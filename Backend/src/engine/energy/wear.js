"use strict";

/**
 * Battery wear cost (§14.4) — **Tier 0** by module path, **Tier 1** by role.
 *
 * > ```
 * > C_battery = cu_per_equivalent_cycle · ( ΔSoC_throughput / 2 ) · stress( DoD, SoC_mid, T, C_rate )
 * > ```
 * > Charged into `C_lifecycle` (§8.5) so that the optimiser stewards the packs without
 * > a dedicated rule.
 *
 * ── Why there is no "protect the battery" rule anywhere in this engine ──────
 * §14.4 lists three practical consequences and calls all three **emergent rather than
 * encoded**:
 *
 * - Deep discharges cost superlinearly more, so the engine prefers many shallow cycles
 *   over few deep ones — the correct Li-ion policy.
 * - High-C-rate charging carries a stress premium, so fast charging happens when time
 *   is genuinely valuable rather than by default.
 * - A calendar-ageing component mildly penalises resting at very high SoC, so the fleet
 *   does not sit at 100 % unnecessarily.
 *
 * None of those is a branch in this module. They fall out of the vendor cycle-life
 * curve being priced honestly and the optimiser minimising `Φ`. That is the whole
 * design: a rule would need a threshold, a threshold would need a justification, and
 * §14.1 is an extended argument about what thresholds cost.
 *
 * ── The stress multiplier is vendor data, not a model ───────────────────────
 * > The stress multiplier comes from the pack's vendor cycle-life-versus-DoD curve,
 * > stored as configuration.
 *
 * So `stressMultiplier()` interpolates measured points and refuses to extrapolate. A
 * DoD outside the measured envelope is reported, not guessed: the curve is superlinear
 * and a linear extrapolation of a superlinear curve under-prices exactly the deep
 * cycles this term exists to discourage.
 *
 * ── Units ───────────────────────────────────────────────────────────────────
 * The result is returned in **integer milli-CU** (§9.6), because it is summed into
 * `C_lifecycle` and §9.6 requires the objective to be compared in fixed point. It is
 * also returned in CU for reporting, and the two are the same number.
 *
 * Decision path (T6): no clock, no randomness, no store.
 */

const { evaluateCurve } = require("./consumption");
const fixedPoint = require("../determinism/fixedPoint");

/**
 * The four arguments of §14.4's stress function.
 * @structural the specification's own stress-function arguments
 */
const STRESS_ARGUMENT = Object.freeze({
  DOD: "dod",
  SOC_MID: "socMid",
  TEMPERATURE_C: "tempC",
  C_RATE: "cRate",
});

const RATE_PARAMETER = "cost.battery.cu_per_equivalent_cycle";

/**
 * @param {*} value
 * @returns {boolean}
 */
function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Equivalent full cycles from state-of-charge throughput.
 *
 * @param {number} socThroughput total |ΔSoC| over the plan, as a fraction
 * @returns {number|null}
 */
function equivalentCycles(socThroughput) {
  if (!isNumber(socThroughput) || socThroughput < 0) return null;
  // @structural §14.4's own divisor: one full cycle is a discharge *and* a charge, so
  // throughput counts each cycle twice.
  return socThroughput / 2;
}

/**
 * `stress(DoD, SoC_mid, T, C_rate)` from the vendor curves.
 *
 * The four factors are multiplied. §14.4 writes the stress term as a single function of
 * four arguments and supplies one curve per argument in the vendor data; multiplying
 * independently-measured derating curves is the standard composition and is stated here
 * so that a reviewer can check it against the pack datasheet rather than infer it.
 *
 * Every curve is required. An absent C-rate curve is not "fast charging is free" — it
 * is the premium §14.4 relies on to stop fast charging happening by default.
 *
 * @param {object} curves the pack's `stressCurves` from `EnergyModelParams`
 * @param {object} conditions
 * @returns {{ ok: boolean, multiplier: number|null, factors: object|null, missing: string[] }}
 */
