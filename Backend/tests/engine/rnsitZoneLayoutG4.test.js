"use strict";

/**
 * **The RNSIT four-zone layout G4 (`tools/campus/rnsitZoneLayoutG4.js`) — offline checks.**
 *
 * Read with `docs/audits/dtaro-zone-coordination/RNSIT_ZONE_LAYOUT_G4_PROPOSAL.md`. Nothing here
 * publishes, pins, writes a row or opens a connection. Published-map behaviour is exercised
 * through the production modules that read a map (`hierarchy`, V8, `dtaroZoneAlert.resolvePoint`)
 * against in-memory maps.
 *
 * Three states are kept apart throughout:
 *   · GENERATED proposal — the instruments only; the 14 L4 ties are open;
 *   · VALIDATED proposal — decision rules R1–R4 applied (owner directive 2026-10-23) and every
 *     offline check passes; still `approved: false`, `published: false`;
 *   · PUBLISHED map — `rnsit-z1`, one zone, all 64 cells; untouched.
 */

const fs = require("fs");
const path = require("path");
const h3 = require("h3-js");

const g4 = require("../../tools/campus/rnsitZoneLayoutG4");
const zoneMap = require("../../tools/campus/rnsitZoneMap");
const cells = require("../../src/engine/spatial/cells");
const hierarchy = require("../../src/engine/spatial/hierarchy");
const validators = require("../../src/engine/config/validators");
const dtaroZoneAlert = require("../../src/services/dtaroZoneAlert.service");
const { pointInPolygon } = require("../../src/services/routeIntersection.service");

const REGION_ROW_ID = "test-region-row-id";
const JSSATE_REGION_ROW_ID = "test-jssate-region-row-id";
const ADOPTED_DIGEST = "04cb64c4205dc59462e149501fdd93b412106cfdc8d7249661bc8f3f47dc08b4";
const ZONE_IDS = g4.PROPOSED_ZONES.map((zone) => zone.id);
const [WEST, EAST, SOUTH, SOUTHWEST] = ZONE_IDS;

/**
 * The reviewed decision table (RNSIT_ZONE_LAYOUT_G4_PROPOSAL.md §6). A change to the inputs or
 * the rules that moves any of these must be reviewed, not absorbed.
 */
const EXPECTED_DECISIONS = Object.freeze({
  "8b6014510490fff": [EAST, "R2_INSTRUMENTS_AGREE", "MEDIUM"], // T01
  "8b6014510493fff": [SOUTH, "R2_INSTRUMENTS_AGREE", "HIGH"], // T02
  "8b601451049afff": [WEST, "R4_ONLY_CONNECTED_OPTION", "LOW"], // T03
  "8b601451049bfff": [WEST, "R3_CONNECTIVITY_REPAIR", "LOW"], // T04
  "8b60145104b1fff": [SOUTH, "R1_SINGLE_NEIGHBOUR", "HIGH"], // T05
  "8b60145104b3fff": [SOUTH, "R2_INSTRUMENTS_AGREE", "MEDIUM"], // T06
  "8b6014512841fff": [EAST, "R2_INSTRUMENTS_AGREE", "MEDIUM"], // T07 (HIGH evidence, seed-sensitive)
  "8b6014512861fff": [EAST, "R1_SINGLE_NEIGHBOUR", "HIGH"], // T08
  "8b6014512866fff": [EAST, "R1_SINGLE_NEIGHBOUR", "HIGH"], // T09
  "8b6014512868fff": [WEST, "R2_INSTRUMENTS_AGREE", "MEDIUM"], // T10
  "8b601451286afff": [WEST, "R3_CONNECTIVITY_REPAIR", "LOW"], // C1 (was East by footprint)
  "8b601451286cfff": [EAST, "R1_SINGLE_NEIGHBOUR", "HIGH"], // T11
  "8b601451286dfff": [WEST, "R2_INSTRUMENTS_AGREE", "HIGH"], // T12
  "8b6014512b20fff": [SOUTHWEST, "R1_SINGLE_NEIGHBOUR", "HIGH"], // T13
  "8b6014512b26fff": [SOUTHWEST, "R2_INSTRUMENTS_AGREE", "HIGH"], // T14
});

