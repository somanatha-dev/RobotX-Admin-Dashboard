const Redis = require("ioredis");

async function initKv({ logger }) {
  const redisUrl = typeof process.env.REDIS_URL === "string" ? process.env.REDIS_URL.trim() : "";
  const redisEnabled = String(process.env.REDIS_ENABLED || "").toLowerCase() !== "false";

  let redis = null;
  let redisAvailable = false;
  let redisWarned = false;

  const memoryKv = new Map();

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
    async set(key, value) {
      if (redisAvailable && redis) {
        try {
          await redis.set(key, value);
          return;
        } catch (e) {
          disableRedis(e);
        }
      }
      memoryKv.set(key, value);
    },
    async get(key) {
      if (redisAvailable && redis) {
        try {
          return await redis.get(key);
        } catch (e) {
          disableRedis(e);
        }
      }
      return memoryKv.get(key) ?? null;
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
