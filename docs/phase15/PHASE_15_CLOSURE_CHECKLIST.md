# Phase 15 — Closure Checklist

**The exact exit conditions, and the current verdict computed from them.**

> Current source of truth for navigation: **[`PHASE_15_MASTER.md`](PHASE_15_MASTER.md)**.
> Evidence: **[`PHASE_15_VERIFICATION_STATE.md`](PHASE_15_VERIFICATION_STATE.md)** ·
> Blockers: **[`PHASE_15_BLOCKERS.md`](PHASE_15_BLOCKERS.md)**

**Current tree (measured live 2026-09-01):** digest **`4d94ef18e52b5953…` (574 files)** ·
**HEAD:** **`9e1d871`** + the V1 audit's source edits — *`d033038cb261c3de…` / 573 is **superseded**.
It held from 2026-08-30 through four commits (`ef0d65f`, `22411e8`, `09e91a5`, `9e1d871`), every one
of which touches only `docs/` and `formal/`, and was then moved by the **V1 audit**: the I20
search-gap-provenance fix (`solve/round.js`, `observability/metrics.js`,
`workers/coordinator.worker.js`) and the N13 registry correction (`workers/registry.js`), plus one
new test file. **§A and §B did not move, no gate changed, and the verdict is unchanged.** (This
header said HEAD `7335260`, and before that "uncommitted at `67b7c7c`"; it also said "the only
modified paths are the five canonical documents themselves", which was true of `docs/` and quietly
untrue of `formal/`, where the X7 fix sat uncommitted.)*

