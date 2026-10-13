/**
 * ROBOT MOTION — sample ordering and presentation between samples.
 *
 *   node --test src/features/maps/__architecture__/robotMotion.test.mjs
 *
 * The "before" model below is the previous renderer's tween, reproduced exactly: on every
 * sample, a fixed 1 800 ms ease-out (t·(2−t)) from the drawn position to the new one. Both
 * models are driven by the same constant-speed robot and sampled at 60 frames per second, and
 * the measurements are printed as test diagnostics.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MOTION,
  MOTION_MODE,
  SAMPLE_VERDICT,
  createMotionTrack,
  createSampleGate,
  displayedPose,
  isTrackStale,
  lerpHeading,
  retargetTrack,
  sampleTimeOf,
  shortestAngleDelta,
} from '../operational/robotMotion.js';

const LAT = 12.9007;
const LNG0 = 77.5176;
const M_PER_DEG_LNG = 111320 * Math.cos((LAT * Math.PI) / 180);
const lngLatAt = (metres) => [LNG0 + metres / M_PER_DEG_LNG, LAT];
/** Along-track metres, rounded to the micrometre (degree round-trips leave ~1e-9 m residue). */
const metresOf = (lngLat) => Math.round((lngLat[0] - LNG0) * M_PER_DEG_LNG * 1e6) / 1e6;

/** The previous renderer, as a model: fixed 1 800 ms ease-out from the drawn position. */
function oldTweenModel() {
  let from = null;
  let to = null;
  let start = 0;
  const shown = (t) => {
    if (!to) return null;
    const k = Math.min(1, (t - start) / 1800);
    const e = k * (2 - k);
    return from + (to - from) * e;
  };
  return {
    sample(t, x) {
      from = to === null ? x : shown(t);
      to = x;
      start = t;
    },
    shown,
  };
}

function newTrackModel(opts = {}) {
  let track = null;
  return {
    sample(t, x, sampleTime = t) {
      if (!track) track = createMotionTrack({ lngLat: lngLatAt(x), sampleTime, nowMs: t });
      else retargetTrack(track, { lngLat: lngLatAt(x), sampleTime }, t, opts);
    },
    shown: (t) => (track ? metresOf(displayedPose(track, t).lngLat) : null),
  };
}

/**
 * A robot at `speed` m/s, reporting at `intervals` (ms, cycled), drawn at 60 fps for `seconds`.
 * Returns per-frame drawn speed statistics over the steady state (after the third sample).
 */
function drive(model, { speed = 2, intervals = [2000], seconds = 40 }) {
  const frameMs = 1000 / 60;
  const sampleTimes = [];
  for (let t = 0, i = 0; t <= seconds * 1000; t += intervals[i % intervals.length], i += 1) sampleTimes.push(t);
  let next = 0;
  let lastDrawn = null;
  let newestSample = 0;
  const speeds = [];
  let ahead = 0;
  let parked = 0;
  for (let t = 0; t <= seconds * 1000; t += frameMs) {
    while (next < sampleTimes.length && sampleTimes[next] <= t) {
      newestSample = (sampleTimes[next] / 1000) * speed;
      model.sample(sampleTimes[next], newestSample);
      next += 1;
    }
    const x = model.shown(t);
    if (next > 3 && lastDrawn !== null) {
      const v = ((x - lastDrawn) / frameMs) * 1000;
      speeds.push(v);
      if (v < 0.05 * speed) parked += 1;
      if (x > newestSample + 1e-6) ahead += 1;
    }
    lastDrawn = x;
  }
  const mean = speeds.reduce((a, b) => a + b, 0) / speeds.length;
  const sd = Math.sqrt(speeds.reduce((a, b) => a + (b - mean) ** 2, 0) / speeds.length);
  return {
    meanSpeed: +mean.toFixed(3),
    speedCv: +(sd / mean).toFixed(3),
    maxSpeedRatio: +(Math.max(...speeds) / speed).toFixed(2),
    parkedFrames: +(parked / speeds.length).toFixed(3),
    framesAheadOfData: ahead,
  };
}

