import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
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
import { acquireMap, releaseMap } from './mapControl/mapInstanceCache.js';
import { initialBasemapConfig, setBasemapConfig } from './environment/basemapConfig.js';
import { resolveMapTheme } from './theme/mapThemes.js';

// ── The new layers this milestone adds ───────────────────────────────────────
import { readStoredTheme, useMapTheme } from './theme/useMapTheme.js';
import {
  resolveCampusDefinition,
  campusRegistryEntry,
  EMPTY_CAMPUS_DEFINITION,
} from './campus/campusRegistry.js';
import { useCampusLayer } from './campus/useCampusLayer.js';
import { useChargingLayer } from './charging/useChargingLayer.js';
import { createStationClickArbiter } from './mapControl/stationClickArbiter.js';
import {
  buildCampusFeatureIndex,
  buildCampusRegistryIndex,
  buildRobotIndex,
  SEARCH_RESULT_TYPE,
} from './campus/campusSearch.js';
import { labelAnchorFor } from './campus/campusLayers.js';
import { campusBounds, operatingCampusBounds, operatingCampusCode } from './campus/operatingCampusView.js';
import { campusOf, isSuperAdmin, mayReadSimulator } from '@/lib/access.js';
import { nearestNamedFeature } from './campus/semantics/campusOperational.js';
import {
  CAMPUS_CAMERA_MODE,
  campusCameraFor,
  campusStartCamera,
  createCameraSequencer,
  isCameraNear,
  topDownCameraForBounds,
} from './camera/cameraModes.js';

import { MapFiltersBar } from './mapControl/ui/MapFiltersBar.jsx';
import { SelectedRobotPanel } from './mapControl/ui/SelectedRobotPanel.jsx';
import { MapUnavailableFallback } from './mapControl/ui/MapUnavailableFallback.jsx';
import { MapLegend } from './mapControl/ui/MapLegend.jsx';
import { MapThemeControl } from './mapControl/ui/MapThemeControl.jsx';
import { MapGrade } from './mapControl/ui/MapGrade.jsx';
import { CampusSearch } from './mapControl/ui/CampusSearch.jsx';
import { CampusFeatureCard } from './mapControl/ui/CampusFeatureCard.jsx';
import { ChargingStationCard } from './mapControl/ui/ChargingStationCard.jsx';
import { CampusDataNotice } from './mapControl/ui/CampusDataNotice.jsx';
import { RouteIssuesNotice } from './mapControl/ui/RouteIssuesNotice.jsx';
import { ObstacleActivityPanel } from './mapControl/ui/ObstacleActivityPanel.jsx';
import { ZoneLegendSection } from './mapControl/ui/ZoneLegendSection.jsx';
import './mapControl/ui/campusUi.css';

// ── DTARO: published zones and obstacle awareness ────────────────────────────
import { getDtaroZones } from '@/lib/api/dtaro.js';
import { ACTIVITY_FILTER, activityEntries, obstacleActivityStore } from '@/lib/obstacleActivity.js';
import { CONNECTION } from '@/lib/connectionState.js';
import { operatingRegionFor } from './campus/campusRegistry.js';
import {
  ZONE_STATUS,
  ZONE_VIEW,
  liveZonesForCampus,
  previewCellCollection,
  previewIsPublished,
  previewLabelsClearOf,
  previewZonesForCampus,
  zonesForView,
} from './dtaro/zoneModel.js';
import { areaLegendRows, campusAreasFor, missingAreaNotes } from './dtaro/campusAreas.js';
import { RNSIT_ZONE_PROPOSAL_PREVIEW } from './dtaro/rnsitZoneProposalPreview.js';
import { useDtaroLayer, useZoneAtCentre } from './dtaro/useDtaroLayer.js';

/** How often expiry labels are re-read while the obstacle panel is mounted. */
const DTARO_CLOCK_MS = 15_000;
const NO_HIDDEN_ZONES = new Set();
const NO_ROBOT_SAMPLE = [];
const NO_ZONES = Object.freeze([]);
const NO_AREAS = Object.freeze([]);

