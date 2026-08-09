/**
 * Task Service — the §3.4 request path.
 *
 * ── PHASE 15 — the legacy assignment path is gone ───────────────────────────
 * The execution plan's Phase 15 row retires "the legacy assignment path in
 * `task.service.js`", and its completion criterion is that the legacy decision path is
 * "**removed from the build, not merely bypassed**". This file is where that criterion is
 * most visible, so what left and what stayed are both stated.
 *
 * **Removed.** `_processAssignment` (greedy per-arrival selection through
 * `taskAssignment.service.js`), `_finalizeAssignment` (the bind-and-dispatch
 * transaction), `legacyDetachedAssignment` (the unsupervised `setImmediate` that §5.2
 * item C6 names as the root cause of "stuck at PENDING with no record of the failure"),
 * `seedTaskKeys` (the Redis writes that made the cache the source of truth for an
 * assignment), `getRoutesWithDistance` and `pathDistanceMeters` (the post-hoc route
 * measurement §13.1 replaces with a plan built *before* the choice), and the
 * `robotReserve:*` retry loop that was the only exclusivity mechanism this path had.
 * `tools/gates/checkLegacyRetirement.js` fails the build if any of them returns.
 *
 * **Kept, deliberately, until the retention window closes.** `rerouteTask` and the
 * `straightLineRoute` fallback it uses. Rerouting an in-flight legacy `Task` is not the
 * assignment path — it is an operator action on work already committed — and the plan
 * retires the `taskPath:*` / `robotTaskState:*` keys it reads "**after cutover**", not at
 * it. Deleting it here would strand every mission in flight across the cutover.
 * `docs/runbooks/cutover.md` names this as the last legacy surface and the condition
 * under which it goes.
 *
 * ── What `assignTask` does now, and what it refuses ────────────────────────
 * One path. Validate, create the `Task` row, map it to the domain (§2.4), and admit it to
 * the round through `engine/intake/intake.js`. There is no branch, no detach, and no
 * background computation: the request path's last act is a durable `WorkQueue` row and
 * the round path's first act is to read it, so no work depends on process-local state.
 *
 * When the engine is **not** live for the resolved shard, the request is **refused** with
 * 503 rather than queued. This is where the post-cutover world differs sharply from the
 * strangler world, and the difference is deliberate: with the legacy dispatcher out of the
 * build, admitting work to a shard whose coordinator is not running would recreate exactly
 * the defect the architecture exists to eliminate — a task accepted, durably recorded, and
 * never decided, with no component responsible for noticing (§12.1). A 503 naming the
 * state is honest; a queue nobody drains is not.
 *
 * ── The two halves of "is the engine live" ─────────────────────────────────
 * `engine/cutover/enabled.js` owns the conjunction (process `ENGINE_ENABLED` AND the
 * shard's `cutover.engine_enabled` binding). This file asks it rather than reading the
 * environment, so a shard that has not been staged is refused here for the same reason,
 * and with the same words, as it is everywhere else.
 */

const { toStringOrNull, toNumberOrNull } = require("../utils/parse");
const crypto = require("crypto");
const { directionsWithDistance } = require("./mapbox.service");
const { dispatchRerouteAlert } = require("./commandDispatcher.service");
const { safeJsonParse } = require("../utils/json");
const logger = require("../config/logger");
const intake = require("../engine/intake/intake");
const cadence = require("../engine/solve/cadence");
const cutoverEnabled = require("../engine/cutover/enabled");
const { taskToWork } = require("../engine/domain/mappers/legacyTask");
const { PURPOSES } = require("../engine/domain/purpose");

/**
 * Is the engine the decision path for the shard this request resolves to?
 *
 * Both halves, from one place (`engine/cutover/enabled.js`). Callers pass the published
 * configuration snapshot and the shard; a caller that passes neither gets `false`, which
 * is the right answer for a caller that cannot say which shard it means.
 *
 * @param {{ config?: object|null, regionId?: string|null, shardId?: string|null }} [context]
 * @returns {boolean}
 */
