"use strict";

/**
 * Phase 9 — B5 settled: the H3 wrapper added to `spatial/cells.js` (§6.2, §6.3).
 *
 * `spatialHierarchy.test.js` (Phase 2) already covers the opaque-token half of
 * this module and is left untouched; this file covers only what Phase 9 adds.
 */

const cells = require("../../src/engine/spatial/cells");

describe("§3.6/B5 — H3 resolution mapping", () => {
  test("FINE and COARSE map to distinct H3 resolutions within their named bands", () => {
    expect(cells.H3_RESOLUTION.FINE).not.toBe(cells.H3_RESOLUTION.COARSE);
    const fineEdgeM = cells.edgeLengthMetres(cells.RESOLUTION.FINE);
    const coarseEdgeM = cells.edgeLengthMetres(cells.RESOLUTION.COARSE);
    expect(fineEdgeM).toBeLessThan(coarseEdgeM);
    // §6.2: "~200-500 m" fine, "~5-10 km" coarse — H3's discrete resolutions land
    // near, not necessarily inside, each band (documented in the module).
    expect(fineEdgeM).toBeGreaterThan(100);
    expect(fineEdgeM).toBeLessThan(1000);
    expect(coarseEdgeM).toBeGreaterThan(1000);
    expect(coarseEdgeM).toBeLessThan(20_000);
  });

  test("h3ResolutionOf rejects an unrecognised resolution label", () => {
    expect(() => cells.h3ResolutionOf("MEDIUM")).toThrow(/unknown resolution/);
  });
});

describe("§6.2 — cellForPoint and centreOfCell", () => {
  const LAT = 12.9716;
  const LON = 77.5946;

  test("is a pure function of (lat, lon, resolution) — same input, same cell", () => {
    const a = cells.cellForPoint(LAT, LON, cells.RESOLUTION.FINE);
    const b = cells.cellForPoint(LAT, LON, cells.RESOLUTION.FINE);
    expect(a).toBe(b);
  });

  test("fine and coarse cells for the same point are different tokens", () => {
    const fine = cells.cellForPoint(LAT, LON, cells.RESOLUTION.FINE);
    const coarse = cells.cellForPoint(LAT, LON, cells.RESOLUTION.COARSE);
    expect(fine).not.toBe(coarse);
  });

  test("rejects a non-finite or out-of-range coordinate", () => {
    expect(() => cells.cellForPoint(Number.NaN, LON, cells.RESOLUTION.FINE)).toThrow();
    expect(() => cells.cellForPoint(200, LON, cells.RESOLUTION.FINE)).toThrow();
  });

  test("centreOfCell round-trips near the original point", () => {
    const fine = cells.cellForPoint(LAT, LON, cells.RESOLUTION.FINE);
    const centre = cells.centreOfCell(fine);
    // Within one fine-cell edge length of the original point.
    const driftM = cells.greatCircleMetres(LAT, LON, centre.lat, centre.lon);
    expect(driftM).toBeLessThan(cells.edgeLengthMetres(cells.RESOLUTION.FINE));
  });

  test("centreOfCell rejects an invalid H3 token", () => {
    expect(() => cells.centreOfCell("not-an-h3-cell")).toThrow(/not a valid H3 cell/);
  });
});

describe("§6.2 — resolutionOfH3Cell", () => {
  test("identifies a fine cell as FINE and a coarse cell as COARSE", () => {
    const fine = cells.cellForPoint(12.97, 77.59, cells.RESOLUTION.FINE);
    const coarse = cells.cellForPoint(12.97, 77.59, cells.RESOLUTION.COARSE);
    expect(cells.resolutionOfH3Cell(fine)).toBe(cells.RESOLUTION.FINE);
    expect(cells.resolutionOfH3Cell(coarse)).toBe(cells.RESOLUTION.COARSE);
  });

  test("an opaque, non-H3 token (a site-local graph zone name) resolves to null, not an error", () => {
    expect(cells.resolutionOfH3Cell("site:rnsit:floor-2:zone-a")).toBeNull();
  });
});

