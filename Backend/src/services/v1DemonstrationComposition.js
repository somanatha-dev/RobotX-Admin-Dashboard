"use strict";

/**
 * The **V1 demonstration composition** — every input seam the coordinator's solve path
 * declares (`workers/coordinatorPipeline`), supplied from the providers that exist today.
 *
 * ── What it is ─────────────────────────────────────────────────────────────
 * One object, spread into the `leaderWorkers.create()` context by `server.js` and by
 * `tools/demo/runV1Assignment.js`, so the server and the proof run compose the SAME solve
 * path. `server.js` composes it only when `V1_DEMONSTRATION_COMPOSITION=true` and the
 * simulator is enabled.
 *
 * ── What it is NOT ─────────────────────────────────────────────────────────
 *   * **Not an assignment algorithm.** It chooses nothing. Candidate discovery, the 38
 *     predicates, the plan, Φ/γ, the solve and the commit are the engine's, unchanged.
 *   * **Not production data.** Every value is labelled `DEVELOPMENT_SIMULATION` (a fact of
 *     the simulator) or `V1_DEMONSTRATION` (a declared V1 simplification).
 *   * **Not a bypass for physical agents.** Each simulation-derived seam answers only for a
 *     simulated agent (`provenance === DEVELOPMENT_SIMULATION` on its facts). For the
 *     physical RobotX the seams answer nothing, the register stays the authority, and the
 *     predicates deny by name until its real providers are connected — see
 *     `PHYSICAL_ROBOT_REPLACEMENTS`.
 *
 * ── Per seam: the V1 model and what replaces it ────────────────────────────
 *   route / terrain / spread / speed  simulation/simulationRouter over the campus traversal
 *                                     network (simulation/campusTraversalNetwork: the campus
 *                                     OSM extract's permitted ways), between EXACT endpoints;
 *                                     flat: the simulator has no elevation
 *                                                              → a production router (B1)
 *   agentFactsFor                     services/agentFacts + simulatedAgentState
 *                                                              → a control-plane provider
 *   agentEnergyDeclarationsFor        the simulated pack's declared floor + dispersion
 *                                                              → Safety-calibrated register rows
 *   environmentFor                    simulatedEnvironment site model
 *                                                              → telemetry ambient/pack temps
 *   failureProbabilityFor             0 — the simulator has no mission-failure mechanism
 *                                                              → fleet reliability history
 *   routeHazardCuFor                  0 on a simulated route  → the Map service's hazard cost
 *   batteryWearInputsFor              derived from the plan (V1 model, both kinds)
 *   returnLegEnergyWhPerMetreFor      derived from the simulated pack's own β
 *                                                              → per-profile fitted rate
 *   routeDescriptorFor / forecast     the simulated world's surfaces, zones, windows
 *                                                              → map + weather providers
 *   missionProfileFor                 V1_DEMONSTRATION mission profile (both kinds)
 *   directionsFor                     none for a simulated agent: it drives the priced route,
 *                                     which the commit attaches to the OFFER
 *                                                              → Mapbox (default, unchanged)
 */

const logger = require("../config/logger");

const simulationPolicy = require("../simulation/simulationPolicy");
const simulationRouter = require("../simulation/simulationRouter");
const campusTraversalNetwork = require("../simulation/campusTraversalNetwork");
const { ENDPOINT_BASIS } = require("../engine/routing/cellPairCache");
const simulatedAgentState = require("../simulation/simulatedAgentState");

const cellProjection = require("../engine/routing/cellProjection");
const campusTravelModel = require("../engine/routing/campusTravelModel");
const campusServiceability = require("../engine/routing/campusServiceability");
const hierarchy = require("../engine/spatial/hierarchy");
const timeline = require("../engine/plan/timeline");
const { routingProfileKey } = require("../engine/domain/mobilityModel");

const agentFacts = require("./agentFacts.service");
const profile = require("./v1DemonstrationProfile");

/** The environment variable that opts a process into this composition. @structural */
const ENV_VAR = "V1_DEMONSTRATION_COMPOSITION";

/** India Standard Time, for §20.3's congestion bucket. @structural the deployment's offset */
const UTC_OFFSET_SECONDS = 19800;

/**
 * Exactly what must be connected before the physical RobotX can be selected, with the seam
 * each replaces. The assignment engine does not change for any of them.
 * @structural
 */