test('MEASURED — constant-speed robot, 2 s telemetry (simulator default): surge-and-settle removed', (t) => {
  const before = drive(oldTweenModel(), { intervals: [2000] });
  const after = drive(newTrackModel(), { intervals: [2000] });
  t.diagnostic(`2000 ms  before ${JSON.stringify(before)}`);
  t.diagnostic(`2000 ms  after  ${JSON.stringify(after)}`);
  assert.ok(before.speedCv > 0.4, 'the reproduction shows the old pulsing');
  assert.ok(after.speedCv < 0.05, `drawn speed is steady (cv ${after.speedCv})`);
  assert.ok(Math.abs(after.meanSpeed - 2) < 0.05, 'drawn at the true speed');
  assert.equal(after.parkedFrames, 0);
  assert.equal(after.framesAheadOfData, 0, 'never drawn past the newest sample');
});

test('MEASURED — the interval is live-configurable: 500 ms and 5 s streams', (t) => {
  for (const interval of [500, 5000]) {
    const before = drive(oldTweenModel(), { intervals: [interval], seconds: 60 });
    const after = drive(newTrackModel(), { intervals: [interval], seconds: 60 });
    t.diagnostic(`${interval} ms  before ${JSON.stringify(before)}`);
    t.diagnostic(`${interval} ms  after  ${JSON.stringify(after)}`);
    assert.ok(after.speedCv < 0.05, `${interval}: steady (cv ${after.speedCv})`);
    assert.equal(after.parkedFrames, 0, `${interval}: never parked while the robot moves`);
    assert.equal(after.framesAheadOfData, 0);
  }
  // The old fixed tween parked for most of every 5 s gap.
  assert.ok(drive(oldTweenModel(), { intervals: [5000], seconds: 60 }).parkedFrames > 0.5);
});

test('MEASURED — jittery arrival (1.7–2.3 s): no stops, never ahead of the data', (t) => {
  const jitter = [2000, 2300, 1700, 2200, 1800, 2100, 1900];
  const before = drive(oldTweenModel(), { intervals: jitter, seconds: 60 });
  const after = drive(newTrackModel(), { intervals: jitter, seconds: 60 });
  t.diagnostic(`jitter  before ${JSON.stringify(before)}`);
  t.diagnostic(`jitter  after  ${JSON.stringify(after)}`);
  assert.ok(after.speedCv < before.speedCv / 2);
  assert.ok(after.parkedFrames < 0.02);
  assert.equal(after.framesAheadOfData, 0);
});

test('a jump is placed, not glided: reset/teleport, a long silence, reduced motion', () => {
  const track = createMotionTrack({ lngLat: lngLatAt(0), sampleTime: 0, nowMs: 0 });
  assert.equal(retargetTrack(track, { lngLat: lngLatAt(4), sampleTime: 2000 }, 2000), MOTION_MODE.ANIMATE);
  // 300 m in one 2 s sample (150 m/s) — a reset, not travel.
  assert.equal(retargetTrack(track, { lngLat: lngLatAt(304), sampleTime: 4000 }, 4000), MOTION_MODE.PLACE);
  assert.equal(metresOf(displayedPose(track, 4000).lngLat), 304);
  // A plausible step after a 20 s silence (page was offline, robot paused) — placed.
  assert.equal(retargetTrack(track, { lngLat: lngLatAt(320), sampleTime: 24_000 }, 24_000), MOTION_MODE.PLACE);
  // Reduced motion: every sample is placed.
  assert.equal(retargetTrack(track, { lngLat: lngLatAt(324), sampleTime: 26_000 }, 26_000, { reducedMotion: true }), MOTION_MODE.PLACE);
  // The same position and heading again: nothing to draw.
  assert.equal(retargetTrack(track, { lngLat: lngLatAt(324), sampleTime: 28_000 }, 28_000), MOTION_MODE.UNCHANGED);
});

