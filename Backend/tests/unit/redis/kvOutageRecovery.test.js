"use strict";

/**
 * What a Redis outage wrote, and what the facade does with it on recovery — against a fake
 * client with a real store, so the outage can be started and ended by the test. The same three
 * cases run against a real server in `tests/integration/redisKv.integration.test.js`.
 *
 * The defect this pins: during an outage writes go to the in-memory store; on reconnect reads
 * went back to Redis, which still held the values from *before* the outage. A robot paired
 * during the outage was then offered its revoked session token, and the outage-time copy was
 * kept and served again during the next outage.
 */

const mockStore = { strings: new Map(), ttlMs: new Map(), sets: new Map(), down: false, execFailures: 0, beforeExec: null, commands: [] };

function mockUnavailable() {
  const err = new Error("connect ECONNREFUSED");
  err.code = "ECONNREFUSED";
  return err;
}

jest.mock("ioredis", () => {
  const apply = (op, args) => {
    const [key, ...rest] = args;
    if (op === "set") {
      mockStore.strings.set(key, rest[0]);
      const flag = String(rest[1] || "").toUpperCase();
      if (flag === "PX") mockStore.ttlMs.set(key, Number(rest[2]));
      else if (flag === "EX") mockStore.ttlMs.set(key, Number(rest[2]) * 1000);
      else mockStore.ttlMs.delete(key);
      return "OK";
    }
    if (op === "get") return mockStore.strings.has(key) ? mockStore.strings.get(key) : null;
    if (op === "del") {
      for (const k of args) {
        mockStore.strings.delete(k);
        mockStore.ttlMs.delete(k);
        mockStore.sets.delete(k);
      }
      return args.length;
    }
    if (op === "sadd") {
      const set = mockStore.sets.get(key) || new Set();
      rest.forEach((m) => set.add(String(m)));
      mockStore.sets.set(key, set);
      return rest.length;
    }
    if (op === "srem") {
      const set = mockStore.sets.get(key);
      rest.forEach((m) => set && set.delete(String(m)));
      return rest.length;
    }
    if (op === "smembers") return [...(mockStore.sets.get(key) || [])];
    throw new Error(`unmodelled ${op}`);
  };

  return class FakeRedis {
    on() {
      return this;
    }

    async connect() {
      if (mockStore.down) throw mockUnavailable();
    }

    disconnect() {}

    async quit() {}

    pipeline() {
      const queued = [];
      const builder = {};
      for (const op of ["set", "get", "del", "sadd", "srem"]) {
        builder[op] = (...args) => {
          queued.push([op, args]);
          return builder;
        };
      }
      builder.exec = async () => {
        if (mockStore.beforeExec) {
          const hook = mockStore.beforeExec;
          mockStore.beforeExec = null;
          await hook();
        }
        if (mockStore.down) throw mockUnavailable();
        mockStore.commands.push(...queued.map(([op, args]) => [op, ...args]));
        if (mockStore.execFailures > 0) {
          mockStore.execFailures -= 1;
          return queued.map(() => [new Error("LOADING"), null]);
        }
        return queued.map(([op, args]) => [null, apply(op, args)]);
      };
      return builder;
    }

    // Single commands, as the facade issues them outside a pipeline.
    async set(...args) {
      if (mockStore.down) throw mockUnavailable();
      return apply("set", args);
    }

    async get(...args) {
      if (mockStore.down) throw mockUnavailable();
      return apply("get", args);
    }

    async del(...args) {
      if (mockStore.down) throw mockUnavailable();
      return apply("del", args);
    }

    async sadd(...args) {
      if (mockStore.down) throw mockUnavailable();
      return apply("sadd", args);
    }

    async srem(...args) {
      if (mockStore.down) throw mockUnavailable();
      return apply("srem", args);
    }

    async smembers(...args) {
      if (mockStore.down) throw mockUnavailable();
      return apply("smembers", args);
    }
  };
});

const { initKv } = require("../../../src/cache/kv");

