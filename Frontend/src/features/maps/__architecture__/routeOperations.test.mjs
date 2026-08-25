/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ROUTES — alignment, progress, visibility, and reporting what is wrong
 *
 *   npm run test:arch
 *
 * The defect these tests were written against is worth stating plainly, because
 * it was invisible for exactly the reason a test suite exists:
 *
 *   The map drew "route travelled" and "route ahead" as two differently-styled
 *   lines, split at `task.pathIndex`. That index is real — the simulation holds
 *   one and the routing service holds one — and NOTHING SENDS IT TO THE
 *   BROWSER. `robot:update` carries position, battery, status, speed and
 *   heading; `TASK_ASSIGNED` carries the paths with no progress. So the split
 *   index was 0 for the entire life of every task: "travelled" was a
 *   zero-length stub and "ahead" was the whole route, from assignment to
 *   completion. Two colours, one meaning.
 *
 * Progress is now derived from the robot's own reported position. These tests
 * pin the three things that has to be:
 *
 *   ALIGNED    every emitted coordinate is a source coordinate or a point ON
 *              the source line — never a smoothed or nudged one (§3D)
 *   HONEST     a unit off its route is reported, not projected onto it anyway
 *   CONTINUOUS the two halves meet exactly, so the route does not appear broken
 * ═══════════════════════════════════════════════════════════════════════════
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LEG_ARRIVAL_M,
  MAX_ROUTE_OFFSET_M,
  ROUTE_SEGMENT,
  advanceRouteState,
  lineCollection,
  metresBetween,
  pathLengthMetres,
  pathToCoordinates,
  projectOntoPath,
  splitPathAtProjection,
  toLonLat,
} from '../operational/routeGeometry.js';
import {
  FINDING_SEVERITY,
  ROUTE_FINDING,
  segmentsIntersect,
  summariseRouteFindings,
  validateRoute,
} from '../operational/routeValidation.js';
import { CAMPUS_FEATURE_KIND, PATH_CLASS } from '../campus/campusSchema.js';
import { CAMPUS_LAYER_ORDER, CAMPUS_LAYER } from '../campus/campusLayers.js';

/** A straight west→east leg at RNSIT's latitude, ~5 vertices, ~100 m apart. */
const PICKUP = [
  { lat: 12.9, lon: 77.51 },
  { lat: 12.9, lon: 77.5109 },
  { lat: 12.9, lon: 77.5118 },
  { lat: 12.9, lon: 77.5127 },
  { lat: 12.9, lon: 77.5136 },
];

/** A leg continuing north from where the pickup leg ends. */
const DROP = [
  { lat: 12.9, lon: 77.5136 },
  { lat: 12.9009, lon: 77.5136 },
  { lat: 12.9018, lon: 77.5136 },
];

// ── Reading a route ─────────────────────────────────────────────────────────

test('both route point shapes are read, and neither swaps lat for lon', () => {
  // The system produces both, and always has: task paths are `{lat, lon}` and
  // GeoJSON coordinates are `[lon, lat]`. A single confused reader here would
  // put the whole fleet in the Arabian Sea.
  assert.deepEqual(toLonLat({ lat: 12.9, lon: 77.5 }), [77.5, 12.9]);
  assert.deepEqual(toLonLat([77.5, 12.9]), [77.5, 12.9]);
  assert.deepEqual(toLonLat({ lat: 12.9, lng: 77.5 }), [77.5, 12.9]);

  assert.equal(toLonLat(null), null);
  assert.equal(toLonLat({ lat: 12.9 }), null);
  assert.equal(toLonLat([77.5]), null);
  assert.equal(toLonLat({ lat: 'x', lon: 1 }), null);

  // Unusable points are dropped, not defaulted to zero — a route through the
  // Gulf of Guinea is the classic way an origin fallback shows up.
  assert.equal(pathToCoordinates([{ lat: 12.9, lon: 77.5 }, null, { lat: 'x', lon: 1 }]).length, 1);
});

// ── §3D — alignment ─────────────────────────────────────────────────────────

