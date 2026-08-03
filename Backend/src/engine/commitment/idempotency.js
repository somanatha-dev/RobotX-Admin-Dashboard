"use strict";

/**
 * Idempotency (§10.5).
 *
 * > - Intake requests carry a client idempotency key; replays return the original
 * >   result rather than creating a second Task.
 * > - Commit is idempotent on `commitment_id`, which is derived deterministically from
 * >   `(leg_id, agent_id, decision_round_id)`. A retried commit either observes its own
 * >   prior commitment and succeeds, or fails its guards — never double-commits.
 * > - Every outbound **mission** command is idempotent on `(commitment_id,
 * >   command_sequence, fence)`. Every outbound **agent** command is idempotent on
 * >   `(agent_id, command_sequence, authority_epoch)`. **The two namespaces are
 * >   disjoint**, matching the two fence scopes of §10.3.1.
 *
 * The first bullet belongs to intake and lands with Phase 10. The second and third are
 * this module.
 *
 * ── Why the commitment id is derived, not minted ────────────────────────────
 * A generated id would make retry-safety a property of the caller's bookkeeping: the
 * caller would have to remember the id it used and reuse it, and a caller that forgot
 * would double-commit while believing it was retrying. Deriving the id from the three
 * facts that identify the decision makes retry-safety a property of the *identity*
 * instead, so a retry cannot fail to be a retry. It is also what lets the unique index
 * on `Commitment.commitmentId` be the enforcement, rather than a convention.
 *
 * ── Why the two namespaces must be provably disjoint ────────────────────────
 * They are keyed on different tuples and both keys are strings. If the two encodings
 * could collide, an agent-scope `QUARANTINE` and a mission-scope `RECALL` could
 * deduplicate against each other and one would be silently dropped — a command that
 * was issued, acknowledged as a duplicate, and never applied. `assertDisjoint` proves
 * they cannot, by construction and in a test, rather than by inspection of the format.
 *
 * Tier 0 (T0-05). Invariant I21's server half; the durable agent-side half is Phase 4.
 */

const crypto = require("crypto");

const fencing = require("./fencing");

const DIGEST_ALGORITHM = "sha256";

/** @structural the namespace prefix of a commitment identity */
const COMMITMENT_NAMESPACE = "commitment";

/** @structural the namespace prefix of the mission-command idempotency key (§10.3.1 row 1) */
const MISSION_COMMAND_NAMESPACE = "mission-command";

/** @structural the namespace prefix of the agent-command idempotency key (§10.3.1 row 2) */
const AGENT_COMMAND_NAMESPACE = "agent-command";

/** @structural the field separator; a character no id may contain */
const FIELD_SEPARATOR = " ";

/** @structural hex characters of the digest retained in a derived id */
const DIGEST_LENGTH = 32;

/**
 * Reject a component that could make two different tuples encode identically.
 *
 * @param {string} label
 * @param {unknown} value
 * @returns {string}
 */
function requireComponent(label, value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`idempotency key component "${label}" must be a non-empty string (§10.5)`);
  }
  if (value.includes(FIELD_SEPARATOR)) {
    throw new TypeError(`idempotency key component "${label}" contains the field separator; the encoding would be ambiguous`);
  }
  return value;
}

/**
 * §10.5 — the deterministic commitment id: `f(leg_id, agent_id, decision_round_id)`.
 *
 * @param {{ legId: string, agentId: string, decisionRoundId: string }} identity
 * @returns {string}
 */
function commitmentIdFor(identity) {
  const source = identity || {};
  const parts = [
    COMMITMENT_NAMESPACE,
    requireComponent("legId", source.legId),
    requireComponent("agentId", source.agentId),
    requireComponent("decisionRoundId", source.decisionRoundId),
  ];
  const digest = crypto.createHash(DIGEST_ALGORITHM).update(parts.join(FIELD_SEPARATOR)).digest("hex");
  return `${COMMITMENT_NAMESPACE}-${digest.slice(0, DIGEST_LENGTH)}`;
}

/**
 * The **mission**-command idempotency key: `(commitment_id, command_sequence, fence)`.
 *
 * @param {{ commitmentId: string, sequence: number, fence: bigint|number|string }} command
 * @returns {string}
 */
function missionCommandKey(command) {
  const source = command || {};
  requireComponent("commitmentId", source.commitmentId);
  if (!Number.isInteger(source.sequence) || source.sequence < 0) {
    throw new TypeError("a mission command's sequence is a non-negative integer (§10.5)");
  }
  if (source.fence === undefined || source.fence === null) {
    throw new TypeError("a mission command is keyed on its commitment fence (§10.5, §10.3.1)");
  }
  return [MISSION_COMMAND_NAMESPACE, source.commitmentId, String(source.sequence), String(BigInt(source.fence))].join(
    FIELD_SEPARATOR,
  );
}

/**
 * The **agent**-command idempotency key: `(agent_id, command_sequence, authority_epoch)`.
 *
 * @param {{ agentId: string, sequence: number, authorityEpoch: bigint|number|string }} command
 * @returns {string}
 */
function agentCommandKey(command) {
  const source = command || {};
  requireComponent("agentId", source.agentId);
  if (!Number.isInteger(source.sequence) || source.sequence < 0) {
    throw new TypeError("an agent command's sequence is a non-negative integer (§10.5)");
  }
  if (source.authorityEpoch === undefined || source.authorityEpoch === null) {
    throw new TypeError("an agent command is keyed on the agent's authority_epoch (§10.5, §10.3.1)");
  }
  return [AGENT_COMMAND_NAMESPACE, source.agentId, String(source.sequence), String(BigInt(source.authorityEpoch))].join(
    FIELD_SEPARATOR,
  );
}

/**
 * Route a command to its namespace's key, using the §10.3.1 scope table rather than a
 * second, parallel classification of the same commands.
 *
 * @param {{ command: string }} envelope the command name plus that namespace's fields
 * @returns {string|null} the key, or null for a query — which is side-effect-free and
 *   therefore has nothing to deduplicate
 */
function idempotencyKeyFor(envelope) {
  const scope = fencing.fenceScopeOf(envelope && envelope.command);
  if (scope === null) return null;
  return scope === fencing.FENCE_SCOPE.COMMITMENT ? missionCommandKey(envelope) : agentCommandKey(envelope);
}

/**
 * §10.5: "The two namespaces are disjoint."
 *
 * Proven rather than asserted: every key carries its namespace as its first field, and
 * the separator cannot appear inside a component, so a mission key and an agent key
 * can never be equal whatever their contents.
 *
 * @param {string} keyA
 * @param {string} keyB
 * @returns {boolean} whether the two keys belong to different namespaces
 */
function inDisjointNamespaces(keyA, keyB) {
  const namespaceOf = (key) => String(key).split(FIELD_SEPARATOR)[0];
  return namespaceOf(keyA) !== namespaceOf(keyB);
}

/**
 * Would a retried commit be recognised as the same commit?
 *
 * @param {object} existing the commitment already in the store, or null
 * @param {{ legId: string, agentId: string, decisionRoundId: string }} identity
 * @returns {boolean}
 */
function isSameCommitment(existing, identity) {
  if (!existing) return false;
  return existing.commitmentId === commitmentIdFor(identity);
}

module.exports = {
  COMMITMENT_NAMESPACE,
  MISSION_COMMAND_NAMESPACE,
  AGENT_COMMAND_NAMESPACE,
  FIELD_SEPARATOR,
  commitmentIdFor,
  missionCommandKey,
  agentCommandKey,
  idempotencyKeyFor,
  inDisjointNamespaces,
  isSameCommitment,
};
