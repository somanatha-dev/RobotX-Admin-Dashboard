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

export function useRobotStream({ locationId, campusId, mapRef, markersRef }) {
  const [robots, setRobots] = useState([]);

  const activeRobotIdsRef = useRef(new Set());
  const abortFetchRef = useRef(null);

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

        // Framer Motion: marker appearance (fade + pop)
        animate(
          root,
          { opacity: [0, 1], transform: ['scale(0.75)', 'scale(1)'] },
          { duration: 0.35, ease: 'easeOut' }
        ).catch(() => {});

        return;
      }

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
    [mapRef, markersRef]
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
      }

      activeRobotIdsRef.current = nextIds;
    },
    [mapRef, markersRef, upsertMarker]
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
    return () => {
      socket.off('robot:update', handler);
    };
  }, [upsertMarker]);

  const robotCount = useMemo(() => (Array.isArray(robots) ? robots.length : 0), [robots]);

  return {
    robots,
    robotCount,
  };
}
