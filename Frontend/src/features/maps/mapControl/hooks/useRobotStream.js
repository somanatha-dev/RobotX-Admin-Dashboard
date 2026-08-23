import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';

import { socket, DASHBOARD_EVENTS } from '@/lib/socket.js';
import { injectPulseCSS, applyMarkerZoomScale } from '@/lib/mapboxMarkers.js';

// ── The robot rendering seam ────────────────────────────────────────────────
//
// This hook owns the OPERATIONAL OVERLAY: robot visuals, route lines and
// mission pins. It no longer owns how a robot is DRAWN. Robot state becomes a
// `RobotVisual` (semantic) carrying a `RobotWorldAnchor` (canonical position),
// and a renderer resolved by name turns that into pixels.
//
//        robot state ──► toRobotVisual ──► renderer.mount / .update
//                              │
//                     RobotWorldAnchor  (the one position formula)
//
// Introducing 3D robots later is a different `representation` string resolving
// to a different renderer. Nothing in this file has to change for it: not the
// socket subscriptions, not the filter logic, not selection, not the routes,
// not `recenter`, not the follow camera.
//
// The `2d` renderer module is imported for its self-registration side effect.
import '@/features/maps/operational/renderers/robotMarker2dRenderer.js';
import { createRobotRenderer } from '@/features/maps/operational/robotRendererRegistry.js';
import { ROBOT_REPRESENTATION, toRobotVisual, colorForRobot } from '@/features/maps/operational/robotVisual.js';
import { anchorToLngLat } from '@/features/maps/world/robotWorldAnchor.js';

function toLngLat(point) {
  if (!point) return null;
  if (Array.isArray(point) && point.length >= 2) {
    const lon = typeof point[0] === 'number' ? point[0] : null;
    const lat = typeof point[1] === 'number' ? point[1] : null;
    if (lon === null || lat === null) return null;
    return [lon, lat];
  }
  const lat = typeof point.lat === 'number' ? point.lat : null;
  const lon = typeof point.lon === 'number' ? point.lon : null;
  if (lat === null || lon === null) return null;
  return [lon, lat];
}

function lineGeoJsonFromPoints(points) {
  const coords = [];
  for (const p of Array.isArray(points) ? points : []) {
    const ll = toLngLat(p);
    if (ll) coords.push(ll);
  }
  if (coords.length === 1) coords.push(coords[0]);
  if (coords.length < 2) return null;
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: coords },
        properties: {},
      },
    ],
  };
}

function splitPath(points, pathIndex) {
  const arr = Array.isArray(points) ? points : null;
  if (!arr || arr.length < 2) return { done: null, todo: null };

  const idx =
    typeof pathIndex === 'number' && Number.isFinite(pathIndex)
      ? Math.max(0, Math.min(arr.length - 1, Math.floor(pathIndex)))
      : 0;

  const donePts = arr.slice(0, idx + 1);
  const todoPts = arr.slice(idx);

  return {
    done: lineGeoJsonFromPoints(donePts),
    todo: lineGeoJsonFromPoints(todoPts),
  };
}

/**
 * Fit the camera to a set of {lat,lon} points, with sane defaults for the
 * live-tracking view. Shared by the auto-fit-on-assignment flow and the
 * manual "Recenter" control so both frame routes the same way.
 */
function fitRouteBounds(map, points, opts = {}) {
  if (!map) return false;
  const lats = (Array.isArray(points) ? points : []).map((p) => p?.lat).filter((v) => typeof v === 'number');
  const lons = (Array.isArray(points) ? points : []).map((p) => p?.lon).filter((v) => typeof v === 'number');
  if (lats.length < 1 || lons.length < 1) return false;

  try {
    map.fitBounds(
      [
        [Math.min(...lons), Math.min(...lats)],
        [Math.max(...lons), Math.max(...lats)],
      ],
      {
        padding: { top: 90, bottom: 90, left: 90, right: 90 },
        maxZoom: 17,
        duration: 1600,
        ...opts,
      }
    );
    return true;
  } catch {
    return false;
  }
}

function safeRemoveLayerAndSource(map, layerId, sourceId) {
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
function zoomLineWidth(dashed) {
  return dashed
    ? ['interpolate', ['linear'], ['zoom'], 10, 1, 14, 2, 18, 3.2]
    : ['interpolate', ['linear'], ['zoom'], 10, 1.4, 14, 2.6, 18, 5];
}

function zoomGlowWidth(dashed) {
  return dashed
    ? ['interpolate', ['linear'], ['zoom'], 10, 2, 14, 4, 18, 7]
    : ['interpolate', ['linear'], ['zoom'], 10, 3, 14, 6, 18, 12];
}

function zoomCasingWidth(dashed) {
  return dashed
    ? ['interpolate', ['linear'], ['zoom'], 10, 1.6, 14, 2.8, 18, 4.2]
    : ['interpolate', ['linear'], ['zoom'], 10, 2, 14, 3.4, 18, 6.2];
}

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
const FLOW_DASH_STEPS = Object.freeze([
  [0, 4, 3], [0.5, 4, 2.5], [1, 4, 2], [1.5, 4, 1.5], [2, 4, 1], [2.5, 4, 0.5],
  [3, 4, 0], [0, 0.5, 3, 3.5], [0, 1, 3, 3], [0, 1.5, 3, 2.5], [0, 2, 3, 2],
  [0, 2.5, 3, 1.5], [0, 3, 3, 1],
]);

const FLOW_STEP_MS = 70;

/**
 * Drives the flow dash for every ahead-route currently on the map.
 *
 * Runs only while at least one flow layer exists, and stops itself when the
 * last route is removed — an idle fleet costs nothing. It writes one paint
 * property per layer per tick and never touches geometry, so it cannot
 * interact with telemetry, the camera or the campus layer.
 */
function createFlowAnimator(getMap, getLayerIds) {
  let timer = null;
  let step = 0;

  const tick = () => {
    const map = getMap();
    const ids = getLayerIds();
    if (!map || ids.length === 0) {
      stop();
      return;
    }
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
    if (typeof window === 'undefined') return;
    timer = window.setInterval(tick, FLOW_STEP_MS);
  }

  function stop() {
    if (timer === null) return;
    try {
      window.clearInterval(timer);
    } catch {
      // ignore
    }
    timer = null;
  }

  return { start, stop };
}

function ensureLineLayer({ map, sourceId, layerId, data, color, dashed, opacity, theme, flow }) {
  if (!map || !data) return;

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
        },
      });
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
        },
      });
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
          ...(dashed ? { 'line-dasharray': [8, 5] } : {}),
        },
      });
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
        },
      });
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

