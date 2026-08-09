"use strict";

/**
 * Service-level indicators and the §20.1 performance targets — **Tier 1**.
 *
 * > Targets are stated per shard, at the 99th percentile, under nominal (non-degraded)
 * > operation. **They are requirements for the release gate, not aspirations.**
 *
 * ── Two targets are stated at p99.9, and the reason is structural ───────────
 * > **Where a tail bounds a safety window, a p99.9 target is stated as well as a p99.**
 * > … the commit transaction's tail bounds the leadership-fence vulnerability window
 * > (§10.3.2, guard G1), and dispatch's tail bounds how long a commitment can exist
 * > without the agent knowing about it. … a p99 target on a quantity that bounds a
 * > safety window would be a category error, since the transaction that outlives its
 * > leadership window is by construction not a typical one.
 *
 * `TARGETS` therefore carries a `boundsSafetyWindow` flag and the window each of the
 * two bounds, so a dashboard cannot render them as two more latency numbers and an
 * alert policy cannot quietly downgrade either to a p99.
 *
 * ── Where the numbers live ──────────────────────────────────────────────────
 * Every target value is a `perf.*` register entry, resolved through the Config Service,
 * never written here. §20.1 calls its table "requirements for the release gate", and a
 * release-gate threshold is a threshold — §22.1 rule 1 admits no exception for the ones
 * that only decide whether a build ships.
 *
 * ── The store: in-process exact, cross-process advisory ─────────────────────
 * Counters, gauges and histograms are held in process memory and published to
 * `engine:sli:{shard}:{instance}` as a snapshot with a TTL. §3.3's cache-authority rule
 * applies in full and costs nothing here: an SLI is a monitoring quantity, its loss
 * degrades visibility and nothing else, and no engine decision reads one back.
 *
 * The two exceptions that must never be served from this store are stated so that a
 * future change cannot make them quietly:
 *
 *   - §7.7's binding-constraint distribution and near-miss margins are **exact over
 *     100 % of decisions** and are folded into `RejectionAggregate` at decision time.
 *     They are not sampled and not derived from a cache blob.
 *   - The invariant-violation count (§26) is produced by the Invariant Checker, which
 *     "runs independently of the code paths that maintain them". A checker reading a
 *     counter written by the enforcer would verify nothing.
 */

const { canonicalJson, compareStrings } = require("../determinism/ordering");

/** The Redis namespace §21.2 reserves for SLIs. @structural the key scheme */
const KEY = Object.freeze({
  snapshot: (shardId, instanceId) => `engine:sli:${shardId}:${instanceId}`,
  instances: (shardId) => `engine:sli:instances:${shardId}`,
});

/** How a target is stated. */
const STATISTIC = Object.freeze({
  P99: "p99",
  P999: "p99.9",
  MEAN: "mean",
  RATIO: "ratio",
  MAX: "max",
});

/**
 * §20.1's table, row for row. Each row names the register entry holding its value, so
 * the target and the number are one thing rather than two that can drift.
 *
 * `boundsSafetyWindow` marks the two rows §20.1 singles out. Nothing else in this table
 * carries it, and a future addition that sets it without naming the window it bounds is
 * refused by `assertTargets()`.
 */
