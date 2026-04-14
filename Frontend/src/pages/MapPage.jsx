/* eslint-disable react-hooks/exhaustive-deps */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { AlertTriangle, ArrowRight, Maximize2, Minimize2, Pause, RefreshCw, StopCircle, Trash2, X } from 'lucide-react';

import FleetDbMap from '../features/maps/FleetDbMap.jsx';
import CampusMap from '../features/campus/CampusMap.jsx';
import { LOCATION_TREE, MAP_CENTER, MAP_FLEET_ROBOTS, MAP_ZOOM } from '../config/mapConfig';
import { useAppActions, useAppState } from '../context/appContext.js';
import { Button } from '../components/ui/button.jsx';

import {
  bearingDeg,
  haversineMeters,
  interpolateLngLat,
  metersToLngLatDelta,
} from '../lib/geo';

import { createRobotMarkerElement } from '../lib/mapboxMarkers';

const RNSIT_CENTER = [77.51867955304837, 12.902372122601147];

export default function MapPage() {
  const { systemOnline } = useAppState();
  const { requestAuth, retire, stopAll } = useAppActions();
  const navigate = useNavigate();

  const [isFullscreen, setIsFullscreen] = useState(false);

  const [selectedRobot, setSelectedRobot] = useState(null);
  const [localDecision, setLocalDecision] = useState(null);
  const [mapStatus, setMapStatus] = useState('ready');
  const [mapError, setMapError] = useState('');
  const [mapRetryKey, setMapRetryKey] = useState(0);

  const [country, setCountry] = useState('India');
  const [stateName, setStateName] = useState('Karnataka');
  const [city, setCity] = useState('Bengaluru');
  const [area, setArea] = useState('RR Nagar');
  const [campus, setCampus] = useState('None');

  const CITY_STYLE_URL = 'mapbox://styles/mapbox/dark-v11';
  const CAMPUS_STYLE_URL = 'mapbox://styles/somanatha-dev/cmndie4c6001a01sa75ykfgpp';

  const isCampusMode = campus === 'RNSIT';

  useEffect(() => {
    if (!isFullscreen) return;
    const onKeyDown = (e) => {
      if (e.key === 'Escape') setIsFullscreen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isFullscreen]);

  const toggleFullscreen = () => {
    setIsFullscreen((prev) => !prev);
    // Ensure Mapbox instances inside child components recalc size.
    setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
    setTimeout(() => window.dispatchEvent(new Event('resize')), 250);
  };

  const modeRef = useRef('city');
  useEffect(() => {
    modeRef.current = isCampusMode ? 'campus' : 'city';
  }, [isCampusMode]);

  const CAMPUS_ROBOT_PATHS = useMemo(
    () => {
      const at = (mx, my) => {
        const [dLng, dLat] = metersToLngLatDelta(mx, my, RNSIT_CENTER[1]);
        return [RNSIT_CENTER[0] + dLng, RNSIT_CENTER[1] + dLat];
      };

      return {
        R1: [at(10, 8), at(60, 30), at(120, 10), at(95, -35), at(25, -25), at(10, 8)],
        R2: [at(-20, 5), at(-20, 5)],
        R3: [at(-10, -35), at(55, -55), at(120, -25), at(105, 20), at(35, 35), at(-10, -35)],
      };
    },
    []
  );

  const selectedArea = useMemo(() => {
    const c = LOCATION_TREE?.[country];
    const s = c?.states?.[stateName];
    const ci = s?.cities?.[city];
    const a = ci?.areas?.[area];
    return a || null;
  }, [country, stateName, city, area]);

  const selectedAreaKey = `${country}::${stateName}::${city}::${area}`;

  const selectLists = useMemo(() => {
    const countries = Object.keys(LOCATION_TREE || {});
    const states = Object.keys(LOCATION_TREE?.[country]?.states || {});
    const cities = Object.keys(LOCATION_TREE?.[country]?.states?.[stateName]?.cities || {});
    const areas = Object.keys(LOCATION_TREE?.[country]?.states?.[stateName]?.cities?.[city]?.areas || {});
    return { countries, states, cities, areas };
  }, [country, stateName, city]);

  const selectedAreaRef = useRef(null);
  const selectedAreaKeyRef = useRef(selectedAreaKey);
  useEffect(() => {
    selectedAreaRef.current = selectedArea;
    selectedAreaKeyRef.current = selectedAreaKey;
  }, [selectedArea, selectedAreaKey]);

  const handleCountryChange = (nextCountry) => {
    const states = Object.keys(LOCATION_TREE?.[nextCountry]?.states || {});
    const nextState = states.includes('Karnataka') ? 'Karnataka' : states[0] || '';
    const cities = Object.keys(LOCATION_TREE?.[nextCountry]?.states?.[nextState]?.cities || {});
    const nextCity = cities.includes('Bengaluru') ? 'Bengaluru' : cities[0] || '';
    const areas = Object.keys(LOCATION_TREE?.[nextCountry]?.states?.[nextState]?.cities?.[nextCity]?.areas || {});
    const nextArea = areas.includes('RR Nagar') ? 'RR Nagar' : areas[0] || '';

    setCountry(nextCountry);
    if (nextState) setStateName(nextState);
    if (nextCity) setCity(nextCity);
    if (nextArea) setArea(nextArea);
  };

  const handleStateChange = (nextState) => {
    const cities = Object.keys(LOCATION_TREE?.[country]?.states?.[nextState]?.cities || {});
    const nextCity = cities.includes('Bengaluru') ? 'Bengaluru' : cities[0] || '';
    const areas = Object.keys(LOCATION_TREE?.[country]?.states?.[nextState]?.cities?.[nextCity]?.areas || {});
    const nextArea = areas.includes('RR Nagar') ? 'RR Nagar' : areas[0] || '';

    setStateName(nextState);
    if (nextCity) setCity(nextCity);
    if (nextArea) setArea(nextArea);
  };

  const handleCityChange = (nextCity) => {
    const areas = Object.keys(LOCATION_TREE?.[country]?.states?.[stateName]?.cities?.[nextCity]?.areas || {});
    const nextArea = areas.includes('RR Nagar') ? 'RR Nagar' : areas[0] || '';

    setCity(nextCity);
    if (nextArea) setArea(nextArea);
  };

  const fleetBaseRef = useRef(
    MAP_FLEET_ROBOTS.map((r) => ({
      id: r.id,
      name: r.name,
      color: r.color,
      speedMps: r.speedMps,
    }))
  );

  const mapRobotsRef = useRef(
    MAP_FLEET_ROBOTS.map((r) => {
      const start = MAP_CENTER;
      return {
        id: r.id,
        name: r.name,
        color: r.color,
        speed: r.speedMps,
        speedMps: r.speedMps,
        status: r.status || 'to_pickup',
        battery: 78,
        taskId: `T-${r.id}`,
        task: 'To pickup',
        lon: start[0],
        lat: start[1],
        locText: `Lat: ${start[1].toFixed(5)}, Lon: ${start[0].toFixed(5)}`,
        health: { gps: true, telemetry: true, motors: true, connection: true },
        issue: null,
      };
    })
  );

  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef(new Map());
  const runtimeRef = useRef([]);
  const animationFrameRef = useRef(null);
  const resizeObserverRef = useRef(null);
  const directionsRouteCacheRef = useRef(new Map());
  const directionsAbortRef = useRef(null);

  const setRouteOpacities = (map, robotId, toPickupOpacity, toDropOpacity) => {
    try {
      map.setPaintProperty(`robot-to-pickup-layer-${robotId}`, 'line-opacity', toPickupOpacity);
      map.setPaintProperty(`robot-to-drop-layer-${robotId}`, 'line-opacity', toDropOpacity);
    } catch {
      // ignore
    }
  };

  const START_OFFSETS_METERS = useMemo(() => [[-220, 120], [180, -140], [-80, -260]], []);

  const PICKUP_OFFSETS_METERS = useMemo(() => [[260, 280], [-320, 180], [160, -340], [420, 60], [-140, 420]], []);

  const DROP_OFFSETS_METERS = useMemo(() => [[520, -80], [-420, -420], [80, 560], [360, 420], [-560, 20]], []);

  const offsetLngLat = (centerLngLat, metersX, metersY) => {
    const [dLng, dLat] = metersToLngLatDelta(metersX, metersY, centerLngLat[1]);
    return [centerLngLat[0] + dLng, centerLngLat[1] + dLat];
  };

  const buildMissionPoints = (areaCenter, robotIdx, orderIdx, startLngLat) => {
    const start =
      startLngLat ||
      offsetLngLat(areaCenter, ...START_OFFSETS_METERS[robotIdx % START_OFFSETS_METERS.length]);
    const pickup = offsetLngLat(
      areaCenter,
      ...PICKUP_OFFSETS_METERS[(robotIdx + orderIdx) % PICKUP_OFFSETS_METERS.length]
    );
    const drop = offsetLngLat(
      areaCenter,
      ...DROP_OFFSETS_METERS[(robotIdx * 2 + orderIdx) % DROP_OFFSETS_METERS.length]
    );
    return { start, pickup, drop };
  };

  const toRouteKey = (fromLngLat, toLngLat) => {
    const f0 = Number(fromLngLat[0]).toFixed(5);
    const f1 = Number(fromLngLat[1]).toFixed(5);
    const t0 = Number(toLngLat[0]).toFixed(5);
    const t1 = Number(toLngLat[1]).toFixed(5);
    return `${f0},${f1};${t0},${t1}`;
  };

  const buildRouteData = (coords) => {
    const safe = Array.isArray(coords) ? coords : [];
    const segLens = [];
    let totalLen = 0;
    for (let i = 0; i < safe.length - 1; i++) {
      const len = haversineMeters(safe[i], safe[i + 1]);
      const l = Number.isFinite(len) ? len : 0;
      segLens.push(l);
      totalLen += l;
    }
    return { coords: safe, segLens, totalLen };
  };

  const fetchDirectionsRoute = async ({ fromLngLat, toLngLat, accessToken, signal }) => {
    const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${fromLngLat[0]},${fromLngLat[1]};${toLngLat[0]},${toLngLat[1]}?geometries=geojson&overview=full&access_token=${accessToken}`;
    const res = await fetch(url, { signal });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Directions API failed (${res.status}): ${text || res.statusText}`);
    }
    const json = await res.json();
    const route = json?.routes?.[0];
    const coords = route?.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) throw new Error('Directions API returned no route geometry.');
    return buildRouteData(coords);
  };

  const getRouteCached = async ({ cache, fromLngLat, toLngLat, accessToken, signal }) => {
    const key = toRouteKey(fromLngLat, toLngLat);
    const existing = cache.get(key);
    if (existing?.status === 'ready') return existing.data;
    if (existing?.status === 'pending') return existing.promise;

    const promise = fetchDirectionsRoute({ fromLngLat, toLngLat, accessToken, signal }).then((data) => {
      cache.set(key, { status: 'ready', data });
      return data;
    });
    cache.set(key, { status: 'pending', promise });
    return promise;
  };

  const setLineData = (map, sourceId, coords, robotId, kind) => {
    try {
      const safeCoords = Array.isArray(coords) && coords.length >= 2 ? coords : [[0, 0], [0, 0]];
      const src = map.getSource(sourceId);
      src?.setData?.({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: safeCoords },
        properties: { id: robotId, kind },
      });
    } catch {
      // ignore
    }
  };

  const getFirstSymbolLayerId = (map) => {
    try {
      const layers = map.getStyle()?.layers;
      if (!Array.isArray(layers)) return undefined;
      const first = layers.find((l) => l?.type === 'symbol');
      return first?.id;
    } catch {
      return undefined;
    }
  };

  const ensureCityRouteLayers = (map) => {
    if (!map) return;
    const beforeId = getFirstSymbolLayerId(map);
    const emptyLine = {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [[0, 0], [0, 0]] },
      properties: {},
    };

    for (const r of fleetBaseRef.current) {
      const pickupSourceId = `robot-to-pickup-${r.id}`;
      const dropSourceId = `robot-to-drop-${r.id}`;
      const pickupLayerId = `robot-to-pickup-layer-${r.id}`;
      const dropLayerId = `robot-to-drop-layer-${r.id}`;

      try {
        if (!map.getSource(pickupSourceId)) {
          map.addSource(pickupSourceId, { type: 'geojson', data: emptyLine });
        }
      } catch {
        // ignore
      }

      try {
        if (!map.getSource(dropSourceId)) {
          map.addSource(dropSourceId, { type: 'geojson', data: emptyLine });
        }
      } catch {
        // ignore
      }

      try {
        if (!map.getLayer(pickupLayerId)) {
          map.addLayer(
            {
              id: pickupLayerId,
              type: 'line',
              source: pickupSourceId,
              layout: { 'line-join': 'round', 'line-cap': 'round' },
              paint: {
                'line-color': r.color,
                'line-width': 4,
                'line-opacity': 0.55,
              },
            },
            beforeId
          );
        }
      } catch {
        // ignore
      }

      try {
        if (!map.getLayer(dropLayerId)) {
          map.addLayer(
            {
              id: dropLayerId,
              type: 'line',
              source: dropSourceId,
              layout: { 'line-join': 'round', 'line-cap': 'round' },
              paint: {
                'line-color': r.color,
                'line-width': 3,
                'line-opacity': 0.35,
                'line-dasharray': [2, 2],
              },
            },
            beforeId
          );
        }
      } catch {
        // ignore
      }
    }
  };

  const ensureCampus3DBuildings = (map) => {
    if (!map) return;
    const layerId = '3d-buildings';
    try {
      if (map.getLayer(layerId)) return;
    } catch {
      // ignore
    }

    try {
      const beforeId = getFirstSymbolLayerId(map);
      const style = map.getStyle();
      const sources = style?.sources || {};
      if (!sources.composite) return;
      map.addLayer(
        {
          id: layerId,
          type: 'fill-extrusion',
          source: 'composite',
          'source-layer': 'building',
          minzoom: 15,
          paint: {
            'fill-extrusion-color': '#aaa',
            'fill-extrusion-height': ['get', 'height'],
            'fill-extrusion-base': ['get', 'min_height'],
            'fill-extrusion-opacity': 0.6,
          },
        },
        beforeId
      );
    } catch {
      // ignore
    }
  };

  const reAddAllMarkers = (map) => {
    if (!map) return;
    const markers = markersRef.current;
    markers.forEach((m) => {
      try {
        m?.marker?.addTo?.(map);
      } catch {
        // ignore
      }
    });
  };

  const planRoutesForRobot = async (rr, centerLngLat, startOverrideLngLat) => {
    const map = mapRef.current;
    const abortController = directionsAbortRef.current;
    if (!map || !abortController) return;
    const accessToken = import.meta.env.VITE_MAPBOX_TOKEN;
    if (!accessToken) return;

    const startLngLat =
      startOverrideLngLat ||
      rr.lastLngLat ||
      buildMissionPoints(centerLngLat, rr.robotIdx, rr.orderIndex || 0, null).start;
    rr.mission = buildMissionPoints(centerLngLat, rr.robotIdx, rr.orderIndex || 0, startLngLat);
    rr.phase = 'to_pickup';
    rr.active = 'A';
    rr.segIndex = 0;
    rr.segT = 0;
    rr.status = 'to_pickup';
    rr.routeA = null;
    rr.routeB = null;

    try {
      const cache = directionsRouteCacheRef.current;
      const [routeA, routeB] = await Promise.all([
        getRouteCached({
          cache,
          fromLngLat: rr.mission.start,
          toLngLat: rr.mission.pickup,
          accessToken,
          signal: abortController.signal,
        }),
        getRouteCached({
          cache,
          fromLngLat: rr.mission.pickup,
          toLngLat: rr.mission.drop,
          accessToken,
          signal: abortController.signal,
        }),
      ]);
      if (abortController.signal.aborted) return;

      rr.routeA = routeA;
      rr.routeB = routeB;

      setLineData(map, `robot-to-pickup-${rr.id}`, rr.routeA.coords, rr.id, 'toPickup');
      setLineData(map, `robot-to-drop-${rr.id}`, rr.routeB.coords, rr.id, 'toDrop');
      setRouteOpacities(map, rr.id, 0.55, 0.35);

      rr.lastLngLat = rr.routeA.coords[0];
      rr.lastBearing = bearingDeg(rr.routeA.coords[0], rr.routeA.coords[1]);
      try {
        rr.marker.setLngLat(rr.lastLngLat);
        rr.carEl.style.transform = `rotate(${rr.lastBearing}deg)`;
      } catch {
        // ignore
      }
    } catch (e) {
      if (abortController.signal.aborted) return;
      console.error('Directions route planning failed:', rr.id, e);
    }
  };

  const applySelectionStyles = (selectedId) => {
    const markers = markersRef.current;
    markers.forEach((m, id) => {
      const isSelected = selectedId && id === selectedId;
      if (m?.root) {
        m.root.style.width = '34px';
        m.root.style.height = '34px';
        m.root.style.transformOrigin = '50% 50%';
        m.root.style.transform = isSelected ? 'scale(1.12)' : 'scale(1)';
      }
      if (m?.carEl) {
        m.carEl.style.filter = isSelected ? 'drop-shadow(0 10px 16px rgba(0,0,0,0.35))' : '';
      }
    });
  };

  useEffect(() => {
    const useLegacyEmbeddedMap = import.meta.env.VITE_USE_LEGACY_EMBEDDED_MAP === 'true';
    if (!useLegacyEmbeddedMap) {
      Promise.resolve().then(() => {
        setMapStatus('ready');
        setMapError('');
      });
      return;
    }

    let isMounted = true;
    let loadTimeout = null;
    let readyFailSafeTimeout = null;
    let readyAfterLoadTimeout = null;
    const markers = markersRef.current;

    const hardFail = (message) => {
      if (!isMounted) return;
      setMapError(String(message || 'Map failed to load.'));
      setMapStatus('error');
    };

    const destroy = () => {
      try {
        if (loadTimeout) clearTimeout(loadTimeout);
      } catch {
        // ignore
      }
      try {
        if (readyFailSafeTimeout) clearTimeout(readyFailSafeTimeout);
      } catch {
        // ignore
      }
      try {
        if (readyAfterLoadTimeout) clearTimeout(readyAfterLoadTimeout);
      } catch {
        // ignore
      }

      try {
        directionsAbortRef.current?.abort?.();
      } catch {
        // ignore
      }
      directionsAbortRef.current = null;

      try {
        if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
      } catch {
        // ignore
      }
      animationFrameRef.current = null;

      try {
        resizeObserverRef.current?.disconnect?.();
      } catch {
        // ignore
      }
      resizeObserverRef.current = null;

      try {
        markers.forEach((m) => m?.marker?.remove?.());
        markers.clear();
      } catch {
        // ignore
      }

      try {
        mapRef.current?.remove?.();
      } catch {
        // ignore
      }
      mapRef.current = null;
    };

    const init = () => {
      if (!isMounted) return;
      if (!mapContainerRef.current) {
        hardFail('Map container is missing.');
        return;
      }
      if (mapRef.current) return;

      if (typeof mapboxgl?.supported === 'function' && !mapboxgl.supported()) {
        hardFail('WebGL is not supported/available in this browser or hardware acceleration is disabled.');
        return;
      }

      setMapStatus('loading');
      setMapError('');

      loadTimeout = setTimeout(() => {
        if (!isMounted) return;
        if (mapRef.current) return;
        hardFail('Map init timed out.');
      }, 12000);

      try {
        if (!import.meta.env.VITE_MAPBOX_TOKEN) {
          hardFail('VITE_MAPBOX_TOKEN is missing. Add it to Frontend/.env or Frontend/.env.local and restart `npm run dev`.');
          return;
        }

        mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN;

        let hasMarkedReady = false;

        const map = new mapboxgl.Map({
          container: mapContainerRef.current,
          style: isCampusMode ? CAMPUS_STYLE_URL : CITY_STYLE_URL,
          center: isCampusMode ? RNSIT_CENTER : MAP_CENTER,
          zoom: isCampusMode ? 17.5 : MAP_ZOOM,
          pitch: isCampusMode ? 65 : 0,
          bearing: isCampusMode ? -25 : 0,
        });

        mapRef.current = map;

        readyFailSafeTimeout = setTimeout(() => {
          if (!isMounted) return;
          hasMarkedReady = true;
          setMapStatus((prev) => (prev === 'ready' ? prev : 'ready'));
        }, 2000);

        map.on('error', (e) => {
          console.error('MAPBOX ERROR:', e);
          const message = e?.error?.message || e?.message || 'Map failed to load style/tiles.';
          if (!hasMarkedReady) hardFail(message);
        });

        map.on('load', () => {
          try {
            directionsAbortRef.current?.abort?.();
          } catch {
            // ignore
          }
          directionsAbortRef.current = new AbortController();

          if (modeRef.current === 'campus') {
            ensureCampus3DBuildings(map);
          } else {
            ensureCityRouteLayers(map);
          }

          map.once('idle', () => {
            if (!isMounted) return;
            hasMarkedReady = true;
            setMapStatus('ready');
          });

          readyAfterLoadTimeout = setTimeout(() => {
            if (!isMounted) return;
            hasMarkedReady = true;
            setMapStatus('ready');
          }, 300);

          if (!isMounted) return;
          if (loadTimeout) clearTimeout(loadTimeout);
          setMapError('');

          requestAnimationFrame(() => {
            try {
              map.resize();
              setTimeout(() => map.resize(), 200);
              setTimeout(() => map.resize(), 500);
            } catch {
              // ignore
            }
          });

          try {
            if (typeof ResizeObserver !== 'undefined') {
              const ro = new ResizeObserver(() => {
                try {
                  mapRef.current?.resize?.();
                } catch {
                  // ignore
                }
              });
              ro.observe(mapContainerRef.current);
              resizeObserverRef.current = ro;
            }
          } catch {
            // ignore
          }

          const areaCenter = selectedAreaRef.current?.center || MAP_CENTER;
          const campusCenter = RNSIT_CENTER;

          const runtime = fleetBaseRef.current.map((r, idx) => {
            const { root, car } = createRobotMarkerElement(r.color, r.id);
            root.style.width = '34px';
            root.style.height = '34px';
            root.style.pointerEvents = 'auto';
            root.style.cursor = 'pointer';

            car.style.filter = 'drop-shadow(0 10px 14px rgba(0,0,0,0.25))';

            const mission = buildMissionPoints(areaCenter, idx, 0, null);
            const campusPath = CAMPUS_ROBOT_PATHS?.[r.id] || [[campusCenter[0], campusCenter[1]], [campusCenter[0], campusCenter[1]]];
            const campusStart = campusPath[0];
            const cityStart = mission.start;

            const startLngLat = modeRef.current === 'campus' ? campusStart : cityStart;
            const startBearing =
              modeRef.current === 'campus'
                ? campusPath.length > 1
                  ? bearingDeg(campusPath[0], campusPath[1])
                  : 0
                : bearingDeg(mission.start, mission.pickup);

            setLineData(map, `robot-to-pickup-${r.id}`, [], r.id, 'toPickup');
            setLineData(map, `robot-to-drop-${r.id}`, [], r.id, 'toDrop');
            setRouteOpacities(map, r.id, modeRef.current === 'campus' ? 0.0 : 0.55, modeRef.current === 'campus' ? 0.0 : 0.35);

            root.addEventListener('click', (ev) => {
              ev.stopPropagation();
              const base = mapRobotsRef.current.find((x) => x.id === r.id);
              if (!base) return;
              const rr = runtimeRef.current.find((x) => x.id === r.id);
              const ll = rr?.lastLngLat || (rr?.marker?.getLngLat?.() ? [rr.marker.getLngLat().lng, rr.marker.getLngLat().lat] : startLngLat);
              setSelectedRobot({
                ...base,
                status: base.status || 'to_pickup',
                speed: r.speedMps,
                lon: ll[0],
                lat: ll[1],
                locText: `Lat: ${ll[1].toFixed(5)}, Lon: ${ll[0].toFixed(5)}`,
              });
              applySelectionStyles(r.id);
            });

            const marker = new mapboxgl.Marker({ element: root, anchor: 'center' }).setLngLat(startLngLat).addTo(map);

            car.style.transform = `rotate(${startBearing}deg)`;

            markers.set(r.id, { marker, root, carEl: car });
            return {
              id: r.id,
              name: r.name,
              robotIdx: idx,
              color: r.color,
              marker,
              root,
              carEl: car,
              speedMps: r.speedMps,
              mission,
              routeA: null,
              routeB: null,
              phase: 'to_pickup',
              active: 'A',
              segIndex: 0,
              segT: 0,
              status: 'to_pickup',
              orderIndex: 0,
              campusPath,
              campusSegIndex: 0,
              campusSegT: 0,
              campusSpeedMps: 1.6,
              campusIdle: campusPath.length < 3,
              lastLngLat: startLngLat,
              lastBearing: startBearing,
              lastTs: 0,
            };
          });

          runtimeRef.current = runtime;

          applySelectionStyles(selectedRobot?.id || null);

          if (modeRef.current === 'city') {
            runtime.forEach((rr) => {
              planRoutesForRobot(rr, areaCenter, null);
            });
          } else {
            try {
              map.flyTo({ center: RNSIT_CENTER, zoom: 17.5, pitch: 65, bearing: -25, essential: true });
            } catch {
              // ignore
            }
          }

          const advanceAlong = (rr, route, metersToAdvance) => {
            let remaining = metersToAdvance;
            while (remaining > 0 && rr.segIndex < route.coords.length - 1) {
              const segLen = route.segLens[rr.segIndex] || 0;
              if (segLen <= 0) {
                rr.segIndex += 1;
                rr.segT = 0;
                continue;
              }
              const segRemaining = segLen * (1 - rr.segT);
              if (remaining < segRemaining) {
                rr.segT += remaining / segLen;
                remaining = 0;
              } else {
                remaining -= segRemaining;
                rr.segIndex += 1;
                rr.segT = 0;
              }
            }

            const i = Math.min(rr.segIndex, route.coords.length - 2);
            const a = route.coords[i];
            const b = route.coords[i + 1] || a;
            const lngLat = interpolateLngLat(a, b, rr.segT);
            const bearing = bearingDeg(a, b);
            const done = rr.segIndex >= route.coords.length - 1 || (rr.segIndex >= route.coords.length - 2 && rr.segT >= 1);
            return { lngLat, bearing, done };
          };

          const animate = (ts) => {
            if (!isMounted) return;
            const liveMap = mapRef.current;
            if (!liveMap) return;

            for (const rr of runtimeRef.current) {
              if (modeRef.current === 'campus') {
                const path = rr.campusPath;
                if (!Array.isArray(path) || path.length < 2) continue;

                if (!rr.lastTs) rr.lastTs = ts;
                const dt = Math.min(0.08, Math.max(0, (ts - rr.lastTs) / 1000));
                rr.lastTs = ts;

                if (rr.campusIdle) {
                  const p = path[0];
                  rr.lastLngLat = p;
                  rr.marker.setLngLat(p);
                  continue;
                }

                let remaining = rr.campusSpeedMps * dt;
                while (remaining > 0 && rr.campusSegIndex < path.length - 1) {
                  const a = path[rr.campusSegIndex];
                  const b = path[rr.campusSegIndex + 1];
                  const segLen = haversineMeters(a, b) || 1;
                  const segRemaining = segLen * (1 - rr.campusSegT);
                  if (remaining < segRemaining) {
                    rr.campusSegT += remaining / segLen;
                    remaining = 0;
                  } else {
                    remaining -= segRemaining;
                    rr.campusSegIndex += 1;
                    rr.campusSegT = 0;
                  }

                  if (rr.campusSegIndex >= path.length - 1) {
                    rr.campusSegIndex = 0;
                    rr.campusSegT = 0;
                  }
                }

                const i = Math.min(rr.campusSegIndex, path.length - 2);
                const a = path[i];
                const b = path[i + 1] || a;
                const lngLat = interpolateLngLat(a, b, rr.campusSegT);
                const bearing = bearingDeg(a, b);
                rr.lastLngLat = lngLat;
                rr.lastBearing = bearing;
                rr.marker.setLngLat(lngLat);
                rr.carEl.style.transform = `rotate(${bearing}deg)`;

                const base = mapRobotsRef.current.find((x) => x.id === rr.id);
                if (base) {
                  base.lon = lngLat[0];
                  base.lat = lngLat[1];
                  base.locText = `Lat: ${lngLat[1].toFixed(5)}, Lon: ${lngLat[0].toFixed(5)}`;
                  base.status = 'campus';
                  base.task = rr.campusIdle ? 'Idle (Campus)' : 'Patrolling (Campus)';
                }
                continue;
              }

              const route = rr.active === 'A' ? rr.routeA : rr.routeB;
              if (!route?.coords || route.coords.length < 2) continue;

              if (!rr.lastTs) rr.lastTs = ts;
              const dt = Math.min(0.08, Math.max(0, (ts - rr.lastTs) / 1000));
              rr.lastTs = ts;

              const metersStep = rr.speedMps * dt;
              const { lngLat, bearing, done } = advanceAlong(rr, route, metersStep);

              rr.lastLngLat = lngLat;
              rr.lastBearing = bearing;
              rr.marker.setLngLat(lngLat);
              rr.carEl.style.transform = `rotate(${bearing}deg)`;

              if (rr.active === 'A') {
                const remainingCoords = [lngLat, ...route.coords.slice(Math.min(rr.segIndex + 1, route.coords.length - 1))];
                setLineData(liveMap, `robot-to-pickup-${rr.id}`, remainingCoords, rr.id, 'toPickup');
                if (rr.routeB?.coords?.length) setLineData(liveMap, `robot-to-drop-${rr.id}`, rr.routeB.coords, rr.id, 'toDrop');
              } else {
                setLineData(liveMap, `robot-to-pickup-${rr.id}`, [], rr.id, 'toPickup');
                const remainingCoords = [lngLat, ...route.coords.slice(Math.min(rr.segIndex + 1, route.coords.length - 1))];
                setLineData(liveMap, `robot-to-drop-${rr.id}`, remainingCoords, rr.id, 'toDrop');
              }

              if (done) {
                if (rr.active === 'A') {
                  rr.active = 'B';
                  rr.phase = 'delivering';
                  rr.status = 'delivering';
                  rr.segIndex = 0;
                  rr.segT = 0;
                  setRouteOpacities(liveMap, rr.id, 0.0, 0.6);

                  if (!rr.routeB?.coords?.length) {
                    rr.active = 'A';
                    rr.phase = 'to_pickup';
                    rr.status = 'to_pickup';
                    setRouteOpacities(liveMap, rr.id, 0.55, 0.35);
                  }
                } else {
                  rr.orderIndex += 1;
                  const nextCenter = selectedAreaRef.current?.center || MAP_CENTER;
                  const startOverride = rr.lastLngLat;
                  rr.active = 'A';
                  rr.phase = 'to_pickup';
                  rr.status = 'to_pickup';
                  rr.segIndex = 0;
                  rr.segT = 0;
                  setRouteOpacities(liveMap, rr.id, 0.55, 0.35);

                  setLineData(liveMap, `robot-to-pickup-${rr.id}`, [], rr.id, 'toPickup');
                  setLineData(liveMap, `robot-to-drop-${rr.id}`, [], rr.id, 'toDrop');

                  planRoutesForRobot(rr, nextCenter, startOverride);
                }
              }

              const base = mapRobotsRef.current.find((x) => x.id === rr.id);
              if (base) {
                base.lon = lngLat[0];
                base.lat = lngLat[1];
                base.locText = `Lat: ${lngLat[1].toFixed(5)}, Lon: ${lngLat[0].toFixed(5)}`;
                base.status = rr.status;
                base.task = rr.status === 'to_pickup' ? 'To pickup' : 'Delivering';
              }
            }

            animationFrameRef.current = requestAnimationFrame(animate);
          };

          animationFrameRef.current = requestAnimationFrame(animate);
        });
      } catch (err) {
        console.error('Map init failed', err);
        hardFail(err?.message || 'Map init failed.');
      }
    };

    destroy();
    setTimeout(() => {
      init();
    }, 100);

    return () => {
      isMounted = false;
      destroy();
    };
  }, [mapRetryKey]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (mapStatus !== 'ready') return;

    const nextMode = isCampusMode ? 'campus' : 'city';
    const nextStyle = nextMode === 'campus' ? CAMPUS_STYLE_URL : CITY_STYLE_URL;

    modeRef.current = nextMode;

    const onStyleError = (evt) => {
      const msg = evt?.error?.message || evt?.message || 'Map style failed to load.';
      console.error('STYLE SWITCH ERROR:', evt);
      if (nextMode === 'campus') setMapError(msg);
    };
    try {
      map.once('error', onStyleError);
    } catch {
      // ignore
    }

    try {
      if (nextMode === 'campus') {
        try {
          directionsAbortRef.current?.abort?.();
        } catch {
          // ignore
        }
        directionsAbortRef.current = null;
      }

      console.log('Switching style:', { nextMode, nextStyle });
      map.setStyle(nextStyle);
    } catch (e) {
      console.error('setStyle failed:', e);
    }

    map.once('style.load', () => {
      const liveMap = mapRef.current;
      if (!liveMap) return;

      try {
        liveMap.off('error', onStyleError);
      } catch {
        // ignore
      }

      try {
        console.log('Current style sprite:', liveMap.getStyle()?.sprite);
      } catch {
        // ignore
      }

      reAddAllMarkers(liveMap);

      if (nextMode === 'campus') {
        console.log('Campus style loaded');
        setMapError('');
        ensureCampus3DBuildings(liveMap);

        runtimeRef.current.forEach((rr) => {
          setRouteOpacities(liveMap, rr.id, 0.0, 0.0);
          rr.routeA = null;
          rr.routeB = null;
          rr.active = 'A';
          rr.phase = 'campus';
          rr.status = 'campus';
          rr.orderIndex = 0;
          rr.segIndex = 0;
          rr.segT = 0;

          rr.campusSegIndex = 0;
          rr.campusSegT = 0;
          const p0 = rr.campusPath?.[0] || RNSIT_CENTER;
          const p1 = rr.campusPath?.[1] || p0;
          rr.lastLngLat = p0;
          rr.lastBearing = bearingDeg(p0, p1);
          try {
            rr.marker.setLngLat(p0);
            rr.carEl.style.transform = `rotate(${rr.lastBearing}deg)`;
          } catch {
            // ignore
          }

          setLineData(liveMap, `robot-to-pickup-${rr.id}`, [], rr.id, 'toPickup');
          setLineData(liveMap, `robot-to-drop-${rr.id}`, [], rr.id, 'toDrop');
        });

        try {
          liveMap.flyTo({ center: RNSIT_CENTER, zoom: 17.5, pitch: 65, bearing: -25, essential: true });
        } catch {
          // ignore
        }
      } else {
        console.log('City style loaded');
        setMapError('');
        ensureCityRouteLayers(liveMap);

        try {
          directionsAbortRef.current?.abort?.();
        } catch {
          // ignore
        }
        directionsAbortRef.current = new AbortController();

        const areaCenter = selectedAreaRef.current?.center || MAP_CENTER;
        const areaZoom = selectedAreaRef.current?.zoom || MAP_ZOOM;

        runtimeRef.current.forEach((rr) => {
          rr.orderIndex = 0;
          rr.phase = 'to_pickup';
          rr.status = 'to_pickup';
          rr.active = 'A';
          rr.segIndex = 0;
          rr.segT = 0;
          rr.lastTs = 0;
          setLineData(liveMap, `robot-to-pickup-${rr.id}`, [], rr.id, 'toPickup');
          setLineData(liveMap, `robot-to-drop-${rr.id}`, [], rr.id, 'toDrop');
          setRouteOpacities(liveMap, rr.id, 0.55, 0.35);
        });

        runtimeRef.current.forEach((rr) => {
          planRoutesForRobot(rr, areaCenter, null);
        });

        try {
          liveMap.flyTo({ center: areaCenter, zoom: areaZoom, pitch: 0, bearing: 0, essential: true });
        } catch {
          // ignore
        }
      }
    });
  }, [campus, isCampusMode, mapStatus]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (mapStatus !== 'ready') return;
    if (isCampusMode) return;
    if (!selectedArea) return;

    try {
      map.flyTo({
        center: selectedArea.center,
        zoom: selectedArea.zoom,
        essential: true,
      });
    } catch {
      // ignore
    }

    try {
      map.resize();
      setTimeout(() => map.resize(), 180);
    } catch {
      // ignore
    }

    try {
      directionsAbortRef.current?.abort?.();
    } catch {
      // ignore
    }
    directionsAbortRef.current = new AbortController();

    const rt = runtimeRef.current;
    rt.forEach((rr) => {
      rr.orderIndex = 0;
      rr.lastTs = 0;
      rr.active = 'A';
      rr.phase = 'to_pickup';
      rr.status = 'to_pickup';
      rr.segIndex = 0;
      rr.segT = 0;

      setLineData(map, `robot-to-pickup-${rr.id}`, [], rr.id, 'toPickup');
      setLineData(map, `robot-to-drop-${rr.id}`, [], rr.id, 'toDrop');
      setRouteOpacities(map, rr.id, 0.55, 0.35);
      planRoutesForRobot(rr, selectedArea.center, null);
    });
  }, [selectedAreaKey, mapStatus]);

  useEffect(() => {
    const decisionInterval = setInterval(() => {
      const list = mapRobotsRef.current;
      if (!list?.length) return;
      const r = list[Math.floor(Math.random() * list.length)];
      setLocalDecision({
        robotId: r.id,
        issue: 'Obstacle detected',
        imageUrl:
          'https://images.unsplash.com/photo-1518770660439-4636190af475?auto=format&fit=crop&q=80&w=800',
        countdown: 10,
        taskId: r.taskId || 'TSK-UNKNOWN',
      });
    }, 60000);

    return () => {
      clearInterval(decisionInterval);
    };
  }, []);

  useEffect(() => {
    applySelectionStyles(selectedRobot?.id || null);
  }, [selectedRobot]);

  useEffect(() => {
    if (!localDecision) return;
    const timer = setTimeout(() => {
      if (localDecision.countdown <= 0) {
        setLocalDecision(null);
        return;
      }
      setLocalDecision((prev) => (prev ? { ...prev, countdown: prev.countdown - 1 } : null));
    }, localDecision.countdown <= 0 ? 0 : 1000);

    return () => clearTimeout(timer);
  }, [localDecision]);

  return (
    <div
      className={
        isFullscreen
          ? 'fixed inset-0 z-50 h-screen w-screen flex flex-col bg-slate-100/50 animate-in fade-in zoom-in-95 duration-200'
          : 'h-full flex flex-col relative bg-slate-100/50'
      }
    >
      <div className="h-16 bg-white border-b border-slate-200 flex items-center justify-between px-4 shrink-0 shadow-sm z-10">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0 flex-wrap">
            <select
              value={country}
              onChange={(e) => handleCountryChange(e.target.value)}
              className="bg-slate-50 border border-slate-200 rounded-lg py-1.5 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all text-slate-900"
            >
              {selectLists.countries.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>

            <select
              value={stateName}
              onChange={(e) => handleStateChange(e.target.value)}
              className="bg-slate-50 border border-slate-200 rounded-lg py-1.5 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all text-slate-900"
            >
              {selectLists.states.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>

            <select
              value={city}
              onChange={(e) => handleCityChange(e.target.value)}
              className="bg-slate-50 border border-slate-200 rounded-lg py-1.5 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all text-slate-900"
            >
              {selectLists.cities.map((ci) => (
                <option key={ci} value={ci}>
                  {ci}
                </option>
              ))}
            </select>

            <select
              value={area}
              onChange={(e) => setArea(e.target.value)}
              className="bg-slate-50 border border-slate-200 rounded-lg py-1.5 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all text-slate-900"
            >
              {selectLists.areas.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>

            <select
              value={campus}
              onChange={(e) => setCampus(e.target.value)}
              className="bg-slate-50 border border-slate-200 rounded-lg py-1.5 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all text-slate-900"
              title="Campus Mode"
            >
              <option value="None">Campus: None</option>
              <option value="RNSIT">Campus: RNSIT</option>
            </select>
          </div>
        </div>

        <div className="flex items-center gap-4 lg:gap-6">
          <button
            type="button"
            onClick={stopAll}
            disabled={!systemOnline}
            className={`px-4 py-2 rounded-lg font-bold tracking-widest text-xs transition-all flex items-center gap-2 ${
              systemOnline
                ? 'bg-rose-600 hover:bg-rose-700 active:bg-rose-800 text-white shadow-sm'
                : 'bg-slate-200 text-slate-400 cursor-not-allowed'
            }`}
          >
            <StopCircle className="w-4 h-4" />
            STOP ALL ROBOTS
          </button>
        </div>
      </div>

      <div className={`flex-1 relative overflow-hidden flex ${isFullscreen ? 'pb-0' : 'pb-4'}`}>
        <div
          className={`flex-1 relative bg-slate-900 overflow-hidden cursor-crosshair min-h-0 ${
            isFullscreen ? 'rounded-none' : 'rounded-xl'
          }`}
        >
          <div className="absolute top-3 right-3 z-20">
            <Button
              type="button"
              variant="secondary"
              size="icon"
              onClick={toggleFullscreen}
              aria-label={isFullscreen ? 'Exit fullscreen map' : 'Enter fullscreen map'}
              className="h-9 w-9 shadow-sm"
            >
              {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </Button>
          </div>
          <div className="absolute inset-0">
            <div className="w-full h-full relative">
              {isCampusMode ? <CampusMap /> : <FleetDbMap center={selectedArea?.center} />}
            </div>
          </div>

          {mapStatus !== 'ready' && (
            <div className="absolute inset-0 z-10 flex items-center justify-center p-6 pointer-events-none">
              <div className="bg-white/90 border border-slate-200 rounded-xl shadow-sm px-5 py-4 text-center max-w-sm w-full backdrop-blur pointer-events-auto">
                <div className="text-sm font-bold text-slate-900">{mapStatus === 'error' ? 'Map unavailable' : 'Loading map…'}</div>
                <div className="text-xs text-slate-600 mt-1">
                  {mapStatus === 'error'
                    ? mapError || 'Map style/tiles failed to load.'
                    : 'If this stays blank, check your network (tile URLs).'}
                </div>
                <div className="mt-4 flex gap-2">
                  <button
                    type="button"
                    onClick={() => navigate('/robots')}
                    className="flex-1 bg-slate-900 hover:bg-slate-800 text-white py-2 rounded-lg text-xs font-bold transition-colors"
                  >
                    Open Robots
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      mapRef.current?.remove();
                      mapRef.current = null;
                      setMapStatus('idle');
                      setMapRetryKey((k) => k + 1);
                    }}
                    className="flex-1 bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 py-2 rounded-lg text-xs font-bold transition-colors"
                  >
                    Retry
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {selectedRobot && (
          <div className="absolute inset-0 bg-slate-900/10 backdrop-blur-[1px] z-20 md:hidden" onClick={() => setSelectedRobot(null)} />
        )}

        <div
          className={`absolute top-0 right-0 bottom-0 w-full md:w-96 bg-white border-l border-slate-200 shadow-2xl transform transition-transform duration-300 ease-in-out flex flex-col z-30 ${
            selectedRobot ? 'translate-x-0' : 'translate-x-full'
          }`}
        >
          {selectedRobot && (
            <>
              <div className="p-4 border-b border-slate-200 flex justify-between items-center bg-slate-50">
                <div className="flex items-center gap-3">
                  <div className="font-mono text-xl font-bold text-slate-900">{selectedRobot.id}</div>
                  <span
                    className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                      ['active', 'delivering'].includes(String(selectedRobot.status).toLowerCase())
                        ? 'bg-emerald-100 text-emerald-700'
                        : ['idle', 'to_pickup'].includes(String(selectedRobot.status).toLowerCase())
                          ? 'bg-amber-100 text-amber-700'
                          : 'bg-rose-100 text-rose-700'
                    }`}
                  >
                    {selectedRobot.status}
                  </span>
                </div>
                <button onClick={() => setSelectedRobot(null)} className="p-1.5 hover:bg-slate-200 rounded-md text-slate-500 transition-colors">
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-5 space-y-6">
                <div className="grid grid-cols-3 gap-2">
                  <button
                    onClick={() => requestAuth(`STOP UNIT ${selectedRobot.id}`, () => {})}
                    className="bg-rose-50 text-rose-700 hover:bg-rose-100 border border-rose-100 p-3 rounded-xl flex flex-col items-center gap-1.5 text-xs font-bold transition-colors"
                  >
                    <StopCircle className="w-5 h-5" /> STOP
                  </button>
                  <button
                    onClick={() => requestAuth(`PAUSE UNIT ${selectedRobot.id}`, () => {})}
                    className="bg-amber-50 text-amber-700 hover:bg-amber-100 border border-amber-100 p-3 rounded-xl flex flex-col items-center gap-1.5 text-xs font-bold transition-colors"
                  >
                    <Pause className="w-5 h-5" /> PAUSE
                  </button>
                  <button
                    onClick={() => requestAuth(`RETURN UNIT ${selectedRobot.id}`, () => {})}
                    className="bg-blue-50 text-blue-700 hover:bg-blue-100 border border-blue-100 p-3 rounded-xl flex flex-col items-center gap-1.5 text-xs font-bold transition-colors"
                  >
                    <RefreshCw className="w-5 h-5" /> RETURN
                  </button>
                </div>

                {selectedRobot?.id?.startsWith('RBT-') && (
                  <button
                    onClick={() => {
                      retire(selectedRobot.id);
                      setSelectedRobot(null);
                    }}
                    className="w-full bg-rose-600 hover:bg-rose-700 text-white py-2.5 rounded-xl font-bold transition-colors shadow-sm flex items-center justify-center gap-2 text-sm"
                    title="Permanently Remove Unit"
                  >
                    <Trash2 className="w-4 h-4" /> Retire Unit
                  </button>
                )}

                <div className="h-px bg-slate-100 w-full" />

                <div>
                  <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-3">Live State</h3>
                  <div className="bg-slate-50 rounded-xl border border-slate-200 p-4 space-y-3 text-sm shadow-sm">
                    <div className="flex justify-between items-center">
                      <span className="text-slate-500 font-medium">Battery</span>
                      <div className="flex items-center gap-3">
                        <div className="w-24 h-2 bg-slate-200 rounded-full overflow-hidden">
                          <div
                            className={`h-full ${selectedRobot.battery < 25 ? 'bg-rose-500' : 'bg-emerald-500'}`}
                            style={{ width: `${selectedRobot.battery}%` }}
                          />
                        </div>
                        <span className="font-mono font-bold w-9 text-right text-slate-700">{selectedRobot.battery.toFixed(0)}%</span>
                      </div>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-slate-500 font-medium">Speed</span>
                      <span className="font-mono font-bold text-slate-700">{selectedRobot.speed} m/s</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-slate-500 font-medium">Task</span>
                      <span className="font-mono font-bold text-blue-600">{selectedRobot.task || 'None'}</span>
                    </div>
                  </div>
                </div>

                {selectedRobot.issue && (
                  <div>
                    <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-3">Warnings</h3>
                    <div className="bg-rose-50 border border-rose-200 rounded-xl p-3 flex items-start gap-2 text-sm text-rose-700 font-medium">
                      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                      <span>{selectedRobot.issue}</span>
                    </div>
                  </div>
                )}
              </div>

              <div className="p-4 border-t border-slate-200 bg-white">
                <button
                  type="button"
                  onClick={() => navigate('/robots')}
                  className="w-full bg-slate-900 hover:bg-slate-800 text-white py-3 rounded-xl font-bold transition-all shadow-sm hover:shadow-md flex items-center justify-center gap-2 text-sm"
                >
                  Open Robots <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            </>
          )}
        </div>

        {localDecision && (
          <div className="absolute inset-0 z-40 flex items-center justify-center p-4 animate-in fade-in duration-200">
            <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" onClick={() => setLocalDecision(null)} />
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md relative z-10 overflow-hidden border border-slate-200 animate-in zoom-in-95 duration-200">
              <div className="bg-amber-50 border-b border-amber-100 p-4 flex justify-between items-center">
                <div className="flex items-center gap-2 text-amber-700">
                  <AlertTriangle className="w-5 h-5" />
                  <h2 className="font-bold tracking-wide">DECISION REQUIRED</h2>
                </div>
                <div className="text-xl font-mono font-bold text-amber-600 bg-white px-2 py-1 rounded shadow-sm border border-amber-100">
                  00:{localDecision.countdown.toString().padStart(2, '0')}
                </div>
              </div>

              <div className="p-6 space-y-5">
                <div className="grid grid-cols-2 gap-4 text-sm bg-slate-50 p-3 rounded-lg border border-slate-100">
                  <div>
                    <span className="text-slate-500 block text-xs uppercase mb-0.5">Robot ID</span>
                    <span className="font-mono font-bold text-slate-900">{localDecision.robotId}</span>
                  </div>
                  <div>
                    <span className="text-slate-500 block text-xs uppercase mb-0.5">Task ID</span>
                    <span className="font-mono font-bold text-slate-900">{localDecision.taskId}</span>
                  </div>
                </div>

                <div>
                  <span className="text-slate-700 font-semibold block mb-2 text-sm">{localDecision.issue}</span>
                  <div className="relative h-40 bg-slate-900 rounded-lg overflow-hidden group border border-slate-200 shadow-inner">
                    <div
                      className="absolute inset-0 bg-cover bg-center opacity-80 mix-blend-luminosity"
                      style={{ backgroundImage: `url(${localDecision.imageUrl})` }}
                    ></div>
                  </div>
                </div>

                <div className="flex gap-3 pt-2">
                  <button
                    onClick={() => setLocalDecision(null)}
                    className="flex-1 bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 py-2.5 rounded-lg text-sm font-semibold transition-colors shadow-sm"
                  >
                    WAIT
                  </button>
                  <button
                    onClick={() => requestAuth('SWARM OVERRIDE: REROUTE', () => setLocalDecision(null))}
                    className="flex-1 bg-amber-500 hover:bg-amber-600 text-white py-2.5 rounded-lg text-sm font-semibold transition-colors shadow-sm"
                  >
                    REROUTE
                  </button>
                  <button
                    onClick={() => requestAuth('SWARM OVERRIDE: CANCEL TASK', () => setLocalDecision(null))}
                    className="flex-1 bg-slate-900 hover:bg-slate-800 text-white py-2.5 rounded-lg text-sm font-semibold transition-colors shadow-sm"
                  >
                    CANCEL
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
