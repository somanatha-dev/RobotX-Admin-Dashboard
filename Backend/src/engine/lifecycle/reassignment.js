"use strict";

/**
 * The reassignment protocol (§4.7) — *"the mechanism absent from the baseline entirely,
 * and it MUST be custody-aware."*
 *
 * **Protocol, custody `NONE`:**
 * > 1. Freeze the Leg (`REASSIGNING`); it stops being modifiable by rounds.
 * > 2. **In one transaction:** advance the incumbent commitment's fence, mark the
 * >    commitment revoked, and write the recall command to the outbox at the new fence.
 * >    The ordering is mandatory and is a transactional property, not a sequencing
 * >    convention: the fence advance and the command that carries it are written
 * >    together, so the recall can never be emitted before the authority that justifies
 * >    it has committed, and no in-flight command from the superseded commitment can
 * >    outrank the recall. **The fence advance does not wait for the agent to respond** —
 * >    this is what makes reassignment safe when the incumbent is unreachable.
 * > 3. Release the commitment; mark the incumbent ineligible for this Leg for
 * >    `recover.incumbent_cooloff` to prevent ping-pong.
 * > 4. Requeue with an aging credit equal to the time already lost, so the Leg is not
 * >    penalised for the incumbent's failure.
 * > 5. Record cause, cost, and the reliability signal attributed to the incumbent.
 *
 * ── Only *that* commitment's fence advances ─────────────────────────────────
 * > Only the *reassigned commitment's* fence advances. Every other commitment the
 * > incumbent holds keeps its own fence and remains fully commandable, which is what
 * > permits reassignment of one Leg on a `capacity > 1` agent without disabling the rest
 * > (§10.3).
 *
 * That is invariant I19, and it is why this module never touches `authorityEpoch`. The
 * agent-scope escalation §4.7 step 2 describes — *"Where the recovery requires the
 * incumbent to abandon **all** work — quarantine, e-stop, or an unrecoverable fault —
 * the agent-scope `authority_epoch` is advanced instead"* — is a different action with a
 * different trigger, and conflating them is exactly how a `capacity > 1` fleet becomes
 * uncommandable.
 *
 * ── "Materially better" is not a threshold this module owns ─────────────────
 * > It means exactly what the objective already says it means: the re-planning column's
 * > price, *including* `C_churn` […] is lower than the incumbent's. […] There is one
 * > threshold, it is priced in CU, and it lives in the cost function.
 *
 * So no comparison lives here. This module executes a reassignment that something else
 * has decided on — a lease expiry, a fault, an operator, or a round — and refuses one
 * that would exceed `recover.max_reassignments_per_leg`.
 *
 * Tier 1 by path (T1-05). Invariants I5, I6, I19.
 */

const clock = require("../commitment/clock");
const custody = require("../domain/custody");
const fencing = require("../commitment/fencing");
const legMachine = require("./legMachine");
const offers = require("../dispatch/offers");
const outbox = require("../dispatch/outbox");
const sequence = require("../dispatch/sequence");
const timers = require("../supervision/timers");

/** @structural outcome labels */
const OUTCOME = Object.freeze({
  REASSIGNED: "REASSIGNED",
  REFUSED: "REFUSED",
  LOST_RACE: "LOST_RACE",
  SUSPENDED: "SUSPENDED",
});

/** §4.7's trigger list, named so a repair can be attributed. @structural */
const TRIGGER = Object.freeze({
  LEASE_EXPIRY: "LEASE_EXPIRY",
  BLOCKING_FAULT: "BLOCKING_FAULT",
  CONNECTIVITY_LOSS: "CONNECTIVITY_LOSS",
  ENERGY_SHORTFALL: "ENERGY_SHORTFALL",
  ETA_BREACH: "ETA_BREACH",
  AGENT_NACK: "AGENT_NACK",
  OPERATOR_ACTION: "OPERATOR_ACTION",
  PREEMPTION: "PREEMPTION",
  REPLAN: "REPLAN",
  START_GRACE_EXPIRY: "START_GRACE_EXPIRY",
});

/**
 * §4.7 — *"Reassignment is bounded. `recover.max_reassignments_per_leg` (default 3) caps
 * the chain; on exhaustion the Leg goes to `SUSPENDED` for operator decision. An
 * unbounded reassignment loop is a livelock that consumes fleet capacity while
 * completing nothing."*
 *
 * The chain length is **derived** from the Leg's commitment history rather than stored
 * in a counter: every reassignment releases a commitment, so the number of released
 * commitments this Leg has accumulated is the number of times it has been reassigned. A
 * separate counter would be a second source of truth that a crash between the release
 * and the increment could put out of step, and the reconciler would then need a divergence
 * class for it.
 *
 * @param {Array<object>} commitments every commitment ever created for this Leg
 * @returns {number}
 */
