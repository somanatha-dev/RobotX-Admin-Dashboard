"use strict";

/**
 * Robot soft retirement — `DELETE /api/robots/:robotId`.
 *
 * ── What it replaced ────────────────────────────────────────────────────────
 * The endpoint hard-deleted the `Robot` row. The delete cascaded to the robot's `Agent`,
 * and `Commitment.agentId` / `Outbox.agentId` are `ON DELETE RESTRICT`, so every robot the
 * engine had ever offered work failed with a RESTRICT violation (SQLSTATE 23001, which Prisma
 * surfaces as an unknown request error with no code) and an unhandled 500. Where the delete did
 * succeed it took the robot's telemetry, commands, observations, battery and charging rows
 * with it and detached its tasks and events. Nothing here deletes a `Robot` or `Agent` row.
 *
 * ── The transition ──────────────────────────────────────────────────────────
 * One transaction, holding the Agent row `FOR UPDATE`:
 *
 *   1. Refuse (409) while the robot has engine work in flight — a live commitment, an
 *      outstanding outbox command, a non-terminal task, or a queued/active charging
 *      reservation. Nothing is cancelled, released, settled or interrupted on the
 *      operator's behalf: each of those has its own path, and retirement fails closed.
 *   2. Otherwise move `Agent.lifecycleState` to `DECOMMISSIONED`, advance
 *      `authorityEpoch` by exactly one (recorded in `AgentFenceAudit`), drop the agent's
 *      `AgentCellPosition` (the availability index's durable mirror), revoke its durable
 *      session, clear the online/socket columns, and write the retirement Event.
 *
 * ── Why the epoch advance, and why the lock ─────────────────────────────────
 * F2 is not in the commit-time volatile subset, so a round whose snapshot predates the
 * retirement could otherwise still commit an offer to the robot. `commit.js` locks the
 * same Agent row `FOR UPDATE` and its guard G3 refuses a snapshot whose `authority_epoch`
 * is no longer the agent's — so whichever transaction takes the lock second loses safely:
 * a commit after a retirement aborts at G3, and a retirement after a commit sees the live
 * commitment and refuses. Every other outbox writer (WITHDRAW, RECALL, MIGRATE) also writes
 * the Agent row in its own transaction, so none of them can slip a row past step 1 either.
 * No assignment-engine code changed: this is the engine's existing fence, used as designed.
 *
 * ── Repeated retirement ─────────────────────────────────────────────────────
 * Succeeds with `alreadyRetired: true`, writes no Event and does not advance the epoch. It
 * does re-remove a cell-position row and any durable session, because a sweep or an AUTH
 * that was in flight at the first retirement can leave one behind, and both are derived
 * state that a retired robot must not have.
 *
 * The in-process and Redis cleanup (`releaseRuntimeState`) runs after the commit, because
 * none of it can be rolled back. Each step is attempted on its own and reported.
 */

const clock = require("../engine/commitment/clock");
const outbox = require("../engine/dispatch/outbox");
const availabilityIndex = require("../engine/candidates/availabilityIndex");
const { TERMINAL_TASK_STATUSES } = require("./taskCancellation.service");
const robotService = require("./robot.service");
const robotStateCache = require("../cache/robotStateCache");
const positionObservation = require("./positionObservation.service");
const robotSockets = require("../sockets/robotSockets");
const { toStringOrNull } = require("../utils/parse");
const policy = require("./robotRetirementPolicy");

/** @structural outcome names */
const OUTCOME = Object.freeze({ RETIRED: "RETIRED", ALREADY_RETIRED: "ALREADY_RETIRED" });

/** @structural refusal codes, on the wire */
const REFUSAL = Object.freeze({
  ROBOT_NOT_FOUND: "ROBOT_NOT_FOUND",
  LIVE_COMMITMENT: "LIVE_COMMITMENT",
  OUTSTANDING_COMMANDS: "OUTSTANDING_COMMANDS",
  ACTIVE_TASK: "ACTIVE_TASK",
  CHARGING_RESERVATION: "CHARGING_RESERVATION",
});

/**
 * The `ChargerReservation.state` values that hold or wait for a plug. The column is a string
 * whose values the dev charging scheduler defines (its `LIVE_STATES`). Stated here rather
 * than imported, because the scheduler's own tests hold that nothing outside its driver
 * imports it (T11); `robotRetirement.test.js` pins this list equal to the scheduler's.
 * @structural
 */
const LIVE_RESERVATION_STATES = Object.freeze(["QUEUED", "ACTIVE"]);

/** `AgentFenceAudit.lastFenceSource` for the retirement epoch advance. @structural */
const FENCE_SOURCE = "decommission";

