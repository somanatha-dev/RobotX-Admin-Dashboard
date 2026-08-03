"use strict";

/**
 * Progress supervision (§12.3) — five signals, because liveness is not progress.
 *
 * > Lease renewal proves liveness; it does not prove *progress*. An agent can heartbeat
 * > happily while stationary behind an obstacle.
 *
 * | Signal | Detection | Response |
 * |---|---|---|
 * | Position not advancing along the planned route beyond `supervise.stall_time` | Track versus plan | Query the agent, request a status detail, then reroute or escalate |
 * | Realised ETA drift beyond `execute.eta_tolerance` | Continuous re-projection | Re-project timeline; set Task `AT_RISK`; notify customer; consider reassignment if pre-custody |
 * | Energy consumption exceeding prediction by more than `energy.deviation_tolerance` | Realised versus predicted Wh | Re-run feasibility with the observed efficiency; divert to charge or abort while it is still possible to reach a charger |
 * | Repeated local replans or intervention requests | Count per km against baseline | Health signal; may quarantine after this mission |
 * | Off-route excursion beyond corridor | Geometric | Immediate investigation; possible safety event |
 *
 * ── The energy row is the one the baseline has no analogue for ──────────────
 * > because the check compares *realised* against *predicted* consumption, an agent
 * > whose efficiency has degraded — worn bearings, cold pack, unexpected gradient — is
 * > detected mid-mission while diversion is still possible. The baseline has no such
 * > loop; the audit notes its simulated agent continues driving at the 5 % floor
 * > indefinitely, and no server-side logic consumes the resulting status change at all.
 *
 * ── Every assessor is pure ──────────────────────────────────────────────────
 * No store, no clock, no cache. Each takes an observation window and the resolved
 * thresholds, and returns a signal with the response §12.3 prescribes. The *acting* is
 * the reconciler's and the timer handlers' — a supervisor that both detected and acted
 * would be untestable at the boundary, and boundaries are where these thresholds are
 * wrong.
 *
 * Energy's own model is Phase 7's. This module compares realised against predicted Wh
 * as §12.3 states, and takes both as inputs; it does not compute a prediction, which
 * would be building a second energy model.
 *
 * Tier 0 (T0-08).
 */

/** §12.3's five signals. @structural the enumerated §12.3 progress signals */
const SIGNAL = Object.freeze({
  STALLED: "STALLED",
  ETA_DRIFT: "ETA_DRIFT",
  ENERGY_DEVIATION: "ENERGY_DEVIATION",
  REPEATED_REPLANS: "REPEATED_REPLANS",
  OFF_ROUTE: "OFF_ROUTE",
});

/** §12.3's response column. @structural the enumerated §12.3 responses */
const RESPONSE = Object.freeze({
  NONE: "NONE",
  QUERY_THEN_REROUTE_OR_ESCALATE: "QUERY_THEN_REROUTE_OR_ESCALATE",
  REPROJECT_AND_SET_AT_RISK: "REPROJECT_AND_SET_AT_RISK",
  RERUN_FEASIBILITY_DIVERT_OR_ABORT: "RERUN_FEASIBILITY_DIVERT_OR_ABORT",
  HEALTH_SIGNAL: "HEALTH_SIGNAL",
  IMMEDIATE_INVESTIGATION: "IMMEDIATE_INVESTIGATION",
});

function clear(signal) {
  return { signal, fired: false, response: RESPONSE.NONE, reason: null, detail: null, measured: null };
}

function fired(signal, response, reason, measured, detail) {
  return { signal, fired: true, response, reason, measured, detail: detail === undefined ? null : detail };
}

/**
 * Row 1 — *"Position not advancing along the planned route beyond
 * `supervise.stall_time`."*
 *
 * Advancement is measured **along the planned route**, not as displacement: an agent
 * circling a roundabout or shunting in a loading bay is moving and not advancing, and
 * displacement would call that progress. The caller supplies route progress in metres
 * because computing it needs the route, which is the Routing Service's (§5.2).
 *
 * @param {object} input
 * @param {number} input.secondsSinceRouteProgress
 * @param {number} input.stallTimeSeconds `supervise.stall_time`
 * @returns {object}
 */
