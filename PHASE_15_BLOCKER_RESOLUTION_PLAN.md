# Phase 15 — Blocker Resolution Plan and Phase 16 Readiness Analysis

**Role:** Principal Distributed-Systems Architect / Performance Engineer / Safety-Release Engineer,
acting as independent technical reviewer.
**Status of this document:** ANALYSIS AND PLANNING ONLY. No source, test, configuration, schema,
migration, architecture document, or verification report was modified in producing it. No parameter
was calibrated, no solver optimised, no shard staged, no gate closed, no commit created. The only
files written during this analysis were throwaway benchmarks in a scratch directory outside the
repository.
**Date:** 2026-08-08 · **Branch:** `feature/dashboard` · **Baseline:** `cf9103f`, with Phases 6–15
present as one uncommitted working tree (unchanged by this analysis).

**Authoritative inputs, read in full:** `PHASE_15_INDEPENDENT_VERIFICATION.md`,
`PHASE_15_IMPLEMENTATION_REPORT.md`, `IMPLEMENTATION_EXECUTION_PLAN.md` (Phase 10, 14, 15, 16 rows;
§6.1 blocking decisions; §7 checklists), `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` §20.1–20.5, §21.6,
§22.4, §22.5, §24.1–24.7, `PHASE_14_INDEPENDENT_VERIFICATION.md`, `PHASE_14_IMPLEMENTATION_REPORT.md`.

**Independent work performed for this plan (read-only):** re-ran `tools/gates/checkCalibration.js
--all` and captured all 39 findings verbatim; enumerated all 54 Safety-class register entries
directly from the four register JSON files with every field; read `src/engine/solve/minCostFlow.js`,
`src/engine/solve/objective.js`, `src/engine/cutover/gates.js`, `src/workers/registry.js`,
`docs/runbooks/cutover.md`, `docs/runbooks/rollback.md`, `tools/simFidelity/validate.js`,
`tests/scale/round.scale.test.js`, `tests/scale/helpers/scaleHarness.js`; and **measured the solver
and the objective builder at §20.1's actual shape**, which no existing document does.

---

## Table of contents

