/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ROUTE OVERLAY — the Mapbox side of every robot's drawn route
 *
 * ONE GeoJSON source holds every robot's route, and a FIXED set of layers draws
 * it. A robot's route is up to four line features in that source — the pickup
 * leg and the drop leg, each split into travelled (`done`) and still ahead
 * (`todo`) — plus the direction chevrons along its ahead segments, and the
 * robot's colour travels on the feature, not on a layer of its own.
 *
 * ── Why not one source and four layers per robot (as before) ───────────────
 * Measured 2026-10-20 on /map (Chrome, RNSIT, 3D Standard style with terrain):
 * Mapbox walks every source's tile cover on EVERY frame, and
 * draws every layer per tile. A robot used to add four sources and up to
 * sixteen layers, so the per-frame cost of the map grew with the fleet — at 20
 * robots, 80 route sources and ~320 route layers, and panning ran below 10 fps.
 * Now the route overlay costs the same nine layers and one source at any
 * fleet size, and a progress update for any number of robots is one
 * `setData`, coalesced (`createRouteFlusher`).
 *
 * ── Why the direction is drawn, not animated ────────────────────────────────
 * The "flow" dash used to be animated by stepping `line-dasharray` every 70 ms.
 * In mapbox-gl v3 `line-dasharray` is a layout-time property
 * (`StyleLayer.setPaintProperty` returns `requiresRelayout` for it), so every
 * step re-tiled every route source in the worker and repainted the whole 3D
 * scene — ~14 full relayouts and repaints a second for as long as any route
 * was on screen. A repaint of this scene alone measured ~25 ms of main thread
 * here; even without the relayout, a 14 Hz animation cost ~410 ms of every
 * second. Direction is now a static chevron along each segment still ahead of
 * its unit: the same information (which way the unit is going, only where it
 * has yet to go), drawn once, costing nothing while nothing changes.
 *
 * The rules that keep a route ON the map hold as before and are driven against
 * a fake map in tests:
 *   · `ensureRouteLayers` is idempotent and orders new layers beneath the
 *     charging stations;
 *   · `routeLayersPresent` / `shouldRedrawRoute` are the redraw guard. A route
 *     counts as drawn only when its layers are actually in the style — never
 *     because an earlier call was attempted. That attempt fails silently when
 *     the style is still loading (Mapbox throws "Style is not done loading",
 *     and every call here swallows errors).
 *
 * No React, no mapbox-gl import: only the map handed in.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** The one source every robot's route is drawn from. */
export const ROUTE_SOURCE = 'robot-route-src';

/**
 * Every route layer, by role. The `robot-route-` prefix is load-bearing: the
 * charging stations and the campus order themselves against it
 * (`TASK_ROUTE_LAYER_PREFIX`, `campusAnchorLayerId`).
 */
export const ROUTE_LAYER = Object.freeze({
  GLOW_PICKUP: 'robot-route-glow-pickup',
  GLOW_DROP: 'robot-route-glow-drop',
  CASING_PICKUP: 'robot-route-casing-pickup',
  CASING_DROP: 'robot-route-casing-drop',
  PICKUP_DONE: 'robot-route-pickup-done',
  PICKUP_TODO: 'robot-route-pickup-todo',
  DROP_DONE: 'robot-route-drop-done',
  DROP_TODO: 'robot-route-drop-todo',
  DIRECTION: 'robot-route-direction',
});

/** Bottom → top. Halos under every line, travelled under ahead, direction on top. */
export const ROUTE_LAYER_ORDER = Object.freeze([
  ROUTE_LAYER.GLOW_PICKUP,
  ROUTE_LAYER.GLOW_DROP,
  ROUTE_LAYER.CASING_PICKUP,
  ROUTE_LAYER.CASING_DROP,
  ROUTE_LAYER.PICKUP_DONE,
  ROUTE_LAYER.PICKUP_TODO,
  ROUTE_LAYER.DROP_DONE,
  ROUTE_LAYER.DROP_TODO,
  ROUTE_LAYER.DIRECTION,
]);

/** A route's two legs and two parts, as feature properties. */
export const ROUTE_LEG = Object.freeze({ PICKUP: 'pickup', DROP: 'drop' });
export const ROUTE_PART = Object.freeze({ TODO: 'todo', DONE: 'done' });

