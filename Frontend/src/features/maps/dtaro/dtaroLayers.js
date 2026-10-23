/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DTARO LAYERS — zones, obstacle markers, the selected obstacle's footprint and
 * the robots involved in it. Sources, layer specs and the idempotent install.
 *
 * No React here, so the install / restore / ordering rules are driven by tests
 * against the fake Mapbox map exactly as `useDtaroLayer` drives them for real.
 *
 * ── The stack, bottom to top ──────────────────────────────────────────────
 *     zone fill                                   beneath the campus PERIMETER line
 *                                                 (way/1120154292, dashed), so the
 *                                                 tint never covers the boundary
 *                                                 robots are held to
 *     ── campus perimeter line, grounds ──
 *     campus-area fill and outline (VISUAL ONLY)  beneath the campus roads, so
 *                                                 walkways and routes read on top
 *     ── campus roads and paths ──
 *     zone outline casing + outline,              ABOVE the roads, beneath the
 *     proposal outline, obstacle footprint        buildings: under the roads the
 *                                                 boundary was cut at every road and
 *                                                 read as one more road (2026-10-22)
 *     ── campus buildings / labels, task routes, charging stations ──
 *     campus-area labels                          overview zooms only; the campus
 *                                                 layer names buildings when closer
 *     zone labels                                 one on the zone's northern edge,
 *                                                 always placed; and the name
 *                                                 repeated along the boundary
 *     involved-robot rings                        (selected obstacle only)
 *     obstacle halo, core, glyph                  top of the GL stack
 *
 * Robots are DOM markers and draw above all of it.
 *
 * Severity is robot-supplied and advisory, so every obstacle is drawn the same way: one
 * neutral marker, never a colour scale that would read as a hazard classification.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { ZONE_KIND } from './zoneModel.js';

export const DTARO_SOURCE = Object.freeze({
  ZONES: 'robotx-dtaro-zones',
  ZONE_LABELS: 'robotx-dtaro-zone-labels',
  // Simplified outer rings of the live zones: the line the boundary label runs along (zoneModel).
  ZONE_EDGES: 'robotx-dtaro-zone-edges',
  // Visual campus areas (campusAreas.js) — a reading aid, never alert routing.
  AREAS: 'robotx-dtaro-areas',
  AREA_LABELS: 'robotx-dtaro-area-labels',
  // The proposal preview's assigned cells (a thin grid inside each preview zone). Empty unless
  // the preview is on.
  PREVIEW_CELLS: 'robotx-dtaro-preview-cells',
  FOOTPRINT: 'robotx-dtaro-footprint',
  PARTIES: 'robotx-dtaro-parties',
  OBSTACLES: 'robotx-dtaro-obstacles',
});

export const DTARO_LAYER = Object.freeze({
  ZONE_FILL: 'robotx-dtaro-zone-fill',
  AREA_FILL: 'robotx-dtaro-area-fill',
  AREA_LINE: 'robotx-dtaro-area-line',
  ZONE_CASING: 'robotx-dtaro-zone-casing',
  ZONE_LINE: 'robotx-dtaro-zone-line',
  PREVIEW_CELLS: 'robotx-dtaro-preview-cell-line',
  PREVIEW_CASING: 'robotx-dtaro-zone-preview-casing',
  PREVIEW_LINE: 'robotx-dtaro-zone-preview-line',
  FOOTPRINT_FILL: 'robotx-dtaro-footprint-fill',
  FOOTPRINT_LINE: 'robotx-dtaro-footprint-line',
  AREA_LABEL: 'robotx-dtaro-area-label',
  ZONE_LABEL: 'robotx-dtaro-zone-label',
  ZONE_EDGE_LABEL: 'robotx-dtaro-zone-edge-label',
  PARTIES: 'robotx-dtaro-parties',
  OBSTACLE_HALO: 'robotx-dtaro-obstacle-halo',
  OBSTACLE_CORE: 'robotx-dtaro-obstacle-core',
  OBSTACLE_GLYPH: 'robotx-dtaro-obstacle-glyph',
});

