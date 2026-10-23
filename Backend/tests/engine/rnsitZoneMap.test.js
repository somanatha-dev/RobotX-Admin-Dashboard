"use strict";

/**
 * **The RNSIT four-zone map PROPOSAL (`tools/campus/rnsitZoneMap.js`) — offline checks.**
 *
 * Read with `docs/audits/dtaro-zone-coordination/RNSIT_ZONE_MAPPING_PROPOSAL.md`. Nothing here
 * publishes, pins, writes a row or opens a connection: the published-map behaviour is exercised
 * through the production modules that read a map (`hierarchy`, the V1 composition's
 * `routeDescriptorFor`, `simulatedAgentState`, F27) against in-memory maps.
 *
 * What these tests establish, and what they deliberately do not:
 *   · the generator keeps the adopted 64-cell cover and its single region, and is deterministic;
 *   · the 14 tied cells stay UNRESOLVED — no test, fixture or default gives one an owner;
 *   · an incomplete proposal cannot become a candidate spatial map, and the engine's own
 *     publish-time validator rejects it by name if someone hand-builds one;
 *   · F27's dependency on database `Zone` rows, through the real seams;
 *   · the proposal's documented path assumption (the spine way touches three zones).
 * They do NOT establish that the map is approved or publishable: it is neither.
 */

const h3 = require("h3-js");

const zoneMap = require("../../tools/campus/rnsitZoneMap");
const cells = require("../../src/engine/spatial/cells");
const hierarchy = require("../../src/engine/spatial/hierarchy");
const validators = require("../../src/engine/config/validators");
const f27 = require("../../src/engine/feasibility/predicates/f27");
const composition = require("../../src/services/v1DemonstrationComposition");
const simulatedAgentState = require("../../src/simulation/simulatedAgentState");

/** A stand-in for the target database's `Region.id`; the real one differs per environment. */
const REGION_ROW_ID = "test-region-row-id";
const PROPOSED_IDS = zoneMap.PROPOSED_ZONES.map((zone) => zone.id);

const inputs = zoneMap.loadInputs();
const { cover } = zoneMap.coverOf(inputs.boundary);
const proposal = zoneMap.buildProposal({ inputs });
const check = zoneMap.checkProposal(proposal, { cover });

const clone = (value) => JSON.parse(JSON.stringify(value));
const rowOf = (cellId) => proposal.cells.find((row) => row.cellId === cellId);
const resolvedRows = proposal.cells.filter((row) => row.zoneId !== null);
const unresolvedRows = proposal.cells.filter((row) => row.zoneId === null);

/** The proposal's resolved cells only: what a reviewer could see today. Not a publishable map. */
function partialMap() {
  return {
    regions: [{ id: REGION_ROW_ID }],
    zones: PROPOSED_IDS.map((id) => ({ id, regionId: REGION_ROW_ID })),
    sites: [],
    cells: resolvedRows.map((row) => ({ cellId: row.cellId, resolution: "FINE", regionId: REGION_ROW_ID, zoneId: row.zoneId })),
  };
}

describe("inputs — the adopted cover, unchanged", () => {
  test("64 FINE cells, 45 centre-contained, every one H3 resolution 11", () => {
    expect(cover).toHaveLength(zoneMap.EXPECTED_COVER_CELLS);
    expect(proposal.cells.filter((row) => row.centreInBoundary)).toHaveLength(45);
    for (const cellId of cover) expect(cells.resolutionOfH3Cell(cellId)).toBe(cells.RESOLUTION.FINE);
  });

  test("a boundary that does not give the adopted 64-cell cover is refused", () => {
    const shrunk = clone(inputs.boundary);
    const ring = shrunk.coordinates[0];
    const [lon0, lat0] = ring[0];
    shrunk.coordinates[0] = ring.map(([lon, lat]) => [lon0 + (lon - lon0) / 2, lat0 + (lat - lat0) / 2]);
    expect(() => zoneMap.coverOf(shrunk)).toThrow(/not the adopted 64/);
  });

  test("the proposal lists exactly the cover, in canonical order", () => {
    expect(proposal.cells.map((row) => row.cellId)).toEqual(cover);
  });
});

