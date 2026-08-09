"use strict";

/**
 * `LB(a, l)` — the admissible lower bound on a single-Leg column's price (§6.4).
 * **Tier 1.**
 *
 * ```
 * LB(a, l) =   ( great_circle( position(a), first_stop(l) ) / v_max(class(a)) ) · λ_min
 *            + wait_until_available(a) · λ_min
 *            + E_min(a, l) · cu_per_wh
 *            + C_delay[l]( earliest_possible_completion(a, l) )
 *            − Ω_terminal(region, decision_time)
 *            − Ω_policy
 * ```
 *
 * Computable **without routing** — every term is a provable underestimate reachable
 * from the agent snapshot, the Leg's declared targets, and the config register alone.
 * That is the property `candidates/expansion.js`'s pruning rule depends on: a cell can
 * be discarded from its boundary geometry before any of its member agents is scored
 * against a routed plan.
 *
 * ── Why each positive term is safe to underestimate ──────────────────────────
 * `travelAndWaitMilliCU` — great-circle distance is the shortest possible path on any
 * network; `maxSpeedMs` is declared as an upper bound on achievable speed, so dividing
 * by it cannot overstate the fastest possible travel time; `cost.lambda_time_floor` is
 * itself a configured floor on `cost.lambda_time` (checked at publish — see
 * `candidates/admissibilityGate.js`), so pricing time at the floor cannot overprice it
 * relative to what `C_direct`/`C_delay` actually use.
 *
 * `energyMilliCU` — §6.4: "`E_min` uses the best-case consumption coefficient over the
 * straight-line distance." This module computes it as `κ(a) · β_dist(class) · distance`
 * — the one term of §14.2's equation that is present at every mission regardless of
 * terrain, mass, or dwell, with every other addend (climb, mass, move-time,
 * stop-start, dwell, aux, thermal) omitted. Because §14.2's equation adds each of
 * those non-negatively and floors the bracket at zero before applying `κ`, omitting
 * them can only *reduce* the estimate relative to the true `E_leg` in the ordinary
 * case. **One caveat, recorded rather than silently resolved**: §14.2's regenerative
 * term is *subtracted* inside the bracket before the floor, so a steeply net-descending
 * route can in principle realise a true `E_leg` below `β_dist · distance` — a case this
 * distance-only estimate does not see, because the climb/descent profile it would need
 * comes from routing, which §6.4 explicitly puts out of scope for this bound. §6.4's
 * own text names exactly this formula as the intended underestimate without qualifying
 * it against regeneration, so this module implements it literally; see
 * `PHASE_9_IMPLEMENTATION_REPORT.md` for the escalation.
 *
 * `delayMilliCU` — `cost/cDelay.forLeg()` evaluated at the Leg's earliest physically
 * possible completion time, which is monotonically increasing in completion time by
 * construction (§8.7), so no later, routed completion time can price lower.
 *
 * ── Why the corrections are safe to subtract ─────────────────────────────────
 * `candidates/omega.js` supplies one combined, non-negative milli-CU quantity —
 * `Ω_terminal + Ω_policy` — which this module subtracts once. See that module for why
 * each half is itself an admissible bound on the *most negative* value its own term
 * (`C_opportunity`, `C_policy`) could contribute.
 *
 * T6: no wall-clock read, no randomness — every time value arrives as an input.
 */

const { assertInt64, subtract } = require("../determinism/fixedPoint");
const { milli, total } = require("../cost/units");
const { apply } = require("../cost/exchangeRates");
const cDelay = require("../cost/cDelay");
const { greatCircleMetres } = require("../spatial/cells");
const { COEFFICIENT } = require("../energy/consumption");

/**
 * @param {*} value
 * @returns {boolean}
 */
function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * @param {object} agent
 * @returns {number|null}
 */
function maxSpeedMsOf(agent) {
  const limits = agent && agent.mobilityModel && agent.mobilityModel.kinematicLimits;
  const value = limits && limits.maxSpeedMs;
  return isNumber(value) && value > 0 ? value : null;
}

