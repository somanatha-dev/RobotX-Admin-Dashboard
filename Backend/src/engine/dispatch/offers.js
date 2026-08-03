"use strict";

/**
 * Offer semantics (§11.2) — the agent may refuse.
 *
 * > Dispatch is an **offer**, and the agent MUST respond. This is the second
 * > structural gap: the baseline has no `TASK_REJECT` event, so an agent cannot
 * > decline, and the one deferral it can perform — holding an assignment while
 * > charging — is invisible to the server, leaving the task `ASSIGNED` for up to half
 * > an hour with no signal, timeout, or alert.
 *
 * The four dispositions, each implemented below as one transaction:
 *
 * | Response | Engine action |
 * |---|---|
 * | `ACCEPT` | Commitment becomes HARD; Leg → `ACCEPTED`; lease renewed |
 * | `REJECT(reason)` | Commitment released; Leg → `QUEUED`; agent excluded for `dispatch.nack_cooloff`; reason recorded as a **feasibility observation** |
 * | `DEFER(until, reason)` | HARD commitment released; Leg returns to `PLANNED` with a start-not-before constraint |
 * | (no response) | Offer TTL expires: withdraw at an **advanced** commitment fence, release, exclude, re-plan |
 *
 * ── Why REJECT releases rather than retries ─────────────────────────────────
 * > **A `REJECT` is an important safety signal, not merely a scheduling event.** The
 * > agent is the authority on its own physical condition, and it may know something
 * > the server does not.
 *
 * The rejection is therefore recorded as an observation to be reconciled against the
 * server's model — "if an agent rejects for low energy while the server believed it
 * feasible, that is a discrepancy between the server's energy model and the agent's —
 * a calibration defect worth alerting on" — rather than as a transient failure to
 * retry against the same agent.
 *
 * ── Why DEFER releases rather than holds ────────────────────────────────────
 * > Releasing rather than holding is what keeps the agent's capacity accounted
 * > correctly while it is not actually working (§2.6).
 *
 * A held commitment on a charging agent consumes a capacity slot that the shard's
 * sizing derivation (§3.5) assumes is doing work.
 *
 * ── The withdrawal fence is *advanced*, deliberately ────────────────────────
 * §11.4 step 2 says "withdraw offer at an advanced commitment fence". Re-sending the
 * withdrawal at the offer's own fence would leave it equal to the highest the agent
 * has seen for that commitment, and §10.3.1's mission rule rejects at `≤` — so the
 * withdrawal would be rejected by the very agent it is addressed to. Advancing the
 * agent's `fence_counter` and carrying the new value is what makes the withdrawal
 * *supersede* the offer instead of tying with it.
 *
 * ── What this module does not do ────────────────────────────────────────────
 * It does not run the §4.4 transition table (Phase 5's `lifecycle/transitions.js`) and
 * does not decide *which* agent is offered a Leg (Phase 10's round). Every Leg write
 * here is a conditional write on the Leg's own version (§4.1 rule 2), which is the
 * property Phase 5's machine will preserve when it takes ownership of the transitions.
 *
 * Tier 0 (T0-09). Invariants I1, I5, I19, I21.
 */

const clock = require("../commitment/clock");
const fencing = require("../commitment/fencing");
const leases = require("../commitment/leases");
const commandSigning = require("../security/commandSigning");
const outbox = require("./outbox");
const sequence = require("./sequence");

/** §11.2's response set. @structural the enumerated agent responses to an offer */
const OFFER_RESPONSE = Object.freeze({
  ACCEPT: "ACCEPT",
  REJECT: "REJECT",
  DEFER: "DEFER",
});

/**
 * The §4.3 Leg states each disposition lands on. Named here so the four transitions
 * §11.2 tabulates are readable as a set rather than scattered through the functions.
 * @structural the §11.2 → §4.3 state mapping
 */
const LEG_STATE = Object.freeze({
  OFFERED: "OFFERED",
  ACCEPTED: "ACCEPTED",
  QUEUED: "QUEUED",
  PLANNED: "PLANNED",
});

/** The outcome kinds a disposition can produce. @structural outcome labels */
const OUTCOME = Object.freeze({
  APPLIED: "APPLIED",
  IGNORED: "IGNORED",
  REFUSED: "REFUSED",
});

