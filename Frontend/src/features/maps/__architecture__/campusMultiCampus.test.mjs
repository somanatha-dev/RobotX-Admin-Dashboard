/**
 * ═══════════════════════════════════════════════════════════════════════════
 * MULTI-CAMPUS — the architecture is generic, or these fail
 *
 *   node --test src/features/maps/__architecture__/
 *   (or: npm run test:arch, from Frontend/)
 *
 * A second campus is not a feature. It is a MEASUREMENT: everything that was
 * secretly about RNSIT now has somewhere to be caught. The failure this file
 * exists to catch is not "JSSATE does not appear" — that is visible in a
 * screenshot. It is the four that are not:
 *
 *   1. A SECOND CAMPUS IMPLEMENTATION. Two importers, two registries, two
 *      classifiers that agree today and diverge in six weeks.
 *   2. RNSIT SILENTLY CHANGED. Making the pipeline generic touched every line
 *      that built RNSIT. Its features must come out byte-identical.
 *   3. GEOMETRY THAT SURVIVES A SWITCH. A layer, a source, a label or a
 *      building from the campus you just left, still on screen.
 *   4. A CAMPUS'S PROVENANCE WEARING ANOTHER'S. RNSIT's owner verification
 *      leaking onto a campus nobody has visited, or JSSATE's features claiming
 *      RNSIT's dataset file.
 *
 * Runs under plain Node — no DOM, no WebGL, no bundler, no Mapbox instance.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import {
  CAMPUS_CATEGORY,
  CAMPUS_FEATURE_KIND,
  PROVENANCE,
  VERIFICATION,
  validateCampusFeature,
} from '../campus/campusSchema.js';
import {
  CAMPUS_GEOMETRY,
  CAMPUS_REGISTRY,
  campusDatasetInfo,
  campusRegistryEntry,
  campusSupplementalInfo,
  missingGeometryRequestFor,
  resolveCampusDefinition,
} from '../campus/campusRegistry.js';
import { JSSATE_BENGALURU_CAMPUS_OSM } from '../campus/data/jssate-bengaluru/jssateBengaluruCampusOsm.js';
import { RNSIT_CAMPUS_OSM } from '../campus/data/rnsit/rnsitCampusOsm.js';
import { importOsmCampus, osmDataset } from '../campus/osm/osmCampusImport.js';
import {
  CAMPUS_INTERACTIVE_LAYERS,
  CAMPUS_LAYER_ORDER,
  CAMPUS_SOURCE,
  campusCollections,
  campusLayerSpecs,
  campusStyleForTheme,
  sourceRoleFor,
} from '../campus/campusLayers.js';
import { installSourcesAndLayers, pushCampusData, removeCampusLayers } from '../campus/useCampusLayer.js';
import {
  SEARCH_RESULT_TYPE,
  buildCampusRegistryIndex,
  buildCampusSearchIndex,
  searchCampusIndex,
} from '../campus/campusSearch.js';
import { MAP_THEMES, MAP_THEME_ORDER } from '../theme/mapThemes.js';
import { CAMPUS_CAMERA_MODE, campusCameraFor } from '../camera/cameraModes.js';
import { validateRoute } from '../operational/routeValidation.js';
import { ROBOT_REPRESENTATION } from '../operational/robotVisual.js';
import { campusVerificationFor } from '../campus/verification/campusVerification.js';

// ── The two DB records, exactly as the filter bar hands them over ────────────

const RNSIT_RECORD = Object.freeze({
  id: 'db-rnsit',
  code: 'RNSIT',
  name: 'RNS Institute of Technology',
  centerLat: 12.9023,
  centerLon: 77.5186,
});

/** Mirrors the row seeded in `Backend/prisma/seed.js`. */
const JSSATE_RECORD = Object.freeze({
  id: 'db-jssate',
  code: 'jssate-bengaluru',
  name: 'JSS Academy of Technical Education',
  centerLat: 12.9027,
  centerLon: 77.5050,
});

const RNSIT = resolveCampusDefinition(RNSIT_RECORD);
const JSSATE = resolveCampusDefinition(JSSATE_RECORD);

// ── 1. The registry entry ───────────────────────────────────────────────────

test('JSSATE is registered with the metadata the hierarchy and the search need', () => {
  const entry = campusRegistryEntry('jssate-bengaluru');
  assert.ok(entry, 'jssate-bengaluru must be a registered campus');
  assert.equal(entry.id, 'jssate-bengaluru');
  assert.equal(entry.name, 'JSS Academy of Technical Education');
  assert.equal(entry.country, 'India');
  assert.equal(entry.state, 'Karnataka');
  assert.equal(entry.city, 'Bengaluru');
  assert.equal(entry.hasCampusGeometry, true);

  // The registry entry carries METADATA and no geometry. That is what lets the
  // filter hierarchy and the search index list a hundred campuses without
  // loading a hundred datasets (§30).
  assert.equal(entry.features, undefined);
  assert.equal(entry.geometry, undefined);
});

test('both campuses go through the SAME registry, keyed by the Campus.code', () => {
  assert.deepEqual(
    CAMPUS_REGISTRY.map((e) => e.id).sort(),
    ['RNSIT', 'jssate-bengaluru'],
    'a campus is registered or it does not exist — there is no second list'
  );

  // Every registry entry has a geometry entry under the identical key. A
  // mismatch here is the multi-campus bug that renders a blank campus while
  // looking configured.
  for (const entry of CAMPUS_REGISTRY) {
    assert.ok(CAMPUS_GEOMETRY[entry.id], `${entry.id} is registered with no geometry entry`);
  }
  assert.deepEqual(Object.keys(CAMPUS_GEOMETRY).sort(), CAMPUS_REGISTRY.map((e) => e.id).sort());

  assert.equal(campusRegistryEntry('NOPE'), null);
  assert.equal(campusRegistryEntry(''), null);
});

