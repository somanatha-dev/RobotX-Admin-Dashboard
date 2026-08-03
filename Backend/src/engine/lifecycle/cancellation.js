"use strict";

/**
 * Cancellation (§4.6) — a request, not an instruction.
 *
 * > Cancellation is a request, not an instruction, and MUST be race-free against an
 * > in-flight round. The baseline's cancellation of a `PENDING` task is silently
 * > reverted by the concurrently-running assignment; that class of bug is prevented as
 * > follows.
 * >
 * > 1. Cancellation writes `cancel_requested_at` and increments the version in a
 * >    transaction. It does **not** attempt to reach a terminal state directly.
 *
 * That first step is the whole mechanism, and it looks like doing less. Writing the flag
 * and stopping is what makes the *round's* conditional write fail — the round loses its
 * CAS and abandons its decision, with no lost update — whereas a cancellation that drove
 * straight to `CANCELLED` would race the round and one of them would overwrite the other.
 *
 * ── The guard is purpose-conditioned, and that is not a loophole ────────────
 * > ```
 * > cancel_requested_at IS NULL   OR   leg.purpose ∈ custodial_purposes
 * > ```
 * >
 * > The unqualified guard `cancel_requested_at IS NULL` would be self-defeating: step 3
 * > below *mandates* generating a return-or-transfer Leg on a Task whose cancellation
 * > flag is, by definition, already set, and the unqualified guard blocks precisely that
 * > Leg. The exemption is therefore not a loophole in the guard; it is what makes the
 * > guard's own mandated recovery path executable.
 *
 * The guard itself lives in `transitions.js`, where every transition passes through it.
 * This module is the *protocol* — the flag, the three custody resolutions, and the
 * `RECOVERY` Leg that custody `HELD` requires.
 *
 * ── Invariant I11 is stronger than "never executes" ─────────────────────────
 * > **A cancelled Task reaches `CANCELLED` only when every custodial Leg it spawned has
 * > settled.** Until then it is `SUSPENDED` with the outstanding custody obligation
 * > named. […] recovery Legs *do* execute, and must, so the invariant is stated over
 * > `PRIMARY` Legs and over custody discharge rather than over execution as such.
 *
 * Tier 1 by path (T1-05). Invariant I11.
 */

const custody = require("../domain/custody");
const legMachine = require("./legMachine");
const purpose = require("../domain/purpose");
const taskMachine = require("./taskMachine");
const timers = require("../supervision/timers");

/** §4.6 step 3's three cases. @structural the enumerated cancellation resolutions */
const RESOLUTION = Object.freeze({
  /** Custody NONE and no HARD commitment: `CANCELLED` immediately. */
  CANCELLED_IMMEDIATELY: "CANCELLED_IMMEDIATELY",
  /** HARD commitment, custody NONE: `ABORTING`, recall at an advanced fence. */
  RECALL_THEN_CANCEL: "RECALL_THEN_CANCEL",
  /** Custody HELD: `ABORTING`, and a new `RECOVERY` Leg. */
  RECOVERY_LEG_REQUIRED: "RECOVERY_LEG_REQUIRED",
});

/** @structural outcome labels */
const OUTCOME = Object.freeze({
  REQUESTED: "REQUESTED",
  RESOLVED: "RESOLVED",
  REFUSED: "REFUSED",
  LOST_RACE: "LOST_RACE",
});

/**
 * §4.6 step 1 — record the request. Nothing else.
 *
 * The version increment is what makes an in-flight round's conditional write fail. It is
 * therefore not bookkeeping: it *is* the race-freedom.
 *
 * §4.6 step 5's authority check — *"Cancellation authority is checked against the
 * requester's scope, is rate-limited, and is audited (§23.6)"* — is the caller's, and
 * this refuses without it rather than assuming it was done. `purpose.isCancellableByRequester`
 * is the second half: *"A requester may not cancel a `RECOVERY` or `TRANSFER` Leg at
 * all."*
 *
 * @param {object} tx a Prisma transaction client
 * @param {object} input
 * @param {object} input.leg
 * @param {Date} input.storeTime
 * @param {string} input.requestedBy
 * @param {boolean} input.authorised the §23.6 scope check's result
 * @param {boolean} [input.isOperator] operators may cancel custodial Legs; requesters may not
 * @param {string} [input.reason]
 * @returns {Promise<object>}
 */
