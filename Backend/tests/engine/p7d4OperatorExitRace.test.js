"use strict";

/**
 * P7-D4 Part 4 (2026-10-10) — the operator exit against concurrent custody writers.
 *
 * Part 3's exit (`cancellation.cancelExhaustedReassigningLeg`) authorises itself from rows it
 * reads inside a READ COMMITTED transaction. The Leg-scoped values are covered by the Leg's
 * version CAS: every writer that can add a commitment or an outbox row for the Leg, or change
 * its custody, also CASes that Leg. The incumbent-agent check was not: the incumbent's *other*
 * live work is on other Legs, and neither a new grant to the incumbent (`commit()`, which locks
 * the Agent row) nor custody taken on one of those Legs (`transitions.apply`, an UPDATE of that
 * Leg) touches anything the exit locked or CASed. And the check read `Commitment.custodyState`,
 * which is written at grant and at settlement only — custody acquired on the Leg never reaches
 * it — so a pickup elsewhere was invisible even without a race.
 *
 * Each race below is driven deterministically: the exit is paused at its first Leg write
 * (every authorising read done, every lock it takes held), the concurrent writer is started on
 * the real code path and given the event loop, then the exit resumes. "State at commit" is
 * recorded from inside the exit's audit append — its last step before commit.
 *
 * MOCKED BOUNDARIES: the store (`helpers/commitmentStore` with `rowLocksOnWrite`, so a plain
 * UPDATE takes PostgreSQL's FOR NO KEY UPDATE row lock, waits behind a conflicting holder, and
 * re-checks its `where` — a model of the conflict table, not PostgreSQL); the legacy `Robot`
 * table (staged per transaction); and the audit stream (an in-memory sink).
 */

const { createCommitmentStore } = require("./helpers/commitmentStore");
const fixtures = require("./helpers/dispatchFixture");
const reassignment = require("../../src/engine/lifecycle/reassignment");
const transitions = require("../../src/engine/lifecycle/transitions");
const outbox = require("../../src/engine/dispatch/outbox");
const commitPath = require("../../src/engine/commitment/commit");
const taskCancellation = require("../../src/services/taskCancellation.service");

const NOW = new Date("2026-10-10T06:00:00.000Z");
const MAX = 3;
const TASK_ROW = "task-row-254";
const TASK_ID = "TSK-1790958521622-254";
const OTHER_TASK_ROW = "task-row-incumbent-elsewhere";
const UNRELATED_TASK_ROW = "task-row-unrelated";
const ROBOT_ROW = "robot-row-A";
const UNRELATED_ROBOT_ROW = "robot-row-B";
const UNRELATED_AGENT_ROW = "agent-row-unrelated";
const OUR_LEG = fixtures.LEG_ROW_ID;
const ELSEWHERE_LEG = `${fixtures.LEG_ROW_ID.slice(0, -1)}1`;
// The fixture would name a third Leg `…2`, which is LEG_ROW_ID itself; this one is renamed.
const UNRELATED_LEG = `${fixtures.LEG_ROW_ID.slice(0, -1)}9`;

