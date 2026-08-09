"use strict";

/**
 * The in-process routing cache tier — diagnostic measurement.
 *
 * ── What question this answers, and what it does not ────────────────────────
 * `PHASE_15_B1_ROUTING_DECISION_REPORT.md` §7.1 records two engine-independent findings:
 *
 *   **N16** — §20.1's `charger_reachability_cached` target of **< 10 µs p99** is unreachable
 *   through the shipped kv. Loopback Redis `GET` measured p50 **304 µs** / p99 **1 156 µs**,
 *   30×–115× over, before any network.
 *
 *   **N17** — the routing cache path alone costs **241–246 ms** at §20.1's own 500 × 200 /
 *   25-cluster shape, against a **250 ms whole-round** target, with a zero-latency engine and
 *   an in-memory kv.
 *
 * Neither is about any candidate engine, and both are therefore measurable now. This tool
 * measures them again, and measures the same two things with `routing/inProcessCache.js`
 * layered in front, so the improvement is a comparison rather than a claim.
 *
 * **It is not §20.1 gate evidence and does not pretend to be.** §20.1 is stated per shard, at
 * p99, under nominal operation, on representative production hardware, over the *whole*
 * round. This is a single process on a build machine measuring one stage. It can rule a
 * design OUT; it cannot rule one IN. Every report it prints carries that provenance line, for
 * the same reason `b1Benchmark.js` and `scaleHarness.js` attach one.
 *
 * **It measures no routing engine and selects none.** The cache path is exercised with engine
 * latency held at zero, exactly as §7.1 did, because the quantity under test is the lookup
 * tier and an engine's latency would be added to both sides of every comparison equally.
 *
 * ── The four configurations ─────────────────────────────────────────────────
 *   A  memory            the §7.1 baseline: caches given an in-memory Map. A lower bound no
 *                        deployment enjoys, reproduced so the comparison has an anchor.
 *   B  memory + L1       the tier over that lower bound. Isolates what the tier costs when
 *                        the store behind it is already free.
 *   C  redis             the **shipped** configuration: `src/cache/kv.js` is ioredis.
 *   D  redis + L1        the proposed configuration.
 *
 * C versus D is the decisive pair. A and B exist so the result can be read against §7.1's
 * published figures rather than against nothing.
 *
 * ── Run the sections separately ─────────────────────────────────────────────
 * `--only cache-path` exists because the 500 × 200 section is sensitive to the heap it runs
 * in: the latency sections above it allocate hundreds of thousands of samples, and a
 * cache-path figure measured after them is measured under GC pressure the round would not
 * have. A figure meant to be compared against §7.1's published 241–246 ms must be taken in a
 * process that has done nothing else, and this flag is how.
 *
 * Usage:
 *   node tools/routing/inProcessCacheBenchmark.js [--redis <url>] [--runs 3] [--json]
 *   node tools/routing/inProcessCacheBenchmark.js --only cache-path --runs 5
 *   node tools/routing/inProcessCacheBenchmark.js --only latency
 *   node tools/routing/inProcessCacheBenchmark.js --no-redis      (A and B only)
 * Exit code is 0 unless the tool itself failed. It states findings; it gates nothing.
 */

const service = require("../../src/engine/config/service");
const chargerCache = require("../../src/engine/routing/chargerReachabilityCache");
const inProcess = require("../../src/engine/routing/inProcessCache");
const b1 = require("./b1Benchmark");

/** @structural nanoseconds per microsecond / millisecond, and seconds per millisecond */
const NS_PER_US = 1e3;
const NS_PER_MS = 1e6;
const BYTES_PER_MIB = 1024 * 1024;

/** The pinned instant every measured round is evaluated against (T6: injected, never read). */
const PINNED_NOW_MS = 1_700_000_000_000;

/**
 * Sizing for the measured runs. These are properties of *this measurement*, not of the
 * system: the tier itself takes its bound and its TTL as required arguments and holds no
 * default (§22.1 rule 1). They are stated here so the report can quote what was measured.
 * @structural the measurement's own shape
 */
const MEASUREMENT = Object.freeze({
  /** Comfortably above the round's distinct-key working set, so eviction is not under test. */
  l1MaxEntries: 50_000,
  /** Matches `route.cell_pair_cache_ttl` (900 s) so L1 and L2 expire together. */
  l1TtlMs: 900_000,
  namespace: "bench|cfg:default|map:0|shard:BENCH",
  /** Samples for the per-operation latency distributions. */
  latencySamples: 200_000,
  /** Samples for the Redis `GET` reproduction of §7.1. */
  redisSamples: 2_000,
});

