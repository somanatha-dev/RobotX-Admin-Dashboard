"use strict";

/**
 * The complete §4.4 transition table, with guards — and the one function that applies a
 * transition.
 *
 * §4.1 generates this table from four rules, and two of them are what this module
 * exists to make unbypassable:
 *
 * > 2. **Every state transition is a conditional write** on the entity's version and,
 * >    where the agent is involved, on its commitment epoch. Unconditional writes permit
 * >    the baseline's silent cancellation reversion, in which finalisation overwrote
 * >    `CANCELLED` back to `ASSIGNED` without reading the current status.
 * > 3. **State is never inferred from the absence of data.** Absence triggers
 * >    investigation, not assumption.
 *
 * ── Three write scopes, and why the table records which ─────────────────────
 * > - Transitions that touch only the Leg are conditional writes on `leg.version`.
 * > - Transitions that create, revise, or release a **HARD commitment** are conditional
 * >   writes on `(leg.version, agent.authority_epoch, shard.leadership_fence)` and
 * >   additionally allocate or advance that commitment's own **fence** (§10.3).
 * > - Transitions between `QUEUED`, `DEFERRED`, and `PLANNED` involve **no commitment
 * >   and no fence**, because no command has been sent to any agent (§2.6).
 *
 * Recording the scope per row is what stops the third case acquiring a fence it does not
 * need — which §2.6 warns produces "a fourth commitment strength alongside SOFT, HARD,
 * and none" — and stops the second losing one it does.
 *
 * ── Every transition carries its timer obligations ──────────────────────────
 * §4.5 requires a timer registered on entry and cancelled atomically on exit. That is
 * invariant I4, and it is enforced here rather than at each of the forty-odd call sites:
 * `apply` cancels the source state's timers and registers the target's, in the same
 * transaction as the conditional write. A caller cannot forget, because there is nothing
 * to forget — it is not a step the caller performs.
 *
 * ── What this module does not do ────────────────────────────────────────────
 * It does not decide *whether* a transition should happen. Deciding is the round's
 * (Phase 10), the supervisor's, the reconciler's, or the agent's; this executes the
 * decision under §4.4's guards and refuses it when a guard fails.
 *
 * Tier 1 by path. Invariants I4, I11, I12.
 */

const legMachine = require("./legMachine");
const purpose = require("../domain/purpose");
const timers = require("../supervision/timers");
// §4.7's recovery assessment, implemented once. This module's lease-expiry row reports
// what that assessment decides rather than restating it (see `leaseExpiryTarget`).
const leases = require("../supervision/leases");

/** §4.4's events, one per row of the table. @structural the enumerated §4.4 events */
const EVENT = Object.freeze({
  ROUND_SELECTS_COLUMN: "ROUND_SELECTS_COLUMN",
  ROUND_SELECTS_DEFER: "ROUND_SELECTS_DEFER",
  ASSIGNMENT_DEADLINE: "ASSIGNMENT_DEADLINE",
  LADDER_EXHAUSTED: "LADDER_EXHAUSTED",
  NEXT_ROUND: "NEXT_ROUND",
  REPLAN_SELECTS_ANOTHER_AGENT: "REPLAN_SELECTS_ANOTHER_AGENT",
  HARDENING_DUE: "HARDENING_DUE",
  AGENT_BECOMES_INFEASIBLE: "AGENT_BECOMES_INFEASIBLE",
  COORDINATOR_FAILOVER: "COORDINATOR_FAILOVER",
  AGENT_ACK: "AGENT_ACK",
  AGENT_NACK: "AGENT_NACK",
  OFFER_TTL_EXPIRY: "OFFER_TTL_EXPIRY",
  /**
   * §4.3-sourced. `PLANNED`'s deadline is `commit.hardening_deadline` and its On-expiry
   * column reads *"harden or re-plan"*. §4.4 supplies the harden half (`HARDENING_DUE`)
   * and no event at all for the re-plan half. See `SECTION_4_3_SOURCED`.
   */
  HARDENING_DEADLINE_ELAPSED: "HARDENING_DEADLINE_ELAPSED",
  /**
   * §4.3-sourced. `ABORTING`'s On-expiry column reads *"force to the applicable
   * `STRANDED_*` state"*, and §4.4 gives `ABORTING` no outgoing row at all.
   */
  ABORT_BUDGET_EXPIRY: "ABORT_BUDGET_EXPIRY",
  DEPARTURE_DETECTED: "DEPARTURE_DETECTED",
  START_GRACE_EXPIRY: "START_GRACE_EXPIRY",
  ARRIVAL_VERIFIED: "ARRIVAL_VERIFIED",
  ETA_BREACH: "ETA_BREACH",
  BLOCKING_FAULT: "BLOCKING_FAULT",
  CUSTODY_ACQUIRED: "CUSTODY_ACQUIRED",
  PICKUP_IMPOSSIBLE: "PICKUP_IMPOSSIBLE",
  DEPARTURE: "DEPARTURE",
  CUSTODY_RELEASED: "CUSTODY_RELEASED",
  VERIFICATION_COMPLETE: "VERIFICATION_COMPLETE",
  EVIDENCE_INSUFFICIENT: "EVIDENCE_INSUFFICIENT",
  CANCEL_REQUEST: "CANCEL_REQUEST",
  LEASE_EXPIRY: "LEASE_EXPIRY",
  OBSTRUCTION_RECLASSIFIED_CRITICAL: "OBSTRUCTION_RECLASSIFIED_CRITICAL",
  CLEARED_BY_RESPONDERS: "CLEARED_BY_RESPONDERS",
  GOODS_AND_AGENT_RECOVERED: "GOODS_AND_AGENT_RECOVERED",
});

/**
 * §4.4's three write scopes.
 * @structural the enumerated conditional-write scopes of §4.4
 */
