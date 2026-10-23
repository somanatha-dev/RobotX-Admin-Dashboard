"use strict";

/**
 * **DTARO building blocks, offline: a simulated obstacle report, resolved through a published map.**
 *
 * Three things, each through unmodified production code:
 *   1. `VirtualRobot._maybeReportObstacle` — the simulator's real, seeded obstacle stream. A
 *      robot is constructed with the real constructor (never connected) and its socket is a
 *      recorder, so the emitted `OBSTACLE_REPORT` payloads are observed exactly.
 *   2. Zone resolution by PUBLISHED ASSIGNMENT (ADR-28): point → `cells.cellForPoint(FINE)` →
 *      `hierarchy.indexMap(map).resolve(cell)`. No bounding box, no query-time geometry.
 *   3. Region isolation (readiness plan AC-CI-1): a robot's region as the server derives it,
 *      `indexMaintainer.regionForObservedPosition(snapshot, position)`, bounds who could ever be
 *      told. Robots of another region are never eligible.
 *
 * What this is NOT:
 *   · Not the production obstacle path. Production `OBSTACLE_REPORT` handling still resolves a
 *     zone from legacy bounding boxes and scans `robots:all` (CURRENT_IMPLEMENTATION_MAP §6);
 *     nothing here changes or claims otherwise.
 *   · Not a recipient policy. WHICH robots inside the region receive an alert (current zone,
 *     route zones, route distance) is owner decision OD-2 and stays open: this file asserts
 *     nothing about within-region selection. `obstacleRecipientPolicyExperiment.test.js` (another
 *     session's Step 4) measures the candidates.
 *   · Not RNSIT. The map is synthetic, two regions, so isolation can be shown; the RNSIT zone map
 *     is still a proposal with unresolved cells (`tools/campus/rnsitZoneMap.js`).
 */

const cells = require("../../src/engine/spatial/cells");
const hierarchy = require("../../src/engine/spatial/hierarchy");
const { regionForObservedPosition } = require("../../src/workers/indexMaintainer.worker");
const VirtualRobot = require("../../src/simulation/VirtualRobot");

const FINE = cells.RESOLUTION.FINE;
const M_PER_DEG_LAT = 111_320;
const metresNorth = (lat, metres) => lat + metres / M_PER_DEG_LAT;
const metresEast = (lat, lon, metres) => lon + metres / (M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180));

/* ── Synthetic published map: two regions; region A split north/south at its origin's latitude ── */
const ORIGIN_A = { lat: 12.9, lon: 77.5 };
const ORIGIN_B = { lat: 12.9, lon: metresEast(12.9, 77.5, 3000) };
const DISK_K = 8; // res-11 rings: ~300 m+ around each origin

function buildMap({ moveCellToSouth } = {}) {
  const cellsOut = [];
  for (const cellId of cells.diskAround(cells.cellForPoint(ORIGIN_A.lat, ORIGIN_A.lon, FINE), DISK_K)) {
    const north = cells.centreOfCell(cellId).lat >= ORIGIN_A.lat && cellId !== moveCellToSouth;
    cellsOut.push({ cellId, resolution: FINE, regionId: "syn-A", zoneId: north ? "syn-A-north" : "syn-A-south" });
  }
  for (const cellId of cells.diskAround(cells.cellForPoint(ORIGIN_B.lat, ORIGIN_B.lon, FINE), DISK_K)) {
    cellsOut.push({ cellId, resolution: FINE, regionId: "syn-B", zoneId: "syn-B-1" });
  }
  return {
    regions: [{ id: "syn-A" }, { id: "syn-B" }],
    zones: [
      { id: "syn-A-north", regionId: "syn-A" },
      { id: "syn-A-south", regionId: "syn-A" },
      { id: "syn-B-1", regionId: "syn-B" },
    ],
    sites: [],
    cells: cellsOut,
  };
}

const MAP = buildMap();
const INDEX = hierarchy.indexMap(MAP);
const resolvePoint = (index, { lat, lon }) => index.resolve(cells.cellForPoint(lat, lon, FINE));

/* ── Robots: positions ≥ 100 m from the north/south line, so ±11 m reports cannot cross it ── */
const POSITIONS = {
  "SIM-A1": { lat: metresNorth(ORIGIN_A.lat, 120), lon: ORIGIN_A.lon },
  "SIM-A2": { lat: metresNorth(ORIGIN_A.lat, -120), lon: ORIGIN_A.lon },
  "SIM-B1": { lat: metresNorth(ORIGIN_B.lat, 120), lon: ORIGIN_B.lon },
};

