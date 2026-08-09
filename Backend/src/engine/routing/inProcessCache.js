"use strict";

/**
 * The in-process routing cache tier (§20.1, §20.3) — **Tier 1**, engine-independent.
 *
 * ── Why this module exists ──────────────────────────────────────────────────
 * §20.1 states two things about the return-leg population that cannot both be true of a
 * network round trip:
 *
 * > | **Return-leg** charger-reachability lookup, per candidate | **< 10 µs cached**, < 2 ms
 * > on miss | The *second* per-candidate routing population, required by `E_return` (§14.5) |
 *
 * and §20.2 sizes that population at `O(m · k)` — 500 × 200 = 100 000 lookups per round at
 * §9.4's own caps, alongside the approach population's identical count. A Redis `GET` on
 * loopback measures p50 **304 µs** / p99 **1 156 µs** on the build machine
 * (`PHASE_15_B1_ROUTING_DECISION_REPORT.md` §7.1) — 30× to 115× the row it must serve, and
 * 100 000 × 304 µs ≈ **30 s** against a 250 ms whole-round budget. No routing engine changes
 * that arithmetic, which is why this tier is designed and built *before* blocking decision
 * B1 rather than after it.
 *
 * The conclusion the B1 report reaches (finding N16) is architectural, not incidental:
 *
 * > The Phase 8 routing client therefore requires an **in-round, in-process** tier in front
 * > of Redis, with Redis as the cross-round tier.
 *
 * ── What this module is, and what it deliberately is not ────────────────────
 * It is a bounded, version-namespaced, clock-free key/value store plus a **kv-shaped
 * façade** that layers it over an injected cross-round kv. That shape is the whole design:
 * `cellPairCache.js` and `chargerReachabilityCache.js` already take their kv client as an
 * injected dependency, so a façade satisfying the same `get`/`set` contract composes in
 * front of them **without either cache module changing by one character**. The §6.2 seam
 * that has kept B1 from contaminating the rest of the engine stays exactly where it is.
 *
 * It is **not** the routing client. It issues no query, holds no adapter, knows no engine,
 * and implements no part of §5.2's degradation ladder. A miss here is a miss — what to do
 * about one is the round's decision, and building that decision is Phase 8 work behind B1.
 *
 * ── Neither tier is an authority (§3.3, invariant I16) ──────────────────────
 * §3.3 requires that the cache tier hold no correctness-critical sole copy. That property
 * is preserved and strengthened: L1 holds a strict subset of what L2 holds, L2 holds what
 * the engine can recompute, and dropping either costs latency and nothing else. Every
 * failure path degrades toward a miss, never toward an answer.
 *
 * ── Correctness: why an L1 hit is the same value an L2 hit would have been ──
 * Three properties, and all three are already established by the callers rather than
 * invented here:
 *
 *   1. **Keys carry their own versions.** §20.3 item 2 keys on `(origin_cell,
 *      destination_cell, mobility_profile, time_bucket)` and item 3 on `(destination_cell,
 *      mobility_profile, time_bucket, charger_availability_version)`. A new profile, bucket
 *      or projection is a **new key**, never an overwritten one, so no version transition is
 *      capable of producing a stale hit. §20.3 states the reason for item 3 explicitly:
 *      "an entry computed against one availability projection is never silently applied
 *      under another, which preserves both the reserve's meaning and replay determinism".
 *   2. **The namespace carries what the key does not.** A cell id is an *opaque token
 *      supplied by the published map* (`spatial/cells.js`), so two configuration versions
 *      may use the same token for different geography. The key cannot see that; the
 *      namespace can. It is required at construction, it prefixes every entry, and a
 *      changed namespace therefore cannot hit an entry written under the old one — epoch
 *      invalidation with no sweep and no bulk delete.
 *   3. **L1 never outlives L2.** The effective TTL of an entry is the *minimum* of this
 *      tier's own TTL and whatever TTL the caller passed to the underlying kv. A tier that
 *      could outlive the store behind it would turn a deliberate expiry into a stale answer
 *      served from memory, which is precisely the failure the TTL exists to prevent.
 *
 * ── Determinism (T6, §9.6): the clock is injected, never read ───────────────
 * A TTL needs a time and the decision path may not read one. Every operation therefore
 * takes `nowMs` from the caller, which takes it from the round's pinned decision time — the
 * same discipline that makes `timeBucket` an input to both caches rather than something
 * they derive. Two workers in one round expiring against one pinned instant agree; two
 * workers reading their own host clocks would not.
 *
 * Note what determinism does and does not require here. The *value* returned for a key is
 * identical whether it came from L1, from L2, or from the engine — that is property 1
 * above, and it is what replay depends on. Which *tier* served it is a property of one
 * process's history and is deliberately **not** part of any decision record: it is an SLI
 * (§20.3, §21.4) and nothing more.
 *
 * ── Isolation ───────────────────────────────────────────────────────────────
 * The store is per-process and is never shared between processes, so no cross-worker
 * coherency protocol is required or implied — coherency comes from the key discipline
 * above, not from invalidation messages. Shard isolation is the caller's, through the
 * namespace: `route.*` is region-scoped (§22.2), so a process serving two shards MUST give
 * each its own namespace, and the natural namespace is the pinned config version, the
 * spatial map version, and the shard id together.
 *
 * ── Bounds ──────────────────────────────────────────────────────────────────
 * `maxEntries` is required and has no default. An unbounded process-local cache in front of
 * a 100 000-lookup round is a memory leak with good latency, and the bound is a deployment
 * property (§3.5 makes routing a per-shard resource cost) rather than something this module
 * is entitled to choose. Eviction is least-recently-used and deterministic: recency is the
 * store's own insertion order, so the same access sequence always evicts the same entry.
 *
 * ── What is registered, and what is not, and why ────────────────────────────
 * §22.1 rule 1 admits no behavioural constant in code. This module holds none: `maxEntries`
 * and `ttlMs` are **required constructor arguments** that throw when absent, so the policy
 * lives wherever the composition root resolves it and the mechanism lives here. When the
 * Phase 8 routing client ships and becomes the thing that constructs this tier, those two
 * values are what it must register under §22.1 with unit, range, owner, change class and
 * blast radius. Registering them now, with no module reading them and no deployment to size
 * them against, would be exactly the uncalibrated-and-unowned constant the gate exists to
 * refuse.
 */

