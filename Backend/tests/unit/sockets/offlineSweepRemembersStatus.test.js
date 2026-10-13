"use strict";

/**
 * The legacy offline sweep (engine-off processes) takes a robot OFFLINE the way the disconnect
 * handler does: it keeps the status it replaced, so the robot's reconnect restores it (P1.4 LF-1).
 *
 * Before: the sweep wrote `status = OFFLINE` and remembered nothing. `markRobotOnline` then had
 * nothing to restore, so the robot stayed OFFLINE after it came back — F9 denies it, `clear-fault`
 * refuses OFFLINE and its own IDLE is refused by §23.5 — until someone edited the row. The sweep
 * shares the database with engine-on boots, so one engine-off run left those robots unassignable.
 * Its write was also unconditional, so a robot that reconnected between the sweep's read and its
 * write was taken offline while connected.
 *
 * The store double applies `where` literally (equality, `in`, `lt`), as the real client does.
 */

const initSocketServer = require("../../../src/sockets/socket.server");
const { markRobotOnline } = require("../../../src/sockets/handlers/robot.handler");
const { OFFLINE_CUTOFF_MS } = require("../../../src/config/liveness.constants");
const robotStateCache = require("../../../src/cache/robotStateCache");

const NOW = Date.parse("2026-10-12T08:00:00Z");
const STALE = new Date(NOW - OFFLINE_CUTOFF_MS - 60_000);

function store(initial) {
  const rows = new Map(initial.map((row) => [row.robotId, { statusBeforeOffline: null, socketId: "sock-1", isOnline: true, lastSeenAt: STALE, ...row }]));
  const fieldMatches = (value, condition) => {
    if (condition && typeof condition === "object" && !(condition instanceof Date)) {
      if ("in" in condition) return condition.in.includes(value);
      if ("lt" in condition) return value instanceof Date && value < condition.lt;
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
      update: async ({ where, data }) => Object.assign(rows.get(where.robotId), data),
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

const kv = { srem: async () => 0, get: async () => null, mget: async (keys) => keys.map(() => null) };

describe("legacy offline sweep — the replaced status is remembered and restored", () => {
  test("it is exported for a single pass", () => {
    expect(typeof initSocketServer.sweepOfflineOnce).toBe("function");
  });

  test.each(["IDLE", "ACTIVE", "PAUSED", "ERROR", "ISSUES"])(
    "a stale %s robot goes OFFLINE remembering it, and its reconnect restores exactly that",
    async (status) => {
      const prisma = store([{ robotId: "SW-1", status }]);
      await initSocketServer.sweepOfflineOnce(prisma, kv, { nowMs: NOW });

      expect(prisma.rows.get("SW-1")).toMatchObject({ isOnline: false, status: "OFFLINE", socketId: null, statusBeforeOffline: status });
      expect(robotStateCache.get("SW-1")).toMatchObject({ isOnline: false, status: "OFFLINE" });

      await markRobotOnline(prisma, "SW-1", "sock-2");
      expect(prisma.rows.get("SW-1")).toMatchObject({ isOnline: true, status, statusBeforeOffline: null });
    },
  );

  test("an OFFLINE row keeps what it already remembered", async () => {
    const prisma = store([{ robotId: "SW-2", status: "OFFLINE", statusBeforeOffline: "PAUSED" }]);
    await initSocketServer.sweepOfflineOnce(prisma, kv, { nowMs: NOW });
    expect(prisma.rows.get("SW-2")).toMatchObject({ isOnline: false, status: "OFFLINE", statusBeforeOffline: "PAUSED" });
  });

  test("a robot that reconnects between the sweep's read and its write is left online", async () => {
    const prisma = store([{ robotId: "SW-3", status: "IDLE" }]);
    prisma.beforeWrite = async () => {
      await markRobotOnline(prisma, "SW-3", "sock-new");
      prisma.rows.get("SW-3").lastSeenAt = new Date(NOW);
    };
    await initSocketServer.sweepOfflineOnce(prisma, kv, { nowMs: NOW });
    expect(prisma.rows.get("SW-3")).toMatchObject({ isOnline: true, status: "IDLE", socketId: "sock-new", statusBeforeOffline: null });
  });

  test("a status written between the sweep's read and its write is the one remembered", async () => {
    const prisma = store([{ robotId: "SW-4", status: "IDLE" }]);
    prisma.beforeWrite = async () => {
      prisma.rows.get("SW-4").status = "PAUSED"; // an operator hold lands first
    };
    await initSocketServer.sweepOfflineOnce(prisma, kv, { nowMs: NOW });
    const row = prisma.rows.get("SW-4");
    // Either taken offline remembering PAUSED, or left for the next pass — never OFFLINE with
    // IDLE (or nothing) remembered.
    if (row.status === "OFFLINE") expect(row.statusBeforeOffline).toBe("PAUSED");
    else expect(row).toMatchObject({ status: "PAUSED", isOnline: true });
  });

  test("a robot the registry still sees beating is not taken offline", async () => {
    const prisma = store([{ robotId: "SW-5", status: "IDLE" }]);
    const liveKv = { ...kv, mget: async (keys) => keys.map(() => JSON.stringify({ lastHeartbeat: NOW - 1000 })), get: async () => JSON.stringify({ lastHeartbeat: NOW - 1000 }) };
    await initSocketServer.sweepOfflineOnce(prisma, liveKv, { nowMs: NOW });
    expect(prisma.rows.get("SW-5")).toMatchObject({ isOnline: true, status: "IDLE" });
  });
});
