jest.mock("../../../src/db/prisma");

const { getPrisma } = require("../../../src/db/prisma");
const { cancelTask } = require("../../../src/controllers/tasks.controller");
const { createTestKv } = require("../../helpers/testKv");
const { createFakeIo } = require("../../helpers/fakeSocket");
const { waitFor } = require("../../helpers/waitFor");

// P1.4 — the dashboard's Cancel never reached the assignment engine. It wrote
// `Task.status = CANCELLED` and nothing else; the engine does not read that column, and
// measured live two cancelled tasks were still committed, delivered, verified and SETTLED
// while the dashboard showed them cancelled. §4.6's cancellation has no resolution wired
// for any Leg state, so a task the engine manages is refused — and nothing is written.
describe("tasks.controller — cancelTask on an engine-managed task (P1.4)", () => {
  let prisma;
  let kv;
  let io;

  function makeRes() {
    const res = { body: null, statusCode: 200 };
    res.status = jest.fn((c) => { res.statusCode = c; return res; });
    res.json = jest.fn((b) => { res.body = b; return res; });
    return res;
  }

  beforeEach(async () => {
    prisma = {
      task: { findUnique: jest.fn(), update: jest.fn() },
      leg: { findFirst: jest.fn() },
      robot: { findUnique: jest.fn(), update: jest.fn() },
      $transaction: jest.fn(async (fn) => fn(prisma)),
    };
    getPrisma.mockReturnValue(prisma);
    ({ kv } = await createTestKv());
    io = createFakeIo();
  });

  for (const legState of ["QUEUED", "OFFERED", "EN_ROUTE_PICKUP", "LOADED"]) {
    test(`a task whose Leg is ${legState} is refused with 409 and nothing is written`, async () => {
      prisma.task.findUnique.mockResolvedValueOnce({ id: "db-task-1", status: "PENDING", robotId: null });
      prisma.leg.findFirst.mockResolvedValueOnce({ state: legState });
      const res = makeRes();
      cancelTask({ params: { taskId: "TSK-1" }, app: { locals: { kv, io } } }, res, jest.fn());
      await waitFor(() => res.json.mock.calls.length > 0);

      expect(res.statusCode).toBe(409);
      expect(res.body).toMatchObject({ ok: false, code: "ENGINE_CANCELLATION_UNAVAILABLE" });
      // The dashboard's request client shows `message` to the operator.
      expect(res.body.message).toMatch(/managed by the assignment engine/);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.task.update).not.toHaveBeenCalled();
      expect(prisma.robot.update).not.toHaveBeenCalled();
      expect(prisma.leg.findFirst.mock.calls[0][0].where).toEqual({ mission: { tasks: { some: { id: "db-task-1" } } } });
    });
  }

  test("a task with no engine Leg (legacy) still cancels as before", async () => {
    prisma.task.findUnique
      .mockResolvedValueOnce({ id: "db-task-2", status: "PENDING", robotId: null })
      .mockResolvedValueOnce({ taskId: "TSK-2", status: "CANCELLED", robot: null });
    prisma.leg.findFirst.mockResolvedValueOnce(null);
    prisma.task.update.mockResolvedValueOnce({ taskId: "TSK-2", status: "CANCELLED", robot: null });
    const res = makeRes();
    cancelTask({ params: { taskId: "TSK-2" }, app: { locals: { kv, io } } }, res, jest.fn());
    await waitFor(() => res.json.mock.calls.length > 0);

    expect(res.statusCode).toBe(200);
    expect(prisma.task.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "CANCELLED" } }));
  });

  test("an already-terminal task is still a 200 no-op, before any Leg lookup", async () => {
    prisma.task.findUnique
      .mockResolvedValueOnce({ id: "db-task-3", status: "COMPLETED", robotId: null })
      .mockResolvedValueOnce({ taskId: "TSK-3", status: "COMPLETED", robot: null });
    const res = makeRes();
    cancelTask({ params: { taskId: "TSK-3" }, app: { locals: { kv, io } } }, res, jest.fn());
    await waitFor(() => res.json.mock.calls.length > 0);

    expect(res.statusCode).toBe(200);
    expect(prisma.leg.findFirst).not.toHaveBeenCalled();
  });
});
