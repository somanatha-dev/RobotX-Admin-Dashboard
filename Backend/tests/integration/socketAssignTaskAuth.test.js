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

// P1.4 (LAN-4) — the legacy `assign_task` socket event reaches the same intake as
// `POST /api/tasks/assign`, which requires an authenticated user. The socket path had no
// check: measured live with the engine on, a bare socket.io client created a queued Task.
// A real HTTP + Socket.IO server and a real client, so the classification a socket gets at
// connection time is the one production gives it.
describe("socket `assign_task` requires an authenticated dashboard user (P1.4, LAN-4)", () => {
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

  const next = (client, event) => new Promise((resolve) => client.once(event, resolve));

  test("a bare client (no Origin, no browser UA, no session) is refused and intake is never called", async () => {
    const client = await connect({ "user-agent": "node-test-client" });
    const refused = next(client, "task_error");
    client.emit("assign_task", REQUEST);
    await expect(refused).resolves.toMatchObject({ code: "UNAUTHORIZED" });
    expect(taskService.assignTask).not.toHaveBeenCalled();
  });

  test("a robot socket that has AUTHed is still not a user: refused", async () => {
    const client = await connect({ "user-agent": "robotx-agent/1.0" });
    const refused = next(client, "task_error");
    client.emit("assign_task", { ...REQUEST, robotId: "V1DEMO-01" });
    await expect(refused).resolves.toMatchObject({ code: "UNAUTHORIZED" });
    expect(taskService.assignTask).not.toHaveBeenCalled();
  });

  test("an authenticated dashboard socket still reaches intake", async () => {
    const token = jwt.sign({ id: USER_ID }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const client = await connect({ "user-agent": "Mozilla/5.0 (test dashboard)", cookie: `token=${token}` });
    const accepted = next(client, "task_accepted");
    client.emit("assign_task", REQUEST);
    await expect(accepted).resolves.toMatchObject({ taskId: "TSK-1" });
    expect(taskService.assignTask).toHaveBeenCalledTimes(1);
  });
});
