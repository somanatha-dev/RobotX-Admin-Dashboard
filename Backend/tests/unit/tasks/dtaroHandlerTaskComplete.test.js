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
    // §2.4 — the handler resolves the identifier the agent reported to a `Task.taskId`
    // before acting on it, because an agent may report the `Leg` it was offered instead.
    // A completion is about a Task that exists, so the fake client says so; without this
    // the resolver would find no Task, fall through to the Leg lookup, and these tests
    // would be asserting the behaviour of an unresolvable identifier.
    prisma.task.findUnique.mockResolvedValue({ taskId: "TSK-1" });
    registerDtaroHandlers(io, socket, { prisma, kv, logger: silentLogger });
  });

  test("ignores TASK_COMPLETE from an unauthenticated socket (no robotId bound)", async () => {
    const anon = createFakeSocket();
    registerDtaroHandlers(io, anon, { prisma, kv, logger: console });
    anon.trigger("TASK_COMPLETE", { taskId: "TSK-1" });
    await new Promise((r) => setTimeout(r, 20));
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  // P2B-2 — these two tests used to assert that a claim with no engine, no commitment and no
  // thresholds completed the Task and freed the robot: completion on the agent's word alone.
  // That path is closed. The same claim is now held for operator verification, and nothing
  // about the Task, the robot or its Redis task state is touched. The graded paths are
  // covered by `taskCompleteVerification.test.js`.
  test("an ungradable claim does NOT mark the task COMPLETED, free the robot, or clear its task state", async () => {
    await kv.set("robotTaskState:R1", JSON.stringify({ taskId: "TSK-1" }), { ex: 86400 });
    await kv.set("robotTask:R1", "TSK-1", { ex: 86400 });
    await setRobotState(kv, "R1", { assignedTaskId: "TSK-1" });

    prisma.task.updateMany.mockResolvedValue({ count: 1 });
    prisma.robot.update.mockResolvedValue({});

    socket.trigger("TASK_COMPLETE", { taskId: "TSK-1" });

    await waitFor(() => socket.sent.some((s) => s.event === "TASK_COMPLETE_ACK"));
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.task.updateMany).not.toHaveBeenCalled();
    expect(prisma.robot.update).not.toHaveBeenCalled();

    expect(await kv.get("robotTaskState:R1")).not.toBeNull();
    expect(await kv.get("robotTask:R1")).toBe("TSK-1");
    const registry = await getRobotState(kv, "R1");
    expect(registry.assignedTaskId).toBe("TSK-1");

    expect(io.to).toHaveBeenCalledWith("dashboard");
  });

  test("acknowledges the claim back to the robot as being verified, with the reason", async () => {
    socket.trigger("TASK_COMPLETE", { taskId: "TSK-1" });
    await waitFor(() => socket.sent.some((s) => s.event === "TASK_COMPLETE_ACK"));
    const ack = socket.sent.find((s) => s.event === "TASK_COMPLETE_ACK").payload;
    expect(ack).toMatchObject({ taskId: "TSK-1", verifying: true, reason: "ENGINE_GATE_CLOSED" });
  });
});
