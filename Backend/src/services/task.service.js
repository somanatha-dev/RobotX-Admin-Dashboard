const { toStringOrNull, toNumberOrNull } = require("../utils/parse");
const crypto = require("crypto");
const { selectNearestRobot } = require("./taskAssignment.service");
const { directionsWithDistance } = require("./mapbox.service");
const { updatePlannedPath, updateAssignedTask } = require("./robotRegistry.service");
const { dispatchTaskAssign, dispatchRerouteAlert } = require("./commandDispatcher.service");
const { recordAllocation } = require("./metrics.service");
const { safeJsonParse } = require("../utils/json");
const { haversineMeters } = require("../utils/distance");
const logger = require("../config/logger");
const robotStateCache = require("../cache/robotStateCache");

async function readRobotLive(kv, robotId) {
  if (!kv) return null;
  try {
    const raw = await kv.get(`robot:${robotId}`);
    return safeJsonParse(raw);
  } catch {
    return null;
  }
}

async function seedTaskKeys(kv, { taskId, robotId, toPickup, toDrop, pickup, drop }) {
  if (!kv) return;
  const ex = 86400;
  await Promise.all([
    kv.set(`taskPath:${taskId}`, JSON.stringify({ toPickup, toDrop, pickup, drop }), { ex }),
    kv.set(`task:${taskId}`, JSON.stringify({ phase: "TO_PICKUP", idx: 0, waitUntil: null }), { ex }),
    kv.set(`robotTask:${robotId}`, String(taskId), { ex }),
    kv.set(
      `robotTaskState:${robotId}`,
      JSON.stringify({ taskId: String(taskId), phase: "TO_PICKUP", pathIndex: 0, waitUntil: null, segment: "toPickup", startedAt: null, parking: null }),
      { ex }
    ),
  ]);
}

function straightLineRoute({ from, to, points = 40 } = {}) {
  if (!from || !to) return null;
  const fromLat = typeof from.lat === "number" ? from.lat : null;
  const fromLon = typeof from.lon === "number" ? from.lon : null;
  const toLat = typeof to.lat === "number" ? to.lat : null;
  const toLon = typeof to.lon === "number" ? to.lon : null;
  if (fromLat === null || fromLon === null || toLat === null || toLon === null) return null;
  const n = Math.max(2, Math.min(200, Math.floor(points)));
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 1 : i / (n - 1);
    out.push({ lat: fromLat + (toLat - fromLat) * t, lon: fromLon + (toLon - fromLon) * t });
  }
  return out;
}

/** Compute total path distance in metres from consecutive haversine segments. */
function pathDistanceMeters(points) {
  if (!Array.isArray(points) || points.length < 2) return null;
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (typeof a?.lat === "number" && typeof a?.lon === "number" &&
        typeof b?.lat === "number" && typeof b?.lon === "number") {
      total += haversineMeters(a.lat, a.lon, b.lat, b.lon);
    }
  }
  return total > 0 ? total : null;
}

async function getRoutesWithDistance({ from, pickup, drop } = {}) {
  // Dense fallback paths — only used when ALL Mapbox profiles fail.
  const fallbackToPickup = straightLineRoute({ from, to: pickup, points: 100 });
  const fallbackToDrop   = straightLineRoute({ from: pickup, to: drop, points: 100 });

  // Profile priority:
  //   driving  — public road network, works for any two addressable points
  //   walking  — pedestrian paths, better for short campus hops
  //   cycling  — additional fallback
  // Each profile is tried independently for both segments.
  for (const profile of ["driving", "walking", "cycling"]) {
    try {
      const [r1, r2] = await Promise.all([
        directionsWithDistance({ from, to: pickup, profile }),
        directionsWithDistance({ from: pickup, to: drop, profile }),
      ]);

      const totalDistance =
        typeof r1.distanceMeters === "number" && typeof r2.distanceMeters === "number"
          ? r1.distanceMeters + r2.distanceMeters
          : pathDistanceMeters([...r1.points, ...r2.points]);

      logger.info(
        `[Routes] ${profile} OK — ${r1.points.length} + ${r2.points.length} pts, ` +
        `${totalDistance ? (totalDistance / 1000).toFixed(2) + " km" : "?"}`
      );

      // Stitch the seam: make toDrop[0] == toPickup[-1] so the two route lines
      // share an exact common point and visually join seamlessly at the pickup marker.
      const stitchedToDrop = r2.points.slice();
      if (r1.points.length > 0 && stitchedToDrop.length > 0) {
        stitchedToDrop[0] = r1.points[r1.points.length - 1];
      }

      return {
        toPickup:       r1.points,
        toDrop:         stitchedToDrop,
        distanceMeters: totalDistance,
        usedFallback:   false,
      };
    } catch (e) {
      logger.warn(`[Routes] ${profile} failed — ${e?.message} (code=${e?.mapboxCode || "?"})`);
    }
  }

  // All Mapbox profiles failed — straight-line fallback (still navigable for simulation).
  logger.warn("[Routes] All Mapbox profiles failed — using straight-line fallback");
  if (!fallbackToPickup || !fallbackToDrop) {
    const err = new Error("Failed to generate routes (Mapbox + fallback unavailable)");
    err.status = 502;
    throw err;
  }
  const totalDistance = pathDistanceMeters([...fallbackToPickup, ...fallbackToDrop]);
  return {
    toPickup:       fallbackToPickup,
    toDrop:         fallbackToDrop,
    distanceMeters: totalDistance,
    usedFallback:   true,
  };
}

