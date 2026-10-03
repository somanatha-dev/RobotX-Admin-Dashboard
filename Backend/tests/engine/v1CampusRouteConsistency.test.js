"use strict";

/**
 * ONE authoritative delivery route — the V1 demonstration's priced route is the route the
 * simulated agent drives and the dashboard draws.
 *
 * ── The defect this pins ────────────────────────────────────────────────────
 * The forensic audit of 2026-10-02 measured three different lines for one delivery:
 *
 *   * the assignment priced `haversine(H3 cell centre → cell centre) + 2 × 250 m` per hop;
 *   * the agent was then handed a two-point chord between the exact coordinates, computed
 *     after the decision by `v1DemonstrationComposition.directionsFor`;
 *   * the map drew that chord — through buildings, on no road.
 *
 * On RNSIT the priced hop was 2.2–11.3× the driven one (Innovation Center → Food Court:
 * 549.7 m priced, 48.7 m driven). Every distance, travel time, ETA, energy and cost figure
 * the engine decided with described a journey nobody made.
 *
 * Every number asserted here is derived from the repository's own campus data
 * (`rnsit-campus-osm.geojson`, `rnsit-campus-supplemental.geojson`), never typed in.
 */

const fs = require("fs");
const path = require("path");

const campusTraversalNetwork = require("../../src/simulation/campusTraversalNetwork");
const simulationRouter = require("../../src/simulation/simulationRouter");
const VirtualRobot = require("../../src/simulation/VirtualRobot");
const cellPairCache = require("../../src/engine/routing/cellPairCache");
const cellProjection = require("../../src/engine/routing/cellProjection");
const campusServiceability = require("../../src/engine/routing/campusServiceability");
const campusTravelModel = require("../../src/engine/routing/campusTravelModel");
const { ROUTE_REFUSAL } = require("../../src/engine/routing/productionRouter");
const cells = require("../../src/engine/spatial/cells");
const timeline = require("../../src/engine/plan/timeline");
const lowerBound = require("../../src/engine/candidates/lowerBound");
const composition = require("../../src/services/v1DemonstrationComposition");
const executionGeometry = require("../../src/services/executionGeometry.service");
const storablePrecision = require("../../src/services/storablePrecision.service");
const assignmentProjection = require("../../src/services/assignmentProjection.service");
const robotSpecification = require("../../src/services/robotSpecification");
const coordinatorSolvePath = require("../../src/workers/coordinatorSolvePath");
const commandHandler = require("../../src/sockets/handlers/command.handler");
const service = require("../../src/engine/config/service");
const demonstration = require("../../tools/config/v1DemonstrationConfig");
const simulatedAgentState = require("../../src/simulation/simulatedAgentState");
const { haversineMeters } = require("../../src/utils/distance");

/* ── The campus, from the repository's own data ──────────────────────────── */

const REPO = path.resolve(__dirname, "..", "..", "..");
const BOUNDARY_WAY = "way/1120154292";
const EXTRACT = JSON.parse(fs.readFileSync(path.join(REPO, "rnsit-campus-osm.geojson"), "utf8"));
const DECLARATION = Object.freeze({
  regionId: "rnsit-campus",
  name: "RNSIT Campus",
  kind: "CAMPUS",
  crs: "EPSG:4326",
  version: BOUNDARY_WAY,
  versionDate: "2026-08-30",
  boundary: EXTRACT.features.find((feature) => feature.id === BOUNDARY_WAY).geometry,
});
const POINTS = Object.fromEntries(
  JSON.parse(fs.readFileSync(path.join(REPO, "rnsit-campus-supplemental.geojson"), "utf8")).features.map((feature) => [
    feature.properties.id,
    { lat: feature.geometry.coordinates[1], lon: feature.geometry.coordinates[0] },
  ]),
);

/** The ROVER chassis' declared permissions — the class every simulated demo unit is. */
const ROVER = robotSpecification.CHASSIS_TEMPLATE[robotSpecification.CHASSIS_TYPE.ROVER].permissionSet;
const ROVER_CLASSES = campusTraversalNetwork.permittedClasses(ROVER);
const NETWORK = campusTraversalNetwork.createCampusTraversalNetwork({
  features: EXTRACT.features,
  roadClasses: ROVER_CLASSES,
  source: "rnsit-campus-osm.geojson",
});

/** Every vertex of a permitted way, as `lon,lat` — what an interior route point must be. */
const PERMITTED_VERTICES = new Set(
  EXTRACT.features
    .filter((f) => f.geometry.type === "LineString" && ROVER_CLASSES.includes(f.properties.highway))
    .flatMap((f) => f.geometry.coordinates.map(([lon, lat]) => `${lon},${lat}`)),
);

/** Every segment of a permitted way, as `[{lat,lon},{lat,lon}]`. */
const PERMITTED_SEGMENTS = EXTRACT.features
  .filter((f) => f.geometry.type === "LineString" && ROVER_CLASSES.includes(f.properties.highway))
  .flatMap((f) =>
    f.geometry.coordinates.slice(1).map((c, i) => [
      { lat: f.geometry.coordinates[i][1], lon: f.geometry.coordinates[i][0] },
      { lat: c[1], lon: c[0] },
    ]),
  );

