"use strict";

/**
 * **RNSIT four-zone map — an OFFLINE, deterministic PROPOSAL generator.** Nothing more.
 *
 * Implements the cell-assignment method of
 * `docs/audits/dtaro-zone-coordination/RNSIT_ZONE_MAPPING_PROPOSAL.md` §5 for the candidate
 * layout L4 (§3.2). It reads repository files only. It does not touch a database, does not
 * publish, pin or mirror anything, and is imported by no runtime code.
 *
 * ── What it never does ──────────────────────────────────────────────────────
 *   · It never decides a tie. A cell equidistant (H3 grid distance) from the anchors of two or
 *     more zones stays `UNRESOLVED_TIE` with `zoneId: null` until an OWNER override names its
 *     zone, with `{ by, on, reason }`. No override exists in the repository today.
 *   · It never reports a map as approved. `approved` is always false here: approval is an owner
 *     act recorded outside this module, and the proposal's owner questions (Q1–Q12) stay listed.
 *   · It never adds or removes a cell. The input is exactly the D6 boundary-overlap cover the V1
 *     bootstrap publishes (64 FINE cells of the adopted `way/1120154292`); anything else refuses.
 *
 * ── Why a candidate spatial map can still be built ──────────────────────────
 * `candidateSpatialMap()` returns the payload shape `hierarchy.validateForPublish` and V8 read,
 * so a reviewer can run the engine's own validators against the proposal. It REFUSES while any
 * cell is unresolved: an unresolved cell would otherwise be published with no zone, which
 * `validateAssignment` reports as "a hole in the pricing surface". Building the shape is not a
 * publication; the region id it carries is supplied by the caller because the published map
 * names the database's `Region.id`, which differs per environment.
 *
 * Deterministic: no clock, no randomness. Cells, anchors and findings are in canonical order.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const h3 = require("h3-js");

const cells = require("../../src/engine/spatial/cells");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

/** The adopted RNSIT boundary (RD-2026-08-30-01), pinned by the same digest the V1 seed checks. */
const BOUNDARY_SHA256 = "04cb64c4205dc59462e149501fdd93b412106cfdc8d7249661bc8f3f47dc08b4";
const BOUNDARY_WAY = "way/1120154292";
/** D6's boundary-overlap cover; `bootstrapV1Environment.EXPECTED_COVER_CELLS` is the same figure. */
const EXPECTED_COVER_CELLS = 64;
/** The single zone every current map producer assigns the whole cover to. */
const CURRENT_ZONE_ID = "rnsit-z1";

/** How a cell got its zone (or did not). */
const BASIS = Object.freeze({
  ANCHOR: "ANCHOR",
  NEAREST: "NEAREST",
  OVERRIDE: "OWNER_OVERRIDE",
  UNRESOLVED_TIE: "UNRESOLVED_TIE",
});

const STATUS = Object.freeze({
  UNRESOLVED: "UNRESOLVED",
  RESOLVED_PENDING_OWNER_APPROVAL: "RESOLVED_PENDING_OWNER_APPROVAL",
});

/**
 * Candidate layout L4 (proposal §3.2). IDs and names are PROPOSALS (owner question Q2).
 * Each anchor names its evidence; `kind` says which file it is read from.
 */