/**
 * The transaction bound. Same order as commissioning's: a handful of indexed reads and
 * writes, plus the wait for the Agent lock when a commit holds it.
 * @structural
 */
const TRANSACTION_TIMEOUT_MS = 15000;
const TRANSACTION_MAX_WAIT_MS = 10000;

/** Bounds what an operator-entered reason may add to the Event row. @structural */
const MAX_REASON_LENGTH = 500;

/** At most this many ids are named in a refusal. @structural */
const MAX_IDS_REPORTED = 10;

/** A refusal with an HTTP status and a machine-readable code. */
class RetirementRefused extends Error {
  constructor(status, code, message, ids) {
    super(message);
    this.name = "RetirementRefused";
    this.status = status;
    this.code = code;
    this.ids = Array.isArray(ids) ? ids.slice(0, MAX_IDS_REPORTED) : [];
  }

  /** The response body. `message` is the sentence the dashboard shows. */
  toBody() {
    return {
      ok: false,
      error: this.status === 404 ? "Not Found" : "Conflict",
      code: this.code,
      refusal: this.code,
      message: this.message,
      ...(this.ids.length > 0 ? { ids: this.ids } : {}),
    };
  }
}

function refuse(code, message, ids) {
  return new RetirementRefused(409, code, message, ids);
}

/**
 * `SELECT … FOR UPDATE` on the Agent row — the statement `db/prisma.selectForUpdate` issues
 * for `commit.js`, written out here so the two lock the same row the same way. Issued on the
 * transaction client directly, so this file does not depend on the database module's
 * runtime (which unit tests replace wholesale).
 * @returns {Promise<object|null>}
 */
