"use strict";

/**
 * Work: Task, Mission, Leg, Stop (§2.4), and the §4.2 / §4.3 state vocabularies.
 *
 * > The baseline conflates task and mission, which forecloses chaining,
 * > consolidation, and multi-modal delivery. This model separates them.
 *
 *   - **Task** — a unit of customer-visible work with a service-level contract.
 *   - **Stop** — a located, time-windowed action at a place.
 *   - **Leg** — a contiguous sequence of Stops executed by **one** agent under
 *     **one** commitment. The Leg is the unit of assignment.
 *   - **Mission** — the ordered set of Legs that discharges one or more Tasks,
 *     joined at transfer points where custody passes between agents.
 *
 * > For the common single-agent point-to-point delivery, Mission = one Leg = two
 * > Stops, and the model collapses to the simple case with no overhead. The
 * > generality exists so that consolidation, chaining, and multi-modal long-haul are
 * > the same model rather than three subsystems.
 *
 * **The unit of assignment is the Leg, and the Leg is also the decision index of
 * the objective** (§1.4). A Task's SLA contract is decomposed *downward* onto its
 * Legs by §8.7's attribution rule and aggregated *upward* for reporting at
 * settlement; conflating the two double-counts lateness on multi-Leg Missions.
 * Phase 8 implements the attribution; Phase 2 records that the two directions are
 * distinct operations so no later phase discovers it the expensive way.
 *
 * This module holds vocabulary and structural validation only. The state
 * *machines* — the transition tables of §4.4 with their guards — are Phase 5's
 * `lifecycle/taskMachine.js`, `legMachine.js`, and `transitions.js`. What is fixed
 * here is which states exist, which are terminal, and what shape a well-formed
 * Mission has.
 */

const { CUSTODY_STATE_NAMES } = require("./custody");
const { PURPOSE_NAMES, isPurpose } = require("./purpose");

/* ═══════════════════════════════════════════════════════════════════════════
   §4.2 — Task state machine
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * The eleven Task states of §4.2, each with the deadline parameter that governs its
 * exit. Deadlines are named, not valued: the values are register parameters the
 * Config Service resolves (§22), and a duration written here would be exactly the
 * bare behavioural constant §22.1 rule 1 forbids.
 *
 * `AT_RISK` exists as a distinct state, rather than a computed flag, so that risk is
 * actionable and alertable at the point it becomes true, and so a task's history
 * records when it became endangered — which is the information an incident review
 * needs.
 */
const TASK_STATES = Object.freeze({
  RECEIVED: Object.freeze({ name: "RECEIVED", meaning: "Accepted by intake, not yet validated", exitDeadline: "intake.validation_budget", terminal: false }),
  REJECTED: Object.freeze({ name: "REJECTED", meaning: "Failed validation or admission", exitDeadline: null, terminal: true }),
  PLANNABLE: Object.freeze({ name: "PLANNABLE", meaning: "Validated; decomposed into Legs", exitDeadline: "immediate", terminal: false }),
  WAITING: Object.freeze({ name: "WAITING", meaning: "One or more Legs pending assignment", exitDeadline: "sla.assignment_deadline", terminal: false }),
  IN_EXECUTION: Object.freeze({ name: "IN_EXECUTION", meaning: "At least one Leg has a HARD commitment", exitDeadline: "mission timeline + margin", terminal: false }),
  AT_RISK: Object.freeze({ name: "AT_RISK", meaning: "Projected to breach its SLA target", exitDeadline: "escalation ladder (§17.4)", terminal: false }),
  SUSPENDED: Object.freeze({ name: "SUSPENDED", meaning: "Blocked; awaiting operator or external resolution", exitDeadline: "ops.suspension_review_period", terminal: false }),
  VERIFYING: Object.freeze({ name: "VERIFYING", meaning: "Delivered; verification evidence incomplete (§12.5)", exitDeadline: "verify.evidence_deadline", terminal: false }),
  COMPLETED: Object.freeze({ name: "COMPLETED", meaning: "Delivered and verified", exitDeadline: null, terminal: true }),
  CANCELLED: Object.freeze({ name: "CANCELLED", meaning: "Cancelled by requester or operator", exitDeadline: null, terminal: true }),
  FAILED: Object.freeze({ name: "FAILED", meaning: "Undeliverable after exhausting recovery", exitDeadline: null, terminal: true }),
});

