"use strict";

/**
 * The offline counterfactual evaluator, and the release gate it carries (§21.6).
 *
 * > **Offline counterfactual evaluator.** Periodically re-solves recent rounds with
 * > relaxed bounds — larger candidate sets, wider regions, longer time budgets, perfect
 * > hindsight forecasts — and reports the realised gap. This is how the engine measures
 * > the cost of its own approximations: shard boundaries, candidate truncation, batch
 * > windows, and — measured by re-solving with a deliberately enlarged column set — the
 * > **column-generation gap**, which is the one approximation the in-round machinery
 * > cannot bound for itself (§9.3).
 *
 * ── Why this is a gate and not a report ─────────────────────────────────────
 * > **The evaluator is a release gate, not only a periodic report, whenever column
 * > generation changes.** The solve makes *selection* among generated columns exact
 * > while leaving *generation* heuristic, so in practice the heuristic determines the
 * > answer: **an exact solve over a poor column set produces an exact but poor result,
 * > and no in-round signal reveals it**, because the in-round bounds cover only what was
 * > generated. The counterfactual evaluator is the sole instrument that can measure it.
 *
 * The consequence for this file is precise: `gate()` fails a change whose measured
 * column-generation gap has widened beyond `solve.max_generation_gap_regression`, and
 * `GATED_CHANGES` enumerates what counts as a change to generation — including the two
 * budget parameters, because §21.6 states that "a budget change is a heuristic change in
 * effect".
 *
 * > Running the evaluator only on a schedule would mean a generation regression ships,
 * > degrades allocation quality silently, and is discovered weeks later mixed in with
 * > every other change made since.
 *
 * ── The relaxations, and why each is measured separately ────────────────────
 * The four approximations §21.6 names are different decisions with different owners: a
 * candidate-truncation gap is answered by raising `candidate.max_evaluated`, a shard
 * boundary gap by re-drawing shards, a batch-window gap by changing cadence, and a
 * generation gap by changing the heuristic. Summing them would produce one number that
 * nobody can act on — the same error §9.3 forbids for the search and LP–IP gaps, applied
 * to their offline cousins.
 *
 * ── What this file does not do ──────────────────────────────────────────────
 * It does not re-solve by itself. Re-solving is `solve/round.js`'s job, and the
 * evaluator injects a `resolve` function bound to the relaxed bounds — the same
 * discipline `shadow.js` uses, and for the same reason: a Tier 1 evaluator that reached
 * into the decision path would be an evaluator that could change what it measures.
 *
 * Usage:
 *   node tools/evaluator/counterfactual.js --report <path-to-run.json>
 * Exit code 0 on pass, 1 when the gate fails.
 */

const fs = require("fs");
const path = require("path");

const { compare: compareMilliCU, subtract, sum } = require("../../src/engine/determinism/fixedPoint");
const { compareStrings } = require("../../src/engine/determinism/ordering");

/** The four approximations §21.6 names, measured and reported separately. */
const RELAXATION = Object.freeze({
  /** Larger candidate sets — how much did `candidate.max_evaluated` cost? */
  CANDIDATE_SET: "CANDIDATE_SET",
  /** Wider regions — how much did the shard boundary cost? */
  SHARD_BOUNDARY: "SHARD_BOUNDARY",
  /** Longer time budgets and wider batch windows — how much did the cadence cost? */
  BATCH_WINDOW: "BATCH_WINDOW",
  /**
   * A deliberately enlarged column set — the column-generation gap, "the one
   * approximation the in-round machinery cannot bound for itself".
   */
  COLUMN_GENERATION: "COLUMN_GENERATION",
});

const RELAXATIONS = Object.freeze(Object.values(RELAXATION));

/**
 * Changes that MUST be gated on an evaluator run before release (§21.6).
 *
 * The two budget entries are there because §21.6 says so explicitly: "The same gate
 * applies to changes in `plan.max_columns_per_round` and `plan.max_bundle_size`, since a
 * budget change is a heuristic change in effect." A reviewer who reads only the first
 * sentence of that paragraph would let a budget cut through ungated, and a budget cut is
 * how a generation heuristic is most easily degraded without touching its code.
 */
const GATED_CHANGES = Object.freeze([
  "the column-generation clustering rule",
  "the bundle-size policy",
  "the enumeration order",
  "the pruning rule",
  "any learned column proposer admitted under §25.5",
  "plan.max_columns_per_round",
  "plan.max_bundle_size",
]);

