# Phase 15 — Closure Checklist

**The exact exit conditions, and the current verdict computed from them.**

> Current source of truth for navigation: **[`PHASE_15_MASTER.md`](PHASE_15_MASTER.md)**.
> Evidence: **[`PHASE_15_VERIFICATION_STATE.md`](PHASE_15_VERIFICATION_STATE.md)** ·
> Blockers: **[`PHASE_15_BLOCKERS.md`](PHASE_15_BLOCKERS.md)**

**Assessed:** 2026-08-29 · **Tree:** digest `431010ace188c4b1…` (565 files) · **HEAD:** `b68dc5d`
**Re-assessed:** 2026-08-29 by the documentation-integrity audit. Every command below was
re-executed and every exit code re-observed on the same digest. **The verdict did not change.**
One row (**I-5**) was made more precise; no status moved.

**Statuses:** `GREEN` · `RED` · `NOT EVALUATED` · `EXTERNAL BLOCKED` · `SPECIFICATION BLOCKED`

---

## A. Implementation requirements

| ID | Requirement | Status | Evidence | Blocking? | Owner | Required next action | Closure evidence |
|---|---|---|---|---|---|---|---|
| **I-1** | §24 release-gate table implemented (24 gates, all blocking) | **GREEN** | `src/engine/cutover/gates.js`; `release:verdict` renders all 24 | — | Phase 15 | none | Gate table renders |
| **I-2** | §22.4 staging discipline / cutover authority implemented | **GREEN** | `src/engine/cutover/` (10 modules); `stage.authoriseEnable` refuses automated enable; `assertOneDirectional` admits only `DISABLE` | — | Phase 15 | none | 19/19 `phase15VersionInForce.js` |
| **I-3** | Legacy decision path **removed from the build**, not bypassed | **GREEN** | `gate:legacy` PASS — 4 modules absent and unimported across 340 files | — | Phase 15 | none | exit 0 |
| **I-4** | Evidence machinery: source digest, collection, verdict | **GREEN** | `tools/release/` ×3; `release-evidence.json` — 17 records, 0 VOID, 17/17 bound to `431010ace1…` | — | Phase 15 | none | Digest match verified |
| **I-5** | All engine workers moved to production scheduling | **RED** | `gate:composition` exit 1 — **1 of 18** (`coordinator`) `LEADER_ONLY_NOT_COMPOSABLE`. **11 of 18 workers actually start**; 6 are `DEFERRED` with declared blockers, which the gate accepts by design — see the note below | **YES** | **EXTERNAL — B1** | D1 + D3 + D8, then B1 Steps 1/3/4/5 | `gate:composition` exit 0 |

