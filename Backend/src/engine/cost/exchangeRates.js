"use strict";

/**
 * Dimensioned exchange rates (§1.3, §8.10).
 *
 * > Every term in the objective is converted into CU by an **exchange rate with
 * > explicit dimensions** — for example `cost.energy.cu_per_wh` (CU·Wh⁻¹),
 * > `cost.wear.cu_per_metre` (CU·m⁻¹), `cost.sla.cu_per_second_late[class]`
 * > (CU·s⁻¹). A "weight" in this engine is never a dimensionless tuning knob; it is a
 * > priced exchange rate traceable to an accounting figure. This is the mechanism by
 * > which the design satisfies "no magic constants": a constant with a unit, an
 * > owner, a valid range, and a derivation is not magic.
 *
 * Two properties this module enforces, both of which the baseline lacked:
 *
 *   - **A rate cannot be applied to the wrong quantity.** `apply()` checks that the
 *     rate's denominator dimension matches the quantity's, so pricing metres with
 *     `cu_per_wh` is a type error rather than a plausible-looking number.
 *   - **A dimensionless coefficient cannot be introduced on a priced quantity.**
 *     §8.10 states it for the case that motivated the rule: "**`V_terminal` has no
 *     weighting coefficients** and therefore no register entries. Its three
 *     components are each already denominated in CU and are summed directly. A
 *     dimensionless weight on an already-priced quantity would be an unregistered
 *     second exchange rate, which §1.3 prohibits."
 *
 * Rates are constructed from the Config Service, never from literals: a rate that is
 * not in the parameter register fails the build (`tools/gates/checkParameterRegister.js`).
 */

const { DIMENSION } = require("./units");
const { milli, assertCost } = require("./units");
const { scaleByRate, toMilliCU } = require("../determinism/fixedPoint");

/**
 * The quantity each rate dimension prices, i.e. its denominator.
 */
const RATE_DENOMINATOR = Object.freeze({
  [DIMENSION.CU_PER_SECOND]: "s",
  [DIMENSION.CU_PER_WH]: "Wh",
  [DIMENSION.CU_PER_METRE]: "m",
  [DIMENSION.CU_PER_CURRENCY]: "currency",
});

/**
 * The register entries that are exchange rates, and the dimension each must carry.
 * The Config Service's unit string is checked against this table at construction, so
 * a register entry whose unit is edited to something incompatible fails loudly rather
 * than pricing the wrong quantity.
 */
const RATE_DIMENSIONS = Object.freeze({
  "cost.cu_per_currency_unit": DIMENSION.CU_PER_CURRENCY,
  "cost.lambda_time": DIMENSION.CU_PER_SECOND,
  "cost.lambda_time_floor": DIMENSION.CU_PER_SECOND,
  "cost.energy.cu_per_wh": DIMENSION.CU_PER_WH,
  "cost.wear.cu_per_metre": DIMENSION.CU_PER_METRE,
  "cost.sla.cu_per_second_late": DIMENSION.CU_PER_SECOND,
  "cost.staleness.cu_per_second_age": DIMENSION.CU_PER_SECOND,
  "churn.per_second_elapsed": DIMENSION.CU_PER_SECOND,
  "cost.opportunity.lambda_zone_prior": DIMENSION.CU_PER_SECOND,
  // Phase 8. §8.9's C_churn formula names `churn.wasted_travel_cost ·
  // distance_already_travelled` and §8.5's C_lifecycle names gradient exposure and
  // thermal stress as addends with their own coefficients; §8.10's table registers
  // neither, so the register entries are supplementary and their dimensions are declared
  // here for the same reason every other rate's is — a rate applied to the wrong quantity
  // produces a plausible-looking wrong number.
  "churn.wasted_travel_cost": DIMENSION.CU_PER_METRE,
  "lifecycle.cu_per_gradient_metre": DIMENSION.CU_PER_METRE,
  "lifecycle.cu_per_thermal_stress_second": DIMENSION.CU_PER_SECOND,
});

/**
 * Register entries that are absolute CU amounts rather than rates. Listed so that
 * "is this a rate or a price?" is answered by data, not by reading the name.
 */
const ABSOLUTE_CU_PARAMETERS = Object.freeze([
  "cost.battery.cu_per_equivalent_cycle",
  "cost.failure.cu",
  "cost.energy_consequence",
  "cost.sla.breach_penalty",
  "cost.uncertainty_penalty",
  "churn.base_cost",
  "candidate.optimality_tolerance_cu",
  "cost.policy.max_total_credit",
  "cost.opportunity.max_terminal_gain",
  "policy.max_zone_affinity_credit",
  "policy.max_dedicated_fleet_credit",
  "policy.max_burn_in_credit",
  "policy.max_pilot_adjustment",
  "policy.max_operator_adjustment",
  "fairness.weight",
  "preempt.min_gain",
  "solve.max_generation_gap_regression",
  // Phase 8. Each is a CU amount multiplied by a count — an actuation, a braking event,
  // a notification, a wasted round — exactly as §8.10 registers
  // `cost.battery.cu_per_equivalent_cycle` as a CU amount multiplied by a cycle count.
  "lifecycle.cu_per_actuator_cycle",
  "lifecycle.cu_per_braking_event",
  "churn.notification_cost",
  "defer.wasted_round_penalty",
]);

/**
 * Construct an exchange rate from a resolved register value.
 *
 * @param {string} name register parameter name
 * @param {number} value the resolved value
 * @param {{ unit?: string, configVersion?: *, level?: string }} [provenance] what the
 *   Config Service said about it — carried so a decision record can cite the rate's
 *   source scope, not merely its number (§21.2, §22.2)
 * @returns {{ name: string, value: number, dimension: string, denominator: string,
 *             provenance: object }}
 */
