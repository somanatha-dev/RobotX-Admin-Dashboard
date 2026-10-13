"use strict";

/**
 * Stale "online" after the backend itself goes away.
 *
 * A robot is taken offline by its socket's `disconnect` handler (`markRobotOffline`). A backend
 * that crashes, is killed or is redeployed never runs those handlers, so every robot connected to
 * it keeps `isOnline: true` and a socket id that no longer exists. With the engine off the legacy
 * sweep eventually notices; with the engine on nothing does (that sweep stands down, by design,
 * and the reconciler does not own `Robot.isOnline`), so a robot that never reconnects stays
 * "online" on the dashboard for good. The engine itself never assigns it: F13 also requires a
 * heartbeat inside `connectivity.max_heartbeat_age`.
 *
 * `reconcileDeadSocketBindings` runs once at startup. A row whose socket exists nowhere in the
 * cluster (Socket.IO's own per-socket room, adapter-aware) gets exactly the write its missed
 * disconnect would have made: `markRobotOffline`, conditional on that socket id, so a robot that
 * reconnects meanwhile is never touched, and with the status it replaced remembered, so the
 * reconnect restores an operator hold or a fault exactly. It is not a periodic sweep and needs no
 * timeout: a socket either exists or it does not. A slow robot whose socket is alive is left alone.
 *
 * Real Socket.IO server and websocket client; the store applies `where` literally.
 */

const http = require("http");
const { Server } = require("socket.io");
const { io: ioClient } = require("socket.io-client");
const { reconcileDeadSocketBindings, markRobotOnline } = require("../../../src/sockets/handlers/robot.handler");
const robotStateCache = require("../../../src/cache/robotStateCache");
const silentLogger = require("../../mocks/silentLogger");

function store(initial) {
  const rows = new Map(initial.map((row) => [row.robotId, { statusBeforeOffline: null, isOnline: true, ...row }]));
  const fieldMatches = (value, condition) => {
    if (condition && typeof condition === "object") {
      if ("not" in condition) return value !== condition.not;
      if ("in" in condition) return condition.in.includes(value);
    }
    return value === condition;
  };
  const matches = (row, where) => Object.entries(where).every(([k, v]) => fieldMatches(row[k], v));
  const client = {
    rows,
    beforeWrite: null,
    $transaction: async (fn) => fn(client),
    $queryRawUnsafe: async () => [],
    robot: {
      findMany: async ({ where, select }) =>
        [...rows.values()].filter((row) => matches(row, where)).map((row) => Object.fromEntries(Object.keys(select).map((k) => [k, row[k]]))),
      findUnique: async ({ where }) => (rows.has(where.robotId) ? { ...rows.get(where.robotId) } : null),
      update: async ({ where, data }) => ({ ...Object.assign(rows.get(where.robotId), data) }),
      updateMany: async ({ where, data }) => {
        if (typeof client.beforeWrite === "function") {
          const hook = client.beforeWrite;
          client.beforeWrite = null;
          await hook();
        }
        let count = 0;
        for (const row of rows.values()) {
          if (matches(row, where)) {
            Object.assign(row, data);
            count += 1;
          }
        }
        return { count };
      },
    },
  };
  return client;
}

function memoryKv() {
  const map = new Map();
  return {
    map,
    get: async (k) => (map.has(k) ? map.get(k) : null),
    set: async (k, v) => map.set(k, v),
    del: async (k) => map.delete(k),
    srem: jest.fn(async () => 0),
  };
}

