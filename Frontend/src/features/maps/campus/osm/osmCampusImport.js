/**
 * ═══════════════════════════════════════════════════════════════════════════
 * OSM CAMPUS IMPORT — OpenStreetMap tags become RobotX campus features
 *
 *      OSM feature (tags + geometry)
 *              │
 *              ▼
 *      classifyOsmFeature()          ← this module: ONE declarative rule set
 *              │
 *      RobotX campus feature         ← campusSchema.js validates it
 *              │
 *              ▼
 *      Mapbox layers                 ← campusLayers.js renders it
 *
 * ── What this module is for (§40, §33) ────────────────────────────────────
 * So that no rendering code ever asks `if (name === 'CSE')`. Every decision
 * about what a feature IS lives here, as data, in one place, and every
 * decision records WHY it was made. The renderer downstream is told a kind, a
 * category and a render height; it is never told an OSM tag.
 *
 * ── What this module refuses to do (§4) ───────────────────────────────────
 * It never creates geometry. Not a footprint, not a boundary, not a road, not
 * a landmark, not a coordinate. Every coordinate it emits was read out of the
 * source file unchanged — asserted in `__architecture__/campusOsmImport.test.mjs`
 * by comparing emitted geometry against the raw export, position by position.
 *
 * It also never invents identity. A building with no `name` tag stays unnamed;
 * it is given a DESCRIPTIVE label derived from its own tags ("Unnamed
 * building"), flagged `nameIsDescriptive`, and excluded from map labelling
 * entirely, rather than being guessed at from its size or position.
 *
 * ── Provenance (§3, §34) ──────────────────────────────────────────────────
 * Every emitted feature carries `provenance: OPEN_DATA_IMPORT`,
 * `verification: NOT_VERIFIED`, the OSM element id, and its complete original
 * tag set in `sourceTags`. Nothing here is surveyed, and nothing here claims
 * to be. The day an RNSIT site survey arrives it becomes a second importer
 * emitting the same feature shape with `provenance: SURVEYED` — the renderer
 * does not change (§64).
 *
 * ── Heights (§8, §38, §39) ────────────────────────────────────────────────
 * This dataset contains NO `height` tag on any feature. It contains
 * `building:levels` on seven. So:
 *
 *      actualHeight   real, measured, from an OSM `height` tag   → null here
 *      renderHeight   how tall to draw the box                   → derived
 *
 * They are separate fields on purpose. `renderHeight` is a rendering decision
 * and is presented as one; it is never shown to an operator as a building's
 * height. See `deriveRenderHeight` for the exact policy.
 *
 * Pure module: no React, no Mapbox, no `@/` alias — loadable under plain Node.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import {
  CAMPUS_CATEGORY,
  CAMPUS_FEATURE_KIND,
  LABEL_PRIORITY,
  PROVENANCE,
  ROAD_CLASS,
  PATH_CLASS,
  VERIFICATION,
} from '../campusSchema.js';

// ── The dataset ──────────────────────────────────────────────────────────────

/**
 * What is TRUE OF EVERY OVERPASS EXTRACT, whichever campus it describes.
 *
 * The origin, the licence and the coordinate system are properties of the
 * SOURCE KIND, not of a campus. The one thing that varies per campus is which
 * file the features were read out of, so that is the only thing `osmDataset`
 * takes — and it is supplied by the registry entry, never by this module.
 *
 * Before this was parameterised, `OSM_DATASET.file` named RNSIT's export as a
 * module constant, which meant the shared importer knew the name of one
 * campus's artefact. A second campus importing through it would have carried
 * RNSIT's filename in its provenance string: the first thing that quietly stops
 * being true when a single-campus map becomes a multi-campus one (§34).
 */
export const OSM_DATASET_ORIGIN = 'OpenStreetMap, exported via Overpass Turbo';
export const OSM_DATASET_LICENCE = '© OpenStreetMap contributors, ODbL';
export const OSM_DATASET_CRS =
  'WGS84 (EPSG:4326), lon/lat order — GeoJSON default, verified against the export';

/**
 * Identifies the artefact a campus's features came from. Copied onto every
 * feature's `source` string, so a feature separated from its collection still
 * says which file, of which campus, it was read out of.
 *
 * @param {string|null} file  the campus's own export, e.g. `rnsit-campus-osm.geojson`
 */
export function osmDataset(file) {
  return Object.freeze({
    file: typeof file === 'string' && file.trim() ? file.trim() : null,
    origin: OSM_DATASET_ORIGIN,
    licence: OSM_DATASET_LICENCE,
    crs: OSM_DATASET_CRS,
  });
}

/**
 * The generic descriptor: a real OpenStreetMap extract that has not said which
 * file it is. Used when a caller imports a collection directly (a test, a
 * one-off inspection) rather than through a registered campus.
 */
export const OSM_DATASET = osmDataset(null);

/** The `source` string every imported feature carries. */
export function osmSourceString(osmId, dataset = OSM_DATASET) {
  const ds = dataset || OSM_DATASET;
  const file = ds.file ? ` — ${ds.file}` : '';
  return `${ds.origin}${file} (${osmId}). ${ds.licence}. Not a survey.`;
}

// ── Render-height policy (§8, §38, §39) ──────────────────────────────────────

export const RENDER_HEIGHT = Object.freeze({
  /**
   * Metres per building level, used ONLY to turn an OSM `building:levels` count
   * into something to draw. A conservative Indian institutional floor-to-floor.
   * It is an assumption about drawing, not a measurement of any building.
   */
  METRES_PER_LEVEL: 3.5,
  /**
   * A building with neither a height nor a level count. Roughly two storeys —
   * low enough that a wrong guess is a small wrong guess (§39: the campus
   * should look like a campus, not a skyline).
   */
  FALLBACK: 7,
  /**
   * Guard for tiny footprints. A 26 m² ATM kiosk extruded to the 7 m fallback
   * renders as a pillar, which reads as a real, tall, thin building — a visual
   * claim the data does not support. Where a footprint is small enough that the
   * fallback would exceed this multiple of its own width, the drawn height is
   * reduced to it. Applies only to the FALLBACK; a recorded level count is
   * always honoured as-is.
   */
  SMALL_FOOTPRINT_FACTOR: 0.9,
});

export const HEIGHT_BASIS = Object.freeze({
  /** An OSM `height` tag in metres. Real, if unverified. */
  OSM_HEIGHT_TAG: 'OSM_HEIGHT_TAG',
  /** `building:levels` × METRES_PER_LEVEL. A rendering estimate. */
  OSM_LEVELS: 'OSM_LEVELS',
  /** Neither present. A rendering default. */
  FALLBACK: 'FALLBACK',
  /** Small-footprint guard applied on top of FALLBACK. */
  FALLBACK_CLAMPED: 'FALLBACK_CLAMPED',
});