const context = g4.loadContext();
const report = g4.fullReport();
const { proposal } = report;
const generated = report.generated.proposal;
const rowOf = (cellId, p = proposal) => p.cells.find((row) => row.cellId === cellId);
const clone = (value) => JSON.parse(JSON.stringify(value));
const zoneCells = (zoneId, p = proposal) => p.cells.filter((row) => row.zoneId === zoneId).map((row) => row.cellId);
const ownerMap = (p) => new Map(p.cells.map((row) => [row.cellId, row.zoneId]));
const walkParts = (map, zoneId) => (g4.walkNetworks(map, g4.walkPieces(context))[zoneId] || []).length;
const geojson = () => JSON.parse(g4.renderAll(report)[g4.OUTPUT_FILES.geojson]);

describe("boundary containment — the adopted perimeter and cover, unchanged", () => {
  test("the perimeter is way/1120154292 from the adopted file, copied verbatim into the preview GeoJSON", () => {
    expect(proposal.boundary).toEqual({ way: "way/1120154292", sha256: ADOPTED_DIGEST });
    const perimeter = geojson().features.filter((f) => f.properties.role === "CAMPUS_PERIMETER");
    expect(perimeter).toHaveLength(1);
    expect(perimeter[0].geometry).toEqual(context.inputs.osm.features.find((f) => f.id === "way/1120154292").geometry);
    expect(perimeter[0].geometry.coordinates).toEqual(context.world.declaration.boundary.coordinates);
  });

  test("the cells are exactly the adopted 64-cell cover, in canonical order, 45 centre-inside", () => {
    expect(proposal.cells.map((row) => row.cellId)).toEqual(context.cover);
    expect(proposal.cells.filter((row) => row.centreInBoundary)).toHaveLength(45);
  });

  test("every cell has part of its area inside the boundary; boundary cells are flagged as such", () => {
    for (const row of proposal.cells) {
      expect(row.insideSamples).toBeGreaterThan(0);
      expect(row.flags.includes(g4.FLAG.BOUNDARY_CELL)).toBe(!row.centreInBoundary);
    }
  });

  test("every network seed and every piece of the walk network lies strictly inside the boundary", () => {
    for (const zone of proposal.zones) {
      for (const seed of zone.seeds) expect(context.containment.containsPoint(seed)).toBe(true);
      expect(zone.seeds.every((seed) => /^(access|osm-centroid):/.test(seed.evidence))).toBe(true);
    }
    for (const piece of g4.walkPieces(context)) expect(context.containment.containsPoint(piece.mid)).toBe(true);
    const outside = geojson().features.filter((f) => f.properties.sourceKind === "USER_SUPPLIED_POINT" && f.properties.insideBoundary === false);
    expect(outside.map((f) => f.id).sort()).toEqual(["supplemental:rnsit-main-gate", "supplemental:rnsit-parking-lot", "supplemental:rnsit-playground-1"]);
  });

  test("control: a seed the boundary does not contain is refused, never used", () => {
    const shut = { ...context, containment: { containsPoint: () => false, containsSegment: () => false } };
    expect(() => g4.buildProposal({ context: shut })).toThrow(/not strictly inside the boundary/);
  });
});

