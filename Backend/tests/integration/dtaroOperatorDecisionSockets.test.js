"use strict";

/**
 * DTARO operator decisions over REAL local sockets: report → decision panel → STOP / REROUTE /
 * REJECT_BROADCAST / the server's 5 s default → selective propagation → simulated execution.
 *
 * A real HTTP + Socket.IO server composed by the shipped `initSocketServer`, a real SUPER_ADMIN
 * dashboard socket, and real `VirtualRobot` clients over websockets. Every assertion about who
 * received what is made on the RECEIVING socket (each robot's own client records every event it
 * is sent), not on a helper's return value.
 *
 * What is NOT real, and why:
 *   * Prisma is an in-memory stand-in (`createPermissivePrisma`). It answers the reads the
 *     decision step makes from fixed rows shaped like the real ones (Agent with its permission
 *     set, live Commitment, OFFER Outbox, Task, Robot) and keeps the DtaroObstacleDecision rows
 *     in memory with the real status guard; every write is recorded, so the absence of engine
 *     writes is asserted, not assumed.
 *   * The map and the walkway network are SYNTHETIC (`tests/helpers/dtaroDecisionWorld.js`).
 *     The detour planner is the real one (`simulation/dtaroDetour`) over a real
 *     `campusTraversalNetwork` built from synthetic ways, injected through the service's test seam
 *     because the synthetic map has no campus extract.
 *   * Robots tick only when the test ticks them (no timer), so positions are deterministic.
 */

jest.mock("../../src/db/prisma");

const http = require("http");
const jwt = require("jsonwebtoken");
const { Server } = require("socket.io");
const { io: ioClient } = require("socket.io-client");

const { getPrisma } = require("../../src/db/prisma");
const initSocketServer = require("../../src/sockets/socket.server");
const dashboardBroadcast = require("../../src/sockets/dashboardBroadcast");
const { dispatchTaskAssign } = require("../../src/services/commandDispatcher.service");
const dtaroZoneAlert = require("../../src/services/dtaroZoneAlert.service");
const obstacleDecision = require("../../src/services/dtaroObstacleDecision.service");
const dtaroDetour = require("../../src/simulation/dtaroDetour");
const VirtualRobot = require("../../src/simulation/VirtualRobot");
const { pathIntersectsPolygon, pointInPolygon } = require("../../src/services/routeIntersection.service");
const { createTestKv } = require("../helpers/testKv");
const { createPermissivePrisma } = require("../helpers/permissivePrisma");
const { waitFor } = require("../helpers/waitFor");
const silentLogger = require("../mocks/silentLogger");
const world = require("../helpers/dtaroDecisionWorld");

jest.setTimeout(90_000);

const SPATIAL = world.buildMap();
const NETWORK = world.buildNetwork();
const SUPER = { id: "11111111-1111-4111-8111-111111111111", email: "root@x", role: "SUPER_ADMIN", campusId: null, campus: null, disabledAt: null };
const ENGINE_MODELS = new Set(["outbox", "commitment", "leg", "task", "mission", "command", "agent"]);
const ROBOT_IDS = Object.keys(world.FLEET);
const ALL_BUT_REPORTER = ROBOT_IDS.filter((id) => id !== "REP");

// ── Prisma stand-in ──────────────────────────────────────────────────────────

function createPrismaStandIn(state) {
  const rows = world.offerRows();
  const tasks = world.taskRows();
  const inList = (value, filter) => !filter || !filter.in || filter.in.includes(value);
  return createPermissivePrisma((model, method, args) => {
    const where = (args && args.where) || {};
    if (/^(create|update|upsert|delete)/.test(method)) state.writes.push({ model, method, args: JSON.parse(JSON.stringify(args || {})) });
    if (model === "robot" && (method === "findUnique" || method === "findFirst")) {
      const robotId = where.robotId ?? where.OR?.[0]?.robotId;
      if (!world.FLEET[robotId]) return null;
      const p = world.positionOf(robotId);
      return { id: `db-${robotId}`, robotId, name: `Robot ${robotId}`, status: "IDLE", isOnline: false, lat: p.lat, lon: p.lon, battery: 90, simulated: true, agent: null };
    }
    if (model === "robot" && method === "findMany") return ROBOT_IDS.filter((id) => inList(id, where.robotId)).map((robotId) => ({ robotId, name: `Robot ${robotId}` }));
    if (model === "user" && method === "findUnique") return where.id === SUPER.id ? SUPER : null;
    if (model === "agent" && method === "findMany") return rows.agents.filter((a) => inList(a.agentId, where.agentId));
    if (model === "commitment" && method === "findMany") return rows.commitments.filter((c) => inList(c.agentId, where.agentId));
    if (model === "outbox" && method === "findMany") return rows.outbox.filter((o) => inList(o.commitmentId, where.commitmentId) && o.command === where.command);
    if (model === "task" && method === "findMany") return tasks.filter((t) => inList(t.taskId, where.taskId));
    if (model === "dtaroObstacleDecision") {
      if (method === "create") {
        const row = { ...args.data };
        state.decisionRows.set(row.decisionId, row);
        return row;
      }
      if (method === "updateMany") {
        const row = state.decisionRows.get(where.decisionId);
        if (!row || (typeof where.status === "string" && row.status !== where.status)) return { count: 0 };
        for (const [key, value] of Object.entries(args.data)) if (value !== undefined) row[key] = value;
        return { count: 1 };
      }
      if (method === "findMany") return [...state.decisionRows.values()];
    }
    return undefined;
  });
}

