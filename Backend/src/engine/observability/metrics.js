"use strict";

/**
 * The §21.4 metric set — **Tier 1**.
 *
 * > Organised by what question they answer, because **a metric that answers no question
 * > will not be looked at**.
 *
 * So the registry below carries the question with the metric, and `assertCoverage()`
 * refuses an entry that names none. That is not decoration: the specification's own
 * organising principle is the question, and a registry that dropped it would be a list
 * of counters within a release.
 *
 * ── Seven groups, not six ───────────────────────────────────────────────────
 * §21.4 states **seven** groups — service quality, allocation quality, fleet health and
 * utilisation, constraint and capacity diagnostics, system health, human capacity and
 * escalation, and safety and integrity. The execution plan's checklist says "all six
 * groups". `IMPLEMENTATION_EXECUTION_PLAN.md` §0.1 settles which wins: *"Where this plan
 * and the specification appear to disagree, the specification wins and this plan is
 * defective."* All seven are implemented.
 *
 * ── Derivation, not instrumentation ─────────────────────────────────────────
 * Most of this set is computed by **reading the durable record**, not by counters
 * sprinkled through the producing code. That is a deliberate choice with three
 * consequences worth stating:
 *
 *   1. It needs no edit to `commitment/`, `dispatch/`, `supervision/`, or `solve/`.
 *      Phase 11's mandate is to modify only what Phase 11 needs, and a metric derived
 *      from `Round` and `DecisionRecordA` is as exact as one incremented at the site
 *      that wrote them — more so, because it cannot drift from the row.
 *   2. It cannot double-count on retry. A counter incremented in a transaction that
 *      later aborts has counted something that did not happen; a `GROUP BY` over the
 *      committed rows has not.
 *   3. It is replayable. The same window over the same rows yields the same numbers on
 *      any process, which is what makes an SLI reviewable months later.
 *
 * The exceptions are quantities no durable row records — request-path latencies, cache
 * hit rates, Explanation API sources — and those come from `sli.js`'s in-process
 * registry, which is advisory by §3.3 and says so.
 *
 * ── Two metrics that may never be derived from a cache ──────────────────────
 * §7.7's binding-constraint distribution is exact over 100 % of decisions because the
 * tuples are folded *before* Tier B sampling; it is read from `RejectionAggregate` and
 * never from a sampled record. And the invariant-violation count (§26) is produced by
 * the Invariant Checker, which "runs independently of the code paths that maintain
 * them" — this module declares the metric and names Phase 12 as its producer rather
 * than computing it from anything the enforcer wrote.
 */

const { compareStrings } = require("../determinism/ordering");
const sli = require("./sli");
const decisionRecord = require("./decisionRecord");

/** §21.4's seven groups, each with the question it exists to answer. */
const GROUP = Object.freeze({
  SERVICE_QUALITY: "SERVICE_QUALITY",
  ALLOCATION_QUALITY: "ALLOCATION_QUALITY",
  FLEET_HEALTH: "FLEET_HEALTH",
  CONSTRAINT_DIAGNOSTICS: "CONSTRAINT_DIAGNOSTICS",
  SYSTEM_HEALTH: "SYSTEM_HEALTH",
  HUMAN_CAPACITY: "HUMAN_CAPACITY",
  SAFETY_AND_INTEGRITY: "SAFETY_AND_INTEGRITY",
});

const GROUPS = Object.freeze([
  { id: GROUP.SERVICE_QUALITY, title: "Service quality (customer-facing SLIs)", question: "Is the customer getting what was promised?" },
  { id: GROUP.ALLOCATION_QUALITY, title: "Allocation quality", question: "Is the engine making good decisions, and how would we know?" },
  { id: GROUP.FLEET_HEALTH, title: "Fleet health and utilisation", question: "Is the fleet being used well and staying healthy?" },
  { id: GROUP.CONSTRAINT_DIAGNOSTICS, title: "Constraint and capacity diagnostics", question: "What is the fleet blocked on, and by how much?" },
  { id: GROUP.SYSTEM_HEALTH, title: "System health", question: "Is the machinery itself keeping up?" },
  { id: GROUP.HUMAN_CAPACITY, title: "Human capacity and escalation", question: "Is there anyone behind the last two rungs of the ladder?" },
  { id: GROUP.SAFETY_AND_INTEGRITY, title: "Safety and integrity", question: "Is anything unsafe or unaccounted for, and would we see it?" },
]);

/** Where a metric's value comes from. */
const SOURCE = Object.freeze({
  /** A `GROUP BY` over the durable record. Exact, replayable, retry-safe. */
  DURABLE: "DURABLE",
  /** `sli.js`'s in-process registry, published advisory to `engine:sli:*` (§3.3). */
  REGISTRY: "REGISTRY",
  /** §7.7's aggregate, folded at decision time and exact over 100 % of decisions. */
  REJECTION_AGGREGATE: "REJECTION_AGGREGATE",
  /** The Invariant Checker, deliberately independent of the enforcing code (§26). */
  INVARIANT_CHECKER: "INVARIANT_CHECKER",
  /** The Config Service's own register view (§22.4). */
  CONFIG_REGISTER: "CONFIG_REGISTER",
});

/**
 * The metric set. One entry per quantity §21.4 names; compound bullets are split,
 * because "commit transaction rate, abort rate, and abort reasons" is three questions
 * with three different answers.
 *
 * `producer` names the phase that supplies the metric's inputs. An entry whose producer
 * has not landed is declared and reported as `null`, never as zero: a metric reporting
 * zero because nothing feeds it is indistinguishable from a system that is behaving,
 * and that is the failure mode an observability phase is least entitled to ship.
 */
