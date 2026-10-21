"use strict";

/**
 * **Access-point CANDIDATES for campus destinations that exist only as a footprint.**
 *
 * The Create Task form offers declared Points only (Frontend `features/tasks/campusLocations.js`).
 * On RNSIT ten named destinations — ECE Department, Main Building, the canteens, … — exist in
 * the data only as OSM building footprints, so they cannot be chosen (audit of 2026-10-21).
 * This module proposes where each could be served from, and nothing more: every proposal is a
 * SUGGESTION for a person to confirm on site. It never makes a delivery endpoint.
 *
 * ── How a candidate is derived ──────────────────────────────────────────────
 *   1. DOCUMENTED_ENTRANCE — a Point the extract tags `entrance` / `door`, on or beside the
 *      footprint. Preferred. (Neither campus extract carries one: an Overpass export of ways
 *      emits their geometry, not the tags of their member nodes.)
 *   2. FRONTAGE_PROJECTION — each vertex and edge midpoint of the footprint's outline is
 *      projected onto the nearest permitted way of the BOUNDARY-CONTAINED campus network
 *      (`simulation/campusTraversalNetwork`, the network `fleetProviders/physicalRouter` routes
 *      on). The candidate is the projection: a point ON the sidewalk graph, facing the
 *      building. A projection whose straight connector from the façade cuts through this
 *      footprint, crosses another building or leaves the boundary is discarded. It is NOT an
 *      entrance: the façade point it faces may be a blank wall. No centroid is ever used.
 *
 * ── How a candidate is validated — with the engine's own instruments ────────
 *   * `spatial/deliveryDomain.evaluatePoint` — the intake geofence verdict;
 *   * `routing/cellProjection.projectExactPoint` — the exact-endpoint gate both routers apply
 *     (the simulation router since de03788, the physical router since 2026-10-21): the point
 *     itself must be inside the region and in the fine cell named for it;
 *   * `simulation/simulationRouter` — the V1 engine's route seam for a simulated ROVER, to every
 *     reference endpoint (the campus's declared Points inside the domain, else the other
 *     buildings' candidates);
 *   * the contained network — the physical route, whose access connectors `site.snapRadiusM`
 *     (R13, undeclared) would bound. A candidate's own connector is 0 m, so no positive R13
 *     can refuse it.
 *
 * ── Status — a candidate cannot become an endpoint by being generated ───────
 *   candidate     generated; every automated check passed; nobody has looked at it.
 *   needs_review  generated; checks passed, but a named `flags` condition needs a judgement.
 *   rejected      an automated check failed (`rejections`), or a reviewer rejected it.
 *   verified      a PERSON confirmed it on site: requires `review { by, on, method }`.
 * This module never emits `verified`. A reviewer edits the register; regeneration keeps every
 * entry that carries a `review`, and refuses a `verified` entry without one. The dashboard
 * admits `verified` entries only (Frontend `campus/access/accessPointImport.js`).
 *
 * Deterministic: no clock, no randomness, file order breaks ties. Same data, same register.
 */

const crypto = require("crypto");

const campusTraversalNetwork = require("../../src/simulation/campusTraversalNetwork");
const simulationRouter = require("../../src/simulation/simulationRouter");
const simulationPolicy = require("../../src/simulation/simulationPolicy");
const deliveryDomain = require("../../src/engine/spatial/deliveryDomain");
const cells = require("../../src/engine/spatial/cells");
const cellProjection = require("../../src/engine/routing/cellProjection");
const campusServiceability = require("../../src/engine/routing/campusServiceability");
const campusTravelModel = require("../../src/engine/routing/campusTravelModel");
const { ROUTER_MODE } = require("../../src/engine/routing/productionRouter");
const routeContainment = require("../../src/services/fleetProviders/routeContainment");
const robotSpecification = require("../../src/services/robotSpecification");
const service = require("../../src/engine/config/service");
const demonstration = require("../config/v1DemonstrationConfig");
const { haversineMeters } = require("../../src/utils/distance");

