/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THEME APPLICATION — interpolate the world, never rebuild it
 *
 * The forbidden implementation (§20) is:
 *
 *      Day → setStyle() → sources destroyed → layers destroyed → terrain gone
 *          → robots reset → routes reset → selection reset → Night
 *
 * This hook never calls `setStyle`. A theme change is:
 *
 *      capture the CURRENTLY DISPLAYED theme values
 *          ↓
 *      hand the vendor its light preset (Mapbox animates its own lighting)
 *          ↓
 *      interpolate every value WE own, frame by frame, in place
 *          ↓
 *      notify consumers with the interpolated theme each frame
 *
 * Nothing is added, removed or re-created, so a theme change cannot touch a
 * robot marker, a route line, the selected robot, the camera or the terrain.
 * That is a structural property of not reloading, not a behaviour anyone has
 * to remember to preserve.
 *
 * ── Interrupting a transition ─────────────────────────────────────────────
 * `from` is the LIVE interpolated theme, not the previous theme's definition.
 * Switching Day → Night and then → Evening halfway through continues from the
 * half-way colours instead of snapping back to Day first.
 *
 * ── Where each value lands ────────────────────────────────────────────────
 *   basemap config   → the vendor's own lighting model (Standard styles)
 *   fog / sky        → only on the fallback style, which draws neither itself
 *   everything else  → consumers (campus layers, route layers) via subscribe
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  DEFAULT_MAP_THEME,
  MAP_THEME,
  THEME_TRANSITION_MS,
  interpolateThemes,
  resolveMapTheme,
} from './mapThemes.js';

const STORAGE_KEY = 'robotx.map.theme';

function readStoredTheme() {
  if (typeof window === 'undefined') return DEFAULT_MAP_THEME;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw && MAP_THEME[raw] ? raw : DEFAULT_MAP_THEME;
  } catch {
    return DEFAULT_MAP_THEME;
  }
}

function persistTheme(themeId) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, themeId);
  } catch {
    // ignore
  }
}

/** Smootherstep — no velocity discontinuity at either end of the transition. */
function ease(t) {
  return t * t * (3 - 2 * t);
}

/**
 * Push the parts of a theme that belong to the map itself.
 *
 * Standard styles own their sky, fog and lighting; handing them ours would
 * fight the vendor's model and produce exactly the low-contrast mush the
 * previous milestone rejected. So Standard gets the light preset and nothing
 * else, and the fallback style — which draws no atmosphere of its own — gets
 * the full interpolated set.
 */
function applyAtmosphere(map, theme, isStandardStyle) {
  if (!map || isStandardStyle) return;
  const a = theme.atmosphere;
  try {
    map.setFog({
      range: [1.5, 12],
      color: a.fogColor,
      'high-color': a.fogHighColor,
      'space-color': a.fogSpaceColor,
      'horizon-blend': a.horizonBlend,
      'star-intensity': a.starIntensity,
    });
  } catch {
    // ignore
  }
  try {
    if (map.getLayer('robotx-sky')) {
      map.setPaintProperty('robotx-sky', 'sky-atmosphere-color', a.skyColor);
      map.setPaintProperty('robotx-sky', 'sky-atmosphere-halo-color', a.skyHaloColor);
      map.setPaintProperty('robotx-sky', 'sky-atmosphere-sun-intensity', a.sunIntensity);
    }
  } catch {
    // ignore
  }
}

function applyBasemapConfig(map, theme) {
  for (const [key, value] of Object.entries(theme.basemap || {})) {
    try {
      map.setConfigProperty?.('basemap', key, value);
    } catch {
      // A style version without this knob loses one property, not the theme.
    }
  }
}

/**
 * @param {{current: object|null}} mapRef
 * @param {object} options
 * @param {boolean} options.isMapLoaded
 * @param {boolean} options.isStandardStyle
 * @returns {{
 *   themeId: string,
 *   setThemeId: (id: string) => void,
 *   theme: object,             // the theme DEFINITION (stable, for UI chrome)
 *   themeRef: {current: object},
 *   subscribeToTheme: (fn: (theme: object) => void) => (() => void),
 *   isTransitioning: boolean,
 * }}
 */
