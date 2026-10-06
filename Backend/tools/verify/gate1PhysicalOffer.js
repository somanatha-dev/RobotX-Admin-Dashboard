#!/usr/bin/env node
"use strict";

/**
 * GATE 1 live proof — physical robot → candidate → signed OFFER, through the real server.
 *
 *   node tools/verify/gate1PhysicalOffer.js --database-url postgresql://<user>@127.0.0.1:<port>/<db> [--port 3041] [--completion]
 *
 * Against a DISPOSABLE local database only (refused otherwise). It:
 *   1. seeds the V1 world (`seedV1Demonstration --fleet single`: the RNSIT region, shard,
 *      depot charger and one virtual robot — a mixed fleet);
 *   2. commissions one PHYSICAL unit (`robot.service.createRobotWithProjection`,
 *      simulated: false); its declaration (applied at boot) binds it to the region and puts
 *      it in service;
 *   3. writes a physical fleet declaration and starts the real server through the V1
 *      launcher with PHYSICAL_FLEET_ENABLED=true (the declaration is applied at boot);
 *   4. logs in, mints the unit's pairing code (`POST /api/robots/commission`) and declares its
 *      state of charge (`POST /api/robots/:id/soc-declaration`);
 *   5. connects a **Pi stand-in** over Socket.IO: AUTH with the pairing code, HEARTBEAT and
 *      TELEMETRY every 2 s (position with a declared 3D fix, the software stop latch), PROBE
 *      answered;
 *   6. submits tasks until the physical unit receives an OFFER, then verifies the envelope
 *      exactly as the Pi must (HMAC, addressee, notValidAfter) and answers COMMAND_ACK +
 *      OFFER_ACCEPT;
 *   7. reports what the database shows.
 *
 * TEST INPUTS, NOT FLEET FACTS: the stand-in's position, fix quality, stop latch and the
 * declaration's numbers are this harness's inputs on a throwaway database. No motor, UART or
 * Pi is involved; this proves the backend half of Gates 1–2.
 *
 * GATE 1b (--completion): the delivery half, at the same protocol boundary. After OFFER_ACCEPT
 * the stand-in walks the accepted OFFER's own `stopSequence[].path` at the unit's commissioned
 * cruise speed (normalSpeedMps, below maxSpeedMps), one TELEMETRY fix every 2 s, and does at
 * each stop what the Pi does: dwell, then CUSTODY_EVENT {commitmentId, fence, kind} (ACQUIRED
 * at PICKUP, RELEASED at DROP), then TASK_COMPLETE {taskId, lat, lon} after the last stop. It
 * never reads the database to decide anything; the harness observes the database and the
 * dashboard socket separately. Task 1 sends RELEASED then TASK_COMPLETE. When it has settled, a
 * second task is submitted until the SAME unit is offered one (re-eligibility), and that one is
 * completed in the inverted order — TASK_COMPLETE while custody is still HELD, RELEASED 12 s
 * later — the C5 check: while goods are aboard the claim must be held (Task not COMPLETED,
 * commitment live, `TASK_COMPLETE_ACK {verifying, reason: CUSTODY_STILL_HELD}`), and the release
 * must then settle the Leg and complete the Task with exactly one TASK_UPDATED COMPLETED.
 * Exit 0 = Gate 1b PASS (C5 included); 1 = FAIL.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn, spawnSync } = require("child_process");

const BACKEND = path.resolve(__dirname, "..", "..");
const REPO = path.resolve(BACKEND, "..");
const { assertDisposableLocal } = require(path.join(BACKEND, "tools/demo/disposableDatabase"));

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const url = assertDisposableLocal(flag("--database-url", ""), { purpose: "the Gate 1 physical OFFER proof" });
const PORT = Number(flag("--port", "3041"));
const BASE = `http://127.0.0.1:${PORT}`;
const ROBOT_ID = "robotx-pi-gate1";
const SIGNING_KEY = "gate1-disposable-signing-key-" + "0".repeat(16);
const ADMIN = { email: "gate1-admin@localhost", password: "Gate1-Disposable-Passw0rd!" };
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "gate1-"));
const COMPLETION = argv.includes("--completion");
// The physical unit's commissioning specification (a harness declaration on a throwaway database).
const SPEC = { massKg: 5, maxSpeedMps: 1.2, normalSpeedMps: 1.0, batteryCapacityWh: 43, batteryReservePct: 20, payloadCapacityKg: 3, initialBatteryPct: 85 };
// Gate 1b stand-in cadence: one fix per TICK_MS (the Gate 1 telemetry interval), a DWELL_MS stay
// at each stop before its custody report, and the C5 probe's HOLD_MS between TASK_COMPLETE and
// RELEASED. TEST INPUTS, not fleet facts.
const TICK_MS = 2000;
const DWELL_MS = 6000;
const HOLD_MS = 12_000;
const MISSION_TIMEOUT_MS = 25 * 60_000;

process.env.DATABASE_URL = url;
process.env.DATABASE_URL_LOCAL = url;
process.env.REDIS_ENABLED = "false";
process.env.REDIS_URL = "";

const log = (...args) => console.log("[gate1]", ...args);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ── campus data ─────────────────────────────────────────────────────────── */
const EXTRACT = JSON.parse(fs.readFileSync(path.join(REPO, "rnsit-campus-osm.geojson"), "utf8"));
const POINTS = Object.fromEntries(
  JSON.parse(fs.readFileSync(path.join(REPO, "rnsit-campus-supplemental.geojson"), "utf8")).features.map((f) => [
    f.properties.id,
    { lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] },
  ]),
);

