"use strict";

/**
 * Integration lane — **the Routing × Spatial authority boundary**.
 *
 * ── Why this file exists ──────────────────────────────────────────────────
 * Routing Batch 1 and Spatial D1–D7 were built in parallel and landed in the same branch.
 * Each contains a point-in-polygon implementation, and the cross-batch audit of 2026-09-19
 * established that they answer the **same geometric question** with the **same ray cast** but
 * under **different verdict policy** — and that nothing in either suite noticed.
 *
 * The resolution adopted is not "delete one". It is: exactly one of them is the authority.
 *
 *   · **`spatial/deliveryDomain.js` is the delivery-domain authority.** The verdict is taken
 *     once, at intake, on the customer's exact coordinate, and pinned to `Stop.geofenceResult`.
 *     The round reads the pin through `pinnedMembership` and evaluates no geometry (ADR-28:
 *     *containment by published assignment, not by query-time geometry*).
 *
 *   · **`routing/campusServiceability.js` is a routing-local instrument.** It guards coordinates
 *     that *this repository derived* from cell ids — see `cellProjection.js` — so a derived
 *     point that lands off-campus is refused rather than routed to. That is a narrower question
 *     than domain membership and it is never an admission decision.
 *
 * These tests hold that line. They are deliberately about the **seam**, not about either
 * module's internals: `spatialDeliveryDomain.test.js` owns D1's behaviour and
 * `routingProductionSeam.test.js` owns the routing producer's.
 *
 * ── What each section proves ──────────────────────────────────────────────
 *   1. The adopted spatial model is resolution 11 and cannot be silently reverted to 8.
 *   2. The routing layer is not a second delivery-domain authority in production.
 *   3. The routing helper's verdict cannot be read as, or written as, the pinned D1 verdict —
 *      including on the two inputs where the two modules deliberately disagree.
 *   4. Fail-closed behaviour on both sides of the seam is intact: absent is never a pass.
 */

const fs = require("fs");
const path = require("path");
const h3 = require("h3-js");

const cells = require("../../src/engine/spatial/cells");
const regionBoundary = require("../../src/engine/spatial/regionBoundary");
const deliveryDomain = require("../../src/engine/spatial/deliveryDomain");
const campusServiceability = require("../../src/engine/routing/campusServiceability");
const cellProjection = require("../../src/engine/routing/cellProjection");

const { SERVICEABILITY } = campusServiceability;
const { GEOFENCE_VERDICT } = deliveryDomain;

const SRC = path.resolve(__dirname, "..", "..", "src");

/** The adopted RNSIT way, read from the tree rather than transcribed. */
function rnsitGeometry() {
  const file = path.resolve(__dirname, "..", "..", "..", "rnsit-campus-osm.geojson");
  const collection = JSON.parse(fs.readFileSync(file, "utf8"));
  return collection.features.find((entry) => entry.id === "way/1120154292").geometry;
}

/** The §1.8.1 owner-declared fields wrapped around that geometry. */
function rnsitDeclaration() {
  return {
    regionId: "rnsit-bengaluru",
    name: "RNSIT Bengaluru Campus",
    kind: regionBoundary.REGION_KIND.CAMPUS,
    crs: "OGC:CRS84",
    version: "rnsit-boundary-v1",
    versionDate: "2026-08-30",
    boundary: rnsitGeometry(),
  };
}

/** Every `.js` file under `src/`, as `[relativePath, body]`. */
function sourceFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".js")) out.push([path.relative(SRC, full).replace(/\\/gu, "/"), fs.readFileSync(full, "utf8")]);
    }
  };
  walk(SRC);
  return out;
}

/* ═══════════════════════════════════════════════════════════════════════════
   1 — the adopted spatial model, pinned against a silent revert
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the adopted spatial model is resolution 11 (ADR-35) and cannot be silently reverted", () => {
  test("FINE resolves to H3 resolution 11 and COARSE to 5", () => {
    expect(h3.getResolution(cells.cellForPoint(12.900864, 77.516765, cells.RESOLUTION.FINE))).toBe(11);
    expect(h3.getResolution(cells.cellForPoint(12.900864, 77.516765, cells.RESOLUTION.COARSE))).toBe(5);
  });

  /**
   * The specific regression this guards. Routing Batch 1 asserted a resolution-8 measurement
   * through the **symbolic** `cells.RESOLUTION.FINE`, so the assertion re-measured itself when
   * ADR-35 changed what `FINE` meant, and the cheapest way to make it green again would have
   * been to revert the resolution. Reverting it now fails here too, in the suite that would
   * have benefited — which is the only placement that makes the guard load-bearing.
   */
  test("a resolution-8 token is NOT a fine cell — an old cover cannot be read as current", () => {
    const legacy = h3.latLngToCell(12.900864, 77.516765, 8);
    expect(cells.resolutionOfH3Cell(legacy)).toBeNull();
    expect(cells.resolutionOfH3Cell(cells.cellForPoint(12.900864, 77.516765, cells.RESOLUTION.FINE))).toBe(cells.RESOLUTION.FINE);
  });

  // A source-scanning "no resolution 8 anywhere in the routing suite" gate was drafted here and
  // deliberately dropped: `routingProductionSeam.test.js:281` legitimately calls
  // `polygonToCells(ring, 8)` on a *synthetic* region and asserts only `Array.isArray`, so any
  // regex broad enough to catch a bad symbolic assertion also catches that, and any regex narrow
  // enough to spare it no longer catches the real fault. A proxy gate that has to be weakened
  // until it passes is not a gate. The two assertions above are the load-bearing guards.
});

