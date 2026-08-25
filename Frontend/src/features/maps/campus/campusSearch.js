/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CAMPUS SEARCH — a frontend index over things that actually exist
 *
 * §34 asks for a way to find a place without already knowing its coordinates,
 * and explicitly says not to stand up a backend search service for a dataset
 * this small. So: an in-memory index, rebuilt from state, no network.
 *
 * ── What is in the index ──────────────────────────────────────────────────
 *   • every REGISTERED CAMPUS, by name, code and alias — metadata only, so
 *     this half stays the same size whether the build holds two campuses or
 *     a hundred
 *   • every feature of the validated CampusDefinition (buildings, gates,
 *     landmarks, facilities, the campus centre)
 *   • every robot currently on the map, by id
 *
 * Three kinds of thing, ONE index and ONE ranking function (§3I). None of the
 * three is special-cased by name anywhere below: a campus is found through the
 * aliases its registry entry lists, exactly as a building is found through the
 * name its dataset gives it.
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

import { CAMPUS_FEATURE_KIND, OPERATIONAL_ROLE, isOperationalRole } from './campusSchema.js';
import { labelAnchorFor } from './campusLayers.js';

export const SEARCH_RESULT_TYPE = Object.freeze({
  /** A CAMPUS — somewhere to go, whether or not it is the one on screen. */
  CAMPUS: 'CAMPUS',
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

/** How an operational role reads in a search result. */
const ROLE_SUBTITLE = Object.freeze({
  GATE: 'Gate · campus entrance',
  DOCKING_STATION: 'Docking station',
  CHARGING_POINT: 'Charging point',
  PICKUP_DROP_POINT: 'Pickup / drop point',
  PARKING: 'Parking',
  FOOD_SERVICE: 'Food service',
  DEPARTMENT: 'Department',
  SERVICE_POINT: 'Service point',
});

function campusSubtitle(f) {
  const base =
    isOperationalRole(f.operationalRole) && ROLE_SUBTITLE[f.operationalRole]
      ? ROLE_SUBTITLE[f.operationalRole]
      : KIND_SUBTITLE[f.kind] || 'Campus feature';
  // A record that surrendered its marker to a co-located neighbour is still a
  // place someone searches for by name, and it still has a coordinate to fly to
  // — the same one. Withholding a duplicate dot must not also withhold the
  // ability to find it (§13).
  return f.coLocatedWith ? `${base} · shares a location` : base;
}

/**
 * The CAMPUS half of the index.
 *
 * Separate from the robot half for one reason and it is a performance one
 * (§3T): the campus is static and the fleet is not. Building both together
 * meant every telemetry tick rebuilt all 65 campus entries — 65 label-anchor
 * derivations and 65 lowercased haystacks — to change one robot's status
 * string. The two halves are now memoised against what each actually depends
 * on and concatenated.
 */
export function buildCampusFeatureIndex(definition) {
  const entries = [];
  for (const f of Array.isArray(definition?.features) ? definition.features : []) {
    // A boundary has no single place to fly to that means anything.
    if (f.kind === CAMPUS_FEATURE_KIND.BOUNDARY) continue;
    const anchor = labelAnchorFor(f.geometry);
    if (!anchor) continue;
    entries.push({
      id: f.id,
      name: f.name,
      subtitle: campusSubtitle(f),
      type: SEARCH_RESULT_TYPE.CAMPUS_FEATURE,
      lon: anchor[0],
      lat: anchor[1],
      feature: f,
      /** Lower is more operationally important — see `OPERATIONAL_PRIORITY`. */
      rank: Number(f.operationalPriority) || 9,
      haystack: `${f.name} ${f.shortName || ''} ${f.kind} ${f.category || ''} ${f.sourceKind || ''} ${
        f.operationalRole && f.operationalRole !== OPERATIONAL_ROLE.NONE ? f.operationalRole : ''
      }`
        .toLowerCase()
        .replace(/_/g, ' '),
    });
  }
  return entries;
}

/**
 * The CAMPUS half of the index — the campuses themselves.
 *
 * ── Why this exists, and why it is not a fourth search box ────────────────
 * §3I says ONE search system. Before there was a second campus, finding a place
 * meant finding something INSIDE the campus already on screen, so the index held
 * features and units and nothing else. With more than one campus, "JSSATE" is a
 * thing an operator types and expects to be taken to — and the wrong way to
 * serve that is a separate control with its own matching rules that drift from
 * this one's. So a campus is simply a third kind of entry in the same index,
 * ranked by the same function.
 *
 * ── Why it costs nothing at 100 campuses ─────────────────────────────────
 * It reads METADATA — a name, a few aliases, a city — and the DB record's
 * centre. It never touches a campus's features, so building this index for a
 * hundred campuses neither loads nor classifies a hundred datasets, and
 * selecting a campus is still what causes its geometry to reach the map (§30).
 *
 * ── Aliases are data ─────────────────────────────────────────────────────
 * "JSSATE", "JSSATE Bengaluru" and "JSS Academy of Technical Education" all
 * reach the same campus because the registry ENTRY lists them, matched by the
 * generic haystack below. There is no condition here on any campus's id, and
 * adding campus #100's abbreviations is adding strings to its entry.
 *
 * @param {object[]} campusRecords  DB Campus rows: { id, code, name, centerLat, centerLon }
 * @param {(code: string) => ({ aliases?: string[], city?: string, state?: string, country?: string }|null)} metadataFor
 */
export function buildCampusRegistryIndex(campusRecords, metadataFor) {
  const entries = [];
  for (const c of Array.isArray(campusRecords) ? campusRecords : []) {
    const code = String(c?.code || '').trim();
    const name = String(c?.name || '').trim();
    if (!code || !name) continue;
    if (typeof c?.centerLat !== 'number' || typeof c?.centerLon !== 'number') continue;

    const meta = (typeof metadataFor === 'function' ? metadataFor(code) : null) || {};
    const place = [meta.city, meta.state, meta.country].filter(Boolean).join(', ');
    const aliases = Array.isArray(meta.aliases) ? meta.aliases : [];

    entries.push({
      id: `campus:${code}`,
      campusCode: code,
      campusId: c.id ?? null,
      name,
      subtitle: place ? `Campus · ${place}` : 'Campus',
      type: SEARCH_RESULT_TYPE.CAMPUS,
      lon: c.centerLon,
      lat: c.centerLat,
      /** Above every feature and unit: a campus is the widest thing you can ask for. */
      rank: 0,
      haystack: `${name} ${code} ${aliases.join(' ')} ${place} campus`
        .toLowerCase()
        .replace(/_/g, ' '),
    });
  }
  return entries;
}

/** The FLEET half of the index. Rebuilt when the fleet changes, and only then. */
export function buildRobotIndex(robots) {
  const entries = [];
  for (const r of Array.isArray(robots) ? robots : []) {
    const id = String(r?.robotId || '').trim();
    if (!id) continue;
    if (typeof r?.lat !== 'number' || typeof r?.lon !== 'number') continue;
    const status = String(r.status || 'UNKNOWN').toUpperCase();
    const battery = typeof r.battery === 'number' ? `${Math.round(r.battery)}%` : null;
    entries.push({
      id: `robot:${id}`,
      robotId: id,
      name: id,
      subtitle: battery ? `Robot · ${status} · ${battery}` : `Robot · ${status}`,
      type: SEARCH_RESULT_TYPE.ROBOT,
      lon: r.lon,
      lat: r.lat,
      rank: 0,
      haystack: `${id} robot unit ${String(r.status || '')}`.toLowerCase(),
    });
  }
  return entries;
}

/**
 * Build the searchable index.
 *
 * @param {object} params
 * @param {object} [params.definition]  validated CampusDefinition
 * @param {object[]} [params.robots]    live robot rows ({ robotId, lat, lon, status })
 * @param {object[]} [params.campuses]  entries from `buildCampusRegistryIndex`
 * @returns {object[]} entries: { id, name, subtitle, type, lon, lat, haystack }
 */
export function buildCampusSearchIndex({ definition, robots, campuses } = {}) {
  return [
    ...(Array.isArray(campuses) ? campuses : []),
    ...buildCampusFeatureIndex(definition),
    ...buildRobotIndex(robots),
  ];
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
    // Operational importance breaks ties WITHIN a match strength, never across
    // one: a gate never outranks an exact-prefix match on a lecture block. At
    // 0.04 per rank step the whole 1–9 scale is worth less than the 0.5 that
    // separates a place from a unit, which is the ordering §34 already settled.
    score += (Number(entry.rank) || 9) * 0.04;
    scored.push({ entry, score });
  }

  scored.sort((a, b) => a.score - b.score || a.entry.name.localeCompare(b.entry.name));
  return scored.slice(0, Math.max(0, limit)).map((s) => s.entry);
}
