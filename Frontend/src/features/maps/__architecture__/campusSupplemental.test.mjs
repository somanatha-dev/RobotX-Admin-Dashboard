/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SUPPLEMENTAL CAMPUS LOCATIONS — the second source, pinned
 *
 *   node --test src/features/maps/__architecture__/
 *   (or: npm run test:arch, from Frontend/)
 *
 * A second dataset introduces failure modes the first one could not have:
 *
 *   1. A POINT BECOMING A BUILDING. A coordinate says where something is. The
 *      moment a footprint, an extent or a height is derived from one, the map
 *      is asserting a shape nobody supplied.
 *   2. TWO RECORDS BECOMING TWO PLACES. The same bank mapped by OSM and by a
 *      person is one bank. Drawing it twice invents a building.
 *   3. TWO PLACES BECOMING ONE. The inverse, and worse: merging a food court
 *      into a canteen because they happen to be 41 m apart deletes a real
 *      location from an operations map.
 *   4. USER-SUPPLIED QUIETLY BECOMING VERIFIED. It is the weakest provenance
 *      here and must stay labelled as such.
 *
 * Runs under plain Node — no DOM, no WebGL, no bundler, no Mapbox.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  CAMPUS_CATEGORY,
  CAMPUS_FEATURE_KIND,
  GEOMETRY_ROLE,
  LABEL_PRIORITY,
  PROVENANCE,
  VERIFICATION,
  validateCampusFeature,
} from '../campus/campusSchema.js';
import { RNSIT_CAMPUS_OSM } from '../campus/data/rnsit/rnsitCampusOsm.js';
import { RNSIT_CAMPUS_SUPPLEMENTAL } from '../campus/data/rnsit/rnsitCampusSupplemental.js';
import { importOsmCampus, osmDataset } from '../campus/osm/osmCampusImport.js';
import {
  BOUNDARY_UNCERTAINTY_M,
  CONTAINMENT,
  MERGE_RADIUS_M,
  classifyContainment,
  describeSupplementalImport,
  importSupplementalCampus,
  kindRuleFor,
  metresToPolygonEdge,
  supplementalDataset,
} from '../campus/supplemental/supplementalCampusImport.js';
import {
  CAMPUS_SOURCE,
  campusCollections,
  isLabelled,
  rendersOwnMarker,
} from '../campus/campusLayers.js';
import { resolveCampusDefinition, campusSupplementalInfo } from '../campus/campusRegistry.js';
import { buildCampusSearchIndex, searchCampusIndex } from '../campus/campusSearch.js';

const RNSIT_RECORD = Object.freeze({
  code: 'RNSIT',
  name: 'RNS Institute of Technology',
  centerLat: 12.9023,
  centerLon: 77.5186,
});

// The dataset descriptors the registry supplies for RNSIT. Both importers are
// campus-agnostic — they are told WHICH artefact they are reading rather than
// knowing one campus's filename — so a direct call has to say so too.
const OSM_DS = osmDataset('rnsit-campus-osm.geojson');
const SUP_DS = supplementalDataset(
  'rnsit-campus-supplemental.geojson',
  'RNSIT',
  'RNS Institute of Technology'
);

const OSM = importOsmCampus(RNSIT_CAMPUS_OSM, { dataset: OSM_DS });
const SUP = importSupplementalCampus(RNSIT_CAMPUS_SUPPLEMENTAL, {
  osmFeatures: OSM.features,
  boundary: OSM.boundary,
  dataset: SUP_DS,
});
const BY_ID = new Map(SUP.features.map((f) => [f.id, f]));
const sourceById = (id) => RNSIT_CAMPUS_SUPPLEMENTAL.features.find((f) => f.properties.id === id);

/** The 11 names the brief lists, verbatim. */
const SUPPLIED_NAMES = Object.freeze([
  'RNSIT Main Gate Entrance',
  'RNSIT Food Court',
  'RNSIT Playground 2',
  'RNSIT Playground 1',
  'RNSIT Parking Lot',
  'RNSIT Pre-University College',
  'Innovation Center',
  'CANARA BANK',
  'RNS FIRST GRADE COLLEGE',
  'RNS Evening College',
  'RNSIT Cyber Security Department',
]);

// ── The source artefact (§24.1, §24.2) ──────────────────────────────────────