// ── 2. Data loading ─────────────────────────────────────────────────────────

test('the JSSATE .js module is the supplied .geojson, not an edited copy of it', () => {
  const p = fileURLToPath(
    new URL('../campus/data/jssate-bengaluru/jssate-bengaluru-campus-osm.geojson', import.meta.url)
  );
  assert.deepEqual(
    JSSATE_BENGALURU_CAMPUS_OSM,
    JSON.parse(readFileSync(p, 'utf8')),
    'regenerate the module from the .geojson; never hand-edit it'
  );
});

test('the supplied JSSATE export is untouched — 47 features, provenance intact', () => {
  assert.equal(JSSATE_BENGALURU_CAMPUS_OSM.features.length, 47);
  assert.equal(JSSATE_BENGALURU_CAMPUS_OSM.generator, 'overpass-turbo');
  assert.match(JSSATE_BENGALURU_CAMPUS_OSM.copyright, /openstreetmap/i);
  assert.equal(JSSATE_BENGALURU_CAMPUS_OSM.timestamp, '2026-08-23T13:21:21Z');

  // Every source feature still carries its OSM id. Losing these is how a
  // feature becomes untraceable back to the community record it came from.
  for (const f of JSSATE_BENGALURU_CAMPUS_OSM.features) {
    assert.match(f.properties['@id'], /^(way|node|relation)\/\d+$/);
  }
});

test('every JSSATE coordinate is the source coordinate, unchanged and unmoved', () => {
  // Not "close to". Identical, and by reference — the same rule RNSIT's import
  // is held to, applied by the same importer, because it IS the same importer.
  const sourceById = (id) => JSSATE_BENGALURU_CAMPUS_OSM.features.find((f) => f.properties['@id'] === id);

  const imported = JSSATE.features.filter((f) => f.sourceId);
  assert.ok(imported.length > 40);

  for (const f of imported) {
    const src = sourceById(f.sourceId);
    assert.ok(src, `${f.sourceId} must come from the supplied collection`);
    assert.equal(f.geometry, src.geometry, `${f.sourceId}: geometry must pass through by reference`);
  }
});

test('the JSSATE export is WGS84 lon/lat and lands where JSSATE actually is', () => {
  // A lat/lon swap produces a perfectly-shaped campus in the Indian Ocean. The
  // campus is at roughly 12.90 N, 77.50 E, so the two orderings are trivially
  // distinguishable. Checked on the CAMPUS features — the extract also contains
  // two city-wide postal boundaries, which are excluded and span far more.
  const inside = JSSATE.features.filter((f) => f.sourceId);
  const positions = [];
  const walk = (c) => {
    if (typeof c[0] === 'number') positions.push(c);
    else c.forEach(walk);
  };
  inside.forEach((f) => walk(f.geometry.coordinates));

  assert.ok(positions.length > 200, 'sanity: there is real geometry to check');
  for (const [lon, lat] of positions) {
    assert.ok(lon > 77.49 && lon < 77.51, `longitude ${lon} is not at JSSATE — lon/lat may be swapped`);
    assert.ok(lat > 12.88 && lat < 12.91, `latitude ${lat} is not at JSSATE — lon/lat may be swapped`);
  }
});

test('every JSSATE source feature is imported or excluded with a stated reason', () => {
  const info = campusDatasetInfo('jssate-bengaluru');
  assert.equal(info.file, 'jssate-bengaluru-campus-osm.geojson');
  assert.equal(info.sourceFeatureCount, 47);
  assert.equal(info.importedFeatureCount + info.excluded.length, 47, 'nothing may vanish silently');

  for (const e of info.excluded) {
    assert.ok(e.reason, `${e.osmId}: an exclusion must have a reason`);
    assert.ok(e.detail, `${e.osmId}: an exclusion must say why`);
  }

  // What this extract's bounding box swept in that is not this campus.
  const excludedIds = info.excluded.map((e) => e.osmId).sort();
  assert.deepEqual(excludedIds, ['relation/17817374', 'relation/17817376', 'way/331547215']);
});

test('JSSATE has no supplemental dataset, and none was invented for it', () => {
  // The separation between OPEN DATA and USER-SUPPLIED LOCAL KNOWLEDGE is the
  // whole reason there are two importers. A campus with nothing in the second
  // category must report nothing there — not a synthesised stand-in, and not
  // RNSIT's file read a second time.
  assert.equal(campusSupplementalInfo('jssate-bengaluru'), null);
  assert.equal(JSSATE.supplemental, null);
  assert.equal(
    JSSATE.features.some((f) => f.provenance === PROVENANCE.USER_SUPPLIED),
    false,
    'nothing may claim to have been supplied by a person who supplied nothing'
  );
});

// ── 3. Schema validation ────────────────────────────────────────────────────

test('every JSSATE feature passes the campus contract, unmodified', () => {
  assert.equal(JSSATE.ok, true, JSSATE.errors.join('; '));
  assert.equal(JSSATE.rejected.length, 0);
  for (const f of JSSATE.features) {
    assert.deepEqual(validateCampusFeature(f, f.id), []);
  }
});

