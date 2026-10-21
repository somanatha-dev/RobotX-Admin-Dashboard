"use strict";

/**
 * RBAC — the dashboard socket's periodic re-check (socket.server.js), with a real server and
 * real clients and the interval shortened to 100 ms.
 *
 * The re-check is what ends a long-lived socket whose account was disabled, or whose role or
 * campus changed, even when `/api/users`' own disconnect did not reach it. It had no test.
 *
 * Defect pinned (2026-10-21): a failed account lookup (a database error) was treated as "no
 * account" — the socket was told its session ended and disconnected, and the dashboard's
 * follow-up `/api/auth/me` answers 401 while the database is still failing, signing the
 * operator out over a transient error. A failed lookup now decides nothing.
 */

jest.mock("../../src/db/prisma");

const http = require("http");
const { Server } = require("socket.io");
const { io: ioClient } = require("socket.io-client");
const jwt = require("jsonwebtoken");

const { getPrisma } = require("../../src/db/prisma");
const initSocketServer = require("../../src/sockets/socket.server");
const dashboardBroadcast = require("../../src/sockets/dashboardBroadcast");
const { createTestKv } = require("../helpers/testKv");
const silentLogger = require("../mocks/silentLogger");

const RECHECK_MS = 100;
const CAMPUS_A = { id: "ca000000-0000-4000-8000-00000000000a", code: "RNSIT", name: "RNSIT", regionId: "ra000000-0000-4000-8000-00000000000a", region: { regionId: "rnsit" } };
const CAMPUS_B = { id: "cb000000-0000-4000-8000-00000000000b", code: "JSS", name: "JSS", regionId: "rb000000-0000-4000-8000-00000000000b", region: { regionId: "jss" } };
const SUPER_ID = "11111111-1111-4111-8111-111111111111";
const ADMIN_ID = "22222222-2222-4222-8222-222222222222";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Real sockets. A connection joins in ~10–50 ms alone, but in the full in-band suite the first
// connection of this file once exceeded the default 5 s while earlier suites' leaked timers were
// still running. The budget is explicit, and `joined` names the phase that stalled.
jest.setTimeout(15000);

describe("dashboard socket re-check", () => {
  let httpServer;
  let io;
  let port;
  let accounts;
  let lookupFails;
  const clients = [];

  function resetAccounts() {
    accounts = new Map([
      [SUPER_ID, { id: SUPER_ID, email: "root@x", role: "SUPER_ADMIN", campusId: null, campus: null, disabledAt: null }],
      [ADMIN_ID, { id: ADMIN_ID, email: "a@x", role: "ADMIN", campusId: CAMPUS_A.id, campus: CAMPUS_A, disabledAt: null }],
    ]);
    lookupFails = false;
  }

  beforeAll(async () => {
    resetAccounts();
    const prisma = {
      user: {
        findUnique: jest.fn(async ({ where }) => {
          if (lookupFails) throw Object.assign(new Error("Can't reach database server"), { code: "P1001" });
          const row = accounts.get(where.id);
          return row ? { ...row } : null;
        }),
      },
      task: { findMany: jest.fn().mockResolvedValue([]) },
      robot: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      campus: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    getPrisma.mockReturnValue(prisma);
    const { kv } = await createTestKv();
    httpServer = http.createServer();
    io = new Server(httpServer, { cors: { origin: true, credentials: true } });
    initSocketServer(io, { prisma, kv, logger: silentLogger, dashboardRecheckIntervalMs: RECHECK_MS });
    await new Promise((resolve) => httpServer.listen(0, resolve));
    port = httpServer.address().port;
  });

  afterAll(async () => {
    io.close();
    await new Promise((resolve) => httpServer.close(resolve));
  });

  afterEach(() => {
    resetAccounts();
    for (const c of clients.splice(0)) {
      try { c.close(); } catch { /* ignore */ }
    }
  });

  /** Connect as `userId` and wait until the server has placed the socket in its rooms. */
  async function joined(userId) {
    const client = ioClient(`http://localhost:${port}`, {
      transports: ["websocket"],
      reconnection: false,
      forceNew: true,
      extraHeaders: { "user-agent": "Mozilla/5.0 (test dashboard)", cookie: `token=${jwt.sign({ id: userId }, process.env.JWT_SECRET)}` },
    });
    clients.push(client);
    const record = { client, unauthorized: [], disconnected: false };
    client.on("UNAUTHORIZED", (payload) => record.unauthorized.push(payload));
    client.on("disconnect", () => { record.disconnected = true; });
    const started = Date.now();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`socket did not connect within 10 s`)), 10_000);
      client.once("connect", () => { clearTimeout(timer); resolve(); });
      client.once("connect_error", (error) => { clearTimeout(timer); reject(error); });
    });
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if ((await io.in(dashboardBroadcast.userRoom(userId)).fetchSockets()).length > 0) return record;
      await sleep(10);
    }
    throw new Error(`socket connected (after ${Date.now() - started} ms) but never joined its rooms`);
  }

  async function until(predicate, ms = 2000) {
    const deadline = Date.now() + ms;
    while (!predicate() && Date.now() < deadline) await sleep(10);
    return predicate();
  }

  test("an unchanged account keeps its socket across re-checks", async () => {
    const s = await joined(SUPER_ID);
    await sleep(RECHECK_MS * 4);
    expect(s.disconnected).toBe(false);
    expect(s.unauthorized).toEqual([]);
  });

  test("an account disabled after connecting is told why and disconnected by the next re-check", async () => {
    const s = await joined(ADMIN_ID);
    accounts.get(ADMIN_ID).disabledAt = new Date();
    expect(await until(() => s.disconnected)).toBe(true);
    expect(s.unauthorized).toEqual([expect.objectContaining({ code: "ACCOUNT_DISABLED" })]);
  });

  test("a campus change is ACCESS_CHANGED and disconnects", async () => {
    const s = await joined(ADMIN_ID);
    Object.assign(accounts.get(ADMIN_ID), { campusId: CAMPUS_B.id, campus: CAMPUS_B });
    expect(await until(() => s.disconnected)).toBe(true);
    expect(s.unauthorized).toEqual([expect.objectContaining({ code: "ACCESS_CHANGED" })]);
  });

  test("a deleted account ends the session", async () => {
    const s = await joined(ADMIN_ID);
    accounts.delete(ADMIN_ID);
    expect(await until(() => s.disconnected)).toBe(true);
    expect(s.unauthorized).toEqual([expect.objectContaining({ code: "SESSION_ENDED" })]);
  });

  test("a failed account lookup keeps the socket; the re-check still applies once the database answers", async () => {
    const s = await joined(ADMIN_ID);
    lookupFails = true;
    await sleep(RECHECK_MS * 5); // several re-checks, every one failing
    expect(s.disconnected).toBe(false);
    expect(s.unauthorized).toEqual([]);

    // Not an exemption: when the database answers again, a disabled account is still cut off.
    accounts.get(ADMIN_ID).disabledAt = new Date();
    lookupFails = false;
    expect(await until(() => s.disconnected)).toBe(true);
    expect(s.unauthorized).toEqual([expect.objectContaining({ code: "ACCOUNT_DISABLED" })]);
  });
});
