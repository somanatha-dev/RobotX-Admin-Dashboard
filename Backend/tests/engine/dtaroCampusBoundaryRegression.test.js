"use strict";

/**
 * Regression — the DTARO alert-zone overlay and the four-zone proposal leave the RNSIT campus
 * boundary, and everything that enforces it, exactly as they were (2026-10-22).
 *
 * The authoritative boundary is OSM `way/1120154292`, adopted unmodified (RD-2026-08-30-01), in
 * the repository's `rnsit-campus-osm.geojson`. `seedV1Demonstration.loadGeometry` digest-checks
 * that file, and `bootstrapV1Environment.intendedWorld()` publishes it as the delivery-domain
 * declaration. Three things enforce it, none of them DTARO's:
 *
 *   · intake pins the exact-coordinate verdict (`deliveryDomain.evaluatePoint`) on each stop;
 *   · the round's `serviceabilityFor` composes that pin with the cell assignment, and F33 denies
 *     any stop that is not serviceable;
 *   · the router's cell projection refuses an exact endpoint outside the boundary, and a
 *     contained traversal network refuses a route that leaves it.
 *
 * The alert zone is a different thing. It is the published INDEX cover — 64 whole H3 cells,
 * 19 of whose centres lie outside the campus (owner ruling D6) — so its outline runs outside
 * the campus boundary in places. Being inside the zone confers no serviceability; the tests
 * below prove that with a point that is in the zone and outside the campus.
 *
 * All in memory: no database, no network.
 */

const fs = require("fs");
const path = require("path");
const h3 = require("h3-js");

const bootstrap = require("../../tools/deploy/bootstrapV1Environment");
const seed = require("../../tools/demo/seedV1Demonstration");
const zoneTool = require("../../tools/campus/rnsitZoneMap");
const cells = require("../../src/engine/spatial/cells");
const deliveryDomain = require("../../src/engine/spatial/deliveryDomain");
const hierarchy = require("../../src/engine/spatial/hierarchy");
const solvePath = require("../../src/workers/coordinatorSolvePath");
const f33 = require("../../src/engine/feasibility/predicates/f33");
const serviceability = require("../../src/engine/routing/campusServiceability");
const cellProjection = require("../../src/engine/routing/cellProjection");
const routeContainment = require("../../src/services/fleetProviders/routeContainment");
const net = require("../../src/simulation/campusTraversalNetwork");
const dtaroZoneAlert = require("../../src/services/dtaroZoneAlert.service");
const { publishedZoneView } = require("../../src/services/dtaroZoneView.service");

jest.setTimeout(120_000);

const BACKEND = path.resolve(__dirname, "..", "..");
const BOUNDARY_WAY = "way/1120154292";
const REGION = "rnsit";

const world = bootstrap.intendedWorld(); // throws if the committed boundary is not the adopted one
const POINTS = seed.loadGeometry().points;
const P = (id) => ({ id, lat: POINTS[id].lat, lon: POINTS[id].lon });

/** Today's published map, as the bootstrap publishes it: every cover cell in `rnsit-z1`. */
const LIVE_MAP = Object.freeze({ version: "v1", ...zoneTool.currentSpatialMap(world.indexCover, { regionId: REGION }) });
const SNAPSHOT = Object.freeze({ spatial: LIVE_MAP, deliveryDomain: world.declaration });

const ORACLE = serviceability.createServiceabilityOracle(world.declaration);
const CONTAINMENT = routeContainment.createRouteContainment(world.declaration);
const EXTRACT = net.extractForDeclaration(world.declaration);
const SIDEWALK = ["footway", "path", "service"];

