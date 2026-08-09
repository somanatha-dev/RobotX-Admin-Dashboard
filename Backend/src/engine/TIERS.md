# Obligation Tiers — the correctness core

**Normative source:** `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` §1.8 (FROZEN).
**Machine-readable source of truth:** [`guards/tierAssertions.js`](guards/tierAssertions.js).
**Enforced by:** [`tools/gates/checkTierDependencies.js`](../../tools/gates/checkTierDependencies.js).

This document and `tierAssertions.js` are checked against each other by the engine
test lane (`tests/engine/tierRegistry.test.js`). Editing one without the other fails
the build. Where they disagree with §1.8, §1.8 wins and both are defective.

---

## Why tiers exist

> "This specification is large, and every mechanism in it is written in the same
> voice. That is a hazard: a document whose thirty-eight feasibility predicates,
> column generation, deferral, preemption, churn pricing, approximate-dynamic-
> programming terminal values, and hierarchical Bayesian reliability estimation all
> appear at the same level of obligation will be partially implemented — its scope
> guarantees that — and the subset that ships will otherwise be self-selected by
> whoever implements it first, with no analysis of whether that subset is safe on
> its own." — §1.8

**The obligations are tiered, and the tiering is normative.** A mechanism's tier
states what its absence or incorrectness costs.

| Tier | Name | If it is wrong | May a release ship without it? |
|---|---|---|---|
| **0** | **Safety core** | A physical incident: a double-commanded machine, a stranded or immobilised agent, lost goods, an unsafe pairing executed | **No.** No agent may be commanded by an engine whose Tier 0 is incomplete |
| **1** | **Operational integrity** | The engine is unsupportable, unauditable, or unbounded in time — it makes decisions nobody can explain, reproduce, or terminate | **No**, for production. A Tier 1 gap is a launch blocker, not a safety event |
| **2** | **Allocation quality** | The engine allocates worse than it could. Nothing physical is at risk | **Yes.** Each is individually disableable (§22.5) |

## The three rules

1. **Every Tier 2 mechanism MUST be individually disableable**, and every kill
   switch MUST degrade to a Tier 1 behaviour that is itself complete and tested
   (§22.5). A kill switch that degrades to an untested path is not a control.
2. **No Tier 0 or Tier 1 guarantee may depend on a Tier 2 mechanism.** This is the
   rule `checkTierDependencies.js` enforces over the static import graph.
3. **The staged implementation order is a consequence, not a suggestion.** Tier 0
   plus Tier 1, at `capacity[agent_class] = 1`, in the singleton regime, with
   deferral and preemption off and `λ_zone` from static configured priors, is a
   complete, safe, shippable engine. Phases 0–15 of the execution plan deliver
   exactly that; Phase 16 enables Tier 2 one mechanism at a time.

---

## Tier 0 — the safety core

These mechanisms, and only these, are what make it safe to command a physical
machine at all.

