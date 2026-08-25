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
  missingGeometryRequestFor,
  resolveCampusDefinition,
} from '../campus/campusRegistry.js';

/**
 * The outstanding-data request is now derived PER CAMPUS from that campus's own
 * import, rather than being one module constant describing RNSIT. Same
 * assertions, addressed to the campus they were always about.
 */
const MISSING_GEOMETRY_REQUEST = missingGeometryRequestFor('RNSIT');
import {
  VERIFICATION_METHOD,
  applyCampusVerification,
  campusVerificationFor,
} from '../campus/verification/campusVerification.js';

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

test('every RNSIT feature keeps its original provenance AND records who verified it', () => {
  // RNSIT's geometry comes from two sources — an OpenStreetMap extract and a
  // set of user-supplied point locations — and the project owner has since
  // confirmed those features against the site (§3A).
  //
  // The property this test defends is that VERIFYING SOMETHING DID NOT ERASE
  // WHERE IT CAME FROM. Those are two independent facts and the failure mode is
  // an edit that treats them as one: a feature that says "verified" and has
  // forgotten it is an OSM import can never be re-derived, re-licensed or
  // re-checked against its source. Provenance below is asserted exactly as it
  // was before the verification existed.
  assert.ok(CAMPUS_GEOMETRY.RNSIT.features.length > 0, 'the imports must supply geometry');

  const allowed = new Set([PROVENANCE.OPEN_DATA_IMPORT, PROVENANCE.USER_SUPPLIED]);
  let osm = 0;
  let supplied = 0;

  for (const f of CAMPUS_GEOMETRY.RNSIT.features) {
    assert.ok(allowed.has(f.provenance), `${f.id}: unexpected provenance ${f.provenance}`);
    // Checked by the owner — and NOT promoted to VERIFIED, which is reserved
    // for a survey. No such source exists for this campus.
    assert.equal(f.verification, VERIFICATION.VERIFIED_BY_USER, `${f.id}: the owner's check must be recorded`);
    assert.notEqual(f.verification, VERIFICATION.VERIFIED, `${f.id}: an owner check is not a survey`);
    assert.equal(f.verifiedOn, '2026-08-23', `${f.id}: a check with no date is not a check`);
    assert.ok(f.verifiedBy, `${f.id}: a check with no named checker is not a check`);

    // The original record travels with the feature, so the verification can be
    // re-examined against what the import was actually working from (§34).
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
      // The RAW FILE still says UNVERIFIED, and must. The owner's check is a
      // separate, dated record applied downstream — it did not go back and edit
      // the dataset on disk (§3P: do not modify raw source files).
      assert.equal(f.sourceTags.verificationStatus, 'UNVERIFIED');
    }
  }

  assert.ok(osm > 0 && supplied > 0, 'both sources must actually be present');
});

