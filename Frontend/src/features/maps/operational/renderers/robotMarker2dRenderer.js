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
  setMarkerFreshness,
  markerScaleForZoom,
} from '../../../../lib/mapboxMarkers.js';
import { prefersReducedMotion, subscribeReducedMotion } from '../../../../lib/reducedMotion.js';
import {
  anchorToLngLat,
  worldYawToScreenYaw,
} from '../../world/robotWorldAnchor.js';
import {
  createMotionTrack,
  displayedPose,
  isTrackStale,
  MOTION_MODE,
  retargetTrack,
  secondsSinceFresh,
} from '../robotMotion.js';
import { registerRobotRenderer } from '../robotRendererRegistry.js';
import { ROBOT_REPRESENTATION } from '../robotVisual.js';

// ── Motion (see `../robotMotion.js`) ─────────────────────────────────────────
//
// This used to be one ease-out tween per sample, a fixed 1 800 ms long, with
// its own requestAnimationFrame chain per robot, and the heading written
// instantly. Against a constant-speed robot that drew a surge at every sample
// (ease-out starts at twice the mean speed), lagged at a 500 ms stream, parked
// for seconds between samples at a 5 s one, and snapped the icon's rotation at
// every tick. Now: one frame loop for every robot this renderer owns, linear
// interpolation over the stream's measured interval, the heading turned along
// the shorter arc over the same tween, and nothing ever drawn past the newest
// sample.

/** How often the freshness (stale / offline) state is re-evaluated. */
const FRESHNESS_CHECK_MS = 1000;

const now = () =>
  typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();

/**
 * @param {object} context
 * @param {() => (object|null)} context.getMap        the live Mapbox map
 * @param {(robotId: string) => void} [context.onSelectRobot]
 * @param {(robotId: string|null) => void} [context.onHoverRobot]
 */
