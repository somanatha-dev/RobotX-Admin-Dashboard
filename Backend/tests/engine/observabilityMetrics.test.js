"use strict";

/**
 * Engine lane — Phase 11: the §21.4 metric set and §20.1's release-gate targets.
 *
 * §21.4 states **seven** groups; the execution plan's checklist says six. §0.1 of the
 * plan settles it — the specification wins — so all seven are implemented and tested.
 */

const metrics = require("../../src/engine/observability/metrics");
const sli = require("../../src/engine/observability/sli");
const fixture = require("./helpers/roundFixture");

describe("§21.4 — the metric set, organised by the question it answers", () => {
  test("all seven groups are present and none is empty", () => {
    const coverage = metrics.assertCoverage();
    expect(coverage.ok).toBe(true);
    expect(coverage.problems).toEqual([]);
    expect(metrics.GROUPS).toHaveLength(7);
    for (const group of metrics.GROUPS) expect(coverage.byGroup[group.id]).toBeGreaterThan(0);
  });

  test("every metric names a question — §21.4's own organising principle", () => {
    // "Organised by what question they answer, because a metric that answers no question
    // will not be looked at."
    for (const metric of metrics.METRICS) {
      expect({ id: metric.id, question: Boolean(metric.question) }).toEqual({ id: metric.id, question: true });
      expect({ id: metric.id, producer: Boolean(metric.producer) }).toEqual({ id: metric.id, producer: true });
    }
  });

  test("the two gaps §9.3 reports separately are two metrics, never one", () => {
    expect(metrics.METRIC_BY_ID.search_gap).toBeDefined();
    expect(metrics.METRIC_BY_ID.column_generation_gap).toBeDefined();
    expect(metrics.METRIC_BY_ID.search_gap.note).toMatch(/never summed/i);
    expect(metrics.METRIC_BY_ID.search_gap.note).toMatch(/would bound neither/i);
  });

  test("the two fence-rejection scopes are two metrics, never one", () => {
    // §21.4: "the two scopes fail for entirely different reasons, so a combined counter
    // would hide both".
    expect(metrics.METRIC_BY_ID.fence_rejections_commitment_scope).toBeDefined();
    expect(metrics.METRIC_BY_ID.fence_rejections_agent_scope).toBeDefined();
  });

  test("the two routing cache populations are reported separately (§20.3)", () => {
    expect(metrics.METRIC_BY_ID.cell_pair_cache_hit_rate).toBeDefined();
    expect(metrics.METRIC_BY_ID.charger_reachability_cache_hit_rate).toBeDefined();
  });

  test("the invariant-violation count is sourced from the independent checker, never the enforcer", () => {
    // §26: "a checker sharing logic with the enforcer verifies nothing".
    expect(metrics.METRIC_BY_ID.invariant_violations.source).toBe(metrics.SOURCE.INVARIANT_CHECKER);
    expect(metrics.METRIC_BY_ID.invariant_violations.note).toMatch(/MUST be zero/);
  });

  test("§7.7's histogram is sourced from the exact aggregate, never from a sampled record", () => {
    expect(metrics.METRIC_BY_ID.rejection_histogram.source).toBe(metrics.SOURCE.REJECTION_AGGREGATE);
    expect(metrics.METRIC_BY_ID.rejection_histogram.note).toMatch(/Exact over 100 % of decisions/);
  });

  test("the idle-time metric is broken down BY CAUSE, which is what makes it actionable", () => {
    expect(metrics.METRIC_BY_ID.idle_time_by_cause.dimensions[0]).toMatch(/NO_DEMAND.*INFEASIBLE.*UNAVAILABLE.*CHARGING.*QUARANTINED/);
  });

  test("the reconciler repair rate is broken down by category (T10)", () => {
    expect(metrics.METRIC_BY_ID.reconciler_repair_rate.dimensions).toEqual(["category"]);
  });

  test("the Safety-class-not-DERIVED count exists and is flagged as MUST-be-zero", () => {
    expect(metrics.METRIC_BY_ID.safety_class_not_derived.note).toMatch(/MUST be zero/);
  });
});

