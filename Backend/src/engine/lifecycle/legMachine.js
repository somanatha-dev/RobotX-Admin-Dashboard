"use strict";

/**
 * The Leg state machine (§4.3) — the one that carries operational weight.
 *
 * > The distinction between `OFFERED`, `ACCEPTED`, and `EN_ROUTE_PICKUP` is essential
 * > and absent from the baseline, which conflates all three into `ASSIGNED`. Without it
 * > the system cannot distinguish (a) an agent that never received the assignment,
 * > (b) an agent that received it and is deliberately holding it — the baseline's silent
 * > 30-minute charge deferral — and (c) an agent that is executing normally. These
 * > require three different responses; a single state permits none of them.
 *
 * ── What this module is ─────────────────────────────────────────────────────
 * The §4.3 table, as data. Nineteen states, each with its meaning, its **exit
 * deadline**, and what happens on expiry. Nothing here performs a transition — that is
 * `transitions.js` — and nothing here reads a store. It is the single place the
 * question "what supervises this state, and for how long" is answered, so that
 * `supervision/timers.js` can register a timer for every non-terminal state without a
 * second, drifting copy of the table.
 *
 * ── Why the deadline lives here and not in the timer module ─────────────────
 * §4.5 opens with "**Every** deadline in §4.2 and §4.3 MUST be registered in the
 * durable timer store at the moment the state is entered". That is a claim about the
 * *state machine*, and it is checkable — `statesWithoutDeadline()` below returns the
 * non-terminal states that have none, and the test suite asserts it is empty. A table
 * of deadlines kept next to the timer store instead would make the claim a matter of
 * whoever wrote the registration call remembering the state.
 *
 * ── STRANDED_* is two states, deliberately ──────────────────────────────────
 * > A robot stopped harmlessly in a car park and a robot stopped across a tram line, a
 * > level crossing, or a fire exit are the same event only to a database.
 *
 * The classification is **derived automatically, never operator-entered**, from the
 * obstruction class of the stopping location, and `strandingStateFor` below is that
 * derivation — including `INDETERMINATE` resolving to the more serious case under
 * policy `DENY` semantics (T2, §7.3), which is invariant I22's first half.
 *
 * Tier 1 by path (`src/engine/lifecycle/`), and load-bearing for T0-08's timers.
 * Invariants I4, I12, I22.
 */

/** §4.3's nineteen states. @structural the enumerated Leg states of §4.3 */
const LEG_STATE = Object.freeze({
  QUEUED: "QUEUED",
  DEFERRED: "DEFERRED",
  PLANNED: "PLANNED",
  OFFERED: "OFFERED",
  ACCEPTED: "ACCEPTED",
  EN_ROUTE_PICKUP: "EN_ROUTE_PICKUP",
  AT_PICKUP: "AT_PICKUP",
  LOADED: "LOADED",
  EN_ROUTE_DROP: "EN_ROUTE_DROP",
  AT_DROP: "AT_DROP",
  RELEASED: "RELEASED",
  SETTLED: "SETTLED",
  ABORTING: "ABORTING",
  STRANDED_SAFE: "STRANDED_SAFE",
  STRANDED_OBSTRUCTING: "STRANDED_OBSTRUCTING",
  REASSIGNING: "REASSIGNING",
  WITHDRAWN: "WITHDRAWN",
  CANCELLED: "CANCELLED",
  FAILED: "FAILED",
});

/**
 * The four terminal states, marked so in §4.3's own table.
 *
 * `SETTLED` is the only *successful* one. `WITHDRAWN` is "terminal for that pairing" —
 * the Leg's work continues under a new pairing, which is why the Leg row that reaches
 * it is the one the withdrawal superseded and not the customer's obligation.
 * @structural the terminal partition of §4.3
 */
const TERMINAL_LEG_STATES = Object.freeze([
  LEG_STATE.SETTLED,
  LEG_STATE.WITHDRAWN,
  LEG_STATE.CANCELLED,
  LEG_STATE.FAILED,
]);