async function lockAgentRow(tx, agentRowId) {
  const rows = await tx.$queryRawUnsafe('SELECT * FROM "Agent" WHERE "id" = $1 FOR UPDATE', agentRowId);
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

/**
 * The `availabilityIndex` record a cell-position row was indexed under — the shape
 * `indexMaintainer.sweepAgents` builds for the same purpose.
 * @param {object|null} row
 * @returns {object|null}
 */
function indexRecordOf(row) {
  if (!row) return null;
  return {
    agentId: row.agentId,
    shardId: row.shardId,
    fineCellId: row.fineCellId,
    coarseCellId: row.coarseCellId,
    availabilityClass: row.availabilityClass,
    capabilityClasses: row.capabilityClasses,
    containerClasses: row.containerClasses,
  };
}

/**
 * Step 1 — everything that makes retirement unsafe. Read after the Agent lock is held, so
 * a commitment or outbox row written by a transaction that held the lock first is seen.
 */
async function assertSafeToRetire(tx, robot, agentRowId) {
  const liveCommitments = await tx.commitment.findMany({
    where: { agentId: agentRowId, releasedAt: null },
    select: { commitmentId: true },
  });
  if (liveCommitments.length > 0) {
    throw refuse(
      REFUSAL.LIVE_COMMITMENT,
      `Unit ${robot.robotId} holds ${liveCommitments.length} live commitment(s). Cancel or complete its work ` +
        "before retiring it; retirement does not release commitments.",
      liveCommitments.map((row) => row.commitmentId),
    );
  }

  const outstanding = await tx.outbox.findMany({
    where: { agentId: agentRowId, state: { in: [...outbox.OUTSTANDING_STATES] } },
    select: { id: true, command: true, state: true },
  });
  if (outstanding.length > 0) {
    throw refuse(
      REFUSAL.OUTSTANDING_COMMANDS,
      `Unit ${robot.robotId} has ${outstanding.length} command(s) not yet acknowledged or settled ` +
        `(${[...new Set(outstanding.map((row) => `${row.command} ${row.state}`))].join(", ")}). ` +
        "Retire it once they are acknowledged or expire.",
      outstanding.map((row) => row.id),
    );
  }

  const taskScope = [{ robotId: robot.id }];
  if (robot.currentTaskId) taskScope.push({ id: robot.currentTaskId });
  const activeTasks = await tx.task.findMany({
    where: { OR: taskScope, status: { notIn: [...TERMINAL_TASK_STATUSES] } },
    select: { taskId: true, status: true },
  });
  if (activeTasks.length > 0) {
    throw refuse(
      REFUSAL.ACTIVE_TASK,
      `Unit ${robot.robotId} has ${activeTasks.length} task(s) that are not finished ` +
        `(${activeTasks.map((row) => `${row.taskId} ${row.status}`).slice(0, MAX_IDS_REPORTED).join(", ")}). ` +
        "Cancel or complete them before retiring it.",
      activeTasks.map((row) => row.taskId),
    );
  }

  const reservations = await tx.chargerReservation.findMany({
    where: { agentId: agentRowId, state: { in: [...LIVE_RESERVATION_STATES] } },
    select: { reservationId: true, state: true },
  });
  if (reservations.length > 0) {
    throw refuse(
      REFUSAL.CHARGING_RESERVATION,
      `Unit ${robot.robotId} has a ${reservations.map((row) => row.state).join("/")} charging reservation. ` +
        "Retire it after the charge ends; retirement does not interrupt charging.",
      reservations.map((row) => row.reservationId),
    );
  }
}

/**
 * Remove what a retired agent must not keep: its index mirror row and its durable session.
 * @returns {Promise<object|null>} the removed cell-position row, for the Redis removal
 */
async function removeDerivedState(tx, robotDbId, agentRowId) {
  const cell = await tx.agentCellPosition.findUnique({ where: { agentId: agentRowId } });
  if (cell) await tx.agentCellPosition.deleteMany({ where: { agentId: agentRowId } });
  await tx.robotSession.deleteMany({ where: { robotDbId } });
  return cell || null;
}

/**
 * Retire one robot. The transaction only; `releaseRuntimeState` is the caller's next step.
 *
 * @param {object} prisma
 * @param {string} robotCode the business id (`Robot.robotId`)
 * @param {object} [options]
 * @param {string|null} [options.actorId] the authenticated operator
 * @param {string|null} [options.reason] optional, recorded on the Event row
 * @param {{ afterLock?: Function }} [options.hooks] test seam: runs while the Agent lock is
 *   held, so a test can interleave a second transaction at exactly that point
 * @returns {Promise<object>} `{ outcome, robotId, robotDbId, agentRowId, agentId, cell,
 *   socketId, epochBefore, epochAfter, agentCreated }`
 * @throws {RetirementRefused} 404 unknown robot, 409 unsafe to retire
 */
async function retireRobot(prisma, robotCode, options) {
  const settings = options || {};
  const code = toStringOrNull(robotCode);
  if (!code) {
    const err = new Error("robotId is required");
    err.status = 400;
    throw err;
  }
  const actorId = toStringOrNull(settings.actorId);
  const reasonRaw = toStringOrNull(settings.reason);
  const reason = reasonRaw ? reasonRaw.slice(0, MAX_REASON_LENGTH) : null;
  const hooks = settings.hooks || {};

  return prisma.$transaction(
    async (tx) => {
      const robot = await tx.robot.findUnique({
        where: { robotId: code },
        select: { id: true, robotId: true, currentTaskId: true, socketId: true },
      });
      if (!robot) {
        throw new RetirementRefused(404, REFUSAL.ROBOT_NOT_FOUND, "Unknown robotId");
      }

      // A robot commissioned before the Agent projection existed may have no Agent. Retirement
      // creates it (the same upsert commissioning uses) so that the robot's retirement has
      // somewhere to live; it is rolled back with everything else if retirement is refused.
      let agentRow = await tx.agent.findUnique({ where: { robotDbId: robot.id }, select: { id: true } });
      let agentCreated = false;
      if (!agentRow) {
        agentRow = await robotService.ensureAgentForRobot(tx, robot);
        agentCreated = true;
        if (!agentRow) throw new Error(`no Agent could be established for robot ${code}`);
      }

      const agent = await lockAgentRow(tx, agentRow.id);
      if (!agent) throw new Error(`the Agent row for robot ${code} vanished under its lock`);
      if (typeof hooks.afterLock === "function") await hooks.afterLock();

      const base = {
        robotId: robot.robotId,
        robotDbId: robot.id,
        agentRowId: agent.id,
        agentId: agent.agentId,
        socketId: robot.socketId || null,
        agentCreated,
      };

      if (agent.lifecycleState === policy.RETIRED_LIFECYCLE_STATE) {
        const cell = await removeDerivedState(tx, robot.id, agent.id);
        const epoch = BigInt(agent.authorityEpoch);
        return { ...base, outcome: OUTCOME.ALREADY_RETIRED, cell, epochBefore: epoch, epochAfter: epoch };
      }

      await assertSafeToRetire(tx, robot, agent.id);

      const storeTime = await clock.readStoreTime(tx);
      const epochBefore = BigInt(agent.authorityEpoch);
      const epochAfter = epochBefore + BigInt(1);
      const previousState = agent.lifecycleState;

      await tx.agent.update({
        where: { id: agent.id },
        data: { lifecycleState: policy.RETIRED_LIFECYCLE_STATE, authorityEpoch: epochAfter },
      });
      // The same record the dedup handshake keeps for its epoch advance (§11.5).
      await tx.agentFenceAudit.upsert({
        where: { agentId: agent.id },
        create: {
          agentId: agent.id,
          fenceHighWater: BigInt(agent.fenceCounter),
          epochHighWater: epochAfter,
          lastFenceSource: FENCE_SOURCE,
          observedAt: storeTime,
        },
        update: {
          fenceHighWater: BigInt(agent.fenceCounter),
          epochHighWater: epochAfter,
          lastFenceSource: FENCE_SOURCE,
          observedAt: storeTime,
        },
      });

      const cell = await removeDerivedState(tx, robot.id, agent.id);
      await tx.robot.update({ where: { id: robot.id }, data: { isOnline: false, socketId: null } });

      await tx.event.create({
        data: {
          robotId: robot.id,
          type: "INFO",
          message:
            `Unit ${robot.robotId} retired (lifecycle ${previousState} -> ${policy.RETIRED_LIFECYCLE_STATE}, ` +
            `authority epoch ${epochBefore} -> ${epochAfter})` +
            (actorId ? ` by ${actorId}` : "") +
            (reason ? `: ${reason}` : ""),
        },
      });

      return { ...base, outcome: OUTCOME.RETIRED, cell, epochBefore, epochAfter };
    },
    { timeout: TRANSACTION_TIMEOUT_MS, maxWait: TRANSACTION_MAX_WAIT_MS },
  );
}

/**
 * After the commit: everything in this process and in the KV that still treats the robot
 * as live. None of it can be rolled back, which is why it is not in the transaction, and
 * none of it decides anything — the retirement is already durable. Each step runs on its
 * own; a failure is logged and returned, never thrown.
 *
 * @param {object} result `retireRobot`'s return value
 * @param {{ kv?: object, io?: object, virtualSimulator?: object, logger?: object }} deps
 * @returns {Promise<{ failed: Array<{ step: string, message: string }> }>}
 */
async function releaseRuntimeState(result, deps) {
  const settings = deps || {};
  const log = settings.logger || console;
  const robotId = result.robotId;
  const failed = [];

  async function step(name, fn) {
    try {
      await fn();
    } catch (error) {
      failed.push({ step: name, message: error?.message || String(error) });
    }
  }

  await step("stateCache", () => robotStateCache.del(robotId));
  await step("positionObservation", () => positionObservation.forget(robotId));

  // The Redis half of the availability index. The durable mirror row went in the
  // transaction; F2 would refuse the agent anyway, but a stale entry fills the rejection panel.
  if (result.cell && settings.kv) {
    await step("availabilityIndex", async () => {
      // `applyPosition` swallows a Redis error and answers `ok: false`; surfaced here.
      const removed = await availabilityIndex.removePosition({ kv: settings.kv }, indexRecordOf(result.cell));
      if (!removed || removed.ok !== true) throw new Error("the availability index did not confirm the removal");
    });
  }

  // Stop the VirtualRobot (which also releases a plug it holds) before the socket goes, so
  // a simulated unit does not reconnect in between — AUTH would refuse it, but needlessly.
  const virtualSimulator = settings.virtualSimulator;
  if (virtualSimulator && typeof virtualSimulator.removeRobot === "function") {
    await step("simulator", () => virtualSimulator.removeRobot(robotId));
  }

  await step("socket", () => robotSockets.disconnectSocket(robotSockets.getRobotSocket(robotId)));

  const kv = settings.kv;
  if (kv) {
    // Live state, the live registry and the robot's credentials. The KV `session:` key is
    // consulted before the durable row at AUTH, so leaving it would outlive the revocation.
    for (const key of [
      `robot:${robotId}`,
      `registry:${robotId}`,
      `session:${robotId}`,
      `pairing:${robotId}`,
      `pairingAttempts:${robotId}`,
      `pairingLocked:${robotId}`,
    ]) {
      // eslint-disable-next-line no-await-in-loop
      await step(`kv:${key.slice(0, key.indexOf(":"))}`, () => kv.del(key));
    }
    if (typeof kv.srem === "function") await step("kv:robots:all", () => kv.srem("robots:all", robotId));
  }

  // Every dashboard, not only the one that retired it: `robot_offline` takes it out of the
  // global STOP's online targets, `robot_retired` out of the lists.
  const io = settings.io;
  if (io) {
    await step("dashboard", () => {
      io.to("dashboard").emit("robot_offline", { robotId });
      io.to("dashboard").emit("robot_retired", { robotId, timestamp: Date.now() });
    });
  }

  if (failed.length > 0) {
    log.warn?.("Robot retired, but part of its runtime cleanup failed; the retirement itself is durable", {
      robotId,
      failed,
    });
  }
  return { failed };
}

module.exports = {
  OUTCOME,
  REFUSAL,
  LIVE_RESERVATION_STATES,
  RetirementRefused,
  retireRobot,
  releaseRuntimeState,
  indexRecordOf,
  // The predicate, re-exported so a caller needs one import.
  isRetiredRobot: policy.isRetiredRobot,
};
