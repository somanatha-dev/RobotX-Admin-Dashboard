/**
 * The DTARO overlay: published zones (or, behind a toggle, the proposal preview), obstacle
 * markers, the selected obstacle's footprint and rings around the robots involved in it.
 * Geometry from `zoneModel.js` / the obstacle activity store; layers from `dtaroLayers.js`.
 *
 * Lifecycle (the same rules as the charging overlay):
 *   · installed once per style load, idempotently — a style reload or a remount restores exactly
 *     one copy of each layer, and the hook removes what it added on unmount;
 *   · data pushed with `setData` only when a collection's content changed — never per telemetry
 *     tick for zones or obstacles; the involved-robot rings follow robot positions only while an
 *     obstacle is selected, and no more than once a second;
 *   · label colours follow the theme in place.
 */

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';

import {
  DTARO_SOURCE,
  applyDtaroTheme,
  footprintCollection,
  installDtaroLayers,
  obstacleCollection,
  obstacleIdAtPoint,
  partiesCollection,
  removeDtaroLayers,
  setDtaroData,
} from './dtaroLayers.js';
import { zoneAtPoint, zoneEdgeCollection, zoneFeatureCollection, zoneLabelCollection } from './zoneModel.js';
import { areaFeatureCollection, areaLabelCollection } from './campusAreas.js';
import { recipientStatus } from '@/lib/obstacleActivity.js';

const PARTY_REFRESH_MS = 1000;

/** No preview: the cell grid source stays empty. */
const EMPTY_CELLS = Object.freeze({ type: 'FeatureCollection', features: [] });

function setSelected(map, obstacleId, selected) {
  if (!obstacleId) return;
  try {
    map.setFeatureState({ source: DTARO_SOURCE.OBSTACLES, id: obstacleId }, { selected });
  } catch {
    // not installed yet — re-applied on the next install
  }
}

/**
 * The zone at the map centre, re-read when the camera stops moving — so the legend can name the
 * zone in view even when none of its boundary is on screen (a campus-wide zone seen from inside).
 *
 * @param {{ current: object|null }} mapRef
 * @param {{ isMapLoaded: boolean, zones: object[] }} options
 * @returns {object|null}
 */
export function useZoneAtCentre(mapRef, { isMapLoaded, zones } = {}) {
  const subscribe = useCallback(
    (notify) => {
      const map = mapRef?.current;
      if (!map || !isMapLoaded) return () => {};
      try {
        map.on('moveend', notify);
      } catch {
        // ignore
      }
      return () => {
        try {
          map.off('moveend', notify);
        } catch {
          // ignore
        }
      };
    },
    [mapRef, isMapLoaded]
  );
  // A string, so an unmoved camera is the same snapshot (useSyncExternalStore compares by value).
  const readCentre = useCallback(() => {
    const map = mapRef?.current;
    if (!map || !isMapLoaded) return null;
    try {
      const c = map.getCenter();
      return Number.isFinite(c?.lng) && Number.isFinite(c?.lat) ? `${c.lng.toFixed(6)},${c.lat.toFixed(6)}` : null;
    } catch {
      return null;
    }
  }, [mapRef, isMapLoaded]);
  const centre = useSyncExternalStore(subscribe, readCentre, () => null);
  return useMemo(() => {
    if (!centre || !zones?.length) return null;
    const [lon, lat] = centre.split(',').map(Number);
    return zoneAtPoint(zones, lon, lat);
  }, [centre, zones]);
}

/**
 * @param {{ current: object|null }} mapRef
 * @param {object} options
 * @param {boolean} options.isMapLoaded
 * @param {boolean} options.enabled          false: nothing is installed at all (feature off)
 * @param {object[]} options.zones           zones to draw (live or preview), from zoneModel
 * @param {Set<string>} options.hiddenZones  zone keys switched off in the legend
 * @param {object[]} [options.areas]         visual campus areas (campusAreas.js) — [] to hide
 * @param {object|null} [options.previewCells] the proposal preview's cell grid
 *                                           (`zoneModel.previewCellCollection`); null when off
 * @param {object[]} options.obstacles       obstacles in scope for the selected campus
 * @param {number} [options.nowMs]           the page clock, so a marker turns expired on time
 * @param {object|null} options.selectedObstacle
 * @param {object[]} options.robots          the fleet (for the involved-robot rings)
 * @param {{ current: object|null }} [options.themeRef]
 * @param {(fn: (theme: object) => void) => (() => void)} [options.subscribeToTheme]
 * @param {(obstacleId: string) => void} [options.onSelectObstacle]
 */