function nearestWayVertex(point, classes) {
  let best = null;
  for (const f of EXTRACT.features) {
    if (!f.geometry || f.geometry.type !== "LineString" || !classes.includes(f.properties.highway)) continue;
    for (const [lon, lat] of f.geometry.coordinates) {
      const d = Math.hypot((lat - point.lat) * 110540, (lon - point.lon) * 111320 * Math.cos((point.lat * Math.PI) / 180));
      if (!best || d < best.d) best = { lat, lon, d };
    }
  }
  return best;
}

async function main() {
  /* 1. seed */
  log("seeding the V1 world (one virtual robot)");
  const seeded = spawnSync(process.execPath, [path.join(BACKEND, "tools/demo/seedV1Demonstration.js"), "--database-url", url, "--fleet", "single"], {
    cwd: BACKEND,
    env: process.env,
    encoding: "utf8",
  });
  if (seeded.status !== 0) throw new Error(`seed failed:\n${seeded.stdout}\n${seeded.stderr}`);

  const { getPrisma } = require(path.join(BACKEND, "src/db/prisma"));
  const prisma = getPrisma();
  const robotService = require(path.join(BACKEND, "src/services/robot.service"));
  const robotSpecification = require(path.join(BACKEND, "src/services/robotSpecification"));
  const campusTraversalNetwork = require(path.join(BACKEND, "src/simulation/campusTraversalNetwork"));
  const commandSigning = require(path.join(BACKEND, "src/engine/security/commandSigning"));

  /* 2. commission the physical unit */
  const location = await prisma.location.findFirst();
  const rover = robotSpecification.CHASSIS_TEMPLATE[robotSpecification.CHASSIS_TYPE.ROVER].permissionSet;
  const at = nearestWayVertex(POINTS["rnsit-innovation-center"], campusTraversalNetwork.permittedClasses(rover));
  log(`physical unit placed on a permitted way vertex ${at.d.toFixed(1)} m from the Innovation Center`);
  await robotService.createRobotWithProjection(
    prisma,
    {
      locationId: location.id,
      lat: at.lat,
      lon: at.lon,
      name: "Gate 1 physical unit (stand-in)",
      chassisType: robotSpecification.CHASSIS_TYPE.ROVER,
      specification: SPEC,
    },
    { robotCode: ROBOT_ID, simulated: false, simulationOwnerId: null },
  );

  /* 3. declaration + server */
  const declarationFile = path.join(SCRATCH, "physical-fleet.declaration.json");
  fs.writeFileSync(
    declarationFile,
    JSON.stringify(
      {
        declaredBy: "gate1 harness (disposable)",
        declaredAt: new Date().toISOString().slice(0, 10),
        charging: { policy: "MANUAL_OUT_OF_SERVICE" },
        stateOfCharge: { policy: "OPERATOR_DECLARED", maxAgeSeconds: 7200 },
        emergencyStop: { mechanism: "SOFTWARE_STOP_LATCH" },
        site: { ambientC: { min: 18, max: 38 }, terrain: "FLAT_DECLARED", connectivityDeadZones: "NONE_DECLARED", constrictions: "NONE_DECLARED", stopStartCyclesPerHop: 1 },
        localisation: { referenceRadiusM: 25, acceptedFixTypes: ["3D", "RTK_FLOAT", "RTK_FIXED"] },
        risk: { failureProbabilityPrior: 0.05, routeHazardCu: 0 },
        robots: [
          {
            robotId: ROBOT_ID,
            control: {
              firmwareVersion: "robotx-pi-agent/stand-in",
              hardwareRevision: "rover-rev-a",
              missionTypes: ["DELIVERY"],
              calibrations: [],
              serviceDueAt: "2027-06-01T00:00:00Z",
              regionId: "rnsit",
              authorisation: "REGION",
              advisories: [],
              operatingAmbientC: { min: 0, max: 45 },
            },
            energy: { idlePowerW: 5, movingPowerW: 20, soh: 0.9, residualCv: 0.2, reserveFloorWh: 8.6 },
          },
        ],
      },
      null,
      2,
    ),
  );
  await prisma.$disconnect();

  log(`starting the V1 server on :${PORT} with PHYSICAL_FLEET_ENABLED=true`);
  const serverLog = fs.createWriteStream(path.join(SCRATCH, "server.log"));
  const server = spawn(process.execPath, [path.join(BACKEND, "tools/demo/startV1Server.js"), "--database-url", url, "--port", String(PORT), "--host", "127.0.0.1"], {
    cwd: BACKEND,
    env: {
      ...process.env,
      PHYSICAL_FLEET_ENABLED: "true",
      PHYSICAL_FLEET_DECLARATION_FILE: declarationFile,
      AGENT_PROBE_INTERVAL_MS: "2000",
      COMMAND_SIGNING_KEY: SIGNING_KEY,
      SEED_ADMIN_EMAIL: ADMIN.email,
      SEED_ADMIN_PASSWORD: ADMIN.password,
    },
  });
  server.stdout.pipe(serverLog);
  server.stderr.pipe(serverLog);
  const stop = () => {
    try { server.kill(); } catch { /* gone */ }
  };
  process.on("exit", stop);

  for (let i = 0; i < 120; i += 1) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.status < 500) break;
    } catch { /* not yet */ }
    await sleep(1000);
  }

  /* 4. operator steps over HTTP */
  const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ADMIN) });
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  if (!login.ok || !cookie) throw new Error(`login failed: ${login.status} ${await login.text()}`);
  const api = async (method, route, body) => {
    const r = await fetch(`${BASE}${route}`, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, json, text };
  };
  const commission = await api("POST", "/api/robots/commission", { robotId: ROBOT_ID });
  const pairingCode = commission.json && (commission.json.pairingCode || commission.json.code || (commission.json.data && commission.json.data.pairingCode));
  log("pairing code minted:", commission.status, pairingCode ? "yes" : commission.text.slice(0, 300));
  const soc = await api("POST", `/api/robots/${ROBOT_ID}/soc-declaration`, { socPct: 85 });
  log("SoC declaration:", soc.status, soc.text.slice(0, 200));

  /* 5. the Pi stand-in */
  const { io: ioClient } = require(path.join(BACKEND, "node_modules/socket.io-client"));
  const socket = ioClient(BASE, { transports: ["websocket"], reconnection: false });
  const evidence = { auth: null, offers: [], verified: [], probes: 0, otherEvents: [], completeAcks: [], fixesSent: 0 };
  let sequence = 0;
  let loop = null;
  // Gate 1b — the stand-in's own state: where it is, what it reports, and the mission it holds.
  const pos = { lat: at.lat, lon: at.lon };
  let heading = 0;
  let speedNow = 0;
  let status = "IDLE";
  let mission = null;
  const missions = [];
  let observeAt = async () => null; // replaced in Gate 1b once the observer exists
  const { haversineMeters } = require(path.join(BACKEND, "src/utils/distance"));
  const bearing = (a, b) => {
    const toRad = (d) => (d * Math.PI) / 180;
    const y = Math.sin(toRad(b.lon - a.lon)) * Math.cos(toRad(b.lat));
    const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) - Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lon - a.lon));
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  };

  /**
   * Gate 1b — advance the held mission by one tick: move `speed × elapsed` metres along the
   * current stop's OFFER path (vertex to vertex, never off it), then do what the stop requires
   * once the dwell has elapsed. Runs after the tick's TELEMETRY, so every action follows a fix.
   */
  async function advanceMission(nowMs) {
    const m = mission;
    if (!m) return;
    const stop = m.stops[m.stopIndex];
    if (m.phase === "MOVING") {
      let budget = (SPEC.normalSpeedMps * (nowMs - m.lastMs)) / 1000;
      while (budget > 0 && m.vertex < stop.path.length) {
        const target = stop.path[m.vertex];
        const d = haversineMeters(pos.lat, pos.lon, target.lat, target.lon);
        if (d > 0) heading = bearing(pos, target);
        if (d <= budget) {
          pos.lat = target.lat;
          pos.lon = target.lon;
          budget -= d;
          m.vertex += 1;
        } else {
          const f = budget / d;
          pos.lat += (target.lat - pos.lat) * f;
          pos.lon += (target.lon - pos.lon) * f;
          budget = 0;
        }
      }
      m.metres += (SPEC.normalSpeedMps * (nowMs - m.lastMs)) / 1000 - budget;
      speedNow = SPEC.normalSpeedMps;
      if (m.vertex >= stop.path.length) {
        m.phase = "DWELL";
        m.until = nowMs + DWELL_MS;
        speedNow = 0;
        m.log.push({ at: new Date(nowMs).toISOString(), step: `arrived ${stop.stopType} (stand-in, end of path)`, offStopM: Number(haversineMeters(pos.lat, pos.lon, stop.lat, stop.lon).toFixed(2)) });
      }
    } else if (m.phase === "DWELL" && nowMs >= m.until) {
      const last = m.stopIndex === m.stops.length - 1;
      if (stop.stopType === "PICKUP") await custody(m, "ACQUIRED");
      if (stop.stopType === "DROP" && !(last && m.inverted)) await custody(m, "RELEASED");
      if (!last) {
        m.stopIndex += 1;
        m.vertex = 0;
        m.phase = "MOVING";
      } else if (m.inverted) {
        await complete(m);
        m.phase = "HOLD";
        m.until = nowMs + HOLD_MS;
      } else {
        m.phase = "COMPLETE_NEXT_TICK";
      }
    } else if (m.phase === "COMPLETE_NEXT_TICK") {
      await complete(m);
      finish(m);
    } else if (m.phase === "HOLD" && nowMs >= m.until) {
      await custody(m, "RELEASED");
      finish(m);
    }
    m.lastMs = nowMs;
  }
  async function custody(m, kind) {
    m.log.push({ at: new Date().toISOString(), step: `CUSTODY_EVENT ${kind} sent`, backendBefore: await observeAt(m) });
    socket.emit("CUSTODY_EVENT", { commitmentId: m.envelope.commitmentId, fence: m.envelope.fence, kind });
  }
  async function complete(m) {
    m.log.push({ at: new Date().toISOString(), step: "TASK_COMPLETE sent", backendBefore: await observeAt(m) });
    socket.emit("TASK_COMPLETE", { taskId: m.envelope.payload.taskId, lat: pos.lat, lon: pos.lon, timestamp: Date.now() });
  }
  function finish(m) {
    m.done = true;
    m.finishedAt = Date.now();
    mission = null;
    status = "IDLE";
    speedNow = 0;
  }

  socket.on("connect", () => socket.emit("AUTH", { robotId: ROBOT_ID, pairingCode }));
  socket.on("AUTH_SUCCESS", (ack) => {
    evidence.auth = { mode: ack && ack.session && ack.session.mode, token: Boolean(ack && ack.token) };
    log("AUTH_SUCCESS", evidence.auth);
    const beat = async () => {
      const now = Date.now();
      // Contract: `{}` when idle, `{commitmentId, fence}` while holding a mission — the
      // commitment-scoped evidence that renews the mission lease (§12.2).
      socket.emit("HEARTBEAT", mission ? { commitmentId: mission.envelope.commitmentId, fence: mission.envelope.fence } : {});
      sequence += 1;
      evidence.fixesSent += 1;
      socket.emit("TELEMETRY", {
        lat: pos.lat,
        lon: pos.lon,
        speed: speedNow,
        status,
        heading,
        timestamp: now,
        sequence,
        position: { fixType: "3D", hAccM: 1.5 },
        safety: { stopLatch: { engaged: false, components: { esp32SafetyStop: false, piMotionInhibit: false } } },
      });
      try {
        await advanceMission(now);
      } catch (error) {
        log("stand-in mission step failed:", error && error.message);
      }
    };
    // Chained, not setInterval: a tick that awaits an observation never overlaps the next one.
    const next = () => {
      loop = setTimeout(async () => {
        await beat();
        if (loop) next();
      }, TICK_MS);
    };
    beat().then(next);
  });
  socket.on("PROBE", (probe) => {
    evidence.probes += 1;
    socket.emit("PROBE_RESULT", { command: "PROBE", correlationId: probe.correlationId, robotId: ROBOT_ID, status });
  });
  socket.on("TASK_COMPLETE_ACK", (ack) => evidence.completeAcks.push({ at: new Date().toISOString(), ...ack }));
  // Gate 1b — a RECALL or WITHDRAW of the held commitment ends the mission, as on the Pi.
  for (const command of ["RECALL", "WITHDRAW"]) {
    socket.on(command, (envelope) => {
      if (mission && envelope && envelope.commitmentId === mission.envelope.commitmentId) {
        mission.log.push({ at: new Date().toISOString(), step: `${command} received for the held commitment — mission ended` });
        mission.endedBy = command;
        finish(mission);
      }
    });
  }
  socket.onAny((event) => {
    if (!["OFFER", "PROBE", "AUTH_SUCCESS", "AUTH_OK", "TASK_COMPLETE_ACK"].includes(event)) {
      evidence.otherEvents.push({ at: new Date().toISOString(), event });
    }
  });
  socket.on("OFFER", (envelope) => {
    evidence.offers.push(envelope);
    const verified = commandSigning.verify(
      {
        agentId: envelope.agentId,
        command: envelope.command,
        commandClass: envelope.commandClass,
        fenceScope: envelope.fenceScope,
        commitmentId: envelope.commitmentId === undefined ? null : envelope.commitmentId,
        fence: envelope.fence === null || envelope.fence === undefined ? null : BigInt(envelope.fence),
        authorityEpoch: envelope.authorityEpoch === null || envelope.authorityEpoch === undefined ? null : BigInt(envelope.authorityEpoch),
        fenceFloor: envelope.fenceFloor === null || envelope.fenceFloor === undefined ? null : BigInt(envelope.fenceFloor),
        sequence: envelope.sequence,
        notValidAfter: new Date(envelope.notValidAfter),
        payload: envelope.payload,
      },
      envelope.signature,
      SIGNING_KEY,
    );
    const addressed = envelope.agentId === ROBOT_ID;
    const unexpired = new Date(envelope.notValidAfter).getTime() > Date.now();
    const tamperedRejected = !commandSigning.verify(
      { agentId: envelope.agentId, command: envelope.command, commandClass: envelope.commandClass, fenceScope: envelope.fenceScope, commitmentId: envelope.commitmentId, fence: BigInt(envelope.fence) + 1n, authorityEpoch: envelope.authorityEpoch == null ? null : BigInt(envelope.authorityEpoch), fenceFloor: envelope.fenceFloor == null ? null : BigInt(envelope.fenceFloor), sequence: envelope.sequence, notValidAfter: new Date(envelope.notValidAfter), payload: envelope.payload },
      envelope.signature,
      SIGNING_KEY,
    );
    const stops = envelope.payload && Array.isArray(envelope.payload.stopSequence) ? envelope.payload.stopSequence : envelope.payload && envelope.payload.stops;
    const row = { commitmentId: envelope.commitmentId, fence: envelope.fence, verified, addressed, unexpired, tamperedRejected, stops: Array.isArray(stops) ? stops.length : null };
    evidence.verified.push(row);
    log("OFFER received", row);
    if (verified && addressed && unexpired) {
      socket.emit("COMMAND_ACK", { outboxId: envelope.outboxId, robotId: ROBOT_ID, fence: envelope.fence, authorityEpoch: envelope.authorityEpoch, timestamp: Date.now() });
      if (!COMPLETION) {
        socket.emit("OFFER_ACCEPT", { commitmentId: envelope.commitmentId, fence: envelope.fence, robotId: ROBOT_ID });
        return;
      }
      // Gate 1b — a unit already executing a mission declines a second one, as the Pi does.
      if (mission) {
        row.declined = "BUSY";
        socket.emit("OFFER_REJECT", { commitmentId: envelope.commitmentId, fence: envelope.fence, robotId: ROBOT_ID, reason: "BUSY" });
        return;
      }
      const offeredStops = Array.isArray(stops) ? stops : [];
      if (offeredStops.length === 0 || offeredStops.some((s) => !Array.isArray(s.path) || s.path.length === 0)) {
        row.declined = "NO_EXECUTABLE_PATH";
        socket.emit("OFFER_REJECT", { commitmentId: envelope.commitmentId, fence: envelope.fence, robotId: ROBOT_ID, reason: "NO_EXECUTABLE_PATH" });
        return;
      }
      socket.emit("OFFER_ACCEPT", { commitmentId: envelope.commitmentId, fence: envelope.fence, robotId: ROBOT_ID });
      mission = {
        envelope,
        stops: offeredStops,
        stopIndex: 0,
        vertex: 0,
        phase: "MOVING",
        lastMs: Date.now(),
        metres: 0,
        until: null,
        // The second mission is the C5 probe: TASK_COMPLETE before RELEASED.
        inverted: missions.length === 1,
        acceptedAt: Date.now(),
        startGapM: Number(haversineMeters(pos.lat, pos.lon, offeredStops[0].path[0].lat, offeredStops[0].path[0].lon).toFixed(2)),
        log: [],
        done: false,
      };
      missions.push(mission);
      status = "ACTIVE";
      log(`Gate 1b: mission ${missions.length} accepted — ${offeredStops.map((s) => `${s.stopType}(${s.path.length} pts)`).join(" → ")}, start gap ${mission.startGapM} m, ${mission.inverted ? "C5 order (TASK_COMPLETE before RELEASED)" : "contract order (RELEASED then TASK_COMPLETE)"}`);
    }
  });

  /* 5b. Gate 1b observers — the database and the dashboard socket, read only */
  const { getPrisma: getWatch } = require(path.join(BACKEND, "src/db/prisma"));
  const watch = getWatch();
  const watchAgent = await watch.agent.findUnique({ where: { agentId: ROBOT_ID } });
  const history = []; // { at, commitmentId, legId, leg, custody, task, released }
  const dashboardEvents = [];
  let poller = null;
  let dashboard = null;
  const legView = async (commitmentId) => {
    const c = await watch.commitment.findUnique({ where: { commitmentId }, select: { commitmentId: true, legId: true, releasedAt: true } });
    if (!c) return null;
    const leg = await watch.leg.findUnique({ where: { id: c.legId }, select: { legId: true, state: true, custodyState: true, mission: { select: { tasks: { select: { taskId: true, status: true } } } } } });
    if (!leg) return null;
    const tasks = (leg.mission && leg.mission.tasks) || [];
    return { commitmentId, legId: leg.legId, leg: leg.state, custody: leg.custodyState, task: tasks.map((t) => t.status).join(","), released: Boolean(c.releasedAt) };
  };
  if (COMPLETION) {
    observeAt = async (m) => {
      try {
        const v = await legView(m.envelope.commitmentId);
        return v && { leg: v.leg, custody: v.custody, task: v.task, released: v.released };
      } catch {
        return null;
      }
    };
    dashboard = ioClient(BASE, { transports: ["websocket"], reconnection: false, extraHeaders: { origin: "http://localhost:5173", cookie } });
    dashboard.onAny((event, payload) => {
      if (/^TASK_/.test(event)) dashboardEvents.push({ at: new Date().toISOString(), event, taskId: payload && payload.taskId, robotId: payload && payload.robotId, status: payload && payload.status });
    });
    const seen = new Map();
    let polling = false;
    poller = setInterval(async () => {
      if (polling) return;
      polling = true;
      try {
        const held = await watch.commitment.findMany({ where: { agentId: watchAgent.id }, select: { commitmentId: true } });
        for (const c of held) {
          const now = await legView(c.commitmentId);
          if (!now) continue;
          const key = JSON.stringify([now.leg, now.custody, now.task, now.released]);
          if (seen.get(c.commitmentId) !== key) {
            seen.set(c.commitmentId, key);
            history.push({ at: new Date().toISOString(), ...now });
          }
        }
      } catch { /* observation only */ }
      polling = false;
    }, 500);
  }

  /* 6. tasks until the physical unit is offered one */
  const pairs = [
    ["rnsit-innovation-center", "rnsit-food-court"],
    ["rnsit-canara-bank", "rnsit-innovation-center"],
    ["rnsit-food-court", "rnsit-canara-bank"],
  ];
  let submitted = 0;
  const submitTask = async (from, to) => {
    submitted += 1;
    const created = await api("POST", "/api/tasks/assign", {
      taskId: `GATE1-TASK-${submitted}-${Date.now()}`,
      pickup: from,
      drop: to,
      pickupLat: POINTS[from].lat,
      pickupLon: POINTS[from].lon,
      dropLat: POINTS[to].lat,
      dropLon: POINTS[to].lon,
      regionId: "rnsit",
    });
    log(`task ${submitted} ${from} → ${to}:`, created.status, created.text.slice(0, 160));
    return created;
  };
  // Gate 1 waits for any OFFER; Gate 1b for one the stand-in accepted.
  const offeredCount = () => (COMPLETION ? missions.length : evidence.offers.length);
  await sleep(12_000); // index sweep + probe window
  for (let i = 0; i < pairs.length && offeredCount() === 0; i += 1) {
    const [from, to] = pairs[i];
    await submitTask(from, to);
    for (let w = 0; w < 45 && offeredCount() === 0; w += 1) await sleep(1000);
  }
  await sleep(4000);

  /* 6b. Gate 1b — the delivery, then a second task for the same unit */
  const waitFor = async (predicate, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return true;
      await sleep(1000);
    }
    return false;
  };
  const settled = async (m) => {
    const v = await legView(m.envelope.commitmentId).catch(() => null);
    return Boolean(v && v.leg === "SETTLED");
  };
  if (COMPLETION && missions.length === 1) {
    const first = missions[0];
    log("Gate 1b: mission 1 under way; waiting for the stand-in to finish it");
    await waitFor(() => first.done, MISSION_TIMEOUT_MS);
    log(`Gate 1b: mission 1 ${first.done ? "finished on the stand-in" : "TIMED OUT"}; waiting for the backend to settle it`);
    await waitFor(() => settled(first), 30_000);
    await sleep(6000); // the index maintainer re-places the released unit
    // Second task: submitted until the SAME unit is offered one. Pickups from the place the unit
    // now stands first; nothing about the unit is written to make it available.
    const second = [
      ["rnsit-food-court", "rnsit-canara-bank"],
      ["rnsit-food-court", "rnsit-innovation-center"],
      ["rnsit-innovation-center", "rnsit-canara-bank"],
      ["rnsit-canara-bank", "rnsit-food-court"],
      ["rnsit-innovation-center", "rnsit-food-court"],
      ["rnsit-canara-bank", "rnsit-innovation-center"],
    ].sort((a, b) => haversineMeters(pos.lat, pos.lon, POINTS[a[0]].lat, POINTS[a[0]].lon) - haversineMeters(pos.lat, pos.lon, POINTS[b[0]].lat, POINTS[b[0]].lon));
    for (let i = 0; i < second.length && missions.length < 2; i += 1) {
      await submitTask(second[i][0], second[i][1]);
      for (let w = 0; w < 45 && missions.length < 2; w += 1) await sleep(1000);
    }
    if (missions.length === 2) {
      log("Gate 1b: mission 2 (C5 order) under way");
      await waitFor(() => missions[1].done, MISSION_TIMEOUT_MS);
      await waitFor(() => settled(missions[1]), 30_000);
      await sleep(4000);
    } else {
      log("Gate 1b: the unit was NOT offered a second task");
    }
  }

  /* 7. what the database shows */
  const prisma2 = require(path.join(BACKEND, "src/db/prisma")).getPrisma();
  const agentRow = await prisma2.agent.findUnique({ where: { agentId: ROBOT_ID } });
  const cell = await prisma2.agentCellPosition.findUnique({ where: { agentId: agentRow.id } });
  const fixRows = await prisma2.observation.count({ where: { agentId: agentRow.id, kind: "position" } });
  const latch = await prisma2.observation.count({ where: { agentId: agentRow.id, kind: "emergency_stop" } });
  const outbox = await prisma2.outbox.findMany({ where: { agentId: agentRow.id }, select: { command: true, state: true, fence: true } });
  const commitments = await prisma2.commitment.findMany({ where: { agentId: agentRow.id }, select: { commitmentId: true, legId: true } });
  const legs = commitments.length
    ? await prisma2.leg.findMany({ where: { id: { in: commitments.map((c) => c.legId) } }, select: { legId: true, state: true } })
    : [];
  const rejections = await prisma2.rejectionAggregate.findMany({ take: 20, orderBy: { count: "desc" } }).catch(() => []);
  const report = {
    auth: evidence.auth,
    probesAnswered: evidence.probes,
    positionObservations: fixRows,
    emergencyStopObservations: latch,
    indexed: cell ? { availabilityClass: cell.availabilityClass, shardId: cell.shardId } : null,
    offersReceived: evidence.offers.length,
    offersVerified: evidence.verified,
    outbox: outbox.map((row) => ({ ...row, fence: String(row.fence) })),
    legs,
    topRejections: rejections.map((r) => ({ predicateId: r.predicateId, count: r.count })),
    serverLog: path.join(SCRATCH, "server.log"),
  };
  console.log(JSON.stringify(report, (k, v) => (typeof v === "bigint" ? String(v) : v), 2));
  if (loop) clearTimeout(loop);
  loop = null;
  if (poller) clearInterval(poller);
  if (dashboard) dashboard.close();

  /* 7b. Gate 1b — what the backend concluded about each delivery */
  if (COMPLETION) {
    const json = (value) => JSON.stringify(value, (k, v) => (typeof v === "bigint" ? String(v) : v), 2);
    const REQUIRED = ["ACCEPTED", "EN_ROUTE_PICKUP", "AT_PICKUP", "LOADED", "EN_ROUTE_DROP", "AT_DROP", "RELEASED", "SETTLED"];
    const inOrder = (seq, req) => {
      let i = 0;
      for (const s of seq) if (s === req[i]) i += 1;
      return i === req.length;
    };
    const serverLog = fs.existsSync(path.join(SCRATCH, "server.log")) ? fs.readFileSync(path.join(SCRATCH, "server.log"), "utf8") : "";
    const logCount = (needle) => serverLog.split(needle).length - 1;

    const deliveries = [];
    for (const [index, m] of missions.entries()) {
      const commitmentId = m.envelope.commitmentId;
      const taskId = m.envelope.payload.taskId;
      const commitment = await prisma2.commitment.findUnique({ where: { commitmentId }, select: { commitmentId: true, legId: true, fence: true, grantedAt: true, releasedAt: true, custodyState: true } });
      const leg = commitment ? await prisma2.leg.findUnique({ where: { id: commitment.legId }, select: { id: true, legId: true, state: true, custodyState: true, version: true } }) : null;
      const task = await prisma2.task.findUnique({ where: { taskId }, select: { taskId: true, status: true, completedAt: true, robot: { select: { robotId: true } } } });
      const offerRows = await prisma2.outbox.findMany({ where: { commitmentId }, select: { command: true, state: true, fence: true }, orderBy: { createdAt: "asc" } });
      const evidenceRows = leg ? await prisma2.verificationEvidence.findMany({ where: { legId: leg.id }, orderBy: { observedAt: "asc" } }) : [];
      const timerRows = leg ? await prisma2.timer.findMany({ where: { entityType: "LEG", entityId: leg.id }, orderBy: { entityVersion: "asc" }, select: { state: true, entityVersion: true, timerState: true, handler: true } }) : [];
      const fixesSinceGrant = commitment ? await prisma2.observation.count({ where: { agentId: agentRow.id, kind: "position", observedAt: { gte: commitment.grantedAt } } }) : null;
      const seen = history.filter((h) => h.commitmentId === commitmentId);
      const legSeq = seen.map((h) => h.leg).filter((s, i, a) => i === 0 || a[i - 1] !== s);
      const firstIndex = (pred) => seen.findIndex(pred);
      const firstHeld = firstIndex((h) => h.custody === "HELD");
      const firstReleased = firstIndex((h) => h.custody === "RELEASED");
      // The durable entry record: every state with a §4.5 deadline leaves a Timer row at the Leg
      // version it was entered with, so a state the 500 ms poller missed is still on record.
      // LOADED and SETTLED carry no deadline and are read from the poller and the final row.
      const timerStates = timerRows.map((t) => t.state);
      const entered = (state) => legSeq.includes(state) || timerStates.includes(state);
      const durableOrder = inOrder(timerStates, ["ACCEPTED", "EN_ROUTE_PICKUP", "AT_PICKUP", "EN_ROUTE_DROP", "AT_DROP", "RELEASED"]) && legSeq.includes("LOADED") && Boolean(leg && leg.state === "SETTLED");
      const verifiedRow = evidence.verified.find((row) => row.commitmentId === commitmentId) || {};
      const step = (label) => m.log.find((entry) => entry.step === label) || null;
      const releasedSend = step("CUSTODY_EVENT RELEASED sent");
      const completeSend = step("TASK_COMPLETE sent");
      const acquiredSend = step("CUSTODY_EVENT ACQUIRED sent");
      const taskEvents = dashboardEvents.filter((e) => e.taskId === taskId);
      const checks = {
        offerVerifiedAddressedUnexpiredTamperRejected: Boolean(verifiedRow.verified && verifiedRow.addressed && verifiedRow.unexpired && verifiedRow.tamperedRejected),
        offerAcked: offerRows.some((row) => row.command === "OFFER" && row.state === "ACKED"),
        legReachedAccepted: legSeq.includes("ACCEPTED") || timerRows.some((t) => t.state === "ACCEPTED"),
        standInFinished: m.done,
        neverRecalledOrWithdrawn: !m.endedBy && !offerRows.some((row) => row.command === "RECALL" || row.command === "WITHDRAW"),
        legPassedEveryStateInOrder: inOrder(legSeq, REQUIRED) || durableOrder,
        // §4.4: LOADED is entered only from AT_PICKUP (CUSTODY_ACQUIRED, guarded by a verified
        // arrival) and RELEASED only from AT_DROP, so the earlier state on record before custody
        // moved is the server's arrival verification preceding the custody admission.
        pickupArrivalVerifiedBeforeCustodyAdmitted: firstHeld > 0 && (seen.slice(0, firstHeld).some((h) => h.leg === "AT_PICKUP") || (entered("AT_PICKUP") && durableOrder)),
        dropArrivalVerifiedBeforeCustodyReleased: firstReleased > 0 && (seen.slice(0, firstReleased).some((h) => h.leg === "AT_DROP") || (entered("AT_DROP") && entered("RELEASED") && durableOrder)),
        custodyHeldUntilReleased: firstHeld >= 0 && firstReleased > firstHeld && seen.slice(firstHeld, firstReleased).every((h) => h.custody === "HELD") && Boolean(releasedSend && releasedSend.backendBefore && releasedSend.backendBefore.custody === "HELD"),
        neverSettledOrReleasedWhileCustodyHeld: !seen.some((h) => h.custody === "HELD" && (h.leg === "SETTLED" || h.released)),
        verificationSufficient: evidenceRows.some((row) => row.outcome === "SUFFICIENT"),
        legSettled: Boolean(leg && leg.state === "SETTLED"),
        custodyReleased: Boolean(leg && leg.custodyState === "RELEASED"),
        commitmentReleased: Boolean(commitment && commitment.releasedAt),
        taskCompleted: Boolean(task && task.status === "COMPLETED"),
        dashboardTaskUpdatedCompleted: taskEvents.some((e) => e.event === "TASK_UPDATED" && e.status === "COMPLETED"),
      };
      deliveries.push({
        mission: index + 1,
        order: m.inverted ? "C5: TASK_COMPLETE then RELEASED" : "contract: RELEASED then TASK_COMPLETE",
        ids: { taskId, legId: leg && leg.legId, commitmentId, fence: commitment && commitment.fence, outboxId: m.envelope.outboxId },
        stops: m.stops.map((s) => ({ stopType: s.stopType, points: s.path.length, pathDistanceMeters: s.pathDistanceMeters, pathProfile: s.pathProfile })),
        standIn: { startGapM: m.startGapM, metresWalked: Number(m.metres.toFixed(1)), seconds: m.finishedAt ? Math.round((m.finishedAt - m.acceptedAt) / 1000) : null, steps: m.log },
        observedLegStates: legSeq,
        observedHistory: seen.map(({ at, leg: l, custody: c, task: t, released }) => ({ at, leg: l, custody: c, task: t, released })),
        timers: timerRows.map((t) => ({ ...t, entityVersion: String(t.entityVersion) })),
        outbox: offerRows.map((row) => ({ ...row, fence: String(row.fence) })),
        verification: evidenceRows.map((row) => ({ outcome: row.outcome, requiredLevel: row.requiredLevel, achievedLevel: row.achievedLevel, failures: row.failures, arrivalDistanceM: row.arrivalDistanceM, trackFixCount: row.trackFixCount, fixRatePerMinute: row.fixRatePerMinute, corridorFraction: row.corridorFraction, maxGapSeconds: row.maxGapSeconds, maxImpliedSpeedMs: row.maxImpliedSpeedMs, securityEvent: row.securityEvent })),
        final: { leg: leg && { state: leg.state, custodyState: leg.custodyState }, commitment: commitment && { releasedAt: commitment.releasedAt, custodyState: commitment.custodyState }, task },
        positionObservationsSinceGrant: fixesSinceGrant,
        dashboardTaskEvents: taskEvents,
        sends: { acquired: acquiredSend, released: releasedSend, complete: completeSend },
        checks,
      });
    }

    const [d1, d2] = deliveries;
    // C5 — the second delivery sends TASK_COMPLETE while custody is HELD. Required: the claim is
    // held (Task not COMPLETED, commitment live, the agent told CUSTODY_STILL_HELD) for the whole
    // window — sampled just before RELEASED is sent — and the release then settles the Leg and
    // completes the Task, with exactly one TASK_UPDATED COMPLETED, after the release.
    const c5Window = d2 && d2.sends.released ? d2.sends.released.backendBefore : null;
    const d2Acks = d2 ? evidence.completeAcks.filter((ack) => ack.taskId === d2.ids.taskId) : [];
    const d2Completed = d2 ? d2.dashboardTaskEvents.filter((e) => e.event === "TASK_UPDATED" && e.status === "COMPLETED") : [];
    const c5 = d2
      ? {
          windowState: c5Window,
          heldWhileCustodyHeld: Boolean(c5Window && c5Window.leg === "AT_DROP" && c5Window.custody === "HELD" && c5Window.task !== "COMPLETED" && !c5Window.released),
          heldAck: d2Acks.length === 1 && d2Acks[0].verifying === true && d2Acks[0].reason === "CUSTODY_STILL_HELD",
          completedOnceAfterRelease: d2Completed.length === 1 && Boolean(d2.sends.released) && d2Completed[0].at >= d2.sends.released.at,
          completionAcks: d2Acks,
          verdict: null,
        }
      : null;
    if (c5) c5.verdict = c5.heldWhileCustodyHeld && c5.heldAck && c5.completedOnceAfterRelease ? "FIXED" : "DEFECT";

    const gate = {
      delivery1: d1 ? Object.values(d1.checks).every(Boolean) : false,
      secondOfferToSameUnit: Boolean(d2 && d2.checks.offerVerifiedAddressedUnexpiredTamperRejected && d2.checks.offerAcked && d2.checks.legReachedAccepted),
      delivery2NeverSettledWhileHeld: Boolean(d2 && d2.checks.neverSettledOrReleasedWhileCustodyHeld),
      c5TaskNotCompletedWhileCustodyHeld: Boolean(c5 && c5.heldWhileCustodyHeld && c5.heldAck),
      c5CompletedOnceAfterRelease: Boolean(c5 && c5.completedOnceAfterRelease),
      delivery2FinalConsistent: Boolean(d2 && d2.checks.neverRecalledOrWithdrawn && d2.checks.verificationSufficient && d2.checks.legSettled && d2.checks.custodyReleased && d2.checks.commitmentReleased && d2.checks.taskCompleted),
    };
    console.log(json({
      gate1b: {
        deliveries,
        c5,
        offersToUnit: evidence.verified,
        standInOtherEvents: evidence.otherEvents,
        taskCompleteAcks: evidence.completeAcks,
        fixesSent: evidence.fixesSent,
        serverLog: {
          positionRefusals: logCount("no position Observation recorded"),
          healthRefused: logCount("Self-reported health refused"),
          trustRefusals: logCount("TELEMETRY refused by the §23.5 trust boundaries"),
          custodyHandled: logCount("CUSTODY_EVENT handled"),
          completionHeld: logCount("TASK_COMPLETE held"),
          agentGateRefusals: logCount("refused by the agent gate"),
        },
        gate,
      },
    }));
    socket.close();
    await prisma2.$disconnect();
    stop();
    const gatePass = Object.values(gate).every(Boolean);
    log(`Gate 1b checks: ${JSON.stringify(gate)}`);
    log(`C5: ${c5 ? c5.verdict : "NOT REACHED"}${c5 ? ` (window: ${JSON.stringify(c5.windowState)})` : ""}`);
    if (!gatePass) {
      log("FAIL — Gate 1b: see the checks above");
      process.exit(1);
    }
    log("PASS — Gate 1b: OFFER → ACCEPT → path → AT_PICKUP → ACQUIRED → AT_DROP → RELEASED → TASK_COMPLETE → SUFFICIENT → SETTLED → COMPLETED; then the same unit's second task, TASK_COMPLETE held while custody HELD and completed once at RELEASED");
    process.exit(0);
  }

  socket.close();
  await prisma2.$disconnect();
  stop();
  const pass = evidence.verified.some((row) => row.verified && row.addressed && row.unexpired && row.tamperedRejected);
  log(pass ? "PASS — physical candidate selected and a verifiable signed OFFER delivered" : "FAIL — no verifiable OFFER reached the physical unit");
  process.exit(pass ? 0 : 1);
}

main().catch((error) => {
  console.error("[gate1] error:", error && error.stack ? error.stack : error);
  process.exit(2);
});