const PROPOSED_ZONES = Object.freeze([
  {
    id: "rnsit-z2",
    name: "RNSIT West — CSE/ISE/CSDS, ECE, Civil & AIML, hostels",
    anchors: [
      { kind: "VERIFIED_ACCESS_POINTS", building: "CSE, ISE & CSDS Department" },
      { kind: "VERIFIED_ACCESS_POINTS", building: "ECE Department" },
      { kind: "VERIFIED_ACCESS_POINTS", building: "RNSIT Civil and AIML Block" },
    ],
  },
  {
    id: "rnsit-z3",
    name: "RNSIT North-east — Main Building, Canara Bank, Canteen (north)",
    anchors: [
      { kind: "SUPPLEMENTAL_POINT", id: "rnsit-canara-bank" },
      { kind: "OSM_FOOTPRINT", id: "way/204638928" },
      { kind: "OSM_FOOTPRINT", id: "way/204638937" },
    ],
  },
  {
    id: "rnsit-z4",
    name: "RNSIT East — Mechanical & EEE, MBA",
    anchors: [
      { kind: "VERIFIED_ACCESS_POINTS", building: "RNSIT Mec and EEE Department" },
      { kind: "VERIFIED_ACCESS_POINTS", building: "RNSIT MBA block" },
    ],
  },
  {
    id: "rnsit-z5",
    name: "RNSIT South — Auditorium, Innovation Center, PU College, Canteen (south)",
    anchors: [
      { kind: "SUPPLEMENTAL_POINT", id: "rnsit-innovation-center" },
      { kind: "SUPPLEMENTAL_POINT", id: "rnsit-pre-university-college" },
      { kind: "SUPPLEMENTAL_POINT", id: "rnsit-food-court" },
      { kind: "OSM_FOOTPRINT", id: "way/1224937859" },
    ],
  },
]);

/** Proposal §8. Listed so no output of this module can be read as "nothing is outstanding". */
const OUTSTANDING_OWNER_DECISIONS = Object.freeze([
  "Q1 layout (L2 / L4 / L6)",
  "Q2 zone ids and the fate of rnsit-z1",
  "Q3 ownership of tied cells, pitch cells, Basketball Court, International School, Playground 2",
  "Q4 Library location",
  "Q5 which Canteen",
  "Q6 which Playground",
  "Q7 PU College point",
  "Q8 Canara Bank location",
  "Q9 boundary-cell rule",
  "Q10 Zone row bounding-box policy",
  "Q11 publication vehicle and approvers",
  "Q12 V1 freeze scope and target environment",
]);

/* ═══════════════════════════════════════════════════════════════════════════
   Inputs
   ═══════════════════════════════════════════════════════════════════════════ */

function readJson(file) {
  return JSON.parse(fs.readFileSync(file));
}

/**
 * The repository's RNSIT campus data, digest-checked.
 *
 * @param {string} [root] repository root
 * @returns {{ osm: object, boundary: object, supplemental: object, access: object }}
 */
function loadInputs(root = REPO_ROOT) {
  const raw = fs.readFileSync(path.join(root, "rnsit-campus-osm.geojson"));
  const digest = crypto.createHash("sha256").update(raw).digest("hex");
  if (digest !== BOUNDARY_SHA256) {
    throw new Error(`the RNSIT OSM extract digest is ${digest}, not the adopted ${BOUNDARY_SHA256}`);
  }
  const osm = JSON.parse(raw);
  const boundaryFeature = osm.features.find((feature) => feature.id === BOUNDARY_WAY);
  if (!boundaryFeature) throw new Error(`the RNSIT extract has no ${BOUNDARY_WAY}`);
  return {
    osm,
    boundary: boundaryFeature.geometry,
    supplemental: readJson(path.join(root, "rnsit-campus-supplemental.geojson")),
    access: readJson(path.join(root, "rnsit-campus-access-candidates.geojson")),
  };
}

const FINE = cells.H3_RESOLUTION.FINE;
const overlapCells = (coordinates) =>
  h3.polygonToCellsExperimental(coordinates, FINE, h3.POLYGON_TO_CELLS_FLAGS.containmentOverlapping, true);
const pointCell = ([lon, lat]) => cells.cellForPoint(lat, lon, cells.RESOLUTION.FINE);

/**
 * The D6 index cover and its centre-contained subset. Refuses unless it is the adopted 64.
 *
 * @param {object} boundary GeoJSON Polygon
 * @returns {{ cover: string[], centreContained: Set<string> }}
 */