test('a background tab cannot replay missed motion: the first frame back is the newest sample', () => {
  const track = createMotionTrack({ lngLat: lngLatAt(0), sampleTime: 0, nowMs: 0 });
  // Samples keep arriving while no frame runs (rAF is paused in a hidden tab).
  for (let s = 1; s <= 30; s += 1) retargetTrack(track, { lngLat: lngLatAt(4 * s), sampleTime: s * 2000 }, s * 2000);
  // Return 10 s after the last sample: drawn exactly at it, settled — no backlog, no glide.
  const pose = displayedPose(track, 70_000);
  assert.equal(metresOf(pose.lngLat), 120);
  assert.equal(pose.settled, true);
});

test('heading turns along the shorter arc', () => {
  assert.equal(shortestAngleDelta(350, 10), 20);
  assert.equal(shortestAngleDelta(10, 350), -20);
  assert.equal(shortestAngleDelta(0, 180), 180);
  assert.equal(lerpHeading(350, 10, 0.5), 0);
  assert.equal(lerpHeading(null, 90, 0.3), 90);
  assert.equal(lerpHeading(90, null, 0.3), 90);
  const track = createMotionTrack({ lngLat: lngLatAt(0), heading: 350, sampleTime: 0, nowMs: 0 });
  retargetTrack(track, { lngLat: lngLatAt(4), heading: 10, sampleTime: 2000 }, 2000);
  const mid = displayedPose(track, 2000 + MOTION.DEFAULT_INTERVAL_MS * MOTION.INTERVAL_SLACK * 0.5).heading;
  assert.ok(Math.abs(shortestAngleDelta(0, mid)) < 1e-9, `half-way through 350°→10° is 0°, got ${mid}`);
});

test('stale: no fresh sample for longer than the stream cadence explains; repeats of an old row do not refresh it', () => {
  const track = createMotionTrack({ lngLat: lngLatAt(0), sampleTime: 0, nowMs: 0 });
  for (let s = 1; s <= 5; s += 1) retargetTrack(track, { lngLat: lngLatAt(4 * s), sampleTime: s * 2000 }, s * 2000);
  assert.equal(isTrackStale(track, 10_000 + 7_000), false);
  // The same row re-sent (same server time) does not count as the robot still reporting.
  retargetTrack(track, { lngLat: lngLatAt(20), sampleTime: 10_000 }, 15_000);
  assert.equal(isTrackStale(track, 10_000 + MOTION.STALE_MIN_MS + 1), true);
  // A parked robot that keeps reporting (new time, same place) is fresh.
  retargetTrack(track, { lngLat: lngLatAt(20), sampleTime: 30_000 }, 30_000);
  assert.equal(isTrackStale(track, 31_000), false);
});

test('sample gate: an older REST snapshot cannot move a robot backwards; its newer status still applies', () => {
  const gate = createSampleGate();
  // socket sample at t=10 000, then a REST row computed before it (t=8 000) arrives late
  assert.equal(gate.resolve('SIM-1', { t: 10_000, lngLat: lngLatAt(20), heading: 90 }).verdict, SAMPLE_VERDICT.ACCEPTED);
  const late = gate.resolve('SIM-1', { t: 8_000, lngLat: lngLatAt(16), heading: 80 });
  assert.equal(late.verdict, SAMPLE_VERDICT.OUT_OF_ORDER);
  assert.equal(metresOf(late.lngLat), 20, 'the newest position is kept');
  assert.equal(late.heading, 90);
  // An untimed position (a DB column, no live state) never displaces a timed one.
  assert.equal(gate.resolve('SIM-1', { t: null, lngLat: lngLatAt(0) }).verdict, SAMPLE_VERDICT.UNTIMED_SUPERSEDED);
  // Newer: accepted; equal time: accepted (same sample through the other route).
  assert.equal(gate.resolve('SIM-1', { t: 12_000, lngLat: lngLatAt(24) }).verdict, SAMPLE_VERDICT.ACCEPTED);
  assert.equal(gate.resolve('SIM-1', { t: 12_000, lngLat: lngLatAt(24) }).verdict, SAMPLE_VERDICT.ACCEPTED);
  // A heading-less sample keeps the last heading rather than dropping the arrow.
  assert.equal(gate.resolve('SIM-1', { t: 14_000, lngLat: lngLatAt(28), heading: null }).heading, 90);
  // Far older than the newest (> window): a restarted stream / clock change — accepted, not frozen forever.
  assert.equal(gate.resolve('SIM-1', { t: 14_000 - MOTION.REORDER_WINDOW_MS - 1, lngLat: lngLatAt(1) }).verdict, SAMPLE_VERDICT.ACCEPTED);
});

