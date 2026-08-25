/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CAMPUS REGISTRY — every campus this map holds, built by ONE pipeline
 *
 *      REGISTERED_CAMPUSES          ← data: metadata + which files
 *              │
 *              ▼
 *      buildCampus()                ← the pipeline, written once, run per campus
 *              │
 *      CAMPUS_GEOMETRY[code]        ← features · dataset · verification · notes
 *              │
 *      resolveCampusDefinition()    ← + the DB centre → the renderable definition
 *              │
 *      campusLayers / useCampusLayer / campusSearch / camera / themes
 *                                   ← none of which knows a campus code exists
 *
 * ── What changed when the second campus arrived ───────────────────────────
 * This file used to BE the RNSIT campus: a straight-line script that imported
 * RNSIT's two datasets, ran them through the importers, applied RNSIT's
 * verification, and froze the result into a one-key object. Every step was
 * correct and every step was written out longhand for exactly one campus.
 *
 * The steps have not changed — the pipeline below is the same sequence, in the
 * same order, with the same comments about why each step happens where it does.
 * What changed is that the sequence is now a FUNCTION and the campus is now an
 * ARGUMENT. Adding JSS Academy of Technical Education added an entry to
 * `REGISTERED_CAMPUSES` and two files under `data/jssate-bengaluru/`. It added
 * no importer, no classifier, no layer, no camera rule and no branch anywhere
 * downstream — which is the property this file exists to keep true at campus
 * #3, #50 and #100.
 *
 * ── What a campus entry may contain ───────────────────────────────────────
 *   id / name          the Campus.code and name — the join to the DB record
 *   country/state/city where it is, for the location hierarchy and for search
 *   aliases            other names people type for it (§search)
 *   osm                { file, collection } — an Overpass extract, or null
 *   supplemental       { file, collection } — user-supplied points, or null
 *
 * It may NOT contain geometry, a camera, a colour, a layer or a rendering
 * decision. If a campus ever needs one of those, the correct fix is a new
 * data-driven field the SHARED pipeline reads for every campus — never a branch
 * on this campus's id.
 *
 * ── What is derived, and where ────────────────────────────────────────────
 * Nothing below invents geometry. Every coordinate on the map was read out of
 * one of the files named in an entry, unchanged, and every feature carries the
 * dataset and element it came from. Verification is applied afterwards from a
 * separate dated record (see `verification/campusVerification.js`), so a campus
 * nobody has visited — JSSATE today — renders exactly the same way while
 * honestly reporting NOT_VERIFIED on every feature.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import {
  CAMPUS_FEATURE_KIND,
  CAMPUS_CATEGORY,
  LABEL_PRIORITY,
  OPERATIONAL_ROLE,
  PROVENANCE,
  VERIFICATION,
  validateCampusDefinition,
} from './campusSchema.js';
import { RNSIT_CAMPUS_OSM } from './data/rnsit/rnsitCampusOsm.js';
import { RNSIT_CAMPUS_SUPPLEMENTAL } from './data/rnsit/rnsitCampusSupplemental.js';
import { JSSATE_BENGALURU_CAMPUS_OSM } from './data/jssate-bengaluru/jssateBengaluruCampusOsm.js';
import { importOsmCampus, osmDataset, pointInPolygon } from './osm/osmCampusImport.js';
import {
  applyMergesToOsmFeatures,
  importSupplementalCampus,
  supplementalDataset,
} from './supplemental/supplementalCampusImport.js';
import { applyOperationalProfiles, describeOperationalModel } from './semantics/campusOperational.js';
import {
  applyCampusVerification,
  campusVerificationFor,
  describeCampusVerification,
} from './verification/campusVerification.js';

// ── The campuses, as data ────────────────────────────────────────────────────

/**
 * Every campus this build holds. THIS IS THE WHOLE OF THE PER-CAMPUS CODE.
 *
 * `id` is the `Campus.code` in the database (Backend/prisma/schema.prisma). The
 * two must agree or the map and the record are talking about different places,
 * which is why the code is never re-derived, prettified or defaulted anywhere
 * downstream.
 */
