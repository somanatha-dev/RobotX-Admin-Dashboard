/**
 * Visual campus areas — a reading aid built only from verified outlines, never an alert zone.
 *
 *   · every area is a feature the campus dataset holds WITH a polygon, its geometry untouched;
 *   · names come from the source (the unnamed cricket/football ground stays "Sports ground",
 *     although "Playground" points exist elsewhere);
 *   · what the data lacks is stated (no Library; point-only playgrounds; two "Canteen"s);
 *   · the areas are their own layers, below the campus roads, and the alert-zone layers and
 *     legend keep them separate;
 *   · rules read classification, not a campus id — JSSATE's data goes through the same rules.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveCampusDefinition } from '../campus/campusRegistry.js';
import {
  AREA_GROUP,
  areaFeatureCollection,
  areaFor,
  areaLabelCollection,
  areaLegendRows,
  campusAreasFor,
  missingAreaNotes,
} from '../dtaro/campusAreas.js';
import { DTARO_LAYER, DTARO_SOURCE, installDtaroLayers } from '../dtaro/dtaroLayers.js';
import { createFakeMapboxMap } from './helpers/fakeMapboxMap.mjs';

const RNSIT = resolveCampusDefinition({ code: 'RNSIT', name: 'RNS Institute of Technology', centerLat: 12.9023, centerLon: 77.5186 });
const JSSATE = resolveCampusDefinition({ code: 'jssate-bengaluru', name: 'JSS Academy', centerLat: 12.9027, centerLon: 77.505 });
const AREAS = campusAreasFor(RNSIT);

test('every area is a source feature with a polygon outline, geometry unchanged', () => {
  assert.ok(AREAS.length > 0);
  for (const area of AREAS) {
    const source = RNSIT.features.find((f) => `area/${f.id}` === area.key);
    assert.ok(source, `${area.key} comes from the dataset`);
    assert.ok(/Polygon/.test(source.geometry.type));
    assert.equal(area.geometry, source.geometry, 'the outline is the source outline, not a copy or a buffer');
  }
  // No point ever becomes an area.
  assert.ok(AREAS.every((a) => a.geometry.type !== 'Point'));
});

test('RNSIT areas, by the source names: sports ground, two canteens, main building, hostels, parking', () => {
  const byGroup = (group) => AREAS.filter((a) => a.group === group).map((a) => [a.label, a.sourceId]);
  assert.deepEqual(byGroup(AREA_GROUP.SPORTS), [['Sports ground', 'way/151617521'], ['Basketball Court', 'way/1224941277']]);
  assert.deepEqual(byGroup(AREA_GROUP.FOOD).map(([l]) => l), ['Canteen', 'Canteen']);
  assert.deepEqual(byGroup(AREA_GROUP.MAIN), [['Main Building', 'way/204638937']]);
  assert.equal(byGroup(AREA_GROUP.HOUSING).length, 3);
  assert.equal(byGroup(AREA_GROUP.PARKING).length, 3);
  // Academic blocks are tinted, not re-labelled: the campus layer names them already.
  assert.ok(AREAS.filter((a) => a.group === AREA_GROUP.ACADEMIC).every((a) => a.label === null));
  // Nothing is called a playground or a library.
  assert.ok(AREAS.every((a) => !/playground|library/i.test(a.label || '')));
});

test('missing data is stated, not drawn', () => {
  assert.deepEqual(missingAreaNotes(RNSIT), [
    'Library — not in this campus’s data',
    'Playgrounds — 2 verified points, no outline',
    '2 separate buildings are named “Canteen” in the source data',
  ]);
});

test('same rules, other campus: JSSATE’s own playground and cricket ground are areas there', () => {
  const jss = campusAreasFor(JSSATE);
  const sports = jss.filter((a) => a.group === AREA_GROUP.SPORTS).map((a) => a.label).sort();
  assert.deepEqual(sports, ['JSS College Play ground', 'JSSATEB Cricket Ground']);
  assert.ok(jss.every((a) => !RNSIT.features.some((f) => `area/${f.id}` === a.key)), 'no RNSIT feature in JSSATE');
  assert.ok(!missingAreaNotes(JSSATE).some((n) => /Playgrounds/.test(n)), 'JSSATE has a playground outline');
});

test('features that are not areas stay out', () => {
  assert.equal(areaFor({ kind: 'BOUNDARY', category: 'OPERATIONAL', name: 'RNS Institute of Technology', geometry: { type: 'Polygon', coordinates: [] } }), null);
  assert.equal(areaFor({ kind: 'BUILDING', category: 'UNCLASSIFIED', name: 'Unnamed building', geometry: { type: 'Polygon', coordinates: [] } }), null);
  assert.equal(areaFor({ kind: 'FACILITY', category: 'SPORTS', name: 'Pitch', geometry: { type: 'Point', coordinates: [77, 12] } }), null);
});

test('legend rows count outlines per group; labels only where a name is shown', () => {
  const rows = areaLegendRows(AREAS);
  assert.deepEqual(
    rows.map((r) => [r.label, r.count]),
    [['Sports', 2], ['Canteen', 2], ['Main Building', 1], ['Auditorium', 2], ['Hostels', 3], ['Parking', 3], ['Academic blocks', 6]],
  );
  const labels = areaLabelCollection(AREAS);
  assert.equal(labels.features.length, AREAS.filter((a) => a.label).length);
  assert.equal(areaFeatureCollection(AREAS).features.length, AREAS.length);
});

test('areas are their own layers: tint beneath the campus roads, labels hand over to the campus labels', () => {
  const map = createFakeMapboxMap({ loaded: true });
  map.addSource('campus', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  for (const id of ['robotx-campus-ground-fill', 'robotx-campus-road-main-casing', 'robotx-campus-label-p1']) {
    map.addLayer({ id, type: id.includes('label') ? 'symbol' : 'fill', source: 'campus' });
  }
  installDtaroLayers(map);
  const ids = map.layerIds();
  const at = (id) => ids.indexOf(id);
  assert.ok(at(DTARO_LAYER.AREA_FILL) < at('robotx-campus-road-main-casing'));
  assert.ok(at(DTARO_LAYER.AREA_FILL) > at(DTARO_LAYER.ZONE_FILL), 'areas over the zone tint');
  assert.ok(at(DTARO_LAYER.ZONE_LINE) > at(DTARO_LAYER.AREA_LINE), 'the alert-zone outline is drawn over area outlines');
  assert.ok(at(DTARO_LAYER.AREA_LABEL) > at('robotx-campus-label-p1'));
  assert.ok(map.getSource(DTARO_SOURCE.AREAS) && map.getSource(DTARO_SOURCE.AREA_LABELS));
  const areaLabel = map.getLayer(DTARO_LAYER.AREA_LABEL);
  assert.equal(areaLabel.maxzoom, 17.4, 'the campus layer names buildings from ~17.4');
  assert.deepEqual(map.errors, []);
});
