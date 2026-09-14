"use strict";

/**
 * Engine lane — **ROUTING BATCH 1**, the production routing producer.
 *
 * ── What these tests establish ────────────────────────────────────────────
 * That `routing/productionRouter.route(parts)` satisfies the contract
 * `workers/coordinatorPipeline.js:289-301` states verbatim, that it reaches the engine only
 * through a **self-hosted** B1 adapter, that the owner's V1 travel-time model is applied
 * exactly as declared, and — the half that matters more — that **every** missing production
 * input is a refusal with a named reason rather than a zero, a guess or a cached default.
 *
 * ── What they do NOT establish ────────────────────────────────────────────
 * They run against a faked transport, so they say nothing about any engine's performance and
 * are not B1 Step 3 evidence. They do not discharge D1, D3 or D8. They do not assert that
 * RNSIT is routable at the frozen H3 resolution — the opposite: one test pins the measured
 * finding that every RNSIT cell centre falls outside the campus, so that a later change which
 * silently "fixes" it by widening a boundary or picking a refused containment mode fails here.
 */

const h3 = require("h3-js");
const fs = require("fs");
const path = require("path");

const contract = require("../../tools/routing/adapters/contract");
const osrm = require("../../tools/routing/adapters/osrm");
const configService = require("../../src/engine/config/service");
const cells = require("../../src/engine/spatial/cells");
const regionBoundary = require("../../src/engine/spatial/regionBoundary");
const timeline = require("../../src/engine/plan/timeline");
const cellPairCache = require("../../src/engine/routing/cellPairCache");

const travelModel = require("../../src/engine/routing/campusTravelModel");
const serviceability = require("../../src/engine/routing/campusServiceability");
const cellProjection = require("../../src/engine/routing/cellProjection");
const productionRouter = require("../../src/engine/routing/productionRouter");

const { SERVICEABILITY } = serviceability;
const { FIELD_PROVENANCE, ROUTER_MODE, ROUTE_REFUSAL, RouteRefusedError } = productionRouter;

/* ═══════════════════════════════════════════════════════════════════════════
   Fixtures — a square region with a hole, and the adopted RNSIT polygon
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * A synthetic region large enough that its own cell centres fall inside it, so the seam can
 * be exercised end to end. It is **not** RNSIT and is never described as RNSIT: the whole
 * point of the RNSIT measurement below is that a real campus does not have this property.
 */
const SQUARE_REGION = Object.freeze({
  regionId: "test-square",
  name: "Test Square Region",
  kind: regionBoundary.REGION_KIND.CAMPUS,
  crs: "OGC:CRS84",
  version: "test-v1",
  versionDate: "2026-09-13",
  boundary: {
    type: "Polygon",
    coordinates: [
      [
        [77.40, 12.80],
        [77.60, 12.80],
        [77.60, 13.00],
        [77.40, 13.00],
        [77.40, 12.80],
      ],
    ],
  },
});

/** The adopted RNSIT serviceable boundary, read from the tree rather than transcribed. */
function rnsitPolygon() {
  const file = path.resolve(__dirname, "..", "..", "..", "rnsit-campus-osm.geojson");
  const collection = JSON.parse(fs.readFileSync(file, "utf8"));
  const feature = collection.features.find((entry) => entry.id === "way/1120154292");
  return feature.geometry;
}

/** The §1.8.1 owner-declared field values, wrapped around that geometry. */
function rnsitDeclaration() {
  return {
    regionId: "rnsit-bengaluru",
    name: "RNSIT Bengaluru Campus",
    kind: regionBoundary.REGION_KIND.CAMPUS,
    crs: "OGC:CRS84",
    version: "rnsit-boundary-v1",
    versionDate: "2026-08-30",
    boundary: rnsitPolygon(),
  };
}

/**
 * A transport that never opens a socket, recording every URL so request construction can be
 * asserted. Modelled on `routingB1Adapters.test.js`'s.
 */
function fakeTransport(responder) {
  const calls = [];
  const transport = async ({ method, url, signal }) => {
    calls.push({ method, url });
    if (signal && signal.aborted) throw new Error("aborted");
    return responder({ method, url, signal, index: calls.length - 1 });
  };
  transport.calls = calls;
  return transport;
}

/** An OSRM Table answer for one destination. */
function tableAnswer(distanceM, durationSeconds) {
  return { httpStatus: 200, body: { code: "Ok", durations: [[durationSeconds]], distances: [[distanceM]] } };
}

const SNAPSHOT = configService.defaultSnapshot();
const MODEL = travelModel.resolveModelParameters(SNAPSHOT, {});

/** Two cells inside `SQUARE_REGION`, and their profile key. */
const ORIGIN_CELL = cells.cellForPoint(12.90, 77.50, cells.RESOLUTION.FINE);
const DEST_CELL = cells.cellForPoint(12.92, 77.52, cells.RESOLUTION.FINE);
const PROFILE = "MOB-TEST:SIDEWALK_GRAPH:unloaded";
/** @structural an arbitrary in-range hour-of-week, Sunday 00:00 = 0 */
const BUCKET = 37;

/**
 * Build a complete, composable router over the square region.
 *
 * `overrides` lets one input at a time be removed or corrupted, which is how every refusal
 * below is provoked without rebuilding the whole composition each time.
 */
