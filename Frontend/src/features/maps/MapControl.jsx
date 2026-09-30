import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';

import { MAP_STYLE } from '@/config/mapConfig.js';
import { Button } from '@/components/ui/button.jsx';

import { MapProvider } from './mapControl/MapProvider.jsx';
import { useMapContext } from './mapControl/mapContext.js';
import { useMapController } from './mapControl/hooks/useMapController.js';
import { useLocationFilters } from './mapControl/hooks/useLocationFilters.js';
import { useRobotStream } from './mapControl/hooks/useRobotStream.js';
import { useEnvironmentLayer } from './environment/useEnvironmentLayer.js';
import {
  CAMERA_PRESETS,
  MAX_PITCH,
  TRACKING_MIN_ZOOM,
  cameraPresetFor,
  flightDurationForZoomDelta,
  isTightTrackingLevel,
} from './environment/environmentConfig.js';
import { ROBOT_REPRESENTATION } from './operational/robotVisual.js';
import { useAppState } from '@/context/appContext.js';

// ── The new layers this milestone adds ───────────────────────────────────────
import { useMapTheme } from './theme/useMapTheme.js';
import {
  resolveCampusDefinition,
  campusRegistryEntry,
  EMPTY_CAMPUS_DEFINITION,
} from './campus/campusRegistry.js';
import { useCampusLayer } from './campus/useCampusLayer.js';
import {
  buildCampusFeatureIndex,
  buildCampusRegistryIndex,
  buildRobotIndex,
  SEARCH_RESULT_TYPE,
} from './campus/campusSearch.js';
import { labelAnchorFor } from './campus/campusLayers.js';
import { operatingCampusBounds } from './campus/operatingCampusView.js';
import { nearestNamedFeature } from './campus/semantics/campusOperational.js';
import { CAMPUS_CAMERA_MODE, campusCameraFor, createCameraSequencer } from './camera/cameraModes.js';

import { MapFiltersBar } from './mapControl/ui/MapFiltersBar.jsx';
import { SelectedRobotPanel } from './mapControl/ui/SelectedRobotPanel.jsx';
import { MapUnavailableFallback } from './mapControl/ui/MapUnavailableFallback.jsx';
import { MapLegend } from './mapControl/ui/MapLegend.jsx';
import { MapThemeControl } from './mapControl/ui/MapThemeControl.jsx';
import { MapGrade } from './mapControl/ui/MapGrade.jsx';
import { CampusSearch } from './mapControl/ui/CampusSearch.jsx';
import { CampusFeatureCard } from './mapControl/ui/CampusFeatureCard.jsx';
import { CampusDataNotice } from './mapControl/ui/CampusDataNotice.jsx';
import { RouteIssuesNotice } from './mapControl/ui/RouteIssuesNotice.jsx';
import './mapControl/ui/campusUi.css';

// WORLD VIEW (strict)
const WORLD_CENTER = [20, 0];

// Module-level (not component state) so it survives MapControl unmounting —
// navigating to another route tears down the whole Mapbox instance (see the
// map-init effect below), so anything that needs to outlive that has to live
// outside the component tree. Holds wherever the user last left the camera,
// and whether the map has ever been opened before in this browser session —
// used to skip the "earth → area" flyTo intro on every return visit and
// just restore the exact last view instantly instead.
let persistedMapCamera = null; // { lon, lat, zoom, pitch, bearing }
let mapHasBeenOpenedBefore = false;

function hasCenter(loc) {
  return typeof loc?.lat === 'number' && typeof loc?.lon === 'number';
}

