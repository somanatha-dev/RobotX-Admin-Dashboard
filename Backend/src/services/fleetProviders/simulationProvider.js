"use strict";

/**
 * The **simulation provider** — the existing DEVELOPMENT_SIMULATION inputs, presented behind
 * the fleet provider boundary (`fleetProviders/index.js`).
 *
 * ── A wrapper, and nothing else ────────────────────────────────────────────
 * Every value this provider hands out is produced by a module that already existed and is
 * not edited here:
 *
 *   route, profile key, speed, return-leg Wh/m, energy declarations, route descriptor,
 *   forecast, thermal multiplier, failure probability, route hazard, environment,
 *   directions, agent facts          → `services/v1DemonstrationComposition` (as built)
 *   charging scope                   → the simulator's own roster (`managesAgent`)
 *
 * The composition object is taken **as built** and its seams are returned by reference, so
 * a seam answered by this provider is the same function the process would have called
 * without the boundary. The only thing this module adds is the three ownership questions
 * the dispatcher asks — and each of those is answered by the module that already owns it:
 *
 *   ownsRobot(robot)        `simulationPolicy.isSimulatedRobot` — the single reader of the
 *                           discriminator, exactly as `agentFacts.service` asks it
 *   ownsSnapshot(snapshot)  `v1DemonstrationComposition.isSimulatedSnapshot` — the check
 *                           every simulation seam already gates itself on
 *   ownsProfileKey(key)     the `SIMULATED:` routing-profile namespace
 *                           `v1DemonstrationComposition.simulatedProfileKeyFor` issues
 *
 * None of these answers reaches the engine. They decide where a fact comes from, never
 * what the engine does with it.
 */

const simulationPolicy = require("../../simulation/simulationPolicy");
const v1DemonstrationComposition = require("../v1DemonstrationComposition");

/** @structural the provider's name, for logs and diagnostics only */
const ID = "SIMULATION";

/**
 * The routing-profile namespace a simulated agent's key is issued in
 * (`v1DemonstrationComposition.simulatedProfileKeyFor` → `SIMULATED:v=…:wh=…`).
 * `tests/engine/fleetProviderBoundary.test.js` pins it against the issuer, so the two
 * cannot drift apart silently.
 * @structural
 */
const SIMULATED_PROFILE_NAMESPACE = "SIMULATED:";

/**
 * @param {object} settings
 * @param {object} settings.composition the object `createV1DemonstrationComposition` returned
 * @param {(subject: object) => boolean} [settings.managesAgent] the simulator's roster
 *   (`SimulationEngine.managesAgent`); absent means no agent is in charging scope
 * @returns {object} the provider
 */
function createSimulationProvider(settings) {
  const { composition, managesAgent } = settings || {};
  if (!composition || typeof composition !== "object") {
    throw new TypeError("createSimulationProvider wraps an existing V1 demonstration composition; none was given");
  }

  return Object.freeze({
    id: ID,
    seams: composition,

    ownsRobot: (robot) => simulationPolicy.isSimulatedRobot(robot),
    ownsSnapshot: (snapshot) => v1DemonstrationComposition.isSimulatedSnapshot(snapshot),
    ownsProfileKey: (profileKey) => typeof profileKey === "string" && profileKey.startsWith(SIMULATED_PROFILE_NAMESPACE),

    /**
     * Is this agent covered by the development Charging Scheduler? The roster answers,
     * exactly as `server.js` asked it before this boundary existed. Awaited, because a
     * roster predicate may be asynchronous.
     */
    chargingInScope: async (subject) => (typeof managesAgent === "function" ? (await managesAgent(subject)) === true : false),
  });
}

/**
 * Build the V1 demonstration composition and wrap it. Throws exactly as
 * `createV1DemonstrationComposition` does when the simulator is not enabled.
 *
 * @param {object} settings as `createV1DemonstrationComposition`, plus `managesAgent`
 * @returns {object}
 */
function fromSettings(settings) {
  const composition = v1DemonstrationComposition.createV1DemonstrationComposition(settings);
  return createSimulationProvider({ composition, managesAgent: settings && settings.managesAgent });
}

module.exports = {
  ID,
  SIMULATED_PROFILE_NAMESPACE,
  createSimulationProvider,
  fromSettings,
};