// ── Harness ──────────────────────────────────────────────────────────────────

async function startServer({ decisions }) {
  process.env[dtaroZoneAlert.ENV_SWITCH] = "true";
  if (decisions) process.env[obstacleDecision.ENV_SWITCH] = "true";
  else delete process.env[obstacleDecision.ENV_SWITCH];
  process.env.VERIFY_CORRIDOR_HALF_WIDTH_M = "30";
  dtaroZoneAlert.resetForTests();
  obstacleDecision.resetForTests();
  obstacleDecision.setPlannerFactoryForTests(() => dtaroDetour.createDetourPlanner({ networkFor: () => ({ ok: true, network: NETWORK }) }));
  const state = { writes: [], decisionRows: new Map() };
  getPrisma.mockReturnValue(createPrismaStandIn(state));
  const { kv } = await createTestKv();
  const httpServer = http.createServer();
  const io = new Server(httpServer, { cors: { origin: true, credentials: true } });
  initSocketServer(io, { prisma: getPrisma(), kv, logger: silentLogger, appLocals: { config: { version: "synthetic-decisions-1", spatial: SPATIAL } } });
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  return { kv, httpServer, io, port: httpServer.address().port, robots: new Map(), received: new Map(), clients: [], state };
}

async function stopServer(s) {
  if (!s) return;
  for (const vr of s.robots.values()) vr.stop();
  for (const c of s.clients) { try { c.close(); } catch { /* ignore */ } }
  s.io.close();
  await new Promise((resolve) => s.httpServer.close(resolve));
  obstacleDecision.resetForTests();
  obstacleDecision.setPlannerFactoryForTests(null);
}

async function startRobot(s, robotId) {
  const spec = world.FLEET[robotId];
  const start = world.positionOf(robotId);
  const token = `session-${robotId}`;
  await s.kv.set(`session:${robotId}`, token, { ex: 3600 });
  const vr = new VirtualRobot({
    robotId,
    lat: start.lat,
    lon: start.lon,
    logger: silentLogger,
    kv: s.kv,
    simulated: true,
    obstacleProbability: 0,
    telemetryIntervalMs: 10_000,
    worldObstacles: [{ id: "OB-1", lat: world.O.lat, lon: world.O.lon, severity: "HIGH", senseRadiusM: 15 }],
  });
  vr.sessionToken = token;
  vr.connect(`http://127.0.0.1:${s.port}`);
  await waitFor(() => vr._sessionEstablished(), { timeout: 5000 });
  const received = [];
  vr.socket.onAny((event, payload) => received.push({ event, payload }));
  s.received.set(robotId, received);
  vr._emitTelemetry(Date.now());
  await waitFor(async () => {
    const socket = (await s.io.fetchSockets()).find((x) => x.data.robotId === robotId);
    return socket && socket.data.telemetryReceipt >= 1 && socket.data.dtaroZone;
  }, { timeout: 5000 });
  s.robots.set(robotId, vr);
  const stops = spec.stops || spec.ownStops;
  if (stops) {
    await dispatchTaskAssign(s.io, robotId, { taskId: `TSK-${robotId}`, pickup: stops[0][stops[0].length - 1], drop: stops[1][stops[1].length - 1], pathToPickup: stops[0], pathToDrop: stops[1] });
    await waitFor(() => vr.task, { timeout: 5000 });
  }
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
  return { client, seen };
}

/** Start every robot, then the reporter, which senses the obstacle and reports it. */
async function scenario({ decisions = true } = {}) {
  const s = await startServer({ decisions });
  const dashboard = await connectDashboard(s);
  for (const robotId of ALL_BUT_REPORTER) await startRobot(s, robotId);
  const commanded = Object.fromEntries([...s.robots].map(([id, vr]) => [id, JSON.parse(JSON.stringify(vr.task ? vr.task.stops : null))]));
  await startRobot(s, "REP");
  commanded.REP = JSON.parse(JSON.stringify(s.robots.get("REP").task.stops));
  const offersBefore = JSON.stringify(world.offerRows().outbox);
  s.robots.get("REP")._senseWorldObstacles();
  return { s, dashboard, commanded, offersBefore };
}

const eventsOf = (s, robotId, event) => (s.received.get(robotId) || []).filter((m) => m.event === event);
const required = (dashboard) => dashboard.seen.find((m) => m.event === obstacleDecision.REQUIRED_EVENT);
const latest = (dashboard, decisionId) => {
  const all = dashboard.seen.filter((m) => (m.event === obstacleDecision.UPDATED_EVENT || m.event === obstacleDecision.REQUIRED_EVENT) && m.payload.decisionId === decisionId);
  return all.reduce((best, m) => (!best || m.payload.revision > best.payload.revision ? m : best), null).payload;
};
const robotIn = (view, robotId) => view.robots.find((r) => r.robotId === robotId);
const decide = (decisionId, decision, key = `key-${decision}-${decisionId.slice(0, 8)}`) =>
  obstacleDecision.decide({ decisionId, body: { decision, idempotencyKey: key }, user: { id: SUPER.id, role: "SUPER_ADMIN" } });
const engineWrites = (s) => s.state.writes.filter((w) => ENGINE_MODELS.has(w.model));
const navTargets = (s) => ROBOT_IDS.filter((id) => eventsOf(s, id, obstacleDecision.NAV_EVENT).length > 0).sort();
const alertedRobots = (s) => ROBOT_IDS.filter((id) => eventsOf(s, id, "OBSTACLE_ALERT").length > 0).sort();
const inFootprint = (p) => pointInPolygon(p, world.FOOTPRINT);

