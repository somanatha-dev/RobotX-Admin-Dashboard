"use strict";

/**
 * The calibration comparator (§21.5).
 *
 * The plan names it *"calibration comparator at settlement"*, and **at settlement** is
 * the load-bearing half. §21.5:
 *
 * > Every prediction the engine makes … is compared against its realised outcome **at
 * > settlement**, and the comparison is a monitored SLI, not an offline curiosity.
 *
 * Settlement (§4.9) is the only moment at which both halves of the pair exist and are
 * both trustworthy: the prediction is pinned in the decision record, and the realised
 * outcome has passed completion verification (§12.5). Comparing earlier would score a
 * prediction against a claim; comparing later would mean holding predictions in memory
 * across a lifetime the engine has no reason to hold anything across.
 *
 * ── Two jobs, one worker ────────────────────────────────────────────────────
 *   1. **`compareAtSettlement()`** — called with a settled commitment's realised
 *      outcomes, it writes one `CalibrationObservation` per predictor. This is the
 *      comparator proper, and it is a function rather than a loop so that Phase 5's
 *      settlement path can call it directly when Phase 15 wires the engine live.
 *   2. **`scoreOnce()`** — the periodic pass that turns those observations into the
 *      §21.5 statistics: bias, dispersion, per-tier probabilistic calibration at each
 *      tier's own timescale, and drift alarms per slice.
 *
 * ── The three tiers are scored by different instruments, and that is enforced ─
 * §21.5 is explicit that T3 is validated "from the *predictive distribution's tail
 * calibration* rather than from event counts, since waiting for T3 events to accumulate
 * enough to test a rate is not a monitoring strategy". `calibration.js` refuses to
 * compute a T3 event frequency at all; this worker reports what it returns without
 * substituting one, so nothing downstream can present "0 observed in 0 expected" as
 * evidence that a 1e-7 target holds.
 *
 * ── Built, tested, and not started ─────────────────────────────────────────
 * Nothing in `server.js` calls `start()`. Phase 15 owns production scheduling.
 *
 * Tier 1 by path (`src/workers/`).
 */

const calibration = require("../engine/observability/calibration");

/**
 * How often the scoring pass runs. Calibration is a slow signal — bias over a slice
 * needs `observability.calibration_min_samples` observations before it says anything —
 * so a five-minute pass is frequent enough to catch drift within an operating hour and
 * infrequent enough that the aggregate query is never the load.
 * @structural the scorer's cadence; a batching choice, not a behavioural threshold
 */
const SCORE_INTERVAL_MS = 300_000;

/** @structural milliseconds per hour, the default scoring window */
const DEFAULT_WINDOW_MS = 3_600_000;

/**
 * Write the calibration observations for one settled commitment.
 *
 * @param {object} deps `{ prisma }`
 * @param {object} input
 * @param {object} input.predictions the Tier A `predictions` section, as recorded
 * @param {object} input.realised the settled outcome, keyed by the same predictor names
 * @param {object} input.subject `{ decisionId, commitmentId, legId, agentId }`
 * @param {object} input.slice `{ shardId, zoneId, missionClass, agentClassId, timeBucket }`
 * @param {number} input.predictedAtMs
 * @param {number} input.observedAtMs
 * @returns {Promise<{ written: number, skipped: string[] }>}
 */