describe("determinism", () => {
  test("two builds of each stage are identical, and so are the digests", () => {
    expect(JSON.stringify(g4.buildProposal({ context }))).toBe(JSON.stringify(proposal));
    expect(JSON.stringify(g4.buildProposal({ context, stage: g4.STAGE.GENERATED }))).toBe(JSON.stringify(generated));
    expect(g4.assignmentDigest(generated)).toBe(report.generated.assignmentDigest);
  });

  test("the review files on disk are the generator's current output (run --write if this fails)", () => {
    for (const result of g4.checkOutputs(report)) expect(result).toEqual({ file: result.file, upToDate: true });
  });

  test("the generated files say VALIDATED PROPOSAL, not published, with both digests", () => {
    const onDisk = JSON.parse(fs.readFileSync(path.join(g4.OUTPUT_DIR, g4.OUTPUT_FILES.geojson), "utf8"));
    expect(onDisk.proposal).toMatchObject({
      stage: "DECIDED",
      validated: true,
      approved: false,
      published: false,
      unresolvedCells: 0,
      assignmentDigest: report.assignmentDigest,
      generatedAssignmentDigest: report.generated.assignmentDigest,
    });
    const html = fs.readFileSync(path.join(g4.OUTPUT_DIR, g4.OUTPUT_FILES.preview), "utf8");
    expect(html).toMatch(/VALIDATED PROPOSAL \(offline checks pass\) — NOT PUBLISHED, NOT PINNED, NOT APPROVED/);
    expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+href="http/);
  });
});

describe("GENERATED stage — the 14 L4 ties open, as reviewed on 2026-10-22", () => {
  test("exactly the L4 tie cells are open, each UNRESOLVED_TIE with no zone", () => {
    expect(generated.unresolved).toHaveLength(g4.EXPECTED_PINNED_TIES);
    expect(generated.unresolved).toEqual(context.l4.unresolved);
    for (const cellId of generated.unresolved) expect(rowOf(cellId, generated)).toMatchObject({ zoneId: null, basis: g4.BASIS.UNRESOLVED_TIE });
    expect(generated.cells.some((row) => row.decision)).toBe(false);
  });

  test("candidateSpatialMap refuses it, and a hand-built map with the ties zoneless fails validateForPublish and V8", () => {
    expect(() => zoneMap.candidateSpatialMap(generated, { regionId: REGION_ROW_ID })).toThrow(zoneMap.ZoneMapIncompleteError);
    const handBuilt = {
      regions: [{ id: REGION_ROW_ID }],
      zones: ZONE_IDS.map((id) => ({ id, regionId: REGION_ROW_ID })),
      sites: [],
      cells: generated.cells.map((row) => ({ cellId: row.cellId, resolution: "FINE", regionId: REGION_ROW_ID, zoneId: row.zoneId })),
    };
    expect(hierarchy.validateForPublish(handBuilt).problems.filter((p) => /names no zone/.test(p))).toHaveLength(14);
    expect(validators.v8SpatialContainment(hierarchy.toConfigPayload(handBuilt)).filter((f) => /maps to 0 zones/.test(f.message))).toHaveLength(14);
  });

  test("its validation fails exactly on open cells, split walk networks and the unrunnable engine check", () => {
    const failed = report.generated.validation.checks.filter((c) => !c.passed).map((c) => c.id);
    expect(failed.sort()).toEqual(["ALL_ASSIGNED", "ENGINE_VALIDATORS", "WALK_NETWORK_CONNECTED"]);
  });
});