> **I-5's plain English and its gate are not the same test, and the difference is deliberate.**
> "All engine workers moved to production scheduling" reads as 18 of 18. `gate:composition` fails
> only on an **undeclared** gap: `assertRegistry()` forces every `DEFERRED` row to name a
> `blockedBy`, and a declared, reasoned deferral passes. So the gate is satisfied at **11 of 18
> running**, and I-5 turns GREEN when `coordinator` composes — not when all 18 start.
>
> This is not a loophole; a worker that must not run until Phase 16a (`capacity_pricing`) or until
> the fleet produces data (`energy_calibration`, `service_time_model`) cannot be a Phase 15 exit
> condition. **But it does mean I-5 GREEN will not mean "all 18 workers run."** The six deferrals
> and their owners are enumerated in
> [`PHASE_15_IMPLEMENTATION_STATE.md`](PHASE_15_IMPLEMENTATION_STATE.md); two of them
> (`shadow`, `charger_reachability`) are released by B1 alongside `coordinator`, one by B8, one by
> Phase 16a, and two by fleet data or missing classifiers. **None is separately tracked as a
> blocker, and none is hidden.**
| **I-6** | Rollback publisher + configuration propagation implemented | **GREEN** | `rollbackPublisher.js`, `configPropagation.js`, wired at `server.js`; P15-R1/R2/E2 fixed | — | Phase 15 | none | 80/80 live-DB |
| **I-7** | Observation-window authority resolves bounds from the register and refuses a caller who states one | **GREEN** | P15-E1/E4/F1 fixed; `evidence.resolveMinObservationMs` validates | — | Phase 15 | none | 19/19 + 17/17 live-DB |
| **I-8** | Formal-verification artefacts present | **GREEN** | `formal/` — 2 `.tla`, 6 `.cfg`, README | — | Phase 15 | none | files exist |
| **I-9** | Runbooks for cutover and rollback | **GREEN** | `docs/runbooks/cutover.md` (391 ln), `rollback.md` (269 ln) | — | Phase 15 | none | files exist |
| **I-10** | Phase 15 test lanes and suites | **GREEN** | 5 Jest projects; 4 `phase15*` suites; 160 suites / 7 162 tests / 0 failures | — | Phase 15 | none | `npm test` exit 0 |
| **I-11** | §17.4 escalation ladder + 3 fairness modules (T1-04) | **SPECIFICATION BLOCKED** | `src/engine/fairness/` **empty**; `preemption.js` absent | **YES** — blocks E1/E2 | REMEDIAL PHASE T1-04 | Complete the remedial phase | Modules exist and are wired |
| **I-12** | `TASK` timer producer | **SPECIFICATION BLOCKED** | `phase15CurrentTree.js` **G1** — 0 TASK-entity timers | **YES** | Frozen-spec owner (**X3**) | §4.2 transition table, or an ADR stating there are none | Spec decision recorded |

---

## B. The §24 release-gate table — the authoritative closure surface

`npm run release:verdict` → exit **1** · **16 GREEN, 1 RED, 7 NOT_EVALUATED** · **RELEASE: BLOCKED — 8 blocking gates are not green.**

### BUILD class

| ID | Gate | Status | Evidence | Blocking? | Owner | Next action |
|---|---|---|---|---|---|---|
| G-01 | `tier_dependencies` §1.8 | **GREEN** | exit 0 `gate:tiers` | — | — | — |
| G-02 | `parameter_register` §22.1 | **GREEN** | exit 0 `gate:params` | — | — | — |
| G-03 | `design_tenets` §1.5 | **GREEN** | exit 0 `gate:tenets` | — | — | — |
| G-04 | `identity_isolation` §23.7 | **GREEN** | exit 0 `gate:privacy` | — | — | — |
| G-05 | `erasure_reconstruction_equivalence` §23.7/§24.3 | **GREEN** | exit 0 `gate:erasure` | — | — | — |
| G-06 | `legacy_removed_from_build` | **GREEN** | exit 0 `gate:legacy` | — | — | — |
| **G-07** | **`engine_decision_path_wired`** | **RED** | **exit 1** `gate:composition` | **YES** | **EXTERNAL — B1** | D1, D3, D8 |

### SUITE class

| ID | Gate | Status | Evidence | Blocking? | Next action |
|---|---|---|---|---|---|
| G-08 | `lower_bound_admissibility` §6.4/§24.1 | **GREEN** | exit 0 | — | — |
| **G-09** | `model_check_capacity_1_2_3` §24.2 | **GREEN ⚠ NOT PROVEN** | exit 0, **with the tool's own `[NOT PROVEN]` annotation**; `tla2tools.jar` absent; suite asserts `exhaustive: false` | **YES — B-M** | Provision `tla2tools.jar`; run TLC exhaustively; then remove `establishedByCommand` |
| G-10 | `determinism_replay` §24.3 | **GREEN** | exit 0 | — | — |
| G-11 | `snapshot_retention` §24.3 | **GREEN** | exit 0 | — | — |
| G-12 | `chaos_capacity_1` §24.5 | **GREEN** | exit 0 | — | — |
| G-13 | `chaos_capacity_2` §24.5 | **GREEN** | exit 0 | — | — |
| G-14 | `cache_tier_flush` §3.3/§24.5/I16 | **GREEN** | exit 0 | — | — |
| G-15 | `scale_targets` §20.1/§24.6 | **GREEN** | exit 0 | — | — |
| G-16 | `locality` §24.6/T9 | **GREEN** | exit 0 | — | — |
| G-17 | `overload_admission_control` §20.5/§24.6 | **GREEN** | exit 0 | — | — |

