"use strict";

/**
 * §9.3 — the singleton-regime min-cost flow: exact, integral, zero LP–IP gap, exact duals.
 */

const objective = require("../../src/engine/solve/objective");
const minCostFlow = require("../../src/engine/solve/minCostFlow");
const regime = require("../../src/engine/solve/regime");
const budgets = require("../../src/engine/solve/budgets");
const fixture = require("./helpers/roundFixture");
const { toMilliCU } = require("../../src/engine/determinism/fixedPoint");

function instanceOf(columns, legIds, options) {
  const built = objective.buildInstance({
    legs: fixture.legs(legIds, options),
    columns,
    deferralEnabled: (options && options.deferralAdmissible) === true,
  });
  expect(built.ok).toBe(true);
  return built.instance;
}

describe("§9.3 — the singleton regime is solved exactly by min-cost flow", () => {
  test("one Leg, three agents: the cheapest wins", () => {
    const columns = [
      fixture.column({ legId: "L1", agentId: "A2", gammaCu: 20 }),
      fixture.column({ legId: "L1", agentId: "A1", gammaCu: 30 }),
      fixture.column({ legId: "L1", agentId: "A3", gammaCu: 10 }),
    ];
    const solved = minCostFlow.solve(instanceOf(columns, ["L1"]));

    expect(solved.ok).toBe(true);
    expect(solved.assignments).toEqual([expect.objectContaining({ legId: "L1", agentId: "A3" })]);
    expect(solved.objectiveMilliCU).toBe(toMilliCU(10));
  });

  test("the round is exact where greedy is not — two Legs, two agents, cannibalisation resolved", () => {
    // Greedy at arrival order assigns L1 → A1 (cost 10), leaving L2 → A2 at 100:
    // total 110. The exact allocation is L1 → A2 (30) and L2 → A1 (20): total 50.
    // §9.1: "Batch solving eliminates cannibalisation exactly (within the batch)."
    const columns = [
      fixture.column({ legId: "L1", agentId: "A1", gammaCu: 10 }),
      fixture.column({ legId: "L1", agentId: "A2", gammaCu: 30 }),
      fixture.column({ legId: "L2", agentId: "A1", gammaCu: 20 }),
      fixture.column({ legId: "L2", agentId: "A2", gammaCu: 100 }),
    ];
    const solved = minCostFlow.solve(instanceOf(columns, ["L1", "L2"]));

    expect(solved.ok).toBe(true);
    expect(solved.objectiveMilliCU).toBe(toMilliCU(50));
    expect(solved.assignments).toEqual([
      expect.objectContaining({ legId: "L1", agentId: "A2" }),
      expect.objectContaining({ legId: "L2", agentId: "A1" }),
    ]);
  });

  test("reports ZERO LP–IP gap, and the bound equals the objective", () => {
    const columns = [
      fixture.column({ legId: "L1", agentId: "A1", gammaCu: 10 }),
      fixture.column({ legId: "L2", agentId: "A2", gammaCu: 20 }),
    ];
    const solved = minCostFlow.solve(instanceOf(columns, ["L1", "L2"]));

    expect(solved.lpIpGapMilliCU).toBe(0n);
    expect(solved.boundMilliCU).toBe(solved.objectiveMilliCU);
    expect(solved.branched).toBe(false);
    expect(solved.regime).toBe(regime.REGIME.SINGLETON);
  });

  test("the duals are labelled EXACT_INTEGER and valid for §8.3 calibration without qualification", () => {
    const columns = [fixture.column({ legId: "L1", agentId: "A1", gammaCu: 10 })];
    const solved = minCostFlow.solve(instanceOf(columns, ["L1"]));

    expect(solved.duals.kind).toBe(regime.DUAL_KIND.EXACT_INTEGER);
    expect(solved.duals.validForCalibrationWithoutQualification).toBe(true);
    expect(solved.agentDuals.kind).toBe(regime.DUAL_KIND.EXACT_INTEGER);
  });

  test("exclusivity holds: one agent never takes two Legs", () => {
    const columns = [
      fixture.column({ legId: "L1", agentId: "A1", gammaCu: 1 }),
      fixture.column({ legId: "L2", agentId: "A1", gammaCu: 1 }),
      fixture.column({ legId: "L2", agentId: "A2", gammaCu: 500 }),
    ];
    const instance = instanceOf(columns, ["L1", "L2"]);
    const solved = minCostFlow.solve(instance);

    const agents = solved.assignments.map((row) => row.agentId);
    expect(new Set(agents).size).toBe(agents.length);

    const validity = objective.validate(instance, {
      columnIndices: solved.assignments.map((row) => row.columnIndex),
      deferredLegIds: solved.deferred.map((row) => row.legId),
    });
    expect(validity.violations).toEqual([]);
  });

  test("negative γ — which C_opportunity produces — is handled exactly, not clamped", () => {
    // The initial DAG relaxation is what makes this exact; a Dijkstra without Johnson
    // potentials would silently mis-solve it.
    const columns = [
      fixture.column({ legId: "L1", agentId: "A1", gammaMilliCU: toMilliCU(-40) }),
      fixture.column({ legId: "L1", agentId: "A2", gammaMilliCU: toMilliCU(-90) }),
      fixture.column({ legId: "L2", agentId: "A2", gammaMilliCU: toMilliCU(-100) }),
      fixture.column({ legId: "L2", agentId: "A1", gammaMilliCU: toMilliCU(-5) }),
    ];
    const solved = minCostFlow.solve(instanceOf(columns, ["L1", "L2"]));

    // L1→A1 (−40) + L2→A2 (−100) = −140 beats L1→A2 (−90) + L2→A1 (−5) = −95.
    expect(solved.objectiveMilliCU).toBe(toMilliCU(-140));
  });
});

