#!/usr/bin/env node
"use strict";

/**
 * DTARO obstacle-awareness demonstration — repeatable, offline, over real local sockets.
 *
 *   node tools/demo/dtaro/runDtaroDemo.js [--quick] [--json <file>]
 *
 * What runs, and what is real:
 *   * REAL: the shipped Socket.IO composition (`initSocketServer`: robot AUTH, TELEMETRY and the
 *     DTARO handlers), `dashboardBroadcast`, the zone-alert service, and `VirtualRobot` clients
 *     connecting over websockets on 127.0.0.1. A SUPER_ADMIN dashboard socket observes the
 *     dashboard events over a real connection.
 *   * REAL GEOMETRY: the spatial authority is the RNSIT map the V1 bootstrap publishes
 *     (`bootstrapV1Environment.intendedWorld()`: D6's 64-cell res-11 cover, ONE zone `rnsit-z1`)
 *     — the currently valid authority, not the unapproved four-zone proposal. Routes are
 *     computed on the RNSIT campus walkway network between named campus points.
 *   * SYNTHETIC, and labelled so: one extra region near JSSATE whose zone deliberately reuses the
 *     label `rnsit-z1`, to show that a same-label zone in another region receives nothing.
 *     JSSATE has no engine region; nothing here configures one.
 *   * NOT REAL: no database (an in-memory Prisma stand-in; the process is pinned to an
 *     unreachable DATABASE_URL and an empty env file before anything loads), no engine (routes
 *     are delivered by the legacy TASK_ASSIGN dispatch, which builds the same `task.stops` an
 *     engine OFFER does), no Redis, no Mapbox.
 *
 * THIS IS NOT `server.js` AND NOT A FULL-STACK TEST. Bypassed, specifically: the express app and
 * REST routes; `configService.bootstrap` (the "pinned snapshot" is a hand-built `{ spatial }`
 * object with no `values`); the engine and every worker (no intake, coordinator, OFFER, outbox,
 * lease or settlement); `SimulationEngine` and `VirtualRobot.commission()` (robots are built
 * directly); pairing (session tokens are pre-seeded in the in-memory KV); Prisma (`getPrisma` is
 * replaced on the module before anything loads, so every query returns the stand-in's answer).
 * Routes are campus-network routes delivered as unsigned legacy TASK_ASSIGN, not priced, signed
 * OFFERs. The full-stack procedure is `tools/demo/dtaro/README.md` § "Full-stack run".
 *
 * The obstacle is the scenario file's fixed point (`rnsit-dtaro-scenario.json`). The reporter is
 * parked beside it and SENSES it on its first tick; the others drive their commanded routes.
 * Exit code 0 only if every expected outcome holds.
 */

const path = require("path");

const BACKEND_ROOT = path.resolve(__dirname, "../../..");

// ── Isolation, before any application module loads ─────────────────────────
process.env.ROBOTX_ENV_FILE = path.join(BACKEND_ROOT, "tests/fixtures/environment/isolated-test.dotenv");
process.env.DATABASE_URL = "postgresql://dtaro-demo-isolation@127.0.0.1:1/none?connect_timeout=2";
delete process.env.ROBOTX_ENV;
delete process.env.REDIS_URL;
process.env.REDIS_ENABLED = "false";
delete process.env.MAPBOX_TOKEN;
delete process.env.MAPBOX_ACCESS_TOKEN;
process.env.ENGINE_ENABLED = "false";
process.env.NODE_ENV = process.env.NODE_ENV || "development";
process.env.JWT_SECRET = "dtaro-demo-local-only-secret";
process.env.DTARO_ZONE_ALERTS_ENABLED = "true";
process.env.SIM_DTARO_SCENARIO = path.join(__dirname, "rnsit-dtaro-scenario.json");

// Every module that reaches for the shared client gets the in-memory stand-in, installed before
// any of them loads (they destructure `getPrisma` at require time).
const ROWS = new Map();
const PRISMA = prismaStandIn(ROWS);
require(path.join(BACKEND_ROOT, "src/db/prisma")).getPrisma = () => PRISMA;

const http = require("http");
const h3 = require("h3-js");
const jwt = require("jsonwebtoken");
const { Server } = require("socket.io");
const { io: ioClient } = require("socket.io-client");

