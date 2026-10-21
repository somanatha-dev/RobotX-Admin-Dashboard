"use strict";

/**
 * The Socket.IO Redis adapter attach (`sockets/redisAdapter.js`) against a server that accepts
 * the TCP connection and answers nothing — the half-open case — with the REAL ioredis client.
 *
 * Reproduced defect (2026-10-21): server.js awaited both clients' `ready` with no bound.
 * ioredis's `connectTimeout` covers only the TCP connect, so the ready check stayed pending
 * (still pending after 15 s) and boot never reached `listen`.
 */

const net = require("net");
const { attachRedisAdapter } = require("../../../src/sockets/redisAdapter");

const SETTINGS = { connectTimeoutMs: 300, commandTimeoutMs: 200, keepAliveMs: 5000 };

function startSilentServer() {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("data", () => {}); // accepts the bytes, never answers
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        url: `redis://127.0.0.1:${server.address().port}/0`,
        open: () => sockets.size,
        stop: () =>
          new Promise((done) => {
            for (const s of sockets) s.destroy();
            server.close(() => done());
          }),
      }),
    );
  });
}

const logger = { info: jest.fn(), warn: jest.fn() };

test("a half-open server fails the attach within connect + command timeout, and both clients are closed", async () => {
  const silent = await startSilentServer();
  const io = { adapter: jest.fn() };
  try {
    const started = Date.now();
    const attached = await attachRedisAdapter(io, { ...SETTINGS, url: silent.url }, logger);
    const elapsed = Date.now() - started;

    expect(attached).toBeNull();
    expect(io.adapter).not.toHaveBeenCalled();
    expect(elapsed).toBeLessThan(SETTINGS.connectTimeoutMs + SETTINGS.commandTimeoutMs + 1000);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("adapter unavailable"), expect.objectContaining({ message: expect.stringContaining("not ready within") }));

    // Disconnected, not left reconnecting: the server sees no connection afterwards.
    await new Promise((r) => setTimeout(r, 300));
    expect(silent.open()).toBe(0);
  } finally {
    await silent.stop();
  }
}, 10000);

test("a refused connection fails the attach and closes both clients", async () => {
  const probe = await startSilentServer();
  const url = probe.url;
  await probe.stop(); // nothing listens on that port now
  const io = { adapter: jest.fn() };
  const attached = await attachRedisAdapter(io, { ...SETTINGS, url }, logger);
  expect(attached).toBeNull();
  expect(io.adapter).not.toHaveBeenCalled();
}, 10000);

test("both clients ready: the adapter is attached with them", async () => {
  const clients = [];
  class FakeRedis {
    constructor() {
      this.handlers = {};
      clients.push(this);
      setImmediate(() => this.emit("ready"));
    }
    duplicate() { return new FakeRedis(); }
    once(event, fn) { (this.handlers[event] ||= []).push(fn); return this; }
    on(event, fn) { return this.once(event, fn); }
    emit(event, ...args) { for (const fn of this.handlers[event] || []) fn(...args); }
    disconnect() { this.disconnected = true; }
  }
  const io = { adapter: jest.fn() };
  const createAdapter = jest.fn(() => "adapter");
  const attached = await attachRedisAdapter(io, { ...SETTINGS, url: "redis://fake" }, logger, { Redis: FakeRedis, createAdapter });
  expect(attached).toEqual({ pubClient: clients[0], subClient: clients[1] });
  expect(createAdapter).toHaveBeenCalledWith(clients[0], clients[1]);
  expect(io.adapter).toHaveBeenCalledWith("adapter");
  expect(clients.every((c) => !c.disconnected)).toBe(true);
});
