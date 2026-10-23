#!/usr/bin/env node
"use strict";

/**
 * **RNSIT four-zone layout G4 — an OFFLINE, geometry-led zoning PROPOSAL.** Nothing more.
 *
 *   node tools/campus/rnsitZoneLayoutG4.js            # summary JSON on stdout; writes nothing
 *   node tools/campus/rnsitZoneLayoutG4.js --write    # writes the three review files (below)
 *   node tools/campus/rnsitZoneLayoutG4.js --check    # exit 1 if any review file is stale
 *
 * Review files, all under `docs/audits/dtaro-zone-coordination/`:
 *   · `rnsit-zone-proposal-g4.geojson`        perimeter, zones, every cell, landmarks
 *   · `rnsit-zone-proposal-g4-preview.html`   self-contained offline map (no network, no tiles)
 *   · `RNSIT_ZONE_LAYOUT_G4_EVIDENCE.md`      generated tables: zones, cells, ties, checks
 *
 * Read with `RNSIT_ZONE_LAYOUT_G4_PROPOSAL.md` in the same directory. The earlier candidate L4
 * (`rnsitZoneMap.js`) seeded four zones by nearest anchor in H3 grid steps. G4 keeps L4's inputs,
 * cover, tie rule and validators and changes how a cell is given a zone:
 *
 *   1. PINNED TIES. The 14 cells L4 left tied stay UNRESOLVED here, whatever G4's own instruments
 *      say. They are read live from `rnsitZoneMap.buildProposal()`, never copied. Only an owner
 *      override `{ zoneId, by, on, reason }` gives one a zone; none exists in the repository.
 *   2. FOOTPRINT. Each zone names its member footprints (OSM buildings and facilities). A cell
 *      goes to the zone whose members cover most of the cell's in-boundary area, measured on the
 *      cell's resolution-14 children (343 per cell). An exact draw is a FOOTPRINT_CONFLICT and
 *      stays unresolved.
 *   3. NETWORK. A cell no member footprint touches goes to the zone with the shortest walk over
 *      the boundary-contained campus network (`campusTraversalNetwork` with the physical
 *      router's `routeContainment`) from the cell's in-boundary representative point to any of
 *      the zone's seeds (its verified access points and its members' area centroids). An exact
 *      draw is a NETWORK_TIE and stays unresolved.
 *
 * Every cell also records the instrument it was NOT decided by, and review flags where the two
 * disagree or a margin is thin. Flags never change ownership.
 *
 * ── What it never does ──────────────────────────────────────────────────────
 *   · It never publishes, pins, writes a row or opens a connection, and no runtime code imports
 *     it. `approved` and `published` are always false.
 *   · It never changes the perimeter: the boundary and the 64-cell cover come from
 *     `rnsitZoneMap.loadInputs`/`coverOf`, which refuse anything but the adopted digest and 64.
 *   · It never uses an UNVERIFIED user-supplied point as a seed, and never draws an outline that
 *     the data lacks (there is no Library and no Playground polygon). Points are landmarks only.
 *   · It never changes live alert routing. `crossZoneDelivery` MODELS today's delivery rule
 *     (`dtaroZoneAlert.resolvePoint` + the zone room of the robot's position) against this map,
 *     offline, to show what publishing it would do.
 *
 * Deterministic: no clock, no randomness; canonical cell order; ties in sorting by id.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const h3 = require("h3-js");

const zoneMap = require("./rnsitZoneMap");
const cells = require("../../src/engine/spatial/cells");
const campusTraversalNetwork = require("../../src/simulation/campusTraversalNetwork");
const { createRouteContainment } = require("../../src/services/fleetProviders/routeContainment");
const { pointInPolygon, pathIntersectsPolygon } = require("../../src/services/routeIntersection.service");
const bootstrap = require("../deploy/bootstrapV1Environment");
const hierarchy = require("../../src/engine/spatial/hierarchy");
const validators = require("../../src/engine/config/validators");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const OUTPUT_DIR = path.join(REPO_ROOT, "docs", "audits", "dtaro-zone-coordination");
const OUTPUT_FILES = Object.freeze({
  geojson: "rnsit-zone-proposal-g4.geojson",
  preview: "rnsit-zone-proposal-g4-preview.html",
  evidence: "RNSIT_ZONE_LAYOUT_G4_EVIDENCE.md",
});

const LAYOUT = "G4";
/** RD-2026-08-30-01: the adopted RNSIT extract (the same digest `rnsitZoneMap.loadInputs` enforces). */
const ADOPTED_BOUNDARY_SHA256 = "04cb64c4205dc59462e149501fdd93b412106cfdc8d7249661bc8f3f47dc08b4";
/** L4's tied cells; G4 keeps every one of them open. */
const EXPECTED_PINNED_TIES = 14;
/** @structural H3 children of a res-11 cell at res 14: 343 points, about 6.3 m² each */
const SAMPLE_RESOLUTION = 14;
/** The JSSATE campus outline in its extract: the other region, used only to prove disjointness. */
const JSSATE_EXTRACT = "jssate-bengaluru-campus-osm.geojson";
const JSSATE_BOUNDARY_WAY = "way/106873634";

const BASIS = Object.freeze({
  FOOTPRINT: "FOOTPRINT",
  NETWORK: "NETWORK",
  OVERRIDE: "OWNER_OVERRIDE",
  UNRESOLVED_TIE: "UNRESOLVED_TIE",
  FOOTPRINT_CONFLICT: "FOOTPRINT_CONFLICT",
  NETWORK_TIE: "NETWORK_TIE",
  NO_INSIDE_SAMPLE: "NO_INSIDE_SAMPLE",
  /** A pinned tie given a zone by decision rule R1, R2 or R4 (`applyDecisions`). */
  EVIDENCE_DECISION: "EVIDENCE_DECISION",
  /** A cell moved (or an open cell given a zone) by R3 to join a zone's split walk network. */
  CONNECTIVITY_REPAIR: "CONNECTIVITY_REPAIR",
});

/**
 * The decision rules the owner's design directive of 2026-10-23 authorises ("use documented
 * geometry and connectivity evidence"). They are applied in this order, deterministically, and
 * each decision records its rule, its evidence and a confidence. A decision is a JUSTIFIED
 * ASSIGNMENT, not an owner approval: the proposal stays `approved: false`.
 */
const RULE = Object.freeze({
  R1_SINGLE_NEIGHBOUR: "R1_SINGLE_NEIGHBOUR",
  R2_INSTRUMENTS_AGREE: "R2_INSTRUMENTS_AGREE",
  R3_CONNECTIVITY_REPAIR: "R3_CONNECTIVITY_REPAIR",
  R4_ONLY_CONNECTED_OPTION: "R4_ONLY_CONNECTED_OPTION",
});
const DECISION_AUTHORITY = "Owner design directive 2026-10-23 (G4 rules R1–R4); evidence-based, not owner-approved per cell";

/** The two stages of the proposal. A third state — published — is the pinned map, never this. */
const STAGE = Object.freeze({ GENERATED: "GENERATED", DECIDED: "DECIDED" });

/** Review flags: they direct a reviewer's attention and never change a cell's zone. */
const FLAG = Object.freeze({
  BOUNDARY_CELL: "BOUNDARY_CELL",
  LOW_FOOTPRINT_SHARE: "LOW_FOOTPRINT_SHARE",
  LOW_NETWORK_MARGIN: "LOW_NETWORK_MARGIN",
  INSTRUMENTS_DISAGREE: "INSTRUMENTS_DISAGREE",
});
/** @structural review-flag thresholds only: 5 % of the cell's inside area; one mean res-11 edge */
const REVIEW_THRESHOLDS = Object.freeze({
  lowFootprintShare: 0.05,
  lowNetworkMarginM: Math.round(h3.getHexagonEdgeLengthAvg(11, h3.UNITS.m) * 10) / 10,
});

const STATUS = zoneMap.STATUS;

/**
 * The proposed zones. IDs and names are PROPOSALS (owner question Q2); they deliberately do not
 * reuse L4's `rnsit-z2…z5`, which name different areas, or the published `rnsit-z1`.
 *
 * `members` are OSM footprints whose area decides cells (stage 2) and whose area centroids are
 * network seeds (stage 3). `accessBuildings` names buildings whose VERIFIED access points are
 * also seeds. Nothing else is a seed.
 */
const PROPOSED_ZONES = Object.freeze([
  {
    id: "rnsit-z-west",
    name: "RNSIT West — CSE/ISE/CSDS, ECE, Civil & AIML, hostels",
    members: [
      ["way/204638929", "CSE, ISE & CSDS Department"],
      ["way/204638932", "ECE Department"],
      ["way/1486312656", "RNSIT Civil and AIML Block"],
      ["way/204638935", "Hostel (north, beside ECE)"],
      ["way/204638934", "Hostel (west, beside Civil & AIML)"],
      ["way/204638936", "Hostel (dormitory, west of the sports ground)"],
    ],
    accessBuildings: ["CSE, ISE & CSDS Department", "ECE Department", "RNSIT Civil and AIML Block"],
  },
  {
    id: "rnsit-z-east",
    name: "RNSIT East — Main Building, Canara Bank, Canteen (north), Basketball Court, Mec & EEE, MBA",
    members: [
      ["way/204638937", "Main Building"],
      ["way/204638927", "Canara Bank (OSM building)"],
      ["way/204638928", "Canteen (north, food court)"],
      ["way/1224941277", "Basketball Court"],
      ["way/204638940", "Theatre (OSM amenity, unnamed)"],
      ["way/204638939", "Toilets (OSM amenity)"],
      ["way/204638954", "Parking (OSM amenity)"],
      ["way/204638955", "Parking (OSM amenity)"],
      ["way/204638941", "RNSIT Mec and EEE Department"],
      ["way/204638943", "RNSIT MBA block"],
    ],
    accessBuildings: ["RNSIT Mec and EEE Department", "RNSIT MBA block"],
  },
  {
    id: "rnsit-z-south",
    name: "RNSIT South — Auditorium, Canteen (south), Shiva Temple",
    members: [
      ["way/1224937859", "RNSIT auditorium"],
      ["way/1486312655", "Canteen (south, cafeteria, level −1)"],
      ["way/204638938", "Shiva Temple"],
      ["way/1224937858", "RN Shetty Statue"],
      ["way/1486312654", "Motorcycle parking (OSM amenity)"],
    ],
    accessBuildings: [],
  },
  {
    id: "rnsit-z-southwest",
    name: "RNSIT South-west — RNS International School and the south-west lobe",
    members: [["way/1224941276", "RNS International School"]],
    accessBuildings: ["RNS International School"],
  },
]);

/**
 * Why each zone line is where it is (report text; the generator does not read it). Each claim
 * is checked by a test against the generated data.
 */
const BOUNDARY_RATIONALE = Object.freeze({
  "rnsit-z-west|rnsit-z-east":
    "North of the sports ground the ECE block meets the Main Building in cell 8b601451286afff, which the Main Building covers ~10× more than ECE; the line follows the north–south service ways 1510483621/1539965405 west of the Main Building.",
  "rnsit-z-east|rnsit-z-south":
    "Along the spine way/204638949 south of the MBA block: MBA's footprint and verified access points stay east, the Auditorium and the cells around PU College's point stay south.",
  "rnsit-z-south|rnsit-z-southwest":
    "Along the north–south service way/1539965404 that fronts the International School, then through the junction cell where it meets the south road; west of it lies the lobe behind the 31 m boundary neck.",
  "rnsit-z-west|rnsit-z-southwest":
    "Between the hostel cluster and the International School; the two cells in between (8b601451049bfff, 8b6014512b26fff) are pinned L4 ties.",
  "rnsit-z-west|rnsit-z-south":
    "Across the dormitory hostel's south end and the sports ground's west edge; every cell on this line except 8b601451049efff (Canteen south) is a pinned L4 tie.",
});

/** Owner questions the earlier proposal listed, plus G4's own. */
const OUTSTANDING_OWNER_DECISIONS = Object.freeze([
  ...zoneMap.OUTSTANDING_OWNER_DECISIONS,
  "G4-1 approve the validated G4 layout (four zones: West, East, South, South-west) as the replacement for rnsit-z1",
  "G4-2 approve the R1–R4 decisions; three are LOW confidence (T03, T04 and the repaired Main Building cell C1)",
  "G4-3 site survey for T03 (First Grade College, Evening College, Cyber Security points share one cell)",
  "G4-4 wire the adopted cross-zone policy: needs a server-side source of each robot's remaining commanded route",
  "G4-5 approve the simulated-route containment correction (changes commanded routes; V1 freeze)",
  "G4-6 OD-3: authorise an engine REROUTE producer and corridor versioning before any automatic reroute",
]);

/* ═══════════════════════════════════════════════════════════════════════════
   Geometry helpers
   ═══════════════════════════════════════════════════════════════════════════ */

const ringOf = (feature) => feature.geometry.coordinates[0].map(([lon, lat]) => ({ lat, lon }));

/** Area centroid, computed in a frame translated to the ring's first vertex (raw lon/lat cancels). */
function areaCentroid(feature) {
  const ring = feature.geometry.coordinates[0];
  const [ox, oy] = ring[0];
  let twiceArea = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 1; i < ring.length; i += 1) {
    const x0 = ring[i - 1][0] - ox;
    const y0 = ring[i - 1][1] - oy;
    const x1 = ring[i][0] - ox;
    const y1 = ring[i][1] - oy;
    const cross = x0 * y1 - x1 * y0;
    twiceArea += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  return { lat: oy + cy / (3 * twiceArea), lon: ox + cx / (3 * twiceArea) };
}

/** A local metric frame (equirectangular about a centre) for areas, perimeters and the preview. */
function localFrame(centreLat, centreLon) {
  const kx = (Math.PI / 180) * 6371000 * Math.cos((centreLat * Math.PI) / 180);
  const ky = (Math.PI / 180) * 6371000;
  return { x: (lon) => (lon - centreLon) * kx, y: (lat) => (lat - centreLat) * ky };
}

/** Area and perimeter (m², m) of a GeoJSON MultiPolygon coordinate array, holes included. */
function areaAndPerimeter(multi, frame) {
  let area = 0;
  let perimeter = 0;
  for (const polygon of multi) {
    polygon.forEach((ring, index) => {
      let twice = 0;
      for (let i = 1; i < ring.length; i += 1) {
        const x0 = frame.x(ring[i - 1][0]);
        const y0 = frame.y(ring[i - 1][1]);
        const x1 = frame.x(ring[i][0]);
        const y1 = frame.y(ring[i][1]);
        twice += x0 * y1 - x1 * y0;
        perimeter += Math.hypot(x1 - x0, y1 - y0);
      }
      area += (index === 0 ? 1 : -1) * Math.abs(twice / 2);
    });
  }
  return { area, perimeter };
}

