"use strict";

/**
 * Physical-robot enrollment UX, backend half (H1–H6).
 *
 * The dashboard's Connect page issues a pairing code, waits for the robot, and rebuilds itself
 * after a refresh. These tests pin the backend facts that page relies on, and the security
 * properties it must not weaken:
 *
 *   H1  the `session:` KV key is written with the configured lifetime, not a fixed 24 h
 *   H2  a code is consumed only by the login that used it, never by a token reconnect
 *   H3  GET /api/robots/:robotId/pairing reports where enrollment stands and never the code
 *   H4  a commissioned robot refused in the pairing branch is announced to the dashboard,
 *       carrying only the attempt count and the lock; an unknown robotId announces nothing
 *   H5  issuing a code and enrolling through one are audit Events that never name the code
 *   H6  decommissioning deletes the robot's credentials and closes its live connection
 */

jest.mock("../../../src/db/prisma");

const crypto = require("crypto");
const express = require("express");
const request = require("supertest");
const { getPrisma } = require("../../../src/db/prisma");
const { createTestKv } = require("../../helpers/testKv");
const { createFakeSocket, createFakeIo } = require("../../helpers/fakeSocket");
const { createMockPrisma } = require("../../helpers/mockPrisma");
const { waitFor } = require("../../helpers/waitFor");

const sha256 = (s) => crypto.createHash("sha256").update(String(s), "utf8").digest("hex");
const ROBOTS = { R1: "row-R1", R2: "row-R2" };
const DAY_SEC = 86_400;

/** An in-memory `RobotSession` table with the semantics the service relies on. */
function sessionStore() {
  const rows = new Map();
  const matches = (row, where = {}) =>
    (where.robotDbId === undefined || row.robotDbId === where.robotDbId) &&
    (where.tokenHash === undefined || row.tokenHash === where.tokenHash) &&
    (where.expiresAt?.gt === undefined || row.expiresAt > where.expiresAt.gt);
  return {
    rows,
    findUnique: jest.fn(async ({ where }) => rows.get(where.robotDbId) ?? null),
    upsert: jest.fn(async ({ where, create, update }) => {
      const current = rows.get(where.robotDbId);
      rows.set(where.robotDbId, current ? { ...current, ...update } : { ...create });
    }),
    create: jest.fn(async ({ data }) => {
      if (rows.has(data.robotDbId)) throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
      rows.set(data.robotDbId, { ...data });
    }),
    updateMany: jest.fn(async ({ where, data }) => {
      let count = 0;
      for (const [key, row] of rows) {
        if (matches(row, where)) {
          rows.set(key, { ...row, ...data });
          count += 1;
        }
      }
      return { count };
    }),
    deleteMany: jest.fn(async () => ({ count: 0 })),
  };
}

function createWorld() {
  const store = sessionStore();
  const prisma = createMockPrisma();
  prisma.robotSession = store;
  prisma.robot.findUnique.mockImplementation(async ({ where }) =>
    ROBOTS[where.robotId] ? { id: ROBOTS[where.robotId], status: "IDLE", isOnline: false, lat: null, lon: null, battery: 90 } : null,
  );
  prisma.robot.update.mockResolvedValue({ status: "IDLE" });
  return { prisma, store };
}

/** One backend process: its own KV (process memory) and handler module state. */
async function startProcess(world) {
  jest.resetModules();
  jest.doMock("../../../src/db/prisma");
  const { registerRobotHandlers } = require("../../../src/sockets/handlers/robot.handler");
  const { kv } = await createTestKv();
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  const io = createFakeIo();

  async function auth(payload) {
    const socket = createFakeSocket();
    registerRobotHandlers(io, socket, { prisma: world.prisma, kv, logger, appLocals: {} });
    socket.trigger("AUTH", payload);
    await waitFor(() => socket.sent.some((s) => s.event === "AUTH_SUCCESS") || socket.disconnect.mock.calls.length > 0);
    // Let the post-AUTH tail (audit write, dashboard emit) settle before asserting on it.
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
    const ack = socket.sent.find((s) => s.event === "AUTH_SUCCESS");
    return { ok: Boolean(ack), token: ack?.payload?.token, socket };
  }

  const authModes = () => logger.info.mock.calls.filter(([m]) => m === "Robot AUTH success").map(([, meta]) => meta.mode);
  const rejections = () => io.emittedTo("dashboard", "robot_pairing_rejected");
  return { kv, logger, io, auth, authModes, rejections };
}

