"use strict";

const path = require("path");
const fs = require("fs");
const { fork, spawn, spawnSync } = require("child_process");
const dotenv = require("dotenv");

const BACKEND_DIR = path.join(__dirname, "..");
dotenv.config({ path: path.join(BACKEND_DIR, ".env.benchmark") });

// Optional DB target override — e.g. pointing at PgBouncer instead of
// Postgres directly for pooling comparisons — plus optional pool-size
// override for connection-scaling sweeps. Both rewrite DATABASE_URL before
// anything reads it: this process's own PrismaClient (below) and the
// spawned server.js child, which inherits process.env verbatim (see
// startServer()).
if (process.env.BENCH_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.BENCH_DATABASE_URL;
}
const BENCH_POOL_SIZE = process.env.BENCH_POOL_SIZE ? Number(process.env.BENCH_POOL_SIZE) : null;
if (BENCH_POOL_SIZE) {
  const raw = process.env.DATABASE_URL;
  const stripped = raw.replace(/([?&])connection_limit=\d+/, "$1").replace(/[?&]$/, "");
  const sep = stripped.includes("?") ? "&" : "?";
  process.env.DATABASE_URL = `${stripped}${sep}connection_limit=${BENCH_POOL_SIZE}`;
}

const { PrismaClient } = require("@prisma/client");
const Redis = require("ioredis");
const { io: ioClient } = require("socket.io-client");

const { resetAndSeed, robotIdFor } = require("./dbReset");
const { sampleProcess, sampleRedis, samplePostgres, sampleHealth, summarize } = require("./systemMetrics");

const STAGE = process.env.BENCH_STAGE || "adhoc";
const RESULTS_DIR = path.join(__dirname, "results", STAGE);
fs.mkdirSync(RESULTS_DIR, { recursive: true });

// BENCH_WORKERS>1 puts N independent server.js processes (own ports, own
// event loop, own Prisma pool) behind an Nginx reverse proxy on the harness's
// usual PORT — the rest of this file (BASE_URL, adminLogin, robotWorker
// connections, REST polling) is completely unchanged and keeps talking to
// PORT, now transparently load-balanced. See startServers()/nginx helpers
// below for the actual process/container management.
const WORKER_COUNT = Math.max(1, Number(process.env.BENCH_WORKERS || 1));
const WORKER_BASE_PORT = Number(process.env.WORKER_BASE_PORT || 4101);
const HARNESS_PORT = Number(process.env.PORT || 4100);

const BASE_URL = `http://127.0.0.1:${HARNESS_PORT}`;
const CHUNK_SIZE = 300;
const WARMUP_MS = Number(process.env.BENCH_WARMUP_MS || 15_000);
const DURATION_MS = Number(process.env.BENCH_DURATION_MS || 75_000);
const SAMPLE_INTERVAL_MS = 2000;
const ASSIGN_INTERVAL_MS = Number(process.env.BENCH_ASSIGN_INTERVAL_MS || 3000);
const READ_INTERVAL_MS = 5000;
const PROBE_COUNT = 8;

const TIERS = (process.argv[2] ? process.argv[2].split(",") : ["100", "500", "1000", "5000"]).map(Number);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ── Server process lifecycle ─────────────────────────────────────────────────

