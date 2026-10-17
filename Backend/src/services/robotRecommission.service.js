"use strict";

/**
 * Authorised recommissioning of a retired robot — `POST /api/robots/:robotId/recommission`.
 *
 * ── Why a retired id used to be refused outright ────────────────────────────
 * Soft retirement (`robotRetirement.service.js`) keeps the robot's `Robot` and `Agent` rows,
 * because they carry its tasks, events, commitments and telemetry. So its `robotId` stays
 * taken, and `robot.service.createRobotWithProjection` refuses to reuse it (409): a *new*
 * unit created under that id would inherit the old one's history. That refusal is still
 * right for a new unit and is unchanged. What was missing was a way to say "this is the
 * same physical robot, and it is coming back". This file is that operation.
 *
 * ── Identity: the same rows, never a second identity ─────────────────────────
 * The robot comes back as itself. Its `Robot` row and its `Agent` row (whose id is a
 * deterministic function of the robot code) are reused, so its history stays attached and
 * there is still exactly one record for that code. Nothing is created, copied or deleted.
 * `Robot.robotId` is unique and `Agent.robotDbId` is unique, so the schema itself rules out
 * a second active identity; this service never tries to make one.
 *
 * ── Lifecycle: DECOMMISSIONED → COMMISSIONED, not ACTIVE ─────────────────────
 * §2.1 already has the state this needs. `COMMISSIONED` means "registered and configured,
 * not yet released into service" and is not lifecycle-eligible, so F2, the availability
 * index, the index maintainer and the reconciler all keep ignoring the unit. The only
 * thing that moves a unit from `COMMISSIONED` to `ACTIVE` is the operator's physical fleet
 * declaration being applied (`physicalDeclaration.service`, at boot), and that is the same
 * step a newly commissioned physical unit needs before it can be offered work. So
 * recommissioning returns the *record*, and putting the unit back in service stays a
 * separate decision with every check it already had: the declaration (region, site, snap
 * radius), pairing, a fresh state-of-charge declaration, a live fix on a permitted way, an
 * unengaged stop latch and a recent probe answer.
 *
 * `Robot.status` (and with it a PAUSED/ERROR hold), the stop latch, the specification and the
 * battery reading are not touched. A hold that was in force at retirement is still in force.
 *
 * ── Credentials: nothing from before retirement survives ─────────────────────
 * Retirement revoked the durable session in its transaction and deleted the KV session,
 * pairing and lockout keys afterwards, best-effort. A key that survived that cleanup would
 * become usable the moment the robot stops being retired, so this operation:
 *
 *   1. deletes the KV credential keys inside its transaction, once the Agent lock is held and
 *      the unit is confirmed retired and physical — every reader still sees it retired until
 *      the commit (AUTH refuses a retired robot, and its online write waits on this lock), so
 *      nothing can re-create them in between — and rolls back (503) when the KV cannot
 *      confirm the deletes;
 *   2. deletes the durable `RobotSession` row in the same transaction;
 *   3. deletes the KV keys once more after the commit.
 *
 * It issues no pairing code. The robot is re-enrolled through the existing flow
 * (`POST /api/robots/commission` with only the robotId — the dashboard's Connect page),
 * which mints a fresh single-use code. A consumed or rejected code is never reusable: the
 * code is deleted when it is used, and step 1 deletes any code still outstanding.
 *
 * ── Concurrency and retries ─────────────────────────────────────────────────
 * One transaction, holding the Agent row `FOR UPDATE` — the same lock retirement and
 * `commit.js` take — so recommissioning and retirement serialise. The authority epoch
 * advances by exactly one (recorded in `AgentFenceAudit` as `recommission`), so no decision
 * taken against the retired agent's snapshot can commit afterwards.
 *
 * A request that finds the unit already `COMMISSIONED` with `recommission` as the last fence
 * source is answered `ALREADY_RECOMMISSIONED` and changes nothing: a double submit or a retry
 * after a lost response gets a success, and the second of two concurrent requests waits on the
 * lock and lands here. A unit in any other non-retired state is a 409 `ROBOT_NOT_RETIRED`.
 */

