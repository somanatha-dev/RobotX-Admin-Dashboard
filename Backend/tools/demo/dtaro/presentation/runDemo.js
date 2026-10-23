#!/usr/bin/env node
"use strict";

/**
 * DTARO obstacle alerts — the presentation demonstration, on the throwaway stack that `setup.ps1`
 * and `start.ps1` made (real server.js, real engine, real simulator; G4 published and pinned).
 *
 *   node tools/demo/dtaro/presentation/runDemo.js [--pause] [--expiry]
 *
 *   --pause   wait for Enter before each step (for presenting live, with the dashboard open)
 *   --expiry  also wait out the obstacle lifetime (5 min) and show a fresh report alerts again
 *
 * Nothing is fabricated. Every obstacle is reported by a SIMULATED robot commissioned on a scenario
 * obstacle (`rnsit-dtaro-g4-scenario.json`): it senses the obstacle on its first tick and sends a
 * real OBSTACLE_REPORT over its own Socket.IO connection. Every recipient and verdict is read from
 * the server's own events, received by a real dashboard socket. An INDEPENDENT oracle (G4
 * cell→zone lookup, 1 m sampling of each robot's remaining OFFER corridor) states who should be
 * alerted, and the driver checks the server against it. Physical robots take no part.
 *
 * Refuses unless the database is the throwaway cluster `setup.ps1` initialised under %TEMP%
 * (its own `SHOW data_directory`). Writes only to that database, through the server's API.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { execFileSync } = require("child_process");

const BACKEND = path.resolve(__dirname, "../../../..");
const h3 = require(path.join(BACKEND, "node_modules/h3-js"));
const { io: ioClient } = require(path.join(BACKEND, "node_modules/socket.io-client"));

const SP = path.join(os.tmpdir(), "robotx-dtaro-presentation");
const PSQL = "C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe";
const ARGS = new Set(process.argv.slice(2));

// ── Configuration and the disposable-target guard ─────────────────────────────

if (!fs.existsSync(path.join(SP, "demo.json"))) {
  console.error("No demo stack: run tools/demo/dtaro/presentation/setup.ps1 and start.ps1 first.");
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
  }).trim();

function guard() {
  if (!["127.0.0.1", "localhost"].includes(DB.hostname)) throw new Error(`refusing: ${DB.hostname} is not loopback`);
  const dir = path.resolve(sql("show data_directory")).toLowerCase();
  const expected = path.resolve(CFG.dataDirectory).toLowerCase();
  if (dir !== expected || !dir.startsWith(path.resolve(os.tmpdir()).toLowerCase())) {
    throw new Error(`refusing: the database's data directory is ${dir}, not the throwaway ${expected}`);
  }
}

// ── Small helpers ─────────────────────────────────────────────────────────────

const log = [];
const note = (...a) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${a.join(" ")}`;
  log.push(line);
  console.log(line);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, label) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout: ${label}`);
    await wait(500);
  }
}
async function step(title) {
  console.log(`\n=== ${title}`);
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
  const socket = ioClient(BASE, { transports: ["websocket"], reconnection: false, forceNew: true, extraHeaders: { cookie, "user-agent": "Mozilla/5.0 (dtaro presentation driver)" } });
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
const zoneOfPoint = (p) => G4_ZONE.get(h3.latLngToCell(p.lat, p.lon, 11)) || null;
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
function remainingFrom(corridor, at) {
  let best = 0;
  let bestD = Infinity;
  corridor.forEach((p, i) => { const d = metres(p, at); if (d < bestD) { bestD = d; best = i; } });
  return [at, ...corridor.slice(best)];
}

/** Each robot's live OFFER corridor (the server's commanded route), read-only. */
function offers() {
  const rows = sql(`select a."agentId", o."commitmentId", md5(o.payload::text), o.payload::text from "Outbox" o join "Agent" a on a.id=o."agentId" join "Commitment" c on c."commitmentId"=o."commitmentId" where o.command='OFFER' and c."releasedAt" is null order by o."createdAt"`);
  const out = {};
  for (const line of rows.split("\n").filter(Boolean)) {
    const [agentId, commitmentId, md5, ...rest] = line.split("|");
    const payload = JSON.parse(rest.join("|"));
    const corridor = [];
    for (const stop of payload.stopSequence || []) corridor.push(...(stop.path || []).filter((x) => typeof x.lat === "number"));
    out[agentId] = { commitmentId, md5, corridor };
  }
  return out;
}
const offerDigests = () => sql(`select o.id, md5(o.payload::text) from "Outbox" o where o.command='OFFER' order by o.id`);
/** Latest accepted position of every agent, from the append-only Observation record. */
function positions() {
  const rows = sql(`select distinct on (a."agentId") a."agentId", (o.value->>'lat')::float, (o.value->>'lon')::float from "Observation" o join "Agent" a on a.id=o."agentId" where o.kind='position' order by a."agentId", o."observedAt" desc`);
  const out = {};
  for (const line of rows.split("\n").filter(Boolean)) {
    const [id, lat, lon] = line.split("|");
    out[id] = { lat: Number(lat), lon: Number(lon) };
  }
  return out;
}

