/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CHARGING STATION MODEL — what a station IS on the map, from the report alone
 *
 * Pure: no map, no DOM. Two halves:
 *
 *   stationStateOf()        the operational state, derived only from what the
 *                           simulator's report states (`GET /api/simulator/status`):
 *                           usability, approval, problems, plug occupancy, queue,
 *                           and which robots are in the CHARGING stage there.
 *
 *   stationModelFeatures()  the miniature installation drawn at the station's
 *                           coordinate: a pad, docking-bay markings, a charger
 *                           pillar, an awning on two posts and a light strip on the
 *                           awning's edge — fill-extrusion polygons, so the station
 *                           sits IN the 3D scene, is lit by it, casts the scene's
 *                           shadows, and stays anchored while the camera zooms,
 *                           tilts, rotates and pans.
 *
 * ── What the geometry is not ───────────────────────────────────────────────
 * Not a survey. Only the ANCHOR is data — the coordinate the backend states for
 * a station. The footprint is a symbol drawn in metres (a few metres across, so
 * it is legible beside a 2D robot marker at campus zoom), aligned to north
 * because no station reports an orientation. It is centred on the coordinate
 * and never moves it.
 *
 * ── Why fill-extrusion and not a 3D model library ──────────────────────────
 * The map is Mapbox GL v3, whose own extrusion layer is lit by the Standard
 * style's lights, takes part in its shadows and depth, and costs a handful of
 * polygons per station. `three` is in package.json but nothing imports it; a
 * custom WebGL layer for a few boxes would add a render pass and a camera sync
 * for no visual gain at this size.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { CHARGING_STAGE, chargingStageOf } from '../../../lib/robotCharging.js';

export const STATION_STATE = Object.freeze({
  /** Usable, a plug free, nobody queued. */
  AVAILABLE: 'AVAILABLE',
  /** Usable, at least one plug granted — a robot charging or on its way to the plug. */
  OCCUPIED: 'OCCUPIED',
  /** Usable, robots waiting for a plug. */
  QUEUED: 'QUEUED',
  /** Declared but not approved by the owner. Never a charger a robot can use. */
  INACTIVE: 'INACTIVE',
  /** Approved but unusable for a reason the backend states (unreachable, not provisioned…). */
  UNAVAILABLE: 'UNAVAILABLE',
});

/**
 * Colours chosen to stay distinct for the common colour-vision deficiencies when
 * read together with the text and icon that always accompany them — colour is
 * never the only carrier of a state.
 */
export const STATION_STATE_META = Object.freeze({
  AVAILABLE: Object.freeze({ label: 'Available', color: '#10b981', operational: true }),
  OCCUPIED: Object.freeze({ label: 'In use', color: '#3b82f6', operational: true }),
  QUEUED: Object.freeze({ label: 'Queue', color: '#f59e0b', operational: true }),
  INACTIVE: Object.freeze({ label: 'Inactive — not approved', color: '#94a3b8', operational: false }),
  UNAVAILABLE: Object.freeze({ label: 'Unavailable', color: '#ef4444', operational: false }),
});

const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const reasonCodes = (station) =>
  Array.isArray(station?.problems) ? station.problems.map((p) => (p && p.code) || String(p)).filter(Boolean) : [];

/** Robots the report places in the CHARGING stage at this station. */
export function robotsChargingAt(simulatorStatus, chargerId) {
  const robots = Array.isArray(simulatorStatus?.robots) ? simulatorStatus.robots : [];
  return robots.filter(
    (r) => r && r.charging && r.charging.stationId === chargerId && chargingStageOf(r) === CHARGING_STAGE.CHARGING
  ).length;
}

/** A station that can serve robots, at the coordinate the backend states for it. */
export function isUsableStation(station) {
  return station?.usable === true && isNumber(station.lat) && isNumber(station.lon);
}

/**
 * The station's state. Not-usable outranks everything: a declared station that cannot
 * serve robots is never drawn in an operational colour, whatever else the row says.
 */
export function stationStateOf(station) {
  if (!station) return null;
  if (!isUsableStation(station)) {
    const reasons = reasonCodes(station);
    if (station.approved === false || reasons.includes('NOT_APPROVED')) return STATION_STATE.INACTIVE;
    return STATION_STATE.UNAVAILABLE;
  }
  if (isNumber(station.queued) && station.queued > 0) return STATION_STATE.QUEUED;
  if (isNumber(station.active) && station.active > 0) return STATION_STATE.OCCUPIED;
  return STATION_STATE.AVAILABLE;
}

/**
 * One short line an operator reads under the station name. Every number in it is the
 * report's; nothing is computed that the report does not support.
 */
export function stationStatusLine(station, { chargingNow = 0 } = {}) {
  const state = stationStateOf(station);
  if (!state) return '';
  if (state === STATION_STATE.INACTIVE) return 'Inactive — not approved';
  if (state === STATION_STATE.UNAVAILABLE) {
    const reasons = reasonCodes(station);
    return `Unavailable — ${reasons.length ? reasons.join(', ') : 'not usable'}`;
  }
  const plugs = isNumber(station.plugCount) ? station.plugCount : null;
  const active = isNumber(station.active) ? station.active : 0;
  const parts = [plugs !== null ? `${active}/${plugs} plug${plugs === 1 ? '' : 's'} in use` : `${active} in use`];
  if (chargingNow > 0) parts.push(`${chargingNow} charging`);
  if (isNumber(station.queued) && station.queued > 0) parts.push(`${station.queued} queued`);
  return parts.join(' · ');
}

// ── The miniature installation ───────────────────────────────────────────────