const TASK_STATE_NAMES = Object.freeze(Object.keys(TASK_STATES));

/**
 * The legacy `TaskStatus` values the schema has always carried, retained until the
 * Phase 15 cutover. They are **not** §4.2 states, and no engine module may treat
 * them as such; `legacyTaskStatusToDomain()` in `mappers/legacyTask.js` is the only
 * sanctioned bridge.
 */
const LEGACY_TASK_STATUSES = Object.freeze(["PENDING", "ASSIGNED", "IN_PROGRESS", "COMPLETED", "FAILED", "CANCELLED"]);

/* ═══════════════════════════════════════════════════════════════════════════
   §4.3 — Leg state machine
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * The nineteen Leg states of §4.3 — the state machine that carries operational
 * weight — with the deadline parameter and the expiry action §4.3 states for each.
 *
 * Three properties of this table are load-bearing:
 *
 *   1. **`OFFERED`, `ACCEPTED`, and `EN_ROUTE_PICKUP` are distinct.** The baseline
 *      conflates all three into `ASSIGNED`, and without the distinction the system
 *      cannot tell an agent that never received the assignment from one deliberately
 *      holding it from one executing normally. These require three different
 *      responses; a single state permits none of them.
 *   2. **The `STRANDED_*` states are first-class states, not errors.** Some
 *      situations are genuinely unrecoverable by software. Representing that
 *      honestly, with an operations SLA attached, is strictly better than
 *      representing it as `ASSIGNED` forever.
 *   3. **Stranding is two states.** A robot stopped harmlessly in a car park and a
 *      robot stopped across a tram line are the same event only to a database. A
 *      single state with a single response target either over-escalates the first
 *      until operators learn to ignore the alert, or under-escalates the second.
 *
 * `deadline: null` marks the two states §4.3 gives no deadline: `LOADED`, whose
 * exit is a physical departure, and the terminal states.
 */
const LEG_STATES = Object.freeze({
  QUEUED: Object.freeze({ name: "QUEUED", meaning: "Eligible for the next round", deadline: "sla.assignment_deadline", onExpiry: "escalation ladder (§17.4)", terminal: false }),
  DEFERRED: Object.freeze({ name: "DEFERRED", meaning: "Round decided to wait; re-enters QUEUED next round", deadline: "assign.max_deferral_time", onExpiry: "force widen + escalate", terminal: false }),
  PLANNED: Object.freeze({ name: "PLANNED", meaning: "SOFT reservation held in coordinator plan state; revisable at C_churn (§2.6)", deadline: "commit.hardening_deadline", onExpiry: "harden or re-plan", terminal: false }),
  OFFERED: Object.freeze({ name: "OFFERED", meaning: "Dispatched to agent; awaiting ACK", deadline: "dispatch.offer_ttl", onExpiry: "withdraw, exclude agent, re-plan", terminal: false }),
  ACCEPTED: Object.freeze({ name: "ACCEPTED", meaning: "Agent ACKed; HARD commitment; not yet moving", deadline: "execute.start_grace", onExpiry: "probe, then reassign", terminal: false }),
  EN_ROUTE_PICKUP: Object.freeze({ name: "EN_ROUTE_PICKUP", meaning: "Moving to first Stop", deadline: "projected ETA × execute.eta_tolerance", onExpiry: "progress probe (§12.3)", terminal: false }),
  AT_PICKUP: Object.freeze({ name: "AT_PICKUP", meaning: "Arrived; servicing", deadline: "stop.service_time_limit", onExpiry: "operator alert", terminal: false }),
  LOADED: Object.freeze({ name: "LOADED", meaning: "Custody HELD", deadline: null, onExpiry: null, terminal: false }),
  EN_ROUTE_DROP: Object.freeze({ name: "EN_ROUTE_DROP", meaning: "Moving to destination", deadline: "projected ETA × execute.eta_tolerance", onExpiry: "progress probe", terminal: false }),
  AT_DROP: Object.freeze({ name: "AT_DROP", meaning: "Arrived; servicing", deadline: "stop.service_time_limit", onExpiry: "operator alert", terminal: false }),
  RELEASED: Object.freeze({ name: "RELEASED", meaning: "Custody released; evidence pending", deadline: "verify.evidence_deadline", onExpiry: "verification escalation", terminal: false }),
  SETTLED: Object.freeze({ name: "SETTLED", meaning: "Leg complete, verified, accounted", deadline: null, onExpiry: null, terminal: true }),
  ABORTING: Object.freeze({ name: "ABORTING", meaning: "Recovery in progress", deadline: "recover.abort_budget", onExpiry: "force to the applicable STRANDED_* state", terminal: false }),
  STRANDED_SAFE: Object.freeze({ name: "STRANDED_SAFE", meaning: "Recovery impossible without physical intervention; the agent is stopped at a location whose obstruction class is CLEAR", deadline: "ops.stranded_safe_response_target", onExpiry: "page operations", terminal: false }),
  STRANDED_OBSTRUCTING: Object.freeze({ name: "STRANDED_OBSTRUCTING", meaning: "As STRANDED_SAFE, but the agent is obstructing a right of way, an emergency route, or a hazardous location", deadline: "ops.stranded_obstructing_response_target", onExpiry: "page operations and the external escalation chain (§18.6)", terminal: false }),
  REASSIGNING: Object.freeze({ name: "REASSIGNING", meaning: "Being moved to a different agent", deadline: "recover.reassign_budget", onExpiry: "escalate", terminal: false }),
  WITHDRAWN: Object.freeze({ name: "WITHDRAWN", meaning: "Offer withdrawn before acceptance (terminal for that pairing)", deadline: null, onExpiry: null, terminal: true }),
  CANCELLED: Object.freeze({ name: "CANCELLED", meaning: "Cancelled", deadline: null, onExpiry: null, terminal: true }),
  FAILED: Object.freeze({ name: "FAILED", meaning: "Unrecoverable", deadline: null, onExpiry: null, terminal: true }),
});

