"use strict";

/**
 * Graded completion verification (§12.5).
 *
 * > The audit notes the baseline accepts completion purely on the agent's assertion,
 * > with no geometric or evidentiary check. Trust in a report should be proportional to
 * > the consequence of its being wrong, so verification is graded per mission class.
 *
 * | Level | Requirements | Applied to |
 * |---|---|---|
 * | L0 — asserted | Agent reports completion | Internal, low-value, reposition and maintenance missions |
 * | L1 — geometric | Position within `verify.arrival_radius` of the stop **and** a plausible telemetry track showing actual travel there | Default for all customer work |
 * | L2 — evidenced | L1 plus a physical event: compartment open/close, mass change, barcode scan, latch state | Goods of material value |
 * | L3 — attested | L2 plus an external attestation: recipient confirmation, PIN, signature, photograph, or third-party scan | High-value, regulated, contested, or age-restricted |
 *
 * ── Insufficient evidence is a third answer, not a failure ──────────────────
 * > Insufficient evidence sends the Task to `VERIFYING` with an operator queue — not to
 * > `COMPLETED`, and not to `FAILED`. Both of those are lies about the physical state.
 *
 * ── The three plausibility tests, and why they are three ────────────────────
 * > **Track plausibility is three stated tests, with thresholds in the register.** "A
 * > plausible track" without a stated threshold would be tuned reactively by whoever
 * > first fields a false-positive complaint, rather than deliberately and in advance —
 * > and a verification threshold set under complaint pressure only ever moves in one
 * > direction.
 *
 * Each test below rejects **its own** crafted failure and no other, which is the phase's
 * stated testing requirement: a track with two fixes an hour apart fails coverage and
 * not corridor; a track that took a different road fails corridor and not coverage; a
 * track with a teleport fails continuity and neither of the others. Tests that overlap
 * would make a failure uninformative, and the operator queue's whole value is that it
 * says which.
 *
 * ── The security half ───────────────────────────────────────────────────────
 * > The plausibility check on the track is what defends against a defective or
 * > compromised agent reporting completion it did not perform: a completion claim from a
 * > position the agent could not physically have reached, given its last known position
 * > and its kinematic limits, is rejected and raises a security event (§23.5).
 *
 * That is the one failure that is not merely "send it to an operator": it sets
 * `securityEvent`, because a physically impossible claim is evidence about the agent
 * rather than about the telemetry link.
 *
 * Tier 0 (T0-08).
 */

const distance = require("../../utils/distance");

/** §12.5's four levels, in order. @structural the enumerated verification levels */
const LEVEL = Object.freeze({
  L0: "L0",
  L1: "L1",
  L2: "L2",
  L3: "L3",
});

/** @structural the level ordering, so "at least L2" is expressible */
const LEVEL_ORDER = Object.freeze([LEVEL.L0, LEVEL.L1, LEVEL.L2, LEVEL.L3]);

/** @structural the two outcomes; §12.5 admits no third */
const OUTCOME = Object.freeze({
  SUFFICIENT: "SUFFICIENT",
  INSUFFICIENT: "INSUFFICIENT",
});

/** The named failures, so the operator queue says *which* test failed. @structural */
const FAILURE = Object.freeze({
  NO_COMPLETION_CLAIM: "NO_COMPLETION_CLAIM",
  ARRIVAL_RADIUS: "ARRIVAL_RADIUS",
  TRACK_COVERAGE: "TRACK_COVERAGE",
  TRACK_CORRIDOR: "TRACK_CORRIDOR",
  TRACK_CONTINUITY: "TRACK_CONTINUITY",
  KINEMATICALLY_IMPOSSIBLE: "KINEMATICALLY_IMPOSSIBLE",
  NO_PHYSICAL_EVENT: "NO_PHYSICAL_EVENT",
  NO_ATTESTATION: "NO_ATTESTATION",
});

/**
 * @param {string} level
 * @param {string} atLeast
 * @returns {boolean}
 */
function meets(level, atLeast) {
  return LEVEL_ORDER.indexOf(level) >= LEVEL_ORDER.indexOf(atLeast);
}

