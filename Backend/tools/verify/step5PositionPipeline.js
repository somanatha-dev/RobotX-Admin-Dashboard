"use strict";

/**
 * STEP 5 — the telemetry → position Observation → AgentCellPosition → Assignment Engine
 * bridge, against **real PostgreSQL, a real Socket.IO server and real agents on both sides
 * of the simulated/physical boundary.**
 *
 * ── Why a live check, when the jest suites already cover the bridge ──────────
 * Because four of Step 5's claims are about things a double cannot establish.
 *
 *   1. **`Observation.value` is `Json` in PostgreSQL, and the provenance label lives in
 *      it.** That `value->>'provenance'` is queryable — which is how any physical-evidence
 *      gate would ask the question — is a property of the column, not of a JS object a
 *      fake returned.
 *   2. **`AgentCellPosition.observedAtMs` is `BigInt`.** The defect this step fixes wrote
 *      the sweep's clock into it. That the *Observation's own* instant survives the
 *      round trip as an exact int64 is a database fact.
 *   3. **Both agents travel one handler.** A simulated agent connecting over a real
 *      socket.io transport and a physical agent connecting over the same one, producing
 *      two rows that differ in exactly one field, is the claim — and a unit test that
 *      calls the writer directly cannot make it.
 *   4. **The Assignment Engine's own loader reads the result.** `coordinatorSolvePath
 *      .agentSnapshotLoaderFor` is the shipped function; it is invoked here rather than
 *      described.
 *
 * ── What this tool does NOT claim, stated before any output is read ─────────
 *   * **No assignment occurred.** No round is run, no coordinator is composed, no
 *     commitment is written. B1 is unresolved and `gate:composition` is RED; a populated
 *     `AgentCellPosition` means an agent is *visible* to candidate search, and nothing
 *     more.
 *   * **No movement or completion occurred.** A position Observation is a report.
 *   * **No routing, charger, region-cover, safety or reliability row is created.** The
 *     final section asserts that as an outcome rather than asking to be believed.
 *   * **No §14 calibration is fabricated.** `BatteryState` is the one row that is no
 *     longer simply absent: `services/agentEnergyProvisioning` provisions one at
 *     commissioning for a simulated unit, before any telemetry is sent. What this step
 *     must not do is *calibrate* — κ moved off the identity, a positive sample count, a
 *     state of health, accumulated throughput — and that is what is checked, rather than
 *     the row's existence.
 *   * **The simulated agent's rows are not physical evidence** and are labelled so.
 *
 * ── Running it ─────────────────────────────────────────────────────────────
 *   node tools/verify/step5PositionPipeline.js "postgresql://user@127.0.0.1:55432/db"
 *
 * Never against `DATABASE_URL`: that is shared infrastructure. Build a throwaway cluster
 * and apply `prisma/migrations/*​/migration.sql` to it in directory-name order first.
 */

const url = process.argv[2];
if (!url) {
  process.stderr.write("usage: node tools/verify/step5PositionPipeline.js <postgres-url>\n");
  process.exit(2);
}
if (/neon\.tech/i.test(url)) {
  process.stderr.write(
    "refused: this tool writes and deletes fleet rows and must never run against shared infrastructure\n",
  );
  process.exit(2);
}

// Set BEFORE anything requires `src/db/prisma`, whose `getPrisma()` builds its client from
// `DATABASE_URL`.
process.env.DATABASE_URL = url;
process.env.JWT_SECRET = process.env.JWT_SECRET || "step5-verification-secret";
process.env.ENABLE_VIRTUAL_SIMULATOR = "true";
delete process.env.DISABLE_VIRTUAL_SIMULATOR;

// ── The key store is disposable too, and that had to be forced ──────────────
//
// `src/config/env.js` loads `.env`, which in this repository names a **shared, hosted
// Redis**. Without this line the harness silently authenticates its agents against
// production infrastructure and leaves `session:` keys there. `REDIS_ENABLED=false` is
// `initKv`'s own "not configured" branch — the in-memory store, which it documents as
// "genuinely correct" for a single process — so nothing outside this process is read or
// written. The first run of this tool did use the hosted store, which is how the line
// came to be here.
process.env.REDIS_ENABLED = "false";
delete process.env.REDIS_URL;