/** The register's status vocabulary. Only `verified` may become a selectable endpoint. */
const STATUS = Object.freeze({
  CANDIDATE: "candidate",
  NEEDS_REVIEW: "needs_review",
  VERIFIED: "verified",
  REJECTED: "rejected",
});

/** How a reviewer may have confirmed a point (Frontend `verification/campusVerification.js`). */
const REVIEW_METHODS = Object.freeze(["OWNER_SITE_CHECK", "SURVEY"]);

const DERIVATION = Object.freeze({
  DOCUMENTED_ENTRANCE: "DOCUMENTED_ENTRANCE",
  FRONTAGE_PROJECTION: "FRONTAGE_PROJECTION",
  /** Added to the register by a reviewer who found the real entrance on site. */
  REVIEWER_SUPPLIED: "REVIEWER_SUPPLIED",
});

/** Why a façade sample produced no candidate. */
const DISCARD = Object.freeze({
  FACADE_OUTSIDE_BOUNDARY: "FACADE_OUTSIDE_BOUNDARY",
  NO_CONTAINED_ACCESS: "NO_CONTAINED_ACCESS",
  CONNECTOR_THROUGH_OWN_FOOTPRINT: "CONNECTOR_THROUGH_OWN_FOOTPRINT",
  CONNECTOR_CROSSES_BUILDING: "CONNECTOR_CROSSES_BUILDING",
  TOO_CLOSE_TO_A_KEPT_CANDIDATE: "TOO_CLOSE_TO_A_KEPT_CANDIDATE",
  BEYOND_CANDIDATE_LIMIT: "BEYOND_CANDIDATE_LIMIT",
});

/** Why a candidate is rejected by the automated checks. */
const REJECTION = Object.freeze({
  OUTSIDE_DELIVERY_DOMAIN: "OUTSIDE_DELIVERY_DOMAIN",
  NOT_ON_SIDEWALK_GRAPH: "NOT_ON_SIDEWALK_GRAPH",
  /** The exact-endpoint gate both routers apply refused the point. */
  EXACT_POINT_GATE_REFUSED: "EXACT_POINT_GATE_REFUSED",
  UNREACHABLE_IN_SIMULATION: "UNREACHABLE_IN_SIMULATION",
  UNREACHABLE_PHYSICALLY: "UNREACHABLE_PHYSICALLY",
});

/** Conditions that pass the automated checks but need a person's judgement. */
const FLAG = Object.freeze({
  /** The façade it faces is more than `reviewGapM` from the sidewalk. */
  LONG_FRONTAGE_GAP: "LONG_FRONTAGE_GAP",
  /** Within `nearDeclaredPointM` of an existing declared location — maybe the same place. */
  NEAR_DECLARED_POINT: "NEAR_DECLARED_POINT",
  /** Within `sharedFrontageM` of another building's candidate — one kerb, two names. */
  SHARED_FRONTAGE: "SHARED_FRONTAGE",
  /** Some reference endpoints are unreachable from it (another network component). */
  PARTIAL_CONNECTIVITY: "PARTIAL_CONNECTIVITY",
  /** No reference endpoint exists to route to. */
  NO_REFERENCE_ENDPOINTS: "NO_REFERENCE_ENDPOINTS",
});

/**
 * Review heuristics — they decide what a PERSON is shown, never what is served. Each is
 * written into the register so a reviewer sees the threshold behind a flag.
 */
const PARAMETERS = Object.freeze({
  /** At most this many frontage candidates per building, so a reviewer sees alternatives. */
  maxCandidatesPerBuilding: 3,
  /** Candidates of one building closer than this are one place; the nearer façade is kept. */
  minCandidateSeparationM: 15,
  /** A façade farther than this from the sidewalk is flagged LONG_FRONTAGE_GAP. */
  reviewGapM: 15,
  /** A candidate this close to a declared location is flagged NEAR_DECLARED_POINT. */
  nearDeclaredPointM: 15,
  /** Candidates of two buildings this close are flagged SHARED_FRONTAGE. */
  sharedFrontageM: 5,
  /** An `entrance`/`door` Point within this of the outline belongs to the footprint. */
  entranceMatchM: 3,
  /** The candidate is ON the graph when its own connector is shorter than this. */
  onGraphToleranceM: 0.01,
  /** How far along the connector the footprint tests start, so the façade's own edge is not hit. */
  connectorStartFraction: 0.001,
});

