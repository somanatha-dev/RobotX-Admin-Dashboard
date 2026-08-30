# Phase 15 — Closure Checklist

**The exact exit conditions, and the current verdict computed from them.**

> Current source of truth for navigation: **[`PHASE_15_MASTER.md`](PHASE_15_MASTER.md)**.
> Evidence: **[`PHASE_15_VERIFICATION_STATE.md`](PHASE_15_VERIFICATION_STATE.md)** ·
> Blockers: **[`PHASE_15_BLOCKERS.md`](PHASE_15_BLOCKERS.md)**

**Current tree (re-measured 2026-08-30):** digest `d033038cb261c3de…` (**573 files**) · **HEAD:**
`67b7c7c` + uncommitted T1-04 / `Leg.slaDeadline` / V-10 work
**Originally assessed:** 2026-08-29 · **Tree:** digest `431010ace188c4b1…` (565 files) · **HEAD:** `b68dc5d` — **superseded**
**Re-assessed:** 2026-08-29 by the documentation-integrity audit. Every command below was
re-executed and every exit code re-observed on the same digest. **The verdict did not change.**
One row (**I-5**) was made more precise; no status moved.

**Re-assessed again 2026-08-30** — closure item **V-10** · **Tree:** digest
`d033038cb261c3de…` (**573 files**) · HEAD `67b7c7c` + uncommitted T1-04, `Leg.slaDeadline` and
V-10 work. **§B — the §24 gate table — is unchanged in substance and the verdict is unchanged.**
Three rows in §C moved: **V-10 GREEN** (executed for the first time; five defects found and
fixed), **V-6 PARTIAL** (three mutants, three killed) and **V-5 RED** — the checked-in evidence
collection has aged past every gate's `maxAgeMs`, so `release:verdict` now reports 0 green /
17 red / 7 not evaluated. **That is staleness, not a gate failing**, it moves no blocker, and it
is the release owner's re-collection to run. Full detail: `PHASE_15_VERIFICATION_STATE.md` §3.0.

**Re-assessed a third time 2026-08-30 — the post-V-10 current-state audit.** Tree re-measured
live: digest `d033038c…` (**573 files**), HEAD `67b7c7c`, **19** registered workers, **28**
migrations, `npm run gates` exit 1 (7 PASS / 1 FAIL), `release:verdict` exit 1 (0/17/7).
**No status in §A, §B or §C moved, no blocker moved, and the verdict is unchanged.** What the
audit found was **stale documentation, not a new defect**: several rows here still carried the
pre-T1-04 tree's numbers (`18` workers, `11` starting, `340` legacy-corpus files, `160`/`7 162`
tests), one row asserted the checked-in evidence collection as current when §C V-5 says it has
aged out, and the migration count was recorded as **29** when 27 + T1-04's one is **28**. All are
corrected in place below and marked with what they used to say.

**Statuses:** `GREEN` · `RED` · `NOT EVALUATED` · `EXTERNAL BLOCKED` · `SPECIFICATION BLOCKED`

---

## A. Implementation requirements

