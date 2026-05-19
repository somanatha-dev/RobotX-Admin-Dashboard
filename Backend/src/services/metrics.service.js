/**
 * Metrics Service — DTARO
 *
 * Lightweight, Redis-backed metrics collection for system-level observability.
 * Tracks: allocation events, rerouting events, system snapshot counts.
 * All writes are best-effort (never throw to callers).
 */

const METRICS_TTL = 3600; // keep individual metric records for 1 hour

/**
 * Record a task allocation event.
 *
 * @param {object} kv
 * @param {{ robotId: string, taskId: string, cost: number, costComponents: object, latencyMs?: number }} data
 */
async function recordAllocation(kv, data) {
  if (!kv) return;
  try {
    await kv.set(
      `metrics:allocation:${Date.now()}`,
      JSON.stringify({ ...data, timestamp: Date.now() }),
      { ex: METRICS_TTL }
    );
  } catch {
    // ignore
  }
}


/**
 * Get a real-time system snapshot.
 * Reads DB for authoritative counts; Redis for live online count.
 *
 * @param {object} kv
 * @param {object} prisma
 * @returns {Promise<{
 *   timestamp: number,
 *   robots: { total: number, online: number, active: number, idle: number, issues: number },
 *   tasks: { total: number, pending: number, inProgress: number, completed: number, failed: number },
 *   obstacles: { active: number }
 * }>}
 */
async function getSystemMetrics(kv, prisma) {
  const snapshot = {
    timestamp: Date.now(),
    robots: { total: 0, online: 0, active: 0, idle: 0, issues: 0 },
    tasks: { total: 0, pending: 0, inProgress: 0, completed: 0, failed: 0 },
    obstacles: { active: 0 },
  };

  if (prisma) {
    try {
      const [robotStats, taskStats] = await Promise.all([
        prisma.robot.groupBy({ by: ["status"], _count: true }),
        prisma.task.groupBy({ by: ["status"], _count: true }),
      ]);

      for (const r of Array.isArray(robotStats) ? robotStats : []) {
        snapshot.robots.total += r._count;
        if (r.status === "ACTIVE") snapshot.robots.active = r._count;
        if (r.status === "IDLE") snapshot.robots.idle = r._count;
        if (r.status === "ISSUES") snapshot.robots.issues = r._count;
      }

      for (const t of Array.isArray(taskStats) ? taskStats : []) {
        snapshot.tasks.total += t._count;
        if (t.status === "PENDING") snapshot.tasks.pending = t._count;
        if (t.status === "IN_PROGRESS") snapshot.tasks.inProgress = t._count;
        if (t.status === "COMPLETED") snapshot.tasks.completed = t._count;
        if (t.status === "FAILED") snapshot.tasks.failed = t._count;
      }
    } catch {
      // ignore DB failures
    }
  }

  if (kv) {
    try {
      const ids = await kv.smembers("robots:all");
      snapshot.robots.online = Array.isArray(ids) ? ids.length : 0;

      // Count active EKB entries
      const obsIds = await kv.smembers("ekb:obstacles");
      snapshot.obstacles.active = Array.isArray(obsIds) ? obsIds.length : 0;
    } catch {
      // ignore Redis failures
    }
  }

  return snapshot;
}

module.exports = {
  recordAllocation,
  getSystemMetrics,
};
