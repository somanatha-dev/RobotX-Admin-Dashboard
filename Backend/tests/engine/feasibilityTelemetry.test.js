"use strict";

/**
 * Engine lane — Phase 6: rejection reporting (§7.7).
 *
 * The completion criterion the execution plan states for this surface is a property,
 * not a feature: *"rejection aggregation exact over 100 % of decisions"*. §7.7 explains
 * what makes that possible and what would destroy it:
 *
 * > **Aggregation happens at decision time; only the per-candidate rows are sampled.**
 * > … Aggregating first and sampling second is what allows full-fidelity capacity
 * > diagnostics and bounded write volume to hold simultaneously; **sampling first would
 * > degrade the histogram to an estimate and destroy exactly the property that makes it
 * > useful for capacity planning**.
 *
 * The central test below is therefore an ordering test: at a sample rate of zero, where
 * no per-candidate row is retained at all, the histograms must still be exact.
 */

const fx = require("./helpers/feasibilityFixture");
const evaluate = require("../../src/engine/feasibility/evaluate");
const telemetry = require("../../src/engine/feasibility/rejectionTelemetry");
const worker = require("../../src/workers/rejectionAggregation.worker");
const { OUTCOME } = require("../../src/engine/feasibility/threeValued");

const R = fx.REMOVE;

const DIMENSIONS = { shardId: "shard-1", zoneId: "zone-1", missionClass: "PARCEL", legPurpose: "PRIMARY", decisionId: "d1" };

