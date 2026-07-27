const { registerDtaroHandlers } = require("../../../src/sockets/handlers/dtaro.handler");
const { setRobotState, getRobotState } = require("../../../src/services/robotRegistry.service");
const { createTestKv } = require("../../helpers/testKv");
const { createFakeSocket, createFakeIo } = require("../../helpers/fakeSocket");
const { createMockPrisma } = require("../../helpers/mockPrisma");
const { waitFor } = require("../../helpers/waitFor");
const silentLogger = require("../../mocks/silentLogger");

describe("dtaro.handler — TASK_COMPLETE (task lifecycle: completion)", () => {
  let prisma;
  let kv;
  let io;
  let socket;

  beforeEach(async () => {
    prisma = createMockPrisma();
    ({ kv } = await createTestKv());
    io = createFakeIo();
    socket = createFakeSocket();
    socket.data.robotId = "R1";
    registerDtaroHandlers(io, socket, { prisma, kv, logger: silentLogger });
  });

  test("ignores TASK_COMPLETE from an unauthenticated socket (no robotId bound)", async () => {
    const anon = createFakeSocket();
    registerDtaroHandlers(io, anon, { prisma, kv, logger: console });
    anon.trigger("TASK_COMPLETE", { taskId: "TSK-1" });
    await new Promise((r) => setTimeout(r, 20));
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  test("marks the task COMPLETED, frees the robot to IDLE, and clears Redis task state", async () => {
    await kv.set("robotTaskState:R1", JSON.stringify({ taskId: "TSK-1" }), { ex: 86400 });
    await kv.set("robotTask:R1", "TSK-1", { ex: 86400 });
    await setRobotState(kv, "R1", { assignedTaskId: "TSK-1" });

    prisma.task.updateMany.mockResolvedValue({ count: 1 });
    prisma.robot.update.mockResolvedValue({});

    socket.trigger("TASK_COMPLETE", { taskId: "TSK-1" });

    await waitFor(() => prisma.$transaction.mock.calls.length > 0);
    expect(prisma.task.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ taskId: "TSK-1", robot: { robotId: "R1" }, status: { in: ["ASSIGNED", "IN_PROGRESS"] } }),
        data: { status: "COMPLETED", completedAt: expect.any(Date) },
      })
    );
    expect(prisma.robot.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { robotId: "R1" }, data: { currentTaskId: null, status: "IDLE", speed: 0 } })
    );

    await waitFor(async () => (await kv.get("robotTaskState:R1")) === null);
    expect(await kv.get("robotTask:R1")).toBeNull();
    const registry = await getRobotState(kv, "R1");
    expect(registry.assignedTaskId).toBeNull();

    expect(io.to).toHaveBeenCalledWith("dashboard");
  });

  test("acknowledges completion back to the reporting robot", async () => {
    prisma.task.updateMany.mockResolvedValue({ count: 1 });
    prisma.robot.update.mockResolvedValue({});
    socket.trigger("TASK_COMPLETE", { taskId: "TSK-1" });
    await waitFor(() => socket.sent.some((s) => s.event === "TASK_COMPLETE_ACK"));
  });
});
