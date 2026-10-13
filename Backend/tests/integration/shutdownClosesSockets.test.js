"use strict";

/**
 * Shutdown must not wait on connected clients.
 *
 * `server.js` used to `await server.close()` and only then call `io.close()`. A Socket.IO
 * websocket is an upgraded connection that `server.close()` waits on, so with one dashboard or
 * robot connected the shutdown stalled there (measured locally: about 4 minutes) and the KV
 * close and `disconnectPrisma()` never ran. Real HTTP server, real Socket.IO server, real
 * websocket clients.
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");
const { io: ioClient } = require("socket.io-client");
const { closeHttpAndSockets } = require("../../src/utils/closeHttpServer");

async function listening(handler) {
  const server = http.createServer(handler || ((req, res) => res.end("ok")));
  const io = new Server(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, io, port: server.address().port };
}

function connect(port) {
  const client = ioClient(`http://127.0.0.1:${port}`, { transports: ["websocket"], reconnection: false, forceNew: true });
  return new Promise((resolve, reject) => {
    client.on("connect", () => resolve(client));
    client.on("connect_error", reject);
  });
}

const within = (promise, ms) =>
  Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve("TIMED_OUT"), ms))]);

describe("shutdown closes the HTTP server with clients connected", () => {
  const clients = [];
  afterEach(() => {
    for (const client of clients.splice(0)) client.close();
  });

  test("with two websocket clients connected, the close completes and every client is disconnected", async () => {
    const { server, io, port } = await listening();
    const a = await connect(port);
    const b = await connect(port);
    clients.push(a, b);
    const reasons = [];
    a.on("disconnect", (reason) => reasons.push(reason));
    b.on("disconnect", (reason) => reasons.push(reason));

    const outcome = await within(closeHttpAndSockets({ server, io, graceMs: 2000 }), 4000);

    expect(outcome).toEqual({ forced: false });
    expect(server.listening).toBe(false);
    await within(new Promise((resolve) => (reasons.length === 2 ? resolve() : setTimeout(resolve, 200))), 1000);
    expect(reasons).toHaveLength(2);
  });

  test("an HTTP request still in flight gets the grace period, then its connection is cut", async () => {
    let held = null;
    const { server, io, port } = await listening((req, res) => {
      held = res; // never answered
    });
    const request = http.get({ host: "127.0.0.1", port, path: "/slow", agent: new http.Agent({ keepAlive: true }) });
    const requestEnded = new Promise((resolve) => request.on("error", () => resolve("ERROR")).on("response", () => resolve("RESPONSE")));
    await within(new Promise((resolve) => {
      const poll = () => (held ? resolve() : setTimeout(poll, 10));
      poll();
    }), 2000);

    const started = Date.now();
    const outcome = await within(closeHttpAndSockets({ server, io, graceMs: 300 }), 3000);

    expect(outcome).toEqual({ forced: true });
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(server.listening).toBe(false);
    expect(await within(requestEnded, 1000)).toBe("ERROR");
  });

  test("server.js closes through it, not through an awaited server.close() before io.close()", () => {
    const source = fs.readFileSync(path.join(__dirname, "../../server.js"), "utf8");
    expect(source).toMatch(/await closeHttpAndSockets\(\{ server, io \}\)/);
    expect(source).not.toMatch(/await new Promise\(\(resolve\) => server\.close\(resolve\)\)/);
  });
});
