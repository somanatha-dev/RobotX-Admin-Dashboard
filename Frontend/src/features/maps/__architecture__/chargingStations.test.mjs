/**
 * CHARGING STATIONS ON THE MAP — state, anchoring, approval, and the layer lifecycle.
 *
 *   node --test src/features/maps/__architecture__/chargingStations.test.mjs
 *
 * Coordinates and approval come from the owner's declaration file
 * (`docs/runbooks/simulated-charging-stations.example.json`), read as data — nothing here is a
 * coordinate typed into a test. The report shapes are the backend's
 * (`SimulationEngine.chargingOverview`, `simulator.controller`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  STATION_PARTS,
  STATION_STATE,
  STATION_STATE_META,
  stationModelFeatures,
  stationStateOf,
  stationStatusLine,
  stationSummaries,
} from '../charging/stationModel.js';
import { stationFeatures } from '../charging/chargingGeoJson.js';
import {
  CHARGING_INTERACTIVE_LAYERS,
  CHARGING_LAYER,
  CHARGING_LAYER_ORDER,
  CHARGING_SOURCE,
  STATE_COLOR_EXPR,
  chargingLayerSpecs,
  chargingOverlayData,
  installChargingLayers,
  removeChargingLayers,
  setChargingData,
} from '../charging/stationLayers.js';
import { STATION_ICON_ID, boltIconImage } from '../charging/stationIcon.js';
import { createFakeMapboxMap } from './helpers/fakeMapboxMap.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const declaration = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/runbooks/simulated-charging-stations.example.json'), 'utf8'));
const PU = declaration.stations.find((s) => s.chargerId === 'RNSIT-CHG-PU-COLLEGE');
const CANARA = declaration.stations.find((s) => s.chargerId === 'RNSIT-CHG-CANARA-BANK');

/** The report the backend builds for the declaration: PU usable, Canara declared-only. */
function report({ puActive = 0, puQueued = 0, robots = [] } = {}) {
  return {
    charging: {
      provenance: 'DEVELOPMENT_SIMULATION',
      stations: [
        { chargerId: 'V1DEMO-DEPOT-01', name: 'Depot', isDepot: true, approved: true, usable: true, lat: 12.900729, lon: 77.517603, problems: [], plugCount: 3, active: 0, queued: 0 },
        { chargerId: PU.chargerId, name: PU.name, isDepot: false, approved: PU.approved, usable: true, lat: PU.lat, lon: PU.lon, declaredLat: PU.lat, declaredLon: PU.lon, problems: [], plugCount: PU.plugCount, active: puActive, queued: puQueued },
        { chargerId: CANARA.chargerId, name: CANARA.name, isDepot: false, approved: CANARA.approved, usable: false, lat: null, lon: null, declaredLat: CANARA.lat, declaredLon: CANARA.lon, problems: [{ code: 'NOT_APPROVED' }], plugCount: null, active: 0, queued: 0 },
      ],
    },
    robots,
  };
}

test('the declaration is what the tests assume: PU College approved, Canara Bank not', () => {
  assert.equal(PU.approved, true);
  assert.equal(CANARA.approved, false);
});