/**
 * Re-colour every route layer currently on the map from a theme.
 *
 * Called on each frame of a theme transition. It writes paint properties onto
 * layers that already exist — no source is touched, no line is rebuilt, and
 * route progress (which segment is done vs ahead) is geometry, so it cannot be
 * disturbed by a colour change (§52).
 */
function applyThemeToRouteLayers(map, routes, theme) {
  if (!map || !theme) return;
  const set = (layerId, prop, value) => {
    try {
      if (map.getLayer(layerId)) map.setPaintProperty(layerId, prop, value);
    } catch {
      // ignore
    }
  };

  for (const entry of routes) {
    for (const layerId of [
      entry?.pickupTodoLayerId,
      entry?.pickupDoneLayerId,
      entry?.dropTodoLayerId,
      entry?.dropDoneLayerId,
    ]) {
      if (!layerId) continue;
      set(`${layerId}-casing`, 'line-color', theme.routes.halo);
      set(`${layerId}-flow`, 'line-color', theme.routes.flow);
      set(`${layerId}-flow`, 'line-opacity', theme.routes.flowOpacity);
    }
  }
}

function createMissionMarkerEl({ color, label }) {
  injectPulseCSS();

  // Outer wrapper — the anchor is 'center', so this element's center = coordinate
  // point. It's passed directly to `new mapboxgl.Marker({element: wrap})`, so
  // Mapbox writes its own positioning transform onto `wrap` every frame — zoom
  // scaling must go on the `inner` child instead (see mapboxMarkers.js for the
  // same pattern on robot markers), or our scale and Mapbox's translate would
  // clobber each other.
  // `position:absolute` (not `relative`) — must agree with Mapbox's own
  // `.mapboxgl-marker { position:absolute }` rule on this exact element, or
  // the inline style wins and pulls it into normal document flow, stacking
  // it under every marker created earlier (see mapboxMarkers.js for the
  // full explanation — this was the actual cause of Pickup/Drop pins
  // drifting from their true coordinate).
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:absolute;width:36px;height:36px;';

  const inner = document.createElement('div');
  inner.style.cssText = 'position:absolute;inset:0;transform-origin:50% 50%;will-change:transform;';
  wrap._scaleWrap = inner;

  // Pulse ring — absolutely centered in wrap
  const pulse = document.createElement('div');
  pulse.style.cssText = [
    'position:absolute',
    'top:50%', 'left:50%',
    'transform:translate(-50%,-50%)',
    'width:24px', 'height:24px',
    'border-radius:50%',
    `background:${color}`,
    'animation:rx-pulse-a 2.5s ease-out 0.4s infinite',
    'pointer-events:none',
    'z-index:0',
  ].join(';');

  // Main dot — absolutely centered
  const dot = document.createElement('div');
  dot.style.cssText = [
    'position:absolute',
    'top:50%', 'left:50%',
    'transform:translate(-50%,-50%)',
    'width:24px', 'height:24px',
    'border-radius:50%',
    `background:${color}`,
    'border:3px solid rgba(255,255,255,0.97)',
    `box-shadow:0 3px 10px rgba(0,0,0,0.5), 0 0 0 4px ${color}33`,
    'z-index:2',
  ].join(';');

  // Label badge (above the dot)
  const tag = document.createElement('div');
  tag.textContent         = label;
  tag.style.position      = 'absolute';
  tag.style.left          = '50%';
  tag.style.bottom        = '100%';
  tag.style.transform     = 'translateX(-50%)';
  tag.style.marginBottom  = '4px';
  tag.style.padding       = '3px 10px';
  tag.style.borderRadius  = '9999px';
  tag.style.background    = color;
  tag.style.color         = '#fff';
  tag.style.fontSize      = '11px';
  tag.style.fontWeight    = '800';
  tag.style.letterSpacing = '0.05em';
  tag.style.whiteSpace    = 'nowrap';
  tag.style.pointerEvents = 'none';
  tag.style.boxShadow     = '0 2px 6px rgba(0,0,0,0.45)';
  tag.style.border        = '1.5px solid rgba(255,255,255,0.5)';
  tag.style.zIndex        = '10';

  dot.appendChild(tag);
  inner.appendChild(pulse);
  inner.appendChild(dot);
  wrap.appendChild(inner);
  return wrap;
}

