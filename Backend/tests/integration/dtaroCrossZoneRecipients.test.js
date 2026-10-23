"use strict";

/**
 * DTARO cross-zone obstacle recipients over REAL local sockets (owner policy 2026-10-23).
 *
 * A real HTTP + Socket.IO server composed by the shipped `initSocketServer`, and real
 * `VirtualRobot` clients over websockets. The server alerts the obstacle's zone room AND every
 * same-region robot whose remaining COMMANDED route — read by the server from the live
 * commitment's OFFER Outbox row and cut at the robot's server-held position — meets the
 * obstacle's footprint.
 *
 * What is NOT real, and why:
 *   * Prisma is an in-memory stand-in. It answers the robot rows AUTH reads and the three
 *     route reads (Agent, live Commitment, OFFER Outbox) from fixed rows shaped like the real
 *     ones; every other call is a no-op. The engine is off, so the OFFER rows are fixtures.
 *   * The spatial authority is a SYNTHETIC published map: region rA split into zones zW and zE
 *     by cell-centre longitude, and a region rB 1.5 km west. It is not RNSIT and not G4, and
 *     nothing is published anywhere: it is passed as `appLocals.config.spatial`.
 *   * Each robot's own route (for its own relevance verdict) arrives by the legacy TASK_ASSIGN.
 *     For every robot but X-ROBOT it equals the OFFER corridor; X-ROBOT's deliberately differs,
 *     to show the server trusts only the OFFER.
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

jest.setTimeout(60_000);

// ── Synthetic spatial authority ──────────────────────────────────────────────

const RES = 11;
const MID = { lat: 12.9023, lon: 77.5186 };
const P_B = { lat: 12.9027, lon: 77.505 };
const at = (base, dLat, dLon) => ({ lat: base.lat + dLat, lon: base.lon + dLon });
const centreOf = (point) => {
  const [lat, lon] = h3.cellToLatLng(h3.latLngToCell(point.lat, point.lon, RES));
  return { lat, lon };
};

function buildMap() {
  const cells = [];
  for (const cellId of h3.gridDisk(h3.latLngToCell(MID.lat, MID.lon, RES), 14)) {
    const [, lon] = h3.cellToLatLng(cellId);
    cells.push({ cellId, resolution: "FINE", regionId: "rA", zoneId: lon < MID.lon ? "zW" : "zE", siteId: null });
  }
  for (const cellId of h3.gridDisk(h3.latLngToCell(P_B.lat, P_B.lon, RES), 6)) {
    cells.push({ cellId, resolution: "FINE", regionId: "rB", zoneId: "zB", siteId: null });
  }
  return {
    regions: [{ id: "rA" }, { id: "rB" }],
    zones: [{ id: "zW", regionId: "rA" }, { id: "zE", regionId: "rA" }, { id: "zB", regionId: "rB" }],
    sites: [],
    cells,
  };
}

const SPATIAL = buildMap();
const O = centreOf(at(MID, 0, 0.0012)); // the obstacle, in zE
const O2 = centreOf(at(O, 0, 0.0005)); // a second obstacle cell, also in zE, on X-CROSS's route

// ── Fleet: position, zone, OFFER corridor (authoritative), robot's own route ──

const FLEET = {
  REPORTER: { position: at(O, 0.00004, 0), zone: "zE" },
  "SAME-CROSS": { position: at(O, 0, 0.0008), zone: "zE", offer: [at(O, 0, 0.0008), O, at(O, 0, -0.0004)] },
  "SAME-IDLE": { position: at(O, 0.0009, 0.0002), zone: "zE" },
  "X-CROSS": { position: at(MID, 0, -0.0012), zone: "zW", offer: [at(MID, 0, -0.0012), O, at(O2, 0, 0.0004)] },
  "X-CLEAR": { position: at(MID, 0.0015, -0.0012), zone: "zW", offer: [at(MID, 0.0015, -0.0012), at(MID, 0.0015, 0.0016)] },
  "X-IDLE": { position: at(MID, -0.001, -0.001), zone: "zW" },
  // Drove from zE west through O, now 33+ m past the last corner and still heading west.
  "X-PASSED": { position: at(MID, 0, -0.0006), zone: "zW", offer: [at(O, 0, 0.0006), O, at(MID, 0, -0.0003), at(MID, 0, -0.0012)], ownRoute: [at(MID, 0, -0.0006), at(MID, 0, -0.0012)] },
  // The server's corridor is clear of O; the robot's OWN route (TASK_ASSIGN) runs through O.
  "X-ROBOT": { position: at(MID, -0.0015, -0.0012), zone: "zW", offer: [at(MID, -0.0015, -0.0012), at(MID, -0.0015, -0.0020)], ownRoute: [at(MID, -0.0015, -0.0012), O] },
  // A live commitment whose OFFER carries no path.
  "X-NOGEOM": { position: at(MID, 0.0008, -0.0014), zone: "zW", offer: "NO_GEOMETRY" },
  // Region B; its (synthetic) corridor is drawn straight through O.
  "B-ROUTE": { position: at(P_B, 0.0002, 0), zone: "zB", offer: [at(P_B, 0.0002, 0), O, at(O, 0, 0.0006)] },
};

let failRouteReads = false;
const routeReads = [];

function offerRows() {
  const agents = [];
  const commitments = [];
  const outbox = [];
  for (const [robotId, spec] of Object.entries(FLEET)) {
    agents.push({ id: `ag-${robotId}`, agentId: robotId });
    if (!spec.offer) continue;
    commitments.push({ commitmentId: `cm-${robotId}`, agentId: `ag-${robotId}`, grantedAt: new Date("2026-10-23T09:00:00Z"), leaseExpiry: new Date(Date.now() + 3_600_000) });
    const stopSequence = spec.offer === "NO_GEOMETRY" ? [{ stopId: "s1", sequence: 1 }] : [{ stopId: "s1", sequence: 1, path: spec.offer }];
    outbox.push({ commitmentId: `cm-${robotId}`, command: "OFFER", createdAt: new Date("2026-10-23T09:00:01Z"), payload: { stopSequence } });
  }
  return { agents, commitments, outbox };
}

const SUPER = { id: "11111111-1111-4111-8111-111111111111", email: "root@x", role: "SUPER_ADMIN", campusId: null, campus: null, disabledAt: null };

function createPrismaStandIn() {
  const rows = offerRows();
  const inList = (value, filter) => !filter || !filter.in || filter.in.includes(value);
  return createPermissivePrisma((model, method, args) => {
    const where = (args && args.where) || {};
    if (model === "robot" && (method === "findUnique" || method === "findFirst")) {
      const robotId = where.robotId ?? where.OR?.[0]?.robotId;
      const spec = FLEET[robotId];
      return spec ? { id: `db-${robotId}`, robotId, status: "IDLE", isOnline: false, lat: spec.position.lat, lon: spec.position.lon, battery: 90, simulated: true, agent: null } : null;
    }
    if (model === "user" && method === "findUnique") return where.id === SUPER.id ? SUPER : null;
    if (["agent", "commitment", "outbox"].includes(model) && method === "findMany") {
      routeReads.push({ model, ids: (where.agentId || where.commitmentId || {}).in || null });
      if (failRouteReads) throw new Error("simulated database outage");
      if (model === "agent") return rows.agents.filter((a) => inList(a.agentId, where.agentId));
      if (model === "commitment") return rows.commitments.filter((c) => inList(c.agentId, where.agentId));
      if (model === "outbox") return rows.outbox.filter((o) => inList(o.commitmentId, where.commitmentId) && o.command === where.command);
    }
    return undefined;
  });
}

// ── Harness ──────────────────────────────────────────────────────────────────

async function startServer(enabled) {
  if (enabled) process.env[dtaroZoneAlert.ENV_SWITCH] = "true";
  else delete process.env[dtaroZoneAlert.ENV_SWITCH];
  getPrisma.mockReturnValue(createPrismaStandIn());
  const { kv } = await createTestKv();
  const httpServer = http.createServer();
  const io = new Server(httpServer, { cors: { origin: true, credentials: true } });
  initSocketServer(io, { prisma: getPrisma(), kv, logger: silentLogger, appLocals: { config: { version: "synthetic-crosszone-1", spatial: SPATIAL } } });
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  return { kv, httpServer, io, port: httpServer.address().port, robots: new Map(), clients: [] };
}

async function stopServer(s) {
  for (const vr of s.robots.values()) vr.stop();
  for (const c of s.clients) { try { c.close(); } catch { /* ignore */ } }
  s.io.close();
  await new Promise((resolve) => s.httpServer.close(resolve));
}

