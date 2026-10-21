/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CO-LOCATED ROBOTS — keep every robot visible when several share one spot
 *
 * A simulated robot parks exactly at its last drop point, so two robots that
 * finished deliveries to the same location stand on the same coordinate to the
 * last decimal (production, 2026-10-21: SIM-21AF… and SIM-7B7F… both at
 * "RNSIT Food Court"). Each robot is a DOM marker at its own coordinate, so the
 * second marker covered the first exactly: the fleet count said three, the map
 * showed two.
 *
 * This module decides the screen-space spread for such groups. It never moves a
 * robot: the coordinate, the robot state, selection and the follow camera all
 * keep the true position. The renderer applies the result as a pixel offset on
 * the marker (`marker.setOffset`), which shifts only the drawn icon.
 *
 * Pure: no DOM, no map, so it runs under plain Node.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { groundDistanceM, validLngLat } from './robotMotion.js';

export const COLOCATION = Object.freeze({
  /** Robots closer than this stand on one spot as far as the map can show. */
  RADIUS_M: 2,
  /** Ring radius, in pixels, for a group of two: clear of a marker's width at campus zoom. */
  RING_PX: 20,
  /** Extra ring radius per member beyond two, so a larger group stays apart. */
  RING_PX_PER_MEMBER: 6,
});

/**
 * Groups of robots that share a spot: single-linkage within `radiusM`. Only groups of two or more
 * are returned, each sorted by id, so the result does not depend on the order of `entries`.
 *
 * @param {Array<{ id: string, lngLat: [number, number] }>} entries
 * @param {number} [radiusM]
 * @returns {string[][]}
 */
export function colocationGroups(entries, radiusM = COLOCATION.RADIUS_M) {
  const valid = (Array.isArray(entries) ? entries : [])
    .filter((e) => e && e.id != null && validLngLat(e.lngLat))
    .map((e) => ({ id: String(e.id), lngLat: e.lngLat }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const parent = valid.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < valid.length; i += 1) {
    for (let j = i + 1; j < valid.length; j += 1) {
      if (groundDistanceM(valid[i].lngLat, valid[j].lngLat) <= radiusM) parent[find(j)] = find(i);
    }
  }

  const byRoot = new Map();
  valid.forEach((e, i) => {
    const root = find(i);
    byRoot.set(root, [...(byRoot.get(root) || []), e.id]);
  });
  return [...byRoot.values()].filter((ids) => ids.length > 1);
}

/**
 * Pixel offsets that place `count` markers on a ring around their shared point. A group of two
 * sits left and right (labels sit below a marker, so a vertical split would stack the labels).
 *
 * @param {number} count
 * @param {{ ringPx?: number, perMemberPx?: number }} [options]
 * @returns {Array<[number, number]>}
 */
export function ringOffsets(count, { ringPx = COLOCATION.RING_PX, perMemberPx = COLOCATION.RING_PX_PER_MEMBER } = {}) {
  if (!Number.isInteger(count) || count < 2) return [[0, 0]];
  const radius = ringPx + (count - 2) * perMemberPx;
  const round = (v) => Math.round(v * 10) / 10 || 0;
  return Array.from({ length: count }, (_, k) => {
    const angle = Math.PI + (2 * Math.PI * k) / count; // start on the left, go clockwise on screen
    return [round(radius * Math.cos(angle)), round(radius * Math.sin(angle))];
  });
}

/**
 * The offset and group size for every robot: `[0, 0]` and 1 for a robot that stands alone.
 *
 * @param {Array<{ id: string, lngLat: [number, number] }>} entries
 * @param {{ radiusM?: number, ringPx?: number, perMemberPx?: number }} [options]
 * @returns {Map<string, { offset: [number, number], groupSize: number }>}
 */
export function colocationLayout(entries, options = {}) {
  const layout = new Map();
  for (const e of Array.isArray(entries) ? entries : []) {
    if (e && e.id != null) layout.set(String(e.id), { offset: [0, 0], groupSize: 1 });
  }
  for (const ids of colocationGroups(entries, options.radiusM)) {
    const offsets = ringOffsets(ids.length, options);
    ids.forEach((id, k) => layout.set(id, { offset: offsets[k], groupSize: ids.length }));
  }
  return layout;
}
