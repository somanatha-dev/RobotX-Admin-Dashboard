import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import { animate } from 'framer-motion';

import { socket } from '@/lib/socket.js';
import {
  createRobotMarkerElement,
  updateMarkerInfo,
  injectPulseCSS,
  applyMarkerZoomScale,
  markerScaleForZoom,
} from '@/lib/mapboxMarkers.js';

function hashStringToInt(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function hslToHex(h, s, l) {
  const _s = s / 100;
  const _l = l / 100;
  const c = (1 - Math.abs(2 * _l - 1)) * _s;
  const hp = (h % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (hp >= 0 && hp < 1) [r1, g1, b1] = [c, x, 0];
  else if (hp >= 1 && hp < 2) [r1, g1, b1] = [x, c, 0];
  else if (hp >= 2 && hp < 3) [r1, g1, b1] = [0, c, x];
  else if (hp >= 3 && hp < 4) [r1, g1, b1] = [0, x, c];
  else if (hp >= 4 && hp < 5) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];
  const m = _l - c / 2;
  const r = Math.round((r1 + m) * 255);
  const g = Math.round((g1 + m) * 255);
  const b = Math.round((b1 + m) * 255);
  const toHex = (n) => n.toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function colorForRobot(robotId) {
  const id = String(robotId || 'robot');
  const h = hashStringToInt(id) % 360;
  return hslToHex(h, 78, 55);
}

function easeOut(t) {
  return t * (2 - t);
}

function getLngLatArray(lngLat) {
  if (!lngLat) return null;
  const lng = typeof lngLat.lng === 'number' ? lngLat.lng : null;
  const lat = typeof lngLat.lat === 'number' ? lngLat.lat : null;
  if (lng === null || lat === null) return null;
  return [lng, lat];
}

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
  // Remove glow/casing sublayers first (added before the main layer, must be removed before source)
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

function ensureLineLayer({ map, sourceId, layerId, data, color, dashed, opacity }) {
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

  // Casing — thin dark/white halo under the main line so the small, expected
  // divergence between our full-precision route and the basemap's
  // zoom-simplified road geometry reads as an intentional "route corridor"
  // instead of visual misalignment.
  const casingLayerId = `${layerId}-casing`;
  if (!map.getLayer(casingLayerId)) {
    try {
      map.addLayer({
        id: casingLayerId,
        type: 'line',
        source: sourceId,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': '#0b1220',
          'line-width': zoomCasingWidth(dashed),
          'line-opacity': dashed ? 0.35 : 0.55,
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
}) {
  const [robots, setRobots] = useState([]);

  const activeRobotIdsRef = useRef(new Set());
  const routesRef = useRef(new Map());
  const taskPathsRef = useRef(new Map());

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
      if (pickupTodo) ensureLineLayer({ map, sourceId: pickupTodoSourceId, layerId: pickupTodoLayerId, data: pickupTodo, color, dashed: true, opacity: 0.75 });
      if (pickupDone) ensureLineLayer({ map, sourceId: pickupDoneSourceId, layerId: pickupDoneLayerId, data: pickupDone, color, dashed: true, opacity: 0.22 });
      if (dropTodo) ensureLineLayer({ map, sourceId: dropTodoSourceId, layerId: dropTodoLayerId, data: dropTodo, color, dashed: false, opacity: 0.9 });
      if (dropDone) ensureLineLayer({ map, sourceId: dropDoneSourceId, layerId: dropDoneLayerId, data: dropDone, color, dashed: false, opacity: 0.25 });

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
    [mapRef, removeRouteForRobot]
  );

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

    socket.on('TASK_ASSIGNED', onAssigned);
    socket.on('TASK_UPDATED', onTaskUpdated);
    return () => {
      socket.off('TASK_ASSIGNED', onAssigned);
      socket.off('TASK_UPDATED', onTaskUpdated);
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

  // Keep every marker's visual size proportionate to the current zoom.
  // Fixed-pixel markers stay the same SCREEN size at any zoom, so at low
  // zoom a 26-36px icon can cover hundreds of metres of ground — making an
  // exactly-correct coordinate look like it's floating far from the road
  // purely from oversized icon footprint, not a positioning bug. Shrinking
  // markers as you zoom out (mirrors Uber/Swiggy) keeps them visually
  // anchored to the road at every zoom level.
  useEffect(() => {
    const map = mapRef?.current;
    if (!map) return;

    const applyToAll = () => {
      const zoom = map.getZoom();
      for (const entry of markersRef?.current?.values() || []) {
        applyMarkerZoomScale(entry?.scaleWrap, zoom);
      }
      for (const entry of routesRef.current.values()) {
        applyMarkerZoomScale(entry?.pickupMarker?.getElement?.()?._scaleWrap, zoom);
        applyMarkerZoomScale(entry?.dropMarker?.getElement?.()?._scaleWrap, zoom);
      }
    };

    applyToAll();

    try {
      map.on('zoom', applyToAll);
    } catch {
      // ignore
    }

    return () => {
      try {
        map.off('zoom', applyToAll);
      } catch {
        // ignore
      }
    };
  }, [mapRef, markersRef]);

  const upsertMarker = useCallback(
    (robot) => {
      const map = mapRef?.current;
      if (!map) return;

      const robotId = String(robot?.robotId || '').trim();
      if (!robotId) return;

      const lat = typeof robot?.lat === 'number' ? robot.lat : null;
      const lon = typeof robot?.lon === 'number' ? robot.lon : null;
      if (lat === null || lon === null) return;

      const key = robotId;
      const store = markersRef?.current;
      if (!store) return;

      let entry = store.get(key);

      const to = [lon, lat];

      const heading = typeof robot?.heading === 'number' ? robot.heading : null;

      if (!entry) {
        const color = colorForRobot(robotId);
        const { root, car, label, scaleWrap } = createRobotMarkerElement(color, robotId);

        // NOTE: the appear animation and zoom-scaling both animate `scaleWrap`,
        // never `root` — `root.style.transform` is owned by Mapbox (it writes
        // its own translate/anchor transform onto the element passed to
        // `mapboxgl.Marker`), so animating `root.style.transform` here would
        // fight Mapbox's positioning and leave the marker mispositioned until
        // the next map move/zoom re-triggers Mapbox's own update.
        scaleWrap.style.opacity = '0';
        scaleWrap.style.transform = 'scale(0.75)';
        scaleWrap.style.willChange = 'transform, opacity';

        const marker = new mapboxgl.Marker({ element: root, anchor: 'center' }).setLngLat(to).addTo(map);
        applyMarkerZoomScale(scaleWrap, map.getZoom());

        entry = {
          marker,
          root,
          carEl: car,
          labelEl: label,
          scaleWrap,
          current: to,
          rafId: null,
          target: to,
        };

        store.set(key, entry);

        if (entry.carEl && typeof heading === 'number') {
          entry.carEl.style.transform = `rotate(${heading}deg)`;
        }

        upsertRoutes(robot);

        // Framer Motion: marker appearance (fade + pop).
        // animate() returns AnimationPlaybackControls (not a Promise) in framer-motion v11+,
        // so we can't call .catch() on it — wrap in try-catch instead.
        try {
          animate(
            scaleWrap,
            { opacity: [0, 1], transform: ['scale(0.75)', `scale(${markerScaleForZoom(map.getZoom())})`] },
            { duration: 0.35, ease: 'easeOut' }
          );
        } catch {
          // ignore animation errors (e.g. element removed before animation completes)
        }

        return;
      }

      if (entry.carEl && typeof heading === 'number') {
        entry.carEl.style.transform = `rotate(${heading}deg)`;
      }

      upsertRoutes(robot);

      // Smooth movement (interpolated, no jumps)
      const from = Array.isArray(entry.current) ? entry.current : getLngLatArray(entry.marker?.getLngLat?.());
      if (!from) {
        try {
          entry.marker?.setLngLat?.(to);
          entry.current = to;
        } catch {
          // ignore
        }
        return;
      }

      const start = performance.now();
      // Match RAF duration to telemetry interval (2 000 ms) minus a small margin
      // so the marker reaches the new position just before the next tick arrives.
      const duration = 1800;

      entry.target = to;

      try {
        if (entry.rafId) cancelAnimationFrame(entry.rafId);
      } catch {
        // ignore
      }

      const step = (now) => {
        const t = Math.min(1, (now - start) / duration);
        const e = easeOut(t);
        const lng = from[0] + (to[0] - from[0]) * e;
        const lat2 = from[1] + (to[1] - from[1]) * e;

        try {
          entry.marker?.setLngLat?.([lng, lat2]);
        } catch {
          // ignore
        }

        if (t < 1) {
          entry.rafId = requestAnimationFrame(step);
        } else {
          entry.rafId = null;
          entry.current = to;
        }
      };

      entry.rafId = requestAnimationFrame(step);
    },
    [mapRef, markersRef, upsertRoutes]
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

      // Remove stale markers for robots not in current filter.
      for (const [id, entry] of store.entries()) {
        if (nextIds.has(id)) continue;
        try {
          if (entry?.rafId) cancelAnimationFrame(entry.rafId);
        } catch {
          // ignore
        }
        try {
          entry?.marker?.remove?.();
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

      upsertMarker(data);

      // Refresh battery bar and status icon in-place (no marker recreate).
      const _store = markersRef?.current;
      if (_store) {
        const _entry = _store.get(robotId);
        if (_entry?.root) {
          updateMarkerInfo(_entry.root, { battery: data.battery, status: data.status });
        }
      }

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
    for (const entry of markersRef?.current?.values() || []) {
      try {
        const ll = entry?.marker?.getLngLat?.();
        if (ll) points.push({ lat: ll.lat, lon: ll.lng });
      } catch {
        // ignore
      }
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
