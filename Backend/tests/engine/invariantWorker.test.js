"use strict";

/**
 * Engine lane — Phase 12: the Invariant Checker's driver and its two sweeps.
 *
 * The worker is where the checker's *findings* become durable rows, socket events, and
 * alerts. Three of its behaviours are load-bearing and are what this file is mostly about:
 *
 *   · A check that could not run writes **nothing**, leaving the previous status standing.
 *     A row overwritten with "we did not look" reads as an assertion about the fleet and is
 *     an assertion about the checker.
 *   · I6's high-water marks are written **after** the comparison, and never retreat.
 *     Writing first would advance the mark past a regression and make the next pass report
 *     the fleet as monotone.
 *   · §18.6 step 5's sweep is a separate pass from the check, because the checker must not
 *     repair what it audits.
 */

const invariantWorker = require("../../src/workers/invariant.worker");
const invariantChecker = require("../../src/engine/observability/invariantChecker");
const transitions = require("../../src/engine/degraded/transitions");
const modeRegister = require("../../src/engine/degraded/modeRegister");
const externalEscalation = require("../../src/engine/failure/externalEscalation");
const { memoryStore, healthyWorld } = require("./helpers/degradedFixture");

const NOW = 1770000000000;
const SHARD = "shard-a";

/** @param {object} [seed] @returns {object} */
function store(seed) {
  return memoryStore(healthyWorld({ nowMs: NOW, ...(seed || {}) }));
}

/** @param {object} [overrides] @returns {object} */
function context(overrides) {
  return {
    shardId: SHARD,
    nowMs: NOW,
    windowMs: 300000,
    statesWithoutDeadline: ["LOADED"],
    softReservedLegIds: [],
    productionOnly: { shadowLabel: null },
    defaultCapacity: 1,
    ladderBudgetSeconds: 3600,
    tierEventBudgets: { T1: 100, T2: 10 },
    sweepEscalations: false,
    ...(overrides || {}),
  };
}

describe("the check pass", () => {
  test("persists one status row per invariant, keyed for upsert", async () => {
    const prisma = store();
    const pass = await invariantWorker.checkPass({ prisma }, context());

    expect(pass.persisted).toBe(22);
    expect(prisma.__store.invariantStatus.filter((row) => row.subjectType === "SHARD")).toHaveLength(22);
    // Idempotent: a second pass updates rather than duplicating.
    await invariantWorker.checkPass({ prisma }, context({ nowMs: NOW + 60000 }));
    expect(prisma.__store.invariantStatus.filter((row) => row.subjectType === "SHARD")).toHaveLength(22);
  });

  test("a suspended status records the authorising mode; an enforced one records none", async () => {
    const prisma = store();
    prisma.__store.commitment[0].leaseExpiry = new Date(NOW - 1000);
    await transitions.enter({ prisma }, {
      mode: modeRegister.MODE.CUSTODIAL_OPERATION,
      shardId: SHARD,
      cause: "B1",
      enteringComponent: "test",
      atMs: NOW,
      maxDurationMs: 900000,
    });

    await invariantWorker.checkPass({ prisma }, context());

    const i2 = prisma.__store.invariantStatus.find((row) => row.invariantId === "I2" && row.subjectType === "SHARD");
    expect(i2.status).toBe(invariantChecker.STATUS.SUSPENDED);
    // The schema's `InvariantStatus_suspension_names_its_mode` CHECK is written against
    // exactly this pair of properties, in both directions.
    expect(i2.authorisingMode).toBe(modeRegister.MODE.CUSTODIAL_OPERATION);

    const i1 = prisma.__store.invariantStatus.find((row) => row.invariantId === "I1" && row.subjectType === "SHARD");
    expect(i1.status).toBe(invariantChecker.STATUS.ENFORCED);
    expect(i1.authorisingMode).toBeNull();
  });

  test("a check that could not run leaves the previous row standing", async () => {
    const prisma = store();
    await invariantWorker.checkPass({ prisma }, context());
    const before = prisma.__store.invariantStatus.find((row) => row.invariantId === "I1" && row.subjectType === "SHARD");
    expect(before.status).toBe(invariantChecker.STATUS.ENFORCED);

    prisma.commitment.groupBy = async () => {
      throw new Error("connection terminated");
    };
    const pass = await invariantWorker.checkPass({ prisma }, context({ nowMs: NOW + 60000 }));

    // Two checks read commitments by `groupBy`, so two go unwritten.
    expect(pass.persisted).toBe(20);
    expect(pass.summary.checkerHealthy).toBe(false);
    const after = prisma.__store.invariantStatus.find((row) => row.invariantId === "I1" && row.subjectType === "SHARD");
    expect(after.status).toBe(invariantChecker.STATUS.ENFORCED);
    expect(after.checkedAt.getTime()).toBe(NOW);
  });

  test("emits a socket event per status change and none for a steady register", async () => {
    const prisma = store();
    const first = await invariantWorker.checkPass({ prisma }, context());
    // The first pass reports every invariant for the first time, which is a change from
    // nothing rather than noise.
    expect(first.changes).toHaveLength(22);

    // A second pass over an unchanged world emits nothing. The step is deliberately small:
    // the fixture's lease expires at NOW + 60 s, and a pass past that point would find a
    // real I2 violation — which would make this test pass for the wrong reason.
    const second = await invariantWorker.checkPass({ prisma }, context({ nowMs: NOW + 1000 }));
    expect(second.changes).toEqual([]);

    prisma.__store.leg[0].custodyState = "HELD";
    prisma.__store.commitment[0].releasedAt = new Date(NOW);
    const third = await invariantWorker.checkPass({ prisma }, context({ nowMs: NOW + 2000 }));
    const i7 = third.changes.find((change) => change.payload.invariantId === "I7");
    expect(i7.payload).toMatchObject({ from: "ENFORCED", to: "VIOLATED" });
  });
});