1. [Executive Summary](#1-executive-summary)
2. [Current Verified State](#2-current-verified-state)
3. [Exact Phase 16 Entry Conditions](#3-exact-phase-16-entry-conditions)
4. [Blocker Dependency Graph](#4-blocker-dependency-graph)
5. [Calibration Analysis — all 39 parameters](#5-calibration-analysis--all-39-parameters)
6. [Calibration Evidence Strategy](#6-calibration-evidence-strategy)
7. [Solver Root-Cause Analysis](#7-solver-root-cause-analysis)
8. [Solver Alternatives Comparison](#8-solver-alternatives-comparison)
9. [Solver Recommendation](#9-solver-recommendation)
10. [Phase Ownership Decision](#10-phase-ownership-decision)
11. [Production Evidence Plan](#11-production-evidence-plan)
12. [Rollback Rehearsal Plan](#12-rollback-rehearsal-plan)
13. [Minor Findings Assessment](#13-minor-findings-assessment)
14. [Parallel Workstreams](#14-parallel-workstreams)
15. [Ordered Remediation Sequence](#15-ordered-remediation-sequence)
16. [Phase 16 Readiness Matrix](#16-phase-16-readiness-matrix)
17. [Final Recommendation](#17-final-recommendation)
18. [Pre-Phase-16 Master Plan](#18-pre-phase-16-master-plan)

---

## 1. Executive Summary

The independent verification's conclusion stands without qualification: **Phase 15's implementation
is correct, and Phase 16 is NOT READY.** Nothing in the repository contradicts it. This document
does not re-litigate that finding; it determines what must happen next.

Four blockers were named. Independent inspection confirms all four, and finds that **three of them
are materially worse than the existing documents state**, in ways that change the sequencing:

**1. The solver blocker is roughly an order of magnitude larger than reported, and it is not
confined to the solver.** The Phase 15 report and the verification both quote 1 615 ms at
500 Legs × 10 candidates against a 250 ms target, characterising the gap as "roughly an order of
magnitude" (`PHASE_15_INDEPENDENT_VERIFICATION.md:684`). That measurement is taken at **one twentieth
of §20.1's candidate count** — the test file discloses the substitution honestly
([round.scale.test.js:180-182](Backend/tests/scale/round.scale.test.js#L180-L182)) but nobody has
measured the real shape. This review did:

| Shape | `minCostFlow.solve` | `objective.buildInstance` | §20.1 budget | Factor over budget |
|---|---|---|---|---|
| 500 × 10 (what the suite measures) | 1 673 ms | 110 ms | 250 ms | 6.7× (solve alone) |
| **500 × 200 (§20.1's actual shape)** | **24 356 ms** | **13 421 ms** | **250 ms** | **≈ 97× (solve alone); ≈ 151× including instance build** |

The gap is two orders of magnitude, not one. And a **second, entirely unreported quadratic-class
hot spot** exists upstream of the solver: `objective.buildInstance` builds its coverage and
exclusivity rows with a `columnVars.filter(...)` per Leg and per agent
([objective.js:193-218](Backend/src/engine/solve/objective.js#L193-L218)), which is O((m + n) · q) —
13.4 s at the §20.1 shape, 54× the entire round budget, **before the solver starts**. Unlike the
solver, this one is pure implementation inefficiency with an O(q) fix and no algorithmic or
correctness consequence.

A third consequence follows and is operationally severe. §9.4's anytime budget is wired
([round.js:410](Backend/src/engine/solve/round.js#L410), checked between augmentations at
[minCostFlow.js:391-401](Backend/src/engine/solve/minCostFlow.js#L391-L401)), and the Phase 15 report
argues it "bounds the *damage*". At the measured rate — 24 356 ms / 500 augmentations ≈ 48 ms per
augmentation — a 250 ms `solve.time_budget` permits **about five augmentations**. The damage bound at
§20.1's own shape is therefore *approximately 1 % of the batch assigned per round*. That is not a
bounded degradation; it is a non-functional round.

**2. Calibration is not one blocker but four different kinds of blocker wearing one gate.** Of the
39 Safety-class parameters that are not `DERIVED`, only a minority genuinely require the engine to
have operated. Reading each entry's own `awaits` field: **13 are decisions**, not measurements
(ops/finance/safety sign-off, external-authority agreements, vendor certifications); **14 are
measurable from the fleet and infrastructure that exist today**, with no engine cutover required;
**7 are blocked behind unresolved execution-plan §6.1 blocking decisions** (B1 routing, B2 charging
scheduler, B3 consensus store) or behind deferred workers; **3 genuinely require observing the
engine's own behaviour**, and all three are satisfiable in **shadow mode** rather than in production;
and **2 are legacy entries whose architecture-sanctioned disposition is retirement, not derivation**
(`legacy.dtaro.*`, `consumers: []`, `retiredInPhase: 15`). Calibration is therefore mostly *not*
gated on cutover, which contradicts the fatalistic reading that "the fleet must operate first" and
makes the majority of it startable immediately.

One parameter is **circular as written**: `sim.max_optimistic_bias` is Safety-class and awaits "the
first one-sided simulator fidelity study against production", while the `simulator_fidelity` release
gate is defined as "no safety-relevant model exceeds `sim.max_optimistic_bias`"
([gates.js:243](Backend/src/engine/cutover/gates.js#L243)). A tolerance cannot be derived from the
study it bounds. This must be re-derived as a Safety *decision* on admissible optimism, recorded as
such — not measured.

**3. `shadow_agreement` has an unnamed engineering prerequisite on the critical path.** The
verification classifies the four PRODUCTION gates as "cannot be discharged by any repository build;
require the fleet to have actually operated" (`PHASE_15_INDEPENDENT_VERIFICATION.md:688-691`). That
is true but incomplete for shadow: the `shadow` worker is `DEFERRED` in the worker registry, blocked
on "the composition root that builds those five collaborators outside a test fixture"
([registry.js:181-195](Backend/src/workers/registry.js#L181-L195)). Shadow mode cannot start
collecting its ≥ 14 days of evidence until that engineering lands. Since 14 days is the longest
single-item lead time in the whole remediation, **the shadow composition root is the critical-path
item nobody has scheduled.**

**4. Rollback rehearsal is the cheapest blocker and is genuinely startable today.** The runbook's §5
already specifies a discharging rehearsal in six steps
([rollback.md:148-167](docs/runbooks/rollback.md#L148-L167)), and every one of them is a *staging*
activity. It has no dependency on calibration, on the solver, or on production. It is being treated
as a late-stage formality when it is in fact the earliest thing that can be closed, and step 4
(rollback B, redeploying the pre-Phase-15 artefact) is the step that will surface unknowns.

**The single recommended next action** is stated in full in §17: **fix and re-measure
`objective.buildInstance`, then re-run the scale suite at §20.1's actual 500 × 200 shape and publish
the corrected measurement.** It is one to two days of low-risk work; it costs nothing if the solver
is later replaced; and it is the only action that converts the largest and least-understood blocker
from an estimate into a measurement — which is a precondition for scoping the solver work honestly
rather than guessing at it.

---

## 2. Current Verified State

### 2.1 What is established and not in dispute

Reproduced from `PHASE_15_INDEPENDENT_VERIFICATION.md` §4, §17, §18 and independently spot-checked:

| Dimension | State |
|---|---|
| Phase 15 code | **Correct.** Cutover conjunction, five refusals, one-directional automatic rollback, 23-gate table, both new build gates (proven able to fail), runtime gate-before-write routing, socket/Frontend contract, safety-case assembler (byte-identical regeneration), formal-verification disclosure |
| Build gates (6) | All PASS |
| Jest lanes (5) | 135 suites / 6 008 tests / 0 failures |
| `npm run release:gates` | Exit 1, stopping at `gate:calibration` |
| Release gates (23) | 16 GREEN, **2 RED** (`calibration_safety_derived`, `scale_targets`), 1 partially discharged (`locality`), 4 `NOT_EVALUATED` |
| Legacy retirement | Complete — file, gate, and repository-wide semantic sweep |
| Phase 16 leakage | None. `fairness/` empty; no `preemption.js`, `setPartitioning.js`, `branchAndBound.js`, `localSearch.js`; all 12 Tier 2 kill switches default thrown |
| Shards staged | Zero. `stage.authoriseEnable()` refuses every shard |

### 2.2 What this review adds to the state model

Facts material to remediation that are **not** recorded in either Phase 15 document:

| # | Finding | Evidence |
|---|---|---|
| N1 | Solve at §20.1's real shape (500 × 200) is **24 356 ms**, not the ~1.6 s the suite reports at 500 × 10. The gap is ≈ 97×, not ≈ 6.7× | Direct measurement, this review, single trial, same machine and code path the suite uses |
| N2 | `objective.buildInstance` is itself quadratic-class — O((m + n) · q) via two per-row `filter` sweeps — and costs **13 421 ms** at 500 × 200 (110 ms at 500 × 10) | [objective.js:193-218](Backend/src/engine/solve/objective.js#L193-L218); measured 260 ms @10k cols, 914 ms @25k, 2 755 ms @50k, 13 421 ms @100k |
| N3 | At the measured per-augmentation cost (≈ 48 ms), `solve.time_budget` = 250 ms yields **≈ 5 of 500 Legs assigned**. §9.4's anytime escape does not bound the damage at the target shape in any useful sense | Derived from N1 and [minCostFlow.js:390-401](Backend/src/engine/solve/minCostFlow.js#L390-L401) |
| N4 | The `shadow` worker is `DEFERRED` and names a missing composition root as its blocker. `shadow_agreement` is therefore gated on engineering, not only on elapsed time | [registry.js:181-195](Backend/src/workers/registry.js#L181-L195) |
| N5 | `energy_calibration` and `service_time_model` workers are also `DEFERRED` — the calibration loops for the energy and service-time parameter families are not running | [registry.js:232-256](Backend/src/workers/registry.js#L232-L256) |
| N6 | `charger_reachability` is `DEFERRED` for want of "a routing client this process does not construct"; the engine's `routing/` directory contains **caches only** and the sole routing provider in the tree is `src/services/mapbox.service.js`. Execution-plan blocking decision **B1 is unresolved** | `ls Backend/src/engine/routing/`; [execution plan:956](IMPLEMENTATION_EXECUTION_PLAN.md#L956) — "The current Mapbox dependency is explicitly incompatible with the hot path. Longest lead time of any item here" |
| N7 | `sim.max_optimistic_bias` is circular as registered: Safety-class, awaits the fidelity study, and is the threshold the fidelity gate compares against | `supplementary.json` entry; [gates.js:237-244](Backend/src/engine/cutover/gates.js#L237-L244) |
| N8 | Two of the 39 (`legacy.dtaro.battery_threshold_pct`, `legacy.dtaro.charging_interrupt_battery_pct`) have `retiredInPhase: 15` and `consumers: []` / one simulation-only consumer. Their `awaits` says "replacement by the Wh-denominated layered reserve model" — i.e. retirement, not derivation | `legacy.json`; `src/config/dtaro.constants.js:44,48` |
| N9 | Phase 14's Finding 2 is still open: `surrogateKeys` is written by no engine code path — a repository-wide grep of `observability/` and `determinism/` returns zero hits. Phase 14's verification recommended resolving it "before Phase 15 treats the column as populated" | `PHASE_14_INDEPENDENT_VERIFICATION.md:108`; grep of `Backend/src/engine/observability/`, `Backend/src/engine/determinism/` |
| N10 | `round.js` partitions oversized batches into connected components of the Leg–agent feasibility graph ([round.js:150-190](Backend/src/engine/solve/round.js#L150-L190)). Whether that partition is fine-grained at production candidate density is **unmeasured**; a shard whose feasibility graph is one giant component gets no relief | [round.js:158](Backend/src/engine/solve/round.js#L158) |

**None of N1–N10 contradicts the Phase 15 verification.** N1–N3 sharpen its finding 2; N4–N6 sharpen
its finding 3; N7–N8 sharpen its finding 1; N9–N10 are new.

### 2.3 The 23 release gates and their exact blocking conditions

Every row in [gates.js:84-277](Backend/src/engine/cutover/gates.js#L84-L277) carries `blocking: true`.
`evaluate()` treats `NOT_EVALUATED` identically to `RED` for the purpose of `ok`
([gates.js:359](Backend/src/engine/cutover/gates.js#L359)); `blockers()` returns every blocking row
that is not `GREEN`. There is deliberately **no `WAIVED` status**
([gates.js:38-40](Backend/src/engine/cutover/gates.js#L38-L40)).

| # | Gate | Evidence kind | Status | What closes it |
|---|---|---|---|---|
| 1 | `tier_dependencies` | BUILD | GREEN | `npm run gate:tiers` |
| 2 | `parameter_register` | BUILD | GREEN | `npm run gate:params` |
| 3 | `design_tenets` | BUILD | GREEN | `npm run gate:tenets` |
| 4 | `identity_isolation` | BUILD | GREEN | `npm run gate:privacy` |
| 5 | `erasure_reconstruction_equivalence` | BUILD | GREEN | `npm run gate:erasure` |
| 6 | `calibration_safety_derived` | ORGANISATIONAL | **RED** | 39 Safety-class parameters `DERIVED` with a stated derivation |
| 7 | `legacy_removed_from_build` | BUILD | GREEN | `npm run gate:legacy` |
| 8 | `lower_bound_admissibility` | SUITE | GREEN | engine lane |
| 9 | `model_check_capacity_1_2_3` | SUITE | GREEN | engine lane, exhaustive at 1/2/3 |
| 10 | `determinism_replay` | SUITE | GREEN | engine lane |
| 11 | `snapshot_retention` | SUITE | GREEN | engine lane |
| 12 | `chaos_capacity_1` | SUITE | GREEN | `npm run test:chaos` |
| 13 | `chaos_capacity_2` | SUITE | GREEN | `npm run test:chaos` |
| 14 | `cache_tier_flush` | SUITE | GREEN | `npm run test:chaos -- cacheFlush` |
| 15 | `scale_targets` | SUITE | **RED** | every §20.1 target met, incl. both p99.9 rows |
| 16 | `locality` | SUITE | **PARTIAL** | T9 cross-scale benchmark — not build-closable as classified (Finding 4) |
| 17 | `overload_admission_control` | SUITE | GREEN | `npm run test:scale -- overload` |
| 18 | `invariants_enforced` | PRODUCTION | NOT_EVALUATED | all 22 §26 invariants `ENFORCED`, zero-violation SLI |
| 19 | `simulator_fidelity` | PRODUCTION | NOT_EVALUATED | one-sided per-model study within `sim.max_optimistic_bias` |
| 20 | `soak` | PRODUCTION | NOT_EVALUATED | `release.soak_duration` (72 h default, PROVISIONAL) with no drift |
| 21 | `shadow_agreement` | PRODUCTION | NOT_EVALUATED | `cutover.shadow_agreement_window` (14 days, DERIVED) + published report |
| 22 | `safety_case_assembled` | ORGANISATIONAL | GREEN | `npm run safety:case` |
| 23 | `rollback_rehearsed` | ORGANISATIONAL | NOT_EVALUATED | rehearsal per `rollback.md` §5, dated, with named operators |

**Critical structural fact:** `authoriseEnable()`'s refusal #1 calls `gates.blockers(...)` with
whatever evidence the caller supplies. With no evidence filed, **all 23** read `NOT_EVALUATED` and
block — not merely the two red ones. There is no state of this repository in which a shard can be
enabled, and no waiver or override applies to gate status
(`options.overrideOrder` applies only to refusal #5, the staging order).

---

## 3. Exact Phase 16 Entry Conditions

Phase 16's prerequisite is stated in exactly one place and it is not a summary of Phase 15's
checklist — it is Phase 15's **completion criteria**, which the plan states twice:

> **Completion criteria** — Every §24 gate green; every §26 invariant `ENFORCED` in nominal
> operation with a zero-violation SLI; safety case assembled from queries rather than prose; legacy
> decision path removed from the build, not merely bypassed; rollback rehearsed.
> — [IMPLEMENTATION_EXECUTION_PLAN.md:733](IMPLEMENTATION_EXECUTION_PLAN.md#L733)

> **Gate:** every §24 gate green; every §26 invariant `ENFORCED`; legacy path removed from the
> build, not merely bypassed. — [IMPLEMENTATION_EXECUTION_PLAN.md:1318](IMPLEMENTATION_EXECUTION_PLAN.md#L1318)

> **Prerequisites:** Phase 15. **Must precede:** nothing. **Parallel with:** sub-phases are strictly
> sequential. — [IMPLEMENTATION_EXECUTION_PLAN.md:773](IMPLEMENTATION_EXECUTION_PLAN.md#L773)

There is no partial-entry provision. Phase 16a's own gate additionally requires "Capacity Pricing
Service live" and Phase 16b requires "Round wall-clock within §20.1 at target batch size"
([execution plan:748-749](IMPLEMENTATION_EXECUTION_PLAN.md#L748-L749)) — note that 16b re-states the
§20.1 requirement, confirming it is a standing condition and not a one-time gate.

| Entry condition | Current state | Evidence required | Blocked by | Resolution |
|---|---|---|---|---|
| **E1.** Every §24 gate GREEN | 16/23 GREEN, 2 RED, 1 partial, 4 NOT_EVALUATED | `gates.blockers(releaseEvidence)` returns `[]` | Blockers A, B, C, D | §15 sequence |
| **E2.** Every §26 invariant `ENFORCED` in nominal operation with a zero-violation SLI | No invariant has been observed in production; all 22 checks exist and pass in test | Invariant-worker SLI over a declared observation window on a live shard | E1 (a shard must be live), which requires A + B + C + D | Track C, after cutover begins |
| **E3.** Safety case assembled from queries | **MET.** `npm run safety:case` PASS, byte-identical regeneration | — | — | Re-run after any predicate/invariant/gate change |
| **E4.** Legacy path removed from build, not bypassed | **MET.** Four services deleted; `gate:legacy` PASS over 285 files | — | — | Hold; re-run each build |
| **E5.** Rollback rehearsed | Runbook written; rehearsal not performed | Dated record, named operators, all six `rollback.md` §5 steps incl. step 4 | Nothing — a staging environment | Blocker D, startable now |

**E2 is the condition most likely to be misread.** It is not "the invariant checker passes its
tests"; it is "`ENFORCED` **in nominal operation**". §26.2's matrix must also hold — no invariant may
report `VIOLATED` where the matrix says `SUSPENDED`. This requires the engine to have decided real
work on a real shard for a declared window. **E2 is strictly downstream of the cutover, and the
cutover is strictly downstream of E1.** Therefore Phase 16 cannot begin at the moment the last gate
goes green; it begins after a live observation window on top of that.

---

## 4. Blocker Dependency Graph

Derived from the gate table, the worker registry, the register's own `awaits` fields, and the
execution plan's §6.1 blocking decisions. It is **not** a single chain.

```text
                    ┌─────────────────────────────────────────────────────────┐
                    │  EXECUTION-PLAN §6.1 BLOCKING DECISIONS (still open)     │
                    │  B1 routing engine · B2 charging scheduler               │
                    │  B3 consensus store · B6 map obstruction source          │
                    │  B8 calibration owner                                    │
                    └───┬──────────────┬───────────────┬──────────────┬────────┘
                        │              │               │              │
        ┌───────────────▼──┐    ┌──────▼───────┐  ┌────▼────────┐ ┌───▼──────────┐
        │ BLOCKER B        │    │ BLOCKER A    │  │ BLOCKER A   │ │ BLOCKER A    │
        │ SOLVER           │    │ Group D      │  │ Group A/B   │ │ Group C      │
        │ (engineering)    │    │ (7 params)   │  │ (27 params) │ │ (3 params)   │
        │                  │    │              │  │             │ │              │
        │ B0 objective.js  │    │ needs B1/B2/ │  │ decisions + │ │ needs the    │
        │   O((m+n)q) fix  │    │ B3 + workers │  │ existing    │ │ engine to    │
        │      ↓           │    │              │  │ measurement │ │ have decided │
        │ B1' SSP constant │    └──────┬───────┘  └──────┬──────┘ └───┬──────────┘
        │      ↓           │           │                 │            │
        │ B2' algorithm    │           └────────┬────────┴────────────┘
        │   (cost scaling) │                    │
        └────────┬─────────┘                    │
                 │                              │
                 │                    ┌─────────▼─────────────┐
                 │                    │ calibration_safety_   │
                 │                    │ derived  →  GREEN     │
                 │                    └─────────┬─────────────┘
                 │                              │
        ┌────────▼─────────┐                    │
        │ scale_targets    │                    │
        │      →  GREEN    │                    │
        └────────┬─────────┘                    │
                 │                              │
                 └──────────────┬───────────────┘
                                │
        ┌───────────────────────▼────────────────────────────────────┐
        │  SHADOW-ELIGIBLE STATE                                     │
        │  (engine can run on live inputs without executing)         │
        │  ALSO REQUIRES: shadow worker composition root  ← N4       │
        └───────┬───────────────────────────────┬────────────────────┘
                │                               │
   ┌────────────▼──────────┐        ┌───────────▼─────────────┐
   │ BLOCKER C.1           │        │ BLOCKER C.2             │
   │ shadow_agreement      │        │ simulator_fidelity      │
   │ ≥ 14 days live inputs │        │ needs realised prod     │
   │                       │        │ distributions + the     │
   │ ALSO CLOSES 3 Group-C │        │ fleet demand generator  │
   │ calibration params ───┼──┐     │ (checklist item 5)      │
   └───────────┬───────────┘  │     └───────────┬─────────────┘
               │              │                 │
               │              └─────────────────┼──► feeds back into BLOCKER A Group C
               │                                │
   ┌───────────▼────────────────────────────────▼─────────────┐
   │ BLOCKER C.3  soak  (release.soak_duration, staging)      │
   └───────────────────────────┬──────────────────────────────┘
                               │
   ┌───────────────────────────▼──────────────────────────────┐
   │ BLOCKER D  rollback_rehearsed                            │
   │ INDEPENDENT — needs only a staging shard.                │
   │ Drawn here only because §5 step 1 says "take a staging    │
   │ shard live through the full cutover", which is easiest    │
   │ once the machinery is exercised. It does NOT require      │
   │ A, B or C. It can start today.                           │
   └───────────────────────────┬──────────────────────────────┘
                               │
                    ┌──────────▼───────────┐
                    │ ALL 23 GATES GREEN   │  ← E1
                    └──────────┬───────────┘
                               │
                    ┌──────────▼───────────┐
                    │ STAGED PRODUCTION    │
                    │ CUTOVER (cutover.md) │
                    └──────────┬───────────┘
                               │
                    ┌──────────▼───────────────────────┐
                    │ §26 INVARIANTS ENFORCED IN        │  ← E2
                    │ NOMINAL OPERATION, ZERO-VIOLATION │
                    │ SLI OVER AN OBSERVATION WINDOW    │
                    └──────────┬───────────────────────┘
                               │
                    ┌──────────▼───────────┐
                    │ INDEPENDENT RE-       │
                    │ VERIFICATION OF       │
                    │ PHASE 15 COMPLETION   │
                    └──────────┬───────────┘
                               │
                    ┌──────────▼───────────┐
                    │  PHASE 16 MAY BEGIN  │
                    └──────────────────────┘
```

### 4.1 Classification of the four blockers

| Blocker | Nature | Concurrent with | Strictly sequential after |
|---|---|---|---|
| **A — Calibration** | Groups A/B: organisational + measurement. Group C: empirical (shadow). Group D: engineering + §6.1 decisions | B, D, and the shadow composition root | Group C only: after shadow is running |
| **B — Solver** | Pure engineering. No production data required to fix; production-representative hardware required to *discharge the gate* | A, C-prep, D | Nothing. Startable immediately |
| **C — Production evidence** | Empirical, wall-clock-bound. Partly gated on engineering (shadow composition root, fleet demand generator) | Each other, once their prerequisites land | `shadow_agreement` after the composition root; `simulator_fidelity` after the demand generator; `soak` after B (a soak of a solver you are about to replace is a soak of the wrong artefact) |
| **D — Rollback rehearsal** | Organisational + staging. Zero dependency on A, B, C | Everything | Nothing. Startable immediately |

### 4.2 The three dependencies that actually determine the schedule

1. **`cutover.shadow_agreement_window` = 14 days, DERIVED** — the longest irreducible wall-clock
   item, and it cannot start until the shadow composition root exists (N4). *Every day the
   composition root slips is a day added to the end of the programme.*
2. **`release.soak_duration` = 72 hours, PROVISIONAL** — must be re-derived (its own `awaits` names
   "the observed time constant of the slowest accumulating resource"), and must run against the
   solver you intend to ship.
3. **The §26 observation window (E2)** — begins only after the staged cutover. Its length is not
   registered; `cutover.observation_window` (3 600 s, PROVISIONAL) governs per-shard staging, not
   the invariant-enforcement evidence window. **This is an unresolved definitional gap: nothing in
   the repository states how long "ENFORCED in nominal operation" must be observed for.**

---

## 5. Calibration Analysis — all 39 parameters

Source of truth: `tools/gates/checkCalibration.js --all`, re-run for this analysis, cross-read
against every entry's full record in `src/engine/config/register/{appendixA,supplementary,legacy}.json`.

**Recomputed totals:** 242 register entries; 52 `DERIVED` / 152 `PROVISIONAL` / 38 `UNCALIBRATED`;
54 Safety-class, of which 15 are `DERIVED` (12 kill switches, `agent.dedup_retention`,
`security.elevated_roles`, `security.second_approver_action_classes`) and **39 are not** — matching
both prior documents exactly.

### 5.1 Why each is Safety-class, and what `DERIVED` requires

The gate is stronger than a status toggle. `checkCalibration.js` blocks on `SAFETY_NOT_DERIVED`
(status ≠ DERIVED) **and** on `SAFETY_DERIVATION_NOT_STATED` (status = DERIVED with no `derivation`
string, or no `section`+`requiredBy` pair). Marking a parameter `DERIVED` without writing down where
the number came from does not close the gate. This is the correct design and must not be weakened.

**Evidence classes used in the table below:**

- **DEC** — an accountable decision (safety, ops, finance, or an external authority). No measurement
  exists that could produce it; a number here is a choice someone must own.
- **MEAS-NOW** — measurable from the fleet, hardware, or infrastructure that exists today, without
  the engine being the decision path.
- **VENDOR** — a specification, certification, or datasheet from a supplier, validated on a bench.
- **MODEL** — a statistical fit that depends on another model being fitted first.
- **SHADOW** — requires observing the engine's own outputs; satisfiable on live inputs without
  executing decisions (§21.6).
- **DEP** — blocked behind an execution-plan §6.1 decision or a `DEFERRED` worker.
- **RETIRE** — the architecture's stated disposition is replacement, not derivation.

### 5.2 The 39, individually

| # | Parameter | Class | Status | Required derivation | Required data / evidence class | Owner | Dependency | Derive now? |
|---|---|---|---|---|---|---|---|---|
| 1 | `agent.autonomous_continuation_limit` | SAFETY | PROVISIONAL | Per-class bound on autonomous continuation without supervision — the property carrying safety while I2 is SUSPENDED (§18.5) | **DEC** — per-class on-agent safety analysis | Safety | — | **YES** |
| 2 | `connectivity.max_deadzone_extension` | SAFETY | PROVISIONAL | Cap on the p95-based lease extension for a known radio dead zone (§18.2 A3) | **MEAS-NOW** — per-zone p95 dead-zone traversal times from existing telemetry | Safety | — | **YES** |
| 3 | `connectivity.max_heartbeat_age` | SAFETY | PROVISIONAL | Oldest heartbeat still counting as live state for commandability (§7.5) | **MEAS-NOW** — heartbeat inter-arrival distribution per radio class | Safety | — | **YES** |
| 4 | `degraded.max_duration` | SAFETY | PROVISIONAL | Time box on any degraded mode (§18.5) | **DEC** — a safety decision per degraded mode | Safety | — | **YES** |
| 5 | `degraded.max_last_known_age` | SAFETY | PROVISIONAL | Oldest last-known agent state a degraded mode may reason from (§18.5) | **DEC + MEAS-NOW** — staleness tolerance, informed by telemetry cadence | Safety | #3 | **YES** |
| 6 | `degraded.max_mission_scope` | SAFETY | PROVISIONAL | Widest mission scope admissible in Restricted Operation (§7.4 step 3b) | **DEC** — operations decision | Safety | — | **YES** |
| 7 | `degraded.reserve_factor` | SAFETY | PROVISIONAL | Multiplier on every energy reserve layer in Restricted Operation (§7.4 step 3c) | **MEAS-NOW / staging** — observed consumption error during a *real* telemetry degradation; inducible in staging chaos | Safety | #14, #38 | **PARTLY** |
| 8 | `energy.charger_availability_margin` | SAFETY | PROVISIONAL | Conservatism margin on the pinned charger availability projection in `E_return` (§14.5) | **DEP** — realised charger contention; requires the Charging Scheduler to publish | Safety | **B2** | **NO** |
| 9 | `energy.charger_projection_max_age` | SAFETY | PROVISIONAL | Age beyond which the projection is refused and `E_return` falls back to depot-only (§14.5) | **DEP** — the Charging Scheduler's published cadence, named explicitly as B2 in the entry | Safety | **B2** | **NO** |
| 10 | `energy.deviation_tolerance` | SAFETY | PROVISIONAL | Permitted realised-vs-predicted consumption deviation before mid-mission intervention (§14.8) | **MODEL** — §14.2 consumption-model residuals per class | Safety | #15, N5 | **NO** (after #15) |
| 11 | `energy.event_budget_per_fleet_year` | SAFETY | PROVISIONAL | The governed quantity from which every `α[tier]` derives (§14.5) | **DEC** — ops/finance/safety sign-off; named as **B8** in the entry | Safety | **B8** | **YES** (decision) |
| 12 | `energy.f_derate` | SAFETY | **UNCALIBRATED** | Conservatism factor on the vendor capacity curve in `E_usable` (§14.3) | **VENDOR** — vendor-curve validation against measured pack behaviour | Safety | — | **YES** |
| 13 | `energy.kappa_bounds` | SAFETY | PROVISIONAL | Clamp on the per-agent efficiency multiplier κ (§14.2) | **MEAS-NOW** — realised κ distribution across a commissioned fleet | Safety | — | **YES** (partial fleet ⇒ cohort prior) |
| 14 | `energy.max_combined_conservatism` | SAFETY | PROVISIONAL | Publish-time cap on the product of all energy derating factors (§14.3) | **DEC** — explicit Safety decision on intended total energy margin | Safety | — | **YES** |
| 15 | `energy.model_residual_cv` | SAFETY | **UNCALIBRATED** (`default: null`) | Residual CV of the §14.2 consumption model — F34 evaluates all three tier conditions on this distribution | **MODEL** — fitted residual variance against realised Wh | Safety | `energy_calibration` worker DEFERRED (N5) | **NO** |
| 16 | `energy.reserve_floor_wh` | SAFETY | **UNCALIBRATED** (`default: null`) | `E_floor` — hardware protection floor, never overridable (§14.5) | **VENDOR** — per-class pack spec + controlled-shutdown energy | Safety | — | **YES** |
| 17 | `energy.uncalibrated_reserve_factor` | SAFETY | PROVISIONAL | Reserve inflation for an agent whose κ is not yet calibrated (§14.3) | **MEAS-NOW** — per-agent κ calibration coverage | Safety | #13 | **YES** (after #13) |
| 18 | `feasibility.systemic_indeterminacy_threshold` | SAFETY | PROVISIONAL | Fraction of candidates INDETERMINATE on one predicate above which the systemic guard trips (§7.4) | **SHADOW** — observed indeterminate rates in normal operation; shadow produces these without executing | Safety | Shadow running | **NO** (shadow) |
| 19 | `health.required_tier` | SAFETY | **UNCALIBRATED** (`default: null`) | Minimum health tier per SLA class for F9 (§7.5, §16.4) | **DEC** — an operations decision per SLA class | Safety + Ops | — | **YES** |
| 20 | `lease.duration` | SAFETY | PROVISIONAL | Commitment lease duration; expiry without evidence triggers custody-aware recovery (§12.2) | **MEAS-NOW** — measured evidence cadence per class | Safety | — | **YES** |
| 21 | `legacy.dtaro.battery_threshold_pct` | SAFETY | **UNCALIBRATED** | Entry states: "A percentage floor cannot express a tail requirement and is **replaced, not re-tuned**"; `retiredInPhase: 15`; `consumers: []` | **RETIRE** — register disposition under §22.3, with an ADR | Safety | — | **YES** (as retirement) |
| 22 | `legacy.dtaro.charging_interrupt_battery_pct` | SAFETY | **UNCALIBRATED** | Same. Replaced by `energy.target_soc_fallback` + the §14.6 charge curve. One remaining consumer: `src/simulation/constants.js` | **RETIRE** — repoint the simulation consumer, then retire | Safety | — | **YES** (as retirement) |
| 23 | `localisation.max_odometry_divergence` | SAFETY | PROVISIONAL | Largest divergence between reported position and independent corroboration before F10 denies (§7.5) | **MEAS-NOW** — per-class odometry drift measurements | Safety | — | **YES** |
| 24 | `localisation.min_confidence` | SAFETY | **UNCALIBRATED** (`default: null`) | Minimum reported localisation confidence per environment (§7.5 F10) | **MEAS-NOW** — per-environment localisation accuracy measurements | Safety | — | **YES** |
| 25 | `map.obstruction_class_max_age` | SAFETY | PROVISIONAL | Staleness budget deciding STRANDED_SAFE from STRANDED_OBSTRUCTING, and therefore whether the §18.6 external chain opens (§4.3) | **DEP** — the region's map hazard-data publication cadence | Safety | **B6** | **NO** |
| 26 | `ops.emergency_services_hazard_threshold` | SAFETY | **UNCALIBRATED** (`default: null`) | Obstruction classes + hazard states at which §18.6 step 4 is *offered* to the on-call operator | **DEC (external)** — safety decision with local emergency services and the site authority | Safety | External org | **YES** (long lead) |
| 27 | `ops.external_escalation_contacts` | SAFETY | **UNCALIBRATED** (`default: null`) | Per-region escalation contact set with a named owner and last-review instant (§18.6) | **DEC (external)** — the responsible infrastructure operator per region | Ops | External org | **YES** (long lead) |
| 28 | `ops.stranded_obstructing_response_target` | SAFETY | PROVISIONAL | Response target for an agent stranded obstructing a public right of way (§4.3, §18.6) | **DEC (external)** — safety decision with local highway or site authority | Safety | External org | **YES** (long lead) |
| 29 | `payload.mass_discrepancy_tolerance_kg` | SAFETY | PROVISIONAL | Band inside which an observed-vs-manifest mass delta is instrument error rather than a discrepancy event (§15.6) | **VENDOR/MEAS-NOW** — on-board scale accuracy per container model | Safety | — | **YES** |
| 30 | `payload.safety_factor` | SAFETY | PROVISIONAL | Fraction of rated mass usable in feasibility (§15) | **VENDOR** — per-class rated-mass certification | Safety | — | **YES** |
| 31 | `route.degraded_max_radius` | SAFETY | **UNCALIBRATED** (`default: null`) | Maximum candidate radius while routing is degraded (§18.3) | **DEP** — per-region straight-line-vs-network error; requires a routing engine to compare against | Safety | **B1** | **NO** |
| 32 | `route.degraded_reserve_factor` | SAFETY | PROVISIONAL | Reserve inflation while routing is degraded (§18.3) | **DEP** — degraded-estimate error distribution | Safety | **B1**, #14 | **NO** |
| 33 | `security.attestation_max_age` | SAFETY | PROVISIONAL | Oldest firmware/hardware attestation that may still derive a capability (§23.2) | **MEAS-NOW** — measured firmware/hardware change cadence per agent class, from ops records | Security | — | **YES** |
| 34 | `security.certificate_revocation_recheck_interval` | SAFETY | PROVISIONAL | Window in which a revoked device keeps acting (§23.2) | **MEAS-NOW** — the operated CA's revocation-publication latency | Security | Operated CA exists | **YES** |
| 35 | `security.energy_rate_tolerance` | SAFETY | PROVISIONAL | How far a reported energy drop may exceed §14.2's prediction before refusal (§23.5) | **MODEL** — residual distribution of §14.2's model vs reported SoC | Security | #15 | **NO** (after #15) |
| 36 | `security.implausible_report_quarantine_threshold` | SAFETY | PROVISIONAL | How many refused reports constitute persistent implausibility (§23.5) | **SHADOW** — background rate of refused reports on healthy agents; `trustBoundaries` can run on live telemetry today | Security | Trust-boundary observation | **PARTLY** |
| 37 | `security.position_plausibility_tolerance` | SAFETY | PROVISIONAL | Multiplier on max speed before a position report is kinematically impossible (§23.5) | **MEAS-NOW** — distribution of implied speed between accepted fixes, per class | Security | — | **YES** |
| 38 | `shard.store_round_trip_budget` | SAFETY | PROVISIONAL | Store round-trip allowance in §19.5's stop-committing margin | **DEP** — measured p99 RTT to the *operated* consensus store | SRE | **B3** | **NO** |
| 39 | `sim.max_optimistic_bias` | SAFETY | PROVISIONAL | Largest optimistic bias the simulator may exhibit before it may discharge an obligation (§24.4) | **DEC** — see below: the registered `awaits` is circular and must be corrected | Safety | **Circular as written (N7)** | **YES**, once re-scoped as a decision |

### 5.3 The eight advisory (non-blocking) findings

`checkCalibration.js` also reports 8 `DERIVATION_NOT_STATED` advisories — entries that are `DERIVED`
but do not state their derivation: `capacity`, `commit.max_serial_utilisation`,
`dispatch.max_delivery_delay`, `legacy.liveness.db_flush_interval_ms`,
`legacy.liveness.offline_cutoff_ms`, `shard.lease_duration`, `solve.max_generation_gap_regression`,
`supervise.max_timer_lag`. **None is Safety-class, so none blocks.** They should be closed in the
same pass as the 39, because a `DERIVED` status with no stated source is exactly the failure mode the
`SAFETY_DERIVATION_NOT_STATED` check exists to catch — it is only luck of change-class that these are
advisory.

### 5.4 The two structural problems in the calibration blocker

**(a) `sim.max_optimistic_bias` is circular.** Its `awaits` reads "the first one-sided simulator
fidelity study against production", and the `simulator_fidelity` gate is "no safety-relevant model
exceeds `sim.max_optimistic_bias`". The threshold cannot be an output of the study it bounds. §24.4
is unambiguous about what the parameter *is*: "The gate is one-sided, because the risk is… Bias
beyond `sim.max_optimistic_bias` on any safety-relevant model… **fails the simulator's own release
gate**." It is a **tolerance decision** — how much optimism Safety will accept before refusing to let
the simulator discharge a Tier 0 obligation — not a measurement.

*Recommended resolution:* the calibration owner and Safety re-derive it as a decision, with the
derivation stating the reasoning (e.g. from the energy reserve headroom the §14.5 tiers already
consume). The register's `awaits` field should be corrected in the same change. This is a
§22.3 Safety-class change requiring two-person approval, and it must go through that route — **not**
edited quietly to make a gate pass.

**(b) Two entries need retirement, not derivation (N8).** Deriving a battery *percentage* floor for
`legacy.dtaro.battery_threshold_pct` would be actively wrong: the register entry itself says "A
percentage floor cannot express a tail requirement and is **replaced, not re-tuned**", and its
`consumers` list is empty. The correct closure is a register change retiring the entry (or moving it
out of Safety class now that nothing safety-relevant reads it), recorded as an ADR under the plan's
§8 maintenance rules. For `charging_interrupt_battery_pct`, the one remaining consumer is
`src/simulation/constants.js` — the simulator, not the decision path — which must be repointed first.

**This is the single place in the whole analysis where the honest answer looks like "make the gate
green".** It is not. The distinction is that the architecture already states the disposition; what is
missing is the paperwork that records it, and the paperwork is a Safety-class change with an
approval trail. Fabricating a percentage would be the failure §22.4 predicts; retiring a parameter
the architecture already replaced is the opposite of that.

---

## 6. Calibration Evidence Strategy

### Group A — derivable immediately from existing evidence or an accountable decision (13)

`agent.autonomous_continuation_limit`, `degraded.max_duration`, `degraded.max_mission_scope`,
`energy.event_budget_per_fleet_year`, `energy.max_combined_conservatism`, `health.required_tier`,
`ops.emergency_services_hazard_threshold`, `ops.external_escalation_contacts`,
`ops.stranded_obstructing_response_target`, `payload.safety_factor`, `energy.reserve_floor_wh`,
`energy.f_derate`, `sim.max_optimistic_bias`.

| Aspect | Content |
|---|---|
| **Evidence needed** | A written derivation naming its source: a safety analysis, a signed budget, a vendor certification or datasheet, or a named external authority's agreement |
| **Collection method** | Safety analysis workshops per agent class; an ops/finance/safety sign-off session for the fleet-year event budget (B8); supplier document review + bench validation for pack/mass values; contact and agreement with each region's infrastructure operator and site authority |
| **Minimum requirements** | The architecture states none numerically for these. §22.4 requires only that the value be "from a stated accounting or measured source"; `checkCalibration.js` enforces that the `derivation` (or `section` + `requiredBy`) field is non-empty |
| **Where recorded** | The register entry's `derivation` field, in the appropriate `register/*.json` file. `ops.external_escalation_contacts` additionally requires a named owner and a last-reviewed instant per §18.6 |
| **Owner** | Register `owner` field: Safety (10), Safety+Ops (1), Ops (1). B8's named calibration owner is accountable for the register as a whole |
| **Gate recognition** | `checkCalibration.js`: `calibrationStatus: "DERIVED"` **and** a non-empty `derivation` |
| **Anti-fabrication / anti-staleness** | Every one of these is a Safety-class change requiring two-person approval (§22.3) and appearing in the hash-chained audit stream (§21.7). §22.4's quarterly review re-examines each. **Additional recommendation:** the derivation string should name the document, meeting, or certificate, not merely restate the reasoning — a derivation that cites nothing is unfalsifiable |

**Longest lead time in this group is items 26–28** (external authorities). Start those first; they
are the only Group A items with a dependency on an organisation outside the programme.

### Group B — require controlled measurement of existing fleet, hardware, or infrastructure (12)

`connectivity.max_deadzone_extension`, `connectivity.max_heartbeat_age`,
`degraded.max_last_known_age`, `energy.kappa_bounds`, `energy.uncalibrated_reserve_factor`,
`lease.duration`, `localisation.max_odometry_divergence`, `localisation.min_confidence`,
`payload.mass_discrepancy_tolerance_kg`, `security.attestation_max_age`,
`security.certificate_revocation_recheck_interval`, `security.position_plausibility_tolerance`.

| Aspect | Content |
|---|---|
| **Evidence needed** | A distribution, not a point estimate. Each entry's `awaits` names the statistic explicitly: "p95 dead-zone traversal times", "heartbeat inter-arrival distribution per radio class", "the realised κ distribution", "the measured distribution of implied speed between accepted fixes, per agent class" |
| **Collection method** | Existing telemetry (`telemetry.handler.js` path), existing session/CA records, bench measurement for odometry drift and scale accuracy, controlled field trials per environment for localisation confidence. **None requires the engine to be the decision path** |
| **Minimum sample requirements** | **The architecture specifies none for these**, and this plan invents none. What it does require is scope: §22.4's slicing discipline and §24.4's "per zone, agent class, and time bucket" mean the derivation must be per the entry's declared `specScope` (`agent_class`, `zone`, `region`, `sla_class`) — a fleet-wide mean for a per-class parameter is not a derivation of it. Where a slice has too little data, §22.4's bootstrap sequence applies: use the class-level or cohort prior with §16.3's shrinkage, and say so in the derivation |
| **Where recorded** | Register `derivation` field, citing the dataset, the window it covers, and the slice |
| **Owner** | Safety (8), Security (3), Safety+Ops (1), under the B8 calibration owner |
| **Gate recognition** | Same as Group A |
| **Anti-fabrication / anti-staleness** | The derivation must name the data window. §22.4's quarterly review plus §21.5's calibration SLIs detect drift. **Additional recommendation:** where the value is produced by a worker (`energy_calibration`, `service_time_model`), the derivation should name the worker and the run, so a re-derivation is reproducible rather than re-argued |

### Group C — require observing the engine's own behaviour (3)

`feasibility.systemic_indeterminacy_threshold`, `security.implausible_report_quarantine_threshold`,
`degraded.reserve_factor`.

| Aspect | Content |
|---|---|
| **Evidence needed** | Rates and error distributions produced *by the engine's own predicates* under realistic input — indeterminate rates per predicate; refused-report rates on known-healthy agents; consumption error during an actual telemetry degradation |
| **Collection method** | **Shadow mode (§21.6), not production.** This is the important finding of this section: shadow "runs on live inputs in parallel with production, producing decisions that are recorded and never executed". Feasibility evaluation, and therefore the INDETERMINATE rate, happens in shadow exactly as it would live. `degraded.reserve_factor` additionally admits a staging path — the chaos suite already injects telemetry degradation (`failure/agentFailures.js`, `degraded/modeRegister.js`) |
| **Prerequisite** | The shadow worker's composition root (N4). This is why that item is on the critical path for calibration as well as for `shadow_agreement` |
| **Where recorded** | Register `derivation` naming the shadow run and its window |
| **Owner** | Safety (2), Security (1) |
| **Gate recognition** | Same as Group A |
| **Anti-fabrication / anti-staleness** | These three should be derived from the **same** shadow run that discharges `shadow_agreement`, and the derivation should cite it — one artefact, two uses. A derivation citing a shadow run shorter than `cutover.shadow_agreement_window` should be treated as provisional evidence, not a derivation |

### Group D — require engineering or an execution-plan §6.1 decision before calibration is possible (11)

`energy.charger_availability_margin` (B2), `energy.charger_projection_max_age` (B2),
`energy.deviation_tolerance` (model), `energy.model_residual_cv` (model + deferred worker),
`security.energy_rate_tolerance` (model), `map.obstruction_class_max_age` (B6),
`route.degraded_max_radius` (B1), `route.degraded_reserve_factor` (B1),
`shard.store_round_trip_budget` (B3), plus the two `legacy.dtaro.*` entries (retirement).

| Aspect | Content |
|---|---|
| **Evidence needed** | First the prerequisite, then the measurement. B2: the Charging Scheduler must exist and publish a cadence. B3: a consensus store must be selected and operated before its p99 RTT means anything. B1: a routing engine must exist before straight-line-vs-network error can be measured. The three energy/security model parameters need the §14.2 consumption model *fitted*, which needs the `energy_calibration` worker to have a scheduler and realised-outcome rows |
| **Collection method** | Resolve B1/B2/B3/B6 as procurement and deployment decisions; land the `energy_calibration` worker's scheduler; then apply Group B method |
| **Minimum requirements** | As Group B, once unblocked |
| **Where recorded** | Register `derivation`; the §6.1 decisions additionally warrant ADRs |
| **Owner** | Safety (6), Security (1), SRE (1), Eng for the blocking decisions |
| **Gate recognition** | Same as Group A |
| **Anti-fabrication** | **The largest fabrication risk in the whole register sits here**, because these are the values where the prerequisite is expensive and the temptation to write a plausible number is highest. `energy.model_residual_cv` is the sharpest case: its own description says "Seeded null, not with a plausible number: §14.5 evaluates all three tier conditions on this distribution, so a fabricated dispersion would produce three fabricated probabilities and F34 would admit or reject on them." Any `DERIVED` status on this entry that does not cite a fitted model with its residuals is the failure mode §22.4 names |

### 6.1 Summary of the calibration strategy

| Group | Count | Startable today? | Gating item |
|---|---|---|---|
| A — decisions and existing documents | 13 | **Yes, all** | Named calibration owner (B8) — the only true prerequisite |
| B — measurement of what exists | 12 | **Yes, all** | Data-access and instrumentation setup |
| C — engine behaviour under live inputs | 3 | No | Shadow composition root |
| D — blocked on a prerequisite | 11 | No | B1 / B2 / B3 / B6 / deferred workers / retirement paperwork |
| **Total** | **39** | **25 of 39 startable now** | |

**The headline is that 25 of the 39 can begin the day a calibration owner is named**, and B8 —
naming that owner — is a decision, not a project.

---

## 7. Solver Root-Cause Analysis

### 7.1 The current algorithm, precisely

`src/engine/solve/minCostFlow.js` solves the singleton regime as a min-cost flow on the network
`S → Leg → Agent → T`, every arc capacity 1, using **successive shortest paths with Johnson
potentials** ([minCostFlow.js:52-58](Backend/src/engine/solve/minCostFlow.js#L52-L58)):

- Initial potentials from one relaxation pass in topological order — exact, and correct even with
  negative γ from `C_opportunity` ([minCostFlow.js:278-302](Backend/src/engine/solve/minCostFlow.js#L278-L302)).
- Each augmentation is a full Dijkstra over the residual network on non-negative reduced costs
  ([minCostFlow.js:403-435](Backend/src/engine/solve/minCostFlow.js#L403-L435)).
- Each augmentation pushes exactly one unit, so there are exactly `|L|` = m augmentations
  ([minCostFlow.js:469-471](Backend/src/engine/solve/minCostFlow.js#L469-L471)).
- Costs are lexicographic `(unassigned, milliCU)` BigInt pairs — an ordered abelian group, chosen
  deliberately to express §22.5 rule 1's "immediate assignment when any feasible candidate exists"
  as a *priority* rather than as a big-M constant
  ([minCostFlow.js:33-50](Backend/src/engine/solve/minCostFlow.js#L33-L50)).

### 7.2 Asymptotic complexity

Let m = Legs, k = candidates per Leg, n = agents, q = m·k columns.
Nodes V = m + n + 2; arcs E = m (supply) + q (pairing) + m (defer/remain-queued) + n (exclusivity)
≈ q for realistic k.

- One Dijkstra with a binary heap: **O(E log V)** = O(q log(m+n)).
- m augmentations: **O(m · q · log(m+n)) = O(m² · k · log(m+n))**.
- Plus an unavoidable O(V) potential-update sweep per augmentation
  ([minCostFlow.js:464-467](Backend/src/engine/solve/minCostFlow.js#L464-L467)) = O(m·(m+n)) — also
  quadratic, smaller constant.

**The solver's own header states this and contrasts it with §20.2's table.** The finding is not a
discovery; it is a disclosed design consequence.

### 7.3 Why it exhibits the observed scaling — reproduced and extended

Measured on this machine, same code path the scale suite uses:

| Shape | Solve (median) | Augmentations | Arcs | Arc-visits | ns/visit |
|---|---|---|---|---|---|
| 100 × 10 | 57 ms | 100 | 1 309 | 2.6 × 10⁵ | 219 |
| 250 × 10 | 382 ms | 250 | 3 259 | 1.6 × 10⁶ | 234 |
| 500 × 10 | **1 673 ms** | 500 | 6 509 | 6.5 × 10⁶ | 257 |
| 100 × 40 | 131 ms | 100 | 4 339 | 8.7 × 10⁵ | 151 |
| 100 × 100 | 298 ms | 100 | 10 399 | 2.1 × 10⁶ | 143 |
| 100 × 200 | 698 ms | 100 | 20 499 | 4.1 × 10⁶ | 170 |
| **500 × 200** | **24 356 ms** | 500 | 101 699 | 1.0 × 10⁸ | 239 |

Exponent in m (at k = 10): log(1673/57)/log(5) = **2.10** — quadratic, as predicted.
Exponent in k (at m = 100, k = 10→200): log(698/58)/log(20) = **0.83** — sub-linear at small k
because node count dominates the Dijkstra, approaching linear as arcs dominate. The suite's quoted
"≈ 0.65" is measured at m = 40, k ∈ [5, 40], where the node-count term is largest; **at §20.1's
candidate count the candidate exponent is closer to 1, which makes the extrapolation from 500 × 10
to 500 × 200 worse than a reader of the report would assume.**

**Two things dominate the measured cost, and they are separable:**

1. **Algorithmic:** m augmentations × O(q) arc visits = 1.0 × 10⁸ visits at 500 × 200. Irreducible
   for SSP.
2. **Constant factor:** ≈ 240 ns per arc visit. A typed-array Dijkstra over machine integers costs
   20–40 ns per visit. The gap is explained by: a fresh 2-element `BigInt` array allocated on every
   `addCost`/`subtractCost` ([minCostFlow.js:117-128](Backend/src/engine/solve/minCostFlow.js#L117-L128)),
   BigInt arithmetic throughout, three fresh `Array(nodeCount)` allocations per augmentation
   ([minCostFlow.js:403-405](Backend/src/engine/solve/minCostFlow.js#L403-L405)), and a Dijkstra that
   drains the whole heap rather than stopping when the sink settles. **Roughly a 6–10× constant-factor
   headroom exists without changing the algorithm.**

### 7.4 The unreported second hot spot

`objective.buildInstance` constructs the coverage and exclusivity rows with a full `columnVars.filter`
sweep **per Leg and per agent** ([objective.js:193-218](Backend/src/engine/solve/objective.js#L193-L218)):

```
coverage    = legIds.map(legId   => columnVars.filter(e => e.legIds.includes(legId)) …)   // O(m · q)
exclusivity = agentIds.map(agent => columnVars.filter(e => e.agentId === agent) …)        // O(n · q)
```

That is **O((m + n) · q) = O(m² · k)** — the same complexity class as the solver, in the code that
prepares its input. Measured at m = 500:

| Columns | `buildInstance` | µs/column |
|---|---|---|
| 5 000 (k=10) | 110 ms | 22 |
| 10 000 (k=20) | 260 ms | 26 |
| 25 000 (k=50) | 914 ms | 37 |
| 50 000 (k=100) | 2 755 ms | 55 |
| **100 000 (k=200)** | **13 421 ms** | **134** |

**13.4 s is 54× the entire 250 ms round budget, before a single augmentation runs.** A single-pass
`Map` group-by makes this O(q) and changes no output whatsoever — the rows produced are identical,
in identical order. There is no correctness, determinism, or architectural question here; it is a
missed group-by.

### 7.5 What §20.1 requires, and what §20.2's "typical" means

§20.1 states one row for the round:

> | Round wall-clock (500 Legs × 200 candidates) | < 250 ms | Keeps the batch window meaningful |

and prefixes the table: "They are **requirements for the release gate, not aspirations**"
([NEXT_GENERATION_ASSIGNMENT_ENGINE.md:4328-4329](NEXT_GENERATION_ASSIGNMENT_ENGINE.md#L4328-L4329)).
Registered as `perf.round_wall_clock_p99` = 250 ms, **STRUCTURAL, DERIVED** — so the target itself is
not a parameter that can be re-tuned into compliance.

Three properties of the target that matter for remediation:

- **It is the whole round, not the solve.** §20.2's stage table budgets candidate generation,
  feasibility, plan pricing, two routing populations, the solve, and the commit. A solver that hits
  250 ms exactly still misses, because everything else must fit inside the same 250 ms. The scale
  suite measures **only** `minCostFlow.solve`, in-process, with no routing at all.
- **It is stated at p99, per shard, under nominal operation.** A single-process median on a build
  machine is not that measurement — the harness says so on every row it emits
  ([scaleHarness.js `measureAgainstTarget`](Backend/tests/scale/helpers/scaleHarness.js)).
- **§20.2's row is not an aspiration either, and it names the algorithm:**
  > Solve — singleton regime | **O(m · k · log) typical for min-cost flow with cost scaling**;
  > worst case polynomial

  "Typical" qualifies the *bound*, not the *algorithm*. The specification names cost scaling as the
  intended technique. **The shipped SSP is therefore a deviation from the specification's stated
  solve technique, not a permissible alternative that merely happens to be slower.** This matters
  enormously for §10's ownership question.

### 7.6 Answers to the ten root-cause questions

| # | Question | Answer |
|---|---|---|
| 1 | Current algorithm | Successive shortest paths with Johnson potentials, one augmentation per Leg, binary-heap Dijkstra, BigInt lexicographic costs |
| 2 | Actual asymptotic complexity | O(m² · k · log(m+n)) for the solve; **plus** O((m+n)·q) = O(m²·k) in `objective.buildInstance` |
| 3 | Why that scaling | m augmentations, each a full-network Dijkstra; measured exponent 2.10 in m. Sub-linear in k only at small k |
| 4 | What §20.1 requires | Whole-round p99 < 250 ms at 500 Legs × 200 candidates, per shard, nominal — a release-gate requirement |
| 5 | What §20.2 "typical" means | The expected-case bound of **cost-scaling** min-cost flow. The specification names the technique; SSP is not it |
| 6 | Can optimisation alone meet the target? | **Almost certainly not, but nobody has measured it.** Best case from constant-factor work: 24.4 s → ~2.5–4 s. Adding the `buildInstance` fix removes 13.4 s. Still ~10× short. Optimisation alone closes the gap only if production instances are far smaller or the feasibility graph partitions well (N10) — both unmeasured |
| 7 | Is the problem implementation, algorithm, benchmark, data shape, or architecture? | **All but architecture, in this order:** (a) implementation — `buildInstance`'s missed group-by, 13.4 s, trivially fixable; (b) implementation — BigInt/allocation constant factor, 6–10×; (c) algorithm — the m² term, irreducible for SSP; (d) benchmark — the shipped measurement is at 1/20 of the target's candidate count; (e) data shape — the partition structure at production candidate density is unmeasured. **Not architecture:** §20.2 already specifies cost scaling, so implementing it is conformance |
| 8 | Is the target measured correctly? | **No, in two ways.** The suite measures the solve only (not the round), and at 500 × 10 rather than 500 × 200. Both are disclosed in the test file; neither is corrected in the reports. The true gap is ≈ 97× on the solve alone, ≈ 151× including instance construction — not "roughly an order of magnitude" |
| 9 | Is the 500 × 10 benchmark representative? | **No, and it is unrepresentative in the safe direction** — it understates the gap by ~15×. It is a strictly easier shape, which the test header says plainly. It should be replaced by a measurement at the real shape now that one is known to be feasible (≈ 40 s single trial) |
| 10 | Is a fundamentally different algorithm required? | **Probably yes, and the specification already names it.** But that conclusion should be *confirmed by measurement after (a) and (b)*, not assumed. See §9 |

---

## 8. Solver Alternatives Comparison

All options are assessed against the invariants any replacement must preserve:
**determinism (§9.6 requirement 2)**, **admissibility of the lower bound (§6.4)**, **exact
constraints and capacity correctness (§9.3 — `≤ 1` per agent, never per capacity slot)**, **integrality
and zero LP–IP gap in the singleton regime**, **exact marginal duals (§9.3)**, **fencing and
commitment semantics (unaffected — the solver returns an allocation, `commitment/commit.js` owns
durability)**, **safety invariants**, **objective semantics including §22.5 rule 1's lexicographic
priority**, and **replay reproducibility (§24.3)**.

| # | Approach | Complexity | Expected benefit at 500 × 200 | Correctness risk | Architecture impact | Impl. effort | Verification effort | Recommended? |
|---|---|---|---|---|---|---|---|---|
| **O0** | **Fix `objective.buildInstance`'s group-by** (O((m+n)·q) → O(q)) | O(q) | Removes **13.4 s** of the 37.8 s total. Round-preparation cost becomes ~0.3 s | **None.** Identical rows in identical order; a pure refactor | None | **Very low** (hours) | Existing determinism + round tests cover it; add a scaling assertion | **YES — do first** |
| **O1** | **Optimise the shipped SSP in place**: typed arrays for potentials/distance/settled, hoist per-augmentation allocation, single scaled integer instead of a BigInt pair in the inner loop, terminate Dijkstra when the sink settles | Unchanged O(m²·k·log) | 240 ns → ~30 ns/visit ⇒ **24.4 s → ~3 s**. Sink-early-exit may give a further ~1.5–2× | **Low-moderate.** The BigInt→machine-integer step is the risk: milliCU must be proven to stay inside a safe range, or the scaled form must be exact by construction. The lexicographic pair must survive the encoding | None. Same algorithm, same outputs | **Medium** (1–2 weeks) | Determinism/replay corpus must reproduce byte-for-byte; add a property test over cost magnitudes | **YES — do second** |
| **O2** | **Cost-scaling min-cost flow** (Goldberg–Tarjan push-relabel; Goldberg–Kennedy for the assignment specialisation) | O(√V · E · log(V·C)) for the assignment case ⇒ ~√m instead of m phases | ~22× fewer phases at m = 500. With O0+O1's constants: **well inside 250 ms for the solve** | **Moderate.** ε-optimality terminates exact for integer costs at ε < 1/(V+1) — must be proven, not assumed. Duals are exact only at termination. **The lexicographic `(unassigned, milliCU)` cost does not scale componentwise**: it must either be handled by a two-phase max-cardinality-then-min-cost decomposition, or encoded as a single integer with a bound computed *from the instance* (Σ\|γ\|+1). The latter is a big-M in effect, which the module header rejects on §1.3 grounds — though an instance-derived bound is materially different from a configured constant, that argument must be made explicitly and reviewed | **None to the specification** — §20.2 names cost scaling. Internally significant: a new solver module, new tests | **High** (4–8 weeks incl. verification) | Determinism, replay corpus, dual exactness, LP–IP gap = 0, regime guarantee test, and a differential test against the SSP solver over a large random corpus | **YES — but only if O0+O1 measurement proves it necessary** |
| **O3** | **Network simplex** | Exponential worst case; near-linear in practice with a strongly-feasible basis | Typically very fast on assignment-shaped networks; duals are node potentials, exactly what §9.3 needs | **Moderate.** Determinism requires a fixed pivot rule with canonical index tie-breaking — achievable but must be proven. Degeneracy handling is the classic source of non-determinism | None to the specification, but §20.2 names cost scaling, so this is a *deviation* requiring the plan's §8 change process | High | Same as O2, plus a stronger determinism argument | **NO** — equivalent effort to O2 with a weaker specification mandate and a harder determinism story |
| **O4** | **Auction / Jonker–Volgenant with ε-scaling** (assignment-specific) | O(V·E·log(V·C)) with ε-scaling; excellent constants for sparse assignment | Comparable to O2 | **Moderate.** Same ε-exactness argument as O2; same lexicographic-cost problem; ties must break canonically | As O2 (a specialisation of cost scaling for the assignment case, so arguably *is* §20.2's technique) | High | As O2 | **CONSIDER** as the concrete form of O2 — the network *is* an assignment problem, and the assignment specialisation is both simpler and faster than general cost-scaling MCF |
| **O5** | **Candidate reduction** — tighten §6.4 lower-bound pruning so fewer than 200 candidates reach the solve | Reduces k, not the exponent | Linear-ish in the reduction. Halving effective k roughly halves solve time | **None to the solver.** But **it changes which allocations are reachable**, so the admissibility argument (§6.4: "Because the bound is admissible, this preserves the optimality guarantee — it is pruning, not sampling") must hold exactly. Over-pruning silently degrades allocation quality with **no in-round signal** (§21.6) | Touches Phase 9's candidate generation | Medium | Counterfactual-evaluator run over a historical corpus is **mandatory** (§21.6 makes it a release gate for generation changes) | **NO as a primary remedy** — it trades a measurable latency problem for an unmeasurable quality problem. Legitimate only as a tuning of `candidate.max_evaluated` after the solver meets its target |
| **O6** | **Decomposition** — rely on `round.partition()`'s connected components of the Leg–agent feasibility graph | Divides m per component; quadratic term shrinks as the square of the reduction | **Unknown and unmeasured (N10).** At 200 candidates per Leg drawn from a shard's agent pool, the graph is plausibly one giant component, in which case the relief is zero | **None** — already implemented and correct: columns spanning a boundary are kept whole by merging, never severed ([round.js:150-190](Backend/src/engine/solve/round.js#L150-L190)) | None — already shipped | **None** (measurement only) | A scale test measuring component-size distribution at production-shaped candidate density | **MEASURE IT** — this is free information that could materially change the required target for O1/O2 |
| **O7** | **Bounded incremental / warm-started solving** across rounds — reuse potentials and the previous allocation | Amortised; no worst-case improvement | Potentially large in steady state, where round-to-round change is small | **High.** Warm-starting is a direct threat to §9.6's determinism: the solution becomes a function of history, not of the pinned inputs. Replay would have to reconstruct the warm-start state exactly, which the input snapshot does not currently carry | **Significant** — would require §9.6 and the input-snapshot contract to change. That is an architecture change under the plan's §8 rules | High | Very high — the entire determinism and replay story is re-opened | **NO** — the determinism cost is disproportionate. Revisit only if O0–O2 fail |
| **O8** | **Hybrid: O0 + O1 + O6-measurement, then O2/O4 if still short** | — | See §9 | Lowest achievable at each step | Minimal until the last step | Staged | Staged | **YES — this is the recommendation** |

---

## 9. Solver Recommendation

**Recommended path: O8 — a three-step, measure-between-steps sequence, with the algorithm
replacement scoped only on evidence.**

### Step S1 — `objective.buildInstance` group-by (days)

Replace the two per-row `filter` sweeps at
[objective.js:193-218](Backend/src/engine/solve/objective.js#L193-L218) with a single-pass `Map`
group-by. Output is byte-identical. Removes ~13.4 s of the ~37.8 s at 500 × 200.

*Why first:* highest benefit per unit of risk in the entire remediation programme; it is
correctness-neutral; and it is **not wasted** if the solver is later replaced, because every solver
consumes the same instance.

### Step S2 — re-measure at §20.1's real shape and publish the corrected figure (days)

Change the scale suite's §20.1 measurement to the actual 500 × 200 shape (feasible: ~40 s for a
single trial, ~11 s of which S1 removes), keep the `attained === false` finding assertion and its
proven polarity, and record the corrected number. Simultaneously add the O6 measurement: the
component-size distribution `round.partition()` actually produces at production candidate density.

*Why second:* every downstream scoping decision depends on the true gap, and the currently published
figure understates it by ~15×. This step is what converts "we think we need a new solver" into a
statement with a number behind it.

### Step S3 — SSP constant-factor optimisation (1–2 weeks), then decide

Typed arrays, hoisted allocation, sink-early-exit, and — if and only if exactness can be proven —
a machine-integer inner loop. Re-measure.

**Decision rule, stated in advance so it cannot be retrofitted:**

> If, after S1–S3 and with the O6 partition evidence in hand, the *whole-round* p99 at 500 × 200 on
> representative hardware is within 250 ms, `scale_targets` may be discharged and no algorithm
> replacement is undertaken. If it is not, implement **O4 (auction / Jonker–Volgenant with
> ε-scaling)** as the concrete realisation of §20.2's named cost-scaling technique.

Expected outcome, stated honestly: **S1–S3 will very likely not be sufficient.** The arithmetic —
24.4 s → ~3 s optimistic, against a 250 ms *whole-round* budget that must also accommodate two
routing populations, feasibility, and pricing — leaves roughly an order of magnitude. But the
programme should reach that conclusion with a measurement rather than an estimate, because S1–S3 cost
two to three weeks, are prerequisites for O4 anyway (O4 needs the same instance builder and the same
harness), and the alternative is committing 4–8 weeks of solver engineering on an extrapolation from
a benchmark that is known to be at the wrong shape.

### Constraints any replacement must satisfy (checklist for the eventual design review)

1. **Determinism.** Canonical node/arc order; every tie broken by node index, never by heap insertion
   order ([minCostFlow.js:313-317](Backend/src/engine/solve/minCostFlow.js#L313-L317)). No wall-clock,
   no randomness (T6).
2. **Exactness and integrality.** LP–IP gap computed and equal to zero, reported as a computed
   equality rather than asserted ([minCostFlow.js:526-531](Backend/src/engine/solve/minCostFlow.js#L526-L531)).
   For any ε-scaling method, termination at ε < 1/(V+1) with integer costs must be *proven* in the
   module, not assumed.
3. **Capacity correctness.** `≤ 1` per agent on the exclusivity arc, never `≤ capacity[a]` — §9.3
   rejects the latter outright.
4. **Exact marginal duals.** Published through `regime.dualsFor()`, never bare; only the milliCU
   component is a price, never the lexicographic ordering component.
5. **§22.5 rule 1's lexicographic priority** must survive whatever cost encoding is chosen, and any
   big-M-equivalent must be derived from the instance and argued explicitly against §1.3.
6. **Anytime behaviour (§9.4).** Stopping must remain safe — currently only between augmentations,
   where the flow is integral. Any replacement must define its own safe stopping points, and (given
   N3) should aim for a granularity meaningfully finer than "1 % of the batch".
7. **Replay reproducibility (§24.3).** The golden corpus must reproduce byte-for-byte before and
   after.
8. **A differential test against the current solver** over a large randomised corpus, asserting
   identical allocations and identical objective values. This is the strongest available evidence
   that a replacement preserves the semantics, and it should be a release gate on the change.

### What must *not* be done

- **Do not widen the scale test's exponent bounds** (currently 1.5–2.6 for m, 0.3–1.3 for k, r² > 0.9)
  to accommodate a partially-improved solver. Those bounds exist to catch an algorithm change; if the
  algorithm changes, the bounds should change *to match the new algorithm's predicted exponent*, with
  the prediction stated.
- **Do not re-tune `perf.round_wall_clock_p99`.** It is STRUCTURAL and DERIVED from §20.1, which is
  frozen.
- **Do not raise `solve.time_budget`** to let the current solver finish. That trades a latency miss
  for a batch-window miss and hides N3 rather than fixing it.
- **Do not reduce `candidate.max_evaluated` or `solve.max_legs_per_round`** to make the benchmark
  shape smaller. §20.1's target names 500 × 200 explicitly and §9.4 caps the round at exactly those
  numbers; shrinking the caps to pass the gate is reinterpreting RED as PASS.

---

## 10. Phase Ownership Decision

**Conclusion: the solver work is option C — it is re-opened Phase 10 work, executed as a Phase 15
blocker-resolution workstream. It is neither a Phase 15 fix nor a new phase.**

### The evidence

**It is not Phase 15's.** Phase 15's purpose is explicit: "Prove the Tier 0 + Tier 1 engine against
§24's gates and cut over from the legacy path. **No new capability ships in this phase.**"
([execution plan:714-715](IMPLEMENTATION_EXECUTION_PLAN.md#L714-L715)). Phase 15's "Files to
create/modify" list contains no `solve/` module. The Phase 15 report's own reasoning is correct on
this point ([report §14 item 2](PHASE_15_IMPLEMENTATION_REPORT.md): "Replacing the solver is new
capability and Phase 15 ships none"). Phase 15 discharged its actual obligation, which was to
*measure* §20.1 and record the gap.

**It is Phase 10's.** Phase 10 — "Round loop and solve" — lists `src/engine/solve/minCostFlow.js`
and `objective.js` in its "Files to create"
([execution plan:581](IMPLEMENTATION_EXECUTION_PLAN.md#L581)) and owns "singleton-regime min-cost
flow, solve budgets and anytime behaviour, spatial partitioning of oversized batches"
([execution plan:573-576](IMPLEMENTATION_EXECUTION_PLAN.md#L573-L576)). Its completion criteria
include "solve is exact in the singleton regime" — met — and "Anytime: exceeding the time budget
returns the incumbent with its bound" — met in mechanism, but N3 shows the incumbent at the target
shape is 1 % of the batch, which is a Phase 10 quality question, not a Phase 15 one.

**It is not a new phase.** The plan is explicit that it is a living document while the specification
is frozen ([execution plan:1339-1341](IMPLEMENTATION_EXECUTION_PLAN.md#L1339-L1341)), and §15 of the
brief is right that inventing "Phase 15.1" would be terminology the architecture does not use. More
decisively: **implementing cost scaling is not new capability at all.** §20.2's own table names
"min-cost flow **with cost scaling**" as the technique for the singleton regime. The shipped SSP is a
deviation from that; correcting it is *conformance to the frozen specification*, which by definition
cannot be a new phase.

**It is not a specification change.** Per the plan's §8 maintenance rules, a specification change
requires a written problem statement, affected-section identification, §22.3-level approval, a
consistency pass, and an ADR. None of that is triggered, because the specification already says what
the solver should be. An ADR **is** warranted for the *choice of concrete algorithm* (auction/JV vs
general cost-scaling push-relabel) and for the lexicographic-cost encoding decision, both of which
are engineering decisions within the specified technique.

### The consequence for reporting

The remediation should be reported as:

> **Phase 10 — solve conformance to §20.2 and §20.1**, a re-opened workstream, with its own
> completion criteria and its own independent verification, whose closure is a prerequisite for
> Phase 15's `scale_targets` gate.

Not as "Phase 15.1", not as "Phase 15 continued", and not folded silently into Phase 16b (whose gate
"Round wall-clock within §20.1 at target batch size" would then be discharged by work nobody
verified separately).

**The same ownership logic applies to the other three blockers:**

| Blocker | Owning phase | Rationale |
|---|---|---|
| **A — Calibration** | **Execution-plan pre-work B8**, spanning Phases 7 and 15 | The plan lists it as a blocking *decision*, not a phase deliverable ([execution plan:963](IMPLEMENTATION_EXECUTION_PLAN.md#L963)) |
| **B — Solver** | **Phase 10, re-opened** | Above |
| **C — Production evidence** | **Phase 15**, except: the shadow composition root is **Phase 11's** (`§21.6`, `workers/shadow`), and the fleet demand generator is **Phase 15 checklist item 5**, correctly reported as partial | The gates are Phase 15's; two of their prerequisites are not |
| **D — Rollback rehearsal** | **Phase 15** | Checklist item 14, unambiguously |

---

## 11. Production Evidence Plan

Requirements below are taken from the gate table, the register, §21.6, §24.4, §24.6 and §26. **No
requirement is invented; where the architecture states none, this plan says so.**

### 11.1 `simulator_fidelity`

| Aspect | Requirement |
|---|---|
| **Gate statement** | "Per-model distributions are validated one-sidedly against realised production data; no safety-relevant model exceeds `sim.max_optimistic_bias`" ([gates.js:242-243](Backend/src/engine/cutover/gates.js#L242-L243)) |
| **Exact evidence** | A study file consumed by `node tools/simFidelity/validate.js --input <study>`, containing per-model, **per-slice** (zone × agent class × time bucket) simulated and realised distributions for the seven models the tool declares: `TRAVEL_TIME`, `SERVICE_TIME`, `ENERGY_CONSUMPTION`, `CHARGE_DURATION`, `FAILURE_RATE`, `INTERVENTION_RATE`, `DISCONNECT_RATE`. Six of the seven are `safetyRelevant: true`; `SERVICE_TIME` is not |
| **How the simulator must be exercised** | §24.4's full brief: replay historical demand **and** generate synthetic demand with controllable burstiness and spatial correlation; inject every §18.2/§18.3 failure individually and in combination; drive entry into and exit from every §18.5 degraded mode, verifying observed invariant statuses match §26.2's matrix exactly; run the named adversarial scenarios; exercise the aging-cap property |
| **Models compared** | The seven above, as **distributions** — bias and dispersion — never averaged across slices. The gate fails on the **worst** slice and names it |
| **Data required** | Realised outcomes in the shape `observability/calibration.js` produces (§21.5 already collects them) |
| **Is the current simulator sufficient?** | **No.** Phase 15 checklist item 5 is correctly reported PARTIAL: the injection surfaces (`failure/agentFailures.js`, `infraFailures.js`, `degraded/modeRegister.js`) and the `VirtualRobot`/`SimulationEngine` substrate exist, but **the demand generator with controllable burstiness and spatial correlation is not built** |
| **Must the demand generator be built first?** | **Yes.** Without it the study can only cover replayed historical demand, which cannot exercise the §18 catalogue the fidelity study is supposed to validate the simulator *for*. Building it is Phase 15 checklist item 5, still open |
| **Prerequisites** | (i) fleet demand generator; (ii) realised production data covering the seven models per slice; (iii) `sim.max_optimistic_bias` re-derived as a decision (§5.4a) |
| **Concurrent?** | The generator build is concurrent with everything. The study itself needs realised data, so it runs alongside or after shadow |
| **Completion artefact** | The study JSON, plus `npm run sim:fidelity -- --input <study>` exiting 0 with no safety-relevant model `OPTIMISTIC_BIAS_EXCEEDED`, `NOT_MEASURED`, or `UNVALIDATABLE`. Filed as `{ pass: true, source, observedAt, detail }` against `simulator_fidelity` |

### 11.2 `soak`

| Aspect | Requirement |
|---|---|
| **Gate statement** | "A soak over days exposes no leak, unbounded cache, timer accumulation or queue drift" |
| **Exact duration** | `release.soak_duration` = **72 hours** default — but **STRUCTURAL and PROVISIONAL**, awaiting "the observed time constant of the slowest accumulating resource (timer table growth and cell-pair cache residency)". The duration must be re-derived before it can discharge the gate; a soak run against an un-derived duration is a run whose length nobody can defend |
| **Exact workload** | §24.6: "soak tests over days to expose leaks, unbounded caches, timer accumulation, and queue drift", under §24.5's "production-shaped load" in staging |
| **Exact metrics** | The four §24.6 names — leaks, unbounded caches, timer accumulation, queue drift. The shipped harness measures the **shape**: window-over-window drift ratio, `bounded === drift <= 0` ([scaleHarness.js `soak`](Backend/tests/scale/helpers/scaleHarness.js)) |
| **Required SLOs** | **The architecture states no numeric SLO for the soak.** It states a shape condition (no unbounded growth). This plan invents none |
| **How success is recorded** | The soak profile's output, with duration, workload description, and per-window samples; filed against `soak` |
| **Prerequisites** | (i) `release.soak_duration` re-derived; (ii) **the solver that will ship** — a 72-hour soak of a solver about to be replaced is a soak of the wrong artefact; (iii) a staging environment carrying production-shaped load |
| **Concurrent?** | With `shadow_agreement` and `simulator_fidelity`, once the solver is settled. **Not** before Blocker B closes |

### 11.3 `shadow_agreement`

| Aspect | Requirement |
|---|---|
| **Gate statement** | "Shadow mode has run against live traffic for at least the declared window and its agreement report is published" |
| **Exact period** | `cutover.shadow_agreement_window` = **14 days**, STRUCTURAL, **DERIVED** — transcribed from the plan's own "≥ 2 weeks of live traffic". Not re-derivable; it is a stated requirement |
| **Traffic requirements** | "live traffic" (§21.6: "runs on live inputs in parallel with production, producing decisions that are recorded and never executed"). The plan says "Run shadow mode against live traffic for ≥ 2 weeks; publish the agreement report" ([execution plan:1309](IMPLEMENTATION_EXECUTION_PLAN.md#L1309)) |
| **Comparison methodology** | §21.6: differences between shadow decisions and executed decisions, analysed offline. The `shadow` worker's "runner and its comparison are complete and tested through `runOnce`" per the registry |
| **Agreement metric** | **The architecture states no numeric agreement threshold.** §21.6 requires the report, not a pass mark. This plan invents none. What the gate requires is that the window has elapsed and the report is *published* |
| **Prerequisites** | **(i) the shadow worker's composition root — the five collaborators `round`, `expandCandidates`, `pricedCandidateFor`, `budgetsFor`, `deferPriceFor`, built outside a test fixture (N4).** (ii) live traffic to shadow. (iii) a solve path that completes inside a shadow round — which means **Blocker B must be closed first**, since a shadow round taking 24 s per batch cannot keep up with live inputs |
| **Must calibration/solver be complete first?** | **The solver: yes**, for the reason above. **Calibration: partially, and in the other direction** — shadow is what *produces* the evidence for Group C's three parameters (§6, Group C). So: solver before shadow; shadow before three of the 39 |
| **Concurrent?** | The composition-root engineering is concurrent with everything. The 14-day window is not concurrent with the solver work |
| **Completion artefact** | The published agreement report, naming the window's start and end instants and the traffic volume; filed against `shadow_agreement` |

### 11.4 `invariants_enforced`

| Aspect | Requirement |
|---|---|
| **Gate statement** | "Every §26 invariant reports ENFORCED in nominal operation with a zero-violation SLI, and none reports VIOLATED where §26.2's matrix says SUSPENDED" |
| **Which invariants** | All **22**: I1–I22, as enumerated by `invariantChecker.CHECKS`. `assertEveryInvariantIsChecked()` already guarantees the register and the checker agree |
| **How they become `ENFORCED`** | The invariant worker runs against a **live shard** and reports each check's status over an observation window with zero violations. `STATUS` is `ENFORCED` / `VIOLATED` / `SUSPENDED` |
| **Production evidence required** | A live, deciding shard. This is the one gate that is genuinely, irreducibly downstream of the cutover: it is Phase 15's completion criterion E2, and by construction it cannot be evaluated before a shard is live |
| **Observation duration** | **Not specified anywhere in the repository.** `cutover.observation_window` (3 600 s, PROVISIONAL) governs the per-shard *staging* hold, not the invariant-enforcement evidence window. **This is a genuine definitional gap that must be closed before the cutover, not during it** — otherwise "ENFORCED in nominal operation" is discharged by whoever decides they have watched long enough. Recommendation: register the invariant-observation window explicitly, derived from the same reasoning as `cutover.observation_window` (long enough for each invariant's slowest-firing check to have fired), as an ordinary STRUCTURAL parameter |
| **Prerequisites** | Every other gate GREEN; the staged cutover under way; §26.2's matrix available to the assessor |
| **Concurrent?** | No. Strictly last |
| **Completion artefact** | The invariant SLI report over the declared window, per shard, showing 22/22 `ENFORCED` (or `SUSPENDED` only where §26.2 authorises it and names the mode); filed against `invariants_enforced` |

### 11.5 Summary

| Gate | Required evidence | Prerequisites | Concurrent? | Completion artefact |
|---|---|---|---|---|
| `simulator_fidelity` | Per-model, per-slice one-sided study; 6 safety-relevant models within `sim.max_optimistic_bias` | Fleet demand generator (checklist item 5); realised production data; `sim.max_optimistic_bias` re-derived as a decision | Generator build: yes. Study: after realised data exists | Study JSON + `sim:fidelity` exit 0 |
| `soak` | ≥ `release.soak_duration` at production-shaped load, no unbounded growth in four named quantities | `release.soak_duration` re-derived; **the shipping solver**; staging env | With shadow, after Blocker B | Soak run record with duration, workload, per-window samples |
| `shadow_agreement` | ≥ 14 days on live inputs + published agreement report | **Shadow composition root (N4)**; live traffic; **Blocker B closed** | Composition root: yes. Window: no | Published agreement report |
| `invariants_enforced` | 22/22 `ENFORCED`, zero-violation SLI, §26.2 matrix respected | **All other gates green + live shard** | No — strictly last | Invariant SLI report over the declared window |

---

## 12. Rollback Rehearsal Plan

`rollback_rehearsed` is ORGANISATIONAL. `docs/runbooks/rollback.md` §5 already specifies exactly what
discharges it; this section adds the operational detail around those six steps and identifies what
must be true before they can be run. **No rehearsal was executed by this analysis.**

### 12.1 Environment

**Staging**, explicitly: `rollback.md` §5 step 1 says "Take a **staging** shard live through the full
§3 of `cutover.md`". The rehearsal must **not** be run in production, and it need not wait for
production: it exercises the controller and the deploy path, both of which exist in staging.

### 12.2 Prerequisites

| # | Prerequisite | Why | Currently satisfied? |
|---|---|---|---|
| 1 | A staging environment with at least one shard and a working config-publish path | §3 of `cutover.md` publishes a `ConfigBinding` | Unknown from the repository — **must be confirmed** |
| 2 | An SLI store the guardrail assessor can read | `cutover/store.js` reads the window out of the SLI store | Present in code |
| 3 | An audit stream (`AuditEvent`) the pre-declaration can be written to and read back from | `store.declarationFor()` reads exclusively from the audit stream, never from memory | Present in code |
| 4 | **Release evidence that satisfies `gates.blockers()` for the staging shard** | `authoriseEnable()` refuses on refusal #1 unless every blocking gate is GREEN | **NOT satisfied — see 12.6, the one real obstacle** |
| 5 | Two distinct human approvers | Refusal #3 refuses `automated: true` and refuses a missing second approver | Organisational |
| 6 | A pre-Phase-15 build artefact, retained and deployable | Step 4 requires identifying "the last artefact whose `checkLegacyRetirement.js` **fails**" | **Must be confirmed retained** — if artefact retention has already aged it out, rollback B is untestable and, more seriously, unavailable in a real incident |
| 7 | `cutover.worker.js` running against the staging shard | Step 2 requires the *controller* to fire, not a manual call | Present in code; must be scheduled |

### 12.3 Simulated failure

Step 2 is precise and the precision is the point: **"Trigger an automatic rollback by breaching a
guardrail deliberately — not by calling the rollback function. What is under test is the controller,
not the API."**

Concretely: declare guardrails per `cutover.md` §3.1 (both p99.9 rows are mandatory), take the shard
live, then drive one declared SLI past its threshold with sufficient samples — e.g. inject latency on
the commit path until `commit_transaction_p999` exceeds its declared 100 ms over ≥ `minSamples`
observations. The `HOLD`-on-insufficient-samples behaviour should be observed first and *not* mistaken
for a soft pass.

### 12.4 Expected automatic action, audit trail, and final state

| Expectation | Source |
|---|---|
| `cutover.worker.js`'s `assessShard()` returns `ROLL_BACK` | `cutover.md` §3.4 |
| `guardrails.assertOneDirectional("DISABLE")` is called and does not throw; an `ENABLE` would throw | `rollback.md` §3 |
| `stage.authoriseRollback({ automatic: true })` succeeds — **no gate, no quorum, no ordering rule**; only a reason is required | `rollback.md` §2 |
| The reverted binding is published and `stage.auditEventFor(...)` is appended, hash-chained, carrying the guardrail declaration | `cutover.md` §3.3 |
| An `error`-level log naming the shard, the breached guardrails, and the observed values | `rollback.md` §3 item 4 |
| `GET /api/health/cutover` shows the shard `live: false` with `consequence` reading *"this shard has NO decision path"* | `rollback.md` §2 |
| New work for the shard is refused **503 `ENGINE_NOT_LIVE`**; **zero** `Task` rows created; `WorkQueue` unchanged | `task.service.js` gate-before-write; `intakeStranglerSeam.test.js:201-224` |
| **Committed work continues** — leases renewed, timers fire, reconciler sweeps | `rollback.md` §2 |
| Legs **queued but not decided** are stranded and require deliberate drain or re-enable | `rollback.md` §2, "What you must do next" |

### 12.5 Evidence to retain, and success criteria

**Retain:** the pre-declaration event and the rollback event from the audit stream (with their hash
links, proving the ordering); the `GET /api/health/cutover` response before and after; the
`error`-level log line; the 503 response body from a refused intake attempt; the deploy record for
rollback B; the timestamps of every step; and the free-text note step 6 requires — "anything that
surprised you".

**Success criteria (all must hold):**

1. The **controller** fired the rollback; no human called `authoriseRollback` in step 2.
2. Only `DISABLE` was ever attempted automatically; `assertOneDirectional` was exercised.
3. The audit stream shows the pre-declaration **strictly before** the observation window opened.
4. Intake refused with a reason and wrote nothing.
5. **Rollback B was performed end to end** — artefact identified by `checkLegacyRetirement.js`
   *failing* on it, deployed, legacy path confirmed serving (tasks reach `ASSIGNED` with a `robotId`;
   `TASK_ASSIGN` reaches agents).
6. Re-cutover succeeded through the full staged discipline, not a shortcut.
7. The record names a date and the operators.

**The runbook itself flags the failure mode:** "Step 4 is the one that will be skipped and it is the
one that matters." A rehearsal record without step 4 does not discharge the gate.

### 12.6 The one real obstacle, and how to handle it honestly

`stage.authoriseEnable()` refuses on refusal #1 unless `gates.blockers(releaseEvidence)` is empty —
and today it is not, in this or any environment. So the rehearsal's step 1 ("take a staging shard
live through the full §3 of `cutover.md`") **cannot be performed today without supplying release
evidence.**

There are exactly two defensible responses, and one indefensible one:

- **Defensible (A):** run the rehearsal with **staging-scoped release evidence**, filed explicitly as
  staging evidence with its own `source` field, and record in the rehearsal document that the enable
  was authorised against staging evidence. The gate object already carries `source` and `observedAt`
  for exactly this reason ([gates.js:320-322](Backend/src/engine/cutover/gates.js#L320-L322)). The
  rehearsal is a test of the *controller and the deploy path*, not of the gates — which are separately
  and mechanically tested.
- **Defensible (B):** defer the rehearsal until the gates are genuinely green, accepting that it then
  sits on the critical path immediately before the production cutover, which is the worst possible
  place for an activity whose purpose is to discover unknowns.
- **Indefensible:** file production-shaped evidence, or add a bypass to `authoriseEnable` for
  "rehearsal mode". Both put a route around refusal #1 into the code, which is precisely the control
  the design has no waiver for.

**Recommendation: (A).** Do it early, do it in staging, label the evidence as staging evidence in the
rehearsal record, and **do not** file that evidence against the production gate table. This is the
single largest reduction in cutover-day risk available for the smallest cost, and the decision
belongs to the SRE owner named in `cutover.md` §1 row 7.

---

## 13. Minor Findings Assessment

| # | Finding | Assessment | Disposition |
|---|---|---|---|
| **1** | **Java/TLC environment wording.** `formal/README.md:28` and `lifecycle.tla`'s header state "no Java toolchain"; the verification environment has Java 20.0.2. The precise blocker is that `tla2tools.jar` is not vendored | Informational. The substantive claim — TLC has not been executed, and the executable equivalent's coverage and limits are accurately described — is unaffected. §24.2 permits "TLA+ **or an equivalent model checker**", so `model_check_capacity_1_2_3` is legitimately GREEN | **Defer, with a one-line wording correction whenever `formal/README.md` is next touched.** Do not open a change for it alone. Separately: `formal/README.md:66` says running TLC "needs a JDK in the build image and nothing else" — **worth doing during the remediation window** as cheap independent corroboration of a Tier 0 property, but it is not a blocker and must not be allowed to consume solver or calibration capacity |
| **2** | **Scale exponent / report precision.** The reports quote "≈2.0 in Legs, ≈0.65 in candidates, r² > 0.99" as if they were enforced thresholds; the enforced bounds are 1.5–2.6, 0.3–1.3, r² > 0.9 | Minor as stated — but this review's §7.3 makes it **more than precision**: at §20.1's candidate count the k-exponent is ≈ 0.83, not 0.65, so the quoted figure also encourages an optimistic extrapolation from 500 × 10 to 500 × 200 | **Fix as part of Solver Step S2.** The corrected 500 × 200 measurement supersedes the whole paragraph. Both reports' §14 item 2 / §18 finding 2 should be annotated with the true figure once measured. **Before Phase 16, and specifically before anyone scopes the solver work** |
| **3** | **Phase 16 module-tree coverage gap.** `phase0Scaffold.test.js` grants `lifecycle/` and `solve/` as whole-directory ownership prefixes, unlike the file-by-file treatment of `shard/`, `security/`, `cutover/`. A future `lifecycle/preemption.js` or `solve/setPartitioning.js` would not be caught | The boundary holds today only because the files are absent. **This becomes a live risk the moment the solver workstream starts editing `src/engine/solve/`** — that is exactly when a Phase 16 module is most likely to appear in that directory, and exactly when the safety net is weakest | **Fix now — before the solver workstream begins.** Convert `solve/` and `lifecycle/` to file-by-file ownership, matching the treatment the test's own comments already justify for the other three directories. Small, mechanical, and it protects the highest-risk workstream in the programme |
| **4** | **`locality` gate evidence classification.** Classified `EVIDENCE.SUITE` ("closable by a build"), but `locality.scale.test.js` solves the identical instance twice; the actual T9 cross-scale claim is an external staging exercise not present in the repository | This is a **gate-classification error, not a test defect** — the test discloses its own scope candidly. Its consequence is real: a reader of `gates.js`'s `statement` field would believe T9 is build-closable, and the `locality` row could be filed GREEN off a build that never tested T9 | **Fix before production cutover.** Either reclassify the row to `PRODUCTION` (matching what actually discharges it) and add the cross-scale benchmark to the staging plan, or split it into two rows — a `SUITE` row for the two structural properties the test genuinely verifies (no fleet-wide term in `sizing.js`; the comparator's two-sidedness) and a `PRODUCTION` row for the T9 cross-scale claim. **This is a Phase 15 correction, and it is the only minor finding that could let a gate be closed on evidence that does not support it** |
| **5** (inherited, Phase 14) | **`surrogateKeys` inert (N9).** No engine code path writes the column; the only writer is the offline `backfillIdentities.js`. Phase 14's verification recommended resolving it "before Phase 15 treats the column as populated" | Not a privacy defect — `gate:privacy` independently confirms the four modules hold no identifying field. But §23.7's *positive* half is not true in behaviour, and Phase 15 has now shipped on top of it without addressing it | **Decide before cutover.** Either thread the derived-quantity lookup into `decisionRecord.js`, or reword the checklist item's disposition to "schema and gate complete; live population deferred". Leaving it silently open across two phase boundaries is how a documentation gap becomes a belief |

**Priority ordering among the minor findings:** 3 (now, protects the solver workstream) → 4 (before
cutover, prevents a gate closing on the wrong evidence) → 2 (with Solver Step S2) → 5 (before cutover,
decision only) → 1 (defer).

**None of these should be permitted to consume capacity that belongs to Blockers A–D.** Findings 3
and 4 together are perhaps two days of work.

---

## 14. Parallel Workstreams

Five tracks. Four of the five can start on the same day.

```text
Day 0 ─────────────────────────────────────────────────────────────────────────►

TRACK A — SOLVE CONFORMANCE  (Phase 10, re-opened)                    [Eng]
  A1 objective.buildInstance group-by ────┐
  A2 scale suite at real 500×200 shape ───┤ measure
  A3 partition component-size measurement ┘
  A4 SSP constant-factor optimisation ──── measure ──► DECISION POINT
  A5 [conditional] auction/JV with ε-scaling + differential test
  A6 whole-round measurement on representative hardware ──► scale_targets GREEN

TRACK B — CALIBRATION  (pre-work B8)                        [Calibration owner]
  B0 NAME THE CALIBRATION OWNER  ◄── gates everything in this track
  B1 Group A: 13 decisions/documents ──────────────────────────────►
     (start items 26–28, external authorities, on day 0 — longest lead)
  B2 Group B: 12 measurements from today's fleet ──────────────────►
  B3 register corrections: sim.max_optimistic_bias circularity;
     the two legacy.dtaro.* retirements; the 8 advisory DERIVATION_NOT_STATED
  B4 Group D unblocking: §6.1 decisions B1/B2/B3/B6; energy_calibration
     worker scheduler ───────────────────────────────────────────────►
  B5 Group C: 3 params ────────────────────── (waits on Track C's C1)

TRACK C — PRODUCTION-EVIDENCE INFRASTRUCTURE                          [Eng]
  C1 shadow worker composition root  ◄── CRITICAL PATH ITEM
  C2 fleet demand generator (checklist item 5)
  C3 re-derive release.soak_duration
  C4 register the invariant-observation window (§11.4 gap)
  C5 confirm pre-Phase-15 artefact retention (rollback B viability)

TRACK D — ROLLBACK REHEARSAL                                          [SRE]
  D1 confirm staging environment + config publish path
  D2 schedule cutover.worker.js against staging
  D3 rehearse: all six rollback.md §5 steps, including step 4
  D4 record and file ──► rollback_rehearsed GREEN   (earliest gate to close)

TRACK E — CORRECTIONS AND HYGIENE                                     [Eng]
  E1 phase0Scaffold: solve/ and lifecycle/ to file-by-file  ◄── before A starts
  E2 locality gate reclassification (Finding 4)
  E3 surrogateKeys decision (Phase 14 Finding 2)
  E4 [optional] vendor tla2tools.jar / add JDK, run TLC
```

### Convergence

```text
        Track A ──► scale_targets GREEN ─────┐
        Track B ──► calibration GREEN ───────┤
        Track E ──► gate classifications ────┤
                                             ├──► SHADOW may start (needs A + C1)
        Track C1 ──► shadow worker live ─────┘         │
                                                       │  ≥ 14 days
        Track D ──► rollback_rehearsed GREEN ──────────┤
        Track C2 ──► demand generator ──► fidelity ────┤
        Track C3 ──► soak (after A settles) ───────────┤
                                                       ▼
                                        ┌──────────────────────────┐
                                        │  22 of 23 gates GREEN    │
                                        │  (all but invariants)    │
                                        └────────────┬─────────────┘
                                                     ▼
                                        ┌──────────────────────────┐
                                        │ INDEPENDENT RE-VERIFY #1 │
                                        └────────────┬─────────────┘
                                                     ▼
                                        ┌──────────────────────────┐
                                        │ STAGED PRODUCTION CUTOVER│
                                        └────────────┬─────────────┘
                                                     ▼  observation window
                                        ┌──────────────────────────┐
                                        │ invariants_enforced GREEN│  (E2)
                                        └────────────┬─────────────┘
                                                     ▼
                                        ┌──────────────────────────┐
                                        │ INDEPENDENT RE-VERIFY #2 │
                                        │  → PHASE 16 MAY BEGIN    │
                                        └──────────────────────────┘
```

### What genuinely cannot be parallelised

1. **Shadow's 14 days cannot start before the solver is fast enough** to keep up with live inputs
   and before C1 lands. This is the longest serial chain: `A1..A4/A5` → `C1` → 14 days → report.
2. **Soak cannot precede the solver decision** — it would soak an artefact about to be replaced.
3. **`invariants_enforced` cannot precede the cutover**, and the cutover cannot precede every other
   gate. This is the irreducible tail.
4. **Group C calibration cannot precede shadow**, since shadow is what produces its evidence.

### What is being serialised today for no reason

- **Rollback rehearsal** (Track D) is treated as a late-stage item. It has no technical dependency on
  A, B, or C. It should close first.
- **Group A and B calibration** (25 of 39 parameters) is treated as gated on production. It is gated
  on naming an owner.
- **The shadow composition root** (C1) is not on anyone's plan and is on the critical path.

---

## 15. Ordered Remediation Sequence

### Stage 0 — Decisions and hygiene (days 0–5, all concurrent)

| # | Action | Owner | Closes / enables | Evidence |
|---|---|---|---|---|
| 0.1 | **Name the calibration owner (B8).** A standing role per §22.4, not a project task | Programme | Unblocks 25 of 39 parameters immediately | The appointment, recorded |
| 0.2 | Open external-authority engagement for `ops.external_escalation_contacts`, `ops.emergency_services_hazard_threshold`, `ops.stranded_obstructing_response_target` | Ops / Safety | Longest-lead Group A items | Contact and meeting records |
| 0.3 | **E1: `phase0Scaffold.test.js` — `solve/` and `lifecycle/` to file-by-file ownership** | Eng | Protects Track A from Phase 16 leakage | Test change + planted-violation proof |
| 0.4 | **E2: reclassify or split the `locality` gate row (Finding 4)** | Eng | Prevents a gate closing on evidence that does not support it | `gates.js` change + updated `locality.scale.test.js` header |
| 0.5 | Confirm staging environment, config-publish path, and **pre-Phase-15 artefact retention** | SRE | Track D viability; and confirms rollback B is available in a real incident | Written confirmation |
| 0.6 | Decide the `surrogateKeys` disposition (Phase 14 Finding 2) | Eng | Closes an inherited gap before it crosses a third phase boundary | Either code or a reworded checklist disposition |

### Stage 1 — Solver measurement (days 1–10) · Rollback rehearsal (days 1–15) · Calibration start (day 5 onward)

| # | Action | Owner | Closes / enables | Evidence |
|---|---|---|---|---|
| 1.1 | **A1: `objective.buildInstance` group-by** — O((m+n)·q) → O(q) | Eng | Removes ~13.4 s at the §20.1 shape | Byte-identical output proof; determinism corpus unchanged |
| 1.2 | **A2: re-measure at 500 × 200** and publish the corrected figure; annotate both Phase 15 documents | Eng | Replaces an estimate with a measurement; supersedes Finding 2 | Updated `round.scale.test.js` retaining `attained === false` polarity |
| 1.3 | **A3: measure the partition component-size distribution** at production candidate density (N10) | Eng | Determines whether O6 gives any relief | New scale test |
| 1.4 | **D1–D4: rehearse the rollback**, all six `rollback.md` §5 steps, staging-scoped evidence explicitly labelled | SRE | **`rollback_rehearsed` GREEN — the first gate to close** | Dated rehearsal record, audit events, deploy record |
| 1.5 | **C1: build the shadow worker's composition root** | Eng | Unblocks the 14-day critical path and 3 calibration parameters | The worker's readiness moving from `DEFERRED` to `SCHEDULED` |
| 1.6 | **B3: register corrections** — `sim.max_optimistic_bias` re-derived as a Safety decision; the two `legacy.dtaro.*` retirements (repointing `src/simulation/constants.js` first); the 8 advisory `DERIVATION_NOT_STATED` entries | Calibration owner + Safety | 3 of the 39 + 8 advisories | §22.3 two-person-approved register changes + ADRs, in the audit stream |
| 1.7 | **B1/B2: Group A and Group B derivations begin** (25 parameters) | Calibration owner | The bulk of Blocker A | `derivation` fields citing documents, datasets, windows, slices |
| 1.8 | **B4: resolve §6.1 blocking decisions B1, B2, B3, B6**; land the `energy_calibration` worker scheduler | Eng / Programme | Unblocks Group D's 9 remaining parameters — and B1 additionally conditions §20.1's routing budget | Decision records + ADRs |

### Stage 2 — Solver engineering (weeks 2–10)

| # | Action | Owner | Closes / enables | Evidence |
|---|---|---|---|---|
| 2.1 | **A4: SSP constant-factor optimisation.** Re-measure | Eng | Possibly sufficient; probably not | Determinism corpus byte-identical; new exponent measurement |
| 2.2 | **DECISION POINT**, against the rule stated in §9 | Eng + Architecture | Scopes A5 honestly or cancels it | The measurement, and a written decision |
| 2.3 | **A5 [conditional]: implement auction/JV with ε-scaling** as §20.2's named cost-scaling technique. ADR for the concrete algorithm and the lexicographic-cost encoding | Eng | The algorithmic half of Blocker B | Differential test vs. the current solver over a large randomised corpus; exactness proof; dual exactness; LP–IP gap 0; replay byte-identical |
| 2.4 | **A6: whole-round p99 on representative hardware at 500 × 200** — the only measurement that can discharge the gate | SRE + Eng | **`scale_targets` GREEN** | Measurement record with hardware provenance |
| 2.5 | Independent verification of the re-opened Phase 10 workstream | Independent reviewer | Prevents the solver replacement from being self-certified | A Phase 10 re-verification report |

### Stage 3 — Evidence accrual (weeks 8–16, overlapping Stage 2's tail)

| # | Action | Owner | Closes / enables | Evidence |
|---|---|---|---|---|
| 3.1 | **Shadow mode starts** on live inputs (needs A4/A5 + C1) | Eng | Begins the 14-day clock | Shadow decisions recorded, none executed |
| 3.2 | **B5: Group C calibration** derived from the same shadow run | Calibration owner | Last 3 of the 39 → **`calibration_safety_derived` GREEN** | `derivation` fields citing the shadow run and window |
| 3.3 | **C2: fleet demand generator**; then the one-sided fidelity study | Eng + Safety | **`simulator_fidelity` GREEN** | Study JSON; `sim:fidelity` exit 0 |
| 3.4 | **C3: re-derive `release.soak_duration`; run the soak** against the shipping solver | Eng | **`soak` GREEN** | Soak record |
| 3.5 | **Shadow agreement report published** at ≥ 14 days | Eng | **`shadow_agreement` GREEN** | The report |
| 3.6 | **C4: register and derive the invariant-observation window** (§11.4 gap) | Eng | Makes E2 assessable rather than judgemental | Register entry with a stated derivation |
| 3.7 | Add the T9 cross-scale benchmark to the staging plan (per E2's reclassification) | SRE | **`locality` GREEN on the right evidence** | Cross-scale benchmark record |

### Stage 4 — Convergence and cutover (weeks 16+)

| # | Action | Owner | Closes / enables | Evidence |
|---|---|---|---|---|
| 4.1 | **Independent re-verification #1** — 22 of 23 gates, with every artefact re-executed by a reviewer who did not produce it | Independent reviewer | Confirms the repository is genuinely cutover-eligible | A re-verification report |
| 4.2 | `npm run release:gates` exits 0; `gates.blockers(releaseEvidence)` returns `[]` | Eng | Refusal #1 no longer fires | Gate table with 22 GREEN, `invariants_enforced` pending |
| 4.3 | **Staged cutover** per `cutover.md`: publish the staging plan; per shard, pre-declare guardrails, authorise with two approvers, publish, audit, hold the observation window | SRE + Eng | The engine becomes the decision path | Audit events per shard |
| 4.4 | Observe §26 invariants over the registered window on live shards | SRE | **`invariants_enforced` GREEN — E2** | Invariant SLI report |
| 4.5 | Re-run `npm run safety:case` after all register and gate changes | Safety | Keeps `safety_case_assembled` honest | Byte-identical regeneration |
| 4.6 | **Independent re-verification #2 — Phase 15 completion** against all five entry conditions E1–E5 | Independent reviewer | **PHASE 16 READY** | Final verification report |

### The two points where the sequence must not be compressed

- **2.2, the solver decision point.** Skipping it means either shipping an inadequate solver or
  committing 4–8 weeks on an extrapolation. The measurement is cheap; the decision is not reversible
  cheaply.
- **4.4, the invariant observation window.** This is the last chance the machinery has to say "no",
  and its length is currently undefined (§11.4). Define it in Stage 3 (3.6), not while watching it.

---

## 16. Phase 16 Readiness Matrix

Strict reading. "Phase 15 code is correct" appears nowhere in this table, because it is not an entry
condition.

| Entry condition / gate | Current state | Evidence required | Blocked by | Resolution step |
|---|---|---|---|---|
| **E1 — every §24 gate GREEN** | 16 GREEN / 2 RED / 1 partial / 4 NOT_EVALUATED | `gates.blockers(evidence)` returns `[]` | A, B, C, D | 4.2 |
| ├ `calibration_safety_derived` | **RED**, 39 findings | 39 × (`DERIVED` + stated derivation) | B8 owner; §6.1 decisions; shadow | 0.1, 1.6, 1.7, 1.8, 3.2 |
| ├ `scale_targets` | **RED**, ≈ 97× at the real shape | Whole-round p99 < 250 ms at 500 × 200 on representative hardware | Solver algorithm class; **and B1 routing, which §20.3 makes the dominant term** | 1.1–1.3, 2.1–2.4 |
| ├ `locality` | **PARTIAL**, misclassified as SUITE | T9 cross-scale benchmark (staging), plus the two structural properties | Gate classification error (Finding 4) | 0.4, 3.7 |
| ├ `shadow_agreement` | NOT_EVALUATED | ≥ 14 days on live inputs + published report | **Shadow composition root (N4)** + solver | 1.5, 2.x, 3.1, 3.5 |
| ├ `simulator_fidelity` | NOT_EVALUATED | Per-model, per-slice one-sided study within `sim.max_optimistic_bias` | Fleet demand generator; realised data; the parameter's circularity | 1.6, 3.3 |
| ├ `soak` | NOT_EVALUATED | ≥ re-derived `release.soak_duration`, no unbounded growth | `release.soak_duration` PROVISIONAL; the shipping solver | 3.4 |
| ├ `invariants_enforced` | NOT_EVALUATED | 22/22 `ENFORCED`, zero-violation SLI, §26.2 respected | **Everything** — needs a live shard | 4.3, 4.4 |
| ├ `rollback_rehearsed` | NOT_EVALUATED | Dated record, named operators, all six §5 steps incl. step 4 | **Nothing** | 1.4 |
| └ the other 14 | GREEN | Re-run on each build | — | Hold |
| **E2 — every §26 invariant `ENFORCED` in nominal operation, zero-violation SLI** | Not observed. All 22 checks exist and pass in test | Invariant-worker SLI over a **registered** observation window on live shards | E1, then the cutover. **The window length is undefined in the repository** | 3.6, 4.3, 4.4 |
| **E3 — safety case assembled from queries** | **MET** | `npm run safety:case` PASS, byte-identical | — | Re-run at 4.5 |
| **E4 — legacy path removed from build** | **MET** | `gate:legacy` PASS, 285 files | — | Hold |
| **E5 — rollback rehearsed** | Runbook written; rehearsal not performed | As above | Nothing | 1.4 |
| **Additional: no Phase 16 leakage** | **MET** — `fairness/` empty; no Tier 2 solve module; 12/12 kill switches thrown | `phase0Scaffold.test.js` module walk | Safety net has a gap for `solve/` and `lifecycle/` (Finding 3) — **most dangerous exactly when Track A opens** | 0.3 |
| **Additional: `tierTwoAtShipState()`** | **MET** | All 12 Tier 2 switches thrown | — | Hold |

### Readiness scorecard

| | Count |
|---|---|
| Gates GREEN today | 16 of 23 |
| Gates closable with **no new evidence** | 0 |
| Gates closable **today** if someone acted | **1** (`rollback_rehearsed`) |
| Gates requiring engineering only | 2 (`scale_targets`, `locality` reclassification) |
| Gates requiring organisational decisions | 1 (`calibration_safety_derived`, in the majority) |
| Gates requiring elapsed wall-clock | 3 (`shadow_agreement` ≥ 14 d, `soak` ≥ 72 h, `invariants_enforced`) |
| Entry conditions MET | 2 of 5 (E3, E4) |
| **Phase 16 status** | **NOT READY** |

---

## 17. Final Recommendation

# RECOMMENDED NEXT ACTION

> **Fix `objective.buildInstance`'s O((m + n) · q) group-by
> ([objective.js:193-218](Backend/src/engine/solve/objective.js#L193-L218)), then re-run the §20.1
> measurement at the real 500 Legs × 200 candidates shape and publish the corrected figure.**

One action, and it is the right one for six reasons:

1. **It converts the largest blocker from an estimate into a measurement.** The published gap
   (≈ 6.7×, at 500 × 10) is not the real gap (≈ 97× on the solve, ≈ 151× including instance
   construction). Every scoping decision about the solver — weeks of engineering, an ADR, an
   algorithm choice, an independent re-verification — is currently being made against a number that
   is wrong by an order of magnitude in the direction that makes the problem look tractable.

2. **It removes 13.4 seconds of the 37.8, and it is a missed group-by.** No algorithm changes, no
   architecture question, no determinism risk, no correctness argument — the rows produced are
   identical, in identical order. It is the single highest benefit-to-risk ratio available anywhere
   in this programme.

3. **It is never wasted.** Every candidate solver consumes the same instance. If the solver is
   replaced tomorrow, this work still counts.

4. **It is the cheapest thing that can be independently verified.** A reviewer can confirm it by
   diffing the produced instance and re-running the determinism corpus.

5. **It reduces the most uncertainty per unit of effort.** After it, the programme knows whether it is
   scoping a two-week optimisation or a two-month algorithm replacement — and that single fact
   determines the shape of Tracks C and D's scheduling, because shadow's 14-day window cannot start
   until the solver is fast enough to keep up with live inputs.

6. **It costs one to two days.** Everything else on the critical path costs weeks or months.

Two things should be started **on the same day** by different people, because they are owned
elsewhere and gate more than they cost:

- **Name the calibration owner (B8).** It is a decision, not a project, and it unblocks 25 of the 39
  parameters immediately.
- **Convert `solve/` and `lifecycle/` to file-by-file ownership in `phase0Scaffold.test.js`.** The
  Phase 16 safety net is weakest in exactly the directory Track A is about to start editing.

**What must not be the next action:** beginning the solver replacement. Not because it is wrong — it
is probably necessary — but because committing 4–8 weeks of high-risk engineering before measuring
the real shape is how a programme spends a quarter solving the wrong half of a problem.

---

# PRE-PHASE-16 MASTER PLAN

**From: the verified current state. To: PHASE 16 READY.**

### Milestone 0 — Decisions, hygiene, and the first gate (days 0–15)

| Work | Owner | Output |
|---|---|---|
| Name the calibration owner (B8) | Programme | A standing role, recorded |
| `phase0Scaffold.test.js`: `solve/`, `lifecycle/` file-by-file | Eng | Finding 3 closed |
| `locality` gate reclassified or split | Eng | Finding 4 closed |
| `surrogateKeys` disposition decided | Eng | Phase 14 Finding 2 closed |
| Confirm staging env, config-publish path, pre-Phase-15 artefact retention | SRE | Track D viable; rollback B confirmed available |
| **Rehearse the rollback**, all six `rollback.md` §5 steps incl. step 4, staging-scoped evidence explicitly labelled | SRE | **`rollback_rehearsed` GREEN** |
| Open external-authority engagement (3 Group A parameters) | Ops / Safety | Longest-lead calibration items started |

**Exit:** one gate GREEN, three findings closed, the calibration track unblocked.

### Milestone 1 — Solve measurement and the shadow critical path (weeks 1–3)

| Work | Owner | Output |
|---|---|---|
| **`objective.buildInstance` group-by** | Eng | ~13.4 s removed at the §20.1 shape |
| **Re-measure at 500 × 200; publish; annotate both Phase 15 documents** | Eng | The real gap, on record; Finding 2 superseded |
| Measure the partition component-size distribution (N10) | Eng | Whether decomposition helps at all |
| **Shadow worker composition root** | Eng | Critical path unblocked |
| Register corrections: `sim.max_optimistic_bias` circularity; two `legacy.dtaro.*` retirements; 8 advisory entries | Calibration owner + Safety | 3 of 39 + 8 advisories; §22.3-approved |
| Group A and Group B derivations begin (25 parameters) | Calibration owner | Blocker A's bulk under way |
| Resolve §6.1 decisions B1, B2, B3, B6; land the `energy_calibration` scheduler | Eng / Programme | Group D unblocked; **B1 also conditions §20.1's routing budget** |

**Exit:** the solver problem is measured rather than estimated; shadow is startable once the solver
is; calibration is in flight on 28 of 39.

### Milestone 2 — Solve conformance (weeks 2–10)

| Work | Owner | Output |
|---|---|---|
| SSP constant-factor optimisation; re-measure | Eng | ~6–10× |
| **Decision point** against the §9 rule | Eng + Architecture | Either `scale_targets` is reachable, or A5 is scoped on evidence |
| [Conditional] auction/JV with ε-scaling; ADR for the algorithm and the cost encoding | Eng | §20.2 conformance |
| Differential test vs. the current solver over a large randomised corpus; replay corpus byte-identical; dual exactness; LP–IP gap 0 | Eng | The semantics are preserved, provably |
| Whole-round p99 at 500 × 200 on representative hardware | SRE + Eng | **`scale_targets` GREEN** |
| **Independent verification of the re-opened Phase 10 workstream** | Independent reviewer | The solver replacement is not self-certified |

**Exit:** the second red gate is green, on evidence a reviewer re-executed.

### Milestone 3 — Evidence accrual (weeks 8–16, overlapping)

| Work | Owner | Output |
|---|---|---|
| Shadow mode on live inputs, ≥ 14 days | Eng | **`shadow_agreement` GREEN** |
| Group C calibration from the same shadow run | Calibration owner | **`calibration_safety_derived` GREEN** |
| Fleet demand generator; one-sided fidelity study | Eng + Safety | **`simulator_fidelity` GREEN** |
| Re-derive `release.soak_duration`; run the soak against the shipping solver | Eng | **`soak` GREEN** |
| T9 cross-scale benchmark in staging | SRE | **`locality` GREEN on the right evidence** |
| Register and derive the invariant-observation window | Eng | E2 becomes assessable rather than judgemental |

**Exit:** 22 of 23 gates GREEN. Only `invariants_enforced` remains, and it is correctly unclosable
from a repository.

### Milestone 4 — Convergence, cutover, and Phase 16 entry (weeks 16+)

| Work | Owner | Output |
|---|---|---|
| **Independent re-verification #1** — 22 gates, every artefact re-executed by someone who did not produce it | Independent reviewer | Cutover eligibility confirmed |
| `npm run release:gates` exits 0; `gates.blockers()` returns `[]` | Eng | Refusal #1 no longer fires |
| **Staged production cutover** per `cutover.md`: publish the plan; per shard pre-declare, authorise with two approvers, publish, audit, hold the window; abort on any §6 criterion | SRE + Eng | The engine is the decision path |
| Observe all 22 §26 invariants over the registered window on live shards | SRE | **`invariants_enforced` GREEN — E2** |
| Re-run `npm run safety:case` after every register and gate change | Safety | `safety_case_assembled` stays honest |
| **Independent re-verification #2 — Phase 15 completion** against E1–E5 | Independent reviewer | **PHASE 16 READY** |

### Gate closure map

| Gate | Closes at | By what evidence |
|---|---|---|
| `rollback_rehearsed` | Milestone 0 | Dated rehearsal record, all six steps |
| `locality` | Milestone 3 | T9 cross-scale staging benchmark + the two structural properties |
| `scale_targets` | Milestone 2 | Whole-round p99 < 250 ms at 500 × 200 on representative hardware |
| `calibration_safety_derived` | Milestone 3 | 39 × (`DERIVED` + stated derivation), §22.3-approved |
| `simulator_fidelity` | Milestone 3 | Per-model, per-slice one-sided study; `sim:fidelity` exit 0 |
| `soak` | Milestone 3 | Soak ≥ re-derived duration, no unbounded growth |
| `shadow_agreement` | Milestone 3 | ≥ 14-day report published |
| `invariants_enforced` | Milestone 4 | 22/22 `ENFORCED`, zero-violation SLI over the registered window |
| the other 15 | Continuously | Build gates and suites, re-run each build |

### Independent verification points

1. **After Milestone 2** — verify the re-opened Phase 10 solve workstream: determinism, exactness,
   duals, LP–IP gap, replay, and the measurement's provenance.
2. **After Milestone 3** — verify 22 gates, every artefact re-executed independently.
3. **After Milestone 4** — verify Phase 15 completion against E1–E5, including the observation
   window's own derivation, and issue the Phase 16 entry decision.

---

## Closing statement

Phase 15's implementation is correct and its machinery is doing exactly what it was built to do:
refusing a cutover the evidence does not support. Nothing in this plan changes a threshold, waives a
gate, or reinterprets a RED as a PASS.

Three things this analysis found are worse than the record showed — the solver gap is two orders of
magnitude rather than one and has an unreported second hot spot upstream of it; `shadow_agreement`
has an engineering prerequisite on the critical path that nobody has scheduled; and the invariant
observation window that Phase 15's own completion criterion turns on is undefined. Two things are
better than the record showed — 25 of the 39 calibration parameters are startable the day an owner is
named, and the rollback rehearsal has no dependency on anything and could close this week.

The correct next action is small, cheap, reversible, and reduces more uncertainty than anything else
available: **fix the instance builder's group-by and measure the round at the shape §20.1 actually
names.** Everything else should be scoped after that number exists.

> **PHASE 16 REMAINS: NOT READY.**

---

*End of Phase 15 Blocker Resolution and Phase 16 Readiness Analysis. No repository file other than
this document was created or modified.*