/** One stop through the production seam: intake's pin, the round's serviceability, F33. */
function throughTheSeam(point, spatial = LIVE_MAP) {
  const pinned = deliveryDomain.verdictFor(world.declaration, point.lat, point.lon);
  const stop = { stopId: "s1", sequence: 1, lat: point.lat, lon: point.lon, geofenceResult: pinned.verdict, routable: true };
  const [projected] = solvePath.serviceabilityFor({ spatial })([stop]);
  const verdict = f33.evaluate({ plan: { stops: [{ ...projected, sequence: 1 }] } });
  return { geofence: pinned.verdict, serviceable: projected.serviceable, f33: verdict.outcome };
}

const INSIDE_POINTS = [
  "rnsit-pre-university-college",
  "rnsit-playground-2",
  "rnsit-canara-bank",
  "rnsit-cyber-security-department",
  "rnsit-food-court",
].map(P);
/** The three reference points the owner named non-serviceable (RD-2026-08-30-01). */
const OUTSIDE_POINTS = ["rnsit-main-gate", "rnsit-playground-1", "rnsit-parking-lot"].map(P);
/** Well clear of the campus (about 1.5 km north-east). */
const FAR_AWAY = { id: "far-away", lat: 12.912, lon: 77.528 };

// ── The authoritative boundary ──────────────────────────────────────────────

describe("the authoritative campus boundary is the adopted one, unchanged", () => {
  test("the published declaration is way/1120154292, validates, and covers 64 index cells", () => {
    expect(world.declaration.version).toBe(BOUNDARY_WAY);
    expect(world.declaration.boundary.type).toBe("Polygon");
    expect(deliveryDomain.validateDomainDeclaration(world.declaration)).toBeTruthy();
    expect(world.indexCover).toHaveLength(64);
  });

  test("the boundary the dashboard draws is byte-identical to the one the backend enforces", () => {
    const file = path.join(BACKEND, "..", "Frontend", "src", "features", "maps", "campus", "data", "rnsit", "rnsitCampusOsm.js");
    expect(fs.existsSync(file)).toBe(true);
    const source = fs.readFileSync(file, "utf8");
    // The frontend module is ESM data: find the boundary feature's geometry in it.
    const at = source.indexOf(`"id": "${BOUNDARY_WAY}"`);
    expect(at).toBeGreaterThan(-1);
    const backendRing = JSON.stringify(world.declaration.boundary.coordinates);
    expect(source.replace(/\s+/g, "")).toContain(backendRing.replace(/\s+/g, ""));
  });
});

// ── Task eligibility ────────────────────────────────────────────────────────

describe("task eligibility still follows the campus boundary", () => {
  test.each(INSIDE_POINTS.map((p) => [p.id, p]))("a stop at %s (inside RNSIT) is serviceable and passes F33", (_id, point) => {
    expect(throughTheSeam(point)).toEqual({ geofence: "INSIDE", serviceable: true, f33: "SATISFIED" });
  });

  test.each([...OUTSIDE_POINTS, FAR_AWAY].map((p) => [p.id, p]))("a stop at %s (outside RNSIT) is refused by F33", (_id, point) => {
    const result = throughTheSeam(point);
    expect(result.geofence).toBe("OUTSIDE");
    expect(result.serviceable).not.toBe(true);
    expect(result.f33).toBe("VIOLATED");
  });

  test("the router's projection refuses an exact endpoint outside the boundary, and accepts one inside", () => {
    const projection = cellProjection.createCellProjection({ serviceability: ORACLE });
    for (const point of INSIDE_POINTS) {
      expect(() => projection.projectExactPoint(cells.cellForPoint(point.lat, point.lon, cells.RESOLUTION.FINE), point)).not.toThrow();
    }
    for (const point of [...OUTSIDE_POINTS, FAR_AWAY]) {
      let refusal = null;
      try {
        projection.projectExactPoint(cells.cellForPoint(point.lat, point.lon, cells.RESOLUTION.FINE), point);
      } catch (error) {
        refusal = error.refusal;
      }
      expect(refusal).toBe(cellProjection.PROJECTION_REFUSAL.OUTSIDE_SERVICEABLE_REGION);
    }
  });
});

// ── Routes ──────────────────────────────────────────────────────────────────