function chainLength(commitments) {
  const all = Array.isArray(commitments) ? commitments : [];
  return all.filter((commitment) => commitment.releasedAt !== null && commitment.releasedAt !== undefined).length;
}

/**
 * @param {object} input
 * @param {Array<object>} input.commitments
 * @param {number} input.maxReassignmentsPerLeg `recover.max_reassignments_per_leg`
 * @returns {{ permitted: boolean, chainLength: number, reason: string|null }}
 */
function assessChainBound(input) {
  const source = input || {};
  const length = chainLength(source.commitments);

  if (!Number.isInteger(source.maxReassignmentsPerLeg) || source.maxReassignmentsPerLeg < 0) {
    throw new RangeError(
      `recover.max_reassignments_per_leg resolved to ${String(source.maxReassignmentsPerLeg)}; a chain bound is a ` +
        "non-negative integer (§4.7)",
    );
  }

  if (length >= source.maxReassignmentsPerLeg) {
    return { permitted: false, chainLength: length, reason: "MAX_REASSIGNMENTS_EXHAUSTED" };
  }
  return { permitted: true, chainLength: length, reason: null };
}

/**
 * Has this Leg's chain been **withdrawn past** its bound — the state `reassign` leaves an
 * exhausted Leg in, awaiting an operator?
 *
 * Derived from the same commitment history as `assessChainBound`, never stored. A permitted
 * reassignment releases a commitment only while `chainLength < max`, so afterwards the count
 * is at most `max`; the exhausted path releases one more, so afterwards it is `max + 1` or
 * greater. "Strictly greater" therefore separates the two without a second source of truth —
 * which is what lets the orphan scan requeue the first and leave the second to `ESCALATE`.
 *
 * @param {Array<object>} commitments every commitment ever created for this Leg
 * @param {number} maxReassignmentsPerLeg `recover.max_reassignments_per_leg`
 * @returns {boolean}
 */
function chainExceedsBound(commitments, maxReassignmentsPerLeg) {
  if (!Number.isInteger(maxReassignmentsPerLeg) || maxReassignmentsPerLeg < 0) return false;
  return chainLength(commitments) > maxReassignmentsPerLeg;
}

/**
 * Execute §4.7's custody-`NONE` protocol, steps 1 to 4, in **one** transaction.
 *
 * Steps 1 and 2 cannot be separate transactions and the specification says why: a fence
 * advanced in one and a recall written in another can emit the recall before the advance
 * commits, or after it has rolled back. So the Leg freeze, the fence advance, the
 * commitment release, and the `RECALL` outbox row are one write.
 *
 * Step 5's reliability signal is returned rather than written — §16.3's estimator is
 * Phase 16's (T2-09), and writing a counter nothing reads would be a record that could
 * silently disagree with the estimator when it arrives. The same treatment
 * `offers.applyReject` gives its exclusion window, for the same reason.
 *
 * @param {object} tx a Prisma transaction client
 * @param {object} input
 * @param {object} input.leg the Leg row, read under lock
 * @param {object} input.agent the incumbent's Agent row, read under lock
 * @param {object} input.commitment the incumbent commitment
 * @param {Array<object>} [input.legCommitments] every commitment for this Leg, for the chain bound
 * @param {Date} input.storeTime
 * @param {string} input.trigger one of `TRIGGER`
 * @param {number} input.maxReassignmentsPerLeg `recover.max_reassignments_per_leg`
 * @param {number} input.incumbentCooloffSeconds `recover.incumbent_cooloff`
 * @param {number} input.reassignBudgetSeconds `recover.reassign_budget`
 * @param {number} input.maxDeliveryDelaySeconds `dispatch.max_delivery_delay`
 * @param {string|Buffer} input.signingKey §23.3
 * @param {string} [input.shardId]
 * @returns {Promise<object>}
 */
