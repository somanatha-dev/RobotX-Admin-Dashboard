"use strict";

/**
 * The KV facade against a real Redis server.
 *
 * Skipped unless REDIS_TEST_URL names one (tests/setup/env.js unsets REDIS_URL so every other
 * suite runs on the in-memory fallback). Point it at a disposable database index:
 *
 *   REDIS_TEST_URL=redis://127.0.0.1:6379/15 npx jest tests/integration/redisKv.integration.test.js
 *
 * Every key is under a per-run prefix and only those keys are deleted afterwards — nothing
 * here flushes a database. The outage is simulated with a TCP proxy this test owns, so no
 * other client of that server is disturbed.
 */

const net = require("net");
const Redis = require("ioredis");
const { initKv } = require("../../src/cache/kv");

const TEST_URL = process.env.REDIS_TEST_URL;
const describeIfRedis = TEST_URL ? describe : describe.skip;

const quiet = { info() {}, warn() {}, error() {} };
const PREFIX = `robotx-test:${process.pid}:${Date.now()}:`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const COMMAND_TIMEOUT_MS = 300;

async function openKv(url) {
  const saved = {
    url: process.env.REDIS_URL,
    enabled: process.env.REDIS_ENABLED,
    timeout: process.env.REDIS_CONNECT_TIMEOUT_MS,
    command: process.env.REDIS_COMMAND_TIMEOUT_MS,
  };
  process.env.REDIS_URL = url;
  process.env.REDIS_ENABLED = "true";
  process.env.REDIS_CONNECT_TIMEOUT_MS = "500";
  process.env.REDIS_COMMAND_TIMEOUT_MS = String(COMMAND_TIMEOUT_MS);
  try {
    return await initKv({ logger: quiet });
  } finally {
    for (const [name, value] of [
      ["REDIS_URL", saved.url],
      ["REDIS_ENABLED", saved.enabled],
      ["REDIS_CONNECT_TIMEOUT_MS", saved.timeout],
      ["REDIS_COMMAND_TIMEOUT_MS", saved.command],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/**
 * A TCP proxy in front of the test server that the test can cut and restore, or silence: a
 * silenced proxy keeps every socket open and forwards nothing in either direction — the
 * half-open connection a dropped route or a dead load balancer leaves, with no FIN or RST.
 */
async function startProxy(target) {
  const sockets = new Set();
  let server = null;
  let silent = false;
  const port = await new Promise((resolve) => {
    const probe = net.createServer().listen(0, "127.0.0.1", () => {
      const { port: free } = probe.address();
      probe.close(() => resolve(free));
    });
  });
  const listen = () =>
    new Promise((resolve) => {
      server = net.createServer((client) => {
        const upstream = net.connect(target.port, target.host);
        sockets.add(client);
        sockets.add(upstream);
        client.on("data", (chunk) => {
          if (!silent) upstream.write(chunk);
        });
        upstream.on("data", (chunk) => {
          if (!silent) client.write(chunk);
        });
        const drop = () => {
          client.destroy();
          upstream.destroy();
          sockets.delete(client);
          sockets.delete(upstream);
        };
        client.on("error", drop).on("close", drop);
        upstream.on("error", drop).on("close", drop);
      });
      server.listen(port, "127.0.0.1", resolve);
    });
  await listen();
  return {
    port,
    async cut() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise((resolve) => server.close(resolve));
    },
    restore: listen,
    silence(on) {
      silent = Boolean(on);
    },
    async stop() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => (server.listening ? server.close(resolve) : resolve()));
    },
  };
}

describeIfRedis("cache/kv against a real Redis server", () => {
  let raw;
  let handle;

  beforeAll(async () => {
    raw = new Redis(TEST_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
    await raw.connect();
    handle = await openKv(TEST_URL);
  });

  afterAll(async () => {
    if (handle) await handle.close();
    if (raw) {
      const keys = await raw.keys(`${PREFIX}*`);
      if (keys.length) await raw.del(...keys);
      raw.disconnect();
    }
  });

  test("connects, and set → get → del round-trips through Redis", async () => {
    const { kv } = handle;
    expect(kv.health()).toMatchObject({ redis: true, configured: true, reconnecting: false });
    await kv.set(`${PREFIX}rt`, "v1");
    expect(await raw.get(`${PREFIX}rt`)).toBe("v1");
    expect(await kv.get(`${PREFIX}rt`)).toBe("v1");
    await kv.del(`${PREFIX}rt`);
    expect(await raw.exists(`${PREFIX}rt`)).toBe(0);
  });

  test("both TTL argument forms store an expiry, and the key expires", async () => {
    const { kv } = handle;
    await kv.set(`${PREFIX}ttl-obj`, "v", { ex: 900 });
    await kv.set(`${PREFIX}ttl-pos`, "v", "EX", 900);
    expect(await raw.ttl(`${PREFIX}ttl-obj`)).toBeGreaterThan(890);
    expect(await raw.ttl(`${PREFIX}ttl-pos`)).toBeGreaterThan(890);

    await kv.set(`${PREFIX}ttl-short`, "v", "EX", 1);
    await sleep(1300);
    expect(await kv.get(`${PREFIX}ttl-short`)).toBeNull();
  });

  test("incr with a TTL leaves the counter expiring", async () => {
    const { kv } = handle;
    expect(await kv.incr(`${PREFIX}attempts`, { ex: 300 })).toBe(1);
    expect(await kv.incr(`${PREFIX}attempts`, { ex: 300 })).toBe(2);
    const ttl = await raw.ttl(`${PREFIX}attempts`);
    expect(ttl).toBeGreaterThan(290);
    expect(ttl).toBeLessThanOrEqual(300);
  });

  test("set helpers, mget and pipelines go through Redis", async () => {
    const { kv } = handle;
    await kv.sadd(`${PREFIX}set:a`, "R1", "R2");
    await kv.sadd(`${PREFIX}set:b`, "R3");
    expect((await kv.smembers(`${PREFIX}set:a`)).sort()).toEqual(["R1", "R2"]);
    expect((await kv.smembersMany([`${PREFIX}set:a`, `${PREFIX}set:b`, `${PREFIX}set:none`])).map((m) => m.sort())).toEqual([["R1", "R2"], ["R3"], []]);
    await kv.srem(`${PREFIX}set:a`, "R1");
    expect(await raw.smembers(`${PREFIX}set:a`)).toEqual(["R2"]);

    await kv.pipeline().set(`${PREFIX}p1`, "1", { ex: 60 }).set(`${PREFIX}p2`, "2").exec();
    expect(await kv.mget([`${PREFIX}p2`, `${PREFIX}missing`, `${PREFIX}p1`])).toEqual(["2", null, "1"]);
    expect(await raw.ttl(`${PREFIX}p1`)).toBeGreaterThan(50);
  });

  test("keys are scoped by their caller's namespace: one robot's state never answers another's", async () => {
    const { kv } = handle;
    await kv.set(`${PREFIX}robot:SIM-A`, JSON.stringify({ battery: 80 }), { ex: 60 });
    await kv.set(`${PREFIX}robot:SIM-B`, JSON.stringify({ battery: 20 }), { ex: 60 });
    expect(JSON.parse(await kv.get(`${PREFIX}robot:SIM-A`)).battery).toBe(80);
    expect(JSON.parse(await kv.get(`${PREFIX}robot:SIM-B`)).battery).toBe(20);
  });

  test("reserveRobot is a real SET NX: a second claim is refused until released", async () => {
    const { kv } = handle;
    expect(await kv.reserveRobot(`${PREFIX}reserve:R1`, "task-1", 30)).toBe(true);
    expect(await kv.reserveRobot(`${PREFIX}reserve:R1`, "task-2", 30)).toBe(false);
    await kv.releaseReservation(`${PREFIX}reserve:R1`);
    expect(await kv.reserveRobot(`${PREFIX}reserve:R1`, "task-2", 30)).toBe(true);
  });
});

describeIfRedis("cache/kv — outage and recovery against a real Redis server", () => {
  let proxy;
  let handle;
  let raw;

  let proxiedUrl;

  beforeAll(async () => {
    const target = new URL(TEST_URL);
    proxy = await startProxy({ host: target.hostname, port: Number(target.port || 6379) });
    const proxied = new URL(TEST_URL);
    proxied.hostname = "127.0.0.1";
    proxied.port = String(proxy.port);
    proxiedUrl = proxied.toString();
    raw = new Redis(TEST_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
    await raw.connect();
  });

  // A facade per test: each test is one outage. Outages back to back on one facade are retried
  // ever more slowly by design (RECONNECT_STABLE_MS), which is not what these tests measure.
  beforeEach(async () => {
    proxy.silence(false);
    handle = await openKv(proxiedUrl);
  });

  afterEach(async () => {
    if (handle) await handle.close();
    handle = null;
  });

  afterAll(async () => {
    if (proxy) await proxy.stop();
    if (raw) {
      const keys = await raw.keys(`${PREFIX}*`);
      if (keys.length) await raw.del(...keys);
      raw.disconnect();
    }
  });

  test("a dropped connection degrades to memory, keeps serving, and reconnects without a restart", async () => {
    const { kv } = handle;
    expect(kv.health().redis).toBe(true);

    await proxy.cut();
    // The next command notices the outage and the facade switches to its fallback.
    await kv.set(`${PREFIX}during-outage`, "mem", { ex: 60 });
    expect(kv.health()).toMatchObject({ redis: false, configured: true, reconnecting: true });
    expect(await kv.get(`${PREFIX}during-outage`)).toBe("mem");
    // An advisory lock is granted (the commit transaction decides); a non-advisory one fails closed.
    expect(await kv.reserveRobot(`${PREFIX}reserve:R9`, "t", 30)).toBe(true);
    await expect(kv.reserveRobot(`${PREFIX}reserve:R9`, "t", 30, { advisory: false })).rejects.toMatchObject({ code: "LOCK_UNAVAILABLE" });

    await proxy.restore();
    // The first reconnect attempt is scheduled 1 s after the outage; allow two.
    const deadline = Date.now() + 5000;
    while (!kv.health().redis && Date.now() < deadline) await sleep(100);
    expect(kv.health()).toMatchObject({ redis: true, reconnecting: false });

    await kv.set(`${PREFIX}after-recovery`, "redis", { ex: 60 });
    expect(await raw.get(`${PREFIX}after-recovery`)).toBe("redis");
    // Written during the outage, and written back to Redis by the reconnect's reconciliation.
    expect(await raw.get(`${PREFIX}during-outage`)).toBe("mem");
  }, 15000);

  async function outage(kv, during) {
    await proxy.cut();
    await during();
    expect(kv.health().redis).toBe(false);
    await proxy.restore();
    const deadline = Date.now() + 5000;
    while (!kv.health().redis && Date.now() < deadline) await sleep(100);
    expect(kv.health().redis).toBe(true);
  }

  test("after recovery, a key written during the outage holds the outage's value — never the one Redis held before it", async () => {
    const { kv } = handle;
    const key = `${PREFIX}session:R-OUTAGE`;
    await kv.set(key, "token-before", { ex: 60 });

    await outage(kv, () => kv.set(key, "token-during", { ex: 60 }));

    // "token-before" is older than what this process last wrote; answering with it would hand a
    // robot paired during the outage its revoked token. The outage's value is written back to
    // Redis with the TTL it had left.
    expect(await kv.get(key)).toBe("token-during");
    expect(await raw.get(key)).toBe("token-during");
    const ttl = await raw.pttl(key);
    expect(ttl).toBeGreaterThan(50_000);
    expect(ttl).toBeLessThanOrEqual(60_000);

    // The outage-time memory copy is not kept for the next outage.
    await proxy.cut();
    expect(await kv.get(key)).toBeNull();
    await proxy.restore();
    const deadline = Date.now() + 5000;
    while (!kv.health().redis && Date.now() < deadline) await sleep(100);
  }, 20000);

  test("after recovery, a key deleted during the outage stays deleted", async () => {
    const { kv } = handle;
    const key = `${PREFIX}taskPath:T-OUTAGE`;
    await kv.set(key, "route-before", { ex: 60 });

    await outage(kv, () => kv.del(key));

    expect(await kv.get(key)).toBeNull();
  }, 15000);

  test("after recovery, set membership changed during the outage is applied to Redis", async () => {
    const { kv } = handle;
    const key = `${PREFIX}robots:all`;
    await kv.sadd(key, "R-A", "R-B");

    await outage(kv, async () => {
      await kv.sadd(key, "R-C");
      await kv.srem(key, "R-A");
    });

    // Members nobody touched during the outage are kept: deleting the set would drop every robot.
    expect((await kv.smembers(key)).sort()).toEqual(["R-B", "R-C"]);
    expect((await raw.smembers(key)).sort()).toEqual(["R-B", "R-C"]);
  }, 15000);

  test("a half-open connection: a command times out to memory, health says so, and recovery reconciles", async () => {
    const { kv } = handle;
    const key = `${PREFIX}session:R-HALFOPEN`;
    await kv.set(key, "token-before", { ex: 60 });
    expect(kv.health().redis).toBe(true);

    proxy.silence(true);
    const started = Date.now();
    await kv.set(key, "token-during", { ex: 60 }); // times out → memory, tracked
    expect(Date.now() - started).toBeLessThan(COMMAND_TIMEOUT_MS * 5);
    expect(kv.health()).toMatchObject({ redis: false, reconnecting: true });
    expect(await kv.get(key)).toBe("token-during");

    proxy.silence(false);
    const deadline = Date.now() + 8000;
    while (!kv.health().redis && Date.now() < deadline) await sleep(100);
    expect(kv.health()).toMatchObject({ redis: true, outagePending: 0 });
    expect(await kv.get(key)).toBe("token-during");
    expect(await raw.get(key)).toBe("token-during");
  }, 20000);

  test("after recovery, a pairing lockout imposed during the outage is still in force in Redis", async () => {
    const { kv } = handle;
    const locked = `${PREFIX}pairingLocked:R-OUTAGE`;
    const attempts = `${PREFIX}pairingAttempts:R-OUTAGE`;
    await outage(kv, async () => {
      for (let i = 0; i < 5; i += 1) await kv.incr(attempts, { ex: 300 });
      await kv.set(locked, "1", { ex: 300 });
    });
    expect(await raw.get(locked)).toBe("1");
    expect(await raw.get(attempts)).toBe("5");
    expect(await raw.pttl(locked)).toBeGreaterThan(290_000);
  }, 15000);

  test("a reconnect attempt through a still-silent path fails within its bound and is retried", async () => {
    const { kv } = handle;
    proxy.silence(true);
    await kv.get(`${PREFIX}probe`); // notices the loss
    expect(kv.health().redis).toBe(false);
    // First attempt at ~1 s; bounded at connect + command timeout; still down after it.
    await sleep(1000 + 500 + COMMAND_TIMEOUT_MS + 500);
    expect(kv.health().redis).toBe(false);
    proxy.silence(false);
    const deadline = Date.now() + 8000;
    while (!kv.health().redis && Date.now() < deadline) await sleep(100);
    expect(kv.health().redis).toBe(true);
  }, 20000);

  test("the availability index keeps its stationary agents through an outage, in memory and then in Redis", async () => {
    const availabilityIndex = require("../../src/engine/candidates/availabilityIndex");
    const indexMaintainer = require("../../src/workers/indexMaintainer.worker");
    const { kv } = handle;
    const shardId = `${PREFIX}shard`;
    const rows = ["agent-1", "agent-2", "agent-3"].map((agentId) => ({
      agentId,
      shardId,
      lat: 12.9,
      lon: 77.5,
      fineCellId: "fine-A",
      coarseCellId: "coarse-A",
      availabilityClass: "IDLE",
      capabilityClasses: [],
      containerClasses: [],
    }));
    const prisma = { agentCellPosition: { findMany: async () => rows.map((row) => ({ ...row })) } };
    const look = () => availabilityIndex.candidatesInFineCell({ kv }, shardId, "fine-A", "IDLE");
    const maintainer = indexMaintainer.start({ prisma, kv }, { intervalMs: 3_600_000 });
    try {
      await maintainer.idle();
      expect(await look()).toEqual(["agent-1", "agent-2", "agent-3"]);

      await proxy.cut();
      await look(); // notices the loss; the maintainer rebuilds into memory
      expect(kv.health().redis).toBe(false);
      let deadline = Date.now() + 4000;
      while ((await look()).length !== 3 && Date.now() < deadline) await sleep(50);
      expect(await look()).toEqual(["agent-1", "agent-2", "agent-3"]);

      await proxy.restore();
      deadline = Date.now() + 8000;
      while (!kv.health().redis && Date.now() < deadline) await sleep(100);
      expect(kv.health().redis).toBe(true);
      await sleep(50);
      await maintainer.idle();
      expect(await look()).toEqual(["agent-1", "agent-2", "agent-3"]);
      expect((await raw.smembers(availabilityIndex.fineKey(shardId, "fine-A", "IDLE"))).sort()).toEqual(["agent-1", "agent-2", "agent-3"]);
    } finally {
      maintainer.stop();
      const keys = [...new Set(rows.flatMap((row) => availabilityIndex.keysFor(row)))];
      if (keys.length) await raw.del(...keys);
    }
  }, 30000);

  test("a server unreachable at boot starts on the fallback and closes cleanly", async () => {
    const dead = await openKv("redis://127.0.0.1:1");
    expect(dead.kv.health()).toMatchObject({ redis: false, configured: true, reconnecting: true });
    await dead.kv.set(`${PREFIX}boot`, "mem");
    expect(await dead.kv.get(`${PREFIX}boot`)).toBe("mem");
    await dead.close();
  });
});
