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
 * Pickup and drop are offered the SAME list. Nothing here decides whether a robot can reach
 * a location: the backend accepts any point inside the delivery domain and the assignment
 * engine answers routability afterwards, refusing by name (`NOT_ROUTABLE`, `ACCESS_TOO_LONG`).
 *
 * ── The inventory: where every source record went ──────────────────────────
 * `campusLocationInventory` accounts for every feature the campus datasets carry — offered,
 * or excluded with one reason from `LOCATION_EXCLUSION` — so "why is X not in the list?" is
 * answered by the data rather than by reading this file. `campusTaskLocations` is derived
 * from it, so the two cannot disagree. A named destination the campus model knows only as a
 * footprint is reported `NO_DECLARED_POINT`: a data gap, closed by supplying a point for it,
 * never by computing one here.
 *
 * ── Access points: suggested by a tool, admitted by a person ────────────────
 * The access-point register (`maps/campus/access/accessPointImport.js`) proposes sidewalk
 * points facing each such footprint. Every proposal is excluded here as
 * `UNVERIFIED_ACCESS_CANDIDATE` until a person verifies it on site; a verified one arrives
 * as an ordinary Point feature naming the footprint it serves (`servesFeatureId`), is
 * offered like any other, and the footprint is then reported `SERVED_BY_ACCESS_POINT`.
 *
 * ── Fail closed ─────────────────────────────────────────────────────────────
 * A campus with no boundary cannot be scoped, so it offers no locations rather than
 * unscoped ones, and `isWithinCampus` answers false. Nothing here talks to the backend or
 * changes what is sent — only which coordinates the operator can choose.
 */
import { campusRegistryEntry, resolveCampusDefinition } from '../maps/campus/campusRegistry.js';
import { CAMPUS_FEATURE_KIND, isOperationalRole } from '../maps/campus/campusSchema.js';
import { pointInPolygon } from '../maps/campus/osm/osmCampusImport.js';

/** Why a campus source record is not offered as a pickup or drop. */
export const LOCATION_EXCLUSION = Object.freeze({
  /** The OSM importer did not import it; the importer's own reason is in `detail`. */
  EXCLUDED_AT_IMPORT: 'EXCLUDED_AT_IMPORT',
  /** A supplied point the import folded into the OSM record of the same place. */
  MERGED_AT_IMPORT: 'MERGED_AT_IMPORT',
  /** The campus schema rejected the record. */
  INVALID_RECORD: 'INVALID_RECORD',
  /** A point whose coordinate is not a pair of finite numbers. */
  MALFORMED_COORDINATE: 'MALFORMED_COORDINATE',
  /** A point outside the adopted campus boundary (RD-2026-08-30-01). */
  OUTSIDE_BOUNDARY: 'OUTSIDE_BOUNDARY',
  /** A second point carrying an id already offered. The first one stands. */
  DUPLICATE_ID: 'DUPLICATE_ID',
  /** A named destination the campus model holds only as a footprint — no point is declared. */
  NO_DECLARED_POINT: 'NO_DECLARED_POINT',
  /** A destination footprint whose place IS offered, through a site-verified access point. */
  SERVED_BY_ACCESS_POINT: 'SERVED_BY_ACCESS_POINT',
  /** Development mode only: offered through UNVERIFIED candidates (access/developmentCandidates.js). */
  SERVED_BY_UNVERIFIED_CANDIDATE: 'SERVED_BY_UNVERIFIED_CANDIDATE',
  /** A generated access-point candidate nobody has verified on site (`candidate`, `needs_review`). */
  UNVERIFIED_ACCESS_CANDIDATE: 'UNVERIFIED_ACCESS_CANDIDATE',
  /** An access-point candidate rejected by the generator's checks or by a reviewer. */
  REJECTED_ACCESS_CANDIDATE: 'REJECTED_ACCESS_CANDIDATE',
  /** A register entry claiming `verified` that the importer refused (no review, off campus, …). */
  INVALID_ACCESS_RECORD: 'INVALID_ACCESS_RECORD',
  /** Not a place a robot is sent to: circulation, the boundary, landmarks, unnamed footprints. */
  NOT_A_DESTINATION: 'NOT_A_DESTINATION',
});

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
const isArea = (geometry) => geometry?.type === 'Polygon' || geometry?.type === 'MultiPolygon';
const sameName = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

/**
 * Reconcile one campus definition into offered locations and excluded records. Pure: the
 * definition is the only input, so a test can hand it a malformed one.
 *
 * @param {object|null} definition `resolveCampusDefinition(...)`'s result
 * @returns {{ hasBoundary: boolean,
 *             offered: Array<{ id: string, sourceId: string|null, name: string, lat: number, lon: number, kind: string }>,
 *             excluded: Array<{ id: string|null, sourceId: string|null, name: string|null, kind: string|null,
 *                               reason: string, detail: string|null,
 *                               sameNameOffered?: string[], containsOffered?: string[] }>,
 *             coLocated: string[][],
 *             sourceFeatureCount: number }}
 */