const REGISTERED_CAMPUSES = Object.freeze([
  Object.freeze({
    id: 'RNSIT',
    name: 'RNS Institute of Technology',
    country: 'India',
    state: 'Karnataka',
    city: 'Bengaluru',
    aliases: Object.freeze(['RNSIT', 'RNS Institute of Technology', 'RNSIT Bengaluru', 'RNS Institute']),
    osm: Object.freeze({ file: 'rnsit-campus-osm.geojson', collection: RNSIT_CAMPUS_OSM }),
    supplemental: Object.freeze({
      file: 'rnsit-campus-supplemental.geojson',
      collection: RNSIT_CAMPUS_SUPPLEMENTAL,
    }),
  }),
  Object.freeze({
    id: 'jssate-bengaluru',
    name: 'JSS Academy of Technical Education',
    country: 'India',
    state: 'Karnataka',
    city: 'Bengaluru',
    /**
     * The names people actually type. "JSSATEB" is the institution's own
     * abbreviation and appears in the extract's `operator` tags; the rest are
     * the forms the brief asks to resolve to this campus.
     *
     * These are DATA in the registry entry, matched by the same generic ranking
     * function every other search entry goes through — not a condition anywhere
     * in the search code.
     */
    aliases: Object.freeze([
      'JSSATE',
      'JSSATE Bengaluru',
      'JSSATEB',
      'JSS Academy of Technical Education',
      'JSS Academy of Technical Education Bengaluru',
      'JSS Academy',
      'JSS',
    ]),
    osm: Object.freeze({
      file: 'jssate-bengaluru-campus-osm.geojson',
      collection: JSSATE_BENGALURU_CAMPUS_OSM,
    }),
    /**
     * None supplied, and none invented. The separation between OPEN DATA and
     * USER-SUPPLIED LOCAL KNOWLEDGE is the point of having two importers; a
     * campus with nothing in the second category has nothing in the second
     * category, and the coverage report says which capabilities that leaves
     * missing rather than filling them in.
     */
    supplemental: null,
  }),
]);

// ── The pipeline, written once ───────────────────────────────────────────────

/**
 * Build one campus's geometry entry.
 *
 * ── This is the merge point, and the only one ────────────────────────────
 *
 *      <campus>/…-osm.geojson          ──►  importOsmCampus         ──┐
 *                                                                     ├──►  features
 *      <campus>/…-supplemental.geojson ──►  importSupplemental       ─┘
 *
 * The order matters: the supplemental import is handed the OSM result so it can
 * reconcile against it, and the OSM features it matched are then annotated with
 * the corroborating record. Neither source file is modified by the other, and
 * `applyMergesToOsmFeatures` returns a new array rather than mutating — the OSM
 * import stays exactly what its own module produced (§22).
 *
 * ── The two derivations that happen HERE and nowhere else ─────────────────
 *
 *   imported features
 *        │
 *        ├─► applyOperationalProfiles   which of these does the fleet use? (§3C)
 *        │
 *        └─► applyCampusVerification    who checked them, and when?        (§3A)
 *
 * Both run at the merge point, downstream of every importer, for the same
 * reason the merge itself does: an importer classifies a FILE, and neither of
 * these is a fact about a file. An importer that emitted VERIFIED_BY_USER would
 * be claiming an OpenStreetMap extract had been to Bengaluru.
 *
 * Both are pure array→array transforms that pass geometry through by reference
 * and never touch `provenance`, `source`, `sourceId` or `sourceTags`. The
 * verification is applied LAST so its metadata line reads after the role, and
 * so a future third derivation slots in without reordering a claim.
 *
 * Runs once per campus at module load. Static rather than lazy on purpose:
 * `resolveCampusDefinition` is a synchronous pure function called from a
 * `useMemo` and from tests. The map only ever receives a campus's features when
 * that campus is actually selected — `resolveCampusDefinition` is called for
 * one record and `useCampusLayer` pushes only what it returns — so global,
 * country, state and city zoom still push nothing to the GPU (§30), no matter
 * how many campuses are registered.
 */
