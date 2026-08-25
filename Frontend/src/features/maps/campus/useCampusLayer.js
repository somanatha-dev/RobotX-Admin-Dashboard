/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CAMPUS LAYER — the semantic layer, installed once and fed with data
 *
 *   3D Scene
 *   ├── ENVIRONMENT LAYER   terrain, vendor buildings, sky   (useEnvironmentLayer)
 *   ├── CAMPUS LAYER        ← this module: boundary, buildings, roads, labels
 *   ├── OPERATIONAL LAYER   robots, routes, mission pins     (useRobotStream)
 *   └── UI LAYER            controls, panels, legend         (MapControl)
 *
 * ── The performance contract, again (§42) ─────────────────────────────────
 * This hook's install effect depends on the map, the style epoch and NOTHING
 * ELSE. Its data effect depends only on the campus definition. Neither has a
 * robot, telemetry or selection dependency, so a `robot:update` twenty times a
 * minute cannot rebuild a single campus layer. Theme frames arrive through a
 * subscription and write paint properties on already-installed layers — no
 * source is re-added, no layer is re-created, and React never re-renders for
 * one.
 *
 * ── Layer ordering ────────────────────────────────────────────────────────
 * Campus layers are inserted BENEATH the basemap's own symbol layers where one
 * can be found, so vendor street labels are not buried under campus geometry,
 * and above everything else so the campus reads as the primary subject at
 * campus zoom (§26).
 *
 * ── Campus precedence over the vendor (§6, §37) ───────────────────────────
 * A `clip` layer, scoped to the basemap import and fed the campus boundary
 * polygon, removes the VENDOR's 3D models and labels inside the campus and
 * nowhere else. That is what stops an OSM footprint we render and a Mapbox
 * footprint of the same building fighting for the same pixels. Outside the
 * boundary the basemap is untouched, so Bengaluru still has its skyline (§57).
 *
 * The clip is best-effort by design: `installVendorClip` retries without the
 * scope and then gives up, and `vendorClipActive` reports what actually
 * happened. Losing the clip must cost de-duplication, never the campus.
 *
 * ── Empty is a valid state ────────────────────────────────────────────────
 * A campus with no registered geometry holds an empty FeatureCollection in
 * every source and draws nothing. The layers still exist, correctly
 * configured. That is deliberate: the failure mode this design refuses is a
 * map that fills a data gap with something that looks like data.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { PROVENANCE, VERIFICATION } from './campusSchema.js';
import {
  CAMPUS_INTERACTIVE_LAYERS,
  CAMPUS_LAYER,
  CAMPUS_LAYER_ORDER,
  CAMPUS_SOURCE,
  EMPTY_COLLECTION,
  campusCollections,
  campusLayerSpecs,
  campusStyleForTheme,
  selectedLabelFilter,
} from './campusLayers.js';

/** How long the campus geometry takes to fade in on arrival (§25, stage 6). */
const REVEAL_MS = 700;

/**
 * How long Operations mode takes to settle in (§3H).
 *
 * Matched to the camera ease that accompanies a mode change, so the framing and
 * the emphasis arrive together rather than as two separate events — a map that
 * moves and then, a beat later, changes appearance reads as two things going
 * wrong rather than one thing happening.
 */
const EMPHASIS_MS = 900;

/** Sources that carry clickable features, so they need stable feature ids. */
const PROMOTED_SOURCES = new Set([CAMPUS_SOURCE.AREAS, CAMPUS_SOURCE.POINTS]);

function firstSymbolLayerId(map) {
  try {
    const layers = map.getStyle()?.layers || [];
    return layers.find((l) => l.type === 'symbol' && l.layout?.['text-field'])?.id;
  } catch {
    return undefined;
  }
}

/**
 * Add the vendor-geometry clip, degrading rather than failing (§37).
 *
 * `clip` arrived in Mapbox GL JS v3.5 and `clip-layer-scope` after it. If this
 * build does not understand either, `addLayer` throws — and losing the clip
 * must cost the map its de-duplication, never its campus. So: try the scoped
 * form, then the unscoped form, then give up and report it, and let the caller
 * tell the operator that vendor buildings may double up rather than leave them
 * to wonder why a footprint has two roofs.
 *
 * @returns {boolean} whether the clip is actually in the style
 */