/**
 * §4.3's deadline column, verbatim.
 *
 * `parameter` names the register entry the deadline resolves from; `onExpiry` is the
 * §4.3 "On expiry" column, which is what the timer handler attempts. `projected` marks
 * the two states whose deadline is not a fixed duration but the mission's own projected
 * ETA scaled by `execute.eta_tolerance` — a distinction that matters, because a fixed
 * timeout on a two-hour leg and on a four-minute one is the same parameter meaning two
 * different things.
 *
 * `LOADED` is the one non-terminal state §4.3 gives no deadline: an agent holding goods
 * and moving is supervised by the *next* state's deadline and by the lease, and a
 * deadline on custody itself would express "you have held these goods too long", which
 * is an operations question and not a transition. It is listed explicitly with a null
 * so that its absence is a recorded decision rather than an omission — `statesWithoutDeadline`
 * reports it, and the suite asserts it is the only one.
 * @structural the §4.3 deadline table
 */
const LEG_DEADLINES = Object.freeze({
  [LEG_STATE.QUEUED]: Object.freeze({ parameter: "sla.assignment_deadline", onExpiry: "ESCALATION_LADDER" }),
  [LEG_STATE.DEFERRED]: Object.freeze({ parameter: "assign.max_deferral_time", onExpiry: "FORCE_WIDEN_AND_ESCALATE" }),
  [LEG_STATE.PLANNED]: Object.freeze({ parameter: "commit.hardening_deadline", onExpiry: "HARDEN_OR_REPLAN" }),
  [LEG_STATE.OFFERED]: Object.freeze({ parameter: "dispatch.offer_ttl", onExpiry: "WITHDRAW_EXCLUDE_REPLAN" }),
  [LEG_STATE.ACCEPTED]: Object.freeze({ parameter: "execute.start_grace", onExpiry: "PROBE_THEN_REASSIGN" }),
  [LEG_STATE.EN_ROUTE_PICKUP]: Object.freeze({
    parameter: "execute.eta_tolerance",
    onExpiry: "PROGRESS_PROBE",
    projected: true,
  }),
  [LEG_STATE.AT_PICKUP]: Object.freeze({ parameter: "stop.service_time_limit", onExpiry: "OPERATOR_ALERT" }),
  [LEG_STATE.LOADED]: null,
  [LEG_STATE.EN_ROUTE_DROP]: Object.freeze({
    parameter: "execute.eta_tolerance",
    onExpiry: "PROGRESS_PROBE",
    projected: true,
  }),
  [LEG_STATE.AT_DROP]: Object.freeze({ parameter: "stop.service_time_limit", onExpiry: "OPERATOR_ALERT" }),
  [LEG_STATE.RELEASED]: Object.freeze({ parameter: "verify.evidence_deadline", onExpiry: "VERIFICATION_ESCALATION" }),
  [LEG_STATE.ABORTING]: Object.freeze({ parameter: "recover.abort_budget", onExpiry: "FORCE_STRANDED" }),
  [LEG_STATE.STRANDED_SAFE]: Object.freeze({
    parameter: "ops.stranded_safe_response_target",
    onExpiry: "PAGE_OPERATIONS",
  }),
  [LEG_STATE.STRANDED_OBSTRUCTING]: Object.freeze({
    parameter: "ops.stranded_obstructing_response_target",
    onExpiry: "PAGE_OPERATIONS_AND_EXTERNAL_ESCALATION",
  }),
  [LEG_STATE.REASSIGNING]: Object.freeze({ parameter: "recover.reassign_budget", onExpiry: "ESCALATE" }),
});

/**
 * §4.3's obstruction-class table, which is what derives one stranding state from the
 * other. `RESTRICTIVE` is `STRANDED_SAFE` with a shortened target, not a third state:
 * a third state would need its own row in every transition table that mentions
 * stranding, for a difference that is entirely one of response time.
 * @structural the §4.3 obstruction-class → state and response-target mapping
 */
