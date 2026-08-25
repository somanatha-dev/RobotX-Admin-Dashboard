/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SELECTION AND SEARCH — the map reads state, and never becomes a source of it
 *
 *   npm run test:arch
 *
 * §3F fixes the data flow and it only points one way:
 *
 *      backend telemetry ──► AppProvider ──► robot semantic state ──► renderer
 *
 * Selecting a robot is a VIEW event. It must not write to robot state, must not
 * change a coordinate, must not touch a task, and must not be stored on
 * anything a renderer owns. The failure this guards against is quiet and
 * plausible: a selection handler that "just" stamps `selected: true` onto the
 * robot row, and from there a map that is subtly a source of truth.
 *
 * §3I adds one search system over campus places AND units. Not two — the same
 * index, the same ranking function, one behaviour.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { ROBOT_REPRESENTATION, toRobotVisual } from '../operational/robotVisual.js';
import { anchorToLngLat, toRobotWorldAnchor } from '../world/robotWorldAnchor.js';
import {
  SEARCH_RESULT_TYPE,
  buildCampusFeatureIndex,
  buildCampusSearchIndex,
  buildRobotIndex,
  searchCampusIndex,
} from '../campus/campusSearch.js';
import { resolveCampusDefinition } from '../campus/campusRegistry.js';
import { OPERATIONAL_ROLE } from '../campus/campusSchema.js';

const RNSIT_RECORD = Object.freeze({
  code: 'RNSIT',
  name: 'RNS Institute of Technology',
  centerLat: 12.9023,
  centerLon: 77.5186,
});

const DEFINITION = resolveCampusDefinition(RNSIT_RECORD);

const ROBOTS = Object.freeze([
  { robotId: 'R01', lat: 12.9012, lon: 77.5175, status: 'ACTIVE', battery: 74, heading: 91, speed: 1.2 },
  { robotId: 'R02', lat: 12.9004, lon: 77.5181, status: 'IDLE', battery: 100, heading: 0, speed: 0 },
]);

// ── §3F — selection is a view event ─────────────────────────────────────────

test('selecting a robot does not mutate robot state', () => {
  const robot = { ...ROBOTS[0], task: { taskId: 'T-1' } };
  const snapshot = JSON.stringify(robot);

  toRobotVisual(robot, { selectedRobotId: 'R01', representation: ROBOT_REPRESENTATION.TWO_D });
  toRobotVisual(robot, { selectedRobotId: null, representation: ROBOT_REPRESENTATION.TWO_D });
  toRobotVisual(robot, { selectedRobotId: 'R02', representation: ROBOT_REPRESENTATION.TWO_D });

  assert.equal(JSON.stringify(robot), snapshot, 'building a visual must not write back to robot state');
  assert.equal(robot.selected, undefined, 'selection must never be stamped onto the robot row');
});

test('selection changes exactly one field of the visual, and nothing about position', () => {
  const unselected = toRobotVisual(ROBOTS[0], { selectedRobotId: null });
  const selected = toRobotVisual(ROBOTS[0], { selectedRobotId: 'R01' });

  assert.equal(unselected.selected, false);
  assert.equal(selected.selected, true);

  // Everything else is identical — including, especially, the world anchor. A
  // selected robot is the same robot in the same place.
  const strip = (v) => JSON.stringify({ ...v, selected: null });
  assert.equal(strip(selected), strip(unselected));
  assert.deepEqual(selected.anchor.position, unselected.anchor.position);
  assert.deepEqual(anchorToLngLat(selected.anchor), anchorToLngLat(unselected.anchor));
});

