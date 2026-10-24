/**
 * DTARO DECISION LAYERS — what an obstacle decision did, on the map. No React here, so the
 * collections and the install are tested against the fake Mapbox map like `dtaroLayers.js`.
 *
 *   original route        the remaining COMMANDED route of each affected robot: subdued, dashed.
 *                         It is never replaced — the engine's route is unchanged.
 *   alternate route       the SIMULATION-ONLY detour a robot was sent (REROUTE): solid.
 *   robot rings           every robot the server considered, at its live position, coloured by
 *                         what happened to it (stopped, rerouting, moving, done, no safe route,
 *                         affected-awaiting, unaffected).
 *   obstacle ring + label the decision's state at the obstacle: awaiting, stop, reroute,
 *                         broadcast rejected, expired. Drawn even when no ALERT_CREATED exists
 *                         (a rejected broadcast sends none).
 *
 * Every geometry is the server's (`obstacleDecisionStore`); robot positions are the fleet's own
 * telemetry. Robots themselves are DOM markers and draw above all of it.
 */

export const DECISION_SOURCE = Object.freeze({
  ROUTES: 'robotx-dtaro-decision-routes',
  ROBOTS: 'robotx-dtaro-decision-robots',
  OBSTACLES: 'robotx-dtaro-decision-obstacles',
});

export const DECISION_LAYER = Object.freeze({
  ORIGINAL: 'robotx-dtaro-decision-original',
  ALTERNATE_CASING: 'robotx-dtaro-decision-alternate-casing',
  ALTERNATE: 'robotx-dtaro-decision-alternate',
  ROBOT_RING: 'robotx-dtaro-decision-robot-ring',
  OBSTACLE_RING: 'robotx-dtaro-decision-obstacle-ring',
  OBSTACLE_LABEL: 'robotx-dtaro-decision-obstacle-label',
});

export const DECISION_LAYER_ORDER = Object.freeze([
  DECISION_LAYER.ORIGINAL,
  DECISION_LAYER.ALTERNATE_CASING,
  DECISION_LAYER.ALTERNATE,
  DECISION_LAYER.ROBOT_RING,
  DECISION_LAYER.OBSTACLE_RING,
  DECISION_LAYER.OBSTACLE_LABEL,
]);

/** Robot ring colours by what happened to the robot. */
export const RING_COLOR = Object.freeze({
  AFFECTED: '#f59e0b',
  STOPPED: '#dc2626',
  NO_SAFE_ROUTE: '#7f1d1d',
  REROUTING: '#0284c7',
  MOVING: '#0ea5e9',
  COMPLETED: '#16a34a',
  UNAFFECTED: '#94a3b8',
});
export const ALTERNATE_COLOR = '#0ea5e9';
export const ORIGINAL_COLOR = '#64748b';
export const OBSTACLE_STATE_COLOR = Object.freeze({
  AWAITING: '#f59e0b',
  STOP: '#dc2626',
  REROUTE: '#0284c7',
  REJECTED: '#475569',
  EXPIRED: '#9ca3af',
});

const EMPTY = Object.freeze({ type: 'FeatureCollection', features: Object.freeze([]) });
const safe = (fn, fallback) => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};
const isPoint = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon);
const coords = (points) => (Array.isArray(points) ? points.filter(isPoint).map((p) => [p.lon, p.lat]) : []);

/** Decisions still worth drawing: not abandoned, and their obstacle not long expired. */
export function drawableDecisions(decisions, nowMs = Date.now()) {
  return (decisions || []).filter((d) => {
    if (!d || d.status === 'ABANDONED_ON_RESTART' || !d.obstacle) return false;
    const expires = Date.parse(d.obstacle.expiresAt);
    return !Number.isFinite(expires) || expires > nowMs - 60_000;
  });
}

/** The ring state of one robot in one decision. */
export function ringStateOf(robot) {
  const e = robot?.execution;
  if (e) {
    if (e.state === 'COMPLETED') return 'COMPLETED';
    if (e.state === 'MOVING') return 'MOVING';
    if (e.state === 'REROUTING') return 'REROUTING';
    if (e.state === 'STOPPED_NO_SAFE_ROUTE' || e.state === 'NO_SAFE_ROUTE') return 'NO_SAFE_ROUTE';
    if (e.state === 'STOPPED' || e.state === 'STOP_SENT' || e.state === 'REFUSED_STOPPED') return 'STOPPED';
  }
  return robot?.affected ? 'AFFECTED' : 'UNAFFECTED';
}