/* ═══════════════════════════════════════════════════════════════════════════
   §7.7 — the structured tuple
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§7.7 — the rejection tuple", () => {
  test("carries every field the specification enumerates", () => {
    // "(agent_id, predicate_id, observed_value, required_value, input_source,
    // observation_age)" — stricter than logging a message string.
    const outcome = evaluate.gate({ id: "c" }, fx.withPatch({ agentSnapshot: { session: { lastHeartbeatAt: new Date(fx.DECISION_TIME_MS - 600_000) } } }), {
      dimensions: DIMENSIONS,
    });

    expect(outcome.feasible).toBe(false);
    const tuple = outcome.tuples[0];

    expect(tuple.agentId).toBe("agent-1");
    expect(tuple.predicateId).toBe("F13");
    expect(tuple.observed).not.toBeNull();
    expect(tuple.required).not.toBeNull();
    expect(tuple.inputSource).toBe("SENSOR");
    expect(typeof tuple.observationAgeMs).toBe("number");
  });

  test("carries the §7.2 class and the aggregation dimensions", () => {
    const outcome = evaluate.gate({ id: "c" }, fx.withPatch({ agentSnapshot: { emergencyStop: { value: true } } }), {
      dimensions: DIMENSIONS,
    });
    const tuple = outcome.tuples[0];

    expect(tuple.constraintClass).toBe("I");
    expect(tuple.zoneId).toBe("zone-1");
    expect(tuple.missionClass).toBe("PARCEL");
    expect(tuple.legPurpose).toBe("PRIMARY");
  });

  test("lifts the F34 binding tier into the key, not into a JSON blob", () => {
    // §7.7: "For F34 the binding tier is part of the key". A value buried inside
    // `observed` is not a key.
    const outcome = evaluate.gate({ id: "c" }, fx.withPatch({ plan: { energy: { tierProbabilities: { T3: 1e-3 } } } }), {
      dimensions: DIMENSIONS,
    });
    const tuple = outcome.tuples.find((row) => row.predicateId === "F34");

    expect(tuple.tier).toBe("T3");
    expect(telemetry.aggregateKey(tuple)).toContain("|T3");
  });

  test("distinguishes an indeterminate rejection from a violated one", () => {
    const violated = evaluate.gate({ id: "a" }, fx.withPatch({ agentSnapshot: { emergencyStop: { value: true } } }), {});
    const indeterminate = evaluate.gate({ id: "b" }, fx.withPatch({ agentSnapshot: { emergencyStop: R } }), {});

    expect(violated.tuples[0].indeterminate).toBe(false);
    expect(indeterminate.tuples[0].indeterminate).toBe(true);
    expect(indeterminate.tuples[0].outcome).toBe(OUTCOME.INDETERMINATE);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   Aggregate first, sample second
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§7.7 — aggregation happens before sampling", () => {
  test("the histogram is exact at a sample rate of zero", () => {
    // The property the whole ordering exists to protect. Not one per-candidate row is
    // retained, and the distribution is still exact over every decision.
    const aggregator = telemetry.createAggregator();
    const candidates = [];
    for (let index = 0; index < 100; index += 1) {
      candidates.push({
        candidate: { id: `c${index}` },
        context: fx.withPatch({ agentSnapshot: { emergencyStop: { value: true } } }),
      });
    }

    const outcome = evaluate.gateAll(candidates, { aggregator, dimensions: DIMENSIONS });
    for (const rejected of outcome.rejected) {
      for (const tuple of rejected.tuples) {
        expect(aggregator.retainRow(tuple, 0)).toBe(false);
      }
    }

    const distribution = aggregator.bindingConstraintDistribution();
    expect(distribution).toHaveLength(1);
    expect(distribution[0].predicateId).toBe("F7");
    expect(distribution[0].count).toBe(100);
  });

  test("sampling cannot change a count", () => {
    const aggregator = telemetry.createAggregator();
    const tuple = telemetry.tupleFrom({
      agentId: "agent-1",
      predicateId: "F34",
      result: { outcome: OUTCOME.VIOLATED, margin: -0.01, marginUnit: "prob", observed: { bindingTier: "T1" } },
      dimensions: DIMENSIONS,
    });

    aggregator.record(tuple);
    const before = aggregator.bindingConstraintDistribution()[0].count;
    for (const rate of [0, 0.5, 1]) aggregator.retainRow(tuple, rate);
    expect(aggregator.bindingConstraintDistribution()[0].count).toBe(before);
  });

  test("the sample decision is deterministic, so a replay retains the same rows", () => {
    // T6/§9.6: unseeded randomness is prohibited in the decision path, and a replay
    // must reach the same conclusions.
    const tuple = telemetry.tupleFrom({
      agentId: "agent-7",
      predicateId: "F21",
      result: { outcome: OUTCOME.VIOLATED },
      dimensions: DIMENSIONS,
    });

    const first = telemetry.createAggregator().retainRow(tuple, 0.5);
    const second = telemetry.createAggregator().retainRow(tuple, 0.5);
    const third = telemetry.createAggregator().retainRow(tuple, 0.5);
    expect(first).toBe(second);
    expect(second).toBe(third);
  });

  test("a sample rate of 1 retains everything and 0 retains nothing", () => {
    const aggregator = telemetry.createAggregator();
    const tuple = telemetry.tupleFrom({ agentId: "a", predicateId: "F9", result: {}, dimensions: DIMENSIONS });
    expect(aggregator.retainRow(tuple, 1)).toBe(true);
    expect(aggregator.retainRow(tuple, 0)).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   SLI 1 — the binding-constraint distribution
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§7.7 SLI 1 — the binding-constraint distribution", () => {
  test("§7.7's own worked example: 60 % of a zone's rejections are F34", () => {
    const aggregator = telemetry.createAggregator();
    const record = (predicateId, times, tier) => {
      for (let index = 0; index < times; index += 1) {
        aggregator.record(
          telemetry.tupleFrom({
            agentId: `a${index}`,
            predicateId,
            result: { outcome: OUTCOME.VIOLATED, observed: tier ? { bindingTier: tier } : null },
            dimensions: DIMENSIONS,
          }),
        );
      }
    };

    record("F34", 60, "T1");
    record("F21", 25);
    record("F13", 15);

    const distribution = aggregator.bindingConstraintDistribution();
    // Sorted descending, so "what is blocking this zone" is the first row.
    expect(distribution[0].predicateId).toBe("F34");
    expect(distribution[0].count / 100).toBe(0.6);
    // "the operational answer is charger placement, not scoring changes"
    expect(distribution[0].tier).toBe("T1");
  });

  test("F34 tiers aggregate separately, never summed", () => {
    // A fleet blocked on immobilisation risk and one blocked on divert-to-charge risk
    // need different interventions, so one "F34: 100" row would be actively misleading.
    const aggregator = telemetry.createAggregator();
    for (const [tier, count] of [["T1", 5], ["T3", 2]]) {
      for (let index = 0; index < count; index += 1) {
        aggregator.record(
          telemetry.tupleFrom({
            agentId: `a${index}`,
            predicateId: "F34",
            result: { outcome: OUTCOME.VIOLATED, observed: { bindingTier: tier } },
            dimensions: DIMENSIONS,
          }),
        );
      }
    }

    const rows = aggregator.bindingConstraintDistribution();
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.tier === "T1").count).toBe(5);
    expect(rows.find((row) => row.tier === "T3").count).toBe(2);
  });

  test("the same predicate in different zones aggregates separately", () => {
    const aggregator = telemetry.createAggregator();
    for (const zoneId of ["zone-1", "zone-2", "zone-1"]) {
      aggregator.record(
        telemetry.tupleFrom({
          agentId: "a",
          predicateId: "F34",
          result: { outcome: OUTCOME.VIOLATED },
          dimensions: { ...DIMENSIONS, zoneId },
        }),
      );
    }
    const rows = aggregator.bindingConstraintDistribution();
    expect(rows.find((row) => row.zoneId === "zone-1").count).toBe(2);
    expect(rows.find((row) => row.zoneId === "zone-2").count).toBe(1);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   SLI 2 — near-miss margins
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§7.7 SLI 2 — near-miss margins", () => {
  test("§7.7's own worked example: failing F34 by 3 % versus by 60 %", () => {
    const near = telemetry.createAggregator();
    const far = telemetry.createAggregator();

    near.record(
      telemetry.tupleFrom({
        agentId: "a",
        predicateId: "F34",
        result: { outcome: OUTCOME.VIOLATED, margin: -0.03, marginUnit: "prob" },
        dimensions: DIMENSIONS,
      }),
    );
    far.record(
      telemetry.tupleFrom({
        agentId: "a",
        predicateId: "F34",
        result: { outcome: OUTCOME.VIOLATED, margin: -0.6, marginUnit: "prob" },
        dimensions: DIMENSIONS,
      }),
    );

    // "one configuration change away from working" and "not close" land in different
    // buckets, which is the entire point of keeping the distance rather than the count.
    expect(telemetry.bucketOf(-0.03)).not.toBe(telemetry.bucketOf(-0.6));
    expect(near.nearMissSketches()[0].buckets[0].bucket).not.toBe(far.nearMissSketches()[0].buckets[0].bucket);
  });

  test("sign is preserved: failing by 3 % and passing by 3 % are distinguishable", () => {
    expect(telemetry.bucketOf(-0.03)).toBe(-telemetry.bucketOf(0.03));
    expect(telemetry.bucketOf(-0.03)).toBeLessThan(0);
    expect(telemetry.bucketOf(0.03)).toBeGreaterThan(0);
  });

  test("margins in different units are never pooled", () => {
    // A quantile over metres, milliseconds, and probabilities together is a number
    // with no interpretation.
    const aggregator = telemetry.createAggregator();
    aggregator.record(
      telemetry.tupleFrom({
        agentId: "a",
        predicateId: "F29",
        result: { outcome: OUTCOME.VIOLATED, margin: -1, marginUnit: "m" },
        dimensions: DIMENSIONS,
      }),
    );
    aggregator.record(
      telemetry.tupleFrom({
        agentId: "a",
        predicateId: "F29",
        result: { outcome: OUTCOME.VIOLATED, margin: -1, marginUnit: "kg" },
        dimensions: DIMENSIONS,
      }),
    );

    const sketches = aggregator.nearMissSketches();
    expect(sketches).toHaveLength(2);
    expect(sketches.map((row) => row.marginUnit).sort()).toEqual(["kg", "m"]);
  });

  test("a margin with no unit is not recorded", () => {
    const aggregator = telemetry.createAggregator();
    aggregator.record(
      telemetry.tupleFrom({
        agentId: "a",
        predicateId: "F21",
        result: { outcome: OUTCOME.VIOLATED, margin: -5 },
        dimensions: DIMENSIONS,
      }),
    );
    // The count still lands; only the uninterpretable sketch entry is skipped.
    expect(aggregator.bindingConstraintDistribution()).toHaveLength(1);
    expect(aggregator.nearMissSketches()).toHaveLength(0);
  });

  test("the sketch is bounded regardless of input magnitude", () => {
    const aggregator = telemetry.createAggregator();
    for (const margin of [-1e-40, -1e40, -1, 0, 1e300]) {
      aggregator.record(
        telemetry.tupleFrom({
          agentId: "a",
          predicateId: "F34",
          result: { outcome: OUTCOME.VIOLATED, margin, marginUnit: "prob" },
          dimensions: DIMENSIONS,
        }),
      );
    }
    const sketch = aggregator.nearMissSketches()[0];
    expect(sketch.buckets.length).toBeLessThanOrEqual(telemetry.SKETCH_BUCKETS * 2 + 1);
    expect(sketch.total).toBe(5);
  });

  test("a quantile reads back as a bound, not as a value", () => {
    // The sketch is bucketed, so reporting a quantile as a point value would overstate
    // the resolution it actually has.
    const aggregator = telemetry.createAggregator();
    for (let index = 0; index < 10; index += 1) {
      aggregator.record(
        telemetry.tupleFrom({
          agentId: "a",
          predicateId: "F34",
          result: { outcome: OUTCOME.VIOLATED, margin: -0.03, marginUnit: "prob" },
          dimensions: DIMENSIONS,
        }),
      );
    }
    const quantile = aggregator.quantile("F34", "prob", 0.5);
    expect(quantile).not.toBeNull();
    expect(quantile.sign).toBe(-1);
    expect(typeof quantile.atLeast).toBe("number");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   The aggregator's lifecycle and the flusher
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the aggregation flusher", () => {
  test("drain hands the counts over and resets, so a flush cannot double-count", () => {
    const aggregator = telemetry.createAggregator();
    aggregator.record(telemetry.tupleFrom({ agentId: "a", predicateId: "F7", result: {}, dimensions: DIMENSIONS }));

    const first = aggregator.drain();
    expect(first.distribution).toHaveLength(1);

    const second = aggregator.drain();
    expect(second.distribution).toHaveLength(0);
  });

  test("the §7.4 tally resets with the drain", () => {
    const aggregator = telemetry.createAggregator();
    aggregator.recordCandidate({ admitted: false, deniedForIndeterminacyOnly: true });
    expect(aggregator.tally()).toEqual({ evaluated: 1, deniedForIndeterminacyOnly: 1 });
    aggregator.drain();
    expect(aggregator.tally()).toEqual({ evaluated: 0, deniedForIndeterminacyOnly: 0 });
  });

  test("bucket windows are half-open and aligned to the ladder", () => {
    const bucket = worker.bucketFor(fx.DECISION_TIME_MS + 12_345);
    expect(bucket.bucketEnd.getTime() - bucket.bucketStart.getTime()).toBe(worker.BUCKET_WIDTH_MS);
    expect(bucket.bucketStart.getTime() % worker.BUCKET_WIDTH_MS).toBe(0);
    // The same instant always lands in the same bucket, which is what makes the
    // flusher's upsert key stable across processes.
    expect(worker.bucketFor(fx.DECISION_TIME_MS + 12_345)).toEqual(bucket);
  });

  test("the full sweep interval is under the plan's stated bound", () => {
    expect(worker.FLUSH_INTERVAL_MS).toBeLessThanOrEqual(60_000);
  });

  test("sketch ladders merge by addition, so two flushes compose", () => {
    // What makes the ladder a *streaming* sketch: flushing a window twice must produce
    // the same distribution one flush of the union would have.
    const merged = worker.mergeBuckets({ "-3": 2, "-4": 1 }, [{ bucket: -3, count: 5 }, { bucket: -5, count: 1 }]);
    expect(merged).toEqual({ "-3": 7, "-4": 1, "-5": 1 });
  });

  test("mergeBuckets tolerates an absent stored ladder", () => {
    expect(worker.mergeBuckets(null, [{ bucket: 1, count: 3 }])).toEqual({ 1: 3 });
  });

  test("a flusher with no aggregator refuses to run", () => {
    // A flusher with nothing to drain would report an empty distribution while
    // rejections were being discarded — the silent version of the failure §7.7 exists
    // to make visible.
    return expect(worker.flushOnce({}, {})).rejects.toThrow(/requires the shard's aggregator/);
  });

  test("an empty aggregator flushes to nothing and writes no rows", async () => {
    const outcome = await worker.flushOnce(
      { aggregator: telemetry.createAggregator(), now: () => fx.DECISION_TIME_MS },
      { shardId: "shard-1" },
    );
    expect(outcome.empty).toBe(true);
    expect(outcome.aggregatesWritten).toBe(0);
  });

  test("a snapshot folds into both tables", async () => {
    const writes = { aggregates: [], sketches: [] };
    const prisma = {
      rejectionAggregate: {
        async upsert(args) {
          writes.aggregates.push(args);
        },
      },
      nearMissSketch: {
        async findUnique() {
          return null;
        },
        async upsert(args) {
          writes.sketches.push(args);
        },
      },
    };

    const aggregator = telemetry.createAggregator();
    aggregator.record(
      telemetry.tupleFrom({
        agentId: "a",
        predicateId: "F34",
        result: { outcome: OUTCOME.VIOLATED, margin: -0.03, marginUnit: "prob", observed: { bindingTier: "T1" } },
        dimensions: DIMENSIONS,
      }),
    );

    const outcome = await worker.flushOnce(
      { prisma, aggregator, now: () => fx.DECISION_TIME_MS },
      { shardId: "shard-1" },
    );

    expect(outcome.aggregatesWritten).toBe(1);
    expect(outcome.sketchesWritten).toBe(1);
    expect(writes.aggregates[0].create.predicateId).toBe("F34");
    expect(writes.aggregates[0].create.tier).toBe("T1");
    // Upsert-and-add is what makes an at-least-once retry safe.
    expect(writes.aggregates[0].update.count).toEqual({ increment: BigInt(1) });
  });
});