describe("decisions R1–R4 (owner directive 2026-10-23) — justified, deterministic, not approvals", () => {
  test("every decided cell matches the reviewed decision table, and no other cell is decided", () => {
    const decided = Object.fromEntries(proposal.cells.filter((row) => row.decision).map((row) => [row.cellId, [row.zoneId, row.decision.rule, g4.confidenceFor(report, row)]]));
    expect(decided).toEqual(EXPECTED_DECISIONS);
  });

  test("every pinned tie is either decided by a rule or still open — never silently assigned", () => {
    for (const cellId of context.l4.unresolved) {
      const row = rowOf(cellId);
      if (row.zoneId === null) expect(row.basis).toBe(g4.BASIS.UNRESOLVED_TIE);
      else expect(row.decision).toMatchObject({ authority: expect.stringMatching(/directive 2026-10-23.*not owner-approved/) });
    }
  });

  test("each rule's own condition holds for the cells it decided", () => {
    for (const row of proposal.cells.filter((r) => r.decision)) {
      const { rule } = row.decision;
      if (rule === g4.RULE.R1_SINGLE_NEIGHBOUR) expect(row.competing).toEqual([row.zoneId]);
      if (rule === g4.RULE.R2_INSTRUMENTS_AGREE) {
        expect(row.footprintLeader).toBe(row.zoneId);
        expect(row.networkLeader).toBe(row.zoneId);
      }
      if (rule === g4.RULE.R4_ONLY_CONNECTED_OPTION) expect(row.connectedOptions).toEqual([row.zoneId]);
      if (rule === g4.RULE.R3_CONNECTIVITY_REPAIR) expect(row.decision.joinsPartsOfM.length).toBeGreaterThan(1);
    }
  });

  test("confidence is LOW exactly where an instrument points elsewhere", () => {
    for (const row of proposal.cells.filter((r) => r.decision)) {
      const disagrees = [row.footprintLeader, row.networkLeader].filter(Boolean).some((leader) => leader !== row.zoneId);
      expect(row.decision.confidence === "LOW").toBe(disagrees);
    }
  });

  test("the only assigned cell moved is the Main Building cell, by connectivity repair", () => {
    const moved = proposal.cells.filter((row) => row.decision && row.decision.from !== null);
    expect(moved.map((row) => [row.cellId, row.decision.from, row.zoneId])).toEqual([["8b601451286afff", EAST, WEST]]);
    expect(rowOf("8b601451286afff").footprintSamples[EAST]).toBeGreaterThan(rowOf("8b601451286afff").footprintSamples[WEST]);
  });

  test("…286a: left East, West's walk network is split (its north footway is cut off); moved West, every network is whole", () => {
    const asGenerated = ownerMap(proposal);
    asGenerated.set("8b601451286afff", EAST);
    expect(walkParts(asGenerated, WEST)).toBeGreaterThan(1);
    expect(walkParts(asGenerated, EAST)).toBe(1);
    for (const zoneId of ZONE_IDS) expect(walkParts(ownerMap(proposal), zoneId)).toBe(1);
  });

  test("T03: South would strand a piece of the hostel footway in South; West keeps every network whole", () => {
    const south = ownerMap(proposal);
    south.set("8b601451049afff", SOUTH);
    expect(walkParts(south, SOUTH)).toBe(2);
    expect(rowOf("8b601451049afff").connectedOptions).toEqual([WEST]);
    expect(rowOf("8b601451049afff").networkLeader).toBe(SOUTH); // the instrument that disagrees
  });

  test("T04: the hostel lane 788480057 meets the rest of the network only in this cell", () => {
    const open = ownerMap(proposal);
    open.set("8b601451049bfff", null);
    const parts = g4.walkNetworks(open, g4.walkPieces(context))[WEST];
    expect(parts).toHaveLength(2);
    expect(parts.some((part) => part.ways.includes("way/788480057") && !part.ways.includes("way/1183883496"))).toBe(true);
  });

  test("an owner override wins over every rule and is never moved by a repair", () => {
    const t10 = "8b6014512868fff";
    const overridden = g4.buildProposal({ context, overrides: { [t10]: { zoneId: EAST, by: "test", on: "2026-10-23", reason: "test only" } } });
    expect(rowOf(t10, overridden)).toMatchObject({ zoneId: EAST, basis: g4.BASIS.OVERRIDE });
    expect(rowOf(t10, overridden).decision).toBeUndefined();
    expect(overridden.approved).toBe(false);
    expect(() => g4.buildProposal({ context, overrides: { [t10]: { zoneId: EAST, by: "", on: "2026-10-23", reason: "x" } } })).toThrow(/"by"/);
  });
});

