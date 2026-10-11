"use strict";

/**
 * Phase 6 — §4.6's immediate case, engine-owned: a task whose Legs are all QUEUED (custody
 * NONE, no HARD commitment) is *"`CANCELLED` immediately"*, in one transaction, or not at all.
 *
 * Before this, `POST /api/tasks/:taskId/cancel` refused every engine-managed task (P1.4), and
 * §4.6's `requestCancellation` had no caller and no §4.4 row reached `CANCELLED`. A queued Leg
 * that no agent could ever serve (TSK-1791530708128-820, F19) could therefore never be taken
 * out of the round's input by an operator.
 *
 * Every test runs against the transactional store model (real conditional writes, locks, and
 * a transaction that commits atomically or not at all), with no database.
 */

const { createCommitmentStore } = require("./helpers/commitmentStore");
const taskCancellation = require("../../src/services/taskCancellation.service");
const cancellation = require("../../src/engine/lifecycle/cancellation");
const transitions = require("../../src/engine/lifecycle/transitions");
const coordinator = require("../../src/workers/coordinator.worker");

const NOW = new Date("2026-10-09T12:00:00.000Z");
const TASK_ROW = "task-row-820";
const MISSION_ROW = "mission-row-820";
const LEG_ROW = "leg-row-820";
const SHARD = "rnsit-shard";

function seed(overrides) {
  const o = overrides || {};
  return createCommitmentStore({
    task: [{ id: TASK_ROW, taskId: "TSK-820", status: "PENDING", robotId: null, version: 0, ...(o.task || {}) }],
    mission: [{ id: MISSION_ROW, missionId: "MSN-820" }],
    leg: [
      {
        id: LEG_ROW,
        legId: "LEG-TSK-820",
        missionId: MISSION_ROW,
        sequence: 0,
        purpose: "PRIMARY",
        state: "QUEUED",
        custodyState: "NONE",
        version: 0,
        cancelRequestedAt: null,
        cancelReason: null,
        obstructionClass: null,
        startNotBefore: null,
        slaDeadline: new Date(NOW.getTime() - 3_600_000),
        ...(o.leg || {}),
      },
    ],
    workQueue: [
      {
        id: "wq-820",
        legId: LEG_ROW,
        shardId: SHARD,
        idempotencyKey: "idem-820",
        purpose: "PRIMARY",
        slaClass: null,
        tenantId: null,
        priority: 0,
        state: "QUEUED",
        availableAt: null,
        claimedByRoundId: null,
        claimedAt: null,
        roundsConsidered: 26538,
        consecutiveDeferrals: 0,
        version: 53076,
        enqueuedAt: new Date(NOW.getTime() - 7 * 3_600_000),
        settledAt: null,
        ...(o.workQueue || {}),
      },
    ],
    timer: [
      {
        id: "timer-ladder-820",
        timerKey: `LEG:${LEG_ROW}:QUEUED:0:ESCALATION_LADDER`,
        entityType: "LEG",
        entityId: LEG_ROW,
        state: "QUEUED",
        entityVersion: 0n,
        dueAt: new Date(NOW.getTime() + 60_000),
        handler: "ESCALATION_LADDER",
        payload: null,
        timerState: "PENDING",
        attempts: 17,
        shardId: SHARD,
        createdAt: new Date(NOW.getTime() - 3_600_000),
        updatedAt: new Date(NOW.getTime() - 60_000),
      },
    ],
    commitment: o.commitments || [],
    outbox: [],
    now: NOW,
  });
}

function auditSink(options) {
  const events = [];
  return {
    events,
    audit: async (_tx, event) => {
      if (options && options.fail) return { ok: false, collided: true };
      events.push(event);
      return { ok: true, event };
    },
  };
}

function cancel(store, sink, overrides) {
  return taskCancellation.cancelQueuedTask(store.client, {
    taskRowId: TASK_ROW,
    taskId: "TSK-820",
    missionIds: [MISSION_ROW],
    actor: { id: "user-1", role: "SUPER_ADMIN" },
    authorised: true,
    storeTime: NOW,
    reason: "OPERATOR_CANCELLATION",
    audit: sink.audit,
    ...(overrides || {}),
  });
}

async function snapshot(store) {
  const [task, leg, queue, timer] = await Promise.all([
    store.client.task.findUnique({ where: { id: TASK_ROW } }),
    store.client.leg.findUnique({ where: { id: LEG_ROW } }),
    store.client.workQueue.findUnique({ where: { id: "wq-820" } }),
    store.client.timer.findUnique({ where: { id: "timer-ladder-820" } }),
  ]);
  return { task, leg, queue, timer, outbox: store.rows("outbox") };
}