async function issueCode(proc, robotId = "R1", code = "123456") {
  await proc.kv.set(`pairing:${robotId}`, code, { ex: 300 }); // what POST /api/robots/commission writes
  return code;
}

async function pair(proc, robotId = "R1", code = "123456") {
  await issueCode(proc, robotId, code);
  return proc.auth({ robotId, pairingCode: code });
}

describe("H1 — the session: KV key carries the configured lifetime", () => {
  const ORIGINAL = process.env.ROBOT_SESSION_TTL_SEC;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.ROBOT_SESSION_TTL_SEC;
    else process.env.ROBOT_SESSION_TTL_SEC = ORIGINAL;
  });

  const sessionWrites = (spy) => spy.mock.calls.filter(([key]) => String(key).startsWith("session:")).map(([, , options]) => options?.ex);

  test("default: pairing and a token reconnect both write the session for 30 days, not 24 h", async () => {
    delete process.env.ROBOT_SESSION_TTL_SEC;
    const world = createWorld();
    const p1 = await startProcess(world);
    const set = jest.spyOn(p1.kv, "set");
    const { token } = await pair(p1);
    await p1.auth({ robotId: "R1", token });

    expect(sessionWrites(set)).toEqual([30 * DAY_SEC, 30 * DAY_SEC]);
    expect(world.store.rows.get("row-R1").expiresAt.getTime()).toBeGreaterThan(Date.now() + 30 * DAY_SEC * 1000 - 5_000);
  });

  test("override: ROBOT_SESSION_TTL_SEC is the lifetime of both the KV key and the durable row", async () => {
    process.env.ROBOT_SESSION_TTL_SEC = String(7 * DAY_SEC);
    const world = createWorld();
    const p1 = await startProcess(world);
    const set = jest.spyOn(p1.kv, "set");
    await pair(p1);

    expect(sessionWrites(set)).toEqual([7 * DAY_SEC]);
    const ttlMs = world.store.rows.get("row-R1").expiresAt.getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(7 * DAY_SEC * 1000 - 5_000);
    expect(ttlMs).toBeLessThanOrEqual(7 * DAY_SEC * 1000);
  });

  test("power-off for days: after a restart the stored token is admitted from the durable row", async () => {
    delete process.env.ROBOT_SESSION_TTL_SEC;
    const world = createWorld();
    const { token } = await pair(await startProcess(world));
    // Ten days pass with the robot off and the backend restarted (empty KV). Under the old fixed
    // 24 h lifetime the row would have expired nine days ago.
    const row = world.store.rows.get("row-R1");
    row.expiresAt = new Date(row.expiresAt.getTime() - 10 * DAY_SEC * 1000);

    const p2 = await startProcess(world);
    const back = await p2.auth({ robotId: "R1", token });
    expect(back.ok).toBe(true);
    expect(p2.authModes()).toEqual(["durable-session"]);
  });
});

