/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CAMPUS GEOGRAPHY CONTRACT — what a campus IS, and where each fact came from
 *
 * This module defines the shape of authoritative campus geography and the
 * rules that decide whether a candidate definition may be rendered. It does
 * NOT contain any campus geometry. Geometry lives in `campusRegistry.js`, and
 * for RNSIT it is currently empty — see that file, and §"Data coverage" below.
 *
 *   CampusDefinition
 *       ├── code / name              ← from the Campus DB record
 *       ├── center                   ← from Campus.centerLat / centerLon
 *       └── features[]               ← boundary · buildings · roads · paths
 *                                      gates · landmarks · facilities
 *
 * ── The rule this module exists to enforce ────────────────────────────────
 * Every feature must declare WHERE IT CAME FROM and WHETHER IT WAS VERIFIED.
 * A feature with no provenance is rejected, not rendered with a shrug. That
 * makes "we do not have RNSIT building footprints" a value the system carries
 * and the UI can state, rather than a gap that quietly gets filled with
 * plausible-looking rectangles.
 *
 *      provenance : where the coordinates came from
 *      verification : whether anyone checked them against the real place
 *
 * Those are independent. A seeded campus centre has a real provenance
 * (a DB record) and is still NOT_VERIFIED, because nobody in this repository
 * has confirmed the coordinate against a survey. Both facts are reported.
 *
 * ── Deliberately absent ───────────────────────────────────────────────────
 * Any default geometry, any "approximate" fallback footprint, any generated
 * boundary derived from a centre point and a guessed radius. A definition with
 * no buildings renders no buildings.
 *
 * Pure module: no React, no Mapbox, no `@/` alias — loadable under plain Node
 * by the architecture tests.
 * ═══════════════════════════════════════════════════════════════════════════
 */

// ── Vocabulary ───────────────────────────────────────────────────────────────

/** What kind of thing a campus feature is. Drives geometry rules and styling. */
export const CAMPUS_FEATURE_KIND = Object.freeze({
  CAMPUS_CENTER: 'CAMPUS_CENTER',
  BOUNDARY: 'BOUNDARY',
  BUILDING: 'BUILDING',
  ROAD: 'ROAD',
  PATH: 'PATH',
  GATE: 'GATE',
  LANDMARK: 'LANDMARK',
  FACILITY: 'FACILITY',
  OPERATIONAL_POINT: 'OPERATIONAL_POINT',
});

/**
 * Semantic classification (§30). Used for a restrained per-category palette —
 * "these are different building types", never "every building is a new colour".
 */
export const CAMPUS_CATEGORY = Object.freeze({
  ACADEMIC: 'ACADEMIC',
  ADMINISTRATIVE: 'ADMINISTRATIVE',
  RESIDENTIAL: 'RESIDENTIAL',
  SPORTS: 'SPORTS',
  UTILITY: 'UTILITY',
  COMMERCIAL: 'COMMERCIAL',
  /** Added for the RNSIT import: the dataset carries `amenity=place_of_worship`. */
  RELIGIOUS: 'RELIGIOUS',
  CIRCULATION: 'CIRCULATION',
  ACCESS: 'ACCESS',
  OPERATIONAL: 'OPERATIONAL',
  UNCLASSIFIED: 'UNCLASSIFIED',
});

/** Road hierarchy (§12). Four classes, visually separated by width and treatment. */
export const ROAD_CLASS = Object.freeze({
  MAIN: 'main',
  SECONDARY: 'secondary',
  PATH: 'path',
  SERVICE: 'service',
});

/**
 * Path treatment. A flight of steps is not a footpath a robot can drive, and a
 * map that draws them identically is hiding that from an operator reading a
 * route. Both remain kind PATH; only the rendering differs.
 */
export const PATH_CLASS = Object.freeze({
  FOOTWAY: 'footway',
  STEPS: 'steps',
});

/**
 * How completely a feature's geometry describes the thing it stands for.
 *
 * This is the upgrade path, made explicit. A campus feature's IDENTITY is its
 * `id`; its geometry is a separate, replaceable fact about it. So a location
 * known today only as a point can gain a real footprint later without becoming
 * a different feature — its label, its search entry, its selection state and
 * any operational reference to it all survive the upgrade.
 *
 *   POINT_LOCATION   we know WHERE it is, not what shape it is
 *   AREA             a real extent, but not a building footprint (a ground)
 *   FOOTPRINT        a building outline, extrudable
 *
 * The rule this encodes: a POINT_LOCATION is never drawn as though it were a
 * footprint. No rectangle is invented around it, no volume is extruded from it.
 */
