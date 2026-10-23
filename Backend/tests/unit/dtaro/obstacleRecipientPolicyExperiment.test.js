"use strict";

/**
 * DTARO Step 4 — OFFLINE recipient-policy measurement. Test-only; owner-authorised for
 * measurement only.
 *
 * ── What this is NOT ─────────────────────────────────────────────────────────
 *   · Not a production policy. None of the three candidates below is approved (OD-2 is OPEN,
 *     see docs/audits/dtaro-zone-coordination/DTARO_OBSTACLE_POLICY_DECISIONS.md).
 *   · Not a validation of production dissemination, of real robot relevance, or of real-world
 *     false-negative rates. The counts are properties of THIS synthetic fixture only.
 *   · Not a threshold choice. The distances below are a sweep fixed before any result was seen;
 *     none is proposed for production (OD-5 is OPEN).
 *   · Not comparable to the DTARO paper's reported numbers.
 *
 * ── What is production, and what is test-only ───────────────────────────────
 * PRODUCTION, read-only: `engine/spatial/cells` (H3 cell ids, centres, disks) and
 * `engine/spatial/hierarchy` (`indexMap().resolve()` for zone/region, `validateForPublish()`).
 * Zone and region membership is ALWAYS resolved through a published cell assignment (ADR-28):
 * point → `cellForPoint(…, FINE)` → `resolve(cell)`. No bounding box is consulted.
 * TEST-ONLY: the fixture builder, the three candidate policies, the ground-truth distance rule
 * and the confusion-matrix arithmetic. No production dissemination code is imported.
 *
 * ── Owner clarifications applied (2026-10-22) ───────────────────────────────
 *   · Policy 2's "zone on their active route" = the published zone of the cell under EVERY
 *     route waypoint (routes are waypoint lists, as the OFFER's stopSequence[].path is).
 *   · Policy 3 uses the SAME distance d as the ground truth, so within a region it is correct by
 *     construction. It is an oracle-style REFERENCE, not a competitor: what it measures is the
 *     cost of region-bounding, and it shows what the zone policies give up against it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * FIXTURE
 * ═══════════════════════════════════════════════════════════════════════════
 * Coordinate system. Each region has an origin (lat, lon). Fixture geometry is declared in a
 * local metric frame: x metres east, y metres north of that origin. The frame is equirectangular:
 *   lat = originLat + y / M_LAT,   lon = originLon + x / M_LON(originLat)
 * The ground-truth distance is measured in this same frame, so the declared metric distances
 * below are exact for the ground truth. H3 resolution uses the converted (lat, lon).
 *
 * Regions (synthetic): A at (12.9000, 77.5000); B 3 000 m east of A. Each region's published
 * cell set is the H3 res-11 disk of radius K = 18 around its origin cell (~600 m+ in every
 * direction), every cell FINE, every cell assigned to exactly one zone.
 *
 * Zones — assigned at map CONSTRUCTION by the latitude band of each cell's centre (a publish-time
 * rule, as a real map is authored; resolution afterwards is by assignment only):
 *   A-z1 "Zone 1"  y < −150      A-z2 "Zone 2"  −150 ≤ y ≤ 150      A-z3 "Zone 3"  y > 150
 *   B-z1 "Zone 1"  y < 0         B-z2 "Zone 2"  y ≥ 0
 * A and B deliberately share the LABELS "Zone 1" and "Zone 2" (distinct ids, as a published map
 * requires). Every robot position and obstacle is ≥ 35 m from a band edge, more than a res-11
 * cell's ~29 m circumradius, so its resolved zone does not depend on hex alignment. Routes that
 * cross a band edge also run ≥ 100 m inside each band they enter.
 *
 * Robots (position = first route vertex; routes are straight segments, densified to a waypoint
 * every ≤ 25 m — under the ~43 m res-11 centre spacing):
 *   R1  A  route (−300,0) → (300,0)          current zone A-z2   route zones {A-z2}
 *   R2  A  route (200,−350) → (200,350)      current zone A-z1   route zones {A-z1, A-z2, A-z3}
 *   R3  A  route (−300,300) → (0,300)        current zone A-z3   route zones {A-z3}
 *   R4  A  route (−350,−350) → (−50,−50)     current zone A-z1   route zones {A-z1, A-z2}   (SW→NE)
 *   R5  A  at (300,−300), NO active route    current zone A-z1   route zones {}
 *   RB1 B  route (−350,−350) → (−50,−50)     current zone B-z1   route zones {B-z1}         (R4's twin)
 *   RB2 B  route (200,−350) → (200,350)      current zone B-z1   route zones {B-z1, B-z2}   (R2's twin)
 *
 * Obstacles (points, all in region A), one per scenario, each evaluated against the whole fleet:
 *   S1 same-zone          O1 (−100,0)     zone A-z2   on R1's route
 *   S2 other-zone         O2 (200,300)    zone A-z3   on R2's route, which STARTS in A-z1
 *   S3 near-miss          O3 (−150,335)   zone A-z3   35 m north of R3's route, on no route
 *   S4 SW→NE bearing      O4 (−250,−250)  zone A-z1   exactly on R4's diagonal route
 *   S5 cross-region label O5 (200,−250)   zone A-z1 ("Zone 1"); RB2's route passes the SAME local
 *                                         point (200,−250) inside B-z1, also labelled "Zone 1"
 *
 * Ground-truth rule. A robot is RELEVANT to an obstacle at distance d iff it has an active route
 * and the minimum distance from the obstacle point to its route polyline (declared vertices, in
 * the local metric frame of the obstacle's region) is ≤ d. Region is not part of the ground
 * truth; region-B robots are irrelevant because they are ~3 km away.
 * Distance sweep, fixed in advance: d ∈ {10 m, 25 m, 50 m}.
 *
 * Hand-derived distances (obstacle → route), used for the ground truth below:
 *   O1: R1 0 · R4 70.7 (to its end (−50,−50)) · R2 300 · R3 300        → {R1} at every d
 *   O2: R2 0 · R3 200 · R1 300                                         → {R2} at every d
 *   O3: R3 35 · R1 335 · R2 350                                        → {} at 10, 25; {R3} at 50
 *   O4: R4 0 · R1 250 · R2 450                                         → {R4} at every d
 *   O5: R2 0 · R1 250 · R4 320 (to (−50,−50))                          → {R2} at every d
 *
 * Metrics, per (scenario, policy, d): TP = relevant ∧ notified; FN = relevant ∧ ¬notified;
 * FP = ¬relevant ∧ notified; N = |notified|. Raw counts are the primary result.
 *   missRate        = FN / (TP + FN)  — null when there is no relevant robot (0/0 is undefined)
 *   unnecessaryRate = FP / N          — null when nothing was notified        (0/0 is undefined)
 *
 * Set DTARO_EXPERIMENT_REPORT=1 to print the canonical result table (for run-to-run comparison).
 */