test('state: PU College available; Canara Bank INACTIVE at its declared coordinate — never an operational colour', () => {
  const status = report();
  const [, pu, canara] = status.charging.stations;
  assert.equal(stationStateOf(pu), STATION_STATE.AVAILABLE);
  assert.equal(stationStateOf(canara), STATION_STATE.INACTIVE);
  assert.equal(STATION_STATE_META.INACTIVE.operational, false);
  assert.equal(stationStatusLine(canara), 'Inactive — not approved');

  const byId = new Map(stationFeatures(status).features.map((f) => [f.properties.chargerId, f]));
  assert.deepEqual(byId.get(CANARA.chargerId).geometry.coordinates, [CANARA.lon, CANARA.lat], 'declared coordinate, verbatim');
  assert.equal(byId.get(CANARA.chargerId).properties.state, STATION_STATE.INACTIVE);
  assert.equal(byId.get(CANARA.chargerId).properties.pulse, false);
  assert.deepEqual(byId.get(PU.chargerId).geometry.coordinates, [PU.lon, PU.lat], 'operational coordinate, verbatim');

  // The colour expression maps INACTIVE to the inactive grey, and no operational state shares it.
  const pairs = new Map();
  for (let i = 2; i < STATE_COLOR_EXPR.length - 1; i += 2) pairs.set(STATE_COLOR_EXPR[i], STATE_COLOR_EXPR[i + 1]);
  assert.equal(pairs.get('INACTIVE'), STATION_STATE_META.INACTIVE.color);
  for (const s of ['AVAILABLE', 'OCCUPIED', 'QUEUED']) assert.notEqual(pairs.get(s), pairs.get('INACTIVE'));
});

test('an approved station that the backend cannot use is UNAVAILABLE with its reasons, never INACTIVE or operational', () => {
  const s = { chargerId: 'X', name: 'X', approved: true, usable: false, declaredLat: 12.9, declaredLon: 77.5, problems: [{ code: 'NOT_REACHABLE' }] };
  assert.equal(stationStateOf(s), STATION_STATE.UNAVAILABLE);
  assert.equal(stationStatusLine(s), 'Unavailable — NOT_REACHABLE');
  // A station with no coordinate at all is listed but not placed.
  const unplaced = { chargerId: 'Y', name: 'Y', approved: false, usable: false, problems: [{ code: 'NOT_APPROVED' }, { code: 'NO_COORDINATE' }] };
  const [summary] = stationSummaries({ charging: { stations: [unplaced] } });
  assert.equal(summary.lngLat, null);
  assert.equal(summary.positionKind, 'NONE');
  assert.equal(stationModelFeatures({ charging: { stations: [unplaced] } }).features.length, 0);
});

test('occupancy and the activity ring follow the report: a granted plug is "in use"; the ring only while a robot CHARGES there', () => {
  // Plug granted, robot still driving to it.
  const approaching = report({ puActive: 1, robots: [{ robotId: 'SIM-1', charging: { phase: 'APPROACHING', stationId: PU.chargerId, reservationState: 'ACTIVE' } }] });
  const pu1 = stationFeatures(approaching).features.find((f) => f.properties.chargerId === PU.chargerId).properties;
  assert.equal(pu1.state, STATION_STATE.OCCUPIED);
  assert.equal(pu1.pulse, false, 'no "charging" animation for a robot that has not arrived');
  assert.equal(pu1.status, '1/1 plug in use');

  // Docked and charging, one more queued.
  const charging = report({
    puActive: 1,
    puQueued: 1,
    robots: [
      { robotId: 'SIM-1', charging: { phase: 'CHARGING', stationId: PU.chargerId } },
      { robotId: 'SIM-2', charging: { phase: 'WAITING', stationId: PU.chargerId, reservationState: 'QUEUED' } },
    ],
  });
  const pu2 = stationFeatures(charging).features.find((f) => f.properties.chargerId === PU.chargerId).properties;
  assert.equal(pu2.state, STATION_STATE.QUEUED);
  assert.equal(pu2.pulse, true);
  assert.equal(pu2.chargingNow, 1);
  assert.equal(pu2.status, '1/1 plug in use · 1 charging · 1 queued');

  // Charging ends: the ring goes with it.
  const done = report({ puActive: 0, robots: [{ robotId: 'SIM-1', charging: null }] });
  assert.equal(stationFeatures(done).features.find((f) => f.properties.chargerId === PU.chargerId).properties.pulse, false);
});

