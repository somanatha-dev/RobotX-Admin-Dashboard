/**
 * Robot Registry Service — DTARO
 *
 * ── SUPERSEDED (Phase 9, §6.2) — traceability banner only, no behavioural change ──
 * The execution plan's Phase 9 row names this file under "Files to modify":
 * "`robots:all` superseded by the cell-partitioned index." `getAllRobotIds()` below
 * reads one global Redis set — an unpartitioned enumeration whose cost grows with
 * total fleet size, which is exactly what §6.1's bounded-work property (T9) forbids
 * of a decision path: "per-decision cost MUST be a function of local agent density,
 * not global fleet size."
 *
 * Its replacement is `src/engine/candidates/availabilityIndex.js`'s
 * `(shard, cell, availability_class)` partition, read through
 * `candidatesInFineCell()` / `candidatesInCoarseCell()`. Nothing here is on the
 * engine's decision path, so this file keeps working unchanged for the legacy
 * DTARO surfaces until Phase 15's cutover retires them the way it retired
 * `taskAssignment.service.js` (see `tools/gates/checkLegacyRetirement.js`).
 *
 * This banner discharges the one finding `PHASE_9_INDEPENDENT_VERIFICATION.md` left
 * open; its companion finding — the same banner on `taskAssignment.service.js` — was
 * overtaken by that file's actual retirement.
 *
 * Unified live-state facade over Redis + in-memory socket map.
 * All DTARO components read/write robot state through this service;
 * nothing else should reach into Redis `robot:*` keys directly for
 * registry-level fields (zoneId, utilization, plannedPath, etc.).
 *
 * Redis schema for registry entries (`registry:{robotId}`, TTL=30s):
 *   { robotId, socketId, lat, lon, battery, status, speed,
 *     zoneId, utilization, plannedPath, healthStatus,
 *     authenticated, connected, assignedTaskId, etaSec,
 *     lastHeartbeat, updatedAt }
 */

const { getRobotSocket } = require("../sockets/robotSockets");
const { safeJsonParse } = require("../utils/json");

const REGISTRY_TTL = 30; // seconds

/**
 * F7-A — the PROBE proof's fields. They belong to `agentProbe.service`'s own key
 * (`probe:{robotId}`) and are not registry state: every writer here reads the whole value and
 * writes it back later, so carrying them would restore an older proof over a newer one.
 * Dropped on every merge, so a value written before F7-A is not carried forward either.
 */
const PROBE_OWNED_FIELDS = Object.freeze(["lastProbeAckAt", "lastProbeSocketId", "linkQuality"]);

/**
 * The software stop latch (F7's input), for the same reason: it belongs to
 * `stopLatchObservation.service`'s own key (`stopLatch:{robotId}`). Carried here, any writer's
 * stale snapshot restored an older `engaged: false` over a newer `true` (2026-10-06 audit).
 */
const STOP_LATCH_OWNED_FIELDS = Object.freeze(["stopLatch"]);

/** Every field another store owns. No registry write carries one. */
const DEDICATED_FIELDS = Object.freeze([...PROBE_OWNED_FIELDS, ...STOP_LATCH_OWNED_FIELDS]);

function withoutDedicatedFields(state) {
  for (const field of DEDICATED_FIELDS) delete state[field];
  return state;
}

/** @param {string} robotId */
function registryKey(robotId) {
  return `registry:${robotId}`;
}

/**
 * Get live state for a robot, augmented with real-time socket connection status.
 * @param {object} kv
 * @param {string} robotId
 * @returns {Promise<object|null>}
 */
async function getRobotState(kv, robotId) {
  if (!kv || !robotId) return null;
  try {
    const raw = await kv.get(registryKey(robotId));
    const state = safeJsonParse(raw);
    if (!state) return null;
    const socket = getRobotSocket(robotId);
    return {
      ...state,
      connected: !!socket,
      socketId: socket?.id || state.socketId || null,
    };
  } catch {
    return null;
  }
}

/**
 * Merge-update live state for a robot (partial update — non-null fields only).
 * @param {object} kv
 * @param {string} robotId
 * @param {object} update
 */
