import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';

import { socket, DASHBOARD_EVENTS } from '@/lib/socket.js';
import { isTerminalTaskStatus, replayableRoutes, staleMapRoutes, standDownRobot } from '@/lib/liveState.js';
import { injectPulseCSS, applyMarkerZoomScale } from '@/lib/mapboxMarkers.js';

// ── The robot rendering seam ────────────────────────────────────────────────
//
// This hook owns the OPERATIONAL OVERLAY: robot visuals, route lines and
// mission pins. It no longer owns how a robot is DRAWN. Robot state becomes a
// `RobotVisual` (semantic) carrying a `RobotWorldAnchor` (canonical position),
// and a renderer resolved by name turns that into pixels.
//
//        robot state ──► toRobotVisual ──► renderer.mount / .update
//                              │
//                     RobotWorldAnchor  (the one position formula)
//
// Introducing 3D robots later is a different `representation` string resolving
// to a different renderer. Nothing in this file has to change for it: not the
// socket subscriptions, not the filter logic, not selection, not the routes,
// not `recenter`, not the follow camera.
//
// The `2d` renderer module is imported for its self-registration side effect.
import '@/features/maps/operational/renderers/robotMarker2dRenderer.js';
import { createRobotRenderer } from '@/features/maps/operational/robotRendererRegistry.js';
import { ROBOT_REPRESENTATION, toRobotVisual, colorForRobot } from '@/features/maps/operational/robotVisual.js';
import { anchorToLngLat } from '@/features/maps/world/robotWorldAnchor.js';
import {
  ROUTE_SEGMENT,
  advanceRouteState,
  lineCollection,
} from '@/features/maps/operational/routeGeometry.js';
import { summariseRouteFindings, validateRoute } from '@/features/maps/operational/routeValidation.js';
import {
  createFlowAnimator,
  ensureLineLayer,
  routeLayersPresent,
  safeRemoveLayerAndSource,
  shouldRedrawRoute,
} from '@/features/maps/operational/routeOverlay.js';
import { createSampleGate, sampleTimeOf } from '@/features/maps/operational/robotMotion.js';
import { CHARGING_STATION_FLOOR_LAYER } from '@/features/maps/charging/stationLayers.js';
import { documentVisible, prefersReducedMotion, subscribeReducedMotion } from '@/lib/reducedMotion.js';
import { comfortableFollowPitch, createFollowCameraState, stepFollowCamera } from '@/features/maps/camera/followCamera.js';

function toLngLat(point) {
  if (!point) return null;
  if (Array.isArray(point) && point.length >= 2) {
    const lon = typeof point[0] === 'number' ? point[0] : null;
    const lat = typeof point[1] === 'number' ? point[1] : null;
    if (lon === null || lat === null) return null;
    return [lon, lat];
  }
  const lat = typeof point.lat === 'number' ? point.lat : null;
  const lon = typeof point.lon === 'number' ? point.lon : null;
  if (lat === null || lon === null) return null;
  return [lon, lat];
}

// ── Where the travelled/ahead split comes from (§3D) ────────────────────────
//
// It used to come from `task.pathIndex`. That index is real — the simulation
// and the routing service both hold one — and it is NEVER SENT TO THE BROWSER:
// `robot:update` carries position, battery, status, speed, heading and nothing
// else, and `TASK_ASSIGNED` carries the paths with no progress. So the split
// index arriving here was always 0 for the whole life of every task, which made
// "route travelled" a permanently zero-length stub and "route ahead" the entire
// route from assignment to completion. The two-colour route was drawing a
// distinction it never actually made.
//
// It now comes from the robot's own live position, projected onto its route by
// `operational/routeGeometry.js`. Nothing was asked of the backend, no
// navigation semantic changed, and no coordinate is edited — the position is
// already streamed and the route is already held, and where a point falls on a
// polyline is arithmetic.

/**
 * Fit the camera to a set of {lat,lon} points, with sane defaults for the
 * live-tracking view. Shared by the auto-fit-on-assignment flow and the
 * manual "Recenter" control so both frame routes the same way.
 */