test('the 3D installation is anchored on the station coordinate and stays a few metres across', () => {
  const { features } = stationModelFeatures(report());
  const pu = features.filter((f) => f.properties.chargerId === PU.chargerId);
  assert.equal(pu.length, STATION_PARTS.length);
  const pad = pu.find((f) => f.properties.part === 'pad');
  const ring = pad.geometry.coordinates[0];
  const xs = ring.map((p) => p[0]);
  const ys = ring.map((p) => p[1]);
  const centre = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
  const mPerLng = 111320 * Math.cos((PU.lat * Math.PI) / 180);
  assert.ok(Math.abs(centre[0] - PU.lon) * mPerLng < 0.01 && Math.abs(centre[1] - PU.lat) * 111320 < 0.01, 'pad centred on the coordinate to the centimetre');
  for (const f of pu) {
    for (const r of f.geometry.coordinates) {
      assert.deepEqual(r[0], r[r.length - 1], `${f.properties.part}: closed ring`);
      for (const [lng, lat] of r) {
        assert.ok(Math.hypot((lng - PU.lon) * mPerLng, (lat - PU.lat) * 111320) < 4, `${f.properties.part}: within 4 m of the anchor`);
      }
    }
    assert.ok(f.properties.height > f.properties.base, `${f.properties.part}: positive extrusion`);
    assert.ok(f.properties.height <= 3, `${f.properties.part}: a miniature, not a building`);
  }
  // The bay's inner ring winds opposite to its outer ring — a hole, not a second polygon.
  const bay = pu.find((f) => f.properties.part === 'bay').geometry.coordinates;
  const area = (r) => r.slice(0, -1).reduce((a, [x1, y1], i) => a + x1 * r[i + 1][1] - r[i + 1][0] * y1, 0);
  assert.ok(Math.sign(area(bay[0])) === -Math.sign(area(bay[1])));
});

test('feature identity is stable across report refreshes (no flicker, feature-state survives)', () => {
  const a = stationFeatures(report()).features.map((f) => f.id);
  const b = stationFeatures(report({ puActive: 1 })).features.map((f) => f.id);
  assert.deepEqual(a, b);
  assert.deepEqual(a, ['V1DEMO-DEPOT-01', PU.chargerId, CANARA.chargerId]);
  const map = createFakeMapboxMap({ loaded: true });
  installChargingLayers(map, { data: chargingOverlayData(report()) });
  assert.equal(map.getSource(CHARGING_SOURCE.STATIONS).spec.promoteId, 'chargerId');
});

test('install before the style loads installs nothing and reports it; the style.load install adds everything once', () => {
  const map = createFakeMapboxMap({ loaded: false });
  const early = installChargingLayers(map, { data: chargingOverlayData(report()) });
  assert.equal(early.installed, 0);
  assert.deepEqual(early.missing, [...CHARGING_LAYER_ORDER]);
  map.on('style.load', () => installChargingLayers(map, { data: chargingOverlayData(report()) }));
  map.finishStyleLoad();
  assert.deepEqual(map.layerIds(), [...CHARGING_LAYER_ORDER]);
  assert.deepEqual(map.imageIds(), [STATION_ICON_ID]);
  assert.deepEqual(map.errors, []);
});

test('repeated install is idempotent; a style reload restores exactly one copy, with data and the icon', () => {
  const map = createFakeMapboxMap({ loaded: true });
  const data = chargingOverlayData(report({ puActive: 1 }));
  for (let i = 0; i < 3; i += 1) installChargingLayers(map, { data });
  assert.deepEqual(map.layerIds(), [...CHARGING_LAYER_ORDER]);
  assert.deepEqual(map.errors, []);

  map.setStyle();
  assert.equal(map.layerIds().length, 0);
  map.finishStyleLoad();
  installChargingLayers(map, { data });
  assert.deepEqual(map.layerIds(), [...CHARGING_LAYER_ORDER]);
  assert.equal(map.getSource(CHARGING_SOURCE.STATIONS).data.features.length, 3, 'reinstalled with the latest report');
  assert.deepEqual(map.imageIds(), [STATION_ICON_ID]);

  // A report refresh is setData only — no layer is removed or re-added.
  const before = map.layerIds();
  setChargingData(map, chargingOverlayData(report({ puActive: 0 })));
  assert.deepEqual(map.layerIds(), before);
  assert.equal(map.getSource(CHARGING_SOURCE.MODEL).setDataCalls, 1);

  removeChargingLayers(map);
  assert.deepEqual(map.layerIds(), []);
  assert.deepEqual(map.sourceIds(), []);
});