async function startRobot(s, robotId) {
  const spec = FLEET[robotId];
  const token = `session-${robotId}`;
  await s.kv.set(`session:${robotId}`, token, { ex: 3600 });
  const vr = new VirtualRobot({
    robotId,
    lat: spec.position.lat,
    lon: spec.position.lon,
    logger: silentLogger,
    kv: s.kv,
    simulated: true,
    obstacleProbability: 0,
    worldObstacles: [
      { id: "OB-1", lat: O.lat, lon: O.lon, severity: "HIGH", senseRadiusM: 15 },
      { id: "OB-2", lat: O2.lat, lon: O2.lon, severity: "HIGH", senseRadiusM: 15 },
    ],
  });
  vr.sessionToken = token;
  vr.connect(`http://127.0.0.1:${s.port}`);
  await waitFor(() => vr._sessionEstablished(), { timeout: 5000 });
  vr._emitTelemetry(Date.now());
  await waitFor(async () => {
    const socket = (await s.io.fetchSockets()).find((x) => x.data.robotId === robotId);
    return socket && socket.data.telemetryReceipt >= 1;
  }, { timeout: 5000 });
  s.robots.set(robotId, vr);
  return vr;
}

async function connectDashboard(s) {
  const token = jwt.sign({ id: SUPER.id }, process.env.JWT_SECRET);
  const client = ioClient(`http://127.0.0.1:${s.port}`, {
    transports: ["websocket"],
    reconnection: false,
    forceNew: true,
    extraHeaders: { "user-agent": "Mozilla/5.0 (test dashboard)", cookie: `token=${token}` },
  });
  s.clients.push(client);
  const seen = [];
  client.onAny((event, payload) => seen.push({ event, payload }));
  await new Promise((resolve, reject) => { client.once("connect", resolve); client.once("connect_error", reject); });
  await waitFor(async () => (await s.io.in(dashboardBroadcast.ROOM).fetchSockets()).length > 0, { timeout: 3000 });
  return seen;
}

