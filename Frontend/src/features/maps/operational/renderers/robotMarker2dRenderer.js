/**
 * ═══════════════════════════════════════════════════════════════════════════
 * '2d' ROBOT RENDERER — the current, and only, robot representation
 *
 * Implements the renderer contract in `../robotRendererRegistry.js` on top of
 * Mapbox DOM markers. It is the sibling a future `'3d'` renderer will sit
 * beside, not the thing a 3D renderer will grow out of.
 *
 * Everything this module knows about a robot arrives as a `RobotVisual`. It
 * never reads telemetry, never touches app state, never subscribes to a
 * socket, and never computes a world position — position arrives already
 * transformed on `visual.anchor`, from the one canonical transform in
 * `world/robotWorldAnchor.js`. Swap this module out and none of that changes,
 * which is the entire point of the seam.
 *
 * It also never reports position back. `mount`/`update` are one-way; the
 * caller keeps the last `RobotVisual` it sent if it needs to know where a
 * robot is (see `useRobotStream`'s `recenter` / follow-camera). Reading a
 * coordinate back out of a marker would make the renderer a second, drifting
 * source of truth for something state already owns.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import mapboxgl from 'mapbox-gl';
import { animate } from 'framer-motion';

import {
  createRobotMarkerElement,
  updateMarkerInfo,
  applyMarkerCamera,
  applyMarkerHeading,
  setMarkerSelected,
  setMarkerHovered,
  markerScaleForZoom,
} from '../../../../lib/mapboxMarkers.js';
import {
  anchorToLngLat,
  worldYawToScreenYaw,
} from '../../world/robotWorldAnchor.js';
import { registerRobotRenderer } from '../robotRendererRegistry.js';
import { ROBOT_REPRESENTATION } from '../robotVisual.js';

// Telemetry arrives roughly every 2 000 ms. Interpolating over slightly less
// than that lands the marker on its new position just before the next tick, so
// motion reads as continuous rather than as a series of jumps.
const POSITION_TWEEN_MS = 1800;

function easeOut(t) {
  return t * (2 - t);
}

function cancelTween(handle) {
  if (handle?.rafId) {
    try {
      cancelAnimationFrame(handle.rafId);
    } catch {
      // ignore
    }
    handle.rafId = null;
  }
}

/**
 * @param {object} context
 * @param {() => (object|null)} context.getMap        the live Mapbox map
 * @param {(robotId: string) => void} [context.onSelectRobot]
 * @param {(robotId: string|null) => void} [context.onHoverRobot]
 */
