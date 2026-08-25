/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ROBOT LAYER DID NOT MOVE — asserted against the source, not by memory
 *
 * §14 and §43 of this milestone's brief are prohibitions: robots stay 2D, and
 * the future-3D seam is not to be disturbed. `robotRenderSeam.test.mjs` proves
 * the seam still works; this file proves the campus/theme work did not quietly
 * change what the live map ASKS FOR, which no amount of seam testing would
 * catch — a map that renders robots as 3D meshes would still pass every seam
 * test in the suite.
 *
 * These read the actual source files, because the thing under test is what the
 * composition point does, and there is no runtime to interrogate for it here.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ROBOT_REPRESENTATION, toRobotVisual } from '../operational/robotVisual.js';
import { hasRobotRenderer } from '../operational/robotRendererRegistry.js';
import { toRobotWorldAnchor } from '../world/robotWorldAnchor.js';

const read = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

/**
 * Strip comments before asserting on a module's dependencies.
 *
 * These files document the very couplings they must not have ("a `robot:update`
 * twenty times a minute cannot re-run this"), so a naive substring search finds
 * the prohibition itself and reports it as the violation. What is under test is
 * the CODE's dependencies, so the prose is removed first. `//` preceded by a
 * colon is left alone so a `mapbox://` style URL is never mistaken for one.
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const MAP_CONTROL = stripComments(read('../MapControl.jsx'));
const ROBOT_STREAM = stripComments(read('../mapControl/hooks/useRobotStream.js'));
const CAMPUS_LAYER = stripComments(read('../campus/useCampusLayer.js'));
const THEME_HOOK = stripComments(read('../theme/useMapTheme.js'));

test('the live map still asks for the 2D robot representation', () => {
  assert.match(
    MAP_CONTROL,
    /representation:\s*ROBOT_REPRESENTATION\.TWO_D/,
    'MapControl must keep passing the 2D representation to useRobotStream (§14)'
  );
  assert.equal(MAP_CONTROL.includes('ROBOT_REPRESENTATION.THREE_D'), false);
});

test('no 3D robot renderer was registered by this milestone', () => {
  // The seam stays an insertion point, not a half-built mesh (§43).
  assert.equal(hasRobotRenderer(ROBOT_REPRESENTATION.THREE_D), false);
});

test('no 3D geometry stack was introduced for robots', () => {
  for (const [name, source] of [
    ['MapControl.jsx', MAP_CONTROL],
    ['useRobotStream.js', ROBOT_STREAM],
    ['useCampusLayer.js', CAMPUS_LAYER],
    ['useMapTheme.js', THEME_HOOK],
  ]) {
    assert.equal(/from ['"]three['"]/.test(source), false, `${name} must not import three`);
    for (const forbidden of ['GLTFLoader', '.glb', '.gltf', 'MeshStandardMaterial', 'BoxGeometry']) {
      assert.equal(source.includes(forbidden), false, `${name} must not reference ${forbidden} (§14)`);
    }
  }
});

test('the canonical world transform is still the only path to a position', () => {
  // The campus layer draws geometry and the theme layer writes colours; if
  // either had grown its own robot-positioning code, robots and campus
  // features could drift apart on a tilted, terrain-backed map.
  for (const [name, source] of [
    ['useCampusLayer.js', CAMPUS_LAYER],
    ['useMapTheme.js', THEME_HOOK],
  ]) {
    assert.equal(source.includes('toRobotWorldAnchor'), false, `${name} must not transform robot state`);
    assert.equal(source.includes('robot:update'), false, `${name} must not consume telemetry`);
  }
});

test('the campus and theme layers carry no telemetry dependency at all (§42)', () => {
  // The performance contract: a robot moving must not be able to rebuild
  // campus geometry or re-run a theme transition.
  for (const [name, source] of [
    ['useCampusLayer.js', CAMPUS_LAYER],
    ['useMapTheme.js', THEME_HOOK],
  ]) {
    for (const forbidden of ['globalRobots', 'selectedRobotId', 'useRobotStream', 'markersRef']) {
      assert.equal(source.includes(forbidden), false, `${name} must not depend on ${forbidden}`);
    }
  }
});

test('the theme layer never reloads the style (§20)', () => {
  // A `setStyle` here is exactly the forbidden implementation: it would
  // destroy every source, layer, robot marker and route on a theme change.
  assert.equal(/\.setStyle\s*\(/.test(THEME_HOOK), false, 'useMapTheme must not call setStyle');
  assert.equal(/\.setStyle\s*\(/.test(MAP_CONTROL), false, 'MapControl must not call setStyle');
  assert.equal(/\.setStyle\s*\(/.test(CAMPUS_LAYER), false, 'useCampusLayer must not call setStyle');
});

test('robot state still produces the same world anchor it always did', () => {
  // A regression guard on the one formula, unchanged by this milestone.
  const telemetry = { robotId: 'RX-0042', lat: 12.9716, lon: 77.5946, heading: 135 };
  const anchor = toRobotWorldAnchor(telemetry);
  assert.equal(anchor.position.lng, 77.5946);
  assert.equal(anchor.position.lat, 12.9716);
  assert.equal(anchor.rotation.yaw, 135);

  const visual = toRobotVisual(telemetry, {});
  assert.equal(visual.representation, ROBOT_REPRESENTATION.TWO_D);
  assert.deepEqual(visual.anchor, anchor);
});

test('the pure operational and camera modules stay pure', () => {
  // §Q: the seam is agnostic because `world/`, `operational/` and `camera/` are
  // pure modules with no rendering dependency — so a future 3D renderer on a
  // different stack can consume them verbatim. This phase added four of them,
  // and each one is exactly where a `mapbox-gl` import would be convenient.
  for (const name of [
    '../operational/routeGeometry.js',
    '../operational/routeValidation.js',
    '../camera/followCamera.js',
    '../campus/semantics/campusOperational.js',
    '../campus/verification/campusVerification.js',
  ]) {
    const source = stripComments(read(name));
    assert.equal(/from ['"]mapbox-gl['"]/.test(source), false, `${name} must not import mapbox-gl`);
    assert.equal(/from ['"]react['"]/.test(source), false, `${name} must not import react`);
    assert.equal(/from ['"]@\//.test(source), false, `${name} must not use the bundler alias`);
    assert.equal(source.includes('document.'), false, `${name} must not touch the DOM`);
  }
});

test('route validation reports and never repairs — structurally', () => {
  // §3D turns on this: a route that contradicts the campus geometry is reported
  // in words, never nudged, snapped or hidden. A validator that could write to
  // a map or a source is a validator that will eventually be asked to "just
  // fix" the line.
  const source = stripComments(read('../operational/routeValidation.js'));
  for (const forbidden of ['setData', 'setPaintProperty', 'addLayer', 'removeLayer', 'map.']) {
    assert.equal(source.includes(forbidden), false, `route validation must not reference "${forbidden}"`);
  }
});

test('the follow camera is driven by frames, not by telemetry', () => {
  // The defect this replaces: `easeTo` on every `robot:update`. If a camera
  // command ever reappears in the telemetry path, the interrupted-tween stutter
  // comes back with it, and it is invisible in a screenshot.
  const handler = ROBOT_STREAM.slice(ROBOT_STREAM.indexOf('const upsertMarker'), ROBOT_STREAM.indexOf('const syncMarkersToRobots'));
  assert.ok(handler.length > 0, 'could not delimit upsertMarker');
  assert.equal(handler.includes('easeTo'), false, 'a telemetry tick must not issue a camera command');
  assert.equal(handler.includes('flyTo'), false);
  assert.equal(handler.includes('jumpTo'), false);
  assert.ok(handler.includes('followTargetRef'), 'a telemetry tick updates a target');

  // And the loop itself exists and uses the tested pure step function.
  assert.ok(ROBOT_STREAM.includes('stepFollowCamera'), 'the follow loop must use the tested smoothing');
  assert.ok(ROBOT_STREAM.includes('requestAnimationFrame'), 'the follow loop must be frame-driven');
});

test('a telemetry payload with no task can no longer delete a route', () => {
  // The defect: `upsertRoutes` read the task off whatever payload triggered it.
  // `robot:update` carries none, so every tick was read as "this robot has no
  // task" and removed the route that had just been drawn. The task now lives in
  // a record, and only two things clear it.
  assert.ok(ROBOT_STREAM.includes('robotTasksRef'), 'the task record must exist');

  // Delimited by CODE, not by a comment — `ROBOT_STREAM` has had its comments
  // stripped, so a comment marker silently returns -1 and slices to the end of
  // the file, which would make the assertion below read `upsertMarker` too.
  const start = ROBOT_STREAM.indexOf('const upsertRoutes');
  const end = ROBOT_STREAM.indexOf('removeRouteForRobot, themeRef, publishFindings]', start);
  assert.ok(start > 0 && end > start, 'could not delimit upsertRoutes');
  const body = ROBOT_STREAM.slice(start, end);

  // It reads the record, not the payload.
  assert.ok(body.includes('robotTasksRef.current.get(robotId)'));
  assert.equal(/robot\?\.task/.test(body), false, 'upsertRoutes must not read a task off a robot payload');
});

test('the theme decides route colour, never route geometry', () => {
  // Route progress is derived from the unit's position against real path
  // geometry. If a theme could reach that, a colour change could redraw where a
  // unit has been.
  const start = ROBOT_STREAM.indexOf('function applyThemeToRouteLayers');
  assert.ok(start > 0, 'applyThemeToRouteLayers must exist — it is the whole theme→route path');

  // Slice to the function's closing brace at column 0, which is where a
  // top-level function declaration ends in this file.
  const end = ROBOT_STREAM.indexOf('\n}', start);
  assert.ok(end > start, 'could not delimit the function body');
  const body = ROBOT_STREAM.slice(start, end);

  assert.ok(body.includes('setPaintProperty'), 'theme application writes paint properties only');
  assert.equal(body.includes('setData'), false, 'theme application must not touch route data');
  assert.equal(body.includes('splitPath'), false, 'theme application must not recompute route progress');
  assert.equal(body.includes('addLayer'), false, 'theme application must not rebuild a route layer');
});
