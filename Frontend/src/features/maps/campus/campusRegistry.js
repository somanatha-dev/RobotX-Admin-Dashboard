/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CAMPUS GEOMETRY REGISTRY — the campus geography this map holds, per campus
 *
 *   RNSIT geometry source:  OpenStreetMap extract     (open data)
 *   RNSIT verification:     NOT_VERIFIED               (nobody surveyed it)
 *
 * ── What changed, and what did not ────────────────────────────────────────
 * This registry previously shipped RNSIT with an EMPTY feature list, because
 * the repository held exactly one campus-scale fact — the seeded centre point —
 * and inventing footprints to fill the gap would have made the map lie about a
 * place an operator navigates a physical fleet through (§2, §4).
 *
 * It now ships the RNSIT features of `data/rnsit-campus-osm.geojson`, an
 * OpenStreetMap extract, classified by `osm/osmCampusImport.js`. That closes
 * the geometry gap. It does NOT close the verification gap, and the two must
 * not be confused:
 *
 *      geometry      real, community-mapped, ODbL-licensed, held by us
 *      verification  NOT_VERIFIED — no survey, no ground truth, no site plan
 *
 * Every imported feature carries `provenance: OPEN_DATA_IMPORT`, its OSM
 * element id and its complete original tag set, and the map says so on screen.
 * Nothing was drawn, corrected, straightened, completed or guessed on the way
 * in: features OSM does not contain are still absent, and the coverage report
 * still names them.
 *
 * ── What the map shows for RNSIT today ────────────────────────────────────
 *   • the campus BOUNDARY, buildings, roads, paths, landmarks and facilities
 *     from the OSM extract — the campus-specific 3D environment
 *   • the campus CENTRE, from the DB record, separately provenance-tagged
 *   • the vendor basemap (Mapbox/OpenStreetMap) as SURROUNDING CITY CONTEXT,
 *     with its own 3D models clipped away inside the campus boundary so the
 *     two never draw the same building twice (§6)
 *   • the operational layer: robots, routes, mission pins — all authoritative
 *
 * ── Replacing OSM with an official survey (§64) ───────────────────────────
 * Swap `rnsitOsmFeatures()` below for a second importer emitting the same
 * feature shape with `provenance: SURVEYED` and a `verifiedOn` date. Nothing
 * downstream — layers, labels, search, click-to-inspect, themes, camera —
 * changes, because none of it knows where geometry came from.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import {
  CAMPUS_FEATURE_KIND,
  CAMPUS_CATEGORY,
  LABEL_PRIORITY,
  PROVENANCE,
  VERIFICATION,
  validateCampusDefinition,
} from './campusSchema.js';
import { RNSIT_CAMPUS_OSM } from './data/rnsitCampusOsm.js';
import { RNSIT_CAMPUS_SUPPLEMENTAL } from './data/rnsitCampusSupplemental.js';
import { OSM_DATASET, importOsmCampus, pointInPolygon } from './osm/osmCampusImport.js';
import {
  SUPPLEMENTAL_DATASET,
  applyMergesToOsmFeatures,
  importSupplementalCampus,
} from './supplemental/supplementalCampusImport.js';

/**
 * The RNSIT imports, run once at module load.
 *
 * Static rather than lazy on purpose: `resolveCampusDefinition` is a
 * synchronous pure function called from a `useMemo` and from tests, and the two
 * datasets are 68 features between them. They are classified once here; the map
 * only ever receives the result when a campus is actually selected, so global
 * and city zoom still push nothing to the GPU (§30).
 *
 * ── This is the merge point, and the only one ────────────────────────────
 *
 *      rnsitCampusOsm.js  ──►  importOsmCampus         ──┐
 *                                                        ├──►  features
 *      rnsitCampusSupplemental.js ──► importSupplemental ─┘
 *
 * The order matters: the supplemental import is handed the OSM result so it can
 * reconcile against it, and the OSM features it matched are then annotated with
 * the corroborating record. Neither source file is modified by the other, and
 * `applyMergesToOsmFeatures` returns a new array rather than mutating — the OSM
 * import stays exactly what its own module produced (§22).
 */
const RNSIT_OSM = importOsmCampus(RNSIT_CAMPUS_OSM);

const RNSIT_SUPPLEMENTAL = importSupplementalCampus(RNSIT_CAMPUS_SUPPLEMENTAL, {
  osmFeatures: RNSIT_OSM.features,
  boundary: RNSIT_OSM.boundary,
});

const RNSIT_OSM_FEATURES = applyMergesToOsmFeatures(
  RNSIT_OSM.features,
  RNSIT_SUPPLEMENTAL.merges,
  RNSIT_CAMPUS_SUPPLEMENTAL
);