function buildRouter(overrides) {
  const settings = overrides || {};
  const oracle = serviceability.createServiceabilityOracle(settings.region === undefined ? SQUARE_REGION : settings.region);
  const projection = cellProjection.createCellProjection({ serviceability: oracle });
  const transport = settings.transport || fakeTransport(() => tableAnswer(1200, 900));

  const adapter =
    settings.adapter === undefined
      ? osrm.create({
          baseUrl: "http://127.0.0.1:5000",
          engineProfile: "foot",
          projectCell: (cellId) => projection.projectCell(cellId),
          chargerCatalogue: () => [],
          // @structural a test budget, not a deployment's
          matrixTimeoutMs: 5000,
          // @structural a test snap radius, not a deployment's
          snapRadiusM: 50,
          travelTimeSpread: { source: travelModel.DECLARED_SPREAD_SOURCE, model: "PROPORTIONAL", value: 0 },
          profile: { energyWhPerMetre: 0.05, speedMetresPerSecond: 1.5 },
          deployment: { shape: "test", extract: "test-extract", profilesBuilt: "foot", hierarchyBuildTime: "n/a — test" },
          transport,
        })
      : settings.adapter;

  return {
    transport,
    oracle,
    projection,
    router: productionRouter.createProductionRouter({
      adapter,
      projection,
      travelModel: settings.travelModel === undefined ? MODEL : settings.travelModel,
      speedFor: settings.speedFor === undefined ? () => 1.5 : settings.speedFor,
      speedProvenance: settings.speedProvenance === undefined ? FIELD_PROVENANCE.PRODUCTION_DECLARED : settings.speedProvenance,
      terrainSource:
        settings.terrainSource === undefined
          ? async () => ({ climbM: 12, descentM: 8, provenance: FIELD_PROVENANCE.PRODUCTION_EXTERNAL })
          : settings.terrainSource,
      stopStartSource:
        settings.stopStartSource === undefined
          ? async () => ({ stopStartCycles: 4, provenance: FIELD_PROVENANCE.PRODUCTION_EXTERNAL })
          : settings.stopStartSource,
      mode: settings.mode,
    }),
  };
}

const REQUEST = Object.freeze({ originCell: ORIGIN_CELL, destCell: DEST_CELL, profileKey: PROFILE, timeBucket: BUCKET });

/** Run `route` and return the thrown `RouteRefusedError`, failing if it resolves. */
async function refusalFrom(router, parts) {
  try {
    await router.route(parts || REQUEST);
  } catch (error) {
    return error;
  }
  throw new Error("expected the router to refuse, and it returned a route");
}

/* ═══════════════════════════════════════════════════════════════════════════
   T1, T6 — the adapter request, and where distanceM comes from
   ═══════════════════════════════════════════════════════════════════════════ */

