"use strict";

/**
 * Usable energy and the conservatism declaration (§14.3) — **Tier 0**.
 *
 * > ```
 * > E_usable(a) = C_nominal(class) · SoH(a) · f_temp(T_pack) · SoC(a) · f_derate(class)
 * > ```
 *
 * Five factors, and each one of them is why §14.1 rejects a percentage floor:
 *
 * - `C_nominal(class)` turns a percentage into watt-hours at all.
 * - `SoH(a)` is why "30 %" of a 70 %-health pack is 21 % of the energy the threshold was
 *   calibrated against, differently for every agent in the fleet.
 * - `f_temp(T_pack)` is why the same percentage means materially less range on a cold
 *   morning.
 * - `f_derate(class)` is the declared conservatism on the vendor curve.
 *
 * ── Layered conservatism MUST be declared, not accumulated ──────────────────
 * > Layered fudge factors compound invisibly, and a fleet whose effective energy margin
 * > is 1.8× because four people each chose 1.15–1.25 will be quietly uneconomic without
 * > anyone having decided that.
 *
 * The declaration itself lives in the register (every conservatism entry carries a
 * `conservatism.compensates` block), and the product is computed at publish by
 * `config/derived.js` and capped by validator V9. This module is the *runtime* half:
 * `declaredConservatism()` reads the two published products out of the resolved config
 * view, and `assertWithinCap()` refuses to reason from a set the publish path would have
 * rejected. The two halves check the same identity from opposite ends, which is what
 * makes a hand-edited snapshot visible rather than merely improbable.
 *
 * Note what is **not** in the product: `energy.variance_inflation` multiplies a variance
 * in Wh², not a reserve in Wh, and §14.3 is explicit that "a product across
 * incommensurable quantities is not a meaningful number".
 *
 * ── Internal resistance is tracked separately, on purpose ───────────────────
 * > Rising internal resistance is separately tracked: it reduces deliverable power and
 * > is a leading indicator of pack failure, so it feeds both `SoH` and the health tier.
 *
 * `resistanceSignal()` produces that second output — the health-tier input — without
 * this module deciding a tier, which is §16.4's job.
 *
 * Tier 0 (T0-03). Decision path (T6): no clock, no randomness, no store.
 */

const { evaluateCurve } = require("./consumption");

/**
 * The factors of §14.3's product, named so a missing one is reportable by name.
 * @structural the specification's own factor names
 */
const FACTOR = Object.freeze({
  NOMINAL_WH: "packNominalWh",
  SOH: "soh",
  F_TEMP: "fTemp",
  SOC: "soc",
  F_DERATE: "fDerate",
});

/**
 * The two products §14.3 requires the Config Service to publish.
 * @structural the specification's own published combination names
 */
const COMBINED = Object.freeze({
  NOMINAL: "energy.combined_nominal_conservatism",
  DEGRADED: "energy.combined_degraded_conservatism",
  CAP: "energy.max_combined_conservatism",
});

/**
 * @param {*} value
 * @returns {boolean}
 */
function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Read a parameter from a resolved configuration view, whatever shape it arrived in.
 *
 * @param {object|Map} config
 * @param {string} name
 * @returns {*}
 */
function readParameter(config, name) {
  if (!config) return undefined;
  if (config instanceof Map) return config.get(name);
  if (typeof config.get === "function") return config.get(name);
  return config[name];
}

/**
 * `f_temp(T_pack)` — capacity derating from the per-chemistry curve.
 *
 * The curve is stored on `EnergyModelParams` as measured points. An absent curve is
 * **not** `f_temp = 1`: a pack whose temperature derating nobody has measured is a pack
 * whose usable energy at −5 °C is unknown, and treating unknown as unity is the
 * fail-open default T2 prohibits.
 *
 * @param {object} model the class's `EnergyModelParams`
 * @param {number} packC
 * @returns {{ ok: boolean, fTemp: number|null, clamped: boolean }}
 */
function fTemp(model, packC) {
  const curve = model && model.thermalDeratingCurve;
  const evaluated = evaluateCurve(curve, packC);
  if (!evaluated.ok) return { ok: false, fTemp: null, clamped: false };
  // A derating factor above 1 would claim a pack delivers more than nominal at some
  // temperature. Vendor curves do not say that, and admitting it here would let a
  // transcription error inflate every reserve computation that follows.
  if (!isNumber(evaluated.y) || evaluated.y < 0 || evaluated.y > 1) {
    return { ok: false, fTemp: null, clamped: evaluated.clamped };
  }
  return { ok: true, fTemp: evaluated.y, clamped: evaluated.clamped };
}

/**
 * `E_usable(a)` in watt-hours.
 *
 * @param {object} input
 * @param {number} input.packNominalWh `C_nominal(class)`
 * @param {number} input.soh `SoH(a)`, in [0, 1]
 * @param {number} input.fTemp `f_temp(T_pack)`, in [0, 1]
 * @param {number} input.soc `SoC(a)`, in [0, 1]
 * @param {number} input.fDerate `energy.f_derate`, a divisor ≥ 1
 * @returns {{ ok: boolean, wh: number|null, factors: object|null, missing: string[] }}
 */
