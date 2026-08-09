"use strict";

/**
 * Sign discipline (§8.1) — **Tier 1**.
 *
 * > **Sign discipline.** `C_direct`, `C_risk`, `C_lifecycle`, `C_delay`, and `C_churn` are
 * > non-negative by construction. `C_opportunity` and `C_policy` may be negative, and both
 * > are bounded below by configured quantities so that the pruning bound of §6.4 remains
 * > admissible. Every term therefore declares its sign and, where it can be negative, its
 * > lower bound. **A cost term whose sign is not stated cannot be safely pruned against,
 * > and this document uses pruning.**
 *
 * That last sentence is why this module is not a debugging aid. §6.4's admissible lower
 * bound is
 *
 * ```
 * LB(a,l) = (four non-negative underestimates) − Ω_terminal − Ω_policy
 * ```
 *
 * and it is admissible **only** because exactly two terms can go negative and each is
 * bounded by exactly the quantity subtracted. A third term drifting negative — a `C_risk`
 * that credits a reliable agent, a `C_delay` that rewards early arrival — would make
 * `LB > γ` for precisely the candidates the search most wants to find, and the pruning
 * would then discard the true optimum **while the decision record advertised a proof**.
 * That failure is silent by construction, so it is checked rather than reasoned about.
 *
 * ── Where it runs ──────────────────────────────────────────────────────────
 * The Phase 8 checklist says "assert declared signs and lower bounds at runtime in
 * dev/test". `check()` is therefore always evaluated — it is a comparison of two integers
 * and costs nothing — and `assertOrThrow()` is the escalation the development and test
 * environments enable. In production the finding is returned for the decision record
 * rather than thrown, because a round that refuses to price a candidate is a worse
 * operational outcome than one that prices it and reports the anomaly; the SLI is what
 * surfaces it.
 *
 * Determinism: integer comparison only. No clock, no randomness, no configuration read —
 * the bounds arrive as arguments, because the module that has the bound is the module that
 * computed it from the round's own price snapshot.
 */

const { compare } = require("../determinism/fixedPoint");

/**
 * Every term's declared sign, from §8.1. `BOUNDED_BELOW` terms name the quantity that
 * bounds them; §6.4 subtracts exactly those two and no others.
 * @structural §8.1's own sign declaration
 */
const SIGN = Object.freeze({
  NON_NEGATIVE: "NON_NEGATIVE",
  BOUNDED_BELOW: "BOUNDED_BELOW",
});

/**
 * The declaration table. A term absent from it cannot be checked, and `check()` refuses an
 * unknown term rather than passing it — an unstated sign is exactly what §8.1 prohibits.
 * @structural §8.1's own term list
 */
const DECLARATIONS = Object.freeze({
  C_direct: Object.freeze({ sign: SIGN.NON_NEGATIVE, bound: null, section: "§8.1, §8.2" }),
  C_risk: Object.freeze({ sign: SIGN.NON_NEGATIVE, bound: null, section: "§8.1, §8.4" }),
  C_lifecycle: Object.freeze({ sign: SIGN.NON_NEGATIVE, bound: null, section: "§8.1, §8.5" }),
  C_delay: Object.freeze({ sign: SIGN.NON_NEGATIVE, bound: null, section: "§8.1, §8.7" }),
  C_churn: Object.freeze({ sign: SIGN.NON_NEGATIVE, bound: null, section: "§8.1, §8.9" }),
  C_defer: Object.freeze({
    sign: SIGN.NON_NEGATIVE,
    bound: null,
    section: "§8.8",
    note:
      "§8.1's sign paragraph does not list C_defer, because deferral is an arc of the objective rather " +
      "than a term of Φ. Its three addends are each a non-negative expectation, so the arc price is " +
      "non-negative by the same construction, and §6.4's bound never prunes against it.",
  }),
  C_opportunity: Object.freeze({
    sign: SIGN.BOUNDED_BELOW,
    bound: "cost.opportunity.max_terminal_gain",
    section: "§8.1, §8.3",
    note:
      "the unavailability component is non-negative since λ_zone ≥ 0; the relocation component may be " +
      "negative, and Ω_terminal is the maximum achievable relocation gain over the search region",
  }),
  C_policy: Object.freeze({
    sign: SIGN.BOUNDED_BELOW,
    bound: "cost.policy.max_total_credit",
    section: "§8.1, §8.6",
    note: "every adjustment declares a credit ceiling, and Ω_policy is their sum, derived at publish",
  }),
});

/** The bound each `BOUNDED_BELOW` term reads out of a `bounds` argument. */
const BOUND_FIELD = Object.freeze({
  C_opportunity: "omegaTerminalMilliCU",
  C_policy: "omegaPolicyMilliCU",
});

/**
 * Check one term against its declaration.
 *
 * @param {string} term
 * @param {bigint} milliCU
 * @param {{ lowerBoundMilliCU?: bigint }} [options] the bound, for a `BOUNDED_BELOW` term.
 *   Supplied as a **non-negative magnitude**; the admissible floor is its negation, which
 *   is how §6.4 writes it (`− Ω_terminal`, `− Ω_policy`).
 * @returns {{ ok: boolean, term: string, sign: string|null, finding: string|null,
 *             lowerBoundMilliCU: bigint|null }}
 */