const LEG_STATE_NAMES = Object.freeze(Object.keys(LEG_STATES));

/** The `STRANDED_*` pair, referenced by §4.3, §12.2, and §18.6. */
const STRANDED_STATES = Object.freeze(["STRANDED_SAFE", "STRANDED_OBSTRUCTING"]);

/**
 * §4.3 — the obstruction class of the stopping location, and the Leg state,
 * response-target parameter, and escalation each class produces.
 *
 * The distinction is **derived automatically, never operator-entered**, from the
 * Map service (§5.2). `INDETERMINATE` resolves to `STRANDED_OBSTRUCTING` under DENY
 * semantics: an unknown stopping location is treated as the more serious case,
 * because the cost of over-escalating a safe stranding is an unnecessary callout
 * and the cost of under-escalating an obstructing one is an incident.
 */
const OBSTRUCTION_CLASSES = Object.freeze({
  CLEAR: Object.freeze({
    name: "CLEAR",
    meaning: "verge, bay, plaza, off-carriageway",
    legState: "STRANDED_SAFE",
    responseTargetParameter: "ops.stranded_safe_response_target",
    escalation: "Operations queue",
  }),
  RESTRICTIVE: Object.freeze({
    name: "RESTRICTIVE",
    meaning: "footway, shared space, access road; passable but impeding",
    legState: "STRANDED_SAFE",
    responseTargetParameter: "ops.stranded_restrictive_response_target",
    escalation: "Operations queue, paged",
  }),
  BLOCKING_CRITICAL: Object.freeze({
    name: "BLOCKING_CRITICAL",
    meaning: "carriageway, tram or rail crossing, emergency route, fire exit, dock apron",
    legState: "STRANDED_OBSTRUCTING",
    responseTargetParameter: "ops.stranded_obstructing_response_target",
    escalation: "Page plus the external escalation chain (§18.6)",
  }),
  INDETERMINATE: Object.freeze({
    name: "INDETERMINATE",
    meaning: "unavailable or stale beyond its budget",
    legState: "STRANDED_OBSTRUCTING",
    responseTargetParameter: "ops.stranded_obstructing_response_target",
    escalation: "Page plus the external escalation chain (§18.6)",
    note: "Resolves to the more serious case under policy DENY (T2, §7.3).",
  }),
});

const OBSTRUCTION_CLASS_NAMES = Object.freeze(Object.keys(OBSTRUCTION_CLASSES));

