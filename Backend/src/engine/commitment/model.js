"use strict";

/**
 * The Commitment (§2.6) — the durable contract binding an Agent to a Leg.
 *
 * > **Only HARD commitments exist in the Commitment Store.** A SOFT reservation is a
 * > different kind of object entirely, deliberately given a different name and a
 * > different home. There is no third case.
 *
 * This module is the single definition of what a Commitment *is*, so that
 * `commit.js`, the guards, the leases, and every later phase read the same shape
 * rather than re-deriving it from the Prisma model. It is deliberately pure: it
 * performs no I/O, holds no client, and reads no clock.
 *
 * ── Why `refuseSoftPersistence` exists ──────────────────────────────────────
 * Invariant I18 is backed by a CHECK constraint (Phase 2). The constraint is the
 * line of defence that cannot be bypassed; this function is the line of defence
 * that produces a *useful message* when a future call site tries, rather than a
 * bare constraint violation from Postgres with no §-reference. §10.3.2 asks for both
 * — "application logic and schema constraints are independent lines of defence" —
 * and it is the schema one that is authoritative.
 *
 * Tier 0 (T0-05). Owner: the commitment core.
 */

const custody = require("../domain/custody");

/**
 * §2.6 — the only kind of commitment that exists in the store.
 * @structural the sole admissible value of `Commitment.kind`
 */
const COMMITMENT_KIND = Object.freeze({ HARD: "HARD" });

/**
 * The name a SOFT reservation is given so that it can never be confused for a
 * commitment. §2.6 gives the two objects different names on purpose; conflating
 * them in code is how the durability rule would be quietly broken.
 * @structural label used only in refusal messages and assertions
 */
const SOFT_RESERVATION = "SOFT";

/**
 * The §2.6 field list, in the order the specification tabulates it. Used by the
 * schema cross-check test, so that a field dropped from the table fails a test
 * rather than silently disappearing from the contract.
 */
const COMMITMENT_FIELDS = Object.freeze([
  "commitmentId",
  "agentId",
  "legId",
  "fence",
  "leaseExpiry",
  "custodyState",
  "planSnapshotRef",
  "decisionRef",
  "version",
]);

/**
 * A commitment is **active** while it has not been released.
 *
 * Stated as a predicate over the row rather than as a status enum because the
 * durable form of "active" is `releasedAt IS NULL` — which is what the partial
 * unique index of §10.3.2 is predicated on. A second, derived notion of activity
 * would be a second source of truth for invariant I1.
 *
 * @param {{ releasedAt?: Date|string|null }} commitment
 * @returns {boolean}
 */
function isActive(commitment) {
  if (!commitment || typeof commitment !== "object") return false;
  return commitment.releasedAt === undefined || commitment.releasedAt === null;
}

/**
 * §2.6 / I18: a SOFT reservation MUST NOT reach the Commitment Store.
 *
 * @param {{ kind?: string }} record
 * @throws {Error} when anything other than a HARD commitment is offered for persistence
 */
function refuseSoftPersistence(record) {
  const kind = record && record.kind !== undefined && record.kind !== null ? String(record.kind) : COMMITMENT_KIND.HARD;
  if (kind === COMMITMENT_KIND.HARD) return;

  throw new Error(
    `a ${kind === SOFT_RESERVATION ? "SOFT reservation" : `commitment of kind "${kind}"`} was offered to the ` +
      "Commitment Store. Only HARD commitments are durable (§2.6, invariant I18): a SOFT reservation is " +
      "round-local coordinator state held in the leader's plan state, reconstructed on failover and never " +
      "recovered. Persisting one would put an entire optimisation loop inside the serialised, exactly-once " +
      "per-shard section and would invalidate the shard-sizing derivation of §3.5.",
  );
}

/**
 * Validate a commitment record's structure before it is written.
 *
 * Returns problems rather than throwing, so a caller can report every defect at
 * once; `commit.js` treats a non-empty result as a programming error and aborts.
 *
 * @param {object} commitment
 * @returns {string[]} problems, empty when well-formed
 */
function validateCommitment(commitment) {
  if (!commitment || typeof commitment !== "object") return ["commitment is not an object"];
  const problems = [];
  const id = typeof commitment.commitmentId === "string" ? commitment.commitmentId : "<unnamed>";

  for (const field of ["commitmentId", "agentId", "legId"]) {
    if (typeof commitment[field] !== "string" || commitment[field].length === 0) {
      problems.push(`commitment "${id}" has no ${field}`);
    }
  }

  if (commitment.kind !== undefined && commitment.kind !== null && String(commitment.kind) !== COMMITMENT_KIND.HARD) {
    problems.push(`commitment "${id}" has kind "${String(commitment.kind)}"; only HARD commitments are durable (§2.6, I18)`);
  }

  if (commitment.fence === undefined || commitment.fence === null) {
    problems.push(`commitment "${id}" carries no fence; §10.3 requires every commitment to carry its own fencing token`);
  } else {
    let fence;
    try {
      fence = BigInt(commitment.fence);
    } catch {
      fence = null;
      problems.push(`commitment "${id}" has a non-integral fence`);
    }
    if (fence !== null && fence <= BigInt(0)) {
      problems.push(`commitment "${id}" has fence ${fence}; fences are drawn from a monotone counter and start above zero`);
    }
  }

  if (!(commitment.leaseExpiry instanceof Date) || Number.isNaN(commitment.leaseExpiry.getTime())) {
    problems.push(
      `commitment "${id}" has no lease expiry; §12.2 requires an absolute expiry from the Commitment Store's clock`,
    );
  }

  if (commitment.custodyState !== undefined && commitment.custodyState !== null && !custody.isCustodyState(commitment.custodyState)) {
    problems.push(`commitment "${id}" carries custody state "${String(commitment.custodyState)}", which §2.5 does not define`);
  }

  if (commitment.capacitySlot === undefined || commitment.capacitySlot === null) {
    problems.push(`commitment "${id}" has no capacity slot; the §10.3.2 partial unique index is keyed on it`);
  } else if (!Number.isInteger(commitment.capacitySlot) || commitment.capacitySlot < 0) {
    problems.push(`commitment "${id}" has capacity slot ${String(commitment.capacitySlot)}; slots are non-negative integers`);
  }

  return problems;
}

/**
 * The lowest capacity slot not occupied by an active commitment on this agent.
 *
 * "Lowest free" rather than "count" is deliberate: the schema backstop is a unique
 * index on `(agentId, capacitySlot)`, so the writer must choose a slot, and choosing
 * deterministically means a retry of the same commit chooses the same slot. It also
 * means a released commitment's slot is reused rather than the agent drifting up
 * through slot numbers and colliding with the capacity bound while under capacity.
 *
 * @param {Array<{ capacitySlot?: number }>} activeCommitments
 * @param {number} capacity
 * @returns {number|null} the slot, or null when the agent is at capacity
 */
function lowestFreeSlot(activeCommitments, capacity) {
  const taken = new Set(
    (activeCommitments || []).map((commitment) => Number(commitment.capacitySlot)).filter(Number.isInteger),
  );
  for (let slot = 0; slot < capacity; slot += 1) {
    if (!taken.has(slot)) return slot;
  }
  return null;
}

module.exports = {
  COMMITMENT_KIND,
  SOFT_RESERVATION,
  COMMITMENT_FIELDS,
  isActive,
  refuseSoftPersistence,
  validateCommitment,
  lowestFreeSlot,
};
