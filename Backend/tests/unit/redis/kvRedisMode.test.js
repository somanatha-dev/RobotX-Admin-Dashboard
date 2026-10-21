"use strict";

/**
 * The commands the KV facade sends when Redis is connected — checked against a fake client
 * that records them, because the in-memory fallback cannot show what reached Redis.
 *
 *   - A TTL given in the ioredis positional form (`"EX", s`, as `cellPairCache.write` and
 *     `capacityPricingClient.write` pass it) reaches Redis as an expiry. It used to be
 *     dropped, and the key was stored with TTL -1.
 *   - `incr` with a TTL is one MULTI (INCR + EXPIRE), so a connection lost between the two
 *     cannot leave a counter that never expires.
 */

const mockCalls = [];
let mockMultiResult = null;

jest.mock("ioredis", () =>
  class FakeRedis {
    on() {
      return this;
    }

    async connect() {}

    disconnect() {}

    async quit() {}

    async set(...args) {
      mockCalls.push(["set", ...args]);
      return "OK";
    }

    async incr(key) {
      mockCalls.push(["incr", key]);
      return 1;
    }

    async expire(key, seconds) {
      mockCalls.push(["expire", key, seconds]);
      return 1;
    }

    multi() {
      const queued = [];
      const builder = {
        incr(key) {
          queued.push(["incr", key]);
          return builder;
        },
        expire(key, seconds) {
          queued.push(["expire", key, seconds]);
          return builder;
        },
        exec: async () => {
          mockCalls.push(["multi", ...queued]);
          return mockMultiResult || queued.map(([op]) => [null, op === "incr" ? 3 : 1]);
        },
      };
      return builder;
    }

    pipeline() {
      const queued = [];
      const builder = {
        set(...args) {
          queued.push(["set", ...args]);
          return builder;
        },
        get(key) {
          queued.push(["get", key]);
          return builder;
        },
        exec: async () => {
          mockCalls.push(["pipeline", ...queued]);
          return queued.map(() => [null, "OK"]);
        },
      };
      return builder;
    }
  });

const { initKv, redisSettings } = require("../../../src/cache/kv");

const quiet = { info() {}, warn() {}, error() {} };

async function connectedKv() {
  const saved = { url: process.env.REDIS_URL, enabled: process.env.REDIS_ENABLED };
  process.env.REDIS_URL = "redis://fake:6379";
  process.env.REDIS_ENABLED = "true";
  try {
    return await initKv({ logger: quiet });
  } finally {
    if (saved.url === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = saved.url;
    process.env.REDIS_ENABLED = saved.enabled;
  }
}

beforeEach(() => {
  mockCalls.length = 0;
  mockMultiResult = null;
});

describe("cache/kv — TTLs reach Redis in every argument form", () => {
  test.each([
    ["{ ex }", [{ ex: 900 }], 900],
    ['"EX", seconds', ["EX", 900], 900],
    ['"PX", milliseconds (rounded up to whole seconds)', ["PX", 1500], 2],
  ])("set(key, value, %s) sends SET … EX", async (_label, options, seconds) => {
    const { kv, close } = await connectedKv();
    expect(kv.health().redis).toBe(true);
    await kv.set("engine:route:cell:a:b:p:12", "{}", ...options);
    expect(mockCalls).toEqual([["set", "engine:route:cell:a:b:p:12", "{}", "EX", seconds]]);
    await close();
  });

  test("set without a TTL sends a plain SET", async () => {
    const { kv, close } = await connectedKv();
    await kv.set("config:active", "7");
    expect(mockCalls).toEqual([["set", "config:active", "7"]]);
    await close();
  });

  test("pipeline().set passes the positional TTL through", async () => {
    const { kv, close } = await connectedKv();
    await kv.pipeline().set("k", "v", "EX", 30).exec();
    expect(mockCalls).toEqual([["pipeline", ["set", "k", "v", "EX", 30]]]);
    await close();
  });
});

describe("cache/kv — incr with a TTL is atomic", () => {
  test("INCR and EXPIRE are sent as one MULTI", async () => {
    const { kv, close } = await connectedKv();
    expect(await kv.incr("pairingAttempts:R1", { ex: 300 })).toBe(3);
    expect(mockCalls).toEqual([["multi", ["incr", "pairingAttempts:R1"], ["expire", "pairingAttempts:R1", 300]]]);
    await close();
  });

  test("incr without a TTL stays a single INCR", async () => {
    const { kv, close } = await connectedKv();
    expect(await kv.incr("counter")).toBe(1);
    expect(mockCalls).toEqual([["incr", "counter"]]);
    await close();
  });

  test("a failed INCR inside the MULTI falls back to memory instead of returning undefined", async () => {
    const { kv, close } = await connectedKv();
    mockMultiResult = [[new Error("WRONGTYPE"), null], [null, 1]];
    expect(await kv.incr("pairingAttempts:R2", { ex: 300 })).toBe(1);
    expect(kv.health().redis).toBe(false);
    await close();
  });
});

describe("cache/kv — redisSettings is the one reading of the environment", () => {
  test.each([
    [{ REDIS_URL: "redis://h:6379", REDIS_ENABLED: "true" }, true],
    [{ REDIS_URL: "redis://h:6379" }, true],
    [{ REDIS_URL: "redis://h:6379", REDIS_ENABLED: "FALSE" }, false],
    [{ REDIS_URL: "  ", REDIS_ENABLED: "true" }, false],
    [{}, false],
  ])("%j → configured %s", (env, configured) => {
    expect(redisSettings(env).configured).toBe(configured);
  });

  test("connect timeout defaults to 5 s", () => {
    expect(redisSettings({}).connectTimeoutMs).toBe(5000);
    expect(redisSettings({ REDIS_CONNECT_TIMEOUT_MS: "250" }).connectTimeoutMs).toBe(250);
  });
});
