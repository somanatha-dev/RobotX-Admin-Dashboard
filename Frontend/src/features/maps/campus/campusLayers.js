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
  ROAD_CLASS,
  PATH_CLASS,
  LABEL_PRIORITY,
  labelMinZoomFor,
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
  CAMPUS_LAYER.POINTS,
  CAMPUS_LAYER.LABEL_P3,
  CAMPUS_LAYER.LABEL_P2,
  CAMPUS_LAYER.LABEL_P1,
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
export function campusStyleForTheme(theme, reveal = 1) {
  const c = theme.campus;
  const r = theme.roads;
  const l = theme.labels;

  // The campus arrival reveal (§25). One multiplier over every opacity, so the
  // semantic layer fades up as the camera settles instead of appearing whole
  // the instant the filter changes. At 1 it is a no-op.
  const v = Math.max(0, Math.min(1, typeof reveal === 'number' && Number.isFinite(reveal) ? reveal : 1));
  const o = (value) => value * v;

  /** Selected features brighten rather than glow (§36). */
  const withSelection = (base, highlight) => [
    'case',
    ['boolean', ['feature-state', 'selected'], false],
    highlight,
    base,
  ];

  const labelPaint = (secondary) => ({
    'text-color': secondary ? l.secondaryColor : l.color,
    'text-halo-color': l.halo,
    'text-halo-width': l.haloWidth,
    'text-halo-blur': 0.4,
    'text-opacity': o(1),
  });

  return {
    [CAMPUS_LAYER.BOUNDARY_FILL]: {
      paint: { 'fill-color': c.boundaryFill, 'fill-opacity': o(c.boundaryFillOpacity) },
    },
    [CAMPUS_LAYER.BOUNDARY_LINE]: {
      paint: {
        'line-color': c.boundaryLine,
        'line-opacity': o(c.boundaryLineOpacity),
        'line-width': ['interpolate', ['linear'], ['zoom'], 13, 1, 17, 2.4],
        'line-dasharray': [3, 2],
      },
    },
    [CAMPUS_LAYER.GROUND_FILL]: {
      paint: {
        'fill-color': withSelection(groundColorExpression(c.ground), c.buildingHighlight),
        'fill-opacity': o(c.groundOpacity),
      },
    },
    [CAMPUS_LAYER.GROUND_LINE]: {
      paint: {
        'line-color': c.groundEdge,
        'line-opacity': o(c.groundEdgeOpacity),
        'line-width': ['interpolate', ['linear'], ['zoom'], 15, 0.6, 18, 1.4],
      },
    },
    [CAMPUS_LAYER.BUILDINGS]: {
      paint: {
        'fill-extrusion-color': withSelection(buildingColorExpression(c.buildings), c.buildingHighlight),
        'fill-extrusion-opacity': o(c.buildingOpacity),
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
        // Roof-to-wall contrast without a second layer: the vertical gradient
        // darkens each face toward its base, and the ambient occlusion lays a
        // short contact shadow where the walls meet the ground. Together they
        // are what stops a campus of low blocks reading as flat coloured
        // rectangles (§11) — no glow, no exaggerated shadow (§46).
        'fill-extrusion-vertical-gradient': true,
        'fill-extrusion-ambient-occlusion-intensity': c.buildingAoIntensity,
        'fill-extrusion-ambient-occlusion-radius': 3.2,
      },
    },
    [CAMPUS_LAYER.ROAD_MAIN_CASING]: {
      paint: { 'line-color': r.main.casing, 'line-opacity': o(0.7), 'line-width': roadWidth(r.main.widthScale * 1.45) },
    },
    [CAMPUS_LAYER.ROAD_MAIN]: {
      paint: {
        'line-color': r.main.color,
        'line-opacity': o(r.main.opacity),
        'line-width': roadWidth(r.main.widthScale),
      },
    },
    [CAMPUS_LAYER.ROAD_SECONDARY_CASING]: {
      paint: {
        'line-color': r.secondary.casing,
        'line-opacity': o(0.6),
        'line-width': roadWidth(r.secondary.widthScale * 1.5),
      },
    },
    [CAMPUS_LAYER.ROAD_SECONDARY]: {
      paint: {
        'line-color': r.secondary.color,
        'line-opacity': o(r.secondary.opacity),
        'line-width': roadWidth(r.secondary.widthScale),
      },
    },
    [CAMPUS_LAYER.ROAD_SERVICE]: {
      paint: {
        'line-color': r.service.color,
        'line-opacity': o(r.service.opacity),
        'line-width': roadWidth(r.service.widthScale),
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
      },
    },
    [CAMPUS_LAYER.POINTS]: {
      paint: {
        // ── The one POI that outranks the others (§8, §15) ────────────────
        // A gate is where a fleet enters and leaves the site, so it is the
        // only point marker given its own colour and a wider ring. Everything
        // else — facilities, parking, playgrounds, landmarks — shares the
        // neutral treatment, because a map where every category shouts is a
        // map where nothing does.
        'circle-color': withSelection(
          ['case', ['==', ['get', 'kind'], CAMPUS_FEATURE_KIND.GATE], c.gate, c.buildingRoof],
          c.buildingHighlight
        ),
        'circle-stroke-color': withSelection(
          ['case', ['==', ['get', 'kind'], CAMPUS_FEATURE_KIND.GATE], c.gateEdge, c.buildingEdge],
          c.buildingHighlight
        ),
        'circle-stroke-width': ['case', ['==', ['get', 'kind'], CAMPUS_FEATURE_KIND.GATE], 2.4, 1.5],
        'circle-opacity': o(0.9),
        'circle-stroke-opacity': o(1),
        // Deliberately small. These markers sit under the robot layer and must
        // not compete with it — a robot is the thing an operator is reading
        // (§16), and a POI that draws the eye first is a defect, not a feature.
        'circle-radius': [
          'interpolate',
          ['linear'],
          ['zoom'],
          13, ['case', ['==', ['get', 'kind'], CAMPUS_FEATURE_KIND.GATE], 3.5, 2.5],
          17, ['case', ['==', ['get', 'kind'], CAMPUS_FEATURE_KIND.GATE], 6.5, 4.5],
          19, ['case', ['==', ['get', 'kind'], CAMPUS_FEATURE_KIND.GATE], 8.5, 6],
        ],
      },
      layout: {
        // Gates draw above the other points so a facility marker can never
        // cover the way onto the site. (`circle-sort-key` is layout, not paint —
        // setting it as paint fails silently and the ordering never applies.)
        'circle-sort-key': ['case', ['==', ['get', 'kind'], CAMPUS_FEATURE_KIND.GATE], 1, 0],
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
      paint: labelPaint(true),
      layout: { 'text-size': ['interpolate', ['linear'], ['zoom'], 17, 10 * l.sizeScale, 19, 12 * l.sizeScale] },
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
      // Lower priority number wins a collision — the campus name survives, the
      // entrance label is the one that gets dropped.
      'symbol-sort-key': ['get', 'labelPriority'],
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
      id: CAMPUS_LAYER.POINTS,
      type: 'circle',
      source: CAMPUS_SOURCE.POINTS,
      minzoom: 13,
    },
    labelLayerSpec(CAMPUS_LAYER.LABEL_P3, LABEL_PRIORITY.DETAIL, false),
    labelLayerSpec(CAMPUS_LAYER.LABEL_P2, LABEL_PRIORITY.SECONDARY, false),
    labelLayerSpec(CAMPUS_LAYER.LABEL_P1, LABEL_PRIORITY.PRIMARY, true),
  ];
}