const round1 = (value) => Math.round(value * 10) / 10;
const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/* ═══════════════════════════════════════════════════════════════════════════
   Inputs
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * The L4 inputs plus what G4 adds: the operating-boundary declaration the V1 bootstrap derives
 * (offline), its containment test, the contained campus network, and the L4 tie set.
 */
function loadContext(root = REPO_ROOT) {
  const inputs = zoneMap.loadInputs(root);
  const { cover, centreContained } = zoneMap.coverOf(inputs.boundary);
  const world = bootstrap.intendedWorld();
  if (JSON.stringify(world.declaration.boundary.coordinates) !== JSON.stringify(inputs.boundary.coordinates)) {
    throw new Error("the V1 operating-boundary declaration is not the adopted way/1120154292 geometry");
  }
  const containment = createRouteContainment(world.declaration);
  const roadClasses = roadClassesOf(inputs);
  const network = campusTraversalNetwork.createCampusTraversalNetwork({
    features: inputs.osm.features,
    roadClasses,
    containment,
    source: "rnsit-campus-osm.geojson",
  });
  if (network.componentCount !== 1) {
    throw new Error(`the contained RNSIT network has ${network.componentCount} components; distances would be undefined`);
  }
  const l4 = zoneMap.buildProposal({ inputs });
  if (l4.unresolved.length !== EXPECTED_PINNED_TIES) {
    throw new Error(`L4 now leaves ${l4.unresolved.length} cells tied, not the ${EXPECTED_PINNED_TIES} G4 was reviewed against`);
  }
  return { root, inputs, cover, centreContained, world, containment, roadClasses, network, l4 };
}

/** The permitted road classes, read from the access register exactly as `pathTransitions` does. */
function roadClassesOf(inputs) {
  const sets = new Set(inputs.access.features.map((feature) => JSON.stringify([...feature.properties.validation.roadClasses].sort())));
  if (sets.size !== 1) throw new Error("the access register's road classes disagree between entries");
  return JSON.parse([...sets][0]);
}

function osmFeature(inputs, id) {
  const feature = inputs.osm.features.find((row) => row.id === id);
  if (!feature || feature.geometry.type !== "Polygon") throw new Error(`no OSM footprint "${id}"`);
  return feature;
}

/**
 * Seed policies. BASELINE is the proposal; the others exist only for `seedSensitivity`, which
 * reports which cells would change owner under each, so a reviewer can see how much a boundary
 * depends on the choice of seeds.
 */
const SEED_POLICY = Object.freeze({
  BASELINE: "BASELINE",
  /** Footprint centroids of NAMED members only (drops toilets, parking, theatre, motorcycle parking). */
  NAMED_MEMBERS_ONLY: "NAMED_MEMBERS_ONLY",
  /** Verified access points only; a zone without one keeps its centroids. */
  ACCESS_POINTS_FIRST: "ACCESS_POINTS_FIRST",
  /** BASELINE plus the UNVERIFIED user-supplied points whose area is not in doubt. */
  WITH_UNVERIFIED_POINTS: "WITH_UNVERIFIED_POINTS",
});

/**
 * Unverified points and the zone each sits in, used ONLY by the WITH_UNVERIFIED_POINTS
 * sensitivity run. The three co-located college/department points (one cell, T03) are left out:
 * which area they belong to is itself an open question.
 */
const SENSITIVITY_POINTS = Object.freeze({
  "rnsit-innovation-center": "rnsit-z-south",
  "rnsit-pre-university-college": "rnsit-z-south",
  "rnsit-food-court": "rnsit-z-south",
  "rnsit-canara-bank": "rnsit-z-east",
  "rnsit-playground-2": "rnsit-z-southwest",
});

/** Each zone's member rings and seeds, every seed strictly inside the operating boundary. */
function zoneEvidence(context, seedPolicy = SEED_POLICY.BASELINE) {
  const { inputs, containment } = context;
  if (!Object.values(SEED_POLICY).includes(seedPolicy)) throw new Error(`unknown seed policy "${seedPolicy}"`);
  const claimed = new Map();
  return PROPOSED_ZONES.map((zone) => {
    const members = zone.members.map(([id, label]) => {
      if (claimed.has(id)) throw new Error(`${id} is a member of ${claimed.get(id)} and ${zone.id}`);
      claimed.set(id, zone.id);
      const feature = osmFeature(inputs, id);
      return { id, label, named: Boolean(feature.properties.name), ring: ringOf(feature), centroid: areaCentroid(feature) };
    });
    const seeds = [];
    const centroidsFrom =
      seedPolicy === SEED_POLICY.NAMED_MEMBERS_ONLY
        ? members.filter((m) => m.named)
        : seedPolicy === SEED_POLICY.ACCESS_POINTS_FIRST && zone.accessBuildings.length > 0
          ? []
          : members;
    for (const member of centroidsFrom) seeds.push({ ...member.centroid, evidence: `osm-centroid:${member.id}` });
    if (seedPolicy === SEED_POLICY.WITH_UNVERIFIED_POINTS) {
      for (const [id, zoneId] of Object.entries(SENSITIVITY_POINTS)) {
        if (zoneId !== zone.id) continue;
        const f = inputs.supplemental.features.find((row) => row.properties.id === id);
        if (!f) throw new Error(`no supplemental point "${id}"`);
        seeds.push({ lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], evidence: `unverified:${id}` });
      }
    }
    for (const building of zone.accessBuildings) {
      const rows = inputs.access.features
        .filter((feature) => feature.properties.buildingName === building && feature.properties.status === "verified")
        .sort((a, b) => byId(a.properties.id, b.properties.id));
      if (rows.length === 0) throw new Error(`no verified access point for "${building}"`);
      for (const row of rows) {
        seeds.push({ lat: row.geometry.coordinates[1], lon: row.geometry.coordinates[0], evidence: `access:${row.properties.id}` });
      }
    }
    for (const seed of seeds) {
      if (!containment.containsPoint(seed)) throw new Error(`seed ${seed.evidence} of ${zone.id} is not strictly inside the boundary`);
    }
    return { id: zone.id, name: zone.name, members, seeds };
  });
}

/** In-boundary sample points of a cell: its res-14 children's centres strictly inside. */
function insideSamples(cellId, containment) {
  return h3
    .cellToChildren(cellId, SAMPLE_RESOLUTION)
    .sort(byId)
    .map((child) => h3.cellToLatLng(child))
    .map(([lat, lon]) => ({ lat, lon }))
    .filter((point) => containment.containsPoint(point));
}

/** The inside sample nearest the samples' mean — always inside, unlike the mean of a sliver. */
function representativePoint(samples) {
  const mean = samples.reduce((acc, p) => ({ lat: acc.lat + p.lat / samples.length, lon: acc.lon + p.lon / samples.length }), { lat: 0, lon: 0 });
  let best = samples[0];
  let bestD = Infinity;
  for (const p of samples) {
    const d = (p.lat - mean.lat) ** 2 + (p.lon - mean.lon) ** 2;
    if (d < bestD) {
      best = p;
      bestD = d;
    }
  }
  return best;
}

/* ═══════════════════════════════════════════════════════════════════════════
   The proposal
   ═══════════════════════════════════════════════════════════════════════════ */

function validateOverrides(overrides, cover) {
  const inCover = new Set(cover);
  const zoneIds = new Set(PROPOSED_ZONES.map((zone) => zone.id));
  for (const [cellId, entry] of Object.entries(overrides || {})) {
    if (!inCover.has(cellId)) throw new Error(`override names ${cellId}, which is not a cover cell`);
    if (!entry || !zoneIds.has(entry.zoneId)) throw new Error(`override for ${cellId} names no proposed G4 zone`);
    for (const field of ["by", "on", "reason"]) {
      if (typeof entry[field] !== "string" || entry[field].trim() === "") {
        throw new Error(`override for ${cellId} has no "${field}"; an owner override records who, when and why`);
      }
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.on)) throw new Error(`override for ${cellId}: "on" must be YYYY-MM-DD`);
  }
}

/* ── The walk network, split by zone ───────────────────────────────────────── */

const piecesCache = new WeakMap();

/**
 * The boundary-contained walk network (the same segments `campusTraversalNetwork` keeps under
 * `routeContainment`) cut into pieces of ≤ 2 m, each labelled with the fine cell of its
 * midpoint. Shared OSM vertices are shared nodes, so ways join where they meet.
 */
function walkPieces(context) {
  if (piecesCache.has(context)) return piecesCache.get(context);
  const pieces = [];
  const vertexKey = (p) => `${p.lon},${p.lat}`;
  for (const feature of context.inputs.osm.features) {
    const highway = feature.properties && feature.properties.highway;
    if (!highway || !context.roadClasses.includes(highway) || feature.geometry.type !== "LineString") continue;
    const points = feature.geometry.coordinates.map(([lon, lat]) => ({ lat, lon }));
    for (let i = 1; i < points.length; i += 1) {
      const a = points[i - 1];
      const b = points[i];
      if (!context.containment.containsSegment(a, b)) continue;
      const length = cells.greatCircleMetres(a.lat, a.lon, b.lat, b.lon);
      const steps = Math.max(1, Math.ceil(length / 2));
      const at = (t) => ({ lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t });
      for (let k = 0; k < steps; k += 1) {
        const mid = at((k + 0.5) / steps);
        pieces.push({
          from: k === 0 ? vertexKey(a) : `${feature.id}:${i}:${k}`,
          to: k === steps - 1 ? vertexKey(b) : `${feature.id}:${i}:${k + 1}`,
          mid,
          cellId: cells.cellForPoint(mid.lat, mid.lon, cells.RESOLUTION.FINE),
          lengthM: length / steps,
          way: feature.id,
        });
      }
    }
  }
  piecesCache.set(context, pieces);
  return pieces;
}

/**
 * The connected parts of each zone's share of the walk network (open cells under
 * "UNRESOLVED"), largest first. A zone a pedestrian robot can cross without leaving it has one.
 *
 * @param {Map<string, string|null>} zoneOfCell
 * @returns {Record<string, { lengthM: number, ways: string[], root: string }[]>}
 */
function walkNetworks(zoneOfCell, pieces) {
  const groups = new Map();
  for (const piece of pieces) {
    if (!zoneOfCell.has(piece.cellId)) continue;
    const label = zoneOfCell.get(piece.cellId) || "UNRESOLVED";
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(piece);
  }
  const out = {};
  for (const [label, list] of groups) {
    const parent = new Map();
    const find = (x) => {
      while (parent.get(x) !== x) {
        parent.set(x, parent.get(parent.get(x)));
        x = parent.get(x);
      }
      return x;
    };
    for (const p of list) {
      if (!parent.has(p.from)) parent.set(p.from, p.from);
      if (!parent.has(p.to)) parent.set(p.to, p.to);
      const ra = find(p.from);
      const rb = find(p.to);
      if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
    }
    const parts = new Map();
    for (const p of list) {
      const root = find(p.from);
      if (!parts.has(root)) parts.set(root, { lengthM: 0, ways: new Set(), root });
      parts.get(root).lengthM += p.lengthM;
      parts.get(root).ways.add(p.way);
    }
    out[label] = [...parts.values()]
      .map((part) => ({ lengthM: Math.round(part.lengthM), ways: [...part.ways].sort(byId), root: part.root }))
      .sort((a, b) => b.lengthM - a.lengthM || byId(a.root, b.root));
  }
  return out;
}

/** The walk piece nearest a point (by piece midpoint): where that point joins the network. */
function attachmentOf(point, pieces) {
  let best = null;
  let bestD = Infinity;
  for (const p of pieces) {
    const d = cells.greatCircleMetres(point.lat, point.lon, p.mid.lat, p.mid.lon);
    if (d < bestD) {
      best = p;
      bestD = d;
    }
  }
  return { piece: best, distanceM: bestD };
}

/* ── Decisions (owner directive 2026-10-23) ─────────────────────────────────── */

function confidenceOf(row, zoneId, rule) {
  const instruments = [row.footprintLeader, row.networkLeader].filter(Boolean);
  const disagree = instruments.filter((leader) => leader !== zoneId);
  if (disagree.length > 0) return "LOW";
  if (rule === RULE.R3_CONNECTIVITY_REPAIR || rule === RULE.R4_ONLY_CONNECTED_OPTION) return "MEDIUM";
  const footprintShare = row.footprintLeader ? row.footprintSamples[row.footprintLeader] / row.insideSamples : null;
  const weak = (footprintShare !== null && footprintShare < REVIEW_THRESHOLDS.lowFootprintShare) || row.networkMarginM < REVIEW_THRESHOLDS.lowNetworkMarginM;
  return weak ? "MEDIUM" : "HIGH";
}

/**
 * Apply R1–R4 to a generated proposal's rows, in place.
 *
 *   R1 a pinned tie that borders exactly one proposed zone (and no other zone's member
 *      footprint touches it) takes that zone;
 *   R2 a pinned tie whose two instruments — member footprint and walk distance — name the same
 *      competing zone takes it;
 *   R3 while a zone's walk network is in more than one part, a cell on its border (open, or
 *      another zone's) moves to it if that joins parts, leaves the donor zone contiguous and
 *      no more split, and is not an owner override; the largest gain wins, first in canonical
 *      order on a draw;
 *   R4 a tie still open takes a competing zone when that zone is the ONLY one that keeps
 *      every zone's walk network unsplit and every zone contiguous.
 * Anything left stays UNRESOLVED_TIE.
 */