/** The scenario obstacle whose report shows the most cases right now (a cross-zone recipient required). */
function pickObstacle(exclude, { minAheadM }) {
  const live = offers();
  const robots = Object.entries(positions()).filter(([id, p]) => zoneOfPoint(p) && !/REPORTER/.test(id)).map(([id, p]) => ({ id, p, zone: zoneOfPoint(p) }));
  let best = null;
  for (const o of SCENARIO.obstacles) {
    if (exclude.has(o.id)) continue;
    const same = robots.filter((r) => r.zone === o.zone).map((r) => r.id);
    const cross = [];
    const unrelated = [];
    for (const r of robots) {
      if (r.zone === o.zone) continue;
      if (!live[r.id]) { unrelated.push(r.id); continue; }
      const ahead = metresToCell(remainingFrom(live[r.id].corridor, r.p), o.cellId);
      if (ahead !== null && ahead >= minAheadM) cross.push({ id: r.id, aheadM: Math.round(ahead) });
      else if (metresToCell(live[r.id].corridor, o.cellId) === null) unrelated.push(r.id);
    }
    const score = (cross.length > 0) * 4 + (same.length > 0) * 2 + (unrelated.length > 0) * 1;
    if (cross.length && (!best || score > best.score)) best = { obstacle: o, score, same, cross, unrelated };
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

async function report(s, name, obstacle, offset = { lat: 0, lon: 0 }) {
  const kinds = ["ALERT_CREATED", "OBSTACLE_REPORT_MERGED", "OBSTACLE_REPORT_REJECTED"];
  const before = s.events.filter((e) => kinds.includes(e.event)).length;
  const snapshot = { offers: offers(), positions: positions() };
  const robotId = await commission(s.api, name, { lat: obstacle.lat + offset.lat, lon: obstacle.lon + offset.lon });
  note(`simulated reporter ${name} (${robotId}) commissioned on ${obstacle.id} in ${obstacle.zone}; it senses the obstacle and reports it`);
  const ev = await until(() => s.events.filter((e) => kinds.includes(e.event))[before], 60_000, `the report of ${obstacle.id}`);
  return { robotId, ev, ...snapshot };
}

function evaluate(s, label, r) {
  const alert = r.ev.payload;
  const verdicts = s.events.filter((e) => e.event === "OBSTACLE_RELEVANCE" && e.payload.obstacleId === alert.obstacleId).map((e) => e.payload);
  const rows = alert.recipientDecisions.map((d) => {
    const pos = r.positions[d.robotId];
    const offer = r.offers[d.robotId];
    let expected;
    if (d.relation === "REPORTER" || d.relation === "OTHER_REGION") expected = false;
    else if (d.zoneId === alert.zoneId) expected = true;
    else if (!offer) expected = false;
    else expected = metresToCell(pos ? remainingFrom(offer.corridor, pos) : offer.corridor, alert.cellId) !== null;
    const v = verdicts.find((x) => x.robotId === d.robotId);
    return {
      robot: d.robotId,
      zone: d.zoneId,
      why: d.reason,
      oracle: expected,
      server: d.alerted,
      route: d.route ? `${d.route.status}${d.route.cut ? `/${d.route.cut}` : ""}` : "-",
      verdict: v ? (v.relevant ? "RELEVANT" : `not relevant (${v.decision})`) : d.alerted ? "pending" : "-",
      agrees: expected === d.alerted,
    };
  });
  note(`${label}: ${alert.obstacleId} in ${alert.zoneId} (oracle: ${G4_ZONE.get(alert.cellId)}); same zone: ${alert.sameZoneRecipients.join(", ") || "none"}; cross-zone: ${alert.crossZoneRecipients.join(", ") || "none"}`);
  console.table(rows.map(({ agrees, ...row }) => ({ ...row, agrees: agrees ? "yes" : "NO" })));
  return {
    obstacleId: alert.obstacleId,
    zoneId: alert.zoneId,
    zoneAgrees: alert.zoneId === G4_ZONE.get(alert.cellId),
    recipients: alert.recipients,
    crossZoneRecipients: alert.crossZoneRecipients,
    expiresAt: alert.expiresAt,
    oracleAgrees: rows.every((x) => x.agrees),
    verdictsFromRecipientsOnly: verdicts.every((v) => alert.recipients.includes(v.robotId)),
    unrelatedNotAlerted: rows.filter((x) => !x.oracle).every((x) => !x.server),
    rows,
  };
}

// ── The demonstration ─────────────────────────────────────────────────────────

(async () => {
  guard();
  const s = await session();
  const checks = [];
  const check = (name, ok, detail = "") => { checks.push({ name, ok: Boolean(ok), detail }); note(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`); };
  const evidence = { startedAt: new Date().toISOString(), log, checks };

  await step("1. The published map: G4, four RNSIT zones (DTARO_ZONE_ALERTS_ENABLED=true on this stack)");
  const campuses = (await s.api("GET", "/api/campuses")).json?.campuses || [];
  let rnsit = campuses.find((c) => c.code === "RNSIT");
  if (!rnsit) {
    const created = await s.api("POST", "/api/campuses", { code: "RNSIT", name: "RNS Institute of Technology", centerLat: 12.9016, centerLon: 77.5183 });
    rnsit = created.json?.campus || created.json;
    note(`campus row RNSIT created (HTTP ${created.status})`);
  }
  if (rnsit && rnsit.id) await s.api("PUT", `/api/campuses/${rnsit.id}/region`, { regionId: "rnsit" });
  const zones = (await s.api("GET", "/api/dtaro/zones")).json;
  evidence.servedMap = { configVersion: zones.configVersion, alertsEnabled: zones.alertsEnabled, zones: (zones.zones || []).map((z) => `${z.zoneId} (${z.cellCount} cells)`) };
  note(`server serves config v${zones.configVersion}: ${evidence.servedMap.zones.join(", ")}; alerts ${zones.alertsEnabled ? "ON" : "OFF"}`);
  check("G4 is served: four zones, 64 cells, alerts on", zones.alertsEnabled === true && (zones.zones || []).length === 4 && (zones.zones || []).reduce((n, z) => n + z.cellCount, 0) === 64);

  await step("2. Give the simulated fleet work, so robots have commanded routes that cross zones");
  const TASKS = [
    [accessPoint("CSE, ISE & CSDS Department"), accessPoint("RNSIT MBA block")],
    [accessPoint("RNS International School"), accessPoint("RNSIT Mec and EEE Department")],
    [accessPoint("ECE Department"), accessPoint("RNSIT Civil and AIML Block")],
    [accessPoint("RNSIT MBA block"), accessPoint("RNS International School")],
  ];
  for (const [a, b] of TASKS) {
    const r = await s.api("POST", "/api/tasks/assign", { regionId: "rnsit", pickup: a.label, pickupLat: a.lat, pickupLon: a.lon, drop: b.label, dropLat: b.lat, dropLon: b.lon });
    note(`task ${a.label} (${zoneOfPoint(a)}) → ${b.label} (${zoneOfPoint(b)}): HTTP ${r.status} ${r.json?.intake?.outcome || ""}`);
  }
  await until(() => Object.keys(offers()).length >= 3, 180_000, "live OFFERs").catch(() => note(`only ${Object.keys(offers()).length} OFFERs so far`));
  const digestsBefore = offerDigests();
  note(`robots with a live commanded route (OFFER): ${Object.keys(offers()).join(", ")}`);

  await step("3. Report 1: a simulated robot reports an obstacle; the server picks recipients");
  const pick1 = await until(() => { const p = pickObstacle(new Set(), { minAheadM: 40 }); return p && p.score >= 6 ? p : null; }, 120_000, "a cross-zone case").catch(() => pickObstacle(new Set(), { minAheadM: 20 }));
  if (!pick1) throw new Error("no scenario obstacle currently gives a cross-zone case; wait for the robots to move and run again");
  note(`oracle expects: same zone ${pick1.same.join(", ") || "none"}; cross-zone ${pick1.cross.map((c) => `${c.id} (${c.aheadM} m ahead)`).join(", ")}; not alerted ${pick1.unrelated.join(", ") || "none"}`);
  const r1 = await report(s, "OBSTACLE-REPORTER-1", pick1.obstacle);
  await until(() => s.events.filter((e) => e.event === "OBSTACLE_RELEVANCE" && e.payload.obstacleId === r1.ev.payload.obstacleId).length >= r1.ev.payload.recipients.length, 30_000, "verdicts").catch(() => note("not every verdict arrived in 30 s"));
  const e1 = evaluate(s, "Report 1", r1);
  evidence.report1 = e1;
  check("report 1 was delivered (ALERT_CREATED over the dashboard socket)", r1.ev.event === "ALERT_CREATED");
  check("report 1: obstacle zone matches the independent G4 lookup", e1.zoneAgrees);
  check("report 1: every alerted/not-alerted decision matches the oracle", e1.oracleAgrees);
  check("report 1: at least one cross-zone recipient (remaining commanded route)", e1.crossZoneRecipients.length > 0, e1.crossZoneRecipients.join(", "));
  check("report 1: unrelated robots were not alerted", e1.unrelatedNotAlerted);
  check("report 1: verdicts came only from recipients", e1.verdictsFromRecipientsOnly);

  await step("4. A second simulated robot reports the SAME obstacle: merged, not re-broadcast");
  const createdBefore = s.events.filter((e) => e.event === "ALERT_CREATED").length;
  const verdictsBefore = s.events.filter((e) => e.event === "OBSTACLE_RELEVANCE").length;
  const dup = await report(s, "OBSTACLE-REPORTER-1B", pick1.obstacle, { lat: 0.000018, lon: 0 });
  await wait(3000);
  check("duplicate merged into report 1", dup.ev.event === "OBSTACLE_REPORT_MERGED" && dup.ev.payload.obstacleId === e1.obstacleId, dup.ev.event);
  check("duplicate created no new alert and no new verdicts",
    s.events.filter((e) => e.event === "ALERT_CREATED").length === createdBefore && s.events.filter((e) => e.event === "OBSTACLE_RELEVANCE").length === verdictsBefore);

  await step("5. Report 2: an obstacle in another zone");
  const used = new Set(SCENARIO.obstacles.filter((o) => o.zone === pick1.obstacle.zone).map((o) => o.id));
  const pick2 = await until(() => pickObstacle(used, { minAheadM: 30 }), 90_000, "a second case").catch(() => null);
  if (pick2) {
    const r2 = await report(s, "OBSTACLE-REPORTER-2", pick2.obstacle);
    await until(() => s.events.filter((e) => e.event === "OBSTACLE_RELEVANCE" && e.payload.obstacleId === r2.ev.payload.obstacleId).length >= r2.ev.payload.recipients.length, 30_000, "verdicts").catch(() => note("not every verdict arrived in 30 s"));
    const e2 = evaluate(s, "Report 2", r2);
    evidence.report2 = e2;
    check("report 2: zone and every decision match the oracle", e2.zoneAgrees && e2.oracleAgrees);
  } else note("report 2 skipped: no second cross-zone case arose in 90 s");

  await step("6. Alerts change nothing in the engine: no reroute, no route rewritten");
  const digestsAfter = offerDigests();
  const reroutes = Number(sql(`select count(*) from "Outbox" where command in ('REROUTE','RESEQUENCE')`));
  check("every OFFER row (commanded route) is byte-identical after the alerts", digestsBefore.split("\n").filter(Boolean).every((line) => digestsAfter.includes(line)));
  check("no REROUTE or RESEQUENCE command exists", reroutes === 0, `${reroutes}`);
  const activity = (await s.api("GET", "/api/dtaro/activity")).json?.events || [];
  check("a dashboard that reconnects can replay the alerts (GET /api/dtaro/activity)", activity.some((e) => e.event === "ALERT_CREATED" && e.payload.obstacleId === e1.obstacleId));

  if (ARGS.has("--expiry")) {
    await step("7. Expiry: wait out the 5-minute lifetime; a new report of the same cell is a NEW obstacle");
    const ms = Date.parse(e1.expiresAt) - Date.now() + 2000;
    note(`waiting ${Math.round(ms / 1000)} s for ${e1.obstacleId} to expire (${e1.expiresAt})`);
    if (ms > 0) await wait(ms);
    const again = await report(s, "OBSTACLE-REPORTER-3", pick1.obstacle, { lat: -0.000018, lon: 0 });
    check("after expiry the same cell alerts again as a new obstacle", again.ev.event === "ALERT_CREATED" && again.ev.payload.obstacleId !== e1.obstacleId);
  }

  const failed = checks.filter((c) => !c.ok);
  evidence.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(SP, "demo-evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(`\n${failed.length === 0 ? "DEMO PASSED" : "DEMO FAILED"}: ${checks.length - failed.length}/${checks.length} checks. Evidence: ${path.join(SP, "demo-evidence.json")}`);
  s.socket.close();
  process.exit(failed.length === 0 ? 0 : 1);
})().catch((e) => {
  console.error("DEMO ERROR:", e.message);
  process.exit(1);
});