/**
 * Which level does this mission class require?
 *
 * The mapping is configuration — §12.5's "Applied to" column is policy, and policy lives
 * in the register — so the caller supplies it. The default when a class is unmapped is
 * **L1**, not L0: §12.5 makes L1 "Default for all customer work", and defaulting to L0
 * would mean an unmapped class silently accepts the agent's assertion, which is the
 * baseline behaviour this section exists to remove.
 *
 * @param {string} missionClass
 * @param {object} levelsByMissionClass
 * @returns {string}
 */
function requiredLevelFor(missionClass, levelsByMissionClass) {
  const map = levelsByMissionClass || {};
  const configured = map[missionClass];
  return LEVEL[configured] ? configured : LEVEL.L1;
}

/**
 * Plausibility test 1 — **coverage**.
 *
 * > the track contains at least `verify.track_min_fix_rate` accepted position fixes per
 * > minute of the leg's realised duration, so a claim backed by two fixes an hour apart
 * > is not evidence of travel.
 *
 * @param {object} input
 * @param {Array<{ at: Date|string }>} input.track accepted fixes
 * @param {number} input.legDurationSeconds
 * @param {number} input.minFixRatePerMinute `verify.track_min_fix_rate`
 * @returns {{ ok: boolean, failure: string|null, measured: object }}
 */
function testCoverage(input) {
  const source = input || {};
  const track = Array.isArray(source.track) ? source.track : [];
  requirePositive("verify.track_min_fix_rate", source.minFixRatePerMinute);

  const minutes = Number.isFinite(source.legDurationSeconds)
    ? source.legDurationSeconds / SECONDS_PER_MINUTE
    : null;

  if (minutes === null || minutes <= 0) {
    // A leg with no realised duration has no rate to measure. Refusing rather than
    // dividing by zero: an unmeasurable claim is not a verified one.
    return {
      ok: false,
      failure: FAILURE.TRACK_COVERAGE,
      measured: { fixCount: track.length, legDurationSeconds: source.legDurationSeconds, fixRatePerMinute: null },
    };
  }

  const fixRatePerMinute = track.length / minutes;
  return {
    ok: fixRatePerMinute >= source.minFixRatePerMinute,
    failure: fixRatePerMinute >= source.minFixRatePerMinute ? null : FAILURE.TRACK_COVERAGE,
    measured: { fixCount: track.length, legDurationSeconds: source.legDurationSeconds, fixRatePerMinute },
  };
}

/**
 * Plausibility test 2 — **corridor**.
 *
 * > at least `verify.track_min_corridor_fraction` (default 0.85) of accepted fixes lie
 * > within the planned route corridor, or within a re-planned corridor the agent
 * > reported at the time. A deviation is not itself a failure; an *unreported* deviation
 * > is.
 *
 * The "or" is load-bearing and is implemented as such: a fix is inside if it is inside
 * the planned corridor **or** inside any corridor the agent reported, which is what
 * makes a legitimately re-routed leg verifiable.
 *
 * @param {object} input
 * @param {Array<{ lat: number, lon: number }>} input.track
 * @param {Array<{ lat: number, lon: number }>} input.corridor the planned route polyline
 * @param {Array<Array<{ lat: number, lon: number }>>} [input.reportedCorridors]
 * @param {number} input.corridorHalfWidthM
 * @param {number} input.minCorridorFraction `verify.track_min_corridor_fraction`
 * @returns {{ ok: boolean, failure: string|null, measured: object }}
 */