describe("PHASE 12 REMEDIATION — the checks that could not fail in any composition", () => {
  /**
   * The context the production composition root actually supplies. `server.js` passes
   * `{ shardId, checkIntervalSeconds }` and the resolved configuration; it does not — and
   * should not have to — name each check's evidence field. Every test in this block runs
   * against *this* shape, not against the fully-specified `context()` above, because the gap
   * between the two is where every defect in this block lived.
   */
  function productionShaped(overrides) {
    return { shardId: SHARD, nowMs: NOW, windowMs: 300000, sweepEscalations: false, ...(overrides || {}) };
  }

  test("I12 detects a modified terminal row across two passes", async () => {
    // Before the fix: `checkI12` returned `terminalVersionMarks` for the caller to persist and
    // the worker dropped them, so `context.terminalVersionMarks` was empty on every pass and
    // the comparison `previous !== undefined` was never true. I12 — a Tier 0 safety-core
    // invariant — could not report `VIOLATED` in any composition, including its own worker.
    // The unit test that "proved" it could injected a mark by hand.
    const prisma = store();
    const terminal = prisma.__store.leg[0];
    terminal.state = "SETTLED";
    terminal.version = 7;
    terminal.updatedAt = new Date(NOW - 1000);

    const state = {};
    const first = await invariantWorker.checkPass({ prisma }, productionShaped({ checkerState: state }));
    expect(first.results.find((row) => row.invariantId === "I12").status).toBe(invariantChecker.STATUS.ENFORCED);

    // Somebody writes to a settled row. That is the whole of I12.
    terminal.version = 8;
    terminal.updatedAt = new Date(NOW + 1000);

    const second = await invariantWorker.checkPass({ prisma }, productionShaped({ nowMs: NOW + 60000, checkerState: state }));
    const i12 = second.results.find((row) => row.invariantId === "I12");
    expect(i12.status).toBe(invariantChecker.STATUS.VIOLATED);
    expect(i12.violations[0]).toMatchObject({ problem: "TERMINAL_ROW_MODIFIED", versionWas: "7", versionNow: "8" });
  });

  test("I12's marks survive a restart, because they are backed up on the row the pass writes", async () => {
    const prisma = store();
    const terminal = prisma.__store.leg[0];
    terminal.state = "SETTLED";
    terminal.version = 7;
    terminal.updatedAt = new Date(NOW - 1000);

    await invariantWorker.checkPass({ prisma }, productionShaped({ checkerState: {} }));
    terminal.version = 8;
    terminal.updatedAt = new Date(NOW + 1000);

    // A *fresh* carry object — a restarted process. The marks come back from the stored row.
    const afterRestart = await invariantWorker.checkPass({ prisma }, productionShaped({ nowMs: NOW + 60000, checkerState: {} }));
    expect(afterRestart.results.find((row) => row.invariantId === "I12").status).toBe(invariantChecker.STATUS.VIOLATED);
  });

  test("I5 detects a rising fence-rejection baseline across two passes", async () => {
    // Before the fix: `previousFenceRejections` had no producer, so `before` was always null
    // and no count could ever be a rise. I5 was structurally incapable of reporting a
    // violation.
    const prisma = store();
    const rejection = (n, at) => ({
      id: `ob-f${n}`, idempotencyKey: `kf${n}`, agentId: "agent-1", command: "ASSIGN",
      fenceScope: "MISSION", lastError: "FENCE_REJECTED", updatedAt: at,
    });
    prisma.__store.outbox.push(rejection(1, new Date(NOW - 10000)));

    const state = {};
    const first = await invariantWorker.checkPass({ prisma }, productionShaped({ checkerState: state }));
    expect(first.results.find((row) => row.invariantId === "I5").status).toBe(null);

    prisma.__store.outbox.push(rejection(2, new Date(NOW + 30000)), rejection(3, new Date(NOW + 31000)));
    const second = await invariantWorker.checkPass({ prisma }, productionShaped({ nowMs: NOW + 60000, checkerState: state }));
    const i5 = second.results.find((row) => row.invariantId === "I5");
    expect(i5.status).toBe(invariantChecker.STATUS.VIOLATED);
    expect(i5.violations[0]).toMatchObject({ scope: "MISSION" });
  });

  test("I5 is ENFORCED with no baseline only when it observed nothing — the one provable case", async () => {
    const prisma = store();
    const pass = await invariantWorker.checkPass({ prisma }, productionShaped({ checkerState: {} }));
    const i5 = pass.results.find((row) => row.invariantId === "I5");
    // Zero cannot be a rise from any non-negative baseline, so this is arithmetic and not a
    // guess. With rejections present and no baseline the status is null — see the test above.
    expect(i5.status).toBe(invariantChecker.STATUS.ENFORCED);
    expect(i5.detail).toMatch(/a count of zero cannot be a rise/);
  });

  test("a healthy fleet does not page under the production context", async () => {
    // The defect this replaces is the one that mattered most: on a fleet that is healthy *by
    // the specification*, the production context produced I4 = VIOLATED (a LOADED Leg has no
    // §4.5 deadline and is legitimately timerless) and I13 = VIOLATED (an entry no round has
    // considered yet, against a ladder budget defaulted to zero). `summary.pageWorthy` was
    // true. Phase 12's own completion gate is "the invariant-violation SLI is zero in nominal
    // operation", and the composition root failed it on an empty defect list.
    const prisma = store();
    prisma.__store.leg.push({
      id: "leg-loaded", legId: "LEG-LOADED", state: "LOADED", purpose: "PRIMARY",
      custodyState: "NONE", version: 3, missionId: prisma.__store.leg[0].missionId,
      obstructionClass: null, updatedAt: new Date(NOW - 5000), cancelRequestedAt: null,
    });
    prisma.__store.commitment.push({
      id: "c-loaded", commitmentId: "C-LOADED", agentId: "agent-9", legId: "leg-loaded",
      kind: "HARD", releasedAt: null, leaseExpiry: new Date(NOW + 600000), fence: 91,
      // A real reference: a commitment with none is an I10 violation, and this test is about
      // I4 and I13.
      decisionRef: prisma.__store.commitment[0].decisionRef, grantedAt: new Date(NOW - 5000),
    });
    prisma.__store.workQueue.push({
      id: "wq-new", legId: "leg-fresh", shardId: SHARD, state: "QUEUED",
      enqueuedAt: new Date(NOW - 300000), roundsConsidered: 0, consecutiveDeferrals: 0,
    });

    const pass = await invariantWorker.checkPass({ prisma }, productionShaped());

    expect(pass.summary.pageWorthy).toBe(false);
    expect(pass.summary.violatedInvariants).toEqual([]);
    // I4 is genuinely verified rather than merely quiet: the LOADED Leg is excluded because
    // §4.5 gives that state no deadline, from `legMachine.statesWithoutDeadline()`.
    expect(pass.results.find((row) => row.invariantId === "I4").status).toBe(invariantChecker.STATUS.ENFORCED);
    // I13 has no resolved ladder budget here, and says so rather than paging or claiming clean.
    const i13 = pass.results.find((row) => row.invariantId === "I13");
    expect(i13.status).toBe(null);
    expect(i13.checkError).toMatch(/no §17.4 ladder budget/);
    expect(pass.summary.checkerHealthy).toBe(false);
  });

  test("I4 still fires for a state that does have a deadline", async () => {
    // The complement of the test above: the exclusion is §4.5's list and not a blanket amnesty.
    const prisma = store();
    prisma.__store.leg.push({
      id: "leg-enroute", legId: "LEG-ENROUTE", state: "EN_ROUTE_DROP", purpose: "PRIMARY",
      custodyState: "HELD", version: 2, missionId: prisma.__store.leg[0].missionId,
      obstructionClass: null, updatedAt: new Date(NOW - 5000), cancelRequestedAt: null,
    });
    prisma.__store.commitment.push({
      id: "c-enroute", commitmentId: "C-ENROUTE", agentId: "agent-8", legId: "leg-enroute",
      kind: "HARD", releasedAt: null, leaseExpiry: new Date(NOW + 600000), fence: 92,
      decisionRef: prisma.__store.commitment[0].decisionRef, grantedAt: new Date(NOW - 5000),
    });

    const pass = await invariantWorker.checkPass({ prisma }, productionShaped());
    const i4 = pass.results.find((row) => row.invariantId === "I4");
    expect(i4.status).toBe(invariantChecker.STATUS.VIOLATED);
    expect(i4.violations.some((row) => row.legId === "LEG-ENROUTE" && row.problem === "NO_PENDING_TIMER")).toBe(true);
  });

  test("the shadow filter is applied by default, so §21.6 runs are not audited as production", async () => {
    // I9, I14, I15 and I20 all read `DecisionRecordA`, and all four took the production filter
    // from `context.productionOnly`. `server.js` supplied none, so every shadow decision —
    // "recorded and never executed" (§21.6) — was audited as though the fleet had executed it.
    const prisma = store();
    prisma.__store.decisionRecordA.push({
      id: "dr-shadow", decisionId: "D-SHADOW", shardId: SHARD, shadowLabel: "SHADOW",
      decisionTime: new Date(NOW - 1000), legId: "leg-1",
      outcome: { action: "ASSIGNED", chosenBindingPredicateId: "F34" },
      versions: {}, runnerUpAndTopN: [], searchAndSolveBounds: {}, rejectionSummary: null,
    });

    const withDefault = await invariantWorker.checkPass({ prisma }, productionShaped());
    expect(withDefault.results.find((row) => row.invariantId === "I9").status).toBe(invariantChecker.STATUS.ENFORCED);
    expect(withDefault.results.find((row) => row.invariantId === "I15").status).toBe(invariantChecker.STATUS.ENFORCED);

    // Without the filter the same shadow row is an I9 violation and an I15 violation — which is
    // what the register reported before the default landed.
    const unfiltered = await invariantWorker.checkPass({ prisma }, productionShaped({ productionOnly: {} }));
    expect(unfiltered.results.find((row) => row.invariantId === "I9").status).toBe(invariantChecker.STATUS.VIOLATED);
  });

  test("I17 compares a count over the tier's own timescale, not over the checker's window", async () => {
    // §26.1: "T1 by event count over days, T2 by event count over quarters", against a
    // **fleet-year** budget. The check compared a five-minute count against 365 events/year,
    // which no integer count of events in five minutes can exceed: the comparison could not
    // fire at all. The budget is now pro-rated to each tier's own window.
    const prisma = store();
    const budgets = { T1: 365000, T2: 365, T3: 4 };
    // T2's quarter allowance is 365 × 91/365 = 91 events. Two is inside it.
    for (let n = 0; n < 2; n += 1) {
      prisma.__store.calibrationObservation.push({
        id: `co-t2-${n}`, predictor: "ENERGY_SHORTFALL", tier: "T2", eventOccurred: true,
        observedAt: new Date(NOW - 86400000 * (n + 1)),
      });
    }
    const inside = await invariantWorker.checkPass({ prisma }, productionShaped({ tierEventBudgets: budgets }));
    expect(inside.results.find((row) => row.invariantId === "I17").status).toBe(invariantChecker.STATUS.ENFORCED);

    // Ninety-two in a quarter is outside it. Under the old comparison this was `2 > 365` and
    // `92 > 365` alike — both false, both reported ENFORCED.
    for (let n = 2; n < 93; n += 1) {
      prisma.__store.calibrationObservation.push({
        id: `co-t2-${n}`, predictor: "ENERGY_SHORTFALL", tier: "T2", eventOccurred: true,
        observedAt: new Date(NOW - 3600000 * (n + 1)),
      });
    }
    const outside = await invariantWorker.checkPass({ prisma }, productionShaped({ tierEventBudgets: budgets }));
    const i17 = outside.results.find((row) => row.invariantId === "I17");
    expect(i17.status).toBe(invariantChecker.STATUS.VIOLATED);
    expect(i17.violations[0]).toMatchObject({ tier: "T2", problem: "REALISED_RATE_EXCEEDS_TIER_BUDGET", windowDays: 91 });
  });

  test("I17 with no budget is ENFORCED on zero events and unverified on any", async () => {
    const prisma = store();
    const clean = await invariantWorker.checkPass({ prisma }, productionShaped());
    expect(clean.results.find((row) => row.invariantId === "I17").status).toBe(invariantChecker.STATUS.ENFORCED);

    prisma.__store.calibrationObservation.push({
      id: "co-1", predictor: "ENERGY_SHORTFALL", tier: "T1", eventOccurred: true,
      observedAt: new Date(NOW - 3600000),
    });
    const unverified = await invariantWorker.checkPass({ prisma }, productionShaped({ nowMs: NOW + 1000 }));
    const i17 = unverified.results.find((row) => row.invariantId === "I17");
    expect(i17.status).toBe(null);
    expect(i17.checkError).toMatch(/no fleet-year budget was resolved/);
  });
});

