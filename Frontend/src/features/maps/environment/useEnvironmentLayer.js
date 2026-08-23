/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ENVIRONMENT LAYER — static 3D geometry, installed once, then left alone
 *
 *   3D Scene
 *   ├── Environment Layer   ← this module: terrain, buildings, sky, lighting
 *   ├── Operational Layer   ← robots, routes, mission pins  (useRobotStream)
 *   └── UI Layer            ← controls, panels, legend      (MapControl)
 *
 * ── The performance contract (§21) ────────────────────────────────────────
 * This hook depends on the map instance and the style epoch. It does NOT
 * depend on robots, telemetry, the selected robot, or anything that changes
 * at telemetry rate — so a `robot:update` arriving twenty times a minute
 * cannot re-run it, and terrain, buildings and sky are never rebuilt by a
 * robot moving. That is enforced structurally by this module's dependency
 * list rather than by anyone remembering to be careful.
 *
 * Re-installation happens exactly when Mapbox itself discards the scene:
 * `map.setStyle()` wipes sources, layers and terrain, and fires `style.load`
 * afterwards. That event is the only re-entry point.
 *
 * ── Degradation (§23) ─────────────────────────────────────────────────────
 * Every install step is independently guarded. Terrain failing does not cost
 * you buildings; buildings failing does not cost you the basemap. The hook
 * reports what actually succeeded rather than assuming, so the UI can say so.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { useCallback, useEffect, useState } from 'react';

import {
  TERRAIN,
  FALLBACK_FOG,
  FALLBACK_BUILDINGS_LAYER,
  FALLBACK_BUILDINGS_LAYER_ID,
  FALLBACK_SKY_LAYER,
  FALLBACK_SKY_LAYER_ID,
  STANDARD_BASEMAP_CONFIG,
} from './environmentConfig.js';

/**
 * True when the loaded style is Mapbox Standard (or another style built on the
 * `basemap` import), which owns its own buildings, lighting and atmosphere.
 *
 * Two independent probes, because getting this wrong is not harmless in either
 * direction: a false negative would paint the fallback's fog and sky layer on
 * top of a style that already renders its own, and a false positive would leave
 * a plain vector style with no depth at all. Neither probe string-matches the
 * style URL, which would break the moment the style is swapped for a custom one
 * built on the same import.
 */
function styleIsStandard(map) {
  try {
    if (typeof map.getConfigProperty?.('basemap', 'lightPreset') === 'string') return true;
  } catch {
    // fall through to the style-spec probe
  }
  try {
    const imports = map.getStyle?.()?.imports;
    return Array.isArray(imports) && imports.some((i) => i?.id === 'basemap');
  } catch {
    return false;
  }
}

/** Does the loaded style already draw a sky? Then the fallback must not add one. */
function styleHasSkyLayer(map) {
  try {
    return (map.getStyle()?.layers || []).some((l) => l.type === 'sky');
  } catch {
    return false;
  }
}

function applyStandardConfig(map) {
  let applied = 0;
  for (const [key, value] of Object.entries(STANDARD_BASEMAP_CONFIG)) {
    try {
      map.setConfigProperty?.('basemap', key, value);
      applied += 1;
    } catch {
      // A future style version may drop a knob — losing one is not a failure.
    }
  }
  return applied > 0;
}

function installTerrain(map) {
  try {
    if (!map.getSource(TERRAIN.sourceId)) {
      map.addSource(TERRAIN.sourceId, { ...TERRAIN.source });
    }
    map.setTerrain({ source: TERRAIN.sourceId, exaggeration: TERRAIN.exaggeration });
    return true;
  } catch {
    // No DEM tiles (offline, token scope, tile error) — the map stays flat but
    // fully usable, and every robot remains visible at its true coordinate.
    try {
      map.setTerrain(null);
    } catch {
      // ignore
    }
    return false;
  }
}

