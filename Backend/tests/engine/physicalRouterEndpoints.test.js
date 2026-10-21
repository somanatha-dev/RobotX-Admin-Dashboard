"use strict";

/**
 * The physical router's endpoint checks and its snap radius, against the simulation router's.
 * Audit of 2026-10-21, `physicalRouter.js:178` and R13 `site.snapRadiusM`.
 *
 * What this pins:
 *
 *   A. missing configuration — R13 has no value anywhere (RD-2026-10-12-01 AC2 is pending), and
 *      without one every physical route is refused NO_SNAP_RADIUS, before any geometry is read.
 *   B. exact endpoints are checked on the points routed (`projectExactPoint`), as the
 *      simulation router has since de03788: a point outside the campus is refused whatever its
 *      cell centre says; a point INSIDE the campus in a boundary cell is routed, and its route
 *      never leaves the campus (incident 2026-10-13, cell 8b601451284cfff — before 2026-10-21
 *      the physical router refused it on the cell's CENTRE); a point not in the cell the request
 *      names for it is refused.
 *   C. cell-only requests keep the cell-centre check, in both routers.
 *   D. boundary exclusions — Playground 2's nearest permitted segment crosses the boundary, so
 *      the physical (contained) network excludes it and the access connector is 59.7 m; the
 *      simulation network snaps to a point OUTSIDE the campus instead.
 *   E. the differences between the two routers, side by side.
 *
 * Every snap radius below is a TEST DOUBLE that isolates one check. None is a proposed value:
 * R13 is the owner's (RD-2026-10-12-01 AC2).
 */

const fs = require("fs");
const path = require("path");

const cells = require("../../src/engine/spatial/cells");
const serviceability = require("../../src/engine/routing/campusServiceability");
const cellProjection = require("../../src/engine/routing/cellProjection");
const configService = require("../../src/engine/config/service");
const campusTravelModel = require("../../src/engine/routing/campusTravelModel");
const { RouteRefusedError, ROUTER_MODE, ROUTE_REFUSAL } = require("../../src/engine/routing/productionRouter");
const simulationPolicy = require("../../src/simulation/simulationPolicy");
const simulationRouter = require("../../src/simulation/simulationRouter");
const campusTraversalNetwork = require("../../src/simulation/campusTraversalNetwork");
const physicalRouter = require("../../src/services/fleetProviders/physicalRouter");
const physicalPolicy = require("../../src/services/fleetProviders/physicalPolicy");
const routeContainment = require("../../src/services/fleetProviders/routeContainment");
const demonstration = require("../../tools/config/v1DemonstrationConfig");
const { haversineMeters } = require("../../src/utils/distance");

const { NETWORK_REFUSAL } = campusTraversalNetwork;

/* ── The campus, from the repository's own data ────────────────────────────── */

const REPO = path.resolve(__dirname, "..", "..", "..");
const BOUNDARY_WAY = "way/1120154292";
const read = (file) => JSON.parse(fs.readFileSync(path.join(REPO, file), "utf8"));
const EXTRACT = read("rnsit-campus-osm.geojson");
const SUPPLEMENTAL = read("rnsit-campus-supplemental.geojson");
const REGISTER = read("rnsit-campus-access-candidates.geojson");
const DECLARATION = Object.freeze({
  regionId: "rnsit-campus",
  name: "RNSIT Campus",
  kind: "CAMPUS",
  crs: "EPSG:4326",
  version: BOUNDARY_WAY,
  versionDate: "2026-08-30",
  boundary: EXTRACT.features.find((f) => f.id === BOUNDARY_WAY).geometry,
});
const ORACLE = serviceability.createServiceabilityOracle(DECLARATION);
const CONTAINMENT = routeContainment.createRouteContainment(DECLARATION);
const CLASSES = campusTraversalNetwork.permittedClasses({ roadClasses: ["footway", "path", "service"], stairCapable: false });
const SIM_NETWORK = campusTraversalNetwork.createCampusTraversalNetwork({ features: EXTRACT.features, roadClasses: CLASSES, source: "rnsit" });
const PHYS_NETWORK = campusTraversalNetwork.createCampusTraversalNetwork({
  features: EXTRACT.features,
  roadClasses: CLASSES,
  source: "rnsit",
  containment: CONTAINMENT,
});

/* ── Fixtures ──────────────────────────────────────────────────────────────── */

