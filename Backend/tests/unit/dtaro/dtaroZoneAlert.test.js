"use strict";

/**
 * DTARO zone alerts — unit level (no sockets; see tests/integration/dtaroZoneAlertSockets.test.js
 * for the real-socket path).
 *
 *   1. routeIntersection.pathIntersectsPolygon — the footprint test receivers use, including a
 *      route running exactly along the obstacle cell's boundary.
 *   2. dtaroZoneAlert — spatial resolution against a published map, room naming, membership.
 *   3. dtaroScenario — the deterministic world is validated and fails closed.
 *   4. VirtualRobot._onObstacleAlert — relevance from the commanded route, and no state change.
 */

const h3 = require("h3-js");
const { pathIntersectsPolygon, pointInPolygon, segmentsIntersect } = require("../../../src/services/routeIntersection.service");
const dtaroZoneAlert = require("../../../src/services/dtaroZoneAlert.service");
const dtaroScenario = require("../../../src/simulation/dtaroScenario");
const VirtualRobot = require("../../../src/simulation/VirtualRobot");

const CENTRE = { lat: 12.9023, lon: 77.5186 };
const CELL = h3.latLngToCell(CENTRE.lat, CENTRE.lon, 11);
const FOOTPRINT = dtaroZoneAlert.cellFootprint(CELL);
const [cLat, cLon] = h3.cellToLatLng(CELL);
const C = { lat: cLat, lon: cLon };
const D = 0.001; // ~110 m

/** Push a point away from the cell centre by `metres` (approximately). */
function outward(p, metres) {
  const dLat = p.lat - C.lat;
  const dLon = (p.lon - C.lon) * Math.cos((C.lat * Math.PI) / 180);
  const len = Math.hypot(dLat, dLon);
  const step = metres / 111_320;
  return {
    lat: p.lat + (dLat / len) * step,
    lon: p.lon + ((dLon / len) * step) / Math.cos((C.lat * Math.PI) / 180),
  };
}

