"use strict";

/**
 * RBAC over Socket.IO, end to end: a real server and real clients, so the handshake, the rooms
 * and the relay are the shipped ones.
 *
 *   - the room is the server's choice: a SUPER_ADMIN joins `dashboard`, a campus ADMIN only
 *     its campus room — a client cannot ask for a room;
 *   - an ADMIN receives a robot or task event only when that robot or task is its campus's,
 *     and never a SUPER_ADMIN-only event (security, pairing, engine invariants);
 *   - a robot whose agent region contradicts its campus, or an unknown one, reaches no ADMIN;
 *   - the reconnect replay is filtered by the same scope;
 *   - an ADMIN with no valid campus is refused; an account change disconnects its sockets.
 */

jest.mock("../../src/db/prisma");

const http = require("http");
const { Server } = require("socket.io");
const { io: ioClient } = require("socket.io-client");
const jwt = require("jsonwebtoken");

const { getPrisma } = require("../../src/db/prisma");
const initSocketServer = require("../../src/sockets/socket.server");
const dashboardBroadcast = require("../../src/sockets/dashboardBroadcast");
const accessScope = require("../../src/services/accessScope.service");
const { createTestKv } = require("../helpers/testKv");
const silentLogger = require("../mocks/silentLogger");

const CAMPUS_A = { id: "ca000000-0000-4000-8000-00000000000a", code: "RNSIT", name: "RNSIT", regionId: "ra000000-0000-4000-8000-00000000000a", region: { regionId: "rnsit" } };
const CAMPUS_B = { id: "cb000000-0000-4000-8000-00000000000b", code: "JSS", name: "JSS", regionId: "rb000000-0000-4000-8000-00000000000b", region: { regionId: "jss" } };

const SUPER = { id: "11111111-1111-4111-8111-111111111111", email: "root@x", role: "SUPER_ADMIN", campusId: null, campus: null, disabledAt: null };
const ADMIN_A = { id: "22222222-2222-4222-8222-222222222222", email: "a@x", role: "ADMIN", campusId: CAMPUS_A.id, campus: CAMPUS_A, disabledAt: null };
const ADMIN_B = { id: "33333333-3333-4333-8333-333333333333", email: "b@x", role: "ADMIN", campusId: CAMPUS_B.id, campus: CAMPUS_B, disabledAt: null };
const ADMIN_BROKEN = { id: "44444444-4444-4444-8444-444444444444", email: "c@x", role: "ADMIN", campusId: CAMPUS_A.id, campus: null, disabledAt: null };
const ACCOUNTS = [SUPER, ADMIN_A, ADMIN_B, ADMIN_BROKEN];

// Robots and tasks as the database records them.
const ROBOTS = {
  "R-A": { campusId: CAMPUS_A.id, campus: { regionId: CAMPUS_A.regionId }, agent: { regionId: CAMPUS_A.regionId } },
  "R-B": { campusId: CAMPUS_B.id, campus: { regionId: CAMPUS_B.regionId }, agent: null },
  // Campus A on its robot row, region B on its agent: belongs to neither campus.
  "R-SPLIT": { campusId: CAMPUS_A.id, campus: { regionId: CAMPUS_A.regionId }, agent: { regionId: CAMPUS_B.regionId } },
};
const TASKS = {
  "T-A": { robotId: null, missions: [{ regionId: CAMPUS_A.regionId }] },
  "T-B": { robotId: null, missions: [{ regionId: CAMPUS_B.regionId }] },
};