describe("startup reconciliation of socket bindings no process holds", () => {
  let server;
  let io;
  let port;
  const clients = [];
  const dashboard = [];

  beforeAll(async () => {
    server = http.createServer();
    io = new Server(server);
    io.on("connection", (socket) => socket.join("dashboard-observer"));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = server.address().port;
  });
  afterAll(async () => {
    for (const client of clients) client.close();
    io.close();
    await new Promise((resolve) => server.close(resolve));
  });
  beforeEach(() => {
    dashboard.length = 0;
  });

  // The emitted dashboard events, captured at the source.
  function capturingIo() {
    return new Proxy(io, {
      get(target, prop) {
        if (prop === "to") {
          return (room) => ({ emit: (event, payload) => dashboard.push({ room, event, payload }) });
        }
        const value = target[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  async function liveSocketId() {
    const client = ioClient(`http://127.0.0.1:${port}`, { transports: ["websocket"], reconnection: false, forceNew: true });
    clients.push(client);
    await new Promise((resolve) => client.on("connect", resolve));
    return client.id;
  }

  test.each([
    ["IDLE", "IDLE"],
    ["an operator hold (PAUSED)", "PAUSED"],
    ["a fault (ERROR)", "ERROR"],
    ["ACTIVE", "ACTIVE"],
  ])("a robot left online by a dead process (%s) is taken offline, and its reconnect restores that status", async (_name, status) => {
    const prisma = store([{ robotId: "DEAD-1", status, socketId: "socket-of-a-dead-process" }]);
    const kv = memoryKv();

    const result = await reconcileDeadSocketBindings({ prisma, io: capturingIo(), kv, log: silentLogger });

    expect(result.offline).toEqual(["DEAD-1"]);
    expect(prisma.rows.get("DEAD-1")).toMatchObject({ isOnline: false, status: "OFFLINE", socketId: null, statusBeforeOffline: status });
    expect(robotStateCache.get("DEAD-1")).toMatchObject({ isOnline: false, status: "OFFLINE" });
    expect(kv.srem).toHaveBeenCalledWith("robots:all", "DEAD-1");
    expect(dashboard).toEqual([{ room: "dashboard", event: "robot_offline", payload: { robotId: "DEAD-1" } }]);

    await markRobotOnline(prisma, "DEAD-1", "sock-reconnected");
    expect(prisma.rows.get("DEAD-1")).toMatchObject({ isOnline: true, status, statusBeforeOffline: null });
  });

  test("a robot whose socket is alive is left alone, however long since it last reported", async () => {
    const socketId = await liveSocketId();
    const prisma = store([{ robotId: "LIVE-1", status: "ACTIVE", socketId, lastSeenAt: new Date(0) }]);

    const result = await reconcileDeadSocketBindings({ prisma, io: capturingIo(), kv: memoryKv(), log: silentLogger });

    expect(result.offline).toEqual([]);
    expect(prisma.rows.get("LIVE-1")).toMatchObject({ isOnline: true, status: "ACTIVE", socketId });
    expect(dashboard).toEqual([]);
  });

  test("a robot that reconnects between the read and the write is never taken offline", async () => {
    const prisma = store([{ robotId: "RACE-1", status: "IDLE", socketId: "socket-of-a-dead-process" }]);
    prisma.beforeWrite = async () => {
      await markRobotOnline(prisma, "RACE-1", "sock-new");
    };

    const result = await reconcileDeadSocketBindings({ prisma, io: capturingIo(), kv: memoryKv(), log: silentLogger });

    expect(result.offline).toEqual([]);
    expect(prisma.rows.get("RACE-1")).toMatchObject({ isOnline: true, status: "IDLE", socketId: "sock-new" });
    expect(dashboard).toEqual([]);
  });

  test("an online row with no socket at all is cleared as liveness only; its status is untouched", async () => {
    // What a telemetry frame in flight at a disconnect could leave before the flush guard:
    // OFFLINE written and remembered, then isOnline put back to true with no socket.
    const prisma = store([{ robotId: "NOSOCK-1", status: "OFFLINE", statusBeforeOffline: "PAUSED", socketId: null }]);

    const result = await reconcileDeadSocketBindings({ prisma, io: capturingIo(), kv: memoryKv(), log: silentLogger });

    expect(result.offline).toEqual(["NOSOCK-1"]);
    expect(prisma.rows.get("NOSOCK-1")).toMatchObject({ isOnline: false, status: "OFFLINE", statusBeforeOffline: "PAUSED" });
    // The dashboard is told exactly what was written: liveness, not a status (`robot_offline`
    // means "OFFLINE was written" to the dashboard, `lib/liveState.js`).
    expect(dashboard).toEqual([{ room: "dashboard", event: "robot:update", payload: { robotId: "NOSOCK-1", isOnline: false } }]);
    await markRobotOnline(prisma, "NOSOCK-1", "sock-back");
    expect(prisma.rows.get("NOSOCK-1")).toMatchObject({ isOnline: true, status: "PAUSED" });
  });

  test("presence that cannot be established is not evidence: the row is left alone", async () => {
    const prisma = store([{ robotId: "UNKNOWN-1", status: "IDLE", socketId: "sid-x" }]);
    const failing = { in: () => ({ fetchSockets: async () => { throw new Error("adapter timeout"); } }), to: () => ({ emit: () => {} }) };

    const result = await reconcileDeadSocketBindings({ prisma, io: failing, kv: memoryKv(), log: silentLogger });

    expect(result.offline).toEqual([]);
    expect(result.unknown).toEqual(["UNKNOWN-1"]);
    expect(prisma.rows.get("UNKNOWN-1")).toMatchObject({ isOnline: true, status: "IDLE", socketId: "sid-x" });
  });

  test("the engine's liveness gate (F13) refuses the robot before reconciliation (stale heartbeat) and after it (no live session)", async () => {
    const f13 = require("../../../src/engine/feasibility/predicates/f13");
    const config = { "connectivity.max_heartbeat_age": 10 };
    const decisionTimeMs = Date.parse("2026-10-12T12:00:00Z");
    const lastHeartbeatAt = new Date(decisionTimeMs - 10 * 60_000); // the dead process's last beat
    const prisma = store([{ robotId: "GATE-1", status: "IDLE", socketId: "socket-of-a-dead-process" }]);
    const verdict = (row) =>
      f13.evaluate({ agentSnapshot: { session: { live: row.isOnline === true, lastHeartbeatAt } }, config, decisionTimeMs }).outcome;

    expect(verdict(prisma.rows.get("GATE-1"))).toBe("VIOLATED"); // shown online, but its heartbeat is stale
    await reconcileDeadSocketBindings({ prisma, io: capturingIo(), kv: memoryKv(), log: silentLogger });
    expect(verdict(prisma.rows.get("GATE-1"))).toBe("VIOLATED"); // now also no live session
  });

  test("server.js runs it once at startup, engine on or off, and never on an interval", () => {
    const source = require("fs").readFileSync(require("path").join(__dirname, "../../../server.js"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const calls = code.match(/reconcileDeadSocketBindings\(\{ prisma, io, kv, log: logger \}\)/g) || [];
    expect(calls).toHaveLength(1);
    expect(code).not.toMatch(/setInterval\([^)]*reconcileDeadSocketBindings/);
    // Not inside the engine gate: the call precedes the `ENGINE_ENABLED` branch that starts workers.
    expect(code.indexOf("reconcileDeadSocketBindings({")).toBeLessThan(code.indexOf("initSocketServer(io") + 400);
  });

  test("offline robots and robots already offline are not read or written", async () => {
    const prisma = store([{ robotId: "OFF-1", status: "OFFLINE", isOnline: false, socketId: null, statusBeforeOffline: "IDLE" }]);
    const result = await reconcileDeadSocketBindings({ prisma, io: capturingIo(), kv: memoryKv(), log: silentLogger });
    expect(result.offline).toEqual([]);
    expect(prisma.rows.get("OFF-1")).toMatchObject({ isOnline: false, status: "OFFLINE", statusBeforeOffline: "IDLE" });
  });
});
