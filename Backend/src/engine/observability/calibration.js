"use strict";

/**
 * Prediction calibration as a first-class loop (§21.5) — **Tier 1**.
 *
 * > Every prediction the engine makes — travel time, service time, energy, failure
 * > probability, demand — is compared against its realised outcome at settlement, and
 * > **the comparison is a monitored SLI, not an offline curiosity**.
 *
 * > This matters more than it initially appears. The cost function is only as good as
 * > its inputs, and a miscalibrated predictor produces confidently wrong allocations
 * > that no amount of solver correctness can fix.
 *
 * The second sentence is why this module sits in the engine rather than in a reporting
 * tool: the loop is what keeps `Φ` honest. A solver that is exactly optimal over wrong
 * numbers is exactly wrong.
 *
 * ── The three statistics, and what each drives ──────────────────────────────
 *   - **Bias** (mean signed error) — drives coefficient refitting.
 *   - **Dispersion** (error spread) — drives uncertainty band width, "which drives
 *     reserves and `p_late`". A dispersion figure is therefore not a diagnostic here; it
 *     is an input to a safety constraint, which is why `dispersion()` reports the band
 *     coverage alongside the spread rather than the spread alone.
 *   - **Probabilistic calibration** — per tier, at its own timescale.
 *
 * ── Why the tiers are scored by different instruments ───────────────────────
 * > Because the tier targets span five orders of magnitude, they are validated at
 * > different timescales and by different instruments: **T1 from direct event counts
 * > within days, T2 from event counts over quarters, and T3 — whose budget is a handful
 * > of events per fleet-year — from the *predictive distribution's tail calibration*
 * > rather than from event counts**, since waiting for T3 events to accumulate enough to
 * > test a rate is not a monitoring strategy. **Validating a 1e-7 target by counting its
 * > occurrences is a category error**, and the design says so rather than implying an
 * > event count will eventually arrive.
 *
 * `INSTRUMENT_BY_TIER` encodes that, and `probabilisticCalibration()` **refuses** to
 * score T3 by event frequency — it returns the tail statistic and states why, rather
 * than returning a frequency that would look like an answer. An implementation that
 * silently counted T3 events would produce a confident "0 observed, 0 expected, within
 * budget" for a target it has no power to test, which is worse than no answer at all.
 *
 * ── No clock ───────────────────────────────────────────────────────────────
 * Every function takes its window as an argument. The worker supplies the clock. This
 * is not a decision-path module, but the same discipline makes a calibration report
 * reproducible from stored rows months later, which is the only way a drift claim can
 * be argued about.
 */

const { compareStrings } = require("../determinism/ordering");

/** The predictors the loop scores. Matches `CalibrationObservation_predictor_known`. */
const PREDICTOR = Object.freeze({
  TRAVEL_TIME: "TRAVEL_TIME",
  SERVICE_TIME: "SERVICE_TIME",
  ENERGY: "ENERGY",
  FAILURE_PROBABILITY: "FAILURE_PROBABILITY",
  DEMAND: "DEMAND",
  /** §3.4's honest predicted assignment window, scored against the realised assignment. */
  ASSIGNMENT_WINDOW: "ASSIGNMENT_WINDOW",
  /** F34's per-tier shortfall probability — invariant I17's statistical half. */
  ENERGY_SHORTFALL: "ENERGY_SHORTFALL",
});

const PREDICTORS = Object.freeze(Object.values(PREDICTOR));

/** §21.5's slices: "sliced by zone, class, agent class, and time bucket". */
const SLICE_DIMENSIONS = Object.freeze(["zoneId", "missionClass", "agentClassId", "timeBucket"]);

/**
 * The instrument each shortfall tier is validated by (§21.5, §26 I17).
 *
 * `EVENT_COUNT` is a frequency test. `TAIL_CALIBRATION` is not — it asks whether the
 * predictive distribution's upper tail is shaped correctly, which is answerable from
 * observations that contain **no** events at all.
 */
const INSTRUMENT = Object.freeze({
  EVENT_COUNT: "EVENT_COUNT",
  TAIL_CALIBRATION: "TAIL_CALIBRATION",
});

