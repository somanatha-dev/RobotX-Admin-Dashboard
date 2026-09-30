/**
 * How live socket events are merged into the provider's robot and task lists — only what
 * each event actually states, never an inference about what probably happened.
 *
 * ── FS-01: robot presence (`robot_offline` / `robot_online`, robot.handler.js) ──
 * Both carry only `{ robotId }` (the robot's code).
 *   · `robot_offline` is emitted after `markRobotOffline` has written `isOnline: false,
 *     status: "OFFLINE"` to the Robot row — so those two fields are the backend's own
 *     values, applied as they were written. Nothing else is: telemetry simply stops, so
 *     battery, position and speed stay what they last were.
 *   · `robot_online` is emitted after `markRobotOnline` has set `isOnline: true` and
 *     restored the status the disconnect replaced (`statusBeforeOffline`). The event does
 *     not say which status that was, so only `isOnline` is applied here and the provider
 *     refetches for the rest.
 *
 * ── FS-04: a task's robot (`TASK_UPDATED`, offer.handler.js) ────────────────
 * The two sources name the robot differently (BG-12, not changed here):
 *   · REST `GET /api/tasks`: `robotId` is the Robot row's **UUID**; `robot.robotId` is the
 *     robot's **code** (V1DEMO-02).
 *   · Socket `TASK_UPDATED.robotId`: the robot's **code**.
 * The card shows the code, read from `robot.robotId` only. A socket update used to write
 * the code into `robotId` and leave `robot` alone, so after a reassignment the stale
 * nested code kept winning (measured: V1DEMO-01 shown while V1DEMO-02 drove the task).
 * Now the code goes into `robot.robotId`, where the card reads it, and a UUID that
 * belonged to the previous robot is dropped rather than kept beside the new code — the
 * refetch that follows supplies the new one.
 */

const trimmed = (value) => (typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim());

/** The robot code a task names, or null. Never the REST `robotId`, which is a UUID. */
export function taskRobotCode(task) {
  return trimmed(task?.robot?.robotId) || null;
}

function patchRobot(robots, robotId, patch) {
  const id = trimmed(robotId);
  if (!id || !Array.isArray(robots)) return robots;
  let changed = false;
  const next = robots.map((r) => {
    if (trimmed(r?.robotId) !== id) return r;
    changed = true;
    return { ...r, ...patch };
  });
  return changed ? next : robots;
}

/** `robot_offline`: the two fields `markRobotOffline` wrote before emitting it. */
export function applyRobotOffline(robots, data) {
  return patchRobot(robots, data?.robotId, { isOnline: false, status: 'OFFLINE' });
}

/** `robot_online`: liveness only. The restored status comes from the refetch. */
export function applyRobotOnline(robots, data) {
  return patchRobot(robots, data?.robotId, { isOnline: true });
}

/**
 * Merge one `TASK_UPDATED` into a task row.
 *
 * @param {object} task a row from `GET /api/tasks` or an earlier socket merge
 * @param {object} data the `TASK_UPDATED` payload
 * @returns {object} the merged row
 */
export function applyTaskUpdate(task, data) {
  const code = trimmed(data?.robotId) || trimmed(data?.robot?.robotId);
  let robotFields = {};
  if (code) {
    const sameRobot = code === taskRobotCode(task);
    robotFields = {
      robot: { ...(task?.robot && typeof task.robot === 'object' ? task.robot : {}), ...(data?.robot && typeof data.robot === 'object' ? data.robot : {}), robotId: code },
      // REST's UUID for this robot. Kept only if the robot did not change; a UUID for the
      // previous robot beside the new code would be two different robots in one row.
      robotId: sameRobot ? task?.robotId ?? null : null,
    };
  }
  return {
    ...task,
    ...(typeof data?.status === 'string' ? { status: data.status } : {}),
    ...robotFields,
    ...(typeof data?.distanceMeters === 'number' ? { distanceMeters: data.distanceMeters } : {}),
    // Carried by a VERIFYING update (insufficient or unavailable completion evidence); the
    // card shows it as the reason the task is held.
    ...(data?.verification && typeof data.verification === 'object' ? { verification: data.verification } : {}),
  };
}

/*
 * ── Route eviction: a finished task's route is no longer an active delivery route ──
 * The terminal Task states are the backend's own (`tasks.controller.cancelTask`, and
 * `features/tasks/taskLifecycle.js`): COMPLETED, FAILED, CANCELLED, REJECTED. VERIFYING is a
 * held completion and is not terminal; PAUSED, OFFLINE and IDLE are robot states and say
 * nothing about a task, so none of them evicts anything.
 *
 * The map redraws every route in the provider's task-route cache on each telemetry tick
 * (`useRobotStream`'s sync effect). A finished task left in that cache was therefore drawn
 * again within one tick of the terminal event removing it (measured: 93 ms).
 */
export const TERMINAL_TASK_STATUSES = Object.freeze(['COMPLETED', 'FAILED', 'CANCELLED', 'REJECTED']);

