"use strict";

/**
 * STEP 3 — what the robot APIs say about simulation, against **real PostgreSQL**.
 *
 * ── Why a live check and not only the jest suite ────────────────────────────
 * Because the defect this step closes was produced by nobody writing any code. Every
 * robot read path uses a Prisma `include`, and an `include` returns **every scalar on the
 * row** — so `GET /api/robots/state` was handing out `simulationOwnerId`, a `User.id`,
 * for every simulated unit. A unit test can only leak what its fixture puts in the
 * fixture. Only a real `SELECT` against a real table returns the real column set, which
 * is exactly the thing under test: what a genuine Prisma read hands to the controller.
 *
 * The same argument runs in the other direction for `simulated`: the jest suite asserts
 * the projection copies the field, and it would pass just as happily if the column did
 * not exist, because the fixture supplies it.
 *
 * So this tool:
 *
 *   1. creates one physical and one simulated unit through the **shipped services**;
 *   2. confirms, by reading the table, that the simulated row really does carry its
 *      owner — without which every absence below would be proving nothing;
 *   3. drives the **real Express router**, with the real auth middleware and a real
 *      Prisma client, over `GET /api/robots` and `GET /api/robots/state`, and asserts
 *      `simulated` is present and correct and the owner id is nowhere in the payload;
 *   4. does the same for the creation 201 and the edit response;
 *   5. asserts the Redis-overlay branch of the list does not drop the discriminator,
 *      because that is the branch the dashboard actually loads through;
 *   6. asserts identity and liveness stay separate on a real row: a simulated unit that
 *      has never connected is `simulated: true, isOnline: false`.
 *
 * Deliberately not a jest test: it needs a live database, and a lane that silently skips
 * when one is absent is how a live-database obligation goes undischarged for four phases.
 *
 * ── Running it ─────────────────────────────────────────────────────────────
 *   node tools/verify/step3SimulationIdentity.js "postgresql://user@127.0.0.1:55432/db"
 *
 * Never against `DATABASE_URL`: that is shared infrastructure. Build a throwaway cluster
 * and apply `prisma/migrations/*​/migration.sql` to it in directory-name order first.
 */

const url = process.argv[2];
if (!url) {
  process.stderr.write("usage: node tools/verify/step3SimulationIdentity.js <postgres-url>\n");
  process.exit(2);
}
if (/neon\.tech/i.test(url)) {
  process.stderr.write(
    "refused: this tool writes and deletes fleet rows and must never run against shared infrastructure\n",
  );
  process.exit(2);
}

// Set BEFORE anything requires `src/db/prisma`, whose `getPrisma()` constructs its client
// from `DATABASE_URL`. The router under test resolves its client through that function, so
// this is what points the shipped code at the disposable cluster rather than at a client
// this tool hands it — the difference between testing the router and testing a fixture.
process.env.DATABASE_URL = url;
process.env.JWT_SECRET = process.env.JWT_SECRET || "step3-verification-secret";

const express = require("express");
const cookieParser = require("cookie-parser");
const request = require("supertest");
const jwt = require("jsonwebtoken");

const { PrismaClient } = require("@prisma/client");
const { getPrisma, disconnectPrisma } = require("../../src/db/prisma");
const robotsRoutes = require("../../src/routes/robots.routes");
const simulatorRoutes = require("../../src/routes/simulator.routes");
const errorHandler = require("../../src/middlewares/errorHandler");

const checks = [];
let failures = 0;

function record(name, ok, detail) {
  checks.push({ name, ok, detail });
  if (!ok) failures += 1;
  process.stdout.write(`${ok ? "  ok  " : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}\n`);
}

const LOCATION_ID = "loc-step3";
const USER_A = "33333333-3333-4333-8333-333333333333";
const PHYSICAL_ID = "RBT-STEP3";

const SPEC = {
  massKg: 45,
  maxSpeedMps: 2.5,
  normalSpeedMps: 1.4,
  batteryCapacityWh: 500,
  batteryReservePct: 15,
  payloadCapacityKg: 20,
  initialBatteryPct: 82,
};

const CREATE_BODY = {
  name: "Sim Rover",
  locationId: LOCATION_ID,
  chassisType: "Rover (Ground)",
  specification: SPEC,
};