/** The original (dashed) and alternate (solid) routes of every drawable decision. */
export function routeCollection(decisions) {
  const features = [];
  for (const d of decisions || []) {
    for (const robot of d.robots || []) {
      if (!robot.affected) continue;
      const original = robot.execution?.originalPath || robot.originalRoute;
      const line = coords(original);
      if (line.length >= 2) {
        features.push({ type: 'Feature', properties: { decisionId: d.decisionId, robotId: robot.robotId, kind: 'ORIGINAL' }, geometry: { type: 'LineString', coordinates: line } });
      }
      // A superseded detour is no longer driven: a later decision's path replaces it on the map.
      const alternate = robot.execution?.state === 'SUPERSEDED' ? [] : coords(robot.execution?.alternatePath);
      if (alternate.length >= 2) {
        features.push({ type: 'Feature', properties: { decisionId: d.decisionId, robotId: robot.robotId, kind: 'ALTERNATE', state: robot.execution.state }, geometry: { type: 'LineString', coordinates: alternate } });
      }
    }
  }
  return features.length ? { type: 'FeatureCollection', features } : EMPTY;
}

/**
 * Rings at each considered robot's live position (the fleet's telemetry), newest decision first
 * so a robot in two decisions shows the latest one. Other-region robots are not drawn.
 *
 * @param {object[]} decisions
 * @param {Map<string, {lat:number, lon:number}>} positions
 */
export function robotCollection(decisions, positions) {
  const features = [];
  const seen = new Set();
  (decisions || []).forEach((d, index) => {
    for (const robot of d.robots || []) {
      if (seen.has(robot.robotId) || robot.role === 'OTHER_REGION') continue;
      // Unaffected robots are ringed for the newest decision only: one grey ring per robot per
      // past decision would bury the rings that matter.
      if (index > 0 && !robot.affected && !robot.execution) continue;
      const p = positions.get(robot.robotId) || robot.position;
      if (!isPoint(p)) continue;
      seen.add(robot.robotId);
      features.push({
        type: 'Feature',
        properties: { decisionId: d.decisionId, robotId: robot.robotId, state: ringStateOf(robot), reporter: robot.role === 'REPORTER' },
        geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
      });
    }
  });
  return features.length ? { type: 'FeatureCollection', features } : EMPTY;
}

/** The decision's state at its obstacle. */
export function obstacleStateOf(decision, nowMs = Date.now()) {
  const expires = Date.parse(decision?.obstacle?.expiresAt);
  if (decision?.status === 'EXPIRED' || (Number.isFinite(expires) && expires <= nowMs)) return 'EXPIRED';
  const choice = decision?.decision?.choice;
  if (!choice) return 'AWAITING';
  if (choice === 'REJECT_BROADCAST') return 'REJECTED';
  return choice;
}

const LABEL = Object.freeze({
  AWAITING: 'Awaiting decision',
  STOP: 'Stop',
  REROUTE: 'Reroute',
  REJECTED: 'Broadcast rejected',
  EXPIRED: 'Expired — not confirmed clear',
});

export function obstacleCollection(decisions, nowMs = Date.now()) {
  const features = [];
  for (const d of decisions || []) {
    if (!isPoint(d.obstacle)) continue;
    const state = obstacleStateOf(d, nowMs);
    const automatic = d.decision?.source === 'DEFAULT_TIMEOUT';
    features.push({
      type: 'Feature',
      id: d.decisionId,
      properties: { decisionId: d.decisionId, state, label: `SIMULATED · ${LABEL[state]}${automatic && state !== 'EXPIRED' ? ' (default)' : ''}` },
      geometry: { type: 'Point', coordinates: [d.obstacle.lon, d.obstacle.lat] },
    });
  }
  return features.length ? { type: 'FeatureCollection', features } : EMPTY;
}

const match = (prop, table, fallback) => ['match', ['get', prop], ...Object.entries(table).flat(), fallback];

