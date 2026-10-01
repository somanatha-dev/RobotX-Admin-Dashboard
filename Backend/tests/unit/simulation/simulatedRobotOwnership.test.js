/**
 * STEP 2 (AS CORRECTED) — one SUPER_ADMIN may create MANY simulated robots, and simulated
 * creation is a separate, SUPER_ADMIN-only flow from physical commissioning.
 *
 * The truth statements these tests exist to hold:
 *
 *   > `POST /api/simulator/robot` is available only to SUPER_ADMIN. Each request creates
 *   > exactly ONE simulated Robot, and the same SUPER_ADMIN may make it any number of
 *   > times: there is no per-operator limit. `simulationOwnerId` records which operator
 *   > created the unit and is not a uniqueness boundary. There is no fleet creation API.
 *   > Simulated creation is a separate flow from physical commissioning; physical robots
 *   > remain `simulated = false` with no owner, and a simulated robot never receives a
 *   > physical pairing code.
 *
 * ── What this file used to assert, and why it no longer does ────────────────
 * It asserted "one operator owns at most one simulated robot at a time", which was a
 * misreading of the requirement, and its fake Prisma implemented the partial unique index
 * that enforced it. Both are gone: the index is dropped by
 * `20260912120000_drop_one_simulated_per_owner`, and the store below deliberately no
 * longer enforces any uniqueness on `simulationOwnerId`. A fake that kept enforcing a
 * dropped constraint would be the one place the removed rule still lived.
 *
 * Nothing was deleted to make a test pass. The old Test B ("a second robot is refused")
 * asserted a product rule that is now known to be wrong, so it is replaced by the
 * assertion of the corrected rule — that the second, third and fourth all succeed.
 *
 * ── What is exercised here, and what is NOT ─────────────────────────────────
 * These run against a fake Prisma, so they exercise the service's and controller's real
 * behaviour against a store that behaves like the real one. They are deliberately **not**
 * the evidence that the *database* now permits many robots per owner: a fake that permits
 * something proves nothing about what PostgreSQL permits, and a migration that failed to
 * drop the index would leave this suite entirely green. That evidence is
 * `tools/verify/step2SimulatedOwnership.js`, which applies the real migrations to a real
 * PostgreSQL cluster, asserts the index is absent, and races two concurrent creations by
 * one operator through it.
 */

jest.mock("../../../src/db/prisma");

const express = require("express");
const cookieParser = require("cookie-parser");
const request = require("supertest");
const jwt = require("jsonwebtoken");
const fs = require("fs");
const path = require("path");

const { getPrisma } = require("../../../src/db/prisma");
const simulatorRoutes = require("../../../src/routes/simulator.routes");
const errorHandler = require("../../../src/middlewares/errorHandler");
const robotService = require("../../../src/services/robot.service");
const simulatedRobotService = require("../../../src/services/simulatedRobot.service");
const { createVirtualRobotSimulator } = require("../../../src/simulation/SimulationEngine");
const { createTestKv } = require("../../helpers/testKv");

const silentLogger = { info() {}, warn() {}, error() {} };

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";

/**
 * A third account whose role is NOT elevated.
 *
 * ── Why this user exists, and what it does and does not prove ───────────────
 * The production `Role` enum currently contains exactly one value:
 *
 *     enum Role { SUPER_ADMIN }
 *
 * so PostgreSQL cannot hold a row with any other role, and no non-SUPER_ADMIN account is
 * representable in the real database today. §6 of the correction says, for exactly this
 * case, to document that and to test the authorisation guard at the appropriate existing
 * seam — not to invent a role.
 *
 * The seam is `requireElevatedRole()`, which reads `req.user.role` and compares it against
 * `security.elevated_roles`. This user makes the fake `user.findUnique` answer with a role
 * outside that list, which is what a second enum value would eventually produce and what a
 * widened `security.elevated_roles` already can. It proves the gate refuses a
 * non-elevated role; it does not, and cannot, claim such a role exists in production.
 */
const USER_UNPRIVILEGED = "33333333-3333-4333-8333-333333333333";
const UNPRIVILEGED_ROLE = "OPERATOR";

const SPEC = Object.freeze({
  massKg: 45,
  maxSpeedMps: 2.5,
  normalSpeedMps: 1.4,
  batteryCapacityWh: 500,
  batteryReservePct: 15,
  payloadCapacityKg: 20,
  initialBatteryPct: 82,
});

/** The minimum a caller sends to create one simulated robot. No id, no owner, no count. */
const CREATE_BODY = Object.freeze({
  name: "Sim Rover",
  locationId: "loc-1",
  chassisType: "Rover (Ground)",
  specification: SPEC,
});

// ═══════════════════════════════════════════════════════════════════════════
// A Prisma stand-in that ENFORCES the two unique constraints the schema declares
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The error shape Prisma raises for a unique-constraint violation.
 *
 * ── This shape is measured, not assumed ─────────────────────────────────────
 * `meta.target` is the **column list**, as an array — `{ modelName: "Robot", target:
 * ["simulationOwnerId"] }` — and that holds even for the partial unique index, which is
 * created by raw SQL and which Prisma does not know exists.
 *
 * The first version of this helper raised the *index name* instead, because that is what
 * the service was written to look for. The two agreed with each other and neither agreed
 * with PostgreSQL: every real concurrent duplicate would have escaped the translation and
 * been answered with an unhandled 500. `tools/verify/step2SimulatedOwnership.js` caught it
 * against a live server, and this helper now reproduces the shape that tool observed.
 *
 * The message deliberately includes a fake code frame mentioning `robotId`, which is what
 * a real P2002 message carries — Prisma renders the failing call site into it. Any
 * implementation that classifies the violation by searching the message will mistake an
 * ownership conflict for an identifier conflict and retry instead of returning 409.
 *
 * @param {string} column the colliding column, as Prisma reports it
 */