const PROVENANCE =
  "PROVENANCE: single process, this machine, one stage of the round, zero-latency engine. " +
  "NOT §20.1 gate evidence — §20.1 is stated per shard, at p99, under nominal operation, on " +
  "representative production hardware, over the whole round.";

/**
 * @param {number[]} values
 * @param {number} quantile
 * @returns {number|null}
 */
function percentile(values, quantile) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(quantile * sorted.length) - 1));
  return sorted[index];
}

/**
 * @param {number[]} values
 * @returns {object}
 */
function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (quantile) => percentile(sorted, quantile);
  return {
    n: sorted.length,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    // Reported only where the sample supports it: a p99.9 over fewer than 1 000 samples is
    // the maximum wearing a percentile's name.
    p999: sorted.length >= 1_000 ? at(0.999) : null,
    // Read off the sorted array rather than spread through `Math.max`, which overflows the
    // call stack at these sample counts.
    max: sorted.length === 0 ? null : sorted[sorted.length - 1],
  };
}

/** The in-memory kv `b1Benchmark` uses. Re-exported through it so there is one definition. */
const memoryKv = b1.memoryKv;

/**
 * An ioredis client wearing the two-method kv shape the caches inject.
 *
 * @param {object} redis
 * @returns {object}
 */
function redisKv(redis) {
  return {
    async get(key) {
      return redis.get(key);
    },
    async set(key, value, ...rest) {
      const ttlMs = inProcess.callerTtlMs(rest);
      /** @structural milliseconds → seconds */
      const MS_PER_SECOND = 1000;
      if (ttlMs) return redis.set(key, value, "EX", Math.max(1, Math.round(ttlMs / MS_PER_SECOND)));
      return redis.set(key, value);
    },
    /** The B1 harness reports the tier's entry count; a remote store's is not this cheap. */
    size() {
      return null;
    },
  };
}

/**
 * A kv that hands back the parsed object rather than the stored string.
 *
 * **Not the shipped contract**, and not proposed as one by this tool. It prices one
 * question: §20.1 budgets 10 µs for a cached return-leg lookup, and one `JSON.parse` of a
 * `k = 5` charger entry costs more than that on its own. This wrapper is how much of the row
 * is the parse, measured rather than asserted, so the Phase 8 decision about the cache
 * modules' value contract is taken against a number.
 *
 * @param {object} kv
 * @returns {object} kv-shaped
 */
function parsedValueKv(kv) {
  return {
    async get(key) {
      const raw = await kv.get(key);
      if (raw === null || raw === undefined) return null;
      return typeof raw === "string" ? JSON.parse(raw) : raw;
    },
    async set(key, value, ...rest) {
      return kv.set(key, value, ...rest);
    },
    size() {
      return typeof kv.size === "function" ? kv.size() : null;
    },
  };
}

/**
 * Wrap any kv in the tier under test.
 *
 * @param {object|null} kv
 * @param {string} population
 * @returns {object} kv-shaped
 */
function layered(kv, population) {
  const tier = inProcess.createTier({
    maxEntries: MEASUREMENT.l1MaxEntries,
    ttlMs: MEASUREMENT.l1TtlMs,
    namespace: MEASUREMENT.namespace,
    population,
  });
  return inProcess.layeredKv({ tier, kv, nowMs: PINNED_NOW_MS });
}

/* ═══════════════════════════════════════════════════════════════════════════
   1 — the raw tier, and §20.1's charger_reachability_cached row through it
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * The instrument's own floor: what `process.hrtime.bigint()` around an operation that does
 * nothing costs, measured the same way everything else here is.
 *
 * This is reported first because without it two of the figures below cannot be read. A
 * `Map.get` and a `JSON.parse` are both operations whose cost is comparable to the timer
 * that brackets them, and a per-operation percentile at that scale is substantially a
 * measurement of the clock. Where an operation is near the floor, the **amortised** figure —
 * one timer around a batch, divided by the batch — is the honest one, and both are given.
 *
 * @returns {object}
 */
function measureTimerFloor() {
  const samples = [];
  let sink = 0;
  for (let index = 0; index < MEASUREMENT.latencySamples; index += 1) {
    const started = process.hrtime.bigint();
    sink += index;
    samples.push(Number(process.hrtime.bigint() - started) / NS_PER_US);
  }
  return { ...distribution(samples), sink };
}

