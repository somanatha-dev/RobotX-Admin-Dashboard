"use strict";

/**
 * Obligation tiering (§1.8) as machine-readable data plus the assertions that
 * enforce it.
 *
 * This module is the single source of truth for tier assignment. `TIERS.md` is
 * generated *from* this file's `MECHANISMS` table and MUST agree with it; the
 * engine test lane asserts that agreement so the prose can never drift from the
 * data the gate actually enforces.
 *
 * §1.8 rule 2 — "No Tier 0 or Tier 1 guarantee may depend on a Tier 2 mechanism"
 * — is enforced structurally by `tools/gates/checkTierDependencies.js`, which
 * reads `MODULE_TIERS` from here.
 *
 * Nothing in this file executes in the request or round path. It is build-time
 * and test-time apparatus only.
 */

/**
 * The three obligation tiers of §1.8.
 * @structural tier ordinals are the specification's own labels, not tunable values
 */
const TIER = Object.freeze({
  SAFETY_CORE: 0,
  OPERATIONAL_INTEGRITY: 1,
  ALLOCATION_QUALITY: 2,
});

/**
 * @structural mirrors TIER; the literal 2 is §1.8's label for the quality tier
 */
const TIER_NAMES = Object.freeze({
  0: "Tier 0 — Safety core",
  1: "Tier 1 — Operational integrity",
  2: "Tier 2 — Allocation quality",
});

/**
 * Every mechanism named by §1.8, with the module that owns it.
 *
 * `modules` are repo-relative POSIX paths under `Backend/`. A path that does not
 * exist yet names the module the owning phase MUST create; the engine test lane
 * checks that every path lies inside a directory the Phase 0 module tree created,
 * which is what keeps this table honest before the code exists.
 *
 * `killSwitch` is populated for Tier 2 mechanisms only, and names the §22.5 switch
 * that disables the mechanism. §22.5 rule 1 requires each to degrade to a complete,
 * tested Tier 1 behaviour.
 */
