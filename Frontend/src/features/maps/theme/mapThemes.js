/**
 * ═══════════════════════════════════════════════════════════════════════════
 * MAP THEMES — Day / Evening / Night as data, not as conditionals
 *
 *   MapTheme
 *       ├── basemap      vendor style config (light preset, label switches)
 *       ├── atmosphere   sky / fog / background
 *       ├── campus       boundary, buildings-by-category, ground
 *       ├── roads        main · secondary · path · service   (§12 hierarchy)
 *       ├── labels       colour, halo, size
 *       ├── routes       ahead / travelled / flow / halo     (§13)
 *       └── robot        the contrast the 2D marker sits against
 *
 * ── Why this file exists (§22) ────────────────────────────────────────────
 * Not one `if (night)` anywhere in the map components. A theme is a value;
 * switching themes is passing a different value; adding DAWN, FOG or
 * EMERGENCY later is adding an entry here and nothing else.
 *
 * ── Why every colour is a hex string ──────────────────────────────────────
 * Because themes are INTERPOLATED, not swapped (§20). `interpolateThemes`
 * walks two theme trees and mixes them channel-by-channel, which requires a
 * numerically-mixable colour form. `hsl(...)` strings would have to be parsed
 * on every frame of every transition; hex does not.
 *
 * ── What a theme deliberately does NOT contain ────────────────────────────
 * Geometry, positions, camera framing, or anything an operator navigates by.
 * A theme changes how the world looks and never where anything is (§ "accuracy
 * over effects"). The robot marker's own colours stay identity-derived — the
 * theme only supplies the ground it must remain legible against (§15).
 *
 * Pure module: no React, no Mapbox — loadable under plain Node by the tests.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { CAMPUS_CATEGORY } from '../campus/campusSchema.js';

export const MAP_THEME = Object.freeze({
  DAY: 'DAY',
  EVENING: 'EVENING',
  NIGHT: 'NIGHT',
});

/** Presentation order for the theme control — chronological, not alphabetical. */
export const MAP_THEME_ORDER = Object.freeze([MAP_THEME.DAY, MAP_THEME.EVENING, MAP_THEME.NIGHT]);

export const MAP_THEME_LABEL = Object.freeze({
  DAY: 'Day',
  EVENING: 'Evening',
  NIGHT: 'Night',
});

/** How long a theme transition takes. Long enough to read as time passing. */
export const THEME_TRANSITION_MS = 1100;

// ── Colour helpers ───────────────────────────────────────────────────────────

const HEX = /^#([0-9a-f]{6})$/i;

