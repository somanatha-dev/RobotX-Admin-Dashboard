"use strict";

/**
 * Assignment read model — the legacy `Task`/`Robot` view of an authoritative commitment.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * THIS IS A PROJECTION. IT DECIDES NOTHING.
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * The assignment is made by candidate generation (§6), the feasibility gate (§7) and the
 * solve (§9), and it is recorded by §10.3.2's serialised conditional write as a
 * `Commitment` and a `Leg` state. That is the authority, and it does not move.
 *
 * What this module does is make the same fact readable by the surfaces that were built
 * against the legacy schema — the Units list, the Tasks list, the dashboard cards and the
 * map — which read `Task.robotId`, `Task.status` and `Robot.currentTaskId`. Those columns
 * were never written by the engine, so after the cutover a task that the engine had
 * genuinely assigned still rendered as `PENDING` with no robot: not a wrong answer, an
 * absent one.
 *
 * ── The four rules that keep it a projection ────────────────────────────────
 *
 *  1. **It runs only after the decision exists.** Its single caller is the `OFFER_ACCEPT`
 *     handler, and only on the `APPLIED` disposition — after the commitment is HARD and
 *     the Leg has reached `ACCEPTED`. There is no path that reaches it before a decision,
 *     and none that reaches it when a decision was refused.
 *
 *  2. **It writes only legacy columns.** `Task.robotId`, `Task.status`, `Task.startedAt`,
 *     `Robot.currentTaskId`, `Robot.status`. It never writes `Commitment`, `Leg`, `Agent`,
 *     `WorkQueue`, `Outbox`, `Round` or any decision record — the rows the engine reasons
 *     from. A projection that wrote one of those would be a second writer of the
 *     authority, which is the defect the cutover removed.
 *
 *  3. **Nothing in the decision path can read it.** This module is imported by socket
 *     handlers only. `tests/engine/assignmentProjectionIsolation.test.js` asserts both
 *     directions structurally — that this module imports no candidate, feasibility, cost,
 *     plan or solve module, and that no module under `src/engine/**` or the coordinator's
 *     solve path imports this one — so the isolation is a property of the build rather
 *     than a habit.
 *
 *  4. **Its failure is not the assignment's failure.** It runs outside the transaction
 *     that applied the accept. A projection that could abort the authoritative write would
 *     be participating in it.
 *
 * ── What it is NOT ──────────────────────────────────────────────────────────
 * It is not `_finalizeAssignment`, and it is not a route back to it. That function chose a
 * robot and bound it; this one is handed the robot the engine chose and copies the choice
 * into two columns. `tools/gates/checkLegacyRetirement.js` stays green because nothing
 * here selects, scores, reserves or dispatches — it reads a decision that has already been
 * taken and writes what the old screens read.
 */

const { toStringOrNull } = require("../utils/parse");

/**
 * The legacy `TaskStatus` values a projection may write over.
 *
 * Only `PENDING`. A task that has since been cancelled, failed or completed has reached a
 * state somebody or something else established, and overwriting it with `ASSIGNED` would
 * be the unconditional write §4.1 rule 2 exists to prohibit — a cancelled task silently
 * reverting to assigned is this codebase's own recorded defect.
 *
 * @structural the legacy status vocabulary, not a tunable value
 */
const PROJECTABLE_FROM = Object.freeze(["PENDING"]);

/** Statuses a reassigned Task is moved to its new robot from. */
const REPROJECTABLE_FROM = Object.freeze(["ASSIGNED", "IN_PROGRESS"]);

/** The legacy status an accepted assignment projects to. */
const PROJECTED_STATUS = "ASSIGNED";

/**
 * The Task a Leg discharges, or null when there is not exactly one.
 *
 * Through §2.8's `Task >──< Mission >──< Leg`, which is the relationship the schema
 * already draws. Ambiguity is refused rather than resolved arbitrarily: a Leg discharging
 * two Tasks has no single Task for `Robot.currentTaskId` to point at, and picking one
 * would show an operator a binding that does not exist.
 *
 * @param {object} prisma
 * @param {string} legRowId the `Leg.id` the commitment names
 * @returns {Promise<object|null>} `{ id, taskId, status, pickup, drop, … }`
 */
async function taskForLeg(prisma, legRowId) {
  if (!legRowId) return null;

  const leg = await prisma.leg.findUnique({
    where: { id: legRowId },
    select: {
      mission: {
        select: {
          tasks: {
            select: {
              id: true,
              taskId: true,
              status: true,
              pickup: true,
              pickupLat: true,
              pickupLon: true,
              drop: true,
              dropLat: true,
              dropLon: true,
            },
          },
        },
      },
    },
  });

  const tasks = (leg && leg.mission && leg.mission.tasks) || [];
  return tasks.length === 1 ? tasks[0] : null;
}