async function expectUntouched(store, sink, extra) {
  const s = await snapshot(store);
  expect(s.task.status).toBe("PENDING");
  expect(s.task.version).toBe(0);
  expect(s.leg.state).toBe(extra && extra.legState ? extra.legState : "QUEUED");
  expect(s.leg.cancelRequestedAt).toBeNull();
  expect(s.queue.state).toBe(extra && extra.queueState ? extra.queueState : "QUEUED");
  expect(s.timer.timerState).toBe("PENDING");
  expect(sink.events).toEqual([]);
}

describe("§4.6 — a QUEUED Leg is cancelled immediately, through the engine's own protocol", () => {
  test("the Task, its Leg, its queue row and its timer all reach their terminal state together, with one audit event", async () => {
    const store = seed();
    const sink = auditSink();
    const result = await cancel(store, sink);

    expect(result.outcome).toBe("CANCELLED");
    const s = await snapshot(store);
    // Leg: step 1's flag (version 0 → 1), then the §4.6 row (1 → 2).
    expect(s.leg.state).toBe("CANCELLED");
    expect(s.leg.cancelRequestedAt).toEqual(NOW);
    expect(s.leg.cancelReason).toBe("OPERATOR_CANCELLATION");
    expect(s.leg.version).toBe(2);
    // Queue: out of every round's input, at a new version.
    expect(s.queue.state).toBe("WITHDRAWN");
    expect(s.queue.version).toBe(53077);
    expect(s.queue.settledAt).toEqual(NOW);
    expect(s.queue.claimedByRoundId).toBeNull();
    // Task: projected, CAS on its own version.
    expect(s.task.status).toBe("CANCELLED");
    expect(s.task.version).toBe(1);
    // The QUEUED deadline's ladder timer is cancelled on exit (§4.5).
    expect(s.timer.timerState).not.toBe("PENDING");
    // Nothing was said to any agent: no outbox row.
    expect(s.outbox).toEqual([]);
    // Audit: one CANCELLATION event naming the resolution and the transition.
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      eventType: "CANCELLATION",
      actorId: "user-1",
      actorRole: "SUPER_ADMIN",
      subjectType: "TASK",
      subjectId: "TSK-820",
      payload: {
        resolution: "CANCELLED_IMMEDIATELY",
        taskStatusFrom: "PENDING",
        legs: [{ legId: "LEG-TSK-820", from: "QUEUED", to: "CANCELLED" }],
        queueRowsWithdrawn: 1,
      },
    });
  });

  test("the coordinator's real claim step no longer selects the cancelled Leg", async () => {
    const store = seed();
    await cancel(store, auditSink());
    const claimed = await coordinator.claimBatch({ prisma: store.client }, { shardId: SHARD, roundId: "round-after", storeTime: NOW, limit: 10 });
    expect(claimed).toEqual([]);
  });

  test("a duplicate request is a no-op answered as already terminal — no second write, no second audit event", async () => {
    const store = seed();
    const sink = auditSink();
    await cancel(store, sink);
    const before = await snapshot(store);

    const again = await cancel(store, sink);
    expect(again.outcome).toBe("ALREADY_TERMINAL");
    const after = await snapshot(store);
    expect(after.leg.version).toBe(before.leg.version);
    expect(after.queue.version).toBe(before.queue.version);
    expect(after.task.version).toBe(before.task.version);
    expect(sink.events).toHaveLength(1);
  });
});

