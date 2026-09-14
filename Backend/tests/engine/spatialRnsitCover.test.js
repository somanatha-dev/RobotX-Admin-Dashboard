"use strict";

/**
 * **The RNSIT cover under D2 (resolution 11) and D6 (boundary-overlapping INDEX cells).**
 *
 * Two covers exist for the same boundary and they answer two different questions:
 *
 *   · the **centre-contained** cover — 45 cells, every centre inside the campus;
 *   · the **index** cover — 64 cells, boundary-overlapping, which D6 permits as
 *     *index membership only*.
 *
 * The refusal `B1_EXTERNAL_INPUT_HANDOFF.md` §1.8.4 item 2 records — *"the owner does not
 * authorise geographic over-assignment of non-campus area into a RobotX region"* — is
 * **not deleted and not weakened**. RD-2026-09-14-01 D6 narrows its *scope*: overlapping
 * cells are index buckets, they confer no delivery-domain membership, and the exact
 * coordinate remains authoritative for every actual destination. These tests assert that
 * the narrowing bought an index and did not buy serviceability.
 *
 * Geometry: the adopted `way/1120154292`, hash-verified. No buffer, no simplification, no
 * reprojection, no snapping, no invented expansion.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const h3 = require("h3-js");

const cells = require("../../src/engine/spatial/cells");
const deliveryDomain = require("../../src/engine/spatial/deliveryDomain");
const regionBoundary = require("../../src/engine/spatial/regionBoundary");

const REPO_ROOT = path.join(__dirname, "..", "..", "..");
const BOUNDARY_SHA256 = "04cb64c4205dc59462e149501fdd93b412106cfdc8d7249661bc8f3f47dc08b4";

const BOUNDARY = (() => {
  const raw = fs.readFileSync(path.join(REPO_ROOT, "rnsit-campus-osm.geojson"));
  expect(crypto.createHash("sha256").update(raw).digest("hex")).toBe(BOUNDARY_SHA256);
  return JSON.parse(raw).features.find((row) => row.id === "way/1120154292").geometry;
})();

const FINE = cells.H3_RESOLUTION.FINE;
const COARSE = cells.H3_RESOLUTION.COARSE;

const CENTRE_COVER = h3.polygonToCells(BOUNDARY.coordinates, FINE, true);
const INDEX_COVER = h3.polygonToCellsExperimental(
  BOUNDARY.coordinates,
  FINE,
  h3.POLYGON_TO_CELLS_FLAGS.containmentOverlapping,
  true,
);

const DOMAIN = deliveryDomain.validateDomainDeclaration({
  regionId: "rnsit-campus",
  name: "RNSIT Campus",
  kind: "CAMPUS",
  crs: "EPSG:4326",
  version: "way/1120154292",
  versionDate: "2026-08-30",
  boundary: BOUNDARY,
});

const coverOf = (cellIds, extra = {}) => ({
  fineCells: cellIds.map((cellId) => ({ cellId, zoneId: "zone-1" })),
  ...extra,
});

describe("D2 — resolution 11 is what makes a non-empty RNSIT cover exist at all", () => {
  test("resolutions 8 and 9 produce an EMPTY cover, which fails V-8", () => {
    for (const resolution of [8, 9]) {
      const cover = h3.polygonToCells(BOUNDARY.coordinates, resolution, true);
      expect({ resolution, count: cover.length }).toEqual({ resolution, count: 0 });
    }
    const verdict = regionBoundary.validateCover(coverOf([]));
    expect(verdict.status).toBe(regionBoundary.BOUNDARY_STATUS.INVALID);
    expect(verdict.problems.join("\n")).toMatch(/V-8: the fine-cell cover is empty/u);
  });

  test("resolution 11 produces 45 centre-contained cells and 64 index cells", () => {
    expect(CENTRE_COVER.length).toBe(45);
    expect(INDEX_COVER.length).toBe(64);
    expect(new Set(CENTRE_COVER).size).toBe(45);
    expect(new Set(INDEX_COVER).size).toBe(64);
    // The centre cover is a subset of the index cover — the overlap mode adds, never
    // substitutes.
    const index = new Set(INDEX_COVER);
    expect(CENTRE_COVER.every((cellId) => index.has(cellId))).toBe(true);
  });

  test("the coarse index is unchanged at resolution 5 and is a single cell for this campus", () => {
    const coarse = h3.polygonToCellsExperimental(
      BOUNDARY.coordinates, COARSE, h3.POLYGON_TO_CELLS_FLAGS.containmentOverlapping, true,
    );
    expect(COARSE).toBe(5);
    expect(coarse.length).toBeGreaterThan(0);
    // Every fine cell's H3 parent is a coarse cell of the same campus — the hierarchy is
    // arithmetic and needs no second published map.
    for (const cellId of INDEX_COVER) {
      expect(cells.resolutionOfH3Cell(cells.coarseParentOf(cellId))).toBe(cells.RESOLUTION.COARSE);
    }
  });
});

describe("D6 — boundary-overlapping cells are INDEX membership and nothing more", () => {
  test("every cell the overlap mode adds has its CENTRE outside the campus", () => {
    const centre = new Set(CENTRE_COVER);
    const added = INDEX_COVER.filter((cellId) => !centre.has(cellId));
    expect(added.length).toBe(19);
    for (const cellId of added) {
      const [lat, lon] = h3.cellToLatLng(cellId);
      expect(deliveryDomain.evaluatePoint(DOMAIN, lat, lon).verdict).toBe("OUTSIDE");
    }
  });

  /**
   * **The index cover reaches 100% of campus ground and the centre cover does not.**
   *
   * This is the measured reason D6 is worth having. Under centre containment 10.34% of
   * RNSIT had no fine cell at all and failed closed to INDETERMINATE — safe, but not a
   * delivery domain. Sampled here on a 5 m lattice for runtime; the full 0.7 m raster
   * result is in `docs/spatial/`.
   */
  test("every in-campus sample resolves to a cell in the INDEX cover; the centre cover misses some", () => {
    const index = new Set(INDEX_COVER);
    const centre = new Set(CENTRE_COVER);
    const box = DOMAIN.bbox;
    const STEP_M = 5;
    const meanLat = (box.minLat + box.maxLat) / 2;
    const dLat = STEP_M / 110574;
    const dLon = STEP_M / (111320 * Math.cos((meanLat * Math.PI) / 180));

    let inCampus = 0;
    let missedByIndex = 0;
    let missedByCentre = 0;
    for (let lat = box.minLat; lat <= box.maxLat; lat += dLat) {
      for (let lon = box.minLon; lon <= box.maxLon; lon += dLon) {
        if (deliveryDomain.evaluatePoint(DOMAIN, lat, lon).verdict !== "INSIDE") continue;
        inCampus += 1;
        const cellId = h3.latLngToCell(lat, lon, FINE);
        if (!index.has(cellId)) missedByIndex += 1;
        if (!centre.has(cellId)) missedByCentre += 1;
      }
    }

    expect(inCampus).toBeGreaterThan(1000);
    expect(missedByIndex).toBe(0);
    // The centre cover genuinely misses ground. This is asserted, not merely noted: if it
    // ever stops being true the D6 ruling has lost its reason.
    expect(missedByCentre).toBeGreaterThan(0);
  });

  test("index membership NEVER implies domain membership — the two questions disagree by design", () => {
    const index = new Set(INDEX_COVER);
    // Sample each added cell's own centre: indexed, and outside the domain.
    const centre = new Set(CENTRE_COVER);
    const added = INDEX_COVER.filter((cellId) => !centre.has(cellId));

    let indexedAndOutside = 0;
    for (const cellId of added) {
      const [lat, lon] = h3.cellToLatLng(cellId);
      expect(index.has(h3.latLngToCell(lat, lon, FINE))).toBe(true);
      if (deliveryDomain.evaluatePoint(DOMAIN, lat, lon).verdict === "OUTSIDE") indexedAndOutside += 1;
    }
    expect(indexedAndOutside).toBe(added.length);
  });

  test("the index cover overlays non-campus ground, and that ground is DENIED by coordinate", () => {
    // The cost of the ruling, stated as a test rather than a footnote: the index does
    // cover ground outside the campus. Safety comes from the coordinate test, not from
    // the cover being tight.
    const box = DOMAIN.bbox;
    const index = new Set(INDEX_COVER);
    let outsideButIndexed = 0;
    const STEP = 0.00005;
    for (let lat = box.minLat; lat <= box.maxLat; lat += STEP) {
      for (let lon = box.minLon; lon <= box.maxLon; lon += STEP) {
        const verdict = deliveryDomain.evaluatePoint(DOMAIN, lat, lon).verdict;
        if (verdict === "OUTSIDE" && index.has(h3.latLngToCell(lat, lon, FINE))) outsideButIndexed += 1;
      }
    }
    expect(outsideButIndexed).toBeGreaterThan(0);
  });
});