function buildCampus(entry) {
  const osmDs = entry.osm ? osmDataset(entry.osm.file) : null;
  const supDs = entry.supplemental
    ? supplementalDataset(entry.supplemental.file, entry.id, entry.name)
    : null;

  const osm = entry.osm
    ? importOsmCampus(entry.osm.collection, { dataset: osmDs })
    : { features: [], excluded: [], unlabelled: [], conflicts: [], outsideBoundary: [], boundary: null };

  const supplemental = entry.supplemental
    ? importSupplementalCampus(entry.supplemental.collection, {
        osmFeatures: osm.features,
        boundary: osm.boundary,
        dataset: supDs,
      })
    : {
        features: [],
        excluded: [],
        merges: [],
        possibleDuplicates: [],
        coLocations: [],
        containment: [],
      };

  const osmFeatures = applyMergesToOsmFeatures(
    osm.features,
    supplemental.merges,
    entry.supplemental?.collection
  );

  const record = campusVerificationFor(entry.id);
  const classified = applyOperationalProfiles([...osmFeatures, ...supplemental.features]);
  const verified = applyCampusVerification(classified, record);

  const dataset = entry.osm
    ? Object.freeze({
        ...osmDs,
        sourceFeatureCount: entry.osm.collection.features.length,
        importedFeatureCount: osm.features.length,
        excluded: Object.freeze(osm.excluded),
        conflicts: Object.freeze(osm.conflicts),
        labelSuppressed: Object.freeze(osm.unlabelled),
        outsideBoundary: Object.freeze(osm.outsideBoundary),
      })
    : null;

  const supplementalInfo = entry.supplemental
    ? Object.freeze({
        ...supDs,
        sourceFeatureCount: entry.supplemental.collection.features.length,
        importedFeatureCount: supplemental.features.length,
        excluded: Object.freeze(supplemental.excluded),
        merges: Object.freeze(supplemental.merges),
        possibleDuplicates: Object.freeze(supplemental.possibleDuplicates),
        coLocations: Object.freeze(supplemental.coLocations),
        containment: Object.freeze(supplemental.containment),
      })
    : null;

  return Object.freeze({
    features: Object.freeze(verified.features),
    verification: Object.freeze({
      ...describeCampusVerification(verified.features, record),
      applied: verified.verified,
      notApplied: verified.skipped,
    }),
    operational: Object.freeze(describeOperationalModel(verified.features)),
    dataset,
    supplemental: supplementalInfo,
    notes: describeCampusNotes(entry, {
      features: verified.features,
      dataset,
      supplemental: supplementalInfo,
      record,
    }),
  });
}

// ── The notes, derived from what was actually imported ───────────────────────

const countBy = (features, pred) => features.filter(pred).length;

/**
 * The on-map coverage statement for one campus.
 *
 * Generated rather than written, for the reason a per-campus paragraph fails at
 * scale: a hand-written note is a claim frozen at the moment somebody typed it,
 * and the fastest way to get a map that lies is to change the data and leave the
 * sentence describing it alone. Every clause below is conditioned on a COUNT
 * taken from the features that were actually imported a few lines above, so a
 * campus that gains a height tag, a gate or a supplemental dataset stops being
 * described as lacking one without anybody editing prose.
 */
function describeCampusNotes(entry, { features, dataset, supplemental, record }) {
  const parts = [];

  if (dataset) {
    parts.push(
      `Campus geometry originates in an OpenStreetMap extract (${dataset.file}), ${dataset.licence}.`
    );
  } else {
    parts.push('No campus dataset is registered for this campus, so the map draws no campus geometry.');
  }

  if (supplemental) {
    parts.push(
      `A second dataset (${supplemental.file}) supplies ${supplemental.importedFeatureCount} ` +
        'user-supplied POINT LOCATIONS the extract does not carry. Both sources are preserved ' +
        'separately and neither edits the other.'
    );
  } else if (dataset) {
    parts.push(
      'No supplemental dataset of user-supplied locations exists for this campus yet, and none ' +
        'has been invented to stand in for one.'
    );
  }

  if (record) {
    parts.push(
      `${record.verifiedBy} confirmed these campus features against the site on ${record.verifiedOn}, ` +
        'so they carry VERIFIED_BY_USER alongside their original provenance — where the coordinates ' +
        'came from and who checked them are two facts and the map keeps both. That is a first-hand ' +
        'check by the person who operates the fleet here; it is not a georeferenced survey, and ' +
        'nothing claims one.'
    );
  } else if (dataset) {
    parts.push(
      'NOBODY HAS CHECKED THIS CAMPUS AGAINST THE PHYSICAL SITE: every feature is NOT_VERIFIED. ' +
        'The geometry is real, community-mapped open data, and being in OpenStreetMap is not a ' +
        'verification — the map does not upgrade one into the other.'
    );
  }

  const buildings = features.filter((f) => f.kind === CAMPUS_FEATURE_KIND.BUILDING);
  const measured = countBy(buildings, (f) => typeof f.height === 'number');
  const withLevels = countBy(buildings, (f) => typeof f.levels === 'number');
  if (buildings.length > 0 && measured === 0) {
    parts.push(
      'Still outstanding: no feature carries a MEASURED height — the extract has no height tag ' +
        `anywhere — so building volumes are drawn from building:levels where present (${withLevels} ` +
        `of ${buildings.length} buildings) and from a conservative rendering default otherwise. ` +
        'No drawn height is a measurement and none is presented as one.'
    );
  } else if (buildings.length > 0) {
    parts.push(
      `${measured} of ${buildings.length} buildings carry a MEASURED height from the source; the ` +
        'rest are drawn from building:levels or from a rendering default.'
    );
  }

  const points = countBy(features, (f) => f.geometryRole === 'POINT_LOCATION');
  if (points > 0) {
    parts.push(
      `The ${points} supplied point locations remain point locations: their position is recorded, ` +
        'their shape and extent are not.'
    );
  }

  const gates = countBy(features, (f) => f.kind === CAMPUS_FEATURE_KIND.GATE);
  parts.push(
    gates > 0
      ? `Every gate access rule is explicitly UNKNOWN — a recorded location is not a recorded ` +
        'access policy, and a route planned through a gate closed to vehicles is a route that ' +
        'does not exist.'
      : 'No dataset here maps a gate, entrance or barrier, so how a fleet gets on and off this ' +
        'site is UNKNOWN.'
  );

  const outside = dataset?.outsideBoundary?.length || 0;
  if (outside > 0) {
    parts.push(
      `${outside} imported ${outside === 1 ? 'feature lies' : 'features lie'} OUTSIDE the campus ` +
        'boundary — an Overpass query is a bounding box, not a campus. They are real, ' +
        'correctly-attributed geometry, so they are drawn and reported as outside rather than ' +
        'deleted.'
    );
  }

  parts.push('Anything the sources do not map is still missing, and is still reported as missing.');

  return parts.join(' ');
}

