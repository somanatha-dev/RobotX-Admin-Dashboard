"use strict";

/**
 * Physical routes stay inside the operating boundary (RD-2026-10-12-01 AC1), and every access
 * connector is bounded by the declared snap radius (AC2, R13).
 *
 * The defect: the campus extract's ways run outside the adopted RNSIT polygon, and the router
 * only checked endpoints, so 14 of the 56 ordered pairs between the in-campus named points
 * (every pair touching `rnsit-playground-2`) routed through ground the boundary excludes.
 *
 * Synthetic geometry (sections A and B) is test data for edge cases, not a claim about any
 * site. Sections C and D use the repository's real RNSIT extract and named points.
 */

const fs = require("fs");
const path = require("path");

const network = require("../../src/simulation/campusTraversalNetwork");
const routeContainment = require("../../src/services/fleetProviders/routeContainment");
const physicalRouter = require("../../src/services/fleetProviders/physicalRouter");
const physicalPolicy = require("../../src/services/fleetProviders/physicalPolicy");
const robotSpecification = require("../../src/services/robotSpecification");
const campusTravelModel = require("../../src/engine/routing/campusTravelModel");
const { RouteRefusedError, ROUTE_REFUSAL } = require("../../src/engine/routing/productionRouter");
const service = require("../../src/engine/config/service");
const cells = require("../../src/engine/spatial/cells");
const demonstration = require("../../tools/config/v1DemonstrationConfig");
const { haversineMeters } = require("../../src/utils/distance");

const { NETWORK_REFUSAL } = network;

/* ── A synthetic U-shaped site ────────────────────────────────────────────────
 *
 *   (0,4) ┌──┐      ┌──┐ (6,4)       units of 0.001°, offset from (77.5, 12.9)
 *         │L │      │ R│             the notch x∈(2,4), y∈(1,4) is OUTSIDE
 *         │  └──────┘  │
 *   (0,0) └────────────┘ (6,0)
 */
const LON0 = 77.5;
const LAT0 = 12.9;
const UNIT = 0.001;
const at = (x, y) => [LON0 + x * UNIT, LAT0 + y * UNIT];
const pt = (x, y) => ({ lon: LON0 + x * UNIT, lat: LAT0 + y * UNIT });

function regionDeclaration(boundary) {
  return {
    regionId: "synthetic-site",
    name: "Synthetic test site",
    kind: "CAMPUS",
    crs: "EPSG:4326",
    version: "way/1",
    versionDate: "2026-10-12",
    boundary,
  };
}

// Counter-clockwise exterior (RFC 7946).
const U_BOUNDARY = {
  type: "Polygon",
  coordinates: [[at(0, 0), at(6, 0), at(6, 4), at(4, 4), at(4, 1), at(2, 1), at(2, 4), at(0, 4), at(0, 0)]],
};
const U = routeContainment.createRouteContainment(regionDeclaration(U_BOUNDARY));

const way = (id, highway, coordinates) => ({ type: "Feature", id, properties: { highway }, geometry: { type: "LineString", coordinates } });

describe("A — routeContainment: a segment is contained only if it is wholly inside", () => {
  test("the U-shaped boundary validates and is usable", () => {
    expect(U.usable).toBe(true);
    expect(U.problems).toEqual([]);
  });

  test("a segment inside one arm is contained", () => {
    expect(U.containsSegment(pt(1, 0.5), pt(1, 3.5))).toBe(true);
  });

  test("both ends inside, but crossing the outside notch: NOT contained", () => {
    expect(U.containsPoint(pt(1, 3))).toBe(true);
    expect(U.containsPoint(pt(5, 3))).toBe(true);
    expect(U.containsSegment(pt(1, 3), pt(5, 3))).toBe(false);
  });

  test("a segment touching a boundary vertex, or ending on the boundary, is NOT contained", () => {
    expect(U.containsSegment(pt(1, 0.5), pt(3, 1))).toBe(false); // ends on the notch floor
    expect(U.containsSegment(pt(1, 2), pt(3, 0))).toBe(false); // passes exactly through (2, 1)
    expect(U.containsPoint(pt(0, 2))).toBe(false); // on the exterior ring
  });

  test("a segment crossing a hole is NOT contained; one beside it is", () => {
    const withHole = routeContainment.createRouteContainment(
      regionDeclaration({
        type: "Polygon",
        coordinates: [
          [at(0, 0), at(6, 0), at(6, 4), at(0, 4), at(0, 0)],
          [at(2, 1), at(2, 3), at(4, 3), at(4, 1), at(2, 1)], // clockwise hole
        ],
      }),
    );
    expect(withHole.usable).toBe(true);
    expect(withHole.containsSegment(pt(1, 2), pt(5, 2))).toBe(false);
    expect(withHole.containsSegment(pt(1, 3.5), pt(5, 3.5))).toBe(true);
  });

  test("an absent or invalid boundary contains nothing", () => {
    for (const declaration of [null, regionDeclaration(null), regionDeclaration({ type: "Polygon", coordinates: [[at(0, 0), at(1, 1)]] })]) {
      const containment = routeContainment.createRouteContainment(declaration);
      expect(containment.usable).toBe(false);
      expect(containment.problems.length).toBeGreaterThan(0);
      expect(containment.containsPoint(pt(1, 1))).toBe(false);
      expect(containment.containsSegment(pt(1, 1), pt(1, 2))).toBe(false);
    }
  });
});

