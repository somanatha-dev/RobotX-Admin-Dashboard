/**
 * DTARO cross-zone recipients in the dashboard (2026-10-23).
 *
 *   · the activity model keeps the server's per-robot decision record and cross-zone list;
 *   · a page that opens or reconnects after a report replays the server's own events
 *     (`GET /api/dtaro/activity`) through the same reducer, idempotently;
 *   · the panel says why each robot was alerted, and lists who was considered but not alerted;
 *   · the G4 preview layers sit in the outline group and are validated by the existing style test.
 *
 * Payloads are shaped exactly like the backend's `ALERT_CREATED` (dtaroZoneAlert.processReport).
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
import {
  EMPTY_ACTIVITY,
  OBSTACLE_EVENTS,
  activityEntries,
  applyObstacleEvent,
  createObstacleActivityStore,
} from '../../../lib/obstacleActivity.js';
import { DTARO_LAYER, DTARO_LAYER_ORDER, DTARO_SOURCE, dtaroLayerSpecs } from '../dtaro/dtaroLayers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../../..');

async function loadJsx(file) {
  const source = fs.readFileSync(file, 'utf8');
  const { code } = await transformWithOxc(source, file, { lang: 'jsx', jsx: { runtime: 'automatic' } });
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

const route = (status, extra = {}) => ({ source: 'OFFER', status, commitmentId: status === 'OK' ? 'cm-1' : null, cut: status === 'OK' ? 'AT_POSITION' : null, ...extra });
const ALERT = {
  obstacleId: 'OBS-X',
  lat: 12.899823,
  lon: 77.518413,
  zoneId: 'syn-east',
  regionId: 'row-rnsit',
  cellId: '8b6014510486fff',
  reportingRobotId: 'SIM-R',
  timestamp: Date.UTC(2026, 9, 23, 6, 0, 0),
  expiresAt: new Date(Date.UTC(2026, 9, 23, 6, 5, 0)).toISOString(),
  delivery: 'ZONE_ROOM',
  recipientPolicy: 'ZONE_PLUS_REMAINING_ROUTE',
  recipients: ['SAME-1', 'X-CROSS'],
  sameZoneRecipients: ['SAME-1'],
  crossZoneRecipients: ['X-CROSS'],
  recipientDecisions: [
    { robotId: 'B-1', zoneId: 'zB', relation: 'OTHER_REGION', routeIntersects: null, selected: false, alerted: false, reason: 'OTHER_REGION', route: null },
    { robotId: 'SAME-1', zoneId: 'syn-east', relation: 'SAME_ZONE', routeIntersects: true, selected: true, alerted: true, reason: 'SAME_ZONE', route: route('OK') },
    { robotId: 'SIM-R', zoneId: 'syn-east', relation: 'REPORTER', routeIntersects: null, selected: false, alerted: false, reason: 'REPORTER', route: null },
    { robotId: 'X-CLEAR', zoneId: 'syn-west', relation: 'OTHER_ZONE', routeIntersects: false, selected: false, alerted: false, reason: 'ROUTE_CLEAR', route: route('OK') },
    { robotId: 'X-CROSS', zoneId: 'syn-west', relation: 'OTHER_ZONE', routeIntersects: true, selected: true, alerted: true, reason: 'ROUTE_CROSSES_OBSTACLE', route: route('OK') },
    { robotId: 'X-IDLE', zoneId: 'syn-west', relation: 'OTHER_ZONE', routeIntersects: null, selected: false, alerted: false, reason: 'NO_REMAINING_ROUTE', route: route('NO_LIVE_COMMITMENT') },
  ],
};
const VERDICT = { obstacleId: 'OBS-X', robotId: 'X-CROSS', relevant: true, routeSource: 'COMMANDED_ROUTE', decision: 'RELEVANT_NO_REPLAN', regionId: 'row-rnsit', zoneId: 'syn-east', reportingRobotId: 'SIM-R', timestamp: ALERT.timestamp + 500 };
const MERGED = { obstacleId: 'OBS-X', reportingRobotId: 'SIM-R2', originalReporterId: 'SIM-R', corroborations: ['SIM-R2'], repeat: false, regionId: 'row-rnsit', zoneId: 'syn-east', cellId: ALERT.cellId, lat: ALERT.lat, lon: ALERT.lon, timestamp: ALERT.timestamp + 900 };
const REJECTED = { reportingRobotId: 'SIM-Q', lat: 12.95, lon: 77.6, reason: 'UNASSIGNED_CELL', cellId: '8b0000000000fff', timestamp: ALERT.timestamp + 1200 };
const SERVER_EVENTS = [
  { seq: 1, event: 'ALERT_CREATED', payload: ALERT },
  { seq: 2, event: 'OBSTACLE_RELEVANCE', payload: VERDICT },
  { seq: 3, event: 'OBSTACLE_REPORT_MERGED', payload: MERGED },
  { seq: 4, event: 'OBSTACLE_REPORT_REJECTED', payload: REJECTED },
];

test('the activity model keeps the server decision record and the cross-zone list, as stated', () => {
  const state = applyObstacleEvent(EMPTY_ACTIVITY, OBSTACLE_EVENTS.ALERT_CREATED, ALERT);
  const o = state.obstacles[0];
  assert.deepEqual(o.recipients, ['SAME-1', 'X-CROSS']);
  assert.deepEqual(o.crossZoneRecipients, ['X-CROSS']);
  assert.equal(o.decisions.length, 6);
  assert.deepEqual(o.decisions.find((d) => d.robotId === 'X-IDLE'), {
    robotId: 'X-IDLE', zoneId: 'syn-west', relation: 'OTHER_ZONE', reason: 'NO_REMAINING_ROUTE', selected: false, alerted: false, routeIntersects: null, routeStatus: 'NO_LIVE_COMMITMENT', cut: null,
  });
  // An ALERT_CREATED from before the integration (no decision fields) still works.
  const legacy = applyObstacleEvent(EMPTY_ACTIVITY, OBSTACLE_EVENTS.ALERT_CREATED, { ...ALERT, recipientDecisions: undefined, crossZoneRecipients: undefined });
  assert.deepEqual(legacy.obstacles[0].decisions, []);
  assert.deepEqual(legacy.obstacles[0].crossZoneRecipients, []);
});

test('hydrate: the server events replay to the same state as live delivery, and replaying twice changes nothing', () => {
  let live = EMPTY_ACTIVITY;
  for (const e of SERVER_EVENTS) live = applyObstacleEvent(live, e.event, e.payload, ALERT.timestamp);
  const store = createObstacleActivityStore();
  assert.equal(store.hydrate(SERVER_EVENTS, ALERT.timestamp), true);
  const once = store.getSnapshot();
  assert.deepEqual(once.obstacles, live.obstacles);
  assert.deepEqual(once.refusals, live.refusals);
  store.hydrate(SERVER_EVENTS, ALERT.timestamp);
  const twice = store.getSnapshot();
  assert.deepEqual(twice.obstacles, once.obstacles);
  assert.equal(twice.refusals.length, 1, 'a replayed refusal is the same refusal, not a second');
  assert.equal(twice.obstacles[0].verdicts['X-CROSS'].relevant, true);
  assert.deepEqual(twice.obstacles[0].corroborations, ['SIM-R2']);
  assert.equal(store.hydrate([], ALERT.timestamp), false);
  assert.equal(store.hydrate(null, ALERT.timestamp), false);
});

test('hydrate after a live event (a reconnecting page) keeps the live verdicts and adds what was missed', () => {
  const store = createObstacleActivityStore();
  store.apply(OBSTACLE_EVENTS.ALERT_CREATED, ALERT, ALERT.timestamp);
  store.hydrate(SERVER_EVENTS, ALERT.timestamp);
  const o = store.getSnapshot().obstacles.find((x) => x.obstacleId === 'OBS-X');
  assert.equal(o.verdicts['X-CROSS'].decision, 'RELEVANT_NO_REPLAN');
  assert.equal(store.getSnapshot().obstacles.length, 1);
});

function renderPanel(state) {
  const view = activityEntries(state, { regionIds: null });
  const entry = view.entries.find((e) => e.kind === 'OBSTACLE');
  return renderToStaticMarkup(
    React.createElement(ObstacleActivityPanel, {
      connectionState: CONNECTION.CONNECTED,
      entries: view.entries,
      hiddenCount: view.hiddenCount,
      campusName: 'RNSIT',
      filter: 'ALL',
      onFilter: () => {},
      selectedObstacle: entry.obstacle,
      onSelect: () => {},
      onFocus: () => {},
      zoneNameOf: () => 'SYNTHETIC TEST — East half',
      robotsById: new Map([['SIM-R', { robotId: 'SIM-R', simulated: true }]]),
      nowMs: ALERT.timestamp + 1000,
      initiallyOpen: true,
    }),
  );
}

test('the panel says why each robot was alerted, marks the cross-zone one, and lists who was not alerted and why', () => {
  let state = applyObstacleEvent(EMPTY_ACTIVITY, OBSTACLE_EVENTS.ALERT_CREATED, ALERT);
  state = applyObstacleEvent(state, OBSTACLE_EVENTS.RELEVANCE, VERDICT);
  const html = renderPanel(state);
  assert.match(html, /X-CROSS<\/span>.*?cross-zone/s);
  assert.match(html, /other zone — its remaining route crosses the obstacle/);
  assert.match(html, /SAME-1<\/span>.*?same zone/s);
  assert.match(html, /Considered, not alerted \(3\)/);
  assert.match(html, /X-CLEAR<\/span><span class="map-obstacle__why">other zone — remaining route clear of the obstacle<\/span>/);
  assert.match(html, /X-IDLE<\/span><span class="map-obstacle__why">other zone — no commanded route \(idle\)<\/span>/);
  assert.match(html, /B-1<\/span><span class="map-obstacle__why">another region — never alerted<\/span>/);
  // The reporter is the reporter, not "considered, not alerted"; reroute is still stated as unavailable.
  assert.doesNotMatch(html, /SIM-R<\/span><span class="map-obstacle__why">/);
  assert.match(html, /Reroute: not available/);
});

test('the G4 preview layers: a casing and a cell grid, both in the outline group, sourced from their own data', () => {
  const ids = dtaroLayerSpecs().map((l) => l.id);
  for (const id of [DTARO_LAYER.PREVIEW_CELLS, DTARO_LAYER.PREVIEW_CASING, DTARO_LAYER.PREVIEW_LINE]) assert.ok(ids.includes(id));
  assert.deepEqual(ids, [...DTARO_LAYER_ORDER]);
  const order = (id) => DTARO_LAYER_ORDER.indexOf(id);
  assert.ok(order(DTARO_LAYER.PREVIEW_CELLS) < order(DTARO_LAYER.PREVIEW_CASING));
  assert.ok(order(DTARO_LAYER.PREVIEW_CASING) < order(DTARO_LAYER.PREVIEW_LINE));
  const cells = dtaroLayerSpecs().find((l) => l.id === DTARO_LAYER.PREVIEW_CELLS);
  assert.equal(cells.source, DTARO_SOURCE.PREVIEW_CELLS);
  const line = dtaroLayerSpecs().find((l) => l.id === DTARO_LAYER.PREVIEW_LINE);
  assert.ok(Array.isArray(line.paint['line-dasharray']), 'the proposal stays dashed, unlike the published solid line');
});