const cells = require("../../../src/engine/spatial/cells");
const hierarchy = require("../../../src/engine/spatial/hierarchy");

/* ═══════════════════════════════════════════════════════════════════════════
   Fixture declaration
   ═══════════════════════════════════════════════════════════════════════════ */

const M_LAT = 110_574; // metres per degree of latitude (fixture frame constant)
const M_PER_DEG_EQUATOR = 111_320; // metres per degree of longitude at the equator
const DISK_K = 18;
const DISTANCES_M = Object.freeze([10, 25, 50]);
const WAYPOINT_STEP_M = 25;

const REGIONS = Object.freeze({
  A: Object.freeze({ id: "A", name: "Synthetic region A", origin: Object.freeze({ lat: 12.9, lon: 77.5 }) }),
  B: Object.freeze({ id: "B", name: "Synthetic region B", origin: null }), // set below: 3 000 m east of A
});

function mLon(lat) {
  return M_PER_DEG_EQUATOR * Math.cos((lat * Math.PI) / 180);
}
const ORIGIN_B = Object.freeze({ lat: REGIONS.A.origin.lat, lon: REGIONS.A.origin.lon + 3000 / mLon(REGIONS.A.origin.lat) });
const ORIGIN = Object.freeze({ A: REGIONS.A.origin, B: ORIGIN_B });