export function isTerminalTaskStatus(status) {
  return TERMINAL_TASK_STATUSES.includes(trimmed(status).toUpperCase());
}

/**
 * Drop from the task-route cache every task the backend's task list reports as terminal.
 * For a terminal event this page missed (it was disconnected) — the refetch after
 * reconnecting is then the backend saying so.
 *
 * @param {Map<string, object>} cache taskId → cached route
 * @param {object[]} tasks rows from `GET /api/tasks`
 * @returns {string[]} the task ids removed
 */
export function evictTerminalRoutes(cache, tasks) {
  if (!cache || typeof cache.delete !== 'function' || !Array.isArray(tasks)) return [];
  const removed = [];
  for (const task of tasks) {
    const taskId = trimmed(task?.taskId);
    if (taskId && isTerminalTaskStatus(task?.status) && cache.delete(taskId)) removed.push(taskId);
  }
  return removed;
}

/**
 * `TASK_UPDATED` → the task-route cache: a terminal update removes its task.
 *
 * @param {Map<string, object>} cache taskId → cached route
 * @param {object} data the `TASK_UPDATED` payload
 * @returns {boolean} whether an entry was removed
 */
export function evictOnTerminalUpdate(cache, data) {
  const taskId = trimmed(data?.taskId);
  if (!taskId || !cache || typeof cache.delete !== 'function' || !isTerminalTaskStatus(data?.status)) return false;
  return cache.delete(taskId);
}

/**
 * The cached routes the map redraws on a sync pass (`useRobotStream`, every telemetry
 * tick): complete paths for a visible robot that has no route drawn — the first cached
 * entry per robot, as the loop it replaces drew the first and then saw the robot as drawn.
 *
 * @param {Map<string, object>} cache taskId → { robotId, pathToPickup, pathToDrop, pickup, drop }
 * @param {{ activeRobotIds: Set<string>, drawnRobotIds: { has(id: string): boolean } }} map
 * @returns {object[]} `{ taskId, robotId, pathToPickup, pathToDrop, pickup, drop }` to draw
 */
export function replayableRoutes(cache, { activeRobotIds, drawnRobotIds }) {
  const out = [];
  if (!cache || typeof cache.entries !== 'function') return out;
  const claimed = new Set();
  for (const [taskId, entry] of cache.entries()) {
    const { robotId, pathToPickup, pathToDrop, pickup, drop } = entry || {};
    if (!robotId || !pathToPickup || !pathToDrop) continue;
    if (!activeRobotIds.has(robotId)) continue;
    if (drawnRobotIds.has(robotId) || claimed.has(robotId)) continue; // already drawn
    claimed.add(robotId);
    out.push({ taskId, robotId, pathToPickup, pathToDrop, pickup, drop });
  }
  return out;
}

/**
 * What the map shows or holds that the provider's task-route cache no longer backs.
 *
 * The cache is the authoritative set of active delivery routes on this page: an entry
 * leaves it only through `evictOnTerminalUpdate` / `evictTerminalRoutes` (a terminal task
 * state the backend reported, by event or by refetch) or the logout clear — never because
 * a socket dropped, a robot went offline or paused, or a task is VERIFYING. So a route the
 * map still draws for a task that left the cache is a terminal event the map missed (it was
 * disconnected); and one drawn on a robot the cache no longer names for that task is a
 * reassignment it missed. Both are removed by the map's next sync pass, which runs after
 * every refetch — no telemetry or further event needed.
 *
 * @param {{ rendered: Map<string, {taskId?: string}>, records: Map<string, {taskId?: string}>, localPaths: Map<string, object> }} map
 *   `rendered` robotId → drawn route; `records` robotId → the task the map holds for it;
 *   `localPaths` taskId → the map's own copy of the paths
 * @param {Map<string, {robotId?: string}>} cache the provider's taskId → route cache
 * @returns {{ robotId: string, taskId: string, finished: boolean }[]} `finished` when the
 *   task left the cache (its local paths go too), false for a robot-mismatch only
 */
export function staleMapRoutes({ rendered, records, localPaths }, cache) {
  const stale = new Map();
  if (!cache || typeof cache.get !== 'function') return [];
  const verdict = (robotId, taskId) => {
    const id = trimmed(taskId);
    if (!id) return null;
    const entry = cache.get(id);
    if (!entry) return { robotId, taskId: id, finished: true };
    const owner = trimmed(entry.robotId);
    return owner && owner !== robotId ? { robotId, taskId: id, finished: false } : null;
  };
  for (const [robotId, route] of rendered || []) {
    const v = verdict(robotId, route?.taskId);
    if (v) stale.set(robotId, v);
  }
  // Not drawn (the robot was out of view), but still held with a path the map could draw
  // from on the next telemetry tick.
  for (const [robotId, record] of records || []) {
    if (stale.has(robotId) || !localPaths?.has(trimmed(record?.taskId))) continue;
    const v = verdict(robotId, record?.taskId);
    if (v) stale.set(robotId, v);
  }
  return [...stale.values()];
}