async function setRobotState(kv, robotId, update) {
  if (!kv || !robotId || !update) return;
  try {
    const key = registryKey(robotId);
    const raw = await kv.get(key);
    const existing = safeJsonParse(raw) || {};
    const next = withoutDedicatedFields({ ...existing, ...update, robotId, updatedAt: Date.now() });
    await kv.set(key, JSON.stringify(next), { ex: REGISTRY_TTL });
  } catch {
    // ignore — Redis unavailable, live state degrades gracefully
  }
}

/**
 * Single read-modify-write against the registry key — one GET, one SET.
 *
 * The telemetry hot path used to call setRobotState (GET+SET) for telemetry
 * fields, then getRobotState (GET) to read utilization for its EMA calc,
 * then setRobotState again (GET+SET) to write it, then assignRobotToZone's
 * own setRobotState (GET+SET) for zone membership — 4 separate
 * read-modify-write cycles against the exact same key on the exact same
 * tick (~7 Redis round trips just for registry state, ~9 total per
 * telemetry event measured in the 2026-07-26 benchmark). `computeFn`
 * receives the one fetched `existing` object and returns the full patch
 * (telemetry + utilization + zone together), collapsing all of that into a
 * single GET and a single SET.
 *
 * @param {object} kv
 * @param {string} robotId
 * @param {(existing: object) => object} computeFn
 * @returns {Promise<object|null>} the merged state that was written, or null on failure
 */
async function mergeRobotState(kv, robotId, computeFn) {
  if (!kv || !robotId || typeof computeFn !== "function") return null;
  try {
    const key = registryKey(robotId);
    const raw = await kv.get(key);
    const next = buildMergedRegistryState(robotId, raw, computeFn);
    await kv.set(key, JSON.stringify(next), { ex: REGISTRY_TTL });
    return next;
  } catch {
    return null;
  }
}

/**
 * Pure computation half of mergeRobotState's read-modify-write, split out so
 * a caller that already has the raw registry value from a batched read (the
 * telemetry hot path — see telemetry.handler.js) can skip mergeRobotState's
 * own internal GET and fold the write into its own batched SET instead.
 * Does no I/O — same merge semantics as mergeRobotState, just without the
 * kv.get()/kv.set() wrapped around it.
 *
 * @param {string} robotId
 * @param {string|null} raw - the raw registry value (as returned by kv.get)
 * @param {(existing: object) => object} computeFn
 * @returns {object} the merged state, ready to JSON.stringify and SET
 */
function buildMergedRegistryState(robotId, raw, computeFn) {
  const existing = safeJsonParse(raw) || {};
  const patch = (typeof computeFn === "function" ? computeFn(existing) : null) || {};
  return withoutDedicatedFields({ ...existing, ...patch, robotId, updatedAt: Date.now() });
}

/**
 * Batch-get live state for many robots in one pipelined round-trip
 * (via `kv.mget`), augmented with real-time socket connection status —
 * same shape as `getRobotState`, just fetched once for the whole set
 * instead of once per robot.
 * @param {object} kv
 * @param {string[]} robotIds
 * @returns {Promise<Map<string, object|null>>}
 */
async function getManyRobotStates(kv, robotIds) {
  const ids = Array.isArray(robotIds) ? robotIds.filter(Boolean) : [];
  if (!kv || ids.length === 0) return new Map();
  try {
    const raws = await kv.mget(ids.map((id) => registryKey(id)));
    const map = new Map();
    for (let i = 0; i < ids.length; i++) {
      const robotId = ids[i];
      const state = safeJsonParse(raws[i]);
      if (!state) {
        map.set(robotId, null);
        continue;
      }
      const socket = getRobotSocket(robotId);
      map.set(robotId, {
        ...state,
        connected: !!socket,
        socketId: socket?.id || state.socketId || null,
      });
    }
    return map;
  } catch {
    return new Map();
  }
}

/**
 * Get all tracked robot IDs.
 * @param {object} kv
 * @returns {Promise<string[]>}
 */