function coverOf(boundary) {
  // `polygonToCellsExperimental` — the 3-argument `polygonToCells` silently ignores a flags
  // argument and returns the centre cover (spatial memory, D6).
  const cover = cells.canonicalCellOrder(overlapCells(boundary.coordinates));
  if (cover.length !== EXPECTED_COVER_CELLS) {
    throw new Error(`the boundary cover has ${cover.length} FINE cells, not the adopted ${EXPECTED_COVER_CELLS}`);
  }
  return { cover, centreContained: new Set(h3.polygonToCells(boundary.coordinates, FINE, true)) };
}

/**
 * Resolve each zone's anchors to cover cells, with the evidence each came from.
 *
 * @returns {Map<string, { cellId: string, evidence: string }[]>}
 */
function anchorCells(inputs, cover) {
  const inCover = new Set(cover);
  const out = new Map();
  for (const zone of PROPOSED_ZONES) {
    const found = [];
    for (const anchor of zone.anchors) {
      let pairs;
      if (anchor.kind === "VERIFIED_ACCESS_POINTS") {
        const rows = inputs.access.features.filter(
          (feature) => feature.properties.buildingName === anchor.building && feature.properties.status === "verified",
        );
        if (rows.length === 0) throw new Error(`no verified access point for "${anchor.building}"`);
        pairs = rows.map((feature) => [pointCell(feature.geometry.coordinates), `access:${feature.properties.id}`]);
      } else if (anchor.kind === "SUPPLEMENTAL_POINT") {
        const feature = inputs.supplemental.features.find((row) => row.properties.id === anchor.id);
        if (!feature) throw new Error(`no supplemental point "${anchor.id}"`);
        pairs = [[pointCell(feature.geometry.coordinates), `supplemental:${anchor.id}`]];
      } else if (anchor.kind === "OSM_FOOTPRINT") {
        const feature = inputs.osm.features.find((row) => row.id === anchor.id);
        if (!feature) throw new Error(`no OSM footprint "${anchor.id}"`);
        pairs = overlapCells(feature.geometry.coordinates).map((cellId) => [cellId, `osm:${anchor.id}`]);
      } else {
        throw new Error(`unknown anchor kind "${anchor.kind}"`);
      }
      for (const [cellId, evidence] of pairs) {
        if (!inCover.has(cellId)) throw new Error(`anchor ${evidence} lies in ${cellId}, outside the cover`);
        found.push({ cellId, evidence });
      }
    }
    found.sort((a, b) => cells.compareCellIds(a.cellId, b.cellId) || (a.evidence < b.evidence ? -1 : a.evidence > b.evidence ? 1 : 0));
    out.set(zone.id, found);
  }
  return out;
}

/**
 * An owner override is honoured only when it is complete; a partial one refuses rather than
 * being half-applied.
 */