const TARGETS = Object.freeze([
  { id: "intake_ack", parameter: "perf.intake_ack_p99", statistic: STATISTIC.P99, unit: "ms",
    rationale: "Synchronous customer path", boundsSafetyWindow: false, window: null },
  { id: "round_wall_clock", parameter: "perf.round_wall_clock_p99", statistic: STATISTIC.P99, unit: "ms",
    rationale: "Keeps the batch window meaningful (500 Legs x 200 candidates)", boundsSafetyWindow: false, window: null },
  { id: "candidate_generation_per_leg", parameter: "perf.candidate_generation_per_leg_p99", statistic: STATISTIC.P99, unit: "ms",
    rationale: "Index lookup plus ring expansion", boundsSafetyWindow: false, window: null },
  { id: "feasibility_per_candidate_cached", parameter: "perf.feasibility_per_candidate_cached_p99", statistic: STATISTIC.P99, unit: "µs",
    rationale: "100 000 evaluations per round must be affordable", boundsSafetyWindow: false, window: null },
  { id: "cost_per_candidate", parameter: "perf.cost_per_candidate_p99", statistic: STATISTIC.P99, unit: "µs",
    rationale: "Routing cached", boundsSafetyWindow: false, window: null },
  { id: "approach_routing_matrix", parameter: "perf.approach_routing_matrix_p99", statistic: STATISTIC.P99, unit: "ms",
    rationale: "Origin-anchored, 200x1, cached; cell-pair cache hit rate > 95 % (§20.3 item 2)", boundsSafetyWindow: false, window: null },
  { id: "charger_reachability_cached", parameter: "perf.charger_reachability_cached_p99", statistic: STATISTIC.P99, unit: "µs",
    rationale: "The second per-candidate routing population, required by E_return (§14.5)", boundsSafetyWindow: false, window: null },
  { id: "charger_reachability_miss", parameter: "perf.charger_reachability_miss_p99", statistic: STATISTIC.P99, unit: "ms",
    rationale: "Charger-reachability cache miss (§20.3 item 3)", boundsSafetyWindow: false, window: null },
  { id: "commit_transaction_p99", parameter: "perf.commit_transaction_p99", statistic: STATISTIC.P99, unit: "ms",
    rationale: "The serial section", boundsSafetyWindow: false, window: null },
  { id: "commit_transaction_p999", parameter: "perf.commit_transaction_p999", statistic: STATISTIC.P999, unit: "ms",
    rationale: "The vulnerable transaction is by definition an unusually slow one and a p99 says nothing about it",
    boundsSafetyWindow: true, window: "the leadership-fence exposure window of §10.3.2 guard G1" },
  { id: "commit_transaction_mean", parameter: "perf.commit_transaction_mean", statistic: STATISTIC.MEAN, unit: "ms",
    rationale: "The mean, not the p99, is what the shard-sizing bound of §3.5 consumes", boundsSafetyWindow: false, window: null },
  { id: "serial_section_utilisation", parameter: "commit.max_serial_utilisation", statistic: STATISTIC.RATIO, unit: "ratio",
    rationale: "Derived, monitored, and the binding shard-size constraint whenever mission rate is high (§3.5)",
    boundsSafetyWindow: false, window: null },
  { id: "decision_to_dispatch_p99", parameter: "perf.decision_to_dispatch_p99", statistic: STATISTIC.P99, unit: "ms",
    rationale: "Decision to dispatch", boundsSafetyWindow: false, window: null },
  { id: "decision_to_dispatch_p999", parameter: "perf.decision_to_dispatch_p999", statistic: STATISTIC.P999, unit: "ms",
    rationale: "A commitment that exists without the agent having been told is unsupervised work in the world",
    boundsSafetyWindow: true, window: "how long a HARD commitment can exist without the agent knowing about it (§11.1)" },
  { id: "intake_to_offer", parameter: "perf.intake_to_offer_p99", statistic: STATISTIC.P99, unit: "ms",
    rationale: "Customer-visible responsiveness, nominal", boundsSafetyWindow: false, window: null },
  { id: "agent_loss_detection", parameter: "perf.agent_loss_detection_p99", statistic: STATISTIC.P99, unit: "ms",
    rationale: "Heartbeat interval plus margin", boundsSafetyWindow: false, window: null },
  { id: "lease_expiry_to_recovery", parameter: "perf.lease_expiry_to_recovery_p99", statistic: STATISTIC.P99, unit: "ms",
    rationale: "Lease expiry to recovery start", boundsSafetyWindow: false, window: null },
  { id: "reconciler_full_sweep", parameter: "perf.reconciler_full_sweep_p99", statistic: STATISTIC.P99, unit: "ms",
    rationale: "Bounds worst-case divergence duration", boundsSafetyWindow: false, window: null },
  { id: "tier_a_record_bytes", parameter: "perf.tier_a_record_bytes", statistic: STATISTIC.MAX, unit: "bytes",
    rationale: "The compact record; sized in §21.2 and always retained", boundsSafetyWindow: false, window: null },
  { id: "tier_b_write_rate", parameter: "observability.tier_b_write_budget", statistic: STATISTIC.MAX, unit: "records·min⁻¹",
    rationale: "Full-fidelity detail is sampled and budgeted, never unbounded (§21.2)", boundsSafetyWindow: false, window: null },
]);

