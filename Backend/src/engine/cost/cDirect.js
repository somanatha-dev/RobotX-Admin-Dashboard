"use strict";

/**
 * `C_direct` — the physical cost of doing the work (§8.2). **Tier 1.**
 *
 * ```
 * C_direct = λ_time(a) · ( t_wait + t_approach + t_service_first
 *                        + t_linehaul + t_service_last + t_terminal )
 *          + cu_per_wh · E_mission(a, m)
 *          + cu_per_metre_wear(a) · d_mission
 * ```
 *
 * Six time components, one energy term, one distance term. Every one of the six is
 * present because §8.2 names it, and the module refuses a plan that cannot supply one
 * rather than treating it as zero — an omitted component is not a cheap mission, it is an
 * unpriced one, and the baseline's central defect was exactly that shape.
 *
 * ── Why the whole mission, and not the approach ────────────────────────────
 * > So the correct statement is not "the drop leg was missing from the ranking" but
 * > **"the baseline's objective was structurally unable to represent the mission, and
 * > therefore unable to represent energy feasibility, resource consumption, terminal
 * > value, chaining, or deadlines."** The remedy is to model the mission, not merely to
 * > add a distance term.
 *
 * The linehaul contributes an equal constant across candidates for a single-stop mission
 * and so cannot change *this term's* argmin — which is precisely why it is easy to drop
 * and why §8.2 spends a paragraph explaining that four other mechanisms depend on it
 * being there.
 *
 * ── Travel time, never geometry ────────────────────────────────────────────
 * > `t_approach` is *road-network travel time*, obtained from the Routing Service, never
 * > a great-circle distance. Geometric distance appears in exactly one place in this
 * > design — the admissible lower bound of §6.4.
 *
 * This module takes the timeline's projected seconds as input and has no geometry in it
 * at all, which is the structural version of that rule: there is no code path by which a
 * great-circle distance could reach `C_direct`.
 *
 * ── The distance-wear addend appears in two places in the specification ────
 * §8.2's third addend and §8.5's first addend are the same expression with the same
 * registered rate, `cost.wear.cu_per_metre[class] · d_mission`. Summing `C_direct` and
 * `C_lifecycle` as written would charge it twice, which doubles a registered exchange
 * rate — the failure §1.3 exists to prevent.
 *
 * This module therefore computes the addend faithfully and reports it **separately**, and
 * `phi.js` owns the single named attribution rule that charges it once. Both the full
 * §8.2 sum and the sum without it are returned, so nothing here silently decides the
 * question: the decision, and its justification, live in one place and are tested there.
 * The ambiguity is recorded in the phase report rather than resolved quietly.
 *
 * T1 (§1.5): every entry point asserts the feasibility brand, so this module is
 * structurally incapable of pricing a candidate the gate did not admit (I14).
 * Determinism: no clock, no randomness, no store.
 */

const { assertFeasible } = require("../guards/tenets");
const { milli, ZERO, total } = require("./units");
const { apply, makeRate } = require("./exchangeRates");
const { sum } = require("../determinism/fixedPoint");

/**
 * §8.2's six time components, in the order the specification lists them. The order is
 * the reporting order in a decision record; the sum is order-independent because it is
 * integer arithmetic (§9.6 requirement 1).
 * @structural the six components §8.2 tabulates, not a tunable set
 */
const TIME_COMPONENTS = Object.freeze([
  "waitSeconds",
  "approachSeconds",
  "serviceFirstSeconds",
  "linehaulSeconds",
  "serviceLastSeconds",
  "terminalSeconds",
]);

/** What each component means, carried into the decision record so an explanation need not restate §8.2. */
const COMPONENT_MEANING = Object.freeze({
  waitSeconds: "time until the agent can start: remaining committed work plus any charge top-up needed",
  approachSeconds: "travel from the projected release position to the first stop, congestion-adjusted",
  serviceFirstSeconds: "dwell at the first stop: docking, load, door, lift, handover, evidence capture",
  linehaulSeconds: "travel across the remaining stop sequence",
  serviceLastSeconds: "dwell at the final stop",
  terminalSeconds:
    "mandatory post-mission activity attributable to this mission — principally a required charging " +
    "leg when the mission leaves the agent below its reserve floor (§14.6)",
});

/**
 * @param {*} value
 * @returns {boolean}
 */
function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Price one plan's direct cost.
 *
 * @param {object} plan the branded plan the feasibility gate admitted
 * @param {object} rates
 * @param {object} rates.lambdaTime a `makeRate("cost.lambda_time", …)` for the agent's class
 * @param {object} rates.cuPerWh a `makeRate("cost.energy.cu_per_wh", …)`
 * @param {object} rates.cuPerMetreWear a `makeRate("cost.wear.cu_per_metre", …)`
 * @returns {{ ok: boolean, milliCU: bigint|null, milliCUWithDistanceWear: bigint|null,
 *             distanceWearMilliCU: bigint|null, breakdown: object|null, missing: string[] }}
 */
