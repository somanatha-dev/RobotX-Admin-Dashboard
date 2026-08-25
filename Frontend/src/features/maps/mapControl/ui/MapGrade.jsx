import React from 'react';

import { MAP_THEMES, MAP_THEME_ORDER, THEME_TRANSITION_MS, hexToRgb } from '../../theme/mapThemes.js';

/**
 * UI LAYER — the colour grade (§60).
 *
 * ── Why this is a DOM layer and not a map property ────────────────────────
 * The two things a time-of-day theme most wants to change are how dark the
 * whole scene is and how the light falls across it, and those are exactly the
 * two Mapbox Standard does not expose. Its ground, land and water colours live
 * inside a sealed import that `setPaintProperty` cannot reach; the only lever
 * is `lightPreset`, and the preset that genuinely looks like dusk was measured
 * to dim the vendor's place labels to unreadable — which at RNSIT costs the
 * operator their only building identification.
 *
 * `map.setLights()` was the other candidate and was rejected on the vendor's
 * own source: `Style.mergeAll` rebuilds the active lights by walking the import
 * tree and keeping only lights whose owning style has them in its `stylesheet`,
 * and `setLights` writes the light objects without writing that stylesheet
 * entry. Any later merge — a `setConfigProperty('basemap', 'lightPreset', …)`
 * call, which is the FIRST thing a theme change does — silently discards them.
 * A lighting model that survives until the next theme switch and then vanishes
 * is worse than none.
 *
 * ── Why it is a vignette and not a wash ───────────────────────────────────
 * A flat tint over the map dims the labels, which is the failure that ruled
 * out `dusk` in the first place. This is transparent through the middle of the
 * viewport and deepens toward the edges: the campus, its labels and the robots
 * sit in the clear centre and lose no contrast, while the frame around them
 * carries the hour.
 *
 * ── Why one layer per theme ───────────────────────────────────────────────
 * CSS does not interpolate gradient stops, so a single layer whose gradient
 * was rewritten per theme would snap while the map beneath it faded. Three
 * static layers cross-faded by opacity animate correctly, cost no per-frame
 * React render, and hold the same "themes interpolate, nothing is rebuilt"
 * contract the campus layers do (§20).
 */

function rgba(hex, alpha) {
  const c = hexToRgb(hex);
  const a = Math.max(0, Math.min(1, typeof alpha === 'number' && Number.isFinite(alpha) ? alpha : 0));
  if (!c) return `rgba(0, 0, 0, ${a})`;
  return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`;
}

/**
 * Two stops of atmosphere: a band of sky colour down from the top of the
 * viewport — where, at campus pitch, the actual sky is — and an elliptical
 * vignette that is fully clear across the operational middle.
 */
function gradeBackground(grade) {
  if (!grade) return 'none';
  const sky = rgba(grade.skyTint, grade.skyTintOpacity);
  const edge = rgba(grade.vignette, grade.vignetteOpacity);
  const mid = rgba(grade.vignette, grade.vignetteOpacity * 0.34);
  return [
    `linear-gradient(to bottom, ${sky} 0%, transparent 38%)`,
    `radial-gradient(ellipse 82% 74% at 50% 44%, transparent 38%, ${mid} 72%, ${edge} 100%)`,
  ].join(', ');
}

export function MapGrade({ themeId }) {
  return (
    <div className="map-grade" aria-hidden="true">
      {MAP_THEME_ORDER.map((id) => (
        <div
          key={id}
          className="map-grade__layer"
          style={{
            background: gradeBackground(MAP_THEMES[id].grade),
            opacity: id === themeId ? 1 : 0,
            transitionDuration: `${THEME_TRANSITION_MS}ms`,
          }}
        />
      ))}
    </div>
  );
}
