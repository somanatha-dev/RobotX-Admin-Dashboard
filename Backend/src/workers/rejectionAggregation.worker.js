"use strict";

/**
 * The rejection-aggregation flusher (§7.7).
 *
 * The plan names it in one line — *"Aggregation flusher (folds in-memory histograms to
 * `RejectionAggregate`)"* — and the whole of its design follows from where §7.7 puts
 * the aggregation:
 *
 * > **Aggregation happens at decision time; only the per-candidate rows are sampled.**
 * > The tuples are folded into the shard's rejection histograms *before* the decision
 * > record is written, so the two derived SLIs are exact over **100 % of decisions**
 * > even though the individual rows land in the sampled Tier B (§21.2).
 *
 * The fold is therefore already done by the time this worker runs. Its job is only to
 * move counts that are exact-but-volatile (an in-memory `Map` on one shard process)
 * into storage that is exact-and-durable, without putting a write on the round's
 * critical path. That is why it is a periodic flusher rather than a per-decision
 * writer: a synchronous insert per rejection would make write volume proportional to
 * `candidates x predicates`, which is the volume §21.2 exists to bound.
 *
 * ── Idempotence, and why it is not optional ────────────────────────────────
 * The flusher is at-least-once, like every other worker in this codebase: a process
 * that dies between the database write and the in-memory reset will re-flush. Both
 * tables therefore carry a unique key over their dimension tuple plus the bucket, and
 * the flush is an **upsert that adds** rather than an insert.
 *
 * Adding-on-conflict is what makes a retry safe, but it is also what makes a *double*
 * flush dangerous — so `drain()` hands the counts over and clears in one call, and this
 * worker never reads the aggregator twice for one flush. An inflated SLI would be worse
 * than a missing one: the whole argument for aggregating before sampling is that these
 * numbers can be trusted exactly.
 *
 * ── Bucketing ──────────────────────────────────────────────────────────────
 * Counts land in a half-open `[bucketStart, bucketEnd)` window so the table grows with
 * `dimensions x time` rather than with decision volume, and so a capacity-planning
 * query can ask "what bound this zone last Tuesday" without scanning every flush.
 *
 * ── Built, tested, and not started ─────────────────────────────────────────
 * Nothing in `server.js` calls `start()`. Phase 15 owns production scheduling, which is
 * the same disposition Phases 4 and 5 gave the outbox, timer, and reconciler workers.
 *
 * Tier 1 by path (`src/workers/` default). Its inputs are Tier 0's.
 */

const { getPrisma } = require("../db/prisma");

/**
 * The flush interval. Rejection aggregates are a capacity-planning instrument read by
 * a human against a dashboard, not a control loop, so seconds of staleness cost
 * nothing and a longer interval buys a larger, cheaper upsert batch.
 * @structural the flusher's cadence; a batching choice, not a behavioural threshold
 */
const FLUSH_INTERVAL_MS = 30_000;

/**
 * The aggregation bucket width. Five minutes is fine enough to locate a capacity
 * problem within an operating hour and coarse enough that a shard produces a bounded
 * number of rows per day per dimension tuple.
 * @structural the aggregate table's time-bucket width
 */
const BUCKET_WIDTH_MS = 300_000;

/**
 * Floor a timestamp onto the bucket ladder.
 *
 * @param {number} atMs
 * @returns {{ bucketStart: Date, bucketEnd: Date }}
 */
function bucketFor(atMs) {
  const start = Math.floor(atMs / BUCKET_WIDTH_MS) * BUCKET_WIDTH_MS;
  return { bucketStart: new Date(start), bucketEnd: new Date(start + BUCKET_WIDTH_MS) };
}

/**
 * Fold one drained snapshot into the two tables.
 *
 * @param {object} deps `{ prisma }`
 * @param {{ distribution: object[], sketches: object[] }} snapshot from
 *   `rejectionTelemetry.createAggregator().drain()`
 * @param {{ atMs: number, shardId: string|null }} context
 * @returns {Promise<{ aggregatesWritten: number, sketchesWritten: number }>}
 */