/** Human sentence for a basis, shown in the details card so the drawn height is never mistaken for data. */
export const HEIGHT_BASIS_NOTE = Object.freeze({
  OSM_HEIGHT_TAG: 'from the OpenStreetMap height tag (unverified)',
  OSM_LEVELS: `estimated for rendering from building:levels × ${RENDER_HEIGHT.METRES_PER_LEVEL} m — not a measured height`,
  FALLBACK: 'rendering default — this building has no height or level data in the source',
  FALLBACK_CLAMPED:
    'rendering default, reduced to suit a very small footprint — this building has no height or level data in the source',
});

// ── Tag → semantics ──────────────────────────────────────────────────────────
//
// Everything below is DATA. Adding a tag the map should understand is adding a
// row here; it is never a new branch in a component.

/** `amenity` / `leisure` / `historic` values that are places in their own right. */
const AMENITY_RULES = Object.freeze({
  place_of_worship: { kind: CAMPUS_FEATURE_KIND.LANDMARK, category: CAMPUS_CATEGORY.RELIGIOUS, major: true },
  conference_centre: { kind: CAMPUS_FEATURE_KIND.FACILITY, category: CAMPUS_CATEGORY.ADMINISTRATIVE, major: true },
  theatre: { kind: CAMPUS_FEATURE_KIND.FACILITY, category: CAMPUS_CATEGORY.ADMINISTRATIVE, major: true },
  food_court: { kind: CAMPUS_FEATURE_KIND.FACILITY, category: CAMPUS_CATEGORY.COMMERCIAL, major: true },
  fast_food: { kind: CAMPUS_FEATURE_KIND.FACILITY, category: CAMPUS_CATEGORY.COMMERCIAL, major: true },
  cafe: { kind: CAMPUS_FEATURE_KIND.FACILITY, category: CAMPUS_CATEGORY.COMMERCIAL, major: true },
  restaurant: { kind: CAMPUS_FEATURE_KIND.FACILITY, category: CAMPUS_CATEGORY.COMMERCIAL, major: true },
  bank: { kind: CAMPUS_FEATURE_KIND.FACILITY, category: CAMPUS_CATEGORY.COMMERCIAL, major: false },
  fountain: { kind: CAMPUS_FEATURE_KIND.LANDMARK, category: CAMPUS_CATEGORY.UNCLASSIFIED, major: false },
  toilets: { kind: CAMPUS_FEATURE_KIND.FACILITY, category: CAMPUS_CATEGORY.UTILITY, major: false },
  parking: { kind: CAMPUS_FEATURE_KIND.FACILITY, category: CAMPUS_CATEGORY.OPERATIONAL, major: false },
  motorcycle_parking: { kind: CAMPUS_FEATURE_KIND.FACILITY, category: CAMPUS_CATEGORY.OPERATIONAL, major: false },
  bicycle_parking: { kind: CAMPUS_FEATURE_KIND.FACILITY, category: CAMPUS_CATEGORY.OPERATIONAL, major: false },
  library: { kind: CAMPUS_FEATURE_KIND.FACILITY, category: CAMPUS_CATEGORY.ACADEMIC, major: true },
});

const HISTORIC_RULES = Object.freeze({
  memorial: { kind: CAMPUS_FEATURE_KIND.LANDMARK, category: CAMPUS_CATEGORY.UNCLASSIFIED, major: true },
  monument: { kind: CAMPUS_FEATURE_KIND.LANDMARK, category: CAMPUS_CATEGORY.UNCLASSIFIED, major: true },
});

const LEISURE_RULES = Object.freeze({
  pitch: { kind: CAMPUS_FEATURE_KIND.FACILITY, category: CAMPUS_CATEGORY.SPORTS, major: true },
  sports_centre: { kind: CAMPUS_FEATURE_KIND.FACILITY, category: CAMPUS_CATEGORY.SPORTS, major: true },
  stadium: { kind: CAMPUS_FEATURE_KIND.FACILITY, category: CAMPUS_CATEGORY.SPORTS, major: true },
  track: { kind: CAMPUS_FEATURE_KIND.FACILITY, category: CAMPUS_CATEGORY.SPORTS, major: true },
  garden: { kind: CAMPUS_FEATURE_KIND.FACILITY, category: CAMPUS_CATEGORY.UNCLASSIFIED, major: false },
  park: { kind: CAMPUS_FEATURE_KIND.FACILITY, category: CAMPUS_CATEGORY.UNCLASSIFIED, major: false },
});

/**
 * `landuse=<value>` values that describe a usable campus AREA.
 *
 * Deliberately short. `landuse` is OSM's broadest tag and most of its values
 * describe the surroundings rather than a place on a campus — `forest`,
 * `residential`, `industrial` and the rest are NOT here, so JSSATE's
 * neighbouring Turahalli reserve forest stays excluded and reported rather than
 * being drawn as a campus facility.
 *
 * `recreation_ground` is here because it is the tag OSM uses for exactly the
 * thing §"campus features" asks for — a playground / recreation ground — and
 * because the alternative was leaving a named, mapped, in-boundary campus
 * ground off the map entirely.
 */
const LANDUSE_RULES = Object.freeze({
  recreation_ground: { kind: CAMPUS_FEATURE_KIND.FACILITY, category: CAMPUS_CATEGORY.SPORTS, major: true },
});

/**
 * `natural=<value>` values that are places on a campus rather than terrain.
 *
 * A campus lake is something an operator navigates by and a robot must not
 * drive into, so it is a LANDMARK. It carries no category of its own — the
 * palette has no "water" colour and inventing one would be a rendering claim,
 * not a data one — so it draws in the neutral unclassified fill (§11).
 */
const NATURAL_RULES = Object.freeze({
  water: { kind: CAMPUS_FEATURE_KIND.LANDMARK, category: CAMPUS_CATEGORY.UNCLASSIFIED, major: false },
});

/** `building=<value>` → category, where the value itself carries a use. */
const BUILDING_VALUE_CATEGORY = Object.freeze({
  dormitory: CAMPUS_CATEGORY.RESIDENTIAL,
  residential: CAMPUS_CATEGORY.RESIDENTIAL,
  apartments: CAMPUS_CATEGORY.RESIDENTIAL,
  house: CAMPUS_CATEGORY.RESIDENTIAL,
  commercial: CAMPUS_CATEGORY.COMMERCIAL,
  retail: CAMPUS_CATEGORY.COMMERCIAL,
  kiosk: CAMPUS_CATEGORY.COMMERCIAL,
  school: CAMPUS_CATEGORY.ACADEMIC,
  university: CAMPUS_CATEGORY.ACADEMIC,
  college: CAMPUS_CATEGORY.ACADEMIC,
  civic: CAMPUS_CATEGORY.ADMINISTRATIVE,
  office: CAMPUS_CATEGORY.ADMINISTRATIVE,
  temple: CAMPUS_CATEGORY.RELIGIOUS,
  church: CAMPUS_CATEGORY.RELIGIOUS,
  mosque: CAMPUS_CATEGORY.RELIGIOUS,
  industrial: CAMPUS_CATEGORY.UTILITY,
  service: CAMPUS_CATEGORY.UTILITY,
  roof: CAMPUS_CATEGORY.UTILITY,
  garage: CAMPUS_CATEGORY.UTILITY,
  garages: CAMPUS_CATEGORY.UTILITY,
});

