"use strict";

/**
 * **The V1 demonstration, end to end, on the real path — and its regression gate.**
 *
 *   Task → intake → WorkQueue → coordinator → candidates → §7.5 feasibility → plan →
 *   Φ/γ ranking → solve → §10.3.2 commit → OFFER → VirtualRobot ACCEPT → execution →
 *   telemetry → TASK_COMPLETE → §12.5 verification → settlement
 *
 * ── What runs, and what does not ───────────────────────────────────────────
 * Everything that decides is the shipped code, composed exactly as `server.js` composes it
 * when `V1_DEMONSTRATION_COMPOSITION=true`:
 *   · robots via `robot.service.createRobotWithProjection` with `simulated: true` — the
 *     commissioning service the dashboard's `createSimulatedRobot` calls — under fixed
 *     robot codes so a run is repeatable;
 *   · a real socket.io server with the app's own handlers (`sockets/socket.server`);
 *   · real `VirtualRobot`s via `SimulationEngine`, which AUTH, stream telemetry, receive
 *     the OFFER over the socket and answer it;
 *   · tasks via `task.service.assignTask` (what `POST /api/tasks/assign` calls);
 *   · the real `leaderWorkers` lifecycle — coordinator loop, outbox dispatcher, timers —
 *     with `services/v1DemonstrationComposition` spread into its context.
 *
 * There is **no gate bypass, no injected candidate, no direct assignment**. The only
 * instrumentation is read-only observers (the feasibility gate's verdicts, the per-candidate
 * refusals handed back to candidate expansion, the outbox deliveries, and the robots'
 * inbound events); each changes no argument and no return value.
 *
 * The `failures` scenario additionally injects **robot-side** faults into named simulated
 * robots (one never answers an OFFER, one always rejects, one disappears mid-mission, one goes
 * offline). That changes what the *robot* does — which is the point: the engine's expiry,
 * NACK, lease and reassignment paths then have to handle it. No engine code is patched.
 *
 * ── Scenarios ──────────────────────────────────────────────────────────────
 *   baseline   6 robots, `--tasks` tasks (default 5) — the first proven run, unchanged
 *   A          10 robots, 10 tasks
 *   B          10 robots, 20 tasks
 *   failures   the Phase 8 failure cases, each asserted by name
 *
 * Exit code: 0 only when every invariant in `tools/demo/v1RunReport.js` holds AND the
 * scenario's own expectations are met; 1 otherwise; 2 for a refused invocation.
 *
 * Loopback PostgreSQL only; never the default port, never Neon, never a remote Redis.
 *
 * Usage:
 *   node tools/demo/runV1Assignment.js <postgres-url> [--scenario baseline|A|B|failures]
 *        [--tasks N] [--timeout-s S] [--seed N] [--json <path>]
 */

const url = process.argv[2];
const flag = (name, fallback) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? fallback : process.argv[at + 1];
};

function refuse(message) {
  process.stderr.write(`REFUSED: ${message}\n`);
  process.exit(2);
}
if (!url) refuse("usage: node tools/demo/runV1Assignment.js <postgres-url> [--scenario baseline|A|B|failures]");
let target;
try {
  target = new URL(url);
} catch {
  refuse(`"${url}" is not a parseable URL`);
}
if (!/^postgres(ql)?:$/u.test(target.protocol)) refuse(`protocol ${target.protocol} is not postgres`);
if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(target.hostname)) refuse(`host "${target.hostname}" is not loopback`);
if (target.port === "" || target.port === "5432") refuse("the default port is the developer's own cluster; use a throwaway one");

const SCENARIO = String(flag("--scenario", "baseline"));
if (!["baseline", "A", "B", "failures"].includes(SCENARIO)) refuse(`unknown scenario "${SCENARIO}"`);

process.env.DATABASE_URL = url;
process.env.DATABASE_URL_LOCAL = url;
process.env.REDIS_ENABLED = "false";
delete process.env.REDIS_URL;
process.env.ENABLE_VIRTUAL_SIMULATOR = "true";
process.env.V1_DEMONSTRATION_COMPOSITION = "true";
process.env.ENGINE_ENABLED = "true";
process.env.PRIVACY_SURROGATE_SECRET = process.env.PRIVACY_SURROGATE_SECRET || "v1-demonstration-run-secret";
process.env.PRIVACY_IDENTITY_KEY = process.env.PRIVACY_IDENTITY_KEY || "22".repeat(32);
process.env.COMMAND_SIGNING_KEY = process.env.COMMAND_SIGNING_KEY || "v1-demonstration-run-signing-key";
process.env.LOG_LEVEL = process.env.LOG_LEVEL || "warn";
// §12.5 completion verification thresholds — V1_DEMONSTRATION values, defined once in
// `tools/config/v1DemonstrationConfig.js` (the V1 server launcher sets the same ones).
// Without them verification is skipped and no Leg is ever settled.
const VERIFY_V1 = require("../config/v1DemonstrationConfig").VERIFICATION_THRESHOLDS;
for (const [name, value] of Object.entries(VERIFY_V1)) process.env[name] = process.env[name] || value;

const fs = require("fs");
const http = require("http");
const { Server } = require("socket.io");

const { getPrisma, runSerializable, selectForUpdate, isSerializationFailure } = require("../../src/db/prisma");
const { initKv } = require("../../src/cache/kv");
const initSocketServer = require("../../src/sockets/socket.server");
const { createVirtualRobotSimulator } = require("../../src/simulation/SimulationEngine");
const VirtualRobot = require("../../src/simulation/VirtualRobot");
const { outboxDeliveryArm } = require("../../src/services/commandDispatcher.service");

