jest.mock("../../../src/services/taskAssignment.service");
jest.mock("../../../src/services/mapbox.service");
jest.mock("../../../src/services/commandDispatcher.service");
jest.mock("../../../src/services/metrics.service");

const { selectNearestRobot } = require("../../../src/services/taskAssignment.service");
const { directionsWithDistance } = require("../../../src/services/mapbox.service");
const { dispatchTaskAssign } = require("../../../src/services/commandDispatcher.service");
const { recordAllocation } = require("../../../src/services/metrics.service");
const { assignTask } = require("../../../src/services/task.service");
const { createMockPrisma } = require("../../helpers/mockPrisma");
const { createTestKv } = require("../../helpers/testKv");
const { createFakeIo } = require("../../helpers/fakeSocket");
const { waitFor } = require("../../helpers/waitFor");

const ROUTE = { points: [{ lat: 1, lon: 1 }, { lat: 2, lon: 2 }], distanceMeters: 1000, durationSec: 100 };

function pendingTaskRow(taskId) {
  return { id: "db-id-1", taskId, status: "PENDING", robot: null };
}

describe("task.service — assignTask (DTARO end-to-end assignment)", () => {
  let prisma;
  let kv;
  let io;

  beforeEach(async () => {
    prisma = createMockPrisma();
    ({ kv } = await createTestKv());
    io = createFakeIo();
    directionsWithDistance.mockResolvedValue(ROUTE);
    dispatchTaskAssign.mockResolvedValue({ dispatched: true });
  });

  const basePayload = {
    pickup: "Building A", drop: "Building B",
    pickupLat: 1, pickupLon: 1, dropLat: 2, dropLon: 2,
  };

  test("returns a PENDING task immediately, before any DTARO/Mapbox work happens", async () => {
    prisma.task.create.mockResolvedValue(pendingTaskRow("TSK-1"));
    selectNearestRobot.mockImplementation(() => new Promise(() => {})); // never resolves

    const result = await assignTask(prisma, basePayload, { kv, io });
    expect(result.status).toBe("PENDING");
    expect(prisma.task.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "PENDING" }) })
    );
  });

  test("emits TASK_CREATED to the dashboard room synchronously", async () => {
    prisma.task.create.mockResolvedValue(pendingTaskRow("TSK-1"));
    selectNearestRobot.mockImplementation(() => new Promise(() => {}));

    await assignTask(prisma, basePayload, { kv, io });
    expect(io.to).toHaveBeenCalledWith("dashboard");
  });

  test("auto-assigns the DTARO-selected robot, records real (non-null) allocation cost, and dispatches TASK_ASSIGN", async () => {
    prisma.task.create.mockResolvedValue(pendingTaskRow("TSK-1"));
    prisma.robot.findUnique.mockResolvedValue({ id: "robot-db-1", status: "IDLE", currentTaskId: null, lat: 1, lon: 1, isOnline: true });
    prisma.$transaction.mockImplementation(async (fn) => {
      // tx.robot.findUnique (re-check) then task.update then robot.update
      const tx = {
        robot: { findUnique: jest.fn().mockResolvedValue({ status: "IDLE", currentTaskId: null }), update: jest.fn().mockResolvedValue({}) },
        task: { update: jest.fn().mockResolvedValue({ taskId: "TSK-1", status: "ASSIGNED", robot: { robotId: "R1" } }) },
      };
      return fn(tx);
    });

    selectNearestRobot.mockResolvedValue({
      robotId: "R1", durationSec: 100, start: { lat: 1, lon: 1 },
      cost: 0.42, costComponents: { D: 0.1, B: 0.2, U: 0.05, T: 0.05, Z: 0.02 },
    });

    await assignTask(prisma, { ...basePayload, taskId: "TSK-1" }, { kv, io });

    await waitFor(() => prisma.$transaction.mock.calls.length > 0);
    expect(dispatchTaskAssign).toHaveBeenCalledWith("R1", expect.objectContaining({ taskId: "TSK-1" }));

    // F8 — allocation metrics must carry the real computed cost, not null,
    // for an auto-assigned (DTARO-selected) task.
    await waitFor(() => recordAllocation.mock.calls.length > 0);
    expect(recordAllocation).toHaveBeenCalledWith(
      kv,
      expect.objectContaining({ robotId: "R1", cost: 0.42, costComponents: expect.any(Object) })
    );
  });

  test("F4 retry: when the top DTARO candidate's reservation is already held, retries with that robot excluded", async () => {
    prisma.task.create.mockResolvedValue(pendingTaskRow("TSK-2"));
    prisma.robot.findUnique.mockResolvedValue({ id: "robot-db-2", status: "IDLE", currentTaskId: null, lat: 1, lon: 1, isOnline: true });
    prisma.$transaction.mockImplementation(async (fn) => fn({
      robot: { findUnique: jest.fn().mockResolvedValue({ status: "IDLE", currentTaskId: null }), update: jest.fn().mockResolvedValue({}) },
      task: { update: jest.fn().mockResolvedValue({ taskId: "TSK-2", status: "ASSIGNED", robot: { robotId: "R2" } }) },
    }));

    // Simulate a concurrent process already holding R1's reservation.
    await kv.reserveRobot("robotReserve:R1", "some-other-task", 30);

    selectNearestRobot.mockImplementation(async ({ excludeRobotIds = [] }) => {
      if (!excludeRobotIds.includes("R1")) return { robotId: "R1", durationSec: 50, start: { lat: 1, lon: 1 }, cost: 0.1, costComponents: {} };
      return { robotId: "R2", durationSec: 60, start: { lat: 1, lon: 1 }, cost: 0.2, costComponents: {} };
    });

    await assignTask(prisma, { ...basePayload, taskId: "TSK-2" }, { kv, io });
    await waitFor(() => prisma.$transaction.mock.calls.length > 0);

    expect(selectNearestRobot).toHaveBeenCalledTimes(2);
    expect(dispatchTaskAssign).toHaveBeenCalledWith("R2", expect.anything());
  });

  test("marks the task FAILED when every DTARO candidate is claimed concurrently (all retries exhausted)", async () => {
    prisma.task.create.mockResolvedValue(pendingTaskRow("TSK-3"));
    selectNearestRobot.mockResolvedValue({ robotId: "ALWAYS_TAKEN", durationSec: 10, start: { lat: 1, lon: 1 } });
    // Pre-claim every candidate this mock could ever return.
    await kv.reserveRobot("robotReserve:ALWAYS_TAKEN", "someone-else", 30);

    await assignTask(prisma, { ...basePayload, taskId: "TSK-3" }, { kv, io });

    await waitFor(() => prisma.task.update.mock.calls.length > 0);
    expect(prisma.task.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { taskId: "TSK-3" }, data: { status: "FAILED" } })
    );
  });

  test("manual robotCodeIn assignment reserves the exact requested robot and skips DTARO selection", async () => {
    prisma.task.create.mockResolvedValue({ ...pendingTaskRow("TSK-4"), robot: null });
    prisma.robot.findUnique.mockResolvedValue({ id: "robot-db-4", status: "IDLE", currentTaskId: null, lat: 1, lon: 1, isOnline: true });
    prisma.$transaction.mockImplementation(async (fn) => fn({
      robot: { findUnique: jest.fn().mockResolvedValue({ status: "IDLE", currentTaskId: null }), update: jest.fn().mockResolvedValue({}) },
      task: { update: jest.fn().mockResolvedValue({ taskId: "TSK-4", status: "ASSIGNED", robot: { robotId: "R9" } }) },
    }));

    await assignTask(prisma, { ...basePayload, taskId: "TSK-4", robotId: "R9" }, { kv, io });
    await waitFor(() => prisma.$transaction.mock.calls.length > 0);

    expect(selectNearestRobot).not.toHaveBeenCalled();
    expect(dispatchTaskAssign).toHaveBeenCalledWith("R9", expect.anything());

    // A manual pick has no DTARO cost computation behind it — recorded as
    // null by design (not a bug), per PHASE1_VERIFICATION.md's F8 caveat.
    await waitFor(() => recordAllocation.mock.calls.length > 0);
    expect(recordAllocation).toHaveBeenCalledWith(kv, expect.objectContaining({ robotId: "R9", cost: null }));
  });

  test("throws synchronously (before the background phase) when pickup/drop text is missing", async () => {
    await expect(assignTask(prisma, { pickupLat: 1, pickupLon: 1, dropLat: 2, dropLon: 2 }, { kv, io }))
      .rejects.toMatchObject({ status: 400 });
  });

  test("throws synchronously when a coordinate is missing", async () => {
    await expect(assignTask(prisma, { pickup: "A", drop: "B" }, { kv, io }))
      .rejects.toMatchObject({ status: 400 });
  });
});