const WRITE_SCOPE = Object.freeze({
  /** Conditional on `leg.version` alone. */
  LEG_ONLY: "LEG_ONLY",
  /** Conditional on `(leg.version, agent.authority_epoch, shard.leadership_fence)`, and allocates or advances a fence. */
  COMMITMENT: "COMMITMENT",
  /** No commitment and no fence — nothing has been said to any agent (§2.6). */
  PLANNING_ONLY: "PLANNING_ONLY",
});

/**
 * The guard identifiers §4.4's guard column names. Each is a **declared** name with a
 * pure evaluator in `GUARD_EVALUATORS`, rather than an inline predicate, so that the
 * table reads as the specification writes it and a guard cannot be silently skipped by a
 * call site that forgot it.
 * @structural the enumerated §4.4 guards
 */
const GUARD = Object.freeze({
  COLUMN_FEASIBLE: "COLUMN_FEASIBLE",
  LEG_VERSION_CAS: "LEG_VERSION_CAS",
  LADDER_STEP_AVAILABLE: "LADDER_STEP_AVAILABLE",
  CHURN_PRICED_NO_CUSTODY: "CHURN_PRICED_NO_CUSTODY",
  COMMIT_GUARDS_PASS: "COMMIT_GUARDS_PASS",
  NEW_LEADER_RECONCILING: "NEW_LEADER_RECONCILING",
  FENCE_MATCHES_OFFER_UNEXPIRED: "FENCE_MATCHES_OFFER_UNEXPIRED",
  MOTION_CORROBORATED: "MOTION_CORROBORATED",
  NO_CUSTODY: "NO_CUSTODY",
  GEOFENCE_AND_EVIDENCE: "GEOFENCE_AND_EVIDENCE",
  PAYLOAD_EVIDENCE: "PAYLOAD_EVIDENCE",
  RELEASE_EVIDENCE: "RELEASE_EVIDENCE",
  EVIDENCE_SUFFICIENT: "EVIDENCE_SUFFICIENT",
  CANCEL_AUTHORISED_AND_NOT_CUSTODIAL: "CANCEL_AUTHORISED_AND_NOT_CUSTODIAL",
  CUSTODY_HELD: "CUSTODY_HELD",
  CORROBORATED_POSITION: "CORROBORATED_POSITION",
  CUSTODY_ACCOUNTED_FOR: "CUSTODY_ACCOUNTED_FOR",
});

/**
 * PHASE 5 REMEDIATION — the marker on a row that §4.3 mandates and §4.4 does not contain.
 *
 * §4.4 is titled *"Complete transition table"*, and for the transitions §4.4 itself
 * enumerates it is complete. It is not complete over **§4.3's "On expiry" column**, which
 * is the other half of the same frozen specification and which names, for three states, a
 * consequence §4.4 provides no row to perform:
 *
 * | §4.3 state | §4.3 "On expiry" | What §4.4 contains |
 * |---|---|---|
 * | `PLANNED` | "harden **or re-plan**" | the harden half only (`hardening due → OFFERED`) |
 * | `EN_ROUTE_DROP` | "progress probe" | no ETA-breach row (`EN_ROUTE_PICKUP` has one) |
 * | `ABORTING` | "force to the applicable `STRANDED_*` state" | **no outgoing row at all** |
 *
 * This is a disagreement inside the frozen specification, not a licence to design. The
 * execution plan's own precedence rule — *"where this plan and the specification appear
 * to disagree, the specification wins"* — does not adjudicate a specification that
 * disagrees with itself, so the rule applied here is narrower and stated once:
 *
 * > A row may carry this marker only where **§4.3 states the consequence in its own
 * > words**, and the row must perform *that* consequence and nothing more. Where §4.3 is
 * > silent, no row is added.
 *
 * Under that rule the three rows above are additions; `REASSIGNING`'s *"escalate"* and
 * the two `OPERATOR_ALERT` states are **not**, because §4.3 names an action there and no
 * target state, and `supervision/expiryActions.js` handles them without moving the Leg.
 *
 * Marked rather than blended in, so `sectionFourThreeSourcedRows()` can enumerate them,
 * the suite can pin the count, and a reviewer comparing this table against §4.4 finds the
 * difference named instead of discovering it.
 * @structural the provenance marker for §4.3-sourced rows
 */
const SECTION_4_3_SOURCED = "§4.3";

const S = legMachine.LEG_STATE;

/**
 * §4.4's table, row for row and in its own order.
 *
 * The `guards` list holds **only what §4.4's guard column names**. The version CAS is
 * not repeated on every row even though §4.1 rule 2 applies to every row, because
 * `apply` performs it unconditionally as the write itself — a declared guard that
 * duplicates an unconditional mechanism is a guard a future edit can remove while
 * believing it has changed nothing. §4.4 names it explicitly on the one row where the
 * round's own read is what it is checked against, and it is listed there.
 *
 * `to` is a function where §4.4's target depends on the context — the two stranding
 * rows, and the lease-expiry row whose target is "by custody state and obstruction
 * class". Encoding those as a function of the context is what keeps the derivation in
 * one place (`legMachine.strandingStateFor`) instead of at each caller.
 * @structural the §4.4 transition table
 */
