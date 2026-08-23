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

test('the theme decides route colour, never route geometry', () => {
  // Route progress is derived from `pathIndex` against real path geometry. If
  // a theme could reach that, a colour change could redraw where a unit has
  // been.
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