// ── What each campus is still waiting on (§46) ───────────────────────────────

const REQUEST_FORMAT = 'GeoJSON, WGS84 (EPSG:4326), lon/lat order';

const ACCEPTABLE_SOURCES = Object.freeze([
  'An institutional site plan or campus survey, georeferenced.',
  'A GNSS/RTK walk-around of the site.',
  'Any dataset the project has an explicit licence to redistribute.',
]);

const NOT_ACCEPTABLE = Object.freeze([
  'Coordinates estimated from a satellite image by eye.',
  'Footprints generated from the centre point and a guessed radius.',
  'Building identities inferred from position ("this one is probably CSE").',
  'A drawn extrusion height reported to an operator as a building height.',
]);

/**
 * The outstanding data request for one campus, derived from its actual import.
 *
 * Generated for the same reason the notes are: a hand-maintained gap list is a
 * gap list that goes stale silently, and a stale one reads as "we have
 * everything" long before anybody notices. Each artefact below appears only
 * while the campus genuinely lacks it.
 */
export function missingGeometryRequestFor(code) {
  const key = String(code || '').trim();
  const entry = REGISTERED_CAMPUSES.find((e) => e.id === key) || null;
  const built = CAMPUS_GEOMETRY[key] || null;
  if (!entry || !built) return null;

  const features = built.features;
  const record = campusVerificationFor(key);
  const buildings = features.filter((f) => f.kind === CAMPUS_FEATURE_KIND.BUILDING);
  const withLevels = countBy(buildings, (f) => typeof f.levels === 'number');
  const gates = countBy(features, (f) => f.kind === CAMPUS_FEATURE_KIND.GATE);
  const points = countBy(features, (f) => f.geometryRole === 'POINT_LOCATION');
  const docks = countBy(
    features,
    (f) =>
      f.operationalRole === OPERATIONAL_ROLE.DOCKING_STATION ||
      f.operationalRole === OPERATIONAL_ROLE.CHARGING_POINT
  );

  const artefacts = [];

  if (countBy(buildings, (f) => typeof f.height === 'number') === 0) {
    artefacts.push(
      'Measured building heights — metres per footprint. NOT PRESENT: the extract carries no ' +
        `height tag on any feature. ${withLevels} buildings carry building:levels, from which a ` +
        'DRAWN height is derived for rendering only; the rest are drawn at a default. No drawn ' +
        'height is a measurement and none is presented as one. Confirming where a building is ' +
        'does not measure how tall it is.'
    );
  }

  artefacts.push(
    gates > 0
      ? 'Gate access rules — vehicle / pedestrian / service / emergency, and opening status. The ' +
        'campus model carries all four channels as first-class fields and every one of them is ' +
        'explicitly UNKNOWN, because no source records them. A route planned through a gate ' +
        'closed to vehicles is a route that does not exist, so this is the highest-value ' +
        'outstanding record on this list.'
      : 'Gate and entrance locations, and their access rules — vehicle / pedestrian / service / ' +
        'emergency. NOT PRESENT: no dataset here maps a gate, barrier or entrance anywhere on ' +
        'this site, so where a fleet may enter it is unknown, and no gate access rule can be ' +
        'stated for a gate that has no recorded position.'
  );

  if (docks === 0) {
    artefacts.push(
      'Robot charging points and docking stations — Points, named. NOT PRESENT in any dataset ' +
        'for this campus. The operational vocabulary declares both roles and NOTHING claims ' +
        'either; no parking apron has been quietly reinterpreted as a dock.'
    );
  }

  artefacts.push(
    record
      ? 'A georeferenced site plan or GNSS walk-around — the only thing that would move these ' +
        'features from VERIFIED_BY_USER to VERIFIED, and the only thing that would put a ' +
        'positional tolerance on the imported vertices.'
      : 'A first-hand check of this campus, and then a georeferenced site plan or GNSS ' +
        'walk-around. Nobody has confirmed a single feature here against the physical site, so ' +
        'every one of them is NOT_VERIFIED.'
  );

  if (points > 0) {
    artefacts.push(
      `Footprints for the ${points} supplied point locations, which remain POINT_LOCATION: their ` +
        'position is recorded, their shape and extent are still unknown.'
    );
  }

  artefacts.push(
    'Interior / operational detail — floors, rooms, door positions, loading points, keep-out ' +
      "zones. Outside OpenStreetMap's scope and absent here."
  );

  return Object.freeze({
    campus: `${entry.id} — ${entry.name}`,
    format: REQUEST_FORMAT,
    suppliedBy: Object.freeze({
      dataset: built.dataset?.file || null,
      origin: built.dataset?.origin || null,
      licence: built.dataset?.licence || null,
      verification: record
        ? 'VERIFIED_BY_USER — community-mapped open data, confirmed against the site by the ' +
          'project owner. A first-hand check, not a georeferenced survey of this campus.'
        : 'NOT_VERIFIED — community-mapped open data. Nobody has checked it against this ' +
          'campus, and being present in OpenStreetMap is not a georeferenced survey.',
    }),
    artefacts: Object.freeze(artefacts),
    perFeatureMetadata: Object.freeze(['provenance', 'source', 'verification', 'verifiedOn']),
    acceptableSources: ACCEPTABLE_SOURCES,
    notAcceptable: NOT_ACCEPTABLE,
  });
}