/**
 * Evaluate one round under one relaxation.
 *
 * @param {object} deps
 * @param {(input: object) => Promise<object>} deps.resolve re-solves a stored round
 *   under the relaxed bounds and returns `{ objectiveMilliCU }`
 * @param {object} input
 * @param {object} input.storedRound `{ roundId, objectiveMilliCU }` as recorded
 * @param {string} input.relaxation one of `RELAXATION`
 * @param {object} input.relaxedBounds
 * @returns {Promise<object>}
 */
async function evaluateRound(deps, input) {
  const source = input || {};
  const stored = source.storedRound || {};

  const relaxed = await deps.resolve({
    roundId: stored.roundId,
    relaxation: source.relaxation,
    bounds: source.relaxedBounds,
  });

  const storedObjective = typeof stored.objectiveMilliCU === "bigint" ? stored.objectiveMilliCU : null;
  const relaxedObjective = relaxed && typeof relaxed.objectiveMilliCU === "bigint" ? relaxed.objectiveMilliCU : null;

  // The realised gap: what the production run cost, minus what the relaxed one cost.
  // Non-negative in a correct system — the relaxed solve searches a superset — and a
  // negative value is reported rather than clamped, because it means the relaxation was
  // not actually a relaxation and the comparison is invalid.
  const gap = storedObjective === null || relaxedObjective === null ? null : subtract(storedObjective, relaxedObjective);

  return {
    roundId: stored.roundId,
    relaxation: source.relaxation,
    storedObjectiveMilliCU: storedObjective === null ? null : storedObjective.toString(),
    relaxedObjectiveMilliCU: relaxedObjective === null ? null : relaxedObjective.toString(),
    realisedGapMilliCU: gap === null ? null : gap.toString(),
    valid: gap === null ? false : compareMilliCU(gap, 0n) >= 0,
    invalidBecause:
      gap !== null && compareMilliCU(gap, 0n) < 0
        ? "the relaxed solve cost MORE than production, so the relaxation did not enlarge the search space. " +
          "The comparison is invalid rather than a negative gap."
        : null,
  };
}

/**
 * Run the evaluator over a corpus of rounds, under every relaxation, reporting each
 * separately.
 *
 * @param {object} deps `{ resolve }`
 * @param {object} input `{ rounds, relaxations, relaxedBounds }`
 * @returns {Promise<object>}
 */
