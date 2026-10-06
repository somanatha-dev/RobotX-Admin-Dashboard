"use strict";

/**
 * Y4 — the Engine.IO heartbeat is explicit and bounded.
 *
 * `pingInterval + pingTimeout` is how long a silent robot link goes unnoticed at both ends (the
 * Pi's python-engineio takes both from the handshake). It was the library default, 25 s + 20 s.
 * Now it is 10 s + 5 s by default, overridable, and refused at boot above 15 s — the bound that
 * lets the robot pause (detection + its 10 s grace + its 0.1 s tick) before its 60 s lease, renewed
 * once half has run out, can expire and be reassigned.
 *
 * The handshake block runs a real Socket.IO server with the resolved options and reads what a
 * real client is told. The last block boots the real `server.js` in a child process, in the shape
 * `verificationThresholdsValidation.test.js` uses (a closed database port, so an admitted boot is
 * stopped at its first connection attempt and a refused one exits before it).
 */

const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");
const { Server } = require("socket.io");
const { io: ioClient } = require("socket.io-client");

const socketTiming = require("../../../src/config/socketTiming");

const BACKEND = path.join(__dirname, "../../..");

describe("socketTiming — the rule", () => {
  test("defaults are 10 000 ms and 5 000 ms, a 15 s detection bound", () => {
    expect(socketTiming.resolve({})).toEqual({ pingInterval: 10_000, pingTimeout: 5_000 });
    expect(socketTiming.MAX_DETECTION_MS).toBe(15_000);
    expect(socketTiming.DEFAULTS.pingInterval + socketTiming.DEFAULTS.pingTimeout).toBeLessThanOrEqual(socketTiming.MAX_DETECTION_MS);
  });

  test("each may be overridden by a plain positive integer of milliseconds within the bound", () => {
    expect(socketTiming.resolve({ SOCKET_PING_INTERVAL_MS: "8000", SOCKET_PING_TIMEOUT_MS: "4000" })).toEqual({
      pingInterval: 8000,
      pingTimeout: 4000,
    });
    expect(socketTiming.resolve({ SOCKET_PING_INTERVAL_MS: "  " })).toEqual(socketTiming.DEFAULTS); // blank = unset
  });

  test("a heartbeat longer than the bound is refused, naming both variables and never a value", () => {
    for (const env of [{ SOCKET_PING_INTERVAL_MS: "25000" }, { SOCKET_PING_TIMEOUT_MS: "20000" }, { SOCKET_PING_INTERVAL_MS: "10000", SOCKET_PING_TIMEOUT_MS: "5001" }]) {
      expect(() => socketTiming.resolve(env)).toThrow(/SOCKET_PING_INTERVAL_MS \+ SOCKET_PING_TIMEOUT_MS must not exceed 15000 ms/);
    }
  });

  test("a malformed value is refused rather than coerced", () => {
    for (const bad of ["0", "-5", "5.5", "0x1388", "5e3", " 5000", "five"]) {
      const { timing, problems } = socketTiming.evaluate({ SOCKET_PING_TIMEOUT_MS: bad });
      expect(timing).toBeNull();
      expect(problems).toEqual(["SOCKET_PING_TIMEOUT_MS must be a plain positive integer of milliseconds."]);
    }
  });
});

describe("socketTiming — the bound against the register's lease", () => {
  // The Pi's side of the invariant, each one refused or floored there: grace ≤ 10 s
  // (`validate_loss_policy`), control tick ≤ 2 s (`agent_hz` ≥ 0.5), heartbeat every 2 s.
  const PI_MAX_GRACE_S = 10;
  const PI_MAX_TICK_S = 2;
  const PI_HEARTBEAT_S = 2;

  test("detection + the Pi's worst-case grace and tick land before the earliest lease expiry", () => {
    const lease = require("../../../src/engine/config/service").loadRegister().entries.get("lease.duration");
    expect({ default: lease.default, unit: lease.unit }).toEqual({ default: 60, unit: "s" });

    const earliestExpiryS = lease.default / 2 - PI_HEARTBEAT_S; // renewed once half has run out
    const pauseByS = socketTiming.MAX_DETECTION_MS / 1000 + PI_MAX_GRACE_S + PI_MAX_TICK_S;
    expect(pauseByS).toBeLessThan(earliestExpiryS); // 27 < 28
  });
});

