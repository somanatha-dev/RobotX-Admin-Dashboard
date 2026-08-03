"use strict";

/**
 * Two fencing scopes (§10.3.1), because there are two kinds of authority.
 *
 * > **Authority in this system is not a single thing.** Some commands assert
 * > authority over the *agent* — stand down entirely, enter quarantine, clear an
 * > e-stop, migrate to another shard. Others assert authority over *one mission* the
 * > agent is executing — reroute it, resequence it, recall it. An agent with
 * > `capacity[agent_class] > 1` executes several missions concurrently, so these two
 * > kinds of authority change independently and MUST be fenced independently.
 *
 * ── The defect this module exists to prevent ────────────────────────────────
 * §10.3.1 spells it out, and it is a steady-state failure rather than a corner case:
 *
 * > If commitment C1 is granted epoch 5 and C2 epoch 6 on the same agent, then a
 * > reroute or a cancellation for C1 carries epoch 5, is below the highest the agent
 * > has seen, and is rejected — C1 becomes uncommandable for the rest of its life.
 * > When C1 later settles and bumps the counter to 7, every subsequent command for C2
 * > carries 6 and is likewise rejected. **The fleet would seize after the second
 * > concurrent commitment on any agent.**
 *
 * The correction is not to the *allocation* of the numbers — both scopes draw from
 * one per-agent monotone counter, which is what preserves I6's total order and lets
 * the reconciler decide which of two observations is newer — but to their
 * **comparison**: per commitment id, not per agent.
 *
 * ── What lives here and what does not ───────────────────────────────────────
 * This module owns the *rules*: the normative command-class → scope table, fence
 * allocation, and the two rejection predicates including `fence_floor`. It performs
 * no I/O and reads no clock. The allocation is applied to the database by
 * `commit.js`; the rejection predicates are mirrored on the agent side by Phase 4
 * (`VirtualRobot`, `dispatch/dedupHandshake.js`), which is why they are stated once,
 * here, rather than twice.
 *
 * Tier 0 (T0-06). Invariants I5, I6, I19.
 */

const { FENCE_SCOPE } = require("../domain/agent");

/**
 * The normative command-class → fence-scope table of §10.3.1.
 *
 * > This mapping is normative. Without it, each implementing team chooses a scope
 * > per command and the incompatibility surfaces only in integration testing, or in
 * > production.
 *
 * Phase 4 delivers the wire protocol for these commands. The table is stated here,
 * in Phase 3, because it is the fencing rule — not the protocol — and because
 * `commit.js` needs it to know which scope the fence it allocates belongs to.
 */
const COMMAND_CLASS = Object.freeze({
  MISSION: "MISSION",
  AGENT: "AGENT",
  QUERY: "QUERY",
});

/** §10.3.1 row 1 — mission commands, fenced by the **commitment** scope. */
const MISSION_COMMANDS = Object.freeze([
  "OFFER",
  "WITHDRAW",
  "REROUTE",
  "RESEQUENCE",
  "RECALL",
  "RESUME",
  "TRANSFER_CUSTODY",
  "ABORT_MISSION",
]);

/** §10.3.1 row 2 — agent commands, fenced by the **agent** scope. */
const AGENT_COMMANDS = Object.freeze([
  "STAND_DOWN_ALL",
  "QUARANTINE",
  "RELEASE_QUARANTINE",
  "ESTOP_CLEAR",
  "SHARD_MIGRATE",
  "SESSION_REKEY",
  "PARAMETER_PUSH",
]);

/** §10.3.1 row 3 — queries. Side-effect-free: "Always answered; never fenced." */
const QUERY_COMMANDS = Object.freeze(["STATUS_REQUEST", "PROBE", "MANIFEST_QUERY"]);

const COMMAND_SCOPE = Object.freeze({
  ...Object.fromEntries(MISSION_COMMANDS.map((name) => [name, FENCE_SCOPE.COMMITMENT])),
  ...Object.fromEntries(AGENT_COMMANDS.map((name) => [name, FENCE_SCOPE.AGENT])),
  ...Object.fromEntries(QUERY_COMMANDS.map((name) => [name, null])),
});

const COMMAND_CLASS_OF = Object.freeze({
  ...Object.fromEntries(MISSION_COMMANDS.map((name) => [name, COMMAND_CLASS.MISSION])),
  ...Object.fromEntries(AGENT_COMMANDS.map((name) => [name, COMMAND_CLASS.AGENT])),
  ...Object.fromEntries(QUERY_COMMANDS.map((name) => [name, COMMAND_CLASS.QUERY])),
});

