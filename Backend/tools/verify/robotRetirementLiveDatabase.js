"use strict";

/**
 * Robot soft retirement — live-PostgreSQL verification.
 *
 * `tests/unit/robots/robotRetirement.test.js` runs the service against an in-memory model.
 * Four claims need PostgreSQL itself, and this harness drives the **shipped** modules against
 * a real disposable database carrying the real migration chain:
 *
 *   R1  the original failure: a hard `Robot` delete on a robot with engine history fails with
 *       a RESTRICT violation — SQLSTATE 23001 on `Commitment_agentId_fkey`, which Prisma 5.22
 *       raises as `PrismaClientUnknownRequestError` with **no** `code` or `meta` (so the error
 *       middleware logs neither) — and where it does succeed it destroys history;
 *   R2  soft retirement preserves Robot, Agent, Commitment, Outbox, Task, Event, Telemetry,
 *       Observation and ChargerReservation rows, and is idempotent;
 *   R3  the 409s, and the lock: retirement racing `commit()` fails safe in either order, and a
 *       racing `markRobotOnline` cannot mark a retired robot online;
 *   R4  a stale availability-index row for a retired agent loads a snapshot that the
 *       feasibility gate refuses (F2), so it cannot become a commitment; and the dashboard
 *       filter keeps robots that have no Agent row (a NOT-IN-NULL trap a model cannot show).
 *
 * Usage (a disposable loopback database only — refused otherwise):
 *   DATABASE_URL=postgresql://user@127.0.0.1:55433/db node tools/verify/robotRetirementLiveDatabase.js
 *
 * It writes only rows it creates, under ids prefixed `rr-<pid>-`. Deliberately not a Jest
 * suite: a test that skips when its database is absent reports green for doing nothing.
 */

const { requireDisposableTarget } = require("../../src/config/environmentGuard");

const target = requireDisposableTarget();
if (target) {
  const port = new URL(process.env.DATABASE_URL.trim()).port || "5432";
  if (port === "5432") {
    console.error("[env] REFUSED: port 5432 is never a disposable target for this harness.");
    process.exit(78);
  }
}

const { PrismaClient } = require("@prisma/client");
const robotRetirement = require("../../src/services/robotRetirement.service");
const policy = require("../../src/services/robotRetirementPolicy");
const { commit, OUTCOME: COMMIT_OUTCOME } = require("../../src/engine/commitment/commit");
const { runSerializable, selectForUpdate, isSerializationFailure } = require("../../src/db/prisma");
const { markRobotOnline } = require("../../src/sockets/handlers/robot.handler");
const { agentSnapshotLoaderFor } = require("../../src/workers/coordinatorSolvePath");
const f02 = require("../../src/engine/feasibility/predicates/f02");
const feasibility = require("../../src/engine/feasibility/evaluate");