describe("pathIntersectsPolygon — the receiver's footprint test", () => {
  test("the footprint is the H3 cell boundary (6 vertices) around the obstacle", () => {
    expect(FOOTPRINT).toHaveLength(6);
    expect(pointInPolygon(C, FOOTPRINT)).toBe(true);
  });

  test("a route through the obstacle is relevant on every bearing (the legacy diagonal missed SW→NE)", () => {
    const swNe = [{ lat: C.lat - D, lon: C.lon - D }, { lat: C.lat + D, lon: C.lon + D }];
    const nwSe = [{ lat: C.lat + D, lon: C.lon - D }, { lat: C.lat - D, lon: C.lon + D }];
    const ew = [{ lat: C.lat, lon: C.lon - D }, { lat: C.lat, lon: C.lon + D }];
    for (const route of [swNe, nwSe, ew]) expect(pathIntersectsPolygon(route, FOOTPRINT)).toBe(true);
    // Characterisation of the legacy defect the new test corrects: collinear with the diagonal → false.
    const diag = [{ lat: C.lat - 0.0002, lon: C.lon - 0.0002 }, { lat: C.lat + 0.0002, lon: C.lon + 0.0002 }];
    expect(segmentsIntersect(swNe[0], swNe[1], diag[0], diag[1])).toBe(false);
  });

  test("a route running exactly ALONG one edge of the cell boundary is relevant (boundary inclusive)", () => {
    for (let i = 0; i < FOOTPRINT.length; i++) {
      const a = FOOTPRINT[i];
      const b = FOOTPRINT[(i + 1) % FOOTPRINT.length];
      // The edge itself, and the edge extended beyond both vertices along the same line.
      const ext = (p, q, t) => ({ lat: p.lat + (q.lat - p.lat) * t, lon: p.lon + (q.lon - p.lon) * t });
      expect(pathIntersectsPolygon([a, b], FOOTPRINT)).toBe(true);
      expect(pathIntersectsPolygon([ext(a, b, -2), ext(a, b, 3)], FOOTPRINT)).toBe(true);
    }
  });

  test("the same edge route shifted 1 m outside the cell is not relevant", () => {
    for (let i = 0; i < FOOTPRINT.length; i++) {
      const a = FOOTPRINT[i];
      const b = FOOTPRINT[(i + 1) % FOOTPRINT.length];
      const mid = { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 };
      const shift = { lat: outward(mid, 1).lat - mid.lat, lon: outward(mid, 1).lon - mid.lon };
      const moved = [a, b].map((p) => ({ lat: p.lat + shift.lat, lon: p.lon + shift.lon }));
      // Shorten slightly so the shifted segment cannot clip a neighbouring edge at the vertices.
      const inset = (p, q) => ({ lat: p.lat + (q.lat - p.lat) * 0.1, lon: p.lon + (q.lon - p.lon) * 0.1 });
      expect(pathIntersectsPolygon([inset(moved[0], moved[1]), inset(moved[1], moved[0])], FOOTPRINT)).toBe(false);
    }
  });

  test("touching only a vertex is relevant; passing 2 m beyond it is not", () => {
    const v = FOOTPRINT[0];
    const away = outward(v, 50);
    expect(pathIntersectsPolygon([away, v], FOOTPRINT)).toBe(true);
    const near = outward(v, 2);
    const tangentDir = { lat: -(near.lon - C.lon) * 0.2, lon: (near.lat - C.lat) * 0.2 };
    expect(
      pathIntersectsPolygon(
        [{ lat: near.lat - tangentDir.lat, lon: near.lon - tangentDir.lon }, { lat: near.lat + tangentDir.lat, lon: near.lon + tangentDir.lon }],
        FOOTPRINT,
      ),
    ).toBe(false);
  });

  test("a route entirely inside the cell, a one-point route, and degenerate inputs", () => {
    const inside = [{ lat: C.lat, lon: C.lon - 0.00005 }, { lat: C.lat, lon: C.lon + 0.00005 }];
    expect(pathIntersectsPolygon(inside, FOOTPRINT)).toBe(true);
    expect(pathIntersectsPolygon([C], FOOTPRINT)).toBe(true);
    expect(pathIntersectsPolygon([{ lat: C.lat + D, lon: C.lon }], FOOTPRINT)).toBe(false);
    expect(pathIntersectsPolygon([], FOOTPRINT)).toBe(false);
    expect(pathIntersectsPolygon([C, C], FOOTPRINT.slice(0, 2))).toBe(false);
    expect(pathIntersectsPolygon([{ lat: "x" }, { lat: C.lat, lon: C.lon - D }, null, { lat: C.lat, lon: C.lon + D }], FOOTPRINT)).toBe(true);
  });

  test("a parallel route 100 m away is not relevant", () => {
    expect(pathIntersectsPolygon([{ lat: C.lat + 0.0009, lon: C.lon - D }, { lat: C.lat + 0.0009, lon: C.lon + D }], FOOTPRINT)).toBe(false);
  });
});