test('the JSSATE database centre and the imported boundary agree about where it is', () => {
  // The quiet multi-campus failure: a registry entry wired to the wrong
  // campus's dataset. The geometry would load, validate and render perfectly —
  // four kilometres from the centre the database holds. Two independent sources
  // agreeing is the check that notices.
  assert.equal(
    JSSATE.centreWithinBoundary,
    true,
    'the seeded JSSATE centre must fall inside the JSSATE boundary'
  );

  // And the cross-check has teeth: RNSIT's centre must NOT fall inside it.
  const crossed = resolveCampusDefinition({ ...JSSATE_RECORD, centerLat: 12.9023, centerLon: 77.5186 });
  assert.equal(crossed.centreWithinBoundary, false, 'the check must fail when the campuses are crossed');
});

test('the JSSATE coverage report names what the extract does not map', () => {
  const present = JSSATE.coverage.present.map((c) => c.id).sort();
  assert.deepEqual(present, ['boundary', 'buildings', 'facilities', 'landmarks', 'paths', 'roads']);

  // No gate, entrance or barrier is mapped anywhere in this extract, so the
  // capability is MISSING and is reported as missing. Nothing was promoted into
  // a gate to fill the row.
  assert.deepEqual(JSSATE.missingGeometry.map((m) => m.id), ['gates']);
  assert.equal(JSSATE.features.some((f) => f.kind === CAMPUS_FEATURE_KIND.GATE), false);
  assert.match(JSSATE.notes, /UNKNOWN/, 'how a fleet gets on site must stay named as unknown');
});

test("JSSATE's outstanding-data request is derived from its own import, not RNSIT's", () => {
  const req = missingGeometryRequestFor('jssate-bengaluru');
  assert.match(req.campus, /JSS Academy of Technical Education/);
  assert.equal(req.suppliedBy.dataset, 'jssate-bengaluru-campus-osm.geojson');
  assert.match(req.suppliedBy.verification, /NOT_VERIFIED/);

  // The two campuses are in genuinely different states, so their requests must
  // differ. JSSATE has no gate mapped at all; RNSIT has one whose access rules
  // are unknown. A shared constant could not say both.
  assert.ok(req.artefacts.some((s) => /no dataset here maps a gate/i.test(s)));
  assert.ok(req.artefacts.some((s) => /Nobody has confirmed a single feature here/i.test(s)));

  const rnsitReq = missingGeometryRequestFor('RNSIT');
  assert.ok(rnsitReq.artefacts.some((s) => /VERIFIED_BY_USER to VERIFIED/.test(s)));
  assert.notDeepEqual(req.artefacts, rnsitReq.artefacts);

  assert.equal(missingGeometryRequestFor('NOPE'), null);
});

// ── 4. Feature classification ───────────────────────────────────────────────

test('JSSATE classifies through the shared rule table, tag by tag', () => {
  const byOsmId = new Map(JSSATE.features.filter((f) => f.sourceId).map((f) => [f.sourceId, f]));
  const kind = (id) => byOsmId.get(id)?.kind;
  const category = (id) => byOsmId.get(id)?.category;

  // The campus itself.
  assert.equal(kind('way/106873634'), CAMPUS_FEATURE_KIND.BOUNDARY, 'amenity=college polygon');
  assert.equal(byOsmId.get('way/106873634').name, 'JSS Academy of Technical Education');

  // Academic blocks — named, and categorised from the name because the tags
  // only say `building=yes`. The same rule that reads RNSIT's "CSE … Department".
  assert.equal(kind('relation/5189000'), CAMPUS_FEATURE_KIND.BUILDING, 'Academic Block A');
  assert.equal(category('relation/5189000'), CAMPUS_CATEGORY.ACADEMIC);
  assert.equal(kind('way/348134309'), CAMPUS_FEATURE_KIND.BUILDING, 'Academic Block C');
  assert.equal(kind('way/1307891565'), CAMPUS_FEATURE_KIND.BUILDING, 'Academic B Block');
  assert.equal(byOsmId.get('way/1307891565').levels, 3, 'building:levels=3 is read, not guessed');

  // A hostel, from `building=dormitory` — a tag, not a name.
  assert.equal(kind('way/1396153763'), CAMPUS_FEATURE_KIND.BUILDING, 'Girls Hostel');
  assert.equal(category('way/1396153763'), CAMPUS_CATEGORY.RESIDENTIAL);
  assert.equal(byOsmId.get('way/1396153763').metadata['Classified from'], 'building=dormitory');

  // Sports and recreation.
  assert.equal(kind('way/1425365487'), CAMPUS_FEATURE_KIND.FACILITY, 'JSSATEB Cricket Ground');
  assert.equal(category('way/1425365487'), CAMPUS_CATEGORY.SPORTS);
  assert.equal(kind('way/1425365484'), CAMPUS_FEATURE_KIND.FACILITY, 'JSS College Play ground');
  assert.equal(category('way/1425365484'), CAMPUS_CATEGORY.SPORTS);

  // Parking — both kinds, both OPERATIONAL.
  assert.equal(category('way/1425365485'), CAMPUS_CATEGORY.OPERATIONAL, 'amenity=parking');
  assert.equal(category('way/348134866'), CAMPUS_CATEGORY.OPERATIONAL, 'amenity=motorcycle_parking');

  // Roads, paths and steps, from the highway hierarchy.
  assert.equal(kind('way/654537800'), CAMPUS_FEATURE_KIND.ROAD, 'highway=residential');
  assert.equal(kind('way/215373982'), CAMPUS_FEATURE_KIND.ROAD, 'highway=service');
  assert.equal(kind('way/1115944581'), CAMPUS_FEATURE_KIND.PATH, 'highway=path');
  assert.equal(byOsmId.get('way/1396152465').pathClass, 'steps', 'a robot cannot drive up steps');

  // Landmarks.
  assert.equal(kind('way/1425365486'), CAMPUS_FEATURE_KIND.LANDMARK, 'Idle Lake — natural=water');
  assert.equal(kind('way/1120154290'), CAMPUS_FEATURE_KIND.LANDMARK, 'amenity=place_of_worship');
  assert.equal(category('way/1120154290'), CAMPUS_CATEGORY.RELIGIOUS);
});

