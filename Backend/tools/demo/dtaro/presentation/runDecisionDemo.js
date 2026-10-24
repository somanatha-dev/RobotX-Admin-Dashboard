#!/usr/bin/env node
"use strict";

/**
 * DTARO human-in-the-loop obstacle decisions — the presentation demonstration, on the throwaway
 * stack `setup.ps1` made, started with `start.ps1 -OperatorDecisions` (real server.js, real engine,
 * real simulator; G4 published and pinned; DTARO_OPERATOR_DECISION_ENABLED=true for that process).
 *
 *   node tools/demo/dtaro/presentation/runDecisionDemo.js [--instance <suffix>] [--pause]
 *
 *   --pause     wait for Enter before each step (present it live with the dashboard open: the
 *               decision panel opens there for every report, and this driver decides on the
 *               server's behalf only where a step says so — or leave it alone for the timeout)
 *   --instance  the suffix given to setup.ps1 / start.ps1 -Instance (a second, independent stack)
 *
 * The four decisions, each on a fresh obstacle (another published cell, so none merges):
 *   A. REROUTE chosen by the operator   — affected robots with a safe detour drive it; the others stop
 *   B. REJECT_BROADCAST                 — no recipient robot gets the alert (proved by the robots'
 *                                         own silence: every robot answers every alert it receives)
 *   C. no operator input                — the server applies REROUTE at its 5 s deadline
 *   D. STOP chosen by the operator      — the affected robots stop
 *
 * Nothing is fabricated. Each report is made by a SIMULATED robot commissioned on a scenario obstacle
 * (`rnsit-dtaro-g4-scenario.json`), over its own Socket.IO connection. Every outcome is read from the
 * server's own events on a real SUPER_ADMIN dashboard socket, and checked against an INDEPENDENT
 * oracle: the G4 cell→zone map, each robot's OFFER corridor (read-only SQL) cut at its latest
 * position Observation, H3 cell rings sampled every metre, and the robots' own telemetry trail.
 *
 * Refuses unless the database is the throwaway cluster under %TEMP% (`SHOW data_directory`). Writes
 * only to that database, through the server's API. Prints no credential.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const readline = require("readline");
const { execFileSync } = require("child_process");

const BACKEND = path.resolve(__dirname, "../../../..");
const h3 = require(path.join(BACKEND, "node_modules/h3-js"));
const { io: ioClient } = require(path.join(BACKEND, "node_modules/socket.io-client"));

const ARGS = new Set(process.argv.slice(2));
const INSTANCE = process.argv.includes("--instance") ? process.argv[process.argv.indexOf("--instance") + 1] || "" : "";
const SP = path.join(os.tmpdir(), `robotx-dtaro-presentation${INSTANCE}`);
const PSQL = "C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe";

if (!fs.existsSync(path.join(SP, "demo.json"))) {
  console.error(`No demo stack in ${SP}: run setup.ps1 and start.ps1 -OperatorDecisions first.`);
  process.exit(2);
}
const CFG = JSON.parse(fs.readFileSync(path.join(SP, "demo.json"), "utf8").replace(/^\uFEFF/, ""));
const DB = new URL(CFG.databaseUrl);
const BASE = `http://127.0.0.1:${CFG.apiPort}`;
const ENV = Object.fromEntries(
  fs.readFileSync(CFG.envFile, "utf8").split(/\r?\n/).filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);

const sql = (q) =>
  execFileSync(PSQL, ["-h", DB.hostname, "-p", DB.port, "-U", DB.username, "-d", DB.pathname.slice(1), "-At", "-F", "|", "-c", q], {
    encoding: "utf8",
    env: { ...process.env, PGOPTIONS: "-c default_transaction_read_only=on" },
    // psql on Windows ends lines with CRLF: a trailing \r would make every last field unequal.
  }).replace(/\r/g, "").trim();

function guard() {
  if (!["127.0.0.1", "localhost"].includes(DB.hostname)) throw new Error(`refusing: ${DB.hostname} is not loopback`);
  const dir = path.resolve(sql("show data_directory")).toLowerCase();
  const expected = path.resolve(CFG.dataDirectory).toLowerCase();
  if (dir !== expected || !dir.startsWith(path.resolve(os.tmpdir()).toLowerCase())) {
    throw new Error(`refusing: the database's data directory is ${dir}, not the throwaway ${expected}`);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const log = [];
const note = (...a) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${a.join(" ")}`;
  log.push(line);
  console.log(line);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, label, every = 250) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout: ${label}`);
    await wait(every);
  }
}
async function step(title, expect) {
  console.log(`\n=== ${title}`);
  if (expect) console.log(`    Expected: ${expect}`);
  if (!ARGS.has("--pause")) return;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise((resolve) => rl.question("    (Enter to continue) ", () => { rl.close(); resolve(); }));
}

async function session() {
  const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: ENV.SEED_ADMIN_EMAIL, password: ENV.SEED_ADMIN_PASSWORD }) });
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  if (login.status !== 200 || !cookie) throw new Error(`login failed: HTTP ${login.status}`);
  const api = async (method, url, body) => {
    const r = await fetch(`${BASE}${url}`, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let json;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: r.status, json };
  };
  const events = [];
  const socket = ioClient(BASE, { transports: ["websocket"], reconnection: true, forceNew: true, extraHeaders: { cookie, "user-agent": "Mozilla/5.0 (dtaro decision driver)" } });
  socket.onAny((event, payload) => events.push({ t: Date.now(), event, payload }));
  await new Promise((res, rej) => { socket.once("connect", res); socket.once("connect_error", rej); });
  return { api, events, socket };
}

// ── Campus data and the independent oracle ───────────────────────────────────

const g4 = require(path.join(BACKEND, "tools/campus/rnsitZoneLayoutG4"));
const G4_ZONE = new Map(g4.buildProposal({ context: g4.loadContext() }).cells.map((r) => [r.cellId, r.zoneId]));
const SCENARIO = JSON.parse(fs.readFileSync(path.join(BACKEND, "tools/demo/dtaro/rnsit-dtaro-g4-scenario.json"), "utf8"));
const ACCESS = JSON.parse(fs.readFileSync(path.join(BACKEND, "..", "rnsit-campus-access-candidates.geojson"), "utf8")).features;
const accessPoint = (building) => {
  const f = ACCESS.filter((x) => x.properties.buildingName === building && x.properties.status === "verified").sort((a, b) => (a.properties.id < b.properties.id ? -1 : 1))[0];
  if (!f) throw new Error(`no verified access point for ${building}`);
  return { label: `${building} access`, lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] };
};
const metres = (a, b) => Math.hypot((a.lat - b.lat) * 110574, (a.lon - b.lon) * 108500);
const cellOf = (p) => h3.latLngToCell(p.lat, p.lon, 11);
function insideRing(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p.lat !== yj > p.lat && p.lon < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
/** Metres along the polyline to its first ~1 m sample inside the cell, or null. */
function metresToCell(pts, cellId) {
  const ring = h3.cellToBoundary(cellId, true);
  if (pts.length === 1) return insideRing(pts[0], ring) ? 0 : null;
  let walked = 0;
  for (let i = 1; i < pts.length; i += 1) {
    const a = pts[i - 1];
    const b = pts[i];
    const n = Math.max(1, Math.ceil(metres(a, b)));
    for (let k = 0; k <= n; k += 1) {
      if (insideRing({ lat: a.lat + ((b.lat - a.lat) * k) / n, lon: a.lon + ((b.lon - a.lon) * k) / n }, ring)) return walked + (metres(a, b) * k) / n;
    }
    walked += metres(a, b);
  }
  return null;
}
/** Every ~1 m sample of a polyline lies in a G4 (rnsit) cell and outside the obstacle's cell. */
function pathCheck(pts, cellId) {
  const ring = h3.cellToBoundary(cellId, true);
  let inObstacle = 0;
  let outOfRegion = 0;
  for (let i = 1; i < pts.length; i += 1) {
    const a = pts[i - 1];
    const b = pts[i];
    const n = Math.max(1, Math.ceil(metres(a, b)));
    for (let k = 0; k <= n; k += 1) {
      const p = { lat: a.lat + ((b.lat - a.lat) * k) / n, lon: a.lon + ((b.lon - a.lon) * k) / n };
      if (insideRing(p, ring)) inObstacle += 1;
      if (!G4_ZONE.has(cellOf(p))) outOfRegion += 1;
    }
  }
  return { inObstacle, outOfRegion };
}
function remainingFrom(corridor, at) {
  let best = 0;
  let bestD = Infinity;
  corridor.forEach((p, i) => { const d = metres(p, at); if (d < bestD) { bestD = d; best = i; } });
  return [at, ...corridor.slice(best)];
}