/**
 * Does the stretch p→q run along one permitted way segment? Both ends within 5 cm of the same
 * OSM segment — which a chord cutting between two different ways cannot satisfy.
 */
function alongAWay(p, q) {
  return PERMITTED_SEGMENTS.some((segment) => offRouteMetres(p, segment) < 0.05 && offRouteMetres(q, segment) < 0.05);
}

const STANDARD_SPEED = robotSpecification.SIMULATION_PRESET.STANDARD.normalSpeedMps;
const TOLERANCE_M = 0.5;

const lengthOf = (points) =>
  points.slice(1).reduce((sum, point, i) => sum + haversineMeters(points[i].lat, points[i].lon, point.lat, point.lon), 0);
const fineCell = (point) => cells.cellForPoint(point.lat, point.lon, cells.RESOLUTION.FINE);

/** Distance from a point to a polyline, in metres (local equirectangular, campus scale). */
function offRouteMetres(point, polyline) {
  const kx = Math.cos((point.lat * Math.PI) / 180) * 111320;
  const ky = 110540;
  let best = Infinity;
  for (let i = 1; i < polyline.length; i += 1) {
    const ax = (polyline[i - 1].lon - point.lon) * kx;
    const ay = (polyline[i - 1].lat - point.lat) * ky;
    const dx = (polyline[i].lon - polyline[i - 1].lon) * kx;
    const dy = (polyline[i].lat - polyline[i - 1].lat) * ky;
    const l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2));
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

/* ── The composition, as server.js builds it, over test doubles for the store ── */

const ENV = { ENABLE_VIRTUAL_SIMULATOR: "true", V1_DEMONSTRATION_COMPOSITION: "true" };

/** The real register with the V1 demonstration bindings, carrying the RNSIT delivery domain. */
function demonstrationSnapshot() {
  const real = service.defaultSnapshot();
  const map = Object.fromEntries(
    [...demonstration.bindings(), ...demonstration.executionBindings()].map((row) => [row.name, row.value]),
  );
  // TEST DOUBLES for the two Safety rows, exactly as the V1 assignment-path suite supplies them.
  map["energy.model_residual_cv"] = 0.1;
  map["energy.reserve_floor_wh"] = 50;
  return Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
    deliveryDomain: DECLARATION,
    resolve: (name, context, options) =>
      Object.prototype.hasOwnProperty.call(map, name) ? map[name] : real.resolve(name, context, options),
    explain: (name, context, options) => {
      const explained = real.explain(name, context, options);
      return Object.prototype.hasOwnProperty.call(map, name) ? { ...explained, value: map[name] } : explained;
    },
  });
}

/** A KV double with the `set(key, value, "EX", ttl)` shape `cellPairCache.write` uses. */
function memoryKv() {
  const store = new Map();
  return {
    store,
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async set(key, value) {
      store.set(key, value);
      return "OK";
    },
    async del(key) {
      store.delete(key);
      return 1;
    },
  };
}

const prismaDouble = { robot: { findMany: async () => [{ robotId: "SIM-RNSIT-1", simulated: true }] } };

function v1Composition(snapshot = demonstrationSnapshot()) {
  return composition.createV1DemonstrationComposition({ prisma: prismaDouble, kv: memoryKv(), snapshot: () => snapshot, env: ENV });
}

/** A simulated ROVER agent snapshot, at a point. */
function simulatedAgent(at, overrides = {}) {
  return {
    provenance: simulatedAgentState.PROVENANCE,
    agentId: "SIM-RNSIT-1",
    lat: at.lat,
    lon: at.lon,
    cellId: fineCell(at),
    mobilityModel: { permissionSet: { ...ROVER }, speedModel: { nominalSpeedMps: STANDARD_SPEED } },
    energyModel: { packNominalWh: 1000 },
    ...overrides,
  };
}

/** The real round, with the real V1 composition spread into its context. */
function realRound() {
  const snapshot = demonstrationSnapshot();
  const kv = memoryKv();
  const seams = composition.createV1DemonstrationComposition({ prisma: prismaDouble, kv, snapshot: () => snapshot, env: ENV });
  const assembly = coordinatorSolvePath.create({
    ...seams,
    prisma: prismaDouble,
    kv,
    snapshot: () => snapshot,
    shardId: "s1",
    signingKey: "k",
    runSerializable: async () => null,
    selectForUpdate: async () => null,
  });
  if (!assembly.ok) throw new Error(`create() refused: ${assembly.blockedBy}`);
  return { ...assembly, seams, snapshot, kv };
}

