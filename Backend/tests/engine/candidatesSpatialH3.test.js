"use strict";

/**
 * Phase 9 — B5 settled: the H3 wrapper added to `spatial/cells.js` (§6.2, §6.3).
 *
 * `spatialHierarchy.test.js` (Phase 2) already covers the opaque-token half of
 * this module and is left untouched; this file covers only what Phase 9 adds.
 */

const cells = require("../../src/engine/spatial/cells");

describe("§3.6/B5 — H3 resolution mapping", () => {
  // The previous form of this test asserted a loose band (100 m < fine edge < 1000 m),
  // which would have passed at resolutions 8, 9 and 10 alike. It is replaced by an
  // **exact** assertion on the declared model, written as literals: reading
  // `H3_RESOLUTION` back and comparing it to itself would agree with any value.
  test("the declared spatial model is exactly H3 FINE 11 / COARSE 5", () => {
    expect({ fine: cells.H3_RESOLUTION.FINE, coarse: cells.H3_RESOLUTION.COARSE }).toEqual({ fine: 11, coarse: 5 });
    expect(cells.SPATIAL_MODEL.id).toBe("H3-F11-C5");
    expect(cells.SPATIAL_MODEL.primitive).toBe("H3");
  });

  test("COARSE stays inside §3.6's generic ~5–10 km band, and FINE is strictly finer", () => {
    const fineEdgeM = cells.edgeLengthMetres(cells.RESOLUTION.FINE);
    const coarseEdgeM = cells.edgeLengthMetres(cells.RESOLUTION.COARSE);
    expect(cells.H3_RESOLUTION.FINE).not.toBe(cells.H3_RESOLUTION.COARSE);
    expect(fineEdgeM).toBeLessThan(coarseEdgeM);
    // §3.6's coarse band is untouched by the D3 amendment and is still satisfied
    // directly, not by exception.
    expect(coarseEdgeM).toBeGreaterThan(5_000);
    expect(coarseEdgeM).toBeLessThan(10_000);
  });

  /**
   * §3.6 as amended by RD-2026-09-14-01 D3 permits a bounded deployment to adopt a finer
   * fine cell **through an explicitly declared spatial model**. This pins the thing that
   * amendment makes true and the thing it does not.
   *
   * It is deliberately a *failing* test if anyone quietly moves FINE back inside the
   * generic band and deletes the declaration: the exemption is only legitimate while a
   * declared model exists to carry it.
   */
  test("FINE is outside §3.6's generic fine band, and the declared model is what permits that", () => {
    const fineEdgeM = cells.edgeLengthMetres(cells.RESOLUTION.FINE);
    const GENERIC_FINE_BAND_FLOOR_M = 200;
    expect(fineEdgeM).toBeLessThan(GENERIC_FINE_BAND_FLOOR_M);

    // A declared model must NAME all four things §3.6's amended clause requires of one.
    expect(Object.keys(cells.SPATIAL_MODEL)).toEqual(
      expect.arrayContaining(["primitive", "fine", "coarse", "evidence"]),
    );
    expect(cells.SPATIAL_MODEL.evidence).toEqual(["COVERAGE", "SAFETY", "DETERMINISM", "PERFORMANCE", "PRIVACY"]);
  });

  test("the model identity is deterministic and derived, never hand-written", () => {
    const again = require("../../src/engine/spatial/cells");
    expect(again.SPATIAL_MODEL.id).toBe(cells.SPATIAL_MODEL.id);
    expect(cells.SPATIAL_MODEL.id).toBe(`H3-F${cells.H3_RESOLUTION.FINE}-C${cells.H3_RESOLUTION.COARSE}`);
    expect(Object.isFrozen(cells.SPATIAL_MODEL)).toBe(true);
  });

  /**
   * D5 — the geometric diameter and the operational network correction are two
   * quantities, and the register default must NOT be wired to the geometry.
   */
  test("the fine-cell diameter is 2x the edge, and is NOT the intra-cell offset default", () => {
    const diameter = cells.fineCellDiameterMetres();
    expect(diameter).toBeCloseTo(2 * cells.edgeLengthMetres(cells.RESOLUTION.FINE), 9);
    expect(diameter).toBeGreaterThan(57);
    expect(diameter).toBeLessThan(58);

    const register = require("../../src/engine/config/register/supplementary.json");
    const entry = register.parameters.find((row) => row.name === "route.intra_cell_offset_m");
    // Held at 250 by RD-2026-09-14-01 D5. It must remain at or above the geometric bound
    // (§20.3) **and** must not have been collapsed onto it.
    expect(entry.default).toBe(250);
    expect(entry.default).toBeGreaterThan(diameter);
    expect(entry.calibrationStatus).toBe("PROVISIONAL");
    // The old text said it awaited the cell edge length. That decision is made; this
    // parameter did not thereby become calibrated.
    expect(entry.awaits).toMatch(/network distance/iu);
    expect(entry.awaits).not.toMatch(/awaits the cell edge length chosen under blocking decision B5/iu);
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