test('the .js module is the supplied .geojson, not an edited copy of it', () => {
  const p = fileURLToPath(new URL('../campus/data/rnsit/rnsit-campus-supplemental.geojson', import.meta.url));
  assert.deepEqual(
    RNSIT_CAMPUS_SUPPLEMENTAL,
    JSON.parse(readFileSync(p, 'utf8')),
    'regenerate the module from the .geojson; never hand-edit it'
  );
});

test('all 11 supplied locations parse, and the dataset declares its own trust level', () => {
  assert.equal(RNSIT_CAMPUS_SUPPLEMENTAL.features.length, 11);
  assert.equal(RNSIT_CAMPUS_SUPPLEMENTAL.metadata.source, 'USER_SUPPLIED_LOCATION');
  assert.equal(RNSIT_CAMPUS_SUPPLEMENTAL.metadata.verificationStatus, 'UNVERIFIED');
  assert.equal(SUP.excluded.length, 0, 'nothing supplied was dropped');
});

// ── Names and coordinates are untouched (§24.3, §24.4) ─────────────────────

test('every supplied name is preserved exactly — no tidying, no renaming', () => {
  // Including the ones that are shouted. "CANARA BANK" is how the user wrote
  // it, and a map that quietly title-cases its inputs is a map that edits them.
  const imported = SUP.features.map((f) => f.name);
  const merged = SUP.merges.map((m) => m.name);
  assert.deepEqual([...imported, ...merged].sort(), [...SUPPLIED_NAMES].sort());
});

test('every coordinate is the supplied coordinate, unchanged', () => {
  for (const f of SUP.features) {
    const src = sourceById(f.sourceId);
    assert.ok(src, `${f.sourceId} must come from the supplied collection`);
    assert.deepEqual(f.geometry, src.geometry, `${f.sourceId}: coordinate was modified on the way in`);
    assert.equal(f.geometry, src.geometry, `${f.sourceId}: geometry must pass through by reference`);
  }
});

test('the supplied points are where RNSIT is, in lon/lat order', () => {
  for (const f of RNSIT_CAMPUS_SUPPLEMENTAL.features) {
    const [lon, lat] = f.geometry.coordinates;
    assert.ok(lon > 77.51 && lon < 77.53, `${f.properties.id}: longitude ${lon} — lon/lat may be swapped`);
    assert.ok(lat > 12.89 && lat < 12.91, `${f.properties.id}: latitude ${lat} — lon/lat may be swapped`);
  }
});

// ── Provenance (§24.5, §24.6) ──────────────────────────────────────────────

test('every supplemental feature is USER_SUPPLIED and stays UNVERIFIED', () => {
  for (const f of SUP.features) {
    assert.equal(f.provenance, PROVENANCE.USER_SUPPLIED);
    assert.equal(f.verification, VERIFICATION.NOT_VERIFIED);
    assert.equal(f.verifiedOn, null);
    assert.match(f.source, /not surveyed, not official RNSIT data, not verified/i);
    // The supplied record travels intact so a later verification can see it.
    assert.equal(f.sourceTags.source, 'USER_SUPPLIED_LOCATION');
    assert.equal(f.sourceTags.verificationStatus, 'UNVERIFIED');
  }
});

test('the contract refuses a VERIFIED claim with nothing behind it', () => {
  const f = BY_ID.get('rnsit-main-gate');
  const errs = validateCampusFeature({ ...f, verification: VERIFICATION.VERIFIED, verifiedOn: null });
  assert.ok(errs.some((e) => /VERIFIED requires verifiedOn/.test(e)));
});

test('every supplemental feature passes the campus contract unchanged', () => {
  for (const f of SUP.features) {
    assert.deepEqual(validateCampusFeature(f, f.id), []);
  }
});

// ── A point is a location, not a building (§24.7) ──────────────────────────

test('no footprint, extent or height is derived from a coordinate', () => {
  for (const f of SUP.features) {
    assert.equal(f.geometry.type, 'Point', `${f.id}: still a point`);
    assert.equal(f.geometryRole, GEOMETRY_ROLE.POINT_LOCATION);
    assert.equal(f.renderHeight, undefined, `${f.id}: a location has nothing to extrude`);
    assert.equal(f.height, undefined, `${f.id}: no height was supplied`);
    assert.equal(f.levels, undefined);
    assert.match(f.metadata['Geometry known'], /Point location only/);
  }
});