function engineEnabled(context) {
  const settings = context || {};
  return cutoverEnabled.forShard({
    snapshot: settings.config || null,
    shard: { regionId: settings.regionId || null, shardId: settings.shardId || null },
  });
}

/**
 * PHASE 10 — §3.4's request path, for a legacy `Task` row.
 *
 * The bridge is `domain/mappers/legacyTask.taskToWork()` (Phase 2), which maps one legacy
 * Task to exactly one Mission, one `PRIMARY` Leg, and two Stops with deterministic ids —
 * §2.4's own "the model collapses to the simple case with no overhead". The ids being
 * deterministic is what makes this idempotent: a retried submission materialises the same
 * Leg and the intake's own unique key answers with the original acceptance.
 *
 * This function lives here rather than inside `src/engine/intake/` deliberately: the
 * engine's intake takes a `Leg.id` and knows nothing about the legacy `Task` shape, and
 * teaching it that shape would give a Tier 1 module a dependency that retires at Phase 15.
 *
 * @param {object} prisma
 * @param {object} pending the freshly created legacy Task row
 * @param {object} options `{ cadenceConfig, admissionInputs, receivedAtMs }`
 * @returns {Promise<object>} the §3.4 response
 */
async function admitToRound(prisma, pending, options = {}) {
  const work = taskToWork(pending, { regionId: options.regionId ?? null });

  // Materialised idempotently: the ids are a pure function of `Task.taskId`, so a retry
  // converges on the same rows rather than creating a second Leg for one request.
  await prisma.mission.upsert({ where: { id: work.mission.id }, create: work.mission, update: {} });
  await prisma.leg.upsert({ where: { id: work.leg.id }, create: work.leg, update: {} });
  for (const stop of work.stops) {
    await prisma.stop.upsert({ where: { id: stop.id }, create: stop, update: {} });
  }

  const receivedAtMs = typeof options.receivedAtMs === "number" ? options.receivedAtMs : Date.now();
  const config = options.cadenceConfig || {};

  // The window quoted to the caller is the one the next round will actually use, taken
  // from the same `solve/cadence.js` the coordinator reads. Two independent notions of
  // the round window — one for quoting and one for running — would make the prediction
  // wrong by construction rather than by circumstance.
  const verdict = cadence.windowFor({
    queueDepth: options.queueDepth ?? 0,
    feasibleSupply: options.feasibleSupply ?? 0,
    slaClassesWaiting: options.slaClassesWaiting || [],
    slaBudgetsSeconds: options.slaBudgetsSeconds,
    config,
  });

  return intake.admit(
    { prisma },
    {
      legId: work.leg.id,
      taskId: pending.taskId,
      purpose: PURPOSES.PRIMARY.name,
      slaClass: options.slaClass ?? null,
      tenantId: options.tenantId ?? null,
      idempotencyKey: options.idempotencyKey,
      externalRef: pending.taskId,
      receivedAtMs,
      shardResolution: { regionId: options.regionId ?? null, shardByRegionId: options.shardByRegionId },
      admissionInputs: options.admissionInputs || {},
      cadence: {
        windowMs: verdict.windowMs,
        maxLegsPerRound: verdict.maxLegsThisRound,
        feasibleSupply: options.feasibleSupply,
        slaBudgetSeconds: options.slaBudgetSeconds,
      },
    },
  );
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

/**
 * Public API — §3.4's request path. One path, no branch.
 *
 * Validate, create the `Task` row, and admit it to the round. The response carries the
 * §3.4 contract: task id, idempotency echo, queue position, and a predicted assignment
 * window that does not imply an assignment has occurred.
 *
 * Refuses with 503 when the engine is not live for the resolved shard — see the file
 * header for why refusing beats queueing now that the legacy dispatcher is out of the
 * build.
 *
 * `task.robotId` — the legacy "assign me this specific robot" field — is **no longer
 * honoured**, and the response says so rather than ignoring it silently. A
 * caller-nominated agent bypasses candidate generation, the feasibility gate and the
 * solve together, and §7.1's rule is absolute: the gate "is evaluated before cost and is
 * never traded against it". The supported way to force an agent is §23.6's override
 * discipline — scoped, reasoned, audited, and refused outright for class I, R and F —
 * which Phase 14 shipped. No new capability is added here to replace the field; Phase 15
 * ships no new capability at all.
 */
async function assignTask(prisma, task, { kv, io, ...options } = {}) {
  let taskId = toStringOrNull(task?.taskId || task?.id);
  const nominatedAgentId = toStringOrNull(task?.robotId);
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

  // ── The cutover gate, checked before anything is written ──────────────────
  //
  // Before the row, not after it. A refused request that had already created a PENDING
  // `Task` would leave exactly the artefact §12.1 objects to: a durable record of work
  // that no component owns. The caller gets a 503 and the database is untouched.
  const posture = cutoverEnabled.describe({
    snapshot: options.config || null,
    shard: { regionId: options.regionId || null, shardId: options.shardId || null },
  });
  if (!posture.live) {
    const err = new Error(
      `the assignment engine is not live for this shard: ${posture.consequence}`,
    );
    err.status = 503;
    err.code = "ENGINE_NOT_LIVE";
    err.posture = posture;
    throw err;
  }

  // Create the PENDING task. Fast and synchronous: no routing provider is consulted on
  // the request path (§3.4), because the plan that will be routed is built inside the
  // round, before the choice, from the same artefact the cost model scores (§13.1).
  const pending = await prisma.task.create({
    data: { taskId, pickup, pickupLat, pickupLon, drop, dropLat, dropLon, status: "PENDING" },
    include: { robot: { select: { robotId: true } } },
  });

  // Notify dashboard so the UI shows the PENDING card with spinner right away.
  try {
    io?.to("dashboard")?.emit("TASK_CREATED", { ...pending, robot: null });
  } catch { /* ignore */ }

  // ── §3.4's request path ───────────────────────────────────────────────────
  //
  // The request path's last act is a durable `WorkQueue` row, and the round path's
  // first act is to read it. Between the two there is no closure, no timer, and no
  // process-local state, which is what makes the work survivable across a restart —
  // and what makes "stuck at PENDING with no record of the failure" unrepresentable:
  // a waiting Leg is a queue row with a position, an age, and a state.
  const admitted = await admitToRound(prisma, pending, {
    receivedAtMs: options.receivedAtMs,
    cadenceConfig: options.cadenceConfig,
    admissionInputs: options.admissionInputs,
    queueDepth: options.queueDepth,
    feasibleSupply: options.feasibleSupply,
    slaClass: options.slaClass,
    slaBudgetSeconds: options.slaBudgetSeconds,
    tenantId: options.tenantId,
    idempotencyKey: options.idempotencyKey,
    regionId: options.regionId,
    shardByRegionId: options.shardByRegionId,
  });

  // The legacy `{ ...task }` shape every existing caller reads is still present, and the
  // §3.4 contract arrives beside it under `intake`. The plan supersedes the old response
  // contract here (`docs/runbooks/cutover.md` carries the API version note); the legacy
  // fields are retained through the retention window so a consumer that has not migrated
  // reads a task row rather than a 500.
  //
  // `ignoredFields` is how a dropped input is reported rather than swallowed. A caller
  // still sending `robotId` learns that it had no effect, in the response, at the moment
  // it had no effect — not weeks later when someone notices the robot it named was never
  // the one that went.
  const ignoredFields = nominatedAgentId
    ? [
        {
          field: "robotId",
          value: nominatedAgentId,
          reason:
            "caller-nominated agents are not honoured: selection runs through candidate generation, the " +
            "feasibility gate and the solve (§6, §7, §9). Use the §23.6 override to force an agent.",
        },
      ]
    : [];

  return Object.assign({}, pending, { intake: admitted, ignoredFields });
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

module.exports = { assignTask, rerouteTask, straightLineRoute, admitToRound, engineEnabled };