| ID | Requirement | Status | Evidence | Blocking? | Owner | Required next action | Closure evidence |
|---|---|---|---|---|---|---|---|
| **I-1** | §24 release-gate table implemented (24 gates, all blocking) | **GREEN** | `src/engine/cutover/gates.js`; `release:verdict` renders all 24 | — | Phase 15 | none | Gate table renders |
| **I-2** | §22.4 staging discipline / cutover authority implemented | **GREEN** | `src/engine/cutover/` (10 modules); `stage.authoriseEnable` refuses automated enable; `assertOneDirectional` admits only `DISABLE` | — | Phase 15 | none | 19/19 `phase15VersionInForce.js` |
| **I-3** | Legacy decision path **removed from the build**, not bypassed | **GREEN** | `gate:legacy` PASS — 4 modules absent and unimported across **346** files, re-run 2026-08-30 *(340 on 2026-08-29 — the corpus grew; the load-bearing number is **4 absent**)* | — | Phase 15 | none | exit 0 |
| **I-4** | Evidence machinery: source digest, collection, verdict | **GREEN — the *machinery*, not the collection** | `tools/release/` ×3 all present and working: `sourceDigest()` re-derives the tree, `verdict.js` renders 24 gates and **correctly refused the checked-in collection as `[STALE]`**. **The collection itself is NOT current evidence** — 17 records bound to the superseded `431010ace1…`; see §C **V-5**. *(This row previously cited "17/17 bound to `431010ace1…`" and "Digest match verified" as its evidence, which stopped being true when T1-04 moved the digest.)* | — | Phase 15 | none | The machinery detecting its own staleness **is** the evidence here |
| **I-5** | All engine workers moved to production scheduling | **RED** | `gate:composition` exit 1 — **1 of 19** (`coordinator`) `LEADER_ONLY_NOT_COMPOSABLE`, re-run 2026-08-30. **12 of 19 workers actually start**; 6 are `DEFERRED` with declared blockers, which the gate accepts by design — see the note below. *(Was "1 of 18" / "11 of 18" — the pre-T1-04 tree)* | **YES** | **EXTERNAL — B1** | D1 + D3 + D8, then B1 Steps 1/3/4/5 | `gate:composition` exit 0 |

> **I-5's plain English and its gate are not the same test, and the difference is deliberate.**
> "All engine workers moved to production scheduling" reads as 19 of 19. `gate:composition` fails
> only on an **undeclared** gap: `assertRegistry()` forces every `DEFERRED` row to name a
> `blockedBy`, and a declared, reasoned deferral passes. So the gate is satisfied at **12 of 19
> running**, and I-5 turns GREEN when `coordinator` composes — not when all 19 start.
>
> This is not a loophole; a worker that must not run until Phase 16a (`capacity_pricing`) or until
> the fleet produces data (`energy_calibration`, `service_time_model`) cannot be a Phase 15 exit
> condition. **But it does mean I-5 GREEN will not mean "all 19 workers run."** The six deferrals
> and their owners are enumerated in
> [`PHASE_15_IMPLEMENTATION_STATE.md`](PHASE_15_IMPLEMENTATION_STATE.md); two of them
> (`shadow`, `charger_reachability`) are released by B1 alongside `coordinator`, one by B8, one by
> Phase 16a, and two by fleet data or missing classifiers. **None is separately tracked as a
> blocker, and none is hidden.**
| **I-6** | Rollback publisher + configuration propagation implemented | **GREEN** | `rollbackPublisher.js`, `configPropagation.js`, wired at `server.js`; P15-R1/R2/E2 fixed | — | Phase 15 | none | 80/80 live-DB |
| **I-7** | Observation-window authority resolves bounds from the register and refuses a caller who states one | **GREEN** | P15-E1/E4/F1 fixed; `evidence.resolveMinObservationMs` validates | — | Phase 15 | none | 19/19 + 17/17 live-DB |
| **I-8** | Formal-verification artefacts present | **GREEN** | `formal/` — 2 `.tla`, 6 `.cfg`, README | — | Phase 15 | none | files exist |
| **I-9** | Runbooks for cutover and rollback | **GREEN** | `docs/runbooks/cutover.md`, `rollback.md`. **Both traced against the current API on 2026-08-30 (V-10); 5 defects fixed, one permissive and fleet-wide.** "Files exist" was never the requirement and is no longer the evidence | — | Phase 15 | none | V-10: 15/15 live-DB, 7 tests, 3 mutants killed |
| **I-10** | Phase 15 test lanes and suites | **GREEN** | 5 Jest projects; **5** `phase15*` suites (V-10 added `phase15RollbackRunbook.test.js`); **162 suites / 7 275 tests / 0 failures**, re-run 2026-08-30 at digest `d033038c…` *(this row still said 160 / 7 162 while **V-1** below said 162 / 7 275 — the two now agree)* | — | Phase 15 | none | `npm test` exit 0 |
| **I-11** | §17.4 escalation ladder + 3 fairness modules (T1-04) | **GREEN** | `ladder.js`, `operatorCapacity.js`, `agentStarvation.js` present; composed at `leaderWorkers.timer` → `expiryActions` → `ESCALATION_LADDER`, and at `server.js` → `fairness.worker`; `task.service.admitToRound` now arms the `QUEUED` deadline that triggers it, and writes `Leg.slaDeadline` in the same transaction so §17.4's third triage key (SLA breach proximity) is no longer inert | No — **T1-04 no longer blocks E1/E2**; they remain blocked by B1 | REMEDIAL PHASE T1-04 — **ran 2026-08-30**; `Leg.slaDeadline` producer added **2026-08-30** | none | 93 + 7 unit + **72/72 live-DB** (`npm run verify:t104`) |
| **I-12** | `TASK` timer producer | **SPECIFICATION BLOCKED** | `phase15CurrentTree.js` **G1** — 0 TASK-entity timers | **YES** | Frozen-spec owner (**X3**) | §4.2 transition table, or an ADR stating there are none | Spec decision recorded |

