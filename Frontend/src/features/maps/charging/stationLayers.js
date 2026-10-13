/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CHARGING LAYERS — sources, layer specs and the idempotent install
 *
 * No React here, so the install / restore / ordering rules are driven by the
 * tests against a fake Mapbox map exactly as `useChargingLayer` drives them
 * against the real one.
 *
 * ── The stack, bottom to top ──────────────────────────────────────────────
 *     charger route casing, charger route      (a simulated robot → its charger)
 *     ── task routes are inserted HERE (useRobotStream: beneath the floor) ──
 *     station shadow          ← CHARGING_STATION_FLOOR_LAYER
 *     station model           (fill-extrusion, z ≥ ~17)
 *     station light strip     (fill-extrusion, self-lit, state colour)
 *     activity ring           (only where a robot is CHARGING; animated unless reduced motion)
 *     selection ring
 *     badge + bolt icon       (z < ~18: the compact, screen-facing form)
 *     label                   (name; name + status from z 17)
 *
 * Robots are DOM markers and always draw above every one of these.
 *
 * ── The zoom hand-off ─────────────────────────────────────────────────────
 * Below ~17 a few metres of station is a few pixels, so it is a badge; from
 * ~17 the extruded model has enough pixels to read as an installation. They
 * cross-fade over 17.2–17.9 rather than switch, so zooming never pops.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { chargerRouteFeatures, stationFeatures } from './chargingGeoJson.js';
import { STATION_STATE_META, stationModelFeatures } from './stationModel.js';
import { STATION_ICON_ID, boltIconImage } from './stationIcon.js';

export const CHARGING_SOURCE = Object.freeze({
  STATIONS: 'robotx-charging-stations',
  MODEL: 'robotx-charging-station-model',
  ROUTES: 'robotx-charging-routes',
});

export const CHARGING_LAYER = Object.freeze({
  ROUTE_CASING: 'robotx-charging-routes-casing',
  ROUTE: 'robotx-charging-routes',
  SHADOW: 'robotx-charging-station-shadow',
  MODEL: 'robotx-charging-station-model',
  LIGHT: 'robotx-charging-station-light',
  PULSE: 'robotx-charging-station-pulse',
  SELECTION: 'robotx-charging-station-selection',
  BADGE: 'robotx-charging-station-badge',
  ICON: 'robotx-charging-station-icon',
  LABEL: 'robotx-charging-station-label',
});

/** Bottom of the station stack: task routes go beneath it, so stations read on top of routes. */
export const CHARGING_STATION_FLOOR_LAYER = CHARGING_LAYER.SHADOW;

/** Install order (bottom → top). */
export const CHARGING_LAYER_ORDER = Object.freeze([
  CHARGING_LAYER.ROUTE_CASING,
  CHARGING_LAYER.ROUTE,
  CHARGING_LAYER.SHADOW,
  CHARGING_LAYER.MODEL,
  CHARGING_LAYER.LIGHT,
  CHARGING_LAYER.PULSE,
  CHARGING_LAYER.SELECTION,
  CHARGING_LAYER.BADGE,
  CHARGING_LAYER.ICON,
  CHARGING_LAYER.LABEL,
]);

/** Layers a click or hover on a station is read from. */
export const CHARGING_INTERACTIVE_LAYERS = Object.freeze([
  CHARGING_LAYER.BADGE,
  CHARGING_LAYER.ICON,
  CHARGING_LAYER.MODEL,
  CHARGING_LAYER.LIGHT,
  CHARGING_LAYER.LABEL,
]);

/** Prefix of every task-route layer `useRobotStream` draws. */
export const TASK_ROUTE_LAYER_PREFIX = 'robot-route-';

/** Charger-route colour — distinct from every robot's identity hue band and from the station states. */
export const CHARGER_ROUTE_COLOR = '#6366f1';

const EMPTY = Object.freeze({ type: 'FeatureCollection', features: [] });

// ── Expressions ──────────────────────────────────────────────────────────────

const STATES = Object.keys(STATION_STATE_META);

/** State → colour, for any layer whose features carry `state`. */
export const STATE_COLOR_EXPR = Object.freeze([
  'match',
  ['get', 'state'],
  ...STATES.flatMap((s) => [s, STATION_STATE_META[s].color]),
  STATION_STATE_META.INACTIVE.color,
]);

/** True for a state a robot can be charged in. */
const OPERATIONAL_EXPR = [
  'match',
  ['get', 'state'],
  STATES.filter((s) => STATION_STATE_META[s].operational),
  true,
  false,
];

/** The badge's zoom fade-out (it hands over to the model). `inner` is the value while visible. */
const badgeFade = (inner) => ['interpolate', ['linear'], ['zoom'], 17.2, inner, 17.9, 0];
/** The model's zoom fade-in. */
const MODEL_FADE = ['interpolate', ['linear'], ['zoom'], 16.8, 0, 17.6, 1];