test('nothing unnamed in the JSSATE extract is given an invented identity', () => {
  const unnamed = JSSATE.features.filter((f) => f.nameIsDescriptive);
  assert.ok(unnamed.length > 0, 'sanity: this extract has unnamed buildings');
  for (const f of unnamed) {
    assert.equal(f.labelled, false, 'an unnamed feature must not print a name on the map');
    assert.match(f.metadata['Name in source'], /Not present/);
    assert.match(f.name, /^(Unnamed building|Road|Service road|Path|Footpath|Steps|Parking|Motorcycle parking)$/);
  }
});

test('no JSSATE building claims a measured height, because the extract has none', () => {
  const buildings = JSSATE.features.filter((f) => f.kind === CAMPUS_FEATURE_KIND.BUILDING);
  assert.ok(buildings.length >= 10);
  for (const f of buildings) {
    assert.equal(f.height, undefined, `${f.id}: no measured height exists in this dataset`);
    assert.equal(typeof f.renderHeight, 'number', `${f.id}: a building needs something to draw`);
    assert.ok(f.heightBasis, `${f.id}: a drawn height must say what it was derived from`);
    assert.ok(f.renderHeight > 0 && f.renderHeight <= 20, `${f.id}: ${f.renderHeight} m is not campus-scale`);
  }
  assert.match(JSSATE.notes, /MEASURED height/);
});

test('features the extract reached past the campus are reported, not hidden', () => {
  // An Overpass query is a bounding box. Omkar Ashram is a real, correctly
  // attributed temple that is not on this campus. Deleting it would edit the
  // supplied data; drawing it silently would put it inside "the campus". So it
  // is drawn, and it says where it is.
  const outside = campusDatasetInfo('jssate-bengaluru').outsideBoundary;
  assert.deepEqual(outside.map((o) => o.osmId), ['way/1120154290']);

  const feature = JSSATE.features.find((f) => f.sourceId === 'way/1120154290');
  assert.ok(feature, 'it is still a feature — nothing was deleted');
  assert.match(feature.metadata['Campus boundary'], /Outside/);
  assert.match(JSSATE.notes, /OUTSIDE the campus boundary/);

  // RNSIT's extract was drawn tight around its site, so it has none — which is
  // what makes this a real measurement rather than a constant.
  assert.deepEqual(campusDatasetInfo('RNSIT').outsideBoundary, []);
});

// ── 5. Search ───────────────────────────────────────────────────────────────

const CAMPUS_RECORDS = [RNSIT_RECORD, JSSATE_RECORD];
const REGISTRY_INDEX = buildCampusRegistryIndex(CAMPUS_RECORDS, campusRegistryEntry);

test('every name the brief lists resolves to the one JSSATE campus', () => {
  const resolve = (q) => {
    const hits = searchCampusIndex(REGISTRY_INDEX, q, 5).filter(
      (e) => e.type === SEARCH_RESULT_TYPE.CAMPUS
    );
    return hits[0]?.campusCode ?? null;
  };

  for (const query of [
    'JSSATE',
    'JSSATE Bengaluru',
    'JSS Academy of Technical Education',
    'JSS Academy Of Technical Education',
    'jssate',
    'JSSATEB',
    'jss academy',
  ]) {
    assert.equal(resolve(query), 'jssate-bengaluru', `"${query}" must reach JSSATE`);
  }

  // And it does not swallow the other campus.
  assert.equal(resolve('RNSIT'), 'RNSIT');
  assert.equal(resolve('RNS Institute of Technology'), 'RNSIT');
});

test('a campus search result carries what selecting it needs, and nothing more', () => {
  const jssate = REGISTRY_INDEX.find((e) => e.campusCode === 'jssate-bengaluru');
  assert.equal(jssate.type, SEARCH_RESULT_TYPE.CAMPUS);
  assert.equal(jssate.campusId, 'db-jssate', 'the DB id is what the filter state is set to');
  assert.equal(jssate.lon, JSSATE_RECORD.centerLon, 'the centre comes from the DB record');
  assert.equal(jssate.lat, JSSATE_RECORD.centerLat);
  assert.equal(jssate.subtitle, 'Campus · Bengaluru, Karnataka, India');
  assert.equal(jssate.feature, undefined, 'a campus entry carries no geometry');
});

test('the campus half of the index is metadata only — it loads no geometry', () => {
  // The property that makes this scale to 100 campuses. Building the index for
  // a campus record whose code is not registered at all must still work: it
  // simply has no aliases.
  const unknown = buildCampusRegistryIndex(
    [{ id: 'x', code: 'UNKNOWN', name: 'Somewhere', centerLat: 1, centerLon: 1 }],
    campusRegistryEntry
  );
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].subtitle, 'Campus');

  // A record with no centre cannot be flown to, so it is not offered.
  assert.deepEqual(buildCampusRegistryIndex([{ id: 'y', code: 'Y', name: 'Y' }], campusRegistryEntry), []);
});

