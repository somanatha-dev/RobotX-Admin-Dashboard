/**
 * ROUTE RESTORATION — a robot's route stays on the map across navigation and style reloads.
 *
 *   node --test src/features/maps/__architecture__/routeRestoration.test.mjs
 *
 * The defect (found 2026-10-13): navigating away tears the Mapbox map down; coming back builds
 * a new one, and the hook replays the cached routes immediately — before the new style has
 * loaded. Mapbox throws "Style is not done loading" from addSource/addLayer, the overlay code
 * swallows it, and the route was nevertheless recorded as drawn with its progress signature.
 * From then on the redraw guard (`existing.signature === signature`) skipped it, so a robot
 * standing still (waiting at a pickup, held, verifying) never got its route back, and a moving
 * one only when its progress happened to change. The `style.load` handler was an empty loop.
 *
 * The draw path below is the hook's own (`upsertRoutes`, reduced to its Mapbox half) driving
 * the real `routeOverlay.js` against a fake map that refuses layers until its style loads,
 * exactly as mapbox-gl 3.20 does.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createFlowAnimator,
  ensureLineLayer,
  routeLayersPresent,
  shouldRedrawRoute,
} from '../operational/routeOverlay.js';
import { CHARGING_LAYER, CHARGING_STATION_FLOOR_LAYER, installChargingLayers } from '../charging/stationLayers.js';
import { applyRerouteToCache, replayableRoutes } from '../../../lib/liveState.js';
import { createFakeMapboxMap } from './helpers/fakeMapboxMap.mjs';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const code = (rel) =>
  fs
    .readFileSync(path.join(SRC, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const LINE = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: [[77.5176, 12.9007], [77.5177, 12.9010]] }, properties: {} }] };
const ids = (robotId) => ({
  todo: { sourceId: `robot-route-drop-todo-src-${robotId}`, layerId: `robot-route-drop-todo-layer-${robotId}` },
  done: { sourceId: `robot-route-drop-done-src-${robotId}`, layerId: `robot-route-drop-done-layer-${robotId}` },
});

/**
 * The Mapbox half of `upsertRoutes`, with the guard under test passed in. Returns whether it
 * drew. `routes` is the hook's `routesRef`.
 */
function upsert(map, routes, robotId, signature, { guard }) {
  const existing = routes.get(robotId) || null;
  if (!guard(existing, signature, map)) return false;
  const { todo, done } = ids(robotId);
  ensureLineLayer({ map, ...todo, data: LINE, color: '#4f46e5', dashed: false, opacity: 0.95, theme: null, flow: true, beforeId: CHARGING_STATION_FLOOR_LAYER });
  ensureLineLayer({ map, ...done, data: LINE, color: '#4f46e5', dashed: false, opacity: 0.3, theme: null, flow: false, beforeId: CHARGING_STATION_FLOOR_LAYER });
  const drawnLayerIds = [todo.layerId, done.layerId];
  const drawn = routeLayersPresent(map, drawnLayerIds);
  routes.set(robotId, { taskId: 'T1', signature: drawn ? signature : null, drawnLayerIds });
  return true;
}
const OLD_GUARD = (existing, signature) => !(existing && existing.signature === signature);
const OLD_RECORD = (map, routes, robotId, signature) => {
  // The old hook recorded the signature unconditionally.
  upsert(map, routes, robotId, signature, { guard: OLD_GUARD });
  routes.get(robotId).signature = signature;
};

test('BEFORE (reproduction): replay before style load + stationary robot → the route never comes back', () => {
  const map = createFakeMapboxMap({ loaded: false });
  const routes = new Map();
  OLD_RECORD(map, routes, 'SIM-1', 'T1|1|TO_DROP|1|0|3|1200'); // remount replay
  map.finishStyleLoad(); // the old style.load handler did nothing
  for (let tick = 0; tick < 30; tick += 1) OLD_RECORD(map, routes, 'SIM-1', 'T1|1|TO_DROP|1|0|3|1200'); // a minute standing still
  assert.equal(map.getLayer(ids('SIM-1').todo.layerId), undefined, 'the defect: no route line after a minute of ticks');
});

test('AFTER: a draw the style refused is not recorded as drawn; the restore on style.load draws it with no telemetry', () => {
  const map = createFakeMapboxMap({ loaded: false });
  const routes = new Map();
  upsert(map, routes, 'SIM-1', 'S', { guard: shouldRedrawRoute });
  assert.equal(routes.get('SIM-1').signature, null, 'refused draw → signature not recorded');
  assert.equal(map.layerIds().length, 0);

  // `restoreRoutes` is registered on style.load: it re-runs upsert for every held route.
  map.on('style.load', () => upsert(map, routes, 'SIM-1', 'S', { guard: shouldRedrawRoute }));
  map.finishStyleLoad();
  assert.ok(map.getLayer(ids('SIM-1').todo.layerId), 'route line present after style.load');
  assert.equal(routes.get('SIM-1').signature, 'S');
  // Further identical ticks are no-ops (no redundant source writes).
  assert.equal(upsert(map, routes, 'SIM-1', 'S', { guard: shouldRedrawRoute }), false);
});

