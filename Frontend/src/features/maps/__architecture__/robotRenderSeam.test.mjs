/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ARCHITECTURAL SEAM TEST — can a 3D robot renderer be dropped in later?
 *
 *   node --test src/features/maps/__architecture__/
 *   (or: npm run test:arch, from Frontend/)
 *
 * This test does NOT create a 3D robot, and the double it registers is not a
 * placeholder mesh, a primitive body, or a step toward one — it is a recorder
 * that captures the values a renderer receives. What is under test is the
 * SHAPE OF THE SEAM: that a second representation can be registered and driven
 * by the same robot state, the same world transform, the same selection state
 * and the same camera, with no edit to any of them.
 *
 * The claim being pinned down is the one that decides whether the future 3D
 * milestone is an increment or a migration:
 *
 *      Robot State
 *           ↓
 *   Canonical World Transform      ← one formula, asserted below
 *           ↓
 *   ┌───────────────┬────────────────┐
 *   │ CURRENT       │ FUTURE         │
 *   │ 2D Renderer   │ 3D Renderer    │
 *   └───────────────┴────────────────┘
 *
 * It runs under plain Node with no bundler, no DOM and no WebGL — which is
 * itself part of the proof: if resolving a renderer required a rendering
 * stack, the seam would not be a seam.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  toRobotWorldAnchor,
  anchorToLngLat,
  worldYawToScreenYaw,
  ALTITUDE_SOURCE,
} from '../world/robotWorldAnchor.js';
import { toRobotVisual, ROBOT_REPRESENTATION, colorForRobot } from '../operational/robotVisual.js';
import {
  registerRobotRenderer,
  resolveRobotRenderer,
  createRobotRenderer,
  hasRobotRenderer,
  listRobotRepresentations,
} from '../operational/robotRendererRegistry.js';

// A representative live telemetry payload: exactly the fields
// `Backend/src/sockets/handlers/telemetry.handler.js` emits.
const TELEMETRY = Object.freeze({
  robotId: 'RX-0042',
  lat: 12.9716,
  lon: 77.5946,
  heading: 135,
  battery: 71.4,
  speed: 2.4,
  status: 'ACTIVE',
  isOnline: true,
});

/**
 * A recording test double standing in for a future renderer. It has no
 * geometry of any kind — it stores what it was handed so the test can assert
 * on it. See this file's header on why that is not a fake 3D robot.
 */
function createRecordingRenderer(representation) {
  const calls = { mounted: [], updated: [], selected: [], cameras: [], destroyed: 0, disposed: 0 };
  return () => ({
    representation,
    calls,
    mount(visual) {
      calls.mounted.push(visual);
      return { id: visual.id, calls };
    },
    update(handle, visual) {
      calls.updated.push(visual);
    },
    setSelected(handle, selected) {
      calls.selected.push(selected);
    },
    applyCamera(handle, camera) {
      calls.cameras.push(camera);
    },
    destroy() {
      calls.destroyed += 1;
    },
    dispose() {
      calls.disposed += 1;
    },
  });
}

// ── The canonical world transform ───────────────────────────────────────────

test('robot state becomes a world position in exactly one place', () => {
  const anchor = toRobotWorldAnchor(TELEMETRY);
  assert.ok(anchor, 'telemetry with lat/lon must produce an anchor');
  assert.equal(anchor.robotId, 'RX-0042');
  assert.equal(anchor.position.lng, TELEMETRY.lon);
  assert.equal(anchor.position.lat, TELEMETRY.lat);
  assert.equal(anchor.rotation.yaw, 135);
  assert.equal(anchor.scale, 1);
  assert.deepEqual(anchorToLngLat(anchor), [TELEMETRY.lon, TELEMETRY.lat]);
});

test('the coordinate model carries a third axis rather than assuming z = 0', () => {
  // Today: no altitude channel, and the anchor says so instead of silently
  // pretending ground level is a measurement.
  const ground = toRobotWorldAnchor(TELEMETRY);
  assert.equal(ground.position.altitude, 0);
  assert.equal(ground.altitudeSource, ALTITUDE_SOURCE.GROUND_ASSUMED);

  // The day telemetry grows one, a 3D renderer reads real elevation with no
  // change to state, transport, or this transform's callers.
  const elevated = toRobotWorldAnchor({ ...TELEMETRY, altitude: 18.5 });
  assert.equal(elevated.position.altitude, 18.5);
  assert.equal(elevated.altitudeSource, ALTITUDE_SOURCE.TELEMETRY);

  // Attitude is structurally present for a future chassis, and honest today.
  assert.equal(ground.rotation.pitch, 0);
  assert.equal(ground.rotation.roll, 0);
});

test('a robot without a position is not placeable — never origin', () => {
  assert.equal(toRobotWorldAnchor({ robotId: 'RX-1', lat: null, lon: null }), null);
  assert.equal(toRobotWorldAnchor({ lat: 1, lon: 2 }), null, 'no id means no anchor');
  assert.equal(toRobotVisual({ robotId: 'RX-1' }), null);
});

test('heading is a world fact; only screen-space representations subtract bearing', () => {
  // North-facing robot, camera rotated 90° — on screen the icon must point left.
  assert.equal(worldYawToScreenYaw(0, 90), 270);
  assert.equal(worldYawToScreenYaw(135, 0), 135);
  assert.equal(worldYawToScreenYaw(10, 45), 325, 'must wrap into [0, 360)');
  // The world yaw on the anchor itself is untouched by the camera, which is
  // what lets a future 3D mesh use it directly.
  assert.equal(toRobotWorldAnchor(TELEMETRY).rotation.yaw, 135);
});

