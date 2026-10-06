jest.mock("../../src/db/prisma");
jest.mock("../../src/services/task.service", () => ({ assignTask: jest.fn() }));

const http = require("http");
const { Server } = require("socket.io");
const { io: ioClient } = require("socket.io-client");
const jwt = require("jsonwebtoken");

const { getPrisma } = require("../../src/db/prisma");
const taskService = require("../../src/services/task.service");
const initSocketServer = require("../../src/sockets/socket.server");
const { createTestKv } = require("../helpers/testKv");
const silentLogger = require("../mocks/silentLogger");

const USER_ID = "44444444-4444-4444-8444-444444444444";
const ADMIN_USER = { id: USER_ID, email: "admin@robotx.test", role: "SUPER_ADMIN" };

// The legacy `assign_task` socket event is retired. It reached the same intake as
// `POST /api/tasks/assign` but without that route's rate limiter or its manual-assignment
// (waiver) gate. P1.4 (LAN-4) had already closed it to unauthenticated sockets; no client
// emitted it. Task submission is REST only, so the assertion is now stronger than LAN-4's:
// **no** socket — bare, robot, or an authenticated dashboard user — reaches intake, and the
// server registers no listener for the event at all. A real HTTP + Socket.IO server and a
// real client, so the classification a socket gets at connection time is the one
// production gives it.
describe("socket `assign_task` is retired: no socket reaches task intake (LAN-4)", () => {
  let httpServer;
  let io;
  let port;
  const clients = [];

  const REQUEST = {
    pickup: "rnsit-food-court",
    pickupLat: 12.9,
    pickupLon: 77.5,
    drop: "rnsit-canara-bank",
    dropLat: 12.901,
    dropLon: 77.501,
    regionId: "rnsit",
  };
  const INTAKE_EVENTS = ["task_accepted", "task_assigned", "task_error"];

  beforeAll(async () => {
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(ADMIN_USER) },
      task: { findMany: jest.fn().mockResolvedValue([]) },
      robot: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      campus: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    getPrisma.mockReturnValue(prisma);
    const { kv } = await createTestKv();

    httpServer = http.createServer();
    io = new Server(httpServer, { cors: { origin: true, credentials: true } });
    initSocketServer(io, { prisma, kv, logger: silentLogger, appLocals: { config: null } });
    await new Promise((resolve) => httpServer.listen(0, resolve));
    port = httpServer.address().port;
  });

  afterAll(async () => {
    io.close();
    await new Promise((resolve) => httpServer.close(resolve));
  });

  beforeEach(() => {
    taskService.assignTask.mockReset();
    taskService.assignTask.mockResolvedValue({ intake: { taskId: "TSK-1", accepted: true, assigned: false } });
  });

  afterEach(() => {
    for (const c of clients.splice(0)) {
      try { c.close(); } catch { /* ignore */ }
    }
  });

  function connect(extraHeaders) {
    const client = ioClient(`http://localhost:${port}`, {
      transports: ["websocket"],
      extraHeaders,
      forceNew: true,
      reconnection: false,
    });
    clients.push(client);
    return new Promise((resolve, reject) => {
      client.on("connect", () => resolve(client));
      client.on("connect_error", reject);
    });
  }

  /** The server-side Socket for a connected client — the object listeners are registered on. */
  const serverSocketOf = (client) => io.of("/").sockets.get(client.id);

  /** Emit `assign_task` and record every intake event that comes back within the window. */
  async function emitAndListen(client, payload) {
    const received = [];
    for (const event of INTAKE_EVENTS) client.on(event, (body) => received.push({ event, body }));
    client.emit("assign_task", payload);
    await new Promise((resolve) => setTimeout(resolve, 300));
    return received;
  }

  test("the server registers no `assign_task` listener (control: a robot event is registered)", async () => {
    const client = await connect({ "user-agent": "robotx-agent/1.0" });
    const socket = serverSocketOf(client);
    expect(socket).toBeDefined();
    expect(socket.listenerCount("AUTH")).toBeGreaterThan(0);
    expect(socket.listenerCount("assign_task")).toBe(0);
  });

  test("a bare client (no Origin, no browser UA, no session): nothing reaches intake", async () => {
    const client = await connect({ "user-agent": "node-test-client" });
    expect(await emitAndListen(client, REQUEST)).toEqual([]);
    expect(taskService.assignTask).not.toHaveBeenCalled();
  });

  test("a robot socket: nothing reaches intake", async () => {
    const client = await connect({ "user-agent": "robotx-agent/1.0" });
    expect(await emitAndListen(client, { ...REQUEST, robotId: "V1DEMO-01" })).toEqual([]);
    expect(taskService.assignTask).not.toHaveBeenCalled();
  });

  test("an authenticated dashboard user cannot create a task over the socket either", async () => {
    const token = jwt.sign({ id: USER_ID }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const client = await connect({ "user-agent": "Mozilla/5.0 (test dashboard)", cookie: `token=${token}` });
    const socket = serverSocketOf(client);
    // Control: the dashboard session was accepted, so a refusal below is not an auth artefact.
    expect(socket && socket.data.userId).toBe(USER_ID);
    expect(socket.listenerCount("assign_task")).toBe(0);

    expect(await emitAndListen(client, REQUEST)).toEqual([]);
    expect(taskService.assignTask).not.toHaveBeenCalled();
    expect(client.connected).toBe(true);
  });
});