async function reassign(tx, input) {
  const source = input || {};
  const { leg, agent, commitment, storeTime } = source;

  if (!leg || !agent || !commitment) {
    return { outcome: OUTCOME.REFUSED, reason: "INCOMPLETE_REQUEST", detail: "reassignment names Leg, agent, and commitment" };
  }

  // §4.7's custody bar. Custody `HELD` has three lawful outcomes and none of them is
  // this function — `supervision/leases.assessRecovery` chooses between them, and
  // reaching here with goods aboard means that choice was skipped.
  if (custody.holdsGoods(leg.custodyState)) {
    return {
      outcome: OUTCOME.REFUSED,
      reason: "CUSTODY_HELD",
      detail:
        "§4.7's custody-HELD protocol has exactly three lawful outcomes — Resume, Transfer, Physical recovery — " +
        "and the engine MUST choose explicitly rather than defaulting. The custody-NONE protocol is not one of them.",
    };
  }

  const bound = assessChainBound({
    commitments: source.legCommitments,
    maxReassignmentsPerLeg: source.maxReassignmentsPerLeg,
  });
  if (!bound.permitted) {
    // §4.7 — "on exhaustion the Leg goes to `SUSPENDED` for operator decision". The Leg
    // machine has no SUSPENDED state (that is the Task's, §4.2), so the Leg is frozen in
    // REASSIGNING and the *Task* is suspended, which is what the caller is told.
    //
    // P7-D2 (2026-10-10). This branch used to return here having written nothing: the Leg
    // stayed in its execution state with a live commitment whose lease had lapsed, so every
    // reconciler sweep chose REASSIGN again and was refused again — for a week on LOCAL. The
    // freeze the comment above promises is now performed, by the same steps 1–3 as the
    // ordinary path: the incumbent's authority is withdrawn exactly as for a reassignment
    // (fence advance, RECALL and release in one transaction, which §4.7 makes safe without
    // the agent's answer). Step 4 is what exhaustion replaces: the Leg is NOT requeued.
    // REASSIGNING's own deadline (`recover.reassign_budget` → ESCALATE) is armed instead, and
    // `reconciler.scanOrphanLegs` leaves a Leg whose chain exceeds the bound to that timer.
    const withdrawn = await withdrawIncumbent(tx, source, {
      reason: "REASSIGNMENT_CHAIN_EXHAUSTED",
      timerPayload: { chainExhausted: true, chainLength: bound.chainLength, awaiting: "OPERATOR_DECISION" },
    });
    if (!withdrawn.ok) return { outcome: OUTCOME.LOST_RACE, reason: "LEG_VERSION_MOVED", detail: null };

    return {
      outcome: OUTCOME.SUSPENDED,
      reason: bound.reason,
      detail:
        `this Leg has already been reassigned ${bound.chainLength} time(s). An unbounded reassignment loop is a ` +
        "livelock that consumes fleet capacity while completing nothing (§4.7).",
      chainLength: bound.chainLength,
      taskState: "SUSPENDED",
      legId: leg.id,
      legState: legMachine.LEG_STATE.REASSIGNING,
      awaiting: "OPERATOR_DECISION",
      requeued: false,
      recallFence: withdrawn.recallFence,
      recallOutboxId: withdrawn.recallOutboxId,
      releasedCommitmentId: commitment.commitmentId,
      reliabilitySignal: {
        agentId: agent.id,
        commitmentId: commitment.commitmentId,
        trigger: source.trigger || TRIGGER.OPERATOR_ACTION,
        observedAt: storeTime,
      },
      authorityEpochTouched: false,
    };
  }

  const withdrawn = await withdrawIncumbent(tx, source, { reason: "REASSIGNMENT", timerPayload: {} });
  if (!withdrawn.ok) return { outcome: OUTCOME.LOST_RACE, reason: "LEG_VERSION_MOVED", detail: null };
  const { recallFence, recallOutboxId } = withdrawn;

  return {
    outcome: OUTCOME.REASSIGNED,
    reason: null,
    recallFence,
    recallOutboxId,
    releasedCommitmentId: commitment.commitmentId,
    legState: legMachine.LEG_STATE.REASSIGNING,
    chainLength: bound.chainLength + 1,
    // Step 3's second half — "mark the incumbent ineligible for this Leg for
    // `recover.incumbent_cooloff` to prevent ping-pong". Returned as an absolute instant
    // for the availability index (Phase 9) and the round (Phase 10) to honour; writing it
    // somewhere neither of them reads would be a record nobody honours.
    excludeIncumbentUntil: clock.deadlineFrom(storeTime, source.incumbentCooloffSeconds),
    // Step 4 — "an aging credit equal to the time already lost, so the Leg is not
    // penalised for the incumbent's failure". Priced by §8.7's aging term (Phase 8);
    // measured here, because this is where "the time already lost" is known.
    agingCreditSeconds: agingCreditSeconds(commitment, storeTime),
    // Step 5 — cause and the reliability signal attributed to the incumbent (§16.3).
    reliabilitySignal: {
      agentId: agent.id,
      commitmentId: commitment.commitmentId,
      trigger: source.trigger || TRIGGER.OPERATOR_ACTION,
      observedAt: storeTime,
    },
    // I19, asserted rather than assumed: this path never touches the agent scope.
    authorityEpochTouched: false,
  };
}