function usableWh(input) {
  const source = input || {};
  const missing = [];

  if (!isNumber(source.packNominalWh) || source.packNominalWh <= 0) missing.push(FACTOR.NOMINAL_WH);
  if (!isNumber(source.soh) || source.soh <= 0 || source.soh > 1) missing.push(FACTOR.SOH);
  if (!isNumber(source.fTemp) || source.fTemp <= 0 || source.fTemp > 1) missing.push(FACTOR.F_TEMP);
  if (!isNumber(source.soc) || source.soc < 0 || source.soc > 1) missing.push(FACTOR.SOC);
  // `f_derate` is registered as a ratio ≥ 1 — "a configured conservatism factor on the
  // vendor curve". A conservatism factor makes the usable figure *smaller*, so it
  // divides. Multiplying by a number ≥ 1 would make the pack larger, which is the sign
  // error this comment exists to make impossible to reintroduce silently.
  if (!isNumber(source.fDerate) || source.fDerate < 1) missing.push(FACTOR.F_DERATE);

  if (missing.length > 0) return { ok: false, wh: null, factors: null, missing };

  const wh = (source.packNominalWh * source.soh * source.fTemp * source.soc) / source.fDerate;

  return {
    ok: true,
    wh,
    factors: Object.freeze({
      packNominalWh: source.packNominalWh,
      soh: source.soh,
      fTemp: source.fTemp,
      soc: source.soc,
      fDerate: source.fDerate,
    }),
    missing: [],
  };
}

/**
 * The two published conservatism products and the cap they are held to.
 *
 * @param {object|Map} config a resolved configuration view
 * @returns {{ ok: boolean, nominal: number|null, degraded: number|null,
 *             cap: number|null, missing: string[] }}
 */
function declaredConservatism(config) {
  const nominal = readParameter(config, COMBINED.NOMINAL);
  const degraded = readParameter(config, COMBINED.DEGRADED);
  const cap = readParameter(config, COMBINED.CAP);
  const missing = [];

  if (!isNumber(nominal)) missing.push(COMBINED.NOMINAL);
  if (!isNumber(degraded)) missing.push(COMBINED.DEGRADED);
  if (!isNumber(cap)) missing.push(COMBINED.CAP);

  if (missing.length > 0) return { ok: false, nominal: null, degraded: null, cap: null, missing };
  return { ok: true, nominal, degraded, cap, missing: [] };
}

/**
 * §14.3's publish-time rule, asserted at the point of use.
 *
 * > A published combination exceeding `energy.max_combined_conservatism` is **rejected
 * > at publish time** (§22.1 rule 5) and requires an explicit Safety-class decision to
 * > raise, which is where a deliberate choice to be very conservative belongs.
 *
 * Validator V9 is the enforcing half and runs at publish. This is the reading half: a
 * snapshot whose products exceed the cap cannot have come from a lawful publish, so
 * reasoning from it would be reasoning from a configuration the governance path
 * refused. It reports rather than throws, because the caller — a round — must record
 * the refusal in the decision record, not crash.
 *
 * @param {object|Map} config
 * @returns {{ ok: boolean, problems: string[], nominal: number|null,
 *             degraded: number|null, cap: number|null }}
 */
function assertWithinCap(config) {
  const declared = declaredConservatism(config);
  if (!declared.ok) {
    return {
      ok: false,
      problems: declared.missing.map(
        (name) => `${name} is unresolved; the combined conservatism §14.3 requires to be published is not available`,
      ),
      nominal: null,
      degraded: null,
      cap: null,
    };
  }

  const problems = [];
  if (declared.nominal > declared.cap) {
    problems.push(
      `combined nominal energy conservatism ${declared.nominal} exceeds ${COMBINED.CAP} ${declared.cap}. ` +
        "Layered derating factors compound invisibly; raising the cap is an explicit Safety-class decision (§14.3)",
    );
  }
  if (declared.degraded > declared.cap) {
    problems.push(
      `combined degraded energy conservatism ${declared.degraded} exceeds ${COMBINED.CAP} ${declared.cap}. ` +
        "The degraded product includes every degradation multiplier a mode can activate, and it is capped by " +
        "the same number for the same reason (§14.3)",
    );
  }

  return { ok: problems.length === 0, problems, nominal: declared.nominal, degraded: declared.degraded, cap: declared.cap };
}

/**
 * The internal-resistance half of §14.3.
 *
 * Two distinct consequences, reported separately because they are consumed by different
 * mechanisms: rising resistance reduces *deliverable power* (a charge-rate and
 * acceleration limit, `chargeCurve.js`) and is a *leading indicator of pack failure*
 * (a health-tier input, §16.4). Collapsing them into one number would force one
 * consumer to reverse-engineer the other's meaning.
 *
 * @param {object} state the agent's `BatteryState`
 * @returns {{ ok: boolean, milliOhm: number|null, trendPerCycle: number|null,
 *             riseRatio: number|null }}
 */
function resistanceSignal(state) {
  if (!state || typeof state !== "object") return { ok: false, milliOhm: null, trendPerCycle: null, riseRatio: null };

  const milliOhm = state.internalResistanceMilliOhm;
  const baseline = state.baselineResistanceMilliOhm;
  const trend = state.resistanceTrendPerCycle;

  if (!isNumber(milliOhm)) return { ok: false, milliOhm: null, trendPerCycle: null, riseRatio: null };

  return {
    ok: true,
    milliOhm,
    trendPerCycle: isNumber(trend) ? trend : null,
    riseRatio: isNumber(baseline) && baseline > 0 ? milliOhm / baseline : null,
  };
}

module.exports = {
  FACTOR,
  COMBINED,
  readParameter,
  fTemp,
  usableWh,
  declaredConservatism,
  assertWithinCap,
  resistanceSignal,
};
