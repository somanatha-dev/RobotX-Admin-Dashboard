"use strict";

/**
 * P7-D2 (Phase 7, 2026-10-10) — an exhausted reassignment chain on an expired lease is held
 * for an operator, once, and the reconciler converges.
 *
 * The defect, measured on LOCAL: TSK-1790958521622-254 and TSK-1790960698218-551 showed
 * ASSIGNED ("Executing") from 2026-10-02. Each Leg was EN_ROUTE_PICKUP, custody NONE, with
 * three released commitments and one LIVE commitment whose lease had expired. Every 60 s sweep
 * chose REASSIGN, `reassign` refused it with MAX_REASSIGNMENTS_EXHAUSTED and wrote nothing, and
 * the reconciler recorded another repair (700 and 659 rows) — for a week. This suite replaced
 * the characterisation tests that pinned that behaviour.
 *
 * The behaviour asserted now (§4.7: "on exhaustion the Leg goes to SUSPENDED for operator
 * decision"; the Leg machine has no SUSPENDED, so the Leg is frozen in REASSIGNING):
 *
 *   1. steps 1–3 of the custody-NONE protocol, exactly as an ordinary reassignment performs
 *      them — Leg frozen in REASSIGNING (version CAS), this commitment's fence advanced, the
 *      signed RECALL written at the new fence, the commitment released, I6's high-water mark;
 *   2. step 4 replaced: no requeue; REASSIGNING's own deadline (recover.reassign_budget →
 *      ESCALATE) armed instead, and `reconciler.scanOrphanLegs` leaves the Leg to it;
 *   3. later sweeps find nothing to do.
 *
 * Driven through the PRODUCTION composition: `leaderWorkers.COMPOSERS.reconciler` and
 * `COMPOSERS.timer` are composed against the register's own values and the stateful store
 * model, and only the two workers' `start` (their interval loops) is replaced, so the test can
 * call the real `reconciler.sweep` and `timerWorker.fireDue` with exactly the deps and
 * configuration production builds. MOCKED BOUNDARY: the store (`helpers/commitmentStore`, which
 * models REPEATABLE READ + FOR UPDATE, not PostgreSQL's SERIALIZABLE — see the race test).
 */

jest.mock("../../src/workers/reconciler.worker", () => {
  const actual = jest.requireActual("../../src/workers/reconciler.worker");
  return { ...actual, start: jest.fn(() => ({ stop: jest.fn() })) };
});
jest.mock("../../src/workers/timer.worker", () => {
  const actual = jest.requireActual("../../src/workers/timer.worker");
  return { ...actual, start: jest.fn(() => ({ stop: jest.fn() })) };
});

const reconcilerWorker = require("../../src/workers/reconciler.worker");
const timerWorker = require("../../src/workers/timer.worker");
const { COMPOSERS } = require("../../src/workers/leaderWorkers");
const reconciler = require("../../src/engine/supervision/reconciler");
const reassignment = require("../../src/engine/lifecycle/reassignment");
const timers = require("../../src/engine/supervision/timers");
const outbox = require("../../src/engine/dispatch/outbox");
const service = require("../../src/engine/config/service");

const fixtures = require("./helpers/dispatchFixture");

/** The register's own values — the bound, the budgets and the deadlines production resolves. */
const VALUES = service.defaultSnapshot().values;
const MAX = VALUES.get("recover.max_reassignments_per_leg");
const REASSIGN_BUDGET = VALUES.get("recover.reassign_budget");

const plain = (value) => JSON.parse(JSON.stringify(value, (k, v) => (typeof v === "bigint" ? String(v) : v)));

/**
 * One Leg EN_ROUTE_PICKUP, custody NONE, with `released` released commitments and one live one
 * (fence 42) whose lease expired a week ago — LOCAL's shape. Its execution-state timer
 * (PROGRESS_PROBE) is registered at the Leg's current version, as the live Leg's was.
 */