function testCorridor(input) {
  const source = input || {};
  const track = Array.isArray(source.track) ? source.track : [];
  requirePositive("verify.track_min_corridor_fraction", source.minCorridorFraction);
  requirePositive("the corridor half-width", source.corridorHalfWidthM);

  if (track.length === 0) {
    return { ok: false, failure: FAILURE.TRACK_CORRIDOR, measured: { corridorFraction: null, fixCount: 0 } };
  }

  const corridors = [source.corridor, ...(Array.isArray(source.reportedCorridors) ? source.reportedCorridors : [])]
    .filter((corridor) => Array.isArray(corridor) && corridor.length > 0);

  if (corridors.length === 0) {
    return { ok: false, failure: FAILURE.TRACK_CORRIDOR, measured: { corridorFraction: null, fixCount: track.length } };
  }

  let inside = 0;
  for (const fix of track) {
    const within = corridors.some((corridor) => minimumDistanceToPolyline(fix, corridor) <= source.corridorHalfWidthM);
    if (within) inside += 1;
  }

  const corridorFraction = inside / track.length;
  return {
    ok: corridorFraction >= source.minCorridorFraction,
    failure: corridorFraction >= source.minCorridorFraction ? null : FAILURE.TRACK_CORRIDOR,
    measured: { corridorFraction, fixCount: track.length, insideCount: inside },
  };
}

/**
 * Plausibility test 3 — **continuity**.
 *
 * > no unexplained gap longer than `verify.track_max_gap`, except where the gap is fully
 * > covered by a mapped dead zone (§18.2 A3), and every implied inter-fix speed within
 * > the agent's kinematic limits (§23.5).
 *
 * The two halves report separately. A gap is a telemetry problem and sends the Task to
 * an operator; a speed beyond the agent's kinematic limits is a claim the agent could
 * not physically have performed, and §12.5 makes that a **security event**. Collapsing
 * them into one verdict would page an operator for a lost signal and file a compromised
 * agent as a lost signal.
 *
 * @param {object} input
 * @param {Array<{ at: Date|string, lat: number, lon: number }>} input.track
 * @param {number} input.maxGapSeconds `verify.track_max_gap`
 * @param {number} input.maxSpeedMs the agent's kinematic limit (§2.2)
 * @param {Array<{ from: Date|string, to: Date|string }>} [input.mappedDeadZoneWindows]
 * @returns {{ ok: boolean, failure: string|null, securityEvent: boolean, measured: object }}
 */
function testContinuity(input) {
  const source = input || {};
  const track = Array.isArray(source.track) ? [...source.track] : [];
  requirePositive("verify.track_max_gap", source.maxGapSeconds);
  requirePositive("the agent's kinematic speed limit", source.maxSpeedMs);

  // A gap and an implied speed are both properties of a *pair* of fixes, so a track with
  // fewer than two has neither to measure. Refusing rather than passing vacuously: an
  // unmeasurable track is not a continuous one.
  // @structural the arity of the interval this test measures over — two fixes make one gap
  if (track.length < 2) {
    return {
      ok: false,
      failure: FAILURE.TRACK_CONTINUITY,
      securityEvent: false,
      measured: { maxGapSeconds: null, maxImpliedSpeedMs: null, fixCount: track.length },
    };
  }

  track.sort((a, b) => timeOf(a.at) - timeOf(b.at));

  let maxGapSeconds = 0;
  let maxImpliedSpeedMs = 0;
  let unexplainedGap = false;

  for (let index = 1; index < track.length; index += 1) {
    const previous = track[index - 1];
    const current = track[index];
    const gapSeconds = (timeOf(current.at) - timeOf(previous.at)) / MILLIS_PER_SECOND;
    if (gapSeconds > maxGapSeconds) maxGapSeconds = gapSeconds;

    if (gapSeconds > source.maxGapSeconds && !coveredByDeadZone(previous.at, current.at, source.mappedDeadZoneWindows)) {
      unexplainedGap = true;
    }

    if (gapSeconds > 0) {
      const metres = distance.haversineMeters(previous.lat, previous.lon, current.lat, current.lon);
      const impliedSpeed = metres / gapSeconds;
      if (impliedSpeed > maxImpliedSpeedMs) maxImpliedSpeedMs = impliedSpeed;
    }
  }

  const kinematicallyImpossible = maxImpliedSpeedMs > source.maxSpeedMs;
  const measured = { maxGapSeconds, maxImpliedSpeedMs, fixCount: track.length };

  if (kinematicallyImpossible) {
    return { ok: false, failure: FAILURE.KINEMATICALLY_IMPOSSIBLE, securityEvent: true, measured };
  }
  if (unexplainedGap) {
    return { ok: false, failure: FAILURE.TRACK_CONTINUITY, securityEvent: false, measured };
  }
  return { ok: true, failure: null, securityEvent: false, measured };
}

