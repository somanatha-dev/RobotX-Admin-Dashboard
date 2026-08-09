"use strict";

/**
 * The §24.6 scale harness.
 *
 * > - Round time versus shard size, candidate count, and batch size, measured against
 * >   §20.1.
 * > - **The locality test:** identical benchmarks against a shard in a small fleet and a
 * >   shard in a million-agent fleet MUST produce statistically indistinguishable round
 * >   times. This is the direct verification of T9, and its failure invalidates the
 * >   scaling claim.
 * > - Soak tests over days to expose leaks, unbounded caches, timer accumulation, and
 * >   queue drift.
 * > - Load tests through overload to verify admission control and graceful shedding rather
 * >   than collapse.
 *
 * ── The honest statement about what a repository can measure ───────────────
 * §20.1's targets are stated "per shard, at the 99th percentile, under nominal
 * (non-degraded) operation" and are "requirements for the release gate, not aspirations".
 * A repository cannot produce a million agents, days of wall clock, or production-shaped
 * traffic. This harness therefore measures **two different things**, and never lets them
 * be mistaken for each other:
 *
 *   1. **Complexity and locality, structurally.** How the measured quantity *scales* with
 *      the input, on this machine. `scaling()` fits an exponent and reports it, so
 *      "candidate generation is linear in the ring size" is a checked claim rather than a
 *      timing that happens to be small on a fast laptop. This is the half that is
 *      machine-independent, and it is the half that catches a real regression: an
 *      accidental O(n²) shows up as an exponent near 2 whatever the hardware.
 *   2. **Absolute latency against §20.1**, reported but **not asserted as the gate**.
 *      Asserting a 250 ms p99 on unknown CI hardware produces a test that is flaky on a
 *      slow runner and vacuous on a fast one — and a release gate that is routinely
 *      re-run until green is not a gate. `measureAgainstTarget()` returns the attainment
 *      and the target so the number is recorded, and the `scale_targets` release gate in
 *      `src/engine/cutover/gates.js` is discharged by a run on **representative
 *      hardware**, which is the only kind of run that can discharge it.
 *
 * The soak profile is the same distinction again: `soak()` runs a long loop and checks for
 * **unbounded growth** — a leak, a timer table that never shrinks, a queue that drifts —
 * which is a shape rather than a duration, and is the property days of running would
 * reveal. It is not days of running, and `release.soak_duration` names what is.
 *
 * ── Timing discipline ──────────────────────────────────────────────────────
 * Every measurement discards a warm-up, takes the median of repeated trials rather than
 * the mean, and reports the sample count. A single timing on a machine with a garbage
 * collector is not a measurement.
 */

/** @structural trials discarded before measurement, to let the JIT settle */
const WARMUP_TRIALS = 3;

/** @structural how many measured trials each data point takes */
const TRIALS = 7;

/**
 * Median of an array. Median rather than mean, deliberately: one GC pause during a run
 * moves a mean and does not move a median, and a scale test that a GC pause can fail is a
 * scale test that will be ignored.
 *
 * @param {number[]} values
 * @returns {number}
 */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/**
 * Time one operation, discarding a warm-up and taking the median.
 *
 * @param {() => void} operation
 * @param {{ trials?: number, warmup?: number }} [options]
 * @returns {{ medianMs: number, trials: number, samples: number[] }}
 */
function timed(operation, options) {
  const settings = options || {};
  const warmup = settings.warmup === undefined ? WARMUP_TRIALS : settings.warmup;
  const trials = settings.trials === undefined ? TRIALS : settings.trials;

  for (let index = 0; index < warmup; index += 1) operation();

  const samples = [];
  for (let index = 0; index < trials; index += 1) {
    const started = process.hrtime.bigint();
    operation();
    const elapsed = process.hrtime.bigint() - started;
    // @structural nanoseconds per millisecond
    samples.push(Number(elapsed) / 1e6);
  }

  return { medianMs: median(samples), trials, samples };
}