const named = (id) => {
  const [lon, lat] = SUPPLEMENTAL.features.find((f) => f.properties.id === id).geometry.coordinates;
  return Object.freeze({ lat, lon });
};
/** The 2026-10-13 incident robot (exactPointContainment.test.js): inside, in a boundary cell. */
const ECE_ROBOT = Object.freeze({ lat: 12.90241739, lon: 77.51785585 });
/** The ECE Department access candidate in the same boundary cell. */
const ECE_CANDIDATE = (() => {
  const f = REGISTER.features.find(
    (x) => x.properties.buildingSourceId === "way/204638932" && x.properties.validation.fineCell === "8b601451284cfff",
  );
  return Object.freeze({ lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] });
})();
/** Just OUTSIDE the campus, in a cell whose centre is INSIDE (exactPointContainment.test.js). */
const OUTSIDE_POINT = Object.freeze({ lat: 12.90037095, lon: 77.51908061 });
const FAR_ROBOT = Object.freeze({ lat: 12.90098435, lon: 77.5187759 });
const CYBER_SECURITY = named("rnsit-cyber-security-department");
const FOOD_COURT = named("rnsit-food-court");
const PLAYGROUND_2 = named("rnsit-playground-2");

const fine = (p) => cells.cellForPoint(p.lat, p.lon, cells.RESOLUTION.FINE);
const status = (p) => ORACLE.assess(p.lat, p.lon).status;
const centreStatus = (p) => status(cells.centreOfCell(fine(p)));
const outsidePoints = (points) => points.filter((p) => !CONTAINMENT.containsPoint(p));

/* ── The two routers, as their compositions build them ─────────────────────── */

const SNAPSHOT = (() => {
  const real = configService.defaultSnapshot();
  const bound = Object.fromEntries([...demonstration.bindings(), ...demonstration.executionBindings()].map((r) => [r.name, r.value]));
  return Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
    deliveryDomain: DECLARATION,
    resolve: (name, c, o) => (Object.prototype.hasOwnProperty.call(bound, name) ? bound[name] : real.resolve(name, c, o)),
  });
})();

/** TEST DOUBLE R13 values, each isolating one check. */
const TEST_SNAP_WIDE_M = 120;

function declaration(siteOverrides) {
  return {
    charging: { policy: "MANUAL_OUT_OF_SERVICE" },
    stateOfCharge: { policy: "OPERATOR_DECLARED", maxAgeSeconds: 7200 },
    emergencyStop: { mechanism: "SOFTWARE_STOP_LATCH" },
    site: {
      ambientC: { min: 18, max: 38 },
      terrain: "FLAT_DECLARED",
      connectivityDeadZones: "NONE_DECLARED",
      constrictions: "NONE_DECLARED",
      stopStartCyclesPerHop: 1,
      snapRadiusM: TEST_SNAP_WIDE_M,
      ...(siteOverrides || {}),
    },
    localisation: { referenceRadiusM: 25, acceptedFixTypes: ["3D"] },
    risk: { failureProbabilityPrior: 0.05, routeHazardCu: 0 },
    robots: [],
  };
}

const physical = (siteOverrides, snapshot = SNAPSHOT) =>
  physicalRouter.createPhysicalRouter({ snapshot: () => snapshot, policy: physicalPolicy.fromDeclaration(declaration(siteOverrides)) });
const simulated = () =>
  simulationRouter.createSimulationRouter({
    projection: cellProjection.createCellProjection({ serviceability: ORACLE }),
    travelModel: campusTravelModel.resolveModelParameters(SNAPSHOT, {}),
    agents: [{ robotId: "SIM-PHYS-AUDIT", simulated: true }],
    mode: ROUTER_MODE.DEVELOPMENT,
    env: { [simulationPolicy.SIMULATOR_ENV_VAR]: "true" },
    speedFor: () => 1.4,
    traversalNetworkFor: () => SIM_NETWORK,
  });

const PHYS_KEY = `PHYSICAL:v=1.4:wh=86:net=${CLASSES.join("+")}`;
const exact = (from, to, profileKey) => ({
  originCell: fine(from),
  destCell: fine(to),
  originPoint: { lat: from.lat, lon: from.lon },
  destPoint: { lat: to.lat, lon: to.lon },
  profileKey,
  timeBucket: 10,
});
const cellOnly = (from, to, profileKey) => ({ originCell: fine(from), destCell: fine(to), profileKey, timeBucket: 10 });
const refusalOf = (promise) => promise.then(() => null, (error) => error);

/* ═══════════════════════════════════════════════════════════════════════════ */

