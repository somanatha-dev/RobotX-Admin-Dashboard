jest.mock("../../../src/services/task.service", () => ({
  getRoutesWithDistance: jest.fn(),
}));

const { getRoutesWithDistance } = require("../../../src/services/task.service");
const { recoverActiveTasks } = require("../../../src/services/taskRecovery.service");
const { createMockPrisma } = require("../../helpers/mockPrisma");
const { createTestKv } = require("../../helpers/testKv");
const silentLogger = require("../../mocks/silentLogger");

const ROUTE = { toPickup: [{ lat: 1, lon: 1 }], toDrop: [{ lat: 2, lon: 2 }], distanceMeters: 500, usedFallback: false };

describe("taskRecovery.service — recoverActiveTasks (restart recovery)", () => {
  let prisma;
  let kv;

  beforeEach(async () => {
    prisma = createMockPrisma();
    ({ kv } = await createTestKv());
    getRoutesWithDistance.mockResolvedValue(ROUTE);
  });

  test("returns { recovered: 0 } when prisma or kv is missing", async () => {
    expect(await recoverActiveTasks(null, kv, null)).toEqual({ recovered: 0 });
    expect(await recoverActiveTasks(prisma, null, null)).toEqual({ recovered: 0 });
  });

  test("queries only ASSIGNED/IN_PROGRESS tasks", async () => {
    prisma.task.findMany.mockResolvedValue([]);
    await recoverActiveTasks(prisma, kv, null);
    expect(prisma.task.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: { in: ["ASSIGNED", "IN_PROGRESS"] } } })
    );
  });

  test("rebuilds taskPath/robotTask/robotTaskState Redis keys for each recovered task", async () => {
    prisma.task.findMany.mockResolvedValue([
      {
        taskId: "TSK-1",
        pickupLat: 1, pickupLon: 1, dropLat: 2, dropLon: 2,
        startedAt: null,
        robot: { robotId: "R1", lat: 1.5, lon: 1.5 },
      },
    ]);

    const result = await recoverActiveTasks(prisma, kv, null);
    expect(result.recovered).toBe(1);

    const path = JSON.parse(await kv.get("taskPath:TSK-1"));
    expect(path.toPickup).toEqual(ROUTE.toPickup);
    expect(await kv.get("robotTask:R1")).toBe("TSK-1");
    const state = JSON.parse(await kv.get("robotTaskState:R1"));
    expect(state).toMatchObject({ taskId: "TSK-1", phase: "TO_PICKUP", pathIndex: 0 });
  });

  test("prefers the robot's live Redis position over its DB position as the route start", async () => {
    prisma.task.findMany.mockResolvedValue([
      {
        taskId: "TSK-2",
        pickupLat: 1, pickupLon: 1, dropLat: 2, dropLon: 2,
        startedAt: null,
        robot: { robotId: "R2", lat: 99, lon: 99 }, // stale DB position
      },
    ]);
    await kv.set("robot:R2", JSON.stringify({ lat: 5, lon: 5 }), { ex: 15 });

    await recoverActiveTasks(prisma, kv, null);
    expect(getRoutesWithDistance).toHaveBeenCalledWith(
      expect.objectContaining({ from: { lat: 5, lon: 5 } })
    );
  });

  test("skips a task with no robot assigned, without throwing", async () => {
    prisma.task.findMany.mockResolvedValue([
      { taskId: "TSK-3", pickupLat: 1, pickupLon: 1, dropLat: 2, dropLon: 2, startedAt: null, robot: null },
    ]);
    const result = await recoverActiveTasks(prisma, kv, null);
    expect(result.recovered).toBe(0);
  });

  test("continues past one task's route-generation failure and still recovers the others", async () => {
    prisma.task.findMany.mockResolvedValue([
      { taskId: "TSK-FAIL", pickupLat: 1, pickupLon: 1, dropLat: 2, dropLon: 2, startedAt: null, robot: { robotId: "RF", lat: 1, lon: 1 } },
      { taskId: "TSK-OK", pickupLat: 1, pickupLon: 1, dropLat: 2, dropLon: 2, startedAt: null, robot: { robotId: "RO", lat: 1, lon: 1 } },
    ]);
    getRoutesWithDistance
      .mockRejectedValueOnce(new Error("Mapbox + fallback both down"))
      .mockResolvedValueOnce(ROUTE);

    const result = await recoverActiveTasks(prisma, kv, null, { logger: silentLogger });
    expect(result.recovered).toBe(1);
    expect(await kv.get("taskPath:TSK-FAIL")).toBeNull();
    expect(await kv.get("taskPath:TSK-OK")).not.toBeNull();
  });
});
