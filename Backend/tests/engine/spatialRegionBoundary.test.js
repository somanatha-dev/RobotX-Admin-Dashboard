"use strict";

/**
 * Engine lane — the **D1 acceptance gate** (`src/engine/spatial/regionBoundary.js`) and the
 * publish-time guard behind it (`config/validators.js` A6, `spatial/hierarchy.js`
 * `validateForPublish`).
 *
 * ── What these tests establish, and what they deliberately do not ──────────
 * They establish that a supplied operating region is **accepted or refused mechanically**:
 * every one of report §30.5.5's checks V-1 … V-13 has a fixture that trips it and a fixture
 * that does not. They establish that a map of placeholder tokens can no longer be published
 * as an operating region, which is finding **N21**.
 *
 * They establish **nothing about where this system operates.** D1 is an Operations +
 * Commercial decision and is still open. Every polygon below is a rectangle on the equator or
 * a deliberately malformed variant of one, chosen precisely because nobody could read it as a
 * deployment: no test here declares a region, and the gate's own answer to the repository's
 * real state — nothing supplied — is asserted first, as `NOT_CONFIGURED`.
 *
 * ── The failure this file exists to prevent ───────────────────────────────
 * A `[lat, lon]` boundary read as `[lon, lat]` produces a cover somewhere else on Earth and
 * passes every downstream check. So does a geometry authored in a projected CRS. Both are
 * asserted here, because neither is discoverable later by looking at the data.
 */

const regionBoundary = require("../../src/engine/spatial/regionBoundary");
const hierarchy = require("../../src/engine/spatial/hierarchy");
const cells = require("../../src/engine/spatial/cells");
const service = require("../../src/engine/config/service");

const { BOUNDARY_STATUS, REGION_KIND, CELL_INDEXING } = regionBoundary;

/**
 * A well-formed declaration, used as the base every negative fixture perturbs by one field.
 *
 * **Not a region.** A 1° square whose south-west corner is the origin of the coordinate
 * system: it is in the Gulf of Guinea, it serves nobody, and it exists so the *shape* of a
 * valid answer can be asserted without anybody having decided a real one.
 */
const VALID = Object.freeze({
  regionId: "TEST-FIXTURE-NOT-A-REGION",
  name: "test fixture — not an operating region",
  kind: REGION_KIND.METRO_SERVICE_AREA,
  crs: "EPSG:4326",
  version: "fixture-1",
  versionDate: "2026-08-09",
  boundary: {
    type: "Polygon",
    coordinates: [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
        [0, 0],
      ],
    ],
  },
});

/** @param {object} overrides @returns {object} */
const withField = (overrides) => ({ ...VALID, ...overrides });

/** @param {number[][]} ring @returns {object} */
const polygonOf = (ring) => ({ type: "Polygon", coordinates: [ring] });

const problemsOf = (result) => result.problems.join("\n");