const TRANSITIONS = Object.freeze([
  {
    from: S.QUEUED,
    event: EVENT.ROUND_SELECTS_COLUMN,
    to: S.PLANNED,
    scope: WRITE_SCOPE.PLANNING_ONLY,
    guards: [GUARD.COLUMN_FEASIBLE, GUARD.LEG_VERSION_CAS],
    effects: ["SOFT_RESERVATION_IN_PLAN_STATE", "REGISTER_HARDENING_TIMER", "DECISION_RECORD"],
  },
  {
    from: S.QUEUED,
    event: EVENT.ROUND_SELECTS_DEFER,
    to: S.DEFERRED,
    scope: WRITE_SCOPE.PLANNING_ONLY,
    guards: [],
    effects: ["DECISION_RECORD_WITH_DEFER_REASON"],
  },
  {
    from: S.QUEUED,
    event: EVENT.ASSIGNMENT_DEADLINE,
    to: S.QUEUED,
    scope: WRITE_SCOPE.PLANNING_ONLY,
    guards: [GUARD.LADDER_STEP_AVAILABLE],
    effects: ["APPLY_LADDER_RELAXATION"],
  },
  {
    from: S.QUEUED,
    event: EVENT.LADDER_EXHAUSTED,
    to: S.FAILED,
    scope: WRITE_SCOPE.LEG_ONLY,
    guards: [],
    effects: ["TASK_FAILED", "OPERATOR_NOTIFICATION"],
  },
  {
    from: S.DEFERRED,
    event: EVENT.NEXT_ROUND,
    to: S.QUEUED,
    scope: WRITE_SCOPE.PLANNING_ONLY,
    guards: [],
    effects: [],
  },
  {
    from: S.PLANNED,
    event: EVENT.REPLAN_SELECTS_ANOTHER_AGENT,
    to: S.PLANNED,
    scope: WRITE_SCOPE.PLANNING_ONLY,
    guards: [GUARD.CHURN_PRICED_NO_CUSTODY],
    // "prior SOFT reservation discarded in memory; **no durable write, no fence, no
    // commitment released** — nothing was ever committed"
    effects: ["DISCARD_SOFT_RESERVATION_IN_MEMORY"],
    durable: false,
  },
  {
    from: S.PLANNED,
    event: EVENT.HARDENING_DUE,
    to: S.OFFERED,
    scope: WRITE_SCOPE.COMMITMENT,
    guards: [GUARD.COMMIT_GUARDS_PASS],
    effects: ["CREATE_HARD_COMMITMENT_WITH_FRESH_FENCE", "GRANT_LEASE", "OUTBOX_ROW_SAME_TRANSACTION"],
  },
  {
    from: S.PLANNED,
    event: EVENT.AGENT_BECOMES_INFEASIBLE,
    to: S.QUEUED,
    scope: WRITE_SCOPE.PLANNING_ONLY,
    guards: [],
    effects: ["DISCARD_SOFT_RESERVATION", "RECORD_CAUSE"],
  },
  {
    from: S.PLANNED,
    event: EVENT.COORDINATOR_FAILOVER,
    to: S.QUEUED,
    scope: WRITE_SCOPE.PLANNING_ONLY,
    guards: [GUARD.NEW_LEADER_RECONCILING],
    // "reservation reconstructed, not recovered" (§19.5) — which is why the orphan scan
    // counts a PLANNED orphan separately from a QUEUED or ACCEPTED one (§12.4).
    effects: ["RECONSTRUCT_NOT_RECOVER"],
  },
  {
    from: S.OFFERED,
    event: EVENT.AGENT_ACK,
    to: S.ACCEPTED,
    scope: WRITE_SCOPE.COMMITMENT,
    guards: [GUARD.FENCE_MATCHES_OFFER_UNEXPIRED],
    effects: ["COMMITMENT_HARD", "RENEW_LEASE"],
  },
  {
    from: S.OFFERED,
    event: EVENT.AGENT_NACK,
    to: S.QUEUED,
    scope: WRITE_SCOPE.COMMITMENT,
    guards: [],
    effects: ["RELEASE_COMMITMENT", "EXCLUDE_AGENT_FOR_NACK_COOLOFF", "RECORD_REASON", "HEALTH_SIGNAL"],
  },
  {
    from: S.OFFERED,
    event: EVENT.OFFER_TTL_EXPIRY,
    to: S.QUEUED,
    via: S.WITHDRAWN,
    scope: WRITE_SCOPE.COMMITMENT,
    guards: [],
    effects: ["WITHDRAW_AT_ADVANCED_FENCE", "RELEASE_COMMITMENT", "RELIABILITY_PENALTY"],
  },
  {
    from: S.ACCEPTED,
    event: EVENT.DEPARTURE_DETECTED,
    to: S.EN_ROUTE_PICKUP,
    scope: WRITE_SCOPE.LEG_ONLY,
    guards: [GUARD.MOTION_CORROBORATED],
    effects: [],
  },
  {
    from: S.ACCEPTED,
    event: EVENT.START_GRACE_EXPIRY,
    to: S.REASSIGNING,
    scope: WRITE_SCOPE.LEG_ONLY,
    guards: [GUARD.NO_CUSTODY],
    effects: ["PROBE_THEN_REASSIGN"],
  },
  {
    from: S.EN_ROUTE_PICKUP,
    event: EVENT.ARRIVAL_VERIFIED,
    to: S.AT_PICKUP,
    scope: WRITE_SCOPE.LEG_ONLY,
    guards: [GUARD.GEOFENCE_AND_EVIDENCE],
    effects: [],
  },
  {
    from: S.EN_ROUTE_PICKUP,
    event: EVENT.ETA_BREACH,
    to: S.EN_ROUTE_PICKUP,
    scope: WRITE_SCOPE.LEG_ONLY,
    guards: [],
    effects: ["REPROJECT", "MAY_SET_TASK_AT_RISK"],
  },
  {
    // §4.3-sourced — the re-plan half of `PLANNED`'s *"harden or re-plan"*.
    //
    // §4.4 has `PLANNED | hardening due | OFFERED`, which is the harden half, and two
    // rows back to `QUEUED` whose events assert a *cause* the expiry does not know:
    // `agent becomes infeasible` and `coordinator failover`. Routing an elapsed
    // hardening deadline through either would file it under a cause nobody observed,
    // and "the agent became infeasible" is a reliability signal attributed to an agent.
    // The transition and its side effects are §4.4's `agent becomes infeasible` row
    // exactly — discard the SOFT reservation, record the cause — and only the event
    // name differs, which is the point: the recorded cause is the true one.
    //
    // No commitment exists to release: §2.6 and §4.4's third scope note say a Leg
    // between `QUEUED`, `DEFERRED` and `PLANNED` has no commitment and no fence,
    // because nothing has been said to any agent. So this is `PLANNING_ONLY`.
    from: S.PLANNED,
    event: EVENT.HARDENING_DEADLINE_ELAPSED,
    to: S.QUEUED,
    scope: WRITE_SCOPE.PLANNING_ONLY,
    guards: [],
    effects: ["DISCARD_SOFT_RESERVATION", "RECORD_CAUSE"],
    source: SECTION_4_3_SOURCED,
  },
  {
    from: S.EN_ROUTE_PICKUP,
    event: EVENT.BLOCKING_FAULT,
    to: S.ABORTING,
    scope: WRITE_SCOPE.LEG_ONLY,
    guards: [GUARD.NO_CUSTODY],
    effects: ["RECOVERY"],
  },
  {
    from: S.AT_PICKUP,
    event: EVENT.CUSTODY_ACQUIRED,
    to: S.LOADED,
    scope: WRITE_SCOPE.LEG_ONLY,
    guards: [GUARD.PAYLOAD_EVIDENCE],
    effects: ["CUSTODY_HELD", "UPDATE_PAYLOAD_STATE"],
  },
  {
    from: S.AT_PICKUP,
    event: EVENT.PICKUP_IMPOSSIBLE,
    to: S.ABORTING,
    scope: WRITE_SCOPE.LEG_ONLY,
    guards: [],
    effects: ["NOTIFY_REQUESTER"],
  },
  {
    from: S.LOADED,
    event: EVENT.DEPARTURE,
    to: S.EN_ROUTE_DROP,
    scope: WRITE_SCOPE.LEG_ONLY,
    guards: [],
    effects: [],
  },
  {
    from: S.EN_ROUTE_DROP,
    event: EVENT.ARRIVAL_VERIFIED,
    to: S.AT_DROP,
    scope: WRITE_SCOPE.LEG_ONLY,
    guards: [GUARD.GEOFENCE_AND_EVIDENCE],
    effects: [],
  },
  {
    from: S.EN_ROUTE_DROP,
    event: EVENT.BLOCKING_FAULT,
    to: (context) => legMachine.strandingStateFor(context && context.obstructionClass).state,
    scope: WRITE_SCOPE.LEG_ONLY,
    guards: [GUARD.CUSTODY_HELD],
    effects: ["RECOVERY_LEG_REQUIRED", "EXTERNAL_ESCALATION_IF_OBSTRUCTING"],
  },
  {
    // §4.3-sourced — `EN_ROUTE_DROP`'s On-expiry column reads *"progress probe"*, the
    // same as `EN_ROUTE_PICKUP`'s, over the same deadline (*"projected ETA × tolerance"*).
    // §4.4 gives `EN_ROUTE_PICKUP` an `ETA breach` self-row and gives `EN_ROUTE_DROP`
    // only its `arrival verified` and `blocking fault` rows.
    //
    // Without this row the second half of every mission is the half §4.5 cannot
    // supervise: the timer fires, `find` returns nothing, and the deadline is
    // undischargeable — the state a Leg carrying goods is in for the longest.
    // §12.3's ETA-drift row is stated over missions, not over one leg half.
    from: S.EN_ROUTE_DROP,
    event: EVENT.ETA_BREACH,
    to: S.EN_ROUTE_DROP,
    scope: WRITE_SCOPE.LEG_ONLY,
    guards: [],
    effects: ["REPROJECT", "MAY_SET_TASK_AT_RISK"],
    source: SECTION_4_3_SOURCED,
  },
  {
    from: S.AT_DROP,
    event: EVENT.CUSTODY_RELEASED,
    to: S.RELEASED,
    scope: WRITE_SCOPE.LEG_ONLY,
    guards: [GUARD.RELEASE_EVIDENCE],
    effects: ["CUSTODY_RELEASED"],
  },
  {
    from: S.RELEASED,
    event: EVENT.VERIFICATION_COMPLETE,
    to: S.SETTLED,
    scope: WRITE_SCOPE.COMMITMENT,
    guards: [GUARD.EVIDENCE_SUFFICIENT],
    effects: ["RELEASE_COMMITMENT", "RETIRE_FENCE", "RETURN_CAPACITY", "WRITE_ACCOUNTING"],
  },
  {
    from: S.RELEASED,
    event: EVENT.EVIDENCE_INSUFFICIENT,
    to: S.RELEASED,
    scope: WRITE_SCOPE.LEG_ONLY,
    guards: [],
    // §4.4 sends the *Task* to VERIFYING; the Leg stays where it is, awaiting evidence.
    effects: ["TASK_VERIFYING", "OPERATOR_QUEUE"],
  },
  {
    from: ANY_NON_TERMINAL,
    event: EVENT.CANCEL_REQUEST,
    to: S.ABORTING,
    scope: WRITE_SCOPE.LEG_ONLY,
    guards: [GUARD.CANCEL_AUTHORISED_AND_NOT_CUSTODIAL],
    effects: ["CANCELLATION_PROTOCOL"],
  },
  {
    from: ANY_NON_TERMINAL,
    event: EVENT.LEASE_EXPIRY,
    to: (context) => leaseExpiryTarget(context),
    scope: WRITE_SCOPE.COMMITMENT,
    guards: [],
    effects: ["CUSTODY_AWARE_RECOVERY_ASSESSMENT"],
  },
  {
    // §4.3-sourced — `ABORTING`'s On-expiry column reads *"force to the applicable
    // `STRANDED_*` state"*, over `recover.abort_budget`. §4.4 gives `ABORTING` **no
    // outgoing row whatsoever**; the only rows that reach it from there are the two
    // wildcards, and neither is an abort-budget expiry.
    //
    // The target is `legMachine.strandingStateFor`, the same derivation the blocking-fault
    // row uses, so the `CLEAR` / `RESTRICTIVE` / `BLOCKING_CRITICAL` / `INDETERMINATE`
    // classification and its `DENY`-semantics default are stated once (I22).
    //
    // **Unguarded, deliberately, and this is the one place that reading is uncomfortable.**
    // §4.3 says *force*, and every other §4.3 stranding path is custody-conditioned. But
    // `ABORTING` is reached both with custody and without — §4.4's `pickup impossible` row
    // enters it from `AT_PICKUP`, and §4.6 step 3 enters it on a cancellation with custody
    // `HELD` — and the state means *"recovery in progress"* in both cases. A recovery that
    // has exhausted its budget has, by definition, not recovered the agent, whether or not
    // it is carrying anything; the difference is what the operator finds when they arrive,
    // which the custody manifest on the page carries. Adding a custody guard here would
    // leave a custody-`NONE` `ABORTING` Leg with a deadline it can never discharge, which
    // is the defect this row exists to remove.
    //
    // `COMMITMENT` scope: the incumbent still holds one — `ABORTING` is entered from
    // states that have a HARD commitment — and stranding is where §4.7's physical-recovery
    // outcome lands, which §4.4 scopes to the commitment on its own stranding row.
    from: S.ABORTING,
    event: EVENT.ABORT_BUDGET_EXPIRY,
    to: (context) => legMachine.strandingStateFor(context && context.obstructionClass).state,
    scope: WRITE_SCOPE.COMMITMENT,
    guards: [],
    effects: ["PAGE_OPERATIONS", "EXTERNAL_ESCALATION_IF_OBSTRUCTING"],
    source: SECTION_4_3_SOURCED,
  },
  {
    from: S.STRANDED_SAFE,
    event: EVENT.OBSTRUCTION_RECLASSIFIED_CRITICAL,
    to: S.STRANDED_OBSTRUCTING,
    scope: WRITE_SCOPE.LEG_ONLY,
    guards: [],
    effects: ["REPAGE_AT_SHORTER_TARGET", "EXTERNAL_ESCALATION"],
  },
  {
    from: S.STRANDED_OBSTRUCTING,
    event: EVENT.CLEARED_BY_RESPONDERS,
    to: S.STRANDED_SAFE,
    scope: WRITE_SCOPE.LEG_ONLY,
    guards: [GUARD.CORROBORATED_POSITION],
    effects: ["DE_ESCALATE", "RECOVERY_CONTINUES"],
  },
  {
    from: [S.STRANDED_SAFE, S.STRANDED_OBSTRUCTING],
    event: EVENT.GOODS_AND_AGENT_RECOVERED,
    to: (context) => (context && context.settled ? S.SETTLED : S.FAILED),
    scope: WRITE_SCOPE.COMMITMENT,
    guards: [GUARD.CUSTODY_ACCOUNTED_FOR],
    effects: ["TERMINATE_ONLY_ONCE_CUSTODY_DISCHARGED"],
  },
]);