async function settle(s, decisionId) {
  await obstacleDecision.settledForTests(decisionId);
  // Acknowledgements travel robot → server over the sockets.
  await new Promise((r) => setTimeout(r, 300));
}

// ── Before any decision ─────────────────────────────────────────────────────

describe("a report opens the operator decision; nothing reaches the fleet before it", () => {
  let ctx;
  let req;
  beforeAll(async () => {
    ctx = await scenario();
    await waitFor(() => required(ctx.dashboard), { timeout: 5000 });
    req = required(ctx.dashboard).payload;
  });
  afterAll(async () => stopServer(ctx && ctx.s));

  test("the decision panel event comes from the server, with a server deadline exactly 5 s after acceptance", () => {
    expect(req).toMatchObject({ status: "AWAITING_OPERATOR_DECISION", provenance: "SIMULATED", windowMs: 5000, defaultDecision: "REROUTE", decision: null });
    expect(Date.parse(req.deadlineAt) - Date.parse(req.receivedAt)).toBe(5000);
    // The reporter's ACK names the decision and says the alert is waiting.
    const ack = eventsOf(ctx.s, "REP", "OBSTACLE_REPORT_ACK")[0].payload;
    expect(ack).toMatchObject({ delivery: "AWAITING_DECISION", decisionId: req.decisionId, recipients: [] });
  });

  test("obstacle details are the server's: cell, zone, region, footprint; no confidence is invented", () => {
    expect(req.obstacle).toMatchObject({ cellId: world.OB_CELL, zoneId: "zE", regionId: "rA", severity: "HIGH", detection: { source: "SIMULATED_ROBOT_REPORT", confidence: null } });
    expect(req.obstacle.footprint).toHaveLength(6);
    expect(req.reporter).toMatchObject({ robotId: "REP", provenance: "SIMULATED", role: "REPORTER", affected: true, affectedReason: "REPORTER_APPROACHING" });
  });

  test("every robot is listed with the server's reason; origin and destination come from the Task row", () => {
    const why = Object.fromEntries(req.robots.map((r) => [r.robotId, [r.role, r.affected, r.affectedReason]]));
    expect(why).toEqual({
      REP: ["REPORTER", true, "REPORTER_APPROACHING"],
      "SAME-CROSS": ["RECIPIENT", true, "ROUTE_CROSSES_OBSTACLE"],
      "SAME-IDLE": ["RECIPIENT", false, "SAME_ZONE_IDLE"],
      DEAD: ["RECIPIENT", true, "ROUTE_CROSSES_OBSTACLE"],
      "X-CROSS": ["RECIPIENT", true, "ROUTE_CROSSES_OBSTACLE"],
      "X-CLEAR": ["NOT_ALERTED", false, "ROUTE_CLEAR"],
      "X-IDLE": ["NOT_ALERTED", false, "NO_REMAINING_ROUTE"],
      "X-NOGEOM": ["RECIPIENT", true, "ROUTE_UNKNOWN"],
      "B-ROUTE": ["OTHER_REGION", false, "OTHER_REGION"],
    });
    const cross = robotIn(req, "SAME-CROSS");
    expect(cross).toMatchObject({ name: "Robot SAME-CROSS", taskId: "TSK-SAME-CROSS", origin: { name: "Pickup of SAME-CROSS" }, destination: { name: "Drop of SAME-CROSS" }, routeStatus: "OK", routeIntersects: true });
    expect(cross.position).toMatchObject({ lat: expect.any(Number), lon: expect.any(Number) });
    expect(cross.originalRoute.length).toBeGreaterThan(2);
    // Absent is absent: the idle robot has no task, origin or destination.
    expect(robotIn(req, "SAME-IDLE")).toMatchObject({ taskId: null, origin: null, destination: null, originalRoute: null });
  });

  test("no robot received an obstacle alert or a navigation instruction before a decision", async () => {
    await new Promise((r) => setTimeout(r, 500));
    expect(alertedRobots(ctx.s)).toEqual([]);
    expect(navTargets(ctx.s)).toEqual([]);
    expect(ctx.dashboard.seen.some((m) => m.event === "ALERT_CREATED")).toBe(false);
    // A relevance answer is refused: nobody is a recipient yet.
    expect(dtaroZoneAlert.recordRelevance({ io: ctx.s.io, robotId: "SAME-CROSS", payload: { obstacleId: req.obstacle.obstacleId, relevant: true, routeSource: "COMMANDED_ROUTE", decision: "RELEVANT_NO_REPLAN" } })).toEqual({ accepted: false, reason: "NOT_A_RECIPIENT" });
  });

  test("the REROUTE preview reports, per affected robot, whether a safe alternate route exists", async () => {
    await waitFor(() => robotIn(latest(ctx.dashboard, req.decisionId), "SAME-CROSS").preview, { timeout: 5000 });
    const view = latest(ctx.dashboard, req.decisionId);
    expect(robotIn(view, "SAME-CROSS").preview).toMatchObject({ ok: true });
    expect(robotIn(view, "DEAD").preview).toMatchObject({ ok: false, reason: "ENDPOINT_IN_OBSTACLE" });
    expect(robotIn(view, "REP").preview).toMatchObject({ ok: false, reason: "ENDPOINT_IN_OBSTACLE" });
    expect(robotIn(view, "X-NOGEOM").preview).toMatchObject({ ok: false, reason: "ROUTE_UNKNOWN" });
  });
});

// ── STOP ─────────────────────────────────────────────────────────────────────

