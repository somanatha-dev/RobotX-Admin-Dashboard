/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ROUTE OVERLAY — the Mapbox side of a robot's drawn route
 *
 * Moved out of `useRobotStream` unchanged except where marked, so the rules
 * that keep a route ON the map can be driven against a fake map in tests:
 *
 *   · `ensureLineLayer` is idempotent and orders new layers beneath the
 *     charging stations;
 *   · `routeLayersPresent` / `shouldRedrawRoute` are the redraw guard. A route
 *     counts as drawn only when its layers are actually in the style — never
 *     because an earlier call was attempted. That attempt fails silently when
 *     the style is still loading (Mapbox throws "Style is not done loading",
 *     and every call here swallows errors), which is exactly the state a map
 *     is in when the operator navigates back to it and cached routes replay;
 *     recording such a route as drawn kept it off the map until its progress
 *     happened to change — for a robot standing still, indefinitely.
 *
 * No React, no mapbox-gl import: only the map handed in.
 * ═══════════════════════════════════════════════════════════════════════════
 */

export function safeRemoveLayerAndSource(map, layerId, sourceId) {
  if (!map) return;
  // Remove glow/casing/flow sublayers first (added around the main layer, and
  // all of them must be gone before the source can be removed).
  try {
    if (layerId && map.getLayer(`${layerId}-flow`)) map.removeLayer(`${layerId}-flow`);
  } catch {
    // ignore
  }
  try {
    if (layerId && map.getLayer(`${layerId}-glow`)) map.removeLayer(`${layerId}-glow`);
  } catch {
    // ignore
  }
  try {
    if (layerId && map.getLayer(`${layerId}-casing`)) map.removeLayer(`${layerId}-casing`);
  } catch {
    // ignore
  }
  try {
    if (layerId && map.getLayer(layerId)) map.removeLayer(layerId);
  } catch {
    // ignore
  }
  try {
    if (sourceId && map.getSource(sourceId)) map.removeSource(sourceId);
  } catch {
    // ignore
  }
}

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

// ── Directional flow (§13) ───────────────────────────────────────────────────
//
// A thin bright dash travelling ALONG the route, over the route's own colour.
// It is animation that carries information — which way the unit is going —
// rather than decoration, which is the bar §50 sets. Only "ahead" segments get
// it; a travelled segment has no direction left to communicate.
//
// The dash pattern is stepped rather than interpolated because `line-dasharray`
// is not an interpolatable paint property. This is the standard Mapbox
// technique and costs one `setPaintProperty` per visible ahead-route per tick.
export const FLOW_DASH_STEPS = Object.freeze([
  [0, 4, 3], [0.5, 4, 2.5], [1, 4, 2], [1.5, 4, 1.5], [2, 4, 1], [2.5, 4, 0.5],
  [3, 4, 0], [0, 0.5, 3, 3.5], [0, 1, 3, 3], [0, 1.5, 3, 2.5], [0, 2, 3, 2],
  [0, 2.5, 3, 1.5], [0, 3, 3, 1],
]);

export const FLOW_STEP_MS = 70;

/**
 * Drives the flow dash for every ahead-route currently on the map.
 *
 * Runs only while at least one flow layer exists, and stops itself when the
 * last route is removed — an idle fleet costs nothing. It writes one paint
 * property per layer per tick and never touches geometry, so it cannot
 * interact with telemetry, the camera or the campus layer.
 *
 * It does not run while the operator prefers reduced motion (the dash then
 * stands still and still shows the direction), and skips its ticks while the
 * page is in a background tab, where every repaint it asked for was invisible.
 */
export function createFlowAnimator(getMap, getLayerIds, { reducedMotion = () => false, visible = () => true } = {}) {
  let timer = null;
  let step = 0;

  const tick = () => {
    const map = getMap();
    const ids = getLayerIds();
    if (!map || ids.length === 0 || reducedMotion()) {
      stop();
      return;
    }
    if (!visible()) return;
    step = (step + 1) % FLOW_DASH_STEPS.length;
    const dash = FLOW_DASH_STEPS[step];
    for (const id of ids) {
      try {
        if (map.getLayer(id)) map.setPaintProperty(id, 'line-dasharray', dash);
      } catch {
        // ignore
      }
    }
  };

  function start() {
    if (timer !== null) return;
    if (reducedMotion()) return;
    if (typeof setInterval !== 'function') return;
    timer = setInterval(tick, FLOW_STEP_MS);
  }

  function stop() {
    if (timer === null) return;
    try {
      clearInterval(timer);
    } catch {
      // ignore
    }
    timer = null;
  }

  return { start, stop, isRunning: () => timer !== null };
}