test('a split emits only source coordinates and points that lie ON the source line', () => {
  const coords = pathToCoordinates(PICKUP);
  // Sit the unit a third of the way along the second segment.
  const hit = projectOntoPath([77.5112, 12.9], coords);
  const { travelled, ahead } = splitPathAtProjection(coords, hit);

  const isSourceVertex = (p) => coords.some((c) => c[0] === p[0] && c[1] === p[1]);
  const onSourceLine = (p) => {
    // Distance from the point to the polyline must be ~0. Anything else means a
    // coordinate was invented, smoothed or nudged — which on an operations map
    // is the route no longer describing where the unit is going (§3P).
    const back = projectOntoPath(p, coords);
    return back.offsetM < 0.01;
  };

  for (const p of [...travelled, ...ahead]) {
    assert.ok(isSourceVertex(p) || onSourceLine(p), `${p} is neither a source vertex nor on the source line`);
  }
});

test('the two halves meet exactly, so the route never reads as broken', () => {
  // Splitting on a vertex INDEX — which is what a `pathIndex` split does —
  // leaves the halves ending and starting at different places. On a pitched 3D
  // map that gap reads as the route breaking, and the obvious "fix" is to
  // overlap them, which then misreports progress.
  const coords = pathToCoordinates(PICKUP);
  const hit = projectOntoPath([77.5121, 12.9], coords);
  const { travelled, ahead } = splitPathAtProjection(coords, hit);

  assert.deepEqual(travelled[travelled.length - 1], ahead[0], 'the halves must share their junction point');
  assert.ok(travelled.length >= 2 && ahead.length >= 2);

  // And no length is lost or gained by cutting the line.
  const whole = pathLengthMetres(coords);
  const cut = pathLengthMetres(travelled) + pathLengthMetres(ahead);
  assert.ok(Math.abs(whole - cut) < 0.5, `cutting changed the route length by ${Math.abs(whole - cut)} m`);
});

test('progress advances as the unit advances, and never runs backwards', () => {
  const coords = pathToCoordinates(PICKUP);
  let previous = -1;
  for (const lon of [77.51, 77.5105, 77.5115, 77.5125, 77.5136]) {
    const hit = projectOntoPath([lon, 12.9], coords);
    assert.ok(hit.alongM > previous, `progress went backwards at lon ${lon}`);
    previous = hit.alongM;
  }

  // The last position is the end of the route.
  assert.ok(Math.abs(previous - pathLengthMetres(coords)) < 1);
});

test('a route that doubles back cannot drag progress backwards', () => {
  // The real case this exists for: a campus drop leg that retraces the service
  // road the pickup leg used. Without a floor, the geometrically nearest point
  // to a unit halfway down the return leg is a point it passed minutes ago, and
  // the travelled line jumps backwards while the unit moves forwards.
  const out = [[77.51, 12.9], [77.512, 12.9], [77.514, 12.9]];
  const back = [[77.512, 12.9], [77.51, 12.9]];
  const loop = [...out, ...back];

  const naive = projectOntoPath([77.512, 12.9], loop);
  assert.equal(naive.index, 0, 'without a floor the nearest match is the OUTBOUND pass');

  const floored = projectOntoPath([77.512, 12.9], loop, { minIndex: 3 });
  assert.ok(floored.index >= 3, 'with a floor it stays on the leg the unit is actually on');
  assert.ok(floored.alongM > naive.alongM);
});

// ── §3D — the state machine ─────────────────────────────────────────────────

test('a unit starts on the pickup leg with nothing travelled', () => {
  const state = advanceRouteState(null, {
    pathToPickup: PICKUP,
    pathToDrop: DROP,
    point: [77.51, 12.9],
    taskId: 'T1',
  });

  assert.equal(state.segment, ROUTE_SEGMENT.TO_PICKUP);
  assert.equal(state.onRoute, true);
  assert.ok(state.pickup.ahead.length >= 2);
  // The drop leg is entirely ahead: nothing on it has been travelled.
  assert.deepEqual(state.drop.travelled, []);
  assert.ok(state.drop.ahead.length >= 2);
});

test('reaching the end of the pickup leg latches the unit onto the drop leg', () => {
  // Nothing on the wire announces this transition, so it is observed. The latch
  // is what stops a unit that lingers near the pickup point from flickering
  // between the two legs every telemetry tick.
  let state = advanceRouteState(null, { pathToPickup: PICKUP, pathToDrop: DROP, point: [77.51, 12.9], taskId: 'T1' });
  assert.equal(state.segment, ROUTE_SEGMENT.TO_PICKUP);

  state = advanceRouteState(state, { pathToPickup: PICKUP, pathToDrop: DROP, point: [77.5136, 12.9], taskId: 'T1' });
  assert.equal(state.segment, ROUTE_SEGMENT.TO_DROP, 'arriving at the pickup must move the unit onto the drop leg');

  // Latched: the whole pickup leg reads as travelled from here on.
  assert.deepEqual(state.pickup.ahead, []);
  assert.equal(state.pickup.travelled.length, PICKUP.length);

  // And it does not come back, even if the unit drifts toward the pickup path.
  const drifted = advanceRouteState(state, {
    pathToPickup: PICKUP,
    pathToDrop: DROP,
    point: [77.5133, 12.9],
    taskId: 'T1',
  });
  assert.equal(drifted.segment, ROUTE_SEGMENT.TO_DROP);
});

