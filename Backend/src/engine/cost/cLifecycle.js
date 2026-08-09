"use strict";

/**
 * `C_lifecycle` — amortised physical consumption (§8.5). **Tier 1.**
 *
 * ```
 * C_lifecycle = cu_per_metre_wear(class) · d_mission
 *             + battery_cycle_cost( ΔSoC path, DoD, temperature )        (§14.4)
 *             + actuator_cycle_cost( lifts, door cycles, latch cycles )
 *             + tyre_and_brake_cost( braking events, gradient exposure )
 *             + thermal_stress_cost( ambient, load )
 * ```
 *
 * > This term is the *economically correct* basis for wear levelling, and it is why this
 * > design needs only a small explicit fairness regulariser rather than a large artificial
 * > one (§17.1). Each coefficient derives from a component's replacement cost divided by
 * > its rated life, which is an accounting figure a maintenance engineer can supply and
 * > defend — not a tuned weight.
 *
 * > An important second-order effect: because battery cycle cost is depth-of-discharge
 * > weighted, the engine spontaneously avoids deep discharges and prefers to spread
 * > shallow cycles across the fleet, which is the correct Li-ion stewardship policy. **No
 * > separate rule is required.**
 *
 * That second-order effect is not written here; it is inherited. `battery_cycle_cost` is
 * Phase 7's `energy/wear.batteryWear()` — the DoD-weighted, temperature-weighted,
 * C-rate-weighted composition of the vendor stress curves — called rather than
 * reimplemented, so the stewardship property holds because the same code produces it in
 * the cost path and in the energy path.
 *
 * ── Where the distance-wear addend is charged ──────────────────────────────
 * §8.2's `C_direct` and §8.5's `C_lifecycle` both state
 * `cost.wear.cu_per_metre[class] · d_mission`. Φ charges it **once, here**, and
 * `cDirect.js` reports it separately with the attribution recorded. The choice of this
 * term rather than the other follows §8.5's own framing: this is the term §17.1 relies on
 * for wear levelling, and moving the distance component out of it would leave the wear
 * regulariser reading a term with no distance in it.
 *
 * ── Three coefficients §8.10 does not tabulate ─────────────────────────────
 * §8.10 registers `cost.wear.cu_per_metre` and `cost.battery.cu_per_equivalent_cycle` —
 * two of this term's five addends. The actuator, tyre-and-brake, and thermal-stress
 * coefficients are named by §8.5's formula and absent from §8.10's table, so Phase 8
 * registers them in `supplementary.json` with the derivation §8.5 states. Registering them
 * rather than accepting three bare CU inputs is the point of §22.1: a constant with a
 * unit, an owner, a valid range, and a derivation is not magic, and one supplied at
 * runtime by nobody in particular is.
 *
 * T1: entry point asserts the feasibility brand. Determinism: no clock, no randomness.
 */

const { assertFeasible } = require("../guards/tenets");
const { cu, milli, ZERO, total } = require("./units");
const { apply } = require("./exchangeRates");
const wear = require("../energy/wear");

/**
 * §8.5's five addends, named for the decision record.
 * @structural §8.5's own five-term formula
 */
const COMPONENT = Object.freeze({
  DISTANCE_WEAR: "distanceWear",
  BATTERY: "batteryCycle",
  ACTUATOR: "actuatorCycle",
  TYRE_AND_BRAKE: "tyreAndBrake",
  THERMAL_STRESS: "thermalStress",
});

/**
 * The actuator kinds §8.5 enumerates.
 * @structural §8.5's own list: "lifts, door cycles, latch cycles"
 */
const ACTUATOR_KINDS = Object.freeze(["LIFT", "DOOR", "LATCH"]);

/**
 * @param {*} value
 * @returns {boolean}
 */
function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * `actuator_cycle_cost(lifts, door cycles, latch cycles)`.
 *
 * A kind that the plan actuates but the register does not price is reported missing, not
 * treated as free. A container whose latch cost nobody supplied is a container whose latch
 * the optimiser will happily cycle a hundred times.
 *
 * @param {Record<string, number>} cyclesByKind counts from the plan's per-stop projection
 * @param {Record<string, number>} cuPerCycle `lifecycle.cu_per_actuator_cycle[class, kind]`
 * @returns {{ ok: boolean, milliCU: bigint|null, perKind: object[], missing: string[] }}
 */
