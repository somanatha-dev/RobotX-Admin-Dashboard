/**
 * The DTARO decision overlay (`decisionLayers.js`): installed once per style load, idempotently,
 * removed on unmount; data pushed only when it changed. Robot rings follow the fleet's positions
 * at most once a second, and only while a decision is drawn.
 */

import { useEffect, useMemo, useRef } from 'react';

import {
  DECISION_SOURCE,
  drawableDecisions,
  installDecisionLayers,
  obstacleCollection,
  removeDecisionLayers,
  robotCollection,
  routeCollection,
  setDecisionData,
} from './decisionLayers.js';

const RING_REFRESH_MS = 1000;

/**
 * @param {{ current: object|null }} mapRef
 * @param {object} options
 * @param {boolean} options.isMapLoaded
 * @param {boolean} options.enabled    false: nothing is installed (feature off on the server)
 * @param {object[]} options.decisions decisions in scope for the selected campus
 * @param {object[]} options.robots    the fleet (live positions for the rings)
 * @param {number} options.nowMs       the page clock (expiry)
 */
export function useDtaroDecisionLayer(mapRef, { isMapLoaded, enabled, decisions, robots, nowMs } = {}) {
  // The caller's page clock (MapControl ticks it); without one nothing is treated as expired.
  const clock = Number.isFinite(nowMs) ? nowMs : 0;
  const drawn = useMemo(() => drawableDecisions(decisions, clock), [decisions, clock]);
  const routes = useMemo(() => routeCollection(drawn), [drawn]);
  const obstacles = useMemo(() => obstacleCollection(drawn, clock), [drawn, clock]);

  const latest = useRef({});
  const robotsRef = useRef(robots);
  useEffect(() => {
    robotsRef.current = robots;
    latest.current = { [DECISION_SOURCE.ROUTES]: routes, [DECISION_SOURCE.OBSTACLES]: obstacles };
  });

  useEffect(() => {
    const map = mapRef?.current;
    if (!map || !isMapLoaded || !enabled) return undefined;
    const install = () => installDecisionLayers(map, latest.current);
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
      removeDecisionLayers(map);
    };
  }, [mapRef, isMapLoaded, enabled]);

  const pushed = useRef({});
  useEffect(() => {
    const map = mapRef?.current;
    if (!map || !isMapLoaded || !enabled) return;
    const changed = {};
    for (const [id, collection] of [[DECISION_SOURCE.ROUTES, routes], [DECISION_SOURCE.OBSTACLES, obstacles]]) {
      const key = JSON.stringify(collection);
      if (pushed.current[id] !== key) {
        pushed.current[id] = key;
        changed[id] = collection;
      }
    }
    if (Object.keys(changed).length) setDecisionData(map, changed);
  }, [mapRef, isMapLoaded, enabled, routes, obstacles]);

  useEffect(() => {
    const map = mapRef?.current;
    if (!map || !isMapLoaded || !enabled) return undefined;
    let lastKey = null;
    const push = () => {
      const positions = new Map();
      for (const r of robotsRef.current || []) {
        if (r?.robotId && Number.isFinite(r.lat) && Number.isFinite(r.lon)) positions.set(String(r.robotId), { lat: r.lat, lon: r.lon });
      }
      const data = robotCollection(drawn, positions);
      const key = JSON.stringify(data);
      if (key === lastKey) return;
      lastKey = key;
      setDecisionData(map, { [DECISION_SOURCE.ROBOTS]: data });
    };
    push();
    if (drawn.length === 0) return undefined;
    const timer = setInterval(push, RING_REFRESH_MS);
    return () => clearInterval(timer);
  }, [mapRef, isMapLoaded, enabled, drawn]);
}