/** Zone declarations: id, region, shared-looking label, and the construction band on centre y. */
const ZONES = Object.freeze([
  { id: "A-z1", regionId: "A", name: "Zone 1", band: (y) => y < -150 },
  { id: "A-z2", regionId: "A", name: "Zone 2", band: (y) => y >= -150 && y <= 150 },
  { id: "A-z3", regionId: "A", name: "Zone 3", band: (y) => y > 150 },
  { id: "B-z1", regionId: "B", name: "Zone 1", band: (y) => y < 0 },
  { id: "B-z2", regionId: "B", name: "Zone 2", band: (y) => y >= 0 },
]);

const ROBOTS = Object.freeze([
  { id: "R1", region: "A", route: [[-300, 0], [300, 0]], at: [-300, 0] },
  { id: "R2", region: "A", route: [[200, -350], [200, 350]], at: [200, -350] },
  { id: "R3", region: "A", route: [[-300, 300], [0, 300]], at: [-300, 300] },
  { id: "R4", region: "A", route: [[-350, -350], [-50, -50]], at: [-350, -350] },
  { id: "R5", region: "A", route: [], at: [300, -300] },
  { id: "RB1", region: "B", route: [[-350, -350], [-50, -50]], at: [-350, -350] },
  { id: "RB2", region: "B", route: [[200, -350], [200, 350]], at: [200, -350] },
]);
const REGION_B_ROBOTS = Object.freeze(["RB1", "RB2"]);

const SCENARIOS = Object.freeze([
  { id: "S1", label: "obstacle on a route in the same zone", region: "A", at: [-100, 0] },
  { id: "S2", label: "obstacle on a route in a different zone of the same region", region: "A", at: [200, 300] },
  { id: "S3", label: "nearby but non-intersecting route (35 m)", region: "A", at: [-150, 335] },
  { id: "S4", label: "route through the obstacle on the SW→NE bearing", region: "A", at: [-250, -250] },
  { id: "S5", label: "other region with the same local zone label", region: "A", at: [200, -250] },
]);

/* ═══════════════════════════════════════════════════════════════════════════
   Hand-derived expectations — written from the fixture geometry above, NOT computed by the
   helpers under test.
   ═══════════════════════════════════════════════════════════════════════════ */

/** Declared zone of every robot position and obstacle. */
const EXPECTED_POSITION_ZONE = Object.freeze({
  R1: "A-z2", R2: "A-z1", R3: "A-z3", R4: "A-z1", R5: "A-z1", RB1: "B-z1", RB2: "B-z1",
  S1: "A-z2", S2: "A-z3", S3: "A-z3", S4: "A-z1", S5: "A-z1",
});

/** Declared waypoint-zone set of every robot's active route. */
const EXPECTED_ROUTE_ZONES = Object.freeze({
  R1: ["A-z2"], R2: ["A-z1", "A-z2", "A-z3"], R3: ["A-z3"], R4: ["A-z1", "A-z2"], R5: [],
  RB1: ["B-z1"], RB2: ["B-z1", "B-z2"],
});

/** Declared ground truth: scenario → d → relevant robots. */
const EXPECTED_RELEVANT = Object.freeze({
  S1: { 10: ["R1"], 25: ["R1"], 50: ["R1"] },
  S2: { 10: ["R2"], 25: ["R2"], 50: ["R2"] },
  S3: { 10: [], 25: [], 50: ["R3"] },
  S4: { 10: ["R4"], 25: ["R4"], 50: ["R4"] },
  S5: { 10: ["R2"], 25: ["R2"], 50: ["R2"] },
});

/**
 * Declared notification sets.
 *   P1 CURRENT_ZONE_ONLY             — robots whose current zone is the obstacle's zone.
 *   P2 CURRENT_ZONE_PLUS_ROUTE_ZONES — P1 ∪ robots whose route waypoint zones include it.
 *   P3 SAME_REGION_ROUTE_INTERSECTION — same region ∧ route within d (the reference).
 * P1 and P2 do not depend on d. Region-B robots appear in none.
 *   S1 (A-z2): P1 {R1}            P2 {R1} ∪ routes through A-z2 {R2, R4} = {R1, R2, R4}
 *   S2 (A-z3): P1 {R3}            P2 {R3} ∪ {R2}                          = {R2, R3}
 *   S3 (A-z3): P1 {R3}            P2 {R2, R3}
 *   S4 (A-z1): P1 {R2, R4, R5}    P2 same (only R2 and R4 have routes there, both already in)
 *   S5 (A-z1): P1 {R2, R4, R5}    P2 same — RB1/RB2 sit in "Zone 1" of region B, a different id
 */