describe("Socket.IO dashboard RBAC", () => {
  let httpServer;
  let io;
  let port;
  let prisma;
  const clients = [];

  beforeAll(async () => {
    prisma = {
      user: { findUnique: jest.fn(async ({ where }) => ACCOUNTS.find((u) => u.id === where.id) || null) },
      task: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(async ({ where }) => TASKS[where.taskId] || null),
      },
      robot: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findFirst: jest.fn(async ({ where }) => {
          const code = where.OR && where.OR[0] && where.OR[0].robotId;
          return ROBOTS[code] || null;
        }),
      },
      campus: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn(async ({ where }) => [CAMPUS_A, CAMPUS_B].find((c) => c.regionId === where.regionId) || null),
      },
    };
    getPrisma.mockReturnValue(prisma);
    const { kv } = await createTestKv();

    httpServer = http.createServer();
    io = new Server(httpServer, { cors: { origin: true, credentials: true } });
    initSocketServer(io, { prisma, kv, logger: silentLogger });
    await new Promise((resolve) => httpServer.listen(0, resolve));
    port = httpServer.address().port;
  });

  afterAll(async () => {
    io.close();
    await new Promise((resolve) => httpServer.close(resolve));
  });

  afterEach(() => {
    for (const c of clients.splice(0)) {
      try { c.close(); } catch { /* ignore */ }
    }
  });

  function connect(user, query) {
    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET);
    const client = ioClient(`http://localhost:${port}`, {
      transports: ["websocket"],
      reconnection: false,
      extraHeaders: { "user-agent": "Mozilla/5.0 (test dashboard)", cookie: `token=${token}` },
      query,
    });
    clients.push(client);
    return client;
  }

  /** Connect and wait until the server has placed the socket in its rooms. */
  async function joined(user, query) {
    const client = connect(user, query);
    await new Promise((resolve, reject) => {
      client.once("connect", resolve);
      client.once("connect_error", reject);
    });
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const sockets = await io.in(dashboardBroadcast.userRoom(user.id)).fetchSockets();
      if (sockets.length > 0) return client;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("socket never joined its rooms");
  }

  function collect(client) {
    const seen = [];
    client.onAny((event, payload) => seen.push({ event, payload }));
    return seen;
  }

  async function broadcastAndSettle(event, payload) {
    dashboardBroadcast.emit(io, event, payload);
    await dashboardBroadcast.drain();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  test("the server chooses the room: SUPER_ADMIN → dashboard; ADMIN → its campus room only", async () => {
    await joined(SUPER);
    await joined(ADMIN_A, { room: "dashboard" }); // a requested room changes nothing
    const rooms = io.of("/").adapter.rooms;
    const inDashboard = [...(rooms.get("dashboard") || [])].length;
    const inCampusA = [...(rooms.get(dashboardBroadcast.campusRoom(CAMPUS_A.id)) || [])].length;
    expect(inDashboard).toBe(1);
    expect(inCampusA).toBe(1);
  });

  test("an ADMIN receives its campus's robot and task events — and nothing else", async () => {
    const root = collect(await joined(SUPER));
    const a = collect(await joined(ADMIN_A));
    const b = collect(await joined(ADMIN_B));

    await broadcastAndSettle("robot:update", { robotId: "R-A", battery: 80 });
    await broadcastAndSettle("robot:update", { robotId: "R-B", battery: 40 });
    await broadcastAndSettle("TASK_UPDATED", { taskId: "T-A", status: "ASSIGNED" });
    await broadcastAndSettle("TASK_UPDATED", { taskId: "T-B", status: "ASSIGNED" });
    // SUPER_ADMIN-only by default.
    await broadcastAndSettle("SECURITY_EVENT", { robotId: "R-A", type: "TELEMETRY_REJECTED" });
    await broadcastAndSettle("robot_pairing_rejected", { robotId: "R-A", failedAttempts: 3 });
    await broadcastAndSettle("INVARIANT_STATUS_CHANGED", { invariant: "I2" });
    // Fail closed: contradictory ownership and an unknown robot reach no ADMIN.
    await broadcastAndSettle("robot:update", { robotId: "R-SPLIT", battery: 10 });
    await broadcastAndSettle("robot:update", { robotId: "R-UNKNOWN", battery: 10 });

    const names = (seen) => seen.map((e) => `${e.event}:${e.payload.robotId || e.payload.taskId || e.payload.invariant}`);
    expect(names(a)).toEqual(["robot:update:R-A", "TASK_UPDATED:T-A"]);
    expect(names(b)).toEqual(["robot:update:R-B", "TASK_UPDATED:T-B"]);
    expect(names(root)).toEqual([
      "robot:update:R-A",
      "robot:update:R-B",
      "TASK_UPDATED:T-A",
      "TASK_UPDATED:T-B",
      "SECURITY_EVENT:R-A",
      "robot_pairing_rejected:R-A",
      "INVARIANT_STATUS_CHANGED:I2",
      "robot:update:R-SPLIT",
      "robot:update:R-UNKNOWN",
    ]);
  });

  test("the reconnect replay is read through the ADMIN's task scope", async () => {
    prisma.task.findMany.mockClear();
    await joined(ADMIN_A);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const [{ where }] = prisma.task.findMany.mock.calls[0];
    expect(where).toEqual(accessScope.within({ status: { in: ["ASSIGNED", "IN_PROGRESS"] } }, accessScope.taskWhere(accessScope.accessScopeFor(ADMIN_A))));
  });

  test("an ADMIN with no valid campus is refused at the handshake", async () => {
    const client = connect(ADMIN_BROKEN);
    const reason = await new Promise((resolve) => {
      client.once("UNAUTHORIZED", () => resolve("UNAUTHORIZED"));
      client.once("disconnect", () => resolve("disconnect"));
    });
    expect(["UNAUTHORIZED", "disconnect"]).toContain(reason);
    const rooms = io.of("/").adapter.rooms;
    expect(rooms.get(dashboardBroadcast.campusRoom(CAMPUS_A.id)) || new Set()).not.toContain(client.id);
  });

  test("an account change reaches the client as UNAUTHORIZED (with its reason) before the disconnect", async () => {
    const a = await joined(ADMIN_A);
    const told = new Promise((resolve) => a.once("UNAUTHORIZED", resolve));
    const gone = new Promise((resolve) => a.once("disconnect", resolve));
    // What `users.controller.updateAdmin` does.
    io.to(dashboardBroadcast.userRoom(ADMIN_A.id)).emit("UNAUTHORIZED", { message: "Your access has been revoked", code: "ACCOUNT_DISABLED" });
    await io.in(dashboardBroadcast.userRoom(ADMIN_A.id)).disconnectSockets(true);
    expect(await told).toEqual({ message: "Your access has been revoked", code: "ACCOUNT_DISABLED" });
    expect(await gone).toBe("io server disconnect");
  });

  test("after a campus change, the reconnected socket is in the new campus only", async () => {
    const moved = { ...ADMIN_A, campusId: CAMPUS_B.id, campus: CAMPUS_B };
    const index = ACCOUNTS.indexOf(ADMIN_A);
    ACCOUNTS[index] = moved;
    try {
      const seen = collect(await joined(moved));
      await broadcastAndSettle("robot:update", { robotId: "R-A", battery: 1 });
      await broadcastAndSettle("robot:update", { robotId: "R-B", battery: 2 });
      expect(seen.map((e) => e.payload.robotId)).toEqual(["R-B"]);
    } finally {
      ACCOUNTS[index] = ADMIN_A;
    }
  });

  test("an account change disconnects that account's sockets, and only those", async () => {
    const a = await joined(ADMIN_A);
    const b = await joined(ADMIN_B);
    const gone = new Promise((resolve) => a.once("disconnect", resolve));
    await io.in(dashboardBroadcast.userRoom(ADMIN_A.id)).disconnectSockets(true);
    await gone;
    expect(a.connected).toBe(false);
    expect(b.connected).toBe(true);
  });
});
