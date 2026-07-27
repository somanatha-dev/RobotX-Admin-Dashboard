jest.mock("../../../src/db/prisma");

const { getPrisma } = require("../../../src/db/prisma");
const { sendRobotCommand } = require("../../../src/controllers/robots.controller");
const { setRobotSocket, deleteRobotSocket } = require("../../../src/sockets/robotSockets");
const { createTestKv } = require("../../helpers/testKv");
const { createFakeIo } = require("../../helpers/fakeSocket");
const { waitFor } = require("../../helpers/waitFor");

function makeRes() {
  const res = { body: null, statusCode: 200 };
  res.status = jest.fn((c) => { res.statusCode = c; return res; });
  res.json = jest.fn((b) => { res.body = b; return res; });
  return res;
}

// POST /api/robots/:robotId/command used to emit through the process-local
// robotId->socket Map. Under clustering that silently dropped every command
// for a robot whose connection is owned by another worker: the Command row
// went to FAILED 15s later with nothing in the logs to explain why. It must
// go through the robot's Socket.IO room like every other robot-bound message.

describe("robots.controller — sendRobotCommand (worker-safe dispatch)", () => {
  let prisma;
  let kv;
  let io;
  let strandedSocket;

  beforeEach(async () => {
    prisma = {
      robot: { findUnique: jest.fn().mockResolvedValue({ id: "db-robot-1" }) },
      command: { create: jest.fn().mockResolvedValue({ id: "cmd-1", type: "STOP" }), findUnique: jest.fn(), update: jest.fn() },
    };
    getPrisma.mockReturnValue(prisma);
    ({ kv } = await createTestKv());
    io = createFakeIo();
    strandedSocket = { id: "local-sock", emit: jest.fn() };
  });

  afterEach(() => {
    deleteRobotSocket("R1", strandedSocket);
    jest.clearAllTimers();
  });

  function call(body = { type: "STOP" }, robotId = "R1") {
    const req = { params: { robotId }, body, app: { locals: { kv, io } } };
    const res = makeRes();
    sendRobotCommand(req, res, jest.fn());
    return res;
  }

  test("dispatches COMMAND into the robot's room, carrying the persisted Command row id", async () => {
    io.joinRoom("robot:R1", { id: "sock-owned-by-any-worker" });

    const res = call({ type: "STOP" });
    await waitFor(() => res.json.mock.calls.length > 0);

    const [command] = io.emittedTo("robot:R1", "COMMAND");
    expect(command).toMatchObject({ commandId: "cmd-1", type: "STOP" });
    expect(res.body).toMatchObject({ ok: true, delivered: true });
  });

  test("does NOT reach for the process-local socket map", async () => {
    // A socket registered locally but absent from the room must not be used:
    // that is precisely the path that broke under clustering.
    setRobotSocket("R1", strandedSocket);

    const res = call({ type: "PAUSE" });
    await waitFor(() => res.json.mock.calls.length > 0);

    expect(strandedSocket.emit).not.toHaveBeenCalled();
  });

  test("reports delivered:false when the robot's room is empty, and still persists the Command", async () => {
    const res = call({ type: "RETURN" });
    await waitFor(() => res.json.mock.calls.length > 0);

    expect(prisma.command.create).toHaveBeenCalled();
    expect(res.body).toMatchObject({ ok: true, delivered: false });
  });

  test("rejects a command type outside the Prisma CommandType enum", async () => {
    const req = { params: { robotId: "R1" }, body: { type: "LAUNCH" }, app: { locals: { kv, io } } };
    const res = makeRes();
    const next = jest.fn();
    sendRobotCommand(req, res, next);

    await waitFor(() => next.mock.calls.length > 0);
    expect(next.mock.calls[0][0]).toMatchObject({ status: 400 });
    expect(prisma.command.create).not.toHaveBeenCalled();
  });

  test("404s for an unknown robot before creating a Command row", async () => {
    prisma.robot.findUnique.mockResolvedValue(null);
    const req = { params: { robotId: "NOPE" }, body: { type: "STOP" }, app: { locals: { kv, io } } };
    const res = makeRes();
    const next = jest.fn();
    sendRobotCommand(req, res, next);

    await waitFor(() => next.mock.calls.length > 0);
    expect(next.mock.calls[0][0]).toMatchObject({ status: 404 });
    expect(prisma.command.create).not.toHaveBeenCalled();
  });
});
