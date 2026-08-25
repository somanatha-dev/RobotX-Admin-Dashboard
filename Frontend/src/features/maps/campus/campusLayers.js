/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CAMPUS LAYERS — a validated CampusDefinition becomes Mapbox sources/layers
 *
 * Pure: this module produces GeoJSON and layer/paint SPECIFICATIONS. It never
 * touches a map. `useCampusLayer.js` installs what it returns. That split is
 * what lets the label hierarchy, the road hierarchy and the per-category
 * building palette be tested under plain Node with no WebGL (§56).
 *
 *   CampusDefinition ──► 4 GeoJSON sources ──► layers
 *                          areas   (boundary, building footprints)
 *                          lines   (roads, paths)
 *                          points  (gates, landmarks, facilities, centre)
 *                          labels  (one anchor per labelled feature)
 *
 * ── Performance (§41) ─────────────────────────────────────────────────────
 * Campus geography is STATIC. It becomes four GeoJSON sources and a fixed set
 * of layers, installed once and updated with `setData` only when the campus
 * itself changes. No DOM element is created per building or per label — a
 * thousand-feature campus costs the same number of layers as an empty one.
 * Robot markers stay DOM, because they are dynamic and must draw above the
 * WebGL canvas.
 *
 * ── On extruded height (§29) ──────────────────────────────────────────────
 * A building extrudes to the height its record carries. A building whose
 * record has no height renders as a flat footprint, not as a guessed volume.
 * A wrong building height is a wrong sight-line on an operations map.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import {
  CAMPUS_FEATURE_KIND,
  CAMPUS_CATEGORY,
  OPERATIONAL_ROLE,
  OPERATIONAL_PRIORITY,
  ROAD_CLASS,
  PATH_CLASS,
  LABEL_PRIORITY,
  isVerified,
  labelMinZoomFor,
  operationalPriorityFor,
} from './campusSchema.js';

// ── Source and layer ids ─────────────────────────────────────────────────────

export const CAMPUS_SOURCE = Object.freeze({
  AREAS: 'robotx-campus-areas',
  LINES: 'robotx-campus-lines',
  POINTS: 'robotx-campus-points',
  LABELS: 'robotx-campus-labels',
  /** The boundary polygon alone, feeding the vendor-geometry clip (§6, §37). */
  CLIP: 'robotx-campus-clip',
});

export const CAMPUS_LAYER = Object.freeze({
  VENDOR_CLIP: 'robotx-campus-vendor-clip',
  /** A ring around gates only — see the gate treatment note on POINTS (§3B). */
  GATE_RING: 'robotx-campus-gate-ring',
  /**
   * The selected feature's label, on its own layer so it can ignore collisions.
   *
   * §3K: *Always prioritize: selected feature.* A sort key only wins a
   * collision it is IN — a selected building whose label was already dropped at
   * this zoom is not competing at all, so raising its rank changes nothing. A
   * dedicated layer with `text-allow-overlap` is the only thing that guarantees
   * the thing an operator just clicked is the thing they can read. Its filter
   * is set imperatively from the selection; with nothing selected it matches
   * nothing and costs nothing.
   */
  LABEL_SELECTED: 'robotx-campus-label-selected',
  BOUNDARY_FILL: 'robotx-campus-boundary-fill',
  BOUNDARY_LINE: 'robotx-campus-boundary-line',
  GROUND_FILL: 'robotx-campus-ground-fill',
  GROUND_LINE: 'robotx-campus-ground-line',
  BUILDINGS: 'robotx-campus-buildings',
  ROAD_MAIN_CASING: 'robotx-campus-road-main-casing',
  ROAD_MAIN: 'robotx-campus-road-main',
  ROAD_SECONDARY_CASING: 'robotx-campus-road-secondary-casing',
  ROAD_SECONDARY: 'robotx-campus-road-secondary',
  ROAD_SERVICE: 'robotx-campus-road-service',
  PATH: 'robotx-campus-path',
  STEPS: 'robotx-campus-steps',
  POINTS: 'robotx-campus-points-circle',
  LABEL_P1: 'robotx-campus-label-p1',
  LABEL_P2: 'robotx-campus-label-p2',
  LABEL_P3: 'robotx-campus-label-p3',
});

/** Every layer this module owns, in draw order (first = bottom). */
export const CAMPUS_LAYER_ORDER = Object.freeze([
  // The clip goes in first so everything the basemap draws sits beneath it.
  CAMPUS_LAYER.VENDOR_CLIP,
  CAMPUS_LAYER.BOUNDARY_FILL,
  CAMPUS_LAYER.BOUNDARY_LINE,
  // Grounds are painted ON the earth, under everything the campus builds on it.
  CAMPUS_LAYER.GROUND_FILL,
  CAMPUS_LAYER.GROUND_LINE,
  CAMPUS_LAYER.ROAD_MAIN_CASING,
  CAMPUS_LAYER.ROAD_SECONDARY_CASING,
  CAMPUS_LAYER.ROAD_SERVICE,
  CAMPUS_LAYER.ROAD_SECONDARY,
  CAMPUS_LAYER.ROAD_MAIN,
  CAMPUS_LAYER.PATH,
  CAMPUS_LAYER.STEPS,
  // Extrusions last among the geometry: a building stands ON the road surface,
  // and drawing it after the roads is what makes the contact read correctly.
  CAMPUS_LAYER.BUILDINGS,
  // The gate ring sits under the point markers so the dot stays the thing that
  // is read; the ring only says "this one is a way on and off the site".
  CAMPUS_LAYER.GATE_RING,
  CAMPUS_LAYER.POINTS,
  CAMPUS_LAYER.LABEL_P3,
  CAMPUS_LAYER.LABEL_P2,
  CAMPUS_LAYER.LABEL_P1,
  CAMPUS_LAYER.LABEL_SELECTED,
]);