const req = (p) => require(path.join(BACKEND_ROOT, p));
const initSocketServer = req("src/sockets/socket.server");
const dashboardBroadcast = req("src/sockets/dashboardBroadcast");
const { dispatchTaskAssign } = req("src/services/commandDispatcher.service");
const dtaroZoneAlert = req("src/services/dtaroZoneAlert.service");
const { pathIntersectsPolygon } = req("src/services/routeIntersection.service");
const dtaroScenario = req("src/simulation/dtaroScenario");
const VirtualRobot = req("src/simulation/VirtualRobot");
const net = req("src/simulation/campusTraversalNetwork");
const { haversineMeters } = req("src/utils/distance");
const { initKv } = req("src/cache/kv");
const bootstrap = req("tools/deploy/bootstrapV1Environment");
const seed = req("tools/demo/seedV1Demonstration");

const args = process.argv.slice(2);
const QUICK = args.includes("--quick");
const JSON_OUT = args.includes("--json") ? args[args.indexOf("--json") + 1] : null;

const quiet = { info() {}, warn() {}, error() {}, debug() {}, http() {}, socket() {}, obstacle() {}, child() { return quiet; } };
const T0 = Date.now();
const timeline = [];
function say(kind, text, data) {
  const t = ((Date.now() - T0) / 1000).toFixed(1).padStart(5);
  console.log(`[t+${t}s] ${kind.padEnd(9)} ${text}`);
  timeline.push({ atMs: Date.now() - T0, kind, text, ...(data ? { data } : {}) });
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// ── World ────────────────────────────────────────────────────────────────────

const REGION = "rnsit"; // the bootstrap's region business key, standing in for its row id
const ZONE = "rnsit-z1";
const SYNTH_REGION = "SYNTHETIC-R2";
const SYNTH_CENTRE = { lat: 12.9027, lon: 77.505 };

function buildWorld() {
  const world = bootstrap.intendedWorld();
  const synthCells = h3.gridDisk(h3.latLngToCell(SYNTH_CENTRE.lat, SYNTH_CENTRE.lon, 11), 4);
  const spatial = {
    version: "demo-1",
    regions: [{ id: REGION }, { id: SYNTH_REGION }],
    zones: [{ id: ZONE, regionId: REGION }],
    sites: [],
    cells: [
      ...world.indexCover.map((cellId) => ({ cellId, resolution: "FINE", regionId: REGION, zoneId: ZONE })),
      // SYNTHETIC: the same zone label in another region; the cells name their own region.
      ...synthCells.map((cellId) => ({ cellId, resolution: "FINE", regionId: SYNTH_REGION, zoneId: ZONE })),
    ],
  };
  const extract = net.extractForDeclaration(world.declaration);
  if (!extract.ok) throw new Error(extract.problems.join("; "));
  const network = net.createCampusTraversalNetwork({ features: extract.features, roadClasses: ["footway", "path", "service"], source: extract.file });
  return { world, spatial, network, points: seed.loadGeometry().points };
}

/** Minimum distance (m) from a point to a polyline, in a local planar frame around the point. */
function minDistanceToRouteM(point, route) {
  const mLat = 111_320;
  const mLon = 111_320 * Math.cos((point.lat * Math.PI) / 180);
  const xy = (p) => ({ x: (p.lon - point.lon) * mLon, y: (p.lat - point.lat) * mLat });
  let best = Infinity;
  for (let i = 1; i < route.length; i++) {
    const a = xy(route[i - 1]);
    const b = xy(route[i]);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / len2));
    best = Math.min(best, Math.hypot(a.x + t * dx, a.y + t * dy));
  }
  return best;
}

function routeOf(network, from, to) {
  const r = network.route(from, to);
  if (!r.ok) throw new Error(`no campus route: ${r.reason}`);
  return r;
}

// ── Prisma stand-in (in memory; the process cannot reach a database anyway) ──

var SUPER = { id: "dddddddd-0000-4000-8000-000000000001", email: "demo@local", role: "SUPER_ADMIN", campusId: null, campus: null, disabledAt: null };

function prismaStandIn(rows) {
  const answer = (model, method, a) => {
    if (model === "robot" && (method === "findUnique" || method === "findFirst")) {
      return rows.get(a?.where?.robotId ?? a?.where?.OR?.[0]?.robotId) || null;
    }
    if (model === "user" && method === "findUnique") return a?.where?.id === SUPER.id ? SUPER : null;
    if (method === "findMany" || method === "groupBy") return [];
    if (method === "findUnique" || method === "findFirst") return null;
    if (method === "count") return 0;
    if (method === "updateMany" || method === "deleteMany" || method === "createMany") return { count: 0 };
    return {};
  };
  const prisma = new Proxy({}, {
    get(_t, model) {
      if (model === "then") return undefined;
      if (model === "$transaction") return async (x) => (typeof x === "function" ? x(prisma) : Promise.all(x));
      if (typeof model === "string" && model.startsWith("$")) return async () => [];
      if (typeof model !== "string") return undefined;
      return new Proxy({}, { get: (_u, method) => (method === "then" ? undefined : async (a) => answer(model, method, a)) });
    },
  });
  return prisma;
}