describe("B — the contained network: no edge, connector or path leaves the boundary", () => {
  const features = [
    // The arms' ways share an OSM node with the shortcut at (1, 3) and (5, 3), so they connect.
    way("w-left", "footway", [at(1, 0.5), at(1, 3), at(1, 3.5)]),
    way("w-right", "footway", [at(5, 0.5), at(5, 3), at(5, 3.5)]),
    // Runs straight across the outside notch — the shape of the RNSIT defect.
    way("w-shortcut", "footway", [at(1, 3), at(5, 3)]),
  ];
  const full = network.createCampusTraversalNetwork({ features, roadClasses: ["footway"], source: "synthetic" });
  const contained = network.createCampusTraversalNetwork({ features, roadClasses: ["footway"], source: "synthetic", containment: U });

  test("REPRODUCTION — without containment the route cuts across the outside notch", () => {
    const routed = full.route(pt(1, 3.4), pt(5, 3.4));
    expect(routed.ok).toBe(true);
    // Every point is inside; the piece between (1, 3) and (5, 3) is not.
    expect(routed.points.every((p) => U.containsPoint(p))).toBe(true);
    expect(routed.points.slice(1).some((p, i) => !U.containsSegment(routed.points[i], p))).toBe(true);
  });

  test("with containment the notch-crossing edge is never built", () => {
    expect(contained.contained).toBe(true);
    expect(contained.excludedSegmentCount).toBe(1);
    expect(contained.segmentCount).toBe(full.segmentCount - 1);
    expect(contained.describe()).toMatch(/boundary-contained/);
  });

  test("DISCONNECTED — the arms are no longer joined, so the route is refused, never a straight line", () => {
    const routed = contained.route(pt(1, 3.4), pt(5, 3.4));
    expect(routed).toMatchObject({ ok: false, refusal: NETWORK_REFUSAL.NOT_CONNECTED });
  });

  test("joined by an inside way, the route goes round the notch and every piece is contained", () => {
    const joined = network.createCampusTraversalNetwork({
      features: [...features, way("w-bottom", "footway", [at(1, 0.5), at(5, 0.5)])],
      roadClasses: ["footway"],
      source: "synthetic",
      containment: U,
    });
    const routed = joined.route(pt(1, 3.4), pt(5, 3.4));
    expect(routed.ok).toBe(true);
    for (let i = 1; i < routed.points.length; i += 1) expect(U.containsSegment(routed.points[i - 1], routed.points[i])).toBe(true);
  });

  test("an endpoint outside the boundary (in the notch) is refused by name", () => {
    expect(contained.route(pt(3, 2), pt(1, 1))).toMatchObject({ ok: false, refusal: NETWORK_REFUSAL.ENDPOINT_OUTSIDE_BOUNDARY });
    expect(contained.route(pt(1, 1), pt(3, 2))).toMatchObject({ ok: false, refusal: NETWORK_REFUSAL.ENDPOINT_OUTSIDE_BOUNDARY });
  });

  test("INVALID CONNECTOR — the nearest way is across the notch; with no inside way the endpoint is refused", () => {
    // Only the right arm exists; (1.9, 3.5) is inside the left arm, nearest the right-arm way across the notch.
    const rightOnly = network.createCampusTraversalNetwork({
      features: [way("w-right", "footway", [at(5, 0.5), at(5, 3.5)])],
      roadClasses: ["footway"],
      source: "synthetic",
      containment: U,
    });
    expect(rightOnly.route(pt(1.9, 3.5), pt(5, 2))).toMatchObject({ ok: false, refusal: NETWORK_REFUSAL.ACCESS_LEAVES_BOUNDARY });
  });

  test("a connector that would cross the notch is replaced by the nearest inside one", () => {
    // (1.9, 3.5): nearest way is the right arm across the notch; the left-arm way is inside.
    const routed = contained.route(pt(1.9, 3.5), pt(1, 1));
    expect(routed.ok).toBe(true);
    expect(routed.points[1].lon).toBeCloseTo(LON0 + 1 * UNIT, 12);
    expect(U.containsSegment(routed.points[0], routed.points[1])).toBe(true);
  });

  test("a connector longer than maxAccessM is refused; a non-positive bound is refused", () => {
    const access = haversineMeters(LAT0 + 3.5 * UNIT, LON0 + 1.9 * UNIT, LAT0 + 3.5 * UNIT, LON0 + 1 * UNIT);
    expect(contained.route(pt(1.9, 3.5), pt(1, 1), { maxAccessM: access + 1 }).ok).toBe(true);
    expect(contained.route(pt(1.9, 3.5), pt(1, 1), { maxAccessM: access - 1 })).toMatchObject({ ok: false, refusal: NETWORK_REFUSAL.ACCESS_TOO_LONG });
    for (const bad of [0, -5, Number.NaN, "50"]) {
      expect(contained.route(pt(1, 1), pt(1, 2), { maxAccessM: bad })).toMatchObject({ ok: false, refusal: NETWORK_REFUSAL.ACCESS_TOO_LONG });
    }
  });

  test("a network with no inside way refuses rather than routing outside", () => {
    const outsideOnly = network.createCampusTraversalNetwork({
      features: [way("w-shortcut", "footway", [at(1, 3), at(5, 3)])],
      roadClasses: ["footway"],
      source: "synthetic",
      containment: U,
    });
    expect(outsideOnly.segmentCount).toBe(0);
    expect(outsideOnly.route(pt(1, 1), pt(1, 2))).toMatchObject({ ok: false, refusal: NETWORK_REFUSAL.NO_PERMITTED_WAYS });
  });

  test("without containment or maxAccessM, behaviour is unchanged (the simulation paths)", () => {
    expect(full.contained).toBe(false);
    expect(full.excludedSegmentCount).toBe(0);
    expect(full.describe()).toMatch(/^DEVELOPMENT_SIMULATION/);
    const routed = full.route(pt(1.9, 3.5), pt(5, 2));
    expect(routed.ok).toBe(true); // nearest way taken across the notch, exactly as before
  });
});