---

## B. The §24 release-gate table — the authoritative closure surface

**The statuses in this section are each gate's standing on its own merits — the reading taken on
2026-08-29, when the evidence collection was current:**
`npm run release:verdict` → exit **1** · **16 GREEN, 1 RED, 7 NOT_EVALUATED** · **RELEASE: BLOCKED — 8 blocking gates are not green.**

> **Currency, re-confirmed 2026-08-30 — read this before quoting the line above.** The checked-in
> collection has since aged out, so **the tool's actual output today is `0 green, 17 red, 7 not
> evaluated`, exit 1**, with every extra RED marked `[STALE]` rather than failing. **No gate was
> weakened and no gate's own standing changed** — which is why this table is kept on the merits
> reading — but *"16 GREEN"* is a historical figure and must not be presented as the current
> verdict. §C **V-5** owns that fact. **BLOCKED either way.**

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
| **G-09** | `model_check_capacity_1_2_3` §24.2 | **GREEN ⚠ NOT PROVEN** | exit 0, **with the tool's own `[NOT PROVEN]` annotation**; `tla2tools.jar` absent; suite asserts `exhaustive: false` | **YES — B-M** | Provision `tla2tools.jar`; run TLC exhaustively; record the run's provenance and obtain release-owner acceptance (`B1_EXTERNAL_INPUT_HANDOFF.md` §7.3a, §7.6); **then** remove `establishedByCommand`. **The row's status does not move on discharge — it is GREEN before and after — so this gate cannot be used to track B-M** |
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
| V-1 | Full test suite green on the current tree | **GREEN** | `npm test` exit 0 — **162 suites / 7 275 tests / 0 failures**, 2026-08-30 at digest `d033038c…` | No | — |
| V-2 | Build gates green (excluding the B1 one) | **GREEN** | 7 of 8 PASS, **re-run 2026-08-30 after V-10**: `gate:tiers` 289 modules / 432 edges · `gate:params` 192 / 250 · `gate:tenets` 286 · `gate:privacy` 16 · `gate:erasure` 3 · `gate:legacy` 346 files · `gate:columngen` NOT_REQUIRED. `gate:composition` FAIL — **1 violation across 19 registered workers** (18 before T1-04's `fairness.worker`) | No | — |
| V-3 | Live-database verification of Phase 15 contracts | **GREEN** | **167/167** across six harnesses on disposable PG 18.3 — the four Phase 15 (80), T1-04 (72), **V-10 (15)** | No | — |
| V-4 | Migration chain applies from empty | **GREEN** | **28/28**, 0 failed, 0 rolled back (27 + T1-04's `LadderEscalation`, re-applied 2026-08-30 for V-10). *(Recorded as "29/29" until 2026-08-30. **The chain and the result are unchanged — only the count was wrong**: 27 + 1 = 28, and a direct re-count on 2026-08-30 returns 28 migration directories and 28 `migration.sql` files.)* | No | — |
| **V-5** | Release evidence bound to the current digest | **RED — the collection has aged out** | The checked-in collection is bound to `431010ace1…` and produced `2026-08-29T06:28:45Z`; the tree is now `d033038c…` and every record is **`[STALE]`** (~126 000 s against an 86 400 s bound). `release:verdict` → **0 green, 17 red, 7 not evaluated** | **No — it changes no blocker.** The verdict was BLOCKED and still is; every RED is staleness, not a gate failing | **Release owner: run `npm run release:gates` at a quiescent, committed tree.** Not done here — it is a ~25-min collection that the next source edit would void, and the working tree is uncommitted |
| V-6 | Mutation testing on the current tree | **PARTIAL** | **V-10's three mutants: 3 built, 3 killed**, tree restored and the restoration byte-verified (`PHASE_15_VERIFICATION_STATE.md` §7a). The rest of the tree is unmeasured | No | Re-run per implementation pass, as V-10 did |
| V-7 | Exhaustive TLC model checking | **NOT EVALUATED** — B-M evidence state **NOT MEASURED / OPEN** | `tla2tools.jar` absent, so not runnable here. `lifecycle.tla` never run under TLC at any capacity; two `commitment.tla` runs recorded 2026-08-15 (TLA+ 1.8.0) against a different tree — historical, not a discharge | **YES — B-M** | Provision, run all six as checked in, **record the provenance** (`B1_EXTERNAL_INPUT_HANDOFF.md` §7.3a), release owner accepts (§7.6) |
| V-8 | Production observation windows (soak / shadow / invariants / fidelity) | **NOT EVALUATED** | Require an operating fleet | **YES — B-P** | Operate the fleet. **Never simulate** |
| **V-9** | Phase 0–14 cross-phase re-verification | **NOT EVALUATED — and its trigger HAS FIRED** | `npm test` covers the suites, not the per-phase live-DB harnesses. **The trigger below is satisfied on this tree:** T1-04 and the `Leg.slaDeadline` producer changed `src/engine/supervision/expiryActions.js` (+153 — `attemptTransition` gained `deadlineSecondsOverride`, `escalationLadder` gained four verdicts), `src/workers/leaderWorkers.js` (+68), `src/services/task.service.js` (+187), `src/engine/observability/metrics.js` (+123), `prisma/schema.prisma` (+103) and added migration 28. **`tools/verify/phase5ExpirySemantics.js` requires the first two of those modules directly** (`:28`, `:31`) and has not been re-run. The archived claim this row rested on — *"Phases 0–14, schema and migration history untouched"* — is false on this tree | No | **REPOSITORY-OWNED AND ACTIONABLE — unrun, result UNKNOWN.** Run the harnesses whose subjects moved (Phase 5; the Phase 9 / 12–13 harnesses over the intake path and the SLIs) on a disposable cluster. **Not all of 0–14**, and **not a blocker**: it moves no gate and not the verdict *(this row previously read only "Run if the tree changes materially", and the verdict block below asserted V-9 "has no trigger" — corrected by the final closure audit, 2026-08-30)* |
| **V-10** | `docs/runbooks/rollback.md` procedure executed against the current API | **GREEN — executed 2026-08-30** | Traced §0–§6 against the current API; **5 defects found and fixed**, one permissive and fleet-wide. 7 tests, 3 mutants/3 killed, **15/15 on live PostgreSQL** (`npm run verify:v10`). Full record: `PHASE_15_BLOCKERS.md` § **V-10** | No | none. **The structural exposure it sat on — P15-F7a, nothing binds a runbook to its API — is unchanged and still open**; `rollback.md` §7 now records the date of the last trace |

---

## PHASE 15 CLOSURE RULE

**Phase 15 is NOT closed merely because:**

- tests pass — *162 suites and 7 275 tests are green right now, and 8 gates are still not*;
- build gates pass — *7 of 8 pass; the 8th is the one that matters*;
- **a runbook exists** — *V-10 traced one on 2026-08-30 and found five defects in it, the worst of which would have reverted the fleet's configuration during an incident. Two files "existing" was the evidence I-9 had carried since Phase 15 began*;
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
                      B-M evidence state: NOT MEASURED / OPEN.
                      NOT one of the 8 above. The tool counts it GREEN, so it
                      does not appear in "8 blocking gates not green". It is
                      listed here so a reader does not mistake GREEN for a
                      discharge: the gate's statement is an exhaustive model
                      check, and TLC has never been run.

Open blockers (programme count):        7   — B1, B8, B-P, B-O, B-M, X3, A9
                                            was 8; X1/T1-04 CLOSED 2026-08-30
Repository-owned AND actionable
  BLOCKERS:                             0   — A9 is repository-owned but deferred to Phase 8.
                                            No blocker is repository-owned and actionable.
  IMPLEMENTATION DEFECTS:               0   — none found by the final closure audit.
  VERIFICATION ROWS:                    1   — V-9. NOT external, NOT a blocker, NOT code.
                                            Its trigger ("the tree changes materially") is
                                            SATISFIED: T1-04 changed expiryActions.js,
                                            leaderWorkers.js, task.service.js, metrics.js,
                                            schema.prisma and added migration 28, and
                                            tools/verify/phase5ExpirySemantics.js requires
                                            two of those modules directly. Unrun; result
                                            UNKNOWN. It moves no gate and not the verdict.
                                            (This block previously read "Repository-owned
                                            AND actionable: 0 … V-9 has no trigger" and
                                            claimed §C held NO row this repository can
                                            close by itself. Corrected by the final
                                            closure audit, 2026-08-30.)
                                            V-10 was the previous such row and it CLOSED
                                            2026-08-30. It was never a blocker and closing
                                            it moved no gate — which is the third time in
                                            three passes that the next genuine item was
                                            not in the blocker table at all. V-9 is the
                                            fourth. V-5 is the release owner's evidence
                                            re-collection, V-7 is B-M (jar + compute),
                                            V-8 is B-P (operating fleet), V-6 has no pass
                                            to attach to. Re-derive this; do not inherit it.

Evidence currency (measured 2026-08-30):    docs/release-evidence.json is STALE and bound to
                                            a superseded digest, so release:verdict reads
                                            0 green / 17 red / 7 not evaluated. Every RED is
                                            [STALE], not a gate failing. Re-collection is the
                                            release owner's step at a committed tree. THE
                                            VERDICT IS UNCHANGED: BLOCKED.
```