test('robot world coordinates survive the round trip byte for byte', () => {
  // The one thing this whole milestone must not do is move a robot. The
  // transform is the only place state becomes a position, and it must pass the
  // numbers through — not round them, not reproject them, not clamp them.
  for (const robot of ROBOTS) {
    const anchor = toRobotWorldAnchor(robot);
    assert.equal(anchor.position.lat, robot.lat);
    assert.equal(anchor.position.lng, robot.lon);
    assert.deepEqual(anchorToLngLat(anchor), [robot.lon, robot.lat]);

    const visual = toRobotVisual(robot, { selectedRobotId: robot.robotId });
    assert.equal(visual.anchor.position.lat, robot.lat);
    assert.equal(visual.anchor.position.lng, robot.lon);
  }
});

test('a robot with no usable position is not placed, and never falls back to an origin', () => {
  // A robot at [0, 0] is in the Gulf of Guinea. "Not placeable" has to stay
  // distinguishable from "placeable at zero".
  assert.equal(toRobotVisual({ robotId: 'R09' }), null);
  assert.equal(toRobotVisual({ robotId: 'R09', lat: 12.9 }), null);
  assert.equal(toRobotVisual({ lat: 12.9, lon: 77.5 }), null, 'a robot with no id is not a robot');
  assert.equal(toRobotVisual({ robotId: 'R09', lat: null, lon: null }), null);
});

test('the visual carries no speculative 3D properties, still', () => {
  // Repeated here because this phase touched the operational layer: the seam
  // holds only while `RobotVisual` stays the semantic state BOTH
  // representations need.
  const visual = toRobotVisual(ROBOTS[0], { selectedRobotId: 'R01' });
  for (const key of ['wheelRotation', 'bodyMesh', 'lidarMesh', 'chassis', 'suspensionHeight', 'cameraBone']) {
    assert.equal(key in visual, false, `RobotVisual must not carry "${key}"`);
  }
});

// ── §3I — one search system ─────────────────────────────────────────────────

test('searching a campus feature finds it, by name and by what it is', () => {
  const index = buildCampusSearchIndex({ definition: DEFINITION, robots: ROBOTS });

  const named = (q) => searchCampusIndex(index, q, 8)[0];

  const gate = named('Main Gate');
  assert.ok(gate, '"Main Gate" must be findable');
  assert.equal(gate.type, SEARCH_RESULT_TYPE.CAMPUS_FEATURE);
  assert.equal(gate.feature.kind, 'GATE');
  assert.equal(gate.subtitle, 'Gate · campus entrance');

  const bank = named('Canara Bank');
  assert.ok(bank, '"Canara Bank" must be findable');
  assert.match(bank.name, /CANARA BANK/i);

  const cse = named('CSE');
  assert.ok(cse, '"CSE" must be findable');
  assert.equal(cse.type, SEARCH_RESULT_TYPE.CAMPUS_FEATURE);

  // Every campus result carries somewhere to fly to, or it is not a result.
  for (const entry of searchCampusIndex(index, 'r', 8)) {
    assert.equal(typeof entry.lon, 'number');
    assert.equal(typeof entry.lat, 'number');
  }
});

test('searching a unit finds the unit, with the state an operator needs', () => {
  const index = buildCampusSearchIndex({ definition: DEFINITION, robots: ROBOTS });
  const hit = searchCampusIndex(index, 'R01', 8)[0];

  assert.ok(hit);
  assert.equal(hit.type, SEARCH_RESULT_TYPE.ROBOT);
  assert.equal(hit.robotId, 'R01');
  assert.equal(hit.lon, ROBOTS[0].lon, 'the result must carry the unit\'s real position');
  assert.equal(hit.lat, ROBOTS[0].lat);
  assert.match(hit.subtitle, /ACTIVE/);
  assert.match(hit.subtitle, /74%/, 'status and battery are already known — showing them costs nothing');
});