function startOneServer(tierCount, port, label) {
  const logPath = path.join(RESULTS_DIR, `server-tier-${tierCount}${label ? `-${label}` : ""}.log`);
  const logStream = fs.createWriteStream(logPath);
  // BENCH_PROFILE wraps the server in a CPU profiler.
  // "prof" -> V8's --prof (tick log, processed with --prof-process into a
  // text report; flushes fine under process.exit()).
  // "cpuprof" -> profiledServer.js, an in-process inspector-based wrapper
  // producing a .cpuprofile (Chrome DevTools / speedscope flame-graph
  // format). NOT the plain --cpu-prof CLI flag — that flag's write is async
  // and does not survive server.js's SIGTERM handler calling process.exit()
  // directly (confirmed by repro: silently produces no file at all).
  // Output lands in RESULTS_DIR (keyed by pid/tier) instead of BACKEND_DIR
  // so profiling runs don't collide with normal runs or each other.
  const env = { ...process.env, PORT: String(port) };
  let script = "server.js";
  let nodeArgs = [];
  if (process.env.BENCH_PROFILE === "prof") {
    nodeArgs = ["--prof", `--logfile=${path.join(RESULTS_DIR, `isolate-%p${label ? `-${label}` : ""}-v8.log`)}`];
  } else if (process.env.BENCH_PROFILE === "cpuprof") {
    script = path.join(__dirname, "profiledServer.js");
    env.CPU_PROF_OUT = path.join(RESULTS_DIR, `tier-${tierCount}${label ? `-${label}` : ""}.cpuprofile`);
  }
  nodeArgs.push(script);
  const child = spawn(process.execPath, nodeArgs, {
    cwd: BACKEND_DIR,
    env,
    // "ipc" lets stopServers() ask for a graceful shutdown via message
    // instead of an OS signal — child.kill("SIGTERM") on Windows is not a
    // real signal delivery, it's an abrupt TerminateProcess() (confirmed by
    // trace: no 'SIGTERM' listener or 'exit' handler ever ran). That's
    // harmless for normal/--prof runs but silently discards --cpu-prof's
    // buffered profile, which is only serialized at a graceful stop.
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  // Only profiledServer.js (cpuprof mode) listens for the IPC "shutdown"
  // message. Plain server.js / --prof runs have no such listener, so
  // stopServers() must still go straight to SIGTERM for them — otherwise
  // every tier would eat a dead 6s IPC timeout before falling back.
  child.usesIpcShutdown = process.env.BENCH_PROFILE === "cpuprof";
  child.port = port;
  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);
  child.on("error", (e) => log(`server process error (port ${port}): ${e.message}`));
  return { child, logPath, port };
}

async function startServers(tierCount) {
  if (WORKER_COUNT === 1) {
    return [startOneServer(tierCount, HARNESS_PORT, null)];
  }
  const servers = [];
  for (let i = 0; i < WORKER_COUNT; i++) {
    servers.push(startOneServer(tierCount, WORKER_BASE_PORT + i, `w${i}`));
  }
  return servers;
}

async function waitHealthyAt(url, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) {
        const body = await res.json();
        if (body.db === "ok" && body.redis === "ok") return true;
      }
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error(`Server at ${url} did not become healthy in time`);
}

async function waitAllHealthy(servers) {
  // Each worker directly first (catches a cold/broken worker immediately,
  // before it's hidden behind the load balancer), then through BASE_URL —
  // for WORKER_COUNT===1 this is the exact same single check as before.
  if (WORKER_COUNT > 1) {
    await Promise.all(servers.map((s) => waitHealthyAt(`http://127.0.0.1:${s.port}`)));
  }
  await waitHealthyAt(BASE_URL);
}

async function stopOneServer(child) {
  if (!child || child.exitCode !== null) return;
  // Ask for a graceful shutdown via IPC message first (see stdio "ipc" note
  // in startOneServer). child.kill("SIGTERM") on Windows does NOT deliver a
  // real signal — it's an abrupt TerminateProcess(), which would race the
  // IPC-triggered shutdown and kill the process before it can drain. Only
  // fall back to kill() if the graceful path doesn't finish in time.
  let sentIpc = false;
  if (child.usesIpcShutdown) {
    try { sentIpc = child.send?.({ type: "shutdown" }) ?? false; } catch { /* no ipc channel */ }
  }
  if (!sentIpc) child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    sleep(6000).then(() => false),
  ]);
  if (!exited) child.kill("SIGKILL");
}

async function stopServers(servers) {
  await Promise.all(servers.map((s) => stopOneServer(s.child)));
}

// ── Nginx (multi-worker only) ────────────────────────────────────────────────
// Round-robin across WORKER_COUNT server.js processes running on the host,
// reached from the container via host.docker.internal. No sticky-session
// config needed: benchmark/robotWorker.js connects with
// transports:["websocket"] only (no HTTP long-polling), so each robot's
// whole connection is one persistent TCP stream picked up by exactly one
// upstream at connect time — a plain round-robin LB is already "sticky" per
// connection. Cross-worker room broadcasts (dashboard updates, TASK_ASSIGN)
// are handled separately by the Socket.IO Redis adapter in server.js, not by
// anything here.
const NGINX_CONTAINER = "robotx-bench-nginx";