function offers() {
  const rows = sql(`select a."agentId", o."commitmentId", o.payload::text from "Outbox" o join "Agent" a on a.id=o."agentId" join "Commitment" c on c."commitmentId"=o."commitmentId" where o.command='OFFER' and c."releasedAt" is null order by o."createdAt"`);
  const out = {};
  for (const line of rows.split("\n").filter(Boolean)) {
    const [agentId, commitmentId, ...rest] = line.split("|");
    const payload = JSON.parse(rest.join("|"));
    const corridor = [];
    for (const stop of payload.stopSequence || []) corridor.push(...(stop.path || []).filter((x) => typeof x.lat === "number"));
    out[agentId] = { commitmentId, corridor };
  }
  return out;
}
const offerDigests = () => sql(`select o.id, md5(o.payload::text) from "Outbox" o where o.command='OFFER' order by o.id`);
function positions() {
  const rows = sql(`select distinct on (a."agentId") a."agentId", (o.value->>'lat')::float, (o.value->>'lon')::float from "Observation" o join "Agent" a on a.id=o."agentId" where o.kind='position' order by a."agentId", o."observedAt" desc`);
  const out = {};
  for (const line of rows.split("\n").filter(Boolean)) {
    const [id, lat, lon] = line.split("|");
    out[id] = { lat: Number(lat), lon: Number(lon) };
  }
  return out;
}

