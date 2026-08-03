"use strict";

/**
 * The commit guard set G1–G6 (§10.3.2 step 2).
 *
 * > Verify the guard set. **Every guard aborts the transaction on failure.**
 *
 * | # | Guard | Protects against |
 * |---|---|---|
 * | G1 | `shard.leadership_fence` equals the value read at round start | A coordinator whose lease expired mid-round committing on stale leadership (§19.5) |
 * | G2 | Agent's active HARD commitment count `< capacity[agent_class]` | Over-commitment |
 * | G3 | Agent's `authority_epoch` equals the decision snapshot's value | The agent having been quarantined, e-stopped, migrated, or stood down since the snapshot |
 * | G4 | Leg `version` equals the snapshot's | A concurrent modification of the Leg |
 * | G5 | `cancel_requested_at IS NULL` **OR** `leg.purpose ∈ custodial_purposes` | Committing cancelled work, while still permitting the recovery Legs that cancellation itself mandates (§4.6) |
 * | G6 | Leg state is the expected one | Committing from an unexpected state |
 *
 * ── Why each guard is a separate pure function ──────────────────────────────
 * The plan's testing requirement is that "each guard aborts on its own violation and
 * **only** its own". A guard set written as one conditional cannot satisfy that
 * requirement, and cannot be shown to: a test that violates G4 and observes an abort
 * learns nothing about *which* guard fired. Each is therefore its own function with
 * its own abort reason, and `evaluateGuards` runs all six and returns every failure
 * rather than short-circuiting — so a commit that violates two guards names both,
 * and a test that violates one can assert the other five passed.
 *
 * These functions perform no I/O. They are given rows that `commit.js` has already
 * read `FOR UPDATE` inside the transaction; reading them here would defeat the row
 * locks that make the read meaningful.
 *
 * Tier 0 (T0-05). Invariants I1, I5, I9, I11.
 */

const purpose = require("../domain/purpose");
const fencing = require("./fencing");

/**
 * The abort reasons, one per guard plus the non-guard aborts `commit.js` can return.
 * Recorded as data because §10.3.2 requires the cause to be recorded when the
 * pairing returns to the next round, and because these strings become decision-record
 * fields and SLI dimensions in Phase 11.
 * @structural abort-reason labels
 */
const ABORT_REASON = Object.freeze({
  G1_LEADERSHIP_FENCE_ADVANCED: "G1_LEADERSHIP_FENCE_ADVANCED",
  G2_AGENT_AT_CAPACITY: "G2_AGENT_AT_CAPACITY",
  G3_AUTHORITY_EPOCH_CHANGED: "G3_AUTHORITY_EPOCH_CHANGED",
  G4_LEG_VERSION_CHANGED: "G4_LEG_VERSION_CHANGED",
  G5_LEG_CANCELLED: "G5_LEG_CANCELLED",
  G6_UNEXPECTED_LEG_STATE: "G6_UNEXPECTED_LEG_STATE",
  VOLATILE_FEASIBILITY_LOST: "VOLATILE_FEASIBILITY_LOST",
  AGENT_NOT_FOUND: "AGENT_NOT_FOUND",
  LEG_NOT_FOUND: "LEG_NOT_FOUND",
  // PHASE 4 — the caller passed a *business* identifier (`Agent.agentId`, `Leg.legId`)
  // where the row's primary key was required. Distinguished from a plain "not found"
  // because the two need opposite responses: a genuinely missing row returns the
  // pairing to the next round, while this is a defect in the caller that no number of
  // rounds will fix. §2.1 gives an Agent both identifiers and the Commitment's foreign
  // keys reference the primary one.
  AGENT_ID_IS_A_BUSINESS_KEY: "AGENT_ID_IS_A_BUSINESS_KEY",
  LEG_ID_IS_A_BUSINESS_KEY: "LEG_ID_IS_A_BUSINESS_KEY",
  LEADERSHIP_RECORD_MISSING: "LEADERSHIP_RECORD_MISSING",
  CLOCK_SKEW_EXCEEDED: "CLOCK_SKEW_EXCEEDED",
  SERIALIZATION_FAILURE: "SERIALIZATION_FAILURE",
  CAPACITY_CONSTRAINT_VIOLATED: "CAPACITY_CONSTRAINT_VIOLATED",
});

