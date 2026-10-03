"use strict";

/**
 * The **physical provider** — the inputs the assignment engine reads for a physical agent,
 * from real rows and the owner's physical fleet declaration (`physicalPolicy`). Never from the
 * simulator: no simulation declaration is copied here, and the only module it imports from
 * `src/simulation/` is the campus OSM traversal network (map geometry), through `physicalRouter`.
 *
 * ── Without a declaration (P1 behaviour, unchanged) ─────────────────────────
 *   agentFactsFor      the real, derived half of `agentFacts.service` (PHYSICAL_DERIVED_ONLY)
 *   vehicleMassKgFor   `Robot.massKg`
 *   everything else    absent; a route is refused NOT_ROUTABLE; the agent is never indexed
 *
 * ── With a declaration (Gate 1, owner decisions 2026-10-03) ─────────────────
 *   availability       `chargingStatusFor`: MANUAL_OUT_OF_SERVICE charging + a live
 *                      operator-declared SoC (younger than maxAgeSeconds) + not PAUSED/ERROR
 *   facts              + the control-plane half from `physicalFacts` (PHYSICAL_DECLARED)
 *   routing            `physicalRouter` over the campus OSM network, `PHYSICAL:` profiles
 *   energy             β/SoH rows written by `physicalDeclaration.service`; per-robot
 *                      residual CV and reserve floor; return-leg Wh/m from the class's β
 *   environment        the declared site ambient worst case (pack taken at it)
 *   route descriptor   the permitted way classes as surfaces; declared no constrictions and no
 *                      dead zones; zones from the pinned spatial model
 *   Φ                  the declared failure prior and route hazard
 *
 * Every declared value is labelled PRODUCTION_DECLARED. A section the declaration omits
 * leaves its seam absent, and the engine refuses by name.
 */

const { createAgentFactsProvider } = require("../agentFacts.service");
const { RouteRefusedError, ROUTE_REFUSAL } = require("../../engine/routing/productionRouter");
const { ENDPOINT_BASIS } = require("../../engine/routing/cellPairCache");
const { routingProfileKey } = require("../../engine/domain/mobilityModel");
const hierarchy = require("../../engine/spatial/hierarchy");
const timeline = require("../../engine/plan/timeline");
const v1DemonstrationComposition = require("../v1DemonstrationComposition");
const profile = require("../v1DemonstrationProfile");
const physicalPolicy = require("./physicalPolicy");
const physicalRouter = require("./physicalRouter");
const physicalFacts = require("./physicalFacts");
const positionObservation = require("../positionObservation.service");

/** @structural the provider's name, for logs and diagnostics only */
const ID = "PHYSICAL";

/** @structural the namespace `physicalRouter` issues */
const PHYSICAL_PROFILE_NAMESPACE = "PHYSICAL:";

/** @structural a label, not a value */
const SIMULATED_FACTS_PROVENANCE = "DEVELOPMENT_SIMULATION";

/** India Standard Time, for §20.3's congestion bucket. @structural the deployment's offset */
const UTC_OFFSET_SECONDS = 19800;

const isNumber = (value) => typeof value === "number" && Number.isFinite(value);

/** The execution geometry of a routed physical agent is its priced route; nothing is recomputed. */
async function noIndependentGeometry() {
  return null;
}

function unknownCharging(reason) {
  return Object.freeze({ known: false, charging: false, chargingInterruptible: false, waiting: false, projectedFreeAtMs: null, reason });
}

/**
 * @param {object} settings
 * @param {object} settings.prisma
 * @param {object} [settings.kv]
 * @param {string} [settings.tenantId]
 * @param {Function|object} [settings.snapshot] the pinned configuration; required for routing
 * @param {object} [settings.policy] `physicalPolicy.load()` result; absent = every section off
 * @param {string} [settings.extractDirectory] test seam for the campus extract directory
 * @returns {object} the provider
 */
