/**
 * MAP INSTANCE REUSE — leaving /map parks the Mapbox map; returning takes it back.
 *
 *   node --test src/features/maps/__architecture__/mapInstanceReuse.test.mjs
 *
 * Measured 2026-10-20 (Chrome, RNSIT, 3 robots, five Dashboard → Map round trips): every return
 * built a new map — a new WebGL context, the style fetched and loaded again, every tile laid out
 * again — and took 2.7–4.3 s to settle, with 1.0–2.5 s of long tasks each time. The page now
 * parks its map (`mapControl/mapInstanceCache.js`). These tests pin the cache's contract and the
 * wiring that keeps a reused map clean: one map, re-attached, never a second; each overlay
 * removes what it added; `load` is not waited for twice; a lost GPU context or an ended session
 * is not reused.
 */
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PARKED_MAP_TTL_MS,
  __resetMapInstanceCacheForTests,
  acquireMap,
  evictParkedMap,
  hasMapLoaded,
  onMapLoaded,
  releaseMap,
} from '../mapControl/mapInstanceCache.js';
import { initialBasemapConfig, setBasemapConfig } from '../environment/basemapConfig.js';
import { STANDARD_BASEMAP_CONFIG } from '../environment/environmentConfig.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const code = (rel) =>
  fs
    .readFileSync(path.join(SRC, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

// ── A DOM just big enough for a host and a container ─────────────────────────
function element() {
  const el = {
    style: {},
    className: '',
    parent: null,
    children: [],
    appendChild(child) {
      child.remove();
      child.parent = el;
      el.children.push(child);
      return child;
    },
    remove() {
      if (!el.parent) return;
      el.parent.children = el.parent.children.filter((c) => c !== el);
      el.parent = null;
    },
  };
  return el;
}
function host() {
  const h = element();
  h.ownerDocument = { createElement: () => element() };
  return h;
}

// ── A map just big enough for the cache ──────────────────────────────────────
function fakeMap(container) {
  const listeners = new Map();
  const canvasListeners = new Map();
  const map = {
    container,
    removed: false,
    once(type, fn) {
      const wrap = (e) => {
        map.off(type, wrap);
        fn(e);
      };
      wrap.original = fn;
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(wrap);
    },
    off(type, fn) {
      for (const l of listeners.get(type) || []) if (l === fn || l.original === fn) listeners.get(type).delete(l);
    },
    fire(type) {
      for (const l of [...(listeners.get(type) || [])]) l({ type });
    },
    loaded: () => false,
    remove() {
      map.removed = true;
    },
    getCanvas: () => ({
      addEventListener: (type, fn) => canvasListeners.set(type, fn),
    }),
    loseContext: () => canvasListeners.get('webglcontextlost')?.(),
  };
  return map;
}

let created;
const create = (container) => {
  const m = fakeMap(container);
  created.push(m);
  return m;
};

beforeEach(() => {
  __resetMapInstanceCacheForTests();
  created = [];
});

test('leaving parks the map; returning takes the same map back — no second map, no remove()', () => {
  const page1 = host();
  const first = acquireMap(page1, create);
  assert.equal(first.reused, false);
  assert.equal(created.length, 1);
  const container = first.map.container;
  assert.equal(container.parent, page1, 'the map lives in a container inside the page host');

  releaseMap(first.map);
  assert.equal(first.map.removed, false, 'parked, not removed');
  assert.equal(container.parent, null, 'its container left the page');

  const page2 = host();
  const second = acquireMap(page2, create);
  assert.equal(second.reused, true);
  assert.equal(second.map, first.map, 'the very same map');
  assert.equal(created.length, 1, 'nothing was constructed');
  assert.equal(container.parent, page2, 'its container moved into the new page');
  releaseMap(second.map);
});

test('five round trips: one map, never removed, always re-attached', () => {
  let map = null;
  for (let i = 0; i < 5; i += 1) {
    const h = host();
    const got = acquireMap(h, create);
    if (map) assert.equal(got.map, map);
    map = got.map;
    assert.equal(h.children.length, 1);
    releaseMap(map);
    assert.equal(h.children.length, 0);
  }
  assert.equal(created.length, 1);
  assert.equal(map.removed, false);
});

test('a reused map counts as loaded at once — its `load` already fired and never fires again', () => {
  const { map } = acquireMap(host(), create);
  assert.equal(hasMapLoaded(map), false);
  let calls = 0;
  const off = onMapLoaded(map, () => (calls += 1));
  map.fire('load');
  assert.equal(calls, 1);
  off();
  releaseMap(map);

  const again = acquireMap(host(), create);
  assert.equal(again.reused, true);
  assert.equal(hasMapLoaded(again.map), true, 'even though map.loaded() is false (tiles in flight)');
  let now = 0;
  onMapLoaded(again.map, () => (now += 1));
  assert.equal(now, 1, 'called synchronously, not on a `load` that will never come');
  releaseMap(again.map);
});

test('onMapLoaded unsubscribes cleanly when the page leaves before load', () => {
  const { map } = acquireMap(host(), create);
  let calls = 0;
  const off = onMapLoaded(map, () => (calls += 1));
  off();
  map.fire('load');
  assert.equal(calls, 0);
  releaseMap(map);
});

test('a map whose GPU context was lost is never reused', () => {
  const first = acquireMap(host(), create);
  first.map.loseContext();
  releaseMap(first.map);
  assert.equal(first.map.removed, true, 'discarded at release');
  const second = acquireMap(host(), create);
  assert.equal(second.reused, false);
  assert.notEqual(second.map, first.map);
  releaseMap(second.map);

  // Lost while parked: replaced at the next acquire.
  second.map.loseContext();
  const third = acquireMap(host(), create);
  assert.equal(third.reused, false);
  assert.equal(second.map.removed, true);
  releaseMap(third.map);
});

test('ending the session (logout from another page) evicts the parked map', () => {
  const { map } = acquireMap(host(), create);
  releaseMap(map);
  assert.equal(map.removed, false, 'parked');
  assert.equal(evictParkedMap(), true);
  assert.equal(map.removed, true);
  const next = acquireMap(host(), create);
  assert.equal(next.reused, false, 'the next visit builds a fresh map');
  releaseMap(next.map);
});

test('logout FROM /map: the session ends while the map is on screen, so its release discards it instead of parking it', () => {
  // AppProvider.clearSessionState runs (and calls evictParkedMap) before the navigation to
  // /login unmounts the page — the order a logout from the map page actually takes.
  const page = host();
  const { map } = acquireMap(page, create);
  assert.equal(evictParkedMap(), false, 'still on screen: left to its page for now');
  assert.equal(map.removed, false);
  releaseMap(map); // the page unmounts
  assert.equal(map.removed, true, 'not parked for the next session');
  assert.equal(page.children.length, 0, 'its container is gone');
  const next = acquireMap(host(), create);
  assert.equal(next.reused, false, 'the next session builds its own map');
  assert.notEqual(next.map, map);
  releaseMap(next.map);
  assert.equal(next.map.removed, false, 'and that one is parked normally');
});

test(`a parked map is discarded after ${PARKED_MAP_TTL_MS / 60000} minutes unused, and the timer stops when it is taken back`, () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const a = acquireMap(host(), create);
    releaseMap(a.map);
    mock.timers.tick(PARKED_MAP_TTL_MS - 1);
    const b = acquireMap(host(), create);
    assert.equal(b.reused, true, 'taken back just in time');
    mock.timers.tick(PARKED_MAP_TTL_MS * 2);
    assert.equal(b.map.removed, false, 'a map in use is never timed out');
    releaseMap(b.map);
    mock.timers.tick(PARKED_MAP_TTL_MS);
    assert.equal(b.map.removed, true, 'parked too long → its GPU memory is given back');
  } finally {
    mock.timers.reset();
  }
});