const INSTRUMENT_BY_TIER = Object.freeze({
  T1: { instrument: INSTRUMENT.EVENT_COUNT, timescale: "days", why: "T1's budget is frequent enough that a count over days has power." },
  T2: { instrument: INSTRUMENT.EVENT_COUNT, timescale: "quarters", why: "T2's budget needs a quarter before a count means anything." },
  T3: {
    instrument: INSTRUMENT.TAIL_CALIBRATION,
    timescale: "fleet-year, and never by counting",
    why:
      "T3's budget is a handful of events per fleet-year. Validating a 1e-7 target by counting its occurrences " +
      "is a category error: at that rate an event count carries no statistical power on any useful timescale, " +
      "and a report of \"0 observed\" would read as confirmation when it is the absence of a test (§21.5, I17).",
  },
});

/** @structural milliseconds per second, for turning a window in seconds into a range */
const MS_PER_SECOND = 1000;

/**
 * Build one observation from a prediction and its realised outcome.
 *
 * @param {object} input
 * @param {string} input.predictor one of `PREDICTOR`
 * @param {string} input.unit the predictor's own unit — never normalised (§1.3)
 * @param {number} [input.predicted]
 * @param {number} [input.realised]
 * @param {number} [input.bandLower]
 * @param {number} [input.bandUpper]
 * @param {string} [input.tier]
 * @param {number} [input.claimedProbability]
 * @param {boolean} [input.eventOccurred]
 * @param {number} [input.tailQuantile] where the realised value fell in the predictive
 *   distribution, in `[0, 1]` — the T3 instrument's raw material
 * @param {number} input.predictedAtMs
 * @param {number} input.observedAtMs
 * @param {object} [input.slice] `{ shardId, zoneId, missionClass, agentClassId, timeBucket }`
 * @param {object} [input.subject] `{ decisionId, commitmentId, legId, agentId }`
 * @returns {object} the `CalibrationObservation` row shape
 */
function observationFrom(input) {
  const source = input || {};
  const slice = source.slice || {};
  const subject = source.subject || {};

  const predicted = Number.isFinite(source.predicted) ? source.predicted : null;
  const realised = Number.isFinite(source.realised) ? source.realised : null;
  const signedError = predicted !== null && realised !== null ? realised - predicted : null;

  const bandLower = Number.isFinite(source.bandLower) ? source.bandLower : null;
  const bandUpper = Number.isFinite(source.bandUpper) ? source.bandUpper : null;
  const withinBand =
    realised === null || bandLower === null || bandUpper === null ? null : realised >= bandLower && realised <= bandUpper;

  return {
    predictor: source.predictor,
    decisionId: subject.decisionId ?? null,
    commitmentId: subject.commitmentId ?? null,
    legId: subject.legId ?? null,
    agentId: subject.agentId ?? null,
    shardId: slice.shardId ?? null,
    zoneId: slice.zoneId ?? null,
    missionClass: slice.missionClass ?? null,
    agentClassId: slice.agentClassId ?? null,
    timeBucket: Number.isFinite(slice.timeBucket) ? slice.timeBucket : null,
    unit: source.unit,
    predicted,
    realised,
    signedError,
    bandLower,
    bandUpper,
    withinBand,
    tier: source.tier ?? null,
    claimedProbability: Number.isFinite(source.claimedProbability) ? source.claimedProbability : null,
    eventOccurred: typeof source.eventOccurred === "boolean" ? source.eventOccurred : null,
    tailQuantile: Number.isFinite(source.tailQuantile) ? source.tailQuantile : null,
    predictedAt: new Date(source.predictedAtMs),
    observedAt: new Date(source.observedAtMs),
  };
}

/**
 * Bias — the mean signed error. Positive means reality ran **above** the prediction.
 *
 * Reported both absolutely, in the predictor's own unit, and relative to the mean
 * prediction, because §21.5's own example is relative ("drifted 20 % above prediction")
 * while the quantity that drives a refit is absolute.
 *
 * @param {object[]} observations
 * @returns {{ n: number, meanSignedError: number|null, meanPredicted: number|null,
 *             relativeBias: number|null, unit: string|null }}
 */