describe("a route may not leave the operating boundary", () => {
  const contained = () =>
    net.createCampusTraversalNetwork({ features: EXTRACT.features, roadClasses: SIDEWALK, source: EXTRACT.file, containment: CONTAINMENT });

  test("the contained network refuses an endpoint outside the boundary", () => {
    const network = contained();
    const from = P("rnsit-pre-university-college");
    for (const outside of [...OUTSIDE_POINTS, FAR_AWAY]) {
      const routed = network.route(from, outside);
      expect(routed.ok).toBe(false);
      expect([net.NETWORK_REFUSAL.ENDPOINT_OUTSIDE_BOUNDARY, net.NETWORK_REFUSAL.ACCESS_LEAVES_BOUNDARY]).toContain(routed.refusal);
    }
  });

  test("between in-campus points, the contained network routes every pair and every segment stays inside", () => {
    const network = contained();
    const inside = Object.keys(POINTS).map(P).filter((p) => ORACLE.assess(p.lat, p.lon).status === "INSIDE");
    expect(inside.length).toBe(8);
    for (const a of inside) {
      for (const b of inside) {
        if (a === b) continue;
        const routed = network.route(a, b);
        expect(routed.ok).toBe(true);
        for (let i = 1; i < routed.points.length; i += 1) {
          expect(CONTAINMENT.containsSegment(routed.points[i - 1], routed.points[i])).toBe(true);
        }
      }
    }
  });

  // KNOWN GAP — pre-existing, not DTARO's, and not changed here (route semantics are frozen).
  // The LIVE simulated task router (`v1DemonstrationComposition.networksFrom`) builds its
  // network WITHOUT `containment`, so only the endpoints are checked. Measured 2026-10-22: 14 of
  // the 56 ordered pairs of in-campus reference points — every one to or from Playground 2 —
  // run up to ~8 m outside the boundary over the ~50 m access connector to Playground 2. The
  // contained network routes the same pairs inside (388 m instead of 410 m for PU ⇄ Playground 2).
  // This states what should hold; jest reports it if it ever starts to pass.
  test.failing("KNOWN GAP: live (uncontained) task routes between in-campus points stay inside the boundary", () => {
    const live = net.createCampusTraversalNetwork({ features: EXTRACT.features, roadClasses: SIDEWALK, source: EXTRACT.file });
    const routed = live.route(P("rnsit-pre-university-college"), P("rnsit-playground-2"));
    expect(routed.ok).toBe(true);
    for (let i = 1; i < routed.points.length; i += 1) {
      expect(CONTAINMENT.containsSegment(routed.points[i - 1], routed.points[i])).toBe(true);
    }
  });
});

// ── The alert zone is not the campus ────────────────────────────────────────

describe("the alert zone is the published index cover, not the campus boundary", () => {
  test("the zone overlay is exactly the 64 published cells — 19 of them centred outside the campus", async () => {
    const view = await publishedZoneView({ snapshot: SNAPSHOT, prisma: null, alertsEnabled: false });
    expect(view.zones).toHaveLength(1);
    expect(view.zones[0]).toMatchObject({ zoneId: "rnsit-z1", cellCount: 64 });
    const centredOutside = world.indexCover.filter((cellId) => {
      const [lat, lon] = h3.cellToLatLng(cellId);
      return ORACLE.assess(lat, lon).status === "OUTSIDE";
    });
    expect(centredOutside).toHaveLength(19);
  });

  test("every in-campus point lies in the zone; a point in the zone but outside the campus is still refused", () => {
    for (const point of INSIDE_POINTS) {
      expect(dtaroZoneAlert.resolvePoint(SNAPSHOT, point.lat, point.lon)).toMatchObject({ ok: true, zoneId: "rnsit-z1" });
    }
    // The parking lot is outside the campus and inside the index cover: in the zone, refused anyway.
    const parking = P("rnsit-parking-lot");
    expect(dtaroZoneAlert.resolvePoint(SNAPSHOT, parking.lat, parking.lon)).toMatchObject({ ok: true, zoneId: "rnsit-z1" });
    expect(throughTheSeam(parking).f33).toBe("VIOLATED");
  });
});

