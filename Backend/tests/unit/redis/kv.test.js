const { createTestKv } = require("../../helpers/testKv");

// These tests exercise `kv.js` running in its in-memory fallback mode (no
// REDIS_URL configured anywhere in the test environment — see
// tests/setup/env.js), which is itself the production code path used
// whenever Redis is unavailable. It is not a stand-in/mock of kv.js — it is
// kv.js, verified without depending on a live Redis instance.
describe("cache/kv — get/set/del", () => {
  let kv;
  beforeEach(async () => ({ kv } = await createTestKv()));

  test("set then get roundtrips a value", async () => {
    await kv.set("foo", "bar");
    expect(await kv.get("foo")).toBe("bar");
  });

  test("get returns null for a key that was never set", async () => {
    expect(await kv.get("never-set")).toBeNull();
  });

  test("del removes a key", async () => {
    await kv.set("foo", "bar");
    await kv.del("foo");
    expect(await kv.get("foo")).toBeNull();
  });

  test("a value set with a TTL expires after it elapses", async () => {
    jest.useFakeTimers();
    try {
      await kv.set("short-lived", "v", { ex: 1 });
      expect(await kv.get("short-lived")).toBe("v");
      jest.advanceTimersByTime(1100);
      expect(await kv.get("short-lived")).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  test("a value set without a TTL never expires", async () => {
    jest.useFakeTimers();
    try {
      await kv.set("forever", "v");
      jest.advanceTimersByTime(1000 * 60 * 60 * 24);
      expect(await kv.get("forever")).toBe("v");
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("cache/kv — mget (batched reads, F9/F14/F17)", () => {
  let kv;
  beforeEach(async () => ({ kv } = await createTestKv()));

  test("returns values in the same order as the requested keys", async () => {
    await kv.set("a", "1");
    await kv.set("b", "2");
    await kv.set("c", "3");
    expect(await kv.mget(["c", "a", "b"])).toEqual(["3", "1", "2"]);
  });

  test("missing/expired keys come back as null, positionally, matching Redis MGET semantics", async () => {
    await kv.set("a", "1");
    expect(await kv.mget(["a", "missing", "also-missing"])).toEqual(["1", null, null]);
  });

  test("an empty key list returns an empty array", async () => {
    expect(await kv.mget([])).toEqual([]);
  });
});

describe("cache/kv — sets (sadd/srem/smembers)", () => {
  let kv;
  beforeEach(async () => ({ kv } = await createTestKv()));

  test("sadd adds members, smembers reads them back, srem removes them", async () => {
    await kv.sadd("robots:all", "R1", "R2");
    expect((await kv.smembers("robots:all")).sort()).toEqual(["R1", "R2"]);
    await kv.srem("robots:all", "R1");
    expect(await kv.smembers("robots:all")).toEqual(["R2"]);
  });

  test("adding a duplicate member is idempotent", async () => {
    await kv.sadd("s", "x");
    await kv.sadd("s", "x");
    expect(await kv.smembers("s")).toEqual(["x"]);
  });

  test("smembers on a set that was never created returns an empty array", async () => {
    expect(await kv.smembers("nope")).toEqual([]);
  });
});

describe("cache/kv — incr (atomic counters, e.g. pairing-attempt lockout)", () => {
  let kv;
  beforeEach(async () => ({ kv } = await createTestKv()));

  test("increments from 0 and returns the new value each time", async () => {
    expect(await kv.incr("counter")).toBe(1);
    expect(await kv.incr("counter")).toBe(2);
    expect(await kv.incr("counter")).toBe(3);
  });

  test("refreshes the TTL on every increment when ex is supplied", async () => {
    jest.useFakeTimers();
    try {
      await kv.incr("counter", { ex: 1 });
      jest.advanceTimersByTime(900);
      await kv.incr("counter", { ex: 1 }); // refresh
      jest.advanceTimersByTime(900); // total 1800ms since first incr, but only 900ms since refresh
      expect(await kv.get("counter")).not.toBeNull();
      jest.advanceTimersByTime(200); // now 1100ms since refresh
      expect(await kv.get("counter")).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("cache/kv — health() when Redis is deliberately not configured", () => {
  // Note: F15/F39 (background reconnect probe) is now IMPLEMENTED — see
  // tests/unit/redis/lockFailClosed.test.js for the configured-but-unreachable
  // case, where `reconnecting: true` and lock acquisition fails closed.
  // The tests here cover the other half of that policy: Redis explicitly
  // disabled is an intentional single-process deployment, so there is nothing
  // to reconnect to and the in-memory fallback is the correct behavior.
  test("reports redis:false and configured:false when no REDIS_URL is set (matches tests/setup/env.js)", async () => {
    const { kv } = await createTestKv();
    expect(kv.health()).toEqual({ redis: false, configured: false, reconnecting: false });
  });

  test("stays on the in-memory fallback, and does not claim to be reconnecting", async () => {
    const { kv } = await createTestKv();
    for (let i = 0; i < 5; i++) {
      await kv.set(`k${i}`, "v");
    }
    expect(kv.health().redis).toBe(false);
    // Nothing was configured, so no recovery is pending — this must not be
    // reported as a degraded state an operator should act on.
    expect(kv.health().reconnecting).toBe(false);
    // Every read/write above must still have succeeded via memory fallback.
    expect(await kv.get("k4")).toBe("v");
  });
});
