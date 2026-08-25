/**
 * ═══════════════════════════════════════════════════════════════════════════
 * FOLLOW CAMERA — tracking a unit without being driven by its telemetry
 *
 *   telemetry tick ──► followTarget (a value)          ~ every 2 000 ms
 *                            │
 *                            ▼
 *   animation frame ──► stepFollowCamera()  ──► camera                ~ 60 Hz
 *
 * ── The rule this module exists to hold ───────────────────────────────────
 * §3G: *Do NOT couple camera state directly to raw telemetry updates.*
 *
 * The previous follow camera did exactly that: every `robot:update` called
 * `map.easeTo({ center, duration: 1200 })`. Telemetry arrives about every
 * 2 000 ms, so each ease was still running when the next one replaced it — and
 * an interrupted `easeTo` does not blend, it restarts from wherever the camera
 * had reached, with a fresh ease-in. The result is a camera that accelerates,
 * gets cut off, and accelerates again: motion that is smooth for 1 200 ms at a
 * time and discontinuous at every seam. Turning on Follow also fired a second,
 * competing 900 ms ease at the same target.
 *
 * The fix is to separate the two clocks. Telemetry writes a TARGET — a plain
 * value, no camera call at all. A frame loop moves the camera toward whatever
 * that target currently is. A tick arriving mid-flight changes where the camera
 * is heading without interrupting anything, because nothing was scheduled.
 *
 * ── Why exponential smoothing and not a tween ─────────────────────────────
 * A tween needs a start, an end and a duration, and a moving target invalidates
 * all three every tick — which is the failure above. Exponential smoothing has
 * no endpoint: each frame the camera closes a fixed FRACTION of the remaining
 * gap. It converges on a stationary robot, trails a moving one by a constant
 * distance rather than a growing one, and is frame-rate independent because the
 * per-frame fraction is derived from the elapsed time
 * (`1 - e^(-lambda·dt)`), not assumed at 60 Hz.
 *
 * ── Bearing stays north-up unless asked ───────────────────────────────────
 * `followHeading` defaults to FALSE, preserving the decision recorded in
 * `cameraModes.js`: an operator matching the map against the physical site
 * should not have to redo the rotation in their head, and every robot heading
 * is read against north. The smoothing for it is implemented and tested so
 * enabling it is a flag rather than new mathematics, and it turns through the
 * SHORT arc — 350° → 10° is 20° of rotation, not 340°.
 *
 * Pure module: no React, no Mapbox — loadable under plain Node.
 * ═══════════════════════════════════════════════════════════════════════════
 */

export const FOLLOW_TUNING = Object.freeze({
  /**
   * Position smoothing rate, per second. The camera closes `1 - e^(-λ·dt)` of
   * the remaining gap each frame, so λ = 2.6 closes ~93 % of a gap in one
   * second. Fast enough that the unit does not drift toward the edge of the
   * viewport, slow enough that a single noisy fix does not throw the camera.
   */
  positionLambda: 2.6,
  /** Bearing smoothing rate. Slower than position: rotation is the more nauseating axis. */
  bearingLambda: 1.2,
  /**
   * Dead band, in metres. Below this the camera is not moved at all.
   *
   * This is what stops a stationary robot's GPS jitter from producing a
   * permanently-running animation loop and a camera that shivers — and it is
   * why the loop can idle between ticks instead of burning a frame callback
   * forever.
   */
  minMoveM: 0.5,
  /** Dead band for bearing, in degrees. */
  minBearingDeg: 0.75,
  /**
   * Longest frame delta the smoothing will honour.
   *
   * A backgrounded tab resumes with a delta of many seconds. Fed in raw, the
   * exponential closes essentially the whole gap in one frame and the camera
   * teleports — the exact "camera teleportation" §3J rules out. Clamped, it
   * resumes by flying rather than jumping.
   */
  maxDtMs: 250,
});

const FULL_TURN = 360;

/** Signed shortest rotation from one bearing to another, in (-180, 180]. */
export function shortestAngleDelta(from, to) {
  const a = Number.isFinite(from) ? from : 0;
  const b = Number.isFinite(to) ? to : 0;
  let d = (b - a) % FULL_TURN;
  if (d > 180) d -= FULL_TURN;
  if (d <= -180) d += FULL_TURN;
  return d;
}

export function normaliseBearing(deg) {
  const d = (Number.isFinite(deg) ? deg : 0) % FULL_TURN;
  return d < 0 ? d + FULL_TURN : d;
}