test('one index, one ranking function: campuses, places and units together (§3I)', () => {
  const index = buildCampusSearchIndex({
    campuses: REGISTRY_INDEX,
    definition: JSSATE,
    robots: [{ robotId: 'R-01', lat: 12.9027, lon: 77.505, status: 'IDLE' }],
  });

  const kinds = new Set(index.map((e) => e.type));
  assert.deepEqual(
    [...kinds].sort(),
    [SEARCH_RESULT_TYPE.CAMPUS, SEARCH_RESULT_TYPE.CAMPUS_FEATURE, SEARCH_RESULT_TYPE.ROBOT].sort()
  );

  // JSSATE's own places are findable once it is the selected campus.
  const names = (q) => searchCampusIndex(index, q, 8).map((e) => e.name);
  assert.ok(names('cricket').includes('JSSATEB Cricket Ground'));
  assert.ok(names('girls').includes('Girls Hostel'));
  assert.ok(names('academic').some((n) => /Academic/.test(n)));
  assert.ok(names('idle').includes('Idle Lake'));
  assert.ok(names('R-01').includes('R-01'));

  // The rule that has not changed: the index offers nothing it cannot locate.
  assert.deepEqual(names('Central Library'), []);
  assert.deepEqual(names('Main Gate'), [], 'this extract maps no gate, so there is none to find');
});

// ── 6. Camera ───────────────────────────────────────────────────────────────

test('JSSATE uses the generic campus camera — there is no per-campus framing', () => {
  // The camera is told a MODE, never a campus. Both campuses get the identical
  // preset; what differs is the centre, which comes from the DB record.
  for (const mode of Object.values(CAMPUS_CAMERA_MODE)) {
    const preset = campusCameraFor(mode);
    assert.ok(preset, `${mode} must resolve`);
    assert.equal(typeof preset.zoom, 'number');
    assert.equal(typeof preset.pitch, 'number');
  }

  const overview = campusCameraFor(CAMPUS_CAMERA_MODE.OVERVIEW);
  assert.deepEqual(campusCameraFor(CAMPUS_CAMERA_MODE.OVERVIEW), overview, 'a preset is a constant');

  // The framing target for each campus is its own DB centre, and the boundary
  // agrees — so the generic OVERVIEW preset frames the real campus in both
  // cases rather than needing a per-site zoom.
  assert.deepEqual(JSSATE.center, { lon: 77.505, lat: 12.9027 });
  assert.deepEqual(RNSIT.center, { lon: 77.5186, lat: 12.9023 });
  assert.equal(JSSATE.centreWithinBoundary, true);
  assert.equal(RNSIT.centreWithinBoundary, true);
});

// ── 7. Themes ───────────────────────────────────────────────────────────────

test('every theme styles JSSATE the way it styles RNSIT — one style, no campus in it', () => {
  // A theme produces PAINT PROPERTIES for LAYER IDS. It never sees a campus, a
  // feature or a definition, so DAY → EVENING → NIGHT → DAY with either campus
  // selected is the identical set of writes.
  for (const id of MAP_THEME_ORDER) {
    const style = campusStyleForTheme(MAP_THEMES[id], 1, 0);
    const layerIds = Object.keys(style).sort();
    assert.ok(layerIds.length > 0, `${id} must style something`);

    for (const layerId of layerIds) {
      assert.ok(
        CAMPUS_LAYER_ORDER.includes(layerId),
        `${id}: ${layerId} is styled but is not an installed campus layer`
      );
    }

    // The serialised style is a pure function of the theme. Deriving it twice —
    // as a campus switch would — yields the same thing, so a switch cannot
    // leave one campus's appearance on another.
    assert.deepEqual(campusStyleForTheme(MAP_THEMES[id], 1, 0), style);
  }
});

