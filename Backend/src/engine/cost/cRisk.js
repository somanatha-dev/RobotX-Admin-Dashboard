"use strict";

/**
 * `C_risk` — the expected cost of things going wrong (§8.4). **Tier 1.**
 *
 * ```
 * C_risk = p_fail(a,m) · C_failure(m)
 *        + Σ    p_energy[tier](a,m) · C_energy_consequence[tier]
 *         tier
 *        + p_late(a,m) · E[ C_delay overrun | late ]
 *        + staleness_penalty(a)
 *        + route_hazard_cost(route, conditions)
 * ```
 *
 * > Modelling risk as a priced expectation rather than a threshold means the engine
 * > trades risk against cost coherently, and the trade is auditable because `C_failure`
 * > is a stated number with a derivation.
 *
 * ── The energy tiers are summed separately, and that is the point ───────────
 * > Summed **per tier** because the consequences differ by five orders of magnitude in
 * > cost: a contingency diversion, a physical recovery mission, and an immobilisation in
 * > service are not the same event and must not share one price.
 *
 * So this module takes three probabilities and three prices and refuses a single blended
 * pair. It also refuses a tier whose price is missing rather than pricing it at zero: a
 * zero on T3 says an immobilisation in service costs nothing, which is a claim about the
 * operation, not a missing input. And §14.5's own point is that these probabilities are
 * **non-zero even for feasible pairings** — feasibility bounds each tier below its own
 * `α[tier]`, and this term prices the residual. A `C_risk` that saw only infeasible
 * candidates would be measuring nothing.
 *
 * ── `p_late` comes from a distribution, never a point estimate ──────────────
 * > From the ETA predictive distribution, not the point estimate. An agent with a
 * > high-variance ETA is penalised relative to an equally-fast, more-predictable one.
 * > Punctuality is a distinct property from speed, and only a distributional model
 * > captures it.
 *
 * `plan/timeline.js` produces the band this reads. The overrun cost is obtained by
 * evaluating `cDelay` at the expected completion **given lateness**, rather than by a
 * second delay model — two models of the same quantity would eventually disagree, and the
 * disagreement would be invisible.
 *
 * ── Staleness prices decision uncertainty, and inverts a baseline defect ────
 * > Prices decision uncertainty, so a well-observed agent is preferred among near-equals.
 * > Contrast the baseline, where stale state produced the *best possible* utilisation
 * > score.
 *
 * ── What this module does not import ───────────────────────────────────────
 * `p_fail` is a hierarchical Bayesian per-agent estimate from the Reliability Service,
 * which §1.8 makes **Tier 2** (T2-09, kill switch `reliability_based_gating`, degrading
 * to cohort priors). This module is Tier 1, so the probability arrives as an input with
 * its provenance attached and there is no static import — §1.8 rule 2, enforced by the
 * build gate. The same applies to `route_hazard_cost`, which is a CU quantity supplied by
 * the Map service (§5.2).
 *
 * T1: entry points asserting the feasibility brand. Determinism: no clock, no randomness.
 */

const { assertFeasible } = require("../guards/tenets");
const { cu, milli, ZERO, total } = require("./units");
const { apply } = require("./exchangeRates");

/** @structural milliseconds in one second */
const MS_PER_SECOND = 1000;

/**
 * The three §14.5 shortfall tiers, in the order the register keys them.
 * @structural §14.5's own three tiers
 */
const ENERGY_TIERS = Object.freeze(["T1", "T2", "T3"]);

/** The five addends §8.4 enumerates, named for the decision record. */
const COMPONENT = Object.freeze({
  FAILURE: "failure",
  ENERGY: "energyShortfall",
  LATENESS: "lateness",
  STALENESS: "staleness",
  ROUTE_HAZARD: "routeHazard",
});

/**
 * @param {*} value
 * @returns {boolean}
 */
function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * @param {*} value
 * @returns {boolean}
 */
function isProbability(value) {
  return isNumber(value) && value >= 0 && value <= 1;
}