/**
 * A ring radius (px) that surrounds the badge at low zoom and the pad at high zoom,
 * where the pad is ~6 m across: ~0.29 m/px at z18 at this latitude, halving per zoom.
 */
export function ringRadiusExpr(scale = 1) {
  return ['interpolate', ['linear'], ['zoom'], 15, 12 * scale, 17, 14 * scale, 18, 17 * scale, 19, 32 * scale, 20, 62 * scale];
}

const STRUCTURE_COLOR_EXPR = [
  'case',
  ['==', ['get', 'role'], 'state'],
  STATE_COLOR_EXPR,
  ['==', ['get', 'role'], 'unit'],
  ['case', OPERATIONAL_EXPR, '#334155', '#64748b'],
  ['==', ['get', 'part'], 'awning'],
  ['case', OPERATIONAL_EXPR, '#eef2f6', '#cfd5dd'],
  ['case', OPERATIONAL_EXPR, '#d9dfe7', '#b9c1cc'],
];

/** The light strip: the state's colour while operational, an unlit dark slate otherwise. */
const LIGHT_COLOR_EXPR = ['case', OPERATIONAL_EXPR, STATE_COLOR_EXPR, '#475569'];

/**
 * Extrusion heights exactly as stated, on a map with terrain.
 *
 * With terrain on (the environment layer enables it), mapbox-gl's default
 * `fill-extrusion-height-alignment: 'flat'` puts every roof at
 * max(centroid elevation + height, ground + base + 2 m) — a 2 m minimum meant for
 * buildings. Seen in the browser (2026-10-13): the 0.22 m light strip rendered as a 2 m
 * green wall, the awning as a 2 m block, the pad 2 m high, hiding the pillar and posts.
 * 'terrain' alignment uses ground + height and ground + base exactly; over a few metres
 * of pad the terrain slope it follows is negligible.
 */
const EXACT_HEIGHTS_ON_TERRAIN = Object.freeze({
  'fill-extrusion-height-alignment': 'terrain',
  'fill-extrusion-base-alignment': 'terrain',
});

// ── Specs ────────────────────────────────────────────────────────────────────

/**
 * Every layer spec, given the theme the labels and the route casing are coloured from.
 * Pure — the tests read these directly.
 */
