"use strict";

/**
 * Rejection reporting (§7.7) — **Tier 0**.
 *
 * > Every rejection is *evaluated* as the structured tuple `(agent_id, predicate_id,
 * > observed_value, required_value, input_source, observation_age)`. This is stricter
 * > than logging a message string, and it is what makes "why did the fleet reject this
 * > mission" **queryable rather than grep-able**.
 *
 * This module replaces `logger.dtaro`, which emitted a formatted allocation report as
 * a log line. A log line is unqueryable at fleet scale, and the two SLIs below are the
 * reason that matters.
 *
 * ── Aggregate first, sample second. This ordering is the whole design ──────
 * > **Aggregation happens at decision time; only the per-candidate rows are sampled.**
 * > The tuples are folded into the shard's rejection histograms *before* the decision
 * > record is written, so the two derived SLIs below are exact over **100 % of
 * > decisions** even though the individual rows land in the sampled Tier B (§21.2).
 * > Aggregating first and sampling second is what allows full-fidelity capacity
 * > diagnostics and bounded write volume to hold simultaneously; **sampling first
 * > would degrade the histogram to an estimate and destroy exactly the property that
 * > makes it useful for capacity planning**.
 *
 * `record()` folds into the in-memory histograms unconditionally. Sampling is a
 * separate decision, applied only to `retainRow()`, and it cannot affect the counts —
 * the two are different code paths over the same tuple, in that order, by
 * construction rather than by convention.
 *
 * ── The two SLIs ────────────────────────────────────────────────────────────
 * 1. **Binding-constraint distribution** per zone, mission class, and Leg `purpose`.
 *    > If 60 % of rejections in a zone are F34 (energy), the operational answer is
 *    > charger placement, not scoring changes.
 *    For F34 the binding **tier** is part of the key, "since a fleet blocked on
 *    immobilisation risk and one blocked on divert-to-charge risk need different
 *    interventions".
 * 2. **Near-miss margins** — the distance from satisfaction, "kept as a streaming
 *    quantile sketch rather than raw rows".
 *    > A fleet routinely failing F34 by 3 % is one configuration change away from
 *    > working, and that is very different from failing by 60 %.
 *
 * ── The sketch ──────────────────────────────────────────────────────────────
 * A bounded, deterministic q-digest-style sketch over a fixed logarithmic bucket
 * ladder. Fixed buckets rather than a sampled reservoir because §7.7 wants the sketch
 * to be exact over 100 % of decisions, and because a reservoir needs randomness, which
 * the decision path prohibits (T6). Bucket boundaries are powers of two in the
 * margin's own unit, which gives useful resolution across the several orders of
 * magnitude these margins span — probabilities near 1e-7 for F34 T3, milliseconds near
 * 1e5 for deadline predicates — without per-predicate tuning.
 *
 * Margins are bucketed **per `(predicateId, marginUnit)`**, never pooled: a sketch fed
 * metres, milliseconds, and probabilities together produces a number with no
 * interpretation.
 *
 * ── No clock, no store ──────────────────────────────────────────────────────
 * In the decision path (T6). Time is supplied; persistence is the flusher worker's.
 */

const { OUTCOME } = require("./threeValued");
const { predicate } = require("./register");

/**
 * The number of logarithmic buckets either side of zero. Sixty-four covers a margin
 * range from 2⁻³² to 2³¹ in the margin's own unit, which spans every dimension the
 * register produces.
 * @structural the sketch's bucket-ladder width; a resolution choice, not a threshold
 */
const SKETCH_BUCKETS = 64;

/**
 * The exponent of the smallest resolvable magnitude, so bucket 0 holds values below
 * 2⁻³². Below this the margin is reported as its sign only.
 * @structural the sketch's low-magnitude floor exponent
 */
const SKETCH_MIN_EXPONENT = -32;