/**
 * One timer around a batch of `batch` calls, repeated, reported as microseconds per call.
 * The timer is paid once per batch instead of once per call, so an operation far below the
 * instrument's floor is measurable.
 *
 * @param {function} operation called with the iteration index
 * @param {number} batch
 * @param {number} batches
 * @returns {object} the per-call distribution across batches, plus the overall mean
 */
function amortised(operation, batch, batches) {
  const perCall = [];
  let total = 0;
  for (let round = 0; round < batches; round += 1) {
    const started = process.hrtime.bigint();
    for (let index = 0; index < batch; index += 1) operation(round * batch + index);
    const elapsedUs = Number(process.hrtime.bigint() - started) / NS_PER_US;
    total += elapsedUs;
    perCall.push(elapsedUs / batch);
  }
  return { ...distribution(perCall), meanUsPerCall: total / (batch * batches), batch, batches };
}

/**
 * The tier's own `get`, with nothing else in the timer.
 *
 * @returns {object}
 */
function measureTierGet() {
  const tier = inProcess.createTier({
    maxEntries: MEASUREMENT.l1MaxEntries,
    ttlMs: MEASUREMENT.l1TtlMs,
    namespace: MEASUREMENT.namespace,
    population: inProcess.POPULATION.CHARGER_REACHABILITY,
  });

  const keys = [];
  /** @structural the distinct-key working set for this micro-measurement */
  const DISTINCT = 5_000;
  for (let index = 0; index < DISTINCT; index += 1) {
    const key = `engine:charger:reach:cell:${index}:profile:0:7`;
    keys.push(key);
    tier.set(key, JSON.stringify(chargerEntryFor(index)), PINNED_NOW_MS);
  }

  const samples = [];
  for (let index = 0; index < MEASUREMENT.latencySamples; index += 1) {
    const key = keys[index % keys.length];
    const started = process.hrtime.bigint();
    tier.get(key, PINNED_NOW_MS);
    samples.push(Number(process.hrtime.bigint() - started) / NS_PER_US);
  }

  /** @structural calls per timed batch, for the amortised figure */
  const BATCH = 1_000;
  const batched = amortised((index) => tier.get(keys[index % keys.length], PINNED_NOW_MS), BATCH, MEASUREMENT.latencySamples / BATCH);

  return { distribution: distribution(samples), amortised: batched, stats: tier.stats() };
}

/**
 * A realistic §20.3 item 3 entry: `route.charger_reachability_k` chargers with travel time
 * and energy, ordered. Its size is what the JSON round trip costs.
 *
 * @param {number} seed
 * @returns {object}
 */
function chargerEntryFor(seed) {
  /** @structural the entry shape chargerReachabilityCache.buildEntry produces */
  const K = 5;
  const chargers = [];
  for (let index = 0; index < K; index += 1) {
    chargers.push({
      chargerId: `CHG-${seed}-${index}`,
      chargerClass: "DEPOT_AC",
      isDepot: index === 0,
      distanceM: 800 + index * 150,
      travelSeconds: 400 + index * 75,
      energyWh: 40 + index * 7.5,
      intraCellOffsetM: 250,
    });
  }
  return { projectionVersion: 7, profileKey: "profile", cellId: `cell:${seed}`, timeBucket: 0, k: K, truncated: false, chargers };
}

/**
 * §20.1's row as it is actually served: `chargerReachabilityCache.read()` end to end,
 * including the JSON parse and the projection-version check, through one kv.
 *
 * This is the quantity the 10 µs target names. The tier's own `get` above is a component of
 * it, and reporting only the component would flatter the design.
 *
 * @param {object} kv
 * @param {number} samples
 * @returns {Promise<object>}
 */
async function measureChargerCachedRow(kv, samples) {
  /** @structural the distinct destination cells this row is walked over */
  const DISTINCT = 2_500;
  const parts = [];
  for (let index = 0; index < DISTINCT; index += 1) {
    const part = { cellId: `cell:${index}`, profileKey: "profile", timeBucket: 0, projectionVersion: 7 };
    parts.push(part);
    // eslint-disable-next-line no-await-in-loop
    await chargerCache.write({ kv }, part, chargerEntryFor(index), 900);
  }

  // Warm: a cached-row measurement of a cold tier would be measuring the fill.
  for (const part of parts) {
    // eslint-disable-next-line no-await-in-loop
    await chargerCache.read({ kv }, part);
  }

  const observed = [];
  let hits = 0;
  for (let index = 0; index < samples; index += 1) {
    const part = parts[index % parts.length];
    const started = process.hrtime.bigint();
    // eslint-disable-next-line no-await-in-loop
    const read = await chargerCache.read({ kv }, part);
    observed.push(Number(process.hrtime.bigint() - started) / NS_PER_US);
    if (read.hit) hits += 1;
  }

  return { distribution: distribution(observed), hits, samples };
}

