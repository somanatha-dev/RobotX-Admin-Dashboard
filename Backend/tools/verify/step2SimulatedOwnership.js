"use strict";

/**
 * STEP 2 (AS CORRECTED) — one SUPER_ADMIN, MANY simulated robots, against **real
 * PostgreSQL**.
 *
 * ── What this tool used to verify, and why that changed ─────────────────────
 * It verified the opposite rule. Step 2 read the requirement as "one user → one simulated
 * robot" and enforced it with a partial unique index, `Robot_one_simulated_per_owner`;
 * this tool asserted the index existed, raced two inserts through it, and confirmed that
 * exactly one survived. Every one of those checks passed, and they were verifying a
 * constraint nobody had asked for.
 *
 * The corrected rule is:
 *
 *   > one SUPER_ADMIN → MANY simulated robots, with no per-operator limit; each
 *   > `POST /api/simulator/robot` creates exactly one, and the endpoint is available only
 *   > to SUPER_ADMIN.
 *
 * ── Why the evidence still has to be live ───────────────────────────────────
 * For the same reason it did before, pointed the other way. A dropped constraint is a
 * database fact, and a unit test running against a fake store proves only that the fake
 * permits what it was written to permit. If `20260912120000_drop_one_simulated_per_owner`
 * were missing, or were applied to a different database than the one the app talks to, the
 * whole jest suite would stay green and the second `POST /api/simulator/robot` in
 * production would answer 500 — an unhandled P2002, since the service no longer has a
 * branch that recognises one.
 *
 * So this tool:
 *
 *   1. asserts the column and its foreign key **survive**, and that the index is **gone**
 *      — a correction that removed the wrong thing is as bad as one that removed nothing;
 *   2. asserts a row inserted without either column still defaults to physical and
 *      unowned, so the correction did not disturb Step 1;
 *   3. drives the **shipped service functions** to create several simulated robots for one
 *      operator, and asserts all of them exist with the same `simulationOwnerId`;
 *   4. races two genuinely concurrent transactions for the same owner and asserts **both**
 *      commit — the interleaving that the dropped index used to refuse;
 *   5. checks the removal did not over-reach: `UNIQUE ("robotId")` must still fire;
 *   6. drives the **real router over HTTP** to establish the SUPER_ADMIN gate — that a
 *      SUPER_ADMIN may create repeatedly, that an unauthenticated request is refused, and
 *      that a role outside `security.elevated_roles` is refused without writing anything.
 *
 * Deliberately not a jest test: it needs a live server, and a lane that silently skips when
 * one is absent is how a live-database obligation goes undischarged for four phases.
 *
 * ── Running it ─────────────────────────────────────────────────────────────
 *   node tools/verify/step2SimulatedOwnership.js "postgresql://user@127.0.0.1:55432/db"
 *
 * Never against `DATABASE_URL`: that is shared infrastructure. Build a throwaway cluster
 * and apply `prisma/migrations/*​/migration.sql` to it in directory-name order first.
 */

const url = process.argv[2];
if (!url) {
  process.stderr.write("usage: node tools/verify/step2SimulatedOwnership.js <postgres-url>\n");
  process.exit(2);
}
if (/neon\.tech/i.test(url)) {
  process.stderr.write(
    "refused: this tool writes and deletes fleet rows and must never run against shared infrastructure\n",
  );
  process.exit(2);
}

// Set BEFORE anything requires `src/db/prisma`, whose `getPrisma()` builds its client from
// `DATABASE_URL`. The router under test resolves its client through that function, so this
// is what points the shipped code at the disposable cluster rather than at a client this
// tool hands it — the difference between testing the router and testing a fixture.
process.env.DATABASE_URL = url;
process.env.JWT_SECRET = process.env.JWT_SECRET || "step2-verification-secret";

const express = require("express");
const cookieParser = require("cookie-parser");
const supertest = require("supertest");
const jwt = require("jsonwebtoken");

const { PrismaClient } = require("@prisma/client");
const { disconnectPrisma } = require("../../src/db/prisma");
const robotService = require("../../src/services/robot.service");
const simulatedRobotService = require("../../src/services/simulatedRobot.service");
const simulatorRoutes = require("../../src/routes/simulator.routes");
const errorHandler = require("../../src/middlewares/errorHandler");

/** The index this correction exists to remove. Named here so its ABSENCE can be asserted. */
const DROPPED_INDEX = "Robot_one_simulated_per_owner";

const checks = [];
let failures = 0;