// ── Run ──────────────────────────────────────────────────────────────────────

async function main() {
  const scenario = dtaroScenario.activeScenario();
  const obstacle = scenario.obstacles[0];
  const { world, spatial, network, points } = buildWorld();

  const located = dtaroZoneAlert.resolvePoint({ spatial }, obstacle.lat, obstacle.lon);
  if (!located.ok) throw new Error(`the scenario obstacle does not resolve in the published map: ${located.reason}`);

  const near = (p, dLat) => ({ lat: p.lat + dLat, lon: p.lon });
  const fleet = [
    { robotId: "SIM-DEMO-REPORTER", at: near(obstacle, 0.00007), role: "reporter (parked ~8 m from the obstacle)" },
    {
      robotId: "SIM-DEMO-CROSS", at: points["rnsit-main-gate"], role: "commanded route passes the obstacle",
      task: { taskId: "TSK-DEMO-CROSS", pickup: points["rnsit-playground-1"], drop: points["rnsit-playground-2"] },
    },
    {
      robotId: "SIM-DEMO-CLEAR", at: points["rnsit-canara-bank"], role: "commanded route elsewhere on campus",
      task: { taskId: "TSK-DEMO-CLEAR", pickup: points["rnsit-cyber-security-department"], drop: points["rns-first-grade-college"] },
    },
    { robotId: "SIM-DEMO-IDLE", at: points["rnsit-innovation-center"], role: "same zone, no task" },
    { robotId: "SIM-SYNTH-R2", at: SYNTH_CENTRE, role: "SYNTHETIC region, same zone label" },
  ];
  for (const f of fleet) {
    ROWS.set(f.robotId, {
      id: `demo-${f.robotId}`, robotId: f.robotId, status: "IDLE", isOnline: false, lat: f.at.lat, lon: f.at.lon, battery: 95, simulated: true, agent: null,
    });
  }

  const { kv } = await initKv({ logger: quiet });
  const prisma = PRISMA;
  const httpServer = http.createServer();
  const io = new Server(httpServer, { cors: { origin: true, credentials: true } });
  initSocketServer(io, { prisma, kv, logger: quiet, appLocals: { config: { version: "dtaro-demo", spatial } } });
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${httpServer.address().port}`;

  console.log("\nDTARO obstacle-awareness demonstration (offline, real local sockets, no database, engine off)\n");
  say("SERVER", `listening on ${url}`);
  say("AUTHORITY", `RNSIT published map from the V1 bootstrap: ${world.indexCover.length} FINE cells → region "${REGION}", ONE zone "${ZONE}"`);
  say("AUTHORITY", `+ SYNTHETIC region "${SYNTH_REGION}" (not configured anywhere) reusing the zone label "${ZONE}"`);
  say("SCENARIO", `${scenario.id}: obstacle ${obstacle.id} at (${obstacle.lat}, ${obstacle.lon}), ${obstacle.severity}, sensed within ${obstacle.senseRadiusM} m → cell ${located.cellId}, zone ${located.zoneId}`);

  // Dashboard observer, over a real socket, as a SUPER_ADMIN.
  const dashboard = ioClient(url, {
    transports: ["websocket"], reconnection: false, forceNew: true,
    extraHeaders: { "user-agent": "Mozilla/5.0 (DTARO demo dashboard)", cookie: `token=${jwt.sign({ id: SUPER.id }, process.env.JWT_SECRET)}` },
  });
  const seen = [];
  dashboard.onAny((event, payload) => {
    if (!["ALERT_CREATED", "OBSTACLE_RELEVANCE", "OBSTACLE_REPORT_REJECTED"].includes(event)) return;
    seen.push({ event, payload });
    if (event === "ALERT_CREATED") {
      say("DASHBOARD", `ALERT_CREATED ${payload.obstacleId} by ${payload.reportingRobotId} in ${payload.regionId}/${payload.zoneId} (cell ${payload.cellId}) → delivered to [${payload.recipients.join(", ")}]`, payload);
    } else if (event === "OBSTACLE_RELEVANCE") {
      say("DASHBOARD", `OBSTACLE_RELEVANCE ${payload.robotId}: ${payload.relevant ? "RELEVANT" : "not relevant"} (${payload.routeSource}${payload.taskId ? ` ${payload.taskId}` : ""}) → ${payload.decision}`, payload);
    } else {
      say("DASHBOARD", `OBSTACLE_REPORT_REJECTED ${payload.reportingRobotId}: ${payload.reason}`, payload);
    }
  });
  await new Promise((resolve, reject) => { dashboard.once("connect", resolve); dashboard.once("connect_error", reject); });
  await until(async () => (await io.in(dashboardBroadcast.ROOM).fetchSockets()).length > 0, 3000, "the dashboard room");
  say("DASHBOARD", "SUPER_ADMIN dashboard socket connected (room \"dashboard\")");

  // Robots, over real sockets.
  const robots = new Map();
  for (const f of fleet) {
    await kv.set(`session:${f.robotId}`, `demo-${f.robotId}`, { ex: 3600 });
    const vr = new VirtualRobot({
      robotId: f.robotId, lat: f.at.lat, lon: f.at.lon, logger: quiet, kv, simulated: true,
      telemetryIntervalMs: 1000, speedBaseMs: 8, speedJitter: 0, initialBattery: 95, randomSeed: 7,
      worldObstacles: dtaroScenario.worldObstaclesFor(),
    });
    vr.sessionToken = `demo-${f.robotId}`;
    vr.connect(url);
    await until(() => vr._sessionEstablished(), 5000, `${f.robotId} AUTH`);
    vr._emitTelemetry(Date.now());
    robots.set(f.robotId, vr);
  }
  await sleep(300);
  for (const f of fleet) {
    const s = (await io.fetchSockets()).find((x) => x.data.robotId === f.robotId);
    say("ROBOT", `${f.robotId.padEnd(18)} AUTH ok → ${s && s.data.dtaroZone ? s.data.dtaroZone.room : "no zone room"}  (${f.role})`);
  }

  // Commanded routes on the campus network, delivered over each robot's own room.
  const commanded = new Map();
  for (const f of fleet.filter((x) => x.task)) {
    const toPickup = routeOf(network, f.at, f.task.pickup);
    const toDrop = routeOf(network, f.task.pickup, f.task.drop);
    const payload = { taskId: f.task.taskId, pickup: f.task.pickup, drop: f.task.drop, pathToPickup: toPickup.points, pathToDrop: toDrop.points };
    commanded.set(f.robotId, payload);
    await dispatchTaskAssign(io, f.robotId, payload);
    say("ROUTE", `${f.robotId} commanded ${f.task.taskId}: ${toPickup.points.length + toDrop.points.length} pts, ${(toPickup.distanceM + toDrop.distanceM).toFixed(0)} m on the campus walkway network`);
  }
  await until(() => [...commanded.keys()].every((id) => robots.get(id).task), 5000, "routes delivered");

  // Two references for the verdict check below, both computed here from the commanded payloads,
  // not from the robots' state:
  //   · `sameAlgorithm` — the robots' own footprint test re-run on the payload. A CONSISTENCY
  //     check (same function), not independent evidence.
  //   · `clearanceM` — the route's minimum distance to the obstacle point, by plain geometry that
  //     shares no code with the footprint test. Independent: a route through the obstacle is
  //     within a few metres of it; one clear of the whole cell is farther than the cell's
  //     circumradius (~29 m at res 11).
  const footprint = dtaroZoneAlert.cellFootprint(located.cellId);
  const sameAlgorithm = {};
  const clearanceM = {};
  for (const [id, p] of commanded) {
    const route = [...p.pathToPickup, ...p.pathToDrop];
    sameAlgorithm[id] = pathIntersectsPolygon(route, footprint);
    clearanceM[id] = Number(minDistanceToRouteM(obstacle, route).toFixed(1));
    say("ROUTE", `${id} passes ${clearanceM[id]} m from the obstacle point (independent metric check)`);
  }

  const before = new Map([...commanded.keys()].map((id) => [id, JSON.stringify(robots.get(id).task.stops.map((s) => s.path))]));

  // Go: every robot ticks; the reporter senses the obstacle on its first tick.
  say("SIM", "simulation ticking (1 s); deterministic world obstacles, no random reports");
  for (const vr of robots.values()) vr.start();

  await until(() => seen.filter((m) => m.event === "OBSTACLE_RELEVANCE").length >= 3, 15000, "three relevance verdicts");

  let passedObstacle = null;
  if (!QUICK) {
    say("SIM", "waiting for SIM-DEMO-CROSS to reach the obstacle on its unchanged commanded route…");
    const cross = robots.get("SIM-DEMO-CROSS");
    let closest = Infinity;
    await until(() => {
      const d = haversineMeters(cross.lat, cross.lon, obstacle.lat, obstacle.lon);
      closest = Math.min(closest, d);
      return cross.obstacleAwareness().reported.some((r) => r.worldId === obstacle.id);
    }, 120000, "SIM-DEMO-CROSS to reach the obstacle");
    passedObstacle = { closestM: Number(closest.toFixed(1)), status: cross.status, report: cross.obstacleAwareness().reported[0] };
    say("ROBOT", `SIM-DEMO-CROSS within ${obstacle.senseRadiusM} m of ${obstacle.id}: already alerted → ${passedObstacle.report.outcome} (no duplicate report), status ${cross.status}`);
  }

  for (const vr of robots.values()) vr.stop();
  dashboard.close();
  io.close();
  await new Promise((resolve) => httpServer.close(resolve));

  // ── Verdict ────────────────────────────────────────────────────────────────
  const created = seen.filter((m) => m.event === "ALERT_CREATED").map((m) => m.payload);
  const verdicts = new Map(seen.filter((m) => m.event === "OBSTACLE_RELEVANCE").map((m) => [m.payload.robotId, m.payload]));
  const checks = [
    ["exactly one obstacle report, accepted", created.length === 1 && seen.every((m) => m.event !== "OBSTACLE_REPORT_REJECTED")],
    ["reporter is SIM-DEMO-REPORTER, zone rnsit/rnsit-z1", created[0] && created[0].reportingRobotId === "SIM-DEMO-REPORTER" && created[0].regionId === REGION && created[0].zoneId === ZONE],
    ["delivered to exactly CLEAR, CROSS, IDLE (not the reporter, not the synthetic region)",
      created[0] && JSON.stringify(created[0].recipients) === JSON.stringify(["SIM-DEMO-CLEAR", "SIM-DEMO-CROSS", "SIM-DEMO-IDLE"])],
    ["SYNTHETIC same-label region received nothing", robots.get("SIM-SYNTH-R2").obstacleAwareness().alerts.length === 0],
    ["CROSS: relevant; its route passes within 5 m of the obstacle (independent) and the same-algorithm re-check agrees",
      verdicts.get("SIM-DEMO-CROSS")?.relevant === true && clearanceM["SIM-DEMO-CROSS"] <= 5 && sameAlgorithm["SIM-DEMO-CROSS"] === true],
    ["CLEAR: not relevant; its route stays over 60 m from the obstacle (independent) and the same-algorithm re-check agrees",
      verdicts.get("SIM-DEMO-CLEAR")?.relevant === false && clearanceM["SIM-DEMO-CLEAR"] > 60 && sameAlgorithm["SIM-DEMO-CLEAR"] === false],
    ["IDLE: no planned route", verdicts.get("SIM-DEMO-IDLE")?.decision === "NO_PLANNED_ROUTE"],
    ["commanded routes unchanged by the alert (no reroute)", [...before].every(([id, json]) => JSON.stringify(robots.get(id).task ? robots.get(id).task.stops.map((s) => s.path) : JSON.parse(json)) === json)],
  ];
  if (passedObstacle) checks.push(["CROSS reached the obstacle without re-reporting it", passedObstacle.report.outcome === "ALREADY_ALERTED"]);

  console.log("\nSummary");
  console.log(`  obstacle   ${created[0] ? created[0].obstacleId : "-"}  ${obstacle.id} (${obstacle.lat}, ${obstacle.lon})  zone ${located.regionId}/${located.zoneId}  cell ${located.cellId}`);
  for (const f of fleet) {
    const v = verdicts.get(f.robotId);
    const a = robots.get(f.robotId).obstacleAwareness();
    const what = f.robotId === "SIM-DEMO-REPORTER" ? `reported → ${a.reported[0] ? a.reported[0].outcome : "-"}` : v ? `${v.relevant ? "RELEVANT" : "not relevant"} → ${v.decision}` : "no alert received";
    console.log(`  ${f.robotId.padEnd(18)} ${what}`);
  }
  console.log("\nChecks");
  for (const [name, ok] of checks) console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  const allPass = checks.every(([, ok]) => ok);
  console.log(`\n${allPass ? "DEMO PASSED" : "DEMO FAILED"} — relevance detection and an observable decision only; no replanning, no engine involvement.\n`);

  if (JSON_OUT) {
    require("fs").writeFileSync(JSON_OUT, JSON.stringify({ scenario, located, fleet: fleet.map(({ robotId, at, role }) => ({ robotId, at, role })), clearanceM, sameAlgorithm, checks, passedObstacle, timeline }, null, 2));
    console.log(`evidence written to ${JSON_OUT}`);
  }
  return allPass ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`DEMO ERROR: ${error.stack || error.message}`);
    process.exit(2);
  });