test('a style reload (setStyle) that discards the route is redrawn — exactly one copy of every layer', () => {
  const map = createFakeMapboxMap({ loaded: true });
  const routes = new Map();
  upsert(map, routes, 'SIM-1', 'S', { guard: shouldRedrawRoute });
  const before = map.layerIds();
  map.setStyle();
  map.on('style.load', () => upsert(map, routes, 'SIM-1', 'S', { guard: shouldRedrawRoute }));
  map.finishStyleLoad();
  assert.deepEqual(map.layerIds(), before, 'the same layers, once each, in the same order');
  assert.deepEqual(map.errors, [], 'no duplicate-layer or missing-source errors');
});

test('ensureLineLayer is idempotent: repeated calls add nothing and only push data', () => {
  const map = createFakeMapboxMap({ loaded: true });
  const { todo } = ids('SIM-2');
  for (let i = 0; i < 5; i += 1) {
    ensureLineLayer({ map, ...todo, data: LINE, color: '#000', dashed: true, opacity: 1, theme: null, flow: true });
  }
  assert.deepEqual(map.layerIds(), [`${todo.layerId}-glow`, `${todo.layerId}-casing`, todo.layerId, `${todo.layerId}-flow`]);
  assert.equal(map.getSource(todo.sourceId).setDataCalls, 4);
  assert.deepEqual(map.errors, []);
});

test('routes are stacked beneath the charging stations, in either install order', () => {
  // Stations first, then a route.
  const a = createFakeMapboxMap({ loaded: true });
  installChargingLayers(a);
  upsert(a, new Map(), 'SIM-1', 'S', { guard: shouldRedrawRoute });
  const la = a.layerIds();
  assert.ok(la.indexOf(ids('SIM-1').todo.layerId) < la.indexOf(CHARGING_STATION_FLOOR_LAYER));
  assert.ok(la.indexOf(CHARGING_LAYER.ROUTE) < la.indexOf(`${ids('SIM-1').todo.layerId}-glow`), 'charger route under task route');

  // A route first, then stations: stations land on top, and the charger route goes beneath the task route.
  const b = createFakeMapboxMap({ loaded: true });
  upsert(b, new Map(), 'SIM-1', 'S', { guard: shouldRedrawRoute });
  installChargingLayers(b);
  const lb = b.layerIds();
  assert.ok(lb.indexOf(ids('SIM-1').todo.layerId) < lb.indexOf(CHARGING_STATION_FLOOR_LAYER));
  assert.ok(lb.indexOf(CHARGING_LAYER.ROUTE) < lb.indexOf(`${ids('SIM-1').todo.layerId}-glow`));
  assert.deepEqual([...a.errors, ...b.errors], []);
});

test('route flow animation: no timer under reduced motion, no paint writes in a background tab, stops with no routes', async () => {
  const map = createFakeMapboxMap({ loaded: true });
  const { todo } = ids('SIM-1');
  ensureLineLayer({ map, ...todo, data: LINE, color: '#000', dashed: false, opacity: 1, theme: null, flow: true });
  const flowIds = [`${todo.layerId}-flow`];

  const reduced = createFlowAnimator(() => map, () => flowIds, { reducedMotion: () => true });
  reduced.start();
  assert.equal(reduced.isRunning(), false, 'reduced motion: never started');

  let visible = false;
  const hidden = createFlowAnimator(() => map, () => flowIds, { visible: () => visible });
  hidden.start();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(map.paintWrites.length, 0, 'background tab: no repaint requests');
  visible = true;
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(map.paintWrites.length > 0, 'visible: the dash moves');
  hidden.stop();

  const empty = createFlowAnimator(() => map, () => []);
  empty.start();
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(empty.isRunning(), false, 'no flow layers → the timer stops itself');
});

test('a REROUTED leg lands in the provider cache, so the map replays the new path after navigation', () => {
  const P = [[1, 1], [2, 2]];
  const D = [[2, 2], [3, 3]];
  const NEW = [[2, 2], [2.5, 2.7], [3, 3]];
  const cache = new Map([['T1', { taskId: 'T1', robotId: 'SIM-1', pathToPickup: P, pathToDrop: D }]]);
  assert.equal(applyRerouteToCache(cache, { taskId: 'T1', robotId: 'SIM-1', action: 'REROUTED', segment: 'toDrop', newPath: NEW }), true);
  const [replayed] = replayableRoutes(cache, { activeRobotIds: new Set(['SIM-1']), drawnRobotIds: new Map() });
  assert.deepEqual(replayed.pathToDrop, NEW, 'remount replays the replanned leg, not the one the robot left');
  assert.deepEqual(replayed.pathToPickup, P);
  // The same leg reading as the map's handler: an absent segment is the approach leg.
  applyRerouteToCache(cache, { taskId: 'T1', action: 'REROUTED', newPath: NEW });
  assert.deepEqual(cache.get('T1').pathToPickup, NEW);
  // Not a reroute, an empty path, or a task the cache does not hold: unchanged.
  assert.equal(applyRerouteToCache(cache, { taskId: 'T1', action: 'ASSIGNED', newPath: NEW }), false);
  assert.equal(applyRerouteToCache(cache, { taskId: 'T1', action: 'REROUTED', newPath: [] }), false);
  assert.equal(applyRerouteToCache(cache, { taskId: 'T9', action: 'REROUTED', newPath: NEW }), false);
  assert.equal(cache.get('T1').robotId, 'SIM-1', 'never re-assigns the task');
});