describe("VALIDATED stage — every offline check passes", () => {
  test("all validation checks pass", () => {
    expect(report.validation.checks.filter((c) => !c.passed)).toEqual([]);
    expect(report.validation.passed).toBe(true);
  });

  test("exactly four zones, each one H3 piece with one connected walk network, and no open cell", () => {
    expect(proposal.unresolved).toEqual([]);
    expect(proposal.status).toBe(zoneMap.STATUS.RESOLVED_PENDING_OWNER_APPROVAL);
    for (const zoneId of ZONE_IDS) {
      expect(g4.components(zoneCells(zoneId))).toHaveLength(1);
      expect(walkParts(ownerMap(proposal), zoneId)).toBe(1);
    }
  });

  test("every site-verified access point joins its own building's zone's walk network", () => {
    expect(report.validation.access).toHaveLength(18);
    for (const a of report.validation.access) expect(a.joinsNetworkIn).toBe(a.zone);
  });

  test("the candidate map builds and the engine's own publish validators accept it (offline; not a publication)", () => {
    const map = zoneMap.candidateSpatialMap(proposal, { regionId: REGION_ROW_ID });
    expect(hierarchy.validateForPublish(map)).toEqual({ ok: true, problems: [] });
    expect(validators.v8SpatialContainment(hierarchy.toConfigPayload(map))).toEqual([]);
    expect(proposal).toMatchObject({ approved: false, published: false });
  });

  test("each cover cell is listed once, zones are disjoint, and together they are the cover", () => {
    const seen = new Set();
    for (const zoneId of ZONE_IDS) {
      for (const cellId of zoneCells(zoneId)) {
        expect(seen.has(cellId)).toBe(false);
        seen.add(cellId);
      }
    }
    expect([...seen].sort()).toEqual([...context.cover].sort());
  });

  test("control: a duplicated cell, a dropped cell and a split zone are each reported", () => {
    const ids = (p) => zoneMap.checkProposal(p, { cover: context.cover }).findings.map((f) => f.id);
    const duplicated = clone(proposal);
    duplicated.cells.push(clone(duplicated.cells[0]));
    expect(ids(duplicated)).toContain("DUPLICATE_CELL");
    const dropped = clone(proposal);
    dropped.cells.pop();
    expect(ids(dropped)).toContain("MISSING_CELL");
    const split = clone(proposal);
    split.cells.find((row) => row.cellId === "8b60145104c2fff").zoneId = EAST;
    expect(ids(split)).toContain("DISCONNECTED_ZONE");
  });
});

describe("the PUBLISHED map is untouched", () => {
  test("today's map is still one zone, rnsit-z1, over all 64 cells, and it validates", () => {
    const today = zoneMap.currentSpatialMap(context.cover, { regionId: REGION_ROW_ID });
    expect(today.zones).toEqual([{ id: "rnsit-z1", regionId: REGION_ROW_ID }]);
    expect(hierarchy.validateForPublish(today).ok).toBe(true);
  });

  test("no runtime module reads the proposal; the recipient policy is wired only through the zone-alert service", () => {
    const src = path.resolve(__dirname, "../../src");
    const proposalReaders = [];
    const policyImporters = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.js$/.test(entry.name)) {
          const text = fs.readFileSync(full, "utf8");
          if (/rnsitZoneLayoutG4|rnsit-zone-proposal-g4|rnsit-z-(west|east|south)/.test(text)) proposalReaders.push(full);
          if (/require\([^)]*dtaroRecipientPolicy/.test(text)) policyImporters.push(full);
        }
      }
    };
    walk(src);
    expect(proposalReaders).toEqual([]);
    expect(policyImporters.map((f) => path.relative(src, f).split(path.sep).join("/"))).toEqual(["services/dtaroZoneAlert.service.js"]);
  });
});