/** Metres → degrees at a latitude. Accurate to well under a centimetre over a few metres. */
const METRES_PER_DEG_LAT = 111_320;
function offset([lng, lat], east, north) {
  const metresPerDegLng = METRES_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
  return [lng + east / metresPerDegLng, lat + north / METRES_PER_DEG_LAT];
}

/** Axis-aligned rectangle (local metres), as a closed ring. Counter-clockwise. */
function rectRing(x0, y0, x1, y1) {
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
    [x0, y0],
  ];
}

/** Rectangle with rounded corners (quarter circles of `r`, `segments` steps each). */
function roundedRectRing(x0, y0, x1, y1, r, segments = 4) {
  const ring = [];
  const corners = [
    [x1 - r, y0 + r, -90],
    [x1 - r, y1 - r, 0],
    [x0 + r, y1 - r, 90],
    [x0 + r, y0 + r, 180],
  ];
  for (const [cx, cy, start] of corners) {
    for (let i = 0; i <= segments; i += 1) {
      const a = ((start + (90 * i) / segments) * Math.PI) / 180;
      ring.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  }
  ring.push(ring[0]);
  return ring;
}

/**
 * The parts, in local metres (x east, y north, centred on the station coordinate).
 * `base`/`height` are metres above ground. `role` decides the colour:
 *   structure  neutral, the same for every state
 *   state      the state's colour (bay markings)
 *   light      the state's colour, self-lit (the awning's light strip)
 */
export const STATION_PARTS = Object.freeze([
  Object.freeze({ part: 'pad', role: 'structure', base: 0, height: 0.28, rings: [roundedRectRing(-3.0, -2.1, 3.0, 2.1, 0.5)] }),
  // Docking-bay markings: a frame, so the pad still reads as a surface a robot parks ON.
  Object.freeze({
    part: 'bay',
    role: 'state',
    base: 0.28,
    height: 0.32,
    rings: [rectRing(-2.2, -1.8, 2.2, 0.9), rectRing(-1.95, -1.55, 1.95, 0.65).reverse()],
  }),
  Object.freeze({ part: 'pillar', role: 'unit', base: 0.28, height: 1.85, rings: [rectRing(-0.45, 1.15, 0.45, 1.75)] }),
  Object.freeze({ part: 'post-west', role: 'unit', base: 0.28, height: 2.6, rings: [rectRing(-2.45, 1.7, -2.2, 1.95)] }),
  Object.freeze({ part: 'post-east', role: 'unit', base: 0.28, height: 2.6, rings: [rectRing(2.2, 1.7, 2.45, 1.95)] }),
  // An awning over the charger only: from straight above, the bay and the robot on it stay visible.
  Object.freeze({ part: 'awning', role: 'structure', base: 2.6, height: 2.78, rings: [rectRing(-2.6, 0.55, 2.6, 2.05)] }),
  Object.freeze({ part: 'light', role: 'light', base: 2.58, height: 2.8, rings: [rectRing(-2.6, 0.35, 2.6, 0.55)] }),
]);

/** Every station drawable at a coordinate: usable ones at `lat/lon`, declared-only at `declaredLat/Lon`. */
export function placedStations(simulatorStatus) {
  const stations =
    simulatorStatus && simulatorStatus.charging && Array.isArray(simulatorStatus.charging.stations)
      ? simulatorStatus.charging.stations.filter(Boolean)
      : [];
  const out = [];
  for (const s of stations) {
    if (isUsableStation(s)) out.push({ station: s, lngLat: [s.lon, s.lat] });
    else if (isNumber(s.declaredLat) && isNumber(s.declaredLon)) out.push({ station: s, lngLat: [s.declaredLon, s.declaredLat] });
  }
  return out;
}

/**
 * The extruded parts of every placed station, as GeoJSON polygons with
 * `{ chargerId, part, role, state, base, height }`.
 */
export function stationModelFeatures(simulatorStatus) {
  const features = [];
  for (const { station, lngLat } of placedStations(simulatorStatus)) {
    const state = stationStateOf(station);
    for (const spec of STATION_PARTS) {
      features.push({
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: spec.rings.map((ring) => ring.map(([x, y]) => offset(lngLat, x, y))),
        },
        properties: {
          chargerId: station.chargerId,
          part: spec.part,
          role: spec.role,
          state,
          base: spec.base,
          height: spec.height,
        },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}

/**
 * Every station the report lists, for the legend and the details card — including the ones
 * that cannot be placed (`lngLat: null`), so an operator can see a station exists but has no
 * coordinate rather than not see it at all.
 */
export function stationSummaries(simulatorStatus) {
  const stations =
    simulatorStatus && simulatorStatus.charging && Array.isArray(simulatorStatus.charging.stations)
      ? simulatorStatus.charging.stations.filter(Boolean)
      : [];
  const placed = new Map(placedStations(simulatorStatus).map(({ station, lngLat }) => [station.chargerId, lngLat]));
  return stations.map((s) => {
    const chargingNow = robotsChargingAt(simulatorStatus, s.chargerId);
    const usable = isUsableStation(s);
    return {
      chargerId: s.chargerId,
      name: s.name || s.chargerId,
      state: stationStateOf(s),
      status: stationStatusLine(s, { chargingNow }),
      lngLat: placed.get(s.chargerId) || null,
      // The declared position of a station that cannot serve robots is shown, never used.
      positionKind: usable ? 'OPERATIONAL' : placed.has(s.chargerId) ? 'DECLARED_ONLY' : 'NONE',
      isDepot: s.isDepot === true,
      approved: typeof s.approved === 'boolean' ? s.approved : null,
      plugCount: usable && isNumber(s.plugCount) ? s.plugCount : null,
      active: usable && isNumber(s.active) ? s.active : null,
      queued: usable && isNumber(s.queued) ? s.queued : null,
      chargingNow,
      reasons: reasonCodes(s),
    };
  });
}