describe("H2 — a pairing code is consumed only by the login that used it", () => {
  test("a valid token login does NOT burn a code an operator has just issued", async () => {
    const world = createWorld();
    const p1 = await startProcess(world);
    const { token } = await pair(p1, "R1", "111111");
    await issueCode(p1, "R1", "222222"); // re-pair issued while the old unit can still reconnect
    await p1.kv.set("pairingAttempts:R1", "2", { ex: 300 });

    const reconnect = await p1.auth({ robotId: "R1", token });
    expect(reconnect.ok).toBe(true);
    expect(p1.authModes()).toEqual(["pairing", "session"]);
    expect(await p1.kv.get("pairing:R1")).toBe("222222");
    expect(await p1.kv.get("pairingAttempts:R1")).toBe("2");

    // ...and the code still enrolls the unit it was issued for.
    const repaired = await p1.auth({ robotId: "R1", pairingCode: "222222" });
    expect(repaired.ok).toBe(true);
    expect(await p1.kv.get("pairing:R1")).toBeNull();
  });

  test("a durable-session login after a restart does not burn an outstanding code either", async () => {
    const world = createWorld();
    const { token } = await pair(await startProcess(world));
    const p2 = await startProcess(world); // empty KV
    await issueCode(p2, "R1", "333333");

    const back = await p2.auth({ robotId: "R1", token });
    expect(back.ok).toBe(true);
    expect(p2.authModes()).toEqual(["durable-session"]);
    expect(await p2.kv.get("pairing:R1")).toBe("333333");
  });

  test("a pairing login consumes the code and clears the failed-attempt counter", async () => {
    const world = createWorld();
    const p1 = await startProcess(world);
    await issueCode(p1, "R1", "444444");
    await p1.kv.set("pairingAttempts:R1", "3", { ex: 300 });

    const paired = await p1.auth({ robotId: "R1", pairingCode: "444444" });
    expect(paired.ok).toBe(true);
    expect(p1.authModes()).toEqual(["pairing"]);
    expect(await p1.kv.get("pairing:R1")).toBeNull();
    expect(await p1.kv.get("pairingAttempts:R1")).toBeNull();

    // Single use: the same code is refused afterwards.
    const replay = await p1.auth({ robotId: "R1", pairingCode: "444444" });
    expect(replay.ok).toBe(false);
  });
});

describe("H4 — robot_pairing_rejected tells the dashboard, and only about commissioned robots", () => {
  test("a wrong code for a commissioned robot is announced with the count and the lock, never a code", async () => {
    const world = createWorld();
    const p1 = await startProcess(world);
    await issueCode(p1, "R1", "123456");

    const refused = await p1.auth({ robotId: "R1", pairingCode: "999999" });
    expect(refused.ok).toBe(false);
    expect(refused.socket.sent.filter((s) => s.event === "AUTH_FAILED")).toEqual([
      { event: "AUTH_FAILED", payload: { reason: "INVALID_CREDENTIAL" } },
    ]);

    expect(p1.rejections()).toEqual([{ robotId: "R1", failedAttempts: 1, locked: false }]);
    const wire = JSON.stringify(p1.io.roomEmits("dashboard"));
    expect(wire).not.toContain("999999");
    expect(wire).not.toContain("123456");
    expect(await p1.kv.get("pairing:R1")).toBe("123456"); // a wrong guess does not spend the real code
  });

  test("the fifth failure is announced as locked, and so is every attempt while locked", async () => {
    const world = createWorld();
    const p1 = await startProcess(world);
    await issueCode(p1, "R1", "123456");
    for (let i = 0; i < 5; i += 1) await p1.auth({ robotId: "R1", pairingCode: `00000${i}` });

    expect(p1.rejections().map((r) => [r.failedAttempts, r.locked])).toEqual([
      [1, false],
      [2, false],
      [3, false],
      [4, false],
      [5, true],
    ]);

    // Locked: even the right code is refused, and the dashboard is told it is the lock.
    const correctButLocked = await p1.auth({ robotId: "R1", pairingCode: "123456" });
    expect(correctButLocked.ok).toBe(false);
    expect(p1.rejections().at(-1)).toEqual({ robotId: "R1", failedAttempts: 5, locked: true });
  });

  test("an unknown robotId gets the same AUTH_FAILED and announces nothing", async () => {
    const world = createWorld();
    const p1 = await startProcess(world);

    const unknown = await p1.auth({ robotId: "RBT-NOT-COMMISSIONED", pairingCode: "123456" });
    expect(unknown.ok).toBe(false);
    expect(unknown.socket.sent.filter((s) => s.event === "AUTH_FAILED")).toEqual([
      { event: "AUTH_FAILED", payload: { reason: "INVALID_CREDENTIAL" } },
    ]);
    expect(p1.rejections()).toEqual([]);
    expect(await p1.kv.get("pairingAttempts:RBT-NOT-COMMISSIONED")).toBeNull();
  });

  test("a successful pairing announces online, not a rejection", async () => {
    const world = createWorld();
    const p1 = await startProcess(world);
    await pair(p1);
    expect(p1.rejections()).toEqual([]);
    expect(p1.io.emittedTo("dashboard", "robot_online")).toEqual([{ robotId: "R1" }]);
  });
});

