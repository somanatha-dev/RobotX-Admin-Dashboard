import React, { useEffect, useMemo, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';

import { useAppState } from '../../context/appContext.js';
import { createRobotMarkerElement } from '../../lib/mapboxMarkers.js';

const MAP_STYLE = 'mapbox://styles/mapbox/dark-v11';
const DEFAULT_CENTER = [77.5199, 12.9256]; // RR Nagar approx
const DEFAULT_ZOOM = 14;

function hashStringToInt(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function hslToHex(h, s, l) {
  // h: 0..360, s/l: 0..100
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
  // keep saturation/lightness in a readable range on dark map
  return hslToHex(h, 78, 55);
}

function toRouteKey(fromLngLat, toLngLat) {
  const f0 = Number(fromLngLat[0]).toFixed(5);
  const f1 = Number(fromLngLat[1]).toFixed(5);
  const t0 = Number(toLngLat[0]).toFixed(5);
  const t1 = Number(toLngLat[1]).toFixed(5);
  return `${f0},${f1};${t0},${t1}`;
}

async function fetchDirectionsRoute({ fromLngLat, toLngLat, accessToken, signal }) {
  const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${fromLngLat[0]},${fromLngLat[1]};${toLngLat[0]},${toLngLat[1]}?geometries=geojson&overview=full&access_token=${accessToken}`;
  const res = await fetch(url, { signal });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Directions API failed (${res.status}): ${text || res.statusText}`);
  }
  const json = await res.json();
  const route = json?.routes?.[0];
  const coords = route?.geometry?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) throw new Error('Directions API returned no route geometry.');
  return coords;
}

async function getRouteCached({ cache, fromLngLat, toLngLat, accessToken, signal }) {
  const key = toRouteKey(fromLngLat, toLngLat);
  const existing = cache.get(key);
  if (existing?.status === 'ready') return existing.coords;
  if (existing?.status === 'pending') return existing.promise;

  const promise = fetchDirectionsRoute({ fromLngLat, toLngLat, accessToken, signal }).then((coords) => {
    cache.set(key, { status: 'ready', coords });
    return coords;
  });
  cache.set(key, { status: 'pending', promise });
  return promise;
}

function setLineData(map, sourceId, coords) {
  const safe = Array.isArray(coords) && coords.length >= 2 ? coords : [[0, 0], [0, 0]];
  const src = map.getSource(sourceId);
  src?.setData?.({
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: safe },
    properties: {},
  });
}

function ensureRouteLayers(map, robotId, color) {
  const pickupSourceId = `robot-to-pickup-${robotId}`;
  const dropSourceId = `robot-to-drop-${robotId}`;
  const pickupLayerId = `robot-to-pickup-layer-${robotId}`;
  const dropLayerId = `robot-to-drop-layer-${robotId}`;

  const emptyLine = {
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: [[0, 0], [0, 0]] },
    properties: {},
  };

  if (!map.getSource(pickupSourceId)) map.addSource(pickupSourceId, { type: 'geojson', data: emptyLine });
  if (!map.getSource(dropSourceId)) map.addSource(dropSourceId, { type: 'geojson', data: emptyLine });

  // Dashed to pickup
  if (!map.getLayer(pickupLayerId)) {
    map.addLayer({
      id: pickupLayerId,
      type: 'line',
      source: pickupSourceId,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': color,
        'line-width': 4,
        'line-opacity': 0.75,
        'line-dasharray': [2, 2],
      },
    });
  }

  // Solid to drop
  if (!map.getLayer(dropLayerId)) {
    map.addLayer({
      id: dropLayerId,
      type: 'line',
      source: dropSourceId,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': color,
        'line-width': 4,
        'line-opacity': 0.8,
      },
    });
  }

  return { pickupSourceId, dropSourceId, pickupLayerId, dropLayerId };
}

function removeRobotRouteLayers(map, robotId) {
  const pickupSourceId = `robot-to-pickup-${robotId}`;
  const dropSourceId = `robot-to-drop-${robotId}`;
  const pickupLayerId = `robot-to-pickup-layer-${robotId}`;
  const dropLayerId = `robot-to-drop-layer-${robotId}`;

  try {
    if (map.getLayer(pickupLayerId)) map.removeLayer(pickupLayerId);
  } catch {
    // ignore
  }
  try {
    if (map.getLayer(dropLayerId)) map.removeLayer(dropLayerId);
  } catch {
    // ignore
  }
  try {
    if (map.getSource(pickupSourceId)) map.removeSource(pickupSourceId);
  } catch {
    // ignore
  }
  try {
    if (map.getSource(dropSourceId)) map.removeSource(dropSourceId);
  } catch {
    // ignore
  }
}

