"use strict";

/**
 * STEP 4 — simulated robot behaviour, against **real PostgreSQL and a real socket server**.
 *
 * ── Why a live check, when the jest suite already has 63 tests ───────────────
 * Because three of Step 4's findings are about things a double cannot reproduce.
 *
 *   1. **The reconnect duplicate-handler defect is a property of socket.io-client.** It
 *      exists because `ioClient()` returns one `Socket` object that survives reconnection
 *      and re-emits `connect` on the same emitter. The jest suite reproduces that by
 *      clearing the flag the old `disconnect` handler cleared — a faithful replay, but a
 *      replay. Only a real client that really drops and really reconnects shows that the
 *      *actual* library behaves the way the fix assumes. If socket.io reconnected by
 *      constructing a fresh `Socket`, the fix would be unnecessary and the unit test would
 *      still pass; this check is what tells those two worlds apart.
 *   2. **`addRobot` re-reads the row with a real `select`.** The engine's refusal rests on
 *      `simulated` coming back from PostgreSQL, not from a fixture that was asked to
 *      include it.
 *   3. **Liveness is written by the AUTH path, not by the simulator.** That a simulated
 *      agent earns `isOnline` by connecting — and that a physical row sitting beside it
 *      does not — is a claim about two subsystems and a table, and every previous step in
 *      this programme found something here that mocks agreed was fine.
 *
 * ── Running it ─────────────────────────────────────────────────────────────
 *   node tools/verify/step4SimulationBehaviour.js "postgresql://user@127.0.0.1:55432/db"
 *
 * Never against `DATABASE_URL`: that is shared infrastructure. Build a throwaway cluster
 * and apply `prisma/migrations/*​/migration.sql` to it in directory-name order first.
 */

const url = process.argv[2];
if (!url) {
  process.stderr.write("usage: node tools/verify/step4SimulationBehaviour.js <postgres-url>\n");
  process.exit(2);
}
if (/neon\.tech/i.test(url)) {
  process.stderr.write(
    "refused: this tool writes and deletes fleet rows and must never run against shared infrastructure\n",
  );
  process.exit(2);
}

// Set BEFORE anything requires `src/db/prisma`, whose `getPrisma()` builds its client from
// `DATABASE_URL`. The shipped router resolves its client through that function.
process.env.DATABASE_URL = url;
process.env.JWT_SECRET = process.env.JWT_SECRET || "step4-verification-secret";
// The simulator is opt-in (Step 1). This process is the one that opts in.
process.env.ENABLE_VIRTUAL_SIMULATOR = "true";
delete process.env.DISABLE_VIRTUAL_SIMULATOR;

const http = require("http");
const express = require("express");
const cookieParser = require("cookie-parser");
const request = require("supertest");
const jwt = require("jsonwebtoken");
const { Server } = require("socket.io");

const { PrismaClient } = require("@prisma/client");
const { getPrisma, disconnectPrisma } = require("../../src/db/prisma");
const { initKv } = require("../../src/cache/kv");
const initSocketServer = require("../../src/sockets/socket.server");
const { createVirtualRobotSimulator } = require("../../src/simulation/SimulationEngine");
const { rehydrateSimulatedRobots } = require("../../src/simulation/rehydrate");
const simulatorRoutes = require("../../src/routes/simulator.routes");
const robotsRoutes = require("../../src/routes/robots.routes");
const errorHandler = require("../../src/middlewares/errorHandler");

// Warnings and errors are surfaced, because a silent verifier that fails tells you nothing
// about why. Set STEP4_QUIET=1 to suppress them once the run is green.
const loud = process.env.STEP4_QUIET !== "1";
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
    return JSON.stringify(value);
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

const LOCATION_ID = "loc-step4";
const USER_ID = "44444444-4444-4444-8444-444444444444";
const PHYSICAL_ID = "RBT-STEP4-PHYS";

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

/** Poll until `predicate()` is truthy, or give up. Returns whether it became true. */
async function waitUntil(predicate, { timeoutMs = 15_000, everyMs = 150 } = {}) {
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
    "Telemetry", "Command", "Event", "Task", "Agent", "Robot", "AgentClass",
    "Capability", "CapabilityBundle", "MobilityModel", "EnergyModel", "ContainerModel",
  ]) {
    await prisma.$executeRawUnsafe(`DELETE FROM "${table}"`);
  }
}

