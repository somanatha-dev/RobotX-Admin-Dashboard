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
  { id: "column_generation_gap", group: GROUP.ALLOCATION_QUALITY, unit: "milli-CU", source: SOURCE.REGISTRY, dimensions: ["shard"],
    question: "How much could a poor column set have cost us?", producer: "Phase 11 counterfactual evaluator (§21.6)",
    note:
      "The one approximation the in-round machinery cannot bound for itself. REGISTRY, not DURABLE: it is not a " +
      "column of any row — it is the offline evaluator's re-solve, published to `sli.column_generation_gap` by " +
      "`workers/counterfactual.worker.js`. Declaring it DURABLE was the reason its readback was written against " +
      "the wrong surface (Finding 3). Distinct from `search_gap` (candidate truncation, §9.3), from the round's " +
      "`lpIpGapMilliCU` (integrality, exactly zero in the singleton regime), and from a decision's truncation " +
      "gap (objective − bound on a budget-limited solve, §21.2). None of the four is a substitute for another." },
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
  { id: "counterfactual_regret", group: GROUP.ALLOCATION_QUALITY, unit: "milli-CU", source: SOURCE.REGISTRY, dimensions: ["shard"],
    question: "What did our own approximations cost, measured against a relaxed re-solve?", producer: "Phase 11 counterfactual evaluator",
    note:
      "Published to `sli.counterfactual_regret` beside the column-generation gap, and read back the same way. " +
      "It carries the CANDIDATE_SET relaxation's gap specifically — §21.6's four relaxations are reported " +
      "separately and never summed." },

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
 * The metrics whose **producing phase has already landed**, but for which this module
 * has not yet written a query.
 *
 * ── Why this list exists ────────────────────────────────────────────────────
 * `derive()` used to give every unproduced metric the same reason: *"no producer has
 * landed yet"*. For twenty-two of them that is true — Phase 12's degraded-mode register,
 * Phase 16's Tier 2 mechanisms — and for these it is **false**, which
 * `PHASE_11_INDEPENDENT_VERIFICATION.md` Finding 5 recorded: the fence-rejection counts,
 * the near-miss margins and the indeterminate rate were attributed to "Phase 12's and
 * Phase 16's" producers when Phases 4, 6 and 7 had already shipped them.
 *
 * The distinction is not pedantry, because the two states have different owners and
 * different remedies. "The producer has not landed" is a *schedule* fact and nobody
 * should act on it. "The producer exists and nothing reads it" is an *observability
 * debt* with a name, and a reader who cannot tell them apart will defer the wiring to a
 * phase that has no reason to do it — which is precisely what the finding observed
 * happening in prose.
 *
 * Re-derived here from the repository rather than copied from the finding: a metric is on
 * this list when the rows, aggregates or registry series it reads are written by code
 * that is in the build today. It is deliberately a flat list of ids and not a computed
 * predicate over the `producer` string, because a regex over prose is exactly how the
 * wrong attribution got made in the first place. `assertCoverage()` refuses an id here
 * that is not a metric, and refuses one that `derive()` does in fact produce.
 */
const PRODUCER_LANDED_QUERY_NOT_WIRED = Object.freeze([
  "ack_latency",
  "active_regime",
  "cell_pair_cache_hit_rate",
  "cells_visited_from_omega",
  "charge_wait_time",
  "charger_contention",
  "charger_projection_error",
  "charger_reachability_cache_hit_rate",
  "churn_cost_fraction",
  "churn_rate",
  "commit_rate",
  "completion_rate",
  "cost_per_mission",
  "decline_rate",
  "dedup_generation_advance_rate",
  "energy_per_mission",
  "energy_shortfall_events_by_tier",
  "eta_accuracy",
  "feasible_candidate_count",
  "fence_rejections_agent_scope",
  "fence_rejections_commitment_scope",
  "idle_time_by_cause",
  "implausible_observation_rate",
  "indeterminate_rate",
  "intake_to_first_movement",
  "intake_to_offer",
  "lateness_distribution",
  "lease_expiry_rate",
  "nack_rate",
  "near_miss_margins",
  "payload_discrepancy_rate",
  "realised_versus_predicted_cost",
  "reassignment_rate",
  "regime_calibration_age",
  "round_time_by_stage",
  "routing_cache_hit_rate",
  "sla_attainment",
  "timer_store_lag",
  "unrehearsed_combination_time",
  "verification_failure_rate",
]);