export default function FleetDbMap({ center }) {
  const { robots } = useAppState();

  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef(new Map());
  const routeCacheRef = useRef(new Map());
  const abortRef = useRef(null);

  const mapCenter = useMemo(() => {
    if (Array.isArray(center) && center.length === 2) return center;
    return DEFAULT_CENTER;
  }, [center]);

  useEffect(() => {
    const accessToken = import.meta.env.VITE_MAPBOX_TOKEN;
    if (!accessToken) return undefined;

    mapboxgl.accessToken = accessToken;

    const map = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: MAP_STYLE,
      center: mapCenter,
      zoom: DEFAULT_ZOOM,
      attributionControl: false,
    });

    mapRef.current = map;
    abortRef.current = new AbortController();

    map.addControl(new mapboxgl.NavigationControl({ showCompass: true }), 'top-left');

    const onLoad = () => {
      // nothing special — we add layers lazily when tasks exist
    };
    map.on('load', onLoad);

    return () => {
      try {
        abortRef.current?.abort?.();
      } catch {
        // ignore
      }
      abortRef.current = null;

      try {
        markersRef.current.forEach((m) => m?.marker?.remove?.());
      } catch {
        // ignore
      }
      markersRef.current.clear();

      try {
        map.remove();
      } catch {
        // ignore
      }
      mapRef.current = null;
    };
  }, [mapCenter]);

  useEffect(() => {
    const map = mapRef.current;
    const accessToken = import.meta.env.VITE_MAPBOX_TOKEN;
    if (!map || !accessToken) return;

    const list = Array.isArray(robots) ? robots : [];

    // Upsert markers for commissioned robots only (must have coordinates)
    const nextIds = new Set();
    for (const r of list) {
      const robotId = String(r?.robotId || '').trim();
      if (!robotId) continue;
      if (typeof r?.lon !== 'number' || typeof r?.lat !== 'number') continue;

      nextIds.add(robotId);

      let entry = markersRef.current.get(robotId);
      if (!entry) {
        const color = colorForRobot(robotId);
        const { root, car, label } = createRobotMarkerElement(color, robotId);
        const marker = new mapboxgl.Marker({ element: root, anchor: 'center' }).setLngLat([r.lon, r.lat]).addTo(map);
        entry = { marker, carEl: car, labelEl: label, color };
        markersRef.current.set(robotId, entry);
      } else {
        try {
          entry.marker?.setLngLat?.([r.lon, r.lat]);
        } catch {
          // ignore
        }
      }

      // Routes only when a task is allocated
      const task = r?.currentTask;
      const hasTask = Boolean(task && task.pickupLat != null && task.pickupLon != null && task.dropLat != null && task.dropLon != null);
      if (!hasTask) {
        removeRobotRouteLayers(map, robotId);
        continue;
      }

      const from = [r.lon, r.lat];
      const pickup = [task.pickupLon, task.pickupLat];
      const drop = [task.dropLon, task.dropLat];

      const color = entry.color || colorForRobot(robotId);

      // Ensure layers exist and populate with directions geometry.
      try {
        ensureRouteLayers(map, robotId, color);
      } catch {
        // ignore
      }

      const abortController = abortRef.current;
      if (!abortController) continue;

      Promise.all([
        getRouteCached({ cache: routeCacheRef.current, fromLngLat: from, toLngLat: pickup, accessToken, signal: abortController.signal }),
        getRouteCached({ cache: routeCacheRef.current, fromLngLat: pickup, toLngLat: drop, accessToken, signal: abortController.signal }),
      ])
        .then(([toPickupCoords, toDropCoords]) => {
          if (abortController.signal.aborted) return;
          try {
            setLineData(map, `robot-to-pickup-${robotId}`, toPickupCoords);
            setLineData(map, `robot-to-drop-${robotId}`, toDropCoords);
          } catch {
            // ignore
          }
        })
        .catch(() => {
          // ignore
        });
    }

    // Remove stale markers + any lingering route layers.
    for (const [id, entry] of markersRef.current.entries()) {
      if (nextIds.has(id)) continue;
      try {
        entry?.marker?.remove?.();
      } catch {
        // ignore
      }
      markersRef.current.delete(id);
      removeRobotRouteLayers(map, id);
    }
  }, [robots]);

  const missingToken = !import.meta.env.VITE_MAPBOX_TOKEN;

  return (
    <div className="w-full h-full relative">
      {missingToken ? (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-950 text-slate-200">
          <div className="text-sm font-semibold">Missing `VITE_MAPBOX_TOKEN`</div>
        </div>
      ) : null}
      <div ref={mapContainerRef} className="w-full h-full" />
    </div>
  );
}