/**
 * §11.2's offer content, in full:
 *
 * > commitment id, commitment fence, mission plan, stop sequence with time windows,
 * > route reference, payload manifest, requirement acknowledgements, energy reserve
 * > parameters and target SoC (§14.6), offer expiry, and a signature (§23.3).
 *
 * `energyReserveParams` and `targetSoc` are **pass-through**: the execution plan
 * assigns them to Phase 7 ("Offer payload gains `energyReserveParams` and `targetSoc`"),
 * and §14.6 makes target SoC an input the engine consumes and never computes. They are
 * present in the shape from the start so that Phase 7 fills a declared field rather
 * than widening a wire contract that firmware has already implemented.
 *
 * @param {object} input
 * @returns {object} the offer payload
 */
function buildOfferPayload(input) {
  const source = input || {};

  if (typeof source.commitmentId !== "string" || source.commitmentId === "") {
    throw new TypeError("an offer names the commitment it offers (§11.2)");
  }
  if (source.fence === undefined || source.fence === null) {
    throw new TypeError("an offer carries its commitment's fence; the agent compares it per commitment id (§10.3.1)");
  }
  if (!(source.offerExpiry instanceof Date) || Number.isNaN(source.offerExpiry.getTime())) {
    throw new TypeError(
      "an offer carries an expiry. Without one, an agent that never answers leaves the Leg committed with no " +
        "signal, timeout, or alert — the exact defect §11.2 names (§11.4 step 2)",
    );
  }

  return {
    commitmentId: source.commitmentId,
    fence: String(BigInt(source.fence)),
    legId: source.legId === undefined ? null : source.legId,
    missionPlan: source.missionPlan === undefined ? null : source.missionPlan,
    stopSequence: Array.isArray(source.stopSequence) ? source.stopSequence : [],
    routeReference: source.routeReference === undefined ? null : source.routeReference,
    payloadManifest: source.payloadManifest === undefined ? null : source.payloadManifest,
    requirementAcknowledgements: Array.isArray(source.requirementAcknowledgements)
      ? source.requirementAcknowledgements
      : [],
    // §14.6 — supplied by the Charging Scheduler through Phase 7; never computed here.
    energyReserveParams: source.energyReserveParams === undefined ? null : source.energyReserveParams,
    targetSoc: source.targetSoc === undefined ? null : source.targetSoc,
    offerExpiry: source.offerExpiry.toISOString(),
  };
}

/**
 * The signed envelope for any mission command, ready for `outbox.buildRow`.
 *
 * @param {object} input
 * @param {string|Buffer} signingKey
 * @returns {object}
 */
function signMissionCommand(input, signingKey) {
  const envelope = {
    agentId: input.agentId,
    command: input.command,
    commandClass: fencing.commandClassOf(input.command),
    fenceScope: fencing.fenceScopeOf(input.command),
    commitmentId: input.commitmentId,
    fence: BigInt(input.fence),
    authorityEpoch: null,
    fenceFloor: null,
    sequence: input.sequence,
    notValidAfter: input.notValidAfter,
    payload: input.payload,
  };
  return { ...envelope, signature: commandSigning.sign(envelope, signingKey) };
}

/**
 * Enqueue an `OFFER` for a commitment — the step 5 of §10.3.2 that Phase 3 left as a
 * seam.
 *
 * Called **inside** the commit transaction. Every argument it needs is available
 * there: the commitment was just inserted, its fence was just allocated, and the Leg
 * row is locked.
 *
 * @param {object} tx a transaction client
 * @param {object} input
 * @param {object} input.commitment the row `commit.js` just created
 * @param {Date} input.storeTime
 * @param {number} input.offerTtlSeconds `dispatch.offer_ttl`
 * @param {object} input.offer the §11.2 content fields
 * @param {string|Buffer} input.signingKey
 * @returns {Promise<object>} the persisted outbox row
 */
async function enqueueOffer(tx, input) {
  const settings = input || {};
  const commitment = settings.commitment;

  if (!commitment || typeof commitment.commitmentId !== "string") {
    throw new TypeError("enqueueOffer takes the commitment the authorising transaction just created (§10.3.2 step 5)");
  }

  const offerExpiry = clock.deadlineFrom(settings.storeTime, settings.offerTtlSeconds);

  const payload = buildOfferPayload({
    ...(settings.offer || {}),
    commitmentId: commitment.commitmentId,
    fence: commitment.fence,
    legId: commitment.legId,
    offerExpiry,
  });

  const allocated = await sequence.allocate(tx, {
    command: "OFFER",
    commitmentId: commitment.commitmentId,
  });

  const signed = signMissionCommand(
    {
      agentId: commitment.agentId,
      command: "OFFER",
      commitmentId: commitment.commitmentId,
      fence: commitment.fence,
      sequence: allocated,
      // §23.3 — an offer that surfaces after its own TTL must not be executed, so the
      // envelope's validity and the offer's validity are the same instant. A longer
      // `not_valid_after` would let the transport deliver an offer the engine has
      // already withdrawn.
      notValidAfter: offerExpiry,
      payload,
    },
    settings.signingKey,
  );

  return outbox.enqueue(
    tx,
    outbox.buildRow({
      command: "OFFER",
      agentId: commitment.agentId,
      commitmentId: commitment.commitmentId,
      fence: commitment.fence,
      sequence: allocated,
      payload,
      notValidAfter: offerExpiry,
      signature: signed.signature,
    }),
  );
}