/**
 * Create or update one route segment: its source, then glow, casing, line and
 * (for segments ahead of the unit) the flow overlay.
 *
 * Idempotent — every add is guarded by its get — so calling it on an intact
 * route only pushes data, and calling it after a style reload rebuilds exactly
 * one copy. `beforeId` places NEW layers beneath that layer when it exists
 * (the charging stations' floor), so stations always read on top of routes.
 */
export function ensureLineLayer({ map, sourceId, layerId, data, color, dashed, opacity, theme, flow, beforeId }) {
  if (!map || !data) return;
  let before;
  try {
    before = beforeId && map.getLayer(beforeId) ? beforeId : undefined;
  } catch {
    before = undefined;
  }

  // Update existing source or create it
  const src = map.getSource(sourceId);
  if (src && typeof src.setData === 'function') {
    try {
      src.setData(data);
    } catch {
      // ignore
    }
  } else {
    try {
      map.addSource(sourceId, { type: 'geojson', data });
    } catch {
      // ignore
    }
  }

  // Subtle glow — just enough to stand out on dark map, not so wide it hides roads
  const glowLayerId = `${layerId}-glow`;
  if (!map.getLayer(glowLayerId)) {
    try {
      map.addLayer({
        id: glowLayerId,
        type: 'line',
        source: sourceId,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': color,
          'line-width': zoomGlowWidth(dashed),
          'line-opacity': 0.10,
          'line-blur': 3,
          'line-emissive-strength': ROUTE_EMISSIVE,
        },
      }, before);
    } catch {
      // ignore
    }
  }

  // Casing — thin halo under the main line so the small, expected divergence
  // between our full-precision route and the basemap's zoom-simplified road
  // geometry reads as an intentional "route corridor" instead of visual
  // misalignment. Theme-coloured, because a dark casing that disappears into a
  // Day basemap does not separate the route from the road it follows.
  const casingLayerId = `${layerId}-casing`;
  if (!map.getLayer(casingLayerId)) {
    try {
      map.addLayer({
        id: casingLayerId,
        type: 'line',
        source: sourceId,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': theme?.routes?.halo || '#0b1220',
          'line-width': zoomCasingWidth(dashed),
          'line-opacity': (dashed ? 0.35 : 0.55) * ((theme?.routes?.haloOpacity ?? 0.3) / 0.3),
          'line-emissive-strength': ROUTE_EMISSIVE,
        },
      }, before);
    } catch {
      // ignore
    }
  }

  // Main line layer
  if (!map.getLayer(layerId)) {
    try {
      map.addLayer({
        id: layerId,
        type: 'line',
        source: sourceId,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': color,
          // dashed = robot→pickup (approaching); solid = pickup→drop (delivery route)
          'line-width': zoomLineWidth(dashed),
          'line-opacity': typeof opacity === 'number' ? opacity : dashed ? 0.85 : 0.95,
          'line-emissive-strength': ROUTE_EMISSIVE,
          ...(dashed ? { 'line-dasharray': [8, 5] } : {}),
        },
      }, before);
    } catch {
      // ignore
    }
  }

  // Flow overlay — only on segments the unit has yet to travel.
  const flowLayerId = `${layerId}-flow`;
  if (flow && !map.getLayer(flowLayerId)) {
    try {
      map.addLayer({
        id: flowLayerId,
        type: 'line',
        source: sourceId,
        layout: { 'line-join': 'round', 'line-cap': 'butt' },
        paint: {
          'line-color': theme?.routes?.flow || '#ffffff',
          'line-width': zoomLineWidth(dashed),
          'line-opacity': theme?.routes?.flowOpacity ?? 0.55,
          'line-dasharray': FLOW_DASH_STEPS[0],
          'line-emissive-strength': ROUTE_EMISSIVE,
        },
      }, before);
    } catch {
      // ignore
    }
  } else if (!flow && map.getLayer(flowLayerId)) {
    try {
      map.removeLayer(flowLayerId);
    } catch {
      // ignore
    }
  }
}

/** Whether every layer id is currently in the map's style. */
export function routeLayersPresent(map, layerIds) {
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
