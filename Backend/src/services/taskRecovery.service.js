const { safeJsonParse } = require("../utils/json");
const { getRoutesWithDistance } = require("./task.service");

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

async function recoverActiveTasks(prisma, kv, io, { logger: _log } = {}) {
  const log = _log || console;
  if (!prisma || !kv) return { recovered: 0 };

  const tasks = await prisma.task.findMany({
    where: { status: { in: ["ASSIGNED", "IN_PROGRESS"] } },
    include: { robot: { select: { robotId: true, lat: true, lon: true } } },
  });

  let recovered = 0;

  for (const t of Array.isArray(tasks) ? tasks : []) {
    const taskId    = typeof t?.taskId     === "string" ? t.taskId             : null;
    const robotCode = typeof t?.robot?.robotId === "string" ? t.robot.robotId  : null;
    if (!taskId || !robotCode) continue;

    const pickup = { lat: t.pickupLat, lon: t.pickupLon };
    const drop   = { lat: t.dropLat,   lon: t.dropLon   };

    // Prefer Redis live position (updated every 2 s by telemetry handler) over DB.
    // This gives the most accurate "where was the robot before shutdown" position,
    // which recoverActiveTasks uses as the route start so path[0] ≈ robot position.
    let from = {
      lat: typeof t.robot.lat === "number" ? t.robot.lat : pickup.lat,
      lon: typeof t.robot.lon === "number" ? t.robot.lon : pickup.lon,
    };
    try {
      const liveRaw = await kv.get(`robot:${robotCode}`);
      const live    = safeJsonParse(liveRaw);
      if (typeof live?.lat === "number" && typeof live?.lon === "number") {
        from = { lat: live.lat, lon: live.lon };
      }
    } catch { /* fall back to DB position */ }

    if (typeof kv.sadd === "function") {
      try { await kv.sadd("robots:all", robotCode); } catch { /* ignore */ }
    }

    let routes;
    try {
      routes = await getRoutesWithDistance({ from, pickup, drop });
    } catch (e) {
      log.error("task recovery: route generation failed", { taskId, robotCode, error: e?.message || e });
      continue;
    }

    try {
      await seedRecoveredKeys(kv, {
        taskId, robotCode,
        toPickup: routes.toPickup, toDrop: routes.toDrop,
        pickup, drop,
        startedAtMs: t.startedAt ? t.startedAt.getTime?.() || null : null,
      });
      recovered += 1;
      log.info(`[TaskRecovery] task ${taskId} → ${robotCode} (${routes.toPickup.length}+${routes.toDrop.length} pts, fallback=${routes.usedFallback})`);
    } catch (e) {
      log.error("task recovery: redis seed failed", { taskId, robotCode, error: e?.message || e });
    }
  }

  if (recovered) log.info(`Recovered ${recovered} active task(s) into Redis`);
  return { recovered };
}

module.exports = {
  recoverActiveTasks,
};