function uniqueViolation(column) {
  const err = new Error(
    "\nInvalid `prisma.robot.create()` invocation in\n" +
      "src/services/robot.service.js:129:31\n\n" +
      "  127   const robot = await tx.robot.create({\n" +
      "  128     data: {\n" +
      "→ 129       robotId: robotCode,\n" +
      `Unique constraint failed on the fields: (\`${column}\`)`,
  );
  err.code = "P2002";
  err.meta = { modelName: "Robot", target: [column] };
  return err;
}

/**
 * A store whose `Robot` table honours `UNIQUE ("robotId")` — the schema's own declaration,
 * and after the correction the ONLY unique constraint the creation path can violate.
 *
 * It is enforced *at insert*, which is what makes the service's P2002 handling reachable
 * in a unit test. Everything else is the minimum the creation transaction touches.
 *
 * ── What this store deliberately does NOT enforce ───────────────────────────
 * Any uniqueness on `simulationOwnerId`. It used to implement
 * `UNIQUE ("simulationOwnerId") WHERE "simulated" AND "simulationOwnerId" IS NOT NULL`,
 * mirroring the partial index the original Step 2 migration created. That index was the
 * wrong rule and has been dropped, so the mirror is gone too — otherwise this fake would
 * be the last place in the system where one-simulated-robot-per-operator was still true,
 * and the suite would go red for the corrected behaviour it is supposed to prove.
 */
function createStorePrisma() {
  const robots = [];
  let nextId = 1;

  const passthroughUpsert = (label) =>
    jest.fn(async ({ create }) => ({ id: `${label}-${create.modelId || create.bundleId || create.classId}`, ...create }));

  const prisma = {
    __robots: robots,

    user: {
      findUnique: jest.fn(async ({ where }) => {
        if ([USER_A, USER_B].includes(where?.id)) {
          return { id: where.id, email: `${where.id}@robotx.test`, role: "SUPER_ADMIN" };
        }
        if (where?.id === USER_UNPRIVILEGED) {
          return { id: where.id, email: `${where.id}@robotx.test`, role: UNPRIVILEGED_ROLE };
        }
        return null;
      }),
    },

    location: {
      findUnique: jest.fn(async ({ where }) =>
        where?.id === "loc-1" ? { id: "loc-1", lat: 12.9, lon: 77.5 } : null,
      ),
    },

    campus: { findUnique: jest.fn(async () => null) },

    robot: {
      findUnique: jest.fn(async ({ where }) => {
        if (where?.robotId !== undefined) return robots.find((r) => r.robotId === where.robotId) || null;
        if (where?.id !== undefined) return robots.find((r) => r.id === where.id) || null;
        return null;
      }),

      findFirst: jest.fn(async ({ where } = {}) =>
        robots.find(
          (r) =>
            (where?.simulated === undefined || r.simulated === where.simulated) &&
            (where?.simulationOwnerId === undefined || r.simulationOwnerId === where.simulationOwnerId),
        ) || null,
      ),

      findMany: jest.fn(async ({ where } = {}) =>
        robots.filter((r) => where?.simulated === undefined || r.simulated === where.simulated),
      ),

      create: jest.fn(async ({ data }) => {
        // UNIQUE ("robotId") — and nothing else. See the note on this factory: repeated
        // `simulationOwnerId` values among simulated rows are legal and must insert.
        if (robots.some((r) => r.robotId === data.robotId)) throw uniqueViolation("robotId");

        const row = { id: `robot-${nextId++}`, ...data };
        robots.push(row);
        return row;
      }),

      delete: jest.fn(async ({ where }) => {
        const index = robots.findIndex((r) => r.robotId === where?.robotId);
        if (index < 0) throw new Error("record not found");
        return robots.splice(index, 1)[0];
      }),

      update: jest.fn(),
      updateMany: jest.fn(),
    },

    mobilityModel: { upsert: passthroughUpsert("mob"), update: jest.fn(async ({ where }) => ({ id: where.id })) },
    energyModel: { upsert: passthroughUpsert("eng"), update: jest.fn(async ({ where }) => ({ id: where.id })) },
    containerModel: { upsert: passthroughUpsert("ctr"), update: jest.fn(async ({ where }) => ({ id: where.id })) },
    // V1 demonstration: the simulated class declaration's writes (see
    // `simulatedClassDeclaration.service`), passthrough spies for the reason given below.
    compartment: { upsert: jest.fn(async ({ create }) => ({ id: "compartment-1", ...create })) },
    capabilityBundle: { upsert: passthroughUpsert("cap") },
    capability: { deleteMany: jest.fn(async () => ({ count: 0 })), createMany: jest.fn(async ({ data }) => ({ count: data.length })) },
    agentClass: { upsert: passthroughUpsert("class"), update: jest.fn(async ({ where }) => ({ id: where.id })) },
    agent: { upsert: jest.fn(async ({ create }) => ({ id: "agent-1", ...create })) },

    // The two tables `agentEnergyProvisioning.service` writes inside the same creation
    // transaction. Modelled here because the commissioning path now writes them for a
    // simulated unit; without them the shared transaction throws and every test in this
    // file fails for a reason that has nothing to do with ownership.
    //
    // Kept as passthrough spies rather than a store: this file is about *who owns what*,
    // and the energy rows' own contents are asserted by
    // `tests/unit/robots/agentEnergyProvisioning.test.js`.
    batteryState: {
      upsert: jest.fn(async ({ create }) => ({ id: "battery-1", ...create })),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    energyModelParams: {
      upsert: jest.fn(async ({ create }) => ({ id: "params-1", ...create })),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },

    $transaction: jest.fn(async (fn) => {
      const { $transaction, ...tx } = prisma;
      return fn(tx);
    }),
  };

  return prisma;
}

/** A JWT the real `authUser` middleware accepts for this user. */
function tokenFor(userId) {
  return jwt.sign({ id: userId }, process.env.JWT_SECRET, { expiresIn: "1h" });
}

/** An express app mounting the REAL simulator router, with the real auth middleware. */
function makeApp({ virtualSimulator = null, kv = null } = {}) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.locals.virtualSimulator = virtualSimulator;
  app.locals.kv = kv;
  app.use("/api/simulator", simulatorRoutes);
  app.use(errorHandler);
  return app;
}

