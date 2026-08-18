"use strict";

/**
 * §9 — the round itself: partitioning that never severs a column, the fast path that is
 * literally the batch path at `|L| = 1`, a decision record for every Leg whatever happens
 * to it, byte-for-byte replay, and the L4 → L3 crossing.
 */

const round = require("../../src/engine/solve/round");
const budgets = require("../../src/engine/solve/budgets");
const planState = require("../../src/engine/shard/planState");
const regime = require("../../src/engine/solve/regime");
const fixture = require("./helpers/roundFixture");
const { toMilliCU } = require("../../src/engine/determinism/fixedPoint");

const DECISION_TIME_MS = 1_800_000_000_000;

/**
 * A round harness: candidate discovery and pricing are injected, exactly as the real
 * coordinator injects them, so these tests exercise the round's own logic rather than
 * §6's expansion or §8's cost function.
 *
 * @param {object} input `{ pairings: { [legId]: { [agentId]: gammaCu } }, agents, config }`
 */
function harness(input) {
  const pairings = input.pairings || {};
  const state = planState.create({ shardId: "s1" });
  state.beginRound("r1");
  for (const agentId of input.agents || []) {
    state.declareAgent({ agentId, capacity: 1, hardCommitmentCount: 0 });
  }

  const tracker = budgets.create({ config: fixture.budgetConfig(input.budgetOverrides), elapsedMs: input.elapsedMs });

  return {
    planState: state,
    budgets: tracker,
    async expandCandidates({ legId }) {
      const entries = Object.entries(pairings[legId] || {});
      return {
        candidates: entries.map(([agentId, gammaCu]) => ({ agentId, costMilliCU: toMilliCU(gammaCu) })),
        achievedGapMilliCU: 0n,
        truncatedBy: null,
        cellsExplored: entries.length,
        agentsEvaluated: entries.length,
        problems: [],
      };
    },
    pricedCandidateFor(agentId, legId, candidate) {
      return {
        agentId,
        legId,
        plan: fixture.brandedPlan(),
        basePlan: null,
        insertionPositions: [],
        pricing: null,
        limits: null,
        // Pre-priced: `plan/columnBuilder.build()` is exercised in its own Phase 8 suite;
        // here the round is what is under test.
        __gammaMilliCU: candidate.costMilliCU,
      };
    },
  };
}

/**
 * `plan()` calls `plan/columnBuilder.build()`, which prices through `Φ`. These tests
 * inject the price instead, by stubbing the builder for the duration of the call — the
 * round's own arithmetic is what is under test, and running the whole cost function here
 * would make a round test fail for a reason in §8.
 */
function withStubbedColumnBuilder(pairings, run) {
  const columnBuilder = require("../../src/engine/plan/columnBuilder");
  const original = columnBuilder.build;
  columnBuilder.build = (input) => {
    const columns = (input.candidates || []).map((candidate) =>
      fixture.column({
        legId: candidate.legId,
        agentId: candidate.agentId,
        gammaMilliCU: candidate.__gammaMilliCU,
        plan: candidate.plan,
      }),
    );
    return {
      ok: true,
      columns,
      pruned: [],
      generation: {
        regime: "SINGLETON",
        generated: columns.length,
        kept: columns.length,
        prunedCount: 0,
        budgetTruncated: false,
        bestPrunedGammaMilliCU: null,
        generationGapMilliCU: 0n,
        generationGapNote: "singleton",
      },
      problems: [],
    };
  };
  return Promise.resolve(run()).finally(() => {
    columnBuilder.build = original;
  });
}

function runPlan(input) {
  const deps = harness(input);
  return withStubbedColumnBuilder(input.pairings, () =>
    round.plan(deps, {
      roundId: "r1",
      shardId: "s1",
      decisionTimeMs: DECISION_TIME_MS,
      legs: (input.legs || []).map((legId) => ({ legId, priority: 0 })),
      config: fixture.budgetConfig(input.budgetOverrides),
      killSwitches: input.killSwitches || {},
    }),
  ).then((result) => ({ result, deps }));
}