describe("PHASE 12 REMEDIATION — §18.6's chain reaches production", () => {
  test("opens steps 1-3 for an obstructing stranding that has no chain", async () => {
    // `externalEscalation.openChain()` had no caller anywhere in the tree: the one response
    // chain that reaches outside the operator was never opened by any production path, and
    // I22's "matching escalation path" audit would have reported VIOLATED for every genuinely
    // obstructing stranding — correctly, and for ever.
    const prisma = store();
    prisma.__store.leg[0].state = "STRANDED_OBSTRUCTING";
    prisma.__store.leg[0].obstructionClass = "BLOCKING_CRITICAL";

    const pass = await invariantWorker.chainOpenPass(
      {
        prisma,
        readEscalationContext: async () => ({
          position: { lat: 1, lon: 2 }, custodyManifest: ["parcel-1"], agentCondition: "IMMOBILISED",
          hazardState: "SEVERE", physicalAccessInstructions: "gate 4, code 1234", segmentId: "seg-9",
        }),
        regionOf: async () => "region-a",
      },
      {
        nowMs: NOW,
        escalationContacts: { "region-a": { owner: "Ops lead", contacts: ["+441234"], reviewedAtMs: NOW - 1000 } },
        contactReviewPeriodSeconds: 86400,
        emergencyServicesThreshold: { obstructionClasses: ["BLOCKING_CRITICAL"], hazardStates: ["SEVERE"] },
      },
    );

    expect(pass.opened).toHaveLength(1);
    expect(pass.opened[0].steps).toEqual([1, 2, 3]);
    const rows = prisma.__store.externalEscalation;
    expect(rows.map((row) => row.step).sort()).toEqual([1, 2, 3]);
    // Step 4 is never written by an automatic path: a step-4 row with no operator is a call
    // nobody authorised, and the schema CHECK refuses one. The *offer* is recorded instead.
    expect(rows.some((row) => row.step === 4)).toBe(false);
    expect(rows.find((row) => row.step === 1).detail.emergencyServicesEligible).toBe(true);
    expect(pass.opened[0].emergencyServicesGated).toBe(true);
    expect(pass.sockets[0].event).toBe("STRANDING_ESCALATED");
  });

  test("is idempotent — a second pass does not page a responder twice for one incident", async () => {
    const prisma = store();
    prisma.__store.leg[0].state = "STRANDED_OBSTRUCTING";
    prisma.__store.leg[0].obstructionClass = "BLOCKING_CRITICAL";

    await invariantWorker.chainOpenPass({ prisma }, { nowMs: NOW });
    const afterFirst = prisma.__store.externalEscalation.length;
    const second = await invariantWorker.chainOpenPass({ prisma }, { nowMs: NOW + 60000 });

    expect(second.opened).toHaveLength(0);
    expect(prisma.__store.externalEscalation).toHaveLength(afterFirst);
  });

  test("does not open a chain for a stranding that obstructs nothing", async () => {
    const prisma = store();
    prisma.__store.leg[0].state = "STRANDED_SAFE";
    prisma.__store.leg[0].obstructionClass = "CLEAR";

    const pass = await invariantWorker.chainOpenPass({ prisma }, { nowMs: NOW });
    expect(pass.obstructing).toBe(0);
    expect(prisma.__store.externalEscalation).toHaveLength(0);
  });

  test("records an absent contact set as a finding rather than a silent no-op", async () => {
    // `ops.external_escalation_contacts` is seeded null and `required`, because a fabricated
    // contact is worse than a recorded absence. The chain still opens; step 3 records why it
    // reached nobody.
    const prisma = store();
    prisma.__store.leg[0].state = "STRANDED_OBSTRUCTING";
    prisma.__store.leg[0].obstructionClass = "BLOCKING_CRITICAL";

    const pass = await invariantWorker.chainOpenPass({ prisma }, { nowMs: NOW, escalationContacts: null });
    expect(pass.opened[0].contactSetConfigured).toBe(false);
    const step3 = prisma.__store.externalEscalation.find((row) => row.step === 3);
    expect(step3.disposition).toBe(externalEscalation.DISPOSITION.NO_CONTACT_CONFIGURED);
  });

  test("I22 goes from VIOLATED to ENFORCED once the chain the spec requires exists", async () => {
    // The end-to-end statement: the checker's audit and the chain opener are joined by the
    // durable table rather than by two tests that agree with each other.
    const prisma = store();
    prisma.__store.leg[0].state = "STRANDED_OBSTRUCTING";
    prisma.__store.leg[0].obstructionClass = "BLOCKING_CRITICAL";

    const before = await invariantWorker.checkPass({ prisma }, { shardId: SHARD, nowMs: NOW, sweepEscalations: false });
    const i22Before = before.results.find((row) => row.invariantId === "I22");
    expect(i22Before.status).toBe(invariantChecker.STATUS.VIOLATED);
    expect(i22Before.violations[0].problem).toBe("OBSTRUCTING_STRANDING_WITH_NO_ESCALATION_CHAIN");

    await invariantWorker.chainOpenPass({ prisma }, { nowMs: NOW });

    const after = await invariantWorker.checkPass({ prisma }, { shardId: SHARD, nowMs: NOW + 1000, sweepEscalations: false });
    expect(after.results.find((row) => row.invariantId === "I22").status).toBe(invariantChecker.STATUS.ENFORCED);
  });
});