test('wiring: the hook restores on style.load and on load, records only verified draws, and MapControl feeds it isMapLoaded', () => {
  const hook = code('features/maps/mapControl/hooks/useRobotStream.js');
  assert.match(hook, /map\.on\('style\.load', restoreRoutes\)/);
  assert.match(hook, /map\.off\('style\.load', restoreRoutes\)/);
  assert.match(hook, /if \(isMapLoaded\) restoreRoutes\(\);/);
  assert.match(hook, /if \(!shouldRedrawRoute\(existing, signature, map\)\) return;/);
  assert.match(hook, /signature: drawn \? signature : null,/);
  assert.doesNotMatch(hook, /existing\.signature === signature\) return/, 'the signature-only guard is gone');
  const control = code('features/maps/MapControl.jsx');
  assert.match(control, /useRobotStream\(\{[\s\S]*?isMapLoaded,[\s\S]*?\}\);/);
  // The provider writes reroutes into the shared cache.
  assert.match(code('context/AppProvider.jsx'), /applyRerouteToCache\(taskPathCacheRef\.current, data\);/);
});

test('wiring: every map/socket/media listener the overlays add is removed by the same effect', () => {
  const pairs = (src, re) => [...src.matchAll(re)].length;
  for (const rel of ['features/maps/mapControl/hooks/useRobotStream.js', 'features/maps/charging/useChargingLayer.js']) {
    const src = code(rel);
    for (const [on, off] of [
      [/map\.on\(/g, /map\.off\(/g],
      [/socket\.on\(/g, /socket\.off\(/g],
      [/subscribeReducedMotion\(/g, /unsubscribe(ReducedMotion)?\(\)/g],
    ]) {
      assert.ok(pairs(src, off) >= pairs(src, on), `${rel}: ${on} has a matching ${off}`);
    }
    assert.ok(pairs(src, /setInterval\(/g) <= pairs(src, /clearInterval\(/g), `${rel}: every interval is cleared`);
  }
});

test('campus geometry is installed BENEATH routes and stations (browser-observed: campus fills hid the depot and would hide routes)', async () => {
  // Observed in headless Chrome, 2026-10-13: with RNSIT selected, the layer order was
  // [charging routes, station shadow/model/light/ring/badge/icon, CAMPUS fills/roads/buildings, station label, campus labels].
  // The campus anchored beneath the first text symbol — our station label — so its ground fill covered the
  // depot's 3D model, and every task route (inserted beneath the station floor) sat under the campus too.
  const { installSourcesAndLayers } = await import('../campus/useCampusLayer.js');
  const { CAMPUS_LAYER_ORDER, campusLayerSpecs } = await import('../campus/campusLayers.js');
  const map = createFakeMapboxMap({ loaded: true });
  installChargingLayers(map); // at map load
  upsert(map, new Map(), 'SIM-1', 'S', { guard: shouldRedrawRoute }); // a route
  installSourcesAndLayers(map); // the campus, at environment-ready — after both, as in the browser

  const order = map.layerIds();
  const at = (id) => order.indexOf(id);
  const specs = campusLayerSpecs();
  const labelIds = new Set(specs.filter((s) => s.type === 'symbol').map((s) => s.id));
  // The vendor `clip` layer paints nothing: scoped to the basemap import, it removes vendor
  // buildings wherever it sits, and the existing install appends it on purpose.
  const clipIds = new Set(specs.filter((s) => s.type === 'clip').map((s) => s.id));
  const geometry = CAMPUS_LAYER_ORDER.filter((id) => !labelIds.has(id) && !clipIds.has(id) && at(id) >= 0);
  const overlay = order.filter((id) => id.startsWith('robotx-charging-') || id.startsWith('robot-route-'));
  assert.ok(geometry.length > 5, 'campus geometry installed');
  const lowestOverlay = Math.min(...overlay.map(at));
  for (const id of geometry) assert.ok(at(id) < lowestOverlay, `${id} must be beneath every route and station layer`);
  for (const id of labelIds) if (at(id) >= 0) assert.ok(at(id) > at(CHARGING_STATION_FLOOR_LAYER), `${id}: campus labels stay on top`);
  // And the route is still beneath the stations.
  assert.ok(at(ids('SIM-1').todo.layerId) < at(CHARGING_STATION_FLOOR_LAYER));
  assert.deepEqual(map.errors, []);
});