const TARGET_BY_ID = Object.freeze(TARGETS.reduce((index, row) => Object.assign(index, { [row.id]: row }), Object.create(null)));

/**
 * Subdivisions per octave in the latency histogram's bucket ladder. Eight gives a
 * relative bucket width of `2^(1/8) − 1 ≈ 9 %`, which is finer than any §20.1 target's
 * own margin and keeps a p99.9 read meaningful without unbounded memory.
 * @structural the histogram's resolution; a bucket-ladder choice, not a threshold
 */
const HISTOGRAM_SUBDIVISIONS = 8;

/**
 * The exponent of the smallest resolvable observation, so bucket 0 holds everything
 * below `2^-10` in the metric's own unit.
 * @structural the histogram's low-magnitude floor exponent
 */
const HISTOGRAM_MIN_EXPONENT = -10;

/**
 * The number of buckets above the floor. Fifty octaves at eight subdivisions spans
 * `2^-10` to `2^40` in the metric's own unit, which covers microseconds to hours.
 * @structural the histogram's ladder width
 */
const HISTOGRAM_OCTAVES = 50;

/**
 * Place an observation in the ladder.
 *
 * @param {number} value
 * @returns {number}
 */
function bucketOf(value) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const exponent = Math.log2(value);
  const index = Math.floor((exponent - HISTOGRAM_MIN_EXPONENT) * HISTOGRAM_SUBDIVISIONS);
  const max = HISTOGRAM_OCTAVES * HISTOGRAM_SUBDIVISIONS;
  return Math.max(0, Math.min(index, max));
}

/**
 * The lower edge of a bucket, in the metric's own unit. A quantile read off a bucketed
 * histogram is a **bound**, and returning the lower edge keeps it an honest one: the
 * true quantile is at least this.
 *
 * @param {number} bucket
 * @returns {number}
 */
function bucketFloor(bucket) {
  // @structural the ladder's base; the buckets are powers of two by construction
  const LADDER_BASE = 2;
  return Math.pow(LADDER_BASE, HISTOGRAM_MIN_EXPONENT + bucket / HISTOGRAM_SUBDIVISIONS);
}

/**
 * Create an SLI registry for one process.
 *
 * @returns {object}
 */