/**
 * Locate the commitment an agent's response names, and refuse a response that does not
 * match the offer the engine actually made.
 *
 * A response carrying a stale fence is not an error to be logged and ignored: it is an
 * agent answering an offer that has since been superseded, and applying it would undo
 * the supersession.
 *
 * @param {object} tx
 * @param {{ commitmentId: string, fence: bigint|number|string, agentId: string }} response
 * @returns {Promise<{ ok: boolean, reason: string|null, commitment: object|null }>}
 */
async function matchResponse(tx, response) {
  const source = response || {};
  if (typeof source.commitmentId !== "string" || source.commitmentId === "") {
    return { ok: false, reason: "RESPONSE_WITHOUT_COMMITMENT_ID", commitment: null };
  }

  const commitment = await tx.commitment.findUnique({ where: { commitmentId: source.commitmentId } });
  if (!commitment) return { ok: false, reason: "UNKNOWN_COMMITMENT", commitment: null };
  if (commitment.agentId !== source.agentId) {
    return { ok: false, reason: "RESPONSE_FROM_ANOTHER_AGENT", commitment: null };
  }
  if (commitment.releasedAt !== null && commitment.releasedAt !== undefined) {
    return { ok: false, reason: "COMMITMENT_ALREADY_RELEASED", commitment };
  }
  if (source.fence === undefined || source.fence === null) {
    return { ok: false, reason: "RESPONSE_WITHOUT_FENCE", commitment };
  }
  if (BigInt(source.fence) !== BigInt(commitment.fence)) {
    return { ok: false, reason: "RESPONSE_CARRIES_A_SUPERSEDED_FENCE", commitment };
  }

  return { ok: true, reason: null, commitment };
}

/**
 * A conditional Leg write (§4.1 rule 2). Returns the row count so the caller can treat
 * a miss as a lost race rather than as success.
 *
 * @param {object} tx
 * @param {{ legId: string, expectedVersion: number, state: string, extra?: object }} update
 * @returns {Promise<number>}
 */
async function writeLegState(tx, update) {
  const result = await tx.leg.updateMany({
    where: { id: update.legId, version: update.expectedVersion },
    data: { state: update.state, version: update.expectedVersion + 1, ...(update.extra || {}) },
  });
  return result.count;
}

/**
 * `ACCEPT` — *"Plan received, validated locally, and accepted. Commitment becomes
 * HARD; Leg → `ACCEPTED`; lease renewed."*
 *
 * The commitment is already HARD (§2.6 admits no other kind into the store), so what
 * ACCEPT changes is the Leg and the lease. The lease renewal is guarded by §12.2's
 * evidence rule, which Phase 3 stated once: the response must name **this** commitment
 * and carry **its** fence. A generic acknowledgement renews nothing.
 *
 * @param {object} tx a transaction client
 * @param {object} input
 * @param {object} input.commitment
 * @param {object} input.leg
 * @param {Date} input.storeTime
 * @param {number} input.leaseDurationSeconds `lease.duration`
 * @param {{ commitmentId: string, fence: bigint|number|string }} input.evidence
 * @returns {Promise<object>}
 */
async function applyAccept(tx, input) {
  const settings = input || {};
  const { commitment, leg, storeTime } = settings;

  const sufficient = leases.isRenewalEvidenceSufficient(commitment, settings.evidence);
  if (!sufficient.sufficient) {
    return { outcome: OUTCOME.REFUSED, reason: sufficient.reason, detail: "§12.2 requires commitment-scoped positive evidence" };
  }

  const renewed = leases.grant({ storeTime, leaseDurationSeconds: settings.leaseDurationSeconds });

  const count = await writeLegState(tx, {
    legId: leg.id,
    expectedVersion: leg.version,
    state: LEG_STATE.ACCEPTED,
  });
  if (count !== 1) {
    return { outcome: OUTCOME.IGNORED, reason: "LEG_VERSION_MOVED", detail: null };
  }

  await tx.commitment.update({
    where: { commitmentId: commitment.commitmentId },
    data: { leaseExpiry: renewed.expiresAt, version: commitment.version + 1 },
  });

  return { outcome: OUTCOME.APPLIED, reason: null, legState: LEG_STATE.ACCEPTED, leaseExpiry: renewed.expiresAt };
}