describe("region isolation", () => {
  const twoRegionMap = () => {
    const jssate = JSON.parse(fs.readFileSync(path.join(context.root, "jssate-bengaluru-campus-osm.geojson")));
    const outline = jssate.features.find((f) => f.id === "way/106873634");
    const jssateCover = h3.polygonToCellsExperimental(outline.geometry.coordinates, 11, h3.POLYGON_TO_CELLS_FLAGS.containmentOverlapping, true);
    const rnsit = zoneMap.candidateSpatialMap(proposal, { regionId: REGION_ROW_ID });
    return {
      jssateCover,
      map: {
        regions: [{ id: REGION_ROW_ID }, { id: JSSATE_REGION_ROW_ID }],
        zones: [...rnsit.zones, { id: "jssate-z1", regionId: JSSATE_REGION_ROW_ID }],
        sites: [],
        cells: [...rnsit.cells, ...jssateCover.map((cellId) => ({ cellId, resolution: "FINE", regionId: JSSATE_REGION_ROW_ID, zoneId: "jssate-z1" }))],
      },
    };
  };

  test("the JSSATE campus cover shares no cell with the RNSIT cover", () => {
    expect(report.isolation.jssateCoverCells).toBeGreaterThan(0);
    expect(report.isolation.sharedCells).toEqual([]);
  });

  test("with JSSATE as a second region, every RNSIT cell keeps today's region and gets only its G4 zone", () => {
    const { map, jssateCover } = twoRegionMap();
    expect(hierarchy.validateForPublish(map)).toEqual({ ok: true, problems: [] });
    const index = hierarchy.indexMap(map);
    const today = hierarchy.indexMap(zoneMap.currentSpatialMap(context.cover, { regionId: REGION_ROW_ID }));
    for (const row of proposal.cells) {
      expect(index.resolve(row.cellId)).toMatchObject({ assigned: true, regionId: today.resolve(row.cellId).regionId, zoneId: row.zoneId });
    }
    for (const cellId of jssateCover) expect(index.resolve(cellId)).toMatchObject({ regionId: JSSATE_REGION_ROW_ID, zoneId: "jssate-z1" });
  });

  test("an obstacle on either campus resolves to its own region's room; the rooms never coincide", () => {
    const { map, jssateCover } = twoRegionMap();
    const snapshot = { spatial: map };
    expect(dtaroZoneAlert.resolvePoint(snapshot, ...h3.cellToLatLng(jssateCover[0]))).toMatchObject({ ok: true, regionId: JSSATE_REGION_ROW_ID });
    expect(dtaroZoneAlert.resolvePoint(snapshot, ...h3.cellToLatLng(zoneCells(SOUTH)[0]))).toMatchObject({ ok: true, regionId: REGION_ROW_ID, zoneId: SOUTH });
    const rooms = new Set([...ZONE_IDS.map((z) => dtaroZoneAlert.zoneRoom(REGION_ROW_ID, z)), dtaroZoneAlert.zoneRoom(JSSATE_REGION_ROW_ID, "jssate-z1")]);
    expect(rooms.size).toBe(ZONE_IDS.length + 1);
  });
});

describe("cross-zone obstacle awareness (offline model, robots observed along their routes)", () => {
  const cz = report.crossZone;

  test("today's single published zone warns every relevant robot", () => {
    expect(cz.PUBLISHED_SINGLE_ZONE.ZONE_ONLY.relevant).toBeGreaterThan(0);
    expect(cz.PUBLISHED_SINGLE_ZONE.ZONE_ONLY.missed).toBe(0);
  });

  test("under G4 the zone room alone misses robots whose remaining route enters another zone", () => {
    const t = cz.G4.ZONE_ONLY;
    expect(t.relevant).toBe(cz.PUBLISHED_SINGLE_ZONE.ZONE_ONLY.relevant);
    expect(Object.keys(t.missedBy)).toEqual(["ROBOT_IN_ANOTHER_ZONE"]);
    expect(cz.missedAcrossZones.reduce((a, m) => a + m.count, 0)).toBe(t.missed);
  });

  test("the adopted policy (zone room + remaining-route intersection) misses none, and the cross-zone warnings are exactly the zone-only misses", () => {
    const t = cz.G4.ZONE_PLUS_ROUTE;
    expect(t.missed).toBe(0);
    expect(t.delivered).toBe(t.relevant);
    expect(t.deliveredCrossZone).toBe(cz.G4.ZONE_ONLY.missed);
    expect(t.deliveredSameZone).toBe(cz.G4.ZONE_ONLY.deliveredSameZone);
  });

  test("cross-zone warnings go only to relevant robots: unnecessary warnings are the zone room's alone", () => {
    expect(cz.G4.ZONE_PLUS_ROUTE.unnecessary).toBe(cz.G4.ZONE_ONLY.unnecessary);
    expect(cz.G4.ZONE_PLUS_ROUTE.messages).toBeLessThan(cz.PUBLISHED_SINGLE_ZONE.ZONE_ONLY.messages);
  });
});