/** Layers whose features answer a click with a details card (§43). */
export const CAMPUS_INTERACTIVE_LAYERS = Object.freeze([
  CAMPUS_LAYER.BUILDINGS,
  CAMPUS_LAYER.POINTS,
  CAMPUS_LAYER.GROUND_FILL,
]);

/**
 * Which source a feature belongs in.
 *
 * Routing is by GEOMETRY, not only by kind: OSM maps a landmark as a node in
 * one place and as a footprint in another (RNSIT's fountain and statue are
 * polygons; a gate would be a node), and a circle layer draws nothing at all
 * for a polygon. So a landmark with an area becomes an area, and a landmark
 * with a position becomes a point, and both stay the same KIND.
 */
const AREA_KINDS = new Set([CAMPUS_FEATURE_KIND.BOUNDARY, CAMPUS_FEATURE_KIND.BUILDING]);
const LINE_KINDS = new Set([CAMPUS_FEATURE_KIND.ROAD, CAMPUS_FEATURE_KIND.PATH]);
const POINT_KINDS = new Set([
  CAMPUS_FEATURE_KIND.GATE,
  CAMPUS_FEATURE_KIND.LANDMARK,
  CAMPUS_FEATURE_KIND.FACILITY,
  CAMPUS_FEATURE_KIND.OPERATIONAL_POINT,
  CAMPUS_FEATURE_KIND.CAMPUS_CENTER,
]);

const AREA_GEOMETRY = new Set(['Polygon', 'MultiPolygon']);

/** `areas` | `lines` | `points` | null — the source this feature draws from. */
export function sourceRoleFor(feature) {
  const kind = feature?.kind;
  const type = feature?.geometry?.type;
  if (AREA_KINDS.has(kind)) return 'areas';
  if (LINE_KINDS.has(kind)) return 'lines';
  if (POINT_KINDS.has(kind)) return AREA_GEOMETRY.has(type) ? 'areas' : 'points';
  return null;
}

// ── GeoJSON ──────────────────────────────────────────────────────────────────

export const EMPTY_COLLECTION = Object.freeze({ type: 'FeatureCollection', features: Object.freeze([]) });

function featureProperties(f) {
  return {
    id: f.id,
    name: f.name,
    shortName: f.shortName || null,
    kind: f.kind,
    category: f.category || CAMPUS_CATEGORY.UNCLASSIFIED,
    roadClass: f.roadClass || null,
    pathClass: f.pathClass || null,
    labelPriority: Number(f.labelPriority) || LABEL_PRIORITY.DETAIL,
    // ── The operational hierarchy, as style inputs (§3C, §3K) ────────────
    // Derived once at import (`semantics/campusOperational.js`) and carried
    // through as data, so no layer expression ever asks what a feature IS —
    // it asks what rank it holds. A definition built before this existed still
    // renders: every field falls back to the neutral, non-operational value.
    operationalRole: f.operationalRole || OPERATIONAL_ROLE.NONE,
    operationalPriority: Number(f.operationalPriority) || operationalPriorityFor(f.operationalRole),
    /** Lower wins a label collision. */
    labelRank: Number(f.labelRank) || operationalPriorityFor(f.operationalRole),
    /** Marker size multiplier — 1 is an ordinary POI. */
    poiScale: typeof f.poiScale === 'number' ? f.poiScale : 1,
    /** Drives the calm "checked" treatment in the UI, never a warning colour. */
    verified: isVerified(f),
    // ── The two heights (§38) ────────────────────────────────────────────
    // `height` is only present when the record carries a MEASURED one, and it
    // exists here so an operator's details card can show it. `renderHeight` is
    // what the extrusion actually reads: a drawing decision, always present for
    // a building, never presented as a measurement. `has` is what the
    // expression branches on, so a feature with neither draws flat rather than
    // guessed.
    ...(typeof f.height === 'number' ? { height: f.height } : {}),
    ...(typeof f.renderHeight === 'number' ? { renderHeight: f.renderHeight } : {}),
    provenance: f.provenance,
    verification: f.verification,
    source: f.source,
  };
}

function toGeoJsonFeature(f) {
  return { type: 'Feature', id: f.id, geometry: f.geometry, properties: featureProperties(f) };
}

function collect(features) {
  return { type: 'FeatureCollection', features };
}

/**
 * Representative interior point for a label anchor.
 *
 * The mean of a polygon's outer ring — derived from authoritative geometry,
 * never a guess. For a Point it is the point itself. Returns null for anything
 * it cannot derive one from, and that feature simply carries no label.
 */