/** Metres per radian of latitude — the sphere `campusTraversalNetwork` and `haversineMeters` use. */
const METRES_PER_RADIAN = 6371000;

const isFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);
const metres = (p, q) => haversineMeters(p.lat, p.lon, q.lat, q.lon);
const toPair = (point) => [point.lon, point.lat];
const toPoint = (pair) => ({ lat: Number(pair[1]), lon: Number(pair[0]) });

/** Every polygon of a Polygon / MultiPolygon, as rings of [lon, lat]. */
function polygonsOf(geometry) {
  if (!geometry) return [];
  if (geometry.type === "Polygon") return [geometry.coordinates];
  if (geometry.type === "MultiPolygon") return geometry.coordinates;
  return [];
}

function insideFootprint(point, geometry) {
  return polygonsOf(geometry).some((polygon) => campusServiceability.pointInPolygon(toPair(point), polygon).inside);
}

function edgesOf(geometry) {
  const edges = [];
  for (const polygon of polygonsOf(geometry)) {
    for (const ring of polygon) {
      for (let i = 0; i + 1 < ring.length; i += 1) edges.push([ring[i], ring[i + 1]]);
    }
  }
  return edges;
}

/** Shortest distance from a point to a footprint's outline, metres (local frame at the point). */
function distanceToOutlineM(point, geometry) {
  const lat0 = (point.lat * Math.PI) / 180;
  const kx = Math.cos(lat0) * (Math.PI / 180) * METRES_PER_RADIAN;
  const ky = (Math.PI / 180) * METRES_PER_RADIAN;
  let best = Infinity;
  for (const [a, b] of edgesOf(geometry)) {
    const ax = (a[0] - point.lon) * kx;
    const ay = (a[1] - point.lat) * ky;
    const dx = (b[0] - a[0]) * kx;
    const dy = (b[1] - a[1]) * ky;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSquared));
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

/** The outline's vertices and edge midpoints, exterior rings only (a hole is a courtyard). */
function facadeSamples(geometry) {
  const samples = [];
  for (const polygon of polygonsOf(geometry)) {
    const ring = polygon[0] || [];
    for (let i = 0; i + 1 < ring.length; i += 1) {
      samples.push(toPoint(ring[i]));
      samples.push(toPoint([(ring[i][0] + ring[i + 1][0]) / 2, (ring[i][1] + ring[i + 1][1]) / 2]));
    }
  }
  return samples;
}

/** Does the connector, started just off the façade, cross any edge of this footprint? */
function connectorMeets(start, end, geometry) {
  for (const [a, b] of edgesOf(geometry)) {
    if (routeContainment.segmentsMeet(toPair(start), toPair(end), a, b)) return true;
  }
  return false;
}

/**
 * The delivery-domain declaration a campus's boundary way gives — the shape
 * `tools/demo/seedV1Demonstration.js` publishes for RNSIT. For a campus with no published
 * region (JSSATE) it is an EVALUATION declaration: nothing here publishes it.
 */
function campusDeclaration(extract, settings) {
  const way = (extract.features || []).find((feature) => feature && feature.id === settings.boundaryWay);
  if (!way || !way.geometry) throw new Error(`the extract carries no boundary way "${settings.boundaryWay}"`);
  return Object.freeze({
    regionId: settings.regionId,
    name: settings.name,
    kind: "CAMPUS",
    crs: "EPSG:4326",
    version: settings.boundaryWay,
    versionDate: settings.versionDate,
    boundary: way.geometry,
  });
}

/** The V1 demonstration's configuration, with the campus's delivery domain pinned. */
function evaluationSnapshot(declaration) {
  const real = service.defaultSnapshot();
  const bound = Object.fromEntries(
    [...demonstration.bindings(), ...demonstration.executionBindings()].map((row) => [row.name, row.value]),
  );
  return Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
    deliveryDomain: declaration,
    resolve: (name, context, options) =>
      Object.prototype.hasOwnProperty.call(bound, name) ? bound[name] : real.resolve(name, context, options),
  });
}