| ID | Mechanism | Spec | Owning module(s) | Invariants |
|---|---|---|---|---|
| T0-01 | Feasibility gate as a boolean pre-cost gate, structurally incapable of being bypassed, with its class I and R predicates | §7.1, §7.5, T1 | `src/engine/feasibility/evaluate.js`<br>`src/engine/feasibility/register.js`<br>`src/engine/feasibility/predicates/` | I9, I14 |
| T0-02 | Three-valued evaluation with DENY on indeterminate for every class I and R predicate, and the systemic-indeterminacy guard | §7.3, §7.4 | `src/engine/feasibility/threeValued.js`<br>`src/engine/feasibility/systemicGuard.js` | I9 |
| T0-03 | Energy feasibility at all three shortfall tiers, and charger reachability from the mission end — F34, F35 | §14.5 | `src/engine/energy/consumption.js`<br>`src/engine/energy/usable.js`<br>`src/engine/energy/reserves.js`<br>`src/engine/energy/tiers.js`<br>`src/engine/energy/eReturn.js`<br>`src/engine/routing/chargerReachabilityCache.js`<br>`src/engine/feasibility/predicates/f34.js`<br>`src/engine/feasibility/predicates/f35.js`<br>`src/engine/energy/chargeCurve.js`<br>`src/engine/energy/midMission.js`<br>`src/engine/energy/chargingSchedulerClient.js` | I17 |
| T0-04 | Payload, capability, and route-permission predicates — F21–F31 | §7.5, §15 | `src/engine/payload/spec.js`<br>`src/engine/payload/container.js`<br>`src/engine/payload/packing.js`<br>`src/engine/payload/loadState.js`<br>`src/engine/domain/capability.js` | I9 |
| T0-05 | Exclusivity: the serialised conditional commit with guards G1–G6 and its schema backstops | §10.3.2 | `src/engine/commitment/commit.js`<br>`src/engine/commitment/guards.js`<br>`src/engine/commitment/model.js`<br>`src/engine/commitment/idempotency.js`<br>`src/engine/commitment/clock.js`<br>`src/engine/commitment/leases.js` | I1, I16, I18 |
| T0-06 | Two-scope fencing and durable agent-side deduplication | §10.3.1, §11.5 | `src/engine/commitment/fencing.js`<br>`src/engine/dispatch/dedupHandshake.js` | I5, I19, I21 |
| T0-07 | Custody as a first-class state, with settlement ordering | §2.5, §4.9 | `src/engine/domain/custody.js`<br>`src/engine/lifecycle/settlement.js`<br>`src/engine/payload/custodyEvidence.js` | I7, I8 |
| T0-08 | Durable timers keyed on each entity's own version, and the reconciler | §4.5, §12 | `src/engine/supervision/timers.js`<br>`src/engine/supervision/leases.js`<br>`src/engine/supervision/progress.js`<br>`src/engine/supervision/reconciler.js`<br>`src/engine/supervision/verification.js`<br>`src/workers/timer.worker.js`<br>`src/workers/reconciler.worker.js` | I2, I4, I12 |
| T0-09 | The transactional outbox | §11.1, §4.1 rule 5 | `src/engine/dispatch/outbox.js`<br>`src/engine/dispatch/sequence.js`<br>`src/engine/dispatch/offers.js`<br>`src/engine/dispatch/escalation.js`<br>`src/workers/outbox.worker.js` | I16 |
| T0-10 | Stranding classification and the external escalation chain | §4.3, §18.6 | `src/engine/map/obstructionClass.js`<br>`src/engine/failure/externalEscalation.js` | I22 |
| T0-11 | The degraded-mode register, with every suspension explicit, named, and time-boxed | §18.5, §26.2 | `src/engine/degraded/modeRegister.js`<br>`src/engine/failure/catalogue.js` | I2 |

Tier 0 carries invariants **I1, I2, I4, I5, I7, I8, I9, I12, I16, I17, I18, I19,
I21, I22** (§1.8, §26.1).

---

## Tier 1 — operational integrity

Not required for any single mission to be *safe*; required for the engine to be
operable, defensible, and bounded.

| ID | Mechanism | Spec | Owning module(s) | Invariants |
|---|---|---|---|---|
| T1-01 | Absolute CU units, dimensioned exchange rates, and the parameter register | §1.3, §22, Appendix A | `src/engine/cost/units.js`<br>`src/engine/cost/exchangeRates.js`<br>`src/engine/config/service.js`<br>`src/engine/config/resolver.js`<br>`src/engine/config/validators.js`<br>`src/engine/config/derived.js`<br>`src/engine/config/calibrationStatus.js`<br>`src/engine/config/killSwitches.js`<br>`src/engine/config/regimes.js`<br>`src/engine/config/register/` | I15 |
| T1-02 | Determinism and replayability of every decision | §9.6, T6 | `src/engine/determinism/fixedPoint.js`<br>`src/engine/determinism/ordering.js`<br>`src/engine/determinism/snapshot.js` | I10 |
| T1-03 | The Tier A decision record and the Explanation API | §21.2, §21.3 | `src/engine/observability/decisionRecord.js`<br>`src/controllers/explain.controller.js`<br>`src/routes/explain.routes.js` | I10 |
| T1-04 | The anti-starvation escalation ladder — where the anti-starvation guarantee lives | §17.4 | `src/engine/fairness/ladder.js`<br>`src/engine/fairness/operatorCapacity.js`<br>`src/engine/fairness/agentStarvation.js` | I13 |
| T1-05 | Cancellation, reassignment, and settlement | §4.6, §4.7, §4.9 | `src/engine/lifecycle/cancellation.js`<br>`src/engine/lifecycle/reassignment.js`<br>`src/engine/lifecycle/settlement.js` | I11 |
| T1-06 | Admission control and backpressure | §20.5 | `src/engine/intake/intake.js`<br>`src/engine/intake/admission.js` | — |
| T1-07 | The Invariant Checker | §26 | `src/engine/observability/invariantChecker.js`<br>`src/workers/invariant.worker.js` | I3, I6 |

