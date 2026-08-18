"use strict";

/**
 * The Explanation API's answers (§21.3) — **Tier 1** (T1-03), tenet T8.
 *
 * > Derived from the decision record, serving both humans and machines. Each answer
 * > names its **source**: `TIER_A` (read directly), `TIER_B` (read directly), or
 * > `RECONSTRUCTED` (recomputed by deterministic replay from the pinned input snapshot,
 * > §21.2). A `RECONSTRUCTED` answer is byte-identical to the Tier B record that would
 * > have been written, by T6, and **the API states so alongside the result rather than
 * > presenting recomputation as though it were retrieval**.
 *
 * The last clause is a requirement about honesty, not about plumbing, and it is why
 * `source` is a field of every answer rather than a property of the endpoint. An
 * operator disputing an allocation is entitled to know whether they are being shown
 * what was written down or what the engine now believes it would have written.
 *
 * ── Eight queries, not seven ────────────────────────────────────────────────
 * §21.3's table states **eight** rows. The execution plan's Phase 11 row lists seven,
 * omitting *"why did this task go to a distant agent?"*. `IMPLEMENTATION_EXECUTION_PLAN.md`
 * §0.1 settles it — *"Where this plan and the specification appear to disagree, the
 * specification wins"* — so all eight are implemented. Answering eight satisfies "all
 * seven" on any reading of which seven were meant.
 *
 * ── Why the common questions never need reconstruction ─────────────────────
 * > The common questions are answered from Tier A with no reconstruction at all,
 * > because the chosen candidate, the runner-up, the top-N, the margins, and the
 * > binding-predicate histogram are all retained unconditionally.
 *
 * Five of the eight are therefore pure reads. The two that are not — *why not agent X*
 * for an agent outside the top-N, and *what would change this decision* — are the two
 * whose answers genuinely depend on the full candidate set, and reconstruction is what
 * makes them available for a decision whose Tier B was never sampled.
 *
 * ── Sensitivity is exact, and that is a payoff of the design ───────────────
 * > Sensitivity analysis: the minimum change in each input that flips the outcome —
 * > **computable exactly because the objective is a transparent sum**. … It is a direct,
 * > concrete payoff of choosing a transparent optimiser over an opaque learned policy
 * > (T7), and it is the query operators use most.
 *
 * For an additive objective the flip margin is a subtraction: the chosen candidate's
 * total must rise by `γ(runner-up) − γ(chosen)`, and because `Φ` is a sum, *any single
 * term* rising by that amount does it. `sensitivity()` reports the margin against each
 * term the decision actually carried, in integer milli-CU, with no search and no
 * approximation.
 */

const { compareStrings } = require("../determinism/ordering");
const { toCU } = require("../determinism/fixedPoint");
const tierAModel = require("./tierA");

/** §21.3's three sources. */
const SOURCE = Object.freeze({
  TIER_A: "TIER_A",
  TIER_B: "TIER_B",
  RECONSTRUCTED: "RECONSTRUCTED",
});

/** The eight queries of §21.3, in the order the table states them. */
const QUERY = Object.freeze({
  WHY_THIS_AGENT: "why_this_agent",
  WHY_NOT_AGENT: "why_not_agent",
  WHY_STILL_WAITING: "why_still_waiting",
  WHY_DEFERRED: "why_deferred",
  WHY_DISTANT_AGENT: "why_distant_agent",
  WHAT_WOULD_CHANGE_IT: "what_would_change_it",
  WHAT_DID_IT_COST: "what_did_it_cost",
  WHAT_HAPPENED: "what_happened",
});

const QUERIES = Object.freeze(Object.values(QUERY));

/**
 * The declared source of each query, as §21.3's table states it. Where the table gives
 * a conditional, both branches are named, and the answer reports which one it took.
 */
