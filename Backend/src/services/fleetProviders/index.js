"use strict";

/**
 * The **fleet provider boundary** — one set of coordinator input seams for a fleet that holds
 * simulated and physical agents at once.
 *
 * ── The rule this module exists to keep ────────────────────────────────────
 * The assignment engine never chooses, admits, rejects, prices or ranks an agent because it
 * is physical or simulated. That distinction is a *data-source* distinction and lives only
 * here, below the seams: each provider supplies the same normalised facts in the same field
 * names, and the engine evaluates every agent through the same candidate → feasibility →
 * routing → energy → ranking → commitment path. `tests/engine/simulationBoundary.test.js`
 * holds the engine side of that structurally.
 *
 * ── What `createFleetComposition` returns ──────────────────────────────────
 * Exactly the seam object `v1DemonstrationComposition` returns — the same keys, each the
 * same kind of value — so it is spread into `leaderWorkers.create()` where that one was.
 * Each seam asks one question to pick the provider that answers it, using the key the seam
 * is already called with. No new field is added to anything the engine reads:
 *
 *   keyed by the agent SNAPSHOT     `snapshot.provenance`, stamped by the agent-facts
 *                                   provider that built it (`ownsSnapshot`)
 *   keyed by the raw ROBOT row      the simulation discriminator, through
 *                                   `simulationPolicy` (`ownsRobot`)
 *   keyed by a ROUTING PROFILE      the profile-key namespace — `route(parts)` carries no
 *                                   agent id (`ownsProfileKey`)
 *   keyed by a PLAN                 the provenance of the route descriptor the plan was
 *                                   built on (`ownsSnapshot(plan.route)`)
 *
 * Whatever the simulation provider does not own goes to the physical provider, which
 * answers only from real sources and otherwise answers *absent*. That is the fail-closed
 * direction: an agent nobody vouches for gets no facts and §7.5 denies it by name.
 *
 * The provider choice is made inside the seam call and is never returned, recorded or
 * attached to any value the engine receives.
 *
 * Mission-scoped seams (`missionProfileFor`, `defaultConsignmentFor`,
 * `defaultStopAccessPrerequisites`) and the process-level declarations (`timeBucket`,
 * `hopTerrainSource`, `travelTimeSpread`, `routeEndpointBasis`, `v1Demonstration`) describe the Leg or the round,
 * not an agent, so they are passed through unchanged from the V1 demonstration composition,
 * which is their only source today.
 */

const logger = require("../../config/logger");
const v1DemonstrationComposition = require("../v1DemonstrationComposition");
const profile = require("../v1DemonstrationProfile");
const simulationProvider = require("./simulationProvider");
const physicalProvider = require("./physicalProvider");
const physicalPolicy = require("./physicalPolicy");

/** The environment variable that selects this dispatcher. Infrastructure only. @structural */
const ENV_VAR = "FLEET_PROVIDER_DISPATCH";

/** Seams keyed by the agent snapshot, and where in the call's arguments it sits. @structural */
const SNAPSHOT_SEAMS = Object.freeze({
  profileKeyFor: (args) => args[0],
  agentEnergyDeclarationsFor: (args) => args[0],
  vehicleMassKgFor: (args) => args[1],
  routeDescriptorFor: (args) => (args[0] ? args[0].agentSnapshot : undefined),
  environmentForecastFor: (args) => args[0],
  thermalStressMultiplierFor: (args) => args[0],
  failureProbabilityFor: (args) => args[0],
  batteryWearInputsFor: (args) => args[0],
  directionsFor: (args) => args[0],
});

/** Seams keyed by the raw `Robot` row. @structural */
const ROBOT_SEAMS = Object.freeze({
  agentFactsFor: (args) => (args[0] && args[0].agent ? args[0].agent.robot : undefined),
  environmentFor: (args) => (args[1] ? args[1].robot : undefined),
});

/** Seams keyed by a routing profile key. @structural */
const PROFILE_KEY_SEAMS = Object.freeze({
  route: (args) => (args[0] ? args[0].profileKey : undefined),
  speedMetresPerSecondFor: (args) => args[0],
  returnLegEnergyWhPerMetreFor: (args) => args[0],
});

/** Seams keyed by a plan's route descriptor. @structural */
const PLAN_SEAMS = Object.freeze({
  routeHazardCuFor: (args) => (args[0] ? args[0].route : undefined),
});