/** The scenario obstacle whose cell the most robots' remaining commanded routes cross, ahead of them. */
function pickObstacle(usedCells, { minAheadM }) {
  const live = offers();
  const at = positions();
  let best = null;
  for (const o of SCENARIO.obstacles) {
    const cellId = cellOf(o);
    if (usedCells.has(cellId)) continue;
    const crossing = Object.keys(live).filter((id) => at[id] && !/REPORTER/.test(id)).map((id) => ({ id, ahead: metresToCell(remainingFrom(live[id].corridor, at[id]), cellId) })).filter((r) => r.ahead !== null && r.ahead >= minAheadM);
    if (crossing.length && (!best || crossing.length > best.crossing.length)) best = { obstacle: o, cellId, crossing };
  }
  return best;
}

async function commission(api, name, at) {
  const locationId = sql(`select id from "Location" order by id limit 1`);
  const specification = require(path.join(BACKEND, "tools/demo/seedV1Demonstration")).simulatedSpecification();
  const r = await api("POST", "/api/simulator/robot", { name, locationId, lat: at.lat, lon: at.lon, chassisType: "ROVER", specification });
  if (r.status !== 201) throw new Error(`commission ${name}: HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`);
  return r.json.robot.robotId;
}

async function giveWork(s, pairs) {
  for (const [a, b] of pairs) {
    const r = await s.api("POST", "/api/tasks/assign", { regionId: "rnsit", pickup: a.label, pickupLat: a.lat, pickupLon: a.lon, drop: b.label, dropLat: b.lat, dropLon: b.lon });
    note(`task ${a.label} → ${b.label}: HTTP ${r.status} ${r.json?.intake?.outcome || ""}`);
  }
}

// ── Reading the server's decision events ────────────────────────────────────

const DECISION_EVENTS = ["OBSTACLE_DECISION_REQUIRED", "OBSTACLE_DECISION_UPDATED"];
const latestView = (s, decisionId) =>
  s.events.filter((e) => DECISION_EVENTS.includes(e.event) && e.payload.decisionId === decisionId).reduce((best, e) => (!best || e.payload.revision > best.revision ? e.payload : best), null);

/** Cells whose obstacle is still active on the server — including ones a moving robot reported itself. */
const activeCells = () => new Set(sql(`select "cellId" from "DtaroObstacleDecision" where "expiresAt" > now() at time zone 'UTC'`).split("\n").filter(Boolean));

/**
 * Pick a fresh obstacle ahead of a moving robot and have a commissioned reporter report it. A
 * robot driving past a scenario obstacle may report it first (a genuine report, with its own
 * decision): such a cell is skipped, and a report that merges into one is retried elsewhere.
 */
