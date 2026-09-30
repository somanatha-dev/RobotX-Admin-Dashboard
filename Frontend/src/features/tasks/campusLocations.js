/**
 * Where a task on a given campus may start and end — from the campus data the frontend
 * already ships, and nothing else.
 *
 * ── Why the task form stopped using Mapbox search ───────────────────────────
 * Mapbox Searchbox returned places from all of Bengaluru for a campus query, and a picked
 * suggestion could resolve to a different feature than the one clicked. A point outside the
 * campus is accepted by intake and then never assigned, so the operator saw a task that
 * could never move. RobotX is campus-scoped; the form should only offer places on the
 * campus the task is for.
 *
 * ── What is offered ─────────────────────────────────────────────────────────
 * The campus's registered **point** locations (`resolveCampusDefinition(...).features` with
 * Point geometry — for RNSIT the supplied locations and the OSM point features), and only
 * those inside the campus **boundary** polygon. These are the same coordinates the backend's
 * demonstration world is seeded from (`rnsit-campus-supplemental.geojson`). Building
 * polygons are not offered: a polygon is not a delivery point, and inventing one (a
 * centroid) would be a coordinate nobody declared.
 *
 * ── Fail closed ─────────────────────────────────────────────────────────────
 * A campus with no boundary cannot be scoped, so it offers no locations rather than
 * unscoped ones, and `isWithinCampus` answers false. Nothing here talks to the backend or
 * changes what is sent — only which coordinates the operator can choose.
 */
import { campusRegistryEntry, resolveCampusDefinition } from '../maps/campus/campusRegistry.js';
import { pointInPolygon } from '../maps/campus/osm/osmCampusImport.js';

const cache = new Map();

function definitionFor(campusCode) {
  const code = String(campusCode || '').trim();
  if (!code) return null;
  if (cache.has(code)) return cache.get(code);
  const entry = campusRegistryEntry(code);
  const definition = entry ? resolveCampusDefinition({ code: entry.id, name: entry.name }) : null;
  cache.set(code, definition);
  return definition;
}

function boundaryOf(definition) {
  const features = Array.isArray(definition?.features) ? definition.features : [];
  const boundary = features.find((f) => f && f.kind === 'BOUNDARY' && f.geometry);
  return boundary ? boundary.geometry : null;
}

const finite = (n) => typeof n === 'number' && Number.isFinite(n);

/**
 * @param {string} campusCode a campus registry id, e.g. `RNSIT`
 * @returns {{ locations: Array<{ id: string, name: string, lat: number, lon: number, kind: string }>,
 *             hasBoundary: boolean }}
 */
export function campusTaskLocations(campusCode) {
  const definition = definitionFor(campusCode);
  const boundary = boundaryOf(definition);
  if (!definition || !boundary) return { locations: [], hasBoundary: false };

  const locations = [];
  for (const feature of definition.features) {
    if (!feature || feature.geometry?.type !== 'Point') continue;
    const [lon, lat] = feature.geometry.coordinates || [];
    if (!finite(lat) || !finite(lon)) continue;
    if (!pointInPolygon([lon, lat], boundary)) continue;
    locations.push({
      id: String(feature.id),
      name: String(feature.name || feature.id),
      lat,
      lon,
      kind: String(feature.kind || ''),
    });
  }
  locations.sort((a, b) => a.name.localeCompare(b.name));
  return { locations, hasBoundary: true };
}

/**
 * Is this coordinate inside the campus boundary? False when the campus has no boundary —
 * an unscoped campus cannot vouch for any point.
 *
 * @param {string} campusCode
 * @param {number} lat
 * @param {number} lon
 * @returns {boolean}
 */
export function isWithinCampus(campusCode, lat, lon) {
  if (!finite(lat) || !finite(lon)) return false;
  const boundary = boundaryOf(definitionFor(campusCode));
  return boundary ? pointInPolygon([lon, lat], boundary) : false;
}
