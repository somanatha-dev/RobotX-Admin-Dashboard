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
 *       ├── robot        the contrast the 2D marker sits against
 *       └── grade        the colour grade laid over the whole scene (§60)
 *
 * ── Emissive strength: why every layer now declares one (§59) ─────────────
 * Mapbox Standard is a LIT style. Its `lights` multiply every non-emissive
 * layer by the scene's illumination, so at `night` a road we painted `#a8bcd8`
 * is not drawn at `#a8bcd8` — it is drawn at whatever a dark blue night light
 * leaves of it, which is the muddy grey the operator was actually seeing. The
 * spec default for `line/fill/circle-emissive-strength` is 0, i.e. "fully lit",
 * so this was never a colour-picking problem: the colours were being dimmed
 * after we chose them.
 *
 * Each theme therefore states how much of each layer is SELF-lit:
 *   Day       ~0    — the sun is the light; roads and ground take its shading
 *   Evening   low   — a warm low sun still shades, street lighting starts
 *   Night     high  — a campus road at night is an ILLUMINATED surface
 *
 * Labels are exempt: `text-emissive-strength` already defaults to 1.
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
 *
 * ── Why the campus roads are DARK here (§12, §59) ─────────────────────────
 * They used to be white, on the reasoning that a road is a pale surface. On a
 * daylight basemap that is a road drawn in the same value as the ground it
 * crosses: at RNSIT the campus network disappeared into the pale apron it runs
 * over, and the legend's "campus road" swatch was a white bar on a white map.
 * A dark carriageway inside a bright casing is the drawn-map convention for
 * exactly this reason — it is the only treatment that survives both a pale
 * ground and a pale building face. Night inverts it (see NIGHT): after dark the
 * road is the ILLUMINATED element, so it becomes the bright one.
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
    // Outside the campus boundary the buildings and roads on screen are the
    // basemap's. Mapbox Standard seals its layers inside an import, so
    // `setPaintProperty` cannot reach them — but it does expose these colour
    // knobs, and they are the only lever that gives the city context any
    // hierarchy behind the campus. Each is applied through the same tolerant
    // path as `lightPreset`, so a Standard version without one loses that
    // knob, not the theme.
    colorMotorways: '#c4d0e0',
    colorRoads: '#ffffff',
    colorGreenspace: '#cfe4bd',
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
    boundaryLine: '#5b6b82',
    boundaryLineOpacity: 0.6,
    boundaryFill: '#8aa0bd',
    boundaryFillOpacity: 0.07,
    buildingOpacity: 0.94,
    buildingRoof: '#f8fafc',
    buildingEdge: '#7f8fa6',
    buildingEdgeOpacity: 0.55,
    buildingHighlight: '#2563eb',
    /**
     * Gates. The one campus POI with its own colour, because a gate is where a
     * fleet enters and leaves the site. Warm against a cool campus so it reads
     * without being loud — a marker, never a beacon (§15, §46).
     */
    gate: '#c9862f',
    gateEdge: '#8a5a15',
    // ── Contact shading (§46) ───────────────────────────────────────────
    // `Ao*Radius` are the lit-style forms of the legacy `-radius`: with
    // `lights` present — which Standard always has — Mapbox reads the ground
    // and wall radii instead, and the ground radius is how far the shading
    // spreads AWAY from the wall. That is the honest lever for "long shadows":
    // it is the building's own occlusion reaching further, not a drawn shape
    // pretending to be a shadow (§24). Day's sun is high, so it stays short.
    buildingAoIntensity: 0.34,
    buildingAoRadius: 3.4,
    buildingAoGroundRadius: 5,
    buildingAoWallRadius: 3.4,
    /** Self-lit fraction. Zero by day: the sun should do the shading. */
    buildingEmissive: 0,
    groundEmissive: 0,
    pointEmissive: 0,
    /** Light spilling from the base of a building. Off in daylight. */
    floodColor: '#ffffff',
    floodIntensity: 0,
    floodWallRadius: 0,
    floodGroundRadius: 0,
    buildings: buildingPalette(
      {
        // More chroma than the near-greys this started as. The categories have
        // to be TELLABLE APART at a glance — that is the whole claim the legend
        // makes with "colour = type" — while staying quiet enough that no
        // category reads as a highlight (§11, §46).
        ACADEMIC: '#b9cbe4',
        ADMINISTRATIVE: '#e2d1b1',
        RESIDENTIAL: '#bad4c2',
        SPORTS: '#c3daa6',
        UTILITY: '#c2c8d2',
        COMMERCIAL: '#e6d2ab',
        // Warm stone rather than the pink it started as: on the live map a
        // rosier hue made the temple the most saturated object on a campus of
        // blue-greys, sages and tans, and a category tint must not read as a
        // highlight (§11, §46).
        RELIGIOUS: '#dcc9bd',
        OPERATIONAL: '#bfcde6',
      },
      '#c7cfda'
    ),
    // Ground areas — playing fields, courts, parking aprons. Held quieter than
    // the buildings they sit beside so the skyline stays the primary read.
    groundOpacity: 0.6,
    groundEdge: '#8296ae',
    groundEdgeOpacity: 0.45,
    ground: {
      SPORTS: '#c9e0a8',
      OPERATIONAL: '#d4dae4',
      OTHER: '#d8dee7',
    },
  },
  roads: {
    // `casingScale` / `casingOpacity` are part of the theme because the casing
    // is what carries a dark road on a light map: at Day the bright casing is
    // doing as much work as the carriageway. See ROAD_MAIN_CASING.
    main: { color: '#2b3a52', casing: '#ffffff', casingOpacity: 0.95, casingScale: 1.5, opacity: 1, widthScale: 1, emissive: 0 },
    secondary: { color: '#3c4d68', casing: '#f7fafd', casingOpacity: 0.9, casingScale: 1.55, opacity: 0.97, widthScale: 0.72, emissive: 0 },
    service: { color: '#56657f', casing: '#f2f6fb', casingOpacity: 0.85, casingScale: 1.6, opacity: 0.9, widthScale: 0.5, emissive: 0 },
    // Footpaths stay warm and dashed so they never read as a narrow road: the
    // difference between "a robot can drive this" and "it cannot" must survive
    // being seen at a glance (§17).
    path: { color: '#8a6640', casing: '#fdfbf7', casingOpacity: 0.8, casingScale: 1.7, opacity: 0.92, widthScale: 0.34, emissive: 0 },
    steps: { color: '#6f4f30', casing: '#fdfbf7', casingOpacity: 0.8, casingScale: 1.7, opacity: 0.95, widthScale: 0.46, emissive: 0 },
  },
  labels: {
    color: '#0f1a2b',
    halo: '#ffffff',
    haloWidth: 1.7,
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
  /**
   * ── The colour grade (§60) ───────────────────────────────────────────────
   * A DOM layer over the canvas, under every panel, `pointer-events: none`.
   *
   * It exists because the two things a time-of-day theme most wants to change
   * — how dark the whole scene is, and how the light falls across it — are the
   * two the vendor does not expose. Standard's ground, water and land colours
   * live inside a sealed import; only `lightPreset` moves them, and the preset
   * that actually looks like dusk (`dusk`) was measured to dim the vendor's
   * place labels to unreadable. Those labels are load-bearing at RNSIT.
   *
   * So the grade is a VIGNETTE, not a wash: transparent through the middle of
   * the viewport, deepening toward the edges, with a warm band along the top
   * where the sky is. The campus and its labels sit in the clear centre and
   * lose nothing; the frame around them carries the hour. It is chrome over a
   * picture of the world, never a change to what the world is (§24).
   */
  grade: {
    vignette: '#1b2a44',
    vignetteOpacity: 0.14,
    skyTint: '#bcd6f2',
    skyTintOpacity: 0.1,
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
 *
 * ── How Evening gets DARK without going back to `dusk` (§60) ──────────────
 * The vendor preset stays `dawn`, because that decision was made on measured
 * label readability and nothing here changes that measurement. The dusk
 * quality is produced by the three levers we actually own:
 *
 *   1. the grade — a deep plum vignette that closes the frame in and leaves
 *      the campus and its labels in a clear, warm centre;
 *   2. our own palette — every campus surface dropped a full step in
 *      lightness, so the site reads as lit by a low sun, not by a noon one;
 *   3. the occlusion ground radius — nearly doubled, which is what actually
 *      lengthens the shading a low sun throws off each building.
 *
 * The result is darker and warmer than before at every point EXCEPT the
 * labels, which is precisely the trade `dusk` could not make.
 */
const EVENING = {
  id: MAP_THEME.EVENING,
  label: MAP_THEME_LABEL.EVENING,
  basemap: {
    lightPreset: 'dawn',
    showRoadLabels: true,
    showPlaceLabels: true,
    showTransitLabels: false,
    // The city outside the campus, taken down into dusk. Roads stay the
    // brightest thing in the vendor set — at a low sun a carriageway is still
    // catching light when the roofs beside it have stopped — which is also
    // what keeps the through-network readable behind the campus.
    colorMotorways: '#8c7561',
    colorRoads: '#d8c2a4',
    colorGreenspace: '#8fa06a',
    colorBuildingHighlight: '#c9a276',
    colorPlaceLabelHighlight: '#b45309',
  },
  atmosphere: {
    background: '#ad8c68',
    fogColor: '#c9a27a',
    fogHighColor: '#c07a4e',
    fogSpaceColor: '#6d4a3a',
    horizonBlend: 0.12,
    starIntensity: 0.05,
    skyColor: '#c9793f',
    skyHaloColor: '#f5c07a',
    sunIntensity: 10,
  },
  campus: {
    boundaryLine: '#6d523c',
    boundaryLineOpacity: 0.65,
    boundaryFill: '#7a5a3e',
    boundaryFillOpacity: 0.14,
    buildingOpacity: 0.95,
    buildingRoof: '#efdcc0',
    buildingEdge: '#7d5c3d',
    buildingEdgeOpacity: 0.55,
    buildingHighlight: '#e2600c',
    // Brightened rather than darkened for the dusk ground: a gate has to stay
    // findable as the light goes, and this is the hour it starts to be lit.
    gate: '#f0a83c',
    gateEdge: '#6b3f08',
    // ── The long shadows (§26) ──────────────────────────────────────────
    // A low sun throws shading that reaches: the ground radius is what makes
    // it reach, and at 9m it is nearly double Day's. Still the building's own
    // occlusion — nothing here draws a shadow shape that is not earned by a
    // wall standing on the ground.
    buildingAoIntensity: 0.48,
    buildingAoRadius: 4.2,
    buildingAoGroundRadius: 9,
    buildingAoWallRadius: 4.5,
    buildingEmissive: 0.08,
    groundEmissive: 0.05,
    pointEmissive: 0.2,
    // First light spilling from the base of the buildings — the hour the
    // campus lighting comes on, held low so it reads as warmth, not as a glow.
    floodColor: '#ffb765',
    floodIntensity: 0.18,
    floodWallRadius: 3,
    floodGroundRadius: 5,
    buildings: buildingPalette(
      {
        // A full step down from Day, and warmer: these are faces taking a low
        // amber sun, not faces in flat noon light. The category hues are the
        // same hues — a building keeps its identity from day to night (§30).
        ACADEMIC: '#b39a86',
        ADMINISTRATIVE: '#c9a878',
        RESIDENTIAL: '#a9a583',
        SPORTS: '#a8ad74',
        UTILITY: '#a99b8d',
        COMMERCIAL: '#cfa877',
        RELIGIOUS: '#bb9c8c',
        OPERATIONAL: '#ab9a9e',
      },
      '#b0a091'
    ),
    groundOpacity: 0.6,
    groundEdge: '#7a5e40',
    groundEdgeOpacity: 0.5,
    ground: {
      SPORTS: '#a7ae72',
      OPERATIONAL: '#b7a68f',
      OTHER: '#bcab94',
    },
  },
  roads: {
    // Dark carriageway, cream casing — the same read as Day, in Evening's
    // temperature. On a ground this warm a pale road would vanish exactly the
    // way the white one did in daylight.
    main: { color: '#33291f', casing: '#ffeacb', casingOpacity: 0.92, casingScale: 1.5, opacity: 1, widthScale: 1, emissive: 0.12 },
    secondary: { color: '#443627', casing: '#f7e3c6', casingOpacity: 0.88, casingScale: 1.55, opacity: 0.97, widthScale: 0.72, emissive: 0.12 },
    service: { color: '#5a4934', casing: '#f2ddbe', casingOpacity: 0.82, casingScale: 1.6, opacity: 0.9, widthScale: 0.5, emissive: 0.1 },
    path: { color: '#7c5a36', casing: '#ffeacb', casingOpacity: 0.78, casingScale: 1.7, opacity: 0.92, widthScale: 0.34, emissive: 0.1 },
    steps: { color: '#63452a', casing: '#ffeacb', casingOpacity: 0.78, casingScale: 1.7, opacity: 0.95, widthScale: 0.46, emissive: 0.1 },
  },
  labels: {
    color: '#2a1b0e',
    halo: '#ffefd8',
    haloWidth: 1.9,
    secondaryColor: '#54402c',
    sizeScale: 1,
  },
  routes: {
    todo: '#4338ca',
    done: '#7d6a5c',
    halo: '#2c1c0e',
    haloOpacity: 0.34,
    flow: '#fff3dd',
    flowOpacity: 0.62,
    todoOpacity: 0.95,
    doneOpacity: 0.32,
  },
  robot: {
    contactShadow: '#2c1c0e',
    contactShadowOpacity: 0.55,
    labelContrast: 'dark-on-light',
  },
  grade: {
    vignette: '#2a1330',
    vignetteOpacity: 0.42,
    skyTint: '#e08a3c',
    skyTintOpacity: 0.28,
  },
};

/**
 * NIGHT (§19) — a fleet-control map after dark, not a dimmed screenshot.
 * Base is a deep blue-slate rather than black, roads are illuminated, and the
 * label/route contrast is the highest of the three themes because night is
 * when an operator most needs the operational layer to separate cleanly.
 *
 * ── Why the campus roads finally look white here (§59) ────────────────────
 * They were already the palest colour in this theme. They did not RENDER pale,
 * because `line-emissive-strength` defaults to 0 and Standard's night lighting
 * multiplied them down to the same grey as everything else — which is what the
 * legend's bright "campus road" swatch was disagreeing with. The road is now
 * both painted near-white AND declared self-lit, which is what an illuminated
 * carriageway is: a surface that is bright because it is lit, not because the
 * sun is on it.
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
    colorMotorways: '#7f97b8',
    colorRoads: '#c2d6f2',
    colorGreenspace: '#16281c',
    colorBuildingHighlight: '#3b4a66',
    colorPlaceLabelHighlight: '#7dd3fc',
  },
  atmosphere: {
    background: '#0e1626',
    fogColor: '#131d30',
    fogHighColor: '#1f3352',
    fogSpaceColor: '#070d18',
    horizonBlend: 0.05,
    starIntensity: 0.18,
    skyColor: '#16233c',
    skyHaloColor: '#2b4a7a',
    sunIntensity: 4,
  },
  campus: {
    boundaryLine: '#6b90c4',
    boundaryLineOpacity: 0.65,
    boundaryFill: '#22406b',
    boundaryFillOpacity: 0.2,
    buildingOpacity: 0.96,
    buildingRoof: '#44536e',
    buildingEdge: '#7d9ac4',
    buildingEdgeOpacity: 0.5,
    buildingHighlight: '#60a5fa',
    // Brightened for the dark ground — the gate has to stay findable at night
    // without becoming the neon the brief rules out.
    gate: '#ffc45c',
    gateEdge: '#8a6522',
    // Lighter at night: the ground is already dark, so heavy contact shading
    // would only close the small gap the buildings have left to read against
    // (§27 — dark buildings, never a black campus).
    buildingAoIntensity: 0.22,
    buildingAoRadius: 3,
    buildingAoGroundRadius: 4,
    buildingAoWallRadius: 2.6,
    // The one theme where the buildings must carry some of their own light.
    // Without it the night lighting takes an already-dark palette to black,
    // and §27's "dark buildings, never a black campus" stops holding.
    buildingEmissive: 0.22,
    groundEmissive: 0.3,
    pointEmissive: 0.85,
    // Campus lighting, pooling on the ground at the foot of each block. This
    // is the detail that separates "a map at night" from "a map turned down".
    floodColor: '#7fb4ff',
    floodIntensity: 0.34,
    floodWallRadius: 4,
    floodGroundRadius: 7,
    buildings: buildingPalette(
      {
        // Lifted a step off the previous set and pushed apart in hue: at night
        // the lighting compresses everything toward the ground colour, so the
        // categories need MORE separation here than by day, not less.
        ACADEMIC: '#35486a',
        ADMINISTRATIVE: '#4d4257',
        RESIDENTIAL: '#2f4c52',
        SPORTS: '#2d4d3a',
        UTILITY: '#39404f',
        COMMERCIAL: '#4e4437',
        RELIGIOUS: '#4b3a4c',
        OPERATIONAL: '#374063',
      },
      '#373f52'
    ),
    groundOpacity: 0.55,
    groundEdge: '#5b76a0',
    groundEdgeOpacity: 0.45,
    ground: {
      SPORTS: '#1f3524',
      OPERATIONAL: '#232c40',
      OTHER: '#252d3f',
    },
  },
  roads: {
    // The inversion of Day: bright carriageway, dark casing. The casing is now
    // doing the separating — a lit road on a dark ground needs an edge for the
    // same reason a dark road on a light one does.
    main: { color: '#f4f8ff', casing: '#08101d', casingOpacity: 0.85, casingScale: 1.55, opacity: 1, widthScale: 1, emissive: 1 },
    secondary: { color: '#cddcf1', casing: '#08101d', casingOpacity: 0.8, casingScale: 1.6, opacity: 0.97, widthScale: 0.72, emissive: 0.9 },
    service: { color: '#93a8c6', casing: '#08101d', casingOpacity: 0.75, casingScale: 1.65, opacity: 0.9, widthScale: 0.5, emissive: 0.75 },
    path: { color: '#86a3c9', casing: '#08101d', casingOpacity: 0.7, casingScale: 1.7, opacity: 0.92, widthScale: 0.34, emissive: 0.7 },
    steps: { color: '#a7c0e0', casing: '#08101d', casingOpacity: 0.7, casingScale: 1.7, opacity: 0.95, widthScale: 0.46, emissive: 0.75 },
  },
  labels: {
    color: '#eef4ff',
    halo: '#060d18',
    haloWidth: 2.1,
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
  grade: {
    vignette: '#03070f',
    vignetteOpacity: 0.5,
    skyTint: '#12305c',
    skyTintOpacity: 0.22,
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
