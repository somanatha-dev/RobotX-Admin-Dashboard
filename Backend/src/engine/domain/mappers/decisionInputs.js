"use strict";

/**
 * Persisted rows → the input shapes the decision path's own modules take.
 *
 * ── Why these live here and not beside either caller ────────────────────────
 * Both functions below were written inside `controllers/diagnostics.controller.js`, with
 * a stated reason: *"Kept beside the endpoint that needs it rather than added to
 * `consumption.js`, whose contract is the coefficient object, not the row it came from."*
 * That reasoning is still right about `consumption.js` and it is no longer right about
 * the location, because a **second** caller now exists — `workers/coordinatorSolvePath.js`,
 * the coordinator's solve-path assembly, which needs exactly the same two conversions.
 *
 * Copying thirteen lines of column renaming into the composition root would have created
 * the one failure mode this directory exists to prevent: two mappings of one schema, free
 * to disagree after the next migration, with the diagnostic endpoint and the decision path
 * then reporting different energy for the same agent. `domain/mappers/` is where a
 * row-shape-to-engine-shape adapter belongs — it is what `legacyRobot.js` and
 * `legacyTask.js` already are.
 *
 * **Nothing here defaults, infers, or fills in.** Every function returns `null` for an
 * input it cannot resolve, and the module that receives the `null` is the one that
 * refuses. A mapper that substituted a plausible coefficient would defeat a fail-closed
 * check one layer down, which is the E-8 defect exactly.
 *
 * Tier 1 by path (`src/engine/`). No clock, no randomness, no I/O.
 */

const consumption = require("../../energy/consumption");

/**
 * `EnergyModelParams` as `energy/consumption.js` reads a model: an object keyed by
 * §14.2's coefficient names (`beta_dist`, …), not the camelCase Prisma columns.
 *
 * This adapter exists because the two spellings are genuinely different and nothing else
 * converts between them. Reading `params.coefficients` — a column `EnergyModelParams` does
 * not have — yields `undefined` for every coefficient and therefore an unresolvable
 * `LB(a, l)` on every agent, which is what the diagnostics endpoint did before the Phase 9
 * closure.
 *
 * @param {object|null} params an `EnergyModelParams` row
 * @returns {object|null} a coefficient object, or `null` when there is no row
 */
function energyCoefficientsFrom(params) {
  if (!params) return null;
  return {
    [consumption.COEFFICIENT.DIST]: params.betaDist,
    [consumption.COEFFICIENT.MASS]: params.betaMass,
    [consumption.COEFFICIENT.CLIMB]: params.betaClimb,
    [consumption.COEFFICIENT.REGEN]: params.betaRegen,
    [consumption.COEFFICIENT.MOVE_TIME]: params.betaMoveTime,
    [consumption.COEFFICIENT.STOP_START]: params.betaStopStart,
    [consumption.COEFFICIENT.DWELL]: params.betaDwell,
    [consumption.COEFFICIENT.AUX]: params.betaAux,
    [consumption.COEFFICIENT.THERMAL]: params.betaThermal,
    [consumption.COEFFICIENT.PAYLOAD_THERMAL]: params.betaPayloadThermal,
    [consumption.COEFFICIENT.REGEN_EFFICIENCY]: params.etaRegen,
  };
}

/**
 * The fleet-wide best-case speed/energy coefficients `unexploredRingFloorMilliCU` needs
 * (§6.4), derived from whichever candidates a sweep actually found — the fastest declared
 * speed and the cheapest `β_dist` among them.
 *
 * An honest, request-scoped proxy for "the fleet's own best-case class", not a fleet-wide
 * configuration lookup. It is a **floor** input: taking the maximum speed and the minimum
 * `β_dist` over the agents actually reached can only make the ring floor smaller, which is
 * the admissible direction (§6.4 — a bound that is too small still bounds).
 *
 * `κ_min` is `1` because `κ` is §14.2's *self-correcting multiplier*, whose neutral value
 * is one and whose registered bounds (`energy.kappa_bounds`) admit values below it: taking
 * the observed minimum over this sweep's agents would make the floor depend on which
 * agents happened to be found, and taking anything above one would raise the floor, which
 * is the inadmissible direction.
 *
 * Returns `null` — never a partial object — when either factor is unresolvable across
 * every row, because `unexploredRingFloorMilliCU` names its missing inputs and a
 * half-filled object would name the wrong one.
 *
 * @param {object[]} positions `AgentCellPosition` rows with `agent.agentClass` included
 * @returns {{ maxSpeedMs: number, kappaMin: number, betaDistMin: number }|null}
 */
function fleetBestCaseFrom(positions) {
  let maxSpeedMs = null;
  let betaDistMin = null;

  for (const position of positions || []) {
    const agentClass = position && position.agent && position.agent.agentClass;
    const limits = agentClass && agentClass.mobilityModel && agentClass.mobilityModel.kinematicLimits;
    if (limits && Number.isFinite(limits.maxSpeedMs)) {
      maxSpeedMs = maxSpeedMs === null ? limits.maxSpeedMs : Math.max(maxSpeedMs, limits.maxSpeedMs);
    }
    const params = agentClass && agentClass.energyModelParams && agentClass.energyModelParams[0];
    const coefficients = energyCoefficientsFrom(params);
    const betaDist = coefficients && coefficients[consumption.COEFFICIENT.DIST];
    if (Number.isFinite(betaDist)) {
      betaDistMin = betaDistMin === null ? betaDist : Math.min(betaDistMin, betaDist);
    }
  }

  if (maxSpeedMs === null || betaDistMin === null) return null;
  // @structural κ's neutral multiplier — the identity of a self-correcting factor (§14.2),
  // not a calibrated value
  return { maxSpeedMs, kappaMin: 1, betaDistMin };
}

module.exports = {
  energyCoefficientsFrom,
  fleetBestCaseFrom,
};