export function locationInventoryFor(definition) {
  const boundary = boundaryOf(definition);
  const offered = [];
  const excluded = [];
  const exclude = (record, reason, detail = null) =>
    excluded.push({
      id: record.id ?? null,
      sourceId: record.sourceId ?? null,
      name: record.name ?? null,
      kind: record.kind ?? null,
      reason,
      detail,
    });

  // Records that never became features: the OSM importer's exclusions, the supplied points
  // merged into an OSM record, and anything the campus schema rejected.
  for (const row of definition?.dataset?.excluded || []) {
    exclude({ sourceId: row.osmId, name: row.name }, LOCATION_EXCLUSION.EXCLUDED_AT_IMPORT, `${row.reason}: ${row.detail}`);
  }
  for (const merge of definition?.supplemental?.merges || []) {
    exclude(
      { id: merge.supplementalId, sourceId: merge.supplementalId, name: merge.name },
      LOCATION_EXCLUSION.MERGED_AT_IMPORT,
      `the same place as ${merge.osmId}, ${merge.metres} m away — offered once, as that record`
    );
  }
  for (const row of definition?.rejected || []) {
    exclude({ id: row.id }, LOCATION_EXCLUSION.INVALID_RECORD, (row.errors || []).join('; '));
  }
  // Access-point register entries that did not become features. A candidate is never
  // offered: only a site-verified entry is admitted, and it then arrives below as a Point.
  const access = definition?.accessPoints;
  for (const row of access?.pending || []) {
    exclude(
      { id: row.id, sourceId: row.id, name: row.buildingName },
      LOCATION_EXCLUSION.UNVERIFIED_ACCESS_CANDIDATE,
      `${row.status} for ${row.buildingFeatureId}${row.flags?.length ? ` — ${row.flags.join(', ')}` : ''}`
    );
  }
  for (const row of access?.rejected || []) {
    exclude(
      { id: row.id, sourceId: row.id, name: row.buildingName },
      LOCATION_EXCLUSION.REJECTED_ACCESS_CANDIDATE,
      `for ${row.buildingFeatureId}: ${(row.reasons || []).join(', ')}`
    );
  }
  for (const row of access?.invalid || []) {
    exclude(
      { id: row.id, sourceId: row.id, name: row.buildingName },
      LOCATION_EXCLUSION.INVALID_ACCESS_RECORD,
      (row.problems || []).join('; ')
    );
  }

  const features = Array.isArray(definition?.features) ? definition.features.filter(Boolean) : [];
  const footprints = [];
  const seen = new Set();
  for (const feature of features) {
    if (feature.geometry?.type !== 'Point') {
      const destination =
        isArea(feature.geometry) &&
        feature.kind !== CAMPUS_FEATURE_KIND.BOUNDARY &&
        isOperationalRole(feature.operationalRole);
      if (destination) footprints.push(feature);
      else exclude(feature, LOCATION_EXCLUSION.NOT_A_DESTINATION, `${feature.kind} ${feature.geometry?.type || 'without geometry'}`);
      continue;
    }
    const [lon, lat] = feature.geometry.coordinates || [];
    if (!finite(lat) || !finite(lon)) {
      exclude(feature, LOCATION_EXCLUSION.MALFORMED_COORDINATE, JSON.stringify(feature.geometry.coordinates ?? null));
      continue;
    }
    if (!boundary || !pointInPolygon([lon, lat], boundary)) {
      exclude(feature, LOCATION_EXCLUSION.OUTSIDE_BOUNDARY, boundary ? `${lat}, ${lon}` : 'the campus has no boundary');
      continue;
    }
    const id = String(feature.id);
    if (seen.has(id)) {
      exclude(feature, LOCATION_EXCLUSION.DUPLICATE_ID, `id "${id}" is already offered`);
      continue;
    }
    seen.add(id);
    offered.push({
      id,
      sourceId: feature.sourceId ?? null,
      name: String(feature.name || feature.id),
      lat,
      lon,
      kind: String(feature.kind || ''),
      servesFeatureId: feature.servesFeatureId ?? null,
      // A development-mode candidate nobody has checked on site (access/developmentCandidates.js).
      unverified: feature.unverifiedCandidate === true,
    });
  }

  // Footprint-only destinations, reported with what IS offered that relates to them. Neither
  // relation is an identity: OSM maps Canara Bank twice, and its node lies inside the Main
  // Building footprint, not inside the bank's own. Only an access point that names the
  // footprint (`servesFeatureId`) serves it — verified, or in development mode unverified,
  // and the two are reported apart.
  for (const feature of footprints) {
    const servedBy = offered.filter((l) => l.servesFeatureId === feature.id && !l.unverified).map((l) => l.id);
    const servedByUnverified = offered.filter((l) => l.servesFeatureId === feature.id && l.unverified).map((l) => l.id);
    const sameNameOffered = offered.filter((l) => sameName(l.name, feature.name)).map((l) => l.id);
    const containsOffered = offered.filter((l) => pointInPolygon([l.lon, l.lat], feature.geometry)).map((l) => l.id);
    const notes = [
      servedBy.length
        ? `${feature.operationalRole} footprint served by verified access point ${servedBy.join(', ')}`
        : servedByUnverified.length
          ? `${feature.operationalRole} footprint offered through ${servedByUnverified.length} UNVERIFIED development candidate(s)`
          : `${feature.operationalRole} footprint with no declared point`,
    ];
    if (sameNameOffered.length) notes.push(`same name offered as ${sameNameOffered.join(', ')}`);
    if (containsOffered.length) notes.push(`contains offered point ${containsOffered.join(', ')}`);
    exclude(
      feature,
      servedBy.length
        ? LOCATION_EXCLUSION.SERVED_BY_ACCESS_POINT
        : servedByUnverified.length
          ? LOCATION_EXCLUSION.SERVED_BY_UNVERIFIED_CANDIDATE
          : LOCATION_EXCLUSION.NO_DECLARED_POINT,
      notes.join('; ')
    );
    Object.assign(excluded[excluded.length - 1], {
      operationalRole: feature.operationalRole,
      servedBy,
      servedByUnverified,
      sameNameOffered,
      containsOffered,
    });
  }

  // Two names on one coordinate (RNSIT has a pair). Both are offered — they are different
  // records — and reported, because choosing both is a delivery of zero metres.
  const byPoint = new Map();
  for (const l of offered) {
    const key = `${l.lon},${l.lat}`;
    byPoint.set(key, [...(byPoint.get(key) || []), l.id]);
  }
  const coLocated = [...byPoint.values()].filter((ids) => ids.length > 1);

  offered.sort((a, b) => a.name.localeCompare(b.name));
  return {
    hasBoundary: Boolean(boundary),
    offered,
    excluded,
    coLocated,
    sourceFeatureCount:
      (definition?.dataset?.sourceFeatureCount || 0) +
      (definition?.supplemental?.sourceFeatureCount || 0) +
      (access?.sourceFeatureCount || 0),
  };
}

