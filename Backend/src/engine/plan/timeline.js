"use strict";

/**
 * The plan timeline (§13.1, §13.2) — **Tier 1**, decision path.
 *
 * > Per-stop projected arrival, service start, service end, and departure times, **each
 * > with an uncertainty band**.
 *
 * > Every stop has an access window (business hours, dock booking, recipient availability,
 * > curfew) and a service-time distribution. Service time is *learned* per
 * > `(site, stop_type, mission_class, hour_of_week)` with **hierarchical shrinkage to
 * > broader cohorts when data is sparse**, because a busy office lobby with a lift, a
 * > kerbside handover, and a warehouse dock have service times that differ by an order of
 * > magnitude, and a single global constant guarantees systematic ETA error at every one
 * > of them.
 *
 * > Waiting is modelled explicitly: arriving before an access window opens produces wait
 * > time, which is priced at `λ_time` like any other committed time. **An agent that would
 * > arrive 20 minutes early is therefore correctly penalised rather than rewarded for being
 * > fast.**
 *
 * ── Hierarchical shrinkage, read side ──────────────────────────────────────
 * The fitter (`src/workers/serviceTimeModel.worker.js`) produces the cohort posteriors;
 * this module selects among them. The ladder runs from the most specific cohort to the
 * least, and the posterior at each level is a precision-weighted blend of the level's own
 * observations and its parent's mean:
 *
 * ```
 * w      = n / ( n + shrinkage_strength )
 * mean   = w · sample_mean + (1 − w) · parent_mean
 * ```
 *
 * A cohort with no observations therefore *is* its parent, continuously rather than by a
 * threshold rule. The alternative — a hard "use the cohort if `n ≥ k`" cut — produces an
 * ETA that jumps discontinuously the moment a site records its `k`-th delivery, which is a
 * step change in every downstream cost for no physical reason.
 *
 * ── Why the uncertainty band is not decoration ─────────────────────────────
 * §8.4 prices `p_late` "from the ETA predictive distribution, not the point estimate", so
 * an agent with a high-variance ETA is penalised relative to an equally-fast, more
 * predictable one. That penalty exists only if a variance is actually produced here.
 * Travel and service variances compose in quadrature, which assumes they are independent —
 * a stated modelling choice, and the conservative direction is the opposite one, so it is
 * recorded rather than assumed away.
 *
 * ── Determinism (T6) ───────────────────────────────────────────────────────
 * No clock. `hourOfWeek()` derives the cohort key arithmetically from epoch milliseconds
 * and a site's UTC offset rather than constructing a `Date`, both because the tenet gate
 * forbids `new Date()` in the decision path and because a host-local calendar would make
 * the same round produce different cohort keys in two regions.
 */

// The standard normal CDF, borrowed from the energy model so that the ETA tail and the
// energy tail are computed by one implementation. Two normal tails in one engine would
// eventually disagree at the fourth decimal, which is where T3-scale probabilities live.
const { normalCdf } = require("../energy/consumption");

/** @structural milliseconds in one second */
const MS_PER_SECOND = 1000;

/** @structural seconds in one hour */
const SECONDS_PER_HOUR = 3600;

/** @structural hours in one day */
const HOURS_PER_DAY = 24;

/** @structural days in one week */
const DAYS_PER_WEEK = 7;

/**
 * @structural 1970-01-01 was a Thursday; this is its index in a Sunday-first week, and it
 * is what lets `hourOfWeek` be arithmetic rather than calendrical
 */
const EPOCH_DAY_OF_WEEK = 4;

/** @structural milliseconds in one day */
const MS_PER_DAY = 86_400_000;

/**
 * The cohort ladder of §13.2, most specific first. Each level drops the rightmost
 * discriminator, which is the hierarchy the shrinkage runs along.
 * @structural §13.2's own key: (site, stop_type, mission_class, hour_of_week)
 */
