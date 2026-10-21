/**
 * Create Task pickup / drop locations — the reconciliation audit of 2026-10-21.
 *
 * The report was "many RNSIT locations are missing from the pickup and drop lists". Traced
 * from source to dropdown, nothing is lost: every Point the campus datasets declare inside
 * the adopted boundary is offered, to both ends, from one list. The places that are missing
 * (ECE Department, Main Building, the canteens, …) exist in the data only as OSM building
 * FOOTPRINTS, with no declared delivery point, and the location list does not invent one.
 * These tests pin that accounting so a future loss — or a future invented coordinate — fails
 * by name.
 *
 * Every expectation below is derived from the repository's own campus files; the pinned id
 * lists are what that derivation produced on 2026-10-21 and change only with the data.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(SRC, '..', '..');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const mod = (rel) => import(pathToFileURL(path.join(SRC, rel)).href);

const locations = await mod('features/tasks/campusLocations.js');
const { campusLocationInventory, campusTaskLocations, isWithinCampus, locationInventoryFor, LOCATION_EXCLUSION: X } = locations;
const { pointInPolygon } = await mod('features/maps/campus/osm/osmCampusImport.js');
const { campusRegistryEntry } = await mod('features/maps/campus/campusRegistry.js');
const { RNSIT_CAMPUS_OSM } = await mod('features/maps/campus/data/rnsit/rnsitCampusOsm.js');
const { RNSIT_CAMPUS_SUPPLEMENTAL } = await mod('features/maps/campus/data/rnsit/rnsitCampusSupplemental.js');
const { JSSATE_BENGALURU_CAMPUS_OSM } = await mod('features/maps/campus/data/jssate-bengaluru/jssateBengaluruCampusOsm.js');
// The access-point registers are a source too: every candidate in them is accounted for
// (pinned by campusAccessPoints.test.mjs, which also proves none of them is offered).
const { RNSIT_CAMPUS_ACCESS_CANDIDATES } = await mod('features/maps/campus/data/rnsit/rnsitCampusAccessCandidates.js');
const { JSSATE_BENGALURU_CAMPUS_ACCESS_CANDIDATES } = await mod(
  'features/maps/campus/data/jssate-bengaluru/jssateBengaluruCampusAccessCandidates.js'
);

const RNSIT_BOUNDARY = RNSIT_CAMPUS_OSM.features.find((f) => f.id === 'way/1120154292').geometry;

const RNSIT_OFFERED = [
  'osm-node-2146315474',
  'rns-evening-college',
  'rns-first-grade-college',
  'rnsit-cyber-security-department',
  'rnsit-food-court',
  'rnsit-innovation-center',
  'rnsit-playground-2',
  'rnsit-pre-university-college',
];

const RNSIT_FOOTPRINT_ONLY = [
  'osm-way-1224937859', // RNSIT auditorium
  'osm-way-1224941276', // RNS International School
  'osm-way-1486312655', // Canteen
  'osm-way-1486312656', // RNSIT Civil and AIML Block
  'osm-way-204638927', //  Canara Bank — its place IS offered, as the OSM node
  'osm-way-204638928', //  Canteen
  'osm-way-204638929', //  CSE, ISE & CSDS Department
  'osm-way-204638932', //  ECE Department
  'osm-way-204638937', //  Main Building
  'osm-way-204638941', //  RNSIT Mec and EEE Department
  'osm-way-204638943', //  RNSIT MBA block
];

const JSSATE_FOOTPRINT_ONLY = ['osm-relation-5189000', 'osm-way-1307891565', 'osm-way-348134309', 'osm-way-348135001'];

const ids = (rows) => rows.map((r) => r.id).sort();
const withReason = (inventory, reason) => inventory.excluded.filter((r) => r.reason === reason);
/**
 * The offered locations that are DECLARED points. A site-verified access point (campusAccessPoints
 * tests) is offered too and names the footprint it serves; these tests pin the declared ones, so
 * a genuine review recorded in the register does not break them.
 */
const declaredOf = (rows) => rows.filter((l) => l.servesFeatureId === null);
/** RNSIT footprints a site-verified access point already serves (none until a review is recorded). */
const servedRnsit = () => ids(withReason(campusLocationInventory('RNSIT'), X.SERVED_BY_ACCESS_POINT));

// ── Complete propagation ────────────────────────────────────────────────────