/**
 * `Σ_tier p_energy[tier] · C_energy_consequence[tier]`, reported per tier.
 *
 * @param {Record<string, number>} tierProbabilities from `energy/tiers.evaluate()`
 * @param {Record<string, number>} consequenceCu `cost.energy_consequence[tier]`
 * @returns {{ ok: boolean, milliCU: bigint|null, perTier: object[], missing: string[] }}
 */
function energyShortfall(tierProbabilities, consequenceCu) {
  const probabilities = tierProbabilities || {};
  const prices = consequenceCu || {};
  const missing = [];
  const perTier = [];
  let accumulated = ZERO;

  for (const tier of ENERGY_TIERS) {
    if (!isProbability(probabilities[tier])) {
      missing.push(`plan.energy.tierProbabilities.${tier}`);
      continue;
    }
    if (!isNumber(prices[tier]) || prices[tier] < 0) {
      missing.push(`cost.energy_consequence.${tier}`);
      continue;
    }
    const priced = cu(probabilities[tier] * prices[tier]);
    perTier.push({
      tier,
      probability: probabilities[tier],
      consequenceCu: prices[tier],
      milliCU: priced.milliCU,
    });
    accumulated = total(accumulated, priced);
  }

  if (missing.length > 0) return { ok: false, milliCU: null, perTier, missing };
  return { ok: true, milliCU: accumulated.milliCU, perTier, missing: [] };
}

/**
 * `staleness_penalty(a)` — increasing in the age of the agent's safety-relevant observations.
 *
 * The **oldest** safety-relevant observation governs, not the average: an agent whose
 * position is two seconds old and whose state of charge is four minutes old is as
 * uncertain as its worst input, and averaging would let a stream of cheap heartbeats
 * conceal a stale reading that actually matters.
 *
 * @param {object} input
 * @param {Record<string, {observedAtMs: number}>} input.safetyRelevantObservations
 * @param {number} input.decisionTimeMs the round's pinned time
 * @param {object} input.stalenessRate a `makeRate("cost.staleness.cu_per_second_age", …)`
 * @returns {{ ok: boolean, milliCU: bigint|null, oldestAgeSeconds: number|null,
 *             oldestKind: string|null, missing: string[] }}
 */
function stalenessPenalty(input) {
  const source = input || {};
  if (!source.stalenessRate || typeof source.stalenessRate.value !== "number") {
    return { ok: false, milliCU: null, oldestAgeSeconds: null, oldestKind: null, missing: ["cost.staleness.cu_per_second_age"] };
  }
  if (!isNumber(source.decisionTimeMs)) {
    return { ok: false, milliCU: null, oldestAgeSeconds: null, oldestKind: null, missing: ["decisionTimeMs"] };
  }

  const observations = source.safetyRelevantObservations || {};
  const kinds = Object.keys(observations).sort();
  if (kinds.length === 0) {
    return {
      ok: false,
      milliCU: null,
      oldestAgeSeconds: null,
      oldestKind: null,
      missing: ["agentSnapshot.safetyRelevantObservations"],
    };
  }

  let oldestAgeSeconds = null;
  let oldestKind = null;
  for (const kind of kinds) {
    const observedAtMs = observations[kind] && observations[kind].observedAtMs;
    if (!isNumber(observedAtMs)) {
      return {
        ok: false,
        milliCU: null,
        oldestAgeSeconds: null,
        oldestKind: null,
        missing: [`agentSnapshot.safetyRelevantObservations.${kind}.observedAtMs`],
      };
    }
    const ageSeconds = Math.max(0, (source.decisionTimeMs - observedAtMs) / MS_PER_SECOND);
    if (oldestAgeSeconds === null || ageSeconds > oldestAgeSeconds) {
      oldestAgeSeconds = ageSeconds;
      oldestKind = kind;
    }
  }

  return {
    ok: true,
    milliCU: apply(source.stalenessRate, oldestAgeSeconds, "s").milliCU,
    oldestAgeSeconds,
    oldestKind,
    missing: [],
  };
}

