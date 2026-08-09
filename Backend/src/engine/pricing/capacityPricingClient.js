"use strict";

/**
 * The Capacity Pricing client (§5.2, §8.3.1) — **Tier 2**, mechanism T2-06, kill switch
 * `opportunity_cost_term`.
 *
 * > **`λ_zone(z, τ)`** — the marginal reduction in expected future operating cost obtained
 * > from having one additional *available* agent in zone `z` at time `τ`, in CU·s⁻¹,
 * > supplied by the Capacity Pricing Service. **This is the only quantity in the
 * > opportunity model that is estimated from data**; everything else is derived from it by
 * > integration.
 *
 * That sentence is the module's whole design constraint. One primitive enters the engine
 * here; `pricing/vTerminal.js` integrates it and `cost/cOpportunity.js` differences it, and
 * neither of them estimates anything. A second estimated quantity anywhere downstream would
 * reintroduce exactly the double-count §8.3.3(a) is written to prevent.
 *
 * ── §8.3.1's three estimators, in order of preference ──────────────────────
 * 1. **Forecast-driven queueing estimate (primary).** `λ = Λ · ∂(delay cost)/∂S` from the
 *    Forecast Service's arrival rate, projected supply, and fitted response curve.
 * 2. **Solver duals (calibration).** Used to *calibrate* estimator 1, never to drive the
 *    current decision — and their validity depends on the solve regime:
 *
 *    > in the **singleton-column regime** the relaxation is integral, so the duals are exact
 *    > marginal prices of the integer problem; in the **multi-Leg-column regime** the
 *    > relaxation is generally fractional, so the duals price the relaxation and are an
 *    > approximation. Calibration MUST either restrict itself to singleton-regime rounds or
 *    > **record the LP–IP gap alongside each dual it consumes**. Treating relaxation duals
 *    > as exact prices is an error the design declines to make silently.
 *
 *    `acceptDual()` enforces that: a dual from a column-regime round without a recorded gap
 *    is refused outright, not accepted with a caveat in a log line.
 * 3. **Static configured prices (degraded).** `cost.opportunity.lambda_zone_prior`.
 *
 * ── Why the surface is padded, and why that is not fabrication ─────────────
 * `vTerminal.vAvail()` refuses a surface that does not cover the valuation horizon, because
 * an integral truncated by a gap is not the same quantity as one truncated at `T_H`.
 * `padToHorizon()` is where the gap is closed — with the configured prior, which is §5.2's
 * own declared degradation for this dependency, and with the padded interval recorded so a
 * decision record can say how much of the value came from a published price and how much
 * from a prior. Padding silently would be fabrication; padding with the declared fallback
 * and reporting it is the degradation the contract specifies.
 *
 * ── `Ω_terminal` travels with the surface ──────────────────────────────────
 * > `Ω_terminal` … computed once per round from the same price snapshot the cost function
 * > uses (§8.3), **published by the Capacity Pricing Service alongside the price surface**.
 *
 * > Static per-zone `lambda_zone_prior` from config; **`Ω_terminal` recomputed from those
 * > static prices, so the bound stays admissible under degradation** (§5.2).
 *
 * `publish()` therefore derives `Ω_terminal` from whatever surface it is about to publish —
 * live, padded, or wholly prior-driven — so the two can never disagree. A bound computed
 * from a surface other than the one in use is the exact failure §6.4 calls "a false
 * guarantee already written into production decision records".
 *
 * ── This is an L1 dependency client ────────────────────────────────────────
 * Nothing here runs inside a round: a round consumes the *pinned* snapshot its own
 * `priceSnapshotVersion` names. The Redis mirror `engine:price:{version}` is a read-through
 * cache of an immutable, versioned artefact — never an authority.
 *
 * Determinism: no clock, no randomness. Ages are measured against the round's pinned
 * decision time.
 */

const vTerminal = require("./vTerminal");
const forecastClient = require("./forecastClient");

/** @structural milliseconds in one second */
const MS_PER_SECOND = 1000;

/** @structural the plan's own key prefix for the pinned λ_zone surface */
const KEY_PREFIX = "engine:price";

/**
 * §8.3.1's three estimators, in the specification's own order of preference.
 * @structural §8.3.1's own numbered list
 */
