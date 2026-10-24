/**
 * DTARO operator decisions in the dashboard: the decision panel rendered (Vite's own transform +
 * `react-dom/server`, as `obstacleActivityPanel.test.mjs` does), the decision history, the map
 * layers (collections, Mapbox's own style-spec validator, idempotent install on the fake map) and
 * the AppProvider wiring (read from the source, like `dtaroObstacleWiring.test.mjs`).
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';

import { CONNECTION } from '../../../lib/connectionState.js';
import { applyDecision, EMPTY_DECISIONS } from '../../../lib/obstacleDecision.js';
import {
  DECISION_LAYER_ORDER,
  DECISION_SOURCE,
  decisionLayerSpecs,
  installDecisionLayers,
  obstacleCollection,
  removeDecisionLayers,
  ringStateOf,
  robotCollection,
  routeCollection,
} from '../dtaro/decisionLayers.js';
import { createFakeMapboxMap } from './helpers/fakeMapboxMap.mjs';
import { sample } from './helpers/decisionFixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../../..');
const { validate: validateStyle } = createRequire(import.meta.url)('mapbox-gl/dist/style-spec/index.cjs');

/** A local import's file, with the extension Vite would have resolved. */
function resolveLocal(base) {
  for (const candidate of [base, `${base}.js`, `${base}.jsx`, path.join(base, 'index.js')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`cannot resolve ${base}`);
}

/**
 * The module URL of a source file: `.js` as is; `.jsx` compiled with Vite's own transform, its
 * imports rewritten the same way, recursively (the panel imports the `.jsx` UI primitives).
 */
const jsxUrls = new Map();
async function urlOf(file) {
  if (!file.endsWith('.jsx')) return pathToFileURL(file).href;
  if (jsxUrls.has(file)) return jsxUrls.get(file);
  const source = fs.readFileSync(file, 'utf8');
  const { code } = await transformWithOxc(source, file, { lang: 'jsx', jsx: { runtime: 'automatic' } });
  const specs = [...code.matchAll(/^import\b[^\n]*?\bfrom\s+(["'])([^"']+)\1/gm)].map((m) => m[2]);
  const targets = new Map();
  for (const spec of specs) {
    if (spec.startsWith('@/')) targets.set(spec, await urlOf(resolveLocal(path.join(SRC, spec.slice(2)))));
    else if (spec.startsWith('.')) targets.set(spec, await urlOf(resolveLocal(path.resolve(path.dirname(file), spec))));
    else targets.set(spec, import.meta.resolve(spec));
  }
  const absolute = code.replace(/^(import\b[^\n]*?\bfrom\s+)(["'])([^"']+)\2/gm, (_m, from, quote, spec) => `${from}${quote}${targets.get(spec)}${quote}`);
  const url = `data:text/javascript;base64,${Buffer.from(absolute).toString('base64')}`;
  jsxUrls.set(file, url);
  return url;
}
const loadJsx = async (file) => import(await urlOf(file));

const { ObstacleDecisionCard } = await loadJsx(path.resolve(SRC, 'components/modals/ObstacleDecisionPanel.jsx'));
const { ObstacleActivityPanel } = await loadJsx(path.resolve(HERE, '../mapControl/ui/ObstacleActivityPanel.jsx'));

const T0 = Date.UTC(2026, 9, 24, 6, 0, 0);
const P = (dx, dy = 0) => ({ lat: 12.9 + dy / 110574, lon: 77.5 + dx / 108500 });

const ROBOTS = [
  {
    robotId: 'SIM-R', name: 'Reporter', provenance: 'SIMULATED', role: 'REPORTER', affected: true, affectedReason: 'REPORTER_APPROACHING', state: 'ACTIVE',
    position: P(-10), origin: { name: 'MBA block', lat: 12.9, lon: 77.49 }, destination: { name: 'Library', lat: 12.91, lon: 77.51 },
    routeProgress: { fraction: 0.42, doneM: 120, totalM: 286 }, originalRoute: [P(-10), P(0), P(60)], preview: { ok: false, reason: 'ENDPOINT_IN_OBSTACLE' },
  },
  {
    robotId: 'SIM-A', provenance: 'SIMULATED', role: 'RECIPIENT', affected: true, affectedReason: 'ROUTE_CROSSES_OBSTACLE', state: 'ACTIVE',
    position: P(60), origin: null, destination: null, originalRoute: [P(60), P(0), P(-120)], preview: { ok: true, distanceM: 460, legs: 1 },
  },
  { robotId: 'SIM-I', provenance: 'SIMULATED', role: 'RECIPIENT', affected: false, affectedReason: 'SAME_ZONE_IDLE', alertedOnPropagation: true, state: 'IDLE', position: P(40, -70) },
  { robotId: 'B-1', provenance: 'SIMULATED', role: 'OTHER_REGION', affected: false, affectedReason: 'OTHER_REGION', position: P(-1500) },
];

const awaiting = () => applyDecision(EMPTY_DECISIONS, sample({ robots: ROBOTS, reporter: ROBOTS[0], obstacle: { ...sample().obstacle, severity: 'HIGH', detection: { source: 'SIMULATED_ROBOT_REPORT', confidence: null } } }), { receivedAtMs: T0 });
const render = (decision, props = {}) =>
  renderToStaticMarkup(React.createElement(ObstacleDecisionCard, { decision, nowMs: T0, offsetMs: 0, onDecide: () => {}, onClose: () => {}, ...props }));

// ── The panel ────────────────────────────────────────────────────────────────

test('awaiting: a visible 5 → 0 countdown, three enabled keyboard buttons, SIMULATED, the server default stated', () => {
  const d = awaiting().decisions[0];
  const html = render(d);
  assert.match(html, /role="timer"[^>]*data-countdown="5"/);
  assert.match(render(d, { nowMs: T0 + 3200 }), /data-countdown="2"/);
  assert.match(render(d, { nowMs: T0 + 9000 }), /data-countdown="0"/);
  for (const choice of ['STOP', 'REROUTE', 'REJECT_BROADCAST']) {
    const button = html.match(new RegExp(`<button[^>]*data-decision-action="${choice}"[^>]*>`))[0];
    assert.doesNotMatch(button, /\sdisabled=""/, choice);
    assert.match(button, /type="button"/);
  }
  assert.match(html, />Stop</);
  assert.match(html, />Reroute</);
  assert.match(html, />Reject broadcast</);
  assert.match(html, /data-simulated/);
  assert.match(html, /The server applies <strong>Reroute<\/strong>/);
  assert.match(html, /Close — the server still decides at the deadline/);
});

test('every detail is the server\'s, and an absent one reads "Unavailable" — nothing invented', () => {
  const html = render(awaiting().decisions[0]);
  assert.match(html, /Reporter \(SIM-R\)/);
  assert.match(html, /MBA block/);
  assert.match(html, /42 % of 286 m/);
  assert.match(html, /high \(as reported, advisory\)/);
  assert.match(html, /Simulated robot report · confidence Unavailable/);
  assert.match(html, /Potentially affected: 2 robots/);
  assert.match(html, /its remaining commanded route crosses the obstacle/);
  // SIM-A has no task row: origin and destination are unavailable, not guessed.
  const simA = html.match(/data-affected-robot="SIM-A"[\s\S]*?<\/li>/)[0];
  assert.match(simA, /Unavailable → Unavailable/);
  assert.match(simA, /alternate route available \(460 m\)/);
  assert.match(html, /no safe alternate route available — it would be stopped/);
  assert.match(html, /another region — never notified/);
});

test('the buttons are disabled once the countdown is spent, while sending, and once decided', () => {
  const d = awaiting().decisions[0];
  const disabledAll = (html) => ['STOP', 'REROUTE', 'REJECT_BROADCAST'].every((c) => /\sdisabled=""/.test(html.match(new RegExp(`<button[^>]*data-decision-action="${c}"[^>]*>`))[0]));
  assert.equal(disabledAll(render(d, { nowMs: T0 + 5000 })), true);
  assert.equal(disabledAll(render(d, { submitting: 'STOP' })), true);
  const decided = applyDecision(awaiting(), sample({ revision: 2, status: 'COMPLETED', robots: ROBOTS, decision: { choice: 'REROUTE', source: 'DEFAULT_TIMEOUT', decidedAt: new Date(T0 + 5000).toISOString(), reason: 'No operator decision reached the server within 5 s' } }), { receivedAtMs: T0 }).decisions[0];
  const html = render(decided);
  assert.equal(disabledAll(html), true);
  assert.match(html, /data-decision-source="DEFAULT_TIMEOUT"/);
  assert.match(html, /applied automatically by the server: no operator decision within 5 s/);
  assert.match(html, /Automatic · committed/);
  assert.doesNotMatch(html, /role="timer"/);
});

test('a rejected broadcast says the alert was suppressed, for whom, and that the obstacle is not confirmed absent', () => {
  const d = applyDecision(awaiting(), sample({ revision: 2, status: 'COMPLETED', robots: ROBOTS, decision: { choice: 'REJECT_BROADCAST', source: 'MANUAL', decidedAt: new Date(T0 + 2000).toISOString() }, propagation: { outcome: 'SUPPRESSED', delivered: [], suppressedRecipients: ['SIM-A', 'SIM-I'] } }), { receivedAtMs: T0 }).decisions[0];
  const html = render(d);
  assert.match(html, /Broadcast rejected — fleet alert suppressed for 2 robot\(s\): SIM-A, SIM-I\. The obstacle is not confirmed absent\./);
  assert.match(html, /Manual · committed/);
});

test("a refusal from the server is announced (role=alert); the narrow layout stacks the actions and scrolls", () => {
  const html = render(awaiting().decisions[0], { message: "Too late: the server's deadline passed and it applied its default." });
  assert.match(html, /role="alert"[^>]*>Too late/);
  assert.match(html, /grid grid-cols-1 gap-2 sm:grid-cols-3/);
  const source = fs.readFileSync(path.resolve(SRC, 'components/modals/ObstacleDecisionPanel.jsx'), 'utf8');
  assert.match(source, /role="alertdialog"/);
  assert.match(source, /max-h-\[92vh\] max-w-2xl overflow-y-auto/);
});

test('the panel claims nothing physical, and the information-only modal is still mounted (FS-06)', () => {
  const source = fs.readFileSync(path.resolve(SRC, 'components/modals/ObstacleDecisionPanel.jsx'), 'utf8');
  assert.match(source, /No physical robot is involved/);
  assert.doesNotMatch(source, /auto-?rerout/i);
  // The information-only modal itself is held by syncTruth.test.mjs (FS-06); the layout still mounts it.
  const layout = fs.readFileSync(path.resolve(SRC, 'router/layout.jsx'), 'utf8');
  assert.match(layout, /<DecisionRequiredModal decisionRequest=\{decisionRequest\} onDismiss=\{handleDismissAlert\} \/>/);
});

test('one idempotency key per decision, reused for every retry of it', () => {
  const source = fs.readFileSync(path.resolve(SRC, 'components/modals/ObstacleDecisionPanel.jsx'), 'utf8');
  assert.match(source, /if \(!keys\.current\.has\(id\)\) keys\.current\.set\(id, newIdempotencyKey\(\)\);/);
  assert.match(source, /submitObstacleDecision\(id, choice, keys\.current\.get\(id\)\)/);
});

// ── The decision history (activity panel) ───────────────────────────────────

test('the history lists each decision: choice, manual or automatic, counts and the final state', () => {
  const executing = { ...ROBOTS[1], execution: { action: 'REROUTE', state: 'MOVING', progress: { fraction: 0.5 } } };
  const d = applyDecision(EMPTY_DECISIONS, sample({ revision: 3, status: 'EXECUTING', robots: [ROBOTS[0], executing], decision: { choice: 'REROUTE', source: 'DEFAULT_TIMEOUT' }, propagation: { outcome: 'PROPAGATED', delivered: ['SIM-A', 'SIM-I'] }, counts: { affected: 2, delivered: 2, suppressed: 0, rerouted: 1, noSafeRoute: 1, stopped: 1 } }), { receivedAtMs: T0 }).decisions;
  const html = renderToStaticMarkup(
    React.createElement(ObstacleActivityPanel, {
      connectionState: CONNECTION.CONNECTED, entries: [], filter: 'ALL', onFilter: () => {}, selectedObstacle: null, onSelect: () => {}, onFocus: () => {},
      zoneNameOf: () => null, robotsById: new Map(), nowMs: T0, initiallyOpen: true, decisions: d,
    })
  );
  assert.match(html, /data-decision-history/);
  assert.match(html, /<strong>Reroute<\/strong>/);
  assert.match(html, /automatic \(server default\)/);
  assert.match(html, /alerted 2/);
  assert.match(html, /rerouted 1/);
  assert.match(html, /no safe route 1/);
  assert.match(html, /Simulated robots executing/);
});

test('feature off: no decision section, and the OD-3 note is unchanged', () => {
  const html = renderToStaticMarkup(
    React.createElement(ObstacleActivityPanel, {
      connectionState: CONNECTION.CONNECTED, entries: [], filter: 'ALL', onFilter: () => {}, selectedObstacle: null, onSelect: () => {}, onFocus: () => {},
      zoneNameOf: () => null, robotsById: new Map(), nowMs: T0, initiallyOpen: true,
    })
  );
  assert.doesNotMatch(html, /data-decision-history/);
});

// ── The map layers ───────────────────────────────────────────────────────────

test('original routes are dashed and alternate routes solid; both come only from the server record', () => {
  const rerouted = { ...ROBOTS[1], execution: { state: 'MOVING', originalPath: [P(60), P(0), P(-120)], alternatePath: [P(60), P(120), P(120, 80), P(-120, 80), P(-120)] } };
  const routes = routeCollection([sample({ robots: [ROBOTS[0], rerouted, ROBOTS[2]] })]);
  assert.deepEqual(routes.features.map((f) => [f.properties.robotId, f.properties.kind]), [['SIM-R', 'ORIGINAL'], ['SIM-A', 'ORIGINAL'], ['SIM-A', 'ALTERNATE']]);
  const original = decisionLayerSpecs().find((s) => s.id === 'robotx-dtaro-decision-original');
  assert.ok(Array.isArray(original.paint['line-dasharray']));
  assert.equal(decisionLayerSpecs().find((s) => s.id === 'robotx-dtaro-decision-alternate').paint['line-dasharray'], undefined);
});

test('robot rings tell affected from unaffected and show what happened; other regions are not drawn', () => {
  assert.equal(ringStateOf({ affected: true }), 'AFFECTED');
  assert.equal(ringStateOf({ affected: false }), 'UNAFFECTED');
  assert.equal(ringStateOf({ affected: true, execution: { state: 'STOPPED_NO_SAFE_ROUTE' } }), 'NO_SAFE_ROUTE');
  assert.equal(ringStateOf({ affected: true, execution: { state: 'MOVING' } }), 'MOVING');
  assert.equal(ringStateOf({ affected: true, execution: { state: 'COMPLETED' } }), 'COMPLETED');
  const rings = robotCollection([sample({ robots: ROBOTS })], new Map([['SIM-A', P(55)]]));
  assert.deepEqual(rings.features.map((f) => [f.properties.robotId, f.properties.state]), [['SIM-R', 'AFFECTED'], ['SIM-A', 'AFFECTED'], ['SIM-I', 'UNAFFECTED']]);
  // The live position wins over the one recorded at the decision.
  assert.deepEqual(rings.features[1].geometry.coordinates, [P(55).lon, P(55).lat]);
  // Older decisions ring only the robots they affected; the newest also rings the unaffected.
  const older = sample({ decisionId: 'older', robots: [{ robotId: 'OLD-AFFECTED', affected: true, position: P(1) }, { robotId: 'OLD-CLEAR', affected: false, position: P(2) }] });
  const two = robotCollection([sample({ robots: ROBOTS }), older], new Map());
  assert.deepEqual(two.features.map((f) => f.properties.robotId).filter((id) => id.startsWith('OLD')), ['OLD-AFFECTED']);
});

test('the obstacle shows the decision state: awaiting, the choice (default marked), rejected, expired', () => {
  const state = (d, now = T0) => obstacleCollection([d], now).features[0].properties;
  assert.match(state(sample()).label, /SIMULATED · Awaiting decision/);
  assert.match(state(sample({ decision: { choice: 'REROUTE', source: 'DEFAULT_TIMEOUT' } })).label, /Reroute \(default\)/);
  assert.equal(state(sample({ decision: { choice: 'REJECT_BROADCAST', source: 'MANUAL' } })).state, 'REJECTED');
  assert.equal(state(sample(), T0 + 400_000).state, 'EXPIRED');
});

test('every decision layer passes the Mapbox style-spec validator', () => {
  const sources = {};
  for (const id of Object.values(DECISION_SOURCE)) sources[id] = { type: 'geojson', data: { type: 'FeatureCollection', features: [] } };
  const errors = validateStyle({ version: 8, glyphs: 'mapbox://fonts/mapbox/{fontstack}/{range}.pbf', sources, layers: decisionLayerSpecs() });
  assert.deepEqual(errors.map((e) => e.message), []);
});

test('install is idempotent (a style reload restores exactly one copy) and removal removes all', () => {
  const map = createFakeMapboxMap({ loaded: true });
  assert.equal(installDecisionLayers(map).installed, DECISION_LAYER_ORDER.length);
  assert.equal(installDecisionLayers(map).installed, DECISION_LAYER_ORDER.length);
  removeDecisionLayers(map);
  for (const id of DECISION_LAYER_ORDER) assert.equal(map.getLayer(id), undefined);
});

// ── Wiring ───────────────────────────────────────────────────────────────────

test('AppProvider: each decision event subscribed once and unsubscribed once, on the reconnect-safe effect', () => {
  const provider = fs.readFileSync(path.resolve(SRC, 'context/AppProvider.jsx'), 'utf8');
  for (const event of ['OBSTACLE_DECISION_REQUIRED', 'OBSTACLE_DECISION_UPDATED']) {
    assert.equal((provider.match(new RegExp(`socket\\.on\\(DASHBOARD_EVENTS\\.${event}, onObstacleDecision\\)`, 'g')) || []).length, 1, event);
    assert.equal((provider.match(new RegExp(`socket\\.off\\(DASHBOARD_EVENTS\\.${event}, onObstacleDecision\\)`, 'g')) || []).length, 1, event);
  }
  assert.match(provider, /getDtaroDecisions\(\)\s*\.then\(\(\{ decisions \}\) => obstacleDecisionStore\.hydrate\(decisions, asked, Date\.now\(\)\)\)/);
  const start = provider.indexOf('const clearSessionState = useCallback(() => {');
  assert.match(provider.slice(start, provider.indexOf('}, []);', start)), /obstacleDecisionStore\.reset\(\);/);
});

test('the map draws decisions only when the server has operator decisions on', () => {
  const page = fs.readFileSync(path.resolve(SRC, 'features/maps/MapControl.jsx'), 'utf8');
  assert.match(page, /const operatorDecisionsEnabled = alertsEnabled && dtaroView\?\.operatorDecisionsEnabled === true;/);
  assert.match(page, /enabled: operatorDecisionsEnabled,/);
});
