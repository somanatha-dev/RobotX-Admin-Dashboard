/**
 * Projection math for the 2D marker on the 3D map.
 *
 * These are the numbers that decide whether a flat marker still tells the
 * truth once the camera can tilt and rotate. They are pure functions, so they
 * are pinned here rather than left to be judged by eye against a live map.
 *
 * `lib/mapboxMarkers.js` imports nothing, so it loads under plain Node; the
 * DOM-touching functions are simply not called.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { groundFlattenForPitch, markerScaleForZoom } from '../../../lib/mapboxMarkers.js';
import { worldYawToScreenYaw } from '../world/robotWorldAnchor.js';
import { CAMERA_PRESETS, MAX_PITCH, flightDurationForZoomDelta } from '../environment/environmentConfig.js';

test('ground foreshortening follows cos(pitch), with a legibility floor', () => {
  // Top-down: the ground plane is the screen plane, so no compression at all.
  assert.equal(groundFlattenForPitch(0), 1);

  // 60° tilt: a horizontal plane projects to exactly half its height.
  assert.ok(Math.abs(groundFlattenForPitch(60) - 0.5) < 1e-9);

  // At the camera's maximum tilt the true cosine (~0.37) would squash the
  // vehicle into an unreadable sliver, so the floor takes over. The contact
  // shadow and the screen-facing chip carry position and identity there.
  assert.equal(groundFlattenForPitch(68), 0.42);
  assert.equal(groundFlattenForPitch(85), 0.42);

  // Junk in must not produce a collapsed or inverted marker.
  assert.equal(groundFlattenForPitch(undefined), 1);
  assert.equal(groundFlattenForPitch(NaN), 1);
  assert.equal(groundFlattenForPitch(-20), 1);
});

test('marker scale shrinks with zoom-out and is clamped at both ends', () => {
  assert.equal(markerScaleForZoom(17), 1);
  assert.equal(markerScaleForZoom(20), 1);
  assert.equal(markerScaleForZoom(12), 0.45);
  assert.equal(markerScaleForZoom(3), 0.45);
  // Monotonic across the interpolation band — no size inversion mid-zoom.
  assert.ok(markerScaleForZoom(13) < markerScaleForZoom(15));
  assert.ok(markerScaleForZoom(15) < markerScaleForZoom(16.5));
  assert.equal(markerScaleForZoom(undefined), 1);
});

test('a rotated camera does not make robots point the wrong way', () => {
  // The regression this guards: before the map could rotate, the icon was
  // rotated by the raw compass heading, which is only correct while screen-up
  // is north. With bearing enabled, every robot would have pointed wrong by
  // exactly the camera bearing.
  const heading = 90; // due east
  assert.equal(worldYawToScreenYaw(heading, 0), 90);
  assert.equal(worldYawToScreenYaw(heading, 90), 0, 'camera turned east → east is screen-up');
  assert.equal(worldYawToScreenYaw(heading, 180), 270);
  assert.equal(worldYawToScreenYaw(heading, 270), 180);

  // A robot with no heading has no screen yaw to apply — the icon keeps its
  // last known orientation rather than snapping to north.
  assert.equal(worldYawToScreenYaw(null, 45), null);
});

test('camera flights are bounded, however far they travel', () => {
  // The regression this guards: an unbounded world→campus flight (~15.7 zoom
  // levels) ran for many seconds, fetching and discarding a batch of tiles at
  // every intermediate zoom. That is what read as "the map glitches on load".
  const worldToCampus = CAMERA_PRESETS.CAMPUS.zoom - CAMERA_PRESETS.WORLD.zoom;
  assert.ok(worldToCampus > 15, 'sanity: this really is a long flight');
  assert.ok(flightDurationForZoomDelta(worldToCampus) <= 3000);
  assert.ok(flightDurationForZoomDelta(worldToCampus) >= 2000, 'still reads as a flight, not a jump cut');

  // Direction must not matter — flying back out is bounded identically.
  assert.equal(
    flightDurationForZoomDelta(-worldToCampus),
    flightDurationForZoomDelta(worldToCampus)
  );

  // The cap genuinely binds for anything longer.
  assert.equal(flightDurationForZoomDelta(100), 3000);

  // Short hops stay snappy rather than being padded up to the cap.
  const areaToCampus = CAMERA_PRESETS.CAMPUS.zoom - CAMERA_PRESETS.AREA.zoom;
  assert.ok(flightDurationForZoomDelta(areaToCampus) < 1500);
  assert.equal(flightDurationForZoomDelta(0), 700);
  assert.equal(flightDurationForZoomDelta(undefined), 700);
});

test('every camera preset is within the map’s pitch limit', () => {
  // A preset above maxPitch would be silently clamped by Mapbox, leaving the
  // configured value and the actual camera quietly disagreeing.
  for (const [level, preset] of Object.entries(CAMERA_PRESETS)) {
    assert.ok(preset.pitch >= 0 && preset.pitch <= MAX_PITCH, `${level} pitch out of range`);
  }
  // Long-range levels stay flat: tilt is only introduced where buildings and
  // terrain are actually resolvable.
  assert.equal(CAMERA_PRESETS.WORLD.pitch, 0);
  assert.equal(CAMERA_PRESETS.COUNTRY.pitch, 0);
  assert.equal(CAMERA_PRESETS.STATE.pitch, 0);
  assert.equal(CAMERA_PRESETS.CITY.pitch, 0);
  assert.ok(CAMERA_PRESETS.AREA.pitch > 0);
  assert.ok(CAMERA_PRESETS.CAMPUS.pitch > CAMERA_PRESETS.AREA.pitch);
});