const ESTIMATOR = Object.freeze({
  FORECAST_QUEUEING: "FORECAST_QUEUEING",
  SOLVER_DUAL_CALIBRATION: "SOLVER_DUAL_CALIBRATION",
  STATIC_PRIOR: "STATIC_PRIOR",
});

/** The two solve regimes §9.3 defines, because a dual's meaning depends on which produced it. */
const REGIME = Object.freeze({
  SINGLETON: "SINGLETON",
  COLUMN: "COLUMN",
});

/**
 * @param {*} value
 * @returns {boolean}
 */
function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * The Redis mirror key for a pinned surface.
 *
 * @param {string|number} version
 * @returns {string}
 */
function key(version) {
  if (version === null || version === undefined || version === "") {
    throw new Error(
      "a price surface has no key without its version. §9.6 pins the round's price snapshot by version, " +
        "and an unversioned surface cannot be pinned, cited, or replayed against",
    );
  }
  return `${KEY_PREFIX}:${version}`;
}

/**
 * Estimator 1 — the forecast-driven queueing estimate.
 *
 * @param {object} input
 * @param {number} input.arrivalRate `Λ(z,τ)`
 * @param {number} input.projectedSupply `S(z,τ)`
 * @param {Array<{supply: number, delayCostCu: number}>} input.responseCurve `R(z, S)`
 * @returns {{ ok: boolean, lambdaCuPerSecond: number|null, convexDecreasing: boolean,
 *             reason: string|null }}
 */
function queueingEstimate(input) {
  const source = input || {};
  if (!isNumber(source.arrivalRate) || source.arrivalRate < 0) {
    return { ok: false, lambdaCuPerSecond: null, convexDecreasing: false, reason: "the arrival rate is unresolved" };
  }

  const slope = forecastClient.delayCostSlope(source.responseCurve, source.projectedSupply);
  if (!slope.ok) {
    return { ok: false, lambdaCuPerSecond: null, convexDecreasing: false, reason: slope.reason };
  }

  // `∂(delay cost)/∂S` is negative for a convex decreasing R — an extra agent *reduces*
  // delay cost — and λ_zone is the magnitude of that reduction. §8.3.3 depends on λ ≥ 0 for
  // the unavailability component to be non-negative, so the sign is taken here, once,
  // rather than left for a caller to guess.
  const lambda = Math.max(0, -slope.derivative * source.arrivalRate);

  return {
    ok: true,
    lambdaCuPerSecond: lambda,
    convexDecreasing: slope.convexDecreasing,
    reason: slope.convexDecreasing
      ? null
      : "the fitted response curve is not convex decreasing in supply; §8.3.1's estimator assumes it is, " +
        "and a non-convex fit means λ no longer rises as supply becomes scarce",
  };
}

/**
 * Estimator 2 — accept a solver dual **for calibration only**, with the §8.3.1 discipline.
 *
 * @param {object} dual `{ zoneId, valueCuPerSecond, regime, lpIpGapCu, roundId }`
 * @returns {{ ok: boolean, dual: object|null, reason: string|null }}
 */
function acceptDual(dual) {
  const source = dual || {};

  if (!isNumber(source.valueCuPerSecond)) {
    return { ok: false, dual: null, reason: "the dual carries no finite value" };
  }
  if (source.regime !== REGIME.SINGLETON && source.regime !== REGIME.COLUMN) {
    return {
      ok: false,
      dual: null,
      reason:
        "the dual does not name the solve regime it came from. §8.3.1 requires the regime to be recorded " +
        "with the dual, because the same number is an exact marginal price in one regime and an " +
        "approximation in the other",
    };
  }
  if (source.regime === REGIME.COLUMN && !isNumber(source.lpIpGapCu)) {
    return {
      ok: false,
      dual: null,
      reason:
        "a column-regime dual carries no LP–IP gap. §8.3.1: calibration MUST either restrict itself to " +
        "singleton-regime rounds or record the LP–IP gap alongside each dual it consumes. Treating a " +
        "relaxation dual as an exact price is an error the design declines to make silently",
    };
  }

  return {
    ok: true,
    dual: Object.freeze({
      zoneId: source.zoneId ?? null,
      valueCuPerSecond: source.valueCuPerSecond,
      regime: source.regime,
      lpIpGapCu: isNumber(source.lpIpGapCu) ? source.lpIpGapCu : null,
      roundId: source.roundId ?? null,
      exactMarginalPrice: source.regime === REGIME.SINGLETON,
      usage: "CALIBRATION_ONLY",
    }),
    reason: null,
  };
}