const quiet = { info() {}, warn() {}, error() {} };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function openKv({ configured = true } = {}) {
  const saved = { url: process.env.REDIS_URL, enabled: process.env.REDIS_ENABLED };
  process.env.REDIS_URL = configured ? "redis://fake:6379" : "";
  process.env.REDIS_ENABLED = configured ? "true" : "false";
  try {
    return await initKv({ logger: quiet });
  } finally {
    if (saved.url === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = saved.url;
    process.env.REDIS_ENABLED = saved.enabled;
  }
}

/** Waits out the facade's reconnect backoff (1 s, then 2 s, …). */
async function untilConnected(kv, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (!kv.health().redis && Date.now() < deadline) await sleep(50);
  return kv.health().redis;
}

let handle;

beforeEach(() => {
  mockStore.strings.clear();
  mockStore.ttlMs.clear();
  mockStore.sets.clear();
  mockStore.down = false;
  mockStore.execFailures = 0;
  mockStore.beforeExec = null;
  mockStore.commands.length = 0;
});

afterEach(async () => {
  if (handle) await handle.close();
  handle = null;
});

describe("cache/kv — recovery from an outage never serves the value Redis held before it", () => {
  test("a key overwritten during the outage holds the outage's value after recovery, never the pre-outage one", async () => {
    handle = await openKv();
    const { kv } = handle;
    await kv.set("session:R1", "token-before", { ex: 60 });

    mockStore.down = true;
    await kv.set("session:R1", "token-during", { ex: 60 });
    expect(await kv.get("session:R1")).toBe("token-during");
    expect(kv.health()).toMatchObject({ redis: false, outagePending: 1 });

    mockStore.down = false;
    expect(await untilConnected(kv)).toBe(true);

    // Written back, with the TTL it had left — served from Redis, not from memory.
    expect(await kv.get("session:R1")).toBe("token-during");
    expect(mockStore.strings.get("session:R1")).toBe("token-during");
    expect(mockStore.ttlMs.get("session:R1")).toBeGreaterThan(55_000);
    expect(mockStore.ttlMs.get("session:R1")).toBeLessThanOrEqual(60_000);
    expect(kv.health()).toMatchObject({ outagePending: 0, memoryEntries: 0 });
  }, 10000);

  test("the outage-time copy is not served again during the next outage", async () => {
    handle = await openKv();
    const { kv } = handle;
    mockStore.down = true;
    await kv.set("robot:R1", '{"lat":1}', { ex: 60 });
    mockStore.down = false;
    expect(await untilConnected(kv)).toBe(true);

    mockStore.down = true;
    expect(await kv.get("robot:R1")).toBeNull();
  }, 10000);

  test("a key deleted during the outage is deleted in Redis on recovery", async () => {
    handle = await openKv();
    const { kv } = handle;
    await kv.set("taskPath:T1", "route", { ex: 60 });

    mockStore.down = true;
    await kv.del("taskPath:T1");
    mockStore.down = false;
    expect(await untilConnected(kv)).toBe(true);

    expect(await kv.get("taskPath:T1")).toBeNull();
  }, 10000);

  test("keys nobody touched during the outage keep their Redis value", async () => {
    handle = await openKv();
    const { kv } = handle;
    await kv.set("robot:R2", "kept", { ex: 60 });

    mockStore.down = true;
    await kv.set("robot:R1", "x", { ex: 60 });
    mockStore.down = false;
    expect(await untilConnected(kv)).toBe(true);

    expect(await kv.get("robot:R2")).toBe("kept");
  }, 10000);

  test("set changes are replayed member by member, the last change to each member winning", async () => {
    handle = await openKv();
    const { kv } = handle;
    await kv.sadd("robots:all", "R-A", "R-B");

    mockStore.down = true;
    await kv.sadd("robots:all", "R-C");
    await kv.srem("robots:all", "R-A");
    await kv.sadd("robots:all", "R-D");
    await kv.srem("robots:all", "R-D");
    mockStore.down = false;
    expect(await untilConnected(kv)).toBe(true);

    expect((await kv.smembers("robots:all")).sort()).toEqual(["R-B", "R-C"]);
  }, 10000);

  test("a reconciliation Redis refuses keeps the facade on its fallback, and the next attempt completes it", async () => {
    handle = await openKv();
    const { kv } = handle;
    await kv.set("session:R1", "token-before", { ex: 60 });

    mockStore.down = true;
    await kv.set("session:R1", "token-during", { ex: 60 });
    mockStore.execFailures = 1;
    mockStore.down = false;

    // The first attempt connects, is refused, and stays on memory with nothing lost.
    await sleep(1300);
    expect(kv.health()).toMatchObject({ redis: false, outagePending: 1 });
    expect(await kv.get("session:R1")).toBe("token-during");

    // The second (2 s later) reconciles.
    expect(await untilConnected(kv, 4000)).toBe(true);
    expect(await kv.get("session:R1")).toBe("token-during");
  }, 10000);

  test("a write that lands while reconciliation is in flight is reconciled before Redis answers again", async () => {
    handle = await openKv();
    const { kv } = handle;
    await kv.set("session:R1", "token-before", { ex: 60 });
    await kv.set("session:R2", "token-before", { ex: 60 });

    mockStore.down = true;
    await kv.set("session:R1", "during", { ex: 60 });
    mockStore.down = false;
    // Lands between the first pass being sent and Redis answering it.
    mockStore.beforeExec = () => kv.set("session:R2", "late", { ex: 60 });

    expect(await untilConnected(kv)).toBe(true);
    expect(await kv.get("session:R1")).toBe("during");
    expect(await kv.get("session:R2")).toBe("late");
  }, 10000);

  // The defect this pins: recovery used to DEL every key the outage touched, so a pairing
  // lockout imposed during the outage was lifted the moment Redis came back — the hazard the
  // runbook rejects `volatile-lru` for — and the attempt counter restarted its window.
  test("a pairing lockout imposed during the outage stays in force after recovery, with its remaining TTL", async () => {
    handle = await openKv();
    const { kv } = handle;
    mockStore.down = true;
    for (let i = 0; i < 5; i += 1) await kv.incr("pairingAttempts:R1", { ex: 300 });
    await kv.set("pairingLocked:R1", "1", { ex: 300 });
    mockStore.down = false;
    expect(await untilConnected(kv)).toBe(true);

    expect(await kv.get("pairingLocked:R1")).toBe("1");
    expect(await kv.get("pairingAttempts:R1")).toBe("5");
    expect(mockStore.ttlMs.get("pairingLocked:R1")).toBeGreaterThan(295_000);
    expect(mockStore.ttlMs.get("pairingLocked:R1")).toBeLessThanOrEqual(300_000);
  }, 10000);

  test("an entry that expired during the outage is deleted in Redis, not written back", async () => {
    handle = await openKv();
    const { kv } = handle;
    await kv.set("pairing:R1", "code-before", { ex: 60 });
    mockStore.down = true;
    await kv.set("pairing:R1", "code-during", { ex: 1 });
    await sleep(1100);
    mockStore.down = false;
    expect(await untilConnected(kv)).toBe(true);

    expect(await kv.get("pairing:R1")).toBeNull();
    expect(mockStore.strings.has("pairing:R1")).toBe(false);
  }, 10000);
});

describe("cache/kv — with Redis not configured nothing is tracked", () => {
  test("the in-memory store is the store: no outage records and nothing is cleared", async () => {
    handle = await openKv({ configured: false });
    const { kv } = handle;
    await kv.set("robot:R1", "v", { ex: 60 });
    await kv.sadd("robots:all", "R1");
    await kv.del("robot:R9");
    expect(kv.health()).toMatchObject({ configured: false, outagePending: 0, memoryEntries: 1 });
    expect(await kv.get("robot:R1")).toBe("v");
  });
});