const MECHANISMS = Object.freeze([
  // ── Tier 0 — the safety core (§1.8) ──────────────────────────────────────
  {
    id: "T0-01",
    tier: TIER.SAFETY_CORE,
    name: "Feasibility gate as a boolean pre-cost gate, structurally incapable of being bypassed, with its class I and R predicates",
    sections: ["§7.1", "§7.5", "T1"],
    modules: [
      "src/engine/feasibility/evaluate.js",
      "src/engine/feasibility/register.js",
      "src/engine/feasibility/predicates/",
    ],
    invariants: ["I9", "I14"],
  },
  {
    id: "T0-02",
    tier: TIER.SAFETY_CORE,
    name: "Three-valued evaluation with DENY on indeterminate for every class I and R predicate, and the systemic-indeterminacy guard",
    sections: ["§7.3", "§7.4"],
    modules: [
      "src/engine/feasibility/threeValued.js",
      "src/engine/feasibility/systemicGuard.js",
    ],
    invariants: ["I9"],
  },
  {
    id: "T0-03",
    tier: TIER.SAFETY_CORE,
    name: "Energy feasibility at all three shortfall tiers, and charger reachability from the mission end — F34, F35",
    sections: ["§14.5"],
    modules: [
      "src/engine/energy/consumption.js",
      "src/engine/energy/usable.js",
      "src/engine/energy/reserves.js",
      "src/engine/energy/tiers.js",
      "src/engine/energy/eReturn.js",
      "src/engine/routing/chargerReachabilityCache.js",
      "src/engine/feasibility/predicates/f34.js",
      "src/engine/feasibility/predicates/f35.js",
    ],
    invariants: ["I17"],
  },
  {
    id: "T0-04",
    tier: TIER.SAFETY_CORE,
    name: "Payload, capability, and route-permission predicates — F21–F31",
    sections: ["§7.5", "§15"],
    modules: [
      "src/engine/payload/spec.js",
      "src/engine/payload/container.js",
      "src/engine/payload/packing.js",
      "src/engine/payload/loadState.js",
      "src/engine/domain/capability.js",
    ],
    invariants: ["I9"],
  },
  {
    id: "T0-05",
    tier: TIER.SAFETY_CORE,
    name: "Exclusivity: the serialised conditional commit with guards G1–G6 and its schema backstops",
    sections: ["§10.3.2"],
    modules: [
      "src/engine/commitment/commit.js",
      "src/engine/commitment/guards.js",
      "src/engine/commitment/model.js",
      "src/engine/commitment/idempotency.js",
      "src/engine/commitment/clock.js",
      // The lease granted at commit (§12.2). Absent from this list until Phase 4; the
      // path-prefix rule always classified it Tier 0, so the gate was never wrong —
      // but the human-readable inventory was incomplete, which is what the Phase 3
      // independent verification found.
      "src/engine/commitment/leases.js",
    ],
    invariants: ["I1", "I16", "I18"],
  },
  {
    id: "T0-06",
    tier: TIER.SAFETY_CORE,
    name: "Two-scope fencing and durable agent-side deduplication",
    sections: ["§10.3.1", "§11.5"],
    modules: [
      "src/engine/commitment/fencing.js",
      "src/engine/dispatch/dedupHandshake.js",
    ],
    invariants: ["I5", "I19", "I21"],
  },
  {
    id: "T0-07",
    tier: TIER.SAFETY_CORE,
    name: "Custody as a first-class state, with settlement ordering",
    sections: ["§2.5", "§4.9"],
    modules: [
      "src/engine/domain/custody.js",
      "src/engine/lifecycle/settlement.js",
      "src/engine/payload/custodyEvidence.js",
    ],
    invariants: ["I7", "I8"],
  },
  {
    id: "T0-08",
    tier: TIER.SAFETY_CORE,
    name: "Durable timers keyed on each entity's own version, and the reconciler",
    sections: ["§4.5", "§12"],
    modules: [
      "src/engine/supervision/timers.js",
      "src/engine/supervision/leases.js",
      "src/engine/supervision/progress.js",
      "src/engine/supervision/reconciler.js",
      "src/engine/supervision/verification.js",
      "src/workers/timer.worker.js",
      "src/workers/reconciler.worker.js",
    ],
    invariants: ["I2", "I4", "I12"],
  },
  {
    id: "T0-09",
    tier: TIER.SAFETY_CORE,
    name: "The transactional outbox",
    sections: ["§11.1", "§4.1 rule 5"],
    modules: [
      "src/engine/dispatch/outbox.js",
      "src/engine/dispatch/sequence.js",
      // §11.2's offer semantics and §11.4's escalation ladder are what the outbox is
      // *for*: a durable dispatch obligation with no disposition and no ladder is a
      // queue, not the mechanism §11.1 specifies.
      "src/engine/dispatch/offers.js",
      "src/engine/dispatch/escalation.js",
      "src/workers/outbox.worker.js",
    ],
    invariants: ["I16"],
  },
  {
    id: "T0-10",
    tier: TIER.SAFETY_CORE,
    name: "Stranding classification and the external escalation chain",
    sections: ["§4.3", "§18.6"],
    modules: [
      "src/engine/map/obstructionClass.js",
      "src/engine/failure/externalEscalation.js",
    ],
    invariants: ["I22"],
  },
  {
    id: "T0-11",
    tier: TIER.SAFETY_CORE,
    name: "The degraded-mode register, with every suspension explicit, named, and time-boxed",
    sections: ["§18.5", "§26.2"],
    modules: [
      "src/engine/degraded/modeRegister.js",
      "src/engine/failure/catalogue.js",
    ],
    invariants: ["I2"],
  },

  // ── Tier 1 — operational integrity (§1.8) ────────────────────────────────
  {
    id: "T1-01",
    tier: TIER.OPERATIONAL_INTEGRITY,
    name: "Absolute CU units, dimensioned exchange rates, and the parameter register",
    sections: ["§1.3", "§22", "Appendix A"],
    modules: [
      "src/engine/cost/units.js",
      "src/engine/cost/exchangeRates.js",
      "src/engine/config/service.js",
      "src/engine/config/resolver.js",
      "src/engine/config/validators.js",
      "src/engine/config/derived.js",
      "src/engine/config/calibrationStatus.js",
      "src/engine/config/killSwitches.js",
      "src/engine/config/regimes.js",
      "src/engine/config/register/",
    ],
    invariants: ["I15"],
  },
  {
    id: "T1-02",
    tier: TIER.OPERATIONAL_INTEGRITY,
    name: "Determinism and replayability of every decision",
    sections: ["§9.6", "T6"],
    modules: [
      "src/engine/determinism/fixedPoint.js",
      "src/engine/determinism/ordering.js",
      "src/engine/determinism/snapshot.js",
    ],
    invariants: ["I10"],
  },
  {
    id: "T1-03",
    tier: TIER.OPERATIONAL_INTEGRITY,
    name: "The Tier A decision record and the Explanation API",
    sections: ["§21.2", "§21.3"],
    modules: [
      "src/engine/observability/decisionRecord.js",
      "src/controllers/explain.controller.js",
      "src/routes/explain.routes.js",
    ],
    invariants: ["I10"],
  },
  {
    id: "T1-04",
    tier: TIER.OPERATIONAL_INTEGRITY,
    name: "The anti-starvation escalation ladder — where the anti-starvation guarantee lives",
    sections: ["§17.4"],
    modules: [
      "src/engine/fairness/ladder.js",
      "src/engine/fairness/operatorCapacity.js",
      "src/engine/fairness/agentStarvation.js",
    ],
    invariants: ["I13"],
  },
  {
    id: "T1-05",
    tier: TIER.OPERATIONAL_INTEGRITY,
    name: "Cancellation, reassignment, and settlement",
    sections: ["§4.6", "§4.7", "§4.9"],
    modules: [
      "src/engine/lifecycle/cancellation.js",
      "src/engine/lifecycle/reassignment.js",
      "src/engine/lifecycle/settlement.js",
    ],
    invariants: ["I11"],
    note:
      "settlement.js is dual-listed: §1.8 names settlement ordering in Tier 0 (custody) and settlement in Tier 1. " +
      "Its MODULE_TIERS assignment is Tier 0 — the stricter of the two, which can only over-constrain the rule-2 gate.",
  },
  {
    id: "T1-06",
    tier: TIER.OPERATIONAL_INTEGRITY,
    name: "Admission control and backpressure",
    sections: ["§20.5"],
    modules: ["src/engine/intake/intake.js", "src/engine/intake/admission.js"],
    invariants: [],
  },
  {
    id: "T1-07",
    tier: TIER.OPERATIONAL_INTEGRITY,
    name: "The Invariant Checker",
    sections: ["§26"],
    modules: [
      "src/engine/observability/invariantChecker.js",
      "src/workers/invariant.worker.js",
    ],
    invariants: ["I3", "I6"],
  },

  // ── Tier 2 — allocation quality (§1.8), each behind its §22.5 kill switch ─
  {
    id: "T2-01",
    tier: TIER.ALLOCATION_QUALITY,
    name: "Batch solving",
    sections: ["§9.1", "§9.2"],
    modules: ["src/engine/solve/batch.js"],
    killSwitch: "batch_solving",
    degradesTo: "The same round executed with a batch of one Leg (§9.2)",
    invariants: ["I20"],
  },
  {
    id: "T2-02",
    tier: TIER.ALLOCATION_QUALITY,
    name: "Multi-Leg columns (bundling and consolidation)",
    sections: ["§9.3"],
    modules: ["src/engine/solve/setPartitioning.js", "src/engine/plan/multiLegColumn.js"],
    killSwitch: "multi_leg_columns",
    degradesTo:
      "Singleton columns only — every round in the singleton regime, where the solve is a totally unimodular min-cost flow, integral and exact (§9.3)",
    invariants: ["I20"],
  },
  {
    id: "T2-03",
    tier: TIER.ALLOCATION_QUALITY,
    name: "Chaining — queue depth capacity > 1",
    sections: ["§13.3"],
    modules: ["src/engine/plan/insertion.js"],
    killSwitch: "chaining",
    degradesTo: "capacity[agent_class] = 1; strict one-mission-per-agent",
    invariants: [],
  },
  {
    id: "T2-04",
    tier: TIER.ALLOCATION_QUALITY,
    name: "Deferral as a priced arc",
    sections: ["§8.8"],
    modules: ["src/engine/cost/cDefer.js"],
    killSwitch: "deferral",
    degradesTo: "Immediate assignment when any feasible candidate exists",
    invariants: [],
  },
  {
    id: "T2-05",
    tier: TIER.ALLOCATION_QUALITY,
    name: "Preemption, including victim disposition",
    sections: ["§4.8"],
    modules: ["src/engine/lifecycle/preemption.js"],
    killSwitch: "preemption",
    degradesTo: "Disabled entirely",
    invariants: [],
  },
  {
    id: "T2-06",
    tier: TIER.ALLOCATION_QUALITY,
    name: "The opportunity-cost and terminal-value model",
    sections: ["§8.3", "§8.3.1"],
    modules: [
      "src/engine/cost/cOpportunity.js",
      "src/engine/pricing/vTerminal.js",
      "src/engine/pricing/capacityPricingClient.js",
      "src/engine/pricing/forecastClient.js",
    ],
    killSwitch: "opportunity_cost_term",
    degradesTo:
      "λ_zone from configured static per-zone, per-bucket priors; the derivation of §8.3 is unchanged, only its input source is (§5.2)",
    invariants: [],
  },
  {
    id: "T2-07",
    tier: TIER.ALLOCATION_QUALITY,
    name: "Churn pricing",
    sections: ["§8.9"],
    modules: ["src/engine/cost/cChurn.js"],
    killSwitch: "churn_pricing",
    onLadder: false, // §1.8 names this Tier 2 mechanism; §22.5 gives it no row — see KILL_SWITCHES_OFF_LADDER
    degradesTo: "Reassignment priced without a churn term",
    invariants: [],
  },
  {
    id: "T2-08",
    tier: TIER.ALLOCATION_QUALITY,
    name: "Post-solve local search",
    sections: ["§9.5"],
    modules: ["src/engine/solve/localSearch.js"],
    killSwitch: "local_search",
    onLadder: false, // §1.8 names this Tier 2 mechanism; §22.5 gives it no row — see KILL_SWITCHES_OFF_LADDER
    degradesTo: "The solver's own solution, reported with its own gap",
    invariants: ["I20"],
  },
  {
    id: "T2-09",
    tier: TIER.ALLOCATION_QUALITY,
    name: "Reliability-priced risk",
    sections: ["§8.4", "§16"],
    modules: ["src/engine/reliability/"],
    killSwitch: "reliability_based_gating",
    degradesTo: "Cohort priors only",
    invariants: [],
  },
  {
    id: "T2-10",
    tier: TIER.ALLOCATION_QUALITY,
    name: "The duty-cycle regulariser",
    sections: ["§17.2"],
    modules: ["src/engine/fairness/dutyCycle.js"],
    killSwitch: "duty_cycle_regulariser",
    onLadder: false, // §1.8 names this Tier 2 mechanism; §22.5 gives it no row — see KILL_SWITCHES_OFF_LADDER
    degradesTo: "Priced wear only (§17.1)",
    invariants: [],
  },
  {
    id: "T2-11",
    tier: TIER.ALLOCATION_QUALITY,
    name: "Repositioning",
    sections: ["§17.3"],
    modules: ["src/engine/fairness/repositioning.js"],
    killSwitch: "reposition_injection",
    degradesTo: "No reposition missions",
    invariants: [],
  },
  {
    id: "T2-12",
    tier: TIER.ALLOCATION_QUALITY,
    name: "Consolidation and chaining in the Plan Builder",
    sections: ["§13.3"],
    modules: ["src/engine/plan/consolidation.js"],
    killSwitch: "multi_leg_columns",
    degradesTo: "Single-Leg plans only",
    invariants: [],
  },
  {
    id: "T2-13",
    tier: TIER.ALLOCATION_QUALITY,
    name: "Cross-region candidacy",
    sections: ["§19.6"],
    modules: ["src/engine/shard/crossRegion.js"],
    killSwitch: "cross_region_candidacy",
    degradesTo: "Region-local only",
    invariants: [],
  },
]);