/** A label for the agent the simulation router is asked about. Not a robot. @structural */
const EVALUATION_AGENT_ID = "ACCESS-CANDIDATE-EVALUATION";

/**
 * Build the engine instruments for one campus.
 *
 * @param {{ extract: object, declaration: object, source?: string }} input
 */
function createInstruments(input) {
  const { extract, declaration } = input;
  const source = input.source || "campus extract";
  const rover = robotSpecification.CHASSIS_TEMPLATE[robotSpecification.CHASSIS_TYPE.ROVER];
  const roadClasses = campusTraversalNetwork.permittedClasses(rover.permissionSet);
  const containment = routeContainment.createRouteContainment(declaration);
  if (!containment.usable) throw new Error(`the boundary cannot contain a route: ${containment.problems.join("; ")}`);
  const simulation = campusTraversalNetwork.createCampusTraversalNetwork({ features: extract.features, roadClasses, source });
  const physical = campusTraversalNetwork.createCampusTraversalNetwork({
    features: extract.features,
    roadClasses,
    source,
    containment,
  });
  const projection = cellProjection.createCellProjection({
    serviceability: campusServiceability.createServiceabilityOracle(declaration),
  });
  const snapshot = evaluationSnapshot(declaration);
  const router = simulationRouter.createSimulationRouter({
    projection,
    travelModel: campusTravelModel.resolveModelParameters(snapshot, {}),
    agents: [{ robotId: EVALUATION_AGENT_ID, simulated: true }],
    mode: ROUTER_MODE.DEVELOPMENT,
    env: { [simulationPolicy.SIMULATOR_ENV_VAR]: "true" },
    traversalNetworkFor: () => simulation,
  });
  return Object.freeze({
    domain: deliveryDomain.validateDomainDeclaration(declaration),
    traversalDomain: rover.traversalDomain,
    roadClasses,
    containment,
    simulation,
    physical,
    projection,
    router,
    profileKey: `SIMULATED:v=${simulationRouter.SIMULATED_NOMINAL_SPEED_MS}:wh=1000:net=${roadClasses.join("+")}`,
  });
}

const fineCell = (point) => cells.cellForPoint(point.lat, point.lon, cells.RESOLUTION.FINE);

function gate(fn) {
  try {
    fn();
    return { ok: true, refusal: null };
  } catch (error) {
    return { ok: false, refusal: (error && error.refusal) || (error && error.message) || String(error) };
  }
}

/** The simulated engine route between two exact points. */
async function engineRoute(instruments, from, to) {
  try {
    const routed = await instruments.router.route({
      originCell: fineCell(from),
      destCell: fineCell(to),
      originPoint: from,
      destPoint: to,
      profileKey: instruments.profileKey,
      timeBucket: 0,
    });
    return { ok: true, distanceM: routed.distanceM, refusal: null };
  } catch (error) {
    const detail = error && error.detail && error.detail.refusal;
    return { ok: false, distanceM: null, refusal: detail || (error && error.refusal) || String(error) };
  }
}

/** The physical route: both exact-point gates (physicalRouter.js) and the contained network. */
function physicalRoute(instruments, from, to) {
  for (const point of [from, to]) {
    const exact = gate(() => instruments.projection.projectExactPoint(fineCell(point), point));
    if (!exact.ok) return { ok: false, refusal: `EXACT_POINT:${exact.refusal}`, accessM: null };
  }
  const routed = instruments.physical.route(from, to);
  return routed.ok
    ? { ok: true, refusal: null, accessM: Math.max(routed.accessM.origin, routed.accessM.destination) }
    : { ok: false, refusal: routed.refusal, accessM: null };
}

/** Where a façade sample meets the contained sidewalk network, or why it does not. */
function frontageFor(instruments, sample) {
  const routed = instruments.physical.route(sample, sample);
  if (!routed.ok) return { ok: false, refusal: routed.refusal };
  const point = routed.accessM.origin === 0 ? routed.points[0] : routed.points[1];
  return { ok: true, point: { lat: point.lat, lon: point.lon }, gapM: routed.accessM.origin };
}