test('RNSIT: every source record is offered or excluded with a reason — none is lost', () => {
  const inventory = campusLocationInventory('RNSIT');
  const sourceCount =
    RNSIT_CAMPUS_OSM.features.length + RNSIT_CAMPUS_SUPPLEMENTAL.features.length + RNSIT_CAMPUS_ACCESS_CANDIDATES.features.length;
  assert.equal(inventory.sourceFeatureCount, sourceCount);
  assert.equal(inventory.offered.length + inventory.excluded.length, sourceCount);
  for (const row of inventory.excluded) assert.ok(Object.values(X).includes(row.reason), `${row.id}: ${row.reason}`);

  // Every declared Point, by its source identity.
  const accounted = new Set([
    ...inventory.offered.flatMap((l) => [l.id, l.sourceId]),
    ...inventory.excluded.flatMap((r) => [r.id, r.sourceId]),
  ]);
  for (const f of RNSIT_CAMPUS_OSM.features.filter((f) => f.geometry.type === 'Point')) assert.ok(accounted.has(f.id), f.id);
  for (const f of RNSIT_CAMPUS_SUPPLEMENTAL.features) assert.ok(accounted.has(f.properties.id), f.properties.id);
});

test('RNSIT: every declared point inside the adopted boundary is offered, except an import duplicate', () => {
  // Derived independently of the pipeline: raw points, raw boundary.
  const raw = [
    ...RNSIT_CAMPUS_OSM.features.filter((f) => f.geometry.type === 'Point').map((f) => ({ key: f.id, at: f.geometry.coordinates })),
    ...RNSIT_CAMPUS_SUPPLEMENTAL.features.map((f) => ({ key: f.properties.id, at: f.geometry.coordinates })),
  ];
  const inside = raw.filter((p) => pointInPolygon(p.at, RNSIT_BOUNDARY)).map((p) => p.key);
  const inventory = campusLocationInventory('RNSIT');
  const duplicates = [...withReason(inventory, X.EXCLUDED_AT_IMPORT), ...withReason(inventory, X.MERGED_AT_IMPORT)]
    .map((r) => r.sourceId);
  const expected = inside.filter((k) => !duplicates.includes(k));
  assert.deepEqual(declaredOf(inventory.offered).map((l) => l.sourceId).sort(), expected.sort());
  assert.deepEqual(ids(declaredOf(inventory.offered)), RNSIT_OFFERED);
  // The two import duplicates, by the importer's own reasons.
  assert.match(inventory.excluded.find((r) => r.sourceId === 'node/1644443078').detail, /^DUPLICATE_OF_POLYGON/);
  assert.match(inventory.excluded.find((r) => r.id === 'rnsit-canara-bank').detail, /node\/2146315474/);
});

test('RNSIT: stable ids and canonical coordinates — nothing is renamed or moved', () => {
  const raw = new Map([
    ...RNSIT_CAMPUS_OSM.features.map((f) => [f.id, f.geometry.coordinates]),
    ...RNSIT_CAMPUS_SUPPLEMENTAL.features.map((f) => [f.properties.id, f.geometry.coordinates]),
    // A verified access point is offered at the register's own coordinate, unchanged.
    ...RNSIT_CAMPUS_ACCESS_CANDIDATES.features.map((f) => [f.properties.id, f.geometry.coordinates]),
  ]);
  const { offered } = campusLocationInventory('RNSIT');
  assert.equal(new Set(offered.map((l) => l.id)).size, offered.length, 'ids are unique');
  for (const l of offered) assert.deepEqual([l.lon, l.lat], raw.get(l.sourceId), `${l.id} moved`);
});

test('RNSIT: the three points outside the adopted boundary are excluded by name (RD-2026-08-30-01)', () => {
  const inventory = campusLocationInventory('RNSIT');
  assert.deepEqual(ids(withReason(inventory, X.OUTSIDE_BOUNDARY)), ['rnsit-main-gate', 'rnsit-parking-lot', 'rnsit-playground-1']);
  for (const r of withReason(inventory, X.OUTSIDE_BOUNDARY)) {
    const [lat, lon] = r.detail.split(', ').map(Number);
    assert.equal(isWithinCampus('RNSIT', lat, lon), false, r.id);
  }
});

// ── The missing places: footprints with no declared point ───────────────────

