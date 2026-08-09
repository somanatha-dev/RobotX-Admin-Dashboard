"use strict";

/**
 * §1.4 / §9.3 — the set-partitioning objective, its two constraint families, and the
 * deferral variable that is present and switched off.
 */

const objective = require("../../src/engine/solve/objective");
const fixture = require("./helpers/roundFixture");
const costFixture = require("./helpers/costFixture");
const { toMilliCU } = require("../../src/engine/determinism/fixedPoint");
const { canonicalJson } = require("../../src/engine/determinism/ordering");

describe("T1 / I14 — the objective cannot contain a pairing the gate did not admit", () => {
  test("an unbranded plan is refused, not filtered", () => {
    const unbranded = costFixture.plan();
    expect(() =>
      objective.buildInstance({
        legs: fixture.legs(["L1"]),
        columns: [{ identity: "c1", agentId: "A1", legIds: ["L1"], gammaMilliCU: 0n, plan: unbranded }],
        deferralEnabled: false,
      }),
    ).toThrow(/T1 violation/);
  });

  test("the brand does not survive a JSON round trip, so a rehydrated column is refused", () => {
    const column = fixture.column({ legId: "L1", agentId: "A1", gammaCu: 1 });
    const rehydrated = { ...column, plan: JSON.parse(JSON.stringify(column.plan)) };
    expect(() =>
      objective.buildInstance({ legs: fixture.legs(["L1"]), columns: [rehydrated], deferralEnabled: false }),
    ).toThrow(/T1 violation/);
  });
});