function applyDecisions(rows, context) {
  const pieces = walkPieces(context);
  const owner = new Map(rows.map((row) => [row.cellId, row.zoneId]));
  const zoneIds = PROPOSED_ZONES.map((zone) => zone.id);
  const parts = (map) => walkNetworks(map, pieces);
  const partCount = (map, zoneId) => (parts(map)[zoneId] || []).length;
  const contiguous = (map, zoneId) => components([...map].filter(([, z]) => z === zoneId).map(([id]) => id)).length === 1;
  const decide = (row, zoneId, basis, rule, extra = {}) => {
    const from = row.zoneId;
    row.zoneId = zoneId;
    row.basis = basis;
    owner.set(row.cellId, zoneId);
    row.decision = { rule, confidence: confidenceOf(row, zoneId, rule), authority: DECISION_AUTHORITY, from, ...extra };
  };

  for (const row of rows) {
    if (row.basis !== BASIS.UNRESOLVED_TIE) continue;
    const otherFootprint = Object.entries(row.footprintSamples).some(([z, n]) => n > 0 && !row.competing.includes(z));
    if (row.competing.length === 1 && !otherFootprint) decide(row, row.competing[0], BASIS.EVIDENCE_DECISION, RULE.R1_SINGLE_NEIGHBOUR);
    else if (row.footprintLeader && row.footprintLeader === row.networkLeader && row.competing.includes(row.footprintLeader)) {
      decide(row, row.footprintLeader, BASIS.EVIDENCE_DECISION, RULE.R2_INSTRUMENTS_AGREE);
    }
  }

  const rowOf = new Map(rows.map((row) => [row.cellId, row]));
  for (;;) {
    const current = parts(owner);
    let best = null;
    for (const zoneId of zoneIds) {
      const before = (current[zoneId] || []).length;
      if (before <= 1) continue;
      const border = new Set();
      for (const [cellId, z] of owner) {
        if (z !== zoneId) continue;
        for (const n of cells.diskAround(cellId, 1)) if (owner.has(n) && owner.get(n) !== zoneId) border.add(n);
      }
      for (const cellId of cells.canonicalCellOrder([...border])) {
        const row = rowOf.get(cellId);
        const donor = owner.get(cellId);
        if (row.basis === BASIS.OVERRIDE) continue;
        if (donor === null && !row.competing.includes(zoneId)) continue;
        const next = new Map(owner);
        next.set(cellId, zoneId);
        const gain = before - partCount(next, zoneId);
        if (gain <= 0) continue;
        if (donor !== null && (partCount(next, donor) > (current[donor] || []).length || !contiguous(next, donor))) continue;
        if (!best || gain > best.gain) best = { row, zoneId, gain, partsBefore: current[zoneId].map((p) => p.lengthM) };
      }
    }
    if (!best) break;
    decide(best.row, best.zoneId, BASIS.CONNECTIVITY_REPAIR, RULE.R3_CONNECTIVITY_REPAIR, { joinsPartsOfM: best.partsBefore });
  }

  for (const row of rows) {
    if (row.basis !== BASIS.UNRESOLVED_TIE) continue;
    const current = parts(owner);
    const valid = row.competing.filter((zoneId) => {
      const next = new Map(owner);
      next.set(row.cellId, zoneId);
      const after = parts(next);
      return zoneIds.every((z) => (after[z] || []).length <= Math.max(1, (current[z] || []).length)) && contiguous(next, zoneId);
    });
    row.connectedOptions = valid;
    if (valid.length === 1) decide(row, valid[0], BASIS.EVIDENCE_DECISION, RULE.R4_ONLY_CONNECTED_OPTION, { connectedOptions: valid });
  }
}

/**
 * Build the G4 proposal. The returned object has the shape `rnsitZoneMap.checkProposal`,
 * `pathTransitions` and `candidateSpatialMap` read, so the L4 checks run on it unchanged.
 *
 *   stage GENERATED — the instruments only; the 14 L4 ties stay open (the 2026-10-22 proposal);
 *   stage DECIDED (default) — R1–R4 applied (`applyDecisions`). Still NOT approved, NOT published.
 *
 * @param {{ context?: object, stage?: string, seedPolicy?: string, overrides?: Record<string, { zoneId: string, by: string, on: string, reason: string }> }} [options]
 */
function buildProposal(options = {}) {
  const context = options.context || loadContext();
  const overrides = options.overrides || {};
  const seedPolicy = options.seedPolicy || SEED_POLICY.BASELINE;
  const stage = options.stage || STAGE.DECIDED;
  if (!Object.values(STAGE).includes(stage)) throw new Error(`unknown stage "${stage}"`);
  const { cover, centreContained, containment, network, l4 } = context;
  validateOverrides(overrides, cover);
  const zones = zoneEvidence(context, seedPolicy);
  const pinned = new Set(l4.unresolved);
  const l4Row = new Map(l4.cells.map((row) => [row.cellId, row]));

  const rows = cover.map((cellId) => {
    const samples = insideSamples(cellId, containment);
    const footprintSamples = {};
    for (const zone of zones) {
      footprintSamples[zone.id] = samples.filter((p) => zone.members.some((member) => pointInPolygon(p, member.ring))).length;
    }
    const footprintTotal = Object.values(footprintSamples).reduce((a, b) => a + b, 0);
    const footprintBest = Math.max(...Object.values(footprintSamples));
    const footprintLeaders = Object.keys(footprintSamples).filter((id) => footprintSamples[id] === footprintBest).sort(byId);

    let networkM = null;
    let networkLeaders = [];
    let networkMargin = null;
    if (samples.length > 0) {
      const from = representativePoint(samples);
      networkM = {};
      for (const zone of zones) {
        let best = Infinity;
        for (const seed of zone.seeds) {
          const routed = network.route(from, seed);
          if (!routed.ok) throw new Error(`no contained route from ${cellId} to ${seed.evidence}: ${routed.reason}`);
          if (routed.distanceM < best) best = routed.distanceM;
        }
        networkM[zone.id] = best;
      }
      const ordered = Object.entries(networkM).sort((a, b) => a[1] - b[1] || byId(a[0], b[0]));
      networkLeaders = ordered.filter(([, d]) => d === ordered[0][1]).map(([id]) => id).sort(byId);
      networkMargin = ordered[1][1] - ordered[0][1];
    }

    let zoneId = null;
    let basis;
    if (overrides[cellId]) {
      zoneId = overrides[cellId].zoneId;
      basis = BASIS.OVERRIDE;
    } else if (pinned.has(cellId)) basis = BASIS.UNRESOLVED_TIE;
    else if (samples.length === 0) basis = BASIS.NO_INSIDE_SAMPLE;
    else if (footprintTotal > 0) {
      if (footprintLeaders.length === 1) {
        zoneId = footprintLeaders[0];
        basis = BASIS.FOOTPRINT;
      } else basis = BASIS.FOOTPRINT_CONFLICT;
    } else if (networkLeaders.length === 1) {
      zoneId = networkLeaders[0];
      basis = BASIS.NETWORK;
    } else basis = BASIS.NETWORK_TIE;

    const flags = [];
    if (!centreContained.has(cellId)) flags.push(FLAG.BOUNDARY_CELL);
    if (basis === BASIS.FOOTPRINT && footprintBest / samples.length < REVIEW_THRESHOLDS.lowFootprintShare) flags.push(FLAG.LOW_FOOTPRINT_SHARE);
    if (basis === BASIS.NETWORK && networkMargin < REVIEW_THRESHOLDS.lowNetworkMarginM) flags.push(FLAG.LOW_NETWORK_MARGIN);
    if (basis === BASIS.FOOTPRINT && networkLeaders.length === 1 && networkLeaders[0] !== zoneId) flags.push(FLAG.INSTRUMENTS_DISAGREE);

    const l4Cell = l4Row.get(cellId);
    return {
      cellId,
      centreInBoundary: centreContained.has(cellId),
      zoneId,
      basis,
      insideSamples: samples.length,
      insideFraction: Math.round((samples.length / 7 ** (SAMPLE_RESOLUTION - 11)) * 1000) / 1000,
      footprintSamples,
      footprintLeader: footprintTotal > 0 ? footprintLeaders.join("|") : null,
      networkM: networkM && Object.fromEntries(Object.entries(networkM).map(([id, d]) => [id, round1(d)])),
      networkLeader: networkLeaders.join("|") || null,
      networkMarginM: networkMargin === null ? null : round1(networkMargin),
      flags,
      l4: { zoneId: l4Cell.zoneId, nearest: l4Cell.nearest },
      ...(overrides[cellId] ? { override: { ...overrides[cellId] } } : {}),
    };
  });

  // Competing zones for an open cell: the zones of its assigned neighbours, plus any zone whose
  // members touch it. `rnsitZoneMap.checkProposal` prints this list as `nearest`.
  // `competing` is fixed at the generated stage, so the decisions read one stable list.
  const zoneOfCell = new Map(rows.map((row) => [row.cellId, row.zoneId]));
  for (const row of rows) {
    if (row.zoneId !== null) continue;
    const competing = new Set();
    for (const neighbour of cells.diskAround(row.cellId, 1)) if (zoneOfCell.get(neighbour)) competing.add(zoneOfCell.get(neighbour));
    for (const [id, n] of Object.entries(row.footprintSamples)) if (n > 0) competing.add(id);
    row.competing = [...competing].sort(byId);
  }

  if (stage === STAGE.DECIDED) applyDecisions(rows, context);
  for (const row of rows) row.nearest = row.zoneId !== null ? [row.zoneId] : row.competing;

  const unresolved = rows.filter((row) => row.zoneId === null).map((row) => row.cellId);
  return {
    layout: LAYOUT,
    stage,
    approved: false,
    published: false,
    status: unresolved.length > 0 ? STATUS.UNRESOLVED : STATUS.RESOLVED_PENDING_OWNER_APPROVAL,
    boundary: { way: "way/1120154292", sha256: digestOfBoundaryFile(context.root) },
    method: {
      seedPolicy,
      sampleResolution: SAMPLE_RESOLUTION,
      roadClasses: context.roadClasses,
      network: context.network.describe(),
      reviewThresholds: { ...REVIEW_THRESHOLDS },
    },
    zones: zones.map((zone) => ({
      id: zone.id,
      name: zone.name,
      members: zone.members.map(({ id, label }) => ({ id, label })),
      seeds: zone.seeds.map(({ evidence, lat, lon }) => ({ evidence, lat, lon })),
    })),
    anchorConflicts: [],
    pinnedTies: [...l4.unresolved],
    cells: rows,
    unresolved,
    outstandingOwnerDecisions: [...OUTSTANDING_OWNER_DECISIONS],
  };
}

function digestOfBoundaryFile(root) {
  return crypto.createHash("sha256").update(fs.readFileSync(path.join(root, "rnsit-campus-osm.geojson"))).digest("hex");
}

/** SHA-256 of the cell→zone assignment alone, for stale-snapshot detection. */
function assignmentDigest(proposal) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(proposal.cells.map((row) => [row.cellId, row.zoneId])))
    .digest("hex");
}

/* ═══════════════════════════════════════════════════════════════════════════
   Checks and measures
   ═══════════════════════════════════════════════════════════════════════════ */

/** Connected components of a cell set under H3 adjacency — the same rule `checkProposal` uses. */
function components(cellIds) {
  const remaining = new Set(cellIds);
  const out = [];
  for (const start of cells.canonicalCellOrder(cellIds)) {
    if (!remaining.has(start)) continue;
    remaining.delete(start);
    const part = [start];
    for (let i = 0; i < part.length; i += 1) {
      for (const n of cells.diskAround(part[i], 1)) {
        if (remaining.has(n)) {
          remaining.delete(n);
          part.push(n);
        }
      }
    }
    out.push(cells.canonicalCellOrder(part));
  }
  return out;
}

/**
 * Per-zone geometry: cell counts, contiguity, Polsby–Popper compactness of the cell union
 * (4πA/P², 1 = disc), extent, and the unresolved cells each zone wholly surrounds.
 */
function zoneGeometry(proposal, frame) {
  const zoneOf = new Map(proposal.cells.map((row) => [row.cellId, row.zoneId]));
  return proposal.zones.map((zone) => {
    const ids = cells.canonicalCellOrder(proposal.cells.filter((row) => row.zoneId === zone.id).map((row) => row.cellId));
    if (ids.length === 0) return { zoneId: zone.id, cells: 0, components: 0 };
    const multi = h3.cellsToMultiPolygon(ids, true);
    const { area, perimeter } = areaAndPerimeter(multi, frame);
    let extent = 0;
    const centres = ids.map((id) => h3.cellToLatLng(id));
    for (let i = 0; i < centres.length; i += 1) {
      for (let j = i + 1; j < centres.length; j += 1) {
        extent = Math.max(extent, cells.greatCircleMetres(centres[i][0], centres[i][1], centres[j][0], centres[j][1]));
      }
    }
    const enclosed = proposal.unresolved.filter((id) =>
      cells.diskAround(id, 1).filter((n) => n !== id && zoneOf.has(n)).every((n) => zoneOf.get(n) === zone.id),
    );
    return {
      zoneId: zone.id,
      cells: ids.length,
      boundaryCells: proposal.cells.filter((row) => row.zoneId === zone.id && !row.centreInBoundary).length,
      components: components(ids).length,
      areaM2: Math.round(area),
      polsbyPopper: Math.round(((4 * Math.PI * area) / perimeter ** 2) * 1000) / 1000,
      extentM: Math.round(extent),
      enclosedUnresolved: enclosed,
    };
  });
}

/** The zone of each cell an ordered point list passes through, sampled every 2 m. */
function cellsAlong(points) {
  const out = [];
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const steps = Math.max(1, Math.ceil(cells.greatCircleMetres(a.lat, a.lon, b.lat, b.lon) / 2));
    for (let k = 0; k <= steps; k += 1) {
      const t = k / steps;
      const id = cells.cellForPoint(a.lat + (b.lat - a.lat) * t, a.lon + (b.lon - a.lon) * t, cells.RESOLUTION.FINE);
      if (out[out.length - 1] !== id) out.push(id);
    }
  }
  return out;
}

/**
 * Intra-zone connectivity on the walk network: route between every pair of a zone's seeds over
 * the contained network and report which other zones (or open cells) those routes pass through.
 */
function intraZoneRoutes(proposal, context) {
  const zoneOf = new Map(proposal.cells.map((row) => [row.cellId, row.zoneId === null ? "UNRESOLVED" : row.zoneId]));
  return proposal.zones.map((zone) => {
    let pairs = 0;
    let onlyOpen = 0;
    let intoOtherZone = 0;
    const through = new Set();
    for (let i = 0; i < zone.seeds.length; i += 1) {
      for (let j = i + 1; j < zone.seeds.length; j += 1) {
        const routed = context.network.route(zone.seeds[i], zone.seeds[j]);
        if (!routed.ok) throw new Error(`no contained route inside ${zone.id}: ${routed.reason}`);
        pairs += 1;
        const others = new Set(cellsAlong(routed.points).map((id) => zoneOf.get(id) || "OUTSIDE_COVER").filter((z) => z !== zone.id));
        const foreign = [...others].filter((z) => z !== "UNRESOLVED");
        if (foreign.length > 0) intoOtherZone += 1;
        else if (others.size > 0) onlyOpen += 1;
        for (const z of foreign) through.add(z);
      }
    }
    // A route that leaves only through UNRESOLVED cells stays inside once those cells join this
    // zone; one that enters another assigned zone does not.
    return { zoneId: zone.id, seedPairs: pairs, routesThroughOpenCellsOnly: onlyOpen, routesThroughAnotherZone: intoOtherZone, otherZones: [...through].sort(byId) };
  });
}