function check(term, milliCU, options) {
  const declaration = DECLARATIONS[term];
  if (!declaration) {
    return {
      ok: false,
      term,
      sign: null,
      lowerBoundMilliCU: null,
      finding:
        `"${term}" declares no sign. §8.1: a cost term whose sign is not stated cannot be safely ` +
        "pruned against, and this design uses pruning (§6.4). Add it to signDiscipline's declaration " +
        "table together with its bound, or it cannot enter the objective",
    };
  }

  if (typeof milliCU !== "bigint") {
    return {
      ok: false,
      term,
      sign: declaration.sign,
      lowerBoundMilliCU: null,
      finding: `${term} is not an int64 milli-CU quantity; costs are compared as integers (§9.6)`,
    };
  }

  if (declaration.sign === SIGN.NON_NEGATIVE) {
    if (compare(milliCU, 0n) < 0) {
      return {
        ok: false,
        term,
        sign: declaration.sign,
        lowerBoundMilliCU: 0n,
        finding:
          `${term} evaluated to ${milliCU} milli-CU. §8.1 declares it non-negative by construction ` +
          `(${declaration.section}). A negative value here makes §6.4's lower bound inadmissible: the ` +
          "search would prune cells that could contain the optimum while the decision record claimed a proof",
      };
    }
    return { ok: true, term, sign: declaration.sign, lowerBoundMilliCU: 0n, finding: null };
  }

  const magnitude = options && options.lowerBoundMilliCU;
  if (typeof magnitude !== "bigint") {
    return {
      ok: false,
      term,
      sign: declaration.sign,
      lowerBoundMilliCU: null,
      finding:
        `${term} may be negative and is bounded below by ${declaration.bound}, but no bound was ` +
        "supplied. An unbounded negative term cannot be pruned against (§6.4)",
    };
  }
  if (compare(magnitude, 0n) < 0) {
    return {
      ok: false,
      term,
      sign: declaration.sign,
      lowerBoundMilliCU: null,
      finding: `${declaration.bound} was supplied as ${magnitude} milli-CU; it is a non-negative magnitude`,
    };
  }

  const floor = -magnitude;
  if (compare(milliCU, floor) < 0) {
    return {
      ok: false,
      term,
      sign: declaration.sign,
      lowerBoundMilliCU: floor,
      finding:
        `${term} evaluated to ${milliCU} milli-CU, beneath its declared floor of ${floor} ` +
        `(− ${declaration.bound}). §6.4 subtracts exactly that quantity to keep the pruning bound ` +
        "admissible, so a value below it invalidates the bound for this round",
    };
  }

  return { ok: true, term, sign: declaration.sign, lowerBoundMilliCU: floor, finding: null };
}

/**
 * Check every term of a `Φ` breakdown.
 *
 * @param {Record<string, bigint>} terms
 * @param {{ omegaTerminalMilliCU?: bigint, omegaPolicyMilliCU?: bigint }} [bounds]
 * @returns {{ ok: boolean, results: object[], findings: string[] }}
 */
function checkBreakdown(terms, bounds) {
  const results = [];
  const findings = [];

  // Sorted so the report is identical across runs; the verdict does not depend on order.
  for (const term of Object.keys(terms || {}).sort()) {
    const field = BOUND_FIELD[term];
    const result = check(
      term,
      terms[term],
      field ? { lowerBoundMilliCU: bounds && bounds[field] } : undefined,
    );
    results.push(result);
    if (!result.ok) findings.push(result.finding);
  }

  return { ok: findings.length === 0, results, findings };
}

/**
 * The escalation for development and test: a violation throws.
 *
 * @param {string} term
 * @param {bigint} milliCU
 * @param {object} [options]
 * @returns {bigint} the value, unchanged
 * @throws {RangeError}
 */
function assertOrThrow(term, milliCU, options) {
  const result = check(term, milliCU, options);
  if (!result.ok) throw new RangeError(result.finding);
  return milliCU;
}

/**
 * The two terms §6.4's bound must subtract, derived from this table rather than restated.
 *
 * Phase 9 builds `candidates/lowerBound.js` and will read this: the set of terms it must
 * correct for is a property of the sign declarations, not a second list that could fall
 * out of step with them. That is the same mechanism §8.6 uses for `Ω_policy` — the bound
 * updates as a mechanical consequence of the register changing.
 *
 * @returns {Array<{ term: string, bound: string }>}
 */
function boundedBelowTerms() {
  return Object.keys(DECLARATIONS)
    .filter((term) => DECLARATIONS[term].sign === SIGN.BOUNDED_BELOW)
    .sort()
    .map((term) => ({ term, bound: DECLARATIONS[term].bound }));
}

module.exports = {
  SIGN,
  DECLARATIONS,
  BOUND_FIELD,
  check,
  checkBreakdown,
  assertOrThrow,
  boundedBelowTerms,
};
