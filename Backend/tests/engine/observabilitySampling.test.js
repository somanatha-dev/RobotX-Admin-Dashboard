"use strict";

/**
 * Engine lane — Phase 11: deterministic Tier B sampling, the **bounded** exemption list,
 * the write budget, and the reservoir fallback (§21.2).
 *
 * The exemption bound is the correction §21.2 says "makes the scheme survive an
 * incident", so it gets the most tests here: a shard-wide degraded mode must not turn
 * sampling into full retention at exactly the moment volume spikes hardest.
 */

const sampling = require("../../src/engine/observability/sampling");

describe("§21.2 — the draw is deterministic, seeded from the decision id", () => {
  test("the same decision id yields the same draw, every time", () => {
    for (const id of ["shard-a:1:L1", "shard-b:99:L7", ""]) {
      expect(sampling.draw(id)).toBe(sampling.draw(id));
      expect(sampling.reproducibility(id, 0.01).ok).toBe(true);
    }
  });

  test("the draw is in [0, 1) and spreads roughly uniformly", () => {
    const draws = Array.from({ length: 20000 }, (unused, index) => sampling.draw(`shard-a:1770000000000:LEG-${index}`));
    expect(Math.min(...draws)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...draws)).toBeLessThan(1);
    // Uniformity is what makes a rate mean what it says: a 1 % rate must retain ~1 %.
    const sampled = draws.filter((value) => value < 0.01).length;
    expect(sampled / draws.length).toBeGreaterThan(0.006);
    expect(sampled / draws.length).toBeLessThan(0.016);
  });

  test("the sample is representative over ONE ROUND'S BATCH, not only asymptotically", () => {
    // A regression test for a measured defect. FNV-1a alone is asymptotically uniform
    // but avalanches weakly on short, nearly-identical inputs: over 200 sequentially
    // numbered decision ids — the shape of one round's batch — a 10 % rate retained
    // **zero**, because neighbouring ids produced neighbouring hashes and the whole
    // batch fell on one side of the threshold.
    //
    // That matters because §21.2's sample must be representative of the *population*:
    // a sampler that retains none of one round and all of the next produces a biased
    // Tier B, and the bias is invisible in the aggregate counts (exact by construction)
    // exactly where it would mislead most.
    for (const family of [
      (index) => `shard-a:1:L${index}`,
      (index) => `r1:L${index}`,
      (index) => `shard-a:1770000000000:LEG-${index}`,
    ]) {
      const batch = Array.from({ length: 200 }, (unused, index) => family(index));
      const retained = batch.filter((id) => sampling.isSampled(id, 0.1)).length;
      // 20 expected; a generous band, and the pre-fix behaviour (0, 1, 10) fails it.
      expect({ family: family(0), retained }).toEqual({ family: family(0), retained: expect.any(Number) });
      expect(retained).toBeGreaterThanOrEqual(12);
      expect(retained).toBeLessThanOrEqual(30);
    }
  });

  test("the avalanche is a bijection — it redistributes, and adds no collisions", () => {
    const seen = new Set();
    for (let index = 0; index < 5000; index += 1) seen.add(sampling.avalanche(index));
    expect(seen.size).toBe(5000);
    // Deterministic, like everything else in the sampler.
    expect(sampling.avalanche(12345)).toBe(sampling.avalanche(12345));
  });

  test("the rate is honoured at its two endpoints exactly", () => {
    expect(sampling.isSampled("anything", 0)).toBe(false);
    expect(sampling.isSampled("anything", 1)).toBe(true);
    // A malformed rate never silently retains everything.
    expect(sampling.isSampled("anything", undefined)).toBe(false);
    expect(sampling.isSampled("anything", Number.NaN)).toBe(false);
  });

  test("no clock and no randomness — sampling is replayable across processes", () => {
    const fs = require("fs");
    const path = require("path");
    const source = fs.readFileSync(path.join(__dirname, "..", "..", "src", "engine", "observability", "sampling.js"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    // A sampler that read a clock or a random source would retain a different
    // population on replay, and §24.3's gate would compare two different things.
    expect(code).not.toMatch(/Math\.random/);
    expect(code).not.toMatch(/Date\.now/);
  });
});

describe("§21.2 — the exemption list is BOUNDED", () => {
  test("a decision-specific degradation exempts", () => {
    const verdict = sampling.classifyExemption({
      degradations: [{ scope: sampling.DEGRADATION_SCOPE.DECISION, reason: "this candidate's telemetry is stale" }],
    });
    expect(verdict.exempt).toBe(true);
    expect(verdict.reasons).toEqual([sampling.EXEMPTION.AT_DECISION.DEGRADED]);
  });

  test("a SHARD-WIDE degraded mode does NOT exempt — it is recorded once, at mode level", () => {
    const verdict = sampling.classifyExemption({
      degradations: [{ scope: sampling.DEGRADATION_SCOPE.SHARD, mode: "DEGRADED_ROUTING" }],
    });
    // This is the correction §21.2 says makes the scheme survive an incident: an
    // unbounded exemption "converts to full retention across the entire shard at exactly
    // the moment volume spikes hardest, which is the opposite of what a sampling scheme
    // is for".
    expect(verdict.exempt).toBe(false);
    expect(verdict.shardWideRefused).toEqual([{ mode: "DEGRADED_ROUTING", reason: null, recordedAt: "MODE_LEVEL" }]);
    expect(verdict.why).toMatch(/recorded once at the mode level/);
  });

  test("a shard-wide mode does not suppress a decision-specific exemption alongside it", () => {
    const verdict = sampling.classifyExemption({
      degradations: [
        { scope: sampling.DEGRADATION_SCOPE.SHARD, mode: "COLD_INDEX" },
        { scope: sampling.DEGRADATION_SCOPE.DECISION, reason: "stale observation" },
      ],
    });
    expect(verdict.exempt).toBe(true);
    expect(verdict.shardWideRefused).toHaveLength(1);
  });

  test("relaxed, overridden, and preempted each exempt on their own", () => {
    expect(sampling.classifyExemption({ relaxed: true }).reasons).toEqual(["RELAXED"]);
    expect(sampling.classifyExemption({ overridden: true }).reasons).toEqual(["OVERRIDDEN"]);
    expect(sampling.classifyExemption({ preempted: true }).reasons).toEqual(["PREEMPTED"]);
  });

  test("the three LATER reasons are separated from the four AT_DECISION ones", () => {
    // §21.2: "Records exempted for a *later* reason — reassigned, failed, disputed —
    // cannot be written retroactively if Tier B was not captured."
    // Copied before sorting: both lists are frozen, which is the module refusing to let
    // a caller reorder the vocabulary the schema CHECK is written against.
    expect([...sampling.LATER_REASONS].sort()).toEqual(["DISPUTED", "FAILED", "REASSIGNED"]);
    expect([...sampling.AT_DECISION_REASONS].sort()).toEqual(["DEGRADED", "OVERRIDDEN", "PREEMPTED", "RELAXED"]);
    for (const reason of sampling.LATER_REASONS) expect(sampling.isLaterReason(reason)).toBe(true);
    for (const reason of sampling.AT_DECISION_REASONS) expect(sampling.isLaterReason(reason)).toBe(false);
  });
});

describe("§21.2 — the write budget, the reservoir, and counted shedding", () => {
  const offer = (budget, index, options) =>
    budget.offer({
      shardId: "shard-a",
      decisionId: `shard-a:1770000000000:LEG-${index}`,
      nowMs: 1770000000000,
      sampleRate: 0,
      exempt: true,
      exemptionReasons: ["DEGRADED"],
      payload: { decisionId: `shard-a:1770000000000:LEG-${index}`, candidates: [] },
      ...(options || {}),
    });

  test("exempt writes draw on the budget, and the sample never does", () => {
    const budget = sampling.createBudget({ writeBudgetPerMinute: 3, reservoirSize: 2 });

    // A sampled decision is not charged to the exemption budget: charging it would let a
    // degraded episode starve the representative sample every aggregate is computed on.
    for (let index = 0; index < 5; index += 1) {
      expect(offer(budget, index, { sampleRate: 1, exempt: false }).verdict).toBe(sampling.VERDICT.SAMPLED);
    }
    expect(budget.counters("shard-a").spent).toBe(0);

    expect(offer(budget, 100).verdict).toBe(sampling.VERDICT.EXEMPT);
    expect(budget.counters("shard-a").spent).toBe(1);
  });

  test("past the budget, exempt decisions fall to the reservoir, then are shed and counted", () => {
    const budget = sampling.createBudget({ writeBudgetPerMinute: 2, reservoirSize: 2 });

    const verdicts = Array.from({ length: 40 }, (unused, index) => offer(budget, index).verdict);

    expect(verdicts.filter((verdict) => verdict === sampling.VERDICT.EXEMPT)).toHaveLength(2);
    expect(verdicts.filter((verdict) => verdict === sampling.VERDICT.RESERVOIR).length).toBeGreaterThan(0);
    expect(verdicts.filter((verdict) => verdict === sampling.VERDICT.SHED).length).toBeGreaterThan(0);

    const counters = budget.counters("shard-a");
    // "The shedding is itself recorded as a counted event." Not silent.
    expect(counters.shed).toBeGreaterThan(0);
    expect(counters.exemptOffered).toBe(40);
    expect(counters.reservoirHeld).toBe(2);
  });

  test("the reservoir is uniform over the exempt population and INDEPENDENT of arrival order", () => {
    const ids = Array.from({ length: 60 }, (unused, index) => `shard-a:1770000000000:LEG-${index}`);

    const fill = (order) => {
      const budget = sampling.createBudget({ writeBudgetPerMinute: 0, reservoirSize: 5 });
      for (const id of order) {
        budget.offer({ shardId: "shard-a", decisionId: id, nowMs: 1, sampleRate: 0, exempt: true, exemptionReasons: ["DEGRADED"], payload: { decisionId: id } });
      }
      return budget.drain("shard-a").reservoir.map((row) => row.decisionId).sort();
    };

    // Bottom-k over the deterministic draw. §21.2 wants "a reservoir sample of Tier B
    // that is uniform over the exempt population"; order-independence is what makes a
    // shed episode reproducible after the fact rather than a story about scheduling.
    expect(fill(ids)).toEqual(fill([...ids].reverse()));
    expect(fill(ids)).toHaveLength(5);
  });

  test("the reservoir holds the five smallest draws — which is what uniform means here", () => {
    const ids = Array.from({ length: 60 }, (unused, index) => `shard-a:1770000000000:LEG-${index}`);
    const budget = sampling.createBudget({ writeBudgetPerMinute: 0, reservoirSize: 5 });
    for (const id of ids) {
      budget.offer({ shardId: "shard-a", decisionId: id, nowMs: 1, sampleRate: 0, exempt: true, exemptionReasons: ["DEGRADED"], payload: { decisionId: id } });
    }
    const held = budget.drain("shard-a").reservoir.map((row) => row.decisionId);
    const expected = [...ids].sort((a, b) => sampling.draw(a) - sampling.draw(b)).slice(0, 5);
    expect(held.sort()).toEqual(expected.sort());
  });

  test("the budget window is a minute, and it rolls", () => {
    expect(sampling.BUDGET_WINDOW_MS).toBe(60000);
    const budget = sampling.createBudget({ writeBudgetPerMinute: 1, reservoirSize: 1 });

    expect(offer(budget, 1, { nowMs: 0 }).verdict).toBe(sampling.VERDICT.EXEMPT);
    expect(offer(budget, 2, { nowMs: 0 }).verdict).not.toBe(sampling.VERDICT.EXEMPT);
    // A new minute restores the budget.
    expect(offer(budget, 3, { nowMs: 60000 }).verdict).toBe(sampling.VERDICT.EXEMPT);
  });

  test("a decision that is neither sampled nor exempt says so, and says it is not lost", () => {
    const budget = sampling.createBudget({ writeBudgetPerMinute: 10, reservoirSize: 5 });
    const verdict = offer(budget, 1, { exempt: false, sampleRate: 0 });
    expect(verdict.verdict).toBe(sampling.VERDICT.NOT_SELECTED);
    expect(verdict.note).toMatch(/replay|RECONSTRUCTED/);
  });

  test("budgets are per shard — one shard's incident does not consume another's", () => {
    const budget = sampling.createBudget({ writeBudgetPerMinute: 1, reservoirSize: 1 });
    budget.offer({ shardId: "shard-a", decisionId: "a:1:L1", nowMs: 0, sampleRate: 0, exempt: true, exemptionReasons: ["DEGRADED"] });
    budget.offer({ shardId: "shard-a", decisionId: "a:1:L2", nowMs: 0, sampleRate: 0, exempt: true, exemptionReasons: ["DEGRADED"] });

    const other = budget.offer({ shardId: "shard-b", decisionId: "b:1:L1", nowMs: 0, sampleRate: 0, exempt: true, exemptionReasons: ["DEGRADED"] });
    expect(other.verdict).toBe(sampling.VERDICT.EXEMPT);
    expect(budget.shardIds()).toEqual(["shard-a", "shard-b"]);
  });
});