describe("§1.4 — the coverage and exclusivity constraints", () => {
  test("coverage rows are per Leg and name the columns that cover them", () => {
    const columns = [
      fixture.column({ legId: "L1", agentId: "A1", gammaCu: 10 }),
      fixture.column({ legId: "L1", agentId: "A2", gammaCu: 20 }),
      fixture.column({ legId: "L2", agentId: "A1", gammaCu: 30 }),
    ];
    const { instance } = objective.buildInstance({ legs: fixture.legs(["L1", "L2"]), columns, deferralEnabled: false });

    expect(instance.coverage).toHaveLength(2);
    expect(instance.coverage[0].legId).toBe("L1");
    expect(instance.coverage[0].columnIndices).toHaveLength(2);
    expect(instance.coverage[1].columnIndices).toHaveLength(1);
  });

  test("exclusivity is ≤ 1 per AGENT, never per capacity slot (§9.3)", () => {
    const columns = [
      fixture.column({ legId: "L1", agentId: "A1", gammaCu: 10 }),
      fixture.column({ legId: "L2", agentId: "A1", gammaCu: 20 }),
    ];
    const { instance } = objective.buildInstance({ legs: fixture.legs(["L1", "L2"]), columns, deferralEnabled: false });

    expect(instance.exclusivity).toHaveLength(1);
    expect(instance.exclusivity[0]).toMatchObject({ agentId: "A1", sense: "<=1" });
    expect(instance.exclusivity[0].columnIndices).toHaveLength(2);
  });

  test("a selection using one agent twice is rejected, and the violation names §9.3", () => {
    const columns = [
      fixture.column({ legId: "L1", agentId: "A1", gammaCu: 10 }),
      fixture.column({ legId: "L2", agentId: "A1", gammaCu: 20 }),
    ];
    const { instance } = objective.buildInstance({ legs: fixture.legs(["L1", "L2"]), columns, deferralEnabled: false });
    const validity = objective.validate(instance, { columnIndices: [0, 1], deferredLegIds: [] });

    expect(validity.feasible).toBe(false);
    expect(validity.violations[0].detail).toMatch(/parallel arcs at one agent node/);
  });

  test("a Leg covered twice is rejected — coverage is a partition, not a cover", () => {
    const columns = [
      fixture.column({ legId: "L1", agentId: "A1", gammaCu: 10 }),
      fixture.column({ legId: "L1", agentId: "A2", gammaCu: 20 }),
    ];
    const { instance } = objective.buildInstance({ legs: fixture.legs(["L1"]), columns, deferralEnabled: false });
    const validity = objective.validate(instance, { columnIndices: [0, 1], deferredLegIds: [] });

    expect(validity.feasible).toBe(false);
    expect(validity.violations[0].detail).toMatch(/commit it to two agents/);
  });

  test("a column covering a Leg outside the batch is a problem, not silently kept", () => {
    const columns = [fixture.column({ legId: "L9", agentId: "A1", gammaCu: 10 })];
    const built = objective.buildInstance({ legs: fixture.legs(["L1"]), columns, deferralEnabled: false });

    expect(built.ok).toBe(false);
    expect(built.problems[0]).toMatch(/not in this round's batch/);
  });
});

describe("§8.8 / §22.5 rule 1 — the deferral variable is present and switched off", () => {
  test("with the switch thrown, NO y[l] variable exists — not one at an unaffordable price", () => {
    const columns = [fixture.column({ legId: "L1", agentId: "A1", gammaCu: 10 })];
    const { instance } = objective.buildInstance({
      legs: fixture.legs(["L1"], { deferralAdmissible: true, deferCu: 5 }),
      columns,
      deferralEnabled: false,
    });

    expect(instance.deferVariables).toEqual([]);
    expect(instance.deferralEnabled).toBe(false);
    expect(instance.deferralOmissions[0].because).toBe("DEFERRAL_DISABLED_BY_KILL_SWITCH");
  });

  test("with the switch thrown, coverage relaxes to ≤ 1 and the relaxation is recorded", () => {
    const columns = [fixture.column({ legId: "L1", agentId: "A1", gammaCu: 10 })];
    const { instance } = objective.buildInstance({ legs: fixture.legs(["L1"]), columns, deferralEnabled: false });

    expect(instance.coverage[0].sense).toBe(objective.COVERAGE_SENSE.AT_MOST_ONE);
    expect(instance.coverageRelaxedBecause).toMatch(/never read as a priced deferral/);
  });

  test("with the switch on, coverage is an equality and the arc carries C_defer", () => {
    const columns = [fixture.column({ legId: "L1", agentId: "A1", gammaCu: 10 })];
    const { instance } = objective.buildInstance({
      legs: fixture.legs(["L1"], { deferralAdmissible: true, deferCu: 42 }),
      columns,
      deferralEnabled: true,
    });

    expect(instance.coverage[0].sense).toBe(objective.COVERAGE_SENSE.EQUALITY);
    expect(instance.deferVariables[0].costMilliCU).toBe(toMilliCU(42));
  });

  test("a Leg past its §8.8 bound loses the arc rather than being priced high", () => {
    const columns = [fixture.column({ legId: "L1", agentId: "A1", gammaCu: 10 })];
    const { instance } = objective.buildInstance({
      legs: [{ legId: "L1", deferralAdmissible: false, deferPriceMilliCU: null }],
      columns,
      deferralEnabled: true,
    });

    expect(instance.deferVariables).toEqual([]);
    expect(instance.deferralOmissions[0].because).toBe("DEFERRAL_BOUND_REACHED_OR_UNPRICED");
    expect(instance.deferralOmissions[0].degradesTo).toMatch(/removed rather than priced high/);
  });

  test("an unpriced deferral cannot be selected — it is priced or it does not happen", () => {
    const columns = [fixture.column({ legId: "L1", agentId: "A1", gammaCu: 10 })];
    const { instance } = objective.buildInstance({ legs: fixture.legs(["L1"]), columns, deferralEnabled: false });
    const value = objective.objectiveValue(instance, { columnIndices: [], deferredLegIds: ["L1"] });

    expect(value.ok).toBe(false);
    expect(value.problems[0]).toMatch(/silently left waiting/);
  });
});

describe("§9.3 — the objective value IS the true cost of the allocation", () => {
  test("recomputation from the selected columns' own γ agrees exactly, in integer milli-CU", () => {
    const columns = [
      fixture.column({ legId: "L1", agentId: "A1", gammaCu: 10 }),
      fixture.column({ legId: "L2", agentId: "A2", gammaCu: 25 }),
    ];
    const { instance } = objective.buildInstance({ legs: fixture.legs(["L1", "L2"]), columns, deferralEnabled: false });
    const selection = { columnIndices: [0, 1], deferredLegIds: [] };

    const value = objective.objectiveValue(instance, selection);
    expect(value.milliCU).toBe(toMilliCU(35));

    const check = objective.assertObjectiveIsAllocationCost({
      instance,
      selection,
      solverObjectiveMilliCU: value.milliCU,
    });
    expect(check.ok).toBe(true);
    expect(check.deltaMilliCU).toBe(0n);
  });

  test("a solver reporting a different value is refused with an explanation, not tolerated", () => {
    const columns = [fixture.column({ legId: "L1", agentId: "A1", gammaCu: 10 })];
    const { instance } = objective.buildInstance({ legs: fixture.legs(["L1"]), columns, deferralEnabled: false });

    const check = objective.assertObjectiveIsAllocationCost({
      instance,
      selection: { columnIndices: [0], deferredLegIds: [] },
      // One milli-CU out. A tolerance would defeat the purpose of an integer pipeline.
      solverObjectiveMilliCU: toMilliCU(10) + 1n,
    });
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/optimising something the cost model did not produce/);
  });

  test("the deferral price enters the objective on the same scale as γ (§1.3)", () => {
    const columns = [fixture.column({ legId: "L1", agentId: "A1", gammaCu: 10 })];
    const { instance } = objective.buildInstance({
      legs: fixture.legs(["L1"], { deferralAdmissible: true, deferCu: 7 }),
      columns,
      deferralEnabled: true,
    });

    const value = objective.objectiveValue(instance, { columnIndices: [], deferredLegIds: ["L1"] });
    expect(value.milliCU).toBe(toMilliCU(7));
    expect(value.breakdown.deferMilliCU).toBe(toMilliCU(7));
    expect(value.breakdown.columnsMilliCU).toBe(0n);
  });
});