async function seed(prisma) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "Location" ("id","name","type","lat","lon") VALUES ($1,$2,$3::"LocationType",$4,$5)
     ON CONFLICT ("id") DO NOTHING`,
    LOCATION_ID, "Step 4 Area", "AREA", 12.9023, 77.5183,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "User" ("id","email","password","role") VALUES ($1,$2,$3,$4::"Role")
     ON CONFLICT ("id") DO NOTHING`,
    USER_ID, "a@step4.test", "not-a-real-hash", "SUPER_ADMIN",
  );
}

let clientCounter = 0;
function authed(app, method, path) {
  clientCounter += 1;
  return request(app)
    [method](path)
    .set("X-Forwarded-For", `10.4.0.${clientCounter % 250}`)
    .set("Authorization", `Bearer ${jwt.sign({ id: USER_ID }, process.env.JWT_SECRET, { expiresIn: "1h" })}`);
}

async function main() {
  const admin = new PrismaClient({ datasources: { db: { url } } });
  await admin.$connect();

  process.stdout.write("\nSTEP 4 — simulated robot behaviour, against live PostgreSQL and a real socket server\n");

  await reset(admin);
  await seed(admin);

  const prisma = getPrisma();
  await prisma.$connect();
  const { kv, close: closeKv } = await initKv({ logger: silentLogger });

  // ── The real socket server, on a real port ────────────────────────────────
  const httpServer = http.createServer();
  const io = new Server(httpServer, { cors: { origin: true, credentials: true } });
  initSocketServer(io, { prisma, kv, logger: silentLogger });
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const port = httpServer.address().port;
  const serverUrl = `http://127.0.0.1:${port}`;

  // ── The HTTP surface, with the real routers ───────────────────────────────
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.locals.kv = kv;
  app.locals.io = io;
  app.locals.logger = silentLogger;
  app.use("/api/robots", robotsRoutes);
  app.use("/api/simulator", simulatorRoutes);
  app.use(errorHandler);

  let simulator = createVirtualRobotSimulator({ prisma, kv, serverUrl, logger: silentLogger });
  app.locals.virtualSimulator = simulator;

  let simulatedIds = [];

  try {
    // ══════════════════════════════════════════════════════════════════════
    section("1. a mixed fleet, created through the shipped entry points");

    const physical = await authed(app, "post", "/api/robots").send({
      robotId: PHYSICAL_ID,
      name: "Step 4 Physical",
      locationId: LOCATION_ID,
      chassisType: "Rover (Ground)",
      specification: SPEC,
    });
    record(
      "one physical robot commissioned",
      physical.status === 200 && physical.body?.robot?.robotId === PHYSICAL_ID,
      `HTTP ${physical.status}`,
    );

    // The physical unit's own AUTH credential, as its pairing flow writes it. Nothing the
    // simulator does may replace this.
    await kv.set(`session:${PHYSICAL_ID}`, "hardware-issued-token", { ex: 900 });

    // Three simulated robots, one request each — there is no fleet endpoint.
    for (let i = 0; i < 3; i++) {
      const created = await authed(app, "post", "/api/simulator/robot").send({
        name: `Step 4 Sim ${i + 1}`,
        locationId: LOCATION_ID,
        chassisType: "Rover (Ground)",
        specification: SPEC,
      });
      if (created.status === 201 && created.body?.robot?.robotId) simulatedIds.push(created.body.robot.robotId);
    }
    record(
      "three simulated robots created, one per request",
      simulatedIds.length === 3 && new Set(simulatedIds).size === 3,
      simulatedIds.join(", "),
    );

    // ══════════════════════════════════════════════════════════════════════
    section("2. what the database actually holds");

    const rows = await admin.$queryRawUnsafe(
      `SELECT "robotId","simulated","isOnline","battery","lat","lon" FROM "Robot" ORDER BY "robotId"`,
    );
    const byId = new Map(rows.map((row) => [row.robotId, row]));

    record(
      "the physical row is simulated = false",
      byId.get(PHYSICAL_ID)?.simulated === false,
      String(byId.get(PHYSICAL_ID)?.simulated),
    );
    record(
      "every simulated row is simulated = true",
      simulatedIds.every((id) => byId.get(id)?.simulated === true),
      simulatedIds.map((id) => `${id}=${byId.get(id)?.simulated}`).join(" "),
    );
    record(
      "no row is online — a created record is not a session",
      rows.every((row) => row.isOnline === false),
      rows.map((row) => `${row.robotId}=${row.isOnline}`).join(" "),
    );

    // Snapshot taken here, before any agent has connected, so section 8 can assert that the
    // simulator changed nothing about the Agent projections rather than that none exists.
    const agentsAtCreation = (
      await admin.$queryRawUnsafe(`SELECT "agentId" FROM "Agent" ORDER BY "agentId"`)
    ).map((row) => row.agentId);
    record(
      "commissioning wrote an Agent projection for every robot, simulated or not",
      agentsAtCreation.length === 4,
      `[${agentsAtCreation.join(",")}]`,
    );

    // ══════════════════════════════════════════════════════════════════════
    section("3. rehydration from a real mixed table (a server restart)");

    // A restart, modelled honestly: the creation-time engine goes away and a fresh one
    // re-hydrates from the table. The old engine is stopped **first** and its robots are
    // dropped, because `commission()` mints `session:{robotId}` — so two live engines over
    // one fleet would have the second one's credential supersede the first's, and the first
    // engine's agents would then be refused at AUTH with a token the store no longer holds.
    // That is the Step 1 credential hazard operating between two *simulators* rather than
    // between a simulator and hardware, and it is a good reason never to run two.
    simulator.stop();
    for (const id of simulatedIds) simulator.removeRobot(id);
    await sleep(500);

    const restarted = createVirtualRobotSimulator({ prisma, kv, serverUrl, logger: silentLogger });
    app.locals.virtualSimulator = restarted;
    restarted.start();
    const outcome = await rehydrateSimulatedRobots({ prisma, simulator: restarted, logger: silentLogger });

    record(
      "rehydration considered exactly the three simulated rows",
      outcome.considered === 3 && outcome.spawned === 3 && outcome.refused.length === 0,
      `considered=${outcome.considered} spawned=${outcome.spawned} refused=${JSON.stringify(outcome.refused)}`,
    );
    const rehydrated = restarted.getStatus();
    record(
      "the physical robot got no VirtualRobot",
      !rehydrated.robots.some((entry) => entry.robotId === PHYSICAL_ID) && rehydrated.robotCount === 3,
      `robotCount=${rehydrated.robotCount}`,
    );
    record(
      "every rehydrated instance reports itself running",
      rehydrated.runningCount === 3 && rehydrated.robots.every((entry) => entry.running === true),
      `runningCount=${rehydrated.runningCount}`,
    );

    // The engine refuses the physical row even when a caller insists — against a real row.
    const lied = await restarted.addRobot({ robotId: PHYSICAL_ID, lat: 12.9, lon: 77.5, simulated: true });
    record(
      "the engine refuses a physical row read from the real table",
      lied.started === false && lied.reason === "ROBOT_NOT_SIMULATED",
      JSON.stringify(lied),
    );

    record(
      "the physical robot's AUTH credential was never overwritten",
      (await kv.get(`session:${PHYSICAL_ID}`)) === "hardware-issued-token",
      String(await kv.get(`session:${PHYSICAL_ID}`)),
    );

    // The re-hydrated engine is now the live one — this *is* the post-restart process — so
    // everything below observes the fleet that rehydration actually started.
    simulator = restarted;

    // ══════════════════════════════════════════════════════════════════════
    section("4. the simulated fleet really connects, authenticates and reports");

    const allOnline = await waitUntil(async () => {
      const live = await admin.$queryRawUnsafe(
        `SELECT "robotId","isOnline" FROM "Robot" WHERE "robotId" = ANY($1::text[])`,
        simulatedIds,
      );
      return live.length === 3 && live.every((row) => row.isOnline === true);
    });
    record(
      "each simulated robot earned isOnline by completing a real AUTH",
      allOnline,
      allOnline ? "all three" : "timed out",
    );

    const physicalStillOffline = await admin.$queryRawUnsafe(
      `SELECT "isOnline" FROM "Robot" WHERE "robotId" = $1`,
      PHYSICAL_ID,
    );
    record(
      "the physical robot stayed offline throughout — no simulated twin brought it online",
      physicalStillOffline[0]?.isOnline === false,
      String(physicalStillOffline[0]?.isOnline),
    );

    // Telemetry: the frames must reach the server and move the real row.
    const moved = await waitUntil(async () => {
      const telemetry = await admin.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM "Telemetry"`);
      return telemetry[0]?.n > 0;
    }, { timeoutMs: 20_000 });
    record("telemetry frames were accepted and persisted as Telemetry rows", moved);

    // Waited for rather than sampled: the robots tick every two seconds, so an immediate read
    // catches whichever of them has not reached its first tick yet.
    const allReporting = await waitUntil(() => {
      const snapshot = simulator.getStatus();
      return snapshot.robots.length === 3 && snapshot.robots.every((entry) => entry.telemetrySequence > 0);
    }, { timeoutMs: 20_000 });
    const frames = simulator.getStatus().robots.map((entry) => entry.telemetrySequence);
    record(
      "every instance is emitting its own monotonic telemetry sequence",
      allReporting,
      `sequences=${frames.join(",")}`,
    );
    record(
      "GET /api/simulator/status reports the running instances and not the physical robot",
      await (async () => {
        const response = await authed(app, "get", "/api/simulator/status");
        const body = response.body || {};
        return (
          response.status === 200 &&
          body.enabled === true &&
          body.started === true &&
          body.runningCount === 3 &&
          !(body.robots || []).some((entry) => entry.robotId === PHYSICAL_ID)
        );
      })(),
    );

    // ══════════════════════════════════════════════════════════════════════
    section("5. a REAL reconnect does not duplicate the agent's handlers");

    // The finding this section exists for. The jest suite replays the defect by clearing
    // the flag; here socket.io-client itself drops and reconnects, which is the only way to
    // establish that the library reuses one `Socket` object — the premise the fix rests on.
    const subject = simulatedIds[0];
    const instance = simulator.getStatus().robots.find((entry) => entry.robotId === subject);
    record("a subject instance is running before the drop", Boolean(instance && instance.running === true));

    // Observed through the engine's narrow introspection accessor, so this tool reads the
    // running instance's transport without being handed the instance to mutate.
    const before = simulator.inspectTransport(subject);
    record(
      "one COMMAND listener before the drop",
      before !== null && before.listeners.COMMAND === 1,
      before ? `listeners=${before.listeners.COMMAND} socketGeneration=${before.socketGeneration}` : "no instance",
    );

    // ── The drop has to be a TRANSPORT drop, not a namespace disconnect ────────
    //
    // Worth stating, because the first version of this check got it wrong and the wrong
    // version looked like a product defect. `disconnectSockets(true)` / `socket.disconnect()`
    // make the server send a namespace-disconnect packet, and socket.io-client treats that
    // reason (`io server disconnect`) as deliberate and **does not reconnect** — by design,
    // on the grounds that a server which just dismissed you should not be immediately
    // re-dialled. That is not the failure a robot suffers in the field.
    //
    // Closing the underlying engine connection is. The client sees `transport close`, which
    // is what its reconnection logic exists for, and that is the path this check needs.
    // (The other case — a server that deliberately dismisses an agent — is a real one this
    // simulator does not recover from, and it is recorded as a known limitation rather than
    // quietly fixed inside a step that is not about it.)
    const roomIds = io.sockets.adapter.rooms.get(`robot:${subject}`);
    let dropped = 0;
    for (const id of roomIds || []) {
      const serverSocket = io.sockets.sockets.get(id);
      if (serverSocket?.conn) {
        serverSocket.conn.close();
        dropped += 1;
      }
    }
    record("the subject's transport was closed from the server side", dropped === 1, `closed=${dropped}`);

    const reconnected = await waitUntil(() => {
      const now = simulator.inspectTransport(subject);
      return now !== null && now.connected === true && now.socketId !== null && now.socketId !== before.socketId;
    }, { timeoutMs: 40_000 });
    record("the agent reconnected on its own after an involuntary drop", reconnected);

    const after = simulator.inspectTransport(subject);
    record(
      "socket.io-client reused the SAME Socket object across the reconnect",
      after !== null && after.socketGeneration === before.socketGeneration,
      after
        ? `socketGeneration ${before.socketGeneration} → ${after.socketGeneration}` +
          (after.socketGeneration === before.socketGeneration ? " (reused — this is why the fix is needed)" : " (new object)")
        : "no instance",
    );

    // Let the handshake finish before counting listeners: registration happens on AUTH_SUCCESS.
    await waitUntil(async () => {
      const live = await admin.$queryRawUnsafe(
        `SELECT "isOnline" FROM "Robot" WHERE "robotId" = $1`, subject,
      );
      return live[0]?.isOnline === true;
    }, { timeoutMs: 25_000 });
    await sleep(1500);

    const settled = simulator.inspectTransport(subject);
    record(
      "still exactly one COMMAND listener after the reconnect",
      settled !== null && settled.listeners.COMMAND === 1,
      settled ? `listeners=${settled.listeners.COMMAND}` : "no instance",
    );
    record(
      "still exactly one TASK_ASSIGN listener after the reconnect",
      settled !== null && settled.listeners.TASK_ASSIGN === 1,
      settled ? `listeners=${settled.listeners.TASK_ASSIGN}` : "no instance",
    );
    record(
      "still exactly one OFFER listener after the reconnect",
      settled !== null && settled.listeners.OFFER === 1,
      settled ? `listeners=${settled.listeners.OFFER}` : "no instance",
    );

    // And the observable consequence: one operator command, one acknowledgement.
    const robotRow = await admin.$queryRawUnsafe(`SELECT "id" FROM "Robot" WHERE "robotId" = $1`, subject);
    const commandId = "cmd-step4-once";
    await admin.$executeRawUnsafe(
      `INSERT INTO "Command" ("id","robotId","type","status","issuedAt")
       VALUES ($1,$2,$3::"CommandType",$4::"CommandStatus", NOW())`,
      commandId, robotRow[0].id, "STOP", "SENT",
    );

    io.to(`robot:${subject}`).emit("COMMAND", { commandId, type: "STOP" });
    const acked = await waitUntil(async () => {
      const row = await admin.$queryRawUnsafe(`SELECT "status" FROM "Command" WHERE "id" = $1`, commandId);
      return row[0]?.status === "ACK";
    });
    record("the command was acknowledged after the reconnect", acked);

    // Exactly one acknowledgement. `command.handler` writes one `Event` row per ACK it
    // processes, so a duplicated agent-side handler is visible here as a duplicated event —
    // which is what makes this the *observable* form of the listener count above.
    await sleep(1000);
    const events = await admin.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM "Event" WHERE "message" LIKE $1`,
      `COMMAND_ACK ${commandId}%`,
    );
    record(
      "exactly ONE acknowledgement was recorded, not one per registered handler",
      events[0]?.n === 1,
      `events=${events[0]?.n}`,
    );

    // A redelivery of the same command is answered but not re-applied.
    const appliedBefore = simulator.getStatus().robots.find((e) => e.robotId === subject)?.appliedCommandCount;
    io.to(`robot:${subject}`).emit("COMMAND", { commandId, type: "STOP" });
    await sleep(1500);
    const appliedAfter = simulator.getStatus().robots.find((e) => e.robotId === subject)?.appliedCommandCount;
    record(
      "a redelivered command applied nothing new",
      appliedBefore === 1 && appliedAfter === 1,
      `appliedCommandCount ${appliedBefore} → ${appliedAfter}`,
    );

    // ══════════════════════════════════════════════════════════════════════
    section("6. stop and start over the real HTTP routes");

    const stopped = await authed(app, "post", "/api/simulator/stop");
    record("POST /api/simulator/stop answered", stopped.status === 200, `HTTP ${stopped.status}`);

    const afterStop = (await authed(app, "get", "/api/simulator/status")).body || {};
    record(
      "after stop: the robots are held but NONE is running",
      afterStop.started === false && afterStop.robotCount === 3 && afterStop.runningCount === 0,
      `started=${afterStop.started} held=${afterStop.robotCount} running=${afterStop.runningCount}`,
    );

    const started = await authed(app, "post", "/api/simulator/start");
    record(
      "POST /api/simulator/start reports how many it actually started",
      started.status === 200 && started.body?.start?.running === 3,
      `HTTP ${started.status} start=${JSON.stringify(started.body?.start)}`,
    );

    const revived = await waitUntil(async () => {
      const body = (await authed(app, "get", "/api/simulator/status")).body || {};
      return body.started === true && body.runningCount === 3;
    });
    record("after start: the fleet is genuinely running again", revived);

    // The point of the finding: the fleet is not merely flagged, it is reporting.
    const reportingAgain = await waitUntil(async () => {
      const before = simulator.getStatus().robots.map((entry) => entry.telemetrySequence);
      await sleep(2500);
      const after = simulator.getStatus().robots.map((entry) => entry.telemetrySequence);
      return after.every((n, i) => n > before[i]);
    }, { timeoutMs: 25_000 });
    record("every revived robot resumed emitting telemetry", reportingAgain);

    // ══════════════════════════════════════════════════════════════════════
    section("7. the configuration endpoint over the real route");

    const badConfig = await authed(app, "patch", "/api/simulator/config").send({ tickMs: 500 });
    record(
      "an unknown parameter is a 400 that names the field, not an ok that discards it",
      badConfig.status === 400 && JSON.stringify(badConfig.body?.problems || []).includes("tickMs"),
      `HTTP ${badConfig.status} ${JSON.stringify(badConfig.body?.problems || badConfig.body)}`,
    );

    const protectedConfig = await authed(app, "patch", "/api/simulator/config").send({ robotId: "SIM-HIJACK" });
    record(
      "a protected identity field is refused",
      protectedConfig.status === 400 &&
        /protected/i.test(JSON.stringify(protectedConfig.body?.problems || [])),
      `HTTP ${protectedConfig.status}`,
    );

    const ownerConfig = await authed(app, "patch", "/api/simulator/config").send({ simulationOwnerId: USER_ID });
    record(
      "the operator-ownership column is refused by the closed tunable set",
      ownerConfig.status === 400,
      `HTTP ${ownerConfig.status} ${JSON.stringify(ownerConfig.body?.problems || [])}`,
    );

    const goodConfig = await authed(app, "patch", "/api/simulator/config")
      .send({ telemetryIntervalMs: 1000, obstacleProbability: 0 });
    record(
      "a valid change is applied to the running fleet and says so",
      goodConfig.status === 200 && goodConfig.body?.robotsUpdated === 3,
      `HTTP ${goodConfig.status} ${JSON.stringify(goodConfig.body)}`,
    );

    const configured = (await authed(app, "get", "/api/simulator/status")).body || {};
    record(
      "the running instances report the new tick period",
      (configured.robots || []).every((entry) => entry.telemetryIntervalMs === 1000),
      (configured.robots || []).map((entry) => entry.telemetryIntervalMs).join(","),
    );

    // ══════════════════════════════════════════════════════════════════════
    section("8. no simulated value reached a physical-evidence surface");

    // The physical robot has produced no telemetry, no snapshot and no live state, because
    // nothing has connected as it.
    const physicalTelemetry = await admin.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM "Telemetry" t
        JOIN "Robot" r ON r."id" = t."robotId" WHERE r."robotId" = $1`,
      PHYSICAL_ID,
    );
    record(
      "the physical robot has zero Telemetry rows",
      physicalTelemetry[0]?.n === 0,
      `rows=${physicalTelemetry[0]?.n}`,
    );
    record(
      "the physical robot has no simulator-written live state",
      (await kv.get(`robot:${PHYSICAL_ID}`)) === null ||
        (await kv.get(`robot:${PHYSICAL_ID}`)) === undefined,
      String(await kv.get(`robot:${PHYSICAL_ID}`)),
    );
    record(
      "the physical robot's credential is still the hardware-issued one",
      (await kv.get(`session:${PHYSICAL_ID}`)) === "hardware-issued-token",
    );

    // The Agent projection set is unchanged by everything the simulator did.
    //
    // Stated as a *delta*, not as an absence. The first draft asserted the physical robot has
    // no `Agent` row at all and failed — correctly, and for a reason worth recording: the
    // projection is written by **commissioning**, for every robot, physical ones included.
    // That is Phase 2's backfill and has nothing to do with simulation. The claim Step 4
    // actually needs is that running the simulator neither created nor altered a projection,
    // which is what comparing against the snapshot taken before any agent connected shows.
    const agentsNow = (
      await admin.$queryRawUnsafe(`SELECT "agentId" FROM "Agent" ORDER BY "agentId"`)
    ).map((row) => row.agentId);
    record(
      "the simulator created no Agent projection — the set is exactly what commissioning wrote",
      JSON.stringify(agentsNow) === JSON.stringify(agentsAtCreation),
      `before=[${agentsAtCreation.join(",")}] after=[${agentsNow.join(",")}]`,
    );
  } finally {
    try { simulator.stop(); } catch { /* ignore */ }
    try { io.close(); } catch { /* ignore */ }
    await new Promise((resolve) => httpServer.close(resolve));
    try { await closeKv(); } catch { /* ignore */ }
    await disconnectPrisma().catch(() => {});
    await admin.$disconnect().catch(() => {});
  }

  process.stdout.write(
    `\nSTEP 4 live verification: ${checks.length - failures}/${checks.length} checks passed\n`,
  );
  if (failures > 0) {
    process.stdout.write("\nFAILED:\n");
    for (const check of checks.filter((c) => !c.ok)) {
      process.stdout.write(`  - ${check.name}${check.detail ? ` (${check.detail})` : ""}\n`);
    }
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`\nstep4 verification crashed: ${error?.stack || error}\n`);
  process.exit(1);
});
