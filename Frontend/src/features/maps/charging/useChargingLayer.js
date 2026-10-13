/**
 * The charging overlay: charging stations (a miniature 3D installation at campus zoom, a badge
 * below it, with capacity, occupancy and queue) and each simulated robot's route to its charger.
 * Geometry and state from `chargingGeoJson.js` / `stationModel.js`; layers from
 * `stationLayers.js`. Nothing here decides where anything is.
 *
 * Lifecycle:
 *   · installed once per style load (`style.load` discards every source, layer and image) —
 *     idempotently, so a re-install restores exactly one copy of each;
 *   · updated in place with `setData` when the simulator's report changes (every poll), never per
 *     telemetry tick and never by tearing layers down — so a report refresh cannot flicker;
 *   · re-coloured in place on theme frames;
 *   · the activity ring animates only while the report shows a robot CHARGING at a station, the
 *     page is visible, and the operator has not asked for reduced motion.
 */

import { useEffect, useMemo, useRef } from 'react';

import { documentVisible, prefersReducedMotion, subscribeReducedMotion } from '@/lib/reducedMotion.js';

import {
  CHARGING_LAYER,
  CHARGING_SOURCE,
  applyChargingTheme,
  chargingOverlayData,
  installChargingLayers,
  removeChargingLayers,
  ringRadiusExpr,
  setChargingData,
  stationIdAtPoint,
} from './stationLayers.js';
import { stationSummaries } from './stationModel.js';

/** One activity-ring cycle. Slow on purpose: it says "power is flowing", not "look here". */
const PULSE_PERIOD_MS = 2400;
const PULSE_STEP_MS = 100;

function setStationState(map, chargerId, state) {
  if (!chargerId) return;
  try {
    map.setFeatureState({ source: CHARGING_SOURCE.STATIONS, id: chargerId }, state);
  } catch {
    // the source is not installed (yet) — re-applied on the next install
  }
}

/**
 * @param {{ current: object|null }} mapRef
 * @param {object} options
 * @param {boolean} options.isMapLoaded
 * @param {object|null} options.simulatorStatus      `GET /api/simulator/status`, or null
 * @param {{ current: object|null }} [options.themeRef]
 * @param {(fn: (theme: object) => void) => (() => void)} [options.subscribeToTheme]
 * @param {string|null} [options.selectedStationId]
 * @param {(chargerId: string|null) => void} [options.onSelectStation]
 * @returns {{ stations: object[] }} every station the report lists, for the legend and card
 */
export function useChargingLayer(
  mapRef,
  { isMapLoaded, simulatorStatus, themeRef, subscribeToTheme, selectedStationId = null, onSelectStation } = {}
) {
  const data = useMemo(() => chargingOverlayData(simulatorStatus), [simulatorStatus]);
  const stations = useMemo(() => stationSummaries(simulatorStatus), [simulatorStatus]);

  // Read by the style.load / click handlers, which outlive any one render. Written in an
  // effect declared before every effect that reads them, so each reader sees this commit's values.
  const dataRef = useRef(data);
  const selectedRef = useRef(selectedStationId);
  const onSelectRef = useRef(onSelectStation);
  const hoveredRef = useRef(null);
  useEffect(() => {
    dataRef.current = data;
    selectedRef.current = selectedStationId;
    onSelectRef.current = onSelectStation;
  });

  // ── Install (once per style load) ─────────────────────────────────────────
  useEffect(() => {
    const map = mapRef?.current;
    if (!map || !isMapLoaded) return undefined;

    const install = () => {
      installChargingLayers(map, { theme: themeRef?.current || null, data: dataRef.current });
      // A reinstalled source has no feature state; the selection is application state, so
      // it is written back rather than lost.
      setStationState(map, selectedRef.current, { selected: true });
    };
    install();

    const onStyleLoad = () => install();
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
      removeChargingLayers(map);
    };
  }, [mapRef, isMapLoaded, themeRef]);

  // ── Data (every report) ───────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef?.current;
    if (!map || !isMapLoaded) return;
    setChargingData(map, data);
  }, [mapRef, isMapLoaded, data]);

  // ── Theme frames ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (typeof subscribeToTheme !== 'function') return undefined;
    return subscribeToTheme((theme) => applyChargingTheme(mapRef?.current, theme));
  }, [subscribeToTheme, mapRef]);

  // ── Selection → feature state ─────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef?.current;
    if (!map || !isMapLoaded || !selectedStationId) return undefined;
    setStationState(map, selectedStationId, { selected: true });
    return () => setStationState(map, selectedStationId, { selected: false });
  }, [mapRef, isMapLoaded, selectedStationId]);

  // ── Click and hover ───────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef?.current;
    if (!map || !isMapLoaded) return undefined;

    // Every click answers: a station, or no station (which clears a station selection).
    const onClick = (event) => onSelectRef.current?.(stationIdAtPoint(map, event.point));

    const onMove = (event) => {
      const id = stationIdAtPoint(map, event.point);
      if (id === hoveredRef.current) return;
      setStationState(map, hoveredRef.current, { hover: false });
      hoveredRef.current = id;
      setStationState(map, id, { hover: true });
      try {
        map.getCanvas().style.cursor = id ? 'pointer' : '';
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
      } catch {
        // ignore
      }
      hoveredRef.current = null;
    };
  }, [mapRef, isMapLoaded]);

  // ── Activity ring ─────────────────────────────────────────────────────────
  const anyCharging = useMemo(() => data.stations.features.some((f) => f.properties?.pulse === true), [data]);
  useEffect(() => {
    const map = mapRef?.current;
    if (!map || !isMapLoaded || !anyCharging) return undefined;

    let timer = null;
    const setRing = (scale, opacity) => {
      try {
        if (!map.getLayer(CHARGING_LAYER.PULSE)) return;
        map.setPaintProperty(CHARGING_LAYER.PULSE, 'circle-radius', ringRadiusExpr(scale));
        map.setPaintProperty(CHARGING_LAYER.PULSE, 'circle-stroke-opacity', opacity);
      } catch {
        // ignore
      }
    };
    // Reduced motion: the ring stays, still — the state is shown, it just does not breathe.
    const still = () => setRing(1.15, 0.5);
    const tick = () => {
      if (!documentVisible()) return;
      const phase = (Date.now() % PULSE_PERIOD_MS) / PULSE_PERIOD_MS;
      setRing(1.05 + 0.35 * phase, 0.6 * (1 - phase));
    };
    const start = () => {
      if (timer !== null) return;
      timer = setInterval(tick, PULSE_STEP_MS);
    };
    const stop = () => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };

    if (prefersReducedMotion()) still();
    else start();
    const unsubscribe = subscribeReducedMotion((reduced) => {
      if (reduced) {
        stop();
        still();
      } else {
        start();
      }
    });

    return () => {
      unsubscribe();
      stop();
      still();
    };
  }, [mapRef, isMapLoaded, anyCharging]);

  return { stations };
}