/* ── The real RNSIT campus ──────────────────────────────────────────────────── */

const REPO = path.resolve(__dirname, "..", "..", "..");
const BOUNDARY_WAY = "way/1120154292";
const EXTRACT = JSON.parse(fs.readFileSync(path.join(REPO, "rnsit-campus-osm.geojson"), "utf8"));
const DELIVERY_DOMAIN = Object.freeze({
  regionId: "rnsit-campus",
  name: "RNSIT Campus",
  kind: "CAMPUS",
  crs: "EPSG:4326",
  version: BOUNDARY_WAY,
  versionDate: "2026-08-30",
  boundary: EXTRACT.features.find((feature) => feature.id === BOUNDARY_WAY).geometry,
});
const NAMED = JSON.parse(fs.readFileSync(path.join(REPO, "rnsit-campus-supplemental.geojson"), "utf8")).features.map((feature) => ({
  id: feature.properties.id,
  lat: feature.geometry.coordinates[1],
  lon: feature.geometry.coordinates[0],
}));
const RNSIT = routeContainment.createRouteContainment(DELIVERY_DOMAIN);
const ROVER = robotSpecification.CHASSIS_TEMPLATE[robotSpecification.CHASSIS_TYPE.ROVER].permissionSet;
const CLASSES = network.permittedClasses(ROVER);
const INSIDE_NAMED = NAMED.filter((p) => RNSIT.containsPoint(p));

// TEST FIXTURES, not owner values (R13 has none yet; RD-2026-10-12-01 AC2). The wide one admits
// every named point (rnsit-playground-2's nearest inside way is ~59.7 m away); the narrow one
// shows that same connector refused.
const TEST_SNAP_RADIUS_WIDE_M = 120;
const TEST_SNAP_RADIUS_NARROW_M = 50;