test('a new task resets progress instead of inheriting the last one', () => {
  const finished = advanceRouteState(null, {
    pathToPickup: PICKUP,
    pathToDrop: DROP,
    point: [77.5136, 12.9],
    taskId: 'T1',
  });
  assert.equal(finished.segment, ROUTE_SEGMENT.TO_DROP);

  const next = advanceRouteState(finished, {
    pathToPickup: PICKUP,
    pathToDrop: DROP,
    point: [77.51, 12.9],
    taskId: 'T2',
  });
  assert.equal(next.segment, ROUTE_SEGMENT.TO_PICKUP, 'a different task must start from the beginning');
  assert.equal(next.taskId, 'T2');
});

test('a segment the backend states wins over one this session observed', () => {
  // A replan is the engine saying which leg it just recomputed. An observation
  // must never override something the engine actually said.
  const observed = advanceRouteState(null, {
    pathToPickup: PICKUP,
    pathToDrop: DROP,
    point: [77.5136, 12.9],
    taskId: 'T1',
  });
  assert.equal(observed.segment, ROUTE_SEGMENT.TO_DROP);

  const declared = advanceRouteState(observed, {
    pathToPickup: PICKUP,
    pathToDrop: DROP,
    point: [77.5136, 12.9],
    taskId: 'T1',
    declaredSegment: ROUTE_SEGMENT.TO_PICKUP,
  });
  assert.equal(declared.segment, ROUTE_SEGMENT.TO_PICKUP);
});

test('a unit far off its route is reported, not projected onto it anyway', () => {
  // The honest failure: the nearest point of a route a unit is 200 m from says
  // where the ROUTE is, not where the unit has got to. Drawing a confident
  // split there would be the map inventing progress.
  const state = advanceRouteState(null, {
    pathToPickup: PICKUP,
    pathToDrop: DROP,
    point: [77.5118, 12.905],
    taskId: 'T1',
  });

  assert.equal(state.onRoute, false);
  assert.ok(state.offsetM > MAX_ROUTE_OFFSET_M);
  assert.equal(state.remainingM, null, 'no distance may be reported that was not measured along the route');
  assert.equal(state.fraction, null);
  // The leg is drawn WHOLE rather than split at a meaningless point.
  assert.deepEqual(state.pickup.travelled, []);
  assert.equal(state.pickup.ahead.length, PICKUP.length);
});

test('a session that never saw the transition still finds the unit on the drop leg', () => {
  // A reload, or the operator opening the map mid-task. State defaults to
  // toPickup; the unit is nowhere near the pickup path and sitting on the drop
  // path. Without this the route would show the whole mission as untravelled.
  const state = advanceRouteState(null, {
    pathToPickup: PICKUP,
    pathToDrop: DROP,
    point: [77.5136, 12.9014],
    taskId: 'T1',
  });
  assert.equal(state.segment, ROUTE_SEGMENT.TO_DROP);
  assert.equal(state.onRoute, true);
  assert.ok(state.drop.travelled.length >= 2, 'part of the drop leg is behind it');
});

test('the arrival threshold is a campus distance, not a round number', () => {
  assert.ok(LEG_ARRIVAL_M > 0 && LEG_ARRIVAL_M <= 25, 'a leg must not be "reached" from across the campus');
  assert.ok(MAX_ROUTE_OFFSET_M > LEG_ARRIVAL_M, 'the off-route band must be wider than the arrival band');
});

test('a degenerate route draws nothing rather than a point pretending to be a line', () => {
  assert.equal(lineCollection([]), null);
  assert.equal(lineCollection([[77.5, 12.9]]), null);
  assert.ok(lineCollection([[77.5, 12.9], [77.51, 12.9]]));

  const state = advanceRouteState(null, { pathToPickup: [PICKUP[0]], pathToDrop: DROP, point: [77.51, 12.9], taskId: 'T' });
  assert.equal(state.pickup, null);
});