const clock = require("../engine/commitment/clock");
const availabilityIndex = require("../engine/candidates/availabilityIndex");
const { LIFECYCLE_STATES } = require("../engine/domain/agent");
const { indexRecordOf } = require("./robotRetirement.service");
const { toStringOrNull } = require("../utils/parse");
const policy = require("./robotRetirementPolicy");
// The physical/simulated discriminator is read through the one predicate the simulator uses.
const simulationPolicy = require("../simulation/simulationPolicy");

/** The lifecycle state a recommissioned robot's Agent carries. @structural §2.1 */
const RECOMMISSIONED_LIFECYCLE_STATE = LIFECYCLE_STATES.COMMISSIONED.name;

/** @structural outcome names */
const OUTCOME = Object.freeze({
  RECOMMISSIONED: "RECOMMISSIONED",
  ALREADY_RECOMMISSIONED: "ALREADY_RECOMMISSIONED",
});

/** @structural refusal codes, on the wire */
const REFUSAL = Object.freeze({
  INVALID_REQUEST: "INVALID_REQUEST",
  ROBOT_NOT_FOUND: "ROBOT_NOT_FOUND",
  ROBOT_NOT_RETIRED: "ROBOT_NOT_RETIRED",
  SIMULATED_NOT_RECOMMISSIONABLE: "SIMULATED_NOT_RECOMMISSIONABLE",
  CREDENTIAL_REVOCATION_UNAVAILABLE: "CREDENTIAL_REVOCATION_UNAVAILABLE",
});

/** `AgentFenceAudit.lastFenceSource` for the recommissioning epoch advance. @structural */
const FENCE_SOURCE = "recommission";

/** The request fields this operation reads; any other field is refused by name. @structural */
const REQUEST_FIELDS = Object.freeze(["reason", "confirmRobotId"]);

/** Bounds the operator-entered reason recorded on the Event row. @structural */
const MAX_REASON_LENGTH = 500;

/** Same bounds as retirement's transaction: a few indexed reads and writes plus the lock wait. @structural */
const TRANSACTION_TIMEOUT_MS = 15000;
const TRANSACTION_MAX_WAIT_MS = 10000;

/**
 * The KV keys that carry a robot's credentials or enrollment state. `session:` holds the
 * bearer token (or a §23.2 certificate binding), `pairing:` an unused code, and the two
 * lockout keys the F32 brute-force state. Retirement deletes the same four.
 * @param {string} robotId
 * @returns {string[]}
 */
function credentialKeys(robotId) {
  return [`session:${robotId}`, `pairing:${robotId}`, `pairingAttempts:${robotId}`, `pairingLocked:${robotId}`];
}

/** A refusal with an HTTP status and a machine-readable code. */
class RecommissionRefused extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.name = "RecommissionRefused";
    this.status = status;
    this.code = code;
    this.extra = extra && typeof extra === "object" ? extra : {};
  }

  /** The response body. `message` is the sentence the dashboard shows. */
  toBody() {
    const error = { 400: "Bad Request", 404: "Not Found", 409: "Conflict", 503: "Service Unavailable" }[this.status] || "Error";
    return { ok: false, error, code: this.code, refusal: this.code, message: this.message, ...this.extra };
  }
}

/**
 * Validate the request body. Pure.
 *
 * `reason` is mandatory: returning a withdrawn unit is a privileged act and its reason is the
 * part of the audit record an investigation reads first. `confirmRobotId` must repeat the id
 * in the path exactly, so a request aimed at the wrong unit — a stale page, a mistyped URL —
 * is refused rather than acted on. Unknown fields are refused by name rather than ignored:
 * a silently dropped `locationId` or `lifecycleState` would leave the caller believing it
 * took effect.
 *
 * @param {string} robotCode the id from the path
 * @param {object} body
 * @returns {{ ok: true, reason: string } | { ok: false, refusal: RecommissionRefused }}
 */
