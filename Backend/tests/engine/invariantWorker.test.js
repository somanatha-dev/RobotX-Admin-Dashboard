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
    expect(sweep.reEvaluated[0].chainContinues).toBe(true);
    const written = prisma.__store.externalEscalation.filter((row) => row.step === externalEscalation.STEP.RE_EVALUATE);
    expect(written).toHaveLength(1);
    expect(written[0].clearedAt).toBeUndefined();
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
