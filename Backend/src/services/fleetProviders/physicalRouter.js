"use strict";

/**
 * The **physical routing producer** — the `PHYSICAL:` profile namespace `physicalProvider`
 * reserved in P1, now issued.
 *
 * A physical agent is routed over the same campus OSM traversal network the simulated fleet
 * uses (`campusTraversalNetwork`: the published delivery domain's own extract, its `highway`
 * ways filtered by the class's `MobilityModel.permissionSet`). That network is map geometry,
 * not simulator output; it imports nothing simulated. Every other route field is declared:
 *
 *   distanceM        the network path length between the exact points (haversine over the
 *                    path points — the distance the robot is handed is the distance priced)
 *   travelSeconds    the owner's V1 campus travel model at the class's commissioned speed
 *   travelSdSeconds  the same model's declared spread
 *   climbM/descentM  0, ONLY under the site declaration `terrain: FLAT_DECLARED`; refused
 *                    NO_TERRAIN_SOURCE otherwise
 *   stopStartCycles  the site declaration's per-hop count; refused NO_STOP_START_SOURCE otherwise
 *
 * A physical route never leaves the operating boundary (RD-2026-10-12-01 AC1): the network is
 * built from boundary-contained edges only, each endpoint and access connector must lie
 * inside, and a route that cannot be kept inside is refused by name (`routeContainment`).
 * Each access connector is bounded by the declared `site.snapRadiusM` (R13); with none
 * declared, every route is refused. There is no straight-line fallback.
 *
 * The simulation router is never called for a physical profile, and this router never answers
 * a `SIMULATED:` one.
 */

const campusTraversalNetwork = require("../../simulation/campusTraversalNetwork");
const cellProjection = require("../../engine/routing/cellProjection");
const campusTravelModel = require("../../engine/routing/campusTravelModel");
const campusServiceability = require("../../engine/routing/campusServiceability");
const { ENDPOINT_BASIS, hasExactEndpoints } = require("../../engine/routing/cellPairCache");
const { RouteRefusedError, ROUTE_REFUSAL, FIELD_PROVENANCE } = require("../../engine/routing/productionRouter");
const physicalPolicy = require("./physicalPolicy");
const routeContainment = require("./routeContainment");

/** Network refusals that mean "this endpoint is outside the operating region". @structural */
const OUTSIDE_REFUSALS = Object.freeze([campusTraversalNetwork.NETWORK_REFUSAL.ENDPOINT_OUTSIDE_BOUNDARY]);

/** @structural the reserved namespace */
const PROFILE_PREFIX = "PHYSICAL";

/** The process-level labels the coordinator probes for presence. @structural */
const PHYSICAL_TERRAIN_SOURCE = `${FIELD_PROVENANCE.PRODUCTION_DECLARED}:SITE_TERRAIN_FLAT_DECLARED`;
const PHYSICAL_SPREAD_SOURCE = `${FIELD_PROVENANCE.PRODUCTION_DECLARED}:${campusTravelModel.DECLARED_SPREAD_SOURCE}`;

const isNumber = (value) => typeof value === "number" && Number.isFinite(value);

/**
 * The routing profile of a physical agent: its commissioned nominal speed, its pack, and the
 * way classes it may use. `null` when any is undeclared — the coordinator then has no route
 * for it and refuses by name.
 *
 * @param {object} agentSnapshot
 * @returns {string|null}
 */
function physicalProfileKeyFor(agentSnapshot) {
  const mobility = agentSnapshot && agentSnapshot.mobilityModel;
  const speed = mobility && mobility.speedModel && mobility.speedModel.nominalSpeedMps;
  const packWh = agentSnapshot && agentSnapshot.energyModel && agentSnapshot.energyModel.packNominalWh;
  const classes = campusTraversalNetwork.permittedClasses(mobility && mobility.permissionSet);
  if (!isNumber(speed) || speed <= 0 || !isNumber(packWh) || packWh <= 0 || classes.length === 0) return null;
  return `${PROFILE_PREFIX}:v=${speed}:wh=${packWh}:net=${classes.join("+")}`;
}

/** @returns {{ speed: number, packWh: number, roadClasses: string[] }|null} */
function parsePhysicalProfile(profileKey) {
  const match = /^PHYSICAL:v=([0-9.]+):wh=([0-9.]+):net=([a-z_+]+)$/u.exec(String(profileKey || ""));
  if (!match) return null;
  const speed = Number(match[1]);
  const packWh = Number(match[2]);
  const roadClasses = match[3].split("+").filter(Boolean);
  return isNumber(speed) && speed > 0 && isNumber(packWh) && packWh > 0 && roadClasses.length > 0
    ? { speed, packWh, roadClasses }
    : null;
}