/**
 * Estimator 3 — the static configured prior for a zone and bucket.
 *
 * @param {object|Map} config
 * @param {string} zoneId
 * @param {string|number} bucket
 * @returns {number|null}
 */
function staticPrior(config, zoneId, bucket) {
  const read = (name) => {
    if (!config) return undefined;
    return config instanceof Map ? config.get(name) : config[name];
  };
  const priors = read("cost.opportunity.lambda_zone_prior");
  if (isNumber(priors)) return priors;
  if (!priors || typeof priors !== "object") return null;

  const byZone = priors[String(zoneId)];
  if (isNumber(byZone)) return byZone;
  if (byZone && typeof byZone === "object" && isNumber(byZone[String(bucket)])) return byZone[String(bucket)];
  return null;
}

/**
 * Extend a zone's buckets so the surface covers the valuation horizon, using the
 * configured prior and recording every padded interval.
 *
 * @param {object} input
 * @param {Array<object>} input.buckets
 * @param {number} input.fromMs
 * @param {number} input.horizonEndMs
 * @param {number} input.bucketSeconds
 * @param {number} input.priorCuPerSecond
 * @returns {{ ok: boolean, buckets: object[], padded: object[], reason: string|null }}
 */
function padToHorizon(input) {
  const source = input || {};
  if (!isNumber(source.priorCuPerSecond) || source.priorCuPerSecond < 0) {
    return {
      ok: false,
      buckets: [],
      padded: [],
      reason:
        "cost.opportunity.lambda_zone_prior is unresolved for this zone, so the surface cannot be padded. " +
        "§5.2 names the static prior as this dependency's declared degradation; without one there is no " +
        "declared behaviour to fall back to, and inventing a zero would understate every agent in the zone",
    };
  }

  const ordered = [...(source.buckets || [])].sort((a, b) => a.startMs - b.startMs);
  const padded = [];
  const result = [];

  let cursor = source.fromMs;
  for (const bucket of ordered) {
    if (bucket.startMs > cursor) {
      const filler = { startMs: cursor, endMs: bucket.startMs, lambdaCuPerSecond: source.priorCuPerSecond, padded: true };
      result.push(filler);
      padded.push(filler);
    }
    result.push({ ...bucket, padded: false });
    cursor = Math.max(cursor, bucket.endMs);
  }

  if (cursor < source.horizonEndMs) {
    const filler = {
      startMs: cursor,
      endMs: source.horizonEndMs,
      lambdaCuPerSecond: source.priorCuPerSecond,
      padded: true,
    };
    result.push(filler);
    padded.push(filler);
  }

  return { ok: true, buckets: result, padded, reason: null };
}

/**
 * Build the round's pinned price snapshot, with `Ω_terminal` derived from it.
 *
 * @param {object} input
 * @param {string|number} input.version
 * @param {number} input.publishedAtMs
 * @param {Record<string, Array<object>>} input.zones published buckets per zone
 * @param {string[]} input.requiredZoneIds every zone the round may value an agent in
 * @param {number} input.fromMs the earliest instant any evaluation will integrate from
 * @param {number} input.horizonEndMs `T_H`
 * @param {number} input.valueHorizonSeconds `cost.opportunity.value_horizon`
 * @param {object|Map} input.config
 * @param {string} input.estimator which of `ESTIMATOR` produced the surface
 * @param {number} input.maxChargeAccessGainCu
 * @param {number} input.maxSocDeficitGainCu
 * @returns {{ ok: boolean, snapshot: object|null, omegaTerminal: object|null,
 *             degradation: object|null, problems: string[] }}
 */