// ── The built registry ───────────────────────────────────────────────────────

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
export const CAMPUS_GEOMETRY = Object.freeze(
  Object.fromEntries(REGISTERED_CAMPUSES.map((entry) => [entry.id, buildCampus(entry)]))
);

/**
 * The campus metadata — everything ABOUT a campus that is not its geometry.
 *
 * Deliberately separate from `CAMPUS_GEOMETRY` and deliberately tiny: this is
 * what the location hierarchy and the search index consume, so listing campuses
 * or searching for one by name never touches a single coordinate. At 100
 * campuses that is the difference between a search box and a stall (§30).
 */
export const CAMPUS_REGISTRY = Object.freeze(
  REGISTERED_CAMPUSES.map((entry) =>
    Object.freeze({
      id: entry.id,
      name: entry.name,
      country: entry.country,
      state: entry.state,
      city: entry.city,
      aliases: entry.aliases,
      hasCampusGeometry: CAMPUS_GEOMETRY[entry.id].features.length > 0,
    })
  )
);

/** The metadata for a campus code, or null. */
export function campusRegistryEntry(code) {
  const key = String(code || '').trim();
  return CAMPUS_REGISTRY.find((e) => e.id === key) || null;
}

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
  //
  // With two campuses this check also catches the new failure mode multi-campus
  // creates: a registry entry wired to the wrong campus's dataset. Geometry from
  // the wrong site would load, validate and render perfectly, 4 km from the
  // centre the database holds — and this is the assertion that notices.
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
    // Who checked this campus and what that covers (§3A), and which of its
    // features the fleet actually operates on (§3C). Both are derived at import
    // time; a consumer never recomputes either.
    verification: entry?.verification || null,
    verificationRecord: campusVerificationFor(code),
    operational: entry?.operational || null,
    registry: campusRegistryEntry(code),
    centreWithinBoundary,
    missingGeometry: validated.coverage.missing,
    missingArtefacts: missingGeometryRequestFor(code),
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
  ownerVerifiedCount: 0,
  notes: 'No campus selected.',
  hasCampusGeometry: false,
  geometrySource: null,
  dataset: null,
  supplemental: null,
  verification: null,
  verificationRecord: null,
  operational: null,
  registry: null,
  centreWithinBoundary: null,
  missingGeometry: Object.freeze([]),
  missingArtefacts: null,
});
