"use strict";

/**
 * Phase 2 — §3.6 spatial hierarchy.
 *
 * The plan's checklist item: "Validate: zone never spans a region; every fine cell
 * maps to exactly one zone and ≤ one site". Its completion criterion: "spatial
 * containment validator (§22.1) passes on seeded region/zone/cell maps".
 *
 * Both halves are checked here: the module's own validator, and — because §22.1
 * rule 5's V8 is what actually gates a publish — the Config Service's validator run
 * over the same seeded map.
 */

const cells = require("../../src/engine/spatial/cells");
const hierarchy = require("../../src/engine/spatial/hierarchy");
const { SEED_SPATIAL_MAP } = require("../../prisma/seed");
const { validateCandidate } = require("../../src/engine/config/service");

describe("§3.6 — cells", () => {
  test("the two resolutions", () => {
    expect([...cells.RESOLUTIONS].sort()).toEqual(["COARSE", "FINE"]);
  });

  test("a cell id is an opaque token — no geometry is parsed from it", () => {
    // The index primitive is blocking decision B5, settled in Phase 9. Phase 2 must
    // work with H3 tokens, S2 tokens, or site-local graph-zone names alike.
    for (const token of ["8928308280fffff", "89c25a0000000000", "site:rnsit:floor-2:zone-a"]) {
      expect(cells.isCellId(token)).toBe(true);
      expect(cells.normaliseCellId(` ${token} `)).toBe(token);
    }
  });

  test("case is preserved — lower-casing would merge distinct H3/S2 tokens", () => {
    expect(cells.normaliseCellId("89C25A00")).toBe("89C25A00");
    expect(cells.compareCellIds("89C25A00", "89c25a00")).not.toBe(0);
  });

  test("canonical order is by code unit, so it is host-independent", () => {
    const sorted = cells.canonicalCellOrder(["b", "A", "a", "B"]);
    expect(sorted).toEqual(["A", "B", "a", "b"]);
  });

  test("the cell-pair cache key is ordered origin-first and is never sorted", () => {
    // Travel time is not symmetric: a downhill leg and its uphill return are
    // different queries, and a key that sorted the pair would answer one with the
    // other.
    expect(cells.cellPairKey("z-cell", "a-cell")).toBe("z-cell:a-cell");
    expect(cells.cellPairKey("a-cell", "z-cell")).not.toBe(cells.cellPairKey("z-cell", "a-cell"));
  });

  test("a fine cell with no zone is rejected — a hole in the pricing surface", () => {
    const problems = cells.validateAssignment({ cellId: "c1", resolution: "FINE", regionId: "R1" });
    expect(problems.join(" ")).toMatch(/names no zone/);
  });

  test("a coarse cell may have no zone", () => {
    expect(cells.validateAssignment({ cellId: "c1", resolution: "COARSE", regionId: "R1" })).toEqual([]);
  });
});

describe("§3.6 — containment by published assignment", () => {
  const map = {
    regions: [{ id: "R1" }, { id: "R2" }],
    zones: [{ id: "Z1", regionId: "R1" }, { id: "Z2", regionId: "R2" }],
    sites: [{ id: "S1", regionId: "R1" }],
    cells: [
      { cellId: "c1", resolution: "FINE", regionId: "R1", zoneId: "Z1", siteId: "S1" },
      { cellId: "c2", resolution: "FINE", regionId: "R1", zoneId: "Z1", siteId: null },
      { cellId: "c3", resolution: "FINE", regionId: "R2", zoneId: "Z2", siteId: null },
      { cellId: "cx", resolution: "COARSE", regionId: "R1", zoneId: null, siteId: null },
    ],
  };

  test("a well-formed map validates clean", () => {
    expect(hierarchy.validate(map)).toEqual({ ok: true, problems: [] });
  });

  test("resolution reads the published assignment, and takes no coordinates", () => {
    const index = hierarchy.indexMap(map);
    expect(index.resolve("c1")).toEqual({
      cellId: "c1",
      resolution: "FINE",
      zoneId: "Z1",
      siteId: "S1",
      regionId: "R1",
      assigned: true,
    });
    // The resolver's signature admits no lat/lon at all, which is the structural
    // form of "containment is by assignment, not by geometry".
    expect(index.resolve.length).toBe(1);
  });

  test("an unassigned cell reports assigned:false rather than a guessed containment", () => {
    const index = hierarchy.indexMap(map);
    const verdict = index.resolve("not-in-the-map");
    expect(verdict.assigned).toBe(false);
    expect(verdict.zoneId).toBeNull();
    expect(verdict.regionId).toBeNull();
  });

  test("a zone's cell set is returned in canonical order", () => {
    const shuffled = { ...map, cells: [...map.cells].reverse() };
    expect(hierarchy.indexMap(shuffled).cellsOfZone("Z1")).toEqual(["c1", "c2"]);
  });

  test("sites and zones are orthogonal — a site's cells are not a zone's cells", () => {
    const index = hierarchy.indexMap(map);
    expect(index.cellsOfSite("S1")).toEqual(["c1"]);
    expect(index.cellsOfZone("Z1")).toEqual(["c1", "c2"]);
  });

  test("a zone spanning two regions is rejected, and the finding says why", () => {
    const straddling = {
      ...map,
      zones: [{ id: "Z1", regionId: "R1" }, { id: "Z1", regionId: "R2" }],
    };
    const verdict = hierarchy.validate(straddling);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(" ")).toMatch(/Ω_terminal no longer bounds/);
  });

  test("a fine cell mapping to two zones is rejected", () => {
    const doubled = {
      ...map,
      cells: [...map.cells, { cellId: "c1", resolution: "FINE", regionId: "R1", zoneId: "Z2", siteId: null }],
    };
    const verdict = hierarchy.validate(doubled);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(" ")).toMatch(/maps to 2 zones/);
  });

  test("a fine cell mapping to two sites is rejected", () => {
    const doubled = {
      regions: [{ id: "R1" }],
      zones: [{ id: "Z1", regionId: "R1" }],
      sites: [{ id: "S1", regionId: "R1" }, { id: "S2", regionId: "R1" }],
      cells: [
        { cellId: "c1", resolution: "FINE", regionId: "R1", zoneId: "Z1", siteId: "S1" },
        { cellId: "c1", resolution: "FINE", regionId: "R1", zoneId: "Z1", siteId: "S2" },
      ],
    };
    const verdict = hierarchy.validate(doubled);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(" ")).toMatch(/maps to 2 sites/);
  });

  test("a cell whose own region disagrees with its zone's region is rejected", () => {
    const inconsistent = {
      ...map,
      cells: [{ cellId: "c1", resolution: "FINE", regionId: "R2", zoneId: "Z1", siteId: null }],
    };
    const verdict = hierarchy.validate(inconsistent);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(" ")).toMatch(/Containment must agree at every level/);
  });

  test("a zone naming an undeclared region is rejected", () => {
    const dangling = { ...map, zones: [{ id: "Z9", regionId: "R404" }] };
    expect(hierarchy.validate(dangling).ok).toBe(false);
  });
});

