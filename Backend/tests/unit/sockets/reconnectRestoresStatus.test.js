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
    const prisma = store([{ robotId: "V1DEMO-01", status: "IDLE", isOnline: true }]);
    await markRobotOffline(prisma, "V1DEMO-01");
    expect(prisma.rows.get("V1DEMO-01")).toMatchObject({ status: "OFFLINE", isOnline: false, statusBeforeOffline: "IDLE" });

    const row = await markRobotOnline(prisma, "V1DEMO-01", "sock-2");
    expect(row).toMatchObject({ status: "IDLE", isOnline: true });
    expect(prisma.rows.get("V1DEMO-01")).toMatchObject({ status: "IDLE", isOnline: true, statusBeforeOffline: null, socketId: "sock-2" });
    expect(robotStateCache.get("V1DEMO-01")).toMatchObject({ status: "IDLE" });
  });

  test("a fault is never laundered: ERROR → disconnect → AUTH → ERROR", async () => {
    const prisma = store([{ robotId: "R-ERR", status: "ERROR", isOnline: true }]);
    await markRobotOffline(prisma, "R-ERR");
    await markRobotOnline(prisma, "R-ERR", "sock-2");
    expect(prisma.rows.get("R-ERR").status).toBe("ERROR");
  });

  test("an operator hold is never lifted: PAUSED → disconnect → AUTH → PAUSED", async () => {
    const prisma = store([{ robotId: "R-P", status: "PAUSED", isOnline: true }]);
    await markRobotOffline(prisma, "R-P");
    await markRobotOnline(prisma, "R-P", "sock-2");
    expect(prisma.rows.get("R-P").status).toBe("PAUSED");
  });

  test("a second disconnect keeps the status first replaced, not OFFLINE", async () => {
    const prisma = store([{ robotId: "R-2", status: "ACTIVE", isOnline: true }]);
    await markRobotOffline(prisma, "R-2");
    await markRobotOffline(prisma, "R-2");
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
    const prisma = store([{ robotId: "R-3", status: "IDLE", isOnline: true }]);
    await markRobotOffline(prisma, "R-3");
    // e.g. an operator marked the unit faulty while it was away.
    Object.assign(prisma.rows.get("R-3"), { status: "ERROR" });
    await markRobotOnline(prisma, "R-3", "sock-5");
    expect(prisma.rows.get("R-3").status).toBe("ERROR");
  });
});