function assessStall(input) {
  const source = input || {};
  requirePositive("supervise.stall_time", source.stallTimeSeconds);

  if (!Number.isFinite(source.secondsSinceRouteProgress)) {
    // §4.1 rule 3 — absence triggers investigation, not assumption. An agent whose
    // route progress cannot be measured is exactly the case a stall detector exists for,
    // so unmeasurable is a signal rather than a silence.
    return fired(
      SIGNAL.STALLED,
      RESPONSE.QUERY_THEN_REROUTE_OR_ESCALATE,
      "ROUTE_PROGRESS_UNMEASURABLE",
      null,
      "no route-progress observation; §4.1 rule 3 makes absence a reason to investigate",
    );
  }

  if (source.secondsSinceRouteProgress > source.stallTimeSeconds) {
    return fired(SIGNAL.STALLED, RESPONSE.QUERY_THEN_REROUTE_OR_ESCALATE, "NO_ROUTE_PROGRESS", {
      secondsSinceRouteProgress: source.secondsSinceRouteProgress,
      threshold: source.stallTimeSeconds,
    });
  }

  return clear(SIGNAL.STALLED);
}

/**
 * Row 2 — *"Realised ETA drift beyond `execute.eta_tolerance`."*
 *
 * The tolerance is a **multiplier** on the projected duration, as §4.3's deadline column
 * uses it ("projected ETA × `execute.eta_tolerance`"), not an absolute number of
 * seconds: a five-minute drift on a four-minute leg and on a two-hour one are not the
 * same event.
 *
 * `considerReassignment` is true only pre-custody, per §12.3's response column —
 * reassigning a loaded agent is §4.7's custody-`HELD` protocol, not an ETA response.
 *
 * @param {object} input
 * @param {number} input.projectedDurationSeconds
 * @param {number} input.realisedDurationSeconds
 * @param {number} input.etaTolerance `execute.eta_tolerance`, a multiplier ≥ 1
 * @param {string} [input.custodyState]
 * @returns {object}
 */
function assessEtaDrift(input) {
  const source = input || {};
  requirePositive("execute.eta_tolerance", source.etaTolerance);

  if (!Number.isFinite(source.projectedDurationSeconds) || source.projectedDurationSeconds <= 0) {
    return clear(SIGNAL.ETA_DRIFT);
  }
  if (!Number.isFinite(source.realisedDurationSeconds)) return clear(SIGNAL.ETA_DRIFT);

  const ratio = source.realisedDurationSeconds / source.projectedDurationSeconds;
  if (ratio <= source.etaTolerance) return clear(SIGNAL.ETA_DRIFT);

  const result = fired(SIGNAL.ETA_DRIFT, RESPONSE.REPROJECT_AND_SET_AT_RISK, "ETA_BEYOND_TOLERANCE", {
    ratio,
    tolerance: source.etaTolerance,
    projectedDurationSeconds: source.projectedDurationSeconds,
    realisedDurationSeconds: source.realisedDurationSeconds,
  });
  result.considerReassignment = source.custodyState !== "HELD";
  return result;
}

/**
 * Row 3 — *"Energy consumption exceeding prediction by more than
 * `energy.deviation_tolerance`."*
 *
 * Both figures are in Wh and both are supplied. §14 forbids reasoning about energy as a
 * percentage, and computing the prediction here would be a second energy model
 * disagreeing with Phase 7's.
 *
 * @param {object} input
 * @param {number} input.predictedWh
 * @param {number} input.realisedWh
 * @param {number} input.deviationTolerance `energy.deviation_tolerance`, a fraction
 * @returns {object}
 */
function assessEnergyDeviation(input) {
  const source = input || {};
  requirePositive("energy.deviation_tolerance", source.deviationTolerance);

  if (!Number.isFinite(source.predictedWh) || source.predictedWh <= 0) return clear(SIGNAL.ENERGY_DEVIATION);
  if (!Number.isFinite(source.realisedWh)) return clear(SIGNAL.ENERGY_DEVIATION);

  const deviation = (source.realisedWh - source.predictedWh) / source.predictedWh;
  // One-sided on purpose. An agent using *less* than predicted is a calibration
  // observation (§21.5), not a mid-mission safety signal, and firing on it would divert
  // agents that are doing better than expected.
  if (deviation <= source.deviationTolerance) return clear(SIGNAL.ENERGY_DEVIATION);

  return fired(SIGNAL.ENERGY_DEVIATION, RESPONSE.RERUN_FEASIBILITY_DIVERT_OR_ABORT, "REALISED_EXCEEDS_PREDICTED", {
    deviation,
    tolerance: source.deviationTolerance,
    predictedWh: source.predictedWh,
    realisedWh: source.realisedWh,
  });
}