describe("dtaroZoneAlert — spatial authority, rooms, membership", () => {
  const MAP = {
    regions: [{ id: "rA" }, { id: "rB" }],
    zones: [{ id: "z1", regionId: "rA" }],
    cells: [
      { cellId: CELL, resolution: "FINE", regionId: "rA", zoneId: "z1" },
      { cellId: h3.latLngToCell(12.9027, 77.505, 11), resolution: "FINE", regionId: "rB", zoneId: "z1" },
      { cellId: h3.latLngToCell(12.91, 77.52, 11), resolution: "FINE", regionId: null, zoneId: null },
    ],
  };
  const SNAPSHOT = { spatial: MAP };

  test("a point resolves to its published cell, zone and region", () => {
    expect(dtaroZoneAlert.resolvePoint(SNAPSHOT, C.lat, C.lon)).toEqual({ ok: true, cellId: CELL, zoneId: "z1", regionId: "rA" });
    expect(dtaroZoneAlert.resolvePoint(SNAPSHOT, 12.9027, 77.505)).toMatchObject({ ok: true, zoneId: "z1", regionId: "rB" });
  });

  test("fails closed: invalid coordinates, no published map, unassigned cell, cell with no zone", () => {
    expect(dtaroZoneAlert.resolvePoint(SNAPSHOT, NaN, 77)).toMatchObject({ ok: false, reason: "INVALID_COORDINATES" });
    expect(dtaroZoneAlert.resolvePoint(SNAPSHOT, 91, 77)).toMatchObject({ ok: false, reason: "INVALID_COORDINATES" });
    expect(dtaroZoneAlert.resolvePoint(null, C.lat, C.lon)).toMatchObject({ ok: false, reason: "SPATIAL_AUTHORITY_UNAVAILABLE" });
    expect(dtaroZoneAlert.resolvePoint({}, C.lat, C.lon)).toMatchObject({ ok: false, reason: "SPATIAL_AUTHORITY_UNAVAILABLE" });
    expect(dtaroZoneAlert.resolvePoint(SNAPSHOT, 12.95, 77.6)).toMatchObject({ ok: false, reason: "UNASSIGNED_CELL" });
    expect(dtaroZoneAlert.resolvePoint(SNAPSHOT, 12.91, 77.52)).toMatchObject({ ok: false, reason: "CELL_HAS_NO_ZONE" });
  });

  test("rooms are region-qualified and unambiguous", () => {
    expect(dtaroZoneAlert.zoneRoom("rA", "z1")).toBe("dtaro:region:rA:zone:z1");
    expect(dtaroZoneAlert.zoneRoom("rA", "z1")).not.toBe(dtaroZoneAlert.zoneRoom("rB", "z1"));
    // An id containing the separator cannot impersonate another pair.
    expect(dtaroZoneAlert.zoneRoom("a:zone:b", "c")).not.toBe(dtaroZoneAlert.zoneRoom("a", "b:zone:c"));
  });

  function fakeSocket(data) {
    const rooms = new Set();
    return { rooms, data: { ...data }, join: (r) => rooms.add(r), leave: (r) => rooms.delete(r) };
  }

  test("membership: joins, keeps on an unknown position, moves on a zone change, leaves on an unassigned cell", () => {
    const socket = fakeSocket({ isAuthed: true, robotId: "SIM-1", dtaroEligible: true });
    expect(dtaroZoneAlert.syncMembership(socket, SNAPSHOT, C.lat, C.lon)).toMatchObject({ changed: true });
    expect([...socket.rooms]).toEqual(["dtaro:region:rA:zone:z1"]);
    expect(dtaroZoneAlert.syncMembership(socket, SNAPSHOT, C.lat, C.lon).changed).toBe(false);
    expect(dtaroZoneAlert.syncMembership(socket, SNAPSHOT, null, null).membership.room).toBe("dtaro:region:rA:zone:z1");
    dtaroZoneAlert.syncMembership(socket, SNAPSHOT, 12.9027, 77.505);
    expect([...socket.rooms]).toEqual(["dtaro:region:rB:zone:z1"]);
    dtaroZoneAlert.syncMembership(socket, SNAPSHOT, 12.95, 77.6);
    expect([...socket.rooms]).toEqual([]);
    expect(socket.data.dtaroZone).toBeNull();
  });

  test("membership is refused to unauthenticated and physical sockets", () => {
    const anon = fakeSocket({});
    const physical = fakeSocket({ isAuthed: true, robotId: "PHY-1", dtaroEligible: false });
    expect(dtaroZoneAlert.syncMembership(anon, SNAPSHOT, C.lat, C.lon).reason).toBe("NOT_AUTHENTICATED");
    expect(dtaroZoneAlert.syncMembership(physical, SNAPSHOT, C.lat, C.lon).reason).toBe("REPORTER_NOT_SIMULATED");
    expect(anon.rooms.size + physical.rooms.size).toBe(0);
  });

  test("the switch is off unless explicitly 'true'", () => {
    expect(dtaroZoneAlert.isEnabled({})).toBe(false);
    expect(dtaroZoneAlert.isEnabled({ DTARO_ZONE_ALERTS_ENABLED: "1" })).toBe(false);
    expect(dtaroZoneAlert.isEnabled({ DTARO_ZONE_ALERTS_ENABLED: "TRUE" })).toBe(true);
  });
});

