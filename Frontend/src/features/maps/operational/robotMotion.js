/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ROBOT MOTION — presentation between telemetry samples
 *
 * Two pure pieces, no DOM, no Mapbox, no clock of their own (every function
 * takes `nowMs`), so both are driven deterministically by the tests.
 *
 *   createSampleGate()   which POSITION is newest. Telemetry reaches the map
 *                        by two routes — the `robot:update` socket event and
 *                        the provider's robot rows, which a REST refetch
 *                        replaces wholesale — and a refetch answered after a
 *                        newer socket sample used to move markers backwards.
 *                        The gate orders samples by the server's receipt time
 *                        (`lastSeenAt`) and keeps the newest position.
 *
 *   motion track         where to DRAW a robot between two accepted samples.
 *                        Linear in time over the measured sample interval, so
 *                        a unit at constant speed is drawn at constant speed —
 *                        not the ease-out tween this replaces, which restarted
 *                        at full speed on every sample (a visible surge-and-
 *                        settle every tick) and had a fixed 1 800 ms length
 *                        while the telemetry interval is live-configurable
 *                        from 100 ms to 60 s.
 *
 * ── What this is NOT ───────────────────────────────────────────────────────
 * It is not localisation. Interpolation draws the straight chord between two
 * positions the robot actually reported; it never extrapolates past the newest
 * sample, so the marker is never ahead of the data. When samples stop, the
 * marker stops on the last reported position and is marked stale. The
 * accepted sample — not the drawn one — is what routes, follow camera and
 * every other consumer read.
 * ═══════════════════════════════════════════════════════════════════════════
 */

export const MOTION = Object.freeze({
  /** The simulator's default (`Backend/src/simulation/constants.js` TELEMETRY_INTERVAL_MS). */
  DEFAULT_INTERVAL_MS: 2000,
  /** Shortest tween — below this a retarget is drawn as a placement. */
  MIN_TWEEN_MS: 80,
  /** Longest tween. A slower stream still animates, but over at most this. */
  MAX_TWEEN_MS: 6000,
  /**
   * Tween length as a multiple of the sample interval. Slightly over 1 so a
   * sample that arrives a little late finds the marker still moving rather
   * than parked — at constant speed this converges to the true speed with a
   * steady lag of ~0.15 of one interval, and never overshoots the sample.
   */
  INTERVAL_SLACK: 1.15,
  /** Weight of a new interval measurement in the running estimate. */
  INTERVAL_SMOOTHING: 0.35,
  /** Interval measurements outside this range are not telemetry cadence. */
  MIN_INTERVAL_MS: 50,
  MAX_INTERVAL_MS: 60_000,
  /**
   * A displacement faster than this is a jump, not travel (a reset, a
   * re-seed, a reconnect after a long gap): the robot is PLACED at the new
   * position instead of being drawn gliding across campus.
   */
  MAX_PLAUSIBLE_SPEED_MPS: 12,
  /** After this long without a sample, the next one is placed, not animated. */
  MAX_ANIMATED_GAP_MS: 15_000,
  /** A sample this much OLDER than the newest is a clock change, not reordering. */
  REORDER_WINDOW_MS: 30_000,
  /** Stale after max(STALE_MIN_MS, STALE_INTERVALS × interval) without fresh data. */
  STALE_MIN_MS: 8_000,
  STALE_INTERVALS: 3,
});

const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

