jest.mock("../../src/db/prisma");

const http = require("http");
const { Server } = require("socket.io");
const { io: ioClient } = require("socket.io-client");

const { getPrisma } = require("../../src/db/prisma");
const initSocketServer = require("../../src/sockets/socket.server");
const { dispatchCommand, dispatchTaskAssign, dispatchStop } = require("../../src/services/commandDispatcher.service");
const { createTestKv } = require("../helpers/testKv");
const { waitFor } = require("../helpers/waitFor");
const silentLogger = require("../mocks/silentLogger");

const ROBOT_ID = "R-INT-1";
const ROBOT_ROW = { id: "db-robot-int-1", status: "IDLE", isOnline: false, lat: 12.9, lon: 77.5, battery: 88 };

// End-to-end wire check for the server -> robot path, over a real HTTP +
// Socket.IO server with a real socket.io-client acting as the robot.
//
// This is the level at which the shipped bugs were actually observable and at
// which the unit tests could not see them:
//
//   - dispatchTaskAssign was called with the wrong arity in server.js, so the
//     re-dispatch after a restart never reached the robot at all;
//   - the command endpoint emitted through a process-local socket map and used
//     an event name the robot did not listen for, so commands were never
//     received and never acknowledged.
//
// Everything here goes through the robot's Socket.IO room, which is the same
// mechanism the Redis adapter extends across worker processes.
describe("server -> robot command round trip (integration)", () => {
  let httpServer;
  let io;
  let port;
  let kv;
  let prisma;
  const clients = [];

  beforeAll(async () => {
    prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(null) },
      task: { findMany: jest.fn().mockResolvedValue([]) },
      robot: {
        findUnique: jest.fn().mockResolvedValue(ROBOT_ROW),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      campus: { findFirst: jest.fn().mockResolvedValue(null) },
      zone: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(1) },
    };
    getPrisma.mockReturnValue(prisma);
    ({ kv } = await createTestKv());

    httpServer = http.createServer();
    io = new Server(httpServer, { cors: { origin: true, credentials: true } });
    initSocketServer(io, { prisma, kv, logger: silentLogger });

    await new Promise((resolve) => httpServer.listen(0, resolve));
    port = httpServer.address().port;
  });

  afterAll(async () => {
    io.close();
    await new Promise((resolve) => httpServer.close(resolve));
  });

  afterEach(() => {
    for (const c of clients.splice(0)) {
      try { c.close(); } catch { /* ignore */ }
    }
  });

  /** Connect as a robot and complete the AUTH handshake, joining robot:{id}. */
  async function connectRobot(robotId = ROBOT_ID) {
    await kv.set(`session:${robotId}`, "session-token", { ex: 3600 });

    const client = ioClient(`http://127.0.0.1:${port}`, {
      transports: ["websocket"],
      reconnection: false,
      forceNew: true,
    });
    clients.push(client);

    const received = [];
    client.onAny((event, payload) => received.push({ event, payload }));

    await new Promise((resolve, reject) => {
      client.on("connect", resolve);
      client.on("connect_error", reject);
      setTimeout(() => reject(new Error("robot socket did not connect")), 5000);
    });

    client.emit("AUTH", { robotId, token: "session-token" });
    await waitFor(() => received.some((m) => m.event === "AUTH_SUCCESS"), { timeout: 5000 });

    return { client, received };
  }

  test("an authenticated robot is reachable by room, and COMMAND round-trips with an ACK", async () => {
    const { client, received } = await connectRobot();

    // Mimic VirtualRobot's contract: act on COMMAND, then acknowledge it.
    client.on("COMMAND", ({ commandId }) => client.emit("COMMAND_ACK", { commandId }));

    const result = await dispatchCommand(io, ROBOT_ID, { commandId: "cmd-int-1", type: "STOP" });

    expect(result.dispatched).toBe(true);
    await waitFor(() => received.some((m) => m.event === "COMMAND"), { timeout: 5000 });
    const cmd = received.find((m) => m.event === "COMMAND");
    expect(cmd.payload).toMatchObject({ commandId: "cmd-int-1", type: "STOP" });
  });

  test("TASK_ASSIGN reaches the robot when dispatched with the (io, robotId, payload) signature", async () => {
    const { received } = await connectRobot();

    const result = await dispatchTaskAssign(io, ROBOT_ID, {
      taskId: "TSK-INT-1",
      pickup: { lat: 12.9, lon: 77.5 },
      drop: { lat: 12.91, lon: 77.51 },
      pathToPickup: [{ lat: 12.9, lon: 77.5 }],
      pathToDrop: [{ lat: 12.91, lon: 77.51 }],
    });

    expect(result.dispatched).toBe(true);
    await waitFor(() => received.some((m) => m.event === "TASK_ASSIGN"), { timeout: 5000 });
    expect(received.find((m) => m.event === "TASK_ASSIGN").payload).toMatchObject({ taskId: "TSK-INT-1" });
  });

  test("the two-argument call that shipped in server.js delivers nothing and says so", async () => {
    const { received } = await connectRobot();

    // Exactly the defective call: robotId lands in the `io` position.
    const result = await dispatchTaskAssign(ROBOT_ID, { taskId: "TSK-INT-BROKEN" });

    expect(result).toMatchObject({ dispatched: false, error: "NO_IO_SERVER" });
    await new Promise((r) => setTimeout(r, 200));
    expect(received.some((m) => m.event === "TASK_ASSIGN")).toBe(false);
  });

  test("STOP from task cancellation reaches the robot's room", async () => {
    const { received } = await connectRobot();

    await dispatchStop(io, ROBOT_ID, { taskId: "TSK-INT-1", reason: "TASK_CANCELLED" });

    await waitFor(() => received.some((m) => m.event === "STOP"), { timeout: 5000 });
    expect(received.find((m) => m.event === "STOP").payload).toMatchObject({ reason: "TASK_CANCELLED" });
  });

  test("a robot that never authenticated is not in its room and receives nothing", async () => {
    const client = ioClient(`http://127.0.0.1:${port}`, {
      transports: ["websocket"], reconnection: false, forceNew: true,
    });
    clients.push(client);
    const received = [];
    client.onAny((event, payload) => received.push({ event, payload }));
    await new Promise((resolve, reject) => {
      client.on("connect", resolve);
      client.on("connect_error", reject);
      setTimeout(() => reject(new Error("did not connect")), 5000);
    });

    const result = await dispatchCommand(io, "R-NEVER-AUTHED", { commandId: "cmd-x", type: "STOP" });

    expect(result.dispatched).toBe(false);
    expect(received.some((m) => m.event === "COMMAND")).toBe(false);
  });

  test("AUTH puts the robot in the live index, and disconnecting takes it back out", async () => {
    const { client } = await connectRobot();

    await waitFor(async () => (await kv.smembers("robots:all")).includes(ROBOT_ID), { timeout: 5000 });

    prisma.robot.findUnique.mockResolvedValue({ ...ROBOT_ROW, socketId: client.id });
    // Y1 — the offline write is conditional on this socket's id; the row above names it, so it matches.
    prisma.robot.updateMany.mockResolvedValue({ count: 1 });
    client.close();

    await waitFor(async () => !(await kv.smembers("robots:all")).includes(ROBOT_ID), { timeout: 5000 });
    expect(await kv.smembers("robots:all")).not.toContain(ROBOT_ID);

    prisma.robot.findUnique.mockResolvedValue(ROBOT_ROW);
    prisma.robot.updateMany.mockResolvedValue({ count: 0 });
  });
});
