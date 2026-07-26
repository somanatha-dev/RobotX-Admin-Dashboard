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

module.exports = {
  segmentsIntersect,
  pathIntersectsSegment,
  findAffectedRobots,
};
