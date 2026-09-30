/**
 * Where the map opens when no location filter is selected: the campuses RobotX actually
 * operates on, from data the frontend already carries.
 *
 * ── Why not world view ──────────────────────────────────────────────────────
 * With no filter the map used to open on the whole globe, the fleet a handful of pixels in
 * Bengaluru. The campus registry already says which campuses have an operating region
 * (`regionId`, the region tasks are submitted to — RNSIT today) and carries each one's
 * adopted boundary polygon. Their extent is the honest default: it is where tasks can be
 * created and where the engine assigns.
 *
 * ── What this does not do ───────────────────────────────────────────────────
 * It invents no coordinates (every number comes from a registered boundary), it does not
 * select a campus or set a filter, and it does not touch robots or markers. A campus with
 * no operating region, or no boundary, contributes nothing; with none at all the caller
 * keeps world view.
 */
import { CAMPUS_REGISTRY, resolveCampusDefinition } from './campusRegistry.js';

function ringsOf(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return geometry.coordinates || [];
  if (geometry.type === 'MultiPolygon') return (geometry.coordinates || []).flat();
  return [];
}

/**
 * The bounding box of every operating campus's boundary.
 *
 * @param {ReadonlyArray<object>} [registry] the campus registry (injectable for tests)
 * @returns {[[number, number], [number, number]] | null} `[[west, south], [east, north]]`
 */
export function operatingCampusBounds(registry = CAMPUS_REGISTRY) {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const entry of Array.isArray(registry) ? registry : []) {
    if (!entry?.regionId) continue;
    const definition = resolveCampusDefinition({ code: entry.id, name: entry.name });
    const boundary = (definition?.features || []).find((f) => f?.kind === 'BOUNDARY');
    for (const ring of ringsOf(boundary?.geometry)) {
      for (const point of ring || []) {
        const [lon, lat] = point || [];
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        west = Math.min(west, lon);
        east = Math.max(east, lon);
        south = Math.min(south, lat);
        north = Math.max(north, lat);
      }
    }
  }
  return Number.isFinite(west) ? [[west, south], [east, north]] : null;
}
