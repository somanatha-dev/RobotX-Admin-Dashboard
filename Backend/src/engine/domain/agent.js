"use strict";

/**
 * Agent (§2.1).
 *
 * > **`Agent`** replaces "robot" as the primary abstraction so that ground robots,
 * > drones, vehicles, and human couriers are representable without a structural
 * > change (§25). An Agent is the unit of commitment: exactly one commitment stack,
 * > exactly one physical identity.
 *
 * Two model decisions §2.1 says warrant justification, and how this module keeps
 * them true:
 *
 * **Lifecycle state is separate from operational status.** The baseline overloads a
 * single status enum, producing the ambiguity where `PAUSED` means either "paused"
 * or "charging" depending on a Redis key that may have expired. Here the five
 * concerns are five fields — lifecycle, commitment, activity, connectivity, health —
 * and `describeState()` returns them as five, so a caller cannot collapse them back
 * by accident. **No inference from an expired cache key is ever required to
 * determine eligibility.**
 *
 * **Capabilities are attested, never self-declared at runtime.** The authoritative
 * set comes from the commissioning record, the installed hardware manifest, and a
 * signed firmware attestation. `domain/capability.js` holds the algebra and the
 * attestation seam; this module never accepts a capability from an agent-reported
 * field.
 *
 * ── Scope ───────────────────────────────────────────────────────────────────
 * Phase 2 lands the facet vocabulary, the lifecycle vocabulary, the eligibility
 * question lifecycle alone answers, and the two fencing counters' invariants. It
 * lands **no** commitment logic: fence allocation, `authority_epoch` advance, and
 * the guards are Phase 3's `commitment/fencing.js` and `commit.js`.
 */

const { CAPABILITY_KIND } = require("./capability");

/**
 * The ten facets §2.1 tabulates. Held as data so that a reader can check the model
 * against the specification's own table rather than against a struct definition.
 * @structural the specification's own facet names
 */
const AGENT_FACETS = Object.freeze([
  "identity",
  "class",
  "mobilityModel",
  "energyModel",
  "capabilityBundle",
  "containerModel",
  "commitmentState",
  "healthState",
  "lifecycleState",
  "observedState",
  "accountingState",
]);

/**
 * §2.1 — lifecycle: is this agent in service at all? Distinct from operational
 * status, from commitment, from connectivity, and from health.
 *
 * `eligible` answers only the lifecycle half of eligibility. An agent that is
 * lifecycle-eligible may still be rejected by any of the 38 predicates of §7.5;
 * an agent that is not is rejected before them.
 */
const LIFECYCLE_STATES = Object.freeze({
  COMMISSIONED: Object.freeze({
    name: "COMMISSIONED",
    meaning: "Registered and configured, not yet released into service",
    eligible: false,
  }),
  ACTIVE: Object.freeze({
    name: "ACTIVE",
    meaning: "In service",
    eligible: true,
  }),
  QUARANTINED: Object.freeze({
    name: "QUARANTINED",
    meaning: "Withdrawn from assignment by health tiering or by an operator (§16.4)",
    eligible: false,
  }),
  MAINTENANCE: Object.freeze({
    name: "MAINTENANCE",
    meaning: "In or transiting to a service bay (§16.6)",
    eligible: false,
  }),
  DECOMMISSIONED: Object.freeze({
    name: "DECOMMISSIONED",
    meaning: "Permanently withdrawn",
    eligible: false,
  }),
});

const LIFECYCLE_STATE_NAMES = Object.freeze(Object.keys(LIFECYCLE_STATES));

/**
 * @param {unknown} state
 * @returns {boolean}
 */
function isLifecycleState(state) {
  return typeof state === "string" && Object.prototype.hasOwnProperty.call(LIFECYCLE_STATES, state);
}

/**
 * @param {string} state
 * @returns {object} the state's §2.1 row
 * @throws {Error} on an unknown state — never read as `ACTIVE`
 */
function lifecycleOf(state) {
  if (!isLifecycleState(state)) {
    throw new Error(
      `unknown lifecycle state "${String(state)}". §2.1 defines: ${LIFECYCLE_STATE_NAMES.join(", ")}. ` +
        "An unrecognised lifecycle state is never treated as in-service.",
    );
  }
  return LIFECYCLE_STATES[state];
}

/**
 * Does lifecycle alone admit this agent to assignment (§2.1)?
 *
 * @param {string} state
 * @returns {boolean}
 */
function isLifecycleEligible(state) {
  return lifecycleOf(state).eligible;
}

/**
 * Return the five orthogonal state concerns as five values (§2.1).
 *
 * > A charging agent is `lifecycle=active`, `activity=charging`,
 * > `commitment=none|reserved_by_charging`.
 *
 * The shape is the point. A caller that wants "is it available" must combine the
 * concerns explicitly, which is exactly what the baseline's single overloaded enum
 * let it avoid doing.
 *
 * @param {object} agent
 * @returns {{ lifecycle: string, commitment: string, activity: string, connectivity: string, health: string }}
 */
