"use strict";

/**
 * The charging model (§14.6) — **Tier 0**.
 *
 * > **Charge duration is nonlinear.** Li-ion charging is constant-current to roughly
 * > 80 % and then constant-voltage with a decaying current, so the last 20 % can take
 * > as long as the first 60 %. A linear rate — as the baseline's simulation uses — will
 * > systematically underestimate time to full and overestimate fleet availability. The
 * > engine MUST integrate a per-model charge-power curve `P_charge(SoC, T, charger_class)`
 * > to compute `t_charge(SoC₀ → SoC₁)`.
 *
 * The baseline's simulator charges at a flat 0.1 % per tick. That is the defect this
 * module exists to remove, and `simulation/VirtualRobot.js` now integrates the same
 * curve — §14.6 requires both sides to reason from identical inputs, and a server that
 * modelled the taper against an agent that did not would disagree about every charging
 * plan it made.
 *
 * ── Target SoC is consumed, never computed ─────────────────────────────────
 * > **Decision: the Charging Scheduler owns and publishes target SoC. The assignment
 * > engine treats the published value as an input constraint. The engine may submit a
 * > priced request to change it; it never computes or asserts a target value
 * > unilaterally.**
 *
 * There is deliberately **no** function in this module that chooses a target. It
 * integrates to a target somebody else supplied. `chargingSchedulerClient.js` is where
 * that value comes from and is the only module entitled to resolve one, including the
 * class-default fallback.
 *
 * ── Charge interruption replaces a magic constant with a stated condition ───
 * > The baseline uses a fixed 30 % threshold. Here, interrupting a charge is permitted
 * > when: (a) the resulting plan satisfies F34–F35 with all reserves intact; (b) the
 * > Charging Scheduler confirms the interruption does not breach the fleet's projected
 * > availability floor; and (c) the value of serving the mission exceeds the wear
 * > premium plus the opportunity cost of the deferred charge.
 *
 * `interruptionPermitted()` is those three conditions and nothing else. It "correctly
 * permits interruption at 25 % for a 400 m mission while forbidding it at 45 % for a
 * 9 km one, which no single threshold can do" — because it never reads a state of
 * charge at all.
 *
 * Tier 0 (T0-03). Decision path (T6): no clock, no randomness, no store.
 */

const { evaluateCurve } = require("./consumption");

/**
 * The three arguments of `P_charge(SoC, T, charger_class)`.
 * @structural the specification's own charge-power arguments
 */
const CHARGE_POWER_ARGUMENT = Object.freeze(["soc", "tempC", "chargerClass"]);

/**
 * The three conditions §14.6 permits a charge interruption under.
 * @structural the specification's own interruption conditions
 */
const INTERRUPTION_CONDITION = Object.freeze({
  RESERVES_INTACT: "a",
  SCHEDULER_CONFIRMS: "b",
  VALUE_EXCEEDS_COST: "c",
});

/**
 * @param {*} value
 * @returns {boolean}
 */
function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * `P_charge(SoC, T, charger_class)` in watts.
 *
 * The curve is stored per charger class as measured points against SoC, with a
 * temperature derating curve applied multiplicatively — the same composition
 * `wear.js` uses, and for the same reason: the two are measured independently.
 *
 * A charger class with no curve is not a charger that charges at some default rate. It
 * is a class nobody has characterised, and inventing a rate for it would produce a
 * charge duration the agent will not reproduce.
 *
 * @param {object} curve the class's `chargePowerCurve`
 * @param {{ soc: number, tempC: number, chargerClass: string }} conditions
 * @returns {{ ok: boolean, watts: number|null, missing: string[] }}
 */
