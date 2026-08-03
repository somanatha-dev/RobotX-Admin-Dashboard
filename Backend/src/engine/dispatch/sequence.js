"use strict";

/**
 * Per-scope command ordering (§11.3).
 *
 * > **Ordered per agent.** Commands carry a per-commitment sequence; the agent applies
 * > them in order and ignores out-of-order duplicates. Reordering a `RECALL` before an
 * > `OFFER` would be a serious defect, so ordering is a protocol requirement rather
 * > than a transport hope.
 *
 * ── Two counters, not one ───────────────────────────────────────────────────
 * The sequence namespace follows the fence scope, because §10.5 keys the two
 * idempotency namespaces on different tuples:
 *
 * > Every outbound **mission** command is idempotent on `(commitment_id,
 * > command_sequence, fence)`. Every outbound **agent** command is idempotent on
 * > `(agent_id, command_sequence, authority_epoch)`. The two namespaces are disjoint.
 *
 * A single per-agent sequence shared by both would make the mission namespace's key
 * depend on how many *agent* commands happened to be issued in between — so a replay
 * of one commitment's command stream would not be reproducible from that commitment's
 * own record, and the disjointness §10.5 requires would be nominal only.
 *
 * ── Why a gap holds rather than skips ───────────────────────────────────────
 * "Applies them in order" has two possible readings when sequence *n+2* arrives and
 * *n+1* never did. Applying it anyway is the reading that permits `RECALL` before
 * `OFFER`, which the specification names as a serious defect; so a gap **holds** the
 * command, and at-least-once delivery is what eventually closes it — the missing row
 * is still in the outbox, still claimed, still retried. Holding is bounded by the
 * command's own `not_valid_after` (§23.3), so a hold cannot become a wait forever.
 *
 * This module is pure. It performs no I/O and reads no clock: the allocation queries
 * live in `outbox.js`'s caller, and the application rules are mirrored byte-for-byte
 * on the agent side by `VirtualRobot`, which is why they are stated once, here.
 *
 * Tier 0 (T0-09). Invariants I5, I21.
 */

const fencing = require("../commitment/fencing");

/** The first sequence in any namespace. @structural the ordering origin */
const FIRST_SEQUENCE = 0;

/**
 * What an agent does with a command, given what it has already applied.
 * @structural the enumerated dispositions of the ordering rule
 */
const ORDERING_DISPOSITION = Object.freeze({
  /** In order and unseen — apply it. */
  APPLY: "APPLY",
  /** Already applied. "Ignores out-of-order duplicates" (§11.3). */
  DUPLICATE: "DUPLICATE",
  /** A gap below it. Hold until the missing command is redelivered. */
  HELD_FOR_ORDER: "HELD_FOR_ORDER",
});

/**
 * The next sequence in a namespace, given the highest already allocated.
 *
 * @param {number|null|undefined} highestAllocated null when nothing has been allocated
 * @returns {number}
 */
function nextSequence(highestAllocated) {
  if (highestAllocated === undefined || highestAllocated === null) return FIRST_SEQUENCE;
  if (!Number.isInteger(highestAllocated) || highestAllocated < FIRST_SEQUENCE) {
    throw new RangeError(
      `the highest allocated sequence is ${String(highestAllocated)}; sequences are non-negative integers (§11.3)`,
    );
  }
  return highestAllocated + 1;
}

/**
 * Which namespace does this command's sequence belong to?
 *
 * Derived from `fencing.js`'s normative scope table rather than from a second,
 * parallel classification of the same commands — the failure mode §10.3.1 warns about
 * ("each implementing team chooses a scope per command and the incompatibility
 * surfaces only in integration testing, or in production") applies just as much to a
 * second copy inside one codebase.
 *
 * @param {string} command
 * @returns {{ scope: string, namespace: "commitment"|"agent" }}
 */
function namespaceOf(command) {
  const scope = fencing.fenceScopeOf(command);
  if (scope === null) {
    throw new Error(
      `"${command}" is a query (§10.3.1 row 3) and is never sequenced: queries are side-effect-free, so there is ` +
        "nothing whose order could matter and nothing to deduplicate",
    );
  }
  return {
    scope,
    namespace: scope === fencing.FENCE_SCOPE.COMMITMENT ? "commitment" : "agent",
  };
}

/**
 * Allocate the next sequence for a command, inside the caller's transaction.
 *
 * Reads the highest sequence already written in the same namespace. Under the commit
 * transaction's row locks (§10.3.2 step 1) this is a stable read; a caller writing an
 * agent-scope command outside that transaction takes the same discipline — §4.1 rule 5
 * requires it to be inside *some* authorising transaction, and the unique index on
 * `idempotencyKey` is the backstop if two allocations ever raced.
 *
 * @param {object} tx a transaction client
 * @param {{ command: string, commitmentId?: string, agentId?: string }} target
 * @returns {Promise<number>}
 */
