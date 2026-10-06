"use strict";

/**
 * **Task completion follows settlement** (§4.9) — the legacy read model's completion, in one
 * place, reached only once the engine's Leg is settled.
 *
 * ── The defect this closes (C5, measured by Gate 1b, 2026-10-04) ───────────
 * `TASK_COMPLETE` used to write `Task.status = COMPLETED`, put the robot back to IDLE and emit
 * the dashboard's `TASK_UPDATED COMPLETED` whatever settlement answered. Sent while custody was
 * still HELD at the drop, settlement refused (`CUSTODY_STILL_HELD`) and the Task was reported
 * delivered while the goods were aboard, the Leg at AT_DROP and the commitment live. Had the
 * RELEASED report never come, it would have stayed that way.
 *
 * Settlement is the decision; this module is its projection onto the columns and events the
 * existing UI reads. It is called from the two places a Leg is settled on a verified
 * completion — `TASK_COMPLETE` (custody already released) and the custody-release path
 * (`legProgress.settleIfVerified`, completion verified first) — so the two orders converge on
 * the same completion, and it runs exactly once:
 *
 *   · `recordInTx` runs **inside the settling transaction**, so a Leg is never settled with its
 *     Task left open, or the reverse.
 *   · The Task write is conditional on the Task still being open, and the robot is released
 *     only by the caller whose settlement moved the Leg or whose write closed the Task. A
 *     duplicate or late caller (ALREADY_SETTLED, a Task already COMPLETED) changes nothing and
 *     publishes nothing.
 */

const robotStateCache = require("../cache/robotStateCache");
const { updateAssignedTask } = require("./robotRegistry.service");
const settlement = require("../engine/lifecycle/settlement");

/** The settlement outcomes after which the Task is complete. @structural */
const SETTLED_OUTCOMES = Object.freeze([settlement.OUTCOME.SETTLED, settlement.OUTCOME.ALREADY_SETTLED]);

/**
 * The statuses a completion may put back to IDLE: those already at IDLE's health tier
 * (`agentFacts.HEALTH_TIER_BY_STATUS`: IDLE and ACTIVE are NOMINAL). ERROR and OFFLINE
 * (QUARANTINED), PAUSED and ISSUES (MARGINAL) are below it, and writing IDLE over them on the
 * agent's own completion would expand its eligibility — §23.5's asymmetric health rule. A fault
 * is cleared by the operator's `clear-fault`; a status outside this list is left alone.
 * @structural
 */
const RELEASABLE_STATUSES = Object.freeze(["IDLE", "ACTIVE"]);

/**
 * Why a completion claim is not bound to the Leg it would settle (F2). @structural
 */
const BINDING_REFUSAL = Object.freeze({
  /** The Leg's Mission discharges no Task, or several (§2.8): there is no one Task to complete. */
  NO_SINGLE_TASK_FOR_LEG: "NO_SINGLE_TASK_FOR_LEG",
  /** The claim names no Task. The protocol's `TASK_COMPLETE` carries `taskId`. */
  TASK_NOT_NAMED: "TASK_NOT_NAMED",
  /** The claim names a Task other than the Leg's own, or an identifier that is no Task. */
  TASK_CLAIM_MISMATCH: "TASK_CLAIM_MISMATCH",
});

/**
 * F2 — the Task a completion completes is the one the settled Leg belongs to, never the one
 * the agent names.
 *
 * The Leg comes from the agent's live commitment; its Task comes from §2.8's
 * `Task >──< Mission >──< Leg`, and ambiguity is refused rather than resolved — the rule
 * `assignmentProjection.taskForLeg` applies. That function is not imported: the projection's
 * importers are a closed list (`assignmentProjectionIsolation.test.js`), so the same one read is
 * made here. The agent's `taskId` is only a consistency claim: it must name that Task. Both
 * settling paths ask this **before** settling, so a claim for another Task neither completes it
 * nor releases this Leg's commitment with its own Task left open.
 *
 * @param {object} client a Prisma client or transaction client
 * @param {{ legId: string, claimedTaskId: string|null|undefined }} input `legId` is the `Leg.id`
 *   the commitment names; `claimedTaskId` is the Task business key the claim resolved to
 * @returns {Promise<{ ok: boolean, reason: string|null, task: object|null }>} `task` is the
 *   Leg's own Task whenever there is exactly one, even when the claim is refused
 */
