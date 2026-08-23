/**
 * ═══════════════════════════════════════════════════════════════════════════
 * 3D ENVIRONMENT CONFIGURATION — static geometry and camera, in one place
 *
 * Everything here describes the WORLD the fleet operates in: basemap style,
 * lighting, terrain, atmosphere, and the camera framing for each level of the
 * location hierarchy. Nothing here knows a robot exists.
 *
 * That separation is the point (§13). The environment is stable geometry that
 * is installed once per style load and then left alone; robots are an
 * operational overlay that updates many times a minute. Keeping their
 * configuration in different modules is what makes it structurally hard for a
 * telemetry tick to end up rebuilding terrain.
 *
 * Pure data + pure functions. No React, no Mapbox import.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * Mapbox Standard. Chosen over the previous `dark-v11` because it ships the
 * 3D environment this milestone is about — extruded buildings, landmarks,
 * trees, and a real lighting model — from the same vendor, the same tiles and
 * the same renderer already in the app. No second rendering framework is
 * introduced (`three` remains an unused dependency; see ARCHITECTURE.md).
 */
export const ENVIRONMENT_STYLE = 'mapbox://styles/mapbox/standard';

/**
 * Fallback basemap. Used if the Standard style fails to load — it is a plain
 * vector style, so `useEnvironmentLayer` adds extruded buildings and a sky to
 * it explicitly rather than leaving the operator on a flat map with no depth
 * cues at all (§23).
 */
export const FALLBACK_STYLE = 'mapbox://styles/mapbox/dark-v11';

/**
 * `day`, because this is an operations map before it is a pretty one.
 *
 * `dusk` was tried first and looked worse in the only way that matters: it
 * washes the whole basemap to a low-contrast brown-mauve in which road
 * geometry, campus ground and building faces all sit within a few percent of
 * each other in luminance. An operator reading robot positions against roads
 * could not separate them. `day` keeps roads bright against grey-white
 * buildings, which is also what the rest of the dashboard's light chrome
 * expects. `dawn`/`dusk`/`night` remain one constant away.
 */
export const LIGHT_PRESET = 'day';

/**
 * Real elevation, at real scale. Exaggeration stays at 1.0 deliberately: the
 * map visualizes truth (§24), and a stretched landscape would misrepresent
 * gradients an operator may be reading for route feasibility.
 */
export const TERRAIN = Object.freeze({
  sourceId: 'mapbox-dem',
  source: Object.freeze({
    type: 'raster-dem',
    url: 'mapbox://mapbox.mapbox-terrain-dem-v1',
    tileSize: 512,
    maxzoom: 14,
  }),
  exaggeration: 1.0,
});

/** Atmosphere for the fallback style. Standard renders its own. */
export const FALLBACK_FOG = Object.freeze({
  range: [1.5, 12],
  color: 'hsl(215, 32%, 22%)',
  'high-color': 'hsl(215, 52%, 30%)',
  'space-color': 'hsl(222, 47%, 8%)',
  'horizon-blend': 0.05,
  'star-intensity': 0.12,
});

// ── Camera ───────────────────────────────────────────────────────────────────
//
// The camera belongs to the map/view system, never to a robot (§18). These are
// framings for a place, not for a unit.
//
// Tilt is introduced only where it buys something. At country/state/city zoom a
// pitched camera adds foreshortening and nothing else; the depth is only
// meaningful once buildings and terrain are resolvable, which is the AREA and
// CAMPUS views. `WORLD` stays flat so the globe reads as a globe.
//
// The tilts are moderate on purpose. At 58° the horizon eats the upper third of
// the viewport and the operational area — the part of the screen the operator is
// actually reading — is squeezed into a band. 50° at campus still shows real
// building volume while keeping the ground plane dominant.

export const MAX_PITCH = 68;

export const CAMERA_PRESETS = Object.freeze({
  WORLD: Object.freeze({ zoom: 1.5, pitch: 0, bearing: 0 }),
  COUNTRY: Object.freeze({ zoom: 4.7, pitch: 0, bearing: 0 }),
  STATE: Object.freeze({ zoom: 6.7, pitch: 0, bearing: 0 }),
  CITY: Object.freeze({ zoom: 9.6, pitch: 0, bearing: 0 }),
  AREA: Object.freeze({ zoom: 13.2, pitch: 35, bearing: 0 }),
  CAMPUS: Object.freeze({ zoom: 17.2, pitch: 50, bearing: 0 }),
});