const http = require("http");
const express = require("express");
const cookieParser = require("cookie-parser");
const request = require("supertest");
const jwt = require("jsonwebtoken");
const { Server } = require("socket.io");
const ioClient = require("socket.io-client");

const { PrismaClient } = require("@prisma/client");
const { getPrisma, disconnectPrisma } = require("../../src/db/prisma");
const { initKv } = require("../../src/cache/kv");
const initSocketServer = require("../../src/sockets/socket.server");
const { createVirtualRobotSimulator } = require("../../src/simulation/SimulationEngine");
const simulatorRoutes = require("../../src/routes/simulator.routes");
const robotsRoutes = require("../../src/routes/robots.routes");
const errorHandler = require("../../src/middlewares/errorHandler");

const positionObservation = require("../../src/services/positionObservation.service");
const indexMaintainer = require("../../src/workers/indexMaintainer.worker");
const coordinatorSolvePath = require("../../src/workers/coordinatorSolvePath");
const cells = require("../../src/engine/spatial/cells");
const simulationPolicy = require("../../src/simulation/simulationPolicy");

const loud = process.env.STEP5_QUIET !== "1";
const silentLogger = {
  info() {}, debug() {}, http() {}, httpEnd() {},
  socket() {}, socketIn() {}, socketOut() {}, dtaro() {}, startup() {},
  simulation() {}, obstacle() {},
  warn(...args) { if (loud) process.stdout.write(`      [warn] ${args.map(fmt).join(" ")}\n`); },
  error(...args) { if (loud) process.stdout.write(`      [error] ${args.map(fmt).join(" ")}\n`); },
  child() { return silentLogger; },
};

function fmt(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, (key, v) => (typeof v === "bigint" ? String(v) : v));
  } catch {
    return String(value);
  }
}

const checks = [];
let failures = 0;

function record(name, ok, detail) {
  checks.push({ name, ok, detail });
  if (!ok) failures += 1;
  process.stdout.write(`${ok ? "  ok  " : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}\n`);
}

function section(title) {
  process.stdout.write(`\n── ${title}\n`);
}

const LOCATION_ID = "loc-step5";
const USER_ID = "55555555-5555-4555-8555-555555555555";
const PHYSICAL_ID = "RBT-STEP5-PHYS";
const UNREPORTING_ID = "RBT-STEP5-SILENT";

/** Bengaluru, the coordinates every other harness in this repository uses. */
const BENGALURU = { lat: 12.9716, lon: 77.5946 };

const SPEC = {
  massKg: 45,
  maxSpeedMps: 2.5,
  normalSpeedMps: 1.4,
  batteryCapacityWh: 500,
  batteryReservePct: 15,
  payloadCapacityKg: 20,
  initialBatteryPct: 82,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(predicate, { timeoutMs = 20_000, everyMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value = false;
    try {
      value = await predicate();
    } catch {
      value = false;
    }
    if (value) return true;
    if (Date.now() >= deadline) return false;
    await sleep(everyMs);
  }
}

async function reset(prisma) {
  for (const table of [
    "AgentCellPosition", "Observation", "Telemetry", "Command", "Event", "Task",
    "BatteryState", "Commitment", "Agent", "Robot", "AgentClass",
    "Capability", "CapabilityBundle", "MobilityModel", "EnergyModel", "ContainerModel",
    "Charger", "ChargerReservation",
  ]) {
    await prisma.$executeRawUnsafe(`DELETE FROM "${table}"`).catch(() => {});
  }
}

async function seed(prisma) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "Location" ("id","name","type","lat","lon") VALUES ($1,$2,$3::"LocationType",$4,$5)
     ON CONFLICT ("id") DO NOTHING`,
    LOCATION_ID, "Step 5 Area", "AREA", BENGALURU.lat, BENGALURU.lon,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "User" ("id","email","password","role") VALUES ($1,$2,$3,$4::"Role")
     ON CONFLICT ("id") DO NOTHING`,
    USER_ID, "a@step5.test", "not-a-real-hash", "SUPER_ADMIN",
  );
}

let clientCounter = 0;
function authed(app, method, path) {
  clientCounter += 1;
  return request(app)
    [method](path)
    .set("X-Forwarded-For", `10.5.0.${clientCounter % 250}`)
    .set("Authorization", `Bearer ${jwt.sign({ id: USER_ID }, process.env.JWT_SECRET, { expiresIn: "1h" })}`);
}