export function decisionLayerSpecs() {
  return [
    {
      id: DECISION_LAYER.ORIGINAL,
      type: 'line',
      source: DECISION_SOURCE.ROUTES,
      filter: ['==', ['get', 'kind'], 'ORIGINAL'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ORIGINAL_COLOR, 'line-width': 3, 'line-opacity': 0.75, 'line-dasharray': [1.5, 2], 'line-emissive-strength': 1 },
    },
    {
      id: DECISION_LAYER.ALTERNATE_CASING,
      type: 'line',
      source: DECISION_SOURCE.ROUTES,
      filter: ['==', ['get', 'kind'], 'ALTERNATE'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': 7, 'line-opacity': 0.9, 'line-emissive-strength': 1 },
    },
    {
      id: DECISION_LAYER.ALTERNATE,
      type: 'line',
      source: DECISION_SOURCE.ROUTES,
      filter: ['==', ['get', 'kind'], 'ALTERNATE'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ALTERNATE_COLOR, 'line-width': 4, 'line-opacity': ['case', ['==', ['get', 'state'], 'COMPLETED'], 0.55, 1], 'line-emissive-strength': 1 },
    },
    {
      id: DECISION_LAYER.ROBOT_RING,
      type: 'circle',
      source: DECISION_SOURCE.ROBOTS,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 13, 18, 21],
        'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-width': ['case', ['==', ['get', 'state'], 'UNAFFECTED'], 1.5, 3.5],
        'circle-stroke-color': match('state', RING_COLOR, RING_COLOR.UNAFFECTED),
        'circle-stroke-opacity': 0.95,
        'circle-pitch-alignment': 'map',
        'circle-emissive-strength': 1,
      },
    },
    {
      id: DECISION_LAYER.OBSTACLE_RING,
      type: 'circle',
      source: DECISION_SOURCE.OBSTACLES,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 14, 18, 22],
        'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-width': 3,
        'circle-stroke-color': match('state', OBSTACLE_STATE_COLOR, OBSTACLE_STATE_COLOR.EXPIRED),
        'circle-stroke-opacity': ['case', ['==', ['get', 'state'], 'EXPIRED'], 0.5, 0.95],
        'circle-pitch-alignment': 'map',
        'circle-emissive-strength': 1,
      },
    },
    {
      id: DECISION_LAYER.OBSTACLE_LABEL,
      type: 'symbol',
      source: DECISION_SOURCE.OBSTACLES,
      layout: {
        'text-field': ['get', 'label'],
        'text-size': 12,
        'text-anchor': 'top',
        'text-offset': [0, 1.6],
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: { 'text-color': '#111827', 'text-halo-color': '#ffffff', 'text-halo-width': 1.6, 'text-emissive-strength': 1 },
    },
  ];
}

/** Install whatever is missing. Idempotent, like `installDtaroLayers`. */
export function installDecisionLayers(map, data = null) {
  if (!map) return { installed: 0, missing: [...DECISION_LAYER_ORDER] };
  for (const id of Object.values(DECISION_SOURCE)) {
    if (safe(() => map.getSource(id), null)) continue;
    safe(() => map.addSource(id, { type: 'geojson', data: data?.[id] || EMPTY }));
  }
  let installed = 0;
  const missing = [];
  for (const spec of decisionLayerSpecs()) {
    if (!safe(() => map.getLayer(spec.id), null)) safe(() => map.addLayer(spec));
    if (safe(() => map.getLayer(spec.id), null)) installed += 1;
    else missing.push(spec.id);
  }
  return { installed, missing };
}

export function setDecisionData(map, data) {
  if (!map || !data) return;
  for (const [id, collection] of Object.entries(data)) {
    const source = safe(() => map.getSource(id), null);
    if (source && typeof source.setData === 'function' && collection) safe(() => source.setData(collection));
  }
}

export function removeDecisionLayers(map) {
  if (!map) return;
  for (const id of [...DECISION_LAYER_ORDER].reverse()) if (safe(() => map.getLayer(id), null)) safe(() => map.removeLayer(id));
  for (const id of Object.values(DECISION_SOURCE)) if (safe(() => map.getSource(id), null)) safe(() => map.removeSource(id));
}