/** The guard identifiers, in the order §10.3.2 tabulates them. */
const GUARD_IDS = Object.freeze(["G1", "G2", "G3", "G4", "G5", "G6"]);

/**
 * Build a guard verdict.
 *
 * @param {string} id
 * @param {boolean} satisfied
 * @param {string|null} reason
 * @param {string} [detail]
 * @returns {{ id: string, satisfied: boolean, reason: string|null, detail: string|null }}
 */
function verdict(id, satisfied, reason, detail) {
  return Object.freeze({ id, satisfied, reason: satisfied ? null : reason, detail: detail || null });
}

/**
 * **G1** — the leadership fence, re-read *inside* the transaction.
 *
 * > G1 is what makes leadership a **database-enforced** property rather than a
 * > coordinator's unverified belief about its own lease. The commit transaction takes
 * > row locks that can block for an unbounded duration under contention with the
 * > reconciliation loop, so a transaction that *begins* inside a valid leadership
 * > window can *commit* after that window has expired. Reading the leadership record
 * > inside the same transaction and aborting if the fence has advanced closes that
 * > window completely, at the cost of one indexed read.
 *
 * The comparison is equality, not `≥`. A coordinator whose fence is *lower* than the
 * store's has been superseded; one whose fence is *higher* is reading a snapshot the
 * store has never issued, which is a defect rather than a race.
 *
 * @param {{ leadershipFence: bigint|number|string }|null} leadership the row read in-transaction
 * @param {bigint|number|string} snapshotFence the value read at round start
 * @returns {object} verdict
 */
function g1LeadershipFence(leadership, snapshotFence) {
  if (!leadership || leadership.leadershipFence === undefined || leadership.leadershipFence === null) {
    return verdict(
      "G1",
      false,
      ABORT_REASON.LEADERSHIP_RECORD_MISSING,
      "no ShardLeadership row was read inside the transaction; leadership cannot be inferred from its absence (§4.1 rule 3)",
    );
  }
  if (snapshotFence === undefined || snapshotFence === null) {
    return verdict(
      "G1",
      false,
      ABORT_REASON.LEADERSHIP_RECORD_MISSING,
      "the round carries no pinned leadership fence; G1 has nothing to compare against (§19.5)",
    );
  }

  const current = BigInt(leadership.leadershipFence);
  const pinned = BigInt(snapshotFence);
  if (current === pinned) return verdict("G1", true, null);

  return verdict(
    "G1",
    false,
    ABORT_REASON.G1_LEADERSHIP_FENCE_ADVANCED,
    `shard leadership fence is ${current}, the round pinned ${pinned}; this coordinator no longer holds the shard (§19.5)`,
  );
}

/**
 * **G2** — the agent's active HARD commitment count is below its capacity.
 *
 * The count is of *active* commitments, which is `releasedAt IS NULL` — the same
 * predicate the partial unique index is built on, so the guard and the backstop
 * cannot disagree about what "active" means.
 *
 * @param {number} activeCommitmentCount
 * @param {number} capacity `capacity[agent_class]`, resolved from the round's config
 * @returns {object} verdict
 */
function g2Capacity(activeCommitmentCount, capacity) {
  if (!Number.isInteger(capacity) || capacity < 1) {
    return verdict(
      "G2",
      false,
      ABORT_REASON.G2_AGENT_AT_CAPACITY,
      `capacity resolved to ${String(capacity)}; capacity[agent_class] is a positive integer (Appendix A)`,
    );
  }
  if (activeCommitmentCount < capacity) return verdict("G2", true, null);
  return verdict(
    "G2",
    false,
    ABORT_REASON.G2_AGENT_AT_CAPACITY,
    `agent already holds ${activeCommitmentCount} active HARD commitment(s) against a capacity of ${capacity} (invariant I1)`,
  );
}

