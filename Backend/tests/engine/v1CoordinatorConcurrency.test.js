"use strict";

/**
 * Regression for the duplicate assignment measured on the V1 10-robot run (2026-09-23):
 * LEG-V1DEMO-TASK-6 was committed to V1DEMO-06, then offered to V1DEMO-02 two minutes later
 * while V1DEMO-06 was carrying it. Three links in that chain, each closed on its own:
 *
 *   1. `coordinator.worker.start` let rounds overlap (`setInterval` does not wait for an async
 *      tick), and overlapping rounds share one assembly's per-round state;
 *   2. a round that threw after committing a Leg returned that Leg to the queue;
 *   3. the solve path told G6 to expect whatever state it loaded, so a Leg in AT_PICKUP
 *      satisfied "the state the decision expected".
 */

const coordinator = require("../../src/workers/coordinator.worker");
const coordinatorSolvePath = require("../../src/workers/coordinatorSolvePath");
const guards = require("../../src/engine/commitment/guards");
const planState = require("../../src/engine/shard/planState");
const intake = require("../../src/engine/intake/intake");
const leadership = require("../../src/engine/shard/leadership");
const fixture = require("./helpers/roundFixture");

const NOW = new Date("2026-09-23T12:00:00.000Z");
const SHARD = leadership.DEFAULT_SHARD_ID;
const CONFIG = {
  windowMinMs: 500,
  windowMaxMs: 3000,
  saturatedWindowMs: 10000,
  batchGrowthThreshold: 10,
  fastPathClasses: [],
  maxLegsPerRound: 500,
  maxWindowSlaFraction: 0.05,
  maxEvaluatedPerLeg: 200,
  maxColumnsPerRound: 2000,
  branchNodeBudget: 5000,
  timeBudgetMs: 250,
  maxClockSkewMillis: 1000,
  storeRoundTripMillis: 100,
};

function leaderStore() {
  const prisma = fixture.memoryPrisma();
  prisma.$queryRawUnsafe = async (sql) => {
    if (sql.includes("NOW()")) return [{ now: NOW }];
    if (sql.includes("ShardLeadership")) {
      return [{ shardId: SHARD, leadershipFence: "7", holder: "i-1", leaseExpiry: new Date(NOW.getTime() + 60_000) }];
    }
    return [];
  };
  prisma.leg = { async findMany() { return []; }, async updateMany() { return { count: 0 }; } };
  return prisma;
}

async function enqueue(prisma, legId) {
  return prisma.workQueue.create({
    data: {
      legId,
      shardId: SHARD,
      idempotencyKey: `k-${legId}`,
      purpose: "PRIMARY",
      slaClass: "standard",
      priority: 0,
      state: intake.QUEUE_STATE.QUEUED,
      enqueuedAt: new Date(NOW.getTime() - 1000),
    },
  });
}