async function legWithExpiredLease({ released = MAX, custodyState = "NONE" } = {}) {
  const fixture = fixtures.seed();
  const live = fixtures.commitmentRow(fixture, { fence: 42n });
  const history = Array.from({ length: released }, (_, i) => ({
    ...fixtures.commitmentRow(fixture, { commitmentId: `commitment-old-${i + 1}`, fence: BigInt(30 + i), slot: i + 1 }),
    releasedAt: new Date(fixture.now.getTime() - (10 - i) * 60_000),
  }));
  const store = fixtures.storeFor(fixture, { commitments: [...history, live] });
  await store.client.agent.update({ where: { id: fixtures.AGENT_ROW_ID }, data: { fenceCounter: 42n } });
  await store.client.commitment.update({
    where: { commitmentId: "commitment-c1" },
    data: { leaseExpiry: new Date(fixture.now.getTime() - 7 * 24 * 3600_000) },
  });
  await store.client.leg.update({ where: { id: fixtures.LEG_ROW_ID }, data: { state: "EN_ROUTE_PICKUP", custodyState } });
  const leg = await store.client.leg.findUnique({ where: { id: fixtures.LEG_ROW_ID } });
  await store.client.$transaction((tx) =>
    timers.register(tx, {
      entityType: timers.ENTITY_TYPE.LEG,
      entityId: leg.id,
      state: "EN_ROUTE_PICKUP",
      entity: leg,
      dueAt: new Date(fixture.now.getTime() + 600_000),
      armedSeconds: 600,
      handler: "PROGRESS_PROBE",
    }),
  );
  return { store, fixture };
}

/** The production reconciler and timer worker, composed over the store. */
function production(store) {
  const records = [];
  const context = {
    prisma: store.client,
    values: VALUES,
    record: (event, detail) => records.push({ event, detail }),
    runInTransaction: (fn) => store.client.$transaction(fn),
    signingKey: fixtures.TEST_SIGNING_KEY,
    shardId: "default",
    regionId: "region-1",
  };
  expect(COMPOSERS.reconciler(context).ok).toBe(true);
  const [reconcilerDeps, reconcilerConfig] = reconcilerWorker.start.mock.calls[reconcilerWorker.start.mock.calls.length - 1];
  expect(COMPOSERS.timer(context).ok).toBe(true);
  const [timerDeps, timerConfig] = timerWorker.start.mock.calls[timerWorker.start.mock.calls.length - 1];
  return {
    records,
    reconcilerConfig,
    sweep: () => reconciler.sweep({ ...reconcilerDeps, readStoreTime: async () => store.now() }, reconcilerConfig),
    fireDue: () => timerWorker.fireDue({ ...timerDeps, readStoreTime: async () => store.now() }, timerConfig),
  };
}

async function state(store) {
  return plain({
    leg: await store.client.leg.findUnique({ where: { id: fixtures.LEG_ROW_ID } }),
    commitments: store.rows("commitment").map((row) => ({ id: row.commitmentId, releasedAt: row.releasedAt, version: row.version })),
    outbox: store.rows("outbox").map((row) => ({ command: row.command, fence: row.fence, state: row.state })),
    timers: store.rows("timer").map((row) => ({ state: row.state, handler: row.handler, timerState: row.timerState, entityVersion: row.entityVersion })),
    agentFence: store.rows("agent")[0].fenceCounter,
    repairs: store.rows("reconcilerRepair").length,
  });
}

