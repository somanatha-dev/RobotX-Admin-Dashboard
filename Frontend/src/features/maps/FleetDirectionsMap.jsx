import React, { useEffect, useMemo, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { socket } from "../../lib/socket";
import { clamp, haversineMeters, interpolateLngLat } from "../../lib/geo";

const MAP_STYLE = "mapbox://styles/mapbox/dark-v11";

// Rajarajeshwari Nagar, Bengaluru (approx)
const RR_NAGAR_CENTER = [77.5199, 12.9256];
const CITY_ZOOM = 16;

const CAMERA_PITCH = 55;
const CAMERA_BEARING = -20;

// Area bounds used to restrict which robots render.
// Format: [SW, NE] where each is [lng, lat]
const AREA_BOUNDS = {
  "RR Nagar": [
    [77.5, 12.9],
    [77.54, 12.94],
  ],
};

const ROBOTS = [
  // color is used for the route-to-pickup dashed path AND the robot car icon.
  { id: "R1", name: "Robot R1", color: "#3b82f6", speedMps: 7.5 }, // blue
  { id: "R2", name: "Robot R2", color: "#facc15", speedMps: 7.0 }, // yellow
  { id: "R3", name: "Robot R3", color: "#a78bfa", speedMps: 6.8 }, // purple
];

// Icon IDs registered in Mapbox (one per robot).
const ROBOT_CAR_ICONS = ROBOTS.map((r) => ({ id: `robot-car-${r.id}`, color: r.color }));

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

function normalizeAngleDiffDeg(a, b) {
  // Smallest signed difference from a -> b, in degrees (-180..180]
  const d = ((b - a + 540) % 360) - 180;
  return d;
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
  const didInitialFitRef = useRef(false);
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

  const createPickupMarkerEl = (robotId, color) => {
    // Pickup point as 📍 with the robot id label.
    const wrap = document.createElement("div");
    wrap.style.display = "flex";
    wrap.style.flexDirection = "column";
    wrap.style.alignItems = "center";
    wrap.style.gap = "2px";

    const label = document.createElement("div");
    label.textContent = String(robotId || "");
    label.style.fontSize = "12px";
    label.style.fontWeight = "800";
    label.style.letterSpacing = "0.04em";
    label.style.color = color || "#e5e7eb";
    label.style.textShadow = "0 1px 2px rgba(0,0,0,0.9)";

    const pin = document.createElement("div");
    pin.textContent = "📍";
    pin.style.fontSize = "26px";
    pin.style.lineHeight = "1";
    pin.style.userSelect = "none";
    pin.style.filter = "drop-shadow(0 1px 2px rgba(0,0,0,0.8))";

    wrap.appendChild(label);
    wrap.appendChild(pin);
    wrap.title = "Pickup Point";
    return wrap;
  };

  const createDropMarkerEl = (robotId, color) => {
    // Destination point should look like the pickup pin, but green.
    // We hue-rotate the emoji to tint it green (simple + lightweight).
    const wrap = document.createElement("div");
    wrap.style.display = "flex";
    wrap.style.flexDirection = "column";
    wrap.style.alignItems = "center";
    wrap.style.gap = "2px";

    const label = document.createElement("div");
    label.textContent = String(robotId || "");
    label.style.fontSize = "12px";
    label.style.fontWeight = "800";
    label.style.letterSpacing = "0.04em";
    label.style.color = color || "#e5e7eb";
    label.style.textShadow = "0 1px 2px rgba(0,0,0,0.9)";

    const pin = document.createElement("div");
    pin.textContent = "📍";
    pin.style.fontSize = "26px";
    pin.style.lineHeight = "1";
    pin.style.userSelect = "none";
    pin.style.filter =
      "hue-rotate(110deg) saturate(2.2) brightness(1.05) drop-shadow(0 1px 2px rgba(0,0,0,0.8))";

    wrap.appendChild(label);
    wrap.appendChild(pin);
    wrap.title = "Destination Point";
    return wrap;
  };

  const upsertMissionMarkers = (rr) => {
    const map = mapRef.current;
    if (!map) return;
    if (!rr?.mission?.pickup || !rr?.mission?.drop) return;

    let entry = missionMarkersRef.current.get(rr.id);
    if (!entry) {
      const pickup = new mapboxgl.Marker({
        element: createPickupMarkerEl(rr.id, rr.color),
        anchor: "bottom",
      })
        .setLngLat(rr.mission.pickup)
        .addTo(map);
      const drop = new mapboxgl.Marker({
        element: createDropMarkerEl(rr.id, rr.color),
        anchor: "bottom",
      })
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

  const ensureRobotCarIcons = (map) => {
    // Create a simple, non-copyrighted 2D "robotic car" (top-down) icon per robot.
    // Colors match the route-to-pickup dashed line.
    const size = 96;
    const pixelRatio = 2;

    const roundRectPath = (ctx, x, y, w, h, r) => {
      const radius = Math.max(0, Math.min(r, Math.min(w, h) / 2));
      // Prefer native roundRect when available.
      if (typeof ctx.roundRect === "function") {
        ctx.roundRect(x, y, w, h, radius);
        return;
      }
      ctx.moveTo(x + radius, y);
      ctx.lineTo(x + w - radius, y);
      ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
      ctx.lineTo(x + w, y + h - radius);
      ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
      ctx.lineTo(x + radius, y + h);
      ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
      ctx.lineTo(x, y + radius);
      ctx.quadraticCurveTo(x, y, x + radius, y);
    };

    const buildIcon = (hex) => {
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;

      ctx.clearRect(0, 0, size, size);

      // Slight global shadow for contrast on map.
      ctx.shadowColor = "rgba(0,0,0,0.35)";
      ctx.shadowBlur = 6;
      ctx.shadowOffsetY = 2;

      // Shadow / base
      ctx.fillStyle = "rgba(0,0,0,0.28)";
      ctx.beginPath();
      roundRectPath(ctx, 24, 22, 48, 56, 16);
      ctx.fill();

      // Body
      ctx.fillStyle = hex;
      ctx.strokeStyle = "#0b1220";
      ctx.lineWidth = 5;
      ctx.beginPath();
      roundRectPath(ctx, 22, 20, 48, 56, 16);
      ctx.fill();
      ctx.stroke();

      // Clear shadow for crisp details.
      ctx.shadowColor = "rgba(0,0,0,0)";
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;

      // Panel lines
      ctx.strokeStyle = "rgba(255,255,255,0.22)";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(30, 34);
      ctx.lineTo(62, 34);
      ctx.moveTo(30, 58);
      ctx.lineTo(62, 58);
      ctx.stroke();

      // "Sensor" dome
      ctx.fillStyle = "#e5e7eb";
      ctx.strokeStyle = "#0b1220";
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(46, 30, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // Lidar ring
      ctx.strokeStyle = "rgba(229,231,235,0.75)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(46, 30, 14, 0, Math.PI * 2);
      ctx.stroke();

      // Antenna
      ctx.strokeStyle = "#0b1220";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(58, 26);
      ctx.lineTo(68, 16);
      ctx.stroke();
      ctx.fillStyle = "#e5e7eb";
      ctx.beginPath();
      ctx.arc(68, 16, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // Front indicator stripe
      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.moveTo(34, 24);
      ctx.lineTo(58, 24);
      ctx.stroke();

      // Wheels
      ctx.fillStyle = "#111827";
      const wheel = (x, y) => {
        ctx.beginPath();
        roundRectPath(ctx, x, y, 10, 16, 5);
        ctx.fill();
      };
      wheel(12, 30);
      wheel(12, 56);
      wheel(74, 30);
      wheel(74, 56);

      // Wheel hubs
      ctx.fillStyle = "#e5e7eb";
      const hub = (cx, cy) => {
        ctx.beginPath();
        ctx.arc(cx, cy, 2.6, 0, Math.PI * 2);
        ctx.fill();
      };
      hub(17, 38);
      hub(17, 64);
      hub(79, 38);
      hub(79, 64);

      const imageData = ctx.getImageData(0, 0, size, size);
      return { width: size, height: size, data: new Uint8Array(imageData.data.buffer) };
    };

    for (const icon of ROBOT_CAR_ICONS) {
      try {
        if (map.hasImage(icon.id)) continue;
        const data = buildIcon(icon.color);
        if (!data) continue;
        map.addImage(icon.id, data, { pixelRatio });
      } catch {
        // ignore
      }
    }
  };

  const addFallbackTruckIcons = (map) => {
    // Legacy fallback kept, but we now prefer robot-car icons.
    if (ROBOT_CAR_ICONS.every((x) => map.hasImage(x.id))) return;

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

    for (const icon of ROBOT_CAR_ICONS) {
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

      didInitialFitRef.current = false;

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
        pitch: CAMERA_PITCH,
        bearing: CAMERA_BEARING,
        antialias: true,
      });

      mapRef.current = map;

      map.on("error", (e) => {
        console.error("MAPBOX ERROR:", e);
      });

      map.on("load", () => {
        if (!mounted) return;

        try {
          map.setFog({
            color: "rgb(20,20,20)",
            "high-color": "rgb(36, 92, 223)",
            "horizon-blend": 0.2,
          });
        } catch {
          // ignore (fog may not be supported in some contexts)
        }

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
                // Route-to-pickup is dashed and its color matches the robot car.
                "line-color": r.color,
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
                // Pickup -> destination should use the same color as the robot + pickup path.
                "line-color": r.color,
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

          const iconId = `robot-car-${r.id}`;

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
            displayBearing: 0,
            prevSegIdx: 0,
            turning: false,
            turnStartTs: 0,
            turnFrom: 0,
            turnTo: 0,
            turnDurationMs: 550,
            turnCornerSegIdx: 0,
            turnCornerDistance: 0,
            turnAdvanceMeters: 2.5,
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

          // Ensure our custom robot-car icons exist before creating the symbol layer.
          ensureRobotCarIcons(map);
          addFallbackTruckIcons(map);

          const ensureRobotsLayer = () => {
            if (!ROBOT_CAR_ICONS.some((x) => map.hasImage(x.id)) && !map.hasImage("truck-icon")) return;
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
                  0.34,
                  16,
                  0.48,
                  18,
                  0.62,
                  20,
                  0.85,
                ],
                "icon-rotate": ["get", "bearing"],
                "icon-rotation-alignment": "map",
                "icon-pitch-alignment": "map",
                "icon-allow-overlap": true,
                "icon-ignore-placement": true,

                "text-field": ["get", "id"],
                "text-font": ["DIN Offc Pro Medium", "Arial Unicode MS Bold"],
                "text-size": 13,
                "text-offset": [0, 1.25],
                "text-anchor": "top",
                "text-allow-overlap": true,
                "text-ignore-placement": true,
              },
              paint: {
                "text-color": ["get", "color"],
                "text-halo-color": "rgba(0,0,0,0.85)",
                "text-halo-width": 1.25,
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

          // Icons are generated in-canvas; no external image required.
          ensureRobotsLayer();
        } catch (e) {
          console.error("2D ROBOTS LAYER ERROR:", e);
        }

        const fitToPlannedRoutesOnce = () => {
          const liveMap = mapRef.current;
          if (!liveMap) return;
          if (didInitialFitRef.current) return;

          try {
            const bounds = new mapboxgl.LngLatBounds();
            let hasAny = false;

            for (const rr of runtimeRef.current || []) {
              const a = rr?.routeA?.coords || [];
              const b = rr?.routeB?.coords || [];
              for (const c of a) {
                if (!c) continue;
                bounds.extend(c);
                hasAny = true;
              }
              for (const c of b) {
                if (!c) continue;
                bounds.extend(c);
                hasAny = true;
              }
            }

            if (!hasAny) return;
            didInitialFitRef.current = true;

            liveMap.fitBounds(bounds, {
              padding: { top: 80, bottom: 80, left: 80, right: 80 },
              pitch: CAMERA_PITCH,
              bearing: CAMERA_BEARING,
              duration: 1000,
            });
          } catch {
            // ignore
          }
        };

        // Plan routes (async) and then fit map to route bounds once.
        void (async () => {
          try {
            await Promise.all(runtime.map((rr) => planRoutesForRobot(rr, rr.lastLngLat)));
          } finally {
            if (!mounted) return;
            fitToPlannedRoutesOnce();
          }
        })();

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

            // If we are in a turning pause, rotate in place at the corner.
            if (rr.turning) {
              const t = clamp((ts - (rr.turnStartTs || ts)) / (rr.turnDurationMs || 550), 0, 1);
              const diff = normalizeAngleDiffDeg(rr.turnFrom || 0, rr.turnTo || 0);
              rr.displayBearing = (rr.turnFrom || 0) + diff * t;
              if (t >= 1) {
                rr.displayBearing = (rr.turnTo || 0) % 360;
                rr.turning = false;

                // Move slightly into the next segment so we don't bounce on the corner.
                const adv = rr.turnAdvanceMeters || 2.5;
                rr.distance = (rr.turnCornerDistance || rr.distance || 0) + adv;
                rr.prevSegIdx = rr.turnCornerSegIdx ?? rr.prevSegIdx;
              }
            } else {
              rr.distance = (rr.distance || 0) + rr.speedMps * dt;
            }

            const pos = rr.turning
              ? getPositionAlongRoute(route, rr.turnCornerDistance || rr.distance || 0)
              : getPositionAlongRoute(route, rr.distance);
            rr.lastLngLat = pos.lngLat;
            rr.lastBearing = pos.bearing;
            rr.isVisible = isInsideBounds(rr.lastLngLat, activeBounds);

            // bearing for 2D icon rotation: use true compass bearing along the route.
            try {
              const current = pos.lngLat;
              const next = route.coords[Math.min(pos.segIdx + 1, route.coords.length - 1)] || current;
              const targetBearing = bearingDeg(current, next);

              // If we just entered a new segment and it's a sharp turn, stop and rotate.
              const prevSeg = rr.prevSegIdx ?? pos.segIdx;
              if (!rr.turning && pos.segIdx !== prevSeg) {
                const delta = Math.abs(normalizeAngleDiffDeg(rr.displayBearing || targetBearing, targetBearing));
                if (delta >= 28) {
                  const cornerSegIdx = pos.segIdx;
                  const cornerDistance = route.cum?.[cornerSegIdx] ?? rr.distance ?? 0;

                  rr.turning = true;
                  rr.turnStartTs = ts;
                  rr.turnFrom = rr.displayBearing || targetBearing;
                  rr.turnTo = targetBearing;
                  rr.turnCornerSegIdx = cornerSegIdx;
                  rr.turnCornerDistance = cornerDistance;

                  // Snap to the corner point while turning.
                  rr.distance = cornerDistance;
                  const cornerPos = getPositionAlongRoute(route, cornerDistance);
                  rr.lastLngLat = cornerPos.lngLat;
                  rr.lastBearing = cornerPos.bearing;
                }
              }

              if (!rr.turning) rr.prevSegIdx = pos.segIdx;

              if (!rr.turning) rr.displayBearing = targetBearing;
            } catch {
              // keep last displayBearing
              rr.displayBearing = rr.displayBearing || 0;
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
                properties: {
                  id: rr.id,
                  bearing: rr.displayBearing || 0,
                  icon: rr.icon || "robot-car-R1",
                  color: rr.color || "#e5e7eb",
                },
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
                    pitch: CAMERA_PITCH,
                    bearing: CAMERA_BEARING,
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
  }, [areaKey, areaCenter]); // eslint-disable-line react-hooks/exhaustive-deps

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