describe("the proposal — deterministic, never approved, ties left open", () => {
  test("two builds are identical", () => {
    expect(JSON.stringify(zoneMap.buildProposal({ inputs }))).toBe(JSON.stringify(proposal));
  });

  test("it is not approved and says so, with the owner questions still outstanding", () => {
    expect(proposal.approved).toBe(false);
    expect(proposal.status).toBe(zoneMap.STATUS.UNRESOLVED);
    expect(proposal.outstandingOwnerDecisions).toHaveLength(12);
  });

  test("no anchor cell is claimed by two zones, and every anchor cell is its zone's at distance 0", () => {
    expect(proposal.anchorConflicts).toEqual([]);
    for (const zone of proposal.zones) {
      expect(zone.anchors.length).toBeGreaterThan(0);
      for (const anchor of zone.anchors) {
        expect(rowOf(anchor.cellId)).toMatchObject({ zoneId: zone.id, basis: zoneMap.BASIS.ANCHOR });
      }
    }
  });

  test("exactly 14 cells are tied; each has no zone and at least two nearest zones", () => {
    expect(unresolvedRows).toHaveLength(14);
    expect(proposal.unresolved).toEqual(unresolvedRows.map((row) => row.cellId));
    for (const row of unresolvedRows) {
      expect(row.basis).toBe(zoneMap.BASIS.UNRESOLVED_TIE);
      expect(row.nearest.length).toBeGreaterThanOrEqual(2);
    }
  });

  test("every resolved cell has exactly one nearest zone and is assigned to it", () => {
    expect(resolvedRows).toHaveLength(50);
    for (const row of resolvedRows) {
      expect(row.nearest).toEqual([row.zoneId]);
      expect([zoneMap.BASIS.ANCHOR, zoneMap.BASIS.NEAREST]).toContain(row.basis);
    }
  });
});

describe("structural checks", () => {
  test("the only finding is the unresolved cells, named one by one", () => {
    expect(check.complete).toBe(false);
    expect(check.findings.map((finding) => finding.id)).toEqual(["UNRESOLVED_CELLS"]);
    for (const row of unresolvedRows) expect(check.findings[0].message).toContain(row.cellId);
  });

  test("every proposed zone is non-empty and its resolved cells are one connected piece", () => {
    for (const id of PROPOSED_IDS) {
      expect(check.zoneCells[id].length).toBeGreaterThan(0);
      expect(check.zoneComponents[id]).toBe(1);
    }
  });

  // Negative controls: a check that cannot fail is not a check.
  test("control: a duplicated, a missing and a foreign cell are each reported", () => {
    const bad = clone(proposal);
    bad.cells.push(clone(bad.cells[0]));
    bad.cells.splice(1, 1);
    bad.cells.push({ ...clone(bad.cells[2]), cellId: h3.latLngToCell(0, 0, cells.H3_RESOLUTION.FINE) });
    const ids = zoneMap.checkProposal(bad, { cover }).findings.map((finding) => finding.id);
    expect(ids).toEqual(expect.arrayContaining(["DUPLICATE_CELL", "MISSING_CELL", "EXTRA_CELL"]));
  });

  test("control: an emptied zone and a split zone are each reported", () => {
    const emptied = clone(proposal);
    for (const row of emptied.cells) if (row.zoneId === "rnsit-z4") row.zoneId = "rnsit-z3";
    expect(zoneMap.checkProposal(emptied, { cover }).findings.map((f) => f.id)).toContain("EMPTY_ZONE");

    // Move one rnsit-z5 cell that touches no rnsit-z2 cell into rnsit-z2: rnsit-z2 becomes two pieces.
    const z2 = new Set(check.zoneCells["rnsit-z2"]);
    const island = check.zoneCells["rnsit-z5"].find((cellId) => cells.diskAround(cellId, 1).every((n) => !z2.has(n)));
    const split = clone(proposal);
    split.cells.find((row) => row.cellId === island).zoneId = "rnsit-z2";
    expect(zoneMap.checkProposal(split, { cover }).findings.map((f) => f.id)).toContain("DISCONNECTED_ZONE");
  });
});