export function labelAnchorFor(geometry) {
  const t = geometry?.type;
  const c = geometry?.coordinates;
  if (t === 'Point') return Array.isArray(c) ? [c[0], c[1]] : null;

  let ring = null;
  if (t === 'Polygon') ring = c?.[0];
  else if (t === 'MultiPolygon') ring = c?.[0]?.[0];
  else if (t === 'LineString') ring = c;
  else if (t === 'MultiLineString') ring = c?.[0];
  if (!Array.isArray(ring) || ring.length === 0) return null;

  // A closed ring repeats its first position last; excluding the duplicate
  // keeps the mean from being pulled toward that vertex.
  const isClosed =
    ring.length > 2 &&
    Array.isArray(ring[0]) &&
    Array.isArray(ring[ring.length - 1]) &&
    ring[0][0] === ring[ring.length - 1][0] &&
    ring[0][1] === ring[ring.length - 1][1];
  const pts = isClosed ? ring.slice(0, -1) : ring;

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

/**
 * Should this feature's name be drawn on the map?
 *
 * Three ways to answer no, and all three are data, not styling:
 *
 *   • a BOUNDARY is an area of ground, not a place — labelling one puts a name
 *     in the middle of the campus that belongs to no building;
 *   • `labelled: false` was set upstream, either because the source never named
 *     the feature (§4 — an unnamed building is not given an invented identity)
 *     or because an identically-named feature metres away already carries the
 *     label (§13);
 *   • there is no anchor to derive from its geometry.
 *
 * The feature itself is still rendered, still clickable and still searchable in
 * every one of those cases. Only the text is withheld.
 */
export function isLabelled(feature) {
  if (feature?.kind === CAMPUS_FEATURE_KIND.BOUNDARY) return false;
  if (feature?.labelled === false) return false;
  return true;
}

/**
 * Does this feature draw its own marker?
 *
 * `false` for a record that is co-located with another — two markers stacked
 * pixel-for-pixel are a rendering artefact, not information (§5). RNS Evening
 * College shares an exact coordinate with RNS FIRST GRADE COLLEGE and declares
 * it via `coLocatedWith`, so it surrenders its marker and its label to that
 * feature. It keeps everything else: it is still a campus feature, still in the
 * search index, still openable in the details card, and its coordinate is
 * unchanged. Only the duplicate dot is withheld.
 */
export function rendersOwnMarker(feature) {
  return feature?.rendersOwnMarker !== false;
}

/** The five GeoJSON collections a campus definition produces. */
export function campusCollections(definition) {
  const features = Array.isArray(definition?.features) ? definition.features : [];

  const areas = [];
  const lines = [];
  const points = [];
  const labels = [];
  const clip = [];

  for (const f of features) {
    const gj = toGeoJsonFeature(f);
    const role = sourceRoleFor(f);
    if (role === 'areas') areas.push(gj);
    else if (role === 'lines') lines.push(gj);
    else if (role === 'points' && rendersOwnMarker(f)) points.push(gj);

    // The clip source carries the campus boundary and nothing else: it defines
    // WHERE the campus dataset takes precedence over the vendor's own 3D
    // models, and a second polygon in it would silently extend that area.
    if (f.kind === CAMPUS_FEATURE_KIND.BOUNDARY && AREA_GEOMETRY.has(f.geometry?.type)) {
      clip.push(gj);
    }

    if (!isLabelled(f)) continue;

    const anchor = labelAnchorFor(f.geometry);
    if (anchor) {
      labels.push({
        type: 'Feature',
        id: `${f.id}--label`,
        geometry: { type: 'Point', coordinates: anchor },
        properties: featureProperties(f),
      });
    }
  }

  return {
    [CAMPUS_SOURCE.AREAS]: collect(areas),
    [CAMPUS_SOURCE.LINES]: collect(lines),
    [CAMPUS_SOURCE.POINTS]: collect(points),
    [CAMPUS_SOURCE.LABELS]: collect(labels),
    [CAMPUS_SOURCE.CLIP]: collect(clip),
  };
}

// ── Style expressions ────────────────────────────────────────────────────────

/** Ground-proportionate line width: the same road reads the same at any zoom. */
function roadWidth(scale) {
  return [
    'interpolate',
    ['linear'],
    ['zoom'],
    13, 0.8 * scale,
    15, 2.4 * scale,
    17, 7 * scale,
    19, 20 * scale,
  ];
}

function buildingColorExpression(palette) {
  const cases = [];
  for (const key of Object.keys(CAMPUS_CATEGORY)) {
    if (key === CAMPUS_CATEGORY.UNCLASSIFIED) continue;
    cases.push(key, palette[key]);
  }
  return ['match', ['get', 'category'], ...cases, palette.UNCLASSIFIED];
}

/**
 * Ground areas — a sports field, a court, a parking apron — read by what they
 * ARE, from the same category vocabulary the buildings use. Restrained, and
 * deliberately quieter than the buildings above them (§11, §47).
 */
function groundColorExpression(palette) {
  return [
    'match',
    ['get', 'category'],
    CAMPUS_CATEGORY.SPORTS, palette.SPORTS,
    CAMPUS_CATEGORY.OPERATIONAL, palette.OPERATIONAL,
    CAMPUS_CATEGORY.RELIGIOUS, palette.OTHER,
    CAMPUS_CATEGORY.COMMERCIAL, palette.OTHER,
    palette.OTHER,
  ];
}

/**
 * Paint/layout values for every campus layer, for one theme.
 *
 * Returned as `{ layerId: { paint: {...}, layout: {...} } }` and applied
 * property-by-property, which is what makes a theme TRANSITION possible: the
 * same function is called with an interpolated theme on every animation frame
 * and the map is updated in place — no layer is removed, re-added or reloaded
 * (§20, §23).
 */
export function campusStyleForTheme(theme, reveal = 1, emphasis = 0) {
  const c = theme.campus;
  const r = theme.roads;
  const l = theme.labels;

  // The campus arrival reveal (§25). One multiplier over every opacity, so the
  // semantic layer fades up as the camera settles instead of appearing whole
  // the instant the filter changes. At 1 it is a no-op.
  const v = Math.max(0, Math.min(1, typeof reveal === 'number' && Number.isFinite(reveal) ? reveal : 1));
  const o = (value) => value * v;

  /**
   * ── Operations emphasis (§3H) ────────────────────────────────────────────
   * 0 = the campus as a place. 1 = the campus as a worksite.
   *
   * It is a MIX, not a switch, so the mode change animates on the same
   * frame-by-frame path every other theme value does, and so "how much" is one
   * number rather than a second set of colours to keep in sync.
   *
   * What it must not do is hide the campus (§3H says so twice). So nothing is
   * removed and nothing is turned off: the building mass and the ground drop
   * ONE step so the operational overlay separates from them, the POIs the fleet
   * has no business with recede, and the roads — which are how an operator
   * reads where a unit can go — are left completely alone.
   */
  const e = Math.max(0, Math.min(1, typeof emphasis === 'number' && Number.isFinite(emphasis) ? emphasis : 0));
  /** Mix from the normal value toward the operations value. */
  const em = (normal, operations) => normal + (operations - normal) * e;

  /**
   * Is this feature something the fleet operates on? Used to recede the
   * scenery rather than to promote the work: a landmark stays on the map, at
   * a lower opacity, because an operator still navigates by it.
   */
  const isOperational = ['<', ['coalesce', ['get', 'operationalPriority'], OPERATIONAL_PRIORITY.NONE], OPERATIONAL_PRIORITY.NONE];

  /** Marker size multiplier, defaulting to an ordinary POI. */
  const poiScale = ['coalesce', ['get', 'poiScale'], 1];

  /**
   * Read a theme number, with the value this layer had before that key existed.
   *
   * Mid-transition frames are produced by walking two theme trees, and a key
   * present in only one of them is carried across verbatim — so a theme (or a
   * hand-built frame in a test) that predates one of the lighting keys must
   * still produce a complete, applicable paint value rather than `undefined`,
   * which Mapbox accepts silently and then renders as black (§28).
   */
  const num = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
  const hex = (value, fallback) => (typeof value === 'string' && value ? value : fallback);

  /**
   * ── Emissive strength (§59) ──────────────────────────────────────────────
   * How much of this layer's colour survives the scene's lighting. Standard is
   * a lit style: at 0 (the spec default) a colour is multiplied by whatever
   * light is falling on it, which is why a near-white night road rendered grey.
   * The theme states it per layer so "lit by the sun" and "lit by street
   * lighting" are different, deliberate answers rather than one global fudge.
   */
  const emissive = (value, fallback = 0) => num(value, fallback);

  /** Selected features brighten rather than glow (§36). */
  const withSelection = (base, highlight) => [
    'case',
    ['boolean', ['feature-state', 'selected'], false],
    highlight,
    base,
  ];

  const labelPaint = (secondary, opacity = 1) => ({
    'text-color': secondary ? l.secondaryColor : l.color,
    'text-halo-color': l.halo,
    'text-halo-width': l.haloWidth,
    'text-halo-blur': 0.4,
    'text-opacity': o(opacity),
  });

  return {
    [CAMPUS_LAYER.BOUNDARY_FILL]: {
      paint: {
        'fill-color': c.boundaryFill,
        'fill-opacity': o(c.boundaryFillOpacity),
        'fill-emissive-strength': emissive(c.groundEmissive),
      },
    },
    [CAMPUS_LAYER.BOUNDARY_LINE]: {
      paint: {
        'line-color': c.boundaryLine,
        'line-opacity': o(c.boundaryLineOpacity),
        'line-width': ['interpolate', ['linear'], ['zoom'], 13, 1, 17, 2.4],
        'line-dasharray': [3, 2],
        'line-emissive-strength': emissive(c.groundEmissive),
      },
    },
    [CAMPUS_LAYER.GROUND_FILL]: {
      paint: {
        'fill-color': withSelection(groundColorExpression(c.ground), c.buildingHighlight),
        'fill-opacity': o(em(c.groundOpacity, c.groundOpacity * 0.78)),
        'fill-emissive-strength': emissive(c.groundEmissive),
      },
    },
    [CAMPUS_LAYER.GROUND_LINE]: {
      paint: {
        'line-color': c.groundEdge,
        'line-opacity': o(c.groundEdgeOpacity),
        'line-width': ['interpolate', ['linear'], ['zoom'], 15, 0.6, 18, 1.4],
        'line-emissive-strength': emissive(c.groundEmissive),
      },
    },
    [CAMPUS_LAYER.BUILDINGS]: {
      paint: {
        'fill-extrusion-color': withSelection(buildingColorExpression(c.buildings), c.buildingHighlight),
        // One step back in Operations, never off: an operator still reads the
        // route against the buildings it runs between (§3H).
        'fill-extrusion-opacity': o(em(c.buildingOpacity, c.buildingOpacity * 0.86)),
        // ── What this height IS (§8, §38) ────────────────────────────────
        // `renderHeight` — a DRAWING value. For RNSIT it comes from OSM
        // `building:levels` where the source has them and from a conservative
        // default where it does not, and the details card captions it as such
        // every time. A feature carrying neither draws FLAT rather than
        // guessed, which is why this branches on `has` instead of coalescing
        // to a number.
        //
        // Grown across the zoom band where volume starts to mean something, so
        // buildings rise out of the ground instead of popping into existence.
        'fill-extrusion-height': [
          'interpolate',
          ['linear'],
          ['zoom'],
          14, 0,
          16, ['case', ['has', 'renderHeight'], ['get', 'renderHeight'], ['case', ['has', 'height'], ['get', 'height'], 0]],
        ],
        'fill-extrusion-base': 0,
        // ── What gives a low block its volume (§11, §46) ──────────────────
        // The vertical gradient darkens each face toward its base; the ambient
        // occlusion lays the contact shading where walls meet the ground.
        //
        // `-ground-radius` / `-wall-radius` are the forms Mapbox reads when the
        // style has `lights` — which Standard always does — and the legacy
        // `-radius` is kept for a style that has none. The GROUND radius is how
        // far the shading reaches away from the wall, which is the honest way
        // to lengthen a shadow at a low sun: it is the building's own occlusion
        // extending, not a drawn shape standing in for one (§24, §26).
        //
        // Real cast shadows are left to the style's own directional light,
        // which `fill-extrusion-cast-shadows` opts into by default — a low
        // preset (Evening's `dawn`) therefore throws genuinely long ones
        // without this layer claiming a sun position of its own.
        'fill-extrusion-vertical-gradient': true,
        'fill-extrusion-ambient-occlusion-intensity': num(c.buildingAoIntensity, 0.28),
        'fill-extrusion-ambient-occlusion-radius': num(c.buildingAoRadius, 3.2),
        'fill-extrusion-ambient-occlusion-ground-radius': num(c.buildingAoGroundRadius, 3.2),
        'fill-extrusion-ambient-occlusion-wall-radius': num(c.buildingAoWallRadius, 3.2),
        // Self-lit fraction — zero by day, meaningful at night (§59).
        'fill-extrusion-emissive-strength': emissive(c.buildingEmissive),
        // Light pooling at the foot of a building. Zero by day, so this costs
        // nothing where it would only look like a glow (§46).
        'fill-extrusion-flood-light-color': hex(c.floodColor, '#ffffff'),
        'fill-extrusion-flood-light-intensity': num(c.floodIntensity, 0),
        'fill-extrusion-flood-light-wall-radius': num(c.floodWallRadius, 0),
        'fill-extrusion-flood-light-ground-radius': num(c.floodGroundRadius, 0),
      },
    },
    [CAMPUS_LAYER.ROAD_MAIN_CASING]: {
      paint: {
        'line-color': r.main.casing,
        // Themed rather than fixed: a bright casing under a dark Day road is
        // load-bearing, a dark casing under a lit Night road is load-bearing,
        // and one hard-coded 0.7 cannot be both.
        'line-opacity': o(num(r.main.casingOpacity, 0.7)),
        'line-width': roadWidth(r.main.widthScale * num(r.main.casingScale, 1.45)),
        'line-emissive-strength': emissive(r.main.emissive),
      },
    },
    [CAMPUS_LAYER.ROAD_MAIN]: {
      paint: {
        'line-color': r.main.color,
        'line-opacity': o(r.main.opacity),
        'line-width': roadWidth(r.main.widthScale),
        'line-emissive-strength': emissive(r.main.emissive),
      },
    },
    [CAMPUS_LAYER.ROAD_SECONDARY_CASING]: {
      paint: {
        'line-color': r.secondary.casing,
        'line-opacity': o(num(r.secondary.casingOpacity, 0.6)),
        'line-width': roadWidth(r.secondary.widthScale * num(r.secondary.casingScale, 1.5)),
        'line-emissive-strength': emissive(r.secondary.emissive),
      },
    },
    [CAMPUS_LAYER.ROAD_SECONDARY]: {
      paint: {
        'line-color': r.secondary.color,
        'line-opacity': o(r.secondary.opacity),
        'line-width': roadWidth(r.secondary.widthScale),
        'line-emissive-strength': emissive(r.secondary.emissive),
      },
    },
    [CAMPUS_LAYER.ROAD_SERVICE]: {
      paint: {
        'line-color': r.service.color,
        'line-opacity': o(r.service.opacity),
        'line-width': roadWidth(r.service.widthScale),
        'line-emissive-strength': emissive(r.service.emissive),
      },
    },
    [CAMPUS_LAYER.PATH]: {
      paint: {
        'line-color': r.path.color,
        'line-opacity': o(r.path.opacity),
        'line-width': roadWidth(r.path.widthScale),
        // A dash is the cheapest unambiguous "this is not a road" signal, and
        // survives every theme without relying on colour alone.
        'line-dasharray': [1.6, 1.4],
        'line-emissive-strength': emissive(r.path.emissive),
      },
    },
    [CAMPUS_LAYER.STEPS]: {
      paint: {
        'line-color': r.steps.color,
        'line-opacity': o(r.steps.opacity),
        'line-width': roadWidth(r.steps.widthScale),
        // Rungs, not dashes. A flight of steps is not a surface a ground robot
        // can route over, so it must not read as a thinner footpath — an
        // operator planning around one needs to see the difference (§17).
        'line-dasharray': [0.35, 0.55],
        'line-emissive-strength': emissive(r.steps.emissive),
      },
    },
    // ── The gate ring (§3B) ──────────────────────────────────────────────
    // A gate must be recognisable at a glance and must not be huge — a marker
    // that outgrows the robot beside it is a defect, because the robot is what
    // the operator is reading (§3E). A ring says "this one is different" using
    // shape rather than size: the dot stays a dot, and a hollow circle around
    // it costs no extra area of attention. It is the ONLY campus feature that
    // gets one.
    [CAMPUS_LAYER.GATE_RING]: {
      paint: {
        'circle-color': c.gate,
        // Hollow. A filled disc this size would be the loudest object on the
        // campus; an outline is a badge.
        'circle-opacity': 0,
        'circle-stroke-color': c.gate,
        'circle-stroke-opacity': o(em(0.55, 0.85)),
        'circle-stroke-width': 1.4,
        'circle-emissive-strength': emissive(c.pointEmissive),
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 6, 17, 11, 19, 15],
      },
    },
    [CAMPUS_LAYER.POINTS]: {
      paint: {
        // ── The one POI that outranks the others (§8, §15, §3C) ───────────
        // A gate is where a fleet enters and leaves the site, so it keeps its
        // own colour and its ring. Everything else shares the neutral
        // treatment and separates by SIZE alone, from the operational scale
        // derived at import — because a map where every category has its own
        // colour is a map where none of them means anything.
        'circle-color': withSelection(
          ['case', ['==', ['get', 'kind'], CAMPUS_FEATURE_KIND.GATE], c.gate, c.buildingRoof],
          c.buildingHighlight
        ),
        'circle-stroke-color': withSelection(
          ['case', ['==', ['get', 'kind'], CAMPUS_FEATURE_KIND.GATE], c.gateEdge, c.buildingEdge],
          c.buildingHighlight
        ),
        'circle-stroke-width': ['case', ['==', ['get', 'kind'], CAMPUS_FEATURE_KIND.GATE], 2.4, 1.5],
        // In Operations the scenery recedes and the working locations do not.
        // Nothing disappears: the floor is 0.45, which is still clearly a
        // marker on the map (§3H — do not hide the campus).
        'circle-opacity': ['case', isOperational, o(0.92), o(em(0.9, 0.45))],
        'circle-stroke-opacity': ['case', isOperational, o(1), o(em(1, 0.5))],
        // A gate dot is a few pixels across. Unlit at night it is the first
        // thing the scene lighting loses, and a gate an operator cannot find
        // is the one POI that matters (§15, §59).
        'circle-emissive-strength': emissive(c.pointEmissive),
        // Deliberately small. These markers sit under the robot layer and must
        // not compete with it — a robot is the thing an operator is reading
        // (§16), and a POI that draws the eye first is a defect, not a feature.
        // `poiScale` is 1 for an ordinary location and at most 1.45 for a gate.
        //
        // The multiplication is inside each STOP, not wrapped around the
        // interpolate. `["zoom"]` may only be the input of a top-level `step`
        // or `interpolate`, so `['*', interpolate(zoom), scale]` is rejected by
        // the style spec — quietly, on a live map, by `applyStyle`'s try/catch,
        // which is precisely why `campusStyleSpec.test.mjs` runs these layers
        // through the vendor's own validator.
        'circle-radius': [
          'interpolate',
          ['linear'],
          ['zoom'],
          13, ['*', 2.5, poiScale],
          17, ['*', 4.5, poiScale],
          19, ['*', 6, poiScale],
        ],
      },
      layout: {
        // Operational markers draw above the scenery, so a landmark dot can
        // never cover the way onto the site. (`circle-sort-key` is layout, not
        // paint — setting it as paint fails silently and the order never
        // applies.) Negated because a HIGHER sort key draws later, i.e. on top,
        // while a LOWER operational priority means more important.
        'circle-sort-key': ['-', 0, ['coalesce', ['get', 'operationalPriority'], OPERATIONAL_PRIORITY.NONE]],
      },
    },
    [CAMPUS_LAYER.LABEL_P1]: {
      paint: labelPaint(false),
      layout: { 'text-size': ['interpolate', ['linear'], ['zoom'], 13.5, 12 * l.sizeScale, 18, 16 * l.sizeScale] },
    },
    [CAMPUS_LAYER.LABEL_P2]: {
      paint: labelPaint(false),
      layout: { 'text-size': ['interpolate', ['linear'], ['zoom'], 15.5, 11 * l.sizeScale, 18, 13.5 * l.sizeScale] },
    },
    [CAMPUS_LAYER.LABEL_P3]: {
      // The detail band is where clutter lives — toilets, an ATM cabin, a
      // fountain. In Operations it steps back rather than disappearing, so the
      // map gets quieter without the operator losing the ability to read it.
      paint: labelPaint(true, em(1, 0.62)),
      layout: { 'text-size': ['interpolate', ['linear'], ['zoom'], 17, 10 * l.sizeScale, 19, 12 * l.sizeScale] },
    },
    [CAMPUS_LAYER.LABEL_SELECTED]: {
      paint: {
        ...labelPaint(false, 1),
        // A slightly stronger halo, because this label is deliberately allowed
        // to overlap its neighbours and has to stay readable where it lands.
        'text-halo-width': l.haloWidth + 0.5,
      },
      layout: { 'text-size': ['interpolate', ['linear'], ['zoom'], 13, 12 * l.sizeScale, 18, 14.5 * l.sizeScale] },
    },
  };
}