describe("the repository's actual D1 state, asserted before anything else", () => {
  test("no region supplied is NOT_CONFIGURED — which is not VALID and not INVALID", () => {
    const result = regionBoundary.validateRegionDeclaration(undefined);
    expect(result.status).toBe(BOUNDARY_STATUS.NOT_CONFIGURED);
    expect(result.polygons).toBeNull();
    expect(result.bbox).toBeNull();
    // The message must send the reader to the decision, not to a code change.
    expect(problemsOf(result)).toMatch(/Operations \+ Commercial|§36\.3\.1/u);
  });

  test("the gate holds no region, no coordinate and no default anywhere in its exports", () => {
    // The one property that makes this module safe to ship while D1 is open: reading it
    // teaches you nothing about where anything operates, because it knows nothing.
    const source = require("fs").readFileSync(require.resolve("../../src/engine/spatial/regionBoundary.js"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/.*$/gmu, "");
    // No decimal-degree literal: every number left in the code is a range bound, an index or
    // a cardinality. A coordinate pair would show up here.
    expect(code).not.toMatch(/\b\d{1,3}\.\d{3,}\b/u);
    expect(regionBoundary.REGION_KINDS).toHaveLength(4);
  });
});

describe("V-1 … V-6 — a supplied declaration is checked, not trusted", () => {
  test("a well-formed declaration validates, and its bbox is derived from its own geometry", () => {
    const result = regionBoundary.validateRegionDeclaration(VALID);
    expect({ status: result.status, problems: result.problems }).toEqual({ status: BOUNDARY_STATUS.VALID, problems: [] });
    expect(result.bbox).toEqual({ minLon: 0, minLat: 0, maxLon: 1, maxLat: 1 });
  });

  test("V-1 — a Point, a LineString or a GeometryCollection is refused", () => {
    for (const type of ["Point", "LineString", "GeometryCollection", "Feature"]) {
      const result = regionBoundary.validateRegionDeclaration(withField({ boundary: { type, coordinates: [] } }));
      expect({ type, status: result.status }).toEqual({ type, status: BOUNDARY_STATUS.INVALID });
      expect(problemsOf(result)).toMatch(/V-1/u);
    }
  });

  test("V-2 — an unclosed ring is refused, and so is one with too few positions", () => {
    const unclosed = regionBoundary.validateRegionDeclaration(
      withField({ boundary: polygonOf([[0, 0], [1, 0], [1, 1], [0, 1]]) }),
    );
    expect(problemsOf(unclosed)).toMatch(/V-2.*not closed/su);

    const tooShort = regionBoundary.validateRegionDeclaration(withField({ boundary: polygonOf([[0, 0], [1, 1], [0, 0]]) }));
    expect(problemsOf(tooShort)).toMatch(/V-2.*at least 4 positions/su);
  });

  test("V-3 — a self-intersecting ring is refused, because its interior is undefined", () => {
    // A bow-tie: the classic case, and the one where a cover would be silently wrong rather
    // than absent, since a fill rule would still produce cells for something.
    const bowTie = polygonOf([
      [0, 0],
      [1, 1],
      [1, 0],
      [0, 1],
      [0, 0],
    ]);
    const result = regionBoundary.validateRegionDeclaration(withField({ boundary: bowTie }));
    expect(result.status).toBe(BOUNDARY_STATUS.INVALID);
    expect(problemsOf(result)).toMatch(/V-3.*crosses/su);
  });

  test("V-4 — a ring enclosing zero area is refused", () => {
    const degenerate = polygonOf([
      [0, 0],
      [1, 0],
      [2, 0],
      [0, 0],
    ]);
    const result = regionBoundary.validateRegionDeclaration(withField({ boundary: degenerate }));
    expect(problemsOf(result)).toMatch(/V-4.*zero area/su);
  });

  test("V-5 — AXIS ORDER: a [lat, lon] file is caught whenever it can be proven", () => {
    // The load-bearing test of this file. A boundary authored [lat, lon] and read [lon, lat]
    // produces a cover somewhere else entirely, every downstream check passes, and the only
    // symptom is that routing is wrong in a way nobody can attribute. Where it can be proven
    // — a second element outside ±90° cannot be a latitude — it must be refused.
    const swapped = polygonOf([
      [12.9, 100.5],
      [12.9, 100.6],
      [13.0, 100.6],
      [13.0, 100.5],
      [12.9, 100.5],
    ]);
    const result = regionBoundary.validateRegionDeclaration(withField({ boundary: swapped }));
    expect(result.status).toBe(BOUNDARY_STATUS.INVALID);
    expect(problemsOf(result)).toMatch(/V-5.*not a latitude/su);
    // And it must not silently correct it: a re-ordered geometry is a new authoritative file.
    expect(problemsOf(result)).toMatch(/Neither is corrected here/u);
  });

  test("V-5 — an out-of-range longitude and a non-numeric position are both refused", () => {
    expect(problemsOf(regionBoundary.validateRegionDeclaration(withField({ boundary: polygonOf([[200, 0], [201, 0], [201, 1], [200, 0]]) })))).toMatch(/V-5/u);
    expect(problemsOf(regionBoundary.validateRegionDeclaration(withField({ boundary: polygonOf([["0", 0], [1, 0], [1, 1], ["0", 0]]) })))).toMatch(/V-5.*finite numbers/su);
  });

  test("V-6 — an absent CRS is refused rather than assumed to be EPSG:4326", () => {
    const result = regionBoundary.validateRegionDeclaration(withField({ crs: undefined }));
    expect(result.status).toBe(BOUNDARY_STATUS.INVALID);
    expect(problemsOf(result)).toMatch(/V-6.*never assumed/su);
  });

  test("V-6 — a projected CRS is refused, and is not reprojected here", () => {
    const result = regionBoundary.validateRegionDeclaration(withField({ crs: "EPSG:32643" }));
    expect(problemsOf(result)).toMatch(/V-6.*not WGS-84/su);
    expect(problemsOf(result)).toMatch(/deliberately not performed here/u);
  });

  test("V-6 — the WGS-84 synonyms are all accepted", () => {
    for (const crs of ["EPSG:4326", "epsg:4326", "OGC:CRS84", "WGS84"]) {
      expect({ crs, status: regionBoundary.validateRegionDeclaration(withField({ crs })).status }).toEqual({ crs, status: BOUNDARY_STATUS.VALID });
    }
  });

  test("V-7 and fields 1, 2, 5 — id, name, kind, version and date are each required", () => {
    expect(problemsOf(regionBoundary.validateRegionDeclaration(withField({ regionId: "" })))).toMatch(/V-7 field 1/u);
    expect(problemsOf(regionBoundary.validateRegionDeclaration(withField({ regionId: " R-1 " })))).toMatch(/whitespace/u);
    expect(problemsOf(regionBoundary.validateRegionDeclaration(withField({ name: undefined })))).toMatch(/field 1: name/u);
    expect(problemsOf(regionBoundary.validateRegionDeclaration(withField({ kind: "REGION" })))).toMatch(/field 2: kind/u);
    expect(problemsOf(regionBoundary.validateRegionDeclaration(withField({ version: undefined })))).toMatch(/field 5: version/u);
    expect(problemsOf(regionBoundary.validateRegionDeclaration(withField({ versionDate: "2026-02-30" })))).toMatch(/field 5: versionDate/u);
  });

  test("a MultiPolygon is accepted, and one bad member fails the whole declaration", () => {
    const good = { type: "MultiPolygon", coordinates: [VALID.boundary.coordinates, [[[5, 5], [6, 5], [6, 6], [5, 5]]]] };
    expect(regionBoundary.validateRegionDeclaration(withField({ boundary: good })).status).toBe(BOUNDARY_STATUS.VALID);

    const bad = { type: "MultiPolygon", coordinates: [VALID.boundary.coordinates, [[[5, 5], [6, 5], [5, 5]]]] };
    expect(regionBoundary.validateRegionDeclaration(withField({ boundary: bad })).status).toBe(BOUNDARY_STATUS.INVALID);
  });
});

describe("V-8, V-9, V-10 — the cover, and N21", () => {
  /** Real H3 indices at §3.6's two bands. Arbitrary equator points; not an operating region. */
  const fine = (lon) => cells.cellForPoint(0, lon, cells.RESOLUTION.FINE);
  const coarse = (lon) => cells.cellForPoint(0, lon, cells.RESOLUTION.COARSE);

  test("no cover supplied is NOT_CONFIGURED", () => {
    expect(regionBoundary.validateCover(undefined).status).toBe(BOUNDARY_STATUS.NOT_CONFIGURED);
  });

  test("V-8 — an empty fine-cell cover is refused: a region with no cells has no pricing surface", () => {
    const result = regionBoundary.validateCover({ fineCells: [], coarseCells: [] });
    expect(result.status).toBe(BOUNDARY_STATUS.INVALID);
    expect(problemsOf(result)).toMatch(/V-8/u);
  });

  test("V-9 — a cover outside §3.6's 10³–10⁵ band is refused unless the exception is recorded", () => {
    const small = { fineCells: [{ cellId: fine(0), zoneId: "z1" }] };
    expect(problemsOf(regionBoundary.validateCover(small))).toMatch(/V-9.*N23/su);
    // An exception is allowed — and must be *stated*, because an unstated exception and a
    // defect look identical.
    expect(regionBoundary.validateCover({ ...small, cardinalityException: "campus deployment, recorded in ADR-nn" }).status).toBe(BOUNDARY_STATUS.VALID);
  });

  test("V-10 / N21 — a placeholder cell token can no longer be published as a region cell", () => {
    // The exact tokens report §30.5.2 proves pass the shipped validator with zero problems.
    const fabricated = { fineCells: [{ cellId: "cell-rrnagar-fine-01", zoneId: "ZN-RRNAGAR" }], cardinalityException: "fixture" };
    const result = regionBoundary.validateCover(fabricated);
    expect(result.status).toBe(BOUNDARY_STATUS.INVALID);
    expect(problemsOf(result)).toMatch(/V-10.*not a valid H3 index/su);
  });

  test("V-10 — a cell published at the wrong resolution is refused", () => {
    const wrong = { fineCells: [{ cellId: coarse(0), zoneId: "z1" }], cardinalityException: "fixture" };
    expect(problemsOf(regionBoundary.validateCover(wrong))).toMatch(/V-10.*resolution 5.*published as FINE/su);
  });

  test("V-10 — §6.2's site-local graph zones remain legitimate, and must name their site", () => {
    // The carve-out is real: §6.2's indoor and multi-level space is a per-region proximity
    // partition whose tokens are deliberately not geodesic. What the check refuses is a token
    // that is neither an H3 index nor a declared site-local one.
    const declared = {
      fineCells: [{ cellId: "site-rnsit-floor-2-wing-a", zoneId: "z1", siteId: "STE-1", indexing: CELL_INDEXING.SITE_LOCAL_GRAPH_ZONE }],
      cardinalityException: "fixture",
    };
    expect(regionBoundary.validateCover(declared).status).toBe(BOUNDARY_STATUS.VALID);

    const unsited = { fineCells: [{ cellId: "floating-token", zoneId: "z1", indexing: CELL_INDEXING.SITE_LOCAL_GRAPH_ZONE }], cardinalityException: "fixture" };
    expect(problemsOf(regionBoundary.validateCover(unsited))).toMatch(/claims §6\.2's site-local graph-zone exemption but names no site/u);
  });
});

describe("D2's residual fitness check (N23) — recorded, and still not reopening D2", () => {
  test("it cannot be evaluated without D1 field 2 and a cover", () => {
    const result = regionBoundary.d2ResidualCheck({});
    expect(result.status).toBe(BOUNDARY_STATUS.NOT_CONFIGURED);
    expect(result.fits).toBeNull();
    expect(result.note).toMatch(/D2's global value is unchanged and is not reopened/u);
  });

  test("a metro service area inside the band closes the residual; a campus below it does not", () => {
    expect(regionBoundary.d2ResidualCheck({ kind: REGION_KIND.METRO_SERVICE_AREA, fineCellCount: 20000 })).toMatchObject({ fits: true, status: BOUNDARY_STATUS.VALID });
    const campus = regionBoundary.d2ResidualCheck({ kind: REGION_KIND.CAMPUS, fineCellCount: 2 });
    expect(campus).toMatchObject({ fits: false, status: BOUNDARY_STATUS.INVALID });
    // It reports the tension; it does not resolve it, and it names whose call that is.
    expect(campus.note).toMatch(/is Architecture's.*not resolved here/su);
  });

  test("the global H3 resolutions are untouched by any of this", () => {
    expect({ fine: cells.H3_RESOLUTION.FINE, coarse: cells.H3_RESOLUTION.COARSE }).toEqual({ fine: 8, coarse: 5 });
  });
});

describe("V-11, V-12, V-13", () => {
  const east = withField({
    regionId: "FIXTURE-EAST",
    boundary: polygonOf([
      [10, 0],
      [11, 0],
      [11, 1],
      [10, 1],
      [10, 0],
    ]),
  });
  const overlapping = withField({
    regionId: "FIXTURE-OVERLAP",
    boundary: polygonOf([
      [0.5, 0.5],
      [1.5, 0.5],
      [1.5, 1.5],
      [0.5, 1.5],
      [0.5, 0.5],
    ]),
  });
  const contained = withField({
    regionId: "FIXTURE-INSIDE",
    boundary: polygonOf([
      [0.2, 0.2],
      [0.3, 0.2],
      [0.3, 0.3],
      [0.2, 0.3],
      [0.2, 0.2],
    ]),
  });

  const declare = (list) => list.map(regionBoundary.validateRegionDeclaration);

  test("V-11 — disjoint regions pass; crossing and contained regions are both refused", () => {
    expect(regionBoundary.validateRegionsDisjoint(declare([VALID, east])).status).toBe(BOUNDARY_STATUS.VALID);
    expect(problemsOf(regionBoundary.validateRegionsDisjoint(declare([VALID, overlapping])))).toMatch(/V-11.*overlap/su);
    // Containment without an edge crossing is the case a bbox test alone would miss.
    expect(problemsOf(regionBoundary.validateRegionsDisjoint(declare([VALID, contained])))).toMatch(/V-11.*overlap/su);
  });

  test("V-11's report is ordered by regionId, so two runs produce the same text (§9.6)", () => {
    const forward = regionBoundary.validateRegionsDisjoint(declare([VALID, overlapping]));
    const reverse = regionBoundary.validateRegionsDisjoint(declare([overlapping, VALID]));
    expect(forward.problems).toEqual(reverse.problems);
  });

  test("V-12 — a charger outside the region's cover is refused as an unreachable fallback", () => {
    const inside = cells.cellForPoint(0, 0, cells.RESOLUTION.FINE);
    const outside = cells.cellForPoint(0, 40, cells.RESOLUTION.FINE);
    const cover = { fineCells: [{ cellId: inside, zoneId: "z1" }] };

    expect(regionBoundary.validateChargerContainment({ cover, chargers: [{ chargerId: "CHG-1", cellId: inside }] }).status).toBe(BOUNDARY_STATUS.VALID);
    expect(problemsOf(regionBoundary.validateChargerContainment({ cover, chargers: [{ chargerId: "CHG-2", cellId: outside }] }))).toMatch(/V-12.*not in this region's cover/su);
    expect(problemsOf(regionBoundary.validateChargerContainment({ cover, chargers: [{ chargerId: "CHG-3" }] }))).toMatch(/names no cell/u);
    expect(regionBoundary.validateChargerContainment({}).status).toBe(BOUNDARY_STATUS.NOT_CONFIGURED);
  });

  test("V-13 — an unsupplied extract margin is NOT_CONFIGURED, never a pass", () => {
    const region = regionBoundary.validateRegionDeclaration(VALID);
    const result = regionBoundary.validateExtractMargin({ region, extract: undefined });
    expect(result.status).toBe(BOUNDARY_STATUS.NOT_CONFIGURED);
    // The margin's size is B1's to measure, and the check says so rather than defaulting one.
    expect(problemsOf(result)).toMatch(/measured at B1 Step 1\/3/u);
  });

  test("V-13 — an extract that does not cover the region plus its margin is refused", () => {
    const region = regionBoundary.validateRegionDeclaration(VALID);
    const tight = { bbox: { minLon: 0, minLat: 0, maxLon: 1, maxLat: 1 }, marginDegrees: 0.1 };
    expect(regionBoundary.validateExtractMargin({ region, extract: tight }).status).toBe(BOUNDARY_STATUS.INVALID);

    const generous = { bbox: { minLon: -0.2, minLat: -0.2, maxLon: 1.2, maxLat: 1.2 }, marginDegrees: 0.1 };
    expect(regionBoundary.validateExtractMargin({ region, extract: generous }).status).toBe(BOUNDARY_STATUS.VALID);
  });
});

describe("N21 at the publish path — the guard that is actually load-bearing", () => {
  /**
   * A map whose cell ids are placeholder tokens, in the shape `prisma/seed.js` publishes.
   * Report §30.5.2 proves this map passes the shipped validation with zero problems; the
   * point of A6 is that it can no longer become a published configuration version.
   */
  const FABRICATED = Object.freeze({
    regions: [{ id: "RGN-FIXTURE", name: "fixture" }],
    zones: [{ id: "ZN-FIXTURE", regionId: "RGN-FIXTURE" }],
    sites: [],
    cells: [{ cellId: "cell-fixture-fine-01", resolution: "FINE", regionId: "RGN-FIXTURE", zoneId: "ZN-FIXTURE", siteId: null }],
  });

  const DERIVED = Object.freeze({
    regions: [{ id: "RGN-FIXTURE", name: "fixture" }],
    zones: [{ id: "ZN-FIXTURE", regionId: "RGN-FIXTURE" }],
    sites: [],
    cells: [{ cellId: cells.cellForPoint(0, 0, cells.RESOLUTION.FINE), resolution: "FINE", regionId: "RGN-FIXTURE", zoneId: "ZN-FIXTURE", siteId: null }],
  });

  test("Phase 2's containment validator still accepts the token map — deliberately unchanged", () => {
    // `validate()` answers §3.6's containment question and was built against an opaque token
    // while B5 was open. Tightening it would break the durable mirror and the seed for a
    // reason that belongs at publish time, so it is left exactly as it was.
    expect(hierarchy.validate(FABRICATED)).toEqual({ ok: true, problems: [] });
  });

  test("but `validateForPublish` refuses it, and accepts the derived one", () => {
    const refused = hierarchy.validateForPublish(FABRICATED);
    expect(refused.ok).toBe(false);
    expect(refused.problems.join("\n")).toMatch(/not a valid H3 index/u);
    expect(hierarchy.validateForPublish(DERIVED)).toEqual({ ok: true, problems: [] });
  });

  test("A6 BLOCKS the publish of a fabricated map — the mechanical guard N21 asked for", () => {
    const { result } = service.validateCandidate({ spatial: hierarchy.toConfigPayload(FABRICATED) });
    const a6 = result.blocking.filter((finding) => finding.id === "A6");
    expect(a6.length).toBeGreaterThan(0);
    expect(a6[0].message).toMatch(/V-10 cell "cell-fixture-fine-01" is not a valid H3 index/u);
    expect(result.ok).toBe(false);
  });

  test("A6 passes a derived map, and passes vacuously while nothing is published", () => {
    const derived = service.validateCandidate({ spatial: hierarchy.toConfigPayload(DERIVED) }).result;
    expect(derived.blocking.filter((finding) => finding.id === "A6")).toEqual([]);
    // D1 is undecided: `spatial` is null today, and an absent map is not an invalid one.
    expect(service.validateCandidate({}).result.blocking.filter((finding) => finding.id === "A6")).toEqual([]);
  });

  test("A6 checks the coarse array at the coarse resolution, not at the fine one", () => {
    const coarseToken = cells.cellForPoint(0, 0, cells.RESOLUTION.COARSE);
    const map = {
      ...DERIVED,
      cells: [...DERIVED.cells, { cellId: coarseToken, resolution: "COARSE", regionId: "RGN-FIXTURE", zoneId: null, siteId: null }],
    };
    const payload = hierarchy.toConfigPayload(map);
    expect(payload.coarseCells.map((cell) => cell.cellId)).toEqual([coarseToken]);
    expect(service.validateCandidate({ spatial: payload }).result.blocking.filter((finding) => finding.id === "A6")).toEqual([]);
  });
});
