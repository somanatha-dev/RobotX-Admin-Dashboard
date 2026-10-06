"use strict";

/**
 * P1.4 (LF-1) — a server-observed reconnect undoes the server's own disconnect write.
 *
 * Before: a disconnect wrote `status = OFFLINE`; AUTH restored only `isOnline`; under
 * enforcement the agent's own `IDLE` is refused (§23.5) and `clear-fault` refuses `OFFLINE`.
 * Measured live, a simulator stop/start left every robot OFFLINE and F9 denied them all for
 * good. Now the disconnect keeps the status it replaced and AUTH restores exactly that —
 * never a higher tier than the robot had.
 *
 * The store double applies `where` literally, including the conditional updates, so the
 * tests exercise the same compare-and-set the real client performs.
 */

const { markRobotOnline, markRobotOffline } = require("../../../src/sockets/handlers/robot.handler");
const robotStateCache = require("../../../src/cache/robotStateCache");

function store(initial) {
  const rows = new Map(initial.map((row) => [row.robotId, { statusBeforeOffline: null, ...row }]));
  const matches = (row, where) => Object.entries(where).every(([k, v]) => row[k] === v);
  return {
    rows,
    robot: {
      findUnique: async ({ where }) => (rows.has(where.robotId) ? { ...rows.get(where.robotId) } : null),
      update: async ({ where, data }) => {
        const row = rows.get(where.robotId);
        Object.assign(row, data);
        return { ...row };
      },
      updateMany: async ({ where, data }) => {
        const row = rows.get(where.robotId);
        if (!row || !matches(row, where)) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
  };
}

describe("LF-1 — disconnect then reconnect (P1.4)", () => {
  test("IDLE → disconnect → OFFLINE → AUTH → IDLE again", async () => {
    const prisma = store([{ robotId: "V1DEMO-01", socketId: "sock-1", status: "IDLE", isOnline: true }]);
    await markRobotOffline(prisma, "V1DEMO-01", "sock-1");
    expect(prisma.rows.get("V1DEMO-01")).toMatchObject({ status: "OFFLINE", isOnline: false, statusBeforeOffline: "IDLE" });

    const row = await markRobotOnline(prisma, "V1DEMO-01", "sock-2");
    expect(row).toMatchObject({ status: "IDLE", isOnline: true });
    expect(prisma.rows.get("V1DEMO-01")).toMatchObject({ status: "IDLE", isOnline: true, statusBeforeOffline: null, socketId: "sock-2" });
    expect(robotStateCache.get("V1DEMO-01")).toMatchObject({ status: "IDLE" });
  });

  test("a fault is never laundered: ERROR → disconnect → AUTH → ERROR", async () => {
    const prisma = store([{ robotId: "R-ERR", socketId: "sock-1", status: "ERROR", isOnline: true }]);
    await markRobotOffline(prisma, "R-ERR", "sock-1");
    await markRobotOnline(prisma, "R-ERR", "sock-2");
    expect(prisma.rows.get("R-ERR").status).toBe("ERROR");
  });

  test("an operator hold is never lifted: PAUSED → disconnect → AUTH → PAUSED", async () => {
    const prisma = store([{ robotId: "R-P", socketId: "sock-1", status: "PAUSED", isOnline: true }]);
    await markRobotOffline(prisma, "R-P", "sock-1");
    await markRobotOnline(prisma, "R-P", "sock-2");
    expect(prisma.rows.get("R-P").status).toBe("PAUSED");
  });

  test("a second disconnect keeps the status first replaced, not OFFLINE", async () => {
    const prisma = store([{ robotId: "R-2", socketId: "sock-1", status: "ACTIVE", isOnline: true }]);
    await markRobotOffline(prisma, "R-2", "sock-1");
    await markRobotOffline(prisma, "R-2", "sock-1");
    expect(prisma.rows.get("R-2").statusBeforeOffline).toBe("ACTIVE");
    await markRobotOnline(prisma, "R-2", "sock-3");
    expect(prisma.rows.get("R-2").status).toBe("ACTIVE");
  });

  test("an OFFLINE the server did not write (nothing remembered) is left OFFLINE", async () => {
    const prisma = store([{ robotId: "R-OLD", status: "OFFLINE", isOnline: false, statusBeforeOffline: null }]);
    await markRobotOnline(prisma, "R-OLD", "sock-4");
    expect(prisma.rows.get("R-OLD")).toMatchObject({ status: "OFFLINE", isOnline: true });
  });

  test("a status that moved on after the disconnect is not overwritten by the reconnect", async () => {
    const prisma = store([{ robotId: "R-3", socketId: "sock-1", status: "IDLE", isOnline: true }]);
    await markRobotOffline(prisma, "R-3", "sock-1");
    // e.g. an operator marked the unit faulty while it was away.
    Object.assign(prisma.rows.get("R-3"), { status: "ERROR" });
    await markRobotOnline(prisma, "R-3", "sock-5");
    expect(prisma.rows.get("R-3").status).toBe("ERROR");
  });
});

/**
 * Y1 — a replaced socket's late disconnect must not take the robot offline.
 *
 * A newer AUTH for the same robot writes its own socket id. The older socket's disconnect can
 * run after that, so the offline transitions are conditional on the disconnecting socket's id,
 * in the database row and in the live registry. The handler-level proof, through real AUTH and
 * a real `disconnect` event, is in `robotSessionDurability.test.js` ("Y1 —").
 */
describe("Y1 — offline only by the robot's current socket", () => {
  const { createTestKv } = require("../../helpers/testKv");
  const { markOnline, markOffline } = require("../../../src/services/robotRegistry.service");
  const registryEntry = async (kv, robotId) => JSON.parse(await kv.get(`registry:${robotId}`));

  test("A. normal disconnect: the current socket takes the robot offline", async () => {
    const prisma = store([{ robotId: "Y-A", status: "IDLE", isOnline: true, socketId: "sock-A" }]);
    expect(await markRobotOffline(prisma, "Y-A", "sock-A")).not.toBeNull();
    expect(prisma.rows.get("Y-A")).toMatchObject({ status: "OFFLINE", isOnline: false, socketId: null, statusBeforeOffline: "IDLE" });
  });

  test("B. stale disconnect after replacement: the robot stays ONLINE on socket B", async () => {
    const prisma = store([{ robotId: "Y-B", status: "IDLE", isOnline: true, socketId: "sock-A" }]);
    await markRobotOnline(prisma, "Y-B", "sock-B"); // B authenticates and replaces A

    expect(await markRobotOffline(prisma, "Y-B", "sock-A")).toBeNull();
    expect(prisma.rows.get("Y-B")).toMatchObject({ status: "IDLE", isOnline: true, socketId: "sock-B", statusBeforeOffline: null });
  });

  test("B (interleaved). B lands after A's read but before A's write: the write itself refuses", async () => {
    const prisma = store([{ robotId: "Y-I", status: "ACTIVE", isOnline: true, socketId: "sock-A" }]);
    const write = prisma.robot.updateMany;
    let replaced = false;
    prisma.robot.updateMany = async (args) => {
      if (!replaced && args.data.status === "OFFLINE") {
        replaced = true;
        await markRobotOnline(prisma, "Y-I", "sock-B"); // between A's findUnique and A's update
      }
      return write(args);
    };

    expect(await markRobotOffline(prisma, "Y-I", "sock-A")).toBeNull();
    expect(replaced).toBe(true);
    expect(prisma.rows.get("Y-I")).toMatchObject({ status: "ACTIVE", isOnline: true, socketId: "sock-B" });
  });

  test("D. the current socket B disconnecting takes the robot offline as expected", async () => {
    const prisma = store([{ robotId: "Y-D", status: "IDLE", isOnline: true, socketId: "sock-A" }]);
    await markRobotOnline(prisma, "Y-D", "sock-B");
    await markRobotOffline(prisma, "Y-D", "sock-A"); // stale: nothing
    expect(await markRobotOffline(prisma, "Y-D", "sock-B")).not.toBeNull();
    expect(prisma.rows.get("Y-D")).toMatchObject({ status: "OFFLINE", isOnline: false, socketId: null, statusBeforeOffline: "IDLE" });
    expect(robotStateCache.get("Y-D")).toMatchObject({ isOnline: false, status: "OFFLINE" });
  });

  test("E. idempotence: a repeated disconnect writes nothing more and throws nothing; no socket id writes nothing", async () => {
    const prisma = store([{ robotId: "Y-E", status: "PAUSED", isOnline: true, socketId: "sock-A" }]);
    await markRobotOffline(prisma, "Y-E", "sock-A");
    const after = { ...prisma.rows.get("Y-E") };
    await expect(markRobotOffline(prisma, "Y-E", "sock-A")).resolves.toBeNull();
    await expect(markRobotOffline(prisma, "Y-E", "sock-A")).resolves.toBeNull();
    expect(prisma.rows.get("Y-E")).toEqual(after);
    expect(after).toMatchObject({ status: "OFFLINE", statusBeforeOffline: "PAUSED" });

    const live = store([{ robotId: "Y-N", status: "IDLE", isOnline: true, socketId: "sock-A" }]);
    await expect(markRobotOffline(live, "Y-N")).resolves.toBeNull();
    await expect(markRobotOffline(live, "Y-N", "")).resolves.toBeNull();
    await expect(markRobotOffline(live, "Y-UNKNOWN", "sock-A")).resolves.toBeNull();
    expect(live.rows.get("Y-N")).toMatchObject({ status: "IDLE", isOnline: true, socketId: "sock-A" });
  });

  test("C. registry: socket A's offline leaves the entry mapped to socket B", async () => {
    const { kv } = await createTestKv();
    await markOnline(kv, "Y-RC", { id: "sock-A" });
    await markOnline(kv, "Y-RC", { id: "sock-B" }); // B replaces A

    expect(await markOffline(kv, "Y-RC", "sock-A")).toBe(false);
    expect(await registryEntry(kv, "Y-RC")).toMatchObject({ socketId: "sock-B", connected: true, authenticated: true });
  });

  test("D. registry: the current socket B's offline marks the entry disconnected", async () => {
    const { kv } = await createTestKv();
    await markOnline(kv, "Y-RD", { id: "sock-B" });

    expect(await markOffline(kv, "Y-RD", "sock-B")).toBe(true);
    expect(await registryEntry(kv, "Y-RD")).toMatchObject({ socketId: "sock-B", connected: false });
  });

  test("E. registry: repeated offline is harmless; no socket id writes nothing; an entry naming no socket is marked as before", async () => {
    const { kv } = await createTestKv();
    await markOnline(kv, "Y-RE", { id: "sock-B" });
    expect(await markOffline(kv, "Y-RE", "sock-B")).toBe(true);
    expect(await markOffline(kv, "Y-RE", "sock-B")).toBe(true);
    expect(await registryEntry(kv, "Y-RE")).toMatchObject({ socketId: "sock-B", connected: false });

    await markOnline(kv, "Y-RN", { id: "sock-B" });
    expect(await markOffline(kv, "Y-RN")).toBe(false);
    expect(await markOffline(kv, "Y-RN", "")).toBe(false);
    expect(await registryEntry(kv, "Y-RN")).toMatchObject({ connected: true });

    await kv.set("registry:Y-RL", JSON.stringify({ robotId: "Y-RL", connected: true }), { ex: 30 });
    expect(await markOffline(kv, "Y-RL", "sock-A")).toBe(true);
    expect(await registryEntry(kv, "Y-RL")).toMatchObject({ connected: false });
  });
});