/**
 * All three plausibility tests. Every one is evaluated — a track that fails coverage and
 * corridor should say so, because the two together mean something different from either.
 *
 * @param {object} input the union of the three tests' inputs
 * @returns {{ plausible: boolean, failures: string[], securityEvent: boolean, measured: object }}
 */
function assessTrackPlausibility(input) {
  const coverage = testCoverage(input);
  const corridor = testCorridor(input);
  const continuity = testContinuity(input);

  const failures = [coverage.failure, corridor.failure, continuity.failure].filter(Boolean);

  return {
    plausible: failures.length === 0,
    failures,
    securityEvent: continuity.securityEvent === true,
    measured: { ...coverage.measured, ...corridor.measured, ...continuity.measured },
  };
}

/**
 * Grade one completion claim.
 *
 * Returns the level the evidence actually supports alongside the level required, because
 * "L2 was required and the evidence reaches L1" is a different operator task from "L2 was
 * required and there is no claim at all".
 *
 * @param {object} input
 * @param {string} input.requiredLevel
 * @param {boolean} input.completionClaimed
 * @param {{ lat: number, lon: number }} [input.claimedPosition]
 * @param {{ lat: number, lon: number }} [input.stopPosition]
 * @param {number} [input.arrivalRadiusM] `verify.arrival_radius`
 * @param {object} [input.physicalEvidence] L2's physical event
 * @param {object} [input.attestation] L3's external attestation
 * @param {object} [input.track] the three tests' inputs
 * @returns {object}
 */
function verify(input) {
  const source = input || {};
  const requiredLevel = LEVEL[source.requiredLevel] ? source.requiredLevel : LEVEL.L1;
  const failures = [];
  let securityEvent = false;
  let measured = {};

  if (source.completionClaimed !== true) {
    return result({
      requiredLevel,
      achievedLevel: LEVEL.L0,
      outcome: OUTCOME.INSUFFICIENT,
      failures: [FAILURE.NO_COMPLETION_CLAIM],
      securityEvent: false,
      measured,
    });
  }

  // L0 is the claim itself. Every level above it adds a check, and each check is
  // *cumulative* — L3 is "L2 plus", so a missing L1 track fails L3 too.
  let achieved = LEVEL.L0;

  if (meets(requiredLevel, LEVEL.L1)) {
    let geometricOk = true;

    if (Number.isFinite(source.arrivalRadiusM) && source.claimedPosition && source.stopPosition) {
      const arrivalDistanceM = distance.haversineMeters(
        source.claimedPosition.lat,
        source.claimedPosition.lon,
        source.stopPosition.lat,
        source.stopPosition.lon,
      );
      measured.arrivalDistanceM = arrivalDistanceM;
      if (arrivalDistanceM > source.arrivalRadiusM) {
        failures.push(FAILURE.ARRIVAL_RADIUS);
        geometricOk = false;
      }
    } else {
      // §4.1 rule 3 — no position, no geometric verification. Not "assume it arrived".
      failures.push(FAILURE.ARRIVAL_RADIUS);
      geometricOk = false;
    }

    const plausibility = assessTrackPlausibility(source.track || {});
    measured = { ...measured, ...plausibility.measured };
    if (!plausibility.plausible) {
      failures.push(...plausibility.failures);
      geometricOk = false;
    }
    if (plausibility.securityEvent) securityEvent = true;

    if (geometricOk) achieved = LEVEL.L1;
  } else {
    achieved = LEVEL.L0;
  }

  if (meets(requiredLevel, LEVEL.L2)) {
    const hasPhysical = Boolean(source.physicalEvidence) && Object.keys(source.physicalEvidence).length > 0;
    if (!hasPhysical) failures.push(FAILURE.NO_PHYSICAL_EVENT);
    else if (achieved === LEVEL.L1) achieved = LEVEL.L2;
  }

  if (meets(requiredLevel, LEVEL.L3)) {
    const hasAttestation = Boolean(source.attestation) && Object.keys(source.attestation).length > 0;
    if (!hasAttestation) failures.push(FAILURE.NO_ATTESTATION);
    else if (achieved === LEVEL.L2) achieved = LEVEL.L3;
  }

  return result({
    requiredLevel,
    achievedLevel: achieved,
    outcome: failures.length === 0 ? OUTCOME.SUFFICIENT : OUTCOME.INSUFFICIENT,
    failures,
    securityEvent,
    measured,
  });
}