/**
 * The Leg state an obstruction class produces (§4.3).
 *
 * Phase 12 owns `map/obstructionClass.js` — the classifier and its staleness
 * budget. This function is the mapping the classifier's output feeds.
 *
 * @param {string|null|undefined} obstructionClass
 * @returns {string} `STRANDED_SAFE` or `STRANDED_OBSTRUCTING`
 */
function strandedStateFor(obstructionClass) {
  const row = OBSTRUCTION_CLASSES[obstructionClass];
  // An absent class is not a missing input to be defaulted permissively; §4.3 says
  // it *is* INDETERMINATE, and INDETERMINATE resolves to the obstructing case.
  return (row || OBSTRUCTION_CLASSES.INDETERMINATE).legState;
}

/* ═══════════════════════════════════════════════════════════════════════════
   §2.4 — Stop types
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * §2.4: "a located, time-windowed action at a place: pickup, drop, wait, charge,
 * inspect, transfer, reposition".
 *
 * A string column rather than a database enum, because the plan's migration group
 * (i) enumerates exactly five new enums and StopType is not among them. The
 * permitted set is enforced here instead, which is where a caller would look for it.
 */
const STOP_TYPES = Object.freeze(["PICKUP", "DROP", "WAIT", "CHARGE", "INSPECT", "TRANSFER", "REPOSITION"]);

/**
 * @param {unknown} stopType
 * @returns {boolean}
 */
function isStopType(stopType) {
  return typeof stopType === "string" && STOP_TYPES.includes(stopType);
}

/* ═══════════════════════════════════════════════════════════════════════════
   Vocabulary predicates
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * @param {unknown} state
 * @returns {boolean}
 */
function isTaskState(state) {
  return typeof state === "string" && Object.prototype.hasOwnProperty.call(TASK_STATES, state);
}

/**
 * @param {unknown} state
 * @returns {boolean}
 */
function isLegState(state) {
  return typeof state === "string" && Object.prototype.hasOwnProperty.call(LEG_STATES, state);
}

/**
 * @param {string} state
 * @returns {boolean}
 * @throws {Error} on an unknown state
 */
function isTerminalTaskState(state) {
  if (!isTaskState(state)) {
    throw new Error(`unknown Task state "${String(state)}". §4.2 defines: ${TASK_STATE_NAMES.join(", ")}.`);
  }
  return TASK_STATES[state].terminal;
}

/**
 * @param {string} state
 * @returns {boolean}
 * @throws {Error} on an unknown state
 */
function isTerminalLegState(state) {
  if (!isLegState(state)) {
    throw new Error(`unknown Leg state "${String(state)}". §4.3 defines: ${LEG_STATE_NAMES.join(", ")}.`);
  }
  return LEG_STATES[state].terminal;
}

/**
 * §4.1 rule 1: "Every non-terminal state has an owner and a deadline. No state may
 * be entered without a durable timer registering its expiry."
 *
 * The two non-terminal Leg states §4.3 gives no deadline — `LOADED`, whose exit is a
 * physical departure — are returned here so Phase 5 can reconcile the rule against
 * the table deliberately rather than by discovering the gap at implementation time.
 *
 * @returns {string[]} non-terminal Leg states with no stated deadline
 */
function nonTerminalLegStatesWithoutDeadline() {
  return LEG_STATE_NAMES.filter((name) => !LEG_STATES[name].terminal && LEG_STATES[name].deadline === null);
}

/* ═══════════════════════════════════════════════════════════════════════════
   Structural validation
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * §2.4: "For the common single-agent point-to-point delivery, Mission = one Leg =
 * two Stops." The backfill's correctness property, and the shape every legacy Task
 * maps to.
 * @structural the pickup and the drop; a structural arity, not a tunable limit
 */
const STOPS_IN_A_POINT_TO_POINT_LEG = 2;

/**
 * Structural rules a well-formed Mission must satisfy. These are shape rules, not
 * feasibility: feasibility is Phase 6's, and it is a property of a *plan*.
 *
 * @param {{ missionId?: string, legs?: Array<object> }} mission
 * @returns {string[]} problems, empty when well-formed
 */
