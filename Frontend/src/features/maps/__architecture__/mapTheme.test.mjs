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

// ── The campus road must be VISIBLE, in every theme ─────────────────────────

const luma = (hex) => {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

test('a campus road separates from the ground it crosses, in every theme', () => {
  // The defect this pins: Day and Evening painted the campus carriageway white
  // and near-white, ON a pale campus apron. The road and the ground it ran over
  // sat within a few percent of each other in luminance, so the network the
  // fleet actually drives was invisible — and the legend's white "campus road"
  // swatch was describing something nobody could see.
  //
  // A minimum separation is the property that cannot be satisfied by accident.
  // Which SIDE the road is on is left to the theme: dark-on-light by day,
  // lit-on-dark at night. Both are correct; sitting in the middle is not.
  for (const theme of ALL) {
    const road = luma(theme.roads.main.color);
    const ground = luma(theme.campus.ground.OTHER);
    assert.ok(
      Math.abs(road - ground) > 60,
      `${theme.id}: campus road (${theme.roads.main.color}) does not separate from campus ground (${theme.campus.ground.OTHER})`
    );

    // And the casing has to separate from its own carriageway, because the
    // casing is what draws the road's edge in both directions.
    assert.ok(
      Math.abs(road - luma(theme.roads.main.casing)) > 60,
      `${theme.id}: road casing does not separate from the carriageway`
    );
  }
});

test('the road inverts between day and night, deliberately', () => {
  // Day and Evening: a dark carriageway inside a bright casing.
  // Night: an illuminated carriageway inside a dark casing.
  for (const id of ['DAY', 'EVENING']) {
    const t = MAP_THEMES[id];
    assert.ok(luma(t.roads.main.color) < luma(t.roads.main.casing), `${id}: road should be darker than its casing`);
  }
  const night = MAP_THEMES.NIGHT;
  assert.ok(luma(night.roads.main.color) > luma(night.roads.main.casing), 'NIGHT: road should be brighter than its casing');
  // Night's road is the brightest of the three — it is the one that is lit.
  assert.ok(luma(night.roads.main.color) > luma(MAP_THEMES.DAY.roads.main.color));
  assert.ok(luma(night.roads.main.color) > luma(MAP_THEMES.EVENING.roads.main.color));
});

test('every theme states how much of each layer is self-lit (§59)', () => {
  // Standard is a LIT style: `line/fill/circle-emissive-strength` default to 0,
  // so a colour chosen here is multiplied by the scene's light before it is
  // drawn. Leaving the default is not "no opinion", it is "fully dimmed by the
  // night lighting" — which is what made the night road grey. A theme that
  // omits one of these silently reintroduces that.
  for (const theme of ALL) {
    for (const key of ['buildingEmissive', 'groundEmissive', 'pointEmissive']) {
      assert.equal(typeof theme.campus[key], 'number', `${theme.id} is missing campus.${key}`);
    }
    for (const cls of ['main', 'secondary', 'service', 'path', 'steps']) {
      assert.equal(typeof theme.roads[cls].emissive, 'number', `${theme.id} is missing roads.${cls}.emissive`);
    }
  }

  // A lit night road is the whole point of declaring these at all.
  assert.ok(MAP_THEMES.NIGHT.roads.main.emissive > MAP_THEMES.DAY.roads.main.emissive);
  assert.ok(MAP_THEMES.NIGHT.campus.pointEmissive > MAP_THEMES.DAY.campus.pointEmissive);
});

test('contact shading lengthens as the sun drops (§26)', () => {
  // The ground radius is how far a building's occlusion reaches away from its
  // wall — the honest lever for "longer shadows at a low sun". Evening's sun is
  // the lowest of the three, so its shading must reach furthest.
  const ground = (id) => MAP_THEMES[id].campus.buildingAoGroundRadius;
  assert.ok(ground('EVENING') > ground('DAY'), 'Evening must throw longer shading than Day');
  assert.ok(ground('EVENING') > ground('NIGHT'), 'Evening must throw longer shading than Night');
  assert.ok(MAP_THEMES.EVENING.campus.buildingAoIntensity > MAP_THEMES.DAY.campus.buildingAoIntensity);
});

test('every theme carries a complete colour grade (§60)', () => {
  // The grade is what gives Evening its dusk without the `dusk` preset that was
  // measured to kill the labels. A theme missing it renders no grade at all,
  // and the cross-fade would fade to nothing rather than to that theme's frame.
  for (const theme of ALL) {
    assert.ok(theme.grade, `${theme.id} is missing its grade`);
    assert.match(theme.grade.vignette, /^#[0-9a-f]{6}$/i, `${theme.id}/grade.vignette`);
    assert.match(theme.grade.skyTint, /^#[0-9a-f]{6}$/i, `${theme.id}/grade.skyTint`);
    for (const key of ['vignetteOpacity', 'skyTintOpacity']) {
      const value = theme.grade[key];
      assert.equal(typeof value, 'number', `${theme.id}/grade.${key}`);
      // A grade is atmosphere over an operations map, never a curtain over one:
      // past roughly half opacity it stops being a vignette and starts hiding
      // the city context the campus is read against (§24).
      assert.ok(value >= 0 && value <= 0.6, `${theme.id}/grade.${key} is out of range`);
    }
  }

  // Evening is the darkest grade — that is how it gets to be dusk while its
  // vendor preset stays `dawn` for the labels' sake.
  assert.ok(MAP_THEMES.EVENING.grade.vignetteOpacity > MAP_THEMES.DAY.grade.vignetteOpacity);
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

test('Day → Evening → Night → Day returns the map to exactly where it started', () => {
  // §3L: the three themes stay, transitions are smooth, and cycling through
  // them must not leave residue. Because a theme is a VALUE and a transition is
  // an interpolation between two values, a full cycle is the identity — there
  // is no accumulated state to drift. This asserts that structurally.
  const cycle = [MAP_THEMES.DAY, MAP_THEMES.EVENING, MAP_THEMES.NIGHT, MAP_THEMES.DAY];
  for (let i = 0; i < cycle.length - 1; i += 1) {
    assert.equal(interpolateThemes(cycle[i], cycle[i + 1], 1), cycle[i + 1]);
  }
  assert.deepEqual(campusStyleForTheme(cycle[3]), campusStyleForTheme(cycle[0]));

  // Each hop genuinely changes the picture — a "transition" between two themes
  // that render identically would pass every other test in this file.
  for (let i = 0; i < cycle.length - 1; i += 1) {
    const from = campusStyleForTheme(cycle[i]);
    const to = campusStyleForTheme(cycle[i + 1]);
    assert.notDeepEqual(
      from[CAMPUS_LAYER.ROAD_MAIN].paint['line-color'],
      to[CAMPUS_LAYER.ROAD_MAIN].paint['line-color'],
      `${cycle[i].id} → ${cycle[i + 1].id} left the campus road unchanged`
    );
  }
});

test('Operations mode changes emphasis and nothing an operator navigates by (§3H)', () => {
  const normal = campusStyleForTheme(MAP_THEMES.DAY, 1, 0);
  const ops = campusStyleForTheme(MAP_THEMES.DAY, 1, 1);

  // The campus must NOT be hidden — §3H says so twice. Buildings and ground
  // step back by one notch; they do not disappear.
  const buildingOpacity = (s) => s[CAMPUS_LAYER.BUILDINGS].paint['fill-extrusion-opacity'];
  assert.ok(buildingOpacity(ops) < buildingOpacity(normal), 'buildings must recede in Operations');
  assert.ok(buildingOpacity(ops) > 0.7, 'buildings must remain clearly visible');

  // The roads are how an operator reads where a unit can go. They are left
  // completely alone.
  assert.deepEqual(ops[CAMPUS_LAYER.ROAD_MAIN].paint, normal[CAMPUS_LAYER.ROAD_MAIN].paint);
  assert.deepEqual(ops[CAMPUS_LAYER.PATH].paint, normal[CAMPUS_LAYER.PATH].paint);
  assert.deepEqual(ops[CAMPUS_LAYER.STEPS].paint, normal[CAMPUS_LAYER.STEPS].paint);

  // Colour is emphasis-independent: Operations changes what is prominent, never
  // what anything IS. A category that changed hue between modes would break the
  // legend's "colour = type" claim.
  assert.deepEqual(
    ops[CAMPUS_LAYER.BUILDINGS].paint['fill-extrusion-color'],
    normal[CAMPUS_LAYER.BUILDINGS].paint['fill-extrusion-color']
  );
  assert.deepEqual(ops[CAMPUS_LAYER.BUILDINGS].paint['fill-extrusion-height'], normal[CAMPUS_LAYER.BUILDINGS].paint['fill-extrusion-height']);

  // Nothing is hidden by geometry either: no layer gains a visibility switch.
  for (const [layerId, spec] of Object.entries(ops)) {
    assert.equal(spec.layout?.visibility, undefined, `${layerId} must not be hidden by Operations mode`);
  }
});

test('the emphasis ramp is monotonic, so the transition cannot flicker', () => {
  const opacity = (e) => campusStyleForTheme(MAP_THEMES.NIGHT, 1, e)[CAMPUS_LAYER.BUILDINGS].paint['fill-extrusion-opacity'];
  let previous = Infinity;
  for (const e of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
    const value = opacity(e);
    assert.ok(value <= previous, `emphasis ${e} reversed direction`);
    previous = value;
  }
  // Out-of-range input is clamped rather than extrapolated into a negative
  // opacity, which Mapbox accepts and renders as nothing at all.
  assert.equal(opacity(-1), opacity(0));
  assert.equal(opacity(5), opacity(1));
  assert.equal(opacity('nonsense'), opacity(0));
});

test('the transition is long enough to read as time passing, short enough to work through', () => {
  assert.ok(THEME_TRANSITION_MS >= 600);
  assert.ok(THEME_TRANSITION_MS <= 2000);
});

test('theme ids and the control order agree', () => {
  assert.deepEqual([...MAP_THEME_ORDER].sort(), Object.keys(MAP_THEME).sort());
});