/**
 * The nine kill switches of §22.5, in the order of the supported monotone ladder.
 * The supported combinations are the *prefixes* of this order (§22.5 rule 2).
 */
const KILL_SWITCH_LADDER = Object.freeze([
  "reposition_injection",
  "preemption",
  "deferral",
  "cross_region_candidacy",
  "chaining",
  "multi_leg_columns",
  "reliability_based_gating",
  "batch_solving",
  "opportunity_cost_term",
]);

/**
 * Kill switches required by §1.8 rule 1 — "every Tier 2 mechanism MUST be
 * individually disableable" — for the three Tier 2 mechanisms §1.8 names that the
 * §22.5 table does not give a row of its own.
 *
 * ── RECORDED SPECIFICATION DISCREPANCY (Phase 0) ────────────────────────────
 * §1.8 enumerates twelve Tier 2 mechanisms. §22.5 tabulates nine kill switches and
 * then reasons about "the nine independent switches above" and their 512
 * combinations. Churn pricing (§8.9), post-solve local search (§9.5), and the
 * duty-cycle regulariser (§17.2) appear in the §1.8 list with no §22.5 row.
 *
 * Phase 0 does not resolve this — resolving it is an architecture change, and the
 * architecture is frozen. It records it: these three carry their own switch so that
 * §1.8 rule 1 holds, and they are marked as **off the supported ladder**, so §22.5
 * rule 2's prefix reasoning and its 2⁹ combination count are untouched. Throwing one
 * of these three is therefore an unrehearsed combination under §22.5 rule 2 and
 * alerts as such.
 *
 * Escalated to the tech lead in `PHASE_0_IMPLEMENTATION_REPORT.md` as an open item
 * for Phase 1, which owns `killSwitches.js` and the ladder.
 */