async function flushSnapshot(deps, snapshot, context) {
  const prisma = (deps && deps.prisma) || getPrisma();
  const { bucketStart, bucketEnd } = bucketFor(context.atMs);
  const shardId = context.shardId === undefined ? null : context.shardId;

  let aggregatesWritten = 0;
  let sketchesWritten = 0;

  for (const row of snapshot.distribution || []) {
    // Upsert-and-add. A retry after a partial flush adds the same counts again only if
    // the aggregator was not drained, which `drain()` makes impossible for one flush.
    await prisma.rejectionAggregate.upsert({
      where: {
        shardId_zoneId_missionClass_legPurpose_predicateId_tier_bucketStart: {
          shardId: row.shardId === undefined ? shardId : row.shardId,
          zoneId: row.zoneId,
          missionClass: row.missionClass,
          legPurpose: row.legPurpose,
          predicateId: row.predicateId,
          tier: row.tier,
          bucketStart,
        },
      },
      create: {
        shardId: row.shardId === undefined ? shardId : row.shardId,
        zoneId: row.zoneId,
        missionClass: row.missionClass,
        legPurpose: row.legPurpose,
        predicateId: row.predicateId,
        tier: row.tier,
        bucketStart,
        bucketEnd,
        count: BigInt(row.count),
      },
      update: { count: { increment: BigInt(row.count) }, bucketEnd },
    });
    aggregatesWritten += 1;
  }

  for (const sketch of snapshot.sketches || []) {
    const existing = await prisma.nearMissSketch.findUnique({
      where: {
        shardId_predicateId_marginUnit_bucketStart: {
          shardId,
          predicateId: sketch.predicateId,
          marginUnit: sketch.marginUnit,
          bucketStart,
        },
      },
    });

    // Sketch buckets merge by addition, which is what makes the ladder a *streaming*
    // sketch (§7.7) rather than a snapshot: two flushes of the same window compose to
    // the same distribution one flush of the union would have produced.
    const merged = mergeBuckets(existing ? existing.buckets : null, sketch.buckets);

    await prisma.nearMissSketch.upsert({
      where: {
        shardId_predicateId_marginUnit_bucketStart: {
          shardId,
          predicateId: sketch.predicateId,
          marginUnit: sketch.marginUnit,
          bucketStart,
        },
      },
      create: {
        shardId,
        predicateId: sketch.predicateId,
        marginUnit: sketch.marginUnit,
        bucketStart,
        bucketEnd,
        buckets: merged,
        total: BigInt(sketch.total),
      },
      update: { buckets: merged, total: { increment: BigInt(sketch.total) }, bucketEnd },
    });
    sketchesWritten += 1;
  }

  return { aggregatesWritten, sketchesWritten };
}

/**
 * Add two bucket ladders together.
 *
 * @param {object|null} stored `{ [bucket]: count }` as previously written
 * @param {Array<{ bucket: number, count: number }>} incoming
 * @returns {object} the merged ladder
 */
function mergeBuckets(stored, incoming) {
  const merged = {};
  if (stored && typeof stored === "object") {
    for (const [bucket, count] of Object.entries(stored)) {
      const value = Number(count);
      if (Number.isFinite(value)) merged[bucket] = value;
    }
  }
  for (const entry of incoming || []) {
    const key = String(entry.bucket);
    merged[key] = (merged[key] || 0) + entry.count;
  }
  return merged;
}

/**
 * One flush pass: drain the aggregator and fold it.
 *
 * @param {object} deps `{ prisma, aggregator, now }`
 * @param {{ shardId?: string|null }} [context]
 * @returns {Promise<object>}
 */
async function flushOnce(deps, context) {
  if (!deps || !deps.aggregator) {
    throw new Error(
      "the rejection-aggregation flusher requires the shard's aggregator. §7.7 folds tuples at " +
        "decision time; a flusher with nothing to drain would silently report an empty distribution " +
        "while rejections were being discarded.",
    );
  }

  const atMs = typeof deps.now === "function" ? deps.now() : Date.now();
  const snapshot = deps.aggregator.drain();

  if (snapshot.distribution.length === 0 && snapshot.sketches.length === 0) {
    return { aggregatesWritten: 0, sketchesWritten: 0, atMs, empty: true };
  }

  const written = await flushSnapshot(deps, snapshot, {
    atMs,
    shardId: (context && context.shardId) || null,
  });

  return { ...written, atMs, empty: false, sampling: snapshot.sampling };
}

/**
 * Start the periodic flusher.
 *
 * @param {object} deps `{ prisma, aggregator, now, onError }`
 * @param {{ shardId?: string|null, intervalMs?: number }} [context]
 * @returns {{ stop: () => void }}
 */
function start(deps, context) {
  const intervalMs = (context && context.intervalMs) || FLUSH_INTERVAL_MS;

  const handle = setInterval(() => {
    flushOnce(deps, context).catch((error) => {
      // A flush failure loses telemetry, never a decision. It is reported and the next
      // pass retries; the aggregator has already been drained, so the loss is bounded
      // to one window rather than growing.
      if (deps && typeof deps.onError === "function") deps.onError(error);
    });
  }, intervalMs);

  if (typeof handle.unref === "function") handle.unref();

  return {
    stop() {
      clearInterval(handle);
    },
  };
}

module.exports = {
  FLUSH_INTERVAL_MS,
  BUCKET_WIDTH_MS,
  bucketFor,
  mergeBuckets,
  flushSnapshot,
  flushOnce,
  start,
};
