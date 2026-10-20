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
 * 2026-10-20: the overlay is one shared source and nine fixed layers for every robot
 * (operational/routeOverlay.js), and the animated flow dash — a `line-dasharray` relayout every
 * 70 ms — is a static direction mark. The guarantees below are unchanged; the layer ids are the
 * shared ones.
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
  DIRECTION_KIND,
  ROUTE_LAYER,
  ROUTE_LAYER_ORDER,
  ROUTE_SOURCE,
  createRouteFlusher,
  directionMarks,
  ensureRouteLayers,
  removeRouteLayers,
  routeFeatures,
  routeLayerSpecs,
  routeLayersPresent,
  setRouteData,
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

const PATH = [[77.5176, 12.9007], [77.5177, 12.901], [77.5179, 12.9012]];
const segmentsIn = (map) => map.getSource(ROUTE_SOURCE).data.features.filter((f) => f.properties.kind !== DIRECTION_KIND);
const featuresFor = (robotId) =>
  routeFeatures({ robotId, taskId: `T-${robotId}`, color: '#4f46e5', pickup: { travelled: PATH.slice(0, 2), ahead: PATH.slice(1) }, drop: { ahead: PATH } });

/**
 * The Mapbox half of `upsertRoutes`, with the guard under test passed in. Returns whether it
 * drew. `routes` is the hook's `routesRef`; `held` its per-robot features.
 */