describe("1 — the coordinator never runs two rounds at once", () => {
  test("a round still in flight makes the next tick a no-op", async () => {
    let started = 0;
    let release;
    const blocked = new Promise((resolve) => {
      release = resolve;
    });
    const deps = {
      prisma: {
        $queryRawUnsafe: async () => {
          started += 1;
          await blocked; // the first round never gets past its clock read until released
          return [{ now: NOW }];
        },
      },
    };
    const handle = coordinator.start(deps, { shardId: SHARD, tickMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(started).toBe(1);
    handle.stop();
    release();
  });
});

describe("2 — a round that throws keeps a Leg it already committed out of the queue", () => {
  test("the committed Leg is SOLVED, the uncommitted one returns to QUEUED", async () => {
    const prisma = leaderStore();
    await enqueue(prisma, "L-committed");
    await enqueue(prisma, "L-open");
    // The round committed L-committed (its commitment is durable), then threw.
    prisma.commitment = { async count({ where }) { return where.legId === "L-committed" ? 1 : 0; } };

    const deps = {
      prisma,
      planState: planState.create({ shardId: SHARD }),
      expandCandidates: async () => {
        throw new Error("round state lost mid-commit");
      },
      pricedCandidateFor: () => null,
      commit: async () => ({ committed: true }),
    };
    await expect(
      coordinator.runRound(deps, { shardId: SHARD, config: CONFIG, feasibleSupply: 3, nowMs: NOW.getTime(), instanceId: "i-1" }),
    ).rejects.toThrow(/round state lost/);

    const byLeg = Object.fromEntries(prisma.__tables.workQueue.map((row) => [row.legId, row.state]));
    expect(byLeg).toEqual({ "L-committed": intake.QUEUE_STATE.SOLVED, "L-open": intake.QUEUE_STATE.QUEUED });
  });
});

describe("3 — G6 refuses a Leg that is not waiting for an agent", () => {
  test("the assignable states are exactly §4.3's pre-assignment states", () => {
    expect([...coordinatorSolvePath.ASSIGNABLE_LEG_STATES].sort()).toEqual(["DEFERRED", "PLANNED", "QUEUED", "REASSIGNING"]);
  });

  test.each(["OFFERED", "ACCEPTED", "EN_ROUTE_PICKUP", "AT_PICKUP", "LOADED", "EN_ROUTE_DROP", "AT_DROP", "SETTLED"])(
    "a Leg in %s fails G6 against the assignable set",
    (state) => {
      const verdict = guards.g6LegState({ state }, coordinatorSolvePath.ASSIGNABLE_LEG_STATES);
      expect(verdict.satisfied).toBe(false);
      expect(verdict.reason).toBe(guards.ABORT_REASON.G6_UNEXPECTED_LEG_STATE);
    },
  );

  test("a QUEUED Leg still passes", () => {
    expect(guards.g6LegState({ state: "QUEUED" }, "QUEUED").satisfied).toBe(true);
    // …and the loaded-state expectation the composer used to pass is what let AT_PICKUP through.
    expect(guards.g6LegState({ state: "AT_PICKUP" }, "AT_PICKUP").satisfied).toBe(true);
  });
});

describe("I8 — the run gate sees a duplicate that was later released", () => {
  const report = require("../../tools/demo/v1RunReport");
  test("two overlapping commitments on one Leg violate I8 even when both are released", () => {
    const result = report.checkInvariants({
      tasks: [{ taskId: "T6", status: "COMPLETED", robotId: "V1DEMO-06", legId: "L6" }],
      legs: [{ legId: "L6", state: "SETTLED" }],
      commitments: [
        { commitmentId: "a", agentId: "V1DEMO-06", legId: "L6", grantedAt: new Date("2026-09-23T11:06:05Z"), releasedAt: new Date("2026-09-23T11:09:14Z") },
        { commitmentId: "b", agentId: "V1DEMO-02", legId: "L6", grantedAt: new Date("2026-09-23T11:08:09Z"), releasedAt: new Date("2026-09-23T11:10:03Z") },
      ],
      queueRows: [],
      verifications: [{ legId: "L6", outcome: "SUFFICIENT" }],
      gateVerdicts: [
        { agentId: "V1DEMO-06", legId: "L6", feasible: true },
        { agentId: "V1DEMO-02", legId: "L6", feasible: true },
      ],
    });
    expect(result.violations.map((row) => row.id)).toContain("I8");
  });

  test("a re-offer after the first commitment was released is not a duplicate", () => {
    const result = report.checkInvariants({
      tasks: [],
      legs: [{ legId: "L1", state: "SETTLED" }],
      commitments: [
        { commitmentId: "a", agentId: "R1", legId: "L1", grantedAt: new Date(1_000), releasedAt: new Date(2_000) },
        { commitmentId: "b", agentId: "R2", legId: "L1", grantedAt: new Date(3_000), releasedAt: new Date(4_000) },
      ],
      gateVerdicts: [
        { agentId: "R1", legId: "L1", feasible: true },
        { agentId: "R2", legId: "L1", feasible: true },
      ],
    });
    expect(result.violations.filter((row) => row.id === "I8")).toEqual([]);
  });
});

describe("4 — a large batch cannot livelock the round on its own wall clock", () => {
  const round = require("../../src/engine/solve/round");
  const budgets = require("../../src/engine/solve/budgets");
  const { toMilliCU } = require("../../src/engine/determinism/fixedPoint");
  const columnBuilder = require("../../src/engine/plan/columnBuilder");

  async function planWith({ pairings, legs, elapsedAfterExpansions }) {
    const state = planState.create({ shardId: "s1" });
    state.beginRound("r1");
    for (const agentId of Object.values(pairings).flatMap((row) => Object.keys(row))) {
      state.declareAgent({ agentId, capacity: 1, hardCommitmentCount: 0 });
    }
    let expansions = 0;
    const config = fixture.budgetConfig({ timeBudgetMs: 1000 });
    const deps = {
      planState: state,
      budgets: budgets.create({ config, elapsedMs: () => elapsedAfterExpansions(expansions) }),
      async expandCandidates({ legId }) {
        expansions += 1;
        const entries = Object.entries(pairings[legId] || {});
        return { candidates: entries.map(([agentId, cu]) => ({ agentId, costMilliCU: toMilliCU(cu) })), achievedGapMilliCU: 0n, truncatedBy: null, cellsExplored: 1, agentsEvaluated: entries.length, problems: [] };
      },
      pricedCandidateFor: (agentId, legId, candidate) => ({ agentId, legId, plan: fixture.brandedPlan(), basePlan: null, insertionPositions: [], pricing: null, limits: null, __gammaMilliCU: candidate.costMilliCU }),
    };
    const original = columnBuilder.build;
    columnBuilder.build = (input) => {
      const columns = (input.candidates || []).map((c) => fixture.column({ legId: c.legId, agentId: c.agentId, gammaMilliCU: c.__gammaMilliCU, plan: c.plan }));
      return { ok: true, columns, pruned: [], generation: { regime: "SINGLETON", generated: columns.length, kept: columns.length, prunedCount: 0, budgetTruncated: false, bestPrunedGammaMilliCU: null, generationGapMilliCU: 0n, generationGapNote: "singleton" }, problems: [] };
    };
    try {
      return await round.plan(deps, { roundId: "r1", shardId: "s1", decisionTimeMs: 1_800_000_000_000, legs: legs.map((legId) => ({ legId, priority: 0 })), config, killSwitches: {} });
    } finally {
      columnBuilder.build = original;
    }
  }

  test("once a Leg is priced and half the budget is spent, the rest wait — and the priced Leg is assigned", async () => {
    const result = await planWith({
      pairings: { L1: { A1: 5 }, L2: { A2: 5 }, L3: { A3: 5 } },
      legs: ["L1", "L2", "L3"],
      elapsedAfterExpansions: (n) => (n >= 1 ? 600 : 0),
    });
    const byLeg = Object.fromEntries(result.decisions.map((row) => [row.legId, row.outcome]));
    expect(byLeg).toEqual({ L1: "ASSIGNED", L2: "BUDGET_TRUNCATED", L3: "BUDGET_TRUNCATED" });
    expect(result.assignments.map((row) => row.agentId)).toEqual(["A1"]);
  });

  test("with nothing priced yet the round keeps expanding, so every round makes progress", async () => {
    const result = await planWith({
      pairings: { L1: {}, L2: { A2: 5 }, L3: { A3: 5 } },
      legs: ["L1", "L2", "L3"],
      elapsedAfterExpansions: () => 600, // already past half before the first Leg
    });
    const byLeg = Object.fromEntries(result.decisions.map((row) => [row.legId, row.outcome]));
    expect(byLeg.L1).toBe("NO_FEASIBLE_CANDIDATE");
    expect(byLeg.L2).toBe("ASSIGNED");
    expect(byLeg.L3).toBe("BUDGET_TRUNCATED");
  });

  test("under the budget nothing changes: every Leg is expanded and assigned", async () => {
    const result = await planWith({
      pairings: { L1: { A1: 5 }, L2: { A2: 5 }, L3: { A3: 5 } },
      legs: ["L1", "L2", "L3"],
      elapsedAfterExpansions: () => 10,
    });
    expect(result.decisions.every((row) => row.outcome === "ASSIGNED")).toBe(true);
  });
});