/** Draw order, bottom → top. */
export const DTARO_LAYER_ORDER = Object.freeze([
  DTARO_LAYER.ZONE_FILL,
  DTARO_LAYER.AREA_FILL,
  DTARO_LAYER.AREA_LINE,
  DTARO_LAYER.ZONE_CASING,
  DTARO_LAYER.ZONE_LINE,
  DTARO_LAYER.PREVIEW_CELLS,
  DTARO_LAYER.PREVIEW_CASING,
  DTARO_LAYER.PREVIEW_LINE,
  DTARO_LAYER.FOOTPRINT_FILL,
  DTARO_LAYER.FOOTPRINT_LINE,
  DTARO_LAYER.AREA_LABEL,
  DTARO_LAYER.ZONE_LABEL,
  DTARO_LAYER.ZONE_EDGE_LABEL,
  DTARO_LAYER.PARTIES,
  DTARO_LAYER.OBSTACLE_HALO,
  DTARO_LAYER.OBSTACLE_CORE,
  DTARO_LAYER.OBSTACLE_GLYPH,
]);

/** The zone tint, inserted beneath the campus perimeter line. */
const ZONE_TINT_LAYERS = new Set([DTARO_LAYER.ZONE_FILL]);
/** The visual-area layers, inserted beneath the campus roads. */
const GROUND_LAYERS = new Set([DTARO_LAYER.AREA_FILL, DTARO_LAYER.AREA_LINE]);
/** The outlines, inserted above the campus roads and beneath the buildings; the rest go on top. */
const OUTLINE_LAYERS = new Set([
  DTARO_LAYER.ZONE_CASING,
  DTARO_LAYER.ZONE_LINE,
  DTARO_LAYER.PREVIEW_CELLS,
  DTARO_LAYER.PREVIEW_CASING,
  DTARO_LAYER.PREVIEW_LINE,
  DTARO_LAYER.FOOTPRINT_FILL,
  DTARO_LAYER.FOOTPRINT_LINE,
]);

/** The campus layers the visual areas must stay beneath, in preference order. */
const GROUND_ANCHORS = Object.freeze(['robotx-campus-road-main-casing', 'robotx-campus-buildings', 'robotx-campus-points-circle']);
/**
 * The zone tint stays beneath the campus perimeter line: drawn over it, the tint washed out the
 * dashed boundary that task eligibility and routing actually follow (2026-10-22).
 */
const ZONE_TINT_ANCHORS = Object.freeze(['robotx-campus-boundary-line', ...GROUND_ANCHORS]);
/** The campus layers the outlines must stay beneath, in preference order. */
const OUTLINE_ANCHORS = Object.freeze(['robotx-campus-buildings', 'robotx-campus-points-circle']);
/** Operational overlays the ground layers must also stay beneath when the campus layer is absent. */
const OVERLAY_PREFIXES = Object.freeze(['robotx-charging-', 'robot-route-']);

export const OBSTACLE_INTERACTIVE_LAYERS = Object.freeze([DTARO_LAYER.OBSTACLE_HALO, DTARO_LAYER.OBSTACLE_CORE]);

/** The one obstacle colour (severity-independent). */
export const OBSTACLE_COLOR = '#f59e0b';
export const PARTY_COLOR = Object.freeze({
  REPORTER: '#f8fafc',
  RELEVANT: '#f59e0b',
  NOT_RELEVANT: '#94a3b8',
  NO_ROUTE: '#94a3b8',
  PENDING: '#38bdf8',
});

const EMPTY = Object.freeze({ type: 'FeatureCollection', features: [] });

