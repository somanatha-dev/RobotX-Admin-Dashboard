"use strict";

/**
 * §24.6 — round time versus batch size and candidate count, and §20.2's complexity claims
 * turned into measured exponents.
 *
 * > Round time versus shard size, candidate count, and batch size, measured against §20.1.
 *
 * ── What is asserted, and what is only recorded ────────────────────────────
 * The assertions are on **scaling exponents**, not on wall-clock milliseconds. §20.2 states
 * the intended complexity of each stage, and an exponent is the machine-independent form of
 * that claim: an accidental cubic shows up as an exponent near 3 on a laptop and on a CI
 * runner alike, whereas a 250 ms assertion is flaky on one and vacuous on the other. A
 * release gate that is routinely re-run until green is not a gate.
 *
 * Absolute latency is **recorded**, with its provenance attached, because a gate discharged
 * by a number nobody wrote down is not discharged.
 *
 * ── PHASE 15 FINDING — the singleton solve was quadratic in batch size ─────
 * This suite's first run produced a finding, and it is kept here rather than deleted now
 * that it has been acted on, because the bounds below are what stop it recurring.
 *
 * §20.2's complexity table says of the singleton regime:
 *
 * > **Solve — singleton regime** | O(m · k · log) typical for min-cost flow **with cost
 * > scaling**; worst case polynomial
 *
 * The shipped solver was **successive shortest paths with Johnson potentials** — its own
 * header said so — not a cost-scaling algorithm. SSP augments once per Leg and each
 * augmentation is a Dijkstra over the whole network, giving O(m · E log V) = O(m² · k · log).
 * The measured exponents matched that prediction exactly: ≈ 2 in Legs and ≈ 0.65 in
 * candidates, at r² > 0.99.
 *
 * The consequence was a §20.1 gap: the round-wall-clock target is "500 Legs × 200 candidates
 * < 250 ms", and the shipped solver needed 23.5 s at that shape on this machine — 94× over.
 *
 * ── PHASE 15 ADDENDUM — the finding was measured through a second bottleneck ──
 * The 500 × 200 shape was never measured here, only inferred from 500 × 10, and the reason
 * given was that the full instance "takes minutes to build and solve". Most of the *build*
 * half of that was `objective.buildInstance` re-scanning all 100 000 columns once per
 * coverage row and once per exclusivity row — O((legs + agents) · columns) to fill a matrix
 * with 200 000 non-zeros. Grouping the columns once removed it, which left instance
 * construction at ~1 % of the round and the solver at ~99 %: the gap was entirely the
 * solver's, and §20.2's "min-cost flow **with cost scaling**" was the thing that was missing.
 *
 * ── PHASE 10 REOPENED — the missing algorithm, implemented and measured ────
 * `solve/costScaling.js` is now that algorithm: Goldberg–Tarjan push-relabel with ε-scaling,
 * dispatched by `solve/minCostFlow.js`, which retains the successive-shortest-path solver as
 * a test oracle and as the exact fallback for instances whose costs are too wide for exact
 * scaled-integer arithmetic.
 *
 * Measured on the build machine (Node v22.17.0, standalone process, single run at the full
 * shape and median-of-5 for the fits):
 *
 * ```
 *                             SSP          cost scaling
 *   500 × 200 solve       23 536 ms            345 ms      68× faster
 *   250 × 200 solve        6 148 ms            115 ms
 *   100 × 200 solve          836 ms             76 ms
 *   exponent in Legs         2.089              1.154      r² 1.0000 → 0.978
 *   exponent in candidates   0.667              0.719
 * ```
 *
 * The exponent in Legs is what the two tests below assert, because it is the
 * machine-independent form of the claim: ≈ 1 is the regime §20.2 describes and ≈ 2 is the
 * one it does not. The absolute figures are recorded, not gated — see `scaleHarness.js` on
 * why, and §13 of `PHASE_10_COST_SCALING_IMPLEMENTATION_REPORT.md` for what remains between
 * this and a §20.1 PASS, which is a run on representative hardware rather than more code.
 */

const objective = require("../../src/engine/solve/objective");
const minCostFlow = require("../../src/engine/solve/minCostFlow");
const sli = require("../../src/engine/observability/sli");
const service = require("../../src/engine/config/service");
const fixture = require("../engine/helpers/roundFixture");
const harness = require("./helpers/scaleHarness");