/** §4.4's "any non-terminal" source. @structural the wildcard source of two §4.4 rows */
function ANY_NON_TERMINAL() {}

/**
 * §4.4's lease-expiry row: *"`REASSIGNING`, `STRANDED_SAFE`, or `STRANDED_OBSTRUCTING`
 * — by custody state and obstruction class"* (§12.2).
 *
 * Custody `NONE` is a scheduling problem and the Leg is reassigned. Custody that may hold
 * goods is a physical logistics problem, and no amount of database repair moves them — so
 * it strands, at the class the stopping location implies, unless §4.7 finds one of its two
 * other lawful outcomes.
 *
 * **This row does not decide anything itself.** §4.7's recovery assessment is implemented
 * once, in `supervision/leases.assessRecovery`, and this resolver reports the Leg state
 * that assessment names. Until Phase 5's remediation it restated the decision inline, and
 * the restatement had drifted in exactly the way a second copy drifts:
 *
 *   - it compared `custodyState !== "HELD"` as a literal string, so `DISPUTED` — which
 *     `domain/custody.holdsGoods` answers **true** for, deliberately, because contested
 *     evidence resolves to the conservative case (§2.5, T2) — took the custody-`NONE`
 *     reassignment path, the one §4.7 reserves for an agent that is carrying nothing;
 *   - it omitted `stillFeasible` from the Resume condition, so an incumbent that recovered
 *     inside its window but is no longer feasible was resumed rather than assessed;
 *   - and it resolved Resume to `REASSIGNING` — taking the Leg away from the incumbent —
 *     where §4.7's Resume mechanism is *"lease renewed, replan route, continue"*.
 *
 * `failure/catalogue.js` and `failure/agentFailures.js` both already name
 * `assessRecovery` as the single implementation of §4.7's outcomes and warn in their own
 * comments against restating them; this row is now held to the same rule.
 *
 * @param {object} context
 * @returns {string}
 */
