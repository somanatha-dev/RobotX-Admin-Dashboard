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

  test("a SHADOW decision's Tier B row does not enter tier_b_write_rate", async () => {
    // `PHASE_11_INDEPENDENT_VERIFICATION.md` Finding 2. `DecisionRecordB` has no
    // `shadowLabel` of its own, so the guard every `decisionRecordA` query carried had no
    // equivalent here and the SLI counted decisions the fleet never executed against
    // `observability.tier_b_write_budget` — the one thing §21.6 says shadow mode must
    // never cause ("recorded and never executed").
    const prisma = fixture.memoryPrisma();

    prisma.__tables.decisionRecords.push(
      { decisionId: "r1:L1", shardId: "s1", decisionTime: new Date(1000), outcome: { outcome: "ASSIGNED" }, shadowLabel: null },
      { decisionId: "shadow:cand-a:r1:L1", shardId: "s1", decisionTime: new Date(1000), outcome: { outcome: "ASSIGNED" }, shadowLabel: "cand-a" },
    );
    prisma.__tables.tierBRecords.push(
      { decisionId: "r1:L1", shardId: "s1", decisionTime: new Date(1000), writtenBecause: "SAMPLED" },
      { decisionId: "shadow:cand-a:r1:L1", shardId: "s1", decisionTime: new Date(1000), writtenBecause: "SAMPLED" },
    );

    const report = await metrics.derive({ prisma }, { shardId: "s1", fromMs: 0, toMs: 60000, config: { get: () => 5000 } });
    const by = Object.fromEntries(report.readings.map((row) => [row.id, row]));

    // One production Tier A and one production Tier B. Two of each are in the store.
    expect(by.tier_a_write_rate.count).toBe(1);
    expect(by.tier_b_write_rate.value).toBe(1);
    expect(by.tier_b_write_rate.byWrittenBecause).toEqual({ SAMPLED: 1 });
  });

  test("the unfiltered query the fix replaced would have counted the shadow row — the leak is real, not theoretical", async () => {
    // Guards against the fix being "correct" only because the double cannot express the
    // filter: run the *old* query shape against the same store and show it double-counts.
    const prisma = fixture.memoryPrisma();
    prisma.__tables.decisionRecords.push(
      { decisionId: "r1:L1", shardId: "s1", decisionTime: new Date(1000), shadowLabel: null },
      { decisionId: "shadow:cand-a:r1:L1", shardId: "s1", decisionTime: new Date(1000), shadowLabel: "cand-a" },
    );
    prisma.__tables.tierBRecords.push(
      { decisionId: "r1:L1", shardId: "s1", decisionTime: new Date(1000), writtenBecause: "SAMPLED" },
      { decisionId: "shadow:cand-a:r1:L1", shardId: "s1", decisionTime: new Date(1000), writtenBecause: "SAMPLED" },
    );

    const unfiltered = await prisma.decisionRecordB.groupBy({
      by: ["writtenBecause"],
      where: { shardId: "s1", decisionTime: { gte: new Date(0), lt: new Date(60000) } },
      _count: { _all: true },
    });
    const filtered = await prisma.decisionRecordB.groupBy({
      by: ["writtenBecause"],
      where: { shardId: "s1", decisionTime: { gte: new Date(0), lt: new Date(60000) }, decision: { shadowLabel: null } },
      _count: { _all: true },
    });

    expect(unfiltered[0]._count._all).toBe(2);
    expect(filtered[0]._count._all).toBe(1);
  });

  test("the two counterfactual gaps are read back from the registry, not left null for ever", async () => {
    // Finding 3, and the sibling it did not name. Both are published with `registry.gauge`
    // by `counterfactual.worker.js`; the old readback scanned `snapshot.counters` only, so
    // adding the key to that allowlist — the finding's own recommendation — would still
    // have produced `null`.
    const prisma = fixture.memoryPrisma();
    const registry = sli.createRegistry();
    registry.gauge("sli.column_generation_gap", 4200, { shardId: "s1" });
    registry.gauge("sli.counterfactual_regret", 1700, { shardId: "s1" });

    const report = await metrics.derive({ prisma }, { shardId: "s1", fromMs: 0, toMs: 60000, registry });
    const by = Object.fromEntries(report.readings.map((row) => [row.id, row]));

    expect(by.column_generation_gap).toBeDefined();
    expect(by.column_generation_gap.instrument).toBe("gauges");
    expect(Object.values(by.column_generation_gap.value)).toEqual([4200]);
    expect(Object.values(by.counterfactual_regret.value)).toEqual([1700]);

    // Still four distinct quantities, never one. §9.3, §21.6, §21.2.
    expect(by.column_generation_gap.id).not.toBe(by.search_gap && by.search_gap.id);
    expect(metrics.METRIC_BY_ID.column_generation_gap.note).toMatch(/Distinct from `search_gap`/);
  });

  test("every registry-backed metric is read back from whichever instrument produced it", () => {
    // The defect class, pinned: a producer writing a gauge and a readback scanning counters.
    const snapshot = { counters: { "sli.a": 1 }, gauges: { "sli.b|{\"x\":1}": 2 }, histograms: { "sli.c": { count: 3 } } };
    expect(metrics.readBackSeries(snapshot, "a").instrument).toBe("counters");
    expect(metrics.readBackSeries(snapshot, "b").instrument).toBe("gauges");
    expect(metrics.readBackSeries(snapshot, "c").instrument).toBe("histograms");
    // Nothing published is null, never zero and never `{}`.
    expect(metrics.readBackSeries(snapshot, "d")).toBeNull();
  });

  test("a metric whose producer HAS landed says so, instead of blaming a future phase", async () => {
    // Finding 5. Phases 4, 6 and 7 shipped the mechanisms behind these; what is missing is
    // a query, and a reader who cannot tell the two apart defers the wiring to a phase
    // that has no reason to do it.
    const prisma = fixture.memoryPrisma();
    const report = await metrics.derive({ prisma }, { shardId: "s1", fromMs: 0, toMs: 60000 });
    const un = Object.fromEntries(report.unavailable.map((row) => [row.id, row]));

    for (const id of ["fence_rejections_commitment_scope", "fence_rejections_agent_scope", "near_miss_margins", "indeterminate_rate"]) {
      expect(un[id].producerLanded).toBe(true);
      expect(un[id].unavailableBecause).toMatch(/the producer has landed/);
      expect(un[id].unavailableBecause).not.toMatch(/no producer has landed yet/);
    }

    // And the genuinely-unlanded ones still say exactly that. `duty_cycle_gini`'s producer is
    // §17.2's regulariser, which is a Tier 2 mechanism no phase has shipped.
    expect(un.duty_cycle_gini.producerLanded).toBe(false);
    expect(un.duty_cycle_gini.unavailableBecause).toMatch(/no producer has landed yet/);

    // ── PHASE 12 REMEDIATION ────────────────────────────────────────────────────
    // `invariant_violations` used to be asserted here as "no producer has landed yet — Phase
    // 12 invariant checker". That was true when this test was written and stopped being true
    // when Phase 12 landed `InvariantStatus` and the worker that fills it. Leaving the
    // assertion would have pinned a stale schedule fact in place — the same failure mode this
    // very test was written to catch, in the opposite direction — so the metric is now derived
    // and asserted as derived.
    expect(un.invariant_violations).toBeUndefined();

    // The wiring-debt list may not name a metric the registry does not declare, and may
    // not name one `derive()` actually produces.
    const produced = new Set(report.readings.map((row) => row.id));
    for (const id of metrics.PRODUCER_LANDED_QUERY_NOT_WIRED) {
      expect(metrics.METRIC_BY_ID[id]).toBeDefined();
      expect(produced.has(id)).toBe(false);
    }
    expect(metrics.assertCoverage().problems).toEqual([]);

    // The three §18.5/§26.1 SLIs Phase 12's own sections name are derived, not declared:
    // "time spent in each mode is an SLI", the violation count "whose target is exactly zero",
    // and the suspension that outlives its box.
    for (const id of ["invariant_violations", "degraded_mode_time", "suspensions_over_time_box"]) {
      expect(produced.has(id)).toBe(true);
    }
  });

  test("PHASE 12 — the mode, violation and stranding SLIs are read from the durable rows", async () => {
    // Not "the query exists": the query is driven against rows and the numbers are checked.
    const prisma = fixture.memoryPrisma();
    const now = 1770000000000;

    // One mode exited inside the window, one still open — an SLI that counted only exited
    // modes would read zero for the whole of an outage and tell the truth once it was over.
    prisma.__tables.degradedModeEvents.push(
      {
        shardId: "s1", mode: "COLD_INDEX", cause: "B3", enteredAt: new Date(now - 300000),
        exitedAt: new Date(now - 60000), durationMs: 240000, suspendedInvariants: [], timeBoxExpiresAt: null,
      },
      {
        shardId: "s1", mode: "CUSTODIAL_OPERATION", cause: "B1", enteredAt: new Date(now - 120000),
        exitedAt: null, durationMs: null, suspendedInvariants: ["I2"],
        // Past its box, and it suspends something: §26.1's alertable suspension.
        timeBoxExpiresAt: new Date(now - 30000),
      },
    );

    prisma.__tables.invariantStatuses.push(
      { invariantId: "I1", shardId: "s1", subjectType: "SHARD", status: "VIOLATED", violationCount: 3, checkedAt: new Date(now - 1000) },
      // A suspended row's findings must not enter a zero-target SLI.
      { invariantId: "I2", shardId: "s1", subjectType: "SHARD", status: "SUSPENDED", violationCount: 9, checkedAt: new Date(now - 1000) },
      { invariantId: "I3", shardId: "s1", subjectType: "SHARD", status: "ENFORCED", violationCount: 0, checkedAt: new Date(now - 1000) },
    );

    prisma.__tables.legRows.push(
      { id: "l1", state: "STRANDED_OBSTRUCTING", obstructionClass: "BLOCKING_CRITICAL" },
      { id: "l2", state: "STRANDED_SAFE", obstructionClass: "CLEAR" },
      { id: "l3", state: "STRANDED_SAFE", obstructionClass: "CLEAR" },
    );

    prisma.__tables.externalEscalations.push({
      legId: "l1", step: 1, obstructionClass: "BLOCKING_CRITICAL", disposition: "EMITTED",
      occurredAt: new Date(now - 200000), clearedAt: new Date(now - 100000),
    });

    const report = await metrics.derive({ prisma }, { shardId: "s1", fromMs: now - 600000, toMs: now });
    const by = Object.fromEntries(report.readings.map((row) => [row.id, row]));

    expect(by.degraded_mode_time.value["COLD_INDEX|B3"]).toBe(240);
    expect(by.degraded_mode_time.value["CUSTODIAL_OPERATION|B1"]).toBe(120);
    expect(by.degraded_mode_time.extra || by.degraded_mode_time.openModes).toBe(1);

    expect(by.suspensions_over_time_box.value).toEqual({ "CUSTODIAL_OPERATION|I2": 1 });
    expect(by.suspensions_over_time_box.alertable).toBe(true);

    expect(by.invariant_violations.value).toEqual({ I1: 3 });
    expect(by.invariant_violations.total).toBe(3);
    expect(by.invariant_violations.suspended).toEqual(["I2"]);
    // Three of twenty-two reported is not a green register, and the reading says so.
    expect(by.invariant_violations.complete).toBe(false);

    expect(by.stranding_events_by_obstruction_class.value).toEqual({ BLOCKING_CRITICAL: 1, CLEAR: 2 });
    expect(by.stranding_response_time.value.BLOCKING_CRITICAL).toBe(100);
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