function actuatorCycleCost(cyclesByKind, cuPerCycle) {
  const counts = cyclesByKind || {};
  const prices = cuPerCycle || {};
  const missing = [];
  const perKind = [];
  let accumulated = ZERO;

  for (const kind of ACTUATOR_KINDS) {
    const count = counts[kind];
    if (count === undefined || count === null) continue;
    if (!isNumber(count) || count < 0) {
      missing.push(`plan.actuatorCycles.${kind}`);
      continue;
    }
    if (count === 0) {
      perKind.push({ kind, cycles: 0, cuPerCycle: null, milliCU: 0n });
      continue;
    }
    if (!isNumber(prices[kind]) || prices[kind] < 0) {
      missing.push(`lifecycle.cu_per_actuator_cycle.${kind}`);
      continue;
    }
    const priced = cu(count * prices[kind]);
    perKind.push({ kind, cycles: count, cuPerCycle: prices[kind], milliCU: priced.milliCU });
    accumulated = total(accumulated, priced);
  }

  if (missing.length > 0) return { ok: false, milliCU: null, perKind, missing };
  return { ok: true, milliCU: accumulated.milliCU, perKind, missing: [] };
}

/**
 * `tyre_and_brake_cost(braking events, gradient exposure)`.
 *
 * @param {object} input
 * @param {number} input.brakingEvents
 * @param {number} input.gradientExposureM metres travelled under gradient, climb and descent
 * @param {number} input.cuPerBrakingEvent `lifecycle.cu_per_braking_event[class]`
 * @param {object} input.gradientRate a `makeRate("lifecycle.cu_per_gradient_metre", …)`
 * @returns {{ ok: boolean, milliCU: bigint|null, breakdown: object|null, missing: string[] }}
 */
function tyreAndBrakeCost(input) {
  const source = input || {};
  const missing = [];

  if (!isNumber(source.brakingEvents) || source.brakingEvents < 0) missing.push("plan.brakingEvents");
  if (!isNumber(source.gradientExposureM) || source.gradientExposureM < 0) missing.push("plan.gradientExposureM");
  if (!isNumber(source.cuPerBrakingEvent) || source.cuPerBrakingEvent < 0) {
    missing.push("lifecycle.cu_per_braking_event");
  }
  if (!source.gradientRate || typeof source.gradientRate.value !== "number") {
    missing.push("lifecycle.cu_per_gradient_metre");
  }
  if (missing.length > 0) return { ok: false, milliCU: null, breakdown: null, missing };

  const braking = cu(source.brakingEvents * source.cuPerBrakingEvent);
  const gradient = apply(source.gradientRate, source.gradientExposureM, "m");

  return {
    ok: true,
    milliCU: total(braking, gradient).milliCU,
    breakdown: Object.freeze({
      brakingEvents: source.brakingEvents,
      brakingMilliCU: braking.milliCU,
      gradientExposureM: source.gradientExposureM,
      gradientMilliCU: gradient.milliCU,
    }),
    missing: [],
  };
}

/**
 * `thermal_stress_cost(ambient, load)`.
 *
 * The reference-condition rate multiplied by the mission's exposed seconds and by a
 * measured stress multiplier over ambient temperature and load — the same shape §14.4
 * uses for battery stress, and for the same reason: the accounting figure is stated at a
 * reference condition and the mission's departure from it is measured, not guessed.
 *
 * An absent multiplier is refused rather than taken as 1. A multiplier of 1 is a claim
 * that the mission ran at reference conditions, and a mission whose ambient nobody
 * recorded did not.
 *
 * @param {object} input
 * @param {number} input.exposedSeconds
 * @param {number} input.stressMultiplier measured over `(ambient, load)`
 * @param {object} input.thermalRate a `makeRate("lifecycle.cu_per_thermal_stress_second", …)`
 * @returns {{ ok: boolean, milliCU: bigint|null, breakdown: object|null, missing: string[] }}
 */