describe("the seeded map (Phase 2 completion criterion)", () => {
  test("passes the hierarchy validator", () => {
    expect(hierarchy.validate(SEED_SPATIAL_MAP)).toEqual({ ok: true, problems: [] });
  });

  test("passes the Config Service's §22.1 rule-5 V8 containment check", () => {
    // The completion criterion names §22.1 specifically: it is the publish-time
    // check that actually gates a configuration version, and it is the one Phase 1
    // shipped. Running the seeded map through the real validator is the evidence.
    const { result } = validateCandidate({ spatial: hierarchy.toConfigPayload(SEED_SPATIAL_MAP) });
    const v8Findings = result.findings.filter((finding) => finding.id === "V8");
    expect(v8Findings).toEqual([]);
  });

  test("V8 rejects a deliberately broken variant of the seeded map", () => {
    // The check above is only meaningful if V8 can fail, so it is shown failing on
    // the same map with one zone reassigned across regions.
    const broken = {
      ...SEED_SPATIAL_MAP,
      regions: [...SEED_SPATIAL_MAP.regions, { id: "RGN-OTHER", name: "Elsewhere" }],
      zones: [
        ...SEED_SPATIAL_MAP.zones,
        { id: "ZN-RRNAGAR", regionId: "RGN-OTHER", name: "Rajarajeshwari Nagar" },
      ],
    };
    const { result } = validateCandidate({ spatial: hierarchy.toConfigPayload(broken) });
    expect(result.findings.some((finding) => finding.id === "V8")).toBe(true);
  });

  test("every fine cell in the seeded map has exactly one zone", () => {
    const index = hierarchy.indexMap(SEED_SPATIAL_MAP);
    const fine = SEED_SPATIAL_MAP.cells.filter((cell) => cell.resolution === "FINE");
    expect(fine.length).toBeGreaterThan(0);
    for (const cell of fine) {
      expect(index.resolve(cell.cellId).zoneId).toBeTruthy();
    }
  });

  test("the config payload shape matches what V8 reads", () => {
    const payload = hierarchy.toConfigPayload(SEED_SPATIAL_MAP);
    expect(Object.keys(payload).sort()).toEqual(["cells", "coarseCells", "regions", "sites", "zones"]);
    for (const zone of payload.zones) expect(zone).toEqual({ id: expect.any(String), regionId: expect.any(String) });
    for (const cell of payload.cells) expect(cell.cellId).toEqual(expect.any(String));
  });

  test("`cells` carries the fine cells only; coarse cells go to `coarseCells`", () => {
    // §3.6 states the one-zone containment rule for fine cells alone. A coarse cell
    // spans many zones by construction — that is what makes it the §6.2 regional
    // sweep unit — so publishing it in the array V8 reads would fail a correct map
    // against a correct check.
    const payload = hierarchy.toConfigPayload(SEED_SPATIAL_MAP);
    expect(payload.cells.every((cell) => cell.resolution === "FINE")).toBe(true);
    expect(payload.coarseCells.map((cell) => cell.cellId)).toEqual(["cell-blr-coarse-01"]);
  });
});