const configService = require("../../src/engine/config/service");
const taskService = require("../../src/services/task.service");
const chargingStatus = require("../../src/services/chargingStatus.service");
const indexMaintainer = require("../../src/workers/indexMaintainer.worker");
const leaderWorkers = require("../../src/workers/leaderWorkers");
const election = require("../../src/engine/shard/election");
const storeClock = require("../../src/engine/commitment/clock");
const feasibility = require("../../src/engine/feasibility/evaluate");
const expansion = require("../../src/engine/candidates/expansion");
const v1Composition = require("../../src/services/v1DemonstrationComposition");
const { haversineMeters } = require("../../src/utils/distance");

const seedTool = require("./seedV1Demonstration");
const report = require("./v1RunReport");

const SEED = Number(flag("--seed", "20260923"));
const JSON_OUT = flag("--json", null);
const SHARD_ID = "v1demo-shard";

const quiet = { info() {}, warn() {}, error() {}, debug() {}, child() { return quiet; } };
const say = (text) => process.stdout.write(`${text}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (process.env.V1_TRACE === "1") {
  const renewal = require("../../src/services/commitmentLeaseRenewal.service");
  const realRenew = renewal.renewFromHeartbeat;
  renewal.renewFromHeartbeat = async (input) => {
    const out = await realRenew(input).catch((e) => ({ threw: e && e.message }));
    say(`[trace] renewFromHeartbeat ${input && input.robotId} ${JSON.stringify(input && input.evidence)} → ${JSON.stringify(out)}`);
    return out;
  };
}

/* ── Read-only observers ───────────────────────────────────────────────────── */
const gateVerdicts = [];
const expansionRefusals = [];
const events = {};
const workerFailures = [];
const bump = (name) => {
  events[name] = (events[name] || 0) + 1;
};

const realGate = feasibility.gate;
feasibility.gate = function observedGate(candidate, context, options) {
  const outcome = realGate(candidate, context, options);
  gateVerdicts.push({
    agentId: context && context.agentSnapshot ? context.agentSnapshot.agentId : null,
    legId: context && context.mission ? context.mission.legId : null,
    feasible: outcome.feasible,
    denials: ((outcome.outcome && outcome.outcome.denials) || []).map((row) => ({
      id: row.predicateId,
      reason: row.result && row.result.reason ? String(row.result.reason).slice(0, 220) : null,
    })),
  });
  return outcome;
};

// The per-candidate verdict `evaluateExact` hands back to expansion, observed on its way
// through: this is where a pairing refused *before* the gate (no route, no plan) is visible.
const realExpand = expansion.expandCandidates;
expansion.expandCandidates = async function observedExpansion(input) {
  const inner = input && input.evaluateExact;
  if (typeof inner !== "function") return realExpand(input);
  return realExpand({
    ...input,
    evaluateExact: async (agentId, leg, agentSnapshot) => {
      const out = await inner(agentId, leg, agentSnapshot);
      if (out && out.feasible !== true && out.refusal && out.refusal !== "INFEASIBLE") {
        expansionRefusals.push({
          agentId: agentSnapshot ? agentSnapshot.agentId : String(agentId),
          legId: leg ? leg.legId : null,
          refusal: out.refusal,
          problems: (out.problems || []).slice(0, 3).map((p) => String(p).slice(0, 200)),
        });
      }
      return out;
    },
  });
};

/* ── Robot-side fault injection (failures scenario only) ───────────────────── */
const FAULTS = new Map();
const realRespond = VirtualRobot.prototype._respondToOffer;
VirtualRobot.prototype._respondToOffer = function faultAwareResponse(envelope) {
  const fault = FAULTS.get(this.robotId);
  if (fault === "SILENT") return undefined; // this robot never answers; the OFFER must expire
  if (fault === "REJECT") {
    this.socket.emit("OFFER_REJECT", {
      commitmentId: envelope.commitmentId,
      fence: envelope.fence,
      robotId: this.robotId,
      reason: "V1_FAULT_INJECTION: robot declines",
    });
    return undefined;
  }
  return realRespond.call(this, envelope);
};

/* ── The campus ────────────────────────────────────────────────────────────── */
// Named points whose FINE cells are interior to the adopted RNSIT boundary. Main gate,
// playground-1 and parking lot are boundary cells the router refuses (RD-2026-08-30-01).
const INTERIOR = Object.freeze([
  "rnsit-innovation-center",
  "rnsit-pre-university-college",
  "rnsit-canara-bank",
  "rns-evening-college",
  "rnsit-food-court",
  "rnsit-playground-2",
  "rns-first-grade-college",
  "rnsit-cyber-security-department",
]);

/**
 * The first proven run's fleet, kept verbatim for `baseline` — defined once, in the seed
 * tool, so `seedV1Demonstration.js --fleet baseline` seeds the same six units for a
 * `server.js` world. The jobs stay here.
 */
const BASELINE_FLEET = seedTool.BASELINE_FLEET;
const BASELINE_JOBS = [
  ["rnsit-food-court", "rnsit-innovation-center"],
  ["rnsit-playground-2", "rnsit-canara-bank"],
  ["rnsit-pre-university-college", "rns-evening-college"],
  ["rns-first-grade-college", "rnsit-food-court"],
  ["rnsit-cyber-security-department", "rnsit-playground-2"],
];

/** Ten robots: eight healthy on the eight interior points, one boundary, one low. */
function tenRobotFleet() {
  const batteries = [90, 85, 80, 75, 95, 70, 88, 82];
  const fleet = INTERIOR.map((point, index) => ({
    code: `V1DEMO-${String(index + 1).padStart(2, "0")}`,
    point,
    batteryPct: batteries[index],
  }));
  fleet.push({ code: "V1DEMO-09", point: "rnsit-main-gate", batteryPct: 85, expect: "NEVER_ASSIGNED" });
  fleet.push({ code: "V1DEMO-10", point: "rnsit-cyber-security-department", batteryPct: 12, expect: "NEVER_ASSIGNED" });
  return fleet;
}

/**
 * N deterministic pickup → drop pairs over the interior points. A pair closer than the
 * arrival radius is not a delivery (`task.service` refuses it — two RNSIT points share one
 * coordinate), so the next offset is taken instead.
 */
function interiorJobs(count) {
  const { points } = seedTool.loadGeometry();
  const minSeparationM = Number(process.env.VERIFY_ARRIVAL_RADIUS_M);
  const apart = (a, b) => haversineMeters(points[a].lat, points[a].lon, points[b].lat, points[b].lon) > minSeparationM;
  const jobs = [];
  for (let index = 0; index < count; index += 1) {
    const from = INTERIOR[index % INTERIOR.length];
    let offset = 1 + (Math.floor(index / INTERIOR.length) % (INTERIOR.length - 1));
    let to = INTERIOR[(index % INTERIOR.length + offset) % INTERIOR.length];
    while (!apart(from, to)) {
      offset = (offset % (INTERIOR.length - 1)) + 1;
      to = INTERIOR[(index % INTERIOR.length + offset) % INTERIOR.length];
    }
    jobs.push([from, to]);
  }
  return jobs;
}

/**
 * The failures scenario. Each robot or task is here to make one failure happen for real.
 * `fault` is a robot-side behaviour; `expect` is what the run must observe.
 */
const FAILURE_FLEET = [
  { code: "V1F-OK-A", point: "rnsit-innovation-center", batteryPct: 90 },
  { code: "V1F-OK-B", point: "rnsit-canara-bank", batteryPct: 90 },
  { code: "V1F-OK-C", point: "rns-evening-college", batteryPct: 90 },
  { code: "V1F-LOW", point: "rnsit-cyber-security-department", batteryPct: 12, expect: "NEVER_ASSIGNED" },
  { code: "V1F-GATE", point: "rnsit-main-gate", batteryPct: 85, expect: "NEVER_ASSIGNED" },
  { code: "V1F-SILENT", point: "rnsit-food-court", batteryPct: 90, fault: "SILENT" },
  { code: "V1F-REJECT", point: "rnsit-playground-2", batteryPct: 90, fault: "REJECT" },
  { code: "V1F-DIES", point: "rnsit-pre-university-college", batteryPct: 90, fault: "DIES_AFTER_ACCEPT" },
  { code: "V1F-OFF", point: "rns-first-grade-college", batteryPct: 90, fault: "OFFLINE_BEFORE_TASKS", expect: "NEVER_ASSIGNED" },
];
const FAILURE_TASKS = [
  // Servable, placed so the faulty robot beside the pickup is the natural first choice.
  { taskId: "V1F-EXPIRE", from: "rnsit-food-court", to: "rnsit-innovation-center", servable: true },
  { taskId: "V1F-REJECTED", from: "rnsit-playground-2", to: "rnsit-canara-bank", servable: true },
  { taskId: "V1F-ABANDONED", from: "rnsit-pre-university-college", to: "rns-evening-college", servable: true },
  { taskId: "V1F-NEAR-OFFLINE", from: "rns-first-grade-college", to: "rnsit-food-court", servable: true },
  // Not servable by anyone in this fleet — each must wait, with its reason, not vanish.
  { taskId: "V1F-HEAVY", from: "rnsit-food-court", to: "rnsit-canara-bank", payload: { massKg: 10, massToleranceKg: 0 } },
  { taskId: "V1F-DRONE", from: "rnsit-canara-bank", to: "rnsit-food-court", requestedChassisType: "DRONE" },
  { taskId: "V1F-GATE-DROP", from: "rnsit-canara-bank", to: "rnsit-main-gate" },
];

function scenarioPlan() {
  if (SCENARIO === "A") return { fleet: tenRobotFleet(), jobs: interiorJobs(Number(flag("--tasks", "10"))), timeoutS: 900 };
  if (SCENARIO === "B") return { fleet: tenRobotFleet(), jobs: interiorJobs(Number(flag("--tasks", "20"))), timeoutS: 1500 };
  if (SCENARIO === "failures") return { fleet: FAILURE_FLEET, jobs: null, timeoutS: 900 };
  const count = Number(flag("--tasks", "5"));
  return { fleet: BASELINE_FLEET, jobs: Array.from({ length: count }, (_, i) => BASELINE_JOBS[i % BASELINE_JOBS.length]), timeoutS: 600 };
}

async function waitFor(check, timeoutMs, stepMs = 500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) return null;
    // eslint-disable-next-line no-await-in-loop
    await sleep(stepMs);
  }
}

/** Every robot through the real commissioning service, at a fixed code (the seed tool's). */
const commissionFleet = seedTool.commissionFleet;

async function main() {
  const plan = scenarioPlan();
  const TIMEOUT_MS = Number(flag("--timeout-s", String(plan.timeoutS))) * 1000;
  const prisma = getPrisma();
  const { kv } = await initKv({ logger: quiet });

  say("═══════════════════════════════════════════════════════════════════════");
  say(` V1 DEMONSTRATION — scenario ${SCENARIO} — real assignment path, simulated fleet`);
  say(`   ${target.hostname}:${target.port}${target.pathname}   seed ${SEED}   NOT PRODUCTION`);
  say("═══════════════════════════════════════════════════════════════════════");

  /* ── 1. World: region, zone, published index cover, shard, depot charger ── */
  const world = await seedTool.seedWorld(prisma, { shardId: SHARD_ID });
  say(`\n[world] region ${world.region.regionId}  shard ${SHARD_ID}  cover ${world.indexCover.length} cells  charger ${world.depot.chargerId}`);

  /* ── 2. Configuration: the 13 + the execution params, spatial, domain ───── */
  // One definition of what a demonstration publishes: the seed tool's, which the
  // `server.js` world is seeded with too (the 13 + execution params + spatial + domain +
  // the region's cutover binding, published and pinned).
  const { published } = await seedTool.publishConfiguration(prisma, world, {
    publishedBy: "tools/demo/runV1Assignment.js",
    note: "V1 DEMONSTRATION RUN (tools/demo/runV1Assignment.js).",
  });
  const pinned = await configService.loadPinnedSnapshot({ prisma });
  say(`[config] version ${published.version} pinned  (S2/V9 accommodation: labelled tool approvers — NOT a Safety approval)`);

  /* ── 3. Fleet, through the real commissioning service ───────────────────── */
  const owner = await prisma.user.findFirst({ where: { email: "v1-demonstration-seed@localhost" } });
  // The seeded unit is `V1DEMO-01` at the innovation centre; the failures fleet renames it.
  const fleet = plan.fleet.map((entry, index) => (index === 0 && SCENARIO !== "failures" ? entry : entry));
  if (SCENARIO === "failures") {
    fleet.unshift({ code: world.robot.robotId, point: "rnsit-innovation-center", batteryPct: 90, fault: "OFFLINE_BEFORE_TASKS", expect: "NEVER_ASSIGNED" });
  }
  await commissionFleet(prisma, world, fleet, owner.id);
  for (const entry of fleet) if (entry.fault === "SILENT" || entry.fault === "REJECT") FAULTS.set(entry.code, entry.fault);
  say(`[fleet] ${fleet.length} simulated robots: ${fleet.map((row) => `${row.code}@${row.point}(${row.batteryPct}%)${row.fault ? `[${row.fault}]` : ""}`).join("  ")}`);

  /* ── 4. Socket server + simulator: robots AUTH and stream telemetry ─────── */
  const httpServer = http.createServer();
  const io = new Server(httpServer, { cors: { origin: true, credentials: true } });
  // What `server.js` hands the socket layer: `app.locals`, carrying the pinned
  // configuration the offer handler's cutover gate reads (`agentGate.assess`).
  const appLocals = { config: pinned, kv };
  initSocketServer(io, { prisma, kv, appLocals, logger: quiet });
  // Read-only: count what the robots send the server.
  io.on("connection", (socket) => {
    socket.onAny((event) => {
      if (["OFFER_ACCEPT", "OFFER_REJECT", "OFFER_DEFER", "CUSTODY_EVENT", "TASK_COMPLETE"].includes(event)) bump(event);
    });
  });
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const serverUrl = `http://127.0.0.1:${httpServer.address().port}`;
  const simulator = createVirtualRobotSimulator({ prisma, kv, serverUrl, logger: quiet });
  // Deterministic robot behaviour: the run's seed, offset per robot id by the engine.
  simulator.setConfig({ randomSeed: SEED });
  simulator.start();
  for (const row of fleet) {
    const point = world.points[row.point];
    // eslint-disable-next-line no-await-in-loop
    await simulator.addRobot({ robotId: row.code, lat: point.lat, lon: point.lon });
  }
  const online = await waitFor(async () => {
    const rows = await prisma.robot.findMany({ where: { robotId: { in: fleet.map((row) => row.code) } }, select: { isOnline: true } });
    return rows.length === fleet.length && rows.every((row) => row.isOnline === true);
  }, 30000);
  say(`[sockets] ${online ? "all robots AUTHed over the real transport and are online" : "NOT all robots came online"}`);
  await sleep(3000); // two telemetry ticks → position Observations

  /* ── 5. Availability index: the real sweep, then the real worker ────────── */
  const chargingStatusFor = chargingStatus.createChargingStatusReader({
    prisma,
    inScope: async (subject) => simulator.managesAgent(subject) === true,
  });
  await indexMaintainer.sweepOnce({ prisma, kv, snapshot: pinned, chargingStatusFor });
  const indexWorker = indexMaintainer.start({ prisma, kv, snapshot: pinned, chargingStatusFor }, { intervalMs: 2000 });
  const mirrors = await prisma.agentCellPosition.count();
  say(`[index] ${mirrors} agents placed in the availability index`);

  // Readiness, not a bypass: an agent answers an OFFER only once its socket carries its
  // shard identity (`agentGate`), which AUTH resolves from `ShardMembership` and each
  // heartbeat flush re-resolves (15 s).
  const agentGate = require("../../src/engine/cutover/agentGate");
  const bound = await waitFor(async () => {
    const sockets = await io.fetchSockets();
    const robots = sockets.filter((sock) => sock.data && sock.data.robotId);
    const placed = new Set(
      (await prisma.agentCellPosition.findMany({ select: { agent: { select: { agentId: true } } } })).map((row) => row.agent.agentId),
    );
    return robots.length >= fleet.length && robots.filter((sock) => placed.has(sock.data.robotId)).every((sock) => {
      const identity = agentGate.identityOf(sock);
      return identity && identity.shardId === SHARD_ID;
    });
  }, 45000, 1000);
  say(`[sockets] ${bound ? "every indexed robot session is bound to its shard (agentGate)" : "NOT every robot session is bound to its shard"}`);

  // Case 4 — a robot that was online and indexed, then went offline before any task.
  for (const row of fleet.filter((entry) => entry.fault === "OFFLINE_BEFORE_TASKS")) {
    simulator.removeRobot(row.code);
    say(`[fault] ${row.code} taken offline (robot-side)`);
  }
  if (fleet.some((entry) => entry.fault === "OFFLINE_BEFORE_TASKS")) {
    await waitFor(async () => {
      const rows = await prisma.robot.findMany({ where: { robotId: { in: fleet.filter((e) => e.fault === "OFFLINE_BEFORE_TASKS").map((e) => e.code) } }, select: { isOnline: true } });
      return rows.every((row) => row.isOnline === false);
    }, 15000);
  }

  /* ── 6. Leadership for the shard, then the real LEADER_ONLY workers ─────── */
  const store = election.assertConsensusStore(
    election.postgresLeadershipStore(prisma, { replicationPosture: "SINGLE_PRIMARY_NO_AUTOMATIC_FAILOVER" }),
  );
  const session = await election.acquire(store, {
    shardId: SHARD_ID,
    candidateId: `v1demo:${process.pid}`,
    storeTime: await storeClock.readStoreTime(prisma),
    leaseDurationSeconds: 3600,
  });
  say(`[leader] ${session.state} fence ${String(session.leadershipFence)}`);

  const composition = v1Composition.createV1DemonstrationComposition({ prisma, kv, snapshot: () => pinned, env: process.env });
  const deliver = outboxDeliveryArm(io, { activeModes: () => [] });
  const lifecycle = leaderWorkers.create({
    prisma,
    kv,
    io,
    values: () => pinned.values,
    snapshot: () => pinned,
    shardId: SHARD_ID,
    regionId: world.region.regionId,
    instanceId: `v1demo:${process.pid}`,
    runInTransaction: (fn) => runSerializable(prisma, fn),
    runSerializable,
    selectForUpdate,
    isSerializationFailure,
    // Read-only: count what the outbox actually delivers, by command.
    deliver: async (agentSocketId, envelope) => {
      const out = await deliver(agentSocketId, envelope);
      if (out && out.delivered !== false && envelope && envelope.command) bump(envelope.command);
      return out;
    },
    signingKey: process.env.COMMAND_SIGNING_KEY,
    // Read-only: a worker that failed says so here rather than into a silenced logger.
    record: (event, detail) => {
      if (/failed/u.test(String(event))) workerFailures.push({ event, message: detail && detail.message ? String(detail.message).slice(0, 300) : null });
    },
    logger: quiet,
    ...composition,
  });
  const started = lifecycle.apply({ mayRunRound: true });
  say(`[workers] running: ${started.running.join(", ")}`);
  for (const refusal of started.refusals) say(`[workers] REFUSED ${refusal.worker}: ${String(refusal.blockedBy || refusal.refusal).slice(0, 300)}`);

  /* ── 7. Tasks, through the request path ─────────────────────────────────── */
  const tasks = [];
  const validation = [];
  const submit = async (spec) => {
    const pickup = world.points[spec.from];
    const drop = world.points[spec.to];
    const created = await taskService.assignTask(
      prisma,
      {
        taskId: spec.taskId,
        pickup: spec.from,
        pickupLat: pickup.lat,
        pickupLon: pickup.lon,
        drop: spec.to,
        dropLat: drop.lat,
        dropLon: drop.lon,
        ...(spec.payload ? { payload: spec.payload } : {}),
        ...(spec.requestedChassisType ? { requestedChassisType: spec.requestedChassisType } : {}),
      },
      { kv, io, config: pinned, regionId: world.region.regionId, slaClass: "STANDARD" },
    );
    tasks.push({ ...spec, taskId: created.taskId });
    say(`[task] ${created.taskId} ${spec.from} → ${spec.to}${spec.payload ? ` payload ${spec.payload.massKg} kg` : ""}${spec.requestedChassisType ? ` class ${spec.requestedChassisType}` : ""}`);
  };

  if (SCENARIO === "failures") {
    // Invalid submissions: refused at the request path, nothing written.
    for (const [name, bad] of [
      ["missing drop coordinates", { taskId: "V1F-INVALID-1", pickup: "a", drop: "b", pickupLat: 12.9, pickupLon: 77.5 }],
      ["unknown chassis class", { taskId: "V1F-INVALID-2", pickup: "a", drop: "b", pickupLat: 12.9, pickupLon: 77.5, dropLat: 12.91, dropLon: 77.51, requestedChassisType: "HOVERCRAFT" }],
      ["negative payload mass", { taskId: "V1F-INVALID-3", pickup: "a", drop: "b", pickupLat: 12.9, pickupLon: 77.5, dropLat: 12.91, dropLon: 77.51, payload: { massKg: -1, massToleranceKg: 0 } }],
      ["pickup equals drop", { taskId: "V1F-INVALID-4", pickup: "rns-evening-college", drop: "rns-first-grade-college", pickupLat: world.points["rns-evening-college"].lat, pickupLon: world.points["rns-evening-college"].lon, dropLat: world.points["rns-first-grade-college"].lat, dropLon: world.points["rns-first-grade-college"].lon }],
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const outcome = await taskService.assignTask(prisma, bad, { kv, io, config: pinned, regionId: world.region.regionId }).then(
        () => ({ refused: false }),
        (error) => ({ refused: true, status: error.status, message: String(error.message).slice(0, 160) }),
      );
      // eslint-disable-next-line no-await-in-loop
      const written = await prisma.task.count({ where: { taskId: bad.taskId } });
      validation.push({ name, ...outcome, written });
      say(`[validate] ${name}: ${outcome.refused ? `refused ${outcome.status} — ${outcome.message}` : "ACCEPTED (unexpected)"}; rows written ${written}`);
    }
    for (const spec of FAILURE_TASKS) {
      // eslint-disable-next-line no-await-in-loop
      await submit(spec);
    }
  } else {
    for (let index = 0; index < plan.jobs.length; index += 1) {
      const [from, to] = plan.jobs[index];
      // eslint-disable-next-line no-await-in-loop
      await submit({ taskId: `V1DEMO-TASK-${index + 1}`, from, to, servable: true });
    }
  }

  /* ── 8. Watch the lifecycle ─────────────────────────────────────────────── */
  const startedAt = Date.now();
  const dying = new Set(fleet.filter((entry) => entry.fault === "DIES_AFTER_ACCEPT").map((entry) => entry.code));
  const died = [];
  let last = "";
  const servable = tasks.filter((spec) => spec.servable).map((spec) => spec.taskId);
  const done = await waitFor(async () => {
    // Case 9 — a robot that accepted and then vanishes mid-mission (robot-side).
    for (const code of dying) {
      // eslint-disable-next-line no-await-in-loop
      const holding = await prisma.commitment.findFirst({
        where: { releasedAt: null, agent: { agentId: code }, leg: { state: { in: ["ACCEPTED", "EN_ROUTE_PICKUP", "AT_PICKUP", "LOADED", "EN_ROUTE_DROP"] } } },
        include: { leg: { select: { legId: true } } },
      });
      if (holding) {
        simulator.removeRobot(code);
        dying.delete(code);
        died.push({ code, legId: holding.leg.legId, commitmentId: holding.commitmentId });
        say(`[fault] ${code} disappeared while holding ${holding.leg.legId} (robot-side)`);
      }
    }
    const rows = await prisma.task.findMany({ where: { taskId: { in: tasks.map((t) => t.taskId) } }, select: { taskId: true, status: true } });
    const legs = await prisma.leg.findMany({ select: { state: true } });
    const liveCount = await prisma.commitment.count({ where: { releasedAt: null } });
    const byState = {};
    for (const leg of legs) byState[leg.state] = (byState[leg.state] || 0) + 1;
    const completed = rows.filter((row) => row.status === "COMPLETED").length;
    const line = `completed ${completed}/${rows.length} legs ${JSON.stringify(byState)} live=${liveCount} offers=${events.OFFER || 0} accepts=${events.OFFER_ACCEPT || 0} rejects=${events.OFFER_REJECT || 0}`;
    if (line !== last) {
      say(`[watch] t+${Math.round((Date.now() - startedAt) / 1000)}s ${line}`);
      last = line;
    }
    const servableDone = rows.filter((row) => servable.includes(row.taskId)).every((row) => row.status === "COMPLETED");
    return servableDone && liveCount === 0 ? true : null;
  }, TIMEOUT_MS, 1000);
  const elapsedS = Math.round((Date.now() - startedAt) / 1000);

  // Let an in-flight settlement land before the rows are read, then stop the workers.
  await sleep(2000);
  indexWorker.stop();
  lifecycle.stop();

  /* ── 9. Read back, check, report ────────────────────────────────────────── */
  const taskRows = await prisma.task.findMany({
    where: { taskId: { in: tasks.map((t) => t.taskId) } },
    select: { taskId: true, status: true, robot: { select: { robotId: true } } },
  });
  const legRows = (
    await prisma.leg.findMany({ select: { id: true, legId: true, state: true, mission: { select: { tasks: { select: { taskId: true } } } } } })
  ).map((row) => ({ ...row, taskIds: row.mission ? row.mission.tasks.map((task) => task.taskId) : [] }));
  const legByRowId = new Map(legRows.map((row) => [row.id, row]));
  const commitmentRows = await prisma.commitment.findMany({
    orderBy: { grantedAt: "asc" },
    include: { agent: { select: { agentId: true } }, leg: { select: { legId: true } } },
  });
  const queueRows = await prisma.workQueue.findMany({ select: { legId: true, state: true } });
  const verificationRows = await prisma.verificationEvidence.findMany({ select: { legId: true, outcome: true } });
  const legOfTask = (taskId) => legRows.find((row) => row.taskIds.includes(taskId)) || null;

  const invariants = report.checkInvariants({
    tasks: taskRows.map((row) => ({ taskId: row.taskId, status: row.status, robotId: row.robot ? row.robot.robotId : null, legId: (legOfTask(row.taskId) || {}).legId })),
    legs: legRows.map((row) => ({ legId: row.legId, state: row.state })),
    commitments: commitmentRows.map((row) => ({ commitmentId: row.commitmentId, agentId: row.agent.agentId, legId: row.leg.legId, grantedAt: row.grantedAt, releasedAt: row.releasedAt })),
    queueRows: queueRows.map((row) => ({ legId: (legByRowId.get(row.legId) || {}).legId, state: row.state })),
    verifications: verificationRows.map((row) => ({ legId: (legByRowId.get(row.legId) || {}).legId, outcome: row.outcome })),
    gateVerdicts,
    capacity: 1,
  });
  const summary = report.summarise({
    gateVerdicts,
    expansionRefusals,
    events,
    commitments: commitmentRows.map((row) => ({ agentId: row.agent.agentId })),
    outcomes: invariants.outcomes,
  });

  /* ── Scenario expectations ──────────────────────────────────────────────── */
  const expectations = [];
  const expect = (name, pass, detail) => expectations.push({ name, pass: Boolean(pass), detail });
  const committedAgents = new Set(commitmentRows.map((row) => row.agent.agentId));
  const denialsFor = (predicate) => gateVerdicts.filter((row) => !row.feasible && row.denials.some((d) => d.id === predicate));
  const outcomeOf = (taskId) => invariants.outcomes[taskId];
  const reasonsForTask = (taskId) => {
    const leg = legOfTask(taskId);
    const legId = leg ? leg.legId : null;
    const gate = new Set(gateVerdicts.filter((row) => row.legId === legId && !row.feasible).flatMap((row) => row.denials.map((d) => d.id)));
    const pre = new Set(expansionRefusals.filter((row) => row.legId === legId).map((row) => row.refusal));
    return { gate: [...gate].sort(), preGate: [...pre].sort(), feasibleEver: gateVerdicts.some((row) => row.legId === legId && row.feasible) };
  };

  for (const entry of fleet.filter((row) => row.expect === "NEVER_ASSIGNED")) {
    expect(`${entry.code} (${entry.point}, ${entry.batteryPct}%${entry.fault ? `, ${entry.fault}` : ""}) is never assigned`, !committedAgents.has(entry.code));
  }
  const low = fleet.find((row) => row.batteryPct <= 15);
  if (low) {
    // On every task it could otherwise do, energy is what refuses it (a DRONE or overweight
    // task is refused by F21/F22 first, which is also correct).
    const servableLegs = new Set(tasks.filter((spec) => spec.servable).map((spec) => `LEG-${spec.taskId}`));
    const lowDenials = gateVerdicts.filter((row) => row.agentId === low.code && !row.feasible && servableLegs.has(row.legId));
    const f34 = lowDenials.map((row) => row.denials.find((d) => d.id === "F34")).find(Boolean);
    expect(`case 1 — low battery: ${low.code} denied by F34 on every servable task`, lowDenials.length > 0 && lowDenials.every((row) => row.denials.some((d) => d.id === "F34")),
      f34 ? f34.reason : "no verdict for the low robot");
  }
  const gateRobot = fleet.find((row) => row.point === "rnsit-main-gate");
  if (gateRobot) {
    const refused = expansionRefusals.filter((row) => row.agentId === gateRobot.code);
    const gated = gateVerdicts.filter((row) => row.agentId === gateRobot.code && row.feasible);
    expect(`impossible geography: ${gateRobot.code} at the main gate is refused before the gate (no route)`, gated.length === 0,
      refused[0] ? `${refused[0].refusal}: ${refused[0].problems[0] || ""}` : "never reached evaluation (not a candidate)");
  }

  if (SCENARIO === "failures") {
    for (const row of validation) expect(`invalid task refused (${row.name})`, row.refused && row.status === 400 && row.written === 0, row.message);
    const heavy = reasonsForTask("V1F-HEAVY");
    expect("case 2 — payload too large: V1F-HEAVY is waiting, never feasible, denied by F22/F21",
      outcomeOf("V1F-HEAVY") === "WAITING" && !heavy.feasibleEver && (heavy.gate.includes("F22") || heavy.gate.includes("F21")), JSON.stringify(heavy));
    const drone = reasonsForTask("V1F-DRONE");
    expect("case 5 — capability: V1F-DRONE is waiting, never feasible, denied by F21",
      outcomeOf("V1F-DRONE") === "WAITING" && !drone.feasibleEver && drone.gate.includes("F21"), JSON.stringify(drone));
    const gateDrop = reasonsForTask("V1F-GATE-DROP");
    expect("case 10 — task cannot be served: V1F-GATE-DROP is waiting, never feasible",
      outcomeOf("V1F-GATE-DROP") === "WAITING" && !gateDrop.feasibleEver, JSON.stringify(gateDrop));
    const offlineCodes = fleet.filter((row) => row.fault === "OFFLINE_BEFORE_TASKS").map((row) => row.code);
    const offlineDenials = gateVerdicts.filter((row) => offlineCodes.includes(row.agentId) && !row.feasible);
    const offlineFeasible = gateVerdicts.filter((row) => offlineCodes.includes(row.agentId) && row.feasible);
    // The gate stops at its first denial: an offline robot reads F9 (Robot.status OFFLINE →
    // health tier QUARANTINED) or F13 (no live session), whichever it reaches first.
    expect("case 4 — offline robot: never assigned and never found feasible (dropped from the index, or F9/F13 where evaluated)",
      offlineCodes.every((code) => !committedAgents.has(code)) && offlineFeasible.length === 0 && offlineDenials.every((row) => row.denials.some((d) => d.id === "F13" || d.id === "F9")),
      `${offlineDenials.length} gate verdict(s) for the offline robots${offlineDenials.length ? `: ${[...new Set(offlineDenials.flatMap((r) => r.denials.map((d) => d.id)))].join(",")}` : " — excluded before the gate"}`);
    const silentOffers = commitmentRows.filter((row) => row.agent.agentId === "V1F-SILENT");
    expect("case 7 — OFFER expires: every V1F-SILENT commitment was released unanswered and its task completed by another robot",
      silentOffers.length > 0 && silentOffers.every((row) => row.releasedAt) &&
        silentOffers.every((row) => { const t = taskRows.find((task) => legOfTask(task.taskId)?.legId === row.leg.legId); return t && t.status === "COMPLETED" && t.robot && t.robot.robotId !== "V1F-SILENT"; }),
      `${silentOffers.length} offer(s) to the silent robot`);
    const rejectOffers = commitmentRows.filter((row) => row.agent.agentId === "V1F-REJECT");
    expect("case 8 — robot rejects OFFER: rejected, released, task completed by another robot",
      (events.OFFER_REJECT || 0) > 0 && rejectOffers.length > 0 && rejectOffers.every((row) => row.releasedAt) &&
        rejectOffers.every((row) => { const t = taskRows.find((task) => legOfTask(task.taskId)?.legId === row.leg.legId); return t && t.status === "COMPLETED" && t.robot && t.robot.robotId !== "V1F-REJECT"; }),
      `${rejectOffers.length} offer(s) to the rejecting robot, ${events.OFFER_REJECT || 0} OFFER_REJECT`);
    expect("case 9 — robot fails to complete: its commitment is released unsettled and the task is completed by another robot",
      died.length > 0 && died.every((d) => {
        const c = commitmentRows.find((row) => row.commitmentId === d.commitmentId);
        const t = taskRows.find((task) => legOfTask(task.taskId)?.legId === d.legId);
        return c && c.releasedAt && t && t.status === "COMPLETED" && t.robot && t.robot.robotId !== d.code;
      }), JSON.stringify(died));
  } else {
    const perAgent = {};
    for (const row of commitmentRows) perAgent[row.agent.agentId] = (perAgent[row.agent.agentId] || 0) + 1;
    expect("case 6 — contention: robots reused sequentially, never two live commitments at once (I1/I2)",
      invariants.violations.every((v) => v.id !== "I1" && v.id !== "I2"), JSON.stringify(perAgent));
    expect("every task completed and settled", summary.completed === tasks.length, `${summary.completed}/${tasks.length}`);
  }

  /* ── Print ──────────────────────────────────────────────────────────────── */
  say("\n── REJECTION REASONS (per agent × Leg, first verdict) ────────────────");
  const seen = new Set();
  for (const verdict of gateVerdicts) {
    const key = `${verdict.agentId}|${verdict.legId}`;
    if (verdict.feasible || seen.has(key)) continue;
    seen.add(key);
    say(`  REJECTED  ${verdict.agentId}  ${verdict.legId}  ${verdict.denials.map((d) => `${d.id}: ${d.reason}`).join(" | ").slice(0, 400)}`);
  }
  const seenPre = new Set();
  for (const row of expansionRefusals) {
    const key = `${row.agentId}|${row.legId}|${row.refusal}`;
    if (seenPre.has(key)) continue;
    seenPre.add(key);
    say(`  REFUSED   ${row.agentId}  ${row.legId}  ${row.refusal}: ${(row.problems[0] || "").slice(0, 200)}`);
  }

  say("\n── TASK OUTCOMES ────────────────────────────────────────────────────");
  for (const row of taskRows) {
    const leg = legOfTask(row.taskId);
    say(`  ${row.taskId.padEnd(22)} ${invariants.outcomes[row.taskId].padEnd(9)} task=${row.status.padEnd(9)} leg=${(leg && leg.state) || "-"}  robot=${row.robot ? row.robot.robotId : "-"}`);
  }

  say("\n── SUMMARY ──────────────────────────────────────────────────────────");
  say(JSON.stringify({ ...summary, workerFailures: workerFailures.length }, null, 2));
  for (const failure of workerFailures.slice(0, 5)) say(`  worker failure: ${failure.event} ${failure.message}`);
  say("\n── INVARIANTS ───────────────────────────────────────────────────────");
  say(invariants.ok ? "  all hold (I1–I8)" : invariants.violations.map((v) => `  VIOLATED ${v.id} ${JSON.stringify(v)}`).join("\n"));
  say("\n── EXPECTATIONS ─────────────────────────────────────────────────────");
  for (const row of expectations) say(`  ${row.pass ? "PASS" : "FAIL"}  ${row.name}${row.detail ? `\n        ${String(row.detail).slice(0, 300)}` : ""}`);

  const ok = invariants.ok && expectations.every((row) => row.pass) && (SCENARIO === "failures" || Boolean(done));
  say(`\nRESULT: ${ok ? "PASS" : "FAIL"} — scenario ${SCENARIO}, ${summary.completed}/${summary.tasks} tasks completed, ${elapsedS} s${done ? "" : " (watch timed out)"}`);

  if (JSON_OUT) {
    fs.writeFileSync(JSON_OUT, JSON.stringify({ scenario: SCENARIO, seed: SEED, elapsedS, ok, summary, invariants, expectations, died, validation, workerFailures }, (k, v) => (typeof v === "bigint" ? String(v) : v), 2));
  }

  await simulator.stop?.();
  io.close();
  httpServer.close();
  await prisma.$disconnect();
  return ok ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`\nFAILED: ${error && error.stack ? error.stack : error}\n`);
    for (const item of (error && error.findings) || []) process.stderr.write(`  [${item.id}] ${item.severity} ${item.message}\n`);
    process.exit(1);
  });