/** @structural the two §20.3 populations this tier is built for, reported separately */
const POPULATION = Object.freeze({
  /** §20.3 item 2 — approach and linehaul, anchored on mission origins. */
  CELL_PAIR: "CELL_PAIR",
  /** §20.3 item 3 — the return leg, anchored on projected mission-end cells. Tier 0 input. */
  CHARGER_REACHABILITY: "CHARGER_REACHABILITY",
});

/**
 * The namespace separator. Neither shipped cache module emits a `|` — `cellPairCache` builds
 * `engine:route:cell:…` and `chargerReachabilityCache` builds `engine:charger:reach:…`, both
 * colon-delimited — and the namespace is composed by the caller from version identifiers, so
 * no namespace and key can collide by concatenation.
 * @structural a key-framing delimiter, not a tunable value
 */
const NAMESPACE_SEPARATOR = "|";

/**
 * @param {*} value
 * @returns {boolean}
 */
function isPositiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * @param {*} value
 * @returns {boolean}
 */
function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

/**
 * The TTL a caller asked the underlying kv for, in milliseconds, from either of the two
 * argument shapes the shipped caches use.
 *
 * `cellPairCache.write()` calls `kv.set(key, value, "EX", seconds)` — ioredis positional
 * form — and `chargerReachabilityCache.write()` calls `kv.set(key, value, { ex: seconds })`.
 * Both are read here rather than either being normalised at the call site, because
 * normalising would mean editing a Tier 0 module to accommodate a Tier 1 optimisation.
 *
 * @param {unknown[]} rest the arguments after key and value
 * @returns {number|null} milliseconds, or null when the caller stated no expiry
 */
function callerTtlMs(rest) {
  /** @structural seconds → milliseconds */
  const MS_PER_SECOND = 1000;

  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];

    if (typeof argument === "string" && argument.toUpperCase() === "EX") {
      const seconds = Number(rest[index + 1]);
      return isPositiveNumber(seconds) ? seconds * MS_PER_SECOND : null;
    }
    if (typeof argument === "string" && argument.toUpperCase() === "PX") {
      const ms = Number(rest[index + 1]);
      return isPositiveNumber(ms) ? ms : null;
    }
    if (argument && typeof argument === "object") {
      if (isPositiveNumber(Number(argument.ex))) return Number(argument.ex) * MS_PER_SECOND;
      if (isPositiveNumber(Number(argument.px))) return Number(argument.px);
    }
  }

  return null;
}