describe("the constraint matrix is grouped, not re-scanned — and the rows are unchanged by it", () => {
  /**
   * The rows `buildInstance` used to produce, written as one `filter` per row exactly as
   * the pre-grouping implementation did.
   *
   * This is the equivalence test's whole point: the optimisation replaced
   * `columnVars.filter(...)` per Leg and per agent with a single grouped pass, and the
   * only defensible evidence that it is correctness-neutral is the discarded expression,
   * kept here and compared against. It reads `instance.columns`, `instance.legIds`,
   * `instance.agentIds` and `instance.deferVariables` — all of which the optimisation did
   * not touch — and rebuilds the two row families from them independently.
   */
  function referenceRows(instance) {
    const deferrable = new Set(instance.deferVariables.map((entry) => entry.legId));
    return {
      coverage: instance.legIds.map((legId) => ({
        constraint: objective.CONSTRAINT.COVERAGE,
        legId,
        columnIndices: instance.columns.filter((entry) => entry.legIds.includes(legId)).map((entry) => entry.index),
        hasDeferVariable: deferrable.has(legId),
        sense: deferrable.has(legId) ? objective.COVERAGE_SENSE.EQUALITY : objective.COVERAGE_SENSE.AT_MOST_ONE,
      })),
      exclusivity: instance.agentIds.map((agentId) => ({
        constraint: objective.CONSTRAINT.EXCLUSIVITY,
        agentId,
        columnIndices: instance.columns.filter((entry) => entry.agentId === agentId).map((entry) => entry.index),
        sense: "<=1",
      })),
    };
  }

  const plan = fixture.brandedPlan();
  const column = (agentId, legIds, gammaCu) =>
    fixture.column({ agentId, legIds, gammaCu, identity: `${agentId}|${legIds.join(",")}|`, plan });

  /**
   * Every shape the two row builders can meet, including the ones a naive grouping gets
   * wrong: a Leg no column covers (an empty row must still exist), a column naming a Leg
   * twice (it joins the row once, because `includes` is a predicate), and a column naming
   * a Leg outside the batch (it joins no row at all).
   */
  const scenarios = [
    {
      name: "dense — every agent appears across several Legs",
      input: {
        legs: fixture.legs(["L1", "L2", "L3", "L4"]),
        columns: [
          column("A1", ["L1"], 10),
          column("A2", ["L1"], 20),
          column("A3", ["L1"], 30),
          column("A1", ["L2"], 15),
          column("A2", ["L2"], 25),
          column("A3", ["L2"], 35),
          column("A1", ["L3"], 12),
          column("A2", ["L3"], 22),
          column("A1", ["L4"], 18),
        ],
        deferralEnabled: false,
      },
    },
    {
      name: "ragged — Legs with different candidate counts, and one with none",
      input: {
        legs: fixture.legs(["L1", "L2", "L3", "L4", "L5"]),
        columns: [column("A1", ["L1"], 10), column("A2", ["L1"], 11), column("A3", ["L1"], 12), column("A1", ["L3"], 40), column("A4", ["L5"], 7)],
        deferralEnabled: false,
      },
    },
    {
      name: "multi-Leg columns beside singletons",
      input: {
        legs: fixture.legs(["L1", "L2", "L3"]),
        columns: [
          column("A1", ["L1", "L2"], 30),
          column("A1", ["L1", "L2", "L3"], 44),
          column("A2", ["L2", "L3"], 28),
          column("A2", ["L1"], 19),
          column("A3", ["L3"], 21),
        ],
        deferralEnabled: false,
      },
    },
    {
      name: "a column naming the same Leg twice joins that row ONCE",
      input: {
        legs: fixture.legs(["L1", "L2"]),
        columns: [column("A1", ["L1", "L1"], 10), column("A2", ["L1", "L2"], 20), column("A3", ["L2", "L2", "L2"], 30)],
        deferralEnabled: false,
      },
    },
    {
      name: "a column covering a Leg outside the batch joins NO coverage row",
      input: {
        legs: fixture.legs(["L1"]),
        columns: [column("A1", ["L1"], 10), column("A2", ["L1", "L9"], 20)],
        deferralEnabled: false,
      },
    },
    {
      name: "deferral on — the coverage rows are equalities",
      input: {
        legs: fixture.legs(["L1", "L2", "L3"], { deferralAdmissible: true, deferCu: 60 }),
        columns: [column("A1", ["L1"], 10), column("A2", ["L2"], 20), column("A1", ["L3"], 30)],
        deferralEnabled: true,
      },
    },
    {
      name: "deferral on, but one Leg past its §8.8 bound — mixed senses in one instance",
      input: {
        legs: [
          { legId: "L1", deferralAdmissible: true, deferPriceMilliCU: toMilliCU(50) },
          { legId: "L2", deferralAdmissible: false, deferPriceMilliCU: null },
        ],
        columns: [column("A1", ["L1"], 10), column("A2", ["L2"], 20), column("A2", ["L1"], 21)],
        deferralEnabled: true,
      },
    },
    {
      name: "Legs with no columns at all",
      input: { legs: fixture.legs(["L1", "L2"]), columns: [], deferralEnabled: false },
    },
    {
      name: "nothing to solve",
      input: { legs: [], columns: [], deferralEnabled: false },
    },
  ];

  test.each(scenarios.map((scenario) => [scenario.name, scenario.input]))(
    "%s — the grouped rows equal the re-scanned rows exactly",
    (unused, input) => {
      const { instance } = objective.buildInstance(input);
      const reference = referenceRows(instance);

      // Compared as canonical JSON rather than field by field, so an added, dropped or
      // renamed field on a row fails here too — the comparison is of the whole row family,
      // not of the one field the optimisation happened to touch.
      expect(canonicalJson(instance.coverage)).toBe(canonicalJson(reference.coverage));
      expect(canonicalJson(instance.exclusivity)).toBe(canonicalJson(reference.exclusivity));
    },
  );

  test("a Leg no column covers still has a row, and it is empty", () => {
    const { instance } = objective.buildInstance(scenarios[1].input);
    const uncovered = instance.coverage.filter((row) => row.columnIndices.length === 0);
    expect(uncovered.map((row) => row.legId)).toEqual(["L2", "L4"]);
    expect(instance.coverage).toHaveLength(5);
  });

  test("row membership is in ascending column index, which is the canonical solve order", () => {
    const { instance } = objective.buildInstance(scenarios[0].input);
    for (const row of [...instance.coverage, ...instance.exclusivity]) {
      const ascending = [...row.columnIndices].sort((a, b) => a - b);
      expect([...row.columnIndices]).toEqual(ascending);
    }
  });

  test("the whole formulation is identical whatever order the columns arrive in", () => {
    // The grouped pass walks `columnVars`, so if the grouping had leaked input order into
    // a row this is where it would show: same columns, three arrival orders, one instance.
    const { legs, columns, deferralEnabled } = scenarios[2].input;
    const forward = objective.buildInstance({ legs, columns, deferralEnabled }).instance;
    const reversed = objective.buildInstance({ legs, columns: [...columns].reverse(), deferralEnabled }).instance;
    const rotated = objective.buildInstance({ legs, columns: [columns[3], columns[0], columns[4], columns[1], columns[2]], deferralEnabled }).instance;

    expect(canonicalJson(reversed)).toBe(canonicalJson(forward));
    expect(canonicalJson(rotated)).toBe(canonicalJson(forward));
  });

  test("the out-of-batch column is still a reported problem, and still consumes its agent's row", () => {
    // The grouping skips the Leg the batch does not have; it must not also skip the
    // column, whose exclusivity row is the reason §1.4 calls the omission a problem.
    const built = objective.buildInstance(scenarios[4].input);
    expect(built.ok).toBe(false);
    expect(built.problems[0]).toMatch(/not in this round's batch/);

    const a2 = built.instance.exclusivity.find((row) => row.agentId === "A2");
    expect(a2.columnIndices).toHaveLength(1);
    expect(built.instance.coverage.map((row) => row.legId)).toEqual(["L1"]);
  });
});

describe("§9.6 requirement 2 — canonical ordering", () => {
  test("columns are indexed in price-then-agent-then-identity order regardless of input order", () => {
    const build = (order) =>
      objective.buildInstance({
        legs: fixture.legs(["L1"]),
        columns: order,
        deferralEnabled: false,
      }).instance;

    const a = fixture.column({ legId: "L1", agentId: "A2", gammaCu: 5 });
    const b = fixture.column({ legId: "L1", agentId: "A1", gammaCu: 5 });
    const c = fixture.column({ legId: "L1", agentId: "A3", gammaCu: 1 });

    const forward = build([a, b, c]);
    const reversed = build([c, b, a]);

    expect(forward.columns.map((entry) => entry.identity)).toEqual(reversed.columns.map((entry) => entry.identity));
    // Cheapest first, then agent id.
    expect(forward.columns.map((entry) => entry.agentId)).toEqual(["A3", "A1", "A2"]);
  });
});
