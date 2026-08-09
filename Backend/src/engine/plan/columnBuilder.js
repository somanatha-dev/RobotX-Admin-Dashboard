"use strict";

/**
 * The Column Builder (§9.3) — **Tier 1**, decision path. **Singleton columns only.**
 *
 * > | **Singleton** | every column covers exactly one Leg | The constraint matrix is the
 * > incidence matrix of a bipartite graph, hence **totally unimodular** | **Min-cost flow**
 * > … | LP relaxation is integral; the solve is **exact**, with no branching and no
 * > integrality gap | Exact marginal prices of the integer problem |
 *
 * > The singleton regime is the ordinary case and the one the min-cost-flow machinery
 * > exists for: it is what the round degenerates to when bundling is disabled by kill
 * > switch (§22.5) and when chaining produces no multi-Leg column. **Selecting the flow
 * > solver in that regime is not a fallback but a specialisation** — the same problem,
 * > solved by the algorithm that exploits its structure.
 *
 * Phase 8's checklist says "singleton columns only for now", and this module is where that
 * restriction is *structural* rather than a configuration choice: `build()` emits one
 * column per (agent, Leg) pair and `assertSingletonRegime()` refuses a set containing a
 * multi-Leg column. Multi-Leg columns are T2-02 (`solve/setPartitioning.js`,
 * `plan/multiLegColumn.js`, kill switch `multi_leg_columns`) and belong to a later phase; a
 * Tier 1 module able to emit one would be a kill switch that cannot be thrown.
 *
 * ── The generation gap is reported, not hidden ─────────────────────────────
 * > **No pricing subproblem is solved to optimality, so no claim is made that the generated
 * > set contains the optimal column.** The selection among generated columns is exact;
 * > generation is heuristic. The decision record reports the number of columns generated,
 * > the number pruned, the best pruned column's bound.
 *
 * In the singleton regime with one column per feasible candidate, the generated set is
 * *complete over single-Leg columns* — the generation gap is exactly zero and this module
 * says so, rather than reporting an unknown. That is a real property of the regime worth
 * recording: it means the only residual approximation in such a round is candidate-set
 * truncation (§6.4), which is separately bounded. §9.3 is explicit that the two gaps are
 * never summed, so they are returned as two fields.
 *
 * ── Budgets (§9.4) ─────────────────────────────────────────────────────────
 * > | Columns per round | `plan.max_columns_per_round` | 2 000 | Keep the cheapest by
 * > bound; record the best pruned column's bound |
 *
 * Truncation keeps the cheapest by realised price and records the cheapest *pruned* price,
 * which is a valid bound on what was discarded in the singleton regime because every
 * column in the set is priced before truncation. Where a caller supplies precomputed
 * bounds instead, they are used and the source is recorded.
 *
 * Determinism: columns are ordered by `(gamma, agent tie-break, identity)`, a total order
 * ending in a unique id, so truncation discards the same columns on every run (§9.6
 * requirement 2).
 */

const column = require("./column");
const { compareStrings, canonicalSort, thenBy } = require("../determinism/ordering");
const { compare: compareMilliCU } = require("../determinism/fixedPoint");

/** Why a generated column did not reach the solver. */
const PRUNED = Object.freeze({
  BUDGET: "COLUMNS_PER_ROUND_BUDGET",
  UNPRICEABLE: "UNPRICEABLE",
  INADMISSIBLE: "QUEUE_DEPTH_OR_HORIZON",
});

/**
 * The canonical total order over priced columns: price first, then the §9.6 tie-break,
 * ending in the column's unique identity.
 * @structural §9.6 requirement 2's order, specialised to columns
 */
const comparePriced = thenBy(
  (a, b) => compareMilliCU(a.gammaMilliCU, b.gammaMilliCU),
  (a, b) => compareStrings(a.agentId, b.agentId),
  (a, b) => compareStrings(a.identity, b.identity),
);

/**
 * Build and price the singleton columns for one round.
 *
 * @param {object} input
 * @param {Array<object>} input.candidates one per (agent, Leg) pairing that survived the
 *   feasibility gate: `{ agentId, legId, plan, basePlan, pricing, limits }`
 * @param {number} input.maxColumnsPerRound `plan.max_columns_per_round`
 * @returns {{ ok: boolean, columns: object[], pruned: object[], generation: object,
 *             problems: string[] }}
 */