/**
 * `LB(a, l)` in int64 milli-CU.
 *
 * @param {object} input
 * @param {object} input.agent an agent snapshot: `{ lat, lon, mobilityModel:
 *   { kinematicLimits: { maxSpeedMs } } }`
 * @param {number} input.waitUntilAvailableSeconds `wait_until_available(a)` — 0 for an
 *   agent that is `IDLE_READY` now
 * @param {object} input.energy `{ kappa, model }` — `model` is the agent class's
 *   `EnergyModelParams` (only `beta_dist` is read)
 * @param {object} input.leg the pending Leg, carrying both the spatial fields this
 *   bound needs and the `cost/cDelay.forLeg` fields: `{ legId, firstStopLat,
 *   firstStopLon, earliestPossibleCompletionMs, role, targetMs, deadlineMs,
 *   queueAgeSeconds }`
 * @param {object} input.rates `{ lambdaTimeFloor, cuPerWh }` — rates built by
 *   `cost/exchangeRates.ratesFrom()` for `cost.lambda_time_floor` and
 *   `cost.energy.cu_per_wh`
 * @param {object} input.delayParameters passed through to `cost/cDelay.forLeg` as its
 *   `parameters` argument
 * @param {{ milliCU: bigint, breakdown?: object }} input.correction the combined
 *   `Ω_terminal + Ω_policy` from `candidates/omega.combinedCorrection()`
 * @returns {{ ok: boolean, milliCU: bigint|null, breakdown: object|null, missing: string[] }}
 */
function lowerBound(input) {
  const source = input || {};
  const missing = [];

  const agent = source.agent || {};
  if (!isNumber(agent.lat) || !isNumber(agent.lon)) missing.push("agent.lat/agent.lon");
  const maxSpeedMs = maxSpeedMsOf(agent);
  if (maxSpeedMs === null) missing.push("agent.mobilityModel.kinematicLimits.maxSpeedMs");

  if (!isNumber(source.waitUntilAvailableSeconds) || source.waitUntilAvailableSeconds < 0) {
    missing.push("waitUntilAvailableSeconds");
  }

  const energy = source.energy || {};
  const kappa = energy.kappa;
  if (!isNumber(kappa) || kappa <= 0) missing.push("energy.kappa");
  const betaDist = energy.model && energy.model[COEFFICIENT.DIST];
  if (!isNumber(betaDist) || betaDist < 0) missing.push(`energy.model.${COEFFICIENT.DIST}`);

  const leg = source.leg || {};
  if (!isNumber(leg.firstStopLat) || !isNumber(leg.firstStopLon)) missing.push("leg.firstStopLat/leg.firstStopLon");
  if (!isNumber(leg.earliestPossibleCompletionMs)) missing.push("leg.earliestPossibleCompletionMs");

  const rates = source.rates || {};
  if (!rates.lambdaTimeFloor || typeof rates.lambdaTimeFloor.value !== "number") {
    missing.push("cost.lambda_time_floor");
  }
  if (!rates.cuPerWh || typeof rates.cuPerWh.value !== "number") missing.push("cost.energy.cu_per_wh");

  if (!source.correction || typeof source.correction.milliCU !== "bigint") {
    missing.push("correction (candidates/omega.combinedCorrection)");
  }

  if (missing.length > 0) {
    return { ok: false, milliCU: null, breakdown: null, missing: [...new Set(missing)] };
  }

  const distanceM = greatCircleMetres(agent.lat, agent.lon, leg.firstStopLat, leg.firstStopLon);

  const travelSeconds = distanceM / maxSpeedMs;
  const totalSeconds = travelSeconds + source.waitUntilAvailableSeconds;
  const travelAndWait = apply(rates.lambdaTimeFloor, totalSeconds, "s");

  const eMinWh = Math.max(0, kappa * betaDist * distanceM);
  const energyTerm = apply(rates.cuPerWh, eMinWh, "Wh");

  const delayResult = cDelay.forLeg(leg, leg.earliestPossibleCompletionMs, source.delayParameters);
  if (!delayResult.ok) {
    return {
      ok: false,
      milliCU: null,
      breakdown: null,
      missing: delayResult.missing.map((name) => `cost.cDelay: ${name}`),
    };
  }

  const positiveSum = total(travelAndWait, energyTerm, milli(delayResult.milliCU));
  const boundMilliCU = subtract(positiveSum.milliCU, source.correction.milliCU);

  return {
    ok: true,
    milliCU: assertInt64(boundMilliCU, "lowerBound"),
    breakdown: Object.freeze({
      agentId: agent.agentId ?? null,
      legId: leg.legId ?? null,
      distanceM,
      maxSpeedMs,
      travelSeconds,
      waitUntilAvailableSeconds: source.waitUntilAvailableSeconds,
      travelAndWaitMilliCU: travelAndWait.milliCU,
      kappa,
      betaDist,
      eMinWh,
      energyMilliCU: energyTerm.milliCU,
      delayMilliCU: delayResult.milliCU,
      positiveSumMilliCU: positiveSum.milliCU,
      correctionMilliCU: source.correction.milliCU,
      correctionBreakdown: source.correction.breakdown ?? null,
      boundMilliCU,
    }),
    missing: [],
  };
}

module.exports = {
  maxSpeedMsOf,
  lowerBound,
};