describe("H5 — enrolling through pairing is an audit Event that never names the code or token", () => {
  test("a pairing login records exactly one INFO Event on the robot's row", async () => {
    const world = createWorld();
    const p1 = await startProcess(world);
    const { token } = await pair(p1, "R1", "123456");

    expect(world.prisma.event.create).toHaveBeenCalledTimes(1);
    const [{ data }] = world.prisma.event.create.mock.calls[0];
    expect(data).toMatchObject({ robotId: "row-R1", type: "INFO" });
    expect(data.message).toMatch(/R1 enrolled through pairing/);
    expect(data.message).not.toContain("123456");
    expect(data.message).not.toContain(token);
    expect(data.message).not.toContain(sha256(token));
  });

  test("a token reconnect is not an enrollment and records nothing", async () => {
    const world = createWorld();
    const p1 = await startProcess(world);
    const { token } = await pair(p1);
    world.prisma.event.create.mockClear();

    await p1.auth({ robotId: "R1", token });
    expect(world.prisma.event.create).not.toHaveBeenCalled();
  });

  test("an audit write that fails does not turn the enrollment into a refusal", async () => {
    const world = createWorld();
    world.prisma.event.create.mockRejectedValueOnce(new Error("connection reset"));
    const p1 = await startProcess(world);

    const paired = await pair(p1);
    expect(paired.ok).toBe(true);
    expect(world.store.rows.get("row-R1").tokenHash).toBe(sha256(paired.token));
  });
});

// ─── The HTTP half ──────────────────────────────────────────────────────────

function makeRes() {
  const res = { body: null, statusCode: 200 };
  res.status = jest.fn((c) => {
    res.statusCode = c;
    return res;
  });
  res.json = jest.fn((b) => {
    res.body = b;
    return res;
  });
  return res;
}

async function callHandler(handler, req) {
  const res = makeRes();
  const next = jest.fn();
  await handler(req, res, next);
  await waitFor(() => res.json.mock.calls.length > 0 || next.mock.calls.length > 0);
  return { res, error: next.mock.calls[0]?.[0] ?? null };
}