function validateRequest(robotCode, body) {
  const source = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const invalid = (message) => ({ ok: false, refusal: new RecommissionRefused(400, REFUSAL.INVALID_REQUEST, message) });

  const code = toStringOrNull(robotCode);
  if (!code) return invalid("robotId is required");

  const unknown = Object.keys(source).filter((key) => !REQUEST_FIELDS.includes(key));
  if (unknown.length > 0) {
    return invalid(
      `Recommissioning accepts only ${REQUEST_FIELDS.join(" and ")}; refused: ${unknown.join(", ")}. ` +
        "Configuration is edited after recommissioning; lifecycle and observed state are never set by a request.",
    );
  }

  const confirm = typeof source.confirmRobotId === "string" ? source.confirmRobotId.trim() : "";
  if (confirm !== code) {
    return invalid(`confirmRobotId must repeat the robot id exactly ("${code}") to confirm which unit is being recommissioned.`);
  }

  const reason = typeof source.reason === "string" ? source.reason.trim() : "";
  if (!reason) return invalid("A reason is required to recommission a retired robot; it is recorded in the audit trail.");
  if (reason.length > MAX_REASON_LENGTH) return invalid(`The reason must be at most ${MAX_REASON_LENGTH} characters.`);

  return { ok: true, reason };
}

/**
 * Delete the robot's KV credential keys. Throws a 503 refusal when the KV is absent or a
 * delete fails, because the operation must not proceed on an unconfirmed revocation.
 *
 * @param {object|null|undefined} kv
 * @param {string} robotId
 */
async function revokeCredentials(kv, robotId) {
  if (!kv || typeof kv.del !== "function") {
    throw new RecommissionRefused(
      503,
      REFUSAL.CREDENTIAL_REVOCATION_UNAVAILABLE,
      "The credential store is unavailable, so the retired robot's old credentials cannot be confirmed revoked. " +
        "Nothing was changed; try again when the backend's KV store is reachable.",
    );
  }
  try {
    for (const key of credentialKeys(robotId)) {
      // eslint-disable-next-line no-await-in-loop
      await kv.del(key);
    }
  } catch {
    throw new RecommissionRefused(
      503,
      REFUSAL.CREDENTIAL_REVOCATION_UNAVAILABLE,
      "The retired robot's old credentials could not be revoked in the KV store. Nothing was changed; try again.",
    );
  }
}