function writeNginxConfig() {
  const upstreams = Array.from({ length: WORKER_COUNT }, (_, i) => `    server host.docker.internal:${WORKER_BASE_PORT + i};`).join("\n");
  // nginx:alpine's compiled-in default is worker_connections 512 with 1
  // worker process — and a proxied WebSocket burns 2 connections (client
  // side + upstream side), so the *effective* concurrent-connection ceiling
  // is ~256 regardless of fleet size or backend worker count. Confirmed by
  // repro: both 2-worker and 4-worker runs plateaued at ~254 robots
  // authenticated, independent of tier (2000 or 5000) or worker count —
  // the signature of a fixed proxy-side cap, not a backend limit. Explicit,
  // generous values here so nginx is never the bottleneck being measured.
  const conf = `worker_processes auto;
worker_rlimit_nofile 65535;
events {
  worker_connections 16384;
}
http {
  upstream robotx_backend {
${upstreams}
  }
  server {
    listen 80;
    location / {
      proxy_pass http://robotx_backend;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
      proxy_set_header Host $host;
      proxy_set_header X-Real-IP $remote_addr;
      proxy_read_timeout 3600s;
      proxy_send_timeout 3600s;
    }
  }
}
`;
  const confPath = path.join(RESULTS_DIR, "nginx.conf");
  fs.writeFileSync(confPath, conf);
  return confPath;
}

function dockerRunSync(args) {
  return spawnSync("docker", args, { encoding: "utf8" });
}

async function startNginx() {
  const confPath = writeNginxConfig();
  dockerRunSync(["rm", "-f", NGINX_CONTAINER]);
  const res = dockerRunSync([
    "run", "-d", "--name", NGINX_CONTAINER,
    "-p", `${HARNESS_PORT}:80`,
    "-v", `${confPath}:/etc/nginx/nginx.conf:ro`,
    "nginx:alpine",
  ]);
  if (res.status !== 0) {
    throw new Error(`Failed to start nginx: ${res.stderr || res.stdout}`);
  }
  log(`Nginx up on :${HARNESS_PORT} -> ${WORKER_COUNT} workers on :${WORKER_BASE_PORT}-${WORKER_BASE_PORT + WORKER_COUNT - 1}`);
}

function stopNginx() {
  dockerRunSync(["rm", "-f", NGINX_CONTAINER]);
}

// ── Admin auth ────────────────────────────────────────────────────────────────

async function adminLogin() {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: process.env.SEED_ADMIN_EMAIL,
      password: process.env.SEED_ADMIN_PASSWORD,
    }),
  });
  if (!res.ok) throw new Error(`Admin login failed: ${res.status}`);
  let cookies = [];
  if (typeof res.headers.getSetCookie === "function") {
    cookies = res.headers.getSetCookie();
  } else {
    const raw = res.headers.get("set-cookie");
    if (raw) cookies = [raw];
  }
  for (const c of cookies) {
    const m = /token=([^;]+)/.exec(c);
    if (m) return decodeURIComponent(m[1]);
  }
  throw new Error("No token cookie in login response");
}

// ── Worker fleet management ──────────────────────────────────────────────────