function bias(observations) {
  const rows = (observations || []).filter((row) => Number.isFinite(row.signedError) && Number.isFinite(row.predicted));
  if (rows.length === 0) return { n: 0, meanSignedError: null, meanPredicted: null, relativeBias: null, unit: null };

  const sumError = rows.reduce((total, row) => total + row.signedError, 0);
  const sumPredicted = rows.reduce((total, row) => total + row.predicted, 0);
  const meanSignedError = sumError / rows.length;
  const meanPredicted = sumPredicted / rows.length;

  return {
    n: rows.length,
    meanSignedError,
    meanPredicted,
    // Undefined rather than infinite when the mean prediction is zero: a relative bias
    // against a zero baseline is not a large number, it is not a number.
    relativeBias: meanPredicted === 0 ? null : meanSignedError / meanPredicted,
    unit: rows[0].unit ?? null,
  };
}

/**
 * Dispersion — the error spread, and the band coverage it is supposed to produce.
 *
 * §21.5 makes dispersion an input to reserve width and `p_late`, so the coverage is
 * reported beside the spread: a predictor whose 80 % band contains 50 % of outcomes is
 * feeding an energy reserve a confidence it does not have, and the spread alone would
 * not say so.
 *
 * @param {object[]} observations
 * @returns {object}
 */
function dispersion(observations) {
  const rows = (observations || []).filter((row) => Number.isFinite(row.signedError));
  if (rows.length === 0) return { n: 0, standardDeviation: null, meanAbsoluteError: null, bandCoverage: null, unit: null };

  const mean = rows.reduce((total, row) => total + row.signedError, 0) / rows.length;
  // @structural the exponent in the definition of variance, not a tuning parameter
  const variance = rows.reduce((total, row) => total + (row.signedError - mean) ** 2, 0) / rows.length;
  const meanAbsoluteError = rows.reduce((total, row) => total + Math.abs(row.signedError), 0) / rows.length;

  const banded = rows.filter((row) => typeof row.withinBand === "boolean");
  const bandCoverage = banded.length === 0 ? null : banded.filter((row) => row.withinBand === true).length / banded.length;

  return {
    n: rows.length,
    standardDeviation: Math.sqrt(variance),
    meanAbsoluteError,
    bandCoverage,
    bandSampleCount: banded.length,
    unit: rows[0].unit ?? null,
    drives: "uncertainty band width, which drives reserves and p_late (§21.5)",
  };
}

/**
 * Probabilistic calibration for one shortfall tier, **by that tier's own instrument**.
 *
 * @param {object} input
 * @param {string} input.tier `T1` | `T2` | `T3`
 * @param {object[]} input.observations
 * @param {number} [input.windowSeconds] `observability.calibration_tier_window[tier]`
 * @param {number} [input.minSamples] `observability.calibration_min_samples`
 * @returns {object}
 */
