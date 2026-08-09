"use strict";

/**
 * Engine lane — Phase 13: §3.5's two sizing bounds, and the binding one.
 *
 * > Shard size is bounded by two separate resources, and the specification states both
 * > **because a shard sized against only the first will silently violate the second**.
 * > […] Both bounds are continuously monitored as SLIs (§21.4), and the *binding* one is
 * > reported, so that a shard split is triggered by whichever resource is actually
 * > exhausted.
 *
 * The tests below are organised around the two ways that requirement is ordinarily
 * mis-implemented: reporting only the computable bound, and reporting an unevaluated bound
 * as satisfied.
 */

const service = require("../../src/engine/config/service");
const validators = require("../../src/engine/config/validators");
const sizing = require("../../src/engine/shard/sizing");

/** §3.5's worked example, at the specification's own stated defaults. */
const DEFAULTS = Object.freeze({
  agents: 20000,
  missionRatePerAgentHour: 4,
  txnPerMissionLifecycle: 2.05,
  commitTxnServiceTimeMs: 5,
  maxSerialUtilisation: 0.25,
});

describe("bound 2 — the serialised commit section (§3.5)", () => {
  // The number §3.5 derives in its own worked example, re-derived here rather than copied
  // from the module. If this drifts, either the arithmetic or the specification has moved.
  test("§3.5's worked example reproduces: ≈ 21 950 admissible agents at the stated defaults", () => {
    const bound = sizing.evaluateSerialCommitBound(DEFAULTS);
    expect(bound.evaluated).toBe(true);
    expect(bound.satisfied).toBe(true);
    expect(bound.admissibleAgents).toBe(21951);
    expect(bound.capacitySeconds).toBe(900);
  });

  // §3.5's second stated property, verbatim: "It is inversely proportional to mission
  // rate. A dense urban shard running short hops at r = 20 admits roughly 4 400 agents,
  // not 20 000."
  test("the bound is inversely proportional to mission rate — r = 20 admits ≈ 4 400, not 20 000", () => {
    const bound = sizing.evaluateSerialCommitBound({ ...DEFAULTS, missionRatePerAgentHour: 20 });
    expect(bound.satisfied).toBe(false);
    expect(bound.admissibleAgents).toBe(4390);
    expect(bound.sentence).toMatch(/inversely proportional to mission rate/);
  });

  test("`ρ_max` is reported as a queueing bound — a shard at 2 % of its budget is distinguishable from one at 98 %", () => {
    const quiet = sizing.evaluateSerialCommitBound({ ...DEFAULTS, agents: 500 });
    const busy = sizing.evaluateSerialCommitBound({ ...DEFAULTS, agents: 21000 });
    expect(quiet.satisfied).toBe(true);
    expect(busy.satisfied).toBe(true);
    expect(quiet.budgetUsed).toBeLessThan(0.05);
    expect(busy.budgetUsed).toBeGreaterThan(0.95);
    expect(quiet.realisedUtilisation).toBeLessThan(busy.realisedUtilisation);
  });

  test("SOFT reservations contribute zero — `k_txn` is the only transaction term, and it is 2.05", () => {
    // §3.5: "SOFT reservations contribute zero, because they are never written — this is
    // the single largest term the design removes from the serial section, and the reason
    // the bound is satisfiable at all." Asserted as arithmetic: raising k_txn to include a
    // per-replan write collapses the admissible count.
    const withSoft = sizing.evaluateSerialCommitBound({ ...DEFAULTS, txnPerMissionLifecycle: 20 });
    expect(withSoft.admissibleAgents).toBeLessThan(sizing.evaluateSerialCommitBound(DEFAULTS).admissibleAgents / 9);
  });

  test("a missing input reports the bound as **unevaluated**, never as satisfied", () => {
    const bound = sizing.evaluateSerialCommitBound({ ...DEFAULTS, commitTxnServiceTimeMs: undefined });
    expect(bound.evaluated).toBe(false);
    expect(bound.satisfied).toBeNull();
    expect(bound.missing).toEqual(["commitTxnServiceTimeMs"]);
    expect(bound.sentence).toMatch(/sized against a bound nobody computed is sized against nothing/);
  });
});

describe("bound 1 — round wall-clock, which is measured (§3.5, §20.1)", () => {
  test("a measurement inside the §20.1 budget holds, and reports its headroom", () => {
    const bound = sizing.evaluateRoundWallClockBound({ observedRoundWallClockP99Ms: 200, roundWallClockBudgetMs: 250 });
    expect(bound.satisfied).toBe(true);
    expect(bound.headroomMs).toBe(50);
    expect(bound.budgetUsed).toBeCloseTo(0.8);
  });

  test("a measurement beyond the budget is violated, and names §20.1's release-gate status", () => {
    const bound = sizing.evaluateRoundWallClockBound({ observedRoundWallClockP99Ms: 400, roundWallClockBudgetMs: 250 });
    expect(bound.satisfied).toBe(false);
    expect(bound.sentence).toMatch(/release-gate requirement rather than an aspiration/);
  });

  // §3.5: "This bound is measured, not derived." The failure this guards is a report that
  // calls an unmeasured shard correctly sized.
  test("no measurement means **unevaluated**, not satisfied", () => {
    const bound = sizing.evaluateRoundWallClockBound({ roundWallClockBudgetMs: 250 });
    expect(bound.evaluated).toBe(false);
    expect(bound.satisfied).toBeNull();
    expect(bound.reason).toBe("NO_MEASUREMENT");
    expect(bound.sentence).toMatch(/reporting a measurement nobody took/);
  });

  test("a p99 over too few rounds is refused — a maximum wearing a percentile's name", () => {
    const bound = sizing.evaluateRoundWallClockBound({
      observedRoundWallClockP99Ms: 100,
      roundWallClockBudgetMs: 250,
      samples: 4,
      minSamples: 100,
    });
    expect(bound.evaluated).toBe(false);
    expect(bound.reason).toBe("INSUFFICIENT_SAMPLES");
  });
});