describe("socketTiming — what a real client is told", () => {
  test("a Socket.IO server built with the resolved options advertises them in the handshake", async () => {
    const httpServer = http.createServer();
    const io = new Server(httpServer, { ...socketTiming.resolve({}) });
    await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const client = ioClient(`http://127.0.0.1:${httpServer.address().port}`, { transports: ["websocket"], reconnection: false });
    try {
      // The Engine.IO open packet as the client received it: the values its liveness timer runs on.
      const handshake = await new Promise((resolve, reject) => {
        client.io.once("open", () => client.io.engine.once("handshake", resolve));
        client.io.engine?.once?.("handshake", resolve);
        client.once("connect_error", reject);
      });
      expect(handshake.pingInterval).toBe(10_000);
      expect(handshake.pingTimeout).toBe(5_000);
    } finally {
      client.close();
      io.close();
      await new Promise((resolve) => httpServer.close(resolve));
    }
  });
});

describe("server.js builds its Socket.IO server with the resolved heartbeat", () => {
  test("resolved before the server is created, and passed to it", () => {
    const source = fs.readFileSync(path.join(BACKEND, "server.js"), "utf8");
    const resolveAt = source.indexOf("socketTiming.resolve(process.env)");
    const serverAt = source.indexOf("const io = new Server(server, {");
    expect(resolveAt).toBeGreaterThan(-1);
    expect(serverAt).toBeGreaterThan(resolveAt);
    const options = source.slice(serverAt, source.indexOf("});", serverAt));
    expect(options).toContain("pingInterval: socketHeartbeat.pingInterval");
    expect(options).toContain("pingTimeout: socketHeartbeat.pingTimeout");
  });
});

function boot(overrides) {
  const script = [
    'require("./src/config/env");',
    'require("@prisma/client");',
    "const o = JSON.parse(process.env.BOOT_TEST_OVERRIDES);",
    "for (const [k, v] of Object.entries(o)) { if (v === null) delete process.env[k]; else process.env[k] = v; }",
    'require("./server.js");',
  ].join("\n");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", script], {
      cwd: BACKEND,
      env: {
        ...process.env,
        DATABASE_URL: "postgresql://boot-test@127.0.0.1:1/never",
        DATABASE_URL_LOCAL: "postgresql://boot-test@127.0.0.1:1/never",
        REDIS_ENABLED: "false",
        PORT: "0",
        HOST: "127.0.0.1",
        BOOT_TEST_OVERRIDES: JSON.stringify(overrides),
      },
    });
    let output = "";
    let reachedDatabase = false;
    const collect = (chunk) => {
      output += chunk.toString();
      if (!reachedDatabase && /Prisma connect failed/.test(output)) {
        reachedDatabase = true;
        child.kill();
      }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("exit", (code) => resolve({ code, output, reachedDatabase }));
  });
}

const SECRETS = { JWT_SECRET: "jwt-secret-for-boot-tests-0123456789abcdef", ENGINE_ENABLED: "false" };

describe("a real server.js boot", () => {
  jest.setTimeout(60_000);

  test("the default heartbeat is admitted and logged; the boot goes on to the database", async () => {
    const result = await boot({ ...SECRETS, SOCKET_PING_INTERVAL_MS: null, SOCKET_PING_TIMEOUT_MS: null });
    expect(result.output).toMatch(/Socket\.IO heartbeat/);
    expect(result.output).not.toMatch(/Socket\.IO heartbeat timing is not usable/);
    expect(result.reachedDatabase).toBe(true);
  });

  test("the library's old 25 s + 20 s is refused before anything connects", async () => {
    const result = await boot({ ...SECRETS, SOCKET_PING_INTERVAL_MS: "25000", SOCKET_PING_TIMEOUT_MS: "20000" });
    expect(result.output).toMatch(/Refusing to start: Socket\.IO heartbeat timing is not usable/);
    expect(result.reachedDatabase).toBe(false);
    expect(result.code).not.toBe(0);
  });
});