describe("PHASE 12 REMEDIATION — the tick's side channels are delivered, not returned and dropped", () => {
  test("the socket sink receives every message the tick produced", async () => {
    // `server.js` started this worker and never called `socketMessages()`, so
    // `INVARIANT_STATUS_CHANGED` and `STRANDING_ESCALATED` had a producer and no wire. The
    // worker still takes no Socket.IO dependency: `deps.emit` is a function.
    const prisma = store();
    prisma.__store.leg[0].state = "STRANDED_OBSTRUCTING";
    prisma.__store.leg[0].obstructionClass = "BLOCKING_CRITICAL";

    const emitted = [];
    const tick = await invariantWorker.runOnce(
      { prisma, emit: async (message) => emitted.push(message), readHazardData: async () => null },
      { shardId: SHARD, nowMs: NOW, maxAgeSeconds: 300 },
    );

    expect(emitted).toHaveLength(invariantWorker.socketMessages(tick).length);
    expect(emitted.some((message) => message.event === "INVARIANT_STATUS_CHANGED")).toBe(true);
    expect(emitted.some((message) => message.event === "STRANDING_ESCALATED")).toBe(true);
  });

  test("the advisory mirror is published when a cache is supplied, and its absence is reported", async () => {
    // `engine:mode:{shard}` — the one Redis key §18.5's plan row reserves — was never written
    // in production, because the worker was started without a `kv`. `publishAdvisory` returns
    // rather than throwing on a cache failure, which is correct and is also why the omission
    // was silent.
    const prisma = store();
    await transitions.enter({ prisma }, {
      mode: modeRegister.MODE.COLD_INDEX, shardId: SHARD, cause: "B3",
      enteringComponent: "test", atMs: NOW, maxDurationMs: 900000,
    });

    const written = new Map();
    const withCache = await invariantWorker.modeSweepPass(
      { prisma, kv: { set: async (key, value) => written.set(key, value) } },
      { shardId: SHARD, nowMs: NOW },
    );
    expect(withCache.advisoryPublished).toBe(true);
    expect(JSON.parse(written.get(`engine:mode:${SHARD}`))).toMatchObject({
      modes: ["COLD_INDEX"], degraded: true, authority: "DegradedModeEvent — this mirror is advisory (§3.3)",
    });

    const withoutCache = await invariantWorker.modeSweepPass({ prisma }, { shardId: SHARD, nowMs: NOW });
    expect(withoutCache.advisoryPublished).toBe(false);
  });
});