test('a second map page alongside the pooled one gets its own map, removed on release', () => {
  const pooled = acquireMap(host(), create);
  const extra = acquireMap(host(), create);
  assert.notEqual(extra.map, pooled.map);
  releaseMap(extra.map);
  assert.equal(extra.map.removed, true);
  releaseMap(pooled.map);
  assert.equal(pooled.map.removed, false);
});

test('a constructor that throws leaves no container behind and is reported to the page', () => {
  const h = host();
  assert.throws(
    () =>
      acquireMap(h, () => {
        throw new Error('WebGL unavailable');
      }),
    /WebGL unavailable/
  );
  assert.equal(h.children.length, 0);
});

// ── basemap configuration: written once, and only when it changes ────────────

test('setBasemapConfig writes only a changed value (an unchanged one would re-lay out the basemap)', () => {
  const config = { lightPreset: 'day' };
  const writes = [];
  const map = {
    getConfigProperty: (fragment, key) => (fragment === 'basemap' ? config[key] ?? null : null),
    setConfigProperty: (fragment, key, value) => {
      writes.push([fragment, key, value]);
      config[key] = value;
    },
  };
  assert.equal(setBasemapConfig(map, 'lightPreset', 'day'), false);
  assert.equal(setBasemapConfig(map, 'lightPreset', 'night'), true);
  assert.equal(setBasemapConfig(map, 'lightPreset', 'night'), false);
  assert.equal(setBasemapConfig(map, 'showPointOfInterestLabels', false), true, 'an unset key is written');
  assert.deepEqual(writes, [['basemap', 'lightPreset', 'night'], ['basemap', 'showPointOfInterestLabels', false]]);
  assert.equal(setBasemapConfig(null, 'x', 1), false);
});

