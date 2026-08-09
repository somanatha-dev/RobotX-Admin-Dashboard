"use strict";

/**
 * The column and its price (§1.4, §9.3, §13.3) — **Tier 1**, decision path.
 *
 * > ```
 * > γ(c) = Φ( plan₀(a) ⊕ L(c) ) − Φ( plan₀(a) ) + C_churn(c)
 * > ```
 *
 * > Because `Φ` sums `C_delay` over **every** Leg in the plan (§8.1), this difference
 * > automatically charges the column for the delay it imposes on the agent's
 * > already-committed Legs, the extra energy and wear, and the altered terminal state.
 * > **There is no separate insertion-cost model that could drift out of agreement with the
 * > cost model.**
 *
 * `price()` is therefore three lines of arithmetic over two `Φ` evaluations, and that is
 * the point: the marginal cost of insertion is not an auxiliary heuristic bolted onto the
 * objective — **it is the price of a column**, and it is computed by evaluating the one
 * cost functional at two plans.
 *
 * ── Exactness in integer milli-CU ──────────────────────────────────────────
 * §8's testing requirement is that "`γ(c)` recomputed from `Φ(plan(c)) − Φ(plan₀)` equals
 * the value given to the solver, **exactly**, in integer milli-CU". Two properties deliver
 * that, and both are structural rather than incidental:
 *
 *   - The difference is taken on `BigInt` milli-CU, so it is exact — no rounding happens
 *     here at all, and the subtraction of two exactly-representable integers is itself
 *     exact.
 *   - `recompute()` exists so a verifier can re-derive `γ` from the two stored `Φ` values
 *     in a decision record and compare byte-for-byte with what the solver was handed.
 *
 * A float pipeline would make the first property depend on the order the terms were summed
 * in, which §9.6 requirement 1 identifies as the reason the whole engine is integer.
 *
 * ── Queue depth is a property of the plan, not an arc capacity ─────────────
 * > **This is where queue depth is enforced.** A column is admissible only if
 * > `plan₀(a) ⊕ L(c)` holds no more than `capacity[agent_class]` concurrent commitments
 * > (F17) and extends no further than `plan.commitment_horizon` into the future. Queue
 * > depth is therefore a **feasibility property of a plan**, not an arc capacity in the
 * > solver — which is precisely what makes `capacity > 1` expressible without breaking the
 * > separability the solve depends on (§9.3).
 *
 * `assertQueueDepthIsPlanFeasibility()` checks that the column's plan carries the two
 * fields F17 reads, and this module exposes **no** capacity field of its own for a solver
 * to consume. §9.3 explains what the alternative would cost:
 *
 * > A flow network with `capacity[a] = k > 1` and one arc per pairing would … compute an
 * > objective value that is not the cost of the allocation it selects, and no amount of
 * > solver quality repairs that: the model would be exactly solving the wrong problem.
 *
 * ── How the Tier 2 churn term reaches a Tier 1 price ───────────────────────
 * `C_churn` is Tier 2 (T2-07, kill switch `churn_pricing`) and this module is Tier 1, so
 * the evaluator arrives through `cost/phi.js`'s registration surface. With nothing
 * registered the price is `Φ(plan(c)) − Φ(plan₀)` and the omission is recorded — which is
 * §22.5 rule 1's "degrades to a complete, tested Tier 1 behaviour", not a silent zero.
 *
 * Determinism: the column's identity is `(agent_id, sorted leg_id list, insertion position
 * vector)` from `determinism/ordering.js`, which is unique and independent of the order the
 * Column Builder generated it in (§9.6 requirement 2).
 */

const phi = require("../cost/phi");
const { columnIdentity, compareStrings } = require("../determinism/ordering");
const { subtract, add, compare } = require("../determinism/fixedPoint");

/** @structural milliseconds in one second */
const MS_PER_SECOND = 1000;

/**
 * @param {*} value
 * @returns {boolean}
 */
function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Build a column: an agent, the Legs it would cover, and the plan that covers them.
 *
 * @param {object} input
 * @param {string} input.agentId
 * @param {string[]} input.legIds the Legs this column covers
 * @param {number[]} [input.insertionPositions] where each Leg's stops were inserted
 * @param {object} input.plan the candidate plan `plan₀(a) ⊕ L(c)`
 * @param {object} input.basePlan `plan₀(a)`, or null for an idle agent
 * @returns {object} a frozen column
 */