const PHYSICAL_ROBOT_REPLACEMENTS = Object.freeze([
  { seam: "agentFactsFor (control-plane half)", needs: agentFacts.PHYSICAL_CONTROL_PLANE_FACTS },
  { seam: "route / hopTerrainSource", needs: ["a production router with elevation + stop-start (B1)"] },
  { seam: "routeDescriptorFor", needs: ["surface classes, constrictions, zone windows along the route"] },
  { seam: "environmentForecastFor", needs: ["an ambient forecast source (F31)"] },
  { seam: "environmentFor", needs: ["ambientC / packC from telemetry"] },
  {
    seam: "agentEnergyDeclarationsFor → register",
    needs: ["energy.model_residual_cv and energy.reserve_floor_wh, Safety-approved", "a fitted β set on EnergyModelParams"],
  },
  { seam: "failureProbabilityFor", needs: ["p_fail from reliability history or a cohort prior"] },
  { seam: "routeHazardCuFor", needs: ["the Map service's hazard cost"] },
  { seam: "thermalStressMultiplierFor", needs: ["a pack thermal-stress model"] },
]);

const isNumber = (value) => typeof value === "number" && Number.isFinite(value);

/** Whether an agent snapshot's facts were stated by the simulator. */
function isSimulatedSnapshot(agentSnapshot) {
  return Boolean(agentSnapshot) && agentSnapshot.provenance === simulatedAgentState.PROVENANCE;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function isEnabled(env) {
  const source = env || process.env;
  return String(source[ENV_VAR] || "").toLowerCase() === "true" && simulationPolicy.isSimulatorEnabled(source);
}

/**
 * The simulation router, built on first use from the simulated robots then on file and the
 * pinned snapshot's delivery domain — so a composition made at process start works once the
 * simulator has rehydrated its fleet. A failed build is not cached.
 *
 * @param {object} settings
 * @returns {() => Promise<object>}
 */
function lazyRouter(settings) {
  const { prisma, env, snapshot } = settings;
  let built = null;

  return async function routerNow() {
    if (built) return built;
    const pinned = typeof snapshot === "function" ? snapshot() : snapshot;
    const declaration = pinned && (pinned.deliveryDomain || (pinned.spatial && pinned.spatial.deliveryDomain));
    if (!declaration) throw new Error("the pinned configuration carries no delivery-domain declaration to project cells within");
    const agents = await prisma.robot.findMany({ where: { simulated: true }, select: { robotId: true, simulated: true } });
    // The campus network, from the extract this delivery domain was published from. Refused
    // here, at the build, when the extract cannot be found — the route then names why on
    // every request instead of falling back to a straight line.
    const extract = campusTraversalNetwork.extractForDeclaration(declaration);
    if (!extract.ok) throw new Error(`the campus traversal network cannot be built: ${extract.problems.join("; ")}`);
    const router = simulationRouter.createSimulationRouter({
      projection: cellProjection.createCellProjection({
        serviceability: campusServiceability.createServiceabilityOracle(declaration),
      }),
      travelModel: campusTravelModel.resolveModelParameters(pinned, {}),
      agents,
      mode: "DEVELOPMENT",
      env,
      // Refuses (NO_SPEED) for a profile that is not a simulated one.
      speedFor: speedForProfile,
      // One network per permitted class set, built once from the extract's ways.
      traversalNetworkFor: networksFrom(extract),
    });
    built = router;
    return router;
  };
}

/**
 * The routing profile of a simulated agent: the two quantities its simulated route and its
 * return-leg energy depend on — the speed `VirtualRobot` actually drives at (its
 * commissioned `speedModel.nominalSpeedMps`, which `VirtualRobot` takes ahead of
 * `SPEED_BASE_MS`) and its pack (the drain is a percentage of it).
 *
 * Why per agent: the router used to price every hop at `SPEED_BASE_MS` (5.56 m/s) while a
 * STANDARD-preset unit drives at 1.5 m/s — travel time, and with it the per-second energy
 * draw, understated 3.7×: the permissive direction on F34. Measured 2026-09-23.
 */
const PROFILE_PREFIX = "SIMULATED";

function simulatedProfileKeyFor(agentSnapshot) {
  if (!isSimulatedSnapshot(agentSnapshot)) return null;
  const speedModel = agentSnapshot.mobilityModel && agentSnapshot.mobilityModel.speedModel;
  const nominal = speedModel && isNumber(speedModel.nominalSpeedMps) && speedModel.nominalSpeedMps > 0
    ? speedModel.nominalSpeedMps
    : simulationRouter.SIMULATED_NOMINAL_SPEED_MS;
  const packWh = agentSnapshot.energyModel && isNumber(agentSnapshot.energyModel.packNominalWh)
    ? agentSnapshot.energyModel.packNominalWh
    : simulatedAgentState.simulatedPackDeclaration().packNominalWh;
  // The third thing the route depends on: which ways the class may use
  // (`MobilityModel.permissionSet`), so two classes with different permissions never share a
  // cached route. An empty set is stated, and the router refuses it rather than guessing.
  const permissionSet = agentSnapshot.mobilityModel && agentSnapshot.mobilityModel.permissionSet;
  const network = campusTraversalNetwork.permittedClasses(permissionSet).join("+");
  return `${PROFILE_PREFIX}:v=${nominal}:wh=${packWh}:net=${network}`;
}

/** @returns {{ speed: number, packWh: number, roadClasses: string[] }|null} */
function parseSimulatedProfile(profileKey) {
  const match = /^SIMULATED:v=([0-9.]+):wh=([0-9.]+)(?::net=([a-z_+]*))?$/u.exec(String(profileKey || ""));
  if (!match) return null;
  const speed = Number(match[1]);
  const packWh = Number(match[2]);
  const roadClasses = match[3] ? match[3].split("+").filter(Boolean) : [];
  return isNumber(speed) && speed > 0 && isNumber(packWh) && packWh > 0 ? { speed, packWh, roadClasses } : null;
}

/**
 * The campus network for a simulated profile: the extract's ways of the profile's permitted
 * classes, built once per class set. `undefined` for a profile that is not a simulated one or
 * permits no ways — the router then refuses by name.
 *
 * @param {{ features: object[], file: string }} extract `campusTraversalNetwork.extractForDeclaration`
 * @returns {(profileKey: string) => object|undefined}
 */
function networksFrom(extract) {
  const built = new Map();
  return (profileKey) => {
    const parsed = parseSimulatedProfile(profileKey);
    if (!parsed || parsed.roadClasses.length === 0) return undefined;
    const classKey = parsed.roadClasses.join("+");
    if (!built.has(classKey)) {
      built.set(
        classKey,
        campusTraversalNetwork.createCampusTraversalNetwork({
          features: extract.features,
          roadClasses: parsed.roadClasses,
          source: extract.file,
        }),
      );
    }
    return built.get(classKey);
  };
}

/** The speed a simulated profile drives at, or `undefined` for any other profile. */
function speedForProfile(profileKey) {
  const parsed = parseSimulatedProfile(profileKey);
  return parsed ? parsed.speed : undefined;
}

/**
 * The return-leg energy per metre for a simulated profile: the simulated pack's declared
 * draw (β_aux + β_move_time) over the speed it drives at. Derived, V1.
 *
 * @param {string} profileKey
 * @returns {number|undefined}
 */
function simulatedWhPerMetre(profileKey) {
  const parsed = parseSimulatedProfile(profileKey);
  if (!parsed) return undefined;
  const coefficients = simulatedAgentState.simulatedEnergyCoefficients(parsed.packWh);
  return (coefficients.betaAux + coefficients.betaMoveTime) / parsed.speed;
}

/**
 * §14.4's mission conditions, derived from the plan. A simple V1 model: the mission is one
 * partial cycle of depth `energyWh / usable capacity`, centred on the starting SoC less half
 * that depth, at the pack's temperature and the plan's average power. Any missing input
 * leaves the whole set absent and `energy/wear` names it.
 *
 * @param {object} agentSnapshot
 * @param {object} plan
 * @returns {object|null}
 */
function batteryWearInputsFor(agentSnapshot, plan) {
  const packWh = agentSnapshot && agentSnapshot.energyModel && agentSnapshot.energyModel.packNominalWh;
  const soh = agentSnapshot && agentSnapshot.soh;
  const soc = agentSnapshot && agentSnapshot.soc;
  const energyWh = plan && plan.energyWh;
  const durationSeconds = plan && plan.durationSeconds;
  if (![packWh, soh, soc, energyWh, durationSeconds].every(isNumber) || packWh <= 0 || soh <= 0 || durationSeconds <= 0) {
    return null;
  }
  const dod = Math.min(1, Math.max(0, energyWh / (packWh * soh)));
  return {
    conditions: {
      dod,
      socMid: Math.min(1, Math.max(0, soc - dod / 2)),
      tempC: agentSnapshot.packC,
      cRate: energyWh / (durationSeconds / 3600) / packWh,
    },
    socThroughput: dod,
    provenance: profile.PROVENANCE,
  };
}

/**
 * The execution-geometry provider for a simulated agent: it produces nothing. Its route is
 * the priced one; no route is computed after the decision.
 *
 * @returns {Promise<null>}
 */
async function noIndependentGeometry() {
  return null;
}

/**
 * Build the composition.
 *
 * @param {object} settings
 * @param {object} settings.prisma
 * @param {Function|object} settings.snapshot the pinned configuration (or an accessor)
 * @param {NodeJS.ProcessEnv} [settings.env]
 * @returns {object} the seams, to be spread into the `leaderWorkers.create()` context
 */
function createV1DemonstrationComposition(settings) {
  const { prisma, snapshot, kv } = settings || {};
  const env = (settings && settings.env) || process.env;
  if (!prisma) throw new TypeError("createV1DemonstrationComposition requires prisma");
  if (!simulationPolicy.isSimulatorEnabled(env)) {
    throw new Error(
      `the V1 demonstration composition serves simulated agents and the simulator is not enabled ` +
        `(${simulationPolicy.SIMULATOR_ENV_VAR} is not true)`,
    );
  }

  const routerNow = lazyRouter({ prisma, env, snapshot });
  const pinned = () => (typeof snapshot === "function" ? snapshot() : snapshot);

  return {
    v1Demonstration: Object.freeze({
      provenance: profile.PROVENANCE,
      physicalRobotReplacements: PHYSICAL_ROBOT_REPLACEMENTS,
    }),

    /* ── routing (§5) ─────────────────────────────────────────────────────── */
    route: async (parts) => (await routerNow()).route(parts),
    hopTerrainSource: simulationRouter.SIMULATED_TERRAIN_SOURCE,
    travelTimeSpread: simulationRouter.SIMULATED_SPREAD_SOURCE,
    profileKeyFor: simulatedProfileKeyFor,
    speedMetresPerSecondFor: speedForProfile,
    // §20.3's congestion bucket at composition (promotion) time.
    timeBucket: timeline.hourOfWeek(Date.now(), UTC_OFFSET_SECONDS),
    // The router above routes between exact coordinates, so the round asks it about the
    // agent's exact position and each stop's exact coordinate rather than cell
    // representatives, and the priced route's points become the OFFER's geometry.
    routeEndpointBasis: ENDPOINT_BASIS.EXACT_POINTS,

    /* ── agent facts (§7.5) ───────────────────────────────────────────────── */
    agentFactsFor: agentFacts.createAgentFactsProvider({ prisma, kv, tenantId: profile.DEMONSTRATION_TENANT_ID }),
    agentEnergyDeclarationsFor: (agentSnapshot) => {
      if (!isSimulatedSnapshot(agentSnapshot)) return null;
      const pack = simulatedAgentState.simulatedPackDeclaration(
        agentSnapshot.energyModel ? agentSnapshot.energyModel.packNominalWh : undefined,
      );
      return { residualCv: pack.residualCv, reserveFloorWh: pack.reserveFloorWh, provenance: simulatedAgentState.PROVENANCE };
    },
    environmentFor: (agentId, agent) =>
      agent && simulationPolicy.isSimulatedRobot(agent.robot)
        ? simulatedAgentState.simulatedAgentFacts({ robot: agent.robot, regionZoneIds: [] }).environmentAt(Date.now())
        : null,
    vehicleMassKgFor: (agentClassId, agentSnapshot) =>
      agentSnapshot && isNumber(agentSnapshot.vehicleMassKg) ? agentSnapshot.vehicleMassKg : null,

    /* ── mission (§7.5) ───────────────────────────────────────────────────── */
    missionProfileFor: profile.applyMissionProfile,
    // §15 — the V1 service envelope for a Leg whose manifests itemise nothing.
    defaultConsignmentFor: (leg) => profile.consignmentFor(leg && leg.tasks ? leg.tasks.payload : null),
    defaultStopAccessPrerequisites: profile.STOP_ACCESS_PREREQUISITES,

    /* ── route facts (§7.5 F27–F31) ───────────────────────────────────────── */
    routeDescriptorFor: ({ agentSnapshot, stops, decisionTimeMs, horizonSeconds }) => {
      if (!isSimulatedSnapshot(agentSnapshot)) return undefined;
      const current = pinned();
      let index = null;
      try {
        index = current && current.spatial ? hierarchy.indexMap(current.spatial) : null;
      } catch {
        index = null;
      }
      const zoneOf = (cellId) => (index && cellId ? index.resolve(cellId).zoneId : null);
      const zones = [...new Set([zoneOf(agentSnapshot.cellId), ...(stops || []).map((stop) => zoneOf(stop.cellId))])];
      // An unassigned endpoint leaves the zone list unreadable, and F27 denies.
      const zonesTraversed = zones.every((zoneId) => typeof zoneId === "string") ? zones.sort() : null;
      const exitMs = isNumber(decisionTimeMs) && isNumber(horizonSeconds) ? decisionTimeMs + horizonSeconds * 1000 : null;
      return {
        provenance: simulatedAgentState.PROVENANCE,
        loaded: false,
        profileKey: routingProfileKey(agentSnapshot.mobilityModel, { loaded: false }),
        // The simulated world has one surface and no constrictions, and its link is an
        // in-process socket with no dead zones.
        surfaceClasses: [simulatedAgentState.SIMULATED_SURFACE_CLASS],
        constrictions: [],
        deadZoneExtentM: 0,
        zonesTraversed,
        // The whole commitment horizon, not the plan's own window: a restriction anywhere
        // in it denies — the conservative direction.
        zoneTraversals:
          zonesTraversed === null || exitMs === null
            ? null
            : zonesTraversed.map((zoneId) => ({
                zoneId,
                enterMs: decisionTimeMs,
                exitMs,
                restrictions: profile.zoneRestrictionsFor(zoneId),
              })),
      };
    },
    environmentForecastFor: (agentSnapshot) =>
      isSimulatedSnapshot(agentSnapshot) ? simulatedAgentState.simulatedEnvironmentForecast() : undefined,
    // The simulator models no pack thermal stress.
    thermalStressMultiplierFor: (agentSnapshot) => (isSimulatedSnapshot(agentSnapshot) ? 1 : undefined),

    /* ── Φ inputs with no producer (§8) ───────────────────────────────────── */
    failureProbabilityFor: (agentSnapshot) =>
      isSimulatedSnapshot(agentSnapshot)
        ? { probability: 0, provenance: `${simulatedAgentState.PROVENANCE}: the simulator has no mission-failure mechanism` }
        : null,
    routeHazardCuFor: (plan) =>
      plan && plan.route && plan.route.provenance === simulatedAgentState.PROVENANCE ? 0 : null,
    batteryWearInputsFor,
    returnLegEnergyWhPerMetreFor: simulatedWhPerMetre,

    /* ── execution geometry ───────────────────────────────────────────────── */
    // A simulated agent drives the route it was priced on: the campus-network points the
    // round's routing carried (`routeEndpointBasis` above), attached to the OFFER by the
    // commit. It is given NO second producer here — this seam used to hand it a two-point
    // chord computed after the decision, which was a different line from the one priced.
    // Absent a priced route, the stop carries no path and the agent refuses it by name.
    // A physical agent keeps the default (Mapbox) provider.
    directionsFor: (agentSnapshot) => (isSimulatedSnapshot(agentSnapshot) ? noIndependentGeometry : undefined),
  };
}

/**
 * Compose for `server.js`, or return `{}` when this process is not a V1 demonstration.
 *
 * @param {object} settings as `createV1DemonstrationComposition`
 * @returns {object}
 */
function composeIfEnabled(settings) {
  const env = (settings && settings.env) || process.env;
  if (!isEnabled(env)) return {};
  const composition = createV1DemonstrationComposition(settings);
  logger.warn(
    "[v1] V1 DEMONSTRATION composition is active: simulated agents are priced on DEVELOPMENT_SIMULATION " +
      "inputs and V1_DEMONSTRATION declarations. NOT PRODUCTION. Physical agents are not admitted until: " +
      PHYSICAL_ROBOT_REPLACEMENTS.map((row) => row.seam).join("; "),
  );
  return composition;
}

module.exports = {
  ENV_VAR,
  PHYSICAL_ROBOT_REPLACEMENTS,
  isEnabled,
  isSimulatedSnapshot,
  simulatedProfileKeyFor,
  speedForProfile,
  simulatedWhPerMetre,
  batteryWearInputsFor,
  createV1DemonstrationComposition,
  composeIfEnabled,
};