const OBSTRUCTION_DISPOSITION = Object.freeze({
  CLEAR: Object.freeze({
    state: LEG_STATE.STRANDED_SAFE,
    responseTargetParameter: "ops.stranded_safe_response_target",
    externalEscalation: false,
  }),
  RESTRICTIVE: Object.freeze({
    state: LEG_STATE.STRANDED_SAFE,
    responseTargetParameter: "ops.stranded_restrictive_response_target",
    externalEscalation: false,
  }),
  BLOCKING_CRITICAL: Object.freeze({
    state: LEG_STATE.STRANDED_OBSTRUCTING,
    responseTargetParameter: "ops.stranded_obstructing_response_target",
    externalEscalation: true,
  }),
  INDETERMINATE: Object.freeze({
    state: LEG_STATE.STRANDED_OBSTRUCTING,
    responseTargetParameter: "ops.stranded_obstructing_response_target",
    externalEscalation: true,
  }),
});

/**
 * @param {string} state
 * @returns {boolean}
 */
function isTerminal(state) {
  return TERMINAL_LEG_STATES.includes(state);
}

/**
 * @param {string} state
 * @returns {boolean}
 */
function isKnown(state) {
  return Object.prototype.hasOwnProperty.call(LEG_STATE, state);
}

/**
 * §4.5 — does entering this state oblige the caller to register a timer?
 *
 * Every non-terminal state with a stated deadline does. `LOADED` is the documented
 * exception above.
 *
 * @param {string} state
 * @returns {boolean}
 */
function requiresTimer(state) {
  if (isTerminal(state)) return false;
  return Boolean(LEG_DEADLINES[state]);
}

/**
 * The deadline specification for a state, or null.
 *
 * @param {string} state
 * @returns {{ parameter: string, onExpiry: string, projected?: boolean }|null}
 */
function deadlineFor(state) {
  const deadline = LEG_DEADLINES[state];
  return deadline === undefined ? null : deadline;
}

/**
 * The checkable form of §4.5's "every deadline MUST be registered": which non-terminal
 * states have no deadline at all?
 *
 * Returned rather than asserted, so the test suite states the expected answer and a
 * future state added without a deadline fails loudly instead of being silently
 * unsupervised.
 *
 * @returns {string[]}
 */
function statesWithoutDeadline() {
  return Object.values(LEG_STATE)
    .filter((state) => !isTerminal(state))
    .filter((state) => !LEG_DEADLINES[state])
    .sort();
}

/**
 * §4.3 / invariant I22 — which stranding state does this stopping location imply?
 *
 * > Where the obstruction class is unavailable or stale beyond its budget, the
 * > classification is `INDETERMINATE` and resolves to `STRANDED_OBSTRUCTING` under
 * > policy `DENY` semantics (T2, §7.3): an unknown stopping location is treated as the
 * > more serious case, because the cost of over-escalating a safe stranding is an
 * > unnecessary callout and the cost of under-escalating an obstructing one is an
 * > incident.
 *
 * An absent classification is `INDETERMINATE`, not an error and not `CLEAR`. Absence
 * resolving to the permissive case is the baseline's registry-expiry cliff (§2.7), and
 * this is the one place it would be easiest to reintroduce.
 *
 * @param {string|null|undefined} obstructionClass
 * @returns {{ state: string, obstructionClass: string, responseTargetParameter: string, externalEscalation: boolean }}
 */
function strandingStateFor(obstructionClass) {
  const known = obstructionClass && OBSTRUCTION_DISPOSITION[obstructionClass] ? obstructionClass : "INDETERMINATE";
  const disposition = OBSTRUCTION_DISPOSITION[known];
  return {
    state: disposition.state,
    obstructionClass: known,
    responseTargetParameter: disposition.responseTargetParameter,
    externalEscalation: disposition.externalEscalation,
  };
}

module.exports = {
  LEG_STATE,
  TERMINAL_LEG_STATES,
  LEG_DEADLINES,
  OBSTRUCTION_DISPOSITION,
  isTerminal,
  isKnown,
  requiresTimer,
  deadlineFor,
  statesWithoutDeadline,
  strandingStateFor,
};