describe("manual STOP", () => {
  let ctx;
  let req;
  let first;
  beforeAll(async () => {
    ctx = await scenario();
    await waitFor(() => required(ctx.dashboard), { timeout: 5000 });
    req = required(ctx.dashboard).payload;
    first = decide(req.decisionId, "STOP");
    await settle(ctx.s, req.decisionId);
    await waitFor(() => latest(ctx.dashboard, req.decisionId).status === "COMPLETED", { timeout: 5000 });
  });
  afterAll(async () => stopServer(ctx && ctx.s));

  test("is committed once; a retry is idempotent and a conflicting decision is refused", () => {
    expect(first).toMatchObject({ status: 200, body: { outcome: "COMMITTED" } });
    expect(decide(req.decisionId, "STOP")).toMatchObject({ status: 200, body: { outcome: "ALREADY_COMMITTED", replay: true } });
    expect(decide(req.decisionId, "REROUTE")).toMatchObject({ status: 409, body: { error: "ALREADY_DECIDED", committed: { choice: "STOP", source: "MANUAL" } } });
    expect(decide(req.decisionId, "STOP", "a-different-key")).toMatchObject({ status: 409 });
    const view = latest(ctx.dashboard, req.decisionId);
    expect(view.decision).toMatchObject({ choice: "STOP", source: "MANUAL", decidedBy: { userId: SUPER.id } });
  });

  test("the fleet alert goes to the recipients only, after the decision, carrying it", () => {
    expect(alertedRobots(ctx.s)).toEqual(["DEAD", "SAME-CROSS", "SAME-IDLE", "X-CROSS", "X-NOGEOM"]);
    const alert = eventsOf(ctx.s, "SAME-CROSS", "OBSTACLE_ALERT")[0].payload;
    expect(alert).toMatchObject({ decisionId: req.decisionId, decision: "STOP", decisionSource: "MANUAL" });
    const created = ctx.dashboard.seen.filter((m) => m.event === "ALERT_CREATED");
    expect(created).toHaveLength(1);
    expect(created[0].payload).toMatchObject({ decisionId: req.decisionId, recipients: ["DEAD", "SAME-CROSS", "SAME-IDLE", "X-CROSS", "X-NOGEOM"] });
  });

  test("only the affected simulated robots are stopped — idle, clear and other-region robots get nothing", () => {
    expect(navTargets(ctx.s)).toEqual(["DEAD", "REP", "SAME-CROSS", "X-CROSS", "X-NOGEOM"]);
    for (const id of ["DEAD", "REP", "SAME-CROSS", "X-CROSS", "X-NOGEOM"]) {
      expect(eventsOf(ctx.s, id, obstacleDecision.NAV_EVENT).map((m) => m.payload.action)).toEqual(["STOP"]);
      expect(ctx.s.robots.get(id).status).toBe("PAUSED");
    }
    for (const id of ["SAME-IDLE", "X-CLEAR", "X-IDLE", "B-ROUTE"]) expect(ctx.s.robots.get(id).status).not.toBe("PAUSED");
    const view = latest(ctx.dashboard, req.decisionId);
    expect(Object.fromEntries(view.robots.filter((r) => r.execution).map((r) => [r.robotId, r.execution.state]))).toEqual({
      DEAD: "STOPPED", REP: "STOPPED", "SAME-CROSS": "STOPPED", "X-CROSS": "STOPPED", "X-NOGEOM": "STOPPED",
    });
    expect(view.status).toBe("COMPLETED");
  });

  test("the audit row records the decision; no engine row is written; the commanded routes are unchanged", () => {
    const row = ctx.s.state.decisionRows.get(req.decisionId);
    expect(row).toMatchObject({ decision: "STOP", decisionSource: "MANUAL", decidedByUserId: SUPER.id, status: "COMPLETED", obstacleId: req.obstacle.obstacleId, cellId: world.OB_CELL });
    expect(row.outcome.robots.find((r) => r.robotId === "X-CROSS").execution).toMatchObject({ action: "STOP", state: "STOPPED" });
    expect(engineWrites(ctx.s)).toEqual([]);
    expect(JSON.stringify(world.offerRows().outbox)).toBe(ctx.offersBefore);
    for (const [id, stops] of Object.entries(ctx.commanded)) {
      if (stops) expect([id, JSON.parse(JSON.stringify(ctx.s.robots.get(id).task.stops))]).toEqual([id, stops]);
    }
  });
});

// ── REROUTE ──────────────────────────────────────────────────────────────────