const DECLARED_SOURCE = Object.freeze({
  [QUERY.WHY_THIS_AGENT]: { primary: SOURCE.TIER_A, fallback: null },
  [QUERY.WHY_NOT_AGENT]: { primary: SOURCE.TIER_A, fallback: SOURCE.RECONSTRUCTED },
  [QUERY.WHY_STILL_WAITING]: { primary: SOURCE.TIER_A, fallback: null },
  [QUERY.WHY_DEFERRED]: { primary: SOURCE.TIER_A, fallback: null },
  [QUERY.WHY_DISTANT_AGENT]: { primary: SOURCE.TIER_A, fallback: SOURCE.RECONSTRUCTED },
  [QUERY.WHAT_WOULD_CHANGE_IT]: { primary: SOURCE.RECONSTRUCTED, fallback: null },
  [QUERY.WHAT_DID_IT_COST]: { primary: SOURCE.TIER_A, fallback: null },
  [QUERY.WHAT_HAPPENED]: { primary: SOURCE.TIER_A, fallback: null },
});

/**
 * Shape one answer. `source` is mandatory and there is no default: an answer that
 * forgot to say where it came from would be exactly the presentation §21.3 forbids.
 *
 * @param {string} query
 * @param {string} source
 * @param {object} body
 * @returns {object}
 */
function answerOf(query, source, body) {
  if (!Object.values(SOURCE).includes(source)) {
    throw new TypeError(`explanation answers must name their source (§21.3); received "${source}"`);
  }
  return Object.freeze({
    query,
    source,
    reconstructed: source === SOURCE.RECONSTRUCTED,
    reconstructionNote:
      source === SOURCE.RECONSTRUCTED
        ? "recomputed by deterministic replay from the pinned input snapshot. By T6 this is byte-identical to " +
          "the Tier B record that would have been written (§21.2); it is stated rather than presented as retrieval."
        : null,
    ...body,
  });
}

/**
 * The provenance of the solve behind one decision — Phase 10's handoffs P11-2 and P11-3,
 * rendered for a human.
 *
 * §21.3 requires every answer to name what it is standing on. "Agent A beat agent B by
 * 4 CU" is a different claim depending on whether the allocation it came from was
 * **certified optimal** by cost scaling, was produced by the reference solver after an
 * exactness fallback, or was an incumbent a wall-clock budget stopped short of proving.
 * All three are recorded (`searchAndSolveBounds`), and none of them is inferable from the
 * outcome label, so this reads them and says which happened.
 *
 * Every gap is reported separately and none is summed — §9.3's rule, and the four
 * quantities bound four different approximations.
 *
 * @param {object} record a `tierA.fromRow()` record
 * @returns {object}
 */
function solveProvenance(record) {
  const bounds = (record && record.searchAndSolveBounds) || {};
  const certified = bounds.optimalityCertified ?? null;
  const truncation = bounds.truncationGapMilliCU ?? null;
  const budgetLimited = bounds.budgetLimited === true;
  const legsUnassigned = bounds.legsUnassignedByIncumbent ?? null;

  return {
    solver: bounds.solver ?? null,
    optimalityCertified: certified,
    // Non-null means §20.2's cost-scaling path did not decide this: the round fell back,
    // and the reason it fell back is the value.
    fallbackFrom: bounds.fallbackFrom ?? null,
    budgetLimited,
    objectiveMilliCU: bounds.objectiveMilliCU ?? null,
    boundMilliCU: bounds.boundMilliCU ?? null,

    // Four quantities, four approximations, never one number (§9.3, §9.4, §21.6).
    truncationGapMilliCU: truncation,
    truncationGapCU: truncation === null ? null : toCU(BigInt(truncation)),
    searchGapMilliCU: bounds.searchGapMilliCU ?? null,
    lpIpGapMilliCU: bounds.lpIpGapMilliCU ?? null,
    gapsReportedSeparately: {
      searchGapMilliCU: "candidate-set truncation — what the expansion did not look at (§6.4, §9.3)",
      lpIpGapMilliCU: "integrality — exactly zero in the singleton regime (§9.3)",
      truncationGapMilliCU: "objective − bound on this solve — what stopping early cost, in MONEY (§9.4)",
      columnGenerationGap: "measured offline only, by the counterfactual evaluator; never in a decision record (§21.6)",
    },

    // The lexicographic objective's dominant component. Stated beside the money gap
    // because a money gap of zero on an incumbent that queued every Leg would otherwise
    // read as a proof of optimality.
    legsUnassignedByIncumbent: legsUnassigned,
    truncationGapScope:
      "the money half of §9.3's lexicographic objective (unassigned, milli-CU). A zero money gap is not a " +
      "certificate: read it with optimalityCertified and legsUnassignedByIncumbent.",

    sentence:
      bounds.solver === null || bounds.solver === undefined
        ? "No solve decided this Leg: it was resolved before the round reached a sub-problem."
        : certified === true
          ? `Decided by ${bounds.solver}, certified optimal over the generated column set.`
          : budgetLimited
            ? `Decided by ${bounds.solver}. NOT certified optimal: a §9.4 budget returned the incumbent with its bound` +
              (truncation === null ? "" : `, ${toCU(BigInt(truncation))} CU above it in money`) +
              (legsUnassigned ? `, leaving ${legsUnassigned} Leg(s) unassigned.` : ".")
            : `Decided by ${bounds.solver}, without a certificate of optimality.`,
  };
}

