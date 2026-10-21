const Redis = require("ioredis");

// How often the in-memory store drops expired entries. A read already drops the entry it
// touches; the sweep covers keys written once and never read again — `metrics:allocation:{ms}`,
// or a route entry keyed on a robot's exact position — which would otherwise be held for the
// life of the process however short their TTL.
const MEMORY_SWEEP_INTERVAL_MS = 60_000;

// Keys per DEL command when a recovered connection invalidates what the outage wrote.
const OUTAGE_DEL_BATCH = 500;

// Passes a reconnect makes over writes that keep landing while it reconciles, before it gives
// up and tries again at the next backoff step.
const OUTAGE_RECONCILE_PASSES = 5;

// The longest a single Redis command may take before the facade treats the connection as lost.
// Without one, a half-open connection (bytes dropped, no FIN or RST) left every command pending
// until the OS gave up on the socket — hours with Linux defaults — and the telemetry handler,
// the heartbeat and `/health` each blocked on their first Redis call, while the facade still
// reported Redis as connected. A command that reaches it falls back to memory like any other
// failure. Telemetry is a 1–2 s tick, so a command slower than this is already a failure.
const DEFAULT_COMMAND_TIMEOUT_MS = 1000;

// How long a recovered connection must stay healthy before the reconnect backoff starts again
// from 1 s. Without it, a Redis that accepts connections but refuses writes (full under
// noeviction) made the facade reconnect, fail its next write and reconnect again every second,
// rebuilding the availability index each time; with it the attempts back off to 30 s.
const RECONNECT_STABLE_MS = 30_000;

// TCP keepalive's initial delay on the facade's connection. ioredis's default (0) keeps the OS
// default, two hours on Linux; this lets an idle half-open connection be noticed without traffic.
const DEFAULT_KEEPALIVE_MS = 5000;

/**
 * The first reply in an ioredis pipeline result that is a lost connection rather than a command's
 * own error. ioredis resolves a pipeline whose commands timed out (`commandTimeout`) or whose
 * stream closed with one error per command instead of rejecting, so without this a half-open
 * connection dropped every batched write silently while the facade still reported Redis as
 * connected. An OOM reply counts too: under `maxmemory-policy noeviction` a full Redis refuses
 * every write, and a batch whose writes were refused must fall back like a single write does,
 * not leave older values to be read back. A command's own error (WRONGTYPE, …) is not one of
 * these.
 *
 * @param {Array<[Error|null, unknown]>|null} results
 * @returns {Error|null}
 */
function connectionFailureIn(results) {
  for (const [err] of results || []) {
    if (!err) continue;
    const message = String(err.message || "");
    if (
      message.includes("Command timed out") ||
      message.includes("Connection is closed") ||
      message.includes("Stream isn't writeable") ||
      message.startsWith("OOM ") ||
      ["ECONNRESET", "EPIPE", "ETIMEDOUT", "ECONNREFUSED", "ENOTCONN"].includes(err.code)
    ) {
      return err;
    }
  }
  return null;
}

function positiveMs(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * The Redis settings, read from the environment in one place so the KV facade and the
 * Socket.IO adapter (server.js) cannot disagree about whether Redis is configured.
 */
function redisSettings(env = process.env) {
  const url = typeof env.REDIS_URL === "string" ? env.REDIS_URL.trim() : "";
  const enabled = String(env.REDIS_ENABLED || "").toLowerCase() !== "false";
  return {
    url,
    enabled,
    configured: enabled && Boolean(url),
    connectTimeoutMs: Number(env.REDIS_CONNECT_TIMEOUT_MS || 5000),
    commandTimeoutMs: positiveMs(env.REDIS_COMMAND_TIMEOUT_MS, DEFAULT_COMMAND_TIMEOUT_MS),
    keepAliveMs: positiveMs(env.REDIS_KEEPALIVE_MS, DEFAULT_KEEPALIVE_MS),
  };
}

function positiveOrUndefined(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * The expiry, in seconds, from either argument shape the callers use: `{ ex: seconds }`, or
 * the ioredis positional form `"EX", seconds` / `"PX", milliseconds`. `cellPairCache.write`
 * and `capacityPricingClient.write` use the positional form, which `set` used to read as "no
 * options" — so their entries were stored with no expiry at all, in Redis (TTL -1) and in
 * memory alike, and `route.cell_pair_cache_ttl` never took effect.
 */
function expirySeconds(args) {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg && typeof arg === "object") return positiveOrUndefined(arg.ex);
    if (typeof arg !== "string") continue;
    const flag = arg.toUpperCase();
    if (flag === "EX") return positiveOrUndefined(Number(args[i + 1]));
    // Rounded up: Redis EX takes whole seconds, and an entry may outlive a sub-second
    // remainder but must not expire before the time it was given.
    if (flag === "PX") {
      const ms = positiveOrUndefined(Number(args[i + 1]));
      return ms === undefined ? undefined : Math.ceil(ms / 1000);
    }
  }
  return undefined;
}

