/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CAMPUS DATA — the contract that keeps invented geometry off the map
 *
 *   node --test src/features/maps/__architecture__/
 *   (or: npm run test:arch, from Frontend/)
 *
 * The single most damaging thing this milestone could have shipped is a
 * beautiful campus that is in the wrong place. These tests pin the rules that
 * make that structurally difficult rather than merely discouraged:
 *
 *   • a feature with no provenance cannot be rendered
 *   • a feature claiming VERIFIED without a date cannot be rendered
 *   • malformed geometry is rejected, not best-efforted
 *   • absent geometry is reported as absent, by name
 *
 * Runs under plain Node — no DOM, no WebGL, no bundler.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CAMPUS_CATEGORY,
  CAMPUS_FEATURE_KIND,
  CAMPUS_GEOMETRY_CAPABILITIES,
  LABEL_PRIORITY,
  PROVENANCE,
  ROAD_CLASS,
  VERIFICATION,
  describeCampusCoverage,
  geometryErrors,
  validateCampusDefinition,
  validateCampusFeature,
} from '../campus/campusSchema.js';
import {
  CAMPUS_GEOMETRY,
  EMPTY_CAMPUS_DEFINITION,
  MISSING_GEOMETRY_REQUEST,
  resolveCampusDefinition,
} from '../campus/campusRegistry.js';

/** A well-formed building, used as the baseline the negative cases mutate. */
const GOOD_BUILDING = Object.freeze({
  id: 'blk-a',
  name: 'Block A',
  shortName: 'A',
  kind: CAMPUS_FEATURE_KIND.BUILDING,
  category: CAMPUS_CATEGORY.ACADEMIC,
  labelPriority: LABEL_PRIORITY.SECONDARY,
  height: 18,
  geometry: {
    type: 'Polygon',
    coordinates: [[[77.5, 12.9], [77.501, 12.9], [77.501, 12.901], [77.5, 12.901], [77.5, 12.9]]],
  },
  provenance: PROVENANCE.SURVEYED,
  verification: VERIFICATION.VERIFIED,
  verifiedOn: '2026-08-23',
  source: 'Site plan, sheet 3',
});

const RNSIT_RECORD = Object.freeze({
  code: 'RNSIT',
  name: 'RNS Institute of Technology',
  centerLat: 12.9023,
  centerLon: 77.5186,
});

// ── The provenance rule ─────────────────────────────────────────────────────

test('a feature without provenance cannot be rendered', () => {
  const { provenance, ...noProvenance } = GOOD_BUILDING;
  assert.ok(provenance, 'sanity: the baseline has one');
  const errs = validateCampusFeature(noProvenance);
  assert.ok(errs.some((e) => /provenance is required/.test(e)));
});

test('a feature without a named source cannot be rendered', () => {
  const errs = validateCampusFeature({ ...GOOD_BUILDING, source: '   ' });
  assert.ok(errs.some((e) => /source is required/.test(e)));
});

test('claiming VERIFIED without saying when it was checked is rejected', () => {
  // This is the specific dishonesty the contract exists to block: a feature
  // that asserts it was checked, with nothing behind the assertion.
  const errs = validateCampusFeature({ ...GOOD_BUILDING, verifiedOn: null });
  assert.ok(errs.some((e) => /VERIFIED requires verifiedOn/.test(e)));

  // NOT_VERIFIED needs no date — it is claiming nothing.
  assert.deepEqual(
    validateCampusFeature({ ...GOOD_BUILDING, verification: VERIFICATION.NOT_VERIFIED, verifiedOn: null }),
    []
  );
});

test('a well-formed, fully-attributed feature passes', () => {
  assert.deepEqual(validateCampusFeature(GOOD_BUILDING), []);
});

// ── Geometry validation ─────────────────────────────────────────────────────

