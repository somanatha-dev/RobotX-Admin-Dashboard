"use strict";

/**
 * Engine lane — Phase 10 → Phase 11, the composition rather than either side of it.
 *
 * `PHASE_10_REMEDIATION_AND_CLOSURE.md` §12 handed Phase 11 four items. Three of them are
 * claims about a *pipeline*:
 *
 *   P11-1  WITHDRAWN. `decidedNothingBecause` is not to exist; the state it was invented
 *          for is already distinguishable from the fields Phase 10 publishes.
 *   P11-2  Tier A must carry the deciding partition's `solver`, `optimalityCertified`
 *          and `fallbackFrom`, "so an exactness fallback in production is visible in the
 *          record, not only in the round object".
 *   P11-3  The record must carry the **truncation gap** (`objective − bound`) as a
 *          quantity distinct from `lpIpGapMilliCU`.
 *   P11-4  Round incumbent semantics were corrected: disjoint partitions **compose** into
 *          the round result rather than competing, so every shadow/counterfactual
 *          consumer must read the union.
 *
 * Every test here drives the **real producer** — `solve/round.js` calling
 * `solve/minCostFlow.js` — and reads the **real consumer**, `observability/`'s writer,
 * record and Explanation API. Nothing asserts against a hand-written partition report:
 * a fixture that names `optimalityCertified: true` proves only that the fixture says so,
 * and "do not infer these fields from labels" is the point of the handoff.
 */

const round = require("../../src/engine/solve/round");
const budgets = require("../../src/engine/solve/budgets");
const planState = require("../../src/engine/shard/planState");
const minCostFlow = require("../../src/engine/solve/minCostFlow");
const costScaling = require("../../src/engine/solve/costScaling");
const objective = require("../../src/engine/solve/objective");
const decisionRecord = require("../../src/engine/observability/decisionRecord");
const tierA = require("../../src/engine/observability/tierA");
const explanation = require("../../src/engine/observability/explanation");
const shadow = require("../../src/engine/observability/shadow");
const counterfactualWorker = require("../../src/workers/counterfactual.worker");
const sampling = require("../../src/engine/observability/sampling");
const fixture = require("./helpers/roundFixture");
const { toMilliCU } = require("../../src/engine/determinism/fixedPoint");

const DECISION_TIME_MS = 1_800_000_000_000;

/* ── The round harness, the same shape the coordinator injects ─────────────── */

function harness(input) {
  const pairings = input.pairings || {};
  const state = planState.create({ shardId: "s1" });
  state.beginRound("r1");
  for (const agentId of input.agents || []) state.declareAgent({ agentId, capacity: 1, hardCommitmentCount: 0 });

  return {
    planState: state,
    budgets: budgets.create({ config: fixture.budgetConfig(input.budgetOverrides), elapsedMs: input.elapsedMs }),
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
        __gammaMilliCU: candidate.costMilliCU,
      };
    },
  };
}