function record(name, ok, detail) {
  checks.push({ name, ok, detail });
  if (!ok) failures += 1;
  process.stdout.write(`${ok ? "  ok  " : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}\n`);
}

const LOCATION_ID = "loc-step2";
const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";

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

/** Wipe everything this tool creates, so it is re-runnable against the same cluster. */
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
    LOCATION_ID, "Step 2 Area", "AREA", 12.9023, 77.5183,
  );
  for (const [id, email] of [[USER_A, "a@step2.test"], [USER_B, "b@step2.test"]]) {
    // Both are SUPER_ADMIN because the production `Role` enum contains only SUPER_ADMIN.
    // The non-elevated case is exercised in section 7 by narrowing the register, which is
    // the only honest way to reach it without inventing an enum value.
    // eslint-disable-next-line no-await-in-loop
    await prisma.$executeRawUnsafe(
      `INSERT INTO "User" ("id","email","password","role") VALUES ($1,$2,$3,$4::"Role")
       ON CONFLICT ("id") DO NOTHING`,
      id, email, "not-a-real-hash", "SUPER_ADMIN",
    );
  }
}

/** The raw insert used by the concurrency and over-reach probes. */
const RAW_INSERT = `
  INSERT INTO "Robot" ("id","robotId","locationId","status","simulated","simulationOwnerId","isOnline")
  VALUES ($1,$2,$3,'IDLE'::"RobotStatus",$4,$5,false)
`;

/**
 * The real simulator router, with the real auth middleware and the real error handler.
 *
 * `configValues` is a parameter because the SUPER_ADMIN gate reads
 * `security.elevated_roles` from `app.locals.config.values`, falling back to the register
 * default `["SUPER_ADMIN"]`. Section 7 uses that to show the gate genuinely consults the
 * list rather than always admitting whoever authenticated.
 */
function makeApp(configValues) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.locals.kv = null;
  app.locals.io = null;
  app.locals.virtualSimulator = null;
  if (configValues) app.locals.config = { values: configValues };
  app.use("/api/simulator", simulatorRoutes);
  app.use(errorHandler);
  return app;
}

let clientCounter = 0;

/** POST /api/simulator/robot as `userId`, or unauthenticated when `userId` is null. */
function createOverHttp(app, userId) {
  clientCounter += 1;
  const req = supertest(app)
    .post("/api/simulator/robot")
    // A distinct client address per call: the router's rate limiter is a module-level
    // closure, and a run that silently started returning 429 partway through would look
    // like the feature under test refusing.
    .set("X-Forwarded-For", `10.2.0.${clientCounter % 250}`);
  if (userId) {
    req.set("Authorization", `Bearer ${jwt.sign({ id: userId }, process.env.JWT_SECRET, { expiresIn: "1h" })}`);
  }
  return req.send(CREATE_BODY);
}