function round(value, digits = 2) {
  return isFiniteNumber(value) ? Number(value.toFixed(digits)) : value;
}

function candidateId(campusId, buildingSourceId, point) {
  return `${campusId}:${buildingSourceId}@${point.lat.toFixed(7)},${point.lon.toFixed(7)}`;
}

/**
 * Propose candidates for one building, before validation.
 *
 * @returns {{ proposals: object[], samples: number, discarded: Record<string, number>, documentedEntrances: number }}
 */
function proposeFor(instruments, target, footprintIndex, extract, parameters) {
  const discarded = {};
  const discard = (reason) => (discarded[reason] = (discarded[reason] || 0) + 1);
  const own = target.geometry;

  // 1. Documented entrances on or beside this footprint.
  const entrances = (extract.features || []).filter((feature) => {
    const tags = (feature && feature.properties) || {};
    if (!feature || !feature.geometry || feature.geometry.type !== "Point") return false;
    if (tags.entrance === undefined && tags.door === undefined) return false;
    const at = toPoint(feature.geometry.coordinates);
    return insideFootprint(at, own) || distanceToOutlineM(at, own) <= parameters.entranceMatchM;
  });
  const proposals = entrances.map((feature) => {
    const at = toPoint(feature.geometry.coordinates);
    return {
      point: at,
      derivation: { method: DERIVATION.DOCUMENTED_ENTRANCE, entranceSourceId: feature.id, facade: [at.lon, at.lat] },
      frontageGapM: 0,
    };
  });

  // 2. Frontage projections from the outline.
  const samples = facadeSamples(own);
  const valid = [];
  samples.forEach((sample, index) => {
    if (!instruments.containment.containsPoint(sample)) return discard(DISCARD.FACADE_OUTSIDE_BOUNDARY);
    const frontage = frontageFor(instruments, sample);
    if (!frontage.ok) return discard(DISCARD.NO_CONTAINED_ACCESS);
    if (frontage.gapM > 0) {
      const f = parameters.connectorStartFraction;
      const start = {
        lat: sample.lat + (frontage.point.lat - sample.lat) * f,
        lon: sample.lon + (frontage.point.lon - sample.lon) * f,
      };
      if (insideFootprint(start, own) || connectorMeets(start, frontage.point, own)) {
        return discard(DISCARD.CONNECTOR_THROUGH_OWN_FOOTPRINT);
      }
      const blocked = footprintIndex.some(
        (other) =>
          other.sourceId !== target.sourceId &&
          (insideFootprint(frontage.point, other.geometry) || connectorMeets(start, frontage.point, other.geometry)),
      );
      if (blocked) return discard(DISCARD.CONNECTOR_CROSSES_BUILDING);
    }
    valid.push({ index, sample, frontage });
  });

  valid.sort((a, b) => a.frontage.gapM - b.frontage.gapM || a.index - b.index);
  for (const row of valid) {
    if (proposals.some((kept) => metres(kept.point, row.frontage.point) < parameters.minCandidateSeparationM)) {
      discard(DISCARD.TOO_CLOSE_TO_A_KEPT_CANDIDATE);
      continue;
    }
    if (proposals.length >= parameters.maxCandidatesPerBuilding) {
      discard(DISCARD.BEYOND_CANDIDATE_LIMIT);
      continue;
    }
    proposals.push({
      point: row.frontage.point,
      derivation: { method: DERIVATION.FRONTAGE_PROJECTION, facade: [row.sample.lon, row.sample.lat] },
      frontageGapM: row.frontage.gapM,
    });
  }
  return { proposals, samples: samples.length, discarded, documentedEntrances: entrances.length };
}

/**
 * Validate one proposal with the engine's instruments, and decide its automated status.
 */