/** Give a robot its own commanded route, as the engine's OFFER would (legacy dispatch). */
async function assignOwnRoute(s, robotId) {
  const spec = FLEET[robotId];
  const path = spec.ownRoute || spec.offer;
  if (!Array.isArray(path)) return;
  const pickup = path[path.length - 1];
  const drop = at(pickup, 0.0003, 0);
  await dispatchTaskAssign(s.io, robotId, { taskId: `TSK-${robotId}`, pickup, drop, pathToPickup: path, pathToDrop: [pickup, drop] });
  await waitFor(() => s.robots.get(robotId).task, { timeout: 5000 });
}

const alertsOf = (s, robotId) => s.robots.get(robotId).obstacleAwareness().alerts;
const decisionOf = (created, robotId) => created.payload.recipientDecisions.find((d) => d.robotId === robotId);

// ── Flag on ──────────────────────────────────────────────────────────────────

describe("cross-zone obstacle recipients — flag on, real sockets", () => {
  const previous = process.env[dtaroZoneAlert.ENV_SWITCH];
  let s;
  let dashboard;
  let created;

  beforeAll(async () => {
    process.env.VERIFY_CORRIDOR_HALF_WIDTH_M = "30";
    s = await startServer(true);
    dashboard = await connectDashboard(s);
    for (const robotId of Object.keys(FLEET)) await startRobot(s, robotId);
    for (const robotId of Object.keys(FLEET)) await assignOwnRoute(s, robotId);

    s.robots.get("REPORTER")._senseWorldObstacles();
    await waitFor(() => dashboard.some((m) => m.event === "ALERT_CREATED"), { timeout: 5000 });
    created = dashboard.find((m) => m.event === "ALERT_CREATED");
    // Wait for every recipient's verdict to reach the dashboard.
    await waitFor(() => dashboard.filter((m) => m.event === "OBSTACLE_RELEVANCE").length >= created.payload.recipients.length, { timeout: 5000 });
  });

  afterAll(async () => {
    await stopServer(s);
    if (previous === undefined) delete process.env[dtaroZoneAlert.ENV_SWITCH];
    else process.env[dtaroZoneAlert.ENV_SWITCH] = previous;
  });

  test("fixture: every robot's server-side zone is the one intended, and the regions share no cell", async () => {
    for (const [robotId, spec] of Object.entries(FLEET)) {
      const socket = (await s.io.fetchSockets()).find((x) => x.data.robotId === robotId);
      expect([robotId, socket.data.dtaroZone.zoneId]).toEqual([robotId, spec.zone]);
    }
    const rA = new Set(SPATIAL.cells.filter((c) => c.regionId === "rA").map((c) => c.cellId));
    expect(SPATIAL.cells.filter((c) => c.regionId === "rB").some((c) => rA.has(c.cellId))).toBe(false);
  });

  test("same-zone robot with an intersecting route is alerted (zone room), and says the obstacle is on its route", () => {
    expect(created.payload.sameZoneRecipients).toEqual(["SAME-CROSS", "SAME-IDLE"]);
    expect(decisionOf(created, "SAME-CROSS")).toMatchObject({ relation: "SAME_ZONE", selected: true, alerted: true, reason: "SAME_ZONE", routeIntersects: true });
    expect(alertsOf(s, "SAME-CROSS")).toEqual([expect.objectContaining({ relevant: true, decision: "RELEVANT_NO_REPLAN" })]);
  });

  test("cross-zone robot whose remaining commanded route meets the obstacle is alerted through its robot room", () => {
    // X-NOGEOM is alerted too, conservatively (ROUTE_UNKNOWN): see the no-geometry test below.
    expect(created.payload.crossZoneRecipients).toEqual(["X-CROSS", "X-NOGEOM"]);
    expect(decisionOf(created, "X-CROSS")).toMatchObject({
      zoneId: "zW",
      relation: "OTHER_ZONE",
      routeIntersects: true,
      selected: true,
      alerted: true,
      reason: "ROUTE_CROSSES_OBSTACLE",
      route: { source: "OFFER", status: "OK", commitmentId: "cm-X-CROSS", cut: "AT_POSITION" },
    });
    expect(alertsOf(s, "X-CROSS")).toEqual([expect.objectContaining({ obstacleId: created.payload.obstacleId, relevant: true, routeSource: "COMMANDED_ROUTE", decision: "RELEVANT_NO_REPLAN" })]);
  });

  test("ALERT_CREATED keeps delivery ZONE_ROOM and lists every alerted robot; the ACK names the same recipients", () => {
    expect(created.payload).toMatchObject({
      reportingRobotId: "REPORTER",
      regionId: "rA",
      zoneId: "zE",
      delivery: "ZONE_ROOM",
      recipientPolicy: "ZONE_PLUS_REMAINING_ROUTE",
      recipients: ["SAME-CROSS", "SAME-IDLE", "X-CROSS", "X-NOGEOM"],
    });
    expect(created.payload.crossZoneError).toBeUndefined();
    const reported = s.robots.get("REPORTER").obstacleAwareness().reported.find((r) => r.worldId === "OB-1");
    expect(reported).toMatchObject({ outcome: "ACCEPTED", obstacleId: created.payload.obstacleId });
  });

  test("the activity log a reconnecting dashboard replays holds exactly what the dashboard received", () => {
    const logged = dtaroZoneAlert.recentActivity().filter((e) => e.event === "ALERT_CREATED" && e.payload.obstacleId === created.payload.obstacleId);
    expect(logged).toHaveLength(1);
    expect(JSON.parse(JSON.stringify(logged[0].payload))).toEqual(created.payload);
    const verdicts = dtaroZoneAlert.recentActivity().filter((e) => e.event === "OBSTACLE_RELEVANCE" && e.payload.obstacleId === created.payload.obstacleId);
    expect(verdicts.map((e) => e.payload.robotId).sort()).toEqual(["SAME-CROSS", "SAME-IDLE", "X-CROSS", "X-NOGEOM"]);
  });

  test("the dashboard receives each recipient's verdict, the cross-zone one included", () => {
    const verdicts = dashboard.filter((m) => m.event === "OBSTACLE_RELEVANCE" && m.payload.obstacleId === created.payload.obstacleId).map((m) => m.payload);
    expect(verdicts.map((v) => [v.robotId, v.relevant, v.decision]).sort()).toEqual([
      ["SAME-CROSS", true, "RELEVANT_NO_REPLAN"],
      ["SAME-IDLE", false, "NO_PLANNED_ROUTE"],
      ["X-CROSS", true, "RELEVANT_NO_REPLAN"],
      ["X-NOGEOM", false, "NO_PLANNED_ROUTE"],
    ]);
  });

  test("cross-zone robot with an unrelated route is not alerted", () => {
    expect(decisionOf(created, "X-CLEAR")).toMatchObject({ relation: "OTHER_ZONE", routeIntersects: false, selected: false, alerted: false, reason: "ROUTE_CLEAR", route: { status: "OK" } });
    expect(alertsOf(s, "X-CLEAR")).toEqual([]);
  });

  test("an idle robot (no live commitment) is not treated as route-affected", () => {
    expect(decisionOf(created, "X-IDLE")).toMatchObject({ selected: false, alerted: false, reason: "NO_REMAINING_ROUTE", route: { status: "NO_LIVE_COMMITMENT", remainingPoints: 0 } });
    expect(alertsOf(s, "X-IDLE")).toEqual([]);
  });

  test("the route is evaluated from the robot's current position, not its completed segments", () => {
    // X-PASSED's corridor runs through O, but the robot is already past it.
    const d = decisionOf(created, "X-PASSED");
    expect(d).toMatchObject({ selected: false, reason: "ROUTE_CLEAR", routeIntersects: false, route: { status: "OK", cut: "AT_POSITION", corridorPoints: 4 } });
    expect(d.route.remainingPoints).toBeLessThan(4 + 1);
    expect(alertsOf(s, "X-PASSED")).toEqual([]);
  });

  test("only the server's commanded route counts: a robot's own route through the obstacle does not select it", () => {
    expect(decisionOf(created, "X-ROBOT")).toMatchObject({ selected: false, reason: "ROUTE_CLEAR", route: { status: "OK", commitmentId: "cm-X-ROBOT" } });
    expect(alertsOf(s, "X-ROBOT")).toEqual([]);
  });

  test("a live commitment with no route geometry is an UNKNOWN route: alerted conservatively, never assumed clear", () => {
    expect(decisionOf(created, "X-NOGEOM")).toMatchObject({ selected: true, alerted: true, reason: "ROUTE_UNKNOWN", routeIntersects: null, route: { status: "NO_ROUTE_GEOMETRY" } });
    expect(alertsOf(s, "X-NOGEOM")).toEqual([expect.objectContaining({ obstacleId: created.payload.obstacleId })]);
  });

  test("a robot in another region is never alerted, and its route is never read", () => {
    expect(decisionOf(created, "B-ROUTE")).toEqual(expect.objectContaining({ relation: "OTHER_REGION", selected: false, alerted: false, reason: "OTHER_REGION", route: null }));
    expect(alertsOf(s, "B-ROUTE")).toEqual([]);
    const agentRead = routeReads.find((r) => r.model === "agent");
    expect(agentRead.ids).not.toContain("B-ROUTE");
    expect(agentRead.ids).not.toContain("REPORTER");
  });

  test("the reporter is excluded and recorded as such", () => {
    expect(decisionOf(created, "REPORTER")).toMatchObject({ relation: "REPORTER", selected: false, reason: "REPORTER" });
    expect(alertsOf(s, "REPORTER")).toEqual([]);
  });

  test("a duplicate report of the same cell is merged: no second delivery to anyone, cross-zone included", async () => {
    const before = Object.fromEntries([...s.robots].map(([id]) => [id, alertsOf(s, id).length]));
    const createdBefore = dashboard.filter((m) => m.event === "ALERT_CREATED").length;
    const vr = s.robots.get("SAME-IDLE");
    const ack = new Promise((resolve) => vr.socket.once("OBSTACLE_REPORT_ACK", resolve));
    vr.socket.emit("OBSTACLE_REPORT", { lat: O.lat + 0.00001, lon: O.lon, severity: "LOW" });
    expect(await ack).toMatchObject({ delivery: "MERGED", duplicateOf: created.payload.obstacleId, recipients: [] });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(dashboard.filter((m) => m.event === "ALERT_CREATED").length).toBe(createdBefore);
    for (const [id] of s.robots) expect(alertsOf(s, id).length).toBe(before[id]);
  });

  test("route state unavailable: same-zone delivery still happens; same-region robots are alerted conservatively as ROUTE_UNKNOWN", async () => {
    failRouteReads = true;
    try {
      const createdBefore = dashboard.filter((m) => m.event === "ALERT_CREATED").length;
      const vr = s.robots.get("SAME-CROSS");
      await new Promise((resolve) => setTimeout(resolve, 550)); // the handler's minimum report interval
      vr.socket.emit("OBSTACLE_REPORT", { lat: O2.lat, lon: O2.lon, severity: "HIGH" });
      await waitFor(() => dashboard.filter((m) => m.event === "ALERT_CREATED").length > createdBefore, { timeout: 5000 });
      const second = dashboard.filter((m) => m.event === "ALERT_CREATED")[createdBefore];
      // Every same-region robot in another zone has an unreadable route: none is assumed clear.
      // Region B is still never considered (its route is not even read).
      const otherZone = ["X-CLEAR", "X-CROSS", "X-IDLE", "X-NOGEOM", "X-PASSED", "X-ROBOT"];
      expect(second.payload).toMatchObject({ zoneId: "zE", sameZoneRecipients: ["REPORTER", "SAME-IDLE"], crossZoneRecipients: otherZone });
      for (const robotId of otherZone) {
        expect(decisionOf(second, robotId)).toMatchObject({ selected: true, alerted: true, reason: "ROUTE_UNKNOWN", route: { status: "LOOKUP_FAILED" } });
      }
      expect(decisionOf(second, "B-ROUTE")).toMatchObject({ reason: "OTHER_REGION", alerted: false });
      await waitFor(() => alertsOf(s, "SAME-IDLE").some((a) => a.obstacleId === second.payload.obstacleId), { timeout: 5000 });
      await waitFor(() => alertsOf(s, "X-CROSS").some((a) => a.obstacleId === second.payload.obstacleId), { timeout: 5000 });
      expect(alertsOf(s, "B-ROUTE").some((a) => a.obstacleId === second.payload.obstacleId)).toBe(false);
    } finally {
      failRouteReads = false;
    }
  });

  test("relevance answers are accepted from a cross-zone recipient once, and refused from a robot that was not alerted", async () => {
    const outsider = s.robots.get("X-CLEAR");
    const refused = new Promise((resolve) => outsider.socket.once("ERROR", resolve));
    outsider.socket.emit("OBSTACLE_RELEVANCE", { obstacleId: created.payload.obstacleId, relevant: true, routeSource: "NONE", decision: "FORGED" });
    expect(await refused).toMatchObject({ reason: "NOT_A_RECIPIENT" });
    const recipient = s.robots.get("X-CROSS");
    const duplicate = new Promise((resolve) => recipient.socket.once("ERROR", resolve));
    recipient.socket.emit("OBSTACLE_RELEVANCE", { obstacleId: created.payload.obstacleId, relevant: false, routeSource: "NONE", decision: "CHANGED_MIND" });
    expect(await duplicate).toMatchObject({ reason: "DUPLICATE" });
  });

  test("reconnect: a cross-zone robot's new socket is reached through its robot room", async () => {
    const vr = s.robots.get("X-CROSS");
    vr.socket.disconnect();
    await waitFor(async () => !(await s.io.fetchSockets()).some((x) => x.data.robotId === "X-CROSS"), { timeout: 3000 });
    vr.socket.connect();
    await waitFor(async () => {
      const socket = (await s.io.fetchSockets()).find((x) => x.data.robotId === "X-CROSS");
      return socket && socket.data.dtaroZone && socket.data.dtaroZone.zoneId === "zW";
    }, { timeout: 5000 });
    // A fresh obstacle on its route, reported from zE.
    const third = centreOf(at(O, 0, -0.0005));
    const createdBefore = dashboard.filter((m) => m.event === "ALERT_CREATED").length;
    await new Promise((resolve) => setTimeout(resolve, 550));
    s.robots.get("SAME-CROSS").socket.emit("OBSTACLE_REPORT", { lat: third.lat, lon: third.lon, severity: "HIGH" });
    await waitFor(() => dashboard.filter((m) => m.event === "ALERT_CREATED").length > createdBefore, { timeout: 5000 });
    const latest = dashboard.filter((m) => m.event === "ALERT_CREATED")[createdBefore];
    expect(latest.payload.crossZoneRecipients).toContain("X-CROSS");
    await waitFor(() => alertsOf(s, "X-CROSS").some((a) => a.obstacleId === latest.payload.obstacleId), { timeout: 5000 });
  });
});

