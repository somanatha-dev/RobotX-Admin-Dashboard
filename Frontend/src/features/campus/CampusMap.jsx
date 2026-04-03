import React, { useEffect, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as skeletonClone } from "three/examples/jsm/utils/SkeletonUtils.js";
import { clamp, haversineMeters, interpolateLngLat } from "../../lib/geo";

const STYLE = "mapbox://styles/somanatha-dev/cmndie4c6001a01sa75ykfgpp";

// Google Maps (lat,lng): 12.902372122601147, 77.51867955304837
// Mapbox expects [lng, lat]
const RNSIT_CENTER = [Number("77.51867955304837"), Number("12.902372122601147")];

const CAMPUS_BOUNDS = [
  [Number("77.51567955304837"), Number("12.900372122601147")], // SW
  [Number("77.52167955304838"), Number("12.905372122601147")], // NE
];

// Deterministic campus-road loop (hand-picked points inside bounds).
// Robots will move ONLY along these coordinates.
const CAMPUS_LOOP = [
  [77.51755, 12.90385],
  [77.51835, 12.90455],
  [77.51955, 12.90445],
  [77.52025, 12.90365],
  [77.52015, 12.90245],
  [77.51915, 12.90175],
  [77.51805, 12.90185],
  [77.51735, 12.90265],
  [77.51755, 12.90385],
];

const ROBOTS = [
  { id: "R1", color: "#3b82f6", speedMps: 3.2, startIdx: 0 }, // blue
  { id: "R2", color: "#facc15", speedMps: 3.0, startIdx: 3 }, // yellow
  { id: "R3", color: "#a78bfa", speedMps: 3.4, startIdx: 6 }, // purple
];

const CAMPUS_ROBOT_CAR_ICONS = ROBOTS.map((r) => ({ id: `campus-robot-car-${r.id}`, color: r.color }));