export const GEOMETRY_ROLE = Object.freeze({
  POINT_LOCATION: 'POINT_LOCATION',
  AREA: 'AREA',
  FOOTPRINT: 'FOOTPRINT',
});

/** The geometry types each role may legitimately carry. */
const GEOMETRY_FOR_ROLE = Object.freeze({
  POINT_LOCATION: ['Point'],
  AREA: ['Polygon', 'MultiPolygon'],
  FOOTPRINT: ['Polygon', 'MultiPolygon'],
});

/**
 * Where a coordinate came from. This is the field that makes the difference
 * between a digital twin and a decoration.
 */
export const PROVENANCE = Object.freeze({
  /** Measured on the ground / from an authoritative survey or site plan. */
  SURVEYED: 'SURVEYED',
  /** A record in this repository's own database (e.g. Campus.centerLat). */
  SEED_RECORD: 'SEED_RECORD',
  /** A live operational record — a task's pickup/drop, a robot's telemetry. */
  OPERATIONAL_RECORD: 'OPERATIONAL_RECORD',
  /** The basemap vendor's data (OpenStreetMap via Mapbox). Context, not survey. */
  VENDOR_BASEMAP: 'VENDOR_BASEMAP',
  /**
   * A third-party open dataset imported into this repository as a file — for
   * RNSIT, an OpenStreetMap extract (`campus/data/rnsit-campus-osm.geojson`).
   *
   * Distinct from VENDOR_BASEMAP on purpose. That is geometry the basemap draws
   * for us and we can only read back; this is geometry WE hold, render and are
   * responsible for. It is real, community-surveyed data and it is still not a
   * survey of this campus, so it is NOT_VERIFIED like everything else here —
   * the `source` string must name the dataset and the element id within it.
   */
  OPEN_DATA_IMPORT: 'OPEN_DATA_IMPORT',
  /**
   * A location supplied by a person operating this system — someone who knows
   * the campus, pointing at where a thing is.
   *
   * Genuinely useful: it fills gaps no open dataset covers (this campus's main
   * gate, its playgrounds, its newer departments). It is also the WEAKEST
   * provenance in this list, because local knowledge is the one input with no
   * external record behind it at all. It is never VERIFIED on its own say-so —
   * a person supplying a coordinate is supplying a claim, not a measurement.
   */
  USER_SUPPLIED: 'USER_SUPPLIED',
});

export const VERIFICATION = Object.freeze({
  VERIFIED: 'VERIFIED',
  NOT_VERIFIED: 'NOT_VERIFIED',
});

// ── Label hierarchy (§9) ─────────────────────────────────────────────────────
//
// Three bands, so a campus overview does not carry every entrance label. The
// numbers are the zoom at which a priority becomes eligible to draw; Mapbox's
// own collision detection then thins whatever survives.

export const LABEL_PRIORITY = Object.freeze({
  /** Campus name, major landmarks, main gates — visible from the campus overview. */
  PRIMARY: 1,
  /** Departments, facilities, grounds — visible once buildings are resolvable. */
  SECONDARY: 2,
  /** Individual rooms, entrances, operational points — close inspection only. */
  DETAIL: 3,
});

const LABEL_MIN_ZOOM = Object.freeze({ 1: 13.5, 2: 15.5, 3: 17 });

/** Lowest zoom at which a label of this priority may draw. */
export function labelMinZoomFor(priority) {
  const p = Number(priority);
  return LABEL_MIN_ZOOM[p] ?? LABEL_MIN_ZOOM[LABEL_PRIORITY.DETAIL];
}

/** Would a label of this priority be eligible to draw at this zoom? */
export function isLabelVisibleAtZoom(priority, zoom) {
  const z = typeof zoom === 'number' && Number.isFinite(zoom) ? zoom : -Infinity;
  return z >= labelMinZoomFor(priority);
}

// ── Geometry rules ───────────────────────────────────────────────────────────

const GEOMETRY_FOR_KIND = Object.freeze({
  CAMPUS_CENTER: ['Point'],
  BOUNDARY: ['Polygon', 'MultiPolygon'],
  BUILDING: ['Polygon', 'MultiPolygon'],
  ROAD: ['LineString', 'MultiLineString'],
  PATH: ['LineString', 'MultiLineString'],
  GATE: ['Point'],
  LANDMARK: ['Point', 'Polygon', 'MultiPolygon'],
  FACILITY: ['Point', 'Polygon', 'MultiPolygon'],
  OPERATIONAL_POINT: ['Point'],
});

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/** A single `[lon, lat]` position, in range and finite. */
function positionErrors(pos, where) {
  if (!Array.isArray(pos) || pos.length < 2) return [`${where}: position must be [lon, lat]`];
  const [lon, lat] = pos;
  const errs = [];
  if (!isFiniteNumber(lon) || lon < -180 || lon > 180) errs.push(`${where}: longitude ${lon} out of range`);
  if (!isFiniteNumber(lat) || lat < -90 || lat > 90) errs.push(`${where}: latitude ${lat} out of range`);
  return errs;
}

