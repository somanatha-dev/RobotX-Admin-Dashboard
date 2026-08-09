"use strict";

/**
 * The Forecast Service client (§5.2, §8.3.1) — **Tier 2**, mechanism T2-06.
 *
 * > | Forecast Service | Demand forecast for opportunity cost | 200 ms | soft | Use last
 * > good forecast; then a seasonal-baseline prior; then flat | Opportunity-cost term
 * > shrinks toward its configured prior; **recorded as a degradation flag** |
 *
 * The ladder is the contract, so it is data here rather than a chain of `if`s: three named
 * sources, each with the envelope reduction it implies, and every resolution carrying which
 * rung it came from. §5.2's own framing is the reason —
 *
 * > Without a pre-declared degradation behaviour, a dependency outage becomes an
 * > improvisation.
 *
 * ── What a forecast is for ─────────────────────────────────────────────────
 * §8.3.1's primary estimator needs three quantities per zone and time bucket:
 *
 * > From the forecast arrival rate `Λ(z,τ)`, projected available supply `S(z,τ)`, and a
 * > fitted response-time-versus-supply curve `R(z, S)`, take `λ = Λ · ∂(delay cost)/∂S`.
 * > Because `R` is convex decreasing in `S`, this is large when supply is scarce relative
 * > to demand and small when supply is ample — exactly the desired behaviour.
 *
 * This module supplies those three and nothing else; `capacityPricingClient.js` turns them
 * into `λ_zone`. The split is deliberate: the forecast is an input the engine consumes and
 * the price is a quantity the Capacity Pricing Service publishes, and collapsing the two
 * would put the engine in the business of estimating its own prices — which is exactly the
 * boundary §1.6 draws.
 *
 * ── This is an L1 dependency client ────────────────────────────────────────
 * It reads a service the engine does not own and does not run inside a round: the round
 * consumes the *pinned* forecast its snapshot names. Nothing here is a decision-path
 * function, and the version is what the decision record cites.
 *
 * Determinism: no clock. Staleness is measured against the round's pinned decision time,
 * exactly as `energy/eReturn.js` measures the charger projection's.
 */

/** @structural milliseconds in one second */
const MS_PER_SECOND = 1000;

/**
 * §5.2's ladder for this dependency, most preferred first.
 * @structural §5.2's own three-rung fallback for the Forecast Service
 */
const SOURCE = Object.freeze({
  LIVE: "LIVE_FORECAST",
  LAST_GOOD: "LAST_GOOD_FORECAST",
  SEASONAL_BASELINE: "SEASONAL_BASELINE_PRIOR",
  FLAT: "FLAT",
});

const LADDER = Object.freeze([SOURCE.LIVE, SOURCE.LAST_GOOD, SOURCE.SEASONAL_BASELINE, SOURCE.FLAT]);

/** The envelope reduction each rung implies (§5.2). */
const ENVELOPE = Object.freeze({
  [SOURCE.LIVE]: "none",
  [SOURCE.LAST_GOOD]:
    "opportunity-cost term shrinks toward its configured prior in proportion to the forecast's age",
  [SOURCE.SEASONAL_BASELINE]: "opportunity-cost term is driven by the seasonal baseline, not by live demand",
  [SOURCE.FLAT]:
    "opportunity-cost term stops discriminating between zones on demand; only the terminal-value " +
    "components still vary, and the degradation flag says so",
});

/** The three quantities §8.3.1's primary estimator needs. */
const REQUIRED_SERIES = Object.freeze(["arrivalRate", "projectedSupply", "responseCurve"]);

/**
 * @structural a secant needs two points; a slope cannot be taken from fewer, and this is
 * the arity of the difference rather than a fitting window anybody would tune
 */
const MIN_CURVE_POINTS = 2;

/**
 * @param {*} value
 * @returns {boolean}
 */
function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Validate a forecast at the boundary, before anything is computed against it.
 *
 * @param {object} forecast
 * @returns {{ ok: boolean, forecast: object|null, problems: string[] }}
 */