function leaseExpiryTarget(context) {
  const source = context || {};
  const assessment = leases.assessRecovery(source);

  if (assessment.outcome === leases.RECOVERY_OUTCOME.RESUME) {
    // §4.7 Resume: the mission continues, so the Leg does not move. `assessRecovery`
    // reports the Leg's own state for this outcome; a self-transition through `apply` is
    // what re-arms supervision at the new version, which is precisely what a renewed lease
    // needs. If the caller supplied no Leg there is no state to continue in, and §4.1
    // rule 3 forbids inventing one from the absence.
    if (typeof assessment.legState === "string" && assessment.legState !== "") return assessment.legState;
    throw new TypeError(
      "§4.7's Resume outcome continues the Leg in its current state, and no Leg was supplied to read it from. " +
        "Absence triggers investigation, not assumption (§4.1 rule 3).",
    );
  }

  return assessment.legState;
}

/**
 * The guard evaluators. Each is pure, takes the context, and returns a verdict with a
 * reason — never a bare boolean, because "which guard, and why" is what a decision
 * record needs and a boolean cannot carry.
 *
 * Guards whose evidence belongs to a phase that has not landed are **explicitly
 * indeterminate** rather than defaulting to true. §7.3's three-valued discipline applies
 * here for the same reason it applies to feasibility: a guard that silently passes when
 * nobody supplied its evidence is not a guard, and §4.1 rule 3 forbids inferring state
 * from the absence of data.
 * @structural the guard evaluator table
 */
