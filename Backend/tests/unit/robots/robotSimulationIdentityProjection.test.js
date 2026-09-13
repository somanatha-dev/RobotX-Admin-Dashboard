/**
 * STEP 3 — what a robot payload says, and what it must never say.
 *
 * Two claims, and they are opposites of each other:
 *
 *   > **A.** Every Robot the API returns says whether it is simulated. `simulated` is
 *   > present and boolean on the list endpoint, the dashboard state endpoint, the
 *   > commissioning response and the edit response — so the UI can label a unit PHYSICAL
 *   > or SIMULATED without guessing.
 *
 *   > **B.** No Robot the API returns says who owns it. `simulationOwnerId` is a
 *   > `User.id`; it is an authorisation fact the server decides with, and it does not
 *   > belong in a robot projection.
 *
 * ── Why B needed a test rather than a code review ───────────────────────────
 * Because the leak nobody wrote was real. Every read path uses Prisma `include`, which
 * returns **every scalar on the row** — so `GET /api/robots/state` was handing the
 * operator's user id to every authenticated caller for every simulated unit, without a
 * single line of code asking for it. `simulator.controller.js` stripped it by hand on its
 * own 201 and that strip was correct; it was simply the only one. An absence that is
 * produced by nobody having added a field is an absence that the next `include` removes,
 * so it is asserted here against the real router.
 */

jest.mock("../../../src/db/prisma");

const express = require("express");
const cookieParser = require("cookie-parser");
const request = require("supertest");
const jwt = require("jsonwebtoken");

const { getPrisma } = require("../../../src/db/prisma");
const robotsRoutes = require("../../../src/routes/robots.routes");
const errorHandler = require("../../../src/middlewares/errorHandler");
const robotProjection = require("../../../src/services/robotProjection");

const USER_A = "11111111-1111-4111-8111-111111111111";

/**
 * Two rows as PostgreSQL would hand them back — that is, with **every scalar present**,
 * which is exactly why the owner id has to be removed rather than merely not selected.
 */
const PHYSICAL_ROW = Object.freeze({
  id: "robot-row-1",
  robotId: "RBT-1000",
  name: "Warehouse Rover A",
  status: "IDLE",
  battery: 82,
  lat: 12.9,
  lon: 77.5,
  speed: 0,
  isOnline: false,
  massKg: 45,
  batteryReservePct: 15,
  simulated: false,
  simulationOwnerId: null,
  agent: {
    agentClass: {
      classId: "AC-RBT-1000",
      chassisType: "ROVER",
      mobilityModel: { kinematicLimits: { maxSpeedMps: 2.5 }, speedModel: { nominalSpeedMps: 1.4 } },
      energyModel: { packNominalWh: 500 },
      containerModel: { totalMassLimitKg: 20 },
    },
  },
});

const SIMULATED_ROW = Object.freeze({
  ...PHYSICAL_ROW,
  id: "robot-row-2",
  robotId: "SIM-A81F92CC0011",
  name: "Sim Rover",
  simulated: true,
  // The fact under test: a real simulated row carries its owner, and the projection is
  // what stops it travelling.
  simulationOwnerId: USER_A,
});

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.locals.kv = null; // exercises the no-overlay branch; the overlay branch is below
  app.use("/api/robots", robotsRoutes);
  app.use(errorHandler);
  return app;
}

/** An app whose Redis overlay answers, so the *merged* branch is exercised too. */
function makeAppWithKv() {
  const app = makeApp();
  app.locals.kv = {
    mget: async (keys) =>
      keys.map(() => JSON.stringify({ lat: 1, lon: 2, speed: 3, battery: 50, status: "ACTIVE" })),
  };
  return app;
}

function get(app, path) {
  return request(app)
    .get(path)
    .set("Authorization", `Bearer ${jwt.sign({ id: USER_A }, process.env.JWT_SECRET, { expiresIn: "1h" })}`);
}

