/**
 * Phase 6 — a robot the server holds PAUSED or ERROR is not shown IDLE because its live
 * report still says IDLE.
 *
 * Phase 5 measured it on the LOCAL stack: two simulated robots PAUSED in `Robot.status` (and
 * holding ASSIGNED tasks) were returned by `GET /api/robots/state` as IDLE, because the KV live
 * state — the robot's raw self-report — was overlaid on the row as written. The map page did
 * the same with every `robot:update`.
 *
 * The rule is §23.5's asymmetric health rule, read from the same tier map the write side
 * enforces it with: a report may restrict or refresh the persisted status, never raise it.
 * Three levels: the pure rule, both REST endpoints through the real router, and the
 * `robot:update` broadcast through the real telemetry handler.
 */

jest.mock("../../../src/db/prisma");

const express = require("express");
const cookieParser = require("cookie-parser");
const request = require("supertest");
const jwt = require("jsonwebtoken");

const { displayedStatus, toPersistedStatus } = require("../../../src/services/robotStatusPrecedence");

// ═══════════════════════════════════════════════════════════════════════════
// The rule
// ═══════════════════════════════════════════════════════════════════════════

describe("displayedStatus — §23.5: a live report may restrict or refresh, never raise", () => {
  test.each([
    // persisted, reported, shown, why
    ["PAUSED", "IDLE", "PAUSED", "stale IDLE over an operator PAUSE — would raise the tier"],
    ["ERROR", "IDLE", "ERROR", "stale IDLE over a fault — would raise the tier"],
    ["ERROR", "ACTIVE", "ERROR", "a faulted robot reporting itself working"],
    ["OFFLINE", "IDLE", "OFFLINE", "a cached IDLE over a disconnect"],
    ["ISSUES", "ACTIVE", "ISSUES", "reduced-work robot reporting itself unrestricted"],
    ["PAUSED", "RETURNING", "PAUSED", "RETURNING is stored as ACTIVE — still a raise"],
    ["ERROR", "CHARGING", "ERROR", "a charge never displays a fault away (P7-D1)"],
    ["IDLE", "IDLE", "IDLE", "legitimately idle"],
    ["IDLE", "ACTIVE", "ACTIVE", "fresh report at the same tier — the intended override"],
    ["ACTIVE", "IDLE", "IDLE", "fresh report at the same tier — the intended override"],
    ["IDLE", "ERROR", "ERROR", "a robot may always declare itself unfit"],
    ["IDLE", "PAUSED", "PAUSED", "a robot may always declare itself unfit"],
    ["IDLE", "CHARGING", "CHARGING", "CHARGING is shown over IDLE: same tier, fresher (P7-D1: it is no longer stored)"],
    ["PAUSED", "CHARGING", "PAUSED", "P7-D1: a charge never displays an operator hold away"],
    ["IDLE", "RETURNING", "RETURNING", "RETURNING is ACTIVE's tier"],
  ])("persisted %s + reported %s → %s (%s)", (persisted, reported, shown) => {
    expect(displayedStatus(persisted, reported)).toBe(shown);
  });

  test.each([[undefined], [null], [""], ["   "], [42]])("no usable report (%j) → the persisted status", (reported) => {
    expect(displayedStatus("PAUSED", reported)).toBe("PAUSED");
    expect(displayedStatus("IDLE", reported)).toBe("IDLE");
  });

  test("a report outside the tier map is never trusted over the row", () => {
    expect(displayedStatus("PAUSED", "WIBBLE")).toBe("PAUSED");
  });

  test("toPersistedStatus is the write side's own mapping (P7-D1: CHARGING is not stored at all)", () => {
    expect(toPersistedStatus("CHARGING")).toBeNull();
    expect(toPersistedStatus("RETURNING")).toBe("ACTIVE");
    expect(toPersistedStatus("IDLE")).toBe("IDLE");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/robots and GET /api/robots/state, through the real router
// ═══════════════════════════════════════════════════════════════════════════

const USER = "11111111-1111-4111-8111-111111111111";

function row(robotId, status) {
  return {
    id: `row-${robotId}`,
    robotId,
    name: robotId,
    status,
    battery: 50,
    lat: 12.9,
    lon: 77.5,
    speed: 0,
    isOnline: true,
    simulated: true,
    simulationOwnerId: null,
    agent: null,
  };
}

describe("the REST robot projections apply the rule", () => {
  const { getPrisma } = require("../../../src/db/prisma");
  const robotsRoutes = require("../../../src/routes/robots.routes");
  const errorHandler = require("../../../src/middlewares/errorHandler");

  // robotId → [persisted, live report or undefined for no live state]
  const FLEET = {
    "SIM-PAUSED-STALE": ["PAUSED", "IDLE"],
    "SIM-ERROR-STALE": ["ERROR", "IDLE"],
    "SIM-IDLE": ["IDLE", "IDLE"],
    "SIM-FRESH-ACTIVE": ["IDLE", "ACTIVE"],
    "SIM-NO-LIVE": ["PAUSED", undefined],
  };

  beforeEach(() => {
    getPrisma.mockReturnValue({
      user: { findUnique: jest.fn(async () => ({ id: USER, email: "a@robotx.test", role: "SUPER_ADMIN" })) },
      robot: { findMany: jest.fn(async () => Object.entries(FLEET).map(([id, [status]]) => row(id, status))) },
    });
  });

  function app() {
    const a = express();
    a.use(express.json());
    a.use(cookieParser());
    a.locals.kv = {
      mget: async (keys) =>
        keys.map((key) => {
          const [, live] = FLEET[key.replace(/^robot:/, "")] || [];
          return live === undefined ? null : JSON.stringify({ lat: 1, lon: 2, speed: 0, battery: 40, status: live });
        }),
    };
    a.use("/api/robots", robotsRoutes);
    a.use(errorHandler);
    return a;
  }

  test.each([["/api/robots/state"], ["/api/robots"]])("%s shows PAUSED/ERROR over a stale IDLE, and fresh same-tier reports as reported", async (path) => {
    const response = await request(app())
      .get(path)
      .set("Authorization", `Bearer ${jwt.sign({ id: USER }, process.env.JWT_SECRET, { expiresIn: "1h" })}`);
    expect(response.status).toBe(200);
    const status = Object.fromEntries(response.body.robots.map((r) => [r.robotId, r.status]));
    expect(status).toEqual({
      "SIM-PAUSED-STALE": "PAUSED",
      "SIM-ERROR-STALE": "ERROR",
      "SIM-IDLE": "IDLE",
      "SIM-FRESH-ACTIVE": "ACTIVE",
      "SIM-NO-LIVE": "PAUSED",
    });
    // The rest of the live overlay still applies (battery came from the live state).
    const stale = response.body.robots.find((r) => r.robotId === "SIM-PAUSED-STALE");
    expect(stale.battery).toBe(40);
  });

  test("the raw report stays visible as live.status on the state endpoint", async () => {
    const response = await request(app())
      .get("/api/robots/state")
      .set("Authorization", `Bearer ${jwt.sign({ id: USER }, process.env.JWT_SECRET, { expiresIn: "1h" })}`);
    const stale = response.body.robots.find((r) => r.robotId === "SIM-PAUSED-STALE");
    expect(stale.live.status).toBe("IDLE");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// robot:update, through the real telemetry handler with the engine on
// ═══════════════════════════════════════════════════════════════════════════

describe("robot:update applies the rule against the server's status after the frame", () => {
  const { createTestKv } = require("../../helpers/testKv");
  const { createFakeSocket, createFakeIo } = require("../../helpers/fakeSocket");
  const { createMockPrisma } = require("../../helpers/mockPrisma");
  const { waitFor } = require("../../helpers/waitFor");
  const silentLogger = require("../../mocks/silentLogger");

  const ROBOT = "R-PRECEDENCE";

  async function frame({ persisted, reported }) {
    jest.resetModules();
    const agentGate = require("../../../src/engine/cutover/agentGate");
    // The engine on: §23.5 is enforced, so an expanding self-report is refused at the write.
    jest.spyOn(agentGate, "mayAct").mockReturnValue(true);
    const { registerTelemetryHandlers } = require("../../../src/sockets/handlers/telemetry.handler");
    const robotStateCache = require("../../../src/cache/robotStateCache");

    const prisma = createMockPrisma();
    const dbRow = { id: "db-robot", robotId: ROBOT, status: persisted, lat: 12.9, lon: 77.5, speed: 0, battery: 60, isOnline: true };
    prisma.robot.findUnique.mockImplementation(async () => ({ ...dbRow }));
    prisma.robot.update.mockImplementation(async ({ data }) => Object.assign(dbRow, data));
    prisma.robot.updateMany.mockImplementation(async ({ where, data }) => {
      if (where.status !== undefined && where.status !== dbRow.status) return { count: 0 };
      Object.assign(dbRow, data);
      return { count: 1 };
    });
    prisma.zone.findMany.mockResolvedValue([]);
    robotStateCache.set(ROBOT, { id: dbRow.id, status: persisted, isOnline: true, lat: 12.9, lon: 77.5, battery: 60, speed: 0 });

    const { kv } = await createTestKv();
    const io = createFakeIo();
    const socket = createFakeSocket({ id: "sock" });
    socket.data.isAuthed = true;
    socket.data.robotId = ROBOT;
    registerTelemetryHandlers(io, socket, { prisma, kv, logger: silentLogger });

    socket.trigger("TELEMETRY", { lat: 12.9001, lon: 77.5001, battery: 60, speed: 0, status: reported });
    await waitFor(() => io.emittedTo("dashboard", "robot:update").length > 0);
    const [payload] = io.emittedTo("dashboard", "robot:update");
    return { payload, dbRow };
  }

  test("persisted PAUSED, reported IDLE: broadcast PAUSED (raw IDLE in reportedStatus); the row stays PAUSED", async () => {
    const { payload, dbRow } = await frame({ persisted: "PAUSED", reported: "IDLE" });
    expect(payload.status).toBe("PAUSED");
    expect(payload.reportedStatus).toBe("IDLE");
    expect(dbRow.status).toBe("PAUSED");
  });

  test("persisted ERROR, reported IDLE: broadcast ERROR", async () => {
    const { payload, dbRow } = await frame({ persisted: "ERROR", reported: "IDLE" });
    expect(payload.status).toBe("ERROR");
    expect(dbRow.status).toBe("ERROR");
  });

  test("persisted IDLE, reported ACTIVE: broadcast ACTIVE (a fresh, same-tier report)", async () => {
    const { payload } = await frame({ persisted: "IDLE", reported: "ACTIVE" });
    expect(payload.status).toBe("ACTIVE");
    expect(payload.reportedStatus).toBe("ACTIVE");
  });

  test("persisted IDLE, reported IDLE: broadcast IDLE", async () => {
    const { payload } = await frame({ persisted: "IDLE", reported: "IDLE" });
    expect(payload.status).toBe("IDLE");
  });

  test("persisted PAUSED, reported CHARGING: broadcast PAUSED (P7-D1: a charge never displays an operator hold away)", async () => {
    const { payload } = await frame({ persisted: "PAUSED", reported: "CHARGING" });
    expect(payload.status).toBe("PAUSED");
  });
});