/** A usable WGS-84 `[lng, lat]`, or null. */
export function validLngLat(lngLat) {
  if (!Array.isArray(lngLat) || lngLat.length < 2) return null;
  const [lng, lat] = lngLat;
  if (!isFiniteNumber(lng) || !isFiniteNumber(lat)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return [lng, lat];
}

/**
 * When the server received the sample a robot state describes, in epoch ms.
 *
 *   telemetryAt       the provider row, copied from the last `robot:update`
 *   lastSeenAt        a `robot:update` payload (a number there; on a REST row
 *                     it is the Robot COLUMN, an ISO string, and not the time
 *                     of the position the row carries — so strings are ignored)
 *   live.lastSeenAt   a REST row's overlaid live state, the time of its position
 */
export function sampleTimeOf(robot) {
  if (!robot || typeof robot !== 'object') return null;
  if (isFiniteNumber(robot.telemetryAt)) return robot.telemetryAt;
  if (isFiniteNumber(robot.lastSeenAt)) return robot.lastSeenAt;
  if (isFiniteNumber(robot.live?.lastSeenAt)) return robot.live.lastSeenAt;
  return null;
}

/** Signed smallest rotation from `from` to `to`, in degrees, in (-180, 180]. */
export function shortestAngleDelta(from, to) {
  const d = (((to - from) % 360) + 540) % 360 - 180;
  return d === -180 ? 180 : d;
}

/** Heading interpolation along the shorter arc; a missing end takes the other. */
export function lerpHeading(from, to, t) {
  if (!isFiniteNumber(from)) return isFiniteNumber(to) ? to : null;
  if (!isFiniteNumber(to)) return from;
  const h = from + shortestAngleDelta(from, to) * t;
  return ((h % 360) + 360) % 360;
}

/** Ground distance in metres (equirectangular — exact enough at campus scale). */
export function groundDistanceM(a, b) {
  if (!a || !b) return 0;
  const R = 6371008.8;
  const toRad = Math.PI / 180;
  const meanLat = ((a[1] + b[1]) / 2) * toRad;
  const dx = (b[0] - a[0]) * toRad * Math.cos(meanLat);
  const dy = (b[1] - a[1]) * toRad;
  return Math.sqrt(dx * dx + dy * dy) * R;
}

// ── The ordering gate ───────────────────────────────────────────────────────

export const SAMPLE_VERDICT = Object.freeze({
  /** Newer than anything seen — this position is drawn. */
  ACCEPTED: 'ACCEPTED',
  /** Carries no time and nothing timed has been seen — accepted. */
  UNTIMED: 'UNTIMED',
  /** Older than the newest accepted sample — the newest position is kept. */
  OUT_OF_ORDER: 'OUT_OF_ORDER',
  /** Carries no time but a timed sample is already held — that one is kept. */
  UNTIMED_SUPERSEDED: 'UNTIMED_SUPERSEDED',
  /** Not a usable coordinate. */
  INVALID: 'INVALID',
});

/**
 * Per-robot memory of the newest accepted position.
 *
 * `resolve` always answers with the position to DRAW: the sample's own when it
 * is the newest, otherwise the newest one already accepted. The caller still
 * applies the rest of the state (status, battery, selection) — a REST row
 * older in position can be newer in status, which is the database's to say.
 */
export function createSampleGate({ reorderWindowMs = MOTION.REORDER_WINDOW_MS } = {}) {
  const newest = new Map(); // robotId → { t: number|null, lngLat, heading }

  function resolve(robotId, { t, lngLat, heading } = {}) {
    const id = String(robotId || '');
    const prev = newest.get(id) || null;
    const ll = validLngLat(lngLat);
    const time = isFiniteNumber(t) ? t : null;
    const kept = (verdict) => ({
      verdict,
      lngLat: prev ? prev.lngLat : null,
      heading: prev ? prev.heading : null,
      t: prev ? prev.t : null,
    });

    if (!ll) return kept(SAMPLE_VERDICT.INVALID);

    if (prev && prev.t !== null) {
      if (time === null) return kept(SAMPLE_VERDICT.UNTIMED_SUPERSEDED);
      // A bounded window: a sample far older than the newest is a server clock
      // change or a restarted stream, and refusing it forever would freeze the unit.
      if (time < prev.t && prev.t - time <= reorderWindowMs) return kept(SAMPLE_VERDICT.OUT_OF_ORDER);
    }

    const next = { t: time, lngLat: ll, heading: isFiniteNumber(heading) ? heading : prev?.heading ?? null };
    newest.set(id, next);
    return { verdict: time === null ? SAMPLE_VERDICT.UNTIMED : SAMPLE_VERDICT.ACCEPTED, ...next };
  }

  return {
    resolve,
    forget: (robotId) => newest.delete(String(robotId || '')),
    clear: () => newest.clear(),
    size: () => newest.size,
  };
}

// ── The motion track ────────────────────────────────────────────────────────

export const MOTION_MODE = Object.freeze({
  /** Tweened from the drawn position to the new sample. */
  ANIMATE: 'ANIMATE',
  /** Placed at the new sample at once (jump, long gap, reduced motion). */
  PLACE: 'PLACE',
  /** Same position and heading as the current target. */
  UNCHANGED: 'UNCHANGED',
});

/** A track at rest on one sample. */
export function createMotionTrack({ lngLat, heading = null, sampleTime = null, nowMs = 0 } = {}) {
  const pose = { lngLat: validLngLat(lngLat), heading: isFiniteNumber(heading) ? heading : null };
  return {
    from: pose,
    to: pose,
    startMs: nowMs,
    durationMs: 0,
    intervalMs: MOTION.DEFAULT_INTERVAL_MS,
    intervalMeasured: false,
    lastSampleTime: isFiniteNumber(sampleTime) ? sampleTime : null,
    lastArrivalMs: nowMs,
    lastFreshMs: nowMs,
  };
}

/** Progress through the current tween, 0…1. */
export function trackProgress(track, nowMs) {
  if (!track || !(track.durationMs > 0)) return 1;
  return Math.max(0, Math.min(1, (nowMs - track.startMs) / track.durationMs));
}

/** Where to draw the robot at `nowMs`. Never beyond the newest sample. */
export function displayedPose(track, nowMs) {
  if (!track || !track.to?.lngLat) return { lngLat: null, heading: null, settled: true };
  const t = trackProgress(track, nowMs);
  const a = track.from?.lngLat || track.to.lngLat;
  const b = track.to.lngLat;
  return {
    lngLat: t >= 1 ? b : [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
    heading: t >= 1 ? track.to.heading ?? track.from?.heading ?? null : lerpHeading(track.from?.heading, track.to.heading, t),
    settled: t >= 1,
  };
}

/**
 * Hand a new (already ordered) sample to the track.
 *
 * @returns {string} a MOTION_MODE
 */
export function retargetTrack(track, { lngLat, heading = null, sampleTime = null } = {}, nowMs, { reducedMotion = false } = {}) {
  const target = validLngLat(lngLat);
  if (!track || !target) return MOTION_MODE.UNCHANGED;
  const nextHeading = isFiniteNumber(heading) ? heading : track.to?.heading ?? null;
  const time = isFiniteNumber(sampleTime) ? sampleTime : null;

  const samePosition = track.to?.lngLat && track.to.lngLat[0] === target[0] && track.to.lngLat[1] === target[1];
  const sameHeading = nextHeading === (track.to?.heading ?? null);

  // Fresh data: a newer server time, or (untimed) a new position. A re-sent
  // copy of the same row is not evidence the robot is still reporting.
  const fresh = time !== null ? track.lastSampleTime === null || time > track.lastSampleTime : !samePosition;
  let measuredGapMs = null;
  if (fresh) {
    measuredGapMs =
      time !== null && track.lastSampleTime !== null ? time - track.lastSampleTime : nowMs - track.lastArrivalMs;
    if (measuredGapMs >= MOTION.MIN_INTERVAL_MS && measuredGapMs <= MOTION.MAX_INTERVAL_MS) {
      // The first measurement replaces the default outright — a stream configured away from
      // 2 s is then drawn right from its second sample — and later ones are smoothed.
      track.intervalMs = track.intervalMeasured
        ? track.intervalMs + (measuredGapMs - track.intervalMs) * MOTION.INTERVAL_SMOOTHING
        : measuredGapMs;
      track.intervalMeasured = true;
    }
    track.lastFreshMs = nowMs;
    if (time !== null) track.lastSampleTime = time;
  }
  const arrivalGapMs = nowMs - track.lastArrivalMs;
  track.lastArrivalMs = nowMs;

  if (samePosition && sameHeading) return MOTION_MODE.UNCHANGED;

  const current = displayedPose(track, nowMs);
  const from = { lngLat: current.lngLat || target, heading: current.heading };
  const to = { lngLat: target, heading: nextHeading };

  const gapS = Math.max((measuredGapMs ?? arrivalGapMs) / 1000, track.intervalMs / 1000, 0.001);
  const impliedSpeed = groundDistanceM(from.lngLat, target) / gapS;
  const place =
    reducedMotion ||
    arrivalGapMs > MOTION.MAX_ANIMATED_GAP_MS ||
    impliedSpeed > MOTION.MAX_PLAUSIBLE_SPEED_MPS;

  const durationMs = Math.min(MOTION.MAX_TWEEN_MS, track.intervalMs * MOTION.INTERVAL_SLACK);
  if (place || durationMs < MOTION.MIN_TWEEN_MS) {
    track.from = to;
    track.to = to;
    track.startMs = nowMs;
    track.durationMs = 0;
    return MOTION_MODE.PLACE;
  }

  track.from = from;
  track.to = to;
  track.startMs = nowMs;
  track.durationMs = durationMs;
  return MOTION_MODE.ANIMATE;
}

/** No fresh sample for longer than the stream's own cadence explains. */
export function isTrackStale(track, nowMs) {
  if (!track) return false;
  const limit = Math.max(MOTION.STALE_MIN_MS, MOTION.STALE_INTERVALS * track.intervalMs);
  return nowMs - track.lastFreshMs > limit;
}

/** Seconds since the last fresh sample, for an operator-facing hint. */
export function secondsSinceFresh(track, nowMs) {
  if (!track) return null;
  return Math.max(0, Math.round((nowMs - track.lastFreshMs) / 1000));
}