/** Metres between two `[lng, lat]` positions — local planar, campus scale. */
function metresBetween(a, b) {
  const kx = 111320 * Math.cos(((a.lat + b.lat) / 2 / 180) * Math.PI);
  const ky = 110574;
  return Math.hypot((a.lng - b.lng) * kx, (a.lat - b.lat) * ky);
}

/**
 * The camera state the follow loop carries between frames.
 *
 * Seeded from where the camera actually is when Follow is switched on, so the
 * first frame closes a fraction of the real gap rather than snapping to the
 * unit — which is what makes turning Follow on read as the camera travelling to
 * the robot instead of cutting to it.
 */
export function createFollowCameraState({ lng, lat, bearing = 0 } = {}) {
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  return { lng, lat, bearing: normaliseBearing(bearing) };
}

/**
 * Advance the follow camera one frame.
 *
 * Pure: same inputs, same output, no clock read, no side effect. That is what
 * makes the convergence and the dead band unit-testable rather than something
 * judged by watching a map.
 *
 * @param {object|null} state    previous camera state (see `createFollowCameraState`)
 * @param {object|null} target   `{ lng, lat, bearing? }` — where the unit is now
 * @param {number} dtMs          milliseconds since the previous frame
 * @param {object} [options]
 * @param {boolean} [options.followHeading=false]
 * @param {object}  [options.tuning=FOLLOW_TUNING]
 * @returns {{ state: object|null, changed: boolean, settled: boolean }}
 *          `changed` — the camera should be written this frame.
 *          `settled` — the gap is inside the dead band; the caller may stop the
 *                      loop until the next target arrives.
 */
export function stepFollowCamera(state, target, dtMs, options = {}) {
  const { followHeading = false, tuning = FOLLOW_TUNING } = options;

  if (!target || !Number.isFinite(target.lng) || !Number.isFinite(target.lat)) {
    return { state, changed: false, settled: true };
  }
  // No prior state: adopt the target. Only reachable when Follow is switched on
  // without a readable camera, which on a live map does not happen — but a
  // follow loop that returns null forever in that case would silently not
  // follow, and silence is the failure mode this whole file is about.
  if (!state) {
    return {
      state: createFollowCameraState({ lng: target.lng, lat: target.lat, bearing: target.bearing ?? 0 }),
      changed: true,
      settled: false,
    };
  }

  const dt = Math.max(0, Math.min(tuning.maxDtMs, Number.isFinite(dtMs) ? dtMs : 0)) / 1000;
  if (dt === 0) return { state, changed: false, settled: false };

  const alpha = 1 - Math.exp(-tuning.positionLambda * dt);
  const next = {
    lng: state.lng + (target.lng - state.lng) * alpha,
    lat: state.lat + (target.lat - state.lat) * alpha,
    bearing: state.bearing,
  };

  const positionGapM = metresBetween(state, target);
  let bearingGap = 0;

  if (followHeading && Number.isFinite(target.bearing)) {
    const beta = 1 - Math.exp(-tuning.bearingLambda * dt);
    const delta = shortestAngleDelta(state.bearing, target.bearing);
    bearingGap = Math.abs(delta);
    next.bearing = normaliseBearing(state.bearing + delta * beta);
  }

  const settled = positionGapM < tuning.minMoveM && bearingGap < tuning.minBearingDeg;

  // Inside the dead band the camera is left EXACTLY where it was — not nudged
  // by a sub-metre fraction — so a parked unit produces no camera writes at all.
  if (settled) return { state, changed: false, settled: true };

  return { state: next, changed: true, settled: false };
}

/**
 * Comfortable pitch for a follow camera.
 *
 * Bounded on both sides. Below ~35° the tilt stops buying depth and the follow
 * view is just a zoomed overview; above ~60° the horizon takes the upper third
 * of the viewport and the unit — the object the operator is reading — is
 * squeezed into a band. §3G asks for "comfortable"; this is what that means
 * numerically, and it keeps whatever the operator chose inside those limits
 * rather than overriding their camera.
 */
export const FOLLOW_PITCH_RANGE = Object.freeze({ min: 35, max: 60 });

export function comfortableFollowPitch(currentPitch, preferred) {
  const source = Number.isFinite(currentPitch) ? currentPitch : preferred;
  const value = Number.isFinite(source) ? source : FOLLOW_PITCH_RANGE.min;
  return Math.max(FOLLOW_PITCH_RANGE.min, Math.min(FOLLOW_PITCH_RANGE.max, value));
}
