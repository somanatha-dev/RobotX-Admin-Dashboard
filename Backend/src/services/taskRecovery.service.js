const { directionsPolyline } = require("./mapbox.service");

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
  const fallbackToPickup = straightLineRoute({ from, to: pickup, points: 50 });
  const fallbackToDrop = straightLineRoute({ from: pickup, to: drop, points: 60 });

  try {
    const toPickup = await directionsPolyline({ from, to: pickup });
    const toDrop = await directionsPolyline({ from: pickup, to: drop });
    return { toPickup, toDrop, usedFallback: false };
  } catch {
    if (!fallbackToPickup || !fallbackToDrop) {
      const err = new Error("Failed to generate routes (Mapbox unavailable and fallback invalid)");
      err.status = 502;
      throw err;
    }
    return { toPickup: fallbackToPickup, toDrop: fallbackToDrop, usedFallback: true };
  }
}

async function seedRecoveredKeys(kv, { taskId, robotCode, toPickup, toDrop, pickup, drop, startedAtMs } = {}) {
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
    kv.set(`robotTask:${robotCode}`, String(taskId), { ex }),
    kv.set(
      `robotTaskState:${robotCode}`,
      JSON.stringify({
        taskId: String(taskId),
        phase: "TO_PICKUP",
        pathIndex: 0,
        waitUntil: null,
        segment: "toPickup",
        startedAt: typeof startedAtMs === "number" ? startedAtMs : null,
        parking: null,
      }),
      { ex }
    ),
  ]);
}

async function recoverActiveTasks(prisma, kv, io, { logger } = {}) {
  const log = logger || console;
  if (!prisma || !kv) return { recovered: 0 };

  const tasks = await prisma.task.findMany({
    where: { status: { in: ["ASSIGNED", "IN_PROGRESS"] } },
    include: { robot: { select: { robotId: true, lat: true, lon: true } } },
  });

  let recovered = 0;

  for (const t of Array.isArray(tasks) ? tasks : []) {
    const taskId = typeof t?.taskId === "string" ? t.taskId : null;
    const robotCode = typeof t?.robot?.robotId === "string" ? t.robot.robotId : null;
    if (!taskId || !robotCode) continue;

    const pickup = { lat: t.pickupLat, lon: t.pickupLon };
    const drop = { lat: t.dropLat, lon: t.dropLon };

    const from = {
      lat: typeof t.robot.lat === "number" ? t.robot.lat : pickup.lat,
      lon: typeof t.robot.lon === "number" ? t.robot.lon : pickup.lon,
    };

    if (typeof kv.sadd === "function") {
      try {
        await kv.sadd("robots:all", robotCode);
      } catch {
        // ignore
      }
    }

    let routes;
    try {
      routes = await getRoutesWithFallback({ from, pickup, drop });
    } catch (e) {
      log.error("task recovery: route generation failed", { taskId, robotCode, error: e?.message || e });
      continue;
    }

    try {
      await seedRecoveredKeys(kv, {
        taskId,
        robotCode,
        toPickup: routes.toPickup,
        toDrop: routes.toDrop,
        pickup,
        drop,
        startedAtMs: t.startedAt ? t.startedAt.getTime?.() || null : null,
      });

      try {
        io?.to("dashboard")?.emit("TASK_ASSIGNED", {
          taskId,
          robotId: robotCode,
          pickup,
          drop,
          pathToPickup: routes.toPickup,
          pathToDrop: routes.toDrop,
          usedFallback: Boolean(routes.usedFallback),
        });
      } catch {
        // ignore
      }

      recovered += 1;
    } catch (e) {
      log.error("task recovery: redis seed failed", { taskId, robotCode, error: e?.message || e });
    }
  }

  if (recovered) log.info("Recovered active tasks into Redis", { recovered });
  return { recovered };
}

module.exports = {
  recoverActiveTasks,
};