describe("P7-D2 — the first recovery of an exhausted chain enters the operator-escalation path", () => {
  test("the register's bound is the one LOCAL publishes", () => {
    expect(MAX).toBe(3);
    expect(Number.isFinite(REASSIGN_BUDGET) && REASSIGN_BUDGET > 0).toBe(true);
  });

  test("one production sweep: Leg frozen in REASSIGNING, incumbent withdrawn at an advanced fence, ESCALATE armed, nothing requeued", async () => {
    const { store, fixture } = await legWithExpiredLease();
    const prod = production(store);
    const before = await store.client.leg.findUnique({ where: { id: fixtures.LEG_ROW_ID } });

    await prod.sweep();

    // The Leg: REASSIGNING, version CAS +1, custody untouched.
    const leg = await store.client.leg.findUnique({ where: { id: fixtures.LEG_ROW_ID } });
    expect(leg).toMatchObject({ state: "REASSIGNING", version: before.version + 1, custodyState: "NONE" });

    // The commitment: released at the store's instant, its version moved.
    const released = store.rows("commitment").find((row) => row.commitmentId === "commitment-c1");
    expect(released.releasedAt).toEqual(fixture.now);
    expect(store.rows("commitment").filter((row) => row.releasedAt === null)).toEqual([]);

    // Fence: this commitment's authority advanced 42 → 43, with I6's high-water mark beside it.
    expect(store.rows("agent")[0].fenceCounter).toBe(43n);
    expect(store.rows("agent")[0].authorityEpoch).toBe(7n); // I19: the agent scope is untouched
    expect(store.rows("agentFenceAudit")[0]).toMatchObject({ fenceHighWater: 43n, lastFenceSource: "commitment-c1" });

    // Exactly one RECALL, at the new fence, superseding the old one.
    const sent = store.rows("outbox");
    expect(sent.map((row) => row.command)).toEqual(["RECALL"]);
    expect(sent[0]).toMatchObject({ commitmentId: "commitment-c1", fence: 43n, state: "PENDING" });
    expect(sent[0].payload).toMatchObject({ supersedesFence: "42", trigger: "LEASE_EXPIRY", reason: "REASSIGNMENT_CHAIN_EXHAUSTED" });

    // Timers: the execution state's deadline cancelled; REASSIGNING's ESCALATE armed at the new version.
    const byState = Object.fromEntries(store.rows("timer").map((row) => [row.state, row]));
    expect(byState.EN_ROUTE_PICKUP.timerState).toBe("CANCELLED");
    expect(byState.REASSIGNING).toMatchObject({ handler: "ESCALATE", timerState: "PENDING", entityVersion: BigInt(leg.version) });
    expect(byState.REASSIGNING.dueAt).toEqual(new Date(fixture.now.getTime() + REASSIGN_BUDGET * 1000));
    expect(byState.REASSIGNING.payload).toMatchObject({ chainExhausted: true, chainLength: 3, awaiting: "OPERATOR_DECISION", supersededCommitment: "commitment-c1" });

    // One repair row for the expiry it processed — not one per sweep.
    const repairs = store.rows("reconcilerRepair");
    expect(repairs.map((row) => `${row.category}/${row.action}`)).toEqual(["LEASE_EXPIRED_UNPROCESSED/RECOVERY_REASSIGN"]);

    // What the engine reports: a transition, the Leg's own id, the operator hand-off.
    const recovered = prod.records.find((r) => r.event === "reconciler.lease_expiry_recovered");
    expect(recovered.detail).toMatchObject({ disposition: "TRANSITIONED", outcome: "SUSPENDED_FOR_OPERATOR:MAX_REASSIGNMENTS_EXHAUSTED:3" });
    const exhausted = prod.records.find((r) => r.event === "timer.reassignment_chain_exhausted");
    expect(exhausted.detail).toMatchObject({ legId: fixtures.LEG_ROW_ID, chainLength: 3, taskState: "SUSPENDED", legState: "REASSIGNING", awaiting: "OPERATOR_DECISION", releasedCommitmentId: "commitment-c1", recallFence: "43" });
  });

  test("reassign() on an exhausted chain returns SUSPENDED with the hand-off, and does not requeue", async () => {
    const { store } = await legWithExpiredLease();
    const leg = await store.client.leg.findUnique({ where: { id: fixtures.LEG_ROW_ID } });
    const agent = await store.client.agent.findUnique({ where: { id: fixtures.AGENT_ROW_ID } });
    const commitment = await store.client.commitment.findUnique({ where: { commitmentId: "commitment-c1" } });
    const legCommitments = store.rows("commitment").filter((row) => row.legId === leg.id);

    const result = await store.client.$transaction((tx) =>
      reassignment.reassign(tx, {
        leg,
        agent,
        commitment,
        legCommitments,
        storeTime: store.now(),
        trigger: reassignment.TRIGGER.LEASE_EXPIRY,
        maxReassignmentsPerLeg: MAX,
        incumbentCooloffSeconds: 300,
        reassignBudgetSeconds: REASSIGN_BUDGET,
        maxDeliveryDelaySeconds: 30,
        signingKey: fixtures.TEST_SIGNING_KEY,
      }),
    );

    expect(result).toMatchObject({
      outcome: reassignment.OUTCOME.SUSPENDED,
      reason: "MAX_REASSIGNMENTS_EXHAUSTED",
      chainLength: 3,
      taskState: "SUSPENDED",
      legId: fixtures.LEG_ROW_ID,
      legState: "REASSIGNING",
      awaiting: "OPERATOR_DECISION",
      requeued: false,
      recallFence: 43n,
      releasedCommitmentId: "commitment-c1",
      authorityEpochTouched: false,
    });
    // An exhausted Leg carries no requeue credit or cooloff: nothing will requeue it.
    expect(result.agingCreditSeconds).toBeUndefined();
    expect(result.excludeIncumbentUntil).toBeUndefined();
    expect(reassignment.chainExceedsBound(store.rows("commitment"), MAX)).toBe(true);
  });
});

