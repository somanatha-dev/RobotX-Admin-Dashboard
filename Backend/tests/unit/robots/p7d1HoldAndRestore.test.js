"use strict";

/**
 * P7-D1 — charging is not an operator hold; an operator hold is not cleared by self-report.
 *
 * Before: a robot's CHARGING report was persisted as `Robot.status = PAUSED` (the enum has no
 * CHARGING), PAUSED is an F3 operator hold, and the robot's IDLE after charging is refused by
 * §23.5 — so every robot that docked once was held forever. Nothing could lift PAUSED:
 * `clear-fault` admitted only ERROR/FAULT, and RESUME only produces a self-report.
 *
 * After (server side, this file):
 *   · CHARGING is not written to `Robot.status`. Charging occupancy is the Charging
 *     Scheduler's reservation (index exclusion + F18), and a robot that SAYS it is charging is
 *     restricted by F18 for as long as it says so — a self-report may restrict (§23.5).
 *   · An operator STOP/PAUSE places the hold SERVER-side, at the command, so it does not depend
 *     on what the robot reports afterwards (the Pi reports STOP as IDLE).
 *   · A held (PAUSED) or faulted (ERROR) robot is never cleared by its own IDLE/ACTIVE.
 *   · PAUSED is lifted only through `clear-fault`, behind the unchanged QUARANTINE_OVERRIDE
 *     gate (elevated role, recorded reason, distinct second approver, both audit records), and
 *     only on live evidence that the unit is connected and itself reports it is running.
 *     Anything unknown refuses.
 *
 * MOCKED BOUNDARIES: Prisma (jest doubles), the KV (the real in-memory test KV where used),
 * the Socket.IO room. The precedence rule, F18, the agent-facts provider, the controller and the
 * override gate are real.
 */

const request = require("supertest");
const jwt = require("jsonwebtoken");

const robotStatusPrecedence = require("../../../src/services/robotStatusPrecedence");
const f18 = require("../../../src/engine/feasibility/predicates/f18");
const override = require("../../../src/engine/security/override");
const { setRobotSocket, deleteRobotSocket } = require("../../../src/sockets/robotSockets");
const { createTestKv } = require("../../helpers/testKv");