// F4: bounded retry against the next-best candidate when the top pick is
// concurrently claimed by another in-flight assignment, plus the short TTL
// on the Redis reservation itself — both back-stops against a reservation
// ever being held forever (deadlock/orphan avoidance).
//
// ── PHASE 3 note: this is no longer the system's only exclusivity mechanism ──
//
// `src/engine/commitment/commit.js` now provides the durable one the frozen
// architecture specifies (§10.3.2): a SERIALIZABLE transaction with `FOR UPDATE`
// row locks on both the agent and the Leg, guards G1–G6, a per-commitment fencing
// token, a lease, and two schema backstops that hold even when application logic is
// defective.
//
// This path is deliberately left intact and unchanged. The plan keeps the legacy
// dispatcher live and untouched until the Phase 15 cutover, and `ENGINE_ENABLED` is
// false in every environment, so for now this reservation remains the *only*
// protection this code path has — which is why `kv.reserveRobot` keeps its
// fail-closed behaviour for callers that do not opt into §10.4's advisory
// semantics. See the policy note in `src/cache/kv.js`.
//
// §10.2 records why this mechanism is insufficient on its own and must not be
// relied on once the durable path is live: the TTL can expire during a long
// finalisation while the holder continues to act as though it holds the lock;
// release performs no ownership check; and the transaction runs at READ COMMITTED,
// which does not serialise the conflicting pair.
const RESERVATION_TTL_SEC = 30;
const MAX_RESERVATION_RETRIES = 2;
const reservationKey = (robotId) => `robotReserve:${robotId}`;

/**
 * Background worker — runs DTARO robot selection, route computation, and DB
 * finalisation after the PENDING task record has already been returned to the client.
 */