/**
 * The fewest milliseconds between two pushes of the route source. Progress is
 * derived from telemetry (one sample per robot every ~2 s), so at 20 robots the
 * source would otherwise be rewritten ten times a second, each a worker re-tile
 * and a full repaint. Four a second keeps every robot's split current to well
 * under a metre at walking speed.
 */
export const ROUTE_FLUSH_MIN_INTERVAL_MS = 250;

// Ground-proportionate widths — plain `line-width` numbers are constant
// SCREEN pixels regardless of zoom, so a fixed 12px glow represents ~1m of
// road at zoom 18 but hundreds of metres at zoom 10. These zoom expressions
// keep the line's apparent ground-width close to a real road/lane at every
// zoom, which is what makes it read as "on the road" instead of a fixed-size
// ribbon that swamps the map when zoomed out.
export function zoomLineWidth(dashed) {
  return dashed
    ? ['interpolate', ['linear'], ['zoom'], 10, 1, 14, 2, 18, 3.2]
    : ['interpolate', ['linear'], ['zoom'], 10, 1.4, 14, 2.6, 18, 5];
}

export function zoomGlowWidth(dashed) {
  return dashed
    ? ['interpolate', ['linear'], ['zoom'], 10, 2, 14, 4, 18, 7]
    : ['interpolate', ['linear'], ['zoom'], 10, 3, 14, 6, 18, 12];
}

export function zoomCasingWidth(dashed) {
  return dashed
    ? ['interpolate', ['linear'], ['zoom'], 10, 1.6, 14, 2.8, 18, 4.2]
    : ['interpolate', ['linear'], ['zoom'], 10, 2, 14, 3.4, 18, 6.2];
}

/**
 * A route is drawn ON the world, not lit by it.
 *
 * Mapbox Standard is a lit style, and `line-emissive-strength` defaults to 0 —
 * meaning "multiply this colour by whatever light is falling here". Left at the
 * default, a route line is dimmed by the night lighting exactly like a road
 * surface is, which is backwards: the route is operational overlay, the same
 * category of thing as the robot marker, and a marker is a DOM element that the
 * scene's lighting never touches at all. Fully self-lit is what makes the route
 * read identically at every hour, which is precisely what §19 asks for — night
 * is when an operator most needs the operational layer to separate cleanly.
 */
export const ROUTE_EMISSIVE = 1;

/** The approach leg is dashed — set once on its layer and never changed (see the header). */
const APPROACH_DASH = [8, 5];

const EMPTY = Object.freeze({ type: 'FeatureCollection', features: [] });
const COLOR = ['get', 'color'];
const legIs = (leg) => ['==', ['get', 'leg'], leg];
const segmentIs = (leg, part) => ['all', legIs(leg), ['==', ['get', 'part'], part]];

/** The opacities a theme gives each line layer — the same multipliers the per-robot layers used. */
function lineOpacities(theme) {
  const todo = theme?.routes?.todoOpacity ?? 0.95;
  const done = theme?.routes?.doneOpacity ?? 0.3;
  return {
    [ROUTE_LAYER.PICKUP_TODO]: todo * 0.8,
    [ROUTE_LAYER.PICKUP_DONE]: done * 0.75,
    [ROUTE_LAYER.DROP_TODO]: todo,
    [ROUTE_LAYER.DROP_DONE]: done,
  };
}

const casingOpacity = (dashed, theme) => (dashed ? 0.35 : 0.55) * ((theme?.routes?.haloOpacity ?? 0.3) / 0.3);