describe("P7-D2 — repeated sweeps converge", () => {
  test("ten later sweeps (an hour of store time) write nothing: no recovery, requeue, fence advance, RECALL or repair row", async () => {
    const { store } = await legWithExpiredLease();
    const prod = production(store);
    await prod.sweep();

    // The agent answers the RECALL — the connected case. `settleRow` is what
    // `command.handler`'s COMMAND_ACK path calls on the engine half.
    const recall = store.rows("outbox")[0];
    await outbox.settleRow(store.client, { id: recall.id, state: outbox.OUTBOX_STATE.ACKED, storeTime: store.now() });

    const settled = await state(store);
    const orphanHeld = [];
    for (let sweep = 0; sweep < 10; sweep += 1) {
      store.advanceClock(360);
      // eslint-disable-next-line no-await-in-loop
      const result = await prod.sweep();
      orphanHeld.push(result.results.find((r) => r.category === reconciler.DIVERGENCE.ORPHAN_LEG).heldForOperator);
      expect(result.total).toBe(0);
    }

    const after = await state(store);
    expect(after.leg).toEqual(settled.leg);
    expect(after.commitments).toEqual(settled.commitments);
    expect(after.outbox).toEqual(settled.outbox);
    expect(after.agentFence).toBe(settled.agentFence);
    expect(after.repairs).toBe(settled.repairs); // still the single LEASE_EXPIRED row
    // The orphan scan saw the Leg every time and left it to its ESCALATE deadline.
    expect(orphanHeld).toEqual(Array(10).fill([fixtures.LEG_ROW_ID]));
    expect(prod.records.filter((r) => r.event === "reconciler.lease_expiry_recovered")).toHaveLength(1);
  });

  test("a RECALL the agent never answers is the dispatch ladder's, exactly as for an ordinary reassignment — not new reassignment churn", async () => {
    // The only repair a later sweep can record is §12.4 row 8 (OUTBOX_UNDELIVERED_PAST_DEADLINE)
    // for the RECALL once it outlives `notValidAfter`, until the outbox worker settles it. That
    // is the existing dispatch ladder for every RECALL; shown here side by side.
    async function undeliveredRepairsAfterSweeps(released) {
      const { store } = await legWithExpiredLease({ released });
      const prod = production(store);
      await prod.sweep();
      // Past the RECALL's `notValidAfter` (`dispatch.max_delivery_delay` from the register).
      store.advanceClock(VALUES.get("dispatch.max_delivery_delay") + 1);
      await prod.sweep();
      return {
        outboxUndelivered: store.rows("reconcilerRepair").filter((row) => row.category === "OUTBOX_UNDELIVERED_PAST_DEADLINE").length,
        leaseRecoveries: store.rows("reconcilerRepair").filter((row) => row.category === "LEASE_EXPIRED_UNPROCESSED").length,
        recalls: store.rows("outbox").filter((row) => row.command === "RECALL").length,
      };
    }
    const exhausted = await undeliveredRepairsAfterSweeps(MAX);
    const ordinary = await undeliveredRepairsAfterSweeps(MAX - 1);
    expect(exhausted).toEqual({ outboxUndelivered: 1, leaseRecoveries: 1, recalls: 1 });
    expect(exhausted.outboxUndelivered).toBe(ordinary.outboxUndelivered);
  });
});