async function allocate(tx, target) {
  const source = target || {};
  const { namespace } = namespaceOf(source.command);

  const where =
    namespace === "commitment"
      ? { commitmentId: source.commitmentId, commandClass: fencing.COMMAND_CLASS.MISSION }
      : { agentId: source.agentId, commandClass: fencing.COMMAND_CLASS.AGENT };

  if (namespace === "commitment" && (typeof source.commitmentId !== "string" || source.commitmentId === "")) {
    throw new TypeError("a mission command's sequence is allocated per commitment id (§10.5)");
  }
  if (namespace === "agent" && (typeof source.agentId !== "string" || source.agentId === "")) {
    throw new TypeError("an agent command's sequence is allocated per agent id (§10.5)");
  }

  const rows = await tx.outbox.findMany({ where, orderBy: { sequence: "desc" }, take: 1 });
  return nextSequence(rows.length > 0 ? rows[0].sequence : null);
}

/**
 * The agent's application rule (§11.3), stated once here and mirrored by the agent.
 *
 * `highestApplied` is the highest sequence applied **in this command's own
 * namespace** — per commitment id for a mission command, per agent for an agent
 * command. Passing a maximum across namespaces would reintroduce, in the ordering
 * dimension, exactly the defect §10.3.1 removed in the fencing dimension.
 *
 * @param {{ sequence: number }} command
 * @param {number|null|undefined} highestApplied null when nothing has been applied
 * @returns {{ disposition: string, reason: string|null }}
 */
function disposition(command, highestApplied) {
  if (!command || !Number.isInteger(command.sequence) || command.sequence < FIRST_SEQUENCE) {
    return { disposition: ORDERING_DISPOSITION.HELD_FOR_ORDER, reason: "COMMAND_WITHOUT_VALID_SEQUENCE" };
  }

  const applied = highestApplied === undefined || highestApplied === null ? null : highestApplied;

  if (applied === null) {
    if (command.sequence === FIRST_SEQUENCE) return { disposition: ORDERING_DISPOSITION.APPLY, reason: null };
    return { disposition: ORDERING_DISPOSITION.HELD_FOR_ORDER, reason: "GAP_BEFORE_FIRST_SEQUENCE" };
  }

  if (command.sequence <= applied) {
    return { disposition: ORDERING_DISPOSITION.DUPLICATE, reason: "ALREADY_APPLIED" };
  }
  if (command.sequence === applied + 1) {
    return { disposition: ORDERING_DISPOSITION.APPLY, reason: null };
  }
  return { disposition: ORDERING_DISPOSITION.HELD_FOR_ORDER, reason: "GAP_IN_SEQUENCE" };
}

/**
 * The property §11.3 names explicitly, as a checkable predicate: could this stream be
 * applied in an order that puts a `RECALL` before the `OFFER` it recalls?
 *
 * Used by the test suite and by the agent-side conformance fixture. Returns the first
 * violation rather than a boolean, because "which pair" is the actionable part.
 *
 * @param {Array<{ command: string, sequence: number }>} appliedInOrder
 * @returns {{ ok: boolean, violation: object|null }}
 */
function checkApplicationOrder(appliedInOrder) {
  const stream = Array.isArray(appliedInOrder) ? appliedInOrder : [];
  let offerSequence = null;

  for (const entry of stream) {
    if (entry.command === "OFFER") {
      offerSequence = entry.sequence;
      continue;
    }
    if (offerSequence === null && SUPERSEDING_MISSION_COMMANDS.includes(entry.command)) {
      return {
        ok: false,
        violation: {
          command: entry.command,
          sequence: entry.sequence,
          reason: `${entry.command} was applied before the OFFER it supersedes (§11.3)`,
        },
      };
    }
  }

  return { ok: true, violation: null };
}

/**
 * The mission commands that only make sense against an offer the agent already holds.
 * Each supersedes or modifies an existing mission authority, so applying one with no
 * prior `OFFER` is the reordering §11.3 forbids.
 */
const SUPERSEDING_MISSION_COMMANDS = Object.freeze([
  "WITHDRAW",
  "REROUTE",
  "RESEQUENCE",
  "RECALL",
  "RESUME",
  "TRANSFER_CUSTODY",
  "ABORT_MISSION",
]);

module.exports = {
  FIRST_SEQUENCE,
  ORDERING_DISPOSITION,
  SUPERSEDING_MISSION_COMMANDS,
  nextSequence,
  namespaceOf,
  allocate,
  disposition,
  checkApplicationOrder,
};