/** The demonstration delivery: robot at Innovation Center, pickup Food Court, drop Cyber Security. */
const ROBOT_AT = POINTS["rnsit-innovation-center"];
const PICKUP = POINTS["rnsit-food-court"];
const DROP = POINTS["rnsit-cyber-security-department"];
const LEG_STOPS = [
  { sequence: 1, stopType: "PICKUP", lat: PICKUP.lat, lon: PICKUP.lon, cellId: fineCell(PICKUP) },
  { sequence: 2, stopType: "DROP", lat: DROP.lat, lon: DROP.lon, cellId: fineCell(DROP) },
];

/* ═══════════════════════════════════════════════════════════════════════════
   1. The network — a real campus route, between exact points
   ═══════════════════════════════════════════════════════════════════════════ */

describe("1 — the campus traversal network routes over the campus's own ways", () => {
  const pairs = [
    ["rnsit-innovation-center", "rnsit-food-court"],
    ["rnsit-food-court", "rnsit-cyber-security-department"],
    ["rnsit-canara-bank", "rnsit-playground-2"],
    ["rnsit-pre-university-college", "rnsit-main-gate"],
  ];

  test("the RNSIT network is the extract's permitted ways, and it is one connected piece", () => {
    expect(ROVER_CLASSES).toEqual(["footway", "path", "service"]);
    expect(NETWORK.vertexCount).toBe(PERMITTED_VERTICES.size);
    expect(NETWORK.componentCount).toBe(1);
  });

  test.each(pairs)("%s → %s starts and ends at the exact points, and runs only through OSM vertices", (a, b) => {
    const route = NETWORK.route(POINTS[a], POINTS[b]);
    expect(route.ok).toBe(true);
    expect(route.points[0]).toEqual(POINTS[a]);
    expect(route.points[route.points.length - 1]).toEqual(POINTS[b]);
    expect(route.points.length).toBeGreaterThan(2);
    // Interior points: the two projections onto the network, and between them nothing but
    // vertices of permitted ways — no interpolated or invented point.
    const interior = route.points.slice(2, -2);
    for (const point of interior) expect(PERMITTED_VERTICES.has(`${point.lon},${point.lat}`)).toBe(true);
    // And every stretch between the two access connectors runs ALONG a permitted way — the
    // route follows the campus's ways rather than cutting between them. Only the first and
    // last stretches (exact point → its projection onto the network) are off-network.
    const network = route.points.slice(1, -1);
    for (let i = 1; i < network.length; i += 1) {
      expect({ stretch: i, alongAWay: alongAWay(network[i - 1], network[i]) }).toEqual({ stretch: i, alongAWay: true });
    }
  });

  test.each(pairs)("%s → %s: distanceM is the length of its own points, and never shorter than the straight line", (a, b) => {
    const route = NETWORK.route(POINTS[a], POINTS[b]);
    expect(route.distanceM).toBeCloseTo(lengthOf(route.points), 9);
    expect(route.distanceM).toBeGreaterThanOrEqual(haversineMeters(POINTS[a].lat, POINTS[a].lon, POINTS[b].lat, POINTS[b].lon));
  });

  test("deterministic: the same request returns the same points", () => {
    const first = NETWORK.route(POINTS["rnsit-canara-bank"], POINTS["rnsit-playground-2"]);
    const fresh = campusTraversalNetwork.createCampusTraversalNetwork({ features: EXTRACT.features, roadClasses: ROVER_CLASSES });
    expect(fresh.route(POINTS["rnsit-canara-bank"], POINTS["rnsit-playground-2"])).toEqual(first);
  });

  test("no permitted ways refuses; ways that do not connect refuse — never a straight line", () => {
    const none = campusTraversalNetwork.createCampusTraversalNetwork({ features: EXTRACT.features, roadClasses: [] });
    expect(none.route(ROBOT_AT, PICKUP)).toMatchObject({ ok: false, refusal: campusTraversalNetwork.NETWORK_REFUSAL.NO_PERMITTED_WAYS });

    const split = campusTraversalNetwork.createCampusTraversalNetwork({
      roadClasses: ["footway"],
      features: [
        { type: "Feature", properties: { highway: "footway" }, geometry: { type: "LineString", coordinates: [[77.5, 12.9], [77.5001, 12.9]] } },
        { type: "Feature", properties: { highway: "footway" }, geometry: { type: "LineString", coordinates: [[77.51, 12.91], [77.5101, 12.91]] } },
      ],
    });
    expect(split.componentCount).toBe(2);
    expect(split.route({ lat: 12.9, lon: 77.50005 }, { lat: 12.91, lon: 77.51005 })).toMatchObject({
      ok: false,
      refusal: campusTraversalNetwork.NETWORK_REFUSAL.NOT_CONNECTED,
    });
  });

  test("stairs are a class only a stair-capable agent is given", () => {
    expect(campusTraversalNetwork.permittedClasses({ roadClasses: ["footway", "steps"], stairCapable: false })).toEqual(["footway"]);
    expect(campusTraversalNetwork.permittedClasses({ roadClasses: ["footway"], stairCapable: true })).toEqual(["footway", "steps"]);
    expect(campusTraversalNetwork.permittedClasses(undefined)).toEqual([]);
  });

  test("the extract is found by the published declaration's own boundary — and only by an exact match", () => {
    const found = campusTraversalNetwork.extractForDeclaration(DECLARATION);
    expect(found).toMatchObject({ ok: true, file: "rnsit-campus-osm.geojson" });

    const moved = JSON.parse(JSON.stringify(DECLARATION));
    moved.boundary.coordinates[0][0][0] += 0.0001;
    expect(campusTraversalNetwork.extractForDeclaration(moved).ok).toBe(false);
    expect(campusTraversalNetwork.extractForDeclaration({ ...DECLARATION, version: "way/0" }).ok).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   2. The router and the cache — the route is what is priced, with nothing added
   ═══════════════════════════════════════════════════════════════════════════ */

describe("2 — the V1 router prices the campus route between exact endpoints", () => {
  const snapshot = demonstrationSnapshot();
  const model = campusTravelModel.resolveModelParameters(snapshot, {});

  function partsFor(agent, from, to) {
    return {
      originCell: fineCell(from),
      destCell: fineCell(to),
      profileKey: composition.simulatedProfileKeyFor(agent),
      timeBucket: 10,
      originPoint: from,
      destPoint: to,
    };
  }

  test("the profile key carries the class's permitted ways, so two permission sets never share a route", () => {
    expect(composition.simulatedProfileKeyFor(simulatedAgent(ROBOT_AT))).toBe(`SIMULATED:v=${STANDARD_SPEED}:wh=1000:net=footway+path+service`);
    const stairs = simulatedAgent(ROBOT_AT, { mobilityModel: { permissionSet: { ...ROVER, stairCapable: true }, speedModel: { nominalSpeedMps: STANDARD_SPEED } } });
    expect(composition.simulatedProfileKeyFor(stairs)).toContain(":net=footway+path+service+steps");
    // Speed and the return-leg rate still read off the key exactly as before.
    expect(composition.speedForProfile(composition.simulatedProfileKeyFor(stairs))).toBe(STANDARD_SPEED);
  });

  test("an exact-endpoint request returns the network route: its distance, its points, its travel time", async () => {
    const seams = v1Composition(snapshot);
    const agent = simulatedAgent(ROBOT_AT);
    const routed = await seams.route(partsFor(agent, ROBOT_AT, PICKUP));
    const expected = NETWORK.route(ROBOT_AT, PICKUP);

    expect(routed.endpointBasis).toBe(cellPairCache.ENDPOINT_BASIS.EXACT_POINTS);
    expect(routed.path).toEqual(expected.points);
    expect(routed.distanceM).toBeCloseTo(expected.distanceM, 9);
    const travel = campusTravelModel.travelTimeFor({
      distanceM: expected.distanceM,
      speedMetresPerSecond: STANDARD_SPEED,
      bufferSecondsPer100m: model.bufferSecondsPer100m,
      sdBufferMultiple: model.sdBufferMultiple,
    });
    expect(routed.travelSeconds).toBeCloseTo(travel.travelSeconds, 9);
  });

  test("a cell-only request (the return leg to a charger) is routed on the network between cell centres, with no geometry", async () => {
    const seams = v1Composition(snapshot);
    const { originPoint, destPoint, ...cellOnly } = partsFor(simulatedAgent(ROBOT_AT), ROBOT_AT, PICKUP);
    const routed = await seams.route(cellOnly);
    expect(routed.endpointBasis).toBe(cellPairCache.ENDPOINT_BASIS.CELL_REPRESENTATIVE);
    expect(routed.path).toBeUndefined();
    expect(originPoint && destPoint).toBeTruthy();
  });

  test("a profile that permits no ways is refused by name — a drone is not given a ground route, nor a straight line", async () => {
    const seams = v1Composition(snapshot);
    const drone = simulatedAgent(ROBOT_AT, {
      mobilityModel: {
        permissionSet: robotSpecification.CHASSIS_TEMPLATE[robotSpecification.CHASSIS_TYPE.DRONE].permissionSet,
        speedModel: { nominalSpeedMps: STANDARD_SPEED },
      },
    });
    await expect(seams.route(partsFor(drone, ROBOT_AT, PICKUP))).rejects.toMatchObject({
      name: "RouteRefusedError",
      refusal: ROUTE_REFUSAL.NOT_ROUTABLE,
    });
  });

  test("the cell projection's serviceability gate still applies: a cell whose centre is off campus is refused", async () => {
    const seams = v1Composition(snapshot);
    const gate = POINTS["rnsit-main-gate"];
    // The seeded fleet relies on this: V1DEMO-05 stands at the main gate and is never assigned.
    await expect(seams.route(partsFor(simulatedAgent(gate), gate, PICKUP))).rejects.toMatchObject({
      refusal: ROUTE_REFUSAL.OUTSIDE_SERVICEABLE_REGION,
    });
  });

  test("the intra-cell offset is not added to an exact-endpoint route, and still is to a cell-representative one", async () => {
    const seams = v1Composition(snapshot);
    const agent = simulatedAgent(ROBOT_AT);
    const offset = snapshot.resolve("route.intra_cell_offset_m", {});
    expect(offset).toBeGreaterThan(0);
    const options = { ttlSeconds: 900, intraCellOffsetM: offset, speedMetresPerSecond: STANDARD_SPEED };
    const deps = { kv: memoryKv(), route: seams.route };

    const exact = await cellPairCache.read(deps, partsFor(agent, ROBOT_AT, PICKUP), options);
    expect(exact.entry.distanceM).toBeCloseTo(NETWORK.route(ROBOT_AT, PICKUP).distanceM, 9);
    expect(exact.entry.intraCellOffsetM).toBe(0);

    const { originPoint, destPoint, ...cellOnly } = partsFor(agent, ROBOT_AT, PICKUP);
    const cellEntry = await cellPairCache.read(deps, cellOnly, options);
    expect(cellEntry.entry.intraCellOffsetM).toBe(2 * offset);
    expect(originPoint && destPoint).toBeTruthy();

    // A hit is answered identically to the miss that wrote it.
    const again = await cellPairCache.read(deps, partsFor(agent, ROBOT_AT, PICKUP), options);
    expect(again.hit).toBe(true);
    expect(again.entry.distanceM).toBe(exact.entry.distanceM);
    expect(again.entry.path).toEqual(exact.entry.path);
  });

  test("an entry claiming exact endpoints under a cell-only key is still corrected (the claim is not trusted)", () => {
    const entry = { distanceM: 100, travelSeconds: 80, endpointBasis: "EXACT_POINTS" };
    const corrected = cellPairCache.applyIntraCellOffset(entry, { intraCellOffsetM: 250, speedMetresPerSecond: 1.5 });
    expect(corrected.corrected.distanceM).toBe(600);
  });

  test("two different exact endpoint pairs in the same cells are two cache entries", () => {
    const a = cellPairCache.key({ originCell: "c1", destCell: "c2", profileKey: "p", timeBucket: 1, originPoint: { lat: 1, lon: 2 }, destPoint: { lat: 3, lon: 4 } });
    const b = cellPairCache.key({ originCell: "c1", destCell: "c2", profileKey: "p", timeBucket: 1, originPoint: { lat: 1, lon: 2.0001 }, destPoint: { lat: 3, lon: 4 } });
    const cellOnly = cellPairCache.key({ originCell: "c1", destCell: "c2", profileKey: "p", timeBucket: 1 });
    expect(a.key).not.toBe(b.key);
    expect(cellOnly.key).toBe(`${cellPairCache.KEY_PREFIX}:c1:c2:p:1`);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   3. The round — assignment reads the route, and keeps its geometry for the OFFER
   ═══════════════════════════════════════════════════════════════════════════ */

describe("3 — the round's routing seam prices the campus route and keeps its geometry", () => {
  test("approach and linehaul are the network routes from the agent's exact position — no 500 m per hop", async () => {
    const { round } = realRound();
    const agent = simulatedAgent(ROBOT_AT);
    const traversal = await round.routing.forPairing(agent.cellId, LEG_STOPS, round.profileKeyFor(agent), {
      lat: agent.lat,
      lon: agent.lon,
    });
    expect(traversal.ok).toBe(true);

    const approach = NETWORK.route(ROBOT_AT, PICKUP);
    const linehaul = NETWORK.route(PICKUP, DROP);
    expect(traversal.hops[0].distanceM).toBeCloseTo(approach.distanceM, 9);
    expect(traversal.hops[1].distanceM).toBeCloseTo(linehaul.distanceM, 9);

    const paths = traversal.pathsForSequence(LEG_STOPS);
    expect(paths.map((p) => p.path)).toEqual([approach.points, linehaul.points]);
  });

  test("the round's exact evaluation asks the routing seam about the agent's EXACT position", async () => {
    const { round } = realRound();
    const agent = { ...simulatedAgent(ROBOT_AT), agentRowId: "agent-row-1" };
    round.rememberLeg({ leg: { legId: "LEG-1", legRowId: "leg-row-1", stops: LEG_STOPS }, scope: {}, decisionTimeMs: 0 });
    const seam = jest.spyOn(round.routing, "forPairing").mockResolvedValue({ ok: false, hops: [], problems: ["stopped here"] });
    try {
      const out = await round.evaluateExact("agent-row-1", { legId: "LEG-1" }, agent);
      expect(out.refusal).toBe(coordinatorSolvePath.REFUSAL.MISSING_HOP);
      expect(seam).toHaveBeenCalledWith(agent.cellId, LEG_STOPS, round.profileKeyFor(agent), { lat: ROBOT_AT.lat, lon: ROBOT_AT.lon });
    } finally {
      seam.mockRestore();
    }
  });

  test("the return leg to a charger stays a cell-pair question, corrected for quantisation", async () => {
    const { round, snapshot } = realRound();
    const agent = simulatedAgent(ROBOT_AT);
    const traversal = await round.routing.forPairing(fineCell(DROP), [{ sequence: 1, cellId: fineCell(PICKUP) }], round.profileKeyFor(agent));
    expect(traversal.ok).toBe(true);
    expect(traversal.hops[0].path).toBeUndefined();
    expect(traversal.hops[0].intraCellOffsetM).toBe(2 * snapshot.resolve("route.intra_cell_offset_m", {}));
  });

  test("ETA and energy inputs: the timeline projects arrival on the route's travel time and distance", async () => {
    const { round } = realRound();
    const agent = simulatedAgent(ROBOT_AT);
    const traversal = await round.routing.forPairing(agent.cellId, LEG_STOPS, round.profileKeyFor(agent), { lat: agent.lat, lon: agent.lon });
    const startMs = 1_800_000_000_000;
    const projected = timeline.project({
      stops: LEG_STOPS.map((stop) => ({ ...stop, serviceSeconds: 60, serviceSdSeconds: 0 })),
      hops: traversal.hops,
      startMs,
    });
    expect(projected.ok).toBe(true);
    expect(projected.stops[0].projectedArrivalMs).toBeCloseTo(startMs + traversal.hops[0].travelSeconds * 1000, 3);
    // The plan's distance — what §14.2's β_dist term and C_direct's wear term read — is the route's.
    const routeTotal = NETWORK.route(ROBOT_AT, PICKUP).distanceM + NETWORK.route(PICKUP, DROP).distanceM;
    expect(projected.totals.distanceM).toBeCloseTo(routeTotal, 6);
  });

  test("the candidate lower bound stays admissible: the great circle never exceeds the priced route", () => {
    for (const [a, b] of [["rnsit-innovation-center", "rnsit-food-court"], ["rnsit-canara-bank", "rnsit-playground-2"]]) {
      const straight = cells.greatCircleMetres(POINTS[a].lat, POINTS[a].lon, POINTS[b].lat, POINTS[b].lon);
      expect(straight).toBeLessThanOrEqual(NETWORK.route(POINTS[a], POINTS[b]).distanceM);
    }
    expect(typeof lowerBound.lowerBound).toBe("function");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   4. THE REGRESSION — one RNSIT delivery, one route, from pricing to the wheels to the map
   ═══════════════════════════════════════════════════════════════════════════ */

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

function recordingSocket() {
  const emitted = [];
  return {
    emitted,
    connected: true,
    emit(event, payload) {
      emitted.push({ event, payload });
    },
    on() {},
    of(event) {
      return emitted.filter((e) => e.event === event);
    },
  };
}

describe("4 — Innovation Center → Food Court → Cyber Security: priced = driven = drawn", () => {
  test("one route from assignment through the OFFER to the simulator and the dashboard", async () => {
    // ── Pricing: the real round's routing seam over the real V1 composition ──
    const { round } = realRound();
    const agent = simulatedAgent(ROBOT_AT);
    const traversal = await round.routing.forPairing(agent.cellId, LEG_STOPS, round.profileKeyFor(agent), { lat: agent.lat, lon: agent.lon });
    const pricedDistance = traversal.hops[0].distanceM + traversal.hops[1].distanceM;
    const pricedPaths = traversal.pathsForSequence(LEG_STOPS);

    // Not a two-point chord: the campus has turns between these buildings.
    expect(pricedPaths[0].path.length).toBeGreaterThan(2);
    expect(pricedPaths[1].path.length).toBeGreaterThan(2);
    // And not the old artefact: no hop carries the 2 × 250 m quantisation offset.
    for (const hop of traversal.hops) expect(hop.intraCellOffsetM).toBe(0);

    // ── Commit: the OFFER's stop sequence, exactly as `commitFor` builds it ──
    const plannedStops = LEG_STOPS.map(({ sequence, stopType, lat, lon }) => ({ sequence, stopType, siteId: null, lat, lon }));
    const geometry = executionGeometry.attachPricedPaths({ stops: plannedStops, pricedPaths });
    expect(geometry.unroutable).toEqual([]);
    // Through the outbox's JSON column, as the agent and the dashboard both receive it.
    const offerPayload = JSON.parse(
      JSON.stringify(storablePrecision.toStorablePrecision({ missionPlan: "plan-1", stopSequence: geometry.stops, taskId: "TASK-RNSIT-1" })),
    );

    // ── Display: TASK_ASSIGNED reads the outbox row back ──
    const outboxDouble = { outbox: { findFirst: async () => ({ payload: offerPayload }) } };
    const drawn = await assignmentProjection.offeredRouteFor(outboxDouble, "CMT-1");

    // ── Execution: the simulated agent receives the same OFFER ──
    const robot = new VirtualRobot({
      robotId: "SIM-RNSIT-1",
      lat: ROBOT_AT.lat,
      lon: ROBOT_AT.lon,
      logger: silentLogger,
      simulated: true,
      telemetryIntervalMs: 2000,
      specification: { massKg: 2, normalSpeedMps: STANDARD_SPEED, maxSpeedMps: 2.0, packNominalWh: 1000, payloadCapacityKg: 5 },
      batteryState: { kappa: 1, kappaSampleCount: 0 },
    });
    robot.socket = recordingSocket();
    robot.connected = true;
    robot.battery = 90;
    robot._respondToOffer({ commitmentId: "CMT-1", fence: "1", payload: offerPayload });
    expect(robot.socket.of("OFFER_ACCEPT")).toHaveLength(1);

    const driven = robot.task.stops.map((stop) => stop.path);
    // The same route, three consumers.
    expect(drawn.pathToPickup).toEqual(driven[0]);
    expect(drawn.pathToDrop).toEqual(driven[1]);
    for (let i = 0; i < 2; i += 1) {
      expect(driven[i].length).toBe(pricedPaths[i].path.length);
      driven[i].forEach((point, k) => {
        expect(haversineMeters(point.lat, point.lon, pricedPaths[i].path[k].lat, pricedPaths[i].path[k].lon)).toBeLessThan(0.01);
      });
    }

    // ── Drive it, on one clock, and watch where the agent is ──
    let now = 1_800_000_000_000;
    let lastPosition = { lat: robot.lat, lon: robot.lon };
    let moves = 0;
    const route = [...driven[0], ...driven[1].slice(1)];
    for (let tick = 0; tick < 5000 && robot.task; tick += 1) {
      now += 2000;
      if (robot.phase && robot.phase.startsWith("TO_")) robot.speed = STANDARD_SPEED;
      robot._advanceTask(now);
      if (robot.lat !== lastPosition.lat || robot.lon !== lastPosition.lon) moves += 1;
      lastPosition = { lat: robot.lat, lon: robot.lon };
      // Every position the agent ever reports lies on the route — it follows the ways.
      expect(offRouteMetres(lastPosition, route)).toBeLessThan(TOLERANCE_M);
    }

    expect(robot.socket.of("TASK_COMPLETE")).toHaveLength(1);
    expect(moves).toBeGreaterThan(10);
    // The decisive number: the distance driven is the distance priced.
    expect(Math.abs(robot.distanceTravelled - pricedDistance)).toBeLessThan(TOLERANCE_M);
    expect(robot.lat).toBeCloseTo(DROP.lat, 6);
    expect(robot.lon).toBeCloseTo(DROP.lon, 6);
  });

  test("the REAL commit puts the priced route on the OFFER, and asks no provider for a second one", async () => {
    const commitmentModule = require("../../src/engine/commitment/commit");
    const offers = require("../../src/engine/dispatch/offers");
    const legEntryDeadline = require("../../src/engine/cutover/legEntryDeadline");
    try {
      const { round, deps } = realRound();
      const agent = { ...simulatedAgent(ROBOT_AT), agentRowId: "agent-row-1", authorityEpoch: "1" };
      const traversal = await round.routing.forPairing(agent.cellId, LEG_STOPS, round.profileKeyFor(agent), { lat: agent.lat, lon: agent.lon });
      const pricedPaths = traversal.pathsForSequence(LEG_STOPS);

      round.rememberLeg({
        leg: { legId: "LEG-1", legRowId: "leg-row-1", version: 3, state: "QUEUED", tasks: { taskIds: ["TASK-1"] }, manifests: [] },
        scope: {},
        decisionTimeMs: 0,
      });
      round.agentIdentity.set("agent-row-1", "agent-row-1");
      round.priced.set("LEG-1|agent-row-1", {
        plan: { planId: "plan-1", stops: LEG_STOPS, reserves: null, charging: null },
        stopPaths: pricedPaths,
        authorityEpoch: "1",
      });
      round.freshAgentSnapshot = async () => agent;

      const provider = jest.spyOn(executionGeometry, "attachStopPaths");
      let sideEffects = null;
      jest.spyOn(commitmentModule, "commit").mockImplementation(async (store) => {
        sideEffects = store.sideEffects;
        return { committed: true };
      });
      const enqueue = jest.spyOn(offers, "enqueueOffer").mockImplementation(async (tx, input) => ({ offer: input.offer }));
      jest.spyOn(legEntryDeadline, "superviseEntry").mockResolvedValue(null);

      await deps.commit({ legId: "leg-row-1", agentId: "agent-row-1" }, { roundId: "r-1", leadershipFence: 1 });
      await sideEffects({}, { commitment: { commitmentId: "CMT-1", fence: 1n }, storeTime: new Date(), leg: {} });

      expect(provider).not.toHaveBeenCalled();
      const offer = enqueue.mock.calls[0][1].offer;
      expect(offer.stopSequence.map((stop) => stop.pathProfile)).toEqual([
        executionGeometry.PRICED_ROUTE_PROFILE,
        executionGeometry.PRICED_ROUTE_PROFILE,
      ]);
      offer.stopSequence.forEach((stop, i) => {
        expect(stop.path).toHaveLength(pricedPaths[i].path.length);
        stop.path.forEach((point, k) => {
          expect(haversineMeters(point.lat, point.lon, pricedPaths[i].path[k].lat, pricedPaths[i].path[k].lon)).toBeLessThan(0.01);
        });
      });
    } finally {
      jest.restoreAllMocks();
    }
  });

  test("a stop with no priced route carries no path, and the agent refuses the offer by name", () => {
    const plannedStops = LEG_STOPS.map(({ sequence, stopType, lat, lon }) => ({ sequence, stopType, lat, lon }));
    const geometry = executionGeometry.attachPricedPaths({ stops: plannedStops, pricedPaths: [null, null] });
    expect(geometry.unroutable).toEqual([1, 2]);
    expect(geometry.stops.every((stop) => stop.path === undefined)).toBe(true);

    const robot = new VirtualRobot({ robotId: "SIM-R2", lat: ROBOT_AT.lat, lon: ROBOT_AT.lon, logger: silentLogger, simulated: true });
    robot.socket = recordingSocket();
    robot.connected = true;
    robot.battery = 90;
    robot._respondToOffer({ commitmentId: "CMT-2", fence: "1", payload: { stopSequence: geometry.stops, taskId: "T" } });
    expect(robot.socket.of("OFFER_REJECT")[0].payload.reason).toMatch(/^NO_EXECUTABLE_PATH/);
  });

  test("a simulated agent is given no second, post-decision route by the execution-geometry seam", async () => {
    const seams = v1Composition();
    const provider = seams.directionsFor(simulatedAgent(ROBOT_AT));
    expect(await provider({ from: ROBOT_AT, to: PICKUP })).toBeNull();
    const routed = await executionGeometry.attachStopPaths({ from: ROBOT_AT, stops: [{ sequence: 1, ...PICKUP }], directions: provider });
    expect(routed.unroutable).toEqual([1]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   5. RECALL / WITHDRAW — the stood-down unit's assignment and route are released
   ═══════════════════════════════════════════════════════════════════════════ */

describe("5 — an acknowledged stand-down releases the read model and tells the dashboard", () => {
  function storeDouble({ heldBy }) {
    const writes = [];
    const tx = {
      task: {
        updateMany: async (args) => {
          writes.push(["task", args]);
          return { count: args.where.robotId === heldBy ? 1 : 0 };
        },
      },
      robot: { updateMany: async (args) => (writes.push(["robot", args]), { count: 1 }) },
    };
    return {
      writes,
      commitment: { findUnique: async () => ({ legId: "leg-row-1" }) },
      leg: { findUnique: async () => ({ mission: { tasks: [{ id: "task-row-1", taskId: "TASK-1", status: "ASSIGNED" }] } }) },
      robot: { findUnique: async () => ({ id: "robot-row-1" }) },
      $transaction: async (fn) => fn(tx),
    };
  }

  function ioDouble() {
    const emitted = [];
    return { emitted, to: () => ({ emit: (event, payload) => emitted.push({ event, payload }) }) };
  }

  test("the task returns to PENDING, the robot is unbound, and TASK_UPDATED names the unit that stood down", async () => {
    const prisma = storeDouble({ heldBy: "robot-row-1" });
    const io = ioDouble();
    const kv = memoryKv();
    await kv.set("taskPath:TASK-1", "{}");
    const out = await commandHandler.publishStandDown({ prisma, kv, io, log: silentLogger, robotId: "SIM-A", commitmentId: "CMT-1" });

    expect(out.released).toBe(true);
    const [taskWrite] = prisma.writes.find(([table]) => table === "task").slice(1);
    expect(taskWrite.where).toMatchObject({ id: "task-row-1", robotId: "robot-row-1", status: { in: ["ASSIGNED", "IN_PROGRESS"] } });
    expect(taskWrite.data).toEqual({ robotId: null, status: "PENDING", startedAt: null });
    expect(io.emitted).toEqual([
      {
        event: "TASK_UPDATED",
        payload: expect.objectContaining({ taskId: "TASK-1", releasedRobotId: "SIM-A", status: "PENDING", action: "RECALLED" }),
      },
    ]);
    // `robotId` on TASK_UPDATED means "the task's robot"; it must not name the unit that left.
    expect(io.emitted[0].payload.robotId).toBeUndefined();
    expect(kv.store.has("taskPath:TASK-1")).toBe(false);
  });

  test("a task already re-projected onto another robot (or cancelled) is left alone, and nothing is emitted", async () => {
    const prisma = storeDouble({ heldBy: "another-robot" });
    const io = ioDouble();
    const out = await commandHandler.publishStandDown({ prisma, kv: memoryKv(), io, log: silentLogger, robotId: "SIM-A", commitmentId: "CMT-1" });
    expect(out.released).toBe(false);
    expect(io.emitted).toEqual([]);
  });

  test("only RECALL and WITHDRAW are stand-downs; ABORT_MISSION halts holding the task", () => {
    expect([...commandHandler.STAND_DOWN_COMMANDS].sort()).toEqual(["RECALL", "WITHDRAW"]);
  });
});