test('the schema itself blocks a point from ever gaining a drawn height', () => {
  // Not merely "the importer does not set one" — the contract refuses it, so a
  // later edit anywhere cannot quietly extrude a location into a building.
  const f = BY_ID.get('rnsit-innovation-center');
  const errs = validateCampusFeature({ ...f, renderHeight: 9, heightBasis: 'FALLBACK' });
  assert.ok(errs.some((e) => /POINT_LOCATION has no footprint to extrude/.test(e)));
});

test('a geometryRole that disagrees with its geometry is rejected', () => {
  const f = BY_ID.get('rnsit-innovation-center');
  assert.ok(
    validateCampusFeature({ ...f, geometryRole: GEOMETRY_ROLE.FOOTPRINT }).some((e) =>
      /geometryRole FOOTPRINT requires Polygon/.test(e)
    )
  );
});

test('a point location is never routed to a polygon layer', () => {
  const c = campusCollections(resolveCampusDefinition(RNSIT_RECORD));
  const areaIds = new Set(c[CAMPUS_SOURCE.AREAS].features.map((f) => f.id));
  for (const f of SUP.features) {
    assert.equal(areaIds.has(f.id), false, `${f.id} must never reach the extrusion or ground layers`);
  }
});

// ── Classification (§24.12 – §24.16) ───────────────────────────────────────

test('the supplied kind words map onto the campus contract, and are preserved', () => {
  const expect = (id, kind, category, sourceKind) => {
    const f = BY_ID.get(id);
    assert.ok(f, `${id} must be imported`);
    assert.equal(f.kind, kind, `${id}: kind`);
    assert.equal(f.category, category, `${id}: category`);
    assert.equal(f.sourceKind, sourceKind, `${id}: the supplied word must survive verbatim`);
  };

  // GATE is a kind in its own right. SPORTS, PARKING and DEPARTMENT are the
  // user's vocabulary; in this model they are CATEGORIES of a facility, and the
  // supplied word is kept on the feature so nothing they wrote is lost.
  expect('rnsit-main-gate', CAMPUS_FEATURE_KIND.GATE, CAMPUS_CATEGORY.ACCESS, 'GATE');
  expect('rnsit-parking-lot', CAMPUS_FEATURE_KIND.FACILITY, CAMPUS_CATEGORY.OPERATIONAL, 'PARKING');
  expect('rnsit-playground-1', CAMPUS_FEATURE_KIND.FACILITY, CAMPUS_CATEGORY.SPORTS, 'SPORTS');
  expect('rnsit-playground-2', CAMPUS_FEATURE_KIND.FACILITY, CAMPUS_CATEGORY.SPORTS, 'SPORTS');
  expect('rnsit-cyber-security-department', CAMPUS_FEATURE_KIND.FACILITY, CAMPUS_CATEGORY.ACADEMIC, 'DEPARTMENT');
  expect('rnsit-food-court', CAMPUS_FEATURE_KIND.FACILITY, CAMPUS_CATEGORY.COMMERCIAL, 'FACILITY');
  expect('rnsit-pre-university-college', CAMPUS_FEATURE_KIND.FACILITY, CAMPUS_CATEGORY.ACADEMIC, 'FACILITY');
});

test('a plain FACILITY with no recognisable name stays UNCLASSIFIED', () => {
  // "Innovation Center" matches no category rule, and the honest result is that
  // the map does not know what kind of place it is. Guessing would be worse.
  const f = BY_ID.get('rnsit-innovation-center');
  assert.equal(f.category, CAMPUS_CATEGORY.UNCLASSIFIED);
  assert.match(f.metadata['Classified from'], /supplied kind "FACILITY"/);
});

test('a category derived from the name says so', () => {
  const f = BY_ID.get('rnsit-pre-university-college');
  assert.match(f.metadata['Classified from'], /supplied name/);
});

test('an unknown kind is excluded with a reason, never guessed into a default', () => {
  const r = importSupplementalCampus(
    {
      features: [
        {
          type: 'Feature',
          properties: { id: 'x', name: 'Mystery', kind: 'TELEPORTER' },
          geometry: { type: 'Point', coordinates: [77.518, 12.901] },
        },
      ],
    },
    { osmFeatures: [], boundary: OSM.boundary }
  );
  assert.equal(r.features.length, 0);
  assert.equal(r.excluded[0].reason, 'UNKNOWN_KIND');
  assert.match(r.excluded[0].detail, /add one rather than guessing/);
});