export function useMapTheme(mapRef, { isMapLoaded, isStandardStyle } = {}) {
  const [themeId, setThemeIdState] = useState(readStoredTheme);
  const [isTransitioning, setIsTransitioning] = useState(false);

  /** The live, possibly mid-transition theme. Read by every consumer. */
  const themeRef = useRef(resolveMapTheme(readStoredTheme()));
  const consumersRef = useRef(new Set());
  const rafRef = useRef(null);

  // Read inside animation frames, not during render. It is a ref rather than a
  // dependency deliberately: the style flipping to (or from) Standard must not
  // restart an in-flight theme transition, it must only change where the next
  // frame's atmosphere values are sent.
  const isStandardRef = useRef(Boolean(isStandardStyle));
  useEffect(() => {
    isStandardRef.current = Boolean(isStandardStyle);
  }, [isStandardStyle]);

  const notify = useCallback((theme) => {
    themeRef.current = theme;
    for (const fn of consumersRef.current) {
      try {
        fn(theme);
      } catch {
        // A consumer throwing must not abort the transition for the others.
      }
    }
  }, []);

  /**
   * Subscribe to interpolated theme frames.
   *
   * The callback is invoked immediately with the current theme so a consumer
   * that mounts mid-transition (or after one) is never left unstyled.
   */
  const subscribeToTheme = useCallback(
    (fn) => {
      if (typeof fn !== 'function') return () => {};
      consumersRef.current.add(fn);
      try {
        fn(themeRef.current);
      } catch {
        // ignore
      }
      return () => consumersRef.current.delete(fn);
    },
    []
  );

  const cancelTransition = useCallback(() => {
    if (rafRef.current !== null) {
      try {
        cancelAnimationFrame(rafRef.current);
      } catch {
        // ignore
      }
      rafRef.current = null;
    }
  }, []);

  const setThemeId = useCallback((next) => {
    if (!MAP_THEME[next]) return;
    setThemeIdState(next);
    persistTheme(next);
  }, []);

  // ── The transition ─────────────────────────────────────────────────────────
  //
  // Depends on the target theme and the map being loaded. It has NO dependency
  // on robots, routes, selection or the camera — which is precisely why it
  // cannot disturb them.
  useEffect(() => {
    const map = mapRef?.current;
    if (!map || !isMapLoaded) return;

    const to = resolveMapTheme(themeId);
    const from = themeRef.current;

    // Hand the vendor its light preset at the START of our window so its
    // lighting animation and ours run concurrently rather than end to end.
    applyBasemapConfig(map, to);

    if (from === to || from?.id === to.id) {
      notify(to);
      applyAtmosphere(map, to, isStandardRef.current);
      return;
    }

    cancelTransition();
    // Driving the Mapbox scene from an effect IS the "update an external
    // system" case; this setState only reports that the drive has started, so
    // the control can announce it to a screen reader. It runs once per theme
    // change — not per frame, and never per telemetry tick.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsTransitioning(true);

    const start = performance.now();
    const step = (now) => {
      const raw = Math.min(1, (now - start) / THEME_TRANSITION_MS);
      const frame = raw >= 1 ? to : interpolateThemes(from, to, ease(raw));
      notify(frame);
      applyAtmosphere(map, frame, isStandardRef.current);

      if (raw < 1) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        rafRef.current = null;
        setIsTransitioning(false);
      }
    };
    rafRef.current = requestAnimationFrame(step);

    return cancelTransition;
    // `notify` and `cancelTransition` are stable.
  }, [themeId, isMapLoaded, mapRef, notify, cancelTransition]);

  // A style reload (the fallback path, or a lost style) discards fog and sky.
  // Re-assert the CURRENT theme immediately — not the target of an abandoned
  // transition, and without animating, because there is nothing to animate
  // from: the scene came back blank.
  useEffect(() => {
    const map = mapRef?.current;
    if (!map || !isMapLoaded) return;

    const onStyleLoad = () => {
      const theme = themeRef.current;
      applyBasemapConfig(map, theme);
      applyAtmosphere(map, theme, isStandardRef.current);
      notify(theme);
    };

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
  }, [mapRef, isMapLoaded, notify]);

  useEffect(() => cancelTransition, [cancelTransition]);

  return {
    themeId,
    setThemeId,
    theme: resolveMapTheme(themeId),
    themeRef,
    subscribeToTheme,
    isTransitioning,
  };
}