async function reset(prisma) {
  await prisma.$executeRawUnsafe(`DELETE FROM "Agent"`);
  await prisma.$executeRawUnsafe(`DELETE FROM "Robot"`);
  await prisma.$executeRawUnsafe(`DELETE FROM "AgentClass"`);
  await prisma.$executeRawUnsafe(`DELETE FROM "Capability"`);
  await prisma.$executeRawUnsafe(`DELETE FROM "CapabilityBundle"`);
  await prisma.$executeRawUnsafe(`DELETE FROM "MobilityModel"`);
  await prisma.$executeRawUnsafe(`DELETE FROM "EnergyModel"`);
  await prisma.$executeRawUnsafe(`DELETE FROM "ContainerModel"`);
}

async function seed(prisma) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "Location" ("id","name","type","lat","lon") VALUES ($1,$2,$3::"LocationType",$4,$5)
     ON CONFLICT ("id") DO NOTHING`,
    LOCATION_ID, "Step 3 Area", "AREA", 12.9023, 77.5183,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "User" ("id","email","password","role") VALUES ($1,$2,$3,$4::"Role")
     ON CONFLICT ("id") DO NOTHING`,
    // SUPER_ADMIN because `POST /api/simulator/robot` is SUPER_ADMIN-only and this tool
    // drives that route. The role is also the only value the `Role` enum holds.
    USER_A, "a@step3.test", "not-a-real-hash", "SUPER_ADMIN",
  );
}

/**
 * The real router, with the real auth middleware.
 *
 * `kv` is a parameter because the list endpoints have two branches — a plain one and a
 * Redis-overlay one that rebuilds the object — and the overlay branch is the one the
 * dashboard actually loads through. A projection applied on only one of them is a defect
 * that a no-Redis check cannot see.
 */
function makeApp(kv) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.locals.kv = kv || null;
  app.locals.io = null;
  app.locals.virtualSimulator = null;
  app.use("/api/robots", robotsRoutes);
  app.use("/api/simulator", simulatorRoutes);
  app.use(errorHandler);
  return app;
}

let clientCounter = 0;
function authed(app, method, path) {
  clientCounter += 1;
  return request(app)
    [method](path)
    .set("X-Forwarded-For", `10.1.0.${clientCounter % 250}`)
    .set("Authorization", `Bearer ${jwt.sign({ id: USER_A }, process.env.JWT_SECRET, { expiresIn: "1h" })}`);
}

/** A KV double that answers the list overlay, so the merged branch is exercised. */
function overlayKv() {
  return {
    mget: async (keys) =>
      keys.map(() => JSON.stringify({ lat: 1, lon: 2, speed: 3, battery: 50, status: "ACTIVE" })),
    set: async () => {},
    sadd: async () => {},
  };
}

function findRobot(body, robotId) {
  return (body.robots || []).find((r) => r.robotId === robotId) || null;
}