describe("§22.5 rule 1 — 'assign when any feasible candidate exists', without a big-M", () => {
  test("a Leg with no column is left unassigned rather than making the round infeasible", () => {
    const columns = [fixture.column({ legId: "L1", agentId: "A1", gammaCu: 10 })];
    const solved = minCostFlow.solve(instanceOf(columns, ["L1", "L2"]));

    expect(solved.ok).toBe(true);
    expect(solved.assignments).toEqual([expect.objectContaining({ legId: "L1" })]);
    expect(solved.unassigned).toEqual([{ legId: "L2" }]);
  });

  test("an expensive assignment still beats leaving the Leg unassigned, at any price", () => {
    // The lexicographic first component is the point: no configuration of real costs can
    // outbid the priority, which is what a big-M constant could not promise.
    const columns = [fixture.column({ legId: "L1", agentId: "A1", gammaCu: 9_000_000 })];
    const solved = minCostFlow.solve(instanceOf(columns, ["L1"]));

    expect(solved.assignments).toHaveLength(1);
    expect(solved.unassigned).toEqual([]);
  });

  test("with deferral enabled the arc is priced, and a cheap deferral is chosen over an expensive assignment", () => {
    const columns = [fixture.column({ legId: "L1", agentId: "A1", gammaCu: 500 })];
    const solved = minCostFlow.solve(
      instanceOf(columns, ["L1"], { deferralAdmissible: true, deferCu: 100 }),
    );

    expect(solved.deferred).toEqual([{ legId: "L1" }]);
    expect(solved.assignments).toEqual([]);
    expect(solved.objectiveMilliCU).toBe(toMilliCU(100));
  });

  test("with deferral enabled a cheap assignment still beats the deferral price", () => {
    const columns = [fixture.column({ legId: "L1", agentId: "A1", gammaCu: 10 })];
    const solved = minCostFlow.solve(
      instanceOf(columns, ["L1"], { deferralAdmissible: true, deferCu: 100 }),
    );

    expect(solved.assignments).toHaveLength(1);
    expect(solved.deferred).toEqual([]);
  });
});