describe("dtaroScenario — deterministic world obstacles", () => {
  test("a valid scenario is normalised, with the default sensing radius", () => {
    const parsed = dtaroScenario.parseScenario({ id: "demo", obstacles: [{ id: "OB-1", lat: 12.9, lon: 77.5, severity: "high" }] });
    expect(parsed).toEqual({
      ok: true,
      scenario: { id: "demo", senseRadiusM: 15, obstacles: [{ id: "OB-1", lat: 12.9, lon: 77.5, severity: "HIGH", senseRadiusM: 15 }] },
    });
  });

  test("every problem is reported and nothing is accepted", () => {
    const parsed = dtaroScenario.parseScenario({
      senseRadiusM: 0,
      obstacles: [{ id: "A", lat: 100, lon: 77 }, { id: "A", lat: 12, lon: 77, severity: "HUGE" }],
    });
    expect(parsed.ok).toBe(false);
    expect(parsed.problems).toEqual(
      expect.arrayContaining([
        "scenario.id must be a non-empty string",
        "scenario.senseRadiusM must be in (0, 200] metres",
        "obstacles[0].lat must be a latitude",
        'obstacles[1].id "A" is duplicated',
        "obstacles[1].severity must be one of LOW, MEDIUM, HIGH, CRITICAL",
      ]),
    );
  });

  test("no scenario configured → no world obstacles (the random stream stays as it was)", () => {
    expect(dtaroScenario.worldObstaclesFor({})).toBeUndefined();
  });

  test("the shipped RNSIT demonstration scenario is valid", () => {
    const scenario = dtaroScenario.loadScenarioFile(require("path").join(__dirname, "../../../tools/demo/dtaro/rnsit-dtaro-scenario.json"));
    expect(scenario.obstacles.length).toBeGreaterThan(0);
  });
});