test('RNSIT: the destination footprints with no declared point are reported, and not given an invented one', () => {
  const inventory = campusLocationInventory('RNSIT');
  const served = servedRnsit();
  // Each destination footprint is reported either with no declared point, or as served by a
  // site-verified access point — never both, never neither.
  const footprints = [...withReason(inventory, X.NO_DECLARED_POINT), ...withReason(inventory, X.SERVED_BY_ACCESS_POINT)];
  assert.deepEqual(ids(footprints), RNSIT_FOOTPRINT_ONLY);
  assert.deepEqual(ids(withReason(inventory, X.NO_DECLARED_POINT)), RNSIT_FOOTPRINT_ONLY.filter((id) => !served.includes(id)));
  // None of them leaked into the offered list under its own id.
  for (const id of RNSIT_FOOTPRINT_ONLY) assert.ok(!inventory.offered.some((l) => l.id === id), id);

  // OSM maps Canara Bank twice: the node (offered) lies inside the Main Building footprint,
  // not the bank's own. Both relations are reported; neither is treated as an identity.
  const bank = footprints.find((r) => r.id === 'osm-way-204638927');
  assert.deepEqual(bank.sameNameOffered, ['osm-node-2146315474']);
  assert.deepEqual(bank.containsOffered, []);
  const main = footprints.find((r) => r.id === 'osm-way-204638937');
  assert.deepEqual(main.sameNameOffered, []);
  assert.deepEqual(main.containsOffered, ['osm-node-2146315474']);

  // What the form tells the operator is missing: all but the bank, whose place is offered.
  const { withoutDeclaredPoint } = campusTaskLocations('RNSIT');
  assert.deepEqual(
    ids(withoutDeclaredPoint),
    RNSIT_FOOTPRINT_ONLY.filter((id) => id !== 'osm-way-204638927' && !served.includes(id))
  );
});

test('RNSIT: two names on one coordinate are both offered and reported as co-located', () => {
  assert.deepEqual(campusLocationInventory('RNSIT').coLocated, [['rns-first-grade-college', 'rns-evening-college']]);
});

// ── Campus isolation ─────────────────────────────────────────────────────────

test('JSSATE: reconciles on its own data — no points declared, four department footprints, nothing offered', () => {
  const inventory = campusLocationInventory('jssate-bengaluru');
  assert.equal(inventory.hasBoundary, true);
  assert.equal(
    inventory.sourceFeatureCount,
    JSSATE_BENGALURU_CAMPUS_OSM.features.length + JSSATE_BENGALURU_CAMPUS_ACCESS_CANDIDATES.features.length
  );
  assert.equal(inventory.offered.length + inventory.excluded.length, inventory.sourceFeatureCount);
  assert.equal(JSSATE_BENGALURU_CAMPUS_OSM.features.filter((f) => f.geometry.type === 'Point').length, 0);
  assert.deepEqual(inventory.offered, []);
  assert.deepEqual(ids(withReason(inventory, X.NO_DECLARED_POINT)), JSSATE_FOOTPRINT_ONLY);
  // And the campus has no operating region, so the form never submits for it.
  assert.equal(campusRegistryEntry('jssate-bengaluru').regionId, null);
});

test('RNSIT and JSSATE never share a location, and asking for one never changes the other', () => {
  const before = campusTaskLocations('RNSIT');
  const jssate = campusTaskLocations('jssate-bengaluru');
  const after = campusTaskLocations('RNSIT');
  assert.deepEqual(after.locations, before.locations);
  assert.deepEqual(ids(declaredOf(after.locations)), RNSIT_OFFERED);
  const rnsitIds = new Set(before.locations.map((l) => l.id));
  for (const l of jssate.locations) assert.ok(!rnsitIds.has(l.id), l.id);
  for (const l of before.locations) assert.equal(isWithinCampus('jssate-bengaluru', l.lat, l.lon), false, l.id);
  for (const id of JSSATE_FOOTPRINT_ONLY) assert.ok(!campusLocationInventory('RNSIT').excluded.some((r) => r.id === id), id);
  assert.deepEqual(campusTaskLocations('NO-SUCH-CAMPUS').locations, []);
  assert.deepEqual(campusTaskLocations('').locations, []);
});

// ── The pure reconciliation: malformed records, coordinate order, duplicates ──