/**
 * A bounded, namespaced, clock-free in-process store.
 *
 * Entries are opaque: whatever the caller wrote is what a hit returns, byte for byte. The
 * shipped caches write JSON strings and parse them on read, and this tier deliberately does
 * not parse on their behalf — a tier that handed back a shared parsed object would let one
 * round's mutation reach the next round's read, and `cellPairCache.read()` parses
 * unconditionally, so returning anything other than what was written would turn every hit
 * into a silent miss.
 */
class InProcessTier {
  /**
   * @param {object} options
   * @param {number} options.maxEntries hard bound on retained entries; required
   * @param {number} options.ttlMs this tier's own entry lifetime; required
   * @param {string} options.namespace epoch identity — config version, spatial map version,
   *   and shard id; required
   * @param {string} [options.population] one of `POPULATION`, for reporting only
   */
  constructor(options) {
    const settings = options || {};

    if (!Number.isInteger(settings.maxEntries) || settings.maxEntries < 1) {
      throw new Error(
        "the in-process routing tier requires an integer maxEntries of at least 1. It has no default: " +
          "an unbounded process-local cache in front of a 100 000-lookup round (§20.2) is a memory leak " +
          "with good latency, and the bound is a per-shard deployment property (§3.5), not this module's " +
          "to choose (§22.1 rule 1).",
      );
    }
    if (!isPositiveNumber(settings.ttlMs)) {
      throw new Error(
        "the in-process routing tier requires a positive ttlMs. It has no default: the entry lifetime is " +
          "behavioural configuration (§22.1 rule 1), and a tier that chose its own would decide how long a " +
          "congestion bucket's travel time stays believable (§20.3 item 6).",
      );
    }
    if (!isNonEmptyString(settings.namespace)) {
      throw new Error(
        "the in-process routing tier requires a namespace. A cell id is an opaque token supplied by the " +
          "published map (§3.6), so two configuration versions may name different geography with the same " +
          "token; the namespace is what stops an entry written under one being served under the other.",
      );
    }

    this.maxEntries = settings.maxEntries;
    this.ttlMs = settings.ttlMs;
    this.namespace = settings.namespace;
    this.population = settings.population || null;

    /**
     * Insertion order is recency order: a hit deletes and re-inserts, so the first key the
     * iterator yields is the least recently used. This is what makes eviction deterministic
     * — the same access sequence always evicts the same entry — where a sampled or
     * clock-based approximation would not be.
     * @type {Map<string, { value: *, expiresAtMs: number }>}
     */
    this.entries = new Map();

    this.hits = 0;
    this.misses = 0;
    this.expiries = 0;
    this.evictions = 0;
    this.writes = 0;
  }

  /**
   * @param {string} key
   * @returns {string}
   */
  namespacedKey(key) {
    return `${this.namespace}${NAMESPACE_SEPARATOR}${key}`;
  }

  /**
   * Read one entry.
   *
   * An expired entry is deleted and reported as a miss rather than returned with a warning:
   * §20.3's whole reason for a TTL is that a travel time stops describing its congestion
   * bucket, and a stale answer to a routing query is not a degraded answer but a wrong one.
   *
   * The TTL is **never extended on read**. Refresh-on-access would let a hot cell pair
   * outlive every bucket boundary indefinitely, which is the one entry most likely to be
   * consulted and the one least able to afford being wrong.
   *
   * @param {string} key
   * @param {number} nowMs the round's pinned decision time (T6: injected, never read)
   * @returns {{ hit: boolean, value: *, reason: string }}
   */
  get(key, nowMs) {
    if (!isNonEmptyString(key)) return { hit: false, value: null, reason: "no key supplied" };
    if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) {
      // Fail closed to a miss rather than guessing an instant. A tier that supplied its own
      // clock here would be the wall-clock read T6 prohibits, one indirection away.
      this.misses += 1;
      return { hit: false, value: null, reason: "no pinned decision time supplied; expiry cannot be evaluated" };
    }

    const full = this.namespacedKey(key);
    const record = this.entries.get(full);

    if (record === undefined) {
      this.misses += 1;
      return { hit: false, value: null, reason: "miss" };
    }