test('a new map is constructed with the environment config, the theme on top', () => {
  const cfg = initialBasemapConfig({ lightPreset: 'night', showRoadLabels: false });
  assert.deepEqual(Object.keys(cfg), ['basemap']);
  assert.equal(cfg.basemap.lightPreset, 'night', 'the theme wins, as it does when the hooks write');
  assert.equal(cfg.basemap.showRoadLabels, false);
  assert.equal(cfg.basemap.show3dObjects, STANDARD_BASEMAP_CONFIG.show3dObjects);
  assert.deepEqual(initialBasemapConfig(null).basemap, { ...STANDARD_BASEMAP_CONFIG });
});

// ── wiring ───────────────────────────────────────────────────────────────────

test('wiring: the page acquires and releases its map through the cache and never removes it itself', () => {
  const control = code('features/maps/MapControl.jsx');
  assert.match(control, /acquireMap\(host, createMap\)/);
  assert.match(control, /releaseMap\(map\);/);
  assert.doesNotMatch(control, /map\.remove\(\)/);
  // Mapbox's own resize observer would shrink a parked (detached, 0×0) map's tile cache.
  assert.match(control, /trackResize: false/);
  assert.match(control, /if \(!host\.isConnected \|\| host\.clientWidth === 0 \|\| host\.clientHeight === 0\) return;/);
  // Controls belong to the map, not the visit: added once, where the map is constructed.
  const createBody = control.match(/const createMap = \(container\) => \{[\s\S]*?return created;/)[0];
  assert.match(createBody, /addControl\(new mapboxgl\.NavigationControl/);
  assert.match(createBody, /addControl\(new mapboxgl\.AttributionControl/);
  assert.equal((control.match(/addControl\(/g) || []).length, 2, 'no control is added per visit');
  // The first layout is the final one.
  assert.match(createBody, /config: initialBasemapConfig\(/);
  // `load` is not waited for twice.
  assert.match(code('features/maps/mapControl/hooks/useMapController.js'), /return onMapLoaded\(map, onLoad\);/);
  // The session's end takes the parked map with it.
  assert.match(code('context/AppProvider.jsx'), /const clearSessionState = useCallback\(\(\) => \{[\s\S]*?evictParkedMap\(\);/);
});

test('wiring: each overlay removes what it added, on the map it captured — a parked map keeps none of it', () => {
  const stream = code('features/maps/mapControl/hooks/useRobotStream.js');
  // The page's cleanup clears mapRef first, so the overlay must hold its own reference.
  assert.match(
    stream,
    /const map = mapRef\?\.current \|\| null;[\s\S]*?return \(\) => \{[\s\S]*?entry\.pickupMarker\?\.remove\?\.\(\);[\s\S]*?entry\.dropMarker\?\.remove\?\.\(\);[\s\S]*?removeRouteLayers\(map\);/
  );
  assert.match(code('features/maps/campus/useCampusLayer.js'), /removeCampusLayers\(map\);/);
  assert.match(code('features/maps/charging/useChargingLayer.js'), /removeChargingLayers\(map\);/);
  // Every config write goes through the guard.
  for (const rel of ['features/maps/MapControl.jsx', 'features/maps/theme/useMapTheme.js', 'features/maps/environment/useEnvironmentLayer.js']) {
    assert.doesNotMatch(code(rel), /\.setConfigProperty/, `${rel}: config is written through setBasemapConfig`);
  }
});
