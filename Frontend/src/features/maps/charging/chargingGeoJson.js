/**
 * The charging overlay's geometry, built only from the simulator's own report
 * (`GET /api/simulator/status` → `charging.stations`, `robots[].charging.route`).
 *
 * Rules (charging audit U-7, Phase B; station markers 2026-10-13):
 *   · a station that can serve robots (`usable`) is placed at the coordinate the backend states
 *     for it (`lat`/`lon`), with its capacity and occupancy;
 *   · a station the owner DECLARED but that cannot serve robots (not approved, not reachable, …)
 *     is placed at its declared coordinate (`declaredLat`/`declaredLon`) as INACTIVE, with its
 *     reasons — never styled or labelled as a charger a robot can use;
 *   · a station with no well-formed coordinate is never drawn at a guessed place (it is listed by
 *     `unplacedStations`);
 *   · a charger route is the robot's own remaining route to its station, exactly as reported;
 *   · no snapping, smoothing or straight-line substitute.
 *
 * Pure: no map, no DOM.
 */

import { STATION_STATE, robotsChargingAt, stationStateOf, stationStatusLine } from './stationModel.js';

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const stationsOf = (simulatorStatus) =>
  simulatorStatus && simulatorStatus.charging && Array.isArray(simulatorStatus.charging.stations)
    ? simulatorStatus.charging.stations.filter(Boolean)
    : [];
const isActive = (s) => s.usable === true && isNumber(s.lat) && isNumber(s.lon);
const isDeclaredOnly = (s) => !isActive(s) && isNumber(s.declaredLat) && isNumber(s.declaredLon);
const reasonsOf = (s) => (Array.isArray(s.problems) ? s.problems.map((p) => (p && p.code) || String(p)) : []);

/**
 * The display fields every placed station carries, from `stationModel.js`: its state, the
 * status line under its name, how many robots the report shows CHARGING there, and whether
 * that is so (`pulse` — the only thing the map animates for a station).
 */
const displayOf = (simulatorStatus, s) => {
  const chargingNow = robotsChargingAt(simulatorStatus, s.chargerId);
  const state = stationStateOf(s);
  return {
    state,
    status: stationStatusLine(s, { chargingNow }),
    chargingNow,
    pulse: chargingNow > 0 && (state === STATION_STATE.OCCUPIED || state === STATION_STATE.QUEUED),
    isDepot: s.isDepot === true,
  };
};

/**
 * Stations as GeoJSON points: usable ones with capacity and occupancy, and declared-but-unusable
 * ones as `inactive` with their reasons.
 */
export function stationFeatures(simulatorStatus) {
  const stations = stationsOf(simulatorStatus);
  const active = stations.filter(isActive).map((s) => ({
    type: 'Feature',
    id: s.chargerId,
    geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
    properties: {
      chargerId: s.chargerId,
      name: s.name || s.chargerId,
      inactive: false,
      plugCount: isNumber(s.plugCount) ? s.plugCount : null,
      active: isNumber(s.active) ? s.active : 0,
      queued: isNumber(s.queued) ? s.queued : 0,
      label: `${s.name || s.chargerId}\n${isNumber(s.active) ? s.active : 0}/${isNumber(s.plugCount) ? s.plugCount : '?'} in use${s.queued ? ` · ${s.queued} queued` : ''}`,
      full: isNumber(s.plugCount) && isNumber(s.active) && s.active >= s.plugCount,
      ...displayOf(simulatorStatus, s),
    },
  }));
  const inactive = stations.filter(isDeclaredOnly).map((s) => {
    const reasons = reasonsOf(s);
    return {
      type: 'Feature',
      id: s.chargerId,
      geometry: { type: 'Point', coordinates: [s.declaredLon, s.declaredLat] },
      properties: {
        chargerId: s.chargerId,
        name: s.name || s.chargerId,
        inactive: true,
        reasons,
        plugCount: null,
        active: 0,
        queued: 0,
        label: `${s.name || s.chargerId}\nINACTIVE — ${reasons.length > 0 ? reasons.join(', ') : 'not usable'}`,
        full: false,
        ...displayOf(simulatorStatus, s),
      },
    };
  });
  return { type: 'FeatureCollection', features: [...active, ...inactive] };
}

/** Stations the backend lists that cannot be placed at all (no well-formed coordinate), for a legend. */
export function unplacedStations(simulatorStatus) {
  return stationsOf(simulatorStatus)
    .filter((s) => !isActive(s) && !isDeclaredOnly(s))
    .map((s) => ({ chargerId: s.chargerId, name: s.name || s.chargerId, reasons: reasonsOf(s) }));
}

/** Each simulated robot's remaining route to its charger, as GeoJSON lines. */
export function chargerRouteFeatures(simulatorStatus) {
  const robots = simulatorStatus && Array.isArray(simulatorStatus.robots) ? simulatorStatus.robots : [];
  return {
    type: 'FeatureCollection',
    features: robots
      .filter((r) => r && r.charging && Array.isArray(r.charging.route) && r.charging.route.length >= 2)
      .filter((r) => r.charging.route.every((p) => p && isNumber(p.lat) && isNumber(p.lon)))
      .map((r) => ({
        type: 'Feature',
        id: r.robotId,
        geometry: { type: 'LineString', coordinates: r.charging.route.map((p) => [p.lon, p.lat]) },
        properties: { robotId: r.robotId, stationId: r.charging.stationId || null },
      })),
  };
}