describe("concurrency — whichever conditional write lands first wins, and nothing is left half-cancelled", () => {
  test("an assignment that moves the Leg first (QUEUED → PLANNED) wins: the cancellation refuses and writes nothing", async () => {
    const store = seed();
    const sink = auditSink();
    // Intercept the cancellation's in-transaction Leg read: after it, a round commits
    // QUEUED → PLANNED outside the transaction — exactly the interleaving a live round makes.
    const racing = {
      ...store.client,
      $transaction: (fn) =>
        store.client.$transaction(async (tx) => {
          const wrapped = Object.create(tx);
          wrapped.leg = Object.create(tx.leg);
          wrapped.leg.findMany = async (args) => {
            const rows = await tx.leg.findMany(args);
            await store.client.leg.updateMany({ where: { id: LEG_ROW, version: 0 }, data: { state: "PLANNED", version: 1 } });
            return rows;
          };
          return fn(wrapped);
        }),
    };
    await expect(
      taskCancellation.cancelQueuedTask(racing, {
        taskRowId: TASK_ROW,
        taskId: "TSK-820",
        missionIds: [MISSION_ROW],
        actor: { id: "user-1", role: "SUPER_ADMIN" },
        authorised: true,
        storeTime: NOW,
        audit: sink.audit,
      }),
    ).rejects.toMatchObject({ code: "LEG_MOVED", status: 409 });

    const s = await snapshot(store);
    expect(s.leg.state).toBe("PLANNED"); // the round's write stands
    expect(s.leg.cancelRequestedAt).toBeNull(); // no stray flag
    expect(s.queue.state).toBe("QUEUED");
    expect(s.task.status).toBe("PENDING");
    expect(sink.events).toEqual([]);
  });

  test("a cancellation that lands first makes the round's QUEUED → PLANNED write fail, and the commit guard refuses the Leg", async () => {
    const store = seed();
    const stale = await store.client.leg.findUnique({ where: { id: LEG_ROW } }); // what the round read
    await cancel(store, auditSink());

    const roundWrite = await store.client.$transaction((tx) =>
      transitions.apply(tx, { leg: stale, event: transitions.EVENT.ROUND_SELECTS_COLUMN, storeTime: NOW, context: { columnFeasible: true } }),
    );
    expect([transitions.OUTCOME.LOST_RACE, transitions.OUTCOME.REFUSED]).toContain(roundWrite.outcome);
    const s = await snapshot(store);
    expect(s.leg.state).toBe("CANCELLED");
    // §4.6 rule 2, as the commit transaction's guard G5 sees the flagged Leg.
    expect(transitions.cancellationGuard(s.leg)).toEqual({ ok: false, reason: "CANCELLATION_REQUESTED" });
  });

  test("a round holding the queue row CLAIMED cannot settle it back: its settle is conditional on the version it claimed", async () => {
    const store = seed({ workQueue: { state: "CLAIMED", claimedByRoundId: "round-in-flight", claimedAt: NOW, version: 53077 } });
    await cancel(store, auditSink());
    // The in-flight round's settle (coordinator.settleBatch's write shape): back to QUEUED at its version.
    const settled = await store.client.workQueue.updateMany({
      where: { id: { in: ["wq-820"] }, version: 53077 },
      data: { state: "QUEUED", claimedByRoundId: null, claimedAt: null, version: 53078 },
    });
    expect(settled.count).toBe(0);
    const s = await snapshot(store);
    expect(s.queue.state).toBe("WITHDRAWN");
  });

  test("if the audit event cannot be written, the whole cancellation rolls back", async () => {
    const store = seed();
    const sink = auditSink({ fail: true });
    await expect(cancel(store, sink)).rejects.toMatchObject({ code: "AUDIT_NOT_RECORDED", status: 503 });
    await expectUntouched(store, sink);
    const leg = await store.client.leg.findUnique({ where: { id: LEG_ROW } });
    expect(leg.version).toBe(0);
  });
});