describe("P7-D2 — the escalation deadline and the acknowledgement follow the existing protocol", () => {
  test("ESCALATE fires at recover.reassign_budget, alerts with chainExhausted, re-arms the same row, and moves nothing", async () => {
    const { store } = await legWithExpiredLease();
    const prod = production(store);
    await prod.sweep();
    const frozen = await state(store);
    const pending = () => store.rows("timer").find((row) => row.state === "REASSIGNING");
    const firstDue = pending().dueAt;

    store.advanceClock(REASSIGN_BUDGET - 1);
    expect((await prod.fireDue()).due).toBe(0); // not before its deadline

    store.advanceClock(1);
    const summary = await prod.fireDue();
    expect(summary).toMatchObject({ due: 1, rearmed: 1, fired: 0, discarded: 0 });
    const escalated = prod.records.find((r) => r.event === "timer.reassignment_escalated");
    expect(escalated.detail).toMatchObject({ legId: fixtures.LEG_ROW_ID, chainExhausted: true, chainLength: MAX + 1, taskState: "SUSPENDED" });

    // Durable: the same row, still PENDING, re-armed one budget on; the Leg did not move.
    expect(pending()).toMatchObject({ timerState: "PENDING", attempts: 1, handler: "ESCALATE" });
    expect(pending().dueAt.getTime()).toBe(firstDue.getTime() + REASSIGN_BUDGET * 1000);
    const after = await state(store);
    expect(after.leg).toEqual(frozen.leg);
    expect(after.outbox).toEqual(frozen.outbox);
    expect(after.agentFence).toBe(frozen.agentFence);
  });

  test("the RECALL acknowledgement settles the outbox row and nothing else; the Leg stays held", async () => {
    const { store } = await legWithExpiredLease();
    const prod = production(store);
    await prod.sweep();
    const before = await state(store);

    const recall = store.rows("outbox")[0];
    expect(await outbox.settleRow(store.client, { id: recall.id, state: outbox.OUTBOX_STATE.ACKED, storeTime: store.now() })).toBe(1);

    const after = await state(store);
    expect(after.outbox).toEqual([{ command: "RECALL", fence: "43", state: "ACKED" }]);
    expect(after.leg).toEqual(before.leg);
    expect(after.commitments).toEqual(before.commitments);
    expect(after.timers).toEqual(before.timers);
    // And the next sweep still leaves it to the operator.
    store.advanceClock(60);
    const swept = await prod.sweep();
    expect(swept.results.find((r) => r.category === reconciler.DIVERGENCE.ORPHAN_LEG).heldForOperator).toEqual([fixtures.LEG_ROW_ID]);
    expect((await store.client.leg.findUnique({ where: { id: fixtures.LEG_ROW_ID } })).state).toBe("REASSIGNING");
  });

  test("a stale execution-state timer cannot touch the frozen Leg: it is cancelled, and if a pass had already selected it, it is discarded", async () => {
    const { store } = await legWithExpiredLease();
    const prod = production(store);
    await prod.sweep();
    const probe = store.rows("timer").find((row) => row.state === "EN_ROUTE_PICKUP");
    expect(probe.timerState).toBe("CANCELLED");
    const frozen = await state(store);

    // Model a pass that selected the PROGRESS_PROBE before the cancellation committed: put the
    // row back to PENDING and due (a test-only rewind; nothing in production writes this).
    await store.client.timer.update({ where: { id: probe.id }, data: { timerState: "PENDING", dueAt: store.now() } });
    const summary = await prod.fireDue();

    expect(summary.discarded).toBe(1);
    expect(store.rows("timer").find((row) => row.id === probe.id)).toMatchObject({ timerState: "DISCARDED", lastOutcome: "ENTITY_VERSION_MOVED_ON" });
    const after = await state(store);
    expect(after.leg).toEqual(frozen.leg);
    expect(after.outbox).toEqual(frozen.outbox);
    expect(prod.records.some((r) => r.event === "timer.progress_probe")).toBe(false);
  });
});

