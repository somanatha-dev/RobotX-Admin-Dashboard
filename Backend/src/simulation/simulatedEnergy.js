"use strict";

/**
 * The simulator's energy consumption — routed through §14.2's model, not around it.
 *
 * ── One model, two consumers ────────────────────────────────────────────────
 * The assignment engine *predicts* a leg's energy with
 * `engine/energy/consumption.legEnergyWh`. Until this module, the simulator *consumed*
 * energy with `battery -= BATTERY_DRAIN_ACTIVE`, a flat percentage per tick that knows
 * nothing about mass, payload, gradient, duration or temperature. So the two halves of
 * the same system disagreed about physics by construction, and any comparison between
 * them measured the gap between two models rather than anything about the world.
 *
 * This module removes the second model. It builds §14.2's leg profile from the
 * simulator's own state and calls **the same function the engine calls**. It contains no
 * energy equation of its own, and adding one here would defeat the entire point.
 *
 * ── This is internal consistency, NOT physical validation ───────────────────
 * Making the simulator and the engine agree makes them *coherent*. It does not make
 * either of them *right*, and nothing here is evidence about a real vehicle:
 *
 *   * `sim:fidelity` stays `UNVALIDATABLE` — agreement between two halves of one program
 *     is not a fidelity measurement, and §24.4's gate is about a model against reality;
 *   * no coefficient is calibrated by running this;
 *   * no output of this module is physical evidence or Safety evidence.
 *
 * ── Fail-closed, and labelled when it cannot ────────────────────────────────
 * `legEnergyWh` refuses unless every §14.2 coefficient and every profile field is
 * present. On this deployment **no β coefficient and no thermal curve has been declared**
 * — `agentEnergyProvisioning` writes the parameter row with all of them null precisely so
 * the refusal names them — and **no terrain source exists**, so `climbM` and `descentM`
 * are absent too. The model therefore refuses today, and that refusal is correct.
 *
 * A development simulator whose pack never discharges is useless, so consumption falls
 * back to the legacy percentage rate. The fallback is **explicitly labelled** and carries
 * the refusal's `missing` list with it, exactly as `VirtualRobot._assessOfferEnergy`
 * already distinguishes `MODELLED_WH` from `LEGACY_PERCENTAGE`. What that label means:
 *
 *   * `MODELLED_WH` — the §14.2 model produced this number.
 *   * `LEGACY_PERCENTAGE` — **it did not.** A flat development rate produced it. It is
 *     not calibrated, not physical, and not evidence of anything. `missing` says exactly
 *     which owner declarations would move this robot onto the real path.
 *
 * The fallback is never silent: `VirtualRobot.getStatus()` reports the basis and the
 * missing list on every read, so a run cannot quietly appear to be modelling physics it
 * is not.
 */

const consumption = require("../engine/energy/consumption");

/**
 * The bases a tick's consumption can be computed on. Same vocabulary
 * `_assessOfferEnergy` uses, deliberately: one word means one thing across the agent.
 * @structural the two named bases, not tunable values
 */
const ENERGY_BASIS = Object.freeze({
  MODELLED: "MODELLED_WH",
  LEGACY: "LEGACY_PERCENTAGE",
});

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Assemble §14.2's leg profile from the simulator's own state.
 *
 * ── Every field is a fact the simulator actually holds, or it is absent ─────
 * There is no defaulting here. A field the simulator cannot legitimately answer is left
 * off the object entirely, so `legEnergyWh` reports it by name and the caller fails
 * closed. In particular:
 *
 *   * **`climbM` / `descentM`** are included **only** when a caller supplies real terrain.
 *     There is no elevation source in this deployment — `executionGeometry` returns a
 *     polyline and Mapbox is not queried for elevation — so in ordinary operation they are
 *     absent and the model refuses. Writing `0` would assert the campus is flat, which is
 *     both unknown and, on a route with gradient, the error that strands a vehicle.
 *   * **`payloadMassKg`** is `0` only when the agent is provably carrying nothing (it has
 *     not reached its pickup, or has already dropped). Zero is a *known* mass, not a
 *     default. When the agent is carrying and no mass was declared, the field is absent.
 *   * **`stopStartCycles`** is the simulator's own count of its stop-and-move transitions.
 *     It is measured by the thing doing the stopping, so it is legitimate.
 *
 * @param {object} input
 * @returns {object} a profile in `legEnergyWh`'s shape, with unknown fields omitted
 */
