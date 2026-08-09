"use strict";

/**
 * Engine lane — Phase 11: the offline counterfactual evaluator and its release gate
 * (§21.6).
 *
 * > **The evaluator is a release gate, not only a periodic report, whenever column
 * > generation changes.** The solve makes *selection* among generated columns exact while
 * > leaving *generation* heuristic … **an exact solve over a poor column set produces an
 * > exact but poor result, and no in-round signal reveals it**.
 *
 * So the gate must fail closed on an unmeasured change, and must treat a budget change as
 * a heuristic change. Both are tested.
 */

const evaluator = require("../../tools/evaluator/counterfactual");
const worker = require("../../src/workers/counterfactual.worker");
const fixture = require("./helpers/roundFixture");

const MILLI = (cu) => BigInt(cu) * 1000n;

const rounds = [
  { roundId: "r1", objectiveMilliCU: MILLI(1000) },
  { roundId: "r2", objectiveMilliCU: MILLI(2000) },
  { roundId: "r3", objectiveMilliCU: MILLI(3000) },
];

/** A resolver that shaves a fixed amount off each round under each relaxation. */
const resolverShaving = (byRelaxation) => async ({ roundId, relaxation }) => {
  const stored = rounds.find((row) => row.roundId === roundId);
  return { objectiveMilliCU: stored.objectiveMilliCU - MILLI(byRelaxation[relaxation] ?? 0) };
};

describe("§21.6 — the four relaxations, reported separately", () => {
  test("all four §21.6 relaxations are named", () => {
    expect([...evaluator.RELAXATIONS].sort()).toEqual(["BATCH_WINDOW", "CANDIDATE_SET", "COLUMN_GENERATION", "SHARD_BOUNDARY"]);
  });

  test("each relaxation's gap is reported on its own, and never summed", async () => {
    const report = await evaluator.run(
      { resolve: resolverShaving({ CANDIDATE_SET: 10, SHARD_BOUNDARY: 20, BATCH_WINDOW: 5, COLUMN_GENERATION: 40 }) },
      { rounds },
    );

    expect(report.byRelaxation.CANDIDATE_SET.meanGapMilliCU).toBe("10000");
    expect(report.byRelaxation.SHARD_BOUNDARY.meanGapMilliCU).toBe("20000");
    expect(report.byRelaxation.BATCH_WINDOW.meanGapMilliCU).toBe("5000");
    expect(report.byRelaxation.COLUMN_GENERATION.meanGapMilliCU).toBe("40000");
    // "The four relaxations bound different approximations and are reported separately.
    // Summing them would produce a figure that bounds none of them."
    expect(report.neverSummed).toMatch(/reported separately/);
    expect(report).not.toHaveProperty("totalGapMilliCU");
  });

  test("§21.4's two allocation-quality metrics come from their own relaxations", async () => {
    const report = await evaluator.run({ resolve: resolverShaving({ CANDIDATE_SET: 10, COLUMN_GENERATION: 40 }) }, { rounds });
    // Counterfactual regret is the cost of candidate truncation, measured rather than
    // bounded; the column-generation gap is the one the in-round machinery cannot bound.
    expect(report.counterfactualRegretMilliCU).toBe("10000");
    expect(report.columnGenerationGapMilliCU).toBe("40000");
  });

  test("a relaxed solve that costs MORE is an invalid comparison, not a negative gap", async () => {
    const report = await evaluator.run(
      { resolve: async ({ roundId }) => ({ objectiveMilliCU: rounds.find((row) => row.roundId === roundId).objectiveMilliCU + MILLI(5) }) },
      { rounds, relaxations: [evaluator.RELAXATION.CANDIDATE_SET] },
    );
    const entry = report.byRelaxation.CANDIDATE_SET;
    expect(entry.validComparisons).toBe(0);
    expect(entry.results[0].valid).toBe(false);
    expect(entry.results[0].invalidBecause).toMatch(/did not enlarge the search space/);
  });
});

