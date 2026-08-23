/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CAMPUS SEARCH — a frontend index over things that actually exist
 *
 * §34 asks for a way to find a place without already knowing its coordinates,
 * and explicitly says not to stand up a backend search service for a dataset
 * this small. So: an in-memory index, rebuilt from state, no network.
 *
 * ── What is in the index ──────────────────────────────────────────────────
 *   • every feature of the validated CampusDefinition (buildings, gates,
 *     landmarks, facilities, the campus centre)
 *   • every robot currently on the map, by id
 *
 * ── What is NOT in the index ──────────────────────────────────────────────
 * A list of plausible campus place names. If "Central Library" is not in the
 * campus definition, searching for it returns nothing — which is the correct
 * answer, because this system does not know where the library is. An index
 * that offers a result it cannot locate is worse than an empty one.
 *
 * Pure module: no React, no Mapbox.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { CAMPUS_FEATURE_KIND } from './campusSchema.js';
import { labelAnchorFor } from './campusLayers.js';

export const SEARCH_RESULT_TYPE = Object.freeze({
  CAMPUS_FEATURE: 'CAMPUS_FEATURE',
  ROBOT: 'ROBOT',
});

const KIND_SUBTITLE = Object.freeze({
  CAMPUS_CENTER: 'Campus centre',
  BOUNDARY: 'Boundary',
  BUILDING: 'Building',
  ROAD: 'Road',
  PATH: 'Path',
  GATE: 'Gate',
  LANDMARK: 'Landmark',
  FACILITY: 'Facility',
  OPERATIONAL_POINT: 'Operational point',
});

/**
 * Build the searchable index.
 *
 * @param {object} params
 * @param {object} [params.definition]  validated CampusDefinition
 * @param {object[]} [params.robots]    live robot rows ({ robotId, lat, lon, status })
 * @returns {object[]} entries: { id, name, subtitle, type, lon, lat, haystack }
 */
export function buildCampusSearchIndex({ definition, robots } = {}) {
  const entries = [];

  for (const f of Array.isArray(definition?.features) ? definition.features : []) {
    // A boundary has no single place to fly to that means anything.
    if (f.kind === CAMPUS_FEATURE_KIND.BOUNDARY) continue;
    const anchor = labelAnchorFor(f.geometry);
    if (!anchor) continue;
    entries.push({
      id: f.id,
      name: f.name,
      // A record that surrendered its marker to a co-located neighbour is still
      // a place someone searches for by name, and it still has a coordinate to
      // fly to — the same one. Withholding a duplicate dot must not also
      // withhold the ability to find it (§13).
      subtitle: f.coLocatedWith
        ? `${KIND_SUBTITLE[f.kind] || 'Campus feature'} · shares a location`
        : KIND_SUBTITLE[f.kind] || 'Campus feature',
      type: SEARCH_RESULT_TYPE.CAMPUS_FEATURE,
      lon: anchor[0],
      lat: anchor[1],
      feature: f,
      haystack: `${f.name} ${f.shortName || ''} ${f.kind} ${f.category || ''} ${f.sourceKind || ''}`.toLowerCase(),
    });
  }

  for (const r of Array.isArray(robots) ? robots : []) {
    const id = String(r?.robotId || '').trim();
    if (!id) continue;
    if (typeof r?.lat !== 'number' || typeof r?.lon !== 'number') continue;
    entries.push({
      id: `robot:${id}`,
      robotId: id,
      name: id,
      subtitle: `Robot · ${String(r.status || 'UNKNOWN').toUpperCase()}`,
      type: SEARCH_RESULT_TYPE.ROBOT,
      lon: r.lon,
      lat: r.lat,
      haystack: `${id} robot ${String(r.status || '')}`.toLowerCase(),
    });
  }

  return entries;
}

/**
 * Rank matches for a query.
 *
 * Prefix matches beat substring matches, and campus places beat robots at
 * equal strength — an operator typing "lib" is looking for a place, not for a
 * robot whose id happens to contain those letters.
 */
export function searchCampusIndex(index, query, limit = 8) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];

  const scored = [];
  for (const entry of Array.isArray(index) ? index : []) {
    const name = entry.name.toLowerCase();
    let score = -1;
    if (name.startsWith(q)) score = 0;
    else if (name.includes(q)) score = 1;
    else if (entry.haystack.includes(q)) score = 2;
    if (score < 0) continue;
    if (entry.type === SEARCH_RESULT_TYPE.ROBOT) score += 0.5;
    scored.push({ entry, score });
  }

  scored.sort((a, b) => a.score - b.score || a.entry.name.localeCompare(b.entry.name));
  return scored.slice(0, Math.max(0, limit)).map((s) => s.entry);
}