describe("§6.2 — coarseParentOf and fineChildrenOf", () => {
  test("every fine cell's coarse parent contains it back", () => {
    const fine = cells.cellForPoint(12.97, 77.59, cells.RESOLUTION.FINE);
    const coarse = cells.coarseParentOf(fine);
    expect(cells.resolutionOfH3Cell(coarse)).toBe(cells.RESOLUTION.COARSE);
    expect(cells.fineChildrenOf(coarse)).toContain(fine);
  });

  test("coarseParentOf refuses a cell that is not fine-resolution", () => {
    const coarse = cells.cellForPoint(12.97, 77.59, cells.RESOLUTION.COARSE);
    expect(() => cells.coarseParentOf(coarse)).toThrow(/not a fine-resolution/);
  });

  test("fineChildrenOf refuses a cell that is not coarse-resolution", () => {
    const fine = cells.cellForPoint(12.97, 77.59, cells.RESOLUTION.FINE);
    expect(() => cells.fineChildrenOf(fine)).toThrow(/not a coarse-resolution/);
  });

  test("fineChildrenOf returns cells in canonical order", () => {
    const coarse = cells.cellForPoint(12.97, 77.59, cells.RESOLUTION.COARSE);
    const children = cells.fineChildrenOf(coarse);
    expect(children).toEqual(cells.canonicalCellOrder(children));
  });
});

describe("§6.3 — diskAround and ringAt (k-ring expansion)", () => {
  const origin = cells.cellForPoint(12.97, 77.59, cells.RESOLUTION.FINE);

  test("disk at k=0 is exactly the origin cell", () => {
    expect(cells.diskAround(origin, 0)).toEqual([origin]);
  });

  test("ring at k>=1 excludes the origin cell", () => {
    const ring1 = cells.ringAt(origin, 1);
    expect(ring1).not.toContain(origin);
    expect(ring1.length).toBeGreaterThan(0);
  });

  test("disk(k) is the union of ring(0..k), and grows monotonically", () => {
    const disk0 = cells.diskAround(origin, 0);
    const disk1 = cells.diskAround(origin, 1);
    const disk2 = cells.diskAround(origin, 2);
    expect(disk1.length).toBeGreaterThan(disk0.length);
    expect(disk2.length).toBeGreaterThan(disk1.length);

    const ring1 = cells.ringAt(origin, 1);
    const ring2 = cells.ringAt(origin, 2);
    const reconstructed = cells.canonicalCellOrder([...disk0, ...ring1, ...ring2]);
    expect(reconstructed).toEqual(disk2);
  });

  test("rejects a negative or fractional k", () => {
    expect(() => cells.diskAround(origin, -1)).toThrow();
    expect(() => cells.diskAround(origin, 1.5)).toThrow();
    expect(() => cells.ringAt(origin, 0)).toThrow();
  });

  test("results are canonically ordered", () => {
    const ring = cells.ringAt(origin, 2);
    expect(ring).toEqual(cells.canonicalCellOrder(ring));
  });
});

describe("§6.4 — gridDistanceBetween and greatCircleMetres", () => {
  test("grid distance from a cell to itself is zero", () => {
    const origin = cells.cellForPoint(12.97, 77.59, cells.RESOLUTION.FINE);
    expect(cells.gridDistanceBetween(origin, origin)).toBe(0);
  });

  test("grid distance to a ring-k neighbour is exactly k", () => {
    const origin = cells.cellForPoint(12.97, 77.59, cells.RESOLUTION.FINE);
    const ring2 = cells.ringAt(origin, 2);
    expect(cells.gridDistanceBetween(origin, ring2[0])).toBe(2);
  });

  test("great-circle distance is symmetric and zero for coincident points", () => {
    expect(cells.greatCircleMetres(12.97, 77.59, 12.97, 77.59)).toBe(0);
    const ab = cells.greatCircleMetres(12.9716, 77.5946, 12.98, 77.6);
    const ba = cells.greatCircleMetres(12.98, 77.6, 12.9716, 77.5946);
    expect(ab).toBeCloseTo(ba, 6);
  });

  test("great-circle distance rejects an out-of-range coordinate", () => {
    expect(() => cells.greatCircleMetres(12.97, 200, 12.98, 77.6)).toThrow();
  });
});