/**
 * POST /api/simulator/robot as `userId`.
 *
 * Each call presents a distinct client address. The router's rate limiter is a
 * module-level closure shared by every test in this file, and a suite that silently
 * started returning 429 partway through would look like a behaviour change in the feature
 * under test. The limiter has its own coverage; it is not what this file is about.
 */
let clientCounter = 0;
function createAs(app, userId, body = CREATE_BODY) {
  clientCounter += 1;
  return request(app)
    .post("/api/simulator/robot")
    .set("X-Forwarded-For", `10.0.0.${clientCounter % 250}`)
    .set("Authorization", `Bearer ${tokenFor(userId)}`)
    .send(body);
}

/** A simulator double that accepts everything and records what it was asked. */
function runningSimulator() {
  const asked = [];
  return {
    asked,
    async addRobot(config) {
      asked.push(config);
      return { started: true, reason: null };
    },
  };
}

let prisma;
beforeEach(() => {
  prisma = createStorePrisma();
  getPrisma.mockReturnValue(prisma);
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST A — one user creates one simulator
// ═══════════════════════════════════════════════════════════════════════════

describe("Test A — an authenticated operator can create one simulated robot", () => {
  test("201, simulated = true, owned by the caller, with a server-generated id", async () => {
    const simulator = runningSimulator();
    const response = await createAs(makeApp({ virtualSimulator: simulator }), USER_A);

    expect(response.status).toBe(201);
    expect(response.body.ok).toBe(true);
    expect(response.body.robot.simulated).toBe(true);
    expect(response.body.robot.robotId).toMatch(/^SIM-[0-9A-F]{12}$/);

    // Ownership is a fact in the database…
    const row = prisma.__robots.find((r) => r.robotId === response.body.robot.robotId);
    expect(row.simulationOwnerId).toBe(USER_A);
    expect(row.simulated).toBe(true);

    // …and deliberately not in the response. See requirement 18: operator identity must
    // not travel with the robot projection.
    expect(response.body.robot.simulationOwnerId).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain(USER_A);
  });

  test("the unit is fully projected — AgentClass and Agent, not an orphan Robot row", async () => {
    await createAs(makeApp({ virtualSimulator: runningSimulator() }), USER_A);

    // The same machinery physical commissioning uses, which is the point: a simulated
    // agent must be the same kind of thing to the assignment engine as a physical one.
    expect(prisma.agentClass.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.agent.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.mobilityModel.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.energyModel.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.containerModel.upsert).toHaveBeenCalledTimes(1);
  });

  test("the whole creation happens in one transaction", async () => {
    await createAs(makeApp({ virtualSimulator: runningSimulator() }), USER_A);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST B — the same SUPER_ADMIN creates MANY. This is the corrected rule.
// ═══════════════════════════════════════════════════════════════════════════

describe("Test B — one SUPER_ADMIN may create many simulated robots", () => {
  test("three consecutive requests each create one robot, all owned by the same operator", async () => {
    // §11 A, B, C and D, as one sequence: simulator #1, #2 and #3 for one SUPER_ADMIN.
    const app = makeApp({ virtualSimulator: runningSimulator() });

    const responses = [];
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      responses.push(await createAs(app, USER_A));
    }

    expect(responses.map((r) => r.status)).toEqual([201, 201, 201]);

    const ids = responses.map((r) => r.body.robot.robotId);
    // D — distinct, server-generated identifiers.
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(id).toMatch(/^SIM-[0-9A-F]{12}$/);

    // D — three rows, every one simulated and attributed to the same SUPER_ADMIN.
    const rows = prisma.__robots.filter((r) => ids.includes(r.robotId));
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.simulated).toBe(true);
      expect(row.simulationOwnerId).toBe(USER_A);
    }

    // Nothing else was created: one request, one robot, three times.
    expect(prisma.__robots).toHaveLength(3);
  });

  test("no response is a 409, and no response mentions an ownership limit", async () => {
    // The specific regression. Before the correction the second request answered 409
    // `SIMULATED_ROBOT_ALREADY_OWNED`, and the operator was told to delete the robot they
    // had. Asserting the absence of that sentence is what would catch the rule being
    // reintroduced somewhere other than the database.
    const app = makeApp({ virtualSimulator: runningSimulator() });

    const first = await createAs(app, USER_A);
    const second = await createAs(app, USER_A);
    const third = await createAs(app, USER_A);

    for (const response of [first, second, third]) {
      expect(response.status).toBe(201);
      expect(JSON.stringify(response.body)).not.toMatch(/already own|one at a time|ALREADY_OWNED/i);
    }
  });

  test("the service itself imposes no limit either — it is not merely the route that allows it", async () => {
    // Driven below the HTTP layer so a future guard added in the controller could not make
    // this pass by accident, and so the assertion is about the creation service rather than
    // about the router.
    const created = [];
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      created.push(await simulatedRobotService.createSimulatedRobot(prisma, CREATE_BODY, {
        ownerId: USER_A,
      }));
    }

    expect(new Set(created.map((r) => r.robotId)).size).toBe(5);
    expect(prisma.__robots.filter((r) => r.simulated === true && r.simulationOwnerId === USER_A))
      .toHaveLength(5);
  });

  test("the service holds no ownership pre-check at all", () => {
    // Structural, because the property is an absence, and an absence has no behavioural
    // witness once the limit is gone: a service that still counted the operator's robots
    // but no longer acted on the count would pass every test above. The old implementation
    // queried `findFirst({ where: { simulated: true, simulationOwnerId } })` before
    // inserting; that query, and the 409 it raised, must be gone rather than dormant.
    const source = fs.readFileSync(
      path.join(__dirname, "..", "..", "..", "src", "services", "simulatedRobot.service.js"),
      "utf8",
    );
    const code = source
      .split(/\r?\n/)
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join("\n");

    expect(code).not.toMatch(/findOwnedSimulatedRobot/);
    expect(code).not.toMatch(/SIMULATED_ROBOT_ALREADY_OWNED/);
    expect(code).not.toMatch(/isOwnerConflictError/);
    expect(code).not.toMatch(/\.robot\.findFirst\s*\(/);
    // The detector is not vacuous: it does find the code that IS there.
    expect(code).toMatch(/createRobotWithProjection/);
  });

  test("the dropped index is not reachable through the service's exports", () => {
    // The public surface of the module is part of the correction: a still-exported
    // `isOwnerConflictError` would be a predicate for a constraint that no longer exists,
    // and the next caller to reach for it would be reimplementing the removed rule.
    expect(simulatedRobotService.isOwnerConflictError).toBeUndefined();
    expect(simulatedRobotService.findOwnedSimulatedRobot).toBeUndefined();
    expect(simulatedRobotService.OWNER_UNIQUE_INDEX).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST C — separate operators are separately recorded
// ═══════════════════════════════════════════════════════════════════════════

describe("Test C — two operators may each create as many as they like", () => {
  test("creations by two operators succeed and are attributed correctly", async () => {
    const app = makeApp({ virtualSimulator: runningSimulator() });

    const a1 = await createAs(app, USER_A);
    const b1 = await createAs(app, USER_B);
    const a2 = await createAs(app, USER_A);
    const b2 = await createAs(app, USER_B);

    expect([a1.status, b1.status, a2.status, b2.status]).toEqual([201, 201, 201, 201]);

    const ownerOf = (response) =>
      prisma.__robots.find((r) => r.robotId === response.body.robot.robotId).simulationOwnerId;

    expect([ownerOf(a1), ownerOf(a2)]).toEqual([USER_A, USER_A]);
    expect([ownerOf(b1), ownerOf(b2)]).toEqual([USER_B, USER_B]);
    expect(prisma.__robots.filter((r) => r.simulated === true)).toHaveLength(4);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST D — two concurrent requests produce TWO robots
// ═══════════════════════════════════════════════════════════════════════════

describe("Test D — concurrent creation by one SUPER_ADMIN yields two distinct robots", () => {
  // This describe replaces the Step 2 concurrency test, which asserted "one 201, one 409,
  // one robot". That test was designed around the incorrect one-per-owner index and
  // asserted the defect, so it could not be adjusted — the expected outcome is the
  // opposite one. What survives is the *shape* of the probe: two requests genuinely in
  // flight at once, and an assertion about how many rows exist afterwards.

  test("two simultaneous requests: two 201s, two robots, one owner", async () => {
    const app = makeApp({ virtualSimulator: runningSimulator() });

    const [first, second] = await Promise.all([createAs(app, USER_A), createAs(app, USER_A)]);

    expect([first.status, second.status]).toEqual([201, 201]);
    expect(first.body.robot.robotId).not.toBe(second.body.robot.robotId);

    const simulated = prisma.__robots.filter((r) => r.simulated === true);
    expect(simulated).toHaveLength(2);
    expect(simulated.map((r) => r.simulationOwnerId)).toEqual([USER_A, USER_A]);
  });

  test("neither concurrent request is refused for any ownership reason", async () => {
    const app = makeApp({ virtualSimulator: runningSimulator() });
    const results = await Promise.all([
      createAs(app, USER_A),
      createAs(app, USER_A),
      createAs(app, USER_A),
    ]);

    for (const response of results) {
      expect(response.status).not.toBe(409);
    }
    expect(prisma.__robots.filter((r) => r.simulated === true)).toHaveLength(3);
  });

  test("a genuine identifier collision between concurrent requests is still resolved", async () => {
    // A 409 is still the right answer to a *real* conflict; what is gone is the one that
    // fired because of ownership. The remaining reachable conflict is two requests drawing
    // the same identifier, and the service's response to it is to draw another — not to
    // refuse the caller, who asked for a robot and not for a particular name.
    const create = prisma.robot.create;
    let collided = false;
    prisma.robot.create = jest.fn(async (args) => {
      if (!collided) {
        collided = true;
        throw uniqueViolation("robotId");
      }
      return create(args);
    });

    const created = await simulatedRobotService.createSimulatedRobot(prisma, CREATE_BODY, {
      ownerId: USER_A,
    });

    expect(collided).toBe(true);
    expect(created.robotId).toMatch(/^SIM-[0-9A-F]{12}$/);
    expect(prisma.__robots).toHaveLength(1);
  });

  test("the authority for this is PostgreSQL, not this file", () => {
    // Stated as an executable pointer rather than a comment: the live verification exists,
    // asserts the dropped index is absent from the real schema, and races real concurrent
    // transactions by one operator through the real table. If it is ever deleted, this test
    // says so rather than the suite quietly losing the evidence.
    const script = path.join(__dirname, "..", "..", "..", "tools", "verify", "step2SimulatedOwnership.js");
    expect(fs.existsSync(script)).toBe(true);

    const source = fs.readFileSync(script, "utf8");
    // It talks to a real server through the generated client…
    expect(source).toMatch(/new PrismaClient/);
    // …it asserts the dropped index is genuinely absent, which is the half no fake store
    // can establish…
    expect(source).toMatch(/Robot_one_simulated_per_owner/);
    expect(source).toMatch(/pg_indexes/);
    // …and it races two genuinely separate connections, which is the only interleaving that
    // can show the database itself admits both.
    expect(source).toMatch(/clientA/);
    expect(source).toMatch(/clientB/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST E — the caller cannot choose the owner
// ═══════════════════════════════════════════════════════════════════════════

describe("Test E — ownership is derived from authentication, never from the body", () => {
  test("a request naming another user's id is refused, and writes nothing", async () => {
    const app = makeApp({ virtualSimulator: runningSimulator() });

    const response = await createAs(app, USER_A, { ...CREATE_BODY, simulationOwnerId: USER_B });

    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/simulationOwnerId is not a request field/i);
    expect(prisma.__robots).toHaveLength(0);
  });

  test("even if the field were tolerated, the owner written is the authenticated user", async () => {
    // The second fence. The service refuses the field above; this asserts that the value
    // that reaches the column comes from `context.ownerId` and from nowhere else, so a
    // future edit that relaxed the refusal would still not create ownership under another
    // account. `createRobotWithProjection` reads identity only from its third argument.
    const row = await robotService.createRobotWithProjection(
      prisma,
      { ...CREATE_BODY, simulationOwnerId: USER_B },
      { robotCode: "SIM-FENCE", simulated: true, simulationOwnerId: USER_A },
    );
    expect(prisma.__robots.find((r) => r.robotId === "SIM-FENCE").simulationOwnerId).toBe(USER_A);
    expect(row.robotId).toBe("SIM-FENCE");
  });

  test("a caller-supplied robotId is refused", async () => {
    const app = makeApp({ virtualSimulator: runningSimulator() });
    const response = await createAs(app, USER_A, { ...CREATE_BODY, robotId: "PHYS-1" });

    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/robotId is not a request field/i);
    expect(prisma.__robots).toHaveLength(0);
  });

  test("an unauthenticated request creates nothing", async () => {
    const response = await request(makeApp()).post("/api/simulator/robot").send(CREATE_BODY);
    expect(response.status).toBe(401);
    expect(prisma.__robots).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SUPER_ADMIN ONLY — enforced on the server, at the existing §23.4 seam
// ═══════════════════════════════════════════════════════════════════════════

describe("Simulator creation is SUPER_ADMIN-only, and the server is what says so", () => {
  test("a SUPER_ADMIN is allowed through", async () => {
    const response = await createAs(makeApp({ virtualSimulator: runningSimulator() }), USER_A);
    expect(response.status).toBe(201);
    expect(prisma.__robots).toHaveLength(1);
  });

  test("a non-elevated role is refused with 403 and creates nothing", async () => {
    // See the note on USER_UNPRIVILEGED: the production `Role` enum holds only
    // SUPER_ADMIN, so this exercises the guard at its own seam — `requireElevatedRole()`
    // reading `req.user.role` — rather than claiming a second role exists in the database.
    const response = await createAs(
      makeApp({ virtualSimulator: runningSimulator() }),
      USER_UNPRIVILEGED,
    );

    expect(response.status).toBe(403);
    expect(response.body.error).toBe("Forbidden");
    expect(prisma.__robots).toHaveLength(0);
  });

  test("the refusal happens before the service is reached, not inside it", async () => {
    // A 403 produced after the row was written, or after the creation service had run and
    // been rolled back, would be a different and much weaker property. Nothing at all is
    // attempted: the request never reaches `robot.create`.
    await createAs(makeApp({ virtualSimulator: runningSimulator() }), USER_UNPRIVILEGED);
    expect(prisma.robot.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  test("an unauthenticated request is refused before the role is ever considered", async () => {
    const response = await request(makeApp({ virtualSimulator: runningSimulator() }))
      .post("/api/simulator/robot")
      .send(CREATE_BODY);

    expect(response.status).toBe(401);
    expect(prisma.robot.create).not.toHaveBeenCalled();
  });

  test("the elevated-role list is the shared one, not a copy in this router", () => {
    // §23.4's whole point: before Phase 14, `config.routes.js` and `shards.routes.js` each
    // carried their own `const ELEVATED_ROLES = ["SUPER_ADMIN"]`, and two copies of an
    // authorisation list is one copy that gets updated. This route must read the same
    // register value through the same middleware, so widening or narrowing
    // `security.elevated_roles` moves every gated surface together.
    const source = fs.readFileSync(
      path.join(__dirname, "..", "..", "..", "src", "routes", "simulator.routes.js"),
      "utf8",
    );
    const code = source
      .split(/\r?\n/)
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join("\n");

    expect(code).toMatch(/requireElevatedRole/);
    // No second statement of the role list, and no hand-rolled comparison against a role.
    expect(code).not.toMatch(/ELEVATED_ROLES\s*=/);
    expect(code).not.toMatch(/role\s*===/);
    // And no new security mechanism smuggled in beside it.
    expect(code).not.toMatch(/webauthn|passkey|pin|fingerprint/i);
  });

  test("the creation route carries the gate; nothing else on the router was silently widened", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "..", "..", "src", "routes", "simulator.routes.js"),
      "utf8",
    );
    const code = source
      .split(/\r?\n/)
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join("\n");

    // The creation route is gated…
    expect(code).toMatch(/router\.post\(\s*"\/robot"[^)]*superAdminOnly/);
    // …and `authUser` still covers the whole router, so the gate is an addition to
    // authentication rather than a replacement for it.
    expect(code).toMatch(/router\.use\(authUser\)/);
  });

  test("the existing step-up mechanisms were not touched, duplicated, or bypassed", () => {
    // The correction is explicitly not allowed to redesign, replace, duplicate or weaken
    // the existing passkey/WebAuthn/PIN step-up. Asserted as a property of the shipped
    // routing table: the WebAuthn and PIN ceremonies are still mounted on the auth router
    // and nowhere else, and there is exactly one of each.
    const authRoutes = fs.readFileSync(
      path.join(__dirname, "..", "..", "..", "src", "routes", "auth.routes.js"),
      "utf8",
    );

    for (const route of [
      "/webauthn/register-options",
      "/webauthn/register",
      "/webauthn/auth-options",
      "/webauthn/verify",
      "/webauthn/status",
      "/pin-auth",
    ]) {
      expect(authRoutes.split(`"${route}"`).length - 1).toBe(1);
    }

    // And no second WebAuthn flow appeared anywhere in the simulator or robot surfaces.
    const src = path.join(__dirname, "..", "..", "..", "src");
    for (const rel of [
      "routes/simulator.routes.js",
      "controllers/simulator.controller.js",
      "services/simulatedRobot.service.js",
    ]) {
      const source = fs.readFileSync(path.join(src, rel), "utf8");
      expect({ rel, webauthn: /require\(.*webauthn|generateAuthenticationOptions|verifyAuthenticationResponse/.test(source) })
        .toEqual({ rel, webauthn: false });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST F — physical robots are unaffected
// ═══════════════════════════════════════════════════════════════════════════

describe("Test F — physical commissioning is unchanged, and consumes no simulator slot", () => {
  test("a physical unit is simulated = false with a NULL owner", async () => {
    await robotService.commissionRobot(prisma, {
      robotId: "PHYS-1",
      name: "Physical Rover",
      locationId: "loc-1",
      chassisType: "Rover (Ground)",
      specification: SPEC,
    });

    const row = prisma.__robots.find((r) => r.robotId === "PHYS-1");
    expect(row.simulated).toBe(false);
    expect(row.simulationOwnerId).toBeNull();
  });

  test("physical commissioning and simulated creation do not interfere", async () => {
    for (const robotId of ["PHYS-1", "PHYS-2", "PHYS-3"]) {
      // eslint-disable-next-line no-await-in-loop
      await robotService.commissionRobot(prisma, {
        robotId,
        locationId: "loc-1",
        chassisType: "Rover (Ground)",
        specification: SPEC,
      });
    }

    const response = await createAs(makeApp({ virtualSimulator: runningSimulator() }), USER_A);
    expect(response.status).toBe(201);
  });

  test("the physical endpoint refuses `simulated: true` and names where to go instead", async () => {
    await expect(
      robotService.commissionRobot(prisma, {
        robotId: "PHYS-X",
        locationId: "loc-1",
        chassisType: "Rover (Ground)",
        specification: SPEC,
        simulated: true,
      }),
    ).rejects.toMatchObject({ status: 400, code: "SIMULATED_NOT_ALLOWED_HERE" });

    expect(prisma.__robots).toHaveLength(0);
  });

  test("the physical endpoint refuses a caller-supplied simulation owner", async () => {
    await expect(
      robotService.commissionRobot(prisma, {
        robotId: "PHYS-Y",
        locationId: "loc-1",
        chassisType: "Rover (Ground)",
        specification: SPEC,
        simulationOwnerId: USER_A,
      }),
    ).rejects.toMatchObject({ status: 400, code: "OWNER_NOT_CALLER_SUPPLIED" });

    expect(prisma.__robots).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST G — simulated creation never touches the physical pairing flow
// ═══════════════════════════════════════════════════════════════════════════

describe("Test G — a simulated robot receives no physical pairing code", () => {
  test("no pairing:{robotId} key is written", async () => {
    const { kv, close } = await createTestKv();
    try {
      const response = await createAs(
        makeApp({ virtualSimulator: runningSimulator(), kv }),
        USER_A,
      );
      expect(response.status).toBe(201);

      expect(await kv.get(`pairing:${response.body.robot.robotId}`)).toBeFalsy();
    } finally {
      await close();
    }
  });

  test("the simulated creation path does not reference the pairing flow at all", () => {
    // Structural, because the property is an absence. A pairing code minted for a row no
    // hardware will ever claim is a physical credential issued against a simulated unit,
    // which is the inverse of the Step 1 hazard and just as wrong.
    const root = path.join(__dirname, "..", "..", "..", "src");
    for (const rel of ["services/simulatedRobot.service.js", "controllers/simulator.controller.js"]) {
      const source = fs.readFileSync(path.join(root, rel), "utf8");
      const code = source
        .split(/\r?\n/)
        .map((line) => line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, ""))
        .join("\n");
      expect({ rel, pairing: /pairing:|commissionRobotWithPairing/.test(code) }).toEqual({
        rel,
        pairing: false,
      });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST H — a disabled simulator is reported as disabled
// ═══════════════════════════════════════════════════════════════════════════

describe("Test H — creation never claims a simulator is running when it is not", () => {
  test("with the simulator disabled: the row is created, and nothing is claimed to run", async () => {
    // The REAL engine, in the default posture Step 1 established
    // (`ENABLE_VIRTUAL_SIMULATOR` unset ⇒ disabled).
    const engine = createVirtualRobotSimulator({
      prisma,
      kv: null,
      serverUrl: "http://127.0.0.1:0",
      logger: silentLogger,
      enabled: false,
    });

    const response = await createAs(makeApp({ virtualSimulator: engine }), USER_A);

    expect(response.status).toBe(201);
    expect(response.body.status).toBe("PERSISTED_NOT_RUNNING");
    expect(response.body.simulator).toEqual({ running: false, reason: "SIMULATOR_DISABLED" });

    // No fabricated liveness anywhere: not in the response, not in the row.
    expect(response.body.robot.isOnline).toBe(false);
    expect(prisma.__robots[0].isOnline).toBe(false);
    expect(engine.getStatus().robotCount).toBe(0);
  });

  test("an engine that is enabled but not started is reported as not running either", async () => {
    const { kv, close } = await createTestKv();
    try {
      const engine = createVirtualRobotSimulator({
        prisma,
        kv,
        serverUrl: "http://127.0.0.1:0",
        logger: silentLogger,
        enabled: true,
      });
      // Deliberately not started, so no socket is opened and no listener is needed.
      const response = await createAs(makeApp({ virtualSimulator: engine, kv }), USER_A);

      expect(response.status).toBe(201);
      expect(response.body.status).toBe("PERSISTED_NOT_RUNNING");
      expect(response.body.simulator).toEqual({ running: false, reason: "ENGINE_NOT_STARTED" });
      // The engine did adopt it — the row is genuinely simulated — but "adopted" is not
      // "running", and the response says which.
      expect(engine.getStatus().robotCount).toBe(1);
    } finally {
      await close();
    }
  });

  test("with no simulator initialised at all, the outcome is still truthful", async () => {
    const response = await createAs(makeApp({ virtualSimulator: null }), USER_A);
    expect(response.status).toBe(201);
    expect(response.body.simulator).toEqual({
      running: false,
      reason: "SIMULATOR_NOT_INITIALISED",
    });
  });

  test("a started simulation IS reported as running", async () => {
    // The other half: the response is not hardcoded to "not running" either.
    const response = await createAs(makeApp({ virtualSimulator: runningSimulator() }), USER_A);
    expect(response.body.status).toBe("RUNNING");
    expect(response.body.simulator).toEqual({ running: true, reason: null });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST I — physical credential safety (Step 1 regression, narrowed to this flow)
// ═══════════════════════════════════════════════════════════════════════════

describe("Test I — creating a simulated robot never touches a physical robot's session", () => {
  test("the physical session and live-state keys are byte-identical afterwards", async () => {
    const { kv, close } = await createTestKv();
    try {
      const PHYSICAL_SESSION = "physical-session-token-issued-by-pairing";
      const PHYSICAL_LIVE = JSON.stringify({
        lat: 12.8, lon: 77.4, battery: 63, status: "IDLE", speed: 0, lastSeenAt: 1_700_000_000_000,
      });
      await kv.set("session:PHYS-1", PHYSICAL_SESSION, { ex: 3600 });
      await kv.set("robot:PHYS-1", PHYSICAL_LIVE, { ex: 3600 });

      await robotService.commissionRobot(prisma, {
        robotId: "PHYS-1",
        locationId: "loc-1",
        chassisType: "Rover (Ground)",
        specification: SPEC,
      });

      const engine = createVirtualRobotSimulator({
        prisma, kv, serverUrl: "http://127.0.0.1:0", logger: silentLogger, enabled: true,
      });
      const response = await createAs(makeApp({ virtualSimulator: engine, kv }), USER_A);
      expect(response.status).toBe(201);

      expect(await kv.get("session:PHYS-1")).toBe(PHYSICAL_SESSION);
      expect(await kv.get("robot:PHYS-1")).toBe(PHYSICAL_LIVE);

      // The simulated unit has its own session, which is correct: for a simulated robot
      // the simulator *is* the robot.
      expect(await kv.get(`session:${response.body.robot.robotId}`)).toBeTruthy();
    } finally {
      await close();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST J — deleting one simulated robot leaves the operator's others alone
// ═══════════════════════════════════════════════════════════════════════════

describe("Test J — deletion removes one unit and nothing else", () => {
  test("create three, delete one, the other two survive and a fourth can still be created", async () => {
    // Under the incorrect rule this test asked whether deletion "vacated the slot", which
    // only meant anything while there was a slot. What it means now is that decommissioning
    // is per-unit: the existing `DELETE /api/robots/:robotId` path removes one row and has
    // no bookkeeping of its own about how many the operator has.
    const app = makeApp({ virtualSimulator: runningSimulator() });

    const created = [];
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      created.push((await createAs(app, USER_A)).body.robot.robotId);
    }

    await prisma.robot.delete({ where: { robotId: created[1] } });

    const remaining = prisma.__robots.filter((r) => r.simulated === true).map((r) => r.robotId);
    expect(remaining.sort()).toEqual([created[0], created[2]].sort());

    const fourth = await createAs(app, USER_A);
    expect(fourth.status).toBe(201);
    expect(created).not.toContain(fourth.body.robot.robotId);
    expect(prisma.__robots.filter((r) => r.simulated === true)).toHaveLength(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST K — generated identifiers are globally unique
// ═══════════════════════════════════════════════════════════════════════════

describe("Test K — generated simulated ids collide with nothing", () => {
  test("2000 generated ids are all distinct and carry no owner information", () => {
    const ids = new Set();
    for (let i = 0; i < 2000; i += 1) ids.add(simulatedRobotService.generateSimulatedRobotId());
    expect(ids.size).toBe(2000);

    for (const id of ids) {
      expect(id).toMatch(/^SIM-[0-9A-F]{12}$/);
      // Requirement 6: the id must not encode User.id, and must not expose user identity.
      expect(id).not.toContain(USER_A.slice(0, 8));
      expect(id).not.toContain(USER_B.slice(0, 8));
    }
  });

  test("an id that turns out to be taken is regenerated, not surfaced as a failure", async () => {
    // The store answers the first insert with the `robotId` unique violation a real
    // collision produces. The service must treat that as its own problem — the caller
    // asked for a robot, not for a particular name — and must not mistake it for the
    // ownership conflict, which is the other P2002 this path can see.
    const create = prisma.robot.create;
    prisma.robot.create = jest.fn(async (args) => {
      prisma.robot.create = create;
      throw uniqueViolation("robotId");
    });

    const created = await simulatedRobotService.createSimulatedRobot(prisma, CREATE_BODY, {
      ownerId: USER_A,
    });

    expect(created.robotId).toMatch(/^SIM-[0-9A-F]{12}$/);
    expect(created.simulated).toBe(true);
    expect(created.simulationOwnerId).toBe(USER_A);
    expect(prisma.__robots).toHaveLength(1);
  });

  test("id allocation gives up rather than looping forever", async () => {
    prisma.robot.create = jest.fn(async () => {
      throw uniqueViolation("robotId");
    });

    await expect(
      simulatedRobotService.createSimulatedRobot(prisma, CREATE_BODY, { ownerId: USER_A }),
    ).rejects.toMatchObject({ status: 503, code: "ROBOT_ID_ALLOCATION_FAILED" });
  });

  test("ids do not depend on the owner — two operators' ids share no structure", async () => {
    const app = makeApp({ virtualSimulator: runningSimulator() });
    const a = await createAs(app, USER_A);
    const b = await createAs(app, USER_B);

    expect(a.body.robot.robotId.slice(4)).not.toBe(b.body.robot.robotId.slice(4));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The two P2002s on this table mean opposite things
// ═══════════════════════════════════════════════════════════════════════════

describe("Step 2 — a unique violation is classified by meta.target, never by the message", () => {
  // Retained from Step 2, narrowed to the one constraint that is still reachable. The
  // original defect is worth keeping a guard for even though the second constraint is
  // gone: the service classified a P2002 by searching the error *message*, and a P2002
  // message embeds a code frame from the failing call site in `robot.service.js`, whose
  // lines mention `robotId`. A message-substring implementation therefore answers "yes,
  // identifier collision" to every unique violation raised from that call site, whatever
  // actually collided — which would silently retry a constraint that retrying cannot
  // satisfy, three times, and then report 503.

  test("an identifier violation is recognised, by target and not by luck", () => {
    const error = uniqueViolation("robotId");
    expect(simulatedRobotService.isRobotIdConflictError(error)).toBe(true);
  });

  test("a violation on some OTHER column is not read as an identifier collision", () => {
    // The trap, preserved: the message contains `robotId` because the code frame does.
    const error = uniqueViolation("someOtherColumn");
    expect(error.message).toContain("robotId");
    expect(simulatedRobotService.isRobotIdConflictError(error)).toBe(false);
  });

  test("the service's own pre-check 409 is recognised as an identifier collision", () => {
    expect(simulatedRobotService.isRobotIdConflictError({ status: 409, code: "ROBOT_ID_TAKEN" })).toBe(true);
  });

  test("unrelated errors are classified as neither", () => {
    for (const error of [
      null,
      undefined,
      new Error("connection reset"),
      { code: "P2003" },
      { code: "P2002", meta: { target: ["currentTaskId"] } },
    ]) {
      expect(simulatedRobotService.isRobotIdConflictError(error)).toBe(false);
    }
  });

  test("an unrelated unique violation is surfaced, not retried away", async () => {
    // The end-to-end consequence of the classification being structural: a constraint the
    // service knows nothing about reaches the caller as itself, rather than being burned
    // through three identifier attempts and reported as an allocation failure.
    prisma.robot.create = jest.fn(async () => {
      throw uniqueViolation("someOtherColumn");
    });

    await expect(
      simulatedRobotService.createSimulatedRobot(prisma, CREATE_BODY, { ownerId: USER_A }),
    ).rejects.toMatchObject({ code: "P2002" });

    // One attempt, not three.
    expect(prisma.robot.create).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST L (Step 2 half) — there is no fleet creation API
// ═══════════════════════════════════════════════════════════════════════════

describe("Step 2 — no fleet creation API exists", () => {
  const ROUTES = path.join(__dirname, "..", "..", "..", "src", "routes", "simulator.routes.js");

  test("the simulator router declares no fleet or count-based creation route", () => {
    const source = fs.readFileSync(ROUTES, "utf8");
    const declared = [...source.matchAll(/router\.(get|post|patch|put|delete)\(\s*"([^"]+)"/g)].map(
      (m) => `${m[1].toUpperCase()} ${m[2]}`,
    );

    expect(declared).toEqual([
      "POST /robot",
      "GET /status",
      "POST /start",
      "POST /stop",
      "POST /reset",
      "PATCH /config",
    ]);
    expect(declared.some((route) => /fleet|bulk|batch/i.test(route))).toBe(false);
  });

  test("no route on this router is a count, fleet, bulk or batch form", () => {
    // The corrected rule permits many simulated robots, which makes this the assertion
    // that matters most: many robots must come from many requests, and never from one
    // request that was told a number. A `POST /robot` with `count` is refused below; this
    // check is that no *route* exists to ask for several either.
    const source = fs.readFileSync(ROUTES, "utf8");
    const code = source
      .split(/\r?\n/)
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join("\n");
    expect(code).not.toMatch(/fleet|bulk|batch|\bcount\b/i);
  });

  test("a request carrying a count is refused rather than partially honoured", async () => {
    const response = await createAs(makeApp({ virtualSimulator: runningSimulator() }), USER_A, {
      ...CREATE_BODY,
      count: 10,
    });

    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/no fleet creation API/i);
    expect(prisma.__robots).toHaveLength(0);
  });

  test("a request carrying `simulated` is refused — the endpoint is what makes it simulated", async () => {
    const response = await createAs(makeApp({ virtualSimulator: runningSimulator() }), USER_A, {
      ...CREATE_BODY,
      simulated: true,
    });

    expect(response.status).toBe(400);
    expect(prisma.__robots).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The two creation surfaces stay distinct, and share one implementation
// ═══════════════════════════════════════════════════════════════════════════

describe("Step 2 — one implementation, two semantically distinct entry points", () => {
  const SRC = path.join(__dirname, "..", "..", "..", "src");

  test("the simulated path writes no Robot row of its own", () => {
    // The requirement is "do not create a second implementation of Robot creation". The
    // check is that the only module which calls `robot.create` is the shared core.
    const source = fs.readFileSync(path.join(SRC, "services", "simulatedRobot.service.js"), "utf8");
    expect(source).not.toMatch(/\.robot\.create\s*\(/);
    expect(source).not.toMatch(/\.agent\.upsert\s*\(/);
    expect(source).not.toMatch(/\.agentClass\.upsert\s*\(/);
    // It calls the shared core instead.
    expect(source).toMatch(/createRobotWithProjection/);
  });

  test("robot.create is called from exactly one place in src/", () => {
    const hits = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".js")) {
          const source = fs.readFileSync(full, "utf8");
          if (/\b(tx|prisma|client)\.robot\.create\s*\(/.test(source)) {
            hits.push(path.relative(SRC, full).replace(/\\/g, "/"));
          }
        }
      }
    };
    walk(SRC);
    expect(hits).toEqual(["services/robot.service.js"]);
  });

  test("neither `simulated` nor `simulationOwnerId` is an editable robot field", () => {
    const controller = fs.readFileSync(path.join(SRC, "controllers", "robots.controller.js"), "utf8");
    const editable = controller.match(/const EDITABLE = new Set\(\[([\s\S]*?)\]\)/);
    expect(editable).not.toBeNull();
    expect(editable[1]).not.toMatch(/simulated/);
    expect(editable[1]).not.toMatch(/simulationOwnerId/);
  });
});