/* ═══════════════════════════════════════════════════════════════════════════
   2 — the routing layer is not a second production authority
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the routing layer is not a second delivery-domain authority", () => {
  test("no production module under src/ constructs a serviceability oracle", () => {
    // `campusServiceability.js` defines the factory, so it is excluded; nothing else may *call*
    // it. A production caller would be a second query-time producer of a domain verdict, which
    // is what ADR-28 forbids. Today the only callers are `tools/verify/` and the test suites.
    const offenders = sourceFiles()
      .filter(([file]) => file !== "engine/routing/campusServiceability.js")
      .filter(([, body]) => /createServiceabilityOracle\s*\(/u.test(body))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });

  test("the composition root imports no routing serviceability and no router of its own", () => {
    const body = fs.readFileSync(path.resolve(SRC, "workers", "coordinatorSolvePath.js"), "utf8");
    expect(body).not.toMatch(/require\(["'][^"']*campusServiceability/u);
    expect(body).not.toMatch(/require\(["'][^"']*productionRouter/u);
    // The router arrives injected as `context.route`, and the domain verdict arrives pinned.
    expect(body).toMatch(/deliveryDomain\.pinnedMembership/u);
  });

  test("intake is the only producer of a pinned geofence verdict", () => {
    const producers = sourceFiles()
      .filter(([file, body]) => file !== "engine/spatial/deliveryDomain.js" && /\b(verdictFor|evaluatePoint)\s*\(/u.test(body))
      .map(([file]) => file);
    expect(producers).toEqual(["services/task.service.js"]);
  });

  test("no production module writes a routing serviceability verdict onto geofenceResult", () => {
    for (const [, body] of sourceFiles()) {
      // A `geofenceResult` assignment fed from `assess(` would cross the two vocabularies.
      expect(body).not.toMatch(/geofenceResult\s*:\s*[^,\n]*assess\s*\(/u);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   3 — the two verdicts are not interconvertible, and disagree on record
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the routing verdict cannot silently redefine the pinned D1 verdict", () => {
  const oracle = () => campusServiceability.createServiceabilityOracle(rnsitDeclaration());
  const domain = () => deliveryDomain.validateDomainDeclaration(rnsitDeclaration());

  test("the vocabularies differ, so a routing verdict is not a pinnable D1 verdict", () => {
    expect(Object.keys(SERVICEABILITY).sort()).toEqual(["INSIDE", "INVALID_BOUNDARY", "NOT_CONFIGURED", "ON_BOUNDARY", "OUTSIDE"]);
    expect(Object.keys(GEOFENCE_VERDICT).sort()).toEqual(["INDETERMINATE", "INSIDE", "OUTSIDE"]);
    // The three routing-only verdicts are outside the pinned vocabulary and read as ABSENT —
    // never as `false`, which would assert a geographic fact, and never as `true`.
    for (const verdict of [SERVICEABILITY.ON_BOUNDARY, SERVICEABILITY.NOT_CONFIGURED, SERVICEABILITY.INVALID_BOUNDARY]) {
      expect(deliveryDomain.pinnedMembership(verdict)).toBeUndefined();
    }
  });

  /**
   * The divergence the audit measured, pinned as **deliberate**.
   *
   * D1 reads the published domain as a closed set, so a declared vertex is `INSIDE`. The routing
   * helper reports `ON_BOUNDARY` and leaves the commercial reading to its caller. Both are
   * correct for their own question; what must never happen is one being substituted for the
   * other, because on the whole declared perimeter they differ.
   */
  test("on EVERY declared vertex the two deliberately disagree — closed set vs reported boundary", () => {
    const ring = rnsitGeometry().coordinates[0];
    const validated = domain();
    const assess = oracle();
    expect(ring.length).toBeGreaterThan(0);
    for (const [lon, lat] of ring) {
      expect(deliveryDomain.evaluatePoint(validated, lat, lon).verdict).toBe(GEOFENCE_VERDICT.INSIDE);
      expect(assess.assess(lat, lon).status).toBe(SERVICEABILITY.ON_BOUNDARY);
    }
  });

  test("on a malformed coordinate D1 stays INDETERMINATE while routing refuses — neither invents a domain fact", () => {
    const validated = domain();
    const assess = oracle();
    for (const bad of [NaN, Infinity, "12.9", null, undefined]) {
      expect(deliveryDomain.evaluatePoint(validated, bad, bad).verdict).toBe(GEOFENCE_VERDICT.INDETERMINATE);
      expect(assess.assess(bad, bad).status).toBe(SERVICEABILITY.OUTSIDE);
    }
    // Both deny. They differ in what they *claim*, and D1's claim is the one that is pinned.
    expect(deliveryDomain.pinnedMembership(GEOFENCE_VERDICT.INDETERMINATE)).toBeUndefined();
  });

  /**
   * The drift guard `campusServiceability.js` claimed for the whole of Routing Batch 1 and never
   * had. The ray casts agree exactly; the audit measured 0 disagreements over a 201x201 grid and
   * over every declared vertex. If either copy is edited, this fails.
   */
  test("the two ray casts agree exactly — the divergence is policy, not geometry", () => {
    const ring = rnsitGeometry().coordinates[0];
    const lons = ring.map((p) => p[0]);
    const lats = ring.map((p) => p[1]);
    const [minLon, maxLon, minLat, maxLat] = [Math.min(...lons), Math.max(...lons), Math.min(...lats), Math.max(...lats)];
    const steps = 60;
    for (let i = 0; i <= steps; i += 1) {
      for (let j = 0; j <= steps; j += 1) {
        const point = [minLon + ((maxLon - minLon) * i) / steps, minLat + ((maxLat - minLat) * j) / steps];
        expect(campusServiceability.pointInRing(point, ring)).toBe(regionBoundary.pointInRing(point, ring));
      }
    }
    for (const vertex of ring) {
      expect(campusServiceability.pointInRing(vertex, ring)).toBe(regionBoundary.pointInRing(vertex, ring));
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   4 — fail-closed on both sides of the seam
   ═══════════════════════════════════════════════════════════════════════════ */

describe("absent is never a pass, on either side of the seam", () => {
  test("an undeclared delivery domain yields INDETERMINATE, and the round reads it as absent", () => {
    for (const published of [null, undefined, {}]) {
      expect(deliveryDomain.verdictFor(published, 12.900864, 77.516765).verdict).toBe(GEOFENCE_VERDICT.INDETERMINATE);
    }
    expect(deliveryDomain.pinnedMembership(undefined)).toBeUndefined();
    expect(deliveryDomain.pinnedMembership(null)).toBeUndefined();
  });

  test("an unconfigured or invalid routing region is NOT_CONFIGURED / INVALID_BOUNDARY, never INSIDE", () => {
    expect(campusServiceability.createServiceabilityOracle(null).assess(12.900864, 77.516765).status).toBe(SERVICEABILITY.NOT_CONFIGURED);
    const broken = campusServiceability.createServiceabilityOracle({ ...rnsitDeclaration(), boundary: { type: "Polygon", coordinates: [] } });
    expect(broken.assess(12.900864, 77.516765).status).toBe(SERVICEABILITY.INVALID_BOUNDARY);
    expect(broken.usable).toBe(false);
  });

  test("a projection with no usable region refuses with NO_REGION rather than projecting", () => {
    const inCampus = cells.cellForPoint(12.900864, 77.516765, cells.RESOLUTION.FINE);
    for (const oracle of [undefined, campusServiceability.createServiceabilityOracle(null)]) {
      const projection = cellProjection.createCellProjection({ serviceability: oracle });
      expect(() => projection.project(inCampus)).toThrow();
      try {
        projection.project(inCampus);
      } catch (error) {
        expect(error.refusal).toBe("NO_REGION");
      }
    }
  });

  test("an off-region cell is refused at whatever resolution FINE currently is", () => {
    const projection = cellProjection.createCellProjection({ serviceability: campusServiceability.createServiceabilityOracle(rnsitDeclaration()) });
    expect(() => projection.project(cells.cellForPoint(0, 0, cells.RESOLUTION.FINE))).toThrow(/OUTSIDE relative to the serviceable region/u);
  });
});