/** Every route layer's spec, bottom → top. */
export function routeLayerSpecs(theme = null) {
  const opacity = lineOpacities(theme);
  const glow = (id, leg, dashed) => ({
    id,
    type: 'line',
    source: ROUTE_SOURCE,
    filter: legIs(leg),
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': COLOR,
      'line-width': zoomGlowWidth(dashed),
      'line-opacity': 0.1,
      'line-blur': 3,
      'line-emissive-strength': ROUTE_EMISSIVE,
    },
  });
  // Casing — thin halo under the main line so the small, expected divergence
  // between our full-precision route and the basemap's zoom-simplified road
  // geometry reads as an intentional "route corridor" instead of visual
  // misalignment. Theme-coloured, because a dark casing that disappears into a
  // Day basemap does not separate the route from the road it follows.
  const casing = (id, leg, dashed) => ({
    id,
    type: 'line',
    source: ROUTE_SOURCE,
    filter: legIs(leg),
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': theme?.routes?.halo || '#0b1220',
      'line-width': zoomCasingWidth(dashed),
      'line-opacity': casingOpacity(dashed, theme),
      'line-emissive-strength': ROUTE_EMISSIVE,
    },
  });
  // dashed = robot→pickup (approaching); solid = pickup→drop (delivery route)
  const line = (id, leg, part, dashed) => ({
    id,
    type: 'line',
    source: ROUTE_SOURCE,
    filter: segmentIs(leg, part),
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': COLOR,
      'line-width': zoomLineWidth(dashed),
      'line-opacity': opacity[id],
      'line-emissive-strength': ROUTE_EMISSIVE,
      ...(dashed ? { 'line-dasharray': APPROACH_DASH } : {}),
    },
  });
  return [
    glow(ROUTE_LAYER.GLOW_PICKUP, ROUTE_LEG.PICKUP, true),
    glow(ROUTE_LAYER.GLOW_DROP, ROUTE_LEG.DROP, false),
    casing(ROUTE_LAYER.CASING_PICKUP, ROUTE_LEG.PICKUP, true),
    casing(ROUTE_LAYER.CASING_DROP, ROUTE_LEG.DROP, false),
    line(ROUTE_LAYER.PICKUP_DONE, ROUTE_LEG.PICKUP, ROUTE_PART.DONE, true),
    line(ROUTE_LAYER.PICKUP_TODO, ROUTE_LEG.PICKUP, ROUTE_PART.TODO, true),
    line(ROUTE_LAYER.DROP_DONE, ROUTE_LEG.DROP, ROUTE_PART.DONE, false),
    line(ROUTE_LAYER.DROP_TODO, ROUTE_LEG.DROP, ROUTE_PART.TODO, false),
    // Direction (§13) — chevrons along segments the unit has yet to travel; a
    // travelled segment has no direction left to communicate. Each chevron is
    // GEOMETRY in the shared source (`directionMarks`), drawn by a plain line
    // layer: no image, no symbol placement, and so no fade-in after each push.
    // Line-placed symbols were measured first: Mapbox re-places them every time
    // the source changes and fades them in over 300 ms, repainting the scene for
    // every frame of the fade (22 repaints a second at three robots, 6 without
    // the fade). Line patterns did not render on these terrain-draped layers in
    // mapbox-gl 3.20.
    {
      id: ROUTE_LAYER.DIRECTION,
      type: 'line',
      source: ROUTE_SOURCE,
      minzoom: DIRECTION_MIN_ZOOM,
      filter: ['==', ['get', 'kind'], DIRECTION_KIND],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': theme?.routes?.flow || '#ffffff',
        'line-width': ['interpolate', ['linear'], ['zoom'], DIRECTION_MIN_ZOOM, 1, 18, 2.4],
        'line-opacity': theme?.routes?.flowOpacity ?? 0.55,
        'line-emissive-strength': ROUTE_EMISSIVE,
      },
    },
  ];
}

/** Below this zoom a chevron a couple of metres across is sub-pixel; none are drawn. */
export const DIRECTION_MIN_ZOOM = 15.5;
/** Feature `kind` of a direction chevron (route segments carry `leg`/`part` instead). */
export const DIRECTION_KIND = 'direction';

const EARTH_M_PER_DEG = 111320;

/**
 * Chevrons along a polyline, pointing the way it runs (its coordinate order —
 * for an ahead segment, from the unit toward its destination).
 *
 * Each is a three-point line, arm → tip → arm, computed from the route's own
 * coordinates; the route itself is untouched. Spacing and size are in metres on
 * the ground, so they hold their place on the road at any zoom.
 *
 * @param {Array<[number, number]>} coords  [lng, lat] pairs
 * @returns {Array<Array<[number, number]>>} one coordinate list per chevron
 */
