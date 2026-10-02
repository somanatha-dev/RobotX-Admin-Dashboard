"use strict";

/**
 * B1 — `kv.smembersMany(keys)`: N `SMEMBERS` in one pipelined round trip, answering exactly
 * what N sequential `smembers(key)` calls answer — including when Redis fails part-way.
 *
 * The sequential facade's error semantics are the reference: a failed `smembers` disables
 * Redis (`disableRedis`) and answers that key from the in-memory sets, and every later call
 * then reads memory too. The batch must reproduce that key for key, so both variants run
 * against two identically seeded fake Redis servers and are compared.
 */

const mockStore = new Map(); // key -> Set, shared by every fake client in a test
let mockFailKeys = new Set();
let mockFailExec = false;

jest.mock("ioredis", () =>
  class FakeRedis {
    constructor() {
      this.handlers = {};
    }

    on(event, fn) {
      this.handlers[event] = fn;
      return this;
    }

    async connect() {
      return undefined;
    }

    disconnect() {}

    async quit() {}

    async smembers(key) {
      if (mockFailKeys.has(key)) throw Object.assign(new Error(`ERR ${key}`), { code: "WRONGTYPE" });
      return mockStore.has(key) ? [...mockStore.get(key)] : [];
    }

    async sadd(key, ...members) {
      if (!mockStore.has(key)) mockStore.set(key, new Set());
      for (const m of members) mockStore.get(key).add(String(m));
      return members.length;
    }

    pipeline() {
      const ops = [];
      const builder = {
        smembers(key) {
          ops.push(key);
          return builder;
        },
        exec: async () => {
          if (mockFailExec) throw new Error("ECONNRESET");
          return ops.map((key) =>
            mockFailKeys.has(key) ? [Object.assign(new Error(`ERR ${key}`), { code: "WRONGTYPE" }), null] : [null, mockStore.has(key) ? [...mockStore.get(key)] : []],
          );
        },
      };
      return builder;
    }
  });

const { initKv } = require("../../../src/cache/kv");

const quiet = { info() {}, warn() {}, error() {} };

async function withRedis(fn) {
  const saved = { url: process.env.REDIS_URL, enabled: process.env.REDIS_ENABLED };
  process.env.REDIS_URL = "redis://fake:6379";
  process.env.REDIS_ENABLED = "true";
  try {
    return await fn();
  } finally {
    if (saved.url === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = saved.url;
    if (saved.enabled === undefined) delete process.env.REDIS_ENABLED;
    else process.env.REDIS_ENABLED = saved.enabled;
  }
}

beforeEach(() => {
  mockStore.clear();
  mockFailKeys = new Set();
  mockFailExec = false;
});

describe("kv.smembersMany — in-memory mode", () => {
  test("one array per key, in key order, [] for a missing key — as sequential smembers", async () => {
    const { kv, close } = await initKv({ logger: quiet });
    await kv.sadd("a", "x", "y");
    await kv.sadd("c", "z");
    const keys = ["a", "missing", "c", "a"];
    const batched = await kv.smembersMany(keys);
    const sequential = [];
    for (const key of keys) {
      // eslint-disable-next-line no-await-in-loop
      sequential.push(await kv.smembers(key));
    }
    expect(batched).toEqual(sequential);
    expect(await kv.smembersMany([])).toEqual([]);
    await close();
  });
});

describe("kv.smembersMany — Redis mode, one pipeline", () => {
  async function seeded() {
    const { kv, close } = await initKv({ logger: quiet });
    await kv.sadd("k1", "a1");
    await kv.sadd("k2", "a2", "a3");
    await kv.sadd("k4", "a4");
    return { kv, close };
  }

  test("a healthy pipeline answers every key from Redis", async () => {
    await withRedis(async () => {
      const { kv, close } = await seeded();
      expect(kv.health().redis).toBe(true);
      expect((await kv.smembersMany(["k1", "k2", "k3", "k4"])).map((m) => [...m].sort())).toEqual([["a1"], ["a2", "a3"], [], ["a4"]]);
      expect(kv.health().redis).toBe(true);
      await close();
    });
  });

  test("a failed command mid-pipeline behaves exactly as the sequential calls would", async () => {
    await withRedis(async () => {
      const keys = ["k1", "k2", "k3", "k4"];

      const seqKv = await seeded();
      mockFailKeys = new Set(["k2"]);
      const sequential = [];
      for (const key of keys) {
        // eslint-disable-next-line no-await-in-loop
        sequential.push(await seqKv.kv.smembers(key));
      }
      const seqHealth = seqKv.kv.health();
      await seqKv.close();

      mockFailKeys = new Set();
      mockStore.clear();
      const batKv = await seeded();
      mockFailKeys = new Set(["k2"]);
      const batched = await batKv.kv.smembersMany(keys);
      const batHealth = batKv.kv.health();
      await batKv.close();

      expect(batched).toEqual(sequential);
      // k1 from Redis; k2 failed and Redis was disabled; k2..k4 from the (empty) memory sets.
      expect(batched).toEqual([["a1"], [], [], []]);
      expect(batHealth.redis).toBe(seqHealth.redis);
      expect(batHealth.redis).toBe(false);
    });
  });

  test("a pipeline that fails outright behaves as the first sequential call failing", async () => {
    await withRedis(async () => {
      const { kv, close } = await seeded();
      mockFailExec = true;
      expect(await kv.smembersMany(["k1", "k2"])).toEqual([[], []]);
      expect(kv.health().redis).toBe(false);
      await close();
    });
  });
});