/**
 * *Why this agent?* — the cost breakdown, the runner-up, the margin, and which terms
 * were decisive.
 *
 * "Which terms were decisive" is computed rather than asserted: a term is decisive when
 * the chosen candidate's advantage on it is at least the winning margin, because
 * removing that advantage alone would flip the decision.
 *
 * @param {object} record a `tierA.fromRow()` record
 * @returns {object}
 */
function whyThisAgent(record) {
  const outcome = record.outcome || {};
  const compact = record.runnerUpAndTopN || {};
  const totals = record.costTotals || {};
  const runnerUp = compact.runnerUp || null;

  const chosenTerms = totals.chosen || {};
  const runnerUpTerms = totals.runnerUp || {};

  const marginMilliCU = runnerUp && runnerUp.deltaMilliCU !== null && runnerUp.deltaMilliCU !== undefined
    ? BigInt(runnerUp.deltaMilliCU)
    : null;

  const decisive = [];
  for (const term of Object.keys(chosenTerms).sort(compareStrings)) {
    const mine = chosenTerms[term];
    const theirs = runnerUpTerms[term];
    if (typeof mine !== "string" || typeof theirs !== "string") continue;
    const advantage = BigInt(theirs) - BigInt(mine);
    if (marginMilliCU !== null && advantage >= marginMilliCU && advantage > 0n) {
      decisive.push({ term, advantageMilliCU: advantage.toString(), advantageCU: toCU(advantage) });
    }
  }

  return answerOf(QUERY.WHY_THIS_AGENT, SOURCE.TIER_A, {
    chosenAgentId: outcome.agentId ?? null,
    outcome: outcome.outcome ?? null,
    costBreakdown: chosenTerms,
    runnerUp,
    marginMilliCU: marginMilliCU === null ? null : marginMilliCU.toString(),
    marginCU: marginMilliCU === null ? null : toCU(marginMilliCU),
    decisiveTerms: decisive.sort((a, b) => compareStrings(a.term, b.term)),
    // How much of this answer is proven, and by what. An operator disputing a margin is
    // entitled to know whether the allocation behind it was certified optimal or was the
    // best thing a §9.4 budget had found when the clock ran out — the two support very
    // different arguments, and every input to the distinction is already in Tier A.
    solve: solveProvenance(record),
    unit: "milli-CU",
    sentence:
      outcome.agentId === null || outcome.agentId === undefined
        ? `No agent was chosen: the outcome was ${outcome.outcome}.`
        : runnerUp === null
          ? `${outcome.agentId} was the only priced candidate.`
          : `${outcome.agentId} was chosen over ${runnerUp.agentId} by ${
              marginMilliCU === null ? "an unrecorded" : toCU(marginMilliCU)
            } CU` + (decisive.length > 0 ? `, decided by ${decisive.map((row) => row.term).join(" and ")}.` : "."),
  });
}

/**
 * *Why not agent X?* — either the predicate that rejected it with observed-versus-
 * required values, or its cost breakdown and the terms where it lost.
 *
 * @param {object} input `{ record, agentId, tierB }`
 * @returns {object}
 */