export function chargingLayerSpecs(theme = null) {
  const labels = theme?.labels || {};
  const routeHalo = theme?.routes?.halo || '#0b1220';
  return [
    {
      id: CHARGING_LAYER.ROUTE_CASING,
      type: 'line',
      source: CHARGING_SOURCE.ROUTES,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': routeHalo,
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2.4, 14, 3.6, 18, 6],
        'line-opacity': 0.35,
        'line-emissive-strength': 1,
      },
    },
    {
      id: CHARGING_LAYER.ROUTE,
      type: 'line',
      source: CHARGING_SOURCE.ROUTES,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': CHARGER_ROUTE_COLOR,
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.2, 14, 2.2, 18, 3.6],
        'line-opacity': 0.9,
        'line-dasharray': [2, 1.5],
        'line-emissive-strength': 1,
      },
    },
    {
      id: CHARGING_LAYER.SHADOW,
      type: 'circle',
      source: CHARGING_SOURCE.STATIONS,
      minzoom: 16.5,
      paint: {
        'circle-pitch-alignment': 'map',
        'circle-color': '#0b1220',
        'circle-blur': 0.85,
        'circle-radius': ['interpolate', ['exponential', 2], ['zoom'], 16, 3.6, 22, 230],
        'circle-opacity': ['interpolate', ['linear'], ['zoom'], 16.6, 0, 17.4, 0.2],
      },
    },
    {
      id: CHARGING_LAYER.MODEL,
      type: 'fill-extrusion',
      source: CHARGING_SOURCE.MODEL,
      minzoom: 16.5,
      filter: ['!=', ['get', 'role'], 'light'],
      paint: {
        'fill-extrusion-color': STRUCTURE_COLOR_EXPR,
        'fill-extrusion-base': ['get', 'base'],
        'fill-extrusion-height': ['get', 'height'],
        ...EXACT_HEIGHTS_ON_TERRAIN,
        'fill-extrusion-opacity': MODEL_FADE,
        'fill-extrusion-vertical-gradient': true,
        'fill-extrusion-ambient-occlusion-intensity': 0.25,
        // A little self-light so the installation does not go black under the Night lights;
        // the light strip, not the structure, carries the state.
        'fill-extrusion-emissive-strength': 0.2,
      },
    },
    {
      id: CHARGING_LAYER.LIGHT,
      type: 'fill-extrusion',
      source: CHARGING_SOURCE.MODEL,
      minzoom: 16.5,
      filter: ['==', ['get', 'role'], 'light'],
      paint: {
        'fill-extrusion-color': LIGHT_COLOR_EXPR,
        'fill-extrusion-base': ['get', 'base'],
        'fill-extrusion-height': ['get', 'height'],
        ...EXACT_HEIGHTS_ON_TERRAIN,
        'fill-extrusion-opacity': MODEL_FADE,
        'fill-extrusion-emissive-strength': 1,
      },
    },
    {
      id: CHARGING_LAYER.PULSE,
      type: 'circle',
      source: CHARGING_SOURCE.STATIONS,
      minzoom: 15,
      filter: ['==', ['get', 'pulse'], true],
      paint: {
        'circle-pitch-alignment': 'map',
        'circle-color': 'rgba(0,0,0,0)',
        'circle-radius': ringRadiusExpr(1.15),
        'circle-stroke-color': STATE_COLOR_EXPR,
        'circle-stroke-width': 2,
        'circle-stroke-opacity': 0.5,
        'circle-emissive-strength': 1,
      },
    },
    {
      id: CHARGING_LAYER.SELECTION,
      type: 'circle',
      source: CHARGING_SOURCE.STATIONS,
      minzoom: 13,
      paint: {
        'circle-pitch-alignment': 'map',
        'circle-color': 'rgba(0,0,0,0)',
        'circle-radius': ringRadiusExpr(1.3),
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 2.5,
        'circle-stroke-opacity': [
          'case',
          ['boolean', ['feature-state', 'selected'], false],
          0.95,
          ['boolean', ['feature-state', 'hover'], false],
          0.45,
          0,
        ],
        'circle-emissive-strength': 1,
      },
    },
    {
      id: CHARGING_LAYER.BADGE,
      type: 'circle',
      source: CHARGING_SOURCE.STATIONS,
      minzoom: 13,
      maxzoom: 18,
      paint: {
        'circle-color': STATE_COLOR_EXPR,
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 4, 15, 7, 17, 9.5],
        'circle-opacity': badgeFade(['case', OPERATIONAL_EXPR, 1, 0.75]),
        'circle-stroke-color': ['case', OPERATIONAL_EXPR, '#ffffff', '#e2e8f0'],
        'circle-stroke-width': ['case', ['boolean', ['feature-state', 'selected'], false], 3, 1.75],
        'circle-stroke-opacity': badgeFade(1),
        'circle-emissive-strength': 1,
      },
    },
    {
      id: CHARGING_LAYER.ICON,
      type: 'symbol',
      source: CHARGING_SOURCE.STATIONS,
      minzoom: 13,
      maxzoom: 18,
      layout: {
        'icon-image': STATION_ICON_ID,
        'icon-size': ['interpolate', ['linear'], ['zoom'], 13, 0.35, 15, 0.55, 17, 0.78],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
      paint: { 'icon-opacity': badgeFade(['case', OPERATIONAL_EXPR, 1, 0.8]) },
    },
    {
      id: CHARGING_LAYER.LABEL,
      type: 'symbol',
      source: CHARGING_SOURCE.STATIONS,
      minzoom: 15,
      layout: {
        'text-field': [
          'step',
          ['zoom'],
          ['get', 'name'],
          17,
          ['format', ['get', 'name'], {}, '\n', {}, ['get', 'status'], { 'font-scale': 0.82 }],
        ],
        'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 15, 10.5, 18, 12.5],
        'text-anchor': 'bottom',
        // Above the badge, then above the awning as the model grows — a robot docked on
        // the pad never covers the station's name.
        'text-offset': ['interpolate', ['linear'], ['zoom'], 15, ['literal', [0, -1.0]], 17.5, ['literal', [0, -1.4]], 19, ['literal', [0, -2.6]], 20, ['literal', [0, -3.8]]],
        'text-max-width': 14,
        'symbol-sort-key': ['case', OPERATIONAL_EXPR, 0, 1],
        'text-allow-overlap': false,
      },
      paint: {
        'text-color': ['case', OPERATIONAL_EXPR, labels.color || '#0f172a', labels.secondaryColor || '#475569'],
        'text-halo-color': labels.halo || '#ffffff',
        'text-halo-width': labels.haloWidth || 1.4,
      },
    },
  ];
}

// ── Install / data / theme / remove ──────────────────────────────────────────

function safe(fn, fallback = undefined) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/**
 * The station a map point falls on — its `chargerId` — or null. Read from the interactive
 * station layers that are actually in the style, so a style still loading answers "none".
 * The click and hover handlers in `useChargingLayer` both ask this.
 */