function safe(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function labelPaint(theme) {
  const l = theme?.labels || {};
  return {
    'text-color': l.secondaryColor || l.color || '#1e293b',
    'text-halo-color': l.halo || '#ffffff',
    'text-halo-width': (l.haloWidth || 1.7) + 0.2,
    'text-halo-blur': 0.4,
    'text-opacity': ['interpolate', ['linear'], ['zoom'], 14.5, 0, 15, 1],
  };
}

/**
 * Zone and area label colour: each feature's own tint on light basemaps; the theme's light
 * label colour on a dark one, where a dark tint on a dark halo would not read.
 */
function featureTextColor(theme, prop) {
  return theme?.robot?.labelContrast === 'light-on-dark' ? theme?.labels?.color || '#e2e8f0' : ['get', prop];
}

export function dtaroLayerSpecs(theme = null) {
  const isLive = ['==', ['get', 'kind'], ZONE_KIND.LIVE];
  return [
    {
      id: DTARO_LAYER.ZONE_FILL,
      type: 'fill',
      source: DTARO_SOURCE.ZONES,
      paint: {
        'fill-color': ['get', 'color'],
        // A pastel tint that reads as a tint (0.11–0.16 did not, on the real basemap) and still
        // leaves roads and buildings legible. `zoom` must be the input of a TOP-LEVEL
        // interpolate (style-spec rule), so the per-kind choice goes inside each stop.
        'fill-opacity': [
          'interpolate',
          ['linear'],
          ['zoom'],
          14,
          ['case', ['==', ['get', 'kind'], ZONE_KIND.UNRESOLVED], 0.2, ['==', ['get', 'kind'], ZONE_KIND.PREVIEW], 0.32, 0.24],
          18,
          ['case', ['==', ['get', 'kind'], ZONE_KIND.UNRESOLVED], 0.2, ['==', ['get', 'kind'], ZONE_KIND.PREVIEW], 0.24, 0.16],
        ],
        'fill-emissive-strength': 1,
      },
    },
    {
      id: DTARO_LAYER.AREA_FILL,
      type: 'fill',
      source: DTARO_SOURCE.AREAS,
      paint: {
        'fill-color': ['get', 'fill'],
        'fill-opacity': ['interpolate', ['linear'], ['zoom'], 15, 0.42, 18, 0.3],
        'fill-emissive-strength': 1,
      },
    },
    {
      id: DTARO_LAYER.AREA_LINE,
      type: 'line',
      source: DTARO_SOURCE.AREAS,
      layout: { 'line-join': 'round' },
      paint: {
        'line-color': ['get', 'line'],
        'line-width': ['interpolate', ['linear'], ['zoom'], 15, 0.6, 18, 1.2],
        'line-opacity': 0.8,
        'line-emissive-strength': 1,
      },
    },
    {
      // A white casing under the zone outline: the outline reads on grass, roofs and roads alike.
      id: DTARO_LAYER.ZONE_CASING,
      type: 'line',
      source: DTARO_SOURCE.ZONES,
      filter: isLive,
      layout: { 'line-join': 'round' },
      paint: {
        'line-color': '#ffffff',
        'line-width': ['interpolate', ['linear'], ['zoom'], 14, 5, 18, 9],
        'line-opacity': 0.95,
        'line-emissive-strength': 1,
      },
    },
    {
      id: DTARO_LAYER.ZONE_LINE,
      type: 'line',
      source: DTARO_SOURCE.ZONES,
      filter: isLive,
      layout: { 'line-join': 'round' },
      paint: {
        'line-color': ['get', 'color'],
        'line-width': ['interpolate', ['linear'], ['zoom'], 14, 2.5, 18, 4.5],
        'line-opacity': 1,
        'line-emissive-strength': 1,
      },
    },
    {
      // The proposal's assigned cells: a thin grid in each zone's colour, so the coverage reads
      // as whole map cells (the unit the published map assigns), not as a hand-drawn shape.
      id: DTARO_LAYER.PREVIEW_CELLS,
      type: 'line',
      source: DTARO_SOURCE.PREVIEW_CELLS,
      layout: { 'line-join': 'round' },
      paint: {
        'line-color': ['get', 'color'],
        'line-width': ['interpolate', ['linear'], ['zoom'], 15, 0.4, 18, 1],
        'line-opacity': 0.55,
        'line-emissive-strength': 1,
      },
    },
    {
      // A white casing under the proposal outline, as under the live one: the dashed outline
      // then reads on grass, roofs and roads alike (1–1.75 px with no casing did not, 2026-10-23).
      id: DTARO_LAYER.PREVIEW_CASING,
      type: 'line',
      source: DTARO_SOURCE.ZONES,
      filter: ['==', ['get', 'kind'], ZONE_KIND.PREVIEW],
      layout: { 'line-join': 'round' },
      paint: {
        'line-color': '#ffffff',
        'line-width': ['interpolate', ['linear'], ['zoom'], 14, 4, 18, 7],
        'line-opacity': 0.9,
        'line-emissive-strength': 1,
      },
    },
    {
      // A proposal is outlined DASHED, so it cannot be mistaken for the published map's solid line.
      id: DTARO_LAYER.PREVIEW_LINE,
      type: 'line',
      source: DTARO_SOURCE.ZONES,
      filter: ['!', isLive],
      layout: { 'line-join': 'round' },
      paint: {
        'line-color': ['get', 'color'],
        'line-width': ['interpolate', ['linear'], ['zoom'], 14, 2.5, 18, 4],
        'line-opacity': 1,
        'line-dasharray': [2.5, 1.25],
        'line-emissive-strength': 1,
      },
    },
    {
      id: DTARO_LAYER.FOOTPRINT_FILL,
      type: 'fill',
      source: DTARO_SOURCE.FOOTPRINT,
      paint: { 'fill-color': OBSTACLE_COLOR, 'fill-opacity': 0.12, 'fill-emissive-strength': 1 },
    },
    {
      id: DTARO_LAYER.FOOTPRINT_LINE,
      type: 'line',
      source: DTARO_SOURCE.FOOTPRINT,
      paint: {
        'line-color': OBSTACLE_COLOR,
        'line-width': 1.5,
        'line-opacity': 0.9,
        'line-dasharray': [1.5, 1],
        'line-emissive-strength': 1,
      },
    },
    {
      // Campus-area names at overview zooms, where the campus layer shows few building names;
      // from ~17.4 the campus layer names the buildings itself, so these step aside.
      id: DTARO_LAYER.AREA_LABEL,
      type: 'symbol',
      source: DTARO_SOURCE.AREA_LABELS,
      minzoom: 15,
      maxzoom: 17.4,
      layout: {
        'text-field': ['get', 'label'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 15, 10.5, 17.4, 12],
        'text-max-width': 8,
        'text-padding': 3,
        'text-allow-overlap': false,
      },
      paint: { ...labelPaint(theme), 'text-color': featureTextColor(theme, 'text'), 'text-opacity': 1 },
    },
    {
      // One label per zone, on its northern edge (zoneLabelCollection), clear of the robots
      // and stations that crowd a campus centre. Always placed: it is the only statement on
      // the map of which alert zone this is, and other labels avoid it.
      id: DTARO_LAYER.ZONE_LABEL,
      type: 'symbol',
      source: DTARO_SOURCE.ZONE_LABELS,
      minzoom: 14,
      layout: {
        // A proposal label is two short lines, "G4 PROPOSAL" over the zone name, larger than a
        // live label: compact enough to sit clear of the robot markers (zoneModel
        // previewLabelsClearOf), which are HTML above the canvas.
        'text-field': [
          'case',
          ['==', ['get', 'kind'], ZONE_KIND.PREVIEW],
          ['format', ['get', 'labelKicker'], { 'font-scale': 0.72 }, '\n', {}, ['upcase', ['get', 'labelName']], { 'font-scale': 1.1 }],
          ['format', ['get', 'label'], {}],
        ],
        'text-size': [
          'interpolate',
          ['linear'],
          ['zoom'],
          14,
          ['case', ['==', ['get', 'kind'], ZONE_KIND.PREVIEW], 13, 11],
          18,
          ['case', ['==', ['get', 'kind'], ZONE_KIND.PREVIEW], 16, 13.5],
        ],
        'text-letter-spacing': 0.03,
        'text-max-width': 14,
        // A live zone's label sits on its northern vertex; a proposal zone's at its interior
        // medoid cell (zoneModel), centred.
        'text-anchor': ['case', ['==', ['get', 'kind'], ZONE_KIND.PREVIEW], 'center', 'bottom'],
        'text-offset': ['case', ['==', ['get', 'kind'], ZONE_KIND.PREVIEW], ['literal', [0, 0]], ['literal', [0, -0.35]]],
        'text-allow-overlap': true,
        'text-ignore-placement': false,
      },
      paint: { ...labelPaint(theme), 'text-color': featureTextColor(theme, 'textColor'), 'text-opacity': 1 },
    },
    {
      // The zone's name along its own boundary, repeated: wherever an edge is on screen, so is
      // the name. The one label at the top vertex left the screen from zoom ~17 (2026-10-22).
      // It runs along the simplified ring (ZONE_EDGES): Mapbox sets no text along the raw cell
      // outline, which turns 60° every cell edge.
      id: DTARO_LAYER.ZONE_EDGE_LABEL,
      type: 'symbol',
      source: DTARO_SOURCE.ZONE_EDGES,
      minzoom: 15.5,
      layout: {
        'symbol-placement': 'line',
        'symbol-spacing': 360,
        'text-field': ['get', 'edgeLabel'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 15.5, 10.5, 18, 12.5],
        'text-letter-spacing': 0.04,
        'text-max-angle': 35,
        'text-keep-upright': true,
        'text-offset': [0, -0.85],
        'text-padding': 2,
        'text-allow-overlap': false,
      },
      paint: { ...labelPaint(theme), 'text-color': featureTextColor(theme, 'textColor'), 'text-opacity': 1 },
    },
    {
      id: DTARO_LAYER.PARTIES,
      type: 'circle',
      source: DTARO_SOURCE.PARTIES,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 11, 18, 17],
        'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-width': ['case', ['==', ['get', 'role'], 'REPORTER'], 3, 2.25],
        'circle-stroke-color': [
          'match',
          ['get', 'status'],
          'REPORTER', PARTY_COLOR.REPORTER,
          'RELEVANT', PARTY_COLOR.RELEVANT,
          'NOT_RELEVANT', PARTY_COLOR.NOT_RELEVANT,
          'NO_ROUTE', PARTY_COLOR.NO_ROUTE,
          PARTY_COLOR.PENDING,
        ],
        'circle-stroke-opacity': 0.95,
        'circle-pitch-alignment': 'map',
        'circle-emissive-strength': 1,
      },
    },
    {
      id: DTARO_LAYER.OBSTACLE_HALO,
      type: 'circle',
      source: DTARO_SOURCE.OBSTACLES,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 9, 18, 14],
        'circle-color': OBSTACLE_COLOR,
        'circle-opacity': ['case', ['boolean', ['get', 'expired'], false], 0.08, 0.22],
        'circle-stroke-color': ['case', ['boolean', ['feature-state', 'selected'], false], '#ffffff', OBSTACLE_COLOR],
        'circle-stroke-width': ['case', ['boolean', ['feature-state', 'selected'], false], 3, 1.5],
        'circle-stroke-opacity': ['case', ['boolean', ['get', 'expired'], false], 0.45, 0.95],
        'circle-pitch-alignment': 'map',
        'circle-emissive-strength': 1,
      },
    },
    {
      id: DTARO_LAYER.OBSTACLE_CORE,
      type: 'circle',
      source: DTARO_SOURCE.OBSTACLES,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 4.5, 18, 6.5],
        'circle-color': '#111827',
        'circle-opacity': ['case', ['boolean', ['get', 'expired'], false], 0.45, 1],
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 1.25,
        'circle-emissive-strength': 1,
      },
    },
    {
      id: DTARO_LAYER.OBSTACLE_GLYPH,
      type: 'symbol',
      source: DTARO_SOURCE.OBSTACLES,
      layout: {
        'text-field': '!',
        'text-size': ['interpolate', ['linear'], ['zoom'], 14, 8, 18, 10],
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: { 'text-color': '#ffffff', 'text-emissive-strength': 1 },
    },
  ];
}

