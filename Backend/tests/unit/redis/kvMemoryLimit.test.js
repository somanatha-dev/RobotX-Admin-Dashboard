"use strict";

/**
 * A Redis at its memory limit under `maxmemory-policy noeviction`: every write is refused with
 * an OOM reply, reads and DEL still work, and the server keeps accepting connections.
 *
 * Two defects this pins, both found while confirming the runbook's move to `noeviction`:
 *   - a pipeline's writes refused with OOM were mapped to `null` and the facade stayed on Redis,
 *     so the telemetry batches dropped every write silently and older values were read back;
 *   - each reconnect reset the backoff to 1 s, so a Redis that accepted the connection and then
 *     refused the next write was reconnected to about once a second, indefinitely.
 */

const mockStore = { strings: new Map(), sets: new Map(), oom: false, connects: 0 };

jest.mock("ioredis", () => {
  const oomError = () => new Error("OOM command not allowed when used memory > 'maxmemory'.");
  const WRITES = new Set(["set", "sadd", "incr", "expire"]);
  const apply = (op, args) => {
    const [key, ...rest] = args;
    if (mockStore.oom && WRITES.has(op)) throw oomError();
    switch (op) {
      case "set":
        mockStore.strings.set(key, String(rest[0]));
        return "OK";
      case "get":
        return mockStore.strings.has(key) ? mockStore.strings.get(key) : null;
      case "del":
        args.forEach((k) => {
          mockStore.strings.delete(k);
          mockStore.sets.delete(k);
        });
        return args.length;
      case "sadd": {
        const set = mockStore.sets.get(key) || new Set();
        rest.forEach((m) => set.add(String(m)));
        mockStore.sets.set(key, set);
        return rest.length;
      }
      case "srem":
        rest.forEach((m) => mockStore.sets.get(key)?.delete(String(m)));
        return rest.length;
      case "smembers":
        return [...(mockStore.sets.get(key) || [])];
      default:
        throw new Error(`unmodelled ${op}`);
    }
  };
  class FakeRedis {
    on() {
      return this;
    }

    async connect() {
      mockStore.connects += 1;
    }

    disconnect() {}

    async quit() {}

    pipeline() {
      const queued = [];
      const builder = {};
      for (const op of ["set", "get", "del", "sadd", "srem", "smembers"]) {
        builder[op] = (...args) => {
          queued.push([op, args]);
          return builder;
        };
      }
      // Like Redis: each command answers on its own; a refused write does not fail the batch.
      builder.exec = async () =>
        queued.map(([op, args]) => {
          try {
            return [null, apply(op, args)];
          } catch (err) {
            return [err, null];
          }
        });
      return builder;
    }
  }
  for (const op of ["set", "get", "del", "sadd", "srem", "smembers"]) {
    FakeRedis.prototype[op] = async function command(...args) {
      return apply(op, args);
    };
  }
  return FakeRedis;
});

const { initKv } = require("../../../src/cache/kv");

const quiet = { info() {}, warn() {}, error() {} };

async function openKv() {
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

let handle;

beforeEach(() => {
  mockStore.strings.clear();
  mockStore.sets.clear();
  mockStore.oom = false;
  mockStore.connects = 0;
});

afterEach(async () => {
  jest.useRealTimers();
  if (handle) await handle.close();
  handle = null;
});

describe("cache/kv — a full Redis (noeviction) takes the fallback path", () => {
  test("a pipeline whose writes are refused falls back and is replayed into memory", async () => {
    handle = await openKv();
    const { kv } = handle;
    await kv.set("robot:R1", "older", { ex: 15 });

    mockStore.oom = true;
    const out = await kv.pipeline().get("robot:R1").set("robot:R1", "newer", { ex: 15 }).exec();

    expect(kv.health().redis).toBe(false);
    // The batch ran on memory: the read answers from it (nothing there yet), the write landed in it.
    expect(out).toEqual([null, undefined]);
    expect(await kv.get("robot:R1")).toBe("newer");
  });

  test("a single refused write falls back too (unchanged behaviour)", async () => {
    handle = await openKv();
    const { kv } = handle;
    mockStore.oom = true;
    await kv.set("session:R1", "t", { ex: 60 });
    expect(kv.health().redis).toBe(false);
    expect(await kv.get("session:R1")).toBe("t");
  });

  test("setManyEx (the simulator's batch) falls back when its writes are refused", async () => {
    handle = await openKv();
    const { kv } = handle;
    mockStore.oom = true;
    await kv.setManyEx([{ key: "robot:SIM-1", value: "v", ex: 15 }]);
    expect(kv.health().redis).toBe(false);
    expect(await kv.get("robot:SIM-1")).toBe("v");
  });
});

describe("cache/kv — a full Redis is not switched back to while it would refuse the outage's set changes", () => {
  test("set members changed during the outage keep the facade on memory until Redis accepts them", async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick"] });
    handle = await openKv();
    const { kv } = handle;
    mockStore.oom = true;
    await kv.sadd("engine:idx:rnsit-shard:fine-A:IDLE", "agent-1"); // refused → memory, tracked
    expect(kv.health().redis).toBe(false);

    await jest.advanceTimersByTimeAsync(1000); // reconnect: the replayed SADD is refused
    expect(kv.health()).toMatchObject({ redis: false, outagePending: 1 });
    expect(await kv.smembers("engine:idx:rnsit-shard:fine-A:IDLE")).toEqual(["agent-1"]);

    mockStore.oom = false; // room again
    await jest.advanceTimersByTimeAsync(2000);
    expect(kv.health()).toMatchObject({ redis: true, outagePending: 0 });
    expect(await kv.smembers("engine:idx:rnsit-shard:fine-A:IDLE")).toEqual(["agent-1"]);
  });
});

describe("cache/kv — reconnecting to a Redis that keeps refusing writes backs off", () => {
  test("each failed recovery waits longer: 1 s, 2 s, 4 s — not a reconnect every second", async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick"] });
    handle = await openKv();
    const { kv } = handle;
    expect(mockStore.connects).toBe(1);

    mockStore.oom = true;
    const attemptsAt = [];
    let clock = 0;
    await kv.set("k", "v"); // refused → fallback; first attempt in 1 s
    for (let step = 0; step < 80 && attemptsAt.length < 3; step += 1) {
      const before = mockStore.connects;
      await jest.advanceTimersByTimeAsync(100);
      clock += 100;
      if (mockStore.connects > before) {
        attemptsAt.push(clock);
        // The reconnect connects, but writing the outage's "k" back is refused while Redis is
        // full, so the facade stays on memory and backs off further.
        await kv.set("k", "v");
        expect(kv.health().redis).toBe(false);
      }
    }

    const gaps = attemptsAt.map((at, i) => at - (i === 0 ? 0 : attemptsAt[i - 1]));
    expect(gaps).toEqual([1000, 2000, 4000]);
  });

  test("a connection that stayed healthy for the stable period starts the backoff again from 1 s", async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick"] });
    handle = await openKv();
    const { kv } = handle;

    mockStore.oom = true;
    await kv.set("k", "v");
    mockStore.oom = false; // room again before attempt 1, which reconnects and writes "k" back
    await jest.advanceTimersByTimeAsync(1000);
    expect(kv.health().redis).toBe(true);

    await jest.advanceTimersByTimeAsync(31_000); // healthy for longer than the stable period
    mockStore.oom = true;
    await kv.set("k", "v"); // a new, unrelated outage
    const before = mockStore.connects;
    await jest.advanceTimersByTimeAsync(1000);
    expect(mockStore.connects).toBe(before + 1);
  });
});