describe("the design claims the report makes, checked against the data", () => {
  const sharedBy = (cellId, ids) =>
    ids.every((id) => {
      const f = context.inputs.osm.features.find((row) => row.id === id);
      return h3.polygonToCellsExperimental(f.geometry.coordinates, 11, h3.POLYGON_TO_CELLS_FLAGS.containmentOverlapping, true).includes(cellId);
    });

  test("the East footprint chain: MBA·Mec&EEE, Mec&EEE·Basketball, Basketball·Main·Canara share cells, all one zone", () => {
    expect(sharedBy("8b6014512865fff", ["way/204638941", "way/204638943"])).toBe(true);
    expect(sharedBy("8b6014512860fff", ["way/204638941", "way/1224941277"])).toBe(true);
    expect(sharedBy("8b6014512863fff", ["way/1224941277", "way/204638937", "way/204638927"])).toBe(true);
    for (const cellId of ["8b6014512865fff", "8b6014512860fff", "8b6014512863fff"]) expect(rowOf(cellId).zoneId).toBe(EAST);
  });

  test("the south-west lobe hangs off a ~31 m neck, and every cell centred in it is South-west", () => {
    const ring = context.inputs.boundary.coordinates[0];
    const neck = cells.greatCircleMetres(ring[11][1], ring[11][0], ring[16][1], ring[16][0]);
    expect(neck).toBeGreaterThan(30);
    expect(neck).toBeLessThan(32);
    const lobe = ring.slice(11, 17).map(([lon, lat]) => ({ lat, lon }));
    const inLobe = proposal.cells.filter((row) => {
      const [lat, lon] = h3.cellToLatLng(row.cellId);
      return pointInPolygon({ lat, lon }, lobe);
    });
    expect(inLobe).toHaveLength(8);
    for (const row of inLobe) expect(row.zoneId).toBe(SOUTHWEST);
  });

  test("seed sensitivity: only T06 and T07 depend on the seeds, and under a variant they stay open — never another zone", () => {
    const changed = report.sensitivity.flatMap((s) => s.changed.map((c) => [s.policy, c.cellId, c.variant]));
    expect(changed).toEqual([
      ["NAMED_MEMBERS_ONLY", "8b60145104b3fff", null],
      ["ACCESS_POINTS_FIRST", "8b6014512841fff", null],
    ]);
    for (const [, cellId] of changed) expect(report.robustness[cellId].seedSensitive).toBe(true);
    for (const row of proposal.cells.filter((r) => r.decision && !["8b60145104b3fff", "8b6014512841fff"].includes(r.cellId))) {
      expect(report.robustness[row.cellId].seedSensitive).toBe(false);
    }
  });

  test("no Library or Playground outline exists, and none is drawn", () => {
    const byName = Object.fromEntries(report.facilities.map((f) => [f.facility, f]));
    expect(byName.Library.status).toMatch(/^MISSING/);
    expect(byName.Playground.found.every((r) => r.geometry === "POINT")).toBe(true);
    expect(geojson().features.filter((f) => /librar|playground/i.test(f.properties.label || "") && f.geometry.type !== "Point")).toEqual([]);
  });

  test("landmarks are display-only: no landmark carries a zone, and ownership comes only from cells", () => {
    const features = geojson().features;
    for (const f of features.filter((x) => ["LANDMARK", "VERIFIED_ACCESS_POINT"].includes(x.properties.role))) expect(f.properties.zoneId).toBeUndefined();
    expect(features.filter((f) => ["PROPOSED_CELL", "DECIDED_CELL"].includes(f.properties.role))).toHaveLength(64);
    expect(features.filter((f) => f.properties.role === "DECIDED_CELL")).toHaveLength(Object.keys(EXPECTED_DECISIONS).length);
  });
});