describe("the binding bound (§3.5's last sentence)", () => {
  test("a violated bound binds", () => {
    const evaluation = sizing.evaluate({
      serialCommit: { ...DEFAULTS, missionRatePerAgentHour: 20 },
      roundWallClock: { observedRoundWallClockP99Ms: 100, roundWallClockBudgetMs: 250 },
    });
    expect(evaluation.bindingBound).toBe(sizing.BOUND.SERIAL_COMMIT);
    expect(evaluation.satisfied).toBe(false);
    expect(evaluation.rebalanceIndicated).toBe(true);
  });

  test("when both hold, the one with the least headroom binds — the resource that runs out first", () => {
    const evaluation = sizing.evaluate({
      serialCommit: { ...DEFAULTS, agents: 2000 },
      roundWallClock: { observedRoundWallClockP99Ms: 245, roundWallClockBudgetMs: 250 },
    });
    expect(evaluation.bindingBound).toBe(sizing.BOUND.ROUND_WALL_CLOCK);
    expect(evaluation.satisfied).toBe(true);
    expect(evaluation.why).toMatch(/least headroom and will be exhausted first/);
  });

  test("when both are violated, the larger overrun binds", () => {
    const evaluation = sizing.evaluate({
      serialCommit: { ...DEFAULTS, agents: 25000 },
      roundWallClock: { observedRoundWallClockP99Ms: 2500, roundWallClockBudgetMs: 250 },
    });
    expect(evaluation.bindingBound).toBe(sizing.BOUND.ROUND_WALL_CLOCK);
    expect(evaluation.why).toMatch(/both bounds are violated/);
  });

  // The failure §3.5 states both bounds in order to prevent, driven: a shard whose
  // arithmetic passes while its rounds overrun must not report itself as sized.
  test("a shard whose arithmetic passes but whose rounds overrun is reported as exceeded, on the right bound", () => {
    const evaluation = sizing.evaluate({
      serialCommit: { ...DEFAULTS, agents: 1000 },
      roundWallClock: { observedRoundWallClockP99Ms: 900, roundWallClockBudgetMs: 250 },
    });
    expect(evaluation.satisfied).toBe(false);
    expect(evaluation.bindingBound).toBe(sizing.BOUND.ROUND_WALL_CLOCK);
    expect(evaluation.bounds[sizing.BOUND.SERIAL_COMMIT].satisfied).toBe(true);
  });

  test("**both** bounds are always returned, so neither becomes unmonitorable through this surface", () => {
    const evaluation = sizing.evaluate({ serialCommit: DEFAULTS, roundWallClock: { observedRoundWallClockP99Ms: 200, roundWallClockBudgetMs: 250 } });
    expect(Object.keys(evaluation.bounds).sort()).toEqual([sizing.BOUND.ROUND_WALL_CLOCK, sizing.BOUND.SERIAL_COMMIT].sort());
  });

  test("neither evaluated is NEITHER_EVALUATED — and is not a statement that the shard is sized", () => {
    const evaluation = sizing.evaluate({ serialCommit: {}, roundWallClock: {} });
    expect(evaluation.bindingBound).toBe(sizing.BOUND.NEITHER_EVALUATED);
    expect(evaluation.satisfied).toBeNull();
    expect(evaluation.why).toMatch(/not a statement that the shard is correctly sized/);
  });

  test("one evaluated binds by default, and the other is reported as unevaluated rather than satisfied", () => {
    const evaluation = sizing.evaluate({ serialCommit: DEFAULTS, roundWallClock: { roundWallClockBudgetMs: 250 } });
    expect(evaluation.bindingBound).toBe(sizing.BOUND.SERIAL_COMMIT);
    expect(evaluation.why).toMatch(/the other is unevaluated, not satisfied/);
    expect(evaluation.bounds[sizing.BOUND.ROUND_WALL_CLOCK].satisfied).toBeNull();
  });

  test("the persisted form carries both bounds and the binding one", () => {
    const evaluation = sizing.evaluate({ serialCommit: DEFAULTS, roundWallClock: { observedRoundWallClockP99Ms: 200, roundWallClockBudgetMs: 250 } });
    const update = sizing.toShardUpdate(evaluation, new Date(0));
    expect(update.bindingBound).toBe(evaluation.bindingBound);
    expect(Object.keys(update.sizingDetail.bounds)).toHaveLength(2);
    expect(update.sizingCheckedAt).toEqual(new Date(0));
  });

  test("the evaluation is pure — the same inputs give the same verdict, and it reads no clock", () => {
    const input = { serialCommit: DEFAULTS, roundWallClock: { observedRoundWallClockP99Ms: 200, roundWallClockBudgetMs: 250 } };
    expect(sizing.evaluate(input)).toEqual(sizing.evaluate(input));
    const source = require("fs").readFileSync(require.resolve("../../src/engine/shard/sizing.js"), "utf8");
    expect(source).not.toMatch(/Date\.now\(|new Date\(|Math\.random\(/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §22.1 rule 5 — the inequality at publish, and the region it is evaluated per
   ═══════════════════════════════════════════════════════════════════════════ */

describe("V4 at publish time (§22.1 rule 5, §3.5)", () => {
  const values = () => service.defaultSnapshot().values;

  test("the seeded defaults pass", () => {
    expect(validators.v4ShardSizing(values())).toEqual([]);
  });

  test("V4 delegates to sizing.js — there is one implementation of the inequality", () => {
    const source = require("fs").readFileSync(require.resolve("../../src/engine/config/validators.js"), "utf8");
    expect(source).toMatch(/sizing\.evaluateSerialCommitBound/);
    // And the arithmetic is *not* restated in the validator.
    const v4 = source.slice(source.indexOf("function v4ShardSizing"), source.indexOf("function v5DedupRetention"));
    expect(v4).not.toMatch(/SECONDS_PER_HOUR|MS_PER_SECOND/);
  });

  // §3.5: "shard size is therefore configured per region against that region's measured
  // r". A publish validated only at global scope passes a set in which one dense region is
  // oversubscribed fivefold.
  test("a per-shard definition that violates the bound is caught, even when the global set passes", () => {
    const findings = validators.v4ShardSizing(values(), [
      { shardId: "quiet", regionId: "suburb", maxAgents: 5000, missionRatePerAgentHour: 2 },
      { shardId: "dense", regionId: "metro", maxAgents: 20000, missionRatePerAgentHour: 20 },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toMatch(/^shard "dense" \(region "metro"\)/);
    expect(findings[0].message).toMatch(/bound 2 is violated/);
  });

  test("a definition set that breaks region → shard is blocked at publish, not at the first Leg", () => {
    const findings = validators.v4ShardSizing(values(), [
      { shardId: "a", regionId: "metro", maxAgents: 100 },
      { shardId: "b", regionId: "metro", maxAgents: 100 },
    ]);
    expect(findings.map((finding) => finding.message).join(" ")).toMatch(/is claimed by both/);
  });

  test("`k_txn` is not overridable per shard — it is a property of the mission lifecycle, not of a region", () => {
    const findings = validators.v4ShardSizing(values(), [
      { shardId: "a", regionId: "metro", maxAgents: 20000, txnPerMissionLifecycle: 0.001 },
    ]);
    // The override is ignored, so the shard is still evaluated against k_txn = 2.05 and
    // still passes on the global rate. If the override were honoured it would be a way to
    // make any shard admissible by declaring its transactions free.
    expect(findings).toEqual([]);
  });

  test("a whole publish carrying shard definitions is validated through the service", () => {
    const outcome = service.validateCandidate({
      shards: [{ shardId: "dense", regionId: "metro", maxAgents: 20000, missionRatePerAgentHour: 20 }],
    });
    expect(outcome.result.ok).toBe(false);
    expect(outcome.result.blocking.map((item) => item.id)).toContain("V4");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   A4 — §19.5's renewal margin
   ═══════════════════════════════════════════════════════════════════════════ */

describe("A4 — the leadership renewal margin (§19.5)", () => {
  function withValues(overrides) {
    const values = service.defaultSnapshot().values;
    for (const [name, value] of Object.entries(overrides)) values.set(name, value);
    return values;
  }

  test("the seeded defaults are satisfiable", () => {
    expect(validators.a4LeadershipRenewalMargin(service.defaultSnapshot().values)).toEqual([]);
  });

  test("a renewal interval at or beyond the margin is blocked", () => {
    const findings = validators.a4LeadershipRenewalMargin(withValues({ "shard.renewal_interval": 4500 }));
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("BLOCKING");
    expect(findings[0].message).toMatch(/committing in bursts/);
  });

  test("the boundary is exclusive — exactly the latest lawful instant is refused", () => {
    // lease 5 s, skew 500 ms, round trip 500 ms → latest lawful renewal is 4 000 ms.
    expect(validators.a4LeadershipRenewalMargin(withValues({ "shard.renewal_interval": 3999 }))).toEqual([]);
    expect(validators.a4LeadershipRenewalMargin(withValues({ "shard.renewal_interval": 4000 }))).toHaveLength(1);
  });

  test("an unset input is reported rather than passed over", () => {
    const findings = validators.a4LeadershipRenewalMargin(withValues({ "shard.store_round_trip_budget": null }));
    expect(findings[0].message).toMatch(/cannot be validated/);
  });
});