const EXPECTED_NOTIFIED = Object.freeze({
  S1: { P1: ["R1"], P2: ["R1", "R2", "R4"], P3: { 10: ["R1"], 25: ["R1"], 50: ["R1"] } },
  S2: { P1: ["R3"], P2: ["R2", "R3"], P3: { 10: ["R2"], 25: ["R2"], 50: ["R2"] } },
  S3: { P1: ["R3"], P2: ["R2", "R3"], P3: { 10: [], 25: [], 50: ["R3"] } },
  S4: { P1: ["R2", "R4", "R5"], P2: ["R2", "R4", "R5"], P3: { 10: ["R4"], 25: ["R4"], 50: ["R4"] } },
  S5: { P1: ["R2", "R4", "R5"], P2: ["R2", "R4", "R5"], P3: { 10: ["R2"], 25: ["R2"], 50: ["R2"] } },
});

/** Declared raw counts [TP, FN, FP, N] — the primary result. */
const EXPECTED_COUNTS = Object.freeze({
  S1: { 10: { P1: [1, 0, 0, 1], P2: [1, 0, 2, 3], P3: [1, 0, 0, 1] },
        25: { P1: [1, 0, 0, 1], P2: [1, 0, 2, 3], P3: [1, 0, 0, 1] },
        50: { P1: [1, 0, 0, 1], P2: [1, 0, 2, 3], P3: [1, 0, 0, 1] } },
  S2: { 10: { P1: [0, 1, 1, 1], P2: [1, 0, 1, 2], P3: [1, 0, 0, 1] },
        25: { P1: [0, 1, 1, 1], P2: [1, 0, 1, 2], P3: [1, 0, 0, 1] },
        50: { P1: [0, 1, 1, 1], P2: [1, 0, 1, 2], P3: [1, 0, 0, 1] } },
  S3: { 10: { P1: [0, 0, 1, 1], P2: [0, 0, 2, 2], P3: [0, 0, 0, 0] },
        25: { P1: [0, 0, 1, 1], P2: [0, 0, 2, 2], P3: [0, 0, 0, 0] },
        50: { P1: [1, 0, 0, 1], P2: [1, 0, 1, 2], P3: [1, 0, 0, 1] } },
  S4: { 10: { P1: [1, 0, 2, 3], P2: [1, 0, 2, 3], P3: [1, 0, 0, 1] },
        25: { P1: [1, 0, 2, 3], P2: [1, 0, 2, 3], P3: [1, 0, 0, 1] },
        50: { P1: [1, 0, 2, 3], P2: [1, 0, 2, 3], P3: [1, 0, 0, 1] } },
  S5: { 10: { P1: [1, 0, 2, 3], P2: [1, 0, 2, 3], P3: [1, 0, 0, 1] },
        25: { P1: [1, 0, 2, 3], P2: [1, 0, 2, 3], P3: [1, 0, 0, 1] },
        50: { P1: [1, 0, 2, 3], P2: [1, 0, 2, 3], P3: [1, 0, 0, 1] } },
});

/** Declared totals over S1–S5, [TP, FN, FP, N], summed by hand from the table above. */
const EXPECTED_TOTALS = Object.freeze({
  10: { P1: [3, 1, 6, 9], P2: [4, 0, 9, 13], P3: [4, 0, 0, 4] },
  25: { P1: [3, 1, 6, 9], P2: [4, 0, 9, 13], P3: [4, 0, 0, 4] },
  50: { P1: [4, 1, 5, 9], P2: [5, 0, 8, 13], P3: [5, 0, 0, 5] },
});

/* ═══════════════════════════════════════════════════════════════════════════
   Test-only helpers (experiment code — not production, not an approved policy)
   ═══════════════════════════════════════════════════════════════════════════ */