function pathExits(points) {
  for (let i = 1; i < points.length; i += 1) if (!RNSIT.containsSegment(points[i - 1], points[i])) return true;
  return false;
}

function gridInside() {
  const ring = DELIVERY_DOMAIN.boundary.coordinates[0];
  const lons = ring.map((p) => p[0]);
  const lats = ring.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...lons), Math.max(...lons), Math.min(...lats), Math.max(...lats)];
  const out = [];
  for (let i = 1; i < 12; i += 1) {
    for (let j = 1; j < 12; j += 1) {
      const p = { lon: x0 + ((x1 - x0) * i) / 12, lat: y0 + ((y1 - y0) * j) / 12 };
      if (RNSIT.containsPoint(p)) out.push(p);
    }
  }
  return out;
}

describe("C — RNSIT: the reproduced defect is gone", () => {
  const full = network.createCampusTraversalNetwork({ features: EXTRACT.features, roadClasses: CLASSES, source: "rnsit" });
  const contained = network.createCampusTraversalNetwork({ features: EXTRACT.features, roadClasses: CLASSES, source: "rnsit", containment: RNSIT });

  test("REPRODUCTION — on the uncontained network, 14 of 56 named in-campus pairs leave the boundary", () => {
    expect(INSIDE_NAMED).toHaveLength(8);
    let exits = 0;
    for (const a of INSIDE_NAMED) for (const b of INSIDE_NAMED) if (a !== b && pathExits(full.route(a, b).points)) exits += 1;
    expect(exits).toBe(14);
  });

  test("the contained network drops the 19 outside segments and stays one connected piece", () => {
    expect(contained.excludedSegmentCount).toBe(19);
    expect(contained.segmentCount).toBe(full.segmentCount - 19);
    expect(contained.componentCount).toBe(1);
  });

  test("all 56 named pairs route, and none leaves the boundary", () => {
    for (const a of INSIDE_NAMED) {
      for (const b of INSIDE_NAMED) {
        if (a === b) continue;
        const routed = contained.route(a, b);
        expect(routed.ok).toBe(true);
        expect(pathExits(routed.points)).toBe(false);
      }
    }
  });

  test("a 64-point in-campus grid: every one of 4,032 routes stays inside", () => {
    const grid = gridInside();
    expect(grid).toHaveLength(64);
    let refused = 0;
    for (const a of grid) {
      for (const b of grid) {
        if (a === b) continue;
        const routed = contained.route(a, b);
        if (!routed.ok) {
          refused += 1;
          continue;
        }
        expect(pathExits(routed.points)).toBe(false);
      }
    }
    expect(refused).toBe(0);
  });
});