describe("§21.4 — derivation from the durable record", () => {
  test("derives write rates, regimes, abort reasons, queue and outbox depth", async () => {
    const prisma = fixture.memoryPrisma();

    prisma.__tables.decisionRecords.push(
      { decisionId: "d1", shardId: "s1", decisionTime: new Date(1000), outcome: { outcome: "ASSIGNED" }, shadowLabel: null },
      { decisionId: "d2", shardId: "s1", decisionTime: new Date(1000), outcome: { outcome: "COMMIT_ABORTED", commitAbortReason: "G1_STALE_LEADERSHIP" }, shadowLabel: null },
      { decisionId: "d3", shardId: "s1", decisionTime: new Date(1000), outcome: { outcome: "NO_FEASIBLE_CANDIDATE" }, shadowLabel: null },
    );
    prisma.__tables.tierBRecords.push({ decisionId: "d1", shardId: "s1", decisionTime: new Date(1000), writtenBecause: "SAMPLED" });
    prisma.__tables.rounds.push(
      { roundId: "r1", shardId: "s1", decisionTime: new Date(1000), regime: "SINGLETON", budgets: { budgetLimited: false }, searchGapMilliCU: "3000", lpIpGapMilliCU: "0" },
      { roundId: "r2", shardId: "s1", decisionTime: new Date(1000), regime: "SINGLETON", budgets: { budgetLimited: true }, searchGapMilliCU: "9000", lpIpGapMilliCU: "0" },
    );
    prisma.__tables.workQueue.push({ id: "q1", shardId: "s1", state: "QUEUED", enqueuedAt: new Date(0) });

    const report = await metrics.derive({ prisma }, { shardId: "s1", fromMs: 0, toMs: 60000, config: { get: () => 5000 } });
    const by = Object.fromEntries(report.readings.map((row) => [row.id, row]));

    expect(by.tier_a_write_rate.value).toBe(3);
    expect(by.tier_b_write_rate.byWrittenBecause).toEqual({ SAMPLED: 1 });
    expect(by.tier_b_write_rate.withinBudget).toBe(true);
    expect(by.rounds_by_regime.value).toEqual({ SINGLETON: 1 });
    expect(by.budget_limited_fraction.value).toBe(0.5);
    expect(by.commit_abort_rate.value).toBeCloseTo(1 / 3);
    expect(by.commit_abort_reasons.value).toEqual({ G1_STALE_LEADERSHIP: 1 });
    expect(by.zero_feasible_fraction.value).toBeCloseTo(1 / 3);
    expect(by.queue_depth.value).toBe(1);
    // The search gap stays integer milli-CU all the way out (§9.6 requirement 1).
    expect(by.search_gap.value).toEqual(expect.any(String));
    expect(by.search_gap.reportedSeparatelyFrom).toBe("column_generation_gap");
  });

  test("a metric whose producer has not landed reports null WITH the reason, never zero", async () => {
    const prisma = fixture.memoryPrisma();
    const report = await metrics.derive({ prisma }, { shardId: "s1", fromMs: 0, toMs: 60000 });

    const unfed = report.unavailable.find((row) => row.id === "duty_cycle_distribution");
    // A metric reporting zero because nothing feeds it is indistinguishable from a
    // system that is behaving, which is the failure an observability phase is least
    // entitled to ship.
    expect(unfed.value).toBeNull();
    expect(unfed.unavailableBecause).toMatch(/no producer has landed yet/);
    expect(unfed.producer).toMatch(/Tier 2/);
  });

  test("a failing derivation degrades that metric alone, never the whole report", async () => {
    const prisma = fixture.memoryPrisma();
    prisma.workQueue.count = async () => {
      throw new Error("connection reset");
    };

    const report = await metrics.derive({ prisma }, { shardId: "s1", fromMs: 0, toMs: 60000 });
    expect(report.failures.map((row) => row.id)).toContain("queue_depth");
    // The rest still came back: a metrics surface that fails whole during an incident is
    // one nobody trusts during the next one.
    expect(report.readings.length).toBeGreaterThan(0);
  });

  test("register status and thrown kill switches are reported from the config register", async () => {
    const prisma = fixture.memoryPrisma();
    const report = await metrics.derive(
      { prisma },
      {
        shardId: "s1",
        fromMs: 0,
        toMs: 60000,
        registerEntries: [
          { calibrationStatus: "DERIVED", changeClass: "TUNED" },
          { calibrationStatus: "PROVISIONAL", changeClass: "SAFETY" },
        ],
        killSwitches: { deferral: true, batch_solving: false },
      },
    );
    const by = Object.fromEntries(report.readings.map((row) => [row.id, row]));
    expect(by.parameters_by_calibration_status.value).toEqual({ DERIVED: 1, PROVISIONAL: 1 });
    expect(by.safety_class_not_derived.value).toBe(1);
    expect(by.kill_switches_thrown.thrown).toEqual(["deferral"]);
  });
});

