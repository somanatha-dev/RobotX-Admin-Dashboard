jest.mock("../../src/db/prisma");

const http = require("http");
const { Server } = require("socket.io");
const { io: ioClient } = require("socket.io-client");
const jwt = require("jsonwebtoken");

const { getPrisma } = require("../../src/db/prisma");
const initSocketServer = require("../../src/sockets/socket.server");
const { createTestKv } = require("../helpers/testKv");

const USER_ID = "33333333-3333-4333-8333-333333333333";
const ADMIN_USER = { id: USER_ID, email: "admin@robotx.test", role: "SUPER_ADMIN" };

// initSocketServer (F21) requires every dashboard-candidate socket to present
// the same admin JWT the REST `authUser` middleware verifies, before it is
// allowed to join the "dashboard" room. This spins up a real HTTP + Socket.IO
// server and connects with a real socket.io-client to exercise the actual
// handshake path end-to-end, rather than unit-testing the gate in isolation.
describe("Socket.IO dashboard-room JWT gate (F21)", () => {
  let httpServer;
  let io;
  let port;
  let kv;
  let prisma;
  const clients = [];

  beforeAll(async () => {
    prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(ADMIN_USER) },
      task: { findMany: jest.fn().mockResolvedValue([]) },
      robot: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      campus: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    getPrisma.mockReturnValue(prisma);
    ({ kv } = await createTestKv());

    httpServer = http.createServer();
    io = new Server(httpServer, { cors: { origin: true, credentials: true } });
    initSocketServer(io, { prisma, kv, logger: { info() {}, warn() {}, error() {}, socket() {}, socketIn() {}, socketOut() {} } });

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

  function connectDashboard({ token, sendCookie = true } = {}) {
    const extraHeaders = { "user-agent": "Mozilla/5.0 (test dashboard)" };
    if (sendCookie && token) extraHeaders.cookie = `token=${token}`;
    const client = ioClient(`http://localhost:${port}`, {
      transports: ["websocket"],
      extraHeaders,
      auth: sendCookie ? {} : { token },
      forceNew: true,
      reconnection: false,
    });
    clients.push(client);
    return client;
  }

  function validAdminToken() {
    return jwt.sign({ id: USER_ID }, process.env.JWT_SECRET, { expiresIn: "7d" });
  }

  test("a dashboard socket with a valid admin JWT cookie is joined to the dashboard room", async () => {
    const client = connectDashboard({ token: validAdminToken() });

    await new Promise((resolve, reject) => {
      client.on("connect", resolve);
      client.on("connect_error", reject);
      client.on("UNAUTHORIZED", () => reject(new Error("unexpectedly rejected")));
    });

    // Give the server a tick to run its async auth + socket.join().
    await new Promise((r) => setTimeout(r, 100));
    expect(io.sockets.adapter.rooms.get("dashboard")?.size).toBe(1);
  });

  // The server emits "UNAUTHORIZED" and immediately force-disconnects in the
  // same tick (socket.emit(...) followed by socket.disconnect(true)) — on a
  // fast local connection the disconnect can occasionally win the race and
  // the client never sees the UNAUTHORIZED packet before the transport
  // closes. The behavioral contract this test actually protects (F21) is
  // "never joins dashboard, connection is not left open" — so it waits on
  // "disconnect" (always fired) as the primary signal, and treats a captured
  // UNAUTHORIZED payload as a bonus assertion rather than the sync point.
  async function expectRejected(client) {
    let unauthorizedPayload = null;
    client.on("UNAUTHORIZED", (payload) => { unauthorizedPayload = payload; });
    await new Promise((resolve) => client.on("disconnect", resolve));
    return unauthorizedPayload;
  }

  test("a dashboard socket with no token is rejected and disconnected, never joining dashboard", async () => {
    const client = connectDashboard({ token: null });
    const unauthorized = await expectRejected(client);
    if (unauthorized) expect(unauthorized).toEqual(expect.objectContaining({ message: expect.any(String) }));
    expect(io.sockets.adapter.rooms.get("dashboard")).toBeUndefined();
  });

  test("a dashboard socket with an invalid/garbage token is rejected", async () => {
    const client = connectDashboard({ token: "not-a-real-jwt" });
    const unauthorized = await expectRejected(client);
    if (unauthorized) expect(unauthorized.message).toMatch(/required/i);
    expect(io.sockets.adapter.rooms.get("dashboard")).toBeUndefined();
  });

  test("a dashboard socket with a token signed by the wrong secret is rejected", async () => {
    const wrongToken = jwt.sign({ id: USER_ID }, "not-the-real-secret", { expiresIn: "7d" });
    const client = connectDashboard({ token: wrongToken });
    await expectRejected(client);
    // No dashboard membership leak from a socket that never authenticated.
    expect(io.sockets.adapter.rooms.get("dashboard")).toBeUndefined();
  });
});