/**
 * Batch sizes the round is measured across. Doubled from `[25, 50, 100, 200]` when the solver
 * became ≈ 15× faster: the old grid now runs in 1.7–19 ms, and a power-law fit over
 * single-digit milliseconds on a machine with a garbage collector measures the runtime rather
 * than the algorithm. The grid is what keeps the exponent a measurement.
 * @structural the measurement grid
 */
const BATCH_SIZES = Object.freeze([50, 100, 200, 400]);

/** Candidates per Leg the round is measured across. @structural the measurement grid */
const CANDIDATE_COUNTS = Object.freeze([10, 20, 40, 80]);

/**
 * Candidates held fixed while the batch size varies.
 *
 * ── Why 80 and not 20 ──────────────────────────────────────────────────────
 * Raised from 20 after the batch-size fit was observed failing its own bound on unchanged,
 * correct code — 1.633 and 1.754 against a bound of 1.6, in 2 of 5 runs of the **whole scale
 * lane**, while the same file run alone measured 1.20–1.27 every time. The exponent was not
 * moving because the solver had changed; it was moving because the fit's smallest point,
 * 50 Legs × 20 candidates, solves in ~3 ms on a bare process and the lane's earlier suites
 * leave a heap on which a single collection pause is a large fraction of that. The median of
 * five 3 ms trials is not a measurement of the algorithm, which is the failure mode this
 * file's header already names — the grid was doubled once for exactly this reason and the
 * floor was still too low.
 *
 * Widening the candidate set rather than the batch raises every point's absolute time without
 * leaving the configured envelope: 400 Legs is inside `solve.max_legs_per_round` (500) and 80
 * candidates is inside `candidate.max_evaluated` (200), and 80 is nearer §20.1's own 200 than
 * 20 was. Measured effect on this machine, 8 repeats of the fit at each setting:
 *
 * ```
 *   @20 candidates   exponent 1.262 – 1.521   spread 0.259   r² ≥ 0.981   points   3– 50 ms
 *   @80 candidates   exponent 1.225 – 1.301   spread 0.076   r² ≥ 0.995   points   7–101 ms
 * ```
 *
 * The bound below is unchanged at 1.6, and it still separates the two regimes it was chosen to
 * separate: successive shortest paths measures 2.134 on this same grid at 80 candidates
 * (r² = 0.9996), against 2.067 at 20. The fit got quieter; the gate did not get weaker.
 * @structural the measurement grid
 */
const BATCH_FIT_CANDIDATES = 80;

/** Legs held fixed while the candidate count varies. @structural the measurement grid */
const CANDIDATE_FIT_LEGS = 60;

/**
 * `buildInstance`'s input for a solvable singleton-regime round: `legs` Legs, each with
 * `candidates` agent options, costs spread so the optimum is not the arrival order.
 *
 * One branded plan is shared by every column. Branding runs the real feasibility gate, and
 * at the 100 000-column shape doing it per column measures the fixture rather than the
 * thing under test. `buildInstance` asserts the brand on every column regardless (T1/I14),
 * so the assertion loop it is timed on is still the full one.
 */
function inputAt(legs, candidates) {
  const plan = fixture.brandedPlan();
  const legIds = Array.from({ length: legs }, (unused, index) => `L${index}`);
  const columns = [];
  for (let leg = 0; leg < legs; leg += 1) {
    for (let candidate = 0; candidate < candidates; candidate += 1) {
      columns.push(
        fixture.column({
          legId: `L${leg}`,
          agentId: `A${(leg + candidate) % (legs + candidates)}`,
          // Deterministic but not monotone in arrival order, so the solve has real work to
          // do rather than confirming the first column it sees.
          gammaCu: 10 + ((leg * 7 + candidate * 13) % 97),
          plan,
        }),
      );
    }
  }
  return { legs: fixture.legs(legIds), columns, deferralEnabled: false };
}

/** The built instance for that round, for the tests that measure the solve. */
function instanceOf(legs, candidates) {
  const built = objective.buildInstance(inputAt(legs, candidates));
  if (!built.ok) throw new Error(`instance did not build: ${JSON.stringify(built.problems)}`);
  return built.instance;
}