async function main() {
  const admin = new PrismaClient({ datasources: { db: { url } } });
  await admin.$connect();

  process.stdout.write("\nSTEP 3 — simulation identity through the robot APIs, against live PostgreSQL\n\n");

  await reset(admin);
  await seed(admin);

  // ── 1. Two real units, created through the shipped entry points ───────────

  const prisma = getPrisma();
  await prisma.$connect();

  const physicalCreate = await authed(makeApp(), "post", "/api/robots").send({
    robotId: PHYSICAL_ID,
    name: "Warehouse Rover A",
    locationId: LOCATION_ID,
    chassisType: "Rover (Ground)",
    specification: SPEC,
  });
  record(
    "physical commissioning still works",
    physicalCreate.status === 200 && physicalCreate.body?.robot?.robotId === PHYSICAL_ID,
    `HTTP ${physicalCreate.status} ${JSON.stringify(physicalCreate.body?.message || "")}`,
  );

  const simulatedCreate = await authed(makeApp(), "post", "/api/simulator/robot").send(CREATE_BODY);
  const simulatedId = simulatedCreate.body?.robot?.robotId || null;
  record(
    "simulated creation still works and returns one server-named unit",
    simulatedCreate.status === 201 && /^SIM-[0-9A-F]{12}$/.test(simulatedId || ""),
    `HTTP ${simulatedCreate.status} ${simulatedId || JSON.stringify(simulatedCreate.body?.message || "")}`,
  );

  // ── 2. The owner really is on the row — otherwise nothing below proves anything ──

  const storedRows = await admin.$queryRawUnsafe(
    `SELECT "robotId", "simulated", "simulationOwnerId", "isOnline" FROM "Robot" ORDER BY "robotId"`,
  );
  const stored = new Map(storedRows.map((r) => [r.robotId, r]));
  record(
    "the simulated row carries its owner in the database",
    stored.get(simulatedId)?.simulationOwnerId === USER_A && stored.get(simulatedId)?.simulated === true,
    JSON.stringify(stored.get(simulatedId) || null),
  );
  record(
    "the physical row is unowned and not simulated",
    stored.get(PHYSICAL_ID)?.simulationOwnerId === null && stored.get(PHYSICAL_ID)?.simulated === false,
    JSON.stringify(stored.get(PHYSICAL_ID) || null),
  );

  // ── 3. Identity is exposed; ownership is not. Both list endpoints, both branches ──

  for (const [label, kv] of [["no Redis overlay", null], ["with the Redis overlay", overlayKv()]]) {
    const app = makeApp(kv);
    for (const path of ["/api/robots", "/api/robots/state"]) {
      // eslint-disable-next-line no-await-in-loop
      const response = await authed(app, "get", path);
      const physical = findRobot(response.body, PHYSICAL_ID);
      const simulated = findRobot(response.body, simulatedId);

      record(
        `${path} (${label}) returns both units`,
        response.status === 200 && physical !== null && simulated !== null,
        `HTTP ${response.status}, ${(response.body.robots || []).length} robot(s)`,
      );
      record(
        `${path} (${label}) reports simulated=false / true`,
        physical?.simulated === false && simulated?.simulated === true,
        `physical=${JSON.stringify(physical?.simulated)}, simulated=${JSON.stringify(simulated?.simulated)}`,
      );
      record(
        `${path} (${label}) omits simulationOwnerId as a key`,
        physical !== null && simulated !== null &&
          !("simulationOwnerId" in physical) && !("simulationOwnerId" in simulated),
        `${"simulationOwnerId" in (simulated || {}) ? "PRESENT on the simulated unit" : "absent"}`,
      );
      record(
        `${path} (${label}) contains the owner's User.id nowhere in the payload`,
        !JSON.stringify(response.body).includes(USER_A),
        JSON.stringify(response.body).includes(USER_A) ? "the user id reached the client" : null,
      );
      if (kv) {
        record(
          `${path} (${label}) still applied the overlay — the branch was not skipped`,
          physical?.battery === 50,
          `battery=${JSON.stringify(physical?.battery)}`,
        );
      }
    }
  }

  // ── 4. The two single-robot responses ─────────────────────────────────────

  record(
    "the simulated-creation 201 carries simulated=true and no owner",
    simulatedCreate.body?.robot?.simulated === true &&
      !("simulationOwnerId" in (simulatedCreate.body?.robot || {})) &&
      !JSON.stringify(simulatedCreate.body).includes(USER_A),
    JSON.stringify({
      simulated: simulatedCreate.body?.robot?.simulated,
      owner: simulatedCreate.body?.robot?.simulationOwnerId,
    }),
  );
  record(
    "the physical commissioning response carries simulated=false and no owner",
    physicalCreate.body?.robot?.simulated === false &&
      !("simulationOwnerId" in (physicalCreate.body?.robot || {})),
    JSON.stringify({ simulated: physicalCreate.body?.robot?.simulated }),
  );

  const edit = await authed(makeApp(), "patch", `/api/robots/${encodeURIComponent(simulatedId)}`)
    .send({ payloadCapacityKg: 12 });
  record(
    "the edit response carries simulated=true and no owner",
    edit.status === 200 && edit.body?.robot?.simulated === true &&
      !("simulationOwnerId" in (edit.body?.robot || {})),
    `HTTP ${edit.status} ${JSON.stringify(edit.body?.robot?.simulated)}`,
  );

  // ── 5. The pairing response is stripped too ───────────────────────────────

  const pairing = await authed(makeApp(overlayKv()), "post", "/api/robots/commission")
    .send({ robotId: simulatedId, locationId: LOCATION_ID });
  record(
    "the pairing response does not leak the owner of an existing simulated row",
    pairing.status === 200 && !("simulationOwnerId" in (pairing.body?.robot || {})) &&
      !JSON.stringify(pairing.body).includes(USER_A),
    `HTTP ${pairing.status}`,
  );
  record(
    "…and it does not invent an all-null specification for a configured unit",
    pairing.body?.robot?.specification === undefined,
    JSON.stringify(pairing.body?.robot?.specification),
  );

  // ── 6. Identity is not liveness ───────────────────────────────────────────

  const afterAll = await authed(makeApp(), "get", "/api/robots/state");
  const simRow = findRobot(afterAll.body, simulatedId);
  record(
    "a simulated unit that has never connected is simulated=true and isOnline=false",
    simRow?.simulated === true && simRow?.isOnline === false,
    `simulated=${JSON.stringify(simRow?.simulated)}, isOnline=${JSON.stringify(simRow?.isOnline)}`,
  );
  record(
    "no simulator is claimed to be running for it",
    // The app under test has no simulator wired, which is the default posture
    // (`ENABLE_VIRTUAL_SIMULATOR` unset). The creation response said so at the time, and
    // it is the honest answer rather than a fabricated RUNNING.
    simulatedCreate.body?.status === "PERSISTED_NOT_RUNNING" &&
      simulatedCreate.body?.simulator?.running === false,
    JSON.stringify(simulatedCreate.body?.simulator),
  );

  // ── 7. A second simulated robot is ALLOWED, and is projected the same way ─
  //
  // ── What these three checks used to assert ─────────────────────────────────
  // That the second creation was refused with 409 "you already own a simulated robot",
  // that the refusal named the existing unit, and that exactly one simulated robot
  // existed. All three passed, and all three were asserting a product rule that was a
  // misreading of the requirement: one SUPER_ADMIN may have MANY simulated robots. The
  // constraint behind them is dropped, so the assertions are inverted rather than
  // softened — the expected outcome is the opposite one, which is not something an
  // adjustment could reach.
  //
  // What Step 3 actually owns here is the *projection*, and that is what survives: the
  // second unit must come back shaped exactly like the first, with `simulated` present
  // and the creator id absent. A leak that appeared only on an operator's second robot
  // would be a real defect, and this is the check that would see it.

  const second = await authed(makeApp(), "post", "/api/simulator/robot").send(CREATE_BODY);
  record(
    "a second simulated robot for the same operator is ALLOWED",
    second.status === 201,
    `HTTP ${second.status} ${second.body?.message || ""}`,
  );
  record(
    "…and it is a different robot from the first",
    Boolean(second.body?.robot?.robotId) && second.body.robot.robotId !== simulatedId,
    `${simulatedId} → ${second.body?.robot?.robotId}`,
  );
  record(
    "…projected identically: simulated present, simulationOwnerId absent",
    second.body?.robot?.simulated === true &&
      second.body.robot.simulationOwnerId === undefined &&
      !JSON.stringify(second.body).includes(USER_A),
    JSON.stringify({ simulated: second.body?.robot?.simulated }),
  );
  const countAfter = await admin.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n FROM "Robot" WHERE "simulated" = true`,
  );
  record("two simulated robots now exist", countAfter[0]?.n === 2, `n=${countAfter[0]?.n}`);

  // The list endpoints, re-read with TWO simulated robots owned by one operator. The
  // projection is applied per row, so a second row is the cheapest way to catch a strip
  // that only ever ran on the first element of a collection.
  const listWithTwo = await authed(makeApp(), "get", "/api/robots/state");
  const simulatedRows = (listWithTwo.body?.robots || listWithTwo.body || []).filter(
    (r) => r && r.simulated === true,
  );
  record(
    "both simulated units appear in /api/robots/state with no creator id on either",
    simulatedRows.length === 2 &&
      simulatedRows.every((r) => r.simulationOwnerId === undefined) &&
      !JSON.stringify(listWithTwo.body).includes(USER_A),
    `${simulatedRows.length} simulated row(s)`,
  );

  // ── Teardown ──────────────────────────────────────────────────────────────

  await reset(admin);
  await admin.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = $1`, USER_A);
  await admin.$executeRawUnsafe(`DELETE FROM "Location" WHERE "id" = $1`, LOCATION_ID);
  await admin.$disconnect();
  await disconnectPrisma();

  process.stdout.write(
    `\n${checks.length - failures}/${checks.length} checks passed` +
      (failures ? ` — ${failures} FAILED\n` : "\n\n"),
  );
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  process.stderr.write(`\nverification aborted: ${error && error.stack}\n`);
  process.exit(1);
});
