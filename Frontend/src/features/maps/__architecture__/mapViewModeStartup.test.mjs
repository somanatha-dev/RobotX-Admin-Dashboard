/**
 * Map view mode, legend collapse and direct campus startup (2026-10-23).
 *
 *   · The map's zone view is a rendering preference: NORMAL draws no zone overlay, ZONES draws
 *     the G4 proposal (or, for diagnostics, the published map). Obstacles are drawn in every
 *     view; no view requests, publishes or pins anything.
 *   · The legend's header collapses the WHOLE legend — the zone key included, which used to stay
 *     on screen and made "minimise" lengthen the panel — and stays as the way back.
 *   · The operational toolbar has no World / None hierarchy; the map opens on the operating
 *     campus (RNSIT) at its Overview framing, and a focus already on screen is not re-flown.
 *
 * The real `.jsx` files are compiled with Vite's own transform and rendered with
 * react-dom/server, as in obstacleActivityPanel.test.mjs.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';

import { ZONE_VIEW, previewZonesForCampus, zonesForView } from '../dtaro/zoneModel.js';
import { RNSIT_ZONE_PROPOSAL_PREVIEW } from '../dtaro/rnsitZoneProposalPreview.js';
import { CAMPUS_CAMERA_PRESETS, campusStartCamera, isCameraNear } from '../camera/cameraModes.js';
import { operatingCampusBounds, operatingCampusCode } from '../campus/operatingCampusView.js';
import { CAMPUS_REGISTRY } from '../campus/campusRegistry.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const source = (rel) => fs.readFileSync(path.resolve(HERE, rel), 'utf8');

async function loadJsx(file) {
  const src = fs.readFileSync(file, 'utf8');
  const { code } = await transformWithOxc(src, file, { lang: 'jsx', jsx: { runtime: 'automatic' } });
  const absolute = code.replace(/^(import\b[^\n]*?\bfrom\s+)(["'])([^"']+)\2/gm, (_m, from, quote, spec) => {
    let target;
    if (spec.startsWith('.')) target = pathToFileURL(path.resolve(path.dirname(file), spec)).href;
    else if (spec.startsWith('@/')) target = pathToFileURL(path.resolve(HERE, '../../..', spec.slice(2))).href;
    else target = import.meta.resolve(spec);
    return `${from}${quote}${target}${quote}`;
  });
  return import(`data:text/javascript;base64,${Buffer.from(absolute).toString('base64')}`);
}

const { MapLegend } = await loadJsx(path.resolve(HERE, '../mapControl/ui/MapLegend.jsx'));

const THEME = {
  routes: { todo: '#2563eb', done: '#64748b' },
  campus: { boundaryLine: '#5b6b82', buildings: { ACADEMIC: '#888' }, ground: { SPORTS: '#9c9' }, gate: '#fff', gateEdge: '#000', buildingRoof: '#ddd', buildingEdge: '#555', buildingHighlight: '#fc0' },
  roads: { main: { color: '#333', casing: '#999' }, path: { color: '#777' }, steps: { color: '#aaa' } },
};

function legend(props) {
  return renderToStaticMarkup(
    React.createElement(MapLegend, {
      theme: THEME,
      terrainActive: true,
      buildings3dActive: true,
      robotCount: 3,
      campusFeatureCount: 40,
      campusName: 'RNSIT',
      zoneSection: React.createElement('div', { className: 'zone-section-marker' }, 'ZONE KEY'),
      headerNote: props.headerNote ?? null,
      expanded: props.expanded,
      onExpandedChange: () => {},
    }),
  );
}

// ── Legend collapse ──────────────────────────────────────────────────────────

test('legend collapsed: the header bar alone — no zone key, no key rows — and it says how to reopen', () => {
  const html = legend({ expanded: false, headerNote: { text: 'Proposal preview: G4 · 4 zones', color: null } });
  assert.match(html, /class="map-legend is-collapsed"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /title="Show the legend"/);
  assert.match(html, />Show<span aria-hidden="true"> ▸<\/span>/);
  // The zone key used to render outside the toggle and never collapsed.
  assert.doesNotMatch(html, /ZONE KEY|zone-section-marker/);
  assert.doesNotMatch(html, /map-legend__row|map-legend__body/);
  // The header note stays readable while collapsed.
  assert.match(html, /Proposal preview: G4 · 4 zones/);
});

test('legend expanded: zone key and map key inside one body the header controls', () => {
  const html = legend({ expanded: true });
  assert.match(html, /class="map-legend is-open"/);
  assert.match(html, /aria-expanded="true"/);
  const controls = html.match(/aria-controls="([^"]+)"/)[1];
  assert.match(html, new RegExp(`<div id="${controls}" class="map-legend__body"><div class="zone-section-marker">ZONE KEY</div>`));
  assert.match(html, /Robot — 2D marker, arrow = heading/);
  assert.match(html, />Hide<span aria-hidden="true"> ▾<\/span>/);
});

test('legend header: one button, its own click only; the zone key is not inside it', () => {
  const src = source('../mapControl/ui/MapLegend.jsx');
  assert.match(src, /onClick=\{\(\) => setOpen\(!open\)\}/);
  // Exactly one button in the header region, closed before the body opens.
  const head = src.slice(src.indexOf('<button'), src.indexOf('</button>'));
  assert.doesNotMatch(head, /zoneSection/);
  assert.match(src, /\{open && \(\s*<div id=\{bodyId\} className="map-legend__body">\s*\{zoneSection\}/);
  // Controlled by the page, so a zone framing can account for it.
  const page = source('../MapControl.jsx');
  assert.match(page, /expanded=\{legendExpanded\}\s*onExpandedChange=\{setLegendExpanded\}/);
});

// ── Zone view ────────────────────────────────────────────────────────────────

test('zone view: NORMAL draws no zones; ZONES draws the four G4 zones; PUBLISHED the published map', () => {
  const preview = previewZonesForCampus(RNSIT_ZONE_PROPOSAL_PREVIEW, 'RNSIT');
  const live = [{ key: 'live/1', zoneId: 'rnsit-syn-east' }, { key: 'live/2', zoneId: 'rnsit-syn-west' }];
  assert.deepEqual(zonesForView(ZONE_VIEW.NORMAL, { liveZones: live, preview }), []);
  assert.deepEqual(zonesForView(ZONE_VIEW.PROPOSAL, { liveZones: live, preview }).map((z) => z.zoneId), ['rnsit-z-west', 'rnsit-z-east', 'rnsit-z-south', 'rnsit-z-southwest']);
  assert.deepEqual(zonesForView(ZONE_VIEW.PUBLISHED, { liveZones: live, preview }), live);
  // No preview for this campus: the proposal view draws nothing rather than another kind.
  assert.deepEqual(zonesForView(ZONE_VIEW.PROPOSAL, { liveZones: live, preview: null }), []);
  assert.deepEqual(zonesForView(undefined, { liveZones: live, preview }), []);
});

test('the page: Normal map by default, the layer fed by the view, obstacles in every view', () => {
  const page = source('../MapControl.jsx');
  assert.match(page, /const \[zoneView, setZoneViewState\] = useState\(ZONE_VIEW\.NORMAL\);/);
  assert.match(page, /zonesForView\(zoneView, \{ liveZones: liveZones\.zones, preview: previewActive \? placedPreview : null \}\)/);
  assert.match(page, /const previewActive = zoneView === ZONE_VIEW\.PROPOSAL && Boolean\(zonePreview\);/);
  // Cell outlines only with the proposal; obstacles independent of the view.
  assert.match(page, /\(\) => \(previewActive \? previewCellCollection\(zonePreview, hiddenZones\) : null\)/);
  const layerCall = page.slice(page.indexOf('useDtaroLayer(mapRef, {'), page.indexOf('});', page.indexOf('useDtaroLayer(mapRef, {')));
  assert.match(layerCall, /zones: layerZones,/);
  assert.match(layerCall, /obstacles: scopedObstacles,/);
  assert.doesNotMatch(page.slice(page.indexOf('const scopedObstacles'), page.indexOf('const selectedObstacle')), /zoneView|previewActive/);
  // A different campus resets to the normal map.
  assert.match(page, /setZoneViewState\(ZONE_VIEW\.NORMAL\);/);
});

test('the view switch: Normal map | Zones, the proposal tagged as not live; nothing but local state changes', () => {
  const page = source('../MapControl.jsx');
  const jsx = page.slice(page.indexOf('<div className="map-zone-mode"'), page.indexOf('</div>', page.indexOf('<div className="map-zone-mode"')));
  assert.match(jsx, />\s*Normal map\s*</);
  assert.match(jsx, />\s*Zones\s*\{/);
  assert.match(jsx, /preview · not live/);
  assert.match(jsx, /published · diagnostic/);
  assert.match(jsx, /aria-pressed=\{zoneView === ZONE_VIEW\.NORMAL\}/);
  // Pressing Zones while already in a zone view keeps that view (no flip-flop).
  assert.match(jsx, /if \(zoneView === ZONE_VIEW\.NORMAL\) setZoneView\(zonePreview \? ZONE_VIEW\.PROPOSAL : ZONE_VIEW\.PUBLISHED\);/);
  // The handler: state, a robot-position sample, and at most one camera ease. No request.
  const body = page.slice(page.indexOf('const setZoneView = useCallback('), page.indexOf('// ── Campus context labels'));
  assert.doesNotMatch(body, /fetch\(|api\.|axios|publish|pin\(|emit\(|socket/i);
});

// ── Toolbar and startup ──────────────────────────────────────────────────────

test('toolbar: no World / None hierarchy and no filter reset — the campus selector alone', () => {
  const bar = source('../mapControl/ui/MapFiltersBar.jsx');
  assert.match(bar, /showHierarchy = true,\s*\}\) \{\s*const hierarchyShown = showHierarchy && !campusLocked;/);
  // Country (World) / state / city / area selects only with the hierarchy.
  assert.match(bar, /\{!hierarchyShown \? null : \(\s*<>\s*<Select value=\{toSelectableValue\(countryId\)\}/);
  // No "None" campus, and no filter Reset, without it.
  assert.match(bar, /\{hierarchyShown \? <SelectItem value="__none__">None<\/SelectItem> : null\}/);
  assert.match(bar, /\{hierarchyShown && \(\s*<Button[^>]*className="map-filters-bar__reset"/);
  // The operational map turns it off; the campus administrator lock is unchanged.
  assert.match(source('../MapControl.jsx'), /campusLocked=\{!superAdmin\}\s*showHierarchy=\{false\}/);
});

test('default campus: the operating campus (RNSIT), selected once the list arrives, a valid stored choice kept', () => {
  assert.equal(operatingCampusCode(), 'RNSIT');
  assert.equal(operatingCampusCode(CAMPUS_REGISTRY.filter((c) => !c.regionId)), null);
  const hook = source('../mapControl/hooks/useLocationFilters.js');
  assert.match(hook, /const fallback = defaultCampusCode \? sorted\.find\(\(c\) => c\?\.code === defaultCampusCode\) : null;/);
  assert.match(hook, /setCampusIdState\(\(cur\) => \(cur && sorted\.some\(\(c\) => c\.id === cur\) \? cur : fallback\.id\)\)/);
  // Loading from the first render, so the empty pre-request list is never read as "no campus".
  assert.match(hook, /campuses: true,\s*\}\);/);
  // Without the hierarchy, stored country/state/city/area ids are not restored.
  assert.match(hook, /return hierarchy \? stored : \{ campusId: stored\.campusId \?\? null \};/);
});

test('start camera: the map is created over RNSIT at the Overview zoom, looking straight down, not on the globe', () => {
  const bounds = operatingCampusBounds();
  const cam = campusStartCamera(bounds);
  assert.deepEqual(cam, {
    lon: (bounds[0][0] + bounds[1][0]) / 2,
    lat: (bounds[0][1] + bounds[1][1]) / 2,
    zoom: CAMPUS_CAMERA_PRESETS.OVERVIEW.zoom,
    // Flat: tilted before elevation data exists, Mapbox lifted the camera out of the terrain
    // at a random moment (z16.6 → 15.87, no camera call). See campusStartCamera.
    pitch: 0,
    bearing: CAMPUS_CAMERA_PRESETS.OVERVIEW.bearing,
  });
  assert.equal(campusStartCamera(null), null);
  const page = source('../MapControl.jsx');
  assert.match(page, /persistedMapCamera \|\| campusStartCamera\(pinnedCampusCode \? campusBounds\(pinnedCampusCode\) : operatingCampusBounds\(\)\)/);
});

test('focus: the campus record arriving is already on screen — no flight; a re-run never re-aims', () => {
  const start = campusStartCamera(operatingCampusBounds());
  // Campus centres held by the databases differ from the boundary's middle: disposable demo DB
  // (142 m) and the seed (Backend/prisma/seed.js). Both are "already there".
  for (const [lat, lon] of [[12.89966350840949, 77.51810846379], [12.9023, 77.5186]]) {
    assert.ok(isCameraNear(start, { lon, lat, zoom: CAMPUS_CAMERA_PRESETS.OVERVIEW.zoom }), `${lat},${lon}`);
  }
  // Another campus, or a far zoom, is not.
  assert.equal(isCameraNear(start, { lon: 77.5, lat: 12.98, zoom: 16.6 }), false);
  assert.equal(isCameraNear(start, { ...start, zoom: 12 }), false);
  assert.equal(isCameraNear(null, start), false);
  const page = source('../MapControl.jsx');
  assert.match(page, /if \(lastFocusKeyRef\.current === focusKey\) return;/);
  assert.match(page, /if \(!skipAnimation && !alreadyAt\(cam\)\) focusCamera\(cam, preset\.pitch\);/);
  assert.match(page, /if \(!skipAnimation && !alreadyAt\(cam\)\) focusCamera\(cam, 0\);/);
});