describe("P7-D2 — races and invariants", () => {
  test("a recovery acting on rows read before another recovery committed loses the Leg CAS and writes nothing", async () => {
    const { store } = await legWithExpiredLease();
    const prod = production(store);
    const staleLeg = await store.client.leg.findUnique({ where: { id: fixtures.LEG_ROW_ID } });
    const staleAgent = await store.client.agent.findUnique({ where: { id: fixtures.AGENT_ROW_ID } });
    const staleCommitment = await store.client.commitment.findUnique({ where: { commitmentId: "commitment-c1" } });
    const legCommitments = store.rows("commitment").filter((row) => row.legId === staleLeg.id);

    await prod.sweep(); // the winner
    const won = await state(store);

    const late = await store.client.$transaction((tx) =>
      reassignment.reassign(tx, {
        leg: staleLeg,
        agent: staleAgent,
        commitment: staleCommitment,
        legCommitments,
        storeTime: store.now(),
        trigger: reassignment.TRIGGER.LEASE_EXPIRY,
        maxReassignmentsPerLeg: MAX,
        incumbentCooloffSeconds: 300,
        reassignBudgetSeconds: REASSIGN_BUDGET,
        maxDeliveryDelaySeconds: 30,
        signingKey: fixtures.TEST_SIGNING_KEY,
      }),
    );
    expect(late).toMatchObject({ outcome: reassignment.OUTCOME.LOST_RACE, reason: "LEG_VERSION_MOVED" });
    expect(await state(store)).toEqual(won); // no second fence, RECALL, release or timer
  });

  test("the reconciler's recovery re-reads the commitment: a second call with the scan's stale row is a no-op", async () => {
    const { store } = await legWithExpiredLease();
    const prod = production(store);
    const scanned = await store.client.commitment.findUnique({ where: { commitmentId: "commitment-c1" } });
    await prod.sweep();
    const won = await state(store);

    const [reconcilerDeps] = reconcilerWorker.start.mock.calls[reconcilerWorker.start.mock.calls.length - 1];
    expect(await reconcilerDeps.recover({ commitment: scanned })).toEqual({ outcome: "COMMITMENT_ALREADY_RELEASED" });
    expect(await state(store)).toEqual(won);
  });

  test("custody HELD is never routed here: an exhausted chain with goods aboard writes nothing through reassign()", async () => {
    const { store } = await legWithExpiredLease({ custodyState: "HELD" });
    const leg = await store.client.leg.findUnique({ where: { id: fixtures.LEG_ROW_ID } });
    const agent = await store.client.agent.findUnique({ where: { id: fixtures.AGENT_ROW_ID } });
    const commitment = await store.client.commitment.findUnique({ where: { commitmentId: "commitment-c1" } });
    const before = await state(store);
    const result = await store.client.$transaction((tx) =>
      reassignment.reassign(tx, {
        leg,
        agent,
        commitment,
        legCommitments: store.rows("commitment"),
        storeTime: store.now(),
        maxReassignmentsPerLeg: MAX,
        reassignBudgetSeconds: REASSIGN_BUDGET,
        maxDeliveryDelaySeconds: 30,
        signingKey: fixtures.TEST_SIGNING_KEY,
      }),
    );
    expect(result).toMatchObject({ outcome: reassignment.OUTCOME.REFUSED, reason: "CUSTODY_HELD" });
    expect(await state(store)).toEqual(before);
  });

  test("an unresolved bound in the reconciler keeps the old orphan requeue (no Leg is held by a guess)", async () => {
    const { store } = await legWithExpiredLease();
    const prod = production(store);
    await prod.sweep();
    const { maxReassignmentsPerLeg, ...withoutBound } = prod.reconcilerConfig;
    expect(maxReassignmentsPerLeg).toBe(MAX);
    const result = await reconciler.scanOrphanLegs(
      { prisma: store.client, runInTransaction: (fn) => store.client.$transaction(fn), readStoreTime: async () => store.now() },
      withoutBound,
      store.now(),
    );
    expect(result.heldForOperator).toEqual([]);
    expect(result.repairs.map((r) => r.legId)).toEqual([fixtures.LEG_ROW_ID]);
  });
});