// ── §3D — route validation, and reporting it ────────────────────────────────

/** A footprint straddling the middle of the pickup leg. */
const BUILDING_ON_ROUTE = Object.freeze({
  id: 'blk-x',
  name: 'Block X',
  kind: CAMPUS_FEATURE_KIND.BUILDING,
  geometry: {
    type: 'Polygon',
    coordinates: [[[77.5114, 12.8997], [77.5114, 12.9003], [77.5122, 12.9003], [77.5122, 12.8997], [77.5114, 12.8997]]],
  },
});

const BUILDING_OFF_ROUTE = Object.freeze({
  id: 'blk-y',
  name: 'Block Y',
  kind: CAMPUS_FEATURE_KIND.BUILDING,
  geometry: {
    type: 'Polygon',
    coordinates: [[[77.52, 12.91], [77.52, 12.911], [77.521, 12.911], [77.521, 12.91], [77.52, 12.91]]],
  },
});

test('a route through a building is reported, with the building named', () => {
  const { findings, checked } = validateRoute({
    path: PICKUP,
    features: [BUILDING_ON_ROUTE, BUILDING_OFF_ROUTE],
    label: 'The approach route',
  });

  assert.equal(checked, true);
  const crossing = findings.find((f) => f.type === ROUTE_FINDING.CROSSES_BUILDING);
  assert.ok(crossing, 'a route straight through a footprint must be reported');
  assert.equal(crossing.severity, FINDING_SEVERITY.SUSPECT);
  assert.equal(crossing.featureName, 'Block X');
  assert.match(crossing.message, /Block X/);
  // The sentence must say that nothing was moved — the whole point of §3D is
  // that the problem is reported rather than rendered away.
  assert.match(crossing.message, /has not been moved/i);

  // And the building nowhere near the route is not reported.
  assert.equal(findings.filter((f) => f.featureId === 'blk-y').length, 0);
});

test('a route across steps is reported, because a ground robot cannot drive them', () => {
  const steps = {
    id: 'steps-1',
    name: 'Library steps',
    kind: CAMPUS_FEATURE_KIND.PATH,
    pathClass: PATH_CLASS.STEPS,
    geometry: { type: 'LineString', coordinates: [[77.5118, 12.8995], [77.5118, 12.9005]] },
  };
  const { findings } = validateRoute({ path: PICKUP, features: [steps], label: 'The delivery route' });
  const hit = findings.find((f) => f.type === ROUTE_FINDING.CROSSES_STEPS);
  assert.ok(hit);
  assert.equal(hit.severity, FINDING_SEVERITY.SUSPECT);
  assert.match(hit.message, /not a driveable surface/);
});

test('leaving the campus is a note, not a fault', () => {
  // A pickup outside the perimeter is an ordinary task, and the main gate is
  // outside the boundary almost by definition. Reporting it as an error would
  // train an operator to ignore the panel.
  const boundary = {
    id: 'b',
    name: 'Campus',
    kind: CAMPUS_FEATURE_KIND.BOUNDARY,
    geometry: {
      type: 'Polygon',
      coordinates: [[[77.5115, 12.8995], [77.5115, 12.9005], [77.514, 12.9005], [77.514, 12.8995], [77.5115, 12.8995]]],
    },
  };
  const { findings } = validateRoute({ path: PICKUP, features: [boundary], label: 'The approach route' });
  const note = findings.find((f) => f.type === ROUTE_FINDING.LEAVES_CAMPUS);
  assert.ok(note);
  assert.equal(note.severity, FINDING_SEVERITY.NOTE);
  assert.ok(note.count > 0 && note.count < PICKUP.length);
});

test('an off-route unit produces a finding of its own', () => {
  const { findings } = validateRoute({ path: PICKUP, features: [], label: 'the approach route', robotOffsetM: 140 });
  const off = findings.find((f) => f.type === ROUTE_FINDING.ROBOT_OFF_ROUTE);
  assert.ok(off);
  assert.equal(off.metres, 140);

  // Inside the band, nothing is said.
  assert.equal(
    validateRoute({ path: PICKUP, features: [], label: 'x', robotOffsetM: 3 }).findings.some(
      (f) => f.type === ROUTE_FINDING.ROBOT_OFF_ROUTE
    ),
    false
  );
});