describe("I6's persisted high-water marks", () => {
  test("are the checker's own rows, not the commit path's audit table", async () => {
    const prisma = store();
    await invariantWorker.checkPass({ prisma }, context());

    const marks = prisma.__store.invariantStatus.filter((row) => row.subjectType === "AGENT");
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({ invariantId: "I6", subjectId: "AGT-001", highWaterMark: 7n, secondaryHighWaterMark: 2n });
    expect(marks[0].instrument).toMatch(/the checker's own mark, not the commit path's/);
  });

  test("advance with the counters and never retreat", async () => {
    const prisma = store();
    await invariantWorker.checkPass({ prisma }, context());

    prisma.__store.agent[0].fenceCounter = 11n;
    await invariantWorker.checkPass({ prisma }, context({ nowMs: NOW + 60000 }));
    expect(prisma.__store.invariantStatus.find((row) => row.subjectType === "AGENT").highWaterMark).toBe(11n);

    // A regression: the mark holds at 11 and I6 turns VIOLATED. Writing the observation
    // would advance past the regression and make the next pass report monotonicity.
    prisma.__store.agent[0].fenceCounter = 4n;
    const pass = await invariantWorker.checkPass({ prisma }, context({ nowMs: NOW + 120000 }));
    expect(pass.summary.violatedInvariants).toContain("I6");
    expect(prisma.__store.invariantStatus.find((row) => row.subjectType === "AGENT").highWaterMark).toBe(11n);
  });

  test("REGRESSION — a mark that did not move is not rewritten", async () => {
    // Measured against a live PostgreSQL cluster: this write was 567 ms of a 706 ms pass at 500
    // agents — 80 % of the checker's whole cost — because it upserted every agent's mark on every
    // pass whether or not the counters had changed. On a 60 s interval that is an upsert per agent
    // per minute for ever. The audit is the comparison, and the comparison has already happened.
    const prisma = store();
    const state = {};
    const first = await invariantWorker.checkPass({ prisma }, context({ checkerState: state }));
    expect(first.highWaterMarksWritten).toBe(1);

    // Nothing advanced: no write.
    const second = await invariantWorker.checkPass({ prisma }, context({ nowMs: NOW + 60000, checkerState: state }));
    expect(second.highWaterMarksWritten).toBe(0);

    // The counter advances: the mark is written, and I6 still holds.
    prisma.__store.agent[0].fenceCounter = 12n;
    const third = await invariantWorker.checkPass({ prisma }, context({ nowMs: NOW + 120000, checkerState: state }));
    expect(third.highWaterMarksWritten).toBe(1);
    expect(prisma.__store.invariantStatus.find((row) => row.subjectType === "AGENT").highWaterMark).toBe(12n);

    // And a regression is still caught — skipping unchanged marks must not skip the comparison.
    prisma.__store.agent[0].fenceCounter = 3n;
    const fourth = await invariantWorker.checkPass({ prisma }, context({ nowMs: NOW + 180000, checkerState: state }));
    expect(fourth.summary.violatedInvariants).toContain("I6");
    expect(prisma.__store.invariantStatus.find((row) => row.subjectType === "AGENT").highWaterMark).toBe(12n);
  });

  test("are loaded before the pass, so a fresh process picks up where the last left off", async () => {
    const prisma = store();
    await invariantWorker.checkPass({ prisma }, context());
    const loaded = await invariantWorker.loadHighWaterMarks({ prisma }, SHARD);
    expect(loaded.get("AGT-001")).toEqual({ fence: "7", epoch: "2" });
  });
});

