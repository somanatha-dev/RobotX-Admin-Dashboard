/**
 * ═══════════════════════════════════════════════════════════════════════════
 * FOLLOW CAMERA — smoothing that is a property, not an impression
 *
 *   npm run test:arch
 *
 * §3G asks for four things, and every one of them is easy to claim and hard to
 * see: follow smoothly, do not snap on every telemetry tick, interpolate
 * heading changes, keep the pitch comfortable. "Looks smooth to me" is not a
 * check — a camera that stutters once every two seconds looks fine in a
 * screenshot and is unusable for an hour.
 *
 * ── What was actually wrong ───────────────────────────────────────────────
 * Every `robot:update` called `map.easeTo({ center, duration: 1200 })`.
 * Telemetry arrives about every 2 000 ms, so each ease was still running when
 * the next replaced it — and an interrupted `easeTo` does not blend, it
 * restarts from wherever the camera had reached with a fresh ease-in. The
 * camera accelerated, was cut off, and accelerated again, forever. Turning
 * Follow on fired a second, competing 900 ms ease at the same target.
 *
 * The fix separates the clocks: telemetry writes a target, a frame loop closes
 * the gap. This file pins the properties that makes true.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FOLLOW_PITCH_RANGE,
  FOLLOW_TUNING,
  comfortableFollowPitch,
  createFollowCameraState,
  normaliseBearing,
  shortestAngleDelta,
  stepFollowCamera,
} from '../camera/followCamera.js';

const AT = Object.freeze({ lng: 77.5186, lat: 12.9023 });

function run(state, target, { frames, dtMs = 16, followHeading = false }) {
  let current = state;
  let writes = 0;
  for (let i = 0; i < frames; i += 1) {
    const result = stepFollowCamera(current, target, dtMs, { followHeading });
    current = result.state;
    if (result.changed) writes += 1;
    if (result.settled) return { state: current, writes, settledAt: i };
  }
  return { state: current, writes, settledAt: null };
}

function metresApart(a, b) {
  const kx = 111320 * Math.cos((a.lat / 180) * Math.PI);
  return Math.hypot((a.lng - b.lng) * kx, (a.lat - b.lat) * 110574);
}

// ── Convergence ─────────────────────────────────────────────────────────────

test('the camera converges on a stationary unit, and then stops writing', () => {
  const start = createFollowCameraState({ lng: 77.5, lat: 12.89, bearing: 0 });
  const { state, settledAt } = run(start, AT, { frames: 600 });

  assert.ok(settledAt !== null, 'the loop must settle rather than run forever');
  assert.ok(metresApart(state, AT) < FOLLOW_TUNING.minMoveM, 'the camera must arrive at the unit');

  // Settling is what lets the frame loop stop. A follow camera that never
  // settles holds a requestAnimationFrame callback for as long as the operator
  // watches, and shivers on a parked unit's GPS noise.
  const after = stepFollowCamera(state, AT, 16, {});
  assert.equal(after.changed, false);
  assert.equal(after.settled, true);
  assert.equal(after.state, state, 'a settled camera must be left exactly where it is');
});

test('convergence is frame-rate independent', () => {
  // The same elapsed time must produce the same camera whether the browser gave
  // us 60 fps or 30. A per-frame constant fraction — the naive form — makes the
  // camera twice as fast on a fast machine.
  const start = () => createFollowCameraState({ lng: 77.5, lat: 12.89, bearing: 0 });
  const fast = run(start(), AT, { frames: 60, dtMs: 16.67 }).state; // ~1s at 60fps
  const slow = run(start(), AT, { frames: 30, dtMs: 33.33 }).state; // ~1s at 30fps

  assert.ok(
    Math.abs(metresApart(fast, AT) - metresApart(slow, AT)) < 1,
    'the same second of wall clock must produce the same camera'
  );
});

test('a moving target is tracked without any command being issued', () => {
  // This is the shape of the fix. The target moves every "tick"; nothing
  // schedules, cancels or restarts anything. The camera simply keeps closing
  // the gap toward wherever the target now is.
  let state = createFollowCameraState({ lng: 77.51, lat: 12.9, bearing: 0 });
  let target = { lng: 77.51, lat: 12.9 };

  for (let tick = 0; tick < 10; tick += 1) {
    // ~10 m of unit movement per 2 s tick — a walking-pace delivery robot.
    target = { lng: target.lng + 0.0001, lat: target.lat };
    for (let f = 0; f < 120; f += 1) {
      const result = stepFollowCamera(state, target, 16.67, {});
      state = result.state;
      if (result.settled) break;
    }
  }

  // Trailing by a bounded distance, not a growing one. A camera that falls
  // further behind every tick puts the unit off screen inside a minute.
  assert.ok(metresApart(state, target) < 2, `camera fell ${metresApart(state, target)} m behind a moving unit`);
});

// ── The dead band ───────────────────────────────────────────────────────────

test('sub-metre jitter moves the camera not at all', () => {
  // A parked unit's position wanders by a fraction of a metre between fixes.
  // Without a dead band the camera chases every one of them and visibly shivers.
  const state = createFollowCameraState(AT);
  const jittered = { lng: AT.lng + 0.000002, lat: AT.lat - 0.000002 };
  const result = stepFollowCamera(state, jittered, 16, {});

  assert.equal(result.changed, false);
  assert.equal(result.settled, true);
  assert.equal(result.state.lng, AT.lng, 'the camera must not be nudged by a sub-metre fraction');
});

test('a backgrounded tab resumes by flying, not by teleporting', () => {
  // A tab that was hidden for a minute resumes with a delta of tens of
  // thousands of milliseconds. Fed in raw, the exponential closes essentially
  // the whole gap in one frame — the camera teleportation §3J rules out.
  const start = createFollowCameraState({ lng: 77.5, lat: 12.89, bearing: 0 });
  const gap = metresApart(start, AT);

  const resumed = stepFollowCamera(start, AT, 60_000, {});
  const closed = gap - metresApart(resumed.state, AT);

  assert.ok(closed > 0, 'the camera must still make progress');
  assert.ok(closed / gap < 0.75, `a single frame closed ${Math.round((closed / gap) * 100)}% of the gap`);
  assert.ok(FOLLOW_TUNING.maxDtMs <= 500);
});

// ── Heading ─────────────────────────────────────────────────────────────────

test('a heading change turns the short way round', () => {
  // 350° → 10° is 20° of rotation, not 340°. Getting this wrong makes the
  // camera spin almost a full turn every time a unit crosses north.
  assert.equal(shortestAngleDelta(350, 10), 20);
  assert.equal(shortestAngleDelta(10, 350), -20);
  assert.equal(shortestAngleDelta(0, 180), 180);
  assert.equal(shortestAngleDelta(0, 181), -179);
  assert.equal(normaliseBearing(-10), 350);
  assert.equal(normaliseBearing(370), 10);
});

test('heading interpolates rather than snapping, when it is followed at all', () => {
  let state = createFollowCameraState({ ...AT, bearing: 350 });
  const target = { ...AT, bearing: 10 };

  const first = stepFollowCamera(state, target, 16, { followHeading: true });
  // Part-way, and on the short arc: past 350 and not yet at 10.
  assert.ok(first.state.bearing > 350 || first.state.bearing < 10);
  assert.notEqual(first.state.bearing, 10, 'the bearing must not snap to the target in one frame');

  state = run(state, target, { frames: 600, followHeading: true }).state;
  assert.ok(Math.abs(shortestAngleDelta(state.bearing, 10)) < FOLLOW_TUNING.minBearingDeg);
});

test('by default the camera does not rotate at all — north stays screen-up', () => {
  // `cameraModes.js` settled this on operational grounds: an operator matching
  // the map against the physical site should not have to redo the rotation in
  // their head, and every robot heading is read against north. The smoothing
  // exists so enabling it later is a flag, not new mathematics.
  const state = createFollowCameraState({ ...AT, bearing: 0 });
  const spun = run(state, { lng: 77.52, lat: 12.91, bearing: 270 }, { frames: 300 }).state;
  assert.equal(spun.bearing, 0, 'following a unit must not rotate the map unless asked');
});

// ── Pitch ───────────────────────────────────────────────────────────────────

test('the follow pitch is bounded on both sides, and respects the operator', () => {
  // Below ~35° the tilt stops buying depth; above ~60° the horizon takes the
  // upper third and the unit is squeezed into a band.
  assert.equal(comfortableFollowPitch(50, null), 50, 'a comfortable choice must be left alone');
  assert.equal(comfortableFollowPitch(10, null), FOLLOW_PITCH_RANGE.min);
  assert.equal(comfortableFollowPitch(85, null), FOLLOW_PITCH_RANGE.max);
  assert.equal(comfortableFollowPitch(undefined, 48), 48);
  assert.equal(comfortableFollowPitch(undefined, undefined), FOLLOW_PITCH_RANGE.min);

  assert.ok(FOLLOW_PITCH_RANGE.min < FOLLOW_PITCH_RANGE.max);
  assert.ok(FOLLOW_PITCH_RANGE.max <= 68, 'must stay within the map\'s own maxPitch');
});

// ── Degenerate input ────────────────────────────────────────────────────────

test('an unusable target leaves the camera alone rather than moving it to nowhere', () => {
  const state = createFollowCameraState(AT);
  for (const target of [null, undefined, {}, { lng: 'x', lat: 12.9 }, { lng: 77.5 }]) {
    const result = stepFollowCamera(state, target, 16, {});
    assert.equal(result.changed, false, `${JSON.stringify(target)} must not move the camera`);
    assert.equal(result.state, state);
  }

  assert.equal(createFollowCameraState({}), null);
  assert.equal(createFollowCameraState({ lng: 77.5 }), null);
});

test('a zero-length frame is not a camera update', () => {
  const state = createFollowCameraState({ lng: 77.5, lat: 12.89 });
  const result = stepFollowCamera(state, AT, 0, {});
  assert.equal(result.changed, false);
  assert.equal(result.state, state);
});

test('the follow camera holds no map, no marker and no robot state', () => {
  // The reason it survives a renderer change: it moves a camera toward a
  // `{ lng, lat }`, and has no idea what is drawn there. A future 3D robot
  // renderer changes nothing here.
  const source = stepFollowCamera.toString() + createFollowCameraState.toString();
  for (const forbidden of ['marker', 'mapbox', 'robotId', 'getElement', 'document']) {
    assert.equal(source.includes(forbidden), false, `the follow camera must not reference "${forbidden}"`);
  }
});
