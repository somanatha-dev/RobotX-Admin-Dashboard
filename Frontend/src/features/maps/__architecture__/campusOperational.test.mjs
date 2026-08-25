/**
 * ═══════════════════════════════════════════════════════════════════════════
 * OPERATIONAL SEMANTICS — gates, operational POIs, and what is NOT claimed
 *
 *   npm run test:arch
 *
 * Three properties, and the third is the one that matters most:
 *
 *   1. a GATE is a first-class feature with a real access model (§3B)
 *   2. operational locations are separated from scenery by DERIVATION, never by
 *      a hard-coded name or position (§3C)
 *   3. the roles with no data behind them claim NOTHING
 *
 * (3) is the load-bearing one. `CHARGING_POINT` and `DOCKING_STATION` exist in
 * the vocabulary so a future record has somewhere to land. The failure mode is
 * that they get "helpfully" filled in — the parking apron reinterpreted as a
 * staging dock, a substation as a charger — and an operator is then reading a
 * facility the campus does not have. A count of zero, asserted, is what keeps
 * "prepared for" from drifting into "pretended".
 * ═══════════════════════════════════════════════════════════════════════════
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACCESS_STATE,
  CAMPUS_FEATURE_KIND,
  GATE_ACCESS_CHANNELS,
  GATE_STATUS,
  OPERATIONAL_ROLE,
  OPERATIONAL_PRIORITY,
  gateAccessIsKnown,
  isOperationalRole,
  operationalPriorityFor,
  unknownGateAccess,
  validateCampusFeature,
} from '../campus/campusSchema.js';
import {
  applyOperationalProfiles,
  deriveGateAccess,
  deriveOperationalRole,
  describeOperationalModel,
  nearestNamedFeature,
} from '../campus/semantics/campusOperational.js';
import { CAMPUS_GEOMETRY, resolveCampusDefinition } from '../campus/campusRegistry.js';
import { labelAnchorFor } from '../campus/campusLayers.js';

const RNSIT_RECORD = Object.freeze({
  code: 'RNSIT',
  name: 'RNS Institute of Technology',
  centerLat: 12.9023,
  centerLon: 77.5186,
});

const FEATURES = CAMPUS_GEOMETRY.RNSIT.features;

// ── §3B — gates ─────────────────────────────────────────────────────────────

test('the gate is a first-class campus feature with a complete access model', () => {
  const gates = FEATURES.filter((f) => f.kind === CAMPUS_FEATURE_KIND.GATE);
  assert.equal(gates.length, 1, 'RNSIT has exactly one recorded gate');

  const gate = gates[0];
  assert.equal(gate.operationalRole, OPERATIONAL_ROLE.GATE);
  assert.equal(gate.operationalPriority, OPERATIONAL_PRIORITY.GATE);
  assert.equal(
    gate.operationalPriority,
    Math.min(...Object.values(OPERATIONAL_PRIORITY)),
    'nothing on a campus outranks the way on and off it'
  );

  // Every channel is PRESENT and every channel is UNKNOWN. Present, because a
  // field that is absent reads as "nobody thought about it"; UNKNOWN, because
  // no source records gate access and inventing one would be a routing claim.
  for (const channel of GATE_ACCESS_CHANNELS) {
    assert.equal(gate.access[channel], ACCESS_STATE.UNKNOWN, `access.${channel} must be explicitly unknown`);
  }
  assert.equal(gate.access.status, GATE_STATUS.UNKNOWN);
  assert.equal(gate.accessKnown, false, 'nothing may claim to know this gate\'s access rules');
  assert.equal(gateAccessIsKnown(gate.access), false);
});

test('access rules are translated from a source, never assumed', () => {
  // Nothing fires on RNSIT's data — every value is UNKNOWN. The table is
  // exercised here so that the day a source DOES carry access, the translation
  // is the one that was reviewed rather than one written under pressure.
  const withTags = deriveGateAccess({
    sourceTags: { motor_vehicle: 'no', foot: 'yes', access: 'private', gateStatus: 'MANNED' },
  });
  assert.equal(withTags.access.vehicle, ACCESS_STATE.PROHIBITED);
  assert.equal(withTags.access.pedestrian, ACCESS_STATE.ALLOWED);
  // OSM `private` is RESTRICTED, not PROHIBITED — a campus fleet on a private
  // road is the normal case, and reading it as "prohibited" would rule out the
  // entire internal network.
  assert.equal(withTags.access.service, ACCESS_STATE.RESTRICTED);
  assert.equal(withTags.access.status, GATE_STATUS.MANNED);
  assert.equal(withTags.known, true);

  // A generic `access` must not overwrite a channel that answered specifically.
  assert.equal(withTags.access.vehicle, ACCESS_STATE.PROHIBITED);

  // And an empty source yields UNKNOWN everywhere, never a default of "allowed".
  const empty = deriveGateAccess({ sourceTags: {} });
  assert.equal(empty.known, false);
  for (const channel of GATE_ACCESS_CHANNELS) {
    assert.equal(empty.access[channel], ACCESS_STATE.UNKNOWN);
  }
});

test('only a gate may declare access rules', () => {
  // "Vehicle access: ALLOWED" on a lecture block reads to an operator as a
  // routing fact and is not one.
  const building = {
    id: 'b',
    name: 'Block',
    kind: CAMPUS_FEATURE_KIND.BUILDING,
    geometry: { type: 'Polygon', coordinates: [[[0, 0], [0, 1], [1, 1], [0, 0]]] },
    provenance: 'OPEN_DATA_IMPORT',
    verification: 'NOT_VERIFIED',
    source: 's',
    access: unknownGateAccess(),
  };
  assert.ok(validateCampusFeature(building).some((e) => /only a GATE/.test(e)));

  const gate = {
    id: 'g',
    name: 'Gate',
    kind: CAMPUS_FEATURE_KIND.GATE,
    geometry: { type: 'Point', coordinates: [77.5, 12.9] },
    provenance: 'USER_SUPPLIED',
    verification: 'NOT_VERIFIED',
    source: 's',
    access: unknownGateAccess(),
  };
  assert.deepEqual(validateCampusFeature(gate), []);

  // A value outside the vocabulary is rejected rather than rendered as itself.
  assert.ok(
    validateCampusFeature({ ...gate, access: { ...unknownGateAccess(), vehicle: 'MAYBE' } }).some((e) =>
      /access\.vehicle/.test(e)
    )
  );
});

// ── §3C — operational POIs ──────────────────────────────────────────────────

test('operational locations are separated from scenery, and the split is real', () => {
  const summary = describeOperationalModel(FEATURES);

  // The campus actually has these, and the counts are asserted so a rule change
  // that silently reclassifies half the campus is visible here rather than on a
  // screenshot.
  assert.equal(summary.byRole[OPERATIONAL_ROLE.GATE], 1);
  assert.equal(summary.byRole[OPERATIONAL_ROLE.PARKING], 1);
  assert.ok(summary.byRole[OPERATIONAL_ROLE.FOOD_SERVICE] >= 1);
  assert.ok(summary.byRole[OPERATIONAL_ROLE.DEPARTMENT] >= 5);

  // And most of the campus is NOT operational. A model in which everything is
  // important is a model that has stopped saying anything.
  assert.ok(summary.byRole[OPERATIONAL_ROLE.NONE] > summary.operational, 'scenery must outnumber worksites');
});

test('nothing claims a charging point or a docking station, because no data supplies one', () => {
  // The whole point of §3C's "prepare the architecture, do not invent them".
  const claimed = FEATURES.filter(
    (f) => f.operationalRole === OPERATIONAL_ROLE.CHARGING_POINT || f.operationalRole === OPERATIONAL_ROLE.DOCKING_STATION
  );
  assert.deepEqual(
    claimed.map((f) => f.name),
    [],
    'a charging or docking location appeared with no source behind it'
  );

  // Nor does any static feature claim to be a task's pickup or drop: those are
  // live operational records, held by the operational layer, not by geography.
  assert.equal(FEATURES.filter((f) => f.operationalRole === OPERATIONAL_ROLE.PICKUP_DROP_POINT).length, 0);

  // The roles exist and are ranked, so supporting one is a row in a table.
  assert.ok(OPERATIONAL_ROLE.CHARGING_POINT && OPERATIONAL_ROLE.DOCKING_STATION);
  assert.ok(operationalPriorityFor(OPERATIONAL_ROLE.DOCKING_STATION) < operationalPriorityFor(OPERATIONAL_ROLE.PARKING));
});

test('a role is derived from declared fields, never from a name the map made up', () => {
  // The supplied word wins where the dataset says what a thing is.
  assert.equal(
    deriveOperationalRole({ kind: CAMPUS_FEATURE_KIND.FACILITY, sourceKind: 'PARKING', name: 'X' }).role,
    OPERATIONAL_ROLE.PARKING
  );
  // An OSM tag wins over a name.
  assert.equal(
    deriveOperationalRole({
      kind: CAMPUS_FEATURE_KIND.FACILITY,
      name: 'Somewhere',
      sourceTags: { amenity: 'food_court' },
    }).role,
    OPERATIONAL_ROLE.FOOD_SERVICE
  );

  // An UNNAMED feature is never a destination: "Unnamed building" is not
  // somewhere a task can be addressed to (§4).
  assert.equal(
    deriveOperationalRole({
      kind: CAMPUS_FEATURE_KIND.BUILDING,
      category: 'ACADEMIC',
      name: 'Unnamed building',
      nameIsDescriptive: true,
    }).role,
    OPERATIONAL_ROLE.NONE
  );

  // Circulation is how a robot gets somewhere, never the somewhere.
  for (const kind of [CAMPUS_FEATURE_KIND.ROAD, CAMPUS_FEATURE_KIND.PATH, CAMPUS_FEATURE_KIND.BOUNDARY]) {
    assert.equal(deriveOperationalRole({ kind, name: 'Main Road' }).role, OPERATIONAL_ROLE.NONE);
  }

  // And a landmark stays scenery, however prominent.
  assert.equal(
    deriveOperationalRole({ kind: CAMPUS_FEATURE_KIND.LANDMARK, name: 'RN Shetty Statue', category: 'UNCLASSIFIED' })
      .role,
    OPERATIONAL_ROLE.NONE
  );
});

test('applying profiles moves no geometry and mutates no input', () => {
  const before = [
    {
      id: 'a',
      name: 'CSE Department',
      kind: CAMPUS_FEATURE_KIND.BUILDING,
      category: 'ACADEMIC',
      geometry: { type: 'Polygon', coordinates: [[[77.5, 12.9], [77.5, 12.91], [77.51, 12.91], [77.5, 12.9]]] },
      metadata: { existing: 'kept' },
    },
  ];
  const after = applyOperationalProfiles(before);

  assert.equal(after[0].geometry, before[0].geometry, 'geometry must be the SAME object');
  assert.equal(after[0].operationalRole, OPERATIONAL_ROLE.DEPARTMENT);
  assert.equal(after[0].metadata.existing, 'kept', 'existing metadata must survive');
  assert.ok(after[0].metadata['Operational role'], 'the derivation must be visible on the card');
  assert.equal(before[0].operationalRole, undefined, 'the input must not be mutated');
});

// ── §3K — the hierarchy reaches the renderer ────────────────────────────────

test('every feature carries a label rank and a marker scale, bounded', () => {
  for (const f of FEATURES) {
    assert.equal(typeof f.labelRank, 'number', `${f.id} has no label rank`);
    assert.equal(f.labelRank, f.operationalPriority, 'rank and priority must not drift apart');
    assert.equal(typeof f.poiScale, 'number');
    // A campus marker must never outgrow the robot beside it: the robot is the
    // object the operator is reading (§3E).
    assert.ok(f.poiScale >= 1 && f.poiScale <= 1.5, `${f.id}: poiScale ${f.poiScale} is out of bounds`);
  }

  const gate = FEATURES.find((f) => f.kind === CAMPUS_FEATURE_KIND.GATE);
  const scenery = FEATURES.find((f) => f.operationalRole === OPERATIONAL_ROLE.NONE);
  assert.ok(gate.poiScale > scenery.poiScale, 'a gate must read larger than scenery');
  assert.ok(gate.labelRank < scenery.labelRank, 'a gate must win a label collision against scenery');
});

test('isOperationalRole says no to the absence of a role', () => {
  assert.equal(isOperationalRole(OPERATIONAL_ROLE.NONE), false);
  assert.equal(isOperationalRole(undefined), false);
  assert.equal(isOperationalRole(OPERATIONAL_ROLE.GATE), true);
});

// ── §3N — "where is this unit?" in campus terms ─────────────────────────────

test('the nearest campus feature is a measurement, and it names nothing anonymous', () => {
  const def = resolveCampusDefinition(RNSIT_RECORD);
  const near = nearestNamedFeature(def.features, [77.5186, 12.9023], labelAnchorFor);

  assert.ok(near, 'a point inside the campus must have a nearest named feature');
  assert.equal(typeof near.metres, 'number');
  assert.ok(near.metres >= 0 && near.metres < 2000);
  assert.ok(near.name && !/^Unnamed/.test(near.name), 'an anonymous footprint orients nobody');

  // A point in the Bay of Bengal still resolves — with a distance that makes
  // the answer obviously useless, which is exactly why the distance is never
  // omitted from the panel.
  const faraway = nearestNamedFeature(def.features, [85, 15], labelAnchorFor);
  assert.ok(faraway.metres > 100000);

  assert.equal(nearestNamedFeature(def.features, null, labelAnchorFor), null);
  assert.equal(nearestNamedFeature(null, [77.5, 12.9], labelAnchorFor), null);
});