function consume(forecast) {
  const problems = [];
  if (!forecast || typeof forecast !== "object") {
    return { ok: false, forecast: null, problems: ["no forecast supplied"] };
  }
  if (forecast.version === null || forecast.version === undefined || forecast.version === "") {
    problems.push(
      "the forecast carries no version. §9.6 requires the round to pin its inputs by version; a " +
        "forecast that cannot be named cannot be replayed against",
    );
  }
  if (!isNumber(forecast.publishedAtMs)) problems.push("the forecast carries no publication time");
  if (!forecast.zones || typeof forecast.zones !== "object") problems.push("the forecast publishes no zones");

  if (problems.length > 0) return { ok: false, forecast: null, problems };

  const zones = {};
  for (const zoneId of Object.keys(forecast.zones).sort()) {
    const zone = forecast.zones[zoneId] || {};
    const missing = REQUIRED_SERIES.filter((name) => zone[name] === undefined || zone[name] === null);
    if (missing.length > 0) {
      problems.push(`zone "${zoneId}" is missing ${missing.join(", ")}`);
      continue;
    }
    zones[zoneId] = Object.freeze({
      arrivalRate: zone.arrivalRate,
      projectedSupply: zone.projectedSupply,
      responseCurve: zone.responseCurve,
    });
  }

  if (problems.length > 0) return { ok: false, forecast: null, problems };

  return {
    ok: true,
    forecast: Object.freeze({
      version: forecast.version,
      publishedAtMs: forecast.publishedAtMs,
      bucketSeconds: forecast.bucketSeconds ?? null,
      zones: Object.freeze(zones),
    }),
    problems: [],
  };
}

/**
 * How stale is a forecast at the round's pinned decision time?
 *
 * @param {object} forecast
 * @param {number} decisionTimeMs
 * @param {number} maxAgeSeconds
 * @returns {{ ok: boolean, ageSeconds: number|null, stale: boolean, reason: string|null }}
 */
function staleness(forecast, decisionTimeMs, maxAgeSeconds) {
  if (!forecast || !isNumber(forecast.publishedAtMs) || !isNumber(decisionTimeMs)) {
    return { ok: false, ageSeconds: null, stale: true, reason: "the forecast's age cannot be established" };
  }
  if (forecast.publishedAtMs > decisionTimeMs) {
    // A forecast dated after the round is not fresh — it is a clock disagreement, and
    // trusting it would let a skewed publisher present arbitrarily fresh data. The same
    // refusal `energy/eReturn.js` makes about the charger projection.
    return {
      ok: false,
      ageSeconds: null,
      stale: true,
      reason: "the forecast is dated after the round's decision time (§10.6 clock discipline)",
    };
  }
  const ageSeconds = (decisionTimeMs - forecast.publishedAtMs) / MS_PER_SECOND;
  const stale = isNumber(maxAgeSeconds) ? ageSeconds > maxAgeSeconds : false;
  return {
    ok: true,
    ageSeconds,
    stale,
    reason: stale ? `the forecast is ${ageSeconds} s old, beyond its maximum age` : null,
  };
}

/**
 * Walk §5.2's ladder and return the best available forecast with the rung it came from.
 *
 * @param {object} input
 * @param {object} [input.live]
 * @param {object} [input.lastGood]
 * @param {object} [input.seasonalBaseline]
 * @param {number} input.decisionTimeMs
 * @param {number} input.maxAgeSeconds
 * @returns {{ ok: boolean, source: string, forecast: object|null, degradation: object|null,
 *             problems: string[] }}
 */