function buildLegProfile(input) {
  const source = input || {};
  const profile = {};

  const carry = (key, value) => {
    if (isNumber(value)) profile[key] = value;
  };

  carry("distanceM", source.distanceM);
  carry("movingSeconds", source.movingSeconds);
  carry("dwellSeconds", source.dwellSeconds);
  carry("totalSeconds", source.totalSeconds);
  carry("stopStartCycles", source.stopStartCycles);
  carry("vehicleMassKg", source.vehicleMassKg);
  carry("payloadMassKg", source.payloadMassKg);
  carry("ambientC", source.ambientC);
  carry("packC", source.packC);

  // Terrain, and only when it is real. `terrain` is an explicit object a caller supplies
  // when it has an elevation source; there is deliberately no way to reach these two
  // fields by accident.
  const terrain = source.terrain;
  if (terrain && typeof terrain === "object") {
    carry("climbM", terrain.climbM);
    carry("descentM", terrain.descentM);
  }

  // An unconditioned compartment draws nothing for conditioning, and `legEnergyWh`
  // already distinguishes a stated absence of thermal class (zero) from an unfitted curve
  // (unknown). The simulated fleet declares no conditioned compartments, so an empty list
  // is the accurate statement — not a missing input.
  profile.compartmentOccupancy = Array.isArray(source.compartmentOccupancy)
    ? source.compartmentOccupancy
    : [];

  return profile;
}

/**
 * One tick's energy consumption, as watt-hours and as a state-of-charge delta.
 *
 * ── How watt-hours become a percentage ──────────────────────────────────────
 * `socDeltaPercent = 100 · Wh / packNominalWh`. **Nominal** capacity, and the choice is
 * deliberate rather than convenient: §14.5's usable energy is
 * `packNominalWh · SoH · f_temp · SoC / f_derate`, and `SoH` is **undeclared** — this
 * deployment has no measured state of health and `agentEnergyProvisioning` writes it null
 * rather than assuming 1.0. `energy/usable.js` therefore refuses, correctly, and it is
 * not called here. Dividing by nominal capacity is stated arithmetic on a declared
 * number; it is *not* §14.5's usable-energy model and must not be reported as one.
 *
 * @param {object} input
 * @param {object|null} input.model coefficients in `legEnergyWh`'s naming, or null
 * @param {object} input.profile from `buildLegProfile`
 * @param {number} input.kappa the agent's κ
 * @param {number|null} input.packNominalWh the commissioned pack capacity
 * @param {number} input.legacyPercent the fallback drain for this tick, in percentage points
 * @returns {{ basis: string, wh: number|null, socDeltaPercent: number,
 *             missing: string[], terms: object|null }}
 */
function tickEnergy(input) {
  const source = input || {};
  const legacyPercent = isNumber(source.legacyPercent) ? source.legacyPercent : 0;

  const evaluated = consumption.legEnergyWh(source.model, source.profile, source.kappa);

  // The model refused, or there is no pack capacity to express its answer against. Either
  // way this tick is NOT modelled, and says so.
  if (!evaluated.ok) {
    return {
      basis: ENERGY_BASIS.LEGACY,
      wh: null,
      socDeltaPercent: legacyPercent,
      missing: evaluated.missing,
      terms: null,
    };
  }

  if (!isNumber(source.packNominalWh) || source.packNominalWh <= 0) {
    return {
      basis: ENERGY_BASIS.LEGACY,
      wh: evaluated.wh,
      socDeltaPercent: legacyPercent,
      // Named the way `legEnergyWh` names its own inputs, so one list reads uniformly.
      missing: ["packNominalWh"],
      terms: evaluated.terms,
    };
  }

  // @structural fraction to percentage
  const socDeltaPercent = (evaluated.wh / source.packNominalWh) * 100;

  return {
    basis: ENERGY_BASIS.MODELLED,
    wh: evaluated.wh,
    socDeltaPercent,
    missing: [],
    terms: evaluated.terms,
  };
}

module.exports = {
  ENERGY_BASIS,
  buildLegProfile,
  tickEnergy,
};