/** Permitted ways and how many metres of each lie in each zone (2 m sampling). */
function walkwaysByZone(proposal, context) {
  const zoneOf = new Map(proposal.cells.map((row) => [row.cellId, row.zoneId === null ? "UNRESOLVED" : row.zoneId]));
  const out = {};
  for (const feature of context.inputs.osm.features) {
    const highway = feature.properties && feature.properties.highway;
    if (!highway || !context.roadClasses.includes(highway) || feature.geometry.type !== "LineString") continue;
    const coordinates = feature.geometry.coordinates;
    for (let i = 1; i < coordinates.length; i += 1) {
      const [lon0, lat0] = coordinates[i - 1];
      const [lon1, lat1] = coordinates[i];
      const length = cells.greatCircleMetres(lat0, lon0, lat1, lon1);
      const steps = Math.max(1, Math.ceil(length / 2));
      for (let k = 0; k < steps; k += 1) {
        const t = (k + 0.5) / steps;
        const label = zoneOf.get(cells.cellForPoint(lat0 + (lat1 - lat0) * t, lon0 + (lon1 - lon0) * t, cells.RESOLUTION.FINE)) || "OUTSIDE_COVER";
        out[label] = out[label] || {};
        out[label][feature.id] = (out[label][feature.id] || 0) + length / steps;
      }
    }
  }
  for (const label of Object.keys(out)) {
    out[label] = Object.entries(out[label])
      .map(([id, m]) => ({ id, highway: context.inputs.osm.features.find((f) => f.id === id).properties.highway, metres: Math.round(m) }))
      .filter((row) => row.metres > 0)
      .sort((a, b) => b.metres - a.metres || byId(a.id, b.id));
  }
  return out;
}

/** Which zone pairs share an edge, with the cells on each side. */
function zoneAdjacency(proposal) {
  const zoneOf = new Map(proposal.cells.map((row) => [row.cellId, row.zoneId === null ? "UNRESOLVED" : row.zoneId]));
  const pairs = new Map();
  for (const row of proposal.cells) {
    for (const n of cells.diskAround(row.cellId, 1)) {
      if (n === row.cellId || !zoneOf.has(n)) continue;
      const a = zoneOf.get(row.cellId);
      const b = zoneOf.get(n);
      if (a === b) continue;
      const key = [a, b].sort(byId).join("|");
      pairs.set(key, (pairs.get(key) || 0) + 1);
    }
  }
  return [...pairs.entries()].map(([pair, halfEdges]) => ({ pair, sharedEdges: halfEdges / 2 })).sort((a, b) => byId(a.pair, b.pair));
}

/**
 * Rebuild the proposal under each non-baseline seed policy and list the cells whose owner
 * changes. Footprint-decided and pinned cells cannot change; only network-decided cells can.
 */
function seedSensitivity(context, baseline) {
  const owner = new Map(baseline.cells.map((row) => [row.cellId, row.zoneId]));
  return Object.values(SEED_POLICY)
    .filter((policy) => policy !== SEED_POLICY.BASELINE)
    .map((policy) => {
      const variant = buildProposal({ context, seedPolicy: policy });
      const changed = variant.cells
        .filter((row) => row.zoneId !== owner.get(row.cellId))
        .map((row) => ({ cellId: row.cellId, baseline: owner.get(row.cellId), variant: row.zoneId }));
      return { policy, changed };
    });
}

/* ── Campus facilities: what the data says, verified or not ────────────────── */

const FACILITY_QUERIES = Object.freeze([
  { facility: "Academic buildings", osm: (p) => /department|block/i.test(p.name || "") && !!p.building },
  { facility: "Main Building", osm: (p) => p.name === "Main Building" },
  { facility: "Entrance / main gate", osm: (p) => p.barrier === "gate" || p.entrance, supplemental: (p) => p.kind === "GATE" },
  { facility: "Sports ground", osm: (p) => /cricket|football/.test(p.sport || "") },
  { facility: "Basketball court", osm: (p) => p.sport === "basketball" },
  { facility: "Hostels", osm: (p) => /hostel/i.test(p.name || "") || p.building === "dormitory" },
  { facility: "Canteen", osm: (p) => /canteen/i.test(p.name || "") || ["food_court", "fast_food", "cafe", "restaurant"].includes(p.amenity), supplemental: (p) => /food|canteen/i.test(p.name || "") },
  { facility: "Parking", osm: (p) => /parking/.test(p.amenity || ""), supplemental: (p) => p.kind === "PARKING" },
  { facility: "Library", osm: (p) => /librar/i.test(`${p.name || ""} ${p.amenity || ""}`), supplemental: (p) => /librar/i.test(p.name || "") },
  { facility: "Playground", osm: (p) => /playground/i.test(`${p.name || ""} ${p.leisure || ""}`), supplemental: (p) => /playground/i.test(p.name || "") },
  { facility: "Auditorium", osm: (p) => /auditorium/i.test(p.name || "") || p.amenity === "conference_centre" },
  { facility: "Bank", osm: (p) => p.amenity === "bank", supplemental: (p) => /bank/i.test(p.name || "") },
  { facility: "International School", osm: (p) => /international school/i.test(p.name || "") },
  { facility: "PU College / other colleges", supplemental: (p) => /college/i.test(p.name || "") },
  { facility: "Innovation Center", supplemental: (p) => /innovation/i.test(p.name || "") },
  { facility: "Temple", osm: (p) => p.amenity === "place_of_worship" },
]);

/**
 * For each facility class the task names: every source feature that matches, whether it is an
 * outline or a point, its verification state and whether it lies inside the boundary. Status
 * says what the data supports; nothing is inferred.
 */
function facilityInventory(context, proposal) {
  const { inputs, containment } = context;
  const memberOf = new Map(proposal.zones.flatMap((zone) => zone.members.map((m) => [m.id, zone.id])));
  const verifiedAccess = (osmId) => inputs.access.features.filter((f) => f.properties.buildingSourceId === osmId && f.properties.status === "verified").length;
  return FACILITY_QUERIES.map((query) => {
    const found = [];
    if (query.osm) {
      for (const f of inputs.osm.features) {
        if (f.id === "way/1120154292" || f.geometry.type === "LineString" || !query.osm(f.properties || {})) continue;
        const point = f.geometry.type === "Point" ? { lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] } : areaCentroid(f);
        found.push({
          source: f.id,
          name: f.properties.name || f.properties.amenity || f.properties.leisure || "(unnamed)",
          geometry: f.geometry.type === "Point" ? "POINT" : "OUTLINE",
          verification: verifiedAccess(f.id) > 0 ? `OSM outline; ${verifiedAccess(f.id)} site-verified access points` : "OSM only, not site-checked",
          insideBoundary: containment.containsPoint(point),
          zone: memberOf.get(f.id) || null,
        });
      }
    }
    if (query.supplemental) {
      for (const f of inputs.supplemental.features) {
        if (!query.supplemental(f.properties)) continue;
        const point = { lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] };
        found.push({
          source: `supplemental:${f.properties.id}`,
          name: f.properties.name,
          geometry: "POINT",
          verification: f.properties.verificationStatus,
          insideBoundary: containment.containsPoint(point),
          zone: null,
        });
      }
    }
    let status;
    if (found.length === 0) status = "MISSING — no feature in any RNSIT source";
    else if (!found.some((row) => row.geometry === "OUTLINE")) status = found.every((row) => !row.insideBoundary) ? "POINT ONLY, OUTSIDE THE BOUNDARY" : "POINT ONLY — no outline in the data";
    else if (found.some((row) => /site-verified/.test(row.verification))) status = "OUTLINE + SITE-VERIFIED ACCESS";
    else status = "OUTLINE (OSM only)";
    return { facility: query.facility, status, found };
  });
}

/* ── Region isolation ──────────────────────────────────────────────────────── */

/** The JSSATE campus cover must not share a cell with RNSIT's, or zone rooms could cross campuses. */
function regionIsolation(context) {
  const extract = JSON.parse(fs.readFileSync(path.join(context.root, JSSATE_EXTRACT)));
  const outline = extract.features.find((f) => f.id === JSSATE_BOUNDARY_WAY);
  if (!outline) throw new Error(`no ${JSSATE_BOUNDARY_WAY} in ${JSSATE_EXTRACT}`);
  const jssate = h3.polygonToCellsExperimental(outline.geometry.coordinates, 11, h3.POLYGON_TO_CELLS_FLAGS.containmentOverlapping, true);
  const rnsit = new Set(context.cover);
  const shared = jssate.filter((id) => rnsit.has(id));
  const a = h3.cellToLatLng(context.cover[0]);
  const b = h3.cellToLatLng(jssate[0]);
  return { jssateCoverCells: jssate.length, sharedCells: shared.sort(byId), approxSeparationM: Math.round(cells.greatCircleMetres(a[0], a[1], b[0], b[1])) };
}

/* ── Cross-zone delivery: what TODAY's delivery rule would do with this map ──── */

/**
 * The resolved cells only, as a partial published map (what `candidateSpatialMap` would build
 * once every cell has a zone). Test and analysis use only; it is never published.
 */
function partialSpatialMap(proposal, regionId) {
  return {
    regions: [{ id: regionId }],
    zones: proposal.zones.map((zone) => ({ id: zone.id, regionId })),
    sites: [],
    cells: proposal.cells.filter((row) => row.zoneId !== null).map((row) => ({ cellId: row.cellId, resolution: cells.RESOLUTION.FINE, regionId, zoneId: row.zoneId })),
  };
}

/**
 * Offline model of cross-zone delivery — the quantity the adopted policy must cover.
 *
 * Fleet: one robot per ordered pair of the 18 site-verified access points and the V1 depot,
 * driving the SIMULATOR's route (`v1DemonstrationComposition` builds its network uncontained),
 * observed at EVERY vertex of that route except the last ("robot moments"). At each moment the
 * robot's zone is the one its position resolves to through the live `dtaroZoneAlert.resolvePoint`,
 * and its remaining commanded route is its position plus the rest of the route.
 *
 * Obstacles: one at the centre of each cover cell, with the alert's footprint
 * (`dtaroZoneAlert.cellFootprint`). A moment is RELEVANT when its remaining route meets the
 * footprint (`pathIntersectsPolygon`, the receiver's own test).
 *
 * Policies:
 *   · ZONE_ONLY — today's live rule (the obstacle's zone room only);
 *   · ZONE_PLUS_ROUTE — the adopted policy (`dtaroRecipientPolicy.selectRecipients`).
 * The single published zone (`rnsit-z1`) is evaluated under ZONE_ONLY as the baseline.
 */