const inventories = new Map();

/**
 * Every source record of one campus, offered or excluded with a reason.
 *
 * @param {string} campusCode a campus registry id, e.g. `RNSIT`
 */
export function campusLocationInventory(campusCode) {
  const code = String(campusCode || '').trim();
  if (!inventories.has(code)) inventories.set(code, locationInventoryFor(definitionFor(code)));
  return inventories.get(code);
}

/**
 * @param {string} campusCode a campus registry id, e.g. `RNSIT`
 * @returns {{ locations: Array<{ id: string, sourceId: string|null, name: string, lat: number, lon: number, kind: string }>,
 *             hasBoundary: boolean,
 *             withoutDeclaredPoint: Array<{ id: string, name: string }>,
 *             unverifiedCount: number }}
 */
export function campusTaskLocations(campusCode) {
  const inventory = campusLocationInventory(campusCode);
  return {
    locations: inventory.offered,
    hasBoundary: inventory.hasBoundary,
    // A footprint whose place is offered under the same name (the Canara Bank node) is not
    // something the operator is missing.
    withoutDeclaredPoint: inventory.excluded
      .filter((row) => row.reason === LOCATION_EXCLUSION.NO_DECLARED_POINT && row.sameNameOffered.length === 0)
      .map((row) => ({ id: row.id, name: row.name })),
    // Development mode only: how many offered locations are unverified candidates.
    unverifiedCount: inventory.offered.filter((l) => l.unverified).length,
  };
}

/**
 * The destination footprints of one campus — the places the campus model says the fleet
 * delivers to but the data holds only as a polygon — whether or not a verified access point
 * already serves them. The Backend access-candidate generator reads exactly this list, so
 * "which buildings need an access point" has one answer.
 *
 * @param {string} campusCode
 * @returns {Array<{ featureId: string, sourceId: string, name: string, operationalRole: string,
 *                   servedBy: string[], related: { sameNameOffered: string[], containsOffered: string[] } }>}
 */
export function destinationFootprints(campusCode) {
  return campusLocationInventory(campusCode)
    .excluded.filter(
      (row) =>
        row.reason === LOCATION_EXCLUSION.NO_DECLARED_POINT ||
        row.reason === LOCATION_EXCLUSION.SERVED_BY_ACCESS_POINT ||
        row.reason === LOCATION_EXCLUSION.SERVED_BY_UNVERIFIED_CANDIDATE
    )
    .map((row) => ({
      featureId: row.id,
      sourceId: row.sourceId,
      name: row.name,
      operationalRole: row.operationalRole,
      servedBy: row.servedBy,
      related: { sameNameOffered: row.sameNameOffered, containsOffered: row.containsOffered },
    }));
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