describe("manual REROUTE", () => {
  let ctx;
  let req;
  const trail = { "SAME-CROSS": [], "X-CROSS": [] };
  beforeAll(async () => {
    ctx = await scenario();
    await waitFor(() => required(ctx.dashboard), { timeout: 5000 });
    req = required(ctx.dashboard).payload;
    expect(decide(req.decisionId, "REROUTE")).toMatchObject({ status: 200 });
    await settle(ctx.s, req.decisionId);
  });
  afterAll(async () => stopServer(ctx && ctx.s));

  test("robots with a safe alternate route are sent one; the others are stopped and told why", () => {
    const actions = Object.fromEntries(navTargets(ctx.s).map((id) => [id, eventsOf(ctx.s, id, obstacleDecision.NAV_EVENT).map((m) => m.payload.action)]));
    expect(actions).toEqual({ DEAD: ["STOP"], REP: ["STOP"], "SAME-CROSS": ["REROUTE"], "X-CROSS": ["REROUTE"], "X-NOGEOM": ["STOP"] });
    const view = latest(ctx.dashboard, req.decisionId);
    expect(robotIn(view, "DEAD").execution).toMatchObject({ action: "REROUTE", state: "STOPPED_NO_SAFE_ROUTE", reason: "ENDPOINT_IN_OBSTACLE" });
    expect(robotIn(view, "REP").execution).toMatchObject({ state: "STOPPED_NO_SAFE_ROUTE", reason: "ENDPOINT_IN_OBSTACLE" });
    expect(robotIn(view, "X-NOGEOM").execution).toMatchObject({ state: "STOPPED_NO_SAFE_ROUTE", reason: "ROUTE_UNKNOWN" });
    expect(eventsOf(ctx.s, "DEAD", obstacleDecision.NAV_EVENT)[0].payload.text).toMatch(/^No safe alternate route available/);
    for (const id of ["DEAD", "REP", "X-NOGEOM"]) expect(ctx.s.robots.get(id).status).toBe("PAUSED");
    expect(view.counts).toMatchObject({ noSafeRoute: 3, rerouted: 2 });
  });

  test("each alternate route avoids the obstacle's footprint and stays in the obstacle's region (independent check)", () => {
    for (const id of ["SAME-CROSS", "X-CROSS"]) {
      const nav = eventsOf(ctx.s, id, obstacleDecision.NAV_EVENT)[0].payload;
      for (const leg of nav.legs) {
        expect(pathIntersectsPolygon(leg.points, world.FOOTPRINT)).toBe(false);
        for (const p of leg.points) expect(dtaroZoneAlert.resolvePoint({ spatial: SPATIAL }, p.lat, p.lon)).toMatchObject({ ok: true, regionId: "rA" });
      }
      expect(nav).toMatchObject({ taskId: `TSK-${id}`, provenance: "SIMULATED" });
    }
  });

  test("the robots drive the alternate route, never enter the footprint, and the server marks each one complete", async () => {
    for (let tick = 0; tick < 40; tick += 1) {
      for (const id of ["SAME-CROSS", "X-CROSS"]) {
        const vr = ctx.s.robots.get(id);
        vr._tick();
        trail[id].push({ lat: vr.lat, lon: vr.lon });
      }
      await new Promise((r) => setTimeout(r, 40));
      const view = obstacleDecision.decisionFor(req.obstacle.obstacleId);
      if (["SAME-CROSS", "X-CROSS"].every((id) => robotIn(view, id).execution.state === "COMPLETED")) break;
    }
    const view = obstacleDecision.decisionFor(req.obstacle.obstacleId);
    for (const id of ["SAME-CROSS", "X-CROSS"]) {
      expect([id, robotIn(view, id).execution.state]).toEqual([id, "COMPLETED"]);
      expect(trail[id].some(inFootprint)).toBe(false);
      expect(trail[id].length).toBeGreaterThan(3);
      const end = world.FLEET[id].stops[0][world.FLEET[id].stops[0].length - 1];
      const last = trail[id][trail[id].length - 1];
      expect(dtaroDetour.pathLengthM([last, end])).toBeLessThan(0.5);
    }
    await waitFor(() => latest(ctx.dashboard, req.decisionId).status === "COMPLETED", { timeout: 5000 });
    const final = latest(ctx.dashboard, req.decisionId);
    // Progress was measured on the way (MOVING) and the alternate and original paths are both shown.
    expect(robotIn(final, "SAME-CROSS").execution).toMatchObject({ progress: { fraction: 1 }, alternatePath: expect.any(Array), originalPath: expect.any(Array) });
    expect(final.history.some((h) => /SAME-CROSS: moving along its alternate route/.test(h.text))).toBe(true);
  });

  test("the commanded route, the OFFER rows and the engine records are untouched", () => {
    expect(engineWrites(ctx.s)).toEqual([]);
    expect(JSON.stringify(world.offerRows().outbox)).toBe(ctx.offersBefore);
    for (const id of ["SAME-CROSS", "X-CROSS"]) {
      expect(JSON.parse(JSON.stringify(ctx.s.robots.get(id).task.stops))).toEqual(ctx.commanded[id]);
      // The robot drove the detour from its simulation-only field.
      expect(ctx.s.robots.get(id).dtaroNavigation().detours.map((d) => d.stopIndex)).toEqual([0]);
    }
  });

  test("unaffected robots did not reroute or move", () => {
    for (const id of ["SAME-IDLE", "X-CLEAR", "X-IDLE", "B-ROUTE"]) {
      expect(eventsOf(ctx.s, id, obstacleDecision.NAV_EVENT)).toEqual([]);
      const start = world.positionOf(id);
      expect(dtaroDetour.pathLengthM([start, { lat: ctx.s.robots.get(id).lat, lon: ctx.s.robots.get(id).lon }])).toBeLessThan(0.01);
    }
  });

  test("a stale or replayed acknowledgement after completion changes nothing", () => {
    const nav = eventsOf(ctx.s, "SAME-CROSS", obstacleDecision.NAV_EVENT)[0].payload;
    expect(obstacleDecision.recordNavAck({ robotId: "SAME-CROSS", payload: { navId: nav.navId, decisionId: req.decisionId, outcome: "REFUSED_STOPPED" } })).toEqual({ accepted: false, reason: "DECISION_COMPLETED" });
    expect(robotIn(obstacleDecision.decisionFor(req.obstacle.obstacleId), "SAME-CROSS").execution.state).toBe("COMPLETED");
  });
});

// ── REJECT_BROADCAST ─────────────────────────────────────────────────────────

