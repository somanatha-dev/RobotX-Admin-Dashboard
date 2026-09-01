"use strict";

/**
 * V1 — I20: **a reported optimality gap is a true bound, or it is not reported.**
 *
 * ── The defect these tests exist to keep closed ─────────────────────────────
 * `solve/round.js`'s `candidatesFor` read:
 *
 *     searchGapMilliCU: expansion.achievedGapMilliCU ?? 0n
 *
 * `candidates/expansion.js` sets `achievedGapMilliCU` to **`null`** in exactly two cases,
 * and states at each of them why zero is the wrong value:
 *
 *   · no unexplored floor resolved — *"No floor resolved, so no bound was proven. Saying
 *     'gap 0' here would be the false guarantee §6.4 calls worse than no bound."*
 *   · nothing was priced — *"there is no `C*` to bound a gap against. `0n` here would read
 *     as 'proven optimal' in the decision record."*
 *
 * `?? 0n` converted each of those into **zero — the strongest optimality claim the engine
 * can make** — and pushed it into the `Round` row, the §21.2 decision record, the operator
 * explanation and the §21.4 SLI.
 *
 * ── Why no existing test or invariant caught it ─────────────────────────────
 * `invariantChecker.checkI20` audits decision records for a **combined** gap and for a
 * **negative** gap. A fabricated `0` is neither: the lie is about the number's provenance,
 * not about the number. That is the exact gap this suite fills, and it is why every
 * assertion below is about *provenance* rather than about magnitude.
 *
 * The distinction under test is between two values that are opposites and used to be
 * indistinguishable:
 *
 *   · `0n`   — a gap that was computed and came out at zero: **proven optimal over the
 *              columns generated**;
 *   · `null` — no bound was proven at all.
 */

const round = require("../../src/engine/solve/round");
const expansion = require("../../src/engine/candidates/expansion");
const metrics = require("../../src/engine/observability/metrics");
const fixture = require("./helpers/roundFixture");

const DECISION_TIME_MS = 1_800_000_000_000;

/** An `expandCandidates` that returns exactly the expansion result handed to it. */
function expansionReturning(result) {
  return async () => result;
}

/** The shape `expansion.expandCandidates` returns, with the gap fields overridable. */
function expansionResult(overrides) {
  return {
    ok: true,
    candidates: [{ agentId: "A1", costMilliCU: 1_000n }],
    bestGammaMilliCU: 1_000n,
    achievedGapMilliCU: 0n,
    achievedGapProven: true,
    truncatedBy: null,
    cellsExplored: 3,
    agentsEvaluated: 1,
    problems: [],
    ...overrides,
  };
}

function discover(result) {
  return round.candidatesFor(
    { expandCandidates: expansionReturning(result) },
    { leg: { legId: "L1" }, decisionTimeMs: DECISION_TIME_MS, expansionInput: {} },
  );
}

describe("I20 — an unproven search gap is never reported as zero", () => {
  test("an expansion that proved no bound yields `null`, not `0n`", async () => {
    const discovered = await discover(
      expansionResult({ achievedGapMilliCU: null, achievedGapProven: false, truncatedBy: "wall_clock_budget" }),
    );

    // The defect, stated as the assertion that would have failed:
    expect(discovered.searchGapMilliCU).toBeNull();
    expect(discovered.searchGapMilliCU).not.toBe(0n);
    expect(discovered.searchGapProven).toBe(false);
  });

  test("an expansion that priced nothing yields `null` — there is no `C*` to bound against", async () => {
    const discovered = await discover(
      expansionResult({ candidates: [], bestGammaMilliCU: null, achievedGapMilliCU: null, achievedGapProven: false }),
    );

    expect(discovered.searchGapMilliCU).toBeNull();
    expect(discovered.searchGapProven).toBe(false);
  });

  test("a genuinely proven zero gap survives as `0n` and is marked proven", async () => {
    const discovered = await discover(expansionResult({ achievedGapMilliCU: 0n, achievedGapProven: true }));

    // The opposite fact from the first test, and it must remain distinguishable from it.
    expect(discovered.searchGapMilliCU).toBe(0n);
    expect(discovered.searchGapProven).toBe(true);
  });

  test("a proven non-zero gap is carried through unchanged", async () => {
    const discovered = await discover(expansionResult({ achievedGapMilliCU: 4_250n, achievedGapProven: true }));

    expect(discovered.searchGapMilliCU).toBe(4_250n);
    expect(discovered.searchGapProven).toBe(true);
  });

  test("a bigint gap contradicted by an explicit `achievedGapProven: false` is read as unproven", async () => {
    // The producer's contract says a bigint means proven. If a producer ever states both,
    // the conservative reading is the only defensible one: withhold the claim.
    const discovered = await discover(expansionResult({ achievedGapMilliCU: 900n, achievedGapProven: false }));

    expect(discovered.searchGapMilliCU).toBeNull();
    expect(discovered.searchGapProven).toBe(false);
  });

  test("an expansion result with no `achievedGapProven` field is read from the gap alone", async () => {
    // Backwards compatibility with every caller that predates the flag: `null` means
    // unproven and a bigint means proven, which is the producer's original contract.
    const withoutFlag = expansionResult({ achievedGapMilliCU: 7n });
    delete withoutFlag.achievedGapProven;

    const discovered = await discover(withoutFlag);
    expect(discovered.searchGapMilliCU).toBe(7n);
    expect(discovered.searchGapProven).toBe(true);
  });
});