function result(fields) {
  return Object.freeze({
    ...fields,
    failures: Object.freeze([...fields.failures]),
    // §12.5 — insufficient evidence sends the *Task* to VERIFYING with an operator
    // queue. Naming the disposition here keeps the caller from inventing a fourth one.
    disposition: fields.outcome === OUTCOME.SUFFICIENT ? "SETTLE" : "TASK_VERIFYING_OPERATOR_QUEUE",
  });
}

/**
 * Is this gap fully covered by a mapped dead zone (§18.2 A3)?
 *
 * "Fully covered" is the requirement: a gap that starts inside a dead zone and continues
 * after the agent left it is only partly explained, and a partly explained gap is
 * unexplained.
 */
function coveredByDeadZone(from, to, windows) {
  if (!Array.isArray(windows)) return false;
  const start = timeOf(from);
  const end = timeOf(to);
  return windows.some((window) => timeOf(window.from) <= start && timeOf(window.to) >= end);
}

function timeOf(value) {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

/**
 * The shortest distance from a point to a polyline, in metres.
 *
 * Segment-wise rather than vertex-wise: a corridor test that measured only to the
 * *vertices* of a route would reject every fix taken halfway along a long straight,
 * which is most of them.
 */
function minimumDistanceToPolyline(point, polyline) {
  if (polyline.length === 1) {
    return distance.haversineMeters(point.lat, point.lon, polyline[0].lat, polyline[0].lon);
  }

  let minimum = Infinity;
  for (let index = 1; index < polyline.length; index += 1) {
    const segmentDistance = distanceToSegment(point, polyline[index - 1], polyline[index]);
    if (segmentDistance < minimum) minimum = segmentDistance;
  }
  return minimum;
}

/**
 * Distance from a point to a segment, in metres, in a local planar approximation.
 *
 * The approximation is deliberate and bounded: corridor half-widths are tens of metres,
 * over which the curvature error of an equirectangular projection is far below the
 * measurement error of the fixes themselves. Using it keeps the test a pure function of
 * its inputs (T6) rather than a call into the Routing Service.
 */
function distanceToSegment(point, start, end) {
  const metresPerDegreeLat = distance.haversineMeters(0, 0, 1, 0);
  const metresPerDegreeLon = metresPerDegreeLat * Math.cos((point.lat * Math.PI) / DEGREES_IN_HALF_TURN);

  const px = point.lon * metresPerDegreeLon;
  const py = point.lat * metresPerDegreeLat;
  const ax = start.lon * metresPerDegreeLon;
  const ay = start.lat * metresPerDegreeLat;
  const bx = end.lon * metresPerDegreeLon;
  const by = end.lat * metresPerDegreeLat;

  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;

  if (lengthSquared === 0) return Math.hypot(px - ax, py - ay);

  let t = ((px - ax) * dx + (py - ay) * dy) / lengthSquared;
  t = Math.max(0, Math.min(1, t));

  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function requirePositive(name, value) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} resolved to ${String(value)}; a verification threshold must be positive (§12.5)`);
  }
}

/** @structural seconds per minute — a unit conversion, not a threshold */
const SECONDS_PER_MINUTE = 60;
/** @structural milliseconds per second — a unit conversion, not a threshold */
const MILLIS_PER_SECOND = 1000;
/** @structural degrees in half a turn — the radian conversion constant */
const DEGREES_IN_HALF_TURN = 180;

module.exports = {
  LEVEL,
  LEVEL_ORDER,
  OUTCOME,
  FAILURE,
  meets,
  requiredLevelFor,
  testCoverage,
  testCorridor,
  testContinuity,
  assessTrackPlausibility,
  verify,
};
