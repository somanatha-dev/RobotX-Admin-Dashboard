/**
 * Robots on one spot stay visible on the map (`operational/colocatedRobots.js`).
 *
 * Defect (production, 2026-10-21): three simulated robots online, two markers on the map.
 * SIM-21AF27BE3917 and SIM-7B7FA70643A6 both finished deliveries to "RNSIT Food Court" and parked
 * at 12.900817, 77.518043 to the last decimal; each robot is a DOM marker at its own coordinate, so
 * one covered the other exactly. The fix fans such a group out with a pixel offset on the marker —
 * the robot's coordinate is never changed.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  COLOCATION,
  colocationGroups,
  colocationLayout,
  ringOffsets,
} from '../operational/colocatedRobots.js';
import { groundDistanceM } from '../operational/robotMotion.js';

const FOOD_COURT = [77.518043, 12.900817];
const PU_COLLEGE = [77.518715, 12.900411];
const PRODUCTION = [
  { id: 'SIM-21AF27BE3917', lngLat: FOOD_COURT },
  { id: 'SIM-7B7FA70643A6', lngLat: FOOD_COURT },
  { id: 'SIM-B577AD16BCE6', lngLat: PU_COLLEGE },
];

const distancePx = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** A point `metres` east of `lngLat`. */
const east = (lngLat, metres) => [lngLat[0] + metres / (111320 * Math.cos((lngLat[1] * Math.PI) / 180)), lngLat[1]];

test('the production case: the two Food Court robots are fanned apart, the third stays where it is', () => {
  const layout = colocationLayout(PRODUCTION);
  const a = layout.get('SIM-21AF27BE3917');
  const b = layout.get('SIM-7B7FA70643A6');
  const c = layout.get('SIM-B577AD16BCE6');

  assert.equal(a.groupSize, 2);
  assert.equal(b.groupSize, 2);
  assert.notDeepEqual(a.offset, b.offset, 'two robots on one spot must not be drawn on one pixel');
  assert.ok(distancePx(a.offset, b.offset) >= 2 * COLOCATION.RING_PX - 0.2, 'apart by the ring diameter');
  // Symmetric about the true point, so the pair still marks the place they stand on.
  assert.deepEqual([a.offset[0] + b.offset[0], a.offset[1] + b.offset[1]], [0, 0]);

  assert.deepEqual(c, { offset: [0, 0], groupSize: 1 }, 'a robot alone is drawn exactly at its coordinate');
});

test('every robot in the input gets a layout entry, so the map can draw all three', () => {
  const layout = colocationLayout(PRODUCTION);
  assert.equal(layout.size, PRODUCTION.length);
  const drawn = new Set(PRODUCTION.map((r) => {
    const { offset } = layout.get(r.id);
    return `${r.lngLat.join(',')}|${offset.join(',')}`;
  }));
  assert.equal(drawn.size, 3, 'three robots, three distinct drawn positions');
});

test('robots within 2 m share a spot; robots further apart do not', () => {
  assert.deepEqual(colocationGroups([{ id: 'A', lngLat: FOOD_COURT }, { id: 'B', lngLat: east(FOOD_COURT, 1.5) }]), [['A', 'B']]);
  assert.deepEqual(colocationGroups([{ id: 'A', lngLat: FOOD_COURT }, { id: 'B', lngLat: east(FOOD_COURT, 3) }]), []);
  assert.ok(Math.abs(groundDistanceM(FOOD_COURT, east(FOOD_COURT, 1.5)) - 1.5) < 0.01, 'the fixture is what it says');
});

test('a larger group: every member on one ring, none drawn on top of another', () => {
  const ids = ['R1', 'R2', 'R3', 'R4', 'R5'];
  const layout = colocationLayout(ids.map((id) => ({ id, lngLat: FOOD_COURT })));
  const offsets = ids.map((id) => layout.get(id).offset);
  const radius = COLOCATION.RING_PX + 3 * COLOCATION.RING_PX_PER_MEMBER;
  for (const o of offsets) assert.ok(Math.abs(Math.hypot(o[0], o[1]) - radius) < 0.2);
  for (let i = 0; i < offsets.length; i += 1) {
    for (let j = i + 1; j < offsets.length; j += 1) {
      assert.ok(distancePx(offsets[i], offsets[j]) > 20, `${ids[i]} and ${ids[j]} must not overlap`);
    }
  }
  assert.ok(ids.every((id) => layout.get(id).groupSize === 5));
});

test('the layout does not depend on input order, and ignores robots with no valid position', () => {
  const forward = colocationLayout(PRODUCTION);
  const reversed = colocationLayout([...PRODUCTION].reverse());
  for (const r of PRODUCTION) assert.deepEqual(forward.get(r.id), reversed.get(r.id));

  const withBad = colocationLayout([...PRODUCTION, { id: 'NO-FIX', lngLat: null }, { id: 'NAN', lngLat: [NaN, 1] }]);
  assert.deepEqual(withBad.get('NO-FIX'), { offset: [0, 0], groupSize: 1 });
  assert.deepEqual(withBad.get('SIM-21AF27BE3917'), forward.get('SIM-21AF27BE3917'));
});

test('a group of two is split left and right, so the labels under the markers do not stack', () => {
  const [left, right] = ringOffsets(2);
  assert.equal(left[1], 0);
  assert.equal(right[1], 0);
  assert.ok(left[0] < 0 && right[0] > 0);
  assert.deepEqual(ringOffsets(1), [[0, 0]]);
});

test('wiring: the 2D renderer fans co-located markers with a pixel offset and never moves the robot', () => {
  const source = readFileSync(fileURLToPath(new URL('../operational/renderers/robotMarker2dRenderer.js', import.meta.url)), 'utf8');
  assert.match(source, /import \{ colocationLayout \} from '\.\.\/colocatedRobots\.js';/);
  assert.match(source, /colocationLayout\(handles\.map\(\(h\) => \(\{ id: h\.robotId, lngLat: h\.targetLngLat \}\)\)\)/);
  assert.match(source, /handle\.marker\?\.setOffset\?\.\(offset\)/, 'the offset is a screen-space marker offset');
  // Relaid out when a robot appears, moves to a new sample, or goes away — batched, not per frame.
  assert.equal((source.match(/scheduleRelayout\(\);/g) || []).length, 3);
  assert.match(source, /queueMicrotask\(relayout\)/);
  assert.doesNotMatch(source.slice(source.indexOf('const frame = () =>'), source.indexOf('const ensureLoop')), /relayout/i);
  // The co-location never feeds back into the robot's coordinate.
  assert.doesNotMatch(source, /setLngLat\([^)]*offset/);
});