function MapControlInner({ filtersHost }) {
  const {
    mapContainerRef,
    mapRef,
    markersRef,
    selectedRobotId,
    followSelected,
    selectRobot,
    setSelectedRobotId,
    setHoveredRobotId,
    setFollowSelected,
    clearSelection,
  } = useMapContext();
  const { robots: globalRobots, taskPathCacheRef } = useAppState();

  const overlayRef = useRef(null);
  const canvasRef = useRef(null);
  const latestCameraRef = useRef(null);

  // Non-null when the 3D map could not be stood up. Drives the fallback view.
  const [mapFailure, setMapFailure] = useState(null);

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

    let map;
    try {
      map = new mapboxgl.Map({
        container: mapContainerRef.current,
        style: MAP_STYLE,
        center: startCam ? [startCam.lon, startCam.lat] : WORLD_CENTER,
        zoom: startCam ? startCam.zoom : CAMERA_PRESETS.WORLD.zoom,
        pitch: startCam ? startCam.pitch : CAMERA_PRESETS.WORLD.pitch,
        bearing: startCam ? startCam.bearing : CAMERA_PRESETS.WORLD.bearing,
        // The environment is 3D now: the camera may tilt and rotate. It is
        // capped below vertical because at grazing angles the horizon
        // dominates the viewport and the operational overlay — which is the
        // point of the screen — is squeezed into a strip.
        maxPitch: MAX_PITCH,
        antialias: true,
        attributionControl: false,
      });
    } catch (err) {
      // No WebGL, no GPU, blocked context. Robots must still be visible (§23),
      // so the failure has to reach React state to swap in the fallback view.
      // This effect's whole job is standing up an external system; a
      // constructor that throws is that system reporting, not a cascading
      // render — and it happens at most once per mount.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMapFailure(err?.message || 'WebGL is unavailable in this browser.');
      return;
    }

    mapHasBeenOpenedBefore = true;

    // Orbit / pan / zoom / tilt all belong to the map's own control surface.
    // `visualizePitch` gives the compass a tilt readout, and a click on it
    // resets bearing and pitch — that is the camera "reset" affordance.
    map.addControl(new mapboxgl.NavigationControl({ showCompass: true, visualizePitch: true }), 'top-left');
    // Vendor attribution is a licence condition of the basemap data, and this
    // map now leans on that data explicitly as city context (§6). Compact so
    // it does not compete with the operational overlay.
    map.addControl(new mapboxgl.AttributionControl({ compact: true }), 'bottom-right');

    mapRef.current = map;

    // A lost GPU context after a successful init is the other half of §23.
    const onContextLost = () => setMapFailure('The graphics context was lost. Reload to restore the 3D map.');
    let canvasEl = null;
    try {
      canvasEl = map.getCanvas();
      canvasEl?.addEventListener('webglcontextlost', onContextLost);
    } catch {
      // ignore
    }

    // Clicking empty map space clears the robot selection. Marker handlers call
    // stopPropagation, so this only fires for genuinely empty space. The campus
    // layer's own click handler runs alongside and owns feature selection.
    const onMapClick = () => setSelectedRobotId(null);
    map.on('click', onMapClick);

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

    const markers = markersRef.current;

    return () => {
      window.removeEventListener('resize', onResize);
      resizeObserver?.disconnect();
      try {
        canvasEl?.removeEventListener('webglcontextlost', onContextLost);
      } catch {
        // ignore
      }
      try {
        map.off('moveend', onMoveEnd);
        map.off('click', onMapClick);
      } catch {
        // ignore
      }

      // Robot visuals are owned by their renderer, which disposes them on its
      // own unmount (see useRobotStream). Clearing the store here just drops
      // this map instance's references to them.
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
  }, [token, mapContainerRef, mapRef, markersRef, setSelectedRobotId]);

  const { isMapLoaded, flyTo } = useMapController(mapRef, { overlayRef, canvasRef });

  // ── ENVIRONMENT LAYER ──────────────────────────────────────────────────────
  // Terrain, 3D buildings, sky and lighting. Installed once per style load and
  // deliberately independent of robots, telemetry and selection — a robot
  // moving cannot re-run this (§21).
  const { environmentReady, terrainActive, buildings3dActive, isStandardStyle } = useEnvironmentLayer(mapRef, {
    isMapLoaded,
  });

  // ── THEME LAYER ────────────────────────────────────────────────────────────
  // Day / Evening / Night, interpolated in place. Never calls `setStyle`, so a
  // theme change cannot reset robots, routes, selection, camera or terrain.
  const { themeId, setThemeId, theme, themeRef, subscribeToTheme, isTransitioning } = useMapTheme(mapRef, {
    isMapLoaded,
    isStandardStyle,
  });

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

  // ── CAMPUS LAYER ───────────────────────────────────────────────────────────
  //
  // The definition is derived from the Campus record the filter bar already
  // loaded, merged with whatever geometry the registry holds for that campus
  // code. For RNSIT that is an OpenStreetMap extract, classified by
  // `campus/osm/osmCampusImport.js` — real geometry, explicitly NOT_VERIFIED.
  // Nothing is invented to fill what OSM does not map; the notice component
  // states the provenance and the remaining gaps on the map instead.
  const campusDefinition = useMemo(
    () => (selectedCampus ? resolveCampusDefinition(selectedCampus) : EMPTY_CAMPUS_DEFINITION),
    [selectedCampus]
  );

  const campusActive = Boolean(selectedCampus);

  // The second data source, summarised for the on-map notice. Derived, not
  // fetched — the registry already reconciled the two datasets at import time.
  const supplementalSummary = useMemo(() => {
    const s = campusDefinition.supplemental;
    if (!s) return null;
    const count = (verdict) => (s.containment || []).filter((c) => c.containment === verdict).length;
    return {
      importedFeatureCount: s.importedFeatureCount,
      possibleDuplicates: s.possibleDuplicates,
      outsideCount: count('OUTSIDE'),
      uncertainCount: count('UNCERTAIN'),
    };
  }, [campusDefinition]);

  const [selectedFeature, setSelectedFeature] = useState(null);
  const [cameraMode, setCameraMode] = useState(CAMPUS_CAMERA_MODE.OVERVIEW);
  /** What the route validator has to say about the routes on screen (§3D). */
  const [routeFindings, setRouteFindings] = useState(null);

  // ── Operations mode (§3H) ──────────────────────────────────────────────────
  //
  // A single number, not a branch. Operations is a way of LOOKING at the campus,
  // so it belongs in the same place every other viewing decision lives — a value
  // fed to `campusStyleForTheme`, interpolated in place like a theme. Follow
  // mode is a framing of Operations, not a third appearance, so it carries the
  // same emphasis rather than a look of its own.
  const operationsEmphasis =
    campusActive && (cameraMode === CAMPUS_CAMERA_MODE.OPERATIONS || cameraMode === CAMPUS_CAMERA_MODE.FOLLOW) ? 1 : 0;

  const { campusFeatureCount, vendorClipActive } = useCampusLayer(mapRef, {
    isMapLoaded,
    environmentReady,
    definition: campusDefinition,
    active: campusActive,
    subscribeToTheme,
    selectedFeatureId: selectedFeature && !selectedFeature.isVendor ? selectedFeature.id : null,
    onSelectFeature: setSelectedFeature,
    operationsEmphasis,
  });

  // ── Campus context labels ──────────────────────────────────────────────────
  //
  // Point-of-interest labels used to be switched ON at campus focus, because
  // they were the ONLY source of "which building is this" — the repository held
  // no campus building names at all.
  //
  // It holds them now. So for a campus with its own geometry they are switched
  // back OFF: the campus layer draws the same names from the same underlying
  // OSM data, in our label hierarchy, collision-managed and zoom-banded, and
  // leaving the vendor's copy on would print several of them twice (§13). A
  // campus WITHOUT geometry keeps the old behaviour, because for it the vendor
  // labels are still the only identification available (§33).
  const campusHasGeometry = campusDefinition.hasCampusGeometry;
  useEffect(() => {
    const map = mapRef?.current;
    if (!map || !isMapLoaded || !environmentReady) return;
    try {
      map.setConfigProperty?.('basemap', 'showPointOfInterestLabels', campusActive && !campusHasGeometry);
    } catch {
      // A style without this knob keeps whatever it had.
    }
  }, [mapRef, isMapLoaded, environmentReady, campusActive, campusHasGeometry]);

  // ── Two-stage focus camera ─────────────────────────────────────────────────
  //
  // Stage 1 travels FLAT to the target. Stage 2 tilts once it has arrived.
  //
  // This is not a flourish — it is the fix for a real failure. A single pitched
  // flyTo across ~15 zoom levels (world → campus) with terrain enabled resolves
  // ground elevation continuously along a long arc, and reliably ended with the
  // camera pointing at atmosphere: a uniform sky-coloured viewport, no tiles and
  // no robots, until some later camera command (the Recenter button) recomputed
  // it. Travelling flat removes the elevation/pitch interaction from the long
  // move entirely, and the short tilt afterwards happens over a stationary
  // point where it cannot go wrong. It also looks better — a descent, then a
  // reveal.
  //
  // Convergence (§51) is the sequencer's job: every command takes a token, and
  // a deferred stage may only act while its token is still the newest issued.
  // Switching India → Karnataka → Bengaluru → RNSIT in under a second leaves
  // exactly one live flight, aimed at RNSIT.
  const sequencerRef = useRef(null);
  if (sequencerRef.current === null) sequencerRef.current = createCameraSequencer();

  const focusCamera = useCallback(
    (cam, targetPitch) => {
      const map = mapRef?.current;
      if (!map) return;

      const token = sequencerRef.current.begin();

      let fromZoom = cam.zoom;
      try {
        fromZoom = map.getZoom();
      } catch {
        // ignore
      }

      flyTo({ ...cam, pitch: 0, duration: flightDurationForZoomDelta(cam.zoom - fromZoom) });

      if (!targetPitch) return;

      const onArrive = () => {
        if (!sequencerRef.current.isCurrent(token)) return;
        try {
          map.easeTo({ pitch: targetPitch, bearing: cam.bearing ?? 0, duration: 900, essential: true });
        } catch {
          // ignore
        }
      };
      try {
        map.once('moveend', onArrive);
      } catch {
        // ignore
      }
    },
    [flyTo, mapRef]
  );

  // Focus rules — camera framing per hierarchy level, from environmentConfig.
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
      return { type: 'CAMPUS', loc: { lat: selectedCampus.centerLat, lon: selectedCampus.centerLon } };
    }
    if (selectedArea) return { type: 'AREA', loc: selectedArea };
    if (selectedCity) return { type: 'CITY', loc: selectedCity };
    if (selectedState) return { type: 'STATE', loc: selectedState };
    if (selectedCountry) return { type: 'COUNTRY', loc: selectedCountry };
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

  // Leaving a campus must not leave a campus building selected behind it (§40,
  // §53). The campus layer's reveal ramp handles the geometry and the labels;
  // this handles the selection state that outlives them.
  //
  // Adjusted during render rather than in an effect: React's documented pattern
  // for "reset state when a prop changes". Doing it in an effect would render
  // one frame with the previous campus's building still selected, and that
  // frame is exactly the stale highlight §53 says must never be visible.
  const [campusIdAtSelection, setCampusIdAtSelection] = useState(campusId);
  if (campusIdAtSelection !== campusId) {
    setCampusIdAtSelection(campusId);
    setSelectedFeature(null);
    setCameraMode(CAMPUS_CAMERA_MODE.OVERVIEW);
  }

  useEffect(() => {
    if (!isMapLoaded) return;
    // Terrain has to be installed BEFORE the first flight, not during it: a
    // camera animation started while `setTerrain` is still pending computes its
    // path against a flat world and then has the ground moved underneath it.
    if (!environmentReady) return;
    // Still waiting on a deeper hierarchy level's list to load (see the
    // focusTarget comment above) — don't touch the camera yet.
    if (focusTarget === undefined) return;

    // Returning visit: this first run just means "the map finished loading
    // again" — it's already sitting at the restored camera (see the
    // map-init effect), so don't replay the earth→area flyTo on top of it.
    // Filter changes made *after* this point (user picks a new area while
    // already on the page) still animate normally.
    const skipAnimation = skipNextFlyToRef.current;
    skipNextFlyToRef.current = false;

    // No filters selected: world view — lift the zoom clamp so the
    // programmatic flyTo below isn't fighting its own limit.
    if (!focusTarget) {
      try {
        mapRef.current?.setMinZoom(0);
      } catch {
        // ignore
      }
      // No filter: open on the campuses RobotX operates on (the registry's operating
      // campuses, framed from their boundaries by Mapbox itself), not the whole globe.
      // World view remains the fallback when no campus has an operating region.
      let cam = null;
      const bounds = operatingCampusBounds();
      if (bounds) {
        try {
          const fitted = mapRef.current?.cameraForBounds(bounds, { padding: 48 });
          if (fitted?.center && Number.isFinite(fitted.zoom)) {
            const center = mapboxgl.LngLat.convert(fitted.center);
            cam = { lon: center.lng, lat: center.lat, zoom: fitted.zoom, pitch: 0, bearing: 0 };
          }
        } catch {
          // fall back to world view below
        }
      }
      if (!cam) {
        const preset = CAMERA_PRESETS.WORLD;
        cam = { lon: WORLD_CENTER[0], lat: WORLD_CENTER[1], ...preset };
      }
      latestCameraRef.current = cam;
      if (!skipAnimation) focusCamera(cam, 0);
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
    try {
      mapRef.current?.setMinZoom(isTightTrackingLevel(type) ? TRACKING_MIN_ZOOM : 0);
    } catch {
      // ignore
    }

    // At CAMPUS the framing comes from the campus camera modes, which are
    // tuned for reading an operational site rather than for covering a
    // geographic extent (§27).
    const preset = type === 'CAMPUS' ? campusCameraFor(CAMPUS_CAMERA_MODE.OVERVIEW) : cameraPresetFor(type);
    const cam = { lon: loc.lon, lat: loc.lat, zoom: preset.zoom, pitch: preset.pitch, bearing: preset.bearing };

    latestCameraRef.current = cam;
    // Flat there, then tilt — see focusCamera.
    if (!skipAnimation) focusCamera(cam, preset.pitch);
  }, [isMapLoaded, environmentReady, focusTarget, focusCamera, mapRef]);

  // ── Camera modes (§28) ─────────────────────────────────────────────────────
  //
  // A mode change while already at the campus is a short ease, not a flight —
  // the camera is already there, only the framing changes. It goes through the
  // same sequencer, so a mode change mid-arrival cannot fight the arrival.
  const applyCameraMode = useCallback(
    (mode) => {
      const map = mapRef?.current;
      setCameraMode(mode);
      if (!map || !campusActive) return;
      if (mode === CAMPUS_CAMERA_MODE.FOLLOW) return; // the follow camera owns the centre

      const preset = campusCameraFor(mode);
      const center = campusDefinition.center;
      sequencerRef.current.begin();
      try {
        map.easeTo({
          ...(center ? { center: [center.lon, center.lat] } : {}),
          zoom: preset.zoom,
          pitch: preset.pitch,
          bearing: preset.bearing,
          duration: 900,
          essential: true,
        });
      } catch {
        // ignore
      }
    },
    [mapRef, campusActive, campusDefinition]
  );

  // "Follow" is a camera mode and `followSelected` is the operational-layer
  // flag that implements it. One direction only, so they cannot oscillate.
  useEffect(() => {
    setFollowSelected(cameraMode === CAMPUS_CAMERA_MODE.FOLLOW && Boolean(selectedRobotId));
  }, [cameraMode, selectedRobotId, setFollowSelected]);

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
  //
  // `representation` is what a future 3D robot milestone flips. Everything else
  // passed here — state, selection, camera-follow, theme — is
  // representation-agnostic.
  const { robots, robotCount, recenter, selectedRouteProgress } = useRobotStream({
    robots: globalRobots,
    taskPathCacheRef,
    countryId,
    stateId,
    cityId,
    locationId: areaId,
    campusId,
    mapRef,
    markersRef,
    representation: ROBOT_REPRESENTATION.TWO_D,
    selectedRobotId,
    followSelected,
    onSelectRobot: selectRobot,
    onHoverRobot: setHoveredRobotId,
    themeRef,
    subscribeToTheme,
    // Read-only, for route VALIDATION (§3D). The operational layer checks the
    // routes it is drawing against the campus geometry and reports what it
    // finds; it never moves, snaps or hides a route to make one agree.
    campusFeatures: campusDefinition.features,
    onRouteFindings: setRouteFindings,
  });

  const selectedRobot = useMemo(
    () => (selectedRobotId ? robots.find((r) => String(r?.robotId) === selectedRobotId) || null : null),
    [robots, selectedRobotId]
  );

  const toggleFollow = useCallback(() => {
    setCameraMode((prev) =>
      prev === CAMPUS_CAMERA_MODE.FOLLOW ? CAMPUS_CAMERA_MODE.OVERVIEW : CAMPUS_CAMERA_MODE.FOLLOW
    );
  }, []);

  // A robot that leaves the visible set must not leave a stale selection behind.
  useEffect(() => {
    if (!selectedRobotId) return;
    if (robots.some((r) => String(r?.robotId) === selectedRobotId)) return;
    clearSelection();
  }, [robots, selectedRobotId, clearSelection]);

  // ── Search (§34, §3I) ──────────────────────────────────────────────────────
  //
  // ONE search system, as §3I requires — campus places and units in the same
  // index, ranked by the same function. What changed is that its two halves are
  // memoised separately (§3T): the campus half depends on the campus and the
  // fleet half on the fleet, so a telemetry tick no longer re-derives 65 label
  // anchors and 65 lowercased haystacks to update one robot's status string.
  //
  // The index gained a third half when the map gained a second campus: the
  // CAMPUSES themselves, so "JSSATE" is something an operator can type from
  // anywhere rather than a dropdown entry they have to already know to look
  // for. It is metadata only — a name, its aliases, the DB centre — and it is
  // memoised against the campus LIST, so it is built once per session and costs
  // the same at a hundred campuses as at two (§30).
  const registryIndex = useMemo(
    () => buildCampusRegistryIndex(campuses, campusRegistryEntry),
    [campuses]
  );
  const campusIndex = useMemo(() => buildCampusFeatureIndex(campusDefinition), [campusDefinition]);
  const robotIndex = useMemo(() => buildRobotIndex(robots), [robots]);
  const searchIndex = useMemo(
    () => [...registryIndex, ...campusIndex, ...robotIndex],
    [registryIndex, campusIndex, robotIndex]
  );

  // ── "Where is this unit?", in campus terms (§3N) ───────────────────────────
  // Derived only for the SELECTED robot — one distance calculation over the
  // campus features, not one per unit per tick.
  const nearestFeature = useMemo(() => {
    if (!selectedRobot || typeof selectedRobot.lat !== 'number' || typeof selectedRobot.lon !== 'number') return null;
    return nearestNamedFeature(campusDefinition.features, [selectedRobot.lon, selectedRobot.lat], labelAnchorFor);
  }, [selectedRobot, campusDefinition]);

  const focusLngLat = useCallback(
    (lon, lat, zoom) => {
      const map = mapRef?.current;
      if (!map) return;
      sequencerRef.current.begin();
      try {
        map.easeTo({ center: [lon, lat], zoom: zoom ?? Math.max(map.getZoom(), 17.6), duration: 1000, essential: true });
      } catch {
        // ignore
      }
    },
    [mapRef]
  );

  /**
   * A search result becomes a selection and a camera move (§3I).
   *
   * The branches deliberately do the same three things in the same order —
   * clear the other kinds of selection, make this one, let the camera follow —
   * so a search for "R01" and a search for "Main Gate" behave identically apart
   * from what ends up selected. A robot additionally switches the camera into
   * Operations, because "find this unit" is an operational question and the
   * answer is easier to read against the operational framing; Follow is then one
   * click away in the panel that has just appeared, rather than being forced on
   * the operator by a search.
   *
   * A CAMPUS result sets `campusId` and stops. It does not fly the camera
   * itself, does not load geometry itself and does not touch a layer: setting
   * the filter is exactly what the campus dropdown does, and everything after
   * that — resolving the definition, pushing it into the already-installed
   * sources, the two-stage focus flight, clearing the previous campus's
   * selection — is the generic machinery that already existed, reached the same
   * way from both controls. That is why picking a campus here cannot drift from
   * picking one there.
   */
  const onSearchPick = useCallback(
    (entry) => {
      if (!entry) return;
      if (entry.type === SEARCH_RESULT_TYPE.CAMPUS) {
        setCampusId(entry.campusId);
        return;
      }
      if (entry.type === SEARCH_RESULT_TYPE.ROBOT) {
        setSelectedFeature(null);
        // `selectRobot` toggles, so a second search for the same unit would
        // otherwise deselect the thing the operator just asked to see.
        setSelectedRobotId(entry.robotId);
        if (campusActive && cameraMode === CAMPUS_CAMERA_MODE.OVERVIEW) {
          setCameraMode(CAMPUS_CAMERA_MODE.OPERATIONS);
        }
      } else {
        setSelectedRobotId(null);
        setSelectedFeature(entry.feature);
      }
      focusLngLat(entry.lon, entry.lat);
    },
    [focusLngLat, setSelectedRobotId, setCampusId, campusActive, cameraMode]
  );

  const focusSelectedFeature = useCallback(() => {
    const anchor = labelAnchorFor(selectedFeature?.geometry);
    if (anchor) focusLngLat(anchor[0], anchor[1]);
  }, [selectedFeature, focusLngLat]);

  // ── Reset (§40) ────────────────────────────────────────────────────────────
  // Everything a reset must not leave behind, cleared in one place: filters,
  // building selection, robot selection, camera mode, and any camera command
  // still waiting to fire.
  const resetEverything = useCallback(() => {
    sequencerRef.current.cancel();
    setSelectedFeature(null);
    setCameraMode(CAMPUS_CAMERA_MODE.OVERVIEW);
    clearSelection();
    resetAll();
  }, [clearSelection, resetAll]);

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
      resetAll={resetEverything}
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
    // The theme's background sits behind the tiles, so the gap around a
    // still-loading map matches the world instead of flashing white.
    <div className="w-full h-full relative" style={{ '--map-bg': theme.atmosphere.background }}>
      {/* overlay used by GSAP pulse */}
      <div ref={overlayRef} className="map-overlay absolute inset-0 pointer-events-none opacity-0 bg-black/10" />

      <div ref={canvasRef} className="absolute inset-0 map-canvas-host">
        <div ref={mapContainerRef} className="w-full h-full" />
      </div>

      {/* Over the canvas, under every panel. Inert — see MapGrade. */}
      {!mapFailure && <MapGrade themeId={themeId} />}

      {mapFailure && <MapUnavailableFallback reason={mapFailure} robots={globalRobots} />}

      {/* ── The right-hand rail ────────────────────────────────────────────
          The view controls and the selected-robot panel share this corner, so
          they share one flow. Positioning them independently meant each had to
          guess the other's height, and at campus focus the camera-mode row was
          taller than the panel's guess — which is how the panel's header ended
          up rendered underneath it. */}
      {!mapFailure && (
        <div className="map-right-rail">
          <MapThemeControl
            themeId={themeId}
            onThemeChange={setThemeId}
            isTransitioning={isTransitioning}
            cameraMode={cameraMode}
            onCameraModeChange={applyCameraMode}
            showCameraModes={campusActive}
            followDisabled={!selectedRobotId}
            onResetCamera={() => {
              setSelectedFeature(null);
              applyCameraMode(CAMPUS_CAMERA_MODE.OVERVIEW);
            }}
          />

          <SelectedRobotPanel
            robot={selectedRobot}
            followSelected={followSelected}
            onToggleFollow={toggleFollow}
            onClear={clearSelection}
            routeProgress={selectedRouteProgress}
            nearestFeature={nearestFeature}
          />
        </div>
      )}

      {/* Mounted whether or not a campus is focused. It used to appear only at
          campus focus, because until there was a second campus the only things
          it could find were inside the campus already on screen. Now the index
          also holds the campuses themselves, so hiding it until one is selected
          would hide the one control that can select one. */}
      {!mapFailure && (
        <CampusSearch
          index={searchIndex}
          onPick={onSearchPick}
          hasCampusPlaces={campusHasGeometry}
          campusActive={campusActive}
        />
      )}

      {!mapFailure && campusActive && (
        <CampusDataNotice
          campusName={campusDefinition.name}
          geometrySource={campusDefinition.geometrySource}
          hasCampusGeometry={campusHasGeometry}
          featureCount={campusFeatureCount}
          missing={campusDefinition.missingGeometry}
          notes={campusDefinition.notes}
          rejectedCount={campusDefinition.rejected.length}
          excludedCount={campusDefinition.dataset?.excluded?.length || 0}
          vendorClipActive={vendorClipActive}
          centreWithinBoundary={campusDefinition.centreWithinBoundary}
          supplemental={supplementalSummary}
          outsideBoundaryCount={campusDefinition.dataset?.outsideBoundary?.length || 0}
          verificationRecord={campusDefinition.verificationRecord}
        />
      )}

      {/* Sits beside the coverage notice, and only when the validator has
          something to say. §3D: a route that contradicts the campus geometry is
          reported, never rendered away. */}
      {!mapFailure && <RouteIssuesNotice summary={routeFindings} />}

      {!mapFailure && selectedFeature && (
        <CampusFeatureCard
          feature={selectedFeature}
          onClose={() => setSelectedFeature(null)}
          onFocus={focusSelectedFeature}
        />
      )}

      {!mapFailure && focusTarget && (
        <MapLegend
          theme={theme}
          terrainActive={terrainActive}
          buildings3dActive={buildings3dActive}
          robotCount={robotCount}
          campusFeatureCount={campusFeatureCount}
          campusName={campusDefinition.name}
          geometrySource={campusDefinition.geometrySource}
          verificationLabel={campusDefinition.verificationRecord ? 'verified by owner' : 'unverified'}
        />
      )}

      {/* Sits between Mapbox's attribution (which its own stylesheet pins at
          10px from each edge) and the feature card above it — see the stack
          documented on `.map-feature-card`. */}
      {!mapFailure && focusTarget && (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => recenter?.()}
          className="absolute bottom-11 right-3 z-10 shadow-lg"
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
