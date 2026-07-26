jest.mock("../../../src/db/prisma");

const { getPrisma } = require("../../../src/db/prisma");
const { cancelTask } = require("../../../src/controllers/tasks.controller");
const { setRobotSocket, deleteRobotSocket } = require("../../../src/sockets/robotSockets");
const { setRobotState, getRobotState } = require("../../../src/services/robotRegistry.service");
const { createTestKv } = require("../../helpers/testKv");
const { createFakeIo } = require("../../helpers/fakeSocket");
const { waitFor } = require("../../helpers/waitFor");

function makeRes() {
  const res = { body: null, statusCode: 200 };
  res.status = jest.fn((c) => { res.statusCode = c; return res; });
  res.json = jest.fn((b) => { res.body = b; return res; });
  return res;
}

// `cancelTask` is wrapped in `asyncHandler`, which fires the async work and
// forwards any rejection to Express's `next(err)` — it does not itself
// return a promise the caller can await. Tests drive it the same way Express
// would: call it with a jest.fn() `next`, then poll for either `res.json` or
// `next` having been invoked.
describe("tasks.controller — cancelTask (F27: cancel must stop the robot + clean up Redis)", () => {
  let prisma;
  let kv;
  let io;
  let fakeRobotSocket;

  beforeEach(async () => {
    prisma = {
      task: { findUnique: jest.fn(), update: jest.fn() },
      robot: { findUnique: jest.fn(), update: jest.fn() },
      $transaction: jest.fn(async (fn) => fn(prisma)),
    };
    getPrisma.mockReturnValue(prisma);
    ({ kv } = await createTestKv());
    io = createFakeIo();
    fakeRobotSocket = { id: "sock-1", emit: jest.fn() };
  });

  afterEach(() => {
    deleteRobotSocket("R1", fakeRobotSocket);
  });

  test("400s when taskId param is missing", async () => {
    const req = { params: {}, app: { locals: { kv, io } } };
    const res = makeRes();
    const next = jest.fn();
    cancelTask(req, res, next);
    await waitFor(() => next.mock.calls.length > 0);
    expect(next.mock.calls[0][0]).toMatchObject({ status: 400 });
  });

  test("404s for an unknown taskId", async () => {
    prisma.task.findUnique.mockResolvedValue(null);
    const req = { params: { taskId: "NOPE" }, app: { locals: { kv, io } } };
    const res = makeRes();
    const next = jest.fn();
    cancelTask(req, res, next);
    await waitFor(() => next.mock.calls.length > 0);
    expect(next.mock.calls[0][0]).toMatchObject({ status: 404 });
  });

  test("is a no-op (200, unchanged) for an already-terminal task", async () => {
    prisma.task.findUnique
      .mockResolvedValueOnce({ id: "db-1", status: "COMPLETED", robotId: "robot-db-1" })
      .mockResolvedValueOnce({ taskId: "TSK-1", status: "COMPLETED", robot: { robotId: "R1" } });
    const req = { params: { taskId: "TSK-1" }, app: { locals: { kv, io } } };
    const res = makeRes();
    cancelTask(req, res, jest.fn());
    await waitFor(() => res.json.mock.calls.length > 0);
    expect(res.body.task.status).toBe("COMPLETED");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  test("cancels an ASSIGNED task: frees the robot, emits STOP to its socket, and clears Redis task state", async () => {
    setRobotSocket("R1", fakeRobotSocket);
    await setRobotState(kv, "R1", { assignedTaskId: "TSK-1" });
    await kv.set("taskPath:TSK-1", JSON.stringify({ toPickup: [], toDrop: [] }), { ex: 86400 });
    await kv.set("robotTaskState:R1", JSON.stringify({ taskId: "TSK-1" }), { ex: 86400 });
    await kv.set("robotTask:R1", "TSK-1", { ex: 86400 });

    prisma.task.findUnique.mockResolvedValueOnce({ id: "db-task-1", status: "ASSIGNED", robotId: "db-robot-1" });
    prisma.robot.findUnique.mockResolvedValue({ id: "db-robot-1", robotId: "R1", currentTaskId: "db-task-1" });
    prisma.task.update.mockResolvedValue({ taskId: "TSK-1", status: "CANCELLED", robot: { robotId: "R1" } });

    const req = { params: { taskId: "TSK-1" }, app: { locals: { kv, io } } };
    const res = makeRes();
    cancelTask(req, res, jest.fn());
    await waitFor(() => res.json.mock.calls.length > 0);

    // Robot released back to IDLE in the DB.
    expect(prisma.robot.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "db-robot-1" }, data: { currentTaskId: null, status: "IDLE" } })
    );

    // The robot's socket must be told to stop driving toward the cancelled task.
    expect(fakeRobotSocket.emit).toHaveBeenCalledWith("STOP", expect.objectContaining({ taskId: "TSK-1", reason: "TASK_CANCELLED" }));

    // Redis runtime state for this task/robot must not survive cancellation.
    await waitFor(async () => (await kv.get("taskPath:TSK-1")) === null);
    expect(await kv.get("robotTaskState:R1")).toBeNull();
    expect(await kv.get("robotTask:R1")).toBeNull();
    const registryState = await getRobotState(kv, "R1");
    expect(registryState.assignedTaskId).toBeNull();

    // Dashboard is notified.
    expect(io.to).toHaveBeenCalledWith("dashboard");
    expect(res.body.ok).toBe(true);
  });

  test("does not touch the robot when its currentTaskId no longer points at the cancelled task (already reassigned)", async () => {
    prisma.task.findUnique.mockResolvedValueOnce({ id: "db-task-1", status: "ASSIGNED", robotId: "db-robot-1" });
    // Robot has since moved on to a different task.
    prisma.robot.findUnique.mockResolvedValue({ id: "db-robot-1", robotId: "R1", currentTaskId: "some-other-task-db-id" });
    prisma.task.update.mockResolvedValue({ taskId: "TSK-1", status: "CANCELLED", robot: { robotId: "R1" } });

    const req = { params: { taskId: "TSK-1" }, app: { locals: { kv, io } } };
    const res = makeRes();
    cancelTask(req, res, jest.fn());
    await waitFor(() => res.json.mock.calls.length > 0);

    expect(prisma.robot.update).not.toHaveBeenCalled();
  });
});