describe("manual REJECT_BROADCAST", () => {
  let ctx;
  let req;
  beforeAll(async () => {
    ctx = await scenario();
    await waitFor(() => required(ctx.dashboard), { timeout: 5000 });
    req = required(ctx.dashboard).payload;
    expect(decide(req.decisionId, "REJECT_BROADCAST")).toMatchObject({ status: 200 });
    await settle(ctx.s, req.decisionId);
    await waitFor(() => latest(ctx.dashboard, req.decisionId).status === "COMPLETED", { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 500));
  });
  afterAll(async () => stopServer(ctx && ctx.s));

  test("no recipient robot receives an obstacle alert or a navigation instruction", () => {
    expect(alertedRobots(ctx.s)).toEqual([]);
    for (const id of ALL_BUT_REPORTER) expect([id, eventsOf(ctx.s, id, obstacleDecision.NAV_EVENT)]).toEqual([id, []]);
    expect(ctx.dashboard.seen.some((m) => m.event === "ALERT_CREATED")).toBe(false);
  });

  test("the reporter, heading into the obstacle, is stopped by its own instruction — not by a broadcast", () => {
    expect(eventsOf(ctx.s, "REP", obstacleDecision.NAV_EVENT).map((m) => [m.payload.action, m.payload.reason])).toEqual([["STOP", "REPORTER_SAFETY_STOP"]]);
    expect(ctx.s.robots.get("REP").status).toBe("PAUSED");
    expect(eventsOf(ctx.s, "REP", "OBSTACLE_ALERT")).toEqual([]);
  });

  test("the suppression is recorded with the deliberately suppressed recipients; the obstacle is not called absent", () => {
    const view = latest(ctx.dashboard, req.decisionId);
    expect(view.propagation).toMatchObject({ outcome: "SUPPRESSED", delivered: [], suppressedRecipients: ["DEAD", "SAME-CROSS", "SAME-IDLE", "X-CROSS", "X-NOGEOM"] });
    expect(view.propagation.reason).toBe("Broadcast rejected by the operator — fleet alert suppressed");
    expect(view.history.some((h) => /not confirmed absent/.test(h.text))).toBe(true);
    expect(ctx.s.state.decisionRows.get(req.decisionId)).toMatchObject({ decision: "REJECT_BROADCAST", status: "COMPLETED", suppressedAt: expect.any(Date) });
  });

  test("a suppressed alert can never be delivered afterwards", async () => {
    expect(await dtaroZoneAlert.propagateAlert({ io: ctx.s.io, prisma: getPrisma(), obstacleId: req.obstacle.obstacleId })).toEqual({ ok: false, reason: "DELIVERY_SUPPRESSED" });
    expect(alertedRobots(ctx.s)).toEqual([]);
  });

  test("a second report of the same cell is merged, not broadcast", async () => {
    const before = ctx.dashboard.seen.filter((m) => m.event === obstacleDecision.REQUIRED_EVENT).length;
    const other = ctx.s.robots.get("SAME-IDLE");
    other.socket.emit("OBSTACLE_REPORT", { lat: world.O.lat, lon: world.O.lon, severity: "HIGH" });
    await waitFor(() => ctx.dashboard.seen.some((m) => m.event === "OBSTACLE_REPORT_MERGED"), { timeout: 5000 });
    expect(ctx.dashboard.seen.filter((m) => m.event === obstacleDecision.REQUIRED_EVENT).length).toBe(before);
    expect(alertedRobots(ctx.s)).toEqual([]);
  });
});

// ── The server's default ─────────────────────────────────────────────────────

describe("no operator decision: the server's 5 s default is REROUTE, with no dashboard connected", () => {
  let ctx;
  let req;
  beforeAll(async () => {
    ctx = await scenario();
    await waitFor(() => required(ctx.dashboard), { timeout: 5000 });
    req = required(ctx.dashboard).payload;
    // The only dashboard goes away before the deadline.
    ctx.dashboard.client.close();
    await waitFor(async () => (await ctx.s.io.in(dashboardBroadcast.ROOM).fetchSockets()).length === 0, { timeout: 3000 });
    await waitFor(() => obstacleDecision.decisionFor(req.obstacle.obstacleId).decision, { timeout: 7000, interval: 50 });
    await settle(ctx.s, req.decisionId);
  });
  afterAll(async () => stopServer(ctx && ctx.s));

  test("the default is committed at the deadline, labelled as the server's, and executed", () => {
    const view = obstacleDecision.decisionFor(req.obstacle.obstacleId);
    expect(view.decision).toMatchObject({ choice: "REROUTE", source: "DEFAULT_TIMEOUT", decidedBy: null });
    expect(view.decision.reason).toMatch(/No operator decision reached the server within 5 s/);
    expect(Date.parse(view.decision.decidedAt)).toBeGreaterThanOrEqual(Date.parse(req.deadlineAt));
    expect(alertedRobots(ctx.s)).toEqual(["DEAD", "SAME-CROSS", "SAME-IDLE", "X-CROSS", "X-NOGEOM"]);
    expect(eventsOf(ctx.s, "SAME-CROSS", obstacleDecision.NAV_EVENT).map((m) => m.payload.action)).toEqual(["REROUTE"]);
    expect(ctx.s.state.decisionRows.get(req.decisionId)).toMatchObject({ decision: "REROUTE", decisionSource: "DEFAULT_TIMEOUT", decidedByUserId: null });
  });

  test("a late manual decision is refused and changes nothing", () => {
    expect(decide(req.decisionId, "STOP")).toMatchObject({ status: 409, body: { error: "DEFAULT_ALREADY_APPLIED", committed: { choice: "REROUTE", source: "DEFAULT_TIMEOUT" } } });
    expect(eventsOf(ctx.s, "SAME-CROSS", obstacleDecision.NAV_EVENT)).toHaveLength(1);
  });

  test("a dashboard that reconnects restores the decided state from the server, deadline unchanged", async () => {
    const decisions = await obstacleDecision.listDecisions(getPrisma());
    const restored = decisions.find((d) => d.decisionId === req.decisionId);
    expect(restored).toMatchObject({ deadlineAt: req.deadlineAt, receivedAt: req.receivedAt, decision: { choice: "REROUTE", source: "DEFAULT_TIMEOUT" } });
    expect(restored.revision).toBeGreaterThan(req.revision);
  });
});