const KILL_SWITCHES_OFF_LADDER = Object.freeze([
  "churn_pricing",
  "local_search",
  "duty_cycle_regulariser",
]);

/**
 * Every kill switch the engine recognises: the §22.5 ladder plus the §1.8 rule-1
 * switches that the §22.5 table omits.
 */
const KILL_SWITCHES = Object.freeze([...KILL_SWITCH_LADDER, ...KILL_SWITCHES_OFF_LADDER]);

/**
 * Tier assignment by module path prefix, longest-prefix-wins.
 *
 * Two conventions, both stated so that a reviewer can check them against §1.8:
 *
 *   1. **Modules not named by §1.8 default to Tier 1.** §1.8 enumerates mechanisms
 *      whose absence has a stated cost, not an exhaustive module partition. Only a
 *      mechanism §1.8 explicitly lists under Tier 2 is Tier 2 here. The default is
 *      conservative: it can only over-constrain the rule-2 gate, never relax it.
 *   2. **Where a module hosts both a base behaviour and a Tier 2 enhancement, the
 *      module carries its base tier and the Tier 2 behaviour lives in its own
 *      module.** Φ (`cost/phi.js`, Tier 1) therefore may not import `cOpportunity.js`
 *      (Tier 2); it obtains optional terms through registration, never a static
 *      import. That is §1.8 rule 2 and §22.5 rule 1 acting together: a kill switch
 *      whose disabled mechanism is still statically linked into the Tier 1 path is
 *      not a control.
 */