const PRODUCER_LANDED = Object.freeze(new Set(PRODUCER_LANDED_QUERY_NOT_WIRED));

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

  // The wiring-debt list must name real metrics, or a reader chasing an id finds nothing
  // and concludes the list is stale rather than that the entry is wrong.
  for (const id of PRODUCER_LANDED_QUERY_NOT_WIRED) {
    if (!Object.prototype.hasOwnProperty.call(METRIC_BY_ID, id)) {
      problems.push(`${id}: named as producer-landed-but-unwired and is not a §21.4 metric`);
    }
  }

  return { ok: problems.length === 0, problems, byGroup };
}

/** @structural milliseconds per second, for turning an age into seconds */
const MS_PER_SECOND = 1000;

/**
 * @structural the size of §26.1's register. A register with fewer rows reported than invariants
 *   is not a green register, and "0 violations over 3 reported" is a different fact from "0 over
 *   22" — so the count is on the wire beside the SLI rather than inferred by a reader.
 */
const INVARIANT_COUNT = 22;

/** @structural milliseconds per minute, for turning a count into a per-minute rate */
const MS_PER_MINUTE = 60000;

/**
 * The §21.4 metrics whose value comes from `sli.js`'s in-process registry rather than
 * from a `GROUP BY` — the quantities no durable row records.
 *
 * ── Why this is a list and not three literals inline ────────────────────────
 * `PHASE_11_INDEPENDENT_VERIFICATION.md` Finding 3 recorded that
 * `column_generation_gap` was written to the registry by `counterfactual.worker.js` and
 * never read back, so a metric §21.4 requires to be "reported separately" from the
 * proven search gap silently resolved to `null` for ever.
 *
 * Re-deriving it here found the finding was *understated in two ways*, and both are the
 * same class of defect rather than one metric's oversight:
 *
 *   1. `counterfactual_regret` — "what did our own approximations cost, measured against
 *      a relaxed re-solve?" — has the identical shape: a real producer on the same line
 *      of the same worker, and no readback. Fixing only the named metric would have left
 *      its sibling broken.
 *   2. The readback scanned `snapshot.counters` **only**, and both of those metrics are
 *      published with `registry.gauge()`. Adding the key to the old allowlist, which is
 *      what Finding 3 recommended, would therefore still have produced `null` — the
 *      recommendation was necessary and not sufficient.
 *
 * `readBackSeries()` consequently reads all three instruments. A producer's choice
 * between a counter, a gauge and a histogram is a local decision, and a readback that
 * silently returns nothing when that choice changes is a metric that dies quietly.
 */
const REGISTRY_BACKED = Object.freeze([
  "explanation_answers_by_source",
  "tier_b_shedding_count",
  "round_time_by_stage",
  "counterfactual_regret",
  "column_generation_gap",
]);

/**
 * Read one metric's series out of an `sli.js` snapshot, whichever instrument produced it.
 *
 * Returns `null` — not zero, and not an empty object — when nothing has been published.
 * §21.4's rule holds here exactly as it holds for an unlanded producer: a metric reading
 * zero because nothing feeds it is indistinguishable from a system that is behaving.
 *
 * @param {object} snapshot an `sli.createRegistry().snapshot()` or `sli.merge()` result
 * @param {string} id the metric id, published under `sli.<id>` with optional `|labels`
 * @returns {{ value: object, instrument: string }|null}
 */
