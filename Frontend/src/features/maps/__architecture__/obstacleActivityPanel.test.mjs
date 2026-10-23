/**
 * The obstacle-awareness panel, rendered.
 *
 * The real `.jsx` files are compiled with Vite's own transform and rendered with
 * `react-dom/server` (the `chargingStationCard.test.mjs` approach), with the `@/` alias resolved
 * to `src/`. The data is built by the real activity model from backend-shaped payloads.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';

import { CONNECTION } from '../../../lib/connectionState.js';
import { ACTIVITY_FILTER, EMPTY_ACTIVITY, OBSTACLE_EVENTS, activityEntries, applyObstacleEvent } from '../../../lib/obstacleActivity.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../../..');

async function loadJsx(file) {
  const source = fs.readFileSync(file, 'utf8');
  const { code } = await transformWithOxc(source, file, { lang: 'jsx', jsx: { runtime: 'automatic' } });
  // Only real import statements (line-anchored) — a JSX string such as "Report from " is not one.
  const absolute = code.replace(/^(import\b[^\n]*?\bfrom\s+)(["'])([^"']+)\2/gm, (_m, from, quote, spec) => {
    let target;
    if (spec.startsWith('@/')) target = pathToFileURL(path.join(SRC, spec.slice(2))).href;
    else if (spec.startsWith('.')) target = pathToFileURL(path.resolve(path.dirname(file), spec)).href;
    else target = import.meta.resolve(spec);
    return `${from}${quote}${target}${quote}`;
  });
  return import(`data:text/javascript;base64,${Buffer.from(absolute).toString('base64')}`);
}

const { ObstacleActivityPanel } = await loadJsx(path.resolve(HERE, '../mapControl/ui/ObstacleActivityPanel.jsx'));
const { ZoneLegendSection } = await loadJsx(path.resolve(HERE, '../mapControl/ui/ZoneLegendSection.jsx'));
const { ZONE_VIEW, liveZonesForCampus, previewZonesForCampus } = await import('../dtaro/zoneModel.js');
const { RNSIT_ZONE_PROPOSAL_PREVIEW } = await import('../dtaro/rnsitZoneProposalPreview.js');

const ALERT = {
  obstacleId: 'OBS-1',
  lat: 12.899823,
  lon: 77.518413,
  zoneId: 'rnsit-z1',
  severity: 'HIGH',
  reportingRobotId: 'SIM-A',
  timestamp: Date.UTC(2026, 9, 23, 4, 30, 0),
  expiresAt: new Date(Date.UTC(2026, 9, 23, 4, 35, 0)).toISOString(),
  regionId: 'row-rnsit',
  cellId: '8b6014510486fff',
  recipients: ['SIM-B', 'SIM-C', 'SIM-D'],
  delivery: 'ZONE_ROOM',
};
const verdict = (robotId, relevant, extra = {}) => ({
  obstacleId: 'OBS-1',
  robotId,
  relevant,
  routeSource: 'COMMANDED_ROUTE',
  taskId: `TSK-${robotId}`,
  decision: relevant ? 'RELEVANT_NO_REPLAN' : 'NOT_RELEVANT',
  regionId: 'row-rnsit',
  zoneId: 'rnsit-z1',
  timestamp: ALERT.timestamp + 500,
  ...extra,
});

function stateWith(...events) {
  return events.reduce((s, [e, p]) => applyObstacleEvent(s, e, p), EMPTY_ACTIVITY);
}

function render(props) {
  const state = props.state || EMPTY_ACTIVITY;
  const view = activityEntries(state, { regionIds: props.regionIds ?? ['row-rnsit'], filter: props.filter || ACTIVITY_FILTER.ALL });
  const selected = props.selectedId ? state.obstacles.find((o) => o.obstacleId === props.selectedId) : null;
  return renderToStaticMarkup(
    React.createElement(ObstacleActivityPanel, {
      connectionState: props.connectionState || CONNECTION.CONNECTED,
      entries: view.entries,
      hiddenCount: view.hiddenCount,
      campusName: 'RNS Institute of Technology',
      filter: props.filter || ACTIVITY_FILTER.ALL,
      onFilter: () => {},
      selectedObstacle: selected,
      onSelect: () => {},
      onFocus: () => {},
      zoneNameOf: (zoneId, regionId) => (zoneId === 'rnsit-z1' && regionId === 'row-rnsit' ? 'RNSIT Zone 1' : null),
      robotsById: new Map([['SIM-A', { robotId: 'SIM-A', simulated: true }]]),
      nowMs: props.nowMs ?? ALERT.timestamp + 1_000,
      initiallyOpen: props.open !== false,
    }),
  );
}

test('collapsed: a labelled toggle with the report count and aria-expanded', () => {
  const html = render({ open: false, state: stateWith([OBSTACLE_EVENTS.ALERT_CREATED, ALERT]) });
  assert.match(html, /aria-label="Obstacle awareness"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /aria-label="1 reports"/);
  assert.doesNotMatch(html, /map-obstacle__list/);
});

test('empty state: says nothing has arrived, invents nothing', () => {
  const html = render({});
  assert.match(html, /No obstacle reports yet/);
  assert.doesNotMatch(html, /map-obstacle__entry/);
});

test('reconnecting and disconnected states are stated; connected says nothing extra', () => {
  assert.match(render({ connectionState: CONNECTION.RECONNECTING }), /Live updates paused — reconnecting/);
  assert.match(render({ connectionState: CONNECTION.DISCONNECTED }), /Live updates stopped/);
  assert.doesNotMatch(render({ connectionState: CONNECTION.CONNECTED }), /Live updates/);
});

test('an obstacle entry: reporter, zone name, and the verdict tallies the backend sent', () => {
  const state = stateWith(
    [OBSTACLE_EVENTS.ALERT_CREATED, ALERT],
    [OBSTACLE_EVENTS.RELEVANCE, verdict('SIM-B', true)],
    [OBSTACLE_EVENTS.RELEVANCE, verdict('SIM-C', false)],
  );
  const html = render({ state });
  assert.match(html, /Obstacle reported by <strong>SIM-A<\/strong>/);
  assert.match(html, /RNSIT Zone 1/);
  assert.match(html, /1 relevant/);
  assert.match(html, /1 not relevant/);
  assert.match(html, /1 awaiting/);
});

test('details: each recipient by its own verdict, decision-only wording, advisory severity, SIM label', () => {
  const state = stateWith(
    [OBSTACLE_EVENTS.ALERT_CREATED, ALERT],
    [OBSTACLE_EVENTS.RELEVANCE, verdict('SIM-B', true)],
    [OBSTACLE_EVENTS.RELEVANCE, verdict('SIM-C', false)],
  );
  const html = render({ state, selectedId: 'OBS-1' });
  assert.match(html, /SIM-B<\/span><span class="map-obstacle__chip is-relevant">On its commanded route/);
  assert.match(html, /SIM-C<\/span><span class="map-obstacle__chip is-clear">Not on its commanded route/);
  assert.match(html, /SIM-D<\/span><span class="map-obstacle__chip is-pending">Awaiting its answer/);
  assert.match(html, /Decision only/);
  assert.match(html, /Reroute: not available — no robot\s+is rerouted/);
  assert.match(html, /owner decision OD-3/);
  assert.doesNotMatch(html, /rerouted to|new route|replanned/i);
  assert.match(html, /as reported by the robot \(advisory\)/);
  assert.match(html, /class="map-obstacle__sim">SIM</);
  assert.match(html, /Show on map/);
});

test('a refusal is its own kind of entry, with the server reason', () => {
  const state = stateWith([
    OBSTACLE_EVENTS.REJECTED,
    { reportingRobotId: 'SIM-X', reason: 'WRONG_REGION', reporterRegionId: 'row-rnsit', obstacleRegionId: 'row-other', timestamp: ALERT.timestamp },
  ]);
  const html = render({ state });
  assert.match(html, /Report from <strong>SIM-X<\/strong> refused/);
  assert.match(html, /is-refused">WRONG_REGION/);
  assert.match(html, /outside the reporter/);
});

test('other regions are not shown for this campus — only counted', () => {
  const state = stateWith([OBSTACLE_EVENTS.ALERT_CREATED, { ...ALERT, obstacleId: 'OBS-9', regionId: 'row-other' }]);
  const html = render({ state });
  assert.doesNotMatch(html, /OBS-9|Obstacle reported by/);
  assert.match(html, /1 entry from other regions not shown/);
});

// ── Zone key ────────────────────────────────────────────────────────────────

const VIEW = {
  available: true,
  alertsEnabled: true,
  spatialVersion: 1,
  regions: [{ id: 'row-rnsit', regionKey: 'rnsit' }],
  zones: [{ regionId: 'row-rnsit', regionKey: 'rnsit', zoneId: 'rnsit-z1', name: 'RNSIT Zone 1', cellCount: 64, geometry: { type: 'MultiPolygon', coordinates: [] } }],
};

function renderZones(props) {
  return renderToStaticMarkup(
    React.createElement(ZoneLegendSection, {
      status: props.live.status,
      zones: props.live.zones,
      hiddenZones: props.hidden || new Set(),
      onToggleZone: () => {},
      onShowAll: () => {},
      spatialVersion: 1,
      preview: props.preview ?? null,
      mode: props.mode || (props.previewOn ? ZONE_VIEW.PROPOSAL : ZONE_VIEW.PUBLISHED),
      onModeChange: () => {},
      areaRows: props.areaRows || [],
      alertsEnabled: props.alertsEnabled || false,
      loadError: props.loadError || null,
      boundaryColor: props.boundaryColor || null,
    }),
  );
}

test('zone key, published map (diagnostics): the published zone with swatch and toggle, and the way back', () => {
  const html = renderZones({ live: liveZonesForCampus(VIEW, 'rnsit'), preview: previewZonesForCampus(RNSIT_ZONE_PROPOSAL_PREVIEW, 'RNSIT') });
  assert.match(html, /Alert zones — published map \(diagnostic\)/);
  assert.match(html, /64 cells · whole campus/);
  assert.match(html, /RNSIT Zone 1/);
  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /Back to the G4 proposal/);
  // The switch is the map's own Normal map | Zones control now, not a checkbox in the key.
  assert.doesNotMatch(html, /is-preview-switch|type="checkbox"/);
  assert.doesNotMatch(html, /PROPOSAL — not approved/);
});

test('zone key, normal map: no zone rows, outlines or boundary note — one line and a way to the zones', () => {
  const live = liveZonesForCampus(VIEW, 'rnsit');
  const preview = previewZonesForCampus(RNSIT_ZONE_PROPOSAL_PREVIEW, 'RNSIT');
  const html = renderZones({ live, preview, mode: ZONE_VIEW.NORMAL, boundaryColor: '#5b6b82', alertsEnabled: true, areaRows: [{ group: 'ACADEMIC', label: 'Academic', count: 3, fill: '#111', line: '#222' }] });
  assert.match(html, /Zones — hidden \(normal map\)/);
  assert.match(html, /No zone shading, outlines or labels on the normal map\. Robots, routes, stations and obstacle alerts are unchanged\./);
  assert.match(html, />Show zones</);
  assert.doesNotMatch(html, /map-zone-legend__row|is-zone|Campus boundary \(dashed\)|Obstacle alerts:|RNSIT Zone 1|rnsit-z-west/);
  // The visual-only campus areas are not zones and stay available on the normal map.
  assert.match(html, /Campus areas — visual only, not alert zones/);
});

test('zone key in preview: G4 named as a validated proposal, four dashed swatches with names and contents', () => {
  const html = renderZones({ live: liveZonesForCampus(VIEW, 'rnsit'), preview: previewZonesForCampus(RNSIT_ZONE_PROPOSAL_PREVIEW, 'RNSIT'), previewOn: true });
  assert.match(html, /Zones — G4 proposal preview/);
  assert.match(html, /G4 PROPOSAL\s+— validated offline — not approved, not published\. Alerts still use the published\s+map \(1 zone, under Diagnostics below\), not this\./);
  // The published zone's own name is not shown over the proposal (it read as one of its zones).
  assert.doesNotMatch(html, /RNSIT Zone 1/);
  // The published map stays reachable, as a diagnostic, off the main switch.
  assert.match(html, /map-zone-legend__link is-diagnostic[^>]*>Diagnostics: published alert map \(1 zone\)</);
  assert.equal((html.match(/is-zone is-dashed/g) || []).length, 4);
  for (const id of ['rnsit-z-west', 'rnsit-z-east', 'rnsit-z-south', 'rnsit-z-southwest']) assert.match(html, new RegExp(`· ${id}`));
  assert.match(html, /RNS International School and the south-west lobe/);
  assert.doesNotMatch(html, /Unresolved/);
});

test('zone key: one published zone is said to be the whole campus, the proposal not in use; alert state stated', () => {
  const live = liveZonesForCampus(VIEW, 'rnsit');
  const preview = previewZonesForCampus(RNSIT_ZONE_PROPOSAL_PREVIEW, 'RNSIT');
  const off = renderZones({ live, preview });
  assert.match(off, /One operational zone is published for this campus\. It covers all 64 assigned\s+cells/);
  assert.match(off, /The 4-zone G4 layout is a proposal and is not in use\./);
  assert.match(off, /Obstacle alerts: off on this server — the zone is shown for reference only\./);
  assert.doesNotMatch(off, /is-on/);
  const on = renderZones({ live, preview, alertsEnabled: true });
  assert.match(on, /map-zone-legend__alerts is-on/);
  assert.match(on, /Obstacle alerts: on/);
  // In the preview the one-zone sentence and the alert line give way to the proposal warning.
  const inPreview = renderZones({ live, preview, previewOn: true, alertsEnabled: true });
  assert.doesNotMatch(inPreview, /One operational zone|Obstacle alerts:/);
});

test('zone key: the campus boundary is its own row, distinct from the alert zone, and the wider zone outline is explained', () => {
  const live = liveZonesForCampus(VIEW, 'rnsit');
  const html = renderZones({ live, boundaryColor: '#5b6b82' });
  assert.match(html, /Campus boundary \(dashed\) — robots operate and route only inside it/);
  assert.match(html, /is-boundary/);
  assert.match(html, /--boundary-color:#5b6b82/);
  assert.match(html, /its outline runs outside the campus boundary in places\. That\s+does not widen where robots may go\./);
  // No campus drawn (no colour): no boundary row.
  assert.doesNotMatch(renderZones({ live }), /Campus boundary/);
  // With the proposal on screen the boundary row stays (2026-10-23): the perimeter must remain
  // distinguishable from the four dashed proposal outlines, which also run outside it in places.
  const inPreview = renderZones({ live, boundaryColor: '#5b6b82', preview: previewZonesForCampus(RNSIT_ZONE_PROPOSAL_PREVIEW, 'RNSIT'), previewOn: true });
  assert.match(inPreview, /Campus boundary \(dashed\) — robots operate and route only inside it/);
  assert.match(inPreview, /Each proposed zone is built from whole map cells, so its dashed outline runs outside the campus boundary in places\. The boundary itself is unchanged\./);
  // The full legend's campus key names it too.
  const legend = fs.readFileSync(path.resolve(HERE, '../mapControl/ui/MapLegend.jsx'), 'utf8');
  assert.match(legend, /Campus boundary — tasks and routes stay inside/);
});

test('zone key: a failed load is stated with its reason, not shown as an empty map', () => {
  const live = liveZonesForCampus({ available: false, alertsEnabled: false, error: 'HTTP 403' }, 'rnsit');
  const html = renderZones({ live, loadError: 'HTTP 403' });
  assert.match(html, /The zone map could not be loaded from the server\. \(HTTP 403\)/);
  assert.doesNotMatch(html, /Obstacle alerts:/);
});

test('zone key with no data says why; a hidden zone offers "Show all"', () => {
  assert.match(renderZones({ live: liveZonesForCampus(VIEW, null) }), /no operating region/);
  const live = liveZonesForCampus(VIEW, 'rnsit');
  const html = renderZones({ live, hidden: new Set([live.zones[0].key]) });
  assert.match(html, /aria-pressed="false"/);
  assert.match(html, /Show all/);
});

test('expiry is a timeout, never shown as clearance; corroborating reports are shown as such', () => {
  const state = stateWith(
    [OBSTACLE_EVENTS.ALERT_CREATED, { ...ALERT, expiresAt: new Date(ALERT.timestamp + 500).toISOString() }],
    [OBSTACLE_EVENTS.MERGED, { obstacleId: 'OBS-1', reportingRobotId: 'SIM-C', corroborations: ['SIM-C'], timestamp: ALERT.timestamp + 200 }],
  );
  const html = render({ state, selectedId: 'OBS-1' });
  assert.match(html, /expired — not confirmed clear/);
  assert.match(html, /timed out, not confirmed clear/);
  assert.doesNotMatch(html, />cleared</i);
  assert.match(html, /\+1 report</);
  assert.match(html, /Also reported by<\/dt><dd>SIM-C — same published cell, not re-broadcast/);
});


test('zone key, published map with no pending proposal (G4 published): plain heading, no diagnostic wording', () => {
  const html = renderZones({ live: liveZonesForCampus(VIEW, 'rnsit'), preview: null, mode: ZONE_VIEW.PUBLISHED });
  assert.match(html, /Alert zones — published map</);
  assert.doesNotMatch(html, /diagnostic|Back to the|proposal/i);
});

test('simulated, active and expiry are stated on the entry itself, and the entry flips to expired at its expiry', () => {
  const state = stateWith([OBSTACLE_EVENTS.ALERT_CREATED, ALERT]);
  const expiresAtMs = Date.parse(ALERT.expiresAt);

  const active = render({ state, nowMs: expiresAtMs - 1 });
  assert.match(active, /SIMULATED<\/span> Every report here comes from a simulated robot/);
  assert.match(active, /None is a physical sensor detection/);
  assert.match(active, /map-obstacle__chip is-sim">simulated</);
  assert.match(active, /active · until \d\d:\d\d:\d\d/);
  assert.match(active, />high</);
  assert.doesNotMatch(active, /expired — not confirmed clear/);

  const expired = render({ state, nowMs: expiresAtMs });
  assert.doesNotMatch(expired, /active · until/);
  assert.match(expired, /expired — not confirmed clear/);
  assert.match(expired, /map-obstacle__entry is-expired/);
});

test('why chips: an unknown route says it was alerted to be safe, naming the route status', () => {
  const state = stateWith([
    OBSTACLE_EVENTS.ALERT_CREATED,
    {
      ...ALERT,
      recipients: ['SIM-U'],
      crossZoneRecipients: ['SIM-U'],
      recipientDecisions: [{ robotId: 'SIM-U', zoneId: 'rnsit-z-west', relation: 'OTHER_ZONE', routeIntersects: null, selected: true, alerted: true, reason: 'ROUTE_UNKNOWN', route: { status: 'LOOKUP_FAILED' } }],
    },
  ]);
  const html = render({ state, selectedId: 'OBS-1' });
  assert.match(html, /route unknown, alerted to be safe \(route could not be read\)/);
});

test('map markers turn expired at the page clock, not only when the obstacle list changes', async () => {
  const { obstacleCollection } = await import('../dtaro/dtaroLayers.js');
  const obstacle = { obstacleId: 'OBS-1', lat: ALERT.lat, lon: ALERT.lon, expiresAtMs: Date.parse(ALERT.expiresAt) };
  assert.equal(obstacleCollection([obstacle], obstacle.expiresAtMs - 1).features[0].properties.expired, false);
  assert.equal(obstacleCollection([obstacle], obstacle.expiresAtMs).features[0].properties.expired, true);
  const hook = fs.readFileSync(path.resolve(HERE, '../dtaro/useDtaroLayer.js'), 'utf8');
  // The layer is fed the page clock and rebuilds its markers when an obstacle crosses its expiry.
  assert.match(hook, /obstacleCollection\(obstacles \|\| \[\], clock\)/);
  assert.match(hook, /\[obstacles, expiredKey\]/);
  const page = fs.readFileSync(path.resolve(HERE, '../MapControl.jsx'), 'utf8');
  assert.match(page, /nowMs: dtaroNowMs,/);
  assert.match(page, /setTimeout\(\(\) => setDtaroNowMs\(Date\.now\(\)\), Math\.max\(0, nextExpiryMs - Date\.now\(\)\)/);
});

test('a connection drop keeps the zone map and the obstacle panel: a network-failed refetch never replaces a good view', () => {
  const page = fs.readFileSync(path.resolve(HERE, '../MapControl.jsx'), 'utf8');
  // The zone fetch re-runs when the connection drops; offline it fails with NETWORK. Replacing the
  // view with that failure set alertsEnabled false and unmounted the panel mid-outage (seen in
  // the real dashboard, 2026-10-23), so the "reconnecting" note was never shown.
  assert.match(page, /setDtaroFetched\(\(previous\) => \(view\?\.error === 'NETWORK' && previous && previous\.available !== false \? previous : view\)\)/);
  assert.match(page, /\{alertsEnabled && \(\s*<ObstacleActivityPanel\s*connectionState=\{connectionState\}/);
});