test('invalid geometry is rejected rather than best-efforted', () => {
  assert.ok(geometryErrors({ type: 'Point', coordinates: [200, 12] }).length, 'longitude out of range');
  assert.ok(geometryErrors({ type: 'Point', coordinates: [77, 95] }).length, 'latitude out of range');
  assert.ok(geometryErrors({ type: 'Point', coordinates: [77, NaN] }).length, 'NaN is not a coordinate');
  assert.ok(geometryErrors({ type: 'LineString', coordinates: [[77, 12]] }).length, 'a line needs 2 positions');
  assert.ok(geometryErrors({ type: 'Circle', coordinates: [] }).length, 'unsupported type');

  // An unclosed ring is the classic hand-authored polygon bug, and it renders
  // as a visibly wrong footprint rather than as an error.
  const unclosed = { type: 'Polygon', coordinates: [[[77.5, 12.9], [77.501, 12.9], [77.501, 12.901], [77.5, 12.9001]]] };
  assert.ok(geometryErrors(unclosed).some((e) => /not closed/.test(e)));

  assert.deepEqual(geometryErrors(GOOD_BUILDING.geometry), []);
});

test('a kind may only carry the geometry that kind can be', () => {
  // A building that is a point is not a footprint, and extruding it would
  // silently produce nothing while looking configured.
  const errs = validateCampusFeature({ ...GOOD_BUILDING, geometry: { type: 'Point', coordinates: [77.5, 12.9] } });
  assert.ok(errs.some((e) => /requires geometry of Polygon \| MultiPolygon/.test(e)));

  const road = {
    ...GOOD_BUILDING,
    id: 'rd-1',
    kind: CAMPUS_FEATURE_KIND.ROAD,
    roadClass: ROAD_CLASS.MAIN,
    height: undefined,
    geometry: { type: 'LineString', coordinates: [[77.5, 12.9], [77.502, 12.902]] },
  };
  assert.deepEqual(validateCampusFeature(road), []);
});

test('an invalid feature is excluded from the rendered set, not repaired', () => {
  const result = validateCampusDefinition({
    code: 'TEST',
    name: 'Test campus',
    center: { lon: 77.5, lat: 12.9 },
    features: [GOOD_BUILDING, { ...GOOD_BUILDING, id: 'broken', provenance: undefined }],
  });

  assert.equal(result.ok, false);
  assert.equal(result.features.length, 1, 'only the valid feature survives');
  assert.equal(result.features[0].id, 'blk-a');
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].id, 'broken');
});

test('duplicate feature ids are rejected — one id, one place', () => {
  const result = validateCampusDefinition({
    code: 'TEST',
    name: 'Test campus',
    features: [GOOD_BUILDING, { ...GOOD_BUILDING }],
  });
  assert.ok(result.errors.some((e) => /duplicate feature id/.test(e)));
  assert.equal(result.features.length, 1);
});

// ── Missing geometry is explicit ────────────────────────────────────────────

test('absent capabilities are reported by name, not silently omitted', () => {
  const { present, missing } = describeCampusCoverage({ features: [GOOD_BUILDING] });
  assert.deepEqual(present.map((p) => p.id), ['buildings']);
  assert.equal(present[0].count, 1);
  assert.equal(present[0].verified, 1);

  const missingIds = missing.map((m) => m.id);
  for (const cap of CAMPUS_GEOMETRY_CAPABILITIES) {
    if (cap.id === 'buildings') continue;
    assert.ok(missingIds.includes(cap.id), `${cap.id} must be reported missing`);
  }
});

// ── RNSIT, as the repository actually holds it ──────────────────────────────