function validateMission(mission) {
  const problems = [];
  if (!mission || typeof mission !== "object") return ["mission is not an object"];
  if (typeof mission.missionId !== "string" || mission.missionId.length === 0) {
    problems.push("mission has no missionId");
  }

  const legs = Array.isArray(mission.legs) ? mission.legs : [];
  if (legs.length === 0) problems.push(`mission "${mission.missionId}" has no Legs`);

  const sequences = new Set();
  for (const leg of legs) {
    problems.push(...validateLeg(leg));
    if (sequences.has(leg && leg.sequence)) {
      problems.push(`mission "${mission.missionId}" has two Legs at sequence ${leg.sequence}`);
    }
    sequences.add(leg && leg.sequence);
  }

  return problems;
}

/**
 * @param {object} leg
 * @returns {string[]} problems, empty when well-formed
 */
function validateLeg(leg) {
  const problems = [];
  if (!leg || typeof leg !== "object") return ["leg is not an object"];

  const id = typeof leg.legId === "string" ? leg.legId : "<unnamed>";
  if (typeof leg.legId !== "string" || leg.legId.length === 0) problems.push("leg has no legId");
  if (!isPurpose(leg.purpose)) {
    problems.push(`leg "${id}" carries purpose "${String(leg.purpose)}"; §2.4 defines: ${PURPOSE_NAMES.join(", ")}`);
  }
  if (leg.state !== undefined && !isLegState(leg.state)) {
    problems.push(`leg "${id}" carries state "${String(leg.state)}"; §4.3 defines: ${LEG_STATE_NAMES.join(", ")}`);
  }
  if (leg.custodyState !== undefined && !CUSTODY_STATE_NAMES.includes(leg.custodyState)) {
    problems.push(`leg "${id}" carries custody state "${String(leg.custodyState)}"; §2.5 defines: ${CUSTODY_STATE_NAMES.join(", ")}`);
  }

  const stops = Array.isArray(leg.stops) ? leg.stops : [];
  // A Leg is "a contiguous sequence of Stops" (§2.4). One Stop is a degenerate
  // sequence with nowhere to go; the minimum meaningful Leg has an origin and a
  // destination.
  if (stops.length < STOPS_IN_A_POINT_TO_POINT_LEG) {
    problems.push(`leg "${id}" has ${stops.length} Stop(s); a Leg is a sequence of Stops (§2.4)`);
  }

  const sequences = new Set();
  for (const stop of stops) {
    if (!stop || typeof stop !== "object") {
      problems.push(`leg "${id}" holds a Stop that is not an object`);
      continue;
    }
    if (!isStopType(stop.stopType)) {
      problems.push(`leg "${id}" holds a Stop of type "${String(stop.stopType)}"; §2.4 defines: ${STOP_TYPES.join(", ")}`);
    }
    if (sequences.has(stop.sequence)) {
      problems.push(`leg "${id}" has two Stops at sequence ${stop.sequence}`);
    }
    sequences.add(stop.sequence);
  }

  return problems;
}

/**
 * Is this the collapsed simple case — one Mission, one `PRIMARY` Leg, two Stops?
 *
 * The Phase 2 backfill asserts this over every converted legacy Task, which is the
 * property the plan states as "every legacy Task maps to exactly one Mission with
 * exactly one `PRIMARY` Leg and two Stops".
 *
 * @param {{ legs?: Array<object> }} mission
 * @returns {boolean}
 */
function isPointToPointMission(mission) {
  const legs = (mission && Array.isArray(mission.legs) && mission.legs) || [];
  if (legs.length !== 1) return false;
  const [leg] = legs;
  if (!leg || leg.purpose !== "PRIMARY") return false;
  const stops = Array.isArray(leg.stops) ? leg.stops : [];
  if (stops.length !== STOPS_IN_A_POINT_TO_POINT_LEG) return false;
  const [first, second] = stops;
  return Boolean(first) && first.stopType === "PICKUP" && Boolean(second) && second.stopType === "DROP";
}

module.exports = {
  TASK_STATES,
  TASK_STATE_NAMES,
  LEGACY_TASK_STATUSES,
  LEG_STATES,
  LEG_STATE_NAMES,
  STRANDED_STATES,
  OBSTRUCTION_CLASSES,
  OBSTRUCTION_CLASS_NAMES,
  STOP_TYPES,
  STOPS_IN_A_POINT_TO_POINT_LEG,
  isTaskState,
  isLegState,
  isStopType,
  isTerminalTaskState,
  isTerminalLegState,
  nonTerminalLegStatesWithoutDeadline,
  strandedStateFor,
  validateMission,
  validateLeg,
  isPointToPointMission,
};