function installVendorClip(map, spec) {
  try {
    if (map.getLayer(spec.id)) return true;
  } catch {
    return false;
  }

  try {
    map.addLayer(spec);
    return true;
  } catch {
    // Most likely `clip-layer-scope` — scoping the clip to the basemap import
    // is what keeps it from also clipping OUR extrusions. Without it the clip
    // would remove the campus buildings it exists to make room for, so the
    // retry drops the layer types down to models only and accepts that the
    // vendor's labels inside the campus survive.
  }

  try {
    map.addLayer({
      ...spec,
      layout: { 'clip-layer-types': ['model'] },
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Install the campus sources and layers into a Mapbox style, ONCE.
 *
 * Exported so the multi-campus architecture test can drive it against a fake
 * map and assert the property that makes campus switching safe: every call is
 * idempotent, because every `addSource` and every `addLayer` is guarded by a
 * `get*` check. Switching campus does not call this at all — it is a `setData`
 * (see the data effect) — but a style reload does, and re-installing must never
 * produce a second copy of anything.
 *
 * Not a React function and it never was; it only ever needed the map.
 */
export function installSourcesAndLayers(map) {
  let installed = 0;
  let clipActive = false;

  for (const sourceId of Object.values(CAMPUS_SOURCE)) {
    try {
      if (map.getSource(sourceId)) continue;
      map.addSource(sourceId, {
        type: 'geojson',
        data: EMPTY_COLLECTION,
        // Campus feature ids are strings. Mapbox only accepts numeric feature
        // ids natively, so `promoteId` is what makes `setFeatureState` work for
        // building selection without renumbering the campus dataset.
        ...(PROMOTED_SOURCES.has(sourceId) ? { promoteId: 'id' } : {}),
      });
    } catch {
      // ignore — a failed source costs its layers, not the whole campus layer
    }
  }

  const beneath = firstSymbolLayerId(map);

  for (const spec of campusLayerSpecs()) {
    try {
      if (map.getLayer(spec.id)) {
        installed += 1;
        if (spec.type === 'clip') clipActive = true;
        continue;
      }
      if (!map.getSource(spec.source)) continue;

      if (spec.type === 'clip') {
        clipActive = installVendorClip(map, spec);
        if (clipActive) installed += 1;
        continue;
      }

      // Campus labels are symbols in their own right and must sit ON TOP of
      // the basemap's labels, not under them; everything else goes beneath.
      const isLabel = spec.type === 'symbol';
      map.addLayer(spec, isLabel ? undefined : beneath);
      installed += 1;
    } catch {
      // ignore
    }
  }

  return { installed, clipActive };
}

/** The teardown half, exported for the same reason as the install half. */
export function removeCampusLayers(map) {
  // Layers first, then sources — a source with a layer still attached cannot
  // be removed.
  for (const layerId of [...CAMPUS_LAYER_ORDER].reverse()) {
    try {
      if (map.getLayer(layerId)) map.removeLayer(layerId);
    } catch {
      // ignore
    }
  }
  for (const sourceId of Object.values(CAMPUS_SOURCE)) {
    try {
      if (map.getSource(sourceId)) map.removeSource(sourceId);
    } catch {
      // ignore
    }
  }
}

/**
 * Feed the campus sources a definition. THIS IS WHAT SWITCHING CAMPUS IS.
 *
 * Not a teardown, not a re-install, not a style reload: five `setData` calls
 * onto sources that were installed once and never touched again. That is the
 * whole reason RNSIT → JSSATE → RNSIT cannot accumulate layers, duplicate
 * sources, strand geometry or recreate the Mapbox instance — there is no code
 * path in a campus change that adds or removes anything.
 *
 * A campus with no registered geometry pushes empty collections, which is the
 * same operation with a different value, so an unknown campus clears the map
 * rather than leaving the previous one's buildings on screen.
 *
 * Exported so the architecture test can drive the real function.
 */
export function pushCampusData(map, definition) {
  if (!map) return;
  const collections = campusCollections(definition);
  for (const [sourceId, data] of Object.entries(collections)) {
    try {
      map.getSource(sourceId)?.setData?.(data);
    } catch {
      // ignore
    }
  }
}

function applyStyle(map, theme, reveal, emphasis) {
  if (!map || !theme) return;
  const style = campusStyleForTheme(theme, reveal, emphasis);

  for (const [layerId, spec] of Object.entries(style)) {
    let exists = false;
    try {
      exists = Boolean(map.getLayer(layerId));
    } catch {
      exists = false;
    }
    if (!exists) continue;

    for (const [prop, value] of Object.entries(spec.paint || {})) {
      try {
        map.setPaintProperty(layerId, prop, value);
      } catch {
        // ignore
      }
    }
    for (const [prop, value] of Object.entries(spec.layout || {})) {
      try {
        map.setLayoutProperty(layerId, prop, value);
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Read a clicked basemap feature honestly.
 *
 * The basemap's buildings and places are the VENDOR's data (OpenStreetMap via
 * Mapbox). They are real geometry and often carry a real name — which is why
 * they are worth surfacing (§33: an operator should be able to find things) —
 * but they are not an RNSIT survey, and the card built from this says so. Only
 * fields that are actually present are returned; nothing is filled in.
 */
function readVendorFeature(feature, index) {
  const props = feature?.properties || {};
  const name = typeof props.name === 'string' && props.name.trim() ? props.name.trim() : null;
  const type = typeof props.type === 'string' ? props.type : typeof props.class === 'string' ? props.class : null;
  const height = typeof props.height === 'number' ? props.height : null;
  const minHeight = typeof props.min_height === 'number' ? props.min_height : null;

  // ── What Mapbox Standard actually hands back (measured on the live map) ──
  // A clicked basemap building carries `height`, `min_height` and `group` —
  // and NO name, class or id. So a click cannot tell an operator which
  // building this is, and the card must say so rather than leave the operator
  // to assume the map knows and simply is not showing it.
  const hasIdentity = Boolean(name || type);
  const hasVolume = height !== null || minHeight !== null;
  if (!hasIdentity && !hasVolume) return null;

  return {
    id: `vendor:${feature?.id ?? name ?? type ?? `hit-${index}`}`,
    name: name || 'Basemap building',
    kind: 'VENDOR_FEATURE',
    category: null,
    provenance: PROVENANCE.VENDOR_BASEMAP,
    verification: VERIFICATION.NOT_VERIFIED,
    source: hasIdentity
      ? 'Mapbox basemap (OpenStreetMap contributors) — city context, not an RNSIT survey'
      : 'Mapbox basemap (OpenStreetMap contributors). This footprint carries no name, ' +
        'class or identifier in the basemap data — the map does not know which building it is.',
    metadata: {
      ...(type ? { 'Basemap class': type } : {}),
      ...(height !== null ? { Height: `${Math.round(height)} m` } : {}),
      ...(!hasIdentity ? { Identity: 'Not in basemap data' } : {}),
    },
    isVendor: true,
  };
}

/**
 * @param {{current: object|null}} mapRef
 * @param {object} options
 * @param {boolean} options.isMapLoaded
 * @param {boolean} options.environmentReady
 * @param {object} options.definition        validated CampusDefinition
 * @param {boolean} options.active           is a campus currently focused?
 * @param {(fn: (theme: object) => void) => (() => void)} options.subscribeToTheme
 * @param {string|null} options.selectedFeatureId
 * @param {(feature: object|null) => void} [options.onSelectFeature]
 */
export function useCampusLayer(
  mapRef,
  {
    isMapLoaded,
    environmentReady,
    definition,
    active,
    subscribeToTheme,
    selectedFeatureId,
    onSelectFeature,
    /** 0 = the campus as a place, 1 = the campus as a worksite (§3H). */
    operationsEmphasis = 0,
  } = {}
) {
  const [layersReady, setLayersReady] = useState(false);
  /** Is the vendor's own 3D geometry actually being clipped inside the campus? */
  const [vendorClipActive, setVendorClipActive] = useState(false);

  const themeRef = useRef(null);
  const revealRef = useRef(0);
  const revealRafRef = useRef(null);
  const emphasisRef = useRef(0);
  const emphasisRafRef = useRef(null);
  // Read inside imperative callbacks — the click handler, the reveal animation
  // frame — never during render. They are seeded with the first value and
  // synced after each commit, so the map handlers always see current data
  // without the handlers themselves having to be re-subscribed on every change.
  const definitionRef = useRef(definition);
  const onSelectFeatureRef = useRef(onSelectFeature);
  const selectedFeatureIdRef = useRef(selectedFeatureId);
  useEffect(() => {
    definitionRef.current = definition;
    onSelectFeatureRef.current = onSelectFeature;
    selectedFeatureIdRef.current = selectedFeatureId;
  }, [definition, onSelectFeature, selectedFeatureId]);

  /** The feature id currently carrying `feature-state.selected`, for clean removal. */
  const highlightedRef = useRef(null);

  const repaint = useCallback(() => {
    applyStyle(mapRef?.current, themeRef.current, revealRef.current, emphasisRef.current);
  }, [mapRef]);

  const pushData = useCallback(() => {
    pushCampusData(mapRef?.current, definitionRef.current);
  }, [mapRef]);

  // ── Install (once per style load) ──────────────────────────────────────────
  //
  // Waits on `environmentReady` for the same reason the focus camera does: a
  // layer added before the style's own layers are settled has no stable
  // insertion point to be placed beneath.
  useEffect(() => {
    const map = mapRef?.current;
    if (!map || !isMapLoaded || !environmentReady) return;

    const install = () => {
      const { installed, clipActive } = installSourcesAndLayers(map);
      pushData();
      repaint();
      // A style reload rebuilds every layer from its spec, and the spec's
      // filter is the empty one. Re-applying the live selection here is what
      // stops a `setStyle` from silently dropping the selected feature's label
      // until the operator happens to select something else.
      try {
        if (map.getLayer(CAMPUS_LAYER.LABEL_SELECTED)) {
          map.setFilter(CAMPUS_LAYER.LABEL_SELECTED, selectedLabelFilter(selectedFeatureIdRef.current));
        }
      } catch {
        // ignore
      }
      // Installing into the Mapbox scene IS the external-system case; the
      // setState only reports whether the GPU accepted the layers, and runs
      // once per style load — never per frame, never per telemetry tick.
      setLayersReady(installed > 0);
      setVendorClipActive(clipActive);
    };

    install();

    // `setStyle()` discards every source and layer and fires this afterwards.
    const onStyleLoad = () => install();
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
      removeCampusLayers(map);
    };
    // Deliberately free of robot, telemetry, theme and selection dependencies.
  }, [mapRef, isMapLoaded, environmentReady, pushData, repaint]);

  // ── Data ───────────────────────────────────────────────────────────────────
  // A different campus (or the same campus gaining surveyed geometry) is a
  // `setData` call. Nothing is torn down.
  useEffect(() => {
    pushData();
  }, [definition, pushData]);

  // ── Theme frames ───────────────────────────────────────────────────────────
  // One subscription for the whole campus layer. Each frame writes paint
  // properties onto existing layers; this is the reason a theme change cannot
  // disturb campus geometry, robots or routes (§52).
  useEffect(() => {
    if (typeof subscribeToTheme !== 'function') return;
    return subscribeToTheme((theme) => {
      themeRef.current = theme;
      repaint();
    });
  }, [subscribeToTheme, repaint]);

  // ── Reveal / conceal (§25 arrival, §40 reset) ──────────────────────────────
  //
  // Leaving the campus ramps the semantic layer back down to zero, so a reset
  // cannot leave campus labels or campus geometry visible at global zoom.
  useEffect(() => {
    const target = active ? 1 : 0;
    const from = revealRef.current;
    if (from === target) {
      repaint();
      return;
    }

    if (revealRafRef.current !== null) {
      try {
        cancelAnimationFrame(revealRafRef.current);
      } catch {
        // ignore
      }
      revealRafRef.current = null;
    }

    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / REVEAL_MS);
      revealRef.current = from + (target - from) * t;
      repaint();
      revealRafRef.current = t < 1 ? requestAnimationFrame(step) : null;
    };
    revealRafRef.current = requestAnimationFrame(step);

    return () => {
      if (revealRafRef.current !== null) {
        try {
          cancelAnimationFrame(revealRafRef.current);
        } catch {
          // ignore
        }
        revealRafRef.current = null;
      }
    };
  }, [active, repaint]);

  // ── Operations emphasis (§3H) ──────────────────────────────────────────────
  //
  // Ramped rather than switched, on the same mechanism as the arrival reveal:
  // paint properties written onto layers that already exist. No layer is added,
  // removed, hidden or re-filtered, so entering Operations mode cannot disturb
  // the campus geometry, a robot, a route or the selection — the same property
  // a theme change has, for the same structural reason (§20).
  useEffect(() => {
    const target = Math.max(0, Math.min(1, Number(operationsEmphasis) || 0));
    const from = emphasisRef.current;
    if (from === target) {
      repaint();
      return;
    }

    if (emphasisRafRef.current !== null) {
      try {
        cancelAnimationFrame(emphasisRafRef.current);
      } catch {
        // ignore
      }
      emphasisRafRef.current = null;
    }

    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / EMPHASIS_MS);
      emphasisRef.current = from + (target - from) * t;
      repaint();
      emphasisRafRef.current = t < 1 ? requestAnimationFrame(step) : null;
    };
    emphasisRafRef.current = requestAnimationFrame(step);

    return () => {
      if (emphasisRafRef.current !== null) {
        try {
          cancelAnimationFrame(emphasisRafRef.current);
        } catch {
          // ignore
        }
        emphasisRafRef.current = null;
      }
    };
  }, [operationsEmphasis, repaint]);

  // ── The selected feature's label (§3K) ─────────────────────────────────────
  //
  // One `setFilter` on a layer that is always installed. The layer is never
  // added or removed, so its position in the draw order — above every other
  // label — is fixed once, at install, and cannot drift as selections change.
  useEffect(() => {
    const map = mapRef?.current;
    if (!map) return;
    try {
      if (map.getLayer(CAMPUS_LAYER.LABEL_SELECTED)) {
        map.setFilter(CAMPUS_LAYER.LABEL_SELECTED, selectedLabelFilter(selectedFeatureId));
      }
    } catch {
      // ignore — losing the emphasised label costs emphasis, never the campus
    }
  }, [selectedFeatureId, mapRef, layersReady]);

  // ── Selection highlight (§36) ──────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef?.current;
    if (!map) return;

    const clear = (ref) => {
      if (!ref) return;
      try {
        map.removeFeatureState({ source: ref.source, id: ref.id }, 'selected');
      } catch {
        // ignore
      }
    };

    clear(highlightedRef.current);
    highlightedRef.current = null;

    if (!selectedFeatureId) return;

    for (const source of PROMOTED_SOURCES) {
      try {
        map.setFeatureState({ source, id: selectedFeatureId }, { selected: true });
        highlightedRef.current = { source, id: selectedFeatureId };
      } catch {
        // ignore — the feature may live in the other source
      }
    }

    return () => clear(highlightedRef.current);
  }, [selectedFeatureId, mapRef, layersReady]);

  // ── Click → feature details (§35) ──────────────────────────────────────────
  useEffect(() => {
    const map = mapRef?.current;
    if (!map || !isMapLoaded) return;

    const onClick = (event) => {
      const handler = onSelectFeatureRef.current;
      if (!handler) return;

      // Campus features first: our own data always outranks the vendor's.
      const ourLayers = CAMPUS_INTERACTIVE_LAYERS.filter((id) => {
        try {
          return Boolean(map.getLayer(id));
        } catch {
          return false;
        }
      });

      let hits = [];
      try {
        hits = ourLayers.length ? map.queryRenderedFeatures(event.point, { layers: ourLayers }) : [];
      } catch {
        hits = [];
      }

      if (hits.length > 0) {
        const props = hits[0].properties || {};
        const id = typeof props.id === 'string' ? props.id : null;
        const known = (definitionRef.current?.features || []).find((f) => f.id === id) || null;
        handler(known ? { ...known, isVendor: false } : null);
        return;
      }

      // Nothing of ours was clicked. Fall back to the basemap so an operator
      // can still identify what they are looking at — clearly attributed.
      let vendorHits = [];
      try {
        vendorHits = map.queryRenderedFeatures(event.point) || [];
      } catch {
        vendorHits = [];
      }
      for (const [i, f] of vendorHits.entries()) {
        const read = readVendorFeature(f, i);
        if (read) {
          handler(read);
          return;
        }
      }
      handler(null);
    };

    try {
      map.on('click', onClick);
    } catch {
      // ignore
    }
    return () => {
      try {
        map.off('click', onClick);
      } catch {
        // ignore
      }
    };
  }, [mapRef, isMapLoaded]);

  return {
    campusLayersReady: layersReady,
    vendorClipActive,
    campusFeatureCount: Array.isArray(definition?.features) ? definition.features.length : 0,
  };
}

export { CAMPUS_LAYER };