function crossZoneDelivery(proposal, context) {
  // Loaded lazily: the zone-alert service pulls in the EKB and socket modules (no connection).
  const dtaroZoneAlert = require("../../src/services/dtaroZoneAlert.service");
  const { selectRecipients } = require("../../src/services/dtaroRecipientPolicy");
  const regionId = "analysis-region";
  const extract = campusTraversalNetwork.extractForDeclaration(context.world.declaration, { directory: context.root });
  if (!extract.ok) throw new Error(extract.problems.join("; "));
  const simNetwork = campusTraversalNetwork.createCampusTraversalNetwork({ features: extract.features, roadClasses: context.roadClasses, source: extract.file });

  const endpoints = context.inputs.access.features
    .filter((f) => f.properties.status === "verified")
    .sort((a, b) => byId(a.properties.id, b.properties.id))
    .map((f) => ({ id: f.properties.id, lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] }));
  endpoints.push({ id: "v1-depot", lat: context.world.depot.lat, lon: context.world.depot.lon });

  // Each route is kept once; a robot moment is (route, vertex k) and its remaining route is the
  // route from vertex k on. `pathIntersectsPolygon` on a path is the OR of it over the path's
  // segments, so a moment is relevant exactly when some segment j ≥ k meets the footprint.
  const routeList = [];
  for (const a of endpoints) {
    for (const b of endpoints) {
      if (a === b) continue;
      const routed = simNetwork.route(a, b);
      if (routed.ok) routeList.push({ id: `${a.id}→${b.id}`, points: routed.points });
    }
  }
  const moments = [];
  routeList.forEach((route, r) => {
    for (let k = 0; k < route.points.length - 1; k += 1) {
      moments.push({ robotId: `${route.id}#${String(k).padStart(3, "0")}`, route: r, k, at: route.points[k] });
    }
  });
  const remainingRoute = (m) => routeList[m.route].points.slice(m.k);

  /** For one obstacle footprint: which moments' remaining routes meet it (suffix OR per route). */
  const relevantMoments = (footprint) => {
    const out = new Set();
    routeList.forEach((route, r) => {
      const hits = [];
      for (let j = 0; j < route.points.length - 1; j += 1) hits.push(pathIntersectsPolygon([route.points[j], route.points[j + 1]], footprint));
      let ahead = false;
      for (let j = hits.length - 1; j >= 0; j -= 1) {
        ahead = ahead || hits[j];
        if (ahead) out.add(`${r}:${j}`);
      }
    });
    return out;
  };

  const maps = {
    PUBLISHED_SINGLE_ZONE: { spatial: zoneMap.currentSpatialMap(context.cover, { regionId }) },
    G4: { spatial: partialSpatialMap(proposal, regionId) },
  };
  const tally = () => ({ relevant: 0, delivered: 0, deliveredSameZone: 0, deliveredCrossZone: 0, missed: 0, unnecessary: 0, messages: 0, missedBy: {} });
  const result = {
    routes: routeList.length,
    endpoints: endpoints.length,
    robotMoments: moments.length,
    obstacles: context.cover.length,
    PUBLISHED_SINGLE_ZONE: { ZONE_ONLY: tally() },
    G4: { ZONE_ONLY: tally(), ZONE_PLUS_ROUTE: tally() },
    policyCrossChecks: 0,
  };
  const crossings = {};
  const relevance = new Map(context.cover.map((cellId) => [cellId, relevantMoments(dtaroZoneAlert.cellFootprint(cellId))]));
  // Every eighth obstacle (canonical order) is also run through `selectRecipients` itself, and
  // the bulk computation below must agree with it exactly.
  const crossChecked = new Set(context.cover.filter((_, i) => i % 8 === 0));

  for (const [mapName, snapshot] of Object.entries(maps)) {
    const zoneOfMoment = moments.map((m) => {
      const here = dtaroZoneAlert.resolvePoint(snapshot, m.at.lat, m.at.lon);
      return here.ok ? here.zoneId : null;
    });
    for (const obstacleCell of context.cover) {
      const footprint = dtaroZoneAlert.cellFootprint(obstacleCell);
      const located = dtaroZoneAlert.resolvePoint(snapshot, ...h3.cellToLatLng(obstacleCell));
      const relevantKeys = relevance.get(obstacleCell);
      const isRelevant = (i) => relevantKeys.has(`${moments[i].route}:${moments[i].k}`);
      const sameZone = new Set();
      const crossZone = new Set();
      if (located.ok) {
        moments.forEach((_, i) => {
          if (zoneOfMoment[i] === located.zoneId) sameZone.add(i);
          else if (isRelevant(i)) crossZone.add(i);
        });
      }
      if (mapName === "G4" && located.ok && crossChecked.has(obstacleCell)) {
        const robots = moments.map((m, i) => ({ robotId: String(i).padStart(6, "0"), regionId: located.regionId, zoneId: zoneOfMoment[i], remainingRoute: remainingRoute(m) }));
        const picked = selectRecipients({ obstacle: { regionId: located.regionId, zoneId: located.zoneId, footprint }, robots });
        const same = new Set(picked.sameZone.map(Number));
        const cross = new Set(picked.crossZone.map(Number));
        const equal = (x, y) => x.size === y.size && [...x].every((v) => y.has(v));
        if (!equal(same, sameZone) || !equal(cross, crossZone)) throw new Error(`cross-zone model disagrees with selectRecipients for ${obstacleCell}`);
        result.policyCrossChecks += 1;
      }
      const policies = mapName === "G4" ? ["ZONE_ONLY", "ZONE_PLUS_ROUTE"] : ["ZONE_ONLY"];
      for (const policy of policies) {
        const t = result[mapName][policy];
        const viaCross = policy === "ZONE_PLUS_ROUTE" ? crossZone : new Set();
        t.messages += sameZone.size + viaCross.size;
        for (const i of sameZone) if (!isRelevant(i)) t.unnecessary += 1;
        moments.forEach((_, i) => {
          if (!isRelevant(i)) return;
          t.relevant += 1;
          if (sameZone.has(i) || viaCross.has(i)) {
            t.delivered += 1;
            if (viaCross.has(i)) t.deliveredCrossZone += 1;
            else t.deliveredSameZone += 1;
            return;
          }
          t.missed += 1;
          const reason = !located.ok ? `OBSTACLE_${located.reason}` : zoneOfMoment[i] === null ? "ROBOT_IN_OPEN_CELL" : "ROBOT_IN_ANOTHER_ZONE";
          t.missedBy[reason] = (t.missedBy[reason] || 0) + 1;
          if (mapName === "G4" && policy === "ZONE_ONLY" && reason === "ROBOT_IN_ANOTHER_ZONE") {
            const key = `${zoneOfMoment[i]}|${located.zoneId}`;
            crossings[key] = (crossings[key] || 0) + 1;
          }
        });
      }
    }
  }
  result.missedAcrossZones = Object.entries(crossings)
    .map(([key, count]) => ({ robotZone: key.split("|")[0], obstacleZone: key.split("|")[1], count }))
    .sort((a, b) => byId(a.robotZone, b.robotZone) || byId(a.obstacleZone, b.obstacleZone));
  return result;
}

/* ═══════════════════════════════════════════════════════════════════════════
   Report: one object every output is rendered from
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Every check a VALIDATED proposal must pass. Offline; the engine validators run against a
 * candidate map built for a stand-in region id, which is not a publication.
 *
 * @returns {{ passed: boolean, checks: { id: string, passed: boolean, detail: string }[], walk: object, access: object[] }}
 */
function validateLayout(proposal, context) {
  const checks = [];
  const add = (id, passed, detail) => checks.push({ id, passed, detail });
  const ids = proposal.cells.map((row) => row.cellId);
  const zoneIds = PROPOSED_ZONES.map((zone) => zone.id);

  const perimeter = context.inputs.osm.features.find((f) => f.id === "way/1120154292");
  add(
    "PERIMETER_UNCHANGED",
    proposal.boundary.sha256 === ADOPTED_BOUNDARY_SHA256 && JSON.stringify(perimeter.geometry.coordinates) === JSON.stringify(context.world.declaration.boundary.coordinates),
    `way/1120154292, sha256 ${proposal.boundary.sha256.slice(0, 12)}…, identical to the published delivery-domain declaration`,
  );
  add("COVER_EXACT", JSON.stringify(ids) === JSON.stringify(context.cover), `${ids.length} cells, the adopted cover in canonical order`);
  const badZone = proposal.cells.filter((row) => row.zoneId !== null && !zoneIds.includes(row.zoneId));
  add("SINGLE_OWNER", new Set(ids).size === ids.length && badZone.length === 0, "each cell listed once, with at most one proposed zone");
  add("ALL_ASSIGNED", proposal.unresolved.length === 0, proposal.unresolved.length ? `open: ${proposal.unresolved.join(", ")}` : "every cell has a zone");
  add("EXACTLY_FOUR_ZONES", zoneIds.length === 4 && zoneIds.every((z) => proposal.cells.some((row) => row.zoneId === z)), zoneIds.join(", "));
  const split = zoneIds.filter((z) => components(proposal.cells.filter((row) => row.zoneId === z).map((row) => row.cellId)).length !== 1);
  add("ZONES_CONTIGUOUS", split.length === 0, split.length ? `split: ${split.join(", ")}` : "each zone is one H3-connected piece");
  add("CELLS_TOUCH_CAMPUS", proposal.cells.every((row) => row.insideSamples > 0), "every cell has part of its area strictly inside the perimeter");
  const seedsOutside = proposal.zones.flatMap((zone) => zone.seeds.filter((seed) => !context.containment.containsPoint(seed)));
  add("SEEDS_INSIDE", seedsOutside.length === 0, "every network seed strictly inside the perimeter");

  const pieces = walkPieces(context);
  const walk = walkNetworks(new Map(proposal.cells.map((row) => [row.cellId, row.zoneId])), pieces);
  const walkSplit = zoneIds.filter((z) => (walk[z] || []).length !== 1);
  add("WALK_NETWORK_CONNECTED", walkSplit.length === 0, walkSplit.length ? walkSplit.map((z) => `${z}: parts ${(walk[z] || []).map((p) => `${p.lengthM} m`).join(", ")}`).join("; ") : "each zone's share of the contained walk network is one connected part");
  add("WALK_NETWORK_CONTAINED", pieces.every((p) => context.containment.containsPoint(p.mid)), `${pieces.length} pieces, all strictly inside the perimeter`);

  const zoneOfMember = new Map(proposal.zones.flatMap((zone) => zone.members.map((m) => [m.id, zone.id])));
  const zoneOfCell = new Map(proposal.cells.map((row) => [row.cellId, row.zoneId]));
  const access = context.inputs.access.features
    .filter((f) => f.properties.status === "verified")
    .sort((a, b) => byId(a.properties.id, b.properties.id))
    .map((f) => {
      const point = { lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] };
      const { piece, distanceM } = attachmentOf(point, pieces);
      const expected = zoneOfMember.get(f.properties.buildingSourceId) || null;
      return { id: f.properties.id, building: f.properties.buildingName, zone: expected, joinsNetworkIn: zoneOfCell.get(piece.cellId) || null, way: piece.way, distanceM: round1(distanceM) };
    });
  const foreign = access.filter((a) => a.zone !== a.joinsNetworkIn);
  add("ACCESS_POINTS_JOIN_OWN_ZONE", foreign.length === 0, foreign.length ? foreign.map((a) => `${a.id} joins ${a.joinsNetworkIn}`).join("; ") : `all ${access.length} verified access points join their own zone's walk network`);

  if (proposal.unresolved.length === 0) {
    const map = zoneMap.candidateSpatialMap(proposal, { regionId: "validation-region" });
    const verdict = hierarchy.validateForPublish(map);
    const v8 = validators.v8SpatialContainment(hierarchy.toConfigPayload(map));
    add("ENGINE_VALIDATORS", verdict.ok && v8.length === 0, `hierarchy.validateForPublish ${verdict.ok ? "ok" : verdict.problems.join("; ")}; V8 findings ${v8.length}`);
  } else add("ENGINE_VALIDATORS", false, "not run: a candidate map cannot be built while cells are open");
  const isolation = regionIsolation(context);
  add("REGION_ISOLATION", isolation.sharedCells.length === 0, `JSSATE cover ${isolation.jssateCoverCells} cells, shared ${isolation.sharedCells.length}`);
  return { passed: checks.every((c) => c.passed), checks, walk, access };
}

function buildReport(options = {}) {
  const context = options.context || loadContext();
  const proposal = options.proposal || buildProposal({ context });
  const generated = buildProposal({ context, stage: STAGE.GENERATED });
  const sensitivity = seedSensitivity(context, proposal);
  const [cLat, cLon] = h3.cellToLatLng(context.cover[0]);
  const frame = localFrame(cLat, cLon);
  const l4Geometry = zoneGeometry(context.l4, frame);
  return {
    proposal,
    validation: validateLayout(proposal, context),
    generated: {
      proposal: generated,
      assignmentDigest: assignmentDigest(generated),
      unresolved: generated.unresolved,
      geometry: zoneGeometry(generated, frame),
      validation: validateLayout(generated, context),
      transitions: zoneMap.pathTransitions(generated, { inputs: context.inputs }),
    },
    assignmentDigest: assignmentDigest(proposal),
    check: zoneMap.checkProposal(proposal, { cover: context.cover }),
    geometry: zoneGeometry(proposal, frame),
    adjacency: zoneAdjacency(proposal),
    intraZone: intraZoneRoutes(proposal, context),
    walkways: walkwaysByZone(proposal, context),
    transitions: zoneMap.pathTransitions(proposal, { inputs: context.inputs }),
    facilities: facilityInventory(context, proposal),
    sensitivity,
    robustness: Object.fromEntries(
      proposal.cells
        .filter((row) => row.decision)
        .map((row) => {
          const changesUnder = sensitivity.flatMap((x) => x.changed.filter((c) => c.cellId === row.cellId).map((c) => ({ policy: x.policy, variant: c.variant })));
          return [row.cellId, { seedSensitive: changesUnder.length > 0, changesUnder }];
        }),
    ),
    isolation: regionIsolation(context),
    crossZone: crossZoneDelivery(proposal, context),
    l4: {
      geometry: l4Geometry,
      transitions: zoneMap.pathTransitions(context.l4, { inputs: context.inputs }),
      check: zoneMap.checkProposal(context.l4, { cover: context.cover }),
    },
    context,
  };
}

/* ── Landmarks for display (never ownership) ───────────────────────────────── */

function landmarks(context, proposal) {
  const memberOf = new Map(proposal.zones.flatMap((zone) => zone.members.map((m) => [m.id, zone.id])));
  const out = [];
  for (const f of context.inputs.osm.features) {
    const p = f.properties || {};
    if (f.id === "way/1120154292" || f.geometry.type === "LineString") continue;
    const label = p.name || (p.sport ? "Sports ground (unnamed; sport=cricket;football)" : null) || p.amenity || p.leisure || p.historic || "building (unnamed)";
    out.push({
      type: "Feature",
      id: f.id,
      geometry: f.geometry,
      properties: { role: "LANDMARK", source: f.id, label, sourceKind: "OSM", verification: "OSM only, not site-checked", memberOfProposedZone: memberOf.get(f.id) || null, ownershipNote: "visual landmark; cells are owned by the zone table, not by this outline" },
    });
  }
  for (const f of context.inputs.supplemental.features) {
    const point = { lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] };
    out.push({
      type: "Feature",
      id: `supplemental:${f.properties.id}`,
      geometry: f.geometry,
      properties: { role: "LANDMARK", source: `supplemental:${f.properties.id}`, label: f.properties.name, sourceKind: "USER_SUPPLIED_POINT", verification: f.properties.verificationStatus, insideBoundary: context.containment.containsPoint(point), memberOfProposedZone: null, ownershipNote: "unverified point; not a seed; owns no cell" },
    });
  }
  for (const f of context.inputs.access.features.filter((row) => row.properties.status === "verified").sort((a, b) => byId(a.properties.id, b.properties.id))) {
    out.push({
      type: "Feature",
      id: `access:${f.properties.id}`,
      geometry: f.geometry,
      properties: { role: "VERIFIED_ACCESS_POINT", source: `access:${f.properties.id}`, label: `${f.properties.buildingName} access`, sourceKind: "ACCESS_REGISTER", verification: "verified (OWNER_SITE_CHECK)", memberOfProposedZone: memberOf.get(f.properties.buildingSourceId) || null, ownershipNote: "network seed of its building's zone" },
    });
  }
  return out;
}

/* ═══════════════════════════════════════════════════════════════════════════
   Renderers
   ═══════════════════════════════════════════════════════════════════════════ */

const ZONE_COLOURS = Object.freeze({
  "rnsit-z-west": "#0072B2",
  "rnsit-z-east": "#E69F00",
  "rnsit-z-south": "#009E73",
  "rnsit-z-southwest": "#CC79A7",
});
const UNRESOLVED_COLOUR = "#D7263D";

/** T01–T14 for the pinned L4 ties; C1… for any other cell a connectivity repair moved. */
function tieLabels(proposal) {
  const labels = new Map(proposal.pinnedTies.map((id, i) => [id, `T${String(i + 1).padStart(2, "0")}`]));
  let n = 0;
  for (const row of proposal.cells) if (row.decision && !labels.has(row.cellId)) labels.set(row.cellId, `C${(n += 1)}`);
  return labels;
}

const CONFIDENCE_STROKE = Object.freeze({ HIGH: "#1d232b", MEDIUM: "#7a5a00", LOW: "#D7263D" });
const stageLabel = (report) =>
  report.proposal.stage === STAGE.GENERATED
    ? "GENERATED PROPOSAL"
    : report.validation.passed
      ? "VALIDATED PROPOSAL (offline checks pass)"
      : "DECIDED PROPOSAL — VALIDATION FAILS";