test('a polygon in this dataset is refused rather than silently accepted', () => {
  // A geometry upgrade is a reviewed change, not something that slips in
  // through the location importer.
  const r = importSupplementalCampus(
    {
      features: [
        {
          type: 'Feature',
          properties: { id: 'y', name: 'Somewhere', kind: 'FACILITY' },
          geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] },
        },
      ],
    },
    { osmFeatures: [], boundary: OSM.boundary }
  );
  assert.equal(r.features.length, 0);
  assert.equal(r.excluded[0].reason, 'BAD_GEOMETRY');
});

// ── Gate (§8, §24.12) ──────────────────────────────────────────────────────

test('the gate is a GATE, and its unknown access properties stay unknown', () => {
  const gate = BY_ID.get('rnsit-main-gate');
  assert.equal(gate.kind, CAMPUS_FEATURE_KIND.GATE);
  assert.equal(gate.name, 'RNSIT Main Gate Entrance');

  // Carried through as explicit UNKNOWNs rather than dropped: an absent field
  // reads as "nobody thought about it", an explicit UNKNOWN reads as "this is a
  // known gap", and only the second one ever gets filled in.
  assert.equal(gate.metadata['Access type'], 'UNKNOWN');
  assert.equal(gate.metadata['Vehicle access'], 'UNKNOWN');
  assert.equal(gate.metadata['Pedestrian access'], 'UNKNOWN');

  // Nothing was invented to make it routable.
  assert.equal(gate.metadata['Opening hours'], undefined);
  assert.equal(gate.emergencyAccess, undefined);
  assert.equal(gate.serviceAccess, undefined);
});

test('the gate is available to future routing as a semantic feature', () => {
  // It is in the campus definition, findable by kind, and carries a coordinate.
  // That is all this task promises — no route uses it, and the solver is
  // untouched (§21).
  const def = resolveCampusDefinition(RNSIT_RECORD);
  const gates = def.features.filter((f) => f.kind === CAMPUS_FEATURE_KIND.GATE);
  assert.equal(gates.length, 1);
  assert.deepEqual(gates[0].geometry.coordinates, [77.519241, 12.902682]);
  assert.equal(def.coverage.present.some((c) => c.id === 'gates'), true);
});

// ── Reconciliation with OSM (§24.9) ────────────────────────────────────────

test('the same bank recorded twice becomes one place, not two markers', () => {
  assert.equal(SUP.merges.length, 1, 'exactly one true duplicate exists across the two datasets');
  const [m] = SUP.merges;
  assert.equal(m.supplementalId, 'rnsit-canara-bank');
  assert.equal(m.osmId, 'node/2146315474');
  assert.ok(m.metres <= MERGE_RADIUS_M);

  // The supplemental record did NOT become a second feature.
  assert.equal(BY_ID.has('rnsit-canara-bank'), false);

  // The OSM feature it merged into is annotated, and is otherwise untouched:
  // same geometry, same provenance, same verification.
  const def = resolveCampusDefinition(RNSIT_RECORD);
  const bank = def.features.find((f) => f.sourceId === 'node/2146315474');
  assert.equal(bank.provenance, PROVENANCE.OPEN_DATA_IMPORT, 'a merge must not rewrite provenance');
  assert.deepEqual(bank.geometry.coordinates, [77.5185188, 12.9022871], 'nothing was moved');
  assert.equal(bank.corroboratedBy.id, 'rnsit-canara-bank');
  assert.equal(bank.corroboratedBy.provenance, PROVENANCE.USER_SUPPLIED);
  assert.match(bank.metadata['Also recorded as'], /CANARA BANK.*unverified/);
});

test('merging requires the NAME to match, not merely proximity', () => {
  // The trap this rule exists for. On a 24-acre site with 54 features, almost
  // everything is within 60 m of something: merging on distance alone would
  // assert that a food court IS a canteen, deleting a real location.
  const merged = new Set(SUP.merges.map((m) => m.supplementalId));
  assert.equal(merged.has('rnsit-food-court'), false, 'a food court 41 m from a canteen is not that canteen');
  assert.equal(merged.has('rnsit-parking-lot'), false, 'a parking lot 52 m from motorcycle parking is not it');
  assert.ok(BY_ID.has('rnsit-food-court'), 'and it survives as its own location');
  assert.ok(BY_ID.has('rnsit-parking-lot'));
});

