/**
 * Development mode: unverified RNSIT department candidates as task locations, for building and
 * testing the software before any site review (`maps/campus/access/developmentCandidates.js`).
 *
 * What this pins:
 *   · the mode is explicit — on only with VITE_UNVERIFIED_CAMPUS_LOCATIONS=true, and never in a
 *     production build, whatever the flag says; off, the production gate is exactly as before;
 *   · it offers the 18 `candidate` entries of the six configured departments, at the register's
 *     own coordinates, named "<building> — point <n> (unverified)", recorded NOT_VERIFIED;
 *   · `needs_review`, `rejected` and unconfigured buildings stay out, and the unique-name rule
 *     still applies;
 *   · pickup and drop offer them from the one list, and a choice reaches the task request with
 *     its exact coordinates.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mod = (rel) => import(pathToFileURL(path.join(SRC, rel)).href);
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const { importAccessPoints, ACCESS_STATUS } = await mod('features/maps/campus/access/accessPointImport.js');
const {
  DEVELOPMENT_CANDIDATE_FLAG,
  DEVELOPMENT_CANDIDATE_BUILDINGS,
  developmentCandidatesEnabled,
  developmentCandidateBuildingsFor,
} = await mod('features/maps/campus/access/developmentCandidates.js');
const { CAMPUS_GEOMETRY, resolveCampusDefinition } = await mod('features/maps/campus/campusRegistry.js');
const { PROVENANCE, VERIFICATION, validateCampusFeature } = await mod('features/maps/campus/campusSchema.js');
const { applyOperationalProfiles } = await mod('features/maps/campus/semantics/campusOperational.js');
const { CAMPUS_VERIFICATION, applyCampusVerification } = await mod('features/maps/campus/verification/campusVerification.js');
const { campusTaskLocations, locationInventoryFor, LOCATION_EXCLUSION: X } = await mod('features/tasks/campusLocations.js');
const { buildAssignTaskRequest } = await mod('lib/taskRequest.js');
const { RNSIT_CAMPUS_ACCESS_CANDIDATES } = await mod('features/maps/campus/data/rnsit/rnsitCampusAccessCandidates.js');

const SIX = DEVELOPMENT_CANDIDATE_BUILDINGS.RNSIT;
const clone = (value) => JSON.parse(JSON.stringify(value));
const osm = () => CAMPUS_GEOMETRY.RNSIT.features.filter((f) => f.provenance === PROVENANCE.OPEN_DATA_IMPORT);
const declaredNames = () =>
  CAMPUS_GEOMETRY.RNSIT.features
    .filter((f) => f.geometry?.type === 'Point' && f.provenance !== PROVENANCE.DERIVED_ACCESS_POINT)
    .map((f) => f.name);
const importDev = (register, buildings = SIX) =>
  importAccessPoints(register, {
    campusId: 'RNSIT',
    osmFeatures: osm(),
    boundary: CAMPUS_GEOMETRY.RNSIT.features.find((f) => f.kind === 'BOUNDARY'),
    declaredNames: declaredNames(),
    developmentCandidateBuildings: buildings,
  });
/**
 * The register before any site review, so a recorded review cannot change what is tested here.
 * A reviewed entry is put back as the generator emitted it — `needs_review` when it carries flags,
 * `candidate` otherwise, with no review — rather than dropped: dropping it would leave these tests
 * checking an empty set once the department points are verified.
 */
const unreviewed = () => {
  const register = clone(RNSIT_CAMPUS_ACCESS_CANDIDATES);
  for (const f of register.features) {
    const p = f.properties;
    if (!p.review && p.status !== ACCESS_STATUS.VERIFIED) continue;
    p.status = (p.flags || []).length > 0 ? ACCESS_STATUS.NEEDS_REVIEW : ACCESS_STATUS.CANDIDATE;
    p.review = null;
  }
  return register;
};
const sixCandidates = (register) =>
  register.features.filter((f) => SIX.includes(f.properties.buildingFeatureId) && f.properties.status === ACCESS_STATUS.CANDIDATE);