const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, child() { return silentLogger; } };

/** A real VirtualRobot, never connected; its socket records what it would send. */
function robot(robotId, { obstacleProbability = 1, status = "ACTIVE" } = {}) {
  const position = POSITIONS[robotId];
  const instance = new VirtualRobot({ robotId, lat: position.lat, lon: position.lon, logger: silentLogger, obstacleProbability });
  const emitted = [];
  instance.socket = { emit: (event, payload) => emitted.push({ event, payload }) };
  instance.status = status;
  return { instance, emitted };
}

function reportsOf(robotId, ticks, options) {
  const { instance, emitted } = robot(robotId, options);
  for (let i = 0; i < ticks; i += 1) instance._maybeReportObstacle();
  return emitted;
}

describe("fixture — a map the publish path would accept", () => {
  test("validateForPublish accepts the synthetic two-region map", () => {
    expect(hierarchy.validateForPublish(MAP)).toEqual({ ok: true, problems: [] });
  });
});

describe("1. simulated obstacle reports are deterministic", () => {
  test("the same robot id gives the same report sequence", () => {
    const first = reportsOf("SIM-A1", 5);
    expect(first).toHaveLength(5);
    expect(reportsOf("SIM-A1", 5)).toEqual(first);
    for (const { event, payload } of first) {
      expect(event).toBe("OBSTACLE_REPORT");
      expect(Object.keys(payload).sort()).toEqual(["lat", "lon", "severity"]);
    }
  });

  test("a different robot id gives a different sequence (independent per-robot streams)", () => {
    expect(reportsOf("SIM-A2", 5)).not.toEqual(reportsOf("SIM-A1", 5));
  });

  test("rate 0 and a non-ACTIVE robot report nothing", () => {
    expect(reportsOf("SIM-A1", 20, { obstacleProbability: 0 })).toEqual([]);
    expect(reportsOf("SIM-A1", 20, { status: "IDLE" })).toEqual([]);
  });
});

describe("2. a report resolves to a zone by published assignment only", () => {
  const reports = reportsOf("SIM-A1", 5).map(({ payload }) => payload);

  test("every SIM-A1 report resolves to region syn-A, zone syn-A-north", () => {
    for (const point of reports) expect(resolvePoint(INDEX, point)).toMatchObject({ assigned: true, regionId: "syn-A", zoneId: "syn-A-north" });
  });

  test("reassigning the report's cell in a new map version moves the zone with no change of coordinates", () => {
    const cellId = cells.cellForPoint(reports[0].lat, reports[0].lon, FINE);
    const moved = hierarchy.indexMap(buildMap({ moveCellToSouth: cellId }));
    expect(resolvePoint(moved, reports[0])).toMatchObject({ assigned: true, regionId: "syn-A", zoneId: "syn-A-south" });
  });

  test("a point outside every published cell is unassigned, never guessed", () => {
    expect(resolvePoint(INDEX, { lat: metresNorth(ORIGIN_A.lat, 2000), lon: ORIGIN_A.lon })).toMatchObject({ assigned: false, zoneId: null, regionId: null });
  });
});

describe("3. region isolation (AC-CI-1) — not a recipient policy", () => {
  const snapshot = { spatial: MAP };

  test("the server-side region of each robot comes from the same published map", () => {
    expect(regionForObservedPosition(snapshot, POSITIONS["SIM-A1"])).toBe("syn-A");
    expect(regionForObservedPosition(snapshot, POSITIONS["SIM-A2"])).toBe("syn-A");
    expect(regionForObservedPosition(snapshot, POSITIONS["SIM-B1"])).toBe("syn-B");
  });

  test("for every SIM-A1 report, no region-B robot is eligible; within-region selection is left to OD-2", () => {
    for (const { payload } of reportsOf("SIM-A1", 5)) {
      const obstacleRegion = resolvePoint(INDEX, payload).regionId;
      const eligible = Object.keys(POSITIONS).filter((id) => regionForObservedPosition(snapshot, POSITIONS[id]) === obstacleRegion);
      expect(eligible).not.toContain("SIM-B1");
      // Region-bounded eligibility includes both region-A robots, whatever their zone. Whether
      // SIM-A2 (other zone) is then TOLD is OD-2's question, deliberately not asserted here.
      expect(eligible.sort()).toEqual(["SIM-A1", "SIM-A2"]);
    }
  });
});