function readBackSeries(snapshot, id) {
  const belongs = (key) => key === `sli.${id}` || key.startsWith(`sli.${id}|`);

  for (const instrument of ["counters", "gauges", "histograms"]) {
    const series = (snapshot && snapshot[instrument]) || {};
    const matching = Object.entries(series)
      .filter(([key]) => belongs(key))
      .sort((a, b) => compareStrings(a[0], b[0]));
    if (matching.length > 0) return { value: Object.fromEntries(matching), instrument };
  }

  return null;
}

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
        // §21.6 through the relation, because `DecisionRecordB` has no `shadowLabel` of its
        // own — it carries only `decisionId`, and the shadow marker lives on the
        // `DecisionRecordA` it points at. A shadow round DOES write Tier B rows
        // (`shadow.worker.js` calls the same `decisionRecord.writeRound()`), so this query
        // without the relation filter counted decisions the fleet never executed against
        // `observability.tier_b_write_budget` — the exact contamination §21.6 forbids
        // ("recorded and never executed"). Spelled with `decisionRecord.PRODUCTION_ONLY`
        // rather than a literal so the two tables' filters cannot drift apart.
        where: { ...shardFilter, decisionTime: { gte: from, lt: to }, decision: { ...decisionRecord.PRODUCTION_ONLY } },
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
      // I20: a round that proved no search bound writes NULL, and it must be **excluded**
      // from this statistic rather than folded in. This read `BigInt(row.searchGapMilliCU
      // || "0")`, which counted every unproven round as a proven zero — so the median of a
      // window in which nothing was proven was `0`, the most reassuring number available,
      // published as an SLI. Excluding them makes the reading a statistic over the rounds
      // that actually carry a bound, and `roundsWithoutProvenGap` says how many did not,
      // so a reader can tell a quiet window from an unproven one.
      const bounded = rounds.filter((row) => row.searchGapMilliCU !== null && row.searchGapMilliCU !== undefined);
      if (bounded.length === 0) {
        return reading("search_gap", null, {
          rounds: rounds.length,
          roundsWithProvenGap: 0,
          roundsWithoutProvenGap: rounds.length,
          why: "no round in this window reported a proven search bound (§6.4, I20)",
        });
      }
      // Kept as integer milli-CU strings all the way out. §9.6 requirement 1.
      const gaps = bounded.map((row) => BigInt(row.searchGapMilliCU)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      // @structural the divisor in the definition of a median, not a threshold
      const MEDIAN_DIVISOR = 2;
      return reading("search_gap", gaps[Math.floor(gaps.length / MEDIAN_DIVISOR)].toString(), {
        rounds: gaps.length,
        roundsWithProvenGap: gaps.length,
        roundsWithoutProvenGap: rounds.length - gaps.length,
        maxMilliCU: gaps[gaps.length - 1].toString(),
        statistic: "median over rounds with a proven bound, in milli-CU",
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

    /* ── PHASE 12 — §18.5's mode SLI, §26.1's violation SLI, §4.3's stranding SLI ──
     *
     * Four of these are named as SLIs by the sections that create them, and one is a *gate*:
     *
     *   · §18.5 rule 1 — "Time spent in each mode is an SLI (§21.4)."
     *   · §26.1 — the violation count "is an SLI whose target is exactly zero", and a
     *     suspension is "itself alertable if it persists beyond the mode's bound".
     *   · §26.1 I22 — "response-time SLI per class".
     *
     * They were left null with the reason "no producer has landed yet — Phase 12", which was
     * true when Phase 11 wrote it and stopped being true when Phase 12 landed its three tables.
     * A metric whose stated reason for being null is a schedule fact nobody should act on is a
     * metric nobody wires; that is the exact confusion `PRODUCER_LANDED_QUERY_NOT_WIRED` exists
     * to prevent, and it had happened again in the other direction.
     *
     * The §17.4 ladder metrics (`outstanding_escalations`, `escalation_saturation_time`,
     * `ladder_step_distribution`) were deliberately **not** wired here, with the reason
     * "their producer is the anti-starvation ladder of §17.4, which is its own phase's, and
     * `src/engine/fairness/` still holds no ladder". The remedial phase has run: the ladder
     * exists, it writes `LadderEscalation`, and the three are derived below from those rows.
     * They are the same rows `operatorCapacity` decides admission from, so a dashboard
     * cannot show a count the admission control disagrees with.
     */
    await attempt("degraded_mode_time", async () => {
      const closed = await deps.prisma.degradedModeEvent.findMany({
        where: { ...shardFilter, exitedAt: { gte: from, lt: to } },
        select: { mode: true, cause: true, durationMs: true },
      });
      const open = await deps.prisma.degradedModeEvent.findMany({
        where: { ...shardFilter, exitedAt: null },
        select: { mode: true, cause: true, enteredAt: true },
      });

      // Open modes count toward the SLI at their elapsed duration. A "time spent degraded"
      // metric that only counted modes already exited would read zero for the whole of an
      // outage and report the truth only once it was over.
      const seconds = new Map();
      const add = (mode, cause, ms) => {
        const key = `${mode}|${cause ?? "unstated"}`;
        seconds.set(key, (seconds.get(key) || 0) + ms / MS_PER_SECOND);
      };
      for (const row of closed) add(row.mode, row.cause, Number(row.durationMs || 0));
      for (const row of open) add(row.mode, row.cause, Math.max(0, toMs - row.enteredAt.getTime()));

      return reading(
        "degraded_mode_time",
        Object.fromEntries([...seconds.entries()].sort((a, b) => compareStrings(a[0], b[0]))),
        { openModes: open.length, exitedInWindow: closed.length, dimensions: ["mode", "entryCause"] },
      );
    });

    await attempt("suspensions_over_time_box", async () => {
      const overdue = await deps.prisma.degradedModeEvent.findMany({
        where: { ...shardFilter, exitedAt: null, timeBoxExpiresAt: { lt: to } },
        select: { mode: true, suspendedInvariants: true, timeBoxExpiresAt: true },
      });
      const counts = new Map();
      for (const row of overdue) {
        // §26.1's clause is about *suspensions* outliving their box. An overdue mode that
        // suspends nothing is a slow recovery, not a guarantee nobody is verifying, and
        // counting it here would make the alert mean two different things.
        for (const invariant of row.suspendedInvariants || []) {
          const key = `${row.mode}|${invariant}`;
          counts.set(key, (counts.get(key) || 0) + 1);
        }
      }
      return reading(
        "suspensions_over_time_box",
        Object.fromEntries([...counts.entries()].sort((a, b) => compareStrings(a[0], b[0]))),
        { overdueModes: overdue.length, mustBeZero: true, alertable: counts.size > 0 },
      );
    });

    /* ── REMEDIAL PHASE T1-04 — §17.4's human capacity, from the ladder's own rows ──
     *
     * > Outstanding escalations against `ops.escalation_capacity` per region, and time
     * > spent saturated (§17.4) — the ladder's guarantee is only as good as the capacity
     * > behind its last two steps.
     * > Ladder step distribution: how far Legs are getting before resolution, by class and
     * > zone.
     *
     * All three come from `LadderEscalation`, which is what makes them consistent with each
     * other and with the admission decision: a point count and an interval question over
     * one set of `admittedAt`/`resolvedAt` pairs cannot disagree.
     *
     * Scoped by **region**, because `ops.escalation_capacity` is — a dispatch function is
     * staffed per region, not per shard, and a count aggregated across regions would be
     * compared against a capacity that does not exist.
     */
    await attempt("outstanding_escalations", async () => {
      const open = await deps.prisma.ladderEscalation.findMany({
        where: { humanStep: true, admittedAt: { not: null }, resolvedAt: null },
        select: { regionId: true },
      });
      const byRegion = new Map();
      for (const row of open) {
        const key = row.regionId ?? "unassigned";
        byRegion.set(key, (byRegion.get(key) || 0) + 1);
      }
      return reading(
        "outstanding_escalations",
        Object.fromEntries([...byRegion.entries()].sort((a, b) => compareStrings(a[0], b[0]))),
        { total: open.length, dimensions: ["region"] },
      );
    });

    await attempt("escalation_saturation_time", async () => {
      // Seconds in the window during which at least one escalation was outstanding,
      // per region — the interval half of the same rows. It is reported without a capacity
      // comparison on purpose: `ops.escalation_capacity` is region-scoped configuration and
      // this derivation runs over every region at once, so the *time* is the measurement
      // and `operatorCapacity.assessSaturation` is what compares it against a capacity for
      // the one region it is bound to. A comparison made here against a capacity read for
      // some other region would be a number that looks authoritative and is not.
      const rows = await deps.prisma.ladderEscalation.findMany({
        where: {
          humanStep: true,
          admittedAt: { not: null, lt: to },
          OR: [{ resolvedAt: null }, { resolvedAt: { gte: from } }],
        },
        select: { regionId: true, admittedAt: true, resolvedAt: true },
      });

      const byRegion = new Map();
      for (const row of rows) {
        const key = row.regionId ?? "unassigned";
        const start = Math.max(row.admittedAt.getTime(), from.getTime());
        const end = Math.min(row.resolvedAt ? row.resolvedAt.getTime() : to.getTime(), to.getTime());
        if (!(end > start)) continue;
        const spans = byRegion.get(key) || [];
        spans.push([start, end]);
        byRegion.set(key, spans);
      }

      // Union of the spans, not their sum: two escalations open at once is one second of
      // "time spent with the human queue occupied", not two.
      const seconds = new Map();
      for (const [key, spans] of byRegion) {
        spans.sort((left, right) => left[0] - right[0]);
        let covered = 0;
        let cursor = null;
        for (const [start, end] of spans) {
          if (cursor === null || start > cursor[1]) {
            if (cursor !== null) covered += cursor[1] - cursor[0];
            cursor = [start, end];
          } else if (end > cursor[1]) {
            cursor = [cursor[0], end];
          }
        }
        if (cursor !== null) covered += cursor[1] - cursor[0];
        seconds.set(key, covered / MS_PER_SECOND);
      }

      return reading(
        "escalation_saturation_time",
        Object.fromEntries([...seconds.entries()].sort((a, b) => compareStrings(a[0], b[0]))),
        { escalationsInWindow: rows.length, windowMinutes, dimensions: ["region"] },
      );
    });

    await attempt("ladder_step_distribution", async () => {
      // "How far Legs are getting before resolution." The highest rung each Leg reached in
      // the window, not every rung it crossed: a Leg that reached rung 7 also has rows for
      // 1 through 6, and counting all of them would report a ladder that is mostly rung 1
      // however badly the fleet is doing.
      const rows = await deps.prisma.ladderEscalation.findMany({
        where: { reachedAt: { gte: from, lt: to } },
        select: { legId: true, step: true, slaClass: true, regionId: true },
      });
      const highest = new Map();
      for (const row of rows) {
        const current = highest.get(row.legId);
        if (!current || row.step > current.step) highest.set(row.legId, row);
      }
      const counts = new Map();
      for (const row of highest.values()) {
        const key = `${row.step}|${row.slaClass ?? "unclassified"}|${row.regionId ?? "unassigned"}`;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      return reading(
        "ladder_step_distribution",
        Object.fromEntries([...counts.entries()].sort((a, b) => compareStrings(a[0], b[0]))),
        { legsOnTheLadder: highest.size, rungsRecorded: rows.length, dimensions: ["step", "class", "region"] },
      );
    });

    await attempt("invariant_violations", async () => {
      const rows = await deps.prisma.invariantStatus.findMany({
        where: { ...shardFilter, subjectType: "SHARD" },
        select: { invariantId: true, status: true, violationCount: true, checkedAt: true },
      });
      // Only `VIOLATED` rows contribute. A suspended check keeps its findings on purpose
      // (§18.5's reconciliation input), and folding them in would make the zero-target SLI
      // non-zero for the whole of an authorised suspension — which is the page §26.1's third
      // status exists to prevent.
      const violated = rows.filter((row) => row.status === "VIOLATED");
      const byInvariant = Object.fromEntries(
        violated.map((row) => [row.invariantId, Number(row.violationCount || 0)]).sort((a, b) => compareStrings(a[0], b[0])),
      );
      const oldest = rows.reduce((min, row) => (min === null || row.checkedAt < min ? row.checkedAt : min), null);
      return reading("invariant_violations", byInvariant, {
        total: violated.reduce((sum, row) => sum + Number(row.violationCount || 0), 0),
        mustBeZero: true,
        // A register that has not reported on every invariant is not a green register, and an
        // SLI of 0 over 3 reported invariants is not the same fact as 0 over 22.
        reported: rows.length,
        expected: INVARIANT_COUNT,
        complete: rows.length === INVARIANT_COUNT,
        suspended: rows.filter((row) => row.status === "SUSPENDED").map((row) => row.invariantId),
        oldestCheckedAt: oldest,
      });
    });

    await attempt("stranding_events_by_obstruction_class", async () => {
      const rows = await deps.prisma.leg.groupBy({
        by: ["obstructionClass"],
        where: { state: { in: ["STRANDED_SAFE", "STRANDED_OBSTRUCTING"] } },
        _count: { _all: true },
      });
      return reading(
        "stranding_events_by_obstruction_class",
        Object.fromEntries(
          rows.map((row) => [row.obstructionClass ?? "UNCLASSIFIED", Number(row._count._all || 0)]).sort((a, b) => compareStrings(a[0], b[0])),
        ),
        { currentlyStranded: rows.reduce((sum, row) => sum + Number(row._count._all || 0), 0) },
      );
    });

    await attempt("stranding_response_time", async () => {
      const cleared = await deps.prisma.externalEscalation.findMany({
        where: { step: 1, clearedAt: { gte: from, lt: to } },
        select: { obstructionClass: true, occurredAt: true, clearedAt: true },
      });
      if (cleared.length === 0) {
        // Distinguished from "no query": nothing was cleared in the window, which is a real
        // observation about a window and not an unfed metric.
        return reading("stranding_response_time", null, { clearedInWindow: 0, note: "no chain cleared in this window" });
      }
      const byClass = new Map();
      for (const row of cleared) {
        const key = row.obstructionClass ?? "UNCLASSIFIED";
        const list = byClass.get(key) || [];
        list.push((row.clearedAt.getTime() - row.occurredAt.getTime()) / MS_PER_SECOND);
        byClass.set(key, list);
      }
      return reading(
        "stranding_response_time",
        Object.fromEntries(
          [...byClass.entries()]
            .map(([key, list]) => [key, list.reduce((sum, value) => sum + value, 0) / list.length])
            .sort((a, b) => compareStrings(a[0], b[0])),
        ),
        { clearedInWindow: cleared.length, statistic: "mean seconds from step 1 to clearance, per class" },
      );
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
    for (const id of REGISTRY_BACKED) {
      const found = readBackSeries(snapshot, id);
      if (found !== null) readings.push(reading(id, found.value, { advisory: true, instrument: found.instrument }));
    }
  }

  /* ── Everything else is declared, and honestly null ──────────────────────── */
  const produced = new Set(readings.map((row) => row.id));
  for (const metric of METRICS) {
    if (produced.has(metric.id)) continue;
    if (unavailable.some((row) => row.id === metric.id)) continue;
    // Two different states, two different reasons, two different owners. Collapsing them
    // into one sentence is what sent Finding 5's four metrics to a phase with no reason
    // to wire them.
    const landed = PRODUCER_LANDED.has(metric.id);
    unavailable.push(
      reading(metric.id, null, {
        unavailableBecause: landed
          ? `the producer has landed (${metric.producer}) and no query reads it yet — observability wiring, not a missing mechanism`
          : `no producer has landed yet — ${metric.producer}`,
        producer: metric.producer,
        producerLanded: landed,
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
  PRODUCER_LANDED_QUERY_NOT_WIRED,
  REGISTRY_BACKED,
  MS_PER_SECOND,
  MS_PER_MINUTE,
  assertCoverage,
  readBackSeries,
  reading,
  derive,
};