function describeState(agent) {
  const source = agent || {};
  return Object.freeze({
    lifecycle: isLifecycleState(source.lifecycleState) ? source.lifecycleState : "UNKNOWN",
    commitment: source.commitmentState === undefined || source.commitmentState === null ? "UNKNOWN" : String(source.commitmentState),
    activity: source.activity === undefined || source.activity === null ? "UNKNOWN" : String(source.activity),
    connectivity: source.connectivity === undefined || source.connectivity === null ? "UNKNOWN" : String(source.connectivity),
    health: source.healthTier === undefined || source.healthTier === null ? "UNKNOWN" : String(source.healthTier),
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   The two fencing counters (§2.6, §10.3.1)
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * §10.3.1 — the two scopes of authority, stated once so that Phase 3's fencing
 * module and Phase 4's command table read the same definition.
 *
 * > The agent's `authority_epoch` guards *agent-level* authority and does not move
 * > on ordinary commits, so several commitments may be created against one agent in
 * > one round without invalidating each other. A per-commitment fence guards each
 * > mission's own commands. **Conflating the two makes a `capacity > 1` agent
 * > uncommandable** (§10.3).
 * @structural scope labels
 */
const FENCE_SCOPE = Object.freeze({
  AGENT: "AGENT",
  COMMITMENT: "COMMITMENT",
});

/**
 * Both counters are monotone non-decreasing. §26 invariant I6 audits the property
 * over a window with a persisted high-water mark; this is the pointwise check the
 * audit is built from.
 *
 * @param {bigint|number|string} previous
 * @param {bigint|number|string} next
 * @returns {boolean}
 */
function isMonotoneAdvance(previous, next) {
  return BigInt(next) >= BigInt(previous);
}

/**
 * §2.6: a commitment's fence is drawn from the agent's `fence_counter` and is
 * **compared per commitment id, never as a single maximum across the agent's
 * concurrent commitments.**
 *
 * > Comparing the commitment fence as a per-agent maximum reintroduces the exact
 * > defect the spec's P0-1 revision removed.
 *
 * Phase 2 states the rule as an assertion the later phases can call rather than
 * re-derive. Phase 3 allocates the fences; Phase 4 compares them on the agent side.
 *
 * @param {{ commitmentId: string, fence: bigint|number }} command
 * @param {Map<string, bigint|number>|object} highestSeenPerCommitment
 * @param {bigint|number} [fenceFloor] the agent-scope floor: an agent-scope command
 *   invalidates *all* commitment authorities below it (§11.5)
 * @returns {boolean} whether the command's authority is current
 */
function isCommandAuthorityCurrent(command, highestSeenPerCommitment, fenceFloor) {
  if (!command || typeof command.commitmentId !== "string") return false;
  const fence = BigInt(command.fence);

  if (fenceFloor !== undefined && fenceFloor !== null && fence <= BigInt(fenceFloor)) return false;

  const read = (source, key) =>
    source instanceof Map ? source.get(key) : source ? source[key] : undefined;
  const seen = read(highestSeenPerCommitment, command.commitmentId);

  // An unknown commitment id is *not* admitted for lack of history: §11.5 requires
  // it to be judged against `fence_floor`, which the check above already applied.
  if (seen === undefined || seen === null) return true;
  return fence > BigInt(seen);
}

/* ═══════════════════════════════════════════════════════════════════════════
   Structural validation
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Validate an Agent record's structure.
 *
 * @param {object} agent
 * @returns {string[]} problems, empty when well-formed
 */
function validateAgent(agent) {
  if (!agent || typeof agent !== "object") return ["agent is not an object"];
  const problems = [];
  const id = typeof agent.agentId === "string" ? agent.agentId : "<unnamed>";

  if (typeof agent.agentId !== "string" || agent.agentId.length === 0) problems.push("agent has no agentId");

  if (!isLifecycleState(agent.lifecycleState)) {
    problems.push(
      `agent "${id}" carries lifecycle state "${String(agent.lifecycleState)}"; §2.1 defines: ${LIFECYCLE_STATE_NAMES.join(", ")}`,
    );
  }

  for (const counter of ["authorityEpoch", "fenceCounter"]) {
    const value = agent[counter];
    if (value === undefined || value === null) {
      problems.push(`agent "${id}" has no ${counter}; §2.6 requires both fencing counters to be present`);
      continue;
    }
    let asBigInt;
    try {
      asBigInt = BigInt(value);
    } catch {
      problems.push(`agent "${id}" has a non-integral ${counter}`);
      continue;
    }
    if (asBigInt < BigInt(0)) problems.push(`agent "${id}" has a negative ${counter}; both counters are monotone`);
  }

  return problems;
}

/**
 * §2.1, §23.5: a capability claim arriving through a telemetry or agent-reported
 * field is untrusted input and is never admitted to the authoritative bundle.
 *
 * > A software update that changes capability MUST update the commissioning record
 * > through the control plane, not through a telemetry field.
 *
 * @param {object} claim
 * @throws {Error} always, when called with a telemetry-sourced capability claim
 */
function refuseSelfDeclaredCapability(claim) {
  const name = claim && claim.name ? String(claim.name) : "<unnamed>";
  throw new Error(
    `capability "${name}" arrived as a runtime self-declaration and is refused. The authoritative ` +
      "capability set is derived from the commissioning record, the installed hardware manifest, and a " +
      "signed firmware attestation; a software update that changes capability must update the " +
      "commissioning record through the control plane, not through a telemetry field (§2.1, §23.2, §23.5).",
  );
}

module.exports = {
  AGENT_FACETS,
  LIFECYCLE_STATES,
  LIFECYCLE_STATE_NAMES,
  FENCE_SCOPE,
  CAPABILITY_KIND,
  isLifecycleState,
  lifecycleOf,
  isLifecycleEligible,
  describeState,
  isMonotoneAdvance,
  isCommandAuthorityCurrent,
  validateAgent,
  refuseSelfDeclaredCapability,
};