test('the index offers nothing it cannot locate', () => {
  const index = buildCampusSearchIndex({ definition: DEFINITION, robots: ROBOTS });

  // A plausible campus place that this system does not hold. An empty result is
  // the CORRECT answer; a suggestion it cannot fly to would be worse than none.
  assert.deepEqual(searchCampusIndex(index, 'Central Library Annexe', 8), []);
  assert.deepEqual(searchCampusIndex(index, '', 8), []);

  // A robot with no coordinates is not indexed, for the same reason.
  assert.equal(buildRobotIndex([{ robotId: 'R99', status: 'OFFLINE' }]).length, 0);
  assert.equal(buildRobotIndex([{ robotId: '', lat: 1, lon: 1 }]).length, 0);
});

test('a place still outranks a unit whose id happens to match', () => {
  // An operator typing "lib" is looking for a place, not for a robot whose id
  // contains those letters. §3C's operational ranking must not disturb that.
  const index = buildCampusSearchIndex({
    definition: DEFINITION,
    robots: [{ robotId: 'CANARA-1', lat: 12.9, lon: 77.5, status: 'IDLE' }],
  });
  const results = searchCampusIndex(index, 'canara', 8);
  assert.equal(results[0].type, SEARCH_RESULT_TYPE.CAMPUS_FEATURE);
});

test('operational importance breaks ties without overturning name matches', () => {
  const definition = {
    features: [
      {
        id: 'a',
        name: 'Alpha Store',
        kind: 'FACILITY',
        geometry: { type: 'Point', coordinates: [77.51, 12.9] },
        operationalRole: OPERATIONAL_ROLE.NONE,
        operationalPriority: 9,
      },
      {
        id: 'b',
        name: 'Alpha Gate',
        kind: 'GATE',
        geometry: { type: 'Point', coordinates: [77.52, 12.9] },
        operationalRole: OPERATIONAL_ROLE.GATE,
        operationalPriority: 1,
      },
    ],
  };
  const index = buildCampusFeatureIndex(definition);

  // Equal match strength ("Alpha…" prefix on both): the gate wins.
  assert.equal(searchCampusIndex(index, 'alpha', 8)[0].id, 'b');

  // A stronger match on the other one still wins — importance is a tiebreak,
  // never an override. Asking for "Alpha Store" must not return a gate.
  assert.equal(searchCampusIndex(index, 'alpha store', 8)[0].id, 'a');
});

test('the two halves of the index are independent, and compose to the whole', () => {
  // The performance property (§3T): the campus half depends on the campus and
  // the fleet half on the fleet, so a telemetry tick cannot rebuild 65 campus
  // entries to change one robot's status string.
  const campus = buildCampusFeatureIndex(DEFINITION);
  const fleet = buildRobotIndex(ROBOTS);
  const combined = buildCampusSearchIndex({ definition: DEFINITION, robots: ROBOTS });

  assert.equal(combined.length, campus.length + fleet.length);
  assert.deepEqual(combined.slice(0, campus.length).map((e) => e.id), campus.map((e) => e.id));

  // Rebuilding one half with different input leaves the other untouched.
  assert.deepEqual(buildCampusFeatureIndex(DEFINITION).map((e) => e.id), campus.map((e) => e.id));
  assert.equal(buildRobotIndex([]).length, 0);
  assert.equal(campus.length > 0, true);
});

test('a co-located record stays findable even though it surrendered its marker', () => {
  // Withholding a duplicate dot must not also withhold the ability to find the
  // thing (§13). RNS Evening College shares a coordinate with RNS FIRST GRADE
  // COLLEGE and gives up its marker to it.
  const index = buildCampusFeatureIndex(DEFINITION);
  const evening = index.find((e) => /evening/i.test(e.name));
  assert.ok(evening, 'the co-located record must still be searchable');
  assert.match(evening.subtitle, /shares a location/);
  assert.equal(typeof evening.lon, 'number');
});

test('the search index holds no map, no marker and no mutable robot reference', () => {
  const fleet = buildRobotIndex(ROBOTS);
  // The entry carries the id and a position, not the robot object — so a stale
  // search result can never be a second, drifting view of a unit's state.
  assert.equal(fleet[0].robot, undefined);
  assert.equal(fleet[0].robotId, 'R01');
});