function probabilisticCalibration(input) {
  const source = input || {};
  const tier = String(source.tier);
  const plan = INSTRUMENT_BY_TIER[tier];
  const rows = (source.observations || []).filter((row) => row.tier === tier);

  if (!plan) {
    return { tier, ok: false, instrument: null, reason: `"${tier}" is not one of the three §14.5 shortfall tiers` };
  }

  const base = {
    tier,
    instrument: plan.instrument,
    timescale: plan.timescale,
    why: plan.why,
    n: rows.length,
    windowSeconds: Number.isFinite(source.windowSeconds) ? source.windowSeconds : null,
    sufficientSample: Number.isFinite(source.minSamples) ? rows.length >= source.minSamples : null,
  };

  if (plan.instrument === INSTRUMENT.EVENT_COUNT) {
    const scored = rows.filter((row) => typeof row.eventOccurred === "boolean" && Number.isFinite(row.claimedProbability));
    if (scored.length === 0) return { ...base, ok: false, observedFrequency: null, claimedProbability: null, reason: "no scored observations" };
    const observedFrequency = scored.filter((row) => row.eventOccurred === true).length / scored.length;
    const claimed = scored.reduce((total, row) => total + row.claimedProbability, 0) / scored.length;
    return {
      ...base,
      ok: true,
      n: scored.length,
      observedFrequency,
      claimedProbability: claimed,
      // Positive means reality produced the event **more** often than claimed, which is
      // the direction that matters: either the model is miscalibrated or F34 is
      // misimplemented, and both are serious (§26 I17).
      excess: observedFrequency - claimed,
    };
  }

  // T3 — tail calibration. The statistic is whether the realised values fall uniformly
  // across the predictive distribution's quantiles: a correctly shaped tail puts a
  // fraction `q` of outcomes below quantile `q`, for every `q`, including the far tail
  // where the events themselves are too rare to count.
  const quantiles = rows.map((row) => row.tailQuantile).filter((value) => Number.isFinite(value));
  if (quantiles.length === 0) {
    return {
      ...base,
      ok: false,
      reason:
        "no tail quantiles recorded. This tier is deliberately NOT scored by counting events: " + plan.why,
      observedFrequencyDeliberatelyNotComputed: true,
    };
  }

  // Kolmogorov–Smirnov distance from uniform: the largest gap between the empirical
  // quantile distribution and the diagonal. One number, and it is the whole test.
  const sorted = [...quantiles].sort((a, b) => a - b);
  let maxGap = 0;
  for (let index = 0; index < sorted.length; index += 1) {
    const empiricalBelow = index / sorted.length;
    const empiricalAtOrBelow = (index + 1) / sorted.length;
    maxGap = Math.max(maxGap, Math.abs(sorted[index] - empiricalBelow), Math.abs(sorted[index] - empiricalAtOrBelow));
  }

  // The upper decile, reported separately: a distribution can be well calibrated in the
  // body and wrong in exactly the tail F34's T3 target lives in.
  // @structural the upper decile boundary, naming which part of the range is "the tail"
  const TAIL_FROM = 0.9;
  const tail = sorted.filter((value) => value >= TAIL_FROM);
  const expectedTailFraction = 1 - TAIL_FROM;
  const observedTailFraction = sorted.length === 0 ? null : tail.length / sorted.length;

  return {
    ...base,
    ok: true,
    n: sorted.length,
    ksDistanceFromUniform: maxGap,
    observedTailFraction,
    expectedTailFraction,
    tailExcess: observedTailFraction === null ? null : observedTailFraction - expectedTailFraction,
    observedFrequencyDeliberatelyNotComputed: true,
  };
}

/**
 * Score one slice for a drift alarm (§21.5's fourth bullet).
 *
 * @param {object} input
 * @param {object[]} input.observations one slice's observations
 * @param {object} input.slice the dimension values identifying it
 * @param {number} input.biasAlarm `observability.calibration_bias_alarm`
 * @param {number} input.minSamples `observability.calibration_min_samples`
 * @returns {object}
 */
function driftAlarm(input) {
  const source = input || {};
  const scored = bias(source.observations);
  const spread = dispersion(source.observations);

  const enough = scored.n >= (Number.isFinite(source.minSamples) ? source.minSamples : 0);
  const alarm =
    enough && scored.relativeBias !== null && Number.isFinite(source.biasAlarm)
      ? Math.abs(scored.relativeBias) >= source.biasAlarm
      : false;

  return {
    slice: source.slice || {},
    n: scored.n,
    sufficientSample: enough,
    relativeBias: scored.relativeBias,
    meanSignedError: scored.meanSignedError,
    standardDeviation: spread.standardDeviation,
    bandCoverage: spread.bandCoverage,
    threshold: Number.isFinite(source.biasAlarm) ? source.biasAlarm : null,
    alarm,
    // The operational reading §21.5 asks for. Drift is not only a model problem: "a
    // route whose realised travel time has drifted 20 % above prediction indicates
    // roadworks, a new signal, or seasonal congestion, and detecting that automatically
    // is operationally valuable in its own right."
    interpretation: !enough
      ? "not enough observations in this slice to say anything"
      : alarm
        ? scored.relativeBias > 0
          ? "reality is running slower/heavier than predicted in this slice — refit, and look for a physical cause"
          : "reality is running faster/lighter than predicted in this slice — the predictor is conservative here"
        : "within tolerance",
  };
}

