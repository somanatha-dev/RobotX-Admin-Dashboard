"use strict";

/**
 * `/health`'s `redis` field reports what the process is actually running on.
 *
 * It used to be a set/get round trip through the KV facade, which the in-memory fallback
 * also passes — so a backend with REDIS_ENABLED=false, or with Redis configured and down,
 * reported `redis: "ok"`. That made the hosted Redis state unknowable from outside.
 */

const request = require("supertest");
const app = require("../../../src/app");
const { initKv } = require("../../../src/cache/kv");

const quiet = { info() {}, warn() {}, error() {} };

async function withKv(kv, fn) {
  const saved = app.locals.kv;
  app.locals.kv = kv;
  try {
    return await fn();
  } finally {
    app.locals.kv = saved;
  }
}

/** A facade stand-in whose connection state the test controls. */
function stubKv({ connected, dropDuringProbe = false }) {
  let live = connected;
  const store = new Map();
  return {
    health: () => ({ redis: live, configured: true, reconnecting: !live, memoryEntries: 0 }),
    async set(key, value) {
      if (dropDuringProbe) live = false; // the facade switches to memory, which still answers
      store.set(key, value);
    },
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async del(key) {
      store.delete(key);
    },
  };
}

describe("/health — redis status", () => {
  test('"disabled" when Redis is not configured, although the in-memory round trip succeeds', async () => {
    const { kv, close } = await initKv({ logger: quiet }); // tests/setup/env.js: REDIS_ENABLED=false
    await withKv(kv, async () => {
      const response = await request(app).get("/health").expect(200);
      expect(response.body.redis).toBe("disabled");
    });
    await close();
  });

  test('"fail" when Redis is configured but unreachable — the in-memory fallback is not reported as Redis', async () => {
    const saved = { url: process.env.REDIS_URL, enabled: process.env.REDIS_ENABLED };
    process.env.REDIS_URL = "redis://127.0.0.1:1";
    process.env.REDIS_ENABLED = "true";
    process.env.REDIS_CONNECT_TIMEOUT_MS = "150";
    let handle;
    try {
      handle = await initKv({ logger: quiet });
    } finally {
      if (saved.url === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = saved.url;
      process.env.REDIS_ENABLED = saved.enabled;
      delete process.env.REDIS_CONNECT_TIMEOUT_MS;
    }
    expect(handle.kv.health()).toMatchObject({ redis: false, configured: true, reconnecting: true });
    await withKv(handle.kv, async () => {
      const response = await request(app).get("/health").expect(200);
      expect(response.body.redis).toBe("fail");
    });
    await handle.close();
  });

  test('"ok" when connected and the round trip goes through Redis', async () => {
    await withKv(stubKv({ connected: true }), async () => {
      const response = await request(app).get("/health").expect(200);
      expect(response.body.redis).toBe("ok");
    });
  });

  test('"fail" when the connection drops during the probe, although the fallback answers the read', async () => {
    await withKv(stubKv({ connected: true, dropDuringProbe: true }), async () => {
      const response = await request(app).get("/health").expect(200);
      expect(response.body.redis).toBe("fail");
    });
  });

  test("Redis state never changes the HTTP status: Redis is optional by design", async () => {
    await withKv(stubKv({ connected: false }), async () => {
      await request(app).get("/health").expect(200);
    });
  });
});