describe("§20.2 — the measured complexity of the singleton solve", () => {
  /** The batch-size fit, built once per test so each measures its own run. */
  const batchFit = () =>
    harness.scalingOf(
      BATCH_SIZES,
      (legs) => {
        const instance = instanceOf(legs, BATCH_FIT_CANDIDATES);
        return () => minCostFlow.solve(instance);
      },
      { trials: 5 },
    );

  test("it is NEAR-LINEAR in batch size, which is what cost scaling predicts", () => {
    const fit = batchFit();

    // eslint-disable-next-line no-console
    console.log(`§20.2 singleton solve — exponent in Legs: ${fit.exponent.toFixed(3)} (r²=${fit.rSquared.toFixed(4)})`);

    // The bounds are the two regimes, not a tolerance around a measurement. Cost scaling
    // moves all the flow under one tolerance and then tightens the tolerance, so the batch
    // size enters through the size of a sweep rather than as a multiplier on the number of
    // sweeps: measured 1.23–1.30 across repeats on a bare process on this machine, and
    // 1.03–1.10 across five consecutive runs of the whole lane through jest.
    // Successive shortest paths measures 2.13 at r² = 0.9996 on the same grid, so the upper
    // bound is what catches a revert to it — and catches an accidental quadratic arrived at
    // any other way. See `BATCH_FIT_CANDIDATES` for why the grid, not the bound, was the
    // thing that had to move when this fit was seen failing on correct code.
    expect(fit.exponent).toBeGreaterThan(0.7);
    expect(fit.exponent).toBeLessThan(1.6);
  });

  test("it is SUB-LINEAR in candidate count", () => {
    const fit = harness.scalingOf(
      CANDIDATE_COUNTS,
      (candidates) => {
        const instance = instanceOf(CANDIDATE_FIT_LEGS, candidates);
        return () => minCostFlow.solve(instance);
      },
      { trials: 5 },
    );

    // eslint-disable-next-line no-console
    console.log(`§20.2 singleton solve — exponent in candidates: ${fit.exponent.toFixed(3)} (r²=${fit.rSquared.toFixed(4)})`);

    // The good half of the finding, and the reason §6.5's candidate cap is affordable: the
    // flow value is bounded by the Leg count, so widening the candidate set adds arcs to each
    // sweep rather than work proportional to the number of candidates. Unchanged by the change
    // of algorithm — 0.667 before, 0.719 after — which is itself the point: the candidate cap
    // was never what was expensive.
    expect(fit.exponent).toBeGreaterThan(0.3);
    expect(fit.exponent).toBeLessThan(1.3);
  });

  test("the fits are fits, not noise — r² is asserted so an exponent read off nothing is visible", () => {
    // A low r² means the timing is dominated by something other than the input size, and an
    // exponent read off such a fit is not evidence of anything. Asserting it is what stops
    // the two tests above from silently degrading into assertions about noise, and it is why
    // `BATCH_SIZES` was doubled when the solve got faster.
    const fit = batchFit();
    expect(fit.rSquared).toBeGreaterThan(0.9);
    expect(fit.points).toHaveLength(BATCH_SIZES.length);
  });

  test("the solver is the algorithm the exponent implies — cost scaling, with the reference kept as an oracle", () => {
    // The exponent is evidence; this is the cause. Asserted so that a future change of
    // algorithm has to update both, and so that a reader of the `scale_targets` gate can see
    // *which* algorithm produced the curve rather than inferring it from the curve.
    const fs = require("fs");
    const path = require("path");
    const solveRoot = path.join(__dirname, "..", "..", "src", "engine", "solve");

    const algorithm = fs.readFileSync(path.join(solveRoot, "costScaling.js"), "utf8");
    expect(algorithm).toMatch(/Goldberg–Tarjan push-relabel with ε-scaling/);

    // And the reference solver still exists, is still named as the reference, and is still not
    // the decision path. Its retention is what makes the equivalence suite possible; asserting
    // it here is what stops it being deleted as dead code.
    const dispatch = fs.readFileSync(path.join(solveRoot, "minCostFlow.js"), "utf8");
    expect(dispatch).toMatch(/Successive shortest paths with Johnson potentials/);
    expect(dispatch).toMatch(/require\("\.\/costScaling"\)/);

    // The decision path runs cost scaling. Checked by running it, not by reading the source:
    // a comment can drift from the dispatch and this cannot.
    const solved = minCostFlow.solve(instanceOf(8, 4));
    expect(solved.solver).toBe(minCostFlow.SOLVER.COST_SCALING);
    expect(solved.optimalityCertified).toBe(true);
  });
});

