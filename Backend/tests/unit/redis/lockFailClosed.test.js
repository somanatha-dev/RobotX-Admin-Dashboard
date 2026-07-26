const { initKv } = require("../../../src/cache/kv");

// HR1 — the allocation lock must never silently degrade into a process-local
// lock.
//
// `kv.js` applies ONE uniform fallback policy to every capability: if Redis is
// unreachable, fall back to an in-process Map. That is correct for a cache and
// catastrophic for `reserveRobot`, which is the primitive the entire F4
// allocation-race fix is built on. Two server instances that have both fallen
// back to memory will BOTH successfully "reserve" the same robot, with no
// error, no log, and no metric — reintroducing double-assignment precisely in
// the multi-instance deployment the lock exists to protect.
//
// The distinction that matters is intent:
//   - Redis deliberately disabled (no REDIS_URL, or REDIS_ENABLED=false)
//       => single-process mode is what the operator asked for; a memory lock
//          is genuinely correct because there is only one process.
//   - Redis configured but unreachable
//       => the operator intended a shared lock. Falling back to memory changes
//          the safety property. Fail closed instead.

const UNREACHABLE = "redis://127.0.0.1:1"; // reserved port — connection refused
const silentLogger = { info() {}, warn() {}, error() {} };

async function kvWithUnreachableRedis() {
  const prev = { url: process.env.REDIS_URL, enabled: process.env.REDIS_ENABLED };
  process.env.REDIS_URL = UNREACHABLE;
  process.env.REDIS_ENABLED = "true";
  process.env.REDIS_CONNECT_TIMEOUT_MS = "150";
  try {
    return await initKv({ logger: silentLogger });
  } finally {
    if (prev.url === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = prev.url;
    process.env.REDIS_ENABLED = prev.enabled;
    delete process.env.REDIS_CONNECT_TIMEOUT_MS;
  }
}

describe("reservation locking must fail closed when Redis was configured but is unavailable (HR1)", () => {
  const openKvs = [];

  afterEach(async () => {
    while (openKvs.length) {
      const close = openKvs.pop();
      try { await close(); } catch { /* ignore */ }
    }
  });

  test("a single instance does not silently grant a lock it cannot actually hold", async () => {
    const { kv, close } = await kvWithUnreachableRedis();
    openKvs.push(close);

    expect(kv.health().redis).toBe(false);

    // Pre-fix this resolves `true` from the in-memory Map — the caller believes
    // it holds a cluster-wide lock that does not exist.
    await expect(kv.reserveRobot("robotReserve:R1", "task-1", 30)).rejects.toThrow(
      /lock|reservation|unavailable/i
    );
  });

  test("two independent instances cannot both claim the same robot", async () => {
    // This is the production failure mode: two API replicas, both degraded to
    // in-memory mode after the same Redis blip, each assigning the same robot
    // to a different task.
    const a = await kvWithUnreachableRedis();
    const b = await kvWithUnreachableRedis();
    openKvs.push(a.close, b.close);

    const results = await Promise.allSettled([
      a.kv.reserveRobot("robotReserve:R1", "task-A", 30),
      b.kv.reserveRobot("robotReserve:R1", "task-B", 30),
    ]);

    const granted = results.filter((r) => r.status === "fulfilled" && r.value === true);
    expect(granted).toHaveLength(0);
  });

  test("the raised error is actionable (503-shaped, not a generic crash)", async () => {
    const { kv, close } = await kvWithUnreachableRedis();
    openKvs.push(close);

    await expect(kv.reserveRobot("robotReserve:R1", "task-1", 30)).rejects.toMatchObject({
      status: 503,
    });
  });

  test("non-lock capabilities still degrade gracefully rather than failing closed", async () => {
    // The fix must be scoped to the lock. A cache read/write losing Redis is
    // still expected to fall back to memory — failing closed there would turn
    // a Redis blip into a full outage.
    const { kv, close } = await kvWithUnreachableRedis();
    openKvs.push(close);

    await expect(kv.set("cache:x", "1", { ex: 5 })).resolves.toBeUndefined();
    await expect(kv.get("cache:x")).resolves.toBe("1");
    await expect(kv.incr("rate:x", { ex: 5 })).resolves.toBe(1);
  });
});

describe("reservation locking in explicitly single-process mode (REDIS_ENABLED=false)", () => {
  test("memory-backed reservations still work when Redis is deliberately disabled", async () => {
    // tests/setup/env.js sets REDIS_ENABLED=false, so this is the ambient
    // test/dev configuration. Single-process mode is intentional here, and an
    // in-memory lock is genuinely correct — the fix must not break it.
    const { kv, close } = await initKv({ logger: silentLogger });
    try {
      await expect(kv.reserveRobot("robotReserve:R1", "task-1", 30)).resolves.toBe(true);
      await expect(kv.reserveRobot("robotReserve:R1", "task-2", 30)).resolves.toBe(false);
    } finally {
      await close();
    }
  });
});

describe("Redis reconnect probe (F15/F39)", () => {
  test("a transient outage does not permanently downgrade the process", async () => {
    const { kv, close } = await kvWithUnreachableRedis();
    try {
      expect(kv.health().redis).toBe(false);
      // The facade must expose that it is actively trying to recover, rather
      // than having latched into memory mode for the life of the process.
      expect(kv.health()).toMatchObject({ reconnecting: true });
    } finally {
      await close();
    }
  });
});
