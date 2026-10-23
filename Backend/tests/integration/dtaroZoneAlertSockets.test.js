"use strict";

/**
 * DTARO zone-scoped obstacle alerts over REAL local sockets.
 *
 * A real HTTP + Socket.IO server composed by the shipped `initSocketServer` (robot AUTH,
 * TELEMETRY and DTARO handlers as registered in production), and real `VirtualRobot`
 * instances connecting to it over websockets with `socket.io-client`. Every hop the flow
 * takes — AUTH, telemetry, the commanded route (TASK_ASSIGN), OBSTACLE_REPORT, the zone-room
 * OBSTACLE_ALERT, OBSTACLE_RELEVANCE, and the dashboard events — crosses a real socket.
 *
 * What is NOT real, and why:
 *   * Prisma is an in-memory stand-in (no database in the test environment). It answers the
 *     robot rows AUTH reads and accepts every other call as a no-op.
 *   * The spatial authority is a SYNTHETIC published map (two regions, three zones, H3 res-11
 *     cells), passed as `appLocals.config.spatial` exactly where the pinned snapshot lives.
 *     It is not the RNSIT map, and nothing here claims the proposed RNSIT zones are live.
 *   * Routes are straight synthetic polylines delivered by the legacy TASK_ASSIGN dispatch,
 *     which builds the same `task.stops` an engine OFFER builds. The engine is off.
 *   * World sensing is invoked directly (`_senseWorldObstacles`) instead of waiting for the
 *     2 s tick, so the test does not depend on timing; the emit it makes is the real one.
 */

jest.mock("../../src/db/prisma");

const http = require("http");
const h3 = require("h3-js");
const jwt = require("jsonwebtoken");
const { Server } = require("socket.io");
const { io: ioClient } = require("socket.io-client");

const { getPrisma } = require("../../src/db/prisma");
const initSocketServer = require("../../src/sockets/socket.server");
const dashboardBroadcast = require("../../src/sockets/dashboardBroadcast");
const { dispatchTaskAssign } = require("../../src/services/commandDispatcher.service");
const dtaroZoneAlert = require("../../src/services/dtaroZoneAlert.service");
const VirtualRobot = require("../../src/simulation/VirtualRobot");
const { createTestKv } = require("../helpers/testKv");
const { createPermissivePrisma } = require("../helpers/permissivePrisma");
const { waitFor } = require("../helpers/waitFor");
const silentLogger = require("../mocks/silentLogger");

// ── Synthetic spatial authority ──────────────────────────────────────────────

const RES = 11;
const P_A = { lat: 12.9023, lon: 77.5186 };   // region rA, zone z1
const P_A2 = { lat: 12.9023, lon: 77.53 };    // region rA, zone z2 (~1.2 km east)
const P_B = { lat: 12.9027, lon: 77.505 };    // region rB, zone ALSO labelled z1 (~1.5 km west)

function disk(point, k) {
  return h3.gridDisk(h3.latLngToCell(point.lat, point.lon, RES), k);
}

function buildMap() {
  const assignments = [];
  const add = (cellIds, regionId, zoneId) => {
    for (const cellId of cellIds) assignments.push({ cellId, resolution: "FINE", regionId, zoneId, siteId: null });
  };
  add(disk(P_A, 8), "rA", "z1");
  add(disk(P_A2, 4), "rA", "z2");
  // Region B's zone carries the SAME local label as region A's: the cell names its own region.
  add(disk(P_B, 8), "rB", "z1");
  return {
    regions: [{ id: "rA" }, { id: "rB" }],
    zones: [{ id: "z1", regionId: "rA" }, { id: "z2", regionId: "rA" }],
    sites: [],
    cells: assignments,
  };
}

const SPATIAL = buildMap();
const OBSTACLE = (() => {
  const [lat, lon] = h3.cellToLatLng(h3.latLngToCell(P_A.lat, P_A.lon, RES));
  return { lat, lon };
})();
const OBSTACLE_B = (() => {
  const [lat, lon] = h3.cellToLatLng(h3.latLngToCell(P_B.lat + 0.0005, P_B.lon, RES));
  return { lat, lon };
})();