test('close-but-differently-named records are disclosed, not merged or hidden', () => {
  const ids = SUP.possibleDuplicates.map((d) => d.supplementalId).sort();
  assert.deepEqual(ids, ['rnsit-cyber-security-department', 'rnsit-food-court']);

  const food = BY_ID.get('rnsit-food-court');
  assert.match(food.metadata['Possible duplicate'], /Canteen/);
  assert.match(food.metadata['Possible duplicate'], /both are classified COMMERCIAL/);
  assert.match(food.metadata['Possible duplicate'], /neither has been moved/);
});

test('proximity alone never flags a duplicate', () => {
  // Two guards against the noise that made the first version of this rule
  // useless: an UNNAMED footprint has no identity to be a duplicate of, and
  // UNCLASSIFIED matching UNCLASSIFIED is an absence of information, not a
  // similarity. Between them they removed 5 of 7 spurious flags.
  const flagged = new Set(SUP.possibleDuplicates.map((d) => d.osmId));
  for (const d of SUP.possibleDuplicates) {
    const osm = OSM.features.find((f) => f.sourceId === d.osmId);
    assert.equal(osm.nameIsDescriptive, false, `${d.osmId} is unnamed and cannot be a duplicate`);
    assert.notEqual(osm.category, CAMPUS_CATEGORY.UNCLASSIFIED);
  }
  // Specifically: the statue 28 m from the food court is not a food court.
  assert.equal(flagged.has('way/1224937858'), false);
});

test('the playgrounds are not confused with the OSM sports ground', () => {
  // 269 m and 344 m away. Distinct places, and both are kept.
  assert.ok(BY_ID.has('rnsit-playground-1'));
  assert.ok(BY_ID.has('rnsit-playground-2'));
  for (const id of ['rnsit-playground-1', 'rnsit-playground-2']) {
    assert.equal(BY_ID.get(id).metadata['Possible duplicate'], undefined);
  }
});

test('the cyber security point is not assigned to the nearest building (§12)', () => {
  const dept = BY_ID.get('rnsit-cyber-security-department');
  // It is disclosed as possibly related to a block 47 m away — and it is NOT
  // given that building's geometry, footprint, height or identity.
  assert.equal(dept.geometry.type, 'Point');
  assert.deepEqual(dept.geometry.coordinates, [77.517667, 12.901389]);
  assert.equal(dept.renderHeight, undefined);
  assert.equal(dept.parentBuilding, undefined);
  assert.match(dept.metadata['Possible duplicate'], /may be the same place, or this may sit within it/);
});

test('the OSM import is not mutated by the supplemental pass (§22)', () => {
  // The merge annotates a COPY. Re-importing the OSM extract from scratch must
  // produce exactly what it produced before the second dataset existed.
  const fresh = importOsmCampus(RNSIT_CAMPUS_OSM, { dataset: OSM_DS });
  const node = fresh.features.find((f) => f.sourceId === 'node/2146315474');
  assert.equal(node.corroboratedBy, undefined, 'the OSM importer must be unaware of the supplemental data');
  assert.equal(node.metadata['Also recorded as'], undefined);
});

// ── Co-location (§24.8) ────────────────────────────────────────────────────

test('two colleges at one coordinate render one marker and stay two records', () => {
  const first = BY_ID.get('rns-first-grade-college');
  const evening = BY_ID.get('rns-evening-college');

  // Same coordinate, and neither was nudged to separate them.
  assert.deepEqual(first.geometry.coordinates, evening.geometry.coordinates);
  assert.deepEqual(first.geometry.coordinates, [77.517575, 12.901151]);

  // One marker, one label.
  assert.equal(rendersOwnMarker(first), true);
  assert.equal(rendersOwnMarker(evening), false);
  assert.equal(isLabelled(evening), false);

  // Two records, each with its own name, cross-referenced both ways.
  assert.equal(evening.coLocatedWith, 'rns-first-grade-college');
  assert.equal(evening.metadata['Co-located with'], 'RNS FIRST GRADE COLLEGE');
  assert.equal(first.metadata['Also at this location'], 'RNS Evening College');
  assert.deepEqual(first.coLocatedFeatures.map((c) => c.name), ['RNS Evening College']);
});