function anchorFor(map, preferred) {
  const layers = safe(() => map.getStyle()?.layers, null);
  if (!Array.isArray(layers)) return undefined;
  for (const id of preferred) if (layers.some((l) => l.id === id)) return id;
  const overlay = layers.find((l) => OVERLAY_PREFIXES.some((p) => String(l.id).startsWith(p)));
  return overlay ? overlay.id : undefined;
}

const SOURCE_OPTIONS = Object.freeze({
  [DTARO_SOURCE.ZONES]: { promoteId: 'key' },
  [DTARO_SOURCE.OBSTACLES]: { promoteId: 'obstacleId' },
});

/**
 * Install whatever is missing. Idempotent: every `add*` is guarded by its `get*`, so a style
 * reload restores exactly one copy and an intact style is left alone.
 *
 * @returns {{ installed: number, missing: string[] }}
 */
export function installDtaroLayers(map, { theme = null, data = null } = {}) {
  if (!map) return { installed: 0, missing: [...DTARO_LAYER_ORDER] };
  for (const id of Object.values(DTARO_SOURCE)) {
    if (safe(() => map.getSource(id), null)) continue;
    safe(() => map.addSource(id, { type: 'geojson', data: data?.[id] || EMPTY, ...(SOURCE_OPTIONS[id] || {}) }));
  }
  const tint = anchorFor(map, ZONE_TINT_ANCHORS);
  const ground = anchorFor(map, GROUND_ANCHORS);
  const outline = anchorFor(map, OUTLINE_ANCHORS);
  let installed = 0;
  const missing = [];
  for (const spec of dtaroLayerSpecs(theme)) {
    if (safe(() => map.getLayer(spec.id), null)) {
      installed += 1;
      continue;
    }
    if (!safe(() => map.getSource(spec.source), null)) {
      missing.push(spec.id);
      continue;
    }
    const before = ZONE_TINT_LAYERS.has(spec.id)
      ? tint
      : GROUND_LAYERS.has(spec.id)
        ? ground
        : OUTLINE_LAYERS.has(spec.id)
          ? outline
          : undefined;
    safe(() => map.addLayer(spec, before));
    if (safe(() => map.getLayer(spec.id), null)) installed += 1;
    else missing.push(spec.id);
  }
  return { installed, missing };
}