const results = [];
let currentGroup = "";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function group(name) {
  currentGroup = name;
  console.log(`\n─── ${name} ${"─".repeat(Math.max(0, 74 - name.length))}`);
}
function check(label, ok, detail) {
  results.push({ group: currentGroup, label, ok: Boolean(ok) });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `\n          ${detail}` : ""}`);
}

let seq = 0;
const uid = (prefix) => `rr-${process.pid}-${prefix}-${(seq += 1)}`;

/* ═══════════════════════════════════════════════════════════════════════════
   Fixture
   ═══════════════════════════════════════════════════════════════════════════ */

let locationId = null;

async function location(prisma) {
  if (locationId) return locationId;
  const row = await prisma.location.create({ data: { id: uid("loc"), name: "retirement verification", type: "AREA" } });
  locationId = row.id;
  return locationId;
}

async function legFor(prisma) {
  const missionRowId = uid("mission");
  await prisma.mission.create({ data: { id: missionRowId, missionId: `M-${missionRowId}` } });
  const legRowId = uid("leg");
  return prisma.leg.create({
    data: { id: legRowId, legId: `L-${legRowId}`, missionId: missionRowId, sequence: 0, purpose: "PRIMARY", state: "PLANNED", version: 0 },
  });
}

/**
 * A robot with an Agent. `history: true` gives it everything the hard delete tripped over and
 * everything it destroyed: a released commitment with its ACKED OFFER, a completed task,
 * telemetry, an observation, a released charge, an index row, a durable session and an Event.
 */
async function robotWithAgent(prisma, options) {
  const settings = options || {};
  const robotId = uid(settings.label || "robot");
  const robot = await prisma.robot.create({
    data: { id: uid("row"), robotId, locationId: await location(prisma), status: "IDLE", isOnline: true, socketId: "sock-live" },
  });
  if (settings.agent === false) return { robot, agent: null };

  const agent = await prisma.agent.create({
    data: { id: uid("agent"), agentId: robotId, robotDbId: robot.id, lifecycleState: "ACTIVE", authorityEpoch: 3n, fenceCounter: 7n },
  });

  if (settings.history) {
    const leg = await legFor(prisma);
    const commitmentId = uid("C");
    await prisma.commitment.create({
      data: { commitmentId, agentId: agent.id, legId: leg.id, fence: 7n, leaseExpiry: new Date(Date.now() + 60_000), releasedAt: new Date() },
    });
    await prisma.outbox.create({
      data: {
        idempotencyKey: uid("idem"),
        agentId: agent.id,
        commitmentId,
        commandClass: "MISSION",
        command: "OFFER",
        fenceScope: "COMMITMENT",
        fence: 7n,
        sequence: 0,
        payload: {},
        notValidAfter: new Date(Date.now() + 60_000),
        signature: "sig",
        state: "ACKED",
      },
    });
    await prisma.task.create({
      data: { taskId: uid("TSK"), robotId: robot.id, status: "COMPLETED", pickup: "a", pickupLat: 12.9, pickupLon: 77.5, drop: "b", dropLat: 12.91, dropLon: 77.51 },
    });
    await prisma.telemetry.create({ data: { robotId: robot.id } });
    await prisma.observation.create({
      data: { agentId: agent.id, kind: "position", value: { lat: 12.9, lon: 77.5 }, observedAt: new Date(), source: "VERIFY" },
    });
    await prisma.chargerReservation.create({
      data: { reservationId: uid("res"), agentId: agent.id, reservedFrom: new Date(), reservedUntil: new Date(Date.now() + 60_000), state: "RELEASED" },
    });
    await prisma.agentCellPosition.create({
      data: { agentId: agent.id, shardId: "default", lat: 12.9, lon: 77.5, fineCellId: "fine", coarseCellId: "coarse", availabilityClass: "IDLE_READY", observedAtMs: BigInt(Date.now()) },
    });
    await prisma.robotSession.create({ data: { robotDbId: robot.id, tokenHash: "hash", expiresAt: new Date(Date.now() + 60_000) } });
    await prisma.event.create({ data: { robotId: robot.id, type: "INFO", message: "fixture history" } });
  }
  return { robot, agent };
}

/** Rows attached to one robot, by table — what "history preserved" is measured against. */
async function historyOf(prisma, robot, agentRowId) {
  const agentWhere = agentRowId ? { agentId: agentRowId } : { agentId: "none" };
  return {
    Robot: await prisma.robot.count({ where: { id: robot.id } }),
    Agent: agentRowId ? await prisma.agent.count({ where: { id: agentRowId } }) : 0,
    Commitment: await prisma.commitment.count({ where: agentWhere }),
    Outbox: await prisma.outbox.count({ where: agentWhere }),
    Task: await prisma.task.count({ where: { robotId: robot.id } }),
    Event: await prisma.event.count({ where: { robotId: robot.id } }),
    Telemetry: await prisma.telemetry.count({ where: { robotId: robot.id } }),
    Observation: await prisma.observation.count({ where: agentWhere }),
    ChargerReservation: await prisma.chargerReservation.count({ where: agentWhere }),
  };
}

function commitDeps(prisma, overrides) {
  return {
    prisma,
    runSerializable: (client, fn) => runSerializable(client, fn, { timeoutMs: 30_000, maxWaitMs: 30_000 }),
    selectForUpdate,
    isSerializationFailure,
    volatileRecheck: async () => ({ ok: true }),
    sideEffects: async () => {},
    ...(overrides || {}),
  };
}

async function commitRequest(prisma, agentRowId, authorityEpoch) {
  const leg = await legFor(prisma);
  const shard = await prisma.shardLeadership.findUnique({ where: { shardId: "default" } });
  return {
    leg,
    request: {
      agentId: agentRowId,
      legId: leg.id,
      decisionRoundId: uid("round"),
      targetLegState: "OFFERED",
      shardId: "default",
      planSnapshotRef: "plan",
      decisionRef: "decision",
      snapshot: { leadershipFence: BigInt(shard.leadershipFence), authorityEpoch: BigInt(authorityEpoch), legVersion: 0, expectedLegState: "PLANNED" },
      config: { capacity: 1, leaseDurationSeconds: 60 },
    },
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   R1 — the original failure, reproduced
   ═══════════════════════════════════════════════════════════════════════════ */

async function r1OriginalFailure(prisma) {
  group("R1 — the 8a7c208 hard delete, on a robot with engine history");
  const { robot, agent } = await robotWithAgent(prisma, { label: "hist", history: true });
  let error = null;
  try {
    await prisma.robot.delete({ where: { robotId: robot.robotId } }); // exactly what 8a7c208's deleteRobot did
  } catch (e) {
    error = e;
  }
  check("prisma.robot.delete throws", error !== null);
  // Observed, not assumed: the cascade from Robot to Agent hits an ON DELETE RESTRICT key, and
  // PostgreSQL answers 23001 (restrict_violation), not 23503. Prisma maps only the latter to
  // P2003; this one arrives as an unknown request error with no `code` and no `meta`.
  check(
    `the error is ${error?.constructor?.name} with code ${error?.code} — not P2003`,
    error?.constructor?.name === "PrismaClientUnknownRequestError" && error?.code === undefined,
  );
  const message = String(error?.message || "");
  check("PostgreSQL reported SQLSTATE 23001 (restrict_violation)", /code: "23001"/.test(message));
  check(
    "on the restricting foreign key onto Agent (Commitment_agentId_fkey)",
    /violates RESTRICT setting of foreign key constraint \\?"Commitment_agentId_fkey\\?"/.test(message),
    (message.match(/message: "([^"\\]|\\.)*"/) || [""])[0],
  );
  const after = await historyOf(prisma, robot, agent.id);
  check("the failed delete changed nothing (the cascade rolled back)", after.Robot === 1 && after.Agent === 1 && after.Telemetry === 1);

  group("R1b — where the hard delete succeeded, it destroyed history");
  const fresh = await robotWithAgent(prisma, { label: "fresh" });
  await prisma.telemetry.create({ data: { robotId: fresh.robot.id } });
  const event = await prisma.event.create({ data: { robotId: fresh.robot.id, type: "INFO", message: "kept?" } });
  const task = await prisma.task.create({
    data: { taskId: uid("TSK"), robotId: fresh.robot.id, status: "COMPLETED", pickup: "a", pickupLat: 1, pickupLon: 1, drop: "b", dropLat: 2, dropLon: 2 },
  });
  await prisma.robot.delete({ where: { robotId: fresh.robot.robotId } });
  check("a robot with no commitment history deletes", (await prisma.robot.count({ where: { id: fresh.robot.id } })) === 0);
  check("…and its telemetry went with it", (await prisma.telemetry.count({ where: { robotId: fresh.robot.id } })) === 0);
  check("…its Agent too", (await prisma.agent.count({ where: { id: fresh.agent.id } })) === 0);
  check("…its task no longer names it (Task.robotId → NULL)", (await prisma.task.findUnique({ where: { id: task.id } })).robotId === null);
  check("…nor does its event (Event.robotId → NULL)", (await prisma.event.findUnique({ where: { id: event.id } })).robotId === null);
}

/* ═══════════════════════════════════════════════════════════════════════════
   R2 — soft retirement preserves history; repeat; missing Agent; new robot
   ═══════════════════════════════════════════════════════════════════════════ */

async function r2SoftRetirement(prisma) {
  group("R2 — soft retirement of a robot with full engine history");
  const { robot, agent } = await robotWithAgent(prisma, { label: "soft", history: true });
  const before = await historyOf(prisma, robot, agent.id);

  const result = await robotRetirement.retireRobot(prisma, robot.robotId, { actorId: "verify-operator", reason: "live verification" });
  check(`outcome RETIRED (${result.outcome})`, result.outcome === "RETIRED");

  const after = await historyOf(prisma, robot, agent.id);
  for (const table of Object.keys(before)) {
    const expected = table === "Event" ? before[table] + 1 : before[table];
    check(`${table}: ${before[table]} → ${after[table]}${table === "Event" ? " (+1 retirement Event)" : ""}`, after[table] === expected);
  }
  const agentAfter = await prisma.agent.findUnique({ where: { id: agent.id } });
  check(`Agent.lifecycleState = ${agentAfter.lifecycleState}`, agentAfter.lifecycleState === "DECOMMISSIONED");
  check(`authorityEpoch 3 → ${agentAfter.authorityEpoch}`, agentAfter.authorityEpoch === 4n);
  check(`fenceCounter untouched (${agentAfter.fenceCounter})`, agentAfter.fenceCounter === 7n);
  const audit = await prisma.agentFenceAudit.findUnique({ where: { agentId: agent.id } });
  check("AgentFenceAudit records the advance", audit && audit.epochHighWater === 4n && audit.lastFenceSource === "decommission");
  check("AgentCellPosition removed", (await prisma.agentCellPosition.count({ where: { agentId: agent.id } })) === 0);
  check("RobotSession revoked", (await prisma.robotSession.count({ where: { robotDbId: robot.id } })) === 0);
  const robotAfter = await prisma.robot.findUnique({ where: { id: robot.id } });
  check("Robot isOnline false, socketId null", robotAfter.isOnline === false && robotAfter.socketId === null);
  const tasks = await prisma.task.findMany({ where: { robotId: robot.id } });
  check("the completed task still names the robot", tasks.length === 1 && tasks[0].robotId === robot.id);
  const event = await prisma.event.findFirst({ where: { robotId: robot.id }, orderBy: { createdAt: "desc" } });
  check("the retirement Event names actor and reason", /retired .* by verify-operator: live verification/.test(event.message), event.message);

  group("R2b — repeated retirement");
  const again = await robotRetirement.retireRobot(prisma, robot.robotId, {});
  const agentAgain = await prisma.agent.findUnique({ where: { id: agent.id } });
  check(`outcome ALREADY_RETIRED (${again.outcome})`, again.outcome === "ALREADY_RETIRED");
  check("epoch not advanced again", agentAgain.authorityEpoch === 4n);
  check("no second Event", (await prisma.event.count({ where: { robotId: robot.id } })) === after.Event);

  group("R2c — a robot with no Agent row, and a brand-new robot");
  const { robot: orphan } = await robotWithAgent(prisma, { label: "orphan", agent: false });
  const orphanResult = await robotRetirement.retireRobot(prisma, orphan.robotId, {});
  const orphanAgent = await prisma.agent.findUnique({ where: { robotDbId: orphan.id } });
  check("retired through a created Agent", orphanResult.agentCreated === true && orphanAgent?.lifecycleState === "DECOMMISSIONED");
  const { robot: fresh } = await robotWithAgent(prisma, { label: "new" });
  check("a robot with no history retires", (await robotRetirement.retireRobot(prisma, fresh.robotId, {})).outcome === "RETIRED");
}

/* ═══════════════════════════════════════════════════════════════════════════
   R3 — refusals, and races
   ═══════════════════════════════════════════════════════════════════════════ */

async function expectRefusal(prisma, robotId, code) {
  try {
    await robotRetirement.retireRobot(prisma, robotId, {});
    return { ok: false, detail: "retired" };
  } catch (e) {
    return { ok: e instanceof robotRetirement.RetirementRefused && e.code === code, detail: `${e.code || e.message}` };
  }
}

async function r3Refusals(prisma) {
  group("R3 — the 409s, against real rows (and nothing written)");
  const live = await robotWithAgent(prisma, { label: "live" });
  const leg = await legFor(prisma);
  const commitmentId = uid("C");
  await prisma.commitment.create({ data: { commitmentId, agentId: live.agent.id, legId: leg.id, fence: 8n, leaseExpiry: new Date(Date.now() + 60_000) } });
  let r = await expectRefusal(prisma, live.robot.robotId, "LIVE_COMMITMENT");
  check(`live commitment → LIVE_COMMITMENT (${r.detail})`, r.ok);

  await prisma.commitment.update({ where: { commitmentId }, data: { releasedAt: new Date() } });
  await prisma.outbox.create({
    data: {
      idempotencyKey: uid("idem"), agentId: live.agent.id, commitmentId, commandClass: "MISSION", command: "WITHDRAW", fenceScope: "COMMITMENT",
      fence: 9n, sequence: 1, payload: {}, notValidAfter: new Date(Date.now() + 60_000), signature: "sig", state: "DELIVERED",
    },
  });
  r = await expectRefusal(prisma, live.robot.robotId, "OUTSTANDING_COMMANDS");
  check(`delivered, unacknowledged WITHDRAW → OUTSTANDING_COMMANDS (${r.detail})`, r.ok);
  await prisma.outbox.updateMany({ where: { agentId: live.agent.id }, data: { state: "ACKED" } });

  const task = await prisma.task.create({
    data: { taskId: uid("TSK"), robotId: live.robot.id, status: "IN_EXECUTION", pickup: "a", pickupLat: 1, pickupLon: 1, drop: "b", dropLat: 2, dropLon: 2 },
  });
  r = await expectRefusal(prisma, live.robot.robotId, "ACTIVE_TASK");
  check(`IN_EXECUTION task → ACTIVE_TASK (${r.detail})`, r.ok);
  await prisma.task.update({ where: { id: task.id }, data: { status: "CANCELLED" } });

  await prisma.chargerReservation.create({
    data: { reservationId: uid("res"), agentId: live.agent.id, reservedFrom: new Date(), reservedUntil: new Date(Date.now() + 60_000), state: "QUEUED" },
  });
  r = await expectRefusal(prisma, live.robot.robotId, "CHARGING_RESERVATION");
  check(`QUEUED charging reservation → CHARGING_RESERVATION (${r.detail})`, r.ok);

  const agentAfter = await prisma.agent.findUnique({ where: { id: live.agent.id } });
  check("after four refusals the Agent is untouched (ACTIVE, epoch 3)", agentAfter.lifecycleState === "ACTIVE" && agentAfter.authorityEpoch === 3n);
  check("and no retirement Event was written", (await prisma.event.count({ where: { robotId: live.robot.id } })) === 0);
}

async function r3Races(prisma) {
  group("R3b — two concurrent retirements");
  const twin = await robotWithAgent(prisma, { label: "twin" });
  const both = await Promise.all([robotRetirement.retireRobot(prisma, twin.robot.robotId, {}), robotRetirement.retireRobot(prisma, twin.robot.robotId, {})]);
  check(`outcomes ${both.map((b) => b.outcome).sort().join(" + ")}`, both.map((b) => b.outcome).sort().join(",") === "ALREADY_RETIRED,RETIRED");
  check("epoch advanced exactly once", (await prisma.agent.findUnique({ where: { id: twin.agent.id } })).authorityEpoch === 4n);
  check("one retirement Event", (await prisma.event.count({ where: { robotId: twin.robot.id } })) === 1);

  group("R3c — retirement commits first, then a commit from an older snapshot");
  const a = await robotWithAgent(prisma, { label: "race-a" });
  const staleSnapshot = await commitRequest(prisma, a.agent.id, 3);
  await robotRetirement.retireRobot(prisma, a.robot.robotId, {});
  const late = await commit(commitDeps(prisma), staleSnapshot.request);
  check(`commit aborts (${late.outcome} ${late.reason || ""})`, late.outcome !== COMMIT_OUTCOME.COMMITTED, JSON.stringify({ outcome: late.outcome, reason: late.reason }));
  check("no commitment exists for the retired agent", (await prisma.commitment.count({ where: { agentId: a.agent.id } })) === 0);

  group("R3d — a commit holds the Agent lock; retirement waits, then refuses");
  const b = await robotWithAgent(prisma, { label: "race-b" });
  const bReq = await commitRequest(prisma, b.agent.id, 3);
  let commitLocked;
  const commitHasLock = new Promise((resolve) => {
    commitLocked = resolve;
  });
  const committing = commit(
    commitDeps(prisma, {
      selectForUpdate: async (tx, table, column, value) => {
        const row = await selectForUpdate(tx, table, column, value);
        if (table === "Agent") {
          commitLocked();
          await sleep(600);
        }
        return row;
      },
    }),
    bReq.request,
  );
  await commitHasLock;
  const startedAt = Date.now();
  const retiring = robotRetirement.retireRobot(prisma, b.robot.robotId, {}).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  const committed = await committing;
  const retired = await retiring;
  check(`the commit succeeds (${committed.outcome})`, committed.outcome === COMMIT_OUTCOME.COMMITTED);
  check(`retirement waited on the lock (${Date.now() - startedAt} ms)`, Date.now() - startedAt >= 300);
  check(`then refused LIVE_COMMITMENT (${retired.error?.code || retired.value?.outcome})`, retired.error?.code === "LIVE_COMMITMENT");
  check("the agent is still ACTIVE", (await prisma.agent.findUnique({ where: { id: b.agent.id } })).lifecycleState === "ACTIVE");

  group("R3e — retirement holds the Agent lock; a commit (current snapshot) waits, then aborts");
  const c = await robotWithAgent(prisma, { label: "race-c" });
  const cReq = await commitRequest(prisma, c.agent.id, 3);
  let retireLocked;
  const retireHasLock = new Promise((resolve) => {
    retireLocked = resolve;
  });
  const retiringC = robotRetirement.retireRobot(prisma, c.robot.robotId, {
    hooks: { afterLock: async () => { retireLocked(); await sleep(600); } },
  });
  await retireHasLock;
  const committingC = commit(commitDeps(prisma), cReq.request);
  const retiredC = await retiringC;
  const committedC = await committingC;
  check(`retirement completes (${retiredC.outcome})`, retiredC.outcome === "RETIRED");
  check(
    `the commit does not commit (${committedC.outcome} ${committedC.reason || ""})`,
    committedC.outcome !== COMMIT_OUTCOME.COMMITTED,
    JSON.stringify({ outcome: committedC.outcome, reason: committedC.reason }),
  );
  check("no commitment exists for the retired agent", (await prisma.commitment.count({ where: { agentId: c.agent.id } })) === 0);

  group("R3f — markRobotOnline racing a retirement that holds the lock");
  const d = await robotWithAgent(prisma, { label: "race-d" });
  await prisma.robot.update({ where: { id: d.robot.id }, data: { isOnline: false, socketId: null } });
  let retireLockedD;
  const lockedD = new Promise((resolve) => {
    retireLockedD = resolve;
  });
  const retiringD = robotRetirement.retireRobot(prisma, d.robot.robotId, {
    hooks: { afterLock: async () => { retireLockedD(); await sleep(500); } },
  });
  await lockedD;
  const online = await markRobotOnline(prisma, d.robot.robotId, "sock-racing");
  await retiringD;
  check("markRobotOnline waited and refused (null)", online === null);
  const dAfter = await prisma.robot.findUnique({ where: { id: d.robot.id } });
  check("the retired robot is not online", dAfter.isOnline === false && dAfter.socketId === null);

  const e = await robotWithAgent(prisma, { label: "online-ok" });
  const ok = await markRobotOnline(prisma, e.robot.robotId, "sock-ok");
  check("markRobotOnline still marks an active robot online", ok && ok.isOnline === true && ok.socketId === "sock-ok");
  const { robot: noAgent } = await robotWithAgent(prisma, { label: "online-noagent", agent: false });
  const ok2 = await markRobotOnline(prisma, noAgent.robotId, "sock-na");
  check("…and a robot with no Agent row", ok2 && ok2.isOnline === true);
}

/* ═══════════════════════════════════════════════════════════════════════════
   R4 — stale index rows, and the list filter's NULL semantics
   ═══════════════════════════════════════════════════════════════════════════ */

async function r4StaleIndexAndLists(prisma) {
  group("R4 — a stale availability-index row for a retired agent cannot become a commitment");
  const s = await robotWithAgent(prisma, { label: "stale" });
  await robotRetirement.retireRobot(prisma, s.robot.robotId, {});
  // What a sweep that was mid-flight at retirement could write back.
  await prisma.agentCellPosition.create({
    data: { agentId: s.agent.id, shardId: "default", lat: 12.9, lon: 77.5, fineCellId: "fine", coarseCellId: "coarse", availabilityClass: "IDLE_READY", observedAtMs: BigInt(Date.now()) },
  });
  const load = agentSnapshotLoaderFor({ prisma });
  const snapshot = await load(s.robot.robotId);
  check(`the round's snapshot loader still finds the stale row (lifecycle ${snapshot?.lifecycleState})`, snapshot && snapshot.lifecycleState === "DECOMMISSIONED");
  const f2 = f02.evaluate({ agentSnapshot: snapshot });
  check(`F2 = ${f2.outcome}`, f2.outcome === "VIOLATED", f2.reason);
  // The real gate, every predicate evaluated. Only a branded (feasible) candidate can be priced
  // and solved into a commitment; an unbranded one is refused by the cost evaluator (I14).
  const gated = feasibility.gate({ legId: "L-stale" }, { agentSnapshot: snapshot, mission: {}, plan: {}, config: {}, decisionTimeMs: Date.now() }, { collectAll: true });
  check("the gate refuses the candidate: not feasible, returned unbranded", gated.feasible === false && gated.candidate === null);
  check("and F2 is among its denials", gated.outcome.denials.some((d) => d.predicateId === "F2" && d.outcome === "VIOLATED"));
  check("no commitment exists for the retired agent", (await prisma.commitment.count({ where: { agentId: s.agent.id } })) === 0);

  group("R4b — the dashboard filter on real PostgreSQL (robots with no Agent row are kept)");
  // An Agent with no robot at all (§25) — the NULL a NOT IN subquery would trip over.
  await prisma.agent.create({ data: { id: uid("agent-norobot"), agentId: uid("drone"), robotDbId: null } });
  const kept = await robotWithAgent(prisma, { label: "list-active" });
  const { robot: orphan } = await robotWithAgent(prisma, { label: "list-noagent", agent: false });
  const retired = await robotWithAgent(prisma, { label: "list-retired" });
  await robotRetirement.retireRobot(prisma, retired.robot.robotId, {});
  const ids = [kept.robot.id, orphan.id, retired.robot.id];
  const listed = await prisma.robot.findMany({ where: { id: { in: ids }, ...policy.notRetiredRobotWhere() }, select: { id: true } });
  const listedIds = listed.map((r) => r.id);
  check("the active robot is listed", listedIds.includes(kept.robot.id));
  check("the robot with no Agent row is listed", listedIds.includes(orphan.id));
  check("the retired robot is not listed", !listedIds.includes(retired.robot.id));
}

async function main() {
  const prisma = new PrismaClient();
  try {
    await r1OriginalFailure(prisma);
    await r2SoftRetirement(prisma);
    await r3Refusals(prisma);
    await r3Races(prisma);
    await r4StaleIndexAndLists(prisma);
  } finally {
    await prisma.$disconnect();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    for (const f of failed) console.log(`  FAIL [${f.group}] ${f.label}`);
    process.exit(1);
  }
}

if (target) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
