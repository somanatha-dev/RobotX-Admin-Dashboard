/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ROUTE GEOMETRY — where on its route a robot actually is
 *
 *      route polyline (from the task)        robot position (from telemetry)
 *                    │                                   │
 *                    └──────────────┬────────────────────┘
 *                                   ▼
 *                       projectOntoPath()          ← this module
 *                                   │
 *                        { index, t, alongM, offsetM }
 *                                   │
 *                       splitPathAtProjection()
 *                                   │
 *                    ┌──────────────┴──────────────┐
 *                    ▼                             ▼
 *              route TRAVELLED                route AHEAD
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 * The map already drew "travelled" and "ahead" as two differently-styled lines,
 * split at a `task.pathIndex`. That index is real — it lives on the simulation's
 * own state and on the routing service's — and it is NEVER SENT TO THE BROWSER.
 * `robot:update` carries `robotId, lat, lon, battery, status, speed, isOnline,
 * lastSeenAt, heading` and nothing else; `TASK_ASSIGNED` carries the paths but
 * no progress. So the split index arriving at the renderer was always 0, and
 * "route travelled" was permanently a zero-length stub while "route ahead" was
 * permanently the whole route — for the entire duration of every task.
 *
 * The fix is deliberately on THIS side of the wire (§"do not modify backend
 * operational logic"). The robot's position is already streamed, the route is
 * already held, and where a point falls on a polyline is arithmetic. Nothing
 * here asks the backend for anything, changes a navigation semantic, moves a
 * robot, or edits a path: it reads two things the map already has and computes
 * a third from them.
 *
 * ── What the offset is for ────────────────────────────────────────────────
 * `offsetM` — how far the robot is from the line it is supposedly following —
 * is returned, not hidden. A robot 60 m off its own route is a real operational
 * fact, and a progress indicator that silently snaps it to the nearest point
 * would erase exactly the signal an operator needs. Consumers decide what to do
 * with it; this module reports it.
 *
 * Pure module: no React, no Mapbox, no `@/` alias — loadable under plain Node.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Metres per degree at a latitude. Local planar; sub-metre at campus scale. */
function metresPerDegree(lat) {
  return { x: 111320 * Math.cos((lat * Math.PI) / 180), y: 110574 };
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Read one route point.
 *
 * The system produces both shapes and always has: task paths are arrays of
 * `{ lat, lon }`, GeoJSON coordinates are `[lon, lat]`. Accepting both here is
 * what stops a second, silently lat/lon-swapped reader appearing downstream.
 */
export function toLonLat(point) {
  if (!point) return null;
  if (Array.isArray(point)) {
    return point.length >= 2 && isFiniteNumber(point[0]) && isFiniteNumber(point[1])
      ? [point[0], point[1]]
      : null;
  }
  if (isFiniteNumber(point.lon) && isFiniteNumber(point.lat)) return [point.lon, point.lat];
  if (isFiniteNumber(point.lng) && isFiniteNumber(point.lat)) return [point.lng, point.lat];
  return null;
}

/** A route (either shape) → an array of `[lon, lat]`, dropping unusable points. */
export function pathToCoordinates(path) {
  const out = [];
  for (const p of Array.isArray(path) ? path : []) {
    const ll = toLonLat(p);
    if (ll) out.push(ll);
  }
  return out;
}

/** Planar distance in metres between two `[lon, lat]` positions. */
export function metresBetween(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return Infinity;
  const { x: kx, y: ky } = metresPerDegree((a[1] + b[1]) / 2);
  return Math.hypot((a[0] - b[0]) * kx, (a[1] - b[1]) * ky);
}

/** Total ground length of a route, in metres. */
export function pathLengthMetres(coords) {
  const list = Array.isArray(coords) ? coords : [];
  let total = 0;
  for (let i = 1; i < list.length; i += 1) total += metresBetween(list[i - 1], list[i]);
  return total;
}

/**
 * Project a point onto the closest point of a polyline.
 *
 * @param {[number,number]} point   `[lon, lat]`
 * @param {Array<[number,number]>} coords  the polyline
 * @param {object} [options]
 * @param {number} [options.minIndex=0]
 *        Refuse to report progress earlier than this segment.
 *
 *        Routes on a campus double back — the drop path frequently retraces the
 *        pickup path along the same service road — so the geometrically nearest
 *        point can be one the robot passed two minutes ago. Snapping there would
 *        make the travelled line jump backwards while the robot moves forwards.
 *        The caller carries the last index it saw and passes it here, which
 *        makes progress monotonic without this module holding any state.
 *
 * @returns {null | {
 *   index: number,       // index of the segment's FIRST vertex
 *   t: number,           // 0..1 along that segment
 *   position: [number, number],
 *   offsetM: number,     // perpendicular distance from the route
 *   alongM: number,      // distance travelled along the route to this point
 *   totalM: number,
 *   fraction: number,    // alongM / totalM, 0..1
 * }}
 */
export function projectOntoPath(point, coords, { minIndex = 0 } = {}) {
  const list = Array.isArray(coords) ? coords : [];
  const p = toLonLat(point);
  if (!p || list.length === 0) return null;

  if (list.length === 1) {
    return {
      index: 0,
      t: 0,
      position: [list[0][0], list[0][1]],
      offsetM: metresBetween(p, list[0]),
      alongM: 0,
      totalM: 0,
      fraction: 0,
    };
  }

  // One local planar frame for the whole computation, taken at the point being
  // projected. Mixing per-segment frames would make distances along a route
  // very slightly inconsistent with distances across it.
  const { x: kx, y: ky } = metresPerDegree(p[1]);
  const px = p[0] * kx;
  const py = p[1] * ky;

  const floor = Math.max(0, Math.min(list.length - 2, Math.floor(isFiniteNumber(minIndex) ? minIndex : 0)));

  let best = null;
  let cumulative = 0;
  const prefix = [0];
  for (let i = 1; i < list.length; i += 1) {
    cumulative += metresBetween(list[i - 1], list[i]);
    prefix.push(cumulative);
  }

  for (let i = floor; i < list.length - 1; i += 1) {
    const ax = list[i][0] * kx;
    const ay = list[i][1] * ky;
    const bx = list[i + 1][0] * kx;
    const by = list[i + 1][1] * ky;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
    const qx = ax + t * dx;
    const qy = ay + t * dy;
    const offset = Math.hypot(px - qx, py - qy);
    if (best === null || offset < best.offsetM) {
      const segmentLength = prefix[i + 1] - prefix[i];
      best = {
        index: i,
        t,
        position: [qx / kx, qy / ky],
        offsetM: offset,
        alongM: prefix[i] + segmentLength * t,
      };
    }
  }

  if (!best) return null;

  const totalM = prefix[prefix.length - 1];
  return { ...best, totalM, fraction: totalM > 0 ? Math.max(0, Math.min(1, best.alongM / totalM)) : 0 };
}

/**
 * Cut a polyline at a projection.
 *
 * The projected position appears as the LAST vertex of `travelled` and the
 * FIRST of `ahead`, so the two lines meet exactly. Splitting on a vertex index
 * alone — which is what a `pathIndex` split does — leaves the two halves
 * ending and starting at different places, and the gap between them reads on a
 * pitched 3D map as the route breaking.
 *
 * @returns {{ travelled: Array<[number,number]>, ahead: Array<[number,number]> }}
 */
export function splitPathAtProjection(coords, projection) {
  const list = Array.isArray(coords) ? coords : [];
  if (list.length < 2 || !projection) return { travelled: [], ahead: list.slice() };

  const i = Math.max(0, Math.min(list.length - 2, projection.index));
  const at = projection.position;

  const travelled = [...list.slice(0, i + 1), at];
  const ahead = [at, ...list.slice(i + 1)];

  return { travelled, ahead };
}

/**
 * Route progress for one robot on one path, in a single call.
 *
 * @returns {null | {
 *   travelled: Array<[number,number]>,
 *   ahead: Array<[number,number]>,
 *   projection: object,
 *   remainingM: number,
 *   offsetM: number,
 *   fraction: number,
 * }}
 */
export function routeProgress(path, robotPoint, { minIndex = 0 } = {}) {
  const coords = pathToCoordinates(path);
  if (coords.length < 2) return null;

  const projection = projectOntoPath(robotPoint, coords, { minIndex });
  if (!projection) return null;

  const { travelled, ahead } = splitPathAtProjection(coords, projection);
  return {
    travelled,
    ahead,
    projection,
    remainingM: Math.max(0, projection.totalM - projection.alongM),
    offsetM: projection.offsetM,
    fraction: projection.fraction,
  };
}

/**
 * How far a robot may be from its own route before the map stops treating the
 * projection as "where it is on this route".
 *
 * Chosen against this campus, not against a round number: RNSIT's site is ~230 m
 * across at its narrowest and its internal service roads run 15–25 m apart, so
 * beyond ~40 m the nearest point of a route is as likely to be a different leg
 * of the same route as the leg the robot is on. Past this the consumer is told
 * `onRoute: false` and reports it rather than drawing a confident split.
 */
export const MAX_ROUTE_OFFSET_M = 40;

/**
 * Close enough to the end of a leg to be treated as having completed it.
 *
 * The pickup and drop legs of a task are ORDERED, and nothing tells the browser
 * when one ends: `TASK_ASSIGNED` carries both paths and a phase of TO_PICKUP,
 * and no later event revises it unless the backend replans. So the transition
 * has to be observed rather than received, and "the unit has reached the end of
 * the pickup path" is the observation that means it.
 *
 * 15 m is a route vertex or two at campus scale, and comfortably inside the
 * distance a mission pin sits from the road it was snapped to.
 */
export const LEG_ARRIVAL_M = 15;

export const ROUTE_SEGMENT = Object.freeze({
  TO_PICKUP: 'toPickup',
  TO_DROP: 'toDrop',
});

/**
 * Advance a robot's position along its task's two legs.
 *
 * ── Why this is a state machine and not a calculation ─────────────────────
 * Two things make a stateless answer wrong on this campus. Legs RETRACE: the
 * drop path frequently runs back along the service road the pickup path used,
 * so the geometrically nearest point can be one the unit passed minutes ago,
 * and the travelled line would jump backwards while the unit moves forwards.
 * And legs are ORDERED: once the unit is on the drop leg it is not going to be
 * on the pickup leg again, so that transition latches.
 *
 * The state carried is three numbers and a string. It is derived entirely from
 * positions the map already receives, and it is a VIEW of the mission, never a
 * claim about it: nothing here decides a phase, commits a task, or is consulted
 * by anything but the renderer.
 *
 * @param {object|null} previous  the last state this function returned
 * @param {object} params
 * @param {Array} params.pathToPickup
 * @param {Array} params.pathToDrop
 * @param {[number,number]|object} params.point  the unit's live position
 * @param {string|null} [params.taskId]  resets the state when the task changes
 * @param {string|null} [params.declaredSegment]  a segment the BACKEND stated —
 *        from `TASK_ASSIGNED`'s phase or a `REROUTED` message. Always wins:
 *        an observation must never override something the engine actually said.
 * @returns {{
 *   taskId: string|null,
 *   segment: string,
 *   pickupIndex: number,
 *   dropIndex: number,
 *   onRoute: boolean,
 *   offsetM: number|null,
 *   pickup: { travelled: Array, ahead: Array }|null,
 *   drop: { travelled: Array, ahead: Array }|null,
 *   remainingM: number|null,
 *   fraction: number|null,
 * }}
 */
export function advanceRouteState(previous, { pathToPickup, pathToDrop, point, taskId = null, declaredSegment = null } = {}) {
  const pickupCoords = pathToCoordinates(pathToPickup);
  const dropCoords = pathToCoordinates(pathToDrop);

  // A different task is a different mission: nothing about the previous one's
  // progress carries over, and silently keeping a latched `toDrop` would show
  // the new task's pickup leg as already travelled.
  const carried = previous && previous.taskId === taskId ? previous : null;

  const base = {
    taskId,
    segment: declaredSegment || carried?.segment || ROUTE_SEGMENT.TO_PICKUP,
    pickupIndex: carried?.pickupIndex || 0,
    dropIndex: carried?.dropIndex || 0,
    onRoute: true,
    offsetM: null,
    pickup: null,
    drop: null,
    remainingM: null,
    fraction: null,
  };

  const position = toLonLat(point);
  if (!position) {
    // No usable position — draw both legs whole rather than guessing progress.
    return {
      ...base,
      pickup: pickupCoords.length >= 2 ? { travelled: [], ahead: pickupCoords } : null,
      drop: dropCoords.length >= 2 ? { travelled: [], ahead: dropCoords } : null,
      onRoute: false,
    };
  }

  const pickupHit = pickupCoords.length >= 2 ? projectOntoPath(position, pickupCoords, { minIndex: base.pickupIndex }) : null;
  const dropHit = dropCoords.length >= 2 ? projectOntoPath(position, dropCoords, { minIndex: base.dropIndex }) : null;

  let segment = base.segment;

  if (!declaredSegment && segment === ROUTE_SEGMENT.TO_PICKUP) {
    const reachedPickup = pickupHit && pickupHit.totalM - pickupHit.alongM <= LEG_ARRIVAL_M;
    // The other way onto the drop leg: this session never saw the transition —
    // a reload, or the operator opening the map mid-task. The unit is nowhere
    // near the pickup path and is sitting on the drop path.
    const strandedOnDrop =
      pickupHit &&
      dropHit &&
      pickupHit.offsetM > MAX_ROUTE_OFFSET_M &&
      dropHit.offsetM <= MAX_ROUTE_OFFSET_M;
    if (reachedPickup || strandedOnDrop) segment = ROUTE_SEGMENT.TO_DROP;
  }

  const activeHit = segment === ROUTE_SEGMENT.TO_DROP ? dropHit : pickupHit;
  const activeCoords = segment === ROUTE_SEGMENT.TO_DROP ? dropCoords : pickupCoords;
  const onRoute = Boolean(activeHit) && activeHit.offsetM <= MAX_ROUTE_OFFSET_M;

  // Off its own route, the projection is not evidence of anything: the nearest
  // point of a route a unit is 80 m from says where the route is, not where the
  // unit has got to. So the leg is drawn WHOLE and the caller is told, rather
  // than a confident-looking split being invented (§"Report it").
  const split = (coords, hit) =>
    coords.length < 2 ? null : onRoute && hit ? splitPathAtProjection(coords, hit) : { travelled: [], ahead: coords };

  const state = {
    ...base,
    segment,
    onRoute,
    offsetM: activeHit ? activeHit.offsetM : null,
    remainingM: onRoute && activeHit ? Math.max(0, activeHit.totalM - activeHit.alongM) : null,
    fraction: onRoute && activeHit ? activeHit.fraction : null,
  };

  if (segment === ROUTE_SEGMENT.TO_DROP) {
    // The pickup leg is behind the unit by definition once the drop leg starts.
    state.pickup = pickupCoords.length >= 2 ? { travelled: pickupCoords, ahead: [] } : null;
    state.drop = split(dropCoords, dropHit);
    if (onRoute && dropHit) state.dropIndex = dropHit.index;
  } else {
    state.pickup = split(pickupCoords, pickupHit);
    // Nothing on the drop leg has been travelled while the unit is still
    // heading for the pickup.
    state.drop = dropCoords.length >= 2 ? { travelled: [], ahead: dropCoords } : null;
    if (onRoute && pickupHit) state.pickupIndex = pickupHit.index;
  }

  // `activeCoords` is read only to keep the two branches honest about which
  // line the reported progress belongs to.
  state.activePointCount = activeCoords.length;
  return state;
}

/** A `[lon, lat]` array → the GeoJSON a line layer takes. Null below 2 points. */
export function lineCollection(coords, properties = {}) {
  const list = Array.isArray(coords) ? coords : [];
  if (list.length < 2) return null;
  return {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: list }, properties }],
  };
}