// ── Flag off ─────────────────────────────────────────────────────────────────

describe("cross-zone obstacle recipients — flag off preserves the legacy path", () => {
  const previous = process.env[dtaroZoneAlert.ENV_SWITCH];
  let s;
  let dashboard;

  beforeAll(async () => {
    routeReads.length = 0;
    s = await startServer(false);
    dashboard = await connectDashboard(s);
    for (const robotId of ["REPORTER", "X-CROSS", "SAME-CROSS"]) await startRobot(s, robotId);
    for (const robotId of ["X-CROSS", "SAME-CROSS"]) await assignOwnRoute(s, robotId);
  });

  afterAll(async () => {
    await stopServer(s);
    if (previous === undefined) delete process.env[dtaroZoneAlert.ENV_SWITCH];
    else process.env[dtaroZoneAlert.ENV_SWITCH] = previous;
  });

  test("no zone rooms, no route reads, no OBSTACLE_ALERT, and the legacy ACK shape", async () => {
    const vr = s.robots.get("REPORTER");
    const ack = new Promise((resolve) => vr.socket.once("OBSTACLE_REPORT_ACK", resolve));
    vr.socket.emit("OBSTACLE_REPORT", { lat: O.lat, lon: O.lon, severity: "HIGH" });
    const payload = await ack;
    expect(Object.keys(payload).sort()).toEqual(["affectedRobots", "obstacleId", "timestamp"]);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(routeReads).toEqual([]);
    for (const id of ["X-CROSS", "SAME-CROSS"]) expect(alertsOf(s, id)).toEqual([]);
    expect((await s.io.fetchSockets()).every((x) => !x.data.dtaroZone)).toBe(true);
    expect(dashboard.some((m) => m.event === "ALERT_CREATED" && m.payload.recipientPolicy)).toBe(false);
  });
});
