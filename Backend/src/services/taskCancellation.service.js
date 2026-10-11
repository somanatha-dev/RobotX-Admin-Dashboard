/**
 * Cancelling an engine-managed task whose Legs are all still `QUEUED` — §4.6's one case with
 * nothing to wait for: custody NONE, no HARD commitment, *"`CANCELLED` immediately"*.
 *
 * `POST /api/tasks/:taskId/cancel` used to refuse every engine-managed task (P1.4): writing
 * `Task.status` is not a cancellation the engine sees — measured live, "cancelled" tasks were
 * still committed, delivered and settled. This is the engine-owned path for the narrow case
 * where it is safe, and it refuses — writing nothing — for every other case, which is the
 * previous behaviour.
 *
 * One transaction, every write conditional:
 *   1. re-read the Task and the Legs of its Missions; refuse unless every open Leg is QUEUED;
 *   2. per Leg, count unreleased commitments inside the transaction, then
 *      `cancellation.cancelQueuedLeg` — §4.6 step 1's flag, then the §4.6-sourced
 *      `QUEUED → CANCELLED` row, both CAS on the Leg's version, timers cancelled on exit;
 *   3. withdraw the Leg's `WorkQueue` row (QUEUED or CLAIMED → WITHDRAWN, version incremented,
 *      so an in-flight round's settle — conditional on the version it claimed — matches
 *      nothing and the round never sees the Leg again);
 *   4. project the Task to CANCELLED, conditional on the status and version read in step 1;
 *   5. append the `CANCELLATION` event to the audit stream (§4.6 step 5, §23.6).
 * Any refusal or lost race throws, so the transaction rolls back: a task is cancelled in full
 * or not at all.
 *
 * P7-D4 Part 3 — the operator's exit from an exhausted reassignment chain uses this same
 * transaction. An open Leg in `REASSIGNING` goes to `cancellation.cancelExhaustedReassigningLeg`
 * (§4.6 step 3's first case for a Leg §4.7 froze "for operator decision"; every precondition
 * proven inside the transaction, each refusal named), and such a Task may still name the robot
 * the chain was withdrawn from — so it is the one case where `Task.robotId` is not refused: the
 * Task is projected to CANCELLED conditional on that robot too, and the robot is unbound only
 * while it still points at this Task. Every other Leg state is refused exactly as before.
 */

const cancellation = require("../engine/lifecycle/cancellation");
const legMachine = require("../engine/lifecycle/legMachine");
const auditStream = require("../engine/observability/auditStream");

/** §4.2's terminal Task states (tasks.controller.js uses the same set). */
const TERMINAL_TASK_STATUSES = Object.freeze(["COMPLETED", "FAILED", "CANCELLED", "REJECTED"]);

/** `WorkQueue` states (intake.QUEUE_STATE; the `WorkQueue_state_known` CHECK). */
const QUEUE = Object.freeze({ QUEUED: "QUEUED", CLAIMED: "CLAIMED", WITHDRAWN: "WITHDRAWN" });

class CancellationRefused extends Error {
  /**
   * @param {number} status HTTP status the controller answers with
   * @param {string} code
   * @param {string} message
   */
  constructor(status, code, message) {
    super(message);
    this.name = "CancellationRefused";
    this.status = status;
    this.code = code;
  }
}

/**
 * @param {object} prisma a client with `$transaction`
 * @param {object} input
 * @param {string} input.taskRowId `Task.id`
 * @param {string} input.taskId `Task.taskId` (for messages and the audit subject)
 * @param {string[]} input.missionIds the Task's Missions, read by the caller
 * @param {{ id: string|null, role: string|null }} input.actor
 * @param {boolean} input.authorised §4.6 step 5's scope check
 * @param {Date} input.storeTime
 * @param {string} [input.reason]
 * @param {number|null} [input.maxReassignmentsPerLeg] `recover.max_reassignments_per_leg`, for a REASSIGNING Leg
 * @param {(tx: object, event: object) => Promise<{ ok: boolean }>} [input.audit] defaults to the hash-chained stream
 * @returns {Promise<{ outcome: "CANCELLED"|"ALREADY_TERMINAL", task: object, legs?: object[], queueRowsWithdrawn?: number,
 *   operatorExit?: string, releasedRobotId?: string|null, robotUnbound?: boolean }>}
 */