/**
 * **G3** — the agent's `authority_epoch` equals the decision snapshot's.
 *
 * > G3 uses the **agent-scope** epoch, not a per-commitment value, and this is
 * > deliberate: it is invariant across ordinary commits, so a coordinator may commit
 * > several Legs to one agent within one round without each commit invalidating the
 * > next one's snapshot. A guard on a per-commitment counter here would reproduce,
 * > inside the store, the same defect the fencing split removes at the agent.
 *
 * That property — several commits to one agent in one round, none invalidating the
 * others — is invariant I19, and it is checked directly in the model check.
 *
 * @param {{ authorityEpoch: bigint|number|string }} agent the row read FOR UPDATE
 * @param {bigint|number|string} snapshotAuthorityEpoch
 * @returns {object} verdict
 */
function g3AuthorityEpoch(agent, snapshotAuthorityEpoch) {
  if (!agent || agent.authorityEpoch === undefined || agent.authorityEpoch === null) {
    return verdict("G3", false, ABORT_REASON.AGENT_NOT_FOUND, "the agent row carries no authority_epoch (§2.6)");
  }
  if (snapshotAuthorityEpoch === undefined || snapshotAuthorityEpoch === null) {
    return verdict(
      "G3",
      false,
      ABORT_REASON.G3_AUTHORITY_EPOCH_CHANGED,
      "the decision snapshot recorded no authority_epoch for this agent; absence is not agreement (§4.1 rule 3)",
    );
  }

  const current = BigInt(agent.authorityEpoch);
  const pinned = BigInt(snapshotAuthorityEpoch);
  if (current === pinned) return verdict("G3", true, null);

  return verdict(
    "G3",
    false,
    ABORT_REASON.G3_AUTHORITY_EPOCH_CHANGED,
    `agent authority_epoch is ${current}, the decision was taken against ${pinned}; the agent has been quarantined, ` +
      "e-stopped, migrated, or stood down since (§10.3.1)",
  );
}

/**
 * **G4** — the Leg's optimistic-concurrency version equals the snapshot's.
 *
 * @param {{ version: number }} leg the row read FOR UPDATE
 * @param {number} snapshotVersion
 * @returns {object} verdict
 */
function g4LegVersion(leg, snapshotVersion) {
  if (!leg || leg.version === undefined || leg.version === null) {
    return verdict("G4", false, ABORT_REASON.LEG_NOT_FOUND, "the Leg row carries no version (§4.1 rule 2)");
  }
  if (snapshotVersion === undefined || snapshotVersion === null) {
    return verdict(
      "G4",
      false,
      ABORT_REASON.G4_LEG_VERSION_CHANGED,
      "the decision snapshot recorded no Leg version; every transition is a conditional write on it (§4.1 rule 2)",
    );
  }
  if (Number(leg.version) === Number(snapshotVersion)) return verdict("G4", true, null);

  return verdict(
    "G4",
    false,
    ABORT_REASON.G4_LEG_VERSION_CHANGED,
    `Leg version is ${leg.version}, the decision was taken against ${snapshotVersion}; the Leg was modified concurrently`,
  );
}

/**
 * **G5** — `cancel_requested_at IS NULL` **OR** `leg.purpose ∈ custodial_purposes`.
 *
 * The disjunction is the whole guard. §4.6:
 *
 * > Committing cancelled work, while still permitting the recovery Legs that
 * > cancellation itself mandates.
 *
 * The unqualified form — "refuse if cancellation was requested" — blocks its own
 * mandated recovery path, which is migration item C10 in the plan. `custodial_purposes`
 * is read from `domain/purpose.js`, which derives it from the §2.4 table rather than
 * restating it, so a seventh purpose cannot be custodial in one place and not another.
 *
 * @param {{ cancelRequestedAt?: Date|string|null, purpose: string }} leg
 * @returns {object} verdict
 */
