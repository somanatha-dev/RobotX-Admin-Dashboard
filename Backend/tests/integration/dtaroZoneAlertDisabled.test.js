"use strict";

/**
 * DTARO zone alerts OFF (the default) — the previous behaviour, over REAL local sockets.
 *
 * The shipped `initSocketServer` composition and real `VirtualRobot` clients, with
 * `DTARO_ZONE_ALERTS_ENABLED` unset and a published map pinned (so the new path WOULD have
 * something to resolve against if it ran). Prisma is an in-memory stand-in; this is not a
 * full-stack test.
 *
 * With the switch off:
 *   * no socket joins a `dtaro:*` room, at AUTH or on telemetry;
 *   * OBSTACLE_REPORT takes the legacy path: the ACK carries exactly the legacy fields
 *     `{ obstacleId, affectedRobots, timestamp }`, ALERT_CREATED carries no dissemination
 *     fields, and no robot receives OBSTACLE_ALERT;
 *   * an OBSTACLE_RELEVANCE frame is ignored (no answer, no dashboard event);
 *   * a report the new path would refuse (a point in no published cell) is accepted as before.
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
const dtaroZoneAlert = require("../../src/services/dtaroZoneAlert.service");
const VirtualRobot = require("../../src/simulation/VirtualRobot");
const { createTestKv } = require("../helpers/testKv");
const { createPermissivePrisma } = require("../helpers/permissivePrisma");
const { waitFor } = require("../helpers/waitFor");
const silentLogger = require("../mocks/silentLogger");

const CENTRE = { lat: 12.9023, lon: 77.5186 };
const SPATIAL = {
  regions: [{ id: "rA" }],
  zones: [{ id: "z1", regionId: "rA" }],
  sites: [],
  cells: h3.gridDisk(h3.latLngToCell(CENTRE.lat, CENTRE.lon, 11), 6).map((cellId) => ({ cellId, resolution: "FINE", regionId: "rA", zoneId: "z1" })),
};
const FLEET = {
  "SIM-OFF-A": { lat: CENTRE.lat, lon: CENTRE.lon },
  "SIM-OFF-B": { lat: CENTRE.lat + 0.001, lon: CENTRE.lon },
};
const SUPER = { id: "11111111-1111-4111-8111-111111111111", role: "SUPER_ADMIN", campusId: null, campus: null, disabledAt: null };

describe("DTARO zone alerts disabled (default): previous behaviour over real local sockets", () => {
  const previousSwitch = process.env[dtaroZoneAlert.ENV_SWITCH];
  let httpServer;
  let io;
  let port;
  let kv;
  const robots = new Map();
  const received = new Map();
  let dashboardSeen;
  let dashboard;

  beforeAll(async () => {
    delete process.env[dtaroZoneAlert.ENV_SWITCH];
    getPrisma.mockReturnValue(
      createPermissivePrisma((model, method, args) => {
        if (model === "robot" && (method === "findUnique" || method === "findFirst")) {
          const robotId = args?.where?.robotId ?? args?.where?.OR?.[0]?.robotId;
          const at = FLEET[robotId];
          return at ? { id: `db-${robotId}`, robotId, status: "IDLE", isOnline: false, lat: at.lat, lon: at.lon, battery: 90, simulated: true } : null;
        }
        if (model === "user" && method === "findUnique") return args?.where?.id === SUPER.id ? SUPER : null;
        return undefined;
      }),
    );
    ({ kv } = await createTestKv());
    httpServer = http.createServer();
    io = new Server(httpServer);
    initSocketServer(io, { prisma: getPrisma(), kv, logger: silentLogger, appLocals: { config: { spatial: SPATIAL } } });
    await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    port = httpServer.address().port;

    dashboard = ioClient(`http://127.0.0.1:${port}`, {
      transports: ["websocket"],
      reconnection: false,
      forceNew: true,
      extraHeaders: { "user-agent": "Mozilla/5.0 (test dashboard)", cookie: `token=${jwt.sign({ id: SUPER.id }, process.env.JWT_SECRET)}` },
    });
    dashboardSeen = [];
    dashboard.onAny((event, payload) => dashboardSeen.push({ event, payload }));
    await new Promise((resolve, reject) => { dashboard.once("connect", resolve); dashboard.once("connect_error", reject); });
    await waitFor(async () => (await io.in(dashboardBroadcast.ROOM).fetchSockets()).length > 0, { timeout: 3000 });

    for (const [robotId, at] of Object.entries(FLEET)) {
      await kv.set(`session:${robotId}`, `t-${robotId}`, { ex: 3600 });
      const vr = new VirtualRobot({ robotId, lat: at.lat, lon: at.lon, logger: silentLogger, kv, simulated: true, obstacleProbability: 0 });
      vr.sessionToken = `t-${robotId}`;
      vr.connect(`http://127.0.0.1:${port}`);
      await waitFor(() => vr._sessionEstablished(), { timeout: 5000 });
      const seen = [];
      vr.socket.onAny((event, payload) => seen.push({ event, payload }));
      received.set(robotId, seen);
      robots.set(robotId, vr);
      vr._emitTelemetry(Date.now());
    }
    await waitFor(async () => (await io.fetchSockets()).filter((s) => s.data.telemetryReceipt >= 1).length === 2, { timeout: 5000 });
  }, 30_000);

  afterAll(async () => {
    for (const vr of robots.values()) vr.stop();
    dashboard.close();
    io.close();
    await new Promise((resolve) => httpServer.close(resolve));
    if (previousSwitch === undefined) delete process.env[dtaroZoneAlert.ENV_SWITCH];
    else process.env[dtaroZoneAlert.ENV_SWITCH] = previousSwitch;
  });

  test("the switch reads as off", () => {
    expect(dtaroZoneAlert.isEnabled()).toBe(false);
  });

  test("no socket joins a dtaro zone room at AUTH or on telemetry", async () => {
    for (const s of await io.fetchSockets()) {
      expect([...s.rooms].filter((room) => room.startsWith("dtaro:"))).toEqual([]);
      expect(s.data.dtaroZone).toBeUndefined();
    }
  });

  test("OBSTACLE_REPORT takes the legacy path: legacy ACK fields only, no OBSTACLE_ALERT, legacy ALERT_CREATED", async () => {
    const reporter = robots.get("SIM-OFF-A");
    const ack = new Promise((resolve) => reporter.socket.once("OBSTACLE_REPORT_ACK", resolve));
    reporter.socket.emit("OBSTACLE_REPORT", { lat: CENTRE.lat, lon: CENTRE.lon, severity: "HIGH" });
    const payload = await ack;
    expect(Object.keys(payload).sort()).toEqual(["affectedRobots", "obstacleId", "timestamp"]);
    expect(payload.affectedRobots).toBe(0);

    await waitFor(() => dashboardSeen.some((m) => m.event === "ALERT_CREATED"), { timeout: 3000 });
    const created = dashboardSeen.find((m) => m.event === "ALERT_CREATED").payload;
    expect(Object.keys(created).sort()).toEqual(
      ["expiresAt", "lat", "lon", "obstacleId", "reportingRobotId", "severity", "timestamp", "zoneId", "zoneName"].sort(),
    );

    await new Promise((resolve) => setTimeout(resolve, 200));
    for (const seen of received.values()) expect(seen.some((m) => m.event === "OBSTACLE_ALERT")).toBe(false);
    expect(dashboardSeen.some((m) => m.event === "OBSTACLE_REPORT_REJECTED")).toBe(false);
  });

  test("a point the zone path would refuse (no published cell) is accepted by the legacy path, as before", async () => {
    const reporter = robots.get("SIM-OFF-A");
    await new Promise((resolve) => setTimeout(resolve, 550)); // the handler's minimum report interval
    const ack = new Promise((resolve) => reporter.socket.once("OBSTACLE_REPORT_ACK", resolve));
    reporter.socket.emit("OBSTACLE_REPORT", { lat: 12.95, lon: 77.6, severity: "LOW" });
    expect(Object.keys(await ack).sort()).toEqual(["affectedRobots", "obstacleId", "timestamp"]);
  });

  test("OBSTACLE_RELEVANCE is ignored: no answer to the robot, nothing on the dashboard", async () => {
    const robot = robots.get("SIM-OFF-B");
    const before = received.get("SIM-OFF-B").length;
    robot.socket.emit("OBSTACLE_RELEVANCE", { obstacleId: "OBS-x", relevant: true, routeSource: "NONE", decision: "X" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(received.get("SIM-OFF-B").slice(before).filter((m) => m.event === "ERROR")).toEqual([]);
    expect(dashboardSeen.some((m) => m.event === "OBSTACLE_RELEVANCE")).toBe(false);
  });
});