async function bindClaim(client, input) {
  const { legId, claimedTaskId } = input || {};
  const leg = legId
    ? await client.leg.findUnique({ where: { id: legId }, select: { mission: { select: { tasks: { select: { taskId: true } } } } } })
    : null;
  const tasks = (leg && leg.mission && leg.mission.tasks) || [];
  const task = tasks.length === 1 ? tasks[0] : null;
  if (!task) return { ok: false, reason: BINDING_REFUSAL.NO_SINGLE_TASK_FOR_LEG, task: null };
  if (claimedTaskId === undefined || claimedTaskId === null || claimedTaskId === "") {
    return { ok: false, reason: BINDING_REFUSAL.TASK_NOT_NAMED, task };
  }
  if (claimedTaskId !== task.taskId) return { ok: false, reason: BINDING_REFUSAL.TASK_CLAIM_MISMATCH, task };
  return { ok: true, reason: null, task };
}

/**
 * @param {{ outcome: string }|null} settled a `settlement.settle` result
 * @returns {boolean}
 */
function isSettled(settled) {
  return Boolean(settled && SETTLED_OUTCOMES.includes(settled.outcome));
}

/**
 * Write the completion inside the transaction that settled the Leg.
 *
 * @param {object} tx
 * @param {{ robotId: string, taskId: string|null, settledNow: boolean }} input `settledNow` is
 *   true only when this transaction's own settlement moved the Leg to SETTLED
 * @returns {Promise<{ robotId: string, taskId: string|null, taskCompleted: boolean, finalized: boolean, statusReleased: boolean }>}
 */
async function recordInTx(tx, input) {
  const { robotId, taskId, settledNow } = input;
  let taskCompleted = false;
  if (taskId) {
    const written = await tx.task.updateMany({
      where: { taskId, robot: { robotId }, status: { in: ["ASSIGNED", "IN_PROGRESS"] } },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
    taskCompleted = Boolean(written && written.count === 1);
  }
  const finalized = taskCompleted || settledNow === true;
  let statusReleased = false;
  if (finalized) {
    await tx.robot.update({ where: { robotId }, data: { currentTaskId: null, speed: 0 } });
    // F1 — conditional in the database, not read-then-write: the filter is evaluated against
    // the row as it is when the UPDATE runs, so a fault committed by another writer after this
    // transaction began is seen and kept rather than overwritten.
    const released = await tx.robot.updateMany({
      where: { robotId, status: { in: RELEASABLE_STATUSES } },
      data: { status: "IDLE" },
    });
    statusReleased = Boolean(released && released.count === 1);
  }
  return { robotId, taskId: taskId || null, taskCompleted, finalized, statusReleased };
}

/**
 * After the transaction commits: the live caches and the dashboard's `TASK_UPDATED COMPLETED`,
 * only for the caller that finalized.
 *
 * @param {{ io?: object, kv?: object, completion: object|null }} input
 * @returns {Promise<boolean>} whether anything was published
 */
async function publish(input) {
  const { io, kv, completion } = input || {};
  if (!completion || !completion.finalized) return false;
  const { robotId, taskId } = completion;

  // F1 — invalidate rather than write IDLE. Telemetry reads this cache as the robot's current
  // status for §23.5's check, so an IDLE written here over a status the database kept (or one a
  // fault wrote between commit and now) would let the agent's next report clear its own fault.
  // A miss re-reads the database, which is the authority.
  robotStateCache.del(robotId);
  if (kv && taskId) {
    await Promise.allSettled([kv.del(`robotTaskState:${robotId}`), kv.del(`robotTask:${robotId}`)]);
  }
  await updateAssignedTask(kv, robotId, null);
  if (io) {
    io.to("dashboard").emit("TASK_UPDATED", { robotId, taskId, status: "COMPLETED", timestamp: Date.now() });
  }
  return true;
}

module.exports = { SETTLED_OUTCOMES, RELEASABLE_STATUSES, BINDING_REFUSAL, bindClaim, isSettled, recordInTx, publish };