function chargePowerW(curve, conditions) {
  const source = conditions || {};
  const missing = [];

  if (!curve || typeof curve !== "object") return { ok: false, watts: null, missing: ["chargePowerCurve"] };
  for (const argument of CHARGE_POWER_ARGUMENT) {
    if (source[argument] === undefined || source[argument] === null) missing.push(`condition.${argument}`);
  }
  if (missing.length > 0) return { ok: false, watts: null, missing };

  const byClass = curve.byChargerClass && curve.byChargerClass[source.chargerClass];
  if (!byClass) return { ok: false, watts: null, missing: [`chargePowerCurve.byChargerClass.${String(source.chargerClass)}`] };

  const power = evaluateCurve(byClass.socCurve, source.soc);
  if (!power.ok || !isNumber(power.y) || power.y < 0) {
    return { ok: false, watts: null, missing: [`chargePowerCurve.byChargerClass.${String(source.chargerClass)}.socCurve`] };
  }

  const derate = evaluateCurve(curve.temperatureDerating, source.tempC);
  if (!derate.ok || !isNumber(derate.y) || derate.y < 0 || derate.y > 1) {
    return { ok: false, watts: null, missing: ["chargePowerCurve.temperatureDerating"] };
  }

  return { ok: true, watts: power.y * derate.y, missing: [] };
}

/**
 * `t_charge(SoC₀ → SoC₁)` in seconds, integrated over the nonlinear curve.
 *
 * The integral is `∫ (C_usable · dSoC) / P_charge(SoC)`, evaluated by the midpoint rule
 * over `energy.charge_curve_integration_steps` equal sub-intervals. A **fixed** step
 * count rather than an adaptive one, because §9.6 requires the duration to be
 * bit-identical on replay and an adaptive scheme's step placement would depend on
 * floating-point comparisons that are not stable across engine versions.
 *
 * A sub-interval in which the curve reads zero power is not skipped: it means the
 * charger cannot deliver at that state of charge, so the target is unreachable and the
 * integral is reported as such rather than returning a finite time.
 *
 * @param {object} input
 * @param {object} input.curve
 * @param {number} input.fromSoc
 * @param {number} input.toSoc
 * @param {number} input.tempC
 * @param {string} input.chargerClass
 * @param {number} input.packUsableWh the pack capacity one unit of SoC corresponds to
 * @param {number} input.steps `energy.charge_curve_integration_steps`
 * @returns {{ ok: boolean, seconds: number|null, energyWh: number|null,
 *             steps: number|null, reason: string|null, missing: string[] }}
 */
function timeToChargeSeconds(input) {
  const source = input || {};
  const missing = [];

  if (!isNumber(source.fromSoc) || source.fromSoc < 0 || source.fromSoc > 1) missing.push("fromSoc");
  if (!isNumber(source.toSoc) || source.toSoc < 0 || source.toSoc > 1) missing.push("toSoc");
  if (!isNumber(source.packUsableWh) || source.packUsableWh <= 0) missing.push("packUsableWh");
  if (!Number.isInteger(source.steps) || source.steps < 1) missing.push("energy.charge_curve_integration_steps");
  if (missing.length > 0) return { ok: false, seconds: null, energyWh: null, steps: null, reason: null, missing };

  if (source.toSoc <= source.fromSoc) {
    return { ok: true, seconds: 0, energyWh: 0, steps: 0, reason: "target already met", missing: [] };
  }

  const span = source.toSoc - source.fromSoc;
  const width = span / source.steps;
  let seconds = 0;

  for (let index = 0; index < source.steps; index += 1) {
    // @structural midpoint of the sub-interval
    const soc = source.fromSoc + width * (index + 0.5);
    const power = chargePowerW(source.curve, { soc, tempC: source.tempC, chargerClass: source.chargerClass });
    if (!power.ok) return { ok: false, seconds: null, energyWh: null, steps: null, reason: null, missing: power.missing };
    if (power.watts <= 0) {
      return {
        ok: false,
        seconds: null,
        energyWh: null,
        steps: null,
        reason: `the charge curve delivers no power at SoC ${soc}; the target ${source.toSoc} is unreachable on a ${String(source.chargerClass)} charger`,
        missing: [],
      };
    }
    // Wh delivered over the sub-interval, divided by watts, converted to seconds.
    // @structural seconds per hour
    seconds += ((width * source.packUsableWh) / power.watts) * 3600;
  }

  return { ok: true, seconds, energyWh: span * source.packUsableWh, steps: source.steps, reason: null, missing: [] };
}