const MODULE_TIERS = Object.freeze([
  // Tier 0 — safety core.
  ["src/engine/commitment/", TIER.SAFETY_CORE],
  ["src/engine/dispatch/", TIER.SAFETY_CORE],
  ["src/engine/supervision/", TIER.SAFETY_CORE],
  ["src/engine/feasibility/", TIER.SAFETY_CORE],
  ["src/engine/energy/", TIER.SAFETY_CORE],
  ["src/engine/payload/", TIER.SAFETY_CORE],
  ["src/engine/degraded/", TIER.SAFETY_CORE],
  ["src/engine/failure/", TIER.SAFETY_CORE],
  ["src/engine/map/", TIER.SAFETY_CORE],
  ["src/engine/domain/custody.js", TIER.SAFETY_CORE],
  ["src/engine/domain/capability.js", TIER.SAFETY_CORE],
  ["src/engine/lifecycle/settlement.js", TIER.SAFETY_CORE],
  ["src/engine/routing/chargerReachabilityCache.js", TIER.SAFETY_CORE],
  ["src/workers/timer.worker.js", TIER.SAFETY_CORE],
  ["src/workers/reconciler.worker.js", TIER.SAFETY_CORE],
  ["src/workers/outbox.worker.js", TIER.SAFETY_CORE],

  // Tier 2 — allocation quality. Every entry is a mechanism §1.8 names as Tier 2.
  ["src/engine/reliability/", TIER.ALLOCATION_QUALITY],
  ["src/engine/pricing/", TIER.ALLOCATION_QUALITY],
  ["src/engine/solve/batch.js", TIER.ALLOCATION_QUALITY],
  ["src/engine/solve/setPartitioning.js", TIER.ALLOCATION_QUALITY],
  ["src/engine/solve/localSearch.js", TIER.ALLOCATION_QUALITY],
  ["src/engine/plan/multiLegColumn.js", TIER.ALLOCATION_QUALITY],
  ["src/engine/plan/insertion.js", TIER.ALLOCATION_QUALITY],
  ["src/engine/plan/consolidation.js", TIER.ALLOCATION_QUALITY],
  ["src/engine/cost/cDefer.js", TIER.ALLOCATION_QUALITY],
  ["src/engine/cost/cChurn.js", TIER.ALLOCATION_QUALITY],
  ["src/engine/cost/cOpportunity.js", TIER.ALLOCATION_QUALITY],
  ["src/engine/lifecycle/preemption.js", TIER.ALLOCATION_QUALITY],
  ["src/engine/fairness/dutyCycle.js", TIER.ALLOCATION_QUALITY],
  ["src/engine/fairness/repositioning.js", TIER.ALLOCATION_QUALITY],
  ["src/engine/shard/crossRegion.js", TIER.ALLOCATION_QUALITY],

  // Tier 1 — the default for everything else inside the engine boundary.
  ["src/engine/", TIER.OPERATIONAL_INTEGRITY],
  ["src/workers/", TIER.OPERATIONAL_INTEGRITY],
]);