function thermalStressCost(input) {
  const source = input || {};
  const missing = [];

  if (!isNumber(source.exposedSeconds) || source.exposedSeconds < 0) missing.push("plan.thermalExposedSeconds");
  if (!isNumber(source.stressMultiplier) || source.stressMultiplier < 0) missing.push("plan.thermalStressMultiplier");
  if (!source.thermalRate || typeof source.thermalRate.value !== "number") {
    missing.push("lifecycle.cu_per_thermal_stress_second");
  }
  if (missing.length > 0) return { ok: false, milliCU: null, breakdown: null, missing };

  const referenceCost = apply(source.thermalRate, source.exposedSeconds, "s");
  const scaled = cu(source.exposedSeconds * source.thermalRate.value * source.stressMultiplier);

  return {
    ok: true,
    milliCU: scaled.milliCU,
    breakdown: Object.freeze({
      exposedSeconds: source.exposedSeconds,
      stressMultiplier: source.stressMultiplier,
      referenceMilliCU: referenceCost.milliCU,
      milliCU: scaled.milliCU,
    }),
    missing: [],
  };
}

/**
 * `C_lifecycle` for one plan.
 *
 * @param {object} plan the branded plan
 * @param {object} input
 * @param {object} input.cuPerMetreWear a `makeRate("cost.wear.cu_per_metre", …)`
 * @param {object} input.battery arguments for `energy/wear.batteryWear()`
 * @param {Record<string, number>} input.cuPerActuatorCycle
 * @param {number} input.cuPerBrakingEvent
 * @param {object} input.gradientRate
 * @param {object} input.thermalRate
 * @returns {{ ok: boolean, milliCU: bigint|null, breakdown: object|null, missing: string[] }}
 */
function evaluate(plan, input) {
  assertFeasible(plan, "cost/cLifecycle.evaluate");

  const source = input || {};
  const missing = [];

  if (!isNumber(plan && plan.distanceM) || plan.distanceM < 0) missing.push("plan.distanceM");
  if (!source.cuPerMetreWear || typeof source.cuPerMetreWear.value !== "number") {
    missing.push("cost.wear.cu_per_metre");
  }

  // §14.4's DoD-weighted battery cost, from Phase 7's module rather than a second
  // implementation of the same curves.
  const battery = wear.batteryWear(source.battery);
  if (!battery.ok) missing.push(...battery.missing.map((name) => `battery.${name}`));

  const actuator = actuatorCycleCost((plan && plan.actuatorCycles) || {}, source.cuPerActuatorCycle);
  if (!actuator.ok) missing.push(...actuator.missing);

  const tyreAndBrake = tyreAndBrakeCost({
    brakingEvents: plan && plan.brakingEvents,
    gradientExposureM: plan && plan.gradientExposureM,
    cuPerBrakingEvent: source.cuPerBrakingEvent,
    gradientRate: source.gradientRate,
  });
  if (!tyreAndBrake.ok) missing.push(...tyreAndBrake.missing);

  const thermal = thermalStressCost({
    exposedSeconds: plan && plan.thermalExposedSeconds,
    stressMultiplier: plan && plan.thermalStressMultiplier,
    thermalRate: source.thermalRate,
  });
  if (!thermal.ok) missing.push(...thermal.missing);

  if (missing.length > 0) return { ok: false, milliCU: null, breakdown: null, missing: [...new Set(missing)] };

  const distanceWear = apply(source.cuPerMetreWear, plan.distanceM, "m");

  const summed = total(
    distanceWear,
    milli(battery.milliCU),
    milli(actuator.milliCU),
    milli(tyreAndBrake.milliCU),
    milli(thermal.milliCU),
  );

  return {
    ok: true,
    milliCU: summed.milliCU,
    breakdown: Object.freeze({
      [COMPONENT.DISTANCE_WEAR]: Object.freeze({
        distanceM: plan.distanceM,
        cuPerMetre: source.cuPerMetreWear.value,
        milliCU: distanceWear.milliCU,
        note:
          "charged here and not in C_direct: §8.2 and §8.5 both state the expression, and Φ charges " +
          "the registered rate once (§1.3)",
      }),
      [COMPONENT.BATTERY]: Object.freeze({ milliCU: battery.milliCU, ...battery.breakdown }),
      [COMPONENT.ACTUATOR]: Object.freeze({ milliCU: actuator.milliCU, perKind: actuator.perKind }),
      [COMPONENT.TYRE_AND_BRAKE]: Object.freeze({ milliCU: tyreAndBrake.milliCU, ...tyreAndBrake.breakdown }),
      [COMPONENT.THERMAL_STRESS]: Object.freeze({ milliCU: thermal.milliCU, ...thermal.breakdown }),
    }),
    missing: [],
  };
}

module.exports = {
  COMPONENT,
  ACTUATOR_KINDS,
  actuatorCycleCost,
  tyreAndBrakeCost,
  thermalStressCost,
  evaluate,
};