describe("§9.6 — determinism", () => {
  test("identical inputs produce a byte-identical allocation across runs", () => {
    const build = () => [
      fixture.column({ legId: "L2", agentId: "A3", gammaCu: 40 }),
      fixture.column({ legId: "L1", agentId: "A1", gammaCu: 40 }),
      fixture.column({ legId: "L1", agentId: "A3", gammaCu: 40 }),
      fixture.column({ legId: "L2", agentId: "A1", gammaCu: 40 }),
    ];

    const first = minCostFlow.solve(instanceOf(build(), ["L1", "L2"]));
    const second = minCostFlow.solve(instanceOf(build(), ["L1", "L2"]));

    expect(JSON.stringify(first.assignments)).toBe(JSON.stringify(second.assignments));
    expect(first.objectiveMilliCU).toBe(second.objectiveMilliCU);
  });

  test("an all-equal-cost instance resolves its ties by the canonical order, not by insertion order", () => {
    const forward = [
      fixture.column({ legId: "L1", agentId: "A1", gammaCu: 7 }),
      fixture.column({ legId: "L1", agentId: "A2", gammaCu: 7 }),
    ];
    const reversed = [...forward].reverse();

    const a = minCostFlow.solve(instanceOf(forward, ["L1"]));
    const b = minCostFlow.solve(instanceOf(reversed, ["L1"]));

    expect(a.assignments[0].agentId).toBe(b.assignments[0].agentId);
  });
});

describe("§9.4 — the anytime property", () => {
  test("an exhausted wall-clock budget returns the incumbent, never nothing and never a throw", () => {
    const tracker = budgets.create({
      config: fixture.budgetConfig({ timeBudgetMs: 0 }),
      elapsedMs: () => 1,
    });
    const columns = [
      fixture.column({ legId: "L1", agentId: "A1", gammaCu: 10 }),
      fixture.column({ legId: "L2", agentId: "A2", gammaCu: 20 }),
    ];

    const solved = minCostFlow.solve(instanceOf(columns, ["L1", "L2"]), { budgets: tracker });

    expect(solved.ok).toBe(true);
    expect(solved.budgetLimited).toBe(true);
    expect(Array.isArray(solved.assignments)).toBe(true);
    expect(budgets.assertAnytime(tracker.result()).ok).toBe(true);
  });

  test("stopping is between augmentations, so the reported flow is always integral", () => {
    const tracker = budgets.create({
      config: fixture.budgetConfig({ timeBudgetMs: 5 }),
      // Exhausts after the first augmentation.
      elapsedMs: (() => {
        let calls = 0;
        return () => {
          calls += 1;
          return calls > 1 ? 99 : 0;
        };
      })(),
    });
    const columns = [
      fixture.column({ legId: "L1", agentId: "A1", gammaCu: 10 }),
      fixture.column({ legId: "L2", agentId: "A2", gammaCu: 20 }),
    ];

    const solved = minCostFlow.solve(instanceOf(columns, ["L1", "L2"]), { budgets: tracker });

    expect(solved.assignments.length + solved.unassigned.length + solved.deferred.length).toBeLessThanOrEqual(2);
    for (const row of solved.assignments) expect(typeof row.agentId).toBe("string");
  });
});

describe("the multi-Leg column has no arc representation (§9.3)", () => {
  test("the flow refuses a column covering two Legs rather than approximating it", () => {
    const columns = [fixture.column({ legIds: ["L1", "L2"], agentId: "A1", gammaCu: 15 })];
    const built = objective.buildInstance({
      legs: fixture.legs(["L1", "L2"]),
      columns,
      deferralEnabled: false,
    });
    const solved = minCostFlow.solve(built.instance);

    expect(solved.ok).toBe(false);
    expect(solved.problems.join(" ")).toMatch(/set partitioning rather than as a flow/);
  });
});