async function requestCancellation(tx, input) {
  const source = input || {};
  const leg = source.leg;

  if (!leg) return { outcome: OUTCOME.REFUSED, reason: "NO_LEG", detail: null };
  if (source.authorised !== true) {
    return {
      outcome: OUTCOME.REFUSED,
      reason: "NOT_AUTHORISED",
      detail: "§4.6 step 5 — authority is checked against the requester's scope, rate-limited, and audited (§23.6)",
    };
  }
  if (legMachine.isTerminal(leg.state)) {
    return {
      outcome: OUTCOME.REFUSED,
      reason: "LEG_TERMINAL",
      detail: `the Leg is ${leg.state}; a terminal state is never modified (invariant I12)`,
    };
  }
  if (!purpose.isCancellableByRequester(leg.purpose) && source.isOperator !== true) {
    return {
      outcome: OUTCOME.REFUSED,
      reason: "CUSTODIAL_PURPOSE_NOT_REQUESTER_CANCELLABLE",
      detail:
        "§4.6 step 5 — a requester may not cancel a RECOVERY or TRANSFER Leg at all; only an authorised operator " +
        "may, and only by explicitly reassigning the custody obligation to another disposition, which is itself " +
        "recorded",
    };
  }

  const written = await tx.leg.updateMany({
    where: { id: leg.id, version: leg.version },
    data: {
      cancelRequestedAt: source.storeTime,
      cancelReason: source.reason || null,
      version: leg.version + 1,
    },
  });

  if (written.count !== 1) {
    return { outcome: OUTCOME.LOST_RACE, reason: "LEG_VERSION_MOVED", detail: null };
  }

  return {
    outcome: OUTCOME.REQUESTED,
    reason: null,
    // The Leg does **not** move state here. §4.6 step 1: "It does not attempt to reach a
    // terminal state directly."
    legState: leg.state,
    version: leg.version + 1,
    resolution: resolutionFor(leg, source.hasHardCommitment === true),
  };
}

/**
 * §4.6 step 3 — which of the three resolutions does this Leg's custody imply?
 *
 * Pure, so the table can be tested exhaustively.
 *
 * @param {object} leg
 * @param {boolean} hasHardCommitment
 * @returns {string}
 */
function resolutionFor(leg, hasHardCommitment) {
  if (custody.holdsGoods(leg.custodyState)) return RESOLUTION.RECOVERY_LEG_REQUIRED;
  if (hasHardCommitment) return RESOLUTION.RECALL_THEN_CANCEL;
  return RESOLUTION.CANCELLED_IMMEDIATELY;
}

/**
 * §4.6 step 3, custody `HELD` — the `RECOVERY` Leg specification.
 *
 * > Custody `HELD`: cancellation **cannot** complete autonomously. The Leg transitions
 * > to `ABORTING`, and a new Leg with `purpose = RECOVERY` is created to return the goods
 * > to origin or divert them to a designated recovery point. That Leg is queued, planned,
 * > committed, and settled through the ordinary pipeline — it is exempt from the
 * > cancellation guard by step 2, not by a special-case code path. The Task remains
 * > non-terminal until goods are accounted for. **Cancelling a delivery does not make the
 * > parcel disappear, and the model MUST not pretend otherwise.**
 *
 * The Leg is created in the same transaction as the `ABORTING` transition, so a crash
 * between the two cannot leave a cancelled mission with goods aboard and no recovery
 * obligation.
 *
 * @param {object} tx a transaction client
 * @param {object} input
 * @param {object} input.leg the Leg being cancelled
 * @param {Date} input.storeTime
 * @param {{ lat: number, lon: number, label: string }} input.recoveryDestination
 * @param {number} input.abortBudgetSeconds `recover.abort_budget`
 * @param {string} [input.shardId]
 * @returns {Promise<object>}
 */
async function spawnRecoveryLeg(tx, input) {
  const source = input || {};
  const leg = source.leg;

  if (!custody.holdsGoods(leg.custodyState)) {
    return {
      outcome: OUTCOME.REFUSED,
      reason: "CUSTODY_NOT_HELD",
      detail: "a RECOVERY Leg exists to return goods; there are none aboard",
    };
  }
  if (!source.recoveryDestination) {
    return {
      outcome: OUTCOME.REFUSED,
      reason: "NO_RECOVERY_DESTINATION",
      detail:
        "§4.6 step 3 requires the goods returned to origin or diverted to a designated recovery point. Neither " +
        "was supplied, and inventing one would be the engine deciding where somebody's parcel goes.",
    };
  }

  // The cancelled Leg moves to ABORTING. Conditional on its version, like every
  // transition (§4.1 rule 2).
  const aborted = await tx.leg.updateMany({
    where: { id: leg.id, version: leg.version },
    data: { state: legMachine.LEG_STATE.ABORTING, version: leg.version + 1 },
  });
  if (aborted.count !== 1) {
    return { outcome: OUTCOME.LOST_RACE, reason: "LEG_VERSION_MOVED", detail: null };
  }

  await timers.cancelFor(tx, {
    entityType: timers.ENTITY_TYPE.LEG,
    entityId: leg.id,
    storeTime: source.storeTime,
    reason: "CANCELLATION_ABORTING",
  });

  await timers.register(tx, {
    entityType: timers.ENTITY_TYPE.LEG,
    entityId: leg.id,
    state: legMachine.LEG_STATE.ABORTING,
    entity: { ...leg, version: leg.version + 1 },
    dueAt: timers.deadlineFrom(source.storeTime, source.abortBudgetSeconds),
    handler: legMachine.deadlineFor(legMachine.LEG_STATE.ABORTING).onExpiry,
    payload: { cause: "CANCELLATION_WITH_CUSTODY_HELD" },
    shardId: source.shardId,
  });

  // The RECOVERY Leg. It joins the same Mission, so the custody obligation stays
  // attached to the work it came from rather than becoming a free-floating errand.
  const sequence = await nextSequenceInMission(tx, leg.missionId);
  const recoveryLeg = await tx.leg.create({
    data: {
      legId: `${leg.legId}-recovery-${sequence}`,
      missionId: leg.missionId,
      sequence,
      // Set at creation and never mutated (§2.4). This is what exempts it from the
      // cancellation guard, makes it non-preemptible (§4.8 rule 1) and non-sheddable
      // (§20.5) — "three properties that would otherwise each need their own ad-hoc test".
      purpose: purpose.PURPOSES.RECOVERY.name,
      state: legMachine.LEG_STATE.QUEUED,
      // The goods are still in the incumbent. The RECOVERY Leg's job is to take custody
      // of them, so it starts with none of its own.
      custodyState: custody.CUSTODY_STATES.NONE.name,
      version: 0,
    },
  });

  await tx.stop.create({
    data: {
      stopId: `${recoveryLeg.legId}-drop`,
      legId: recoveryLeg.id,
      sequence: 0,
      stopType: "DROP",
      label: source.recoveryDestination.label || "recovery point",
      lat: source.recoveryDestination.lat,
      lon: source.recoveryDestination.lon,
    },
  });

  return {
    outcome: OUTCOME.RESOLVED,
    reason: null,
    resolution: RESOLUTION.RECOVERY_LEG_REQUIRED,
    abortedLegId: leg.id,
    recoveryLegId: recoveryLeg.id,
    // §4.6 step 4 — the Task stays non-terminal, and says why.
    taskState: taskMachine.TASK_STATE.SUSPENDED,
    outstandingCustodyObligation: recoveryLeg.legId,
  };
}