test('sample gate: invalid coordinates are never drawn; per-robot isolation; forget', () => {
  const gate = createSampleGate();
  assert.equal(gate.resolve('A', { t: 1, lngLat: [NaN, 12] }).lngLat, null);
  assert.equal(gate.resolve('A', { t: 1, lngLat: [77, 95] }).verdict, SAMPLE_VERDICT.INVALID);
  gate.resolve('A', { t: 5, lngLat: lngLatAt(1) });
  gate.resolve('B', { t: 1, lngLat: lngLatAt(9) });
  assert.equal(metresOf(gate.resolve('A', { t: 6, lngLat: [77, 95] }).lngLat), 1, 'an invalid sample keeps the last good position');
  assert.equal(gate.resolve('B', { t: 2, lngLat: lngLatAt(10) }).verdict, SAMPLE_VERDICT.ACCEPTED, 'B is not ordered against A');
  gate.forget('A');
  assert.equal(gate.resolve('A', { t: 1, lngLat: lngLatAt(0) }).verdict, SAMPLE_VERDICT.ACCEPTED);
});

test('sampleTimeOf: socket lastSeenAt, provider telemetryAt, REST live.lastSeenAt — never the ISO Robot column', () => {
  assert.equal(sampleTimeOf({ lastSeenAt: 1700 }), 1700);
  assert.equal(sampleTimeOf({ telemetryAt: 1800, lastSeenAt: '2026-10-13T00:00:00Z', live: { lastSeenAt: 1500 } }), 1800);
  assert.equal(sampleTimeOf({ lastSeenAt: '2026-10-13T00:00:00Z', live: { lastSeenAt: 1500 } }), 1500);
  assert.equal(sampleTimeOf({ lastSeenAt: '2026-10-13T00:00:00Z' }), null);
  assert.equal(sampleTimeOf(null), null);
});

test('wiring: one frame loop per renderer, cancelled on dispose; the gate sits before the renderer; the sync pass skips unchanged rows', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const code = (rel) =>
    fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  const renderer = code('features/maps/operational/renderers/robotMarker2dRenderer.js');
  assert.equal([...renderer.matchAll(/requestAnimationFrame\(frame\)/g)].length, 2, 'the one shared loop (start + continue)');
  assert.doesNotMatch(renderer, /requestAnimationFrame\(step\)/, 'no per-robot tween loops');
  assert.match(renderer, /dispose\(\) \{[\s\S]*stopLoop\(\);[\s\S]*stopFreshnessTimer\(\);[\s\S]*unsubscribeReducedMotion\(\);/);
  assert.match(renderer, /retargetTrack\([\s\S]*\{ reducedMotion \}\s*\)/);

  const hook = code('features/maps/mapControl/hooks/useRobotStream.js');
  const gateAt = hook.indexOf('sampleGateRef.current.resolve(robotKey,');
  const visualAt = hook.indexOf('const visual = toRobotVisual(positioned,');
  assert.ok(gateAt > 0 && visualAt > gateAt, 'positions are ordered before they reach the renderer, routes and camera');
  assert.match(hook, /if \(store\.has\(robotId\) && lastSyncedRowRef\.current\.get\(robotId\) === r\) continue;/);

  // The provider stamps each row with the time of the sample it carries.
  assert.match(code('context/AppProvider.jsx'), /\{ telemetryAt: data\.lastSeenAt \}/);
});