const METRICS = Object.freeze([
  /* ── Service quality ────────────────────────────────────────────────────── */
  { id: "intake_to_offer", group: GROUP.SERVICE_QUALITY, unit: "ms", source: SOURCE.REGISTRY, dimensions: ["slaClass", "zone"],
    question: "How long does a customer wait before an agent is offered the work?", producer: "Phase 10 intake + Phase 4 dispatch" },
  { id: "intake_to_first_movement", group: GROUP.SERVICE_QUALITY, unit: "ms", source: SOURCE.REGISTRY, dimensions: ["slaClass", "zone"],
    question: "How long before something physically starts happening?", producer: "Phase 5 progress supervision" },
  { id: "sla_attainment", group: GROUP.SERVICE_QUALITY, unit: "ratio", source: SOURCE.DURABLE, dimensions: ["slaClass", "tenant"],
    question: "Are we meeting the contract?", producer: "Phase 5 settlement" },
  { id: "lateness_distribution", group: GROUP.SERVICE_QUALITY, unit: "s", source: SOURCE.DURABLE, dimensions: ["slaClass", "tenant"],
    question: "When we are late, by how much?", producer: "Phase 5 settlement" },
  { id: "completion_rate", group: GROUP.SERVICE_QUALITY, unit: "ratio", source: SOURCE.DURABLE, dimensions: ["slaClass"],
    question: "What fraction of work completes?", producer: "Phase 5 settlement" },
  { id: "reassignment_rate", group: GROUP.SERVICE_QUALITY, unit: "ratio", source: SOURCE.DURABLE, dimensions: ["slaClass"],
    question: "How often does work change hands after it was committed?", producer: "Phase 5 reassignment" },
  { id: "decline_rate", group: GROUP.SERVICE_QUALITY, unit: "ratio", source: SOURCE.DURABLE, dimensions: ["reason"],
    question: "How often does an agent refuse an offer, and why?", producer: "Phase 4 offer semantics" },
  { id: "eta_accuracy", group: GROUP.SERVICE_QUALITY, unit: "s", source: SOURCE.DURABLE, dimensions: ["slaClass", "zone"],
    question: "Is the ETA we quoted the one that happened?", producer: "Phase 11 calibration (§21.5)" },

  /* ── Allocation quality ─────────────────────────────────────────────────── */
  { id: "cost_per_mission", group: GROUP.ALLOCATION_QUALITY, unit: "milli-CU", source: SOURCE.DURABLE, dimensions: ["term", "missionClass"],
    question: "What does a mission cost, and which term dominates?", producer: "Phase 11 Tier A cost totals" },
  { id: "realised_versus_predicted_cost", group: GROUP.ALLOCATION_QUALITY, unit: "milli-CU", source: SOURCE.DURABLE, dimensions: ["missionClass"],
    question: "Was the price we decided on the price we paid?", producer: "Phase 11 calibration" },
  { id: "search_gap", group: GROUP.ALLOCATION_QUALITY, unit: "milli-CU", source: SOURCE.DURABLE, dimensions: ["shard"],
    question: "How much could candidate-set truncation have cost us?", producer: "Phase 9 admissible bound",
    note: "Reported separately from the column-generation gap and never summed: §9.3 — they bound different approximations and a single combined figure would bound neither." },
  { id: "column_generation_gap", group: GROUP.ALLOCATION_QUALITY, unit: "milli-CU", source: SOURCE.DURABLE, dimensions: ["shard"],
    question: "How much could a poor column set have cost us?", producer: "Phase 11 counterfactual evaluator (§21.6)",
    note: "The one approximation the in-round machinery cannot bound for itself." },
  { id: "cells_visited_from_omega", group: GROUP.ALLOCATION_QUALITY, unit: "count", source: SOURCE.DURABLE, dimensions: ["shard"],
    question: "Are the Ω admissibility corrections costing us search?", producer: "Phase 9 Ω corrections",
    note: "§21.4: a large value means policy credit ceilings exceed their realised use and should be tightened." },
  { id: "budget_limited_fraction", group: GROUP.ALLOCATION_QUALITY, unit: "ratio", source: SOURCE.DURABLE, dimensions: ["shard"],
    question: "How often does the solver run out of budget rather than out of work?", producer: "Phase 10 solve budgets" },
  { id: "rounds_by_regime", group: GROUP.ALLOCATION_QUALITY, unit: "ratio", source: SOURCE.DURABLE, dimensions: ["regime"],
    question: "Which regime are we actually solving in?", producer: "Phase 10 regime" },
  { id: "deferral_rate", group: GROUP.ALLOCATION_QUALITY, unit: "ratio", source: SOURCE.DURABLE, dimensions: ["shard"],
    question: "How often does the engine choose to wait?", producer: "Phase 16g (Tier 2, switched off)" },
  { id: "deferral_realised_benefit", group: GROUP.ALLOCATION_QUALITY, unit: "milli-CU", source: SOURCE.DURABLE, dimensions: ["shard"],
    question: "Did waiting actually help?", producer: "Phase 16g (Tier 2, switched off)" },
  { id: "preemption_rate", group: GROUP.ALLOCATION_QUALITY, unit: "ratio", source: SOURCE.DURABLE, dimensions: ["shard"],
    question: "How often is an incumbent displaced?", producer: "Phase 16h (Tier 2, switched off)" },
  { id: "churn_rate", group: GROUP.ALLOCATION_QUALITY, unit: "ratio", source: SOURCE.DURABLE, dimensions: ["shard"],
    question: "How often does the rolling horizon revise itself?", producer: "Phase 8 C_churn" },
  { id: "churn_cost_fraction", group: GROUP.ALLOCATION_QUALITY, unit: "ratio", source: SOURCE.DURABLE, dimensions: ["shard"],
    question: "What share of total cost is hysteresis?", producer: "Phase 8 C_churn" },
  { id: "counterfactual_regret", group: GROUP.ALLOCATION_QUALITY, unit: "milli-CU", source: SOURCE.DURABLE, dimensions: ["shard"],
    question: "What did our own approximations cost, measured against a relaxed re-solve?", producer: "Phase 11 counterfactual evaluator" },

  /* ── Fleet health and utilisation ───────────────────────────────────────── */
  { id: "duty_cycle_distribution", group: GROUP.FLEET_HEALTH, unit: "ratio", source: SOURCE.DURABLE, dimensions: ["agentClass"],
    question: "Is work spread across the fleet?", producer: "Phase 16 duty-cycle regulariser (Tier 2)" },
  { id: "duty_cycle_gini", group: GROUP.FLEET_HEALTH, unit: "ratio", source: SOURCE.DURABLE, dimensions: ["shard"],
    question: "How unequal is that spread, in one number?", producer: "Phase 16 duty-cycle regulariser (Tier 2)" },
  { id: "idle_time_by_cause", group: GROUP.FLEET_HEALTH, unit: "s", source: SOURCE.DURABLE,
    dimensions: ["cause: NO_DEMAND | INFEASIBLE | UNAVAILABLE | CHARGING | QUARANTINED"],
    question: "Why is that agent not working?", producer: "Phase 9 availability index + Phase 6 feasibility",
    note: "§21.4: the cause breakdown is what makes this metric actionable rather than merely interesting." },
  { id: "energy_per_mission", group: GROUP.FLEET_HEALTH, unit: "Wh", source: SOURCE.DURABLE, dimensions: ["agentClass", "zone"],
    question: "What does a mission cost in watt-hours?", producer: "Phase 7 energy model" },
  { id: "charge_wait_time", group: GROUP.FLEET_HEALTH, unit: "s", source: SOURCE.DURABLE, dimensions: ["site"],
    question: "How long do agents queue for a charger?", producer: "Phase 7 charging scheduler client" },
  { id: "charger_contention", group: GROUP.FLEET_HEALTH, unit: "ratio", source: SOURCE.DURABLE, dimensions: ["site"],
    question: "Are there enough chargers?", producer: "Phase 7 charger reservations" },
  { id: "health_tier_distribution", group: GROUP.FLEET_HEALTH, unit: "count", source: SOURCE.DURABLE, dimensions: ["tier"],
    question: "How healthy is the fleet?", producer: "Phase 16c reliability (Tier 2)" },
  { id: "quarantine_rate", group: GROUP.FLEET_HEALTH, unit: "ratio", source: SOURCE.DURABLE, dimensions: ["agentClass"],
    question: "How often is an agent taken out of service automatically?", producer: "Phase 16c reliability (Tier 2)" },
  { id: "intervention_rate_per_km", group: GROUP.FLEET_HEALTH, unit: "km⁻¹", source: SOURCE.DURABLE, dimensions: ["agentClass"],
    question: "How often does a human have to touch a robot?", producer: "Phase 16c reliability (Tier 2)" },

  /* ── Constraint and capacity diagnostics ────────────────────────────────── */
  { id: "rejection_histogram", group: GROUP.CONSTRAINT_DIAGNOSTICS, unit: "count", source: SOURCE.REJECTION_AGGREGATE,
    dimensions: ["predicate", "zone", "class", "agent"],
    question: "What is blocking this zone?", producer: "Phase 6 rejection telemetry",
    note: "Exact over 100 % of decisions: the tuples are folded before Tier B sampling (§7.7, §21.2)." },
  { id: "near_miss_margins", group: GROUP.CONSTRAINT_DIAGNOSTICS, unit: "predicate-specific", source: SOURCE.REJECTION_AGGREGATE,
    dimensions: ["predicate", "marginUnit"],
    question: "By how much is it blocked — a config change or capital spend?", producer: "Phase 6 rejection telemetry" },
  { id: "feasible_candidate_count", group: GROUP.CONSTRAINT_DIAGNOSTICS, unit: "count", source: SOURCE.DURABLE, dimensions: ["zone", "class"],
    question: "How much choice does the solver actually have?", producer: "Phase 11 Tier A bounds" },
  { id: "zero_feasible_fraction", group: GROUP.CONSTRAINT_DIAGNOSTICS, unit: "ratio", source: SOURCE.DURABLE, dimensions: ["zone", "class"],
    question: "How often is there no eligible agent at all?", producer: "Phase 11 Tier A outcomes" },
  { id: "indeterminate_rate", group: GROUP.CONSTRAINT_DIAGNOSTICS, unit: "ratio", source: SOURCE.REJECTION_AGGREGATE, dimensions: ["predicate"],
    question: "How often can a predicate not decide?", producer: "Phase 6 three-valued evaluation" },

  /* ── System health ──────────────────────────────────────────────────────── */
  { id: "round_time_by_stage", group: GROUP.SYSTEM_HEALTH, unit: "ms", source: SOURCE.REGISTRY, dimensions: ["stage"],
    question: "Where does a round spend its time?", producer: "Phase 10 round loop" },
  { id: "queue_depth", group: GROUP.SYSTEM_HEALTH, unit: "count", source: SOURCE.DURABLE, dimensions: ["shard"],
    question: "How much work is waiting?", producer: "Phase 10 work queue" },
  { id: "queue_oldest_age", group: GROUP.SYSTEM_HEALTH, unit: "s", source: SOURCE.DURABLE, dimensions: ["shard"],
    question: "How long has the oldest waiting item waited?", producer: "Phase 10 work queue" },
  { id: "routing_cache_hit_rate", group: GROUP.SYSTEM_HEALTH, unit: "ratio", source: SOURCE.REGISTRY, dimensions: ["population"],
    question: "Is the routing cache doing its job?", producer: "Phase 8 cell-pair cache" },
  { id: "dependency_latency", group: GROUP.SYSTEM_HEALTH, unit: "ms", source: SOURCE.REGISTRY, dimensions: ["dependency"],
    question: "Which dependency is slow?", producer: "Phase 12 dependency registry" },
  { id: "dependency_error_rate", group: GROUP.SYSTEM_HEALTH, unit: "ratio", source: SOURCE.REGISTRY, dimensions: ["dependency"],
    question: "Which dependency is failing?", producer: "Phase 12 dependency registry" },
  { id: "circuit_breaker_state", group: GROUP.SYSTEM_HEALTH, unit: "state", source: SOURCE.REGISTRY, dimensions: ["dependency"],
    question: "What have we stopped calling?", producer: "Phase 12 circuit breakers" },
  { id: "commit_rate", group: GROUP.SYSTEM_HEALTH, unit: "min⁻¹", source: SOURCE.DURABLE, dimensions: ["shard"],
    question: "How fast is the serial section running?", producer: "Phase 3 commit" },
  { id: "commit_abort_rate", group: GROUP.SYSTEM_HEALTH, unit: "ratio", source: SOURCE.DURABLE, dimensions: ["shard"],
    question: "How often does a commit fail?", producer: "Phase 3 commit" },
  { id: "commit_abort_reasons", group: GROUP.SYSTEM_HEALTH, unit: "count", source: SOURCE.DURABLE, dimensions: ["reason"],
    question: "Which guard is aborting them?", producer: "Phase 3 guards G1–G6" },
  { id: "outbox_depth", group: GROUP.SYSTEM_HEALTH, unit: "count", source: SOURCE.DURABLE, dimensions: ["shard"],
    question: "How many commands are undelivered?", producer: "Phase 4 outbox" },
  { id: "outbox_oldest_undelivered_age", group: GROUP.SYSTEM_HEALTH, unit: "s", source: SOURCE.DURABLE, dimensions: ["shard"],
    question: "How long has the oldest one waited?", producer: "Phase 4 outbox" },
  { id: "ack_latency", group: GROUP.SYSTEM_HEALTH, unit: "ms", source: SOURCE.REGISTRY, dimensions: ["commandClass"],
    question: "How quickly do agents acknowledge?", producer: "Phase 4 ACK correlation" },
  { id: "nack_rate", group: GROUP.SYSTEM_HEALTH, unit: "ratio", source: SOURCE.REGISTRY, dimensions: ["commandClass"],
    question: "How often do they refuse?", producer: "Phase 4 offer semantics" },
  { id: "lease_expiry_rate", group: GROUP.SYSTEM_HEALTH, unit: "min⁻¹", source: SOURCE.DURABLE, dimensions: ["shard"],
    question: "How often does supervision lose contact?", producer: "Phase 5 leases" },
  { id: "reconciler_repair_rate", group: GROUP.SYSTEM_HEALTH, unit: "min⁻¹", source: SOURCE.DURABLE, dimensions: ["category"],
    question: "What is the reconciler having to fix, and how often?", producer: "Phase 5 reconciler",
    note: "T10 — a repair rate that is not broken down by category tells you something is wrong and nothing about what." },
  { id: "timer_store_lag", group: GROUP.SYSTEM_HEALTH, unit: "ms", source: SOURCE.DURABLE, dimensions: ["shard"],
    question: "Are timers firing on time?", producer: "Phase 5 timer worker" },
  { id: "degraded_mode_time", group: GROUP.SYSTEM_HEALTH, unit: "s", source: SOURCE.DURABLE, dimensions: ["mode", "entryCause"],
    question: "How long have we been degraded, and in what way?", producer: "Phase 12 degraded-mode register" },
  { id: "suspensions_over_time_box", group: GROUP.SYSTEM_HEALTH, unit: "count", source: SOURCE.DURABLE, dimensions: ["mode", "invariant"],
    question: "Has any invariant suspension outlived the mode that authorised it?", producer: "Phase 12 degraded-mode register" },
  { id: "cell_pair_cache_hit_rate", group: GROUP.SYSTEM_HEALTH, unit: "ratio", source: SOURCE.REGISTRY, dimensions: ["shard"],
    question: "Is the approach-routing cache warm?", producer: "Phase 8 cell-pair cache",
    note: "Reported separately from charger reachability: a drop confined to one has a different cause and a different fix (§20.3)." },
  { id: "charger_reachability_cache_hit_rate", group: GROUP.SYSTEM_HEALTH, unit: "ratio", source: SOURCE.REGISTRY, dimensions: ["shard"],
    question: "Is the return-leg cache warm?", producer: "Phase 7 charger-reachability cache" },
  { id: "tier_a_write_rate", group: GROUP.SYSTEM_HEALTH, unit: "min⁻¹", source: SOURCE.DURABLE, dimensions: ["shard"],
    question: "How many decisions are we recording?", producer: "Phase 11" },
  { id: "tier_b_write_rate", group: GROUP.SYSTEM_HEALTH, unit: "min⁻¹", source: SOURCE.DURABLE, dimensions: ["shard", "writtenBecause"],
    question: "How much full-fidelity detail are we keeping, against the budget?", producer: "Phase 11" },
  { id: "tier_b_shedding_count", group: GROUP.SYSTEM_HEALTH, unit: "count", source: SOURCE.REGISTRY, dimensions: ["shard"],
    question: "How much exempt detail did we have to drop?", producer: "Phase 11 sampler",
    note: "§21.2: the shedding is itself recorded as a counted event — retention degrades visibly, not by arrival order." },
  { id: "explanation_answers_by_source", group: GROUP.SYSTEM_HEALTH, unit: "count", source: SOURCE.REGISTRY, dimensions: ["source"],
    question: "How many explanations are read versus recomputed?", producer: "Phase 11 Explanation API" },
  { id: "dedup_generation_advance_rate", group: GROUP.SYSTEM_HEALTH, unit: "min⁻¹", source: SOURCE.DURABLE, dimensions: ["agentClass"],
    question: "Is agent non-volatile storage actually durable?", producer: "Phase 4 dedup handshake",
    note: "§21.4: a rising rate means storage that is not actually durable, which is invisible in every other signal." },
  { id: "kill_switches_thrown", group: GROUP.SYSTEM_HEALTH, unit: "count", source: SOURCE.CONFIG_REGISTER, dimensions: ["switch"],
    question: "What have we turned off?", producer: "Phase 1 kill-switch registry" },
  { id: "unrehearsed_combination_time", group: GROUP.SYSTEM_HEALTH, unit: "s", source: SOURCE.CONFIG_REGISTER, dimensions: ["combination"],
    question: "Are we running a switch combination nobody has rehearsed?", producer: "Phase 1 kill-switch ladder" },
  { id: "active_regime", group: GROUP.SYSTEM_HEALTH, unit: "state", source: SOURCE.CONFIG_REGISTER, dimensions: ["region"],
    question: "Which parameter set is in force here?", producer: "Phase 1 operating regimes" },
  { id: "regime_calibration_age", group: GROUP.SYSTEM_HEALTH, unit: "s", source: SOURCE.CONFIG_REGISTER, dimensions: ["region"],
    question: "When was it last calibrated?", producer: "Phase 1 operating regimes" },

  /* ── Human capacity and escalation ──────────────────────────────────────── */
  { id: "outstanding_escalations", group: GROUP.HUMAN_CAPACITY, unit: "count", source: SOURCE.DURABLE, dimensions: ["region"],
    question: "Is there capacity behind the ladder's last two steps?", producer: "Phase 12 escalation ladder",
    note: "§17.4: the ladder's guarantee is only as good as the capacity behind its last two steps." },
  { id: "escalation_saturation_time", group: GROUP.HUMAN_CAPACITY, unit: "s", source: SOURCE.DURABLE, dimensions: ["region"],
    question: "How long have we been out of human capacity?", producer: "Phase 12 escalation ladder" },
  { id: "ladder_step_distribution", group: GROUP.HUMAN_CAPACITY, unit: "count", source: SOURCE.DURABLE, dimensions: ["step", "class", "zone"],
    question: "How far up the ladder are Legs getting before resolution?", producer: "Phase 12 escalation ladder" },
  { id: "deadzone_extensions_granted", group: GROUP.HUMAN_CAPACITY, unit: "count", source: SOURCE.DURABLE, dimensions: ["region"],
    question: "How often are we extending a lease into a dead zone?", producer: "Phase 12 A3 handling" },
  { id: "deadzone_extensions_at_cap", group: GROUP.HUMAN_CAPACITY, unit: "count", source: SOURCE.DURABLE, dimensions: ["region"],
    question: "How many reach connectivity.max_deadzone_extension?", producer: "Phase 12 A3 handling" },
  { id: "deadzone_extensions_unclosed", group: GROUP.HUMAN_CAPACITY, unit: "count", source: SOURCE.DURABLE, dimensions: ["region"],
    question: "How many were never closed by a corroborated exit?", producer: "Phase 12 A3 handling" },
  { id: "parameters_by_calibration_status", group: GROUP.HUMAN_CAPACITY, unit: "count", source: SOURCE.CONFIG_REGISTER, dimensions: ["status"],
    question: "How much of the register has anyone actually looked at?", producer: "Phase 1 calibration status" },
  { id: "safety_class_not_derived", group: GROUP.HUMAN_CAPACITY, unit: "count", source: SOURCE.CONFIG_REGISTER, dimensions: [],
    question: "Is any Safety-class parameter still a placeholder?", producer: "Phase 1 calibration status",
    note: "§22.4: this MUST be zero in production. Phase 15 owns the gate; the count is live from now." },

  /* ── Safety and integrity ───────────────────────────────────────────────── */
  { id: "fence_rejections_commitment_scope", group: GROUP.SAFETY_AND_INTEGRITY, unit: "count", source: SOURCE.DURABLE, dimensions: ["shard"],
    question: "How often is a commitment-scoped command refused as stale?", producer: "Phase 4 fencing",
    note: "§21.4 requires the two scopes reported separately: they fail for entirely different reasons, so a combined counter would hide both." },
  { id: "fence_rejections_agent_scope", group: GROUP.SAFETY_AND_INTEGRITY, unit: "count", source: SOURCE.DURABLE, dimensions: ["shard"],
    question: "How often is an agent-scoped command refused as stale?", producer: "Phase 4 fencing" },
  { id: "energy_shortfall_events_by_tier", group: GROUP.SAFETY_AND_INTEGRITY, unit: "events·yr⁻¹", source: SOURCE.DURABLE, dimensions: ["tier"],
    question: "Is the realised shortfall rate inside its budget?", producer: "Phase 7 energy tiers",
    note: "Invariant I17, composed to a fleet-year rate and compared against energy.event_budget_per_fleet_year[tier]." },
  { id: "stranding_events_by_obstruction_class", group: GROUP.SAFETY_AND_INTEGRITY, unit: "count", source: SOURCE.DURABLE, dimensions: ["obstructionClass"],
    question: "How often are we stranded, and where does it block?", producer: "Phase 12 obstruction classification" },
  { id: "stranding_response_time", group: GROUP.SAFETY_AND_INTEGRITY, unit: "s", source: SOURCE.DURABLE, dimensions: ["obstructionClass"],
    question: "How quickly do we clear one?", producer: "Phase 12 external escalation",
    note: "§4.3, §18.6 — STRANDED_OBSTRUCTING response time is a safety SLI, not an operations one." },
  { id: "charger_projection_error", group: GROUP.SAFETY_AND_INTEGRITY, unit: "ratio", source: SOURCE.DURABLE, dimensions: ["site"],
    question: "Was the charger we computed E_return against actually free?", producer: "Phase 7 charger projection",
    note: "§14.5 — the measured cost of the fixed-point-free approximation." },
  { id: "implausible_observation_rate", group: GROUP.SAFETY_AND_INTEGRITY, unit: "ratio", source: SOURCE.DURABLE, dimensions: ["agentClass"],
    question: "How often does an agent tell us something impossible?", producer: "Phase 5 verification" },
  { id: "verification_failure_rate", group: GROUP.SAFETY_AND_INTEGRITY, unit: "ratio", source: SOURCE.DURABLE, dimensions: ["level"],
    question: "How often does a completion claim fail its evidence test?", producer: "Phase 5 verification" },
  { id: "payload_discrepancy_rate", group: GROUP.SAFETY_AND_INTEGRITY, unit: "ratio", source: SOURCE.DURABLE, dimensions: ["missionClass"],
    question: "How often does the manifest disagree with reality?", producer: "Phase 7 custody evidence" },
  { id: "invariant_violations", group: GROUP.SAFETY_AND_INTEGRITY, unit: "count", source: SOURCE.INVARIANT_CHECKER, dimensions: ["invariant"],
    question: "Is anything the design forbids actually happening?", producer: "Phase 12 invariant checker",
    note: "§26: this MUST be zero, and any non-zero value is a page. Sourced from the independent checker, never from the enforcing path." },
]);