test('a campus definition reaches no theme code path', () => {
  // Structural, not incidental. `campusStyleForTheme(theme, reveal, emphasis)`
  // takes a theme and two numbers, and a theme alone is enough to call it —
  // there is no argument through which a campus, a feature or a definition
  // could be passed. That is why a theme change cannot disturb campus geometry
  // (§52), and why DAY → EVENING → NIGHT behaves identically on both campuses.
  assert.deepEqual(campusStyleForTheme(MAP_THEMES.DAY), campusStyleForTheme(MAP_THEMES.DAY, 1, 0));

  // And the module that builds the style never loads a campus at all.
  const layersSrc = readFileSync(fileURLToPath(new URL('../campus/campusLayers.js', import.meta.url)), 'utf8');
  assert.equal(/from\s+['"][^'"]*campusRegistry/.test(layersSrc), false);
  assert.equal(/from\s+['"][^'"]*\/data\//.test(layersSrc), false);
});

// ── 8-12. Switching: RNSIT → JSSATE → RNSIT, on a fake Mapbox style ─────────

/**
 * A Mapbox style that counts what was done to it.
 *
 * Deliberately strict: `addSource` and `addLayer` THROW on a duplicate id,
 * exactly as the real Mapbox GL does. So a campus switch that added anything a
 * second time would fail here rather than be measured after the fact.
 */
function fakeMap() {
  const sources = new Map();
  const layers = new Map();
  const calls = { addSource: 0, removeSource: 0, addLayer: 0, removeLayer: 0, setData: 0, created: 1 };

  return {
    calls,
    sources,
    layers,
    getStyle: () => ({ layers: [{ id: 'vendor-labels', type: 'symbol', layout: { 'text-field': 'x' } }] }),
    getSource(id) {
      return sources.get(id);
    },
    addSource(id, spec) {
      if (sources.has(id)) throw new Error(`source ${id} already exists`);
      calls.addSource += 1;
      sources.set(id, {
        spec,
        data: spec.data,
        setData(d) {
          calls.setData += 1;
          this.data = d;
        },
      });
    },
    removeSource(id) {
      calls.removeSource += 1;
      sources.delete(id);
    },
    getLayer(id) {
      return layers.get(id);
    },
    addLayer(spec) {
      if (layers.has(spec.id)) throw new Error(`layer ${spec.id} already exists`);
      calls.addLayer += 1;
      layers.set(spec.id, spec);
    },
    removeLayer(id) {
      calls.removeLayer += 1;
      layers.delete(id);
    },
  };
}

const featureIds = (map, sourceId) => (map.getSource(sourceId)?.data.features || []).map((f) => f.id);
const allDrawnIds = (map) =>
  Object.values(CAMPUS_SOURCE).flatMap((s) => (map.getSource(s)?.data.features || []).map((f) => f.properties?.id ?? f.id));

test('switching campus adds no source and no layer — it is a setData', () => {
  const map = fakeMap();
  installSourcesAndLayers(map);

  const sourcesAfterInstall = map.calls.addSource;
  const layersAfterInstall = map.calls.addLayer;
  assert.ok(sourcesAfterInstall > 0 && layersAfterInstall > 0, 'sanity: the layer installed');

  // RNSIT → JSSATE → RNSIT → JSSATE → RNSIT → JSSATE, six switches.
  for (const def of [RNSIT, JSSATE, RNSIT, JSSATE, RNSIT, JSSATE]) {
    pushCampusData(map, def);
  }

  assert.equal(map.calls.addSource, sourcesAfterInstall, 'a campus switch must not add a source');
  assert.equal(map.calls.addLayer, layersAfterInstall, 'a campus switch must not add a layer');
  assert.equal(map.calls.removeSource, 0, 'a campus switch must not remove a source');
  assert.equal(map.calls.removeLayer, 0, 'a campus switch must not remove a layer');
  assert.equal(map.calls.created, 1, 'the Mapbox instance is created once, ever');
});

test('no duplicate sources and no duplicate layers survive repeated installs', () => {
  const map = fakeMap();

  // A style reload re-runs the install. The fake throws on a duplicate id, so
  // an unguarded `addSource`/`addLayer` fails this outright.
  for (let i = 0; i < 4; i += 1) {
    installSourcesAndLayers(map);
    pushCampusData(map, i % 2 === 0 ? RNSIT : JSSATE);
  }

  assert.equal(map.sources.size, Object.values(CAMPUS_SOURCE).length);
  assert.equal(new Set(map.sources.keys()).size, map.sources.size);

  const installedLayerIds = [...map.layers.keys()];
  assert.equal(new Set(installedLayerIds).size, installedLayerIds.length, 'duplicate layer id');
  for (const id of installedLayerIds) {
    assert.ok(CAMPUS_LAYER_ORDER.includes(id), `${id} is installed but is not a declared campus layer`);
  }

  // Every install after the first is a no-op.
  assert.equal(map.calls.addSource, Object.values(CAMPUS_SOURCE).length);
  assert.equal(map.calls.addLayer, installedLayerIds.length);
});

test('RNSIT → JSSATE leaves no RNSIT geometry, label, marker or boundary behind', () => {
  const map = fakeMap();
  installSourcesAndLayers(map);

  pushCampusData(map, RNSIT);
  const rnsitDrawn = new Set(allDrawnIds(map));
  assert.ok(rnsitDrawn.size > 40, 'sanity: RNSIT drew something');

  pushCampusData(map, JSSATE);
  const jssateDrawn = allDrawnIds(map);
  assert.ok(jssateDrawn.length > 30, 'sanity: JSSATE drew something');

  for (const id of jssateDrawn) {
    assert.equal(rnsitDrawn.has(id), false, `${id} is RNSIT geometry still on screen after the switch`);
  }

  // Labels, markers and the vendor clip specifically — the three that would
  // read as "the campus changed but the map did not".
  const labels = map.getSource(CAMPUS_SOURCE.LABELS).data.features.map((f) => f.properties.name);
  assert.equal(labels.some((n) => /RNSIT|RNS Institute/i.test(n)), false, 'a stale RNSIT label');
  assert.ok(labels.some((n) => /JSS/i.test(n)), 'JSSATE labels arrived');

  const clip = map.getSource(CAMPUS_SOURCE.CLIP).data.features;
  assert.equal(clip.length, 1, 'exactly one boundary is clipped, and it is the new one');
  assert.deepEqual(
    clip[0].geometry,
    JSSATE.features.find((f) => f.kind === CAMPUS_FEATURE_KIND.BOUNDARY).geometry
  );
});

test('JSSATE → RNSIT leaves no JSSATE geometry behind either', () => {
  const map = fakeMap();
  installSourcesAndLayers(map);

  pushCampusData(map, JSSATE);
  const jssateDrawn = new Set(allDrawnIds(map));

  pushCampusData(map, RNSIT);
  for (const id of allDrawnIds(map)) {
    assert.equal(jssateDrawn.has(id), false, `${id} is JSSATE geometry still on screen after the switch`);
  }

  const labels = map.getSource(CAMPUS_SOURCE.LABELS).data.features.map((f) => f.properties.name);
  assert.equal(labels.some((n) => /JSS/i.test(n)), false, 'a stale JSSATE label');
  assert.ok(labels.some((n) => /RNSIT/i.test(n)));
});

test('deselecting the campus empties every source rather than stranding a campus', () => {
  const map = fakeMap();
  installSourcesAndLayers(map);
  pushCampusData(map, JSSATE);
  pushCampusData(map, { features: [] });

  for (const sourceId of Object.values(CAMPUS_SOURCE)) {
    assert.deepEqual(featureIds(map, sourceId), [], `${sourceId} kept geometry after the campus was cleared`);
  }
});

test('six switches in a row accumulate nothing — the map is byte-identical each time', () => {
  const map = fakeMap();
  installSourcesAndLayers(map);

  const snapshots = [];
  for (let i = 0; i < 6; i += 1) {
    pushCampusData(map, i % 2 === 0 ? RNSIT : JSSATE);
    snapshots.push(
      Object.fromEntries(
        Object.values(CAMPUS_SOURCE).map((s) => [s, map.getSource(s).data.features.length])
      )
    );
  }

  // Every RNSIT snapshot equals every other RNSIT snapshot; same for JSSATE.
  // A leak of any kind — a feature retained, a marker duplicated — shows up as
  // a count that grows.
  assert.deepEqual(snapshots[0], snapshots[2]);
  assert.deepEqual(snapshots[0], snapshots[4]);
  assert.deepEqual(snapshots[1], snapshots[3]);
  assert.deepEqual(snapshots[1], snapshots[5]);
  assert.notDeepEqual(snapshots[0], snapshots[1], 'sanity: the two campuses differ');

  // Teardown removes exactly what was installed, so an unmount leaves nothing.
  removeCampusLayers(map);
  assert.equal(map.sources.size, 0);
  assert.equal(map.layers.size, 0);
});

// ── 13-14. Provenance and verification ──────────────────────────────────────

test('every JSSATE feature is OpenStreetMap-sourced and names its OWN dataset', () => {
  for (const f of JSSATE.features.filter((x) => x.sourceId)) {
    assert.equal(f.provenance, PROVENANCE.OPEN_DATA_IMPORT);
    assert.match(f.source, /OpenStreetMap/);
    assert.match(f.source, /ODbL/, 'the licence must travel with the data');
    assert.match(f.source, /Not a survey/i);
    assert.match(f.source, /jssate-bengaluru-campus-osm\.geojson/, 'a feature must name its own artefact');
    assert.equal(/rnsit/i.test(f.source), false, "JSSATE features must not cite RNSIT's file");
    assert.ok(f.sourceTags['@id'], 'the raw OSM tags must be preserved');
    assert.equal(f.sourceTags['@id'], f.sourceId);
  }
});

test('JSSATE is NOT_VERIFIED — being in OpenStreetMap is not a verification', () => {
  // The project owner has confirmed RNSIT against the site. Nobody has been to
  // JSSATE. The failure this catches is a blanket verification edit, or a
  // verification record applied by campus POSITION rather than by campus.
  assert.equal(campusVerificationFor('jssate-bengaluru'), null, 'no record exists, and none was invented');
  assert.equal(JSSATE.verificationRecord, null);
  assert.equal(JSSATE.ownerVerifiedCount, 0);
  assert.equal(JSSATE.verifiedCount, 0);

  for (const f of JSSATE.features) {
    assert.equal(f.verification, VERIFICATION.NOT_VERIFIED, `${f.id}: nobody has checked this`);
    assert.equal(f.verifiedBy, undefined);
    assert.equal(f.verifiedOn ?? null, null);
  }

  assert.equal(CAMPUS_GEOMETRY['jssate-bengaluru'].verification.applied, 0);
  assert.match(JSSATE.notes, /NOBODY HAS CHECKED THIS CAMPUS/);
});

test("adding JSSATE did not change one RNSIT feature", () => {
  // The regression that matters most. Making the pipeline generic rewrote every
  // line that built RNSIT, so RNSIT's features are re-derived here from its own
  // artefact through the shared importer and compared field by field.
  const fresh = importOsmCampus(RNSIT_CAMPUS_OSM, { dataset: osmDataset('rnsit-campus-osm.geojson') });
  assert.ok(fresh.features.length > 40);

  for (const before of fresh.features) {
    const after = RNSIT.features.find((f) => f.sourceId === before.sourceId);
    assert.ok(after, `${before.sourceId} disappeared from RNSIT`);
    assert.equal(after.geometry, before.geometry, `${before.sourceId}: geometry is no longer by reference`);
    assert.equal(after.kind, before.kind);
    assert.equal(after.category, before.category);
    assert.equal(after.renderHeight, before.renderHeight);
    assert.equal(after.heightBasis, before.heightBasis);
    assert.equal(after.labelPriority, before.labelPriority);
    assert.equal(after.labelled, before.labelled);
    assert.equal(after.provenance, before.provenance);
    assert.equal(after.source, before.source, `${before.sourceId}: the provenance string changed`);
  }

  // And RNSIT is still the campus the owner confirmed.
  assert.ok(RNSIT.verificationRecord, "RNSIT's verification record must survive");
  assert.equal(RNSIT.ownerVerifiedCount, RNSIT.features.length - 1, 'all but the seeded centre');
  assert.match(RNSIT.notes, /not a georeferenced survey/i);
});

test('the two campuses share no feature id, so selection cannot cross campuses', () => {
  const rnsitIds = new Set(RNSIT.features.map((f) => f.id));
  for (const f of JSSATE.features) {
    assert.equal(rnsitIds.has(f.id), false, `${f.id} is used by both campuses`);
  }
});

// ── 15. The renderer is generic ─────────────────────────────────────────────

test('both campuses route through the identical sources, layers and roles', () => {
  const rnsitKeys = Object.keys(campusCollections(RNSIT)).sort();
  const jssateKeys = Object.keys(campusCollections(JSSATE)).sort();
  assert.deepEqual(rnsitKeys, jssateKeys);
  assert.deepEqual(rnsitKeys, Object.values(CAMPUS_SOURCE).sort());

  // `campusLayerSpecs()` takes no argument at all. There is no way for it to
  // know which campus is loaded, which is the structural reason a second campus
  // could not have grown its own layers.
  assert.equal(campusLayerSpecs.length, 0);
  assert.deepEqual(campusLayerSpecs().map((s) => s.id), [...CAMPUS_LAYER_ORDER]);
  for (const spec of campusLayerSpecs()) {
    assert.ok(
      Object.values(CAMPUS_SOURCE).includes(spec.source),
      `${spec.id} reads a source that is not a campus source`
    );
  }

  // Every feature of BOTH campuses reaches a source, and no polygon lands in
  // the circle layer — a landmark routed to `points` would silently draw
  // nothing while looking configured.
  for (const def of [RNSIT, JSSATE]) {
    for (const f of def.features) {
      const role = sourceRoleFor(f);
      assert.ok(role, `${f.id} (${f.kind}) reaches no source`);
      if (role === 'points') assert.equal(f.geometry.type, 'Point');
      if (role === 'lines') assert.match(f.geometry.type, /LineString/);
    }
  }

  assert.ok(CAMPUS_INTERACTIVE_LAYERS.length > 0);
});

test('the operational layer validates a route against WHICHEVER campus is loaded', () => {
  // §3D route validation takes FEATURES, never a campus. So a route drawn on
  // JSSATE is checked against JSSATE's buildings by the same function that
  // checks RNSIT's, with no second code path and no per-campus tuning.
  assert.equal(validateRoute.length, 0, 'it takes one options object — no campus argument exists');

  const block = JSSATE.features.find((f) => f.sourceId === 'relation/5189000');
  const ring = block.geometry.coordinates[0];
  const through = validateRoute({
    // A straight line across Academic Block A's own footprint.
    path: [ring[0], ring[Math.floor(ring.length / 2)]],
    features: JSSATE.features,
    label: 'test route',
  });

  assert.ok(
    through.findings.some((f) => /Academic Block A/.test(f.detail || f.message || JSON.stringify(f))),
    'a route through a JSSATE building must be reported, naming that building'
  );

  // Reported, never repaired: the input path comes back untouched.
  assert.deepEqual(through.path ?? [ring[0], ring[Math.floor(ring.length / 2)]], [
    ring[0],
    ring[Math.floor(ring.length / 2)],
  ]);
});

test('robots are still 2D, on both campuses, and no campus can change that', () => {
  // The brief for this milestone is explicit: DO NOT implement 3D robots. The
  // representation is a constant the map asks for once, and nothing in the
  // campus layer, the registry or either dataset can reach it.
  assert.deepEqual(Object.keys(ROBOT_REPRESENTATION).sort(), ['THREE_D', 'TWO_D']);

  const mapControl = readFileSync(fileURLToPath(new URL('../MapControl.jsx', import.meta.url)), 'utf8');
  assert.match(mapControl, /representation:\s*ROBOT_REPRESENTATION\.TWO_D/);
  assert.equal(/ROBOT_REPRESENTATION\.THREE_D/.test(mapControl), false);

  // The seam is still there for the day a 3D renderer arrives — the campus work
  // must not have closed it.
  assert.ok(ROBOT_REPRESENTATION.THREE_D, 'the 3D seam stays declared and unimplemented');
});

// ── 16. No campus-specific branches anywhere in the frontend ────────────────

/** Every source file under `features/maps`, plus the data modules it loads. */
function mapSourceFiles() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        walk(p);
        continue;
      }
      if (/\.(js|jsx|mjs)$/.test(name)) out.push(p);
    }
  };
  walk(root);
  return out;
}