describe("§20.1 — the release-gate targets", () => {
  test("every row of §20.1's table is a target, and each names a register entry", () => {
    expect(sli.assertTargets()).toEqual({ ok: true, problems: [] });
    expect(sli.TARGETS.length).toBeGreaterThanOrEqual(20);
  });

  test("exactly two targets bound a safety window, and both are stated at p99.9", () => {
    const safety = sli.TARGETS.filter((target) => target.boundsSafetyWindow);
    expect(safety.map((target) => target.id).sort()).toEqual(["commit_transaction_p999", "decision_to_dispatch_p999"]);
    for (const target of safety) {
      // §20.1: "a p99 target on a quantity that bounds a safety window would be a
      // category error".
      expect(target.statistic).toBe(sli.STATISTIC.P999);
      expect(target.window).toBeTruthy();
    }
  });

  test("the commit target's mean is what §3.5's shard sizing consumes, and it is separate", () => {
    expect(sli.TARGET_BY_ID.commit_transaction_mean.statistic).toBe(sli.STATISTIC.MEAN);
    expect(sli.TARGET_BY_ID.commit_transaction_mean.rationale).toMatch(/shard-sizing bound of §3\.5/);
  });

  test("a target with no observation reports meets: null — an unmeasured target is not a met one", () => {
    const attainment = sli.attainment({ merged: sli.merge([]), config: { get: () => 100 } });
    for (const row of attainment) expect(row.meets).toBeNull();
  });

  test("a bucketed quantile is reported as a lower bound, and says so", () => {
    // 1 % of commits take 500 ms and the rest take 5 ms. A p99 would sit in the fast
    // bucket and report the system healthy; the p99.9 lands in the slow one. That gap is
    // exactly why §20.1 states this target at p99.9: "the transaction that outlives its
    // leadership window is by construction not a typical one".
    const registry = sli.createRegistry();
    for (let index = 0; index < 1000; index += 1) registry.observe("sli.commit_transaction_p999", index < 990 ? 5 : 500);
    for (let index = 0; index < 1000; index += 1) registry.observe("sli.commit_transaction_p99", index < 990 ? 5 : 500);

    const attainment = sli.attainment({ merged: sli.merge([registry.snapshot()]), config: { get: (name) => (name === "perf.commit_transaction_p999" ? 100 : 20) } });

    const tail = attainment.find((row) => row.id === "commit_transaction_p999");
    // A bucketed quantile is a bound, never a value; the answer says which it is rather
    // than letting a dashboard present a bucket edge as a measurement.
    expect(tail.observedIsLowerBound).toBe(true);
    expect(tail.sampleCount).toBe(1000);
    expect(tail.meets).toBe(false);

    const body = attainment.find((row) => row.id === "commit_transaction_p99");
    expect(body.meets).toBe(true);
  });
});

describe("the SLI registry and its advisory Redis tier (§3.3)", () => {
  test("counters, gauges and histograms merge deterministically across processes", () => {
    const one = sli.createRegistry();
    const two = sli.createRegistry();
    one.count("sli.x", 3);
    two.count("sli.x", 4);
    one.gauge("sli.g", 1);
    one.observe("sli.h", 10);
    two.observe("sli.h", 20);

    const merged = sli.merge([one.snapshot(), two.snapshot()]);
    expect(merged.counters["sli.x"]).toBe(7);
    expect(merged.gauges["sli.g"]).toBe(1);
    expect(merged.histograms["sli.h"].count).toBe(2);
    // Merge order must not matter: two workers' snapshots have no defined arrival order.
    expect(sli.merge([two.snapshot(), one.snapshot()]).counters["sli.x"]).toBe(7);
  });

  test("publishing and collecting round-trip through the kv facade", async () => {
    const store = new Map();
    const sets = new Map();
    const kv = {
      async set(key, value) {
        store.set(key, value);
      },
      async sadd(key, member) {
        if (!sets.has(key)) sets.set(key, new Set());
        sets.get(key).add(member);
      },
      async smembers(key) {
        return [...(sets.get(key) || [])];
      },
      async mget(keys) {
        return keys.map((key) => store.get(key) ?? null);
      },
    };

    const registry = sli.createRegistry();
    registry.count("sli.explanation_answers_by_source", 5);
    expect(await sli.publish({ kv }, { shardId: "s1", instanceId: "i1", registry, ttlSeconds: 60 })).toBe(true);

    const collected = await sli.collect({ kv }, "s1");
    expect(collected.instances).toEqual(["i1"]);
    expect(collected.merged.counters["sli.explanation_answers_by_source"]).toBe(5);
  });

  test("a kv failure loses visibility and never throws — the cache-authority rule (§3.3)", async () => {
    const kv = {
      async set() {
        throw new Error("redis down");
      },
      async sadd() {},
      async smembers() {
        throw new Error("redis down");
      },
      async mget() {
        return [];
      },
    };
    expect(await sli.publish({ kv }, { shardId: "s1", instanceId: "i1", registry: sli.createRegistry() })).toBe(false);
    await expect(sli.collect({ kv }, "s1")).resolves.toEqual({ merged: sli.merge([]), instances: [] });
  });

  test("the SLI namespace is the one §21.2 reserves, and holds no decision data", () => {
    expect(sli.KEY.snapshot("s1", "i1")).toBe("engine:sli:s1:i1");
    expect(sli.KEY.instances("s1")).toBe("engine:sli:instances:s1");
  });
});