test('validation reports and never repairs', () => {
  // The property that matters most: the route handed in comes back untouched.
  const path = PICKUP.map((p) => ({ ...p }));
  const snapshot = JSON.stringify(path);
  validateRoute({ path, features: [BUILDING_ON_ROUTE], label: 'x' });
  assert.equal(JSON.stringify(path), snapshot, 'validation must not modify the route it inspects');
});

test('one problem reported once, across both legs of a task', () => {
  // The pickup and drop legs of a task usually clip the same building, and
  // reporting it twice makes one problem look like two.
  const a = validateRoute({ path: PICKUP, features: [BUILDING_ON_ROUTE], label: 'The approach route' });
  const b = validateRoute({ path: PICKUP, features: [BUILDING_ON_ROUTE], label: 'The delivery route' });
  const summary = summariseRouteFindings([
    { robotId: 'R01', findings: a.findings },
    { robotId: 'R01', findings: b.findings },
  ]);

  assert.equal(summary.findings.filter((f) => f.type === ROUTE_FINDING.CROSSES_BUILDING).length, 1);
  assert.equal(summary.suspect, 1);

  // Two different units hitting the same building are one finding naming both.
  const twoUnits = summariseRouteFindings([
    { robotId: 'R01', findings: a.findings },
    { robotId: 'R02', findings: a.findings },
  ]);
  assert.deepEqual(twoUnits.findings[0].robotIds, ['R01', 'R02']);
});

test('a route with nothing to draw says so instead of failing silently', () => {
  const { findings, checked } = validateRoute({ path: [{ lat: 12.9, lon: 77.5 }], features: [], label: 'x' });
  assert.equal(checked, false);
  assert.equal(findings[0].type, ROUTE_FINDING.DEGENERATE);
});

test('segment intersection handles the cases a campus actually produces', () => {
  // Crossing.
  assert.equal(segmentsIntersect([0, 0], [2, 2], [0, 2], [2, 0]), true);
  // Parallel, no touch.
  assert.equal(segmentsIntersect([0, 0], [2, 0], [0, 1], [2, 1]), false);
  // Touching at an endpoint — a route that STOPS on a building edge is still a
  // route that reaches the building.
  assert.equal(segmentsIntersect([0, 0], [1, 1], [1, 1], [2, 0]), true);
  // Collinear overlap — a route running ALONG a wall.
  assert.equal(segmentsIntersect([0, 0], [2, 0], [1, 0], [3, 0]), true);
});

// ── §3D — the route stays visible over the 3D campus ────────────────────────

test('route layers are added after the campus layers, so buildings cannot bury them', () => {
  // Campus layers are installed as a fixed, ordered set at style load. Route
  // layers are added later, by `useRobotStream`, and Mapbox draws a layer added
  // later ON TOP. This asserts the campus set contains no route layer — i.e.
  // that nothing in the campus order can ever be inserted above one.
  for (const id of CAMPUS_LAYER_ORDER) {
    assert.equal(/robot-route/.test(id), false, `${id} looks like a route layer inside the campus order`);
  }

  // And the campus set ends with its labels, not with an extrusion: a route is
  // added above the whole set, so the last campus layer is what a route has to
  // clear.
  assert.equal(CAMPUS_LAYER_ORDER[CAMPUS_LAYER_ORDER.length - 1], CAMPUS_LAYER.LABEL_SELECTED);
  assert.ok(
    CAMPUS_LAYER_ORDER.indexOf(CAMPUS_LAYER.BUILDINGS) < CAMPUS_LAYER_ORDER.indexOf(CAMPUS_LAYER.LABEL_P1),
    'the building extrusions must sit below the label layers'
  );
});

test('a route is measured in metres on the ground, not in degrees', () => {
  // A degree of longitude at RNSIT is ~108 km and a degree of latitude ~111 km.
  // Any distance computed in raw degrees would be wrong by ~3% between the two
  // axes — enough to make an "arrived at the leg end" test fire in the wrong
  // place depending on which way the unit was travelling.
  const east = metresBetween([77.51, 12.9], [77.511, 12.9]);
  const north = metresBetween([77.51, 12.9], [77.51, 12.901]);
  assert.ok(Math.abs(east - 108.5) < 2, `east-west metre conversion is off: ${east}`);
  assert.ok(Math.abs(north - 110.6) < 2, `north-south metre conversion is off: ${north}`);
  assert.ok(north > east, 'a degree of latitude is longer than a degree of longitude at 12.9°N');
});