/**
 * §4.6 step 4 / invariant I11 — may this cancelled Task reach `CANCELLED` yet?
 *
 * > A cancelled Task reaches `CANCELLED` only when every custodial Leg it spawned has
 * > settled. Until then it is `SUSPENDED` with the outstanding custody obligation named.
 *
 * @param {Array<{ purpose: string, state: string, legId: string }>} legs every Leg of the Task
 * @returns {{ mayCancel: boolean, taskState: string, outstanding: string[] }}
 */
function assessTaskTermination(legs) {
  const all = Array.isArray(legs) ? legs : [];
  const outstanding = all
    .filter((leg) => purpose.isCustodial(leg.purpose))
    .filter((leg) => leg.state !== legMachine.LEG_STATE.SETTLED)
    .map((leg) => leg.legId);

  if (outstanding.length > 0) {
    return { mayCancel: false, taskState: taskMachine.TASK_STATE.SUSPENDED, outstanding };
  }
  return { mayCancel: true, taskState: taskMachine.TASK_STATE.CANCELLED, outstanding: [] };
}

/**
 * Invariant I11's first half, as a query: has any `PRIMARY` Leg of a cancelled Task
 * transitioned into execution?
 *
 * "Into execution" is any state at or beyond `ACCEPTED` — the point at which a HARD
 * commitment exists and the agent has been told to act.
 * @structural the execution partition of §4.3, as invariant I11 reads it
 */
const EXECUTION_STATES = Object.freeze([
  legMachine.LEG_STATE.ACCEPTED,
  legMachine.LEG_STATE.EN_ROUTE_PICKUP,
  legMachine.LEG_STATE.AT_PICKUP,
  legMachine.LEG_STATE.LOADED,
  legMachine.LEG_STATE.EN_ROUTE_DROP,
  legMachine.LEG_STATE.AT_DROP,
]);

/**
 * @param {object} prisma
 * @param {number} [limit]
 * @returns {Promise<object[]>}
 */
async function auditI11(prisma, limit) {
  const cancelled = await prisma.leg.findMany({
    where: { cancelRequestedAt: { not: null }, purpose: purpose.PURPOSES.PRIMARY.name },
    take: limit || DEFAULT_AUDIT_LIMIT,
  });

  return cancelled
    .filter((leg) => EXECUTION_STATES.includes(leg.state))
    .map((leg) => ({ legId: leg.legId, state: leg.state, cancelRequestedAt: leg.cancelRequestedAt }));
}

/**
 * The next free sequence in a Mission's ordered Leg list.
 *
 * `(missionId, sequence)` is unique in the schema, so a collision is a constraint
 * violation rather than a silent overwrite — which is why this reads the maximum rather
 * than counting rows: counting would collide with any Leg that had been removed.
 */
async function nextSequenceInMission(tx, missionId) {
  const rows = await tx.leg.findMany({ where: { missionId }, orderBy: { sequence: "desc" }, take: 1 });
  return rows.length > 0 ? rows[0].sequence + 1 : 0;
}

/** @structural the audit's batch size; a work-partitioning constant */
const DEFAULT_AUDIT_LIMIT = 200;

module.exports = {
  RESOLUTION,
  OUTCOME,
  EXECUTION_STATES,
  requestCancellation,
  resolutionFor,
  spawnRecoveryLeg,
  assessTaskTermination,
  auditI11,
};