describe("§9.4 — partitioning is by connected components, and never severs a column", () => {
  test("two Legs with disjoint agent sets solve as two independent parts", () => {
    const partitioned = round.partition({
      legs: [{ legId: "L1" }, { legId: "L2" }],
      pricedColumns: [
        fixture.column({ legId: "L1", agentId: "A1", gammaCu: 1 }),
        fixture.column({ legId: "L2", agentId: "A2", gammaCu: 1 }),
      ],
    });

    expect(partitioned.parts).toHaveLength(2);
    expect(partitioned.merges).toEqual([]);
    expect(partitioned.note).toMatch(/exactly lossless, not merely near-lossless/);
  });

  test("two Legs sharing one agent are one part", () => {
    const partitioned = round.partition({
      legs: [{ legId: "L1" }, { legId: "L2" }],
      pricedColumns: [
        fixture.column({ legId: "L1", agentId: "A1", gammaCu: 1 }),
        fixture.column({ legId: "L2", agentId: "A1", gammaCu: 1 }),
      ],
    });

    expect(partitioned.parts).toHaveLength(1);
    expect(partitioned.parts[0].legs).toHaveLength(2);
  });

  test("§9.4's SECOND condition: a multi-Leg column merges components with disjoint agent sets", () => {
    // "two Legs may be linked by a multi-Leg column even when their individual candidate
    // agent sets are disjoint, and splitting such a pair would discard that column
    // silently."
    const partitioned = round.partition({
      legs: [{ legId: "L1" }, { legId: "L2" }],
      pricedColumns: [
        fixture.column({ legId: "L1", agentId: "A1", gammaCu: 1 }),
        fixture.column({ legId: "L2", agentId: "A2", gammaCu: 1 }),
        fixture.column({ legIds: ["L1", "L2"], agentId: "A3", gammaCu: 1 }),
      ],
    });

    expect(partitioned.parts).toHaveLength(1);
    expect(partitioned.merges).toHaveLength(1);
    expect(partitioned.merges[0].because).toMatch(/kept whole by merging the components, never severed/);
  });

  test("the partition is canonical — the same components whatever order the columns arrive in", () => {
    const columns = [
      fixture.column({ legId: "L1", agentId: "A1", gammaCu: 1 }),
      fixture.column({ legId: "L2", agentId: "A1", gammaCu: 2 }),
      fixture.column({ legId: "L3", agentId: "A2", gammaCu: 3 }),
    ];
    const forward = round.partition({ legs: [{ legId: "L1" }, { legId: "L2" }, { legId: "L3" }], pricedColumns: columns });
    const reversed = round.partition({
      legs: [{ legId: "L3" }, { legId: "L2" }, { legId: "L1" }],
      pricedColumns: [...columns].reverse(),
    });

    const shape = (partitioned) => partitioned.parts.map((part) => part.legs.map((leg) => leg.legId).sort());
    expect(shape(forward)).toEqual(shape(reversed));
  });
});