/**
 * Second-stage category rules, applied to the name THE SOURCE SUPPLIED and only
 * where every tag was silent about use.
 *
 * ── Why this is not the guessing §4 forbids ───────────────────────────────
 * §4 forbids inventing geometry and inferring identity from POSITION ("that
 * large rectangle must be CSE"). This does neither. It reads a name OSM already
 * asserts — "CSE, ISE & CSDS Department" — and concludes the building is
 * academic. It cannot move a building, rename one, or bring one into existence,
 * and every feature records `categoryBasis` so the derivation is visible in the
 * details card rather than passing as tag data.
 *
 * Category affects the building palette and nothing else (§11). If every rule
 * here were deleted, the map would still be geographically correct — every
 * building would simply be drawn in the neutral unclassified colour.
 *
 * Ordered: the first match wins, so more specific phrases come first.
 */
const NAME_CATEGORY_RULES = Object.freeze([
  Object.freeze({ pattern: /\b(temple|mandir|masjid|church|chapel|shrine)\b/i, category: CAMPUS_CATEGORY.RELIGIOUS }),
  Object.freeze({ pattern: /\b(hostel|dormitory|residence hall|quarters)\b/i, category: CAMPUS_CATEGORY.RESIDENTIAL }),
  Object.freeze({
    pattern: /\b(canteen|cafeteria|mess|cafe|food ?court|bank|atm|store|stores|shop)\b/i,
    category: CAMPUS_CATEGORY.COMMERCIAL,
  }),
  Object.freeze({
    pattern: /\b(main building|administration|administrative|admin|principal|office|auditorium|seminar hall)\b/i,
    category: CAMPUS_CATEGORY.ADMINISTRATIVE,
  }),
  Object.freeze({
    pattern: /\b(department|dept|block|school|college|institute|library|laborator(y|ies)|lab|academic|classroom)\b/i,
    category: CAMPUS_CATEGORY.ACADEMIC,
  }),
  Object.freeze({
    pattern: /\b(court|ground|grounds|pitch|stadium|gym|gymnasium|pavilion|playfield)\b/i,
    category: CAMPUS_CATEGORY.SPORTS,
  }),
  Object.freeze({
    pattern: /\b(substation|transformer|generator|pump ?house|water tank|utility|plant room)\b/i,
    category: CAMPUS_CATEGORY.UTILITY,
  }),
]);

export const CATEGORY_BASIS = Object.freeze({
  OSM_TAG: 'OSM_TAG',
  SOURCE_NAME: 'SOURCE_NAME',
  NONE: 'NONE',
});

/**
 * Category from a supplied NAME alone, using the rule table above.
 *
 * Exported so the supplemental importer can apply the identical rules rather
 * than growing a second, drifting copy of them. Returns `UNCLASSIFIED` when no
 * rule matches — "we do not know what this is" is a real answer and is the one
 * that must not be dressed up as a classification.
 */
export function categoryFromName(name) {
  const n = String(name || '');
  if (!n.trim()) return { category: CAMPUS_CATEGORY.UNCLASSIFIED, basis: CATEGORY_BASIS.NONE, from: null };
  for (const rule of NAME_CATEGORY_RULES) {
    if (rule.pattern.test(n)) {
      return { category: rule.category, basis: CATEGORY_BASIS.SOURCE_NAME, from: `name "${n}"` };
    }
  }
  return { category: CAMPUS_CATEGORY.UNCLASSIFIED, basis: CATEGORY_BASIS.NONE, from: null };
}

/** `highway=<value>` → the road/path hierarchy of §17. */
const HIGHWAY_RULES = Object.freeze({
  motorway: { kind: CAMPUS_FEATURE_KIND.ROAD, roadClass: ROAD_CLASS.MAIN, name: 'Road' },
  trunk: { kind: CAMPUS_FEATURE_KIND.ROAD, roadClass: ROAD_CLASS.MAIN, name: 'Road' },
  primary: { kind: CAMPUS_FEATURE_KIND.ROAD, roadClass: ROAD_CLASS.MAIN, name: 'Road' },
  secondary: { kind: CAMPUS_FEATURE_KIND.ROAD, roadClass: ROAD_CLASS.MAIN, name: 'Road' },
  tertiary: { kind: CAMPUS_FEATURE_KIND.ROAD, roadClass: ROAD_CLASS.MAIN, name: 'Road' },
  unclassified: { kind: CAMPUS_FEATURE_KIND.ROAD, roadClass: ROAD_CLASS.MAIN, name: 'Road' },
  residential: { kind: CAMPUS_FEATURE_KIND.ROAD, roadClass: ROAD_CLASS.MAIN, name: 'Road' },
  // The campus's own internal network. Every one of them in this dataset also
  // carries `access=private`, which is what makes them campus roads rather than
  // public streets — but the class comes from `highway`, not from the access.
  service: { kind: CAMPUS_FEATURE_KIND.ROAD, roadClass: ROAD_CLASS.SECONDARY, name: 'Service road' },
  track: { kind: CAMPUS_FEATURE_KIND.ROAD, roadClass: ROAD_CLASS.SERVICE, name: 'Track' },
  footway: { kind: CAMPUS_FEATURE_KIND.PATH, pathClass: PATH_CLASS.FOOTWAY, name: 'Footpath' },
  path: { kind: CAMPUS_FEATURE_KIND.PATH, pathClass: PATH_CLASS.FOOTWAY, name: 'Path' },
  pedestrian: { kind: CAMPUS_FEATURE_KIND.PATH, pathClass: PATH_CLASS.FOOTWAY, name: 'Pedestrian way' },
  corridor: { kind: CAMPUS_FEATURE_KIND.PATH, pathClass: PATH_CLASS.FOOTWAY, name: 'Corridor' },
  steps: { kind: CAMPUS_FEATURE_KIND.PATH, pathClass: PATH_CLASS.STEPS, name: 'Steps' },
});

/** Surfaces that contradict a `building` tag when a sport is also present. */
const OPEN_GROUND_SURFACES = new Set(['grass', 'earth', 'dirt', 'ground', 'sand', 'clay', 'gravel']);