/** `SELECT … FOR UPDATE` on the Agent row — the statement retirement and `commit.js` issue. */
async function lockAgentRow(tx, agentRowId) {
  const rows = await tx.$queryRawUnsafe('SELECT * FROM "Agent" WHERE "id" = $1 FOR UPDATE', agentRowId);
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

/**
 * The transaction. The KV half of the revocation is passed in (`revokeCredentials`) and run
 * under the lock, after the unit is confirmed retired and physical and before any write.
 *
 * @param {object} prisma
 * @param {string} robotCode
 * @param {{ actorId?: string|null, reason: string, revokeCredentials?: Function,
 *   hooks?: { afterLock?: Function } }} options
 * @returns {Promise<object>} `{ outcome, robotId, robotDbId, agentRowId, agentId,
 *   lifecycleState, epochBefore, epochAfter }`
 * @throws {RecommissionRefused}
 */
async function recommissionInTransaction(prisma, robotCode, options) {
  const settings = options || {};
  const actorId = toStringOrNull(settings.actorId);
  const reason = String(settings.reason || "").slice(0, MAX_REASON_LENGTH);
  const hooks = settings.hooks || {};

  return prisma.$transaction(
    async (tx) => {
      const robot = await tx.robot.findUnique({
        where: { robotId: robotCode },
        select: { id: true, robotId: true, simulated: true },
      });
      if (!robot) throw new RecommissionRefused(404, REFUSAL.ROBOT_NOT_FOUND, `No robot with ID "${robotCode}" exists.`);

      // Retirement always leaves an Agent row (it creates one for an older robot that had
      // none), so a robot without one was never retired.
      const agentRow = await tx.agent.findUnique({ where: { robotDbId: robot.id }, select: { id: true } });
      if (!agentRow) {
        throw new RecommissionRefused(409, REFUSAL.ROBOT_NOT_RETIRED, `Unit ${robotCode} is not retired, so there is nothing to recommission.`, {
          lifecycleState: null,
        });
      }

      const agent = await lockAgentRow(tx, agentRow.id);
      if (!agent) throw new Error(`the Agent row for robot ${robotCode} vanished under its lock`);
      if (typeof hooks.afterLock === "function") await hooks.afterLock();

      const base = { robotId: robot.robotId, robotDbId: robot.id, agentRowId: agent.id, agentId: agent.agentId };

      if (agent.lifecycleState !== policy.RETIRED_LIFECYCLE_STATE) {
        // A retry of a recommissioning that already committed: nothing has moved the unit
        // since (no later epoch advance), so it is the same operation, answered again.
        if (agent.lifecycleState === RECOMMISSIONED_LIFECYCLE_STATE) {
          const audit = await tx.agentFenceAudit.findUnique({ where: { agentId: agent.id }, select: { lastFenceSource: true } });
          if (audit && audit.lastFenceSource === FENCE_SOURCE) {
            const epoch = BigInt(agent.authorityEpoch);
            return { ...base, outcome: OUTCOME.ALREADY_RECOMMISSIONED, lifecycleState: agent.lifecycleState, epochBefore: epoch, epochAfter: epoch };
          }
        }
        throw new RecommissionRefused(
          409,
          REFUSAL.ROBOT_NOT_RETIRED,
          `Unit ${robotCode} is not retired (lifecycle ${agent.lifecycleState}), so it cannot be recommissioned. ` +
            "If it was recommissioned earlier, connect it from its unit page instead.",
          { lifecycleState: agent.lifecycleState },
        );
      }

      // Simulated units are created by the server under generated ids and are provisioned by
      // the simulator, which dropped this one at retirement. Bringing one back would hand the
      // simulator a unit it no longer manages; a new simulated robot is the supported path.
      if (simulationPolicy.isSimulatedRobot(robot)) {
        throw new RecommissionRefused(
          409,
          REFUSAL.SIMULATED_NOT_RECOMMISSIONABLE,
          `Unit ${robotCode} is a retired simulated robot. Simulated robots are not recommissioned; create a new one instead.`,
        );
      }

      // Step 1, under the lock: the unit is confirmed retired and physical, and every reader
      // still sees it retired (AUTH refuses it, and its online write waits on this lock), so
      // nothing can re-create a credential between this delete and the commit. A failure
      // throws and rolls the transaction back.
      if (typeof settings.revokeCredentials === "function") await settings.revokeCredentials();

      const storeTime = await clock.readStoreTime(tx);
      const epochBefore = BigInt(agent.authorityEpoch);
      const epochAfter = epochBefore + BigInt(1);

      await tx.agent.update({
        where: { id: agent.id },
        data: { lifecycleState: RECOMMISSIONED_LIFECYCLE_STATE, authorityEpoch: epochAfter },
      });
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

      // Retirement revoked these; a session written by an AUTH that raced it is removed here.
      await tx.robotSession.deleteMany({ where: { robotDbId: robot.id } });
      // Retirement removed the unit's index mirror row too. One that survived it (a sweep that
      // raced the retirement, before the index maintainer took the lifecycle lock) would make a
      // COMMISSIONED unit a candidate that F2 rejects in every round. Removed under this lock;
      // the Redis half after the commit.
      const cell = await tx.agentCellPosition.findUnique({ where: { agentId: agent.id } });
      if (cell) await tx.agentCellPosition.deleteMany({ where: { agentId: agent.id } });
      await tx.robot.update({ where: { id: robot.id }, data: { isOnline: false, socketId: null } });

      await tx.event.create({
        data: {
          robotId: robot.id,
          type: "INFO",
          message:
            `Unit ${robot.robotId} recommissioned (lifecycle ${policy.RETIRED_LIFECYCLE_STATE} -> ${RECOMMISSIONED_LIFECYCLE_STATE}, ` +
            `authority epoch ${epochBefore} -> ${epochAfter})` +
            (actorId ? ` by ${actorId}` : "") +
            `: ${reason}. Previous credentials revoked; not yet released into service ` +
            "(pairing and the physical fleet declaration are still required).",
        },
      });

      return { ...base, outcome: OUTCOME.RECOMMISSIONED, lifecycleState: RECOMMISSIONED_LIFECYCLE_STATE, epochBefore, epochAfter, cell: cell || null };
    },
    { timeout: TRANSACTION_TIMEOUT_MS, maxWait: TRANSACTION_MAX_WAIT_MS },
  );
}

/**
 * Recommission one retired robot: validate, then — in one transaction under the Agent lock —
 * revoke its old credentials and transition it; revoke the KV keys again after the commit.
 *
 * @param {object} prisma
 * @param {string} robotCode the business id (`Robot.robotId`)
 * @param {object} body the request body (`reason`, `confirmRobotId`)
 * @param {{ actorId?: string|null, kv?: object, hooks?: object }} [options]
 * @returns {Promise<object>} the transaction's result, plus `postCommitRevocationFailed`
 * @throws {RecommissionRefused}
 */
async function recommission(prisma, robotCode, body, options) {
  const settings = options || {};
  const code = toStringOrNull(robotCode);
  const validated = validateRequest(code, body);
  if (!validated.ok) throw validated.refusal;

  // Step 1 runs inside the transaction, only once the unit is confirmed retired and physical
  // under its lock — so a live robot's credentials are never touched.
  const result = await recommissionInTransaction(prisma, code, {
    actorId: settings.actorId,
    reason: validated.reason,
    hooks: settings.hooks,
    revokeCredentials: () => revokeCredentials(settings.kv, code),
  });

  // Step 3. The revocation that matters already happened before the commit, so a failure here
  // is reported, never turned into an error for an operation that is durable.
  let postCommitRevocationFailed = false;
  let indexEntryRemovalFailed = false;
  const { cell, ...outcome } = result;
  if (result.outcome === OUTCOME.RECOMMISSIONED) {
    try {
      await revokeCredentials(settings.kv, code);
    } catch {
      postCommitRevocationFailed = true;
    }
    // The Redis half of a leftover index entry whose mirror row went in the transaction.
    if (cell && settings.kv) {
      const removed = await availabilityIndex.removePosition({ kv: settings.kv }, indexRecordOf(cell));
      indexEntryRemovalFailed = !removed || removed.ok !== true;
    }
  }
  return {
    ...outcome,
    postCommitRevocationFailed,
    indexEntryRemoved: Boolean(cell),
    ...(indexEntryRemovalFailed ? { indexEntryRemovalFailed: true } : {}),
  };
}

/**
 * The retired robots an operator can choose from. Never returns credentials or session data.
 *
 * `retiredAt` is the store time retirement recorded on the agent's fence audit, when that is
 * still the latest fence event; otherwise null.
 *
 * @param {object} prisma
 * @returns {Promise<Array<{ robotId: string, name: string|null, simulated: boolean,
 *   recommissionable: boolean, lastSeenAt: string|null, locationName: string|null, retiredAt: string|null }>>}
 */
async function listRetiredRobots(prisma) {
  const robots = await prisma.robot.findMany({
    where: { agent: { is: { lifecycleState: policy.RETIRED_LIFECYCLE_STATE } } },
    select: {
      robotId: true,
      name: true,
      simulated: true,
      lastSeenAt: true,
      location: { select: { name: true } },
      agent: { select: { id: true } },
    },
    orderBy: { robotId: "asc" },
  });

  const agentIds = robots.map((row) => row.agent && row.agent.id).filter(Boolean);
  const audits = agentIds.length
    ? await prisma.agentFenceAudit.findMany({
        where: { agentId: { in: agentIds } },
        select: { agentId: true, lastFenceSource: true, observedAt: true },
      })
    : [];
  const retiredAtByAgent = new Map(
    audits.filter((row) => row.lastFenceSource === "decommission" && row.observedAt).map((row) => [row.agentId, new Date(row.observedAt).toISOString()]),
  );

  return robots.map((row) => ({
    robotId: row.robotId,
    name: row.name || null,
    simulated: simulationPolicy.isSimulatedRobot(row),
    recommissionable: !simulationPolicy.isSimulatedRobot(row),
    lastSeenAt: row.lastSeenAt ? new Date(row.lastSeenAt).toISOString() : null,
    locationName: (row.location && row.location.name) || null,
    retiredAt: (row.agent && retiredAtByAgent.get(row.agent.id)) || null,
  }));
}

module.exports = {
  OUTCOME,
  REFUSAL,
  FENCE_SOURCE,
  RECOMMISSIONED_LIFECYCLE_STATE,
  MAX_REASON_LENGTH,
  RecommissionRefused,
  credentialKeys,
  validateRequest,
  revokeCredentials,
  recommissionInTransaction,
  recommission,
  listRetiredRobots,
};