function build(input) {
  const source = input || {};
  const priced = [];
  const pruned = [];
  const problems = [];

  for (const candidate of source.candidates || []) {
    const built = column.make({
      agentId: candidate.agentId,
      legIds: [candidate.legId],
      insertionPositions: candidate.insertionPositions,
      plan: candidate.plan,
      basePlan: candidate.basePlan,
    });

    const result = column.price(built, {
      candidatePhi: candidate.pricing && candidate.pricing.candidatePhi,
      basePhi: candidate.pricing && candidate.pricing.basePhi,
      churn: candidate.pricing && candidate.pricing.churn,
      limits: candidate.limits,
    });

    if (!result.ok) {
      pruned.push({
        identity: built.identity,
        agentId: built.agentId,
        legIds: built.legIds,
        reason: result.problems.length > 0 ? PRUNED.INADMISSIBLE : PRUNED.UNPRICEABLE,
        detail: [...result.problems, ...result.missing],
        gammaMilliCU: null,
      });
      continue;
    }

    priced.push({
      identity: built.identity,
      agentId: built.agentId,
      legIds: built.legIds,
      singleton: built.singleton,
      gammaMilliCU: result.gammaMilliCU,
      breakdown: result.breakdown,
      omittedTerms: result.omittedTerms,
      column: built,
    });
    problems.push(...result.problems);
  }

  const ordered = canonicalSort(priced, comparePriced);

  let kept = ordered;
  let bestPrunedGammaMilliCU = null;

  if (Number.isFinite(source.maxColumnsPerRound) && ordered.length > source.maxColumnsPerRound) {
    kept = ordered.slice(0, source.maxColumnsPerRound);
    for (const discarded of ordered.slice(source.maxColumnsPerRound)) {
      pruned.push({
        identity: discarded.identity,
        agentId: discarded.agentId,
        legIds: discarded.legIds,
        reason: PRUNED.BUDGET,
        detail: [],
        gammaMilliCU: discarded.gammaMilliCU,
      });
      if (bestPrunedGammaMilliCU === null || compareMilliCU(discarded.gammaMilliCU, bestPrunedGammaMilliCU) < 0) {
        bestPrunedGammaMilliCU = discarded.gammaMilliCU;
      }
    }
  }

  const singletonRegime = kept.every((entry) => entry.singleton);

  return {
    ok: true,
    columns: kept,
    pruned,
    generation: Object.freeze({
      regime: singletonRegime ? "SINGLETON" : "COLUMN",
      generated: priced.length,
      kept: kept.length,
      prunedCount: pruned.length,
      budgetTruncated: kept.length < ordered.length,
      bestPrunedGammaMilliCU,
      // Reported separately from §6.4's search gap, and never summed with it: the two
      // bound different approximations (§9.3).
      generationGapMilliCU: singletonRegime && kept.length === ordered.length ? 0n : null,
      generationGapNote: singletonRegime
        ? "the singleton column set is complete over single-Leg columns — one column per feasible " +
          "candidate — so column generation contributes no gap. The round's only residual approximation " +
          "is candidate-set truncation (§6.4), which is bounded and reported separately"
        : "multi-Leg columns are present; the generation gap is not established by this builder",
    }),
    problems,
  };
}

/**
 * Refuse a column set that is not in the singleton regime.
 *
 * @param {object[]} columns
 * @returns {{ ok: boolean, problems: string[] }}
 */
function assertSingletonRegime(columns) {
  const problems = [];
  for (const entry of columns || []) {
    const legIds = entry.legIds || (entry.column && entry.column.legIds) || [];
    if (legIds.length !== 1) {
      problems.push(
        `column ${String(entry.identity)} covers ${legIds.length} Legs. Phase 8 builds singleton columns ` +
          "only; multi-Leg columns are the Tier 2 mechanism T2-02 behind the `multi_leg_columns` kill " +
          "switch, and emitting one here would be a kill switch that cannot be thrown (§1.8 rule 2)",
      );
    }
  }
  return { ok: problems.length === 0, problems };
}

module.exports = {
  PRUNED,
  comparePriced,
  build,
  assertSingletonRegime,
};