async function _processAssignment(prisma, taskId, payload, { kv, io } = {}) {
  const { robotCodeIn, pickupLat, pickupLon, dropLat, dropLon, pickup, drop } = payload;

  let robotCode = null;
  let start = null;
  let reservedRobotCode = null;
  let allocationCost = null;
  let allocationComponents = null;
  let allocationLatencyMs = null;

  try {
    if (robotCodeIn) {
      // Manual assignment — reserve the explicitly requested robot. There's
      // no "next candidate" to fall back to here, so a lost reservation race
      // just fails the assignment (the caller asked for this exact robot).
      if (kv) {
        const ok = await kv.reserveRobot(reservationKey(robotCodeIn), taskId, RESERVATION_TTL_SEC);
        if (!ok) {
          const err = new Error(`Robot ${robotCodeIn} is currently being assigned to another task`);
          err.status = 409;
          throw err;
        }
        reservedRobotCode = robotCodeIn;
      }
      robotCode = robotCodeIn;
    } else {
      // DTARO auto-selection — if the winning candidate was just claimed by a
      // concurrent assignment, retry selection excluding it and fall through
      // to the next-best candidate instead of failing the task outright.
      const excludeRobotIds = [];
      const selectionStartedAt = Date.now();
      for (let attempt = 0; attempt <= MAX_RESERVATION_RETRIES; attempt++) {
        const best = await selectNearestRobot({
          prisma, kv,
          pickup: { lat: pickupLat, lon: pickupLon },
          excludeRobotIds,
        });

        if (!kv) {
          robotCode = best.robotId;
          start = best.start;
          allocationCost = best.cost ?? null;
          allocationComponents = best.costComponents ?? null;
          allocationLatencyMs = Date.now() - selectionStartedAt;
          break;
        }

        const ok = await kv.reserveRobot(reservationKey(best.robotId), taskId, RESERVATION_TTL_SEC);
        if (ok) {
          robotCode = best.robotId;
          start = best.start;
          reservedRobotCode = best.robotId;
          allocationCost = best.cost ?? null;
          allocationComponents = best.costComponents ?? null;
          allocationLatencyMs = Date.now() - selectionStartedAt;
          break;
        }

        logger.warn("Robot reservation lost to a concurrent assignment — retrying next candidate", {
          taskId, robotId: best.robotId, attempt,
        });
        excludeRobotIds.push(best.robotId);
      }

      if (!robotCode) {
        const err = new Error("No robot could be reserved for assignment (all candidates claimed concurrently)");
        err.status = 409;
        throw err;
      }
    }

    return await _finalizeAssignment(
      prisma, taskId, robotCode, start,
      { pickupLat, pickupLon, dropLat, dropLon },
      { kv, io, cost: allocationCost, costComponents: allocationComponents, latencyMs: allocationLatencyMs }
    );
  } finally {
    // Release on every path — success or failure — so a reservation never
    // outlives the request that took it (the TTL is only the last-resort
    // backstop, e.g. a process crash between reserve and release).
    if (reservedRobotCode && kv) {
      await kv.releaseReservation(reservationKey(reservedRobotCode));
    }
  }
}

async function _finalizeAssignment(prisma, taskId, robotCode, start, { pickupLat, pickupLon, dropLat, dropLon }, { kv, io, cost = null, costComponents = null, latencyMs = null } = {}) {
  const robotRow = await prisma.robot.findUnique({
    where: { robotId: robotCode },
    select: { id: true, status: true, currentTaskId: true, lat: true, lon: true, isOnline: true },
  });
  if (!robotRow) throw new Error("Robot not commissioned");
  if (robotRow.currentTaskId) throw new Error("Robot already has an active task");
  if (!robotRow.isOnline) throw new Error(`Robot ${robotCode} is offline`);

  const live = await readRobotLive(kv, robotCode);
  const startLat = typeof live?.lat === "number" ? live.lat : start?.lat ?? (typeof robotRow.lat === "number" ? robotRow.lat : null);
  const startLon = typeof live?.lon === "number" ? live.lon : start?.lon ?? (typeof robotRow.lon === "number" ? robotRow.lon : null);
  if (typeof startLat !== "number" || typeof startLon !== "number") throw new Error("Robot has no known position");

  const from        = { lat: startLat, lon: startLon };
  const pickupCoord = { lat: pickupLat, lon: pickupLon };
  const dropCoord   = { lat: dropLat,   lon: dropLon   };

  const routes = await getRoutesWithDistance({ from, pickup: pickupCoord, drop: dropCoord });

  // Finalise in a transaction: mark task ASSIGNED + bind robot.
  const updated = await prisma.$transaction(async (tx) => {
    const cur = await tx.robot.findUnique({ where: { id: robotRow.id }, select: { status: true, currentTaskId: true } });
    if (cur?.currentTaskId) throw new Error("Robot already has an active task");
    // Allow IDLE and PAUSED (PAUSED covers CHARGING virtual robots stored as PAUSED in DB).
    const assignable = new Set(["IDLE", "PAUSED"]);
    if (!assignable.has(String(cur?.status || ""))) throw new Error("Robot is not available for assignment");

    const t = await tx.task.update({
      where: { taskId },
      data: {
        robotId:       robotRow.id,
        status:        "ASSIGNED",
        distanceMeters: typeof routes.distanceMeters === "number" ? routes.distanceMeters : null,
      },
      include: { robot: { select: { robotId: true, id: true } } },
    });

    await tx.robot.update({
      where: { id: robotRow.id },
      data: { currentTaskId: t.id, status: "ACTIVE", isOnline: true, lastSeenAt: new Date() },
    });

    return t;
  });

  // Keep the telemetry-hot-path cache in sync with the status/currentTaskId
  // transition the transaction above just committed (see robotStateCache.js).
  robotStateCache.set(robotCode, { status: "ACTIVE", isOnline: true });

  // Cache routes + state machine in Redis.
  if (kv) {
    await seedTaskKeys(kv, {
      taskId, robotId: robotCode,
      toPickup: routes.toPickup, toDrop: routes.toDrop,
      pickup: pickupCoord, drop: dropCoord,
    });

    // Emit TASK_ASSIGNED for map route overlays.
    try {
      io?.to("dashboard")?.emit("TASK_ASSIGNED", {
        taskId,
        robotId:       robotCode,
        pickup:        pickupCoord,
        drop:          dropCoord,
        pathToPickup:  routes.toPickup,
        pathToDrop:    routes.toDrop,
        usedFallback:  Boolean(routes.usedFallback),
      });
    } catch { /* ignore */ }

    // Emit TASK_UPDATED so the task card in the UI refreshes with robot + distance.
    try {
      io?.to("dashboard")?.emit("TASK_UPDATED", {
        taskId,
        status:        "ASSIGNED",
        robotId:       robotCode,
        robot:         { robotId: robotCode },
        distanceMeters: typeof routes.distanceMeters === "number" ? routes.distanceMeters : null,
      });
    } catch { /* ignore */ }

    try {
      const fullPath = [...(routes.toPickup || []), ...(routes.toDrop || [])];
      await updatePlannedPath(kv, robotCode, fullPath);
      await updateAssignedTask(kv, robotCode, taskId);
    } catch { /* non-critical */ }

    try {
      await dispatchTaskAssign(io, robotCode, {
        taskId,
        pickup: pickupCoord, drop: dropCoord,
        pathToPickup: routes.toPickup, pathToDrop: routes.toDrop,
      });
    } catch { /* non-critical */ }

    try {
      await recordAllocation(kv, { robotId: robotCode, taskId, cost, costComponents, latencyMs });
    } catch { /* non-critical */ }
  }

  return updated;
}