Tier 1 carries invariants **I3, I6, I10, I11, I13, I14, I15** (§1.8, §26.1).

---

## Tier 2 — allocation quality

Each of these improves the answer. None is permitted to be load-bearing for a
Tier 0 or Tier 1 guarantee.

| ID | Mechanism | Spec | Owning module(s) | Kill switch | Degrades to |
|---|---|---|---|---|---|
| T2-01 | Batch solving | §9.1, §9.2 | `src/engine/solve/batch.js` | `batch_solving` | The same round executed with a batch of one Leg (§9.2) |
| T2-02 | Multi-Leg columns (bundling and consolidation) | §9.3 | `src/engine/solve/setPartitioning.js`<br>`src/engine/plan/multiLegColumn.js` | `multi_leg_columns` | Singleton columns only — every round in the singleton regime, where the solve is a totally unimodular min-cost flow, integral and exact (§9.3) |
| T2-03 | Chaining — queue depth capacity > 1 | §13.3 | `src/engine/plan/insertion.js` | `chaining` | capacity[agent_class] = 1; strict one-mission-per-agent |
| T2-04 | Deferral as a priced arc | §8.8 | `src/engine/cost/cDefer.js` | `deferral` | Immediate assignment when any feasible candidate exists |
| T2-05 | Preemption, including victim disposition | §4.8 | `src/engine/lifecycle/preemption.js` | `preemption` | Disabled entirely |
| T2-06 | The opportunity-cost and terminal-value model | §8.3, §8.3.1 | `src/engine/cost/cOpportunity.js`<br>`src/engine/pricing/vTerminal.js`<br>`src/engine/pricing/capacityPricingClient.js`<br>`src/engine/pricing/forecastClient.js` | `opportunity_cost_term` | λ_zone from configured static per-zone, per-bucket priors; the derivation of §8.3 is unchanged, only its input source is (§5.2) |
| T2-07 | Churn pricing | §8.9 | `src/engine/cost/cChurn.js` | `churn_pricing` **(off ladder)** | Reassignment priced without a churn term |
| T2-08 | Post-solve local search | §9.5 | `src/engine/solve/localSearch.js` | `local_search` **(off ladder)** | The solver's own solution, reported with its own gap |
| T2-09 | Reliability-priced risk | §8.4, §16 | `src/engine/reliability/` | `reliability_based_gating` | Cohort priors only |
| T2-10 | The duty-cycle regulariser | §17.2 | `src/engine/fairness/dutyCycle.js` | `duty_cycle_regulariser` **(off ladder)** | Priced wear only (§17.1) |
| T2-11 | Repositioning | §17.3 | `src/engine/fairness/repositioning.js` | `reposition_injection` | No reposition missions |
| T2-12 | Consolidation and chaining in the Plan Builder | §13.3 | `src/engine/plan/consolidation.js` | `multi_leg_columns` | Single-Leg plans only |
| T2-13 | Cross-region candidacy | §19.6 | `src/engine/shard/crossRegion.js` | `cross_region_candidacy` | Region-local only |

Invariant **I20** governs the *claims* Tier 2 makes and MUST hold whenever any of
these is enabled — a quality mechanism may be absent, but it may not lie about its
own optimality.