describe("I20 — the producer contract this depends on", () => {
  test("§6.3's unbounded-search refusal reports `achievedGapMilliCU: null`, never `0n`", async () => {
    // Reached through the real module, not a fixture: tier 2 enabled with neither
    // `candidate.max_radius_by_sla_class` nor a wall-clock budget. `expandCandidates`
    // refuses rather than expanding without limit, and it must not claim a bound while
    // doing so.
    const refused = await expansion.expandCandidates({
      originLat: 12.9716,
      originLon: 77.5946,
      maxExpansionTiers: expansion.TIER.KRING,
    });

    expect(refused.ok).toBe(false);
    expect(refused.truncatedBy).toBe("unbounded_search_refused");
    expect(refused.achievedGapMilliCU).toBeNull();
    expect(refused.achievedGapProven).toBe(false);

    // And the round must carry that null rather than absorbing it.
    const discovered = await discover(refused);
    expect(discovered.searchGapMilliCU).toBeNull();
    expect(discovered.searchGapProven).toBe(false);
  });
});

describe("I20 — the round's own gap is a bound only if every Leg contributed one", () => {
  /**
   * `finish()` is reached through `plan()`, and `plan()`'s exits that do not need a solve
   * are the cleanest place to assert the aggregate: a regime that cannot be solved still
   * produces a complete result with the round's two gaps on it.
   */
  function planWith(perLegExpansions) {
    const queue = [...perLegExpansions];
    return round.plan(
      {
        expandCandidates: async () => queue.shift(),
        pricedCandidateFor: () => null, // no columns ⇒ the regime is unsolvable ⇒ finish()
        planState: null,
      },
      {
        roundId: "r1",
        shardId: "s1",
        decisionTimeMs: DECISION_TIME_MS,
        legs: perLegExpansions.map((_, index) => ({ legId: `L${index + 1}`, priority: 0 })),
        config: {},
        killSwitches: {},
      },
    );
  }

  test("every Leg proven ⇒ the round reports a summed bigint and `searchGapProven: true`", async () => {
    const result = await planWith([
      expansionResult({ achievedGapMilliCU: 100n, achievedGapProven: true }),
      expansionResult({ achievedGapMilliCU: 250n, achievedGapProven: true }),
    ]);

    expect(result.searchGapMilliCU).toBe(350n);
    expect(result.searchGapProven).toBe(true);
  });

  test("ONE unproven Leg ⇒ the round reports `null`, not the sum of the rest", async () => {
    const result = await planWith([
      expansionResult({ achievedGapMilliCU: 100n, achievedGapProven: true }),
      expansionResult({ achievedGapMilliCU: null, achievedGapProven: false }),
    ]);

    // A sum over `n − 1` proven bounds and one unproven contribution bounds nothing, and
    // `100n` here would be a smaller number than the truth presented as a guarantee.
    expect(result.searchGapMilliCU).toBeNull();
    expect(result.searchGapProven).toBe(false);
    expect(result.searchGapMilliCU).not.toBe(100n);
  });

  test("the per-Leg record carries the same provenance the round does", async () => {
    const result = await planWith([expansionResult({ achievedGapMilliCU: null, achievedGapProven: false })]);

    const row = result.decisions.find((entry) => entry.legId === "L1");
    expect(row.searchGapMilliCU).toBeNull();
    expect(row.searchGapProven).toBe(false);
  });

  test("an empty batch is proven vacuously — no Leg means no candidate set was truncated", async () => {
    const result = await planWith([]);

    expect(result.searchGapMilliCU).toBe(0n);
    expect(result.searchGapProven).toBe(true);
  });

  test("the two gaps are still reported separately, and no combined field appears", async () => {
    const result = await planWith([expansionResult({ achievedGapMilliCU: null, achievedGapProven: false })]);

    expect(result).toHaveProperty("searchGapMilliCU");
    expect(result).toHaveProperty("lpIpGapMilliCU");
    expect(Object.keys(result).filter((key) => /combined|total.*gap/i.test(key))).toEqual([]);
  });
});

describe("I20 — the §21.4 SLI excludes rounds that proved no bound", () => {
  async function searchGapReading(rounds) {
    const prisma = fixture.memoryPrisma();
    prisma.__tables.rounds.push(
      ...rounds.map((row, index) => ({
        roundId: `r${index + 1}`,
        shardId: "s1",
        decisionTime: new Date(1000),
        regime: "SINGLETON",
        budgets: { budgetLimited: false },
        lpIpGapMilliCU: "0",
        ...row,
      })),
    );

    const report = await metrics.derive(
      { prisma },
      { shardId: "s1", fromMs: 0, toMs: 60_000, config: { get: () => 5000 } },
    );
    return Object.fromEntries(report.readings.map((row) => [row.id, row])).search_gap;
  }

  test("a window in which nothing was proven reads `null`, not a median of zero", async () => {
    const reading = await searchGapReading([{ searchGapMilliCU: null }, { searchGapMilliCU: null }]);

    // `BigInt(row.searchGapMilliCU || "0")` used to make this `"0"` — the most reassuring
    // number available, published as an SLI for a window that proved nothing.
    expect(reading.value).toBeNull();
    expect(reading.roundsWithProvenGap).toBe(0);
    expect(reading.roundsWithoutProvenGap).toBe(2);
  });

  test("unproven rounds are excluded from the median rather than counted as zero", async () => {
    const reading = await searchGapReading([
      { searchGapMilliCU: "500" },
      { searchGapMilliCU: null },
      { searchGapMilliCU: "700" },
    ]);

    // Median over {500, 700} is 700 (upper of two). Had the null been folded in as 0 the
    // set would be {0, 500, 700} and the median 500 — a materially better-looking figure
    // produced by counting an absence as a success.
    expect(reading.value).toBe("700");
    expect(reading.roundsWithProvenGap).toBe(2);
    expect(reading.roundsWithoutProvenGap).toBe(1);
  });
});
