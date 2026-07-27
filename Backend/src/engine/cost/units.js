"use strict";

/**
 * The canonical cost unit (§1.3).
 *
 * > **Decision: all cost terms MUST be expressed in a single absolute, physically
 * > meaningful, additive unit. Relative (min-max, rank, or z-score) normalisation of
 * > cost terms is prohibited.**
 *
 * > **1 CU ≡ the fully-loaded operating cost of one second of committed time of a
 * > reference agent class**, where the reference class and its cost are configuration
 * > (`cost.reference_agent_class`, `cost.cu_per_currency_unit`).
 *
 * Five capabilities depend on absolute units, and all five are unreachable under
 * relative normalisation — which is why this is a unit module and not a formatting
 * helper:
 *
 *   1. **Deferral.** Comparing "assign now at 4 100 CU" against "expected cost of
 *      waiting one round, 900 CU" requires both on the same absolute scale. Under
 *      min-max the best candidate always scores exactly 0 however bad it is.
 *   2. **Cross-task comparison.** Batch optimisation sums costs across assignments;
 *      sums of per-task-rescaled quantities are meaningless.
 *   3. **Heterogeneous fleets.** A drone-second and a ground-robot-second differ in
 *      cost. Absolute units make them comparable.
 *   4. **Scale-invariance defects.** Under min-max, a 5 m versus 10 m spread and a
 *      5 km versus 400 km spread both produce (0, 1).
 *   5. **Sensible degenerate behaviour.** With one candidate, min-max yields 0.5 for
 *      every relative term, so the terms silently vanish — and one candidate is the
 *      common case in a sparse fleet.
 *
 * The baseline's `C(r) = w1·D + w2·(1−B) + w3·U + w4·T + w5·Z` with weights summing
 * to 1 has every one of these defects. Its weights are not convertible into this
 * model; they can only be re-derived from accounting figures (§22.4).
 *
 * Every value here is carried as int64 milli-CU (`determinism/fixedPoint.js`). A
 * quantity that leaves this module for arithmetic leaves as a `BigInt`.
 */

const { toMilliCU, toCU, add, sum, negate, compare, format } = require("../determinism/fixedPoint");

/**
 * The definition, verbatim, so a decision record and an operator explanation can
 * quote the same sentence the specification does.
 */
const CU_DEFINITION =
  "1 CU ≡ the fully-loaded operating cost of one second of committed time of a reference agent class " +
  "(cost.reference_agent_class), converted to money by the single configured rate cost.cu_per_currency_unit.";

/**
 * The dimensions the engine recognises. A "weight" in this engine is never a
 * dimensionless tuning knob; it is a priced exchange rate traceable to an accounting
 * figure, and its dimension says which quantity it prices.
 */
const DIMENSION = Object.freeze({
  /** An absolute cost. */
  CU: "CU",
  /** Value of time — `cost.lambda_time`, `cost.sla.cu_per_second_late`. */
  CU_PER_SECOND: "CU·s⁻¹",
  /** Value of energy — `cost.energy.cu_per_wh`. */
  CU_PER_WH: "CU·Wh⁻¹",
  /** Value of distance-proportional wear — `cost.wear.cu_per_metre`. */
  CU_PER_METRE: "CU·m⁻¹",
  /** The single money conversion — `cost.cu_per_currency_unit`. */
  CU_PER_CURRENCY: "CU·currency⁻¹",
  /**
   * A shaping factor on an already-priced quantity — `cost.sla.lateness_exponent`,
   * `cost.aging.max_multiplier`. Permitted only where the specification names one;
   * a dimensionless weight *introduced* on a priced quantity would be an
   * unregistered second exchange rate, which §1.3 prohibits.
   */
  DIMENSIONLESS: "dimensionless",
});

const ALL_DIMENSIONS = Object.freeze(Object.values(DIMENSION));

/**
 * The normalisations §1.3 prohibits, named so an error message can say which one was
 * attempted rather than "invalid cost".
 */
const PROHIBITED_NORMALISATIONS = Object.freeze(["min-max", "rank", "z-score"]);

/**
 * Construct a cost in CU.
 *
 * @param {number} value cost in CU
 * @returns {{ milliCU: bigint, dimension: string }}
 */
function cu(value) {
  return Object.freeze({ milliCU: toMilliCU(value), dimension: DIMENSION.CU });
}

/**
 * Construct a cost already expressed in milli-CU.
 *
 * @param {bigint} milliCU
 * @returns {{ milliCU: bigint, dimension: string }}
 */
