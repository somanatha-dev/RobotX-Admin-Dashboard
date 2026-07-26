jest.mock("../../../src/services/mapbox.service");
jest.mock("../../../src/services/zoneManager.service");

const { matrixDurationsToDestination } = require("../../../src/services/mapbox.service");
const { getZoneForCoordinates } = require("../../../src/services/zoneManager.service");
const { selectNearestRobot } = require("../../../src/services/taskAssignment.service");
const { setRobotState } = require("../../../src/services/robotRegistry.service");
const { createMockPrisma } = require("../../helpers/mockPrisma");
const { createTestKv } = require("../../helpers/testKv");

describe("taskAssignment.service — selectNearestRobot (DTARO candidate pipeline)", () => {
  let prisma;
  let kv;

  beforeEach(async () => {
    prisma = createMockPrisma();
    ({ kv } = await createTestKv());
    getZoneForCoordinates.mockResolvedValue(null);
    // Default: Matrix succeeds with a flat duration for every origin.
    matrixDurationsToDestination.mockImplementation(async ({ origins }) => origins.map(() => 120));
  });

  test("throws 409 when no IDLE/PAUSED robots exist in the DB at all", async () => {
    prisma.robot.findMany.mockResolvedValue([]);
    await expect(
      selectNearestRobot({ prisma, kv, pickup: { lat: 1, lon: 1 } })
    ).rejects.toMatchObject({ status: 409, message: "No available IDLE robots" });
  });

  test("throws 409 when every DB candidate fails validation", async () => {
    prisma.robot.findMany.mockResolvedValue([
      { robotId: "LOW_BATTERY", lat: 1, lon: 1, battery: 5, currentTaskId: null, isOnline: true, status: "IDLE", zoneId: null },
    ]);
    await expect(
      selectNearestRobot({ prisma, kv, pickup: { lat: 1, lon: 1 } })
    ).rejects.toMatchObject({ status: 409, message: "No robots passed eligibility validation" });
  });

  test("selects the minimum-cost robot among multiple eligible candidates", async () => {
    prisma.robot.findMany.mockResolvedValue([
      { robotId: "NEAR", lat: 1.0001, lon: 1.0001, battery: 90, currentTaskId: null, isOnline: true, status: "IDLE", zoneId: null },
      { robotId: "FAR", lat: 5, lon: 5, battery: 90, currentTaskId: null, isOnline: true, status: "IDLE", zoneId: null },
    ]);
    await setRobotState(kv, "NEAR", { battery: 90, utilization: 0 });
    await setRobotState(kv, "FAR", { battery: 90, utilization: 0 });

    const result = await selectNearestRobot({ prisma, kv, pickup: { lat: 1, lon: 1 } });
    expect(result.robotId).toBe("NEAR");
    expect(result.cost).toBeDefined();
    expect(result.costComponents).toBeDefined();
  });

  test("excludeRobotIds removes a robot from DB candidate selection (F4 retry loop support)", async () => {
    prisma.robot.findMany.mockImplementation(async ({ where }) => {
      const excluded = where?.robotId?.notIn || [];
      const all = [
        { robotId: "R1", lat: 1, lon: 1, battery: 90, currentTaskId: null, isOnline: true, status: "IDLE", zoneId: null },
        { robotId: "R2", lat: 1, lon: 1, battery: 90, currentTaskId: null, isOnline: true, status: "IDLE", zoneId: null },
      ];
      return all.filter((r) => !excluded.includes(r.robotId));
    });
    await setRobotState(kv, "R1", { battery: 90, utilization: 0 });
    await setRobotState(kv, "R2", { battery: 90, utilization: 0 });

    const result = await selectNearestRobot({
      prisma, kv,
      pickup: { lat: 1, lon: 1 },
      excludeRobotIds: ["R1"],
    });
    expect(result.robotId).toBe("R2");
  });

  test("falls back to haversine distance when the Mapbox Matrix call throws (usedFallback=true)", async () => {
    matrixDurationsToDestination.mockRejectedValue(new Error("Mapbox down"));
    prisma.robot.findMany.mockResolvedValue([
      { robotId: "R1", lat: 1.001, lon: 1.001, battery: 90, currentTaskId: null, isOnline: true, status: "IDLE", zoneId: null },
    ]);
    await setRobotState(kv, "R1", { battery: 90, utilization: 0 });

    const result = await selectNearestRobot({ prisma, kv, pickup: { lat: 1, lon: 1 } });
    expect(result.robotId).toBe("R1");
    expect(result.usedFallback).toBe(true);
    // NOTE (characterization, not a spec assertion): costEvaluator.service.js
    // internally defaults a null durationSec to 0 for the T-normalization
    // array, then echoes that same 0 back out on its per-candidate result
    // object — so a total Matrix failure surfaces here as `durationSec: 0`,
    // not `null` as one might expect from "no travel-time data available".
    // Low practical impact (task.service.js never consumes this field), but
    // worth a maintainer's attention if `durationSec` is ever surfaced to
    // an operator or used in a health check.
    expect(result.durationSec).toBe(0);
  });

  test("overlays live Redis position over stale DB position", async () => {
    prisma.robot.findMany.mockResolvedValue([
      { robotId: "R1", lat: 50, lon: 50, battery: 90, currentTaskId: null, isOnline: true, status: "IDLE", zoneId: null },
    ]);
    // Live registry says the robot has actually moved to (1,1) — near the pickup.
    await setRobotState(kv, "R1", { battery: 90, utilization: 0, lat: 1, lon: 1 });

    const result = await selectNearestRobot({ prisma, kv, pickup: { lat: 1, lon: 1 } });
    expect(result.start).toEqual({ lat: 1, lon: 1 });
  });

  test("rejects pickup coordinates that are not numbers", async () => {
    await expect(
      selectNearestRobot({ prisma, kv, pickup: { lat: "not-a-number", lon: 1 } })
    ).rejects.toMatchObject({ status: 400 });
  });

  test("throws when kv is not provided", async () => {
    await expect(
      selectNearestRobot({ prisma, kv: null, pickup: { lat: 1, lon: 1 } })
    ).rejects.toMatchObject({ status: 503 });
  });

  test("PAUSED (charging) robots are queried alongside IDLE for candidate pool", async () => {
    await selectNearestRobot({ prisma, kv, pickup: { lat: 1, lon: 1 } }).catch(() => {});
    expect(prisma.robot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: { in: ["IDLE", "PAUSED"] } }),
      })
    );
  });
});