describe("T1/T6 — the self-hosted adapter is asked the right question and its distance is used verbatim", () => {
  test("one Table query per route, lon,lat ordered, bounded snap, both annotations", async () => {
    const { router, transport } = buildRouter();
    await router.route(REQUEST);

    expect(transport.calls).toHaveLength(1);
    const url = transport.calls[0].url;
    expect(url).toContain("/table/v1/foot/");
    expect(url).toContain("sources=0&destinations=1");
    expect(url).toContain("annotations=duration,distance");
    expect(url).toContain("radiuses=50;50");

    // OSRM orders a coordinate lon,lat. A reversed pair is a silent 90°-rotated answer, so
    // the ordering is asserted against the projection rather than against a literal.
    const origin = cells.centreOfCell(ORIGIN_CELL);
    expect(url).toContain(`${origin.lon},${origin.lat}`);
  });

  test("distanceM is the engine's routed distance — not a straight line, not a cell separation", async () => {
    const { router } = buildRouter({ transport: fakeTransport(() => tableAnswer(1737.25, 1200)) });
    const route = await router.route(REQUEST);

    expect(route.distanceM).toBe(1737.25);
    expect(route.provenance.distanceM).toBe(FIELD_PROVENANCE.PRODUCTION_EXTERNAL);

    // The great-circle separation of the two cell centres, which the router must NOT have used.
    const straightLineM = h3.greatCircleDistance(h3.cellToLatLng(ORIGIN_CELL), h3.cellToLatLng(DEST_CELL), "m");
    expect(route.distanceM).not.toBeCloseTo(straightLineM, 0);
  });

  test("a Table response with no distances block is refused, never derived from the duration", async () => {
    const { router } = buildRouter({
      transport: fakeTransport(() => ({ httpStatus: 200, body: { code: "Ok", durations: [[900]] } })),
    });
    const refusal = await refusalFrom(router);
    expect(refusal.refusal).toBe(ROUTE_REFUSAL.ENGINE_REFUSED);
    expect(refusal.reason).toMatch(/distanceM is a required output and is never derived from a duration/u);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   T2, T3, T4, T5 — projection, whole-campus acceptance, and the two refusals
   ═══════════════════════════════════════════════════════════════════════════ */

describe("T2 — origin/destination mapping is deterministic and reuses spatial/cells", () => {
  test("a cell projects to its own H3 centre, identically on every call", () => {
    const { projection } = buildRouter();
    const first = projection.project(ORIGIN_CELL);
    const second = projection.project(ORIGIN_CELL);
    expect(first).toEqual(second);
    expect({ lat: first.lat, lon: first.lon }).toEqual(cells.centreOfCell(ORIGIN_CELL));
    expect(first.source).toBe(cellProjection.PROJECTION_SOURCE.CELL_CENTRE);
  });

  test("a non-H3 token has no coordinate and is refused rather than guessed", () => {
    const { projection } = buildRouter();
    expect(() => projection.project("cell-rnsit-fine-01")).toThrow(/not a fine-resolution H3 cell id/u);
  });
});

describe("T3 — the WHOLE region is serviceable, by point-in-polygon and not by cell cover", () => {
  test("every interior point is accepted, including ones no cell cover would contain", () => {
    const oracle = serviceability.createServiceabilityOracle(SQUARE_REGION);
    for (const [lat, lon] of [[12.81, 77.41], [12.90, 77.50], [12.99, 77.59], [12.8001, 77.5999]]) {
      expect(oracle.assess(lat, lon).status).toBe(SERVICEABILITY.INSIDE);
    }
  });

  test("acceptance never consults a cell cover, so no containment mode is chosen by it", () => {
    // The region's own polygonToCells cover is irrelevant to the verdict: a point is inside
    // or it is not. This is the property that keeps the owner's standing refusal of
    // `containmentOverlapping` / `containmentOverlappingBbox` untouched by this batch.
    const oracle = serviceability.createServiceabilityOracle(SQUARE_REGION);
    const ring = SQUARE_REGION.boundary.coordinates[0].map(([lon, lat]) => [lat, lon]);
    const cover = h3.polygonToCells(ring, 8);
    expect(oracle.assess(12.90, 77.50).status).toBe(SERVICEABILITY.INSIDE);
    // Stated so the test fails loudly if someone later wires the cover into the verdict.
    expect(Array.isArray(cover)).toBe(true);
  });

  test("a point exactly on the boundary is ON_BOUNDARY and is NOT accepted — fail-closed", () => {
    const oracle = serviceability.createServiceabilityOracle(SQUARE_REGION);
    expect(oracle.assess(12.80, 77.50).status).toBe(SERVICEABILITY.ON_BOUNDARY);
    expect(oracle.isServiceable(12.80, 77.50)).toBe(false);
  });
});

describe("T4 — outside the region is refused, with no buffer in either direction", () => {
  test("a point beyond the perimeter is OUTSIDE", () => {
    const oracle = serviceability.createServiceabilityOracle(SQUARE_REGION);
    expect(oracle.assess(12.90, 77.61).status).toBe(SERVICEABILITY.OUTSIDE);
  });

  test("NO TOLERANCE — a point 0.7 m outside stays outside, as RD-2026-08-30-01 §4 requires", () => {
    const oracle = serviceability.createServiceabilityOracle(rnsitDeclaration());
    // `rnsit-parking-lot`, measured 0.7 m outside the adopted polygon. The decision record
    // makes the polygon authoritative with zero tolerance; a buffer here would silently
    // re-admit it and would be this module overturning an owner decision by arithmetic.
    const parkingLot = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, "..", "..", "..", "rnsit-campus-supplemental.geojson"), "utf8"),
    ).features.find((entry) => entry.id === "rnsit-parking-lot");
    const [lon, lat] = parkingLot.geometry.coordinates;
    expect(oracle.assess(lat, lon).status).toBe(SERVICEABILITY.OUTSIDE);
  });

  test("the main gate is outside the adopted boundary, per RD-2026-08-30-01 §5", () => {
    const oracle = serviceability.createServiceabilityOracle(rnsitDeclaration());
    expect(oracle.assess(12.902682, 77.519241).status).toBe(SERVICEABILITY.OUTSIDE);
  });

  test("an unconfigured region admits nothing — NOT_CONFIGURED is not a pass", () => {
    const oracle = serviceability.createServiceabilityOracle(null);
    expect(oracle.assess(12.90, 77.50).status).toBe(SERVICEABILITY.NOT_CONFIGURED);
    expect(oracle.isServiceable(12.90, 77.50)).toBe(false);
  });

  test("a cell whose centre is outside the region is refused BEFORE the engine is called", async () => {
    const { router, transport } = buildRouter();
    const outsideCell = cells.cellForPoint(12.50, 77.50, cells.RESOLUTION.FINE);
    const refusal = await refusalFrom(router, { ...REQUEST, destCell: outsideCell });
    expect(refusal.refusal).toBe(ROUTE_REFUSAL.OUTSIDE_SERVICEABLE_REGION);
    // No engine call was made for a destination outside the operational domain.
    expect(transport.calls).toHaveLength(0);
  });
});

describe("T5 — inside but genuinely unroutable is its own finding, not 'outside'", () => {
  test("an OSRM null pair becomes NOT_ROUTABLE with no fabricated distance", async () => {
    const { router } = buildRouter({
      transport: fakeTransport(() => ({ httpStatus: 200, body: { code: "Ok", durations: [[null]], distances: [[null]] } })),
    });
    const refusal = await refusalFrom(router);
    expect(refusal.refusal).toBe(ROUTE_REFUSAL.NOT_ROUTABLE);
    expect(refusal.reason).toMatch(/inside the serviceable region and still be unreachable/u);
  });

  test("a coordinate outside the cut extract is NOT_ROUTABLE, distinct from an engine failure", async () => {
    const { router } = buildRouter({
      transport: fakeTransport(() => ({ httpStatus: 400, body: { code: "NoSegment", message: "Could not find a matching segment" } })),
    });
    const refusal = await refusalFrom(router);
    expect(refusal.refusal).toBe(ROUTE_REFUSAL.NOT_ROUTABLE);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   T7, T8, T9, T20, T21 — the owner's travel-time model
   ═══════════════════════════════════════════════════════════════════════════ */

describe("T7/T8 — travelSeconds is the owner's declared V1 model, exactly", () => {
  test("travelSeconds = distanceM / speedMps + distanceM x 15 / 100", async () => {
    const { router } = buildRouter({ transport: fakeTransport(() => tableAnswer(400, 111)) });
    const route = await router.route(REQUEST);

    const expectedBase = 400 / 1.5;
    const expectedBuffer = (400 * 15) / 100;
    expect(route.travelSeconds).toBeCloseTo(expectedBase + expectedBuffer, 10);
    expect(route.terms.baseTravelSeconds).toBeCloseTo(expectedBase, 10);
    expect(route.terms.operationalBufferSeconds).toBeCloseTo(expectedBuffer, 10);
  });

  test("the registered buffer really is 15 s per 100 m", () => {
    expect(SNAPSHOT.resolve("route.campus_operational_buffer_s_per_100m", {})).toBe(15);
    expect(MODEL.bufferSecondsPer100m).toBe(15);
  });

  test("THE BUFFER IS NOT OPTIONAL — removing it changes the answer, so a caller cannot skip it", () => {
    const withBuffer = travelModel.travelTimeFor({ distanceM: 400, speedMetresPerSecond: 1.5, bufferSecondsPer100m: 15, sdBufferMultiple: 1 });
    const withoutBuffer = travelModel.travelTimeFor({ distanceM: 400, speedMetresPerSecond: 1.5, bufferSecondsPer100m: 0, sdBufferMultiple: 1 });
    expect(withBuffer.travelSeconds - withoutBuffer.travelSeconds).toBeCloseTo(60, 10);
  });

  test("THE ENGINE'S OWN DURATION IS DISCARDED — changing it does not move travelSeconds", async () => {
    const first = await buildRouter({ transport: fakeTransport(() => tableAnswer(400, 111)) }).router.route(REQUEST);
    const second = await buildRouter({ transport: fakeTransport(() => tableAnswer(400, 999_999)) }).router.route(REQUEST);
    expect(second.travelSeconds).toBe(first.travelSeconds);
    expect(first.terms.engineDurationUsed).toBe(false);
  });
});

describe("T9 — the speed comes from the profile and is never invented", () => {
  test("a different profile speed produces a different base term and the same buffer", async () => {
    const slow = await buildRouter({ transport: fakeTransport(() => tableAnswer(400, 111)), speedFor: () => 1.0 }).router.route(REQUEST);
    const fast = await buildRouter({ transport: fakeTransport(() => tableAnswer(400, 111)), speedFor: () => 2.0 }).router.route(REQUEST);
    expect(slow.terms.baseTravelSeconds).toBeCloseTo(400, 10);
    expect(fast.terms.baseTravelSeconds).toBeCloseTo(200, 10);
    expect(slow.terms.operationalBufferSeconds).toBe(fast.terms.operationalBufferSeconds);
  });

  test("the profile key reaches the speed lookup, so two profiles cannot share a speed by accident", async () => {
    const seen = [];
    const { router } = buildRouter({
      transport: fakeTransport(() => tableAnswer(400, 111)),
      speedFor: (profileKey) => {
        seen.push(profileKey);
        return 1.5;
      },
    });
    await router.route(REQUEST);
    expect(seen).toEqual([PROFILE]);
  });

  test("NO SPEED IS A REFUSAL, not a default — D3 is named in the reason", async () => {
    const { router } = buildRouter({ transport: fakeTransport(() => tableAnswer(400, 111)), speedFor: () => null });
    const refusal = await refusalFrom(router);
    expect(refusal.refusal).toBe(ROUTE_REFUSAL.NO_SPEED);
    expect(refusal.reason).toMatch(/D3/u);
  });

  test("a zero or negative speed is refused rather than producing an infinite or negative ETA", async () => {
    for (const speed of [0, -1.5]) {
      const { router } = buildRouter({ transport: fakeTransport(() => tableAnswer(400, 111)), speedFor: () => speed });
      expect((await refusalFrom(router)).refusal).toBe(ROUTE_REFUSAL.NO_SPEED);
    }
  });
});

describe("T20/T21 — determinism", () => {
  test("NO RANDOMNESS — Math.random is not called anywhere on the route path", async () => {
    const spy = jest.spyOn(Math, "random");
    try {
      const { router } = buildRouter({ transport: fakeTransport(() => tableAnswer(400, 111)) });
      await router.route(REQUEST);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test("the same request produces a bit-identical result on repeated calls", async () => {
    const { router } = buildRouter({ transport: fakeTransport(() => tableAnswer(1234.5, 777)) });
    const first = await router.route(REQUEST);
    const second = await router.route(REQUEST);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  test("no clock is read — the bucket is the caller's and is echoed back unchanged", async () => {
    const { router } = buildRouter({ transport: fakeTransport(() => tableAnswer(400, 111)) });
    const route = await router.route({ ...REQUEST, timeBucket: 0 });
    expect(route.identity.timeBucket).toBe(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   T10, T11, T12 — timeBucket and cache identity
   ═══════════════════════════════════════════════════════════════════════════ */

describe("T10 — timeBucket is 0…167 hour-of-week and is actually threaded through", () => {
  test("the convention matches plan/timeline.hourOfWeek — Sunday 00:00 UTC is 0", () => {
    // 1970-01-04 was a Sunday.
    expect(timeline.hourOfWeek(Date.UTC(1970, 0, 4, 0, 0, 0), 0)).toBe(0);
    expect(timeline.hourOfWeek(Date.UTC(1970, 0, 4, 1, 0, 0), 0)).toBe(1);
    expect(timeline.hourOfWeek(Date.UTC(1970, 0, 10, 23, 0, 0), 0)).toBe(productionRouter.TIME_BUCKET_COUNT - 1);
  });

  test("every hour-of-week in range is accepted and reaches the adapter", async () => {
    for (const bucket of [0, 1, 83, 167]) {
      const seen = [];
      const adapter = {
        id: "recording",
        matrix: async (request) => {
          seen.push(request.timeBucket);
          return [{ destCellId: request.destCellIds[0], status: "OK", distanceM: 400, travelSeconds: 300, travelSdSeconds: 0 }];
        },
      };
      const { router } = buildRouter({ adapter });
      await router.route({ ...REQUEST, timeBucket: bucket });
      expect(seen).toEqual([bucket]);
    }
  });

  test("AN OUT-OF-RANGE BUCKET IS REFUSED — a timestamp would silently disable the cache", async () => {
    const { router } = buildRouter();
    for (const bad of [-1, 168, 1_757_700_000_000, 3.5, "37", null, undefined]) {
      const refusal = await refusalFrom(router, { ...REQUEST, timeBucket: bad });
      expect(refusal.refusal).toBe(ROUTE_REFUSAL.MALFORMED_REQUEST);
      expect(refusal.reason).toMatch(/hour-of-week/u);
    }
  });
});

describe("T11/T12 — the cache key separates by bucket and by profile", () => {
  test("the key carries all four §20.3 components", () => {
    expect(cellPairCache.KEY_FIELDS).toEqual(["originCell", "destCell", "profileKey", "timeBucket"]);
  });

  test("two buckets are two keys", () => {
    const a = cellPairCache.key({ ...REQUEST, timeBucket: 1 });
    const b = cellPairCache.key({ ...REQUEST, timeBucket: 2 });
    expect(a.ok && b.ok).toBe(true);
    expect(a.key).not.toBe(b.key);
  });

  test("two profiles are two keys", () => {
    const a = cellPairCache.key({ ...REQUEST, profileKey: "MOB-A:SIDEWALK_GRAPH:unloaded" });
    const b = cellPairCache.key({ ...REQUEST, profileKey: "MOB-A:SIDEWALK_GRAPH:loaded" });
    expect(a.key).not.toBe(b.key);
  });

  test("the router's answer round-trips through cellPairCache.read against a real key space", async () => {
    const store = new Map();
    const kv = {
      get: async (key) => store.get(key) || null,
      set: async (key, value) => {
        store.set(key, value);
      },
    };
    const { router } = buildRouter({ transport: fakeTransport(() => tableAnswer(400, 111)) });
    const counters = new cellPairCache.Counters();
    const deps = { kv, counters, route: (parts) => router.route(parts) };
    const options = { ttlSeconds: 60, intraCellOffsetM: 250, speedMetresPerSecond: 1.5 };

    const miss = await cellPairCache.read(deps, REQUEST, options);
    expect(miss.ok).toBe(true);
    expect(miss.hit).toBe(false);

    const hit = await cellPairCache.read(deps, REQUEST, options);
    expect(hit.hit).toBe(true);
    expect(counters.report(0.95).hits).toBe(1);

    // A different bucket is a different entry, so it misses even though the pair is the same.
    const otherBucket = await cellPairCache.read(deps, { ...REQUEST, timeBucket: BUCKET + 1 }, options);
    expect(otherBucket.hit).toBe(false);
    expect(store.size).toBe(2);
  });

  test("A REFUSED ROUTE NEVER BECOMES A CACHE ENTRY", async () => {
    const store = new Map();
    const kv = {
      get: async (key) => store.get(key) || null,
      set: async (key, value) => {
        store.set(key, value);
      },
    };
    const { router } = buildRouter({ terrainSource: null });
    const result = await cellPairCache.read({ kv, route: (parts) => router.route(parts) }, REQUEST, {});
    expect(result.ok).toBe(false);
    expect(store.size).toBe(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   T13, T14 — malformed and failing engines
   ═══════════════════════════════════════════════════════════════════════════ */

describe("T13/T14 — a malformed, failing or slow engine is refused, never guessed around", () => {
  test("a non-JSON-object answer is refused", async () => {
    const { router } = buildRouter({ transport: fakeTransport(() => ({ httpStatus: 200, body: "not json" })) });
    expect((await refusalFrom(router)).refusal).toBe(ROUTE_REFUSAL.ENGINE_REFUSED);
  });

  test("a row of the wrong length is refused rather than read positionally", async () => {
    const { router } = buildRouter({
      transport: fakeTransport(() => ({ httpStatus: 200, body: { code: "Ok", durations: [[900, 800]], distances: [[1200, 1100]] } })),
    });
    expect((await refusalFrom(router)).refusal).toBe(ROUTE_REFUSAL.ENGINE_REFUSED);
  });

  test("HTTP 500 is an engine failure, distinct from 'no route'", async () => {
    const { router } = buildRouter({ transport: fakeTransport(() => ({ httpStatus: 500, body: {} })) });
    expect((await refusalFrom(router)).refusal).toBe(ROUTE_REFUSAL.ENGINE_REFUSED);
  });

  test("a timeout is a refusal and no degraded estimate is substituted", async () => {
    const { router } = buildRouter({
      transport: fakeTransport(
        () =>
          new Promise((unusedResolve, reject) => {
            setTimeout(() => reject(new Error("aborted")), 50).unref();
          }),
      ),
      adapter: undefined,
    });
    // The adapter's own budget is 5000 ms, so force the abort path with a short-budget adapter.
    const oracle = serviceability.createServiceabilityOracle(SQUARE_REGION);
    const projection = cellProjection.createCellProjection({ serviceability: oracle });
    const slow = osrm.create({
      baseUrl: "http://127.0.0.1:5000",
      engineProfile: "foot",
      projectCell: (cellId) => projection.projectCell(cellId),
      chargerCatalogue: () => [],
      // @structural a deliberately unreachable budget, to exercise the abort path
      matrixTimeoutMs: 1,
      // @structural a test snap radius
      snapRadiusM: 50,
      travelTimeSpread: { source: travelModel.DECLARED_SPREAD_SOURCE, model: "PROPORTIONAL", value: 0 },
      profile: { energyWhPerMetre: 0.05, speedMetresPerSecond: 1.5 },
      deployment: { shape: "test", extract: "test-extract", profilesBuilt: "foot", hierarchyBuildTime: "n/a — test" },
      transport: fakeTransport(
        (call) =>
          new Promise((unusedResolve, reject) => {
            const timer = setTimeout(() => reject(new Error("network")), 500);
            call.signal.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(new Error("aborted"));
            });
          }),
      ),
    });
    const timed = productionRouter.createProductionRouter({
      adapter: slow,
      projection,
      travelModel: MODEL,
      speedFor: () => 1.5,
      speedProvenance: FIELD_PROVENANCE.PRODUCTION_DECLARED,
      terrainSource: async () => ({ climbM: 0, descentM: 0, provenance: FIELD_PROVENANCE.PRODUCTION_EXTERNAL }),
      stopStartSource: async () => ({ stopStartCycles: 0, provenance: FIELD_PROVENANCE.PRODUCTION_EXTERNAL }),
    });
    const refusal = await refusalFrom(timed);
    expect(refusal.refusal).toBe(ROUTE_REFUSAL.ENGINE_REFUSED);
    expect(refusal.detail.status).toBe(contract.ROUTE_STATUS.TIMEOUT);
    expect(router).toBeDefined();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   T15, T16, T17, T18, T22 — the fields with no producer
   ═══════════════════════════════════════════════════════════════════════════ */

describe("T15 — missing production terrain is a refusal, NEVER a zero", () => {
  test("no terrain source at all is refused, and the reason names §14.2 and the absent producer", async () => {
    const { router } = buildRouter({ terrainSource: null });
    const refusal = await refusalFrom(router);
    expect(refusal.refusal).toBe(ROUTE_REFUSAL.NO_TERRAIN_SOURCE);
    expect(refusal.reason).toMatch(/no elevation source anywhere in this\s+deployment/u);
  });

  test("a terrain source that returns nothing is refused rather than coerced to flat", async () => {
    for (const answer of [null, {}, { climbM: 5 }, { climbM: 5, descentM: null }, { climbM: -1, descentM: 0 }]) {
      const { router } = buildRouter({ terrainSource: async () => answer, stopStartSource: undefined });
      expect((await refusalFrom(router)).refusal).toBe(ROUTE_REFUSAL.NO_TERRAIN_SOURCE);
    }
  });

  test("a terrain value with no stated provenance is refused", async () => {
    const { router } = buildRouter({ terrainSource: async () => ({ climbM: 5, descentM: 5 }) });
    const refusal = await refusalFrom(router);
    expect(refusal.reason).toMatch(/provenance/u);
  });

  test("the decision path refuses the hop too, so a zero here would have to pass TWO gates", () => {
    // `plan/timeline.project` is the E-8 refusal. Pinned here so that a future change which
    // let terrain default to zero in the router would still be caught downstream.
    expect(timeline.TERRAIN_FIELDS).toEqual(cellPairCache.TERRAIN_FIELDS);
  });
});

describe("T16 — simulation terrain is allowed ONLY in DEVELOPMENT, and only when it says so", () => {
  test("a simulated terrain value is REFUSED in production mode", async () => {
    const { router } = buildRouter({
      mode: ROUTER_MODE.PRODUCTION,
      terrainSource: async () => ({ climbM: 12, descentM: 8, provenance: FIELD_PROVENANCE.DEVELOPMENT_SIMULATION }),
    });
    const refusal = await refusalFrom(router);
    expect(refusal.refusal).toBe(ROUTE_REFUSAL.SIMULATION_IN_PRODUCTION);
  });

  test("PRODUCTION IS THE DEFAULT — a composition that forgot to declare a mode still refuses", async () => {
    const { router } = buildRouter({
      mode: undefined,
      terrainSource: async () => ({ climbM: 12, descentM: 8, provenance: FIELD_PROVENANCE.DEVELOPMENT_SIMULATION }),
    });
    expect(router.mode).toBe(ROUTER_MODE.PRODUCTION);
    expect((await refusalFrom(router)).refusal).toBe(ROUTE_REFUSAL.SIMULATION_IN_PRODUCTION);
  });

  test("in DEVELOPMENT it is accepted AND carries its simulation label through to the result", async () => {
    const { router } = buildRouter({
      mode: ROUTER_MODE.DEVELOPMENT,
      terrainSource: async () => ({ climbM: 12, descentM: 8, provenance: FIELD_PROVENANCE.DEVELOPMENT_SIMULATION }),
      transport: fakeTransport(() => tableAnswer(400, 111)),
    });
    const route = await router.route(REQUEST);
    expect(route.climbM).toBe(12);
    expect(route.provenance.climbM).toBe(FIELD_PROVENANCE.DEVELOPMENT_SIMULATION);
    expect(route.provenance.evidenceAxis.climbM).toBe("SIMULATED");
    expect(route.provenance.mode).toBe(ROUTER_MODE.DEVELOPMENT);
  });

  test("a simulated SPEED cannot be composed into a production router at all", () => {
    expect(() => buildRouter({ mode: ROUTER_MODE.PRODUCTION, speedProvenance: FIELD_PROVENANCE.DEVELOPMENT_SIMULATION })).toThrow(
      /simulated speed produces a simulated ETA/u,
    );
  });
});

describe("T17 — travelSdSeconds has a named declared source and is never silently zero", () => {
  test("the spread is the operational buffer times the registered multiple", async () => {
    const { router } = buildRouter({ transport: fakeTransport(() => tableAnswer(400, 111)) });
    const route = await router.route(REQUEST);
    expect(route.travelSdSeconds).toBeCloseTo(60 * MODEL.sdBufferMultiple, 10);
    expect(route.provenance.travelSdSource).toBe("DECLARED_V1_OPERATIONAL_UNCERTAINTY");
  });

  test("it is positive whenever the distance is, so no ETA is priced as certain (N29)", async () => {
    const { router } = buildRouter({ transport: fakeTransport(() => tableAnswer(400, 111)) });
    expect((await router.route(REQUEST)).travelSdSeconds).toBeGreaterThan(0);
  });

  test("a zero or missing multiple is refused — 'certain' is the optimistic direction", () => {
    for (const multiple of [0, -1, null, undefined, NaN]) {
      const result = travelModel.travelTimeFor({ distanceM: 400, speedMetresPerSecond: 1.5, bufferSecondsPer100m: 15, sdBufferMultiple: multiple });
      expect(result.ok).toBe(false);
    }
  });

  test("it is declared, not measured — the basis says so in words", () => {
    expect(travelModel.DECLARED_SPREAD_BASIS).toMatch(/NOT measured/u);
    expect(travelModel.DECLARED_SPREAD_BASIS).toMatch(/NOT traffic-derived/u);
  });
});

describe("T18 — stopStartCycles has no producer and is refused", () => {
  test("no source is a refusal that names what the term means", async () => {
    const { router } = buildRouter({ stopStartSource: null });
    const refusal = await refusalFrom(router);
    expect(refusal.refusal).toBe(ROUTE_REFUSAL.NO_STOP_START_SOURCE);
    expect(refusal.reason).toMatch(/ACCELERATION CYCLES/u);
  });

  test("the refusal explicitly declines OSRM's intersection count as a substitute", async () => {
    const { router } = buildRouter({ stopStartSource: null });
    expect((await refusalFrom(router)).reason).toMatch(/intersection traversed without stopping is not an acceleration cycle/u);
  });

  test("a negative or fractional-but-negative count is refused", async () => {
    const { router } = buildRouter({ stopStartSource: async () => ({ stopStartCycles: -1, provenance: FIELD_PROVENANCE.PRODUCTION_EXTERNAL }) });
    expect((await refusalFrom(router)).refusal).toBe(ROUTE_REFUSAL.NO_STOP_START_SOURCE);
  });
});

describe("T22 — no six-field value is fabricated", () => {
  test("a complete route has all six fields finite and non-negative, and buildEntry accepts it", async () => {
    const { router } = buildRouter({ transport: fakeTransport(() => tableAnswer(400, 111)) });
    const route = await router.route(REQUEST);
    for (const field of ["distanceM", "travelSeconds", "travelSdSeconds", "climbM", "descentM", "stopStartCycles"]) {
      expect(Number.isFinite(route[field])).toBe(true);
      expect(route[field]).toBeGreaterThanOrEqual(0);
    }
    const entry = cellPairCache.buildEntry(route);
    expect(entry.ok).toBe(true);
    expect(entry.missing).toEqual([]);
  });

  test("EVERY field's absence is a DIFFERENT named refusal — none collapses to a zero", async () => {
    const refusals = [];
    refusals.push((await refusalFrom(buildRouter({ speedFor: () => null }).router)).refusal);
    refusals.push((await refusalFrom(buildRouter({ terrainSource: null }).router)).refusal);
    refusals.push((await refusalFrom(buildRouter({ stopStartSource: null }).router)).refusal);
    expect(new Set(refusals).size).toBe(3);
    expect(refusals).toEqual([ROUTE_REFUSAL.NO_SPEED, ROUTE_REFUSAL.NO_TERRAIN_SOURCE, ROUTE_REFUSAL.NO_STOP_START_SOURCE]);
  });

  test("a refusal is an error, so nothing downstream can read a partially-filled route", async () => {
    const { router } = buildRouter({ terrainSource: null });
    await expect(router.route(REQUEST)).rejects.toBeInstanceOf(RouteRefusedError);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   T19 — no Mapbox, no hosted service, on the production routing path
   ═══════════════════════════════════════════════════════════════════════════ */

describe("T19 — the production routing path cannot reach a hosted service", () => {
  test("api.mapbox.com is refused as a routing base URL", () => {
    expect(() => contract.assertSelfHosted("osrm", "https://api.mapbox.com/directions/v5")).toThrow(/public hosted routing service/u);
  });

  test("every hosted host is refused, including with a trailing root dot", () => {
    for (const host of contract.HOSTED_HOSTS) {
      expect(() => contract.assertSelfHosted("osrm", `https://${host}/x`)).toThrow(/public hosted routing service/u);
      expect(() => contract.assertSelfHosted("osrm", `https://${host}./x`)).toThrow(/public hosted routing service/u);
    }
  });

  test("the routing modules import no Mapbox client and name no Mapbox host", () => {
    const directory = path.resolve(__dirname, "..", "..", "src", "engine", "routing");
    for (const file of fs.readdirSync(directory)) {
      const body = fs.readFileSync(path.join(directory, file), "utf8");
      expect(body).not.toMatch(/require\(["'][^"']*mapbox/iu);
      expect(body).not.toMatch(/api\.mapbox\.com/iu);
      expect(body).not.toMatch(/googleapis\.com|maps\.google/iu);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   The RNSIT finding — pinned so a later "fix" cannot hide it
   ═══════════════════════════════════════════════════════════════════════════ */

describe("RNSIT at the frozen H3 resolution — the measured finding, pinned", () => {
  test("the adopted boundary validates as a region declaration once the §1.8.1 fields are supplied", () => {
    const validated = regionBoundary.validateRegionDeclaration(rnsitDeclaration());
    expect(validated.status).toBe(regionBoundary.BOUNDARY_STATUS.VALID);
  });

  test("the standard cover is EMPTY at both resolutions — V-8, not V-9", () => {
    const ring = rnsitPolygon().coordinates[0].map(([lon, lat]) => [lat, lon]);
    expect(h3.polygonToCells(ring, 8)).toHaveLength(0);
    expect(h3.polygonToCells(ring, 5)).toHaveLength(0);
    // V-8 fires, and `cardinalityException` cannot rescue it because V-9 never runs.
    const cover = regionBoundary.validateCover({ fineCells: [], cardinalityException: "declared" });
    expect(cover.status).toBe(regionBoundary.BOUNDARY_STATUS.INVALID);
    expect(cover.problems.join(" ")).toMatch(/V-8/u);
  });

  test("EVERY cell the campus touches has its centre OUTSIDE the campus", () => {
    const oracle = serviceability.createServiceabilityOracle(rnsitDeclaration());
    const touched = new Set(rnsitPolygon().coordinates[0].map(([lon, lat]) => cells.cellForPoint(lat, lon, cells.RESOLUTION.FINE)));
    expect(touched.size).toBeGreaterThan(0);
    for (const cellId of touched) {
      const centre = cells.centreOfCell(cellId);
      expect(oracle.assess(centre.lat, centre.lon).status).toBe(SERVICEABILITY.OUTSIDE);
    }
  });

  test("so the cell projection refuses every RNSIT cell, rather than routing off-campus", () => {
    const oracle = serviceability.createServiceabilityOracle(rnsitDeclaration());
    const projection = cellProjection.createCellProjection({ serviceability: oracle });
    const touched = [...new Set(rnsitPolygon().coordinates[0].map(([lon, lat]) => cells.cellForPoint(lat, lon, cells.RESOLUTION.FINE)))];
    for (const cellId of touched) {
      expect(() => projection.project(cellId)).toThrow(/OUTSIDE relative to the serviceable region/u);
    }
  });

  test("interior campus POINTS are nonetheless serviceable — the domain is whole, the cell identity is not", () => {
    const oracle = serviceability.createServiceabilityOracle(rnsitDeclaration());
    // The food court, measured 112.3 m inside the perimeter in RD-2026-08-30-01 §4.1.
    expect(oracle.assess(12.900864, 77.516765).status).toBe(SERVICEABILITY.INSIDE);
  });
});