describe("§9 — every round produces a decision record, for every Leg", () => {
  test("an assigned Leg, a lost Leg, and a Leg with no candidate are all recorded", async () => {
    const { result } = await runPlan({
      legs: ["L1", "L2", "L3"],
      agents: ["A1"],
      // L1 and L2 compete for A1; L3 has no candidate at all.
      pairings: { L1: { A1: 10 }, L2: { A1: 20 }, L3: {} },
    });

    const byLeg = Object.fromEntries(result.decisions.map((row) => [row.legId, row.outcome]));
    expect(byLeg.L1).toBe(round.LEG_OUTCOME.ASSIGNED);
    expect(byLeg.L2).toBe(round.LEG_OUTCOME.LOST_TO_ANOTHER_LEG);
    expect(byLeg.L3).toBe(round.LEG_OUTCOME.NO_FEASIBLE_CANDIDATE);
  });

  test("the 'no feasible candidate' record is a priced outcome, not an error", async () => {
    const { result } = await runPlan({ legs: ["L1"], agents: [], pairings: { L1: {} } });
    const decision = result.decisions[0];

    expect(result.ok).toBe(true);
    expect(decision.detail).toMatch(/This is a priced outcome, not an error/);
    expect(decision.detail).toMatch(/§17.4 ladder widens the option set/);
  });

  test("the 'lost to another Leg' record names cannibalisation, resolved in the round's favour", async () => {
    const { result } = await runPlan({
      legs: ["L1", "L2"],
      agents: ["A1"],
      pairings: { L1: { A1: 5 }, L2: { A1: 50 } },
    });
    const lost = result.decisions.find((row) => row.outcome === round.LEG_OUTCOME.LOST_TO_ANOTHER_LEG);

    expect(lost.detail).toMatch(/cannibalisation the batch solve exists to resolve/);
  });

  test("assertEveryLegRecorded is the completion criterion, and it passes", async () => {
    const legs = ["L1", "L2", "L3"];
    const { result } = await runPlan({
      legs,
      agents: ["A1", "A2"],
      pairings: { L1: { A1: 10 }, L2: { A2: 20 }, L3: {} },
    });

    expect(round.assertEveryLegRecorded({ legs: legs.map((legId) => ({ legId })), result })).toEqual({
      ok: true,
      missing: [],
      unaccounted: [],
      withoutOutcome: [],
    });
  });

  test("assertEveryLegRecorded FAILS when a Leg has no outcome", () => {
    const verdict = round.assertEveryLegRecorded({
      legs: [{ legId: "L1" }, { legId: "L2" }],
      result: { decisions: [{ legId: "L1", outcome: "ASSIGNED" }, { legId: "L2", outcome: null }] },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.withoutOutcome).toEqual(["L2"]);
  });
});

describe("§9.2 — the fast path IS the batch path at |L| = 1", () => {
  test("a one-Leg round runs the same function and reports the same regime and guarantees", async () => {
    const single = await runPlan({ legs: ["L1"], agents: ["A1"], pairings: { L1: { A1: 10 } } });
    const batch = await runPlan({
      legs: ["L1", "L2"],
      agents: ["A1", "A2"],
      pairings: { L1: { A1: 10 }, L2: { A2: 20 } },
    });

    expect(single.result.regime).toBe(batch.result.regime);
    expect(single.result.guarantees).toEqual(batch.result.guarantees);
    expect(Object.keys(single.result).sort()).toEqual(Object.keys(batch.result).sort());
  });

  test("a one-Leg round is in the singleton regime and reports zero LP–IP gap", async () => {
    const { result } = await runPlan({ legs: ["L1"], agents: ["A1"], pairings: { L1: { A1: 10 } } });

    expect(result.regime).toBe(regime.REGIME.SINGLETON);
    expect(result.lpIpGapMilliCU).toBe(0n);
    expect(result.partitions[0].augmentations).toBe(1);
  });
});

describe("§9.6 — replay reproduces the allocation and per-candidate costs byte for byte", () => {
  test("two runs over identical inputs produce identical decisions and identical objectives", async () => {
    const spec = {
      legs: ["L1", "L2", "L3"],
      agents: ["A1", "A2", "A3"],
      pairings: {
        L1: { A1: 30, A2: 30, A3: 30 },
        L2: { A1: 30, A2: 30, A3: 30 },
        L3: { A1: 30, A2: 30, A3: 30 },
      },
    };

    const first = await runPlan(spec);
    const second = await runPlan(spec);

    const serialise = (result) =>
      JSON.stringify(
        result.decisions.map((row) => [row.legId, row.outcome, row.agentId ?? null, row.columnIdentity ?? null]),
      );

    // Every cost is equal, so the allocation is decided entirely by the canonical order.
    // Byte-for-byte equality here is the §9.6 acceptance test's own property.
    expect(serialise(first.result)).toBe(serialise(second.result));
    expect(String(first.result.searchGapMilliCU)).toBe(String(second.result.searchGapMilliCU));
    expect(first.result.partitions.map((part) => String(part.objectiveMilliCU))).toEqual(
      second.result.partitions.map((part) => String(part.objectiveMilliCU)),
    );
  });
});

describe("§9.3 — the two gaps are reported separately and never summed", () => {
  test("the search gap and the LP–IP gap are distinct fields", async () => {
    const { result } = await runPlan({ legs: ["L1"], agents: ["A1"], pairings: { L1: { A1: 10 } } });

    expect(result).toHaveProperty("searchGapMilliCU");
    expect(result).toHaveProperty("lpIpGapMilliCU");
    expect(result.searchGapMilliCU).not.toBe(undefined);
    // No field sums them, and no field is named for a combined gap.
    expect(Object.keys(result).filter((key) => /combined|total.*gap/i.test(key))).toEqual([]);
  });
});

describe("§2.6 — the round takes SOFT reservations and nothing durable", () => {
  test("an assignment takes a reservation in plan state and describes the one durable effect", async () => {
    const { result, deps } = await runPlan({ legs: ["L1"], agents: ["A1"], pairings: { L1: { A1: 10 } } });

    expect(deps.planState.size).toBe(1);
    expect(result.assignments[0]).toMatchObject({ legId: "L1", agentId: "A1", reserved: true });
    expect(result.assignments[0].durableEffect.targetState).toBe("PLANNED");
  });
});

describe("§9.4 — anytime, at the round level", () => {
  test("an exhausted wall clock still yields a complete result with a record per Leg", async () => {
    const { result } = await runPlan({
      legs: ["L1", "L2"],
      agents: ["A1", "A2"],
      pairings: { L1: { A1: 10 }, L2: { A2: 20 } },
      budgetOverrides: { timeBudgetMs: 0 },
      elapsedMs: () => 1,
    });

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe(round.ROUND_OUTCOME.BUDGET_LIMITED);
    expect(result.decisions).toHaveLength(2);
    expect(result.anytime.ok).toBe(true);
  });

  test("a Leg the clock stopped is recorded as BUDGET_TRUNCATED, not as having lost to a cheaper Leg", async () => {
    // The round used to label every un-assigned, un-deferred Leg `LOST_TO_ANOTHER_LEG`, with a
    // detail asserting that "every agent that could serve this Leg was allocated to a Leg the
    // objective priced more cheaply". On a budget-limited solve that is a causal claim no solve
    // established — at a zero budget the solver returns the trivial incumbent without pricing
    // anything at all — and it is the claim §17.4's anti-starvation ladder would be reading.
    const { result } = await runPlan({
      legs: ["L1", "L2"],
      agents: ["A1", "A2"],
      pairings: { L1: { A1: 10 }, L2: { A2: 20 } },
      budgetOverrides: { timeBudgetMs: 0 },
      elapsedMs: () => 1,
    });

    expect(result.outcome).toBe(round.ROUND_OUTCOME.BUDGET_LIMITED);
    expect(result.decisions.map((row) => row.outcome)).toEqual([
      round.LEG_OUTCOME.BUDGET_TRUNCATED,
      round.LEG_OUTCOME.BUDGET_TRUNCATED,
    ]);
    expect(result.decisions[0].detail).toMatch(/wall-clock budget/);
    expect(result.decisions[0].detail).not.toMatch(/priced more cheaply/);

    // And the incumbent is still a complete, feasible allocation of both Legs — the round-level
    // half of the solver fix: no Leg vanishes from the record because the clock ran out.
    expect(round.assertEveryLegRecorded({ legs: [{ legId: "L1" }, { legId: "L2" }], result }).ok).toBe(true);
  });

  test("the round's incumbent is the UNION of its partitions, not the cheapest of them", async () => {
    // Two Legs with disjoint agent sets are two partitions (§9.4), and `round.plan` used to
    // offer each one to `budgets.offer()` separately. `offer()` keeps a solution only while it
    // improves the objective — right for competing solutions to one problem, wrong for two
    // disjoint sub-problems whose allocations compose — so the round published the cheapest
    // partition's allocation and its objective as the whole round's.
    //
    // `observability/shadow.js` compares `budgets.incumbent.objectiveMilliCU` between the
    // production and shadow rounds, and `workers/counterfactual.worker.js` reads it as the
    // round's realised objective (§21.6). Both consume a number neither can sanity-check.
    const { result } = await runPlan({
      legs: ["L1", "L2", "L3"],
      agents: ["A1", "A2", "A3"],
      pairings: { L1: { A1: 10 }, L2: { A2: 20 }, L3: { A3: 30 } },
    });

    expect(result.partitions).toHaveLength(3);

    const incumbent = result.budgets.incumbent;
    expect(incumbent.assignments.map((row) => row.legId).sort()).toEqual(["L1", "L2", "L3"]);
    expect(incumbent.objectiveMilliCU).toBe(toMilliCU(60));
    expect(incumbent.boundMilliCU).toBe(toMilliCU(60));
  });

  test("a round that assigns nothing reports EMPTY rather than returning nothing", async () => {
    const { result } = await runPlan({ legs: ["L1"], agents: [], pairings: { L1: {} } });

    expect(result.outcome).toBe(round.ROUND_OUTCOME.EMPTY);
    expect(result.assignments).toEqual([]);
    expect(result.decisions).toHaveLength(1);
  });
});

describe("L4 → L3 — the crossing, and what an aborted commit does", () => {
  test("a committed assignment is recorded as committed", async () => {
    const deps = harness({ agents: ["A1"], pairings: { L1: { A1: 10 } } });
    const result = await withStubbedColumnBuilder({}, () =>
      round.execute(
        {
          ...deps,
          commit: async () => ({ committed: true, outcome: "COMMITTED", commitment: { commitmentId: "c1" } }),
        },
        {
          roundId: "r1",
          shardId: "s1",
          decisionTimeMs: DECISION_TIME_MS,
          legs: [{ legId: "L1", priority: 0 }],
          config: fixture.budgetConfig(),
          killSwitches: {},
        },
      ),
    );

    expect(result.committed).toEqual([expect.objectContaining({ legId: "L1", commitmentId: "c1" })]);
    expect(result.aborted).toEqual([]);
  });

  test("an aborted commit releases the SOFT reservation and records the cause on the Leg", async () => {
    const deps = harness({ agents: ["A1"], pairings: { L1: { A1: 10 } } });
    const result = await withStubbedColumnBuilder({}, () =>
      round.execute(
        {
          ...deps,
          commit: async () => ({ committed: false, reason: "LEG_VERSION_CHANGED", detail: "guard G4" }),
        },
        {
          roundId: "r1",
          shardId: "s1",
          decisionTimeMs: DECISION_TIME_MS,
          legs: [{ legId: "L1", priority: 0 }],
          config: fixture.budgetConfig(),
          killSwitches: {},
        },
      ),
    );

    expect(result.aborted[0]).toMatchObject({ legId: "L1", reason: "LEG_VERSION_CHANGED" });
    expect(result.decisions[0].outcome).toBe(round.LEG_OUTCOME.COMMIT_ABORTED);
    // §10.3.2 — the pairing returns to the next round with the cause recorded.
    expect(deps.planState.size).toBe(0);
  });

  test("the record writer is invoked with the completed result", async () => {
    const deps = harness({ agents: ["A1"], pairings: { L1: { A1: 10 } } });
    const recorded = [];
    await withStubbedColumnBuilder({}, () =>
      round.execute(
        {
          ...deps,
          commit: async () => ({ committed: true, outcome: "COMMITTED", commitment: { commitmentId: "c1" } }),
          record: async (result) => recorded.push(result),
        },
        {
          roundId: "r1",
          shardId: "s1",
          decisionTimeMs: DECISION_TIME_MS,
          legs: [{ legId: "L1", priority: 0 }],
          config: fixture.budgetConfig(),
          killSwitches: {},
        },
      ),
    );

    expect(recorded).toHaveLength(1);
    expect(recorded[0].decisions).toHaveLength(1);
  });
});