const COHORT_LEVELS = Object.freeze([
  Object.freeze(["siteId", "stopType", "missionClass", "hourOfWeek"]),
  Object.freeze(["siteId", "stopType", "missionClass"]),
  Object.freeze(["siteId", "stopType"]),
  Object.freeze(["stopType", "missionClass"]),
  Object.freeze(["stopType"]),
]);

/** Where a resolved service time came from. */
const SOURCE = Object.freeze({
  FITTED: "FITTED_COHORT",
  PRIOR: "CONFIGURED_PRIOR",
  CHARGE_CURVE: "CHARGE_CURVE",
});

/**
 * @param {*} value
 * @returns {boolean}
 */
function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * The `hour_of_week` cohort discriminator: 0–167, Sunday 00:00 local being 0.
 *
 * Computed arithmetically from epoch milliseconds and the site's UTC offset. Local time is
 * the right frame for this key — a lobby is busy at 09:00 where it stands, not at 09:00
 * UTC — and the offset is a property of the site, supplied with it.
 *
 * @param {number} epochMs
 * @param {number} [utcOffsetSeconds] the site's offset; absent, UTC is used and the key
 *   says so by being computed at offset zero
 * @returns {number|null}
 */
function hourOfWeek(epochMs, utcOffsetSeconds) {
  if (!isNumber(epochMs)) return null;
  const offsetMs = (isNumber(utcOffsetSeconds) ? utcOffsetSeconds : 0) * MS_PER_SECOND;
  const local = epochMs + offsetMs;

  // Floor division, so instants before the epoch land on the correct day rather than
  // truncating toward zero.
  const days = Math.floor(local / MS_PER_DAY);
  const msIntoDay = local - days * MS_PER_DAY;
  const dayOfWeek = (((days + EPOCH_DAY_OF_WEEK) % DAYS_PER_WEEK) + DAYS_PER_WEEK) % DAYS_PER_WEEK;
  const hourOfDay = Math.floor(msIntoDay / (SECONDS_PER_HOUR * MS_PER_SECOND));

  return dayOfWeek * HOURS_PER_DAY + hourOfDay;
}

/**
 * The canonical key of a cohort at one level of the ladder.
 *
 * @param {string[]} level
 * @param {object} descriptor
 * @returns {string|null} null when the descriptor cannot fill the level
 */
function cohortKey(level, descriptor) {
  const parts = [];
  for (const field of level) {
    const value = (descriptor || {})[field];
    if (value === null || value === undefined || value === "") return null;
    parts.push(`${field}=${String(value)}`);
  }
  return parts.join("|");
}

/**
 * Precision-weighted shrinkage of a cohort's sample toward its parent.
 *
 * @param {{ n: number, meanSeconds: number, sdSeconds: number }} sample
 * @param {{ meanSeconds: number, sdSeconds: number }} parent
 * @param {number} strength `plan.service_time_shrinkage_strength` — the pseudo-count at
 *   which a cohort's own data carries half the weight
 * @returns {{ meanSeconds: number, sdSeconds: number, weight: number }}
 */
function shrink(sample, parent, strength) {
  const n = isNumber(sample && sample.n) ? Math.max(0, sample.n) : 0;
  const weight = n / (n + strength);
  return {
    meanSeconds: weight * sample.meanSeconds + (1 - weight) * parent.meanSeconds,
    // The dispersion is shrunk on the same weight. A cohort with one observation has no
    // usable dispersion of its own, and inheriting the parent's is the honest answer;
    // reporting the sample's near-zero spread would tell §8.4 that a barely-observed site
    // is highly predictable, which is the opposite of the truth.
    sdSeconds: weight * sample.sdSeconds + (1 - weight) * parent.sdSeconds,
    weight,
  };
}

/**
 * Resolve a stop's service-time distribution through the shrinkage ladder.
 *
 * @param {object} input
 * @param {Record<string, {n: number, meanSeconds: number, sdSeconds: number}>} input.models
 *   fitted cohorts, keyed by `cohortKey`
 * @param {object} input.descriptor `{ siteId, stopType, missionClass, hourOfWeek }`
 * @param {number} input.priorSeconds the configured prior for this stop type
 * @param {number} input.priorCv the prior's coefficient of variation
 * @param {number} input.shrinkageStrength
 * @returns {{ ok: boolean, meanSeconds: number|null, sdSeconds: number|null,
 *             source: string|null, cohortKey: string|null, shrinkageWeight: number|null,
 *             ladder: object[], missing: string[] }}
 */