describe("final ownership is required before a candidate map exists", () => {
  test("candidateSpatialMap refuses the proposal and names all 14 cells", () => {
    let error;
    try {
      zoneMap.candidateSpatialMap(proposal, { regionId: REGION_ROW_ID });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(zoneMap.ZoneMapIncompleteError);
    expect(error.unresolved).toEqual(proposal.unresolved);
    expect(error.message).toMatch(/owner decision/);
  });

  test("a hand-built 64-cell map that leaves the ties without a zone is rejected by the engine's own validators", () => {
    const handBuilt = {
      ...partialMap(),
      cells: proposal.cells.map((row) => ({ cellId: row.cellId, resolution: "FINE", regionId: REGION_ROW_ID, zoneId: row.zoneId })),
    };
    const verdict = hierarchy.validateForPublish(handBuilt);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.filter((problem) => /names no zone/.test(problem))).toHaveLength(14);
    // V8 (the publish-time check) independently refuses the same 14 cells.
    const v8 = validators.v8SpatialContainment(hierarchy.toConfigPayload(handBuilt));
    expect(v8.filter((finding) => /maps to 0 zones/.test(finding.message))).toHaveLength(14);
  });

  test("an owner override must say who, when and why, name a cover cell and a proposed zone", () => {
    const tie = proposal.unresolved[0];
    const good = { zoneId: proposal.cells.find((row) => row.cellId === tie).nearest[0], by: "x", on: "2026-10-23", reason: "x" };
    expect(() => zoneMap.buildProposal({ inputs, overrides: { [tie]: { ...good, reason: "" } } })).toThrow(/"reason"/);
    expect(() => zoneMap.buildProposal({ inputs, overrides: { [tie]: { ...good, on: "23/10/2026" } } })).toThrow(/YYYY-MM-DD/);
    expect(() => zoneMap.buildProposal({ inputs, overrides: { [tie]: { ...good, zoneId: "rnsit-z9" } } })).toThrow(/no proposed zone/);
    const foreign = h3.latLngToCell(0, 0, cells.H3_RESOLUTION.FINE);
    expect(() => zoneMap.buildProposal({ inputs, overrides: { [foreign]: good } })).toThrow(/not a cover cell/);
  });

  test("the candidate map shape itself validates once a proposal is complete (synthetic two-cell proposal, not RNSIT)", () => {
    const a = cells.cellForPoint(12.9, 77.5, cells.RESOLUTION.FINE);
    const synthetic = {
      zones: [{ id: "synthetic-zone" }],
      cells: [a, cells.ringAt(a, 1)[0]].map((cellId) => ({ cellId, zoneId: "synthetic-zone" })),
      unresolved: [],
    };
    const map = zoneMap.candidateSpatialMap(synthetic, { regionId: REGION_ROW_ID });
    expect(hierarchy.validateForPublish(map)).toEqual({ ok: true, problems: [] });
  });
});

describe("region identity — reassigning zones does not move a resolved cell between regions", () => {
  const current = hierarchy.indexMap(zoneMap.currentSpatialMap(cover, { regionId: REGION_ROW_ID }));
  const partial = hierarchy.indexMap(partialMap());

  test("today's map (every cell in rnsit-z1, as the bootstrap publishes it) is valid and assigns all 64 cells", () => {
    expect(hierarchy.validateForPublish(zoneMap.currentSpatialMap(cover, { regionId: REGION_ROW_ID })).ok).toBe(true);
    for (const cellId of cover) expect(current.resolve(cellId)).toMatchObject({ assigned: true, zoneId: zoneMap.CURRENT_ZONE_ID });
  });

  test("every resolved cell keeps its region; every tied cell would be UNASSIGNED if published as is", () => {
    for (const row of resolvedRows) {
      expect(partial.resolve(row.cellId)).toMatchObject({ assigned: true, regionId: current.resolve(row.cellId).regionId, zoneId: row.zoneId });
    }
    for (const row of unresolvedRows) expect(partial.resolve(row.cellId).assigned).toBe(false);
  });
});

