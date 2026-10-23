/**
 * DTARO zones and obstacle layers on the map.
 *
 *   · Live zones come only from the backend's published zone map, scoped to the selected
 *     campus's region; a reused zone label in another region never leaks in; a campus with no
 *     region, or no data, draws nothing and says why.
 *   · The four-zone proposal is a PREVIEW: its own kind, labelled as a proposal, dashed, its 14
 *     tied cells left without a zone — and never part of the live set.
 *   · Layers install once per style load, below the campus roads (tint) and above them
 *     (labels, obstacles); reinstalling after a style reload restores exactly one copy.
 *   · An obstacle marker carries no severity: severity is advisory and is not drawn as a class.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ZONE_KIND,
  ZONE_STATUS,
  liveZonesForCampus,
  previewZonesForCampus,
  previewCellCollection,
  previewLabelsClearOf,
  PREVIEW_LABEL_CLEARANCE,
  PREVIEW_PALETTE,
  ZONE_PALETTE,
  zoneAtPoint,
  zoneEdgeCollection,
  zoneFeatureCollection,
  zoneLabel,
  zoneLabelCollection,
  zoneStatusSentence,
  zoneTextColor,
} from '../dtaro/zoneModel.js';
import {
  DTARO_LAYER,
  DTARO_LAYER_ORDER,
  DTARO_SOURCE,
  footprintCollection,
  installDtaroLayers,
  obstacleCollection,
  partiesCollection,
  removeDtaroLayers,
  setDtaroData,
} from '../dtaro/dtaroLayers.js';
import { RNSIT_ZONE_PROPOSAL_PREVIEW } from '../dtaro/rnsitZoneProposalPreview.js';
import { topDownCameraForBounds } from '../camera/cameraModes.js';
import { createFakeMapboxMap } from './helpers/fakeMapboxMap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const source = (rel) => fs.readFileSync(path.resolve(HERE, rel), 'utf8');

const square = (lon, lat, d = 0.001) => ({
  type: 'MultiPolygon',
  coordinates: [[[[lon, lat], [lon + d, lat], [lon + d, lat + d], [lon, lat + d], [lon, lat]]]],
});

// The backend's `/api/dtaro/zones` answer: RNSIT's one published zone, and a second region
// whose zone deliberately reuses the label "rnsit-z1".
const VIEW = Object.freeze({
  available: true,
  alertsEnabled: true,
  source: 'PUBLISHED_MAP',
  spatialVersion: 1,
  regions: [
    { id: 'row-rnsit', regionKey: 'rnsit', name: 'RNSIT' },
    { id: 'row-other', regionKey: 'other-region', name: 'Other' },
  ],
  zones: [
    { key: 'row-rnsit/rnsit-z1', regionId: 'row-rnsit', regionKey: 'rnsit', zoneId: 'rnsit-z1', name: 'RNSIT Zone 1', cellCount: 64, geometry: square(77.518, 12.9) },
    { key: 'row-other/rnsit-z1', regionId: 'row-other', regionKey: 'other-region', zoneId: 'rnsit-z1', name: 'RNSIT Zone 1', cellCount: 7, geometry: square(77.505, 12.9) },
  ],
});

// ── Live zones ───────────────────────────────────────────────────────────────

test('live zones: one campus, its own region only — a reused label in another region does not leak in', () => {
  const live = liveZonesForCampus(VIEW, 'rnsit');
  assert.equal(live.status, ZONE_STATUS.READY);
  assert.deepEqual(live.zones.map((z) => z.key), ['row-rnsit/rnsit-z1']);
  assert.deepEqual(live.regionIds, ['row-rnsit']);
  assert.equal(live.zones[0].kind, ZONE_KIND.LIVE);
  // Keyed by region AND zone: the two "rnsit-z1" zones are different keys.
  const other = liveZonesForCampus(VIEW, 'other-region');
  assert.deepEqual(other.zones.map((z) => z.key), ['row-other/rnsit-z1']);
  assert.notEqual(other.zones[0].key, live.zones[0].key);
});

test('missing zone data: every empty case is a stated status, never invented geometry', () => {
  assert.equal(liveZonesForCampus(null, 'rnsit').status, ZONE_STATUS.LOADING);
  assert.equal(liveZonesForCampus({ available: false, alertsEnabled: false, error: 'HTTP 403' }, 'rnsit').status, ZONE_STATUS.LOAD_FAILED);
  assert.equal(liveZonesForCampus({ available: false, alertsEnabled: true, zones: [] }, 'rnsit').status, ZONE_STATUS.UNAVAILABLE);
  assert.equal(liveZonesForCampus(VIEW, 'rnsit', { campusSelected: false }).status, ZONE_STATUS.NO_CAMPUS);
  // JSSATE has no operating region: nothing, not the nearest region's zones.
  assert.equal(liveZonesForCampus(VIEW, null).status, ZONE_STATUS.NO_REGION);
  assert.equal(liveZonesForCampus(VIEW, 'unpublished-region').status, ZONE_STATUS.NO_ZONES);
  // Every empty case explains itself: an empty map with no reason is the failure the operator saw
  // (2026-10-22: the alert switch was off, the zone map was gated on it, and nothing said so).
  for (const status of Object.values(ZONE_STATUS)) {
    if (status === ZONE_STATUS.READY) assert.equal(zoneStatusSentence(status), null);
    else assert.equal(typeof zoneStatusSentence(status), 'string', status);
  }
  assert.deepEqual(liveZonesForCampus({ available: false, error: 'NETWORK' }, 'rnsit').zones, []);
  assert.deepEqual(liveZonesForCampus({ available: false }, 'rnsit').zones, []);
});

test('alerts off does not hide the published map: same zones either way', () => {
  const on = liveZonesForCampus(VIEW, 'rnsit');
  const off = liveZonesForCampus({ ...VIEW, alertsEnabled: false }, 'rnsit');
  assert.equal(off.status, ZONE_STATUS.READY);
  assert.deepEqual(off.zones, on.zones);
});

test('one published zone stays one zone — nothing is added to make the map look fuller', () => {
  const live = liveZonesForCampus(VIEW, 'rnsit');
  assert.equal(live.zones.length, 1);
  assert.equal(zoneFeatureCollection(live.zones).features.length, 1);
});

// ── Proposal preview ────────────────────────────────────────────────────────

test('the proposal preview is the validated G4 proposal: not approved, not published, four zones, every cell owned', () => {
  assert.equal(RNSIT_ZONE_PROPOSAL_PREVIEW.approved, false);
  assert.equal(RNSIT_ZONE_PROPOSAL_PREVIEW.published, false);
  assert.equal(RNSIT_ZONE_PROPOSAL_PREVIEW.layout, 'G4');
  assert.equal(RNSIT_ZONE_PROPOSAL_PREVIEW.validated, true);
  const preview = previewZonesForCampus(RNSIT_ZONE_PROPOSAL_PREVIEW, 'RNSIT');
  assert.ok(preview);
  assert.equal(preview.layout, 'G4');
  assert.deepEqual(preview.zones.map((z) => z.zoneId), ['rnsit-z-west', 'rnsit-z-east', 'rnsit-z-south', 'rnsit-z-southwest']);
  for (const zone of preview.zones) {
    assert.equal(zone.kind, ZONE_KIND.PREVIEW);
    assert.equal(zoneLabel(zone), `PROPOSAL · ${zone.name} · ${zone.zoneId}`);
    assert.ok(zone.contents, 'each zone names what it contains');
  }
  // Four distinct colours from the preview's own set — no two blues side by side — none the
  // published zone's.
  assert.deepEqual(preview.zones.map((z) => z.color), [...PREVIEW_PALETTE]);
  assert.ok(preview.zones.every((z) => z.color !== ZONE_PALETTE[0]));
  assert.equal(preview.unresolved, null);
  assert.equal(preview.zones.reduce((n, z) => n + z.cellCount, 0), 64);
  assert.equal(preview.cells.length, 64);
  assert.ok(preview.cells.every((c) => preview.zones.some((z) => z.zoneId === c.zoneId)));
});

test('each proposal label sits inside its own zone (its medoid cell), not on a shared northern edge', () => {
  const preview = previewZonesForCampus(RNSIT_ZONE_PROPOSAL_PREVIEW, 'RNSIT');
  const labels = zoneLabelCollection(preview.zones);
  assert.equal(labels.features.length, 4);
  const inRing = ([x, y], ring) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  for (const f of labels.features) {
    const zone = preview.zones.find((z) => z.key === f.properties.key);
    const own = preview.cells.filter((c) => c.zoneId === zone.zoneId);
    assert.ok(own.some((c) => inRing(f.geometry.coordinates, c.ring)), `${zone.zoneId} label lies in one of its own cells`);
    assert.equal(f.properties.label, `PROPOSAL · ${zone.name} · ${zone.zoneId}`);
  }
  // Pairwise far apart (> ~50 m), so no two labels collide the way the edge-anchored ones did.
  const pts = labels.features.map((f) => f.geometry.coordinates);
  for (let i = 0; i < pts.length; i += 1) {
    for (let j = i + 1; j < pts.length; j += 1) assert.ok(Math.hypot((pts[i][0] - pts[j][0]) * 108500, (pts[i][1] - pts[j][1]) * 110574) > 50);
  }
});

test('proposal labels move off parked robots: none under a marker, each in its own zone, none overlapping', () => {
  // The robots as parked in the demo environment on 2026-10-23, when three of the four medoid
  // labels sat under a robot marker in the browser.
  const robots = [
    [12.90041, 77.51872], [12.89948, 77.51609], [12.90139, 77.51767], [12.9019, 77.51787], [12.90268, 77.51924],
    [12.90073, 77.5176], [12.90041, 77.51872], [12.9027, 77.505], [12.89999, 77.51861], [12.90001, 77.51861],
    [12.89948, 77.51609], [12.89991, 77.51738],
  ].map(([lat, lon]) => ({ lat, lon }));
  const preview = previewZonesForCampus(RNSIT_ZONE_PROPOSAL_PREVIEW, 'RNSIT');
  const { labelHalfWidthM: lw, labelHalfHeightM: lh, markerHalfWidthM: mw, markerAboveM: ma, markerBelowM: mb } = PREVIEW_LABEL_CLEARANCE;
  const kx = 111320 * Math.cos((12.9 * Math.PI) / 180);
  const ky = 110574;
  const covered = ([lon, lat]) => robots.some((r) => Math.abs((lon - r.lon) * kx) < lw + mw && (lat - r.lat) * ky - lh < ma && (lat - r.lat) * ky + lh > -mb);
  // The failure being fixed: medoid labels under markers.
  assert.ok(preview.zones.filter((z) => covered(z.labelAt)).length >= 3);

  const placed = previewLabelsClearOf(preview, robots);
  const labels = zoneLabelCollection(placed.zones).features;
  assert.equal(labels.length, 4);
  for (const f of labels) {
    const zone = placed.zones.find((z) => z.key === f.properties.key);
    assert.ok(!covered(f.geometry.coordinates), `${zone.zoneId} label clear of every robot marker`);
    const centre = (ring) => [0, 1].map((i) => ring.slice(0, -1).reduce((a, p) => a + p[i], 0) / (ring.length - 1));
    assert.ok(placed.cells.some((c) => c.zoneId === zone.zoneId && centre(c.ring).every((v, i) => Math.abs(v - f.geometry.coordinates[i]) < 1e-12)), `${zone.zoneId} label on one of its own cells`);
  }
  for (let i = 0; i < labels.length; i += 1) {
    for (let j = i + 1; j < labels.length; j += 1) {
      const [a, b] = [labels[i].geometry.coordinates, labels[j].geometry.coordinates];
      assert.ok(Math.abs((a[0] - b[0]) * kx) >= 2 * lw || Math.abs((a[1] - b[1]) * ky) >= 2 * lh, 'labels do not overlap');
    }
  }
  // Everything else about the preview is untouched; no robots, or no preview, changes nothing.
  assert.deepEqual(placed.zones.map((z) => [z.zoneId, z.color, z.cellCount]), preview.zones.map((z) => [z.zoneId, z.color, z.cellCount]));
  assert.equal(placed.cells, preview.cells);
  assert.equal(previewLabelsClearOf(preview, []), preview);
  assert.equal(previewLabelsClearOf(null, robots), null);
});

test('a proposal label is two short lines (layout kicker over the zone name); a live label is unchanged', () => {
  const preview = previewZonesForCampus(RNSIT_ZONE_PROPOSAL_PREVIEW, 'RNSIT');
  const props = zoneLabelCollection(preview.zones).features.map((f) => f.properties);
  assert.deepEqual(props.map((p) => [p.labelKicker, p.labelName]), preview.zones.map((z) => ['G4 PROPOSAL', z.name]));
  const layer = dtaroLayerSpecs(null).find((l) => l.id === DTARO_LAYER.ZONE_LABEL);
  assert.deepEqual(layer.layout['text-field'][2], ['format', ['get', 'labelKicker'], { 'font-scale': 0.72 }, '\n', {}, ['upcase', ['get', 'labelName']], { 'font-scale': 1.1 }]);
  assert.deepEqual(layer.layout['text-field'][3], ['format', ['get', 'label'], {}]);
});

test('the preview cell grid: one outline per assigned cell in its zone colour; a hidden zone drops its cells', () => {
  const preview = previewZonesForCampus(RNSIT_ZONE_PROPOSAL_PREVIEW, 'RNSIT');
  const all = previewCellCollection(preview);
  assert.equal(all.features.length, 64);
  const colourOf = new Map(preview.zones.map((z) => [z.zoneId, z.color]));
  for (const f of all.features) {
    assert.equal(f.geometry.type, 'Polygon');
    assert.equal(f.properties.color, colourOf.get(f.properties.zoneId));
  }
  const west = preview.zones.find((z) => z.zoneId === 'rnsit-z-west');
  const hidden = previewCellCollection(preview, new Set([west.key]));
  assert.equal(hidden.features.length, 64 - west.cellCount);
  assert.deepEqual(previewCellCollection(null), { type: 'FeatureCollection', features: [] });
});

test('the preview is never live data and never another campus', () => {
  const live = liveZonesForCampus(VIEW, 'rnsit');
  assert.ok(live.zones.every((z) => z.kind === ZONE_KIND.LIVE && !z.key.startsWith('preview/')));
  assert.equal(previewZonesForCampus(RNSIT_ZONE_PROPOSAL_PREVIEW, 'jssate-bengaluru'), null);
  assert.equal(previewZonesForCampus(RNSIT_ZONE_PROPOSAL_PREVIEW, null), null);
  assert.equal(previewZonesForCampus({ ...RNSIT_ZONE_PROPOSAL_PREVIEW, approved: true }, 'RNSIT'), null);
  assert.equal(previewZonesForCampus({ ...RNSIT_ZONE_PROPOSAL_PREVIEW, published: true }, 'RNSIT'), null);
});

test('live routing never reads the preview: only the map UI imports it', () => {
  const hits = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (/\.(js|jsx)$/.test(name) && fs.readFileSync(p, 'utf8').includes('rnsitZoneProposalPreview')) hits.push(path.relative(path.resolve(HERE, '../../..'), p));
    }
  };
  walk(path.resolve(HERE, '../../..'));
  assert.deepEqual(hits.map((h) => h.replaceAll('\\', '/')).sort(), ['features/maps/MapControl.jsx']);
});

// ── Labels ──────────────────────────────────────────────────────────────────

test('one label per zone, even when a zone is several polygons; hidden zones drop both shape and label', () => {
  const zone = {
    key: 'row-rnsit/rnsit-z1',
    kind: ZONE_KIND.LIVE,
    name: 'RNSIT Zone 1',
    color: '#0072B2',
    geometry: { type: 'MultiPolygon', coordinates: [...square(77.5, 12.9).coordinates, ...square(77.6, 12.9, 0.0002).coordinates] },
  };
  const labels = zoneLabelCollection([zone]);
  assert.equal(labels.features.length, 1);
  // On the NORTHERN EDGE of the largest part (its top vertex), not the centre: a campus-wide
  // zone's centre is where robots park, and the label there was hidden and lost collisions
  // (seen in the real app, 2026-10-22).
  const [lon, lat] = labels.features[0].geometry.coordinates;
  assert.ok(lon >= 77.5 && lon <= 77.501, 'label is on the largest part');
  assert.equal(lat, 12.901, 'label anchor is the top of that part');
  assert.equal(labels.features[0].properties.label, 'Alert zone · RNSIT Zone 1');
  assert.equal(labels.features[0].properties.color, '#0072B2');
  const hidden = new Set([zone.key]);
  assert.equal(zoneFeatureCollection([zone], hidden).features.length, 0);
  assert.equal(zoneLabelCollection([zone], hidden).features.length, 0);
});

// ── Layers on a (fake) Mapbox map ───────────────────────────────────────────

function mapWithCampus() {
  const map = createFakeMapboxMap({ loaded: true });
  for (const id of ['robotx-campus-src']) map.addSource(id, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  for (const id of ['robotx-campus-boundary-fill', 'robotx-campus-boundary-line', 'robotx-campus-road-main-casing', 'robotx-campus-buildings', 'robotx-campus-label-p1']) {
    map.addLayer({ id, type: id.includes('label') ? 'symbol' : 'fill', source: 'robotx-campus-src' });
  }
  map.addLayer({ id: 'robot-route-ahead', type: 'line', source: 'robotx-campus-src' });
  return map;
}

test('layer order: zone tint under the campus roads; labels and obstacles on top', () => {
  const map = mapWithCampus();
  const { installed, missing } = installDtaroLayers(map);
  assert.deepEqual(missing, []);
  assert.equal(installed, DTARO_LAYER_ORDER.length);
  const ids = map.layerIds();
  const at = (id) => ids.indexOf(id);
  assert.ok(at(DTARO_LAYER.ZONE_FILL) > at('robotx-campus-boundary-fill'));
  assert.ok(at(DTARO_LAYER.ZONE_FILL) < at('robotx-campus-road-main-casing'));
  // The tint is BENEATH the campus perimeter line (way/1120154292, the boundary tasks and routes
  // are held to): drawn over it, the tint washed the perimeter out (2026-10-22).
  assert.ok(at(DTARO_LAYER.ZONE_FILL) < at('robotx-campus-boundary-line'));
  assert.ok(at(DTARO_LAYER.AREA_FILL) > at('robotx-campus-boundary-line'));
  // The boundary sits ABOVE the roads (beneath them it was cut at every road and read as one
  // more road, 2026-10-22) and beneath the buildings.
  assert.ok(at(DTARO_LAYER.ZONE_CASING) > at('robotx-campus-road-main-casing'));
  assert.ok(at(DTARO_LAYER.ZONE_LINE) > at(DTARO_LAYER.ZONE_CASING));
  assert.ok(at(DTARO_LAYER.ZONE_LINE) < at('robotx-campus-buildings'));
  assert.ok(at(DTARO_LAYER.ZONE_EDGE_LABEL) > at('robotx-campus-label-p1'));
  assert.ok(at(DTARO_LAYER.ZONE_LABEL) > at('robotx-campus-label-p1'));
  assert.ok(at(DTARO_LAYER.OBSTACLE_CORE) > at('robot-route-ahead'));
  assert.equal(at(DTARO_LAYER.OBSTACLE_GLYPH), ids.length - 1);
  assert.deepEqual(map.errors, []);
});

test('the campus layers — the perimeter among them — are never removed, reordered or added to by DTARO', () => {
  const map = mapWithCampus();
  const campus = () => map.layerIds().filter((id) => !id.startsWith('robotx-dtaro-'));
  const before = campus();
  installDtaroLayers(map);
  installDtaroLayers(map);
  assert.deepEqual(campus(), before);
  setDtaroData(map, { [DTARO_SOURCE.ZONES]: zoneFeatureCollection(liveZonesForCampus(VIEW, 'rnsit').zones) });
  assert.deepEqual(campus(), before);
  removeDtaroLayers(map);
  assert.deepEqual(campus(), before);
  assert.ok(before.includes('robotx-campus-boundary-line'));
  // And no DTARO module names a campus layer except as an insertion anchor.
  const specs = source('../dtaro/dtaroLayers.js');
  assert.doesNotMatch(specs, /setPaintProperty\(\s*['"]robotx-campus-/);
  assert.doesNotMatch(specs, /removeLayer\(\s*['"]robotx-campus-/);
});

test('no accumulation: reinstalling, a style reload and a remount each leave exactly one copy', () => {
  const map = mapWithCampus();
  installDtaroLayers(map);
  installDtaroLayers(map);
  const count = () => map.layerIds().filter((id) => id.startsWith('robotx-dtaro-')).length;
  assert.equal(count(), DTARO_LAYER_ORDER.length);
  assert.deepEqual(map.errors, []);

  map.setStyle();
  assert.equal(count(), 0);
  map.finishStyleLoad();
  installDtaroLayers(map);
  assert.equal(count(), DTARO_LAYER_ORDER.length);

  removeDtaroLayers(map);
  assert.equal(count(), 0);
  assert.deepEqual(map.sourceIds().filter((id) => id.startsWith('robotx-dtaro-')), []);
  installDtaroLayers(map);
  assert.equal(count(), DTARO_LAYER_ORDER.length);
  assert.deepEqual(map.errors, []);
});

test('a style still loading refuses the install without throwing; the caller retries on style.load', () => {
  const map = createFakeMapboxMap({ loaded: false });
  const result = installDtaroLayers(map);
  assert.equal(result.installed, 0);
  assert.equal(result.missing.length, DTARO_LAYER_ORDER.length);
});

test('setData touches sources only, never layers', () => {
  const map = mapWithCampus();
  installDtaroLayers(map);
  const before = map.layerIds().join();
  setDtaroData(map, { [DTARO_SOURCE.ZONES]: zoneFeatureCollection(liveZonesForCampus(VIEW, 'rnsit').zones) });
  assert.equal(map.layerIds().join(), before);
  assert.equal(map.getSource(DTARO_SOURCE.ZONES).data.features.length, 1);
});

test('obstacle markers: located obstacles only, and no severity property (advisory, not a class)', () => {
  const data = obstacleCollection(
    [
      { obstacleId: 'OBS-1', lat: 12.9, lon: 77.5, severity: 'CRITICAL', expiresAtMs: 10 },
      { obstacleId: 'OBS-2', lat: null, lon: null, severity: 'LOW' },
    ],
    20,
  );
  assert.equal(data.features.length, 1);
  assert.deepEqual(Object.keys(data.features[0].properties).sort(), ['expired', 'obstacleId']);
  assert.equal(data.features[0].properties.expired, true);
  const specs = source('../dtaro/dtaroLayers.js');
  assert.doesNotMatch(specs, /\['get',\s*'severity'\]/);
});

test('footprint and involved-robot rings come from what the server sent', () => {
  const footprint = footprintCollection({ footprint: [{ lat: 1, lon: 2 }, { lat: 1, lon: 3 }, { lat: 2, lon: 3 }] });
  const ring = footprint.features[0].geometry.coordinates[0];
  assert.deepEqual(ring[0], ring[ring.length - 1]);
  assert.equal(footprintCollection({ footprint: null }).features.length, 0);

  const obstacle = { reportingRobotId: 'SIM-A', recipients: ['SIM-B', 'SIM-C', 'SIM-GONE'] };
  const positions = new Map([
    ['SIM-A', { lat: 1, lon: 1 }],
    ['SIM-B', { lat: 2, lon: 2 }],
    ['SIM-C', { lat: 3, lon: 3 }],
  ]);
  const parties = partiesCollection(obstacle, positions, (_o, id) => (id === 'SIM-B' ? 'RELEVANT' : 'PENDING'));
  assert.deepEqual(
    parties.features.map((f) => [f.properties.robotId, f.properties.role, f.properties.status]),
    [
      ['SIM-A', 'REPORTER', 'REPORTER'],
      ['SIM-B', 'RECIPIENT', 'RELEVANT'],
      ['SIM-C', 'RECIPIENT', 'PENDING'],
    ],
  );
});

// ── Mapbox's own style validator ────────────────────────────────────────────
//
// The fake map accepts any spec; Mapbox does not. Found in the browser (2026-10-22): a `zoom`
// interpolation nested inside a `case` made Mapbox refuse the whole zone-fill layer.

import { createRequire } from 'node:module';
const { validate: validateStyle } = createRequire(import.meta.url)('mapbox-gl/dist/style-spec/index.cjs');
import { MAP_THEMES, MAP_THEME_ORDER } from '../theme/mapThemes.js';
import { dtaroLayerSpecs } from '../dtaro/dtaroLayers.js';

function styleWith(layers) {
  const sources = {};
  for (const id of Object.values(DTARO_SOURCE)) sources[id] = { type: 'geojson', data: { type: 'FeatureCollection', features: [] } };
  return { version: 8, glyphs: 'mapbox://fonts/mapbox/{fontstack}/{range}.pbf', sources, layers };
}

test('every DTARO layer spec passes the Mapbox style-spec validator, in every theme', () => {
  for (const themeId of MAP_THEME_ORDER) {
    const errors = validateStyle(styleWith(dtaroLayerSpecs(MAP_THEMES[themeId])));
    assert.deepEqual(errors.map((e) => e.message), [], `theme ${themeId}`);
  }
});

test('control: the validator does reject a zoom interpolation nested inside a case', () => {
  const bad = {
    id: 'bad',
    type: 'fill',
    source: DTARO_SOURCE.ZONES,
    paint: { 'fill-opacity': ['case', ['==', ['get', 'kind'], 'X'], 0.2, ['interpolate', ['linear'], ['zoom'], 14, 0.16, 18, 0.11]] },
  };
  assert.ok(validateStyle(styleWith([bad])).length > 0);
});

// ── Wiring (read from the source, like the other architecture tests) ────────

test('the hook installs per style load and removes what it added on unmount', () => {
  const hook = source('../dtaro/useDtaroLayer.js');
  assert.match(hook, /map\.on\('style\.load', install\)/);
  assert.match(hook, /map\.off\('style\.load', install\)/);
  assert.match(hook, /removeDtaroLayers\(map\)/);
  assert.match(hook, /if \(!map \|\| !isMapLoaded \|\| !enabled\) return undefined;/);
});

test('not a SUPER_ADMIN: no fetch result is used, nothing installs or renders', () => {
  const page = source('../MapControl.jsx');
  assert.match(page, /const dtaroView = superAdmin \? dtaroFetched : null;/);
  assert.match(page, /if \(!superAdmin\) return undefined;/);
  assert.match(page, /const zoneMapEnabled = superAdmin;/);
  assert.match(page, /zoneMapEnabled \? \(\s*<ZoneLegendSection/);
  assert.match(page, /enabled: zoneMapEnabled,/);
});

test('the zone map does not wait for the socket, and alerts off hides only the obstacle panel', () => {
  const page = source('../MapControl.jsx');
  // Fetched as soon as a SUPER_ADMIN is on the page; the connection only triggers a re-read.
  assert.doesNotMatch(page, /if \(!superAdmin \|\| !dtaroLive\) return undefined;/);
  assert.match(page, /\}, \[superAdmin, dtaroLive\]\);/);
  assert.match(page, /const alertsEnabled = dtaroView\?\.alertsEnabled === true;/);
  assert.match(page, /\{alertsEnabled && \(\s*<ObstacleActivityPanel/);
  assert.match(page, /alertsEnabled=\{alertsEnabled\}/);
  assert.match(page, /loadError=\{dtaroView\?\.error \|\| null\}/);
  assert.doesNotMatch(page, /dtaroEnabled/);
});

test('the legend header names the published zone at the map centre (published view only); campus areas start hidden', () => {
  const page = source('../MapControl.jsx');
  assert.match(page, /const zoneHere = useZoneAtCentre\(mapRef, \{/);
  assert.match(page, /zones: zoneMapEnabled && selectedCampus && publishedActive \? liveZones\.zones : NO_ZONES,/);
  assert.match(page, /if \(!zoneMapEnabled \|\| !selectedCampus \|\| !publishedActive \|\| liveZones\.status !== ZONE_STATUS\.READY\) return null;/);
  assert.match(page, /headerNote=\{legendZoneNote\}/);
  assert.match(page, /const \[areasOn, setAreasOn\] = useState\(false\);/);
  const hook = source('../dtaro/useDtaroLayer.js');
  assert.match(hook, /map\.on\('moveend', notify\)/);
  assert.match(hook, /map\.off\('moveend', notify\)/);
  const legend = source('../mapControl/ui/MapLegend.jsx');
  assert.match(legend, /className="map-legend__note"/);
});

test('the G4 preview camera: flat Mercator framing, every proposal cell inside the padded view', () => {
  // The same bounds, padding and 1136×692 map the browser measured: Mapbox's flat fit was
  // z16.3643 before terrain loaded and z15.2–15.4 after it (2026-10-23). Ours is the flat one.
  const bounds = [[77.514922, 12.898653], [77.520128, 12.902975]];
  const padding = { top: 64, bottom: 96, left: 341, right: 64 };
  const cam = topDownCameraForBounds(bounds, { width: 1136, height: 692, padding });
  assert.ok(Math.abs(cam.zoom - 16.3643) < 0.001, `zoom ${cam.zoom}`);
  // Project every proposal cell vertex at that camera: all inside the padded area, and the
  // bounds fill it along one axis (a fit, not just "somewhere on screen").
  const preview = previewZonesForCampus(RNSIT_ZONE_PROPOSAL_PREVIEW, 'RNSIT');
  const scale = 512 * 2 ** cam.zoom;
  const mx = (lon) => (lon + 180) / 360;
  const my = (lat) => (1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2;
  const px = ([lon, lat]) => [1136 / 2 + (mx(lon) - mx(cam.center[0])) * scale, 692 / 2 + (my(lat) - my(cam.center[1])) * scale];
  const pts = preview.cells.flatMap((c) => c.ring.map(px));
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  assert.ok(Math.min(...xs) >= padding.left - 0.5 && Math.max(...xs) <= 1136 - padding.right + 0.5);
  assert.ok(Math.min(...ys) >= padding.top - 0.5 && Math.max(...ys) <= 692 - padding.bottom + 0.5);
  const filledX = (Math.max(...xs) - Math.min(...xs)) / (1136 - padding.left - padding.right);
  const filledY = (Math.max(...ys) - Math.min(...ys)) / (692 - padding.top - padding.bottom);
  assert.ok(Math.max(filledX, filledY) > 0.97, `fills ${filledX.toFixed(3)} × ${filledY.toFixed(3)}`);
  // Nothing to frame, or no room inside the padding: no camera rather than a wild one.
  assert.equal(topDownCameraForBounds([], { width: 1136, height: 692 }), null);
  assert.equal(topDownCameraForBounds(bounds, { width: 300, height: 692, padding }), null);
  assert.equal(topDownCameraForBounds([[77.5, 12.9], [77.5, 12.9]], { width: 800, height: 600, maxZoom: 18 }).zoom, 18);
});

test('the zones switch eases to that camera only when the proposal is not already in view: no fitBounds, no standing padding, takes the sequencer', () => {
  const page = source('../MapControl.jsx');
  const body = page.slice(page.indexOf('const setZoneView = useCallback('), page.indexOf('// ── Campus context labels'));
  assert.ok(body.length > 0);
  assert.match(body, /if \(view !== ZONE_VIEW\.PROPOSAL\) return;/, 'Normal map and the published view never move the camera');
  assert.match(body, /const inView = corners\.every\(/);
  assert.match(body, /const slack = 12;/);
  assert.match(body, /x >= padding\.left - slack &&/);
  assert.match(body, /if \(inView\) return;/, 'switching back and forth at the same camera does not move it');
  assert.match(body, /left: legendExpanded \? Math\.min\(360, Math\.round\(width \* 0\.3\)\) : 48/);
  assert.match(body, /const cam = topDownCameraForBounds\(/);
  assert.match(body, /sequencerRef\.current\?\.begin\(\);/);
  assert.match(body, /map\.easeTo\(\{ center: cam\.center, zoom: cam\.zoom, pitch: 0, bearing: 0, duration: 900, essential: true \}\);/);
  assert.doesNotMatch(body, /fitBounds\(/);
});

// ── Zone at a point; boundary-label lines; readable colours ─────────────────

test('zoneAtPoint: inside, outside, in a hole, and hidden', () => {
  const ring = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
  const hole = [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]];
  const zone = { key: 'r/z1', kind: ZONE_KIND.LIVE, name: 'Z1', geometry: { type: 'MultiPolygon', coordinates: [[ring, hole]] } };
  const other = { key: 'r/z2', kind: ZONE_KIND.LIVE, name: 'Z2', geometry: { type: 'Polygon', coordinates: [[[20, 0], [30, 0], [30, 10], [20, 10], [20, 0]]] } };
  assert.equal(zoneAtPoint([zone, other], 2, 2)?.key, 'r/z1');
  assert.equal(zoneAtPoint([zone, other], 25, 5)?.key, 'r/z2');
  assert.equal(zoneAtPoint([zone, other], 15, 5), null, 'between the zones');
  assert.equal(zoneAtPoint([zone, other], 5, 5), null, 'inside the hole');
  assert.equal(zoneAtPoint([zone, other], 2, 2, new Set(['r/z1'])), null, 'a hidden zone is not named');
  assert.equal(zoneAtPoint([zone], Number.NaN, 2), null);
});

// Outlined exactly as the backend outlines a zone (h3 cellsToMultiPolygon, GeoJSON order). h3-js is
// the backend's dependency; without it installed the test is reported as skipped, not passed.
const H3 = (() => {
  try {
    return createRequire(import.meta.url)('../../../../../Backend/node_modules/h3-js');
  } catch {
    return null;
  }
})();

test('zoneAtPoint on a real H3 outline: the campus centre is in the zone', { skip: H3 ? false : 'Backend h3-js not installed' }, () => {
  const h3 = H3;
  const cells = h3.gridDisk(h3.latLngToCell(12.901, 77.518, 11), 4);
  const zone = { key: 'r/rnsit-z1', kind: ZONE_KIND.LIVE, name: 'RNSIT Zone 1', geometry: { type: 'MultiPolygon', coordinates: h3.cellsToMultiPolygon(cells, true) } };
  assert.equal(zoneAtPoint([zone], 77.518, 12.901)?.name, 'RNSIT Zone 1');
  assert.equal(zoneAtPoint([zone], 77.53, 12.92), null);
});

test('boundary-label lines: live zones only, one closed line per part, far fewer turns than the cell outline', () => {
  // A zig-zag edge like an H3 outline: 40 points, 60° turns.
  const ring = [];
  for (let i = 0; i <= 20; i += 1) ring.push([77.5 + i * 0.0002, 12.9 + (i % 2) * 0.00005]);
  ring.push([77.504, 12.902], [77.5, 12.902], [77.5, 12.9]);
  const live = { key: 'r/z1', kind: ZONE_KIND.LIVE, name: 'RNSIT Zone 1', color: ZONE_PALETTE[0], geometry: { type: 'Polygon', coordinates: [ring] } };
  const preview = { ...live, key: 'preview/z2', kind: ZONE_KIND.PREVIEW, zoneId: 'z2' };
  const edges = zoneEdgeCollection([live, preview]);
  assert.equal(edges.features.length, 1, 'the proposal gets no live boundary label');
  const line = edges.features[0].geometry;
  assert.equal(line.type, 'LineString');
  assert.deepEqual(line.coordinates[0], line.coordinates[line.coordinates.length - 1], 'the ring stays closed');
  assert.ok(line.coordinates.length < 10, `simplified to ${line.coordinates.length} points`);
  assert.equal(edges.features[0].properties.edgeLabel, 'RNSIT Zone 1 · alert zone');
  assert.equal(zoneEdgeCollection([live], new Set(['r/z1'])).features.length, 0, 'a hidden zone has no label');
  // The drawn boundary is untouched: the zone source still carries the exact outline.
  assert.deepEqual(zoneFeatureCollection([live]).features[0].geometry, live.geometry);
});

test('every zone colour has a text colour that reads on a white halo (WCAG AA, 4.5:1)', () => {
  const luminance = (hex) => {
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(1 + i, 3 + i), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  for (const colour of ZONE_PALETTE) {
    const text = zoneTextColor(colour);
    assert.match(text, /^#[0-9a-f]{6}$/);
    const ratio = 1.05 / (luminance(text) + 0.05);
    assert.ok(ratio >= 4.5, `${colour} → ${text}: ${ratio.toFixed(2)}:1`);
  }
});

test('the first zone colour is not the blue of the campus roads and routes; a proposal never wears it', () => {
  assert.notEqual(ZONE_PALETTE[0], '#0072B2');
  const live = liveZonesForCampus(VIEW, 'rnsit');
  assert.equal(live.zones[0].color, ZONE_PALETTE[0]);
  const preview = previewZonesForCampus(RNSIT_ZONE_PROPOSAL_PREVIEW, 'RNSIT');
  assert.ok(preview.zones.every((z) => z.color !== ZONE_PALETTE[0]));
});

test('the boundary label runs along the simplified ring, as a line label, on the live zones only', () => {
  const spec = dtaroLayerSpecs().find((l) => l.id === DTARO_LAYER.ZONE_EDGE_LABEL);
  assert.equal(spec.type, 'symbol');
  assert.equal(spec.source, DTARO_SOURCE.ZONE_EDGES);
  assert.equal(spec.layout['symbol-placement'], 'line');
  assert.deepEqual(spec.layout['text-field'], ['get', 'edgeLabel']);
  const hook = source('../dtaro/useDtaroLayer.js');
  assert.match(hook, /zoneEdgeCollection\(zones \|\| \[\], hiddenZones\)/);
  assert.match(hook, /\[DTARO_SOURCE\.ZONE_EDGES, edgeData\]/);
});