/**
 * Campus geometry, keyed by `Campus.code`.
 *
 * An entry's `features` array may contain ONLY features that declare where
 * their coordinates came from — `provenance`, `source` and `verification` are
 * all mandatory, and `campusSchema.validateCampusFeature` rejects anything
 * else. That is what keeps a plausible-looking hand-authored object out.
 *
 * @type {Readonly<Record<string, { features: object[], notes: string, dataset: object }>>}
 */
export const CAMPUS_GEOMETRY = Object.freeze({
  RNSIT: Object.freeze({
    features: Object.freeze([...RNSIT_OSM_FEATURES, ...RNSIT_SUPPLEMENTAL.features]),
    dataset: Object.freeze({
      ...OSM_DATASET,
      sourceFeatureCount: RNSIT_CAMPUS_OSM.features.length,
      importedFeatureCount: RNSIT_OSM.features.length,
      excluded: Object.freeze(RNSIT_OSM.excluded),
      conflicts: Object.freeze(RNSIT_OSM.conflicts),
      labelSuppressed: Object.freeze(RNSIT_OSM.unlabelled),
    }),
    supplemental: Object.freeze({
      ...SUPPLEMENTAL_DATASET,
      sourceFeatureCount: RNSIT_CAMPUS_SUPPLEMENTAL.features.length,
      importedFeatureCount: RNSIT_SUPPLEMENTAL.features.length,
      excluded: Object.freeze(RNSIT_SUPPLEMENTAL.excluded),
      merges: Object.freeze(RNSIT_SUPPLEMENTAL.merges),
      possibleDuplicates: Object.freeze(RNSIT_SUPPLEMENTAL.possibleDuplicates),
      coLocations: Object.freeze(RNSIT_SUPPLEMENTAL.coLocations),
      containment: Object.freeze(RNSIT_SUPPLEMENTAL.containment),
    }),
    notes:
      `Campus geometry is an OpenStreetMap extract (${OSM_DATASET.file}), ${OSM_DATASET.licence}. ` +
      'It is real community-mapped data and it is NOT a survey of this campus: nothing in this ' +
      'repository has checked it against the physical site, so every feature is NOT_VERIFIED. ' +
      'No feature carries a measured height — the extract has no height tag anywhere — so building ' +
      'volumes are drawn from building:levels where present and from a conservative rendering ' +
      'default otherwise. Anything OSM does not map is still missing and is reported as missing. ' +
      `A second dataset (${SUPPLEMENTAL_DATASET.file}) adds user-supplied POINT LOCATIONS — a gate, ` +
      'playgrounds, parking, departments and facilities OSM does not carry. Those are locations ' +
      'only: no footprint, extent or height is derived from them, and they are the least verified ' +
      'thing on this map.',
  }),
});

/** The OSM import diagnostics for a campus code, for the data-quality UI and tests. */
export function campusDatasetInfo(code) {
  return CAMPUS_GEOMETRY[String(code || '').trim()]?.dataset || null;
}

/** The supplemental import diagnostics — merges, near-misses, containment. */
export function campusSupplementalInfo(code) {
  return CAMPUS_GEOMETRY[String(code || '').trim()]?.supplemental || null;
}

/**
 * Build the renderable CampusDefinition for a campus record.
 *
 * The centre is read from the DB record the filter bar already loaded — it is
 * never hard-coded here, so the map and the database cannot drift apart on
 * where a campus is.
 *
 * @param {{code?: string, name?: string, centerLat?: number, centerLon?: number}|null} campusRecord
 * @returns {ReturnType<typeof validateCampusDefinition> & {
 *   notes: string,
 *   hasCampusGeometry: boolean,
 *   geometrySource: string|null,
 *   dataset: object|null,
 *   missingGeometry: object[],
 * }}
 */