async function initKv({ logger }) {
  const { url: redisUrl, enabled: redisEnabled, configured, connectTimeoutMs, commandTimeoutMs, keepAliveMs } = redisSettings();

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
  const redisConfigured = configured;

  // Background reconnect probe (F15/F39). Without this, a single transient
  // blip trips `disableRedis()` and downgrades the process to in-memory mode
  // for the rest of its life — permanently, silently, and with no way back
  // short of a restart.
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  // When the last reconnect succeeded: the backoff restarts only once a connection outlives
  // RECONNECT_STABLE_MS (see there). 0 — no reconnect yet, so the first outage starts at 1 s.
  let recoveredAt = 0;
  let closed = false;

  // In-memory fallback supports basic TTL semantics so higher-level code
  // can rely on expirations even when Redis is unavailable.
  const memoryKv = new Map();
  // In-memory fallback for Redis SET semantics.
  const memorySets = new Map();

  // What an outage wrote, kept only while Redis is configured (when it is not, the memory
  // store is the store and there is nothing to reconcile). On reconnect the Redis copy of
  // every such key is older than this process's last write, so answering from it would serve
  // stale state — a robot paired during the outage would be offered its revoked session token.
  //   outageKeys    — string keys set or deleted during the outage: on recovery written back with
  //                   their remaining TTL when memory still holds them, deleted in Redis otherwise
  //   outageMembers — set key → member → "add" | "rem", the last change to each member: replayed,
  //                   because deleting a set would drop every member nobody touched
  const outageKeys = new Set();
  const outageMembers = new Map();

  function nowMs() {
    return Date.now();
  }

  function recordOutageKey(key) {
    if (redisConfigured) outageKeys.add(String(key));
  }

  function recordOutageMember(key, member, change) {
    if (!redisConfigured) return;
    const k = String(key);
    let members = outageMembers.get(k);
    if (!members) {
      members = new Map();
      outageMembers.set(k, members);
    }
    members.set(String(member), change);
  }

  function memorySet(key, value, { ex } = {}) {
    const expiresAt = typeof ex === "number" && Number.isFinite(ex) && ex > 0 ? nowMs() + ex * 1000 : null;
    memoryKv.set(key, { value, expiresAt });
    recordOutageKey(key);
  }

  function memoryDel(key) {
    memoryKv.delete(key);
    recordOutageKey(key);
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

  function sweepExpired() {
    const now = nowMs();
    for (const [key, entry] of memoryKv) {
      if (entry && typeof entry === "object" && entry.expiresAt && now > entry.expiresAt) memoryKv.delete(key);
    }
  }

  const sweepTimer = setInterval(sweepExpired, MEMORY_SWEEP_INTERVAL_MS);
  if (typeof sweepTimer.unref === "function") sweepTimer.unref();

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
      recordOutageMember(k, s, "add");
      if (!set.has(s)) {
        set.add(s);
        added += 1;
      }
    }
    return added;
  }

  function memorySRem(key, ...members) {
    const k = String(key);
    // Recorded even when this process holds no copy of the set: the member is in Redis's.
    for (const m of members) {
      if (m !== undefined && m !== null) recordOutageMember(k, String(m), "rem");
    }
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

  // Told when the facade leaves Redis for its in-memory store ("fallback") and when it is back
  // on Redis with the outage reconciled ("recovered"). The memory store starts empty, so state
  // rebuilt from durable records — the availability index — has to be rebuilt into it, or every
  // reader sees nothing for as long as the outage lasts. Called on a later tick, never inside
  // the facade's own state change; a listener's failure is its own.
  const modeListeners = new Set();

  function announce(mode) {
    for (const listener of [...modeListeners]) {
      setImmediate(() => {
        try {
          const result = listener(mode);
          if (result && typeof result.catch === "function") result.catch(() => {});
        } catch {
          // a listener's failure never reaches the facade
        }
      });
    }
  }

  function disableRedis(err) {
    if (!redisWarned) {
      const code = err && (err.code || err.errno);
      (logger || console).warn(
        "Redis unavailable; falling back to in-memory cache" + (code ? ` (${code})` : "")
      );
      redisWarned = true;
    }
    const wasAvailable = redisAvailable;
    if (wasAvailable && nowMs() - recoveredAt >= RECONNECT_STABLE_MS) reconnectAttempt = 0;
    redisAvailable = false;
    if (wasAvailable) announce("fallback");
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
        // The attempt count is kept, not reset: it restarts when this connection has stayed
        // healthy for RECONNECT_STABLE_MS, so a Redis that keeps failing right after a reconnect
        // is retried ever more slowly instead of every second.
        recoveredAt = nowMs();
        redisWarned = false;
        (logger || console).info("Redis reconnected; leaving in-memory fallback mode");
        announce("recovered");
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
      connectTimeout: connectTimeoutMs,
      // A finite answer to every command, and a keepalive that notices an idle dead socket —
      // see DEFAULT_COMMAND_TIMEOUT_MS. A timed-out command rejects and takes the existing
      // fallback path (disableRedis), exactly as a refused connection does.
      commandTimeout: commandTimeoutMs,
      keepAlive: keepAliveMs,
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
      // ioredis's connectTimeout covers the TCP connect; a server that accepts the socket and
      // then answers nothing (the half-open case) would hold the handshake open. The attempt as a
      // whole is bounded, so a reconnect through a dead path fails and is retried at the next
      // backoff step instead of stopping the reconnect loop.
      let deadline = null;
      try {
        await Promise.race([
          client.connect(),
          new Promise((_, reject) => {
            deadline = setTimeout(() => reject(new Error("Redis connect timed out")), connectTimeoutMs + commandTimeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(deadline);
      }
      let restored = 0;
      let invalidated = 0;
      let replayed = 0;
      // The emptiness check that ends this loop and the switch below run with no await between
      // them, so a write that lands while a pass is in flight is reconciled by the next pass
      // rather than cleared unreconciled.
      for (let pass = 0; outageKeys.size > 0 || outageMembers.size > 0; pass += 1) {
        if (pass >= OUTAGE_RECONCILE_PASSES) throw new Error("outage writes kept arriving during reconciliation");
        const done = await reconcileOutage(client);
        restored += done.restored;
        invalidated += done.invalidated;
        replayed += done.replayed;
      }
      // Everything the memory store holds was written during the outage and is now reconciled;
      // keeping it would serve this outage's values during the next one.
      memoryKv.clear();
      memorySets.clear();
      redis = client;
      redisAvailable = true;
      if (restored > 0 || invalidated > 0 || replayed > 0) {
        (logger || console).info("Redis reconciled after an outage", { restoredKeys: restored, invalidatedKeys: invalidated, replayedSetChanges: replayed });
      }
      return true;
    } catch {
      try { client.disconnect(); } catch { /* ignore */ }
      return false;
    }
  }

  /**
   * One pass over what the outage wrote, sent to the recovered connection. A string key the
   * outage set and memory still holds is written back with its remaining TTL; one it deleted, or
   * whose entry has since expired, is DEL'd. Either way Redis ends up with this process's latest
   * value, never the one it held before the outage. Writing back, rather than deleting every
   * touched key, is what keeps a pairing lockout (`pairingLocked:`, `pairingAttempts:`) imposed
   * during the outage in force after it — a DEL lifted it early, the hazard the runbook rejects
   * `volatile-lru` for — and keeps a pairing code or session issued during the outage usable.
   * SADD/SREM replay every set member changed. On failure the records are put back — a change
   * recorded since this pass began wins — and the caller keeps the facade on its fallback, so
   * nothing is lost and the next reconnect attempt retries.
   */
  async function reconcileOutage(client) {
    const keys = [...outageKeys];
    const members = new Map(outageMembers);
    outageKeys.clear();
    outageMembers.clear();

    const pipeline = client.pipeline();
    const now = nowMs();
    const deleted = [];
    let restored = 0;
    for (const key of keys) {
      const entry = memoryKv.get(key);
      if (entry === undefined) {
        deleted.push(key);
        continue;
      }
      if (entry && typeof entry === "object" && "value" in entry) {
        if (entry.expiresAt) {
          const remainingMs = entry.expiresAt - now;
          if (remainingMs <= 0) {
            deleted.push(key);
            continue;
          }
          pipeline.set(key, entry.value, "PX", Math.ceil(remainingMs));
        } else {
          pipeline.set(key, entry.value);
        }
      } else {
        // Backward-compat: a raw value stored by older code, with no expiry.
        pipeline.set(key, entry);
      }
      restored += 1;
    }
    for (let i = 0; i < deleted.length; i += OUTAGE_DEL_BATCH) pipeline.del(...deleted.slice(i, i + OUTAGE_DEL_BATCH));
    let replayed = 0;
    for (const [key, changes] of members) {
      const adds = [];
      const rems = [];
      for (const [member, change] of changes) (change === "add" ? adds : rems).push(member);
      if (adds.length) pipeline.sadd(key, ...adds);
      if (rems.length) pipeline.srem(key, ...rems);
      replayed += changes.size;
    }

    try {
      const results = await pipeline.exec();
      const failed = (results || []).find(([err]) => err);
      if (failed) throw failed[0];
      return { restored, invalidated: deleted.length, replayed };
    } catch (e) {
      for (const key of keys) outageKeys.add(key);
      for (const [key, changes] of members) {
        for (const [member, change] of changes) {
          const current = outageMembers.get(key);
          if (current && current.has(member)) continue;
          recordOutageMember(key, member, change);
        }
      }
      throw e;
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
    // - options.ex: expire in seconds; the ioredis positional "EX", s / "PX", ms is read too
    async set(key, value, ...options) {
      const ex = expirySeconds(options);
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
      memoryDel(key);
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

    // Batch SMEMBERS as one Redis pipeline: one network round trip for N keys instead of N
    // (B1 — the Availability Index sweep made ~8,750 sequential reads per Leg). Returns one
    // array per key, in key order, `[]` for a missing key: exactly what N calls to
    // `smembers` return. Error semantics are the sequential calls' too: the first command that
    // fails disables Redis just as `smembers` would on it, and that key and every later one
    // are answered from the in-memory sets, as each later sequential call would have been.
    async smembersMany(keys) {
      if (!Array.isArray(keys) || keys.length === 0) return [];
      const out = new Array(keys.length);
      let next = 0;
      if (redisAvailable && redis) {
        try {
          const p = redis.pipeline();
          for (const key of keys) p.smembers(key);
          const results = await p.exec();
          for (; next < keys.length; next += 1) {
            const [err, value] = (results && results[next]) || [new Error("no pipeline reply")];
            if (err) {
              disableRedis(err);
              break;
            }
            out[next] = Array.isArray(value) ? value : [];
          }
        } catch (e) {
          disableRedis(e);
        }
      }
      for (; next < keys.length; next += 1) out[next] = memorySMembers(keys[next]);
      return out;
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
          const lost = connectionFailureIn(await pipeline.exec());
          if (lost) throw lost;
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

    // Mixed get/set batch executed as one Redis pipeline (one network
    // round-trip for N commands) instead of N individually-awaited calls.
    // NOT a transaction (no MULTI) — commands can still partially apply on a
    // connection error, same as today's independent calls; this only
    // collapses round-trips, it doesn't add cross-key atomicity. Falls back
    // to sequential in-memory ops (same graceful-degradation contract as the
    // rest of this facade) when Redis is unavailable.
    //
    // Usage: const [a, b] = await kv.pipeline().get(k1).get(k2).exec();
    //        await kv.pipeline().set(k1, v1, { ex: 30 }).set(k2, v2).exec();
    pipeline() {
      const ops = [];
      const builder = {
        get(key) {
          ops.push({ type: "get", key });
          return builder;
        },
        set(key, value, ...options) {
          const ex = expirySeconds(options);
          ops.push({ type: "set", key, value, ex });
          return builder;
        },
        async exec() {
          if (redisAvailable && redis) {
            try {
              const p = redis.pipeline();
              for (const o of ops) {
                if (o.type === "get") p.get(o.key);
                else if (typeof o.ex === "number" && Number.isFinite(o.ex) && o.ex > 0) p.set(o.key, o.value, "EX", Math.floor(o.ex));
                else p.set(o.key, o.value);
              }
              const results = await p.exec();
              const lost = connectionFailureIn(results);
              if (lost) throw lost;
              // ioredis pipeline results are [err, result] pairs in command order.
              return results.map(([err, result]) => (err ? null : result));
            } catch (e) {
              disableRedis(e);
            }
          }
          // Fallback: sequential in-memory, preserving get/set order.
          return ops.map((o) => {
            if (o.type === "get") return memoryGet(o.key);
            memorySet(o.key, o.value, { ex: o.ex });
            return undefined;
          });
        },
      };
      return builder;
    },

    /**
     * Atomically increment a counter and set/refresh its TTL.
     * INCR and EXPIRE run in one MULTI, so a connection lost between the two cannot leave
     * a counter with no expiry — for `pairingAttempts:{robotId}` that would count failures
     * forever instead of per 300 s window. Falls back to GET+SET in memory.
     *
     * @param {string} key
     * @param {{ ex?: number }} [options]  ex = TTL in seconds
     * @returns {Promise<number>} new value after increment
     */
    async incr(key, { ex } = {}) {
      if (redisAvailable && redis) {
        try {
          if (!(typeof ex === "number" && Number.isFinite(ex) && ex > 0)) return await redis.incr(key);
          const results = await redis.multi().incr(key).expire(key, Math.floor(ex)).exec();
          const [incrErr, next] = (results && results[0]) || [new Error("MULTI aborted")];
          if (incrErr) throw incrErr;
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
    // ── PHASE 3 (§10.4): this lock is being demoted to ADVISORY ──────────────
    //
    // The frozen architecture is explicit about what this lock is for once the
    // durable commitment core exists:
    //
    //   > A short-lived cache lock per agent is retained, with a changed purpose:
    //   > it prevents *wasted work*, not incorrect outcomes. Two coordinators
    //   > evaluating the same agent will have one back off early rather than both
    //   > reach the transaction and have one abort. It is therefore permitted to
    //   > be lossy, and its loss degrades throughput only. Because it is advisory,
    //   > cache unavailability MUST NOT halt commitment.
    //
    // §10.2 states why it was never sufficient on its own: a lock with a timeout
    // cannot provide mutual exclusion across a process pause, because a paused
    // holder cannot know it was preempted. The remedy is a fencing token, not a
    // longer TTL — which is what `src/engine/commitment/` now supplies.
    //
    // ── Why the fail-closed throw is still here ─────────────────────────────
    //
    // The execution plan conditions the removal, and the condition is not yet met:
    //
    //   > `reserveRobot` demoted to advisory; remove the fail-closed *throw* only
    //   > after the durable path is live — see Risk.
    //   > Demote `kv.reserveRobot` to advisory (§10.4) — **only after** the durable
    //   > path passes its gate.
    //
    // ── PHASE 15 — the condition is met, and the default has flipped ────────
    //
    // The plan's Phase 15 Redis row: "Retire `robotReserve:*` reliance for
    // correctness (it remains advisory)." The condition it was waiting on was the
    // durable path being live, and the cutover satisfies it: the legacy dispatcher
    // is removed from the build, `task.service.js` no longer reserves anything, and
    // **no caller in this repository depends on this lock for exclusivity.** That
    // job belongs entirely to `engine/commitment/commit.js` — a SERIALIZABLE
    // transaction with `FOR UPDATE` row locks on the agent and the Leg, guards
    // G1-G6, a per-commitment fencing token, and two schema backstops that hold
    // even when application logic is defective.
    //
    // So `advisory` now defaults to **true**: §10.4's semantics, in which losing
    // the lock degrades throughput and never correctness. The fail-closed throw is
    // retained and reachable by passing `{ advisory: false }` explicitly, because
    // deleting it would remove the ability to express "this caller has no other
    // exclusivity mechanism" — and a future integration might. What it must never
    // again be is the default, which is what made a cache outage able to halt
    // allocation for a system whose §3.3 rule says the opposite:
    //
    //   > cache unavailability MUST NOT halt commitment.
    //
    // ── The retained legacy policy, unchanged ───────────────────────────────
    // FAIL-CLOSED POLICY (HR1) — for a non-advisory caller this must NOT silently
    // fall back to the in-memory Map when Redis is configured but unreachable. An
    // in-memory lock is only a lock relative to its own process; two replicas that
    // have both degraded would each be granted the same robot, with no error and
    // no metric, reintroducing the exact double-assignment race F4 exists to
    // prevent — and doing so precisely in the multi-instance deployment where it
    // matters.
    //
    // Halting allocation is a recoverable business problem (orders queue and are
    // retried). Double-assigning a physical vehicle is not.
    //
    // When Redis was never configured (no REDIS_URL, or REDIS_ENABLED=false) the
    // deployment is explicitly single-process, so the memory-backed lock is
    // genuinely correct and is still used.
    async reserveRobot(key, value, ttlSec, options) {
      const ex = typeof ttlSec === "number" && Number.isFinite(ttlSec) && ttlSec > 0 ? Math.floor(ttlSec) : 30;
      // PHASE 15 — advisory by default. Only a caller that explicitly passes
      // `{ advisory: false }` — declaring that it has no other exclusivity mechanism —
      // gets the fail-closed throw. No caller in this repository does.
      const advisory = !options || options.advisory !== false;

      if (redisAvailable && redis) {
        try {
          const res = await redis.set(key, value, "EX", ex, "NX");
          return res === "OK";
        } catch (e) {
          disableRedis(e);
          // Fall through: to the advisory grant for an engine caller, or to the
          // fail-closed guard below for a legacy one.
        }
      }

      // Reached only when the Redis attempt above did not answer. What happens next
      // turns on *why*, and the two reasons are not the same fact:
      //
      //   - Redis was configured and is unreachable. The operator asked for a shared
      //     lock and there is not one. An advisory caller is granted it (§10.4:
      //     "cache unavailability MUST NOT halt commitment" — the durable commit
      //     transaction decides the outcome and takes no cache dependency at all); a
      //     caller that declared `{ advisory: false }` gets the fail-closed throw,
      //     because it has told us this lock is its only exclusivity mechanism.
      //   - Redis was never configured. The deployment is explicitly single-process,
      //     so the memory-backed lock is genuinely a lock and is used — for advisory
      //     and non-advisory callers alike. Short-circuiting an advisory caller to
      //     `true` here would throw away a correct lock and is the ordering bug this
      //     branch is written out longhand to prevent.
      if (redisConfigured) {
        if (advisory) return true;
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

    /**
     * Subscribe to the facade's mode changes: `"fallback"` when a connected Redis is lost and
     * reads and writes move to the in-memory store, `"recovered"` when Redis answers again with
     * the outage reconciled. Never called when Redis is not configured.
     *
     * @param {(mode: "fallback"|"recovered") => void|Promise<void>} listener
     * @returns {() => void} unsubscribe
     */
    onModeChange(listener) {
      if (typeof listener !== "function") return () => {};
      modeListeners.add(listener);
      return () => modeListeners.delete(listener);
    },

    // Best-effort health signal for monitoring endpoints.
    //   redis        — a live connection is currently usable
    //   configured   — the operator asked for Redis at all
    //   reconnecting — configured, currently down, and actively being retried
    //                  (i.e. degraded but not permanently latched)
    //   memoryEntries — keys held by the in-memory store (all of them when Redis is off)
    //   outagePending — keys and set members written during the current outage, reconciled on
    //                   reconnect (always 0 when Redis is off or connected)
    health() {
      let pendingMembers = 0;
      for (const changes of outageMembers.values()) pendingMembers += changes.size;
      return {
        redis: Boolean(redisAvailable && redis),
        configured: redisConfigured,
        reconnecting: Boolean(redisConfigured && !redisAvailable),
        memoryEntries: memoryKv.size,
        outagePending: outageKeys.size + pendingMembers,
      };
    },
  };

  await initRedis();

  return {
    kv,
    async close() {
      closed = true;
      modeListeners.clear();
      clearInterval(sweepTimer);
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
  redisSettings,
  MEMORY_SWEEP_INTERVAL_MS,
};