/** Why a source feature was not turned into a campus feature. */
export const EXCLUSION_REASON = Object.freeze({
  /** The same real object, mapped twice in OSM (a node inside its own way). */
  DUPLICATE_OF_POLYGON: 'DUPLICATE_OF_POLYGON',
  /** An unnamed building footprint fully inside a named one — a part-mapping. */
  SUPERSEDED_BY_ENCLOSING_BUILDING: 'SUPERSEDED_BY_ENCLOSING_BUILDING',
  /** No tag this map understands. Kept out rather than rendered as "something". */
  UNCLASSIFIED_TAGS: 'UNCLASSIFIED_TAGS',
  /** Tagged in a way the geometry cannot support (e.g. a building as a line). */
  GEOMETRY_MISMATCH: 'GEOMETRY_MISMATCH',
});

// ── Geometry helpers (measurement only — nothing here creates geometry) ──────

/** Metres per degree at a given latitude. Local, planar, good to well under a metre at campus scale. */
function metresPerDegree(lat) {
  return { x: 111320 * Math.cos((lat * Math.PI) / 180), y: 110574 };
}

function outerRing(geometry) {
  if (geometry?.type === 'Polygon') return geometry.coordinates?.[0] || null;
  if (geometry?.type === 'MultiPolygon') return geometry.coordinates?.[0]?.[0] || null;
  return null;
}

/** Footprint area in m². Returns 0 for anything that is not a polygon. */
export function footprintAreaSqm(geometry) {
  const ring = outerRing(geometry);
  if (!Array.isArray(ring) || ring.length < 4) return 0;
  const { x: kx, y: ky } = metresPerDegree(ring[0][1]);
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += ring[j][0] * kx * (ring[i][1] * ky) - ring[i][0] * kx * (ring[j][1] * ky);
  }
  return Math.abs(sum / 2);
}

/** Mean of a ring's distinct vertices — the same anchor `campusLayers.labelAnchorFor` uses. */
function ringCentroid(geometry) {
  const ring = outerRing(geometry);
  if (!Array.isArray(ring) || ring.length === 0) return null;
  const closed =
    ring.length > 2 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
  const pts = closed ? ring.slice(0, -1) : ring;
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const p of pts) {
    if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    sx += p[0];
    sy += p[1];
    n += 1;
  }
  return n === 0 ? null : [sx / n, sy / n];
}

function anchorOf(geometry) {
  if (geometry?.type === 'Point') {
    const c = geometry.coordinates;
    return Array.isArray(c) ? [c[0], c[1]] : null;
  }
  if (geometry?.type === 'LineString') {
    const c = geometry.coordinates || [];
    return c.length ? c[Math.floor(c.length / 2)] : null;
  }
  return ringCentroid(geometry);
}

/** Ray-casting point-in-polygon against a polygon's outer ring. */
export function pointInPolygon(point, geometry) {
  const ring = outerRing(geometry);
  if (!Array.isArray(point) || !Array.isArray(ring) || ring.length < 4) return false;
  const [px, py] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Every position in a geometry, flattened. Read-only — nothing is copied back. */
function everyPosition(geometry) {
  const out = [];
  const walk = (c) => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === 'number') out.push(c);
    else c.forEach(walk);
  };
  walk(geometry?.coordinates);
  return out;
}

/**
 * Is this feature ON the campus the boundary describes?
 *
 * The test differs by geometry, because "where is it" means different things
 * for a line and for an area, and using one rule for both gets one of them
 * wrong in a way that matters:
 *
 *   LINES     any vertex inside. A service road that runs along the perimeter
 *             is genuinely a campus road even though the middle of the line
 *             falls a few metres outside the fence. Judging a road by its
 *             midpoint reported three of RNSIT's own roads as somewhere else.
 *
 *   AREAS AND POINTS  the anchor — a polygon's centroid, a point itself.
 *             An area is where its middle is. JSSATE's extract contains a
 *             temple compound that SHARES A BORDER with the campus, so "any
 *             vertex inside" would have called it a campus building; its
 *             centroid is several hundred metres down the hill, which is the
 *             fact worth reporting.
 *
 * Neither answer moves, hides or deletes anything. It decides which sentence
 * the map says about a feature it draws either way (§49).
 */
export function touchesPolygon(geometry, polygon) {
  if (!geometry || !polygon) return false;

  const type = geometry.type;
  if (type === 'LineString' || type === 'MultiLineString') {
    for (const position of everyPosition(geometry)) {
      if (pointInPolygon(position, polygon)) return true;
    }
    return false;
  }

  const anchor = anchorOf(geometry);
  return anchor ? pointInPolygon(anchor, polygon) : false;
}

/** Planar distance in metres between two lon/lat positions, at campus scale. */
export function metresBetween(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return Infinity;
  const { x: kx, y: ky } = metresPerDegree((a[1] + b[1]) / 2);
  return Math.hypot((a[0] - b[0]) * kx, (a[1] - b[1]) * ky);
}

// ── Tag parsing ──────────────────────────────────────────────────────────────

