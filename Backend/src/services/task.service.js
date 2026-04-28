const { toStringOrNull, toNumberOrNull } = require("../utils/parse");
const crypto = require("crypto");
const { selectNearestRobot } = require("./taskAssignment.service");
const { directionsPolyline } = require("./mapbox.service");

function safeJsonParse(raw) {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

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
    kv.set(
      `taskPath:${taskId}`,
      JSON.stringify({
        toPickup,
        toDrop,
        pickup,
        drop,
      }),
      { ex }
    ),
    kv.set(
      `task:${taskId}`,
      JSON.stringify({
        phase: "TO_PICKUP",
        idx: 0,
        waitUntil: null,
      }),
      { ex }
    ),
    kv.set(`robotTask:${robotId}`, String(taskId), { ex }),
    kv.set(
      `robotTaskState:${robotId}`,
      JSON.stringify({
        taskId: String(taskId),
        phase: "TO_PICKUP",
        pathIndex: 0,
        waitUntil: null,
        segment: "toPickup",
        startedAt: null,
        parking: null,
      }),
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
  for (let i = 0; i < n; i += 1) {
    const t = n === 1 ? 1 : i / (n - 1);
    out.push({
      lat: fromLat + (toLat - fromLat) * t,
      lon: fromLon + (toLon - fromLon) * t,
    });
  }
  return out;
}

async function getRoutesWithFallback({ from, pickup, drop } = {}) {
  // Always returns { toPickup, toDrop } or throws.
  const fallbackToPickup = straightLineRoute({ from, to: pickup, points: 50 });
  const fallbackToDrop = straightLineRoute({ from: pickup, to: drop, points: 60 });

  try {
    const toPickup = await directionsPolyline({ from, to: pickup });
    const toDrop = await directionsPolyline({ from: pickup, to: drop });
    return { toPickup, toDrop, usedFallback: false };
  } catch {
    if (!fallbackToPickup || !fallbackToDrop) {
      const err = new Error("Failed to generate routes (Mapbox + fallback unavailable)");
      err.status = 502;
      throw err;
    }
    return { toPickup: fallbackToPickup, toDrop: fallbackToDrop, usedFallback: true };
  }
}

async function assignTask(prisma, task, { kv, io } = {}) {
  let taskId = toStringOrNull(task?.taskId || task?.id);
  const robotCodeIn = toStringOrNull(task?.robotId);
  const pickup = toStringOrNull(task?.pickup);
  const drop = toStringOrNull(task?.drop);

  if (!pickup || !drop) {
    const err = new Error("pickup and drop are required");
    err.status = 400;
    throw err;
  }

  if (!taskId) {
    // Human-friendly id used across UI.
    const suffix = crypto.randomInt(100, 1000);
    taskId = `TSK-${Date.now()}-${suffix}`;
  }

  const pickupLat = toNumberOrNull(task?.pickupLat);
  const pickupLon = toNumberOrNull(task?.pickupLon);
  const dropLat = toNumberOrNull(task?.dropLat);
  const dropLon = toNumberOrNull(task?.dropLon);

  if (pickupLat === null || pickupLon === null || dropLat === null || dropLon === null) {
    const err = new Error("pickupLat/pickupLon/dropLat/dropLon are required");
    err.status = 400;
    throw err;
  }

  // Auto-assignment: if robotId is omitted/empty, choose nearest IDLE robot by real road duration.
  let robotCode = robotCodeIn;
  let start = null;
  const autoAssigned = !robotCode;

  if (!robotCode) {
    const best = await selectNearestRobot({
      prisma,
      kv,
      pickup: { lat: pickupLat, lon: pickupLon },
    });
    robotCode = best.robotId;
    start = best.start;
  }

  const robotRow = await prisma.robot.findUnique({
    where: { robotId: robotCode },
    select: { id: true, status: true, currentTaskId: true, lat: true, lon: true },
  });
  if (!robotRow) {
    const err = new Error("Robot not commissioned");
    err.status = 400;
    throw err;
  }

  if (robotRow.currentTaskId) {
    const err = new Error("Robot already has an active task");
    err.status = 409;
    throw err;
  }

  // SAFE PATTERN: compute everything FIRST (robot + routes), then DB transaction.
  // Routes are always produced (Mapbox or straight-line fallback) so the system never blocks.
  const live = await readRobotLive(kv, robotCode);
  const startLat = typeof live?.lat === "number" ? live.lat : start?.lat ?? (typeof robotRow.lat === "number" ? robotRow.lat : null);
  const startLon = typeof live?.lon === "number" ? live.lon : start?.lon ?? (typeof robotRow.lon === "number" ? robotRow.lon : null);

  if (typeof startLat !== "number" || typeof startLon !== "number") {
    const err = new Error("Robot has no known position to route from");
    err.status = 409;
    throw err;
  }

  const from = { lat: startLat, lon: startLon };
  const pickupCoord = { lat: pickupLat, lon: pickupLon };
  const dropCoord = { lat: dropLat, lon: dropLon };
  const routes = await getRoutesWithFallback({ from, pickup: pickupCoord, drop: dropCoord });

  // 1) Persist task + bind robot (transaction)
  const created = await prisma.$transaction(async (tx) => {
    // Re-check availability inside the transaction.
    const cur = await tx.robot.findUnique({ where: { id: robotRow.id }, select: { status: true, currentTaskId: true } });
    if (cur?.currentTaskId) {
      const err = new Error("Robot already has an active task");
      err.status = 409;
      throw err;
    }
    if (String(cur?.status || "") !== "IDLE") {
      const err = new Error("Robot is not IDLE");
      err.status = 409;
      throw err;
    }

    const t = await tx.task.create({
      data: {
        taskId,
        robotId: robotRow.id,
        pickup,
        pickupLat,
        pickupLon,
        drop,
        dropLat,
        dropLon,
        status: "ASSIGNED",
      },
      include: { robot: true },
    });

    await tx.robot.update({
      where: { id: robotRow.id },
      data: {
        currentTaskId: t.id,
        status: "ACTIVE",
        isOnline: true,
        lastSeenAt: new Date(),
      },
    });

    return t;
  });

  // 2) Cache routes + state machine in Redis and emit TASK_ASSIGNED once.
  if (kv) {
    await seedTaskKeys(kv, {
      taskId,
      robotId: robotCode,
      toPickup: routes.toPickup,
      toDrop: routes.toDrop,
      pickup: pickupCoord,
      drop: dropCoord,
    });

    try {
      io?.to("dashboard")?.emit("TASK_ASSIGNED", {
        taskId,
        robotId: robotCode,
        pickup: pickupCoord,
        drop: dropCoord,
        pathToPickup: routes.toPickup,
        pathToDrop: routes.toDrop,
        usedFallback: Boolean(routes.usedFallback),
      });
    } catch {
      // ignore
    }
  }

  return created;
}

module.exports = {
  assignTask,
};