/**
 * Release a commitment: the shared half of REJECT, DEFER, and withdrawal.
 *
 * Releasing sets `releasedAt`, which is the predicate the §10.3.2 partial unique index
 * is built on — so the agent's capacity slot becomes free at the database, not merely
 * in the application's opinion of its own state.
 *
 * @param {object} tx
 * @param {object} commitment
 * @param {Date} storeTime
 * @returns {Promise<void>}
 */
async function releaseCommitment(tx, commitment, storeTime) {
  await tx.commitment.update({
    where: { commitmentId: commitment.commitmentId },
    data: { releasedAt: storeTime, version: commitment.version + 1 },
  });
}

/**
 * `REJECT(reason)` — *"Locally infeasible or refused."*
 *
 * The exclusion is expressed as an absolute instant (`storeTime + nack_cooloff`)
 * returned to the caller rather than written to a table: the availability index that
 * consumes it is Phase 9's, and the round that must respect it is Phase 10's. Writing
 * it somewhere neither of them reads would be a record nobody honours.
 *
 * @param {object} tx
 * @param {object} input
 * @returns {Promise<object>}
 */
async function applyReject(tx, input) {
  const settings = input || {};
  const { commitment, leg, storeTime } = settings;

  const count = await writeLegState(tx, {
    legId: leg.id,
    expectedVersion: leg.version,
    state: LEG_STATE.QUEUED,
  });
  if (count !== 1) {
    return { outcome: OUTCOME.IGNORED, reason: "LEG_VERSION_MOVED", detail: null };
  }

  await releaseCommitment(tx, commitment, storeTime);

  return {
    outcome: OUTCOME.APPLIED,
    reason: null,
    legState: LEG_STATE.QUEUED,
    // §11.2 — "reason recorded as a feasibility observation and reconciled against the
    // server's view". The observation itself is §2.7's append-only record, written by
    // the caller which holds the agent's domain row; what this returns is the tuple it
    // must record, so the rejection cannot be reduced to a log line.
    feasibilityObservation: {
      kind: "offer_rejection",
      agentId: commitment.agentId,
      commitmentId: commitment.commitmentId,
      reason: settings.reason || "UNSPECIFIED",
      observedAt: storeTime,
    },
    excludeAgentUntil: clock.deadlineFrom(storeTime, settings.nackCooloffSeconds),
  };
}

/**
 * `DEFER(until, reason)` — *"Cannot start now but can later."*
 *
 * > The HARD commitment is released and the Leg returns to `PLANNED` as a SOFT
 * > reservation carrying a start-not-before constraint, then is re-optimised next
 * > round against alternatives — so the deferral becomes a priced trade rather than an
 * > invisible wait.
 *
 * Phase 4 writes the durable half: the release and `Leg.startNotBefore`. The SOFT
 * reservation itself is round-local coordinator memory (§2.6, invariant I18) and is
 * Phase 10's; persisting one here would be exactly the write I18 forbids.
 *
 * @param {object} tx
 * @param {object} input
 * @returns {Promise<object>}
 */
async function applyDefer(tx, input) {
  const settings = input || {};
  const { commitment, leg, storeTime } = settings;

  const until = settings.until instanceof Date ? settings.until : new Date(settings.until);
  if (Number.isNaN(until.getTime())) {
    return { outcome: OUTCOME.REFUSED, reason: "DEFER_WITHOUT_START_NOT_BEFORE", detail: null };
  }
  if (until.getTime() <= storeTime.getTime()) {
    // A deferral to the past is a rejection wearing a deferral's name; treating it as
    // a deferral would put the Leg straight back into the next round against the same
    // agent, which is a livelock rather than a trade.
    return { outcome: OUTCOME.REFUSED, reason: "DEFER_UNTIL_IS_NOT_IN_THE_FUTURE", detail: null };
  }

  const count = await writeLegState(tx, {
    legId: leg.id,
    expectedVersion: leg.version,
    state: LEG_STATE.PLANNED,
    extra: { startNotBefore: until },
  });
  if (count !== 1) {
    return { outcome: OUTCOME.IGNORED, reason: "LEG_VERSION_MOVED", detail: null };
  }

  await releaseCommitment(tx, commitment, storeTime);

  return {
    outcome: OUTCOME.APPLIED,
    reason: null,
    legState: LEG_STATE.PLANNED,
    startNotBefore: until,
    deferReason: settings.reason || "UNSPECIFIED",
  };
}