function milli(milliCU) {
  return Object.freeze({ milliCU, dimension: DIMENSION.CU });
}

/**
 * The additive identity. Every cost term sums into this.
 */
const ZERO = Object.freeze({ milliCU: 0n, dimension: DIMENSION.CU });

/**
 * Assert that a value is a CU-dimensioned cost.
 *
 * @param {*} value
 * @param {string} [site]
 * @returns {{ milliCU: bigint, dimension: string }}
 */
function assertCost(value, site) {
  if (!value || typeof value !== "object" || typeof value.milliCU !== "bigint") {
    throw new TypeError(
      `${site ? `${site}: ` : ""}expected a CU-dimensioned cost in milli-CU, received ` +
        `${JSON.stringify(value)} (§1.3, §9.6)`,
    );
  }
  if (value.dimension !== DIMENSION.CU) {
    throw new TypeError(
      `${site ? `${site}: ` : ""}expected dimension ${DIMENSION.CU}, received "${value.dimension}". ` +
        "Every term in the objective is converted into CU by an exchange rate with explicit " +
        "dimensions before it is summed (§1.3).",
    );
  }
  return value;
}

/**
 * Add costs. Additive by construction, in exact integer arithmetic, so the total does
 * not depend on the order of the terms (§9.6 requirement 1).
 *
 * @param {...{ milliCU: bigint, dimension: string }} costs
 * @returns {{ milliCU: bigint, dimension: string }}
 */
function total(...costs) {
  for (const value of costs) assertCost(value, "units.total");
  return milli(sum(costs.map((value) => value.milliCU)));
}

/**
 * The currency view §1.3 requires the engine to maintain alongside every cost:
 * "Operators and finance reason in money; engineers reason in CU; the conversion is a
 * single configured rate. Decision records carry both."
 *
 * @param {{ milliCU: bigint, dimension: string }} cost
 * @param {number} cuPerCurrencyUnit `cost.cu_per_currency_unit`, in CU·currency⁻¹
 * @returns {number} the cost in currency units
 */
function toCurrency(cost, cuPerCurrencyUnit) {
  assertCost(cost, "units.toCurrency");
  if (typeof cuPerCurrencyUnit !== "number" || !Number.isFinite(cuPerCurrencyUnit) || cuPerCurrencyUnit <= 0) {
    throw new TypeError(
      `cost.cu_per_currency_unit must be a positive finite rate in ${DIMENSION.CU_PER_CURRENCY}; ` +
        `received ${JSON.stringify(cuPerCurrencyUnit)} (§1.3)`,
    );
  }
  return toCU(cost.milliCU) / cuPerCurrencyUnit;
}

/**
 * Both views of a cost, for a decision record.
 *
 * @param {{ milliCU: bigint, dimension: string }} cost
 * @param {number} cuPerCurrencyUnit
 * @returns {{ milliCU: string, cu: number, currency: number, dimension: string }}
 */
function views(cost, cuPerCurrencyUnit) {
  assertCost(cost, "units.views");
  return {
    milliCU: cost.milliCU.toString(),
    cu: toCU(cost.milliCU),
    currency: toCurrency(cost, cuPerCurrencyUnit),
    dimension: cost.dimension,
  };
}

/**
 * Refuse a normalised cost vector.
 *
 * Relative normalisation is prohibited outright (§1.3), so there is no code path that
 * performs one. This exists as the explicit failure a future contributor meets if
 * they reintroduce the baseline's `costEvaluator.service.js` habit of rescaling each
 * candidate set into [0, 1] before weighting.
 *
 * @param {string} kind one of PROHIBITED_NORMALISATIONS
 * @param {string} [site]
 * @throws {Error} always
 */
function refuseNormalisation(kind, site) {
  throw new Error(
    `${site ? `${site}: ` : ""}${kind} normalisation of cost terms is prohibited (§1.3). ` +
      "Under it, deferral, cross-task comparison, heterogeneous fleets, scale sensitivity, and " +
      "single-candidate behaviour are all unreachable. Price the term in CU with a dimensioned " +
      "exchange rate instead.",
  );
}

module.exports = {
  CU_DEFINITION,
  DIMENSION,
  ALL_DIMENSIONS,
  PROHIBITED_NORMALISATIONS,
  ZERO,
  cu,
  milli,
  assertCost,
  total,
  toCurrency,
  views,
  refuseNormalisation,
  // Re-exported so a cost module never reaches around units.js into the raw arithmetic.
  add,
  negate,
  compare,
  format,
};
