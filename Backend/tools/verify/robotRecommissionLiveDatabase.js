"use strict";

/**
 * Recommissioning a retired robot — live-PostgreSQL verification.
 *
 * `tests/unit/robots/robotRecommission.test.js` runs the service against an in-memory model.
 * What only PostgreSQL can show, this harness drives through the **shipped** modules against a
 * real disposable database carrying the real migration chain:
 *
 *   L1  every query the service and the retired list issue is valid against the real schema,
 *       and a retired robot with full engine history is listed with its retirement time;
 *   L2  recommissioning keeps every history row, moves DECOMMISSIONED → COMMISSIONED, advances
 *       the epoch once, revokes the durable session, and records one Event;
 *   L3  concurrent requests on a real `FOR UPDATE`: one transition, one Event, one identity —
 *       and the schema itself refuses a second Robot row for the same robotId;
 *   L4  recommissioning and retirement racing on the Agent lock, in both orders;
 *   L5  a commit built from the retired agent's snapshot is refused (G3), and F2 refuses the
 *       recommissioned agent as loaded from the database;
 *   L6  refusals write nothing: an active robot (its session survives), a simulated robot.
 *
 * Usage (a disposable loopback database only — refused otherwise):
 *   DATABASE_URL=postgresql://user@127.0.0.1:55470/db node tools/verify/robotRecommissionLiveDatabase.js
 *
 * It writes only rows it creates, under ids prefixed `rc-<pid>-`.
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
const robotRecommission = require("../../src/services/robotRecommission.service");
const { commit, OUTCOME: COMMIT_OUTCOME } = require("../../src/engine/commitment/commit");
const { runSerializable, selectForUpdate, isSerializationFailure } = require("../../src/db/prisma");
const f02 = require("../../src/engine/feasibility/predicates/f02");

const results = [];
let currentGroup = "";
function group(name) {
  currentGroup = name;
  console.log(`\n─── ${name} ${"─".repeat(Math.max(0, 74 - name.length))}`);
}
function check(label, ok, detail) {
  results.push({ group: currentGroup, label, ok: Boolean(ok) });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `\n          ${detail}` : ""}`);
}

let seq = 0;
const uid = (prefix) => `rc-${process.pid}-${prefix}-${(seq += 1)}`;
const REASON = "live verification: repaired and re-inspected";

/** A KV stand-in with the one method the service calls, recording what it deleted. */
function mapKv(initial) {
  const store = new Map(Object.entries(initial || {}));
  return {
    store,
    del: async (key) => {
      store.delete(key);
    },
  };
}

