"use strict";

/**
 * A half-open Redis connection — the socket stays up, nothing is answered, no FIN or RST — with
 * the REAL ioredis client against a minimal RESP server this test owns (no Redis needed).
 *
 * Reproduced defect (2026-10-21, against Memurai through a black-hole proxy): a KV GET was still
 * pending after 8 s and the facade still reported `redis: true`. The facade set no command
 * timeout, and ioredis's keepalive leaves the OS default (hours), so the telemetry handler, the
 * heartbeat's registry write and `/health` would each block on their first Redis call.
 */

const net = require("net");
const request = require("supertest");
// Loaded once: the settings are read when `initKv` runs, not when the module loads.
const { initKv } = require("../../../src/cache/kv");
const app = require("../../../src/app");
const { setRobotState } = require("../../../src/services/robotRegistry.service");

const COMMAND_TIMEOUT_MS = 200;
const CONNECT_TIMEOUT_MS = 300;

/** Enough of RESP for ioredis's handshake and the facade's commands. `silent` answers nothing. */
function startRespServer() {
  const store = new Map();
  const sockets = new Set();
  const state = { silent: false, commands: 0 };

  function parse(buffer) {
    const commands = [];
    let offset = 0;
    for (;;) {
      if (buffer[offset] !== 0x2a) break; // '*'
      const end = buffer.indexOf("\r\n", offset);
      if (end < 0) break;
      const count = Number(buffer.slice(offset + 1, end).toString());
      let cursor = end + 2;
      const args = [];
      let complete = true;
      for (let i = 0; i < count; i += 1) {
        const lenEnd = buffer.indexOf("\r\n", cursor);
        if (lenEnd < 0) { complete = false; break; }
        const len = Number(buffer.slice(cursor + 1, lenEnd).toString());
        const start = lenEnd + 2;
        if (buffer.length < start + len + 2) { complete = false; break; }
        args.push(buffer.slice(start, start + len).toString());
        cursor = start + len + 2;
      }
      if (!complete) break;
      commands.push(args);
      offset = cursor;
    }
    return { commands, rest: buffer.slice(offset) };
  }

  const bulk = (s) => (s === null || s === undefined ? "$-1\r\n" : `$${Buffer.byteLength(s)}\r\n${s}\r\n`);
  function reply([name, ...args]) {
    switch (String(name).toUpperCase()) {
      case "INFO": return bulk("# Server\r\nredis_version:7.2.0\r\nloading:0\r\n");
      case "PING": return "+PONG\r\n";
      case "GET": return bulk(store.has(args[0]) ? store.get(args[0]) : null);
      case "SET": store.set(args[0], args[1]); return "+OK\r\n";
      case "DEL": { let n = 0; for (const k of args) n += store.delete(k) ? 1 : 0; return `:${n}\r\n`; }
      default: return "+OK\r\n";
    }
  }

  const server = net.createServer((socket) => {
    sockets.add(socket);
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      if (state.silent) return; // half-open: bytes accepted, never answered
      pending = Buffer.concat([pending, chunk]);
      const { commands, rest } = parse(pending);
      pending = rest;
      for (const command of commands) {
        state.commands += 1;
        socket.write(reply(command));
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        state,
        url: `redis://127.0.0.1:${server.address().port}/0`,
        async stop() {
          for (const socket of sockets) socket.destroy();
          await new Promise((r) => server.close(r));
        },
      });
    });
  });
}

const quiet = { info() {}, warn() {}, error() {} };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function openKv(url) {
  const names = ["REDIS_URL", "REDIS_ENABLED", "REDIS_CONNECT_TIMEOUT_MS", "REDIS_COMMAND_TIMEOUT_MS"];
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  Object.assign(process.env, {
    REDIS_URL: url,
    REDIS_ENABLED: "true",
    REDIS_CONNECT_TIMEOUT_MS: String(CONNECT_TIMEOUT_MS),
    REDIS_COMMAND_TIMEOUT_MS: String(COMMAND_TIMEOUT_MS),
  });
  try {
    return await initKv({ logger: quiet });
  } finally {
    for (const n of names) {
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
    }
  }
}

async function timed(promise) {
  const t0 = Date.now();
  const value = await promise;
  return { value, ms: Date.now() - t0 };
}

let server;
let handle;

beforeEach(async () => {
  server = await startRespServer();
  handle = await openKv(server.url);
});

afterEach(async () => {
  if (handle) await handle.close();
  if (server) await server.stop();
});