const METRIC_BY_ID = Object.freeze(METRICS.reduce((index, row) => Object.assign(index, { [row.id]: row }), Object.create(null)));

/**
 * Refuse a malformed metric set: seven groups, every group non-empty, every metric with
 * a question, a unit, a source, and a named producer.
 *
 * @returns {{ ok: boolean, problems: string[], byGroup: Record<string, number> }}
 */
function assertCoverage() {
  const problems = [];
  const byGroup = Object.fromEntries(GROUPS.map((group) => [group.id, 0]));

  for (const metric of METRICS) {
    if (!Object.prototype.hasOwnProperty.call(byGroup, metric.group)) {
      problems.push(`${metric.id}: group "${metric.group}" is not one of §21.4's seven`);
      continue;
    }
    byGroup[metric.group] += 1;
    if (!metric.question) problems.push(`${metric.id}: names no question. §21.4: "a metric that answers no question will not be looked at"`);
    if (!metric.unit) problems.push(`${metric.id}: names no unit`);
    if (!Object.values(SOURCE).includes(metric.source)) problems.push(`${metric.id}: source "${metric.source}" is not a declared source`);
    if (!metric.producer) problems.push(`${metric.id}: names no producer, so a null reading cannot be told from an unfed one`);
  }

  for (const group of GROUPS) {
    if (byGroup[group.id] === 0) problems.push(`group ${group.id} has no metrics`);
  }

  return { ok: problems.length === 0, problems, byGroup };
}