> **The two counts used to both be 8 and no longer are.** "8 blocking gates not green" counts §24
> gate rows and is **unchanged**; "7 open blockers" counts programme blockers. Closing X1/T1-04
> moved the second and not the first, because T1-04 was never a §24 gate row — which is the
> clearest demonstration available that the two counts were never in correspondence. B-P is one
> blocker covering four gate rows; X3 and A9 are blockers that are not §24 gates at all.

# FINAL CURRENT VERDICT
# PHASE 15 IMPLEMENTATION: CLOSED
# PHASE 15 RELEASE: BLOCKED
# PHASE 16: NOT READY

**Phase 15's implementation obligations are discharged.** What remains open is **not code**. B1, B8,
B-P, B-O and B-M each require a decision, a measurement, an attestation or a compute run that no
commit in this repository can supply; X3 requires a specification decision. **T1-04 was the last
open item that *was* code, and it ran on 2026-08-30** — §17.4's ladder, its human capacity model
and §17.5's detection are implemented, composed into the production path, and verified against a
live database. The release verdict is unchanged by it, because T1-04 was never a §24 gate.

**This verdict was computed from the gate table, not asserted.** Do not alter it to make the
documentation look complete. If the repository changes, re-run `npm run release:verdict` and
recompute — the digest in the header is how you know whether these numbers still apply.

**"In-repository defects: none remaining" is not claimed here, and on the evidence of six passes it
should stop being claimed at all.** Each pass has found defects on the surface the previous pass's
fix created.

---

**TRUTH > GREEN.**
