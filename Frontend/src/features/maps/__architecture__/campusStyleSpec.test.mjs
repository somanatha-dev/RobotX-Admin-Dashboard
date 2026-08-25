/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CAMPUS STYLE — validated against the VENDOR's spec, not against our opinion
 *
 * Every other test in this directory checks what we believe about the style.
 * This one checks what Mapbox believes about it, by running the layers we
 * generate through the validator shipped inside `mapbox-gl` itself.
 *
 * ── Why this is worth a test ──────────────────────────────────────────────
 * The whole style path is silent on failure, deliberately and correctly:
 * `useCampusLayer.applyStyle` wraps every `setPaintProperty` in a try/catch so
 * that one property a future Mapbox version does not understand costs that
 * property and not the campus. The cost of that tolerance is that a MISSPELLED
 * property, a number outside its legal range, or a colour where an expression
 * belongs, all fail exactly as quietly — on the live map, as "that theme just
 * doesn't look right", with nothing in the console.
 *
 * The lighting properties are the reason this now matters. Several of them
 * (`-ambient-occlusion-ground-radius`, `-flood-light-*`) are marked
 * experimental in the spec and several `requires: ["lights"]`, so the style
 * built here declares lights the way Mapbox Standard does — the validator will
 * reject a lit-only property in an unlit style, and we want to know that here
 * rather than from a screenshot.
 *
 * Interpolated frames are validated too, because a theme transition applies
 * ~65 intermediate styles that no static theme definition ever equals.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

import { MAP_THEMES, MAP_THEME_ORDER, interpolateThemes } from '../theme/mapThemes.js';
import { campusStyleForTheme, campusLayerSpecs } from '../campus/campusLayers.js';

const require = createRequire(import.meta.url);
const { validate } = require('mapbox-gl/dist/style-spec/index.cjs');

/** Every campus layer except the clip, which paints nothing (see mapTheme.test). */
const SPECS = campusLayerSpecs().filter((s) => s.type !== 'clip');

/**
 * A minimal style carrying our layers.
 *
 * `glyphs` and `lights` are here because the REAL style has them: Standard
 * ships glyphs, and its light preset installs an ambient and a directional
 * light. Omitting either would make the validator reject label layers and every
 * `requires: ["lights"]` property, so leaving them out would test a style we
 * never actually load.
 */
function styleFor(theme, reveal, emphasis = 0) {
  const style = campusStyleForTheme(theme, reveal, emphasis);
  return {
    version: 8,
    glyphs: 'mapbox://fonts/mapbox/{fontstack}/{range}.pbf',
    lights: [
      { id: 'ambient', type: 'ambient', properties: { intensity: 0.5 } },
      {
        id: 'directional',
        type: 'directional',
        properties: { intensity: 0.7, direction: [120, 45], 'cast-shadows': true },
      },
    ],
    sources: Object.fromEntries(
      [...new Set(SPECS.map((s) => s.source))].map((id) => [
        id,
        { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
      ])
    ),
    layers: SPECS.map((spec) => {
      const themed = style[spec.id] || {};
      return {
        ...spec,
        paint: themed.paint || {},
        layout: { ...(spec.layout || {}), ...(themed.layout || {}) },
      };
    }),
  };
}

function assertValid(label, theme, reveal, emphasis = 0) {
  const errors = validate(styleFor(theme, reveal, emphasis));
  assert.deepEqual(
    errors.map((e) => e.message),
    [],
    `${label} (reveal=${reveal}, emphasis=${emphasis}) produced a style Mapbox rejects`
  );
}

test('every theme produces a style the Mapbox validator accepts', () => {
  for (const id of MAP_THEME_ORDER) {
    for (const reveal of [0, 0.5, 1]) {
      assertValid(id, MAP_THEMES[id], reveal);
    }
  }
});

test('Operations mode is valid at every point of its ramp, in every theme', () => {
  // Operations emphasis introduced the first `case` expressions on a circle's
  // opacity and a new `*` inside an interpolate's stops — both places the style
  // spec is strict and `applyStyle`'s try/catch is silent. It ramps over ~55
  // applied styles, none of which any static value equals.
  for (const id of MAP_THEME_ORDER) {
    for (const emphasis of [0, 0.25, 0.5, 0.75, 1]) {
      assertValid(`${id} operations`, MAP_THEMES[id], 1, emphasis);
    }
  }

  // And the two ramps overlap in practice: an operator can switch to Operations
  // while the campus is still fading in on arrival.
  assertValid('DAY arriving into operations', MAP_THEMES.DAY, 0.4, 0.6);
});

test('every frame of every theme transition is a valid style too', () => {
  // A transition is ~65 applied styles that no theme definition equals. A value
  // that is only legal at the endpoints is a defect the operator sees for one
  // second, once per switch — the hardest kind to catch by looking.
  for (let i = 0; i < MAP_THEME_ORDER.length; i += 1) {
    const from = MAP_THEMES[MAP_THEME_ORDER[i]];
    const to = MAP_THEMES[MAP_THEME_ORDER[(i + 1) % MAP_THEME_ORDER.length]];
    for (const t of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      assertValid(`${from.id} → ${to.id} @ ${t}`, interpolateThemes(from, to, t), 1);
    }
  }
});

test('the lighting properties this milestone added are really in the spec', () => {
  // `assertValid` proves the styles are accepted; it cannot prove the
  // properties are doing anything, because an unknown key in `paint` is an
  // error the validator WOULD report — but a key silently dropped upstream
  // would leave a passing test and an unlit map. Asserting the spec carries
  // each name pins the vendor contract these themes are written against.
  const { v8 } = require('mapbox-gl/dist/style-spec/index.cjs');
  const expected = {
    'paint_fill-extrusion': [
      'fill-extrusion-emissive-strength',
      'fill-extrusion-flood-light-color',
      'fill-extrusion-flood-light-intensity',
      'fill-extrusion-flood-light-ground-radius',
      'fill-extrusion-ambient-occlusion-ground-radius',
      'fill-extrusion-cast-shadows',
    ],
    paint_line: ['line-emissive-strength'],
    paint_fill: ['fill-emissive-strength'],
    paint_circle: ['circle-emissive-strength'],
  };
  for (const [group, keys] of Object.entries(expected)) {
    for (const key of keys) {
      assert.ok(v8[group]?.[key], `${group}/${key} is not in the installed style spec`);
    }
  }

  // And the reason every layer must state one: the spec default is "fully lit",
  // i.e. multiplied down by the scene lighting. That default is what made the
  // night campus road render grey after being painted near-white (§59).
  assert.equal(v8.paint_line['line-emissive-strength'].default, 0);
  assert.equal(v8.paint_fill['fill-emissive-strength'].default, 0);
  assert.equal(v8.paint_circle['circle-emissive-strength'].default, 0);
});