### The §22.5 supported monotone ladder

The supported kill-switch combinations are the **prefixes** of this order. Any other
combination is *permitted* — an operator must never be blocked from disabling a
specific misbehaving mechanism — but is recorded as an **unrehearsed combination**,
alerts as such, and requires explicit acknowledgement.

| Step | Switch |
|---|---|
| 1 | `reposition_injection` |
| 2 | `preemption` |
| 3 | `deferral` |
| 4 | `cross_region_candidacy` |
| 5 | `chaining` |
| 6 | `multi_leg_columns` |
| 7 | `reliability_based_gating` |
| 8 | `batch_solving` |
| 9 | `opportunity_cost_term` |

### Recorded specification discrepancy — three mechanisms, no ladder row

§1.8 enumerates **twelve** Tier 2 mechanisms. §22.5 tabulates **nine** kill switches
and then reasons about "the nine independent switches above" and their 512
combinations. Churn pricing (§8.9), post-solve local search (§9.5), and the
duty-cycle regulariser (§17.2) appear in the §1.8 list with no §22.5 row.

Phase 0 does **not** resolve this — resolving it is an architecture change, and the
architecture is frozen. It records it. Those three carry their own switch
(`churn_pricing`, `local_search`, `duty_cycle_regulariser`) so that §1.8 rule 1
holds, and they are marked **off ladder**, leaving §22.5 rule 2's prefix reasoning
and its 2⁹ combination count untouched. Throwing one of the three is therefore an
unrehearsed combination and alerts as such.

Escalated to the tech lead in `PHASE_0_IMPLEMENTATION_REPORT.md` as an open item for
**Phase 1**, which owns `src/engine/config/killSwitches.js` and the ladder.

---

## Module tier assignment

The table the dependency gate reads. **Longest prefix wins.**

| Path prefix | Tier |
|---|---|
| `src/engine/commitment/` | Tier 0 — Safety core |
| `src/engine/dispatch/` | Tier 0 — Safety core |
| `src/engine/supervision/` | Tier 0 — Safety core |
| `src/engine/feasibility/` | Tier 0 — Safety core |
| `src/engine/energy/` | Tier 0 — Safety core |
| `src/engine/payload/` | Tier 0 — Safety core |
| `src/engine/degraded/` | Tier 0 — Safety core |
| `src/engine/failure/` | Tier 0 — Safety core |
| `src/engine/map/` | Tier 0 — Safety core |
| `src/engine/domain/custody.js` | Tier 0 — Safety core |
| `src/engine/domain/capability.js` | Tier 0 — Safety core |
| `src/engine/lifecycle/settlement.js` | Tier 0 — Safety core |
| `src/engine/routing/chargerReachabilityCache.js` | Tier 0 — Safety core |
| `src/workers/timer.worker.js` | Tier 0 — Safety core |
| `src/workers/reconciler.worker.js` | Tier 0 — Safety core |
| `src/workers/outbox.worker.js` | Tier 0 — Safety core |
| `src/engine/reliability/` | Tier 2 — Allocation quality |
| `src/engine/pricing/` | Tier 2 — Allocation quality |
| `src/engine/solve/batch.js` | Tier 2 — Allocation quality |
| `src/engine/solve/setPartitioning.js` | Tier 2 — Allocation quality |
| `src/engine/solve/localSearch.js` | Tier 2 — Allocation quality |
| `src/engine/plan/multiLegColumn.js` | Tier 2 — Allocation quality |
| `src/engine/plan/insertion.js` | Tier 2 — Allocation quality |
| `src/engine/plan/consolidation.js` | Tier 2 — Allocation quality |
| `src/engine/cost/cDefer.js` | Tier 2 — Allocation quality |
| `src/engine/cost/cChurn.js` | Tier 2 — Allocation quality |
| `src/engine/cost/cOpportunity.js` | Tier 2 — Allocation quality |
| `src/engine/lifecycle/preemption.js` | Tier 2 — Allocation quality |
| `src/engine/fairness/dutyCycle.js` | Tier 2 — Allocation quality |
| `src/engine/fairness/repositioning.js` | Tier 2 — Allocation quality |
| `src/engine/shard/crossRegion.js` | Tier 2 — Allocation quality |
| `src/engine/` | Tier 1 — Operational integrity |
| `src/workers/` | Tier 1 — Operational integrity |

