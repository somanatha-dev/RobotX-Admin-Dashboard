/**
 * Routing Service — DTARO
 *
 * Provides:
 *   1. A* path planning over a waypoint graph
 *   2. Mapbox Directions integration with straight-line fallback
 *   3. Obstacle-aware route replanning
 *   4. In-task rerouting: updates Redis task path + robot registry
 *
 * A* operates on the existing route waypoints as a graph, marking
 * obstacle-proximate waypoints as blocked and finding an alternate index sequence.
 * For real-world scenarios Mapbox Directions is used for actual road geometry.
 */

const { directionsPolyline } = require("./mapbox.service");
const { updatePlannedPath } = require("./robotRegistry.service");
const { haversineMeters } = require("../utils/distance");
const { safeJsonParse } = require("../utils/json");

const OBSTACLE_RADIUS_M = 30; // meters to flag waypoints as blocked
const K_NEAREST = 6;         // neighbors considered by A*

/**
 * A* path planning on a waypoint array.
 * Nodes are indices into `waypoints`. Edges connect each node to its
 * K_NEAREST geographic neighbors (excluding blocked indices).
 *
 * @param {Array<{lat:number,lon:number}>} waypoints
 * @param {number} startIdx
 * @param {number} goalIdx
 * @param {Set<number>} [blocked] - indices that are impassable
 * @returns {number[]|null} ordered index path, or null if unreachable
 */
function astar(waypoints, startIdx, goalIdx, blocked = new Set()) {
  const n = waypoints.length;
  if (n < 2) return null;
  if (startIdx === goalIdx) return [startIdx];

  function heuristic(i) {
    return haversineMeters(
      waypoints[i].lat, waypoints[i].lon,
      waypoints[goalIdx].lat, waypoints[goalIdx].lon
    );
  }

  function neighbors(i) {
    return waypoints
      .map((_, j) => ({
        j,
        d: haversineMeters(waypoints[i].lat, waypoints[i].lon, waypoints[j].lat, waypoints[j].lon),
      }))
      .filter(({ j }) => j !== i && !blocked.has(j))
      .sort((a, b) => a.d - b.d)
      .slice(0, K_NEAREST);
  }

  const gScore = new Map([[startIdx, 0]]);
  const fScore = new Map([[startIdx, heuristic(startIdx)]]);
  const cameFrom = new Map();
  const open = new Set([startIdx]);
  const closed = new Set();

  while (open.size > 0) {
    // Find lowest f-score node in open set
    let current = null;
    let lowestF = Infinity;
    for (const idx of open) {
      const f = fScore.get(idx) ?? Infinity;
      if (f < lowestF) { lowestF = f; current = idx; }
    }

    if (current === goalIdx) {
      const path = [current];
      while (cameFrom.has(current)) {
        current = cameFrom.get(current);
        path.unshift(current);
      }
      return path;
    }

    open.delete(current);
    closed.add(current);

    for (const { j, d } of neighbors(current)) {
      if (closed.has(j)) continue;
      const tentativeG = (gScore.get(current) ?? Infinity) + d;
      if (tentativeG < (gScore.get(j) ?? Infinity)) {
        cameFrom.set(j, current);
        gScore.set(j, tentativeG);
        fScore.set(j, tentativeG + heuristic(j));
        open.add(j);
      }
    }
  }

  return null; // no path
}

/**
 * Plan a fresh route between two points.
 * Uses Mapbox Directions; falls back to straight line on failure.
 *
 * @param {{ lat: number, lon: number }} from
 * @param {{ lat: number, lon: number }} to
 * @returns {Promise<Array<{lat:number,lon:number}>>}
 */
async function planRoute(from, to) {
  try {
    const points = await directionsPolyline({ from, to });
    if (Array.isArray(points) && points.length >= 2) return points;
  } catch {
    // fall through
  }
  return [from, to]; // minimal straight-line fallback
}

/**
 * Replan an existing path around an obstacle using A*.
 * If A* finds no alternate, falls back to Mapbox Directions from current position.
 *
 * @param {Array<{lat:number,lon:number}>} existingPath
 * @param {{ lat: number, lon: number }} obstacleLocation
 * @param {{ lat: number, lon: number }} destination
 * @param {number} [currentIdx] - robot's current index in the path
 * @returns {Promise<Array<{lat:number,lon:number}>>}
 */
async function replanRoute(existingPath, obstacleLocation, destination, currentIdx = 0) {
  if (!Array.isArray(existingPath) || existingPath.length < 2) {
    return planRoute(destination, destination);
  }

  // Mark waypoints within OBSTACLE_RADIUS_M as blocked
  const blocked = new Set();
  existingPath.forEach((wp, i) => {
    if (typeof wp?.lat !== "number") return;
    const d = haversineMeters(wp.lat, wp.lon, obstacleLocation.lat, obstacleLocation.lon);
    if (d <= OBSTACLE_RADIUS_M) blocked.add(i);
  });

  const startIdx = Math.max(0, Math.min(currentIdx, existingPath.length - 1));
  const goalIdx = existingPath.length - 1;

  if (blocked.size === 0) {
    // No waypoints blocked — original path (from current position) is fine
    return existingPath.slice(startIdx);
  }

  // Try A* on existing waypoints
  const indices = astar(existingPath, startIdx, goalIdx, blocked);
  if (indices && indices.length >= 2) {
    return indices.map((i) => existingPath[i]);
  }

  // A* failed (e.g., obstacle fully blocks path) — request fresh Mapbox route
  const currentPos = existingPath[startIdx] || existingPath[0];
  return planRoute(currentPos, destination);
}

/**
 * Reroute an actively assigned robot around an obstacle.
 * Updates:
 *   - Redis `taskPath:{taskId}` with new path segment
 *   - Registry `plannedPath`
 *   - Emits TASK_UPDATED to dashboard
 *
 * @param {object} prisma
 * @param {object} kv
 * @param {object|null} io
 * @param {string} robotId
 * @param {{ obstacleLocation: { lat: number, lon: number } }} options
 */
async function rerouteRobot(prisma, kv, io, robotId, { obstacleLocation }) {
  if (!kv || !robotId) return;

  // Load active task state from Redis
  const stateRaw = await kv.get(`robotTaskState:${robotId}`);
  if (!stateRaw) return; // no active task — nothing to reroute

  const state = safeJsonParse(stateRaw);
  if (!state?.taskId) return;

  const { taskId, pathIndex = 0, segment = "toPickup" } = state;

  const pathRaw = await kv.get(`taskPath:${taskId}`);
  if (!pathRaw) return;

  const path = safeJsonParse(pathRaw);
  if (!path) return;

  const activePath = segment === "toDrop" ? path.toDrop : path.toPickup;
  const destination = segment === "toDrop" ? path.drop : path.pickup;

  if (!Array.isArray(activePath) || !destination) return;

  const newPath = await replanRoute(activePath, obstacleLocation, destination, pathIndex);

  // Write new path back to Redis
  if (segment === "toDrop") {
    path.toDrop = newPath;
  } else {
    path.toPickup = newPath;
  }

  await kv.set(`taskPath:${taskId}`, JSON.stringify(path), { ex: 86400 });

  // Update registry with new planned path
  await updatePlannedPath(kv, robotId, newPath);

  // Notify dashboard
  if (io) {
    try {
      io.to("dashboard").emit("TASK_UPDATED", {
        robotId,
        taskId,
        action: "REROUTED",
        newPath,
        segment,
        timestamp: Date.now(),
      });
    } catch {
      // ignore
    }
  }
}

module.exports = {
  astar,
  planRoute,
  replanRoute,
  rerouteRobot,
};