/**
 * Row 4 — *"Repeated local replans or intervention requests. Count per km against
 * baseline."*
 *
 * Per kilometre, not per mission: a long mission legitimately replans more often, and a
 * per-mission count would quarantine the agents doing the hardest work.
 *
 * The response is a health signal that "may quarantine **after this mission**" — never
 * during. Quarantining an agent mid-mission is an agent-scope authority change, which
 * invalidates every commitment it holds (§10.3.1); doing that for a quality signal
 * rather than a safety one would strand goods to improve a statistic.
 *
 * ── The comparison is against the baseline itself ───────────────────────────
 * §12.3 writes "Count per km against baseline" and states no multiple, so none is
 * invented here. A tolerance factor would be a behavioural constant with no register
 * entry and no owner (§22.1), and the baseline is already the calibrated quantity — it
 * is §16.3's cohort estimate, which is where a tolerance belongs if one is ever wanted.
 *
 * @param {object} input
 * @param {number} input.replanCount
 * @param {number} input.distanceKm
 * @param {number} input.baselinePerKm the cohort baseline, from §16.3
 * @returns {object}
 */
function assessReplanRate(input) {
  const source = input || {};

  if (!Number.isFinite(source.distanceKm) || source.distanceKm <= 0) return clear(SIGNAL.REPEATED_REPLANS);
  if (!Number.isFinite(source.baselinePerKm) || source.baselinePerKm < 0) return clear(SIGNAL.REPEATED_REPLANS);
  if (!Number.isFinite(source.replanCount)) return clear(SIGNAL.REPEATED_REPLANS);

  const perKm = source.replanCount / source.distanceKm;
  if (perKm <= source.baselinePerKm) return clear(SIGNAL.REPEATED_REPLANS);

  const result = fired(SIGNAL.REPEATED_REPLANS, RESPONSE.HEALTH_SIGNAL, "REPLAN_RATE_ABOVE_BASELINE", {
    perKm,
    baselinePerKm: source.baselinePerKm,
  });
  result.quarantineAfterMission = true;
  return result;
}

/**
 * Row 5 — *"Off-route excursion beyond corridor. Geometric. Immediate investigation;
 * possible safety event."*
 *
 * The corridor half-width is supplied by the caller, from the route the mission was
 * planned against. An excursion that the agent *reported* is not this signal — §12.5
 * makes the same distinction for verification: "A deviation is not itself a failure; an
 * *unreported* deviation is."
 *
 * @param {object} input
 * @param {number} input.offRouteDistanceM
 * @param {number} input.corridorHalfWidthM
 * @param {boolean} [input.reportedByAgent]
 * @returns {object}
 */
function assessOffRoute(input) {
  const source = input || {};
  if (!Number.isFinite(source.corridorHalfWidthM) || source.corridorHalfWidthM <= 0) return clear(SIGNAL.OFF_ROUTE);
  if (!Number.isFinite(source.offRouteDistanceM)) return clear(SIGNAL.OFF_ROUTE);
  if (source.offRouteDistanceM <= source.corridorHalfWidthM) return clear(SIGNAL.OFF_ROUTE);
  if (source.reportedByAgent === true) {
    const reported = clear(SIGNAL.OFF_ROUTE);
    reported.detail = "the agent reported this deviation at the time; a reported deviation is not an excursion (§12.5)";
    return reported;
  }

  const result = fired(SIGNAL.OFF_ROUTE, RESPONSE.IMMEDIATE_INVESTIGATION, "UNREPORTED_CORRIDOR_EXCURSION", {
    offRouteDistanceM: source.offRouteDistanceM,
    corridorHalfWidthM: source.corridorHalfWidthM,
  });
  result.possibleSafetyEvent = true;
  return result;
}

/**
 * All five, over one observation window.
 *
 * Every signal is evaluated; none short-circuits. An agent that is stalled *and*
 * off-route is a different incident from one that is only stalled, and a supervisor that
 * returned at the first hit would report the same thing for both.
 *
 * @param {object} input the union of the five assessors' inputs
 * @returns {{ fired: object[], clear: object[], responses: string[] }}
 */
function assessAll(input) {
  const source = input || {};
  const results = [
    assessStall(source),
    assessEtaDrift(source),
    assessEnergyDeviation(source),
    assessReplanRate(source),
    assessOffRoute(source),
  ];

  const firedSignals = results.filter((result) => result.fired);
  return {
    fired: firedSignals,
    clear: results.filter((result) => !result.fired),
    responses: [...new Set(firedSignals.map((result) => result.response))],
  };
}

/**
 * @param {string} name
 * @param {unknown} value
 */
function requirePositive(name, value) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} resolved to ${String(value)}; a supervision threshold must be positive (§12.3)`);
  }
}

module.exports = {
  SIGNAL,
  RESPONSE,
  assessStall,
  assessEtaDrift,
  assessEnergyDeviation,
  assessReplanRate,
  assessOffRoute,
  assessAll,
};