function g5Cancellation(leg) {
  if (!leg) return verdict("G5", false, ABORT_REASON.LEG_NOT_FOUND, "no Leg row");
  const cancelRequested = leg.cancelRequestedAt !== undefined && leg.cancelRequestedAt !== null;
  if (!cancelRequested) return verdict("G5", true, null);

  // Throws on an unknown purpose rather than defaulting to permissive (T2).
  if (purpose.isCustodial(leg.purpose)) {
    return verdict("G5", true, null);
  }

  return verdict(
    "G5",
    false,
    ABORT_REASON.G5_LEG_CANCELLED,
    `cancellation was requested for this ${leg.purpose} Leg and its purpose is not custodial; ` +
      `custodial_purposes = {${purpose.CUSTODIAL_PURPOSES.join(", ")}} (§4.6, invariant I11)`,
  );
}

/**
 * **G6** — the Leg is in the state the decision expected.
 *
 * @param {{ state: string }} leg
 * @param {string|string[]} expectedState the state, or the admissible set, the
 *   decision was taken against
 * @returns {object} verdict
 */
function g6LegState(leg, expectedState) {
  if (!leg || leg.state === undefined || leg.state === null) {
    return verdict("G6", false, ABORT_REASON.LEG_NOT_FOUND, "the Leg row carries no state (§4.3)");
  }
  const expected = Array.isArray(expectedState) ? expectedState : [expectedState];
  if (expected.length === 0 || expected.some((state) => state === undefined || state === null)) {
    return verdict(
      "G6",
      false,
      ABORT_REASON.G6_UNEXPECTED_LEG_STATE,
      "the decision declared no expected Leg state; committing from an unstated state is committing from an unexpected one",
    );
  }
  if (expected.includes(leg.state)) return verdict("G6", true, null);

  return verdict(
    "G6",
    false,
    ABORT_REASON.G6_UNEXPECTED_LEG_STATE,
    `Leg is in state ${leg.state}; the decision expected ${expected.join(" or ")} (§4.3)`,
  );
}

/**
 * Run all six guards and return every verdict.
 *
 * Deliberately does not short-circuit. Two reasons, both operational: a commit that
 * violates two guards should name both in its decision record rather than only the
 * first one evaluated, and a test asserting "G4 aborts on its own violation and only
 * its own" needs the other five verdicts to make the second half of that claim.
 *
 * @param {object} input
 * @param {object|null} input.leadership the `ShardLeadership` row read in-transaction
 * @param {object} input.agent the `Agent` row read `FOR UPDATE`
 * @param {object} input.leg the `Leg` row read `FOR UPDATE`
 * @param {number} input.activeCommitmentCount active HARD commitments on the agent
 * @param {number} input.capacity `capacity[agent_class]`
 * @param {object} input.snapshot the decision snapshot's pinned values
 * @returns {{ ok: boolean, verdicts: object[], failures: object[] }}
 */
function evaluateGuards(input) {
  const snapshot = input.snapshot || {};
  const verdicts = [
    g1LeadershipFence(input.leadership, snapshot.leadershipFence),
    g2Capacity(input.activeCommitmentCount, input.capacity),
    g3AuthorityEpoch(input.agent, snapshot.authorityEpoch),
    g4LegVersion(input.leg, snapshot.legVersion),
    g5Cancellation(input.leg),
    g6LegState(input.leg, snapshot.expectedLegState),
  ];
  const failures = verdicts.filter((entry) => !entry.satisfied);
  return { ok: failures.length === 0, verdicts, failures };
}

/**
 * The fencing rule G3 relies on, stated so a reader of the guards can see it without
 * leaving the file: an ordinary commit never advances `authority_epoch`, which is
 * exactly why G3 can guard on it across several commits in one round (I19).
 *
 * @param {object} before the agent row before the commit
 * @param {object} after the agent row after the commit
 * @returns {boolean}
 */
function authorityEpochUntouched(before, after) {
  return BigInt(before.authorityEpoch) === BigInt(after.authorityEpoch);
}

module.exports = {
  ABORT_REASON,
  GUARD_IDS,
  FENCE_SCOPE: fencing.FENCE_SCOPE,
  g1LeadershipFence,
  g2Capacity,
  g3AuthorityEpoch,
  g4LegVersion,
  g5Cancellation,
  g6LegState,
  evaluateGuards,
  authorityEpochUntouched,
};