/**
 * Public API — creates a PENDING task immediately and processes the DTARO
 * assignment in the background so the HTTP response is fast.
 */
async function assignTask(prisma, task, { kv, io } = {}) {
  let taskId = toStringOrNull(task?.taskId || task?.id);
  const robotCodeIn = toStringOrNull(task?.robotId);
  const pickup      = toStringOrNull(task?.pickup);
  const drop        = toStringOrNull(task?.drop);

  if (!pickup || !drop) {
    const err = new Error("pickup and drop are required");
    err.status = 400;
    throw err;
  }

  if (!taskId) {
    const suffix = crypto.randomInt(100, 1000);
    taskId = `TSK-${Date.now()}-${suffix}`;
  }

  const pickupLat = toNumberOrNull(task?.pickupLat);
  const pickupLon = toNumberOrNull(task?.pickupLon);
  const dropLat   = toNumberOrNull(task?.dropLat);
  const dropLon   = toNumberOrNull(task?.dropLon);

  if (pickupLat === null || pickupLon === null || dropLat === null || dropLon === null) {
    const err = new Error("pickupLat/pickupLon/dropLat/dropLon are required");
    err.status = 400;
    throw err;
  }

  // Phase 1 — Create PENDING task immediately (fast, no Mapbox calls).
  const pending = await prisma.task.create({
    data: { taskId, pickup, pickupLat, pickupLon, drop, dropLat, dropLon, status: "PENDING" },
    include: { robot: { select: { robotId: true } } },
  });

  // Notify dashboard so the UI shows the PENDING card with spinner right away.
  try {
    io?.to("dashboard")?.emit("TASK_CREATED", { ...pending, robot: null });
  } catch { /* ignore */ }

  // Phase 2 — Heavy work in background: DTARO + Mapbox + DB update.
  setImmediate(async () => {
    try {
      await _processAssignment(prisma, taskId, { robotCodeIn, pickupLat, pickupLon, dropLat, dropLon, pickup, drop }, { kv, io });
    } catch (e) {
      logger.error("Task assignment failed", { taskId, error: e?.message });
      try {
        await prisma.task.update({ where: { taskId }, data: { status: "FAILED" } });
        io?.to("dashboard")?.emit("TASK_UPDATED", { taskId, status: "FAILED" });
      } catch { /* ignore */ }
    }
  });

  return pending;
}