> **Not every module under a Tier 0 prefix is named in the mechanism inventory above.**
> `src/engine/energy/wear.js` is the standing example: §14.4 charges battery wear into
> `C_lifecycle`, which is a Tier 1 cost term, and §1.8 names no Tier 0 mechanism it
> belongs to. Its Tier 0 classification comes from the path prefix — convention 1's
> conservative default — and over-constraining the rule-2 gate is the only effect that
> has. The inventory enumerates the mechanisms §1.8 names; the prefix table is what the
> gate reads.

Two conventions, stated so a reviewer can check them against §1.8:

1. **Modules not named by §1.8 default to Tier 1.** §1.8 enumerates mechanisms whose
   absence has a stated cost, not an exhaustive module partition. Only a mechanism
   §1.8 explicitly lists under Tier 2 is Tier 2 here. The default is conservative: it
   can only over-constrain the rule-2 gate, never relax it.
2. **Where a module would host both a base behaviour and a Tier 2 enhancement, the
   Tier 2 behaviour lives in its own module.** Φ (`cost/phi.js`, Tier 1) may not
   import `cost/cOpportunity.js` (Tier 2); it obtains optional terms through
   registration, never a static import.

`src/engine/lifecycle/settlement.js` is dual-listed by §1.8 — Tier 0 for custody
settlement *ordering*, Tier 1 for settlement itself. It is assigned **Tier 0**, the
stricter of the two, which can only over-constrain the gate.

### The compliant pattern for an optional Tier 2 enhancement

A Tier 1 module never imports its Tier 2 enhancement. The Tier 2 module registers
with, or is injected into, the Tier 1 module at composition time:

```
  ✗  cost/phi.js          require("./cOpportunity")     ← gate fails
  ✓  engine/bootstrap.js  phi.registerTerm(cOpportunity) when the switch is on
```

This is §1.8 rule 2 and §22.5 rule 1 acting together. A Tier 2 mechanism statically
linked into the Tier 1 path is a kill switch that cannot actually be thrown, and a
Tier 1 path that cannot run without it is a Tier 1 guarantee depending on Tier 2.

---

## Invariant → tier partition (§26.1)

"Each invariant belongs to exactly one obligation tier, and the register partitions
cleanly across them." `assertInvariantPartition()` proves this mechanically and the
dependency gate runs it on every invocation.

| Invariant | Tier |
|---|---|
| I1 | Tier 0 — Safety core |
| I2 | Tier 0 — Safety core |
| I3 | Tier 1 — Operational integrity |
| I4 | Tier 0 — Safety core |
| I5 | Tier 0 — Safety core |
| I6 | Tier 1 — Operational integrity |
| I7 | Tier 0 — Safety core |
| I8 | Tier 0 — Safety core |
| I9 | Tier 0 — Safety core |
| I10 | Tier 1 — Operational integrity |
| I11 | Tier 1 — Operational integrity |
| I12 | Tier 0 — Safety core |
| I13 | Tier 1 — Operational integrity |
| I14 | Tier 1 — Operational integrity |
| I15 | Tier 1 — Operational integrity |
| I16 | Tier 0 — Safety core |
| I17 | Tier 0 — Safety core |
| I18 | Tier 0 — Safety core |
| I19 | Tier 0 — Safety core |
| I20 | Tier 2 — Allocation quality |
| I21 | Tier 0 — Safety core |
| I22 | Tier 0 — Safety core |

---

## Release gates per tier (§24, §1.8)

| Tier | Required gates |
|---|---|
| Tier 0 | Model checking (§24.2) **and** chaos injection (§24.5) |
| Tier 1 | Replay and reconstruction-equivalence gates (§24.3) |
| Tier 2 | Shadow evaluation and counterfactual measurement (§21.6) |

A tier's gates are not optional for a release that ships that tier.
