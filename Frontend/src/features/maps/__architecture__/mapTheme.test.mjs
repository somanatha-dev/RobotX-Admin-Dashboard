/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THEMES — every theme resolves, and a theme change is a colour change only
 *
 * The requirement a theme system most easily violates is not "it looks nice".
 * It is §52: a theme change must not reset operational state. These tests pin
 * the two properties that make that true by construction —
 *
 *   1. a theme carries NO geometry, position, camera or robot state, so there
 *      is nothing operational for it to reset;
 *   2. themes interpolate, so applying one is writing values, never rebuilding.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_MAP_THEME,
  MAP_THEME,
  MAP_THEMES,
  MAP_THEME_LABEL,
  MAP_THEME_ORDER,
  THEME_TRANSITION_MS,
  hexToRgb,
  interpolateThemes,
  mixHex,
  resolveMapTheme,
} from '../theme/mapThemes.js';
import { CAMPUS_CATEGORY } from '../campus/campusSchema.js';
import { campusStyleForTheme, campusLayerSpecs, CAMPUS_LAYER } from '../campus/campusLayers.js';

const ALL = MAP_THEME_ORDER.map((id) => MAP_THEMES[id]);

// ── Every theme resolves, completely ────────────────────────────────────────

test('all three themes resolve and are structurally complete', () => {
  assert.deepEqual(MAP_THEME_ORDER, ['DAY', 'EVENING', 'NIGHT']);

  for (const id of MAP_THEME_ORDER) {
    const theme = resolveMapTheme(id);
    assert.equal(theme.id, id);
    assert.equal(theme.label, MAP_THEME_LABEL[id]);

    for (const section of ['basemap', 'atmosphere', 'campus', 'roads', 'labels', 'routes', 'robot']) {
      assert.ok(theme[section], `${id} is missing its ${section} section`);
    }

    // Every building category has a colour, in every theme — a category added
    // later cannot silently fall through to `undefined` in one theme only.
    for (const category of Object.keys(CAMPUS_CATEGORY)) {
      assert.match(theme.campus.buildings[category], /^#[0-9a-f]{6}$/i, `${id}/${category}`);
    }

    // Every road class exists, so the hierarchy cannot lose a level in a theme.
    for (const cls of ['main', 'secondary', 'service', 'path']) {
      assert.ok(theme.roads[cls], `${id} is missing road class ${cls}`);
      assert.match(theme.roads[cls].color, /^#[0-9a-f]{6}$/i);
    }
  }
});

test('an unknown theme id falls back to Day instead of throwing at an operator', () => {
  assert.equal(resolveMapTheme('MIDNIGHT_NEON').id, DEFAULT_MAP_THEME);
  assert.equal(resolveMapTheme(undefined).id, DEFAULT_MAP_THEME);
});

test('the three themes are genuinely different, not one palette with a tint', () => {
  const backgrounds = ALL.map((t) => t.atmosphere.background);
  assert.equal(new Set(backgrounds).size, 3);

  const presets = ALL.map((t) => t.basemap.lightPreset);
  assert.deepEqual(presets, ['day', 'dawn', 'night']);

  // Night is darker than Day, measurably — §19 also says it must not be black.
  const luma = (hex) => {
    const [r, g, b] = hexToRgb(hex);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const dayBg = luma(MAP_THEMES.DAY.atmosphere.background);
  const nightBg = luma(MAP_THEMES.NIGHT.atmosphere.background);
  assert.ok(nightBg < dayBg, 'night must be darker than day');
  assert.ok(nightBg > 12, 'night must not be effectively black (§19)');
});

test('Evening does not use the `dusk` light preset — readability, verified live', () => {
  // Guards a fix that is easy to undo on the assumption that "Evening" and
  // "dusk" obviously belong together. They do not: on the live map `dusk`
  // dimmed the vendor's own place labels, which at RNSIT are the operator's
  // ONLY building identification, to unreadable. See the note in mapThemes.js.
  assert.notEqual(MAP_THEMES.EVENING.basemap.lightPreset, 'dusk');
  assert.equal(MAP_THEMES.EVENING.basemap.lightPreset, 'dawn');
});

test('every theme supplies the vendor colour knobs the campus basemap is styled with', () => {
  // With no surveyed campus geometry, the roads and buildings on screen are
  // the vendor's. These config properties are the only way to give them any
  // hierarchy, so a theme missing one silently loses that hierarchy.
  for (const theme of ALL) {
    for (const key of ['colorMotorways', 'colorRoads', 'colorGreenspace', 'colorBuildingHighlight']) {
      assert.match(theme.basemap[key], /^#[0-9a-f]{6}$/i, `${theme.id} is missing ${key}`);
    }
    // Roads must be lighter than motorway fill in every theme, so the local
    // network the fleet drives reads above the through-traffic network.
    const luma = (hex) => {
      const [r, g, b] = hexToRgb(hex);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    assert.ok(
      luma(theme.basemap.colorRoads) > luma(theme.basemap.colorMotorways),
      `${theme.id}: campus-scale roads must read above motorways`
    );
  }
});

test('the road hierarchy is a hierarchy in every theme', () => {
  // main > secondary > service > path, by width. If two classes ever collapse
  // to the same width the hierarchy stops communicating anything.
  for (const theme of ALL) {
    const { main, secondary, service, path } = theme.roads;
    assert.ok(main.widthScale > secondary.widthScale, `${theme.id}: main vs secondary`);
    assert.ok(secondary.widthScale > service.widthScale, `${theme.id}: secondary vs service`);
    assert.ok(service.widthScale > path.widthScale, `${theme.id}: service vs path`);
  }
});

// ── A theme cannot reset operational state ──────────────────────────────────

test('a theme carries no geometry, position, camera or robot state (§52)', () => {
  // This is the structural reason a theme change cannot move a robot, drop a
  // route, or reframe the camera: there is nothing of that kind in a theme to
  // apply. A property added here that names one would fail this immediately.
  const forbidden = [
    'center', 'zoom', 'pitch', 'bearing', 'camera', 'geometry', 'coordinates',
    'features', 'robots', 'selectedRobotId', 'routesData', 'position',
  ];
  const seen = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      seen.add(key);
      walk(value);
    }
  };
  ALL.forEach(walk);

  for (const key of forbidden) {
    assert.equal(seen.has(key), false, `a theme must not carry "${key}"`);
  }
});

// ── Interpolation ───────────────────────────────────────────────────────────

test('colours mix channel-wise, and non-colours hold then snap', () => {
  assert.equal(mixHex('#000000', '#ffffff', 0), '#000000');
  assert.equal(mixHex('#000000', '#ffffff', 1), '#ffffff');
  assert.equal(mixHex('#000000', '#ffffff', 0.5), '#808080');
  // Junk must not produce a broken colour string on a live map.
  assert.equal(mixHex('not-a-colour', '#ffffff', 0.9), '#ffffff');
});

test('a transition passes through intermediate values, in both directions', () => {
  const day = MAP_THEMES.DAY;
  const night = MAP_THEMES.NIGHT;

  assert.equal(interpolateThemes(day, night, 0), day, 't=0 is the source theme');
  assert.equal(interpolateThemes(day, night, 1), night, 't=1 is the target theme');

  const mid = interpolateThemes(day, night, 0.5);
  assert.notEqual(mid.atmosphere.background, day.atmosphere.background);
  assert.notEqual(mid.atmosphere.background, night.atmosphere.background);
  assert.match(mid.atmosphere.background, /^#[0-9a-f]{6}$/i);

  // Numbers interpolate too — halo width, opacity, sun intensity.
  const a = day.labels.haloWidth;
  const b = night.labels.haloWidth;
  assert.ok(Math.abs(mid.labels.haloWidth - (a + b) / 2) < 1e-9);

  // Reversing gives the mirror value: no direction-dependent drift.
  const back = interpolateThemes(night, day, 0.5);
  assert.equal(back.atmosphere.background, mid.atmosphere.background);
});

test('an interrupted transition can restart from a mid-transition value', () => {
  // Day → Night interrupted at the half-way point, then redirected to Evening.
  // The half-way object is a plain interpolated theme, so it is a valid `from`.
  const mid = interpolateThemes(MAP_THEMES.DAY, MAP_THEMES.NIGHT, 0.5);
  const redirected = interpolateThemes(mid, MAP_THEMES.EVENING, 0.5);

  assert.match(redirected.atmosphere.background, /^#[0-9a-f]{6}$/i);
  assert.match(redirected.campus.buildings.ACADEMIC, /^#[0-9a-f]{6}$/i);
  assert.equal(typeof redirected.roads.main.widthScale, 'number');
  assert.equal(typeof redirected.labels.haloWidth, 'number');
});

test('every theme produces a complete, applicable campus style', () => {
  // If a theme were missing a value, this is where it would surface as
  // `undefined` in a paint property — which Mapbox accepts silently and then
  // renders as black.
  // Derived from the specs rather than listed by hand, so a layer added later
  // is covered automatically. A `clip` layer is the one exemption and it is
  // structural, not cosmetic: it paints nothing at all — it removes the
  // vendor's geometry from inside the campus boundary — so it has no colour a
  // theme could get wrong.
  const themeable = campusLayerSpecs()
    .filter((s) => s.type !== 'clip')
    .map((s) => s.id);

  assert.ok(themeable.length > 0);

  for (const theme of ALL) {
    const style = campusStyleForTheme(theme);
    for (const layerId of themeable) {
      const spec = style[layerId];
      assert.ok(spec, `${theme.id}: no style for ${layerId}`);
      for (const [prop, value] of Object.entries(spec.paint || {})) {
        assert.notEqual(value, undefined, `${theme.id}/${layerId}/${prop} is undefined`);
      }
    }
  }
});

test('the campus geometry survives every theme, and every theme styles it (§24, §28)', () => {
  // The failure this guards is subtle: a theme change that leaves one campus
  // layer unstyled renders it black, or leaves it painted in the PREVIOUS
  // theme's colours — on a layer the operator is reading building mass from.
  // Day → Evening → Night, and every campus layer keeps a complete style.
  const path = [MAP_THEMES.DAY, MAP_THEMES.EVENING, MAP_THEMES.NIGHT, MAP_THEMES.DAY];
  const themeable = campusLayerSpecs().filter((s) => s.type !== 'clip');

  for (let i = 0; i < path.length - 1; i += 1) {
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const frame = interpolateThemes(path[i], path[i + 1], t);
      const style = campusStyleForTheme(frame, 1);
      for (const spec of themeable) {
        const layer = style[spec.id];
        assert.ok(layer, `${spec.id} unstyled at t=${t}`);
        for (const [prop, value] of Object.entries(layer.paint || {})) {
          assert.notEqual(value, undefined, `${spec.id}/${prop} undefined mid-transition`);
          if (typeof value === 'string' && prop.endsWith('color')) {
            assert.match(value, /^#[0-9a-f]{6}$/i, `${spec.id}/${prop} is not a mixable colour`);
          }
        }
      }
    }
  }
});

test('the arrival reveal scales opacity and nothing else', () => {
  const full = campusStyleForTheme(MAP_THEMES.DAY, 1);
  const hidden = campusStyleForTheme(MAP_THEMES.DAY, 0);
  const half = campusStyleForTheme(MAP_THEMES.DAY, 0.5);

  assert.equal(hidden[CAMPUS_LAYER.BUILDINGS].paint['fill-extrusion-opacity'], 0);
  assert.equal(
    half[CAMPUS_LAYER.BUILDINGS].paint['fill-extrusion-opacity'],
    full[CAMPUS_LAYER.BUILDINGS].paint['fill-extrusion-opacity'] / 2
  );

  // Colour and geometry-derived values are untouched by the reveal — fading in
  // must not also change what the campus looks like.
  assert.deepEqual(
    hidden[CAMPUS_LAYER.BUILDINGS].paint['fill-extrusion-color'],
    full[CAMPUS_LAYER.BUILDINGS].paint['fill-extrusion-color']
  );
  assert.deepEqual(
    hidden[CAMPUS_LAYER.ROAD_MAIN].paint['line-width'],
    full[CAMPUS_LAYER.ROAD_MAIN].paint['line-width']
  );
});

test('the transition is long enough to read as time passing, short enough to work through', () => {
  assert.ok(THEME_TRANSITION_MS >= 600);
  assert.ok(THEME_TRANSITION_MS <= 2000);
});

test('theme ids and the control order agree', () => {
  assert.deepEqual([...MAP_THEME_ORDER].sort(), Object.keys(MAP_THEME).sort());
});