// ── Flag off ─────────────────────────────────────────────────────────────────

describe("DTARO_OPERATOR_DECISION_ENABLED off: alerts are delivered at once, exactly as before", () => {
  let ctx;
  beforeAll(async () => {
    ctx = await scenario({ decisions: false });
    await waitFor(() => ctx.dashboard.seen.some((m) => m.event === "ALERT_CREATED"), { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 500));
  });
  afterAll(async () => {
    await stopServer(ctx && ctx.s);
    delete process.env[obstacleDecision.ENV_SWITCH];
  });

  test("no decision event, no navigation instruction, no audit row; the zone alert goes out immediately", () => {
    expect(ctx.dashboard.seen.some((m) => m.event === obstacleDecision.REQUIRED_EVENT || m.event === obstacleDecision.UPDATED_EVENT)).toBe(false);
    expect(navTargets(ctx.s)).toEqual([]);
    expect(ctx.s.state.writes.filter((w) => w.model === "dtaroObstacleDecision")).toEqual([]);
    expect(alertedRobots(ctx.s)).toEqual(["DEAD", "SAME-CROSS", "SAME-IDLE", "X-CROSS", "X-NOGEOM"]);
    const created = ctx.dashboard.seen.find((m) => m.event === "ALERT_CREATED").payload;
    expect(created.decisionId).toBeUndefined();
    expect(eventsOf(ctx.s, "REP", "OBSTACLE_REPORT_ACK")[0].payload.delivery).toBe("ZONE_ROOM");
    for (const id of ROBOT_IDS) expect(ctx.s.robots.get(id).status).not.toBe("PAUSED");
  });
});

// ── Found on the real stack (2026-10-24): a robot already driving a detour ───────────────────

const ekb = require("../../src/services/ekb.service");
const onBypass = (vr) => vr.lat > world.xy(0, 60).lat && vr.lon > world.xy(40, 0).lon;

describe("a second obstacle while robots drive detours", () => {
  let ctx;
  let first;
  let second;
  beforeAll(async () => {
    ctx = await scenario();
    await waitFor(() => required(ctx.dashboard), { timeout: 5000 });
    first = required(ctx.dashboard).payload;
    decide(first.decisionId, "REROUTE");
    await settle(ctx.s, first.decisionId);
    // SAME-CROSS drives its detour onto the bypass, short of x = 0 (where the second obstacle is).
    const vr = ctx.s.robots.get("SAME-CROSS");
    for (let i = 0; i < 30 && !onBypass(vr); i += 1) {
      vr._tick();
      await new Promise((r) => setTimeout(r, 40));
    }
    await waitFor(() => robotIn(obstacleDecision.decisionFor(first.obstacle.obstacleId), "SAME-CROSS").execution.state === "MOVING", { timeout: 3000 });
    // A robot reports a second obstacle ON the bypass: the only way round the first one.
    ctx.s.robots.get("SAME-IDLE").socket.emit("OBSTACLE_REPORT", { lat: world.xy(0, 80).lat, lon: world.xy(0, 80).lon, severity: "HIGH" });
    await waitFor(() => ctx.dashboard.seen.some((m) => m.event === obstacleDecision.REQUIRED_EVENT && m.payload.decisionId !== first.decisionId), { timeout: 5000 });
    second = ctx.dashboard.seen.find((m) => m.event === obstacleDecision.REQUIRED_EVENT && m.payload.decisionId !== first.decisionId).payload;
    decide(second.decisionId, "REROUTE");
    await settle(ctx.s, second.decisionId);
  });
  afterAll(async () => stopServer(ctx && ctx.s));

  test("a detouring robot is judged on the detour it is driving, not the corridor it left", () => {
    expect(onBypass(ctx.s.robots.get("SAME-CROSS"))).toBe(true);
    expect(robotIn(second, "SAME-CROSS")).toMatchObject({ affected: true, affectedReason: "DETOUR_CROSSES_OBSTACLE", onDetourFrom: first.decisionId });
  });

  test("its new plan keeps clear of BOTH obstacles: with the bypass blocked too, no safe route exists, so it is stopped", () => {
    const view = obstacleDecision.decisionFor(second.obstacle.obstacleId);
    expect(robotIn(view, "SAME-CROSS").execution).toMatchObject({ action: "REROUTE", state: "STOPPED_NO_SAFE_ROUTE" });
    expect(ctx.s.robots.get("SAME-CROSS").status).toBe("PAUSED");
    // Never a path back through the first obstacle's cell.
    for (const m of eventsOf(ctx.s, "SAME-CROSS", obstacleDecision.NAV_EVENT).slice(1)) {
      for (const leg of m.payload.legs || []) expect(pathIntersectsPolygon(leg.points, world.FOOTPRINT)).toBe(false);
    }
  });

  test("the earlier instruction is superseded, and the first decision closes", async () => {
    await waitFor(() => obstacleDecision.decisionFor(first.obstacle.obstacleId).status === "COMPLETED", { timeout: 5000 });
    const before = obstacleDecision.decisionFor(first.obstacle.obstacleId);
    expect(robotIn(before, "SAME-CROSS").execution).toMatchObject({ state: "SUPERSEDED", supersededBy: second.decisionId });
    expect(before.history.some((h) => /superseded by a later decision/.test(h.text))).toBe(true);
  });

  test("a robot told to reroute while it is already stopped installs the detour but reports itself STOPPED (held)", () => {
    // DEAD was stopped by the first decision (no safe route); it is affected by neither detour
    // here, so drive the held case directly through the robot's own handler.
    const vr = ctx.s.robots.get("DEAD");
    expect(vr.status).toBe("PAUSED");
    const sent = [];
    const emit = vr.socket.emit.bind(vr.socket);
    vr.socket.emit = (event, payload) => { sent.push({ event, payload }); return emit(event, payload); };
    const legs = [{ stopIndex: 1, points: world.FLEET.DEAD.stops[1].slice() }];
    // Leg 2 runs through the obstacle in this fixture: the robot refuses it and stays stopped.
    vr._onDtaroSimNav({ navId: "held-1", decisionId: "d-held", obstacleId: "x", action: "REROUTE", footprint: world.FOOTPRINT, taskId: "TSK-DEAD", legs });
    expect(sent.find((m) => m.event === "DTARO_SIM_NAV_ACK").payload).toMatchObject({ outcome: "REFUSED_STOPPED", reason: "DETOUR_MEETS_OBSTACLE" });
    const clear = [{ stopIndex: 1, points: [world.xy(10, 0), world.xy(10, -60), world.xy(-30, -60), world.xy(-30, 0)] }];
    vr._onDtaroSimNav({ navId: "held-2", decisionId: "d-held", obstacleId: "y", action: "REROUTE", footprint: world.FOOTPRINT.map((p) => ({ lat: p.lat + 0.01, lon: p.lon })), taskId: "TSK-DEAD", legs: clear });
    expect(sent.filter((m) => m.event === "DTARO_SIM_NAV_ACK")[1].payload).toMatchObject({ outcome: "STOPPED", reason: expect.stringMatching(/^HELD/) });
    expect(vr.status).toBe("PAUSED");
  });
});

