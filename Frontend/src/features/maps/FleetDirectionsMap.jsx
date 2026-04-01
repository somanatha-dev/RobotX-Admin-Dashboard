import React, { useEffect, useMemo, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { socket } from "../../lib/socket";
import { clamp, haversineMeters, interpolateLngLat } from "../../lib/geo";

const MAP_STYLE = "mapbox://styles/mapbox/dark-v11";

// Rajarajeshwari Nagar, Bengaluru (approx)
const RR_NAGAR_CENTER = [77.5199, 12.9256];
const CITY_ZOOM = 14;

// Area bounds used to restrict which robots render.
// Format: [SW, NE] where each is [lng, lat]
const AREA_BOUNDS = {
  "RR Nagar": [
    [77.5, 12.9],
    [77.54, 12.94],
  ],
};

const ROBOTS = [
  { id: "R1", name: "Robot R1", color: "#06b6d4", speedMps: 7.5 },
  { id: "R2", name: "Robot R2", color: "#a78bfa", speedMps: 7.0 },
  { id: "R3", name: "Robot R3", color: "#34d399", speedMps: 6.8 },
];

// Icon IDs registered in Mapbox.
// Keep these exact names so per-robot coloring is data-driven.
const TRUCK_ICONS = [
  { id: "truck-blue", color: "#3b82f6" },
  { id: "truck-green", color: "#22c55e" },
  { id: "truck-red", color: "#ef4444" },
];

// Fixed, real coordinates inside each supported area.
// No random movement, no offsets, no drifting.
const AREA_MISSIONS = {
  "RR Nagar": {
    starts: [
      [77.5142, 12.9287],
      [77.5167, 12.9269],
      [77.5128, 12.9276],
    ],
    pickups: [
      [77.5176, 12.9275],
      [77.5157, 12.9295],
      [77.5182, 12.9283],
      [77.5149, 12.9293],
      [77.516, 12.9294],
    ],
    drops: [
      [77.5164, 12.93],
      [77.5136, 12.9269],
      [77.5174, 12.9282],
      [77.515, 12.9272],
      [77.5169, 12.929],
    ],
  },
};

function degToRad(d) {
  return (d * Math.PI) / 180;
}

function radToDeg(r) {
  return (r * 180) / Math.PI;
}

function bearingDeg(a, b) {
  const lat1 = degToRad(a[1]);
  const lat2 = degToRad(b[1]);
  const dLon = degToRad(b[0] - a[0]);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  const brng = radToDeg(Math.atan2(y, x));
  return (brng + 360) % 360;
}

function isInsideBounds(lngLat, bounds) {
  if (!bounds || !lngLat) return false;
  const sw = bounds[0];
  const ne = bounds[1];
  return lngLat[0] >= sw[0] && lngLat[0] <= ne[0] && lngLat[1] >= sw[1] && lngLat[1] <= ne[1];
}

function pickFrom(arr, idx) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr[((idx % arr.length) + arr.length) % arr.length];
}

function buildMissionPoints(areaKey, robotIdx, orderIdx, startOverride) {
  const catalog = AREA_MISSIONS?.[areaKey];
  if (!catalog) return null;

  const start = startOverride || pickFrom(catalog.starts, robotIdx) || pickFrom(catalog.starts, 0);
  const pickup = pickFrom(catalog.pickups, robotIdx + orderIdx) || pickFrom(catalog.pickups, 0);
  const drop = pickFrom(catalog.drops, robotIdx * 2 + orderIdx) || pickFrom(catalog.drops, 0);
  if (!start || !pickup || !drop) return null;
  return { start, pickup, drop };
}

function toRouteKey(fromLngLat, toLngLat) {
  const f0 = Number(fromLngLat[0]).toFixed(5);
  const f1 = Number(fromLngLat[1]).toFixed(5);
  const t0 = Number(toLngLat[0]).toFixed(5);
  const t1 = Number(toLngLat[1]).toFixed(5);
  return `${f0},${f1};${t0},${t1}`;
}