function publish(input) {
  const source = input || {};
  const problems = [];

  if (source.version === null || source.version === undefined || source.version === "") {
    problems.push("a price surface must carry a version; §9.6 pins the round's price snapshot by it");
  }
  if (!isNumber(source.fromMs) || !isNumber(source.horizonEndMs)) problems.push("fromMs and horizonEndMs");
  if (!Array.isArray(source.requiredZoneIds) || source.requiredZoneIds.length === 0) {
    problems.push("requiredZoneIds — the surface must state which zones it is complete for");
  }
  if (problems.length > 0) {
    return { ok: false, snapshot: null, omegaTerminal: null, degradation: null, problems };
  }

  const published = source.zones || {};
  const zones = {};
  const paddedZones = [];

  for (const zoneId of [...source.requiredZoneIds].map(String).sort()) {
    const prior = staticPrior(source.config, zoneId, source.bucket);
    const padding = padToHorizon({
      buckets: published[zoneId] || [],
      fromMs: source.fromMs,
      horizonEndMs: source.horizonEndMs,
      priorCuPerSecond: prior,
    });
    if (!padding.ok) {
      problems.push(`zone "${zoneId}": ${padding.reason}`);
      continue;
    }
    zones[zoneId] = padding.buckets;
    if (padding.padded.length > 0) {
      paddedZones.push({ zoneId, intervals: padding.padded.length, priorCuPerSecond: prior });
    }
  }

  if (problems.length > 0) {
    return { ok: false, snapshot: null, omegaTerminal: null, degradation: null, problems };
  }

  const snapshot = Object.freeze({
    version: source.version,
    publishedAtMs: source.publishedAtMs ?? null,
    source: source.estimator || ESTIMATOR.STATIC_PRIOR,
    horizonEndMs: source.horizonEndMs,
    zones: Object.freeze(zones),
    paddedZones: Object.freeze(paddedZones),
  });

  // Derived from the surface just built, never supplied. §6.4's admissibility argument is
  // about *this* surface, and a bound computed from another one would be a proof about a
  // price surface nobody used.
  const omega = vTerminal.omegaTerminal({
    snapshot,
    valueHorizonSeconds: source.valueHorizonSeconds,
    maxChargeAccessGainCu: source.maxChargeAccessGainCu,
    maxSocDeficitGainCu: source.maxSocDeficitGainCu,
  });
  if (!omega.ok) {
    return { ok: false, snapshot: null, omegaTerminal: null, degradation: null, problems: omega.problems };
  }

  const degradation =
    snapshot.source === ESTIMATOR.STATIC_PRIOR || paddedZones.length > 0
      ? Object.freeze({
          dependency: "Capacity Pricing",
          estimator: snapshot.source,
          paddedZones: paddedZones.length,
          envelopeReduction:
            "opportunity term shrinks toward its prior in the padded intervals; recorded as a degradation " +
            "flag, and Ω_terminal is recomputed from the same prices so the bound stays admissible (§5.2)",
        })
      : null;

  return { ok: true, snapshot, omegaTerminal: omega, degradation, problems: [] };
}

/**
 * Read a pinned surface through the Redis mirror, falling through to the caller's durable
 * loader.
 *
 * A read error is a miss, never a verdict: the surface's authority is the durable
 * `ZonePriceSnapshot` row, and the mirror only saves a query (I16).
 *
 * @param {object} deps `{ kv, load }`
 * @param {string|number} version
 * @returns {Promise<{ ok: boolean, snapshot: object|null, hit: boolean }>}
 */
async function read(deps, version) {
  const source = deps || {};
  if (source.kv && typeof source.kv.get === "function") {
    try {
      const raw = await source.kv.get(key(version));
      if (raw) return { ok: true, snapshot: JSON.parse(raw), hit: true };
    } catch {
      // A cache error is a miss. Falling through to the authority is always correct.
    }
  }
  if (typeof source.load !== "function") return { ok: false, snapshot: null, hit: false };
  const loaded = await source.load(version);
  return { ok: Boolean(loaded), snapshot: loaded || null, hit: false };
}

/**
 * Mirror a pinned surface into Redis. A write failure is silent for the same reason a read
 * error is a miss.
 *
 * @param {object} deps `{ kv }`
 * @param {object} snapshot
 * @param {number} ttlSeconds
 * @returns {Promise<boolean>}
 */
async function write(deps, snapshot, ttlSeconds) {
  const source = deps || {};
  if (!source.kv || typeof source.kv.set !== "function" || !snapshot) return false;
  try {
    await source.kv.set(key(snapshot.version), JSON.stringify(snapshot), "EX", ttlSeconds);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  MS_PER_SECOND,
  KEY_PREFIX,
  ESTIMATOR,
  REGIME,
  key,
  queueingEstimate,
  acceptDual,
  staticPrior,
  padToHorizon,
  publish,
  read,
  write,
};