// ── Layer specifications ─────────────────────────────────────────────────────

function labelLayerSpec(id, priority, uppercase) {
  return {
    id,
    type: 'symbol',
    source: CAMPUS_SOURCE.LABELS,
    // ── The label hierarchy (§9) ──────────────────────────────────────────
    // Each priority is its own layer purely so it can carry its own `minzoom`:
    // the Mapbox style spec does not accept a `zoom` expression inside a
    // `filter`, so a single layer could not gate features by zoom per feature.
    minzoom: labelMinZoomFor(priority),
    filter: ['==', ['get', 'labelPriority'], priority],
    layout: {
      'text-field': uppercase
        ? ['upcase', ['coalesce', ['get', 'shortName'], ['get', 'name']]]
        : ['get', 'name'],
      'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'],
      'text-anchor': 'center',
      'text-max-width': 9,
      'text-letter-spacing': uppercase ? 0.08 : 0.01,
      'text-padding': 4,
      // ── Which label survives a collision (§3K) ────────────────────────────
      // Lower sort key wins. This used to be `labelPriority`, which is the ZOOM
      // BAND — and every feature in one of these layers has the same band by
      // construction, so the key was constant and collisions were resolved by
      // whatever order the source happened to be in. `labelRank` is the
      // operational priority derived at import, so within a band the gate beats
      // the department, the department beats the fountain, and the answer comes
      // from the semantic model rather than from array order.
      'symbol-sort-key': ['coalesce', ['get', 'labelRank'], ['get', 'labelPriority']],
      'text-allow-overlap': false,
      'text-ignore-placement': false,
      // Labels are anchored to the world and reprojected by Mapbox every
      // frame, so they stay on their feature through pitch, rotate and zoom
      // (§10) — this is not an HTML list floating over the canvas.
      'text-pitch-alignment': 'viewport',
      'text-rotation-alignment': 'viewport',
    },
  };
}