**Re-assessed a fourth time 2026-08-30 — closure item V-9**, the Phase 0–14 cross-phase
re-verification. **Executed for the first time. §A and §B did not move and the verdict is
unchanged.** One row in §C moved: **V-9 GREEN**. 7 Phase 0–14 harnesses on a disposable
PostgreSQL 18.3 cluster, **315 / 317 checks**, both failures being `phase5ExpirySemantics`
FINDING assertions whose premise T1-04 deliberately invalidated. **No regression, no code
changed, digest unmoved.** Full record: `PHASE_15_VERIFICATION_STATE.md` §7c.
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
| **I-10** | Phase 15 test lanes and suites | **GREEN** | 5 Jest projects; **5** `phase15*` suites (V-10 added `phase15RollbackRunbook.test.js`); **163 suites / 7 291 tests / 0 failures**, re-run **2026-09-01** at digest `4d94ef18…` *(was 162 / 7 275 at `d033038c…`, and before that this row said 160 / 7 162 while **V-1** said 162 / 7 275 — the two have agreed since and still do)* | — | Phase 15 | none | `npm test` exit 0 |
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
| **G-09** | `model_check_capacity_1_2_3` §24.2 | **GREEN ⚠ NOT PROVEN** — **unchanged by the 2026-08-31 TLC runs, exactly as predicted** | exit 0, **with the tool's own `[NOT PROVEN]` annotation**; suite asserts `exhaustive: false`. **TLC was run on 2026-08-31 (all six configs): 1 closed, 2 UNKNOWN, 3 FAILED** — and **this row did not move**, because it never depended on TLC. `tla2tools.jar` remains absent *from the repository* (it was provisioned outside the tree) | **YES — B-M**, and the runs additionally opened **X4** and **X5** (neither is a gate row, so the blocking-gate count is unchanged) | Obtain compute on which `commitment_c2/c3` converge; resolve **X5** so the lifecycle configs can evaluate anything at all; resolve **X4**; record provenance and obtain release-owner acceptance (`B1_EXTERNAL_INPUT_HANDOFF.md` §7.3a, §7.6); **then** remove `establishedByCommand`. **The row's status does not move on discharge — it is GREEN before and after — so this gate cannot be used to track B-M.** The 2026-08-31 runs are the proof of that: six configurations were executed, three failed, and **not one character of this row changed** |
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
| V-1 | Full test suite green on the current tree | **GREEN** | `npm test` exit 0 — **163 suites / 7 291 tests / 0 failures**, **2026-09-01 at digest `4d94ef18…`** *(was 162 / 7 275 at `d033038c…`; the V1 audit's I20 and N13 work added a suite and 16 net tests)* | No | — |
| V-2 | Build gates green (excluding the B1 one) | **GREEN** | 7 of 8 PASS, **re-run 2026-08-30 after V-10**: `gate:tiers` 289 modules / 432 edges · `gate:params` 192 / 250 · `gate:tenets` 286 · `gate:privacy` 16 · `gate:erasure` 3 · `gate:legacy` 346 files · `gate:columngen` NOT_REQUIRED. `gate:composition` FAIL — **1 violation across 19 registered workers** (18 before T1-04's `fairness.worker`) | No | — |
| V-3 | Live-database verification of Phase 15 contracts | **GREEN** | **167/167** across six harnesses on disposable PG 18.3 — the four Phase 15 (80), T1-04 (72), **V-10 (15)** | No | — |
| V-4 | Migration chain applies from empty | **GREEN** | **28/28**, 0 failed, 0 rolled back (27 + T1-04's `LadderEscalation`, re-applied 2026-08-30 for V-10). *(Recorded as "29/29" until 2026-08-30. **The chain and the result are unchanged — only the count was wrong**: 27 + 1 = 28, and a direct re-count on 2026-08-30 returns 28 migration directories and 28 `migration.sql` files.)* | No | — |
| **V-5** | Release evidence bound to the current digest | **RED — the collection has aged out, and is now two digests behind** | The checked-in collection is bound to `431010ace1…` and produced `2026-08-29T06:28:45Z`; the tree is now **`4d94ef18…`** *(via `d033038c…`)* and every record is **`[STALE]`** (~126 000 s against an 86 400 s bound, and growing). `release:verdict` → **0 green, 17 red, 7 not evaluated**. *(The V1 audit's digest move makes the binding staler and changes nothing else: the records were already stale on wall-clock alone, and the verdict was already BLOCKED.)* | **No — it changes no blocker.** The verdict was BLOCKED and still is; every RED is staleness, not a gate failing | **Release owner: run `npm run release:gates` at a quiescent, committed tree.** Not done here, and **not by any subsequent pass** — it is a ~25-min collection, it is the release owner's step rather than a documentation act, and **the verdict is BLOCKED either way**: re-collecting changes the rendering, not the outcome. *(This cell also gave "the working tree is uncommitted" as a reason. **That premise expired** when the snapshot `7335260` was committed before V-9 — corrected 2026-08-31 by the freeze audit. **The conclusion is unchanged, and a committed tree is not an instruction to collect**: `engine_decision_path_wired` is RED on its own merits and the 7 `NOT_EVALUATED` rows have nothing filed, so a fresh collection would render 16/1/7 and still read BLOCKED.)* |
| V-6 | Mutation testing on the current tree | **PARTIAL** | **V-10's three mutants: 3 built, 3 killed**, tree restored and the restoration byte-verified (`PHASE_15_VERIFICATION_STATE.md` §7a). **Plus the X4/X5 pass's four MODEL mutants on 2026-08-31: 4 built, 4 killed**, scratch copy restored and byte-verified against the repository file (§7e.5) — M1 (revert only the X4 widening) reproduced the original depth-9 counterexample and M2 (remove only `TaskQuiescent`) restored the deadlock, which is what proves each change is load-bearing for its own finding. **Plus the X6 pass's SEVEN model mutants later on 2026-08-31: 7 built, 7 killed** (§7f.5) — M3/M5/M7 attack the ladder transition, its terminal state and its advance; **M4** (drop the `QUEUED` guard from `LadderExhausted`) is a *safety* kill, `Action property TerminalIsFinal is violated`; **M6** (`SF`→`WF`) survives the `QueuedLegsProgress` oracle and is killed under the X7-isolated `Liveness` oracle, **recorded as a survival rather than presented as a kill**; and **M1 and M2 were re-run against the new module and both still kill**, so X4's widening and X5's `TaskQuiescent` are still load-bearing after the X6 change. **Plus the X7 pass's ONE model mutant on 2026-09-01: 1 built, 1 killed** (§7g.5) — the minimal X7 mutation removes **only** the two new latch-*guard* conjuncts, leaving the variable, its `Init`, its writes and all 31 `UNCHANGED` tuples intact, and TLC returns exit **13** with `Liveness` violated and the `CancelWithCustody ↔ Strand` lasso restored — which is what proves the §4.6 latch *guard*, not the bookkeeping around it, is the load-bearing part of the X7 fix. **The mutant was built in a scratch copy and the repository was not modified for it.** The rest of the tree is unmeasured | No | Re-run per implementation pass, as V-10, the X4/X5 pass, the X6 pass and the X7 pass did |
| **V-7** | Exhaustive TLC model checking | **RED — EXECUTED 2026-08-31 and NOT SATISFIED.** B-M evidence state remains **NOT MEASURED / OPEN**. *(Was "NOT EVALUATED"; it has now been evaluated, and it did not pass)* | **All six checked-in configurations were run** on the frozen tree with TLA+ v1.8.0 (SHA-256 `eabd140a…533a`), JDK 20.0.2, on a 16 GB i5-1235U workstation. **1 closed** — `commitment_c1.cfg` exhaustive, 17 991 520 states / 2 375 660 distinct / diameter 21, no error. **2 UNKNOWN** — `commitment_c2/c3` did not converge (126 M and 21 M states left on queue; 23.6 GiB disk queue still growing on `c2`, whose machine also slept mid-run). ~~**3 FAIL** — `lifecycle_c1/c2/c3` all abort on TLC's default deadlock check at depth 6~~ **— SUPERSEDED by the X4/X5 decision pass later on 2026-08-31.** After the model change: **`lifecycle_c1` CLOSES** (8 030 states / 1 909 distinct / depth 27 / 0 on queue) with `Safety` **PASS** and `TerminalIsFinal` **PASS**; **all three still FAIL, now on `Liveness`** (**X6**), and `c2`/`c3` stop on that error with states still queued so their `Safety` result is partial, not exhaustive. **2 of 6 now closed, was 1.** §7.3a items 4 (named operator), 8 (boundedness) and 10 (acceptance) are **all still unsatisfied**, and **G5 is still covered by no TLC run**. **— SUPERSEDED AGAIN by the X6 pass, third pass of 2026-08-31.** X6 was classified as a **transcription defect** (§4.4's two `QUEUED` rows were never transcribed, and `WF_vars(Next)` does not transcribe §24.2's "given fair timer firing") and fixed in `formal/lifecycle.tla` only. After that change: **`QueuedLegsProgress` PASSES on a complete state graph at capacity 1** — 676 854 states / 156 941 distinct / depth 43 / **0 on queue**, with `Safety` and `TerminalIsFinal` also passing — **the first passing lifecycle liveness verdict this project has produced**; `EveryLegSettles` (174 320 / 39 036) and `CustodyNeverLost` (159 731 / 35 834) **still FAIL**, on the new blocker **X7** and on nothing else, proven by an isolation diagnostic in which blocking one edge makes every declared property pass exhaustively (662 454 / 156 941 / depth 43 / 0 queued). **Run as checked in: `c1` and `c2` report `Liveness` violated and are partial searches; `c3` reached NO VERDICT at all** — it did not converge and was interrupted at a stated budget after ≈54 min (16 247 475 / 2 388 556 / depth 15 / 1 014 936 on queue, no violation reported), so **`c3` is UNKNOWN, not FAIL**. `lifecycle_c1` therefore **no longer closes as checked in** — **authoritative closures are back to 1 of 6**. The non-convergence is arithmetic: `ladder` multiplies the space by up to `(LadderSteps+1)^|Legs|` (81× / 729× / 6 561×), confirmed at capacity 1 (1 909 → 156 941 = 82.2×), and **neither `MaxTicks` nor `LadderSteps` was reduced to make it converge**. Full record with raw output retained verbatim: [`PHASE_15_BM_TLC_RUN_RECORD.md`](PHASE_15_BM_TLC_RUN_RECORD.md) **§15 and §16**; **— SUPERSEDED AGAIN by the X7 pass, 2026-09-01 (fourth pass).** X7 was **reclassified from SPECIFICATION AMBIGUITY to TRANSCRIPTION DEFECT** — §4.6's `cancel_requested_at` latch was never modelled, making `Cancel`/`CancelWithCustody` indefinitely repeatable against the same Leg — and fixed in `formal/lifecycle.tla` only. **`lifecycle_c1`, run AS CHECKED IN, now CLOSES: 777 942 states / 187 289 distinct / depth 43 / 0 on queue, exit 0, with `Safety`, `TerminalIsFinal` and `Liveness` (ALL THREE conjuncts, including the two that defined X7) PASSING** — reproducing the controlled experiment's D5 result exactly; the X7 mutant is **KILLED**. **Authoritative closures are now 2 of 6, was 1.** `lifecycle_c2`/`c3` were **not run by this pass** and still require authoritative treatment; `commitment_c2`/`c3` remain **UNKNOWN, deliberately unaffected and not re-run**. §7.3a items 4, 8 and 10 are **still unsatisfied** and **G5 is still covered by no TLC run**. **B-M IS STILL OPEN — do not report "X7 fixed = B-M closed".** Records: §15, §16 and **§17**; summary at `PHASE_15_VERIFICATION_STATE.md` **§7d, §7e, §7f and §7g** | **YES — B-M** *(X4, X5, X6 **and X7** are all decided/closed and implemented; **B-M is now blocked on COMPUTE and ACCEPTANCE, not on any open model defect**)* | **Compute/Platform** supply compute on which `commitment_c2/c3` converge — this workstation could not, and they were **not re-run** by either later pass, deliberately: `commitment.tla` neither `EXTENDS` nor `INSTANCE`s `lifecycle.tla`, so no commitment result can be affected. ~~**Decide X7**~~ — **DONE 2026-09-01**: X7 needed no such decision. It was a **transcription defect** (the missing §4.6 cancellation latch) and the lifecycle half now **passes at capacity 1**. **Question A** — whether `STRANDED_*` is cancellable at all — survives as a **non-blocking** modelling question. **What the lifecycle half still needs is COMPUTE for `c2`/`c3`, not a decision.** Accept boundedness (§7.3a item 8), name an operator, give **final acceptance** (§7.6). **Do not treat "TLC was provisioned" as progress against the compute requirement, and do not treat "X4, X5, X6 and X7 are resolved" as progress against it either** — **two commitment configurations are still UNKNOWN and two lifecycle configurations still need authoritative treatment** |
| V-8 | Production observation windows (soak / shadow / invariants / fidelity) | **NOT EVALUATED** | Require an operating fleet | **YES — B-P** | Operate the fleet. **Never simulate** |
| **V-9** | Phase 0–14 cross-phase re-verification | **GREEN — executed 2026-08-30. CLOSED / VERIFIED** | **Scope derived, not asserted:** the transitive `require()` closure of all **22** Phase 0–14 harnesses was intersected with the **11** changed application-source files. **4 harnesses carry a changed module in their closure** (`phase5ExpirySemantics` 5, `phase9ProductionPath` 5, `phase14LiveDatabase` 3, `phase11LiveDatabase` 1); the other 18 carry **zero**. **7 harnesses executed** on disposable PostgreSQL 18.3 (port 55437, 28/28 migrations from empty, destroyed after use): **315 / 317 checks passed**. The **2 failures are both `phase5ExpirySemantics` FINDING assertions whose premise T1-04 deliberately invalidated** — they assert the ladder does *not* exist — and **neither is a regression**: proven by isolating the single variable (`stepTableFrom(harness VALUES)` → `ok=false`; the same map **plus the 8 register-published rung fractions** → `ok=true`, 8 strictly increasing rungs), and corroborated by `verify:t104` **72/72** live. **No regression found. No code changed** — digest still `d033038c…` / 573, working tree clean. Full record: `PHASE_15_VERIFICATION_STATE.md` **§7c** | No | **none — CLOSED.** *(This row previously read "NOT EVALUATED — and its trigger HAS FIRED … unrun, result UNKNOWN". The trigger did fire; the answer is now measured.)* V-9 surfaced one **incidental, pre-existing, out-of-scope** defect — `prisma/seed.js` silently partial-seeds and exits 0 — registered as residual observation **8** in `PHASE_15_BLOCKERS.md`. It is **not** a Phase 15 item and moves no gate |
| **V-10** | `docs/runbooks/rollback.md` procedure executed against the current API | **GREEN — executed 2026-08-30** | Traced §0–§6 against the current API; **5 defects found and fixed**, one permissive and fleet-wide. 7 tests, 3 mutants/3 killed, **15/15 on live PostgreSQL** (`npm run verify:v10`). Full record: `PHASE_15_BLOCKERS.md` § **V-10** | No | none. **The structural exposure it sat on — P15-F7a, nothing binds a runbook to its API — is unchanged and still open**; `rollback.md` §7 now records the date of the last trace |

---

## PHASE 15 CLOSURE RULE

**Phase 15 is NOT closed merely because:**

- tests pass — *163 suites and 7 291 tests are green right now, and 8 gates are still not*;
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
                      check, and only 1 of the 6 checked-in configurations
                      has ever completed one.
                      UPDATED 2026-08-31: TLC HAS now been run -- all six
                      configurations, on the frozen tree. 1 closed (PASS),
                      2 did not converge (UNKNOWN), 3 FAILED. The gate row
                      is UNCHANGED by that: it was GREEN [NOT PROVEN] before
                      and is GREEN [NOT PROVEN] after, exactly as the handoff
                      SS7.0 warned it would be. Do not track B-M here.
                      The runs opened two NEW blockers, X4 and X5, neither of
                      which is a gate row -- so the "8 blocking gates not
                      green" figure above is UNCHANGED.
                      2026-08-31, SECOND pass: X4 and X5 were DECIDED and
                      IMPLEMENTED (formal/lifecycle.tla only; digest unmoved),
                      and the verification OPENED X6 -- Liveness now reaches a
                      verdict at all three capacities and FAILS. The lifecycle
                      half of B-M still does not pass; the reason moved from
                      "nothing is evaluated" to "a declared property fails".
                      The gate row is STILL GREEN [NOT PROVEN] and the
                      "8 blocking gates not green" figure is STILL UNCHANGED.
                      2026-08-31, THIRD pass: X6 was CLOSED as a transcription
                      defect -- Sec 4.4's two QUEUED assignment-deadline rows
                      were never transcribed, and WF_vars(Next) does not
                      transcribe Sec 24.2's "given fair timer firing".
                      formal/lifecycle.tla only; digest still unmoved. The
                      verification OPENED X7 (a STRANDED_* Leg cancelled back
                      into ABORTING for ever, holding custody).
                      QueuedLegsProgress now PASSES on a COMPLETE state graph
                      at capacity 1 -- the first passing lifecycle liveness
                      verdict this project has produced -- but EveryLegSettles
                      and CustodyNeverLost still FAIL, so Liveness (a
                      conjunction) still FAILS and the lifecycle half of B-M
                      still does not pass. Run as checked in, all three
                      configurations are now PARTIAL searches, so authoritative
                      closures are back to 1 of 6 (commitment_c1).
                      The gate row is STILL GREEN [NOT PROVEN] and the
                      "8 blocking gates not green" figure is STILL UNCHANGED.
                      2026-09-01, FOURTH pass: X7 was CLOSED and RECLASSIFIED
                      from SPECIFICATION AMBIGUITY to TRANSCRIPTION DEFECT --
                      Sec 4.6's cancel_requested_at latch was never modelled at
                      all, so Cancel and CancelWithCustody were indefinitely
                      repeatable against the same Leg. The shipped engine
                      already had the latch (cancellation.js writes it under a
                      version-conditional update; transitions.js
                      cancellationGuard reads it; nothing clears it), so it
                      forbids the cycle through the latch rather than through
                      any STRANDED_* rule. formal/lifecycle.tla only; no
                      Backend file, test, .cfg, specification or ADR changed;
                      digest still unmoved. The verification OPENED NOTHING.
                      lifecycle_c1 AS CHECKED IN now CLOSES on a COMPLETE state
                      graph -- 777,942 states / 187,289 distinct / depth 43 /
                      0 on queue, exit 0 -- with Safety, TerminalIsFinal and
                      Liveness (ALL THREE conjuncts) PASSING. The X7 lasso is
                      gone and the X7 mutant is KILLED. Authoritative closures
                      are 2 of 6, was 1. lifecycle_c2/c3 still require
                      authoritative treatment and commitment_c2/c3 remain
                      UNKNOWN, deliberately unaffected and not re-run. B-M IS
                      STILL OPEN: X7 closing is NOT B-M closing.
                      The gate row is STILL GREEN [NOT PROVEN] and the
                      "8 blocking gates not green" figure is STILL UNCHANGED.

Open blockers (programme count):        7   — B1, B8, B-P, B-O, B-M, X3, A9
                                            was 7, then 9, then 8, still 8, now 7.
                                            X1/T1-04 CLOSED 2026-08-30; X4 and X5
                                            OPENED 2026-08-31 by the B-M TLC
                                            execution, then DECIDED AND IMPLEMENTED
                                            the same day by the sole project
                                            owner/reviewer -- whose own verification
                                            OPENED X6 (Liveness fails;
                                            pre-existing, previously masked by X5).
                                            9 - 2 + 1 = 8. Then the THIRD pass
                                            CLOSED X6 as a transcription defect and
                                            OPENED X7: 8 - 1 + 1 = 8. Then the
                                            FOURTH pass (2026-09-01) CLOSED X7 as a
                                            transcription defect -- the missing
                                            Sec 4.6 cancellation latch -- and OPENED
                                            NOTHING: 8 - 1 + 0 = 7.
                                            NO INDEPENDENT SAFETY-ENGINEERING OR
                                            RELEASE-OWNER ACCEPTANCE EXISTS for the
                                            X4/X5 decisions, the X6 change OR the
                                            X7 change. Solo project; none was
                                            obtained, simulated or inferred.
                                            The programme count went UP when a
                                            blocker was worked on, then down by two
                                            and up by one, then down by one and up
                                            by one, and now down by one with nothing
                                            opened -- the first pass in this series
                                            that closed an item without finding a
                                            replacement. That is a real decrease,
                                            and it is still 7 blockers, not 0.
Repository-owned AND actionable
  BLOCKERS:                             0   — A9 is repository-owned but deferred to Phase 8.
                                            No blocker is repository-owned and actionable.
  IMPLEMENTATION DEFECTS:               0   — none found by the final closure audit.
  VERIFICATION ROWS:                    0   — V-9 CLOSED 2026-08-30. It was the last §C row
                                            this repository could close by itself, and it
                                            is now measured rather than UNKNOWN: 7 Phase
                                            0-14 harnesses on a disposable cluster,
                                            315/317, no regression, no code changed.
                                            (This block previously read "VERIFICATION
                                            ROWS: 1 — V-9 … Unrun; result UNKNOWN", and
                                            before that "0 … V-9 has no trigger". The
                                            trigger fired, the row was run, and it closed.)
                                            V-5 is the release owner's evidence
                                            re-collection, V-7 is B-M (now RUN and NOT
                                            satisfied -- it needs compute; the X4, X5
                                            and X6 items it also needed were resolved on
                                            2026-08-31, and X7 on 2026-09-01 -- the
                                            lifecycle half now PASSES at capacity 1 and
                                            V-7 is blocked on compute for c2/c3, not on
                                            a model defect), V-8 is B-P (operating fleet),
                                            V-6 now HAS three passes attached -- the X4/X5
                                            model-mutation run, 4 built / 4 killed, the
                                            X6 run, 7 built / 7 killed (M6 recorded
                                            as a survival under its first oracle), and
                                            the X7 run, 1 built / 1 killed.
                                            Re-derive this; do not inherit it.

  CAUTION — this count is Phase-15-scoped, and V-9 demonstrated the limit of that.
                                            V-9 executed cleanly AND surfaced a genuine
                                            repository-owned actionable defect that is
                                            NOT Phase 15's and NOT in any register above:
                                            prisma/seed.js swallows its own failure and
                                            exits 0 after seeding 165 of 250 register
                                            entries and none of the domain fixtures,
                                            because 3 entries carry changeClass
                                            "OPERATIONAL" and the ConfigChangeClass enum
                                            has no such member. Pre-existing since
                                            cbe540e (2026-08-09) — proven, not assumed:
                                            the enum, the 3 entries and seed.js are all
                                            byte-identical at 67b7c7c. It blocks
                                            phase12LiveDatabase.js from running on an
                                            empty cluster. Registered as residual
                                            observation 8. "0 repository-owned actionable"
                                            above means PHASE 15 items; it has never meant
                                            the repository is defect-free, and this is the
                                            fourth pass running in which the next genuine
                                            item was outside the blocker table.

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
commit in this repository can supply; **X3 alone** requires a specification decision. *(This read
"X3 and **X6** require specification or formal-verification decisions". **X6 was closed on
2026-08-31** — `09e91a5` — and the X7 it opened was closed on **2026-09-01** — `9e1d871`. **All four
formal-model blockers X4, X5, X6 and X7 are closed**, every one of them a transcription defect in
`formal/lifecycle.tla` and none of them a defect in the shipped engine, which no `Backend/` file
change was needed to demonstrate.)* **X4 and X5 were decided and implemented on 2026-08-31** by the
sole project owner/reviewer — **with no independent safety-engineering or release-owner acceptance,
because on a solo project none exists** — in `formal/lifecycle.tla` alone, and the same is true of
the X6 and X7 passes; the source digest is unmoved throughout. **T1-04 was the last open item that
*was* code, and it ran on
2026-08-30** — §17.4's ladder, its human capacity model and §17.5's detection are implemented,
composed into the production path, and verified against a live database. The release verdict is
unchanged by it, because T1-04 was never a §24 gate.

> ### ⚠ 2026-08-31 — distinguish these two statements. They are both true and neither implies the other.
>
> | Statement | Basis |
> |---|---|
> | **Phase 15 implementation remains FROZEN, and its verdict is unchanged** | The freeze commit `c27a75c` is intact. The TLC pass changed **no** application source, `.tla`, `.cfg`, schema, migration, test or configuration. The source digest `d033038c…` did not move. **Nothing found is a Phase 15 implementation defect** |
> | **Formal verification has uncovered a specification-level blocker** | **X4** — `lifecycle.tla`'s `CustodyMatchesState` is contradicted by its own `Strand` and `TimerFires` transitions, while `Recovered` is written to resolve the very state the invariant forbids. Reached at depth 9 by the trace `Plan → Offer → Accept → Depart → ArrivePickup → Load → CancelWithCustody → TimerFires`, producing `ABORTING → STRANDED_OBSTRUCTING` with custody still `HELD`. **SPECIFICATION / FORMAL MODEL / SAFETY ENGINEERING** |
>
> **A frozen, unmodified implementation is entirely consistent with a formal model that contradicts
> itself** — the model transcribes the *specification*, not the code. **The freeze is not evidence
> that X4 is benign, and X4 is not evidence that the freeze was wrong.** Alongside it, **X5** records
> that the checked-in lifecycle configurations abort before evaluating any declared property.
> **B-M, X4 and X5 are three separate items with three different owners. Do not merge them, and do
> not close any of them on the strength of another.** Full record:
> [`PHASE_15_BM_TLC_RUN_RECORD.md`](PHASE_15_BM_TLC_RUN_RECORD.md).

**This verdict was computed from the gate table, not asserted.** Do not alter it to make the
documentation look complete. If the repository changes, re-run `npm run release:verdict` and
recompute — the digest in the header is how you know whether these numbers still apply.

**"In-repository defects: none remaining" is not claimed here, and on the evidence of six passes it
should stop being claimed at all.** Each pass has found defects on the surface the previous pass's
fix created.

---

**TRUTH > GREEN.**