// ── The switch ───────────────────────────────────────────────────────────────

test('the mode is on only when explicitly asked for, and never in a production build', () => {
  assert.equal(DEVELOPMENT_CANDIDATE_FLAG, 'VITE_UNVERIFIED_CAMPUS_LOCATIONS');
  const on = { [DEVELOPMENT_CANDIDATE_FLAG]: 'true' };
  assert.equal(developmentCandidatesEnabled(on), true);
  assert.equal(developmentCandidatesEnabled({ ...on, MODE: 'development', DEV: true, PROD: false }), true);
  for (const env of [
    {},
    undefined,
    { [DEVELOPMENT_CANDIDATE_FLAG]: 'false' },
    { [DEVELOPMENT_CANDIDATE_FLAG]: '1' },
    { [DEVELOPMENT_CANDIDATE_FLAG]: true }, // Vite env values are strings; anything else is not "asked for"
    { ...on, PROD: true },
    { ...on, PROD: 'true' },
    { ...on, MODE: 'production' },
    { ...on, NODE_ENV: 'production' },
  ]) {
    assert.equal(developmentCandidatesEnabled(env), false, JSON.stringify(env));
    assert.deepEqual(developmentCandidateBuildingsFor('RNSIT', env), []);
  }
  assert.deepEqual(developmentCandidateBuildingsFor('RNSIT', on), [...SIX]);
  assert.deepEqual(developmentCandidateBuildingsFor('jssate-bengaluru', on), [], 'JSSATE is not configured');
});

test('the six configured buildings are the six clean departments, each with three candidates', () => {
  const names = SIX.map((id) => osm().find((f) => f.id === id).name).sort();
  assert.deepEqual(names, [
    'CSE, ISE & CSDS Department',
    'ECE Department',
    'RNS International School',
    'RNSIT Civil and AIML Block',
    'RNSIT MBA block',
    'RNSIT Mec and EEE Department',
  ]);
  const register = unreviewed();
  for (const id of SIX) {
    const mine = register.features.filter((f) => f.properties.buildingFeatureId === id);
    assert.deepEqual(mine.map((f) => [f.properties.status, f.properties.flags.length]), [['candidate', 0], ['candidate', 0], ['candidate', 0]], id);
  }
});

// ── What it admits ───────────────────────────────────────────────────────────

test('off (the default), the importer admits nothing unverified — the production gate is unchanged', () => {
  const result = importDev(unreviewed(), []);
  assert.deepEqual(result.features, []);
  assert.deepEqual(result.invalid, []);
  const registry = CAMPUS_GEOMETRY.RNSIT.accessPoints;
  assert.equal(registry.unverifiedFeatureCount, 0, 'the test process runs without the flag');
});

test('on, exactly the 18 department candidates are offered, unverified, at the register\'s own coordinates', () => {
  const register = unreviewed();
  const result = importDev(register);
  const expected = sixCandidates(register);
  assert.equal(expected.length, 18);
  assert.deepEqual(result.invalid, []);
  assert.deepEqual(result.features.map((f) => f.id).sort(), expected.map((f) => f.properties.id).sort());
  const byId = new Map(expected.map((f) => [f.properties.id, f]));
  for (const feature of result.features) {
    const entry = byId.get(feature.id);
    assert.deepEqual(feature.geometry.coordinates, entry.geometry.coordinates, `${feature.id} moved`);
    assert.equal(feature.servesFeatureId, entry.properties.buildingFeatureId);
    assert.match(feature.name, new RegExp(`^${entry.properties.buildingName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} — point [123] \\(unverified\\)$`));
    // Never presented as checked: NOT_VERIFIED, no reviewer, no date.
    assert.equal(feature.unverifiedCandidate, true);
    assert.equal(feature.verification, VERIFICATION.NOT_VERIFIED);
    assert.equal(feature.verifiedOn, null);
    assert.equal(feature.verifiedBy, undefined);
    assert.equal(feature.provenance, PROVENANCE.DERIVED_ACCESS_POINT);
    assert.match(feature.source, /UNVERIFIED development candidate/);
    assert.deepEqual(validateCampusFeature(feature, feature.id), []);
  }
  // The campus's blanket owner check cannot promote them.
  const checked = applyCampusVerification(applyOperationalProfiles(result.features), CAMPUS_VERIFICATION.RNSIT).features;
  assert.ok(checked.every((f) => f.verification === VERIFICATION.NOT_VERIFIED));
  // Every name is unique, and none repeats a declared location.
  const names = result.features.map((f) => f.name.toLowerCase());
  assert.equal(new Set(names).size, 18);
  for (const n of declaredNames()) assert.ok(!names.includes(n.toLowerCase()), n);
  // Everything else is still pending or rejected, as before.
  assert.equal(result.pending.length + result.rejected.length + result.features.length, register.features.length);
});