/**
 * The confidence a reader should give a decision: the evidence confidence, capped at MEDIUM when
 * the decision does not survive every seed-sensitivity variant (`report.robustness`).
 */
function confidenceFor(report, row) {
  if (!row.decision) return null;
  const robust = report.robustness && report.robustness[row.cellId];
  if (robust && robust.seedSensitive && row.decision.confidence === "HIGH") return "MEDIUM";
  return row.decision.confidence;
}

function renderGeojson(report) {
  const { proposal, context } = report;
  const ties = tieLabels(proposal);
  const features = [];
  const perimeter = context.inputs.osm.features.find((f) => f.id === "way/1120154292");
  features.push({ type: "Feature", id: "perimeter:way/1120154292", geometry: perimeter.geometry, properties: { role: "CAMPUS_PERIMETER", source: "way/1120154292", note: "Authoritative RNSIT boundary (RD-2026-08-30-01), copied verbatim; unchanged by this proposal" } });
  for (const zone of proposal.zones) {
    const ids = proposal.cells.filter((row) => row.zoneId === zone.id).map((row) => row.cellId);
    const g = report.geometry.find((row) => row.zoneId === zone.id);
    features.push({
      type: "Feature",
      id: `zone:${zone.id}`,
      geometry: { type: "MultiPolygon", coordinates: h3.cellsToMultiPolygon(cells.canonicalCellOrder(ids), true) },
      properties: { role: "PROPOSED_ZONE", status: "PROPOSED — NOT PUBLISHED", zoneId: zone.id, name: zone.name, cellCount: ids.length, components: g.components, colour: ZONE_COLOURS[zone.id] },
    });
  }
  for (const row of proposal.cells) {
    features.push({
      type: "Feature",
      id: `cell:${row.cellId}`,
      geometry: { type: "Polygon", coordinates: [h3.cellToBoundary(row.cellId, true)] },
      properties: {
        role: row.zoneId === null ? "UNRESOLVED_CELL" : row.decision ? "DECIDED_CELL" : "PROPOSED_CELL",
        cellId: row.cellId,
        zoneId: row.zoneId,
        basis: row.basis,
        tieLabel: ties.get(row.cellId) || null,
        competingZones: row.competing || null,
        decision: row.decision
          ? { rule: row.decision.rule, confidence: confidenceFor(report, row), evidenceConfidence: row.decision.confidence, seedSensitive: report.robustness[row.cellId].seedSensitive, from: row.decision.from }
          : null,
        centreInBoundary: row.centreInBoundary,
        insideFraction: row.insideFraction,
        footprintSamples: row.footprintSamples,
        networkM: row.networkM,
        networkMarginM: row.networkMarginM,
        flags: row.flags,
        l4ZoneId: row.l4.zoneId,
      },
    });
  }
  features.push(...landmarks(context, proposal));
  const collection = {
    type: "FeatureCollection",
    name: "rnsit-zone-proposal-g4",
    campusId: "RNSIT",
    generator: { tool: "Backend/tools/campus/rnsitZoneLayoutG4.js", method: proposal.method },
    proposal: {
      layout: proposal.layout,
      stage: proposal.stage,
      validated: report.validation.passed,
      status: proposal.status,
      approved: false,
      published: false,
      notice: `${stageLabel(report)}. Not published, not pinned, not approved by the owner. The published map is still one zone, rnsit-z1.`,
      assignmentDigest: report.assignmentDigest,
      generatedAssignmentDigest: report.generated.assignmentDigest,
      unresolvedCells: proposal.unresolved.length,
      decidedCells: proposal.cells.filter((row) => row.decision).length,
      boundary: proposal.boundary,
    },
    features,
  };
  return `${JSON.stringify(collection, null, 1)}\n`;
}