function stressMultiplier(curves, conditions) {
  const source = conditions || {};
  const missing = [];

  if (!curves || typeof curves !== "object") {
    return { ok: false, multiplier: null, factors: null, missing: ["stressCurves"] };
  }

  const factors = {};
  for (const argument of Object.values(STRESS_ARGUMENT)) {
    const value = source[argument];
    if (!isNumber(value)) {
      missing.push(`condition.${argument}`);
      continue;
    }
    const evaluated = evaluateCurve(curves[argument], value);
    if (!evaluated.ok) {
      missing.push(`stressCurves.${argument}`);
      continue;
    }
    if (evaluated.clamped) {
      // Reported, not refused: the clamp is the honest reading of a measured envelope,
      // and the caller records it so a fleet routinely operating off the end of the
      // vendor curve is visible rather than silently priced at the boundary.
      factors[`${argument}Clamped`] = true;
    }
    if (!isNumber(evaluated.y) || evaluated.y < 0) {
      missing.push(`stressCurves.${argument}`);
      continue;
    }
    factors[argument] = evaluated.y;
  }

  if (missing.length > 0) return { ok: false, multiplier: null, factors: null, missing };

  const multiplier = Object.values(STRESS_ARGUMENT).reduce((product, argument) => product * factors[argument], 1);
  return { ok: true, multiplier, factors: Object.freeze(factors), missing: [] };
}

/**
 * The calendar-ageing component: a mild penalty for resting at very high SoC.
 *
 * Expressed as additional equivalent cycles per second of rest, read from the same
 * vendor data, so it lands in the same unit as the cycling term and is priced by the
 * same rate. Charging it as a separate rate would need a second calibration for the
 * same physical quantity.
 *
 * @param {object} curves
 * @param {{ restSoc: number, restSeconds: number }} rest
 * @returns {{ ok: boolean, equivalentCycles: number|null, missing: string[] }}
 */
function calendarAgeingCycles(curves, rest) {
  const source = rest || {};
  if (!curves || typeof curves !== "object") return { ok: false, equivalentCycles: null, missing: ["stressCurves"] };
  if (!isNumber(source.restSoc) || !isNumber(source.restSeconds) || source.restSeconds < 0) {
    return { ok: false, equivalentCycles: null, missing: ["rest.restSoc", "rest.restSeconds"] };
  }

  const evaluated = evaluateCurve(curves.calendarAgeing, source.restSoc);
  if (!evaluated.ok || !isNumber(evaluated.y) || evaluated.y < 0) {
    return { ok: false, equivalentCycles: null, missing: ["stressCurves.calendarAgeing"] };
  }

  return { ok: true, equivalentCycles: evaluated.y * source.restSeconds, missing: [] };
}

/**
 * `C_battery` in milli-CU, for `C_lifecycle`.
 *
 * @param {object} input
 * @param {number} input.socThroughput
 * @param {object} input.curves the pack's stress curves
 * @param {object} input.conditions `{ dod, socMid, tempC, cRate }`
 * @param {number} input.cuPerEquivalentCycle `cost.battery.cu_per_equivalent_cycle`
 * @param {{ restSoc: number, restSeconds: number }} [input.rest]
 * @returns {{ ok: boolean, milliCU: bigint|null, cu: number|null, breakdown: object|null,
 *             missing: string[] }}
 */
function batteryWear(input) {
  const source = input || {};
  const missing = [];

  const cycles = equivalentCycles(source.socThroughput);
  if (cycles === null) missing.push("socThroughput");

  if (!isNumber(source.cuPerEquivalentCycle) || source.cuPerEquivalentCycle < 0) {
    missing.push(RATE_PARAMETER);
  }

  const stress = stressMultiplier(source.curves, source.conditions);
  missing.push(...stress.missing);

  let calendarCycles = 0;
  if (source.rest) {
    const calendar = calendarAgeingCycles(source.curves, source.rest);
    if (!calendar.ok) missing.push(...calendar.missing);
    else calendarCycles = calendar.equivalentCycles;
  }

  if (missing.length > 0) {
    return { ok: false, milliCU: null, cu: null, breakdown: null, missing: [...new Set(missing)] };
  }

  const cyclingCu = source.cuPerEquivalentCycle * cycles * stress.multiplier;
  const calendarCu = source.cuPerEquivalentCycle * calendarCycles;
  const cu = cyclingCu + calendarCu;

  return {
    ok: true,
    milliCU: fixedPoint.toMilliCU(cu),
    cu,
    breakdown: Object.freeze({
      equivalentCycles: cycles,
      stressMultiplier: stress.multiplier,
      stressFactors: stress.factors,
      calendarEquivalentCycles: calendarCycles,
      cyclingCu,
      calendarCu,
    }),
    missing: [],
  };
}

module.exports = {
  STRESS_ARGUMENT,
  RATE_PARAMETER,
  equivalentCycles,
  stressMultiplier,
  calendarAgeingCycles,
  batteryWear,
};