export function directionMarks(coords, { spacingM = 9, armM = 1.3, halfAngleDeg = 38 } = {}) {
  const list = Array.isArray(coords) ? coords : [];
  if (list.length < 2) return [];
  const lat0 = list[0][1];
  const mx = EARTH_M_PER_DEG * Math.cos((lat0 * Math.PI) / 180);
  const my = EARTH_M_PER_DEG;
  const cosA = Math.cos((halfAngleDeg * Math.PI) / 180);
  const sinA = Math.sin((halfAngleDeg * Math.PI) / 180);
  const out = [];
  // The first chevron sits half a spacing ahead of the unit, not on top of its marker.
  let nextAt = spacingM / 2;
  let walked = 0;
  for (let i = 1; i < list.length; i += 1) {
    const [x1, y1] = list[i - 1];
    const [x2, y2] = list[i];
    const dx = (x2 - x1) * mx;
    const dy = (y2 - y1) * my;
    const len = Math.hypot(dx, dy);
    if (len === 0) continue;
    const ux = dx / len;
    const uy = dy / len;
    while (nextAt <= walked + len) {
      const t = (nextAt - walked) / len;
      const tip = [x1 + (x2 - x1) * t, y1 + (y2 - y1) * t];
      // Each arm: back along the direction, rotated ±halfAngle.
      const arm = (s) => {
        const bx = -(ux * cosA - s * uy * sinA) * armM;
        const by = -(uy * cosA + s * ux * sinA) * armM;
        return [tip[0] + bx / mx, tip[1] + by / my];
      };
      out.push([arm(1), tip, arm(-1)]);
      nextAt += spacingM;
    }
    walked += len;
  }
  return out;
}

/**
 * Install whatever of the route overlay is missing: the source and every layer. Idempotent — every add is guarded by its get — so calling it on
 * an intact style changes nothing, and calling it after a style reload rebuilds
 * exactly one copy. `beforeId` places NEW layers beneath that layer when it
 * exists (the charging stations' floor), so stations always read on top of
 * routes.
 */
export function ensureRouteLayers(map, { theme = null, beforeId } = {}) {
  if (!map) return;
  // Called on every redraw; when the overlay is intact (nearly always) this is the whole cost.
  try {
    if (map.getSource(ROUTE_SOURCE) && routeLayersPresent(map)) return;
  } catch {
    // fall through to the guarded install
  }
  let before;
  try {
    before = beforeId && map.getLayer(beforeId) ? beforeId : undefined;
  } catch {
    before = undefined;
  }
  try {
    if (!map.getSource(ROUTE_SOURCE)) map.addSource(ROUTE_SOURCE, { type: 'geojson', data: EMPTY });
  } catch {
    // ignore — a style still loading refuses it; the caller retries on style.load
  }
  for (const spec of routeLayerSpecs(theme)) {
    try {
      if (!map.getLayer(spec.id)) map.addLayer(spec, before);
    } catch {
      // ignore
    }
  }
}

/** Remove the whole route overlay — every layer and the source. */
export function removeRouteLayers(map) {
  if (!map) return;
  for (const id of [...ROUTE_LAYER_ORDER].reverse()) {
    try {
      if (map.getLayer(id)) map.removeLayer(id);
    } catch {
      // ignore
    }
  }
  try {
    if (map.getSource(ROUTE_SOURCE)) map.removeSource(ROUTE_SOURCE);
  } catch {
    // ignore
  }
}

/**
 * Re-colour the route overlay from a theme frame. Paint properties only — none
 * of them relayouts — and no source is touched, so route progress (which is
 * geometry) cannot be disturbed by a colour change (§52).
 */
export function applyRouteTheme(map, theme) {
  if (!map || !theme) return;
  const set = (layerId, prop, value) => {
    try {
      if (map.getLayer(layerId)) map.setPaintProperty(layerId, prop, value);
    } catch {
      // ignore
    }
  };
  set(ROUTE_LAYER.CASING_PICKUP, 'line-color', theme.routes.halo);
  set(ROUTE_LAYER.CASING_DROP, 'line-color', theme.routes.halo);
  set(ROUTE_LAYER.CASING_PICKUP, 'line-opacity', casingOpacity(true, theme));
  set(ROUTE_LAYER.CASING_DROP, 'line-opacity', casingOpacity(false, theme));
  for (const [id, value] of Object.entries(lineOpacities(theme))) set(id, 'line-opacity', value);
  set(ROUTE_LAYER.DIRECTION, 'line-color', theme.routes.flow);
  set(ROUTE_LAYER.DIRECTION, 'line-opacity', theme.routes.flowOpacity);
}