/**
 * §4.7's custody-`NONE` steps 1–3, and the REASSIGNING deadline §4.5 attaches to step 1 — the
 * withdrawal of the incumbent's authority, shared by the ordinary path and the exhausted one.
 *
 * Written once so the two cannot drift: the Leg freeze (conditional on its version), the
 * advance of **this commitment's** fence, the signed RECALL at the new fence, the release, the
 * I6 high-water mark, the cancellation of the old state's timers and the REASSIGNING timer —
 * all in the caller's transaction, in this order, exactly as `reassign` wrote them inline.
 *
 * @param {object} tx
 * @param {object} source `reassign`'s input
 * @param {{ reason: string, timerPayload: object }} options the RECALL's default reason, and
 *   what the REASSIGNING timer's payload adds to `{ trigger, supersededCommitment }`
 * @returns {Promise<{ ok: false } | { ok: true, recallFence: bigint, recallOutboxId: string }>}
 */
async function withdrawIncumbent(tx, source, options) {
  const { leg, agent, commitment, storeTime } = source;

  // Step 1 — freeze the Leg. Conditional on its version (§4.1 rule 2), so a round that
  // was mid-decision loses rather than overwriting the freeze.
  const frozen = await tx.leg.updateMany({
    where: { id: leg.id, version: leg.version },
    data: { state: legMachine.LEG_STATE.REASSIGNING, version: leg.version + 1 },
  });
  if (frozen.count !== 1) {
    return { ok: false };
  }

  // Step 2 — advance **this commitment's** fence and write the RECALL at the new fence.
  const recallFence = fencing.allocateFence(agent.fenceCounter);
  if (!fencing.isStrictAdvance(agent.fenceCounter, recallFence)) {
    throw new Error(`the recall fence did not advance the counter for agent ${agent.id} (invariant I6)`);
  }

  await tx.agent.update({ where: { id: agent.id }, data: { fenceCounter: recallFence } });

  const notValidAfter = clock.deadlineFrom(storeTime, source.maxDeliveryDelaySeconds);
  const payload = {
    commitmentId: commitment.commitmentId,
    supersedesFence: String(BigInt(commitment.fence)),
    trigger: source.trigger || TRIGGER.OPERATOR_ACTION,
    reason: source.reason || options.reason,
  };

  const allocated = await sequence.allocate(tx, { command: "RECALL", commitmentId: commitment.commitmentId });
  const signed = offers.signMissionCommand(
    {
      // The wire identity, as for OFFER and WITHDRAW (`dispatch/offers.js`): the delivery arm
      // addresses the envelope to `Agent.agentId` (`leaderWorkers`), so a RECALL signed for
      // the row id failed verification at every agent that verifies (P2B-2, measured 0/1).
      // The row id stays the Outbox FK below.
      agentId: agent.agentId || agent.id,
      command: "RECALL",
      commitmentId: commitment.commitmentId,
      fence: recallFence,
      sequence: allocated,
      notValidAfter,
      payload,
    },
    source.signingKey,
  );

  const recallRow = await outbox.enqueue(
    tx,
    outbox.buildRow({
      command: "RECALL",
      agentId: agent.id,
      commitmentId: commitment.commitmentId,
      fence: recallFence,
      sequence: allocated,
      payload,
      notValidAfter,
      signature: signed.signature,
    }),
  );

  // Step 3 — release the commitment. `releasedAt` is what the §10.3.2 partial unique
  // index is predicated on, so the capacity slot frees at the database.
  await tx.commitment.update({
    where: { commitmentId: commitment.commitmentId },
    data: { releasedAt: storeTime, version: commitment.version + 1 },
  });

  // Invariant I6's persisted high-water mark, in the same transaction as the counter —
  // the arrangement Phase 3 established and every later fence writer preserves.
  await tx.agentFenceAudit.upsert({
    where: { agentId: agent.id },
    create: {
      agentId: agent.id,
      fenceHighWater: recallFence,
      epochHighWater: BigInt(agent.authorityEpoch),
      lastFenceSource: commitment.commitmentId,
      observedAt: storeTime,
    },
    update: {
      fenceHighWater: recallFence,
      epochHighWater: BigInt(agent.authorityEpoch),
      lastFenceSource: commitment.commitmentId,
      observedAt: storeTime,
    },
  });

  // §4.5 — the Leg has entered REASSIGNING, so its deadline is registered here.
  await timers.cancelFor(tx, {
    entityType: timers.ENTITY_TYPE.LEG,
    entityId: leg.id,
    storeTime,
    reason: `EXITED_${leg.state}`,
  });
  await timers.register(tx, {
    entityType: timers.ENTITY_TYPE.LEG,
    entityId: leg.id,
    state: legMachine.LEG_STATE.REASSIGNING,
    entity: { ...leg, version: leg.version + 1 },
    dueAt: timers.deadlineFrom(storeTime, source.reassignBudgetSeconds),
    armedSeconds: source.reassignBudgetSeconds,
    handler: legMachine.deadlineFor(legMachine.LEG_STATE.REASSIGNING).onExpiry,
    payload: { trigger: source.trigger, supersededCommitment: commitment.commitmentId, ...options.timerPayload },
    shardId: source.shardId,
  });

  return { ok: true, recallFence, recallOutboxId: recallRow.id };
}

