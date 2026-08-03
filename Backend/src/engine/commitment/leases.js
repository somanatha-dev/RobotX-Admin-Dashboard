"use strict";

/**
 * The lease, granted at commit (§12.2).
 *
 * > Each HARD commitment holds a lease with expiry `now + lease.duration` (default
 * > 60 s), renewed by the Supervisor while progress evidence continues to arrive.
 * > **Leases are per commitment**, so an agent holding several commitments renews each
 * > one on its own evidence; a heartbeat naming one mission does not renew the lease of
 * > another.
 *
 * ── Scope of this module ────────────────────────────────────────────────────
 * Phase 3 owns the **grant**: computing the expiry from the store's clock inside the
 * commit transaction, and judging validity against that same clock. Renewal, expiry
 * detection, and the custody-aware recovery assessment that expiry triggers are
 * Phase 5's `supervision/leases.js` — a different module with a different tier entry
 * (T0-08), sequenced after the durable timers exist to drive them.
 *
 * The one rule Phase 3 states here rather than deferring is what renewal *evidence*
 * must be, because it constrains the shape of the lease and would otherwise be
 * discovered late:
 *
 * > Renewal requires *positive evidence*: a heartbeat that includes the commitment id
 * > and its fence. A generic connectivity ping is insufficient — it proves the link,
 * > not the mission.
 *
 * ── Why the expiry is absolute and store-sourced ────────────────────────────
 * §10.6: "All deadlines are stored as absolute timestamps from the Commitment Store's
 * clock, which is the single authority for lease validity." A duration stored instead
 * of an instant would have to be added to *something* at read time, and every reader
 * would choose its own something.
 *
 * Tier 0 (T0-05 at grant; T0-08 owns renewal). Invariant I2.
 */

const clock = require("./clock");

/**
 * Grant a lease: `store_now + lease.duration`.
 *
 * @param {object} input
 * @param {Date} input.storeTime the transaction's timestamp, from `clock.readStoreTime`
 * @param {number} input.leaseDurationSeconds `lease.duration`, resolved for the agent class
 * @returns {{ grantedAt: Date, expiresAt: Date, durationSeconds: number }}
 */
function grant(input) {
  const settings = input || {};
  const { storeTime, leaseDurationSeconds } = settings;

  if (!Number.isFinite(leaseDurationSeconds) || leaseDurationSeconds <= 0) {
    throw new RangeError(
      `lease.duration resolved to ${String(leaseDurationSeconds)}; a commitment without a positive lease is an ` +
        "unsupervised commitment (§12.2, invariant I2)",
    );
  }

  return {
    grantedAt: storeTime,
    expiresAt: clock.deadlineFrom(storeTime, leaseDurationSeconds),
    durationSeconds: leaseDurationSeconds,
  };
}

/**
 * Is this commitment's lease still valid, judged against the store's clock?
 *
 * @param {{ leaseExpiry: Date|string|null }} commitment
 * @param {Date} storeTime
 * @returns {boolean}
 */
function isValidAt(commitment, storeTime) {
  if (!commitment) return false;
  return !clock.hasPassed(commitment.leaseExpiry, storeTime);
}

/**
 * §12.2 — is this evidence sufficient to renew *this* commitment's lease?
 *
 * > A generic connectivity ping is insufficient — it proves the link, not the mission.
 *
 * Stated in Phase 3 as a predicate so that the rule has one definition; Phase 5's
 * Supervisor is what calls it on a renewal path. Both the commitment id **and** its
 * fence are required: an id alone would let evidence generated under a superseded
 * authority renew the lease of the commitment that superseded it.
 *
 * @param {{ commitmentId: string, fence: bigint|number|string }} commitment
 * @param {{ commitmentId?: string, fence?: bigint|number|string }} evidence
 * @returns {{ sufficient: boolean, reason: string|null }}
 */
function isRenewalEvidenceSufficient(commitment, evidence) {
  if (!evidence || typeof evidence !== "object") {
    return { sufficient: false, reason: "NO_EVIDENCE" };
  }
  if (evidence.commitmentId !== commitment.commitmentId) {
    return { sufficient: false, reason: "EVIDENCE_NAMES_ANOTHER_COMMITMENT" };
  }
  if (evidence.fence === undefined || evidence.fence === null) {
    return { sufficient: false, reason: "EVIDENCE_CARRIES_NO_FENCE" };
  }
  if (BigInt(evidence.fence) !== BigInt(commitment.fence)) {
    return { sufficient: false, reason: "EVIDENCE_CARRIES_A_DIFFERENT_FENCE" };
  }
  return { sufficient: true, reason: null };
}

module.exports = {
  grant,
  isValidAt,
  isRenewalEvidenceSufficient,
};