/**
 * Every campus layer, in draw order, with theme-independent structure.
 * Paint values come from `campusStyleForTheme` and are applied after adding.
 */
export function campusLayerSpecs() {
  const line = (id, filter) => ({
    id,
    type: 'line',
    source: CAMPUS_SOURCE.LINES,
    filter,
    layout: { 'line-join': 'round', 'line-cap': 'round' },
  });

  const isRoad = (cls) => [
    'all',
    ['==', ['get', 'kind'], CAMPUS_FEATURE_KIND.ROAD],
    ['==', ['get', 'roadClass'], cls],
  ];

  // Steps are the special case; a path that does not declare a class is an
  // ordinary footway, so a dataset with no `pathClass` at all still renders
  // every path rather than silently rendering none.
  const isSteps = [
    'all',
    ['==', ['get', 'kind'], CAMPUS_FEATURE_KIND.PATH],
    ['==', ['get', 'pathClass'], PATH_CLASS.STEPS],
  ];
  const isFootway = [
    'all',
    ['==', ['get', 'kind'], CAMPUS_FEATURE_KIND.PATH],
    ['!=', ['get', 'pathClass'], PATH_CLASS.STEPS],
  ];

  // Everything in the areas source that is neither the site perimeter nor a
  // building: sports grounds, courts, parking aprons, the statue plinth.
  const isGround = [
    'all',
    ['!=', ['get', 'kind'], CAMPUS_FEATURE_KIND.BOUNDARY],
    ['!=', ['get', 'kind'], CAMPUS_FEATURE_KIND.BUILDING],
  ];

  return [
    // ── The precedence mechanism (§6, §37) ────────────────────────────────
    // A `clip` layer scoped to the basemap import removes the VENDOR's 3D
    // models — its generic extruded buildings, landmarks and trees — and its
    // labels, inside this polygon and nowhere else. Outside the boundary the
    // basemap is completely untouched, which is what keeps Bengaluru's context
    // intact while the campus dataset becomes authoritative within its own
    // perimeter (§57). Installed by `useCampusLayer` with a scope-less retry,
    // because losing the clip must not cost the campus its geometry.
    {
      id: CAMPUS_LAYER.VENDOR_CLIP,
      type: 'clip',
      source: CAMPUS_SOURCE.CLIP,
      // Below this the campus is a few pixels across and there is nothing to
      // clip that anyone could see; the campus layers themselves fade in from
      // 14 (§30).
      minzoom: 14,
      layout: {
        'clip-layer-types': ['model', 'symbol'],
        'clip-layer-scope': ['basemap'],
      },
    },
    {
      id: CAMPUS_LAYER.BOUNDARY_FILL,
      type: 'fill',
      source: CAMPUS_SOURCE.AREAS,
      filter: ['==', ['get', 'kind'], CAMPUS_FEATURE_KIND.BOUNDARY],
    },
    {
      id: CAMPUS_LAYER.BOUNDARY_LINE,
      type: 'line',
      source: CAMPUS_SOURCE.AREAS,
      filter: ['==', ['get', 'kind'], CAMPUS_FEATURE_KIND.BOUNDARY],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
    },
    {
      id: CAMPUS_LAYER.GROUND_FILL,
      type: 'fill',
      source: CAMPUS_SOURCE.AREAS,
      filter: isGround,
    },
    {
      id: CAMPUS_LAYER.GROUND_LINE,
      type: 'line',
      source: CAMPUS_SOURCE.AREAS,
      filter: isGround,
      layout: { 'line-join': 'round' },
    },
    line(CAMPUS_LAYER.ROAD_MAIN_CASING, isRoad(ROAD_CLASS.MAIN)),
    line(CAMPUS_LAYER.ROAD_SECONDARY_CASING, isRoad(ROAD_CLASS.SECONDARY)),
    line(CAMPUS_LAYER.ROAD_SERVICE, isRoad(ROAD_CLASS.SERVICE)),
    line(CAMPUS_LAYER.ROAD_SECONDARY, isRoad(ROAD_CLASS.SECONDARY)),
    line(CAMPUS_LAYER.ROAD_MAIN, isRoad(ROAD_CLASS.MAIN)),
    line(CAMPUS_LAYER.PATH, isFootway),
    line(CAMPUS_LAYER.STEPS, isSteps),
    {
      id: CAMPUS_LAYER.BUILDINGS,
      type: 'fill-extrusion',
      source: CAMPUS_SOURCE.AREAS,
      filter: ['==', ['get', 'kind'], CAMPUS_FEATURE_KIND.BUILDING],
    },
    {
      id: CAMPUS_LAYER.GATE_RING,
      type: 'circle',
      source: CAMPUS_SOURCE.POINTS,
      // Higher than the POINTS floor: below this the ring and the dot are the
      // same few pixels and the badge reads as a fatter marker, not as a badge.
      minzoom: 14,
      filter: ['==', ['get', 'kind'], CAMPUS_FEATURE_KIND.GATE],
    },
    {
      id: CAMPUS_LAYER.POINTS,
      type: 'circle',
      source: CAMPUS_SOURCE.POINTS,
      minzoom: 13,
    },
    labelLayerSpec(CAMPUS_LAYER.LABEL_P3, LABEL_PRIORITY.DETAIL, false),
    labelLayerSpec(CAMPUS_LAYER.LABEL_P2, LABEL_PRIORITY.SECONDARY, false),
    labelLayerSpec(CAMPUS_LAYER.LABEL_P1, LABEL_PRIORITY.PRIMARY, true),
    selectedLabelLayerSpec(),
  ];
}

