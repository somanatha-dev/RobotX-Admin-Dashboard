/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import { animate } from 'framer-motion';

import * as robotsApi from '../../../../lib/api/robots.js';
import { socket } from '../../../../lib/socket.js';
import { createRobotMarkerElement } from '../../../../lib/mapboxMarkers.js';

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

function safeRemoveLayerAndSource(map, layerId, sourceId) {
  if (!map) return;
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

function ensureLineLayer({ map, sourceId, layerId, data, color, dashed, opacity }) {
  if (!map || !data) return;

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

  if (!map.getLayer(layerId)) {
    try {
      map.addLayer({
        id: layerId,
        type: 'line',
        source: sourceId,
        layout: {
          'line-join': 'round',
          'line-cap': 'round',
        },
        paint: {
          'line-color': color,
          'line-width': dashed ? 3 : 4,
          'line-opacity': typeof opacity === 'number' ? opacity : dashed ? 0.7 : 0.85,
          ...(dashed ? { 'line-dasharray': [2, 2] } : {}),
        },
      });
    } catch {
      // ignore
    }
  }
}

function createMissionMarkerEl({ color, label }) {
  const root = document.createElement('div');
  root.style.width = '14px';
  root.style.height = '14px';
  root.style.borderRadius = '9999px';
  root.style.background = color;
  root.style.border = '2px solid rgba(15, 23, 42, 0.9)';
  root.style.boxShadow = '0 1px 2px rgba(0,0,0,0.25)';
  root.style.position = 'relative';

  const tag = document.createElement('div');
  tag.textContent = label;
  tag.style.position = 'absolute';
  tag.style.left = '50%';
  tag.style.bottom = '100%';
  tag.style.transform = 'translate(-50%, -6px)';
  tag.style.padding = '2px 6px';
  tag.style.borderRadius = '9999px';
  tag.style.background = 'rgba(15, 23, 42, 0.9)';
  tag.style.color = '#fff';
  tag.style.fontSize = '10px';
  tag.style.fontWeight = '700';
  tag.style.letterSpacing = '0.04em';
  tag.style.whiteSpace = 'nowrap';
  tag.style.pointerEvents = 'none';

  root.appendChild(tag);
  return root;
}

export function useRobotStream({ locationId, campusId, mapRef, markersRef }) {
  const [robots, setRobots] = useState([]);

  const activeRobotIdsRef = useRef(new Set());
  const abortFetchRef = useRef(null);
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

      const pickupLL = toLngLat(pickup);
      const dropLL = toLngLat(drop);

      if (pickupLL) {
        if (!pickupMarker) {
          pickupMarker = new mapboxgl.Marker({
            element: createMissionMarkerEl({ color: '#ef4444', label: 'Pickup' }),
            anchor: 'bottom',
          })
            .setLngLat(pickupLL)
            .addTo(map);
        } else {
          try {
            pickupMarker.setLngLat(pickupLL);
          } catch {
            // ignore
          }
        }
      }

      if (dropLL) {
        if (!dropMarker) {
          dropMarker = new mapboxgl.Marker({
            element: createMissionMarkerEl({ color: '#22c55e', label: 'Drop' }),
            anchor: 'bottom',
          })
            .setLngLat(dropLL)
            .addTo(map);
        } else {
          try {
            dropMarker.setLngLat(dropLL);
          } catch {
            // ignore
          }
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
  useEffect(() => {
    const onAssigned = (msg) => {
      const taskId = String(msg?.taskId || '').trim();
      const robotId = String(msg?.robotId || '').trim();
      if (!taskId) return;

      const pathToPickup = Array.isArray(msg?.pathToPickup) ? msg.pathToPickup : null;
      const pathToDrop = Array.isArray(msg?.pathToDrop) ? msg.pathToDrop : null;
      if (!pathToPickup || !pathToDrop) return;

      taskPathsRef.current.set(taskId, {
        taskId,
        robotId: robotId || null,
        pickup: msg?.pickup ?? null,
        drop: msg?.drop ?? null,
        pathToPickup,
        pathToDrop,
      });

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
      }
    };

    socket.on('TASK_ASSIGNED', onAssigned);
    return () => {
      socket.off('TASK_ASSIGNED', onAssigned);
    };
  }, [upsertRoutes]);

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
        const { root, car, label } = createRobotMarkerElement(color, robotId);

        root.style.opacity = '0';
        root.style.transform = 'scale(0.75)';
        root.style.willChange = 'transform, opacity';

        const marker = new mapboxgl.Marker({ element: root, anchor: 'center' }).setLngLat(to).addTo(map);

        entry = {
          marker,
          root,
          carEl: car,
          labelEl: label,
          current: to,
          rafId: null,
          target: to,
        };

        store.set(key, entry);

        if (entry.carEl && typeof heading === 'number') {
          entry.carEl.style.transformOrigin = '50% 50%';
          entry.carEl.style.transform = `rotate(${heading}deg)`;
          entry.carEl.style.willChange = 'transform';
        }

        upsertRoutes(robot);

        // Framer Motion: marker appearance (fade + pop)
        animate(
          root,
          { opacity: [0, 1], transform: ['scale(0.75)', 'scale(1)'] },
          { duration: 0.35, ease: 'easeOut' }
        ).catch(() => {});

        return;
      }

      if (entry.carEl && typeof heading === 'number') {
        entry.carEl.style.transformOrigin = '50% 50%';
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
      const duration = 800;

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

  // Fetch robots for the selected Area (or Campus).
  useEffect(() => {
    const map = mapRef?.current;
    if (!map) return;

    try {
      abortFetchRef.current?.abort?.();
    } catch {
      // ignore
    }

    const ac = new AbortController();
    abortFetchRef.current = ac;

    if (!locationId && !campusId) {
      setRobots([]);
      syncMarkersToRobots([]);
      return () => {
        try {
          ac.abort();
        } catch {
          // ignore
        }
      };
    }

    (async () => {
      try {
        const list = await robotsApi.listRobots({
          locationId,
          campusId,
          includeDescendants: true,
        });
        if (ac.signal.aborted) return;
        setRobots(Array.isArray(list) ? list : []);
        syncMarkersToRobots(list);
      } catch {
        if (ac.signal.aborted) return;
        setRobots([]);
        syncMarkersToRobots([]);
      }
    })();

    return () => {
      try {
        ac.abort();
      } catch {
        // ignore
      }
    };
  }, [locationId, campusId, mapRef, syncMarkersToRobots]);

  // Live updates via Socket.IO
  useEffect(() => {
    const handler = (data) => {
      const robotId = String(data?.robotId || '').trim();
      if (!robotId) return;

      // Only update markers we are currently tracking (active filter).
      if (!activeRobotIdsRef.current.has(robotId)) return;

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

    socket.on('robot:update', handler);
    socket.on('robot_update', handler);
    socket.on('ROBOT_UPDATE', handler);

    const handlerBatch = (list) => {
      const arr = Array.isArray(list) ? list : [];
      for (const item of arr) handler(item);
    };

    socket.on('ROBOT_UPDATE_BATCH', handlerBatch);
    return () => {
      socket.off('robot:update', handler);
      socket.off('robot_update', handler);
      socket.off('ROBOT_UPDATE', handler);
      socket.off('ROBOT_UPDATE_BATCH', handlerBatch);
    };
  }, [upsertMarker]);

  const robotCount = useMemo(() => (Array.isArray(robots) ? robots.length : 0), [robots]);

  return {
    robots,
    robotCount,
  };
}