function serviceTimeFor(input) {
  const source = input || {};
  const missing = [];

  if (!isNumber(source.priorSeconds) || source.priorSeconds < 0) missing.push("plan.service_time_prior");
  if (!isNumber(source.priorCv) || source.priorCv < 0) missing.push("plan.service_time_prior_cv");
  if (!isNumber(source.shrinkageStrength) || source.shrinkageStrength <= 0) {
    missing.push("plan.service_time_shrinkage_strength");
  }
  if (missing.length > 0) {
    return {
      ok: false,
      meanSeconds: null,
      sdSeconds: null,
      source: null,
      cohortKey: null,
      shrinkageWeight: null,
      ladder: [],
      missing,
    };
  }

  // The root of the hierarchy is the configured prior, which is why §8.2 calls it "a
  // configured prior" rather than a default: every cohort shrinks toward it, so it is
  // never merely a fallback that only sparse sites see.
  let current = { meanSeconds: source.priorSeconds, sdSeconds: source.priorSeconds * source.priorCv };
  const ladder = [{ level: "prior", key: null, meanSeconds: current.meanSeconds, sdSeconds: current.sdSeconds }];

  const models = source.models || {};
  let resolvedSource = SOURCE.PRIOR;
  let resolvedKey = null;
  let resolvedWeight = 0;

  // Least specific first, so each level shrinks toward the level above it and the most
  // specific cohort inherits everything its ancestors learned.
  for (const level of [...COHORT_LEVELS].reverse()) {
    const key = cohortKey(level, source.descriptor);
    if (key === null) continue;
    const fitted = models[key];
    if (!fitted || !isNumber(fitted.meanSeconds) || !isNumber(fitted.sdSeconds)) continue;

    const shrunk = shrink(fitted, current, source.shrinkageStrength);
    current = { meanSeconds: shrunk.meanSeconds, sdSeconds: shrunk.sdSeconds };
    ladder.push({ level: level.join("+"), key, n: fitted.n ?? 0, ...current, weight: shrunk.weight });
    resolvedSource = SOURCE.FITTED;
    resolvedKey = key;
    resolvedWeight = shrunk.weight;
  }

  return {
    ok: true,
    meanSeconds: current.meanSeconds,
    sdSeconds: current.sdSeconds,
    source: resolvedSource,
    cohortKey: resolvedKey,
    shrinkageWeight: resolvedWeight,
    ladder,
    missing: [],
  };
}

/**
 * Project the timeline over an ordered stop list.
 *
 * @param {object} input
 * @param {object[]} input.stops ordered, each carrying `serviceSeconds`, `serviceSdSeconds`,
 *   and optionally `windowStartMs` / `windowEndMs` / `waitPermitted`
 * @param {number} input.startMs the agent's projected release time
 * @param {number} [input.decisionTimeMs] the round's pinned time, for the release delay
 * @param {Array<{distanceM: number, travelSeconds: number, travelSdSeconds: number}>} input.hops
 *   travel **into** each stop, one per stop
 * @returns {{ ok: boolean, stops: object[], totals: object, problems: string[] }}
 */