> **G-09 is counted in the 8 blocking items even though it renders GREEN.** The gate's statement is
> an exhaustive model check; the command that discharges it does not establish that statement, and
> the tool says so in its own output. Treating it as satisfied would be exactly the "false green"
> this programme exists to prevent.

### PRODUCTION class — all NOT_EVALUATED

| ID | Gate | Status | Evidence | Blocking? | Owner | Next action |
|---|---|---|---|---|---|---|
| G-18 | `invariants_enforced` §26 | **NOT EVALUATED** | no observation window filed; OP-8 gap | **YES — B-P** | Operations | Register and derive the §26 invariant-observation window |
| G-19 | `simulator_fidelity` §24.4 | **NOT EVALUATED** | `sim:fidelity` exit 1 — 7 models NOT_MEASURED, 6 safety-relevant | **YES — B-P** | Operations | Supply a fidelity study against realised production data |
| G-20 | `soak` §24.6 | **NOT EVALUATED** | no soak record | **YES — B-P** | Operations | Run the soak (`release.soak_duration` = 72 h, still `PROVISIONAL` — see B8) |
| G-21 | `shadow_agreement` §21.6 | **NOT EVALUATED** | no shadow window; **the shadow worker cannot compose (B1)**, so the 14-day window cannot begin | **YES — B-P, gated by B1** | Operations | B1 first, then run the window |

### ORGANISATIONAL class — all NOT_EVALUATED

| ID | Gate | Status | Evidence | Blocking? | Owner | Next action |
|---|---|---|---|---|---|---|
| G-22 | `calibration_safety_derived` §22.4 | **NOT EVALUATED** | `gate:calibration` exit 1 — 39 findings; 54 Safety-class | **YES — B8** | §22.4 calibration owner | Derive the values; file the attestation |
| G-23 | `safety_case_assembled` §24.7 | **NOT EVALUATED** | `safety:case` exit 0 and every reference resolves — **but the assembler files no evidence** | **YES — B-O** | Release owner | File the safety-case attestation |
| G-24 | `rollback_rehearsed` | **NOT EVALUATED** | no rehearsal recorded | **YES — B-O** | Named operator | Rehearse per `rollback.md` §5 in a declared non-production environment (ADR-34 `REHEARSAL`) |

---

## C. Verification requirements

| ID | Requirement | Status | Evidence | Blocking? | Next action |
|---|---|---|---|---|---|
| V-1 | Full test suite green on the current tree | **GREEN** | `npm test` exit 0 — 160/7 162/0 failures, 2026-08-29 | No | — |
| V-2 | Build gates green (excluding the B1 one) | **GREEN** | 7 of 8 PASS | No | — |
| V-3 | Live-database verification of Phase 15 contracts | **GREEN** | **80/80** across four harnesses on disposable PG 18.3, 2026-08-29 | No | — |
| V-4 | Migration chain applies from empty | **GREEN** | 27/27, 0 failed, 0 rolled back | No | — |
| V-5 | Release evidence bound to the current digest | **GREEN** | 17 records, 0 VOID, 17/17 bound to `431010ace1…` | No | — |
| V-6 | Mutation testing on the current tree | **NOT EVALUATED** | Deliberately not re-run — requires editing source; this consolidation is documentation-only | No | Re-run only as part of an implementation pass |
| V-7 | Exhaustive TLC model checking | **NOT EVALUATED** | `tla2tools.jar` absent — **never run by any pass** | **YES — B-M** | Provision and run |
| V-8 | Production observation windows (soak / shadow / invariants / fidelity) | **NOT EVALUATED** | Require an operating fleet | **YES — B-P** | Operate the fleet. **Never simulate** |
| V-9 | Phase 0–14 cross-phase re-verification | **NOT EVALUATED** | Out of scope here; `npm test` covers the suites, not the per-phase live-DB harnesses | No | Run if the tree changes materially |
| V-10 | `docs/runbooks/rollback.md` procedure executed against the current API | **NOT EVALUATED** | **No pass has ever done it** (P15-F7a exposure) | No — but **UNKNOWN**, not clean | Execute the procedure and record the result |