const GUARD_EVALUATORS = Object.freeze({
  [GUARD.LEG_VERSION_CAS]: (context) =>
    context.leg && context.expectedVersion === context.leg.version
      ? pass()
      : fail("LEG_VERSION_MOVED", `expected leg.version ${String(context.expectedVersion)}, found ${String(context.leg && context.leg.version)}`),

  [GUARD.COLUMN_FEASIBLE]: (context) => required(context, "columnFeasible", "COLUMN_NOT_FEASIBLE"),

  [GUARD.LADDER_STEP_AVAILABLE]: (context) => required(context, "ladderStepAvailable", "LADDER_EXHAUSTED"),

  [GUARD.CHURN_PRICED_NO_CUSTODY]: (context) => {
    if (context.leg && context.leg.custodyState === "HELD") return fail("CUSTODY_HELD", "a loaded Leg is not re-planned");
    return required(context, "churnPriced", "CHURN_NOT_PRICED");
  },

  [GUARD.COMMIT_GUARDS_PASS]: (context) => required(context, "commitGuardsPass", "COMMIT_GUARDS_FAILED"),

  [GUARD.NEW_LEADER_RECONCILING]: (context) => required(context, "newLeaderReconciling", "NOT_RECONCILING"),

  [GUARD.FENCE_MATCHES_OFFER_UNEXPIRED]: (context) => {
    if (!context.commitment) return fail("NO_COMMITMENT", "an ACK names a commitment");
    if (context.fence === undefined || context.fence === null) return fail("NO_FENCE", "an ACK carries its fence");
    if (BigInt(context.fence) !== BigInt(context.commitment.fence)) {
      return fail("SUPERSEDED_FENCE", "the response answers an offer that has been superseded");
    }
    return required(context, "offerUnexpired", "OFFER_EXPIRED");
  },

  [GUARD.MOTION_CORROBORATED]: (context) => required(context, "motionCorroborated", "MOTION_NOT_CORROBORATED"),

  [GUARD.NO_CUSTODY]: (context) =>
    context.leg && context.leg.custodyState === "NONE"
      ? pass()
      : fail("CUSTODY_NOT_NONE", `custody is ${String(context.leg && context.leg.custodyState)}`),

  [GUARD.CUSTODY_HELD]: (context) =>
    context.leg && context.leg.custodyState === "HELD"
      ? pass()
      : fail("CUSTODY_NOT_HELD", `custody is ${String(context.leg && context.leg.custodyState)}`),

  [GUARD.GEOFENCE_AND_EVIDENCE]: (context) => required(context, "arrivalVerified", "ARRIVAL_NOT_VERIFIED"),

  [GUARD.PAYLOAD_EVIDENCE]: (context) => required(context, "payloadEvidence", "NO_PAYLOAD_EVIDENCE"),

  [GUARD.RELEASE_EVIDENCE]: (context) => required(context, "releaseEvidence", "NO_RELEASE_EVIDENCE"),

  [GUARD.EVIDENCE_SUFFICIENT]: (context) => required(context, "evidenceSufficient", "EVIDENCE_INSUFFICIENT"),

  [GUARD.CORROBORATED_POSITION]: (context) => required(context, "corroboratedPosition", "POSITION_NOT_CORROBORATED"),

  [GUARD.CUSTODY_ACCOUNTED_FOR]: (context) => required(context, "custodyAccountedFor", "CUSTODY_NOT_ACCOUNTED_FOR"),

  /**
   * §4.6 rule 2 — the purpose-conditioned cancellation guard, in full:
   *
   * > `cancel_requested_at IS NULL   OR   leg.purpose ∈ custodial_purposes`
   *
   * Note the direction. This guard governs *other* transitions, refusing them once a
   * cancellation is pending; the row it sits on is the cancellation itself, whose
   * precondition is authority rather than the flag. Both readings are needed and they
   * are different functions, which is why `cancellationGuard` below is separate.
   */
  [GUARD.CANCEL_AUTHORISED_AND_NOT_CUSTODIAL]: (context) => {
    if (context.cancelAuthorised !== true) return fail("CANCEL_NOT_AUTHORISED", "§23.6 checks scope, rate, and audit");
    if (context.leg && purpose.isCustodial(context.leg.purpose)) {
      return fail(
        "CUSTODIAL_PURPOSE",
        "a RECOVERY or TRANSFER Leg is not cancellable by a requester (§4.6 step 5); only an authorised operator " +
          "may, and only by reassigning the custody obligation to another disposition",
      );
    }
    return pass();
  },
});

/**
 * §4.6 rule 2's guard as every *other* transition sees it — the one that makes a
 * mid-flight round abandon its decision when a cancellation lands.
 *
 * > A round that was mid-flight when cancellation landed therefore fails its conditional
 * > write and abandons its decision — the correct outcome, with no lost update — while
 * > the `RECOVERY` and `TRANSFER` Legs that cancellation itself creates remain able to
 * > progress.
 *
 * The exemption is not a loophole: without it, step 3's *mandated* recovery Leg is
 * blocked by the guard on a Task whose cancellation flag is, by definition, already set.
 *
 * @param {{ cancelRequestedAt: Date|null, purpose: string }} leg
 * @returns {{ ok: boolean, reason: string|null }}
 */
function cancellationGuard(leg) {
  if (!leg) return { ok: false, reason: "NO_LEG" };
  if (leg.cancelRequestedAt === null || leg.cancelRequestedAt === undefined) return { ok: true, reason: null };
  if (purpose.isCustodial(leg.purpose)) return { ok: true, reason: "CUSTODIAL_PURPOSE_EXEMPT" };
  return { ok: false, reason: "CANCELLATION_REQUESTED" };
}

function pass() {
  return { ok: true, reason: null, detail: null };
}

function fail(reason, detail) {
  return { ok: false, reason, detail: detail === undefined ? null : detail };
}

/**
 * A guard whose evidence the caller must supply. Absent evidence fails — §4.1 rule 3.
 */
