/**
 * Writing Standard's `basemap` configuration without re-laying out the basemap.
 *
 * mapbox-gl 3.20's `Style.setConfigProperty` has no equality check: every call ends in
 * `updateConfigDependencies(key)`, which re-lays out every basemap layer that reads the key
 * (labels, 3D objects, the light preset's dependants) even when the value did not change.
 * The environment install, the theme and the campus-label switch each re-assert their keys —
 * on every load and every visit — so the basemap was laid out once with the style's defaults
 * and then again, tile by tile, with the values we always wanted.
 *
 * Two rules remove that:
 *   · a key is written only when its current value differs (`setBasemapConfig`);
 *   · a new map is CONSTRUCTED with the values (`initialBasemapConfig`), so the first layout
 *     is already the final one.
 *
 * No React, no mapbox-gl import: only the map handed in.
 */

import { STANDARD_BASEMAP_CONFIG } from './environmentConfig.js';

const BASEMAP = 'basemap';

/**
 * Set one basemap config key, unless it already has that value.
 *
 * @returns {boolean} whether a write was made
 */
export function setBasemapConfig(map, key, value) {
  if (!map || typeof map.setConfigProperty !== 'function') return false;
  try {
    if (typeof map.getConfigProperty === 'function' && map.getConfigProperty(BASEMAP, key) === value) return false;
  } catch {
    // A style without this fragment answers by throwing; the write below decides.
  }
  map.setConfigProperty(BASEMAP, key, value);
  return true;
}

/**
 * The `config` a new map is constructed with: the environment's settings, then the theme's
 * (the theme is applied after the environment, so its keys win — the same order the two
 * hooks write them in).
 */
export function initialBasemapConfig(themeBasemap) {
  return { [BASEMAP]: { ...STANDARD_BASEMAP_CONFIG, ...(themeBasemap || {}) } };
}