describe("§18.6 step 5 — the escalation sweep", () => {
  test("re-evaluates every open chain and writes the outcome as a new step row", async () => {
    const prisma = store();
    prisma.__store.leg[0].state = "STRANDED_OBSTRUCTING";
    prisma.__store.leg[0].obstructionClass = "BLOCKING_CRITICAL";
    prisma.__store.externalEscalation.push({
      id: "ee-1",
      legId: "leg-1",
      step: 1,
      obstructionClass: "BLOCKING_CRITICAL",
      disposition: "EMITTED",
      clearedAt: null,
      occurredAt: new Date(NOW - 60000),
    });

    const sweep = await invariantWorker.escalationSweepPass(
      { prisma, readHazardData: async () => ({ obstructionClass: "BLOCKING_CRITICAL", observedAtMs: NOW - 1000 }) },
      { nowMs: NOW, maxAgeSeconds: 300 },
    );

    expect(sweep.open).toBe(1);
    expect(sweep.chains).toBe(1);
    expect(sweep.reEvaluated[0].chainContinues).toBe(true);

    // ── PHASE 12 REMEDIATION ────────────────────────────────────────────────────
    // This assertion used to require a row per pass, which is what the sweep did — and
    // that is the defect, not the contract. §18.6 step 5 re-evaluates "as position or map
    // data changes"; a row recording that nothing changed is a row per open row per tick,
    // and because each such row was itself left open it was re-evaluated next tick too.
    // Three chain rows became six, then twelve, for one stranded agent (see the
    // exponential-growth test below). An unchanged re-evaluation is now reported in the
    // pass result and written nowhere.
    expect(sweep.reEvaluated[0].reclassification.changed).toBe(false);
    expect(sweep.written).toBe(0);
    expect(prisma.__store.externalEscalation.filter((row) => row.step === externalEscalation.STEP.RE_EVALUATE)).toHaveLength(0);
  });

  test("writes a row when the classification actually changes", async () => {
    const prisma = store();
    prisma.__store.leg[0].state = "STRANDED_OBSTRUCTING";
    prisma.__store.leg[0].obstructionClass = "BLOCKING_CRITICAL";
    prisma.__store.externalEscalation.push({
      id: "ee-1", legId: "leg-1", step: 1, obstructionClass: "BLOCKING_CRITICAL",
      disposition: "EMITTED", clearedAt: null, occurredAt: new Date(NOW - 60000),
    });

    // RESTRICTIVE is a different class that still obstructs nothing critical — a change
    // worth a row, and one that keeps the chain open.
    const sweep = await invariantWorker.escalationSweepPass(
      { prisma, readHazardData: async () => ({ obstructionClass: "RESTRICTIVE", observedAtMs: NOW - 1000 }) },
      { nowMs: NOW, maxAgeSeconds: 300 },
    );

    expect(sweep.reEvaluated[0].reclassification.changed).toBe(true);
    expect(sweep.written).toBe(1);
    const written = prisma.__store.externalEscalation.filter((row) => row.step === externalEscalation.STEP.RE_EVALUATE);
    expect(written).toHaveLength(1);
    expect(written[0].obstructionClass).toBe("RESTRICTIVE");
  });

  test("REGRESSION — the sweep's cost is the number of stranded agents, not the number of ticks", async () => {
    // The defect this replaces: `escalationSweepPass` iterated every open *row*, so one
    // stranding with three open chain steps was re-evaluated three times per tick, and each
    // re-evaluation wrote a row that was itself left open. Measured before the fix: 3 rows
    // became 6, 12, 24, 48, 96, 192 over six ticks — for one agent, at one row per doubling,
    // for as long as the agent stayed stranded.
    const prisma = store();
    prisma.__store.leg[0].state = "STRANDED_OBSTRUCTING";
    prisma.__store.leg[0].obstructionClass = "BLOCKING_CRITICAL";
    for (const step of [1, 2, 3]) {
      prisma.__store.externalEscalation.push({
        id: `ee-${step}`, legId: "leg-1", step, obstructionClass: "BLOCKING_CRITICAL",
        disposition: "EMITTED", clearedAt: null, occurredAt: new Date(NOW - 60000),
      });
    }

    // Fresh map data on every tick — the Map service is reachable and the obstruction has not
    // moved, which is what an unresolved stranding looks like.
    let at = NOW;
    const deps = {
      prisma,
      readHazardData: async () => ({ obstructionClass: "BLOCKING_CRITICAL", observedAtMs: at - 1000 }),
    };
    for (let tick = 1; tick <= 8; tick += 1) {
      at = NOW + tick * 60000;
      // eslint-disable-next-line no-await-in-loop
      const sweep = await invariantWorker.escalationSweepPass(deps, { nowMs: at, maxAgeSeconds: 300 });
      // One chain, re-evaluated once, however many steps it has accumulated.
      expect(sweep.chains).toBe(1);
      expect(sweep.reEvaluated).toHaveLength(1);
      expect(sweep.written).toBe(0);
    }

    // Eight ticks of an unresolved stranding add nothing: the three opening steps and no more.
    expect(prisma.__store.externalEscalation).toHaveLength(3);
  });

  test("REGRESSION — one reclassification writes one row, however many passes observe it", async () => {
    // The second half of the same defect, and the reason "changed" is measured against the
    // chain's own last recorded class rather than against `Leg.obstructionClass`: the sweep
    // records a reclassification on the chain and deliberately does not write the Leg's class,
    // so measuring against the Leg made one event "changed" on every subsequent pass — a row
    // per tick for one transition.
    const prisma = store();
    prisma.__store.leg[0].state = "STRANDED_OBSTRUCTING";
    prisma.__store.leg[0].obstructionClass = "BLOCKING_CRITICAL";
    prisma.__store.externalEscalation.push({
      id: "ee-1", legId: "leg-1", step: 1, obstructionClass: "BLOCKING_CRITICAL",
      disposition: "EMITTED", clearedAt: null, occurredAt: new Date(NOW - 60000),
    });

    // Map data that never refreshes: the class goes INDETERMINATE the moment it passes its
    // budget (§4.3) and stays there. That is one reclassification, not one per pass.
    const deps = {
      prisma,
      readHazardData: async () => ({ obstructionClass: "BLOCKING_CRITICAL", observedAtMs: NOW - 1000 }),
    };
    for (let tick = 1; tick <= 8; tick += 1) {
      // eslint-disable-next-line no-await-in-loop
      await invariantWorker.escalationSweepPass(deps, { nowMs: NOW + tick * 60000, maxAgeSeconds: 300 });
    }

    const reEvaluations = prisma.__store.externalEscalation.filter((row) => row.step === externalEscalation.STEP.RE_EVALUATE);
    expect(reEvaluations).toHaveLength(1);
    expect(reEvaluations[0].obstructionClass).toBe("INDETERMINATE");
    // INDETERMINATE still resolves to STRANDED_OBSTRUCTING (§4.3), so the chain stays open.
    expect(reEvaluations[0].clearedAt === null || reEvaluations[0].clearedAt === undefined).toBe(true);
  });

  test("closes the chain when the agent is moved clear", async () => {
    const prisma = store();
    prisma.__store.leg[0].state = "STRANDED_OBSTRUCTING";
    prisma.__store.leg[0].obstructionClass = "BLOCKING_CRITICAL";
    prisma.__store.externalEscalation.push({
      id: "ee-1",
      legId: "leg-1",
      step: 1,
      obstructionClass: "BLOCKING_CRITICAL",
      disposition: "EMITTED",
      clearedAt: null,
      occurredAt: new Date(NOW - 60000),
    });

    const sweep = await invariantWorker.escalationSweepPass(
      { prisma, readHazardData: async () => ({ obstructionClass: "CLEAR", observedAtMs: NOW - 1000 }) },
      { nowMs: NOW, maxAgeSeconds: 300 },
    );

    expect(sweep.reEvaluated[0].disposition).toBe(externalEscalation.DISPOSITION.DE_ESCALATED);
    const closing = prisma.__store.externalEscalation.find((row) => row.step === externalEscalation.STEP.RE_EVALUATE);
    expect(closing.clearedAt).toEqual(new Date(NOW));

    // ── PHASE 12 REMEDIATION ────────────────────────────────────────────────────
    // "Closes the chain" has to mean the chain. Marking only the row that observed the
    // clearance left every earlier step with `clearedAt = NULL`, so the next pass found the
    // same stranding open and re-evaluated an incident that was already resolved — for ever.
    expect(sweep.cleared).toBeGreaterThanOrEqual(1);
    expect(prisma.__store.externalEscalation.filter((row) => row.clearedAt === null || row.clearedAt === undefined)).toHaveLength(0);

    // And a second sweep therefore finds nothing.
    const again = await invariantWorker.escalationSweepPass(
      { prisma, readHazardData: async () => ({ obstructionClass: "CLEAR", observedAtMs: NOW - 1000 }) },
      { nowMs: NOW + 60000, maxAgeSeconds: 300 },
    );
    expect(again.open).toBe(0);
    expect(again.reEvaluated).toHaveLength(0);
  });

  test("a chain with no hazard reader does not de-escalate on the absence of data", async () => {
    const prisma = store();
    prisma.__store.leg[0].state = "STRANDED_OBSTRUCTING";
    prisma.__store.leg[0].obstructionClass = "BLOCKING_CRITICAL";
    prisma.__store.externalEscalation.push({
      id: "ee-1",
      legId: "leg-1",
      step: 1,
      obstructionClass: "BLOCKING_CRITICAL",
      disposition: "EMITTED",
      clearedAt: null,
      occurredAt: new Date(NOW - 60000),
    });

    const sweep = await invariantWorker.escalationSweepPass({ prisma }, { nowMs: NOW, maxAgeSeconds: 300 });
    expect(sweep.reEvaluated[0].chainContinues).toBe(true);
  });
});