/**
 * Project an accepted assignment onto the legacy columns the existing UI reads.
 *
 * ── Conditional on both sides ───────────────────────────────────────────────
 * The Task is moved only from `PENDING`, and the Robot is bound only when it is not
 * already carrying a different task. Both are `updateMany` with the condition in the
 * `where`, so a concurrent cancellation wins rather than being overwritten, and the caller
 * is told how many rows actually moved instead of assuming.
 *
 * @param {object} prisma
 * @param {object} input
 * @param {string} input.legRowId the `Leg.id` the commitment names
 * @param {string} input.robotCode the legacy `Robot.robotId` of the accepting agent
 * @returns {Promise<{ projected: boolean, reason: string|null, taskId: string|null,
 *                     robotId: string|null, task: object|null }>}
 */
async function projectAcceptedAssignment(prisma, input) {
  const settings = input || {};
  const legRowId = toStringOrNull(settings.legRowId);
  const robotCode = toStringOrNull(settings.robotCode);

  if (!legRowId || !robotCode) {
    return { projected: false, reason: "INCOMPLETE_INPUT", taskId: null, robotId: null, task: null };
  }

  const task = await taskForLeg(prisma, legRowId);
  if (!task) {
    // A Leg with no single Task is legitimate — an engine-native mission has no legacy
    // Task at all. There is simply nothing to project, which is different from a failure.
    return { projected: false, reason: "NO_SINGLE_TASK_FOR_LEG", taskId: null, robotId: robotCode, task: null };
  }

  const robot = await prisma.robot.findUnique({
    where: { robotId: robotCode },
    select: { id: true, currentTaskId: true },
  });
  if (!robot) {
    return { projected: false, reason: "UNKNOWN_ROBOT", taskId: task.taskId, robotId: robotCode, task };
  }

  const moved = await prisma.$transaction(async (tx) => {
    const taskUpdate = await tx.task.updateMany({
      where: {
        id: task.id,
        OR: [
          { status: { in: PROJECTABLE_FROM } },
          // A reassigned Leg (§4.7): the engine has just applied this robot's ACCEPT, so the
          // read model follows it off the previous robot. Without this the Task kept naming a
          // robot that no longer held the work, and the new robot's TASK_COMPLETE — which
          // marks the Task complete only for the robot the Task names — left it ASSIGNED for
          // ever although its Leg settled (measured on the V1 failure run, 2026-09-23).
          { status: { in: REPROJECTABLE_FROM }, robotId: { not: robot.id } },
        ],
      },
      data: { robotId: robot.id, status: PROJECTED_STATUS, startedAt: new Date() },
    });

    if (taskUpdate.count !== 1) return { count: 0, reason: "TASK_NOT_PENDING" };

    // The previous robot no longer carries this Task.
    await tx.robot.updateMany({
      where: { currentTaskId: task.id, id: { not: robot.id } },
      data: { currentTaskId: null },
    });

    // `currentTaskId` is a strict 1:1 (`@unique`), so binding a robot that already carries
    // a different task would violate the constraint rather than quietly overwrite. The
    // condition makes that a no-op with a reason instead of an exception.
    const robotUpdate = await tx.robot.updateMany({
      where: { id: robot.id, OR: [{ currentTaskId: null }, { currentTaskId: task.id }] },
      data: { currentTaskId: task.id, status: "ACTIVE" },
    });

    if (robotUpdate.count !== 1) {
      // The Task move and the Robot binding are one projection; a half-applied one would
      // show a task assigned to a robot that is not carrying it.
      throw Object.assign(new Error("ROBOT_ALREADY_BOUND"), { projectionReason: "ROBOT_ALREADY_BOUND" });
    }

    return { count: 1, reason: null };
  }).catch((e) => ({ count: 0, reason: e?.projectionReason || "PROJECTION_FAILED" }));

  return {
    projected: moved.count === 1,
    reason: moved.reason,
    taskId: task.taskId,
    robotId: robotCode,
    task,
  };
}

/**
 * The route the offer carried, read back for the frontend's map.
 *
 * ── Why the outbox row is the source ────────────────────────────────────────
 * The geometry was resolved before the commitment transaction and written into the
 * `Outbox` row's payload inside it (§11.1 — "either both exist or neither does"). So the
 * durable record of *the route the agent was actually offered* is that row, and reading it
 * back is how the dashboard draws the same line the agent is driving rather than a second
 * route computed later that could differ.
 *
 * Nothing is recomputed here and no provider is called. If the offer carried no geometry,
 * this returns null and no `TASK_ASSIGNED` is emitted — the map draws nothing, which is
 * the honest rendering of an offer the agent will refuse.
 *
 * @param {object} prisma
 * @param {string} commitmentId
 * @returns {Promise<{ pathToPickup: object[], pathToDrop: object[] }|null>}
 */