function makeRate(name, value, provenance) {
  const dimension = RATE_DIMENSIONS[name];
  if (!dimension) {
    throw new Error(
      `"${name}" is not a registered exchange rate. Every conversion into CU uses a rate with ` +
        "explicit dimensions drawn from the parameter register (§1.3, §8.10).",
    );
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(
      `exchange rate "${name}" resolved to ${JSON.stringify(value)}. An unset rate cannot be used to ` +
        "price anything; the Config Service must supply it (§22.1 rule 5).",
    );
  }
  if (value < 0) {
    throw new RangeError(`exchange rate "${name}" is negative (${value}); a price is not negative (§8.10)`);
  }
  const declaredUnit = provenance && provenance.unit;
  if (declaredUnit && declaredUnit !== dimension) {
    throw new TypeError(
      `exchange rate "${name}" is registered with unit "${declaredUnit}" but this engine prices it ` +
        `as "${dimension}". A rate applied to the wrong quantity produces a plausible-looking wrong ` +
        "number, which is the failure mode explicit dimensions exist to prevent (§1.3).",
    );
  }

  return Object.freeze({
    name,
    value,
    dimension,
    denominator: RATE_DENOMINATOR[dimension],
    provenance: Object.freeze({ ...(provenance || {}) }),
  });
}

/**
 * Apply a rate to a physical quantity, yielding a CU cost in milli-CU.
 *
 * @param {object} rate from `makeRate`
 * @param {number} quantity the physical amount
 * @param {string} quantityUnit the amount's unit — checked against the rate's denominator
 * @returns {{ milliCU: bigint, dimension: string }}
 */
function apply(rate, quantity, quantityUnit) {
  if (!rate || typeof rate.value !== "number" || !rate.denominator) {
    throw new TypeError("apply() requires an exchange rate built by makeRate() (§1.3)");
  }
  if (quantityUnit !== rate.denominator) {
    throw new TypeError(
      `exchange rate "${rate.name}" prices ${rate.denominator}, not ${quantityUnit}. ` +
        "Pricing the wrong quantity is a type error here, not a plausible number (§1.3).",
    );
  }
  if (typeof quantity !== "number" || !Number.isFinite(quantity)) {
    throw new TypeError(`apply("${rate.name}") received a non-finite quantity ${JSON.stringify(quantity)}`);
  }
  return milli(toMilliCU(quantity * rate.value));
}

/**
 * The only dimensionless factors permitted on a priced quantity (§8.7, §8.10).
 */
const DIMENSIONLESS_FACTORS = Object.freeze([
  "cost.sla.lateness_exponent",
  "cost.sla.upstream_slack_weight",
  "cost.aging.growth_exponent",
  "cost.aging.max_multiplier",
]);

/**
 * Apply a **dimensionless** shaping factor to an already-priced cost.
 *
 * Permitted only for the factors the specification itself names as dimensionless —
 * `cost.sla.lateness_exponent`, `cost.aging.max_multiplier`,
 * `cost.sla.upstream_slack_weight`. Anything else is an unregistered second exchange
 * rate, which §1.3 prohibits, so the factor's register entry is checked.
 *
 * @param {{ milliCU: bigint, dimension: string }} cost
 * @param {number} factor
 * @param {string} factorName register parameter name
 * @returns {{ milliCU: bigint, dimension: string }}
 */
function applyDimensionlessFactor(cost, factor, factorName) {
  assertCost(cost, "exchangeRates.applyDimensionlessFactor");
  if (!DIMENSIONLESS_FACTORS.includes(factorName)) {
    throw new Error(
      `"${factorName}" is not one of the dimensionless factors the specification names ` +
        `(${DIMENSIONLESS_FACTORS.join(", ")}). A dimensionless weight on an already-priced quantity ` +
        "would be an unregistered second exchange rate, which §1.3 prohibits — as §8.10 states for " +
        "V_terminal, whose three components are each already in CU and are summed directly.",
    );
  }
  if (typeof factor !== "number" || !Number.isFinite(factor)) {
    throw new TypeError(`dimensionless factor "${factorName}" is ${JSON.stringify(factor)}; it must be finite`);
  }
  return milli(scaleByRate(cost.milliCU, factor));
}

/**
 * Build every exchange rate a cost evaluation needs from a config snapshot.
 *
 * @param {{ explain: (name: string, context?: object, options?: object) => object }} snapshot
 * @param {object} [context] scope context
 * @param {{ agentClass?: string }} [index]
 * @returns {Record<string, object>} rate name → rate
 */
function ratesFrom(snapshot, context, index) {
  const rates = {};
  for (const name of Object.keys(RATE_DIMENSIONS)) {
    const explained = snapshot.explain(name, context, index && index[name] ? { index: index[name] } : undefined);
    if (explained.value === null || explained.value === undefined) continue;
    rates[name] = makeRate(name, explained.value, {
      unit: explained.unit,
      configVersion: explained.configVersion,
      level: explained.level,
      calibrationStatus: explained.calibrationStatus,
    });
  }
  return rates;
}

module.exports = {
  RATE_DENOMINATOR,
  RATE_DIMENSIONS,
  ABSOLUTE_CU_PARAMETERS,
  DIMENSIONLESS_FACTORS,
  makeRate,
  apply,
  applyDimensionlessFactor,
  ratesFrom,
};