const esc = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function renderPreview(report) {
  const { proposal, context } = report;
  const ties = tieLabels(proposal);
  const allCorners = proposal.cells.flatMap((row) => h3.cellToBoundary(row.cellId, true));
  const lons = allCorners.map((c) => c[0]);
  const lats = allCorners.map((c) => c[1]);
  const frame = localFrame((Math.min(...lats) + Math.max(...lats)) / 2, (Math.min(...lons) + Math.max(...lons)) / 2);
  const xs = allCorners.map((c) => frame.x(c[0]));
  const ys = allCorners.map((c) => frame.y(c[1]));
  const pad = 12;
  const minX = Math.min(...xs) - pad;
  const maxY = Math.max(...ys) + pad;
  const width = Math.max(...xs) + pad - minX;
  const height = maxY - (Math.min(...ys) - pad);
  const P = ([lon, lat]) => `${(frame.x(lon) - minX).toFixed(1)},${(maxY - frame.y(lat)).toFixed(1)}`;
  const pts = (ring) => ring.map(P).join(" ");
  const at = (lat, lon) => P([lon, lat]).split(",").map(Number);
  const svg = [];

  svg.push(`<defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="${UNRESOLVED_COLOUR}" fill-opacity="0.18"/><line x1="0" y1="0" x2="0" y2="6" stroke="${UNRESOLVED_COLOUR}" stroke-width="2.4"/></pattern></defs>`);
  svg.push('<g id="layer-cells">');
  for (const row of proposal.cells) {
    const ring = h3.cellToBoundary(row.cellId, true);
    const fill = row.zoneId ? ZONE_COLOURS[row.zoneId] : "url(#hatch)";
    const tip = [
      `${row.cellId}${ties.has(row.cellId) ? ` (${ties.get(row.cellId)})` : ""}`,
      `zone: ${row.zoneId || "UNRESOLVED"} — basis ${row.basis}`,
      row.decision ? `decision: ${row.decision.rule} (${confidenceFor(report, row)}${report.robustness[row.cellId].seedSensitive ? ", seed-sensitive" : ""})${row.decision.from ? `, moved from ${row.decision.from}` : ""}` : null,
      row.competing ? `competing at generation: ${row.competing.join(", ")}` : null,
      `inside boundary: ${Math.round(row.insideFraction * 100)}%${row.centreInBoundary ? "" : " (boundary cell)"}`,
      `member footprint samples: ${Object.entries(row.footprintSamples).filter(([, n]) => n > 0).map(([z, n]) => `${z} ${n}`).join(", ") || "none"}`,
      row.networkM ? `walk to zone seeds (m): ${Object.entries(row.networkM).map(([z, d]) => `${z} ${d}`).join(", ")}` : null,
      row.flags.length ? `review flags: ${row.flags.join(", ")}` : null,
      `L4: ${row.l4.zoneId || `tie ${row.l4.nearest.join("|")}`}`,
    ].filter(Boolean).join("\n");
    svg.push(`<polygon class="cell${row.zoneId ? "" : " open"}" points="${pts(ring)}" fill="${fill}" fill-opacity="${row.zoneId ? 0.34 : 1}" stroke="${row.zoneId ? "#5b6470" : UNRESOLVED_COLOUR}" stroke-width="${row.zoneId ? 0.5 : 1.8}"${row.centreInBoundary ? "" : ' stroke-dasharray="3 2"'}><title>${esc(tip)}</title></polygon>`);
  }
  // Decided cells get an inset outline coloured by confidence, drawn after the fills.
  for (const row of proposal.cells.filter((r) => r.decision)) {
    svg.push(`<polygon points="${pts(h3.cellToBoundary(row.cellId, true))}" class="decided" stroke="${CONFIDENCE_STROKE[confidenceFor(report, row)]}"/>`);
  }
  svg.push("</g>");

  svg.push('<g id="layer-cellids" class="cellids">');
  for (const row of proposal.cells) {
    const [x, y] = at(...h3.cellToLatLng(row.cellId));
    const label = ties.get(row.cellId);
    svg.push(`<text x="${x.toFixed(1)}" y="${(y + (label ? 2 : 9)).toFixed(1)}" class="${label ? "tie" : "cid"}">${label ? `${label}` : row.cellId.slice(8, 12)}</text>`);
  }
  svg.push("</g>");

  svg.push('<g id="layer-ways">');
  for (const f of context.inputs.osm.features) {
    const hw = f.properties && f.properties.highway;
    if (!hw || f.geometry.type !== "LineString") continue;
    const permitted = context.roadClasses.includes(hw);
    svg.push(`<polyline points="${pts(f.geometry.coordinates)}" class="way ${permitted ? "permitted" : "other"}"><title>${esc(`${f.id} highway=${hw}${permitted ? "" : " (not a permitted class)"}`)}</title></polyline>`);
  }
  svg.push("</g>");

  svg.push('<g id="layer-landmarks">');
  const memberOf = new Map(proposal.zones.flatMap((zone) => zone.members.map((m) => [m.id, zone.id])));
  for (const f of context.inputs.osm.features) {
    if (f.id === "way/1120154292" || f.geometry.type !== "Polygon") continue;
    const p = f.properties || {};
    const label = p.name || (p.sport ? "Sports ground" : "") || p.amenity || p.leisure || "";
    svg.push(`<polygon points="${pts(f.geometry.coordinates[0])}" class="footprint${memberOf.has(f.id) ? " member" : ""}"><title>${esc(`${label || "unnamed building"} — ${f.id}\n${memberOf.has(f.id) ? `member of ${memberOf.get(f.id)}` : "landmark only (owns no cell)"}`)}</title></polygon>`);
    if (label) {
      const c = areaCentroid(f);
      const [x, y] = at(c.lat, c.lon);
      svg.push(`<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" class="fplabel">${esc(label.length > 26 ? `${label.slice(0, 25)}…` : label)}</text>`);
    }
  }
  for (const f of context.inputs.supplemental.features) {
    const [x, y] = at(f.geometry.coordinates[1], f.geometry.coordinates[0]);
    const inside = context.containment.containsPoint({ lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] });
    svg.push(`<g class="sup${inside ? "" : " outside"}"><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.2"/><text x="${(x + 4.5).toFixed(1)}" y="${(y + 3).toFixed(1)}">${esc(f.properties.name)}${inside ? "" : " (outside)"}</text><title>${esc(`${f.properties.name} — user-supplied point, ${f.properties.verificationStatus}${inside ? "" : ", OUTSIDE the boundary"}; landmark only`)}</title></g>`);
  }
  for (const f of context.inputs.access.features.filter((row) => row.properties.status === "verified")) {
    const [x, y] = at(f.geometry.coordinates[1], f.geometry.coordinates[0]);
    svg.push(`<rect x="${(x - 2.4).toFixed(1)}" y="${(y - 2.4).toFixed(1)}" width="4.8" height="4.8" class="ap"><title>${esc(`${f.properties.buildingName} — verified access point ${f.properties.id}`)}</title></rect>`);
  }
  svg.push("</g>");

  svg.push('<g id="layer-zones">');
  for (const zone of proposal.zones) {
    const ids = proposal.cells.filter((row) => row.zoneId === zone.id).map((row) => row.cellId);
    for (const polygon of h3.cellsToMultiPolygon(cells.canonicalCellOrder(ids), true)) {
      for (const ring of polygon) svg.push(`<polygon points="${pts(ring)}" class="zoneline" stroke="${ZONE_COLOURS[zone.id]}"/>`);
    }
  }
  for (const zone of proposal.zones) {
    const ids = proposal.cells.filter((row) => row.zoneId === zone.id).map((row) => row.cellId);
    const own = new Set(ids);
    const label = cells.canonicalCellOrder(ids).map((id) => [id, cells.diskAround(id, 1).filter((n) => own.has(n)).length]).sort((a, b) => b[1] - a[1])[0][0];
    const [x, y] = at(...h3.cellToLatLng(label));
    const short = zone.name.split(" — ")[0].replace("RNSIT ", "");
    svg.push(`<g class="zonelabel"><text x="${x.toFixed(1)}" y="${(y - 4).toFixed(1)}" fill="${ZONE_COLOURS[zone.id]}">${esc(short)}</text><text x="${x.toFixed(1)}" y="${(y + 8).toFixed(1)}" class="zid" fill="${ZONE_COLOURS[zone.id]}">${esc(zone.id)} · ${ids.length} cells</text></g>`);
  }
  svg.push("</g>");

  const perimeter = context.inputs.osm.features.find((f) => f.id === "way/1120154292");
  svg.push(`<polygon id="layer-perimeter" points="${pts(perimeter.geometry.coordinates[0])}" class="perimeter"><title>Authoritative perimeter way/1120154292 (unchanged)</title></polygon>`);

  const zoneRows = proposal.zones.map((zone) => {
    const g = report.geometry.find((row) => row.zoneId === zone.id);
    return `<tr><td><span class="sw" style="background:${ZONE_COLOURS[zone.id]}"></span><code>${esc(zone.id)}</code></td><td>${esc(zone.name.split(" — ")[1] || zone.name)}</td><td class="n">${g.cells}</td><td class="n">${g.components}</td></tr>`;
  });
  const tieRows = [...ties.keys()].map((id) => {
    const row = proposal.cells.find((r) => r.cellId === id);
    const zone = row.zoneId
      ? `<span class="sw" style="background:${ZONE_COLOURS[row.zoneId]}"></span>${row.zoneId.replace("rnsit-z-", "")}`
      : `<b style="color:${UNRESOLVED_COLOUR}">OPEN</b> (${esc(row.competing.map((z) => z.replace("rnsit-z-", "")).join(" · "))})`;
    const rule = row.decision ? `${row.decision.rule.split("_")[0]} · <span style="color:${CONFIDENCE_STROKE[confidenceFor(report, row)]}">${confidenceFor(report, row)}</span>` : "—";
    return `<tr><td>${ties.get(id)}</td><td><code>${id.slice(8, 12)}</code></td><td>${zone}</td><td>${rule}</td></tr>`;
  });

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>RNSIT Zone Proposal G4</title>
<!-- GENERATED by Backend/tools/campus/rnsitZoneLayoutG4.js — do not edit by hand. Offline: no scripts or tiles are fetched. -->
<style>
:root { --bg:#fbfbf9; --fg:#1d232b; --muted:#5b6470; --line:#d9dde3; --panel:#ffffff; --warn:${UNRESOLVED_COLOUR}; }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
header { padding:14px 16px 10px; border-bottom:1px solid var(--line); background:var(--panel); }
h1 { margin:0 0 4px; font-size:18px; }
.banner { display:inline-block; margin-top:4px; padding:3px 8px; border:1.5px solid var(--warn); color:var(--warn); font-weight:600; border-radius:4px; font-size:12.5px; }
main { display:grid; grid-template-columns:minmax(0,1fr) 340px; gap:0; }
@media (max-width: 900px) { main { grid-template-columns:1fr; } }
#map { padding:8px 16px; }
#map svg { width:100%; height:auto; background:#fff; border:1px solid var(--line); }
aside { padding:12px 16px; border-left:1px solid var(--line); background:var(--panel); }
aside h2 { font-size:14px; margin:14px 0 6px; }
table { border-collapse:collapse; width:100%; font-size:12.5px; }
td, th { padding:3px 4px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top; }
td.n { text-align:right; font-variant-numeric:tabular-nums; }
.sw { display:inline-block; width:10px; height:10px; margin-right:5px; border-radius:2px; vertical-align:-1px; }
label { display:block; font-size:13px; margin:2px 0; }
.legend div { margin:3px 0; font-size:12.5px; }
.muted { color:var(--muted); font-size:12.5px; }
svg text { font-family:system-ui, sans-serif; text-anchor:middle; pointer-events:none; }
.cid { font-size:5.5px; fill:#59606b; }
.tie { font-size:8px; font-weight:700; fill:var(--warn); paint-order:stroke; stroke:#fff; stroke-width:2px; }
.way { fill:none; stroke-linecap:round; stroke-linejoin:round; }
.way.permitted { stroke:#3d4652; stroke-width:1.6; }
.way.other { stroke:#9aa1ab; stroke-width:1.1; stroke-dasharray:3 2; }
.footprint { fill:#1d232b; fill-opacity:0.07; stroke:#1d232b; stroke-width:0.7; }
.footprint.member { fill-opacity:0.13; stroke-width:0.9; }
.fplabel { font-size:6.2px; font-weight:600; fill:#1d232b; paint-order:stroke; stroke:#fff; stroke-width:1.8px; }
.sup circle { fill:#fff; stroke:#6a3d9a; stroke-width:1.2; }
.sup text { font-size:5.6px; fill:#6a3d9a; text-anchor:start; paint-order:stroke; stroke:#fff; stroke-width:1.6px; }
.sup.outside circle { stroke:#999; stroke-dasharray:1.5 1; }
.sup.outside text { fill:#888; }
.ap { fill:#1d232b; stroke:#fff; stroke-width:0.6; }
.zoneline { fill:none; stroke-width:2.6; stroke-linejoin:round; }
.zonelabel text { font-size:10px; font-weight:800; paint-order:stroke; stroke:#fff; stroke-width:3px; }
.zonelabel .zid { font-size:6.5px; font-weight:600; }
.perimeter { fill:none; stroke:#111; stroke-width:2.2; }
.decided { fill:none; stroke-width:1.6; stroke-dasharray:4 2; }
</style>
</head>
<body>
<header>
<h1>RNSIT four-zone proposal G4</h1>
<div class="muted">Geometry-led layout over the authoritative perimeter <code>way/1120154292</code> (unchanged). Assignment digest <code>${report.assignmentDigest.slice(0, 16)}…</code></div>
<div class="banner">${esc(stageLabel(report))} — NOT PUBLISHED, NOT PINNED, NOT APPROVED · ${proposal.unresolved.length} cells unresolved · published map is still one zone (rnsit-z1)</div>
</header>
<main>
<div id="map">
<svg viewBox="0 0 ${width.toFixed(0)} ${height.toFixed(0)}" role="img" aria-label="RNSIT campus with four proposed zones and ${proposal.unresolved.length} unresolved cells">
${svg.join("\n")}
</svg>
<p class="muted">Hover a cell for its basis, decision rule, footprint evidence, walking distances and review flags. Dashed hexagons are boundary cells (centre outside the perimeter; index-only). <b>T01–T14</b> are the L4 ties and <b>C1…</b> cells moved by connectivity repair; their inset dashed outline shows the decision's confidence. Red hatched hexagons would be cells still open.</p>
</div>
<aside>
<h2>Layers</h2>
<label><input type="checkbox" data-layer="layer-cells" checked> Cell ownership</label>
<label><input type="checkbox" data-layer="layer-zones" checked> Zone boundaries &amp; labels</label>
<label><input type="checkbox" data-layer="layer-landmarks" checked> Landmarks (display only)</label>
<label><input type="checkbox" data-layer="layer-ways" checked> Walkways / service ways</label>
<label><input type="checkbox" data-layer="layer-cellids" checked> Cell ids / tie labels</label>
<h2>Proposed zones</h2>
<table><tr><th>ID</th><th>Contents</th><th class="n">Cells</th><th class="n">Parts</th></tr>
${zoneRows.join("\n")}
<tr><td><span class="sw" style="background:${UNRESOLVED_COLOUR}"></span>unresolved</td><td>owner decision needed</td><td class="n">${proposal.unresolved.length}</td><td></td></tr>
</table>
<h2>Decided and open cells</h2>
<table><tr><th>Cell</th><th></th><th>Zone</th><th>Rule · confidence</th></tr>
${tieRows.join("\n")}</table>
<h2>Legend</h2>
<div class="legend">
<div><svg width="22" height="10"><line x1="0" y1="5" x2="22" y2="5" stroke="#111" stroke-width="2.4"/></svg> authoritative perimeter</div>
<div><svg width="22" height="10"><rect width="22" height="10" fill="#1d232b" fill-opacity="0.13" stroke="#1d232b" stroke-width="0.9"/></svg> zone member footprint</div>
<div><svg width="22" height="10"><rect width="22" height="10" fill="#1d232b" fill-opacity="0.07" stroke="#1d232b" stroke-width="0.7"/></svg> landmark only (owns no cell)</div>
<div><svg width="22" height="10"><rect x="8" y="2" width="6" height="6" fill="#1d232b"/></svg> site-verified access point (seed)</div>
<div><svg width="22" height="10"><circle cx="11" cy="5" r="3.5" fill="#fff" stroke="#6a3d9a" stroke-width="1.2"/></svg> user-supplied point, UNVERIFIED (landmark only)</div>
<div><svg width="22" height="10"><line x1="0" y1="5" x2="22" y2="5" stroke="#3d4652" stroke-width="1.6"/></svg> permitted way (footway / path / service)</div>
<div><svg width="22" height="10"><rect x="1" y="1" width="20" height="8" fill="none" stroke="${CONFIDENCE_STROKE.HIGH}" stroke-width="1.6" stroke-dasharray="4 2"/></svg> decided cell, HIGH confidence</div>
<div><svg width="22" height="10"><rect x="1" y="1" width="20" height="8" fill="none" stroke="${CONFIDENCE_STROKE.MEDIUM}" stroke-width="1.6" stroke-dasharray="4 2"/></svg> decided cell, MEDIUM confidence</div>
<div><svg width="22" height="10"><rect x="1" y="1" width="20" height="8" fill="none" stroke="${CONFIDENCE_STROKE.LOW}" stroke-width="1.6" stroke-dasharray="4 2"/></svg> decided cell, LOW confidence (instruments disagree)</div>
</div>
<p class="muted">Source: <code>rnsit-zone-proposal-g4.geojson</code>; report: <code>RNSIT_ZONE_LAYOUT_G4_PROPOSAL.md</code>. No Library or Playground outline exists in the data, so none is drawn.</p>
</aside>
</main>
<script>
for (const box of document.querySelectorAll("input[data-layer]")) {
  box.addEventListener("change", () => { const g = document.getElementById(box.dataset.layer); if (g) g.style.display = box.checked ? "" : "none"; });
}
</script>
</body>
</html>
`;
}

function mdTable(header, rows) {
  return [`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
}

/** A share as a percentage: one decimal below 1 %, whole numbers above. */
const pct = (share) => (share * 100 < 1 ? (share * 100).toFixed(1) : String(Math.round(share * 100)));

function renderEvidence(report) {
  const { proposal } = report;
  const ties = tieLabels(proposal);
  const short = (id) => (id ? id.replace("rnsit-z-", "") : "—");
  const out = [];
  out.push("# RNSIT four-zone layout G4 — generated evidence");
  out.push("");
  out.push("Generated by `Backend/tools/campus/rnsitZoneLayoutG4.js --write`. Do not edit by hand; `--check` reports staleness.");
  out.push("");
  out.push(`**${stageLabel(report)} — NOT PUBLISHED, NOT PINNED, NOT APPROVED BY THE OWNER.** Stage \`${proposal.stage}\`, status \`${proposal.status}\`, \`approved: false\`, \`published: false\`. The published map is still one zone, \`rnsit-z1\`.`);
  out.push("");
  out.push(`- Validated assignment digest \`${report.assignmentDigest}\`; generated (pre-decision) digest \`${report.generated.assignmentDigest}\`.`);
  out.push(`- Boundary \`${proposal.boundary.way}\`, file sha256 \`${proposal.boundary.sha256}\`.`);
  out.push(`- Method: pinned L4 ties → member-footprint area (res-${proposal.method.sampleResolution} samples) → walking distance on the ${proposal.method.network}; then decision rules R1–R4 (${DECISION_AUTHORITY}). Review thresholds (flags only): footprint share < ${proposal.method.reviewThresholds.lowFootprintShare * 100} %, network margin < ${proposal.method.reviewThresholds.lowNetworkMarginM} m.`);
  out.push("");

  out.push("## 1. Zones (validated stage)");
  out.push("");
  out.push(mdTable(
    ["Zone", "Name", "Cells", "Generated stage", "Boundary cells", "H3 parts", "Walk-network parts", "Area of cells m²", "Polsby–Popper", "Extent m"],
    report.geometry.map((g) => {
      const zone = proposal.zones.find((z) => z.id === g.zoneId);
      const gen = report.generated.geometry.find((x) => x.zoneId === g.zoneId);
      return [`\`${g.zoneId}\``, zone.name, g.cells, gen.cells, g.boundaryCells, g.components, (report.validation.walk[g.zoneId] || []).length, g.areaM2, g.polsbyPopper, g.extentM];
    }),
  ));
  out.push("");
  out.push(`Unresolved: **${proposal.unresolved.length}**${proposal.unresolved.length ? ` (${proposal.unresolved.map((id) => `${ties.get(id) || ""} \`${id}\``).join(", ")})` : ""}. Decided by rule: **${proposal.cells.filter((r) => r.decision).length}**. Total ${proposal.cells.length} cells.`);
  out.push("");
  out.push("### Zone adjacency (shared H3 edges)");
  out.push("");
  out.push(mdTable(["Pair", "Shared edges"], report.adjacency.map((a) => [a.pair.split("|").map(short).join(" · "), a.sharedEdges])));
  out.push("");
  for (const zone of proposal.zones) {
    const g = report.geometry.find((row) => row.zoneId === zone.id);
    const intra = report.intraZone.find((row) => row.zoneId === zone.id);
    const zoneCells = proposal.cells.filter((row) => row.zoneId === zone.id);
    const count = (basis) => zoneCells.filter((r) => r.basis === basis).length;
    out.push(`### \`${zone.id}\` — ${zone.name}`);
    out.push("");
    out.push(`- **Cells:** ${g.cells} — ${count(BASIS.FOOTPRINT)} by footprint, ${count(BASIS.NETWORK)} by walk distance, ${count(BASIS.EVIDENCE_DECISION)} by decision rule, ${count(BASIS.CONNECTIVITY_REPAIR)} by connectivity repair, ${count(BASIS.OVERRIDE)} by owner override; ${g.boundaryCells} boundary cells; ${g.components} H3 part(s).`);
    out.push(`- **Member footprints:** ${zone.members.map((m) => `${m.label} (\`${m.id}\`)`).join("; ")}.`);
    out.push(`- **Seeds:** ${zone.seeds.length} — ${zone.seeds.filter((x) => x.evidence.startsWith("access:")).length} site-verified access points, ${zone.seeds.filter((x) => x.evidence.startsWith("osm-centroid:")).length} footprint centroids.`);
    const ways = (report.walkways[zone.id] || []).filter((w) => w.metres >= 10);
    out.push(`- **Walkways (≥ 10 m inside):** ${ways.map((w) => `\`${w.id}\` ${w.highway} ${w.metres} m`).join("; ") || "none"}.`);
    const parts = report.validation.walk[zone.id] || [];
    out.push(`- **Walk network:** ${parts.length} connected part(s): ${parts.map((p) => `${p.lengthM} m over ${p.ways.length} way(s)`).join("; ")}.`);
    out.push(
      `- **Shortest walks between its seeds:** ${intra.seedPairs}: ${intra.seedPairs - intra.routesThroughOpenCellsOnly - intra.routesThroughAnotherZone} stay inside, ` +
        `${intra.routesThroughOpenCellsOnly} leave only through open cells, ${intra.routesThroughAnotherZone} pass through another zone${intra.otherZones.length ? ` (${intra.otherZones.map(short).join(", ")})` : ""}. ` +
        "A shortest walk may cut through a neighbour even when an inside path exists; the walk-network part count is the connectivity test.",
    );
    const flagged = zoneCells.filter((r) => r.flags.some((f) => f !== FLAG.BOUNDARY_CELL));
    out.push(`- **Review flags:** ${flagged.map((r) => `\`${r.cellId}\` ${r.flags.filter((f) => f !== FLAG.BOUNDARY_CELL).join("+")}`).join("; ") || "none"}.`);
    out.push("");
  }

  out.push("## 2. Ownership decisions — every pinned tie and every repaired cell");
  out.push("");
  out.push("Rules (applied in order, deterministically): **R1** the tie borders exactly one proposed zone; **R2** member footprint and walk distance name the same competing zone; **R3** connectivity repair — a border cell joins a zone's split walk network without splitting or disconnecting the donor; **R4** the only competing zone that keeps every zone's walk network and every zone contiguous. Confidence: HIGH = all evidence agrees and is strong; MEDIUM = agrees but weak, or decided by connectivity; LOW = an instrument disagrees. A HIGH decision that does not survive every seed-sensitivity variant (§5) is shown as MEDIUM.");
  out.push("");
  const evidence = report.tieEvidence || [];
  const labelOf = osmLabels(report.context);
  out.push(mdTable(
    ["Cell", "", "What is in it", "Competing at generation", "Footprint points to", "Walk points to (margin m)", "Decision", "Rule", "Confidence", "Survives every seed variant", "Note"],
    [...ties.keys()].map((id) => {
      const row = proposal.cells.find((r) => r.cellId === id);
      const e = evidence.find((t) => t.cellId === id) || { outlines: [], points: [], access: [], walkways: [] };
      const places = describePlaces(e, labelOf);
      const fp = Object.entries(row.footprintSamples).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).map(([z, n]) => `${short(z)} (${pct(n / row.insideSamples)} %)`).join(", ") || "none";
      const walkOrder = Object.entries(row.networkM).sort((a, b) => a[1] - b[1]);
      const decision = row.zoneId ? `**${short(row.zoneId)}**${row.decision && row.decision.from ? ` (was ${short(row.decision.from)})` : ""}` : "**OPEN**";
      const note =
        row.decision && confidenceFor(report, row) === "LOW"
          ? `instruments disagree — owner review${e.points.length ? "; site survey recommended for the unverified points" : ""}`
          : row.decision && row.decision.rule === RULE.R1_SINGLE_NEIGHBOUR
            ? "only neighbour"
            : row.zoneId === null
              ? "owner override or site survey needed"
              : "—";
      return [
        ties.get(id),
        `\`${id}\``,
        evidence.some((t) => t.cellId === id) ? places.text : "(not an L4 tie)",
        row.competing ? row.competing.map(short).join(" · ") : `assigned ${short(row.decision && row.decision.from)} at generation`,
        fp,
        `${short(walkOrder[0][0])} (${row.networkMarginM})`,
        decision,
        row.decision ? row.decision.rule : "—",
        row.decision ? confidenceFor(report, row) : "—",
        row.decision ? (report.robustness[id].seedSensitive ? `no — ${report.robustness[id].changesUnder.map((c) => `${c.policy}: ${c.variant ? short(c.variant) : "open"}`).join("; ")}` : "yes") : "—",
        note,
      ];
    }),
  ));
  out.push("");

  const renderChecks = (title, v) => {
    out.push(title);
    out.push("");
    out.push(mdTable(["Check", "Result", "Detail"], v.checks.map((c) => [`\`${c.id}\``, c.passed ? "PASS" : "**FAIL**", c.detail])));
    out.push("");
  };
  out.push("## 3. Validation");
  out.push("");
  renderChecks(`### Validated stage — ${report.validation.passed ? "all checks pass" : "CHECKS FAIL"}`, report.validation);
  renderChecks(`### Generated stage (before R1–R4), for comparison — ${report.generated.validation.passed ? "all checks pass" : "fails"}`, report.generated.validation);
  out.push("### Site-verified access points: where each joins the walk network");
  out.push("");
  out.push(mdTable(["Access point", "Building", "Building's zone", "Joins the network in", "Way", "Distance m"], report.validation.access.map((a) => [`\`${a.id}\``, a.building, short(a.zone), short(a.joinsNetworkIn), `\`${a.way}\``, a.distanceM])));
  out.push("");

  out.push("## 4. Every cell");
  out.push("");
  out.push(mdTable(
    ["Cell", "Zone", "Basis", "Rule (confidence)", "Inside %", "Footprint leader", "Walk leader (margin m)", "Flags", "L4"],
    proposal.cells.map((row) => [
      `\`${row.cellId}\`${ties.has(row.cellId) ? ` ${ties.get(row.cellId)}` : ""}`,
      row.zoneId ? short(row.zoneId) : "**UNRESOLVED**",
      row.basis,
      row.decision ? `${row.decision.rule.split("_")[0]} (${confidenceFor(report, row)})` : "—",
      Math.round(row.insideFraction * 100),
      row.footprintLeader ? row.footprintLeader.split("|").map(short).join("\\|") : "—",
      row.networkLeader ? `${row.networkLeader.split("|").map(short).join("\\|")} (${row.networkMarginM})` : "—",
      row.flags.join(", ") || "—",
      row.l4.zoneId || `tie ${row.l4.nearest.join("\\|")}`,
    ]),
  ));
  out.push("");

  out.push("## 5. Structure, paths and sensitivity");
  out.push("");
  out.push(`- \`rnsitZoneMap.checkProposal\` (the L4 checker, unchanged): complete **${report.check.complete}**; findings: ${report.check.findings.map((f) => `\`${f.id}\``).join(", ") || "none"}.`);
  out.push(`- Cover ${proposal.cells.length} cells (${proposal.cells.filter((r) => r.centreInBoundary).length} centre-inside, ${proposal.cells.filter((r) => !r.centreInBoundary).length} boundary). Region isolation: JSSATE cover ${report.isolation.jssateCoverCells} cells, shared ${report.isolation.sharedCells.length}; campuses ≈${report.isolation.approxSeparationM} m apart.`);
  out.push("");
  out.push("### Path transitions (zone changes along each permitted way)");
  out.push("");
  const sumT = (t) => t.ways.reduce((a, w) => a + w.transitions, 0);
  const sumU = (t) => t.ways.reduce((a, w) => a + w.unresolvedCells, 0);
  const tRow = (name, t) => [name, t.ways.length, sumT(t), Math.max(...t.ways.map((w) => w.transitions)), sumU(t)];
  out.push(mdTable(["Layout", "Ways", "Total transitions", "Max on one way", "Open cells crossed"], [
    tRow("G4 validated", report.transitions),
    tRow("G4 generated", report.generated.transitions),
    tRow("L4", report.l4.transitions),
  ]));
  out.push("");
  out.push(mdTable(["Way", "Class", "G4 zone sequence", "Transitions"], report.transitions.ways.map((w) => [`\`${w.id}\``, w.highway, w.zones.map((z) => (z === BASIS.UNRESOLVED_TIE ? "OPEN" : z === "OUTSIDE_COVER" ? "out" : short(z))).join(" → "), w.transitions])));
  out.push("");
  out.push("### G4 against L4");
  out.push("");
  out.push(mdTable(["Layout", "Zone", "Cells", "Parts", "Polsby–Popper", "Extent m"], [
    ...report.geometry.map((g) => ["G4 validated", short(g.zoneId), g.cells, g.components, g.polsbyPopper, g.extentM]),
    ...report.generated.geometry.map((g) => ["G4 generated", short(g.zoneId), g.cells, g.components, g.polsbyPopper, g.extentM]),
    ...report.l4.geometry.map((g) => ["L4", g.zoneId, g.cells, g.components, g.polsbyPopper, g.extentM]),
  ]));
  out.push("");
  out.push("### Seed sensitivity");
  out.push("");
  out.push("Each row rebuilds the validated proposal (decision rules included) with different network seeds and lists every cell whose owner changes.");
  out.push("");
  out.push(mdTable(["Seed policy", "Cells that change owner"], report.sensitivity.map((x) => [
    `\`${x.policy}\``,
    x.changed.map((c) => `\`${c.cellId}\` ${short(c.baseline)} → ${short(c.variant)}`).join("; ") || "none",
  ])));
  out.push("");

  out.push("## 6. Campus facilities in the source data");
  out.push("");
  out.push(mdTable(["Facility", "What the data supports", "Features (source · geometry · verification · inside · G4 member of)"], report.facilities.map((f) => [
    f.facility,
    f.status,
    f.found.map((r) => `${r.name} (\`${r.source}\` · ${r.geometry} · ${r.verification} · ${r.insideBoundary ? "inside" : "**outside**"} · ${r.zone ? short(r.zone) : "—"})`).join("<br>") || "—",
  ])));
  out.push("");

  out.push("## 7. Cross-zone obstacle awareness (offline model)");
  out.push("");
  const cz = report.crossZone;
  out.push(`${cz.routes} simulated routes (every ordered pair of ${cz.endpoints} endpoints: the 18 site-verified access points and the V1 depot, on the simulator's network), each observed at every route vertex but the last: **${cz.robotMoments} robot moments**, × ${cz.obstacles} obstacle cells. A moment is relevant when its REMAINING route meets the obstacle's cell footprint. ZONE_PLUS_ROUTE is the adopted policy (\`src/services/dtaroRecipientPolicy.selectRecipients\`, wired into \`dtaroZoneAlert.processReport\` on 2026-10-23 with server-side OFFER routes; G4 itself is not published).`);
  out.push("");
  const czRow = (name, t) => [name, t.relevant, t.deliveredSameZone, t.deliveredCrossZone, t.missed, Object.entries(t.missedBy).map(([k, v]) => `${k} ${v}`).join(", ") || "—", t.unnecessary, t.messages];
  out.push(mdTable(["Map · recipients", "Relevant", "Warned (same zone)", "Warned (cross-zone)", "Missed", "Missed because", "Warned, not relevant", "Messages"], [
    czRow("Published single zone · zone room (live today)", cz.PUBLISHED_SINGLE_ZONE.ZONE_ONLY),
    czRow("G4 · zone room only (live rule)", cz.G4.ZONE_ONLY),
    czRow("G4 · zone room + remaining-route intersection (adopted policy)", cz.G4.ZONE_PLUS_ROUTE),
  ]));
  out.push("");
  out.push("Cross-zone warnings the adopted policy must add under G4 (robot's zone → obstacle's zone):");
  out.push("");
  out.push(mdTable(["Robot's zone", "Obstacle's zone", "Relevant moments"], cz.missedAcrossZones.map((m) => [short(m.robotZone), short(m.obstacleZone), m.count])));
  out.push("");
  out.push("## 8. Outstanding owner decisions");
  out.push("");
  for (const q of proposal.outstandingOwnerDecisions) out.push(`- ${q}`);
  out.push("");
  return out.join("\n");
}

/** OSM id → a readable label (the sports ground is unnamed in OSM; it is labelled by its tags). */
function osmLabels(context) {
  const out = new Map();
  for (const f of context.inputs.osm.features) {
    const p = f.properties || {};
    out.set(f.id, p.name || (p.sport ? "Sports ground (unnamed)" : null) || (p.amenity ? `${p.amenity} (unnamed)` : null) || "building (unnamed)");
  }
  return out;
}

/** What the L4 tie evidence found in a cell, relabelled, split into named places and the rest. */
function describePlaces(e, labelOf) {
  const outlines = e.outlines.map((entry) => {
    const id = (entry.match(/\((way\/\d+)\)$/) || [])[1];
    return id ? { id, label: labelOf.get(id) } : { id: null, label: entry };
  });
  const named = [
    ...outlines.filter((o) => !/\(unnamed\)$/.test(o.label)).map((o) => o.label),
    ...e.points.map((p) => p.replace(" (user-supplied point)", " (unverified point)")),
    ...e.access,
  ];
  const unnamed = outlines.filter((o) => /\(unnamed\)$/.test(o.label)).map((o) => `${o.label.replace(" (unnamed)", "")} ${o.id}`);
  const parts = [...named, ...(unnamed.length ? [`unnamed: ${unnamed.join(", ")}`] : []), ...(e.walkways.length ? [`ways: ${e.walkways.join(", ")}`] : [])];
  return { named, walkways: e.walkways, text: parts.join("; ") || "nothing mapped" };
}

/* ═══════════════════════════════════════════════════════════════════════════
   CLI
   ═══════════════════════════════════════════════════════════════════════════ */

function renderAll(report) {
  return {
    [OUTPUT_FILES.geojson]: renderGeojson(report),
    [OUTPUT_FILES.preview]: renderPreview(report),
    [OUTPUT_FILES.evidence]: renderEvidence(report),
  };
}

/** Build everything the review files are rendered from, tie evidence included. */
function fullReport() {
  const report = buildReport();
  // The L4 tie-evidence tool describes the pinned cells' contents; G4 reuses it verbatim.
  report.tieEvidence = require("./rnsitZoneTieEvidence").buildTieEvidence().ties;
  return report;
}

const normalise = (text) => text.replace(/\r\n/g, "\n");

/** @returns {{ file: string, upToDate: boolean }[]} */
function checkOutputs(report = fullReport(), directory = OUTPUT_DIR) {
  return Object.entries(renderAll(report)).map(([name, text]) => {
    const file = path.join(directory, name);
    const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    return { file, upToDate: current !== null && normalise(current) === normalise(text) };
  });
}

module.exports = {
  LAYOUT,
  BASIS,
  FLAG,
  RULE,
  STAGE,
  SEED_POLICY,
  SENSITIVITY_POINTS,
  STATUS,
  PROPOSED_ZONES,
  BOUNDARY_RATIONALE,
  REVIEW_THRESHOLDS,
  OUTPUT_DIR,
  OUTPUT_FILES,
  EXPECTED_PINNED_TIES,
  loadContext,
  buildProposal,
  walkPieces,
  walkNetworks,
  validateLayout,
  confidenceFor,
  buildReport,
  fullReport,
  assignmentDigest,
  components,
  zoneGeometry,
  zoneAdjacency,
  facilityInventory,
  seedSensitivity,
  regionIsolation,
  partialSpatialMap,
  crossZoneDelivery,
  renderAll,
  checkOutputs,
};

if (require.main === module) {
  const report = fullReport();
  if (report.proposal.approved || report.proposal.published) {
    process.stderr.write("The proposal claims approval or publication; this tool never produces either. Nothing written.\n");
    process.exit(1);
  }
  if (process.argv.includes("--check")) {
    const results = checkOutputs(report);
    for (const r of results) process.stdout.write(`${r.upToDate ? "up to date" : "STALE"}  ${r.file}\n`);
    process.exit(results.every((r) => r.upToDate) ? 0 : 1);
  } else if (process.argv.includes("--write")) {
    for (const [name, text] of Object.entries(renderAll(report))) {
      fs.writeFileSync(path.join(OUTPUT_DIR, name), text);
      process.stdout.write(`wrote ${path.join(OUTPUT_DIR, name)}\n`);
    }
    process.stdout.write(`assignment digest ${report.assignmentDigest}; unresolved ${report.proposal.unresolved.length}\n`);
  } else {
    const { proposal } = report;
    process.stdout.write(`${JSON.stringify({
      layout: proposal.layout,
      status: proposal.status,
      approved: proposal.approved,
      published: proposal.published,
      assignmentDigest: report.assignmentDigest,
      zones: report.geometry,
      unresolved: proposal.unresolved,
      stage: proposal.stage,
      validated: report.validation.passed,
      failedChecks: report.validation.checks.filter((c) => !c.passed).map((c) => c.id),
      decisions: proposal.cells.filter((r) => r.decision).map((r) => ({ cellId: r.cellId, zoneId: r.zoneId, rule: r.decision.rule, confidence: confidenceFor(report, r), seedSensitive: report.robustness[r.cellId].seedSensitive, from: r.decision.from })),
      crossZone: { singleZone: report.crossZone.PUBLISHED_SINGLE_ZONE, g4: report.crossZone.G4 },
    }, null, 2)}\n`);
  }
}