/**
 * Which fence scope guards this command?
 *
 * @param {string} command
 * @returns {"AGENT"|"COMMITMENT"|null} null for a query, which is never fenced
 * @throws {Error} on an unknown command — an unrecognised command is never treated
 *   as unfenced. T2: unknown is never permission. A command absent from the table is
 *   a command whose authority nobody decided, and admitting it as a query would let
 *   any new command class bypass fencing entirely
 */
function fenceScopeOf(command) {
  if (!isKnownCommand(command)) {
    throw new Error(
      `command "${String(command)}" is absent from the §10.3.1 command-class → fence-scope table. ` +
        "Every command MUST declare its scope; treating an unrecognised command as unfenced would let a " +
        "new command class bypass fencing entirely (T2, §10.3.1).",
    );
  }
  return COMMAND_SCOPE[command];
}

/**
 * @param {unknown} command
 * @returns {boolean}
 */
function isKnownCommand(command) {
  return typeof command === "string" && Object.prototype.hasOwnProperty.call(COMMAND_SCOPE, command);
}

/**
 * @param {string} command
 * @returns {"MISSION"|"AGENT"|"QUERY"}
 */
function commandClassOf(command) {
  fenceScopeOf(command);
  return COMMAND_CLASS_OF[command];
}

/**
 * §10.3.2 step 4 — allocate the next commitment-scope fence from the agent's
 * monotone `fence_counter`.
 *
 * > Allocate `fence = agent.fence_counter + 1`; update `agent.fence_counter` to that
 * > value. **The agent's `authority_epoch` is not touched.**
 *
 * @param {bigint|number|string} fenceCounter the agent's current counter
 * @returns {bigint} the fence for the new commitment, and the counter's new value
 */
function allocateFence(fenceCounter) {
  const current = BigInt(fenceCounter);
  if (current < BigInt(0)) {
    throw new RangeError(`fence_counter is ${current}; both fencing counters are monotone and non-negative (I6)`);
  }
  return current + BigInt(1);
}

/**
 * §10.3.1 — the `fence_floor` an agent-scope command carries.
 *
 * > Every agent-scope command carries, in addition to `authority_epoch`, the agent's
 * > current `fence_counter` value as `fence_floor`. On accepting an agent-scope
 * > command the agent (a) records the new `authority_epoch`, (b) sets its local
 * > `fence_floor` to the value carried, and (c) discards its per-commitment authority
 * > table. Any subsequent mission command whose `fence ≤ fence_floor` is then
 * > rejected. One `STAND_DOWN_ALL` therefore fences **every** commitment the agent
 * > holds, in one action, without needing to enumerate them.
 *
 * @param {{ fenceCounter: bigint|number|string }} agent
 * @returns {bigint}
 */
function fenceFloorFor(agent) {
  if (!agent || agent.fenceCounter === undefined || agent.fenceCounter === null) {
    throw new TypeError("fence_floor is the agent's current fence_counter; the agent row must supply it (§10.3.1)");
  }
  return BigInt(agent.fenceCounter);
}

/**
 * The agent's rejection rule for a **mission** command (§10.3.1 row 1):
 * *"Reject if `fence ≤ highest_seen[commitment_id]`, or if `fence ≤ fence_floor`."*
 *
 * The first comparison is **per commitment id**. Comparing against a maximum across
 * the agent's concurrent commitments is the defect §10.3.1 was revised to remove, so
 * this function does not accept such a maximum: it takes a map keyed by commitment
 * id, and an unknown key means "no history for *this* commitment", judged against
 * `fence_floor` alone rather than admitted for lack of history (§11.5).
 *
 * @param {{ commitmentId: string, fence: bigint|number|string }} command
 * @param {Map<string, bigint|number|string>|Record<string, bigint|number|string>} highestSeenPerCommitment
 * @param {bigint|number|string} [fenceFloor]
 * @returns {{ accepted: boolean, reason: string|null }}
 */