describe("the obstacle expiring mid-detour does not end tracking", () => {
  let ctx;
  let req;
  let spy;
  beforeAll(async () => {
    const store = ekb.storeObstacle;
    spy = jest.spyOn(ekb, "storeObstacle").mockImplementation((kv, prisma, args) => store(kv, prisma, { ...args, ttlSec: 3 }));
    ctx = await scenario();
    await waitFor(() => required(ctx.dashboard), { timeout: 5000 });
    req = required(ctx.dashboard).payload;
    decide(req.decisionId, "REROUTE");
    await settle(ctx.s, req.decisionId);
  });
  afterAll(async () => {
    spy.mockRestore();
    await stopServer(ctx && ctx.s);
  });

  test("past the obstacle's expiry the decision still follows its rerouted robots, then completes", async () => {
    await new Promise((r) => setTimeout(r, 3500));
    const mid = obstacleDecision.decisionFor(req.obstacle.obstacleId);
    expect(mid).toMatchObject({ status: "EXECUTING", obstacleExpired: true });
    for (let tick = 0; tick < 40; tick += 1) {
      for (const id of ["SAME-CROSS", "X-CROSS"]) ctx.s.robots.get(id)._tick();
      await new Promise((r) => setTimeout(r, 40));
      if (obstacleDecision.decisionFor(req.obstacle.obstacleId).status === "COMPLETED") break;
    }
    const done = obstacleDecision.decisionFor(req.obstacle.obstacleId);
    expect(done.status).toBe("COMPLETED");
    expect(["SAME-CROSS", "X-CROSS"].map((id) => robotIn(done, id).execution.state)).toEqual(["COMPLETED", "COMPLETED"]);
  });
});

describe("a session that is not a simulated (DTARO-eligible) robot is never instructed", () => {
  let ctx;
  let req;
  beforeAll(async () => {
    ctx = await scenario();
    await waitFor(() => required(ctx.dashboard), { timeout: 5000 });
    req = required(ctx.dashboard).payload;
    // Stand-in for a physical unit: the server-side session of X-CROSS loses DTARO eligibility.
    for (const socket of await ctx.s.io.in("robot:X-CROSS").fetchSockets()) socket.data.dtaroEligible = false;
    decide(req.decisionId, "STOP");
    await settle(ctx.s, req.decisionId);
  });
  afterAll(async () => stopServer(ctx && ctx.s));

  test("it is not even a candidate: not considered, not listed, sent nothing; the simulated robots are still instructed", () => {
    const view = obstacleDecision.decisionFor(req.obstacle.obstacleId);
    expect(robotIn(view, "X-CROSS")).toBeUndefined();
    expect(eventsOf(ctx.s, "X-CROSS", obstacleDecision.NAV_EVENT)).toEqual([]);
    expect(eventsOf(ctx.s, "X-CROSS", "OBSTACLE_ALERT")).toEqual([]);
    expect(ctx.s.robots.get("X-CROSS").status).not.toBe("PAUSED");
    expect(robotIn(view, "SAME-CROSS").execution.state).toBe("STOPPED");
  });
});