/**
 * Place a margin in the bucket ladder.
 *
 * Sign is preserved as part of the bucket identity: a margin of −0.03 (failed by 3 %)
 * and +0.03 (passed with 3 % to spare) are the two facts §7.7's example contrasts, and
 * a magnitude-only sketch could not tell them apart.
 *
 * @param {number} margin
 * @returns {number} bucket index; negative indices denote negative margins
 */
function bucketOf(margin) {
  if (!Number.isFinite(margin) || margin === 0) return 0;
  const magnitude = Math.abs(margin);
  const exponent = Math.floor(Math.log2(magnitude));
  const clamped = Math.max(SKETCH_MIN_EXPONENT, Math.min(exponent, SKETCH_MIN_EXPONENT + SKETCH_BUCKETS - 1));
  const index = clamped - SKETCH_MIN_EXPONENT + 1;
  return margin < 0 ? -index : index;
}

/**
 * The magnitude range a bucket covers, for rendering a sketch back to a human.
 *
 * @param {number} bucket
 * @returns {{ from: number, to: number, sign: number }}
 */
function bucketRange(bucket) {
  if (bucket === 0) return { from: 0, to: 0, sign: 0 };
  const index = Math.abs(bucket) - 1;
  const exponent = index + SKETCH_MIN_EXPONENT;
  // @structural the ladder's base; buckets are powers of two by construction
  return { from: Math.pow(2, exponent), to: Math.pow(2, exponent + 1), sign: bucket < 0 ? -1 : 1 };
}

/**
 * The aggregation key §7.7 names: "per zone, mission class, and Leg `purpose`", plus
 * the binding tier for F34.
 *
 * @param {object} tuple
 * @returns {string}
 */
function aggregateKey(tuple) {
  return [
    tuple.shardId === undefined || tuple.shardId === null ? "-" : tuple.shardId,
    tuple.zoneId === undefined || tuple.zoneId === null ? "-" : tuple.zoneId,
    tuple.missionClass === undefined || tuple.missionClass === null ? "-" : tuple.missionClass,
    tuple.legPurpose === undefined || tuple.legPurpose === null ? "-" : tuple.legPurpose,
    tuple.predicateId,
    tuple.tier === undefined || tuple.tier === null ? "-" : tuple.tier,
  ].join("|");
}

/**
 * Create a shard-local aggregator.
 *
 * Held in memory and folded to `RejectionAggregate` / `NearMissSketch` by the
 * aggregation flusher (`workers/rejectionAggregation.worker.js`). In memory because
 * §7.7 requires the fold to happen *at decision time*, before the decision record is
 * written — a fold that went to the database synchronously would put a write on the
 * round's critical path.
 *
 * @returns {object}
 */