/**
 * Invariant → owning tier (§26.1). The partition is exhaustive and disjoint by
 * construction; `assertInvariantPartition()` proves it.
 */
const INVARIANT_TIERS = Object.freeze({
  I1: TIER.SAFETY_CORE,
  I2: TIER.SAFETY_CORE,
  I3: TIER.OPERATIONAL_INTEGRITY,
  I4: TIER.SAFETY_CORE,
  I5: TIER.SAFETY_CORE,
  I6: TIER.OPERATIONAL_INTEGRITY,
  I7: TIER.SAFETY_CORE,
  I8: TIER.SAFETY_CORE,
  I9: TIER.SAFETY_CORE,
  I10: TIER.OPERATIONAL_INTEGRITY,
  I11: TIER.OPERATIONAL_INTEGRITY,
  I12: TIER.SAFETY_CORE,
  I13: TIER.OPERATIONAL_INTEGRITY,
  I14: TIER.OPERATIONAL_INTEGRITY,
  I15: TIER.OPERATIONAL_INTEGRITY,
  I16: TIER.SAFETY_CORE,
  I17: TIER.SAFETY_CORE,
  I18: TIER.SAFETY_CORE,
  I19: TIER.SAFETY_CORE,
  I20: TIER.ALLOCATION_QUALITY,
  I21: TIER.SAFETY_CORE,
  I22: TIER.SAFETY_CORE,
});

/**
 * Modules that lie inside the engine tree but are build-time apparatus rather than
 * runtime mechanism. They are exempt from the parameter register (they encode no
 * behavioural constants) and from the decision-path tenets (they never run in a
 * round).
 */
const BUILD_TIME_MODULES = Object.freeze(["src/engine/guards/"]);

/**
 * Resolve a module's tier by longest-prefix match.
 *
 * @param {string} modulePath repo-relative POSIX path under `Backend/`
 * @param {Array<[string, number]>} [table] override, used by the gate self-tests
 * @returns {number|null} tier, or null when the path is outside every governed tree
 */
function tierOf(modulePath, table) {
  const entries = table || MODULE_TIERS;
  let best = null;
  let bestLength = -1;
  for (const [prefix, tier] of entries) {
    const matches = modulePath === prefix || modulePath.startsWith(prefix);
    if (matches && prefix.length > bestLength) {
      best = tier;
      bestLength = prefix.length;
    }
  }
  return best;
}

/**
 * Is `modulePath` build-time apparatus rather than a runtime mechanism?
 *
 * @param {string} modulePath
 * @returns {boolean}
 */
function isBuildTimeModule(modulePath) {
  return BUILD_TIME_MODULES.some((prefix) => modulePath.startsWith(prefix));
}

/**
 * §1.8 rule 2: a Tier 0 or Tier 1 module may not depend on a Tier 2 module.
 *
 * @param {number|null} fromTier
 * @param {number|null} toTier
 * @returns {boolean} true when the dependency is forbidden
 */
