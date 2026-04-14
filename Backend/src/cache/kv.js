const Redis = require("ioredis");

async function initKv({ logger }) {
  const redisUrl = typeof process.env.REDIS_URL === "string" ? process.env.REDIS_URL.trim() : "";
  const redisEnabled = String(process.env.REDIS_ENABLED || "").toLowerCase() !== "false";

  let redis = null;
  let redisAvailable = false;
  let redisWarned = false;

  // In-memory fallback supports basic TTL semantics so higher-level code
  // can rely on expirations even when Redis is unavailable.
  const memoryKv = new Map();

  function nowMs() {
    return Date.now();
  }

  function memorySet(key, value, { ex } = {}) {
    const expiresAt = typeof ex === "number" && Number.isFinite(ex) && ex > 0 ? nowMs() + ex * 1000 : null;
    memoryKv.set(key, { value, expiresAt });
  }

  function memoryGet(key) {
    const entry = memoryKv.get(key);
    if (!entry) return null;
    // Backward-compat: if older code stored raw values.
    if (typeof entry !== "object" || entry === null || !("value" in entry)) return entry;
    if (entry.expiresAt && nowMs() > entry.expiresAt) {
      memoryKv.delete(key);
      return null;
    }
    return entry.value;
  }

  function disableRedis(err) {
    if (!redisWarned) {
      const code = err && (err.code || err.errno);
      (logger || console).warn(
        "Redis unavailable; falling back to in-memory cache" + (code ? ` (${code})` : "")
      );
      redisWarned = true;
    }
    redisAvailable = false;
    if (redis) {
      try {
        redis.disconnect();
      } catch {
        // ignore
      }
    }
    redis = null;
  }

  async function initRedis() {
    if (!redisEnabled) {
      (logger || console).info("Redis disabled via REDIS_ENABLED=false");
      return;
    }
    if (!redisUrl) {
      (logger || console).info("Redis disabled (no REDIS_URL)");
      return;
    }

    redis = new Redis(redisUrl, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: Number(process.env.REDIS_CONNECT_TIMEOUT_MS || 5000),
    });

    redis.on("connect", () => (logger || console).info("Redis connected"));
    redis.on("ready", () => (logger || console).info("Redis ready"));
    redis.on("error", (err) => {
      const code = err && (err.code || err.errno);
      if (!redisWarned) (logger || console).warn("Redis error", code || err);
    });
    redis.on("close", () => {
      if (!redisWarned) (logger || console).warn("Redis connection closed");
    });

    try {
      await redis.connect();
      redisAvailable = true;
    } catch (e) {
      disableRedis(e);
    }
  }

  const kv = {
    // set(key, value[, options])
    // - options.ex: expire in seconds
    async set(key, value, options) {
      const ex = options && typeof options === "object" ? options.ex : undefined;
      if (redisAvailable && redis) {
        try {
          if (typeof ex === "number" && Number.isFinite(ex) && ex > 0) {
            await redis.set(key, value, "EX", Math.floor(ex));
          } else {
            await redis.set(key, value);
          }
          return;
        } catch (e) {
          disableRedis(e);
        }
      }

      memorySet(key, value, { ex });
    },
    async get(key) {
      if (redisAvailable && redis) {
        try {
          return await redis.get(key);
        } catch (e) {
          disableRedis(e);
        }
      }
      return memoryGet(key);
    },
    async del(key) {
      if (redisAvailable && redis) {
        try {
          await redis.del(key);
          return;
        } catch (e) {
          disableRedis(e);
        }
      }
      memoryKv.delete(key);
    },

    // Best-effort health signal for monitoring endpoints.
    // Note: operations still fall back to in-memory when Redis is down.
    health() {
      return {
        redis: Boolean(redisAvailable && redis),
      };
    },
  };

  await initRedis();

  return {
    kv,
    async close() {
      if (redis) {
        try {
          await redis.quit();
        } catch {
          try {
            redis.disconnect();
          } catch {
            // ignore
          }
        }
      }
      redis = null;
      redisAvailable = false;
    },
  };
}

module.exports = {
  initKv,
};