test('layer specs: zoom hand-off badge → model, labels on top of the stack, every interactive layer exists', () => {
  const specs = new Map(chargingLayerSpecs().map((s) => [s.id, s]));
  assert.equal(specs.get(CHARGING_LAYER.BADGE).maxzoom, 18);
  assert.ok(specs.get(CHARGING_LAYER.MODEL).minzoom < specs.get(CHARGING_LAYER.BADGE).maxzoom, 'the two forms overlap — a cross-fade, not a pop');
  assert.equal(specs.get(CHARGING_LAYER.MODEL).type, 'fill-extrusion');
  assert.equal(specs.get(CHARGING_LAYER.LIGHT).paint['fill-extrusion-emissive-strength'], 1);
  assert.deepEqual(specs.get(CHARGING_LAYER.PULSE).filter, ['==', ['get', 'pulse'], true]);
  for (const id of CHARGING_INTERACTIVE_LAYERS) assert.ok(specs.has(id), id);
  assert.equal(CHARGING_LAYER_ORDER.at(-1), CHARGING_LAYER.LABEL);
  // Theme-aware label colours.
  const night = chargingLayerSpecs({ labels: { color: '#e6edf7', halo: '#060d18', haloWidth: 2.1, secondaryColor: '#9fb0c8' } });
  const label = night.find((s) => s.id === CHARGING_LAYER.LABEL).paint;
  assert.equal(label['text-halo-color'], '#060d18');
});

test('the bolt icon is generated, not fetched: transparent corners, opaque white body', () => {
  const img = boltIconImage(40);
  assert.equal(img.width, 40);
  assert.equal(img.data.length, 40 * 40 * 4);
  const px = (x, y) => Array.from(img.data.slice((y * 40 + x) * 4, (y * 40 + x) * 4 + 4));
  assert.equal(px(0, 0)[3], 0);
  assert.equal(px(39, 39)[3], 0);
  const opaqueWhite = [];
  for (let i = 0; i < img.data.length; i += 4) if (img.data[i] === 255 && img.data[i + 3] > 200) opaqueWhite.push(i);
  assert.ok(opaqueWhite.length > 60);
});

test('on a terrain map the model keeps its stated heights (browser-observed 2 m roof minimum)', () => {
  // Observed in headless Chrome against mapbox-gl 3.20 with terrain on (2026-10-13): the default
  // `fill-extrusion-height-alignment: 'flat'` raises every roof to at least base + 2 m, so the
  // 0.22 m light strip drew as a 2 m wall and the awning as a block hiding the pillar and posts.
  // Every extrusion layer of the station model must ask for exact (terrain-relative) heights.
  const extrusions = chargingLayerSpecs().filter((s) => s.type === 'fill-extrusion');
  assert.deepEqual(extrusions.map((s) => s.id).sort(), [CHARGING_LAYER.LIGHT, CHARGING_LAYER.MODEL].sort());
  for (const spec of extrusions) {
    assert.equal(spec.paint['fill-extrusion-height-alignment'], 'terrain', `${spec.id}: height alignment`);
    assert.equal(spec.paint['fill-extrusion-base-alignment'], 'terrain', `${spec.id}: base alignment`);
  }
  // Parts that float (base > 0) are exactly the ones the 2 m minimum distorted.
  assert.ok(STATION_PARTS.some((p) => p.base > 0 && p.height - p.base < 2));
});