const mockPrismaClient = {
  user: { findUnique: jest.fn() },
  robot: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  command: { create: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  // A RESUME names the robot's live commitment (`liveCommitmentIdFor`); none is held here.
  agent: { findUnique: jest.fn() },
  commitment: { findFirst: jest.fn() },
  event: { create: jest.fn() },
  auditEvent: { findFirst: jest.fn(), create: jest.fn() },
  overrideAudit: { create: jest.fn() },
  configVersion: { findFirst: jest.fn(), findMany: jest.fn() },
  configActiveVersion: { findUnique: jest.fn() },
  $transaction: jest.fn(async (callback) => callback(mockPrismaClient)),
};

jest.mock("../../../src/db/prisma", () => ({
  getPrisma: () => mockPrismaClient,
  connectPrisma: jest.fn(),
  connectPrismaWithRetry: jest.fn(),
  disconnectPrisma: jest.fn(),
}));

const app = require("../../../src/app");
const { createAgentFactsProvider } = require("../../../src/services/agentFacts.service");
const { sendRobotCommand } = require("../../../src/controllers/robots.controller");

const USER = { id: "11111111-1111-4111-8111-111111111111", email: "ops@robotx.test", role: "SUPER_ADMIN" };
const VIEWER = { ...USER, role: "VIEWER" };
// The second approver is an existing account, resolved by id (the gate refuses a made-up identity).
const APPROVER = { id: "22222222-2222-4222-8222-222222222222", role: "SUPER_ADMIN" };
const token = () => jwt.sign({ id: USER.id }, process.env.JWT_SECRET);

const kvHandles = [];
afterEach(async () => {
  while (kvHandles.length > 0) await kvHandles.pop().close();
});
async function freshKv() {
  const handle = await createTestKv();
  kvHandles.push(handle);
  return handle.kv;
}

/* ═══════════════════════════════════════════════════════════════════════════
   1. CHARGING is not stored as PAUSED, and is never shown as fitter than a hold
   ═══════════════════════════════════════════════════════════════════════════ */

describe("P7-D1 — CHARGING is an occupancy, not a stored status", () => {
  test("CHARGING has no persisted form (the enum has none, and PAUSED would be an operator hold)", () => {
    expect(robotStatusPrecedence.toPersistedStatus("CHARGING")).toBeNull();
    expect(robotStatusPrecedence.toPersistedStatus("RETURNING")).toBe("ACTIVE");
    expect(robotStatusPrecedence.toPersistedStatus("PAUSED")).toBe("PAUSED");
  });

  test.each([
    ["IDLE", "CHARGING", "CHARGING"], // the report: fresher, same tier
    ["ACTIVE", "CHARGING", "CHARGING"],
    ["PAUSED", "CHARGING", "PAUSED"], // an operator hold is never displayed away by a charge
    ["ERROR", "CHARGING", "ERROR"],
    ["PAUSED", "IDLE", "PAUSED"], // a stale or self-reported IDLE never displays a hold away
    ["ERROR", "ACTIVE", "ERROR"],
  ])("persisted %s + reported %s displays %s", (persisted, reported, shown) => {
    expect(robotStatusPrecedence.displayedStatus(persisted, reported)).toBe(shown);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   2. A charging robot is not assignable: its reservation, and its own report
   ═══════════════════════════════════════════════════════════════════════════ */

describe("P7-D1 — a robot that is charging is denied by F18, whatever its stored status", () => {
  const D = 1_800_000_000_000;
  const plan = { projectedStartMs: D + 1_000, projectedEndMs: D + 600_000 };
  const robot = (extra) => ({
    robotId: "R-D1", simulated: false, status: "IDLE", isOnline: true, socketId: "sock-d1",
    lastSeenAt: new Date(D - 5_000), createdAt: new Date(D - 86_400_000), ...extra,
  });
  const store = (reservations = []) => ({
    agentCellPosition: { findUnique: jest.fn(async () => null) },
    shard: { findUnique: jest.fn(async () => null) },
    observation: { findFirst: jest.fn(async () => null) },
    chargerReservation: { findMany: jest.fn(async () => reservations) },
    zone: { findMany: jest.fn(async () => []) },
  });
  const factsFor = async (kv, reservations, robotExtra) =>
    createAgentFactsProvider({ prisma: store(reservations), kv })({
      agent: { id: "agent-row-d1", robot: robot(robotExtra) },
      config: () => 10,
      asOfMs: D,
    });

  test("a live charger reservation denies (unchanged)", async () => {
    const kv = await freshKv();
    const facts = await factsFor(kv, [{ reservationId: "V1DEMO-DEPOT-01:agent-row-d1:0", reservedFrom: new Date(D - 60_000), reservedUntil: new Date(D + 3_600_000) }]);
    expect(f18.evaluate({ agentSnapshot: facts, plan }).outcome).toBe("VIOLATED");
  });

  test("a robot that reports CHARGING — with no reservation, stored IDLE — is denied by its own report", async () => {
    const kv = await freshKv();
    await kv.set("registry:R-D1", JSON.stringify({ status: "CHARGING", updatedAt: D - 2_000 }));
    const facts = await factsFor(kv, []);
    expect(facts.reservations).toEqual([
      expect.objectContaining({ subsystem: "CHARGING", reservationId: "SELF_REPORTED_CHARGING", until: null }),
    ]);
    expect(f18.evaluate({ agentSnapshot: facts, plan }).outcome).toBe("VIOLATED");
  });

  test("a CHARGING report with no readable report time still denies (the window opens at the epoch)", async () => {
    const kv = await freshKv();
    await kv.set("registry:R-D1", JSON.stringify({ status: "CHARGING" }));
    const facts = await factsFor(kv, []);
    expect(facts.reservations[0].from.getTime()).toBe(0);
    expect(f18.evaluate({ agentSnapshot: facts, plan }).outcome).toBe("VIOLATED");
  });

  test("once the robot stops reporting CHARGING (and holds no reservation) the restriction is gone — nothing sticks", async () => {
    const kv = await freshKv();
    await kv.set("registry:R-D1", JSON.stringify({ status: "IDLE", updatedAt: D - 2_000 }));
    const facts = await factsFor(kv, []);
    expect(facts.reservations).toEqual([]);
    expect(f18.evaluate({ agentSnapshot: facts, plan }).outcome).toBe("SATISFIED");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   3. An operator STOP/PAUSE places the hold server-side
   ═══════════════════════════════════════════════════════════════════════════ */

describe("P7-D1 — STOP and PAUSE hold the robot at the server, whatever it reports next", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrismaClient.robot.findUnique.mockResolvedValue({ id: "db-robot-1" });
    mockPrismaClient.robot.updateMany.mockResolvedValue({ count: 1 });
    mockPrismaClient.command.create.mockResolvedValue({ id: "cmd-1" });
  });

  function call(type) {
    const { createFakeIo } = require("../../helpers/fakeSocket");
    const res = { body: null, statusCode: 200 };
    res.status = jest.fn((c) => { res.statusCode = c; return res; });
    const done = new Promise((resolve, reject) => {
      res.json = jest.fn((b) => { res.body = b; resolve(); return res; });
      sendRobotCommand({ params: { robotId: "R1" }, body: { type }, user: USER, app: { locals: { io: createFakeIo() } } }, res, reject);
    });
    return done.then(() => res);
  }

  test.each(["STOP", "PAUSE"])("%s: a running robot is held PAUSED; an OFFLINE one comes back PAUSED", async (type) => {
    const res = await call(type);
    expect(res.body).toMatchObject({ operatorHold: { placed: true } });
    const writes = mockPrismaClient.robot.updateMany.mock.calls.map(([args]) => args);
    expect(writes).toContainEqual({ where: { robotId: "R1", status: { in: ["IDLE", "ACTIVE", "ISSUES"] } }, data: { status: "PAUSED" } });
    expect(writes).toContainEqual({
      where: { robotId: "R1", status: "OFFLINE", OR: [{ statusBeforeOffline: null }, { statusBeforeOffline: { in: ["IDLE", "ACTIVE", "ISSUES"] } }] },
      data: { statusBeforeOffline: "PAUSED" },
    });
    // ERROR and an existing PAUSED are never touched: both are already at least as restrictive.
    for (const write of writes) expect(JSON.stringify(write.where)).not.toMatch(/"ERROR"/);
  });

  test.each(["RESUME", "RETURN"])("%s places no hold and lifts none", async (type) => {
    await call(type);
    expect(mockPrismaClient.robot.updateMany).not.toHaveBeenCalled();
  });

  test("a hold that cannot be written does not stop the STOP: the command is still sent, and the failure is reported", async () => {
    mockPrismaClient.robot.updateMany.mockRejectedValue(new Error("database unavailable"));
    const res = await call("STOP");
    expect(mockPrismaClient.command.create).toHaveBeenCalled();
    expect(res.body).toMatchObject({ ok: true, operatorHold: { placed: false } });
    expect(res.body.operatorHold.problem).toMatch(/database unavailable/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   4. Restoring a held robot: the override gate, and live evidence
   ═══════════════════════════════════════════════════════════════════════════ */

describe("P7-D1 — a PAUSED robot is restored only through the QUARANTINE_OVERRIDE gate, on live evidence", () => {
  let kv;
  const socket = { id: "sock-agt-1" };
  beforeEach(async () => {
    jest.clearAllMocks();
    kv = await freshKv();
    mockPrismaClient.user.findUnique.mockImplementation(async ({ where }) => [USER, APPROVER].find((row) => row.id === where.id) || null);
    mockPrismaClient.auditEvent.findFirst.mockResolvedValue(null);
    mockPrismaClient.auditEvent.create.mockImplementation(async ({ data }) => ({ ...data }));
    mockPrismaClient.overrideAudit.create.mockResolvedValue({});
    mockPrismaClient.robot.findUnique.mockResolvedValue({ id: "robot-db-1", status: "PAUSED", currentTaskId: null });
    mockPrismaClient.robot.updateMany.mockResolvedValue({ count: 1 });
    mockPrismaClient.robot.update.mockResolvedValue({});
    mockPrismaClient.event.create.mockResolvedValue({});
    app.locals.prisma = mockPrismaClient;
    app.locals.kv = kv;
  });
  afterEach(() => {
    deleteRobotSocket("AGT-1", socket);
    delete app.locals.kv;
  });

  const live = (state) => kv.set("registry:AGT-1", JSON.stringify({ updatedAt: Date.now(), ...state }));
  const restore = () =>
    request(app)
      .post("/api/robots/AGT-1/clear-fault")
      .set("Authorization", `Bearer ${token()}`)
      .set("X-Override-Reason", "unit inspected after the STOP; operator resumed it")
      .set("X-Second-Approver", APPROVER.id);

  test.each([
    ["no recorded reason", (r) => r.unset("X-Override-Reason"), 400, override.REFUSAL.NO_REASON],
    ["no second approver", (r) => r.unset("X-Second-Approver"), 400, override.REFUSAL.SECOND_APPROVER_REQUIRED],
    ["a second approver naming no account", (r) => r.set("X-Second-Approver", "33333333-3333-4333-8333-333333333333"), 400, override.REFUSAL.SECOND_APPROVER_UNKNOWN],
    ["a made-up second approver", (r) => r.set("X-Second-Approver", "ops-2"), 400, override.REFUSAL.SECOND_APPROVER_UNKNOWN],
  ])("the gate is unchanged: %s is refused and nothing is written", async (_label, alter, status, refusal) => {
    setRobotSocket("AGT-1", socket);
    await live({ status: "IDLE" });
    const response = await alter(restore()).send({}).expect(status);
    expect(response.body.refusal).toBe(refusal);
    expect(mockPrismaClient.robot.updateMany).not.toHaveBeenCalled();
  });

  test("the gate is unchanged: an unelevated role is refused", async () => {
    mockPrismaClient.user.findUnique.mockResolvedValue(VIEWER);
    setRobotSocket("AGT-1", socket);
    await live({ status: "IDLE" });
    const response = await restore().send({}).expect(403);
    expect(response.body.refusal).toBe(override.REFUSAL.ROLE_NOT_ELEVATED);
    expect(mockPrismaClient.robot.updateMany).not.toHaveBeenCalled();
  });

  test.each([
    ["no live state at all", async () => {}, "LIVE_STATE_UNKNOWN"],
    ["live state but no connected socket", async () => { await live({ status: "IDLE" }); }, "UNIT_NOT_CONNECTED"],
    ["the unit still reports PAUSED", async () => { setRobotSocket("AGT-1", socket); await live({ status: "PAUSED" }); }, "UNIT_STILL_STOPPED"],
    ["the unit reports CHARGING", async () => { setRobotSocket("AGT-1", socket); await live({ status: "CHARGING" }); }, "UNIT_STILL_STOPPED"],
    ["the unit reports ERROR", async () => { setRobotSocket("AGT-1", socket); await live({ status: "ERROR" }); }, "UNIT_STILL_STOPPED"],
  ])("fails closed with a passed gate when there is %s", async (_label, arrange, refusal) => {
    await arrange();
    const response = await restore().send({}).expect(409);
    expect(response.body.refusal).toBe(refusal);
    expect(mockPrismaClient.robot.updateMany).not.toHaveBeenCalled();
  });

  test("with the gate passed and the unit connected and reporting IDLE, the hold is lifted — conditionally, and recorded", async () => {
    setRobotSocket("AGT-1", socket);
    await live({ status: "IDLE" });

    await restore().send({}).expect(200);

    expect(mockPrismaClient.robot.updateMany).toHaveBeenCalledWith({ where: { robotId: "AGT-1", status: "PAUSED" }, data: { status: "IDLE" } });
    const audited = mockPrismaClient.auditEvent.create.mock.calls[0][0].data;
    expect(audited).toMatchObject({ eventType: "QUARANTINE", actorId: USER.id });
    expect(mockPrismaClient.overrideAudit.create.mock.calls[0][0].data).toMatchObject({ granted: true, actionClass: "QUARANTINE_OVERRIDE" });
    expect(mockPrismaClient.event.create.mock.calls[0][0].data.message).toMatch(/hold cleared .*PAUSED -> IDLE/i);
  });

  test("a robot still carrying a task is restored to ACTIVE, not IDLE", async () => {
    mockPrismaClient.robot.findUnique.mockResolvedValue({ id: "robot-db-1", status: "PAUSED", currentTaskId: "task-1" });
    setRobotSocket("AGT-1", socket);
    await live({ status: "ACTIVE" });
    await restore().send({}).expect(200);
    expect(mockPrismaClient.robot.updateMany).toHaveBeenCalledWith({ where: { robotId: "AGT-1", status: "PAUSED" }, data: { status: "ACTIVE" } });
  });

  test("if the hold changed under the request, nothing is claimed", async () => {
    mockPrismaClient.robot.updateMany.mockResolvedValue({ count: 0 });
    setRobotSocket("AGT-1", socket);
    await live({ status: "IDLE" });
    const response = await restore().send({}).expect(409);
    expect(response.body.refusal).toBe("HOLD_CHANGED");
    expect(mockPrismaClient.event.create).not.toHaveBeenCalled();
  });

  test("a robot that is neither held nor faulted is still refused (409), as before", async () => {
    mockPrismaClient.robot.findUnique.mockResolvedValue({ id: "robot-db-1", status: "IDLE", currentTaskId: null });
    await restore().send({}).expect(409);
    expect(mockPrismaClient.robot.updateMany).not.toHaveBeenCalled();
    expect(mockPrismaClient.robot.update).not.toHaveBeenCalled();
  });

  test("a predicate waiver is still refused by name, before anything else", async () => {
    setRobotSocket("AGT-1", socket);
    await live({ status: "IDLE" });
    const response = await restore().send({ waivePredicate: "F3" }).expect(403);
    expect(response.body.refusal).toBe(override.REFUSAL.CLASS_NOT_WAIVABLE);
    expect(mockPrismaClient.robot.updateMany).not.toHaveBeenCalled();
  });
});