async function compareAtSettlement(deps, input) {
  const source = input || {};
  const predictions = source.predictions || {};
  const realised = source.realised || {};

  const rows = [];
  const skipped = [];

  for (const predictor of calibration.PREDICTORS) {
    const predicted = predictions[predictor];
    const observed = realised[predictor];

    // A predictor the decision did not make is not a miss; it is a predictor that was
    // not applicable. Recording a null pair would dilute the slice's bias with rows
    // that carry no information.
    if (predicted === undefined && observed === undefined) continue;

    const band = (predictions.bands || {})[predictor] || {};
    const probabilistic = (predictions.probabilistic || {})[predictor] || {};

    if (predicted === undefined || observed === undefined) {
      skipped.push(predictor);
      continue;
    }

    rows.push(
      calibration.observationFrom({
        predictor,
        unit: (predictions.units || {})[predictor] || "unspecified",
        predicted: typeof predicted === "number" ? predicted : predicted && predicted.value,
        realised: typeof observed === "number" ? observed : observed && observed.value,
        bandLower: band.lower,
        bandUpper: band.upper,
        tier: probabilistic.tier,
        claimedProbability: probabilistic.claimedProbability,
        eventOccurred: probabilistic.eventOccurred,
        tailQuantile: probabilistic.tailQuantile,
        predictedAtMs: source.predictedAtMs,
        observedAtMs: source.observedAtMs,
        slice: source.slice,
        subject: source.subject,
      }),
    );
  }

  if (rows.length > 0) await deps.prisma.calibrationObservation.createMany({ data: rows });

  return { written: rows.length, skipped };
}

/**
 * One scoring pass.
 *
 * @param {object} deps `{ prisma, config, now, registry }`
 * @param {object} [context] `{ shardId, windowMs, dimensions }`
 * @returns {Promise<object>}
 */
async function scoreOnce(deps, context) {
  const settings = context || {};
  const toMs = typeof deps.now === "function" ? deps.now() : Date.now();
  const windowMs = Number.isFinite(settings.windowMs) ? settings.windowMs : DEFAULT_WINDOW_MS;

  const report = await calibration.score(deps, {
    fromMs: toMs - windowMs,
    toMs,
    config: deps.config,
    shardId: settings.shardId,
    dimensions: settings.dimensions,
  });

  if (deps.registry) {
    for (const predictor of report.predictors) {
      if (predictor.bias.meanSignedError !== null) {
        deps.registry.gauge("sli.calibration_bias", predictor.bias.meanSignedError, { predictor: predictor.predictor });
      }
      if (predictor.dispersion.standardDeviation !== null) {
        deps.registry.gauge("sli.calibration_dispersion", predictor.dispersion.standardDeviation, {
          predictor: predictor.predictor,
        });
      }
      if (predictor.alarms > 0) deps.registry.count("sli.calibration_drift_alarms", predictor.alarms, { predictor: predictor.predictor });
    }

    for (const tier of report.energyShortfallTiers) {
      // Only the tiers whose instrument is an event count get a frequency gauge. T3 gets
      // its KS distance instead: publishing a frequency for T3 would give a dashboard a
      // number to trend for a target the count has no power to test (§21.5, I17).
      if (tier.instrument === calibration.INSTRUMENT.EVENT_COUNT && tier.observedFrequency !== null && tier.observedFrequency !== undefined) {
        deps.registry.gauge("sli.energy_shortfall_observed_frequency", tier.observedFrequency, { tier: tier.tier });
      }
      if (tier.instrument === calibration.INSTRUMENT.TAIL_CALIBRATION && Number.isFinite(tier.ksDistanceFromUniform)) {
        deps.registry.gauge("sli.energy_shortfall_tail_ks", tier.ksDistanceFromUniform, { tier: tier.tier });
      }
    }
  }

  return report;
}

/**
 * Start the periodic scorer.
 *
 * @param {object} deps as `scoreOnce`, plus `onError`
 * @param {object} [context]
 * @returns {{ stop: () => void }}
 */
function start(deps, context) {
  const intervalMs = (context && context.intervalMs) || SCORE_INTERVAL_MS;

  const handle = setInterval(() => {
    scoreOnce(deps, context).catch((error) => {
      // A failed pass loses one window's report, never an observation: the rows are
      // durable and the next pass re-reads them.
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
  SCORE_INTERVAL_MS,
  DEFAULT_WINDOW_MS,
  compareAtSettlement,
  scoreOnce,
  start,
};