test('co-location is deterministic across repeated imports', () => {
  const a = importSupplementalCampus(RNSIT_CAMPUS_SUPPLEMENTAL, { osmFeatures: OSM.features, boundary: OSM.boundary });
  const b = importSupplementalCampus(RNSIT_CAMPUS_SUPPLEMENTAL, { osmFeatures: OSM.features, boundary: OSM.boundary });
  assert.deepEqual(
    a.features.map((f) => [f.id, f.rendersOwnMarker, f.labelled]),
    b.features.map((f) => [f.id, f.rendersOwnMarker, f.labelled])
  );
  assert.deepEqual(a.merges, b.merges);
  assert.deepEqual(a.possibleDuplicates, b.possibleDuplicates);
});

test('exactly one marker is drawn per physical location', () => {
  const c = campusCollections(resolveCampusDefinition(RNSIT_RECORD));
  const seen = new Map();
  for (const f of c[CAMPUS_SOURCE.POINTS].features) {
    const key = f.geometry.coordinates.join(',');
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  for (const [key, n] of seen) {
    assert.equal(n, 1, `${n} markers stacked at ${key}`);
  }
});

// ── Campus boundary (§24, §7) ──────────────────────────────────────────────

test('every supplied point is classified against the campus boundary', () => {
  const by = Object.fromEntries(SUP.containment.map((c) => [c.name, c.containment]));

  assert.equal(by['RNSIT Main Gate Entrance'], CONTAINMENT.OUTSIDE);
  assert.equal(by['RNSIT Playground 1'], CONTAINMENT.OUTSIDE);
  assert.equal(by['RNSIT Parking Lot'], CONTAINMENT.UNCERTAIN);
  assert.equal(by['CANARA BANK'], CONTAINMENT.UNCERTAIN);
  assert.equal(by['Innovation Center'], CONTAINMENT.INSIDE);
  assert.equal(by['RNSIT Cyber Security Department'], CONTAINMENT.INSIDE);

  assert.equal(SUP.containment.length, 11, 'every supplied point gets a verdict');
});

test('an outside point is kept, classified and reported — never discarded (§7)', () => {
  // A main gate is outside the perimeter almost by definition: that is what a
  // gate is. Dropping it would remove the one feature a fleet needs most.
  const gate = BY_ID.get('rnsit-main-gate');
  assert.ok(gate, 'the outside gate is still imported');
  assert.equal(gate.containment, CONTAINMENT.OUTSIDE);
  assert.ok(gate.metresFromBoundary > 0, 'positive metres = outside');
  assert.match(gate.metadata['Campus boundary'], /OUTSIDE/);
  assert.ok(BY_ID.get('rnsit-playground-1'), 'and so is the outside playground');
});

test('a point near an unverified boundary is UNCERTAIN, not falsely decided', () => {
  // The boundary is itself unverified OSM geometry. A point 1 m outside an
  // unverified line is not evidence the thing is off campus — it is evidence
  // that we do not know, and reporting it as OUTSIDE would dress up the
  // boundary's uncertainty as a fact about the feature.
  const parking = BY_ID.get('rnsit-parking-lot');
  assert.equal(parking.containment, CONTAINMENT.UNCERTAIN);
  assert.ok(Math.abs(parking.metresFromBoundary) <= BOUNDARY_UNCERTAINTY_M);
  assert.match(parking.metadata['Campus boundary'], /too close to call/);
});

test('containment falls back to UNCERTAIN when there is no boundary to test', () => {
  const r = classifyContainment([77.518, 12.901], null);
  assert.equal(r.containment, CONTAINMENT.UNCERTAIN);
  assert.equal(r.metresFromBoundary, null);
});

test('edge distance is measured to the boundary EDGE, not to its vertices', () => {
  // A vertex-only measure would call a point 2 m from the middle of a 200 m
  // perimeter segment "100 m from the boundary", and the UNCERTAIN band would
  // never fire where it matters.
  const square = { type: 'Polygon', coordinates: [[[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01], [0, 0]]] };
  const nearEdgeMidpoint = metresToPolygonEdge([0.005, 0.00001], square);
  assert.ok(nearEdgeMidpoint < 5, `expected a few metres, got ${nearEdgeMidpoint}`);
});

// ── Rendering, search, labels (§24.10, §24.11, §15, §16) ───────────────────

test('supplemental points reach the point layer and nothing else', () => {
  const c = campusCollections(resolveCampusDefinition(RNSIT_RECORD));
  const pointIds = new Set(c[CAMPUS_SOURCE.POINTS].features.map((f) => f.id));

  for (const f of SUP.features) {
    if (f.rendersOwnMarker === false) {
      assert.equal(pointIds.has(f.id), false, `${f.id} is co-located and must not draw its own marker`);
    } else {
      assert.ok(pointIds.has(f.id), `${f.id} must be drawn`);
    }
  }
  assert.equal(c[CAMPUS_SOURCE.LINES].features.some((f) => pointIds.has(f.id)), false);
});

test('no supplemental label claims the campus name band', () => {
  // PRIMARY is the campus's own name, rendered upcased and letter-spaced. A POI
  // in that treatment is the "giant label" the brief rules out (§15).
  for (const f of SUP.features) {
    assert.notEqual(f.labelPriority, LABEL_PRIORITY.PRIMARY, `${f.name} must not use the campus name band`);
  }
  // The gate and the department are operationally important, so they label with
  // the buildings rather than below them.
  assert.equal(BY_ID.get('rnsit-main-gate').labelPriority, LABEL_PRIORITY.SECONDARY);
  assert.equal(BY_ID.get('rnsit-cyber-security-department').labelPriority, LABEL_PRIORITY.SECONDARY);
  // Ordinary facilities wait for close zoom.
  assert.equal(BY_ID.get('rnsit-food-court').labelPriority, LABEL_PRIORITY.DETAIL);
  assert.equal(BY_ID.get('rnsit-parking-lot').labelPriority, LABEL_PRIORITY.DETAIL);
});

test('all eleven supplied names are searchable, including the co-located one', () => {
  const def = resolveCampusDefinition(RNSIT_RECORD);
  const index = buildCampusSearchIndex({ definition: def, robots: [] });
  const finds = (q) => searchCampusIndex(index, q, 12).map((e) => e.name);

  for (const name of SUPPLIED_NAMES) {
    const hits = finds(name);
    if (name === 'CANARA BANK') {
      // Merged into the OSM record of the same place, so it answers under that
      // record's spelling — "Canara Bank". Searching the supplied text still
      // lands the operator on the one bank, which is the point of the merge:
      // the query resolves to a PLACE, not to a string.
      assert.ok(
        hits.some((h) => h.toLowerCase() === name.toLowerCase()),
        `search must find "${name}" (as the merged OSM record)`
      );
      continue;
    }
    assert.ok(hits.includes(name), `search must find "${name}"`);
  }

  // Partial queries an operator would actually type.
  assert.ok(finds('gate').includes('RNSIT Main Gate Entrance'));
  assert.ok(finds('playground').includes('RNSIT Playground 1'));
  assert.ok(finds('parking').includes('RNSIT Parking Lot'));
  assert.ok(finds('innovation').includes('Innovation Center'));
  assert.ok(finds('cyber').includes('RNSIT Cyber Security Department'));

  // The record that surrendered its marker is still findable, and still has a
  // coordinate to fly to — the same one as its host.
  const evening = searchCampusIndex(index, 'Evening College', 12).find((e) => e.name === 'RNS Evening College');
  assert.ok(evening, 'a co-located record must remain searchable');
  assert.deepEqual([evening.lon, evening.lat], [77.517575, 12.901151]);
  assert.match(evening.subtitle, /shares a location/);
});

test('search still offers nothing it cannot locate', () => {
  const def = resolveCampusDefinition(RNSIT_RECORD);
  const index = buildCampusSearchIndex({ definition: def, robots: [] });
  assert.deepEqual(searchCampusIndex(index, 'library'), []);
  assert.deepEqual(searchCampusIndex(index, 'Innovation Centre Annexe'), []);
});

test('a clicked supplemental feature can answer with supplied data and nothing else', () => {
  const gate = BY_ID.get('rnsit-main-gate');
  assert.equal(gate.metadata.Coordinates, '12.902682, 77.519241');
  assert.match(gate.metadata['Supplied as'], /GATE/);

  for (const invented of ['Floors', 'Capacity', 'Height', 'Opening hours', 'Built', 'Area']) {
    assert.equal(gate.metadata[invented], undefined, `${invented} is not in the data and must not be in the card`);
  }
});

// ── The whole model (§24.17) ───────────────────────────────────────────────

test('the merged campus definition is valid and both sources survive it', () => {
  const def = resolveCampusDefinition(RNSIT_RECORD);
  assert.equal(def.ok, true, def.errors.join('; '));
  assert.equal(def.rejected.length, 0);

  const byProvenance = def.features.reduce((acc, f) => {
    acc[f.provenance] = (acc[f.provenance] || 0) + 1;
    return acc;
  }, {});
  assert.equal(byProvenance[PROVENANCE.OPEN_DATA_IMPORT], 54);
  assert.equal(byProvenance[PROVENANCE.USER_SUPPLIED], 10);
  assert.equal(byProvenance[PROVENANCE.SEED_RECORD], 1);
  assert.equal(def.features.length, 65);

  // Ids are unique across the two sources — a collision would have one dataset
  // silently shadowing the other.
  assert.equal(new Set(def.features.map((f) => f.id)).size, def.features.length);
});

test('the existing OSM geometry is unchanged by the second source', () => {
  const def = resolveCampusDefinition(RNSIT_RECORD);
  const fresh = importOsmCampus(RNSIT_CAMPUS_OSM, { dataset: OSM_DS });
  for (const before of fresh.features) {
    const after = def.features.find((f) => f.sourceId === before.sourceId);
    assert.ok(after, `${before.sourceId} must still be present`);
    assert.deepEqual(after.geometry, before.geometry, `${before.sourceId}: geometry moved`);
    assert.equal(after.kind, before.kind);
    assert.equal(after.category, before.category);
    assert.equal(after.renderHeight, before.renderHeight);
    assert.equal(after.provenance, before.provenance);
    assert.equal(after.source, before.source, `${before.sourceId}: the source string was rewritten`);
    assert.equal(after.sourceId, before.sourceId);

    // Verification is the ONE field the registry is allowed to change, and only
    // by adding a dated, attributed record on top (§3A). What it must never do
    // is edit the OSM record underneath: the importer still produces
    // NOT_VERIFIED, and the feature still says it came from OpenStreetMap.
    assert.equal(before.verification, VERIFICATION.NOT_VERIFIED, 'the importer must not verify anything');
    assert.equal(after.verification, VERIFICATION.VERIFIED_BY_USER);
  }
});

// ── Report (§28) ───────────────────────────────────────────────────────────

test('the supplemental summary matches the artefact it describes', () => {
  const s = describeSupplementalImport(RNSIT_CAMPUS_SUPPLEMENTAL, {
    osmFeatures: OSM.features,
    boundary: OSM.boundary,
    dataset: SUP_DS,
  });

  assert.equal(s.sourceFeatures, 11);
  assert.equal(s.imported + s.mergedWithOsm + s.excluded, 11, 'every supplied location is accounted for');
  assert.equal(s.mergedWithOsm, 1);
  assert.equal(s.coLocated, 1);
  assert.equal(s.markersDrawn, 9, '10 imported, 1 co-located, so 9 markers');
  assert.deepEqual(s.byKind, { GATE: 1, FACILITY: 5, SPORTS: 2, PARKING: 1, DEPARTMENT: 1 });
  assert.equal(s.inside.length + s.outside.length + s.uncertain.length, 11);
});

test('the registry exposes the reconciliation for the UI and for review', () => {
  const info = campusSupplementalInfo('RNSIT');
  assert.equal(info.file, 'rnsit-campus-supplemental.geojson');
  assert.equal(info.merges.length, 1);
  assert.equal(info.possibleDuplicates.length, 2);
  assert.equal(info.containment.length, 11);
  assert.equal(campusSupplementalInfo('NOPE'), null);
});

test('kind rules are declared data, not scattered branches', () => {
  for (const k of ['GATE', 'FACILITY', 'SPORTS', 'PARKING', 'DEPARTMENT']) {
    const rule = kindRuleFor(k);
    assert.ok(rule, `${k} must have a rule`);
    assert.ok(rule.kind && rule.category && rule.note, `${k}'s rule must be complete and explained`);
  }
  assert.equal(kindRuleFor('NONSENSE'), null);
  assert.equal(kindRuleFor(undefined), null);
});