function speedForProfile(profileKey) {
  const parsed = parsePhysicalProfile(profileKey);
  return parsed ? parsed.speed : undefined;
}

/**
 * Build the router. Lazy: the delivery domain and the extract are read on first use, and a
 * failed build is not cached.
 *
 * @param {{ snapshot: Function|object, policy?: object, extractDirectory?: string }} settings
 */
function createPhysicalRouter(settings) {
  const { snapshot } = settings || {};
  const policyOf = () => (settings && settings.policy) || physicalPolicy.NONE;
  const pinned = () => (typeof snapshot === "function" ? snapshot() : snapshot);

  let built = null;
  function build() {
    if (built) return built;
    const current = pinned();
    const declaration = current && (current.deliveryDomain || (current.spatial && current.spatial.deliveryDomain));
    if (!declaration) throw new Error("the pinned configuration carries no delivery-domain declaration to project cells within");
    const extract = campusTraversalNetwork.extractForDeclaration(
      declaration,
      settings && settings.extractDirectory ? { directory: settings.extractDirectory } : undefined,
    );
    if (!extract.ok) throw new Error(`the campus traversal network cannot be built: ${extract.problems.join("; ")}`);
    const containment = routeContainment.createRouteContainment(declaration);
    if (!containment.usable) {
      throw new Error(`the operating boundary cannot contain a route: ${containment.problems.join("; ")}`);
    }
    // Two networks per class set: the contained one routes; the full one only answers
    // MAP_MATCH's "how far is this fix from a way", which is a measurement, not a route.
    const networks = new Map();
    const networkOf = (roadClasses, contained) => {
      const key = `${contained ? "contained" : "full"}:${[...roadClasses].sort().join("+")}`;
      if (!networks.has(key)) {
        networks.set(
          key,
          campusTraversalNetwork.createCampusTraversalNetwork({
            features: extract.features,
            roadClasses,
            source: extract.file,
            ...(contained ? { containment } : {}),
          }),
        );
      }
      return networks.get(key);
    };
    built = {
      projection: cellProjection.createCellProjection({
        serviceability: campusServiceability.createServiceabilityOracle(declaration),
      }),
      travelModel: campusTravelModel.resolveModelParameters(current, {}),
      networkFor: (roadClasses) => networkOf(roadClasses, true),
      mapNetworkFor: (roadClasses) => networkOf(roadClasses, false),
    };
    return built;
  }

  async function route(parts) {
    const source = parts || {};
    const parsed = parsePhysicalProfile(source.profileKey);
    if (!parsed) {
      throw new RouteRefusedError(ROUTE_REFUSAL.NOT_ROUTABLE, `"${source.profileKey}" is not a physical routing profile`);
    }
    const site = policyOf().site;
    if (site.terrain !== physicalPolicy.POLICY.FLAT_DECLARED) {
      throw new RouteRefusedError(
        ROUTE_REFUSAL.NO_TERRAIN_SOURCE,
        "no terrain source: the physical fleet declaration does not declare site.terrain FLAT_DECLARED",
      );
    }
    if (!Number.isInteger(site.stopStartCyclesPerHop)) {
      throw new RouteRefusedError(
        ROUTE_REFUSAL.NO_STOP_START_SOURCE,
        "no stop-start source: the physical fleet declaration does not declare site.stopStartCyclesPerHop",
      );
    }
    if (!isNumber(site.snapRadiusM) || site.snapRadiusM <= 0) {
      throw new RouteRefusedError(
        ROUTE_REFUSAL.NOT_ROUTABLE,
        "no snap radius: the physical fleet declaration does not declare site.snapRadiusM (R13), so no access " +
          "connector can be bounded and no route is produced",
        { refusal: "NO_SNAP_RADIUS" },
      );
    }

    let world;
    try {
      world = build();
    } catch (error) {
      throw new RouteRefusedError(ROUTE_REFUSAL.NOT_ROUTABLE, error && error.message);
    }

    // An exact-endpoint request routes the exact points, so those are what is checked:
    // `projectExactPoint` requires each to be a valid coordinate, to lie in the fine cell the
    // request names for it, and to be inside the region by the same oracle. Testing the cell's
    // CENTRE instead refused points inside the campus in boundary cells (10.3 % of RNSIT) while
    // the route between the exact points never left it — the defect de03788 fixed in the
    // simulation router. A cell-only request keeps the cell-centre check. The contained network
    // below still requires each exact point strictly inside, every access connector inside and
    // within `site.snapRadiusM`, and the whole path inside.
    const exact = hasExactEndpoints(source);
    let origin;
    let destination;
    try {
      origin = exact
        ? world.projection.projectExactPoint(source.originCell, source.originPoint)
        : world.projection.project(source.originCell);
      destination = exact
        ? world.projection.projectExactPoint(source.destCell, source.destPoint)
        : world.projection.project(source.destCell);
    } catch (error) {
      if (error instanceof cellProjection.ProjectionError) {
        throw new RouteRefusedError(
          error.refusal === "OUTSIDE_SERVICEABLE_REGION" ? ROUTE_REFUSAL.OUTSIDE_SERVICEABLE_REGION : ROUTE_REFUSAL.MALFORMED_REQUEST,
          error.reason,
          { refusal: error.refusal },
        );
      }
      throw error;
    }

    const network = world.networkFor(parsed.roadClasses);
    const routed = network.route(exact ? source.originPoint : origin, exact ? source.destPoint : destination, {
      maxAccessM: site.snapRadiusM,
    });
    if (!routed.ok) {
      throw new RouteRefusedError(
        OUTSIDE_REFUSALS.includes(routed.refusal) ? ROUTE_REFUSAL.OUTSIDE_SERVICEABLE_REGION : ROUTE_REFUSAL.NOT_ROUTABLE,
        routed.reason,
        { refusal: routed.refusal },
      );
    }

    const modelled = campusTravelModel.travelTimeFor({
      distanceM: routed.distanceM,
      speedMetresPerSecond: parsed.speed,
      bufferSecondsPer100m: world.travelModel.bufferSecondsPer100m,
      sdBufferMultiple: world.travelModel.sdBufferMultiple,
    });
    if (!modelled.ok) {
      throw new RouteRefusedError(ROUTE_REFUSAL.MODEL_REFUSED, `the V1 campus travel model refused: ${modelled.problems.join("; ")}`);
    }

    return Object.freeze({
      distanceM: routed.distanceM,
      travelSeconds: modelled.travelSeconds,
      travelSdSeconds: modelled.travelSdSeconds,
      climbM: 0,
      descentM: 0,
      stopStartCycles: site.stopStartCyclesPerHop,
      endpointBasis: exact ? ENDPOINT_BASIS.EXACT_POINTS : ENDPOINT_BASIS.CELL_REPRESENTATIVE,
      ...(exact ? { path: routed.points } : {}),
      accessM: routed.accessM,
      provenance: Object.freeze({
        distanceM: "CAMPUS_OSM_NETWORK",
        travelSeconds: FIELD_PROVENANCE.PRODUCTION_DECLARED,
        travelSdSeconds: FIELD_PROVENANCE.PRODUCTION_DECLARED,
        climbM: PHYSICAL_TERRAIN_SOURCE,
        descentM: PHYSICAL_TERRAIN_SOURCE,
        stopStartCycles: FIELD_PROVENANCE.PRODUCTION_DECLARED,
      }),
    });
  }

  /**
   * F10's MAP_MATCH corroboration: how far a fix lies from the nearest way its class may use.
   * Independent of the localisation stack's own accuracy estimate — it is the map's
   * statement, not the receiver's. `null` when the network cannot be built.
   */
  function mapMatchDivergenceM(point, permissionSet) {
    const classes = campusTraversalNetwork.permittedClasses(permissionSet);
    if (!point || !isNumber(point.lat) || !isNumber(point.lon) || classes.length === 0) return null;
    let world;
    try {
      world = build();
    } catch {
      return null;
    }
    const routed = world.mapNetworkFor(classes).route(point, point);
    return routed.ok && routed.accessM && isNumber(routed.accessM.origin) ? routed.accessM.origin : null;
  }

  return Object.freeze({ route, mapMatchDivergenceM });
}

module.exports = {
  PROFILE_PREFIX,
  PHYSICAL_TERRAIN_SOURCE,
  PHYSICAL_SPREAD_SOURCE,
  physicalProfileKeyFor,
  parsePhysicalProfile,
  speedForProfile,
  createPhysicalRouter,
};