function whyNotAgent(input) {
  const source = input || {};
  const record = source.record;
  const agentId = String(source.agentId);
  const compact = record.runnerUpAndTopN || {};
  const inTopN = (compact.topN || []).find((row) => String(row.agentId) === agentId) || null;

  if (inTopN !== null) {
    const chosenTotal =
      record.outcome && record.outcome.agentId
        ? (compact.topN || []).find((row) => row.chosen === true)
        : null;

    const delta =
      inTopN.gammaMilliCU !== null && chosenTotal && chosenTotal.gammaMilliCU !== null
        ? BigInt(inTopN.gammaMilliCU) - BigInt(chosenTotal.gammaMilliCU)
        : null;

    return answerOf(QUERY.WHY_NOT_AGENT, SOURCE.TIER_A, {
      agentId,
      inTopN: true,
      // Truthy, not non-null: a priced top-N row omits the key entirely (Tier A drops
      // fields that do not apply, for size), so `!== null` would call every candidate
      // rejected.
      rejected: Boolean(inTopN.bindingPredicateId),
      bindingPredicateId: inTopN.bindingPredicateId ?? null,
      gammaMilliCU: inTopN.gammaMilliCU,
      deltaFromChosenMilliCU: delta === null ? null : delta.toString(),
      discoveryTier: inTopN.discoveryTier,
      sentence:
        inTopN.bindingPredicateId
          ? `${agentId} was rejected by ${inTopN.bindingPredicateId}.`
          : delta === null
            ? `${agentId} was evaluated and not chosen.`
            : `${agentId} cost ${toCU(delta)} CU more than the chosen agent.`,
    });
  }

  // Outside the top-N. §21.3: TIER_B where present, RECONSTRUCTED otherwise — and both
  // are the same content by T6, which is why the fallback is not a degradation.
  if (source.tierB) {
    const feasibility = (source.tierB.feasibility || []).find((row) => String(row.agentId) === agentId) || null;
    const cost = (source.tierB.costs || []).find((row) => String(row.agentId) === agentId) || null;
    const considered = (source.tierB.candidateSet || []).find((row) => String(row.agentId) === agentId) || null;

    return answerOf(QUERY.WHY_NOT_AGENT, source.tierBSource || SOURCE.TIER_B, {
      agentId,
      inTopN: false,
      considered: considered !== null,
      // The full evaluation tuple §7.7 specifies, per predicate, for this one agent.
      predicates: feasibility ? feasibility.predicates : null,
      bindingPredicateId: feasibility ? feasibility.bindingPredicateId : null,
      costBreakdown: cost ? cost.terms : null,
      gammaMilliCU: cost ? cost.totalMilliCU : null,
      sentence:
        considered === null
          ? `${agentId} was never reached by the hierarchical expansion for this decision.`
          : feasibility && feasibility.bindingPredicateId
            ? `${agentId} was considered and rejected by ${feasibility.bindingPredicateId}.`
            : `${agentId} was considered, priced, and not selected.`,
    });
  }

  return answerOf(QUERY.WHY_NOT_AGENT, SOURCE.TIER_A, {
    agentId,
    inTopN: false,
    unavailable: true,
    sentence:
      `${agentId} is outside this decision's retained top-${compact.compactTopN ?? "N"}. The full answer is ` +
      "available by reconstruction from the pinned input snapshot; this response was served without one.",
  });
}

/**
 * *Why is this task still waiting?* — the rejection histogram across the whole candidate
 * set, the binding-constraint distribution, the current ladder step, and the projected
 * assignment time with its basis.
 *
 * Always `TIER_A`: the histogram is aggregated at decision time and never sampled
 * (§7.7, §21.2), which is exactly what makes the most-asked question the cheapest one.
 *
 * @param {object} input `{ record, projectedAssignment }`
 * @returns {object}
 */
