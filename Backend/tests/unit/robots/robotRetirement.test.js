"use strict";

/**
 * Robot soft retirement — `DELETE /api/robots/:robotId` and every reader that must honour it.
 *
 * Retirement used to hard-delete the Robot row, which failed with a RESTRICT violation
 * (SQLSTATE 23001, an unhandled 500)
 * for every robot the engine had offered work. It now moves the robot's Agent to
 * `DECOMMISSIONED` and keeps every row. These tests drive the production modules against an
 * in-memory store (`helpers/retirementStore`); `tools/verify/robotRetirementLiveDatabase.js`
 * drives the same service against a real disposable PostgreSQL.
 *
 *   A  the transition: lifecycle, epoch, fence audit, derived state, Event, history kept
 *   B  every 409, and that a refusal changes nothing
 *   C  unknown robot, missing Agent row, repeated and concurrent retirement
 *   D  the post-commit cleanup and the HTTP contract
 *   E  operator endpoints refuse a retired robot (ROBOT_RETIRED)
 *   F  socket AUTH refuses a retired robot at every credential, and a racing AUTH
 *   G  the simulator neither creates nor re-hydrates a retired unit
 *   H  dashboard lists omit retired robots and keep robots with no Agent row
 *   I  enrollment: a retired id stays taken; structural guards
 */

jest.mock("../../../src/db/prisma");

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const request = require("supertest");

const { createRetirementStore } = require("../../helpers/retirementStore");
const { createTestKv } = require("../../helpers/testKv");
const { createFakeSocket, createFakeIo } = require("../../helpers/fakeSocket");
const { waitFor } = require("../../helpers/waitFor");
const outbox = require("../../../src/engine/dispatch/outbox");

const SRC = path.join(__dirname, "..", "..", "..", "src");
const sha256 = (s) => crypto.createHash("sha256").update(String(s), "utf8").digest("hex");
const FUTURE = () => new Date(Date.now() + 86_400_000).toISOString();
const silentLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

/**
 * Two robots. R-A has a full engine history — a released commitment, an acknowledged OFFER,
 * a completed task, a released charge, an index row and a durable session — which is
 * exactly the history that made the hard delete fail. R-B is a fresh unit with none.
 */
function fleet(overrides) {
  const o = overrides || {};
  return createRetirementStore({
    robots: [
      { id: "row-A", robotId: "R-A", socketId: "sock-A", isOnline: true, currentTaskId: null },
      { id: "row-B", robotId: "R-B" },
      ...(o.robots || []),
    ],
    agents: [
      { id: "agent-A", agentId: "R-A", robotDbId: "row-A", authorityEpoch: 4, fenceCounter: 9 },
      { id: "agent-B", agentId: "R-B", robotDbId: "row-B" },
      ...(o.agents || []),
    ],
    commitments: [{ commitmentId: "C-old", agentId: "agent-A", releasedAt: "2026-10-01T00:00:00.000Z" }, ...(o.commitments || [])],
    outbox: [{ id: "ob-acked", agentId: "agent-A", command: "OFFER", state: "ACKED" }, ...(o.outbox || [])],
    tasks: [{ id: "task-done", taskId: "TSK-DONE", robotId: "row-A", status: "COMPLETED" }, ...(o.tasks || [])],
    reservations: [{ reservationId: "res-old", agentId: "agent-A", state: "RELEASED" }, ...(o.reservations || [])],
    cells: [
      {
        agentId: "agent-A",
        shardId: "default",
        fineCellId: "fine-1",
        coarseCellId: "coarse-1",
        availabilityClass: "IDLE_READY",
        capabilityClasses: ["cap-1"],
        containerClasses: [],
      },
      ...(o.cells || []),
    ],
    sessions: [{ robotDbId: "row-A", tokenHash: sha256("tok-A"), expiresAt: FUTURE() }, ...(o.sessions || [])],
  });
}

const snapshotOf = (state) => JSON.parse(JSON.stringify(state, (k, v) => (typeof v === "bigint" ? `${v}n` : v)));

function loadService() {
  return require("../../../src/services/robotRetirement.service");
}

// ═══════════════════════════════════════════════════════════════════════════
// A — the transition
// ═══════════════════════════════════════════════════════════════════════════