test('the reconciliation names a reason for every malformed, outside, duplicate or footprint record', () => {
  const square = { type: 'Polygon', coordinates: [[[77, 12], [77.01, 12], [77.01, 12.01], [77, 12.01], [77, 12]]] };
  const point = (id, coordinates, extra = {}) => ({ id, name: id, kind: 'FACILITY', geometry: { type: 'Point', coordinates }, ...extra });
  const inventory = locationInventoryFor({
    features: [
      { id: 'b', kind: 'BOUNDARY', geometry: square },
      point('ok', [77.005, 12.005]),
      point('nan', [Number.NaN, 12.005]),
      point('none', undefined),
      point('outside', [77.5, 12.5]),
      point('transposed', [12.005, 77.005]), // [lat, lon] order — lands far off the campus, refused as outside
      point('ok', [77.006, 12.006]), // same id again
      { id: 'dept', name: 'Dept', kind: 'BUILDING', operationalRole: 'DEPARTMENT', geometry: square },
      { id: 'unnamed', name: 'Unnamed building', kind: 'BUILDING', operationalRole: 'NONE', geometry: square },
      { id: 'road', name: 'Road', kind: 'ROAD', geometry: { type: 'LineString', coordinates: [[77, 12], [77.01, 12.01]] } },
    ],
    rejected: [{ id: 'bad', errors: ['no provenance'] }],
    dataset: { sourceFeatureCount: 10, excluded: [{ osmId: 'node/1', name: 'dup', reason: 'DUPLICATE_OF_POLYGON', detail: 'x' }] },
    supplemental: { sourceFeatureCount: 1, merges: [{ supplementalId: 's1', osmId: 'node/2', name: 'S1', metres: 3 }] },
  });
  assert.deepEqual(inventory.offered.map((l) => [l.id, l.lon, l.lat]), [['ok', 77.005, 12.005]]);
  const reasonOf = (id) => inventory.excluded.filter((r) => r.id === id || r.sourceId === id).map((r) => r.reason);
  assert.deepEqual(reasonOf('nan'), [X.MALFORMED_COORDINATE]);
  assert.deepEqual(reasonOf('none'), [X.MALFORMED_COORDINATE]);
  assert.deepEqual(reasonOf('outside'), [X.OUTSIDE_BOUNDARY]);
  assert.deepEqual(reasonOf('transposed'), [X.OUTSIDE_BOUNDARY]);
  assert.deepEqual(reasonOf('ok'), [X.DUPLICATE_ID]);
  assert.deepEqual(reasonOf('dept'), [X.NO_DECLARED_POINT]);
  assert.deepEqual(reasonOf('unnamed'), [X.NOT_A_DESTINATION]);
  assert.deepEqual(reasonOf('road'), [X.NOT_A_DESTINATION]);
  assert.deepEqual(reasonOf('b'), [X.NOT_A_DESTINATION]);
  assert.deepEqual(reasonOf('bad'), [X.INVALID_RECORD]);
  assert.deepEqual(reasonOf('node/1'), [X.EXCLUDED_AT_IMPORT]);
  assert.deepEqual(reasonOf('s1'), [X.MERGED_AT_IMPORT]);
  assert.equal(inventory.sourceFeatureCount, 11);
});

test('a campus with no boundary offers nothing; a missing definition offers nothing', () => {
  const unscoped = locationInventoryFor({ features: [{ id: 'p', kind: 'FACILITY', geometry: { type: 'Point', coordinates: [77, 12] } }] });
  assert.equal(unscoped.hasBoundary, false);
  assert.deepEqual(unscoped.offered, []);
  assert.deepEqual(unscoped.excluded.map((r) => [r.id, r.reason]), [['p', X.OUTSIDE_BOUNDARY]]);
  assert.deepEqual(locationInventoryFor(null).offered, []);
});

// ── The form: one list, both ends, no truncation ────────────────────────────

test('pickup and drop are rendered from the same list, untruncated, and the gap is stated', () => {
  const modal = code(read('components/modals/CreateTaskModal.jsx'));
  assert.equal((modal.match(/campusLocations\.map\(/g) || []).length, 1, 'one option list');
  assert.match(modal, /\{ key: 'pickup'[\s\S]*\{ key: 'drop'[\s\S]*\]\.map\(\(end\) =>[\s\S]*campusLocations\.map\(/, 'shared by both ends');
  assert.doesNotMatch(modal, /campusLocations\.(slice|filter)\(/, 'no per-end filter or limit');
  assert.match(modal, /withoutDeclaredPoint\.length/, 'footprint-only destinations are counted, not silently absent');
});

// ── One dataset, three copies ───────────────────────────────────────────────

test('the dashboard and the backend read the same campus data', () => {
  // The backend's delivery domain, traversal network and seed read the repository-root
  // files; the dashboard reads the Frontend copies through their .js modules (whose parity
  // with the .geojson is pinned by campusOsmImport / campusSupplemental tests). A copy that
  // drifts would offer points the backend geofences or routes differently.
  const pairs = [
    ['rnsit-campus-osm.geojson', 'features/maps/campus/data/rnsit/rnsit-campus-osm.geojson'],
    ['rnsit-campus-supplemental.geojson', 'features/maps/campus/data/rnsit/rnsit-campus-supplemental.geojson'],
    ['jssate-bengaluru-campus-osm.geojson', 'features/maps/campus/data/jssate-bengaluru/jssate-bengaluru-campus-osm.geojson'],
  ];
  for (const [root, copy] of pairs) {
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(REPO, root), 'utf8')),
      JSON.parse(read(copy)),
      `${root} and Frontend/src/${copy} differ — update both together`
    );
  }
});