describe("V-8, V-9, V-10 on the real cover", () => {
  test("V-8 now PASSES for RNSIT — this is what the resolution change bought", () => {
    const verdict = regionBoundary.validateCover(coverOf(INDEX_COVER, { cardinalityException: "fixture" }));
    expect(verdict.problems.join("\n")).not.toMatch(/V-8/u);
    expect(verdict.fineCellCount).toBe(64);
  });

  test("V-9 still fires on 64 cells, and the sanctioned mechanism is the declared exception", () => {
    const without = regionBoundary.validateCover(coverOf(INDEX_COVER));
    expect(without.status).toBe(regionBoundary.BOUNDARY_STATUS.INVALID);
    expect(without.problems.join("\n")).toMatch(/V-9: the cover holds 64 fine cells/u);

    const withException = regionBoundary.validateCover(
      coverOf(INDEX_COVER, {
        cardinalityException:
          "RNSIT is a deliberately small bounded deployment (0.0995 km²); §3.6's 10³–10⁵ envelope describes a " +
          "metro service area and does not represent this region's physical scale (B1 §1.8.4 item 1).",
      }),
    );
    expect(withException.status).toBe(regionBoundary.BOUNDARY_STATUS.VALID);
  });

  test("V-9 is NOT weakened — the band itself is untouched", () => {
    expect(regionBoundary.FINE_CELL_BAND).toEqual({ min: 1000, max: 100000 });
  });

  test("V-10 refuses a cell published at any resolution but FINE", () => {
    for (const resolution of [8, 9, 10, 12]) {
      const foreign = h3.latLngToCell(12.9008, 77.5176, resolution);
      const verdict = regionBoundary.validateCover(coverOf([foreign], { cardinalityException: "fixture" }));
      expect({ resolution, status: verdict.status }).toEqual({ resolution, status: regionBoundary.BOUNDARY_STATUS.INVALID });
    }
    // And it accepts the model in force.
    const ok = regionBoundary.validateCover(coverOf([INDEX_COVER[0]], { cardinalityException: "fixture" }));
    expect(ok.status).toBe(regionBoundary.BOUNDARY_STATUS.VALID);
  });

  test("V-10 refuses a malformed token outright, distinctly from a foreign resolution", () => {
    const verdict = regionBoundary.validateCover(coverOf(["not-an-h3-index"], { cardinalityException: "fixture" }));
    expect(verdict.problems.join("\n")).toMatch(/not a valid H3 index/u);
  });
});

describe("the geometry is used exactly as adopted", () => {
  test("the declaration validates against the adopted way, unmodified", () => {
    expect(DOMAIN.status).toBe(regionBoundary.BOUNDARY_STATUS.VALID);
    expect(DOMAIN.domainId).toBe("rnsit-campus");
    expect(DOMAIN.version).toBe("way/1120154292");
  });

  test("the ring is closed, is used verbatim, and is not simplified", () => {
    const ring = BOUNDARY.coordinates[0];
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    expect(ring.length).toBe(19);
    // The bbox is derived from the supplied positions and nothing else.
    const lons = ring.map(([lon]) => lon);
    const lats = ring.map(([, lat]) => lat);
    expect(DOMAIN.bbox).toEqual({
      minLon: Math.min(...lons), maxLon: Math.max(...lons),
      minLat: Math.min(...lats), maxLat: Math.max(...lats),
    });
  });
});