function toLatLon(region, [x, y]) {
  const origin = ORIGIN[region];
  return { lat: origin.lat + y / M_LAT, lon: origin.lon + x / mLon(origin.lat) };
}

function toLocal(region, { lat, lon }) {
  const origin = ORIGIN[region];
  return [(lon - origin.lon) * mLon(origin.lat), (lat - origin.lat) * M_LAT];
}

/** The synthetic published map, built from production H3 primitives; zones by centre band. */
function buildPublishedMap() {
  const assignments = [];
  for (const regionId of ["A", "B"]) {
    const origin = ORIGIN[regionId];
    const originCell = cells.cellForPoint(origin.lat, origin.lon, cells.RESOLUTION.FINE);
    for (const cellId of cells.canonicalCellOrder(cells.diskAround(originCell, DISK_K))) {
      const [, y] = toLocal(regionId, cells.centreOfCell(cellId));
      const zone = ZONES.find((candidate) => candidate.regionId === regionId && candidate.band(y));
      assignments.push({ cellId, resolution: cells.RESOLUTION.FINE, regionId, zoneId: zone.id });
    }
  }
  return {
    version: 1,
    regions: [REGIONS.A, REGIONS.B].map(({ id, name }) => ({ id, name })),
    zones: ZONES.map(({ id, regionId, name }) => ({ id, regionId, name })),
    sites: [],
    cells: assignments,
  };
}

/** Point → published zone/region, by assignment only (ADR-28). */
function resolvePoint(index, region, xy) {
  const { lat, lon } = toLatLon(region, xy);
  return index.resolve(cells.cellForPoint(lat, lon, cells.RESOLUTION.FINE));
}

/** The route as a waypoint list: each segment densified to steps of ≤ WAYPOINT_STEP_M. */
function waypointsOf(route) {
  if (route.length === 0) return [];
  const out = [route[0]];
  for (let i = 1; i < route.length; i += 1) {
    const [ax, ay] = route[i - 1];
    const [bx, by] = route[i];
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / WAYPOINT_STEP_M));
    for (let s = 1; s <= steps; s += 1) out.push([ax + ((bx - ax) * s) / steps, ay + ((by - ay) * s) / steps]);
  }
  return out;
}

function routeZonesOf(index, robot) {
  const zones = new Set(waypointsOf(robot.route).map((xy) => resolvePoint(index, robot.region, xy).zoneId));
  return [...zones].sort();
}

/** Minimum point-to-polyline distance in a region's local metric frame. */
function distanceToRoute([px, py], route) {
  let best = Infinity;
  for (let i = 1; i < route.length; i += 1) {
    const [ax, ay] = route[i - 1];
    const [bx, by] = route[i];
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
    best = Math.min(best, Math.hypot(px - (ax + t * dx), py - (ay + t * dy)));
  }
  return best;
}

/** The obstacle in the robot's own frame (both frames share axes; origins differ). */
function obstacleInFrameOf(scenario, robot) {
  if (scenario.region === robot.region) return scenario.at;
  return toLocal(robot.region, toLatLon(scenario.region, scenario.at));
}

function groundTruth(scenario, d) {
  return ROBOTS.filter((robot) => robot.route.length > 0 && distanceToRoute(obstacleInFrameOf(scenario, robot), robot.route) <= d)
    .map((robot) => robot.id)
    .sort();
}

const POLICIES = Object.freeze({
  P1: "CURRENT_ZONE_ONLY",
  P2: "CURRENT_ZONE_PLUS_ROUTE_ZONES",
  P3: "SAME_REGION_ROUTE_INTERSECTION (reference)",
});

function notify(policy, world, scenario, d) {
  const obstacle = resolvePoint(world.index, scenario.region, scenario.at);
  const chosen = ROBOTS.filter((robot) => {
    const current = world.positionOf[robot.id];
    if (policy === "P1") return current.zoneId === obstacle.zoneId;
    if (policy === "P2") return current.zoneId === obstacle.zoneId || world.routeZonesOf[robot.id].includes(obstacle.zoneId);
    // P3: same published region, active route within d of the obstacle point.
    return (
      current.regionId === obstacle.regionId &&
      robot.route.length > 0 &&
      distanceToRoute(obstacleInFrameOf(scenario, robot), robot.route) <= d
    );
  });
  return chosen.map((robot) => robot.id).sort();
}