function isForbiddenDependency(fromTier, toTier) {
  if (fromTier === null || toTier === null) return false;
  return toTier === TIER.ALLOCATION_QUALITY && fromTier < TIER.ALLOCATION_QUALITY;
}

/**
 * Throw if a dependency violates §1.8 rule 2. The runtime counterpart of the build
 * gate, for use at module load time where a phase wires components dynamically.
 *
 * @param {string} fromPath
 * @param {string} toPath
 * @throws {Error}
 */
function assertTierDependency(fromPath, toPath) {
  const fromTier = tierOf(fromPath);
  const toTier = tierOf(toPath);
  if (isForbiddenDependency(fromTier, toTier)) {
    throw new Error(
      `§1.8 rule 2 violation: ${TIER_NAMES[fromTier]} module "${fromPath}" ` +
        `depends on ${TIER_NAMES[toTier]} module "${toPath}". ` +
        "No Tier 0 or Tier 1 guarantee may depend on a Tier 2 mechanism.",
    );
  }
}

/**
 * Prove the §26.1 claim that the invariant register partitions cleanly across the
 * tiers: every invariant belongs to exactly one tier, and the tier sets are the
 * ones §1.8 states.
 *
 * @returns {{ ok: boolean, problems: string[] }}
 */
function assertInvariantPartition() {
  const problems = [];
  const expected = {
    [TIER.SAFETY_CORE]: [
      "I1", "I2", "I4", "I5", "I7", "I8", "I9", "I12",
      "I16", "I17", "I18", "I19", "I21", "I22",
    ],
    [TIER.OPERATIONAL_INTEGRITY]: ["I3", "I6", "I10", "I11", "I13", "I14", "I15"],
    [TIER.ALLOCATION_QUALITY]: ["I20"],
  };

  for (const [tier, names] of Object.entries(expected)) {
    const actual = Object.keys(INVARIANT_TIERS)
      .filter((name) => String(INVARIANT_TIERS[name]) === tier)
      .sort();
    const wanted = [...names].sort();
    if (actual.join(",") !== wanted.join(",")) {
      problems.push(
        `${TIER_NAMES[tier]} carries [${actual.join(", ")}] but §1.8 states [${wanted.join(", ")}]`,
      );
    }
  }

  return { ok: problems.length === 0, problems };
}

/**
 * Every mechanism at a given tier.
 *
 * @param {number} tier
 * @returns {object[]}
 */
function mechanismsAtTier(tier) {
  return MECHANISMS.filter((mechanism) => mechanism.tier === tier);
}

/**
 * §22.5 rule 1: every Tier 2 mechanism MUST be individually disableable by a named
 * kill switch drawn from the §22.5 ladder, and must state what it degrades to.
 *
 * @returns {{ ok: boolean, problems: string[] }}
 */
function assertTierTwoIsDisableable() {
  const problems = [];
  for (const mechanism of mechanismsAtTier(TIER.ALLOCATION_QUALITY)) {
    if (!mechanism.killSwitch) {
      problems.push(`${mechanism.id} "${mechanism.name}" declares no kill switch (§22.5 rule 1)`);
      continue;
    }
    if (!KILL_SWITCHES.includes(mechanism.killSwitch)) {
      problems.push(
        `${mechanism.id} names kill switch "${mechanism.killSwitch}", which is not a recognised ` +
          "switch (§22.5 ladder, or a §1.8 rule-1 off-ladder switch)",
      );
    }
    if (!mechanism.degradesTo) {
      problems.push(`${mechanism.id} does not state the behaviour its kill switch degrades to`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Is this switch part of the §22.5 supported monotone ladder, whose prefixes are
 * the rehearsed combinations?
 *
 * @param {string} switchName
 * @returns {boolean}
 */
function isOnSupportedLadder(switchName) {
  return KILL_SWITCH_LADDER.includes(switchName);
}

module.exports = {
  TIER,
  TIER_NAMES,
  MECHANISMS,
  MODULE_TIERS,
  INVARIANT_TIERS,
  KILL_SWITCH_LADDER,
  KILL_SWITCHES_OFF_LADDER,
  KILL_SWITCHES,
  isOnSupportedLadder,
  BUILD_TIME_MODULES,
  tierOf,
  isBuildTimeModule,
  isForbiddenDependency,
  assertTierDependency,
  assertInvariantPartition,
  assertTierTwoIsDisableable,
  mechanismsAtTier,
};