export function stationIdAtPoint(map, point) {
  if (!map) return null;
  const layers = CHARGING_INTERACTIVE_LAYERS.filter((id) => safe(() => Boolean(map.getLayer(id)), false));
  if (!layers.length) return null;
  const hit = safe(() => map.queryRenderedFeatures(point, { layers })[0], null);
  return hit?.properties?.chargerId || null;
}

/** The lowest task-route layer on the map, so charger routes can go beneath it. */
function firstTaskRouteLayer(map) {
  const layers = safe(() => map.getStyle()?.layers, null);
  if (!Array.isArray(layers)) return undefined;
  const hit = layers.find((l) => typeof l?.id === 'string' && l.id.startsWith(TASK_ROUTE_LAYER_PREFIX));
  return hit ? hit.id : undefined;
}

/**
 * Install everything that is missing. Idempotent: every `add*` is guarded by its `get*`/`has*`,
 * so running it again after a style reload restores exactly one copy of each, and running it on
 * an intact style changes nothing.
 *
 * @returns {{ installed: number, missing: string[] }} layers present afterwards, and any that the
 *   style refused (a style still loading refuses all of them; the caller retries on `style.load`)
 */
export function installChargingLayers(map, { theme = null, data = null } = {}) {
  if (!map) return { installed: 0, missing: [...CHARGING_LAYER_ORDER] };

  if (!safe(() => map.hasImage(STATION_ICON_ID), false)) {
    safe(() => map.addImage(STATION_ICON_ID, boltIconImage(40), { pixelRatio: 2 }));
  }

  const sourceData = {
    [CHARGING_SOURCE.STATIONS]: data?.stations || EMPTY,
    [CHARGING_SOURCE.MODEL]: data?.model || EMPTY,
    [CHARGING_SOURCE.ROUTES]: data?.routes || EMPTY,
  };
  for (const [id, collection] of Object.entries(sourceData)) {
    if (safe(() => map.getSource(id), null)) continue;
    safe(() =>
      map.addSource(id, {
        type: 'geojson',
        data: collection,
        // Stable identity per station for hover/selection feature-state across `setData` calls.
        ...(id === CHARGING_SOURCE.STATIONS ? { promoteId: 'chargerId' } : {}),
      })
    );
  }

  const beneathTaskRoutes = firstTaskRouteLayer(map);
  const missing = [];
  let installed = 0;
  for (const spec of chargingLayerSpecs(theme)) {
    if (safe(() => map.getLayer(spec.id), null)) {
      installed += 1;
      continue;
    }
    if (!safe(() => map.getSource(spec.source), null)) {
      missing.push(spec.id);
      continue;
    }
    const isChargerRoute = spec.id === CHARGING_LAYER.ROUTE_CASING || spec.id === CHARGING_LAYER.ROUTE;
    const before = isChargerRoute && beneathTaskRoutes ? beneathTaskRoutes : undefined;
    safe(() => map.addLayer(spec, before));
    if (safe(() => map.getLayer(spec.id), null)) installed += 1;
    else missing.push(spec.id);
  }
  return { installed, missing };
}

/** Push new report data into the installed sources. No layer is touched. */
export function setChargingData(map, data) {
  if (!map || !data) return;
  for (const [id, collection] of [
    [CHARGING_SOURCE.STATIONS, data.stations],
    [CHARGING_SOURCE.MODEL, data.model],
    [CHARGING_SOURCE.ROUTES, data.routes],
  ]) {
    const source = safe(() => map.getSource(id), null);
    if (source && typeof source.setData === 'function' && collection) safe(() => source.setData(collection));
  }
}

/** Re-colour the theme-dependent paint on layers that exist. */
export function applyChargingTheme(map, theme) {
  if (!map || !theme) return;
  for (const spec of chargingLayerSpecs(theme)) {
    if (spec.id !== CHARGING_LAYER.LABEL && spec.id !== CHARGING_LAYER.ROUTE_CASING) continue;
    if (!safe(() => map.getLayer(spec.id), null)) continue;
    for (const [prop, value] of Object.entries(spec.paint)) {
      if (prop.startsWith('text-') || prop === 'line-color') safe(() => map.setPaintProperty(spec.id, prop, value));
    }
  }
}

/** Remove every charging layer, then the sources. */
export function removeChargingLayers(map) {
  if (!map) return;
  for (const id of [...CHARGING_LAYER_ORDER].reverse()) {
    if (safe(() => map.getLayer(id), null)) safe(() => map.removeLayer(id));
  }
  for (const id of Object.values(CHARGING_SOURCE)) {
    if (safe(() => map.getSource(id), null)) safe(() => map.removeSource(id));
  }
}

/** The three collections the charging overlay draws, from one simulator report. */
export function chargingOverlayData(simulatorStatus) {
  return {
    stations: stationFeatures(simulatorStatus),
    model: stationModelFeatures(simulatorStatus),
    routes: chargerRouteFeatures(simulatorStatus),
  };
}
