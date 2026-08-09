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

/* ═══════════════════════════════════════════════════════════════════════════
   PHASE 11 — §21.4's metric set and §20.1's targets (§21, §20.1)
   ═══════════════════════════════════════════════════════════════════════════

   The two functions above are the legacy dispatcher's, unchanged, and retire with it
   at Phase 15. What follows is the engine's, and the split is deliberate rather than
   transitional: `recordAllocation` writes one Redis key per allocation with a one-hour
   TTL, which is precisely the unbounded per-decision write volume §21.2 exists to
   replace. Extending it would have made the engine's observability inherit a shape the
   architecture rejects.

   The engine's set is instead **derived from the durable record** —
   `src/engine/observability/metrics.js` — with only genuinely ephemeral quantities
   (latencies, cache hit rates, Explanation API sources) coming from the advisory
   `engine:sli:*` registry. See that module's header for why derivation beats
   instrumentation here.

   This file exposes the two entry points the HTTP surface needs, so that `app.js`
   depends on one metrics service rather than reaching into the engine tree directly.
*/

const engineMetrics = require("../engine/observability/metrics");
const engineSli = require("../engine/observability/sli");

/**
 * The §21.4 metric set for one shard over one window, with §20.1 target attainment.
 *
 * Best-effort in full: every derivation is individually guarded inside
 * `engineMetrics.derive`, and a total failure returns an empty report rather than
 * throwing. A metrics surface that fails whole during an incident is a metrics surface
 * nobody trusts during the next one.
 *
 * @param {object} deps `{ prisma, kv }`
 * @param {object} input `{ shardId, fromMs, toMs, registry, config, killSwitches,
 *   registerEntries }`
 * @returns {Promise<object>}
 */
async function getEngineMetrics(deps, input) {
  const source = input || {};
  try {
    const collected = deps && deps.kv ? await engineSli.collect(deps, source.shardId ?? "default") : { merged: engineSli.merge([]), instances: [] };

    const derived = await engineMetrics.derive(deps, { ...source, mergedSli: collected.merged });

    return {
      ...derived,
      sliInstances: collected.instances,
      // §20.1's targets, evaluated. `meets: null` where nothing has been observed —
      // an unmeasured target is not a met one.
      targets: engineSli.attainment({ merged: collected.merged, config: source.config }),
    };
  } catch (error) {
    return {
      window: null,
      readings: [],
      unavailable: [],
      failures: [{ id: "getEngineMetrics", message: error && error.message }],
      groups: engineMetrics.GROUPS,
      targets: null,
    };
  }
}

/**
 * The compact SLI block `/health` carries: how many of §20.1's targets are being met,
 * which safety-window targets are breached, and the group inventory.
 *
 * Deliberately small. `/health` is polled by monitoring on a short interval, and a
 * health check that ran the full §21.4 derivation would put the metric set's cost on
 * the availability path.
 *
 * @param {object} deps `{ kv }`
 * @param {object} input `{ shardId, config }`
 * @returns {Promise<object>}
 */
async function getSliSummary(deps, input) {
  const source = input || {};
  try {
    const collected = deps && deps.kv ? await engineSli.collect(deps, source.shardId ?? "default") : { merged: engineSli.merge([]), instances: [] };
    const targets = engineSli.attainment({ merged: collected.merged, config: source.config });

    const measured = targets.filter((row) => row.meets !== null);
    const breached = measured.filter((row) => row.meets === false);

    return {
      targets: targets.length,
      measured: measured.length,
      breached: breached.length,
      // §20.1 singles out two targets because they bound safety windows rather than
      // describing latency. A breach of either is a different fact from a slow p99, and
      // the health surface says which.
      safetyWindowBreaches: breached
        .filter((row) => row.boundsSafetyWindow)
        .map((row) => ({ id: row.id, statistic: row.statistic, target: row.target, observed: row.observed, bounds: row.window })),
      metricGroups: engineMetrics.GROUPS.length,
      metrics: engineMetrics.METRICS.length,
      sliInstances: collected.instances.length,
    };
  } catch {
    return null;
  }
}

module.exports = {
  recordAllocation,
  getSystemMetrics,
  getEngineMetrics,
  getSliSummary,
};