function make(input) {
  const source = input || {};
  const column = {
    agentId: String(source.agentId),
    legIds: [...(source.legIds || [])].map(String).sort(compareStrings),
    insertionPositions: [...(source.insertionPositions || [])],
    plan: source.plan,
    basePlan: source.basePlan ?? null,
  };
  column.identity = columnIdentity(column);
  // §9.3's regime is a property of the generated column set: a column covering one Leg is
  // a singleton column, and a round whose columns are all singletons is solved by a
  // min-cost flow that is integral and exact.
  column.singleton = column.legIds.length === 1;
  return Object.freeze(column);
}

/**
 * §13.3's admissibility rule, checked as a property of the plan.
 *
 * @param {object} plan
 * @param {object} limits `{ capacity, commitmentHorizonSeconds, decisionTimeMs }`
 * @returns {{ ok: boolean, problems: string[], observed: object }}
 */
function assertQueueDepthIsPlanFeasibility(plan, limits) {
  const source = limits || {};
  const problems = [];

  const concurrent = plan && plan.concurrentCommitments;
  const horizonEndMs = plan && (plan.horizonEndMs !== undefined ? plan.horizonEndMs : plan.projectedEndMs);

  if (!isNumber(concurrent)) {
    problems.push(
      "the plan does not state its concurrent-commitment count. F17 is evaluated as a property of the " +
        "plan (§13.3); a column that cannot state it cannot be checked against capacity without " +
        "reaching for the agent's live state, which would couple this candidate to the solver's other " +
        "provisional choices (§9.3)",
    );
  }
  if (!isNumber(horizonEndMs)) {
    problems.push("the plan does not state its furthest extent, so the commitment horizon cannot be checked");
  }

  if (isNumber(concurrent) && isNumber(source.capacity) && concurrent > source.capacity) {
    problems.push(`the plan holds ${concurrent} concurrent commitments against a capacity of ${source.capacity} (F17)`);
  }
  if (isNumber(horizonEndMs) && isNumber(source.commitmentHorizonSeconds) && isNumber(source.decisionTimeMs)) {
    const extentSeconds = (horizonEndMs - source.decisionTimeMs) / MS_PER_SECOND;
    if (extentSeconds > source.commitmentHorizonSeconds) {
      problems.push(
        `the plan extends ${extentSeconds} s ahead, beyond the ${source.commitmentHorizonSeconds} s ` +
          "commitment horizon (F17, §13.3)",
      );
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    observed: {
      concurrentCommitments: isNumber(concurrent) ? concurrent : null,
      horizonEndMs: isNumber(horizonEndMs) ? horizonEndMs : null,
      capacity: isNumber(source.capacity) ? source.capacity : null,
      commitmentHorizonSeconds: isNumber(source.commitmentHorizonSeconds) ? source.commitmentHorizonSeconds : null,
    },
  };
}

/**
 * `γ(c) = Φ(plan(c)) − Φ(plan₀) + C_churn(c)`.
 *
 * @param {object} column from `make()`
 * @param {object} input
 * @param {object} input.candidatePhi arguments for `phi.evaluate()` on `plan(c)`
 * @param {object} [input.basePhi] arguments for `phi.evaluate()` on `plan₀`; omit for an
 *   idle agent, where `Φ(∅) = 0` exactly
 * @param {object} [input.churn] arguments for a registered `C_churn` evaluator
 * @param {object} [input.limits] as `assertQueueDepthIsPlanFeasibility`
 * @returns {{ ok: boolean, gammaMilliCU: bigint|null, breakdown: object|null,
 *             omittedTerms: object[], missing: string[], problems: string[] }}
 */
function price(column, input) {
  const source = input || {};
  const problems = [];
  const omittedTerms = [];

  const admissible = assertQueueDepthIsPlanFeasibility(column.plan, source.limits);
  if (!admissible.ok) {
    return {
      ok: false,
      gammaMilliCU: null,
      breakdown: null,
      omittedTerms,
      missing: [],
      problems: admissible.problems,
    };
  }

  const candidate = phi.evaluate(column.plan, source.candidatePhi);
  if (!candidate.ok) {
    return {
      ok: false,
      gammaMilliCU: null,
      breakdown: null,
      omittedTerms,
      missing: candidate.missing.map((name) => `Φ(plan(c)): ${name}`),
      problems: candidate.problems || [],
    };
  }
  problems.push(...(candidate.problems || []));
  omittedTerms.push(...(candidate.omittedTerms || []));

  // §8.1's degenerate case: for an idle agent, plan₀ is empty and Φ(∅) = 0 exactly, so
  // γ = Φ(plan with l) = Cost(a,l). Handled by the same arithmetic rather than by a branch
  // that could drift from it.
  let base;
  if (column.basePlan) {
    base = phi.evaluate(column.basePlan, source.basePhi);
    if (!base.ok) {
      return {
        ok: false,
        gammaMilliCU: null,
        breakdown: null,
        omittedTerms,
        missing: base.missing.map((name) => `Φ(plan₀): ${name}`),
        problems,
      };
    }
    problems.push(...(base.problems || []));
  } else {
    base = phi.empty();
  }

  // Exact, in integers. No rounding occurs at this subtraction, which is what makes
  // `recompute()` able to reproduce the solver's value byte-for-byte.
  const difference = subtract(candidate.milliCU, base.milliCU);

  let churnMilliCU = 0n;
  let churnBreakdown = null;
  const churnEvaluator = phi.evaluatorFor("C_churn");

  if (churnEvaluator) {
    const churn = churnEvaluator(source.churn);
    if (!churn || !churn.ok || typeof churn.milliCU !== "bigint") {
      return {
        ok: false,
        gammaMilliCU: null,
        breakdown: null,
        omittedTerms,
        missing: (churn && (churn.missing || churn.problems)) || ["C_churn"],
        problems,
      };
    }
    churnMilliCU = churn.milliCU;
    churnBreakdown = churn.breakdown || null;
  } else {
    omittedTerms.push({
      term: "C_churn",
      killSwitch: phi.REGISTRABLE_TERMS.C_churn.killSwitch,
      degradesTo: phi.REGISTRABLE_TERMS.C_churn.degradesTo,
      note:
        "no evaluator is registered, so the column price carries no hysteresis term. Revision is then " +
        "bounded by §4.7's protocol and F20's incumbent cooloff alone, not by price.",
    });
  }

  const gammaMilliCU = add(difference, churnMilliCU);

  return {
    ok: true,
    gammaMilliCU,
    breakdown: Object.freeze({
      identity: column.identity,
      agentId: column.agentId,
      legIds: column.legIds,
      singleton: column.singleton,
      phiCandidateMilliCU: candidate.milliCU,
      phiBaseMilliCU: base.milliCU,
      differenceMilliCU: difference,
      churnMilliCU,
      churn: churnBreakdown,
      gammaMilliCU,
      candidateTerms: candidate.breakdown ? candidate.breakdown.terms : null,
      baseTerms: base.breakdown ? base.breakdown.terms : null,
      queueDepth: admissible.observed,
    }),
    omittedTerms,
    missing: [],
    problems,
  };
}

/**
 * Re-derive `γ` from two stored `Φ` values and a churn value, and compare with what the
 * solver was given.
 *
 * §8's consistency requirement, as a function a verifier can call against a decision
 * record. Exact equality in integer milli-CU is the assertion; a tolerance would defeat the
 * purpose, because the whole reason the pipeline is integer is that exact equality is
 * achievable.
 *
 * @param {object} input `{ phiCandidateMilliCU, phiBaseMilliCU, churnMilliCU, solverGammaMilliCU }`
 * @returns {{ ok: boolean, recomputedMilliCU: bigint|null, deltaMilliCU: bigint|null,
 *             reason: string|null }}
 */
function recompute(input) {
  const source = input || {};
  const fields = ["phiCandidateMilliCU", "phiBaseMilliCU", "churnMilliCU", "solverGammaMilliCU"];
  for (const field of fields) {
    if (typeof source[field] !== "bigint") {
      return {
        ok: false,
        recomputedMilliCU: null,
        deltaMilliCU: null,
        reason: `${field} is not an int64 milli-CU quantity; γ is recomputed in integers or not at all (§9.6)`,
      };
    }
  }

  const recomputed = add(subtract(source.phiCandidateMilliCU, source.phiBaseMilliCU), source.churnMilliCU);
  const delta = subtract(recomputed, source.solverGammaMilliCU);

  return {
    ok: compare(recomputed, source.solverGammaMilliCU) === 0,
    recomputedMilliCU: recomputed,
    deltaMilliCU: delta,
    reason:
      compare(recomputed, source.solverGammaMilliCU) === 0
        ? null
        : `γ recomputed from Φ is ${recomputed} milli-CU but the solver was given ` +
          `${source.solverGammaMilliCU}, a difference of ${delta}. The two must agree exactly: a solver ` +
          "optimising a value the cost model cannot reproduce is optimising a different objective",
  };
}

module.exports = {
  MS_PER_SECOND,
  make,
  assertQueueDepthIsPlanFeasibility,
  price,
  recompute,
};