async function cancelQueuedTask(prisma, input) {
  const source = input || {};
  const audit = typeof source.audit === "function" ? source.audit : (tx, event) => auditStream.append({ prisma: tx }, event);
  const storeTime = source.storeTime;
  const robotRefusal = () =>
    new CancellationRefused(409, "ENGINE_CANCELLATION_UNAVAILABLE", `Task ${source.taskId} has a robot; only a queued task can be cancelled`);

  return prisma.$transaction(async (tx) => {
    // Two cancellations of one Task serialise here, so a concurrent duplicate reads the Task the
    // first one committed (terminal) instead of racing it to the conditional writes below. The
    // version CAS on every write remains the guard against every other writer.
    await tx.$queryRawUnsafe('SELECT "id" FROM "Task" WHERE "id" = $1 FOR UPDATE', source.taskRowId);
    const task = await tx.task.findUnique({ where: { id: source.taskRowId } });
    if (!task) throw new CancellationRefused(404, "UNKNOWN_TASK", `Task ${source.taskId} does not exist`);
    if (TERMINAL_TASK_STATUSES.includes(task.status)) return { outcome: "ALREADY_TERMINAL", task };

    const legs = await tx.leg.findMany({ where: { missionId: { in: source.missionIds || [] } } });
    const open = legs.filter((leg) => !legMachine.isTerminal(leg.state));
    if (open.length === 0) {
      if (task.robotId) throw robotRefusal();
      throw new CancellationRefused(409, "ENGINE_CANCELLATION_UNAVAILABLE", `Task ${source.taskId} has no open engine Leg to cancel`);
    }
    const unresolvable = open.find((leg) => leg.state !== legMachine.LEG_STATE.QUEUED && leg.state !== legMachine.LEG_STATE.REASSIGNING);
    if (unresolvable) {
      if (task.robotId) throw robotRefusal();
      throw new CancellationRefused(
        409,
        "ENGINE_CANCELLATION_UNAVAILABLE",
        `Task ${source.taskId} is managed by the assignment engine (Leg ${unresolvable.state}); only a task whose Legs are all QUEUED can be cancelled, and nothing was changed.`,
      );
    }
    // P7-D4 Part 3 — a REASSIGNING Leg is the operator's exit; a robot-bound Task is accepted only
    // when every open Leg is one (a QUEUED Leg with a robot is the same refusal as before).
    const operatorExit = open.some((leg) => leg.state === legMachine.LEG_STATE.REASSIGNING);
    if (task.robotId && !open.every((leg) => leg.state === legMachine.LEG_STATE.REASSIGNING)) throw robotRefusal();

    const cancelledLegs = [];
    for (const leg of open) {
      let result;
      if (leg.state === legMachine.LEG_STATE.QUEUED) {
        // eslint-disable-next-line no-await-in-loop
        const live = await tx.commitment.count({ where: { legId: leg.id, releasedAt: null } });
        // eslint-disable-next-line no-await-in-loop
        result = await cancellation.cancelQueuedLeg(tx, {
          leg,
          storeTime,
          authorised: source.authorised === true,
          noHardCommitment: live === 0,
          reason: source.reason || "OPERATOR_CANCELLATION",
        });
      } else {
        // eslint-disable-next-line no-await-in-loop
        result = await cancellation.cancelExhaustedReassigningLeg(tx, {
          leg,
          storeTime,
          authorised: source.authorised === true,
          maxReassignmentsPerLeg: source.maxReassignmentsPerLeg,
          reason: source.reason || "OPERATOR_CANCELLATION",
        });
      }
      if (result.outcome === cancellation.OUTCOME.LOST_RACE) {
        throw new CancellationRefused(409, "LEG_MOVED", `Task ${source.taskId}'s Leg changed while cancelling; nothing was changed`);
      }
      if (result.outcome !== cancellation.OUTCOME.RESOLVED) {
        const status = result.reason === "NOT_AUTHORISED" ? 403 : result.reason === "CHAIN_BOUND_UNRESOLVED" ? 503 : 409;
        const why = leg.state === legMachine.LEG_STATE.REASSIGNING && result.detail ? `${result.reason}: ${result.detail}` : result.reason;
        throw new CancellationRefused(status, result.reason || "CANCELLATION_REFUSED", `Task ${source.taskId} was not cancelled (${why}); nothing was changed`);
      }
      cancelledLegs.push({
        legId: leg.legId,
        from: result.from,
        to: result.to,
        timersCancelled: result.timersCancelled,
        ...(result.exit ? { exit: result.exit, chainLength: result.chainLength } : {}),
      });
    }

    const openIds = open.map((leg) => leg.id);
    const withdrawn = await tx.workQueue.updateMany({
      where: { legId: { in: openIds }, state: { in: [QUEUE.QUEUED, QUEUE.CLAIMED] } },
      data: { state: QUEUE.WITHDRAWN, settledAt: storeTime, claimedByRoundId: null, claimedAt: null, version: { increment: 1 } },
    });

    // Conditional on the robot as well: the assignment read model re-projects a Task between
    // robots without touching `version` (`assignmentProjection.projectAcceptedAssignment`), so
    // status and version alone would not see a newer grant's projection land.
    const projected = await tx.task.updateMany({
      where: { id: task.id, status: task.status, version: task.version, robotId: task.robotId ?? null },
      data: { status: "CANCELLED", version: task.version + 1 },
    });
    if (projected.count !== 1) {
      throw new CancellationRefused(409, "TASK_MOVED", `Task ${source.taskId} changed while cancelling; nothing was changed`);
    }

    // The unit the exhausted chain was withdrawn from stops carrying this Task — only while it
    // still points at this Task, so a robot already rebound elsewhere is left alone.
    let releasedRobotId = null;
    let robotUnbound = false;
    if (operatorExit && task.robotId) {
      const robot = await tx.robot.findUnique({ where: { id: task.robotId }, select: { id: true, robotId: true } });
      releasedRobotId = robot ? robot.robotId : null;
      const unbound = await tx.robot.updateMany({ where: { id: task.robotId, currentTaskId: task.id }, data: { currentTaskId: null } });
      robotUnbound = unbound.count === 1;
    }

    const appended = await audit(tx, {
      eventType: auditStream.EVENT_TYPE.CANCELLATION,
      actorId: source.actor?.id ?? null,
      actorRole: source.actor?.role ?? null,
      subjectType: "TASK",
      subjectId: source.taskId,
      reason: source.reason || "OPERATOR_CANCELLATION",
      payload: {
        resolution: cancellation.RESOLUTION.CANCELLED_IMMEDIATELY,
        taskStatusFrom: task.status,
        legs: cancelledLegs.map(({ legId, from, to }) => ({ legId, from, to })),
        queueRowsWithdrawn: withdrawn.count,
        ...(operatorExit
          ? {
              operatorExit: "EXHAUSTED_REASSIGNMENT",
              chainLengths: cancelledLegs.filter((leg) => leg.exit).map(({ legId, chainLength }) => ({ legId, chainLength })),
              taskRobotRowId: task.robotId ?? null,
              robotUnbound,
            }
          : {}),
      },
      recordedAtMs: storeTime.getTime(),
    });
    if (!appended || appended.ok !== true) {
      // A cancellation whose audit event was not written is not committed (§23.6).
      throw new CancellationRefused(503, "AUDIT_NOT_RECORDED", "the cancellation could not be audited; nothing was changed — retry");
    }

    return {
      outcome: "CANCELLED",
      task: { ...task, status: "CANCELLED", version: task.version + 1 },
      legs: cancelledLegs,
      queueRowsWithdrawn: withdrawn.count,
      ...(operatorExit ? { operatorExit: "EXHAUSTED_REASSIGNMENT", releasedRobotId, robotUnbound } : {}),
    };
  });
}

module.exports = { cancelQueuedTask, CancellationRefused, TERMINAL_TASK_STATUSES };