function createPhysicalProvider(settings) {
  const { prisma, kv, tenantId, snapshot } = settings || {};
  if (!prisma) throw new TypeError("createPhysicalProvider requires prisma");
  const policy = (settings && settings.policy) || physicalPolicy.NONE;
  const pinned = () => (typeof snapshot === "function" ? snapshot() : snapshot);

  const derivedFacts = createAgentFactsProvider({ prisma, kv, tenantId, physicalControlPlaneConnected: policy.robots.size > 0 });
  const router = snapshot ? physicalRouter.createPhysicalRouter({ snapshot, policy, extractDirectory: settings.extractDirectory }) : null;

  const declaredFor = (agentSnapshot) => (agentSnapshot && agentSnapshot.agentId ? policy.robotFor(agentSnapshot.agentId) : null);
  const isPhysicalDescriptor = (descriptor) => Boolean(descriptor) && descriptor.provenance === physicalPolicy.PROVENANCE;
  const site = policy.site;

  /** The class's moving draw, Wh per second, from the β row the declaration wrote. */
  function movingWhPerSecond(agentSnapshot) {
    const params = agentSnapshot && agentSnapshot.energyModelParams;
    return params && isNumber(params.betaAux) && isNumber(params.betaMoveTime) ? params.betaAux + params.betaMoveTime : null;
  }

  function profileKeyFor(agentSnapshot) {
    if (!router || !declaredFor(agentSnapshot)) return null;
    const base = physicalRouter.physicalProfileKeyFor(agentSnapshot);
    const draw = movingWhPerSecond(agentSnapshot);
    return base && isNumber(draw) && draw > 0 ? `${base}:whps=${draw}` : null;
  }

  /** `PHYSICAL:…:whps=<Wh/s>` → the router's own key, and the draw. */
  function splitProfileKey(profileKey) {
    const match = /^(PHYSICAL:.+):whps=([0-9.eE+-]+)$/u.exec(String(profileKey || ""));
    if (!match) return null;
    const draw = Number(match[2]);
    return isNumber(draw) && draw > 0 ? { routerKey: match[1], draw } : null;
  }

  const environmentDeclared = Boolean(site.ambientC);

  const seams = Object.freeze({
    /* ── agent facts (§7.5) ─────────────────────────────────────────────── */
    async agentFactsFor(input) {
      const facts = await derivedFacts(input);
      // Never pass on simulator-stated facts, whatever the caller routed here.
      if (!facts || facts.provenance === SIMULATED_FACTS_PROVENANCE) return null;
      const control = await physicalFacts.controlFactsFor({
        prisma,
        kv,
        policy,
        router,
        agent: input && input.agent,
        asOfMs: input && input.asOfMs,
        placement: input && input.placement,
      });
      if (!control) return facts;
      const { sessionOverlay, ...controlPlane } = control;
      return { ...facts, ...controlPlane, session: { ...facts.session, ...sessionOverlay }, provenance: physicalFacts.PROVENANCE };
    },

    /* ── commissioning and declared energy ──────────────────────────────── */
    vehicleMassKgFor: (agentClassId, agentSnapshot) =>
      agentSnapshot && isNumber(agentSnapshot.vehicleMassKg) ? agentSnapshot.vehicleMassKg : null,
    batteryWearInputsFor: (agentSnapshot, plan) => v1DemonstrationComposition.batteryWearInputsFor(agentSnapshot, plan),
    agentEnergyDeclarationsFor: (agentSnapshot) => {
      const declared = declaredFor(agentSnapshot);
      return declared
        ? { residualCv: declared.energy.residualCv, reserveFloorWh: declared.energy.reserveFloorWh, provenance: physicalPolicy.PROVENANCE }
        : null;
    },

    /* ── routing (§5) ───────────────────────────────────────────────────── */
    profileKeyFor,
    speedMetresPerSecondFor: (profileKey) => {
      const split = splitProfileKey(profileKey);
      return split ? physicalRouter.speedForProfile(split.routerKey) : undefined;
    },
    returnLegEnergyWhPerMetreFor: (profileKey) => {
      const split = splitProfileKey(profileKey);
      const speed = split ? physicalRouter.speedForProfile(split.routerKey) : undefined;
      return split && isNumber(speed) && speed > 0 ? split.draw / speed : undefined;
    },
    async route(parts) {
      const split = splitProfileKey(parts && parts.profileKey);
      if (!router || !split) {
        const profileKey = parts && parts.profileKey;
        throw new RouteRefusedError(
          ROUTE_REFUSAL.NOT_ROUTABLE,
          `no physical routing producer is composed, so profile "${profileKey}" has no route. A physical agent is ` +
            "never routed on the simulation router; it is refused until its own routing producer exists",
          { provider: ID, profileKey: profileKey === undefined ? null : profileKey },
        );
      }
      return router.route({ ...parts, profileKey: split.routerKey });
    },
    routeDescriptorFor: ({ agentSnapshot, stops, decisionTimeMs, horizonSeconds } = {}) => {
      if (!declaredFor(agentSnapshot) || !router) return undefined;
      if (site.constrictions !== physicalPolicy.POLICY.NONE_DECLARED) return undefined;
      if (site.connectivityDeadZones !== physicalPolicy.POLICY.NONE_DECLARED) return undefined;
      const permissionSet = agentSnapshot.mobilityModel && agentSnapshot.mobilityModel.permissionSet;
      const surfaceClasses = permissionSet && Array.isArray(permissionSet.surfaceClasses) ? [...permissionSet.surfaceClasses] : null;
      if (!surfaceClasses || surfaceClasses.length === 0) return undefined;
      const current = pinned();
      let index = null;
      try {
        index = current && current.spatial ? hierarchy.indexMap(current.spatial) : null;
      } catch {
        index = null;
      }
      const zoneOf = (cellId) => (index && cellId ? index.resolve(cellId).zoneId : null);
      const zones = [...new Set([zoneOf(agentSnapshot.cellId), ...(stops || []).map((stop) => zoneOf(stop.cellId))])];
      const zonesTraversed = zones.every((zoneId) => typeof zoneId === "string") ? zones.sort() : null;
      const exitMs = isNumber(decisionTimeMs) && isNumber(horizonSeconds) ? decisionTimeMs + horizonSeconds * 1000 : null;
      return {
        provenance: physicalPolicy.PROVENANCE,
        loaded: false,
        profileKey: routingProfileKey(agentSnapshot.mobilityModel, { loaded: false }),
        surfaceClasses,
        constrictions: [],
        deadZoneExtentM: 0,
        zonesTraversed,
        zoneTraversals:
          zonesTraversed === null || exitMs === null
            ? null
            : zonesTraversed.map((zoneId) => ({ zoneId, enterMs: decisionTimeMs, exitMs, restrictions: profile.zoneRestrictionsFor(zoneId) })),
      };
    },
    // A routed physical agent drives the route it was priced on (the OFFER's paths).
    directionsFor: (agentSnapshot) => (router && declaredFor(agentSnapshot) ? noIndependentGeometry : undefined),

    /* ── environment (declared site range) ──────────────────────────────── */
    environmentFor: (agentId) =>
      environmentDeclared && policy.robotFor(agentId)
        ? { ambientC: site.ambientC.max, packC: site.ambientC.max, provenance: physicalPolicy.PROVENANCE }
        : null,
    environmentForecastFor: (agentSnapshot) =>
      environmentDeclared && declaredFor(agentSnapshot)
        ? {
            source: "FORECAST",
            provenance: physicalPolicy.PROVENANCE,
            variables: { ambientC: { worstCase: site.ambientC.max, min: site.ambientC.min, max: site.ambientC.max } },
          }
        : undefined,
    thermalStressMultiplierFor: (agentSnapshot) => (environmentDeclared && declaredFor(agentSnapshot) ? 1 : undefined),

    /* ── Φ inputs (declared) ────────────────────────────────────────────── */
    failureProbabilityFor: (agentSnapshot) =>
      declaredFor(agentSnapshot) && isNumber(policy.risk.failureProbabilityPrior)
        ? { probability: policy.risk.failureProbabilityPrior, provenance: physicalPolicy.PROVENANCE }
        : null,
    routeHazardCuFor: (plan) =>
      plan && isPhysicalDescriptor(plan.route) && isNumber(policy.risk.routeHazardCu) ? policy.risk.routeHazardCu : null,
  });

  /**
   * The physical availability policy, in the shape `indexMaintainer` reads from
   * `chargingStatus.service`. Known, and not charging, only when the owner declared
   * MANUAL_OUT_OF_SERVICE charging, the robot is declared, and its operator-declared SoC is
   * younger than the declared bound. Otherwise unknown, with the reason — never a default.
   *
   * @param {string} agentRowId
   */
  async function chargingStatusFor(agentRowId) {
    if (policy.charging !== physicalPolicy.POLICY.MANUAL_OUT_OF_SERVICE) {
      return unknownCharging("the physical fleet declaration declares no charging policy (B2)");
    }
    if (!policy.stateOfCharge) return unknownCharging("the physical fleet declaration declares no state-of-charge policy");
    try {
      const agent = await prisma.agent.findUnique({
        where: { id: agentRowId },
        select: { agentId: true, robot: { select: { robotId: true, status: true } }, batteryState: { select: { lastObservedSoc: true, lastObservedAt: true } } },
      });
      if (!agent || !agent.robot) return unknownCharging("no such physical agent");
      if (!policy.robotFor(agent.robot.robotId)) return unknownCharging(`robot ${agent.robot.robotId} is not in the physical fleet declaration`);
      // A declaration naming a simulated unit by mistake must not make it available here.
      if ((await positionObservation.provenanceOf(prisma, agent.robot.robotId)) !== "PHYSICAL") {
        return unknownCharging(`robot ${agent.robot.robotId} is not a physical unit`);
      }
      const battery = agent.batteryState;
      if (!battery || !isNumber(battery.lastObservedSoc) || !battery.lastObservedAt) {
        return unknownCharging("no operator-declared state of charge");
      }
      const ageSeconds = (Date.now() - new Date(battery.lastObservedAt).getTime()) / 1000;
      if (!(ageSeconds <= policy.stateOfCharge.maxAgeSeconds)) {
        return unknownCharging(`the declared state of charge is ${Math.round(ageSeconds)} s old (bound ${policy.stateOfCharge.maxAgeSeconds} s)`);
      }
      return Object.freeze({ known: true, charging: false, chargingInterruptible: false, waiting: false, projectedFreeAtMs: null, reason: null });
    } catch (error) {
      return unknownCharging(`the physical availability policy could not be read: ${error && error.message}`);
    }
  }

  /** The round- and mission-level seams a physical-only process supplies itself. */
  const processSeams = Object.freeze({
    v1Demonstration: Object.freeze({ provenance: physicalPolicy.PROVENANCE, physicalFleet: true }),
    hopTerrainSource: physicalRouter.PHYSICAL_TERRAIN_SOURCE,
    travelTimeSpread: physicalRouter.PHYSICAL_SPREAD_SOURCE,
    timeBucket: timeline.hourOfWeek(Date.now(), UTC_OFFSET_SECONDS),
    routeEndpointBasis: ENDPOINT_BASIS.EXACT_POINTS,
    missionProfileFor: profile.applyMissionProfile,
    defaultConsignmentFor: (leg) => profile.consignmentFor(leg && leg.tasks ? leg.tasks.payload : null),
    defaultStopAccessPrerequisites: profile.STOP_ACCESS_PREREQUISITES,
  });

  return Object.freeze({
    id: ID,
    policy,
    seams,
    processSeams,
    chargingStatusFor,
    /** Charging scope for the simulator's dev scheduler: never a physical agent. */
    chargingInScope: async () => false,
  });
}

module.exports = {
  ID,
  PHYSICAL_PROFILE_NAMESPACE,
  createPhysicalProvider,
};