function project(input) {
  const source = input || {};
  const stops = source.stops || [];
  const hops = source.hops || [];
  const problems = [];

  if (!isNumber(source.startMs)) problems.push("startMs");
  if (stops.length === 0) problems.push("stops");
  if (hops.length !== stops.length) {
    problems.push(
      `${hops.length} travel time(s) for ${stops.length} stop(s). Every stop needs the hop into it; a ` +
        "missing hop is a leg the plan would traverse for free",
    );
  }
  if (problems.length > 0) return { ok: false, stops: [], totals: null, problems };

  const projected = [];
  let cursorMs = source.startMs;
  // Variances, not standard deviations: they are what add for independent contributions.
  let varianceSeconds2 = 0;

  let distanceM = 0;
  let waitSeconds = 0;
  let approachSeconds = 0;
  let linehaulSeconds = 0;
  let intermediateServiceSeconds = 0;

  for (let index = 0; index < stops.length; index += 1) {
    const stop = stops[index];
    const hop = hops[index] || {};

    if (!isNumber(hop.travelSeconds) || hop.travelSeconds < 0 || !isNumber(hop.distanceM) || hop.distanceM < 0) {
      problems.push(`stop ${String(stop.sequence)}: travel time or distance is unresolved`);
      continue;
    }
    if (!isNumber(stop.serviceSeconds) || stop.serviceSeconds < 0) {
      problems.push(`stop ${String(stop.sequence)}: service time is unresolved`);
      continue;
    }

    const travelSd = isNumber(hop.travelSdSeconds) ? hop.travelSdSeconds : 0;
    const serviceSd = isNumber(stop.serviceSdSeconds) ? stop.serviceSdSeconds : 0;

    const arrivalMs = cursorMs + hop.travelSeconds * MS_PER_SECOND;
    varianceSeconds2 += travelSd * travelSd;
    const arrivalSdSeconds = Math.sqrt(varianceSeconds2);

    // §13.2's explicit wait: arriving before the window opens is committed time, not free
    // time. An agent 20 minutes early is penalised, not rewarded.
    const windowStartMs = isNumber(stop.windowStartMs) ? stop.windowStartMs : null;
    const stopWaitSeconds =
      windowStartMs !== null && arrivalMs < windowStartMs ? (windowStartMs - arrivalMs) / MS_PER_SECOND : 0;

    const serviceStartMs = arrivalMs + stopWaitSeconds * MS_PER_SECOND;
    const serviceEndMs = serviceStartMs + stop.serviceSeconds * MS_PER_SECOND;
    varianceSeconds2 += serviceSd * serviceSd;

    const windowEndMs = isNumber(stop.windowEndMs) ? stop.windowEndMs : null;
    const windowMissed = windowEndMs !== null && serviceStartMs > windowEndMs ? serviceStartMs - windowEndMs : 0;

    projected.push({
      sequence: stop.sequence,
      projectedArrivalMs: arrivalMs,
      serviceStartMs,
      serviceEndMs,
      departureMs: serviceEndMs,
      travelSeconds: hop.travelSeconds,
      serviceSeconds: stop.serviceSeconds,
      waitSeconds: stopWaitSeconds,
      distanceM: hop.distanceM,
      band: {
        arrivalSdSeconds,
        departureSdSeconds: Math.sqrt(varianceSeconds2),
        basis: "travel and service variances composed in quadrature, assuming independence",
      },
      windowMissed,
    });

    distanceM += hop.distanceM;
    waitSeconds += stopWaitSeconds;
    if (index === 0) approachSeconds += hop.travelSeconds;
    else linehaulSeconds += hop.travelSeconds;
    if (index > 0 && index < stops.length - 1) intermediateServiceSeconds += stop.serviceSeconds;

    cursorMs = serviceEndMs;
  }

  if (problems.length > 0) return { ok: false, stops: projected, totals: null, problems };

  const firstStop = projected[0];
  const lastStop = projected[projected.length - 1];

  // The release delay: §8.2's `t_wait` is "time until the agent can start: remaining
  // committed work plus any charge top-up needed", which is the gap between the round's
  // decision time and the agent's projected release.
  const releaseDelaySeconds = isNumber(source.decisionTimeMs)
    ? Math.max(0, (source.startMs - source.decisionTimeMs) / MS_PER_SECOND)
    : 0;

  return {
    ok: true,
    stops: projected,
    totals: {
      distanceM,
      durationSeconds: (lastStop.departureMs - source.startMs) / MS_PER_SECOND,
      startMs: source.startMs,
      endMs: lastStop.departureMs,
      endSdSeconds: lastStop.band.departureSdSeconds,

      // ── §8.2's six components, less `t_terminal`, which the Plan Builder owns ──
      // Window waits are §8.2's `t_wait` on the same reading §13.2 gives them: the agent
      // is idle and committed, and both halves are priced at λ_time. Reported separately
      // as well, so an explanation can distinguish "waited for a release" from "waited for
      // a door".
      waitSeconds: releaseDelaySeconds + waitSeconds,
      releaseDelaySeconds,
      windowWaitSeconds: waitSeconds,
      approachSeconds,
      serviceFirstSeconds: firstStop.serviceSeconds,
      // §8.2 names `t_linehaul` "travel time across the remaining stop sequence" and
      // tabulates service only at the first and last stop, because it is written for the
      // two-stop mission. For a sequence with intermediate stops their dwell is part of
      // traversing that sequence, so it is carried here and reported separately — leaving
      // it out would make a three-stop plan cheaper than the two-stop plan it contains,
      // which is exactly the unpriced-component defect §8.2 exists to close.
      linehaulSeconds: linehaulSeconds + intermediateServiceSeconds,
      linehaulTravelSeconds: linehaulSeconds,
      intermediateServiceSeconds,
      serviceLastSeconds: projected.length > 1 ? lastStop.serviceSeconds : 0,
    },
    problems: [],
  };
}