function ensureCampusRobotCarIcons(map) {
  const size = 96;
  const pixelRatio = 2;

  const roundRectPath = (ctx, x, y, w, h, r) => {
    const radius = Math.max(0, Math.min(r, Math.min(w, h) / 2));
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

    // Contrast shadow so it reads on 3D campus style.
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

  for (const icon of CAMPUS_ROBOT_CAR_ICONS) {
    try {
      if (map.hasImage(icon.id)) continue;
      const data = buildIcon(icon.color);
      if (!data) continue;
      map.addImage(icon.id, data, { pixelRatio });
    } catch {
      // ignore
    }
  }
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

function degToRad(d) {
  return (d * Math.PI) / 180;
}

function radToDeg(r) {
  return (r * 180) / Math.PI;
}

function bearingDeg(a, b) {
  // a,b are [lng,lat]
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

function sliceLoop(loop, fromIdx, toIdx) {
  const pts = loop.slice(0, loop.length - 1); // exclude duplicated last
  const n = pts.length;
  const norm = (i) => ((i % n) + n) % n;
  let i = norm(fromIdx);
  const end = norm(toIdx);
  const out = [pts[i]];
  while (i !== end) {
    i = norm(i + 1);
    out.push(pts[i]);
    if (out.length > n + 2) break;
  }
  return out;
}

function getPositionAlongRoute(route, distanceMeters) {
  const coords = route?.coords || [];
  const cum = route?.cum || [];
  if (coords.length < 2 || cum.length < 2) {
    return { lngLat: coords[0] || RNSIT_CENTER, bearing: 0, angleRad: 0, done: true, segIdx: 0 };
  }

  const total = route.totalLen || 0;
  const d = Math.max(0, distanceMeters);
  if (d >= total) {
    const a = coords[coords.length - 2];
    const b = coords[coords.length - 1];
    const ma = mapboxgl.MercatorCoordinate.fromLngLat(a, 0);
    const mb = mapboxgl.MercatorCoordinate.fromLngLat(b, 0);
    const angleRad = Math.atan2(mb.y - ma.y, mb.x - ma.x);
    const bearing = bearingDeg(a, b);
    return { lngLat: b, bearing, angleRad, done: true, segIdx: Math.max(0, coords.length - 2) };
  }

  let segIdx = 0;
  while (segIdx < cum.length - 2 && cum[segIdx + 1] < d) segIdx += 1;
  const segStartDist = cum[segIdx] || 0;
  const segLen = route.segLens?.[segIdx] || 1;
  const t = clamp((d - segStartDist) / (segLen || 1), 0, 1);
  const a = coords[segIdx];
  const b = coords[segIdx + 1] || a;
  const lngLat = interpolateLngLat(a, b, t);
  const ma = mapboxgl.MercatorCoordinate.fromLngLat(a, 0);
  const mb = mapboxgl.MercatorCoordinate.fromLngLat(b, 0);
  const angleRad = Math.atan2(mb.y - ma.y, mb.x - ma.x);
  const bearing = bearingDeg(a, b);
  return { lngLat, bearing, angleRad, done: false, segIdx };
}

function normalizeAngleDiffDeg(a, b) {
  const d = ((b - a + 540) % 360) - 180;
  return d;
}

function _createCampusRobotsLayer({ runtimeRef, followRobotIdRef }) {
  return {
    id: "campus-3d-robots",
    type: "custom",
    renderingMode: "3d",
    onAdd(map, gl) {
      this.map = map;
      this.camera = new THREE.Camera();
      this.scene = new THREE.Scene();

      // Pre-allocate common transforms/vectors to reduce GC.
      this._mRotX = new THREE.Matrix4().makeRotationX(Math.PI / 2);
      this._mRotZ = new THREE.Matrix4();
      this._mScale = new THREE.Matrix4();
      this._mTrans = new THREE.Matrix4();
      this._mFinal = new THREE.Matrix4();

      this._mPinRotX = new THREE.Matrix4().makeRotationX(Math.PI / 2);
      this._mPinScale = new THREE.Matrix4();
      this._mPinTrans = new THREE.Matrix4();
      this._mPinFinal = new THREE.Matrix4();

      const light1 = new THREE.DirectionalLight(0xffffff, 1.2);
      light1.position.set(100, 200, 300);
      this.scene.add(light1);
      this.scene.add(new THREE.AmbientLight(0xffffff, 0.6));

      this.pickupPinGeometry = new THREE.ConeGeometry(0.45, 1.6, 14);
      this.dropPinGeometry = new THREE.ConeGeometry(0.45, 1.6, 14);
      this.objects = new Map();

      const collectMaterials = (root) => {
        const materials = [];
        try {
          root?.traverse?.((obj) => {
            if (obj && obj.isMesh && obj.material) {
              const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
              for (const m of mats) materials.push(m);
            }
          });
        } catch {
          // ignore
        }
        return materials;
      };

      const fleet = runtimeRef.current || [];
      for (const rr of fleet) {
        const pickupMat = new THREE.MeshStandardMaterial({ color: "#facc15", roughness: 0.55, metalness: 0.05 });
        const dropMat = new THREE.MeshStandardMaterial({ color: "#ef4444", roughness: 0.55, metalness: 0.05 });
        const pickupPin = new THREE.Mesh(this.pickupPinGeometry, pickupMat);
        const dropPin = new THREE.Mesh(this.dropPinGeometry, dropMat);
        pickupPin.frustumCulled = false;
        dropPin.frustumCulled = false;
        pickupPin.matrixAutoUpdate = false;
        dropPin.matrixAutoUpdate = false;
        this.scene.add(pickupPin);
        this.scene.add(dropPin);

        this.objects.set(rr.id, { model: null, modelMaterials: [], pickupPin, dropPin });
      }

      // Load real truck model(s). No cube fallback.
      try {
        const loader = new GLTFLoader();
        loader.load(
          "/models/truck.glb",
          (gltf) => {
            try {
              const template = gltf?.scene;
              if (!template) return;

              for (const rr of fleet) {
                const entry = this.objects?.get(rr.id);
                if (!entry) continue;

                const model = skeletonClone(template);
                model.updateMatrixWorld(true);
                const box = new THREE.Box3().setFromObject(model);
                const center = box.getCenter(new THREE.Vector3());
                model.position.sub(center);
                model.updateMatrixWorld(true);

                model.traverse((obj) => {
                  if (!obj || !obj.isMesh) return;
                  obj.frustumCulled = false;
                  const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
                  for (const m of mats) {
                    if (!m) continue;
                    m.side = THREE.DoubleSide;
                    m.needsUpdate = true;
                  }
                });

                const root = new THREE.Group();
                root.matrixAutoUpdate = false;
                root.frustumCulled = false;
                root.add(model);
                this.scene.add(root);

                entry.model = root;
                entry.modelMaterials = collectMaterials(root);
              }

              this.map?.triggerRepaint?.();
            } catch {
              // ignore
            }
          },
          undefined,
          () => {
            // ignore missing model
          }
        );
      } catch {
        // ignore
      }

      this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
      this.renderer.autoClear = false;
      try {
        this.renderer.setPixelRatio(1);
      } catch {
        // ignore
      }
      try {
        const c = this.map.getCanvas();
        this.renderer.setSize(c.width, c.height, false);
      } catch {
        // ignore
      }
    },
    render(gl, matrix) {
      this.camera.projectionMatrix = new THREE.Matrix4().fromArray(matrix);

      // Keep Three renderer viewport in sync with Mapbox canvas.
      try {
        const c = this.map.getCanvas();
        const w = c.width;
        const h = c.height;
        if (w && h && (this._lastCanvasW !== w || this._lastCanvasH !== h)) {
          this._lastCanvasW = w;
          this._lastCanvasH = h;
          this.renderer.setSize(w, h, false);
        }
      } catch {
        // ignore
      }

      const applyModelMatrix = (obj, lngLat, angleRad) => {
        const merc = mapboxgl.MercatorCoordinate.fromLngLat(lngLat, 0);

        const scale = merc.meterInMercatorCoordinateUnits() * 3.2; // 👈 FIXED SIZE

        this._mScale.makeScale(scale, scale, scale);
        this._mRotZ.makeRotationZ(angleRad);
        this._mTrans.makeTranslation(merc.x, merc.y, merc.z);

        this._mFinal
          .identity()
          .multiply(this._mTrans) // WORLD POSITION LAST
          .multiply(this._mRotZ) // direction
          .multiply(this._mRotX) // map alignment
          .multiply(this._mScale); // local scale FIRST

        obj.matrix.copy(this._mFinal);
        obj.matrixAutoUpdate = false;
        obj.matrixWorldNeedsUpdate = true;
      };

      const applyPinMatrix = (obj, lngLat, altitudeMeters, scaleMeters) => {
        const merc = mapboxgl.MercatorCoordinate.fromLngLat(lngLat, altitudeMeters || 0);
        const units = merc.meterInMercatorCoordinateUnits();
        const scale = units * (scaleMeters || 1);

        this._mPinScale.makeScale(scale, scale, scale);
        this._mPinTrans.makeTranslation(merc.x, merc.y, merc.z);

        this._mPinFinal
          .identity()
          .multiply(this._mPinTrans)
          .multiply(this._mPinRotX)
          .multiply(this._mPinScale);

        obj.matrix.copy(this._mPinFinal);
        obj.matrixAutoUpdate = false;
        obj.matrixWorldNeedsUpdate = true;
      };

      try {
        const fleet = runtimeRef.current || [];
        const followId = followRobotIdRef?.current || null;

        for (const rr of fleet) {
          const entry = this.objects?.get(rr.id);
          if (!entry || !rr.lastLngLat) continue;

          try {
            const model = entry.model;
            if (model) {
              const lastLngLat = Array.isArray(rr.lastLngLat)
                ? { lng: rr.lastLngLat[0], lat: rr.lastLngLat[1] }
                : rr.lastLngLat;

              // Initialize
              if (!rr.prevLngLat) {
                rr.prevLngLat = lastLngLat;
              }

              const curr = mapboxgl.MercatorCoordinate.fromLngLat(lastLngLat, 0);
              const prev = mapboxgl.MercatorCoordinate.fromLngLat(rr.prevLngLat, 0);

              const dx = curr.x - prev.x;
              const dy = curr.y - prev.y;

              let targetAngle = rr.renderAngle || 0;

              // update only if movement exists
              if (Math.abs(dx) > 1e-9 || Math.abs(dy) > 1e-9) {
                targetAngle = Math.atan2(dy, dx);
              }

              // Uber-style smoothing (stable, no jitter)
              if (rr.renderAngle === undefined) {
                rr.renderAngle = targetAngle;
              } else {
                const diff = targetAngle - rr.renderAngle;
                const normalizedDiff = Math.atan2(Math.sin(diff), Math.cos(diff));
                rr.renderAngle += normalizedDiff * 0.18;
              }

              const finalAngle = rr.renderAngle;
              rr.prevLngLat = lastLngLat;

              applyModelMatrix(model, lastLngLat, finalAngle);
            }
          } catch {
            // ignore
          }

          if (rr.mission?.pickup) {
            applyPinMatrix(entry.pickupPin, rr.mission.pickup, 0.2, 1.6);
          }
          if (rr.mission?.drop) {
            applyPinMatrix(entry.dropPin, rr.mission.drop, 0.2, 1.6);
          }

          // highlight followed
          const isFollowed = followId && rr.id === followId;
          const dim = followId && !isFollowed;
          const mats = entry.modelMaterials || [];
          for (const m of mats) {
            if (!m) continue;
            m.transparent = !!dim;
            m.opacity = dim ? 0.35 : 1;
          }
        }
      } catch {
        // ignore
      }

      this.renderer.resetState();
      // CRITICAL FIX: clear depth on Mapbox's WebGL context to prevent ghosting.
      try {
        gl.clear(gl.DEPTH_BUFFER_BIT);
      } catch {
        // ignore
      }
      this.renderer.render(this.scene, this.camera);

      // Restore full-canvas viewport for Mapbox.
      try {
        const c = this.map.getCanvas();
        gl.viewport(0, 0, c.width, c.height);
      } catch {
        // ignore
      }

      try {
        this.map?.triggerRepaint?.();
      } catch {
        // ignore
      }
    },
    onRemove() {
      try {
        this.objects?.forEach?.((entry) => {
          try {
            const model = entry?.model;
            model?.traverse?.((obj) => {
              if (obj && obj.isMesh) {
                try {
                  obj.geometry?.dispose?.();
                } catch {
                  // ignore
                }
                try {
                  const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
                  for (const m of mats) m?.dispose?.();
                } catch {
                  // ignore
                }
              }
            });
          } catch {
            // ignore
          }
        });
        this.pickupPinGeometry?.dispose?.();
        this.dropPinGeometry?.dispose?.();
      } catch {
        // ignore
      }
      try {
        this.renderer?.dispose?.();
      } catch {
        // ignore
      }
      this.objects = null;
      this.scene = null;
      this.camera = null;
      this.renderer = null;
      this.map = null;
    },
  };
}

export default function CampusMap() {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const runtimeRef = useRef([]);
  const rafRef = useRef(null);
  const followRobotIdRef = useRef(null);
  const missionMarkersRef = useRef(new Map());
  const [followRobotId, setFollowRobotId] = useState(null);
  useEffect(() => {
    followRobotIdRef.current = followRobotId;
  }, [followRobotId]);

  useEffect(() => {
    let mounted = true;

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
        const pickup = new mapboxgl.Marker({ element: createPickupMarkerEl(rr.id, rr.color), anchor: "bottom" })
          .setLngLat(rr.mission.pickup)
          .addTo(map);
        const drop = new mapboxgl.Marker({ element: createDropMarkerEl(rr.id, rr.color), anchor: "bottom" })
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

    const destroy = () => {
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
      runtimeRef.current = [];

      try {
        for (const [id] of missionMarkersRef.current) removeMissionMarkers(id);
      } catch {
        // ignore
      }
      missionMarkersRef.current.clear();
    };

    const init = () => {
      if (!containerRef.current) return;
      const token = import.meta.env.VITE_MAPBOX_TOKEN;
      if (!token) {
        console.error("VITE_MAPBOX_TOKEN missing");
        return;
      }
      mapboxgl.accessToken = token;

      const map = new mapboxgl.Map({
        container: containerRef.current,
        style: STYLE,
        center: RNSIT_CENTER,
        zoom: 18,
        pitch: 60,
        bearing: -20,
        antialias: true,
        maxBounds: CAMPUS_BOUNDS,
        minZoom: 17,
        maxZoom: 20,
      });
      mapRef.current = map;

      map.on("error", (e) => {
        console.error("CAMPUS MAP ERROR:", e?.error?.message || e);
      });

      map.on("load", () => {
        if (!mounted) return;
        setTimeout(() => map.resize(), 100);
        setTimeout(() => map.resize(), 300);

        // 3D buildings
        try {
          if (!map.getLayer("3d-buildings")) {
            const layers = map.getStyle()?.layers || [];
            const labelLayerId = layers.find(
              (layer) => layer.type === "symbol" && layer.layout && layer.layout["text-field"]
            )?.id;
            map.addLayer(
              {
                id: "3d-buildings",
                source: "composite",
                "source-layer": "building",
                filter: ["==", "extrude", "true"],
                type: "fill-extrusion",
                minzoom: 15,
                paint: {
                  "fill-extrusion-color": "#aaa",
                  "fill-extrusion-height": ["get", "height"],
                  "fill-extrusion-base": ["get", "min_height"],
                  "fill-extrusion-opacity": 0.9,
                },
              },
              labelLayerId
            );
          }
        } catch (e) {
          console.error("CAMPUS 3D BUILDINGS ERROR:", e);
        }

        // per-robot route sources/layers
        for (const r of ROBOTS) {
          const pickupSourceId = `campus-route-to-pickup-${r.id}`;
          const dropSourceId = `campus-route-to-drop-${r.id}`;
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
          const pickupLayerId = `campus-route-to-pickup-layer-${r.id}`;
          const dropLayerId = `campus-route-to-drop-layer-${r.id}`;
          if (!map.getLayer(pickupLayerId)) {
            map.addLayer({
              id: pickupLayerId,
              type: "line",
              source: pickupSourceId,
              layout: { "line-join": "round", "line-cap": "round" },
              paint: {
                // Route-to-pickup is dashed; its color matches the robot car.
                "line-color": r.color,
                "line-width": 4,
                "line-opacity": 0.85,
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
                // Pickup -> destination uses the same color as robot + pickup path.
                "line-color": r.color,
                "line-width": 5,
                "line-opacity": 0.8,
              },
            });
          }
        }

        // runtime
        const runtime = ROBOTS.map((r) => {
          const pickupIdx = (r.startIdx + 2) % 8;
          const dropIdx = (r.startIdx + 5) % 8;
          const start = CAMPUS_LOOP[r.startIdx];
          const pickup = CAMPUS_LOOP[pickupIdx];
          const drop = CAMPUS_LOOP[dropIdx];
          const routeToPickup = buildRouteData(sliceLoop(CAMPUS_LOOP, r.startIdx, pickupIdx));
          const routeToDrop = buildRouteData(sliceLoop(CAMPUS_LOOP, pickupIdx, dropIdx));

          // seed lines
          map.getSource(`campus-route-to-pickup-${r.id}`)?.setData({
            type: "Feature",
            geometry: { type: "LineString", coordinates: routeToPickup.coords },
            properties: { id: r.id, kind: "toPickup" },
          });
          map.getSource(`campus-route-to-drop-${r.id}`)?.setData({
            type: "Feature",
            geometry: { type: "LineString", coordinates: routeToDrop.coords },
            properties: { id: r.id, kind: "toDrop" },
          });

          return {
            id: r.id,
            color: r.color,
            speedMps: r.speedMps,
            orderIndex: 0,
            state: "TO_PICKUP",
            distance: 0,
            lastTs: 0,
            lastLngLat: start,
            lastAngleRad: 0,
            lastBearing: 0,
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
            mission: { start, pickup, drop },
            routeToPickup,
            routeToDrop,
          };
        });
        runtimeRef.current = runtime;

        // Pickup/Destination markers
        try {
          runtime.forEach((rr) => upsertMissionMarkers(rr));
        } catch {
          // ignore
        }

        // 2D robot cars (always visible)
        try {
          ensureCampusRobotCarIcons(map);
          if (!map.getSource("campus-robots")) {
            map.addSource("campus-robots", {
              type: "geojson",
              data: { type: "FeatureCollection", features: [] },
            });
          }
          if (!map.getLayer("campus-robots-layer")) {
            map.addLayer({
              id: "campus-robots-layer",
              type: "symbol",
              source: "campus-robots",
              layout: {
                "icon-image": ["get", "icon"],
                "icon-size": [
                  "interpolate",
                  ["linear"],
                  ["zoom"],
                  17,
                  0.85,
                  18,
                  1.05,
                  19,
                  1.25,
                  20,
                  1.45,
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

            map.on("click", "campus-robots-layer", (e) => {
              const id = e?.features?.[0]?.properties?.id;
              if (!id) return;
              setFollowRobotId((prev) => (prev === id ? null : id));
            });

            map.on("mouseenter", "campus-robots-layer", () => {
              try {
                map.getCanvas().style.cursor = "pointer";
              } catch {
                // ignore
              }
            });
            map.on("mouseleave", "campus-robots-layer", () => {
              try {
                map.getCanvas().style.cursor = "";
              } catch {
                // ignore
              }
            });
          }
        } catch {
          // ignore
        }

        // Note: we intentionally avoid the 3D GLTF truck layer here because missing assets
        // can make robots invisible. 2D icons are reliable and match the requested UX.

        // hit layer for selection
        try {
          const srcId = "campus-robots-points";
          const layerId = "campus-robots-hit";
          if (!map.getSource(srcId)) {
            map.addSource(srcId, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
          }
          if (!map.getLayer(layerId)) {
            map.addLayer({
              id: layerId,
              type: "circle",
              source: srcId,
              paint: { "circle-radius": 14, "circle-color": "#000000", "circle-opacity": 0 },
            });
          }
          map.on("click", layerId, (e) => {
            const id = e?.features?.[0]?.properties?.id;
            if (!id) return;
            setFollowRobotId((prev) => (prev === id ? null : id));
          });
          map.on("mouseenter", layerId, () => {
            try {
              map.getCanvas().style.cursor = "pointer";
            } catch {
              // ignore
            }
          });
          map.on("mouseleave", layerId, () => {
            try {
              map.getCanvas().style.cursor = "";
            } catch {
              // ignore
            }
          });
        } catch {
          // ignore
        }

        const animate = (ts) => {
          if (!mounted) return;
          const liveMap = mapRef.current;
          if (!liveMap) return;

          // update hit points
          try {
            const features = runtimeRef.current.map((rr) => ({
              type: "Feature",
              geometry: { type: "Point", coordinates: rr.lastLngLat || RNSIT_CENTER },
              properties: { id: rr.id },
            }));
            liveMap.getSource("campus-robots-points")?.setData({ type: "FeatureCollection", features });
          } catch {
            // ignore
          }

          for (const rr of runtimeRef.current) {
            const route = rr.state === "TO_PICKUP" ? rr.routeToPickup : rr.routeToDrop;
            if (!route?.coords || route.coords.length < 2) continue;

            if (!rr.lastTs) rr.lastTs = ts;
            const dt = clamp((ts - rr.lastTs) / 1000, 0, 0.08);
            rr.lastTs = ts;

            if (rr.turning) {
              const t = clamp((ts - (rr.turnStartTs || ts)) / (rr.turnDurationMs || 550), 0, 1);
              const diff = normalizeAngleDiffDeg(rr.turnFrom || 0, rr.turnTo || 0);
              rr.displayBearing = (rr.turnFrom || 0) + diff * t;
              if (t >= 1) {
                rr.displayBearing = (rr.turnTo || 0) % 360;
                rr.turning = false;

                // Nudge into next segment to avoid bouncing on the corner.
                const adv = rr.turnAdvanceMeters || 2.5;
                rr.distance = (rr.turnCornerDistance || rr.distance || 0) + adv;
                rr.prevSegIdx = rr.turnCornerSegIdx ?? rr.prevSegIdx;
              }
            } else {
              rr.distance += rr.speedMps * dt;
            }
            const pos = rr.turning
              ? getPositionAlongRoute(route, rr.turnCornerDistance || rr.distance || 0)
              : getPositionAlongRoute(route, rr.distance);
            rr.lastLngLat = pos.lngLat;
            rr.lastAngleRad = pos.angleRad;
            rr.lastBearing = pos.bearing;

            try {
              const targetBearing = pos.bearing;
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

                  rr.distance = cornerDistance;
                  const cornerPos = getPositionAlongRoute(route, cornerDistance);
                  rr.lastLngLat = cornerPos.lngLat;
                  rr.lastAngleRad = cornerPos.angleRad;
                  rr.lastBearing = cornerPos.bearing;
                }
              }
              if (!rr.turning) rr.prevSegIdx = pos.segIdx;
              if (!rr.turning) rr.displayBearing = targetBearing;
            } catch {
              rr.displayBearing = rr.displayBearing || rr.lastBearing || 0;
            }

            const pickupSourceId = `campus-route-to-pickup-${rr.id}`;
            const dropSourceId = `campus-route-to-drop-${rr.id}`;
            if (rr.state === "TO_PICKUP") {
              const rem = [pos.lngLat, ...route.coords.slice(Math.min(pos.segIdx + 1, route.coords.length - 1))];
              liveMap.getSource(pickupSourceId)?.setData({
                type: "Feature",
                geometry: { type: "LineString", coordinates: rem },
                properties: { id: rr.id, kind: "toPickup" },
              });
            } else {
              const rem = [pos.lngLat, ...route.coords.slice(Math.min(pos.segIdx + 1, route.coords.length - 1))];
              liveMap.getSource(dropSourceId)?.setData({
                type: "Feature",
                geometry: { type: "LineString", coordinates: rem },
                properties: { id: rr.id, kind: "toDrop" },
              });
            }

            if (pos.done) {
              rr.distance = 0;
              if (rr.state === "TO_PICKUP") {
                rr.state = "TO_DESTINATION";
              } else {
                // next order: shift pickup/drop along the loop
                rr.orderIndex += 1;
                const base = (ROBOTS.find((r) => r.id === rr.id)?.startIdx || 0) + rr.orderIndex;
                const startIdx = base % 8;
                const pickupIdx = (startIdx + 2) % 8;
                const dropIdx = (startIdx + 5) % 8;
                const start = CAMPUS_LOOP[startIdx];
                const pickup = CAMPUS_LOOP[pickupIdx];
                const drop = CAMPUS_LOOP[dropIdx];
                rr.mission = { start, pickup, drop };
                try {
                  upsertMissionMarkers(rr);
                } catch {
                  // ignore
                }
                rr.routeToPickup = buildRouteData(sliceLoop(CAMPUS_LOOP, startIdx, pickupIdx));
                rr.routeToDrop = buildRouteData(sliceLoop(CAMPUS_LOOP, pickupIdx, dropIdx));
                rr.state = "TO_PICKUP";

                liveMap.getSource(`campus-route-to-pickup-${rr.id}`)?.setData({
                  type: "Feature",
                  geometry: { type: "LineString", coordinates: rr.routeToPickup.coords },
                  properties: { id: rr.id, kind: "toPickup" },
                });
                liveMap.getSource(`campus-route-to-drop-${rr.id}`)?.setData({
                  type: "Feature",
                  geometry: { type: "LineString", coordinates: rr.routeToDrop.coords },
                  properties: { id: rr.id, kind: "toDrop" },
                });
              }
            }
          }

          // push 2D cars
          try {
            const features = runtimeRef.current.map((rr) => ({
              type: "Feature",
              geometry: { type: "Point", coordinates: rr.lastLngLat || RNSIT_CENTER },
              properties: {
                id: rr.id,
                bearing: rr.displayBearing || rr.lastBearing || 0,
                icon: `campus-robot-car-${rr.id}`,
                color: rr.color || "#e5e7eb",
              },
            }));
            liveMap.getSource("campus-robots")?.setData({ type: "FeatureCollection", features });
          } catch {
            // ignore
          }

          // camera follow
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
                    zoom: 19,
                    pitch: 60,
                    bearing: rr.lastBearing || 0,
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
  }, []);

  return <div ref={containerRef} className="w-full h-full" style={{ minHeight: "500px" }} />;
}