// ── The renderer seam ───────────────────────────────────────────────────────

test('asking for "3d" today fails loudly and points at the insertion point', () => {
  assert.equal(hasRobotRenderer(ROBOT_REPRESENTATION.THREE_D), false);
  assert.throws(() => resolveRobotRenderer(ROBOT_REPRESENTATION.THREE_D), /registerRobotRenderer\("3d"/);
});

test('a renderer missing a contract method is rejected at wire-up, not at runtime', () => {
  registerRobotRenderer('broken', () => ({ mount() {}, update() {} }));
  assert.throws(() => createRobotRenderer('broken', {}), /does not satisfy the renderer contract/);
});

test('a 3D renderer drops in and receives the same state the 2D one would', () => {
  // This is the whole future migration, performed: register, and use.
  registerRobotRenderer(ROBOT_REPRESENTATION.THREE_D, createRecordingRenderer(ROBOT_REPRESENTATION.THREE_D));
  assert.ok(listRobotRepresentations().includes(ROBOT_REPRESENTATION.THREE_D));

  const renderer = createRobotRenderer(ROBOT_REPRESENTATION.THREE_D, { getMap: () => null });

  // Same robot state. Same selection state. Same transform. Only the
  // representation string differs from what the live map passes today.
  const visual = toRobotVisual(TELEMETRY, {
    selectedRobotId: 'RX-0042',
    representation: ROBOT_REPRESENTATION.THREE_D,
  });

  const handle = renderer.mount(visual);
  renderer.update(handle, toRobotVisual({ ...TELEMETRY, lat: 12.9722 }, { selectedRobotId: 'RX-0042' }));
  renderer.setSelected(handle, false);
  renderer.applyCamera(handle, { zoom: 17, pitch: 58, bearing: 30 });
  renderer.destroy(handle);

  const { calls } = renderer;
  assert.equal(calls.mounted.length, 1);

  // Everything a 3D robot needs to place and orient itself arrived on the
  // anchor produced by the SAME transform the 2D marker consumes.
  const mounted = calls.mounted[0];
  assert.equal(mounted.id, 'RX-0042');
  assert.equal(mounted.anchor.position.lng, TELEMETRY.lon);
  assert.equal(mounted.anchor.position.lat, TELEMETRY.lat);
  assert.equal(mounted.anchor.position.altitude, 0);
  assert.equal(mounted.anchor.rotation.yaw, 135);
  assert.equal(mounted.selected, true, 'selection is app state, not renderer state');

  // Semantics survive the representation change untouched.
  assert.equal(mounted.status, 'ACTIVE');
  assert.equal(mounted.availability, 'BUSY');
  assert.equal(mounted.health, 'OK');
  assert.equal(mounted.battery, 71.4);
  assert.equal(mounted.color, colorForRobot('RX-0042'));

  assert.equal(calls.updated[0].anchor.position.lat, 12.9722);
  assert.deepEqual(calls.selected, [false]);
  assert.deepEqual(calls.cameras, [{ zoom: 17, pitch: 58, bearing: 30 }]);
  assert.equal(calls.destroyed, 1);
});

test('2D and 3D representations receive byte-identical world state', () => {
  // The single most likely way this migration goes wrong is two position
  // formulas that disagree slightly. There is one formula, so they cannot.
  const asTwoD = toRobotVisual(TELEMETRY, { representation: ROBOT_REPRESENTATION.TWO_D });
  const asThreeD = toRobotVisual(TELEMETRY, { representation: ROBOT_REPRESENTATION.THREE_D });

  assert.deepEqual(asTwoD.anchor, asThreeD.anchor);
  assert.equal(asTwoD.representation, '2d');
  assert.equal(asThreeD.representation, '3d');

  // ...and everything except the renderer name is identical.
  assert.deepEqual({ ...asTwoD, representation: null }, { ...asThreeD, representation: null });
});

test('the semantic model carries no speculative 3D-only properties', () => {
  // Guards §8: a 3D robot's visual details belong to the renderer that has
  // one, not to the contract every representation shares.
  const visual = toRobotVisual(TELEMETRY, {});
  for (const forbidden of [
    'wheelRotation',
    'suspensionHeight',
    'bodyMesh',
    'cameraBone',
    'lidarMesh',
    'antennaRotation',
  ]) {
    assert.equal(forbidden in visual, false, `RobotVisual must not model "${forbidden}" before a 3D robot exists`);
  }

  // What it does carry is the stable set both representations need.
  for (const required of [
    'id',
    'anchor',
    'status',
    'availability',
    'battery',
    'health',
    'selected',
    'timestamp',
    'representation',
  ]) {
    assert.ok(required in visual, `RobotVisual must carry "${required}"`);
  }
});

test('the seam is resolvable without any rendering stack', () => {
  // Passing implicitly: this file imported the world transform, the semantic
  // model and the registry under plain Node. If any of them reached for
  // mapbox-gl, React or a DOM, the module graph would have failed to load and
  // every test above would be unreachable.
  assert.equal(typeof globalThis.document, 'undefined');
  assert.equal(typeof globalThis.WebGLRenderingContext, 'undefined');
});