/** Seams passed through unchanged: mission-scoped, or process-level declarations. @structural */
const PASS_THROUGH = Object.freeze([
  "v1Demonstration",
  "hopTerrainSource",
  "travelTimeSpread",
  "timeBucket",
  "routeEndpointBasis",
  "missionProfileFor",
  "defaultConsignmentFor",
  "defaultStopAccessPrerequisites",
]);

/** Every seam this composition returns — exactly the V1 demonstration composition's. @structural */
const SEAMS = Object.freeze([
  ...PASS_THROUGH,
  ...Object.keys(SNAPSHOT_SEAMS),
  ...Object.keys(ROBOT_SEAMS),
  ...Object.keys(PROFILE_KEY_SEAMS),
  ...Object.keys(PLAN_SEAMS),
]);

/** Marks a dispatched composition without adding an enumerable (spreadable) key. */
const DISPATCH_MARK = Symbol.for("robotx.fleetProviders.dispatch");

function assertProvider(provider, role, required) {
  if (!provider || typeof provider !== "object" || !provider.seams || typeof provider.seams !== "object") {
    throw new TypeError(`createFleetComposition requires a ${role} provider with a seams object`);
  }
  for (const name of required) {
    if (typeof provider[name] !== "function") throw new TypeError(`the ${role} provider must implement ${name}()`);
  }
}

/**
 * @param {object} providers
 * @param {object} [providers.simulation] `simulationProvider.createSimulationProvider(…)`; absent
 *   in a process that runs no simulator, in which case nothing is owned by it
 * @param {object} providers.physical `physicalProvider.createPhysicalProvider(…)`
 * @returns {object} the coordinator's seams
 */
function createFleetComposition(providers) {
  const { simulation, physical } = providers || {};
  assertProvider(physical, "physical", ["chargingInScope"]);
  if (simulation !== undefined && simulation !== null) {
    assertProvider(simulation, "simulation", ["ownsRobot", "ownsSnapshot", "ownsProfileKey", "chargingInScope"]);
  }
  const sim = simulation || null;

  const byOwner = (owns) => (owns ? sim.seams : physical.seams);
  const dispatchOn = (name, keyOf, owns) =>
    function dispatched(...args) {
      const seams = byOwner(sim !== null && owns(keyOf(args)));
      return seams[name](...args);
    };

  const composition = {};

  if (sim) {
    for (const name of PASS_THROUGH) {
      if (Object.prototype.hasOwnProperty.call(sim.seams, name)) composition[name] = sim.seams[name];
    }
  } else if (physical.processSeams) {
    // Gate 1 (F05) — a process with no simulator: the round- and mission-level declarations
    // come from the physical provider's own (PRODUCTION_DECLARED labels, the V1 mission profile).
    for (const name of PASS_THROUGH) {
      if (Object.prototype.hasOwnProperty.call(physical.processSeams, name)) composition[name] = physical.processSeams[name];
    }
  }
  for (const [name, keyOf] of Object.entries(SNAPSHOT_SEAMS)) {
    composition[name] = dispatchOn(name, keyOf, (snapshot) => sim.ownsSnapshot(snapshot));
  }
  for (const [name, keyOf] of Object.entries(ROBOT_SEAMS)) {
    composition[name] = dispatchOn(name, keyOf, (robot) => sim.ownsRobot(robot));
  }
  for (const [name, keyOf] of Object.entries(PROFILE_KEY_SEAMS)) {
    composition[name] = dispatchOn(name, keyOf, (profileKey) => sim.ownsProfileKey(profileKey));
  }
  for (const [name, keyOf] of Object.entries(PLAN_SEAMS)) {
    composition[name] = dispatchOn(name, keyOf, (routeDescriptor) => sim.ownsSnapshot(routeDescriptor));
  }

  Object.defineProperty(composition, DISPATCH_MARK, {
    value: Object.freeze({ providers: [sim ? sim.id : null, physical.id].filter(Boolean) }),
    enumerable: false,
  });
  return composition;
}

/**
 * The index maintainer's charging-scope predicate, over both providers. Each provider
 * answers only for agents whose charging state it owns: the simulator's roster for a
 * simulated agent, and nobody — yet — for a physical one.
 *
 * Asynchronous, because a provider's answer may be (the demonstration runner's roster
 * predicate is), and `chargingStatus.service` awaits its `inScope`. A pending answer is
 * awaited, never read as a truthy object.
 *
 * @param {{ simulation?: { chargingInScope: Function }, physical: { chargingInScope: Function } }} providers
 * @returns {(subject: object) => Promise<boolean>}
 */