/**
 * What §20.1's 10 µs row would cost if the read path were **synchronous and pre-parsed**:
 * one tier lookup plus the projection-version check `chargerReachabilityCache.read()` makes,
 * with no promise and no `JSON.parse` anywhere in the timer.
 *
 * This is **not the shipped contract and is not proposed here as one.** It answers one
 * question that the four measured configurations cannot, and that the Phase 8 routing client
 * has to answer before §20.1's row can be closed: *is 10 µs reachable in process at all, or
 * is the budget unreachable regardless of where the entry is stored?* Every configuration
 * measured above — including the ones with no network in them — exceeds it, so the answer
 * matters and is not derivable from them.
 *
 * @returns {object}
 */
function measureSynchronousPreParsedRow() {
  const tier = inProcess.createTier({
    maxEntries: MEASUREMENT.l1MaxEntries,
    ttlMs: MEASUREMENT.l1TtlMs,
    namespace: MEASUREMENT.namespace,
    population: inProcess.POPULATION.CHARGER_REACHABILITY,
  });

  /** @structural the round's distinct return-leg key count, from §20.1's shape */
  const DISTINCT = 2_500;
  const parts = [];
  for (let index = 0; index < DISTINCT; index += 1) {
    const part = { cellId: `cell:${index}`, profileKey: "profile", timeBucket: 0, projectionVersion: 7 };
    parts.push(part);
    tier.set(chargerCache.key(part).key, Object.freeze(chargerEntryFor(index)), PINNED_NOW_MS);
  }

  /** The read `chargerReachabilityCache.read()` performs, minus the await and the parse. */
  const readOne = (part) => {
    const built = chargerCache.key(part);
    if (!built.ok) return null;
    const found = tier.get(built.key, PINNED_NOW_MS);
    if (!found.hit) return null;
    // The same belt-and-braces version check the shipped read makes: an entry naming a
    // different projection is a miss, never a plausible wrong answer (§20.3 item 3).
    if (String(found.value.projectionVersion) !== String(part.projectionVersion)) return null;
    return found.value;
  };

  const samples = [];
  for (let index = 0; index < MEASUREMENT.latencySamples; index += 1) {
    const part = parts[index % parts.length];
    const started = process.hrtime.bigint();
    readOne(part);
    samples.push(Number(process.hrtime.bigint() - started) / NS_PER_US);
  }

  /** @structural calls per timed batch, for the amortised figure */
  const BATCH = 1_000;
  return {
    distribution: distribution(samples),
    amortised: amortised((index) => readOne(parts[index % parts.length]), BATCH, MEASUREMENT.latencySamples / BATCH),
  };
}

/**
 * How much of the cached row is the JSON parse rather than the lookup.
 *
 * Reported because it is the honest answer to "why is an L1 hit not free": the tier stores
 * the byte string the caller wrote — it must, since `cellPairCache.read()` parses
 * unconditionally and a pre-parsed object would turn every hit into a silent miss — so every
 * hit pays one `JSON.parse`. Whether that is worth removing is a Phase 8 decision about the
 * cache modules' contract, and this figure is what it should be decided on.
 *
 * @returns {object}
 */
function measureSerialisation() {
  const payloads = [];
  /** @structural distinct payloads, so the parse is not measured against one hot shape */
  const DISTINCT = 1_000;
  for (let index = 0; index < DISTINCT; index += 1) payloads.push(JSON.stringify(chargerEntryFor(index)));

  const parse = [];
  for (let index = 0; index < MEASUREMENT.latencySamples; index += 1) {
    const payload = payloads[index % payloads.length];
    const started = process.hrtime.bigint();
    JSON.parse(payload);
    parse.push(Number(process.hrtime.bigint() - started) / NS_PER_US);
  }

  /** @structural calls per timed batch, for the amortised figure */
  const BATCH = 1_000;
  const batched = amortised((index) => JSON.parse(payloads[index % payloads.length]), BATCH, MEASUREMENT.latencySamples / BATCH);

  return {
    parse: distribution(parse),
    parseAmortised: batched,
    meanEntryBytes: Math.round(payloads.reduce((total, payload) => total + payload.length, 0) / payloads.length),
  };
}

/**
 * The tier's memory footprint at a stated entry count, measured rather than modelled.
 *
 * @param {number} entries
 * @returns {object}
 */