function createRegistry() {
  const counters = new Map();
  const gauges = new Map();
  /** name → { count, sum, min, max, buckets: Map<bucket, count> } */
  const histograms = new Map();

  const seriesKey = (name, labels) => (labels && Object.keys(labels).length > 0 ? `${name}|${canonicalJson(labels)}` : name);

  /**
   * Increment a counter.
   *
   * @param {string} name
   * @param {number} [by]
   * @param {object} [labels]
   */
  function count(name, by, labels) {
    const key = seriesKey(name, labels);
    const delta = Number.isFinite(by) ? by : 1;
    counters.set(key, (counters.get(key) || 0) + delta);
  }

  /**
   * Set a gauge.
   *
   * @param {string} name
   * @param {number} value
   * @param {object} [labels]
   */
  function gauge(name, value, labels) {
    if (!Number.isFinite(value)) return;
    gauges.set(seriesKey(name, labels), value);
  }

  /**
   * Record a latency or size observation.
   *
   * @param {string} name
   * @param {number} value
   * @param {object} [labels]
   */
  function observe(name, value, labels) {
    if (!Number.isFinite(value)) return;
    const key = seriesKey(name, labels);
    let histogram = histograms.get(key);
    if (!histogram) {
      histogram = { count: 0, sum: 0, min: value, max: value, buckets: new Map() };
      histograms.set(key, histogram);
    }
    histogram.count += 1;
    histogram.sum += value;
    histogram.min = Math.min(histogram.min, value);
    histogram.max = Math.max(histogram.max, value);
    const bucket = bucketOf(value);
    histogram.buckets.set(bucket, (histogram.buckets.get(bucket) || 0) + 1);
  }

  /**
   * Read a quantile as a lower bound.
   *
   * @param {string} name
   * @param {number} q in `[0, 1]`
   * @param {object} [labels]
   * @returns {{ atLeast: number, count: number }|null}
   */
  function quantile(name, q, labels) {
    const histogram = histograms.get(seriesKey(name, labels));
    if (!histogram || histogram.count === 0) return null;
    const ordered = [...histogram.buckets.entries()].sort((a, b) => a[0] - b[0]);
    const target = q * histogram.count;
    let cumulative = 0;
    for (const [bucket, bucketCount] of ordered) {
      cumulative += bucketCount;
      if (cumulative >= target) return { atLeast: bucketFloor(bucket), count: histogram.count };
    }
    return { atLeast: bucketFloor(ordered[ordered.length - 1][0]), count: histogram.count };
  }

  /**
   * The mean of a histogram.
   *
   * @param {string} name
   * @param {object} [labels]
   * @returns {number|null}
   */
  function mean(name, labels) {
    const histogram = histograms.get(seriesKey(name, labels));
    if (!histogram || histogram.count === 0) return null;
    return histogram.sum / histogram.count;
  }

  /**
   * The full snapshot, sorted so two processes' snapshots merge deterministically.
   *
   * @returns {object}
   */
  function snapshot() {
    return {
      counters: Object.fromEntries([...counters.entries()].sort((a, b) => compareStrings(a[0], b[0]))),
      gauges: Object.fromEntries([...gauges.entries()].sort((a, b) => compareStrings(a[0], b[0]))),
      histograms: Object.fromEntries(
        [...histograms.entries()]
          .sort((a, b) => compareStrings(a[0], b[0]))
          .map(([key, histogram]) => [
            key,
            {
              count: histogram.count,
              sum: histogram.sum,
              min: histogram.min,
              max: histogram.max,
              buckets: Object.fromEntries([...histogram.buckets.entries()].sort((a, b) => a[0] - b[0])),
            },
          ]),
      ),
    };
  }

  function reset() {
    counters.clear();
    gauges.clear();
    histograms.clear();
  }

  return { count, gauge, observe, quantile, mean, snapshot, reset, seriesKey };
}

/**
 * Merge snapshots from several processes into one shard-level view.
 *
 * Counters and histogram buckets add; gauges take the most recent writer's value, which
 * for a per-shard quantity written by the one leader is the only value.
 *
 * @param {object[]} snapshots
 * @returns {object}
 */