/**
 * Reroute an in-progress task from the robot's current position.
 * Called when the operator selects REROUTE in the Decision Required modal.
 */
async function rerouteTask(prisma, taskId, { kv, io } = {}) {
  const task = await prisma.task.findUnique({
    where: { taskId },
    include: { robot: { select: { robotId: true, lat: true, lon: true } } },
  });
  if (!task) { const e = new Error("Task not found"); e.status = 404; throw e; }
  if (!task.robot) { const e = new Error("No robot assigned to task"); e.status = 400; throw e; }

  const robotId = task.robot.robotId;

  // Get robot's current live position from Redis, fall back to DB
  const live = await readRobotLive(kv, robotId);
  const curLat = typeof live?.lat === "number" ? live.lat
    : typeof task.robot.lat === "number" ? task.robot.lat : null;
  const curLon = typeof live?.lon === "number" ? live.lon
    : typeof task.robot.lon === "number" ? task.robot.lon : null;
  if (curLat === null || curLon === null) {
    const e = new Error("Robot has no known position"); e.status = 400; throw e;
  }

  // Determine which segment the robot is currently navigating
  let segment = "toPickup";
  let targetCoord = { lat: task.pickupLat, lon: task.pickupLon };
  try {
    const rawState = kv ? await kv.get(`robotTaskState:${robotId}`) : null;
    const state = safeJsonParse(rawState);
    if (state?.phase === "TO_DROP" || state?.segment === "toDrop") {
      segment = "toDrop";
      targetCoord = { lat: task.dropLat, lon: task.dropLon };
    }
  } catch { /* ignore */ }

  // Compute fresh Mapbox route from current position
  const from = { lat: curLat, lon: curLon };
  let newPoints = null;
  for (const profile of ["driving", "walking", "cycling"]) {
    try {
      const r = await directionsWithDistance({ from, to: targetCoord, profile });
      newPoints = r.points;
      logger.info(`[Reroute] ${profile} route OK — ${newPoints.length} pts, task ${taskId}`);
      break;
    } catch (e) {
      logger.warn(`[Reroute] ${profile} failed — ${e?.message}`);
    }
  }
  // Straight-line fallback
  if (!newPoints) {
    newPoints = straightLineRoute({ from, to: targetCoord, points: 100 });
    logger.warn(`[Reroute] Using straight-line fallback for task ${taskId}`);
  }
  if (!newPoints) {
    const e = new Error("Cannot compute reroute path"); e.status = 502; throw e;
  }

  // Update Redis task path cache with the new segment
  if (kv) {
    try {
      const rawPath = await kv.get(`taskPath:${taskId}`);
      const cached = safeJsonParse(rawPath) || {};
      const updated = { ...cached, [segment]: newPoints };
      await kv.set(`taskPath:${taskId}`, JSON.stringify(updated), { ex: 86400 });
    } catch { /* non-critical */ }

    // Reset pathIndex so robot starts the new path from index 0
    try {
      const rawState = await kv.get(`robotTaskState:${robotId}`);
      const state = safeJsonParse(rawState);
      if (state) {
        state.pathIndex = 0;
        await kv.set(`robotTaskState:${robotId}`, JSON.stringify(state), { ex: 86400 });
      }
    } catch { /* non-critical */ }
  }

  // Notify dashboard — useRobotStream listens for TASK_UPDATED with action REROUTED
  try {
    io?.to("dashboard")?.emit("TASK_UPDATED", {
      taskId,
      robotId,
      action: "REROUTED",
      segment,
      newPath: newPoints,
    });
  } catch { /* ignore */ }

  // Send REROUTE_ALERT to the robot socket with the full new path
  try {
    await dispatchRerouteAlert(io, robotId, {
      taskId,
      segment,
      newPath: newPoints,
    });
  } catch { /* non-critical — robot will use existing path if not reached */ }

  logger.info(`[Reroute] Task ${taskId} rerouted — ${newPoints.length} pts, segment=${segment}`);
  return { taskId, robotId, segment, points: newPoints.length };
}

module.exports = { assignTask, rerouteTask, straightLineRoute, getRoutesWithDistance };