/** '#rrggbb' → [r, g, b]; null if it is not a plain 6-digit hex. */
export function hexToRgb(hex) {
  const m = HEX.exec(String(hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Linear mix of two hex colours. `t = 0` is `a`, `t = 1` is `b`. */
export function mixHex(a, b, t) {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  if (!ca || !cb) return t < 0.5 ? a : b;
  const k = Math.max(0, Math.min(1, typeof t === 'number' && Number.isFinite(t) ? t : 0));
  return rgbToHex([ca[0] + (cb[0] - ca[0]) * k, ca[1] + (cb[1] - ca[1]) * k, ca[2] + (cb[2] - ca[2]) * k]);
}

function isHexColor(v) {
  return typeof v === 'string' && HEX.test(v.trim());
}

// ── Building palette (§30) ───────────────────────────────────────────────────
//
// One restrained hue per category, held at low saturation so the map stays
// coherent. The operator should read "different building types", never "every
// building has a random colour". The same hues run through all three themes at
// different lightness — a category keeps its identity from day to night.

function buildingPalette(hexByCategory, fallback) {
  const out = {};
  for (const key of Object.keys(CAMPUS_CATEGORY)) {
    out[key] = hexByCategory[key] || fallback;
  }
  return out;
}

// ── The themes ───────────────────────────────────────────────────────────────

/**
 * DAY (§17) — bright, clean, high contrast, built for daytime operations.
 * Buildings are deliberately not white: pure white loses all face-to-face
 * shading and the skyline flattens into paper cut-outs.
 */
const DAY = {
  id: MAP_THEME.DAY,
  label: MAP_THEME_LABEL.DAY,
  basemap: {
    lightPreset: 'day',
    showRoadLabels: true,
    showPlaceLabels: true,
    showTransitLabels: false,
    // ── Theming the VENDOR's geometry (§12, §30) ──────────────────────────
    // At RNSIT the buildings and roads on screen are the basemap's, because
    // this repository has no surveyed campus geometry. Mapbox Standard seals
    // its layers inside an import, so `setPaintProperty` cannot reach them —
    // but it does expose these colour knobs, and they are the only lever that
    // gives the road hierarchy and the building mass any contrast at campus
    // zoom. Each is applied through the same tolerant path as `lightPreset`,
    // so a Standard version without one loses that knob, not the theme.
    colorMotorways: '#c9d4e2',
    colorRoads: '#ffffff',
    colorGreenspace: '#d6e8c8',
    colorBuildingHighlight: '#dfe7f0',
    colorPlaceLabelHighlight: '#1d4ed8',
  },
  atmosphere: {
    background: '#e8eef5',
    fogColor: '#dfe8f3',
    fogHighColor: '#b6cfe8',
    fogSpaceColor: '#9dbfe0',
    horizonBlend: 0.06,
    starIntensity: 0,
    skyColor: '#8fb8e0',
    skyHaloColor: '#dbeafe',
    sunIntensity: 8,
  },
  campus: {
    boundaryLine: '#64748b',
    boundaryLineOpacity: 0.55,
    boundaryFill: '#94a3b8',
    boundaryFillOpacity: 0.06,
    buildingOpacity: 0.92,
    buildingRoof: '#f8fafc',
    buildingEdge: '#94a3b8',
    buildingEdgeOpacity: 0.5,
    buildingHighlight: '#2563eb',
    /**
     * Gates. The one campus POI with its own colour, because a gate is where a
     * fleet enters and leaves the site. Warm against a cool campus so it reads
     * without being loud — a marker, never a beacon (§15, §46).
     */
    gate: '#c9862f',
    gateEdge: '#8a5a15',
    /** Contact shading where a wall meets the ground. Depth, not drama (§46). */
    buildingAoIntensity: 0.28,
    buildings: buildingPalette(
      {
        ACADEMIC: '#c3d0e0',
        ADMINISTRATIVE: '#dcd0bd',
        RESIDENTIAL: '#c6d6c9',
        SPORTS: '#c2d8b4',
        UTILITY: '#c8ccd3',
        COMMERCIAL: '#e0d3ba',
        // Warm stone rather than the pink it started as: on the live map a
        // rosier hue made the temple the most saturated object on a campus of
        // blue-greys, sages and tans, and a category tint must not read as a
        // highlight (§11, §46).
        RELIGIOUS: '#d8ccc4',
        OPERATIONAL: '#c9d3e2',
      },
      '#c9cfd8'
    ),
    // Ground areas — playing fields, courts, parking aprons. Held quieter than
    // the buildings they sit beside so the skyline stays the primary read.
    groundOpacity: 0.55,
    groundEdge: '#8fa0b5',
    groundEdgeOpacity: 0.4,
    ground: {
      SPORTS: '#cfe0b7',
      OPERATIONAL: '#d8dde5',
      OTHER: '#d9dfe6',
    },
  },
  roads: {
    main: { color: '#ffffff', casing: '#94a3b8', opacity: 1, widthScale: 1 },
    secondary: { color: '#f6f8fb', casing: '#a8b3c2', opacity: 0.95, widthScale: 0.72 },
    service: { color: '#e9edf3', casing: '#aab4c2', opacity: 0.85, widthScale: 0.5 },
    path: { color: '#8fa0b5', casing: '#ffffff', opacity: 0.9, widthScale: 0.34 },
    steps: { color: '#7d8ea6', casing: '#ffffff', opacity: 0.95, widthScale: 0.46 },
  },
  labels: {
    color: '#111c2e',
    halo: '#ffffff',
    haloWidth: 1.6,
    secondaryColor: '#3d4a5c',
    sizeScale: 1,
  },
  routes: {
    todo: '#4f46e5',
    done: '#7c8598',
    halo: '#0b1220',
    haloOpacity: 0.22,
    flow: '#ffffff',
    flowOpacity: 0.55,
    todoOpacity: 0.95,
    doneOpacity: 0.3,
  },
  robot: {
    /** Ground the 2D marker sits on — drives its contact shadow strength. */
    contactShadow: '#0b1220',
    contactShadowOpacity: 0.5,
    labelContrast: 'dark-on-light',
  },
};

/**
 * EVENING (§18) — golden hour: warm low light, long shadows, warm sky, with
 * operational information still fully readable.
 *
 * ── Why the vendor preset is `dawn` and not `dusk` ────────────────────────
 * `dusk` was tried first, on the live map, and it reproduced exactly the
 * failure the previous milestone documented when it rejected `dusk` as the
 * global light preset: the basemap washes to a low-contrast brown-mauve in
 * which campus ground, building faces and road fill sit within a few percent
 * of each other in luminance — and, worse here, the vendor dims its own place
 * labels with it. At RNSIT those labels ("CSE", "RNSIT Mec and EEE
 * Department", "Hostel") are the ONLY identification the operator has, because
 * this repository holds no campus building names. Under `dusk` they were
 * effectively unreadable.
 *
 * `dawn` renders the same golden, low-sun quality — warm amber light, long
 * shadows, warm sky — while keeping labels and roads at full contrast. The
 * theme is a VIEWING MODE, not a claim about the time of day or the sun's
 * azimuth, and §18's hard requirement is readability. So Evening is `dawn`.
 * Verified by side-by-side capture on the running map; see the report.
 *
 * The palette below is therefore tuned against a BRIGHT warm basemap: dark
 * labels on light haloes, like Day, not the light-on-dark set a dusk theme
 * would need.
 */
const EVENING = {
  id: MAP_THEME.EVENING,
  label: MAP_THEME_LABEL.EVENING,
  basemap: {
    lightPreset: 'dawn',
    showRoadLabels: true,
    showPlaceLabels: true,
    showTransitLabels: false,
    // Roads held near-white against the warm ground — this is what keeps the
    // hierarchy legible when everything else shifts amber.
    colorMotorways: '#d8cdbe',
    colorRoads: '#fbf7f2',
    colorGreenspace: '#cfdcb4',
    colorBuildingHighlight: '#f0dcc4',
    colorPlaceLabelHighlight: '#b45309',
  },
  atmosphere: {
    background: '#e9dccb',
    fogColor: '#e8d5bd',
    fogHighColor: '#e0a878',
    fogSpaceColor: '#b58a6a',
    horizonBlend: 0.09,
    starIntensity: 0.02,
    skyColor: '#e0a878',
    skyHaloColor: '#fbdcb0',
    sunIntensity: 12,
  },
  campus: {
    boundaryLine: '#8a6b53',
    boundaryLineOpacity: 0.6,
    boundaryFill: '#b08a63',
    boundaryFillOpacity: 0.09,
    buildingOpacity: 0.94,
    buildingRoof: '#fbf1e2',
    buildingEdge: '#a8845f',
    buildingEdgeOpacity: 0.5,
    buildingHighlight: '#c2410c',
    // Pushed cooler and darker than the Day gate: against Evening's warm ground
    // a warm marker would disappear into it.
    gate: '#8c5a12',
    gateEdge: '#5c3806',
    // Longer contact shadows at a low sun (§26) — still shading, not staging.
    buildingAoIntensity: 0.36,
    buildings: buildingPalette(
      {
        ACADEMIC: '#d9cec2',
        ADMINISTRATIVE: '#e6cfae',
        RESIDENTIAL: '#d2d3bd',
        SPORTS: '#cdd8ab',
        UTILITY: '#d3cbc2',
        COMMERCIAL: '#ecd4b0',
        RELIGIOUS: '#e0cec2',
        OPERATIONAL: '#d6cdcb',
      },
      '#d6ccc1'
    ),
    groundOpacity: 0.55,
    groundEdge: '#a08667',
    groundEdgeOpacity: 0.42,
    ground: {
      SPORTS: '#d5dcae',
      OPERATIONAL: '#e0d5c6',
      OTHER: '#e2d8c9',
    },
  },
  roads: {
    main: { color: '#fffaf3', casing: '#a08667', opacity: 1, widthScale: 1 },
    secondary: { color: '#f6ece0', casing: '#ab8f74', opacity: 0.95, widthScale: 0.72 },
    service: { color: '#e8dbcb', casing: '#b09474', opacity: 0.85, widthScale: 0.5 },
    path: { color: '#9c8166', casing: '#fffaf3', opacity: 0.9, widthScale: 0.34 },
    steps: { color: '#8a6c4f', casing: '#fffaf3', opacity: 0.95, widthScale: 0.46 },
  },
  labels: {
    color: '#2a1c10',
    halo: '#fff6e8',
    haloWidth: 1.8,
    secondaryColor: '#5b4632',
    sizeScale: 1,
  },
  routes: {
    todo: '#4338ca',
    done: '#8a7f79',
    halo: '#3b2a1a',
    haloOpacity: 0.3,
    flow: '#fff8ec',
    flowOpacity: 0.62,
    todoOpacity: 0.95,
    doneOpacity: 0.32,
  },
  robot: {
    contactShadow: '#3b2a1a',
    contactShadowOpacity: 0.5,
    labelContrast: 'dark-on-light',
  },
};

/**
 * NIGHT (§19) — a fleet-control map after dark, not a dimmed screenshot.
 * Base is a deep blue-slate rather than black, roads are illuminated, and the
 * label/route contrast is the highest of the three themes because night is
 * when an operator most needs the operational layer to separate cleanly.
 */
const NIGHT = {
  id: MAP_THEME.NIGHT,
  label: MAP_THEME_LABEL.NIGHT,
  basemap: {
    lightPreset: 'night',
    showRoadLabels: true,
    showPlaceLabels: true,
    showTransitLabels: false,
    // Roads are the illuminated element at night — lifted well clear of the
    // dark ground so the network an operator navigates by stays legible.
    colorMotorways: '#8fa6c4',
    colorRoads: '#a9bcd6',
    colorGreenspace: '#1d3326',
    colorBuildingHighlight: '#37445c',
    colorPlaceLabelHighlight: '#7dd3fc',
  },
  atmosphere: {
    background: '#111a2b',
    fogColor: '#162034',
    fogHighColor: '#1f3352',
    fogSpaceColor: '#0a1120',
    horizonBlend: 0.05,
    starIntensity: 0.15,
    skyColor: '#16233c',
    skyHaloColor: '#2b4a7a',
    sunIntensity: 4,
  },
  campus: {
    boundaryLine: '#5a7ba6',
    boundaryLineOpacity: 0.6,
    boundaryFill: '#2a3d5c',
    boundaryFillOpacity: 0.16,
    buildingOpacity: 0.95,
    buildingRoof: '#3a4761',
    buildingEdge: '#6b86ad',
    buildingEdgeOpacity: 0.42,
    buildingHighlight: '#5b9dff',
    // Brightened for the dark ground — the gate has to stay findable at night
    // without becoming the neon the brief rules out.
    gate: '#e0a94e',
    gateEdge: '#8a6522',
    // Lighter at night: the ground is already dark, so heavy contact shading
    // would only close the small gap the buildings have left to read against
    // (§27 — dark buildings, never a black campus).
    buildingAoIntensity: 0.18,
    buildings: buildingPalette(
      {
        ACADEMIC: '#2f3d55',
        ADMINISTRATIVE: '#453c4c',
        RESIDENTIAL: '#2e4247',
        SPORTS: '#2c4436',
        UTILITY: '#333a46',
        COMMERCIAL: '#463f38',
        RELIGIOUS: '#453444',
        OPERATIONAL: '#333a5a',
      },
      '#323a4a'
    ),
    groundOpacity: 0.5,
    groundEdge: '#4f6689',
    groundEdgeOpacity: 0.4,
    ground: {
      SPORTS: '#22321f',
      OPERATIONAL: '#232b3c',
      OTHER: '#242c3b',
    },
  },
  roads: {
    main: { color: '#a8bcd8', casing: '#0b1424', opacity: 1, widthScale: 1 },
    secondary: { color: '#7d92b0', casing: '#0b1424', opacity: 0.95, widthScale: 0.72 },
    service: { color: '#5b6c86', casing: '#0b1424', opacity: 0.85, widthScale: 0.5 },
    path: { color: '#6f88a8', casing: '#0b1424', opacity: 0.9, widthScale: 0.34 },
    steps: { color: '#8298b8', casing: '#0b1424', opacity: 0.95, widthScale: 0.46 },
  },
  labels: {
    color: '#eaf2ff',
    halo: '#0a1120',
    haloWidth: 2,
    secondaryColor: '#a9bcd6',
    sizeScale: 1,
  },
  routes: {
    todo: '#7aa2ff',
    done: '#5c6b7a',
    halo: '#000814',
    haloOpacity: 0.4,
    flow: '#ffffff',
    flowOpacity: 0.7,
    todoOpacity: 1,
    doneOpacity: 0.32,
  },
  robot: {
    contactShadow: '#000814',
    contactShadowOpacity: 0.6,
    labelContrast: 'light-on-dark',
  },
};

function deepFreeze(obj) {
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object') deepFreeze(value);
  }
  return Object.freeze(obj);
}

export const MAP_THEMES = deepFreeze({
  [MAP_THEME.DAY]: DAY,
  [MAP_THEME.EVENING]: EVENING,
  [MAP_THEME.NIGHT]: NIGHT,
});

export const DEFAULT_MAP_THEME = MAP_THEME.DAY;

/** Resolve a theme by id, falling back to Day rather than throwing at a user. */
export function resolveMapTheme(themeId) {
  return MAP_THEMES[themeId] || MAP_THEMES[DEFAULT_MAP_THEME];
}

/**
 * Interpolate between two themes.
 *
 * Walks the tree generically so a new theme key is animated the day it is
 * added — there is no per-property switch to forget to update.
 *
 *   number  → linear
 *   hex     → channel mix
 *   other   → `from` until t >= 1, then `to`
 *
 * Strings that are not colours (light presets, contrast hints) hold their
 * starting value for the whole transition and snap at the end. The vendor's
 * `lightPreset` is applied separately, at t = 0, so Mapbox animates its own
 * lighting across the same window rather than jumping at the end of ours.
 */
export function interpolateThemes(from, to, t) {
  const k = Math.max(0, Math.min(1, typeof t === 'number' && Number.isFinite(t) ? t : 0));
  if (k <= 0) return from;
  if (k >= 1) return to;

  const walk = (a, b) => {
    if (typeof a === 'number' && typeof b === 'number') return a + (b - a) * k;
    if (isHexColor(a) && isHexColor(b)) return mixHex(a, b, k);
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      const out = Array.isArray(a) ? [] : {};
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        out[key] = key in a && key in b ? walk(a[key], b[key]) : key in b ? b[key] : a[key];
      }
      return out;
    }
    return a;
  };

  return walk(from, to);
}