describe("§21.6 — the release gate on column-generation changes", () => {
  const reportWithGap = (gapCU) => ({ columnGenerationGapMilliCU: String(gapCU * 1000) });

  test("passes when the gap has not widened", () => {
    const verdict = evaluator.gate({ baseline: reportWithGap(40), candidate: reportWithGap(38), maxRegressionCU: 0 });
    expect(verdict.ok).toBe(true);
    expect(verdict.regressionMilliCU).toBe("-2000");
  });

  test("fails when the gap has widened beyond solve.max_generation_gap_regression", () => {
    const verdict = evaluator.gate({ baseline: reportWithGap(40), candidate: reportWithGap(45), maxRegressionCU: 2 });
    expect(verdict.ok).toBe(false);
    expect(verdict.parameter).toBe("solve.max_generation_gap_regression");
    expect(verdict.detail).toMatch(/no in-round bound would have revealed this/);
  });

  test("passes a widening inside the allowance", () => {
    expect(evaluator.gate({ baseline: reportWithGap(40), candidate: reportWithGap(41), maxRegressionCU: 2 }).ok).toBe(true);
  });

  test("FAILS CLOSED when the gap was not measured — an unmeasured change is an ungated one", () => {
    const verdict = evaluator.gate({ baseline: reportWithGap(40), candidate: {}, maxRegressionCU: 5 });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("NO_MEASUREMENT");
    expect(verdict.detail).toMatch(/fails closed rather than waving it through/);
  });

  test("the registered allowance is the one the gate reads", () => {
    const { defaultSnapshot } = require("../../src/engine/config/service");
    expect(defaultSnapshot().resolve("solve.max_generation_gap_regression")).toBe(0);
  });

  test("a BUDGET change requires the gate — §21.6 says a budget change is a heuristic change", () => {
    expect(evaluator.GATED_CHANGES).toContain("plan.max_columns_per_round");
    expect(evaluator.GATED_CHANGES).toContain("plan.max_bundle_size");
    expect(evaluator.gateRequiredFor(["plan.max_columns_per_round"]).required).toBe(true);
    expect(evaluator.gateRequiredFor(["the enumeration order"]).required).toBe(true);
    expect(evaluator.gateRequiredFor(["a learned column proposer admitted under §25.5"]).required).toBe(true);
    // Prose, as a release engineer would actually write it.
    expect(evaluator.gateRequiredFor(["we lowered plan.max_columns_per_round from 4000 to 2000"]).required).toBe(true);
    expect(evaluator.gateRequiredFor(["reworked the bundle size policy"]).required).toBe(true);
  });

  test("an unrelated change does not require the gate", () => {
    expect(evaluator.gateRequiredFor(["a logging change"]).required).toBe(false);
    expect(evaluator.gateRequiredFor(["renamed a controller"]).required).toBe(false);
  });
});

describe("workers/counterfactual.worker — the periodic report", () => {
  test("loads recent rounds with their recorded objectives as bigints", async () => {
    const prisma = fixture.memoryPrisma();
    prisma.__tables.rounds.push(
      { roundId: "r1", shardId: "s1", decisionTime: new Date(2000), regime: "SINGLETON", budgets: { incumbent: { objectiveMilliCU: "1000" } } },
      { roundId: "r2", shardId: "s1", decisionTime: new Date(1000), regime: "SINGLETON", budgets: { incumbent: { objectiveMilliCU: "2000" } } },
    );

    const loaded = await worker.loadRounds({ prisma }, { shardId: "s1", size: 5 });
    expect(loaded.map((row) => row.roundId)).toEqual(["r1", "r2"]);
    // Revived as bigints, because every comparison downstream is exact.
    expect(loaded[0].objectiveMilliCU).toBe(1000n);
  });

  test("publishes the two gaps as separate gauges, never one", async () => {
    const prisma = fixture.memoryPrisma();
    prisma.__tables.rounds.push({ roundId: "r1", shardId: "s1", decisionTime: new Date(1), budgets: { incumbent: { objectiveMilliCU: "100000" } } });

    const registry = require("../../src/engine/observability/sli").createRegistry();
    await worker.runOnce(
      { prisma, registry, resolve: async ({ relaxation }) => ({ objectiveMilliCU: 100000n - (relaxation === "COLUMN_GENERATION" ? 4000n : 1000n) }) },
      { shardId: "s1" },
    );

    const gauges = registry.snapshot().gauges;
    expect(gauges['sli.counterfactual_regret|{"shardId":"s1"}']).toBe(1000);
    expect(gauges['sli.column_generation_gap|{"shardId":"s1"}']).toBe(4000);
  });

  test("the worker's gate reads the allowance from the config service", () => {
    const verdict = worker.gateAgainst({
      baseline: { columnGenerationGapMilliCU: "40000" },
      candidate: { columnGenerationGapMilliCU: "60000" },
      config: { get: (name) => (name === "solve.max_generation_gap_regression" ? 5 : null) },
      changes: ["the clustering rule"],
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.allowanceMilliCU).toBe("5000");
    expect(verdict.changes).toEqual(["the clustering rule"]);
  });

  // PHASE 15 — the evaluator moves to production scheduling. §21.6 makes it a "permanent
  // capability, not temporary tooling", and it is the sole instrument that can measure the
  // column-generation gap, so a build in which it is never scheduled is a build with no
  // reading of the one approximation the in-round machinery cannot bound for itself.
  test("the worker is scheduled from server.js", () => {
    const fs = require("fs");
    const path = require("path");
    const server = fs.readFileSync(path.join(__dirname, "..", "..", "server.js"), "utf8");
    expect(server.includes("counterfactual.worker")).toBe(true);

    const registry = require("../../src/workers/registry");
    expect(registry.WORKER_BY_ID.counterfactual.readiness).toBe(registry.READINESS.SCHEDULED);
  });
});