export function resolveCampusDefinition(campusRecord) {
  const code = typeof campusRecord?.code === 'string' ? campusRecord.code.trim() : '';
  const name = typeof campusRecord?.name === 'string' ? campusRecord.name.trim() : '';
  const lat = campusRecord?.centerLat;
  const lon = campusRecord?.centerLon;
  const hasCenter = typeof lat === 'number' && Number.isFinite(lat) && typeof lon === 'number' && Number.isFinite(lon);

  const entry = CAMPUS_GEOMETRY[code] || null;
  const registered = Array.isArray(entry?.features) ? entry.features : [];

  const features = [...registered];

  // The campus centre is the one campus-scale fact this system actually holds.
  // It is a real record, so it is rendered — and it is NOT_VERIFIED, because
  // nothing here has checked that coordinate against the physical campus.
  if (hasCenter) {
    features.unshift({
      id: `${code || 'campus'}-center`,
      name: name || code || 'Campus',
      shortName: code || null,
      kind: CAMPUS_FEATURE_KIND.CAMPUS_CENTER,
      category: CAMPUS_CATEGORY.OPERATIONAL,
      labelPriority: LABEL_PRIORITY.PRIMARY,
      geometry: { type: 'Point', coordinates: [lon, lat] },
      provenance: PROVENANCE.SEED_RECORD,
      verification: VERIFICATION.NOT_VERIFIED,
      source: 'Campus.centerLat / Campus.centerLon (Backend/prisma/schema.prisma; seeded in Backend/prisma/seed.js)',
      verifiedOn: null,
      metadata: { role: 'campus centre' },
    });
  }

  const validated = validateCampusDefinition({
    code: code || null,
    name: name || null,
    center: hasCenter ? { lon, lat } : null,
    features,
  });

  // The single most likely way this integration could go wrong is silently:
  // geometry that loads, validates and renders in the wrong place. The centre
  // the database holds must fall inside the boundary the dataset draws, or the
  // two disagree about where the campus is and one of them is lying to the
  // operator. Reported, never corrected — moving geometry to make a check pass
  // is the failure, not the fix (§49).
  const boundary = validated.features.find((f) => f.kind === CAMPUS_FEATURE_KIND.BOUNDARY) || null;
  const centreWithinBoundary =
    boundary && hasCenter ? pointInPolygon([lon, lat], boundary.geometry) : null;

  return {
    ...validated,
    notes: entry?.notes || 'No campus geometry entry registered for this campus code.',
    hasCampusGeometry: registered.length > 0,
    geometrySource: entry?.dataset?.origin || null,
    dataset: entry?.dataset || null,
    supplemental: entry?.supplemental || null,
    centreWithinBoundary,
    missingGeometry: validated.coverage.missing,
  };
}

/**
 * An empty, valid definition — used when no campus is selected, so consumers
 * never branch on null and layers can be installed with empty sources.
 */
export const EMPTY_CAMPUS_DEFINITION = Object.freeze({
  ok: true,
  code: null,
  name: null,
  center: null,
  features: Object.freeze([]),
  rejected: Object.freeze([]),
  errors: Object.freeze([]),
  coverage: Object.freeze({ present: Object.freeze([]), missing: Object.freeze([]) }),
  verifiedCount: 0,
  notes: 'No campus selected.',
  hasCampusGeometry: false,
  geometrySource: null,
  dataset: null,
  supplemental: null,
  centreWithinBoundary: null,
  missingGeometry: Object.freeze([]),
});

/**
 * What this map still does NOT have for RNSIT, after the OSM import.
 *
 * The OSM extract supplied the boundary, buildings, roads, paths, landmarks and
 * facilities. It did not supply — and this file will not manufacture — the two
 * things below. They stay named, in the UI and in this constant, so the gap
 * remains a tracked data request rather than a silent visual compromise (§46).
 */
export const MISSING_GEOMETRY_REQUEST = Object.freeze({
  campus: 'RNSIT — RNS Institute of Technology',
  format: 'GeoJSON, WGS84 (EPSG:4326), lon/lat order',
  suppliedBy: Object.freeze({
    dataset: OSM_DATASET.file,
    origin: OSM_DATASET.origin,
    licence: OSM_DATASET.licence,
    verification: 'NOT_VERIFIED — community-mapped open data, not a survey of this site',
  }),
  artefacts: Object.freeze([
    'Gates / entrances — Points, named, with access role. NOT PRESENT in the OSM extract: it ' +
      'contains no barrier=gate, entrance=* or access-control node anywhere on the site, so the ' +
      'map does not know where the campus is entered.',
    'Measured building heights — metres per footprint. NOT PRESENT: the extract carries no ' +
      'height tag on any feature. Seven buildings carry building:levels, from which a DRAWN ' +
      'height is derived for rendering only; the other buildings are drawn at a default. ' +
      'No drawn height is a measurement and none is presented as one.',
    'Independent verification of the imported geometry — a site plan or GNSS walk-around the ' +
      'imported footprints can be checked against, which would move features from NOT_VERIFIED ' +
      'to VERIFIED with a date.',
    'Interior / operational detail — floors, rooms, door positions, loading points, keep-out ' +
      'zones. Outside OSM\'s scope and absent here.',
  ]),
  perFeatureMetadata: Object.freeze(['provenance', 'source', 'verification', 'verifiedOn']),
  acceptableSources: Object.freeze([
    'An institutional site plan or campus survey, georeferenced.',
    'A GNSS/RTK walk-around of the site.',
    'Any dataset the project has an explicit licence to redistribute.',
  ]),
  notAcceptable: Object.freeze([
    'Coordinates estimated from a satellite image by eye.',
    'Footprints generated from the centre point and a guessed radius.',
    'Building identities inferred from position ("this one is probably CSE").',
    'A drawn extrusion height reported to an operator as a building height.',
  ]),
});