async function freshReport(s, name, usedCells, minAheadM) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    for (const cell of activeCells()) usedCells.add(cell);
    const pick = await until(() => pickObstacle(usedCells, { minAheadM }), 120_000, "an obstacle ahead of a moving robot");
    usedCells.add(pick.cellId);
    const r = await report(s, `${name}${attempt ? `-${attempt}` : ""}`, pick);
    if (r) return r;
    note(`the report of ${pick.obstacle.id} merged into an obstacle already active in that cell; trying another cell`);
  }
  throw new Error("every candidate cell already held an active obstacle");
}

async function report(s, name, pick) {
  const before = s.events.length;
  const snapshot = { offers: offers(), positions: positions(), at: Date.now() };
  const robotId = await commission(s.api, name, { lat: pick.obstacle.lat, lon: pick.obstacle.lon });
  note(`simulated reporter ${name} (${robotId}) commissioned on ${pick.obstacle.id} (${pick.obstacle.zone}); it senses the obstacle and reports it`);
  const outcome = await until(
    () => s.events.slice(before).find((e) => (e.event === "OBSTACLE_DECISION_REQUIRED" && e.payload.reporter?.robotId === robotId) || (e.event === "OBSTACLE_REPORT_MERGED" && e.payload.reportingRobotId === robotId)),
    60_000,
    `the decision for ${pick.obstacle.id}`,
  );
  if (outcome.event === "OBSTACLE_REPORT_MERGED") return null;
  const view = outcome.payload;
  note(`decision ${view.decisionId} REQUIRED: obstacle ${view.obstacle.obstacleId} in ${view.obstacle.zoneId}/${view.obstacle.regionId}, deadline ${view.deadlineAt} (${Date.parse(view.deadlineAt) - Date.parse(view.receivedAt)} ms after acceptance)`);
  console.table(view.robots.map((r) => ({ robot: r.robotId, role: r.role, affected: r.affected, why: r.affectedReason, state: r.state, task: r.taskId || "-", origin: r.origin?.name || "-", destination: r.destination?.name || "-" })));
  return { robotId, view, snapshot, requiredAt: outcome.t, before };
}

async function decide(s, decisionId, decision, key) {
  return s.api("POST", `/api/dtaro/decisions/${decisionId}`, { decision, idempotencyKey: key });
}

/** Checks every decision shares: the panel event, the oracle, nothing sent before the decision. */
function commonChecks(check, s, r) {
  const v = r.view;
  check(`${r.label}: the decision panel event came from the server, deadline = acceptance + 5 s`, Date.parse(v.deadlineAt) - Date.parse(v.receivedAt) === 5000 && v.provenance === "SIMULATED");
  check(`${r.label}: obstacle cell and zone agree with the independent G4 lookup`, v.obstacle.zoneId === G4_ZONE.get(v.obstacle.cellId) && v.obstacle.cellId === cellOf(v.obstacle));
  // Oracle: a robot whose remaining corridor (at the snapshot) crosses the cell ≥ 25 m ahead must
  // be affected; a robot whose whole corridor never meets the cell must not be.
  const rows = [];
  for (const robot of v.robots) {
    const offer = r.snapshot.offers[robot.robotId];
    const pos = r.snapshot.positions[robot.robotId];
    if (!offer || robot.role === "REPORTER") continue;
    if (robot.onDetourFrom) {
      // Driving a detour from an earlier decision: judged on that detour (independently sampled),
      // not on the commanded corridor it has left. A crossing detour must make it affected.
      const earlier = latestView(s, robot.onDetourFrom);
      const detour = earlier && (earlier.robots.find((x) => x.robotId === robot.robotId) || {}).execution;
      const ahead = detour && pos ? metresToCell(remainingFrom(detour.alternatePath, pos), v.obstacle.cellId) : null;
      if (ahead !== null) rows.push({ robot: robot.robotId, oracle: true, server: robot.affected, on: "detour" });
      else if (detour && metresToCell(detour.alternatePath, v.obstacle.cellId) === null && metresToCell(offer.corridor, v.obstacle.cellId) === null) rows.push({ robot: robot.robotId, oracle: false, server: robot.affected, on: "detour" });
      continue;
    }
    const ahead = pos ? metresToCell(remainingFrom(offer.corridor, pos), v.obstacle.cellId) : null;
    const ever = metresToCell(offer.corridor, v.obstacle.cellId);
    if (ahead !== null && ahead >= 25) rows.push({ robot: robot.robotId, oracle: true, server: robot.affected });
    else if (ever === null) rows.push({ robot: robot.robotId, oracle: false, server: robot.affected });
  }
  check(`${r.label}: affected robots agree with the independent corridor oracle`, rows.every((x) => x.oracle === x.server), JSON.stringify(rows));
  const early = s.events.slice(r.before).filter((e) => e.t < (r.decidedAt || Infinity) && (e.event === "ALERT_CREATED" || e.event === "OBSTACLE_RELEVANCE") && e.payload.obstacleId === v.obstacle.obstacleId);
  check(`${r.label}: no fleet alert and no robot verdict before the decision`, early.length === 0, `${early.length}`);
}