function required(context, field, reason) {
  const value = context ? context[field] : undefined;
  if (value === true) return pass();
  if (value === false) return fail(reason, `${field} was evaluated and did not hold`);
  return fail(
    `${reason}_INDETERMINATE`,
    `${field} was not supplied. §4.1 rule 3: state is never inferred from the absence of data — absence triggers ` +
      "investigation, not assumption.",
  );
}

/**
 * Find §4.4's row for a `(from, event)` pair.
 *
 * @param {string} from
 * @param {string} event
 * @returns {object|null}
 */
function find(from, event) {
  const exact = TRANSITIONS.find((row) => matchesSource(row.from, from) && row.event === event && row.from !== ANY_NON_TERMINAL);
  if (exact) return exact;
  return (
    TRANSITIONS.find(
      (row) => row.from === ANY_NON_TERMINAL && row.event === event && !legMachine.isTerminal(from),
    ) || null
  );
}

function matchesSource(source, from) {
  if (source === ANY_NON_TERMINAL) return false;
  if (Array.isArray(source)) return source.includes(from);
  return source === from;
}

/**
 * Resolve a row's target state against the context.
 *
 * @param {object} row
 * @param {object} context
 * @returns {string}
 */
function targetOf(row, context) {
  return typeof row.to === "function" ? row.to(context) : row.to;
}

/**
 * Evaluate every guard on a row. **None short-circuits** — the same discipline
 * `commitment/guards.js` applies, and for the same reason: a decision record should
 * state what was checked as well as what failed.
 *
 * @param {object} row
 * @param {object} context
 * @returns {{ ok: boolean, verdicts: object[], failures: object[] }}
 */
function evaluateGuards(row, context) {
  const verdicts = [];
  for (const guard of row.guards || []) {
    const evaluator = GUARD_EVALUATORS[guard];
    if (!evaluator) {
      verdicts.push({ guard, ok: false, reason: "GUARD_NOT_IMPLEMENTED", detail: guard });
      continue;
    }
    const verdict = evaluator(context || {});
    verdicts.push({ guard, ...verdict });
  }
  const failures = verdicts.filter((verdict) => !verdict.ok);
  return { ok: failures.length === 0, verdicts, failures };
}

/** What `apply` can return. @structural outcome labels */
const OUTCOME = Object.freeze({
  APPLIED: "APPLIED",
  REFUSED: "REFUSED",
  LOST_RACE: "LOST_RACE",
  NO_SUCH_TRANSITION: "NO_SUCH_TRANSITION",
});

/**
 * Apply one §4.4 transition: guards, the conditional write, and the timer obligations —
 * all inside the caller's transaction.
 *
 * The three parts are inseparable and that is the point. §4.1 rule 2 makes the write
 * conditional; §4.5 makes the timer cancellation atomic with the exit and the
 * registration atomic with the entry; and doing any of them in a second transaction
 * reintroduces the window each was written to close.
 *
 * The caller supplies `deadlineSeconds` — resolved from the target state's own
 * parameter, through the Config Service — because resolving configuration is not this
 * module's job and a default invented here would be a behavioural constant outside the
 * register (§22.1).
 *
 * @param {object} tx a Prisma transaction client
 * @param {object} input
 * @param {object} input.leg the current Leg row, read under lock by the caller
 * @param {string} input.event
 * @param {Date} input.storeTime
 * @param {number} [input.deadlineSeconds] the target state's deadline; required when the
 *   target state requires a timer
 * @param {object} [input.context] guard evidence
 * @param {object} [input.data] extra columns to write with the transition
 * @param {string} [input.shardId]
 * @returns {Promise<object>}
 */
async function apply(tx, input) {
  const source = input || {};
  const leg = source.leg;
  const context = { ...(source.context || {}), leg, expectedVersion: source.context ? source.context.expectedVersion : undefined };

  if (context.expectedVersion === undefined) context.expectedVersion = leg ? leg.version : undefined;

  const row = find(leg ? leg.state : undefined, source.event);
  if (!row) {
    return {
      outcome: OUTCOME.NO_SUCH_TRANSITION,
      reason: "NO_SUCH_TRANSITION",
      detail: `§4.4 has no row for (${String(leg && leg.state)}, ${String(source.event)})`,
      verdicts: [],
    };
  }

  // §4.6 rule 2's guard applies to every transition that is not itself the cancellation
  // or a custodial recovery, and it is checked here rather than added to every row —
  // "Expressing it through the first-class `purpose` attribute rather than through an
  // ad-hoc flag is what keeps it consistent across every call site".
  if (source.event !== EVENT.CANCEL_REQUEST) {
    const cancel = cancellationGuard(leg);
    if (!cancel.ok) {
      return {
        outcome: OUTCOME.REFUSED,
        reason: "CANCELLATION_REQUESTED",
        detail: "§4.6 rule 2 — a round mid-flight when cancellation landed abandons its decision",
        verdicts: [],
      };
    }
  }

  const guardResult = evaluateGuards(row, context);
  if (!guardResult.ok) {
    const first = guardResult.failures[0];
    return {
      outcome: OUTCOME.REFUSED,
      reason: first.reason,
      detail: first.detail,
      verdicts: guardResult.verdicts,
    };
  }

  const target = targetOf(row, { ...context, ...(source.context || {}) });

  // §4.4's one non-durable row: a re-plan that selects a different agent for a SOFT
  // reservation writes nothing at all (§2.6).
  if (row.durable === false) {
    return {
      outcome: OUTCOME.APPLIED,
      reason: null,
      from: leg.state,
      to: target,
      durable: false,
      verdicts: guardResult.verdicts,
    };
  }

  const nextVersion = leg.version + 1;
  const written = await tx.leg.updateMany({
    where: { id: leg.id, version: leg.version },
    data: { state: target, version: nextVersion, ...(source.data || {}) },
  });

  if (written.count !== 1) {
    // Not an error: two supervisors acting on one entity is exactly what §12.4 says
    // happens, and the conditional write is what decides which of them wins.
    return {
      outcome: OUTCOME.LOST_RACE,
      reason: "LEG_VERSION_MOVED",
      detail: "another writer moved this Leg first; the conditional write is what makes that safe (§4.1 rule 2)",
      verdicts: guardResult.verdicts,
    };
  }

  // §4.5 — cancel on exit, register on entry, in this transaction.
  const cancelled = await timers.cancelFor(tx, {
    entityType: timers.ENTITY_TYPE.LEG,
    entityId: leg.id,
    storeTime: source.storeTime,
    reason: `EXITED_${leg.state}`,
  });

  let registered = null;
  if (legMachine.requiresTimer(target)) {
    if (!Number.isFinite(source.deadlineSeconds) || source.deadlineSeconds <= 0) {
      throw new RangeError(
        `entering ${target} requires a deadline (§4.5: "every deadline MUST be registered […] at the moment the ` +
          `state is entered"), and none was resolved. Its parameter is ` +
          `"${legMachine.deadlineFor(target).parameter}".`,
      );
    }
    registered = await timers.register(tx, {
      entityType: timers.ENTITY_TYPE.LEG,
      entityId: leg.id,
      state: target,
      entity: { ...leg, version: nextVersion },
      dueAt: timers.deadlineFrom(source.storeTime, source.deadlineSeconds),
      // Recorded on the row, because the re-arm needs it and `dueAt − createdAt` cannot
      // supply it for a row registered with a `dueAt` already in the past. For §4.3's two
      // *projected* deadlines it is the only durable record of what the plan projected.
      armedSeconds: source.deadlineSeconds,
      handler: legMachine.deadlineFor(target).onExpiry,
      payload: { from: leg.state, event: source.event },
      shardId: source.shardId,
    });
  }

  return {
    outcome: OUTCOME.APPLIED,
    reason: null,
    from: leg.state,
    to: target,
    via: row.via || null,
    scope: row.scope,
    effects: row.effects,
    version: nextVersion,
    timersCancelled: cancelled,
    timerRegistered: registered ? registered.timerKey : null,
    verdicts: guardResult.verdicts,
  };
}