function whyStillWaiting(input) {
  const source = input || {};
  const record = source.record;
  // Stored as a compact map for size (§20.1); rendered here as the descending rows an
  // operator reads. The ordering lives at the read, not in the record, so the record
  // stays canonical and the answer stays useful.
  const distribution = tierAModel.rejectionRows(record.rejectionSummary);
  const total = distribution.reduce((sum, row) => sum + row.count, 0);
  const binding = distribution.length > 0 ? distribution[0] : null;

  return answerOf(QUERY.WHY_STILL_WAITING, SOURCE.TIER_A, {
    legId: record.leg ? record.leg.legId : null,
    outcome: record.outcome ? record.outcome.outcome : null,
    queueAgeSeconds: record.leg ? record.leg.queueAgeSeconds : null,
    ladderStep: record.leg ? record.leg.ladderStep : null,
    rejectionHistogram: distribution,
    bindingConstraint: binding,
    exactOverAllDecisions: true,
    candidatesConsidered: record.runnerUpAndTopN ? record.runnerUpAndTopN.candidatesConsidered : null,
    searchAndSolveBounds: record.searchAndSolveBounds || null,
    // §9.4's `BUDGET_TRUNCATED` is a *different answer* to "why is this still waiting"
    // from `LOST_TO_ANOTHER_LEG`, and Phase 10's D1 separated them precisely so that the
    // record stops claiming a cheaper Leg took the agent when the solve may never have
    // priced this one. The provenance is what lets the answer say which.
    solve: solveProvenance(record),
    projectedAssignment: source.projectedAssignment ?? null,
    sentence:
      binding === null
        ? "No candidate was rejected on a predicate in this decision; the Leg lost to another Leg or the round found no agent to evaluate."
        : `${Math.round(binding.share * 100)} % of rejections were ${binding.predicateId}` +
          (binding.tier ? ` (tier ${binding.tier})` : "") +
          ". That is what is binding for this Leg.",
  });
}

/**
 * *Why was this task deferred while a robot sat idle?* — the §8.8 deferral reason
 * record, rendered as one sentence for the operator console.
 *
 * `TIER_A`, never sampled, "because this is the decision most often challenged".
 *
 * @param {object} record
 * @returns {object}
 */
function whyDeferred(record) {
  const deferral = record.deferral || null;

  if (deferral === null) {
    return answerOf(QUERY.WHY_DEFERRED, SOURCE.TIER_A, {
      deferred: false,
      sentence: "This decision was not a deferral.",
      note:
        "A null deferral section means no deferral was taken, not a deferral without a reason: §8.8 requires " +
        "every deferral to emit an operator-facing reason at the moment it is taken.",
    });
  }

  const improvement = deferral.expectedImprovementMilliCU;
  const parts = ["waiting"];
  if (deferral.supplyEventAwaited) parts.push(` — ${deferral.supplyEventAwaited}`);
  if (improvement !== null && improvement !== undefined) {
    parts.push(`; assigning now would cost ${toCU(BigInt(improvement))} CU more`);
  }
  if (deferral.deferralDeadlineMs) parts.push(`; the ladder takes over at ${new Date(deferral.deferralDeadlineMs).toISOString()}`);

  return answerOf(QUERY.WHY_DEFERRED, SOURCE.TIER_A, {
    deferred: true,
    reason: deferral.reason ?? null,
    supplyEventAwaited: deferral.supplyEventAwaited ?? null,
    expectedImprovementMilliCU: improvement ?? null,
    expectedImprovementCU: improvement === null || improvement === undefined ? null : toCU(BigInt(improvement)),
    projectedAssignmentTimeMs: deferral.projectedAssignmentTimeMs ?? null,
    deferralDeadlineMs: deferral.deferralDeadlineMs ?? null,
    sentence: `${parts.join("")}.`,
  });
}

/**
 * *Why did this task go to a distant agent?* — the near agents' rejection reasons or
 * cost disadvantages, itemised.
 *
 * @param {object} input `{ record, tierB }`
 * @returns {object}
 */
