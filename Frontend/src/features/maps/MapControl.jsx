import React, { useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import gsap from 'gsap';

import { MAP_STYLE } from '../../config/mapConfig.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.jsx';
import { Button } from '../../components/ui/button.jsx';

const CAMPUS_STYLE = 'mapbox://styles/mapbox/standard';

import { MapProvider } from './mapControl/MapProvider.jsx';
import { useMapContext } from './mapControl/mapContext.js';
import { useMapController } from './mapControl/hooks/useMapController.js';
import { useLocationFilters } from './mapControl/hooks/useLocationFilters.js';
import { useRobotStream } from './mapControl/hooks/useRobotStream.js';
import { useAppState } from '../../context/appContext.js';

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
  const { robots: globalRobots } = useAppState();

  const overlayRef = useRef(null);
  const canvasRef = useRef(null);
  const styleModeRef = useRef('default');
  const styleTransitionIdRef = useRef(0);
  const latestCameraRef = useRef(null);

  const token = import.meta.env.VITE_MAPBOX_TOKEN;

  // Initialize Mapbox once (no reloads)
  useEffect(() => {
    if (!token) return;
    if (!mapContainerRef.current) return;
    if (mapRef.current) return;

    mapboxgl.accessToken = token;

    const map = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: MAP_STYLE,
      center: WORLD_CENTER,
      zoom: WORLD_ZOOM,
      attributionControl: false,
    });

    map.addControl(new mapboxgl.NavigationControl({ showCompass: true }), 'top-left');

    mapRef.current = map;

    const onResize = () => {
      try {
        map.resize();
      } catch {
        // ignore
      }
    };

    window.addEventListener('resize', onResize);

    return () => {
      window.removeEventListener('resize', onResize);

      try {
        markersRef.current.forEach((m) => {
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
        markersRef.current.clear();
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

  // Focus rules (strict)
  const focusTarget = useMemo(() => {
    if (selectedCampus) {
      return {
        type: 'CAMPUS',
        loc: { lat: selectedCampus.centerLat, lon: selectedCampus.centerLon },
        pitch: 60,
        bearing: -20,
      };
    }
    if (selectedArea) return { type: 'AREA', loc: selectedArea, pitch: 55, bearing: -20 };
    if (selectedCity) return { type: 'CITY', loc: selectedCity, pitch: 55, bearing: -20 };
    if (selectedState) return { type: 'STATE', loc: selectedState, pitch: 0, bearing: 0 };
    if (selectedCountry) return { type: 'COUNTRY', loc: selectedCountry, pitch: 0, bearing: 0 };
    return null;
  }, [selectedCampus, selectedCountry, selectedState, selectedCity, selectedArea]);

  useEffect(() => {
    if (!isMapLoaded) return;

    const wantStyleMode = campusId ? 'campus' : 'default';
    const isStyleAboutToSwitch = styleModeRef.current !== wantStyleMode;

    // No filters selected: world view
    if (!focusTarget) {
      const cam = { lon: WORLD_CENTER[0], lat: WORLD_CENTER[1], zoom: WORLD_ZOOM, pitch: 0, bearing: 0 };
      latestCameraRef.current = cam;
      if (!isStyleAboutToSwitch) flyTo(cam);
      return;
    }

    const { type, loc } = focusTarget;
    if (!hasCenter(loc)) return;

    const cam = {
      lon: loc.lon,
      lat: loc.lat,
      zoom: ZOOM_LEVELS[type] || WORLD_ZOOM,
      pitch: typeof focusTarget?.pitch === 'number' ? focusTarget.pitch : 0,
      bearing: typeof focusTarget?.bearing === 'number' ? focusTarget.bearing : 0,
    };

    latestCameraRef.current = cam;
    if (!isStyleAboutToSwitch) flyTo(cam);
  }, [isMapLoaded, focusTarget, flyTo, campusId]);

  // Campus view: switch to day 3D basemap (Mapbox Standard) with a smooth fade transition
  useEffect(() => {
    const map = mapRef?.current;
    if (!map) return;

    const wantMode = campusId ? 'campus' : 'default';
    if (styleModeRef.current === wantMode) return;
    styleModeRef.current = wantMode;

    const nextStyle = wantMode === 'campus' ? CAMPUS_STYLE : MAP_STYLE;

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
  useRobotStream({
    robots: globalRobots,
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
