/**
 * Route Intersection Service — DTARO
 *
 * Determines whether a robot's planned path intersects a blocked segment.
 * Uses the standard parametric line-segment intersection algorithm on
 * lat/lon coordinates (valid for small geographic areas).
 */

/**
 * Test whether two 2D line segments (p1→p2) and (p3→p4) intersect.
 * Uses the cross-product / parametric method; handles parallel and collinear cases.
 *
 * @param {{ lat: number, lon: number }} p1
 * @param {{ lat: number, lon: number }} p2
 * @param {{ lat: number, lon: number }} p3
 * @param {{ lat: number, lon: number }} p4
 * @returns {boolean}
 */
function segmentsIntersect(p1, p2, p3, p4) {
  // Direction vectors
  const d1x = p2.lon - p1.lon;
  const d1y = p2.lat - p1.lat;
  const d2x = p4.lon - p3.lon;
  const d2y = p4.lat - p3.lat;

  const cross = d1x * d2y - d1y * d2x;

  // Parallel (or anti-parallel) — treat as non-intersecting
  if (Math.abs(cross) < 1e-12) return false;

  const dx = p3.lon - p1.lon;
  const dy = p3.lat - p1.lat;

  // Parametric positions t (on segment 1) and u (on segment 2)
  const t = (dx * d2y - dy * d2x) / cross;
  const u = (dx * d1y - dy * d1x) / cross;

  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

/**
 * Check whether a robot's planned path intersects a blocked segment.
 * Each consecutive pair of waypoints in the path is tested as a segment.
 *
 * @param {Array<{ lat: number, lon: number }>} plannedPath - ordered waypoints
 * @param {{ lat: number, lon: number }} blockStart
 * @param {{ lat: number, lon: number }} blockEnd
 * @returns {boolean}
 */
function pathIntersectsSegment(plannedPath, blockStart, blockEnd) {
  if (!Array.isArray(plannedPath) || plannedPath.length < 2) return false;
  if (!blockStart || !blockEnd) return false;

  for (let i = 0; i < plannedPath.length - 1; i++) {
    const a = plannedPath[i];
    const b = plannedPath[i + 1];
    if (
      typeof a?.lat !== "number" || typeof a?.lon !== "number" ||
      typeof b?.lat !== "number" || typeof b?.lon !== "number"
    ) continue;

    if (segmentsIntersect(a, b, blockStart, blockEnd)) return true;
  }

  return false;
}

/**
 * From a list of robots (each with a planned path), return the IDs of
 * those whose path crosses the blocked segment.
 *
 * @param {Array<{ robotId: string, plannedPath: Array<{ lat: number, lon: number }> }>} robots
 * @param {{ lat: number, lon: number }} blockStart
 * @param {{ lat: number, lon: number }} blockEnd
 * @returns {string[]} affected robot IDs
 */
function findAffectedRobots(robots, blockStart, blockEnd) {
  if (!Array.isArray(robots)) return [];
  return robots
    .filter(
      (r) =>
        Array.isArray(r?.plannedPath) &&
        r.plannedPath.length >= 2 &&
        pathIntersectsSegment(r.plannedPath, blockStart, blockEnd)
    )
    .map((r) => r.robotId);
}

// ─── Footprint test (DTARO zone alerts) ─────────────────────────────────────
//
// The functions above model an obstacle as ONE diagonal segment, so a route running along
// that diagonal (parallel) or crossing the obstacle's area without crossing the diagonal is
// missed (audit FI-1). They are kept unchanged for the legacy fleet scan. The receiver-side
// relevance check tests the route against the obstacle's footprint POLYGON instead, and
// counts boundary contact as an intersection: a route running exactly along the footprint's
// edge passes within the obstacle's localisation, which is the fail-safe reading.
//
// Coordinates are used directly as a plane (lon = x, lat = y), as above. Intersection and
// containment are invariant under the locally affine lat/lon → metres map, so no
// projection is needed at campus scale.

/**
 * Orientation tolerance, in degrees². A collinear route built from the footprint's own
 * vertices yields cross products of ~1e-20 from float rounding; a route offset 1 m (~9e-6°)
 * from a 25 m edge yields ~2e-9. Anything inside the band is treated as touching.
 */
const ORIENTATION_EPS = 1e-14;

function isPoint(p) {
  return p !== null && typeof p === "object" && Number.isFinite(p.lat) && Number.isFinite(p.lon);
}

function orientation(a, b, c) {
  const value = (b.lon - a.lon) * (c.lat - a.lat) - (b.lat - a.lat) * (c.lon - a.lon);
  if (Math.abs(value) <= ORIENTATION_EPS) return 0;
  return value > 0 ? 1 : -1;
}

/** `p` lies within the bounding box of `a`–`b` (used once `p` is known to be collinear). */
function withinBox(a, b, p) {
  const tol = 1e-12;
  return (
    p.lon <= Math.max(a.lon, b.lon) + tol &&
    p.lon >= Math.min(a.lon, b.lon) - tol &&
    p.lat <= Math.max(a.lat, b.lat) + tol &&
    p.lat >= Math.min(a.lat, b.lat) - tol
  );
}

/**
 * Closed-segment intersection: touching endpoints and collinear overlap count.
 * Unlike `segmentsIntersect`, parallel segments that overlap are intersecting.
 */
function segmentsTouch(p1, p2, p3, p4) {
  const o1 = orientation(p1, p2, p3);
  const o2 = orientation(p1, p2, p4);
  const o3 = orientation(p3, p4, p1);
  const o4 = orientation(p3, p4, p2);

  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && withinBox(p1, p2, p3)) return true;
  if (o2 === 0 && withinBox(p1, p2, p4)) return true;
  if (o3 === 0 && withinBox(p3, p4, p1)) return true;
  if (o4 === 0 && withinBox(p3, p4, p2)) return true;
  return false;
}

