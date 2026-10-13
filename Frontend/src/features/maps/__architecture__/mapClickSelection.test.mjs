/**
 * Station-versus-building click selection on the operations map.
 *
 * One map click reaches two listeners — the charging layer's and the campus layer's — and Mapbox
 * runs them in registration order, which neither layer controls. A charging station stands on
 * campus ground and beside buildings, so a click can hit both. The rule
 * (`mapControl/stationClickArbiter.js`): a station hit selects the station and NOT the feature
 * underneath; a click without a station hit selects (or clears) the campus feature and clears
 * the station.
 *
 * Driven with the real layer installs (`installChargingLayers`, `installSourcesAndLayers`), the
 * real hit tests (`stationIdAtPoint`, `campusFeatureAtPoint`) and the real arbiter, on the fake
 * Mapbox map. Its `queryRenderedFeatures` is scripted per point and honours the `layers`
 * option, as Mapbox's does — so each hit test only sees the layers it asks for.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFakeMapboxMap } from './helpers/fakeMapboxMap.mjs';
import { CHARGING_LAYER, chargingOverlayData, installChargingLayers, stationIdAtPoint } from '../charging/stationLayers.js';
import { campusFeatureAtPoint, installSourcesAndLayers } from '../campus/useCampusLayer.js';
import { CAMPUS_LAYER } from '../campus/campusLayers.js';
import { createStationClickArbiter } from '../mapControl/stationClickArbiter.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAPS = path.resolve(HERE, '..');

const PU = 'RNSIT-CHG-PU-COLLEGE';
const REPORT = {
  robots: [],
  charging: {
    stations: [
      { chargerId: PU, name: 'Near RNSIT PU College building', isDepot: false, approved: true, usable: true, lat: 12.900742024769887, lon: 77.51884060360668, problems: [], plugCount: 1, active: 0, queued: 0 },
    ],
  },
};
const DEFINITION = { features: [{ id: 'BLDG-PU', name: 'PU College block', kind: 'building' }] };

// What is rendered under each click point (`x,y`), by layer.
const SCENE = {
  '10,10': [
    { layer: CHARGING_LAYER.BADGE, properties: { chargerId: PU } }, // the station…
    { layer: CAMPUS_LAYER.BUILDINGS, properties: { id: 'BLDG-PU' } }, // …standing on the building
  ],
  '20,20': [{ layer: CAMPUS_LAYER.BUILDINGS, properties: { id: 'BLDG-PU' } }], // the building alone
  '30,30': [], // open ground, nothing identifiable
};

/** The map, both layers installed, and the two click listeners registered in `order`. */
function setup(order) {
  const map = createFakeMapboxMap({ loaded: true });
  installSourcesAndLayers(map);
  installChargingLayers(map, { data: chargingOverlayData(REPORT) });
  map.queryRenderedFeatures = (point, options = {}) => {
    const hits = SCENE[`${point.x},${point.y}`] || [];
    const wanted = Array.isArray(options.layers) ? new Set(options.layers) : null;
    return hits
      .filter((h) => !wanted || wanted.has(h.layer))
      .filter((h) => map.getLayer(h.layer))
      .map((h) => ({ layer: { id: h.layer }, properties: h.properties }));
  };

  const state = { station: null, feature: null };
  const arbiter = createStationClickArbiter({
    selectStation: (id) => {
      state.station = id;
    },
    selectFeature: (feature) => {
      state.feature = feature;
    },
  });
  // Exactly what the two hooks register (asserted in the wiring test below).
  const stationListener = (event) => arbiter.station(stationIdAtPoint(map, event.point));
  const campusListener = (event) => arbiter.feature(campusFeatureAtPoint(map, event.point, DEFINITION));
  for (const which of order) map.on('click', which === 'station' ? stationListener : campusListener);

  const click = async (x, y) => {
    map.fire('click', { point: { x, y } });
    await Promise.resolve(); // the dispatch has ended: the claim's microtask has run
  };
  return { map, state, click };
}

for (const order of [['station', 'campus'], ['campus', 'station']]) {
  const label = order.join(' → ');

  test(`[${label}] a click on a station selects the station, not the building underneath`, async () => {
    const { state, click } = setup(order);
    await click(10, 10);
    assert.equal(state.station, PU);
    assert.equal(state.feature, null);
  });

  test(`[${label}] a station click clears a building that was selected before`, async () => {
    const { state, click } = setup(order);
    await click(20, 20);
    assert.equal(state.feature?.id, 'BLDG-PU');
    await click(10, 10);
    assert.equal(state.station, PU);
    assert.equal(state.feature, null);
  });

  test(`[${label}] a click on a building alone selects the building and clears the station`, async () => {
    const { state, click } = setup(order);
    await click(10, 10);
    assert.equal(state.station, PU);
    await click(20, 20);
    assert.equal(state.station, null);
    assert.deepEqual(state.feature, { id: 'BLDG-PU', name: 'PU College block', kind: 'building', isVendor: false });
  });

  test(`[${label}] a click on open ground clears both`, async () => {
    const { state, click } = setup(order);
    await click(20, 20);
    await click(30, 30);
    assert.equal(state.station, null);
    assert.equal(state.feature, null);
  });
}

test('without the station layers (style still loading) a click falls through to the campus answer', async () => {
  const { map, state, click } = setup(['station', 'campus']);
  for (const id of Object.values(CHARGING_LAYER)) map.removeLayer(id);
  await click(10, 10);
  assert.equal(state.station, null);
  assert.equal(state.feature?.id, 'BLDG-PU');
});

test('wiring: the page uses the arbiter, and both hooks answer clicks with these hit tests', () => {
  const control = fs.readFileSync(path.join(MAPS, 'MapControl.jsx'), 'utf8');
  // Created once, as lazy state, from the two selection setters.
  assert.match(control, /useState\(\(\) =>\s*createStationClickArbiter\(\{\s*selectStation: setSelectedStationId,\s*selectFeature: setSelectedFeature,\s*\}\)\s*\)/);
  assert.match(control, /const onSelectStation = clickArbiter\.station;\s*const onSelectCampusFeature = clickArbiter\.feature;/);
  assert.match(control, /onSelectFeature: onSelectCampusFeature,/);
  assert.match(control, /useChargingLayer\(mapRef, \{[\s\S]*?onSelectStation,[\s\S]*?\}\)/);

  const charging = fs.readFileSync(path.join(MAPS, 'charging/useChargingLayer.js'), 'utf8');
  assert.match(charging, /const onClick = \(event\) => onSelectRef\.current\?\.\(stationIdAtPoint\(map, event\.point\)\);/);
  const campus = fs.readFileSync(path.join(MAPS, 'campus/useCampusLayer.js'), 'utf8');
  assert.match(campus, /handler\(campusFeatureAtPoint\(map, event\.point, definitionRef\.current\)\);/);
});