/**
 * The selected feature's label (§3K).
 *
 * Two things make it different from the banded layers: it has no `minzoom`, so
 * a selection made from search is readable the moment the camera arrives rather
 * than only past zoom 15.5; and it ignores collisions, so it cannot be the
 * label that gets dropped. Both are safe precisely because at most one feature
 * matches — the filter below matches NOTHING until `useCampusLayer` narrows it
 * to the selected id.
 */
export function selectedLabelLayerSpec() {
  return {
    id: CAMPUS_LAYER.LABEL_SELECTED,
    type: 'symbol',
    source: CAMPUS_SOURCE.LABELS,
    filter: selectedLabelFilter(null),
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'],
      'text-anchor': 'top',
      // Clear of the marker it belongs to, so the dot the operator just clicked
      // is not covered by the label naming it.
      'text-offset': [0, 0.9],
      'text-max-width': 11,
      'text-padding': 2,
      'text-allow-overlap': true,
      'text-ignore-placement': true,
      'text-pitch-alignment': 'viewport',
      'text-rotation-alignment': 'viewport',
    },
  };
}

/**
 * The filter that narrows the selected-label layer to one feature.
 *
 * With no selection it compares against a string no campus id can be — every id
 * is an OSM slug or a supplemental slug and none contains a space — so the
 * layer stays present, valid and drawing nothing. Far less fragile than adding
 * and removing a layer on every selection change, and it means the layer's
 * position in the draw order is fixed once, at install.
 */
export function selectedLabelFilter(featureId) {
  return ['==', ['get', 'id'], featureId ? String(featureId) : ' no selection '];
}