async function getAllRobotIds(kv) {
  if (!kv) return [];
  try {
    const ids = await kv.smembers("robots:all");
    return Array.isArray(ids) ? ids.filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * Mark robot online after successful socket auth.
 * @param {object} kv
 * @param {string} robotId
 * @param {object} socket
 */
async function markOnline(kv, robotId, socket) {
  await setRobotState(kv, robotId, {
    connected: true,
    authenticated: true,
    socketId: socket?.id || null,
    lastHeartbeat: Date.now(),
  });
}

/**
 * Mark robot offline on socket disconnect — only on behalf of the socket the entry belongs to.
 *
 * Y1 — `markOnline` records the authenticated socket's id. A newer socket for the same robot
 * overwrites it, and the older socket's late disconnect must not then mark the newer one's
 * entry disconnected. An entry naming a different socket is left as it is; an entry naming
 * none (expired, or written before any AUTH) is marked offline as before.
 *
 * @param {object} kv
 * @param {string} robotId
 * @param {string} socketId the disconnecting socket's id; without one nothing is written
 * @returns {Promise<boolean>} whether the entry was marked offline
 */
async function markOffline(kv, robotId, socketId) {
  if (!kv || !robotId || typeof socketId !== "string" || socketId === "") return false;
  try {
    const key = registryKey(robotId);
    const existing = safeJsonParse(await kv.get(key)) || {};
    if (existing.socketId && existing.socketId !== socketId) return false;
    const next = withoutDedicatedFields({ ...existing, connected: false, lastHeartbeat: Date.now(), robotId, updatedAt: Date.now() });
    await kv.set(key, JSON.stringify(next), { ex: REGISTRY_TTL });
    return true;
  } catch {
    return false; // as setRobotState: Redis unavailable, live state degrades gracefully
  }
}

/**
 * Update telemetry fields from a live TELEMETRY event.
 * @param {object} kv
 * @param {string} robotId
 * @param {{ lat: number, lon: number, battery: number, status: string, speed: number }} telemetry
 */
async function updateTelemetry(kv, robotId, telemetry) {
  await setRobotState(kv, robotId, {
    lat: telemetry.lat,
    lon: telemetry.lon,
    battery: telemetry.battery,
    status: telemetry.status,
    speed: telemetry.speed,
    lastHeartbeat: Date.now(),
  });
}

/**
 * Update robot's zone assignment.
 * @param {object} kv
 * @param {string} robotId
 * @param {string|null} zoneId
 */
async function updateZone(kv, robotId, zoneId) {
  await setRobotState(kv, robotId, { zoneId: zoneId || null });
}

/**
 * Update robot's planned path (full route waypoints).
 * @param {object} kv
 * @param {string} robotId
 * @param {Array<{lat:number,lon:number}>|null} path
 */
async function updatePlannedPath(kv, robotId, path) {
  await setRobotState(kv, robotId, { plannedPath: Array.isArray(path) ? path : null });
}

/**
 * Update robot's utilization ratio (0–1).
 * @param {object} kv
 * @param {string} robotId
 * @param {number} utilization
 */
async function updateUtilization(kv, robotId, utilization) {
  const u = typeof utilization === "number" ? Math.max(0, Math.min(1, utilization)) : 0;
  await setRobotState(kv, robotId, { utilization: u });
}

/**
 * Update robot's assigned task ID.
 * @param {object} kv
 * @param {string} robotId
 * @param {string|null} taskId
 */
async function updateAssignedTask(kv, robotId, taskId) {
  await setRobotState(kv, robotId, { assignedTaskId: taskId || null });
}

/**
 * Update robot health status.
 * @param {object} kv
 * @param {string} robotId
 * @param {'OK'|'DEGRADED'|'FAULT'} healthStatus
 */
async function updateHealthStatus(kv, robotId, healthStatus) {
  const valid = ["OK", "DEGRADED", "FAULT"];
  await setRobotState(kv, robotId, { healthStatus: valid.includes(healthStatus) ? healthStatus : "OK" });
}

module.exports = {
  REGISTRY_TTL,
  PROBE_OWNED_FIELDS,
  STOP_LATCH_OWNED_FIELDS,
  registryKey,
  getRobotState,
  getManyRobotStates,
  setRobotState,
  mergeRobotState,
  buildMergedRegistryState,
  getAllRobotIds,
  markOnline,
  markOffline,
  updateTelemetry,
  updateZone,
  updatePlannedPath,
  updateUtilization,
  updateAssignedTask,
  updateHealthStatus,
};