async function main() {
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  await prisma.$connect();

  process.stdout.write("\nSTEP 2 CORRECTION — many simulated robots per SUPER_ADMIN, against live PostgreSQL\n\n");

  // ── 1. What the migrations left behind ────────────────────────────────────

  const columns = await prisma.$queryRawUnsafe(
    `SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_name = 'Robot' AND column_name IN ('simulated','simulationOwnerId')
      ORDER BY column_name`,
  );
  const byName = new Map(columns.map((c) => [c.column_name, c]));

  record(
    "Robot.simulationOwnerId SURVIVES the correction and is nullable",
    byName.get("simulationOwnerId")?.is_nullable === "YES",
    byName.get("simulationOwnerId")
      ? `${byName.get("simulationOwnerId").data_type}, nullable=${byName.get("simulationOwnerId").is_nullable}`
      : "column absent — the correction dropped the creator metadata it was told to keep",
  );
  record(
    "Robot.simulated is still NOT NULL (Step 1 unchanged)",
    byName.get("simulated")?.is_nullable === "NO",
    byName.get("simulated") ? `nullable=${byName.get("simulated").is_nullable}` : "column absent",
  );

  const fks = await prisma.$queryRawUnsafe(
    `SELECT tc.constraint_name, rc.delete_rule, ccu.table_name AS referenced_table,
            ccu.column_name AS referenced_column
       FROM information_schema.table_constraints tc
       JOIN information_schema.referential_constraints rc ON rc.constraint_name = tc.constraint_name
       JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
       JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
      WHERE tc.table_name = 'Robot' AND kcu.column_name = 'simulationOwnerId'`,
  );
  record(
    "simulationOwnerId still references User.id",
    fks.length === 1 && fks[0].referenced_table === "User" && fks[0].referenced_column === "id",
    fks.length ? `${fks[0].referenced_table}.${fks[0].referenced_column}` : "no foreign key",
  );
  record(
    "the foreign key is still ON DELETE SET NULL, not CASCADE",
    fks[0]?.delete_rule === "SET NULL",
    fks[0]?.delete_rule || "none",
  );

  // ── The central assertion of the correction ───────────────────────────────
  const droppedIndex = await prisma.$queryRawUnsafe(
    `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'Robot' AND indexname = $1`,
    DROPPED_INDEX,
  );
  record(
    `the incorrect ${DROPPED_INDEX} index is GONE`,
    droppedIndex.length === 0,
    droppedIndex.length ? `still present: ${droppedIndex[0].indexdef}` : null,
  );

  // …and it was the ONLY thing removed. A correction that also dropped `UNIQUE ("robotId")`
  // would pass every "many robots per owner" check while quietly removing the constraint
  // the server's identifier generation is validated by.
  const robotIdIndexes = await prisma.$queryRawUnsafe(
    `SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'Robot' AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%"robotId"%'`,
  );
  record(
    "UNIQUE (robotId) was NOT collaterally dropped",
    robotIdIndexes.length >= 1,
    robotIdIndexes.length ? robotIdIndexes[0].indexname : "absent — identifier uniqueness is gone",
  );

  const ownerIndexes = await prisma.$queryRawUnsafe(
    `SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'Robot' AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%"simulationOwnerId"%'`,
  );
  record(
    "no OTHER unique index constrains simulationOwnerId either",
    ownerIndexes.length === 0,
    ownerIndexes.length ? ownerIndexes.map((i) => i.indexname).join(", ") : null,
  );

  // ── 2. A row that predates the columns is still physical and unowned ──────

  await reset(prisma);
  await seed(prisma);

  await prisma.$executeRawUnsafe(
    `INSERT INTO "Robot" ("id","robotId","locationId","status","isOnline")
     VALUES ('legacy-row','LEGACY-1',$1,'IDLE'::"RobotStatus",false)`,
    LOCATION_ID,
  );
  const legacy = await prisma.robot.findUnique({
    where: { robotId: "LEGACY-1" },
    select: { simulated: true, simulationOwnerId: true },
  });
  record(
    "an insert omitting both columns is physical and unowned",
    legacy.simulated === false && legacy.simulationOwnerId === null,
    `simulated=${legacy.simulated} simulationOwnerId=${legacy.simulationOwnerId}`,
  );

  // ── 3. The shipped service, creating MANY for one operator ────────────────

  await reset(prisma);
  await seed(prisma);

  const physical = await robotService.commissionRobot(prisma, {
    robotId: "PHYS-1",
    name: "Physical Rover",
    locationId: LOCATION_ID,
    chassisType: "Rover (Ground)",
    specification: SPEC,
  });
  const physicalRow = await prisma.robot.findUnique({
    where: { robotId: "PHYS-1" },
    select: { simulated: true, simulationOwnerId: true, isOnline: true },
  });
  record(
    "commissionRobot persists a physical, unowned, offline unit",
    physicalRow.simulated === false &&
      physicalRow.simulationOwnerId === null &&
      physicalRow.isOnline === false,
    JSON.stringify(physicalRow),
  );
  record("…and it is fully projected (Agent exists)", Boolean(
    await prisma.agent.findFirst({ where: { robotDbId: physical.id } }),
  ));

  let refusedSimulated = null;
  try {
    await robotService.commissionRobot(prisma, {
      robotId: "PHYS-LOOPHOLE",
      locationId: LOCATION_ID,
      chassisType: "Rover (Ground)",
      specification: SPEC,
      simulated: true,
    });
  } catch (error) {
    refusedSimulated = error;
  }
  const loopholeRow = await prisma.robot.findUnique({ where: { robotId: "PHYS-LOOPHOLE" } });
  record(
    "POST /api/robots still cannot create a simulated robot",
    refusedSimulated?.status === 400 &&
      refusedSimulated?.code === "SIMULATED_NOT_ALLOWED_HERE" &&
      loopholeRow === null,
    refusedSimulated ? `${refusedSimulated.code}, row written: ${loopholeRow !== null}` : "it was ACCEPTED",
  );

  // §11 A, B, C — simulator #1, #2 and #3 for ONE operator, through the shipped service.
  const forA = [];
  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    forA.push(await simulatedRobotService.createSimulatedRobot(prisma, CREATE_BODY, {
      ownerId: USER_A,
    }));
  }

  const rowsForA = await prisma.robot.findMany({
    where: { simulated: true, simulationOwnerId: USER_A },
    select: { robotId: true, simulated: true, simulationOwnerId: true, isOnline: true },
    orderBy: { robotId: "asc" },
  });

  record(
    "the SAME operator created three simulated robots — no 409 anywhere",
    rowsForA.length === 3,
    `${rowsForA.length} row(s): ${rowsForA.map((r) => r.robotId).join(", ")}`,
  );
  // §11 D.
  record(
    "…all three are simulated=true with the SAME simulationOwnerId",
    rowsForA.every((r) => r.simulated === true && r.simulationOwnerId === USER_A),
    JSON.stringify(rowsForA.map((r) => [r.robotId, r.simulated, r.simulationOwnerId === USER_A])),
  );
  record(
    "…with three DISTINCT server-generated ids that encode nothing about the owner",
    new Set(forA.map((r) => r.robotId)).size === 3 &&
      forA.every((r) => /^SIM-[0-9A-F]{12}$/.test(r.robotId) && !r.robotId.includes(USER_A.slice(0, 8))),
    forA.map((r) => r.robotId).join(", "),
  );
  record(
    "…and none of them is online merely because it was created",
    rowsForA.every((r) => r.isOnline === false),
  );
  record("…each is fully projected (an Agent exists for every one)", (
    await Promise.all(forA.map((r) => prisma.agent.findFirst({ where: { robotDbId: r.id } })))
  ).every(Boolean));

  const simB = await simulatedRobotService.createSimulatedRobot(prisma, CREATE_BODY, {
    ownerId: USER_B,
  });
  record(
    "a second operator's units are recorded against that operator, not the first",
    simB.simulationOwnerId === USER_B &&
      (await prisma.robot.count({ where: { simulated: true, simulationOwnerId: USER_A } })) === 3,
    `${simB.robotId} → ${simB.simulationOwnerId}`,
  );

  // ── 4. The concurrency the dropped index used to refuse ───────────────────
  //
  // Two separate client connections, so these are two genuinely concurrent server-side
  // transactions rather than two turns of one event loop. Under the old partial index the
  // second blocked on the unique index and then failed; now it must simply commit.
  //
  // `robot.create` and not raw SQL, for the reason Step 2 established: a raw statement
  // surfaces as `P2010` wrapping PostgreSQL's `23505` text, while the production path calls
  // `prisma.robot.create` and would surface `P2002` with structured meta. Racing the wrong
  // call would say nothing about the path that actually runs.

  await reset(prisma);
  await seed(prisma);

  const clientA = new PrismaClient({ datasources: { db: { url } } });
  const clientB = new PrismaClient({ datasources: { db: { url } } });
  await Promise.all([clientA.$connect(), clientB.$connect()]);

  const raceRow = (robotId) => ({
    robotId,
    locationId: LOCATION_ID,
    simulated: true,
    simulationOwnerId: USER_A,
  });

  let release;
  const held = new Promise((resolve) => { release = resolve; });

  const first = clientA.$transaction(async (tx) => {
    await tx.robot.create({ data: raceRow("SIM-RACE-A") });
    await held; // hold the transaction open so the second genuinely overlaps it
    return "committed";
  }, { timeout: 20000 });

  await new Promise((resolve) => setTimeout(resolve, 300));

  const second = clientB
    .$transaction(async (tx) => {
      await tx.robot.create({ data: raceRow("SIM-RACE-B") });
      return "committed";
    }, { timeout: 20000 })
    .then(() => ({ ok: true, error: null }))
    .catch((error) => ({ ok: false, error }));

  // The second must not be waiting on the first. Under the dropped index it would block
  // here until `release()`; settling before that is itself evidence the index is gone.
  const settledEarly = await Promise.race([
    second.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 1500)),
  ]);

  release();

  const [firstResult, secondResult] = await Promise.all([first, second]);

  record("the first concurrent insert commits", firstResult === "committed");
  record(
    "the second concurrent insert for the SAME owner ALSO commits",
    secondResult.ok === true,
    secondResult.ok
      ? null
      : `refused: ${secondResult.error?.code || ""} ${
        Array.isArray(secondResult.error?.meta?.target) ? `target=[${secondResult.error.meta.target.join(",")}]` : ""
      }`.trim(),
  );
  record(
    "…and it did NOT block on the first transaction (nothing serialises them any more)",
    settledEarly === true,
    settledEarly ? null : "it waited for the first to commit — a uniqueness constraint is still present",
  );
  record(
    "two simulated robots exist for that operator after the race",
    (await prisma.robot.count({ where: { simulated: true, simulationOwnerId: USER_A } })) === 2,
  );

  await Promise.all([clientA.$disconnect(), clientB.$disconnect()]);

  // ── 5. The removal did not over-reach ─────────────────────────────────────
  //
  // Dropping a constraint is as easy to get wrong in the permissive direction as a new
  // constraint is in the restrictive one. These probes are the other half.

  await reset(prisma);
  await seed(prisma);

  let manyOwned = null;
  try {
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await prisma.$executeRawUnsafe(RAW_INSERT, `sim-${i}`, `SIM-RAW-${i}`, LOCATION_ID, true, USER_A);
    }
  } catch (error) {
    manyOwned = error;
  }
  record(
    "the DATABASE itself accepts five simulated rows with one simulationOwnerId",
    manyOwned === null &&
      (await prisma.robot.count({ where: { simulated: true, simulationOwnerId: USER_A } })) === 5,
    manyOwned ? `refused: ${String(manyOwned.message).split("\n")[0]}` : null,
  );

  let physicalPair = null;
  try {
    await prisma.$executeRawUnsafe(RAW_INSERT, "phys-a", "PHYS-A", LOCATION_ID, false, USER_A);
    await prisma.$executeRawUnsafe(RAW_INSERT, "phys-b", "PHYS-B", LOCATION_ID, false, USER_A);
  } catch (error) {
    physicalPair = error;
  }
  record(
    "physical robots are still unconstrained by the owner column",
    physicalPair === null,
    physicalPair ? `refused: ${String(physicalPair.message).split("\n")[0]}` : null,
  );

  let duplicateId = null;
  try {
    await prisma.$executeRawUnsafe(RAW_INSERT, "dupe", "SIM-RAW-0", LOCATION_ID, true, USER_A);
  } catch (error) {
    duplicateId = error;
  }
  record(
    "a duplicate robotId is STILL refused — identifier uniqueness survives",
    duplicateId !== null,
    duplicateId ? null : "it was ACCEPTED — UNIQUE (robotId) is no longer enforced",
  );

  // ── The SHIPPED predicate, against the REAL error shape ───────────────────
  //
  // Step 2's most expensive lesson: the service classified a P2002 by a name real Prisma
  // never reports, the unit-test fake obligingly raised that same name, and the two agreed
  // with each other while neither agreed with PostgreSQL. Only a live error settled it.
  //
  // Now that `isRobotIdConflictError` is the only classifier left, it is the one that has
  // to be re-established the same way — and through `robot.create`, not raw SQL: the raw
  // statement above surfaces as `P2010` wrapping `23505` text, while the production path
  // surfaces `P2002` with structured meta, and the shape is precisely what is classified.
  let createDuplicate = null;
  try {
    await prisma.robot.create({
      data: { robotId: "SIM-RAW-0", locationId: LOCATION_ID, simulated: true, simulationOwnerId: USER_A },
    });
  } catch (error) {
    createDuplicate = error;
  }
  const duplicateEvidence = [
    createDuplicate?.code,
    Array.isArray(createDuplicate?.meta?.target) ? `target=[${createDuplicate.meta.target.join(",")}]` : null,
  ].filter(Boolean).join(" ");

  record(
    "…and the SHIPPED predicate classifies the real P2002 as an identifier collision",
    createDuplicate !== null && simulatedRobotService.isRobotIdConflictError(createDuplicate) === true,
    duplicateEvidence || "no structured error metadata at all",
  );

  // ── 6. Deleting one unit, and deleting the creator ────────────────────────

  await reset(prisma);
  await seed(prisma);

  const three = [];
  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    three.push(await simulatedRobotService.createSimulatedRobot(prisma, CREATE_BODY, {
      ownerId: USER_A,
    }));
  }
  await prisma.robot.delete({ where: { robotId: three[1].robotId } });
  record(
    "deleting one simulated robot leaves the operator's others untouched",
    (await prisma.robot.count({ where: { simulated: true, simulationOwnerId: USER_A } })) === 2 &&
      (await prisma.robot.findUnique({ where: { robotId: three[1].robotId } })) === null,
  );

  const replacement = await simulatedRobotService.createSimulatedRobot(prisma, CREATE_BODY, {
    ownerId: USER_A,
  });
  record(
    "…and the operator may still create more afterwards",
    replacement.simulationOwnerId === USER_A &&
      (await prisma.robot.count({ where: { simulated: true, simulationOwnerId: USER_A } })) === 3,
    replacement.robotId,
  );

  await prisma.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = $1`, USER_A);
  const orphaned = await prisma.robot.findMany({
    where: { simulated: true },
    select: { robotId: true, simulated: true, simulationOwnerId: true },
  });
  record(
    "deleting the creator leaves ALL their robots, unowned (ON DELETE SET NULL)",
    orphaned.length === 3 && orphaned.every((r) => r.simulationOwnerId === null && r.simulated === true),
    JSON.stringify(orphaned),
  );

  // ── 7. SUPER_ADMIN only — through the REAL router, over HTTP ──────────────
  //
  // Sections 3–6 drive the service directly, which cannot see the route's authorisation at
  // all. The gate lives in `simulator.routes.js`, so it is exercised where it lives: real
  // router, real `authUser`, real `requireElevatedRole()`, real Prisma, real JWT.

  await reset(prisma);
  await seed(prisma);

  const app = makeApp(null); // register default: security.elevated_roles = ["SUPER_ADMIN"]

  const firstHttp = await createOverHttp(app, USER_A);
  const secondHttp = await createOverHttp(app, USER_A);
  const thirdHttp = await createOverHttp(app, USER_A);

  record(
    "a SUPER_ADMIN creates simulator #1, #2 and #3 over HTTP — three 201s",
    [firstHttp.status, secondHttp.status, thirdHttp.status].every((s) => s === 201),
    `statuses: ${[firstHttp.status, secondHttp.status, thirdHttp.status].join(", ")} — ${
      JSON.stringify(secondHttp.body?.message || secondHttp.body?.error || "")}`,
  );

  const httpIds = [firstHttp, secondHttp, thirdHttp].map((r) => r.body?.robot?.robotId);
  record(
    "…three distinct robots, all recorded against that SUPER_ADMIN",
    new Set(httpIds).size === 3 &&
      (await prisma.robot.count({ where: { simulated: true, simulationOwnerId: USER_A } })) === 3,
    httpIds.join(", "),
  );
  // Step 3's projection, re-checked here because this is the response an operator's browser
  // actually receives: `simulated` present, creator id absent.
  record(
    "…each 201 exposes `simulated` and does NOT leak simulationOwnerId",
    [firstHttp, secondHttp, thirdHttp].every(
      (r) => r.body?.robot?.simulated === true &&
        r.body.robot.simulationOwnerId === undefined &&
        !JSON.stringify(r.body).includes(USER_A),
    ),
  );

  const anonymous = await createOverHttp(app, null);
  record(
    "an UNAUTHENTICATED creation request is refused with 401",
    anonymous.status === 401,
    `status ${anonymous.status}`,
  );

  // The production `Role` enum contains only SUPER_ADMIN, so no non-elevated user row can
  // exist in this database. The gate is therefore exercised from the other side: the same
  // real user, against a register whose `security.elevated_roles` does not name their role.
  // That is the same comparison a second enum value would meet, and it establishes the gate
  // genuinely consults the list rather than admitting anyone who authenticated.
  const countBefore = await prisma.robot.count();
  const narrowedApp = makeApp(new Map([["security.elevated_roles", ["SOME_OTHER_ROLE"]]]));
  const refusedByRole = await createOverHttp(narrowedApp, USER_A);
  const countAfter = await prisma.robot.count();

  record(
    "a role outside security.elevated_roles is refused with 403",
    refusedByRole.status === 403,
    `status ${refusedByRole.status} ${JSON.stringify(refusedByRole.body)}`,
  );
  record(
    "…and that refusal wrote NOTHING — it happens before the creation service",
    countAfter === countBefore,
    `${countBefore} → ${countAfter} robot rows`,
  );

  // ── Teardown ──────────────────────────────────────────────────────────────

  await reset(prisma);
  await prisma.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = ANY($1::text[])`, [USER_A, USER_B]);
  await prisma.$executeRawUnsafe(`DELETE FROM "Location" WHERE "id" = $1`, LOCATION_ID);
  await prisma.$disconnect();
  await disconnectPrisma().catch(() => {});

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