async function run(deps, input) {
  const source = input || {};
  const relaxations = source.relaxations || RELAXATIONS;
  const byRelaxation = {};

  for (const relaxation of relaxations) {
    const results = [];
    for (const storedRound of source.rounds || []) {
      // eslint-disable-next-line no-await-in-loop
      results.push(
        await evaluateRound(deps, {
          storedRound,
          relaxation,
          relaxedBounds: (source.relaxedBounds || {})[relaxation] || {},
        }),
      );
    }

    const valid = results.filter((row) => row.valid);
    const gaps = valid.map((row) => BigInt(row.realisedGapMilliCU)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    byRelaxation[relaxation] = {
      relaxation,
      rounds: results.length,
      validComparisons: valid.length,
      // Reported separately per relaxation and never summed: the four bound different
      // approximations with different owners, and one combined number would be
      // actionable by nobody (§9.3's discipline, applied offline).
      totalGapMilliCU: gaps.length === 0 ? null : sum(gaps).toString(),
      meanGapMilliCU: gaps.length === 0 ? null : (sum(gaps) / BigInt(gaps.length)).toString(),
      medianGapMilliCU: gaps.length === 0 ? null : gaps[Math.floor(gaps.length / 2)].toString(),
      maxGapMilliCU: gaps.length === 0 ? null : gaps[gaps.length - 1].toString(),
      results,
    };
  }

  return {
    rounds: (source.rounds || []).length,
    byRelaxation,
    // §21.4's "counterfactual regret from the offline evaluator", which is the
    // candidate-set relaxation's own gap — the cost of truncation, measured rather than
    // bounded.
    counterfactualRegretMilliCU: byRelaxation[RELAXATION.CANDIDATE_SET]
      ? byRelaxation[RELAXATION.CANDIDATE_SET].meanGapMilliCU
      : null,
    columnGenerationGapMilliCU: byRelaxation[RELAXATION.COLUMN_GENERATION]
      ? byRelaxation[RELAXATION.COLUMN_GENERATION].meanGapMilliCU
      : null,
    neverSummed:
      "the four relaxations bound different approximations and are reported separately. Summing them would " +
      "produce a figure that bounds none of them (§9.3, §21.6).",
  };
}

/** @structural milli-CU per CU, converting a CU-denominated register value */
const MILLI_PER_CU = 1000;

/**
 * Words that carry no meaning for matching a change description against `GATED_CHANGES`.
 * @structural the matcher's stop list
 */
const STOP_WORDS = new Set(["any", "the", "and", "for", "its", "our", "under", "admitted", "change", "changes"]);

/**
 * The release gate: has the column-generation gap widened beyond
 * `solve.max_generation_gap_regression`?
 *
 * @param {object} input
 * @param {object} input.baseline a previous `run()` report over the same corpus
 * @param {object} input.candidate this change's `run()` report
 * @param {number} input.maxRegressionCU `solve.max_generation_gap_regression`, in CU
 * @param {string[]} [input.changes] what changed, for the record
 * @returns {object}
 */
function gate(input) {
  const source = input || {};

  const read = (report) => {
    const value = report && report.columnGenerationGapMilliCU;
    return value === null || value === undefined ? null : BigInt(value);
  };

  const baseline = read(source.baseline);
  const candidate = read(source.candidate);

  if (baseline === null || candidate === null) {
    return Object.freeze({
      ok: false,
      reason: "NO_MEASUREMENT",
      detail:
        "the column-generation gap was not measured on one or both sides. §21.6 makes the evaluator the sole " +
        "instrument that can see a generation regression; an unmeasured change is an ungated one, and the gate " +
        "fails closed rather than waving it through.",
      gatedChanges: GATED_CHANGES,
    });
  }

  const regression = subtract(candidate, baseline);
  const allowance = Number.isFinite(source.maxRegressionCU) ? BigInt(Math.round(source.maxRegressionCU * MILLI_PER_CU)) : 0n;
  const ok = compareMilliCU(regression, allowance) <= 0;

  return Object.freeze({
    ok,
    baselineGapMilliCU: baseline.toString(),
    candidateGapMilliCU: candidate.toString(),
    regressionMilliCU: regression.toString(),
    allowanceMilliCU: allowance.toString(),
    parameter: "solve.max_generation_gap_regression",
    changes: source.changes || [],
    gatedChanges: GATED_CHANGES,
    detail: ok
      ? "the column-generation gap has not widened beyond its allowance."
      : "the column-generation gap widened beyond solve.max_generation_gap_regression. An exact solve over a " +
        "poorer column set is still exact, and no in-round bound would have revealed this (§9.3, §21.6).",
  });
}

/**
 * Does a described change require the gate?
 *
 * @param {string[]} changes
 * @returns {{ required: boolean, matched: string[] }}
 */
function gateRequiredFor(changes) {
  // Matched on significant words rather than on substring containment. A release
  // engineer describes a change in prose — "a learned column proposer", "we lowered
  // max_columns_per_round" — and a containment test on the exact phrasing would let a
  // gated change through on an article. Failing to *require* the gate is the expensive
  // direction here: §21.6's whole argument is that no in-round signal reveals a
  // generation regression, so a missed gate ships one silently.
  const significant = (text) =>
    new Set(
      String(text)
        .toLowerCase()
        .split(/[^a-z0-9_.]+/)
        .filter((word) => word.length > 2 && !STOP_WORDS.has(word)),
    );

  const described = (changes || []).map(significant);

  const matched = GATED_CHANGES.filter((gated) => {
    const words = significant(gated);
    return described.some((change) => {
      const overlap = [...words].filter((word) => change.has(word)).length;
      // Every significant word of the gated phrase present, or an exact parameter name.
      return words.size > 0 && overlap === words.size;
    });
  });

  return { required: matched.length > 0, matched: matched.sort(compareStrings) };
}

/* ── CLI ─────────────────────────────────────────────────────────────────── */

if (require.main === module) {
  const argv = process.argv.slice(2);
  const reportIndex = argv.indexOf("--report");
  if (reportIndex === -1) {
    process.stdout.write("usage: node tools/evaluator/counterfactual.js --report <run.json>\n");
    process.exit(1);
  }

  const report = JSON.parse(fs.readFileSync(path.resolve(argv[reportIndex + 1]), "utf8"));
  const verdict = gate(report);

  process.stdout.write("gate: counterfactual evaluator — column-generation regression (§21.6)\n");
  process.stdout.write(
    `  ${verdict.ok ? "PASS" : "FAIL"} — ${verdict.detail}\n` +
      (verdict.regressionMilliCU
        ? `  regression ${verdict.regressionMilliCU} milli-CU against an allowance of ${verdict.allowanceMilliCU}\n`
        : ""),
  );
  process.exit(verdict.ok ? 0 : 1);
}

module.exports = {
  RELAXATION,
  RELAXATIONS,
  GATED_CHANGES,
  MILLI_PER_CU,
  STOP_WORDS,
  evaluateRound,
  run,
  gate,
  gateRequiredFor,
};