function merge(snapshots) {
  const counters = new Map();
  const gauges = new Map();
  const histograms = new Map();

  for (const snapshot of snapshots || []) {
    if (!snapshot || typeof snapshot !== "object") continue;
    for (const [key, value] of Object.entries(snapshot.counters || {})) {
      counters.set(key, (counters.get(key) || 0) + Number(value || 0));
    }
    for (const [key, value] of Object.entries(snapshot.gauges || {})) gauges.set(key, Number(value));
    for (const [key, histogram] of Object.entries(snapshot.histograms || {})) {
      let merged = histograms.get(key);
      if (!merged) {
        merged = { count: 0, sum: 0, min: null, max: null, buckets: new Map() };
        histograms.set(key, merged);
      }
      merged.count += Number(histogram.count || 0);
      merged.sum += Number(histogram.sum || 0);
      merged.min = merged.min === null ? histogram.min : Math.min(merged.min, histogram.min);
      merged.max = merged.max === null ? histogram.max : Math.max(merged.max, histogram.max);
      for (const [bucket, bucketCount] of Object.entries(histogram.buckets || {})) {
        const index = Number(bucket);
        merged.buckets.set(index, (merged.buckets.get(index) || 0) + Number(bucketCount || 0));
      }
    }
  }

  return {
    counters: Object.fromEntries([...counters.entries()].sort((a, b) => compareStrings(a[0], b[0]))),
    gauges: Object.fromEntries([...gauges.entries()].sort((a, b) => compareStrings(a[0], b[0]))),
    histograms: Object.fromEntries(
      [...histograms.entries()]
        .sort((a, b) => compareStrings(a[0], b[0]))
        .map(([key, histogram]) => [
          key,
          { ...histogram, buckets: Object.fromEntries([...histogram.buckets.entries()].sort((a, b) => a[0] - b[0])) },
        ]),
    ),
  };
}

/**
 * Read a statistic out of a merged snapshot.
 *
 * @param {object} merged
 * @param {string} seriesName
 * @param {string} statistic one of `STATISTIC`
 * @returns {{ value: number|null, count: number, bound: boolean }}
 */
function statisticOf(merged, seriesName, statistic) {
  const histogram = (merged.histograms || {})[seriesName];
  if (!histogram || !histogram.count) {
    const gaugeValue = (merged.gauges || {})[seriesName];
    return { value: Number.isFinite(gaugeValue) ? gaugeValue : null, count: 0, bound: false };
  }

  if (statistic === STATISTIC.MEAN) return { value: histogram.sum / histogram.count, count: histogram.count, bound: false };
  if (statistic === STATISTIC.MAX) return { value: histogram.max, count: histogram.count, bound: false };

  // The two percentiles §20.1 states. They are the *definitions* of "p99" and "p99.9",
  // not tuning knobs: a configurable p99 would be a p-something, and the two targets
  // §20.1 states at p99.9 are stated there because a percentile is what bounds a safety
  // window. @structural the definitions of the two named percentiles
  const P99 = 0.99;
  // @structural the definition of the p99.9 percentile
  const P999 = 0.999;
  const q = statistic === STATISTIC.P999 ? P999 : P99;
  const ordered = Object.entries(histogram.buckets).map(([bucket, count]) => [Number(bucket), Number(count)]).sort((a, b) => a[0] - b[0]);
  const target = q * histogram.count;
  let cumulative = 0;
  for (const [bucket, count] of ordered) {
    cumulative += count;
    // A bucketed quantile is a bound, never a value; `bound: true` says so to the
    // caller rather than letting a dashboard present the lower edge as a measurement.
    if (cumulative >= target) return { value: bucketFloor(bucket), count: histogram.count, bound: true };
  }
  return { value: histogram.max, count: histogram.count, bound: true };
}

/**
 * Evaluate every §20.1 target against a merged snapshot.
 *
 * @param {object} input
 * @param {object} input.merged
 * @param {{ get: (name: string) => * }} input.config resolved parameters
 * @param {Record<string, string>} [input.seriesFor] target id → series name override
 * @returns {object[]}
 */