describe("only the immediate case — everything else is refused with nothing written", () => {
  test.each([["DEFERRED"], ["PLANNED"], ["OFFERED"], ["ACCEPTED"], ["EN_ROUTE_PICKUP"], ["LOADED"]])(
    "a Leg in %s is refused (409 ENGINE_CANCELLATION_UNAVAILABLE)",
    async (state) => {
      const store = seed({ leg: { state } });
      const sink = auditSink();
      await expect(cancel(store, sink)).rejects.toMatchObject({ code: "ENGINE_CANCELLATION_UNAVAILABLE", status: 409 });
      await expectUntouched(store, sink, { legState: state });
    },
  );

  test("a QUEUED Leg with an unreleased commitment is not this path (RECALL_THEN_CANCEL): refused, nothing written", async () => {
    const store = seed({ commitments: [] });
    // Counted inside the transaction; a stub count stands in for a live HARD commitment.
    const withCommitment = {
      ...store.client,
      $transaction: (fn) =>
        store.client.$transaction(async (tx) => {
          const wrapped = Object.create(tx);
          wrapped.commitment = { ...tx.commitment, count: async () => 1 };
          return fn(wrapped);
        }),
    };
    const sink = auditSink();
    await expect(
      taskCancellation.cancelQueuedTask(withCommitment, {
        taskRowId: TASK_ROW, taskId: "TSK-820", missionIds: [MISSION_ROW], actor: { id: "u" }, authorised: true, storeTime: NOW, audit: sink.audit,
      }),
    ).rejects.toMatchObject({ code: "HARD_COMMITMENT_EXISTS", status: 409 });
    await expectUntouched(store, sink);
  });

  test("custody HELD is refused (RECOVERY_LEG_REQUIRED is not this path)", async () => {
    const store = seed({ leg: { custodyState: "HELD" } });
    const sink = auditSink();
    await expect(cancel(store, sink)).rejects.toMatchObject({ code: "CUSTODY_HELD", status: 409 });
    await expectUntouched(store, sink);
  });

  test("a task that already has a robot is refused", async () => {
    const store = seed({ task: { robotId: "robot-row-1" } });
    const sink = auditSink();
    await expect(cancel(store, sink)).rejects.toMatchObject({ code: "ENGINE_CANCELLATION_UNAVAILABLE", status: 409 });
    await expectUntouched(store, sink);
  });

  test("an unauthorised requester is refused with 403 and nothing written (§4.6 step 5)", async () => {
    const store = seed();
    const sink = auditSink();
    await expect(cancel(store, sink, { authorised: false })).rejects.toMatchObject({ code: "NOT_AUTHORISED", status: 403 });
    await expectUntouched(store, sink);
  });

  test("an already-terminal task is answered as such without touching anything", async () => {
    const store = seed({ task: { status: "COMPLETED" } });
    const sink = auditSink();
    const result = await cancel(store, sink);
    expect(result.outcome).toBe("ALREADY_TERMINAL");
    const s = await snapshot(store);
    expect(s.leg.state).toBe("QUEUED");
    expect(sink.events).toEqual([]);
  });
});

describe("the §4.6-sourced row itself", () => {
  test("QUEUED + CANCELLATION_RESOLVED → CANCELLED exists, is marked §4.6, and leaves the §4.3-sourced list alone", () => {
    const row = transitions.find("QUEUED", transitions.EVENT.CANCELLATION_RESOLVED);
    expect(row).toMatchObject({ to: "CANCELLED", source: transitions.SECTION_4_6_SOURCED });
    expect(transitions.sectionFourThreeSourcedRows().some((r) => r.event === transitions.EVENT.CANCELLATION_RESOLVED)).toBe(false);
    // Only from QUEUED.
    expect(transitions.find("PLANNED", transitions.EVENT.CANCELLATION_RESOLVED)).toBeNull();
  });

  test("its guard refuses without step 1's flag, with custody, or without commitment evidence", () => {
    const evaluate = transitions.GUARD_EVALUATORS[transitions.GUARD.CANCEL_REQUESTED_NO_COMMITMENT_NO_CUSTODY];
    const leg = { state: "QUEUED", custodyState: "NONE", cancelRequestedAt: NOW };
    expect(evaluate({ leg: { ...leg, cancelRequestedAt: null }, noHardCommitment: true }).ok).toBe(false);
    expect(evaluate({ leg: { ...leg, custodyState: "HELD" }, noHardCommitment: true }).ok).toBe(false);
    expect(evaluate({ leg }).ok).toBe(false); // absent evidence fails (§4.1 rule 3)
    expect(evaluate({ leg, noHardCommitment: false }).ok).toBe(false);
    expect(evaluate({ leg, noHardCommitment: true }).ok).toBe(true);
  });

  test("cancelQueuedLeg refuses every case it does not own before writing", async () => {
    const store = seed();
    const leg = await store.client.leg.findUnique({ where: { id: LEG_ROW } });
    const run = (patch, input) =>
      store.client.$transaction((tx) =>
        cancellation.cancelQueuedLeg(tx, { leg: { ...leg, ...patch }, storeTime: NOW, authorised: true, noHardCommitment: true, ...(input || {}) }),
      );
    expect((await run({ state: "PLANNED" })).reason).toBe("LEG_NOT_QUEUED");
    expect((await run({}, { noHardCommitment: false })).reason).toBe("HARD_COMMITMENT_EXISTS");
    expect((await run({ custodyState: "HELD" })).reason).toBe("CUSTODY_HELD");
    const after = await store.client.leg.findUnique({ where: { id: LEG_ROW } });
    expect(after.version).toBe(0);
    expect(after.cancelRequestedAt).toBeNull();
  });
});