describe("H3 — GET /api/robots/:robotId/pairing reports enrollment state and never the code", () => {
  let controller;
  let kv;
  let prisma;

  beforeEach(async () => {
    jest.resetModules();
    jest.doMock("../../../src/db/prisma");
    controller = require("../../../src/controllers/robots.controller");
    ({ kv } = await createTestKv());
    prisma = {
      robot: { findUnique: jest.fn(async ({ where }) => (where.robotId === "R1" ? { id: "row-R1", isOnline: false, lastSeenAt: null } : null)) },
      robotSession: { findUnique: jest.fn(async () => null) },
    };
    require("../../../src/db/prisma").getPrisma.mockReturnValue(prisma);
  });

  const status = (robotId = "R1") => callHandler(controller.getPairingStatus, { params: { robotId }, app: { locals: { kv } } });

  test("a freshly commissioned robot: not enrolled, nothing pending, not locked", async () => {
    const { res } = await status();
    expect(res.body).toEqual({
      ok: true,
      robotId: "R1",
      isOnline: false,
      lastSeenAt: null,
      enrolled: false,
      pairingPending: false,
      failedAttempts: 0,
      locked: false,
    });
  });

  test("a pending code and failed attempts are reported; the code itself is not", async () => {
    await kv.set("pairing:R1", "654321", { ex: 300 });
    await kv.set("pairingAttempts:R1", "2", { ex: 300 });

    const { res } = await status();
    expect(res.body).toMatchObject({ pairingPending: true, failedAttempts: 2, locked: false });
    expect(JSON.stringify(res.body)).not.toContain("654321");
    expect(Object.keys(res.body).sort()).toEqual(
      ["enrolled", "failedAttempts", "isOnline", "lastSeenAt", "locked", "ok", "pairingPending", "robotId"].sort(),
    );
  });

  test("locked is reported", async () => {
    await kv.set("pairingLocked:R1", "1", { ex: 3600 });
    await kv.set("pairingAttempts:R1", "5", { ex: 300 });
    const { res } = await status();
    expect(res.body).toMatchObject({ locked: true, failedAttempts: 5 });
  });

  test("enrolled = an unexpired durable session; neither its hash nor its expiry is returned", async () => {
    const expiresAt = new Date(Date.now() + 5 * DAY_SEC * 1000);
    prisma.robotSession.findUnique.mockResolvedValue({ expiresAt });
    prisma.robot.findUnique.mockResolvedValue({ id: "row-R1", isOnline: true, lastSeenAt: new Date("2026-10-08T10:00:00Z") });

    const { res } = await status();
    expect(res.body).toMatchObject({ enrolled: true, isOnline: true, lastSeenAt: "2026-10-08T10:00:00.000Z" });
    expect(JSON.stringify(res.body)).not.toContain(expiresAt.toISOString());
    expect(prisma.robotSession.findUnique).toHaveBeenCalledWith({ where: { robotDbId: "row-R1" }, select: { expiresAt: true } });
  });

  test("an expired durable session is not enrolled", async () => {
    prisma.robotSession.findUnique.mockResolvedValue({ expiresAt: new Date(Date.now() - 1000) });
    const { res } = await status();
    expect(res.body.enrolled).toBe(false);
  });

  test("an unknown robot is a 404", async () => {
    const { error } = await status("RBT-NOPE");
    expect(error.status).toBe(404);
  });

  test("the route is behind the dashboard login: no session cookie or bearer, no answer", async () => {
    const app = express();
    app.locals.kv = kv;
    app.use("/api/robots", require("../../../src/routes/robots.routes"));
    const response = await request(app).get("/api/robots/R1/pairing");
    expect(response.status).toBe(401);
    expect(prisma.robot.findUnique).not.toHaveBeenCalled();
  });
});

describe("H5 — issuing a code is audited without the code; the code itself is unchanged", () => {
  test("POST /commission for an existing robot: a 6-digit, 300 s code in the response, an Event without it", async () => {
    jest.resetModules();
    jest.doMock("../../../src/db/prisma");
    const controller = require("../../../src/controllers/robots.controller");
    const { kv } = await createTestKv();
    const prisma = createMockPrisma();
    prisma.robot.findUnique.mockImplementation(async ({ include }) =>
      include ? { id: "row-R1", robotId: "R1", lat: null, lon: null, status: "IDLE" } : { id: "row-R1" },
    );
    prisma.event.create.mockResolvedValue({});
    require("../../../src/db/prisma").getPrisma.mockReturnValue(prisma);

    const { res } = await callHandler(controller.commissionRobotWithPairing, {
      body: { robotId: "R1" },
      user: { id: "user-7" },
      app: { locals: { kv, io: createFakeIo(), logger: { warn: jest.fn() } } },
    });

    expect(res.body.pairingCode).toMatch(/^[0-9]{6}$/);
    expect(res.body.expiresIn).toBe(300);
    expect(await kv.get("pairing:R1")).toBe(res.body.pairingCode);

    const issued = prisma.event.create.mock.calls.map(([arg]) => arg.data).find((d) => /Pairing code issued/.test(d.message));
    expect(issued).toMatchObject({ robotId: "row-R1", type: "INFO" });
    expect(issued.message).toMatch(/by user-7/);
    expect(issued.message).not.toContain(res.body.pairingCode);
  });
});