describe("VirtualRobot — receiver-side relevance from the commanded route", () => {
  const quiet = { info() {}, warn() {}, error() {}, debug() {} };

  function robotWithRoute(path) {
    const vr = new VirtualRobot({ robotId: "SIM-U", lat: path[0].lat, lon: path[0].lon, logger: quiet, simulated: true, obstacleProbability: 0 });
    vr.socket = { emit: jest.fn(), connected: true };
    vr._onTaskAssign({ taskId: "TSK-U", pathToPickup: path.slice(0, 2), pathToDrop: path.slice(1) });
    return vr;
  }

  const alert = (extra) => ({
    obstacleId: "OBS-1",
    lat: C.lat,
    lon: C.lon,
    regionId: "rA",
    zoneId: "z1",
    cellId: CELL,
    footprint: { kind: "H3_CELL", cellId: CELL, polygon: FOOTPRINT },
    reportingRobotId: "SIM-R",
    ...extra,
  });

  function state(vr) {
    return JSON.stringify([vr.lat, vr.lon, vr.status, vr.phase, vr.stopIndex, vr.pathIndex, vr.activePath, vr.task.stops.map((s) => s.path)]);
  }

  test("a route whose LATER stop crosses the footprint is relevant; nothing about the route or motion changes", () => {
    const vr = robotWithRoute([
      { lat: C.lat + D, lon: C.lon - D },
      { lat: C.lat, lon: C.lon - D },
      { lat: C.lat, lon: C.lon + D },
    ]);
    const before = state(vr);
    vr._onObstacleAlert(alert());
    expect(vr.socket.emit).toHaveBeenCalledWith("OBSTACLE_RELEVANCE", {
      obstacleId: "OBS-1",
      relevant: true,
      routeSource: "COMMANDED_ROUTE",
      taskId: "TSK-U",
      routePoints: expect.any(Number),
      decision: "RELEVANT_NO_REPLAN",
    });
    expect(state(vr)).toBe(before);
    expect(vr.obstacleAwareness().alerts[0]).toMatchObject({ relevant: true, zoneId: "z1" });
  });

  test("a route clear of the footprint is not relevant and changes nothing", () => {
    const vr = robotWithRoute([
      { lat: C.lat + D, lon: C.lon - D },
      { lat: C.lat + D, lon: C.lon },
      { lat: C.lat + D, lon: C.lon + D },
    ]);
    const before = state(vr);
    vr._onObstacleAlert(alert());
    expect(vr.socket.emit.mock.calls[0][1]).toMatchObject({ relevant: false, decision: "NOT_RELEVANT" });
    expect(state(vr)).toBe(before);
  });

  test("the part of the route already driven does not count", () => {
    const vr = robotWithRoute([
      { lat: C.lat, lon: C.lon - D },
      { lat: C.lat, lon: C.lon + D },
      { lat: C.lat + D, lon: C.lon + D },
    ]);
    // Past the obstacle: now on the second stop, heading north away from it.
    vr.stopIndex = 1;
    vr.activePath = vr.task.stops[1].path;
    vr.pathIndex = 1;
    vr.lat = C.lat + 0.0005;
    vr.lon = C.lon + D;
    vr._onObstacleAlert(alert());
    expect(vr.socket.emit.mock.calls[0][1]).toMatchObject({ relevant: false });
  });

  test("duplicates, its own report and malformed alerts are ignored", () => {
    const vr = robotWithRoute([{ lat: C.lat, lon: C.lon - D }, { lat: C.lat, lon: C.lon }, { lat: C.lat, lon: C.lon + D }]);
    vr._onObstacleAlert(alert());
    vr._onObstacleAlert(alert());
    vr._onObstacleAlert(alert({ obstacleId: "OBS-2", reportingRobotId: "SIM-U" }));
    vr._onObstacleAlert(alert({ obstacleId: "OBS-3", footprint: { polygon: [] } }));
    expect(vr.socket.emit).toHaveBeenCalledTimes(1);
  });

  test("world sensing waits for an authenticated session and reports each obstacle once", () => {
    const vr = new VirtualRobot({
      robotId: "SIM-S",
      lat: C.lat,
      lon: C.lon,
      logger: quiet,
      simulated: true,
      worldObstacles: [{ id: "OB-1", lat: C.lat + 0.00005, lon: C.lon, severity: "HIGH", senseRadiusM: 15 }],
    });
    vr.socket = { emit: jest.fn(), connected: true };
    vr._senseWorldObstacles();
    expect(vr.socket.emit).not.toHaveBeenCalled();
    vr._handlerSocket = vr.socket;
    vr._senseWorldObstacles();
    vr._senseWorldObstacles();
    expect(vr.socket.emit).toHaveBeenCalledTimes(1);
    expect(vr.socket.emit).toHaveBeenCalledWith("OBSTACLE_REPORT", { lat: C.lat + 0.00005, lon: C.lon, severity: "HIGH" });
  });
});