/**
 * Time two operations **interleaved**, so both see the same machine conditions.
 *
 * The locality test compares two timings and asks whether they are indistinguishable. Timed
 * back to back, arm A can land inside a garbage-collection pause that arm B misses, and the
 * comparison then reports a divergence that is a property of the runtime rather than of the
 * thing under test — which is how a release gate becomes a test people re-run until it
 * passes. Interleaving the trials (A, B, A, B, …) puts any drift into both arms, and the
 * median over the interleaved samples cancels it.
 *
 * @param {() => void} left
 * @param {() => void} right
 * @param {{ trials?: number, warmup?: number }} [options]
 * @returns {{ left: { medianMs: number }, right: { medianMs: number }, trials: number }}
 */
function interleaved(left, right, options) {
  const settings = options || {};
  const warmup = settings.warmup === undefined ? WARMUP_TRIALS : settings.warmup;
  const trials = settings.trials === undefined ? TRIALS : settings.trials;

  for (let index = 0; index < warmup; index += 1) {
    left();
    right();
  }

  const leftSamples = [];
  const rightSamples = [];
  for (let index = 0; index < trials; index += 1) {
    let started = process.hrtime.bigint();
    left();
    // @structural nanoseconds per millisecond
    leftSamples.push(Number(process.hrtime.bigint() - started) / 1e6);

    started = process.hrtime.bigint();
    right();
    rightSamples.push(Number(process.hrtime.bigint() - started) / 1e6);
  }

  // The measurement's own noise floor: the relative spread *within* one arm, over the same
  // trials. It is what makes the comparison self-calibrating — see `noiseFloor` below.
  const spread = (samples) => {
    const sorted = [...samples].sort((a, b) => a - b);
    const low = sorted[Math.floor(sorted.length * 0.25)];
    const high = sorted[Math.floor(sorted.length * 0.75)];
    const centre = median(sorted);
    return centre === 0 ? 0 : (high - low) / centre;
  };

  return {
    left: { medianMs: median(leftSamples), samples: leftSamples },
    right: { medianMs: median(rightSamples), samples: rightSamples },
    trials,
    /**
     * The largest relative difference this run could not have resolved anyway.
     *
     * "Statistically indistinguishable" (§24.6) is not a fixed number: two timings cannot be
     * told apart below the measurement's own noise, and on a loaded machine that floor rises.
     * A locality test that compared against a fixed tolerance therefore fails on a busy CI
     * runner while measuring nothing — which is precisely how a release gate becomes a test
     * people re-run until it passes. Observed here twice before this was added.
     *
     * The floor is the wider of the two arms' interquartile spreads. It never *hides* a real
     * divergence: a genuine locality failure is a systematic shift of one arm's centre, which
     * moves the medians apart without widening either arm's own spread.
     */
    noiseFloor: Math.max(spread(leftSamples), spread(rightSamples)),
  };
}

/**
 * Fit a power law `t = k · n^exponent` across measured sizes, by least squares on the logs.
 *
 * The exponent is what the complexity claim is *about*. §20.2 states the intended
 * complexity of each stage; this turns "candidate generation is O(c + k log k)" into a
 * number a test can assert a bound on, independently of how fast the machine is.
 *
 * @param {{ size: number, medianMs: number }[]} points
 * @returns {{ exponent: number, points: object[], rSquared: number }}
 */
