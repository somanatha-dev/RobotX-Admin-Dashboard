/**
 * ── PHASE 5: absorbed into the reconciler's orphan scan; retires at Phase 15 ──
 *
 * The execution plan records this file as "**absorbed** into reconciler orphan scan; file
 * retires at Phase 15". What it does — find work that is in flight, notice that the
 * process-local state supporting it is gone, and rebuild it — is §12.4 row 3 ("Leg
 * non-terminal with no commitment and no queue entry") restricted to exactly one trigger:
 * a process restart.
 *
 * §12.1 is explicit about why that restriction is the defect rather than the design:
 *
 * > They have different triggers but one shared root cause: **no component is responsible
 * > for noticing that a state has stopped progressing.** Patching each trigger
 * > individually leaves the seventh undiscovered.
 *
 * `reconciler.scanOrphanLegs` is the trigger-independent version. It runs continuously
 * rather than at boot, it repairs by conditional write rather than by rebuilding a cache,
 * it counts every repair against a per-category rate (§12.4), and it distinguishes a
 * `PLANNED` orphan after a coordinator failover — expected — from a `QUEUED` or
 * `ACCEPTED` one, which is a defect.
 *
 * **This file is not deleted in Phase 5 and its behaviour is unchanged.** It rebuilds
 * *Redis* state for the *legacy* dispatcher, which is still the production path and which
 * the reconciler deliberately does not touch: the engine reasons about Legs and
 * Commitments, not about `robotTaskState:` keys. Deleting it now would break task
 * recovery for the running system in exchange for a mechanism that Phase 15 has not yet
 * switched on. Phase 15 removes it together with the legacy path it serves.
 */

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
