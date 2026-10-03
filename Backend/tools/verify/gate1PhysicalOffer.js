#!/usr/bin/env node
"use strict";

/**
 * GATE 1 live proof — physical robot → candidate → signed OFFER, through the real server.
 *
 *   node tools/verify/gate1PhysicalOffer.js --database-url postgresql://<user>@127.0.0.1:<port>/<db> [--port 3041]
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
      specification: { massKg: 5, maxSpeedMps: 1.2, normalSpeedMps: 1.0, batteryCapacityWh: 43, batteryReservePct: 20, payloadCapacityKg: 3, initialBatteryPct: 85 },
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
  const evidence = { auth: null, offers: [], verified: [], probes: 0 };
  let sequence = 0;
  let loop = null;
  socket.on("connect", () => socket.emit("AUTH", { robotId: ROBOT_ID, pairingCode }));
  socket.on("AUTH_SUCCESS", (ack) => {
    evidence.auth = { mode: ack && ack.session && ack.session.mode, token: Boolean(ack && ack.token) };
    log("AUTH_SUCCESS", evidence.auth);
    const beat = () => {
      const now = Date.now();
      socket.emit("HEARTBEAT", {});
      sequence += 1;
      socket.emit("TELEMETRY", {
        lat: at.lat,
        lon: at.lon,
        speed: 0,
        status: "IDLE",
        heading: 0,
        timestamp: now,
        sequence,
        position: { fixType: "3D", hAccM: 1.5 },
        safety: { stopLatch: { engaged: false, components: { esp32SafetyStop: false, piMotionInhibit: false } } },
      });
    };
    beat();
    loop = setInterval(beat, 2000);
  });
  socket.on("PROBE", (probe) => {
    evidence.probes += 1;
    socket.emit("PROBE_RESULT", { command: "PROBE", correlationId: probe.correlationId, robotId: ROBOT_ID, status: "IDLE" });
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
      socket.emit("OFFER_ACCEPT", { commitmentId: envelope.commitmentId, fence: envelope.fence, robotId: ROBOT_ID });
    }
  });

  /* 6. tasks until the physical unit is offered one */
  const pairs = [
    ["rnsit-innovation-center", "rnsit-food-court"],
    ["rnsit-canara-bank", "rnsit-innovation-center"],
    ["rnsit-food-court", "rnsit-canara-bank"],
  ];
  await sleep(12_000); // index sweep + probe window
  for (let i = 0; i < pairs.length && evidence.offers.length === 0; i += 1) {
    const [from, to] = pairs[i];
    const created = await api("POST", "/api/tasks/assign", {
      taskId: `GATE1-TASK-${i + 1}-${Date.now()}`,
      pickup: from,
      drop: to,
      pickupLat: POINTS[from].lat,
      pickupLon: POINTS[from].lon,
      dropLat: POINTS[to].lat,
      dropLon: POINTS[to].lon,
      regionId: "rnsit",
    });
    log(`task ${i + 1} ${from} → ${to}:`, created.status, created.text.slice(0, 160));
    for (let w = 0; w < 45 && evidence.offers.length === 0; w += 1) await sleep(1000);
  }
  await sleep(4000);

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
  if (loop) clearInterval(loop);
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