function tagString(tags, key) {
  const v = tags?.[key];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * An OSM `height` in metres. OSM allows "12", "12 m", "12.5". Anything it
 * cannot read confidently (feet-and-inches notation, ranges) returns null —
 * a misread height is worse than an absent one.
 */
export function parseOsmHeight(tags) {
  const raw = tagString(tags, 'height') || tagString(tags, 'building:height');
  if (!raw) return null;
  const m = /^(\d+(?:\.\d+)?)\s*m?$/i.exec(raw);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** An OSM `building:levels` count. */
export function parseOsmLevels(tags) {
  const raw = tagString(tags, 'building:levels');
  if (!raw) return null;
  const m = /^(\d+(?:\.\d+)?)$/.exec(raw);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) && v > 0 && v < 200 ? v : null;
}

/**
 * The height policy, in one function (§8, §38).
 *
 * @returns {{ actualHeight: number|null, renderHeight: number, basis: string, levels: number|null }}
 */
export function deriveRenderHeight(tags, geometry) {
  const actualHeight = parseOsmHeight(tags);
  const levels = parseOsmLevels(tags);

  if (actualHeight !== null) {
    return { actualHeight, renderHeight: actualHeight, basis: HEIGHT_BASIS.OSM_HEIGHT_TAG, levels };
  }
  if (levels !== null) {
    return {
      actualHeight: null,
      renderHeight: round1(levels * RENDER_HEIGHT.METRES_PER_LEVEL),
      basis: HEIGHT_BASIS.OSM_LEVELS,
      levels,
    };
  }

  // No height, no levels. Draw the conservative default — unless the footprint
  // is so small the default would render a pillar rather than a building.
  const area = footprintAreaSqm(geometry);
  const width = area > 0 ? Math.sqrt(area) : 0;
  const clamp = width > 0 ? width * RENDER_HEIGHT.SMALL_FOOTPRINT_FACTOR : Infinity;
  if (clamp < RENDER_HEIGHT.FALLBACK) {
    return {
      actualHeight: null,
      renderHeight: round1(Math.max(2.5, clamp)),
      basis: HEIGHT_BASIS.FALLBACK_CLAMPED,
      levels: null,
    };
  }
  return { actualHeight: null, renderHeight: RENDER_HEIGHT.FALLBACK, basis: HEIGHT_BASIS.FALLBACK, levels: null };
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

// ── Classification ───────────────────────────────────────────────────────────

function categoryForBuilding(tags, name) {
  const amenity = tagString(tags, 'amenity');
  const amenityRule = amenity ? AMENITY_RULES[amenity] : null;
  if (amenityRule && amenityRule.category !== CAMPUS_CATEGORY.UNCLASSIFIED) {
    return { category: amenityRule.category, basis: CATEGORY_BASIS.OSM_TAG, from: `amenity=${amenity}` };
  }

  const buildingValue = tagString(tags, 'building');
  if (buildingValue && BUILDING_VALUE_CATEGORY[buildingValue]) {
    return {
      category: BUILDING_VALUE_CATEGORY[buildingValue],
      basis: CATEGORY_BASIS.OSM_TAG,
      from: `building=${buildingValue}`,
    };
  }

  if (tagString(tags, 'religion') || tagString(tags, 'denomination')) {
    return { category: CAMPUS_CATEGORY.RELIGIOUS, basis: CATEGORY_BASIS.OSM_TAG, from: 'religion' };
  }

  // Tags are silent. Fall back to the name the source itself supplies.
  if (name) {
    for (const rule of NAME_CATEGORY_RULES) {
      if (rule.pattern.test(name)) {
        return { category: rule.category, basis: CATEGORY_BASIS.SOURCE_NAME, from: `name "${name}"` };
      }
    }
  }

  return { category: CAMPUS_CATEGORY.UNCLASSIFIED, basis: CATEGORY_BASIS.NONE, from: null };
}

/**
 * Does a `building` tag conflict with what the rest of the tags describe? (§41)
 *
 * `way/151617521` in this dataset is `building=commercial` + `sport=cricket;football`
 * + `surface=grass` over 13 338 m². Extruding that as a building would put a
 * seven-metre box over the entire playing field — a large, confident, wrong
 * claim about the campus. The tags contradict each other; the conservative
 * reading (an open ground, drawn flat) is the one that claims less.
 */
function buildingContradictedByGround(tags) {
  const hasSport = Boolean(tagString(tags, 'sport'));
  const leisure = tagString(tags, 'leisure');
  const surface = tagString(tags, 'surface');
  const openSurface = surface ? OPEN_GROUND_SURFACES.has(surface) : false;
  if (hasSport && (openSurface || leisure === 'pitch')) {
    return `building=${tagString(tags, 'building')} contradicted by sport=${tagString(tags, 'sport')}${
      surface ? ` and surface=${surface}` : ''
    }`;
  }
  if (leisure === 'pitch' && openSurface) {
    return `building tag contradicted by leisure=pitch and surface=${surface}`;
  }
  return null;
}

/**
 * Classify one OSM feature.
 *
 * @returns {{
 *   kind: string, category: string, categoryBasis: string, categoryFrom: string|null,
 *   roadClass?: string, pathClass?: string, extrude: boolean, major: boolean,
 *   descriptiveName: string, conflict: string|null,
 * } | { excluded: string, detail: string }}
 */
export function classifyOsmFeature(sourceFeature) {
  const tags = sourceFeature?.properties || {};
  const geometry = sourceFeature?.geometry;
  const type = geometry?.type;
  const name = tagString(tags, 'name');
  const isPolygon = type === 'Polygon' || type === 'MultiPolygon';
  const isLine = type === 'LineString' || type === 'MultiLineString';
  const isPoint = type === 'Point';

  // ── The campus site itself ───────────────────────────────────────────────
  // `amenity=college` on the site polygon is the campus boundary (§7). The
  // identically-tagged NODE is the same object mapped twice; it is dropped in
  // the de-duplication pass, not here, so the reason is recorded against the
  // polygon that superseded it.
  if (tagString(tags, 'amenity') === 'college' || tagString(tags, 'amenity') === 'university') {
    if (isPolygon) {
      return {
        kind: CAMPUS_FEATURE_KIND.BOUNDARY,
        category: CAMPUS_CATEGORY.OPERATIONAL,
        categoryBasis: CATEGORY_BASIS.OSM_TAG,
        categoryFrom: `amenity=${tagString(tags, 'amenity')}`,
        extrude: false,
        major: true,
        descriptiveName: name || 'Campus boundary',
        conflict: null,
      };
    }
    if (isPoint) {
      return {
        kind: CAMPUS_FEATURE_KIND.LANDMARK,
        category: CAMPUS_CATEGORY.OPERATIONAL,
        categoryBasis: CATEGORY_BASIS.OSM_TAG,
        categoryFrom: `amenity=${tagString(tags, 'amenity')}`,
        extrude: false,
        major: true,
        descriptiveName: name || 'Campus',
        conflict: null,
      };
    }
    return { excluded: EXCLUSION_REASON.GEOMETRY_MISMATCH, detail: `amenity=college on ${type}` };
  }

  // ── Buildings ────────────────────────────────────────────────────────────
  if (tagString(tags, 'building')) {
    if (!isPolygon) {
      return { excluded: EXCLUSION_REASON.GEOMETRY_MISMATCH, detail: `building tag on ${type}` };
    }

    const conflict = buildingContradictedByGround(tags);
    if (conflict) {
      // Drawn as ground, not as a volume — and the contradiction is carried
      // through to the details card rather than resolved silently.
      const sportName = tagString(tags, 'sport');
      return {
        kind: CAMPUS_FEATURE_KIND.FACILITY,
        category: CAMPUS_CATEGORY.SPORTS,
        categoryBasis: CATEGORY_BASIS.OSM_TAG,
        categoryFrom: sportName ? `sport=${sportName}` : 'leisure=pitch',
        extrude: false,
        major: true,
        descriptiveName: name || 'Sports ground',
        conflict,
      };
    }

    const cat = categoryForBuilding(tags, name);
    return {
      kind: CAMPUS_FEATURE_KIND.BUILDING,
      category: cat.category,
      categoryBasis: cat.basis,
      categoryFrom: cat.from,
      extrude: true,
      major: false,
      descriptiveName: name || 'Unnamed building',
      conflict: null,
    };
  }

  // ── Sports and leisure areas with no building tag ────────────────────────
  const leisure = tagString(tags, 'leisure');
  if (leisure && LEISURE_RULES[leisure]) {
    const rule = LEISURE_RULES[leisure];
    const sport = tagString(tags, 'sport');
    return {
      kind: rule.kind,
      category: rule.category,
      categoryBasis: CATEGORY_BASIS.OSM_TAG,
      categoryFrom: sport ? `leisure=${leisure}, sport=${sport}` : `leisure=${leisure}`,
      extrude: false,
      major: rule.major,
      descriptiveName: name || (sport ? `${sport} pitch` : 'Sports area'),
      conflict: null,
    };
  }

  // ── Amenities and landmarks ──────────────────────────────────────────────
  const amenity = tagString(tags, 'amenity');
  if (amenity && AMENITY_RULES[amenity]) {
    const rule = AMENITY_RULES[amenity];
    return {
      kind: rule.kind,
      category: rule.category,
      categoryBasis: CATEGORY_BASIS.OSM_TAG,
      categoryFrom: `amenity=${amenity}`,
      extrude: false,
      major: rule.major,
      descriptiveName: name || humanise(amenity),
      conflict: null,
    };
  }

  // ── Usable campus areas and natural features ─────────────────────────────
  const landuse = tagString(tags, 'landuse');
  if (landuse && LANDUSE_RULES[landuse]) {
    if (!isPolygon) return { excluded: EXCLUSION_REASON.GEOMETRY_MISMATCH, detail: `landuse=${landuse} on ${type}` };
    const rule = LANDUSE_RULES[landuse];
    return {
      kind: rule.kind,
      category: rule.category,
      categoryBasis: CATEGORY_BASIS.OSM_TAG,
      categoryFrom: `landuse=${landuse}`,
      extrude: false,
      major: rule.major,
      descriptiveName: name || humanise(landuse),
      conflict: null,
    };
  }

  const natural = tagString(tags, 'natural');
  if (natural && NATURAL_RULES[natural]) {
    if (!isPolygon && !isPoint) {
      return { excluded: EXCLUSION_REASON.GEOMETRY_MISMATCH, detail: `natural=${natural} on ${type}` };
    }
    const rule = NATURAL_RULES[natural];
    const water = tagString(tags, 'water');
    return {
      kind: rule.kind,
      category: rule.category,
      categoryBasis: CATEGORY_BASIS.OSM_TAG,
      categoryFrom: water ? `natural=${natural}, water=${water}` : `natural=${natural}`,
      extrude: false,
      major: rule.major,
      descriptiveName: name || humanise(water || natural),
      conflict: null,
    };
  }

  const historic = tagString(tags, 'historic');
  if (historic && HISTORIC_RULES[historic]) {
    const rule = HISTORIC_RULES[historic];
    const memorial = tagString(tags, 'memorial');
    return {
      kind: rule.kind,
      category: rule.category,
      categoryBasis: CATEGORY_BASIS.OSM_TAG,
      categoryFrom: memorial ? `historic=${historic}, memorial=${memorial}` : `historic=${historic}`,
      extrude: false,
      major: rule.major,
      descriptiveName: name || humanise(memorial || historic),
      conflict: null,
    };
  }

  // ── Roads and paths ──────────────────────────────────────────────────────
  const highway = tagString(tags, 'highway');
  if (highway && HIGHWAY_RULES[highway]) {
    if (!isLine) return { excluded: EXCLUSION_REASON.GEOMETRY_MISMATCH, detail: `highway=${highway} on ${type}` };
    const rule = HIGHWAY_RULES[highway];
    return {
      kind: rule.kind,
      category: CAMPUS_CATEGORY.CIRCULATION,
      categoryBasis: CATEGORY_BASIS.OSM_TAG,
      categoryFrom: `highway=${highway}`,
      ...(rule.roadClass ? { roadClass: rule.roadClass } : {}),
      ...(rule.pathClass ? { pathClass: rule.pathClass } : {}),
      extrude: false,
      major: false,
      descriptiveName: name || rule.name,
      conflict: null,
    };
  }

  return {
    excluded: EXCLUSION_REASON.UNCLASSIFIED_TAGS,
    detail: `no rule for tags: ${Object.keys(tags).filter((k) => k !== '@id').join(', ') || '(none)'}`,
  };
}

function humanise(value) {
  return String(value || '')
    .replace(/_/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());
}

// ── Label priority (§14) ─────────────────────────────────────────────────────

/**
 * A building smaller than this is a kiosk, a guard hut or an ATM cabin, not a
 * block — its name waits for close zoom rather than competing with the
 * department buildings at the campus overview.
 *
 * Footprint area is the only signal in the data that separates them: OSM tags
 * this campus's 26 m² Canara Bank cabin and its 2 269 m² Mechanical & EEE
 * department identically, as `building=yes` with a name.
 */
export const SMALL_BUILDING_LABEL_SQM = 150;

/**
 * Which zoom band a feature's label belongs to.
 *
 *   PRIMARY    the campus itself — supplied by the campus centre record, so
 *              nothing imported here claims this band
 *   SECONDARY  named buildings of real size, and major landmarks/facilities —
 *              readable from the campus overview framing
 *   DETAIL     small facilities and small structures: parking, toilets, an
 *              ATM cabin, a fountain
 */
function labelPriorityFor(classification, hasSourceName, geometry) {
  if (!hasSourceName) return LABEL_PRIORITY.DETAIL;
  if (classification.kind === CAMPUS_FEATURE_KIND.BUILDING) {
    return footprintAreaSqm(geometry) >= SMALL_BUILDING_LABEL_SQM
      ? LABEL_PRIORITY.SECONDARY
      : LABEL_PRIORITY.DETAIL;
  }
  return classification.major ? LABEL_PRIORITY.SECONDARY : LABEL_PRIORITY.DETAIL;
}

// ── De-duplication (§13, §41) ────────────────────────────────────────────────

/** Two names are "the same name" for label purposes if they match case- and space-insensitively. */
function normaliseName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Same-named features closer together than this are treated as one place for
 * LABELLING purposes — both features are kept, both stay clickable and
 * searchable, but only the larger one carries the map label.
 *
 * This dataset's three "Hostel" buildings are 89–102 m apart and all keep their
 * labels; its two "Canara Bank" features are 58 m apart and collapse to one.
 */
export const LABEL_DEDUP_RADIUS_M = 75;

// ── Import ───────────────────────────────────────────────────────────────────

function idFor(osmId) {
  return `osm-${String(osmId).replace(/[^a-zA-Z0-9]+/g, '-')}`;
}

/** Tags that are noise in a details card — ids, transliterations, brand metadata. */
const METADATA_TAG_DENYLIST = /^(@id|name|name:|alt_name|brand:|wikidata|wikipedia|source|addr:|contact:|building$|highway$|amenity$|leisure$|historic$|landuse$|natural$)/;

function interestingTags(tags) {
  const out = {};
  for (const [k, v] of Object.entries(tags || {})) {
    if (METADATA_TAG_DENYLIST.test(k)) continue;
    if (k.includes(':') && !/^(building:levels|diet:|internet_access)/.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Turn an OSM FeatureCollection into validated-shape RobotX campus features.
 *
 * Geometry is passed through BY REFERENCE-EQUAL VALUE: the emitted feature's
 * `geometry` is the source geometry object. No reprojection, no rounding, no
 * simplification, no repair (§21, §22, §56). If the source is wrong, the map is
 * wrong in exactly the same way, and says where it came from.
 *
 * @param {object} collection  a GeoJSON FeatureCollection of OSM features
 * @param {object} [options]
 * @param {object} [options.dataset]  which artefact this collection is, from `osmDataset()`
 * @returns {{
 *   features: object[],
 *   excluded: Array<{ osmId: string, name: string|null, reason: string, detail: string }>,
 *   unlabelled: Array<{ osmId: string, name: string, reason: string }>,
 *   conflicts: Array<{ osmId: string, name: string, conflict: string }>,
 *   outsideBoundary: Array<{ osmId: string, name: string, kind: string }>,
 *   boundary: object|null,
 * }}
 */
export function importOsmCampus(collection, { dataset = OSM_DATASET } = {}) {
  const source = Array.isArray(collection?.features) ? collection.features : [];

  const excluded = [];
  const conflicts = [];
  const unlabelled = [];

  // ── Pass 1: classify ─────────────────────────────────────────────────────
  const staged = [];
  for (const sf of source) {
    const osmId = sf?.properties?.['@id'] || sf?.id || null;
    const tags = sf?.properties || {};
    const sourceName = tagString(tags, 'name');

    if (!osmId || !sf?.geometry) {
      excluded.push({
        osmId: osmId || '(no id)',
        name: sourceName,
        reason: EXCLUSION_REASON.GEOMETRY_MISMATCH,
        detail: 'feature has no OSM id or no geometry',
      });
      continue;
    }

    const classification = classifyOsmFeature(sf);
    if (classification.excluded) {
      excluded.push({
        osmId,
        name: sourceName,
        reason: classification.excluded,
        detail: classification.detail,
      });
      continue;
    }

    if (classification.conflict) {
      conflicts.push({ osmId, name: sourceName || classification.descriptiveName, conflict: classification.conflict });
    }

    staged.push({ sf, osmId, tags, sourceName, classification, anchor: anchorOf(sf.geometry) });
  }

  // ── Pass 2: drop objects OSM mapped twice ────────────────────────────────
  //
  // A node carrying the same name as a polygon, and lying INSIDE that polygon,
  // is that polygon — the campus site node inside the campus boundary is the
  // textbook case. Topological, so it needs no distance threshold to justify.
  const polygons = staged.filter((s) => s.sf.geometry.type === 'Polygon' || s.sf.geometry.type === 'MultiPolygon');
  const kept = [];
  for (const s of staged) {
    if (s.sf.geometry.type !== 'Point' || !s.sourceName) {
      kept.push(s);
      continue;
    }
    const enclosing = polygons.find(
      (p) => normaliseName(p.sourceName) === normaliseName(s.sourceName) && pointInPolygon(s.anchor, p.sf.geometry)
    );
    if (enclosing) {
      excluded.push({
        osmId: s.osmId,
        name: s.sourceName,
        reason: EXCLUSION_REASON.DUPLICATE_OF_POLYGON,
        detail: `the same object is mapped as ${enclosing.osmId}, whose polygon contains this node`,
      });
      continue;
    }
    kept.push(s);
  }

  // ── Pass 3: unnamed building footprints inside a named one ───────────────
  //
  // OSM contains RNS International School twice: once as the named 4-storey
  // building, and once as two unnamed part-footprints that together trace the
  // same outline. Extruding all three produces coplanar faces fighting for the
  // same pixels (§6) — the z-fighting this rule exists to prevent. The named
  // feature survives; the parts are recorded, not deleted from the record.
  const namedBuildings = kept.filter(
    (s) => s.classification.kind === CAMPUS_FEATURE_KIND.BUILDING && s.sourceName
  );
  const surviving = [];
  for (const s of kept) {
    const isUnnamedBuilding = s.classification.kind === CAMPUS_FEATURE_KIND.BUILDING && !s.sourceName;
    const enclosing = isUnnamedBuilding
      ? namedBuildings.find((n) => n !== s && s.anchor && pointInPolygon(s.anchor, n.sf.geometry))
      : null;
    if (enclosing) {
      excluded.push({
        osmId: s.osmId,
        name: null,
        reason: EXCLUSION_REASON.SUPERSEDED_BY_ENCLOSING_BUILDING,
        detail: `unnamed footprint inside "${enclosing.sourceName}" (${enclosing.osmId}) — the same building, mapped twice`,
      });
      continue;
    }
    surviving.push(s);
  }

  // ── Pass 4: emit ─────────────────────────────────────────────────────────
  const features = surviving.map((s) => {
    const { sf, osmId, tags, sourceName, classification } = s;
    const isBuilding = classification.kind === CAMPUS_FEATURE_KIND.BUILDING;
    const height = isBuilding ? deriveRenderHeight(tags, sf.geometry) : null;

    const feature = {
      id: idFor(osmId),
      name: sourceName || classification.descriptiveName,
      shortName: null,
      kind: classification.kind,
      category: classification.category,
      labelPriority: labelPriorityFor(classification, Boolean(sourceName), sf.geometry),
      // Boundaries are ground, and anything the source did not name has no
      // identity to put on a map (§4). Set here; refined by the label
      // de-duplication pass below.
      labelled: Boolean(sourceName) && classification.kind !== CAMPUS_FEATURE_KIND.BOUNDARY,
      nameIsDescriptive: !sourceName,
      geometry: sf.geometry,

      ...(classification.roadClass ? { roadClass: classification.roadClass } : {}),
      ...(classification.pathClass ? { pathClass: classification.pathClass } : {}),

      // ── Height (§38): what is real, and what is only drawn ──────────────
      ...(height?.actualHeight !== null && height?.actualHeight !== undefined
        ? { height: height.actualHeight }
        : {}),
      ...(height ? { renderHeight: height.renderHeight, heightBasis: height.basis } : {}),
      ...(height?.levels ? { levels: height.levels } : {}),

      // ── Provenance (§3, §34) ────────────────────────────────────────────
      provenance: PROVENANCE.OPEN_DATA_IMPORT,
      verification: VERIFICATION.NOT_VERIFIED,
      verifiedOn: null,
      source: osmSourceString(osmId, dataset),
      sourceId: osmId,
      sourceTags: Object.freeze({ ...tags }),

      metadata: buildMetadata({ classification, tags, sourceName, height }),
    };

    return feature;
  });

  // ── Pass 5: label de-duplication (§13) ───────────────────────────────────
  //
  // Both features stay on the map and in the search index. Only the label is
  // taken away, and only from the smaller of two same-named features that are
  // close enough to read as one place.
  const byName = new Map();
  for (const f of features) {
    if (!f.labelled) continue;
    const key = normaliseName(f.name);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(f);
  }

  for (const [, group] of byName) {
    if (group.length < 2) continue;
    // Largest footprint first — a building outranks a node at the same name.
    const ranked = [...group].sort((a, b) => footprintAreaSqm(b.geometry) - footprintAreaSqm(a.geometry));
    for (let i = 1; i < ranked.length; i += 1) {
      const near = ranked
        .slice(0, i)
        .find((keeper) => keeper.labelled && metresBetween(anchorOf(keeper.geometry), anchorOf(ranked[i].geometry)) <= LABEL_DEDUP_RADIUS_M);
      if (!near) continue;
      ranked[i].labelled = false;
      ranked[i].metadata = {
        ...ranked[i].metadata,
        'Map label': `Suppressed — the same name is labelled on ${near.sourceId}, ${Math.round(
          metresBetween(anchorOf(near.geometry), anchorOf(ranked[i].geometry))
        )} m away`,
      };
      unlabelled.push({
        osmId: ranked[i].sourceId,
        name: ranked[i].name,
        reason: `same name as ${near.sourceId} within ${LABEL_DEDUP_RADIUS_M} m`,
      });
    }
  }

  // Where a name genuinely recurs across the campus, say so rather than let an
  // operator assume two "Hostel" labels are a rendering bug.
  const nameCounts = new Map();
  for (const f of features) {
    const key = normaliseName(f.name);
    if (f.nameIsDescriptive) continue;
    nameCounts.set(key, (nameCounts.get(key) || 0) + 1);
  }
  for (const f of features) {
    const n = nameCounts.get(normaliseName(f.name));
    if (!f.nameIsDescriptive && n > 1) {
      f.metadata = { ...f.metadata, 'Name in source': `used by ${n} separate features in the OSM data` };
    }
  }

  const boundary = features.find((f) => f.kind === CAMPUS_FEATURE_KIND.BOUNDARY) || null;

  // ── Pass 6: what the extract reached past the campus (§46, §49) ──────────
  //
  // An Overpass query is a BOUNDING BOX, not a campus. RNSIT's export happened
  // to be drawn tight around the site; JSSATE's returns a neighbouring reserve
  // forest, two city postal-code relations and a temple down the hill. Most of
  // those carry no tag this map understands and are already excluded — but some
  // do, and drawing them silently would put another institution's buildings
  // inside "the JSSATE campus".
  //
  // Neither dropped nor hidden. They are real, correctly-attributed OSM
  // geometry, so they are imported and rendered; what is added here is the
  // STATEMENT that they lie outside the boundary, on the same principle the
  // supplemental importer already applies to its own points — reported, never
  // corrected (§49). A campus with no boundary reports nothing, because with
  // nothing to be outside of there is no claim to make.
  const outsideBoundary = [];
  if (boundary) {
    for (const f of features) {
      if (f.kind === CAMPUS_FEATURE_KIND.BOUNDARY) continue;
      if (touchesPolygon(f.geometry, boundary.geometry)) continue;
      outsideBoundary.push({ osmId: f.sourceId, name: f.name, kind: f.kind });
      f.metadata = {
        ...f.metadata,
        'Campus boundary': 'Outside — this feature is in the extract but not inside the campus boundary',
      };
    }
  }

  return { features, excluded, unlabelled, conflicts, outsideBoundary, boundary };
}

function buildMetadata({ classification, tags, sourceName, height }) {
  const meta = {};

  if (!sourceName) meta['Name in source'] = 'Not present — this feature is unnamed in OpenStreetMap';

  if (classification.categoryFrom) {
    meta['Classified from'] =
      classification.categoryBasis === CATEGORY_BASIS.SOURCE_NAME
        ? `${classification.categoryFrom} — derived from the name, not from a tag`
        : classification.categoryFrom;
  }

  if (height) {
    if (height.levels) meta['Levels'] = `${height.levels} (OpenStreetMap building:levels)`;
    meta['Measured height'] =
      height.actualHeight !== null ? `${height.actualHeight} m (OpenStreetMap, unverified)` : 'Not in source data';
    meta['Drawn height'] = `${height.renderHeight} m — ${HEIGHT_BASIS_NOTE[height.basis]}`;
  }

  if (classification.conflict) meta['Tag conflict'] = classification.conflict;

  for (const [k, v] of Object.entries(interestingTags(tags))) {
    if (k === 'building:levels') continue; // already reported as Levels
    meta[humanise(k)] = v;
  }

  meta['OSM element'] = tags['@id'] || '(unknown)';
  return meta;
}

// ── Data quality report (§61) ────────────────────────────────────────────────

/**
 * Summarise a raw OSM collection and the import of it.
 * Consumed by the architecture tests and by the implementation report.
 */
export function describeOsmImport(collection, { dataset = OSM_DATASET } = {}) {
  const result = importOsmCampus(collection, { dataset });
  const source = Array.isArray(collection?.features) ? collection.features : [];

  const count = (pred) => result.features.filter(pred).length;
  const buildings = result.features.filter((f) => f.kind === CAMPUS_FEATURE_KIND.BUILDING);

  return {
    sourceFeatures: source.length,
    sourceGeometryTypes: source.reduce((acc, f) => {
      const t = f?.geometry?.type || 'none';
      acc[t] = (acc[t] || 0) + 1;
      return acc;
    }, {}),
    imported: result.features.length,
    excluded: result.excluded.length,
    boundary: result.boundary ? 1 : 0,
    buildings: buildings.length,
    namedBuildings: buildings.filter((f) => !f.nameIsDescriptive).length,
    unnamedBuildings: buildings.filter((f) => f.nameIsDescriptive).length,
    roads: count((f) => f.kind === CAMPUS_FEATURE_KIND.ROAD),
    paths: count((f) => f.kind === CAMPUS_FEATURE_KIND.PATH),
    steps: count((f) => f.pathClass === PATH_CLASS.STEPS),
    landmarks: count((f) => f.kind === CAMPUS_FEATURE_KIND.LANDMARK),
    facilities: count((f) => f.kind === CAMPUS_FEATURE_KIND.FACILITY),
    sports: count((f) => f.category === CAMPUS_CATEGORY.SPORTS),
    withMeasuredHeight: buildings.filter((f) => typeof f.height === 'number').length,
    withoutMeasuredHeight: buildings.filter((f) => typeof f.height !== 'number').length,
    withLevels: buildings.filter((f) => typeof f.levels === 'number').length,
    labelled: count((f) => f.labelled),
    labelSuppressed: result.unlabelled.length,
    tagConflicts: result.conflicts.length,
    outsideBoundary: result.outsideBoundary.length,
    namedFeatures: result.features.filter((f) => !f.nameIsDescriptive).map((f) => f.name).sort(),
  };
}