/**
 * Connect one **physical** agent over a real socket.io transport and authenticate it the
 * way hardware does — with the session token its own pairing flow minted, which nothing in
 * the simulator may write or replace (Step 1's credential hazard).
 */
const HARDWARE_TOKEN = "step5-hardware-issued-token";

async function connectPhysicalAgent(serverUrl, robotId, token) {
  const socket = ioClient(serverUrl, { transports: ["websocket"], reconnection: false, forceNew: true });
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
    setTimeout(() => reject(new Error("physical agent connect timed out")), 10_000);
  });
  socket.emit("AUTH", { robotId, token });
  return socket;
}

async function main() {
  const admin = new PrismaClient({ datasources: { db: { url } } });
  await admin.$connect();

  process.stdout.write("\nSTEP 5 — the position pipeline, against live PostgreSQL and a real socket server\n");
  const version = await admin.$queryRawUnsafe("SELECT version()");
  process.stdout.write(`  ${version[0].version}\n`);

  await reset(admin);
  await seed(admin);

  const prisma = getPrisma();
  await prisma.$connect();
  const { kv, close: closeKv } = await initKv({ logger: silentLogger });

  const httpServer = http.createServer();
  const io = new Server(httpServer, { cors: { origin: true, credentials: true } });
  initSocketServer(io, { prisma, kv, logger: silentLogger });
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const serverUrl = `http://127.0.0.1:${httpServer.address().port}`;

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.locals.kv = kv;
  app.locals.io = io;
  app.locals.logger = silentLogger;
  app.use("/api/robots", robotsRoutes);
  app.use("/api/simulator", simulatorRoutes);
  app.use(errorHandler);

  const simulator = createVirtualRobotSimulator({ prisma, kv, serverUrl, logger: silentLogger });
  app.locals.virtualSimulator = simulator;

  const simulatedIds = [];
  let physicalSocket = null;

  try {
    // ══════════════════════════════════════════════════════════════════════
    section("1. a mixed fleet, created through the shipped HTTP entry points");

    for (const [robotId, name] of [[PHYSICAL_ID, "Step 5 Physical"], [UNREPORTING_ID, "Step 5 Silent"]]) {
      // eslint-disable-next-line no-await-in-loop
      const created = await authed(app, "post", "/api/robots").send({
        robotId, name, locationId: LOCATION_ID, chassisType: "Rover (Ground)", specification: SPEC,
      });
      record(`physical robot ${robotId} commissioned`, created.status === 200, `HTTP ${created.status}`);
    }

    for (let i = 0; i < 2; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const created = await authed(app, "post", "/api/simulator/robot").send({
        name: `Step 5 Sim ${i + 1}`, locationId: LOCATION_ID, chassisType: "Rover (Ground)", specification: SPEC,
      });
      if (created.status === 201 && created.body?.robot?.robotId) simulatedIds.push(created.body.robot.robotId);
    }
    record("two simulated robots created, one request each", simulatedIds.length === 2, simulatedIds.join(", "));

    const agents = await admin.$queryRawUnsafe(`SELECT "agentId","id" FROM "Agent" ORDER BY "agentId"`);
    record(
      "every robot — simulated or physical — has ONE Agent projection, from the same code path",
      agents.length === 4,
      `[${agents.map((row) => row.agentId).join(",")}]`,
    );
    const agentRowIdFor = new Map(agents.map((row) => [row.agentId, row.id]));

    // ══════════════════════════════════════════════════════════════════════
    section("2. the physical path stays protected from simulator spawning");

    const physicalRow = (
      await admin.$queryRawUnsafe(`SELECT "simulated" FROM "Robot" WHERE "robotId" = $1`, PHYSICAL_ID)
    )[0];
    record("the physical row is simulated = false", physicalRow?.simulated === false, String(physicalRow?.simulated));

    const lied = await simulator.addRobot({ robotId: PHYSICAL_ID, lat: BENGALURU.lat, lon: BENGALURU.lon, simulated: true });
    record(
      "the simulator refuses the physical row even when the caller insists",
      lied.started === false && lied.reason === "ROBOT_NOT_SIMULATED",
      fmt(lied),
    );
    record(
      "simulationPolicy refuses it too, read from the real row",
      simulationPolicy.maySpawnVirtualRobot(physicalRow, { enabled: true }).reason === "ROBOT_NOT_SIMULATED",
    );

    // Step 1's credential hazard, set up here so section 3 can measure it. The physical
    // unit's AUTH credential is written *before* any simulated agent connects; what
    // matters is that it is byte-identical afterwards. Asserting "no key exists" instead
    // would be a weaker claim about an empty store rather than about the simulator.
    await kv.set(`session:${PHYSICAL_ID}`, HARDWARE_TOKEN, { ex: 900 });

    // ══════════════════════════════════════════════════════════════════════
    section("3. the simulated agents connect and their telemetry is accepted");

    simulator.start();
    for (const robotId of simulatedIds) {
      // eslint-disable-next-line no-await-in-loop
      await simulator.addRobot({ robotId, lat: BENGALURU.lat, lon: BENGALURU.lon });
    }

    const simsOnline = await waitUntil(async () => {
      const rows = await admin.$queryRawUnsafe(
        `SELECT "isOnline" FROM "Robot" WHERE "robotId" = ANY($1::text[])`, simulatedIds,
      );
      return rows.length === simulatedIds.length && rows.every((row) => row.isOnline === true);
    });
    record("each simulated agent completed a real AUTH over the real transport", simsOnline);

    const survivingToken = await kv.get(`session:${PHYSICAL_ID}`);
    record(
      "the physical robot's own AUTH credential was not overwritten by the simulated agents",
      survivingToken === HARDWARE_TOKEN,
      `session:${PHYSICAL_ID} = ${JSON.stringify(survivingToken)}`,
    );

    // ══════════════════════════════════════════════════════════════════════
    section("4. position Observations — the row that did not exist before Step 5");

    const simObservationsAppeared = await waitUntil(async () => {
      const rows = await admin.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS n FROM "Observation" WHERE "kind" = 'position'`,
      );
      return rows[0]?.n >= simulatedIds.length;
    }, { timeoutMs: 40_000 });
    record("simulated telemetry produced position Observations", simObservationsAppeared);

    const simRows = await admin.$queryRawUnsafe(
      `SELECT o."agentId", o."kind", o."source", o."observedAt", o."receivedAt", o."sequence",
              o."value"->>'provenance' AS provenance,
              (o."value"->>'lat')::float8 AS lat, (o."value"->>'lon')::float8 AS lon
         FROM "Observation" o WHERE o."kind" = 'position' ORDER BY o."observedAt"`,
    );
    record(
      "every simulated observation is labelled SIMULATED, in a field PostgreSQL can query",
      simRows.length > 0 && simRows.every((row) => row.provenance === "SIMULATED"),
      `${simRows.length} row(s), provenance=${[...new Set(simRows.map((r) => r.provenance))].join("/")}`,
    );
    record(
      "the source is §2.7's AGENT_REPORT — no sixth provenance value was invented",
      simRows.every((row) => row.source === "AGENT_REPORT"),
    );
    record(
      "observedAt is the AGENT's instant and is strictly earlier than the server's receivedAt",
      simRows.every((row) => new Date(row.observedAt).getTime() <= new Date(row.receivedAt).getTime()) &&
        simRows.some((row) => new Date(row.observedAt).getTime() < new Date(row.receivedAt).getTime()),
      `Δ(receivedAt − observedAt) = ${simRows.map((r) => new Date(r.receivedAt) - new Date(r.observedAt)).join(",")} ms`,
    );
    record(
      "each carries the agent's own monotonic sequence",
      simRows.every((row) => row.sequence !== null),
      `sequences=${simRows.map((r) => String(r.sequence)).join(",")}`,
    );

    // Continuity: a pipeline that produced one row per agent and then stopped would pass
    // every check above. The agents keep reporting, so the log keeps growing — and it
    // grows in order.
    const subject = simulatedIds[0];
    const subjectAgentRowId = agentRowIdFor.get(subject);
    const kept = await waitUntil(async () => {
      const rows = await admin.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS n FROM "Observation" WHERE "agentId" = $1 AND "kind" = 'position'`,
        subjectAgentRowId,
      );
      return rows[0]?.n >= 2;
    }, { timeoutMs: 40_000 });
    const series = await admin.$queryRawUnsafe(
      `SELECT "observedAt","sequence" FROM "Observation"
        WHERE "agentId" = $1 AND "kind" = 'position' ORDER BY "observedAt"`,
      subjectAgentRowId,
    );
    record(
      "the log keeps growing as the agent keeps reporting — this is a stream, not one row",
      kept && series.length >= 2,
      `${series.length} position observation(s) for ${subject}`,
    );
    record(
      "observedAt and sequence are both strictly increasing along that series",
      series.length >= 2 &&
        series.every((row, i) =>
          i === 0 ||
          (new Date(row.observedAt).getTime() > new Date(series[i - 1].observedAt).getTime() &&
            BigInt(row.sequence) > BigInt(series[i - 1].sequence)),
        ),
      `sequences=${series.map((r) => String(r.sequence)).join("<")}`,
    );

    // ══════════════════════════════════════════════════════════════════════
    section("5. a PHYSICAL agent on the same handler produces a PHYSICAL observation");

    physicalSocket = await connectPhysicalAgent(serverUrl, PHYSICAL_ID, HARDWARE_TOKEN);
    const physicalAuthed = await waitUntil(async () => {
      const rows = await admin.$queryRawUnsafe(`SELECT "isOnline" FROM "Robot" WHERE "robotId" = $1`, PHYSICAL_ID);
      return rows[0]?.isOnline === true;
    });
    record("the physical agent authenticated with its own hardware-issued token", physicalAuthed);

    const physicalMeasuredAt = Date.now() - 3_000; // measured three seconds ago, by the agent
    physicalSocket.emit("TELEMETRY", {
      robotId: PHYSICAL_ID,
      lat: BENGALURU.lat + 0.001,
      lon: BENGALURU.lon + 0.001,
      battery: SPEC.initialBatteryPct,
      speed: 1.1,
      status: "ACTIVE",
      timestamp: physicalMeasuredAt,
      sequence: 1,
    });

    const physicalAgentRowId = agentRowIdFor.get(PHYSICAL_ID);
    const physicalObserved = await waitUntil(async () => {
      const rows = await admin.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS n FROM "Observation" WHERE "agentId" = $1 AND "kind" = 'position'`,
        physicalAgentRowId,
      );
      return rows[0]?.n > 0;
    });
    record("the physical agent's telemetry produced a position Observation", physicalObserved);

    const physicalRows = await admin.$queryRawUnsafe(
      `SELECT "value"->>'provenance' AS provenance, "observedAt", "sequence"
         FROM "Observation" WHERE "agentId" = $1 AND "kind" = 'position'`,
      physicalAgentRowId,
    );
    record(
      "it is labelled PHYSICAL",
      physicalRows.length === 1 && physicalRows[0].provenance === "PHYSICAL",
      fmt(physicalRows[0]),
    );
    record(
      "its observedAt is the agent's OWN timestamp, to the millisecond — not server receipt time",
      physicalRows[0] && new Date(physicalRows[0].observedAt).getTime() === physicalMeasuredAt,
      `agent said ${physicalMeasuredAt}, row holds ${physicalRows[0] && new Date(physicalRows[0].observedAt).getTime()}`,
    );
    record(
      "physical and simulated evidence are told apart by the shipped predicate",
      positionObservation.isPhysicalEvidence({ value: { provenance: physicalRows[0]?.provenance } }) === true &&
        simRows.every((row) => positionObservation.isPhysicalEvidence({ value: { provenance: row.provenance } }) === false),
    );

    // ══════════════════════════════════════════════════════════════════════
    section("6. stale and out-of-order telemetry cannot overwrite newer position state");

    const beforeStale = (
      await admin.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS n FROM "Observation" WHERE "agentId" = $1 AND "kind" = 'position'`,
        physicalAgentRowId,
      )
    )[0].n;

    await sleep(200);
    physicalSocket.emit("TELEMETRY", {
      robotId: PHYSICAL_ID,
      lat: BENGALURU.lat + 0.5, lon: BENGALURU.lon + 0.5,
      battery: SPEC.initialBatteryPct, status: "ACTIVE",
      timestamp: physicalMeasuredAt - 60_000, // a minute BEFORE the fix already accepted
      sequence: 0,
    });
    await sleep(2_000);

    const afterStale = await admin.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM "Observation" WHERE "agentId" = $1 AND "kind" = 'position'`,
      physicalAgentRowId,
    );
    record(
      "the stale, out-of-order frame wrote nothing",
      afterStale[0].n === beforeStale,
      `${beforeStale} → ${afterStale[0].n} position observation(s)`,
    );

    // ══════════════════════════════════════════════════════════════════════
    section("7. indexMaintainer turns those Observations into AgentCellPosition");

    // Driven EXPLICITLY. `start()` is deliberately not called here: this harness is about
    // the position pipeline, and a scheduled worker would make the sweep's timing part of
    // what the assertions below depend on.
    //
    // ── BATCH 2: the charging classifier is now a REQUIRED input ──────────────
    //
    // Step 5 ran these sweeps with no `chargingStatusFor` at all, because the worker then
    // defaulted to `charging: false`. That default was the worker's registered blocker and
    // Batch 2 removed it: it is a WIDENING — "not charging" plus "no commitments" is
    // `IDLE_READY`, the partition §6.3 searches first — so an agent whose charging state
    // nobody owns is now left out of the index entirely.
    //
    // Step 5's subject is unchanged and so are its claims: an accepted frame becomes one
    // canonical Observation, the maintainer turns it into `AgentCellPosition`, and the
    // mirror carries the agent's own instant. To assert any of that there has to be an
    // indexable agent, so a classifier is supplied — and it is supplied for **both**
    // fleets, which models a deployment whose Charging Scheduler covers the whole estate.
    //
    // That is deliberately NOT the charging boundary. Whether a PHYSICAL agent may be
    // covered at all is Batch 2's question, not Step 5's, and
    // `tools/verify/batch2ChargingScheduler.js` is where it is asked — that harness checks
    // that a physical agent no scheduler covers reads `known: false` and is NOT indexed.
    // Supplying a covering classifier here keeps Step 5 measuring Step 5.
    const coveredByAScheduler = async () => ({
      known: true,
      charging: false,
      chargingInterruptible: false,
      waiting: false,
      projectedFreeAtMs: null,
    });

    const sweep = await indexMaintainer.sweepOnce({ prisma, kv: null, chargingStatusFor: coveredByAScheduler });
    record(
      "one explicit sweep indexed every agent that has a position Observation",
      sweep.failed === 0 && sweep.indexed >= 3,
      fmt(sweep),
    );

    const mirror = await admin.$queryRawUnsafe(
      `SELECT p."agentId", a."agentId" AS code, p."fineCellId", p."coarseCellId", p."availabilityClass",
              p."lat", p."lon", p."observedAtMs"
         FROM "AgentCellPosition" p JOIN "Agent" a ON a."id" = p."agentId" ORDER BY a."agentId"`,
    );
    record(
      "AgentCellPosition is populated — it was empty before this step existed",
      mirror.length >= 3,
      `${mirror.length} row(s): ${mirror.map((r) => r.code).join(", ")}`,
    );
    record(
      "the fine cell is the EXISTING H3 implementation's answer, not a second one",
      mirror.every((row) => row.fineCellId === cells.cellForPoint(row.lat, row.lon, cells.RESOLUTION.FINE)) &&
        mirror.every((row) => row.coarseCellId === cells.coarseParentOf(row.fineCellId)),
      mirror[0] && `${mirror[0].fineCellId} ⊂ ${mirror[0].coarseCellId}`,
    );
    record(
      "both a simulated and a physical agent are indexed, in the same table, the same way",
      mirror.some((row) => row.code === PHYSICAL_ID) && mirror.some((row) => simulatedIds.includes(row.code)),
      mirror.map((r) => r.code).join(", "),
    );
    record(
      "the mirror carries NO provenance column — the engine's input cannot see the discriminator",
      !Object.keys(mirror[0] || {}).some((key) => /provenance|simulated/i.test(key)),
      `columns: ${Object.keys(mirror[0] || {}).join(",")}`,
    );

    // ══════════════════════════════════════════════════════════════════════
    section("8. observedAtMs is the Observation's own instant, surviving as an exact int64");

    const physicalMirror = mirror.find((row) => row.code === PHYSICAL_ID);
    record(
      "the physical agent's mirror row carries the agent's timestamp, to the millisecond",
      physicalMirror && BigInt(physicalMirror.observedAtMs) === BigInt(physicalMeasuredAt),
      `agent said ${physicalMeasuredAt}, mirror holds ${physicalMirror && String(physicalMirror.observedAtMs)}`,
    );

    const beforeSecondSweep = physicalMirror && String(physicalMirror.observedAtMs);
    await sleep(1_500);
    await indexMaintainer.sweepOnce({ prisma, kv: null, chargingStatusFor: coveredByAScheduler });
    const afterSecondSweep = (
      await admin.$queryRawUnsafe(
        `SELECT p."observedAtMs" FROM "AgentCellPosition" p WHERE p."agentId" = $1`, physicalAgentRowId,
      )
    )[0];
    record(
      "a second sweep does NOT refresh it — the mirror is allowed to age, which is the point",
      afterSecondSweep && String(afterSecondSweep.observedAtMs) === beforeSecondSweep,
      `${beforeSecondSweep} → ${afterSecondSweep && String(afterSecondSweep.observedAtMs)}`,
    );

    // ══════════════════════════════════════════════════════════════════════
    section("9. no AgentCellPosition exists without a valid position Observation");

    const silentAgentRowId = agentRowIdFor.get(UNREPORTING_ID);
    const silentObservations = await admin.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM "Observation" WHERE "agentId" = $1`, silentAgentRowId,
    );
    const silentMirror = await admin.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM "AgentCellPosition" WHERE "agentId" = $1`, silentAgentRowId,
    );
    record(
      "the commissioned robot that never reported has no Observation and no mirror row",
      silentObservations[0].n === 0 && silentMirror[0].n === 0,
      `observations=${silentObservations[0].n} mirror=${silentMirror[0].n}`,
    );

    const orphanMirrors = await admin.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM "AgentCellPosition" p
        WHERE NOT EXISTS (SELECT 1 FROM "Observation" o WHERE o."agentId" = p."agentId" AND o."kind" = 'position')`,
    );
    record(
      "no mirror row anywhere lacks a backing position Observation",
      orphanMirrors[0].n === 0,
      `${orphanMirrors[0].n} orphan(s)`,
    );

    // ══════════════════════════════════════════════════════════════════════
    section("10. the Assignment Engine's OWN snapshot loader reads the result");

    const loadAgentSnapshot = coordinatorSolvePath.agentSnapshotLoaderFor({ prisma });
    const snapshot = await loadAgentSnapshot(physicalAgentRowId);
    record(
      "coordinatorSolvePath.agentSnapshotLoaderFor returns a snapshot for the indexed agent",
      Boolean(snapshot) && snapshot.agentId === PHYSICAL_ID,
      snapshot ? `agentId=${snapshot.agentId} cell=${snapshot.cellId}` : "null",
    );
    record(
      "its position is the one telemetry reported, through the whole chain",
      snapshot && snapshot.cellId === cells.cellForPoint(BENGALURU.lat + 0.001, BENGALURU.lon + 0.001, cells.RESOLUTION.FINE),
      snapshot && `cellId=${snapshot.cellId}`,
    );
    record(
      "its observedAtMs is the agent's own measurement instant",
      snapshot && snapshot.observedAtMs === physicalMeasuredAt,
      snapshot && `${snapshot.observedAtMs} vs ${physicalMeasuredAt}`,
    );
    record(
      "the snapshot carries no simulation discriminator of any kind",
      snapshot && !JSON.stringify(snapshot, (k, v) => (typeof v === "bigint" ? String(v) : v)).match(/provenance|simulated|SIMULATED/i),
    );

    const simAgentRowId = agentRowIdFor.get(simulatedIds[0]);
    const simSnapshot = await loadAgentSnapshot(simAgentRowId);
    record(
      "a SIMULATED agent loads through the identical function — one engine, not two",
      Boolean(simSnapshot) && simSnapshot.agentId === simulatedIds[0],
      simSnapshot ? `agentId=${simSnapshot.agentId} cell=${simSnapshot.cellId}` : "null",
    );

    // ══════════════════════════════════════════════════════════════════════
    section("11. nothing was fabricated — asserted as an outcome, not asked to be believed");

    for (const [table, label] of [
      ["Charger", "no charger was invented (F35's input is still absent)"],
      ["ChargerReservation", "no charging reservation was invented"],
      ["Commitment", "no commitment was created — NOTHING WAS ASSIGNED"],
      ["Region", "no operating region was declared (D1 is the owner's)"],
      ["CellAssignment", "no region cover was published (V-8 is unresolved)"],
      ["ConfigVersion", "no configuration version was published — cutover.engine_enabled is untouched (S-5)"],
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const rows = await admin.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM "${table}"`).catch(() => [{ n: -1 }]);
      record(label, rows[0].n === 0, `${table}=${rows[0].n}`);
    }

    // ── BatteryState: a CONTENT check, not a count ────────────────────────
    //
    // This was `COUNT(*) = 0` alongside the six tables above, and that stopped being the
    // right question. When it was written, **nothing in `src/` created a `BatteryState`
    // at all**, so "no row exists" and "this pipeline fabricated no calibration" were the
    // same statement. They are no longer: `services/agentEnergyProvisioning` now
    // provisions one at commissioning for a **simulated** unit, so this harness's two
    // simulated robots legitimately have one before a single telemetry frame is sent.
    //
    // The property actually being protected has not changed, and is **not** about
    // existence. §14's κ is `@default(1)`, so a row conjured from a telemetry battery
    // reading would silently assert a *calibrated* agent — an agent whose model is
    // trusted because nobody looked at the sample count. There is no mapping from a
    // telemetry frame to §14 calibration, and this step must take none.
    //
    // So the check asks what fabrication would actually look like. A legitimately
    // provisioned row is pristine: κ at the identity with **zero** samples, no state of
    // health, no accumulated throughput or cycles, and it belongs to a simulated unit
    // (the producer is gated on that, which is what keeps physical hardware fail-closed
    // with no pack state at all). Anything else in any of those columns is either
    // calibration this pipeline invented or a row against a unit that should not have
    // one.
    //
    // This is **stronger** than the count it replaces, not weaker: it still passes on
    // zero rows, and it now also fails on a fabricated κ or SoH — which a bare
    // `COUNT(*)` could never have detected once any row was permitted to exist.
    const fabricated = await admin
      .$queryRawUnsafe(
        `SELECT COUNT(*)::int AS n
           FROM "BatteryState" b
           LEFT JOIN "Agent" a ON a.id = b."agentId"
           LEFT JOIN "Robot" r ON r."robotId" = a."agentId"
          WHERE b."kappaSampleCount" <> 0
             OR b.kappa <> 1
             OR b."kappaUpdatedAt" IS NOT NULL
             OR b.soh IS NOT NULL
             OR b."socThroughput" <> 0
             OR b."cycleCount" <> 0
             OR r."simulated" IS DISTINCT FROM true`,
      )
      .catch(() => [{ n: -1 }]);
    const batteryTotal = await admin
      .$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM "BatteryState"`)
      .catch(() => [{ n: -1 }]);
    record(
      "no BatteryState calibration was fabricated — §14 calibration has no telemetry mapping this " +
        "step may take (commissioning rows are κ=1, samples=0, SoH null, on simulated units only)",
      fabricated[0].n === 0,
      `BatteryState=${batteryTotal[0].n}, fabricated=${fabricated[0].n}`,
    );

    const observationKinds = await admin.$queryRawUnsafe(
      `SELECT DISTINCT "kind" FROM "Observation" ORDER BY "kind"`,
    );
    record(
      "the only Observation kind this step writes is 'position' — no safety, reliability or energy fact was invented",
      observationKinds.length === 1 && observationKinds[0].kind === "position",
      observationKinds.map((row) => row.kind).join(","),
    );

    process.stdout.write(
      "\n  NOTE, stated as part of the result: a populated AgentCellPosition means an agent is VISIBLE to\n" +
        "  candidate search. No round ran, no coordinator was composed, no offer was made, no commitment\n" +
        "  was written and no robot moved. B1 is unresolved and gate:composition is still RED.\n",
    );
  } finally {
    try { if (physicalSocket) physicalSocket.close(); } catch { /* ignore */ }
    try { simulator.stop(); } catch { /* ignore */ }
    await sleep(300);
    try { io.close(); } catch { /* ignore */ }
    try { httpServer.close(); } catch { /* ignore */ }
    try { await closeKv(); } catch { /* ignore */ }
    try { await disconnectPrisma(); } catch { /* ignore */ }
    try { await admin.$disconnect(); } catch { /* ignore */ }
  }

  process.stdout.write(`\n${checks.length - failures} / ${checks.length} checks passed\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`\nstep5PositionPipeline crashed: ${error && error.stack}\n`);
  process.exitCode = 1;
});