function ringErrors(ring, where) {
  if (!Array.isArray(ring) || ring.length < 4) {
    return [`${where}: a polygon ring needs at least 4 positions`];
  }
  const errs = [];
  ring.forEach((pos, i) => errs.push(...positionErrors(pos, `${where}[${i}]`)));
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (Array.isArray(first) && Array.isArray(last) && (first[0] !== last[0] || first[1] !== last[1])) {
    errs.push(`${where}: polygon ring is not closed (first position must equal last)`);
  }
  return errs;
}

/**
 * Validate a GeoJSON geometry object structurally and numerically.
 * Returns an array of human-readable errors — empty means valid.
 */
export function geometryErrors(geometry, where = 'geometry') {
  const type = geometry?.type;
  const coords = geometry?.coordinates;

  switch (type) {
    case 'Point':
      return positionErrors(coords, where);
    case 'LineString': {
      if (!Array.isArray(coords) || coords.length < 2) return [`${where}: LineString needs at least 2 positions`];
      return coords.flatMap((p, i) => positionErrors(p, `${where}[${i}]`));
    }
    case 'MultiLineString': {
      if (!Array.isArray(coords) || coords.length < 1) return [`${where}: MultiLineString needs at least 1 line`];
      return coords.flatMap((line, i) =>
        !Array.isArray(line) || line.length < 2
          ? [`${where}[${i}]: LineString needs at least 2 positions`]
          : line.flatMap((p, j) => positionErrors(p, `${where}[${i}][${j}]`))
      );
    }
    case 'Polygon': {
      if (!Array.isArray(coords) || coords.length < 1) return [`${where}: Polygon needs at least 1 ring`];
      return coords.flatMap((ring, i) => ringErrors(ring, `${where}[${i}]`));
    }
    case 'MultiPolygon': {
      if (!Array.isArray(coords) || coords.length < 1) return [`${where}: MultiPolygon needs at least 1 polygon`];
      return coords.flatMap((poly, i) =>
        !Array.isArray(poly) || poly.length < 1
          ? [`${where}[${i}]: Polygon needs at least 1 ring`]
          : poly.flatMap((ring, j) => ringErrors(ring, `${where}[${i}][${j}]`))
      );
    }
    default:
      return [`${where}: unsupported geometry type ${JSON.stringify(type)}`];
  }
}

// ── Feature validation ───────────────────────────────────────────────────────

/**
 * Validate one campus feature.
 *
 * @returns {string[]} errors; empty means the feature may be rendered.
 */
