/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE MAPBOX MAP FOR THE /map PAGE, KEPT ACROSS ROUTE CHANGES
 *
 * Leaving /map used to `remove()` the map and returning built a new one: a new
 * WebGL context, the Standard style and its imports fetched and parsed again,
 * every shader compiled again, the terrain DEM and every vector tile fetched and
 * laid out again. That is the multi-second blank map on every return, and the
 * burst of worker and main-thread work after it is the sluggishness that
 * followed.
 *
 * Now the page PARKS its map when it unmounts and takes it back when it mounts:
 *
 *   mount    acquireMap(host, create)   the parked map's container is moved into
 *                                       the page's host element, or a new map is
 *                                       created into a container this module owns
 *   unmount  releaseMap(map)            the container is detached and kept
 *
 * Ownership stays where it was. Every hook still installs its own layers and
 * listeners on mount and removes them on unmount, exactly as it did against a
 * fresh map — a parked map holds the style, the environment and the tile caches
 * and nothing of the page's. That is what keeps a reused map from carrying
 * duplicate layers, stale routes or leaked listeners into the next visit.
 *
 * The container is created here, not by React, so React never owns (and never
 * removes) the element Mapbox draws into. A parked map is discarded when its
 * GPU context is lost, when the session ends (`evictParkedMap`), or after
 * `PARKED_MAP_TTL_MS` unused, so an operator who leaves the map for the rest of
 * a shift does not hold a WebGL context and its caches for it.
 *
 * No React, no mapbox-gl import: the caller's `create` builds the map.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** How long a parked map is kept before its GPU memory is given back. */
export const PARKED_MAP_TTL_MS = 10 * 60 * 1000;

/** The pooled map: `{ map, container, inUse, lost, evictOnRelease, evictTimer }`, or null. */
let slot = null;

/** Maps whose `load` has fired. `load` fires once per map, so a reused map never fires it again. */
const loadedMaps = new WeakSet();

function discard(entry) {
  if (!entry) return;
  if (entry.evictTimer !== null) clearTimeout(entry.evictTimer);
  entry.evictTimer = null;
  try {
    entry.container?.remove?.();
  } catch {
    // ignore
  }
  try {
    entry.map?.remove?.();
  } catch {
    // ignore
  }
}

function watchForContextLoss(entry) {
  try {
    entry.map.getCanvas?.()?.addEventListener?.('webglcontextlost', () => {
      entry.lost = true;
    });
  } catch {
    // ignore
  }
}

/**
 * Take the parked map into `host`, or create one there.
 *
 * @param {HTMLElement} host           the page's (React-owned) element the map lives in
 * @param {(container: HTMLElement) => object} create   builds a map into `container`
 * @returns {{ map: object, reused: boolean }}
 */
export function acquireMap(host, create) {
  if (slot && !slot.inUse && !slot.lost) {
    if (slot.evictTimer !== null) clearTimeout(slot.evictTimer);
    slot.evictTimer = null;
    host.appendChild(slot.container);
    slot.inUse = true;
    return { map: slot.map, reused: true };
  }
  // A parked map whose context was lost cannot draw again; it is replaced, not reused.
  if (slot && !slot.inUse) evictParkedMap();

  const doc = host.ownerDocument || globalThis.document;
  const container = doc.createElement('div');
  container.className = 'robotx-map-instance';
  // The same box the page's own map element had (`w-full h-full`); Mapbox makes it
  // `position: relative` itself.
  container.style.cssText = 'width:100%;height:100%;';
  host.appendChild(container);

  let map;
  try {
    map = create(container);
  } catch (err) {
    try {
      container.remove();
    } catch {
      // ignore
    }
    throw err;
  }

  const entry = { map, container, inUse: true, lost: false, evictOnRelease: false, evictTimer: null };
  try {
    map.once('load', () => loadedMaps.add(map));
  } catch {
    // ignore
  }
  watchForContextLoss(entry);
  // A second map page alongside the pooled one (never the case today) gets a map of its own
  // that is removed on release rather than competing for the slot.
  if (!slot) slot = entry;
  return { map, reused: false };
}

/**
 * The page is done with `map`. The pooled map is parked; any other map is removed.
 */
export function releaseMap(map) {
  if (!map) return;
  if (slot && slot.map === map) {
    // A lost context cannot draw again; a map whose session ended while it was on screen
    // (logout from /map) must not be parked for the next session.
    if (slot.lost || slot.evictOnRelease) {
      const entry = slot;
      slot = null;
      discard(entry);
      return;
    }
    try {
      slot.container.remove();
    } catch {
      // ignore
    }
    slot.inUse = false;
    slot.evictTimer = setTimeout(evictParkedMap, PARKED_MAP_TTL_MS);
    return;
  }
  try {
    map.remove();
  } catch {
    // ignore
  }
}

/**
 * Discard the parked map, if any. A map still in use is left to its page, but marked so that
 * its release discards it instead of parking it — a logout from /map clears the session
 * before the page unmounts, and the map must not outlive the session either way.
 */
export function evictParkedMap() {
  if (!slot) return false;
  if (slot.inUse) {
    slot.evictOnRelease = true;
    return false;
  }
  const entry = slot;
  slot = null;
  discard(entry);
  return true;
}

/** Whether this map's style and first frame have loaded — true for a reused map, whose `load` will not fire again. */
export function hasMapLoaded(map) {
  if (!map) return false;
  if (loadedMaps.has(map)) return true;
  try {
    return Boolean(map.loaded?.());
  } catch {
    return false;
  }
}

/**
 * Call `fn` once the map has loaded: now, if it already has, else on its `load`.
 *
 * @returns {() => void} unsubscribe
 */
export function onMapLoaded(map, fn) {
  if (!map) return () => {};
  if (hasMapLoaded(map)) {
    fn();
    return () => {};
  }
  const onLoad = () => {
    loadedMaps.add(map);
    fn();
  };
  try {
    map.once('load', onLoad);
  } catch {
    return () => {};
  }
  return () => {
    try {
      map.off('load', onLoad);
    } catch {
      // ignore
    }
  };
}

/** Test seam: forget the pooled map without touching it. */
export function __resetMapInstanceCacheForTests() {
  if (slot?.evictTimer) clearTimeout(slot.evictTimer);
  slot = null;
}