async function forkWorkers(robotIds, probeRobotIds) {
  const workers = [];
  let workerIdx = 0;
  for (let start = 0; start < robotIds.length; start += CHUNK_SIZE) {
    const slice = robotIds.slice(start, start + CHUNK_SIZE);
    const sliceProbeSet = new Set(probeRobotIds);
    const sliceProbes = slice.filter((id) => sliceProbeSet.has(id));
    const child = fork(path.join(__dirname, "robotWorker.js"), [], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const entry = { child, size: slice.length, authedCount: 0 };
    workers.push(entry);
    child.send({
      type: "start",
      config: {
        robotIds: slice,
        serverUrl: BASE_URL,
        tickMs: 2000,
        reportIntervalMs: 1000,
        probeRobotIds: sliceProbes,
        connectStaggerMs: 30,
      },
    });
    workerIdx++;
    if (workerIdx % 3 === 0) await sleep(400); // gentle stagger between worker batches
  }
  return workers;
}

async function stopWorkers(workers) {
  for (const w of workers) {
    try { w.child.send({ type: "stop" }); } catch { /* ignore */ }
  }
  await sleep(500);
  for (const w of workers) {
    try { w.child.kill("SIGKILL"); } catch { /* ignore */ }
  }
}

// ── One full tier run ─────────────────────────────────────────────────────────

async function runTier(prisma, redis, tierCount) {
  log(`=== TIER ${tierCount} robots — reset & seed ===`);
  const robotIds = await resetAndSeed(prisma, redis, tierCount);

  log(`Starting server${WORKER_COUNT > 1 ? `s (${WORKER_COUNT} workers)` : ""}…`);
  const servers = await startServers(tierCount);
  await waitAllHealthy(servers);
  log(`Server${WORKER_COUNT > 1 ? "s" : ""} healthy (pid${WORKER_COUNT > 1 ? "s" : ""} ${servers.map((s) => s.child.pid).join(", ")})`);

  const jwtToken = await adminLogin();

  const probeRobotIds = robotIds.slice(0, Math.min(PROBE_COUNT, robotIds.length));
  const pendingProbe = new Map(); // robotId -> sentAt

  // Aggregated running totals across all workers (reset at measurement start)
  const totals = { telemetrySent: 0, heartbeatSent: 0, taskAssignReceived: 0, taskCompleteSent: 0 };
  let measuring = false;
  const telemetryLatencySamples = [];

  const workers = await forkWorkers(robotIds, probeRobotIds);
  for (const w of workers) {
    w.child.on("message", (msg) => {
      if (msg?.type === "stats") {
        w.authedCount = msg.authedCount;
        if (measuring) {
          totals.telemetrySent += msg.telemetrySent;
          totals.heartbeatSent += msg.heartbeatSent;
          totals.taskAssignReceived += msg.taskAssignReceived;
          totals.taskCompleteSent += msg.taskCompleteSent;
        }
      } else if (msg?.type === "probeSent") {
        pendingProbe.set(msg.robotId, msg.sentAt);
      }
    });
  }

  // Monitor / dashboard socket — joins the "dashboard" room to observe
  // broadcast fan-out (robot:update) and task-assignment lifecycle events.
  let broadcastCount = 0;
  const pendingAssign = new Map(); // taskId -> t0
  const assignLatencySamples = [];
  const assignOutcomes = { assigned: 0, failed: 0, timedOut: 0 };

  const monitorSocket = ioClient(BASE_URL, {
    transports: ["websocket"],
    reconnection: true,
    extraHeaders: { origin: process.env.FRONTEND_URL || "http://localhost:5173" },
    auth: { token: jwtToken },
  });

  monitorSocket.on("robot:update", (payload) => {
    if (measuring) broadcastCount++;
    const robotId = payload?.robotId;
    if (!robotId) return;
    const sentAt = pendingProbe.get(robotId);
    if (typeof sentAt === "number") {
      telemetryLatencySamples.push(Date.now() - sentAt);
      pendingProbe.delete(robotId);
    }
  });

  monitorSocket.on("TASK_UPDATED", (payload) => {
    const taskId = payload?.taskId;
    if (!taskId || !pendingAssign.has(taskId)) return;
    if (payload.status === "ASSIGNED") {
      assignLatencySamples.push(Date.now() - pendingAssign.get(taskId));
      assignOutcomes.assigned++;
      pendingAssign.delete(taskId);
    } else if (payload.status === "FAILED") {
      assignOutcomes.failed++;
      pendingAssign.delete(taskId);
    }
  });

  await new Promise((resolve) => {
    monitorSocket.on("connect", resolve);
    monitorSocket.on("connect_error", (e) => { log(`monitor socket connect_error: ${e.message}`); resolve(); });
    setTimeout(resolve, 8000);
  });

  // Wait for the fleet to authenticate. Generous ceiling — connection
  // ramp-up rate itself is a metric we want to observe honestly rather than
  // truncate, so this waits for a real plateau (no auth progress for 10s)
  // rather than assuming a fixed duration is enough at high tiers.
  log(`Waiting for fleet AUTH (${tierCount} robots across ${workers.length} workers)…`);
  const authTimeoutMs = Math.min(300_000, Math.max(30_000, tierCount * 300));
  const authStart = Date.now();
  let authedTotal = 0;
  let lastProgressAt = Date.now();
  let lastAuthedTotal = -1;
  while (Date.now() - authStart < authTimeoutMs) {
    authedTotal = workers.reduce((sum, w) => sum + w.authedCount, 0);
    if (authedTotal >= tierCount * 0.95) break;
    if (authedTotal !== lastAuthedTotal) {
      lastAuthedTotal = authedTotal;
      lastProgressAt = Date.now();
    } else if (Date.now() - lastProgressAt > 10_000) {
      log(`AUTH progress plateaued at ${authedTotal}/${tierCount} — proceeding`);
      break;
    }
    await sleep(1000);
  }
  authedTotal = workers.reduce((sum, w) => sum + w.authedCount, 0);
  const rampUpMs = Date.now() - authStart;
  log(`Fleet AUTH: ${authedTotal}/${tierCount} (${((authedTotal / tierCount) * 100).toFixed(1)}%) after ${(rampUpMs / 1000).toFixed(1)}s`);

  log(`Warmup ${WARMUP_MS / 1000}s…`);
  await sleep(WARMUP_MS);

  log(`Measurement window ${DURATION_MS / 1000}s…`);
  measuring = true;
  totals.telemetrySent = 0;
  totals.heartbeatSent = 0;
  totals.taskAssignReceived = 0;
  totals.taskCompleteSent = 0;
  broadcastCount = 0;
  telemetryLatencySamples.length = 0;
  assignLatencySamples.length = 0;
  assignOutcomes.assigned = 0;
  assignOutcomes.failed = 0;
  assignOutcomes.timedOut = 0;

  const resourceSamples = { cpuPercent: [], memoryBytes: [], redisOpsPerSec: [], redisInstOpsPerSec: [], pgWritesPerSec: [], pgXactPerSec: [], pgNumBackends: [], eventLoopP95Ms: [], eventLoopMeanMs: [], poolConnectionsOpen: [], poolConnectionsBusy: [], poolQueriesWaitAvgMs: [] };
  const restLatency = { assign: [], robotsState: [], health: [] };
  let restRequestCount = 0;
  let assignAttempts = 0;

  let lastRedisSample = await sampleRedis(redis);
  let lastPgSample = await samplePostgres(prisma);
  let lastSampleAt = Date.now();

  const sampleTimer = setInterval(async () => {
    const now = Date.now();
    const dtSec = (now - lastSampleAt) / 1000;
    lastSampleAt = now;

    // Fleet-wide totals across all worker processes — the fair comparison
    // point against a single process's own cpuPercent/memoryBytes (same
    // units, just summed instead of a single PID).
    const procs = await Promise.all(servers.map((s) => sampleProcess(s.child.pid)));
    if (process.env.BENCH_DEBUG_SAMPLE) log(`DEBUG sample: pids=${servers.map((s)=>s.child.pid).join(",")} procs=${JSON.stringify(procs)}`);
    const liveProcs = procs.filter(Boolean);
    if (liveProcs.length) {
      resourceSamples.cpuPercent.push(liveProcs.reduce((a, p) => a + p.cpuPercent, 0));
      resourceSamples.memoryBytes.push(liveProcs.reduce((a, p) => a + p.memoryBytes, 0));
    }

    const redisNow = await sampleRedis(redis);
    if (redisNow && lastRedisSample) {
      const delta = redisNow.totalCommandsProcessed - lastRedisSample.totalCommandsProcessed;
      resourceSamples.redisOpsPerSec.push(dtSec > 0 ? delta / dtSec : 0);
      resourceSamples.redisInstOpsPerSec.push(redisNow.instantaneousOpsPerSec);
    }
    lastRedisSample = redisNow;

    const pgNow = await samplePostgres(prisma);
    if (pgNow && lastPgSample) {
      const writeDelta = (pgNow.tupInserted - lastPgSample.tupInserted) + (pgNow.tupUpdated - lastPgSample.tupUpdated) + (pgNow.tupDeleted - lastPgSample.tupDeleted);
      const xactDelta = pgNow.xactCommit - lastPgSample.xactCommit;
      resourceSamples.pgWritesPerSec.push(dtSec > 0 ? writeDelta / dtSec : 0);
      resourceSamples.pgXactPerSec.push(dtSec > 0 ? xactDelta / dtSec : 0);
      resourceSamples.pgNumBackends.push(pgNow.numBackends);
    }
    lastPgSample = pgNow;

    // Each worker's own /health, hit directly (not through nginx) so a
    // lagging worker can't hide behind a healthy one. Every worker's reading
    // this tick feeds the same arrays, so summarize()'s avg is a fleet-wide
    // average and its max is the worst single worker observed at any tick —
    // for WORKER_COUNT===1 this is exactly the single sampleHealth(BASE_URL)
    // call it replaces.
    const healths = await Promise.all(servers.map((s) => sampleHealth(`http://127.0.0.1:${s.port}`)));
    for (const health of healths) {
      if (health?.eventLoopDelay) {
        resourceSamples.eventLoopP95Ms.push(health.eventLoopDelay.p95Ms);
        resourceSamples.eventLoopMeanMs.push(health.eventLoopDelay.meanMs);
      }
      if (health?.prismaPool) {
        if (typeof health.prismaPool.connectionsOpen === "number") resourceSamples.poolConnectionsOpen.push(health.prismaPool.connectionsOpen);
        if (typeof health.prismaPool.connectionsBusy === "number") resourceSamples.poolConnectionsBusy.push(health.prismaPool.connectionsBusy);
        if (typeof health.prismaPool.queriesWaitAvgMs === "number") resourceSamples.poolQueriesWaitAvgMs.push(health.prismaPool.queriesWaitAvgMs);
      }
    }
  }, SAMPLE_INTERVAL_MS);

  let assignCounter = 0;
  const assignTimer = setInterval(async () => {
    if (assignCounter >= robotIds.length) return;
    const targetRobotId = robotIds[assignCounter++];
    const taskId = `BENCH-TSK-${Date.now()}-${assignCounter}`;
    const t0 = Date.now();
    pendingAssign.set(taskId, t0);
    assignAttempts++;
    restRequestCount++;
    try {
      const res = await fetch(`${BASE_URL}/api/tasks/assign`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwtToken}` },
        body: JSON.stringify({
          taskId,
          robotId: targetRobotId,
          pickup: "Bench Pickup", pickupLat: 12.9053, pickupLon: 77.5216,
          drop: "Bench Drop", dropLat: 12.8983, dropLon: 77.5246,
        }),
      });
      restLatency.assign.push(Date.now() - t0);
      if (!res.ok) { assignOutcomes.failed++; pendingAssign.delete(taskId); }
      setTimeout(() => {
        if (pendingAssign.has(taskId)) { assignOutcomes.timedOut++; pendingAssign.delete(taskId); }
      }, 10_000);
    } catch {
      restLatency.assign.push(Date.now() - t0);
      assignOutcomes.failed++;
      pendingAssign.delete(taskId);
    }
  }, ASSIGN_INTERVAL_MS);

  const readTimer = setInterval(async () => {
    restRequestCount++;
    const t0 = Date.now();
    try {
      const res = await fetch(`${BASE_URL}/api/robots/state`, { headers: { Authorization: `Bearer ${jwtToken}` } });
      await res.text();
      restLatency.robotsState.push(Date.now() - t0);
    } catch { /* ignore */ }

    restRequestCount++;
    const t1 = Date.now();
    try {
      const res2 = await fetch(`${BASE_URL}/health`);
      await res2.text();
      restLatency.health.push(Date.now() - t1);
    } catch { /* ignore */ }
  }, READ_INTERVAL_MS);

  await sleep(DURATION_MS);

  measuring = false;
  clearInterval(sampleTimer);
  clearInterval(assignTimer);
  clearInterval(readTimer);

  const measuredSeconds = DURATION_MS / 1000;
  const socketInboundTotal = totals.telemetrySent + totals.heartbeatSent;

  const result = {
    tier: tierCount,
    poolSize: BENCH_POOL_SIZE || 20,
    workers: WORKER_COUNT,
    timestamp: new Date().toISOString(),
    connection: { targetCount: tierCount, authedFinal: authedTotal, authRatio: authedTotal / tierCount, rampUpMs },
    duration: { warmupMs: WARMUP_MS, measurementMs: DURATION_MS },
    throughput: {
      restRequestsPerSec: Math.round((restRequestCount / measuredSeconds) * 100) / 100,
      socketInboundMsgPerSec: Math.round((socketInboundTotal / measuredSeconds) * 100) / 100,
      telemetryMsgPerSec: Math.round((totals.telemetrySent / measuredSeconds) * 100) / 100,
      heartbeatMsgPerSec: Math.round((totals.heartbeatSent / measuredSeconds) * 100) / 100,
      dashboardBroadcastPerSec: Math.round((broadcastCount / measuredSeconds) * 100) / 100,
    },
    latency: {
      assignmentEndToEndMs: summarize(assignLatencySamples),
      assignRestResponseMs: summarize(restLatency.assign),
      telemetryToDashboardMs: summarize(telemetryLatencySamples),
      robotsStateRestMs: summarize(restLatency.robotsState),
      healthRestMs: summarize(restLatency.health),
    },
    resources: {
      serverProcess: {
        cpuPercentAvg: summarize(resourceSamples.cpuPercent).avg,
        cpuPercentMax: summarize(resourceSamples.cpuPercent).max,
        memoryMBAvg: resourceSamples.memoryBytes.length ? Math.round((resourceSamples.memoryBytes.reduce((a, b) => a + b, 0) / resourceSamples.memoryBytes.length) / 1e6) : null,
        memoryMBMax: resourceSamples.memoryBytes.length ? Math.round(Math.max(...resourceSamples.memoryBytes) / 1e6) : null,
      },
      redis: {
        opsPerSecAvg: summarize(resourceSamples.redisOpsPerSec).avg,
        opsPerSecMax: summarize(resourceSamples.redisOpsPerSec).max,
        instantaneousOpsPerSecAvg: summarize(resourceSamples.redisInstOpsPerSec).avg,
      },
      postgres: {
        writesPerSecAvg: summarize(resourceSamples.pgWritesPerSec).avg,
        writesPerSecMax: summarize(resourceSamples.pgWritesPerSec).max,
        xactPerSecAvg: summarize(resourceSamples.pgXactPerSec).avg,
        numBackendsAvg: summarize(resourceSamples.pgNumBackends).avg,
      },
      eventLoop: {
        p95MsAvg: summarize(resourceSamples.eventLoopP95Ms).avg,
        p95MsMax: summarize(resourceSamples.eventLoopP95Ms).max,
        meanMsAvg: summarize(resourceSamples.eventLoopMeanMs).avg,
      },
      prismaPool: {
        connectionsOpenAvg: summarize(resourceSamples.poolConnectionsOpen).avg,
        connectionsBusyAvg: summarize(resourceSamples.poolConnectionsBusy).avg,
        connectionsBusyMax: summarize(resourceSamples.poolConnectionsBusy).max,
        queriesWaitAvgMs: summarize(resourceSamples.poolQueriesWaitAvgMs).avg,
        queriesWaitMaxMs: summarize(resourceSamples.poolQueriesWaitAvgMs).max,
      },
    },
    counts: {
      telemetryReceivedTotal: totals.telemetrySent,
      heartbeatReceivedTotal: totals.heartbeatSent,
      taskAssignAttempts: assignAttempts,
      taskAssignSucceeded: assignOutcomes.assigned,
      taskAssignFailed: assignOutcomes.failed,
      taskAssignTimedOut: assignOutcomes.timedOut,
    },
  };

  fs.writeFileSync(path.join(RESULTS_DIR, `tier-${tierCount}.json`), JSON.stringify(result, null, 2));
  log(`Tier ${tierCount} done. authRatio=${(result.connection.authRatio * 100).toFixed(1)}% assign p50/p95=${result.latency.assignmentEndToEndMs.p50}/${result.latency.assignmentEndToEndMs.p95}ms`);

  try { monitorSocket.disconnect(); } catch { /* ignore */ }
  await stopWorkers(workers);
  await stopServers(servers);
  await sleep(2000);

  return result;
}

async function main() {
  const prisma = new PrismaClient();
  const redis = new Redis(process.env.REDIS_URL);

  if (WORKER_COUNT > 1) {
    await startNginx();
  }

  const summary = [];
  for (const tierCount of TIERS) {
    try {
      const result = await runTier(prisma, redis, tierCount);
      summary.push(result);
    } catch (e) {
      log(`TIER ${tierCount} FAILED: ${e.stack || e.message}`);
      summary.push({ tier: tierCount, error: e.message });
    }
  }

  fs.writeFileSync(path.join(RESULTS_DIR, "summary.json"), JSON.stringify(summary, null, 2));
  log("All tiers complete. Summary written to benchmark/results/summary.json");

  if (WORKER_COUNT > 1) {
    stopNginx();
  }

  await redis.quit();
  await prisma.$disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