export function validateCampusFeature(feature, where = 'feature') {
  const errs = [];
  const id = typeof feature?.id === 'string' ? feature.id.trim() : '';
  if (!id) errs.push(`${where}: id is required`);

  const label = `${where}${id ? `(${id})` : ''}`;

  if (typeof feature?.name !== 'string' || !feature.name.trim()) {
    errs.push(`${label}: name is required`);
  }

  const kind = feature?.kind;
  const allowed = GEOMETRY_FOR_KIND[kind];
  if (!allowed) {
    errs.push(`${label}: unknown kind ${JSON.stringify(kind)}`);
  }

  if (feature?.category !== undefined && !CAMPUS_CATEGORY[feature.category]) {
    errs.push(`${label}: unknown category ${JSON.stringify(feature.category)}`);
  }

  if (feature?.roadClass !== undefined && !Object.values(ROAD_CLASS).includes(feature.roadClass)) {
    errs.push(`${label}: unknown roadClass ${JSON.stringify(feature.roadClass)}`);
  }

  if (feature?.pathClass !== undefined && !Object.values(PATH_CLASS).includes(feature.pathClass)) {
    errs.push(`${label}: unknown pathClass ${JSON.stringify(feature.pathClass)}`);
  }

  if (feature?.labelPriority !== undefined && ![1, 2, 3].includes(Number(feature.labelPriority))) {
    errs.push(`${label}: labelPriority must be 1, 2 or 3`);
  }

  // ── height vs renderHeight (§38) ──────────────────────────────────────────
  // `height` is a CLAIM ABOUT THE WORLD: this building is this many metres
  // tall, and the source said so. `renderHeight` is a CLAIM ABOUT THE PICTURE:
  // draw the box this tall. They are validated separately and neither implies
  // the other, so a dataset with no heights (which is RNSIT's situation — the
  // OSM extract carries `building:levels` and no `height` anywhere) can still
  // produce a three-dimensional campus without the map asserting a measurement
  // nobody took.
  if (feature?.height !== undefined && (!isFiniteNumber(feature.height) || feature.height <= 0)) {
    errs.push(`${label}: height must be a positive number of metres when present`);
  }

  if (feature?.renderHeight !== undefined && (!isFiniteNumber(feature.renderHeight) || feature.renderHeight <= 0)) {
    errs.push(`${label}: renderHeight must be a positive number of metres when present`);
  }

  // A drawn height with no stated basis is exactly the ambiguity this pair of
  // fields exists to remove — the UI would have nothing honest to caption it.
  if (feature?.renderHeight !== undefined && (typeof feature?.heightBasis !== 'string' || !feature.heightBasis.trim())) {
    errs.push(`${label}: renderHeight requires heightBasis — say what the drawn height was derived from`);
  }

  if (feature?.levels !== undefined && (!isFiniteNumber(feature.levels) || feature.levels <= 0)) {
    errs.push(`${label}: levels must be a positive number when present`);
  }

  if (feature?.labelled !== undefined && typeof feature.labelled !== 'boolean') {
    errs.push(`${label}: labelled must be a boolean when present`);
  }

  // ── geometryRole (§23 upgradeability) ────────────────────────────────────
  // A role that disagrees with the geometry is the failure this check exists
  // for: a feature claiming FOOTPRINT while carrying a Point would be asking
  // the extrusion layer for a volume there is no outline for, and a feature
  // claiming POINT_LOCATION while carrying a polygon has already been upgraded
  // without anyone updating the record that says so.
  if (feature?.geometryRole !== undefined) {
    const allowedForRole = GEOMETRY_FOR_ROLE[feature.geometryRole];
    if (!allowedForRole) {
      errs.push(`${label}: unknown geometryRole ${JSON.stringify(feature.geometryRole)}`);
    } else if (feature?.geometry?.type && !allowedForRole.includes(feature.geometry.type)) {
      errs.push(
        `${label}: geometryRole ${feature.geometryRole} requires ${allowedForRole.join(' | ')}, got ${feature.geometry.type}`
      );
    }
  }

  // A point location has no extent, so it has nothing to extrude. Letting one
  // carry a render height is how an invented volume would get onto the map.
  if (feature?.geometryRole === GEOMETRY_ROLE.POINT_LOCATION && feature?.renderHeight !== undefined) {
    errs.push(`${label}: a POINT_LOCATION has no footprint to extrude — remove renderHeight`);
  }

  if (feature?.coLocatedWith !== undefined) {
    if (typeof feature.coLocatedWith !== 'string' || !feature.coLocatedWith.trim()) {
      errs.push(`${label}: coLocatedWith must name another feature's id when present`);
    } else if (feature.coLocatedWith.trim() === id) {
      errs.push(`${label}: coLocatedWith cannot point at itself`);
    }
  }

  // ── Provenance is mandatory. This is the rule that keeps invented geometry
  // out: there is no way to add a feature without saying where it came from.
  if (!PROVENANCE[feature?.provenance]) {
    errs.push(`${label}: provenance is required (one of ${Object.keys(PROVENANCE).join(', ')})`);
  }
  if (!VERIFICATION[feature?.verification]) {
    errs.push(`${label}: verification is required (VERIFIED or NOT_VERIFIED)`);
  }
  if (typeof feature?.source !== 'string' || !feature.source.trim()) {
    errs.push(`${label}: source is required — name the record, dataset or survey`);
  }
  // Claiming VERIFIED without saying who checked it and when is exactly the
  // failure mode this contract exists to prevent.
  if (feature?.verification === VERIFICATION.VERIFIED) {
    if (typeof feature?.verifiedOn !== 'string' || !feature.verifiedOn.trim()) {
      errs.push(`${label}: VERIFIED requires verifiedOn (ISO date of the check)`);
    }
  }

  const geomErrs = geometryErrors(feature?.geometry, `${label}.geometry`);
  errs.push(...geomErrs);

  if (allowed && geomErrs.length === 0 && !allowed.includes(feature.geometry.type)) {
    errs.push(`${label}: kind ${kind} requires geometry of ${allowed.join(' | ')}, got ${feature.geometry.type}`);
  }

  return errs;
}