describe("D — the physical router on RNSIT: containment, the snap radius, and priced = returned", () => {
  function snapshot() {
    const real = service.defaultSnapshot();
    const map = Object.fromEntries([...demonstration.bindings(), ...demonstration.executionBindings()].map((row) => [row.name, row.value]));
    return Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
      deliveryDomain: DELIVERY_DOMAIN,
      resolve: (name, context, options) => (Object.prototype.hasOwnProperty.call(map, name) ? map[name] : real.resolve(name, context, options)),
    });
  }
  const SNAPSHOT = snapshot();

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
        snapRadiusM: TEST_SNAP_RADIUS_WIDE_M,
        ...(siteOverrides || {}),
      },
      localisation: { referenceRadiusM: 25, acceptedFixTypes: ["3D"] },
      risk: { failureProbabilityPrior: 0.05, routeHazardCu: 0 },
      robots: [],
    };
  }
  const routerWith = (siteOverrides) =>
    physicalRouter.createPhysicalRouter({ snapshot: () => SNAPSHOT, policy: physicalPolicy.fromDeclaration(declaration(siteOverrides)) });
  const SPEED = 1;
  const KEY = `PHYSICAL:v=${SPEED}:wh=86:net=${CLASSES.join("+")}`;
  const partsFor = (from, to) => ({
    originCell: cells.cellForPoint(from.lat, from.lon, cells.RESOLUTION.FINE),
    destCell: cells.cellForPoint(to.lat, to.lon, cells.RESOLUTION.FINE),
    originPoint: from,
    destPoint: to,
    profileKey: KEY,
    timeBucket: 10,
  });
  const named = (id) => NAMED.find((p) => p.id === id);

  test("every previously-exiting named pair is now priced on a contained route", async () => {
    const router = routerWith();
    const playground = named("rnsit-playground-2");
    for (const other of INSIDE_NAMED.filter((p) => p !== playground)) {
      for (const [a, b] of [[playground, other], [other, playground]]) {
        const route = await router.route(partsFor(a, b));
        expect(pathExits(route.path)).toBe(false);
      }
    }
  });

  test("PRICED = RETURNED — distance is the returned path's length, time is the model over that distance", async () => {
    const router = routerWith();
    const params = campusTravelModel.resolveModelParameters(SNAPSHOT, {});
    for (const [a, b] of [["rnsit-innovation-center", "rnsit-food-court"], ["rnsit-playground-2", "rnsit-canara-bank"]]) {
      const from = named(a);
      const to = named(b);
      const route = await router.route(partsFor(from, to));
      let length = 0;
      for (let i = 1; i < route.path.length; i += 1) {
        length += haversineMeters(route.path[i - 1].lat, route.path[i - 1].lon, route.path[i].lat, route.path[i].lon);
      }
      expect(route.distanceM).toBeCloseTo(length, 9);
      expect(route.path[0]).toEqual({ lat: from.lat, lon: from.lon });
      expect(route.path[route.path.length - 1]).toEqual({ lat: to.lat, lon: to.lon });
      const modelled = campusTravelModel.travelTimeFor({
        distanceM: route.distanceM,
        speedMetresPerSecond: SPEED,
        bufferSecondsPer100m: params.bufferSecondsPer100m,
        sdBufferMultiple: params.sdBufferMultiple,
      });
      expect(route.travelSeconds).toBe(modelled.travelSeconds);
      expect(route.travelSdSeconds).toBe(modelled.travelSdSeconds);
      expect(route.accessM.origin).toBeLessThanOrEqual(TEST_SNAP_RADIUS_WIDE_M);
      expect(route.accessM.destination).toBeLessThanOrEqual(TEST_SNAP_RADIUS_WIDE_M);
    }
  });

  test("NO SNAP RADIUS DECLARED — every physical route is refused, and the policy says why", async () => {
    for (const snapRadiusM of [undefined, null, 0, -1, "50"]) {
      const error = await routerWith({ snapRadiusM }).route(partsFor(named("rnsit-innovation-center"), named("rnsit-food-court"))).catch((e) => e);
      expect(error).toBeInstanceOf(RouteRefusedError);
      expect(error.refusal).toBe(ROUTE_REFUSAL.NOT_ROUTABLE);
      expect(error.detail).toEqual({ refusal: "NO_SNAP_RADIUS" });
    }
    expect(physicalPolicy.fromDeclaration(declaration({ snapRadiusM: undefined })).problems.join(" ")).toMatch(/site\.snapRadiusM/);
    expect(physicalPolicy.fromDeclaration(declaration()).site.snapRadiusM).toBe(TEST_SNAP_RADIUS_WIDE_M);
  });

  test("INVALID CONNECTOR on real data — playground-2's ~59.7 m connector is refused under a narrower bound", async () => {
    const error = await routerWith({ snapRadiusM: TEST_SNAP_RADIUS_NARROW_M })
      .route(partsFor(named("rnsit-playground-2"), named("rnsit-food-court")))
      .catch((e) => e);
    expect(error).toBeInstanceOf(RouteRefusedError);
    expect(error.refusal).toBe(ROUTE_REFUSAL.NOT_ROUTABLE);
    expect(error.detail).toEqual({ refusal: NETWORK_REFUSAL.ACCESS_TOO_LONG });
  });

  test("an exact endpoint outside the boundary is refused as outside the serviceable region", async () => {
    // rnsit-main-gate is 33.4 m outside the adopted perimeter (RD-2026-08-30-01 §5).
    const gate = named("rnsit-main-gate");
    expect(RNSIT.containsPoint(gate)).toBe(false);
    const error = await routerWith().route(partsFor(gate, named("rnsit-food-court"))).catch((e) => e);
    expect(error).toBeInstanceOf(RouteRefusedError);
    expect(error.refusal).toBe(ROUTE_REFUSAL.OUTSIDE_SERVICEABLE_REGION);
  });

  test("MAP_MATCH is a measurement, not a route: it still answers for a fix outside the boundary", () => {
    const gate = named("rnsit-main-gate");
    const divergence = routerWith().mapMatchDivergenceM(gate, ROVER);
    expect(typeof divergence).toBe("number");
    expect(Number.isFinite(divergence)).toBe(true);
  });
});