function validateOverrides(overrides, cover) {
  const inCover = new Set(cover);
  const zoneIds = new Set(PROPOSED_ZONES.map((zone) => zone.id));
  for (const [cellId, entry] of Object.entries(overrides || {})) {
    if (!inCover.has(cellId)) throw new Error(`override names ${cellId}, which is not a cover cell`);
    if (!entry || !zoneIds.has(entry.zoneId)) throw new Error(`override for ${cellId} names no proposed zone`);
    for (const field of ["by", "on", "reason"]) {
      if (typeof entry[field] !== "string" || entry[field].trim() === "") {
        throw new Error(`override for ${cellId} has no "${field}"; an owner override records who, when and why`);
      }
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.on)) throw new Error(`override for ${cellId}: "on" must be YYYY-MM-DD`);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   The proposal
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Apply §5 steps 1–4.
 *
 * @param {{ inputs?: object, overrides?: Record<string, { zoneId: string, by: string, on: string, reason: string }> }} [options]
 * @returns {object} the proposal; `approved` is always false
 */
function buildProposal(options = {}) {
  const inputs = options.inputs || loadInputs();
  const overrides = options.overrides || {};
  const { cover, centreContained } = coverOf(inputs.boundary);
  validateOverrides(overrides, cover);
  const anchors = anchorCells(inputs, cover);

  const anchorOwner = new Map();
  const anchorConflicts = [];
  for (const [zoneId, list] of anchors.entries()) {
    for (const { cellId } of list) {
      if (anchorOwner.has(cellId) && anchorOwner.get(cellId) !== zoneId) anchorConflicts.push(cellId);
      else anchorOwner.set(cellId, zoneId);
    }
  }

  const rows = cover.map((cellId) => {
    const distances = {};
    for (const [zoneId, list] of anchors.entries()) {
      distances[zoneId] = Math.min(...list.map((anchor) => cells.gridDistanceBetween(cellId, anchor.cellId)));
    }
    const best = Math.min(...Object.values(distances));
    const nearest = Object.keys(distances).filter((zoneId) => distances[zoneId] === best).sort();
    const row = { cellId, centreInBoundary: centreContained.has(cellId), distances, nearest, zoneId: null, basis: null };
    if (overrides[cellId]) {
      return { ...row, zoneId: overrides[cellId].zoneId, basis: BASIS.OVERRIDE, override: { ...overrides[cellId] } };
    }
    if (nearest.length === 1) return { ...row, zoneId: nearest[0], basis: best === 0 ? BASIS.ANCHOR : BASIS.NEAREST };
    return { ...row, basis: BASIS.UNRESOLVED_TIE };
  });

  const unresolved = rows.filter((row) => row.zoneId === null).map((row) => row.cellId);
  return {
    layout: "L4",
    approved: false,
    status: unresolved.length > 0 || anchorConflicts.length > 0 ? STATUS.UNRESOLVED : STATUS.RESOLVED_PENDING_OWNER_APPROVAL,
    boundary: { way: BOUNDARY_WAY, sha256: BOUNDARY_SHA256 },
    zones: PROPOSED_ZONES.map((zone) => ({ id: zone.id, name: zone.name, anchors: anchors.get(zone.id) })),
    anchorConflicts: cells.canonicalCellOrder([...new Set(anchorConflicts)]),
    cells: rows,
    unresolved,
    outstandingOwnerDecisions: [...OUTSTANDING_OWNER_DECISIONS],
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   Checks (§5 steps 5–6)
   ═══════════════════════════════════════════════════════════════════════════ */

/** Connected components of a cell set under H3 adjacency (`gridDisk(k=1)`). */
function components(cellIds) {
  const remaining = new Set(cellIds);
  const out = [];
  for (const start of cells.canonicalCellOrder(cellIds)) {
    if (!remaining.has(start)) continue;
    remaining.delete(start);
    const component = [start];
    for (let i = 0; i < component.length; i += 1) {
      for (const neighbour of cells.diskAround(component[i], 1)) {
        if (remaining.has(neighbour)) {
          remaining.delete(neighbour);
          component.push(neighbour);
        }
      }
    }
    out.push(cells.canonicalCellOrder(component));
  }
  return out;
}

/**
 * Structural findings. `complete` is true only when every cover cell has exactly one zone,
 * every zone is non-empty and contiguous, and no anchor is claimed twice. A complete proposal
 * is still NOT approved.
 *
 * @param {object} proposal from `buildProposal`
 * @param {{ cover?: string[] }} [options] the expected cover; defaults to the repository's
 * @returns {{ complete: boolean, findings: { id: string, message: string }[], zoneCells: Record<string, string[]>, zoneComponents: Record<string, number> }}
 */
function checkProposal(proposal, options = {}) {
  const expected = options.cover || coverOf(loadInputs().boundary).cover;
  const findings = [];
  const seen = new Map();
  for (const row of proposal.cells) seen.set(row.cellId, (seen.get(row.cellId) || 0) + 1);
  const duplicates = [...seen.entries()].filter(([, count]) => count > 1).map(([cellId]) => cellId);
  const missing = expected.filter((cellId) => !seen.has(cellId));
  const extra = [...seen.keys()].filter((cellId) => !expected.includes(cellId));
  if (duplicates.length) findings.push({ id: "DUPLICATE_CELL", message: `cells listed more than once: ${duplicates.join(", ")}` });
  if (missing.length) findings.push({ id: "MISSING_CELL", message: `cover cells absent: ${missing.join(", ")}` });
  if (extra.length) findings.push({ id: "EXTRA_CELL", message: `cells outside the cover: ${extra.join(", ")}` });
  if (proposal.anchorConflicts.length) {
    findings.push({ id: "ANCHOR_CONFLICT", message: `anchor cells claimed by two zones: ${proposal.anchorConflicts.join(", ")}` });
  }
  const unresolved = proposal.cells.filter((row) => row.zoneId === null);
  if (unresolved.length) {
    findings.push({
      id: "UNRESOLVED_CELLS",
      message:
        `${unresolved.length} cell(s) have no zone and need an owner decision (proposal Q3): ` +
        unresolved.map((row) => `${row.cellId} [${row.nearest.join(" | ")}]`).join(", "),
    });
  }

  const zoneCells = {};
  const zoneComponents = {};
  for (const zone of proposal.zones) {
    zoneCells[zone.id] = cells.canonicalCellOrder(proposal.cells.filter((row) => row.zoneId === zone.id).map((row) => row.cellId));
    zoneComponents[zone.id] = components(zoneCells[zone.id]).length;
    if (zoneCells[zone.id].length === 0) findings.push({ id: "EMPTY_ZONE", message: `zone ${zone.id} has no cells` });
    else if (zoneComponents[zone.id] > 1) {
      findings.push({ id: "DISCONNECTED_ZONE", message: `zone ${zone.id} is in ${zoneComponents[zone.id]} disconnected parts` });
    }
  }
  return { complete: findings.length === 0, findings, zoneCells, zoneComponents };
}

/**
 * The zones each permitted way passes through, in order — the input to §5 step 6. Reported, not
 * judged: no threshold for "too many transitions" is declared anywhere.
 *
 * The permitted road classes are read from the access register's own validation record (the
 * classes its candidates were validated against), and must agree across the register.
 *
 * @param {object} proposal
 * @param {{ inputs?: object, sampleM?: number }} [options]
 * @returns {{ roadClasses: string[], ways: { id: string, highway: string, zones: string[], transitions: number, unresolvedCells: number, outsideCover: number }[] }}
 */
function pathTransitions(proposal, options = {}) {
  const inputs = options.inputs || loadInputs();
  // @structural sampling step finer than half a res-11 cell edge, so no crossed cell is skipped
  const sampleM = options.sampleM || 2;
  const classSets = new Set(
    inputs.access.features.map((feature) => JSON.stringify([...feature.properties.validation.roadClasses].sort())),
  );
  if (classSets.size !== 1) throw new Error("the access register's road classes disagree between entries");
  const roadClasses = JSON.parse([...classSets][0]);

  const zoneOf = new Map(proposal.cells.map((row) => [row.cellId, row.zoneId === null ? BASIS.UNRESOLVED_TIE : row.zoneId]));
  const ways = [];
  for (const feature of inputs.osm.features) {
    const highway = feature.properties && feature.properties.highway;
    if (!highway || !roadClasses.includes(highway) || feature.geometry.type !== "LineString") continue;
    const sequence = [];
    let unresolvedCells = 0;
    let outsideCover = 0;
    const visited = new Set();
    const points = feature.geometry.coordinates;
    for (let i = 1; i < points.length; i += 1) {
      const [lon0, lat0] = points[i - 1];
      const [lon1, lat1] = points[i];
      const steps = Math.max(1, Math.ceil(cells.greatCircleMetres(lat0, lon0, lat1, lon1) / sampleM));
      for (let k = 0; k <= steps; k += 1) {
        const t = k / steps;
        const cellId = cells.cellForPoint(lat0 + (lat1 - lat0) * t, lon0 + (lon1 - lon0) * t, cells.RESOLUTION.FINE);
        const label = zoneOf.has(cellId) ? zoneOf.get(cellId) : "OUTSIDE_COVER";
        if (!visited.has(cellId)) {
          visited.add(cellId);
          if (label === BASIS.UNRESOLVED_TIE) unresolvedCells += 1;
          if (label === "OUTSIDE_COVER") outsideCover += 1;
        }
        if (sequence[sequence.length - 1] !== label) sequence.push(label);
      }
    }
    ways.push({ id: feature.id, highway, zones: sequence, transitions: sequence.length - 1, unresolvedCells, outsideCover });
  }
  ways.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { roadClasses, ways };
}

/* ═══════════════════════════════════════════════════════════════════════════
   Candidate payload shapes — for validation only, never published from here
   ═══════════════════════════════════════════════════════════════════════════ */

class ZoneMapIncompleteError extends Error {
  constructor(unresolved) {
    super(
      `the zone map is incomplete: ${unresolved.length} cell(s) have no owner-decided zone ` +
        `(${unresolved.join(", ")}). Final ownership is an owner decision (proposal Q3); ` +
        "no candidate spatial map is built from an incomplete proposal",
    );
    this.name = "ZoneMapIncompleteError";
    this.unresolved = unresolved;
  }
}

/**
 * The spatial payload shape (`hierarchy.toConfigPayload` input) for the proposal. Refuses while
 * any cell is unresolved.
 *
 * @param {object} proposal
 * @param {{ regionId: string }} options the target database's `Region.id`
 * @returns {{ regions: object[], zones: object[], sites: object[], cells: object[] }}
 */
function candidateSpatialMap(proposal, { regionId }) {
  if (typeof regionId !== "string" || regionId === "") throw new Error("candidateSpatialMap needs the target Region.id");
  if (proposal.unresolved.length > 0) throw new ZoneMapIncompleteError(proposal.unresolved);
  return {
    regions: [{ id: regionId }],
    zones: proposal.zones.map((zone) => ({ id: zone.id, regionId })),
    sites: [],
    cells: proposal.cells.map((row) => ({ cellId: row.cellId, resolution: cells.RESOLUTION.FINE, regionId, zoneId: row.zoneId })),
  };
}

/**
 * Today's map, as `bootstrapV1Environment.publishRequest` builds it: every cover cell in
 * `rnsit-z1`. The baseline for "region resolution is unchanged".
 */
function currentSpatialMap(cover, { regionId }) {
  return {
    regions: [{ id: regionId }],
    zones: [{ id: CURRENT_ZONE_ID, regionId }],
    sites: [],
    cells: cover.map((cellId) => ({ cellId, resolution: cells.RESOLUTION.FINE, regionId, zoneId: CURRENT_ZONE_ID })),
  };
}

module.exports = {
  BASIS,
  STATUS,
  PROPOSED_ZONES,
  OUTSTANDING_OWNER_DECISIONS,
  EXPECTED_COVER_CELLS,
  CURRENT_ZONE_ID,
  ZoneMapIncompleteError,
  loadInputs,
  coverOf,
  buildProposal,
  checkProposal,
  pathTransitions,
  candidateSpatialMap,
  currentSpatialMap,
};

// Prints the proposal and its checks to stdout. Writes no file.
if (require.main === module) {
  const proposal = buildProposal();
  const check = checkProposal(proposal);
  process.stdout.write(
    `${JSON.stringify({ proposal, check, transitions: pathTransitions(proposal) }, null, 2)}\n`,
  );
  process.exit(0);
}