function withStubbedColumnBuilder(run, options) {
  const settings = options || {};
  const columnBuilder = require("../../src/engine/plan/columnBuilder");
  const original = columnBuilder.build;
  columnBuilder.build = (input) => {
    const columns = (input.candidates || []).map((candidate) =>
      fixture.column({
        // A multi-Leg column puts the round in §9.3's COLUMN regime, which the min-cost
        // flow does not serve — the one production path on which no partition exists.
        legIds: settings.multiLeg ? [candidate.legId, `${candidate.legId}-b`] : [candidate.legId],
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
        regime: settings.multiLeg ? "COLUMN" : "SINGLETON",
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
  return withStubbedColumnBuilder(
    () =>
      round.plan(deps, {
        roundId: "r1",
        shardId: "s1",
        decisionTimeMs: DECISION_TIME_MS,
        legs: (input.legs || []).map((legId) => ({ legId, priority: 0 })),
        config: fixture.budgetConfig(input.budgetOverrides),
        killSwitches: input.killSwitches || {},
      }),
    { multiLeg: input.multiLeg === true },
  ).then((result) => ({ result, deps }));
}

/** Write a round's records through the real writer, and hand back the stored rows. */
async function recordsFor(result) {
  const prisma = fixture.memoryPrisma();
  const report = await decisionRecord.writeRound(
    { prisma },
    {
      round: result,
      context: {
        shardId: "s1",
        snapshot: { snapshotId: "r1", hash: "h", seed: "s", pins: {} },
        perLeg: {},
      },
      budget: sampling.createBudget({ writeBudgetPerMinute: 0, reservoirSize: 0 }),
      config: { sampleRate: 0, compactTopN: 5, fullRetentionDays: 30, tierBRetentionDays: 30, snapshotRetentionDays: 30, tierARecordBytes: 2048 },
      nowMs: DECISION_TIME_MS,
    },
  );

  const byLeg = new Map(prisma.__tables.decisionRecords.map((row) => [row.legId, row]));
  return { prisma, report, byLeg };
}

/* ── P11-2 / P11-3 — the exact, certified case ─────────────────────────────── */

describe("P11-2 / P11-3 — an EXACT cost-scaling solve reaches the decision record", () => {
  test("solver, certification, fallback, objective, bound and a ZERO truncation gap, traced from the solve", async () => {
    const { result } = await runPlan({
      legs: ["L1", "L2"],
      agents: ["A1", "A2"],
      pairings: { L1: { A1: 10, A2: 40 }, L2: { A2: 20 } },
    });

    // The producer's own claim, before any record exists.
    const part = result.partitions.find((row) => row.legIds.includes("L1"));
    expect(part.solver).toBe(minCostFlow.SOLVER.COST_SCALING);
    expect(part.optimalityCertified).toBe(true);
    expect(part.fallbackFrom).toBeNull();
    expect(part.budgetLimited).toBe(false);
    // An exact solve proves its own bound: the two are the same number, so the truncation
    // gap is zero *by construction* rather than by rounding.
    expect(part.objectiveMilliCU).toBe(part.boundMilliCU);

    const { byLeg } = await recordsFor(result);
    const bounds = byLeg.get("L1").searchAndSolveBounds;

    expect(bounds.solver).toBe("COST_SCALING");
    expect(bounds.optimalityCertified).toBe(true);
    expect(bounds.fallbackFrom).toBeNull();
    expect(bounds.budgetLimited).toBe(false);
    expect(bounds.objectiveMilliCU).toBe(part.objectiveMilliCU.toString());
    expect(bounds.boundMilliCU).toBe(part.boundMilliCU.toString());
    // A string, like every other cost in Tier A (§9.6 requirement 1) — never a number.
    expect(bounds.truncationGapMilliCU).toBe("0");
    expect(typeof bounds.truncationGapMilliCU).toBe("string");
  });

  test("each partition's OWN solver metadata reaches its OWN Legs, never a round-level roll-up", async () => {
    // Three Legs with disjoint agent sets are three partitions (§9.4). Attributing one
    // partition's certification to all of them would be a claim no solve made about the
    // other two — and would be invisible while every partition happens to agree.
    const { result } = await runPlan({
      legs: ["L1", "L2", "L3"],
      agents: ["A1", "A2", "A3"],
      pairings: { L1: { A1: 10 }, L2: { A2: 20 }, L3: { A3: 30 } },
    });

    expect(result.partitions).toHaveLength(3);
    for (const part of result.partitions) expect(part.legIds).toHaveLength(1);

    const { byLeg } = await recordsFor(result);
    for (const part of result.partitions) {
      const legId = part.legIds[0];
      expect(byLeg.get(legId).searchAndSolveBounds.objectiveMilliCU).toBe(part.objectiveMilliCU.toString());
    }

    // The three objectives differ, so a roll-up would be visible here.
    const objectives = result.partitions.map((row) => row.objectiveMilliCU.toString());
    expect(new Set(objectives).size).toBe(3);
  });

  test("a Leg with no feasible candidate WAS still solved, and the record says which solver", async () => {
    // Worth pinning because the intuition points the other way. §9.4 puts a Leg with an
    // empty candidate set into the batch anyway (`legsInBatch` admits
    // `NO_FEASIBLE_CANDIDATE`), so it is a real member of a real sub-problem that a real
    // solver decided — it simply had no column to assign. The record says exactly that,
    // rather than the `null` an "obviously nothing ran" reading would expect.
    const { result } = await runPlan({ legs: ["L1"], agents: [], pairings: { L1: {} } });

    expect(result.decisions[0].outcome).toBe(round.LEG_OUTCOME.NO_FEASIBLE_CANDIDATE);

    const { byLeg } = await recordsFor(result);
    const bounds = byLeg.get("L1").searchAndSolveBounds;

    expect(bounds.solver).toBe("COST_SCALING");
    expect(bounds.optimalityCertified).toBe(true);
    expect(bounds.truncationGapMilliCU).toBe("0");
  });

  test("a Leg no partition ever contained carries NULL, not a manufactured 'not certified'", async () => {
    // The genuine no-solve path: a regime the solver does not serve, where `partitions` is
    // empty by construction, so no partition can be attributed to any Leg.
    const { result } = await runPlan({
      legs: ["L1", "L2"],
      agents: ["A1"],
      // One agent serving two Legs through a single multi-Leg column puts the round in the
      // COLUMN regime, which §9.3's min-cost flow does not solve.
      pairings: { L1: { A1: 10 }, L2: { A1: 20 } },
      multiLeg: true,
    });

    // The path must actually have been taken, or the assertions below prove nothing.
    expect(result.outcome).toBe(round.ROUND_OUTCOME.REGIME_UNSOLVABLE);
    expect(result.partitions).toHaveLength(0);

    const { byLeg } = await recordsFor(result);
    const bounds = byLeg.get("L1").searchAndSolveBounds;

    // There was no solve, so there is no solver, no certification and no gap. `null` is
    // not `false`: a record claiming `optimalityCertified: false` here would describe a
    // proof that failed, and none was attempted.
    expect(bounds.solver).toBeNull();
    expect(bounds.optimalityCertified).toBeNull();
    expect(bounds.truncationGapMilliCU).toBeNull();
    expect(bounds.objectiveMilliCU).toBeNull();
    expect(bounds.legsUnassignedByIncumbent).toBeNull();
  });
});

/* ── P11-3 — the budget-limited case, and the four gaps ────────────────────── */

describe("P11-3 — a BUDGET-LIMITED solve records a real truncation gap", () => {
  const budgetLimitedRound = (pairings) =>
    runPlan({
      legs: Object.keys(pairings || { L1: { A1: 10 }, L2: { A2: 20 } }),
      agents: ["A1", "A2"],
      pairings: pairings || { L1: { A1: 10 }, L2: { A2: 20 } },
      // §9.4's wall-clock budget, exhausted before the first scaling phase.
      budgetOverrides: { timeBudgetMs: 0 },
      elapsedMs: () => 1,
    });

  test("the record carries the objective, a REAL relaxation bound, and the exact gap between them", async () => {
    // A negatively-priced pairing (γ < 0 is legitimate — §8's priority credit) is what makes
    // the money gap visible: the relaxation's money lower bound goes negative while the
    // trivial incumbent's money cost stays at zero.
    const { result } = await budgetLimitedRound({ L1: { A1: -10 }, L2: { A2: -20 } });

    const part = result.partitions.find((row) => row.legIds.includes("L1"));
    expect(part.budgetLimited).toBe(true);
    expect(part.optimalityCertified).toBe(false);
    // Not the objective echoed back: a budget-limited solve returns "the incumbent with
    // its LP bound" (§9.4), so the bound is the relaxation's, computed separately.
    expect(typeof part.boundMilliCU).toBe("bigint");
    expect(part.objectiveMilliCU > part.boundMilliCU).toBe(true);

    const { byLeg } = await recordsFor(result);
    const bounds = byLeg.get("L1").searchAndSolveBounds;

    expect(bounds.optimalityCertified).toBe(false);
    expect(bounds.budgetLimited).toBe(true);
    // Exact integer arithmetic, end to end.
    expect(BigInt(bounds.truncationGapMilliCU)).toBe(part.objectiveMilliCU - part.boundMilliCU);
    expect(BigInt(bounds.truncationGapMilliCU) > 0n).toBe(true);
  });

  test("truncationGap > 0 while lpIpGapMilliCU = 0 — the two are NOT the same quantity", async () => {
    // The distinctness §9.3 and P11-3 both require, made a failing condition rather than a
    // sentence. In the singleton regime the LP relaxation is integral, so the LP/IP gap is
    // exactly zero *even on a solve that stopped early* — and a reader who took it as the
    // measure of "how far from optimal" would read zero on a round that never priced a Leg.
    const { result } = await budgetLimitedRound({ L1: { A1: -10 }, L2: { A2: -20 } });
    const { byLeg } = await recordsFor(result);
    const bounds = byLeg.get("L1").searchAndSolveBounds;

    expect(bounds.lpIpGapMilliCU).toBe("0");
    expect(BigInt(bounds.truncationGapMilliCU) > 0n).toBe(true);
    expect(bounds.truncationGapMilliCU).not.toBe(bounds.lpIpGapMilliCU);

    // And the third gap is a third field again: candidate-set truncation (§6.4, §9.3).
    expect(bounds).toHaveProperty("searchGapMilliCU");
    // The fourth — the column-generation gap — is measured offline only and is deliberately
    // absent from a decision record (§21.6).
    expect(bounds).not.toHaveProperty("columnGenerationGapMilliCU");
  });

  test("a ZERO money gap on a trivial incumbent is not readable as a proof of optimality", async () => {
    // The trap P11-3's `objective − bound` walks into on its own, and the reason the record
    // carries a second field. §9.3's objective is lexicographic — `(unassigned, milliCU)` —
    // and `objectiveMilliCU`/`boundMilliCU` are the money half. With positive prices the
    // trivial incumbent queues every Leg at money cost 0 against a money lower bound of 0,
    // so the money gap is exactly zero on the WORST incumbent the round can produce.
    const { result } = await budgetLimitedRound({ L1: { A1: 10 }, L2: { A2: 20 } });
    const { byLeg } = await recordsFor(result);
    const bounds = byLeg.get("L1").searchAndSolveBounds;

    expect(bounds.truncationGapMilliCU).toBe("0");
    // …and every one of these contradicts the optimistic reading.
    expect(bounds.optimalityCertified).toBe(false);
    expect(bounds.budgetLimited).toBe(true);
    expect(bounds.legsUnassignedByIncumbent).toBe(1);
    expect(byLeg.get("L1").outcome.outcome).toBe(round.LEG_OUTCOME.BUDGET_TRUNCATED);

    // And the exact solve of the same instance assigns it, so the incumbent really was
    // far from optimal despite the zero money gap.
    const { result: exact } = await runPlan({
      legs: ["L1", "L2"],
      agents: ["A1", "A2"],
      pairings: { L1: { A1: 10 }, L2: { A2: 20 } },
    });
    expect(exact.partitions.every((part) => part.unassigned.length === 0)).toBe(true);
  });

  test("P11-1 stays withdrawn: the state is distinguishable WITHOUT decidedNothingBecause", async () => {
    const { result } = await budgetLimitedRound();
    const { byLeg } = await recordsFor(result);

    // Phase 10's closure: "`budgetLimited: true` + `solverDiagnostics.trivialIncumbent` +
    // `scalingPhases: 0` + `legsDecidedByTrivialCompletion`, and `LEG_OUTCOME.BUDGET_TRUNCATED`
    // per Leg". Every one of those is present, so the invented field is not needed.
    expect(result.decisions.map((row) => row.outcome)).toEqual([
      round.LEG_OUTCOME.BUDGET_TRUNCATED,
      round.LEG_OUTCOME.BUDGET_TRUNCATED,
    ]);
    expect(byLeg.get("L1").searchAndSolveBounds.budgetLimited).toBe(true);
    expect(byLeg.get("L1").outcome.outcome).toBe(round.LEG_OUTCOME.BUDGET_TRUNCATED);

    // The field itself must not exist anywhere in the record.
    expect(JSON.stringify(byLeg.get("L1"))).not.toMatch(/decidedNothingBecause/);
  });
});

/* ── P11-2 — the exactness fallback, through the real dispatch ─────────────── */

describe("P11-2 — an SSP fallback is visible in the record, not only in the round object", () => {
  test("fallbackFrom names the reason cost scaling handed the instance over", () => {
    // The fallback branch is reached when `costScaling.prepare()` refuses. Forcing that
    // refusal — rather than hand-writing a partition report — keeps `solver`,
    // `optimalityCertified` and `fallbackFrom` the *solver's* values.
    const original = costScaling.prepare;
    costScaling.prepare = () => ({ ok: false, refusal: "PREPARE_REFUSED", detail: "forced, to reach §20.2's exactness fallback" });

    let solved;
    try {
      const instance = objective.buildInstance({
        legs: fixture.legs(["L1"]),
        columns: [fixture.column({ legId: "L1", agentId: "A1", gammaCu: 10 })],
        deferralEnabled: false,
      });
      expect(instance.ok).toBe(true);
      solved = minCostFlow.solve(instance.instance, {});
    } finally {
      costScaling.prepare = original;
    }

    expect(solved.ok).toBe(true);
    expect(solved.solver).toBe(minCostFlow.SOLVER.SUCCESSIVE_SHORTEST_PATH);
    expect(solved.solverDiagnostics.fallbackFrom).toMatch(/PREPARE_REFUSED/);

    // The reference solver does not produce a certificate, and the record must say `null`
    // rather than `false`: "no proof was attempted" and "a proof failed" are different
    // statements, and only one of them is true here.
    expect(solved.optimalityCertified === undefined || solved.optimalityCertified === null).toBe(true);

    // Through the record's own adapter, from the producer's values.
    const record = tierA.build(
      decisionRecord.tierAInputFor({
        round: {
          roundId: "r1",
          shardId: "s1",
          decisionTimeMs: DECISION_TIME_MS,
          decisions: [{ legId: "L1", outcome: "ASSIGNED", agentId: "A1" }],
          partitions: [
            {
              root: "L1",
              ok: true,
              legIds: ["L1"],
              solver: solved.solver,
              optimalityCertified: solved.optimalityCertified,
              fallbackFrom: solved.solverDiagnostics.fallbackFrom,
              objectiveMilliCU: solved.objectiveMilliCU,
              boundMilliCU: solved.boundMilliCU,
            },
          ],
        },
        decision: { legId: "L1", outcome: "ASSIGNED", agentId: "A1" },
        context: { shardId: "s1" },
      }),
    );

    expect(record.searchAndSolveBounds.solver).toBe("SUCCESSIVE_SHORTEST_PATH");
    expect(record.searchAndSolveBounds.fallbackFrom).toMatch(/PREPARE_REFUSED/);
    expect(record.searchAndSolveBounds.optimalityCertified).toBeNull();
  });
});

/* ── The Explanation API's view of all of it ───────────────────────────────── */

describe("§21.3 — the Explanation API states what the answer is standing on", () => {
  test("a certified answer says so; a budget-limited one says it is NOT certified, with the gap", async () => {
    const exact = await runPlan({ legs: ["L1"], agents: ["A1", "A2"], pairings: { L1: { A1: 10, A2: 40 } } });
    const exactRows = await recordsFor(exact.result);
    const certified = explanation.explain({ row: exactRows.byLeg.get("L1"), query: explanation.QUERY.WHY_THIS_AGENT }).answers[0];

    expect(certified.solve.solver).toBe("COST_SCALING");
    expect(certified.solve.optimalityCertified).toBe(true);
    expect(certified.solve.truncationGapMilliCU).toBe("0");
    expect(certified.solve.sentence).toMatch(/certified optimal/);

    const limited = await runPlan({
      legs: ["L1", "L2"],
      agents: ["A1", "A2"],
      pairings: { L1: { A1: -10 }, L2: { A2: -20 } },
      budgetOverrides: { timeBudgetMs: 0 },
      elapsedMs: () => 1,
    });
    const limitedRows = await recordsFor(limited.result);
    const waiting = explanation.explain({ row: limitedRows.byLeg.get("L1"), query: explanation.QUERY.WHY_STILL_WAITING }).answers[0];

    expect(waiting.solve.optimalityCertified).toBe(false);
    expect(waiting.solve.budgetLimited).toBe(true);
    expect(BigInt(waiting.solve.truncationGapMilliCU) > 0n).toBe(true);
    expect(waiting.solve.sentence).toMatch(/NOT certified optimal/);
    // The API states the gap's scope rather than letting a reader assume it is total.
    expect(waiting.solve.truncationGapScope).toMatch(/money half/);
    expect(waiting.solve.legsUnassignedByIncumbent).toBe(1);
    // The four gaps stay four, and the answer says which is which.
    expect(Object.keys(waiting.solve.gapsReportedSeparately).sort()).toEqual([
      "columnGenerationGap",
      "lpIpGapMilliCU",
      "searchGapMilliCU",
      "truncationGapMilliCU",
    ]);
  });

  test("an explanation never presents reconstruction as retrieval, whatever the solve was", async () => {
    const { result } = await runPlan({ legs: ["L1"], agents: ["A1", "A2"], pairings: { L1: { A1: 10, A2: 40 } } });
    const { byLeg } = await recordsFor(result);
    const all = explanation.explain({ row: byLeg.get("L1"), agentId: "A2" }).answers;

    for (const answer of all) {
      expect(Object.values(explanation.SOURCE)).toContain(answer.source);
      expect(answer.reconstructed).toBe(answer.source === explanation.SOURCE.RECONSTRUCTED);
      if (answer.reconstructed) expect(answer.reconstructionNote).toMatch(/byte-identical/);
      else expect(answer.reconstructionNote).toBeNull();
    }
  });
});

/* ── P11-4 — round-union semantics, at every consumer ──────────────────────── */

describe("P11-4 — every observability consumer reads the round UNION, not the cheapest partition", () => {
  const threePartitions = () =>
    runPlan({
      legs: ["L1", "L2", "L3"],
      agents: ["A1", "A2", "A3"],
      pairings: { L1: { A1: 10 }, L2: { A2: 20 }, L3: { A3: 30 } },
    });

  test("the incumbent the consumers read is the sum of the parts", async () => {
    const { result } = await threePartitions();

    expect(result.partitions).toHaveLength(3);
    expect(result.budgets.incumbent.objectiveMilliCU).toBe(toMilliCU(60));
    // Not 10 — the cheapest partition's objective, which is what the pre-D5 round published.
    expect(result.budgets.incumbent.objectiveMilliCU).not.toBe(toMilliCU(10));
    expect(result.budgets.incumbent.assignments.map((row) => row.legId).sort()).toEqual(["L1", "L2", "L3"]);
  });

  test("shadow.compare's objective delta is a union-to-union comparison", async () => {
    const { result: production } = await threePartitions();
    // The same round with one pairing priced 5 CU cheaper: a candidate that is better by
    // exactly 5, and nothing else changed.
    const { result: candidate } = await runPlan({
      legs: ["L1", "L2", "L3"],
      agents: ["A1", "A2", "A3"],
      pairings: { L1: { A1: 5 }, L2: { A2: 20 }, L3: { A3: 30 } },
    });

    const report = shadow.compare({
      production,
      productionSnapshotHash: "h",
      shadow: { label: "cheaper-L1", snapshotHash: "h", result: candidate },
    });

    expect(report.ok).toBe(true);
    // 55 − 60. Under the pre-D5 semantics both sides would have published their cheapest
    // partition (5 and 10), and the delta would have been the same number for the wrong
    // reason — which is why P11-4 says any comparison recorded against the old behaviour
    // is invalid rather than merely stale.
    expect(report.objectiveDeltaMilliCU).toBe(toMilliCU(-5).toString());
    expect(report.objectiveDeltaFavoursCandidate).toBe(true);
    expect(report.agreementRate).toBe(1);
  });

  test("the counterfactual evaluator's corpus loads the union as the round's realised objective", async () => {
    const { result } = await threePartitions();

    const prisma = fixture.memoryPrisma();
    prisma.__tables.rounds.push({
      roundId: "r1",
      shardId: "s1",
      decisionTime: new Date(DECISION_TIME_MS),
      regime: result.regime,
      // The `Round` row as `coordinator.worker.recordRound()` writes it: the incumbent,
      // serialised, because int64 milli-CU does not survive a JSON number.
      budgets: { incumbent: { objectiveMilliCU: result.budgets.incumbent.objectiveMilliCU.toString() } },
    });

    const corpus = await counterfactualWorker.loadRounds({ prisma }, { shardId: "s1" });

    expect(corpus).toHaveLength(1);
    expect(corpus[0].objectiveMilliCU).toBe(toMilliCU(60));
    // Revived as a bigint, so every comparison downstream is exact (§9.6 requirement 1).
    expect(typeof corpus[0].objectiveMilliCU).toBe("bigint");
  });

  test("a milli-CU objective past float precision survives the corpus round trip", async () => {
    // 2^53 + 1. The value a JSON number silently rounds to 2^53, which would make two
    // different allocations compare equal in the evaluator's own gap arithmetic.
    const precisionBoundary = 9007199254740993n;

    const prisma = fixture.memoryPrisma();
    prisma.__tables.rounds.push({
      roundId: "r-precision",
      shardId: "s1",
      decisionTime: new Date(DECISION_TIME_MS),
      regime: "SINGLETON",
      budgets: { incumbent: { objectiveMilliCU: precisionBoundary.toString() } },
    });

    const corpus = await counterfactualWorker.loadRounds({ prisma }, { shardId: "s1" });

    expect(corpus[0].objectiveMilliCU).toBe(precisionBoundary);
    expect(corpus[0].objectiveMilliCU).not.toBe(BigInt(Number(precisionBoundary)));
  });
});