export function createRobotMarker2dRenderer(context = {}) {
  const { getMap, onSelectRobot, onHoverRobot } = context;

  const liveHandles = new Set();
  /** Handles whose drawn pose is still travelling toward their newest sample. */
  const moving = new Set();
  let rafId = null;
  let freshnessTimer = null;
  let reducedMotion = prefersReducedMotion();

  const currentCamera = () => {
    const map = getMap?.();
    if (!map) return { zoom: undefined, pitch: 0, bearing: 0 };
    try {
      return { zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() };
    } catch {
      return { zoom: undefined, pitch: 0, bearing: 0 };
    }
  };

  const currentBearing = () => {
    try {
      return getMap?.()?.getBearing?.() ?? 0;
    } catch {
      return 0;
    }
  };

  /** Re-derive the icon's on-screen rotation from the DRAWN world yaw + camera bearing. */
  const applyHeadingFor = (handle, bearing) => {
    if (!handle?.hasHeading || typeof handle.drawnYaw !== 'number') return;
    const screenYaw = worldYawToScreenYaw(handle.drawnYaw, bearing);
    if (screenYaw !== null) applyMarkerHeading(handle.root, screenYaw);
  };

  /** Draw one handle's pose at time `t`. Returns whether it has arrived. */
  const drawPose = (handle, t, bearing) => {
    const pose = displayedPose(handle.motion, t);
    if (pose.lngLat) {
      const [lng, lat] = pose.lngLat;
      if (!handle.drawnLngLat || handle.drawnLngLat[0] !== lng || handle.drawnLngLat[1] !== lat) {
        try {
          handle.marker?.setLngLat?.(pose.lngLat);
        } catch {
          // ignore
        }
        handle.drawnLngLat = pose.lngLat;
      }
    }
    if (typeof pose.heading === 'number' && pose.heading !== handle.drawnYaw) {
      handle.drawnYaw = pose.heading;
      applyHeadingFor(handle, bearing);
    }
    return pose.settled;
  };

  // ONE loop for the whole fleet. It runs only while some robot is between two
  // samples and stops itself when the last one arrives, so a parked fleet costs
  // no frames. A background tab gets no frames at all; on return the first frame
  // draws every robot at its newest sample (the tween's clock kept running), so
  // the missed motion is never replayed.
  const frame = () => {
    rafId = null;
    const t = now();
    const bearing = currentBearing();
    for (const handle of [...moving]) {
      if (!liveHandles.has(handle) || drawPose(handle, t, bearing)) moving.delete(handle);
    }
    if (moving.size > 0) rafId = requestAnimationFrame(frame);
  };

  const ensureLoop = () => {
    if (rafId !== null || moving.size === 0) return;
    if (typeof requestAnimationFrame !== 'function') {
      // No frame clock in this host: draw where every tween ends.
      const bearing = currentBearing();
      for (const handle of moving) drawPose(handle, Number.POSITIVE_INFINITY, bearing);
      moving.clear();
      return;
    }
    rafId = requestAnimationFrame(frame);
  };

  const stopLoop = () => {
    if (rafId !== null) {
      try {
        cancelAnimationFrame(rafId);
      } catch {
        // ignore
      }
      rafId = null;
    }
    moving.clear();
  };

  const applyFreshness = (handle, t) => {
    setMarkerFreshness(handle.root, {
      offline: handle.isOnline === false,
      stale: handle.isOnline !== false && isTrackStale(handle.motion, t),
      ageSeconds: secondsSinceFresh(handle.motion, t),
      label: handle.label,
    });
  };

  const checkFreshness = () => {
    const t = now();
    for (const handle of liveHandles) applyFreshness(handle, t);
  };

  const ensureFreshnessTimer = () => {
    if (freshnessTimer !== null || typeof setInterval !== 'function') return;
    freshnessTimer = setInterval(checkFreshness, FRESHNESS_CHECK_MS);
  };

  const stopFreshnessTimer = () => {
    if (freshnessTimer === null) return;
    clearInterval(freshnessTimer);
    freshnessTimer = null;
  };

  // Turning reduced motion on mid-session finishes every tween where it was heading.
  const unsubscribeReducedMotion = subscribeReducedMotion((reduced) => {
    reducedMotion = reduced;
    if (!reduced) return;
    const bearing = currentBearing();
    for (const handle of moving) drawPose(handle, Number.POSITIVE_INFINITY, bearing);
    stopLoop();
  });

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
      scaleWrap.style.opacity = reducedMotion ? '1' : '0';
      if (!reducedMotion) scaleWrap.style.transform = 'scale(0.75)';
      scaleWrap.style.willChange = 'transform, opacity';

      const marker = new mapboxgl.Marker({ element: root, anchor: 'center' })
        .setLngLat(lngLat)
        .addTo(map);

      const t = now();
      const yaw = visual.anchor.hasHeading ? visual.anchor.rotation.yaw : null;
      const handle = {
        robotId: visual.id,
        label: visual.label,
        marker,
        root,
        scaleWrap,
        motion: createMotionTrack({ lngLat, heading: yaw, sampleTime: visual.sampleTime ?? null, nowMs: t }),
        drawnLngLat: lngLat,
        drawnYaw: yaw,
        hasHeading: visual.anchor.hasHeading,
        isOnline: visual.isOnline,
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
      applyFreshness(handle, t);

      if (!reducedMotion) {
        try {
          animate(
            scaleWrap,
            { opacity: [0, 1], transform: ['scale(0.75)', `scale(${markerScaleForZoom(camera.zoom)})`] },
            { duration: 0.35, ease: 'easeOut' }
          );
        } catch {
          // ignore animation errors (element removed before the animation ran)
        }
      }

      liveHandles.add(handle);
      ensureFreshnessTimer();
      return handle;
    },

    update(handle, visual) {
      if (!handle) return;
      const to = anchorToLngLat(visual?.anchor);
      if (!to) return;

      // A sample without a heading keeps the last one rather than losing the arrow.
      handle.hasHeading = visual.anchor.hasHeading || handle.hasHeading;
      handle.isOnline = visual.isOnline;
      handle.label = visual.label;

      updateMarkerInfo(handle.root, { battery: visual.battery, status: visual.status });
      setMarkerSelected(handle.root, visual.selected);

      const t = now();
      const mode = retargetTrack(
        handle.motion,
        {
          lngLat: to,
          heading: visual.anchor.hasHeading ? visual.anchor.rotation.yaw : null,
          sampleTime: visual.sampleTime ?? null,
        },
        t,
        { reducedMotion }
      );
      applyFreshness(handle, t);

      if (mode === MOTION_MODE.PLACE) {
        moving.delete(handle);
        drawPose(handle, t, currentBearing());
      } else if (mode === MOTION_MODE.ANIMATE) {
        moving.add(handle);
        ensureLoop();
      }
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
      moving.delete(handle);
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
      if (liveHandles.size === 0) {
        stopLoop();
        stopFreshnessTimer();
      }
    },

    dispose() {
      for (const handle of [...liveHandles]) {
        this.destroy(handle);
      }
      liveHandles.clear();
      stopLoop();
      stopFreshnessTimer();
      unsubscribeReducedMotion();
    },
  };
}

// Self-registration on import. The registry stays free of any rendering
// dependency this way, which is what lets the architectural seam test resolve
// renderers under plain Node.
registerRobotRenderer(ROBOT_REPRESENTATION.TWO_D, createRobotMarker2dRenderer);