describe("A — retirement is a lifecycle transition, never a delete", () => {
  test("a robot with engine history retires: DECOMMISSIONED, epoch +1, fence audit, derived state removed, Event", async () => {
    const svc = loadService();
    const world = fleet();

    const result = await svc.retireRobot(world.prisma, "R-A", { actorId: "op-7", reason: "end of trial" });

    expect(result).toMatchObject({ outcome: "RETIRED", robotId: "R-A", agentRowId: "agent-A", epochBefore: 4n, epochAfter: 5n });
    const agent = world.state.agents.find((a) => a.id === "agent-A");
    expect(agent.lifecycleState).toBe("DECOMMISSIONED");
    expect(agent.authorityEpoch).toBe(5n);
    expect(agent.fenceCounter).toBe(9n);
    expect(world.state.fenceAudits).toEqual([
      expect.objectContaining({ agentId: "agent-A", epochHighWater: 5n, fenceHighWater: 9n, lastFenceSource: "decommission" }),
    ]);
    // Derived state a retired robot must not keep.
    expect(world.state.cells.filter((c) => c.agentId === "agent-A")).toEqual([]);
    expect(world.state.sessions.filter((s) => s.robotDbId === "row-A")).toEqual([]);
    expect(world.state.robots.find((r) => r.id === "row-A")).toMatchObject({ isOnline: false, socketId: null });
    // The Event names the transition, the actor and the reason.
    expect(world.state.events).toHaveLength(1);
    expect(world.state.events[0]).toMatchObject({ robotId: "row-A", type: "INFO" });
    expect(world.state.events[0].message).toMatch(/R-A retired \(lifecycle ACTIVE -> DECOMMISSIONED, authority epoch 4 -> 5\) by op-7: end of trial/);
  });

  test("history is preserved: no Robot or Agent row deleted; commitments, outbox, tasks, reservations untouched", async () => {
    const svc = loadService();
    const world = fleet();
    const before = snapshotOf(world.state);

    await svc.retireRobot(world.prisma, "R-A", {});

    expect(world.prisma.robot.delete).not.toHaveBeenCalled();
    expect(world.prisma.agent.delete).not.toHaveBeenCalled();
    expect(world.state.robots.map((r) => r.id)).toEqual(before.robots.map((r) => r.id));
    expect(world.state.agents.map((a) => a.id)).toEqual(before.agents.map((a) => a.id));
    expect(snapshotOf(world.state).commitments).toEqual(before.commitments);
    expect(snapshotOf(world.state).outbox).toEqual(before.outbox);
    expect(snapshotOf(world.state).tasks).toEqual(before.tasks);
    expect(snapshotOf(world.state).reservations).toEqual(before.reservations);
    // The other robot is untouched.
    expect(world.state.agents.find((a) => a.id === "agent-B").lifecycleState).toBe("ACTIVE");
  });

  test("a reason is optional and bounded; an actor is recorded when known", async () => {
    const svc = loadService();
    const world = fleet();
    await svc.retireRobot(world.prisma, "R-B", { actorId: null, reason: "x".repeat(2000) });
    const message = world.state.events[0].message;
    expect(message).not.toMatch(/ by /);
    expect(message.length).toBeLessThan(700);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B — the 409s, and that a refusal changes nothing
// ═══════════════════════════════════════════════════════════════════════════

describe("B — retirement is refused (409) while work is in flight, and the refusal writes nothing", () => {
  const cases = [
    ["a live commitment", { commitments: [{ commitmentId: "C-live", agentId: "agent-A", releasedAt: null }] }, "LIVE_COMMITMENT", ["C-live"]],
    ...outbox.OUTSTANDING_STATES.map((state) => [
      `an outbox command in ${state}`,
      { outbox: [{ id: `ob-${state}`, agentId: "agent-A", command: "WITHDRAW", state }] },
      "OUTSTANDING_COMMANDS",
      [`ob-${state}`],
    ]),
    ["a non-terminal task assigned to the robot", { tasks: [{ id: "task-run", taskId: "TSK-RUN", robotId: "row-A", status: "IN_EXECUTION" }] }, "ACTIVE_TASK", ["TSK-RUN"]],
    ["a queued charging reservation", { reservations: [{ reservationId: "res-q", agentId: "agent-A", state: "QUEUED" }] }, "CHARGING_RESERVATION", ["res-q"]],
    ["an active charging reservation", { reservations: [{ reservationId: "res-a", agentId: "agent-A", state: "ACTIVE" }] }, "CHARGING_RESERVATION", ["res-a"]],
  ];

  test.each(cases)("%s → 409 %s", async (label, overrides, code, ids) => {
    const svc = loadService();
    const world = fleet(overrides);
    const before = snapshotOf(world.state);

    const error = await svc.retireRobot(world.prisma, "R-A", { actorId: "op-7" }).catch((e) => e);

    expect(error).toBeInstanceOf(svc.RetirementRefused);
    expect(error.status).toBe(409);
    expect(error.code).toBe(code);
    expect(error.ids).toEqual(ids);
    expect(error.toBody()).toMatchObject({ ok: false, error: "Conflict", code, refusal: code });
    expect(error.toBody().message).toMatch(/R-A/);
    expect(snapshotOf(world.state)).toEqual(before);
  });

  test("the robot's currentTaskId counts when it points at an unfinished task, even one assigned elsewhere", async () => {
    const svc = loadService();
    const world = fleet({ tasks: [{ id: "task-cur", taskId: "TSK-CUR", robotId: null, status: "ASSIGNED" }] });
    world.state.robots.find((r) => r.id === "row-A").currentTaskId = "task-cur";
    const error = await svc.retireRobot(world.prisma, "R-A", {}).catch((e) => e);
    expect(error.code).toBe("ACTIVE_TASK");
    expect(error.ids).toEqual(["TSK-CUR"]);
  });

  test("terminal tasks, settled commands and released charges do not block", async () => {
    const svc = loadService();
    const world = fleet({
      tasks: ["COMPLETED", "FAILED", "CANCELLED", "REJECTED"].map((status, i) => ({ id: `t-${i}`, taskId: `TSK-${i}`, robotId: "row-A", status })),
      outbox: ["ACKED", "EXPIRED", "SUPPRESSED", "FAILED"].map((state) => ({ id: `ob-${state}`, agentId: "agent-A", command: "OFFER", state })),
    });
    const stale = world.state.robots.find((r) => r.id === "row-A");
    stale.currentTaskId = "t-0"; // a stale pointer to a finished task is not an active task
    await expect(svc.retireRobot(world.prisma, "R-A", {})).resolves.toMatchObject({ outcome: "RETIRED" });
  });

  test("the refused reservation states are exactly the charging scheduler's live states", () => {
    // Stated in the service (the scheduler may not be imported outside its driver, T11),
    // so pinned here: a state the scheduler adds must be added to the refusal too.
    const scheduler = require("../../../src/simulation/devChargingScheduler");
    expect([...loadService().LIVE_RESERVATION_STATES].sort()).toEqual([...scheduler.LIVE_STATES].sort());
  });

  test("work belonging to another robot never blocks this one", async () => {
    const svc = loadService();
    const world = fleet({ commitments: [{ commitmentId: "C-B", agentId: "agent-B", releasedAt: null }] });
    await expect(svc.retireRobot(world.prisma, "R-A", {})).resolves.toMatchObject({ outcome: "RETIRED" });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C — unknown, missing Agent, repeated, concurrent
// ═══════════════════════════════════════════════════════════════════════════

describe("C — identities and repetition", () => {
  test("an unknown robot id is a 404, and nothing is written", async () => {
    const svc = loadService();
    const world = fleet();
    const before = snapshotOf(world.state);
    const error = await svc.retireRobot(world.prisma, "R-NOPE", {}).catch((e) => e);
    expect(error).toBeInstanceOf(svc.RetirementRefused);
    expect(error.status).toBe(404);
    expect(error.toBody()).toMatchObject({ code: "ROBOT_NOT_FOUND", message: "Unknown robotId" });
    expect(snapshotOf(world.state)).toEqual(before);
  });

  test("an empty robot id is a 400", async () => {
    const svc = loadService();
    await expect(svc.retireRobot(fleet().prisma, "  ", {})).rejects.toMatchObject({ status: 400 });
  });

  test("a robot with no Agent row gets one (the commissioning upsert) and is retired through it", async () => {
    const svc = loadService();
    const world = fleet({ robots: [{ id: "row-OLD", robotId: "R-OLD" }] });
    const result = await svc.retireRobot(world.prisma, "R-OLD", {});
    expect(result).toMatchObject({ outcome: "RETIRED", agentCreated: true, epochBefore: 0n, epochAfter: 1n });
    const agent = world.state.agents.find((a) => a.robotDbId === "row-OLD");
    expect(agent).toMatchObject({ agentId: "R-OLD", lifecycleState: "DECOMMISSIONED" });
    expect(world.prisma.agent.upsert).toHaveBeenCalledTimes(1);
  });

  test("a refused retirement of a robot with no Agent row leaves no Agent row behind", async () => {
    const svc = loadService();
    const world = fleet({
      robots: [{ id: "row-OLD", robotId: "R-OLD" }],
      tasks: [{ id: "task-old", taskId: "TSK-OLD", robotId: "row-OLD", status: "PENDING" }],
    });
    const error = await svc.retireRobot(world.prisma, "R-OLD", {}).catch((e) => e);
    expect(error.code).toBe("ACTIVE_TASK");
    expect(world.state.agents.find((a) => a.robotDbId === "row-OLD")).toBeUndefined();
  });

  test("repeating a retirement succeeds as ALREADY_RETIRED without a second epoch advance or Event", async () => {
    const svc = loadService();
    const world = fleet();
    await svc.retireRobot(world.prisma, "R-A", {});
    // What a racing index sweep or AUTH could leave behind after the first retirement.
    world.state.cells.push({ agentId: "agent-A", shardId: "default", fineCellId: "f", coarseCellId: "c", availabilityClass: "IDLE_READY", capabilityClasses: [], containerClasses: [] });
    world.state.sessions.push({ robotDbId: "row-A", tokenHash: "late", expiresAt: FUTURE() });

    const again = await svc.retireRobot(world.prisma, "R-A", {});

    expect(again).toMatchObject({ outcome: "ALREADY_RETIRED", epochBefore: 5n, epochAfter: 5n });
    expect(world.state.agents.find((a) => a.id === "agent-A").authorityEpoch).toBe(5n);
    expect(world.state.events).toHaveLength(1);
    expect(world.state.fenceAudits).toHaveLength(1);
    expect(world.state.cells.filter((c) => c.agentId === "agent-A")).toEqual([]);
    expect(world.state.sessions.filter((s) => s.robotDbId === "row-A")).toEqual([]);
    expect(again.cell).toMatchObject({ fineCellId: "f" });
  });

  test("a retired robot with work still recorded against it is ALREADY_RETIRED, not refused", async () => {
    // The 409 conditions guard the transition; once retired, a repeat is reported, not judged.
    const svc = loadService();
    const world = fleet();
    await svc.retireRobot(world.prisma, "R-A", {});
    world.state.tasks.push({ id: "t-late", taskId: "TSK-LATE", robotId: "row-A", status: "PENDING" });
    await expect(svc.retireRobot(world.prisma, "R-A", {})).resolves.toMatchObject({ outcome: "ALREADY_RETIRED" });
  });

  test("two concurrent retirements: one RETIRED, one ALREADY_RETIRED, the epoch advanced exactly once", async () => {
    const svc = loadService();
    const world = fleet();
    const outcomes = await Promise.all([svc.retireRobot(world.prisma, "R-A", {}), svc.retireRobot(world.prisma, "R-A", {})]);
    expect(outcomes.map((o) => o.outcome).sort()).toEqual(["ALREADY_RETIRED", "RETIRED"]);
    expect(world.state.agents.find((a) => a.id === "agent-A").authorityEpoch).toBe(5n);
    expect(world.state.events).toHaveLength(1);
  });

  test("the second retirement waits on the Agent lock the first holds", async () => {
    const svc = loadService();
    const world = fleet();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let firstLocked;
    const locked = new Promise((resolve) => {
      firstLocked = resolve;
    });
    const first = svc.retireRobot(world.prisma, "R-A", { hooks: { afterLock: async () => { firstLocked(); await gate; } } });
    await locked;
    let secondDone = false;
    const second = svc.retireRobot(world.prisma, "R-A", {}).then((r) => {
      secondDone = true;
      return r;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(secondDone).toBe(false);
    release();
    expect((await first).outcome).toBe("RETIRED");
    expect((await second).outcome).toBe("ALREADY_RETIRED");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D — post-commit cleanup and the HTTP contract
// ═══════════════════════════════════════════════════════════════════════════

describe("D — runtime cleanup after the commit, and DELETE's responses", () => {
  test("cleanup removes the Redis index entry, KV keys, the simulator and the socket, and tells every dashboard", async () => {
    jest.resetModules();
    jest.doMock("../../../src/db/prisma");
    const svc = loadService();
    const robotSockets = require("../../../src/sockets/robotSockets");
    const availabilityIndex = require("../../../src/engine/candidates/availabilityIndex");
    const { kv, close } = await createTestKv();
    try {
      const world = fleet();
      const cell = world.state.cells[0];
      await availabilityIndex.applyPosition({ kv }, null, svc.indexRecordOf(cell));
      const indexKeys = availabilityIndex.keysFor(svc.indexRecordOf(cell));
      expect(indexKeys.length).toBeGreaterThan(0);
      for (const key of indexKeys) expect(await kv.smembers(key)).toContain("agent-A");
      for (const key of ["robot", "registry", "session", "pairing", "pairingAttempts", "pairingLocked"]) {
        await kv.set(`${key}:R-A`, "x", { ex: 300 });
      }
      await kv.set("session:R-B", "keep", { ex: 300 });
      const live = createFakeSocket({ id: "sock-A" });
      robotSockets.setRobotSocket("R-A", live);
      const io = createFakeIo();
      const virtualSimulator = { removeRobot: jest.fn() };

      const result = await svc.retireRobot(world.prisma, "R-A", {});
      const cleanup = await svc.releaseRuntimeState(result, { kv, io, virtualSimulator, logger: silentLogger });

      expect(cleanup.failed).toEqual([]);
      for (const key of indexKeys) expect(await kv.smembers(key)).not.toContain("agent-A");
      for (const key of ["robot", "registry", "session", "pairing", "pairingAttempts", "pairingLocked"]) {
        expect(await kv.get(`${key}:R-A`)).toBeNull();
      }
      expect(await kv.get("session:R-B")).toBe("keep");
      expect(virtualSimulator.removeRobot).toHaveBeenCalledWith("R-A");
      expect(live.disconnect).toHaveBeenCalledWith(true);
      expect(io.emittedTo("dashboard", "robot_offline")).toEqual([{ robotId: "R-A" }]);
      expect(io.emittedTo("dashboard", "robot_retired")).toEqual([expect.objectContaining({ robotId: "R-A" })]);
      robotSockets.deleteRobotSocket("R-A");
    } finally {
      await close();
    }
  });

  test("a failing cleanup step is reported and logged, and the other steps still run", async () => {
    const svc = loadService();
    const world = fleet();
    const logger = { warn: jest.fn(), info: jest.fn(), error: jest.fn() };
    const kv = { del: jest.fn(async () => undefined), srem: jest.fn(async () => 0), sadd: jest.fn(async () => 0) };
    const virtualSimulator = {
      removeRobot: jest.fn(() => {
        throw new Error("simulator gone");
      }),
    };
    const result = await svc.retireRobot(world.prisma, "R-A", {});
    const cleanup = await svc.releaseRuntimeState(result, { kv, virtualSimulator, logger });
    expect(cleanup.failed).toEqual([{ step: "simulator", message: "simulator gone" }]);
    expect(kv.del).toHaveBeenCalledWith("session:R-A");
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/runtime cleanup failed/), expect.objectContaining({ robotId: "R-A" }));
  });

  async function callDelete(world, robotId, locals, body) {
    jest.resetModules();
    jest.doMock("../../../src/db/prisma");
    require("../../../src/db/prisma").getPrisma.mockReturnValue(world.prisma);
    const controller = require("../../../src/controllers/robots.controller");
    const res = { statusCode: 200, body: null };
    res.status = jest.fn((code) => {
      res.statusCode = code;
      return res;
    });
    res.json = jest.fn((payload) => {
      res.body = payload;
      return res;
    });
    const next = jest.fn();
    await controller.deleteRobot({ params: { robotId }, body: body || {}, user: { id: "op-7" }, app: { locals: locals || {} } }, res, next);
    await waitFor(() => res.json.mock.calls.length > 0 || next.mock.calls.length > 0);
    return { res, error: next.mock.calls[0]?.[0] ?? null };
  }

  test("200: retired, then alreadyRetired on repeat; the actor and an optional reason are recorded", async () => {
    const world = fleet();
    const first = await callDelete(world, "R-A", {}, { reason: "worn out" });
    expect(first.res.statusCode).toBe(200);
    expect(first.res.body).toEqual({ ok: true, robotId: "R-A", retired: true, alreadyRetired: false });
    expect(world.state.events[0].message).toMatch(/by op-7: worn out/);
    const second = await callDelete(world, "R-A", {});
    expect(second.res.body).toEqual({ ok: true, robotId: "R-A", retired: true, alreadyRetired: true });
  });

  test("409 carries the code and the sentence the dashboard shows; 404 for an unknown id", async () => {
    const world = fleet({ commitments: [{ commitmentId: "C-live", agentId: "agent-A", releasedAt: null }] });
    const conflict = await callDelete(world, "R-A");
    expect(conflict.res.statusCode).toBe(409);
    expect(conflict.res.body).toMatchObject({ ok: false, code: "LIVE_COMMITMENT", ids: ["C-live"] });
    expect(conflict.res.body.message).toMatch(/live commitment/);

    const missing = await callDelete(world, "R-NOPE");
    expect(missing.res.statusCode).toBe(404);
    expect(missing.res.body).toMatchObject({ code: "ROBOT_NOT_FOUND" });
  });

  test("a cleanup failure is named in the 200, never turned into an error", async () => {
    const world = fleet();
    const virtualSimulator = { removeRobot: jest.fn(() => { throw new Error("boom"); }) };
    const { res } = await callDelete(world, "R-A", { virtualSimulator });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, retired: true, cleanupIncomplete: ["simulator"] });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// E — operator endpoints refuse a retired robot
// ═══════════════════════════════════════════════════════════════════════════

describe("E — a retired robot is refused by every per-robot operator endpoint (409 ROBOT_RETIRED)", () => {
  let app;
  let world;
  let overrideReached;

  beforeEach(() => {
    jest.resetModules();
    jest.doMock("../../../src/db/prisma");
    overrideReached = jest.fn();
    jest.doMock("../../../src/middlewares/auth_middleware", () => ({
      authUser: (req, res, next) => {
        req.user = { id: "op-7", role: "SUPER_ADMIN" };
        next();
      },
      requireActionClass: () => (req, res, next) => {
        overrideReached(req.path);
        next();
      },
      policyFor: () => ({}),
      recordAuthorisation: jest.fn(async () => {}),
      configValue: () => undefined,
    }));
    world = fleet();
    world.state.agents.find((a) => a.id === "agent-A").lifecycleState = "DECOMMISSIONED";
    require("../../../src/db/prisma").getPrisma.mockReturnValue(world.prisma);
    app = express();
    app.use(express.json());
    app.use("/api/robots", require("../../../src/routes/robots.routes"));
  });

  afterEach(() => {
    jest.dontMock("../../../src/middlewares/auth_middleware");
  });

  const endpoints = [
    ["POST", "/api/robots/commission", { robotId: "R-A" }],
    ["POST", "/api/robots/R-A/pairing/unlock", { reason: "x" }],
    ["POST", "/api/robots/R-A/command", { type: "STOP" }],
    ["POST", "/api/robots/R-A/soc-declaration", { socPct: 80 }],
    ["POST", "/api/robots/R-A/clear-fault", { reason: "x" }],
    ["PATCH", "/api/robots/R-A", { name: "renamed" }],
  ];

  test.each(endpoints)("%s %s → 409, before any handler or override gate", async (method, url, body) => {
    const res = await request(app)[method.toLowerCase()](url).send(body);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ ok: false, code: "ROBOT_RETIRED", refusal: "ROBOT_RETIRED" });
    expect(res.body.message).toMatch(/R-A is retired/);
    expect(overrideReached).not.toHaveBeenCalled();
    expect(world.prisma.command.create).not.toHaveBeenCalled();
    expect(world.prisma.robot.update).not.toHaveBeenCalled();
  });

  test("an active robot passes the refusal and reaches its handler", async () => {
    const res = await request(app).post("/api/robots/R-B/command").send({ type: "STOP" });
    expect(res.status).not.toBe(409);
    expect(world.prisma.command.create).toHaveBeenCalled();
  });

  test("an unknown robot passes through to the handler's own answer", async () => {
    const res = await request(app).post("/api/robots/R-NOPE/command").send({ type: "STOP" });
    expect(res.status).toBe(404);
  });

  test("DELETE is not refused for a retired robot — a repeat is a success", async () => {
    const res = await request(app).delete("/api/robots/R-A");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, alreadyRetired: true });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F — socket AUTH
// ═══════════════════════════════════════════════════════════════════════════

describe("F — AUTH refuses a retired robot at every credential, and a racing AUTH cannot mark it online", () => {
  async function authProcess(world) {
    jest.resetModules();
    jest.doMock("../../../src/db/prisma");
    const { registerRobotHandlers } = require("../../../src/sockets/handlers/robot.handler");
    const robotSockets = require("../../../src/sockets/robotSockets");
    const { kv } = await createTestKv();
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    const io = createFakeIo();

    function start(payload) {
      const socket = createFakeSocket();
      registerRobotHandlers(io, socket, { prisma: world.prisma, kv, logger, appLocals: {} });
      socket.trigger("AUTH", payload);
      return socket;
    }
    async function settle(socket) {
      await waitFor(() => socket.sent.some((s) => s.event === "AUTH_SUCCESS") || socket.disconnect.mock.calls.length > 0);
      for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
      return { ok: socket.sent.some((s) => s.event === "AUTH_SUCCESS"), socket };
    }
    const auth = async (payload) => settle(start(payload));
    const refusedAsRetired = () => logger.warn.mock.calls.some(([m]) => /AUTH refused — the robot is retired/.test(m));
    return { kv, logger, io, auth, start, settle, robotSockets, refusedAsRetired };
  }

  function retiredAndActive() {
    const world = fleet({
      robots: [{ id: "row-C", robotId: "R-C" }],
      agents: [{ id: "agent-C", agentId: "R-C", robotDbId: "row-C" }],
    });
    // As a retirement leaves it: DECOMMISSIONED, offline, its durable session revoked.
    world.state.agents.find((a) => a.id === "agent-A").lifecycleState = "DECOMMISSIONED";
    world.state.robots.find((r) => r.id === "row-A").isOnline = false;
    world.state.sessions = world.state.sessions.filter((s) => s.robotDbId !== "row-A");
    return world;
  }

  const AUTH_FAILED = { event: "AUTH_FAILED", payload: { reason: "INVALID_CREDENTIAL" } };

  test("pairing code: the active robot pairs, the retired one is refused and mints nothing", async () => {
    const world = retiredAndActive();
    const p = await authProcess(world);
    await p.kv.set("pairing:R-C", "111111", { ex: 300 });
    await p.kv.set("pairing:R-A", "222222", { ex: 300 });

    expect((await p.auth({ robotId: "R-C", pairingCode: "111111" })).ok).toBe(true);
    const refused = await p.auth({ robotId: "R-A", pairingCode: "222222" });

    expect(refused.ok).toBe(false);
    expect(refused.socket.sent).toContainEqual(AUTH_FAILED);
    expect(p.refusedAsRetired()).toBe(true);
    expect(await p.kv.get("session:R-A")).toBeNull();
    expect(world.state.sessions.filter((s) => s.robotDbId === "row-A")).toEqual([]);
    expect(world.state.robots.find((r) => r.id === "row-A").isOnline).toBe(false);
  });

  test("KV session token: valid for the active robot, refused for the retired one", async () => {
    const world = retiredAndActive();
    const p = await authProcess(world);
    await p.kv.set("session:R-C", "tok-C", { ex: 300 });
    await p.kv.set("session:R-A", "tok-A", { ex: 300 });

    expect((await p.auth({ robotId: "R-C", token: "tok-C" })).ok).toBe(true);
    const refused = await p.auth({ robotId: "R-A", token: "tok-A" });
    expect(refused.ok).toBe(false);
    expect(refused.socket.sent).toContainEqual(AUTH_FAILED);
    expect(p.refusedAsRetired()).toBe(true);
  });

  test("durable session (KV empty): valid for the active robot, refused for the retired one", async () => {
    const world = retiredAndActive();
    world.state.sessions.push({ robotDbId: "row-C", tokenHash: sha256("dur-C"), expiresAt: FUTURE() });
    // A durable row a retired robot should not have, to prove the lifecycle check precedes it.
    world.state.sessions.push({ robotDbId: "row-A", tokenHash: sha256("dur-A"), expiresAt: FUTURE() });
    const p = await authProcess(world);

    expect((await p.auth({ robotId: "R-C", token: "dur-C" })).ok).toBe(true);
    const refused = await p.auth({ robotId: "R-A", token: "dur-A" });
    expect(refused.ok).toBe(false);
    expect(refused.socket.sent).toContainEqual(AUTH_FAILED);
    expect(p.refusedAsRetired()).toBe(true);
  });

  test("certificate: a retired robot is refused before its certificate is examined", async () => {
    const world = retiredAndActive();
    const p = await authProcess(world);
    const refused = await p.auth({ robotId: "R-A", certificate: { pem: "-----BEGIN CERTIFICATE-----" } });
    expect(refused.ok).toBe(false);
    expect(refused.socket.sent).toContainEqual(AUTH_FAILED);
    expect(p.refusedAsRetired()).toBe(true);
    expect(p.logger.warn.mock.calls.some(([m]) => /refused by §23\.2/.test(m))).toBe(false);
  });

  test("markRobotOnline: a retired robot is not marked online; a robot with no Agent row is", async () => {
    const { markRobotOnline } = require("../../../src/sockets/handlers/robot.handler");
    const world = retiredAndActive();
    world.state.robots.push({ id: "row-N", robotId: "R-N", isOnline: false, status: "IDLE" });

    expect(await markRobotOnline(world.prisma, "R-A", "sock-x")).toBeNull();
    expect(world.state.robots.find((r) => r.id === "row-A")).toMatchObject({ isOnline: false });
    expect(await markRobotOnline(world.prisma, "R-N", "sock-n")).toMatchObject({ isOnline: true, socketId: "sock-n" });
    expect(await markRobotOnline(world.prisma, "R-C", "sock-c")).toMatchObject({ isOnline: true, socketId: "sock-c" });
  });

  test("an AUTH that read the robot before retirement committed is refused at its online write and leaves nothing behind", async () => {
    const world = fleet();
    const p = await authProcess(world);
    const svc = loadService();
    await p.kv.set("pairing:R-B", "333333", { ex: 300 });
    world.state.sessions = world.state.sessions.filter((s) => s.robotDbId !== "row-B");

    // Retirement takes the Agent lock and holds it…
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let lockedSignal;
    const locked = new Promise((resolve) => {
      lockedSignal = resolve;
    });
    const retiring = svc.retireRobot(world.prisma, "R-B", { hooks: { afterLock: async () => { lockedSignal(); await gate; } } });
    await locked;

    // …while an AUTH reads the robot (still ACTIVE), pairs, and reaches its online write.
    const socket = p.start({ robotId: "R-B", pairingCode: "333333" });
    await waitFor(() => world.state.sessions.some((s) => s.robotDbId === "row-B"));
    release();
    expect((await retiring).outcome).toBe("RETIRED");
    const outcome = await p.settle(socket);

    expect(outcome.ok).toBe(false);
    expect(socket.sent).toContainEqual(AUTH_FAILED);
    expect(p.logger.warn.mock.calls.some(([m]) => /retired while it was authenticating/.test(m))).toBe(true);
    expect(world.state.robots.find((r) => r.id === "row-B")).toMatchObject({ isOnline: false, socketId: null });
    expect(world.state.sessions.filter((s) => s.robotDbId === "row-B")).toEqual([]);
    expect(await p.kv.get("session:R-B")).toBeNull();
    expect(p.robotSockets.getRobotSocket("R-B")).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// G — the simulator
// ═══════════════════════════════════════════════════════════════════════════

describe("G — a retired simulated unit is neither spawned nor re-hydrated", () => {
  const simulationPolicy = require("../../../src/simulation/simulationPolicy");

  test("the spawn policy refuses a retired simulated row by name", () => {
    expect(simulationPolicy.maySpawnVirtualRobot({ simulated: true, agent: { lifecycleState: "DECOMMISSIONED" } }, { enabled: true })).toEqual({
      allowed: false,
      reason: "ROBOT_RETIRED",
    });
    expect(simulationPolicy.maySpawnVirtualRobot({ simulated: true, agent: { lifecycleState: "ACTIVE" } }, { enabled: true })).toEqual({
      allowed: true,
      reason: null,
    });
    expect(simulationPolicy.maySpawnVirtualRobot({ simulated: true, agent: null }, { enabled: true }).allowed).toBe(true);
  });

  function simFleet() {
    return createRetirementStore({
      robots: [
        { id: "row-S1", robotId: "SIM-LIVE", simulated: true, lat: 12.91, lon: 77.51, battery: 80 },
        { id: "row-S2", robotId: "SIM-RET", simulated: true, lat: 12.92, lon: 77.52, battery: 80 },
      ],
      agents: [
        { id: "agent-S1", agentId: "SIM-LIVE", robotDbId: "row-S1" },
        { id: "agent-S2", agentId: "SIM-RET", robotDbId: "row-S2", lifecycleState: "DECOMMISSIONED" },
      ],
    });
  }

  test("the engine refuses to construct a VirtualRobot for a retired row, and mints it no credential", async () => {
    const { createVirtualRobotSimulator } = require("../../../src/simulation/SimulationEngine");
    const { kv, close } = await createTestKv();
    try {
      const world = simFleet();
      const engine = createVirtualRobotSimulator({ prisma: world.prisma, kv, serverUrl: "http://127.0.0.1:0", logger: silentLogger, enabled: true });
      const result = await engine.addRobot({ robotId: "SIM-RET", simulated: true });
      expect(result).toEqual({ started: false, reason: "ROBOT_RETIRED" });
      expect(engine.getStatus().robotCount).toBe(0);
      expect(await kv.get("session:SIM-RET")).toBeNull();
    } finally {
      await close();
    }
  });

  test("boot re-hydration spawns the active unit and reports the retired one as refused", async () => {
    const { createVirtualRobotSimulator } = require("../../../src/simulation/SimulationEngine");
    const { rehydrateSimulatedRobots } = require("../../../src/simulation/rehydrate");
    const { kv, close } = await createTestKv();
    try {
      const world = simFleet();
      // Not started, so no socket is opened: a constructed unit reports ENGINE_NOT_STARTED.
      const engine = createVirtualRobotSimulator({ prisma: world.prisma, kv, serverUrl: "http://127.0.0.1:0", logger: silentLogger, enabled: true });
      const outcome = await rehydrateSimulatedRobots({ prisma: world.prisma, simulator: engine, logger: silentLogger, enabled: true });

      expect(outcome.considered).toBe(2);
      expect(outcome.refused).toEqual(
        expect.arrayContaining([{ robotId: "SIM-RET", reason: "ROBOT_RETIRED" }, { robotId: "SIM-LIVE", reason: "ENGINE_NOT_STARTED" }]),
      );
      expect(engine.getStatus().robots.map((r) => r.robotId)).toEqual(["SIM-LIVE"]);
      expect(await kv.get("session:SIM-RET")).toBeNull();
    } finally {
      await close();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// H — dashboard lists
// ═══════════════════════════════════════════════════════════════════════════

describe("H — dashboard lists omit retired robots and keep robots with no Agent row", () => {
  const policy = require("../../../src/services/robotRetirementPolicy");

  function listFleet() {
    const world = fleet({ robots: [{ id: "row-N", robotId: "R-N" }] });
    world.state.agents.find((a) => a.id === "agent-A").lifecycleState = "DECOMMISSIONED";
    return world;
  }

  test("GET /api/robots/state", async () => {
    jest.resetModules();
    jest.doMock("../../../src/db/prisma");
    const world = listFleet();
    require("../../../src/db/prisma").getPrisma.mockReturnValue(world.prisma);
    const controller = require("../../../src/controllers/robots.controller");
    const res = { json: jest.fn() };
    await controller.getRobotsState({ app: { locals: {} } }, res, jest.fn());
    await waitFor(() => res.json.mock.calls.length > 0);

    expect(world.prisma.robot.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: policy.notRetiredRobotWhere() }));
    expect(res.json.mock.calls[0][0].robots.map((r) => r.robotId).sort()).toEqual(["R-B", "R-N"]);
  });

  test("GET /api/robots (robotService.listRobots), with and without filters", async () => {
    const robotService = require("../../../src/services/robot.service");
    const world = listFleet();
    const all = await robotService.listRobots(world.prisma, {});
    expect(all.map((r) => r.robotId).sort()).toEqual(["R-B", "R-N"]);
    expect(world.prisma.robot.findMany.mock.calls[0][0].where).toEqual(policy.notRetiredRobotWhere());

    await robotService.listRobots(world.prisma, { isOnline: "false", status: "IDLE" });
    expect(world.prisma.robot.findMany.mock.calls[1][0].where).toEqual({ ...policy.notRetiredRobotWhere(), isOnline: false, status: "IDLE" });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// I — enrollment and structure
// ═══════════════════════════════════════════════════════════════════════════

describe("I — enrollment is unaffected; a retired id stays taken", () => {
  const SPEC = Object.freeze({
    massKg: 45,
    maxSpeedMps: 2.5,
    normalSpeedMps: 1.4,
    batteryCapacityWh: 500,
    batteryReservePct: 15,
    payloadCapacityKg: 20,
    initialBatteryPct: 82,
  });

  test("commissioning a retired robot's id is a 409 ROBOT_ID_TAKEN that says it is retired", async () => {
    const robotService = require("../../../src/services/robot.service");
    const world = fleet();
    world.state.agents.find((a) => a.id === "agent-A").lifecycleState = "DECOMMISSIONED";
    const body = { locationId: "loc-1", chassisType: "ROVER", specification: SPEC };

    const error = await robotService.createRobotWithProjection(world.prisma, body, { robotCode: "R-A", simulated: false }).catch((e) => e);

    expect(error).toMatchObject({ status: 409, code: "ROBOT_ID_TAKEN" });
    expect(error.message).toMatch(/belongs to a retired robot and cannot be reused/);
    expect(world.prisma.robot.create).not.toHaveBeenCalled();
  });

  test("an active robot's id is still ROBOT_ID_TAKEN with the original sentence", async () => {
    const robotService = require("../../../src/services/robot.service");
    const world = fleet();
    const body = { locationId: "loc-1", chassisType: "ROVER", specification: SPEC };
    const error = await robotService.createRobotWithProjection(world.prisma, body, { robotCode: "R-B", simulated: false }).catch((e) => e);
    expect(error).toMatchObject({ status: 409, code: "ROBOT_ID_TAKEN" });
    expect(error.message).toMatch(/is already commissioned/);
  });

  test("a new id passes the duplicate check and proceeds to commissioning (enrollment unaffected)", async () => {
    const robotService = require("../../../src/services/robot.service");
    const world = fleet();
    world.state.agents.find((a) => a.id === "agent-A").lifecycleState = "DECOMMISSIONED";
    world.prisma.location.findUnique.mockResolvedValue(null); // stop right after the duplicate check
    const body = { locationId: "loc-1", chassisType: "ROVER", specification: SPEC };
    const error = await robotService.createRobotWithProjection(world.prisma, body, { robotCode: "R-NEW", simulated: false }).catch((e) => e);
    // Past the duplicate check: the next refusal is the location's, not ROBOT_ID_TAKEN.
    expect(error).toMatchObject({ status: 400, message: "Invalid locationId" });
  });

  test("structural: the controller never deletes a robot, and the refusal precedes every override gate", () => {
    // Code only: the comments explain the delete this replaced, by name.
    const code = (file) =>
      fs
        .readFileSync(file, "utf8")
        .split(/\r?\n/)
        .map((line) => line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, ""))
        .join("\n");
    const controller = code(path.join(SRC, "controllers", "robots.controller.js"));
    expect(controller).not.toMatch(/prisma\.robot\.delete\b/);
    const service = code(path.join(SRC, "services", "robotRetirement.service.js"));
    expect(service).not.toMatch(/\.robot\.delete(Many)?\b/);
    expect(service).not.toMatch(/\.agent\.delete(Many)?\b/);

    const routes = fs.readFileSync(path.join(SRC, "routes", "robots.routes.js"), "utf8");
    for (const line of routes.split(/\r?\n/).filter((l) => /quarantineOverride,/.test(l) && /router\./.test(l))) {
      expect(line.indexOf("notRetired")).toBeGreaterThan(-1);
      expect(line.indexOf("notRetired")).toBeLessThan(line.indexOf("quarantineOverride"));
    }
  });
});