/** Push collections into installed sources (`{ [sourceId]: FeatureCollection }`). No layer is touched. */
export function setDtaroData(map, data) {
  if (!map || !data) return;
  for (const [id, collection] of Object.entries(data)) {
    const source = safe(() => map.getSource(id), null);
    if (source && typeof source.setData === 'function' && collection) safe(() => source.setData(collection));
  }
}

export function applyDtaroTheme(map, theme) {
  if (!map || !theme) return;
  for (const [id, prop] of [[DTARO_LAYER.ZONE_LABEL, 'textColor'], [DTARO_LAYER.ZONE_EDGE_LABEL, 'textColor'], [DTARO_LAYER.AREA_LABEL, 'text']]) {
    if (!safe(() => map.getLayer(id), null)) continue;
    for (const [name, value] of Object.entries(labelPaint(theme))) {
      if (name === 'text-opacity' || name === 'text-color') continue;
      safe(() => map.setPaintProperty(id, name, value));
    }
    safe(() => map.setPaintProperty(id, 'text-color', featureTextColor(theme, prop)));
  }
}

export function removeDtaroLayers(map) {
  if (!map) return;
  for (const id of [...DTARO_LAYER_ORDER].reverse()) {
    if (safe(() => map.getLayer(id), null)) safe(() => map.removeLayer(id));
  }
  for (const id of Object.values(DTARO_SOURCE)) {
    if (safe(() => map.getSource(id), null)) safe(() => map.removeSource(id));
  }
}