/** @structural milliseconds per second, for turning an age into seconds */
const MS_PER_SECOND = 1000;

/** @structural milliseconds per minute, for turning a count into a per-minute rate */
const MS_PER_MINUTE = 60000;

/**
 * A reading. `value === null` with a stated `unavailableBecause` is the honest answer
 * for a metric whose producer has not landed; zero would not be.
 *
 * @param {string} id
 * @param {*} value
 * @param {object} [extra]
 * @returns {object}
 */
function reading(id, value, extra) {
  const metric = METRIC_BY_ID[id];
  return {
    id,
    group: metric ? metric.group : null,
    unit: metric ? metric.unit : null,
    source: metric ? metric.source : null,
    question: metric ? metric.question : null,
    value: value === undefined ? null : value,
    ...(extra || {}),
  };
}

/**
 * Derive every metric whose producer has landed, from the durable record.
 *
 * @param {object} deps `{ prisma, kv }`
 * @param {object} input `{ shardId, fromMs, toMs, registry, config, killSwitches }`
 * @returns {Promise<{ window: object, readings: object[], unavailable: object[] }>}
 */
async function derive(deps, input) {
  const source = input || {};
  const toMs = Number.isFinite(source.toMs) ? source.toMs : Date.now();
  const fromMs = Number.isFinite(source.fromMs) ? source.fromMs : toMs - MS_PER_MINUTE;
  const windowMinutes = Math.max(1, (toMs - fromMs) / MS_PER_MINUTE);
  const from = new Date(fromMs);
  const to = new Date(toMs);
  const shardFilter = source.shardId ? { shardId: source.shardId } : {};

  // Every read of a decision record carries the production filter. §21.6's shadow runs
  // write decisions that were "recorded and never executed"; one that entered a write
  // rate, an abort rate, or a regime distribution would make an SLI describe a world the
  // fleet never operated in. The filter is a shared constant rather than a literal here
  // precisely so that it is one thing to check — `observabilityShadowAudit.test.js`
  // source-scans every `decisionRecordA` query in this phase for it.
  const decisionFilter = { ...shardFilter, ...decisionRecord.PRODUCTION_ONLY };

  const readings = [];
  const unavailable = [];
  const failures = [];

  /**
   * Run one derivation, and record a failure rather than throwing: a metrics surface
   * that fails whole because one query failed is a metrics surface nobody trusts during
   * the incident it exists for.
   */
  const attempt = async (id, fn) => {
    try {
      const value = await fn();
      if (value !== undefined) readings.push(value);
    } catch (error) {
      failures.push({ id, message: error && error.message });
      unavailable.push(reading(id, null, { unavailableBecause: "the derivation query failed" }));
    }
  };

  if (deps && deps.prisma) {
    /* ── Decision-record volume (§21.4 System health) ───────────────────────── */
    await attempt("tier_a_write_rate", async () => {
      const count = await deps.prisma.decisionRecordA.count({ where: { ...decisionFilter, decisionTime: { gte: from, lt: to } } });
      return reading("tier_a_write_rate", count / windowMinutes, { count, windowMinutes });
    });

    await attempt("tier_b_write_rate", async () => {
      const rows = await deps.prisma.decisionRecordB.groupBy({
        by: ["writtenBecause"],
        where: { ...shardFilter, decisionTime: { gte: from, lt: to } },
        _count: { _all: true },
      });
      const total = rows.reduce((sum, row) => sum + Number(row._count._all || 0), 0);
      const budget = source.config && typeof source.config.get === "function" ? source.config.get("observability.tier_b_write_budget") : null;
      return reading("tier_b_write_rate", total / windowMinutes, {
        byWrittenBecause: Object.fromEntries(rows.map((row) => [row.writtenBecause, Number(row._count._all || 0)])),
        budgetPerMinute: Number.isFinite(budget) ? budget : null,
        withinBudget: Number.isFinite(budget) ? total / windowMinutes <= budget : null,
      });
    });

    /* ── Round-level allocation quality ─────────────────────────────────────── */
    await attempt("rounds_by_regime", async () => {
      const rows = await deps.prisma.round.groupBy({
        by: ["regime"],
        where: { ...shardFilter, decisionTime: { gte: from, lt: to } },
        _count: { _all: true },
      });
      const total = rows.reduce((sum, row) => sum + Number(row._count._all || 0), 0);
      return reading("rounds_by_regime", total === 0 ? null : Object.fromEntries(rows.map((row) => [row.regime, Number(row._count._all || 0) / total])), {
        rounds: total,
      });
    });

    await attempt("budget_limited_fraction", async () => {
      const rounds = await deps.prisma.round.findMany({
        where: { ...shardFilter, decisionTime: { gte: from, lt: to } },
        select: { budgets: true, searchGapMilliCU: true },
      });
      if (rounds.length === 0) return reading("budget_limited_fraction", null, { rounds: 0 });
      const limited = rounds.filter((row) => row.budgets && row.budgets.budgetLimited === true).length;
      return reading("budget_limited_fraction", limited / rounds.length, { rounds: rounds.length, limited });
    });

    await attempt("search_gap", async () => {
      const rounds = await deps.prisma.round.findMany({
        where: { ...shardFilter, decisionTime: { gte: from, lt: to } },
        select: { searchGapMilliCU: true, lpIpGapMilliCU: true },
      });
      if (rounds.length === 0) return reading("search_gap", null, { rounds: 0 });
      // Kept as integer milli-CU strings all the way out. §9.6 requirement 1.
      const gaps = rounds.map((row) => BigInt(row.searchGapMilliCU || "0")).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      // @structural the divisor in the definition of a median, not a threshold
      const MEDIAN_DIVISOR = 2;
      return reading("search_gap", gaps[Math.floor(gaps.length / MEDIAN_DIVISOR)].toString(), {
        rounds: gaps.length,
        maxMilliCU: gaps[gaps.length - 1].toString(),
        statistic: "median, in milli-CU",
        reportedSeparatelyFrom: "column_generation_gap",
      });
    });

    /* ── Commit health (§21.4 System health) ────────────────────────────────── */
    await attempt("commit_abort_rate", async () => {
      const rows = await deps.prisma.decisionRecordA.findMany({
        where: { ...decisionFilter, decisionTime: { gte: from, lt: to } },
        select: { outcome: true },
      });
      if (rows.length === 0) return reading("commit_abort_rate", null, { decisions: 0 });
      const aborted = rows.filter((row) => row.outcome && row.outcome.outcome === "COMMIT_ABORTED");
      const reasons = new Map();
      for (const row of aborted) {
        const reason = (row.outcome && row.outcome.commitAbortReason) || "UNSTATED";
        reasons.set(reason, (reasons.get(reason) || 0) + 1);
      }
      readings.push(
        reading("commit_abort_reasons", Object.fromEntries([...reasons.entries()].sort((a, b) => compareStrings(a[0], b[0]))), {
          aborted: aborted.length,
        }),
      );
      return reading("commit_abort_rate", aborted.length / rows.length, { decisions: rows.length, aborted: aborted.length });
    });

    await attempt("zero_feasible_fraction", async () => {
      const rows = await deps.prisma.decisionRecordA.findMany({
        where: { ...decisionFilter, decisionTime: { gte: from, lt: to } },
        select: { outcome: true },
      });
      if (rows.length === 0) return reading("zero_feasible_fraction", null, { decisions: 0 });
      const none = rows.filter((row) => row.outcome && row.outcome.outcome === "NO_FEASIBLE_CANDIDATE").length;
      return reading("zero_feasible_fraction", none / rows.length, { decisions: rows.length, withNoCandidate: none });
    });

    /* ── Queue and outbox depth ─────────────────────────────────────────────── */
    await attempt("queue_depth", async () => {
      const depth = await deps.prisma.workQueue.count({ where: { ...shardFilter, state: "QUEUED" } });
      const oldest = await deps.prisma.workQueue.findFirst({
        where: { ...shardFilter, state: "QUEUED" },
        orderBy: { enqueuedAt: "asc" },
        select: { enqueuedAt: true },
      });
      readings.push(
        reading("queue_oldest_age", oldest ? (toMs - oldest.enqueuedAt.getTime()) / MS_PER_SECOND : null, {
          oldestEnqueuedAt: oldest ? oldest.enqueuedAt : null,
        }),
      );
      return reading("queue_depth", depth);
    });

    await attempt("outbox_depth", async () => {
      const depth = await deps.prisma.outbox.count({ where: { deliveredAt: null } });
      const oldest = await deps.prisma.outbox.findFirst({
        where: { deliveredAt: null },
        orderBy: { createdAt: "asc" },
        select: { createdAt: true },
      });
      readings.push(
        reading("outbox_oldest_undelivered_age", oldest ? (toMs - oldest.createdAt.getTime()) / MS_PER_SECOND : null, {
          oldestCreatedAt: oldest ? oldest.createdAt : null,
        }),
      );
      return reading("outbox_depth", depth);
    });

    /* ── Reconciler repairs, by category (T10) ──────────────────────────────── */
    await attempt("reconciler_repair_rate", async () => {
      const rows = await deps.prisma.reconcilerRepair.groupBy({
        by: ["category"],
        where: { at: { gte: from, lt: to } },
        _count: { _all: true },
      });
      const byCategory = Object.fromEntries(rows.map((row) => [row.category, Number(row._count._all || 0) / windowMinutes]));
      return reading("reconciler_repair_rate", byCategory, { categories: rows.length });
    });

    /* ── §7.7's aggregate, exact over 100 % of decisions ────────────────────── */
    await attempt("rejection_histogram", async () => {
      const rows = await deps.prisma.rejectionAggregate.groupBy({
        by: ["predicateId", "tier"],
        where: { ...shardFilter, bucketStart: { gte: from, lt: to } },
        _sum: { count: true },
      });
      const total = rows.reduce((sum, row) => sum + Number(row._sum.count || 0), 0);
      return reading(
        "rejection_histogram",
        Object.fromEntries(
          rows
            .map((row) => [`${row.predicateId}${row.tier ? `:${row.tier}` : ""}`, Number(row._sum.count || 0)])
            .sort((a, b) => compareStrings(a[0], b[0])),
        ),
        { total, exactOverAllDecisions: true },
      );
    });
  }

  /* ── The config register's own view (§22.4) ──────────────────────────────── */
  if (source.registerEntries) {
    const byStatus = new Map();
    let safetyNotDerived = 0;
    for (const entry of source.registerEntries) {
      byStatus.set(entry.calibrationStatus, (byStatus.get(entry.calibrationStatus) || 0) + 1);
      if (entry.changeClass === "SAFETY" && entry.calibrationStatus !== "DERIVED") safetyNotDerived += 1;
    }
    readings.push(
      reading("parameters_by_calibration_status", Object.fromEntries([...byStatus.entries()].sort((a, b) => compareStrings(a[0], b[0])))),
    );
    readings.push(
      reading("safety_class_not_derived", safetyNotDerived, {
        mustBeZeroInProduction: true,
        gate: "Phase 15 — §22.4's launch gate. Reported from now so the gate is a report rather than a discovery.",
      }),
    );
  }

  if (source.killSwitches) {
    const thrown = Object.entries(source.killSwitches)
      .filter(([, state]) => state === true)
      .map(([name]) => name)
      .sort(compareStrings);
    readings.push(reading("kill_switches_thrown", thrown.length, { thrown }));
  }

  /* ── The advisory registry's own series ──────────────────────────────────── */
  if (source.registry) {
    const snapshot = source.registry.snapshot();
    for (const id of ["explanation_answers_by_source", "tier_b_shedding_count", "round_time_by_stage"]) {
      const matching = Object.entries(snapshot.counters)
        .filter(([key]) => key === `sli.${id}` || key.startsWith(`sli.${id}|`))
        .sort((a, b) => compareStrings(a[0], b[0]));
      if (matching.length > 0) readings.push(reading(id, Object.fromEntries(matching), { advisory: true }));
    }
  }

  /* ── Everything else is declared, and honestly null ──────────────────────── */
  const produced = new Set(readings.map((row) => row.id));
  for (const metric of METRICS) {
    if (produced.has(metric.id)) continue;
    if (unavailable.some((row) => row.id === metric.id)) continue;
    unavailable.push(
      reading(metric.id, null, {
        unavailableBecause: `no producer has landed yet — ${metric.producer}`,
        producer: metric.producer,
      }),
    );
  }

  return {
    window: { from, to, windowMinutes, shardId: source.shardId ?? null },
    readings: readings.sort((a, b) => compareStrings(a.id, b.id)),
    unavailable: unavailable.sort((a, b) => compareStrings(a.id, b.id)),
    failures,
    groups: GROUPS,
    targets: source.mergedSli ? sli.attainment({ merged: source.mergedSli, config: source.config }) : null,
  };
}

module.exports = {
  GROUP,
  GROUPS,
  SOURCE,
  METRICS,
  METRIC_BY_ID,
  MS_PER_SECOND,
  MS_PER_MINUTE,
  assertCoverage,
  reading,
  derive,
};