async function validate(instruments, proposal, context) {
  const { point } = proposal;
  const { parameters, references, declaredPoints, otherCandidates, target } = context;
  const rejections = [];
  const flags = [];

  const verdict = deliveryDomain.evaluatePoint(instruments.domain, point.lat, point.lon).verdict;
  if (verdict !== "INSIDE") rejections.push(REJECTION.OUTSIDE_DELIVERY_DOMAIN);

  const simAccess = instruments.simulation.route(point, point);
  const physAccess = instruments.physical.route(point, point);
  const simulationAccessM = simAccess.ok ? simAccess.accessM.origin : null;
  const physicalAccessM = physAccess.ok ? physAccess.accessM.origin : null;
  if (!(physicalAccessM !== null && physicalAccessM < parameters.onGraphToleranceM)) {
    rejections.push(REJECTION.NOT_ON_SIDEWALK_GRAPH);
  }

  const cell = verdict === "INSIDE" ? fineCell(point) : null;
  const exactPointGate = cell ? gate(() => instruments.projection.projectExactPoint(cell, point)) : { ok: false, refusal: "OUTSIDE" };
  if (!exactPointGate.ok) rejections.push(REJECTION.EXACT_POINT_GATE_REFUSED);

  const simulationRefused = [];
  const physicalRefused = [];
  let simulationReached = 0;
  let physicalReached = 0;
  for (const reference of references) {
    const simulated = await engineRoute(instruments, point, reference.point);
    if (simulated.ok) simulationReached += 1;
    else simulationRefused.push({ to: reference.id, refusal: simulated.refusal });
    const physical = physicalRoute(instruments, point, reference.point);
    if (physical.ok) physicalReached += 1;
    else physicalRefused.push({ to: reference.id, refusal: physical.refusal });
  }
  if (references.length === 0) flags.push(FLAG.NO_REFERENCE_ENDPOINTS);
  else {
    if (simulationReached === 0) rejections.push(REJECTION.UNREACHABLE_IN_SIMULATION);
    if (physicalReached === 0) rejections.push(REJECTION.UNREACHABLE_PHYSICALLY);
    if ((simulationReached > 0 && simulationRefused.length > 0) || (physicalReached > 0 && physicalRefused.length > 0)) {
      flags.push(FLAG.PARTIAL_CONNECTIVITY);
    }
  }

  if (proposal.frontageGapM > parameters.reviewGapM) flags.push(FLAG.LONG_FRONTAGE_GAP);
  const nearDeclared = declaredPoints
    .map((declared) => ({ id: declared.id, metres: metres(point, declared.point) }))
    .filter((row) => row.metres <= parameters.nearDeclaredPointM)
    .map((row) => ({ id: row.id, metres: round(row.metres, 1) }));
  if (nearDeclared.length) flags.push(FLAG.NEAR_DECLARED_POINT);
  const shared = otherCandidates
    .filter((other) => other.buildingSourceId !== target.sourceId && metres(point, other.point) <= parameters.sharedFrontageM)
    .map((other) => other.buildingSourceId);
  if (shared.length) flags.push(FLAG.SHARED_FRONTAGE);

  const status = rejections.length ? STATUS.REJECTED : flags.length ? STATUS.NEEDS_REVIEW : STATUS.CANDIDATE;
  return {
    status,
    rejections,
    flags,
    measurements: {
      frontageGapM: round(proposal.frontageGapM),
      distanceToFootprintM: round(distanceToOutlineM(point, target.geometry)),
      simulationAccessM: round(simulationAccessM, 3),
      physicalAccessM: round(physicalAccessM, 3),
    },
    validation: {
      deliveryDomain: verdict,
      traversalDomain: instruments.traversalDomain,
      roadClasses: [...instruments.roadClasses],
      fineCell: cell,
      exactPointGate: exactPointGate.ok ? "PASS" : exactPointGate.refusal,
      routes: {
        references: references.length,
        simulation: { reached: simulationReached, refused: simulationRefused },
        physical: {
          reached: physicalReached,
          refused: physicalRefused,
          ownAccessConnectorM: round(physicalAccessM, 3),
          snapRadius: "R13 site.snapRadiusM is undeclared; the physical router refuses every route until it is",
        },
      },
      nearDeclaredPoints: nearDeclared,
      sharedFrontageWith: shared,
    },
  };
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

/**
 * Check a reviewer's entry before regeneration keeps it.
 *
 * @returns {string[]} problems; empty when the entry may be kept
 */
function reviewProblems(feature) {
  const props = (feature && feature.properties) || {};
  const problems = [];
  if (!Object.values(STATUS).includes(props.status)) problems.push(`unknown status ${JSON.stringify(props.status)}`);
  const review = props.review;
  if (props.status === STATUS.VERIFIED || review) {
    if (!review || typeof review !== "object") problems.push("a verified entry needs a review { by, on, method }");
    else {
      if (typeof review.by !== "string" || !review.by.trim()) problems.push("review.by must name who checked it");
      if (typeof review.on !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(review.on)) problems.push("review.on must be YYYY-MM-DD");
      if (!REVIEW_METHODS.includes(review.method)) problems.push(`review.method must be one of ${REVIEW_METHODS.join(", ")}`);
    }
  }
  return problems;
}

/**
 * Generate one campus's register.
 *
 * @param {object} input
 * @param {string} input.campusId the Frontend campus registry id (`RNSIT`, `jssate-bengaluru`)
 * @param {{ file: string, text: string }} input.extract the campus OSM extract, as read
 * @param {{ file: string, text: string }|null} input.supplemental the supplied points, as read
 * @param {object} input.declarationSettings `{ regionId, name, boundaryWay, versionDate }`
 * @param {Array<{ sourceId: string, featureId: string, name: string, operationalRole: string, related?: object }>} input.targets
 *   the footprint-only destinations (Frontend `destinationFootprints`)
 * @param {object|null} [input.existing] the register currently on disk, whose reviews are kept
 * @param {object} [input.parameters] overrides for `PARAMETERS` (tests)
 * @returns {Promise<object>} a GeoJSON FeatureCollection with `generator` and `buildings` members
 */
async function generateRegister(input) {
  const parameters = Object.freeze({ ...PARAMETERS, ...(input.parameters || {}) });
  const extract = JSON.parse(input.extract.text);
  const supplemental = input.supplemental ? JSON.parse(input.supplemental.text) : null;
  const declaration = campusDeclaration(extract, input.declarationSettings);
  const instruments = createInstruments({ extract, declaration, source: input.extract.file });

  for (const feature of (input.existing && input.existing.features) || []) {
    const problems = reviewProblems(feature);
    if (problems.length) {
      throw new Error(`register entry ${feature && feature.properties && feature.properties.id}: ${problems.join("; ")}`);
    }
  }

  // Every declared Point inside the domain: what the form already offers, and what a candidate
  // must route to.
  const declaredPoints = [
    ...(extract.features || [])
      .filter((feature) => feature && feature.geometry && feature.geometry.type === "Point")
      .map((feature) => ({ id: feature.id, point: toPoint(feature.geometry.coordinates) })),
    ...((supplemental && supplemental.features) || []).map((feature) => ({
      id: feature.properties.id,
      point: toPoint(feature.geometry.coordinates),
    })),
  ].filter((row) => deliveryDomain.evaluatePoint(instruments.domain, row.point.lat, row.point.lon).verdict === "INSIDE");

  // The footprints a connector may not cross: every building in the extract.
  const footprintIndex = (extract.features || [])
    .filter((feature) => feature && feature.properties && feature.properties.building && polygonsOf(feature.geometry).length)
    .map((feature) => ({ sourceId: feature.id, geometry: feature.geometry }));

  const byId = new Map((extract.features || []).map((feature) => [feature.id, feature]));
  const proposed = [];
  const buildings = [];
  for (const target of input.targets) {
    const feature = byId.get(target.sourceId);
    if (!feature || !polygonsOf(feature.geometry).length) {
      buildings.push({ ...target, problem: "the extract carries no footprint with this id", candidates: [] });
      continue;
    }
    const subject = { ...target, geometry: feature.geometry };
    const proposal = proposeFor(instruments, subject, footprintIndex, extract, parameters);
    buildings.push({ ...target, subject, proposal });
    for (const row of proposal.proposals) proposed.push({ ...row, buildingSourceId: target.sourceId, subject });
  }

  // References: the declared Points; on a campus with none, every other building's best candidate.
  const features = [];
  for (const row of proposed) {
    const references = declaredPoints.length
      ? declaredPoints
      : proposed
          .filter((other) => other.buildingSourceId !== row.buildingSourceId)
          .filter((other, i, all) => all.findIndex((x) => x.buildingSourceId === other.buildingSourceId) === i)
          .map((other) => ({ id: candidateId(input.campusId, other.buildingSourceId, other.point), point: other.point }));
    const checked = await validate(instruments, row, {
      parameters,
      references,
      declaredPoints,
      otherCandidates: proposed,
      target: row.subject,
    });
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [row.point.lon, row.point.lat] },
      properties: {
        id: candidateId(input.campusId, row.buildingSourceId, row.point),
        campusId: input.campusId,
        buildingSourceId: row.buildingSourceId,
        buildingFeatureId: row.subject.featureId,
        buildingName: row.subject.name,
        status: checked.status,
        rejections: checked.rejections,
        flags: checked.flags,
        derivation: row.derivation,
        measurements: checked.measurements,
        validation: checked.validation,
        review: null,
      },
    });
  }

  // Reviews survive regeneration. A reviewed entry the data no longer produces is kept as it
  // was, marked stale, so its reviewer sees the geometry moved under it — unless a reviewer
  // supplied it, in which case the generator never produced it.
  const generatedIds = new Set(features.map((feature) => feature.properties.id));
  for (const kept of (input.existing && input.existing.features) || []) {
    const props = kept.properties || {};
    if (!props.review) continue;
    if (generatedIds.has(props.id)) {
      const regenerated = features.find((feature) => feature.properties.id === props.id);
      regenerated.properties.status = props.status;
      regenerated.properties.review = props.review;
    } else {
      const supplied = props.derivation && props.derivation.method === DERIVATION.REVIEWER_SUPPLIED;
      features.push(supplied ? kept : { ...kept, properties: { ...props, stale: true } });
    }
  }

  return {
    type: "FeatureCollection",
    campusId: input.campusId,
    generator: {
      tool: "Backend/tools/campus/generateAccessCandidates.js",
      statusModel:
        "candidate | needs_review | rejected are generated; verified is set by a person with review { by, on, method }. " +
        "Only verified entries are offered as task locations.",
      parameters,
      boundary: { way: declaration.version, versionDate: declaration.versionDate },
      sources: {
        extract: { file: input.extract.file, sha256: sha256(input.extract.text) },
        supplemental: input.supplemental ? { file: input.supplemental.file, sha256: sha256(input.supplemental.text) } : null,
      },
      network: {
        traversalDomain: instruments.traversalDomain,
        roadClasses: [...instruments.roadClasses],
        simulation: instruments.simulation.describe(),
        physical: instruments.physical.describe(),
      },
      references: declaredPoints.length
        ? declaredPoints.map((row) => row.id)
        : "no declared Point inside the domain — each candidate is routed to the other buildings' candidates",
    },
    buildings: buildings.map((row) => {
      const mine = features.filter((feature) => feature.properties.buildingSourceId === row.sourceId);
      return {
        buildingSourceId: row.sourceId,
        buildingFeatureId: row.featureId,
        name: row.name,
        operationalRole: row.operationalRole,
        related: row.related || null,
        documentedEntrances: row.proposal ? row.proposal.documentedEntrances : 0,
        facadeSamples: row.proposal ? row.proposal.samples : 0,
        discardedSamples: row.proposal ? row.proposal.discarded : {},
        candidates: mine.map((feature) => feature.properties.id),
        reliableCandidates: mine.filter((feature) => feature.properties.status !== STATUS.REJECTED).length,
        problem: row.problem || null,
      };
    }),
    features,
  };
}

module.exports = {
  STATUS,
  REVIEW_METHODS,
  DERIVATION,
  DISCARD,
  REJECTION,
  FLAG,
  PARAMETERS,
  campusDeclaration,
  createInstruments,
  facadeSamples,
  distanceToOutlineM,
  reviewProblems,
  generateRegister,
};