describe("one full tick", () => {
  test("runs the three passes and returns the socket messages a caller with an `io` would emit", async () => {
    const prisma = store();
    prisma.__store.leg[0].state = "STRANDED_OBSTRUCTING";
    prisma.__store.leg[0].obstructionClass = "BLOCKING_CRITICAL";
    prisma.__store.externalEscalation.push({
      id: "ee-1",
      legId: "leg-1",
      step: 1,
      obstructionClass: "BLOCKING_CRITICAL",
      disposition: "EMITTED",
      clearedAt: null,
      occurredAt: new Date(NOW - 60000),
    });

    const tick = await invariantWorker.runOnce(
      { prisma, readHazardData: async () => ({ obstructionClass: "CLEAR", observedAtMs: NOW - 1000 }), now: () => NOW },
      context({ sweepEscalations: true, maxAgeSeconds: 300 }),
    );

    expect(tick.check.summary.total).toBe(22);
    expect(tick.modes.activeModes).toEqual([]);
    expect(tick.escalations.open).toBe(1);

    const messages = invariantWorker.socketMessages(tick);
    expect(messages.some((message) => message.event === "INVARIANT_STATUS_CHANGED")).toBe(true);
    expect(messages.some((message) => message.event === "STRANDING_ESCALATED" && message.payload.cleared === true)).toBe(true);
  });

  test("takes no Socket.IO dependency — the messages are returned, never emitted", () => {
    // The disposition every engine worker since Phase 4 has carried: the composition root
    // Phase 15 wires is where an `io` and an engine component meet.
    const fs = require("fs");
    const path = require("path");
    const source = fs.readFileSync(path.join(__dirname, "..", "..", "src", "workers", "invariant.worker.js"), "utf8");
    expect(source).not.toMatch(/socket\.io|io\.to\(|require\("socket/);
  });
});