export function useRobotStream({
  robots: globalRobots,
  taskPathCacheRef,
  countryId,
  stateId,
  cityId,
  locationId,
  campusId,
  mapRef,
  markersRef,
  // Operational overlay inputs — all application state, none renderer state.
  representation = ROBOT_REPRESENTATION.TWO_D,
  selectedRobotId = null,
  followSelected = false,
  onSelectRobot,
  onHoverRobot,
  // View state, not operational state: the theme only decides what the route
  // corridor and its flow are coloured, never where the route goes.
  themeRef,
  subscribeToTheme,
}) {
  const [robots, setRobots] = useState([]);

  const activeRobotIdsRef = useRef(new Set());
  const routesRef = useRef(new Map());
  const taskPathsRef = useRef(new Map());
  const flowAnimatorRef = useRef(null);

  // Read inside imperative callbacks rather than listed as dependencies, so a
  // selection or follow-toggle never tears down and rebuilds marker plumbing.
  const selectedRobotIdRef = useRef(selectedRobotId);
  selectedRobotIdRef.current = selectedRobotId;
  const followSelectedRef = useRef(followSelected);
  followSelectedRef.current = followSelected;
  const onSelectRobotRef = useRef(onSelectRobot);
  onSelectRobotRef.current = onSelectRobot;
  const onHoverRobotRef = useRef(onHoverRobot);
  onHoverRobotRef.current = onHoverRobot;

  // One renderer instance for the whole overlay, resolved by representation
  // name. `createRobotRenderer` validates the contract at wire-up, so a
  // renderer missing a method fails here rather than on the first telemetry
  // tick of a live fleet view.
  const rendererRef = useRef(null);
  const rendererRepresentationRef = useRef(null);
  const getRenderer = useCallback(() => {
    if (rendererRef.current && rendererRepresentationRef.current === representation) {
      return rendererRef.current;
    }
    // Representation changed (or first use): drop everything the previous
    // renderer owned before standing the new one up. This is the code path a
    // future 2d → 3d switch travels; it exists now so it is not written under
    // pressure later.
    if (rendererRef.current) {
      try {
        rendererRef.current.dispose();
      } catch {
        // ignore
      }
      markersRef?.current?.clear?.();
    }
    rendererRef.current = createRobotRenderer(representation, {
      getMap: () => mapRef?.current || null,
      onSelectRobot: (id) => onSelectRobotRef.current?.(id),
      onHoverRobot: (id) => onHoverRobotRef.current?.(id),
    });
    rendererRepresentationRef.current = representation;
    return rendererRef.current;
  }, [representation, mapRef, markersRef]);

  useEffect(() => {
    return () => {
      try {
        rendererRef.current?.dispose();
      } catch {
        // ignore
      }
      rendererRef.current = null;
      rendererRepresentationRef.current = null;
    };
  }, []);

  const removeRouteForRobot = useCallback(
    (robotId) => {
      const map = mapRef?.current;
      const entry = routesRef.current.get(robotId);
      if (!entry || !map) {
        routesRef.current.delete(robotId);
        return;
      }

      // New progress layers
      safeRemoveLayerAndSource(map, entry.pickupTodoLayerId, entry.pickupTodoSourceId);
      safeRemoveLayerAndSource(map, entry.pickupDoneLayerId, entry.pickupDoneSourceId);
      safeRemoveLayerAndSource(map, entry.dropTodoLayerId, entry.dropTodoSourceId);
      safeRemoveLayerAndSource(map, entry.dropDoneLayerId, entry.dropDoneSourceId);

      // Legacy layers (backward compatibility cleanup)
      safeRemoveLayerAndSource(map, entry.pickupLayerId, entry.pickupSourceId);
      safeRemoveLayerAndSource(map, entry.dropLayerId, entry.dropSourceId);

      try {
        entry.pickupMarker?.remove?.();
      } catch {
        // ignore
      }
      try {
        entry.dropMarker?.remove?.();
      } catch {
        // ignore
      }

      routesRef.current.delete(robotId);
    },
    [mapRef]
  );

  const upsertRoutes = useCallback(
    (robot) => {
      const map = mapRef?.current;
      if (!map) return;

      const robotId = String(robot?.robotId || '').trim();
      if (!robotId) return;

      const task = robot?.task && typeof robot.task === 'object' ? robot.task : null;
      const taskId = task?.taskId ? String(task.taskId) : '';
      const cached = taskId ? taskPathsRef.current.get(taskId) : null;

      const pathToPickup = task?.pathToPickup || cached?.pathToPickup || null;
      const pathToDrop = task?.pathToDrop || cached?.pathToDrop || null;
      const pickup = task?.pickup || cached?.pickup || null;
      const drop = task?.drop || cached?.drop || null;

      const existing = routesRef.current.get(robotId) || null;

      // No task => clear overlays.
      if (!taskId) {
        removeRouteForRobot(robotId);
        return;
      }

      const pickupLine = lineGeoJsonFromPoints(pathToPickup);
      const dropLine = lineGeoJsonFromPoints(pathToDrop);

      // If paths are omitted on incremental updates, keep existing overlays
      // as long as the taskId hasn't changed.
      if ((!pickupLine || !dropLine) && existing && existing.taskId === taskId) {
        // Still update mission markers if coords are provided.
        const pickupLL = toLngLat(pickup);
        const dropLL = toLngLat(drop);
        if (pickupLL && existing.pickupMarker) {
          try {
            existing.pickupMarker.setLngLat(pickupLL);
          } catch {
            // ignore
          }
        }
        if (dropLL && existing.dropMarker) {
          try {
            existing.dropMarker.setLngLat(dropLL);
          } catch {
            // ignore
          }
        }
        return;
      }

      // If task changed and we don't yet have new paths, clear stale overlays.
      if ((!pickupLine || !dropLine) && (!existing || existing.taskId !== taskId)) {
        removeRouteForRobot(robotId);
        return;
      }

      const color = colorForRobot(robotId);
      const pickupTodoSourceId = `robot-route-pickup-todo-src-${robotId}`;
      const pickupTodoLayerId = `robot-route-pickup-todo-layer-${robotId}`;
      const pickupDoneSourceId = `robot-route-pickup-done-src-${robotId}`;
      const pickupDoneLayerId = `robot-route-pickup-done-layer-${robotId}`;

      const dropTodoSourceId = `robot-route-drop-todo-src-${robotId}`;
      const dropTodoLayerId = `robot-route-drop-todo-layer-${robotId}`;
      const dropDoneSourceId = `robot-route-drop-done-src-${robotId}`;
      const dropDoneLayerId = `robot-route-drop-done-layer-${robotId}`;

      const phase = typeof task?.phase === 'string' ? task.phase : '';
      const segmentRaw = typeof task?.segment === 'string' ? task.segment : '';
      const segment = segmentRaw || (phase.includes('DROP') ? 'toDrop' : 'toPickup');
      const pathIndex = typeof task?.pathIndex === 'number' ? task.pathIndex : 0;

      // Build progress-aware geometry.
      let pickupDone = null;
      let pickupTodo = null;
      let dropDone = null;
      let dropTodo = null;

      if (segment === 'toPickup') {
        const split = splitPath(pathToPickup, pathIndex);
        pickupDone = split.done;
        pickupTodo = split.todo;
        dropDone = null;
        dropTodo = dropLine;
      } else {
        // toDrop
        pickupDone = pickupLine;
        pickupTodo = null;
        const split = splitPath(pathToDrop, pathIndex);
        dropDone = split.done;
        dropTodo = split.todo;
      }

      // Waiting implies segment completion.
      if (phase === 'WAIT_PICKUP') {
        pickupDone = pickupLine;
        pickupTodo = null;
        dropDone = null;
        dropTodo = dropLine;
      }
      if (phase === 'WAIT_DROP') {
        pickupDone = pickupLine;
        pickupTodo = null;
        dropDone = dropLine;
        dropTodo = null;
      }

      // Remove legacy layers if they exist (so we don't double-draw after upgrading).
      safeRemoveLayerAndSource(map, existing?.pickupLayerId, existing?.pickupSourceId);
      safeRemoveLayerAndSource(map, existing?.dropLayerId, existing?.dropSourceId);

      // Re-add if style switched (sources/layers removed by map.setStyle).
      // `flow` marks the segments still ahead of the unit — the only ones with
      // a direction left to communicate.
      const theme = themeRef?.current || null;
      const todoOpacity = theme?.routes?.todoOpacity ?? 0.95;
      const doneOpacity = theme?.routes?.doneOpacity ?? 0.3;

      if (pickupTodo) ensureLineLayer({ map, sourceId: pickupTodoSourceId, layerId: pickupTodoLayerId, data: pickupTodo, color, dashed: true, opacity: todoOpacity * 0.8, theme, flow: true });
      if (pickupDone) ensureLineLayer({ map, sourceId: pickupDoneSourceId, layerId: pickupDoneLayerId, data: pickupDone, color, dashed: true, opacity: doneOpacity * 0.75, theme, flow: false });
      if (dropTodo) ensureLineLayer({ map, sourceId: dropTodoSourceId, layerId: dropTodoLayerId, data: dropTodo, color, dashed: false, opacity: todoOpacity, theme, flow: true });
      if (dropDone) ensureLineLayer({ map, sourceId: dropDoneSourceId, layerId: dropDoneLayerId, data: dropDone, color, dashed: false, opacity: doneOpacity, theme, flow: false });

      // If any segment is absent, remove its layer/source.
      if (!pickupTodo) safeRemoveLayerAndSource(map, pickupTodoLayerId, pickupTodoSourceId);
      if (!pickupDone) safeRemoveLayerAndSource(map, pickupDoneLayerId, pickupDoneSourceId);
      if (!dropTodo) safeRemoveLayerAndSource(map, dropTodoLayerId, dropTodoSourceId);
      if (!dropDone) safeRemoveLayerAndSource(map, dropDoneLayerId, dropDoneSourceId);

      let pickupMarker = existing?.pickupMarker || null;
      let dropMarker = existing?.dropMarker || null;

      // Use the road-snapped PATH ENDPOINT for each marker, not the raw task address.
      // Mapbox snaps coordinates to the nearest road; pathToPickup[-1] is where the
      // dashed line actually ends, and pathToDrop[-1] is where the solid line ends.
      // Placing markers at task.pickup/task.drop (unsnapped) causes a visible gap
      // between the end of the line and the pin.
      const snapPickupLL = pathToPickup && pathToPickup.length > 0
        ? toLngLat(pathToPickup[pathToPickup.length - 1])
        : toLngLat(pickup);
      const snapDropLL = pathToDrop && pathToDrop.length > 0
        ? toLngLat(pathToDrop[pathToDrop.length - 1])
        : toLngLat(drop);

      if (snapPickupLL) {
        if (!pickupMarker) {
          pickupMarker = new mapboxgl.Marker({
            element: createMissionMarkerEl({ color, label: 'Pickup' }),
            anchor: 'center',
          })
            .setLngLat(snapPickupLL)
            .addTo(map);
          applyMarkerZoomScale(pickupMarker.getElement()?._scaleWrap, map.getZoom());
        } else {
          try { pickupMarker.setLngLat(snapPickupLL); } catch { /* ignore */ }
        }
      }

      if (snapDropLL) {
        if (!dropMarker) {
          dropMarker = new mapboxgl.Marker({
            element: createMissionMarkerEl({ color: '#22c55e', label: 'Drop' }),
            anchor: 'center',
          })
            .setLngLat(snapDropLL)
            .addTo(map);
          applyMarkerZoomScale(dropMarker.getElement()?._scaleWrap, map.getZoom());
        } else {
          try { dropMarker.setLngLat(snapDropLL); } catch { /* ignore */ }
        }
      }

      flowAnimatorRef.current?.start();

      routesRef.current.set(robotId, {
        taskId,
        pickupTodoSourceId,
        pickupTodoLayerId,
        pickupDoneSourceId,
        pickupDoneLayerId,
        dropTodoSourceId,
        dropTodoLayerId,
        dropDoneSourceId,
        dropDoneLayerId,
        pickupMarker,
        dropMarker,
      });
    },
    [mapRef, removeRouteForRobot, themeRef]
  );

  // ── Route flow animation ───────────────────────────────────────────────────
  // Owns its own lifecycle: started by the first route drawn, stopped when the
  // last one is removed or the map unmounts.
  useEffect(() => {
    const animator = createFlowAnimator(
      () => mapRef?.current || null,
      () => {
        const ids = [];
        for (const entry of routesRef.current.values()) {
          for (const layerId of [entry?.pickupTodoLayerId, entry?.dropTodoLayerId]) {
            if (layerId) ids.push(`${layerId}-flow`);
          }
        }
        return ids;
      }
    );
    flowAnimatorRef.current = animator;
    if (routesRef.current.size > 0) animator.start();

    return () => {
      animator.stop();
      flowAnimatorRef.current = null;
    };
  }, [mapRef]);

  // ── Theme frames → route colours ───────────────────────────────────────────
  // Route GEOMETRY and route PROGRESS are untouched by this; only the corridor
  // halo and the flow overlay are re-coloured, on layers that already exist.
  useEffect(() => {
    if (typeof subscribeToTheme !== 'function') return;
    return subscribeToTheme((theme) => {
      applyThemeToRouteLayers(mapRef?.current, routesRef.current.values(), theme);
    });
  }, [subscribeToTheme, mapRef]);

  // Cache task routes once.
  // On mount: seed taskPathsRef from AppProvider's persistent cache so routes
  // are drawn even if TASK_ASSIGNED fired before this component mounted.
  useEffect(() => {
    const cache = taskPathCacheRef?.current;
    if (!cache || cache.size === 0) return;
    for (const [taskId, entry] of cache.entries()) {
      if (!taskPathsRef.current.has(taskId)) {
        taskPathsRef.current.set(taskId, entry);
      }
    }
  // Run once on mount — ref contents don't cause re-renders.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onAssigned = (msg) => {
      const taskId = String(msg?.taskId || '').trim();
      const robotId = String(msg?.robotId || '').trim();
      if (!taskId) return;

      const pathToPickup = Array.isArray(msg?.pathToPickup) ? msg.pathToPickup : null;
      const pathToDrop = Array.isArray(msg?.pathToDrop) ? msg.pathToDrop : null;
      if (!pathToPickup || !pathToDrop) return;

      const entry = {
        taskId,
        robotId: robotId || null,
        pickup: msg?.pickup ?? null,
        drop: msg?.drop ?? null,
        pathToPickup,
        pathToDrop,
      };

      taskPathsRef.current.set(taskId, entry);
      // Also keep the AppProvider cache in sync.
      if (taskPathCacheRef?.current) taskPathCacheRef.current.set(taskId, entry);

      if (robotId && activeRobotIdsRef.current.has(robotId)) {
        upsertRoutes({
          robotId,
          task: {
            taskId,
            phase: 'TO_PICKUP',
            pathToPickup,
            pathToDrop,
            pickup: msg?.pickup ?? null,
            drop: msg?.drop ?? null,
          },
        });
      } else if (robotId) {
        // Robot not yet in active set (e.g. user navigated to map after assignment).
        // Add it to the active set so the next telemetry tick updates its marker.
        activeRobotIdsRef.current.add(robotId);
      }

      // Auto-fit map to show the full route (robot → pickup → drop)
      const map = mapRef?.current;
      if (map) {
        fitRouteBounds(map, [...pathToPickup, ...pathToDrop]);
      }
    };

    // Single handler for all TASK_UPDATED cases — previously split across two
    // useEffects which caused two subscriptions to the same event per render.
    const TERMINAL_STATUSES_ROUTE = new Set(['COMPLETED', 'CANCELLED', 'FAILED']);
    const onTaskUpdated = (msg) => {
      const taskId = String(msg?.taskId || '').trim();
      const robotId = String(msg?.robotId || '').trim();

      // Case A: task reached a terminal status — remove route overlays.
      if (TERMINAL_STATUSES_ROUTE.has(msg?.status)) {
        if (robotId) removeRouteForRobot(robotId);
        return;
      }

      // Case B: backend replanned a segment after an obstacle.
      if (msg?.action !== 'REROUTED') return;

      const newPath = Array.isArray(msg?.newPath) ? msg.newPath : null;
      const segment = typeof msg?.segment === 'string' ? msg.segment : 'toPickup';
      if (!taskId || !newPath) return;

      const cached = taskPathsRef.current.get(taskId);
      if (cached) {
        const updated = {
          ...cached,
          ...(segment === 'toPickup' ? { pathToPickup: newPath } : { pathToDrop: newPath }),
        };
        taskPathsRef.current.set(taskId, updated);

        if (robotId && activeRobotIdsRef.current.has(robotId)) {
          upsertRoutes({
            robotId,
            task: {
              taskId,
              phase: segment === 'toPickup' ? 'TO_PICKUP' : 'TO_DROP',
              pathToPickup: updated.pathToPickup,
              pathToDrop: updated.pathToDrop,
              pickup: updated.pickup ?? null,
              drop: updated.drop ?? null,
            },
          });
        }
      }
    };

    // PHASE 15 — `TASK_ASSIGNED` (capitals) still carries a drawable route and is
    // still the right event for this hook: it fires after a real decision, when
    // there is a path to render. The lower-case `task_assigned` echo carries a
    // PENDING task with a null robot and nothing to draw, which is why the map does
    // not subscribe to it. Both names are catalogued in `lib/socket.js`.
    socket.on(DASHBOARD_EVENTS.TASK_ASSIGNED, onAssigned);
    socket.on(DASHBOARD_EVENTS.TASK_UPDATED, onTaskUpdated);
    return () => {
      socket.off(DASHBOARD_EVENTS.TASK_ASSIGNED, onAssigned);
      socket.off(DASHBOARD_EVENTS.TASK_UPDATED, onTaskUpdated);
    };
  }, [upsertRoutes, removeRouteForRobot, mapRef, taskPathCacheRef]);

  // Rebuild route layers after style changes.
  useEffect(() => {
    const map = mapRef?.current;
    if (!map) return;

    const onStyleLoad = () => {
      for (const id of activeRobotIdsRef.current) {
        const overlay = routesRef.current.get(id);
        // overlays will be recreated on next upsertRoutes call;
        // do a best-effort refresh now if we still have lines cached.
        if (!overlay) continue;
        // Nothing to do here: the next socket tick will refresh.
      }
    };

    try {
      map.on('style.load', onStyleLoad);
    } catch {
      // ignore
    }

    return () => {
      try {
        map.off('style.load', onStyleLoad);
      } catch {
        // ignore
      }
    };
  }, [mapRef]);

  // ── Camera → overlay reprojection ──────────────────────────────────────────
  //
  // Three separate reasons a marker must respond to the camera now that the
  // environment is 3D:
  //
  //   zoom     Fixed-pixel markers stay the same SCREEN size at any zoom, so at
  //            low zoom a 26×36px icon can cover hundreds of metres of ground,
  //            making an exactly-correct coordinate look like it is floating off
  //            the road. Shrinking as you zoom out (mirrors Uber/Swiggy) keeps
  //            it visually anchored at every zoom level.
  //   pitch    The ground half of the marker is foreshortened by cos(pitch) so
  //            it reads as lying on the ground rather than standing on it.
  //   bearing  A robot's heading is degrees from true NORTH. Once the camera can
  //            rotate, north is no longer screen-up, so the icon's rotation must
  //            be re-derived — otherwise every robot on the map points the wrong
  //            way the instant the operator rotates the view.
  //
  // This is reprojection, not reconstruction: it only writes CSS transforms onto
  // already-mounted elements, and it is driven by camera events, never by
  // telemetry. Environment geometry is untouched.
  useEffect(() => {
    const map = mapRef?.current;
    if (!map) return;

    const applyToAll = () => {
      let camera;
      try {
        camera = { zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() };
      } catch {
        return;
      }

      const renderer = rendererRef.current;
      if (renderer) {
        for (const entry of markersRef?.current?.values() || []) {
          if (entry?.handle) renderer.applyCamera(entry.handle, camera);
        }
      }

      // Mission (pickup/drop) pins have no ground half — they are pure
      // screen-space badges, so zoom scale is all they need.
      for (const entry of routesRef.current.values()) {
        applyMarkerZoomScale(entry?.pickupMarker?.getElement?.()?._scaleWrap, camera.zoom);
        applyMarkerZoomScale(entry?.dropMarker?.getElement?.()?._scaleWrap, camera.zoom);
      }
    };

    applyToAll();

    const events = ['zoom', 'pitch', 'rotate'];
    for (const evt of events) {
      try {
        map.on(evt, applyToAll);
      } catch {
        // ignore
      }
    }

    return () => {
      for (const evt of events) {
        try {
          map.off(evt, applyToAll);
        } catch {
          // ignore
        }
      }
    };
  }, [mapRef, markersRef]);

  /**
   * Robot state → the operational overlay, via the rendering seam.
   *
   * The whole of this function is representation-agnostic. It builds the
   * semantic `RobotVisual` (which carries the canonically-transformed world
   * anchor) and hands it to whichever renderer is registered. There is no 2D
   * geometry, no DOM, no marker API and no position arithmetic left here —
   * all of that moved behind the renderer contract, which is what makes a
   * future 3D robot a renderer swap rather than an edit to this file.
   */
  const upsertMarker = useCallback(
    (robot) => {
      const map = mapRef?.current;
      const store = markersRef?.current;
      if (!map || !store) return;

      // The ONE transform from robot state to world position and semantics.
      const visual = toRobotVisual(robot, {
        selectedRobotId: selectedRobotIdRef.current,
        representation,
      });
      // No usable position — deliberately not placed. Never fall back to an
      // origin coordinate, which would draw a robot in the Gulf of Guinea.
      if (!visual) return;

      const renderer = getRenderer();
      let entry = store.get(visual.id);

      if (!entry) {
        const handle = renderer.mount(visual);
        if (!handle) return;
        entry = { representation, handle, visual };
        store.set(visual.id, entry);
      } else {
        renderer.update(entry.handle, visual);
        // The last visual is retained so the hook can answer "where is this
        // robot?" from state rather than by reading a coordinate back out of
        // the renderer — see `recenter` and the follow camera below.
        entry.visual = visual;
      }

      // Routes are a separate operational overlay keyed by task, not part of
      // the robot's representation — a 3D robot would not change any of this.
      upsertRoutes(robot);

      // Follow-selected camera. It tracks the robot's WORLD TRANSFORM, taken
      // from the canonical anchor — not a marker element, not a mesh (§18), so
      // it keeps working verbatim under a 3D renderer.
      if (followSelectedRef.current && selectedRobotIdRef.current === visual.id) {
        const lngLat = anchorToLngLat(visual.anchor);
        if (lngLat) {
          try {
            map.easeTo({ center: lngLat, duration: 1200, essential: true });
          } catch {
            // ignore
          }
        }
      }
    },
    [mapRef, markersRef, upsertRoutes, getRenderer, representation]
  );

  const syncMarkersToRobots = useCallback(
    (list) => {
      const map = mapRef?.current;
      const store = markersRef?.current;
      if (!map || !store) return;

      const nextIds = new Set();
      for (const r of Array.isArray(list) ? list : []) {
        const robotId = String(r?.robotId || '').trim();
        if (!robotId) continue;
        nextIds.add(robotId);
        upsertMarker(r?.live && typeof r.live === 'object' ? { ...r, ...r.live } : r);
      }

      // Remove stale visuals for robots not in the current filter. The renderer
      // owns teardown of whatever it created (elements, listeners, in-flight
      // animations) — this loop never touches marker internals.
      const renderer = rendererRef.current;
      for (const [id, entry] of store.entries()) {
        if (nextIds.has(id)) continue;
        try {
          renderer?.destroy(entry?.handle);
        } catch {
          // ignore
        }
        store.delete(id);
        removeRouteForRobot(id);
      }

      activeRobotIdsRef.current = nextIds;
    },
    [mapRef, markersRef, upsertMarker, removeRouteForRobot]
  );

  // Sync map markers from the global robots list whenever it changes or the
  // location filter changes. Robots (and their routes/pickup/drop pins) are
  // shown as soon as ANY filter level is picked — country, state, city,
  // area, or campus — not just area/campus; cleared only at world view (no
  // filter at all). Robots aren't actually filtered by geography here (see
  // below), so there's no reason to withhold them until the narrowest
  // filter is chosen — the zoom-scaled marker/route sizing already keeps
  // the display readable at every one of those zoom levels.
  useEffect(() => {
    const map = mapRef?.current;
    if (!map) return;

    const hasAnyFilter = Boolean(countryId || stateId || cityId || locationId || campusId);
    if (!hasAnyFilter) {
      setRobots([]);
      syncMarkersToRobots([]);
      return;
    }

    // Show all robots that have valid coordinates — regardless of which DB
    // location they were commissioned under.  This ensures robots commissioned
    // with a custom Mapbox place (not in the seeded location hierarchy) still
    // appear on the map.
    const list = (Array.isArray(globalRobots) ? globalRobots : []).filter(
      (r) => typeof r?.lat === 'number' && typeof r?.lon === 'number'
    );

    setRobots(list);
    syncMarkersToRobots(list);

    // After markers are placed, draw any routes we have cached but haven't
    // drawn yet (e.g. TASK_ASSIGNED fired while user was on a different page).
    if (taskPathCacheRef?.current) {
      for (const [taskId, entry] of taskPathCacheRef.current.entries()) {
        const { robotId, pathToPickup, pathToDrop, pickup, drop } = entry;
        if (!robotId || !pathToPickup || !pathToDrop) continue;
        if (!activeRobotIdsRef.current.has(robotId)) continue;
        if (routesRef.current.has(robotId)) continue; // already drawn
        upsertRoutes({
          robotId,
          task: { taskId, phase: 'TO_PICKUP', pathToPickup, pathToDrop, pickup, drop },
        });
      }
    }
  }, [countryId, stateId, cityId, locationId, campusId, globalRobots, mapRef, syncMarkersToRobots, upsertRoutes, taskPathCacheRef]);

  // Live updates via Socket.IO
  useEffect(() => {
    const handler = (data) => {
      const robotId = String(data?.robotId || '').trim();
      if (!robotId) return;

      // Only update markers we are currently tracking (active filter).
      if (!activeRobotIdsRef.current.has(robotId)) return;

      // One call. Battery, status, heading and position all travel on the
      // RobotVisual now, and the renderer updates them in place — no second
      // pass into marker internals, and no marker is ever recreated.
      upsertMarker(data);

      // Keep local list in sync (light update).
      setRobots((prev) => {
        const list = Array.isArray(prev) ? prev : [];
        const idx = list.findIndex((r) => String(r?.robotId || '').trim() === robotId);
        if (idx < 0) return list;

        const current = list[idx];
        const next = {
          ...current,
          lat: typeof data?.lat === 'number' ? data.lat : current.lat,
          lon: typeof data?.lon === 'number' ? data.lon : current.lon,
          // Heading is read back by the UI layer (the selected-robot panel), so
          // it has to stay live here too — the marker gets it via the anchor,
          // but this list is what the panel renders from.
          heading: typeof data?.heading === 'number' ? data.heading : current.heading,
          battery: typeof data?.battery === 'number' ? data.battery : current.battery,
          speed: typeof data?.speed === 'number' ? data.speed : current.speed,
          status: typeof data?.status === 'string' ? data.status : current.status,
          isOnline: typeof data?.isOnline === 'boolean' ? data.isOnline : current.isOnline,
          live: data,
        };

        const copy = list.slice();
        copy[idx] = next;
        return copy;
      });
    };

    // Subscribe to the single canonical telemetry event only.
    // "robot_update" and "ROBOT_UPDATE" were legacy aliases; subscribing to all
    // three was firing the same handler 3× per tick. TASK_UPDATED is now
    // handled exclusively in the TASK_ASSIGNED useEffect above.
    socket.on('robot:update', handler);

    return () => {
      socket.off('robot:update', handler);
    };
  }, [upsertMarker, markersRef]);

  // Add newly commissioned robots to the map immediately, bypassing the location filter.
  useEffect(() => {
    const onCommissioned = (data) => {
      const robotId = String(data?.robotId || '').trim();
      if (!robotId) return;

      // Activate so subsequent live telemetry updates are processed.
      activeRobotIdsRef.current.add(robotId);

      // Create marker right away.
      upsertMarker(data);

      // Seed the local robot list so the sidebar / counts reflect the new unit.
      setRobots((prev) => {
        const list = Array.isArray(prev) ? prev : [];
        if (list.some((r) => String(r?.robotId || '').trim() === robotId)) return list;
        return [...list, data];
      });
    };

    socket.on('ROBOT_COMMISSIONED', onCommissioned);
    return () => {
      socket.off('ROBOT_COMMISSIONED', onCommissioned);
    };
  }, [upsertMarker]);

  // ── Selection → renderer ───────────────────────────────────────────────────
  //
  // Selection is application state (MapProvider). This effect is the only thing
  // that pushes it at pixels, and it does so through the renderer contract, so
  // the exact same `selectedRobotId` highlights a 3D robot later with no change
  // to how selection is stored, set or cleared (§19).
  //
  // It touches only the two robots whose selected-ness actually changed, so
  // clicking a robot in a hundred-unit fleet is two DOM writes, not a resync.
  useEffect(() => {
    const renderer = rendererRef.current;
    const store = markersRef?.current;
    if (!renderer || !store) return;

    for (const [id, entry] of store.entries()) {
      const isSelected = id === selectedRobotId;
      if (entry.visual) {
        if (entry.visual.selected === isSelected) continue;
        entry.visual = { ...entry.visual, selected: isSelected };
      }
      try {
        renderer.setSelected(entry.handle, isSelected);
      } catch {
        // ignore
      }
    }
    // Selection only. Robots mounted *after* a selection change already come up
    // correct, because `upsertMarker` reads the same id off `selectedRobotIdRef`
    // when it builds their visual — so depending on the robot list here would
    // re-walk the fleet on every telemetry tick to do nothing.
  }, [selectedRobotId, markersRef]);

  // Turning "follow" on should move the camera immediately rather than waiting
  // for the next telemetry tick. Reads the canonical anchor, never a marker.
  useEffect(() => {
    const map = mapRef?.current;
    if (!map || !followSelected || !selectedRobotId) return;
    const entry = markersRef?.current?.get(selectedRobotId);
    const lngLat = anchorToLngLat(entry?.visual?.anchor);
    if (!lngLat) return;
    try {
      map.easeTo({ center: lngLat, duration: 900, essential: true });
    } catch {
      // ignore
    }
  }, [followSelected, selectedRobotId, mapRef, markersRef]);

  const robotCount = useMemo(() => (Array.isArray(robots) ? robots.length : 0), [robots]);

  // Manual "snap back" for when the user has panned/zoomed out far enough
  // that markers no longer read as sitting on their roads (an inherent
  // limit of any slippy map at very low zoom — see fixed-pixel marker note
  // above). Frames every currently visible robot + its pickup/drop pins,
  // same logic as the auto-fit run on TASK_ASSIGNED.
  const recenter = useCallback(() => {
    const map = mapRef?.current;
    if (!map) return false;

    const points = [];
    // Robot positions come from the last RobotVisual we sent to the renderer —
    // i.e. from state, through the canonical world transform. Asking the marker
    // where it is would make the renderer a second source of truth for a
    // position state already owns, and would stop working the moment the
    // representation changed (§16).
    for (const entry of markersRef?.current?.values() || []) {
      const ll = anchorToLngLat(entry?.visual?.anchor);
      if (ll) points.push({ lat: ll[1], lon: ll[0] });
    }
    for (const entry of routesRef.current.values()) {
      for (const m of [entry?.pickupMarker, entry?.dropMarker]) {
        try {
          const ll = m?.getLngLat?.();
          if (ll) points.push({ lat: ll.lat, lon: ll.lng });
        } catch {
          // ignore
        }
      }
    }

    return fitRouteBounds(map, points, { maxZoom: 17, duration: 900 });
  }, [mapRef, markersRef]);

  return {
    robots,
    robotCount,
    recenter,
  };
}