/**
 * `C_risk` for one plan.
 *
 * @param {object} plan the branded plan
 * @param {object} input
 * @param {{ probability: number, provenance: string }} input.failure `p_fail` with where it
 *   came from — a per-agent posterior or a cohort prior under the Tier 2 kill switch
 * @param {number} input.failureConsequenceCu `cost.failure.cu[mission_class, custody_state]`
 * @param {Record<string, number>} input.tierProbabilities
 * @param {Record<string, number>} input.energyConsequenceCu
 * @param {number} input.lateProbability `p_late`, read from the ETA distribution
 * @param {bigint} input.overrunMilliCU `E[C_delay overrun | late]`, from `cDelay.overrunGivenLate`
 * @param {object} input.staleness as `stalenessPenalty`
 * @param {number} input.routeHazardCu supplied by the Map service (§5.2)
 * @returns {{ ok: boolean, milliCU: bigint|null, breakdown: object|null, missing: string[] }}
 */
function evaluate(plan, input) {
  assertFeasible(plan, "cost/cRisk.evaluate");

  const source = input || {};
  const missing = [];

  const failureProbability = source.failure && source.failure.probability;
  if (!isProbability(failureProbability)) missing.push("p_fail");
  if (!isNumber(source.failureConsequenceCu) || source.failureConsequenceCu < 0) missing.push("cost.failure.cu");
  if (!isProbability(source.lateProbability)) missing.push("p_late");
  if (typeof source.overrunMilliCU !== "bigint") missing.push("E[C_delay overrun | late]");
  if (!isNumber(source.routeHazardCu) || source.routeHazardCu < 0) missing.push("route_hazard_cost");

  const energy = energyShortfall(source.tierProbabilities, source.energyConsequenceCu);
  if (!energy.ok) missing.push(...energy.missing);

  const staleness = stalenessPenalty(source.staleness);
  if (!staleness.ok) missing.push(...staleness.missing);

  if (missing.length > 0) return { ok: false, milliCU: null, breakdown: null, missing: [...new Set(missing)] };

  const failure = cu(failureProbability * source.failureConsequenceCu);
  // The overrun is already a priced delay cost in milli-CU, so the probability scales an
  // integer quantity rather than a float one: one rounding, at the same boundary as the
  // rest of the term.
  const lateness = milli(
    BigInt(Math.round(Number(source.overrunMilliCU) * source.lateProbability)),
  );
  const hazard = cu(source.routeHazardCu);

  const summed = total(failure, milli(energy.milliCU), lateness, milli(staleness.milliCU), hazard);

  return {
    ok: true,
    milliCU: summed.milliCU,
    breakdown: Object.freeze({
      [COMPONENT.FAILURE]: Object.freeze({
        probability: failureProbability,
        provenance: (source.failure && source.failure.provenance) || null,
        consequenceCu: source.failureConsequenceCu,
        milliCU: failure.milliCU,
      }),
      [COMPONENT.ENERGY]: Object.freeze({ perTier: energy.perTier, milliCU: energy.milliCU }),
      [COMPONENT.LATENESS]: Object.freeze({
        probability: source.lateProbability,
        overrunMilliCU: source.overrunMilliCU,
        milliCU: lateness.milliCU,
      }),
      [COMPONENT.STALENESS]: Object.freeze({
        oldestAgeSeconds: staleness.oldestAgeSeconds,
        oldestKind: staleness.oldestKind,
        milliCU: staleness.milliCU,
      }),
      [COMPONENT.ROUTE_HAZARD]: Object.freeze({ cu: source.routeHazardCu, milliCU: hazard.milliCU }),
    }),
    missing: [],
  };
}

module.exports = {
  MS_PER_SECOND,
  ENERGY_TIERS,
  COMPONENT,
  energyShortfall,
  stalenessPenalty,
  evaluate,
};