function scaling(points) {
  const usable = points.filter((point) => point.size > 0 && point.medianMs > 0);
  if (usable.length < 2) return { exponent: null, points, rSquared: null };

  const xs = usable.map((point) => Math.log(point.size));
  const ys = usable.map((point) => Math.log(point.medianMs));
  const meanX = xs.reduce((sum, value) => sum + value, 0) / xs.length;
  const meanY = ys.reduce((sum, value) => sum + value, 0) / ys.length;

  let covariance = 0;
  let varianceX = 0;
  for (let index = 0; index < xs.length; index += 1) {
    covariance += (xs[index] - meanX) * (ys[index] - meanY);
    varianceX += (xs[index] - meanX) ** 2;
  }
  const exponent = varianceX === 0 ? null : covariance / varianceX;

  // How well the power law describes the data. A low r² means the timing is dominated by
  // something other than the input size — noise, or a constant — and an exponent read off
  // such a fit is not evidence of anything, which is why it is reported beside it.
  let residual = 0;
  let total = 0;
  for (let index = 0; index < xs.length; index += 1) {
    const predicted = meanY + exponent * (xs[index] - meanX);
    residual += (ys[index] - predicted) ** 2;
    total += (ys[index] - meanY) ** 2;
  }
  const rSquared = total === 0 ? null : 1 - residual / total;

  return { exponent, points: usable, rSquared };
}

/**
 * Measure an operation across a range of sizes and fit the scaling exponent.
 *
 * @param {number[]} sizes
 * @param {(size: number) => () => void} build returns the operation for one size
 * @param {{ trials?: number }} [options]
 * @returns {{ exponent: number, rSquared: number, points: object[] }}
 */
function scalingOf(sizes, build, options) {
  const points = sizes.map((size) => {
    const operation = build(size);
    const { medianMs } = timed(operation, options);
    return { size, medianMs };
  });
  return scaling(points);
}

/**
 * Record a measurement against a §20.1 target without asserting it.
 *
 * The record is the point. §20.1's table is a release gate, and a gate discharged by a
 * number nobody wrote down is not discharged. `attained` is reported so a run on
 * representative hardware can be read directly from the test output.
 *
 * @param {{ id: string, target: number, unit: string, measuredMs: number, statistic: string }} input
 * @returns {object}
 */
function measureAgainstTarget(input) {
  const measured = input.unit === "µs" ? input.measuredMs * 1000 : input.measuredMs;
  return {
    id: input.id,
    statistic: input.statistic,
    target: input.target,
    unit: input.unit,
    measured,
    attained: measured <= input.target,
    // Stated on every row, because the row is otherwise indistinguishable from a
    // production measurement and would eventually be read as one.
    provenance:
      "measured on the build machine, not on representative production hardware. §20.1's targets are " +
      "per shard at p99 under nominal operation; this is a single-process median and is recorded as a " +
      "trend signal, not as the discharge of the release gate.",
  };
}

/**
 * Run a long loop and report whether a tracked quantity grew without bound.
 *
 * §24.6's soak looks for "leaks, unbounded caches, timer accumulation, and queue drift" —
 * every one of which is a *shape*, not a duration: something that grows monotonically with
 * iterations rather than settling. `soak()` samples the quantity in windows and compares
 * the last window against the first, so a value that settles passes at any length and one
 * that drifts fails at any length.
 *
 * @param {{ iterations: number, windows?: number, step: (index: number) => void, sample: () => number }} input
 * @returns {{ windows: number[], drift: number, bounded: boolean, iterations: number }}
 */
function soak(input) {
  const windows = input.windows || 4;
  const perWindow = Math.max(1, Math.floor(input.iterations / windows));
  const observed = [];

  for (let window = 0; window < windows; window += 1) {
    for (let step = 0; step < perWindow; step += 1) input.step(window * perWindow + step);
    observed.push(input.sample());
  }

  const first = observed[0];
  const last = observed[observed.length - 1];
  // Drift as a ratio rather than a difference, so the check is scale-free: a queue that
  // holds 10 items and one that holds 10 000 are both bounded if neither grows.
  const drift = first === 0 ? (last === 0 ? 0 : Infinity) : (last - first) / first;

  return { windows: observed, drift, bounded: Number.isFinite(drift) && drift <= 0, iterations: perWindow * windows };
}

module.exports = { WARMUP_TRIALS, TRIALS, median, timed, interleaved, scaling, scalingOf, measureAgainstTarget, soak };