function evaluate(plan, rates) {
  assertFeasible(plan, "cost/cDirect.evaluate");

  const source = rates || {};
  const missing = [];

  const components = (plan && plan.components) || {};
  for (const name of TIME_COMPONENTS) {
    if (!isNumber(components[name]) || components[name] < 0) missing.push(`plan.components.${name}`);
  }
  if (!isNumber(plan && plan.energyWh) || plan.energyWh < 0) missing.push("plan.energyWh");
  if (!isNumber(plan && plan.distanceM) || plan.distanceM < 0) missing.push("plan.distanceM");

  for (const [name, rate] of [
    ["cost.lambda_time", source.lambdaTime],
    ["cost.energy.cu_per_wh", source.cuPerWh],
    ["cost.wear.cu_per_metre", source.cuPerMetreWear],
  ]) {
    if (!rate || typeof rate.value !== "number") missing.push(name);
  }

  if (missing.length > 0) {
    return {
      ok: false,
      milliCU: null,
      milliCUWithDistanceWear: null,
      distanceWearMilliCU: null,
      breakdown: null,
      missing: [...new Set(missing)],
    };
  }

  // Each component is priced separately rather than summing the seconds first. The two
  // agree exactly here because a single rate multiplies all six, but pricing each one
  // keeps the decision record able to say which component dominates — which is the
  // question an operator asks when a candidate looks expensive, and the question the
  // baseline's single blended score could never answer.
  const timeByComponent = Object.create(null);
  for (const name of TIME_COMPONENTS) {
    timeByComponent[name] = apply(source.lambdaTime, components[name], "s");
  }

  const timeMilliCU = sum(TIME_COMPONENTS.map((name) => timeByComponent[name].milliCU));
  const energy = apply(source.cuPerWh, plan.energyWh, "Wh");
  const distanceWear = apply(source.cuPerMetreWear, plan.distanceM, "m");

  const withoutDistanceWear = total(milli(timeMilliCU), energy);
  const withDistanceWear = total(withoutDistanceWear, distanceWear);

  return {
    ok: true,
    // §8.2's three addends less the one §8.5 also claims. `phi.js` names the rule.
    milliCU: withoutDistanceWear.milliCU,
    milliCUWithDistanceWear: withDistanceWear.milliCU,
    distanceWearMilliCU: distanceWear.milliCU,
    breakdown: Object.freeze({
      time: Object.freeze(
        Object.fromEntries(
          TIME_COMPONENTS.map((name) => [
            name,
            Object.freeze({
              seconds: components[name],
              milliCU: timeByComponent[name].milliCU,
              meaning: COMPONENT_MEANING[name],
            }),
          ]),
        ),
      ),
      timeMilliCU,
      totalTimeSeconds: TIME_COMPONENTS.reduce((accumulated, name) => accumulated + components[name], 0),
      energy: Object.freeze({ wh: plan.energyWh, milliCU: energy.milliCU }),
      distanceWear: Object.freeze({
        distanceM: plan.distanceM,
        milliCU: distanceWear.milliCU,
        attributedTo: "C_lifecycle",
        note:
          "§8.2 and §8.5 both state cost.wear.cu_per_metre · d_mission. Charging it in both would " +
          "double a registered exchange rate (§1.3), so Φ charges it once, in C_lifecycle.",
      }),
      lambdaTimeCuPerSecond: source.lambdaTime.value,
      cuPerWh: source.cuPerWh.value,
      cuPerMetreWear: source.cuPerMetreWear.value,
    }),
    missing: [],
  };
}

/**
 * Build the three rates `evaluate()` needs from a config snapshot, indexed by agent class.
 *
 * @param {{ explain: Function }} snapshot
 * @param {object} context scope context
 * @param {string} agentClassId
 * @returns {{ ok: boolean, rates: object|null, missing: string[] }}
 */
function ratesFor(snapshot, context, agentClassId) {
  const wanted = [
    ["lambdaTime", "cost.lambda_time", agentClassId],
    ["cuPerWh", "cost.energy.cu_per_wh", null],
    ["cuPerMetreWear", "cost.wear.cu_per_metre", agentClassId],
  ];

  const rates = {};
  const missing = [];

  for (const [field, name, index] of wanted) {
    const explained = snapshot.explain(name, context, index === null ? undefined : { index });
    if (explained.value === null || explained.value === undefined) {
      missing.push(name);
      continue;
    }
    rates[field] = makeRate(name, explained.value, {
      unit: explained.unit,
      configVersion: explained.configVersion,
      level: explained.level,
      calibrationStatus: explained.calibrationStatus,
    });
  }

  if (missing.length > 0) return { ok: false, rates: null, missing };
  return { ok: true, rates, missing: [] };
}

module.exports = {
  TIME_COMPONENTS,
  COMPONENT_MEANING,
  ZERO,
  evaluate,
  ratesFor,
};