function buildRouteData(coords) {
  const safe = Array.isArray(coords) ? coords : [];
  const segLens = [];
  const cum = [0];
  let totalLen = 0;
  for (let i = 0; i < safe.length - 1; i++) {
    const len = haversineMeters(safe[i], safe[i + 1]);
    const l = Number.isFinite(len) ? len : 0;
    segLens.push(l);
    totalLen += l;
    cum.push(totalLen);
  }
  return { coords: safe, segLens, cum, totalLen };
}

async function fetchDirectionsRoute({ fromLngLat, toLngLat, accessToken, signal }) {
  const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${fromLngLat[0]},${fromLngLat[1]};${toLngLat[0]},${toLngLat[1]}?geometries=geojson&overview=full&access_token=${accessToken}`;
  const res = await fetch(url, { signal });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Directions API failed (${res.status}): ${text || res.statusText}`);
  }
  const json = await res.json();
  const route = json?.routes?.[0];
  const coords = route?.geometry?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) throw new Error("Directions API returned no route geometry.");
  return buildRouteData(coords);
}

async function getRouteCached({ cache, fromLngLat, toLngLat, accessToken, signal }) {
  const key = toRouteKey(fromLngLat, toLngLat);
  const existing = cache.get(key);
  if (existing?.status === "ready") return existing.data;
  if (existing?.status === "pending") return existing.promise;

  const promise = fetchDirectionsRoute({ fromLngLat, toLngLat, accessToken, signal }).then((data) => {
    cache.set(key, { status: "ready", data });
    return data;
  });
  cache.set(key, { status: "pending", promise });
  return promise;
}