/**
 * Group observations into §21.5's slices.
 *
 * @param {object[]} observations
 * @param {string[]} [dimensions]
 * @returns {Map<string, { slice: object, observations: object[] }>}
 */
function bySlice(observations, dimensions) {
  const dims = dimensions && dimensions.length > 0 ? dimensions : SLICE_DIMENSIONS;
  const groups = new Map();
  for (const row of observations || []) {
    const slice = {};
    for (const dimension of dims) slice[dimension] = row[dimension] ?? null;
    const key = dims.map((dimension) => String(slice[dimension])).join("|");
    if (!groups.has(key)) groups.set(key, { slice, observations: [] });
    groups.get(key).observations.push(row);
  }
  return groups;
}

/**
 * Score every predictor over a window, sliced, with drift alarms and — for
 * `ENERGY_SHORTFALL` — the per-tier probabilistic calibration at each tier's own
 * timescale.
 *
 * @param {object} deps `{ prisma }`
 * @param {object} input `{ fromMs, toMs, config, shardId, dimensions }`
 * @returns {Promise<object>}
 */
async function score(deps, input) {
  const source = input || {};
  const toMs = Number.isFinite(source.toMs) ? source.toMs : 0;
  const fromMs = Number.isFinite(source.fromMs) ? source.fromMs : 0;
  const read = (name) => (source.config && typeof source.config.get === "function" ? source.config.get(name) : null);

  const biasAlarm = read("observability.calibration_bias_alarm");
  const minSamples = read("observability.calibration_min_samples");
  const tierWindows = read("observability.calibration_tier_window") || {};

  const where = {
    observedAt: { gte: new Date(fromMs), lt: new Date(toMs) },
    ...(source.shardId ? { shardId: source.shardId } : {}),
  };

  const observations = await deps.prisma.calibrationObservation.findMany({ where });

  const predictors = [];
  for (const predictor of PREDICTORS) {
    const rows = observations.filter((row) => row.predictor === predictor);
    const slices = [...bySlice(rows, source.dimensions).values()]
      .map((group) => driftAlarm({ observations: group.observations, slice: group.slice, biasAlarm, minSamples }))
      .sort((a, b) => compareStrings(JSON.stringify(a.slice), JSON.stringify(b.slice)));

    predictors.push({
      predictor,
      n: rows.length,
      bias: bias(rows),
      dispersion: dispersion(rows),
      slices,
      alarms: slices.filter((slice) => slice.alarm).length,
    });
  }

  // I17's statistical half, per tier, each by its own instrument over its own window.
  const shortfall = observations.filter((row) => row.predictor === PREDICTOR.ENERGY_SHORTFALL);
  const tiers = Object.keys(INSTRUMENT_BY_TIER).map((tier) => {
    const windowSeconds = Number.isFinite(tierWindows[tier]) ? tierWindows[tier] : null;
    const tierFrom = windowSeconds === null ? fromMs : toMs - windowSeconds * MS_PER_SECOND;
    const rows = shortfall.filter((row) => {
      const at = row.observedAt instanceof Date ? row.observedAt.getTime() : Number(row.observedAt);
      return at >= tierFrom && at < toMs;
    });
    return probabilisticCalibration({ tier, observations: rows, windowSeconds, minSamples });
  });

  return {
    window: { fromMs, toMs, shardId: source.shardId ?? null },
    thresholds: { biasAlarm, minSamples, tierWindows },
    predictors,
    energyShortfallTiers: tiers,
    totalAlarms: predictors.reduce((total, row) => total + row.alarms, 0),
  };
}

module.exports = {
  PREDICTOR,
  PREDICTORS,
  SLICE_DIMENSIONS,
  INSTRUMENT,
  INSTRUMENT_BY_TIER,
  observationFrom,
  bias,
  dispersion,
  probabilisticCalibration,
  driftAlarm,
  bySlice,
  score,
};
