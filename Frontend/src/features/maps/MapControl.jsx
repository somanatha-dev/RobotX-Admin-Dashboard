import React, { useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import gsap from 'gsap';

import { MAP_STYLE } from '@/config/mapConfig.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select.jsx';
import { Button } from '@/components/ui/button.jsx';

const CAMPUS_STYLE = 'mapbox://styles/mapbox/standard';

import { MapProvider } from './mapControl/MapProvider.jsx';
import { useMapContext } from './mapControl/mapContext.js';
import { useMapController } from './mapControl/hooks/useMapController.js';
import { useLocationFilters } from './mapControl/hooks/useLocationFilters.js';
import { useRobotStream } from './mapControl/hooks/useRobotStream.js';
import { useAppState } from '@/context/appContext.js';

// WORLD VIEW (strict)
const WORLD_CENTER = [20, 0];
const WORLD_ZOOM = 1.5;

const ZOOM_LEVELS = {
  COUNTRY: 4.7,
  STATE: 6.7,
  CITY: 9.6,
  AREA: 13.2,
  CAMPUS: 17.2,
};

// Below this zoom, a fixed-pixel marker/route line represents so much ground
// distance that even an exactly-correct GPS coordinate reads as "floating
// off the road" — see mapboxMarkers.js / useRobotStream.js zoom-scaling
// notes. Live delivery-tracking apps never expose that scale during
// tracking, so once a location/campus is focused (robots become visible) we
// clamp how far the user can scroll out. World overview (no filter) is
// reached only programmatically via flyTo, so it's exempt.
const TRACKING_MIN_ZOOM = 11;

// Module-level (not component state) so it survives MapControl unmounting —
// navigating to another route tears down the whole Mapbox instance (see the
// map-init effect below), so anything that needs to outlive that has to live
// outside the component tree. Holds wherever the user last left the camera,
// and whether the map has ever been opened before in this browser session —
// used to skip the "earth → area" flyTo intro on every return visit and
// just restore the exact last view instantly instead.
let persistedMapCamera = null; // { lon, lat, zoom, pitch, bearing }
let mapHasBeenOpenedBefore = false;

function toSelectableValue(id) {
  return id ? String(id) : '__none__';
}

function fromSelectableValue(v) {
  if (!v || v === '__none__') return null;
  return String(v);
}

function hasCenter(loc) {
  return typeof loc?.lat === 'number' && typeof loc?.lon === 'number';
}

function MapFiltersBar({
  countries,
  states,
  cities,
  areas,
  campuses,
  countryId,
  stateId,
  cityId,
  areaId,
  campusId,
  setCountryId,
  setStateId,
  setCityId,
  setAreaId,
  setCampusId,
  loading,
  resetAll,
}) {
  return (
    <div className="map-filters-bar" aria-label="Map location filters">
      <div className="map-filters-bar__group">
        <Select value={toSelectableValue(countryId)} onValueChange={(v) => setCountryId(fromSelectableValue(v))}>
          <SelectTrigger className="map-filter-trigger">
            <SelectValue placeholder={loading.countries ? 'Loading…' : 'Country'} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">World</SelectItem>
            {countries.map((c) => (
              <SelectItem key={c.id} value={String(c.id)}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={toSelectableValue(stateId)}
          onValueChange={(v) => setStateId(fromSelectableValue(v))}
          disabled={!countryId || loading.states}
        >
          <SelectTrigger className="map-filter-trigger">
            <SelectValue placeholder={loading.states ? 'Loading…' : 'State'} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">None</SelectItem>
            {states.map((s) => (
              <SelectItem key={s.id} value={String(s.id)}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={toSelectableValue(cityId)}
          onValueChange={(v) => setCityId(fromSelectableValue(v))}
          disabled={!stateId || loading.cities}
        >
          <SelectTrigger className="map-filter-trigger">
            <SelectValue placeholder={loading.cities ? 'Loading…' : 'City'} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">None</SelectItem>
            {cities.map((ci) => (
              <SelectItem key={ci.id} value={String(ci.id)}>
                {ci.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={toSelectableValue(areaId)}
          onValueChange={(v) => setAreaId(fromSelectableValue(v))}
          disabled={!cityId || loading.areas}
        >
          <SelectTrigger className="map-filter-trigger">
            <SelectValue placeholder={loading.areas ? 'Loading…' : 'Area'} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">None</SelectItem>
            {areas.map((a) => (
              <SelectItem key={a.id} value={String(a.id)}>
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={toSelectableValue(campusId)} onValueChange={(v) => setCampusId(fromSelectableValue(v))}>
          <SelectTrigger className="map-filter-trigger">
            <SelectValue placeholder={loading.campuses ? 'Loading…' : 'Campus'} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">None</SelectItem>
            {Array.isArray(campuses) &&
              campuses.map((c) => (
                <SelectItem key={c.id} value={String(c.id)}>
                  {c.name}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      </div>

      <Button type="button" variant="ghost" size="sm" onClick={resetAll} className="map-filters-bar__reset">
        Reset
      </Button>
    </div>
  );
}

function MapControlInner({ filtersHost }) {
  const { mapContainerRef, mapRef, markersRef } = useMapContext();
  const { robots: globalRobots, taskPathCacheRef } = useAppState();

  const overlayRef = useRef(null);
  const canvasRef = useRef(null);
  const styleModeRef = useRef('default');
  const styleTransitionIdRef = useRef(0);
  const latestCameraRef = useRef(null);

  // Captured once, at this component instance's first render — true if the
  // map was already opened earlier in this session (i.e. this is a
  // navigate-back-to-/map remount, not the very first visit). Consumed by
  // the focusTarget effect below: on a returning visit, its first run
  // should do nothing (the map is already constructed at the last-saved
  // camera) instead of replaying the "earth → area" flyTo.
  const skipNextFlyToRef = useRef(mapHasBeenOpenedBefore);

  const token = import.meta.env.VITE_MAPBOX_TOKEN;

  // Initialize Mapbox once (no reloads)
  useEffect(() => {
    if (!token) return;
    if (!mapContainerRef.current) return;
    if (mapRef.current) return;

    mapboxgl.accessToken = token;

    // Returning visit: open exactly where the user left off, instantly —
    // no world-view flash, no replayed flyTo animation.
    const startCam = persistedMapCamera;

    const map = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: MAP_STYLE,
      center: startCam ? [startCam.lon, startCam.lat] : WORLD_CENTER,
      zoom: startCam ? startCam.zoom : WORLD_ZOOM,
      pitch: startCam ? startCam.pitch : 0,
      bearing: startCam ? startCam.bearing : 0,
      maxPitch: 0,          // hard lock — no tilt ever
      attributionControl: false,
    });

    mapHasBeenOpenedBefore = true;

    // Disable all rotation/tilt gestures so the map stays flat 2D
    map.dragRotate.disable();
    try { map.touchZoomRotate.disableRotation(); } catch { /* ignore */ }

    // Show compass (for bearing reset) but not pitch control since we lock pitch=0
    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-left');

    mapRef.current = map;
    const markers = markersRef.current;

    // Remember wherever the user leaves the camera, so the next time this
    // page mounts (even after a full teardown from route navigation) it can
    // reopen there instead of restarting the intro animation.
    const onMoveEnd = () => {
      try {
        const c = map.getCenter();
        persistedMapCamera = {
          lon: c.lng,
          lat: c.lat,
          zoom: map.getZoom(),
          pitch: map.getPitch(),
          bearing: map.getBearing(),
        };
      } catch {
        // ignore
      }
    };
    map.on('moveend', onMoveEnd);

    const onResize = () => {
      try {
        map.resize();
      } catch {
        // ignore
      }
    };

    window.addEventListener('resize', onResize);

    // The `window` resize event only fires for actual browser-window
    // changes. The map container also changes size from purely CSS-driven
    // layout shifts — the sidebar's `transition-[padding]` (see Layout.jsx),
    // the fullscreen toggle, filter bar wrapping — none of which dispatch a
    // window resize event. Without recalibrating on those too, the canvas's
    // backing store goes stale relative to its CSS size and gets stretched,
    // which reads as a blurry map. A ResizeObserver catches every case.
    let resizeObserver = null;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(onResize);
      resizeObserver.observe(mapContainerRef.current);
    }

    return () => {
      window.removeEventListener('resize', onResize);
      resizeObserver?.disconnect();
      try {
        map.off('moveend', onMoveEnd);
      } catch {
        // ignore
      }

      try {
        markers.forEach((m) => {
          try {
            m?.marker?.remove?.();
          } catch {
            // ignore
          }
        });
      } catch {
        // ignore
      }
      try {
        markers.clear();
      } catch {
        // ignore
      }

      try {
        map.remove();
      } catch {
        // ignore
      }
      mapRef.current = null;
    };
  }, [token, mapContainerRef, mapRef, markersRef]);

  const { isMapLoaded, flyTo } = useMapController(mapRef, { overlayRef, canvasRef });

  const {
    countries,
    states,
    cities,
    areas,
    campuses,
    countryId,
    stateId,
    cityId,
    areaId,
    campusId,
    selectedCountry,
    selectedState,
    selectedCity,
    selectedArea,
    selectedCampus,
    setCountryId,
    setStateId,
    setCityId,
    setAreaId,
    setCampusId,
    loading,
    resetAll,
  } = useLocationFilters();

  // Focus rules — always flat top-down (pitch=0, bearing=0) for clean road visibility
  //
  // Persisted filters (country+state+city+area, restored from localStorage by
  // useLocationFilters) are all set as ids on the very first render, but each
  // level's option list loads from its own independent, unsynchronized fetch.
  // Without the loading guards below, each list resolves at whatever moment
  // its request completes, so `selected*` fills in one level at a time —
  // country, then state, then city, then area — and each intermediate fill
  // computed its own focusTarget, firing its own flyTo that interrupted the
  // previous one mid-flight. That's what produced the black/glitchy tile
  // flashes reported on first load: every interrupted flight abandons
  // whatever tiles it had just started fetching, and the visible camera path
  // jumps repeatedly instead of one clean world -> target flight.
  //
  // Fix: if a deeper id is set but its list is still loading, report
  // `undefined` ("still resolving", handled by the effect below by doing
  // nothing) instead of falling back to whatever shallower level happens to
  // already be resolved. That collapses the whole hierarchy into a single
  // flyTo once the deepest persisted level is known.
  const focusTarget = useMemo(() => {
    if (campusId && !selectedCampus && loading.campuses) return undefined;
    if (areaId && !selectedArea && loading.areas) return undefined;
    if (cityId && !selectedCity && loading.cities) return undefined;
    if (stateId && !selectedState && loading.states) return undefined;
    if (countryId && !selectedCountry && loading.countries) return undefined;

    if (selectedCampus) {
      return {
        type: 'CAMPUS',
        loc: { lat: selectedCampus.centerLat, lon: selectedCampus.centerLon },
        pitch: 0,
        bearing: 0,
      };
    }
    if (selectedArea) return { type: 'AREA', loc: selectedArea, pitch: 0, bearing: 0 };
    if (selectedCity) return { type: 'CITY', loc: selectedCity, pitch: 0, bearing: 0 };
    if (selectedState) return { type: 'STATE', loc: selectedState, pitch: 0, bearing: 0 };
    if (selectedCountry) return { type: 'COUNTRY', loc: selectedCountry, pitch: 0, bearing: 0 };
    return null;
  }, [
    campusId,
    areaId,
    cityId,
    stateId,
    countryId,
    selectedCampus,
    selectedCountry,
    selectedState,
    selectedCity,
    selectedArea,
    loading.campuses,
    loading.areas,
    loading.cities,
    loading.states,
    loading.countries,
  ]);

  useEffect(() => {
    if (!isMapLoaded) return;
    // Still waiting on a deeper hierarchy level's list to load (see the
    // focusTarget comment above) — don't touch the camera yet.
    if (focusTarget === undefined) return;

    const wantStyleMode = campusId ? 'campus' : 'default';
    const isStyleAboutToSwitch = styleModeRef.current !== wantStyleMode;

    // Returning visit: this first run just means "the map finished loading
    // again" — it's already sitting at the restored camera (see the
    // map-init effect), so don't replay the earth→area flyTo on top of it.
    // Filter changes made *after* this point (user picks a new area while
    // already on the page) still animate normally.
    const skipAnimation = skipNextFlyToRef.current;
    skipNextFlyToRef.current = false;

    // No filters selected: world view — lift the zoom clamp so the
    // programmatic flyTo(WORLD_ZOOM) below isn't fighting its own limit.
    if (!focusTarget) {
      try { mapRef.current?.setMinZoom(0); } catch { /* ignore */ }
      const cam = { lon: WORLD_CENTER[0], lat: WORLD_CENTER[1], zoom: WORLD_ZOOM, pitch: 0, bearing: 0 };
      latestCameraRef.current = cam;
      if (!isStyleAboutToSwitch && !skipAnimation) flyTo(cam);
      return;
    }

    const { type, loc } = focusTarget;
    if (!hasCenter(loc)) return;

    // Only clamp the zoom floor for the tight AREA/CAMPUS tracking view —
    // COUNTRY/STATE/CITY targets sit at zoom 4.7-9.6, well below
    // TRACKING_MIN_ZOOM (11). Clamping unconditionally forced flyTo's
    // target up to 11 regardless of what the filter asked for, so picking
    // e.g. a state flew the camera to zoom 11 on an arbitrary point instead
    // of 6.7 — a huge batch of never-cached tiles at that zoom, hence the
    // multi-second blank glitch before anything rendered.
    const isTightTrackingView = type === 'AREA' || type === 'CAMPUS';
    try {
      mapRef.current?.setMinZoom(isTightTrackingView ? TRACKING_MIN_ZOOM : 0);
    } catch {
      // ignore
    }

    const cam = {
      lon: loc.lon,
      lat: loc.lat,
      zoom: ZOOM_LEVELS[type] || WORLD_ZOOM,
      pitch: typeof focusTarget?.pitch === 'number' ? focusTarget.pitch : 0,
      bearing: typeof focusTarget?.bearing === 'number' ? focusTarget.bearing : 0,
    };

    latestCameraRef.current = cam;
    if (!isStyleAboutToSwitch && !skipAnimation) flyTo(cam);
  }, [isMapLoaded, focusTarget, flyTo, campusId, mapRef]);

  // Always use the flat road style — 3D campus tilt makes markers misalign with roads.
  // This effect is kept but immediately returns when no style change is needed.
  useEffect(() => {
    const map = mapRef?.current;
    if (!map) return;

    // Always 'default' — never switch to tilted 3D campus style
    const wantMode = 'default';
    if (styleModeRef.current === wantMode) return;
    styleModeRef.current = wantMode;

    const nextStyle = MAP_STYLE;

    const overlayEl = overlayRef.current;
    const canvasEl = canvasRef.current;

    const transitionId = Date.now();
    styleTransitionIdRef.current = transitionId;

    const setInteractive = (isInteractive) => {
      if (!canvasEl) return;
      canvasEl.style.pointerEvents = isInteractive ? '' : 'none';
    };

    const fadeOut = () => {
      try {
        if (canvasEl) gsap.killTweensOf(canvasEl);
        if (overlayEl) gsap.killTweensOf(overlayEl);
      } catch {
        // ignore
      }

      return new Promise((resolve) => {
        if (overlayEl) {
          gsap.to(overlayEl, { opacity: 0.18, duration: 0.16, ease: 'power2.out' });
        }
        if (!canvasEl) {
          resolve();
          return;
        }
        gsap.to(canvasEl, {
          opacity: 0.12,
          duration: 0.16,
          ease: 'power2.out',
          onComplete: resolve,
        });
      });
    };

    const fadeIn = () => {
      if (overlayEl) {
        gsap.to(overlayEl, { opacity: 0, duration: 0.22, ease: 'power2.out' });
      }
      if (canvasEl) {
        gsap.to(canvasEl, { opacity: 1, duration: 0.22, ease: 'power2.out' });
      }
    };

    const applyCampusConfig = () => {
      try {
        map.setConfigProperty?.('basemap', 'lightPreset', 'day');
      } catch {
        // ignore
      }
      try {
        map.setConfigProperty?.('basemap', 'show3dObjects', true);
      } catch {
        // ignore
      }
    };

    const onStyleLoad = () => {
      if (styleTransitionIdRef.current !== transitionId) return;

      if (wantMode === 'campus') applyCampusConfig();

      try {
        map.resize?.();
      } catch {
        // ignore
      }

      const cam = latestCameraRef.current;
      if (cam) flyTo(cam);

      fadeIn();
      setInteractive(true);
      styleTransitionIdRef.current = 0;
    };

    setInteractive(false);

    fadeOut()
      .then(() => {
        if (styleTransitionIdRef.current !== transitionId) return;
        try {
          map.once('style.load', onStyleLoad);
          map.setStyle(nextStyle);
        } catch {
          // ignore
          setInteractive(true);
          fadeIn();
        }
      })
      .catch(() => {
        setInteractive(true);
        fadeIn();
      });

    return () => {
      if (styleTransitionIdRef.current === transitionId) styleTransitionIdRef.current = 0;
      try {
        map.off?.('style.load', onStyleLoad);
      } catch {
        // ignore
      }
    };
  }, [campusId, mapRef, flyTo]);

  // Robots: show all global robots on the map whenever any location is selected.
  // The location/campus filter drives the map viewport (flyTo); the global
  // robots list (from AppProvider) drives which markers are visible, so that
  // robots commissioned with a custom location still appear on the map.
  // taskPathCacheRef holds route paths from `TASK_ASSIGNED` events — persists
  // across page navigation so routes are drawn even if the user wasn't on /map
  // when the event fired.
  //
  // PHASE 15: `TASK_ASSIGNED` (capitals) is the event that means a robot was
  // actually chosen and a route exists. The engine's intake acknowledgement is
  // `task_accepted` and carries a queue position rather than a path, so there is
  // nothing for this cache to hold until a round has decided. The full contract,
  // including which legacy events are retired after the retention window, is in
  // `src/lib/socket.js`.
  const { recenter } = useRobotStream({
    robots: globalRobots,
    taskPathCacheRef,
    countryId,
    stateId,
    cityId,
    locationId: areaId,
    campusId,
    mapRef,
    markersRef,
  });

  const filtersBar = (
    <MapFiltersBar
      countries={countries}
      states={states}
      cities={cities}
      areas={areas}
      campuses={campuses}
      countryId={countryId}
      stateId={stateId}
      cityId={cityId}
      areaId={areaId}
      campusId={campusId}
      setCountryId={setCountryId}
      setStateId={setStateId}
      setCityId={setCityId}
      setAreaId={setAreaId}
      setCampusId={setCampusId}
      loading={loading}
      resetAll={resetAll}
    />
  );

  if (!token) {
    return (
      <div className="w-full h-full relative">
        <div className="absolute inset-0 flex items-center justify-center bg-slate-950 text-slate-200">
          <div className="text-sm font-semibold">Missing `VITE_MAPBOX_TOKEN`</div>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full h-full relative">
      {/* overlay used by GSAP pulse */}
      <div ref={overlayRef} className="map-overlay absolute inset-0 pointer-events-none opacity-0 bg-black/10" />

      <div ref={canvasRef} className="absolute inset-0">
        <div ref={mapContainerRef} className="w-full h-full" />
      </div>

      {focusTarget && (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => recenter?.()}
          className="absolute bottom-6 right-4 z-10 shadow-lg"
          title="Recenter on active robots and routes"
        >
          Recenter
        </Button>
      )}

      {filtersHost ? createPortal(filtersBar, filtersHost) : <div className="map-filters-overlay">{filtersBar}</div>}
    </div>
  );
}

export default function MapControl({ filtersHost }) {
  return (
    <MapProvider>
      <MapControlInner filtersHost={filtersHost} />
    </MapProvider>
  );
}