// WORLD VIEW (strict)
const WORLD_CENTER = [20, 0];

// Module-level (not component state) so it survives MapControl unmounting.
// Navigating away parks the Mapbox instance (mapControl/mapInstanceCache.js), and
// a parked map keeps its camera — but one that was discarded (session end, lost
// GPU context, parked too long) is rebuilt, and that rebuild must not replay the
// intro either. Holds wherever the user last left the camera, and whether the map
// has ever been opened before in this browser session — used to skip the
// "earth → area" flyTo intro on every return visit and just restore the exact
// last view instantly instead.
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
  const { robots: globalRobots, taskPathCacheRef, simulatorStatus, session, connection } = useAppState();
  // RBAC — a campus administrator's map is its campus: no location hierarchy (a SUPER_ADMIN-only
  // read), the campus selection pinned to its own, and the opening view framed on it.
  const superAdmin = isSuperAdmin(session);
  const pinnedCampus = superAdmin ? null : campusOf(session);
  const pinnedCampusId = pinnedCampus?.id || null;
  const pinnedCampusCode = pinnedCampus?.code || null;
  // The operational map: no World / country / state / city / area hierarchy (RNSIT is the one
  // campus RobotX operates; the hierarchy only ever led to a globe view), and with nothing valid
  // selected it opens on the operating campus. Other campuses stay selectable from the campus
  // selector and the search; their data is untouched.
  const locationFilterOptions = useMemo(
    () => ({ hierarchy: false, pinnedCampusId, defaultCampusCode: pinnedCampusId ? null : operatingCampusCode() }),
    [pinnedCampusId]
  );

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
  // The focus target the camera was last aimed at (see the focus effect).
  const lastFocusKeyRef = useRef(null);

  const token = import.meta.env.VITE_MAPBOX_TOKEN;

  // Take the page's map: the one parked on the last visit, or a new one.
  useEffect(() => {
    if (!token) return;
    const host = mapContainerRef.current;
    if (!host) return;
    if (mapRef.current) return;

    mapboxgl.accessToken = token;

    // Returning visit with no parked map: open exactly where the user left off,
    // instantly — no world-view flash, no replayed flyTo animation. A first visit (and every
    // reload) opens straight on the campus, at its Overview framing — not on the globe with a
    // flight in once the style and terrain have loaded (~10 s, measured 2026-10-23).
    const startCam =
      persistedMapCamera || campusStartCamera(pinnedCampusCode ? campusBounds(pinnedCampusCode) : operatingCampusBounds());

    const createMap = (container) => {
      const created = new mapboxgl.Map({
        container,
        style: MAP_STYLE,
        // The basemap is laid out once, with the values the environment and the
        // theme are about to ask for — not with the style's defaults first.
        config: initialBasemapConfig(resolveMapTheme(readStoredTheme()).basemap),
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
        // Resizing is this page's (below). Mapbox's own observer would see a
        // parked map's detached container as 0×0 and shrink the tile cache to
        // match — discarding the tiles that parking it exists to keep.
        trackResize: false,
      });
      // Orbit / pan / zoom / tilt all belong to the map's own control surface.
      // `visualizePitch` gives the compass a tilt readout, and a click on it
      // resets bearing and pitch — that is the camera "reset" affordance.
      // Added once per map: a reused map still has them.
      created.addControl(new mapboxgl.NavigationControl({ showCompass: true, visualizePitch: true }), 'top-left');
      // Vendor attribution is a licence condition of the basemap data, and this
      // map now leans on that data explicitly as city context (§6). Compact so
      // it does not compete with the operational overlay.
      created.addControl(new mapboxgl.AttributionControl({ compact: true }), 'bottom-right');
      return created;
    };

    let map;
    let reused = false;
    try {
      ({ map, reused } = acquireMap(host, createMap));
    } catch (err) {
      // No WebGL, no GPU, blocked context. Robots must still be visible (§23),
      // so the failure has to reach React state to swap in the fallback view.
      // This effect's whole job is standing up an external system; a
      // constructor that throws is that system reporting, not a cascading
      // render — and it happens at most once per mount.
      setMapFailure(err?.message || 'WebGL is unavailable in this browser.');
      return;
    }

    mapHasBeenOpenedBefore = true;

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
    // page mounts (even on a rebuilt map, when the parked one was discarded) it
    // can reopen there instead of restarting the intro animation.
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
      // A host that has left the document (the page is unmounting) or has no size yet
      // must not shrink the map to 0×0: the tile cache is sized from the viewport.
      if (!host.isConnected || host.clientWidth === 0 || host.clientHeight === 0) return;
      try {
        map.resize();
      } catch {
        // ignore
      }
    };

    // A reused map was parked at whatever size the page last had; this page may
    // be a different size (the window or the sidebar changed in between).
    if (reused) onResize();

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
      resizeObserver.observe(host);
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

      // Parked, not removed: the next visit takes it back with its style, terrain
      // and tiles intact. Each overlay hook removes what it added to it in its own
      // cleanup (they hold the map they installed on, not `mapRef`).
      releaseMap(map);
      mapRef.current = null;
    };
  }, [token, mapContainerRef, mapRef, markersRef, setSelectedRobotId, pinnedCampusCode]);

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
  } = useLocationFilters(locationFilterOptions);

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

  // ── CHARGING LAYER ─────────────────────────────────────────────────────────
  // Charging stations — a miniature 3D installation at campus zoom, a badge below it — with
  // their state (available / in use / queue / inactive / unavailable), and each simulated
  // robot's route to its charger, from the simulator's report. A usable station is drawn at
  // its operational coordinate; a declared-but-unusable one at its declared coordinate as
  // INACTIVE or UNAVAILABLE, never in an operational colour.
  const [selectedStationId, setSelectedStationId] = useState(null);
  // A click that hits a station selects the station and not the building underneath it, in
  // whichever order the two click listeners run (mapControl/stationClickArbiter.js). Created
  // once (lazy state): its two answers are stable callbacks, and both setters are state setters.
  const [clickArbiter] = useState(() =>
    createStationClickArbiter({
      selectStation: setSelectedStationId,
      selectFeature: setSelectedFeature,
    })
  );
  const onSelectStation = clickArbiter.station;
  const onSelectCampusFeature = clickArbiter.feature;
  const { stations: chargingStations } = useChargingLayer(mapRef, {
    isMapLoaded,
    simulatorStatus,
    themeRef,
    subscribeToTheme,
    selectedStationId,
    onSelectStation,
  });
  const selectedStation = useMemo(
    () => (selectedStationId ? chargingStations.find((s) => s.chargerId === selectedStationId) || null : null),
    [chargingStations, selectedStationId]
  );

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
    onSelectFeature: onSelectCampusFeature,
    operationsEmphasis,
  });

  // DTARO view state, declared before their first reader (the campus reset below also clears them).
  // Normal map by default: no zone overlay. See ZONE_VIEW.
  const [zoneView, setZoneViewState] = useState(ZONE_VIEW.NORMAL);
  // The legend starts expanded, except on a phone, where it would cover a third of the map.
  const [legendExpanded, setLegendExpanded] = useState(
    () => typeof window === 'undefined' || !window.matchMedia?.('(max-width: 640px)').matches
  );
  // Robot positions sampled when the preview is switched on: its labels are placed clear of them.
  const [previewRobotSample, setPreviewRobotSample] = useState(NO_ROBOT_SAMPLE);
  const [hiddenZones, setHiddenZones] = useState(NO_HIDDEN_ZONES);
  const [selectedObstacleId, setSelectedObstacleId] = useState(null);
  const [activityFilter, setActivityFilter] = useState(ACTIVITY_FILTER.ALL);
  // Off by default: tinted buildings beside a campus-wide zone read as zone divisions they are not.
  const [areasOn, setAreasOn] = useState(false);

  // ── DTARO LAYER ────────────────────────────────────────────────────────────
  //
  // The published zone map (`GET /api/dtaro/zones`, SUPER_ADMIN only — obstacle data is
  // default-deny for campus administrators) and the obstacle activity the provider collects
  // from the socket. The zone map is drawn for every SUPER_ADMIN session, whatever the alert
  // switch: it is the published map, and gating it on DTARO_ZONE_ALERTS_ENABLED left a server
  // without the switch showing no zone and no reason (seen in the real app, 2026-10-22). The
  // obstacle panel needs alerts on. Fetched at once, and again whenever the live connection
  // comes back, so a server restart with a new pinned map is picked up without a reload.
  const [dtaroFetched, setDtaroFetched] = useState(null);
  const connectionState = connection?.state || CONNECTION.IDLE;
  const dtaroLive = connectionState === CONNECTION.CONNECTED;
  useEffect(() => {
    if (!superAdmin) return undefined;
    let cancelled = false;
    getDtaroZones().then((view) => {
      if (cancelled) return;
      // A refetch that fails because the network is down (it runs when the connection drops,
      // too) keeps the last map: otherwise the zones and the obstacle panel vanished exactly
      // while the panel should be saying "reconnecting". Any answer from the server replaces it.
      setDtaroFetched((previous) => (view?.error === 'NETWORK' && previous && previous.available !== false ? previous : view));
    });
    return () => {
      cancelled = true;
    };
  }, [superAdmin, dtaroLive]);
  const dtaroView = superAdmin ? dtaroFetched : null;
  const zoneMapEnabled = superAdmin;
  const alertsEnabled = dtaroView?.alertsEnabled === true;

  // A campus shows its own region's zones only: the region the campus record names, else the
  // registry's operating region for its code — the same one tasks are submitted to.
  const campusRegionKey = selectedCampus ? selectedCampus.regionId || operatingRegionFor(selectedCampus.code) : null;
  const liveZones = useMemo(
    () => liveZonesForCampus(dtaroView, campusRegionKey, { campusSelected: Boolean(selectedCampus) }),
    [dtaroView, campusRegionKey, selectedCampus]
  );
  // The proposal preview — until the published map holds it: then it IS the operational map and
  // Zones shows the published zones, never a "not approved, not published" proposal.
  const zonePreview = useMemo(() => {
    if (!zoneMapEnabled) return null;
    const preview = previewZonesForCampus(RNSIT_ZONE_PROPOSAL_PREVIEW, selectedCampus?.code || null);
    return preview && previewIsPublished(preview, liveZones.zones) ? null : preview;
  }, [zoneMapEnabled, selectedCampus, liveZones]);
  const previewActive = zoneView === ZONE_VIEW.PROPOSAL && Boolean(zonePreview);
  const publishedActive = zoneView === ZONE_VIEW.PUBLISHED;
  const placedPreview = useMemo(
    () => (previewActive ? previewLabelsClearOf(zonePreview, previewRobotSample) : zonePreview),
    [previewActive, zonePreview, previewRobotSample]
  );
  const layerZones = useMemo(
    () => zonesForView(zoneView, { liveZones: liveZones.zones, preview: previewActive ? placedPreview : null }),
    [zoneView, previewActive, placedPreview, liveZones]
  );

  // Visual campus areas — named buildings and grounds from the campus's own outlines, so the
  // campus reads by area. Not alert zones (the published map has one zone per region today),
  // and hidden during the proposal preview so the two kinds of shading are never on screen
  // together.
  const campusAreas = useMemo(
    () => (zoneMapEnabled && selectedCampus ? campusAreasFor(campusDefinition) : NO_AREAS),
    [zoneMapEnabled, selectedCampus, campusDefinition]
  );
  const areaRows = useMemo(() => (previewActive ? [] : areaLegendRows(campusAreas)), [previewActive, campusAreas]);
  const areaNotes = useMemo(() => (campusAreas.length ? missingAreaNotes(campusDefinition) : []), [campusAreas, campusDefinition]);
  const layerAreas = areasOn && !previewActive ? campusAreas : NO_AREAS;
  const previewCells = useMemo(
    () => (previewActive ? previewCellCollection(zonePreview, hiddenZones) : null),
    [previewActive, zonePreview, hiddenZones]
  );

  const activity = useSyncExternalStore(obstacleActivityStore.subscribe, obstacleActivityStore.getSnapshot);
  // No campus: every region, each entry naming its own. A campus: its region's published ids only.
  const regionScope = selectedCampus ? liveZones.regionIds : null;
  const activityView = useMemo(
    () => activityEntries(activity, { regionIds: regionScope, filter: activityFilter }),
    [activity, regionScope, activityFilter]
  );
  const scopedObstacles = useMemo(
    () => activityEntries(activity, { regionIds: regionScope }).entries.filter((e) => e.kind === 'OBSTACLE').map((e) => e.obstacle),
    [activity, regionScope]
  );
  const selectedObstacle = useMemo(
    () => (selectedObstacleId ? scopedObstacles.find((o) => o.obstacleId === selectedObstacleId) || null : null),
    [scopedObstacles, selectedObstacleId]
  );
  const zoneNameOf = useCallback(
    (zoneId, regionId) => liveZones.zones.find((z) => z.zoneId === zoneId && z.regionId === regionId)?.name || null,
    [liveZones]
  );
  const robotsById = useMemo(() => new Map((globalRobots || []).map((r) => [String(r?.robotId), r])), [globalRobots]);

  const [dtaroNowMs, setDtaroNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!alertsEnabled) return undefined;
    const timer = setInterval(() => setDtaroNowMs(Date.now()), DTARO_CLOCK_MS);
    return () => clearInterval(timer);
  }, [alertsEnabled]);
  // And exactly when the next obstacle expires, so the panel and the marker stop showing it as
  // active at its expiry rather than up to one clock period later.
  const nextExpiryMs = useMemo(() => {
    const pending = scopedObstacles.map((o) => o.expiresAtMs).filter((ms) => Number.isFinite(ms) && ms > dtaroNowMs);
    return pending.length ? Math.min(...pending) : null;
  }, [scopedObstacles, dtaroNowMs]);
  useEffect(() => {
    if (!alertsEnabled || nextExpiryMs === null) return undefined;
    const timer = setTimeout(() => setDtaroNowMs(Date.now()), Math.max(0, nextExpiryMs - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [alertsEnabled, nextExpiryMs]);

  const toggleZone = useCallback((key) => {
    setHiddenZones((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  useDtaroLayer(mapRef, {
    isMapLoaded: isMapLoaded && environmentReady,
    enabled: zoneMapEnabled,
    zones: layerZones,
    hiddenZones,
    areas: layerAreas,
    previewCells,
    obstacles: scopedObstacles,
    nowMs: dtaroNowMs,
    selectedObstacle,
    robots: globalRobots,
    themeRef,
    subscribeToTheme,
    onSelectObstacle: setSelectedObstacleId,
  });

  // The published zone at the map centre, named in the legend header while the published map is
  // shown (diagnostics): readable with the legend collapsed. Never the preview's zones.
  const zoneHere = useZoneAtCentre(mapRef, {
    isMapLoaded: isMapLoaded && environmentReady,
    zones: zoneMapEnabled && selectedCampus && publishedActive ? liveZones.zones : NO_ZONES,
  });
  const legendZoneNote = useMemo(() => {
    // During the preview the header names the preview, never a published zone: "Alert zone:
    // SYNTHETIC … west half" over four proposal zones read as if it were one of them (2026-10-23).
    // The normal map has no zone overlay, so its header names none.
    if (zoneMapEnabled && selectedCampus && previewActive) {
      return { text: `Proposal preview: ${zonePreview.layout || 'proposal'} · ${zonePreview.zones.length} zones`, color: null };
    }
    if (!zoneMapEnabled || !selectedCampus || !publishedActive || liveZones.status !== ZONE_STATUS.READY) return null;
    return zoneHere ? { text: `Alert zone: ${zoneHere.name}`, color: zoneHere.color } : { text: 'Outside the alert zones', color: null };
  }, [zoneMapEnabled, selectedCampus, liveZones.status, zoneHere, previewActive, publishedActive, zonePreview]);

  // Switching the map's zone view (Normal map / Zones). A rendering preference: it changes what
  // the DTARO layer draws and nothing else — no request, no publish or pin, no alert, route or
  // assignment change. Turning the proposal ON frames it top-down clear of the legend ONLY when
  // it is not already wholly on screen there, so switching back and forth does not move the
  // camera (the pitched default view hid the south-west lobe under the legend).
  const setZoneView = useCallback(
    (view) => {
      setZoneViewState(view);
      if (view !== ZONE_VIEW.PROPOSAL) return;
      setPreviewRobotSample((globalRobots || []).map((r) => ({ lat: r?.lat, lon: r?.lon })));
      const map = mapRef.current;
      if (!map || !zonePreview || zonePreview.cells.length === 0) return;
      let minLon = Infinity;
      let minLat = Infinity;
      let maxLon = -Infinity;
      let maxLat = -Infinity;
      for (const cell of zonePreview.cells) {
        for (const [lon, lat] of cell.ring || []) {
          if (lon < minLon) minLon = lon;
          if (lon > maxLon) maxLon = lon;
          if (lat < minLat) minLat = lat;
          if (lat > maxLat) maxLat = lat;
        }
      }
      if (!Number.isFinite(minLon)) return;
      try {
        const width = map.getContainer()?.clientWidth || 1000;
        const height = map.getContainer()?.clientHeight || 700;
        // An expanded legend covers the lower left; a collapsed one is a header bar.
        const padding = { top: 64, bottom: 96, left: legendExpanded ? Math.min(360, Math.round(width * 0.3)) : 48, right: 64 };
        const corners = [
          [minLon, minLat],
          [minLon, maxLat],
          [maxLon, minLat],
          [maxLon, maxLat],
        ];
        // A few pixels of slack: after a fit the corners sit exactly ON the padded edge, and
        // floating point (63.9999 vs 64) re-framed a view that was already right (2026-10-23).
        const slack = 12;
        const inView = corners.every((lngLat) => {
          const { x, y } = map.project(lngLat);
          return (
            x >= padding.left - slack &&
            x <= width - padding.right + slack &&
            y >= padding.top - slack &&
            y <= height - padding.bottom + slack
          );
        });
        if (inView) return;
        // Flat framing computed here, not `fitBounds` (terrain-dependent, and its padding would
        // stay on the map) — see topDownCameraForBounds.
        const cam = topDownCameraForBounds(
          [
            [minLon, minLat],
            [maxLon, maxLat],
          ],
          { width, height, padding }
        );
        if (!cam) return;
        // Claims the camera like every other command, so a deferred stage of an earlier one (the
        // arrival tilt) cannot run after this.
        sequencerRef.current?.begin();
        map.easeTo({ center: cam.center, zoom: cam.zoom, pitch: 0, bearing: 0, duration: 900, essential: true });
      } catch {
        // a camera the map refuses (mid-style-reload) leaves the view where it is
      }
    },
    [mapRef, zonePreview, globalRobots, legendExpanded]
  );

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
      setBasemapConfig(map, 'showPointOfInterestLabels', campusActive && !campusHasGeometry);
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
    setSelectedStationId(null);
    setCameraMode(CAMPUS_CAMERA_MODE.OVERVIEW);
    setZoneViewState(ZONE_VIEW.NORMAL);
    setHiddenZones(NO_HIDDEN_ZONES);
    setSelectedObstacleId(null);
  }

  // DTARO — an obstacle and a campus feature or station card share the right side of the map,
  // so picking one closes the other: one inspected object at a time, as for robots and stations.
  const [obstacleIdAtCards, setObstacleIdAtCards] = useState(selectedObstacleId);
  if (obstacleIdAtCards !== selectedObstacleId) {
    setObstacleIdAtCards(selectedObstacleId);
    if (selectedObstacleId) {
      setSelectedFeature(null);
      setSelectedStationId(null);
    }
  }
  const cardOpen = Boolean(selectedFeature || selectedStationId);
  const [cardOpenAtObstacle, setCardOpenAtObstacle] = useState(cardOpen);
  if (cardOpenAtObstacle !== cardOpen) {
    setCardOpenAtObstacle(cardOpen);
    if (cardOpen) setSelectedObstacleId(null);
  }

  // Selecting a robot closes the station card: one inspected object at a time. Adjusted during
  // render, like the campus reset above, so no frame shows both.
  const [robotIdAtStation, setRobotIdAtStation] = useState(selectedRobotId);
  if (robotIdAtStation !== selectedRobotId) {
    setRobotIdAtStation(selectedRobotId);
    if (selectedRobotId) setSelectedStationId(null);
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

    // A re-run for the target already applied (a list finished loading, the style reloaded, a
    // dependency changed identity) is not a new choice: the camera is never re-aimed at it,
    // wherever the operator has moved it since. Only a different target moves the camera.
    const focusKey = focusTarget ? `${focusTarget.type}:${focusTarget.loc?.lat}:${focusTarget.loc?.lon}` : 'NONE';
    if (lastFocusKeyRef.current === focusKey) return;
    lastFocusKeyRef.current = focusKey;
    // The map opens at the campus (see the map-init effect), so the campus record arriving is
    // usually a target already on screen: no flight to where the operator is already looking.
    const alreadyAt = (cam) => {
      try {
        const map = mapRef.current;
        const c = map.getCenter();
        return isCameraNear({ lon: c.lng, lat: c.lat, zoom: map.getZoom() }, cam);
      } catch {
        return false;
      }
    };

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
      // RBAC — a campus administrator opens on its own campus, never on another one.
      const bounds = pinnedCampusCode ? campusBounds(pinnedCampusCode) : operatingCampusBounds();
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
      if (!skipAnimation && !alreadyAt(cam)) focusCamera(cam, 0);
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
    if (!skipAnimation && !alreadyAt(cam)) focusCamera(cam, preset.pitch);
  }, [isMapLoaded, environmentReady, focusTarget, focusCamera, mapRef, pinnedCampusCode]);

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
    // Routes are restored when the map can take layers — not on the next telemetry tick,
    // which never comes for a robot standing still.
    isMapLoaded,
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
      setSelectedStationId(null);
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

  /** A station picked from the legend's list: select it and bring it into view. */
  const pickStation = useCallback(
    (chargerId) => {
      const station = chargingStations.find((s) => s.chargerId === chargerId);
      if (!station?.lngLat) return;
      clearSelection();
      setSelectedFeature(null);
      setSelectedStationId(chargerId);
      focusLngLat(station.lngLat[0], station.lngLat[1], 18.2);
    },
    [chargingStations, clearSelection, focusLngLat]
  );

  const focusObstacle = useCallback(
    (obstacle) => {
      if (Number.isFinite(obstacle?.lon) && Number.isFinite(obstacle?.lat)) focusLngLat(obstacle.lon, obstacle.lat, 18);
    },
    [focusLngLat]
  );

  const focusSelectedStation = useCallback(() => {
    if (selectedStation?.lngLat) focusLngLat(selectedStation.lngLat[0], selectedStation.lngLat[1], 18.2);
  }, [selectedStation, focusLngLat]);

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
    setSelectedStationId(null);
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
      campusLocked={!superAdmin}
      showHierarchy={false}
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

          {alertsEnabled && (
            <ObstacleActivityPanel
              connectionState={connectionState}
              entries={activityView.entries}
              hiddenCount={activityView.hiddenCount}
              campusName={selectedCampus ? campusDefinition.name : null}
              filter={activityFilter}
              onFilter={setActivityFilter}
              selectedObstacle={selectedObstacle}
              onSelect={setSelectedObstacleId}
              onFocus={focusObstacle}
              zoneNameOf={zoneNameOf}
              robotsById={robotsById}
              nowMs={dtaroNowMs}
            />
          )}

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

      {/* The map's view: the clean campus, or the zone overlay. On the map itself, top centre. */}
      {!mapFailure && zoneMapEnabled && selectedCampus && (
        <div className="map-zone-mode" role="group" aria-label="Map view">
          <button
            type="button"
            className={`map-zone-mode__option${zoneView === ZONE_VIEW.NORMAL ? ' is-active' : ''}`}
            aria-pressed={zoneView === ZONE_VIEW.NORMAL}
            onClick={() => setZoneView(ZONE_VIEW.NORMAL)}
          >
            Normal map
          </button>
          <button
            type="button"
            className={`map-zone-mode__option is-zones${zoneView === ZONE_VIEW.NORMAL ? '' : ' is-active'}`}
            aria-pressed={zoneView !== ZONE_VIEW.NORMAL}
            onClick={() => {
              if (zoneView === ZONE_VIEW.NORMAL) setZoneView(zonePreview ? ZONE_VIEW.PROPOSAL : ZONE_VIEW.PUBLISHED);
            }}
          >
            Zones
            {/* What the overlay is, so an unpublished preview is never mistaken for live zones. */}
            <span className={`map-zone-mode__tag${publishedActive || !zonePreview ? ' is-published' : ''}`}>
              {zonePreview ? (publishedActive ? 'published · diagnostic' : `${zonePreview.layout || 'proposal'} preview · not live`) : 'published'}
            </span>
          </button>
        </div>
      )}

      {!mapFailure && previewActive && (
        <div className="map-dtaro-preview-banner" role="note">
          <span className="map-dtaro-preview-banner__long">
            {zonePreview.layout ? `${zonePreview.layout} ` : ''}zone proposal preview
            {zonePreview.validated ? ' — validated offline' : ''} — NOT approved, NOT published, not used for alerts.
            {liveZones.zones.length > 0
              ? ` Alerts use the published map (${liveZones.zones.length} zone${liveZones.zones.length === 1 ? '' : 's'}).`
              : ''}
          </span>
          {/* A phone's short form: the long one ran to four lines over the obstacle panel. */}
          <span className="map-dtaro-preview-banner__short">
            {zonePreview.layout ? `${zonePreview.layout} ` : ''}preview — not approved, not published, not used for alerts
          </span>
        </div>
      )}

      {/* Sits beside the coverage notice, and only when the validator has
          something to say. §3D: a route that contradicts the campus geometry is
          reported, never rendered away. */}
      {!mapFailure && <RouteIssuesNotice summary={routeFindings} />}

      {!mapFailure && selectedStation && (
        <ChargingStationCard
          station={selectedStation}
          onClose={() => setSelectedStationId(null)}
          onFocus={focusSelectedStation}
        />
      )}

      {!mapFailure && selectedFeature && !selectedStation && (
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
          stations={chargingStations}
          chargingReported={Boolean(simulatorStatus?.charging)}
          chargingRestricted={!mayReadSimulator(session)}
          selectedStationId={selectedStationId}
          onPickStation={pickStation}
          headerNote={legendZoneNote}
          expanded={legendExpanded}
          onExpandedChange={setLegendExpanded}
          zoneSection={
            zoneMapEnabled ? (
              <ZoneLegendSection
                status={liveZones.status}
                zones={liveZones.zones}
                hiddenZones={hiddenZones}
                onToggleZone={toggleZone}
                onShowAll={() => setHiddenZones(NO_HIDDEN_ZONES)}
                spatialVersion={dtaroView?.spatialVersion ?? null}
                preview={zonePreview}
                mode={zoneView}
                onModeChange={setZoneView}
                areaRows={areaRows}
                areasOn={areasOn}
                onToggleAreas={setAreasOn}
                areaNotes={areaNotes}
                areaSource={campusDefinition.verificationRecord ? 'OpenStreetMap, checked by the project owner' : 'OpenStreetMap, not verified'}
                alertsEnabled={alertsEnabled}
                loadError={dtaroView?.error || null}
                boundaryColor={campusFeatureCount > 1 ? theme.campus.boundaryLine : null}
              />
            ) : null
          }
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
          className="map-recenter absolute bottom-11 right-3 z-10 shadow-lg"
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