describe("dtaroZoneAlert — one active obstacle per published cell (duplicates and expiry)", () => {
  const { createTestKv } = require("../../helpers/testKv");
  const MAP = { spatial: { regions: [{ id: "rA" }], zones: [{ id: "z1", regionId: "rA" }], cells: [{ cellId: CELL, resolution: "FINE", regionId: "rA", zoneId: "z1" }] } };

  function harness() {
    const emitted = [];
    const room = (name) => ({
      emit: (event, payload) => emitted.push({ room: name, event, payload }),
      except: () => room(name),
    });
    const io = { to: (name) => room(name), in: () => ({ fetchSockets: async () => [{ data: { robotId: "SIM-B" } }] }) };
    const socket = (robotId) => ({ data: { robotId, isAuthed: true, dtaroEligible: true, dtaroZone: { regionId: "rA", zoneId: "z1" } }, emit: (event, payload) => emitted.push({ room: `socket:${robotId}`, event, payload }) });
    return { emitted, io, socket };
  }

  const report = async (h, kv, robotId) =>
    dtaroZoneAlert.processReport({ io: h.io, prisma: null, kv, snapshot: MAP, socket: h.socket(robotId), reporterRobotId: robotId, report: { lat: C.lat, lon: C.lon, severity: "HIGH" } });

  afterEach(() => {
    dtaroZoneAlert.resetForTests();
    jest.restoreAllMocks();
  });

  test("first report alerts; a second robot is a corroboration; the original reporter repeating is a repeat — one alert in all", async () => {
    const { kv } = await createTestKv();
    const h = harness();
    const first = await report(h, kv, "SIM-A");
    expect(first).toMatchObject({ accepted: true, recipients: ["SIM-B"] });
    expect(first.merged).toBeUndefined();

    const second = await report(h, kv, "SIM-C");
    expect(second).toMatchObject({ accepted: true, merged: true });
    expect(second.alert).toMatchObject({ obstacleId: first.obstacle.obstacleId, corroborations: ["SIM-C"], repeat: false });

    const third = await report(h, kv, "SIM-A");
    expect(third.alert).toMatchObject({ obstacleId: first.obstacle.obstacleId, corroborations: ["SIM-C"], repeat: true });

    expect(h.emitted.filter((e) => e.event === dtaroZoneAlert.ALERT_EVENT)).toHaveLength(1);
    expect(h.emitted.filter((e) => e.event === "ALERT_CREATED")).toHaveLength(1);
    expect(h.emitted.filter((e) => e.event === dtaroZoneAlert.MERGED_EVENT)).toHaveLength(2);
  });

  test("after the obstacle's lifetime ends, a report of the same cell is a new obstacle and alerts again", async () => {
    const { kv } = await createTestKv();
    const h = harness();
    const t0 = Date.now();
    const now = jest.spyOn(Date, "now").mockReturnValue(t0);
    const first = await report(h, kv, "SIM-A");
    now.mockReturnValue(t0 + 300_001);
    const later = await report(h, kv, "SIM-C");
    expect(later.merged).toBeUndefined();
    expect(later.obstacle.obstacleId).not.toBe(first.obstacle.obstacleId);
    expect(h.emitted.filter((e) => e.event === dtaroZoneAlert.ALERT_EVENT)).toHaveLength(2);
  });

  test("concurrent reports of one cell create ONE obstacle: the rest merge, even while the first is still being stored", async () => {
    const { kv } = await createTestKv();
    const h = harness();
    // Make storing slow, so all three reports are in flight before the first one finishes.
    const ekb = require("../../../src/services/ekb.service");
    const realStore = ekb.storeObstacle;
    jest.spyOn(ekb, "storeObstacle").mockImplementation(async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return realStore(...args);
    });
    const results = await Promise.all(["SIM-A", "SIM-C", "SIM-D"].map((id) => report(h, kv, id)));
    const created = results.filter((r) => !r.merged);
    expect(created).toHaveLength(1);
    expect(results.filter((r) => r.merged).map((r) => r.alert.obstacleId)).toEqual([created[0].obstacle.obstacleId, created[0].obstacle.obstacleId]);
    expect(ekb.storeObstacle).toHaveBeenCalledTimes(1);
    expect(h.emitted.filter((e) => e.event === dtaroZoneAlert.ALERT_EVENT)).toHaveLength(1);
    expect(h.emitted.filter((e) => e.event === "ALERT_CREATED")).toHaveLength(1);
  });

  test("two distinct obstacles in adjacent published cells are NOT merged: each alerts", async () => {
    const { kv } = await createTestKv();
    const h = harness();
    const neighbour = h3.gridDisk(CELL, 1).find((id) => id !== CELL);
    const [nLat, nLon] = h3.cellToLatLng(neighbour);
    const map2 = { spatial: { ...MAP.spatial, cells: [...MAP.spatial.cells, { cellId: neighbour, resolution: "FINE", regionId: "rA", zoneId: "z1" }] } };
    const first = await dtaroZoneAlert.processReport({ io: h.io, prisma: null, kv, snapshot: map2, socket: h.socket("SIM-A"), reporterRobotId: "SIM-A", report: { lat: C.lat, lon: C.lon, severity: "HIGH" } });
    const second = await dtaroZoneAlert.processReport({ io: h.io, prisma: null, kv, snapshot: map2, socket: h.socket("SIM-C"), reporterRobotId: "SIM-C", report: { lat: nLat, lon: nLon, severity: "HIGH" } });
    expect(second.merged).toBeUndefined();
    expect(second.obstacle.obstacleId).not.toBe(first.obstacle.obstacleId);
    expect([first.alert.cellId, second.alert.cellId]).toEqual([CELL, neighbour]);
    expect(h.emitted.filter((e) => e.event === dtaroZoneAlert.ALERT_EVENT)).toHaveLength(2);
  });

  test("a verdict carries its obstacle's expiry; a verdict after expiry is refused and relays nothing", async () => {
    const { kv } = await createTestKv();
    const h = harness();
    const t0 = Date.now();
    const now = jest.spyOn(Date, "now").mockReturnValue(t0);
    const first = await report(h, kv, "SIM-A");
    const answer = { obstacleId: first.obstacle.obstacleId, relevant: false, routeSource: "NONE", decision: "NO_PLANNED_ROUTE" };
    const relayed = dtaroZoneAlert.recordRelevance({ io: h.io, robotId: "SIM-B", payload: answer });
    expect(relayed).toMatchObject({ accepted: true, payload: { expiresAt: first.obstacle.expiresAt } });

    now.mockReturnValue(t0 + 300_001);
    const late = dtaroZoneAlert.recordRelevance({ io: h.io, robotId: "SIM-B", payload: { ...answer, decision: "LATE" } });
    expect(late).toEqual({ accepted: false, reason: "UNKNOWN_OBSTACLE" });
    expect(h.emitted.filter((e) => e.event === dtaroZoneAlert.RELEVANCE_EVENT)).toHaveLength(1);
  });

  test("a merged report names the obstacle's original expiry; merging never extends its lifetime", async () => {
    const { kv } = await createTestKv();
    const h = harness();
    const t0 = Date.now();
    const now = jest.spyOn(Date, "now").mockReturnValue(t0);
    const first = await report(h, kv, "SIM-A");
    now.mockReturnValue(t0 + 200_000);
    const merged = await report(h, kv, "SIM-C");
    expect(merged.alert.expiresAt).toBe(first.obstacle.expiresAt);
    now.mockReturnValue(t0 + 300_001);
    expect(dtaroZoneAlert.ledgerGet(first.obstacle.obstacleId)).toBeNull();
  });

  test("the same cell in another region is a different obstacle", async () => {
    const { kv } = await createTestKv();
    const h = harness();
    const map2 = { spatial: { ...MAP.spatial, regions: [{ id: "rB" }], cells: [{ cellId: CELL, resolution: "FINE", regionId: "rB", zoneId: "z1" }] } };
    const first = await report(h, kv, "SIM-A");
    const sock = { ...h.socket("SIM-X"), data: { robotId: "SIM-X", isAuthed: true, dtaroEligible: true, dtaroZone: { regionId: "rB", zoneId: "z1" } } };
    const other = await dtaroZoneAlert.processReport({ io: h.io, prisma: null, kv, snapshot: map2, socket: sock, reporterRobotId: "SIM-X", report: { lat: C.lat, lon: C.lon, severity: "LOW" } });
    expect(other.merged).toBeUndefined();
    expect(other.obstacle.obstacleId).not.toBe(first.obstacle.obstacleId);
  });
});