/**
 * One robot's route as features of the shared source.
 *
 * @param {object} route
 * @param {string} route.robotId
 * @param {string} route.taskId
 * @param {string} route.color
 * @param {{ travelled?: Array, ahead?: Array }} [route.pickup]
 * @param {{ travelled?: Array, ahead?: Array }} [route.drop]
 * @returns {object[]} GeoJSON features — a degenerate segment (fewer than two points) draws nothing
 */
export function routeFeatures({ robotId, taskId, color, pickup, drop }) {
  const out = [];
  const add = (leg, part, coords) => {
    if (!Array.isArray(coords) || coords.length < 2) return;
    out.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: coords },
      properties: { robotId, taskId, color, leg, part },
    });
  };
  add(ROUTE_LEG.PICKUP, ROUTE_PART.DONE, pickup?.travelled);
  add(ROUTE_LEG.PICKUP, ROUTE_PART.TODO, pickup?.ahead);
  add(ROUTE_LEG.DROP, ROUTE_PART.DONE, drop?.travelled);
  add(ROUTE_LEG.DROP, ROUTE_PART.TODO, drop?.ahead);
  // Direction marks, on the ahead segments only. They carry no `leg`/`part`, so no
  // route-line layer draws them.
  for (const ahead of [pickup?.ahead, drop?.ahead]) {
    for (const mark of directionMarks(ahead)) {
      out.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: mark },
        properties: { robotId, taskId, kind: DIRECTION_KIND },
      });
    }
  }
  return out;
}

/** Push every held route into the source. Returns whether the style took it. */
export function setRouteData(map, features) {
  const source = map?.getSource?.(ROUTE_SOURCE);
  if (!source || typeof source.setData !== 'function') return false;
  try {
    source.setData({ type: 'FeatureCollection', features });
    return true;
  } catch {
    return false;
  }
}

/** Whether every layer id is currently in the map's style. */
export function routeLayersPresent(map, layerIds = ROUTE_LAYER_ORDER) {
  if (!map || !Array.isArray(layerIds)) return false;
  for (const id of layerIds) {
    try {
      if (!map.getLayer(id)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * The redraw guard. Redraw unless the route already drawn has the same
 * signature AND its layers are still in the style (a style reload removes them
 * without telling anyone; a failed first draw never added them).
 */
export function shouldRedrawRoute(existing, signature, map) {
  if (!existing || existing.signature !== signature) return true;
  return !routeLayersPresent(map, existing.drawnLayerIds);
}

/**
 * Coalesces route-source writes: any number of `schedule()` calls between two
 * pushes become one `setData`, and pushes are at least `minIntervalMs` apart.
 * A push the style refuses (still loading) is retried by the next `schedule()`
 * or `flushNow()` — the hook calls `flushNow()` on `load` / `style.load`.
 *
 * @param {object} options
 * @param {() => (object|null)} options.getMap
 * @param {() => object[]} options.getFeatures   every held route's features, now
 * @param {number} [options.minIntervalMs]
 * @param {() => number} [options.now]
 */
export function createRouteFlusher({ getMap, getFeatures, minIntervalMs = ROUTE_FLUSH_MIN_INTERVAL_MS, now = () => Date.now() }) {
  let timer = null;
  let lastPushAt = -Infinity;
  let dirty = false;

  const flushNow = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    const map = getMap();
    if (!map) return false;
    const pushed = setRouteData(map, getFeatures());
    dirty = !pushed;
    if (pushed) lastPushAt = now();
    return pushed;
  };

  const schedule = () => {
    dirty = true;
    if (timer !== null) return;
    const wait = Math.max(0, lastPushAt + minIntervalMs - now());
    timer = setTimeout(() => {
      timer = null;
      flushNow();
    }, wait);
  };

  const cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  return { schedule, flushNow, cancel, isDirty: () => dirty, isPending: () => timer !== null };
}