---

## PHASE 15 CLOSURE RULE

**Phase 15 is NOT closed merely because:**

- tests pass — *160 suites and 7 162 tests are green right now, and 8 gates are still not*;
- build gates pass — *7 of 8 pass; the 8th is the one that matters*;
- implementation exists — *the cutover authority is complete and the release is still blocked*;
- documentation says complete — *this document is not evidence; the gate table is*;
- individual findings are fixed — *every pass has closed its own findings and none has closed the phase*.

**Phase 15 closes only when the authoritative closure conditions are satisfied:** the §24 gate
table — **24 gates, all blocking** — reports 24 GREEN, with `NOT_EVALUATED` counting as blocking
exactly as `RED` does, and with `model_check_capacity_1_2_3` carrying no `[NOT PROVEN]` annotation.

---

## Current verdict, computed from the evidence above

```
§24 gate table (24 gates, all blocking):   16 GREEN · 1 RED · 7 NOT_EVALUATED
Blocking gates not green:                  8
  RED            (1)  engine_decision_path_wired ............ B1
  NOT_EVALUATED  (7)  calibration_safety_derived ............ B8
                      invariants_enforced ................... B-P
                      simulator_fidelity .................... B-P
                      soak .................................. B-P
                      shadow_agreement ...................... B-P (gated by B1)
                      safety_case_assembled ................. B-O
                      rollback_rehearsed .................... B-O
  GREEN-NOT-PROVEN    model_check_capacity_1_2_3 ............ B-M
                      NOT one of the 8 above. The tool counts it GREEN, so it
                      does not appear in "8 blocking gates not green". It is
                      listed here so a reader does not mistake GREEN for a
                      discharge: the gate's statement is an exhaustive model
                      check, and TLC has never been run.

Open blockers (programme count):        8   — B1, B8, B-P, B-O, B-M, X3, X1/T1-04, A9
Repository-owned AND actionable:        0   — A9 is repository-owned but deferred to Phase 8
```

> **The two 8s are not the same 8.** "8 blocking gates not green" counts §24 gate rows; "8 open
> blockers" counts programme blockers. B-P is one blocker covering four gate rows; X3, X1/T1-04 and
> A9 are blockers that are not §24 gates at all. They coincide by arithmetic accident.

# FINAL CURRENT VERDICT
# PHASE 15 IMPLEMENTATION: CLOSED
# PHASE 15 RELEASE: BLOCKED
# PHASE 16: NOT READY

**Phase 15's implementation obligations are discharged.** What remains open is **not code**. B1, B8,
B-P, B-O and B-M each require a decision, a measurement, an attestation or a compute run that no
commit in this repository can supply; X3 requires a specification decision; T1-04 is a separate
remedial phase.

**This verdict was computed from the gate table, not asserted.** Do not alter it to make the
documentation look complete. If the repository changes, re-run `npm run release:verdict` and
recompute — the digest in the header is how you know whether these numbers still apply.

**"In-repository defects: none remaining" is not claimed here, and on the evidence of six passes it
should stop being claimed at all.** Each pass has found defects on the surface the previous pass's
fix created.

---

**TRUTH > GREEN.**