function acceptsMissionCommand(command, highestSeenPerCommitment, fenceFloor) {
  if (!command || typeof command.commitmentId !== "string" || command.commitmentId === "") {
    return { accepted: false, reason: "MISSION_COMMAND_WITHOUT_COMMITMENT_ID" };
  }
  if (command.fence === undefined || command.fence === null) {
    return { accepted: false, reason: "MISSION_COMMAND_WITHOUT_FENCE" };
  }

  const fence = BigInt(command.fence);

  if (fenceFloor !== undefined && fenceFloor !== null && fence <= BigInt(fenceFloor)) {
    return { accepted: false, reason: "FENCE_AT_OR_BELOW_FLOOR" };
  }

  const seen =
    highestSeenPerCommitment instanceof Map
      ? highestSeenPerCommitment.get(command.commitmentId)
      : highestSeenPerCommitment
        ? highestSeenPerCommitment[command.commitmentId]
        : undefined;

  if (seen === undefined || seen === null) return { accepted: true, reason: null };
  if (fence <= BigInt(seen)) return { accepted: false, reason: "FENCE_SUPERSEDED_FOR_COMMITMENT" };
  return { accepted: true, reason: null };
}

/**
 * The agent's rejection rule for an **agent** command (§10.3.1 row 2):
 * *"Reject if `authority_epoch < highest_seen_authority`."*
 *
 * Note the asymmetry with the mission rule, which is in the specification and is not
 * a transcription slip: mission commands are rejected at `≤`, agent commands at `<`.
 * An agent-scope command may legitimately be re-sent at the same epoch — a redelivery
 * of the same `QUARANTINE` — and dedup on `(agent_id, sequence, authority_epoch)`
 * (§10.5) is what makes that harmless, rather than the fence.
 *
 * @param {{ authorityEpoch: bigint|number|string }} command
 * @param {bigint|number|string} highestSeenAuthority
 * @returns {{ accepted: boolean, reason: string|null }}
 */
function acceptsAgentCommand(command, highestSeenAuthority) {
  if (!command || command.authorityEpoch === undefined || command.authorityEpoch === null) {
    return { accepted: false, reason: "AGENT_COMMAND_WITHOUT_AUTHORITY_EPOCH" };
  }
  if (highestSeenAuthority === undefined || highestSeenAuthority === null) {
    return { accepted: true, reason: null };
  }
  if (BigInt(command.authorityEpoch) < BigInt(highestSeenAuthority)) {
    return { accepted: false, reason: "AUTHORITY_EPOCH_SUPERSEDED" };
  }
  return { accepted: true, reason: null };
}

/**
 * Apply an accepted agent-scope command to the agent's local authority state
 * (§10.3.1's interaction rule). Returns the new state rather than mutating, so the
 * rule is testable as a function and Phase 4 can apply it on the agent side.
 *
 * (a) record the new `authority_epoch`; (b) set `fence_floor` to the value carried;
 * (c) **discard the per-commitment authority table** — which is what makes one
 * `STAND_DOWN_ALL` fence every commitment without enumerating them.
 *
 * @param {{ authorityEpoch: bigint|number|string, fenceFloor: bigint|number|string }} command
 * @returns {{ highestSeenAuthority: bigint, fenceFloor: bigint, highestSeenPerCommitment: Map<string, bigint> }}
 */
function applyAgentCommand(command) {
  if (!command || command.fenceFloor === undefined || command.fenceFloor === null) {
    throw new TypeError(
      "an agent-scope command MUST carry fence_floor alongside authority_epoch; without it the agent cannot " +
        "invalidate the mission authorities it is superseding (§10.3.1)",
    );
  }
  return {
    highestSeenAuthority: BigInt(command.authorityEpoch),
    fenceFloor: BigInt(command.fenceFloor),
    highestSeenPerCommitment: new Map(),
  };
}

/**
 * §26 invariant I6, pointwise: both counters are strictly monotone across an advance.
 *
 * `isMonotoneAdvance` in `domain/agent.js` states the non-decreasing property, which
 * is what a *high-water audit* compares. This is the stricter form the *allocator*
 * must satisfy: a fence allocation that did not move the counter would hand two
 * commitments the same token.
 *
 * @param {bigint|number|string} previous
 * @param {bigint|number|string} next
 * @returns {boolean}
 */
function isStrictAdvance(previous, next) {
  return BigInt(next) > BigInt(previous);
}

module.exports = {
  FENCE_SCOPE,
  COMMAND_CLASS,
  MISSION_COMMANDS,
  AGENT_COMMANDS,
  QUERY_COMMANDS,
  COMMAND_SCOPE,
  isKnownCommand,
  fenceScopeOf,
  commandClassOf,
  allocateFence,
  fenceFloorFor,
  acceptsMissionCommand,
  acceptsAgentCommand,
  applyAgentCommand,
  isStrictAdvance,
};