function attainment(input) {
  const source = input || {};
  const merged = source.merged || {};
  const seriesFor = source.seriesFor || {};

  return TARGETS.map((target) => {
    const series = seriesFor[target.id] || `sli.${target.id}`;
    const observed = statisticOf(merged, series, target.statistic);
    const targetValue = source.config && typeof source.config.get === "function" ? source.config.get(target.parameter) : null;

    return {
      id: target.id,
      parameter: target.parameter,
      statistic: target.statistic,
      unit: target.unit,
      rationale: target.rationale,
      boundsSafetyWindow: target.boundsSafetyWindow,
      window: target.window,
      target: Number.isFinite(targetValue) ? targetValue : null,
      observed: observed.value,
      observedIsLowerBound: observed.bound,
      sampleCount: observed.count,
      // `null` where nothing has been observed yet: an unmeasured target is not a met
      // one, and reporting it as attained is how a release gate becomes a formality.
      meets: observed.value === null || !Number.isFinite(targetValue) ? null : observed.value <= targetValue,
    };
  });
}

/**
 * Publish this process's snapshot to the advisory `engine:sli:*` namespace.
 *
 * Best-effort in full: a failure is a loss of visibility, never of correctness, and the
 * caller is never told to retry.
 *
 * @param {object} deps `{ kv }`
 * @param {object} input `{ shardId, instanceId, registry, ttlSeconds }`
 * @returns {Promise<boolean>} whether the publish landed
 */
async function publish(deps, input) {
  const source = input || {};
  if (!deps || !deps.kv) return false;
  try {
    await deps.kv.set(KEY.snapshot(source.shardId, source.instanceId), JSON.stringify(source.registry.snapshot()), {
      ex: source.ttlSeconds,
    });
    await deps.kv.sadd(KEY.instances(source.shardId), String(source.instanceId));
    return true;
  } catch {
    return false;
  }
}

/**
 * Collect and merge every process's snapshot for one shard.
 *
 * @param {object} deps `{ kv }`
 * @param {string} shardId
 * @returns {Promise<{ merged: object, instances: string[] }>}
 */
async function collect(deps, shardId) {
  if (!deps || !deps.kv) return { merged: merge([]), instances: [] };
  try {
    const instances = (await deps.kv.smembers(KEY.instances(shardId))) || [];
    const ordered = [...instances].map(String).sort(compareStrings);
    if (ordered.length === 0) return { merged: merge([]), instances: [] };
    const raw = await deps.kv.mget(ordered.map((instanceId) => KEY.snapshot(shardId, instanceId)));
    const parsed = (raw || []).map((value) => {
      try {
        return value ? JSON.parse(value) : null;
      } catch {
        return null;
      }
    });
    return { merged: merge(parsed.filter(Boolean)), instances: ordered };
  } catch {
    return { merged: merge([]), instances: [] };
  }
}

/**
 * Refuse a malformed target table: a row that claims to bound a safety window must name
 * the window, and every row must name a register entry.
 *
 * @returns {{ ok: boolean, problems: string[] }}
 */
function assertTargets() {
  const problems = [];
  for (const target of TARGETS) {
    if (!target.parameter) problems.push(`${target.id}: names no register entry (§22.1 rule 1)`);
    if (target.boundsSafetyWindow === true && !target.window) {
      problems.push(
        `${target.id}: claims to bound a safety window but does not name it. §20.1 states both such targets ` +
          "and what each bounds; an unnamed window is a p99.9 nobody can justify keeping.",
      );
    }
    if (target.boundsSafetyWindow === true && target.statistic !== STATISTIC.P999) {
      problems.push(
        `${target.id}: bounds a safety window but is stated at ${target.statistic}. §20.1: "a p99 target on a ` +
          'quantity that bounds a safety window would be a category error".',
      );
    }
  }
  return { ok: problems.length === 0, problems };
}

module.exports = {
  KEY,
  STATISTIC,
  TARGETS,
  TARGET_BY_ID,
  HISTOGRAM_SUBDIVISIONS,
  HISTOGRAM_MIN_EXPONENT,
  HISTOGRAM_OCTAVES,
  bucketOf,
  bucketFloor,
  createRegistry,
  merge,
  statisticOf,
  attainment,
  publish,
  collect,
  assertTargets,
};