let prisma;
beforeEach(() => {
  prisma = {
    user: {
      findUnique: jest.fn(async ({ where }) =>
        where?.id === USER_A ? { id: USER_A, email: "a@robotx.test", role: "SUPER_ADMIN" } : null,
      ),
    },
    robot: {
      findMany: jest.fn(async () => [PHYSICAL_ROW, SIMULATED_ROW]),
    },
  };
  getPrisma.mockReturnValue(prisma);
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST A — the robot list exposes simulation identity
// ═══════════════════════════════════════════════════════════════════════════

describe("Test A — every robot the API returns says whether it is simulated", () => {
  test.each([
    ["GET /api/robots", "/api/robots"],
    ["GET /api/robots/state", "/api/robots/state"],
  ])("%s reports simulated=false for a physical unit and true for a simulated one", async (_label, path) => {
    const response = await get(makeApp(), path);

    expect(response.status).toBe(200);
    const byId = Object.fromEntries(response.body.robots.map((r) => [r.robotId, r]));

    expect(byId["RBT-1000"].simulated).toBe(false);
    expect(byId["SIM-A81F92CC0011"].simulated).toBe(true);
  });

  test.each([
    ["GET /api/robots", "/api/robots"],
    ["GET /api/robots/state", "/api/robots/state"],
  ])("%s answers with a boolean, never a missing key — the UI must not have to guess", async (_label, path) => {
    const response = await get(makeApp(), path);

    for (const robot of response.body.robots) {
      expect(typeof robot.simulated).toBe("boolean");
    }
  });

  test("the Redis live overlay does not drop the discriminator", async () => {
    // The overlay branch rebuilds the object. A merge that spread the live state over a
    // projection — or projected before merging — is exactly how `simulated` would go
    // missing on the one endpoint the dashboard actually loads from.
    const response = await get(makeAppWithKv(), "/api/robots/state");

    expect(response.status).toBe(200);
    const byId = Object.fromEntries(response.body.robots.map((r) => [r.robotId, r]));
    expect(byId["SIM-A81F92CC0011"].simulated).toBe(true);
    expect(byId["RBT-1000"].simulated).toBe(false);
    // …and the overlay still applied, so this is not passing because the branch was skipped.
    expect(byId["RBT-1000"].battery).toBe(50);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST B — ownership is not exposed to general robot consumers
// ═══════════════════════════════════════════════════════════════════════════

describe("Test B — no general robot response carries the owner's User.id", () => {
  test.each([
    ["GET /api/robots", "/api/robots"],
    ["GET /api/robots/state", "/api/robots/state"],
  ])("%s omits simulationOwnerId entirely", async (_label, path) => {
    const response = await get(makeApp(), path);

    for (const robot of response.body.robots) {
      expect(robot.simulationOwnerId).toBeUndefined();
      expect("simulationOwnerId" in robot).toBe(false);
    }
  });

  test.each([
    ["GET /api/robots", "/api/robots"],
    ["GET /api/robots/state", "/api/robots/state"],
  ])("%s does not contain the owner's id anywhere in the payload", async (_label, path) => {
    // Broader than the field check on purpose: the field could be renamed, nested under a
    // relation, or echoed inside the `live` overlay. What must not happen is the user id
    // reaching the client, under any key.
    const response = await get(makeApp(), path);
    expect(JSON.stringify(response.body)).not.toContain(USER_A);
  });

  test("the owner is still on the row the endpoint read — so the absence is the projection's doing", async () => {
    // Without this, both assertions above would pass just as happily against a fixture
    // that never had an owner, and the test would be proving nothing.
    await get(makeApp(), "/api/robots/state");
    const returned = await prisma.robot.findMany.mock.results[0].value;
    expect(returned.find((r) => r.robotId === "SIM-A81F92CC0011").simulationOwnerId).toBe(USER_A);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The projection itself — the guard, and what it refuses to invent
// ═══════════════════════════════════════════════════════════════════════════

describe("robotProjection — the one public shape of a Robot row", () => {
  test("strips the owner and normalises the discriminator", () => {
    const projected = robotProjection.toPublicRobot(SIMULATED_ROW);

    expect(projected.simulationOwnerId).toBeUndefined();
    expect(projected.simulated).toBe(true);
    expect(projected.robotId).toBe("SIM-A81F92CC0011");
    // The specification still travels — this replaced `withSpecification`, it did not
    // drop what that did.
    expect(projected.specification.chassisType).toBe("ROVER");
    expect(projected.specification.payloadCapacityKg).toBe(20);
  });

  test("does not mutate the row it was given", () => {
    const row = { ...SIMULATED_ROW };
    robotProjection.toPublicRobot(row);
    expect(row.simulationOwnerId).toBe(USER_A);
  });

  test("refuses a row whose `simulated` column was not read, rather than answering false", () => {
    // The fabrication this guard exists to prevent. `Robot.simulated` is non-nullable, so
    // an absent value means a `select` omitted it — and defaulting to `false` there would
    // render a simulated unit as physical hardware with no error anywhere. Same discipline
    // as the `isOnline: true` that commissioning used to invent.
    const { simulated, ...withoutColumn } = SIMULATED_ROW;
    expect(simulated).toBe(true); // the fixture really did have it

    expect(() => robotProjection.toPublicRobot(withoutColumn)).toThrow(/no `simulated` column/);
  });

  test("a truthy non-true value is not simulated — the flag is read strictly", () => {
    expect(robotProjection.toPublicRobot({ ...PHYSICAL_ROW, simulated: "true" }).simulated).toBe(false);
    expect(robotProjection.toPublicRobot({ ...PHYSICAL_ROW, simulated: 1 }).simulated).toBe(false);
  });

  test("stripInternalFields removes the owner without inventing a specification", () => {
    // The pairing endpoint's projection. It reads its row without the specification
    // include, so attaching `specificationOf`'s all-null answer would report a configured
    // unit as unconfigured — a different fabrication, avoided by not joining at all.
    const stripped = robotProjection.stripInternalFields(SIMULATED_ROW);

    expect(stripped.simulationOwnerId).toBeUndefined();
    expect(stripped.specification).toBeUndefined();
    expect(stripped.simulated).toBe(true);
  });

  test("the internal-field list is the single statement of what may not travel", () => {
    expect(robotProjection.INTERNAL_ONLY_FIELDS).toEqual(["simulationOwnerId"]);
  });
});