// ── The overlay changes nothing ─────────────────────────────────────────────

describe("the DTARO overlay does not change campus geometry or task eligibility", () => {
  const sample = [...INSIDE_POINTS, ...OUTSIDE_POINTS, FAR_AWAY];

  test("drawing zones and resolving obstacle reports leaves the snapshot and every verdict as it was", async () => {
    const before = JSON.stringify(SNAPSHOT);
    const verdictsBefore = sample.map((p) => throughTheSeam(p));
    await publishedZoneView({ snapshot: SNAPSHOT, prisma: null, alertsEnabled: true });
    await publishedZoneView({ snapshot: SNAPSHOT, prisma: null, alertsEnabled: false });
    for (const p of sample) dtaroZoneAlert.resolvePoint(SNAPSHOT, p.lat, p.lon);
    expect(JSON.stringify(SNAPSHOT)).toBe(before);
    expect(sample.map((p) => throughTheSeam(p))).toEqual(verdictsBefore);
  });

  test("no DTARO module reads or writes the boundary, the containment checks or the configuration", () => {
    const files = [
      "src/services/dtaroZoneAlert.service.js",
      "src/services/dtaroZoneView.service.js",
      "src/controllers/dtaro.controller.js",
      "src/routes/dtaro.routes.js",
      "src/simulation/dtaroScenario.js",
    ];
    const forbidden =
      /require\([^)]*(deliveryDomain|regionBoundary|campusServiceability|routeContainment|cellProjection|campusTraversalNetwork|engine\/config\/service|publishV1Demonstration)/;
    for (const rel of files) {
      const source = fs.readFileSync(path.join(BACKEND, rel), "utf8");
      expect({ rel, forbidden: forbidden.test(source) }).toEqual({ rel, forbidden: false });
      // No write to the spatial or configuration tables.
      expect({ rel, writes: /\.(region|zone|configVersion|spatialMap)\.(create|update|upsert|delete)/.test(source) }).toEqual({ rel, writes: false });
    }
  });
});

// ── The four-zone proposal changes nothing until approved ───────────────────

describe("the four-zone proposal does not affect live assignment before approval", () => {
  test("it cannot become a map while any cell is tied, and it has 14 tied cells", () => {
    const proposal = zoneTool.buildProposal();
    expect(proposal.unresolved).toHaveLength(14);
    expect(() => zoneTool.candidateSpatialMap(proposal, { regionId: REGION })).toThrow(zoneTool.ZoneMapIncompleteError);
  });

  test("building it leaves the live map resolving every cover cell to rnsit-z1, and every verdict unchanged", () => {
    const verdictsBefore = [...INSIDE_POINTS, ...OUTSIDE_POINTS, FAR_AWAY].map((p) => throughTheSeam(p));
    zoneTool.buildProposal();
    const index = hierarchy.indexMap(LIVE_MAP);
    for (const cellId of world.indexCover) {
      expect(index.resolve(cellId)).toMatchObject({ assigned: true, zoneId: "rnsit-z1", regionId: REGION });
    }
    expect([...INSIDE_POINTS, ...OUTSIDE_POINTS, FAR_AWAY].map((p) => throughTheSeam(p))).toEqual(verdictsBefore);
  });

  test("no runtime module under src/ imports the proposal tool or its preview", () => {
    const hits = [];
    const walk = (dir) => {
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        if (fs.statSync(p).isDirectory()) walk(p);
        else if (/\.js$/.test(name) && /rnsitZoneMap|rnsitZoneProposalPreview|rnsitZoneTieEvidence/.test(fs.readFileSync(p, "utf8"))) hits.push(p);
      }
    };
    walk(path.join(BACKEND, "src"));
    expect(hits).toEqual([]);
  });
});