describe("F27 compatibility — traversed zones from the map, authorised zones from Zone rows", () => {
  const SIM_ENV = Object.freeze({ ENABLE_VIRTUAL_SIMULATOR: "true", V1_DEMONSTRATION_COMPOSITION: "true" });
  const seams = composition.createV1DemonstrationComposition({ prisma: {}, snapshot: () => ({ spatial: partialMap() }), env: SIM_ENV });
  const anchorOf = (zoneId) => proposal.zones.find((zone) => zone.id === zoneId).anchors[0].cellId;

  const agentAt = (cellId) => ({ agentId: "SIM-1", provenance: simulatedAgentState.PROVENANCE, cellId, mobilityModel: { speedModel: { nominalSpeedMps: 1.5 } } });
  const plan = (agentCell, stopCells) => ({
    route: seams.routeDescriptorFor({ agentSnapshot: agentAt(agentCell), stops: stopCells.map((cellId) => ({ cellId })), decisionTimeMs: 0, horizonSeconds: 60 }),
  });
  /** `agentFacts` builds the authorised set from the region's `Zone` rows exactly like this. */
  const agentWithRows = (cellId, zoneRowIds) => ({
    ...agentAt(cellId),
    authorisedZoneIds: simulatedAgentState.simulatedAgentFacts({ robot: { robotId: "SIM-1", status: "IDLE" }, regionZoneIds: zoneRowIds }).authorisedZoneIds,
  });

  test("the route seam resolves an agent and stops in three proposed zones to those three zones", () => {
    const route = plan(anchorOf("rnsit-z2"), [anchorOf("rnsit-z4"), anchorOf("rnsit-z5")]).route;
    expect(route.zonesTraversed).toEqual(["rnsit-z2", "rnsit-z4", "rnsit-z5"]);
  });

  test("with only today's Zone row (rnsit-z1), F27 is VIOLATED — the map must not be pinned before its rows exist", () => {
    const verdict = f27.evaluate({
      agentSnapshot: agentWithRows(anchorOf("rnsit-z2"), [zoneMap.CURRENT_ZONE_ID]),
      plan: plan(anchorOf("rnsit-z2"), [anchorOf("rnsit-z4"), anchorOf("rnsit-z5")]),
    });
    expect(verdict.outcome).toBe("VIOLATED");
    expect(verdict.observed.unauthorisedZones).toEqual(["rnsit-z2", "rnsit-z4", "rnsit-z5"]);
  });

  test("with a Zone row for every proposed zone, F27 is SATISFIED", () => {
    const verdict = f27.evaluate({
      agentSnapshot: agentWithRows(anchorOf("rnsit-z2"), [zoneMap.CURRENT_ZONE_ID, ...PROPOSED_IDS]),
      plan: plan(anchorOf("rnsit-z2"), [anchorOf("rnsit-z4"), anchorOf("rnsit-z5")]),
    });
    expect(verdict.outcome).toBe("SATISFIED");
  });

  test("a stop in a tied (unpublished) cell leaves the zone list unreadable, and F27 does not pass", () => {
    const verdict = f27.evaluate({
      agentSnapshot: agentWithRows(anchorOf("rnsit-z2"), [zoneMap.CURRENT_ZONE_ID, ...PROPOSED_IDS]),
      plan: plan(anchorOf("rnsit-z2"), [proposal.unresolved[0]]),
    });
    expect(verdict.outcome).not.toBe("SATISFIED");
  });
});

describe("path transitions — reported, not judged", () => {
  const transitions = zoneMap.pathTransitions(proposal, { inputs });

  test("road classes come from the access register and are footway, path, service", () => {
    expect(transitions.roadClasses).toEqual(["footway", "path", "service"]);
  });

  test("deterministic", () => {
    expect(JSON.stringify(zoneMap.pathTransitions(proposal, { inputs }))).toBe(JSON.stringify(transitions));
  });

  test("the proposal's §4.4 assumption holds: the spine way/204638949 passes through rnsit-z3, z4 and z5, and through tied cells", () => {
    const spine = transitions.ways.find((way) => way.id === "way/204638949");
    expect(spine.zones).toEqual(expect.arrayContaining(["rnsit-z3", "rnsit-z4", "rnsit-z5"]));
    expect(spine.unresolvedCells).toBeGreaterThan(0);
  });
});