async function offeredRouteFor(prisma, commitmentId) {
  const id = toStringOrNull(commitmentId);
  if (!id) return null;

  const row = await prisma.outbox.findFirst({
    where: { commitmentId: id, command: "OFFER" },
    orderBy: { createdAt: "desc" },
    select: { payload: true },
  });

  const stops = row && row.payload && Array.isArray(row.payload.stopSequence) ? row.payload.stopSequence : [];
  const pathToPickup = Array.isArray(stops[0] && stops[0].path) ? stops[0].path : null;
  const pathToDrop = Array.isArray(stops[1] && stops[1].path) ? stops[1].path : null;

  if (!pathToPickup || !pathToDrop) return null;
  return { pathToPickup, pathToDrop };
}

/**
 * The `TASK_ASSIGNED` payload the existing frontend already knows how to draw.
 *
 * ── Reusing the event and its shape, deliberately ───────────────────────────
 * `AppProvider`'s `onTaskAssigned` caches `{ taskId, robotId, pickup, drop, pathToPickup,
 * pathToDrop }` and `useRobotStream` draws from that cache. Both were written against this
 * shape and both still subscribe to it; what disappeared at the cutover was the producer,
 * not the contract. So this restores the producer at the point the route becomes known and
 * changes neither the event name nor a field of it.
 *
 * It is emitted only when both paths exist, because the consumer's own guard
 * (`if (!pathToPickup || !pathToDrop) return;`) discards anything else — an event that the
 * receiver drops is worse than no event, since it looks like a working handoff.
 *
 * @param {object} input `{ task, robotId, route }`
 * @returns {object|null}
 */
function taskAssignedPayload(input) {
  const settings = input || {};
  const task = settings.task;
  const route = settings.route;

  if (!task || !route) return null;

  return {
    taskId: task.taskId,
    robotId: settings.robotId || null,
    pickup: { name: task.pickup ?? null, lat: task.pickupLat ?? null, lon: task.pickupLon ?? null },
    drop: { name: task.drop ?? null, lat: task.dropLat ?? null, lon: task.dropLon ?? null },
    pathToPickup: route.pathToPickup,
    pathToDrop: route.pathToDrop,
  };
}

/**
 * The Redis keys the reroute path and the recovery path already read.
 *
 * `taskPath:<taskId>` is the cached route and `robotTaskState:<robotId>` is the phase and
 * index the reroute path resets. `task.service.rerouteTask` reads both today and
 * `tasks.controller.cancelTask` deletes both, so writing them here is completing an
 * existing contract rather than introducing a cache.
 *
 * **This is not `seedTaskKeys`.** That function made Redis the source of truth for an
 * assignment — it was written *before* the decision and read as if it were one. These are
 * written after the authoritative commitment exists, they are read only by the reroute and
 * map paths, and no assignment decision consults them. The distinction is the one Phase 15
 * drew, and the retirement gate holds it: nothing here selects a robot.
 *
 * Best effort by construction. A KV failure loses a redraw, never an assignment.
 *
 * @param {object|null} kv
 * @param {{ taskId: string, robotId: string, route: object }} input
 * @returns {Promise<boolean>} whether both keys were written
 */
async function writeRouteCache(kv, input) {
  const settings = input || {};
  if (!kv || !settings.taskId || !settings.route) return false;

  // @structural one day, matching the TTL `rerouteTask` already writes these keys with
  const TTL_SECONDS = 86400;

  try {
    await Promise.all([
      kv.set(
        `taskPath:${settings.taskId}`,
        JSON.stringify({ toPickup: settings.route.pathToPickup, toDrop: settings.route.pathToDrop }),
        { ex: TTL_SECONDS },
      ),
      settings.robotId
        ? kv.set(
            `robotTaskState:${settings.robotId}`,
            JSON.stringify({ taskId: settings.taskId, phase: "TO_PICKUP", segment: "toPickup", pathIndex: 0 }),
            { ex: TTL_SECONDS },
          )
        : Promise.resolve(),
    ]);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  PROJECTABLE_FROM,
  PROJECTED_STATUS,
  taskForLeg,
  projectAcceptedAssignment,
  offeredRouteFor,
  taskAssignedPayload,
  writeRouteCache,
};