describe("P7-D2 — ordinary (non-exhausted) reassignment is unchanged", () => {
  test("with chain length below the bound the Leg is reassigned and the orphan scan requeues it, as before", async () => {
    const { store } = await legWithExpiredLease({ released: MAX - 1 });
    const prod = production(store);

    await prod.sweep();
    const recovered = prod.records.find((r) => r.event === "reconciler.lease_expiry_recovered");
    expect(recovered.detail).toMatchObject({ disposition: "TRANSITIONED", outcome: "REASSIGNED:commitment-c1" });
    expect(prod.records.some((r) => r.event === "timer.reassignment_chain_exhausted")).toBe(false);
    const reassigning = store.rows("timer").find((row) => row.state === "REASSIGNING");
    // Exactly the pre-P7-D2 payload (`timers.register` adds `armedSeconds` itself).
    expect(reassigning.payload).toEqual({ trigger: "LEASE_EXPIRY", supersededCommitment: "commitment-c1", armedSeconds: REASSIGN_BUDGET });
    expect(store.rows("outbox")[0].payload).toMatchObject({ reason: "REASSIGNMENT" });

    // Released count is now exactly the bound (≤ max): the next sweep's orphan scan requeues it.
    expect(reassignment.chainExceedsBound(store.rows("commitment"), MAX)).toBe(false);
    store.advanceClock(60);
    const next = await prod.sweep();
    const orphan = next.results.find((r) => r.category === reconciler.DIVERGENCE.ORPHAN_LEG);
    expect(orphan.heldForOperator).toEqual([]);
    expect(orphan.repairs.map((r) => r.legId)).toEqual([fixtures.LEG_ROW_ID]);
    expect((await store.client.leg.findUnique({ where: { id: fixtures.LEG_ROW_ID } })).state).toBe("QUEUED");
  });

  test("chainExceedsBound: strictly greater than the bound, and false (never a guess) when the bound is unresolved", () => {
    const releasedN = (n) => Array.from({ length: n }, () => ({ releasedAt: new Date() }));
    expect(reassignment.chainExceedsBound(releasedN(3), 3)).toBe(false); // after a permitted 3rd reassignment
    expect(reassignment.chainExceedsBound(releasedN(4), 3)).toBe(true); // after the exhausted withdrawal
    expect(reassignment.chainExceedsBound([...releasedN(3), { releasedAt: null }], 3)).toBe(false); // a live one is not history
    expect(reassignment.chainExceedsBound(releasedN(1), 0)).toBe(true);
    expect(reassignment.chainExceedsBound(releasedN(9), undefined)).toBe(false);
    expect(reassignment.chainExceedsBound(releasedN(9), -1)).toBe(false);
  });
});
