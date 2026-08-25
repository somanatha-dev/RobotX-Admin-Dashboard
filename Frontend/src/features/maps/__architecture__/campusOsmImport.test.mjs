/**
 * ═══════════════════════════════════════════════════════════════════════════
 * OSM CAMPUS IMPORT — the integration, pinned
 *
 *   node --test src/features/maps/__architecture__/
 *   (or: npm run test:arch, from Frontend/)
 *
 * Importing real geometry made two new failure modes possible, and neither is
 * visible on a screenshot:
 *
 *   1. GEOMETRY THAT MOVED. A reprojection, a rounding, a "repair", a
 *      coordinate swap. The map still looks like a campus; it is simply in the
 *      wrong place, and every robot on it appears to drive through walls.
 *
 *   2. A DRAWN HEIGHT BECOMING A MEASURED ONE. `renderHeight` is a decision
 *      about a picture. The moment it is reported as `height`, the map is
 *      asserting building dimensions nobody measured.
 *
 * Most of what follows is about those two. Runs under plain Node — no DOM, no
 * WebGL, no bundler, no Mapbox.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  CAMPUS_CATEGORY,
  CAMPUS_FEATURE_KIND,
  LABEL_PRIORITY,
  PATH_CLASS,
  PROVENANCE,
  ROAD_CLASS,
  VERIFICATION,
  validateCampusFeature,
} from '../campus/campusSchema.js';
import { RNSIT_CAMPUS_OSM } from '../campus/data/rnsit/rnsitCampusOsm.js';
import {
  EXCLUSION_REASON,
  HEIGHT_BASIS,
  LABEL_DEDUP_RADIUS_M,
  RENDER_HEIGHT,
  classifyOsmFeature,
  deriveRenderHeight,
  describeOsmImport,
  importOsmCampus,
  metresBetween,
  parseOsmHeight,
  parseOsmLevels,
} from '../campus/osm/osmCampusImport.js';
import {
  CAMPUS_LAYER,
  CAMPUS_SOURCE,
  campusCollections,
  campusLayerSpecs,
  isLabelled,
  labelAnchorFor,
  sourceRoleFor,
} from '../campus/campusLayers.js';
import { resolveCampusDefinition } from '../campus/campusRegistry.js';
import { buildCampusSearchIndex, searchCampusIndex } from '../campus/campusSearch.js';

const RNSIT_RECORD = Object.freeze({
  code: 'RNSIT',
  name: 'RNS Institute of Technology',
  centerLat: 12.9023,
  centerLon: 77.5186,
});

const IMPORT = importOsmCampus(RNSIT_CAMPUS_OSM);
const BY_OSM_ID = new Map(IMPORT.features.map((f) => [f.sourceId, f]));
const sourceById = (id) => RNSIT_CAMPUS_OSM.features.find((f) => f.properties['@id'] === id);

// ── The source artefact ─────────────────────────────────────────────────────

test('the .js module is the .geojson file, not an edited copy of it', () => {
  // The module exists so `resolveCampusDefinition` can stay synchronous under
  // both Vite and plain Node. It must never become a place where geometry gets
  // quietly touched up — so it is compared against the artefact it mirrors.
  const geojsonPath = fileURLToPath(new URL('../campus/data/rnsit/rnsit-campus-osm.geojson', import.meta.url));
  const onDisk = JSON.parse(readFileSync(geojsonPath, 'utf8'));
  assert.deepEqual(RNSIT_CAMPUS_OSM, onDisk, 'regenerate the module from the .geojson; never hand-edit it');
});

test('the export is WGS84 lon/lat and lands where RNSIT actually is (§22)', () => {
  // GeoJSON is *normally* lon/lat WGS84. "Normally" is not "verified", and a
  // lat/lon swap is the classic import bug that produces a perfectly-shaped
  // campus in the Indian Ocean. RNSIT is at roughly 12.90 N, 77.52 E, so the
  // two orderings are trivially distinguishable.
  const positions = [];
  const walk = (c) => {
    if (typeof c[0] === 'number') positions.push(c);
    else c.forEach(walk);
  };
  RNSIT_CAMPUS_OSM.features.forEach((f) => walk(f.geometry.coordinates));

  assert.equal(positions.length, 330, 'sanity: every position in the export is checked');
  for (const [lon, lat] of positions) {
    assert.ok(lon > 77.51 && lon < 77.53, `longitude ${lon} is not at RNSIT — lon/lat may be swapped`);
    assert.ok(lat > 12.89 && lat < 12.91, `latitude ${lat} is not at RNSIT — lon/lat may be swapped`);
  }
});

// ── Geometry is passed through, never transformed (§21, §23, §56) ───────────

test('every imported coordinate is the source coordinate, unchanged', () => {
  // Not "close to". Identical. There is exactly ONE coordinate system on this
  // map — the one the robot world transform already uses — and the way the
  // campus joins it is by not being converted at all. A tolerance here would
  // be a place for a systematic offset to hide.
  assert.ok(IMPORT.features.length > 40);

  for (const f of IMPORT.features) {
    const src = sourceById(f.sourceId);
    assert.ok(src, `${f.sourceId} must come from the source collection`);
    assert.deepEqual(
      f.geometry,
      src.geometry,
      `${f.sourceId}: geometry was modified on the way in — no reprojection, rounding, ` +
        'simplification or repair is permitted'
    );
    // Stronger still: the same object, so a copy cannot silently diverge later.
    assert.equal(f.geometry, src.geometry, `${f.sourceId}: geometry must be passed through by reference`);
  }
});

test('the import invents no feature — every output traces to one input', () => {
  const sourceIds = new Set(RNSIT_CAMPUS_OSM.features.map((f) => f.properties['@id']));
  for (const f of IMPORT.features) {
    assert.ok(sourceIds.has(f.sourceId), `${f.id} has no source element — it was invented`);
  }
  // And every input is accounted for: imported, or excluded with a stated reason.
  const accounted = new Set([...IMPORT.features.map((f) => f.sourceId), ...IMPORT.excluded.map((e) => e.osmId)]);
  assert.equal(accounted.size, sourceIds.size, 'every source feature must be imported or explicitly excluded');
  for (const e of IMPORT.excluded) {
    assert.ok(Object.values(EXCLUSION_REASON).includes(e.reason), `${e.osmId}: unknown exclusion reason`);
    assert.ok(e.detail, `${e.osmId}: an exclusion must say why`);
  }
});

// ── Provenance (§3, §34) ────────────────────────────────────────────────────

test('every imported feature is OpenStreetMap-sourced and NOT_VERIFIED', () => {
  for (const f of IMPORT.features) {
    assert.equal(f.provenance, PROVENANCE.OPEN_DATA_IMPORT);
    assert.equal(f.verification, VERIFICATION.NOT_VERIFIED);
    assert.equal(f.verifiedOn, null);
    assert.match(f.source, /OpenStreetMap/);
    assert.match(f.source, /ODbL/, 'the licence must travel with the data');
    assert.match(f.source, /Not a survey/i);
  }
});

test('the raw OSM tags survive the import, so a later verification can see them', () => {
  const cse = BY_OSM_ID.get('way/204638929');
  assert.ok(cse);
  assert.deepEqual(cse.sourceTags, sourceById('way/204638929').properties);
  assert.equal(cse.sourceTags['building:levels'], '3');
});

test('every imported feature passes the campus contract unchanged', () => {
  // The import is not exempt from the rule that keeps invented geometry off the
  // map — it goes through exactly the same validator as a hand-authored survey.
  for (const f of IMPORT.features) {
    assert.deepEqual(validateCampusFeature(f, f.sourceId), []);
  }
});

// ── Classification (§40, §41) ───────────────────────────────────────────────

test('buildings, roads, paths, landmarks and the boundary are each classified correctly', () => {
  const kind = (osmId) => BY_OSM_ID.get(osmId)?.kind;

  assert.equal(kind('way/1120154292'), CAMPUS_FEATURE_KIND.BOUNDARY, 'amenity=college polygon is the campus');
  assert.equal(kind('way/204638929'), CAMPUS_FEATURE_KIND.BUILDING, 'building=yes');
  assert.equal(kind('way/204638936'), CAMPUS_FEATURE_KIND.BUILDING, 'building=dormitory');
  assert.equal(kind('way/1101720976'), CAMPUS_FEATURE_KIND.ROAD, 'highway=residential');
  assert.equal(kind('way/204638946'), CAMPUS_FEATURE_KIND.ROAD, 'highway=service');
  assert.equal(kind('way/204638947'), CAMPUS_FEATURE_KIND.PATH, 'highway=footway');
  assert.equal(kind('way/204638944'), CAMPUS_FEATURE_KIND.PATH, 'highway=steps');
  assert.equal(kind('way/1224937858'), CAMPUS_FEATURE_KIND.LANDMARK, 'historic=memorial');
  assert.equal(kind('way/204638954'), CAMPUS_FEATURE_KIND.FACILITY, 'amenity=parking');
  assert.equal(kind('way/1224941277'), CAMPUS_FEATURE_KIND.FACILITY, 'leisure=pitch');
});

test('the road hierarchy comes from the highway tag, and steps are separated from footways (§17)', () => {
  assert.equal(BY_OSM_ID.get('way/1101720976').roadClass, ROAD_CLASS.MAIN);
  assert.equal(BY_OSM_ID.get('way/204638946').roadClass, ROAD_CLASS.SECONDARY);
  assert.equal(BY_OSM_ID.get('way/204638947').pathClass, PATH_CLASS.FOOTWAY);
  assert.equal(BY_OSM_ID.get('way/204638944').pathClass, PATH_CLASS.STEPS);

  // A robot cannot drive up steps. Drawing them as a thinner footpath would
  // hide that from an operator reading a route, so they are their own layer.
  const layerIds = campusLayerSpecs().map((s) => s.id);
  assert.ok(layerIds.includes(CAMPUS_LAYER.STEPS));
  assert.ok(layerIds.includes(CAMPUS_LAYER.PATH));
});

test('a building tag contradicted by an open playing surface is not extruded (§41)', () => {
  // `way/151617521`: building=commercial + sport=cricket;football + surface=grass,
  // over 13 000 m². Extruding it would put a seven-metre box across the whole
  // field. The tags disagree; the reading that claims less wins, and the
  // disagreement is reported rather than resolved silently.
  const ground = BY_OSM_ID.get('way/151617521');
  assert.ok(ground);
  assert.equal(ground.kind, CAMPUS_FEATURE_KIND.FACILITY, 'not a building volume');
  assert.equal(ground.category, CAMPUS_CATEGORY.SPORTS);
  assert.equal(ground.renderHeight, undefined, 'nothing to extrude');
  assert.match(ground.metadata['Tag conflict'], /building=commercial contradicted by sport/);

  assert.equal(IMPORT.conflicts.length, 1, 'exactly one tag conflict exists in this dataset');
  assert.equal(IMPORT.conflicts[0].osmId, 'way/151617521');
});

test('a category derived from a name says so, and only a palette depends on it', () => {
  // §33: no `if (name === 'CSE')` in rendering code. The rule lives in the
  // classifier, records how it fired, and drives a colour — nothing more.
  const cse = BY_OSM_ID.get('way/204638929');
  assert.equal(cse.category, CAMPUS_CATEGORY.ACADEMIC);
  assert.match(cse.metadata['Classified from'], /derived from the name, not from a tag/);

  // A tag beats a name, and says so differently.
  const temple = BY_OSM_ID.get('way/204638938');
  assert.equal(temple.category, CAMPUS_CATEGORY.RELIGIOUS);
  assert.equal(temple.metadata['Classified from'], 'amenity=place_of_worship');

  // Deleting every name rule must leave the map geographically identical —
  // only less colourful. Nothing but `category` may change.
  const stripped = classifyOsmFeature({ ...sourceById('way/204638929'), properties: { '@id': 'way/x', building: 'yes' } });
  assert.equal(stripped.kind, CAMPUS_FEATURE_KIND.BUILDING);
  assert.equal(stripped.category, CAMPUS_CATEGORY.UNCLASSIFIED);
});

test('an unnamed feature is never given an invented identity (§4)', () => {
  const unnamed = IMPORT.features.filter((f) => f.nameIsDescriptive);
  assert.ok(unnamed.length > 0, 'sanity: this dataset has unnamed features');

  for (const f of unnamed) {
    assert.equal(sourceById(f.sourceId).properties.name, undefined, 'it really is unnamed in the source');
    assert.equal(f.labelled, false, 'an unnamed feature must not print a name on the map');
    assert.match(f.metadata['Name in source'], /Not present/);
    // The descriptive name describes what the tags say it is, and nothing more.
    assert.ok(
      /^(Unnamed building|Service road|Road|Footpath|Path|Steps|Parking|Motorcycle parking|Toilets|Theatre|Sports ground|Track|Pedestrian way|Corridor)$/.test(
        f.name
      ),
      `${f.sourceId}: "${f.name}" is not a tag description`
    );
  }
});

// ── Heights (§8, §38, §39) ──────────────────────────────────────────────────

test('this dataset contains no measured height, and the import does not manufacture one', () => {
  for (const f of RNSIT_CAMPUS_OSM.features) {
    assert.equal(parseOsmHeight(f.properties), null, `${f.properties['@id']} unexpectedly has a height tag`);
  }
  for (const f of IMPORT.features) {
    assert.equal(f.height, undefined, `${f.sourceId}: height must stay absent`);
  }
});

test('a drawn height is derived from levels where the source has them, and defaulted where it does not', () => {
  assert.equal(parseOsmLevels({ 'building:levels': '3' }), 3);
  assert.equal(parseOsmLevels({ 'building:levels': 'three' }), null);

  const cse = BY_OSM_ID.get('way/204638929'); // building:levels = 3
  assert.equal(cse.levels, 3);
  assert.equal(cse.renderHeight, 3 * RENDER_HEIGHT.METRES_PER_LEVEL);
  assert.equal(cse.heightBasis, HEIGHT_BASIS.OSM_LEVELS);
  assert.match(cse.metadata['Drawn height'], /not a measured height/);
  assert.equal(cse.metadata['Measured height'], 'Not in source data');

  const school = BY_OSM_ID.get('way/1224941276'); // building:levels = 4
  assert.equal(school.renderHeight, 4 * RENDER_HEIGHT.METRES_PER_LEVEL);

  const noLevels = BY_OSM_ID.get('way/204638934'); // Hostel, no levels
  assert.equal(noLevels.levels, undefined);
  assert.equal(noLevels.renderHeight, RENDER_HEIGHT.FALLBACK);
  assert.equal(noLevels.heightBasis, HEIGHT_BASIS.FALLBACK);
  assert.match(noLevels.metadata['Drawn height'], /rendering default/);
});

test('a tiny footprint is not extruded into a pillar', () => {
  // The 26 m² Canara Bank kiosk at the default 7 m would render as a tall thin
  // tower — a confident visual claim the data does not support (§39).
  const kiosk = BY_OSM_ID.get('way/204638927');
  assert.equal(kiosk.heightBasis, HEIGHT_BASIS.FALLBACK_CLAMPED);
  assert.ok(kiosk.renderHeight < RENDER_HEIGHT.FALLBACK);
  assert.ok(kiosk.renderHeight >= 2.5);

  // The clamp is for the default only — a recorded level count is honoured.
  const withLevels = deriveRenderHeight(
    { 'building:levels': '4' },
    { type: 'Polygon', coordinates: [[[0, 0], [0.00001, 0], [0.00001, 0.00001], [0, 0.00001], [0, 0]]] }
  );
  assert.equal(withLevels.basis, HEIGHT_BASIS.OSM_LEVELS);
  assert.equal(withLevels.renderHeight, 14);
});

test('no building is drawn at a skyline height (§39)', () => {
  for (const f of IMPORT.features.filter((x) => x.kind === CAMPUS_FEATURE_KIND.BUILDING)) {
    assert.ok(f.renderHeight <= 20, `${f.sourceId}: ${f.renderHeight} m is not a college campus`);
  }
});

// ── De-duplication (§6, §13, §41) ───────────────────────────────────────────

test('an object OSM mapped twice is imported once', () => {
  // `node/1644443078` carries the identical tags (down to the wikidata id) to
  // the campus boundary way, and sits inside it. Two "RNS Institute of
  // Technology" labels in the middle of the campus is the visible symptom.
  assert.equal(BY_OSM_ID.has('node/1644443078'), false);
  const dropped = IMPORT.excluded.find((e) => e.osmId === 'node/1644443078');
  assert.equal(dropped.reason, EXCLUSION_REASON.DUPLICATE_OF_POLYGON);
  assert.match(dropped.detail, /way\/1120154292/);
});

test('an unnamed footprint inside a named building is a part-mapping, not a second building', () => {
  // OSM holds RNS International School as one named 4-storey building AND as
  // two unnamed part-footprints tracing the same outline. Extruding all three
  // produces coplanar faces fighting for the same pixels (§6).
  for (const id of ['way/348134468', 'way/348135401']) {
    assert.equal(BY_OSM_ID.has(id), false, `${id} must not be rendered`);
    const dropped = IMPORT.excluded.find((e) => e.osmId === id);
    assert.equal(dropped.reason, EXCLUSION_REASON.SUPERSEDED_BY_ENCLOSING_BUILDING);
    assert.match(dropped.detail, /RNS International School/);
  }
  assert.ok(BY_OSM_ID.has('way/1224941276'), 'the named building survives');
});

test('same-named features far apart keep their labels; co-located ones do not (§13)', () => {
  // Three separate hostels really are all called "Hostel" in the source. They
  // are 89–102 m apart and each labels its own building — collapsing them would
  // hide two real buildings from an operator.
  const hostels = IMPORT.features.filter((f) => f.name === 'Hostel');
  assert.equal(hostels.length, 3);
  for (const h of hostels) {
    assert.equal(h.labelled, true, 'a distinct building keeps its own label');
    assert.match(h.metadata['Name in source'], /used by 3 separate features/);
  }

  // The two Canara Bank features are 58 m apart — one place, mapped as a
  // building and as a node. Both are kept and both stay clickable; only the
  // smaller one loses its label.
  const banks = IMPORT.features.filter((f) => f.name === 'Canara Bank');
  assert.equal(banks.length, 2, 'both features are kept — only a label was withheld');
  assert.equal(banks.filter((b) => b.labelled).length, 1);
  const suppressed = banks.find((b) => !b.labelled);
  assert.match(suppressed.metadata['Map label'], /Suppressed/);

  // The distance is what justified collapsing them, so pin it: the node and the
  // building really are within the de-duplication radius, and the three hostels
  // really are not.
  // Measured between LABEL ANCHORS — the same points the de-duplication and the
  // label layer use, so the test and the map agree on what "close" means.
  const node = banks.find((b) => b.geometry.type === 'Point');
  const building = banks.find((b) => b.geometry.type === 'Polygon');
  assert.ok(node && building);
  assert.ok(
    metresBetween(labelAnchorFor(node.geometry), labelAnchorFor(building.geometry)) <= LABEL_DEDUP_RADIUS_M
  );

  const anchors = hostels.map((h) => labelAnchorFor(h.geometry));
  for (let i = 0; i < anchors.length; i += 1) {
    for (let j = i + 1; j < anchors.length; j += 1) {
      assert.ok(
        metresBetween(anchors[i], anchors[j]) > LABEL_DEDUP_RADIUS_M,
        'the hostels are separate buildings, and the radius must not be widened until they are not'
      );
    }
  }
});

test('the label de-duplication radius is a campus-scale distance, not a coincidence', () => {
  assert.ok(LABEL_DEDUP_RADIUS_M > 0 && LABEL_DEDUP_RADIUS_M < 150);
});

// ── Label hierarchy (§14) ───────────────────────────────────────────────────

test('labels are banded so a campus overview is not covered in text', () => {
  const labelled = IMPORT.features.filter((f) => isLabelled(f));

  // The boundary is never labelled: its name belongs to the campus, which the
  // seeded centre point already carries at PRIMARY.
  assert.equal(labelled.some((f) => f.kind === CAMPUS_FEATURE_KIND.BOUNDARY), false);

  // Nothing imported claims the PRIMARY band — that is the campus's own.
  assert.equal(labelled.some((f) => f.labelPriority === LABEL_PRIORITY.PRIMARY), false);

  // Named buildings and major landmarks are readable from the overview.
  assert.equal(BY_OSM_ID.get('way/204638929').labelPriority, LABEL_PRIORITY.SECONDARY);
  assert.equal(BY_OSM_ID.get('way/204638938').labelPriority, LABEL_PRIORITY.SECONDARY, 'Shiva Temple');
  assert.equal(BY_OSM_ID.get('way/1224941277').labelPriority, LABEL_PRIORITY.SECONDARY, 'Basketball Court');

  // Small facilities — and small STRUCTURES — wait for close zoom. The Canara
  // Bank cabin is a 26 m² named building, tagged identically to a 2 269 m²
  // department block; footprint area is what keeps its label off the overview.
  assert.equal(BY_OSM_ID.get('way/204638933').labelPriority, LABEL_PRIORITY.DETAIL, 'Fountain');
  assert.equal(BY_OSM_ID.get('way/204638927').labelPriority, LABEL_PRIORITY.DETAIL, 'Canara Bank cabin');
  assert.equal(BY_OSM_ID.get('way/204638928').labelPriority, LABEL_PRIORITY.SECONDARY, '361 m² Canteen');

  // Roads and paths are unnamed in this dataset and must not print "Service
  // road" fifteen times across the campus.
  for (const f of IMPORT.features.filter((x) => x.kind === CAMPUS_FEATURE_KIND.ROAD || x.kind === CAMPUS_FEATURE_KIND.PATH)) {
    assert.equal(isLabelled(f), false, `${f.sourceId} would print a generic label`);
  }
});

// ── Rendering (§31, §32) ────────────────────────────────────────────────────

test('every feature reaches a source, and polygons never land in the circle layer', () => {
  // A landmark mapped as a polygon routed to the points source would render
  // NOTHING — a circle layer draws no circle for a polygon — and the feature
  // would silently vanish while looking configured.
  for (const f of IMPORT.features) {
    const role = sourceRoleFor(f);
    assert.ok(role, `${f.sourceId} (${f.kind}) reaches no source`);
    if (role === 'points') assert.equal(f.geometry.type, 'Point');
    if (role === 'lines') assert.match(f.geometry.type, /LineString/);
  }

  const def = resolveCampusDefinition(RNSIT_RECORD);
  const c = campusCollections(def);
  const total =
    c[CAMPUS_SOURCE.AREAS].features.length +
    c[CAMPUS_SOURCE.LINES].features.length +
    c[CAMPUS_SOURCE.POINTS].features.length;

  // Every feature is drawn EXCEPT the ones that deliberately surrender their
  // marker to a co-located neighbour — two markers on one coordinate are a
  // rendering artefact, not information (§5). Those are still campus features
  // and are still searchable; they simply have no dot of their own.
  const coLocated = def.features.filter((f) => f.rendersOwnMarker === false);
  assert.equal(coLocated.length, 1, 'exactly one co-located record in this dataset');
  assert.equal(coLocated[0].name, 'RNS Evening College');

  assert.equal(
    total,
    def.features.length - coLocated.length,
    'every campus feature must be drawn by some layer, unless it is co-located'
  );

  // The statue and the sports ground are polygons and belong with the areas.
  const areaIds = c[CAMPUS_SOURCE.AREAS].features.map((f) => f.id);
  assert.ok(areaIds.includes('osm-way-1224937858'), 'RN Shetty Statue');
  assert.ok(areaIds.includes('osm-way-151617521'), 'sports ground');
});

test('the clip source carries the campus boundary and only the campus boundary (§37)', () => {
  const c = campusCollections(resolveCampusDefinition(RNSIT_RECORD));
  const clip = c[CAMPUS_SOURCE.CLIP].features;

  assert.equal(clip.length, 1, 'a second polygon here would silently extend where the vendor is clipped');
  assert.equal(clip[0].properties.kind, CAMPUS_FEATURE_KIND.BOUNDARY);
  assert.deepEqual(clip[0].geometry, sourceById('way/1120154292').geometry);

  // An empty campus clips nothing at all — the basemap is untouched.
  assert.deepEqual(campusCollections({ features: [] })[CAMPUS_SOURCE.CLIP], {
    type: 'FeatureCollection',
    features: [],
  });
});

test('the vendor clip is scoped to the basemap, so it cannot clip our own buildings', () => {
  const clip = campusLayerSpecs().find((s) => s.type === 'clip');
  assert.ok(clip, 'the precedence mechanism must exist');
  assert.equal(clip.id, CAMPUS_LAYER.VENDOR_CLIP);
  assert.deepEqual(clip.layout['clip-layer-scope'], ['basemap']);
  assert.ok(clip.layout['clip-layer-types'].includes('model'), 'the vendor 3D buildings are the point');
  assert.ok(clip.minzoom >= 14, 'nothing to clip at city zoom');

  // It draws first, so everything the basemap renders is beneath it.
  const order = campusLayerSpecs().map((s) => s.id);
  assert.equal(order[0], CAMPUS_LAYER.VENDOR_CLIP);
});

test('a label is only emitted for a feature that is allowed one', () => {
  const c = campusCollections(resolveCampusDefinition(RNSIT_RECORD));
  const labels = c[CAMPUS_SOURCE.LABELS].features;
  const names = labels.map((f) => f.properties.name);

  assert.ok(names.includes('CSE, ISE & CSDS Department'));
  assert.ok(names.includes('RNSIT auditorium'));
  assert.equal(names.filter((n) => n === 'Canara Bank').length, 1, 'the co-located duplicate lost its label');
  assert.equal(names.filter((n) => n === 'Hostel').length, 3, 'three real buildings keep three labels');
  assert.equal(names.includes('Unnamed building'), false);
  assert.equal(names.includes('Service road'), false);

  // The boundary is in the areas source but never in the labels source.
  assert.ok(c[CAMPUS_SOURCE.AREAS].features.some((f) => f.properties.kind === CAMPUS_FEATURE_KIND.BOUNDARY));
  assert.equal(labels.some((f) => f.properties.kind === CAMPUS_FEATURE_KIND.BOUNDARY), false);
});

test('the extrusion reads renderHeight, and a feature with neither height draws flat', () => {
  const c = campusCollections(resolveCampusDefinition(RNSIT_RECORD));
  const props = c[CAMPUS_SOURCE.AREAS].features.find((f) => f.id === 'osm-way-204638929').properties;

  assert.equal(props.renderHeight, 10.5);
  assert.equal('height' in props, false, 'no measured height may reach the style');

  // The boundary and the sports ground carry no renderHeight, so the `has`
  // branch in the extrusion expression sends them to zero rather than guessing.
  const ground = c[CAMPUS_SOURCE.AREAS].features.find((f) => f.id === 'osm-way-151617521').properties;
  assert.equal('renderHeight' in ground, false);
});

// ── Search and click (§42, §43) ─────────────────────────────────────────────

test('the supplied campus names are searchable, and absent ones still are not', () => {
  const def = resolveCampusDefinition(RNSIT_RECORD);
  const index = buildCampusSearchIndex({ definition: def, robots: [] });

  const finds = (q) => searchCampusIndex(index, q).map((e) => e.name);

  assert.ok(finds('CSE').includes('CSE, ISE & CSDS Department'));
  assert.ok(finds('auditorium').includes('RNSIT auditorium'));
  assert.ok(finds('hostel').includes('Hostel'));
  assert.ok(finds('canteen').includes('Canteen'));
  assert.ok(finds('basketball').includes('Basketball Court'));
  assert.ok(finds('shiva').includes('Shiva Temple'));
  assert.ok(finds('mba').includes('RNSIT MBA block'));

  // A feature whose label was suppressed is still findable — the label was
  // withheld, the place was not.
  assert.ok(finds('canara').length >= 1);

  // The rule that has not changed: the index offers nothing it cannot locate.
  // RNSIT has a library; neither dataset maps it, so searching finds none.
  assert.deepEqual(finds('library'), []);
  assert.deepEqual(finds('Central Library'), []);

  // "main gate" DID return nothing when only the OSM extract existed — the
  // extract has no gate anywhere. The supplemental dataset supplies one, so the
  // correct answer changed with the data rather than with the search code.
  assert.deepEqual(finds('main gate'), ['RNSIT Main Gate Entrance']);
});

test('a clicked feature can answer with real data and nothing else', () => {
  const cse = BY_OSM_ID.get('way/204638929');

  // Present, because the source has them.
  assert.equal(cse.name, 'CSE, ISE & CSDS Department');
  assert.equal(cse.metadata['Levels'], '3 (OpenStreetMap building:levels)');
  assert.equal(cse.metadata['OSM element'], 'way/204638929');

  // Absent, because the source does not have them — and no placeholder was
  // substituted to make the card look complete (§43).
  for (const invented of ['Floors', 'Capacity', 'Department head', 'Built', 'Construction year', 'Rooms']) {
    assert.equal(cse.metadata[invented], undefined, `${invented} is not in the data and must not be in the card`);
  }
});

// ── The report (§61) ────────────────────────────────────────────────────────

test('the dataset summary matches the artefact it describes', () => {
  const s = describeOsmImport(RNSIT_CAMPUS_OSM);

  assert.equal(s.sourceFeatures, RNSIT_CAMPUS_OSM.features.length);
  assert.equal(s.imported + s.excluded, s.sourceFeatures);
  assert.deepEqual(s.sourceGeometryTypes, { Polygon: 31, LineString: 24, Point: 2 });
  assert.equal(s.boundary, 1);
  assert.equal(s.withMeasuredHeight, 0, 'the headline fact about this dataset');
  assert.equal(s.withoutMeasuredHeight, s.buildings);
  assert.ok(s.namedBuildings > 0 && s.unnamedBuildings > 0);
  assert.equal(s.namedBuildings + s.unnamedBuildings, s.buildings);
});