function confusion(relevant, notified) {
  const r = new Set(relevant);
  const n = new Set(notified);
  const tp = [...n].filter((id) => r.has(id)).length;
  const fn = [...r].filter((id) => !n.has(id)).length;
  const fp = [...n].filter((id) => !r.has(id)).length;
  return {
    counts: [tp, fn, fp, n.size],
    missRate: tp + fn === 0 ? null : fn / (tp + fn),
    unnecessaryRate: n.size === 0 ? null : fp / n.size,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   The world, built once (pure and deterministic: no clock, no randomness, no I/O)
   ═══════════════════════════════════════════════════════════════════════════ */

const map = buildPublishedMap();
const index = hierarchy.indexMap(map);
const world = {
  index,
  positionOf: Object.fromEntries(ROBOTS.map((robot) => [robot.id, resolvePoint(index, robot.region, robot.at)])),
  routeZonesOf: Object.fromEntries(ROBOTS.map((robot) => [robot.id, routeZonesOf(index, robot)])),
};

function measureAll() {
  const rows = [];
  for (const scenario of SCENARIOS) {
    for (const d of DISTANCES_M) {
      const relevant = groundTruth(scenario, d);
      for (const policy of Object.keys(POLICIES)) {
        const notified = notify(policy, world, scenario, d);
        rows.push({ scenario: scenario.id, d, policy, relevant, notified, ...confusion(relevant, notified) });
      }
    }
  }
  return rows;
}

/* ═══════════════════════════════════════════════════════════════════════════
   1. The fixture is a valid published map and resolves as declared
   ═══════════════════════════════════════════════════════════════════════════ */

describe("fixture — a synthetic map the publish path would accept (ADR-28)", () => {
  test("validateForPublish accepts it: two regions, five zones, every cell an H3 res-11 FINE cell", () => {
    expect(hierarchy.validateForPublish(map)).toEqual({ ok: true, problems: [] });
    expect(map.regions.map((r) => r.id)).toEqual(["A", "B"]);
    expect(map.cells.every((cell) => cells.resolutionOfH3Cell(cell.cellId) === cells.RESOLUTION.FINE)).toBe(true);
  });

  test("the two regions share no cell, and both use the labels 'Zone 1' and 'Zone 2' under distinct ids", () => {
    const a = new Set(map.cells.filter((c) => c.regionId === "A").map((c) => c.cellId));
    const b = map.cells.filter((c) => c.regionId === "B").map((c) => c.cellId);
    expect(b.filter((cellId) => a.has(cellId))).toEqual([]);
    expect(map.zones.filter((z) => z.name === "Zone 1").map((z) => z.id)).toEqual(["A-z1", "B-z1"]);
    expect(map.zones.filter((z) => z.name === "Zone 2").map((z) => z.id)).toEqual(["A-z2", "B-z2"]);
    for (const zone of ZONES) expect(index.cellsOfZone(zone.id).length).toBeGreaterThan(0);
  });

  test("every robot position and obstacle resolves, by assignment, to its declared region and zone", () => {
    for (const robot of ROBOTS) {
      expect({ id: robot.id, ...pick(world.positionOf[robot.id]) }).toEqual({
        id: robot.id, assigned: true, regionId: robot.region, zoneId: EXPECTED_POSITION_ZONE[robot.id],
      });
    }
    for (const scenario of SCENARIOS) {
      expect({ id: scenario.id, ...pick(resolvePoint(index, scenario.region, scenario.at)) }).toEqual({
        id: scenario.id, assigned: true, regionId: scenario.region, zoneId: EXPECTED_POSITION_ZONE[scenario.id],
      });
    }
  });

  test("every route waypoint is inside the published map, and route zones are as declared", () => {
    for (const robot of ROBOTS) {
      for (const xy of waypointsOf(robot.route)) {
        const resolved = resolvePoint(index, robot.region, xy);
        expect({ robot: robot.id, assigned: resolved.assigned, regionId: resolved.regionId }).toEqual({
          robot: robot.id, assigned: true, regionId: robot.region,
        });
      }
      expect({ robot: robot.id, zones: world.routeZonesOf[robot.id] }).toEqual({ robot: robot.id, zones: EXPECTED_ROUTE_ZONES[robot.id] });
    }
  });

  test.each(SCENARIOS.flatMap((s) => DISTANCES_M.map((d) => [s.id, d])))(
    "ground truth for %s at d = %i m matches the hand-declared set",
    (scenarioId, d) => {
      const scenario = SCENARIOS.find((s) => s.id === scenarioId);
      expect(groundTruth(scenario, d)).toEqual(EXPECTED_RELEVANT[scenarioId][d]);
    },
  );
});

function pick(resolved) {
  return { assigned: resolved.assigned, regionId: resolved.regionId, zoneId: resolved.zoneId };
}

/* ═══════════════════════════════════════════════════════════════════════════
   2. Measurements — exact raw counts per (scenario, d, policy)
   ═══════════════════════════════════════════════════════════════════════════ */

describe("measurement — candidate recipient policies on the fixture (evidence only; no policy is approved)", () => {
  const rows = measureAll();

  test.each(rows.map((row) => [row.scenario, row.d, row.policy, row]))(
    "%s, d = %i m, %s: notified set and [TP, FN, FP, N] equal the hand-derived values",
    (scenarioId, d, policy, row) => {
      const expectedNotified = policy === "P3" ? EXPECTED_NOTIFIED[scenarioId].P3[d] : EXPECTED_NOTIFIED[scenarioId][policy];
      expect(row.notified).toEqual(expectedNotified);
      expect(row.counts).toEqual(EXPECTED_COUNTS[scenarioId][d][policy]);
    },
  );

  test.each(DISTANCES_M)("totals over S1–S5 at d = %i m equal the hand-summed totals", (d) => {
    const totals = {};
    for (const policy of Object.keys(POLICIES)) {
      totals[policy] = rows
        .filter((row) => row.d === d && row.policy === policy)
        .reduce((sum, row) => sum.map((value, i) => value + row.counts[i]), [0, 0, 0, 0]);
    }
    expect(totals).toEqual(EXPECTED_TOTALS[d]);
  });

  test("cross-region: no policy, at any distance, in any scenario, notifies a region-B robot", () => {
    const leaks = rows.filter((row) => row.notified.some((id) => REGION_B_ROBOTS.includes(id)));
    expect(leaks).toEqual([]);
    // And the S5 twin is real: RB2's route passes the same LOCAL point, in a zone with the same label.
    const rb2 = ROBOTS.find((robot) => robot.id === "RB2");
    expect(distanceToRoute(SCENARIOS.find((s) => s.id === "S5").at, rb2.route)).toBe(0);
    expect(map.zones.find((z) => z.id === EXPECTED_POSITION_ZONE.RB2).name).toBe(map.zones.find((z) => z.id === EXPECTED_POSITION_ZONE.S5).name);
  });

  test("zero-denominator rule: rates are null, never 0, when undefined", () => {
    const s3p3 = rows.find((row) => row.scenario === "S3" && row.d === 10 && row.policy === "P3");
    expect(s3p3.counts).toEqual([0, 0, 0, 0]);
    expect(s3p3.missRate).toBeNull();
    expect(s3p3.unnecessaryRate).toBeNull();
    const s2p1 = rows.find((row) => row.scenario === "S2" && row.d === 10 && row.policy === "P1");
    expect([s2p1.missRate, s2p1.unnecessaryRate]).toEqual([1, 1]);
  });

  test("the fixture is deterministic: a second measurement in the same process is identical", () => {
    expect(JSON.stringify(measureAll())).toBe(JSON.stringify(rows));
    if (process.env.DTARO_EXPERIMENT_REPORT === "1") {
      process.stdout.write(`${JSON.stringify(rows.map(({ scenario, d, policy, counts, missRate, unnecessaryRate }) => ({ scenario, d, policy, counts, missRate, unnecessaryRate })))}\n`);
    }
  });
});