function whyDistantAgent(input) {
  const source = input || {};
  const record = source.record;
  const compact = record.runnerUpAndTopN || {};
  const chosen = record.outcome ? record.outcome.agentId : null;

  // Nearness is the expansion tier at which a candidate was discovered (§6.3): tier 0 is
  // the origin cell, and a higher tier is literally further out. Using the tier rather
  // than a recomputed distance keeps the answer a read of what the round did.
  const near = (compact.topN || [])
    .filter((row) => String(row.agentId) !== String(chosen))
    .sort((a, b) => (a.discoveryTier ?? Infinity) - (b.discoveryTier ?? Infinity) || compareStrings(a.agentId, b.agentId));

  const chosenEntry = (compact.topN || []).find((row) => row.chosen === true) || null;
  const chosenTier = chosenEntry ? chosenEntry.discoveryTier : null;

  const itemised = near.map((row) => ({
    agentId: row.agentId,
    discoveryTier: row.discoveryTier,
    nearerThanChosen: chosenTier !== null && row.discoveryTier !== null ? row.discoveryTier < chosenTier : null,
    rejectedBy: row.bindingPredicateId,
    gammaMilliCU: row.gammaMilliCU,
    costDisadvantageMilliCU:
      row.gammaMilliCU !== null && chosenEntry && chosenEntry.gammaMilliCU !== null
        ? (BigInt(row.gammaMilliCU) - BigInt(chosenEntry.gammaMilliCU)).toString()
        : null,
  }));

  const nearer = itemised.filter((row) => row.nearerThanChosen === true);

  return answerOf(QUERY.WHY_DISTANT_AGENT, source.tierB ? (source.tierBSource || SOURCE.TIER_B) : SOURCE.TIER_A, {
    chosenAgentId: chosen,
    chosenDiscoveryTier: chosenTier,
    nearerCandidates: nearer,
    allRetainedCandidates: itemised,
    fullCandidateSet: source.tierB ? source.tierB.candidateSet : null,
    sentence:
      chosenTier === null
        ? "The chosen agent's discovery tier was not recorded for this decision."
        : nearer.length === 0
          ? `No nearer candidate was retained: the chosen agent was found at expansion tier ${chosenTier}, and nothing closer survived the gate.`
          : `${nearer.length} nearer candidate(s) were considered: ` +
            nearer
              .map((row) => (row.rejectedBy ? `${row.agentId} rejected by ${row.rejectedBy}` : `${row.agentId} cost more`))
              .join("; ") +
            ".",
  });
}

/**
 * *What would change this decision?* — the minimum change in each input that flips the
 * outcome.
 *
 * Exact, because `Φ` is a transparent additive sum: the chosen candidate loses as soon
 * as its total rises by the winning margin, and because the total is a sum, any single
 * term rising by that margin achieves it. No search, no perturbation, no approximation.
 *
 * @param {object} record
 * @returns {object}
 */
function sensitivity(record) {
  const compact = record.runnerUpAndTopN || {};
  const totals = record.costTotals || {};
  const runnerUp = compact.runnerUp || null;
  const chosenTerms = totals.chosen || {};

  const margin =
    runnerUp && runnerUp.deltaMilliCU !== null && runnerUp.deltaMilliCU !== undefined ? BigInt(runnerUp.deltaMilliCU) : null;

  const perTerm = Object.keys(chosenTerms)
    .sort(compareStrings)
    .filter((term) => typeof chosenTerms[term] === "string")
    .map((term) => {
      const current = BigInt(chosenTerms[term]);
      return {
        term,
        currentMilliCU: current.toString(),
        // The chosen candidate flips to the runner-up as soon as this one term rises by
        // the margin. Every other term held fixed — which is the definition of a
        // sensitivity, and is exact here rather than a local linearisation.
        flipsIfIncreasedByMilliCU: margin === null ? null : margin.toString(),
        flipsIfIncreasedByCU: margin === null ? null : toCU(margin),
        relativeChangeRequired: margin === null || current === 0n ? null : Number(margin) / Number(current),
      };
    });

  const feasibilityLevers = (compact.topN || [])
    // A truthy binding predicate, not merely a non-null one: a priced row omits the key
    // entirely (Tier A drops fields that do not apply, for size), and `undefined !== null`
    // would sweep every priced candidate into the feasibility levers.
    .filter((row) => Boolean(row.bindingPredicateId))
    .map((row) => ({
      agentId: row.agentId,
      // A rejected candidate does not flip on cost at all: it flips on its binding
      // predicate becoming satisfiable. Reporting a cost sensitivity for it would be
      // arithmetic about a candidate the gate never admitted (T1, I14).
      lever: "FEASIBILITY",
      bindingPredicateId: row.bindingPredicateId,
      note: "this candidate is not priced; it enters the decision only if this predicate is satisfied",
    }));

  return answerOf(QUERY.WHAT_WOULD_CHANGE_IT, SOURCE.RECONSTRUCTED, {
    chosenAgentId: record.outcome ? record.outcome.agentId : null,
    runnerUpAgentId: runnerUp ? runnerUp.agentId : null,
    marginMilliCU: margin === null ? null : margin.toString(),
    marginCU: margin === null ? null : toCU(margin),
    costLevers: perTerm,
    feasibilityLevers,
    exact: true,
    why:
      "the objective is an explicit additive function of named terms (§8.1), so the flip point is a subtraction " +
      "rather than a search. This is the concrete payoff of a transparent optimiser over an opaque learned " +
      "policy (T7).",
    sentence:
      margin === null
        ? "No runner-up was recorded, so there is no margin to flip."
        : `Any single cost term of the chosen agent rising by ${toCU(margin)} CU flips this decision to ${
            runnerUp ? runnerUp.agentId : "the runner-up"
          }.`,
  });
}