async function finalView(s, decisionId, ms) {
  return until(() => {
    const v = latestView(s, decisionId);
    return v && ["COMPLETED", "EXPIRED"].includes(v.status) ? v : null;
  }, ms, `decision ${decisionId} to finish`, 500).catch(() => latestView(s, decisionId));
}

function verdictsFor(s, obstacleId) {
  return s.events.filter((e) => e.event === "OBSTACLE_RELEVANCE" && e.payload.obstacleId === obstacleId).map((e) => e.payload.robotId);
}

/** The robots' own telemetry trail (robot:update) since `fromT`. */
function trailOf(s, robotId, fromT) {
  return s.events.filter((e) => e.event === "robot:update" && e.t >= fromT && e.payload.robotId === robotId && Number.isFinite(e.payload.lat)).map((e) => ({ lat: e.payload.lat, lon: e.payload.lon, status: e.payload.status }));
}

// ── The demonstration ─────────────────────────────────────────────────────────

(async () => {
  guard();
  const s = await session();
  const checks = [];
  const check = (name, ok, detail = "") => { checks.push({ name, ok: Boolean(ok), detail }); note(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? ` — ${detail}` : ""}`); };
  const evidence = { startedAt: new Date().toISOString(), log, checks, decisions: {} };
  // A cell whose obstacle is still active (an earlier run on this stack) would merge, not decide.
  const usedCells = new Set(sql(`select "cellId" from "DtaroObstacleDecision" where "expiresAt" > now() at time zone 'UTC'`).split("\n").filter(Boolean));

  await step("1. The server: G4 published, zone alerts on, OPERATOR DECISIONS on (simulated fleet only)");
  const campuses = (await s.api("GET", "/api/campuses")).json?.campuses || [];
  let rnsit = campuses.find((c) => c.code === "RNSIT");
  if (!rnsit) {
    const created = await s.api("POST", "/api/campuses", { code: "RNSIT", name: "RNS Institute of Technology", centerLat: 12.9016, centerLon: 77.5183 });
    rnsit = created.json?.campus || created.json;
  }
  if (rnsit && rnsit.id) await s.api("PUT", `/api/campuses/${rnsit.id}/region`, { regionId: "rnsit" });
  const zones = (await s.api("GET", "/api/dtaro/zones")).json;
  note(`config v${zones.configVersion}; ${(zones.zones || []).length} zones; alerts ${zones.alertsEnabled ? "ON" : "OFF"}; operator decisions ${zones.operatorDecisionsEnabled ? "ON" : "OFF"}`);
  if (zones.operatorDecisionsEnabled !== true) {
    console.error("Operator decisions are off on this server: restart it with start.ps1 -OperatorDecisions.");
    process.exit(2);
  }
  check("G4 served (four zones), alerts and operator decisions on", zones.alertsEnabled === true && (zones.zones || []).length === 4);

  await step("2. Give the simulated fleet work, so robots have commanded routes", "OFFERs for several robots");
  const A = (b) => accessPoint(b);
  await giveWork(s, [
    [A("CSE, ISE & CSDS Department"), A("RNSIT MBA block")],
    [A("RNS International School"), A("RNSIT Mec and EEE Department")],
    [A("ECE Department"), A("RNSIT Civil and AIML Block")],
    [A("RNSIT MBA block"), A("RNS International School")],
  ]);
  await until(() => Object.keys(offers()).length >= 3, 180_000, "live OFFERs").catch(() => note(`only ${Object.keys(offers()).length} OFFERs so far`));
  const digestsBefore = offerDigests();
  note(`robots with a live commanded route: ${Object.keys(offers()).join(", ")}`);

  // ── A. REROUTE chosen by the operator ────────────────────────────────────
  await step("3. Decision A — the operator chooses REROUTE", "affected robots with a safe detour drive it around the obstacle's cell; robots without one stop, with the reason");
  const a = { label: "A (REROUTE)", ...(await freshReport(s, "DECISION-REPORTER-A", usedCells, 60)) };
  await until(() => (latestView(s, a.view.decisionId).robots || []).filter((r) => r.affected).every((r) => r.preview), 3500, "previews").catch(() => note("decided before every preview arrived"));
  const keyA = crypto.randomUUID();
  const resA = await decide(s, a.view.decisionId, "REROUTE", keyA);
  a.decidedAt = Date.now();
  check("A: the operator's REROUTE is committed (HTTP 200)", resA.status === 200 && resA.json.outcome === "COMMITTED", `${resA.status} ${JSON.stringify(resA.json).slice(0, 200)}`);
  const retryA = await decide(s, a.view.decisionId, "REROUTE", keyA);
  check("A: a retried request (same key) returns the committed result", retryA.status === 200 && retryA.json.outcome === "ALREADY_COMMITTED");
  const conflictA = await decide(s, a.view.decisionId, "STOP", crypto.randomUUID());
  check("A: a conflicting second decision is refused (409)", conflictA.status === 409 && conflictA.json.committed?.choice === "REROUTE");
  commonChecks(check, s, a);
  await until(() => s.events.some((e) => e.event === "ALERT_CREATED" && e.payload.decisionId === a.view.decisionId), 20_000, "the decided alert").catch(() => {});
  const createdA = s.events.find((e) => e.event === "ALERT_CREATED" && e.payload.decisionId === a.view.decisionId);
  check("A: the fleet alert went out after the decision, carrying it", Boolean(createdA) && createdA.payload.decision === "REROUTE");
  await wait(4000);
  const verdictsA = verdictsFor(s, a.view.obstacle.obstacleId);
  check("A: robot verdicts come only from the delivered recipients", createdA && verdictsA.every((id) => createdA.payload.recipients.includes(id)), verdictsA.join(","));
  const viewA = latestView(s, a.view.decisionId);
  const rerouted = viewA.robots.filter((r) => r.execution && ["REROUTING", "MOVING", "COMPLETED"].includes(r.execution.state));
  const stoppedA = viewA.robots.filter((r) => r.execution && /STOPPED|NO_SAFE_ROUTE/.test(r.execution.state));
  note(`A: rerouting ${rerouted.map((r) => r.robotId).join(", ") || "none"}; stopped (no safe route) ${stoppedA.map((r) => `${r.robotId}:${r.execution.reason}`).join(", ") || "none"}`);
  for (const r of rerouted) {
    const c = pathCheck(r.execution.alternatePath, a.view.obstacle.cellId);
    check(`A: ${r.robotId}'s alternate route avoids the obstacle cell and stays in the RNSIT region (1 m samples)`, c.inObstacle === 0 && c.outOfRegion === 0, JSON.stringify(c));
  }
  for (const r of stoppedA) check(`A: ${r.robotId} without a safe alternate route is stopped, with the reason`, r.execution.state === "STOPPED_NO_SAFE_ROUTE" && Boolean(r.execution.reason));
  if (rerouted.length) {
    // The seeded robots drive at their commissioned walking speed, so a detour takes minutes: the
    // driver checks it has started (server-measured progress, the robot's own fixes) and comes back
    // for the arrival after the other decisions.
    await until(() => latestView(s, a.view.decisionId).robots.some((r) => r.execution && ["MOVING", "COMPLETED"].includes(r.execution.state)), 60_000, "a rerouted robot moving").catch(() => {});
    const movingA = latestView(s, a.view.decisionId).robots.filter((r) => r.execution && ["MOVING", "COMPLETED"].includes(r.execution.state));
    check("A: the rerouted robot is moving along its alternate route (server-measured progress)", movingA.length > 0, movingA.map((r) => `${r.robotId}:${JSON.stringify(r.execution.progress)}`).join(" "));
  } else {
    note("A: no affected robot had a safe alternate route on this campus for this obstacle (honest outcome; every one was stopped)");
    evidence.decisions.A = await finalView(s, a.view.decisionId, 30_000);
  }

  // ── B. REJECT_BROADCAST ──────────────────────────────────────────────────
  await giveWork(s, [[A("ECE Department"), A("RNSIT MBA block")], [A("RNSIT Civil and AIML Block"), A("CSE, ISE & CSDS Department")]]);
  await step("4. Decision B — the operator REJECTS the broadcast", "no robot receives the obstacle alert; the suppression and its recipients are recorded");
  const b = { label: "B (REJECT_BROADCAST)", ...(await freshReport(s, "DECISION-REPORTER-B", usedCells, 40)) };
  const resB = await decide(s, b.view.decisionId, "REJECT_BROADCAST", crypto.randomUUID());
  b.decidedAt = Date.now();
  check("B: REJECT_BROADCAST is committed", resB.status === 200);
  commonChecks(check, s, b);
  const doneB = await finalView(s, b.view.decisionId, 30_000);
  await wait(8000);
  check("B: the suppression is recorded with the robots it was withheld from", doneB.propagation?.outcome === "SUPPRESSED" && Array.isArray(doneB.propagation.suppressedRecipients), JSON.stringify(doneB.propagation));
  check("B: no ALERT_CREATED for the obstacle", !s.events.some((e) => e.event === "ALERT_CREATED" && e.payload.obstacleId === b.view.obstacle.obstacleId));
  check("B: no robot answered an alert for it — no robot received one (robot-side evidence)", verdictsFor(s, b.view.obstacle.obstacleId).length === 0, verdictsFor(s, b.view.obstacle.obstacleId).join(","));
  const logB = fs.existsSync(path.join(SP, "server.log")) ? fs.readFileSync(path.join(SP, "server.log"), "utf8") : "";
  check("B: the server log shows no OBSTACLE_ALERT delivery for it", !new RegExp(`OBSTACLE_ALERT delivered[^\\n]*${b.view.obstacle.obstacleId}`).test(logB));
  evidence.decisions.B = doneB;

  // ── C. No operator: the server's default ─────────────────────────────────
  await giveWork(s, [[A("RNS International School"), A("ECE Department")]]);
  await step("5. Decision C — nobody decides", "at 5 s the SERVER applies REROUTE, labelled as its default; a late click is refused");
  const c = { label: "C (server default)", ...(await freshReport(s, "DECISION-REPORTER-C", usedCells, 40)) };
  const decidedC = await until(() => latestView(s, c.view.decisionId)?.decision, 10_000, "the default", 100);
  c.decidedAt = Date.parse(decidedC.decidedAt);
  check("C: the server applied REROUTE as its default at the deadline", decidedC.choice === "REROUTE" && decidedC.source === "DEFAULT_TIMEOUT" && Date.parse(decidedC.decidedAt) >= Date.parse(c.view.deadlineAt) && Date.parse(decidedC.decidedAt) - Date.parse(c.view.deadlineAt) < 1000, JSON.stringify(decidedC));
  const lateC = await decide(s, c.view.decisionId, "STOP", crypto.randomUUID());
  check("C: a late manual decision is refused (409) and changes nothing", lateC.status === 409 && lateC.json.committed?.source === "DEFAULT_TIMEOUT");
  commonChecks(check, s, c);
  evidence.decisions.C = await finalView(s, c.view.decisionId, 60_000);

  // ── D. STOP chosen by the operator ───────────────────────────────────────
  await giveWork(s, [[A("RNSIT Mec and EEE Department"), A("RNSIT MBA block")]]);
  await step("6. Decision D — the operator chooses STOP", "every affected robot stops (PAUSED); unaffected robots carry on");
  const dReport = await freshReport(s, "DECISION-REPORTER-D", usedCells, 40).catch((e) => { note(`D: ${e.message}`); return null; });
  if (dReport) {
    const d = { label: "D (STOP)", ...dReport };
    const resD = await decide(s, d.view.decisionId, "STOP", crypto.randomUUID());
    d.decidedAt = Date.now();
    check("D: STOP is committed", resD.status === 200);
    commonChecks(check, s, d);
    const doneD = await finalView(s, d.view.decisionId, 30_000);
    const targets = doneD.robots.filter((r) => r.execution);
    check("D: every affected robot was stopped", targets.length > 0 && targets.every((r) => r.execution.state === "STOPPED"), targets.map((r) => `${r.robotId}:${r.execution.state}`).join(","));
    check("D: only affected robots were instructed", doneD.robots.filter((r) => r.execution).every((r) => r.affected));
    await wait(5000);
    for (const r of targets) {
      const trail = trailOf(s, r.robotId, d.decidedAt + 3000);
      check(`D: ${r.robotId} reports itself stopped and does not move`, trail.length > 0 && trail.every((p) => p.status === "PAUSED") && metres(trail[0], trail[trail.length - 1]) < 0.5, `${trail.length} fixes`);
    }
    evidence.decisions.D = doneD;
  } else note("D skipped: no further obstacle ahead of a moving robot within 120 s");

  // ── A, continued: the detour's arrival ───────────────────────────────────
  if (rerouted.length) {
    await step("7. Decision A, continued — the rerouted robot arrives", "the server marks its reroute COMPLETED; its trail never entered the obstacle's cell");
    const doneA = await until(
      () => {
        const v = latestView(s, a.view.decisionId);
        const states = rerouted.map((r) => v.robots.find((x) => x.robotId === r.robotId).execution.state);
        return states.every((st) => st === "COMPLETED") ? v : null;
      },
      20 * 60_000,
      "the rerouted robots to arrive",
      2000,
    ).catch(() => latestView(s, a.view.decisionId));
    const ring = h3.cellToBoundary(a.view.obstacle.cellId, true);
    for (const r of rerouted) {
      const final = doneA.robots.find((x) => x.robotId === r.robotId);
      const trail = trailOf(s, r.robotId, a.decidedAt);
      const end = final.execution.alternatePath[final.execution.alternatePath.length - 1];
      check(`A: ${r.robotId} drove its alternate route (${trail.length} fixes), never inside the obstacle cell, and arrived`,
        final.execution.state === "COMPLETED" && trail.length > 3 && !trail.some((p) => insideRing(p, ring)) && metres(trail[trail.length - 1], end) < 1,
        `${final.execution.state}, ${trail.length} fixes, ${trail.length ? metres(trail[trail.length - 1], end).toFixed(1) : "?"} m from the end`);
    }
    evidence.decisions.A = doneA;
  }

  // ── Whole run ────────────────────────────────────────────────────────────
  await step("8. Nothing in the engine changed: commanded routes, no reroute command; every decision audited");
  const digestsAfter = offerDigests();
  check("every OFFER row (commanded route) present before is byte-identical", digestsBefore.split("\n").filter(Boolean).every((line) => digestsAfter.includes(line)));
  const reroutes = Number(sql(`select count(*) from "Outbox" where command in ('REROUTE','RESEQUENCE')`));
  check("no REROUTE or RESEQUENCE engine command exists", reroutes === 0, `${reroutes}`);
  const rows = sql(`select "decisionId", status, decision, "decisionSource" from "DtaroObstacleDecision" order by "receivedAt"`).split("\n").filter(Boolean).map((l) => l.split("|"));
  console.table(rows.map(([id, status, decision, source]) => ({ id: id.slice(0, 8), status, decision, source })));
  const expectedSources = { [a.view.decisionId]: ["REROUTE", "MANUAL"], [b.view.decisionId]: ["REJECT_BROADCAST", "MANUAL"], [c.view.decisionId]: ["REROUTE", "DEFAULT_TIMEOUT"] };
  check("each decision's audit row holds its choice and its source", Object.entries(expectedSources).every(([id, [dec, src]]) => rows.some((r) => r[0] === id && r[2] === dec && r[3] === src)));
  const restore = (await s.api("GET", "/api/dtaro/decisions")).json;
  check("a reconnecting dashboard restores every decision (GET /api/dtaro/decisions)", [a, b, c].every((x) => restore.decisions.some((d) => d.decisionId === x.view.decisionId && d.deadlineAt === x.view.deadlineAt)));
  const errLog = fs.existsSync(path.join(SP, "server.err.log")) ? fs.readFileSync(path.join(SP, "server.err.log"), "utf8").trim() : "";
  check("no server errors on stderr", errLog === "", errLog.slice(0, 300));

  const failed = checks.filter((x) => !x.ok);
  evidence.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(SP, "decision-demo-evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(`\n${failed.length === 0 ? "DEMO PASSED" : "DEMO FAILED"}: ${checks.length - failed.length}/${checks.length} checks. Evidence: ${path.join(SP, "decision-demo-evidence.json")}`);
  console.log("Stopped simulated robots stay PAUSED (the simulator's own stop); release one with RESUME from its robot page.");
  s.socket.close();
  process.exit(failed.length === 0 ? 0 : 1);
})().catch((e) => {
  console.error("DEMO ERROR:", e.message);
  process.exit(1);
});
