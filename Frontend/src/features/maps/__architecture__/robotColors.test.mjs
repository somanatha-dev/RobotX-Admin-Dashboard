/**
 * Every robot on the map has its own colour, and its Pickup / Drop pins wear it
 * (`operational/robotColors.js`).
 *
 * Defect (production, 2026-10-21): the identity colour was `hash(id) % 360` as a hue, so
 * SIM-7B7FA70643A6 (#7de633) and SIM-B577AD16BCE6 (#5de633) were the same green, and the Drop
 * pin was a fixed green for every robot — robots and their deliveries could not be told apart.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  ROBOT_PALETTE,
  assignRobotColors,
  fallbackRobotColor,
  resetFleetColors,
  robotColorFor,
  setFleetRobotIds,
} from '../operational/robotColors.js';
import { colorForRobot } from '../operational/robotVisual.js';

const PRODUCTION = ['RBT-2000', 'SIM-21AF27BE3917', 'SIM-7B7FA70643A6', 'SIM-B577AD16BCE6'];
const LOCAL = ['SIM-2D8E1395193D', 'SIM-3FE59B56468E', 'SIM-C1E3C3312B23', 'SIM-FB88751BAD78', 'SIM-FC21A7B286E9'];

// ── Colour science, for judging the palette rather than eyeballing it ─────────
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = (hex) => {
  const [r, g, b] = rgb(hex).map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrastWithWhite = (hex) => 1.05 / (luminance(hex) + 0.05);
const lab = (hex) => {
  const [r, g, b] = rgb(hex).map(lin);
  const xyz = [
    (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047,
    0.2126 * r + 0.7152 * g + 0.0722 * b,
    (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883,
  ].map((t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116));
  return [116 * xyz[1] - 16, 500 * (xyz[0] - xyz[1]), 200 * (xyz[1] - xyz[2])];
};
const deltaE = (a, b) => Math.hypot(...lab(a).map((v, i) => v - lab(b)[i]));

test('the production fleet: four robots, four distinct colours — the two greens are now different', () => {
  const colors = assignRobotColors(PRODUCTION);
  assert.equal(new Set(colors.values()).size, PRODUCTION.length);
  assert.notEqual(colors.get('SIM-7B7FA70643A6'), colors.get('SIM-B577AD16BCE6'));
  for (const c of colors.values()) assert.ok(ROBOT_PALETTE.includes(c));
});

test('the local fleet: every robot distinct', () => {
  const colors = assignRobotColors(LOCAL);
  assert.equal(new Set(colors.values()).size, LOCAL.length);
});

test('any fleet up to the palette size is distinct (2 000 random fleets)', () => {
  let seed = 42;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let n = 0; n < 2000; n += 1) {
    const size = 2 + Math.floor(random() * (ROBOT_PALETTE.length - 1));
    const ids = Array.from({ length: size }, () => `SIM-${Math.floor(random() * 1e12).toString(16).toUpperCase()}`);
    const colors = assignRobotColors(ids);
    assert.equal(new Set(colors.values()).size, new Set(ids).size, `fleet ${ids.join(',')}`);
  }
});

test('deterministic: the same fleet gets the same colours in any order, on any screen', () => {
  const a = assignRobotColors(PRODUCTION);
  const b = assignRobotColors([...PRODUCTION].reverse());
  for (const id of PRODUCTION) assert.equal(a.get(id), b.get(id));
});

test('beyond the palette the original hue formula is the fallback, still deterministic', () => {
  const ids = Array.from({ length: ROBOT_PALETTE.length + 3 }, (_, i) => `SIM-${String(i).padStart(4, '0')}`);
  const colors = assignRobotColors(ids);
  const fromPalette = [...colors.values()].filter((c) => ROBOT_PALETTE.includes(c));
  assert.equal(new Set(fromPalette).size, ROBOT_PALETTE.length, 'the palette is used in full first');
  const rest = ids.filter((id) => !ROBOT_PALETTE.includes(colors.get(id)));
  assert.equal(rest.length, 3);
  for (const id of rest) assert.equal(colors.get(id), fallbackRobotColor(id));
});

test('the palette: readable white labels, clearly different colours, none mistaken for a state colour', () => {
  for (const c of ROBOT_PALETTE) assert.ok(contrastWithWhite(c) >= 4.5, `${c}: white text contrast ${contrastWithWhite(c).toFixed(2)}`);
  for (let i = 0; i < ROBOT_PALETTE.length; i += 1) {
    for (let j = i + 1; j < ROBOT_PALETTE.length; j += 1) {
      const d = deltaE(ROBOT_PALETTE[i], ROBOT_PALETTE[j]);
      assert.ok(d >= 20, `${ROBOT_PALETTE[i]} vs ${ROBOT_PALETTE[j]}: ΔE ${d.toFixed(1)}`);
    }
  }
  // Error red, charging yellow, warning amber, battery green (lib/mapboxMarkers.js).
  for (const state of ['#ef4444', '#facc15', '#f59e0b', '#22c55e']) {
    for (const c of ROBOT_PALETTE) assert.ok(deltaE(c, state) >= 20, `${c} too close to state colour ${state}`);
  }
  // The colours that failed in production were nearly identical — the measure catches that.
  assert.ok(deltaE('#7de633', '#5de633') < 20);
});

test('the map assignment: colorForRobot reads it; an unchanged fleet reports no recolour', () => {
  resetFleetColors();
  const changed = setFleetRobotIds(PRODUCTION);
  assert.deepEqual([...changed].sort(), [...PRODUCTION].sort(), 'every robot is new the first time');
  const expected = assignRobotColors(PRODUCTION);
  for (const id of PRODUCTION) {
    assert.equal(robotColorFor(id), expected.get(id));
    assert.equal(colorForRobot(id), expected.get(id), 'the marker, route and pins all read this');
  }
  assert.deepEqual(setFleetRobotIds([...PRODUCTION].reverse()), []);
  // A robot the map has not been told about yet still gets a colour.
  assert.equal(robotColorFor('SIM-UNSEEN'), fallbackRobotColor('SIM-UNSEEN'));
  resetFleetColors();
});

test('wiring: pins, route and marker all follow the robot colour, and a fleet change recolours them', () => {
  const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
  const stream = read('../mapControl/hooks/useRobotStream.js');
  assert.doesNotMatch(stream, /#22c55e/, 'the Drop pin is no longer a fixed green');
  assert.match(stream, /createMissionMarkerEl\(\{ color, label: 'Pickup' \}\)/);
  assert.match(stream, /createMissionMarkerEl\(\{ color, label: 'Drop' \}\)/);
  assert.match(stream, /for \(const id of setFleetRobotIds\(listed\)\) lastSyncedRowRef\.current\.delete\(id\);/);
  assert.match(stream, /const signature = \[\s*taskId,[\s\S]*?\bcolor,/, 'a new colour redraws the route');
  assert.match(stream, /existing\.missionColor !== color/, 'pins in an old colour are rebuilt');
  assert.match(stream, /missionColor: color,/);

  const renderer = read('../operational/renderers/robotMarker2dRenderer.js');
  assert.match(renderer, /if \(visual\.color && visual\.color !== handle\.color\) \{\s*setMarkerColor\(handle\.root, visual\.color\);/);

  const markers = read('../../../lib/mapboxMarkers.js');
  assert.match(markers, /export function setMarkerColor\(root, color\)/);
  assert.match(markers, /root\._labelEl\.style\.background = color;/);
  assert.match(markers, /root\._carEl\.innerHTML = carSvg\(color\);/);
});