function createAggregator() {
  /** aggregateKey → { …dimensions, count } */
  const counts = new Map();
  /** `${predicateId}|${marginUnit}` → Map<bucket, count> */
  const sketches = new Map();
  /** Per-round tallies feeding §7.4's guard. */
  let evaluated = 0;
  let deniedForIndeterminacyOnly = 0;
  let rowsRetained = 0;
  let rowsOffered = 0;

  /**
   * Fold one rejection tuple into the histograms. **Never sampled.**
   *
   * @param {object} tuple `(agentId, predicateId, observed, required, inputSource,
   *   observationAgeMs)` plus the aggregation dimensions and the F34 binding tier
   */
  function record(tuple) {
    const key = aggregateKey(tuple);
    const existing = counts.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      counts.set(key, {
        shardId: tuple.shardId === undefined ? null : tuple.shardId,
        zoneId: tuple.zoneId === undefined ? null : tuple.zoneId,
        missionClass: tuple.missionClass === undefined ? null : tuple.missionClass,
        legPurpose: tuple.legPurpose === undefined ? null : tuple.legPurpose,
        predicateId: tuple.predicateId,
        tier: tuple.tier === undefined ? null : tuple.tier,
        count: 1,
      });
    }

    // The near-miss sketch. A margin with no unit is not recorded: pooling dimensions
    // would make the resulting quantile uninterpretable.
    if (typeof tuple.margin === "number" && Number.isFinite(tuple.margin) && tuple.marginUnit) {
      const sketchKey = `${tuple.predicateId}|${tuple.marginUnit}`;
      let sketch = sketches.get(sketchKey);
      if (!sketch) {
        sketch = new Map();
        sketches.set(sketchKey, sketch);
      }
      const bucket = bucketOf(tuple.margin);
      sketch.set(bucket, (sketch.get(bucket) || 0) + 1);
    }
  }

  /**
   * Record a candidate's overall disposition, for §7.4's guard.
   *
   * @param {{ admitted: boolean, deniedForIndeterminacyOnly: boolean }} disposition
   */
  function recordCandidate(disposition) {
    evaluated += 1;
    if (!disposition.admitted && disposition.deniedForIndeterminacyOnly) deniedForIndeterminacyOnly += 1;
  }

  /**
   * Should this per-candidate row be retained in the sampled Tier B (§21.2)?
   *
   * Called **after** `record()`, always, and its answer cannot affect the counts. The
   * sample decision is deterministic — a hash of the tuple's identity against the
   * rate, never a random draw — because the decision path prohibits unseeded
   * randomness (T6, §9.6) and because a replay must retain the same rows.
   *
   * @param {object} tuple
   * @param {number} sampleRate `observability.tier_b_sample_rate`, in [0, 1]
   * @returns {boolean}
   */
  function retainRow(tuple, sampleRate) {
    rowsOffered += 1;
    if (typeof sampleRate !== "number" || !Number.isFinite(sampleRate) || sampleRate <= 0) return false;
    if (sampleRate >= 1) {
      rowsRetained += 1;
      return true;
    }

    // Deterministic sampling: FNV-1a over the tuple identity, compared against the
    // rate. Replayable, and stable across processes.
    const identity = `${tuple.agentId}|${tuple.predicateId}|${tuple.decisionId || ""}`;
    // @structural FNV-1a's published 32-bit offset basis; a hash constant, not a threshold
    let hash = 0x811c9dc5;
    for (let index = 0; index < identity.length; index += 1) {
      hash ^= identity.charCodeAt(index);
      // @structural FNV-1a's published 32-bit prime; a hash constant, not a threshold
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    // @structural the 32-bit unsigned maximum, normalising the hash onto [0, 1)
    const retained = hash / 0xffffffff < sampleRate;
    if (retained) rowsRetained += 1;
    return retained;
  }

  /**
   * The §7.4 tally for this round.
   *
   * @returns {{ evaluated: number, deniedForIndeterminacyOnly: number }}
   */
  function tally() {
    return { evaluated, deniedForIndeterminacyOnly };
  }

  /**
   * The binding-constraint distribution, sorted descending by count. Sorted so that
   * the answer to "what is blocking this zone" is the first row (§7.7 SLI 1).
   *
   * @returns {object[]}
   */
  function bindingConstraintDistribution() {
    return [...counts.values()].sort(
      (a, b) => b.count - a.count || a.predicateId.localeCompare(b.predicateId),
    );
  }

  /**
   * The near-miss sketches, as flushable rows.
   *
   * @returns {object[]}
   */
  function nearMissSketches() {
    return [...sketches.entries()]
      .map(([key, buckets]) => {
        const [predicateId, marginUnit] = key.split("|");
        return {
          predicateId,
          marginUnit,
          buckets: [...buckets.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([bucket, count]) => ({ bucket, count, range: bucketRange(bucket) })),
          total: [...buckets.values()].reduce((sum, count) => sum + count, 0),
        };
      })
      .sort((a, b) => a.predicateId.localeCompare(b.predicateId) || a.marginUnit.localeCompare(b.marginUnit));
  }

  /**
   * Read a quantile out of a predicate's sketch.
   *
   * Returns the bucket's lower magnitude with its sign — the sketch is bucketed, so
   * the answer is a bound rather than a value, and reporting it as a value would
   * overstate the resolution.
   *
   * @param {string} predicateId
   * @param {string} marginUnit
   * @param {number} quantile in [0, 1]
   * @returns {{ bucket: number, atLeast: number, sign: number }|null}
   */
  function quantile(predicateId, marginUnit, quantile_) {
    const sketch = sketches.get(`${predicateId}|${marginUnit}`);
    if (!sketch) return null;
    const ordered = [...sketch.entries()].sort((a, b) => a[0] - b[0]);
    const total = ordered.reduce((sum, [, count]) => sum + count, 0);
    if (total === 0) return null;

    const target = quantile_ * total;
    let cumulative = 0;
    for (const [bucket, count] of ordered) {
      cumulative += count;
      if (cumulative >= target) {
        const range = bucketRange(bucket);
        return { bucket, atLeast: range.from * (range.sign === 0 ? 1 : range.sign), sign: range.sign };
      }
    }
    return null;
  }

  /**
   * Drain the aggregator for the flusher, and reset. Counts are handed over rather
   * than copied so that a flush cannot double-count.
   *
   * @returns {{ distribution: object[], sketches: object[], sampling: object }}
   */
  function drain() {
    const snapshot = {
      distribution: bindingConstraintDistribution(),
      sketches: nearMissSketches(),
      sampling: { rowsOffered, rowsRetained },
    };
    counts.clear();
    sketches.clear();
    evaluated = 0;
    deniedForIndeterminacyOnly = 0;
    rowsOffered = 0;
    rowsRetained = 0;
    return snapshot;
  }

  return {
    record,
    recordCandidate,
    retainRow,
    tally,
    bindingConstraintDistribution,
    nearMissSketches,
    quantile,
    drain,
  };
}