test('every RNSIT feature declares a real provenance and NOT_VERIFIED', () => {
  // RNSIT's geometry comes from two sources now — an OpenStreetMap extract and
  // a set of user-supplied point locations. What must NOT change is the honesty
  // of either. Real data arriving does not make it a survey, and this is where
  // a future edit that quietly upgrades the claim gets caught.
  assert.ok(CAMPUS_GEOMETRY.RNSIT.features.length > 0, 'the imports must supply geometry');

  const allowed = new Set([PROVENANCE.OPEN_DATA_IMPORT, PROVENANCE.USER_SUPPLIED]);
  let osm = 0;
  let supplied = 0;

  for (const f of CAMPUS_GEOMETRY.RNSIT.features) {
    assert.ok(allowed.has(f.provenance), `${f.id}: unexpected provenance ${f.provenance}`);
    // The rule that matters, and it is the same for both sources.
    assert.equal(f.verification, VERIFICATION.NOT_VERIFIED, `${f.id}: nothing here has been verified`);
    assert.equal(f.verifiedOn, null);

    // The original record travels with the feature, so a later verification
    // pass can see what the import was working from (§34).
    assert.equal(typeof f.sourceTags, 'object');

    if (f.provenance === PROVENANCE.OPEN_DATA_IMPORT) {
      osm += 1;
      assert.match(f.source, /OpenStreetMap/, `${f.id}: the source must name the dataset`);
      assert.match(f.source, /way\/|node\/|relation\//, `${f.id}: the source must name the OSM element`);
      assert.ok(f.sourceTags['@id'], `${f.id}: the raw OSM tags must be preserved`);
    } else {
      supplied += 1;
      assert.match(f.source, /User-supplied/i, `${f.id}: the source must say it was supplied by a person`);
      assert.match(f.source, /not surveyed/i, `${f.id}: the source must refuse the survey claim outright`);
      assert.equal(f.sourceTags.source, 'USER_SUPPLIED_LOCATION');
      assert.equal(f.sourceTags.verificationStatus, 'UNVERIFIED');
    }
  }

  assert.ok(osm > 0 && supplied > 0, 'both sources must actually be present');
});

test('no RNSIT feature claims a measured height, because the dataset has none', () => {
  // The extract carries `building:levels` on seven buildings and no `height`
  // tag anywhere. A drawn extrusion is not a measurement, and this is the
  // assertion that keeps those two apart (§8, §38).
  for (const f of CAMPUS_GEOMETRY.RNSIT.features) {
    assert.equal(
      f.height,
      undefined,
      `${f.id}: no feature in this dataset has a measured height — if one appears, it came from somewhere`
    );
    if (f.kind === CAMPUS_FEATURE_KIND.BUILDING) {
      assert.equal(typeof f.renderHeight, 'number', `${f.id}: a building must have something to draw`);
      assert.ok(f.renderHeight > 0 && f.renderHeight <= 30, `${f.id}: ${f.renderHeight} m is not campus-scale`);
      assert.ok(f.heightBasis, `${f.id}: a drawn height must say what it was derived from`);
    }
  }
});

test('the RNSIT definition carries the campus centre, from the DB record, unverified', () => {
  const def = resolveCampusDefinition(RNSIT_RECORD);

  assert.equal(def.ok, true, def.errors.join('; '));
  assert.equal(def.code, 'RNSIT');
  assert.deepEqual(def.center, { lon: 77.5186, lat: 12.9023 });

  const centre = def.features.find((f) => f.kind === CAMPUS_FEATURE_KIND.CAMPUS_CENTER);
  assert.ok(centre, 'the seeded centre must still be a feature in its own right');
  assert.deepEqual(centre.geometry.coordinates, [77.5186, 12.9023]);

  // Provenance is real (a database record) AND verification is honest (nobody
  // in this repository has checked that coordinate against the physical site).
  // It stays SEED_RECORD rather than being absorbed into the OSM import — two
  // different sources agreeing is worth more than one source restated.
  assert.equal(centre.provenance, PROVENANCE.SEED_RECORD);
  assert.equal(centre.verification, VERIFICATION.NOT_VERIFIED);
  assert.equal(def.verifiedCount, 0, 'nothing on this map is verified');
  assert.match(centre.source, /Campus\.centerLat/);
});

test('the database centre and the imported boundary agree about where RNSIT is (§22, §49)', () => {
  // The regression this exists to catch is the quiet one: geometry that loads,
  // validates and renders 10–20 m from where the robots are. The seeded centre
  // and the OSM boundary come from completely independent sources, so the
  // centre falling inside the boundary is a real cross-check on both.
  const def = resolveCampusDefinition(RNSIT_RECORD);
  assert.equal(
    def.centreWithinBoundary,
    true,
    'the seeded campus centre must fall inside the imported campus boundary — if it does not, ' +
      'one of the two is wrong and the fix is to find out which, never to move the geometry'
  );
});

test('the campus centre is read from the record, never hard-coded in the map', () => {
  // Move the record; the map must move with it. A registry with a baked-in
  // coordinate would quietly disagree with the database.
  const moved = resolveCampusDefinition({ ...RNSIT_RECORD, centerLat: 13.1, centerLon: 77.7 });
  assert.deepEqual(moved.center, { lon: 77.7, lat: 13.1 });
  assert.deepEqual(moved.features[0].geometry.coordinates, [77.7, 13.1]);
});

test('RNSIT now covers every campus geometry capability, across two sources', () => {
  const def = resolveCampusDefinition(RNSIT_RECORD);

  // Gates were the one gap the OSM extract left: it contains no barrier=gate,
  // no entrance=* and no access-control node anywhere on the site. The
  // supplemental dataset supplies one, so coverage is complete — and it is
  // complete because a person said where the gate is, which is exactly why the
  // verification status below still matters.
  const present = def.coverage.present.map((m) => m.id).sort();
  assert.deepEqual(present, ['boundary', 'buildings', 'facilities', 'gates', 'landmarks', 'paths', 'roads']);
  assert.deepEqual(def.missingGeometry, []);

  const gates = def.features.filter((f) => f.kind === 'GATE');
  assert.equal(gates.length, 1);
  assert.equal(gates[0].provenance, PROVENANCE.USER_SUPPLIED);
  assert.equal(gates[0].verification, VERIFICATION.NOT_VERIFIED);

  // Full coverage must not read as full confidence.
  assert.equal(def.verifiedCount, 0, 'covering every capability verifies nothing');
  assert.equal(def.hasCampusGeometry, true);
  assert.match(def.geometrySource, /OpenStreetMap/);
  assert.match(def.notes, /NOT a survey/);
  assert.match(def.notes, /NOT_VERIFIED/);
  assert.match(def.notes, /least verified/, 'the notes must rank the supplemental data honestly');
});

test('a campus with no registered geometry yields a definition with nothing to draw', () => {
  const def = resolveCampusDefinition({ code: 'X', name: 'X campus' });
  assert.equal(def.features.length, 0);
  assert.equal(def.center, null);
  assert.equal(def.hasCampusGeometry, false);
  assert.equal(def.geometrySource, null);
  // Still a valid definition — "we know nothing about this campus" is a state
  // the renderer must handle, not an error to throw at an operator. RNSIT
  // gaining geometry must not turn every other campus into a broken one.
  assert.equal(def.ok, true);
});

test('the empty definition is a usable value, so consumers never branch on null', () => {
  assert.equal(EMPTY_CAMPUS_DEFINITION.ok, true);
  assert.deepEqual(EMPTY_CAMPUS_DEFINITION.features, []);
  assert.equal(EMPTY_CAMPUS_DEFINITION.center, null);
});

test('the data the map is still waiting on is stated, in the form it must arrive in', () => {
  assert.match(MISSING_GEOMETRY_REQUEST.format, /WGS84/);
  assert.ok(MISSING_GEOMETRY_REQUEST.artefacts.length >= 3);

  // The request must name what the OSM import DID supply, or the gap list reads
  // as if the map still has nothing.
  assert.match(MISSING_GEOMETRY_REQUEST.suppliedBy.origin, /OpenStreetMap/);
  assert.match(MISSING_GEOMETRY_REQUEST.suppliedBy.verification, /NOT_VERIFIED/);

  assert.ok(
    MISSING_GEOMETRY_REQUEST.artefacts.some((s) => /gate/i.test(s)),
    'gates are the capability the import did not supply and must stay requested'
  );
  assert.ok(
    MISSING_GEOMETRY_REQUEST.notAcceptable.some((s) => /satellite image by eye/i.test(s)),
    'eyeballed coordinates must be explicitly out of bounds'
  );
  assert.ok(
    MISSING_GEOMETRY_REQUEST.notAcceptable.some((s) => /extrusion height reported/i.test(s)),
    'a drawn height passed off as a measurement is the new failure mode this import creates'
  );
});