test('no rendering, camera, theme or layer code branches on a campus id', () => {
  // The rule this milestone exists to keep true. A campus id may be a KEY —
  // `CAMPUS_GEOMETRY[code]`, `campusVerificationFor(code)` — and may appear in
  // the registry as data. It may never be a CONDITION.
  const forbidden = [
    /campusId\s*===\s*['"`]/,
    /campus\s*===\s*['"`]/,
    /campusCode\s*===\s*['"`]/,
    /\bcode\s*===\s*['"`](RNSIT|jssate)/i,
    /\b(rnsit|jssate)(Renderer|Layers|Camera|Campus|Theme|Style)\b/i,
    /\bif\s*\([^)]*\b(rnsit|jssate)\b[^)]*\)/i,
  ];

  const offences = [];
  for (const file of mapSourceFiles()) {
    // The datasets themselves are DATA — they are full of the campus's own
    // names, as they must be. Only code is scanned.
    if (/[\\/]campus[\\/]data[\\/]/.test(file)) continue;
    // This file names both campuses on purpose: it is the test that they are
    // interchangeable.
    if (/campusMultiCampus\.test\.mjs$/.test(file)) continue;

    const text = readFileSync(file, 'utf8');
    for (const [i, line] of text.split('\n').entries()) {
      // Comments explain; they do not execute.
      const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
      for (const pattern of forbidden) {
        if (pattern.test(code)) offences.push(`${file}:${i + 1}: ${line.trim()}`);
      }
    }
  }

  assert.deepEqual(offences, [], `campus-specific branch(es):\n${offences.join('\n')}`);
});

test('the campus registry is the ONLY module that names a campus dataset', () => {
  // The importers, the layers, the search, the camera and the themes must all
  // be reachable without knowing a campus exists. If a second module starts
  // importing a campus's data, the "one shared engine" claim is over.
  const importers = [];
  for (const file of mapSourceFiles()) {
    if (/[\\/]campus[\\/]data[\\/]/.test(file)) continue;
    if (/__architecture__/.test(file)) continue;
    const text = readFileSync(file, 'utf8');
    if (/from\s+['"][^'"]*campus\/data\//.test(text) || /from\s+['"]\.\/data\//.test(text)) {
      importers.push(file);
    }
  }

  assert.equal(importers.length, 1, `only campusRegistry may load campus data, got:\n${importers.join('\n')}`);
  assert.match(importers[0], /campusRegistry\.js$/);
});