describe("§20.1 — the targets are recorded with their provenance", () => {
  test("every target names a register entry, and the two p99.9 rows name the window they bound", () => {
    // The precondition for measuring anything: §20.1's table and the register cannot have
    // drifted apart, and a row that claims to bound a safety window must say which.
    expect(sli.assertTargets()).toEqual({ ok: true, problems: [] });

    const safetyWindowRows = sli.TARGETS.filter((target) => target.boundsSafetyWindow);
    expect(safetyWindowRows.map((target) => target.id).sort()).toEqual(
      ["commit_transaction_p999", "decision_to_dispatch_p999"].sort(),
    );
    for (const row of safetyWindowRows) {
      expect({ id: row.id, statistic: row.statistic }).toEqual({ id: row.id, statistic: sli.STATISTIC.P999 });
      expect(row.window).toBeTruthy();
    }
  });

  test("PHASE 10 — the solve is measured at §20.1's OWN 500 × 200 shape, not at a reduced stand-in", () => {
    // §20.1: "Round wall-clock (500 Legs × 200 candidates) | < 250 ms". §9.4 caps the round at
    // exactly those two numbers (`solve.max_legs_per_round` 500, `candidate.max_evaluated`
    // 200), so this is the shape the engine is sized for rather than a stress case.
    //
    // Measured at the real shape. The previous version of this test measured 500 × 10 and said
    // why: the full solve took tens of seconds. It no longer does, so the stand-in is no
    // longer the honest choice — the real shape is.
    const snapshot = service.defaultSnapshot();
    const targetMs = snapshot.resolve("perf.round_wall_clock_p99");
    const maxLegs = snapshot.resolve("solve.max_legs_per_round");
    const maxCandidates = snapshot.resolve("candidate.max_evaluated");

    const instance = instanceOf(maxLegs, maxCandidates);
    const solved = minCostFlow.solve(instance);
    const { medianMs } = harness.timed(() => minCostFlow.solve(instance), { trials: 3, warmup: 1 });

    const record = harness.measureAgainstTarget({
      id: "round_wall_clock_solve",
      statistic: "median",
      target: targetMs,
      unit: "ms",
      measuredMs: medianMs,
    });

    // eslint-disable-next-line no-console
    console.log(
      `§20.1 singleton solve — ${record.measured.toFixed(0)} ms at ${maxLegs} Legs × ${maxCandidates} candidates ` +
        `(${instance.columns.length} columns; the whole round's target is ${record.target} ms). ` +
        `Baseline for the same shape, same machine, successive shortest paths: 23 536 ms.`,
    );

    // The answer is optimal — asserted here as well as in the equivalence suite, because a
    // performance test that measured a wrong answer quickly would be the worst outcome
    // available and this is the only place the full shape is solved.
    expect(solved.optimalityCertified).toBe(true);
    expect(solved.assignments).toHaveLength(maxLegs);

    // A **regression bound**, not a §20.1 pass. It sits an order of magnitude above the
    // measured 345 ms and two below the 23 536 ms baseline, which is the band in which it
    // catches a reverted or accidentally-quadratic solver on any machine this suite plausibly
    // runs on while staying immune to a loaded runner. Asserting 250 ms here would be
    // asserting §20.1's gate on unknown hardware, which `scaleHarness.js` explains at length
    // is not a gate — the provenance line below is asserted for the same reason.
    expect(record.measured).toBeLessThan(5_000);
    expect(record.provenance).toMatch(/not on representative production hardware/);
  });

  test("PHASE 10 — instance construction at §20.1's OWN 500 × 200 shape, measured not inferred", () => {
    // The test above measures the *solve* at a reduced candidate count because the full
    // solve takes tens of seconds. Instance construction does not, and it is the half of
    // the round that was previously assumed expensive without being measured. Measured
    // here at the real shape — 500 Legs × 200 candidates, 100 000 columns — so that the
    // §20.1 gap can be attributed to the stage that actually owns it.
    const snapshot = service.defaultSnapshot();
    const maxLegs = snapshot.resolve("solve.max_legs_per_round");
    const maxCandidates = snapshot.resolve("candidate.max_evaluated");

    const input = inputAt(maxLegs, maxCandidates);
    const built = objective.buildInstance(input);
    expect(built.ok).toBe(true);
    expect(built.instance.columns).toHaveLength(maxLegs * maxCandidates);

    const { medianMs } = harness.timed(() => objective.buildInstance(input), { trials: 3, warmup: 1 });

    // eslint-disable-next-line no-console
    console.log(
      `§20.1 buildInstance — ${medianMs.toFixed(0)} ms at ${maxLegs} Legs × ${maxCandidates} candidates ` +
        `(${built.instance.columns.length} columns, ${built.instance.coverage.length} coverage rows, ` +
        `${built.instance.exclusivity.length} exclusivity rows)`,
    );

    // Recorded, not asserted, for the reason the header gives: a wall-clock bound is flaky
    // on a slow runner and vacuous on a fast one. The regression that would matter here is
    // a *shape*, and the next test is what asserts it.
    expect(medianMs).toBeGreaterThan(0);
  });

  test("PHASE 10 — and it is LINEAR in batch size, which is what grouping the columns bought", () => {
    // The complexity claim, in the machine-independent form this file uses everywhere else.
    // `buildInstance` fills a matrix with one non-zero per (column, Leg) pair, so its work
    // is proportional to the column count and the exponent in Legs is 1 at fixed candidates.
    //
    // The repeated-scan implementation was not: it re-filtered all `m · c` columns once per
    // coverage row, an `O(m² · c)` term that shows up as an exponent near 2.
    //
    // Measured at 100 candidates because that is where the two implementations separate
    // furthest on this machine: 1.59 for the repeated scan against 1.10 for the grouped
    // pass. (20 candidates was tried and is worse — 1.42 against 1.04 — because the
    // quadratic term needs enough absolute time to outweigh the per-column constants that
    // `buildInstance` pays either way: the canonical sort, the brand assertion, and the
    // frozen variable record.)
    const fit = harness.scalingOf(
      [63, 125, 250, 500],
      (legs) => {
        const input = inputAt(legs, 100);
        return () => objective.buildInstance(input);
      },
      { trials: 3, warmup: 1 },
    );

    // eslint-disable-next-line no-console
    console.log(
      `§20.2 buildInstance — exponent in Legs at 100 candidates: ${fit.exponent.toFixed(3)} ` +
        `(r²=${fit.rSquared.toFixed(4)})`,
    );

    expect(fit.rSquared).toBeGreaterThan(0.9);

    // The bound sits at 1.4, roughly midway: 0.30 above the grouped pass, 0.19 below the
    // scan. Placed there rather than tight against 1.0 on purpose — a loaded runner moves
    // the fit (one run of the grouped pass came in at 0.84), and the asymmetry is the safe
    // direction. A missed catch is recoverable; a scale test people re-run until it passes
    // is not.
    expect(fit.exponent).toBeLessThan(1.4);
  });

  test("§9.4's anytime budget bounds the damage the finding causes, and is registered", () => {
    // The specification's own escape, and the reason the finding is a quality gap rather
    // than a hang: "The solver MUST be an **anytime** algorithm: at any point it holds a
    // feasible solution and a bound. Exceeding the time budget returns the incumbent with
    // its bound, never nothing and never a hang."
    const entries = service.loadRegister().entries;
    const budget = entries.get("solve.time_budget");
    expect(budget).toBeTruthy();
    expect(budget.default).toBeGreaterThan(0);

    // And an oversized batch is partitioned rather than attempted whole (§9.4), which is
    // what keeps a saturated shard from meeting the quadratic term at full width.
    expect(entries.get("solve.max_legs_per_round")).toBeTruthy();
    expect(entries.get("candidate.max_evaluated")).toBeTruthy();
  });
});