function upsert(map, routes, robotId, signature, { guard, held = new Map() }) {
  const existing = routes.get(robotId) || null;
  if (!guard(existing, signature, map)) return false;
  ensureRouteLayers(map, { theme: null, beforeId: CHARGING_STATION_FLOOR_LAYER });
  held.set(robotId, featuresFor(robotId));
  setRouteData(map, [...held.values()].flat());
  const drawnLayerIds = ROUTE_LAYER_ORDER;
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
  assert.equal(map.getLayer(ROUTE_LAYER.DROP_TODO), undefined, 'the defect: no route line after a minute of ticks');
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
  assert.ok(map.getLayer(ROUTE_LAYER.DROP_TODO), 'route line present after style.load');
  assert.equal(segmentsIn(map).length, 3, "the robot's segments are in the source");
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

test('ensureRouteLayers is idempotent: repeated calls add nothing', () => {
  const map = createFakeMapboxMap({ loaded: true });
  for (let i = 0; i < 5; i += 1) ensureRouteLayers(map);
  assert.deepEqual(map.layerIds(), [...ROUTE_LAYER_ORDER]);
  assert.deepEqual(map.sourceIds(), [ROUTE_SOURCE]);
  assert.deepEqual(map.errors, []);
});

test('one source and nine layers at any fleet size (was four sources and up to sixteen layers PER robot)', () => {
  const map = createFakeMapboxMap({ loaded: true });
  const routes = new Map();
  const held = new Map();
  for (let i = 0; i < 20; i += 1) upsert(map, routes, `SIM-${i}`, 'S', { guard: shouldRedrawRoute, held });
  assert.equal(map.sourceIds().length, 1);
  assert.equal(map.layerIds().length, ROUTE_LAYER_ORDER.length);
  assert.equal(segmentsIn(map).length, 20 * 3, "every robot's segments, in the one source");
  const robots = new Set(map.getSource(ROUTE_SOURCE).data.features.map((f) => f.properties.robotId));
  assert.equal(robots.size, 20);
  // A robot's colour travels on its features, so twenty robots need no per-robot layer.
  for (const spec of routeLayerSpecs()) {
    // Casings take the theme's halo; the direction layer is drawn from its pattern.
    if (spec.type === 'line' && ![ROUTE_LAYER.CASING_PICKUP, ROUTE_LAYER.CASING_DROP, ROUTE_LAYER.DIRECTION].includes(spec.id)) {
      assert.deepEqual(spec.paint['line-color'], ['get', 'color'], `${spec.id} is coloured per feature`);
    }
  }
});

test('route features: four segments by leg and part, and a degenerate segment draws nothing', () => {
  const f = routeFeatures({ robotId: 'R', taskId: 'T', color: '#123456', pickup: { travelled: PATH, ahead: PATH }, drop: { travelled: PATH, ahead: PATH } }).filter(
    (x) => x.properties.kind !== DIRECTION_KIND
  );
  assert.deepEqual(f.map((x) => `${x.properties.leg}:${x.properties.part}`), ['pickup:done', 'pickup:todo', 'drop:done', 'drop:todo']);
  for (const x of f) assert.deepEqual(x.geometry.coordinates, PATH, 'coordinates are the route data, untouched');
  assert.equal(routeFeatures({ robotId: 'R', taskId: 'T', color: '#000', pickup: { travelled: [PATH[0]], ahead: [] }, drop: {} }).length, 0);
});

test('direction chevrons: on ahead segments only, pointing along the route, every ~9 m, route untouched', () => {
  // A straight 100 m eastward segment at RNSIT's latitude.
  const lat = 12.9023;
  const lng0 = 77.5186;
  const dLng = 100 / (111320 * Math.cos((lat * Math.PI) / 180));
  const east = [[lng0, lat], [lng0 + dLng, lat]];
  const marks = directionMarks(east);
  assert.equal(marks.length, 11, 'first at 4.5 m, then every 9 m to 94.5 m');
  for (const [armA, tip, armB] of marks) {
    assert.ok(armA[0] < tip[0] && armB[0] < tip[0], 'both arms trail the tip: the chevron points east, the way the route runs');
    assert.ok(armA[1] !== armB[1], 'one arm each side of the route');
    assert.ok(Math.abs(tip[1] - lat) < 1e-12, 'the tip lies on the route');
  }
  // Reversed route → reversed chevrons.
  const [[a, tip]] = directionMarks([...east].reverse());
  assert.ok(a[0] > tip[0], 'westward route: the chevron points west');
  assert.deepEqual(directionMarks([east[0]]), [], 'a degenerate segment has no direction');

  const f = routeFeatures({ robotId: 'R', taskId: 'T', color: '#000', pickup: { travelled: east }, drop: { ahead: east } });
  assert.equal(f.filter((x) => x.properties.kind === DIRECTION_KIND).length, 11, 'chevrons only on the segment still ahead');
  assert.deepEqual(f.find((x) => x.properties.part === 'todo').geometry.coordinates, east, 'the route itself is unchanged');
});

test('direction is drawn, not animated: nothing writes to the style while nothing changes', async () => {
  const map = createFakeMapboxMap({ loaded: true });
  upsert(map, new Map(), 'SIM-1', 'S', { guard: shouldRedrawRoute });
  const writes = map.paintWrites.length;
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(map.paintWrites.length, writes, 'no timer steps any paint property');
  // `line-dasharray` is a layout-time property in mapbox-gl v3 (changing it re-tiles the source),
  // so it is set once, on the approach leg, and never written again.
  const dashed = routeLayerSpecs().filter((s) => s.paint?.['line-dasharray']).map((s) => s.id);
  assert.deepEqual(dashed, [ROUTE_LAYER.PICKUP_DONE, ROUTE_LAYER.PICKUP_TODO]);
  const direction = routeLayerSpecs().find((s) => s.id === ROUTE_LAYER.DIRECTION);
  assert.deepEqual(direction.filter, ['==', ['get', 'kind'], DIRECTION_KIND]);
  // Chevrons are geometry drawn by a line layer: a line-placed symbol is re-placed and faded in
  // (a scene repaint per frame of the fade) every time the source changes.
  assert.equal(direction.type, 'line');
  assert.equal(routeLayerSpecs().some((s) => s.type === 'symbol'), false, 'the route overlay has no symbol layer');
  // No route-line layer draws a chevron: every other layer selects by `leg`, which chevrons lack.
  for (const spec of routeLayerSpecs()) {
    if (spec.id === ROUTE_LAYER.DIRECTION) continue;
    assert.ok(JSON.stringify(spec.filter).includes('"leg"'), `${spec.id} selects by leg`);
  }
  const marks = featuresFor('R').filter((f) => f.properties.kind === DIRECTION_KIND);
  assert.ok(marks.length > 0);
  for (const m of marks) assert.equal(m.properties.leg, undefined);
  const hook = code('features/maps/mapControl/hooks/useRobotStream.js');
  assert.doesNotMatch(hook, /line-dasharray|setInterval\(|createFlowAnimator/);
});

test('route pushes are coalesced: many robot updates between two pushes are one setData, at least the interval apart', async () => {
  const map = createFakeMapboxMap({ loaded: true });
  ensureRouteLayers(map);
  const held = new Map();
  let clock = 1000;
  const flusher = createRouteFlusher({ getMap: () => map, getFeatures: () => [...held.values()].flat(), minIntervalMs: 50, now: () => clock });
  for (let i = 0; i < 20; i += 1) {
    held.set(`R${i}`, featuresFor(`R${i}`));
    flusher.schedule();
  }
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(map.getSource(ROUTE_SOURCE).setDataCalls, 1, 'twenty updates → one push');
  assert.equal(segmentsIn(map).length, 60);

  clock += 10; // 10 ms after the last push
  flusher.schedule();
  assert.equal(flusher.isPending(), true);
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(map.getSource(ROUTE_SOURCE).setDataCalls, 1, 'not before the interval');
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(map.getSource(ROUTE_SOURCE).setDataCalls, 2);
  flusher.cancel();
});

test('a push the loading style refuses is retried, not lost', () => {
  const map = createFakeMapboxMap({ loaded: false });
  const held = new Map([['R1', featuresFor('R1')]]);
  const flusher = createRouteFlusher({ getMap: () => map, getFeatures: () => [...held.values()].flat() });
  assert.equal(flusher.flushNow(), false, 'no source yet');
  assert.equal(flusher.isDirty(), true);
  map.finishStyleLoad();
  ensureRouteLayers(map);
  assert.equal(flusher.flushNow(), true);
  assert.equal(flusher.isDirty(), false);
  assert.equal(segmentsIn(map).length, 3);
});

test('removeRouteLayers leaves nothing behind — a parked map carries no fleet routes', () => {
  const map = createFakeMapboxMap({ loaded: true });
  installChargingLayers(map);
  const charging = map.layerIds();
  upsert(map, new Map(), 'SIM-1', 'S', { guard: shouldRedrawRoute });
  removeRouteLayers(map);
  assert.deepEqual(map.layerIds(), charging, 'only the route overlay was removed');
  assert.equal(map.getSource(ROUTE_SOURCE), undefined);
  ensureRouteLayers(map);
  assert.equal(map.layerIds().length, charging.length + ROUTE_LAYER_ORDER.length, 'and it can be installed again');
});

test('routes are stacked beneath the charging stations, in either install order', () => {
  // Stations first, then a route.
  const a = createFakeMapboxMap({ loaded: true });
  installChargingLayers(a);
  upsert(a, new Map(), 'SIM-1', 'S', { guard: shouldRedrawRoute });
  const la = a.layerIds();
  assert.ok(la.indexOf(ROUTE_LAYER.DIRECTION) < la.indexOf(CHARGING_STATION_FLOOR_LAYER));
  assert.ok(la.indexOf(CHARGING_LAYER.ROUTE) < la.indexOf(ROUTE_LAYER.GLOW_PICKUP), 'charger route under task route');

  // A route first, then stations: stations land on top, and the charger route goes beneath the task route.
  const b = createFakeMapboxMap({ loaded: true });
  upsert(b, new Map(), 'SIM-1', 'S', { guard: shouldRedrawRoute });
  installChargingLayers(b);
  const lb = b.layerIds();
  assert.ok(lb.indexOf(ROUTE_LAYER.DIRECTION) < lb.indexOf(CHARGING_STATION_FLOOR_LAYER));
  assert.ok(lb.indexOf(CHARGING_LAYER.ROUTE) < lb.indexOf(ROUTE_LAYER.GLOW_PICKUP));
  assert.deepEqual([...a.errors, ...b.errors], []);
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
  // The restore pushes the refilled source at once, and the unmount takes the overlay with it.
  assert.match(hook, /routeFlusherRef\.current\.flushNow\(\)/);
  assert.match(hook, /removeRouteLayers\(map\);/);
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
  assert.ok(at(ROUTE_LAYER.DROP_TODO) < at(CHARGING_STATION_FLOOR_LAYER));
  assert.deepEqual(map.errors, []);
});