describe("H6 — decommissioning deletes the robot's credentials and closes its connection", () => {
  test("session, pairing, attempts and lock keys are deleted; the live socket is disconnected", async () => {
    jest.resetModules();
    jest.doMock("../../../src/db/prisma");
    const controller = require("../../../src/controllers/robots.controller");
    const robotSockets = require("../../../src/sockets/robotSockets");
    const { kv } = await createTestKv();
    const prisma = createMockPrisma();
    prisma.robot.findUnique.mockResolvedValue({ id: "row-R1" });
    prisma.robot.delete.mockResolvedValue({ id: "row-R1" });
    require("../../../src/db/prisma").getPrisma.mockReturnValue(prisma);

    for (const robotId of ["R1", "R2"]) {
      await kv.set(`session:${robotId}`, `token-${robotId}`, { ex: 3600 });
      await kv.set(`pairing:${robotId}`, "123456", { ex: 300 });
      await kv.set(`pairingAttempts:${robotId}`, "2", { ex: 300 });
      await kv.set(`pairingLocked:${robotId}`, "1", { ex: 3600 });
    }
    const live = createFakeSocket({ id: "sock-R1" });
    robotSockets.setRobotSocket("R1", live);

    const { res } = await callHandler(controller.deleteRobot, { params: { robotId: "R1" }, app: { locals: { kv } } });

    expect(res.body).toEqual({ ok: true, robotId: "R1" });
    for (const key of ["session:R1", "pairing:R1", "pairingAttempts:R1", "pairingLocked:R1"]) {
      expect(await kv.get(key)).toBeNull();
    }
    expect(live.disconnect).toHaveBeenCalledWith(true);
    // Another robot's credentials are untouched.
    expect(await kv.get("session:R2")).toBe("token-R2");
    expect(await kv.get("pairing:R2")).toBe("123456");
    // The row went first, so a reconnect finds no robot to authenticate as.
    expect(prisma.robot.delete.mock.invocationCallOrder[0]).toBeLessThan(live.disconnect.mock.invocationCallOrder[0]);
    robotSockets.deleteRobotSocket("R1");
  });

  test("a re-commissioned robotId no longer accepts the decommissioned unit's token", async () => {
    const world = createWorld();
    const p1 = await startProcess(world);
    const { token } = await pair(p1);

    jest.doMock("../../../src/db/prisma");
    const controller = require("../../../src/controllers/robots.controller");
    world.prisma.robot.delete.mockResolvedValue({ id: "row-R1" });
    require("../../../src/db/prisma").getPrisma.mockReturnValue(world.prisma);
    await callHandler(controller.deleteRobot, { params: { robotId: "R1" }, app: { locals: { kv: p1.kv } } });

    // Same robotId commissioned again (the mock's findUnique still answers for R1). The durable
    // row would have cascaded with the deleted Robot; model that, then present the old token.
    world.store.rows.delete("row-R1");
    expect(await p1.kv.get("session:R1")).toBeNull();
    const reused = await p1.auth({ robotId: "R1", token });
    expect(reused.ok).toBe(false);
  });

  test("decommissioning a robot with no live connection is fine", async () => {
    jest.resetModules();
    jest.doMock("../../../src/db/prisma");
    const controller = require("../../../src/controllers/robots.controller");
    const { kv } = await createTestKv();
    const prisma = createMockPrisma();
    prisma.robot.findUnique.mockResolvedValue({ id: "row-R9" });
    prisma.robot.delete.mockResolvedValue({ id: "row-R9" });
    require("../../../src/db/prisma").getPrisma.mockReturnValue(prisma);

    const { res } = await callHandler(controller.deleteRobot, { params: { robotId: "R9" }, app: { locals: { kv } } });
    expect(res.body).toEqual({ ok: true, robotId: "R9" });
  });
});