test('needs_review, rejected and unconfigured buildings stay out even in development mode', () => {
  const register = unreviewed();
  const [ece1, ece2] = register.features.filter((f) => f.properties.buildingFeatureId === 'osm-way-204638932');
  ece1.properties.status = ACCESS_STATUS.NEEDS_REVIEW;
  ece2.properties.status = ACCESS_STATUS.REJECTED;
  const result = importDev(register);
  const offered = new Set(result.features.map((f) => f.id));
  assert.ok(!offered.has(ece1.properties.id), 'needs_review');
  assert.ok(!offered.has(ece2.properties.id), 'rejected');
  assert.equal(result.features.length, 16);
  // The canteens, Main Building, auditorium and Canara Bank footprint are not configured.
  for (const f of result.features) assert.ok(SIX.includes(f.servesFeatureId), f.id);
});

test('the unique-name rule still applies in development mode', () => {
  // Configure both canteens: each would be "Canteen — point 1 (unverified)", so both are refused.
  const result = importDev(unreviewed(), ['osm-way-204638928', 'osm-way-1486312655']);
  const plainCanteen = result.features.filter((f) => /^Canteen — point 1 /.test(f.name));
  assert.deepEqual(plainCanteen, []);
  assert.ok(result.invalid.some((r) => /would also name an access point of/.test(r.problems.join(' '))));
});

test('a verified entry stays verified; development mode never re-labels it', () => {
  const register = unreviewed();
  const ece = register.features.find((f) => f.properties.buildingFeatureId === 'osm-way-204638932');
  Object.assign(ece.properties, { status: ACCESS_STATUS.VERIFIED, review: { by: 'TEST', on: '2026-10-21', method: 'OWNER_SITE_CHECK' } });
  const result = importDev(register);
  const feature = result.features.find((f) => f.id === ece.properties.id);
  assert.equal(feature.name, 'ECE Department');
  assert.equal(feature.verification, VERIFICATION.VERIFIED_BY_USER);
  assert.equal(feature.unverifiedCandidate, undefined);
  assert.equal(result.features.filter((f) => f.unverifiedCandidate).length, 17);
});

// ── Through the inventory, the registry, the form and the request ───────────

test('the inventory offers them to pickup and drop alike, keeps the declared eight, and says they are unverified', () => {
  const admitted = importDev(unreviewed());
  const definition = resolveCampusDefinition({ code: 'RNSIT', name: 'RNS Institute of Technology' });
  const inventory = locationInventoryFor({
    ...definition,
    features: [...definition.features.filter((f) => f.provenance !== PROVENANCE.DERIVED_ACCESS_POINT), ...applyOperationalProfiles(admitted.features)],
    accessPoints: { ...definition.accessPoints, pending: admitted.pending, rejected: admitted.rejected, invalid: admitted.invalid },
  });
  assert.equal(inventory.offered.length, 8 + 18);
  assert.equal(inventory.offered.filter((l) => l.unverified).length, 18);
  assert.equal(inventory.offered.filter((l) => l.servesFeatureId === null).length, 8, 'the declared eight');
  assert.equal(inventory.offered.length + inventory.excluded.length, inventory.sourceFeatureCount);
  const served = inventory.excluded.filter((r) => r.reason === X.SERVED_BY_UNVERIFIED_CANDIDATE);
  assert.deepEqual(served.map((r) => r.id).sort(), [...SIX].sort());
  for (const r of served) {
    assert.deepEqual(r.servedBy, [], 'not "served by a verified point"');
    assert.equal(r.servedByUnverified.length, 3);
  }
  assert.ok(!inventory.excluded.some((r) => r.reason === X.SERVED_BY_ACCESS_POINT));
});