/**
 * Which non-terminal states have no outgoing row in §4.4?
 *
 * The model-checking claim §24.2 asks for — *"every non-terminal state eventually
 * leaves under fair timer firing"* — needs this to be empty as its precondition. A state
 * with no outgoing transition cannot be left however fairly its timer fires.
 *
 * @returns {string[]}
 */
function statesWithoutExit() {
  const sourced = new Set();
  for (const row of TRANSITIONS) {
    if (row.from === ANY_NON_TERMINAL) {
      for (const state of Object.values(legMachine.LEG_STATE)) {
        if (!legMachine.isTerminal(state)) sourced.add(state);
      }
      continue;
    }
    for (const state of Array.isArray(row.from) ? row.from : [row.from]) sourced.add(state);
  }
  return Object.values(legMachine.LEG_STATE)
    .filter((state) => !legMachine.isTerminal(state))
    .filter((state) => !sourced.has(state))
    .sort();
}

/**
 * The rows this table adds beyond §4.4's own enumeration, with the §4.3 wording that
 * mandates each.
 *
 * Returned rather than asserted, for the reason `statesWithoutDeadline` gives: the suite
 * states the expected set, so a fourth row added later fails loudly rather than joining a
 * list nobody counts.
 *
 * @returns {Array<{ from: string, event: string, source: string }>}
 */
function sectionFourThreeSourcedRows() {
  return TRANSITIONS.filter((row) => row.source === SECTION_4_3_SOURCED).map((row) => ({
    from: typeof row.from === "function" ? "ANY_NON_TERMINAL" : String(row.from),
    event: row.event,
    source: row.source,
  }));
}

/**
 * §4.5's completeness claim, read the other way round: which §4.3 expiry actions name a
 * consequence that this table cannot perform?
 *
 * A Leg state whose deadline exists but whose only outgoing rows are the two wildcards
 * (`CANCEL_REQUEST`, `LEASE_EXPIRY`) has an expiry action with nowhere to go — the timer
 * fires, `find` returns the wildcard or nothing, and the deadline is undischargeable.
 * That was true of `ABORTING` and of `EN_ROUTE_DROP` before this remediation, and it is
 * the machine-checkable form of the gap.
 *
 * `REASSIGNING` is the one state that remains, and it is **correct** that it does: §4.3
 * names an action for it — *"escalate"* — and no target state, and §4.7's own answer to
 * where an exhausted chain goes is `SUSPENDED`, which is the *Task's* state and not one
 * §4.3 gives the Leg. `lifecycle/reassignment.js` reached that conclusion first and
 * `supervision/expiryActions.js` follows it: the Leg is escalated in place.
 *
 * Listing it is what distinguishes "acts without transitioning" from "cannot act at all",
 * which is the distinction `ABORTING` failed before this remediation.
 *
 * @returns {string[]}
 */
function statesWhoseExpiryHasNoDedicatedRow() {
  const wildcardOnly = [];
  for (const state of Object.values(legMachine.LEG_STATE)) {
    if (!legMachine.requiresTimer(state)) continue;
    const dedicated = TRANSITIONS.some((row) => row.from !== ANY_NON_TERMINAL && matchesSource(row.from, state));
    if (!dedicated) wildcardOnly.push(state);
  }
  return wildcardOnly.sort();
}

module.exports = {
  EVENT,
  WRITE_SCOPE,
  GUARD,
  SECTION_4_3_SOURCED,
  sectionFourThreeSourcedRows,
  statesWhoseExpiryHasNoDedicatedRow,
  GUARD_EVALUATORS,
  TRANSITIONS,
  ANY_NON_TERMINAL,
  OUTCOME,
  find,
  targetOf,
  evaluateGuards,
  cancellationGuard,
  leaseExpiryTarget,
  apply,
  statesWithoutExit,
};