function createChargingScope(providers) {
  const { simulation, physical } = providers || {};
  if (!physical || typeof physical.chargingInScope !== "function") {
    throw new TypeError("createChargingScope requires a physical provider");
  }
  return async (subject) => {
    if (simulation && typeof simulation.chargingInScope === "function" && (await simulation.chargingInScope(subject)) === true) {
      return true;
    }
    return (await physical.chargingInScope(subject)) === true;
  };
}

/**
 * The index maintainer's charging-status reader over both providers (Gate 1, F01). The
 * simulator's reader answers for its roster; any agent it does not know is asked of the
 * physical provider's availability policy, which answers known only for a declared physical
 * unit with a live operator-declared state of charge.
 *
 * @param {{ simulationStatusFor?: Function, physical: { chargingStatusFor: Function } }} readers
 * @returns {(agentRowId: string) => Promise<object>}
 */
function createChargingStatusFor(readers) {
  const { simulationStatusFor, physical } = readers || {};
  if (!physical || typeof physical.chargingStatusFor !== "function") {
    throw new TypeError("createChargingStatusFor requires a physical provider");
  }
  return async (agentRowId) => {
    if (typeof simulationStatusFor === "function") {
      const simulationStatus = await simulationStatusFor(agentRowId);
      if (simulationStatus && simulationStatus.known === true) return simulationStatus;
    }
    return physical.chargingStatusFor(agentRowId);
  };
}

/** Is the dispatcher selected for this process? Default: no. */
function isDispatchEnabled(env) {
  return String(((env || process.env)[ENV_VAR]) || "").trim().toLowerCase() === "true";
}

/** Is this composition the dispatcher? For diagnostics and tests. */
function isFleetComposition(composition) {
  return Boolean(composition && composition[DISPATCH_MARK]);
}

/**
 * Compose for `server.js` under the same gate as `v1DemonstrationComposition.composeIfEnabled`,
 * or return `{}` when this process is not a V1 demonstration.
 *
 * @param {object} settings `{ prisma, kv, snapshot, env }`
 * @returns {object}
 */
function composeIfEnabled(settings) {
  const env = (settings && settings.env) || process.env;
  const physicalFleet = physicalPolicy.isEnabled(env);
  const simulationComposed = v1DemonstrationComposition.isEnabled(env);
  if (!simulationComposed && !physicalFleet) return {};
  const physical =
    (settings && settings.physical) ||
    physicalProvider.createPhysicalProvider({
      prisma: settings.prisma,
      kv: settings.kv,
      tenantId: profile.DEMONSTRATION_TENANT_ID,
      // Gate 1 — the physical fleet declaration and the pinned snapshot (for routing) only when
      // the process opted into the physical fleet; otherwise the P1 provider, unchanged.
      ...(physicalFleet ? { snapshot: settings.snapshot, policy: physicalPolicy.load(env) } : {}),
    });
  if (!simulationComposed) {
    const composition = createFleetComposition({ simulation: null, physical });
    logger.warn(
      "[physical] PHYSICAL FLEET composition is active with no simulator: physical agents are priced on real rows and " +
        "the owner's PRODUCTION_DECLARED physical fleet declaration. Declaration problems: " +
        (physical.policy && physical.policy.problems.length > 0 ? physical.policy.problems.join("; ") : "none"),
    );
    return composition;
  }
  const simulation = simulationProvider.fromSettings(settings);
  const composition = createFleetComposition({ simulation, physical });
  logger.warn(
    "[v1] V1 DEMONSTRATION composition is active behind the FLEET PROVIDER boundary: simulated agents are " +
      "priced on DEVELOPMENT_SIMULATION inputs and V1_DEMONSTRATION declarations, physical agents on real " +
      "sources only. NOT PRODUCTION. Physical agents are not admitted until: " +
      v1DemonstrationComposition.PHYSICAL_ROBOT_REPLACEMENTS.map((row) => row.seam).join("; "),
  );
  return composition;
}

module.exports = {
  ENV_VAR,
  SEAMS,
  SNAPSHOT_SEAMS,
  ROBOT_SEAMS,
  PROFILE_KEY_SEAMS,
  PLAN_SEAMS,
  PASS_THROUGH,
  createFleetComposition,
  createChargingScope,
  createChargingStatusFor,
  isDispatchEnabled,
  isFleetComposition,
  composeIfEnabled,
  simulationProvider,
  physicalProvider,
  physicalPolicy,
};