/**
 * Build the §7.7 tuple from a predicate result.
 *
 * The F34 binding tier is lifted into the key rather than left inside `observed`,
 * because §7.7 makes it part of the aggregation key and a value buried in a JSON blob
 * is not a key.
 *
 * @param {object} input
 * @param {string} input.agentId
 * @param {string} input.predicateId
 * @param {object} input.result the predicate result
 * @param {object} [input.dimensions] `{ shardId, zoneId, missionClass, legPurpose, decisionId }`
 * @returns {object} the rejection tuple
 */
function tupleFrom(input) {
  const result = input.result || {};
  const dimensions = input.dimensions || {};
  const entry = predicate(input.predicateId);

  // §7.7: "For F34 the binding **tier** … is part of the key". Read from the observed
  // value the predicate published, which is where f34 records it.
  const tier =
    result.observed && typeof result.observed === "object" && result.observed.bindingTier
      ? result.observed.bindingTier
      : null;

  return Object.freeze({
    agentId: input.agentId,
    predicateId: input.predicateId,
    constraintClass: entry ? entry.constraintClass : null,
    outcome: result.outcome === undefined ? null : result.outcome,
    observed: result.observed === undefined ? null : result.observed,
    required: result.required === undefined ? null : result.required,
    inputSource: result.inputSource === undefined ? null : result.inputSource,
    observationAgeMs: result.observationAgeMs === undefined ? null : result.observationAgeMs,
    margin: result.margin === undefined ? null : result.margin,
    marginUnit: result.marginUnit === undefined ? null : result.marginUnit,
    tier,
    indeterminate: result.outcome === OUTCOME.INDETERMINATE,
    shardId: dimensions.shardId === undefined ? null : dimensions.shardId,
    zoneId: dimensions.zoneId === undefined ? null : dimensions.zoneId,
    missionClass: dimensions.missionClass === undefined ? null : dimensions.missionClass,
    legPurpose: dimensions.legPurpose === undefined ? null : dimensions.legPurpose,
    decisionId: dimensions.decisionId === undefined ? null : dimensions.decisionId,
  });
}

module.exports = {
  SKETCH_BUCKETS,
  SKETCH_MIN_EXPONENT,
  bucketOf,
  bucketRange,
  aggregateKey,
  createAggregator,
  tupleFrom,
};