/**
 * `completion_time(l, plan)` for every Leg — the argument `C_delay` is evaluated at.
 *
 * A Leg completes when its **last** stop departs. Reported per Leg because `Φ` sums
 * `C_delay` over every Leg the plan executes, committed ones included (§8.1).
 *
 * @param {object[]} projectedStops from `project()`
 * @param {object[]} stops the sequenced stops, carrying `legId`
 * @returns {Record<string, number>}
 */
function legCompletions(projectedStops, stops) {
  const bySequence = new Map();
  for (const projected of projectedStops || []) bySequence.set(projected.sequence, projected);

  const completions = Object.create(null);
  for (const stop of stops || []) {
    const projected = bySequence.get(stop.sequence);
    if (!projected) continue;
    const legId = String(stop.legId);
    if (completions[legId] === undefined || projected.departureMs > completions[legId]) {
      completions[legId] = projected.departureMs;
    }
  }
  return completions;
}

/**
 * The ETA predictive distribution `C_risk`'s `p_late` reads (§8.4).
 *
 * @param {object[]} projectedStops
 * @param {number} deadlineMs
 * @returns {{ ok: boolean, meanMs: number|null, sdSeconds: number|null,
 *             lateProbability: number|null }}
 */
function lateProbability(projectedStops, deadlineMs) {
  const stops = projectedStops || [];
  if (stops.length === 0 || !isNumber(deadlineMs)) {
    return { ok: false, meanMs: null, sdSeconds: null, lateProbability: null };
  }
  const last = stops[stops.length - 1];
  const sdSeconds = last.band ? last.band.departureSdSeconds : 0;

  if (!isNumber(sdSeconds) || sdSeconds <= 0) {
    // A degenerate band is a point estimate, and a point estimate answers the question
    // with a 0 or a 1. Reported as such rather than smoothed, because §8.4's whole point
    // is that punctuality is a distinct property and a fabricated spread would invent one.
    return {
      ok: true,
      meanMs: last.departureMs,
      sdSeconds: 0,
      lateProbability: last.departureMs > deadlineMs ? 1 : 0,
    };
  }

  const z = (deadlineMs - last.departureMs) / MS_PER_SECOND / sdSeconds;
  return { ok: true, meanMs: last.departureMs, sdSeconds, lateProbability: 1 - normalCdf(z) };
}

module.exports = {
  MS_PER_SECOND,
  SECONDS_PER_HOUR,
  HOURS_PER_DAY,
  DAYS_PER_WEEK,
  COHORT_LEVELS,
  SOURCE,
  hourOfWeek,
  cohortKey,
  shrink,
  serviceTimeFor,
  project,
  legCompletions,
  lateProbability,
};