test('the real registry: the flag adds only the department candidates, and a production build ignores it', () => {
  // Derived from the register, so a recorded site review moves an entry from "development only" to
  // "offered everywhere" without editing this test: 8 declared + every verified entry in any build,
  // plus the unreviewed department candidates only with the flag in a non-production build.
  const declared = 8;
  const verified = RNSIT_CAMPUS_ACCESS_CANDIDATES.features.filter((f) => f.properties.status === ACCESS_STATUS.VERIFIED).length;
  const development = sixCandidates(RNSIT_CAMPUS_ACCESS_CANDIDATES).length;
  assert.equal(verified + development, 18, 'the six departments have 18 points between them, verified or not');
  const script = [
    "import { pathToFileURL } from 'node:url';",
    `const m = await import(pathToFileURL(${JSON.stringify(path.join(SRC, 'features/tasks/campusLocations.js'))}).href);`,
    "const r = m.campusTaskLocations('RNSIT').locations; const j = m.campusTaskLocations('jssate-bengaluru').locations;",
    'console.log(JSON.stringify({ rnsit: r.length, unverified: r.filter((l) => l.unverified).length, jssate: j.length }));',
  ].join('\n');
  const run = (extra) => {
    const env = { ...process.env, ...extra };
    delete env.NODE_ENV;
    Object.assign(env, extra);
    return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' }).trim());
  };
  assert.deepEqual(run({ [DEVELOPMENT_CANDIDATE_FLAG]: 'true' }), { rnsit: declared + verified + development, unverified: development, jssate: 0 });
  assert.deepEqual(run({ [DEVELOPMENT_CANDIDATE_FLAG]: 'true', NODE_ENV: 'production' }), { rnsit: declared + verified, unverified: 0, jssate: 0 });
  assert.deepEqual(run({ [DEVELOPMENT_CANDIDATE_FLAG]: 'false' }), { rnsit: declared + verified, unverified: 0, jssate: 0 });
});

test('a development location reaches the task request with its exact coordinates and the RNSIT region', () => {
  const [feature] = importDev(unreviewed()).features.filter((f) => f.servesFeatureId === 'osm-way-204638932');
  const [lon, lat] = feature.geometry.coordinates;
  const body = buildAssignTaskRequest({
    campusId: 'RNSIT',
    pickup: feature.name,
    pickupLat: lat,
    pickupLon: lon,
    drop: 'RNSIT Food Court',
    dropLat: 12.900817,
    dropLon: 77.518043,
    payload: { massKg: 1, massToleranceKg: 0.1 },
    requestedChassisType: 'ROVER',
  });
  assert.equal(body.regionId, 'rnsit');
  assert.equal(body.pickup, feature.name);
  assert.equal(body.pickupLat, lat);
  assert.equal(body.pickupLon, lon);
});

test('the form says plainly when unverified options are in the list', () => {
  const modal = code(fs.readFileSync(path.join(SRC, 'components/modals/CreateTaskModal.jsx'), 'utf8'));
  assert.match(modal, /unverifiedCount > 0/);
  assert.match(modal, /data-unverified-locations=/);
  assert.doesNotMatch(modal, /campusLocations\.(slice|filter)\(/, 'the count comes from campusTaskLocations, not a per-end filter');
  // Still one list for both ends.
  assert.equal((modal.match(/campusLocations\.map\(/g) || []).length, 1);
  // And the default build has none to announce.
  assert.equal(campusTaskLocations('RNSIT').unverifiedCount, 0);
});