const at = (base, dLat, dLon) => ({ lat: base.lat + dLat, lon: base.lon + dLon });

// ── Fleet ────────────────────────────────────────────────────────────────────

const FLEET = {
  "SIM-REPORTER": { position: at(OBSTACLE, 0.00004, 0), simulated: true },   // ~4 m from the obstacle
  "SIM-CROSS":    { position: at(OBSTACLE, 0, -0.002), simulated: true },    // route runs through it
  "SIM-CLEAR":    { position: at(OBSTACLE, 0.0015, -0.002), simulated: true }, // parallel route ~166 m north
  "SIM-IDLE":     { position: at(OBSTACLE, 0.001, 0), simulated: true },     // same zone, no route
  "SIM-ZONE2":    { position: P_A2, simulated: true },                       // same region, other zone
  "SIM-B1":       { position: null, simulated: true },                       // region B, zone "z1", beside OBSTACLE_B
  "SIM-B2":       { position: at(P_B, -0.0005, 0), simulated: true },        // region B, zone "z1"
  "PHY-1":        { position: at(OBSTACLE, -0.0005, 0), simulated: false },  // physical, region A zone z1
};

FLEET["SIM-B1"].position = at(OBSTACLE_B, 0.00004, 0);

const ROUTE_CROSS = {
  taskId: "TSK-CROSS",
  pickup: at(OBSTACLE, 0, 0.0005),
  drop: at(OBSTACLE, 0, 0.002),
  pathToPickup: [FLEET["SIM-CROSS"].position, at(OBSTACLE, 0, -0.001), at(OBSTACLE, 0, 0.0005)],
  pathToDrop: [at(OBSTACLE, 0, 0.0005), at(OBSTACLE, 0, 0.002)],
};
const ROUTE_CLEAR = {
  taskId: "TSK-CLEAR",
  pickup: at(OBSTACLE, 0.0015, 0),
  drop: at(OBSTACLE, 0.0015, 0.002),
  pathToPickup: [FLEET["SIM-CLEAR"].position, at(OBSTACLE, 0.0015, 0)],
  pathToDrop: [at(OBSTACLE, 0.0015, 0), at(OBSTACLE, 0.0015, 0.002)],
};

const SUPER = { id: "11111111-1111-4111-8111-111111111111", email: "root@x", role: "SUPER_ADMIN", campusId: null, campus: null, disabledAt: null };

function robotRow(robotId) {
  const spec = FLEET[robotId];
  if (!spec) return null;
  return {
    id: `db-${robotId}`,
    robotId,
    status: "IDLE",
    isOnline: false,
    lat: spec.position.lat,
    lon: spec.position.lon,
    battery: 90,
    simulated: spec.simulated,
    agent: null,
  };
}

/** Answers the robot rows and the dashboard account; accepts everything else as a no-op. */
function createPrismaStandIn() {
  return createPermissivePrisma((model, method, args) => {
    if (model === "robot" && (method === "findUnique" || method === "findFirst")) {
      return robotRow(args?.where?.robotId ?? args?.where?.OR?.[0]?.robotId);
    }
    if (model === "user" && method === "findUnique") return args?.where?.id === SUPER.id ? SUPER : null;
    return undefined;
  });
}

// ── Harness ──────────────────────────────────────────────────────────────────