/** Let every runnable continuation run — enough for a writer to either commit or block on a lock. */
async function settle(turns = 50) {
  for (let i = 0; i < turns; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** A promise whose completion can be read synchronously. */
function track(promise) {
  const t = { done: false, value: undefined, error: undefined };
  t.promise = promise.then(
    (value) => {
      t.done = true;
      t.value = value;
      return value;
    },
    (error) => {
      t.done = true;
      t.error = error;
      return undefined;
    },
  );
  return t;
}

function withRobots(store, robots) {
  const rows = new Map(robots.map((r) => [r.id, { status: "IDLE", currentTaskId: null, ...r }]));
  const tableOf = (map) => ({
    async findUnique({ where }) {
      const row = map.get(where.id);
      return row ? { ...row } : null;
    },
    async updateMany({ where, data }) {
      const row = map.get(where.id);
      if (!row) return { count: 0 };
      if (Object.prototype.hasOwnProperty.call(where, "currentTaskId") && row.currentTaskId !== where.currentTaskId) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    },
  });
  return {
    robots: rows,
    client: {
      ...store.client,
      robot: tableOf(rows),
      async $transaction(fn) {
        const staged = new Map([...rows].map(([id, row]) => [id, { ...row }]));
        const result = await store.client.$transaction((tx) => fn({ ...tx, robot: tableOf(staged) }));
        rows.clear();
        for (const [id, row] of staged) rows.set(id, row);
        return result;
      },
    },
  };
}

/**
 * Part 3's stranded Leg (exhausted chain, REASSIGNING, C1 released, RECALL FAILED), plus:
 *  - `elsewhere`: the incumbent's other work — "LIVE" gives it live commitment C-OTHER on
 *    ELSEWHERE_LEG at AT_PICKUP (custody NONE) and rebinds its robot to that Task; "FREE" leaves
 *    ELSEWHERE_LEG PLANNED and ungranted with `elsewhereCustody`, for a grant to race the exit;
 *  - an unrelated agent, robot, Task and Leg (C-UNRELATED live on UNRELATED_LEG).
 */
async function world(options) {
  const o = { elsewhere: "LIVE", elsewhereCustody: "NONE", ...(options || {}) };
  const fixture = fixtures.seed({ legs: 3, capacity: 1, now: NOW });
  fixture.legs[0].state = "EN_ROUTE_PICKUP";
  fixture.legs[1].state = o.elsewhere === "LIVE" ? "AT_PICKUP" : "PLANNED";
  fixture.legs[1].custodyState = o.elsewhereCustody;
  fixture.legs[2].id = UNRELATED_LEG;
  fixture.legs[2].state = "AT_PICKUP";
  fixture.agent.fenceCounter = 42n;
  fixture.leadership.leaseExpiry = new Date(NOW.getTime() + 3_600_000);
  const unrelatedAgent = { ...fixture.agent, id: UNRELATED_AGENT_ROW, agentId: "porter-unrelated", fenceCounter: 10n };

  const history = Array.from({ length: MAX }, (_, i) => ({
    ...fixtures.commitmentRow(fixture, { commitmentId: `old-${i + 1}`, fence: BigInt(30 + i), slot: i + 1 }),
    releasedAt: new Date(NOW.getTime() - (10 - i) * 60_000),
  }));
  const live = [fixtures.commitmentRow(fixture, { commitmentId: "C1", fence: 42n })];
  const unrelated = { ...fixtures.commitmentRow(fixture, { commitmentId: "C-UNRELATED", fence: 9n, legIndex: 2 }), agentId: UNRELATED_AGENT_ROW };

  const store = createCommitmentStore({
    rowLocksOnWrite: true,
    agent: [fixture.agent, unrelatedAgent],
    leg: fixture.legs,
    shardLeadership: [fixture.leadership],
    commitment: [...history, ...live, unrelated],
    outbox: [],
    agentDedupState: [],
    agentFenceAudit: [],
    observation: [],
    timer: [],
    workQueue: [],
    mission: fixture.legs.map((leg) => ({ id: leg.missionId, missionId: `MSN-${leg.missionId}` })),
    task: [
      { id: TASK_ROW, taskId: TASK_ID, status: "ASSIGNED", robotId: ROBOT_ROW, version: 0, missionId: fixture.legs[0].missionId },
      { id: OTHER_TASK_ROW, taskId: "TSK-ELSEWHERE", status: "PENDING", robotId: null, version: 0, missionId: fixture.legs[1].missionId },
      { id: UNRELATED_TASK_ROW, taskId: "TSK-UNRELATED", status: "ASSIGNED", robotId: UNRELATED_ROBOT_ROW, version: 0, missionId: fixture.legs[2].missionId },
    ],
    now: NOW,
  });

  // The real exhausted §4.7 reassignment strands the Leg, then the RECALL fails.
  const withdrawn = await store.client.$transaction(async (tx) =>
    reassignment.reassign(tx, {
      leg: await tx.leg.findUnique({ where: { id: OUR_LEG } }),
      agent: await tx.agent.findUnique({ where: { id: fixture.agent.id } }),
      commitment: await tx.commitment.findUnique({ where: { commitmentId: "C1" } }),
      legCommitments: await tx.commitment.findMany({ where: { legId: OUR_LEG } }),
      storeTime: NOW,
      trigger: reassignment.TRIGGER.LEASE_EXPIRY,
      maxReassignmentsPerLeg: MAX,
      incumbentCooloffSeconds: 300,
      reassignBudgetSeconds: 300,
      maxDeliveryDelaySeconds: 30,
      signingKey: fixtures.TEST_SIGNING_KEY,
    }),
  );
  await outbox.settleRow(store.client, { id: withdrawn.recallOutboxId, state: "FAILED", storeTime: NOW, detail: "HELD_FOR_ORDER" });

  // The incumbent has since been given other work, and its robot follows it.
  let robotTask = TASK_ROW;
  if (o.elsewhere === "LIVE") {
    await store.client.commitment.create({
      data: { ...fixtures.commitmentRow(fixture, { commitmentId: "C-OTHER", fence: 44n, legIndex: 1, slot: 0 }), grantedAt: NOW },
    });
    await store.client.task.updateMany({ where: { id: OTHER_TASK_ROW }, data: { status: "ASSIGNED", robotId: ROBOT_ROW } });
    robotTask = OTHER_TASK_ROW;
  }

  const robots = withRobots(store, [
    { id: ROBOT_ROW, robotId: "SIM-A", currentTaskId: robotTask },
    { id: UNRELATED_ROBOT_ROW, robotId: "SIM-B", currentTaskId: UNRELATED_TASK_ROW },
  ]);
  return { fixture, store, ...robots };
}

function auditSink(onAppend) {
  const events = [];
  return {
    events,
    audit: async (tx, event) => {
      if (onAppend) await onAppend(tx, event);
      events.push(event);
      return { ok: true, event };
    },
  };
}

/** The exit, paused at its first write to our Leg — after every authorising read and lock. */
function exitPausedAtFirstLegWrite(w, sink, during) {
  let paused = false;
  const client = {
    ...w.client,
    $transaction: (fn) =>
      w.client.$transaction((tx) =>
        fn({
          ...tx,
          leg: {
            ...tx.leg,
            updateMany: async (args) => {
              if (!paused && args.where && args.where.id === OUR_LEG) {
                paused = true;
                await during();
              }
              return tx.leg.updateMany(args);
            },
          },
        }),
      ),
  };
  return exit({ ...w, client }, sink);
}

function exit(w, sink) {
  return taskCancellation.cancelQueuedTask(w.client, {
    taskRowId: TASK_ROW,
    taskId: TASK_ID,
    missionIds: [w.fixture.legs[0].missionId],
    actor: { id: "operator-1", role: "SUPER_ADMIN" },
    authorised: true,
    storeTime: NOW,
    reason: "OPERATOR_EXIT_EXHAUSTED_CHAIN",
    maxReassignmentsPerLeg: MAX,
    audit: sink.audit,
  });
}

/** Run an exit to its outcome, a refusal included. */
async function outcomeOf(promise) {
  try {
    return await promise;
  } catch (error) {
    return { outcome: "REFUSED", code: error.code, status: error.status, error };
  }
}

// The real writers.

/** `legProgress.applyCustodyReport`'s write: the agent took the goods at the pickup. */
function acquireCustody(store, legId) {
  return store.client.$transaction(async (tx) => {
    const leg = await tx.leg.findUnique({ where: { id: legId } });
    return transitions.apply(tx, {
      leg,
      event: transitions.EVENT.CUSTODY_ACQUIRED,
      context: { payloadEvidence: true, payloadEvidenceRecord: { source: "AGENT_REPORT" } },
      data: { custodyState: "HELD" },
      storeTime: store.now(),
      deadlineSeconds: 600,
    });
  });
}

/** A round's grant of ELSEWHERE_LEG to the incumbent: the real `commit()`. */
function grantElsewhere(w) {
  return commitPath.commit(
    fixtures.commitDeps(w.store),
    fixtures.commitRequest(w.fixture, {
      legId: ELSEWHERE_LEG,
      snapshot: {
        leadershipFence: w.fixture.leadership.leadershipFence,
        authorityEpoch: w.fixture.agent.authorityEpoch,
        legVersion: 0,
        expectedLegState: "PLANNED",
      },
    }),
  );
}

const row = (w, table, id) => w.store.rows(table).find((r) => r.id === id);
const liveNonNoneOfIncumbent = (w) =>
  w.store
    .rows("commitment")
    .filter((c) => c.agentId === fixtures.AGENT_ROW_ID && c.releasedAt === null)
    .filter((c) => c.custodyState !== "NONE" || (row(w, "leg", c.legId) || {}).custodyState !== "NONE");

function snapshot(w) {
  return {
    leg: w.store.rows("leg"),
    task: w.store.rows("task"),
    commitment: w.store.rows("commitment"),
    outbox: w.store.rows("outbox"),
    timer: w.store.rows("timer").map((r) => ({ id: r.id, timerState: r.timerState })),
    agent: w.store.rows("agent"),
    robots: [...w.robots.values()].map((r) => ({ ...r })),
  };
}

// ── 1. custody racing the exit ──────────────────────────────────────────────

describe("P7-D4 Part 4 — custody taken on the incumbent's other Leg while the exit runs", () => {
  test("the custody write cannot commit inside the exit: the exit commits against NONE, the pickup lands after it", async () => {
    const w = await world();
    let writer;
    const atCommit = {};
    const sink = auditSink(() => {
      atCommit.elsewhereCustody = row(w, "leg", ELSEWHERE_LEG).custodyState;
      atCommit.writerDone = writer.done;
    });

    const out = await outcomeOf(
      exitPausedAtFirstLegWrite(w, sink, async () => {
        writer = track(acquireCustody(w.store, ELSEWHERE_LEG));
        await settle();
      }),
    );
    await writer.promise;

    // The safety property: never a successful exit whose commit saw custody other than NONE.
    expect({ outcome: out.outcome, custodyAtExitCommit: atCommit.elsewhereCustody }).not.toEqual({ outcome: "CANCELLED", custodyAtExitCommit: "HELD" });
    // What the fix makes of it: the pickup waited on the exit's FOR SHARE lock.
    expect(out.outcome).toBe("CANCELLED");
    expect(atCommit).toEqual({ elsewhereCustody: "NONE", writerDone: false });
    expect(writer.value).toMatchObject({ outcome: "APPLIED", to: "LOADED" });
    expect(row(w, "leg", ELSEWHERE_LEG)).toMatchObject({ state: "LOADED", custodyState: "HELD" });
    expect(row(w, "leg", OUR_LEG).state).toBe("CANCELLED");
  });

  test("custody taken just before the exit reads it → AGENT_CUSTODY_UNRESOLVED, nothing written (the Leg is the custody of record; the commitment's copy says NONE)", async () => {
    const w = await world();
    expect(await acquireCustody(w.store, ELSEWHERE_LEG)).toMatchObject({ outcome: "APPLIED" });
    expect(w.store.rows("commitment").find((c) => c.commitmentId === "C-OTHER").custodyState).toBe("NONE");
    const before = snapshot(w);
    const sink = auditSink();

    const out = await outcomeOf(exit(w, sink));
    expect(out).toMatchObject({ outcome: "REFUSED", code: "AGENT_CUSTODY_UNRESOLVED", status: 409 });
    expect(snapshot(w)).toEqual(before);
    expect(sink.events).toEqual([]);
  });

  test.each([["HELD"], ["DISPUTED"], ["PENDING_TRANSFER"], ["RELEASED"], [null], ["SOMETHING_UNKNOWN"]])(
    "the incumbent's other live Leg with custody %s → AGENT_CUSTODY_UNRESOLVED (only exactly NONE passes)",
    async (state) => {
      const w = await world();
      await w.store.client.leg.update({ where: { id: ELSEWHERE_LEG }, data: { custodyState: state } });
      const before = snapshot(w);
      const out = await outcomeOf(exit(w, auditSink()));
      expect(out).toMatchObject({ outcome: "REFUSED", code: "AGENT_CUSTODY_UNRESOLVED", status: 409 });
      expect(snapshot(w)).toEqual(before);
    },
  );

  test("a live commitment whose Leg row cannot be read is unknown custody → AGENT_CUSTODY_UNRESOLVED", async () => {
    const w = await world();
    await w.store.client.commitment.update({ where: { commitmentId: "C-OTHER" }, data: { legId: "leg-that-does-not-exist" } });
    const out = await outcomeOf(exit(w, auditSink()));
    expect(out).toMatchObject({ outcome: "REFUSED", code: "AGENT_CUSTODY_UNRESOLVED" });
    expect(row(w, "leg", OUR_LEG).state).toBe("REASSIGNING");
  });
});

// ── 2. a grant racing the exit ──────────────────────────────────────────────

describe("P7-D4 Part 4 — a new grant to the incumbent while the exit runs", () => {
  test("the grant cannot commit inside the exit: commit() waits on the Agent lock, then lands after the exit", async () => {
    const w = await world({ elsewhere: "FREE", elsewhereCustody: "PENDING_TRANSFER" });
    let grant;
    const atCommit = {};
    const sink = auditSink(() => {
      atCommit.incumbentLiveNotNone = liveNonNoneOfIncumbent(w).map((c) => c.commitmentId);
      atCommit.grantDone = grant.done;
    });

    const out = await outcomeOf(
      exitPausedAtFirstLegWrite(w, sink, async () => {
        grant = track(grantElsewhere(w));
        await settle();
      }),
    );
    await grant.promise;

    expect(out.outcome === "CANCELLED" && atCommit.incumbentLiveNotNone.length > 0).toBe(false);
    expect(out.outcome).toBe("CANCELLED");
    expect(atCommit).toEqual({ incumbentLiveNotNone: [], grantDone: false });
    // The grant itself is not refused or undone — it is ordered after the exit.
    expect(grant.error).toBeUndefined();
    expect(grant.value).toMatchObject({ outcome: "COMMITTED" });
    expect(liveNonNoneOfIncumbent(w).map((c) => c.legId)).toEqual([ELSEWHERE_LEG]);
  });

  test("a grant committed just before the exit reads → AGENT_CUSTODY_UNRESOLVED, nothing written", async () => {
    const w = await world({ elsewhere: "FREE", elsewhereCustody: "PENDING_TRANSFER" });
    expect(await grantElsewhere(w)).toMatchObject({ outcome: "COMMITTED" });
    const before = snapshot(w);
    const out = await outcomeOf(exit(w, auditSink()));
    expect(out).toMatchObject({ outcome: "REFUSED", code: "AGENT_CUSTODY_UNRESOLVED" });
    expect(snapshot(w)).toEqual(before);
  });
});

// ── 3. the lock order cannot deadlock against a withdrawal ──────────────────

describe("P7-D4 Part 4 — a writer already holding the incumbent's other Leg", () => {
  test("§4.7 withdrawal of that Leg (Leg write, then Agent fence write) and the exit both complete — no lock cycle", async () => {
    const w = await world();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let legLocked = false;
    // The withdrawal freezes ELSEWHERE_LEG first (its row lock is held from here), and only then
    // advances the Agent's fence. The exit starts in between.
    const withdrawal = track(
      w.store.client.$transaction(async (tx) => {
        const gated = {
          ...tx,
          leg: {
            ...tx.leg,
            updateMany: async (args) => {
              const result = await tx.leg.updateMany(args);
              legLocked = true;
              return result;
            },
          },
          agent: {
            ...tx.agent,
            update: async (args) => {
              await gate;
              return tx.agent.update(args);
            },
          },
        };
        return reassignment.reassign(gated, {
          leg: await tx.leg.findUnique({ where: { id: ELSEWHERE_LEG } }),
          agent: await tx.agent.findUnique({ where: { id: fixtures.AGENT_ROW_ID } }),
          commitment: await tx.commitment.findUnique({ where: { commitmentId: "C-OTHER" } }),
          legCommitments: await tx.commitment.findMany({ where: { legId: ELSEWHERE_LEG } }),
          storeTime: NOW,
          trigger: reassignment.TRIGGER.LEASE_EXPIRY,
          maxReassignmentsPerLeg: MAX,
          incumbentCooloffSeconds: 300,
          reassignBudgetSeconds: 300,
          maxDeliveryDelaySeconds: 30,
          signingKey: fixtures.TEST_SIGNING_KEY,
        });
      }),
    );
    await settle();
    expect(legLocked).toBe(true);

    const exitRun = track(outcomeOf(exit(w, auditSink())));
    await settle();
    // The exit holds the Task and the Agent (FOR KEY SHARE) and waits for ELSEWHERE_LEG.
    expect(exitRun.done).toBe(false);

    release();
    await withdrawal.promise;
    await exitRun.promise;

    expect(withdrawal.error).toBeUndefined();
    expect(withdrawal.value).toMatchObject({ outcome: "REASSIGNED" });
    expect(exitRun.value).toMatchObject({ outcome: "CANCELLED" });
    expect(row(w, "leg", OUR_LEG).state).toBe("CANCELLED");
    expect(row(w, "leg", ELSEWHERE_LEG).state).toBe("REASSIGNING");
  });
});

// ── 4. idempotency, unrelated work, the safe path ───────────────────────────

describe("P7-D4 Part 4 — what the locks do not change", () => {
  test("two concurrent exits: one CANCELLED, one ALREADY_TERMINAL, one audit event", async () => {
    const w = await world();
    const sink = auditSink();
    const outcomes = await Promise.all([outcomeOf(exit(w, sink)), outcomeOf(exit(w, sink))]);
    expect(outcomes.map((o) => o.outcome).sort()).toEqual(["ALREADY_TERMINAL", "CANCELLED"]);
    expect(sink.events).toHaveLength(1);
    expect(row(w, "task", TASK_ROW)).toMatchObject({ status: "CANCELLED", version: 1 });
  });

  test("unrelated work runs to completion while the exit holds its locks, and is not modified by it", async () => {
    const w = await world();
    const before = snapshot(w);
    const unrelated = [];
    const out = await outcomeOf(
      exitPausedAtFirstLegWrite(w, auditSink(), async () => {
        unrelated.push(
          // another robot's pickup
          track(acquireCustody(w.store, UNRELATED_LEG).catch(() => null)),
          // another Task's projection
          track(w.store.client.task.updateMany({ where: { id: UNRELATED_TASK_ROW }, data: { status: "EXECUTING" } })),
          // another agent's fence
          track(w.store.client.agent.update({ where: { id: UNRELATED_AGENT_ROW }, data: { fenceCounter: 11n } })),
          // the incumbent's own non-key Agent write (FOR KEY SHARE does not block it)
          track(w.store.client.agent.update({ where: { id: fixtures.AGENT_ROW_ID }, data: { lifecycleState: "ACTIVE" } })),
        );
        await settle();
        expect(unrelated.map((t) => t.done)).toEqual([true, true, true, true]);
      }),
    );
    expect(out.outcome).toBe("CANCELLED");
    expect(unrelated.map((t) => t.error)).toEqual([undefined, undefined, undefined, undefined]);

    expect(unrelated[0].value).toMatchObject({ outcome: "APPLIED", to: "LOADED" });

    // The exit changed only its own Task, its own Leg, that Leg's queue row and timers.
    expect(row(w, "leg", UNRELATED_LEG)).toMatchObject({ state: "LOADED", custodyState: "HELD", version: before.leg.find((l) => l.id === UNRELATED_LEG).version + 1 });
    expect(row(w, "task", UNRELATED_TASK_ROW)).toMatchObject({ status: "EXECUTING", version: 0 });
    expect(row(w, "task", OTHER_TASK_ROW)).toEqual(before.task.find((t) => t.id === OTHER_TASK_ROW));
    expect(row(w, "leg", ELSEWHERE_LEG)).toEqual(before.leg.find((l) => l.id === ELSEWHERE_LEG));
    expect(w.store.rows("commitment")).toEqual(before.commitment);
    expect(w.store.rows("outbox")).toEqual(before.outbox);
    // The incumbent's robot is bound to its newer Task, and stays so.
    expect(out).toMatchObject({ robotUnbound: false });
    expect(w.robots.get(ROBOT_ROW).currentTaskId).toBe(OTHER_TASK_ROW);
    expect(w.robots.get(UNRELATED_ROBOT_ROW).currentTaskId).toBe(UNRELATED_TASK_ROW);
  });

  test("the safe exit still succeeds with the incumbent working elsewhere at custody NONE (row locks on)", async () => {
    const w = await world();
    const sink = auditSink();
    const out = await outcomeOf(exit(w, sink));
    expect(out).toMatchObject({ outcome: "CANCELLED", operatorExit: "EXHAUSTED_REASSIGNMENT" });
    expect(row(w, "leg", OUR_LEG)).toMatchObject({ state: "CANCELLED", custodyState: "NONE" });
    expect(sink.events).toHaveLength(1);
    expect(w.store.stats.lockWaits).toBe(0);
  });

  test("the safe exit with no incumbent work elsewhere still succeeds and unbinds the robot", async () => {
    const w = await world({ elsewhere: "FREE" });
    const out = await outcomeOf(exit(w, auditSink()));
    expect(out).toMatchObject({ outcome: "CANCELLED", robotUnbound: true, releasedRobotId: "SIM-A" });
    expect(w.robots.get(ROBOT_ROW).currentTaskId).toBeNull();
  });
});