/** Point in a simple polygon, boundary inclusive. `polygon` is an open or closed ring. */
function pointInPolygon(point, polygon) {
  if (!isPoint(point) || !Array.isArray(polygon) || polygon.length < 3) return false;
  const n = polygon.length;
  for (let i = 0; i < n; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % n];
    if (orientation(a, b, point) === 0 && withinBox(a, b, point)) return true;
  }
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if ((a.lat > point.lat) !== (b.lat > point.lat)) {
      const lonAt = ((b.lon - a.lon) * (point.lat - a.lat)) / (b.lat - a.lat) + a.lon;
      if (point.lon < lonAt) inside = !inside;
    }
  }
  return inside;
}

/**
 * Whether a route (an ordered polyline) enters or touches a footprint polygon.
 *
 * A one-point route is tested as a point. Invalid waypoints are skipped, as in
 * `pathIntersectsSegment`; a footprint with fewer than three valid vertices is not a
 * footprint and never intersects.
 *
 * @param {Array<{ lat: number, lon: number }>} path
 * @param {Array<{ lat: number, lon: number }>} polygon
 * @returns {boolean}
 */
function pathIntersectsPolygon(path, polygon) {
  if (!Array.isArray(path) || !Array.isArray(polygon)) return false;
  const ring = polygon.filter(isPoint);
  if (ring.length < 3) return false;
  const points = path.filter(isPoint);
  if (points.length === 0) return false;
  if (points.length === 1) return pointInPolygon(points[0], ring);

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (pointInPolygon(a, ring) || pointInPolygon(b, ring)) return true;
    for (let k = 0; k < ring.length; k++) {
      if (segmentsTouch(a, b, ring[k], ring[(k + 1) % ring.length])) return true;
    }
  }
  return false;
}

module.exports = {
  segmentsIntersect,
  pathIntersectsSegment,
  findAffectedRobots,
  segmentsTouch,
  pointInPolygon,
  pathIntersectsPolygon,
};