describe("DTARO zone alerts over real local sockets", () => {
  const previousSwitch = process.env[dtaroZoneAlert.ENV_SWITCH];
  let httpServer;
  let io;
  let port;
  let kv;
  const robots = new Map();
  const extraClients = [];
  let dashboardSeen;

  async function startRobot(robotId) {
    const spec = FLEET[robotId];
    const token = `session-${robotId}`;
    await kv.set(`session:${robotId}`, token, { ex: 3600 });
    const vr = new VirtualRobot({
      robotId,
      lat: spec.position.lat,
      lon: spec.position.lon,
      logger: silentLogger,
      kv,
      simulated: true,
      obstacleProbability: 0,
      worldObstacles: [
        { id: "OB-A", lat: OBSTACLE.lat, lon: OBSTACLE.lon, severity: "HIGH", senseRadiusM: 15 },
        { id: "OB-B", lat: OBSTACLE_B.lat, lon: OBSTACLE_B.lon, severity: "MEDIUM", senseRadiusM: 15 },
      ],
    });
    vr.sessionToken = token;
    vr.connect(`http://127.0.0.1:${port}`);
    await waitFor(() => vr._sessionEstablished(), { timeout: 5000 });
    robots.set(robotId, vr);
    return vr;
  }

  async function sendTelemetry(vr) {
    vr._emitTelemetry(Date.now());
    // Membership is applied by the telemetry handler; wait for the server to hold it.
    await waitFor(async () => {
      const sockets = await io.fetchSockets();
      const s = sockets.find((x) => x.data.robotId === vr.robotId);
      return s && s.data.telemetryReceipt >= 1;
    }, { timeout: 5000 });
  }

  async function membersOf(room) {
    const sockets = await io.in(room).fetchSockets();
    return sockets.map((s) => s.data.robotId).sort();
  }

  async function connectPhysical(robotId) {
    await kv.set(`session:${robotId}`, "phy-token", { ex: 3600 });
    const client = ioClient(`http://127.0.0.1:${port}`, { transports: ["websocket"], reconnection: false, forceNew: true });
    extraClients.push(client);
    const received = [];
    client.onAny((event, payload) => received.push({ event, payload }));
    await new Promise((resolve, reject) => { client.on("connect", resolve); client.on("connect_error", reject); });
    client.emit("AUTH", { robotId, token: "phy-token" });
    await waitFor(() => received.some((m) => m.event === "AUTH_SUCCESS"), { timeout: 5000 });
    return { client, received };
  }

  async function connectDashboard() {
    const token = jwt.sign({ id: SUPER.id }, process.env.JWT_SECRET);
    const client = ioClient(`http://127.0.0.1:${port}`, {
      transports: ["websocket"],
      reconnection: false,
      forceNew: true,
      extraHeaders: { "user-agent": "Mozilla/5.0 (test dashboard)", cookie: `token=${token}` },
    });
    extraClients.push(client);
    const seen = [];
    client.onAny((event, payload) => seen.push({ event, payload }));
    await new Promise((resolve, reject) => { client.once("connect", resolve); client.once("connect_error", reject); });
    await waitFor(async () => (await io.in(dashboardBroadcast.ROOM).fetchSockets()).length > 0, { timeout: 3000 });
    return seen;
  }

  function navigationState(vr) {
    return JSON.stringify({
      lat: vr.lat,
      lon: vr.lon,
      status: vr.status,
      phase: vr.phase,
      stopIndex: vr.stopIndex,
      pathIndex: vr.pathIndex,
      activePath: vr.activePath,
      stops: vr.task ? vr.task.stops.map((s) => s.path) : null,
      speed: vr.speed,
    });
  }

  beforeAll(async () => {
    process.env[dtaroZoneAlert.ENV_SWITCH] = "true";
    getPrisma.mockReturnValue(createPrismaStandIn());
    ({ kv } = await createTestKv());

    httpServer = http.createServer();
    io = new Server(httpServer, { cors: { origin: true, credentials: true } });
    initSocketServer(io, {
      prisma: getPrisma(),
      kv,
      logger: silentLogger,
      appLocals: { config: { version: "synthetic-dtaro-1", spatial: SPATIAL } },
    });
    await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    port = httpServer.address().port;

    dashboardSeen = await connectDashboard();
    for (const robotId of Object.keys(FLEET).filter((id) => FLEET[id].simulated)) {
      const vr = await startRobot(robotId);
      await sendTelemetry(vr);
    }

    // The commanded routes, delivered over the robots' own rooms.
    await dispatchTaskAssign(io, "SIM-CROSS", ROUTE_CROSS);
    await dispatchTaskAssign(io, "SIM-CLEAR", ROUTE_CLEAR);
    await waitFor(() => robots.get("SIM-CROSS").task && robots.get("SIM-CLEAR").task, { timeout: 5000 });
  }, 30_000);

  afterAll(async () => {
    for (const vr of robots.values()) vr.stop();
    for (const c of extraClients) { try { c.close(); } catch { /* ignore */ } }
    io.close();
    await new Promise((resolve) => httpServer.close(resolve));
    if (previousSwitch === undefined) delete process.env[dtaroZoneAlert.ENV_SWITCH];
    else process.env[dtaroZoneAlert.ENV_SWITCH] = previousSwitch;
  });

  test("membership is server-computed and region-qualified: same label 'z1' in two regions is two rooms", async () => {
    const roomAz1 = dtaroZoneAlert.zoneRoom("rA", "z1");
    const roomBz1 = dtaroZoneAlert.zoneRoom("rB", "z1");
    expect(roomAz1).not.toBe(roomBz1);
    expect(await membersOf(roomAz1)).toEqual(["SIM-CLEAR", "SIM-CROSS", "SIM-IDLE", "SIM-REPORTER"]);
    expect(await membersOf(dtaroZoneAlert.zoneRoom("rA", "z2"))).toEqual(["SIM-ZONE2"]);
    expect(await membersOf(roomBz1)).toEqual(["SIM-B1", "SIM-B2"]);
  });

  test("positive delivery: reporter → zone room → relevance decided by each receiver; no route or motion changes", async () => {
    const before = {
      cross: navigationState(robots.get("SIM-CROSS")),
      clear: navigationState(robots.get("SIM-CLEAR")),
      idle: navigationState(robots.get("SIM-IDLE")),
    };

    robots.get("SIM-REPORTER")._senseWorldObstacles();

    await waitFor(
      () => dashboardSeen.filter((m) => m.event === "OBSTACLE_RELEVANCE").length >= 3,
      { timeout: 5000 },
    );

    const created = dashboardSeen.find((m) => m.event === "ALERT_CREATED");
    expect(created.payload).toMatchObject({
      reportingRobotId: "SIM-REPORTER",
      regionId: "rA",
      zoneId: "z1",
      delivery: "ZONE_ROOM",
      recipients: ["SIM-CLEAR", "SIM-CROSS", "SIM-IDLE"],
    });
    const obstacleId = created.payload.obstacleId;

    // The reporter was told who received it.
    const reporter = robots.get("SIM-REPORTER").obstacleAwareness().reported.find((r) => r.worldId === "OB-A");
    expect(reporter).toMatchObject({ outcome: "ACCEPTED", obstacleId });

    // Receivers, over their real sockets.
    const cross = robots.get("SIM-CROSS").obstacleAwareness().alerts;
    const clear = robots.get("SIM-CLEAR").obstacleAwareness().alerts;
    const idle = robots.get("SIM-IDLE").obstacleAwareness().alerts;
    expect(cross).toEqual([expect.objectContaining({ obstacleId, relevant: true, routeSource: "COMMANDED_ROUTE", taskId: "TSK-CROSS", decision: "RELEVANT_NO_REPLAN" })]);
    expect(clear).toEqual([expect.objectContaining({ obstacleId, relevant: false, routeSource: "COMMANDED_ROUTE", taskId: "TSK-CLEAR", decision: "NOT_RELEVANT" })]);
    expect(idle).toEqual([expect.objectContaining({ obstacleId, relevant: false, routeSource: "NONE", decision: "NO_PLANNED_ROUTE" })]);

    // Not delivered outside the zone, outside the region, or to the reporter.
    for (const id of ["SIM-ZONE2", "SIM-B1", "SIM-B2", "SIM-REPORTER"]) {
      expect(robots.get(id).obstacleAwareness().alerts).toEqual([]);
    }

    // The dashboard sees each verdict, attributed by the server.
    const verdicts = dashboardSeen.filter((m) => m.event === "OBSTACLE_RELEVANCE").map((m) => m.payload);
    expect(verdicts.map((v) => [v.robotId, v.relevant, v.decision]).sort()).toEqual([
      ["SIM-CLEAR", false, "NOT_RELEVANT"],
      ["SIM-CROSS", true, "RELEVANT_NO_REPLAN"],
      ["SIM-IDLE", false, "NO_PLANNED_ROUTE"],
    ]);
    for (const v of verdicts) expect(v).toMatchObject({ obstacleId, regionId: "rA", zoneId: "z1", reportingRobotId: "SIM-REPORTER" });

    // Relevance detection only: neither the relevant nor the irrelevant receiver moved or rerouted.
    expect(navigationState(robots.get("SIM-CROSS"))).toBe(before.cross);
    expect(navigationState(robots.get("SIM-CLEAR"))).toBe(before.clear);
    expect(navigationState(robots.get("SIM-IDLE"))).toBe(before.idle);
  });

  test("the receiver that drives into the obstacle does not report it again (already alerted)", () => {
    const cross = robots.get("SIM-CROSS");
    const saved = { lat: cross.lat, lon: cross.lon };
    cross.lat = OBSTACLE.lat;
    cross.lon = OBSTACLE.lon;
    cross._senseWorldObstacles();
    cross.lat = saved.lat;
    cross.lon = saved.lon;
    expect(cross.obstacleAwareness().reported).toEqual([expect.objectContaining({ worldId: "OB-A", outcome: "ALREADY_ALERTED" })]);
  });

  test("cross-region isolation with identical labels: a region-B report reaches region B's z1 only", async () => {
    const seenBefore = dashboardSeen.length;
    robots.get("SIM-B1")._senseWorldObstacles();
    await waitFor(() => robots.get("SIM-B2").obstacleAwareness().alerts.length === 1, { timeout: 5000 });
    await new Promise((resolve) => setTimeout(resolve, 150));

    const alert = robots.get("SIM-B2").obstacleAwareness().alerts[0];
    expect(alert).toMatchObject({ regionId: "rB", zoneId: "z1", reportingRobotId: "SIM-B1" });
    for (const id of ["SIM-CROSS", "SIM-CLEAR", "SIM-IDLE", "SIM-REPORTER", "SIM-ZONE2"]) {
      expect(robots.get(id).obstacleAwareness().alerts.some((a) => a.obstacleId === alert.obstacleId)).toBe(false);
    }
    const created = dashboardSeen.slice(seenBefore).find((m) => m.event === "ALERT_CREATED");
    expect(created.payload).toMatchObject({ regionId: "rB", zoneId: "z1", recipients: ["SIM-B2"] });
  });

  test("duplicate: a second robot reporting the same published cell is merged — no new alert, ACK names the active obstacle", async () => {
    const created = dashboardSeen.find((m) => m.event === "ALERT_CREATED" && m.payload.regionId === "rA");
    const original = created.payload.obstacleId;
    const alertsBefore = Object.fromEntries([...robots].map(([id, vr]) => [id, vr.obstacleAwareness().alerts.length]));
    const createdBefore = dashboardSeen.filter((m) => m.event === "ALERT_CREATED").length;

    const vr = robots.get("SIM-CLEAR");
    const ack = new Promise((resolve) => vr.socket.once("OBSTACLE_REPORT_ACK", resolve));
    vr.socket.emit("OBSTACLE_REPORT", { lat: OBSTACLE.lat + 0.00001, lon: OBSTACLE.lon, severity: "LOW" });
    expect(await ack).toMatchObject({ delivery: "MERGED", duplicateOf: original, obstacleId: original, recipients: [] });

    await waitFor(() => dashboardSeen.some((m) => m.event === "OBSTACLE_REPORT_MERGED"), { timeout: 3000 });
    const merged = dashboardSeen.find((m) => m.event === "OBSTACLE_REPORT_MERGED").payload;
    expect(merged).toMatchObject({ obstacleId: original, reportingRobotId: "SIM-CLEAR", originalReporterId: "SIM-REPORTER", corroborations: ["SIM-CLEAR"], repeat: false });

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(dashboardSeen.filter((m) => m.event === "ALERT_CREATED").length).toBe(createdBefore);
    for (const [id, vr2] of robots) expect(vr2.obstacleAwareness().alerts.length).toBe(alertsBefore[id]);
  });

  test("a report naming a point in another region is refused (WRONG_REGION), and nothing is delivered", async () => {
    const vr = robots.get("SIM-B2");
    const rejected = new Promise((resolve) => vr.socket.once("OBSTACLE_REPORT_REJECTED", resolve));
    const alertsBefore = robots.get("SIM-CROSS").obstacleAwareness().alerts.length;
    // The client also claims region A and zone z1: the server ignores both fields.
    vr.socket.emit("OBSTACLE_REPORT", { lat: OBSTACLE.lat + 0.0002, lon: OBSTACLE.lon, severity: "HIGH", regionId: "rA", zoneId: "z1" });
    const payload = await rejected;
    expect(payload).toMatchObject({ reason: "WRONG_REGION", reporterRegionId: "rB", obstacleRegionId: "rA" });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(robots.get("SIM-CROSS").obstacleAwareness().alerts.length).toBe(alertsBefore);
  });

  test("a client-supplied region or zone does not redirect delivery", async () => {
    const vr = robots.get("SIM-REPORTER");
    await new Promise((resolve) => setTimeout(resolve, 550)); // the handler's minimum report interval
    const ack = new Promise((resolve) => vr.socket.once("OBSTACLE_REPORT_ACK", resolve));
    vr.socket.emit("OBSTACLE_REPORT", { lat: OBSTACLE.lat + 0.0003, lon: OBSTACLE.lon, severity: "LOW", regionId: "rB", zoneId: "z1" });
    const payload = await ack;
    expect(payload).toMatchObject({ regionId: "rA", zoneId: "z1", delivery: "ZONE_ROOM" });
    expect(payload.recipients).toEqual(["SIM-CLEAR", "SIM-CROSS", "SIM-IDLE"]);
  });

  test.each([
    ["out-of-range coordinates", { lat: 999, lon: 77.5 }, "INVALID_COORDINATES"],
    ["a cell the published map does not assign", { lat: 12.95, lon: 77.6 }, "UNASSIGNED_CELL"],
  ])("invalid report: %s is refused (%s) and stores nothing", async (_label, point, reason) => {
    const vr = robots.get("SIM-REPORTER");
    const rejected = new Promise((resolve) => vr.socket.once("OBSTACLE_REPORT_REJECTED", resolve));
    await new Promise((resolve) => setTimeout(resolve, 550)); // the handler's minimum report interval
    vr.socket.emit("OBSTACLE_REPORT", { ...point, severity: "HIGH" });
    expect(await rejected).toMatchObject({ reason });
    await waitFor(() => dashboardSeen.some((m) => m.event === "OBSTACLE_REPORT_REJECTED" && m.payload.reason === reason), { timeout: 3000 });
  });

  test("a malformed report is refused by the existing schema (ERROR 'Invalid payload')", async () => {
    const vr = robots.get("SIM-REPORTER");
    await new Promise((resolve) => setTimeout(resolve, 550));
    const error = new Promise((resolve) => vr.socket.once("ERROR", resolve));
    vr.socket.emit("OBSTACLE_REPORT", { lat: "12.9", lon: null });
    expect(await error).toMatchObject({ event: "OBSTACLE_REPORT", reason: "Invalid payload" });
  });

  test("a physical robot is neither a zone member nor an accepted reporter", async () => {
    const { client, received } = await connectPhysical("PHY-1");
    client.emit("TELEMETRY", { robotId: "PHY-1", ...FLEET["PHY-1"].position, battery: 80, speed: 0, status: "IDLE", timestamp: Date.now(), sequence: 1 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await membersOf(dtaroZoneAlert.zoneRoom("rA", "z1"))).not.toContain("PHY-1");

    client.emit("OBSTACLE_REPORT", { ...OBSTACLE, severity: "HIGH" });
    await waitFor(() => received.some((m) => m.event === "OBSTACLE_REPORT_REJECTED"), { timeout: 3000 });
    expect(received.find((m) => m.event === "OBSTACLE_REPORT_REJECTED").payload.reason).toBe("REPORTER_NOT_SIMULATED");
    client.close();
  });

  test("relevance answers are accepted only from recipients, once", async () => {
    const created = dashboardSeen.find((m) => m.event === "ALERT_CREATED" && m.payload.regionId === "rA");
    const obstacleId = created.payload.obstacleId;

    const outsider = robots.get("SIM-ZONE2");
    const refused = new Promise((resolve) => outsider.socket.once("ERROR", resolve));
    outsider.socket.emit("OBSTACLE_RELEVANCE", { obstacleId, relevant: true, routeSource: "NONE", decision: "FORGED" });
    expect(await refused).toMatchObject({ event: "OBSTACLE_RELEVANCE", reason: "NOT_A_RECIPIENT" });

    const recipient = robots.get("SIM-CROSS");
    const duplicate = new Promise((resolve) => recipient.socket.once("ERROR", resolve));
    recipient.socket.emit("OBSTACLE_RELEVANCE", { obstacleId, relevant: false, routeSource: "NONE", decision: "CHANGED_MIND" });
    expect(await duplicate).toMatchObject({ reason: "DUPLICATE" });
  });

  test("disconnect/reconnect: the new socket is re-joined to its zone room at AUTH and receives later alerts", async () => {
    const vr = robots.get("SIM-CLEAR");
    const room = dtaroZoneAlert.zoneRoom("rA", "z1");
    const oldSocketId = (await io.in(room).fetchSockets()).find((s) => s.data.robotId === "SIM-CLEAR").id;

    vr.socket.disconnect();
    await waitFor(async () => !(await membersOf(room)).includes("SIM-CLEAR"), { timeout: 3000 });

    vr.socket.connect(); // same client Socket object, new server-side socket
    await waitFor(async () => {
      const s = (await io.in(room).fetchSockets()).find((x) => x.data.robotId === "SIM-CLEAR");
      return s && s.id !== oldSocketId;
    }, { timeout: 5000 });

    const reporter = robots.get("SIM-REPORTER");
    await new Promise((resolve) => setTimeout(resolve, 550));
    const ack = new Promise((resolve) => reporter.socket.once("OBSTACLE_REPORT_ACK", resolve));
    reporter.socket.emit("OBSTACLE_REPORT", { lat: OBSTACLE.lat - 0.0003, lon: OBSTACLE.lon, severity: "MEDIUM" });
    const { obstacleId, recipients } = await ack;
    expect(recipients).toContain("SIM-CLEAR");
    await waitFor(() => vr.obstacleAwareness().alerts.some((a) => a.obstacleId === obstacleId), { timeout: 5000 });
  });

  test("moving to another zone moves the room: telemetry re-places the robot", async () => {
    const vr = robots.get("SIM-IDLE");
    vr.lat = P_A2.lat;
    vr.lon = P_A2.lon + 0.0002;
    vr._emitTelemetry(Date.now());
    await waitFor(async () => (await membersOf(dtaroZoneAlert.zoneRoom("rA", "z2"))).includes("SIM-IDLE"), { timeout: 5000 });
    expect(await membersOf(dtaroZoneAlert.zoneRoom("rA", "z1"))).not.toContain("SIM-IDLE");
  });
});
