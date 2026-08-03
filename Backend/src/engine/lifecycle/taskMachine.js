"use strict";

/**
 * The Task state machine (§4.2) — the customer-visible contract.
 *
 * > The Task is the customer-visible contract. Its states are deliberately coarse;
 * > execution detail lives on the Leg.
 *
 * ── `AT_RISK` is a state, not a flag ────────────────────────────────────────
 * > `AT_RISK` exists as a distinct state, rather than a computed flag, so that risk is
 * > *actionable and alertable* at the point it becomes true, and so that a task's
 * > history records when it became endangered — which is the information an incident
 * > review needs.
 *
 * A computed flag has no history and no moment; by the time an incident review asks
 * "when did we know", a flag can only answer "now".
 *
 * ── The legacy vocabulary ───────────────────────────────────────────────────
 * `TaskStatus` in the schema carries both the §4.2 states and the legacy dispatcher's
 * `PENDING` / `ASSIGNED` / `IN_PROGRESS`, which stay in use until the Phase 15 cutover.
 * This module names both sets and keeps them separate: `isEngineState` is what an
 * engine path asserts, and `LEGACY_TASK_STATE` exists so that a reconciler reading a
 * legacy row can recognise it rather than treat it as corrupt. **No mapping between
 * the two is offered here** — inventing one would be deciding the cutover semantics
 * four phases early, and Phase 15 owns that.
 *
 * Tier 1 by path. Invariants I4, I11, I12, I13.
 */

/** §4.2's eleven states. @structural the enumerated Task states of §4.2 */
const TASK_STATE = Object.freeze({
  RECEIVED: "RECEIVED",
  REJECTED: "REJECTED",
  PLANNABLE: "PLANNABLE",
  WAITING: "WAITING",
  IN_EXECUTION: "IN_EXECUTION",
  AT_RISK: "AT_RISK",
  SUSPENDED: "SUSPENDED",
  VERIFYING: "VERIFYING",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
  FAILED: "FAILED",
});

/** The legacy dispatcher's vocabulary, retained until Phase 15. @structural */
const LEGACY_TASK_STATE = Object.freeze({
  PENDING: "PENDING",
  ASSIGNED: "ASSIGNED",
  IN_PROGRESS: "IN_PROGRESS",
});

/** @structural the terminal partition of §4.2 */
const TERMINAL_TASK_STATES = Object.freeze([
  TASK_STATE.REJECTED,
  TASK_STATE.COMPLETED,
  TASK_STATE.CANCELLED,
  TASK_STATE.FAILED,
]);

/**
 * §4.2's exit-deadline column, verbatim.
 *
 * `PLANNABLE`'s deadline is the literal word "immediate": the Task is decomposed into
 * Legs and moves on within the same transaction, so its timer exists to catch the case
 * where it did not — a Task sitting in `PLANNABLE` is a decomposition that failed
 * silently, which is exactly the shape §12.1 describes. `immediate: true` marks it so
 * the timer is registered at the smallest supervisory horizon rather than not at all.
 *
 * `IN_EXECUTION`'s deadline is the mission timeline plus a margin, so it is projected
 * from the plan rather than resolved from one parameter — the same treatment
 * `EN_ROUTE_*` gets on the Leg.
 *
 * `AT_RISK` is supervised by the §17.4 ladder, whose step timing is Phase 8's
 * (T1-04). Named here, owned there.
 * @structural the §4.2 deadline table
 */
const TASK_DEADLINES = Object.freeze({
  [TASK_STATE.RECEIVED]: Object.freeze({ parameter: "intake.validation_budget", onExpiry: "REJECT_OR_ESCALATE" }),
  [TASK_STATE.PLANNABLE]: Object.freeze({
    parameter: "intake.validation_budget",
    onExpiry: "DECOMPOSITION_STALLED",
    immediate: true,
  }),
  [TASK_STATE.WAITING]: Object.freeze({ parameter: "sla.assignment_deadline", onExpiry: "ESCALATION_LADDER" }),
  [TASK_STATE.IN_EXECUTION]: Object.freeze({
    parameter: "execute.eta_tolerance",
    onExpiry: "REPROJECT_TIMELINE",
    projected: true,
  }),
  [TASK_STATE.AT_RISK]: Object.freeze({ parameter: "sla.assignment_deadline", onExpiry: "ESCALATION_LADDER" }),
  [TASK_STATE.SUSPENDED]: Object.freeze({ parameter: "ops.suspension_review_period", onExpiry: "OPERATOR_REVIEW" }),
  [TASK_STATE.VERIFYING]: Object.freeze({
    parameter: "verify.evidence_deadline",
    onExpiry: "VERIFICATION_ESCALATION",
  }),
});

/**
 * @param {string} state
 * @returns {boolean}
 */
function isTerminal(state) {
  return TERMINAL_TASK_STATES.includes(state);
}

/**
 * Is this one of §4.2's states, as opposed to a legacy one?
 *
 * @param {string} state
 * @returns {boolean}
 */
function isEngineState(state) {
  return Object.prototype.hasOwnProperty.call(TASK_STATE, state);
}

/**
 * @param {string} state
 * @returns {boolean}
 */
function isLegacyState(state) {
  return Object.prototype.hasOwnProperty.call(LEGACY_TASK_STATE, state);
}

/**
 * @param {string} state
 * @returns {boolean}
 */
function requiresTimer(state) {
  if (isTerminal(state)) return false;
  return Boolean(TASK_DEADLINES[state]);
}

/**
 * @param {string} state
 * @returns {{ parameter: string, onExpiry: string, projected?: boolean, immediate?: boolean }|null}
 */
function deadlineFor(state) {
  const deadline = TASK_DEADLINES[state];
  return deadline === undefined ? null : deadline;
}

/**
 * The §4.5 completeness check, over §4.2's states. Expected to be empty.
 *
 * @returns {string[]}
 */
function statesWithoutDeadline() {
  return Object.values(TASK_STATE)
    .filter((state) => !isTerminal(state))
    .filter((state) => !TASK_DEADLINES[state])
    .sort();
}

module.exports = {
  TASK_STATE,
  LEGACY_TASK_STATE,
  TERMINAL_TASK_STATES,
  TASK_DEADLINES,
  isTerminal,
  isEngineState,
  isLegacyState,
  requiresTimer,
  deadlineFor,
  statesWithoutDeadline,
};