/**
 * §11.4 step 2 — no ACK within `dispatch.offer_ttl`.
 *
 * > Withdraw offer at an **advanced commitment fence**, release the commitment, mark
 * > agent `dispatch_unresponsive`, re-plan the Leg excluding it.
 *
 * One transaction, because the fence advance and the `WITHDRAW` it authorises are
 * §4.1 rule 5's worked example: "A reconciler that bumps a fence and then separately
 * issues a recall can emit that recall before the bump commits, or after the bump has
 * been rolled back."
 *
 * The agent's `authority_epoch` is **not** touched: a single unanswered offer is a
 * mission-scope event, and advancing the agent scope would invalidate every other
 * commitment the agent holds (invariant I19).
 *
 * @param {object} tx a transaction client
 * @param {object} input
 * @returns {Promise<object>}
 */
async function withdrawExpiredOffer(tx, input) {
  const settings = input || {};
  const { commitment, agent, leg, storeTime } = settings;

  const withdrawalFence = fencing.allocateFence(agent.fenceCounter);
  if (!fencing.isStrictAdvance(agent.fenceCounter, withdrawalFence)) {
    throw new Error(`withdrawal fence did not advance the counter for agent ${agent.id} (invariant I6)`);
  }

  await tx.agent.update({ where: { id: agent.id }, data: { fenceCounter: withdrawalFence } });

  const notValidAfter = clock.deadlineFrom(storeTime, settings.maxDeliveryDelaySeconds);
  const payload = {
    commitmentId: commitment.commitmentId,
    supersedesFence: String(BigInt(commitment.fence)),
    reason: settings.reason || "OFFER_TTL_EXPIRED",
  };

  const allocated = await sequence.allocate(tx, { command: "WITHDRAW", commitmentId: commitment.commitmentId });

  const signed = signMissionCommand(
    {
      agentId: agent.id,
      command: "WITHDRAW",
      commitmentId: commitment.commitmentId,
      fence: withdrawalFence,
      sequence: allocated,
      notValidAfter,
      payload,
    },
    settings.signingKey,
  );

  const row = await outbox.enqueue(
    tx,
    outbox.buildRow({
      command: "WITHDRAW",
      agentId: agent.id,
      commitmentId: commitment.commitmentId,
      fence: withdrawalFence,
      sequence: allocated,
      payload,
      notValidAfter,
      signature: signed.signature,
    }),
  );

  const count = await writeLegState(tx, {
    legId: leg.id,
    expectedVersion: leg.version,
    state: LEG_STATE.QUEUED,
  });
  if (count !== 1) {
    // The Leg moved on under us — abort the whole transaction rather than leave a
    // withdrawal enqueued against a fence advance for a Leg somebody else is driving.
    throw new Error(
      `the conditional write on Leg ${leg.id} at version ${leg.version} matched ${count} rows during offer ` +
        "withdrawal; the fence advance and the WITHDRAW it authorises must roll back together (§4.1 rule 5)",
    );
  }

  await releaseCommitment(tx, commitment, storeTime);

  // Invariant I6's persisted high-water mark, advanced in the same transaction as the
  // counter — the arrangement Phase 3 established, preserved by every later writer of
  // a fence.
  await tx.agentFenceAudit.upsert({
    where: { agentId: agent.id },
    create: {
      agentId: agent.id,
      fenceHighWater: withdrawalFence,
      epochHighWater: BigInt(agent.authorityEpoch),
      lastFenceSource: commitment.commitmentId,
      observedAt: storeTime,
    },
    update: {
      fenceHighWater: withdrawalFence,
      epochHighWater: BigInt(agent.authorityEpoch),
      lastFenceSource: commitment.commitmentId,
      observedAt: storeTime,
    },
  });

  return {
    outcome: OUTCOME.APPLIED,
    reason: null,
    withdrawalFence,
    outboxRowId: row.id,
    legState: LEG_STATE.QUEUED,
    excludeAgentUntil: clock.deadlineFrom(storeTime, settings.nackCooloffSeconds),
  };
}

module.exports = {
  OFFER_RESPONSE,
  LEG_STATE,
  OUTCOME,
  buildOfferPayload,
  signMissionCommand,
  enqueueOffer,
  matchResponse,
  writeLegState,
  releaseCommitment,
  applyAccept,
  applyReject,
  applyDefer,
  withdrawExpiredOffer,
};