let locationId = null;
async function location(prisma) {
  if (locationId) return locationId;
  const row = await prisma.location.create({ data: { id: uid("loc"), name: "recommission verification", type: "AREA" } });
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

/** A robot with an Agent and the engine history retirement preserves. */
async function robotWithHistory(prisma, options) {
  const settings = options || {};
  const robotId = uid(settings.label || "RBT");
  const robot = await prisma.robot.create({
    data: { id: uid("row"), robotId, name: "Rover", locationId: await location(prisma), status: "PAUSED", isOnline: true, socketId: "sock-live", simulated: settings.simulated === true },
  });
  const agent = await prisma.agent.create({
    data: { id: uid("agent"), agentId: robotId, robotDbId: robot.id, lifecycleState: "ACTIVE", authorityEpoch: 3n, fenceCounter: 7n },
  });
  const leg = await legFor(prisma);
  const commitmentId = uid("C");
  await prisma.commitment.create({
    data: { commitmentId, agentId: agent.id, legId: leg.id, fence: 7n, leaseExpiry: new Date(Date.now() + 60_000), releasedAt: new Date() },
  });
  await prisma.outbox.create({
    data: {
      idempotencyKey: uid("idem"), agentId: agent.id, commitmentId, commandClass: "MISSION", command: "OFFER", fenceScope: "COMMITMENT",
      fence: 7n, sequence: 0, payload: {}, notValidAfter: new Date(Date.now() + 60_000), signature: "sig", state: "ACKED",
    },
  });
  await prisma.task.create({
    data: { taskId: uid("TSK"), robotId: robot.id, status: "COMPLETED", pickup: "a", pickupLat: 12.9, pickupLon: 77.5, drop: "b", dropLat: 12.91, dropLon: 77.51 },
  });
  await prisma.telemetry.create({ data: { robotId: robot.id } });
  await prisma.observation.create({ data: { agentId: agent.id, kind: "position", value: { lat: 12.9, lon: 77.5 }, observedAt: new Date(), source: "VERIFY" } });
  await prisma.chargerReservation.create({
    data: { reservationId: uid("res"), agentId: agent.id, reservedFrom: new Date(), reservedUntil: new Date(Date.now() + 60_000), state: "RELEASED" },
  });
  await prisma.robotSession.create({ data: { robotDbId: robot.id, tokenHash: "hash-before-retirement", expiresAt: new Date(Date.now() + 60_000) } });
  await prisma.event.create({ data: { robotId: robot.id, type: "INFO", message: "fixture history" } });
  return { robot, agent };
}

async function historyOf(prisma, robot, agentRowId) {
  const agentWhere = { agentId: agentRowId };
  return {
    Robot: await prisma.robot.count({ where: { robotId: robot.robotId } }),
    Agent: await prisma.agent.count({ where: { robotDbId: robot.id } }),
    Commitment: await prisma.commitment.count({ where: agentWhere }),
    Outbox: await prisma.outbox.count({ where: agentWhere }),
    Task: await prisma.task.count({ where: { robotId: robot.id } }),
    Event: await prisma.event.count({ where: { robotId: robot.id } }),
    Telemetry: await prisma.telemetry.count({ where: { robotId: robot.id } }),
    Observation: await prisma.observation.count({ where: agentWhere }),
    ChargerReservation: await prisma.chargerReservation.count({ where: agentWhere }),
  };
}

const bodyFor = (robotId) => ({ reason: REASON, confirmRobotId: robotId });

async function retired(prisma, options) {
  const unit = await robotWithHistory(prisma, options);
  const result = await robotRetirement.retireRobot(prisma, unit.robot.robotId, { actorId: "verify-admin" });
  if (result.outcome !== "RETIRED") throw new Error(`fixture retirement failed: ${result.outcome}`);
  return unit;
}

/* L1 + L2 */
async function l1l2(prisma) {
  group("L1 — the retired list, against the real schema");
  const { robot, agent } = await retired(prisma, { label: "RBT2000" });
  const listed = await robotRecommission.listRetiredRobots(prisma);
  const row = listed.find((r) => r.robotId === robot.robotId);
  check("the retired robot is listed", Boolean(row));
  check("…recommissionable, physical, with its location", row && row.recommissionable === true && row.simulated === false && row.locationName === "recommission verification");
  check(`…with its retirement time from the fence audit (${row && row.retiredAt})`, row && typeof row.retiredAt === "string");
  check("…and no credential field", row && !Object.keys(row).some((k) => /token|session|pairing|hash/i.test(k)));

  group("L2 — recommissioning keeps history and transitions once");
  const before = await historyOf(prisma, robot, agent.id);
  const kv = mapKv({ [`session:${robot.robotId}`]: "stale-token", [`pairing:${robot.robotId}`]: "424242", [`pairingLocked:${robot.robotId}`]: "1" });
  const result = await robotRecommission.recommission(prisma, robot.robotId, bodyFor(robot.robotId), { actorId: "verify-admin", kv });
  check(`outcome RECOMMISSIONED (${result.outcome})`, result.outcome === "RECOMMISSIONED");
  const after = await historyOf(prisma, robot, agent.id);
  for (const table of Object.keys(before)) {
    const expected = table === "Event" ? before[table] + 1 : before[table];
    check(`${table}: ${before[table]} → ${after[table]}${table === "Event" ? " (+1 recommissioning Event)" : ""}`, after[table] === expected);
  }
  const agentAfter = await prisma.agent.findUnique({ where: { id: agent.id } });
  check(`lifecycleState = ${agentAfter.lifecycleState}`, agentAfter.lifecycleState === "COMMISSIONED");
  check(`authorityEpoch 4 → ${agentAfter.authorityEpoch} (retirement took 3 → 4)`, agentAfter.authorityEpoch === 5n);
  const audit = await prisma.agentFenceAudit.findUnique({ where: { agentId: agent.id } });
  check(`fence audit source = ${audit && audit.lastFenceSource}, epochHighWater = ${audit && audit.epochHighWater}`, audit && audit.lastFenceSource === "recommission" && audit.epochHighWater === 5n);
  check("no durable session survives", (await prisma.robotSession.count({ where: { robotDbId: robot.id } })) === 0);
  check("KV credential keys deleted", kv.store.size === 0);
  const robotAfter = await prisma.robot.findUnique({ where: { id: robot.id } });
  check(`robot offline, status hold kept (${robotAfter.status})`, robotAfter.isOnline === false && robotAfter.socketId === null && robotAfter.status === "PAUSED");
  const event = await prisma.event.findFirst({ where: { robotId: robot.id }, orderBy: { createdAt: "desc" } });
  check("the Event names the actor and the reason", /recommissioned .* by verify-admin: live verification/.test(event.message), event.message);
  check("the robot left the retired list", !(await robotRecommission.listRetiredRobots(prisma)).some((r) => r.robotId === robot.robotId));
  return { robot, agent };
}

/* L3 */
async function l3(prisma) {
  group("L3 — concurrent requests on a real FOR UPDATE");
  const { robot, agent } = await retired(prisma, { label: "CONC" });
  const events = await prisma.event.count({ where: { robotId: robot.id } });
  const outcomes = await Promise.all(
    [1, 2, 3].map(() => robotRecommission.recommission(prisma, robot.robotId, bodyFor(robot.robotId), { actorId: "verify-admin", kv: mapKv() })),
  );
  const names = outcomes.map((o) => o.outcome).sort();
  check(`three concurrent requests: ${names.join(", ")}`, names.filter((n) => n === "RECOMMISSIONED").length === 1 && names.filter((n) => n === "ALREADY_RECOMMISSIONED").length === 2);
  const agentAfter = await prisma.agent.findUnique({ where: { id: agent.id } });
  check(`epoch advanced exactly once (${agentAfter.authorityEpoch})`, agentAfter.authorityEpoch === 5n);
  check("exactly one recommissioning Event", (await prisma.event.count({ where: { robotId: robot.id } })) === events + 1);
  check("one Robot row and one Agent row for the id", (await prisma.robot.count({ where: { robotId: robot.robotId } })) === 1 && (await prisma.agent.count({ where: { agentId: robot.robotId } })) === 1);
  let duplicateError = null;
  try {
    await prisma.robot.create({ data: { id: uid("row"), robotId: robot.robotId, locationId: await location(prisma), status: "IDLE" } });
  } catch (e) {
    duplicateError = e;
  }
  check(`the schema refuses a second Robot row for the id (${duplicateError && duplicateError.code})`, duplicateError && duplicateError.code === "P2002");
}

/* L4 */
async function l4(prisma) {
  group("L4 — recommission and retire racing on the Agent lock");
  {
    const { robot, agent } = await retired(prisma, { label: "RACE1" });
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    let signal;
    const locked = new Promise((resolve) => (signal = resolve));
    const recommissioning = robotRecommission.recommission(prisma, robot.robotId, bodyFor(robot.robotId), {
      kv: mapKv(),
      hooks: { afterLock: async () => { signal(); await gate; } },
    });
    await locked;
    let retireDone = false;
    const retiring = robotRetirement.retireRobot(prisma, robot.robotId, {}).then((r) => { retireDone = true; return r; });
    await new Promise((resolve) => setTimeout(resolve, 300));
    check("retirement waits while recommissioning holds the lock", retireDone === false);
    release();
    const a = await recommissioning;
    const b = await retiring;
    check(`recommission first: ${a.outcome}, then retirement: ${b.outcome}`, a.outcome === "RECOMMISSIONED" && b.outcome === "RETIRED");
    const finalAgent = await prisma.agent.findUnique({ where: { id: agent.id } });
    check(`final state DECOMMISSIONED, epoch 4 → 5 → ${finalAgent.authorityEpoch}`, finalAgent.lifecycleState === "DECOMMISSIONED" && finalAgent.authorityEpoch === 6n);
  }
  {
    const { robot, agent } = await robotWithHistory(prisma, { label: "RACE2" });
    await prisma.robotSession.deleteMany({ where: { robotDbId: robot.id } });
    await prisma.commitment.updateMany({ where: { agentId: agent.id }, data: { releasedAt: new Date() } });
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    let signal;
    const locked = new Promise((resolve) => (signal = resolve));
    const retiring = robotRetirement.retireRobot(prisma, robot.robotId, { hooks: { afterLock: async () => { signal(); await gate; } } });
    await locked;
    // The robot was live a moment ago: a session token is still in the KV. Each delete records
    // the committed lifecycle (read on another connection) at the moment it ran.
    const kv = mapKv({ [`session:${robot.robotId}`]: "token-from-before-retirement" });
    const committedAtDelete = [];
    const del = kv.del;
    kv.del = async (key) => {
      committedAtDelete.push((await prisma.agent.findUnique({ where: { id: agent.id } })).lifecycleState);
      return del(key);
    };
    const recommissioning = robotRecommission
      .recommission(prisma, robot.robotId, bodyFor(robot.robotId), { kv })
      .then((r) => ({ ok: true, r }), (e) => ({ ok: false, e }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    check("no credential is deleted while the robot is not yet retired", committedAtDelete.length === 0);
    release();
    const a = await retiring;
    const b = await recommissioning;
    check(`retire first: ${a.outcome}, then recommission: ${b.ok ? b.r.outcome : b.e.code}`, a.outcome === "RETIRED" && b.ok && b.r.outcome === "RECOMMISSIONED");
    check(
      `the stale session was deleted before the recommissioning committed (committed state at first delete: ${committedAtDelete[0]})`,
      committedAtDelete[0] === "DECOMMISSIONED" && !kv.store.has(`session:${robot.robotId}`),
    );
  }
}

/* L5 */
async function l5(prisma) {
  group("L5 — no decision taken against the retired agent can commit; F2 refuses COMMISSIONED");
  const { robot, agent } = await retired(prisma, { label: "FENCE" });
  const retiredEpoch = (await prisma.agent.findUnique({ where: { id: agent.id } })).authorityEpoch;
  await robotRecommission.recommission(prisma, robot.robotId, bodyFor(robot.robotId), { kv: mapKv() });

  const leg = await legFor(prisma);
  const shard = await prisma.shardLeadership.findUnique({ where: { shardId: "default" } });
  if (!shard) {
    check("shard leadership row present for the commit check (skipped: none seeded)", false);
  } else {
    const deps = {
      prisma,
      runSerializable: (client, fn) => runSerializable(client, fn, { timeoutMs: 30_000, maxWaitMs: 30_000 }),
      selectForUpdate,
      isSerializationFailure,
      volatileRecheck: async () => ({ ok: true }),
      sideEffects: async () => {},
    };
    const outcome = await commit(deps, {
      agentId: agent.id,
      legId: leg.id,
      decisionRoundId: uid("round"),
      targetLegState: "OFFERED",
      shardId: "default",
      planSnapshotRef: "plan",
      decisionRef: "decision",
      snapshot: { leadershipFence: BigInt(shard.leadershipFence), authorityEpoch: BigInt(retiredEpoch), legVersion: 0, expectedLegState: "PLANNED" },
      config: { capacity: 1, leaseDurationSeconds: 60 },
    });
    check(`a commit on the retired snapshot is refused (${outcome.outcome} ${outcome.guard || outcome.reason || ""})`, outcome.outcome !== COMMIT_OUTCOME.COMMITTED);
    check("…and wrote no commitment", (await prisma.commitment.count({ where: { agentId: agent.id, legId: leg.id } })) === 0);
  }
  const loaded = await prisma.agent.findUnique({ where: { id: agent.id } });
  const verdict = f02.evaluate({ agentSnapshot: { lifecycleState: loaded.lifecycleState } });
  check(`F2 on the loaded agent (${loaded.lifecycleState}) is violated`, /violated/i.test(JSON.stringify(verdict)), JSON.stringify(verdict).slice(0, 160));
}

/* L6 */
async function l6(prisma) {
  group("L6 — refusals write nothing");
  const active = await robotWithHistory(prisma, { label: "ACTIVE" });
  const kv = mapKv({ [`session:${active.robot.robotId}`]: "live-token" });
  const refused = await robotRecommission.recommission(prisma, active.robot.robotId, bodyFor(active.robot.robotId), { kv }).catch((e) => e);
  check(`active robot: ${refused.code}`, refused.code === "ROBOT_NOT_RETIRED");
  check("…its KV session survives", kv.store.get(`session:${active.robot.robotId}`) === "live-token");
  check("…its durable session survives", (await prisma.robotSession.count({ where: { robotDbId: active.robot.id } })) === 1);
  check("…its lifecycle is unchanged", (await prisma.agent.findUnique({ where: { id: active.agent.id } })).lifecycleState === "ACTIVE");

  const sim = await retired(prisma, { label: "SIM", simulated: true });
  const epoch = (await prisma.agent.findUnique({ where: { id: sim.agent.id } })).authorityEpoch;
  const simRefused = await robotRecommission.recommission(prisma, sim.robot.robotId, bodyFor(sim.robot.robotId), { kv: mapKv() }).catch((e) => e);
  check(`simulated robot: ${simRefused.code}`, simRefused.code === "SIMULATED_NOT_RECOMMISSIONABLE");
  const simAgent = await prisma.agent.findUnique({ where: { id: sim.agent.id } });
  check("…still DECOMMISSIONED, epoch unchanged", simAgent.lifecycleState === "DECOMMISSIONED" && simAgent.authorityEpoch === epoch);
}

async function main() {
  const prisma = new PrismaClient();
  try {
    await l1l2(prisma);
    await l3(prisma);
    await l4(prisma);
    await l5(prisma);
    await l6(prisma);
  } finally {
    await prisma.$disconnect();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