/**
 * The mean C-rate over a charge, for `wear.js`'s stress term.
 *
 * §14.4 prices a high-C-rate premium so that "fast charging happens when time is
 * genuinely valuable rather than by default". That premium needs the realised rate of
 * the *planned* charge, which is a property of this integral and not of the charger's
 * nameplate.
 *
 * @param {number} energyWh
 * @param {number} seconds
 * @param {number} packUsableWh
 * @returns {number|null}
 */
function meanCRate(energyWh, seconds, packUsableWh) {
  if (!isNumber(energyWh) || !isNumber(seconds) || !isNumber(packUsableWh)) return null;
  if (seconds <= 0 || packUsableWh <= 0) return null;
  // @structural seconds per hour
  const hours = seconds / 3600;
  return energyWh / hours / packUsableWh;
}

/**
 * §14.6's three interruption conditions, evaluated together.
 *
 * Every condition must be **stated**. An unstated condition is not a satisfied one:
 * "the Scheduler did not answer" is not "the Scheduler confirms", and §14.7 makes that
 * explicit — on Scheduler unavailability "agents already charging continue to
 * completion; no interruption is permitted (T3 — without the fleet-level view,
 * interruption cannot be shown safe)".
 *
 * @param {object} input
 * @param {boolean} input.reservesIntact whether the resulting plan satisfies F34–F35
 * @param {boolean} input.schedulerConfirms
 * @param {number} input.missionValueCu
 * @param {number} input.wearPremiumCu
 * @param {number} input.deferredChargeOpportunityCu
 * @returns {{ permitted: boolean, failed: string[], reasons: string[] }}
 */
function interruptionPermitted(input) {
  const source = input || {};
  const failed = [];
  const reasons = [];

  if (source.reservesIntact !== true) {
    failed.push(INTERRUPTION_CONDITION.RESERVES_INTACT);
    reasons.push("(a) the resulting plan does not satisfy F34–F35 with all reserves intact (§14.6)");
  }
  if (source.schedulerConfirms !== true) {
    failed.push(INTERRUPTION_CONDITION.SCHEDULER_CONFIRMS);
    reasons.push(
      "(b) the Charging Scheduler has not confirmed that the interruption leaves the fleet's projected " +
        "availability floor intact. Without the fleet-level view the interruption cannot be shown safe (§14.6, §14.7)",
    );
  }

  const value = source.missionValueCu;
  const cost = [source.wearPremiumCu, source.deferredChargeOpportunityCu];
  if (!isNumber(value) || cost.some((entry) => !isNumber(entry))) {
    failed.push(INTERRUPTION_CONDITION.VALUE_EXCEEDS_COST);
    reasons.push("(c) the value of serving the mission or the cost of deferring the charge is not priced (§14.6)");
  } else if (value <= source.wearPremiumCu + source.deferredChargeOpportunityCu) {
    failed.push(INTERRUPTION_CONDITION.VALUE_EXCEEDS_COST);
    reasons.push(
      `(c) mission value ${value} CU does not exceed the wear premium ${source.wearPremiumCu} CU plus the ` +
        `deferred-charge opportunity cost ${source.deferredChargeOpportunityCu} CU (§14.6)`,
    );
  }

  return { permitted: failed.length === 0, failed, reasons };
}

module.exports = {
  CHARGE_POWER_ARGUMENT,
  INTERRUPTION_CONDITION,
  chargePowerW,
  timeToChargeSeconds,
  meanCRate,
  interruptionPermitted,
};