export default function FleetDirectionsMap({ area, center }) {
  const [robots, setRobots] = useState({});
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const runtimeRef = useRef([]);
  const rafRef = useRef(null);
  const abortRef = useRef(null);
  const routeCacheRef = useRef(new Map());
  const missionMarkersRef = useRef(new Map());
  const followRobotIdRef = useRef(null);
  const [followRobotId, setFollowRobotId] = useState(null);

  useEffect(() => {
    socket.on("robot_update", (data) => {
      setRobots((prev) => ({
        ...prev,
        [data.robotId]: data,
      }));
    });

    return () => socket.off("robot_update");
  }, []);

  console.log(robots);
  useEffect(() => {
    followRobotIdRef.current = followRobotId;
  }, [followRobotId]);

  const areaKey = typeof area === "string" ? area.trim() : "";
  const activeBounds = AREA_BOUNDS?.[areaKey] || null;
  const areaCenter = useMemo(() => center || RR_NAGAR_CENTER, [center]);

  const clampLngLatToBounds = (lngLat) => {
    if (!activeBounds) return lngLat;
    const sw = activeBounds[0];
    const ne = activeBounds[1];
    return [clamp(lngLat[0], sw[0], ne[0]), clamp(lngLat[1], sw[1], ne[1])];
  };

  const routeIsInsideBounds = (routeData) => {
    if (!activeBounds) return true;
    const sw = activeBounds[0];
    const ne = activeBounds[1];
    const coords = routeData?.coords || [];
    for (const p of coords) {
      if (!p) continue;
      const lng = p[0];
      const lat = p[1];
      if (lng < sw[0] || lng > ne[0] || lat < sw[1] || lat > ne[1]) return false;
    }
    return true;
  };

  const getPositionAlongRoute = (route, distanceMeters) => {
    const coords = route?.coords || [];
    const cum = route?.cum || [];
    if (coords.length < 2 || cum.length < 2) {
      return { lngLat: coords[0] || areaCenter, bearing: 0, done: true, segIdx: 0 };
    }

    const total = route.totalLen || 0;
    const d = Math.max(0, distanceMeters);
    if (d >= total) {
      const a = coords[coords.length - 2];
      const b = coords[coords.length - 1];
      const bearing = bearingDeg(a, b);
      return { lngLat: b, bearing, done: true, segIdx: Math.max(0, coords.length - 2) };
    }

    let segIdx = 0;
    while (segIdx < cum.length - 2 && cum[segIdx + 1] < d) segIdx += 1;

    const segStartDist = cum[segIdx] || 0;
    const segLen = route.segLens?.[segIdx] || 1;
    const t = clamp((d - segStartDist) / (segLen || 1), 0, 1);
    const a = coords[segIdx];
    const b = coords[segIdx + 1] || a;
    const lngLat = interpolateLngLat(a, b, t);
    const bearing = bearingDeg(a, b);

    return { lngLat, bearing, done: false, segIdx };
  };

  const removeMissionMarkers = (robotId) => {
    const entry = missionMarkersRef.current.get(robotId);
    if (!entry) return;
    try {
      entry.pickup?.remove?.();
    } catch {
      // ignore
    }
    try {
      entry.drop?.remove?.();
    } catch {
      // ignore
    }
    missionMarkersRef.current.delete(robotId);
  };

  const createPickupMarkerEl = () => {
    const pickupEl = document.createElement("div");
    pickupEl.style.width = "14px";
    pickupEl.style.height = "14px";
    pickupEl.style.background = "#facc15";
    pickupEl.style.border = "2px solid #000";
    pickupEl.style.borderRadius = "50%";
    pickupEl.title = "Pickup Location";
    return pickupEl;
  };

  const createDropMarkerEl = () => {
    const dropEl = document.createElement("div");
    dropEl.style.width = "16px";
    dropEl.style.height = "16px";
    dropEl.style.background = "#ef4444";
    dropEl.style.borderRadius = "50%";
    dropEl.style.boxShadow = "0 0 0 2px white";
    dropEl.title = "Drop Location";
    return dropEl;
  };

  const upsertMissionMarkers = (rr) => {
    const map = mapRef.current;
    if (!map) return;
    if (!rr?.mission?.pickup || !rr?.mission?.drop) return;

    let entry = missionMarkersRef.current.get(rr.id);
    if (!entry) {
      const pickup = new mapboxgl.Marker(createPickupMarkerEl())
        .setLngLat(rr.mission.pickup)
        .addTo(map);
      const drop = new mapboxgl.Marker(createDropMarkerEl())
        .setLngLat(rr.mission.drop)
        .addTo(map);
      entry = { pickup, drop };
      missionMarkersRef.current.set(rr.id, entry);
      return;
    }

    try {
      entry.pickup?.setLngLat?.(rr.mission.pickup);
    } catch {
      // ignore
    }
    try {
      entry.drop?.setLngLat?.(rr.mission.drop);
    } catch {
      // ignore
    }
  };

  const ensureTruckIcons = (map, baseImage) => {
    // baseImage comes from map.loadImage and can be HTMLImageElement or ImageBitmap.
    // We register multiple tinted variants and store the chosen icon name in each robot feature.
    const createTinted = (img, tint) => {
      const w = img?.width || 64;
      const h = img?.height || 64;
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      ctx.globalCompositeOperation = "source-atop";
      ctx.fillStyle = tint;
      ctx.fillRect(0, 0, w, h);
      const imageData = ctx.getImageData(0, 0, w, h);
      return { width: w, height: h, data: new Uint8Array(imageData.data.buffer) };
    };

    const addIfMissing = (id, data) => {
      if (!data) return;
      if (map.hasImage(id)) return;
      map.addImage(id, data);
    };

    // Ensure a base icon exists as well (kept for compatibility).
    if (!map.hasImage("truck-icon") && baseImage) {
      try {
        map.addImage("truck-icon", baseImage);
      } catch {
        // ignore
      }
    }

    for (const icon of TRUCK_ICONS) {
      try {
        const tinted = createTinted(baseImage, icon.color);
        addIfMissing(icon.id, tinted);
      } catch {
        // ignore
      }
    }
  };

  const addFallbackTruckIcons = (map) => {
    if (TRUCK_ICONS.every((x) => map.hasImage(x.id))) return;

    const size = 64;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = "rgba(0,0,0,0)";
    ctx.fillRect(0, 0, size, size);

    // simple truck silhouette (original, non-copyright)
    ctx.fillStyle = "#e5e7eb";
    ctx.strokeStyle = "#111827";
    ctx.lineWidth = 3;

    // trailer
    ctx.beginPath();
    ctx.rect(22, 18, 20, 28);
    ctx.fill();
    ctx.stroke();

    // cab
    ctx.beginPath();
    ctx.rect(22, 6, 20, 12);
    ctx.fill();
    ctx.stroke();

    // wheels
    ctx.fillStyle = "#111827";
    ctx.beginPath();
    ctx.arc(26, 50, 5, 0, Math.PI * 2);
    ctx.arc(38, 50, 5, 0, Math.PI * 2);
    ctx.fill();

    const base = ctx.getImageData(0, 0, size, size);
    try {
      if (!map.hasImage("truck-icon")) {
        map.addImage(
          "truck-icon",
          { width: size, height: size, data: new Uint8Array(base.data.buffer) },
          { pixelRatio: 2 }
        );
      }
    } catch {
      // ignore
    }

    const tint = (hex) => {
      const c = document.createElement("canvas");
      c.width = size;
      c.height = size;
      const cctx = c.getContext("2d");
      if (!cctx) return null;
      cctx.putImageData(base, 0, 0);
      cctx.globalCompositeOperation = "source-atop";
      cctx.fillStyle = hex;
      cctx.fillRect(0, 0, size, size);
      const d = cctx.getImageData(0, 0, size, size);
      return { width: size, height: size, data: new Uint8Array(d.data.buffer) };
    };

    for (const icon of TRUCK_ICONS) {
      try {
        if (!map.hasImage(icon.id)) map.addImage(icon.id, tint(icon.color), { pixelRatio: 2 });
      } catch {
        // ignore
      }
    }
  };

  useEffect(() => {
    let mounted = true;

    const hardFail = (msg) => {
      if (!mounted) return;
      setError(String(msg || "Map failed"));
      setStatus("error");
    };

    const destroy = () => {
      try {
        abortRef.current?.abort?.();
      } catch {
        // ignore
      }
      abortRef.current = null;

      try {
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
      } catch {
        // ignore
      }
      rafRef.current = null;

      try {
        mapRef.current?.remove?.();
      } catch {
        // ignore
      }
      mapRef.current = null;

      try {
        for (const [id] of missionMarkersRef.current) removeMissionMarkers(id);
      } catch {
        // ignore
      }
      missionMarkersRef.current.clear();

      runtimeRef.current = [];
    };

    const planRoutesForRobot = async (rr, startOverride) => {
      const map = mapRef.current;
      const accessToken = import.meta.env.VITE_MAPBOX_TOKEN;
      if (!map) return;
      if (!accessToken) {
        hardFail("VITE_MAPBOX_TOKEN is missing.");
        return;
      }
      const abortController = abortRef.current;
      if (!abortController) return;

      // If area is not supported, don't plan any routes.
      if (!activeBounds) return;

      // Ensure mission points stay inside the selected area's bounds.
      const mission0 = buildMissionPoints(areaKey, rr.robotIdx, rr.orderIndex, startOverride);
      if (!mission0) return;
      const mission = {
        start: clampLngLatToBounds(mission0.start),
        pickup: clampLngLatToBounds(mission0.pickup),
        drop: clampLngLatToBounds(mission0.drop),
      };
      rr.mission = mission;
      upsertMissionMarkers(rr);
      rr.phase = "to_pickup";
      rr.active = "A";
      rr.distance = 0;
      rr.status = "to_pickup";
      rr.routeA = null;
      rr.routeB = null;
      rr.routeToPickup = null;
      rr.routeToDrop = null;

      try {
        const cache = routeCacheRef.current;
        // Try a few target combos until we get routes that stay inside the area.
        let routeA = null;
        let routeB = null;
        let planned = false;
        for (let attempt = 0; attempt < 4; attempt++) {
          const m0 = buildMissionPoints(areaKey, rr.robotIdx, rr.orderIndex + attempt, startOverride);
          if (!m0) return;
          const m = {
            start: clampLngLatToBounds(m0.start),
            pickup: clampLngLatToBounds(m0.pickup),
            drop: clampLngLatToBounds(m0.drop),
          };

          const [a, b] = await Promise.all([
            getRouteCached({
              cache,
              fromLngLat: m.start,
              toLngLat: m.pickup,
              accessToken,
              signal: abortController.signal,
            }),
            getRouteCached({
              cache,
              fromLngLat: m.pickup,
              toLngLat: m.drop,
              accessToken,
              signal: abortController.signal,
            }),
          ]);
          if (abortController.signal.aborted) return;

          if (routeIsInsideBounds(a) && routeIsInsideBounds(b)) {
            rr.mission = m;
            upsertMissionMarkers(rr);
            routeA = a;
            routeB = b;
            planned = true;
            break;
          }
        }

        if (!planned || !routeA || !routeB) return;
        if (abortController.signal.aborted) return;

        rr.routeA = routeA;
        rr.routeB = routeB;
        rr.routeToPickup = routeA;
        rr.routeToDrop = routeB;

        const pickupSourceId = `route-to-pickup-${rr.id}`;
        const dropSourceId = `route-to-drop-${rr.id}`;

        map.getSource(pickupSourceId)?.setData({
          type: "Feature",
          geometry: { type: "LineString", coordinates: routeA.coords },
          properties: { id: rr.id, kind: "toPickup" },
        });
        map.getSource(dropSourceId)?.setData({
          type: "Feature",
          geometry: { type: "LineString", coordinates: routeB.coords },
          properties: { id: rr.id, kind: "toDrop" },
        });

        rr.state = "TO_PICKUP";
        rr.lastLngLat = routeA.coords[0];
        rr.lastBearing = bearingDeg(routeA.coords[0], routeA.coords[1]);
        rr.lastAngleRad = getPositionAlongRoute(routeA, 0).angleRad;
        rr.isVisible = isInsideBounds(rr.lastLngLat, activeBounds);
      } catch (e) {
        if (abortController.signal.aborted) return;
        console.error("Directions planning failed", rr.id, e);
      }
    };

    const init = async () => {
      if (!mounted) return;
      if (!mapContainerRef.current) {
        hardFail("Map container missing");
        return;
      }

      const token = import.meta.env.VITE_MAPBOX_TOKEN;
      if (!token) {
        hardFail("VITE_MAPBOX_TOKEN is missing.");
        return;
      }

      setStatus("loading");
      setError("");

      mapboxgl.accessToken = token;

      abortRef.current?.abort?.();
      abortRef.current = new AbortController();

      const map = new mapboxgl.Map({
        container: mapContainerRef.current,
        style: MAP_STYLE,
        center: areaCenter,
        zoom: CITY_ZOOM,
        pitch: 0,
        antialias: true,
      });

      mapRef.current = map;

      map.on("error", (e) => {
        console.error("MAPBOX ERROR:", e);
      });

      map.on("load", () => {
        if (!mounted) return;

        // sources/layers
        ROBOTS.forEach((r) => {
          const pickupSourceId = `route-to-pickup-${r.id}`;
          const dropSourceId = `route-to-drop-${r.id}`;

          if (!map.getSource(pickupSourceId)) {
            map.addSource(pickupSourceId, {
              type: "geojson",
              data: { type: "Feature", geometry: { type: "LineString", coordinates: [] }, properties: {} },
            });
          }
          if (!map.getSource(dropSourceId)) {
            map.addSource(dropSourceId, {
              type: "geojson",
              data: { type: "Feature", geometry: { type: "LineString", coordinates: [] }, properties: {} },
            });
          }

          const pickupLayerId = `route-to-pickup-layer-${r.id}`;
          const dropLayerId = `route-to-drop-layer-${r.id}`;

          if (!map.getLayer(pickupLayerId)) {
            map.addLayer({
              id: pickupLayerId,
              type: "line",
              source: pickupSourceId,
              layout: { "line-join": "round", "line-cap": "round" },
              paint: {
                "line-color": "#facc15", // yellow
                "line-width": 5,
                "line-opacity": 0.9,
                "line-dasharray": [2, 2],
              },
            });
          }

          if (!map.getLayer(dropLayerId)) {
            map.addLayer({
              id: dropLayerId,
              type: "line",
              source: dropSourceId,
              layout: { "line-join": "round", "line-cap": "round" },
              paint: {
                "line-color": "#22c55e", // green
                "line-width": 5,
                "line-opacity": 0.9,
              },
            });
          }
        });

        // If selected area isn't supported, show the map but render no robots.
        if (!activeBounds) {
          setStatus("ready");
          return;
        }

        // runtime (robots)
        const runtime = ROBOTS.map((r, idx) => {
          const m0 = buildMissionPoints(areaKey, idx, 0, null);
          const start = clampLngLatToBounds(m0?.start || areaCenter);

          const iconId = TRUCK_ICONS[idx % TRUCK_ICONS.length]?.id || "truck-blue";

          return {
            id: r.id,
            name: r.name,
            robotIdx: idx,
            color: r.color,
            icon: iconId,
            speedMps: r.speedMps,
            orderIndex: 0,
            mission: null,
            routeA: null,
            routeB: null,
            routeToPickup: null,
            routeToDrop: null,
            phase: "to_pickup",
            active: "A",
            distance: 0,
            lastTs: 0,
            lastLngLat: start,
            lastBearing: 0,
            bearing: 0,
            isVisible: true,
            status: "to_pickup",
          };
        });

        runtimeRef.current = runtime;

        // 2D Uber-style vehicles (GeoJSON + Symbol layer)
        try {
          if (!map.getSource("robots")) {
            map.addSource("robots", {
              type: "geojson",
              data: { type: "FeatureCollection", features: [] },
            });
          }

          const ensureRobotsLayer = () => {
            if (!TRUCK_ICONS.some((x) => map.hasImage(x.id)) && !map.hasImage("truck-icon")) return;
            if (map.getLayer("robots-layer")) return;

            map.addLayer({
              id: "robots-layer",
              type: "symbol",
              source: "robots",
              layout: {
                "icon-image": ["get", "icon"],
                "icon-size": [
                  "interpolate",
                  ["linear"],
                  ["zoom"],
                  12,
                  0.12,
                  16,
                  0.18,
                  18,
                  0.28,
                  20,
                  0.45,
                ],
                "icon-rotate": ["get", "bearing"],
                "icon-rotation-alignment": "map",
                "icon-pitch-alignment": "map",
                "icon-allow-overlap": true,
                "icon-ignore-placement": true,
              },
            });

            map.on("click", "robots-layer", (e) => {
              const id = e?.features?.[0]?.properties?.id;
              if (!id) return;
              setFollowRobotId((prev) => (prev === id ? null : id));
            });

            map.on("mouseenter", "robots-layer", () => {
              try {
                map.getCanvas().style.cursor = "pointer";
              } catch {
                // ignore
              }
            });
            map.on("mouseleave", "robots-layer", () => {
              try {
                map.getCanvas().style.cursor = "";
              } catch {
                // ignore
              }
            });
          };

          map.loadImage("/icons/truck.png", (err, image) => {
            try {
              if (!err && image) ensureTruckIcons(map, image);
            } catch {
              // ignore
            }

            addFallbackTruckIcons(map);
            ensureRobotsLayer();
          });
        } catch (e) {
          console.error("2D ROBOTS LAYER ERROR:", e);
        }

        // plan routes
        runtime.forEach((rr) => planRoutesForRobot(rr, rr.lastLngLat));

        setStatus("ready");

        const animate = (ts) => {
          if (!mounted) return;
          const liveMap = mapRef.current;
          if (!liveMap) return;

          for (const rr of runtimeRef.current) {
            const route = rr.active === "A" ? rr.routeA : rr.routeB;
            if (!route?.coords || route.coords.length < 2) continue;

            if (!rr.lastTs) rr.lastTs = ts;
            const dt = clamp((ts - rr.lastTs) / 1000, 0, 0.08);
            rr.lastTs = ts;

            rr.distance = (rr.distance || 0) + rr.speedMps * dt;
            const pos = getPositionAlongRoute(route, rr.distance);
            rr.lastLngLat = pos.lngLat;
            rr.lastBearing = pos.bearing;
            rr.isVisible = isInsideBounds(rr.lastLngLat, activeBounds);

            // bearing for 2D icon rotation
            try {
              const current = pos.lngLat;
              const next = route.coords[Math.min(pos.segIdx + 1, route.coords.length - 1)] || current;
              const dx = next[0] - current[0];
              const dy = next[1] - current[1];
              const angle = Math.atan2(dy, dx);
              const deg = (angle * 180) / Math.PI;
              rr.bearing = Number.isFinite(deg) ? deg : 0;
            } catch {
              rr.bearing = rr.bearing || 0;
            }

            if (!rr.isVisible) {
              // Hide both route lines and robot if it ever exits bounds.
              removeMissionMarkers(rr.id);
              liveMap.getSource(`route-to-pickup-${rr.id}`)?.setData({
                type: "Feature",
                geometry: { type: "LineString", coordinates: [] },
                properties: { id: rr.id, kind: "toPickup" },
              });
              liveMap.getSource(`route-to-drop-${rr.id}`)?.setData({
                type: "Feature",
                geometry: { type: "LineString", coordinates: [] },
                properties: { id: rr.id, kind: "toDrop" },
              });
              continue;
            }

            // update remaining geometry
            if (rr.active === "A") {
              const rem = [pos.lngLat, ...route.coords.slice(Math.min(pos.segIdx + 1, route.coords.length - 1))];
              liveMap.getSource(`route-to-pickup-${rr.id}`)?.setData({
                type: "Feature",
                geometry: { type: "LineString", coordinates: rem },
                properties: { id: rr.id, kind: "toPickup" },
              });
            } else {
              const rem = [pos.lngLat, ...route.coords.slice(Math.min(pos.segIdx + 1, route.coords.length - 1))];
              liveMap.getSource(`route-to-drop-${rr.id}`)?.setData({
                type: "Feature",
                geometry: { type: "LineString", coordinates: rem },
                properties: { id: rr.id, kind: "toDrop" },
              });
            }

            if (pos.done) {
              if (rr.active === "A") {
                rr.active = "B";
                rr.state = "TO_DESTINATION";
                rr.phase = "delivering";
                rr.status = "delivering";
                rr.distance = 0;
              } else {
                rr.orderIndex += 1;
                rr.active = "A";
                rr.state = "TO_PICKUP";
                rr.phase = "to_pickup";
                rr.status = "to_pickup";
                rr.distance = 0;

                // clear sources immediately then re-plan
                liveMap.getSource(`route-to-pickup-${rr.id}`)?.setData({
                  type: "Feature",
                  geometry: { type: "LineString", coordinates: [] },
                  properties: { id: rr.id, kind: "toPickup" },
                });
                liveMap.getSource(`route-to-drop-${rr.id}`)?.setData({
                  type: "Feature",
                  geometry: { type: "LineString", coordinates: [] },
                  properties: { id: rr.id, kind: "toDrop" },
                });

                planRoutesForRobot(rr, rr.lastLngLat);
              }
            }
          }

          // Push 2D robot + mission features
          try {
            const fleet = runtimeRef.current || [];
            const robotsFeatures = fleet
              .filter((rr) => rr.isVisible !== false && rr.lastLngLat)
              .map((rr) => ({
                type: "Feature",
                geometry: { type: "Point", coordinates: rr.lastLngLat },
                properties: { id: rr.id, bearing: rr.bearing || 0, icon: rr.icon || "truck-blue" },
              }));

            liveMap.getSource("robots")?.setData({
              type: "FeatureCollection",
              features: robotsFeatures,
            });

          } catch {
            // ignore
          }

          // Camera follow (throttled)
          try {
            const id = followRobotIdRef.current;
            if (id) {
              const rr = runtimeRef.current.find((x) => x.id === id);
              if (rr?.lastLngLat) {
                if (!animate._lastFollowTs) animate._lastFollowTs = 0;
                if (ts - animate._lastFollowTs > 700) {
                  animate._lastFollowTs = ts;
                  liveMap.easeTo({
                    center: rr.lastLngLat,
                    zoom: 17,
                    pitch: 0,
                    duration: 1000,
                    essential: true,
                  });
                }
              }
            }
          } catch {
            // ignore
          }

          rafRef.current = requestAnimationFrame(animate);
        };

        rafRef.current = requestAnimationFrame(animate);
      });
    };

    destroy();
    init();

    return () => {
      mounted = false;
      destroy();
    };
  }, [areaKey, areaCenter]);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <div ref={mapContainerRef} style={{ position: "absolute", inset: 0 }} />
      {status !== "ready" && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(2,6,23,0.12)",
            backdropFilter: "blur(2px)",
            color: "#0f172a",
            fontWeight: 600,
          }}
        >
          {status === "error" ? error || "Failed to load" : "Loading map…"}
        </div>
      )}
    </div>
  );
}
