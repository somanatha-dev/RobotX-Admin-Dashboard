#!/usr/bin/env node
"use strict";

/**
 * GATE 3 — signed OFFER → the REAL Pi agent → mission → navigator → DecisionMaker →
 * MotionIntent → Pi safety gate → DRIVE → the ESP32 firmware (host simulator) → ACK/telemetry.
 *
 *   node tools/verify/gate3PiSimOffer.js --database-url postgresql://<user>@127.0.0.1:<port>/<db>
 *        [--port 3043] [--pi-repo <path to RobotX-Pi>] [--sim-exe <rover_sim(.exe)>]
 *
 * DISPOSABLE local database only. Steps 1–4 are the Gate 1 setup, unchanged (mixed fleet,
 * physical unit commissioned and declared, real server.js with PHYSICAL_FLEET_ENABLED,
 * pairing code, operator SoC). Step 5 runs the Pi repository's own agent
 * (tests/integration/gate3_harness.py) with:
 *   ROBOTX_ESP32_SIMULATOR_EXE  the ESP32 repository's compiled host simulator — no UART is
 *                               opened (the harness makes any serial open fail loudly)
 *   ROBOTX_GPS_SOURCE=esp32     position from ESP32 GPS frames
 *   ROBOTX_CUSTODY_CONFIRMATION=operator
 * and TEST INPUTS for the two things this machine has no hardware for (GPS frames at a
 * fixed position; a clear camera scene). No motor exists anywhere in this run.
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
const url = assertDisposableLocal(flag("--database-url", ""), { purpose: "the Gate 3 Pi + ESP32 simulator proof" });
const PORT = Number(flag("--port", "3043"));
const BASE = `http://127.0.0.1:${PORT}`;
const ROBOT_ID = "robotx-pi-gate3";
const SIGNING_KEY = "gate1-disposable-signing-key-" + "0".repeat(16);
const ADMIN = { email: "gate1-admin@localhost", password: "Gate1-Disposable-Passw0rd!" };
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "gate3-"));

process.env.DATABASE_URL = url;
process.env.DATABASE_URL_LOCAL = url;
process.env.REDIS_ENABLED = "false";
process.env.REDIS_URL = "";

const log = (...args) => console.log("[gate3]", ...args);
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
      name: "Gate 3 physical unit (real Pi agent, simulated ESP32)",
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
        declaredBy: "gate3 harness (disposable)",
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
              firmwareVersion: "robotx-pi-agent/gate3",
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

  /* 5. the real Pi agent, against the ESP32 host simulator */
  const PI_REPO = path.resolve(flag("--pi-repo", path.join(REPO, "..", "RobotX-Pi")));
  const SIM_EXE = path.resolve(flag("--sim-exe", path.join(os.tmpdir(), "rover_host_build", process.platform === "win32" ? "rover_sim.exe" : "rover_sim")));
  const PYTHON = process.platform === "win32" ? path.join(PI_REPO, "venv", "Scripts", "python.exe") : path.join(PI_REPO, "venv", "bin", "python");
  for (const [what, p] of [["Pi repository", PI_REPO], ["ESP32 host simulator", SIM_EXE], ["Pi venv python", PYTHON]]) {
    if (!fs.existsSync(p)) throw new Error(`${what} not found: ${p}`);
  }
  const reportFile = path.join(SCRATCH, "gate3-pi-report.json");
  log("starting the real Pi agent (ESP32 host simulator, no UART)");
  const piLog = fs.openSync(path.join(SCRATCH, "pi.log"), "w");
  let markReady;
  const piReady = new Promise((resolve) => { markReady = resolve; });
  const piExit = new Promise((resolve) => {
    const child = spawn(PYTHON, ["-m", "tests.integration.gate3_harness"], {
      cwd: PI_REPO,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
        ROBOTX_ROBOT_ID: ROBOT_ID,
        ROBOTX_LOG_LEVEL: "INFO",
        ROBOTX_SOCKET_ENABLED: "1",
        ROBOTX_SOCKET_SERVER_URL: BASE,
        ROBOTX_PAIRING_CODE: String(pairingCode),
        ROBOTX_COMMAND_SIGNING_KEY: SIGNING_KEY,
        ROBOTX_BACKEND_TOKEN_PATH: path.join(SCRATCH, "pi-session.json"),
        ROBOTX_COMMITMENT_STATE_PATH: path.join(SCRATCH, "pi-commitments.json"),
        ROBOTX_CAMERA_ENABLED: "0",
        ROBOTX_PERCEPTION_ENABLED: "0",
        ROBOTX_GPS_ENABLED: "1",
        ROBOTX_GPS_SOURCE: "esp32",
        ROBOTX_ESP32_ENABLED: "1",
        ROBOTX_ESP32_TRANSMIT_ENABLED: "1",
        ROBOTX_ESP32_MOTION_ENABLED: "1",
        ROBOTX_ESP32_SIMULATOR_EXE: SIM_EXE,
        ROBOTX_CUSTODY_CONFIRMATION: "operator",
        SIM_DRIVE_AVAILABLE: "1",
        SIM_FRONT_CM_FILE: path.join(SCRATCH, "sim-front-cm.txt"),
        GATE3_LAT: String(at.lat),
        GATE3_LON: String(at.lon),
        GATE3_REPORT: reportFile,
        GATE3_TIMEOUT_S: "200",
      },
    });
    child.stdout.on("data", (chunk) => {
      fs.writeSync(piLog, chunk);
      for (const line of String(chunk).split("\n")) {
        if (line.startsWith("[gate3]")) log("pi:", line.replace("[gate3] ", ""));
        if (line.startsWith("[gate3] ready")) markReady(true);
      }
    });
    child.stderr.on("data", (chunk) => fs.writeSync(piLog, chunk));
    const timer = setTimeout(() => child.kill(), 420_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      markReady(false);
      resolve({ status: code });
    });
  });


  /* 5b. tasks, once the Pi is up — until the physical unit is offered one */
  const ready = await Promise.race([piReady, sleep(90_000).then(() => false)]);
  log("Pi agent ready:", ready);
  const pairs = [
    ["rnsit-innovation-center", "rnsit-food-court"],
    ["rnsit-canara-bank", "rnsit-innovation-center"],
    ["rnsit-food-court", "rnsit-canara-bank"],
  ];
  const { getPrisma: getPrismaForWatch } = require(path.join(BACKEND, "src/db/prisma"));
  const watch = getPrismaForWatch();
  const watchAgent = await watch.agent.findUnique({ where: { agentId: ROBOT_ID } });
  const offered = async () => (await watch.outbox.count({ where: { agentId: watchAgent.id, command: "OFFER" } })) > 0;
  if (ready) {
    await sleep(12_000); // index sweep + probe window
    for (let i = 0; i < pairs.length && !(await offered()); i += 1) {
      const [from, to] = pairs[i];
      const created = await api("POST", "/api/tasks/assign", {
        taskId: `GATE3-TASK-${i + 1}-${Date.now()}`,
        pickup: from, drop: to,
        pickupLat: POINTS[from].lat, pickupLon: POINTS[from].lon,
        dropLat: POINTS[to].lat, dropLon: POINTS[to].lon,
        regionId: "rnsit",
      });
      log(`task ${i + 1} ${from} → ${to}:`, created.status, created.text.slice(0, 120));
      for (let w = 0; w < 45 && !(await offered()); w += 1) await sleep(1000);
    }
  }
  const pi = await piExit;
  const piReport = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, "utf8")) : null;

  /* 6. what the database shows */
  const prisma2 = require(path.join(BACKEND, "src/db/prisma")).getPrisma();
  const agentRow = await prisma2.agent.findUnique({ where: { agentId: ROBOT_ID } });
  const fixes = await prisma2.observation.findMany({ where: { agentId: agentRow.id, kind: "position" }, orderBy: { observedAt: "desc" }, take: 3 });
  const latch = await prisma2.observation.findMany({ where: { agentId: agentRow.id, kind: "emergency_stop" }, orderBy: { observedAt: "asc" }, select: { value: true } });
  const outbox = await prisma2.outbox.findMany({ where: { agentId: agentRow.id }, select: { command: true, state: true, fence: true } });
  const commitments = await prisma2.commitment.findMany({ where: { agentId: agentRow.id }, select: { legId: true } });
  const legs = commitments.length ? await prisma2.leg.findMany({ where: { id: { in: commitments.map((c) => c.legId) } }, select: { legId: true, state: true } }) : [];
  const db = {
    positionObservations: await prisma2.observation.count({ where: { agentId: agentRow.id, kind: "position" } }),
    latestFix: fixes[0] ? { provenance: fixes[0].value.provenance, fixType: fixes[0].value.fixType || null, hAccM: fixes[0].uncertaintyRadiusM } : null,
    stopLatchHistory: latch.map((row) => row.value.engaged),
    outbox: outbox.map((row) => ({ ...row, fence: String(row.fence) })),
    legs,
  };
  await prisma2.$disconnect();
  stop();
  console.log(JSON.stringify({
    pi: piReport && piReport.checks,
    piAcks: piReport && piReport.acks,
    piDrives: piReport && piReport.drive_frames,
    esp32Telemetry: piReport && piReport.esp32_telemetry_samples,
    esp32Counters: piReport && piReport.esp32_counters,
    piBackendEvents: piReport && piReport.backend_events,
    db,
    logs: SCRATCH,
  }, (k, v) => (typeof v === "bigint" ? String(v) : v), 2));
  const backendOk =
    db.outbox.some((row) => row.command === "OFFER" && row.state === "ACKED") &&
    db.legs.some((leg) => leg.state !== "QUEUED") &&
    Boolean(db.latestFix) && db.latestFix.provenance === "PHYSICAL" && db.latestFix.fixType === "3D";
  const pass = pi.status === 0 && backendOk;
  log(pass ? "PASS — signed OFFER → real Pi agent → DRIVE → ESP32 simulator → ACK/telemetry, safety gate held" : `FAIL — pi exit ${pi.status}, backend checks ${backendOk}`);
  process.exit(pass ? 0 : 1);
}

main().catch((error) => {
  console.error("[gate3] error:", error && error.stack ? error.stack : error);
  process.exit(2);
});
