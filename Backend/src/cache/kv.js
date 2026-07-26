const Redis = require("ioredis");

async function initKv({ logger }) {
  const redisUrl = typeof process.env.REDIS_URL === "string" ? process.env.REDIS_URL.trim() : "";
  const redisEnabled = String(process.env.REDIS_ENABLED || "").toLowerCase() !== "false";

  let redis = null;
  let redisAvailable = false;
  let redisWarned = false;

  // Whether the operator actually asked for Redis. This is the distinction the
  // fallback policy below turns on:
  //   - not configured (no REDIS_URL, or REDIS_ENABLED=false) → single-process
  //     mode is intentional, so an in-memory lock is genuinely correct.
  //   - configured but unreachable → the operator intended a SHARED lock across
  //     instances. Falling back to memory would silently change that safety
  //     property, so lock operations fail closed instead (see reserveRobot).
  const redisConfigured = redisEnabled && Boolean(redisUrl);

  // Background reconnect probe (F15/F39). Without this, a single transient
  // blip trips `disableRedis()` and downgrades the process to in-memory mode
  // for the rest of its life — permanently, silently, and with no way back
  // short of a restart.
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let closed = false;

  // In-memory fallback supports basic TTL semantics so higher-level code
  // can rely on expirations even when Redis is unavailable.
  const memoryKv = new Map();
  // In-memory fallback for Redis SET semantics.
  const memorySets = new Map();

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

  function memorySAdd(key, ...members) {
    const k = String(key);
    let set = memorySets.get(k);
    if (!set) {
      set = new Set();
      memorySets.set(k, set);
    }
    let added = 0;
    for (const m of members) {
      if (m === undefined || m === null) continue;
      const s = String(m);
      if (!set.has(s)) {
        set.add(s);
        added += 1;
      }
    }
    return added;
  }

  function memorySRem(key, ...members) {
    const k = String(key);
    const set = memorySets.get(k);
    if (!set) return 0;
    let removed = 0;
    for (const m of members) {
      if (m === undefined || m === null) continue;
      const s = String(m);
      if (set.delete(s)) removed += 1;
    }
    if (set.size === 0) memorySets.delete(k);
    return removed;
  }

  function memorySMembers(key) {
    const k = String(key);
    const set = memorySets.get(k);
    if (!set) return [];
    return Array.from(set);
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
    scheduleReconnect();
  }

  /**
   * Schedule the next reconnect attempt with capped exponential backoff.
   * Only ever runs when Redis was configured — an intentionally-disabled Redis
   * has nothing to reconnect to. The timer is `unref()`d so a process that is
   * otherwise idle can still exit.
   */
  function scheduleReconnect() {
    if (!redisConfigured || closed || reconnectTimer) return;

    const backoffMs = Math.min(30_000, 1000 * 2 ** Math.min(reconnectAttempt, 5));
    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null;
      if (closed || redisAvailable) return;
      reconnectAttempt += 1;
      const connected = await connectRedis();
      if (connected) {
        reconnectAttempt = 0;
        redisWarned = false;
        (logger || console).info("Redis reconnected; leaving in-memory fallback mode");
      } else {
        scheduleReconnect();
      }
    }, backoffMs);

    if (typeof reconnectTimer.unref === "function") reconnectTimer.unref();
  }

  /**
   * Attempt a single connection. Returns true on success.
   * Deliberately does NOT call disableRedis() on failure — the caller decides
   * whether that failure should (re)start the backoff loop, so a failed probe
   * can't recurse into scheduling itself twice.
   */
  async function connectRedis() {
    const client = new Redis(redisUrl, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      // Don't let ioredis run its own retry loop underneath ours — this
      // facade owns the backoff so the two can't compound.
      retryStrategy: () => null,
      connectTimeout: Number(process.env.REDIS_CONNECT_TIMEOUT_MS || 5000),
    });

    client.on("connect", () => (logger || console).info("Redis connected"));
    client.on("ready", () => (logger || console).info("Redis ready"));
    client.on("error", (err) => {
      const code = err && (err.code || err.errno);
      if (!redisWarned) (logger || console).warn("Redis error", code || err);
    });
    client.on("close", () => {
      if (!redisWarned) (logger || console).warn("Redis connection closed");
    });

    try {
      await client.connect();
      redis = client;
      redisAvailable = true;
      return true;
    } catch {
      try { client.disconnect(); } catch { /* ignore */ }
      return false;
    }
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

    const connected = await connectRedis();
    if (!connected) {
      // Configured but unreachable at boot — warn, fall back for cache-style
      // reads/writes, fail closed for locks, and keep probing.
      disableRedis(new Error("initial connect failed"));
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

    // Redis Set helpers (best-effort). Used for live robot indexing.
    async sadd(key, ...members) {
      if (redisAvailable && redis) {
        try {
          // ioredis returns number added
          return await redis.sadd(key, ...members.map((m) => String(m)));
        } catch (e) {
          disableRedis(e);
        }
      }
      return memorySAdd(key, ...members);
    },
    async srem(key, ...members) {
      if (redisAvailable && redis) {
        try {
          return await redis.srem(key, ...members.map((m) => String(m)));
        } catch (e) {
          disableRedis(e);
        }
      }
      return memorySRem(key, ...members);
    },
    async smembers(key) {
      if (redisAvailable && redis) {
        try {
          const out = await redis.smembers(key);
          return Array.isArray(out) ? out : [];
        } catch (e) {
          disableRedis(e);
        }
      }
      return memorySMembers(key);
    },

    // Batch set using Redis pipelining (performance-critical for simulation).
    // entries: [{ key, value, ex }]
    async setManyEx(entries) {
      if (!Array.isArray(entries) || entries.length === 0) return;

      if (redisAvailable && redis) {
        try {
          const pipeline = redis.pipeline();
          for (const e of entries) {
            if (!e || !e.key) continue;
            const ex = typeof e.ex === "number" && Number.isFinite(e.ex) && e.ex > 0 ? Math.floor(e.ex) : null;
            if (ex) pipeline.set(String(e.key), e.value, "EX", ex);
            else pipeline.set(String(e.key), e.value);
          }
          await pipeline.exec();
          return;
        } catch (e) {
          disableRedis(e);
        }
      }

      // Fallback: sequential set
      for (const e of entries) {
        if (!e || !e.key) continue;
        await kv.set(String(e.key), e.value, { ex: e.ex });
      }
    },

    // Batch get using Redis MGET (a single pipelined round-trip instead of
    // N individual GETs). Returns values in the same order as `keys`, with
    // `null` for any key that is missing/expired — matching Redis MGET
    // semantics so callers can zip `keys` with the result by index in both
    // Redis and in-memory-fallback mode.
    async mget(keys) {
      if (!Array.isArray(keys) || keys.length === 0) return [];

      if (redisAvailable && redis) {
        try {
          const values = await redis.mget(keys.map((k) => String(k)));
          return Array.isArray(values) ? values : keys.map(() => null);
        } catch (e) {
          disableRedis(e);
        }
      }

      // Fallback: sequential in-memory reads (no pipelining available, but
      // preserves the same order/null semantics as Redis MGET).
      return keys.map((key) => memoryGet(String(key)));
    },

    /**
     * Atomically increment a counter and set/refresh its TTL.
     * Uses Redis INCR + EXPIRE for true atomicity; falls back to safe GET+SET.
     *
     * @param {string} key
     * @param {{ ex?: number }} [options]  ex = TTL in seconds
     * @returns {Promise<number>} new value after increment
     */
    async incr(key, { ex } = {}) {
      if (redisAvailable && redis) {
        try {
          const next = await redis.incr(key);
          if (typeof ex === "number" && Number.isFinite(ex) && ex > 0) {
            await redis.expire(key, Math.floor(ex));
          }
          return next;
        } catch (e) {
          disableRedis(e);
        }
      }
      // In-memory fallback: best-effort (not atomic across concurrent JS ops,
      // but single-threaded Node.js makes this safe in practice).
      const raw = memoryGet(key);
      const next = (raw !== null ? Number.parseInt(String(raw), 10) : 0) + 1;
      memorySet(key, String(next), { ex });
      return Number.isFinite(next) ? next : 1;
    },

    // Short-lived allocation reservation (F4): atomic "claim if free" so two
    // concurrent task assignments can't both pick the same robot. Backed by
    // Redis SET NX EX.
    //
    // FAIL-CLOSED POLICY (HR1) — this is the one capability on the facade that
    // must NOT silently fall back to the in-memory Map when Redis is
    // configured but unreachable. An in-memory lock is only a lock relative to
    // its own process; two replicas that have both degraded would each be
    // granted the same robot, with no error and no metric, reintroducing the
    // exact double-assignment race F4 exists to prevent — and doing so
    // precisely in the multi-instance deployment where it matters.
    //
    // Halting allocation is a recoverable business problem (orders queue and
    // are retried). Double-assigning a physical vehicle is not.
    //
    // When Redis was never configured (no REDIS_URL, or REDIS_ENABLED=false)
    // the deployment is explicitly single-process, so the memory-backed lock
    // is genuinely correct and is still used.
    async reserveRobot(key, value, ttlSec) {
      const ex = typeof ttlSec === "number" && Number.isFinite(ttlSec) && ttlSec > 0 ? Math.floor(ttlSec) : 30;

      if (redisAvailable && redis) {
        try {
          const res = await redis.set(key, value, "EX", ex, "NX");
          return res === "OK";
        } catch (e) {
          disableRedis(e);
          // Fall through to the fail-closed guard below rather than to memory.
        }
      }

      if (redisConfigured) {
        const err = new Error(
          "Reservation lock unavailable: Redis is configured but unreachable. " +
          "Refusing to fall back to a process-local lock (would allow double-assignment across instances)."
        );
        err.status = 503;
        err.code = "LOCK_UNAVAILABLE";
        throw err;
      }

      if (memoryGet(key) !== null) return false;
      memorySet(key, value, { ex });
      return true;
    },

    // Release a reservation taken via reserveRobot. Plain delete — callers
    // only release keys they successfully reserved themselves, so there's no
    // "owned by someone else" case to guard against here.
    //
    // Deliberately lenient (no fail-closed guard): release runs in a `finally`
    // block, so throwing here would mask whatever error was already unwinding.
    // A release that doesn't land is covered by the reservation's TTL.
    async releaseReservation(key) {
      await kv.del(key);
    },

    // Best-effort health signal for monitoring endpoints.
    //   redis        — a live connection is currently usable
    //   configured   — the operator asked for Redis at all
    //   reconnecting — configured, currently down, and actively being retried
    //                  (i.e. degraded but not permanently latched)
    health() {
      return {
        redis: Boolean(redisAvailable && redis),
        configured: redisConfigured,
        reconnecting: Boolean(redisConfigured && !redisAvailable),
      };
    },
  };

  await initRedis();

  return {
    kv,
    async close() {
      closed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
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