describe("cache/kv — a half-open connection is bounded and falls back", () => {
  test("a command on a silent connection times out, falls back to memory, and health says so", async () => {
    const { kv } = handle;
    await kv.set("robot:R1", "live", { ex: 60 });
    expect(await kv.get("robot:R1")).toBe("live");
    expect(kv.health().redis).toBe(true);

    server.state.silent = true;
    const { value, ms } = await timed(kv.get("robot:R1"));

    expect(ms).toBeLessThan(COMMAND_TIMEOUT_MS * 5);
    expect(value).toBeNull(); // the memory store's answer: not a value Redis can no longer vouch for
    expect(kv.health()).toMatchObject({ redis: false, configured: true, reconnecting: true });
    // Later calls are answered from memory at once.
    expect((await timed(kv.set("robot:R1", "x", { ex: 60 }))).ms).toBeLessThan(50);
  });

  test("a pipeline (the telemetry read and write batches) is bounded the same way", async () => {
    const { kv } = handle;
    server.state.silent = true;
    const { value, ms } = await timed(kv.pipeline().get("robot:R1").get("registry:R1").set("robot:R1", "v", { ex: 15 }).exec());
    expect(ms).toBeLessThan(COMMAND_TIMEOUT_MS * 5);
    expect(value).toEqual([null, null, undefined]);
    expect(kv.health().redis).toBe(false);
  });

  test("the heartbeat's registry write does not block", async () => {
    const { kv } = handle;
    server.state.silent = true;
    const beat = Date.now();
    const { ms } = await timed(setRobotState(kv, "R1", { lastHeartbeat: beat, connected: true }));
    expect(ms).toBeLessThan(COMMAND_TIMEOUT_MS * 5);
    // Written to the in-memory store the facade fell back to.
    expect(JSON.parse(await kv.get("registry:R1"))).toMatchObject({ lastHeartbeat: beat });
  });

  test("/health answers promptly with redis \"fail\" instead of hanging", async () => {
    const saved = app.locals.kv;
    app.locals.kv = handle.kv;
    try {
      server.state.silent = true;
      const { value: response, ms } = await timed(request(app).get("/health"));
      expect(response.status).toBe(200);
      expect(response.body.redis).toBe("fail");
      expect(ms).toBeLessThan(COMMAND_TIMEOUT_MS * 10);
    } finally {
      app.locals.kv = saved;
    }
  });

  test("reconnecting through a still-silent server is bounded; it recovers once the server answers", async () => {
    const { kv } = handle;
    const modes = [];
    kv.onModeChange((mode) => modes.push(mode));
    await kv.set("session:R1", "before", { ex: 60 });

    server.state.silent = true;
    await kv.set("session:R1", "during", { ex: 60 }); // times out → memory, tracked for recovery
    expect(kv.health().redis).toBe(false);

    // The first reconnect attempt (1 s) connects TCP but gets no handshake reply: it must fail
    // within its bound and be retried, not hold the reconnect loop open.
    await sleep(1000 + CONNECT_TIMEOUT_MS + COMMAND_TIMEOUT_MS + 300);
    expect(kv.health().redis).toBe(false);

    server.state.silent = false;
    const deadline = Date.now() + 6000;
    while (!kv.health().redis && Date.now() < deadline) await sleep(50);
    expect(kv.health()).toMatchObject({ redis: true, reconnecting: false, outagePending: 0 });
    // Reconciled: the outage's value is written back, never the pre-outage one.
    expect(await kv.get("session:R1")).toBe("during");
    await sleep(20);
    expect(modes).toEqual(["fallback", "recovered"]);
  }, 15000);
});

describe("telemetry — a half-open Redis does not stall a frame", () => {
  test("TELEMETRY is processed and broadcast within the command timeout", async () => {
    const { createFakeSocket, createFakeIo } = require("../../helpers/fakeSocket");
    const { createMockPrisma } = require("../../helpers/mockPrisma");
    const { waitFor } = require("../../helpers/waitFor");
    const silentLogger = require("../../mocks/silentLogger");
    const { registerTelemetryHandlers } = require("../../../src/sockets/handlers/telemetry.handler");

    const prisma = createMockPrisma();
    prisma.zone.findMany.mockResolvedValue([]);
    prisma.robot.updateMany.mockResolvedValue({ count: 1 });
    prisma.robot.update.mockResolvedValue({});
    prisma.robot.findUnique.mockResolvedValue({ id: "db-robot-1", status: "IDLE", lat: 1, lon: 1, speed: 0, battery: 50, isOnline: true });
    const io = createFakeIo();
    const socket = createFakeSocket();
    socket.data.isAuthed = true;
    socket.data.robotId = "R1";
    registerTelemetryHandlers(io, socket, { prisma, kv: handle.kv, logger: silentLogger });

    server.state.silent = true;
    const t0 = Date.now();
    socket.trigger("TELEMETRY", { lat: 12.9, lon: 77.5, battery: 60, status: "IDLE" });
    await waitFor(() => io.emittedTo("dashboard", "robot:update").length === 1, { timeout: 3000 });
    expect(Date.now() - t0).toBeLessThan(COMMAND_TIMEOUT_MS * 10);
    expect(handle.kv.health().redis).toBe(false);
  });
});