    if (record.expiresAtMs <= nowMs) {
      this.entries.delete(full);
      this.expiries += 1;
      this.misses += 1;
      return { hit: false, value: null, reason: "expired" };
    }

    // Move to the most-recently-used end without touching the expiry.
    this.entries.delete(full);
    this.entries.set(full, record);
    this.hits += 1;
    return { hit: true, value: record.value, reason: "hit" };
  }

  /**
   * Write one entry, evicting the least recently used when the bound is reached.
   *
   * @param {string} key
   * @param {*} value stored as supplied; see the class note on opacity
   * @param {number} nowMs the round's pinned decision time
   * @param {number|null} [maxLifetimeMs] the underlying store's own TTL for this entry, when
   *   the caller stated one. The effective lifetime is the **minimum** of it and this tier's:
   *   an L1 entry that outlived its L2 counterpart would convert a deliberate expiry into a
   *   stale answer served from memory.
   * @returns {boolean} whether the entry was retained
   */
  set(key, value, nowMs, maxLifetimeMs) {
    if (!isNonEmptyString(key)) return false;
    if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) return false;

    const lifetimeMs = isPositiveNumber(maxLifetimeMs) ? Math.min(this.ttlMs, maxLifetimeMs) : this.ttlMs;
    const full = this.namespacedKey(key);

    // Delete first so a re-write moves the key to the most-recently-used end rather than
    // leaving it at its original position with a new expiry.
    this.entries.delete(full);
    this.entries.set(full, { value, expiresAtMs: nowMs + lifetimeMs });
    this.writes += 1;

    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
      this.evictions += 1;
    }

    return true;
  }

  /**
   * Drop one entry. Present for operational invalidation, not for correctness: correctness
   * comes from the key and the namespace, both of which make a change a different key rather
   * than an entry needing removal.
   *
   * @param {string} key
   * @returns {boolean}
   */
  delete(key) {
    if (!isNonEmptyString(key)) return false;
    return this.entries.delete(this.namespacedKey(key));
  }

  /** Drop everything. Costs latency and nothing else (§3.3). */
  clear() {
    this.entries.clear();
  }

  /** @returns {number} */
  get size() {
    return this.entries.size;
  }

  /**
   * The §20.3 / §21.4 SLI view. Hit rate is reported and no target is applied here: §20.3's
   * targets are *steady-state* rates over live demand, and a single process's counters since
   * start-up are not that quantity.
   *
   * @returns {object}
   */
  stats() {
    const reads = this.hits + this.misses;
    return Object.freeze({
      population: this.population,
      namespace: this.namespace,
      maxEntries: this.maxEntries,
      ttlMs: this.ttlMs,
      size: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      reads,
      hitRate: reads === 0 ? null : this.hits / reads,
      expiries: this.expiries,
      evictions: this.evictions,
      writes: this.writes,
    });
  }

  /** Reset the counters without dropping the entries, for per-round reporting. */
  resetCounters() {
    this.hits = 0;
    this.misses = 0;
    this.expiries = 0;
    this.evictions = 0;
    this.writes = 0;
  }
}

/**
 * Construct a tier.
 *
 * @param {object} options see `InProcessTier`
 * @returns {InProcessTier}
 */
function createTier(options) {
  return new InProcessTier(options);
}

/**
 * Layer a tier in front of a cross-round kv, producing something kv-shaped.
 *
 * This is the composition the whole module exists for: the result satisfies exactly the
 * `get`/`set` contract `cellPairCache` and `chargerReachabilityCache` already inject, so
 * neither changes and the §6.2 routing seam is preserved intact. Substituting it is a
 * composition-root decision, which is where a deployment property belongs.
 *
 * ── Read path ───────────────────────────────────────────────────────────────
 * L1 hit → return. L1 miss → L2, and **promote** the L2 answer into L1, because the second
 * of the 40 reads a cell pair receives in a 500 × 200 round should not pay a second round
 * trip. An L2 error is a miss (I16) and is never promoted.
 *
 * ── Write path ──────────────────────────────────────────────────────────────
 * Write-through, L2 first. If the durable-ish tier refuses the write, the process-local one
 * does not keep a copy the rest of the fleet cannot see: a write failure is already silent
 * in both cache modules, and a silent failure that populated only this process would make
 * one worker's hit rate a function of another worker's Redis errors.
 *
 * ── Single flight ───────────────────────────────────────────────────────────
 * Concurrent L1 misses for the same key share **one** L2 read. Two candidates in one round
 * asking for the same cell pair at the same moment is the common case, not the exotic one.
 * Note the boundary: this collapses duplicate *cache* reads only. §20.3 item 7's "negative
 * and result caching for repeated identical queries within a round" — collapsing duplicate
 * *engine* queries — belongs to the routing client, which is Phase 8 work behind B1 and is
 * deliberately not implemented here.
 *
 * @param {object} options
 * @param {InProcessTier} options.tier
 * @param {object|null} options.kv the cross-round tier; may be null, leaving L1 alone
 * @param {number} options.nowMs the round's pinned decision time
 * @returns {object} a kv-shaped `{ get, set, stats, tier, kv }`
 */