test('the verification is one dated, attributed record — not a flag sprinkled per feature', () => {
  // If "verified" is ever set feature-by-feature, it stops being auditable: no
  // single place says who checked what, and a half-applied edit is invisible.
  // One record, applied by one function, at one merge point.
  const record = campusVerificationFor('RNSIT');
  assert.ok(record, 'RNSIT must carry a verification record');
  assert.equal(record.verifiedBy, 'Project owner');
  assert.match(record.verifiedOn, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(record.method, VERIFICATION_METHOD.OWNER_SITE_CHECK);
  assert.notEqual(record.method, VERIFICATION_METHOD.SURVEY);

  // And the record states the LIMITS of the claim, in as many words. A
  // verification that does not say what it does not cover is the one that gets
  // read as covering everything.
  assert.ok(record.doesNotCover.length >= 3);
  assert.ok(record.doesNotCover.some((s) => /height/i.test(s)), 'drawn heights are still not measured');
  assert.ok(record.doesNotCover.some((s) => /access/i.test(s)), 'gate access is still unknown');
  assert.ok(record.doesNotCover.some((s) => /centre/i.test(s)), 'the seeded DB centre is outside the claim');
  assert.match(record.statement, /not a georeferenced survey/i);
});

test('applying the verification does not touch geometry, provenance or the source record', () => {
  // The transform runs across every campus feature. If it ever copied a
  // coordinate — rounded it, reprojected it, rebuilt the array — the campus
  // would move by a metre nobody could account for. Identity, not equality.
  const before = [
    {
      id: 'x',
      name: 'X',
      kind: CAMPUS_FEATURE_KIND.BUILDING,
      geometry: { type: 'Polygon', coordinates: [[[0, 0], [0, 1], [1, 1], [0, 0]]] },
      provenance: PROVENANCE.OPEN_DATA_IMPORT,
      verification: VERIFICATION.NOT_VERIFIED,
      verifiedOn: null,
      source: 'source string',
      sourceId: 'way/1',
      sourceTags: { '@id': 'way/1' },
    },
  ];
  const record = campusVerificationFor('RNSIT');
  const { features, verified } = applyCampusVerification(before, record);

  assert.equal(verified, 1);
  assert.equal(features[0].geometry, before[0].geometry, 'geometry must be the SAME object');
  assert.equal(features[0].provenance, PROVENANCE.OPEN_DATA_IMPORT);
  assert.equal(features[0].source, 'source string');
  assert.equal(features[0].sourceTags, before[0].sourceTags, 'the source tags must be the SAME object');
  assert.equal(features[0].verification, VERIFICATION.VERIFIED_BY_USER);

  // And the input is untouched, so re-running the import produces what it
  // produced before this record existed.
  assert.equal(before[0].verification, VERIFICATION.NOT_VERIFIED);
});

test('the verification refuses to reach past what it covers', () => {
  // A record covering OSM and user-supplied data must not verify a database
  // seed row, a vendor basemap feature, or anything else that appears later.
  const record = campusVerificationFor('RNSIT');
  const outOfScope = [
    { id: 'a', provenance: PROVENANCE.SEED_RECORD, verification: VERIFICATION.NOT_VERIFIED },
    { id: 'b', provenance: PROVENANCE.VENDOR_BASEMAP, verification: VERIFICATION.NOT_VERIFIED },
    { id: 'c', provenance: PROVENANCE.OPERATIONAL_RECORD, verification: VERIFICATION.NOT_VERIFIED },
  ];
  const { features, verified, skipped } = applyCampusVerification(outOfScope, record);
  assert.equal(verified, 0);
  assert.equal(skipped, 3);
  for (const f of features) assert.equal(f.verification, VERIFICATION.NOT_VERIFIED);

  // No record at all verifies nothing, rather than defaulting to something.
  const none = applyCampusVerification(outOfScope, null);
  assert.equal(none.verified, 0);
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

  // Provenance is real (a database record) AND verification is honest. The
  // owner's check covers the CAMPUS FEATURES — the imported geometry and the
  // supplied locations. It does not cover a seed row in this repository's own
  // database, which nobody walked to, and the verification record says so by
  // name. This is the one feature on the map that is still unverified, and it
  // is the assertion that keeps a blanket "verify everything" edit honest.
  assert.equal(centre.provenance, PROVENANCE.SEED_RECORD);
  assert.equal(centre.verification, VERIFICATION.NOT_VERIFIED);
  assert.match(centre.source, /Campus\.centerLat/);

  // Everything except the centre is owner-verified.
  assert.equal(def.ownerVerifiedCount, def.features.length - 1);
  assert.equal(def.verifiedCount, def.ownerVerifiedCount);
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
  // supplemental dataset supplies one, so GEOMETRY coverage is complete.
  const present = def.coverage.present.map((m) => m.id).sort();
  assert.deepEqual(present, ['boundary', 'buildings', 'facilities', 'gates', 'landmarks', 'paths', 'roads']);
  assert.deepEqual(def.missingGeometry, []);

  const gates = def.features.filter((f) => f.kind === 'GATE');
  assert.equal(gates.length, 1);
  assert.equal(gates[0].provenance, PROVENANCE.USER_SUPPLIED);
  assert.equal(gates[0].verification, VERIFICATION.VERIFIED_BY_USER);

  // Covering every capability, and confirming every feature, still leaves real
  // gaps — and the notes have to keep naming them, or "complete coverage" reads
  // as "complete information". The three that remain are a measured height, a
  // footprint for a point location, and a gate's access rules.
  assert.equal(def.hasCampusGeometry, true);
  assert.match(def.geometrySource, /OpenStreetMap/);
  assert.match(def.notes, /not a georeferenced survey/i);
  assert.match(def.notes, /MEASURED height/);
  assert.match(def.notes, /point locations/i);
  assert.match(def.notes, /UNKNOWN/, 'gate access must stay named as unknown');
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
  assert.match(MISSING_GEOMETRY_REQUEST.suppliedBy.verification, /VERIFIED_BY_USER/);
  assert.match(
    MISSING_GEOMETRY_REQUEST.suppliedBy.verification,
    /not a georeferenced survey/i,
    'the owner check must not be allowed to read as a survey'
  );

  // The gate LOCATION is supplied and confirmed; its ACCESS RULES are not, and
  // that is now the outstanding record with real operational consequences.
  assert.ok(
    MISSING_GEOMETRY_REQUEST.artefacts.some((s) => /gate access/i.test(s)),
    'gate access rules are unknown and must stay requested'
  );
  assert.ok(
    MISSING_GEOMETRY_REQUEST.artefacts.some((s) => /charging|docking/i.test(s)),
    'charging and docking locations are declared roles with no data and must stay requested'
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
