/**
 * Distance for a task card, from the route the engine actually sent the robot.
 *
 * ── Where the numbers come from ─────────────────────────────────────────────
 * `Task.distanceMeters` is not set on the engine path (it stays null), and the engine
 * publishes no ETA (`what_happened.predictions` is null). What the dashboard does receive is
 * `TASK_ASSIGNED`, whose `pathToPickup` and `pathToDrop` are read back from the OFFER the
 * robot was sent (`assignmentProjection.offeredRouteFor`). Its length is the planned route
 * distance — measured geometry, not an estimate.
 *
 * No ETA is derived here: dividing by the robot's current speed would ignore stop dwell
 * times and which leg of the route the robot is on (the dashboard is not told), and would
 * present a guess as a prediction.
 */

// Mean Earth radius (IUGG), metres — the physical constant of the haversine formula.
const EARTH_RADIUS_M = 6371008.8;

const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const rad = (deg) => (deg * Math.PI) / 180;

function haversine(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Length of a polyline of `{ lat, lon }` points, or null when it is not a usable path.
 *
 * @param {Array<{ lat: number, lon: number }>} points
 * @returns {number|null}
 */
export function pathLengthMeters(points) {
  if (!Array.isArray(points) || points.length === 0) return null;
  if (!points.every((p) => p && finite(p.lat) && finite(p.lon))) return null;
  // A one-point path is a robot already standing where the path ends: zero metres.
  let total = 0;
  for (let i = 1; i < points.length; i += 1) total += haversine(points[i - 1], points[i]);
  return total;
}

/**
 * The planned route length (robot → pickup → drop) of a cached `TASK_ASSIGNED` entry.
 *
 * @param {{ pathToPickup?: object[], pathToDrop?: object[] } | null | undefined} route
 * @returns {number|null} metres, or null when either half is missing or malformed
 */
export function plannedRouteMeters(route) {
  const toPickup = pathLengthMeters(route?.pathToPickup);
  const toDrop = pathLengthMeters(route?.pathToDrop);
  if (toPickup === null || toDrop === null) return null;
  return toPickup + toDrop;
}