export function useDtaroLayer(
  mapRef,
  {
    isMapLoaded,
    enabled,
    zones,
    hiddenZones,
    areas,
    previewCells,
    obstacles,
    nowMs,
    selectedObstacle,
    robots,
    themeRef,
    subscribeToTheme,
    onSelectObstacle,
  } = {}
) {
  const selectedId = selectedObstacle?.obstacleId || null;

  const zoneData = useMemo(() => zoneFeatureCollection(zones || [], hiddenZones), [zones, hiddenZones]);
  const labelData = useMemo(() => zoneLabelCollection(zones || [], hiddenZones), [zones, hiddenZones]);
  const edgeData = useMemo(() => zoneEdgeCollection(zones || [], hiddenZones), [zones, hiddenZones]);
  const areaData = useMemo(() => areaFeatureCollection(areas || []), [areas]);
  const areaLabelData = useMemo(() => areaLabelCollection(areas || []), [areas]);
  const previewCellData = useMemo(() => previewCells || EMPTY_CELLS, [previewCells]);
  // Rebuilt when the list changes or when an obstacle crosses its expiry, never on every tick:
  // an expired obstacle must stop looking active on the map without waiting for another event.
  const clock = Number.isFinite(nowMs) ? nowMs : Date.now();
  const expiredKey = (obstacles || []).filter((o) => Number.isFinite(o?.expiresAtMs) && o.expiresAtMs <= clock).map((o) => o.obstacleId).join('|');
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `clock` is captured through `expiredKey`
  const obstacleData = useMemo(() => obstacleCollection(obstacles || [], clock), [obstacles, expiredKey]);
  const footprintData = useMemo(() => footprintCollection(selectedObstacle), [selectedObstacle]);

  // Read by the style.load / click handlers, which outlive any one render.
  const latestRef = useRef(null);
  const onSelectRef = useRef(onSelectObstacle);
  useEffect(() => {
    latestRef.current = {
      [DTARO_SOURCE.ZONES]: zoneData,
      [DTARO_SOURCE.ZONE_LABELS]: labelData,
      [DTARO_SOURCE.ZONE_EDGES]: edgeData,
      [DTARO_SOURCE.AREAS]: areaData,
      [DTARO_SOURCE.AREA_LABELS]: areaLabelData,
      [DTARO_SOURCE.PREVIEW_CELLS]: previewCellData,
      [DTARO_SOURCE.OBSTACLES]: obstacleData,
      [DTARO_SOURCE.FOOTPRINT]: footprintData,
    };
    onSelectRef.current = onSelectObstacle;
  });
  const selectedRef = useRef(selectedId);
  useEffect(() => {
    selectedRef.current = selectedId;
  }, [selectedId]);

  // ── Install (once per style load) ─────────────────────────────────────────
  useEffect(() => {
    const map = mapRef?.current;
    if (!map || !isMapLoaded || !enabled) return undefined;
    const install = () => {
      installDtaroLayers(map, { theme: themeRef?.current || null, data: latestRef.current });
      setSelected(map, selectedRef.current, true);
    };
    install();
    try {
      map.on('style.load', install);
    } catch {
      // ignore
    }
    return () => {
      try {
        map.off('style.load', install);
      } catch {
        // ignore
      }
      removeDtaroLayers(map);
    };
  }, [mapRef, isMapLoaded, enabled, themeRef]);

  // ── Data (only what changed) ──────────────────────────────────────────────
  const pushedRef = useRef({ map: null, keys: {} });
  useEffect(() => {
    const map = mapRef?.current;
    if (!map || !isMapLoaded || !enabled) return;
    if (pushedRef.current.map !== map) pushedRef.current = { map, keys: {} };
    const pushed = pushedRef.current.keys;
    const changed = {};
    for (const [id, collection] of [
      [DTARO_SOURCE.ZONES, zoneData],
      [DTARO_SOURCE.ZONE_LABELS, labelData],
      [DTARO_SOURCE.ZONE_EDGES, edgeData],
      [DTARO_SOURCE.AREAS, areaData],
      [DTARO_SOURCE.AREA_LABELS, areaLabelData],
      [DTARO_SOURCE.PREVIEW_CELLS, previewCellData],
      [DTARO_SOURCE.OBSTACLES, obstacleData],
      [DTARO_SOURCE.FOOTPRINT, footprintData],
    ]) {
      const key = JSON.stringify(collection);
      if (key !== pushed[id]) {
        changed[id] = collection;
        pushed[id] = key;
      }
    }
    if (Object.keys(changed).length > 0) setDtaroData(map, changed);
  }, [mapRef, isMapLoaded, enabled, zoneData, labelData, edgeData, areaData, areaLabelData, previewCellData, obstacleData, footprintData]);

  // ── Involved-robot rings: only while an obstacle is selected, at most once a second ──
  const robotsRef = useRef(robots);
  useEffect(() => {
    robotsRef.current = robots;
  }, [robots]);
  useEffect(() => {
    const map = mapRef?.current;
    if (!map || !isMapLoaded || !enabled) return undefined;
    let lastKey = null;
    const push = () => {
      const positions = new Map();
      for (const r of robotsRef.current || []) {
        if (r?.robotId && Number.isFinite(r.lat) && Number.isFinite(r.lon)) positions.set(String(r.robotId), { lat: r.lat, lon: r.lon });
      }
      const data = partiesCollection(selectedObstacle, positions, recipientStatus);
      const key = JSON.stringify(data);
      if (key === lastKey) return;
      lastKey = key;
      setDtaroData(map, { [DTARO_SOURCE.PARTIES]: data });
    };
    push();
    if (!selectedObstacle) return undefined;
    const timer = setInterval(push, PARTY_REFRESH_MS);
    return () => {
      clearInterval(timer);
      setDtaroData(map, { [DTARO_SOURCE.PARTIES]: partiesCollection(null, new Map(), recipientStatus) });
    };
  }, [mapRef, isMapLoaded, enabled, selectedObstacle]);

  // ── Theme frames ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!enabled || typeof subscribeToTheme !== 'function') return undefined;
    return subscribeToTheme((theme) => applyDtaroTheme(mapRef?.current, theme));
  }, [enabled, subscribeToTheme, mapRef]);

  // ── Selection → feature state ─────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef?.current;
    if (!map || !isMapLoaded || !enabled || !selectedId) return undefined;
    setSelected(map, selectedId, true);
    return () => setSelected(map, selectedId, false);
  }, [mapRef, isMapLoaded, enabled, selectedId]);

  // ── Click and hover on obstacle markers ───────────────────────────────────
  const hasObstacles = obstacleData.features.length > 0;
  useEffect(() => {
    const map = mapRef?.current;
    if (!map || !isMapLoaded || !enabled || !hasObstacles) return undefined;
    let hovering = false;
    const onClick = (event) => {
      const id = obstacleIdAtPoint(map, event.point);
      if (id) onSelectRef.current?.(id);
    };
    const onMove = (event) => {
      const over = Boolean(obstacleIdAtPoint(map, event.point));
      if (over === hovering) return;
      hovering = over;
      try {
        map.getCanvas().style.cursor = over ? 'pointer' : '';
      } catch {
        // ignore
      }
    };
    try {
      map.on('click', onClick);
      map.on('mousemove', onMove);
    } catch {
      // ignore
    }
    return () => {
      try {
        map.off('click', onClick);
        map.off('mousemove', onMove);
        if (hovering) map.getCanvas().style.cursor = '';
      } catch {
        // ignore
      }
    };
  }, [mapRef, isMapLoaded, enabled, hasObstacles]);
}
