"use strict";

/**
 * The scheduled counterfactual evaluator (§21.6).
 *
 * > **Offline counterfactual evaluator.** Periodically re-solves recent rounds with
 * > relaxed bounds — larger candidate sets, wider regions, longer time budgets, perfect
 * > hindsight forecasts — and reports the realised gap. This is how the engine measures
 * > the cost of its own approximations.
 *
 * ── Scheduled *and* gated, and the distinction matters ──────────────────────
 * §21.6 is emphatic that the schedule is not sufficient on its own:
 *
 * > **The evaluator is a release gate, not only a periodic report, whenever column
 * > generation changes.** … Running the evaluator only on a schedule would mean a
 * > generation regression ships, degrades allocation quality silently, and is discovered
 * > weeks later mixed in with every other change made since.
 *
 * So this worker is the *periodic report* half, and `tools/evaluator/counterfactual.js`
 * carries the gate that a release runs. This file exists to keep a baseline current, so
 * that when the gate does run it has something to compare against that was measured over
 * the same corpus rather than assembled in a hurry on the day.
 *
 * ── Why it re-solves rather than re-reads ──────────────────────────────────
 * The whole point is to compute what production *did not*: an allocation over a larger
 * candidate set, a wider region, a longer budget, an enlarged column set. That means
 * running the solver, which this worker does through an injected `resolve` — the same
 * seam `shadow.js` uses, and for the same reason. A Tier 1 evaluator that reached into
 * the decision path directly could change what it was measuring.
 *
 * ── Off the production path, by construction ───────────────────────────────
 * The evaluator never commits and never dispatches. It reads stored rounds, re-solves
 * them under relaxed bounds, and writes nothing but a report. That is what makes
 * off-policy evaluation possible "without any production experiment", which §21.6 calls
 * "a deliberate present-day choice on behalf of future work".
 *
 * ── Built, tested, and not started ─────────────────────────────────────────
 * Nothing in `server.js` calls `start()`. Phase 15 owns production scheduling.
 *
 * Tier 1 by path (`src/workers/`).
 */

const evaluator = require("../../tools/evaluator/counterfactual");

/**
 * How often the periodic report runs. Daily: the evaluator re-solves rounds, which costs
 * roughly what the original solve did per round, and its output is a trend rather than
 * an alarm.
 * @structural the evaluator's cadence; a scheduling choice, not a behavioural threshold
 */
const RUN_INTERVAL_MS = 86_400_000;

/**
 * How many recent rounds one report covers.
 * @structural the report's corpus size
 */
const CORPUS_SIZE = 200;

/**
 * Load a corpus of recent rounds and their recorded objectives.
 *
 * @param {object} deps `{ prisma }`
 * @param {object} input `{ shardId, size, fromMs, toMs }`
 * @returns {Promise<object[]>}
 */
async function loadRounds(deps, input) {
  const source = input || {};
  const rows = await deps.prisma.round.findMany({
    where: {
      ...(source.shardId ? { shardId: source.shardId } : {}),
      ...(Number.isFinite(source.fromMs) && Number.isFinite(source.toMs)
        ? { decisionTime: { gte: new Date(source.fromMs), lt: new Date(source.toMs) } }
        : {}),
    },
    orderBy: { decisionTime: "desc" },
    take: Number.isFinite(source.size) ? source.size : CORPUS_SIZE,
  });

  return rows.map((row) => ({
    roundId: row.roundId,
    shardId: row.shardId,
    decisionTime: row.decisionTime,
    regime: row.regime,
    // The objective as recorded, in integer milli-CU. Carried as a string in the
    // database because int64 milli-CU does not survive a JSON number; revived here as a
    // `bigint` because every comparison downstream is exact (§9.6 requirement 1).
    objectiveMilliCU:
      row.budgets && row.budgets.incumbent && row.budgets.incumbent.objectiveMilliCU !== undefined
        ? BigInt(row.budgets.incumbent.objectiveMilliCU)
        : null,
  }));
}

/**
 * One report pass.
 *
 * @param {object} deps `{ prisma, resolve, now, registry }`
 * @param {object} [context] `{ shardId, size, relaxations, relaxedBounds }`
 * @returns {Promise<object>}
 */
async function runOnce(deps, context) {
  const settings = context || {};
  const nowMs = typeof deps.now === "function" ? deps.now() : Date.now();

  const rounds = await loadRounds(deps, { shardId: settings.shardId, size: settings.size });
  const report = await evaluator.run(deps, {
    rounds,
    relaxations: settings.relaxations,
    relaxedBounds: settings.relaxedBounds,
  });

  if (deps.registry) {
    // §21.4's two allocation-quality metrics from this instrument, published separately
    // and never summed — they bound different approximations (§9.3, §21.6).
    if (report.counterfactualRegretMilliCU !== null) {
      deps.registry.gauge("sli.counterfactual_regret", Number(report.counterfactualRegretMilliCU), {
        shardId: settings.shardId ?? null,
      });
    }
    if (report.columnGenerationGapMilliCU !== null) {
      deps.registry.gauge("sli.column_generation_gap", Number(report.columnGenerationGapMilliCU), {
        shardId: settings.shardId ?? null,
      });
    }
  }

  return { nowMs, shardId: settings.shardId ?? null, ...report };
}

/**
 * The release gate, run against a stored baseline. Exposed here as well as in the tool
 * so that a scheduled pass can flag a regression it happens to notice, without that
 * becoming the only place the gate runs — which is precisely the failure §21.6 names.
 *
 * @param {object} input `{ baseline, candidate, config, changes }`
 * @returns {object}
 */
function gateAgainst(input) {
  const source = input || {};
  const maxRegressionCU =
    source.config && typeof source.config.get === "function" ? source.config.get("solve.max_generation_gap_regression") : null;

  return evaluator.gate({
    baseline: source.baseline,
    candidate: source.candidate,
    maxRegressionCU: Number.isFinite(maxRegressionCU) ? maxRegressionCU : null,
    changes: source.changes,
  });
}

/**
 * Start the periodic evaluator.
 *
 * @param {object} deps as `runOnce`, plus `onError`
 * @param {object} [context]
 * @returns {{ stop: () => void }}
 */
function start(deps, context) {
  const intervalMs = (context && context.intervalMs) || RUN_INTERVAL_MS;

  const handle = setInterval(() => {
    runOnce(deps, context).catch((error) => {
      // A failed pass costs a trend point. The gate is elsewhere and fails closed.
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
  RUN_INTERVAL_MS,
  CORPUS_SIZE,
  loadRounds,
  runOnce,
  gateAgainst,
  start,
};