function installFallbackDepth(map) {
  let buildings = false;
  let sky = false;

  try {
    map.setFog({ ...FALLBACK_FOG });
  } catch {
    // ignore
  }

  try {
    if (map.getLayer(FALLBACK_SKY_LAYER_ID) || styleHasSkyLayer(map)) {
      sky = true;
    } else {
      map.addLayer({ ...FALLBACK_SKY_LAYER });
      sky = true;
    }
  } catch {
    // ignore
  }

  try {
    if (map.getSource('composite') && !map.getLayer(FALLBACK_BUILDINGS_LAYER_ID)) {
      // Insert beneath the first symbol layer so street labels stay on top of
      // the skyline instead of being buried by it.
      const layers = map.getStyle()?.layers || [];
      const firstSymbol = layers.find((l) => l.type === 'symbol' && l.layout?.['text-field'])?.id;
      map.addLayer({ ...FALLBACK_BUILDINGS_LAYER }, firstSymbol);
      buildings = true;
    } else if (map.getLayer(FALLBACK_BUILDINGS_LAYER_ID)) {
      buildings = true;
    }
  } catch {
    // ignore
  }

  return { buildings, sky };
}

/**
 * Install and maintain the 3D environment.
 *
 * @param {{current: object|null}} mapRef
 * @param {object} options
 * @param {boolean} options.isMapLoaded
 * @param {boolean} [options.terrainEnabled=true]
 * @returns {{
 *   environmentReady: boolean,
 *   terrainActive: boolean,
 *   buildings3dActive: boolean,
 *   isStandardStyle: boolean,
 * }}
 */
export function useEnvironmentLayer(mapRef, { isMapLoaded, terrainEnabled = true } = {}) {
  const [state, setState] = useState({
    environmentReady: false,
    terrainActive: false,
    buildings3dActive: false,
    isStandardStyle: false,
  });

  const install = useCallback(
    (map) => {
      if (!map) return;

      // Standard draws its own buildings, trees, landmarks and atmosphere once
      // `show3dObjects` is on, so the fallback's explicit extrusions and sky are
      // only for styles that do not. If the style claimed to be Standard but
      // rejected every config property, treat it as not-Standard and give the
      // operator the fallback's depth rather than a flat map (§23).
      const isStandard = styleIsStandard(map) && applyStandardConfig(map);
      let buildings3dActive = true;

      if (!isStandard) {
        const fallback = installFallbackDepth(map);
        buildings3dActive = fallback.buildings;
      }

      let terrainActive = false;
      if (terrainEnabled) {
        terrainActive = installTerrain(map);
      } else {
        try {
          map.setTerrain(null);
        } catch {
          // ignore
        }
      }

      setState({ environmentReady: true, terrainActive, buildings3dActive, isStandardStyle: isStandard });
    },
    // `terrainEnabled` is a rarely-flipped switch, not a per-frame input, so
    // letting it re-identify `install` (and therefore re-run the effect below)
    // costs one listener re-subscription on toggle and keeps the single
    // install path honest.
    [terrainEnabled]
  );

  useEffect(() => {
    const map = mapRef?.current;
    if (!map || !isMapLoaded) return;

    // `style.load` is the only moment the scene needs rebuilding: it is what
    // Mapbox fires after `setStyle()` has discarded every source, layer and
    // the terrain along with them.
    const onStyleLoad = () => install(map);

    // Installing terrain/buildings/sky into the Mapbox scene IS the "update an
    // external system from an effect" case the rule exists to allow; the
    // setState inside `install` only reports back which of those steps the GPU
    // and tile server actually accepted, so the UI can say so honestly (§23).
    // It runs once per style load, not per frame and never per telemetry tick.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    install(map);

    try {
      map.on('style.load', onStyleLoad);
    } catch {
      // ignore
    }

    return () => {
      try {
        map.off('style.load', onStyleLoad);
      } catch {
        // ignore
      }
    };
    // Deliberately free of robot/telemetry/selection dependencies — see the
    // performance contract in this file's header.
  }, [mapRef, isMapLoaded, install]);

  return state;
}