// ── Data coverage ────────────────────────────────────────────────────────────
//
// The capabilities a campus needs before the map can claim to represent it.
// Anything absent is reported as MISSING AUTHORITATIVE GEOMETRY (§46) rather
// than substituted.

export const CAMPUS_GEOMETRY_CAPABILITIES = Object.freeze([
  Object.freeze({ id: 'boundary', kind: CAMPUS_FEATURE_KIND.BOUNDARY, label: 'Campus boundary' }),
  Object.freeze({ id: 'buildings', kind: CAMPUS_FEATURE_KIND.BUILDING, label: 'Building footprints' }),
  Object.freeze({ id: 'roads', kind: CAMPUS_FEATURE_KIND.ROAD, label: 'Campus roads' }),
  Object.freeze({ id: 'paths', kind: CAMPUS_FEATURE_KIND.PATH, label: 'Pedestrian paths' }),
  Object.freeze({ id: 'gates', kind: CAMPUS_FEATURE_KIND.GATE, label: 'Gates / entrances' }),
  Object.freeze({ id: 'landmarks', kind: CAMPUS_FEATURE_KIND.LANDMARK, label: 'Landmarks' }),
  Object.freeze({ id: 'facilities', kind: CAMPUS_FEATURE_KIND.FACILITY, label: 'Facilities' }),
]);

/**
 * Which capabilities this definition actually supplies, and which it does not.
 * Consumed by the UI so an operator is told what the map does not know.
 */
export function describeCampusCoverage(definition) {
  const features = Array.isArray(definition?.features) ? definition.features : [];
  const present = [];
  const missing = [];

  for (const cap of CAMPUS_GEOMETRY_CAPABILITIES) {
    const matches = features.filter((f) => f?.kind === cap.kind);
    if (matches.length > 0) {
      present.push({
        ...cap,
        count: matches.length,
        verified: matches.filter((f) => f?.verification === VERIFICATION.VERIFIED).length,
      });
    } else {
      missing.push({ ...cap, count: 0, verified: 0 });
    }
  }

  return { present, missing };
}

// ── Definition validation ────────────────────────────────────────────────────

/**
 * Validate a whole CampusDefinition.
 *
 * Invalid features are REJECTED — returned in `errors` and excluded from
 * `features` — rather than rendered with best effort. Half-valid geometry on a
 * map an operator navigates by is worse than absent geometry.
 *
 * @returns {{
 *   ok: boolean,
 *   code: string|null,
 *   name: string|null,
 *   center: {lon:number, lat:number}|null,
 *   features: object[],      // only the features that passed
 *   rejected: object[],      // { id, errors } for the ones that did not
 *   errors: string[],
 *   coverage: { present: object[], missing: object[] },
 *   verifiedCount: number,
 * }}
 */
export function validateCampusDefinition(definition) {
  const errors = [];
  const code = typeof definition?.code === 'string' && definition.code.trim() ? definition.code.trim() : null;
  const name = typeof definition?.name === 'string' && definition.name.trim() ? definition.name.trim() : null;

  if (!code) errors.push('definition: code is required');
  if (!name) errors.push('definition: name is required');

  let center = null;
  const rawCenter = definition?.center;
  if (rawCenter) {
    const centerErrs = positionErrors([rawCenter.lon, rawCenter.lat], 'definition.center');
    if (centerErrs.length) errors.push(...centerErrs);
    else center = { lon: rawCenter.lon, lat: rawCenter.lat };
  }

  const accepted = [];
  const rejected = [];
  const seenIds = new Set();

  for (const [i, feature] of (Array.isArray(definition?.features) ? definition.features : []).entries()) {
    const featureErrs = validateCampusFeature(feature, `features[${i}]`);

    const id = typeof feature?.id === 'string' ? feature.id.trim() : '';
    if (id && seenIds.has(id)) featureErrs.push(`features[${i}](${id}): duplicate feature id`);
    if (id) seenIds.add(id);

    if (featureErrs.length) {
      rejected.push({ id: id || `features[${i}]`, errors: featureErrs });
      errors.push(...featureErrs);
    } else {
      accepted.push(feature);
    }
  }

  return {
    ok: errors.length === 0,
    code,
    name,
    center,
    features: accepted,
    rejected,
    errors,
    coverage: describeCampusCoverage({ features: accepted }),
    verifiedCount: accepted.filter((f) => f.verification === VERIFICATION.VERIFIED).length,
  };
}