/**
 * §4.7 step 4's "time already lost" — from the moment the incumbent was granted the
 * commitment to now.
 *
 * Measured from the grant rather than from the Leg's creation, because the Leg's earlier
 * queue time is already carried by its own aging (§8.7); counting it twice would credit
 * the Leg for waiting that the incumbent did not cause.
 *
 * @param {object} commitment
 * @param {Date} storeTime
 * @returns {number}
 */
function agingCreditSeconds(commitment, storeTime) {
  const grantedAt = commitment.grantedAt instanceof Date ? commitment.grantedAt : new Date(commitment.grantedAt);
  return Math.max(0, (storeTime.getTime() - grantedAt.getTime()) / MILLIS_PER_SECOND);
}

/**
 * §4.7's `TRANSFER` outcome — the transfer mission's specification.
 *
 * > A transfer mission is an ordinary Leg with `purpose = TRANSFER` (§2.4), a pickup Stop
 * > at the incumbent's position, and a `RequirementSet` derived from the goods already
 * > aboard — so it flows through the same optimiser with no special-case code path. Its
 * > priority inherits the original Task's SLA plus a configured recovery premium, because
 * > a stalled parcel is worse than an unstarted one.
 *
 * Returned as a specification rather than created here, because the `RequirementSet`
 * derivation is Phase 6's capability matching and the priority premium is Phase 8's
 * pricing. What this owns is the §4.7 gate: an agent-to-agent transfer is selected only
 * when a `custody_transfer_capable` receiver positively exists.
 *
 * @param {object} input
 * @param {object} input.leg
 * @param {{ lat: number, lon: number }} input.incumbentPosition
 * @param {boolean} input.transferCapableReceiverAvailable
 * @returns {{ permitted: boolean, mediation: string, specification: object|null, reason: string|null }}
 */
function transferMissionSpecification(input) {
  const source = input || {};

  if (source.transferCapableReceiverAvailable !== true) {
    return {
      permitted: false,
      // §4.7: "Where no `custody_transfer_capable` agent class is deployed, this outcome
      // is human-mediated by default and the engine MUST NOT select an agent-to-agent
      // transfer." Unknown is not permission.
      mediation: "HUMAN",
      specification: null,
      reason: "NO_CUSTODY_TRANSFER_CAPABLE_RECEIVER",
    };
  }

  return {
    permitted: true,
    mediation: "AGENT_TO_AGENT",
    reason: null,
    specification: {
      purpose: "TRANSFER",
      missionId: source.leg ? source.leg.missionId : null,
      pickupAt: source.incumbentPosition || null,
      requirementSetDerivedFrom: source.leg ? source.leg.id : null,
      // The three properties the purpose carries, listed so a reader can see they are
      // consequences of `purpose` and not separate flags (§4.7).
      exemptFromCancellationGuard: true,
      preemptible: false,
      sheddable: false,
      ownedBy: "Phase 6 (RequirementSet derivation) and Phase 8 (recovery premium)",
    },
  };
}

/** @structural milliseconds per second — a unit conversion, not a threshold */
const MILLIS_PER_SECOND = 1000;

module.exports = {
  OUTCOME,
  TRIGGER,
  chainLength,
  assessChainBound,
  chainExceedsBound,
  reassign,
  agingCreditSeconds,
  transferMissionSpecification,
};