function fitRouteBounds(map, points, opts = {}) {
  if (!map) return false;
  const lats = (Array.isArray(points) ? points : []).map((p) => p?.lat).filter((v) => typeof v === 'number');
  const lons = (Array.isArray(points) ? points : []).map((p) => p?.lon).filter((v) => typeof v === 'number');
  if (lats.length < 1 || lons.length < 1) return false;

  try {
    map.fitBounds(
      [
        [Math.min(...lons), Math.min(...lats)],
        [Math.max(...lons), Math.max(...lats)],
      ],
      {
        padding: { top: 90, bottom: 90, left: 90, right: 90 },
        maxZoom: 17,
        duration: 1600,
        ...opts,
      }
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Re-colour every route layer currently on the map from a theme.
 *
 * Called on each frame of a theme transition. It writes paint properties onto
 * layers that already exist — no source is touched, no line is rebuilt, and
 * route progress (which segment is done vs ahead) is geometry, so it cannot be
 * disturbed by a colour change (§52).
 */
function applyThemeToRouteLayers(map, routes, theme) {
  if (!map || !theme) return;
  const set = (layerId, prop, value) => {
    try {
      if (map.getLayer(layerId)) map.setPaintProperty(layerId, prop, value);
    } catch {
      // ignore
    }
  };

  for (const entry of routes) {
    for (const layerId of [
      entry?.pickupTodoLayerId,
      entry?.pickupDoneLayerId,
      entry?.dropTodoLayerId,
      entry?.dropDoneLayerId,
    ]) {
      if (!layerId) continue;
      set(`${layerId}-casing`, 'line-color', theme.routes.halo);
      set(`${layerId}-flow`, 'line-color', theme.routes.flow);
      set(`${layerId}-flow`, 'line-opacity', theme.routes.flowOpacity);
    }
  }
}

function createMissionMarkerEl({ color, label }) {
  injectPulseCSS();

  // Outer wrapper — the anchor is 'center', so this element's center = coordinate
  // point. It's passed directly to `new mapboxgl.Marker({element: wrap})`, so
  // Mapbox writes its own positioning transform onto `wrap` every frame — zoom
  // scaling must go on the `inner` child instead (see mapboxMarkers.js for the
  // same pattern on robot markers), or our scale and Mapbox's translate would
  // clobber each other.
  // `position:absolute` (not `relative`) — must agree with Mapbox's own
  // `.mapboxgl-marker { position:absolute }` rule on this exact element, or
  // the inline style wins and pulls it into normal document flow, stacking
  // it under every marker created earlier (see mapboxMarkers.js for the
  // full explanation — this was the actual cause of Pickup/Drop pins
  // drifting from their true coordinate).
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:absolute;width:36px;height:36px;';

  const inner = document.createElement('div');
  inner.style.cssText = 'position:absolute;inset:0;transform-origin:50% 50%;will-change:transform;';
  wrap._scaleWrap = inner;

  // Pulse ring — absolutely centered in wrap
  const pulse = document.createElement('div');
  pulse.style.cssText = [
    'position:absolute',
    'top:50%', 'left:50%',
    'transform:translate(-50%,-50%)',
    'width:24px', 'height:24px',
    'border-radius:50%',
    `background:${color}`,
    'animation:rx-pulse-a 2.5s ease-out 0.4s infinite',
    'pointer-events:none',
    'z-index:0',
  ].join(';');
  pulse.dataset.rxMotion = 'pulse';

  // Main dot — absolutely centered
  const dot = document.createElement('div');
  dot.style.cssText = [
    'position:absolute',
    'top:50%', 'left:50%',
    'transform:translate(-50%,-50%)',
    'width:24px', 'height:24px',
    'border-radius:50%',
    `background:${color}`,
    'border:3px solid rgba(255,255,255,0.97)',
    `box-shadow:0 3px 10px rgba(0,0,0,0.5), 0 0 0 4px ${color}33`,
    'z-index:2',
  ].join(';');

  // Label badge (above the dot)
  const tag = document.createElement('div');
  tag.textContent         = label;
  tag.style.position      = 'absolute';
  tag.style.left          = '50%';
  tag.style.bottom        = '100%';
  tag.style.transform     = 'translateX(-50%)';
  tag.style.marginBottom  = '4px';
  tag.style.padding       = '3px 10px';
  tag.style.borderRadius  = '9999px';
  tag.style.background    = color;
  tag.style.color         = '#fff';
  tag.style.fontSize      = '11px';
  tag.style.fontWeight    = '800';
  tag.style.letterSpacing = '0.05em';
  tag.style.whiteSpace    = 'nowrap';
  tag.style.pointerEvents = 'none';
  tag.style.boxShadow     = '0 2px 6px rgba(0,0,0,0.45)';
  tag.style.border        = '1.5px solid rgba(255,255,255,0.5)';
  tag.style.zIndex        = '10';

  dot.appendChild(tag);
  inner.appendChild(pulse);
  inner.appendChild(dot);
  wrap.appendChild(inner);
  return wrap;
}

export function useRobotStream({
  robots: globalRobots,
  taskPathCacheRef,
  countryId,
  stateId,
  cityId,
  locationId,
  campusId,
  mapRef,
  markersRef,
  /**
   * The map's `load` has fired. A map built on returning to this page is not
   * ready for layers when the cached routes first replay; this is one of the
   * two moments they are restored (the other is `style.load`).
   */
  isMapLoaded = false,
  // Operational overlay inputs — all application state, none renderer state.
  representation = ROBOT_REPRESENTATION.TWO_D,
  selectedRobotId = null,
  followSelected = false,
  onSelectRobot,
  onHoverRobot,
  // View state, not operational state: the theme only decides what the route
  // corridor and its flow are coloured, never where the route goes.
  themeRef,
  subscribeToTheme,
  /**
   * Campus features, for route VALIDATION only (§3D). Read-only, and used to
   * produce findings that are reported as text — never to move, snap, hide or
   * repair a route.
   */
  campusFeatures,
  /** Called with the current route findings whenever they change. */
  onRouteFindings,
}) {
  const [robots, setRobots] = useState([]);

  const activeRobotIdsRef = useRef(new Set());
  const routesRef = useRef(new Map());
  const taskPathsRef = useRef(new Map());
  const flowAnimatorRef = useRef(null);

  /**
   * robotId → the task this unit is currently running.
   *
   * ── The defect this ref exists to fix (§3D) ─────────────────────────────
   * `upsertRoutes` used to read the task off whatever robot payload it was
   * handed. `TASK_ASSIGNED` supplies one; `robot:update` does not — it carries
   * `{ robotId, lat, lon, battery, status, speed, isOnline, lastSeenAt,
   * heading }` and no task at all. So the sequence in live operation was:
   * a task is assigned, the route is drawn, and the very next telemetry tick
   * (about two seconds later) arrives with no task, is read as "this robot has
   * no task", and DELETES the route it just drew. The route was on screen for
   * roughly one tick per redraw, for the whole of every mission.
   *
   * Holding the task here instead makes the absence of a task on a telemetry
   * payload mean what it actually means — that telemetry does not carry tasks —
   * rather than "the task ended". A route is now removed only when something
   * says so: a terminal `TASK_UPDATED`, or the robot leaving the visible set.
   */
  const robotTasksRef = useRef(new Map());

  /**
   * The newest position per robot, ordered by the server's receipt time. Two
   * routes bring a position here — the `robot:update` handler below and the
   * provider's rows, which a REST refetch replaces wholesale — and a refetch
   * answered after a newer socket sample used to move the marker backwards for
   * one tick. See `operational/robotMotion.js`.
   */
  const sampleGateRef = useRef(null);
  if (sampleGateRef.current === null) sampleGateRef.current = createSampleGate();
  /** robotId → the provider row object the sync pass last handed to `upsertMarker`. */
  const lastSyncedRowRef = useRef(new Map());
  /** taskId → the progress state machine's carry-over (see `advanceRouteState`). */
  const routeStateRef = useRef(new Map());
  /** robotId → the findings last computed for its route. */
  const routeFindingsRef = useRef(new Map());
  /** The last findings signature published, so an unchanged set is not re-announced. */
  const findingsSignatureRef = useRef(null);

  /**
   * Route progress for the SELECTED unit only (§3N).
   *
   * State rather than a ref because the information panel renders it, and only
   * for the selected unit because that is the only one whose progress is on
   * screen — putting every robot's progress in React state would re-render the
   * map chrome once per unit per tick to display nothing.
   */
  const [selectedRouteProgress, setSelectedRouteProgress] = useState(null);

  // Read inside imperative callbacks rather than listed as dependencies, so a
  // selection or follow-toggle never tears down and rebuilds marker plumbing.
  const selectedRobotIdRef = useRef(selectedRobotId);
  selectedRobotIdRef.current = selectedRobotId;
  const followSelectedRef = useRef(followSelected);
  followSelectedRef.current = followSelected;
  const onSelectRobotRef = useRef(onSelectRobot);
  onSelectRobotRef.current = onSelectRobot;
  const onHoverRobotRef = useRef(onHoverRobot);
  onHoverRobotRef.current = onHoverRobot;
  const campusFeaturesRef = useRef(campusFeatures);
  campusFeaturesRef.current = campusFeatures;
  const onRouteFindingsRef = useRef(onRouteFindings);
  onRouteFindingsRef.current = onRouteFindings;

  // One renderer instance for the whole overlay, resolved by representation
  // name. `createRobotRenderer` validates the contract at wire-up, so a
  // renderer missing a method fails here rather than on the first telemetry
  // tick of a live fleet view.
  const rendererRef = useRef(null);
  const rendererRepresentationRef = useRef(null);
  const getRenderer = useCallback(() => {
    if (rendererRef.current && rendererRepresentationRef.current === representation) {
      return rendererRef.current;
    }
    // Representation changed (or first use): drop everything the previous
    // renderer owned before standing the new one up. This is the code path a
    // future 2d → 3d switch travels; it exists now so it is not written under
    // pressure later.
    if (rendererRef.current) {
      try {
        rendererRef.current.dispose();
      } catch {
        // ignore
      }
      markersRef?.current?.clear?.();
    }
    rendererRef.current = createRobotRenderer(representation, {
      getMap: () => mapRef?.current || null,
      onSelectRobot: (id) => onSelectRobotRef.current?.(id),
      onHoverRobot: (id) => onHoverRobotRef.current?.(id),
    });
    rendererRepresentationRef.current = representation;
    return rendererRef.current;
  }, [representation, mapRef, markersRef]);

  useEffect(() => {
    return () => {
      try {
        rendererRef.current?.dispose();
      } catch {
        // ignore
      }
      rendererRef.current = null;
      rendererRepresentationRef.current = null;
    };
  }, []);

  // ── The follow camera's two clocks (§3G) ───────────────────────────────────
  //
  //   telemetry  ──► followTargetRef        a value, written ~every 2 000 ms
  //   rAF        ──► stepFollowCamera()     the camera, moved ~60 times a second
  //
  // Separating them is the entire fix. Nothing in the telemetry path issues a
  // camera command, so nothing can interrupt one.
  const followTargetRef = useRef(null);
  const followStateRef = useRef(null);
  const followRafRef = useRef(null);
  const followLastFrameRef = useRef(0);

  const stopFollowLoop = useCallback(() => {
    if (followRafRef.current !== null) {
      try {
        cancelAnimationFrame(followRafRef.current);
      } catch {
        // ignore
      }
      followRafRef.current = null;
    }
    followLastFrameRef.current = 0;
  }, []);

  /**
   * Start the smoothing loop if it is not already running.
   *
   * The loop STOPS ITSELF once the camera is inside the dead band, and this
   * restarts it when a new target arrives. A parked unit therefore costs no
   * frame callbacks at all — which is also what stops its GPS jitter from
   * shivering the camera forever.
   */
  const ensureFollowLoop = useCallback(() => {
    if (followRafRef.current !== null) return;
    if (typeof requestAnimationFrame !== 'function') return;

    const frame = (timestamp) => {
      followRafRef.current = null;
      const map = mapRef?.current;
      if (!map || !followSelectedRef.current) {
        followLastFrameRef.current = 0;
        return;
      }

      const previous = followLastFrameRef.current;
      followLastFrameRef.current = timestamp;
      const dtMs = previous ? timestamp - previous : 16;

      const { state, changed, settled } = stepFollowCamera(followStateRef.current, followTargetRef.current, dtMs, {
        // North stays screen-up. `cameraModes.js` settled that: an operator
        // matching the map against the physical site should not have to redo
        // the rotation in their head, and every robot heading is read against
        // north. The bearing smoothing exists and is tested, so turning this on
        // later is a flag rather than new mathematics.
        followHeading: false,
      });
      followStateRef.current = state;

      if (changed && state) {
        try {
          // `jumpTo`, not `easeTo`. The smoothing IS the easing — asking Mapbox
          // to ease toward a point that moves every frame is what produced the
          // interrupted-tween stutter this loop replaces.
          map.jumpTo({ center: [state.lng, state.lat] });
        } catch {
          // ignore
        }
      }

      if (settled) {
        followLastFrameRef.current = 0;
        return;
      }
      followRafRef.current = requestAnimationFrame(frame);
    };

    followRafRef.current = requestAnimationFrame(frame);
  }, [mapRef]);

  // The loop must not outlive the hook: a frame callback holding a removed map
  // is the classic post-unmount crash.
  useEffect(() => stopFollowLoop, [stopFollowLoop]);

  /**
   * Where this robot was last known to be, as `[lng, lat]`.
   *
   * Read from the last `RobotVisual` handed to the renderer — i.e. from state,
   * through the canonical world transform — never from a marker element. Asking
   * a marker where it is would make the renderer a second source of truth for a
   * position state already owns, and would stop working the moment the
   * representation changed (§Q).
   */
  const lastKnownPoint = useCallback(
    (robotId) => anchorToLngLat(markersRef?.current?.get(robotId)?.visual?.anchor),
    [markersRef]
  );

  const removeRouteForRobot = useCallback(
    (robotId) => {
      const map = mapRef?.current;
      const entry = routesRef.current.get(robotId);
      if (!entry || !map) {
        routesRef.current.delete(robotId);
        return;
      }

      // New progress layers
      safeRemoveLayerAndSource(map, entry.pickupTodoLayerId, entry.pickupTodoSourceId);
      safeRemoveLayerAndSource(map, entry.pickupDoneLayerId, entry.pickupDoneSourceId);
      safeRemoveLayerAndSource(map, entry.dropTodoLayerId, entry.dropTodoSourceId);
      safeRemoveLayerAndSource(map, entry.dropDoneLayerId, entry.dropDoneSourceId);

      // Legacy layers (backward compatibility cleanup)
      safeRemoveLayerAndSource(map, entry.pickupLayerId, entry.pickupSourceId);
      safeRemoveLayerAndSource(map, entry.dropLayerId, entry.dropSourceId);

      try {
        entry.pickupMarker?.remove?.();
      } catch {
        // ignore
      }
      try {
        entry.dropMarker?.remove?.();
      } catch {
        // ignore
      }

      routesRef.current.delete(robotId);
      routeStateRef.current.delete(entry.taskId);
      routeFindingsRef.current.delete(robotId);
    },
    [mapRef]
  );

  /**
   * Publish the current route findings upward (§3D — *report it*).
   *
   * Debounced by content, not by time: the callback fires only when the set of
   * findings actually differs, so a unit driving along a route that crosses a
   * building does not re-render the notice sixty times a minute saying the same
   * sentence.
   */
  const publishFindings = useCallback(() => {
    const handler = onRouteFindingsRef.current;
    if (typeof handler !== 'function') return;
    const summary = summariseRouteFindings([...routeFindingsRef.current.values()]);
    const signature = summary.findings.map((f) => `${f.type}:${f.featureId || ''}:${f.metres ?? ''}`).join('|');
    if (signature === findingsSignatureRef.current) return;
    findingsSignatureRef.current = signature;
    handler(summary);
  }, []);

  /**
   * Record the task a robot is running.
   *
   * The ONLY writer of `robotTasksRef`. Everything that knows about a task —
   * `TASK_ASSIGNED`, a `REROUTED` update, the cached paths replayed for a robot
   * that was already running when the map opened — comes through here, so
   * "which task is this unit on" has exactly one answer and one place to look
   * for it. `pendingSegment` carries a segment the BACKEND stated, to be applied
   * once and then handed back to observation (see `advanceRouteState`).
   */
  const rememberTask = useCallback((robotId, entry) => {
    const id = String(robotId || '').trim();
    const taskId = String(entry?.taskId || '').trim();
    if (!id || !taskId) return null;

    const previous = robotTasksRef.current.get(id) || null;
    const record = {
      ...previous,
      ...entry,
      taskId,
      robotId: id,
      // Bumped whenever the PATHS change, so route validation re-runs on a
      // replan and only on a replan — never on every telemetry tick.
      pathRevision:
        previous && previous.taskId === taskId && previous.pathToPickup === entry.pathToPickup && previous.pathToDrop === entry.pathToDrop
          ? previous.pathRevision || 0
          : (previous?.pathRevision || 0) + 1,
    };
    robotTasksRef.current.set(id, record);
    return record;
  }, []);

  const upsertRoutes = useCallback(
    (robotIdIn, robotPoint) => {
      const map = mapRef?.current;
      if (!map) return;

      const robotId = String(robotIdIn || '').trim();
      if (!robotId) return;

      // The task comes from the record, NOT from the payload that triggered
      // this call. That is the whole fix: a telemetry tick carries no task, and
      // reading "no task" off it used to delete the route (see `robotTasksRef`).
      const record = robotTasksRef.current.get(robotId) || null;
      const taskId = record?.taskId ? String(record.taskId) : '';
      const cached = taskId ? taskPathsRef.current.get(taskId) : null;

      const pathToPickup = record?.pathToPickup || cached?.pathToPickup || null;
      const pathToDrop = record?.pathToDrop || cached?.pathToDrop || null;
      const pickup = record?.pickup ?? cached?.pickup ?? null;
      const drop = record?.drop ?? cached?.drop ?? null;

      const existing = routesRef.current.get(robotId) || null;

      // Reached only when something actually said this robot has no task — a
      // terminal `TASK_UPDATED`, or the unit leaving the visible set.
      if (!taskId) {
        removeRouteForRobot(robotId);
        return;
      }

      const hasBothLegs =
        Array.isArray(pathToPickup) && pathToPickup.length > 0 && Array.isArray(pathToDrop) && pathToDrop.length > 0;

      if (!hasBothLegs) {
        // Same task, paths not (yet) known: keep what is drawn and refresh the
        // mission pins if their coordinates arrived.
        if (existing && existing.taskId === taskId) {
          const pickupLL = toLngLat(pickup);
          const dropLL = toLngLat(drop);
          if (pickupLL && existing.pickupMarker) {
            try {
              existing.pickupMarker.setLngLat(pickupLL);
            } catch {
              // ignore
            }
          }
          if (dropLL && existing.dropMarker) {
            try {
              existing.dropMarker.setLngLat(dropLL);
            } catch {
              // ignore
            }
          }
          return;
        }
        removeRouteForRobot(robotId);
        return;
      }

      const color = colorForRobot(robotId);
      const pickupTodoSourceId = `robot-route-pickup-todo-src-${robotId}`;
      const pickupTodoLayerId = `robot-route-pickup-todo-layer-${robotId}`;
      const pickupDoneSourceId = `robot-route-pickup-done-src-${robotId}`;
      const pickupDoneLayerId = `robot-route-pickup-done-layer-${robotId}`;

      const dropTodoSourceId = `robot-route-drop-todo-src-${robotId}`;
      const dropTodoLayerId = `robot-route-drop-todo-layer-${robotId}`;
      const dropDoneSourceId = `robot-route-drop-done-src-${robotId}`;
      const dropDoneLayerId = `robot-route-drop-done-layer-${robotId}`;

      // ── Progress, from the unit's own position (§3D) ─────────────────────
      //
      // A segment the backend actually stated wins, once. After that the state
      // machine observes: it latches the pickup→drop transition, refuses to run
      // backwards along a route that retraces itself, and reports rather than
      // guesses when the unit is too far off its route to project onto it.
      const point = robotPoint || existing?.lastPoint || null;
      const declaredSegment = record?.pendingSegment || null;
      if (declaredSegment && record) record.pendingSegment = null;

      const state = advanceRouteState(routeStateRef.current.get(taskId) || null, {
        pathToPickup,
        pathToDrop,
        point,
        taskId,
        declaredSegment,
      });
      routeStateRef.current.set(taskId, state);

      // ── The redraw guard (§3T) ───────────────────────────────────────────
      // Everything below writes to Mapbox sources. A stationary unit produces
      // an identical split every tick, and pushing identical GeoJSON into four
      // sources twenty times a minute is work with no output. The signature
      // covers everything that can change what is drawn; `pathRevision` covers
      // a replan that keeps the same task id.
      const signature = [
        taskId,
        record?.pathRevision || 0,
        state.segment,
        state.onRoute ? 1 : 0,
        state.pickupIndex,
        state.dropIndex,
        Math.round((state.fraction ?? 0) * 4000),
      ].join('|');

      // Same route, same split, and its layers really are in the style: nothing to do.
      if (!shouldRedrawRoute(existing, signature, map)) return;

      const pickupDone = lineCollection(state.pickup?.travelled);
      const pickupTodo = lineCollection(state.pickup?.ahead);
      const dropDone = lineCollection(state.drop?.travelled);
      const dropTodo = lineCollection(state.drop?.ahead);

      // Remove legacy layers if they exist (so we don't double-draw after upgrading).
      safeRemoveLayerAndSource(map, existing?.pickupLayerId, existing?.pickupSourceId);
      safeRemoveLayerAndSource(map, existing?.dropLayerId, existing?.dropSourceId);

      // Re-add if style switched (sources/layers removed by map.setStyle).
      // `flow` marks the segments still ahead of the unit — the only ones with
      // a direction left to communicate.
      const theme = themeRef?.current || null;
      const todoOpacity = theme?.routes?.todoOpacity ?? 0.95;
      const doneOpacity = theme?.routes?.doneOpacity ?? 0.3;

      // Beneath the charging stations, so a station a route ends at stays readable on top of it.
      const beforeId = CHARGING_STATION_FLOOR_LAYER;
      if (pickupTodo) ensureLineLayer({ map, sourceId: pickupTodoSourceId, layerId: pickupTodoLayerId, data: pickupTodo, color, dashed: true, opacity: todoOpacity * 0.8, theme, flow: true, beforeId });
      if (pickupDone) ensureLineLayer({ map, sourceId: pickupDoneSourceId, layerId: pickupDoneLayerId, data: pickupDone, color, dashed: true, opacity: doneOpacity * 0.75, theme, flow: false, beforeId });
      if (dropTodo) ensureLineLayer({ map, sourceId: dropTodoSourceId, layerId: dropTodoLayerId, data: dropTodo, color, dashed: false, opacity: todoOpacity, theme, flow: true, beforeId });
      if (dropDone) ensureLineLayer({ map, sourceId: dropDoneSourceId, layerId: dropDoneLayerId, data: dropDone, color, dashed: false, opacity: doneOpacity, theme, flow: false, beforeId });

      // If any segment is absent, remove its layer/source.
      if (!pickupTodo) safeRemoveLayerAndSource(map, pickupTodoLayerId, pickupTodoSourceId);
      if (!pickupDone) safeRemoveLayerAndSource(map, pickupDoneLayerId, pickupDoneSourceId);
      if (!dropTodo) safeRemoveLayerAndSource(map, dropTodoLayerId, dropTodoSourceId);
      if (!dropDone) safeRemoveLayerAndSource(map, dropDoneLayerId, dropDoneSourceId);

      // What this draw was supposed to leave in the style. If the style refused it (still
      // loading), the signature is not recorded, so the next call — the restore on `load` /
      // `style.load`, or the next tick — draws it instead of believing it is already there.
      const drawnLayerIds = [
        pickupTodo && pickupTodoLayerId,
        pickupDone && pickupDoneLayerId,
        dropTodo && dropTodoLayerId,
        dropDone && dropDoneLayerId,
      ].filter(Boolean);
      const drawn = routeLayersPresent(map, drawnLayerIds);

      let pickupMarker = existing?.pickupMarker || null;
      let dropMarker = existing?.dropMarker || null;

      // Place each pin at the PATH ENDPOINT — where the dashed (pickup) and solid (drop)
      // lines actually end — rather than at the task's stated address. On the V1 engine path
      // the route ends at the stop's exact coordinate, so the two coincide; a provider route
      // (which may end on the nearest road) would otherwise leave a gap between line and pin.
      const snapPickupLL = pathToPickup && pathToPickup.length > 0
        ? toLngLat(pathToPickup[pathToPickup.length - 1])
        : toLngLat(pickup);
      const snapDropLL = pathToDrop && pathToDrop.length > 0
        ? toLngLat(pathToDrop[pathToDrop.length - 1])
        : toLngLat(drop);

      if (snapPickupLL) {
        if (!pickupMarker) {
          pickupMarker = new mapboxgl.Marker({
            element: createMissionMarkerEl({ color, label: 'Pickup' }),
            anchor: 'center',
          })
            .setLngLat(snapPickupLL)
            .addTo(map);
          applyMarkerZoomScale(pickupMarker.getElement()?._scaleWrap, map.getZoom());
        } else {
          try { pickupMarker.setLngLat(snapPickupLL); } catch { /* ignore */ }
        }
      }

      if (snapDropLL) {
        if (!dropMarker) {
          dropMarker = new mapboxgl.Marker({
            element: createMissionMarkerEl({ color: '#22c55e', label: 'Drop' }),
            anchor: 'center',
          })
            .setLngLat(snapDropLL)
            .addTo(map);
          applyMarkerZoomScale(dropMarker.getElement()?._scaleWrap, map.getZoom());
        } else {
          try { dropMarker.setLngLat(snapDropLL); } catch { /* ignore */ }
        }
      }

      flowAnimatorRef.current?.start();

      // ── Validate the route against the campus, and REPORT (§3D) ──────────
      //
      // Run when the ROUTE changes, never when progress does: the polyline is
      // the thing being checked and it does not move as the unit travels along
      // it. Re-checking every tick would be the same answer at ~19 000 segment
      // tests a leg.
      //
      // Nothing here alters a route. A crossing is drawn exactly where the
      // route data puts it and reported in words — the brief is explicit that
      // hiding it with rendering is the failure, not the fix.
      const pathRevision = record?.pathRevision || 0;
      if (!existing || existing.validatedRevision !== pathRevision || existing.taskId !== taskId) {
        const features = campusFeaturesRef.current;
        if (Array.isArray(features) && features.length > 0) {
          const pickupCheck = validateRoute({ path: pathToPickup, features, label: 'The approach route' });
          const dropCheck = validateRoute({ path: pathToDrop, features, label: 'The delivery route' });
          routeFindingsRef.current.set(robotId, {
            robotId,
            findings: [...pickupCheck.findings, ...dropCheck.findings],
          });
        } else {
          routeFindingsRef.current.delete(robotId);
        }
      }

      // The unit being off its own route is progress state, not route state, so
      // it is folded in every time rather than only on a replan.
      if (!state.onRoute && state.offsetM !== null) {
        const entryFindings = routeFindingsRef.current.get(robotId) || { robotId, findings: [] };
        const label = state.segment === ROUTE_SEGMENT.TO_DROP ? 'the delivery route' : 'the approach route';
        const offRoute = validateRoute({
          path: state.segment === ROUTE_SEGMENT.TO_DROP ? pathToDrop : pathToPickup,
          features: [],
          label,
          robotOffsetM: state.offsetM,
        }).findings.filter((f) => f.type !== 'DEGENERATE');
        routeFindingsRef.current.set(robotId, {
          robotId,
          findings: [...entryFindings.findings.filter((f) => f.type !== 'ROBOT_OFF_ROUTE'), ...offRoute],
        });
      } else {
        const entryFindings = routeFindingsRef.current.get(robotId);
        if (entryFindings?.findings.some((f) => f.type === 'ROBOT_OFF_ROUTE')) {
          routeFindingsRef.current.set(robotId, {
            robotId,
            findings: entryFindings.findings.filter((f) => f.type !== 'ROBOT_OFF_ROUTE'),
          });
        }
      }
      publishFindings();

      const progress = {
        taskId,
        segment: state.segment,
        onRoute: state.onRoute,
        offsetM: state.offsetM,
        remainingM: state.remainingM,
        fraction: state.fraction,
      };
      // Only the selected unit's progress reaches React. Reached at most once
      // per tick, and only when the signature guard above has already proved
      // something actually changed.
      if (selectedRobotIdRef.current === robotId) setSelectedRouteProgress(progress);

      routesRef.current.set(robotId, {
        taskId,
        signature: drawn ? signature : null,
        drawnLayerIds,
        validatedRevision: pathRevision,
        lastPoint: point,
        // The progress an operator can be shown, kept beside the geometry it
        // was derived from so the panel reads state rather than re-deriving it.
        progress,
        pickupTodoSourceId,
        pickupTodoLayerId,
        pickupDoneSourceId,
        pickupDoneLayerId,
        dropTodoSourceId,
        dropTodoLayerId,
        dropDoneSourceId,
        dropDoneLayerId,
        pickupMarker,
        dropMarker,
      });
    },
    [mapRef, removeRouteForRobot, themeRef, publishFindings]
  );

  // ── Route flow animation ───────────────────────────────────────────────────
  // Owns its own lifecycle: started by the first route drawn, stopped when the
  // last one is removed or the map unmounts.
  useEffect(() => {
    let reduced = prefersReducedMotion();
    const animator = createFlowAnimator(
      () => mapRef?.current || null,
      () => {
        const ids = [];
        for (const entry of routesRef.current.values()) {
          for (const layerId of [entry?.pickupTodoLayerId, entry?.dropTodoLayerId]) {
            if (layerId) ids.push(`${layerId}-flow`);
          }
        }
        return ids;
      },
      { reducedMotion: () => reduced, visible: documentVisible }
    );
    flowAnimatorRef.current = animator;
    if (routesRef.current.size > 0) animator.start();
    const unsubscribe = subscribeReducedMotion((next) => {
      reduced = next;
      if (next) animator.stop();
      else if (routesRef.current.size > 0) animator.start();
    });

    return () => {
      unsubscribe();
      animator.stop();
      flowAnimatorRef.current = null;
    };
  }, [mapRef]);

  // ── Theme frames → route colours ───────────────────────────────────────────
  // Route GEOMETRY and route PROGRESS are untouched by this; only the corridor
  // halo and the flow overlay are re-coloured, on layers that already exist.
  useEffect(() => {
    if (typeof subscribeToTheme !== 'function') return;
    return subscribeToTheme((theme) => {
      applyThemeToRouteLayers(mapRef?.current, routesRef.current.values(), theme);
    });
  }, [subscribeToTheme, mapRef]);

  // Cache task routes once.
  // On mount: seed taskPathsRef from AppProvider's persistent cache so routes
  // are drawn even if TASK_ASSIGNED fired before this component mounted.
  useEffect(() => {
    const cache = taskPathCacheRef?.current;
    if (!cache || cache.size === 0) return;
    for (const [taskId, entry] of cache.entries()) {
      if (!taskPathsRef.current.has(taskId)) {
        taskPathsRef.current.set(taskId, entry);
      }
    }
  // Run once on mount — ref contents don't cause re-renders.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // FS-04 — a task has one robot. When the backend names the robot for a task, any other
    // robot this map still ties to it (the one it was reassigned from) loses the task and
    // its route line, instead of keeping both drawn.
    const releaseFromOtherRobots = (taskId, robotId) => {
      if (!taskId || !robotId) return;
      for (const [otherId, record] of robotTasksRef.current.entries()) {
        if (otherId === robotId || String(record?.taskId || '') !== taskId) continue;
        robotTasksRef.current.delete(otherId);
        removeRouteForRobot(otherId);
      }
    };

    const onAssigned = (msg) => {
      const taskId = String(msg?.taskId || '').trim();
      const robotId = String(msg?.robotId || '').trim();
      if (!taskId) return;
      releaseFromOtherRobots(taskId, robotId);

      const pathToPickup = Array.isArray(msg?.pathToPickup) ? msg.pathToPickup : null;
      const pathToDrop = Array.isArray(msg?.pathToDrop) ? msg.pathToDrop : null;
      if (!pathToPickup || !pathToDrop) return;

      const entry = {
        taskId,
        robotId: robotId || null,
        pickup: msg?.pickup ?? null,
        drop: msg?.drop ?? null,
        pathToPickup,
        pathToDrop,
      };

      taskPathsRef.current.set(taskId, entry);
      // Also keep the AppProvider cache in sync.
      if (taskPathCacheRef?.current) taskPathCacheRef.current.set(taskId, entry);

      if (robotId) {
        // The task is recorded FIRST and unconditionally. It used to be handed
        // straight to the renderer and then forgotten, which is why the next
        // telemetry tick could not find it (see `robotTasksRef`).
        rememberTask(robotId, {
          ...entry,
          // The engine has just said this unit is heading for the pickup. That
          // is a statement, so it wins once; from there the progress state
          // machine observes the transition to the drop leg itself, because
          // nothing on the wire ever announces it.
          pendingSegment: ROUTE_SEGMENT.TO_PICKUP,
        });

        if (activeRobotIdsRef.current.has(robotId)) {
          upsertRoutes(robotId, lastKnownPoint(robotId));
        } else {
          // Robot not yet in the active set (e.g. the operator navigated to the
          // map after the assignment). Activate it so the next telemetry tick
          // updates its marker — and the route is already on record.
          activeRobotIdsRef.current.add(robotId);
        }
      }

      // Auto-fit map to show the full route (robot → pickup → drop)
      const map = mapRef?.current;
      if (map) {
        fitRouteBounds(map, [...pathToPickup, ...pathToDrop]);
      }
    };

    // Single handler for all TASK_UPDATED cases — previously split across two
    // useEffects which caused two subscriptions to the same event per render.
    const onTaskUpdated = (msg) => {
      const taskId = String(msg?.taskId || '').trim();
      const robotId = String(msg?.robotId || '').trim();

      // Case A: task reached a terminal status — remove route overlays.
      //
      // This, and a robot leaving the visible set, are now the ONLY two things
      // that delete a route. Forgetting the task record is what makes the
      // removal stick: without it the next cache replay would draw it again.
      if (isTerminalTaskStatus(msg?.status)) {
        if (robotId) {
          robotTasksRef.current.delete(robotId);
          removeRouteForRobot(robotId);
        }
        // The finished task's paths leave this hook's cache too (the provider's replayed
        // cache is evicted by AppProvider), so nothing here can redraw it.
        if (taskId) taskPathsRef.current.delete(taskId);
        return;
      }

      // Case A′: the unit acknowledged a RECALL / WITHDRAW and stood down. The task is not
      // finished — it goes back to the queue — but this unit's route describes nothing it is
      // doing any more, so it goes, unless the record has already moved to another task.
      const stoodDown = standDownRobot(msg);
      if (stoodDown) {
        const record = robotTasksRef.current.get(stoodDown);
        if (!record || String(record.taskId || '') === taskId) {
          robotTasksRef.current.delete(stoodDown);
          removeRouteForRobot(stoodDown);
        }
        const cached = taskId ? taskPathsRef.current.get(taskId) : null;
        if (cached && String(cached.robotId || '') === stoodDown) taskPathsRef.current.delete(taskId);
        return;
      }

      // A non-terminal update naming the task's robot (an assignment or a reassignment).
      releaseFromOtherRobots(taskId, robotId);

      // Case B: backend replanned a segment after an obstacle.
      if (msg?.action !== 'REROUTED') return;

      const newPath = Array.isArray(msg?.newPath) ? msg.newPath : null;
      const segment = typeof msg?.segment === 'string' ? msg.segment : 'toPickup';
      if (!taskId || !newPath) return;

      const cached = taskPathsRef.current.get(taskId);
      if (cached) {
        const updated = {
          ...cached,
          ...(segment === 'toPickup' ? { pathToPickup: newPath } : { pathToDrop: newPath }),
        };
        taskPathsRef.current.set(taskId, updated);

        if (robotId) {
          // A replan is the backend stating which leg it just recomputed, so
          // that segment wins over whatever this session had observed.
          rememberTask(robotId, {
            ...updated,
            pendingSegment: segment === 'toPickup' ? ROUTE_SEGMENT.TO_PICKUP : ROUTE_SEGMENT.TO_DROP,
          });
          if (activeRobotIdsRef.current.has(robotId)) {
            upsertRoutes(robotId, lastKnownPoint(robotId));
          }
        }
      }
    };

    // PHASE 15 — `TASK_ASSIGNED` (capitals) still carries a drawable route and is
    // still the right event for this hook: it fires after a real decision, when
    // there is a path to render. The lower-case `task_assigned` echo carries a
    // PENDING task with a null robot and nothing to draw, which is why the map does
    // not subscribe to it. Both names are catalogued in `lib/socket.js`.
    socket.on(DASHBOARD_EVENTS.TASK_ASSIGNED, onAssigned);
    socket.on(DASHBOARD_EVENTS.TASK_UPDATED, onTaskUpdated);
    return () => {
      socket.off(DASHBOARD_EVENTS.TASK_ASSIGNED, onAssigned);
      socket.off(DASHBOARD_EVENTS.TASK_UPDATED, onTaskUpdated);
    };
  }, [upsertRoutes, removeRouteForRobot, rememberTask, lastKnownPoint, mapRef, taskPathCacheRef]);

  /**
   * Draw every held route that is not actually on the map.
   *
   * The routes are held in state (`robotTasksRef`, `taskPathsRef`, the
   * provider's cache), never only in Mapbox, so a style that lost its layers
   * — a fresh map on returning to this page, a style reload — is refilled
   * from state. Routes already intact are skipped by the redraw guard, so
   * this is safe to call at any time and costs nothing when nothing is
   * missing. It waits for no telemetry: a robot standing still gets its route
   * back as soon as the style can take it.
   */
  const restoreRoutes = useCallback(() => {
    const map = mapRef?.current;
    if (!map) return;
    for (const robotId of [...robotTasksRef.current.keys()]) {
      if (!activeRobotIdsRef.current.has(robotId)) continue;
      upsertRoutes(robotId, lastKnownPoint(robotId));
    }
  }, [mapRef, upsertRoutes, lastKnownPoint]);

  // `style.load` — the style can take layers (the first load on a new map, or after any
  // `setStyle`, which discards every source and layer this hook added).
  useEffect(() => {
    const map = mapRef?.current;
    if (!map) return;

    try {
      map.on('style.load', restoreRoutes);
    } catch {
      // ignore
    }

    return () => {
      try {
        map.off('style.load', restoreRoutes);
      } catch {
        // ignore
      }
    };
  }, [mapRef, restoreRoutes]);

  // `load` — the second chance, for a style whose `style.load` fired before this hook listened.
  useEffect(() => {
    if (isMapLoaded) restoreRoutes();
  }, [isMapLoaded, restoreRoutes]);

  // ── Camera → overlay reprojection ──────────────────────────────────────────
  //
  // Three separate reasons a marker must respond to the camera now that the
  // environment is 3D:
  //
  //   zoom     Fixed-pixel markers stay the same SCREEN size at any zoom, so at
  //            low zoom a 26×36px icon can cover hundreds of metres of ground,
  //            making an exactly-correct coordinate look like it is floating off
  //            the road. Shrinking as you zoom out (mirrors Uber/Swiggy) keeps
  //            it visually anchored at every zoom level.
  //   pitch    The ground half of the marker is foreshortened by cos(pitch) so
  //            it reads as lying on the ground rather than standing on it.
  //   bearing  A robot's heading is degrees from true NORTH. Once the camera can
  //            rotate, north is no longer screen-up, so the icon's rotation must
  //            be re-derived — otherwise every robot on the map points the wrong
  //            way the instant the operator rotates the view.
  //
  // This is reprojection, not reconstruction: it only writes CSS transforms onto
  // already-mounted elements, and it is driven by camera events, never by
  // telemetry. Environment geometry is untouched.
  useEffect(() => {
    const map = mapRef?.current;
    if (!map) return;

    const applyToAll = () => {
      let camera;
      try {
        camera = { zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() };
      } catch {
        return;
      }

      const renderer = rendererRef.current;
      if (renderer) {
        for (const entry of markersRef?.current?.values() || []) {
          if (entry?.handle) renderer.applyCamera(entry.handle, camera);
        }
      }

      // Mission (pickup/drop) pins have no ground half — they are pure
      // screen-space badges, so zoom scale is all they need.
      for (const entry of routesRef.current.values()) {
        applyMarkerZoomScale(entry?.pickupMarker?.getElement?.()?._scaleWrap, camera.zoom);
        applyMarkerZoomScale(entry?.dropMarker?.getElement?.()?._scaleWrap, camera.zoom);
      }
    };

    applyToAll();

    const events = ['zoom', 'pitch', 'rotate'];
    for (const evt of events) {
      try {
        map.on(evt, applyToAll);
      } catch {
        // ignore
      }
    }

    return () => {
      for (const evt of events) {
        try {
          map.off(evt, applyToAll);
        } catch {
          // ignore
        }
      }
    };
  }, [mapRef, markersRef]);

  /**
   * Robot state → the operational overlay, via the rendering seam.
   *
   * The whole of this function is representation-agnostic. It builds the
   * semantic `RobotVisual` (which carries the canonically-transformed world
   * anchor) and hands it to whichever renderer is registered. There is no 2D
   * geometry, no DOM, no marker API and no position arithmetic left here —
   * all of that moved behind the renderer contract, which is what makes a
   * future 3D robot a renderer swap rather than an edit to this file.
   */
  const upsertMarker = useCallback(
    (robot) => {
      const map = mapRef?.current;
      const store = markersRef?.current;
      if (!map || !store) return;

      // Newest position wins (see `sampleGateRef`). The rest of this state — status,
      // battery, task — is applied as it is: a REST row can be older in position and newer
      // in status, which is the database's to say.
      const robotKey = String(robot?.robotId || '').trim();
      const resolved = sampleGateRef.current.resolve(robotKey, {
        t: sampleTimeOf(robot),
        lngLat: [robot?.lon, robot?.lat],
        heading: robot?.heading,
      });
      // No usable position, now or before — deliberately not placed. Never fall back to an
      // origin coordinate, which would draw a robot in the Gulf of Guinea.
      if (!resolved.lngLat) return;
      const positioned =
        resolved.lngLat[0] === robot.lon && resolved.lngLat[1] === robot.lat && resolved.heading === robot.heading
          ? robot
          : { ...robot, lon: resolved.lngLat[0], lat: resolved.lngLat[1], heading: resolved.heading };

      // The ONE transform from robot state to world position and semantics.
      const visual = toRobotVisual(positioned, {
        selectedRobotId: selectedRobotIdRef.current,
        representation,
      });
      if (!visual) return;
      // When the server received this position — the renderer measures the stream's cadence from it.
      visual.sampleTime = resolved.t;

      const renderer = getRenderer();
      let entry = store.get(visual.id);

      if (!entry) {
        const handle = renderer.mount(visual);
        if (!handle) return;
        entry = { representation, handle, visual };
        store.set(visual.id, entry);
      } else {
        renderer.update(entry.handle, visual);
        // The last visual is retained so the hook can answer "where is this
        // robot?" from state rather than by reading a coordinate back out of
        // the renderer — see `recenter` and the follow camera below.
        entry.visual = visual;
      }

      const lngLat = anchorToLngLat(visual.anchor);

      // A robot state that carries its own task — a REST row's `currentTask` —
      // registers it. Telemetry carries none and simply says nothing, which is
      // now read as "telemetry does not carry tasks" rather than as "the task
      // ended".
      const carried = robot?.task || robot?.currentTask;
      // A row read before the task finished can still name it; a finished task is not re-registered.
      if (carried?.taskId && !isTerminalTaskStatus(carried.status)) rememberTask(visual.id, { ...carried, taskId: String(carried.taskId) });

      // Routes are a separate operational overlay keyed by task, not part of
      // the robot's representation — a 3D robot would not change any of this.
      // The position is passed in because route PROGRESS is now derived from it
      // (§3D); the route itself still comes from the task record.
      upsertRoutes(visual.id, lngLat);

      // ── Follow-selected camera (§3G) ─────────────────────────────────────
      //
      // A telemetry tick updates a TARGET and nothing else. It issues no camera
      // command, so it cannot interrupt one — which is what the previous
      // `easeTo` per tick did, restarting a 1 200 ms ease every ~2 000 ms and
      // producing a camera that accelerated, was cut off, and accelerated
      // again. The frame loop below closes the gap continuously.
      //
      // It still tracks the robot's WORLD TRANSFORM, taken from the canonical
      // anchor — not a marker element, not a mesh — so it keeps working
      // verbatim under a 3D renderer.
      if (followSelectedRef.current && selectedRobotIdRef.current === visual.id && lngLat) {
        followTargetRef.current = { lng: lngLat[0], lat: lngLat[1], bearing: visual.anchor.rotation.yaw };
        ensureFollowLoop();
      }
    },
    [mapRef, markersRef, upsertRoutes, rememberTask, ensureFollowLoop, getRenderer, representation]
  );

  const syncMarkersToRobots = useCallback(
    (list) => {
      const map = mapRef?.current;
      const store = markersRef?.current;
      if (!map || !store) return;

      const nextIds = new Set();
      for (const r of Array.isArray(list) ? list : []) {
        const robotId = String(r?.robotId || '').trim();
        if (!robotId) continue;
        nextIds.add(robotId);
        // The provider replaces only the row that changed (`prev.map`), so an identical
        // object means nothing new for this robot. Every telemetry tick used to re-run the
        // marker and route projection for EVERY robot here; now it is the one that moved.
        if (store.has(robotId) && lastSyncedRowRef.current.get(robotId) === r) continue;
        lastSyncedRowRef.current.set(robotId, r);
        // The row's own fields win over `live`. `live` is the telemetry snapshot the
        // REST load carried and nothing refreshes it afterwards, while the row's
        // lat/lon/battery/status are kept current by every `robot:update`. Letting the
        // snapshot win re-sent a moving robot's load-time position on every tick, and
        // once it stopped its marker settled back where it had started (measured:
        // 49.6 m from the robot, 2.8 m from its starting point). `live` still fills in
        // anything the row lacks.
        upsertMarker(r?.live && typeof r.live === 'object' ? { ...r.live, ...r } : r);
      }

      // Remove stale visuals for robots not in the current filter. The renderer
      // owns teardown of whatever it created (elements, listeners, in-flight
      // animations) — this loop never touches marker internals.
      const renderer = rendererRef.current;
      for (const [id, entry] of store.entries()) {
        if (nextIds.has(id)) continue;
        try {
          renderer?.destroy(entry?.handle);
        } catch {
          // ignore
        }
        store.delete(id);
        lastSyncedRowRef.current.delete(id);
        sampleGateRef.current.forget(id);
        // Out of the visible set: forget the task too, or the next cache replay
        // would redraw a route for a unit that is no longer on the map.
        robotTasksRef.current.delete(id);
        removeRouteForRobot(id);
      }
      publishFindings();

      activeRobotIdsRef.current = nextIds;
    },
    [mapRef, markersRef, upsertMarker, removeRouteForRobot, publishFindings]
  );

  // Sync map markers from the global robots list whenever it changes or the
  // location filter changes.
  //
  // ── FE-10: every robot with real coordinates, filter or no filter ─────────
  // This effect used to clear every marker at world view (no filter picked) and,
  // once any filter was picked, show every robot anyway — it never filtered by
  // geography. The gate only hid robots, and on a deployment whose location
  // hierarchy has no country/campus rows (the V1 demonstration world has none)
  // no filter could ever be picked, so the map showed no robot at all.
  //
  // Robots are not filtered by the location/campus selection here, because the
  // robot rows do not establish that relationship reliably (a unit's `Location`
  // is where it was commissioned, not where it is), and claiming a unit belongs
  // to a campus it may not be on is worse than showing it. The filter drives the
  // camera; the markers are the fleet, at the coordinates the backend reports.
  useEffect(() => {
    const map = mapRef?.current;
    if (!map) return;

    // First, what is drawn must still be backed by the provider's route cache: a terminal
    // task the map never heard about (it was disconnected when it finished) was evicted by
    // the refetch that follows the reconnect, and that refetch is what re-runs this effect.
    // Done before the markers sync, so no stale record is drawn from on the way.
    if (taskPathCacheRef?.current) {
      const stale = staleMapRoutes(
        { rendered: routesRef.current, records: robotTasksRef.current, localPaths: taskPathsRef.current },
        taskPathCacheRef.current,
      );
      for (const { robotId, taskId, finished } of stale) {
        robotTasksRef.current.delete(robotId);
        if (finished) taskPathsRef.current.delete(taskId);
        removeRouteForRobot(robotId);
      }
    }

    // Only coordinates the backend actually reported — never a default position.
    const list = (Array.isArray(globalRobots) ? globalRobots : []).filter(
      (r) => Number.isFinite(r?.lat) && Number.isFinite(r?.lon)
    );

    setRobots(list);
    syncMarkersToRobots(list);

    // After markers are placed, draw any routes we have cached but haven't
    // drawn yet (e.g. TASK_ASSIGNED fired while user was on a different page).
    // A finished task is not in this cache (AppProvider evicts it), so it cannot come back here.
    if (taskPathCacheRef?.current) {
      const replay = replayableRoutes(taskPathCacheRef.current, {
        activeRobotIds: activeRobotIdsRef.current,
        drawnRobotIds: routesRef.current,
      });
      for (const { taskId, robotId, pathToPickup, pathToDrop, pickup, drop } of replay) {
        // No `pendingSegment`: this is a REPLAY of an assignment that may have
        // happened minutes ago, not the engine saying where the unit is now.
        // Declaring TO_PICKUP here would drag the drawn progress back to the
        // start of a leg the unit has already finished — the state machine
        // works out which leg it is on from where it actually is.
        rememberTask(robotId, { taskId, robotId, pathToPickup, pathToDrop, pickup, drop });
        upsertRoutes(robotId, lastKnownPoint(robotId));
      }
    }
  }, [
    countryId,
    stateId,
    cityId,
    locationId,
    campusId,
    globalRobots,
    mapRef,
    syncMarkersToRobots,
    upsertRoutes,
    rememberTask,
    lastKnownPoint,
    removeRouteForRobot,
    taskPathCacheRef,
  ]);

  // Live updates via Socket.IO
  useEffect(() => {
    const handler = (data) => {
      const robotId = String(data?.robotId || '').trim();
      if (!robotId) return;

      // Only update markers we are currently tracking (active filter).
      if (!activeRobotIdsRef.current.has(robotId)) return;

      // One call. Battery, status, heading and position all travel on the
      // RobotVisual now, and the renderer updates them in place — no second
      // pass into marker internals, and no marker is ever recreated.
      upsertMarker(data);

      // Keep local list in sync (light update).
      setRobots((prev) => {
        const list = Array.isArray(prev) ? prev : [];
        const idx = list.findIndex((r) => String(r?.robotId || '').trim() === robotId);
        if (idx < 0) return list;

        const current = list[idx];
        const next = {
          ...current,
          lat: typeof data?.lat === 'number' ? data.lat : current.lat,
          lon: typeof data?.lon === 'number' ? data.lon : current.lon,
          // Heading is read back by the UI layer (the selected-robot panel), so
          // it has to stay live here too — the marker gets it via the anchor,
          // but this list is what the panel renders from.
          heading: typeof data?.heading === 'number' ? data.heading : current.heading,
          battery: typeof data?.battery === 'number' ? data.battery : current.battery,
          speed: typeof data?.speed === 'number' ? data.speed : current.speed,
          status: typeof data?.status === 'string' ? data.status : current.status,
          isOnline: typeof data?.isOnline === 'boolean' ? data.isOnline : current.isOnline,
          live: data,
        };

        const copy = list.slice();
        copy[idx] = next;
        return copy;
      });
    };

    // Subscribe to the single canonical telemetry event only.
    // "robot_update" and "ROBOT_UPDATE" were legacy aliases; subscribing to all
    // three was firing the same handler 3× per tick. TASK_UPDATED is now
    // handled exclusively in the TASK_ASSIGNED useEffect above.
    socket.on('robot:update', handler);

    return () => {
      socket.off('robot:update', handler);
    };
  }, [upsertMarker, markersRef]);

  // Add newly commissioned robots to the map immediately, bypassing the location filter.
  useEffect(() => {
    const onCommissioned = (data) => {
      const robotId = String(data?.robotId || '').trim();
      if (!robotId) return;

      // Activate so subsequent live telemetry updates are processed.
      activeRobotIdsRef.current.add(robotId);

      // Create marker right away.
      upsertMarker(data);

      // Seed the local robot list so the sidebar / counts reflect the new unit.
      setRobots((prev) => {
        const list = Array.isArray(prev) ? prev : [];
        if (list.some((r) => String(r?.robotId || '').trim() === robotId)) return list;
        return [...list, data];
      });
    };

    socket.on('ROBOT_COMMISSIONED', onCommissioned);
    return () => {
      socket.off('ROBOT_COMMISSIONED', onCommissioned);
    };
  }, [upsertMarker]);

  // ── Selection → renderer ───────────────────────────────────────────────────
  //
  // Selection is application state (MapProvider). This effect is the only thing
  // that pushes it at pixels, and it does so through the renderer contract, so
  // the exact same `selectedRobotId` highlights a 3D robot later with no change
  // to how selection is stored, set or cleared (§19).
  //
  // It touches only the two robots whose selected-ness actually changed, so
  // clicking a robot in a hundred-unit fleet is two DOM writes, not a resync.
  useEffect(() => {
    const renderer = rendererRef.current;
    const store = markersRef?.current;
    if (!renderer || !store) return;

    for (const [id, entry] of store.entries()) {
      const isSelected = id === selectedRobotId;
      if (entry.visual) {
        if (entry.visual.selected === isSelected) continue;
        entry.visual = { ...entry.visual, selected: isSelected };
      }
      try {
        renderer.setSelected(entry.handle, isSelected);
      } catch {
        // ignore
      }
    }
    // Selection only. Robots mounted *after* a selection change already come up
    // correct, because `upsertMarker` reads the same id off `selectedRobotIdRef`
    // when it builds their visual — so depending on the robot list here would
    // re-walk the fleet on every telemetry tick to do nothing.
  }, [selectedRobotId, markersRef]);

  // Selecting a unit must show the route progress it ALREADY has, not wait for
  // its next tick — and deselecting must not leave the previous unit's progress
  // on screen (§3F: selection preserves context, it does not fabricate it).
  useEffect(() => {
    setSelectedRouteProgress(selectedRobotId ? routesRef.current.get(selectedRobotId)?.progress || null : null);
  }, [selectedRobotId]);

  // ── Entering and leaving Follow (§3G) ──────────────────────────────────────
  //
  // Entering is ONE deliberate framing move — travel to the unit and settle at
  // a comfortable pitch — and the smoothing loop takes over when it lands. That
  // ordering matters: `jumpTo` cancels an in-flight `easeTo`, so starting the
  // loop first would kill the arrival flight on its first frame and the camera
  // would cut to the robot instead of travelling to it.
  //
  // Leaving is instant, in one statement, with no animation to sit through —
  // §3G: *The user must be able to exit Follow mode instantly.*
  useEffect(() => {
    const map = mapRef?.current;
    if (!map) return;

    if (!followSelected || !selectedRobotId) {
      stopFollowLoop();
      followStateRef.current = null;
      followTargetRef.current = null;
      return;
    }

    const lngLat = anchorToLngLat(markersRef?.current?.get(selectedRobotId)?.visual?.anchor);
    if (!lngLat) return;

    followTargetRef.current = { lng: lngLat[0], lat: lngLat[1] };

    let cancelled = false;
    const handOverToLoop = () => {
      if (cancelled) return;
      let camera = { lng: lngLat[0], lat: lngLat[1], bearing: 0 };
      try {
        const c = map.getCenter();
        camera = { lng: c.lng, lat: c.lat, bearing: map.getBearing() };
      } catch {
        // ignore — the seeded target is a usable starting point
      }
      followStateRef.current = createFollowCameraState(camera);
      ensureFollowLoop();
    };

    try {
      map.easeTo({
        center: lngLat,
        // The operator's own tilt is respected and only bounded — a follow
        // camera that overrides a deliberate camera choice is worse than one
        // that is a few degrees off (§3G: "pitch should remain comfortable").
        pitch: comfortableFollowPitch(map.getPitch(), null),
        duration: 900,
        essential: true,
      });
      map.once('moveend', handOverToLoop);
    } catch {
      handOverToLoop();
    }

    return () => {
      cancelled = true;
      stopFollowLoop();
    };
  }, [followSelected, selectedRobotId, mapRef, markersRef, ensureFollowLoop, stopFollowLoop]);

  const robotCount = useMemo(() => (Array.isArray(robots) ? robots.length : 0), [robots]);

  // Manual "snap back" for when the user has panned/zoomed out far enough
  // that markers no longer read as sitting on their roads (an inherent
  // limit of any slippy map at very low zoom — see fixed-pixel marker note
  // above). Frames every currently visible robot + its pickup/drop pins,
  // same logic as the auto-fit run on TASK_ASSIGNED.
  const recenter = useCallback(() => {
    const map = mapRef?.current;
    if (!map) return false;

    const points = [];
    // Robot positions come from the last RobotVisual we sent to the renderer —
    // i.e. from state, through the canonical world transform. Asking the marker
    // where it is would make the renderer a second source of truth for a
    // position state already owns, and would stop working the moment the
    // representation changed (§16).
    for (const entry of markersRef?.current?.values() || []) {
      const ll = anchorToLngLat(entry?.visual?.anchor);
      if (ll) points.push({ lat: ll[1], lon: ll[0] });
    }
    for (const entry of routesRef.current.values()) {
      for (const m of [entry?.pickupMarker, entry?.dropMarker]) {
        try {
          const ll = m?.getLngLat?.();
          if (ll) points.push({ lat: ll.lat, lon: ll.lng });
        } catch {
          // ignore
        }
      }
    }

    return fitRouteBounds(map, points, { maxZoom: 17, duration: 900 });
  }, [mapRef, markersRef]);

  return {
    robots,
    robotCount,
    recenter,
    /** The selected unit's live progress along its route, or null (§3N). */
    selectedRouteProgress,
  };
}