function resolve(input) {
  const source = input || {};
  const problems = [];

  const attempts = [
    [SOURCE.LIVE, source.live],
    [SOURCE.LAST_GOOD, source.lastGood],
    [SOURCE.SEASONAL_BASELINE, source.seasonalBaseline],
  ];

  for (const [rung, candidate] of attempts) {
    if (!candidate) continue;
    const consumed = consume(candidate);
    if (!consumed.ok) {
      problems.push(`${rung}: ${consumed.problems.join("; ")}`);
      continue;
    }
    // Staleness demotes the live rung to `LAST_GOOD` rather than discarding it: a forecast
    // that is merely old is still the best information available, and §5.2's degradation is
    // that the term shrinks toward its prior, not that it vanishes.
    const age = staleness(consumed.forecast, source.decisionTimeMs, source.maxAgeSeconds);
    const effective = rung === SOURCE.LIVE && (!age.ok || age.stale) ? SOURCE.LAST_GOOD : rung;

    return {
      ok: true,
      source: effective,
      forecast: consumed.forecast,
      degradation:
        effective === SOURCE.LIVE
          ? null
          : Object.freeze({
              dependency: "Forecast Service",
              source: effective,
              envelopeReduction: ENVELOPE[effective],
              ageSeconds: age.ageSeconds,
              reason: age.reason || `the ${rung} rung of §5.2's ladder was used`,
            }),
      problems,
    };
  }

  return {
    ok: true,
    source: SOURCE.FLAT,
    forecast: null,
    degradation: Object.freeze({
      dependency: "Forecast Service",
      source: SOURCE.FLAT,
      envelopeReduction: ENVELOPE[SOURCE.FLAT],
      ageSeconds: null,
      reason: "no forecast at any rung of §5.2's ladder; the opportunity term falls back to configured priors",
    }),
    problems,
  };
}

/**
 * `∂(delay cost)/∂S` at the forecast's projected supply, from the fitted
 * response-time-versus-supply curve.
 *
 * > Because `R` is convex decreasing in `S`, this is large when supply is scarce relative
 * > to demand and small when supply is ample.
 *
 * The derivative is taken as a one-sided finite difference over the curve's own published
 * points rather than by fitting a functional form: the curve is empirical and per zone
 * (§8.3.1), and choosing a parametric family here would introduce a modelling assumption
 * the specification does not make.
 *
 * @param {Array<{supply: number, delayCostCu: number}>} responseCurve
 * @param {number} supply `S(z,τ)`
 * @returns {{ ok: boolean, derivative: number|null, convexDecreasing: boolean, reason: string|null }}
 */
function delayCostSlope(responseCurve, supply) {
  if (!Array.isArray(responseCurve) || responseCurve.length < MIN_CURVE_POINTS) {
    return { ok: false, derivative: null, convexDecreasing: false, reason: "the response curve has fewer than two points" };
  }
  if (!isNumber(supply)) {
    return { ok: false, derivative: null, convexDecreasing: false, reason: "projected supply is unresolved" };
  }

  const points = [...responseCurve].sort((a, b) => a.supply - b.supply);

  let decreasing = true;
  let convex = true;
  for (let index = 1; index < points.length; index += 1) {
    if (points[index].delayCostCu > points[index - 1].delayCostCu) decreasing = false;
  }
  // Convexity is a property of consecutive *pairs* of secants, so the scan starts at the
  // third point and looks two back. Both offsets are the arity of a secant pair, not a
  // tunable window.
  for (let index = MIN_CURVE_POINTS; index < points.length; index += 1) {
    const previous = index - MIN_CURVE_POINTS;
    const first =
      (points[index - 1].delayCostCu - points[previous].delayCostCu) /
      (points[index - 1].supply - points[previous].supply);
    const second =
      (points[index].delayCostCu - points[index - 1].delayCostCu) /
      (points[index].supply - points[index - 1].supply);
    if (second < first) convex = false;
  }

  let lower = points[0];
  let upper = points[points.length - 1];
  for (let index = 1; index < points.length; index += 1) {
    if (points[index - 1].supply <= supply && points[index].supply >= supply) {
      lower = points[index - 1];
      upper = points[index];
      break;
    }
  }

  if (upper.supply === lower.supply) {
    return { ok: false, derivative: null, convexDecreasing: decreasing && convex, reason: "the curve is degenerate at this supply" };
  }

  return {
    ok: true,
    derivative: (upper.delayCostCu - lower.delayCostCu) / (upper.supply - lower.supply),
    convexDecreasing: decreasing && convex,
    reason: null,
  };
}

module.exports = {
  MS_PER_SECOND,
  SOURCE,
  LADDER,
  ENVELOPE,
  REQUIRED_SERIES,
  MIN_CURVE_POINTS,
  consume,
  staleness,
  resolve,
  delayCostSlope,
};