/** The obstacle under a point, or null. */
export function obstacleIdAtPoint(map, point) {
  const hits = safe(() => map.queryRenderedFeatures(point, { layers: OBSTACLE_INTERACTIVE_LAYERS.filter((id) => map.getLayer(id)) }), []);
  const hit = (hits || []).find((f) => f?.properties?.obstacleId);
  return hit ? String(hit.properties.obstacleId) : null;
}

// ── Data ────────────────────────────────────────────────────────────────────

/** Obstacle points (only those the server located). */
export function obstacleCollection(obstacles, nowMs = Date.now()) {
  return {
    type: 'FeatureCollection',
    features: (obstacles || [])
      .filter((o) => Number.isFinite(o?.lat) && Number.isFinite(o?.lon) && o.obstacleId)
      .map((o) => ({
        type: 'Feature',
        id: o.obstacleId,
        properties: { obstacleId: o.obstacleId, expired: Number.isFinite(o.expiresAtMs) && o.expiresAtMs <= nowMs },
        geometry: { type: 'Point', coordinates: [o.lon, o.lat] },
      })),
  };
}

/** The selected obstacle's published cell, as the server sent it. */
export function footprintCollection(obstacle) {
  const ring = Array.isArray(obstacle?.footprint) ? obstacle.footprint.filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon)) : [];
  if (ring.length < 3) return EMPTY;
  const coordinates = ring.map((p) => [p.lon, p.lat]);
  coordinates.push(coordinates[0]);
  return { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [coordinates] } }] };
}

/**
 * Rings around the robots involved in the selected obstacle, at their current reported
 * positions: the reporter, and each recipient coloured by its own verdict.
 *
 * @param {object|null} obstacle
 * @param {Map<string, {lat:number, lon:number}>} positions robotId → position
 * @param {(obstacle: object, robotId: string) => string} statusOf
 */
export function partiesCollection(obstacle, positions, statusOf) {
  if (!obstacle) return EMPTY;
  const features = [];
  const add = (robotId, role, status) => {
    const p = positions.get(robotId);
    if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return;
    features.push({ type: 'Feature', properties: { robotId, role, status }, geometry: { type: 'Point', coordinates: [p.lon, p.lat] } });
  };
  if (obstacle.reportingRobotId) add(obstacle.reportingRobotId, 'REPORTER', 'REPORTER');
  for (const robotId of obstacle.recipients || []) add(robotId, 'RECIPIENT', statusOf(obstacle, robotId));
  return { type: 'FeatureCollection', features };
}