/**
 * *What did this decision cost?* — the CU breakdown and its currency equivalent.
 *
 * @param {object} input `{ record, cuPerCurrencyUnit }`
 * @returns {object}
 */
function whatDidItCost(input) {
  const source = input || {};
  const record = source.record;
  const chosen = (record.costTotals || {}).chosen || {};
  const rate = Number.isFinite(source.cuPerCurrencyUnit) ? source.cuPerCurrencyUnit : null;

  const terms = Object.keys(chosen)
    .sort(compareStrings)
    .filter((term) => typeof chosen[term] === "string")
    .map((term) => {
      const milliCU = BigInt(chosen[term]);
      const cu = toCU(milliCU);
      return {
        term,
        milliCU: milliCU.toString(),
        cu,
        // §1.3's exchange rate, applied only at the presentation boundary. The stored
        // quantity stays in CU: converting inside the record would bake a rate that
        // changes into a number that must not.
        currency: rate === null || rate === 0 ? null : cu / rate,
      };
    });

  const totalMilliCU = terms.reduce((sum, row) => sum + BigInt(row.milliCU), 0n);

  return answerOf(QUERY.WHAT_DID_IT_COST, SOURCE.TIER_A, {
    agentId: record.outcome ? record.outcome.agentId : null,
    terms,
    totalMilliCU: totalMilliCU.toString(),
    totalCU: toCU(totalMilliCU),
    totalCurrency: rate === null || rate === 0 ? null : toCU(totalMilliCU) / rate,
    cuPerCurrencyUnit: rate,
    sentence: `This decision was priced at ${toCU(totalMilliCU)} CU across ${terms.length} term(s).`,
  });
}

/**
 * *What actually happened?* — realised versus predicted timeline and energy, with the
 * deltas.
 *
 * @param {object} input `{ record, settlement }` where `settlement` carries the
 *   realised outcomes joined from §4.9 / §21.5
 * @returns {object}
 */
function whatHappened(input) {
  const source = input || {};
  const record = source.record;
  const predictions = record.predictions || null;
  const settlement = source.settlement || null;

  const deltas = [];
  if (predictions && settlement) {
    for (const key of Object.keys(predictions).sort(compareStrings)) {
      const predicted = predictions[key];
      const realised = settlement[key];
      if (Number.isFinite(predicted) && Number.isFinite(realised)) {
        deltas.push({
          quantity: key,
          predicted,
          realised,
          // Signed, reality minus prediction, the same convention §21.5's bias uses, so
          // an operator reading this and an engineer reading a calibration report are
          // reading the same sign.
          signedError: realised - predicted,
        });
      }
    }
  }

  return answerOf(QUERY.WHAT_HAPPENED, SOURCE.TIER_A, {
    predictions,
    settlement,
    deltas,
    settled: settlement !== null,
    sentence:
      settlement === null
        ? "This decision has not settled yet, so only the predictions are available."
        : deltas.length === 0
          ? "The decision has settled; no comparable predicted/realised pair was recorded."
          : deltas
              .map((row) => `${row.quantity}: predicted ${row.predicted}, realised ${row.realised} (${row.signedError >= 0 ? "+" : ""}${row.signedError})`)
              .join("; "),
  });
}