function measureMemory(entries) {
  if (global.gc) global.gc();
  const before = process.memoryUsage().heapUsed;

  const tier = inProcess.createTier({
    maxEntries: entries,
    ttlMs: MEASUREMENT.l1TtlMs,
    namespace: MEASUREMENT.namespace,
    population: inProcess.POPULATION.CHARGER_REACHABILITY,
  });
  for (let index = 0; index < entries; index += 1) {
    tier.set(`engine:charger:reach:cell:${index}:profile:0:7`, JSON.stringify(chargerEntryFor(index)), PINNED_NOW_MS);
  }

  if (global.gc) global.gc();
  const after = process.memoryUsage().heapUsed;
  return {
    entries: tier.size,
    heapDeltaBytes: after - before,
    heapDeltaMiB: (after - before) / BYTES_PER_MIB,
    bytesPerEntry: Math.round((after - before) / Math.max(1, tier.size)),
    gcAvailable: Boolean(global.gc),
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   2 — Redis, reproduced
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * §7.1's loopback `GET` measurement, re-run so this report's Redis figure is its own rather
 * than a quotation.
 *
 * @param {object} redis
 * @returns {Promise<object>}
 */
async function measureRedisGet(redis) {
  const key = "bench:charger:reach:probe";
  await redis.set(key, JSON.stringify(chargerEntryFor(0)));

  const samples = [];
  for (let index = 0; index < MEASUREMENT.redisSamples; index += 1) {
    const started = process.hrtime.bigint();
    // eslint-disable-next-line no-await-in-loop
    await redis.get(key);
    samples.push(Number(process.hrtime.bigint() - started) / NS_PER_US);
  }
  await redis.del(key);
  return distribution(samples);
}

/* ═══════════════════════════════════════════════════════════════════════════
   3 — the §20.1 cache path at 500 × 200 / 25 clusters
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * A routing adapter that routes nothing, at zero latency.
 *
 * It is **not a candidate engine and not B1 evidence.** Its only purpose is to hold engine
 * latency at zero so that what remains in the wall clock is the cache path — the same
 * stand-in discipline §7.1 used, and the reason its 241–246 ms figure is attributable.
 */
const ZERO_LATENCY_STAND_IN = Object.freeze({
  id: "zero-latency-stand-in",
  description: "routes nothing; holds engine latency at zero so the cache path is what is measured",
  async matrix({ destCellIds }) {
    return (destCellIds || []).map((destCellId, index) => ({
      destCellId,
      distanceM: 500 + index,
      travelSeconds: 200 + index,
      travelSdSeconds: 10,
    }));
  },
  async nearestChargers({ k }) {
    const chargers = [];
    for (let index = 0; index < (k || 1); index += 1) {
      chargers.push({ chargerId: `CHG-${index}`, distanceM: 800 + index * 100, travelSeconds: 400 + index * 50 });
    }
    return chargers;
  },
  profile: { energyWhPerMetre: 0.05, speedMetresPerSecond: 5 },
});

/**
 * Resolve the register values the cache path needs. Every threshold is the registered one.
 *
 * @returns {object}
 */
function resolveCacheConfig() {
  const snapshot = service.defaultSnapshot();
  return {
    cellPairTtl: snapshot.resolve("route.cell_pair_cache_ttl"),
    cellPairMinHitRate: snapshot.resolve("route.cell_pair_min_hit_rate"),
    chargerK: snapshot.resolve("route.charger_reachability_k"),
    chargerTtl: snapshot.resolve("route.cell_pair_cache_ttl"),
    intraCellOffsetM: snapshot.resolve("route.intra_cell_offset_m"),
    energyWhPerMetre: ZERO_LATENCY_STAND_IN.profile.energyWhPerMetre,
    speedMetresPerSecond: ZERO_LATENCY_STAND_IN.profile.speedMetresPerSecond,
  };
}

/**
 * Drive `b1Benchmark.measure()` — §20.1's own 500 × 200 / 25-cluster shape, unchanged —
 * against one kv factory, and report the wall clock.
 *
 * The workload loop is the B1 harness's, not a copy: two copies of one access pattern would
 * drift, and the drifted one would be the one quoted.
 *
 * @param {function} kvFactory
 * @param {number} runs measured runs after one discarded warm-up
 * @returns {Promise<object>}
 */
async function measureCachePath(kvFactory, runs) {
  const config = resolveCacheConfig();
  const wallClockMs = [];
  let last = null;
  let lastKv = null;

  // Capture the kv each run builds, so the cross-round tier's operation counts are measured
  // rather than inferred from the wall clock. Which operations remain on the network is the
  // whole question this section is asking.
  const capturing = () => {
    lastKv = kvFactory();
    return lastKv;
  };

  // Warm-up, discarded: the first run pays JIT and allocation costs the steady state does not.
  await b1.measure(ZERO_LATENCY_STAND_IN, config, undefined, { kvFactory: capturing });

  for (let run = 0; run < runs; run += 1) {
    const started = process.hrtime.bigint();
    // eslint-disable-next-line no-await-in-loop
    last = await b1.measure(ZERO_LATENCY_STAND_IN, config, undefined, { kvFactory: capturing });
    wallClockMs.push(Number(process.hrtime.bigint() - started) / NS_PER_MS);
  }

  return {
    runs: wallClockMs,
    min: Math.min(...wallClockMs),
    max: Math.max(...wallClockMs),
    median: percentile(wallClockMs, 0.5),
    amortisation: last ? last.amortisation : null,
    cacheEntries: last ? last.cacheEntries : null,
    chargerCachedP99Us: last ? percentile(last.chargerHitUs, 0.99) : null,
    tierStats: lastKv && typeof lastKv.stats === "function" ? lastKv.stats() : null,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   CLI
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * @param {number|null} value
 * @param {number} places
 * @returns {string}
 */
function fixed(value, places) {
  return value === null || value === undefined ? "—" : value.toFixed(places);
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
async function main(argv) {
  const args = argv || process.argv.slice(2);
  const asJson = args.includes("--json");
  const noRedis = args.includes("--no-redis");
  const runsIndex = args.indexOf("--runs");
  /** @structural measured runs after the warm-up, when the caller states none */
  const DEFAULT_RUNS = 3;
  const runs = runsIndex >= 0 ? Number(args[runsIndex + 1]) || DEFAULT_RUNS : DEFAULT_RUNS;
  const urlIndex = args.indexOf("--redis");
  const redisUrl = urlIndex >= 0 ? args[urlIndex + 1] : process.env.BENCH_REDIS_URL || "redis://127.0.0.1:6379";

  const onlyIndex = args.indexOf("--only");
  const only = onlyIndex >= 0 ? String(args[onlyIndex + 1] || "") : null;
  const wantLatency = only === null || only === "latency";
  const wantCachePath = only === null || only === "cache-path";

  const snapshot = service.defaultSnapshot();
  const targets = {
    chargerCachedUs: snapshot.resolve("perf.charger_reachability_cached_p99"),
    roundWallClockMs: snapshot.resolve("perf.round_wall_clock_p99"),
  };

  const report = { provenance: PROVENANCE, measurement: MEASUREMENT, only, targets, redis: null, sections: {} };

  if (wantLatency) {
    report.sections.timerFloor = measureTimerFloor();
    report.sections.tierGet = measureTierGet();
    report.sections.serialisation = measureSerialisation();
    /** @structural the round's distinct return-leg key count, from §20.1's shape */
    const ROUND_WORKING_SET = 2_500;
    report.sections.memory = measureMemory(ROUND_WORKING_SET);

    report.sections.chargerCachedRow = {
      memory: await measureChargerCachedRow(memoryKv(), MEASUREMENT.latencySamples / 10),
      memoryLayered: await measureChargerCachedRow(layered(memoryKv(), inProcess.POPULATION.CHARGER_REACHABILITY), MEASUREMENT.latencySamples / 10),
      // What the same row costs if the entry never has to be parsed. Not the shipped
      // contract and not proposed here as one — `chargerReachabilityCache.read()` already
      // accepts a non-string (`typeof raw === "string" ? JSON.parse(raw) : raw`) but
      // `cellPairCache.read()` parses unconditionally, so a tier that returned objects would
      // turn every cell-pair hit into a silent miss. This row exists to price the Phase 8
      // decision, because §20.1's 10 µs budget is smaller than one JSON.parse of an entry.
      memoryLayeredParsed: await measureChargerCachedRow(
        parsedValueKv(layered(memoryKv(), inProcess.POPULATION.CHARGER_REACHABILITY)),
        MEASUREMENT.latencySamples / 10,
      ),
    };
    report.sections.synchronousPreParsed = measureSynchronousPreParsedRow();
  }

  let redis = null;
  if (!noRedis) {
    try {
      const Redis = require("ioredis");
      redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null });
      await redis.connect();
      await redis.ping();
      report.redis = { url: redisUrl.replace(/:\/\/.*@/, "://***@"), reachable: true };
    } catch (error) {
      report.redis = { url: redisUrl.replace(/:\/\/.*@/, "://***@"), reachable: false, error: error.message };
      redis = null;
    }
  } else {
    report.redis = { reachable: false, error: "--no-redis" };
  }

  if (redis && wantLatency) {
    report.sections.redisGet = await measureRedisGet(redis);
    await redis.flushdb();
    report.sections.chargerCachedRow.redis = await measureChargerCachedRow(redisKv(redis), MEASUREMENT.redisSamples);
    await redis.flushdb();
    report.sections.chargerCachedRow.redisLayered = await measureChargerCachedRow(
      layered(redisKv(redis), inProcess.POPULATION.CHARGER_REACHABILITY),
      MEASUREMENT.latencySamples / 10,
    );
    await redis.flushdb();
  }

  if (wantCachePath) {
    report.sections.cachePath = {
      memory: await measureCachePath(() => memoryKv(), runs),
      memoryLayered: await measureCachePath(() => layered(memoryKv(), inProcess.POPULATION.CELL_PAIR), runs),
    };

    if (redis) {
      await redis.flushdb();
      report.sections.cachePath.redis = await measureCachePath(() => redisKv(redis), runs);
      await redis.flushdb();
      report.sections.cachePath.redisLayered = await measureCachePath(
        () => layered(redisKv(redis), inProcess.POPULATION.CELL_PAIR),
        runs,
      );
      await redis.flushdb();
    }
  }

  if (redis) redis.disconnect();

  if (asJson) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }

  const line = [];
  line.push("");
  line.push("IN-PROCESS ROUTING CACHE TIER — DIAGNOSTIC MEASUREMENT");
  line.push("");
  line.push(`  ${PROVENANCE}`);
  line.push("");
  line.push(`  §20.1 charger_reachability_cached target : < ${targets.chargerCachedUs} µs p99`);
  line.push(`  §20.1 round wall clock target           : < ${targets.roundWallClockMs} ms p99 (WHOLE round)`);
  line.push("");

  if (report.sections.tierGet) {
    const floor = report.sections.timerFloor;
    line.push("  0. THE INSTRUMENT'S OWN FLOOR — hrtime around an operation that does nothing");
    line.push(`     n=${floor.n}  p50 ${fixed(floor.p50, 3)} µs  p99 ${fixed(floor.p99, 3)} µs`);
    line.push("     Read rows 1 and 2 against this: an operation near the floor is substantially a");
    line.push("     measurement of the clock, which is why the amortised figure is given beside it.");
    line.push("");

    const tierGet = report.sections.tierGet.distribution;
    const tierAmortised = report.sections.tierGet.amortised;
    line.push("  1. THE TIER'S OWN get(), nothing else in the timer");
    line.push(`     n=${tierGet.n}  p50 ${fixed(tierGet.p50, 3)} µs  p95 ${fixed(tierGet.p95, 3)} µs  ` +
      `p99 ${fixed(tierGet.p99, 3)} µs  p99.9 ${fixed(tierGet.p999, 3)} µs  max ${fixed(tierGet.max, 3)} µs`);
    line.push(`     amortised over batches of ${tierAmortised.batch}: ${fixed(tierAmortised.meanUsPerCall, 4)} µs/call`);
    line.push("");

    const parse = report.sections.serialisation.parse;
    const parseAmortised = report.sections.serialisation.parseAmortised;
    line.push("  2. SERIALISATION — what every hit pays on top, because the tier stores bytes");
    line.push(`     JSON.parse of a ${report.sections.serialisation.meanEntryBytes}-byte k=5 entry: ` +
      `p50 ${fixed(parse.p50, 3)} µs  p99 ${fixed(parse.p99, 3)} µs`);
    line.push(`     amortised over batches of ${parseAmortised.batch}: ${fixed(parseAmortised.meanUsPerCall, 4)} µs/call`);
    line.push("");

    const memory = report.sections.memory;
    line.push("  3. MEMORY at the round's return-leg working set");
    line.push(`     ${memory.entries} entries  ${fixed(memory.heapDeltaMiB, 2)} MiB  ` +
      `${memory.bytesPerEntry} B/entry${memory.gcAvailable ? "" : "  (no --expose-gc; delta is indicative)"}`);
    line.push("");

    line.push("  4. §20.1 charger_reachability_cached — chargerReachabilityCache.read() end to end");
    const rowOrder = [
      ["A  memory                ", report.sections.chargerCachedRow.memory],
      ["B  memory + L1           ", report.sections.chargerCachedRow.memoryLayered],
      ["C  redis  (SHIPPED)      ", report.sections.chargerCachedRow.redis],
      ["D  redis + L1            ", report.sections.chargerCachedRow.redisLayered],
      ["E  memory + L1, no parse ", report.sections.chargerCachedRow.memoryLayeredParsed],
    ];
    for (const [label, section] of rowOrder) {
      if (!section) {
        line.push(`     ${label} NOT MEASURED — Redis unreachable`);
        continue;
      }
      const d = section.distribution;
      const verdict = d.p99 === null ? "—" : d.p99 < targets.chargerCachedUs ? "within target" : "OVER TARGET";
      line.push(`     ${label} p50 ${fixed(d.p50, 2)}  p95 ${fixed(d.p95, 2)}  p99 ${fixed(d.p99, 2)}  ` +
        `p99.9 ${fixed(d.p999, 2)} µs   ${verdict}`);
    }
    if (report.sections.redisGet) {
      const g = report.sections.redisGet;
      line.push(`     raw Redis GET, n=${g.n}: p50 ${fixed(g.p50, 1)} µs  p99 ${fixed(g.p99, 1)} µs`);
    }
    const sync = report.sections.synchronousPreParsed;
    const syncVerdict = sync.distribution.p99 < targets.chargerCachedUs ? "WITHIN TARGET" : "OVER TARGET";
    line.push(`     F  sync, pre-parsed      p50 ${fixed(sync.distribution.p50, 2)}  p95 ${fixed(sync.distribution.p95, 2)}  ` +
      `p99 ${fixed(sync.distribution.p99, 2)}  p99.9 ${fixed(sync.distribution.p999, 2)} µs   ${syncVerdict}`);
    line.push(`                              amortised ${fixed(sync.amortised.meanUsPerCall, 4)} µs/call`);
    line.push("");
    line.push("     E and F are NOT the shipped contract. E is confounded — it removes a JSON.parse");
    line.push("     but adds an async hop, so it isolates neither. F is the clean question: what the");
    line.push("     row costs with no promise and no parse in it, i.e. whether 10 µs is reachable at");
    line.push("     all in process. That is a Phase 8 decision about the cache modules' contract.");
    line.push("");
  }

  if (report.sections.cachePath) {
    line.push("  5. CACHE PATH at §20.1's own 500 × 200 / 25-cluster shape, zero-latency engine");
    const pathOrder = [
      ["A  memory            ", report.sections.cachePath.memory],
      ["B  memory + L1       ", report.sections.cachePath.memoryLayered],
      ["C  redis  (SHIPPED)  ", report.sections.cachePath.redis],
      ["D  redis + L1        ", report.sections.cachePath.redisLayered],
    ];
    for (const [label, section] of pathOrder) {
      if (!section) {
        line.push(`     ${label} NOT MEASURED — Redis unreachable`);
        continue;
      }
      line.push(`     ${label} ${section.runs.map((value) => `${value.toFixed(1)}`).join(", ")} ms   ` +
        `median ${fixed(section.median, 1)} ms`);
      if (section.tierStats) {
        const l1 = section.tierStats.l1;
        const l2 = section.tierStats.l2;
        line.push(`        L1 reads ${l1.reads} hits ${l1.hits} (${fixed(l1.hitRate === null ? null : l1.hitRate * 100, 1)}%) ` +
          `size ${l1.size} evictions ${l1.evictions}  ·  L2 reads ${l2.l2Reads} writes ${l2.l2Writes} coalesced ${l2.coalesced}`);
      }
    }
    const amortisation = report.sections.cachePath.memory && report.sections.cachePath.memory.amortisation;
    if (amortisation) {
      line.push(`     amortisation — approach: ${amortisation.approach.engineQueries} engine queries → ` +
        `${amortisation.approach.cacheReads} cache reads;  return leg: ${amortisation.returnLeg.engineQueries} → ` +
        `${amortisation.returnLeg.cacheReads}`);
    }
    line.push("");
  }
  line.push("  This tool measures the lookup tier. It measures no routing engine, selects none,");
  line.push("  and closes no release gate. B1 remains open.");
  line.push("");

  // eslint-disable-next-line no-console
  console.log(line.join("\n"));
  return 0;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      // eslint-disable-next-line no-console
      console.error(error);
      process.exit(1);
    });
}

module.exports = { MEASUREMENT, PROVENANCE, ZERO_LATENCY_STAND_IN, percentile, distribution, measureCachePath, main };