describe("preconditions — the geometry these tests rely on", () => {
  test("the incident robot and the ECE candidate are inside, in cell 8b601451284cfff, whose centre is outside", () => {
    for (const p of [ECE_ROBOT, ECE_CANDIDATE]) {
      expect(fine(p)).toBe("8b601451284cfff");
      expect(status(p)).toBe(serviceability.SERVICEABILITY.INSIDE);
      expect(centreStatus(p)).toBe(serviceability.SERVICEABILITY.OUTSIDE);
    }
  });

  test("the outside point is outside, in a cell whose centre is inside; the other fixtures are interior", () => {
    expect(status(OUTSIDE_POINT)).toBe(serviceability.SERVICEABILITY.OUTSIDE);
    expect(centreStatus(OUTSIDE_POINT)).toBe(serviceability.SERVICEABILITY.INSIDE);
    for (const p of [FAR_ROBOT, CYBER_SECURITY, FOOD_COURT, PLAYGROUND_2]) {
      expect(status(p)).toBe(serviceability.SERVICEABILITY.INSIDE);
      expect(centreStatus(p)).toBe(serviceability.SERVICEABILITY.INSIDE);
    }
  });
});

describe("A — missing configuration: R13 snapRadiusM", () => {
  test("the shipped example declaration carries no value, and loading it records why every route will be refused", async () => {
    const example = JSON.parse(fs.readFileSync(path.join(REPO, "docs/runbooks/physical-fleet.declaration.example.json"), "utf8"));
    expect(typeof example.site.snapRadiusM).toBe("string");
    expect(example.site.snapRadiusM).toMatch(/^REPLACE:.*no default exists/);
    const policy = physicalPolicy.fromDeclaration(example);
    expect(policy.site.snapRadiusM).toBeNull();
    expect(policy.problems.join(" ")).toMatch(/site\.snapRadiusM must be a positive number of metres/);
    // Every other site section is still in force: the absence is one field, not the whole file.
    expect(policy.site.terrain).toBe("FLAT_DECLARED");
    expect(policy.site.stopStartCyclesPerHop).toBe(1);
  });

  test("absent, zero, negative, non-numeric, NaN and infinite values are all refused NO_SNAP_RADIUS", async () => {
    for (const snapRadiusM of [undefined, null, 0, -1, "50", Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(physicalPolicy.fromDeclaration(declaration({ snapRadiusM })).site.snapRadiusM).toBeNull();
      const error = await refusalOf(physical({ snapRadiusM }).route(exact(FAR_ROBOT, CYBER_SECURITY, PHYS_KEY)));
      expect(error).toBeInstanceOf(RouteRefusedError);
      expect([String(snapRadiusM), error.refusal, error.detail]).toEqual([
        String(snapRadiusM),
        ROUTE_REFUSAL.NOT_ROUTABLE,
        { refusal: "NO_SNAP_RADIUS" },
      ]);
    }
  });

  test("the refusal comes before any geometry: a router with no delivery domain still says NO_SNAP_RADIUS", async () => {
    const noDomain = Object.assign(Object.create(Object.getPrototypeOf(SNAPSHOT)), SNAPSHOT, { deliveryDomain: undefined });
    const error = await refusalOf(physical({ snapRadiusM: undefined }, noDomain).route(exact(FAR_ROBOT, CYBER_SECURITY, PHYS_KEY)));
    expect(error.detail).toEqual({ refusal: "NO_SNAP_RADIUS" });
  });

  test("with no declaration at all, terrain is refused first — the snap radius is never the only gap", async () => {
    const router = physicalRouter.createPhysicalRouter({ snapshot: () => SNAPSHOT, policy: physicalPolicy.NONE });
    const error = await refusalOf(router.route(exact(FAR_ROBOT, CYBER_SECURITY, PHYS_KEY)));
    expect(error.refusal).toBe(ROUTE_REFUSAL.NO_TERRAIN_SOURCE);
    expect(physicalPolicy.NONE.site.snapRadiusM).toBeNull();
  });

  test("MAP_MATCH is a measurement and still answers without a snap radius", () => {
    const divergence = physical({ snapRadiusM: undefined }).mapMatchDivergenceM(PLAYGROUND_2, { roadClasses: CLASSES });
    expect(divergence).toBeCloseTo(49.9, 1); // the UNcontained map network, by design
  });
});

describe("B — exact endpoints in the physical router", () => {
  test("an exact point outside the campus is refused on the point itself, though its cell centre is inside", async () => {
    for (const parts of [exact(OUTSIDE_POINT, CYBER_SECURITY, PHYS_KEY), exact(CYBER_SECURITY, OUTSIDE_POINT, PHYS_KEY)]) {
      const error = await refusalOf(physical().route(parts));
      expect(error.refusal).toBe(ROUTE_REFUSAL.OUTSIDE_SERVICEABLE_REGION);
      expect(error.detail).toEqual({ refusal: cellProjection.PROJECTION_REFUSAL.OUTSIDE_SERVICEABLE_REGION });
      expect(error.message).not.toMatch(/via CELL_CENTRE/);
    }
    // The contained network refuses it too, independently — the second line of the same check.
    expect(PHYS_NETWORK.route(OUTSIDE_POINT, CYBER_SECURITY).refusal).toBe(NETWORK_REFUSAL.ENDPOINT_OUTSIDE_BOUNDARY);
  });

  test("an exact point INSIDE the campus in a boundary cell is routed, and its route never leaves the campus", async () => {
    for (const point of [ECE_ROBOT, ECE_CANDIDATE]) {
      for (const parts of [exact(point, CYBER_SECURITY, PHYS_KEY), exact(CYBER_SECURITY, point, PHYS_KEY)]) {
        const routed = await physical().route(parts);
        expect(outsidePoints(routed.path)).toEqual([]);
        expect(routed.path[0]).toEqual({ lat: parts.originPoint.lat, lon: parts.originPoint.lon });
        expect(routed.path[routed.path.length - 1]).toEqual({ lat: parts.destPoint.lat, lon: parts.destPoint.lon });
        // The contained network's own route, unchanged: same distance, same bounded connectors.
        expect(routed.distanceM).toBeCloseTo(PHYS_NETWORK.route(parts.originPoint, parts.destPoint).distanceM, 9);
        expect(Math.max(routed.accessM.origin, routed.accessM.destination)).toBeLessThan(15);
      }
    }
  });

  test("the snap radius still bounds a boundary-cell point's access connector", async () => {
    // ECE_ROBOT's connector is 9.4 m (the incident record); a TEST DOUBLE bound below it refuses.
    const parts = exact(ECE_ROBOT, CYBER_SECURITY, PHYS_KEY);
    const error = await refusalOf(physical({ snapRadiusM: 5 }).route(parts));
    expect(error.detail).toEqual({ refusal: NETWORK_REFUSAL.ACCESS_TOO_LONG });
  });

  test("an exact point that does not lie in the cell the request names for it is refused, in both routers", async () => {
    const mismatched = { ...exact(ECE_ROBOT, CYBER_SECURITY, PHYS_KEY), originCell: fine(FAR_ROBOT) };
    expect(mismatched.originCell).not.toBe(fine(ECE_ROBOT));
    const physError = await refusalOf(physical().route(mismatched));
    expect(physError.refusal).toBe(ROUTE_REFUSAL.MALFORMED_REQUEST);
    expect(physError.detail).toEqual({ refusal: cellProjection.PROJECTION_REFUSAL.EXACT_POINT_NOT_IN_CELL });
    const simError = await refusalOf(simulated().route({ ...mismatched, profileKey: "SIMULATED:test" }));
    expect(simError.detail).toEqual({ refusal: cellProjection.PROJECTION_REFUSAL.EXACT_POINT_NOT_IN_CELL });
  });

  test("a non-finite exact point makes the request cell-only, so the cell-centre check applies", async () => {
    // `cellPairCache.hasExactEndpoints` needs finite points (unchanged, shared with the simulation
    // router): such a request is cell-only, routed between cell centres, with no path…
    const interior = { ...exact(FAR_ROBOT, CYBER_SECURITY, PHYS_KEY), originPoint: { lat: Number.NaN, lon: FAR_ROBOT.lon } };
    const routed = await physical().route(interior);
    expect(routed.endpointBasis).toBe("CELL_REPRESENTATIVE");
    expect(routed.path).toBeUndefined();
    // …and in a boundary cell it is refused on the cell centre, exactly as before.
    const boundary = { ...exact(ECE_ROBOT, CYBER_SECURITY, PHYS_KEY), originPoint: { lat: Number.NaN, lon: ECE_ROBOT.lon } };
    const error = await refusalOf(physical().route(boundary));
    expect(error.refusal).toBe(ROUTE_REFUSAL.OUTSIDE_SERVICEABLE_REGION);
    expect(error.message).toMatch(/via CELL_CENTRE/);
  });
});

describe("C — cell-only requests keep the cell-centre check, in both routers", () => {
  test("a cell whose centre is outside is refused; interior cells route between their centres", async () => {
    for (const [router, key] of [[physical(), PHYS_KEY], [simulated(), "SIMULATED:test"]]) {
      const error = await refusalOf(router.route(cellOnly(ECE_ROBOT, CYBER_SECURITY, key)));
      expect(error.refusal).toBe(ROUTE_REFUSAL.OUTSIDE_SERVICEABLE_REGION);
      const routed = await router.route(cellOnly(FAR_ROBOT, CYBER_SECURITY, key));
      expect(routed.path).toBeUndefined();
      expect(routed.endpointBasis).toBe("CELL_REPRESENTATIVE");
    }
  });
});

describe("D — boundary exclusions: Playground 2", () => {
  const segmentsOf = (wayId) => {
    const coordinates = EXTRACT.features.find((f) => f.id === wayId).geometry.coordinates;
    return coordinates.slice(1).map((b, i) => [
      { lon: coordinates[i][0], lat: coordinates[i][1] },
      { lon: b[0], lat: b[1] },
    ]);
  };

  test("its nearest permitted segment crosses the boundary, so only the simulation network may use it", () => {
    const [a, b] = segmentsOf("way/788480062")[0];
    expect(CONTAINMENT.containsPoint(a)).toBe(true);
    expect(CONTAINMENT.containsPoint(b)).toBe(false);
    expect(CONTAINMENT.containsSegment(a, b)).toBe(false);

    const sim = SIM_NETWORK.route(PLAYGROUND_2, PLAYGROUND_2);
    expect(sim.accessM.origin).toBeCloseTo(49.9, 1);
    expect(CONTAINMENT.containsPoint(sim.points[1])).toBe(false); // the snap point is off campus
    const phys = PHYS_NETWORK.route(PLAYGROUND_2, PLAYGROUND_2);
    expect(phys.accessM.origin).toBeCloseTo(59.7, 1);
    expect(CONTAINMENT.containsPoint(phys.points[1])).toBe(true);
    expect(CONTAINMENT.containsSegment(PLAYGROUND_2, phys.points[1])).toBe(true);
  });

  test("the physical router admits it only under a snap radius of at least its 59.7 m connector", async () => {
    const parts = exact(PLAYGROUND_2, FOOD_COURT, PHYS_KEY);
    const narrow = await refusalOf(physical({ snapRadiusM: 59 }).route(parts)); // TEST DOUBLE
    expect(narrow.detail).toEqual({ refusal: NETWORK_REFUSAL.ACCESS_TOO_LONG });
    const routed = await physical({ snapRadiusM: 60 }).route(parts); // TEST DOUBLE
    expect(routed.accessM.origin).toBeCloseTo(59.7, 1);
    expect(outsidePoints(routed.path)).toEqual([]);
  });
});

describe("E — simulation and physical routing, side by side", () => {
  test("ECE (boundary cell): both routers route it between the exact points", async () => {
    const sim = await simulated().route(exact(ECE_ROBOT, CYBER_SECURITY, "SIMULATED:test"));
    expect(sim.distanceM).toBeGreaterThan(0);
    const phys = await physical().route(exact(ECE_ROBOT, CYBER_SECURITY, PHYS_KEY));
    expect(outsidePoints(phys.path)).toEqual([]);
  });

  test("outside point: both refuse it", async () => {
    for (const [router, key] of [[physical(), PHYS_KEY], [simulated(), "SIMULATED:test"]]) {
      const error = await refusalOf(router.route(exact(OUTSIDE_POINT, CYBER_SECURITY, key)));
      expect(error.refusal).toBe(ROUTE_REFUSAL.OUTSIDE_SERVICEABLE_REGION);
    }
  });

  test("Playground 2: the simulated route leaves the campus; the physical one stays inside and is shorter", async () => {
    const sim = await simulated().route(exact(PLAYGROUND_2, FOOD_COURT, "SIMULATED:test"));
    const phys = await physical().route(exact(PLAYGROUND_2, FOOD_COURT, PHYS_KEY));
    expect(outsidePoints(sim.path).length).toBeGreaterThan(0);
    expect(outsidePoints(phys.path)).toEqual([]);
    expect(phys.distanceM).toBeLessThan(sim.distanceM);
    expect(haversineMeters(sim.path[1].lat, sim.path[1].lon, phys.path[1].lat, phys.path[1].lon)).toBeGreaterThan(30);
  });
});