export function createRobotMarker2dRenderer(context = {}) {
  const { getMap, onSelectRobot, onHoverRobot } = context;

  const liveHandles = new Set();

  const currentCamera = () => {
    const map = getMap?.();
    if (!map) return { zoom: undefined, pitch: 0, bearing: 0 };
    try {
      return { zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() };
    } catch {
      return { zoom: undefined, pitch: 0, bearing: 0 };
    }
  };

  /** Re-derive the icon's on-screen rotation from world yaw + camera bearing. */
  const applyHeadingFor = (handle, bearing) => {
    if (!handle?.hasHeading) return;
    const screenYaw = worldYawToScreenYaw(handle.worldYaw, bearing);
    if (screenYaw !== null) applyMarkerHeading(handle.root, screenYaw);
  };

  return {
    representation: ROBOT_REPRESENTATION.TWO_D,

    mount(visual) {
      const map = getMap?.();
      const lngLat = anchorToLngLat(visual?.anchor);
      if (!map || !lngLat) return null;

      const { root, scaleWrap, hitEl, label } = createRobotMarkerElement(visual.color, visual.label);

      // Appear animation and zoom scaling both drive `scaleWrap`, never `root`
      // — `root.style.transform` belongs to Mapbox, which rewrites its own
      // translate onto it every frame.
      scaleWrap.style.opacity = '0';
      scaleWrap.style.transform = 'scale(0.75)';
      scaleWrap.style.willChange = 'transform, opacity';

      const marker = new mapboxgl.Marker({ element: root, anchor: 'center' })
        .setLngLat(lngLat)
        .addTo(map);

      const handle = {
        robotId: visual.id,
        marker,
        root,
        scaleWrap,
        currentLngLat: lngLat,
        rafId: null,
        worldYaw: visual.anchor.rotation.yaw,
        hasHeading: visual.anchor.hasHeading,
        listeners: [],
      };

      // ── Interaction → application state ──────────────────────────────────
      // These handlers report an id upward. They do not decide anything, and
      // they do not store selection on the element — so a 3D renderer raising
      // the same id keeps every downstream behaviour identical (§19).
      const select = (event) => {
        event.stopPropagation();
        onSelectRobot?.(visual.id);
      };
      const enter = () => {
        setMarkerHovered(root, true);
        onHoverRobot?.(visual.id);
      };
      const leave = () => {
        setMarkerHovered(root, false);
        onHoverRobot?.(null);
      };
      const keyActivate = (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          event.stopPropagation();
          onSelectRobot?.(visual.id);
        }
      };

      for (const el of [hitEl, label]) {
        if (!el) continue;
        el.addEventListener('click', select);
        el.addEventListener('mouseenter', enter);
        el.addEventListener('mouseleave', leave);
        handle.listeners.push([el, 'click', select], [el, 'mouseenter', enter], [el, 'mouseleave', leave]);
      }
      if (hitEl) {
        hitEl.addEventListener('keydown', keyActivate);
        handle.listeners.push([hitEl, 'keydown', keyActivate]);
      }

      const camera = currentCamera();
      applyMarkerCamera(root, camera);
      applyHeadingFor(handle, camera.bearing);
      updateMarkerInfo(root, { battery: visual.battery, status: visual.status });
      setMarkerSelected(root, visual.selected);

      try {
        animate(
          scaleWrap,
          { opacity: [0, 1], transform: ['scale(0.75)', `scale(${markerScaleForZoom(camera.zoom)})`] },
          { duration: 0.35, ease: 'easeOut' }
        );
      } catch {
        // ignore animation errors (element removed before the animation ran)
      }

      liveHandles.add(handle);
      return handle;
    },

    update(handle, visual) {
      if (!handle) return;
      const to = anchorToLngLat(visual?.anchor);
      if (!to) return;

      handle.worldYaw = visual.anchor.rotation.yaw;
      handle.hasHeading = visual.anchor.hasHeading;
      applyHeadingFor(handle, currentCamera().bearing);

      updateMarkerInfo(handle.root, { battery: visual.battery, status: visual.status });
      setMarkerSelected(handle.root, visual.selected);

      const from = handle.currentLngLat;
      if (!from) {
        try {
          handle.marker?.setLngLat?.(to);
        } catch {
          // ignore
        }
        handle.currentLngLat = to;
        return;
      }

      if (from[0] === to[0] && from[1] === to[1]) return;

      cancelTween(handle);

      const start = performance.now();
      const step = (now) => {
        const t = Math.min(1, (now - start) / POSITION_TWEEN_MS);
        const e = easeOut(t);
        try {
          handle.marker?.setLngLat?.([
            from[0] + (to[0] - from[0]) * e,
            from[1] + (to[1] - from[1]) * e,
          ]);
        } catch {
          // ignore
        }
        if (t < 1) {
          handle.rafId = requestAnimationFrame(step);
        } else {
          handle.rafId = null;
          handle.currentLngLat = to;
        }
      };
      handle.rafId = requestAnimationFrame(step);
    },

    setSelected(handle, selected) {
      if (!handle) return;
      setMarkerSelected(handle.root, Boolean(selected));
    },

    /**
     * Camera changed — reproject, do not rebuild. Zoom drives marker scale,
     * pitch drives ground-plane foreshortening, bearing re-derives the icon's
     * screen rotation from the unchanged world heading.
     */
    applyCamera(handle, camera = {}) {
      if (!handle) return;
      applyMarkerCamera(handle.root, camera);
      applyHeadingFor(handle, camera.bearing);
    },

    destroy(handle) {
      if (!handle) return;
      cancelTween(handle);
      for (const [el, type, fn] of handle.listeners || []) {
        try {
          el.removeEventListener(type, fn);
        } catch {
          // ignore
        }
      }
      handle.listeners = [];
      try {
        handle.marker?.remove?.();
      } catch {
        // ignore
      }
      liveHandles.delete(handle);
    },

    dispose() {
      for (const handle of [...liveHandles]) {
        this.destroy(handle);
      }
      liveHandles.clear();
    },
  };
}

// Self-registration on import. The registry stays free of any rendering
// dependency this way, which is what lets the architectural seam test resolve
// renderers under plain Node.
registerRobotRenderer(ROBOT_REPRESENTATION.TWO_D, createRobotMarker2dRenderer);