/**
 * How long a camera flight should take, given how far it has to travel in zoom.
 *
 * Left uncapped, Mapbox's `speed`/`curve` model turns a world→campus move (~15
 * zoom levels) into a flight of many seconds. Every intermediate zoom fetches a
 * batch of tiles that is discarded moments later, which is what a user reads as
 * "the map glitches on load". Bounding it keeps the intro cinematic without the
 * thrash.
 */
export function flightDurationForZoomDelta(delta) {
  const d = typeof delta === 'number' && Number.isFinite(delta) ? Math.abs(delta) : 0;
  return Math.min(3000, 700 + d * 130);
}

/** Camera framing for a focus level, falling back to the world view. */
export function cameraPresetFor(level) {
  return CAMERA_PRESETS[level] || CAMERA_PRESETS.WORLD;
}

/**
 * Below this zoom a fixed-pixel marker or route line represents so much ground
 * distance that an exactly-correct GPS coordinate reads as floating off the
 * road. Live delivery-tracking apps never expose that scale during tracking, so
 * once a location is focused (robots visible) we clamp how far out the user can
 * scroll. The world overview is reached only programmatically, so it is exempt.
 */
export const TRACKING_MIN_ZOOM = 11;

/** Focus levels that get the tilted, tracking-scale treatment. */
const TIGHT_TRACKING_LEVELS = new Set(['AREA', 'CAMPUS']);

export function isTightTrackingLevel(level) {
  return TIGHT_TRACKING_LEVELS.has(level);
}

// ── Fallback-style depth ─────────────────────────────────────────────────────
//
// Only used when the Standard style is unavailable. Standard already draws
// buildings, trees and landmarks with proper lighting; this is the minimum that
// keeps the map three-dimensional without it.

export const FALLBACK_BUILDINGS_LAYER_ID = 'robotx-3d-buildings';
export const FALLBACK_SKY_LAYER_ID = 'robotx-sky';

export const FALLBACK_BUILDINGS_LAYER = Object.freeze({
  id: FALLBACK_BUILDINGS_LAYER_ID,
  source: 'composite',
  'source-layer': 'building',
  filter: ['==', ['get', 'extrude'], 'true'],
  type: 'fill-extrusion',
  minzoom: 13,
  paint: {
    'fill-extrusion-color': [
      'interpolate',
      ['linear'],
      ['get', 'height'],
      0, 'hsl(215, 25%, 26%)',
      40, 'hsl(215, 28%, 34%)',
      120, 'hsl(212, 32%, 44%)',
    ],
    // Fade the extrusions in across the zoom band where they start to matter,
    // so buildings grow out of the ground instead of popping in.
    'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 13, 0, 15.5, ['get', 'height']],
    'fill-extrusion-base': ['interpolate', ['linear'], ['zoom'], 13, 0, 15.5, ['get', 'min_height']],
    'fill-extrusion-opacity': 0.82,
    'fill-extrusion-vertical-gradient': true,
  },
});

export const FALLBACK_SKY_LAYER = Object.freeze({
  id: FALLBACK_SKY_LAYER_ID,
  type: 'sky',
  paint: {
    'sky-type': 'atmosphere',
    'sky-atmosphere-sun-intensity': 6,
    'sky-atmosphere-color': 'hsl(215, 45%, 32%)',
    'sky-atmosphere-halo-color': 'hsl(215, 60%, 55%)',
  },
});

/** Standard-style config knobs. Applied via `map.setConfigProperty('basemap', …)`. */
export const STANDARD_BASEMAP_CONFIG = Object.freeze({
  lightPreset: LIGHT_PRESET,
  // The environment this milestone is about.
  show3dObjects: true,
  showRoadLabels: true,
  showPlaceLabels: true,
  showTransitLabels: false,
  // Points of interest are visual noise on a fleet-operations map — the
  // operator is reading robots, routes and roads, not restaurants (§12).
  showPointOfInterestLabels: false,
});
