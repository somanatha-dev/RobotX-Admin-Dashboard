# CURRENT PHASE 15 SOURCE OF TRUTH

> **This document is the canonical navigation and current-state document for Phase 15.**
>
> **Archived Phase 15 reports are historical evidence only.**
> **They MUST NOT be used as current implementation truth.**
>
> Every archived report was written against a tree that no longer exists, and several of them
> were corrected by later passes. Reading them to decide what to implement is the specific
> failure this document exists to prevent.

**Consolidated:** 2026-08-29 · **Last updated:** **2026-09-01 (fourth pass)** — the **X7 pass**: X7
was re-investigated against the frozen specification, the shipped implementation and a controlled
`D3 → D6` experiment, **reclassified from a specification ambiguity to a transcription defect**
(§4.6's cancellation latch was never modelled), fixed in `formal/lifecycle.tla` only, and verified —
**`lifecycle_c1` now closes with every declared property PASS**. **No new blocker was opened.**
**B-M remains OPEN.** Before it: the **X6 pass** (2026-08-31, third pass), which opened X7; the
**X4/X5 decision pass**; and the **B-M TLC execution**, which ran all six checked-in configurations
for the first time — **B-M did NOT close** and opened X4 and X5. Before those: closure item **V-9**,
the Phase 0–14 cross-phase re-verification (2026-08-30); the post-V-10 current-state audit; and
closure item **V-10**.

> ### ⚠ 2026-09-01 (FIFTH pass) — THE V1 AUDIT. **The source digest MOVED, and the Phase 15 verdict did not.** Read both halves.
>
> **A V1/V2 boundary now exists** — [`../v1/V1_CONTRACT_AND_STOP_CONDITION.md`](../v1/V1_CONTRACT_AND_STOP_CONDITION.md).
> Before it, this programme had no exit condition smaller than the §24 gate table, which is a
> **production release** condition. V1 is a smaller, honest claim beneath it. **No §24 gate was
> weakened, reclassified or set aside; no blocker moved; the verdict is unchanged.**
>
> | | |
> |---|---|
> | **The digest MOVED** | **`4d94ef18e52b5953…` / 574 files** *(was `d033038cb261c3de…` / 573, which had held since 2026-08-30)*. **Application source changed for the first time since T1-04**, so **every measurement on this page dated 2026-08-30 was taken against a tree that no longer exists** — the *digest-scope* tree, not merely its git identity. Historical rows below keep `d033038c…` deliberately: that is the tree they were measured against, and rewriting them would sever the measurement from its subject |
> | **The Phase 15 implementation freeze was broken, by owner direction** | Not by a pass hunting for work. The owner directed that a genuine V1 correctness defect be **fixed rather than documented**. The freeze bars manufactured work; it does not bar an owner decision |
> | **What changed, and why each is V1** | **I20 — `solve/round.js:248` reported an *unproven* search gap as `0n`.** `candidates/expansion.js` sets `achievedGapMilliCU = null` in two cases and says at each of them that zero would be *"the false guarantee §6.4 calls worse than no bound"*; `?? 0n` converted that into **the strongest optimality claim the engine can make**, and pushed it into the `Round` row, the §21.2 decision record, the operator explanation and the §21.4 SLI. Fixed at all three layers (`round.js`, `coordinator.worker.js`, `metrics.js`), with `achievedGapProven` carried rather than discarded. **`invariantChecker.checkI20` could not catch it**: it audits for a *combined* or a *negative* gap, and a fabricated zero is neither |
> | | **N13 — `workers/registry.js` published a false `cadenceParameter` on 11 of 19 rows**, five of them workers this process starts. Corrected to the parameter actually read, or to `null` plus a mandatory `cadenceNote`; `assertRegistry()` now enforces exactly-one-of. **`timer` was simply wrong** — it named `supervision.timer_tick`, which no code reads, while the composer has always used the registered `supervise.max_timer_lag`. **No parameter was registered, no default invented, no cadence changed** |
> | **Evidence: 14 new tests, 3 mutants built, 3 killed** | The mutants revert **only** the coercion in each of the three layers; the tree was restored and byte-verified against the pre-mutation copies. Full record: [`../v1/V1_CONTRACT_AND_STOP_CONDITION.md`](../v1/V1_CONTRACT_AND_STOP_CONDITION.md) §E |
> | **What this does NOT change** | **`release-evidence.json` was already `[STALE]` and is now bound to a superseded digest as well.** `engine_decision_path_wired` is still RED; the 7 `NOT_EVALUATED` rows still have nothing filed; **8 blocking gates are still not green**; B1, B8, B-P, B-O, B-M, X3 and A9 are all exactly where they were. **RELEASE: BLOCKED** |
>
> **The audit also disproved two claims a prior V1 review had made**, and both matter because acting
> on either would have caused harm. **(1)** *"`service.defaultSnapshot()` returns `spatial: null`,
> `shards: null`, `bindings: {}`, so no valid default operating configuration exists."* — It is a
> **boot fallback that a live engine never reaches**: `server.js` replaces it with
> `configService.bootstrap(...)`, which **throws** if `ENGINE_ENABLED` is true and no version is
> pinned. The cutover gate refuses on `cutover.engine_enabled = false`, §22.4's designed fail-closed
> staging — not on a null field. **"Fixing" it would have manufactured a production configuration.**
> **(2)** *"N13 cadence parameters are absent from the register."* — True as measured, and **not a V1
> correctness defect**: the one cadence a correctness invariant depends on (§4.5's timer lag) was
> governed all along. See §C.2 and §C.5 of the V1 document.

> ### ⚠ 2026-09-01 (FOURTH pass) — X7 is CLOSED as a TRANSCRIPTION DEFECT. `lifecycle_c1` PASSES on a closed graph. **B-M is STILL OPEN.**
>
> | | |
> |---|---|
> | **X7 — CLOSED** | **Reclassified from SPECIFICATION AMBIGUITY to TRANSCRIPTION DEFECT.** The defect is **not** that `STRANDED_*` is necessarily non-cancellable — it is that `formal/lifecycle.tla` **never modelled §4.6 step 1's `cancel_requested_at`**, making `Cancel` and `CancelWithCustody` indefinitely repeatable against the same Leg. §4.6 makes cancellation a **latch**: step 1 writes it and increments the version in one transaction, step 2 guards every subsequent transition on it, **nothing clears it**, step 5 forbids a requester cancelling the Legs cancellation creates. Fixed in `formal/lifecycle.tla` **only** |
> | **The shipped implementation already had the latch** | `lifecycle/cancellation.js:119-130` writes `cancelRequestedAt` under a version-conditional `updateMany`; `lifecycle/transitions.js:664-669` `cancellationGuard` reads it; **nothing in `Backend/src/` clears it**. The shipped system forbids the X7 cycle **through the latch**, not through a `STRANDED_*` rule. **No `Backend/` file changed** |
> | **`lifecycleModel.js` — separate permissive-model observation** | `tests/engine/helpers/lifecycleModel.js:350` exempts `CANCEL_REQUEST` itself from `cancellationGuard`, so the executable checker still admits a repeat the engine refuses. **Recorded, not fixed; no test changed** |
> | **The `STRANDED_*` cancellation question is NON-BLOCKING** | Retained as *Question A*. It did **not** need resolving to fix X7 and was **not** resolved. The repair adds **no** `STRANDED_*` special case |
>
> **The controlled experiment.** D1/D2 reproduced the previous graph exactly. **D3** pristine, 1 Leg:
> `Liveness` **VIOLATED** by the `CancelWithCustody ↔ Strand` lasso. **D4** add *only* the latch:
> all properties **PASS**. **D5** at the `c1` shape: **COMPLETE graph, PASS**, 777 942 / 187 289 /
> depth 43 / **0 on queue**. **D6** remove *only* the latch guard: **VIOLATED**, mutant killed.
>
> **Verification, repository as checked in.** `lifecycle_c1.cfg` **unmodified**, same TLC artefact
> (SHA-256 `eabd140a…533a`), JDK 20.0.2: **777 942 states / 187 289 distinct / depth 43 / 0 on queue,
> exit 0, "No error has been found"** — **reproducing D5 exactly**. `Safety` **PASS**,
> `TerminalIsFinal` **PASS**, `Liveness` **PASS** (all three conjuncts). **The X7 lasso is gone.**
> **X7 mutant re-run against the checked-in config: KILLED** (exit 13, lasso restored).
>
> **Only `formal/lifecycle.tla` changed.** No `Backend/` file, `.cfg`, test, specification, ADR,
> schema or migration was touched. `CHECK_DEADLOCK FALSE` is still absent and deadlock checking ran
> at its default; **`EveryLegSettles` and `CustodyNeverLost` are byte-identical**; **no fairness was
> added on `Recovered`**; no boundedness, timeout or artificial-progress constant was added.
> X4/X5/X6 modelling is intact and byte-identical.
>
> ### B-M did NOT close. X7 closing is not B-M closing.
> B-M needs the complete capacity 1/2/3 evidence and its acceptance: **`commitment_c1` PASS ·
> `commitment_c2` UNKNOWN · `commitment_c3` UNKNOWN · `lifecycle_c1` PASS (new) · `lifecycle_c2` and
> `lifecycle_c3` still require authoritative treatment.** The commitment UNKNOWNs are **deliberately
> unaffected** and were not re-run — `commitment.tla` neither `EXTENDS` nor `INSTANCE`s
> `lifecycle.tla` and no `.cfg` changed. **2 of 6 configurations close, was 1.** **No independent
> safety-engineering or release-owner acceptance exists for X7 and none is claimed.** Full record:
> [`PHASE_15_BM_TLC_RUN_RECORD.md`](PHASE_15_BM_TLC_RUN_RECORD.md) **§17**.

> ### ⚠ 2026-08-31 (THIRD pass) — X6 is CLOSED as a transcription defect. X7 is OPEN. `Liveness` still fails.
>
> | | |
> |---|---|
> | **X6 — CLOSED** | `formal/lifecycle.tla` transcribed **neither** of §4.4's two `QUEUED` assignment-deadline rows (`:1122` `ladder step available → QUEUED`, `:1123` `ladder exhausted → FAILED`) — `TimerFires` had no `QUEUED` case at all — **and** `WF_vars(Next)` does not transcribe §24.2's own hypothesis, "given fair timer firing". Both fixed: a monotone per-Leg `ladder`, `LadderAdvance`/`LadderExhausted`, and **strong** fairness on those two actions. **The shipped engine already implemented all of it end to end and no `Backend/` file changed** |
> | **X7 — NEW, OPEN** | A `STRANDED_*` Leg can be cancelled back into `ABORTING` and re-stranded for ever, holding custody throughout. **`CustodyNeverLost` and `EveryLegSettles` fail on this and on nothing else.** §4.4's cancel row says "any non-terminal"; its stranded rows enumerate exits that exclude `ABORTING`; §24.2 states the custody clause unconditionally. **A genuine specification ambiguity — reported, not decided** |
>
> **Only `formal/lifecycle.tla` changed.** No `Backend/` file, `.cfg`, schema, migration, test or
> configuration was touched; `CHECK_DEADLOCK FALSE` is still absent; `EveryLegSettles` was not
> weakened; no boundedness or timeout constant was added (`LadderSteps == 8` is §17.4's own rung
> count, written as a definition so no configuration supplies it). **The source digest is unmoved
> and the freeze at `c27a75c` is intact.**
>
> **X6 was a transcription defect for the same reason X4 was.** The shipped engine has both rows
> (`lifecycle/transitions.js:203-217` → `fairness/ladder.js` → `supervision/expiryActions.js` →
> `workers/leaderWorkers.js`), and **`lifecycleModel.js` traverses both** — it emits
> `QUEUED--LADDER_EXHAUSTED-->FAILED` from its initial state. **The two checkers disagreed on the
> transition relation and `lifecycle.tla` was again the one not updated.**
>
> **Verification:** **`QueuedLegsProgress` now PASSES on a complete state graph** at capacity 1 —
> 676 854 states / 156 941 distinct / depth 43 / **0 on queue**, with `Safety` and `TerminalIsFinal`
> passing there too. **That is the first passing lifecycle liveness verdict this project has ever
> produced.** **7 model mutants built, 7 killed**, including M1 and M2, which re-confirm that the X4
> widening and X5's `TaskQuiescent` are each still load-bearing.
>
> **B-M did NOT close and did not move.** `Liveness` is a conjunction and it still FAILS, now on X7.
> `commitment_c1/c2/c3` were **not re-run** — `commitment.tla` neither `EXTENDS` nor `INSTANCE`s
> `lifecycle.tla` and no `.cfg` changed, so no commitment result can be affected. **No independent
> safety-engineering or release-owner acceptance exists for X6 and none is claimed.** Full record:
> [`PHASE_15_BM_TLC_RUN_RECORD.md`](PHASE_15_BM_TLC_RUN_RECORD.md) **§16**.

> ### ⚠ 2026-08-31 (second pass) — X4 and X5 are DECIDED, IMPLEMENTED and VERIFIED. X6 is OPEN.
>
> | | |
> |---|---|
> | **X4 — CLOSED** | `STRANDED_SAFE` / `STRANDED_OBSTRUCTING` are **custody-bearing**; `custody = "HELD"` is lawful while stranded. Implemented by separating `CustodyLawfulStates` (the invariant's domain) from `CustodyBearingStates` (a **guard** used by `Dispute` and `TimerFires`, deliberately left untouched so no transition changed) |
> | **X5 — CLOSED** | Terminal deadlock freedom treated as a genuine §24.2 obligation; satisfied by an explicit `TaskQuiescent` stuttering action. **`CHECK_DEADLOCK FALSE` REJECTED. No `.cfg` edited.** |
> | **X6 — NEW, OPEN** | `Liveness` now fails at all three capacities. **Pre-existing and previously masked** — no lifecycle liveness property had ever been evaluated. Deliberately not decided in the same pass |
>
> **Only `formal/lifecycle.tla` changed. No `Backend/` file, `.cfg`, schema, migration, test or
> configuration was touched. The source digest is unmoved at `d033038cb261c3de…` / 573 files and the
> Phase 15 implementation freeze at `c27a75c` is intact.**
>
> **X4 turned out to be a transcription defect, not an open safety question.** §4.4's own
> `EN_ROUTE_DROP` row enters a stranded state under the guard **"custody `HELD`"**, §4.4's recovery
> row makes custody discharge a precondition of terminating a stranded Leg, and
> `lifecycleModel.js` — the §24.2 *executable* checker, running against the **shipped** modules —
> had listed both stranded states as custody-bearing since Phase 15. **The two checkers had
> contradicted each other all along, and `lifecycle.tla` was the one that was not updated.**
>
> **Verification:** `Safety` exhaustive and clean at all three capacities under a labelled secondary
> diagnostic (c3: 16 557 136 states / 1 680 163 distinct / depth 47 / 0 on queue); **4 model
> mutants built, 4 killed**, including M1 — reverting *only* the X4 widening reproduces the original
> depth-9 `STRANDED_OBSTRUCTING`-with-`HELD` counterexample **exactly**.
>
> ### NO INDEPENDENT SIGN-OFF EXISTS AND NONE IS CLAIMED.
> This is a solo project. The separate **safety engineer**, **frozen-specification owner** and
> **release owner** of §7.6 **do not exist as distinct individuals**. **No independent
> safety-engineering or release-owner acceptance was obtained, simulated or inferred.** §7.3a items
> 4, 8 and 10 remain formally unsatisfied.
>
> **B-M did NOT close.** `commitment_c2`/`c3` were not re-run and are still UNKNOWN; the lifecycle
> half now fails on **X6** rather than aborting on X5. Full record:
> [`PHASE_15_BM_TLC_RUN_RECORD.md`](PHASE_15_BM_TLC_RUN_RECORD.md) **§15**.

> ### ⚠ Two things happened on 2026-08-31 and they must not be conflated.
>
> | | |
> |---|---|
> | **Phase 15 implementation remains FROZEN** | The freeze commit `c27a75c` is intact. **No application source, `.tla`, `.cfg`, schema, migration, test or configuration was changed**, and the implementation verdict is unchanged. The source digest did not move |
> | **Formal verification has uncovered a specification-level blocker** | **X4** — `lifecycle.tla`'s `CustodyMatchesState` is contradicted by its own `Strand` and `TimerFires` transitions, while `Recovered` is written to resolve the very state the invariant forbids. It is a **specification / formal-model / safety-engineering** finding, **not** a Phase 15 implementation defect, and **not** part of B-M |
>
> **Neither statement implies the other.** A frozen, unmodified implementation is entirely
> consistent with a formal model that contradicts itself — the model transcribes the
> *specification*, not the code. **The freeze is not evidence that X4 is benign, and X4 is not
> evidence that the freeze was wrong.** Full record:
> [`PHASE_15_BM_TLC_RUN_RECORD.md`](PHASE_15_BM_TLC_RUN_RECORD.md).
**Branch:** `feature/dashboard` · **HEAD:** **`9e1d871`** — *"spec(phase15): close X7 as a TLA+
transcription defect (the missing §4.6 latch)"*, the X7 pass committed on 2026-09-01 by the V1
audit. *(This line read **`7335260`** and was stale by three commits: `ef0d65f` recorded the TLC
findings, `22411e8` decided and implemented X4/X5, `09e91a5` closed X6 — and the X7 pass's own work
sat uncommitted on top of all three, so **the tree's most recent verification result was reproducible
from no commit at all**. That is why the HEAD row is worth re-reading rather than trusting; it had
been correct when written and had silently stopped being so four times.)*
**Source-digest scope: unchanged by any of it.** `ef0d65f`, `22411e8`, `09e91a5` and `9e1d871` touch
only `docs/` and `formal/`, both of which are outside the scope — **the digest below is the same
`d033038c…` / 573 the freeze audit measured on 2026-08-31**, re-measured live again on 2026-09-01.
*Text below that says "`67b7c7c` + uncommitted" describes `7335260`'s content under its previous git
identity.*
**Source digest of the current tree:**
**`4d94ef18e52b59532837d86fc34ac12f496251f446226693def982070a0e2ab5` (574 files)**
— computed live via `node -e "require('./tools/release/sourceDigest.js').sourceDigest()"` from `Backend/`,
2026-09-01, after the V1 audit's four source edits and one new test file.

> **`d033038cb261c3de…` / 573 is SUPERSEDED, and this is the first digest move since 2026-08-30.**
> It is not a cosmetic change of identity: **application source moved**, so every measurement on this
> page dated 2026-08-30 was taken against a tree that no longer exists. Those rows keep `d033038c…`
> **on purpose** — a measurement is only meaningful attached to the tree it was taken on, and
> back-dating them would destroy exactly the binding that makes this page usable.
> **Re-measured on the new tree and unchanged: 19 workers · 9/4/6 · 28 migrations · 346 legacy-corpus
> files · 250 register entries / 39 findings / 54 Safety-class · `routing:readiness` BLOCKED ·
> `gates` 7 PASS 1 FAIL.** Digests seen earlier and now superseded: `d033038c…` (573),
> `431010ace1…` (565).

> **Digest `431010ace1…` (565 files) is the 2026-08-29 consolidation's tree and is superseded.**
> Measurements below still dated 2026-08-29 were taken against it; the ones re-executed on
> 2026-08-30 say so. `PHASE_15_VERIFICATION_STATE.md` carries every current number.

---

## 1. Authority order

When this document and any other source disagree, resolve in this order:

| # | Authority |
|---|---|
| 1 | `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` — **FROZEN** architecture/specification |
| 2 | `IMPLEMENTATION_EXECUTION_PLAN.md` — execution plan |
| 3 | **The actual current repository** — source, config, schema, migrations, tests, scripts, tools, generated artefacts, git state |
| 4 | Freshly executed verification against the current repository |
| 5 | These five canonical Phase 15 documents |
| 6 | `archive/` — historical Phase 15 reports |

A historical report is **not** authoritative because it is detailed, recent, or says "FINAL".

---

## 2. What Phase 15 is

`IMPLEMENTATION_EXECUTION_PLAN.md` §3, "PHASE 15 — Verification, release gates, and production
cutover". Its purpose is **not** new capability. It is:

- implement `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` §24 in full — the release-gate table;
- implement §22.4's staging discipline — the per-shard cutover authority and its guardrails;
- move every engine worker from shadow to **production scheduling**;
- **remove** the legacy DTARO decision path from the build, not bypass it;
- provide the evidence machinery — source digest, evidence collection, release verdict,
  safety case, simulator-fidelity gate, formal-verification artefacts.

Phase 16 has exactly one prerequisite: Phase 15.

---

## 3. Current status — the verdict

# PHASE 15 IMPLEMENTATION — CLOSED
# PHASE 15 RELEASE — BLOCKED
# PHASE 16 — NOT READY

**Read the distinction carefully; it is the single most important fact in this document.**

- **Implementation CLOSED** means: Phase 15's *code* obligations are discharged. The cutover
  authority, its evidence binding, its observation-window authority, its rollback publisher and
  its configuration propagation are implemented, adversarially attacked, mutation-tested, and
  verified against a live PostgreSQL database. Six adversarial passes have each closed their own
  findings.
- **Release BLOCKED** means: `npm run release:verdict` exits 1. **8 of 24 blocking gates are not
  green for their own reasons** (1 RED — B1; 7 NOT_EVALUATED — B8/B-P/B-O), and nothing in this
  repository can turn any of those 8 green. **As measured on 2026-08-30 the tool reports 0
  green / 17 red / 7 not evaluated**, because the checked-in evidence collection is bound to the
  superseded digest and has aged past every gate's `maxAgeMs` — every extra RED is `[STALE]`, not
  a gate failing, and a fresh `npm run release:gates` at a committed tree restores the 16. See
  `PHASE_15_VERIFICATION_STATE.md` §3.0. **The verdict is BLOCKED either way.**
- **Phase 16 NOT READY** follows from the release verdict. It no longer follows from **REMEDIAL
  PHASE T1-04**: that phase ran on 2026-08-30 and its three fairness modules exist, are composed
  into the production timer and worker paths, and are verified against a live database.

**"In-repository defects: none remaining" is NOT claimed and should not be claimed.** Every pass
that has claimed it has been proven wrong by the next pass, because each pass searches the surface
the previous pass's fix created. See §51 of the archived third-pass report for why this is
structural rather than accidental.

**The 2026-08-30 demonstration of exactly that.** This document told an agent, in §9, that *"there
is no unblocked Phase 15 implementation work identified"*. Closure item **V-10** — *"`rollback.md`
executed against the current API"*, `NOT EVALUATED`, status **UNKNOWN**, never executed by any
pass — was sitting in `PHASE_15_CLOSURE_CHECKLIST.md` §C the whole time. Executing it found
**five defects**, including a manual rollback procedure that would have reverted the fleet's
entire configuration, and a §4 paragraph arguing that Rollback B was safe from a database mirror
that has had no writer since Phase 15 deleted the legacy dispatcher. **None of them was in the
blocker table**, and none would have been found by any test. Three passes running, the next
genuine item has been outside the blocker register — so read §C of the checklist, not only §7 of
this file.

**The 2026-08-30 V-9 run, and what it did and did not establish.** Closure item **V-9** — the
Phase 0–14 cross-phase re-verification — was the last §C row this repository could close by
itself, and it had never been run. It has now been: scope derived by measurement rather than
judgement (22 harnesses' `require()` closures intersected with the 11 changed source files), **7
executed against a disposable PostgreSQL 18.3 cluster, 315/317 checks**. **The current Phase 15
tree remains compatible with the affected Phase 0–14 contracts.** The only 2 failures are
`phase5ExpirySemantics` FINDING assertions stating that §17.4's ladder does not exist — which
T1-04 deliberately made false — and neither is a regression: the shipped ladder was proven live at
72/72, and the `LADDER_EXHAUSTED → FAILED` row was not taken. **No code was changed, so no
mutation testing was owed, and the digest is unmoved at `d033038c…`.** *Two things V-9 refused to
do, both of which would have produced a greener page: edit the two stale assertions to their
inverse, and fabricate a `Mission` row so a seventh harness could run.* Full record:
`PHASE_15_VERIFICATION_STATE.md` **§7c**.

**The 2026-08-30 post-V-10 audit, and why it did not produce a seventh implementation task.**
V-10's changes were re-examined for newly actionable repository-owned work — the worker-count
move, the runbook edits, the new verification harness, and the digest movement. **There is none,
and none was manufactured.** Everything found was **stale documentation**: the canonical set still
carried the pre-T1-04 tree's numbers (18 workers, 11 starting, 340 legacy-corpus files, 242
register entries, `160`/`7 162` tests), recorded **29** migrations where 27 + T1-04's one is
**28**, and — most consequentially — **asserted in two places that the checked-in evidence
collection "matches the current tree"**, contradicting the V-10 finding that it has aged out. All
are corrected in place and marked with what they used to say; the command-by-command record is
`PHASE_15_VERIFICATION_STATE.md` **§7b**. **No code was written, no gate or threshold touched, no
blocker moved, and none of V-10's five findings was altered.** *A pass that finds only stale
numbers should report only stale numbers — inventing a remediation to justify the pass is the
failure mode this file's §10 exists to prevent.*

---

## 4. Current repository identity

| | |
|---|---|
| Branch | `feature/dashboard` |
| HEAD | **`9e1d871`** — "spec(phase15): close X7 as a TLA+ transcription defect (the missing §4.6 latch)", 2026-09-01. Its four predecessors, newest first: `09e91a5` (X6 closed, X7 opened), `22411e8` (X4/X5 decided and implemented), `ef0d65f` (TLC findings recorded), `7335260` (the snapshot before V-9). **Every one of the four touches only `docs/` and `formal/`, so the digest has not moved since `7335260`.** *(This row said `7335260`, and before that `67b7c7c`, and before that `b68dc5d`. It has now been stale three times, which is why the digest — not the hash — is this table's binding fact.)* |
| Working tree | **Was not clean at the start of the V1 audit, and the reason mattered:** `formal/lifecycle.tla` carried the **X7 fix itself**, uncommitted, alongside `formal/README.md` and six of these documents. The X4/X5 and X6 passes had each committed their own work; the X7 pass had not, so the tree's most recent formal-verification result was reproducible from no commit. **Committed as `9e1d871`.** T1-04, the `Leg.slaDeadline` producer and V-10 — which are **why the digest moved** from `431010ace1…`/565 — were committed earlier, as the snapshot `7335260`. *(This row read "No application source is modified. … The only paths modified now are these five canonical documents themselves", which was true of `docs/` and silently untrue of `formal/`.)* |
| Source digest | **`4d94ef18e52b59532837d86fc34ac12f496251f446226693def982070a0e2ab5`** — measured live 2026-09-01 by the V1 audit. *(`d033038cb261c3de…` and `431010ace1…` are both **superseded**. The move is the V1 audit's four source edits — `solve/round.js`, `observability/metrics.js`, `workers/coordinator.worker.js`, `workers/registry.js` — plus one new test file.)* |
| Files in digest scope | **574** *(was 573; +1 is `tests/engine/solveRoundSearchGapProvenance.test.js`)* |
| Digest scope | `Backend/{src,tools,tests}`, `Backend/package.json`, `Backend/jest.config.js` — **`docs/` is deliberately excluded** |
| Registered workers | **19 registered** · **12 actually start** (9 `SCHEDULED` + 3 of 4 `LEADER_ONLY`) · 6 `DEFERRED` · 1 refused (`coordinator`, B1). *Was 18/11 before T1-04 added `fairness.worker.js`; re-measured 2026-08-30 via `registry.report({running:[]})` → total 19, scheduled 9, leaderOnly 4, deferred 6.* `src/workers/` holds **21** `.js` files (19 `*.worker.js` + `registry.js` + `leaderWorkers.js`) |
| Prisma migrations | **28** *(27 before T1-04, which added exactly one — `20260830120000_ladder_escalation_t1_04`)*. **Re-counted directly 2026-08-30: 28 directories, 28 `migration.sql` files.** *An earlier revision said "29 (was 27; T1-04 added one)", which contradicts its own arithmetic; the 29 was wrong wherever it appeared* |
| §24 release gates | 24, all blocking. `gates.blockers({})` returns all **24** |
| Build gates in `npm run gates` | **8** — 7 PASS, 1 FAIL (`gate:composition`) |

**The digest is the binding fact.** Any report — archived or otherwise — that quotes a different
digest was measured against a different tree, and its numbers do not transfer. Digests seen in the
archive that are **NOT** this tree: `22ca9143…`, `134ebc0d…`, `801ed1df…`, `72f943df…`, `d9fdb79a…`.

---

## 5. Current implementation summary

Full detail: **[`PHASE_15_IMPLEMENTATION_STATE.md`](PHASE_15_IMPLEMENTATION_STATE.md)**.

| Subsystem | State |
|---|---|
| Cutover authority | **Implemented** — `src/engine/cutover/` (10 modules). Its **operator procedures** were traced against it for the first time on 2026-08-30 (**V-10**): 5 runbook defects, fixed — see `PHASE_15_BLOCKERS.md` § *V-10* |
| Release gates + evidence | **Implemented** — `tools/release/` (3 tools), 24-gate table in `src/engine/cutover/gates.js` |
| Workers / composition root | **Implemented** — `server.js` is the production composition root. **19 registered; 12 start** (9 `SCHEDULED` + 3 of 4 `LEADER_ONLY`). **1 cannot be composed** (`coordinator`, B1) and **6 are `DEFERRED` with declared blockers**. `gate:composition` prints **"1 violation across 19 registered worker(s)"** and that counts *compliance*, not *starts* — see `PHASE_15_IMPLEMENTATION_STATE.md`. *(Re-measured 2026-08-30; this row said 18/11 and quoted "1 violation of 18", which was the pre-T1-04 tree)* |
| Legacy retirement | **Complete** — 4 modules deleted, build gate enforces absence |
| Routing | **Adapters + readiness tool implemented; NO ENGINE SELECTED** (B1, external) |
| Calibration | Gate implemented; **39 blocking findings** (B8, external) |
| Simulator fidelity | Gate implemented; **no study supplied** — 7 models NOT_MEASURED |
| Safety case | Assembler implemented; assembles cleanly. **The §24.7 gate is not thereby discharged** |
| Formal verification | TLA+ modules + 6 TLC configs present. **TLC was EXECUTED for the first time on 2026-08-31 — all six checked-in configurations, on the frozen tree**, then `lifecycle.tla` was changed twice the same day (**X4/X5**, then **X6**) and re-run. Commitment half **unchanged throughout**: **1 closed** (`commitment_c1`, exhaustive PASS), **2 UNKNOWN** (`commitment_c2/c3`, did not converge) — **not re-run by either later pass, deliberately**, since `commitment.tla` neither `EXTENDS` nor `INSTANCE`s `lifecycle.tla`. Lifecycle half: the deadlock abort (**X5**) and the `CustodyMatchesState` contradiction (**X4**) are fixed; **`QueuedLegsProgress` now PASSES on a complete state graph at capacity 1** (676 854 / 156 941 / depth 43 / 0 on queue, with `Safety` and `TerminalIsFinal`) — the first passing lifecycle liveness verdict — while `EveryLegSettles` and `CustodyNeverLost` **still FAIL**, on **X7** and on nothing else. **— SUPERSEDED by the X7 pass, 2026-09-01.** X7 was reclassified as a **transcription defect** (§4.6's `cancel_requested_at` latch was never modelled, making cancellation indefinitely repeatable) and fixed in `formal/lifecycle.tla` only. **`lifecycle_c1` now CLOSES with every declared property PASS** — 777 942 states / 187 289 distinct / depth 43 / **0 on queue**, exit 0, `Safety` + `TerminalIsFinal` + `Liveness` (all three conjuncts) — and the X7 mutant is **KILLED**. **2 of 6 configurations now close, was 1.** `lifecycle_c2`/`c3` still require authoritative treatment and `commitment_c2`/`c3` remain **UNKNOWN, deliberately unaffected and not re-run**. **B-M = NOT MEASURED / OPEN — it did NOT close.** Full §7.3a record with raw output: [`PHASE_15_BM_TLC_RUN_RECORD.md`](PHASE_15_BM_TLC_RUN_RECORD.md) §12, §15, §16, **§17** |
| Database | **28 migrations**; **6** live-DB harnesses (the four Phase 15 ones, plus T1-04's and V-10's), **167/167**, all green |
| Runbooks | `docs/runbooks/cutover.md` and `rollback.md`. **Both traced against the current API 2026-08-30 (V-10) — 5 defects fixed**, and `rollback.md` §7 now records when that trace happened. P15-F7a (nothing *binds* a runbook to its API) is unchanged and still open |

---

## 6. Current verification summary

Full detail with commands, exit codes and dates: **[`PHASE_15_VERIFICATION_STATE.md`](PHASE_15_VERIFICATION_STATE.md)**.

**Every row below carries its own date.** The rows marked *re-measured 2026-08-30* were executed
against the **current** digest `d033038c…` (573 files); the rest were executed on 2026-08-29
against the superseded `431010ace1…` and have not been re-run since. None is an inherited number —
but do not read the whole table as one date, which an earlier revision of this sentence invited.

| Command | Exit | Result |
|---|---|---|
| `npm test` | **0** | **163 suites / 7 291 tests / 0 failures / 0 skips** — re-measured **2026-09-01** at digest `4d94ef18…` *(was 162 / 7 275 at `d033038c…`; the V1 audit added `solveRoundSearchGapProvenance.test.js` and reworked `workerRegistry.test.js`)* |
| `npm run gates` | **1** | 7 PASS, 1 FAIL (`gate:composition` — B1, 1 violation of **19** workers) — **re-measured 2026-09-01, unchanged.** `gate:params` still PASS at 192 modules / 250 parameters, so the N13 registry correction introduced no bare behavioural constant |
| `npm run release:verdict` | **1** | **2026-08-30: 0 GREEN, 17 RED, 7 NOT_EVALUATED** — every extra RED is `[STALE]`, not a gate failing. *(2026-08-29, when the collection was current: 16 GREEN, 1 RED, 7 NOT_EVALUATED.)* **RELEASE: BLOCKED**, both times |
| `npm run gate:calibration` | **1** | 39 blocking findings; **250** entries (52 DERIVED / **160** PROVISIONAL / 38 UNCALIBRATED), 54 Safety-class — **re-measured 2026-08-30**. *(Was 242 / 152; T1-04 added 8 `PROVISIONAL` ladder-rung fractions, **none Safety-class**, so the 39 and the 54 did not move — see `PHASE_15_BLOCKERS.md` § B8)* |
| `npm run routing:readiness` | **0** *(by design)* | **OVERALL: BLOCKED** — D1, D3, D8 all BLOCKED; Steps 1/3/4/5 BLOCKED, Step 2 PASS — **re-run 2026-08-30, unchanged** |
| `npm run sim:fidelity` | **1** | 7 models NOT_MEASURED, 6 safety-relevant |
| `npm run safety:case` | **0** | 12 hazards assembled, every reference resolves |
| 4 × `tools/verify/phase15*.js` on live PostgreSQL 18.3 | **0** | **80 / 80** checks |
| `npm run verify:t104` (T1-04 + `Leg.slaDeadline`) | **0** | **72 / 72** checks, 2026-08-30 |
| **`npm run verify:v10`** (`rollback.md` §2.1 vs the live API) | **0** | **15 / 15** checks, 2026-08-30 — **167 / 167** in total |

| **Phase 0–14 cross-phase re-verification (V-9)** — 7 harnesses on disposable PostgreSQL | mixed | **315 / 317**, 2026-08-30. The 2 failures are `phase5ExpirySemantics` FINDING assertions whose premise T1-04 deliberately invalidated — **not regressions.** `PHASE_15_VERIFICATION_STATE.md` **§7c** |

**NOT currently verified** (labelled honestly, not assumed): mutation testing and the
soak/shadow/invariant observation windows. See `PHASE_15_VERIFICATION_STATE.md` §5.
***Phase 0–14 cross-phase re-verification was on this list until 2026-08-30 and is not any more —
V-9 ran it. TLC model checking was on this list until 2026-08-31 and is not any more — all six
configurations were run (`PHASE_15_VERIFICATION_STATE.md` §7d). Being measured is not being
discharged: one of the six closed, and B-M is still OPEN.***

---

## 7. Current blockers

Full register with owners and closure conditions: **[`PHASE_15_BLOCKERS.md`](PHASE_15_BLOCKERS.md)**.

**7 open blockers. 0 are repository-owned *and actionable*** — the one repository-owned entry (A9)
is correctly deferred to Phase 8 and has no action available here. **X1/T1-04 was closed on
2026-08-30** by REMEDIAL PHASE T1-04 (§17.4's ladder, its human capacity model, and §17.5's
detection — implemented, composed, and verified against live PostgreSQL).

> **Was 7, then 9, then 8, still 8, and now 7 — and the arithmetic is worth reading rather than trusting.**
> On 2026-08-31 `tla2tools.jar` was provisioned and all six TLC configurations were run; B-M did not
> close and the runs uncovered **X4** and **X5**, taking 7 → 9. Later the same day both were
> **decided and implemented**, and the verification opened **X6**: 9 − 2 + 1 = **8**. On the third
> pass **X6 was closed** as a transcription defect and its verification opened **X7**:
> 8 − 1 + 1 = **8**. On the fourth pass (2026-09-01) **X7 was closed** as a transcription defect
> — the missing §4.6 cancellation latch — and its verification opened **nothing**:
> 8 − 1 + 0 = **7**. The open set is now **B1, B8, B-P, B-O, B-M, X3, A9**.
>
> **The §24 gate count is unchanged at 8 blocking gates not green** through all of it, because none
> of X4, X5, X6 or X7 is a gate row and `model_check_capacity_1_2_3` renders exactly as it did
> before — **X7 closing does not change it either**, because that gate needs all six configurations
> and only two now close. See `PHASE_15_VERIFICATION_STATE.md` §7d, §7e, §7f and **§7g**.
>
> **A closed blocker replaced by a new one is not standing still, and it is not progress either —
> read what actually moved.** X6 was answerable from the frozen document: §4.4 states the
> ladder-exhaustion row verbatim and the shipped engine already implements it, so the only defect
> was in the transcription. **What that bought is one real verdict** — `QueuedLegsProgress` passes
> on a complete state graph at capacity 1, the first passing lifecycle liveness result this project
> has produced — **and one isolated cause**: `EveryLegSettles` and `CustodyNeverLost` now fail on
> **X7 alone**, which the X6 fix is what made provable. ~~**X7 is a genuine specification ambiguity
> about whether §4.4's "any non-terminal" cancel row governs a `STRANDED_*` Leg**, and it is now the
> reason the lifecycle half of B-M still does not pass.~~
>
> **SUPERSEDED by the X7 pass, 2026-09-01 (`9e1d871`) — and the struck sentence was wrong about the
> defect, not merely out of date.** X7 was not a specification ambiguity at all. `lifecycle.tla`
> never modelled §4.6 step 1's `cancel_requested_at`, so `Cancel` and `CancelWithCustody` were
> indefinitely repeatable against one Leg; the `STRANDED_*` question never had to be answered and was
> not. It survives as *Question A*, non-blocking. **The lifecycle half of B-M now passes at capacity
> 1**, and what B-M still lacks is compute for `c2`/`c3` and acceptance — **not any open model
> defect.** The `STRANDED_*` three-reading framing must not be re-opened to settle Question A.

> **Two different quantities in this documentation used to both equal 8. They no longer do, and
> that is itself worth stating.** **7 open blockers** (this table) is a programme count — it
> includes specification and phase-ownership items that are not §24 gates. **8 blocking gates not
> green** (the §24 table: 1 RED + 7 NOT_EVALUATED) is the release-verdict count, and it is
> **unchanged**: closing X1/T1-04 moved the programme count and no gate, because T1-04 was never a
> §24 gate row. B1 appears in both; X3 and A9 appear only in the blocker count; the four individual
> PRODUCTION gates are one blocker (B-P) but four gate rows.

| ID | Summary | Classification | Owner |
|---|---|---|---|
| **B1** | No routing engine selected → `coordinator` uncomposable → `engine_decision_path_wired` RED | **EXTERNAL** | Ops + Commercial (D1), Product + Fleet Eng (D3), Ops (D8) |
| **B8** | 39 Safety-class parameters not `DERIVED` | **EXTERNAL** | §22.4 calibration owner |
| **B-P** | 4 PRODUCTION gates NOT_EVALUATED — needs an operating fleet | **EVIDENCE / OPERATIONS** | Operations |
| **B-O** | 3 ORGANISATIONAL gates NOT_EVALUATED — needs filed attestations | **EVIDENCE / OPERATIONS** | Named humans / release owner |
| **B-M** | `model_check_capacity_1_2_3` is GREEN and **NOT PROVEN** — **NOT MEASURED / OPEN**. **All six configurations RUN 2026-08-31: 1 closed, 2 UNKNOWN, 3 FAIL, no acceptance.** An independent release-evidence item, **not a B1 sub-step** | **EVIDENCE / OPERATIONS** (compute) | Release owner (provisioning + **final acceptance**) · Compute/Platform · Safety engineer (property coverage, boundedness) · Engineering (mechanical only) |
| **X3** | No `TASK` timer producer; §4.2 has no transition table | **SPECIFICATION / ADR** | Frozen-spec owner |
| ~~**X4**~~ | ~~`CustodyMatchesState` is contradicted by `Strand` and `TimerFires`~~ **DECIDED AND IMPLEMENTED 2026-08-31.** The `STRANDED_*` states are custody-bearing; `HELD` is lawful while stranded. **The frozen §4.4 table already entered a stranded state under the guard "custody `HELD`" — it was a transcription defect** | **CLOSED** | Sole project owner/reviewer. **No independent sign-off exists** |
| ~~**X5**~~ | ~~The three `lifecycle_c*.cfg` abort on the deadlock check~~ **DECIDED AND IMPLEMENTED 2026-08-31.** Terminal deadlock freedom is a genuine §24.2 obligation; an explicit `TaskQuiescent` action satisfies it. **`CHECK_DEADLOCK FALSE` was REJECTED; no `.cfg` was edited** | **CLOSED** | Sole project owner/reviewer. **No independent sign-off exists** |
| ~~**X6**~~ | ~~**`Liveness` FAILS** at all three capacities; the module never transcribed §4.4's `QUEUED` → `FAILED` *"ladder exhausted"* row that T1-04 shipped~~ **CLOSED 2026-08-31 (third pass), committed as `09e91a5`.** A transcription defect: **both** of §4.4's `QUEUED` assignment-deadline rows were missing, **and** `WF_vars(Next)` does not transcribe §24.2's own hypothesis, "given fair timer firing". Fixed with a monotone per-Leg `ladder` and strong fairness on the two ladder actions. **The shipped engine already implemented all of it end to end and no `Backend/` file changed** | **CLOSED** | Sole project owner/reviewer. **No independent sign-off exists** |
| ~~**X7**~~ | ~~A `STRANDED_*` Leg can be cancelled back into `ABORTING` for ever, holding custody~~ **CLOSED 2026-09-01 (fourth pass), committed as `9e1d871`.** Reclassified from *specification ambiguity* to **transcription defect**: `lifecycle.tla` never modelled §4.6 step 1's `cancel_requested_at`, so cancellation was indefinitely repeatable against one Leg. **The shipped engine already had the latch** and no `Backend/` file changed. `lifecycle_c1` now closes with every declared property PASS | **CLOSED** | Sole project owner/reviewer. **No independent sign-off exists** |
| **A9** | `assertVersionInKey` implemented, tested, genuinely uncalled | **REPOSITORY-OWNED, correctly deferred** | Phase 8 |

**Closed since the last revision — X1 / T1-04**, on 2026-08-30. §17.4's escalation ladder, its
human capacity model and §17.5's agent-starvation detection are implemented in
`src/engine/fairness/`, composed into the production timer path (`leaderWorkers.timer` →
`expiryActions` → `ESCALATION_LADDER`) and into `server.js`'s scheduled set, and verified by 72/72
checks against live PostgreSQL. Four parts of §17.4/§17.5 genuinely remain and are recorded with
their reasons in `PHASE_15_BLOCKERS.md`; none of them is a §24 gate. Composing it required arming
the `QUEUED` deadline in `task.service.admitToRound`, which the request path had never done — so
before this phase the ladder would have had no runtime trigger for customer work even had it
existed.

**`Leg.slaDeadline` gained its producer on 2026-08-30**, in the same function and the same
transaction: §17.4's triage comparator sorts escalations by SLA breach proximity, and the column
that proximity is measured from had no writer, so the key was inert and a dispatcher's queue fell
back to arrival order. It is now `storeTime + sla.assignment_deadline` — §4.3's exit deadline for
Leg state `QUEUED`, taken from the same resolved budget and the same clock read as the §4.5 timer
beside it, so the instant §17.4 sorts on cannot drift from the instant §4.5 fires on. Recorded in
full in `PHASE_15_BLOCKERS.md`.

**A9 is the only repository-owned entry, and it is deferred by design** — its discharge point is
`src/engine/routing/client.js`, a Phase 8 module that does not exist and cannot exist before B1.
Do not manufacture a caller for it.

**Closed 2026-08-30 — closure item V-10.** *"`docs/runbooks/rollback.md`'s procedure executed
against the current API"* was never a blocker; it was a `NOT EVALUATED` verification row in
`PHASE_15_CLOSURE_CHECKLIST.md` §C with the note *"No pass has ever done it"* and the status
**UNKNOWN**. Executing it found **five defects** — the worst being that the manual Rollback A, as
written, published one binding into a configuration system whose versions are *complete sets*, and
so reverted every other parameter in the deployment while stopping one shard. All five are fixed,
with 7 tests, 3 mutants killed and **15/15 against live PostgreSQL**. Full record:
`PHASE_15_BLOCKERS.md` § **V-10**.

**B1 gained a fifth item of required engineering work as a result**, and it is *not* implemented:
the coordinator does not read the per-shard cutover switch, so a Rollback A does not stop a
running coordinator. It is invisible today only because no coordinator can be composed. The guard
belongs in the composition root beside the routing client, and writing it now would produce a
guard with no caller. See `PHASE_15_BLOCKERS.md` § **B1**, item 5.

**Closed 2026-08-30 — closure item V-9.** *"Phase 0–14 cross-phase re-verification"* was never a
blocker either; it was a `NOT EVALUATED` row in `PHASE_15_CLOSURE_CHECKLIST.md` §C whose trigger had
fired. Executing it found **no regression** — but it did find, incidentally, a **pre-existing**
repository-owned defect in `prisma/seed.js` that no register held. Full record:
`PHASE_15_BLOCKERS.md` § **V-9** and residual observation 8.

Separately, there are **7 residual in-repository observations that are reported and not fixed**
*(was 6 — observation 2, the unexecuted rollback runbook, was discharged by V-10, and observation 8
was added by V-9, both on 2026-08-30)*. None is permissive. They are listed in `PHASE_15_BLOCKERS.md` §"Residual" and are *not* counted as
blockers. **Observation 1 — P15-F7a, that nothing binds a runbook to the API it documents — is
unchanged, and V-10 is the second demonstration of what it costs.**

### 7.1 Known unresolved contradictions

**Yes, there are some. They are named rather than silently corrected.** A fresh agent reading these
five documents *and then* opening `ARCHITECTURE.md` or `ROBOTX_SYSTEM_HANDBOOK.md` will hit
statements that contradict this document. That is expected and is registered, not accidental:

- **Inside the five canonical documents: none known.** §16 of the audit compared every
  status, count and classification across MASTER / IMPLEMENTATION_STATE / VERIFICATION_STATE /
  BLOCKERS / CLOSURE_CHECKLIST against the repository on 2026-08-29 and found no surviving
  contradiction. Where a fact was not established, it is written `UNKNOWN` or `NOT VERIFIED`.
- **Between the canonical documents and the wider documentation: 9 registered discrepancies.**
  The Phase-15-owned falsehoods were corrected on 2026-08-29 (worker scheduling, composition root,
  release-gate count, build-gate count, `gate:legacy`'s quoted output, ADR-34's absence from the
  authority table, CI's third omission). The rest — engine-module counts, suite/test counts, and
  repeated "7 build gates / 23 release gates" phrasing scattered through the handbook — are
  **cross-phase drift that Phase 15 does not own** and were deliberately left in place and
  recorded. **Full register with file and line: [`PHASE_15_BLOCKERS.md`](PHASE_15_BLOCKERS.md)
  § *Cross-phase documentation discrepancies*.**

**When this document and `ARCHITECTURE.md` / `ROBOTX_SYSTEM_HANDBOOK.md` disagree about Phase 15,
this document wins** — §1's authority order, rank 3 (the repository) then rank 5 (these five
documents); `ARCHITECTURE.md` ranks itself below both.

---

## 8. Current closure status

Full checklist: **[`PHASE_15_CLOSURE_CHECKLIST.md`](PHASE_15_CLOSURE_CHECKLIST.md)**.

Phase 15 does not close on test results. It closes on the §24 gate table, and **8 of its 24
blocking gates are not green**. Every one of the 8 requires a decision, a measurement, an
attestation or a compute run that no commit in this repository can supply.

---

## 9. Safe next actions

**For a human / the programme (these unblock Phase 15):**

1. **D1 — partially answered 2026-08-30, still BLOCKED, and no longer waiting on the region
   declaration.** The owner has declared two independent campus regions (`rnsit-bengaluru`,
   `jssate-bengaluru`) with names, `kind`, CRS, versions and an adopted boundary feature each, and
   JSSATE's geometry is pinned as an external snapshot. What is now needed is **an escalation
   authority**: the approved boundaries are smaller than one H3 res-8 cell, standard coverage
   returns zero cells so **V-8** fires, `cardinalityException` cannot rescue it, and the owner has
   **refused** both over-assigning containment modes. **No Architecture, Commercial or approval
   authority exists to resolve it, and none may be invented.** Also still outstanding: the RNSIT
   snapshot artefact and every governance record. See
   [`B1_EXTERNAL_INPUT_HANDOFF.md`](B1_EXTERNAL_INPUT_HANDOFF.md) §1.8.
2. **Product + Fleet Engineering answer D3** — the agent classes operated and, per distinct mobility
   model, §2.2's six elements with a real speed model.
3. **Operations answer D8** — extract identity, source, vintage (ISO), refresh cadence,
   re-contraction downtime budget, plus `extract.bbox` and `extract.marginDegrees`.
4. **§22.4's calibration owner** derives the 39 Safety-class values (B8).
5. **Release owner** closes B-M. **Advanced twice on 2026-08-31 and still OPEN.** The jar was
   provisioned and all six configurations were run and recorded per §7.3a
   ([`PHASE_15_BM_TLC_RUN_RECORD.md`](PHASE_15_BM_TLC_RUN_RECORD.md)); then **X4 and X5 were decided
   and implemented** (§15 of the same record), which took the lifecycle configurations from
   *aborting before any verdict* to *reaching verdicts*. **2 of 6 now close, was 1.**
   **Advanced twice more since, and STILL OPEN** — X6 closed on 2026-08-31 (`09e91a5`) and X7 on
   2026-09-01 (`9e1d871`), both as transcription defects. **X4, X5, X6 and X7 are ALL closed.**
   What remains: **Compute/Platform** supplies compute on which `commitment_c2/c3` can converge
   (this workstation could not, and they were **not re-run** by any later pass, deliberately);
   `lifecycle_c2`/`c3` still require authoritative treatment; the boundedness judgement (§7.3a item
   8) is **still unsigned**; a **named human** signs as operator (§7.3a item 4); and **final
   acceptance** (§7.6) is given. ~~**X6** — the newly-visible `Liveness` failure — must be decided
   before the lifecycle half can pass~~ — *superseded: X6 and X7 are both decided, the lifecycle
   half **passes at capacity 1**, and **B-M is now blocked on COMPUTE and ACCEPTANCE, not on any open
   model defect.*** **This is independent of 1–4 above.**
   **Do not report B-M as advanced because a jar was downloaded, and do not report it as advanced
   because X4, X5, X6 and X7 are all decided** — *(this read "because X4 and X5 are decided — the
   lifecycle half still fails, now on X6"; the failure it names is gone and the caution is not)* —
   **two of six configurations close, four do not, and the two commitment configurations are exactly
   where they were.** Closing four model defects moved the lifecycle half from *no verdict* to
   *passing at capacity 1*. It moved B-M's evidence state not at all.

**For an AI coding agent, right now, in this repository:**

- Read the five canonical documents. Nothing else is required to understand current state.
- Answer questions about current state from `PHASE_15_VERIFICATION_STATE.md`, or re-run the
  command yourself. Do not quote a number from `archive/`.
- If asked to *implement* something in Phase 15: **no unblocked implementation work is identified
  in `PHASE_15_BLOCKERS.md` — and that is not the same as none existing.** Check
  **`PHASE_15_CLOSURE_CHECKLIST.md` §C** as well: it is where V-10 sat, unexecuted, through six
  passes that all read the blocker table. Every §C row that is `NOT EVALUATED` with an owner
  inside this repository is candidate work. Confirm against both before writing code.
- **§C was swept on 2026-08-30 after V-10 closed, re-swept by the final closure audit later the
  same day, and its last internal row was executed the same day as closure item V-9. All five open
  rows are now external by construction.** **V-5** is the release owner's evidence re-collection at
  a committed tree, **V-7** is B-M (needs `tla2tools.jar` and compute), **V-8** is B-P (needs an
  operating fleet), and **V-6** is per-pass mutation testing with no pass to attach to.
  **V-9 — the Phase 0–14 cross-phase re-verification — CLOSED 2026-08-30.** Its trigger had fired
  and it had never been run; it has now been run and **no regression was found**. Scope was derived
  by intersecting all 22 Phase 0–14 harnesses' transitive `require()` closures with the 11 changed
  source files — 4 carry a changed module, 18 carry none — and **7 harnesses were executed on a
  disposable PostgreSQL cluster for 315/317 checks**. The only 2 failures are
  `phase5ExpirySemantics` FINDING assertions that §17.4's ladder *does not exist*, which T1-04
  deliberately made false; the ladder was proven live at 72/72 and the `LADDER_EXHAUSTED → FAILED`
  row was **not** taken. **No code was changed; the digest is unmoved.** Full record:
  `PHASE_15_VERIFICATION_STATE.md` **§7c**. *(This bullet previously said V-9 was "repository-owned,
  actionable, and unrun" with result "UNKNOWN"; before that, that it "has no trigger". Both are
  superseded — the trigger fired and the row is now measured.)*
- **What V-9 changed about this section's standing advice: nothing, and one thing.** No §24 gate,
  blocker or verdict moved. But V-9 **did** surface a genuine repository-owned actionable defect
  that is **not Phase 15's and was in no register** — `prisma/seed.js` swallows its own failure and
  exits 0 after a partial seed, because 3 register entries carry a `changeClass` the
  `ConfigChangeClass` enum does not define (pre-existing since 2026-08-09, **proven**, not assumed).
  It is residual observation 8 in `PHASE_15_BLOCKERS.md`. **This is the fourth consecutive pass in
  which the next genuine item was outside the blocker table** — so keep reading §C *and* the
  residual list, not only §7 of this file.
- **Do NOT run `npm run release:gates` to make the tree look green.** The checked-in evidence
  collection is genuinely stale and `release:verdict` genuinely reads 0/17/7; the fix is the
  release owner's re-collection at a **quiescent, committed** tree. **The verdict is BLOCKED either
  way** — recollecting changes the rendering, not the outcome. *(This bullet also argued that "a
  collection taken against this uncommitted tree would be voided by the next source edit". **That
  premise expired** with the snapshot `7335260`, and it is corrected here rather than deleted —
  because **a committed tree is not an instruction to collect.** `engine_decision_path_wired` is RED
  on its own merits and the 7 `NOT_EVALUATED` rows have nothing filed, so a fresh collection renders
  16/1/7 and still reads BLOCKED. It remains the release owner's step and not a documentation act.)*
- If the repository has changed since the digest in §4, **re-measure before answering**. The digest
  is how you tell.

---

## 10. Forbidden actions

These are not stylistic preferences. Each corresponds to a defect a previous pass either committed
or came close to committing.

| Do NOT | Why |
|---|---|
| Select, rank, recommend or hint at a routing engine | B1 Step 5 is a decision on recorded evidence, in an ADR. No evidence exists |
| Invent an operating region, boundary, CRS or region kind | D1. `prisma/seed.js`'s `SEED_SPATIAL_MAP` / `RGN-BLR` is a **Phase 2 containment demonstration, not production configuration** |
| Invent a mobility model, speed model or speed data | D3. The only `MobilityModel` in the repository is a seed whose `speedModel` is a note deferring to this decision |
| Invent an extract vintage, cadence or bbox | D8 |
| Derive, edit or reclassify any calibration value | B8. §22.3 forbids automated change of a Safety-class parameter |
| Change any threshold | Every threshold in the §24 table and the register is governed |
| Weaken a gate, or convert `NOT_EVALUATED` → `GREEN` | `NOT_EVALUATED` blocks exactly as `RED` does (§24), and is kept distinct on purpose |
| Use `DEGRADED_ROUTING` as a substitute for a routing service | It is a degradation ladder rung, not an engine |
| Write a stub, fake or in-process router to make `gate:composition` pass | Starting the coordinator on invented travel times assigns real work on invented data |
| Manufacture a caller for `assertVersionInKey` (A9) | Its seam is a Phase 8 module that does not exist |
| Fabricate an observation window, soak record, rehearsal record or attestation | These are the four gates the whole programme has classified as un-closable by commit |
| Put `docs/` into the source digest scope | Every prose edit would void a ~25-minute evidence collection. See B-M/P15-F7a discussion |
| Begin Phase 16 implementation | Phase 16's only prerequisite is Phase 15, which is not closed |
| Re-open a blocker because an archived report gives an older classification | The archive is frozen history. §11 explains |
| Mark a blocker closed because an archived report says "FIXED" | Six passes have proven a historical "FIXED" insufficient |

---

## 11. Documentation map

### The V1 boundary — read this before deciding whether a piece of work is Phase 15's

| File | Answers |
|---|---|
| **[`../v1/V1_CONTRACT_AND_STOP_CONDITION.md`](../v1/V1_CONTRACT_AND_STOP_CONDITION.md)** | **The V1/V2 boundary and the finite V1 stop condition** (2026-09-01). Before it, this programme's only exit condition was the §24 gate table — a **production release** condition — and there was no smaller milestone to aim at, which is most of why "what remains" has read as unbounded. V1 is a *smaller* claim that sits below Phase 15, not an alternative route through it: **it weakens no §24 gate and moves no blocker.** Read §D for the traced request→dispatch call graph and where it actually breaks, §F.1 for which B1 decisions V1 genuinely needs (four values) and which are strictly production, and §I for the eight-condition stop condition. **Phase 15's verdict is unchanged: IMPLEMENTATION CLOSED · RELEASE BLOCKED.** |

### Canonical — read these

| File | Answers |
|---|---|
| **`PHASE_15_MASTER.md`** (this file) | Navigation + current truth + what not to do |
| **`PHASE_15_IMPLEMENTATION_STATE.md`** | What actually exists in the repository, by subsystem |
| **`PHASE_15_VERIFICATION_STATE.md`** | What has actually been proven, with command + exit code + date + tree |
| **`PHASE_15_BLOCKERS.md`** | What prevents closure, who owns it, what closes it |
| **`PHASE_15_CLOSURE_CHECKLIST.md`** | The exact exit conditions and the current verdict |

### The B1 / B-M operational handoff — read before doing any B1 or B-M work

| File | Answers |
|---|---|
| **[`B1_EXTERNAL_INPUT_HANDOFF.md`](B1_EXTERNAL_INPUT_HANDOFF.md)** | **The single operational handoff for the external inputs.** What D1, D3 and D8 require field by field, who owns each, what evidence substantiates it, the operator deployment-module contract, B1's execution order and stop conditions — and, in §7, **B-M**: its independence from B1, its `NOT MEASURED / OPEN` state, what must be recorded, and who accepts it. **Do not write a second handoff.** |
| **[`PHASE_15_BM_TLC_RUN_RECORD.md`](PHASE_15_BM_TLC_RUN_RECORD.md)** | **The §7.3a run record for B-M, and the retained raw TLC output.** The tool artefact and its SHA-256, JDK/machine, the provenance discrepancy in the historical 2026-08-15 run, all six configuration results with the constants actually used, property coverage including the **G5** gap, boundedness, and the two new findings **X4** and **X5**. **The raw output is retained verbatim in its §12** — do not summarise it away, and do not read it as a discharge. It is *evidence input* to a §7.6 decision that has not been made |

### Upstream authorities — unchanged by this consolidation

- `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` (FROZEN)
- `IMPLEMENTATION_EXECUTION_PLAN.md`
- `docs/adr/` — in particular **ADR-11** (routing), **ADR-33** (B1 traversal-domain scope),
  **ADR-34** (cutover rehearsal purpose)

### Historical — `archive/`

15 superseded Phase 15 reports, indexed at **[`archive/README.md`](archive/README.md)**.

---

## 12. Historical archive policy

1. Every archived document is preserved **byte-for-byte**. None was edited, annotated, softened or
   truncated. They are audit records of what was believed at a point in time, and several of them
   contain a later pass's correction *of* an earlier pass — that correction history is itself the
   evidence, and rewriting it would destroy it.
2. Because they are unedited, **no archived file carries a banner saying it is archived.** Their
   status is declared in `archive/README.md`, which names each file, the tree it was measured
   against, and why it is superseded. **Read `archive/README.md` before opening any archived file.**
3. Open an archived report only to answer *"what did we believe on date X and why"*. Never to
   answer *"what is true now"*.
4. Nothing was deleted. No two Phase 15 reports were byte-identical, and every one contains unique
   historical evidence.

---

**TRUTH > GREEN.**

# PHASE 15 IMPLEMENTATION — CLOSED. RELEASE — BLOCKED. PHASE 16 — NOT READY.