function layeredKv(options) {
  const settings = options || {};
  const tier = settings.tier;
  const kv = settings.kv || null;
  const nowMs = settings.nowMs;

  if (!(tier instanceof InProcessTier)) {
    throw new Error("layeredKv requires the in-process tier it is layering; it constructs none of its own");
  }
  if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) {
    throw new Error(
      "layeredKv requires the round's pinned decision time. Time in the decision path comes from the " +
        "pinned snapshot, never from the host clock (§1.5 T6, §9.6, I10).",
    );
  }

  const inFlight = new Map();
  const counters = {
    l2Hits: 0,
    l2Misses: 0,
    l2Errors: 0,
    l2Reads: 0,
    l2Writes: 0,
    l2WriteErrors: 0,
    coalesced: 0,
    promotions: 0,
  };

  /**
   * @param {string} key
   * @returns {Promise<*>}
   */
  async function readThrough(key) {
    const local = tier.get(key, nowMs);
    if (local.hit) return local.value;

    if (!kv || typeof kv.get !== "function") return null;

    const pending = inFlight.get(key);
    if (pending) {
      counters.coalesced += 1;
      return pending;
    }

    const attempt = (async () => {
      counters.l2Reads += 1;
      let raw;
      try {
        raw = await kv.get(key);
      } catch {
        // A cache error is a miss, never a verdict (I16).
        counters.l2Errors += 1;
        return null;
      }
      if (raw === null || raw === undefined) {
        counters.l2Misses += 1;
        return null;
      }
      counters.l2Hits += 1;
      // Promoted without a stated lifetime: what L2's own remaining TTL is cannot be known
      // from a GET, so the tier's own TTL bounds it. That is the conservative direction —
      // the promoted copy can only be shorter-lived than the entry it came from.
      tier.set(key, raw, nowMs);
      counters.promotions += 1;
      return raw;
    })();

    inFlight.set(key, attempt);
    try {
      return await attempt;
    } finally {
      inFlight.delete(key);
    }
  }

  return {
    /**
     * @param {string} key
     * @returns {Promise<*>}
     */
    async get(key) {
      return readThrough(key);
    },

    /**
     * @param {string} key
     * @param {*} value
     * @param {...*} rest the caller's own expiry arguments, passed through verbatim
     * @returns {Promise<*>}
     */
    async set(key, value, ...rest) {
      let result = null;
      if (kv && typeof kv.set === "function") {
        try {
          counters.l2Writes += 1;
          result = await kv.set(key, value, ...rest);
        } catch {
          counters.l2WriteErrors += 1;
          // Write failure is silent in both cache modules; keeping a process-local copy the
          // rest of the fleet cannot see would make one worker's hit rate a function of
          // another worker's Redis errors.
          return null;
        }
      }
      tier.set(key, value, nowMs, callerTtlMs(rest));
      return result;
    },

    /**
     * Retained L1 entries. Present because the in-memory kv the B1 harness injects exposes
     * one and the harness reports it; it describes this process's tier and says nothing
     * about how many entries the cross-round tier holds.
     * @returns {number}
     */
    size() {
      return tier.size;
    },

    /** @returns {object} both tiers' counters, reported separately (§20.3). */
    stats() {
      return Object.freeze({
        l1: tier.stats(),
        l2: Object.freeze({ ...counters }),
      });
    },

    tier,
    kv,
  };
}

module.exports = {
  POPULATION,
  NAMESPACE_SEPARATOR,
  InProcessTier,
  createTier,
  layeredKv,
  callerTtlMs,
};