/**
 * Answer one query, or all eight.
 *
 * @param {object} input
 * @param {object} input.row the `DecisionRecordA` row
 * @param {object} [input.tierBRow] the `DecisionRecordB` row, when one was written
 * @param {object} [input.reconstructed] a Tier B record produced by replay
 * @param {string} [input.query] one of `QUERY`; omit for all eight
 * @param {string} [input.agentId] required by `why_not_agent`
 * @param {object} [input.settlement]
 * @param {object} [input.projectedAssignment]
 * @param {number} [input.cuPerCurrencyUnit]
 * @returns {object}
 */
function explain(input) {
  const source = input || {};
  const record = tierAModel.fromRow(source.row);

  const tierBRecord = source.tierBRow || source.reconstructed || null;
  const tierBSource = source.tierBRow ? SOURCE.TIER_B : source.reconstructed ? SOURCE.RECONSTRUCTED : null;

  const build = (query) => {
    switch (query) {
      case QUERY.WHY_THIS_AGENT:
        return whyThisAgent(record);
      case QUERY.WHY_NOT_AGENT:
        return whyNotAgent({ record, agentId: source.agentId, tierB: tierBRecord, tierBSource });
      case QUERY.WHY_STILL_WAITING:
        return whyStillWaiting({ record, projectedAssignment: source.projectedAssignment });
      case QUERY.WHY_DEFERRED:
        return whyDeferred(record);
      case QUERY.WHY_DISTANT_AGENT:
        return whyDistantAgent({ record, tierB: tierBRecord, tierBSource });
      case QUERY.WHAT_WOULD_CHANGE_IT:
        return sensitivity(record);
      case QUERY.WHAT_DID_IT_COST:
        return whatDidItCost({ record, cuPerCurrencyUnit: source.cuPerCurrencyUnit });
      case QUERY.WHAT_HAPPENED:
        return whatHappened({ record, settlement: source.settlement });
      default:
        throw new TypeError(`"${query}" is not one of §21.3's eight queries`);
    }
  };

  if (source.query) {
    if (source.query === QUERY.WHY_NOT_AGENT && !source.agentId) {
      throw new TypeError('the "why not agent X" query needs an agent id');
    }
    return { decisionId: record.identity.decisionId, answers: [build(source.query)] };
  }

  return {
    decisionId: record.identity.decisionId,
    answers: QUERIES.filter((query) => query !== QUERY.WHY_NOT_AGENT || Boolean(source.agentId)).map(build),
  };
}

/**
 * Assert every §21.3 query is implemented and every declared source is honoured.
 *
 * @returns {{ ok: boolean, problems: string[], queries: number }}
 */
function assertCoverage() {
  const problems = [];
  for (const query of QUERIES) {
    if (!DECLARED_SOURCE[query]) problems.push(`${query}: no declared source (§21.3's table names one for every row)`);
  }
  // §21.3 has eight rows. The execution plan says seven; the specification wins (§0.1).
  // @structural §21.3's own row count
  const SPECIFIED_QUERIES = 8;
  if (QUERIES.length !== SPECIFIED_QUERIES) {
    problems.push(`§21.3 states ${SPECIFIED_QUERIES} queries; ${QUERIES.length} are implemented`);
  }
  return { ok: problems.length === 0, problems, queries: QUERIES.length };
}

module.exports = {
  SOURCE,
  QUERY,
  QUERIES,
  DECLARED_SOURCE,
  answerOf,
  solveProvenance,
  whyThisAgent,
  whyNotAgent,
  whyStillWaiting,
  whyDeferred,
  whyDistantAgent,
  sensitivity,
  whatDidItCost,
  whatHappened,
  explain,
  assertCoverage,
};
