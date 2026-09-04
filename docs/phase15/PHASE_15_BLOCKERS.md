# Phase 15 — Blocker Register

**The canonical list of what prevents Phase 15 from closing.**

> Current source of truth for navigation and verdict: **[`PHASE_15_MASTER.md`](PHASE_15_MASTER.md)**.
> Evidence for every "last verified" line below: [`PHASE_15_VERIFICATION_STATE.md`](PHASE_15_VERIFICATION_STATE.md).

**Last verified:** **2026-09-01** · **Tree:** digest **`1b301e285ad7dcd0…` (576 files)**, HEAD
**`9e1d871`** + the V1 audit's source edits. **`d033038cb261c3de…` / 573 is superseded** — it held
through four commits (`ef0d65f`, `22411e8`, `09e91a5`, `9e1d871`), all of which touch only `docs/`
and `formal/`, and was then moved by the V1 audit's I20 and N13 fixes. **No blocker in this register
moved with it**: B1, B8, B-P, B-O, B-M, X3 and A9 are exactly where they were, and neither I20 nor
N13 was ever a blocker here — which is the fourth consecutive pass in which the genuine item was
outside this table. *(This line said HEAD **`7335260`** and was three commits stale, and before that
"`67b7c7c` + uncommitted"; earlier still, 2026-08-29 at `431010ace188c4b1…` / 565 / `b68dc5d`. **The
digest, not the hash, is what makes a number on this page transferable** — it has held through four
consecutive HEAD corrections.)*
**Re-verified 2026-08-29** by the documentation-integrity audit: every blocker below re-derived from
the current repository; blocker count and classifications unchanged. The audit added the
§ *Cross-phase documentation discrepancies* register at the end and found **no new blocker**.

> **CURRENT TREE, 2026-09-04 — supersedes the HEAD and digest stated in this row.** **HEAD `8910818`** · digest **`011049f7a504fa70d05bfc2e87a662f897cefdf4fbd5a58b3e861fff5eba3b42` / 577 files** · `npm test` **165 suites / 7 336 tests / 0 failures** · `npm run gates` **7 PASS / 1 FAIL** (`gate:composition`) · `routing:readiness` **BLOCKED**.
>
> **Application source HAS been modified since `7335260`** — the claim that it had not held through `9e1d871` and is now false. Five V1 commits have landed: `2b367e4` (I20 + N13), `cb6517b`, `27d3470` (E-7), **`e38fe5b` (E-8 — the terrain and ETA-spread fail-opens)** and **`8910818` (E-8b — the coordinator's pinned snapshot)**. See `docs/v1/V1_CONTRACT_AND_STOP_CONDITION.md` §J.0.
>
> **No §24 gate moved. RELEASE: BLOCKED, unchanged.** B1, B8, B-P, B-O, B-M, X3 and A9 are all where they were, and no formal-verification run was repeated.


> **Updated 2026-08-30 by closure item V-10** (tree now digest `d033038c…`, 573 files). **The
> blocker count and every classification are unchanged.** What moved:
> - **B1 gained a fifth item of required engineering work** — the coordinator does not read the
>   per-shard cutover switch, so a Rollback A does not stop a running coordinator. Filed, not
>   implemented; see B1 item 5.
> - **Residual observation 2 is discharged** — the rollback runbook has now been executed
>   against the current API. Observation 1 (**P15-F7a**) is unchanged and still open.
> - **A new closed section, § *V-10*,** records the five defects it found.
> - **`release-evidence.json` has aged out.** `release:verdict` now reports 0 green / 17 red /
>   7 not evaluated — every RED for `[STALE]`, not for a gate failing. No blocker moves; the
>   verdict was and is BLOCKED. See `PHASE_15_VERIFICATION_STATE.md` §3.0.
>
> **Re-audited 2026-08-30, after V-10 closed** — every blocker below re-derived from the current
> tree (digest `d033038c…`, 573 files; `gate:composition` exit 1 at **19** registered workers;
> `release:verdict` exit 1 at 0/17/7). **The blocker count is still 7, every classification is
> unchanged, 0 are repository-owned and actionable, and no new blocker was found.** The audit
> corrected stale *numbers* in this register — the worker count in B1's evidence, and rows C1, C3
> and C7 of the cross-phase table — and **changed no finding, no severity and no owner.** In
> particular **nothing in § *V-10* was altered**: its five findings stand exactly as recorded.

## Summary

| Count | |
|---:|---|
| **7** | Open blockers — **was 8; X7 CLOSED 2026-09-01 (fourth pass) as a transcription defect, and no new blocker was opened** |
| **0** | REPOSITORY-OWNED and actionable |
| **2** | EXTERNAL (B1, B8) |
| **1** | SPECIFICATION / ADR / SAFETY (X3) — X1/T1-04, **X4**, **X6** and now **X7** are closed |
| **0** | FORMAL-VERIFICATION CONFIGURATION — **X5 is decided and implemented** |
| **3** | EVIDENCE / OPERATIONS (B-P, B-O, B-M) |
| **1** | REPOSITORY-OWNED but correctly deferred to another phase (A9) |
| **0** | NOT EVALUATED |

> ### ⚠ Updated 2026-09-01 (FOURTH pass) — **X7 CLOSED as a transcription defect: the §4.6 cancellation latch was never modelled. `lifecycle_c1` now closes with every declared property PASS. B-M REMAINS OPEN.**
>
> X7 was re-investigated against the frozen specification, the shipped implementation and a
> controlled `D3 → D6` experiment before anything was changed. **The previous three-reading framing
> was wrong about where the defect lived**, and is superseded — not because a reading was chosen,
> but because the question it asked turned out not to be the one that mattered.
>
> | | |
> |---|---|
> | **X7 — CLOSED** | **Reclassified from SPECIFICATION AMBIGUITY to TRANSCRIPTION DEFECT.** The defect is **not** that `STRANDED_*` is necessarily non-cancellable. It is that `formal/lifecycle.tla` **did not model §4.6 step 1's `cancel_requested_at` at all**, which made `Cancel` and `CancelWithCustody` indefinitely repeatable against the same Leg. §4.6 makes cancellation a **latch**: step 1 writes `cancel_requested_at` and increments the version in one transaction, step 2 guards every subsequent transition on it, **nothing anywhere clears it**, and step 5 forbids a requester cancelling the Legs cancellation itself creates. Fixed in `formal/lifecycle.tla` only |
> | **The shipped implementation already had the latch** | `Backend/src/engine/lifecycle/cancellation.js:119-130` writes `cancelRequestedAt` under a version-conditional `updateMany`; `lifecycle/transitions.js:664-669` `cancellationGuard` reads it; **no write anywhere in `Backend/src/` clears it** — the sole `cancelRequestedAt: null` is `domain/mappers/legacyTask.js:139`, constructing a fresh Leg at `version: 0`. The shipped system therefore forbids the X7 cycle **through the latch**, not through any `STRANDED_*`-specific rule. **No `Backend/` file changed** |
> | **`lifecycleModel.js` remains a separate, permissive-model observation** | `tests/engine/helpers/lifecycleModel.js:350` exempts `CANCEL_REQUEST` itself from `cancellationGuard` (`if (event !== transitions.EVENT.CANCEL_REQUEST)`), so the executable checker still admits a repeated cancellation request that the shipped engine does not. **Recorded, not fixed here** — no test changed |
> | **The `STRANDED_*` cancellation question is now NON-BLOCKING** | It survives as *Question A*, a recorded modelling question. It does **not** need to be resolved to fix X7, and it was **not** resolved. The repair adds **no** `STRANDED_*` special case: a stranded Leg that has never been cancelled may still be cancelled, once |
>
> **The controlled experiment (D1–D6).** D1/D2 reproduced the previous graph exactly, confirming the
> scratchpad copy faithful. **D3** — pristine `Spec`, 1 Leg: `Liveness` **VIOLATED** by the
> `CancelWithCustody ↔ Strand` lasso. **D4** — add *only* the §4.6 latch: `Safety`,
> `TerminalIsFinal` and `Liveness` all **PASS**. **D5** — D4 at the `c1` shape: **COMPLETE graph,
> PASS**, 777 942 states / 187 289 distinct / depth 43 / **0 on queue**. **D6** — remove *only* the
> latch guard: `Liveness` **VIOLATED**; mutant killed.
>
> **Verification on the repository as checked in.** `formal/lifecycle_c1.cfg`, **unmodified**,
> against the changed module: **777 942 / 187 289 / depth 43 / 0 on queue, exit 0, "No error has
> been found"** — reproducing D5 exactly. `Safety` **PASS**, `TerminalIsFinal` **PASS**, `Liveness`
> **PASS** (all three conjuncts). **The X7 lasso is gone.** **X7 mutant re-run against the checked-in
> `c1` config: KILLED** (exit 13, `Liveness` violated, lasso `CancelWithCustody(l1) ↔ Strand(l1)`
> with `custody = HELD` throughout). Full record: **§17** of
> [`PHASE_15_BM_TLC_RUN_RECORD.md`](PHASE_15_BM_TLC_RUN_RECORD.md).
>
> **`EveryLegSettles` and `CustodyNeverLost` are byte-identical to their previous text — neither was
> weakened.** No `.cfg` changed; `CHECK_DEADLOCK FALSE` is still absent and deadlock checking ran at
> its default; **no fairness was added on `Recovered`**; no boundedness, timeout or artificial
> progress constant was added. X4/X5/X6 modelling is intact and byte-identical.
>
> ### B-M REMAINS OPEN. X7 closing is NOT B-M closing.
>
> B-M requires the complete capacity 1/2/3 evidence and its acceptance. Current state:
> **`commitment_c1` PASS · `commitment_c2` UNKNOWN · `commitment_c3` UNKNOWN · `lifecycle_c1` now
> PASS · `lifecycle_c2` and `lifecycle_c3` still require authoritative treatment.** `commitment_c2`
> and `c3` are **deliberately unaffected and were not re-run** — `commitment.tla` neither `EXTENDS`
> nor `INSTANCE`s `lifecycle.tla` and no `.cfg` changed, so no commitment result can move. **2 of 6
> configurations now close, was 1.** §7.3a items 4 (named operator), 8 (boundedness) and 10
> (acceptance) remain unsatisfied and **G5 is still covered by no TLC run**.
>
> **No `Backend/` file, test, `.cfg`, specification or ADR changed. No independent safety-engineering
> or release-owner approval exists for X7, and none is claimed.**

> ### ⚠ Updated 2026-08-31 (THIRD pass of the day) — **X6 CLOSED as a transcription defect. X7 opened. `Liveness` still fails.**
>
> X6 was investigated against the frozen specification, the shipped implementation and the
> executable checker before anything was changed, and it came back **a transcription defect on both
> counts it was suspected of**:
>
> | | |
> |---|---|
> | **X6 — CLOSED** | `formal/lifecycle.tla` transcribed **neither** of §4.4's two `QUEUED` assignment-deadline rows (`:1122`, `:1123`) — `TimerFires` had no `QUEUED` case at all — **and** `WF_vars(Next)` does not transcribe §24.2's "given fair timer firing". Both fixed in `formal/lifecycle.tla` only: a monotone `ladder` variable, `LadderAdvance`/`LadderExhausted`, and `SF` on those two actions. **The shipped implementation already had all of it** (`transitions.js:203-217`, `fairness/ladder.js`, `expiryActions.js:373-425`, `leaderWorkers.js:416`) and **no `Backend/` file changed** |
> | **X7 — NEW** | A `STRANDED_*` Leg can be cancelled back into `ABORTING` and re-stranded for ever, holding custody the whole time. **`CustodyNeverLost` and `EveryLegSettles` still fail on this, and on nothing else.** §4.4's cancel row says "any non-terminal"; its stranded rows enumerate exits that do not include `ABORTING`; §24.2 states the custody clause unconditionally. **Genuinely ambiguous — reported, not decided** |
>
> **What actually moved.** `QueuedLegsProgress` now **PASSES on a complete state graph** at capacity
> 1 (676 854 states / 156 941 distinct / depth 43 / **0 on queue**), with `Safety` and
> `TerminalIsFinal` also passing there. **`Liveness` as a conjunction still FAILS**, so the lifecycle
> half of B-M still does not pass. **7 model mutants built, 7 killed**, including M1 and M2 — which
> re-confirm that the X4 widening and X5's `TaskQuiescent` are each still load-bearing.
>
> **`EveryLegSettles` was not weakened, no `.cfg` was edited, `CHECK_DEADLOCK FALSE` is still
> absent, and no boundedness or timeout constant was added** — `LadderSteps == 8` is §17.4's own
> rung count, written as a definition rather than a CONSTANT so that no configuration supplies it.
>
> **No `Backend/` file changed. The source digest is unmoved at `d033038cb261c3de…` / 573 files,
> and the Phase 15 implementation freeze at `c27a75c` is intact.** **No independent
> safety-engineering or release-owner approval exists for X6, and none is claimed.**

> ### ⚠ Updated 2026-08-31 (second pass of the day) — **X4 and X5 DECIDED, IMPLEMENTED and VERIFIED. X6 opened.**
>
> The two decisions the morning's TLC execution referred out were **taken by the sole project
> owner/reviewer**, acting as the project's specification and verification authority, and
> implemented in **`formal/lifecycle.tla` and nothing else**.
>
> | | |
> |---|---|
> | **X4** | **DECIDED: the `STRANDED_*` states are custody-bearing; `HELD` is lawful while stranded.** Implemented by separating `CustodyLawfulStates` (the invariant's domain) from `CustodyBearingStates` (a guard used by `Dispute` and `TimerFires`, left untouched). **The frozen §4.4 transition table already entered a stranded state under the guard "custody `HELD`" — this was a transcription defect, not an open safety question** |
> | **X5** | **DECIDED: terminal deadlock freedom is a genuine §24.2 obligation.** Implemented by an explicit `TaskQuiescent` stuttering action. **`CHECK_DEADLOCK FALSE` was REJECTED and no `.cfg` was edited** |
> | **X6 — NEW** | With the deadlock abort gone, the lifecycle liveness properties were evaluated **for the first time ever** and **`Liveness` FAILS**: a Leg can be re-planned forever (`Plan → Offer → Reject`) and never settle. Pre-existing, previously masked, **deliberately not decided in the pass that found it** |
>
> **Verification:** `Safety` is now **exhaustive and clean at all three capacities** under the
> safety-only diagnostic (c3: 16 557 136 states / 1 680 163 distinct / depth 47 / 0 left on queue).
> **4 model mutants built, 4 killed** — including M1, which reverts *only* the X4 widening and
> reproduces the **original depth-9 `STRANDED_OBSTRUCTING` + `HELD` counterexample exactly**.
>
> **No `Backend/` file changed. The source digest is unmoved at `d033038cb261c3de…` / 573 files,
> and the Phase 15 implementation freeze at `c27a75c` is intact.**
>
> ### ⚠ NO INDEPENDENT SIGN-OFF EXISTS, AND NONE IS CLAIMED.
> This is a **solo project** — one developer, one tester, one reviewer. The separate **safety
> engineer**, **frozen-specification owner** and **release owner** of §7.6 **do not exist as
> distinct individuals**. **No independent safety-engineering acceptance and no independent
> release-owner acceptance was obtained, simulated or inferred.** §7.3a items 4, 8 and 10 remain
> formally unsatisfied. See the sign-off note in the **X4** entry.
>
> **B-M did NOT close.** `commitment_c2`/`c3` were not re-run and are still UNKNOWN; the lifecycle
> half now fails on **X6** instead of aborting on X5. **Do not read "X4 and X5 decided" as "B-M
> discharged".**

> ### ⚠ Updated 2026-08-31, FIRST pass of that day — TLC was executed for the first time. **B-M did not close. Two new blockers opened.**
>
> *(Retained as the historical record of the morning's execution. **X4 and X5 were decided and
> implemented later the same day** — see the banner above; this block is what was true when they
> were opened, and is not rewritten to pretend otherwise.)*
>
> `tla2tools.jar` was provisioned (v1.8.0 release asset, SHA-256
> `eabd140a…533a`) and **all six checked-in configurations were run on the frozen tree**. Full
> §7.3a record with the **raw TLC output retained verbatim**:
> **[`PHASE_15_BM_TLC_RUN_RECORD.md`](PHASE_15_BM_TLC_RUN_RECORD.md)**.
>
> | | |
> |---|---|
> | **B-M** | **STILL OPEN — evidence state NOT MEASURED / OPEN.** 1 of 6 configurations closed. `commitment_c1` exhaustive PASS; `commitment_c2`/`c3` **UNKNOWN**, did not converge; `lifecycle_c1`/`c2`/`c3` **FAIL**. No independent acceptance. **The compute requirement is NOT satisfied merely because TLC was provisioned** |
> | **X4 — NEW** | `lifecycle.tla`'s `CustodyMatchesState` is contradicted by `Strand` and `TimerFires`, while `Recovered` is written to resolve the very state it forbids. **SPECIFICATION / FORMAL MODEL / SAFETY.** Explicitly **separate from B-M** |
> | **X5 — NEW** | The three checked-in `lifecycle_c*.cfg` abort on TLC's default deadlock check before any declared property is evaluated. **FORMAL-VERIFICATION CONFIGURATION.** Explicitly **separate from X4 and from B-M** |
>
> **No source file, `.tla`, `.cfg`, schema, test or configuration was changed.** The Phase 15
> implementation freeze at `c27a75c` is intact and its verdict is unchanged. `formal/` and `docs/`
> are outside the source-digest scope, so **the digest `d033038c…` did not move.**
> **B1, B8, B-P, B-O, X3 and A9 were not touched** — only the counts above changed, arithmetically.

Plus **7 residual in-repository observations** — reported, not fixed, none permissive
*(was 6; observation 2 was discharged by **V-10** and **observation 8 was added by V-9** on
2026-08-30 — a pre-existing silent-partial-seed defect that is not Phase 15's)*. They are listed
at the end and are **not** counted as blockers.

> **Updated 2026-08-30 by closure item V-9** — the Phase 0–14 cross-phase re-verification,
> executed for the first time. **No blocker moved, no classification changed, and no new blocker
> was found.** 7 Phase 0–14 harnesses on a disposable cluster, **315/317**, both failures being
> `phase5ExpirySemantics` FINDING assertions whose premise T1-04 deliberately invalidated. **No
> code was changed and the digest is unmoved.** What moved: a new closed section, § *V-9*, and
> **residual observation 8**. Full record: `PHASE_15_VERIFICATION_STATE.md` §7c.

**Standing rule for this register.** A blocker is not re-opened because an archived report carries
an older classification, and not closed because an archived report says "FIXED". Each entry below
was re-derived from the current repository on 2026-08-29.

> **Scope of the 2026-08-31 FIRST update, stated so it is not overread.** That pass executed TLC and
> nothing else. It **re-derived only B-M**, and it **added X4 and X5**. It did **not** re-derive
> **B1, B8, B-P, B-O, X3 or A9** — those entries are unchanged and still carry their own
> "Last verified" dates. The header's tree line is unchanged for the same reason: the pass changed
> no source, so the digest did not move. HEAD is now **`c27a75c`**, the Phase 15 freeze commit.

> **Scope of the 2026-08-31 SECOND update — the X4/X5 decision pass — stated to the same standard.**
> It **decided and implemented X4 and X5**, and it **opened X6**. It touched
> **`formal/lifecycle.tla` and no other repository file.** It did **not** re-derive **B1, B8, B-P,
> B-O, X3, A9 or B-M** — B-M's evidence state is carried forward unchanged except for the lifecycle
> rows, and `commitment_c2`/`c3` were **not** re-run. **No release evidence was re-collected**, by
> instruction. The digest did not move, because `formal/` is outside its scope.

---

## B1 — No routing engine is selected

**Status:** OPEN
**Classification:** **EXTERNAL**
**Owner:** Operations + Commercial (D1) · Product + Fleet Engineering (D3) · Operations (D8)
**First discovered:** 2026-08-08 (`PHASE_15_B1_ROUTING_DECISION_REPORT.md`). Originally recorded as
in-repository composition work (D-4 / D-5); **reclassified to EXTERNAL on 2026-08-22** and
re-confirmed EXTERNAL by every pass since.
**Last verified:** 2026-08-29

**Current evidence:**
- `npm run gate:composition` → exit **1**, **1 violation across 19 registered workers**:
  `coordinator` `[LEADER_ONLY_NOT_COMPOSABLE]`, owner declared **EXTERNAL** by the gate itself.
  *(Re-run 2026-08-30. Was "1 violation of 18"; T1-04 added a 19th worker and **the violation
  count did not move**.)*
- `npm run release:verdict` → §24 gate `engine_decision_path_wired` **RED**.
- `npm run routing:readiness` → `OVERALL: BLOCKED`; D1, D3, D8 each BLOCKED; Steps 1, 3, 4, 5
  BLOCKED; Step 2 PASS.
- `tools/verify/phase15CurrentTree.js` check **G2** confirms coordinator and shadow remain
  uncomposable.

**Why it blocks:** `coordinator`'s round loop needs `expandCandidates`, `pricedCandidateFor` and
`commit`. The first two resolve through `plan/insertion.js → planBuilder.hopsForSequence →
routing/cellPairCache.hopsFor` to an injected `route` function — the routing engine. With no engine
selected, the Tier 0 decision path has no leaf. `engine_decision_path_wired` is one of 24 blocking
§24 gates.

**Three workers, not one, are held by B1.** `gate:composition` fails on `coordinator` alone,
because it is the only one *declared* `LEADER_ONLY` and therefore expected to start. Two more are
`DEFERRED` on the same dependency and so pass the gate by declaration:

| Worker | Readiness | Consequence of B1 |
|---|---|---|
| `coordinator` | `LEADER_ONLY` | Gate violation. No round can execute |
| `shadow` | `DEFERRED` | **`shadow_agreement` cannot begin accumulating evidence at all.** The system is not merely short of the 14-day window — it cannot start the clock. This is why **B-P** is gated by B1 |
| `charger_reachability` | `DEFERRED` | Scheduling it needs the routing client this process does not construct (Phase 8's `routing/client.js`) |

Full readiness breakdown: [`PHASE_15_IMPLEMENTATION_STATE.md`](PHASE_15_IMPLEMENTATION_STATE.md)
§ *Workers and the composition root*.

**Can repository code solve it?** **No.** Selection is B1 Step 5: a choice made on recorded
benchmark evidence and written into an ADR. Step 3 evidence cannot be produced because Step 1
(deploy each candidate against the target region extract, build per-profile contraction hierarchies)
requires a region that does not exist.

**Required external input.** The field-by-field requirements, per-field ownership and evidence, the
operator deployment-module contract and B1's execution order are in
**[`B1_EXTERNAL_INPUT_HANDOFF.md`](B1_EXTERNAL_INPUT_HANDOFF.md)** — the single operational handoff
for this blocker. Summary only below.

| | Owner | What is missing |
|---|---|---|
| **D1** | Operations + Commercial | **Partially answered 2026-08-30 — still BLOCKED.** The owner has declared two independent campus regions with `regionId`, `name`, `kind: CAMPUS`, `crs: OGC:CRS84`, version + date, and an adopted boundary feature each; JSSATE's geometry is pinned as an external snapshot. **Still missing:** the RNSIT snapshot artefact, the cell cover (see below), and every governance record — no approval, no Commercial confirmation, no Architecture approval exists. Full record: [`B1_EXTERNAL_INPUT_HANDOFF.md`](B1_EXTERNAL_INPUT_HANDOFF.md) §1.8 |
| **D3** | Product + Fleet Engineering | The agent classes this deployment operates and, per distinct mobility model, §2.2's six elements with a real speed model over `roadClass`, `gradient`, `surface`, `payloadMass`, `congestion`, `weather` |
| **D8** | Operations | Extract identity, source, vintage (ISO date, never a file timestamp), refresh cadence, re-contraction downtime budget, **plus `extract.bbox` and `extract.marginDegrees`** (read by validator V-13) |

D1 additionally releases: the cell cover (Engineering), the charger catalogue (Ops / Charging — now
required, not optional), V-11 disjointness, V-12 containment, V-13 margin, D2's residual (N23), and
`projectCell()` (N27).

**D1's live sub-blocker since 2026-08-30 is architectural, not a missing input.** The approved
JSSATE boundary is ≈0.1022 km² against a ≈0.7373 km² H3 res-8 cell, so standard `polygonToCells`
returns **zero** fine cells and **V-8 fires** — and `cover.cardinalityException` cannot rescue it,
because that exception is read only inside the V-9 branch. The owner has **refused** both
over-assigning containment modes (`containmentOverlapping`, `containmentOverlappingBbox`) and has
escalated the coverage-semantics question, but **the escalation target is NOT DEFINED**: RobotX has
no separate Architecture, Commercial or approval authority, and none may be invented or inferred.
So D1 is currently blocked on a **governance vacuum**. Measurements, refusals and consequences:
[`B1_EXTERNAL_INPUT_HANDOFF.md`](B1_EXTERNAL_INPUT_HANDOFF.md) §1.8.3–§1.8.5. **D3 and B-M are not
behind this escalation.**

**Required engineering work after the dependency arrives:**
1. B1 Steps 1, 3, 4 — deploy, benchmark, record.
2. B1 Step 5 — write the ADR selecting the engine.
3. `src/engine/routing/client.js` — the production Routing Service client (§5.2's degradation ladder,
   §18.3 B6's uniform-treatment rule, the `route(parts)` seam). **Phase 8**, also blocked by N25/N26.
4. Composition-root construction at `server.js`: `evaluateExact`, `pricedCandidateFor`,
   `hopsForSequence`, plus the routing client and charger precompute trigger. **Estimate as
   composition-root work, not adapter wiring.**
5. **NEW, added by V-10 on 2026-08-30 — the coordinator does not read the per-shard cutover
   switch, so a Rollback A does not stop a running coordinator.** Measured on the current tree:
   `cutover.engine_enabled` (via `cutover/enabled.js`) has exactly **four** production consumers
   — `services/task.service.js` (intake, 503 `ENGINE_NOT_LIVE`), `cutover/agentGate.js` (all five
   socket handlers), `controllers/health.controller.js` (reporting) and `cutover/store.liveShards()`
   (the guardrail controller's own enumeration). **`workers/coordinator.worker.js` is not among
   them**: `runRound()` takes no configuration snapshot and asks no cutover question, and
   `server.js` gates the coordinator lifecycle on `ENGINE_ENABLED` — the *process* half — only.
   So Rollback A stops new work **entering** a shard and does not stop a coordinator already
   draining that shard's `WorkQueue`.

   **It is filed here, under B1, and deliberately not implemented.** The gate needs a
   configuration snapshot injected into a worker that **cannot be composed at all** until B1
   selects an engine. Writing it now would produce a guard whose only caller does not exist —
   the defect class this register was created to stop (Phase 14 wrote nine such guards, tested
   all, called none), and the same reasoning that keeps **A9** deferred. `docs/runbooks/rollback.md`
   §2 now states plainly that the stand-down is not enforced by configuration, instead of
   promising it.

   *It is invisible today rather than harmless: no coordinator runs, because `leaderWorkers`
   refuses to compose one. The two states are indistinguishable in this deployment, which is
   exactly why five passes did not notice.*

**Do not:**
- Select, rank, recommend or hint at an engine. `b1Readiness.js` explicitly refuses to, and so must you.
- Invent a region, boundary, CRS, speed model, extract vintage or bbox.
- Treat `prisma/seed.js`'s `SEED_SPATIAL_MAP` / `RGN-BLR` as production configuration. It is a Phase 2
  containment demonstration: four fine cells, placeholder cell ids, never published as a config version.
- Write a stub, fake or in-process router to make `gate:composition` pass. Starting the coordinator
  against an invented router assigns real work on invented travel times.
- Use `DEGRADED_ROUTING` as a substitute for a routing service.

**Closure condition:** D1, D3 and D8 answered; Steps 1/3/4 executed and recorded; Step 5 ADR
written; the routing client and composition root built; `gate:composition` exits 0;
`engine_decision_path_wired` GREEN.

---

## B8 — Safety-class parameters are not DERIVED

**Status:** OPEN
**Classification:** **EXTERNAL**
**Owner:** §22.4's named calibration owner
**First discovered:** 2026-08-08 · **Last verified:** 2026-08-29

**Current evidence:** `npm run gate:calibration` → exit **1**, `FAIL — 39 blocking finding(s)`.
**250 registered entries: 52 DERIVED, 160 PROVISIONAL, 38 UNCALIBRATED; 54 Safety-class**
— **re-run 2026-08-30 at digest `d033038c…`.**
`phase15CurrentTree.js` check **G3** confirms the gate and the publish validator agree that B8
blocks the cutover (190 launch-gate findings; defaults refused by V9).

> **The register grew and B8 did not — measured, not assumed.** It held **242** entries
> (152 `PROVISIONAL`) on 2026-08-29. **REMEDIAL PHASE T1-04 added exactly 8**, all
> `PROVISIONAL`, all §17.4 ladder-rung fractions:
> `ladder.step_1_widen_radius_fraction` … `ladder.step_8_alternative_modality_fraction`.
> **None of the 8 is Safety-class**, which is why the two numbers that matter here —
> **39 blocking findings and 54 Safety-class entries — are unchanged.** T1-04 added no
> Safety-class calibration debt, and this row's totals had simply never been re-measured
> after it. Nothing about B8's ownership, closure condition or classification moves.

**Why it blocks:** §22.4 — no Tier 0 parameter may be `PROVISIONAL` or `UNCALIBRATED` at launch.
§24 gate `calibration_safety_derived` is `NOT_EVALUATED`, which blocks exactly as RED.

**Can repository code solve it?** **No.** Every one of the 39 findings names what it awaits, and
none of them is a code change — e.g. *"per-class rated-mass certification"*, *"the operated CA's
revocation-publication latency"*, *"a safety decision with the local highway or site authority"*,
*"measured on-board scale accuracy per container model"*.

**Required external input:** a named calibration owner, and per-parameter derivation from a stated
accounting or measured basis (§22.4's `DERIVED` definition).

**One worker is held by B8.** `energy_calibration` is `DEFERRED` — it exposes a pass function
rather than a scheduler, and its inputs are realised-outcome rows the fleet has not produced. The
registry records it as one of the loops B8's calibration owner governs. It does not fail
`gate:composition`, because the deferral is declared.

**Required engineering work after the dependency arrives:** record the derived values and their
bases in the register; `gate:calibration` then passes without any code change.

**Do not:** derive, invent, edit, promote or reclassify any calibration value. **§22.3 forbids any
automated process from changing a Safety-class parameter.** Note in particular that
`release.soak_duration` is still `PROVISIONAL` and was deliberately **not** promoted — an earlier
pass made the system *use* it, which is a different act from calibrating it.

**Closure condition:** 39 findings → 0; `gate:calibration` exit 0; `calibration_safety_derived` GREEN.

---

## B-P — Four PRODUCTION gates are NOT_EVALUATED

**Status:** OPEN
**Classification:** **EVIDENCE / OPERATIONS**
**Owner:** Operations — requires an operating fleet
**First discovered:** 2026-08-08 · **Last verified:** 2026-08-29

**Current evidence:** `release:verdict` shows `invariants_enforced`, `simulator_fidelity`, `soak`
and `shadow_agreement` all `NOT_EVALUATED`. `npm run sim:fidelity` → exit **1**, all 7 models
`NOT_MEASURED`, 6 safety-relevant, no study supplied.

**Why it blocks:** these four gates are discharged by *observed production behaviour over a
declared window*. There is no collector for them; an operator files them by hand. `NOT_EVALUATED`
blocks exactly as RED.

**Can repository code solve it?** **No.** Worse — **the observation cannot even begin**: the shadow
worker cannot compose, for the same reason `coordinator` cannot (B1). The 14-day shadow-agreement
window has no start.

**Required external input:** an operating fleet; a simulator-fidelity study against realised
production data (`sim:fidelity --input <file.json>`); a completed soak; a completed shadow window;
an invariant-observation window (execution-plan **OP-8**, a pre-existing gap — I13 consumes the
window, no phase creates it).

**Do not:** fabricate an observation window, a soak record, a fidelity study or a shadow-agreement
result. This is the exact attack surface finding **P15-E1** closed — malformed windows
(`NaN`, `±Infinity`, entirely-in-the-future) were being ADMITTED and PASSED on precisely these four
gates, and would have taken a shard live. The authority now refuses them by name. **Do not weaken
that, and do not route around it.**

**Closure condition:** each of the four filed with a valid, finite, past, sufficiently long
observation window and a genuine result.

---

## B-O — Three ORGANISATIONAL gates are NOT_EVALUATED

**Status:** OPEN
**Classification:** **EVIDENCE / OPERATIONS**
**Owner:** Named humans — the release owner, the calibration owner, the rehearsal operator
**First discovered:** 2026-08-08 · **Last verified:** 2026-08-29

**Current evidence:** `calibration_safety_derived`, `safety_case_assembled` and `rollback_rehearsed`
are all `NOT_EVALUATED`. **0 attestations are filed** — `release-evidence.json` carries 17 build
records and no attestation block.

**Why it blocks:** these are human sign-offs. `npm run safety:case` exits 0 and every reference
resolves, but **the assembler files no evidence** — it reports "0 green, 0 red, 24 not evaluated"
itself. An assembling safety case is not a discharged §24.7 gate.

**Can repository code solve it?** **No.**

**Required external input:** a filed safety-case attestation; a recorded rollback rehearsal per
`docs/runbooks/rollback.md` §5, in a declared non-production environment (ADR-34's `REHEARSAL`
purpose exists for exactly this and sets aside exactly one gate); the B8 calibration attestation.

**Do not:** file an attestation on anyone's behalf. Note that `verdict.js` (and now
`cutover.md` §3.2) forces a gate **RED** when a build record and an attestation collide for the
same gate id — do not attempt to override a build record with an attestation.

**Closure condition:** three attestations filed by named humans and admitted by `evidence.admit()`.

---

## B-M — `model_check_capacity_1_2_3` is GREEN and NOT PROVEN

**Status:** OPEN · **Evidence state: NOT MEASURED / OPEN.** Not `PASS`, and the gate rendering
GREEN is not evidence that it is.
**Classification:** **EVIDENCE / OPERATIONS** (compute provisioning) — an **independent
release-evidence item, NOT a B1 sub-step.** It is independent of D1, D3, D8, routing-engine
selection and B1 Steps 1/3/4/5, in both directions: B-M progress is not B1 progress and B1 progress
is not B-M progress.
**Owner:** **Release owner** (provisions `tla2tools.jar`, executes or coordinates the runs, and
gives **final acceptance**) · **Compute/Platform** (suitable compute and the machine statement) ·
**Safety engineer** (property-coverage and boundedness judgement) · **Engineering** (repository
implementation and mechanical support only — **release authority does not transfer to Engineering**).
Full ownership and the run-record requirements:
[`B1_EXTERNAL_INPUT_HANDOFF.md`](B1_EXTERNAL_INPUT_HANDOFF.md) §7.3a and §7.6.
**First discovered:** pass 3 (as **P15-E5**) · **Last verified:** **2026-08-31 — TLC executed**

### ⚠ 2026-08-31 — the six configurations were RUN. B-M did NOT close.

**`tla2tools.jar` was provisioned and all six checked-in configurations were executed on the frozen
tree.** Full §7.3a record, with the **raw TLC output retained verbatim** and the tool/JDK/machine
provenance: **[`PHASE_15_BM_TLC_RUN_RECORD.md`](PHASE_15_BM_TLC_RUN_RECORD.md)**.

| Configuration | Constants as checked in | Closed? | Result |
|---|---|---|---|
| `commitment_c1.cfg` | 2 Legs / 2 Workers / Cap 1 / MaxFence 4 | **YES** | **PROVEN / PASS — exhaustive.** 17 991 520 states, 2 375 660 distinct, diameter 21, no error, 25 s |
| `commitment_c2.cfg` | 3 / 2 / Cap 2 / MaxFence 5 | **NO** | **UNKNOWN — did not converge.** 287 M distinct found, **126 M still on queue**, **23.6 GiB** disk queue still growing |
| `commitment_c3.cfg` | 4 / 2 / Cap 3 / MaxFence 6 | **NO** | **UNKNOWN — did not converge.** Abnormal exit `-1` at 247 s, 21 M on queue, no TLC error or completion line |
| `lifecycle_c1.cfg` | 2 Legs / Cap 1 / MaxTicks 3 | ~~**NO**~~ → **YES** | ~~**FAIL — deadlock abort at depth 6**~~ → **FAIL — `Liveness` violated (X6).** State graph now CLOSES: 8 030 states / 1 909 distinct / depth 27 / 0 on queue. `Safety` **PASS**, `TerminalIsFinal` **PASS** |
| `lifecycle_c2.cfg` | 3 Legs / Cap 2 / MaxTicks 3 | **NO** | ~~**FAIL — deadlock abort at depth 6**~~ → **FAIL — `Liveness` violated (X6)**, run ends there with 2 474 states on queue. `Safety` no violation **in a partial search** |
| `lifecycle_c3.cfg` | 4 Legs / Cap 3 / MaxTicks 3 | **NO** | ~~**FAIL — deadlock abort at depth 6**~~ → **FAIL — `Liveness` violated (X6)**, run ends there with 3 722 states on queue. `Safety` no violation **in a partial search** |

> **The three lifecycle rows were REVISED on 2026-08-31 by the X4/X5 decision pass**, which changed
> `formal/lifecycle.tla`. The struck-through values are the morning's results **against the previous
> model** and are retained so the change is visible rather than overwritten. The commitment rows are
> **untouched and were not re-run.**
>
> **The lifecycle half still does not pass** — the reason moved from "nothing is evaluated" to "a
> declared property fails". **That is progress, not a discharge.** Separately, a **secondary
> diagnostic** run with `INVARIANT Safety` only (no `PROPERTY` lines — *not* a checked-in
> configuration) closes exhaustively and cleanly at **all three capacities**: c1 8 030/1 909 depth
> 27 · c2 419 171/60 079 depth 37 · c3 **16 557 136 / 1 680 163 depth 47**, every one `0 states left
> on queue`, `No error has been found`. **That is evidence that X4 is genuinely fixed at every
> capacity. It is NOT a result for `lifecycle_c{1,2,3}.cfg`** — the configuration under check is
> part of the requirement (§24.2), and these ran a different one.

**Tool:** v1.8.0 release asset, SHA-256 `eabd140a70f49eb9305a3bd3f3df944eddf87e5a90d329789085f8953a80533a`,
self-reporting `TLC2 Version 2026.08.21.155922 (rev: 9787e65)`. **JDK** Oracle 20.0.2+9-78.
**Machine** LENOVO 21DJ, i5-1235U (12 logical cores), 15.72 GB RAM, 363 GB volume / 45 GB free —
**a contended developer workstation, and the machine slept during the `c2` run** (run record §5.2).

**What this changes about B-M: the outcomes are measured instead of absent. Nothing else.**

- **2 of 6 closed** *(was 1; `lifecycle_c1`'s state graph now closes)*. §7.3 requires all six.
  **The lifecycle half still produces no PASSING evidence at any capacity** — `Liveness` fails
  (**X6**) at all three, and `c2`/`c3` stop on that error before their searches complete.
- **§7.3a item 4 (named human operator) NOT satisfied**; **item 8 (boundedness accepted) NOT
  accepted**; **item 10 (release-owner acceptance) NOT given**; **item 7's G5 gap unchanged and
  still uncovered by any TLC run.**
- **The compute requirement is NOT satisfied because TLC was provisioned.** The two commitment
  configurations that did not converge are the same two that had never completed on any machine
  tried before, and this machine is not the compute §7.6 assigns to Compute/Platform.
- **`establishedByCommand` was NOT removed and must not be.**

> **Two NEW blockers came out of these runs and are NOT part of B-M** — see **X4** and **X5**
> below. **Do not fold either into B-M and do not close B-M by resolving either.**
>
> **Both were decided and implemented later on 2026-08-31, and a third — X6 — was opened by that
> pass. B-M is unaffected by all three and remains OPEN.** The instruction above is unchanged and
> now has a worked example: X4 and X5 are resolved, and **B-M did not move**, because B-M is an
> evidence/compute item and the two commitment configurations that never converged still have not.

> **One correction owed to `gates.js`, deliberately NOT made — and now stale in TWO ways.** Its
> `notEstablishedReason` string says *"`lifecycle.tla` has never been run under TLC"*. That was
> already false after the morning pass — it had been run, and it failed on the deadlock check. After
> the X4/X5 decision pass it is **further** out of date: the module has since been *changed*, and
> `lifecycle_c1` now closes its state graph and passes `Safety` and `TerminalIsFinal`, failing only
> `Liveness` (**X6**).
>
> **Still deliberately not corrected.** `Backend/src/engine/cutover/gates.js` is inside the
> source-digest scope and inside the frozen implementation; editing it would move the digest, which
> the X4/X5 pass had no mandate to do. **The sentence continues to UNDERSTATE the gap rather than
> overstate it** — the gate is still not established, and for a reason the string does not name — so
> leaving it remains the conservative choice. Recorded for whoever next has authority over that file.

**Current evidence:** `release:verdict` prints the gate as GREEN with an inline `[NOT PROVEN]`
annotation generated by the tool: *"the discharging suite asserts `exhaustive: false` for the
lifecycle at capacities 1, 2 and 3, and `lifecycle.tla` has never been run under TLC; the commitment
half is exhaustive only at capacity 1."* **That quoted string is the tool's, and its middle clause
is now out of date** — see the correction note above. A repository-wide search still confirms
**`tla2tools.jar` is absent from the repository**; the jar used on 2026-08-31 was provisioned
**outside the tree** and deliberately not added to it, so **"absent from the repo" no longer implies
"TLC has not been run here".**

**Why it blocks:** the gate's *statement* is an exhaustive model check. A passing exit code from the
discharging command does not establish it. The `[NOT PROVEN]` annotation is the honest record of
that gap, deliberately made visible rather than silent.

**Can repository code solve it?** **No** — it needs `tla2tools.jar` and a compute run. The artefacts
it would check (`formal/commitment.tla`, `formal/lifecycle.tla`, six `.cfg` configurations) all
exist.

**Required external input:** `tla2tools.jar` and machine time.

**Required engineering work after the dependency arrives:** run the six configurations per
`formal/README.md`; record the run per the handoff's §7.3a (tool version **and SHA-256**, JDK
version, machine/compute characteristics, named operator and run date, whether each state graph
actually **closed**, state counts/diameter/runtime, the §24.2 properties each run covered,
boundedness explicitly accepted, capacity scope explicitly addressed, and the retained raw output);
then, **on the release owner's recorded acceptance and not before**, remove `establishedByCommand`
from the gate.

**Two structural gaps in the machinery itself — recorded here, NOT to be fixed.** Both verified
against the current tree on 2026-08-29. Do **not** modify `gates.js`, `evidence.js`,
`sourceDigest.js` or any test to accommodate a TLC run:

1. **A completed TLC run has no normal evidence-admission path.** The gate is `EVIDENCE.SUITE` with
   `command: "npm run test:engine -- ModelCheck"` (`gates.js:186-190`), and `evidence.admit()`
   refuses any BUILD/SUITE record whose `run.command` is not that exact command
   (`COMMAND_MISMATCH`, `evidence.js:342-405`). A `java -jar tla2tools.jar …` run cannot be filed
   against this gate, and the schema has no field for any of the provenance items above. **The run
   evidence therefore lives only in the written record — nothing admits, checks or ages it**, and
   the only mechanical act reflecting a discharge is the flag removal above.
2. **`formal/` is outside the source-digest scope.** The digest covers `Backend/{src,tools,tests}`
   plus `package.json` and `jest.config.js` (`sourceDigest.js:33-36`); `formal/` is at the
   repository root. **No evidence record is bound to the state of the two `.tla` modules or the six
   `.cfg` files** — one could be altered between a run and its citation with no digest movement and
   no gate reaction. This is why the runs must be recorded as executed *as checked in*. **Do not
   propose digest-scoping `formal/` as a fix** — see `PHASE_15_MASTER.md` §10.

**Do not:** remove the `[NOT PROVEN]` annotation, change the gate algebra, or mark the gate proven.
The GREEN status is *not* a discharge and must not be read as one; **the `[NOT PROVEN]` annotation
is the authoritative statement of this row's truth and outranks the GREEN.**

**Closure condition:** the checked-in configurations completed exhaustively, recorded with the
provenance above, and accepted by the release owner; then the flag removed. **Note the gate's
status does not move on closure** — it is GREEN before and after — so the gate table cannot be used
to track B-M. This register and the handoff §7 are where its state lives.

---

## X3 — No `TASK` timer producer; §4.2 has no transition table

**Status:** OPEN
**Classification:** **SPECIFICATION / ADR**
**Owner:** The frozen-specification owner
**First discovered:** adversarial pass 1, 2026-08-22 · **Last verified:** 2026-08-29

**Current evidence:** `tools/verify/phase15CurrentTree.js` check **G1** — *"FINDING X3 — no §4.2 Task
state is written anywhere, so no TASK timer has a producer."* Passes as a finding assertion, i.e. it
confirms the gap is still present.

**Why it blocks:** the timer subsystem implements expiry for entities whose §4.x transition tables
exist. §4.2 (`TASK`) has none, so there is nothing to produce a `TASK` timer *from*.

**Can repository code solve it?** **No — and it must not.** Pass 2 recorded this explicitly as
*"NOT FIXED, and must not be"*: inventing a TASK transition table would be writing specification,
and `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` is **FROZEN**.

**Required external input:** a §4.2 transition table from the specification owner, or an ADR
declaring that `TASK` has no timed transitions.

**Do not:** invent a TASK state machine, a TASK timer producer, or a §4.2 transition table.

**Closure condition:** the specification decision is recorded, and the repository implements it.

---

## X4 — `lifecycle.tla`'s `CustodyMatchesState` is contradicted by `Strand` and `TimerFires`

**Status:** **DECIDED AND IMPLEMENTED 2026-08-31 — model change landed and verified.**
**Classification:** **SPECIFICATION / FORMAL MODEL / SAFETY ENGINEERING**
**Decided by:** the **sole project owner/reviewer**, acting as the project's specification and
verification authority. **See the sign-off note immediately below — there is no independent
acceptance and none is claimed.**
**First discovered:** **2026-08-31**, by the first-ever TLC execution of `lifecycle.tla`
**Decided / implemented / verified:** 2026-08-31
**Last verified:** 2026-08-31

> ### ⚠ AUTHORITY AND SIGN-OFF — read before citing this entry as closed
>
> This project has **one person**: sole developer, sole tester, sole reviewer. The separate
> **safety engineer**, **frozen-specification owner** and **release owner** that §7.6 names as
> distinct parties **do not exist as separate individuals here**, and no external approval was
> available to obtain.
>
> The decision below was therefore made by the **sole project owner/reviewer** as the project's
> specification and verification authority, and recorded as such.
>
> | | |
> |---|---|
> | **Independent safety-engineering acceptance** | **DOES NOT EXIST.** Not obtained, not simulated, not claimed |
> | **Independent release-owner acceptance (§7.3a item 10, §7.6)** | **DOES NOT EXIST.** Still formally unsatisfied |
> | **Named-operator attestation (§7.3a item 4)** | **STILL NOT SATISFIED** — unchanged by this pass |
> | **What the four-eyes separation in §7.6 bought** | **Nothing, here.** One person deciding and implementing their own specification call is exactly the review structure §7.6 exists to avoid, and that is a property of the project's size, not a defect this document can fix |
>
> **What makes the decision defensible is not the sign-off — it is that the frozen specification
> already said it** (see *Basis* below), so the decision is a **transcription correction** rather
> than a new safety claim. Had the specification been silent or contrary, one person's judgement
> would not have been enough, and this entry would have stayed OPEN.
>
> **If independent review ever becomes available, this decision is the first thing to re-examine.**

> ### This is SEPARATE from B-M and must not be folded into it.
> B-M is an **evidence/compute** item: whether the six configurations were run and recorded. X4 is
> a **specification-level safety finding** about what the model says. **Resolving X4 does not close
> B-M, and closing B-M would not resolve X4.** They have different owners and different closure
> conditions.

**Current evidence:** all three lifecycle configurations report
`Error: Invariant Safety is violated.` at **depth 9**, with an identical trace on Leg `l1`
(296 / 1 051 / 3 812 distinct states at capacity 1 / 2 / 3). Raw output and the full nine-state
counterexample: [`PHASE_15_BM_TLC_RUN_RECORD.md`](PHASE_15_BM_TLC_RUN_RECORD.md) §10 and §12.7–§12.9.

**The trace:**

```
Plan → Offer → Accept → Depart → ArrivePickup → Load → CancelWithCustody → TimerFires
```

producing `ABORTING → STRANDED_OBSTRUCTING` **while `custody[l1]` remains `"HELD"`**.

**Affected invariant** — `CustodyMatchesState` (`lifecycle.tla:392-394`), a conjunct of `Safety`:

```tla
custody[l] = "HELD" => legState[l] \in (CustodyBearingStates \cup { "ABORTING" })
```

`CustodyBearingStates == { "LOADED", "EN_ROUTE_DROP", "AT_DROP" }` — **neither stranded state is in
the permitted set.**

**Affected transitions — there are TWO independent routes into the violation, not one:**

| Definition | Lines | What it does |
|---|---|---|
| **`TimerFires`** (`recover.abort_budget` disjunct) | `:340-342` | `ABORTING → STRANDED_OBSTRUCTING` with `UNCHANGED custody`. **The route the trace takes** |
| **`Strand(l, class)`** | `:291-295` | `ABORTING → STRANDED_SAFE`/`STRANDED_OBSTRUCTING` with `UNCHANGED custody`. **A second, independent route** |
| **`Recovered(l)`** | `:301-306` | Guarded on the Leg being **stranded**, and its custody update is `IF custody[l] = "HELD" THEN "RELEASED"` — **it is written to resolve exactly the state the invariant forbids.** Under `CustodyMatchesState` that branch is dead code |

**The contradiction in one sentence:** `Strand` and `TimerFires` construct stranded-with-custody
states, `Recovered` exists to resolve them, and `CustodyMatchesState` declares they cannot exist.
*(By contrast `AbortResolved` (`:284-289`) has the same shape but fires from `ABORTING`, which the
invariant permits — that one is consistent. The disagreement is specifically about the stranded
states.)*

**Why it blocks:** `model_check_capacity_1_2_3`'s statement is that **every §24.2 safety property**
is model-checked. A model whose own safety invariant is violated by its own transitions cannot
produce that evidence at any capacity, on any compute. **The lifecycle half of the gate cannot pass
while X4 stands**, independently of B-M's compute problem.

---

### THE DECISION — recorded 2026-08-31

> **`STRANDED_SAFE` and `STRANDED_OBSTRUCTING` are custody-bearing states. `custody = "HELD"` is
> LAWFUL while a Leg is stranded. The invariant and the state classification are brought into
> agreement with that semantics, and recovery subsequently releases or otherwise accounts for the
> held custody.**

Of the four candidate readings the register listed, the decision selects **"the invariant is too
narrow"** — `CustodyMatchesState` was wrong, and `Strand`, `TimerFires` and `Recovered` were right.

**It was NOT chosen because its repair is smaller.** It was chosen because the frozen specification
already says it, and the entry below is the evidence.

### THE BASIS — the frozen specification already decided this, and the module mis-transcribed it

This is the finding that changes X4's character: **it is a transcription defect, not an open safety
question.** Five independent places in the FROZEN `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` state or
presuppose that a stranded Leg can hold custody:

| Source | What it says | Force |
|---|---|---|
| **§4.4 transition table**, `EN_ROUTE_DROP` row (`:1141`) | `EN_ROUTE_DROP` → `STRANDED_SAFE` / `STRANDED_OBSTRUCTING`, **guard: `custody `HELD``** | **Decisive.** The specification's own transition table has a transition *into* a stranded state whose **guard is held custody**. A state that cannot lawfully hold custody cannot be entered by a transition guarded on holding it |
| **§4.4**, lease-expiry row (`:1146`) | any non-terminal → `REASSIGNING`, `STRANDED_SAFE` or `STRANDED_OBSTRUCTING`, "**by custody state** and obstruction class" | A second entry route that selects the stranded states *on the basis of* custody |
| **§4.4**, recovery row (`:1149`) | `STRANDED_*` → `FAILED`/`SETTLED`, guard "custody accounted for (§4.9)", note "**Leg terminates only once custody is discharged** (I7, I8)" | An obligation that is **vacuous** unless a stranded Leg can hold custody |
| **§4.3** (`:1069`) | stranding is "an agent **with goods aboard**, immobilised, out of communication" | The state's own definition |
| **§18.6** step 1 (`:4144`) | the responder is paged with a "**custody manifest**" | You do not page a custody manifest for goods the model says cannot be there |

**And the executable checker had already found it.**
[`lifecycleModel.js:64-72`](../../Backend/tests/engine/helpers/lifecycleModel.js#L64-L72) — the
§24.2 "equivalent model checker", whose transitions call the **shipped** modules — has listed
`STRANDED_SAFE` and `STRANDED_OBSTRUCTING` in `CUSTODY_BEARING` since Phase 15, with a comment
recording that it found them **by counterexample**: *"A model that treated custody in a stranded
state as a violation would be asserting that the system must lose track of the goods at the moment
it most needs to know where they are."*

> **So the two §24.2 checkers have contradicted each other since Phase 15**, and `formal/README.md`
> already stated the rule for that case: *"An action added to one without a matching action in the
> other is a defect in whichever was not updated."* Here it is an **invariant** rather than an
> action, and **`lifecycle.tla` is the one that was not updated.**

**The earlier entry's caution was right, and is preserved rather than deleted.** Retaining `HELD`
custody while stranded *is* the semantically correct reading — a robot broken down mid-delivery is
still holding the parcel — and the register was correct that this must not be decided by whichever
repair is smaller. What the 2026-08-31 decision pass added was **§4.4's guard**, which settles it
from the specification rather than from judgement.

### WHAT CHANGED — `formal/lifecycle.tla` only

**No `Backend/` file, no `.cfg`, no schema, no test, and no shipped transition was modified.** The
source digest is unmoved at `d033038cb261c3de…` / 573 files.

| Change | Detail |
|---|---|
| **`CustodyBearingStates` — value UNCHANGED** | Still `{ "LOADED", "EN_ROUTE_DROP", "AT_DROP" }`. Only its comment changed, to say what it is: a **guard** used by `Dispute` and `TimerFires`, not a classification |
| **`StrandedLegStates` — NEW** | `{ "STRANDED_SAFE", "STRANDED_OBSTRUCTING" }` |
| **`CustodyLawfulStates` — NEW** | `CustodyBearingStates \cup { "ABORTING" } \cup StrandedLegStates`, with the §4.4 / §4.3 / §18.6 basis stated inline |
| **`CustodyMatchesState`** | Right-hand side is now `legState[l] \in CustodyLawfulStates` |

> ### Why `CustodyBearingStates` itself was NOT widened, though the decision names it
>
> That set is used as a **guard in two actions**, not only in the invariant:
> `Dispute` (`lifecycle.tla:223`) and `TimerFires` (`:333`). Adding the stranded states to it would
> have **silently changed the transition relation**: a stranded Leg would have become disputable,
> and a timer would have dragged a stranded Leg back to `ABORTING` — contradicting §4.3's
> *"recovery is impossible without physical intervention"* and the module's own stranded-stuttering
> disjunct at `:346`.
>
> **That would have been changing the meaning of a shipped transition to make the model pass**,
> which is the exact failure this register exists to prevent. Separating the *physical-transport*
> set (`CustodyBearingStates`, a guard) from the *custody-lawful* set (`CustodyLawfulStates`, the
> invariant's domain) implements the decision precisely **and changes no transition**.

**The invariant was not blindly weakened.** What it still forbids is unchanged and is the part that
matters: custody in any state that has not reached the pickup (`QUEUED`, `DEFERRED`, `PLANNED`,
`OFFERED`, `ACCEPTED`, `EN_ROUTE_PICKUP`, `AT_PICKUP`) and custody in **any terminal state** — the
two ways goods are lost rather than carried. Mutation M3 and M4 below prove both still bite.

### THE EVIDENCE — the counterexample is gone, and gone for the intended reason

| Run | Before (2026-08-31, §12.7–§12.9) | After |
|---|---|---|
| `lifecycle_c1` | `Invariant Safety is violated` at depth 9 | **No violation.** Complete state graph: 8 030 states / 1 909 distinct / **depth 27, 0 left on queue** |
| `lifecycle_c2` | same violation, depth 9 | **No violation found** — but the run stops on the *liveness* error (X6) with states still queued |
| `lifecycle_c3` | same violation, depth 9 | as `c2` |
| **Safety-only diagnostic**, all three capacities | — | **Exhaustive and clean at every capacity.** c1 8 030/1 909 depth 27 · c2 419 171/60 079 depth 37 · c3 **16 557 136 / 1 680 163 depth 47** — all `0 states left on queue`, `No error has been found` |

**Mutation testing — 4 mutants built, 4 killed** (full detail in the run record):

| Mutant | Kills |
|---|---|
| **M1 — revert ONLY the X4 widening**, restoring the old invariant | **`Invariant Safety is violated`**, and the counterexample is the **original X4 trace**: depth 9, Leg `l1` → `STRANDED_OBSTRUCTING` with `custody = "HELD"`, sibling untouched in `QUEUED`. **This is the proof that the X4 change is what eliminated the counterexample, and not some side effect of the X5 change** |
| **M3 — `Recovered` no longer accounts for custody** | `Invariant Safety is violated` — a `FAILED` Leg holding `HELD` |
| **M4 — `Cancel` may carry custody** | `Invariant Safety is violated` — `CustodyNeverCancelled` |

**Is the shipped implementation affected?** The earlier entry left this UNKNOWN and told X4's owner
to ask. **Asked and answered: no change is required.**
[`transitions.js:499-506`](../../Backend/src/engine/lifecycle/transitions.js#L499-L506) already
routes `STRANDED_*` → `FAILED`/`SETTLED` under the `CUSTODY_ACCOUNTED_FOR` guard, and
`lifecycleModel.js` already treats stranded as custody-bearing. **The shipped implementation was
always on the decided side of this question; only the TLA+ transcription was not.**

**Closure condition — MET for the model; the acceptance half is structurally unavailable:** the
specification decision is recorded (above) and the repository implements it (`formal/lifecycle.tla`).
The independent **release-owner acceptance** the original closure condition also required
**does not exist and cannot, on a solo project** — see the sign-off note at the head of this entry.

**Still do not:** treat X4 as an implementation bug; merge it into B-M or X5; or cite this entry as
evidence that B-M is discharged. **X4 is decided. B-M is not.**

---

## X5 — the checked-in `lifecycle_c*.cfg` abort on the deadlock check before any property is evaluated

**Status:** **DECIDED AND IMPLEMENTED 2026-08-31 — model change landed and verified.**
**Classification:** **FORMAL-VERIFICATION CONFIGURATION / DOCUMENTATION GAP**
**Decided by:** the **sole project owner/reviewer**, acting as the project's specification and
verification authority. **No independent safety-engineering or release-owner acceptance exists** —
see the sign-off note in **X4**, which applies identically here and is not repeated.
**First discovered:** **2026-08-31**, by the first-ever TLC execution of `lifecycle.tla`
**Decided / implemented / verified:** 2026-08-31
**Last verified:** 2026-08-31

---

### THE DECISION — recorded 2026-08-31

> **Terminal deadlock freedom is a genuine §24.2 obligation of this model. The model is changed to
> SATISFY TLC's deadlock check — it is NOT switched off.**

This is **option 3** of the four the register listed: *"treat deadlock freedom as a genuine §24.2
obligation and change the model to satisfy it"*.

**Option 1 — `CHECK_DEADLOCK FALSE` — was explicitly REJECTED**, and rejected for the stated
reason rather than by omission: it would have made TLC pass by removing the question instead of
answering it. **No `.cfg` sets `CHECK_DEADLOCK FALSE`, none was edited, and none may be.**

> ### One honest qualification on the basis for this decision
>
> **§24.2 does not enumerate deadlock freedom.** Its safety clauses are capacity, terminal
> immutability, superseded authority, `STAND_DOWN_ALL`, leadership fencing, SOFT-reservation loss
> and custody; its liveness clauses are *"every non-terminal state eventually leaves"* and *"every
> queued mission is eventually assigned, escalated, or explicitly declined."*
>
> **Treating deadlock freedom as an obligation of this model is therefore a DECISION, not a
> quotation.** What supports it is that §4.1 rule 1 (*"no state is both terminal and modifiable"*)
> and §24.2's liveness clause together imply that the **only** legitimate quiescent state of a
> behaviour is one in which every Leg is terminal — so a deadlock report on any *other* state would
> be a real defect, and the model should be able to say so. It could not previously, because it
> aborted on the legitimate case first.

### WHAT CHANGED — `formal/lifecycle.tla` only

**No `.cfg` was edited. `formal/README.md`'s run instructions are unchanged. `CHECK_DEADLOCK`
remains ON in all three lifecycle configurations.**

```tla
AllLegsTerminal == \A l \in Legs : legState[l] \in TerminalLegStates

TaskQuiescent ==
    /\ AllLegsTerminal
    /\ UNCHANGED vars
```

added to `Next` as a third top-level disjunct.

**Why this cannot hide a liveness defect — the property that makes it safe to add:** it is a
**stuttering step on `vars`**, so it is *not* a `<<Next>>_vars` step. `WF_vars(Next)` is therefore
unaffected by it: it cannot starve an enabled action and it **cannot discharge any liveness
obligation**. It is enabled only when every Leg is already terminal — precisely the state §4.1
rule 1 declares unmodifiable. **The proof that it did not paper anything over is X6 below: the
liveness property it exposed promptly failed, which a masking fix would have prevented.**

**It deliberately does NOT touch `taskState`.** Resolving the Task's own state when its Legs end
other than by settlement is §4.2 territory, and §4.2 has no transition table — **that is X3, which
this pass did not touch.**

### THE EVIDENCE

| Run | Before | After |
|---|---|---|
| `lifecycle_c1` | `Error: Deadlock reached` at **depth 6**, 79 distinct states, **no declared property reached a verdict** | **No deadlock.** Complete state graph, **depth 27**, 8 030 states / 1 909 distinct, 0 left on queue. `Safety` **PASS**, `TerminalIsFinal` **PASS**, `Liveness` **FAIL (X6)** |
| `lifecycle_c2` | deadlock at depth 6, 277 distinct | **No deadlock.** 78 471 / 11 886, depth 16 reached; run ends on the `Liveness` error |
| `lifecycle_c3` | deadlock at depth 6, 1 012 distinct | **No deadlock.** 66 908 / 9 934, depth 11 reached; run ends on the `Liveness` error |

**Mutation M2 — remove `TaskQuiescent` from `Next`** → **`Error: Deadlock reached`** returns.
**That is the proof that this action, and nothing else, is what eliminated the deadlock abort.**

> ### The three `-deadlock` diagnostic runs from the first pass are now SUPERSEDED, not promoted
> They remain at §12.7–§12.9, still labelled non-authoritative, still discharging nothing. **They
> were never promoted into proof**; the deadlock question was answered by changing the model so the
> checked-in configurations reach a verdict on their own terms. **Do not cite them as a result for
> `lifecycle_c{1,2,3}.cfg`** — that instruction is unchanged.

**Closure condition — MET for the model:** the option taken and its reasoning are recorded above,
and the corresponding change is made. The independent acceptance half is structurally unavailable —
see the sign-off note in **X4**.

---

### The original finding, retained verbatim below

> ### This is SEPARATE from X4 and from B-M.
> **X5 is a configuration/documentation gap; X4 is a safety finding about the model's content.**
> They were found in the same session and are otherwise unrelated: fixing X5 does not fix X4 —
> it **reveals** it — and fixing X4 does not fix X5.

**Current evidence:** `lifecycle_c1/c2/c3.cfg`, run exactly as `formal/README.md:21-24` instructs,
each abort with `Error: Deadlock reached.` at **depth 6**, having explored **79 / 277 / 1 012**
distinct states. Raw output: [`PHASE_15_BM_TLC_RUN_RECORD.md`](PHASE_15_BM_TLC_RUN_RECORD.md) §9
and §12.4–§12.6.

**What happens:** every Leg is `Cancel`led in turn until all are `CANCELLED`; every action in `Next`
requires some `legState[l] \notin TerminalLegStates`, so no successor exists. **TLC's default
deadlock check fires.** No `.cfg` sets `CHECK_DEADLOCK FALSE` and the model has no stuttering action.

**Why it blocks:** the three configurations **declare** `INVARIANT Safety` and
`PROPERTY TerminalIsFinal, Liveness` and **none of them reaches a verdict on any of those** — the
run is over at depth 6. **The checked-in lifecycle configurations, run as documented, cannot produce
evidence for the gate they exist to serve.** In particular **no lifecycle liveness property has ever
been evaluated by TLC at any capacity**, and the absence of a temporal-property error in the logs is
the absence of a search, not the absence of a counterexample.

**This is not obviously a model defect.** `Safety`'s own `TerminalIsFinal` conjunct asserts that
terminal Legs never change state (`:377-379`), so "every Leg terminal" is an **intended end of a
behaviour**. TLC's default check cannot distinguish that from a stuck system. **Which it is, is the
owner's call.**

**Required decision — four options, not equivalent, and at least one is a specification statement:**

| Option | What it asserts | Who may decide |
|---|---|---|
| `CHECK_DEADLOCK FALSE` in the three `.cfg` | Deadlock freedom is not a §24.2 property of this model | Safety engineer + release owner |
| An explicit stuttering/termination action in `lifecycle.tla` | A change to the transition relation | Frozen-specification owner |
| Treat deadlock freedom as a genuine §24.2 obligation | The current model is defective | Frozen-specification owner + safety engineer |
| Accept that the lifecycle configurations produce no evidence | The gate's lifecycle half stays permanently unevidenced | Release owner |

**Can repository code solve it?** **Not unilaterally.** Every option is a statement about what
§24.2 requires of this model. **Engineering must not pick one**, and picking the first because it is
the smallest edit is exactly the failure this register exists to prevent.

> ### The secondary `-deadlock` diagnostic runs are NOT a discharge and must not be promoted to one.
> Each lifecycle configuration was re-run once with TLC's `-deadlock` flag **on the command line;
> no file was modified**. Those runs are **diagnostic evidence only** — they are how **X4** was
> found. §24.2's own argument, quoted in all six `.cfg` headers, is that *"the configuration under
> check is itself part of the requirement"*, so **a run under a flag the configuration does not
> specify is evidence about a different run.** They are retained, clearly labelled, at
> `PHASE_15_BM_TLC_RUN_RECORD.md` §12.7–§12.9. **Do not cite them as a result for
> `lifecycle_c{1,2,3}.cfg`.**

**Do not:** edit any `.cfg`; edit `formal/README.md`; change `CHECK_DEADLOCK`; or silently convert
the `-deadlock` diagnostic into authoritative proof. *(The original text also said "add a stuttering
action". **That prohibition was addressed to Engineering acting without a decision, and it is the
option the recorded decision above selected.** The `.cfg`, `README` and `CHECK_DEADLOCK`
prohibitions are unchanged and still stand.)*

**Closure condition:** the owner records which of the four options is taken and why; only then is
the corresponding change made. — **MET 2026-08-31**; see the decision at the head of this entry.

---

## X6 — `Liveness` fails: the §17.4 ladder has no counterpart in `lifecycle.tla`

**Status:** **CLOSED — 2026-08-31, third pass of the day. Classified as a TRANSCRIPTION defect,
fixed in `formal/lifecycle.tla` only, and verified.**
**Classification:** **FORMAL MODEL — transcription of §4.4 and of §24.2's fairness hypothesis.**
*Not* a specification question, and *not* a shipped-implementation defect
**Owner:** the project's specification/verification authority — **on this project, the sole owner**
**First discovered:** 2026-08-31, by the first-ever *evaluation* of the lifecycle liveness
properties — which only became possible once **X5** was decided
**Last verified:** 2026-08-31 (third pass)

> ### ⚠ Closing X6 did NOT make `Liveness` pass. Read **X7** before citing this entry.
>
> X6 was two transcription defects and both are fixed. **`QueuedLegsProgress` now passes
> exhaustively at capacity 1.** `EveryLegSettles` and `CustodyNeverLost` still fail — on a cause
> that has nothing to do with the ladder, which the X6 fix *isolated* rather than introduced. That
> cause is the new blocker **X7**. **`Liveness` is a conjunction, so the lifecycle half of B-M
> still does not pass.**

### THE INVESTIGATION — the trace the recorded entry described was not the trace TLC produced

The pre-fix run was reproduced on the same jar (SHA-256 `eabd140a…533a`), same JDK 20.0.2, same
workstation, and it reproduces the recorded counts **exactly**: `lifecycle_c1.cfg` as checked in,
8 030 states / 1 909 distinct / depth 27 / 0 on queue, `Liveness` violated. **Two things the
original entry recorded are corrected here; the counts are not, and the historical §15 record is
left untouched.**

1. **The counterexample is not the `Reject` cycle.** The lasso TLC emitted is a **reassignment**
   cycle:
   ```
   ACCEPTED --Reassign--> REASSIGNING --ReassignComplete--> QUEUED
           --Plan--> PLANNED --Offer--> OFFERED --Accept--> ACCEPTED --> ...
   ```
   The `QUEUED → Plan → Offer → Reject → QUEUED` cycle the entry describes **is** a real cycle of
   the model — `Reject` does return `OFFERED` to `QUEUED` — but it is not what TLC reported. The
   distinction matters only because it shows the defect is not specific to `Reject`: *every*
   unbounded cycle in this model passes through `QUEUED`, which is why one ladder fixes all of them.
2. **All three `Liveness` conjuncts fail independently**, not one. The entry said
   `QueuedLegsProgress` and `CustodyNeverLost` were satisfied on the trace. Checked one at a time on
   the same closed 8 030 / 1 909 graph:

   | Conjunct | Pre-fix verdict | Counterexample |
   |---|---|---|
   | `EveryLegSettles` | **VIOLATED** | the reassignment lasso above |
   | `CustodyNeverLost` | **VIOLATED** | `ABORTING --Strand--> STRANDED_* --CancelWithCustody--> ABORTING`, custody `HELD` throughout — **this is X7** |
   | `QueuedLegsProgress` | **VIOLATED** | `l2` parked in `QUEUED` for ever while `l1` spins in that same cycle — **no ladder involved at all** |

### THE ANSWERS — specification, shipped implementation, executable checker, TLA+ module

| # | Question | Answer |
|---|---|---|
| **A** | Does the frozen spec explicitly require a terminal `QUEUED → FAILED` on ladder exhaustion? | **YES, verbatim.** §4.4 row `NEXT_GENERATION_ASSIGNMENT_ENGINE.md:1123` — <code>\| `QUEUED` \| ladder exhausted \| `FAILED` \| — \| task `FAILED`, operator notification \|</code>. Its partner row `:1122` is <code>\| `QUEUED` \| assignment deadline \| `QUEUED` \| ladder step available \| relaxation applied and recorded (§17.4) \|</code>. Corroborated by §4.3's `QUEUED` row (`:1041`, deadline `sla.assignment_deadline`, on expiry "escalation ladder (§17.4)"), §17.4 ("It is finite… and it terminates in a decision"; "A task cannot wait forever"), §18.4 ("A task reaches `FAILED` **only** through the §17.4 ladder"), and I13 (`:5485`) |
| **B** | Does the shipped implementation already implement it? | **YES, end to end.** `lifecycle/transitions.js:203-217` carries both rows — `ASSIGNMENT_DEADLINE` guarded by `LADDER_STEP_AVAILABLE`, and `LADDER_EXHAUSTED → FAILED` with no guard and effects `TASK_FAILED`, `OPERATOR_NOTIFICATION`. `fairness/ladder.js` (T1-04) supplies the verdict from eight rungs (`STEPS`), `supervision/expiryActions.js:373-425` maps `EXHAUSTED → LADDER_EXHAUSTED` and everything else to the re-queue row, and `workers/leaderWorkers.js:416` injects the ladder into the timer worker's handler map. **No Backend change was needed or made** |
| **C** | Does the executable checker model or verify it? | **It MODELS it; it does not VERIFY the property.** `lifecycleModel.js:successors` enumerates every `transitions.EVENT`, so from the initial state it emits `leg-1:QUEUED--LADDER_EXHAUSTED-->FAILED` and `leg-1:QUEUED--ASSIGNMENT_DEADLINE-->QUEUED` (confirmed by running it). But its only liveness check is `checkNoDeadEnds` — "no reachable non-terminal state is a dead end" — and **it has no `EveryLegSettles` and no fairness at all**, so it could never have caught this. **The two checkers disagreed on the transition relation itself, exactly as in X4, and per `formal/README.md` the defect is in whichever was not updated: this module** |
| **D** | Is the only missing piece the TLA+ transcription? | **Yes — but it is TWO pieces, not one.** (a) the two §4.4 `QUEUED` rows, absent entirely — `TimerFires` had **no `QUEUED` case at all**, so the one state whose exit *is* the anti-starvation guarantee was the one state with no supervised exit; and (b) the fairness declaration — see **F** |
| **E** | Is `EveryLegSettles` correctly stated, or stronger than the spec? | **It is stronger than §24.2's literal text, and weakening it would not have helped.** §24.2's clauses are "every non-terminal state eventually leaves" and "every queued mission is eventually assigned, escalated, or explicitly declined"; `EveryLegSettles` asserts every Leg eventually reaches a terminal-or-stranded state, which neither clause says. **Measured rather than argued:** a diagnostic property `NonTerminalStatesLeave` transcribing §24.2's *literal, weaker* first clause **is also violated** on the fixed model (20 355 states / 5 405 distinct). So the residual failure is a violation of the frozen specification's own weaker wording, and `EveryLegSettles` was **not** weakened |
| **F** | Does `WF_vars(Next)` provide the intended fairness? | **No, and this is half the defect.** §24.2 conditions its liveness clauses on "**given fair timer firing**". `WF_vars(Next)` is weak fairness on the *whole disjunction*: it only forbids the system stuttering while some step is enabled, and imposes nothing on any particular Leg or timer. The `QueuedLegsProgress` counterexample proves it — `l2` never moves, and no ladder is involved. **Strong fairness, not weak, is required**, because a Leg in a re-plan cycle leaves `QUEUED` between rungs so `LadderAdvance` is enabled infinitely often but never *continuously*. Measured: with `WF` instead of `SF`, `Liveness` is violated (66 489 / 15 885 / depth 15); with `SF` it passes exhaustively (662 454 / 156 941 / depth 43 / 0 on queue) |
| **G** | Could the infinite reject/requeue trace be legitimate? | **No — it is explicitly forbidden.** §17.4: "A task cannot wait forever, which is what the baseline permits for a task stuck at `PENDING`". §18.4 draws the distinction between *"we could not process this right now"* and *"this cannot be done"* and calls conflating them destructive. I13 requires every queued mission to be "progressing through the escalation ladder or [to have] a terminal decision" |

### THE CHANGE — `formal/lifecycle.tla` only

**No `Backend/` file, no schema, no migration, no `.cfg` and no release evidence was touched.** The
three `lifecycle_c*.cfg` are byte-identical to the ones the X4/X5 runs used, so `CHECK_DEADLOCK
FALSE` is still absent and X5's solution is still the one in force.

| Added | What it transcribes |
|---|---|
| `VARIABLE ladder`, `[Legs -> 0..LadderSteps]`, initialised to 0, added to `vars` and `TypeOK` | §17.4's rung, per Leg |
| `LadderSteps == 8` — a **definition**, not a CONSTANT | §17.4's table has exactly eight rungs, and `fairness/ladder.js`'s `STEPS` carries the same eight. It is not a tunable bound and no `.cfg` supplies it |
| `LadderAdvance(l)` — `QUEUED` ∧ `ladder[l] < LadderSteps` → `ladder[l] + 1`, state unchanged | §4.4 row `:1122` |
| `LadderExhausted(l)` — `QUEUED` ∧ `ladder[l] = LadderSteps` → `FAILED` | §4.4 row `:1123` |
| `Fairness == WF_vars(Next) ∧ ∀l : SF_vars(LadderAdvance(l)) ∧ ∀l : SF_vars(LadderExhausted(l))` | §24.2's "given fair timer firing", per Leg. **`WF_vars(Next)` is kept, not replaced** |

Three properties of the change worth stating because each was a live design choice:

- **The rung never resets.** No transition into `QUEUED` clears `ladder`. That is not an
  abstraction — it is what the shipped ladder does, and `fairness/ladder.js` says why in its own
  words: queue age comes from `WorkQueue.enqueuedAt`, which "survives a Leg leaving and re-entering
  `QUEUED` (a NACK, a failed hardening) … a queue age that resets on every requeue is a starvation
  clock that starvation resets." **The monotonicity is the guarantee.**
- **The ladder rungs do not consume `ticks`.** `MaxTicks` exists to bound actions that have no
  intrinsic bound. §17.4's ladder is finite in the *specification*, so it carries its own bound.
  Charging rungs against `MaxTicks = 3` would have capped the ladder at three rungs and made §4.4's
  second row unreachable.
- **`LadderExhausted` deliberately leaves `taskState` UNCHANGED**, although §4.4's side-effect
  column reads "task `FAILED`". Resolving the Task's state when its Legs end other than by
  settlement is §4.2 territory, §4.2 has no transition table, and that is **X3** — untouched, for
  the same reason X5's `TaskQuiescent` does not touch `taskState` either. **Recorded as a
  limitation, not silently omitted.**

### THE ONE MODELLING JUDGEMENT, named rather than buried

Adding a fairness condition **assumes more**, and therefore makes a liveness property *easier* to
satisfy. That is the direction that deserves scrutiny, so it is stated plainly: **the choice of
strong fairness over weak, on the two ladder actions, is a modelling judgement.** Its basis is
§17.4's own sentence — "It is finite, it advances on elapsed SLA budget **regardless of cost
dynamics** … **No amount of cost arithmetic can prevent it from advancing**" — which, for an action
that is repeatedly but not continuously enabled, is the definition of strong fairness. It is
confined to the two ladder actions and to nothing else.

**It was not adopted to make TLC pass, and the mutation evidence is what shows that:** M3, M5 and
M7 all reintroduce the failure with the fairness left in place, so fairness on an action that does
not exist, or that does not terminate the Leg, proves nothing.

### THE EVIDENCE — after the change

**Exhaustive, checked-in `Legs`/`Capacity`/`MaxTicks`, `INVARIANT Safety` + `PROPERTY
TerminalIsFinal`, one liveness conjunct at a time, capacity 1:**

| Conjunct | Verdict | States / distinct / depth / queue |
|---|---|---|
| **`QueuedLegsProgress`** | **PASS — complete state graph** | 676 854 / 156 941 / **43** / **0** |
| `EveryLegSettles` | **VIOLATED (X7)** | 174 320 / 39 036 / 18 / 7 684 left |
| `CustodyNeverLost` | **VIOLATED (X7)** | 159 731 / 35 834 / 17 / 7 276 left |

`Safety` and `TerminalIsFinal` **PASS** on the closed graph in the first row.

**The X7 isolation, and why it is not a proposed change.** With the X6 fix in place and the
`STRANDED_* → ABORTING` edge blocked as a *diagnostic only*, **every declared property passes
exhaustively**: `Safety` PASS, `TerminalIsFinal` PASS, `Liveness` PASS, 662 454 states / 156 941
distinct / depth 43 / **0 on queue**. **X7 is therefore the single remaining cause of both residual
failures**, and the X6 change is what made that provable. That diagnostic is **not** checked in and
**decides nothing** — see **X7**.

### THE MUTATIONS — 7 built, 7 killed

All at `Legs = {l1,l2}`, `Capacity = 1`, `MaxTicks = 3`, `INVARIANT Safety` + `PROPERTY
TerminalIsFinal, QueuedLegsProgress` unless noted.

| # | Mutation | Result |
|---|---|---|
| **M3** | remove `LadderExhausted` from `Next` | **KILLED** — `QueuedLegsProgress` violated (217 291 / 47 957). *Requirement 1: removing the ladder-exhaustion transition recreates the liveness failure* |
| **M4** | drop the `legState[l] = "QUEUED"` guard from `LadderExhausted` | **KILLED** — `Action property TerminalIsFinal is violated` (24 098 / 6 290). *Requirement 2: breaking the guard is a safety failure* |
| **M5** | `LadderExhausted` targets `"QUEUED"` instead of `"FAILED"` | **KILLED** — `QueuedLegsProgress` violated (213 359 / 47 096). *Requirement 2: breaking the terminal state is a liveness failure* |
| **M7** | remove `LadderAdvance` from `Next` | **KILLED** — `QueuedLegsProgress` violated, and the graph collapses to **exactly** the pre-X6 8 030 / 1 909 / depth 27, which also confirms the new variable adds no states when it cannot advance |
| **M6** | `SF_vars(LadderAdvance)` → `WF_vars(...)` | **SURVIVED under this oracle** (676 854 / 156 941 / 0 queued, no error) and **KILLED under the X7-isolated oracle with `Liveness`** (violated, 66 489 / 15 885 / depth 15). **Recorded honestly:** `QueuedLegsProgress` cannot distinguish weak from strong fairness, because the only case it needs — a Leg *parked* in `QUEUED` — has `LadderAdvance` continuously enabled. The distinction is what the *cycling* case needs, and that is `EveryLegSettles` |
| **M1** | revert **only** the X4 widening of `CustodyLawfulStates` | **KILLED** — `Invariant Safety is violated` (4 294 / 1 349). *Requirement 3: the X4 custody invariant remains enforced* |
| **M2** | remove **only** X5's `TaskQuiescent` from `Next` | **KILLED** — `Deadlock reached` (530 / 214). *Requirement 4: X5 terminal quiescence remains necessary and still works* |

### What this does NOT close

**B-M is not closed and did not move.** `commitment_c2`/`c3` were **not re-run** and are still
UNKNOWN; §7.3a items 4, 8 and 10 (named operator, boundedness acceptance, release-owner acceptance)
are all still unsatisfied; `establishedByCommand` is still in place and must stay. **No independent
safety-engineering or release-owner approval exists for X6 — this is a solo project and none was
obtained or is claimed.**

**Do not:** treat X6's closure as progress against B-M's compute requirement; treat the X7-isolation
diagnostic as a decision; or read "`QueuedLegsProgress` passes" as "`Liveness` passes".

---

## X7 — cancellation was modelled as an indefinitely repeatable event; §4.6's cancellation latch was never transcribed

**Status:** ~~**OPEN — NEW, opened 2026-08-31 by the X6 pass**~~ → **CLOSED 2026-09-01 (fourth
pass), decided and implemented by the sole project owner/reviewer acting as the project's
specification and verification authority.**
**Classification:** ~~**SPECIFICATION — the frozen document is genuinely ambiguous here**~~ →
**TRANSCRIPTION DEFECT in `formal/lifecycle.tla`.** *Not* a specification ambiguity, and *not* a
shipped-implementation defect
**Decided:** 2026-09-01 · **Implemented:** 2026-09-01 in `formal/lifecycle.tla` **only**
**Verified:** 2026-09-01 — `lifecycle_c1.cfg` as checked in, complete graph, every declared property
PASS; X7 mutant killed

### The decision

**X7 is a transcription defect. The exact reason: the missing §4.6 cancellation latch.**

The defect is **NOT** that `STRANDED_*` is necessarily non-cancellable. The actual frozen-spec
requirement is §4.6's **one-cancellation-per-Leg latch** (`:1185`–`:1231`):

1. cancellation **writes `cancel_requested_at` and increments the version in a transaction** — and
   "does **not** attempt to reach a terminal state directly" (`:1185`–`:1186`);
2. every subsequent transition is guarded by that cancellation state —
   `cancel_requested_at IS NULL OR leg.purpose ∈ custodial_purposes` (`:1190`);
3. **nothing clears that cancellation request**, anywhere in the frozen document, so cancellation is
   **not an indefinitely repeatable event against the same Leg**. Step 5 (`:1228`–`:1231`) closes the
   loop for the Legs cancellation itself creates: "A requester may not cancel a `RECOVERY` or
   `TRANSFER` Leg at all".

`formal/lifecycle.tla` **did not model `cancel_requested_at` at all**, which made `Cancel` and
`CancelWithCustody` repeatable — and *that*, not any property of `STRANDED_*`, is what produced the
lasso.

**The shipped Backend implementation already has the latch**, and therefore forbids the X7 cycle
**through the latch** rather than through a `STRANDED_*`-specific rule:

| Shipped artefact | What it does |
|---|---|
| `Backend/src/engine/lifecycle/cancellation.js:119`–`:130` | Writes `cancelRequestedAt` in a **version-conditional** `updateMany`; a lost race returns `LOST_RACE`, not a second write |
| `Backend/src/engine/lifecycle/transitions.js:664`–`:669` `cancellationGuard` | Reads it; returns `CANCELLATION_REQUESTED` (not ok) once set, with the narrow custodial-purpose exemption of §4.6 step 2 |
| `Backend/src/engine/lifecycle/cancellation.js:101`–`:116` | Refuses a terminal Leg, and refuses a requester cancelling a custodial-purpose Leg — §4.6 step 5 |
| **Nothing in `Backend/src/` clears it** | The only `cancelRequestedAt: null` write is `domain/mappers/legacyTask.js:139`, constructing a **fresh** Leg at `version: 0` — initialisation, not a reset |

### The controlled D3 → D6 experiment

D1/D2 reproduce the previous graph exactly, confirming the scratchpad copy is faithful.

| | Variant | Result |
|---|---|---|
| **D3** | pristine `Spec`, 1 Leg | `Liveness` **VIOLATED** by the `CancelWithCustody ↔ Strand` lasso |
| **D4** | add **only** the §4.6 cancellation latch | `Safety` + `TerminalIsFinal` + `Liveness` **PASS** |
| **D5** | D4 at the `c1` shape | **COMPLETE graph, PASS** — 777 942 states / 187 289 distinct / depth 43 / **0 on queue** |
| **D6** | remove **only** the latch guard | `Liveness` **VIOLATED** — **mutant killed** |

D4 is the load-bearing row: adding the latch *alone* — with no `STRANDED_*` rule, no fairness on
`Recovered`, and no weakening of any property — discharges every declared property.

### What was implemented

`formal/lifecycle.tla` **only**. A per-Leg `cancelRequested` variable, `[Legs -> BOOLEAN]`,
initialised to `FALSE`; `Cancel` and `CancelWithCustody` each gain the guard `~cancelRequested[l]`
and the write `cancelRequested' = [cancelRequested EXCEPT ![l] = TRUE]`; every other action carries
it through `UNCHANGED`; `TypeOK` gains its domain. The latch is **never cleared**.

**Explicitly NOT done, and each was checked:** no `STRANDED_*` special case was added merely to kill
X7; no fairness was added on `Recovered`; `EveryLegSettles`, `CustodyNeverLost`,
`QueuedLegsProgress`, `Liveness`, `TerminalIsFinal`, `CustodyMatchesState`, `Next`, `Spec`,
`Fairness`, `TaskQuiescent`, `AllLegsTerminal` and `CustodyLawfulStates` are **byte-identical** to
their previous text; `CHECK_DEADLOCK` is unchanged and still absent from every `.cfg`; no `.cfg`
changed; no boundedness, timeout or artificial-progress constant was added. **X4/X5/X6 modelling is
intact.**

### Verification — the repository's own `lifecycle_c1`, as checked in

TLA+ v1.8.0, SHA-256 `eabd140a70f49eb9305a3bd3f3df944eddf87e5a90d329789085f8953a80533a` — the same
artefact as the previous controlled experiment — JDK 20.0.2, `-Xmx6g -XX:+UseParallelGC`,
`-workers auto -noTE`, `lifecycle_c1.cfg` **unmodified** (`Legs = {l1,l2}`, `Capacity = 1`,
`MaxTicks = 3`):

**777 942 states generated / 187 289 distinct / depth 43 / 0 left on queue · exit code 0 · "Model
checking completed. No error has been found." · graph CLOSED** — reproducing **D5 exactly**.
`Safety` **PASS**, `TerminalIsFinal` **PASS**, `Liveness` **PASS** (all three conjuncts, including
the two that defined X7). **The X7 lasso is gone.**

**Mutation check.** The minimal X7 mutation — remove **only** the two new latch-guard conjuncts, in
a scratchpad copy, leaving the variable, its `Init`, its writes and every `UNCHANGED` intact; the
repository was not modified — **KILLED the mutant**: exit 13, `Temporal property Liveness was
violated`, counterexample lasso `CancelWithCustody(l1) → STRANDED_OBSTRUCTING → Strand(l1) → back to
state 14` with `custody = HELD` throughout. **Behaving as expected; this creates no new repository
blocker.** Full record: **§17** of [`PHASE_15_BM_TLC_RUN_RECORD.md`](PHASE_15_BM_TLC_RUN_RECORD.md).

### Question A — recorded, non-blocking, deliberately NOT resolved

Whether a `STRANDED_*` Leg should be cancellable **at all** remains an open *modelling* question. It
is **non-blocking**: it does not need to be resolved to fix X7, and it was not. Under the latch, a
stranded Leg that has never been cancelled may still be cancelled — once — which is exactly what
makes this repair a transcription of §4.6 rather than a special case aimed at the counterexample.
**Do not re-open the previous three-reading framing of `STRANDED_*` cancellation to settle it.**

### Known remaining divergence — `lifecycleModel.js`, recorded not fixed

`Backend/tests/engine/helpers/lifecycleModel.js:347`–`:353` applies `cancellationGuard` to every
event **except `CANCEL_REQUEST` itself**. The executable checker therefore still admits a repeated
cancellation request that the shipped engine refuses. This is a **separate permissive-model
observation**, not part of X7's closure: **no test was changed by this pass**, and it does not
affect the shipped implementation, which has the latch.

### Consequence for B-M — it REMAINS OPEN

`lifecycle_c1` now passes on a closed graph. **That is not B-M.** B-M requires the complete
capacity 1/2/3 evidence and its acceptance: **`commitment_c1` PASS · `commitment_c2` UNKNOWN ·
`commitment_c3` UNKNOWN · `lifecycle_c1` PASS (new) · `lifecycle_c2` and `lifecycle_c3` still
require authoritative treatment.** The two commitment UNKNOWNs are **deliberately unaffected** and
were not re-run. **2 of 6 configurations close, was 1.**

---

## X7 — the original entry, retained verbatim below

*(Superseded by the decision above. Retained because the register's own convention is that a
correction belongs beside the record, not on top of it. **Its central classification is corrected
above**: X7 is a transcription defect — the missing §4.6 cancellation latch — not the specification
ambiguity about `STRANDED_*` cancellability that this entry frames it as. The **cycle it describes
is real and was reproduced**; what changed is the diagnosis of its cause.)*

**Status:** **OPEN — NEW, opened 2026-08-31 by the X6 pass. Deliberately NOT decided by the pass
that found it.**
**Classification:** **SPECIFICATION — the frozen document is genuinely ambiguous here.** *Not* a
transcription defect, and *not* a shipped-implementation defect on the evidence gathered
**Owner:** the project's specification/verification authority
**First discovered:** 2026-08-31, by checking the `Liveness` conjuncts one at a time — which the
X4/X5 pass did not do
**Last verified:** 2026-08-31

**The cycle**, reached at depth 12 with a single Leg:

```
… Load → LOADED → (timer) → ABORTING → (timer) → STRANDED_OBSTRUCTING
    --CancelWithCustody--> ABORTING --Strand--> STRANDED_* --CancelWithCustody--> …
```

`custody` is `HELD` at every state of the lasso and never becomes `RELEASED` or `DISPUTED`, so
**`CustodyNeverLost` is violated**. The same cycle starves every other Leg — it supplies an infinite
run of `Next` steps, which is all `WF_vars(Next)` requires — so **`EveryLegSettles` is violated too**,
by a sibling frozen in `REASSIGNING`. Blocking that one edge as a diagnostic makes **every** declared
property pass exhaustively (662 454 / 156 941 / depth 43 / 0 on queue), so this is the single
remaining cause of the lifecycle `Liveness` failure.

### Why this is a specification question and not a transcription defect

The model's `CancelWithCustody` is a literal reading of §4.4's `:1145` row — <code>\| any
non-terminal \| cancel request \| `ABORTING` \| …</code> — and `STRANDED_*` **is** non-terminal
(§4.3). **The frozen document says two things that cannot both be honoured for a Leg stranded with
goods aboard**, and X4 is what made that state modellable in the first place:

| Reading | Support in the frozen specification |
|---|---|
| **A stranded Leg is not cancellable.** §4.4's stranded rows (`:1147`, `:1148`, `:1149`) enumerate the exits from `STRANDED_*` — re-classification between the two, and "goods recovered and agent recovered → `FAILED` or `SETTLED`" under the guard "custody accounted for (§4.9)". None routes a stranded Leg back to `ABORTING`. §4.3 gives `STRANDED_*` an on-expiry action of "**page operations**", which is not a state transition. On this reading X7 is a second transcription defect, in `CancelWithCustody` | §4.4 `:1147`–`:1149`, §4.3 `:1054`–`:1055` |
| **A stranded Leg is cancellable, and physical response is eventually assumed.** §4.4 `:1145` says "any non-terminal" without exception. Then `CustodyNeverLost` needs a fairness condition on `Recovered` — justified by §4.3's `ops.stranded_*_response_target` and §18.6's external escalation chain, which do assert a bounded physical response | §4.4 `:1145`, §4.3's response targets, §18.6 |

**A third possibility must also be put to the authority:** that `CustodyNeverLost` should carry the
same `STRANDED_*` exemption `EveryLegSettles` already carries. The module's own comment argues for
it — §4.3 says recovery there "is impossible without physical intervention", so "the obligation is
that the state is reached and paged, not that software leaves it". But **§24.2 states the custody
clause unconditionally** — "custody is never lost — every `HELD` transitions to `RELEASED` or
`DISPUTED`" (`:5216`) — and it states it under **Safety**, not Liveness.

**This is exactly the ambiguity that must be reported rather than resolved.** Choosing any of the
three would be making a new safety decision in order to make a model pass, and each produces a
different model.

**Do not:** block `CancelWithCustody` on `StrandedLegStates`, add fairness on `Recovered`, or exempt
`STRANDED_*` from `CustodyNeverLost`, without a recorded decision. The first of those was run **as a
diagnostic only** and is not checked in.

**Closure condition:** the authority records which reading of §4.4 `:1145` governs a `STRANDED_*`
Leg, and whether §24.2's custody clause admits a stranding exemption; only then is the model changed
to match.

**Consequence for B-M:** the lifecycle half of `model_check_capacity_1_2_3` still cannot pass.
**X6 being closed does not change that.**

---

## X6 — the original entry, retained verbatim below

*(Superseded by the decision above. Retained because the register's own convention is that a
correction belongs beside the record, not on top of it. **Two of its factual claims are corrected
above**: the counterexample is the reassignment lasso rather than the `Reject` cycle, and all three
`Liveness` conjuncts fail rather than one.)*

**Status:** ~~**OPEN — NEW, opened 2026-08-31 by the X4/X5 verification pass**~~ → **CLOSED**
**Classification:** **SPECIFICATION / FORMAL MODEL — fairness and §17.4 coverage**
**Owner:** the project's specification/verification authority — **on this project, the sole owner**,
who has **deliberately not decided it in the same pass that found it**
**First discovered:** 2026-08-31, by the first-ever *evaluation* of the lifecycle liveness
properties — which only became possible once **X5** was decided
**Last verified:** 2026-08-31

> ### This is not a regression, and it is not caused by the X4 or X5 change.
> It is a **pre-existing defect of the model that X5's deadlock abort had been masking.** Before
> this pass, all three lifecycle configurations died at depth 6 and **no liveness property had ever
> been evaluated by TLC at any capacity.** Fixing X5 did not create this; it made it visible — which
> is exactly what the X5 entry predicted a genuine fix would do, and the reason the fix is
> trustworthy.

**Current evidence:** all three configurations, run **as checked in**, report
`Error: Temporal property Liveness was violated.` The `c1` counterexample is a complete lasso on a
closed state graph (8 030 states, 1 909 distinct, depth 27, 0 left on queue):

```
QUEUED → Plan → PLANNED → Offer → OFFERED → Reject → QUEUED → …
```

cycling forever at `ticks = 3 = MaxTicks`, with `l2` already `CANCELLED`. Leg `l1` never reaches a
terminal or a stranded state, so **`EveryLegSettles` is violated**. (The other two conjuncts are
satisfied on this trace: `QueuedLegsProgress` holds — the Leg *does* leave `QUEUED` each cycle — and
`CustodyNeverLost` is vacuous, `everHeld` being `FALSE` throughout.)

**Two candidate root causes, and they are not the same fix:**

| Reading | What is wrong | What it would take |
|---|---|---|
| **The fairness statement is too weak** | `Spec` asserts `WF_vars(Next)` — weak fairness on the **whole disjunction**. That guarantees *some* action keeps firing, not that `Settle`, `Cancel` or the ladder ever does. `Plan`/`Offer`/`Reject` can conspire to keep a Leg alive forever while consuming no ticks | Per-action fairness, which is **a change to the specification's fairness statement** |
| **The model is missing §17.4's ladder termination** | §4.4 has a `QUEUED` → `FAILED` row on *"ladder exhausted"*. **`lifecycle.tla` has no such action and no bound on re-planning**, so a Leg can be re-planned unboundedly — which the real system cannot do | An action transcribing §4.4's ladder-exhaustion row |

**The second is more likely the real defect**, and it connects to **X1/T1-04**: §17.4's escalation
ladder was implemented in `Backend/src/engine/fairness/` on 2026-08-30, and **it was never
transcribed into the TLA+ module.** The model therefore permits a starvation the shipped engine
forbids.

**Deliberately NOT decided in this pass.** Both repairs change the transition relation or the
fairness statement of a module that transcribes the frozen specification. **That is exactly the
class of change X4 and X5 required a recorded decision for**, and making a third such decision
inside the verification pass that discovered it would be the failure mode this register exists to
prevent. **It is recorded, scoped and left open.**

**Consequence for B-M, stated plainly:** the lifecycle half of `model_check_capacity_1_2_3` **still
cannot pass** — no longer because nothing is evaluated, but because a declared property now fails.
**This is progress and it is not a discharge.**

**Do not:** weaken `EveryLegSettles` or delete it to make TLC green; add per-action fairness without
a recorded decision; or treat X6 as closed because `Safety` passes.

**Closure condition:** the authority records which reading is correct and why; only then is the
model changed to match.

---

## X1 / T1-04 — The §17.4 escalation ladder and the three fairness modules

**Status:** **CLOSED — implemented, composed, and verified against a live database** (2026-08-30)
**Classification:** was SPECIFICATION / ADR · **now discharged by REPOSITORY work**
**Owner:** **REMEDIAL PHASE T1-04** (`IMPLEMENTATION_EXECUTION_PLAN.md` §3, §6.3)
**First discovered:** recorded as ARCHITECTURE.md gap 16 / OAD-7 · **Closed:** 2026-08-30

**What it was:** `src/engine/fairness/` existed and was empty. §1.8 places the anti-starvation
*guarantee* in this ladder, and Phase 8's aging-multiplier cap was justified *because* the
guarantee lives here — so the engine had neither the unbounded price it had deliberately given up
nor the ladder it gave it up for.

**What now exists (all three, Tier 1, invariant I13):**

| Module | What it implements |
|---|---|
| `src/engine/fairness/ladder.js` | §17.4's eight rungs, triggered on elapsed queue age over `sla.assignment_deadline`; four named verdicts; every crossed rung recorded with what was relaxed and why |
| `src/engine/fairness/operatorCapacity.js` | §17.4's human capacity model — `ops.escalation_capacity`, the triage order, holding, and sustained-saturation alerting |
| `src/engine/fairness/agentStarvation.js` | §17.5's detection: zero completed missions in `fairness.idle_alert_period` while nominally available |

**Where it runs — the composition, which is the part that makes it more than a module:**

- `workers/leaderWorkers.js:timer()` builds the ladder and passes it to
  `expiryActions.handlers({ ladder })`. The timer worker fires `ESCALATION_LADDER`, which §4.3
  declares as the expiry action of `QUEUED`. That is the runtime caller, and there is no other.
- `services/task.service.js:admitToRound()` now arms the `QUEUED` deadline in the transaction that
  creates the Leg. **This was the load-bearing find of the session:** the production request path
  armed *no* `QUEUED` timer at all, so `checkI4` reported every admitted Leg as `NO_PENDING_TIMER`
  and the ladder had no trigger for customer work. Composing the ladder without this would have
  produced a mechanism that was present, tested, and unreachable.
- `server.js` starts `workers/fairness.worker.js` for §17.5, whose signal is an *absence* over a
  window and therefore has no deadline behind it.
- `observability/metrics.js` derives `outstanding_escalations`, `escalation_saturation_time` and
  `ladder_step_distribution` from `LadderEscalation` — the three §21.4 SLIs whose producer note
  used to read "`src/engine/fairness/` still holds no ladder".

**Verification:** 93 tests in `tests/engine/fairnessLadder.test.js`; the full five-lane suite green
at **161 suites / 7 261 tests**; and **72/72 checks against live PostgreSQL 18.3** via
`npm run verify:t104` — every one of the migration's ten CHECK constraints rejecting its own
planted violation, and the shipped module driven end to end through real Prisma transactions.
(65/65 at T1-04's own closure; the seven added on 2026-08-30 are the `Leg.slaDeadline` producer
below, driven through the real `admitToRound` path.)

**Not everything §17.4 and §17.5 name is implemented.** Four genuinely remain, each with a stated
reason rather than an omission:

| Remaining | Why |
|---|---|
| §17.5 **exercise missions** | A short reposition mission needs §17.3's repositioning — **Tier 2**, which §1.8 rule 2 forbids this Tier 1 mechanism from depending on — and no EXERCISE Leg producer exists. `agentStarvation.exerciseCandidates` produces the list; every entry carries the blocker |
| §17.4 **rate limiting** into the human queue | No register entry parameterises a rate. Admission is gated on concurrent capacity, which §17.4 *does* parameterise. A gap in smoothing, not in the guarantee |
| §17.4 **saturation → §20.5 admission control** | The directive is emitted; nothing consumes it. Owned by §20.5, not by T1-04. **Re-derived 2026-08-30 — this is not one missing producer but four distinct undecided questions; see below** |
| §17.4 rung 8 **alternative modality** | No register entry names a modality set, so "where configured" reads as not configured and the decline branch runs. The collaborator seam exists and is unused |

#### `Leg.slaDeadline` — **CLOSED 2026-08-30**

T1-04 left §17.4's triage comparator with a third key it could not use. `compareForTriage` orders
escalations by "custody state first, then obstruction class, **then SLA breach proximity**, then
queue age", and breach proximity is read from `Leg.slaDeadline` — a nullable column whose only
writer on the tree was `domain/mappers/legacyTask.taskToWork()`, which sets it to `null`. Every Leg
therefore reached a dispatcher as "proximity unknown", and the key collapsed to arrival order.

**The producer.** `task.service.superviseQueuedEntry` now writes the column in the transaction that
creates the Leg, as `storeTime + sla.assignment_deadline`. Nothing was invented: §4.3 gives Leg
state `QUEUED` the exit deadline `sla.assignment_deadline` (registered, default 900 s), §4.5
requires that deadline to be registered in the transaction entering the state, and the column holds
that deadline's absolute instant. The producer sits beside the §4.5 timer and takes the **same**
resolved budget and the **same** store-clock read, so the instant §17.4 sorts on and the instant
§4.5 fires on are one number rather than two that can drift.

Three properties are load-bearing and each is tested:
- **The whole budget, not the rung.** The timer is armed at rung 1's boundary (225 s of 900 s)
  because the ladder re-arms at each rung. A deadline derived from that would declare every Leg in
  breach 675 s early — urgent-looking and wrong.
- **Written once, never moved.** It sits below the "already supervised" guard, so a retried
  submission converging on the same Leg does not recompute it against a later clock. Requeue paths
  (§11.2, `cutover/legEntryDeadline.superviseEntry`) are deliberately untouched: restarting the
  assignment budget on every offer rejection would reset the anti-starvation clock a Leg could then
  cycle indefinitely against.
- **Null over a guess.** An unresolvable `sla.assignment_deadline` leaves the column `null` (§22.1),
  which the comparator already reads as "proximity unknown, sort last".

**Verification:** 7 focused tests in `tests/engine/intakeStranglerSeam.test.js`; the engine lane
green at **130 suites / 6 927 tests**; and **7 live-PostgreSQL checks** in `npm run verify:t104`
driving the real `admitToRound` (72/72 overall). Both mutants were built and both were caught —
`budgetSeconds → armedSeconds` fails 3 tests, removing the write fails 5.

**This closes the column's gap and nothing wider.** `Leg.slaDeadline` is populated by the legacy
`Task` → Leg admission path, which is the only Leg-creation path in production. Legs created by any
future non-legacy intake would need the same producer, and Legs admitted *before* this change keep
`null` — no backfill was run, because rewriting the deadline of an in-flight Leg would change the
supervision it is already under.

#### §20.5 admission control — why the seam cannot be closed by writing a producer (2026-08-30)

A pass scoped to §20.5 traced the seam and found the earlier "no production producer" framing
**understated the blocker**. `intake/admission.js` is complete and correct; `intake.admit()` already
calls `admission.assess()`. What is absent is not wiring but **decided semantics for the inputs**.
Measured on the production input shape — `admissionInputs` is `{}` because neither
`tasks.controller.js` nor `socket.server.js` ever sets it — `assess()` returns **ADMIT for all 30
purpose × SLA-class combinations**, with every observed control value `null` except `shedLevel`,
pinned at `0` (`NOMINAL`). §20.5 is presently incapable of declining anything in production.

Each of the four controls is blocked on a **different** missing decision:

| Control | Missing decision |
|---|---|
| Per-tenant rate / concurrency quotas | **§27 open decision #13** — "Multi-tenancy model … drives F4, `C_policy`, and **quota design**", *Depends on: Commercial model*. No quota parameter is registered, and `tenantId` has no production source (null on every request). **External/commercial, not repository-owned** |
| Global admission (projected queue delay > class budget) | The rule and the budget are settled — `sla.assignment_deadline` (default 900 s, scoped `sla_class`/`tenant`) is resolvable via `snapshot.resolve()`, and `predictAssignmentWindow`'s `atRisk` field is already arithmetically the §20.5 test. The **input** is not producible: §3.4 defines the projection as "derived from current queue depth **and supply**", `solve/cadence.js` keys its regime on feasible supply, and the specification never defines what quantity *intake* measures as supply — while §3.4 forbids consulting the routing provider on the request path and §7 makes feasibility a round-path evaluation. `feasibleSupply` has **no producer anywhere on the tree**, including in `coordinator.worker.js`, which takes it as an input defaulting to `0`. The Availability Index cannot supply it: it is cache-tier and advisory, and §3.3 / §18.5 rule 3 forbid promoting it to an authority for a customer-visible decline. `cadence.windowFor`'s config shape has no register→config producer either |
| Class-based shedding (`shedLevel`) | The published **order** is implemented (`SHED_LADDER`). The **level** is not derivable: §18.5 makes Shed Load a *binary* named mode, B19's entry condition ("arrival rate > capacity") has **no registered threshold parameter**, and no published mapping exists from overload severity to rungs 1/2/3. Nothing under `src/` ever calls `transitions.enter()` for `SHED_LOAD` |
| §17.4 saturation → admission | The **trigger** is fully specified and already computed deterministically by T1-04 (`ops.escalation_capacity`, `ops.escalation_saturation_period`). The **consequence** is not: "declining new work of *the affected classes*" — the phrase occurs **exactly once in the 5 941-line specification and is never defined**. Closing it requires choosing (a) which classes are "affected", and (b) whether the consequence is a §20.5 *shed* verdict (purpose-then-class, custodial-exempt) or a *global-admission decline* (queue-delay-keyed) — different verdicts, different operator meanings, different custodial paths |

**No code was written for §20.5.** Each producer would have required inventing a threshold, a
supply definition, or a class set that the frozen specification does not publish — and a producer
that manufactures its own input is the failure mode this blocker register exists to record, not a
closure of it. The two decisions that would unblock the repository-owned half are: **what quantity
intake measures as "supply"**, and **what "the affected classes" denotes in §17.4**.

**`src/engine/lifecycle/preemption.js` is still absent, and that is correct** — §4.8 preemption is
**Tier 2 / Phase 16**. It was listed as evidence under this blocker; it is not T1-04's. Rung 4
emits a `PERMIT_PREEMPTION_OF_LOWER_CLASS` directive and calls nothing, which is what §1.8 rule 2
requires and what `gate:tiers` enforces.

**Closure condition (met):** the three modules exist, are reachable from the production path, and
are verified against a live database. **E1/E2 are now dischargeable as far as T1-04 is concerned**
— they remain blocked by B1, which is external.

---

## A9 — `assertVersionInKey` is implemented, tested, and called by nothing

**Status:** OPEN — **correctly deferred**
**Classification:** **REPOSITORY-OWNED**, deferred to **Phase 8**
**Owner:** Phase 8
**First discovered:** B1 prerequisite pass, 2026-08-28 · **Last verified:** 2026-08-29

**Current evidence:** defined at `src/engine/routing/chargerReachabilityCache.js:124`, exported at
`:375`. The only callers on the whole tree are `tests/engine/energySchema.test.js:268–269` (both
directions asserted) and one explanatory comment in `tools/routing/adapters/contract.js:340`. No
production caller exists.

**Why it does not block now:** its discharge point is `src/engine/routing/client.js` — a Phase 8
module that **does not exist** and cannot exist before B1. Meanwhile `read()` already carries a
genuine independent cross-check that a self-built key could not provide, so nothing is currently
unguarded.

**Can repository code solve it?** Only by manufacturing a caller, which would be a fake seam.

**Do not:** manufacture a caller. A guard called from a synthetic site is not a guard.

**Closure condition:** `src/engine/routing/client.js` is built (post-B1, Phase 8) and calls it.

---

## V-10 — the rollback runbook traced against the current API (CLOSED 2026-08-30)

**Status:** **CLOSED** — executed, five defects fixed, verified against a live database
**Classification:** REPOSITORY-OWNED · **was the only Phase-15-owned closure-checklist row that
was actionable in this repository and had never been executed**
**Owner:** Phase 15 · **Executed:** 2026-08-30 at digest `d033038c…` (573 files)

**What V-10 was.** `PHASE_15_CLOSURE_CHECKLIST.md` §C row **V-10** —
*"`docs/runbooks/rollback.md` procedure executed against the current API"* — stood at
`NOT EVALUATED`, blocking **No**, with the note *"No pass has ever done it"* and the status
**UNKNOWN, not clean**. It was the next genuine item: `rollback.md` §5 is the procedure the
`rollback_rehearsed` gate (**B-O**) is evidence for, and `rollbackPublisher`'s
`SUPERSEDES_AN_UNPINNED_VERSION` refusal routes an operator into §2 by name. A runbook that has
drifted is discovered during the incident it exists for.

**Five defects. The first is permissive and fleet-wide.**

| # | Defect | Severity |
|---|---|---|
| **V10-1** | **§2 step 1 published a single binding.** It read, in full: *"Publish `authorisation.action.binding` (`cutover.engine_enabled = false`, region scope)."* A configuration version is a **complete set** — `config/service.publish()` writes exactly `snapshot.declaredBindings` and inherits nothing, and `config.controller.publishVersion` defaults `bindings` to `[]`. The manual Rollback A therefore reverted **every other parameter in the deployment** to its register default, as a side effect of disabling one shard. `rollbackPublisher.bindingsWithRegionDisabled` exists precisely to prevent this on the automatic path; the runbook never carried it across. Fixed by new **§2.1**, which gives the recipe, names `POST /api/config/publish`, and states the pin | **Permissive, fleet-wide** |
| **V10-2** | **§2 promised a coordinator stand-down that no code performs.** *"The coordinator stands down for that shard at the next tick."* The per-shard switch has four production consumers and `coordinator.worker.js` is not one of them. Corrected in the runbook; **the missing gate is routed to B1's composition-root work** (item 5 above) and deliberately not written, because the worker it belongs in cannot be composed | **Permissive claim; latent behaviour** |
| **V10-3** | **§4 argued Rollback B was safe from a mirror that has no writer.** *"It reads `Robot.currentTaskId`, which the engine maintains as a mirror, so an agent executing an engine commitment appears busy and is not re-assigned."* **No code in the build assigns `Robot.currentTaskId` a task id.** Its only writers clear it (`tasks.controller.js:263`, `dtaro.handler.js:183`); it was the *legacy* path's own record (`tools/migrate/backfillDomain.js:32-34`) and that path was deleted at Phase 15. So after Rollback B every agent holding an engine commitment reads IDLE to the legacy dispatcher and can be re-assigned — **a double assignment, arriving during the incident that prompted the rollback**. Corrected, and the hazard and the `Commitment`-table remedy stated. **The column is retained by design** and `commitmentSchema.test.js` still fails if a drop arrives early — *retained is not maintained* | **Permissive claim; real hazard** |
| **V10-4** | **§5 never named the six rehearsal step keys.** The record table said *"each of the six steps above, named individually"*. `evidence.REHEARSAL_STEPS` requires `cutover`, `automatic_rollback`, `no_decision_path_confirmed`, `artefact_rollback`, `recutover`, `recorded`. A record filed from the runbook alone is refused `REHEARSAL_INCOMPLETE` — **on a gate no build can close**. The keys, and the `approval.recordedBy`/`approvedBy` and `pass` fields, are now named | **Obstructive — blocks B-O** |
| **V10-5** | **`rollbackPublisher.js` cited `rollback.md` §4** for the carry-forward sentence, which is in **§3**; §4 is Rollback B and says nothing of the kind. Corrected in the code comment | Low |

**Also corrected in `cutover.md`, because it is the same sentence:** §3.3's *"Publish
`authorisation.action.binding` through the Config Service"* carries V10-1 in the enable
direction, and it named **`POST /api/config/versions`** as the publish endpoint. That endpoint
does not exist — `/versions` is `GET`, the read-only version list, and it returns no payloads.
The publish route is **`POST /api/config/publish`**.

**One claim in this register's own draft was corrected by the live run.** The one-binding
publish does **not** simply succeed: **V9** refuses it, because dropping the set takes
`route.degraded_reserve_factor` to a default over the combined-conservatism cap. That is a
guard by coincidence, not by design — it names an energy cap rather than the four vanished
bindings, and check **B2** of the harness shows that resolving it the obvious way (bind the one
parameter the message names) publishes and pins successfully, reverting everything else. The
severity is unchanged; the description is now true. This is recorded because a register that
edits its own drafts silently is a register nobody can audit.

**Verification:** 7 tests in `tests/engine/phase15RollbackRunbook.test.js`; **3 mutants built,
3 killed**; the engine lane green at 131 suites / 6 934 tests and the full suite at 162 / 7 275;
and **15/15 against live PostgreSQL 18.3** via `npm run verify:v10`, including a BEFORE variant
that reproduces the fleet-wide revert and a `C6` check that the manual recipe and the automatic
publisher produce the same binding set field for field.

**What V-10 did NOT do:** it did not add a prose-parsing gate, digest-scope `docs/`, weaken any
gate, or write the coordinator's cutover check. **P15-F7a — the structural gap that nothing
binds a runbook to its API — is still open**, and is residual observation 1.

**Closure condition (met):** the procedure traced end to end against the current API, the drifts
corrected, and the corrected procedure executed against a real database.

---

## V-9 — the Phase 0–14 cross-phase re-verification (CLOSED 2026-08-30)

**Status:** **CLOSED — executed, no regression found, no code changed**
**Classification:** REPOSITORY-OWNED · **was the last Phase-15-owned closure-checklist row that
was actionable in this repository and had never been executed** — the successor to V-10, and the
fourth pass running in which the next genuine item was **not in this blocker table**
**Owner:** Phase 15 · **Executed:** 2026-08-30 at digest `d033038c…` (573 files)

**What V-9 was.** `PHASE_15_CLOSURE_CHECKLIST.md` §C row **V-9** — *"Phase 0–14 cross-phase
re-verification"* — stood at `NOT EVALUATED`, blocking **No**, result **UNKNOWN**, with its
trigger (*"run if the tree changes materially"*) **already fired**: T1-04 and the `Leg.slaDeadline`
producer changed `expiryActions.js` (+153), `leaderWorkers.js` (+68), `task.service.js` (+187),
`metrics.js` (+123), `schema.prisma` (+103) and added migration 28 — and
`tools/verify/phase5ExpirySemantics.js` requires the first two directly.

**Scope was derived, not judged.** The transitive `require()` closure of all **22** Phase 0–14
harnesses was intersected with the **11** changed application-source files. **4 carry a changed
module** (`phase5ExpirySemantics` 5, `phase9ProductionPath` 5, `phase14LiveDatabase` 3,
`phase11LiveDatabase` 1); **18 carry none**. The schema diff was read and is **purely additive** —
one new table, one back-relation, **no pre-existing column altered** — so no Phase 0–14 subject
table moved. **7 harnesses were run; 14 were skipped with that measurement as the reason.**

**Result: 315 / 317 checks on disposable PostgreSQL 18.3.** `phase5LiveDatabase` 106/106 ·
`phase13LiveDatabase` 73/73 · `phase11LiveDatabase` 31/31 · `phase9ProductionPath` 7/7 ·
`phase12Profile` completed clean · `phase5ExpirySemantics` **100/102**.

**The 2 failures are not defects, and this was proven rather than argued.** Both are
`phase5ExpirySemantics` **FINDING assertions** — checks that pass by confirming a gap is still
open — and the gap they assert is *"§17.4's escalation ladder has no implementation"*, which
**X1/T1-04 closed on this same tree**. The subtler of the two returned
`LADDER_UNDETERMINED:LADDER_NOT_PUBLISHED`, which could have meant the shipped ladder was inert.
It does not: the harness's hand-built `VALUES` map carries **0** of the 8 `ladder.step_*_fraction`
entries T1-04 registered, and feeding the shipped `stepTableFrom` that same map **plus the
register's own fractions** flips it from `ok=false` to `ok=true` with 8 strictly increasing
rungs. `verify:t104` corroborated end to end at **72/72** on the same cluster. **The
`LADDER_EXHAUSTED → FAILED` row was not taken and the deadline was re-armed** — the property those
checks exist to protect held.

**What V-9 did NOT do:** it did not edit the two stale assertions to make the run green (that
would have destroyed the record of what they asserted), did not fabricate the `Mission` row that
would have let `phase12LiveDatabase` run, did not touch a gate, threshold, test or configuration,
and did not re-collect release evidence. **`git status` is empty and the digest is unmoved at
`d033038c…` / 573** — so **no mutation testing was owed**, V-6 being a per-*implementation*-pass
requirement.

**Two items are handed on, neither of them Phase 15's:**
1. **Phase 5 owns its own harness's staleness** — `phase5ExpirySemantics.js:334` and `:1101`
   assert a pre-T1-04 world. What to change is written out in
   `PHASE_15_VERIFICATION_STATE.md` §7c.4. Not done here.
2. **A pre-existing seed defect**, found incidentally and registered as **residual observation 8**
   below. It is repository-owned and actionable and it is **not a Phase 15 item**.

**Closure condition (met):** the harnesses whose subjects moved were identified by measurement,
executed against a disposable live database, and every failure classified as regression or
expected semantic change on evidence. **V-9 — CLOSED / VERIFIED.**

---

## Residual in-repository observations — reported, not fixed, none permissive

These are **not blockers**. They are carried forward so a future pass inherits named gaps instead of
rediscovering them. Each was re-confirmed present on 2026-08-29.

| # | Observation | Evidence | Why it is not a blocker |
|---|---|---|---|
| 1 | **P15-F7a — nothing binds a runbook to the API it documents.** `docs/` is outside the source-digest scope by design, so no gate detects a runbook drifting from a signature it calls. `docs/runbooks/cutover.md` §3.2 drifted through two contract changes with every build gate green — and **on 2026-08-30 V-10 found five more drifts, in the other runbook** | `tools/release/sourceDigest.js` scope; the P15-F7 defect; the V-10 findings below | Structural gap. Still **not** fixed by digest-scoping `docs/` (which would void a ~25-min evidence collection on every prose edit) or by a prose-parsing gate (an unmaintained future false green). **Two partial compensating controls now exist and are the most that should be built:** `rollback.md` §7 records the date of the last hand-trace, and `tests/engine/phase15RollbackRunbook.test.js` pins the two *constants* the runbook enumerates — not its prose |
| 2 | ~~**`docs/runbooks/rollback.md` has never had its procedure executed against the current API.**~~ **EXECUTED 2026-08-30 — closure item V-10.** Five defects found and fixed; see § *V-10* below | `npm run verify:v10` — 15/15 on live PostgreSQL 18.3; 7 tests in `tests/engine/phase15RollbackRunbook.test.js`; 3 mutants, 3 killed | **No longer UNKNOWN.** The surface is examined and the defects are closed. The *structural* exposure is observation 1 and remains open |
| 3 | **`app.locals.releaseEvidence` has no producer** (P15-E6). The cutover health endpoint always evaluates against `{}` | `grep`: no assignment; read with `\|\| {}` at `health.controller.js:319` | **Fails closed** — every gate reads as not-green |
| 4 | **`gates.blockers()` ignores `unknownEvidence`.** Evidence filed against an unknown gate id never appears as a blocker | `src/engine/cutover/gates.js` — `blockers()` filters `results` only | `evaluate()` does fold it into `ok`, and `verdict.js` prints it |
| 5 | **The evidence schema cannot distinguish a gate that failed from a gate that never ran** | Discovered when a gate process failed to start (`0xC0000142 STATUS_DLL_INIT_FAILED`) and the collection was discarded rather than reported | Detected in practice; the affected collection was voided, not published |
| 6 | **The register accessor is injected**, and pass 2's **X-C1** / **X-C2** | Archived third-pass report §33.3, probe 12d | Carried forward, none permissive |
| 8 | **`prisma/seed.js` fails silently and exits 0 — a partial seed reported as success.** It aborts inside `seedRegister` with `Invalid value for argument "changeClass". Expected ConfigChangeClass`: **3 register entries carry `changeClass: "OPERATIONAL"`** (`feasibility.negative_cache_ttl`, `link.min_quality`, `reliability.max_intervention_rate`) and the enum has **7 members, none of them `OPERATIONAL`**. `main().catch(console.error)` swallows it, so the process **exits 0** having written **165 of 250** register entries and **0 Mission / 0 Shard / 0 Region / 0 Agent**. **Found by V-9 on 2026-08-30**, as the reason `phase12LiveDatabase.js` could not run from an empty cluster | Measured on the disposable cluster: `SELECT count(*)` → `ParameterRegisterEntry` 165, `Mission` 0, `Shard` 0, `Region` 0. **Proven pre-existing by construction:** the enum, the 3 entries and `seed.js` are **byte-identical at `67b7c7c`**, the T1-04 diff touches none of them, and `git log -S'"OPERATIONAL"'` dates it to **`cbe540e`, 2026-08-09** | **Not permissive, and NOT Phase 15's** — it predates the tree movement V-9 assesses by three weeks, moves **no §24 gate**, and affects only a development/verification fixture path. It **is** repository-owned and actionable, and is recorded here rather than fixed because the choice between *"add `OPERATIONAL` to `ConfigChangeClass`"* and *"reclassify the 3 entries"* is a **§22.1 register governance decision**, not a mechanical one. `gate:params` does not catch it because it reads the register JSON, never the database. **Do not fabricate the missing `Mission` row to make `phase12LiveDatabase` green** |
| 7 | **CI does not run `gate:composition`** — CI is green on a tree where a blocking §24 gate is RED | `.github/workflows/ci.yml` — 7 gate steps, no `gate:composition`; the workflow header enumerates exactly **two** deliberate absences (`gate:calibration`, `safety:case`) and this is not one of them, so **no reason is recorded**. `npm run gates` runs 8 and exits 1; CI runs 7 of those 8 and exits 0, and the omitted one is the only one that fails | The gate is authoritative via `npm run gates` and `release:verdict`; CI is not the §24 authority. **Recorded by the consolidation; extended by the 2026-08-29 audit**, which additionally found that `gate:columngen` is pull-request-only (a push runs 6 gate steps) and that `ARCHITECTURE.md` §9.1 and `ROBOTX_SYSTEM_HANDBOOK.md` §42 both described CI as running the complete gate set. Those two prose statements were corrected; **CI itself was not changed** — that is a code change and is out of scope for a documentation pass |

---

## Cross-phase documentation discrepancies — recorded, not owned by Phase 15

**These are not blockers and not Phase 15 findings.** They are places where documentation outside
`docs/phase15/` disagrees with the current repository. The audit of 2026-08-29 classified each by
**who owns the correction**, corrected only the Phase-15-owned ones, and left the rest in place
with the reasoning below. Nothing here was silently discarded.

**Standing rule.** Where any of these documents and the five canonical Phase 15 documents disagree
about Phase 15, the canonical documents win — `PHASE_15_MASTER.md` §1's authority order, rank 3
(the repository) then rank 5. `ARCHITECTURE.md` ranks itself below both, in its own words.

### Corrected on 2026-08-29 — Phase-15-owned and provably false

| # | Statement | Where | Truth | Why Phase 15 owned it |
|---|---|---|---|---|
| **C1** | "None of the 19 workers is on production scheduling" | `ARCHITECTURE.md` §4.2 · `ROBOTX_SYSTEM_HANDBOOK.md` §3.3 | **12 of 19 start** (re-measured 2026-08-30): 9 `SCHEDULED` at boot + 3 of 4 `LEADER_ONLY` on promotion. *(Read "11 of 18 · 8 SCHEDULED" when written on 2026-08-29; T1-04's `fairness.worker.js` is the 19th and it is `SCHEDULED`. **The falsehood being corrected is unchanged — "none" is still wrong.**)* | "All engine workers move to production scheduling" **is** Phase 15's execution-plan row |
| **C2** | "No production composition root exists" (archived finding **N12**) | `ROBOTX_SYSTEM_HANDBOOK.md` §3.3 · §51.2 · §2 summary | **`Backend/server.js` is the composition root.** What is absent is a constructible *solve path* — a different claim, and the one that is still true | Phase 15 built the composition root |
| **C3** | "19 workers" | `ARCHITECTURE.md` §1.4, §4.2 · `ROBOTX_SYSTEM_HANDBOOK.md` §0.1, §3.3, §51.2 | **⚠ THIS ROW HAS INVERTED — DO NOT ACT ON ITS ORIGINAL TEXT.** On 2026-08-29 the registry held **18** and this row read *"18 registered … `src/workers/` holds 20 `.js` files … '19' is wrong under every reading"*. **Since T1-04 the registry registers exactly 19** (re-measured 2026-08-30), so the figure this register was created to correct is now the *correct* registry count, reached by coincidence rather than by anyone updating it. The file count did **not** converge, and has since diverged further: `src/workers/` now holds **22** `.js` files (19 `*.worker.js` + `registry.js` + `leaderWorkers.js` + `coordinatorPipeline.js`, added 2026-09-01 by the V1 audit) — *21 when this row was written*. So "19" is still wrong **as a file count** and right **as a registry count**, and **the registry count did not move**, because `coordinatorPipeline.js` registers no worker. **A future pass must not "correct" 19 → 18.** The genuine remaining defect in those documents is that they say *none* of the workers is scheduled (row C1), not the number | Phase 15 wrote the registry and `leaderWorkers.js` |
| **C4** | "`gates.blockers({})` returns all **23** rows" / "23 release gates" | `ARCHITECTURE.md` §1.5 · `ROBOTX_SYSTEM_HANDBOOK.md` §60.4, §87 | **24 rows**, all blocking; `blockers({})` returns 24 | The §24 gate table is Phase 15's deliverable |
| **C5** | "16 GREEN, 2 RED, 1 **PARTIAL**, 4 NOT_EVALUATED" | `ROBOTX_SYSTEM_HANDBOOK.md` §60.4 | **16 GREEN, 1 RED, 7 NOT_EVALUATED.** Doubly wrong: the counts moved, **and there is no `PARTIAL` status in the gate algebra** — `gates.js` defines GREEN, RED and NOT_EVALUATED only | It misstates the release verdict, which is the closure surface |
| **C6** | "the seven build gates" | `ARCHITECTURE.md` §2 rank 6 · `ROBOTX_SYSTEM_HANDBOOK.md` §0.2 item 6 · `README.md` verification block | **`npm run gates` runs 8** and **exits 1**. Phase 15 added the eighth, `gate:composition`, and it is the one that fails | Phase 15 added the gate; a "seven gates, all passing" reading hides the RED one |
| **C7** | `gate:legacy` quoted as *"…across 301 file(s)"* | `ARCHITECTURE.md` §1.3 | **346 files**, re-measured 2026-08-30 *(340 on 2026-08-29; the corpus grew with T1-04's and V-10's files)*. **The load-bearing number is *4 absent*, not the corpus size** — which is exactly why this row moves every time the tree does, and why quoting the corpus size at all is the weaker practice | `gate:legacy` is Phase 15's gate |
| **C8** | Authority table lists ADR-33 but **not ADR-34** | `ARCHITECTURE.md` §2 rank 2 · `README.md` doc table (said "38 records") | **40 ADR files** = 38 frozen Appendix C records + ADR-33 + **ADR-34**. `docs/adr/README.md`'s "38 records are the complete set" is correct *for the frozen set* and is not a defect | **ADR-34 is Phase 15's own ADR** (cutover rehearsal purpose, resolving D-7) |
| **C9** | CI described as running the complete build-gate set | `ARCHITECTURE.md` §9.1 · `ROBOTX_SYSTEM_HANDBOOK.md` §42 | CI runs **7 of 8** gate steps (6 on a push — `gate:columngen` is pull-request-only) and omits `gate:composition` **without stating a reason** | See residual observation 7 |

### Recorded and deliberately NOT corrected — cross-phase drift

**Reason, stated once and applying to every row below: these are general project counts, not Phase
15 facts, and re-counting the whole handbook is a handbook re-audit rather than a Phase 15
documentation audit.** Correcting them here would also mean Phase 15 silently asserting numbers for
phases it did not measure. A **currency banner** was added at the head of
`ROBOTX_SYSTEM_HANDBOOK.md` instead, and `ARCHITECTURE.md`'s baseline header was relabelled
**historical**, so every figure below is now reachable as dated rather than current.

| # | Drift | Where | Current, measured 2026-08-29 | Owner |
|---|---|---|---|---|
| **D1** | "145 suites · 6 363 tests" (and "6 287", "6 357") | `ROBOTX_SYSTEM_HANDBOOK.md` lines 53, 55, 1136, 1895, 2915, 3858, 3860, 4081, 4083, 4120, 4132, 4350, 4525, 4553 · `ARCHITECTURE.md` header | **162 suites / 7 275 tests / 0 failures**, exit 0 — re-measured 2026-08-30 *(was 160 / 7 162 on 2026-08-29; T1-04 and V-10 added two suites)*. **This row is itself the argument for the rule below: a suite count is stale the moment anyone adds a test, which is why these are recorded rather than chased** | Whoever next re-compiles the handbook |
| **D2** | "185 engine modules" / "186 `.js` files" | `ROBOTX_SYSTEM_HANDBOOK.md` lines 64, 146, 247, 299, 2911, 3243, 3247, 4110, 4553 · `ARCHITECTURE.md` §1.4 | **Approximate, and each gate scopes its own:** `gate:tiers` governs **285**, `gate:params` scans **189**, `find src/engine -name '*.js'` gives **192**. The handbook's own advice — quote a gate's number with the gate's name attached — is the right rule | Programme-wide |
| **D3** | `gate:tiers` quoted as "277 modules / 386 edges" and `gate:params` as "183 modules" | `ROBOTX_SYSTEM_HANDBOOK.md` §0.1 | **285 / 423** and **189 / 242** | Phase 0's gates |
| **D4** | "39 ADR files … ADR-01 through ADR-33 plus six lettered sub-records" — presented as a *corrected* count | `ROBOTX_SYSTEM_HANDBOOK.md` §0.1 | **40 files**, ADR-01…**34** plus six lettered. The handbook corrected 38→39 and was then overtaken by ADR-34 | Whoever next re-compiles the handbook |
| **D5** | Phase 15 row: "16 GREEN · 2 RED · 1 PARTIAL · 4 NOT_EVALUATED … **BLOCKED**", entry conditions, findings N11–N20 | `ROBOTX_SYSTEM_HANDBOOK.md` §29 phase table, line 1694 | Superseded by this register and by `PHASE_15_CLOSURE_CHECKLIST.md`. Left intact because it is one row of a 16-row cross-phase table whose other rows this audit did not verify | Whoever next re-compiles the handbook |
| **D6** | The label "**Ph15 F1**" applied to the `tla2tools.jar` gap | `ROBOTX_SYSTEM_HANDBOOK.md` §41 | **Naming collision.** In the current ledger **P15-F1** is the observation-bound weakening finding (fixed); the `tla2tools.jar` gap is **B-M**. The handbook's label predates both IDs | Whoever next re-compiles the handbook |

**None of the above blocks anything.** They are registered so the next pass inherits them by name
rather than rediscovering them, and so no one mistakes a dated figure for a current one.

---

## Findings that are CLOSED — do not re-open

Every entry below was raised by an earlier pass and is closed. **Do not re-open one because an
archived report shows it OPEN** — archived reports were frozen at the moment they were written.
Where "verified 2026-08-29" appears, this consolidation re-confirmed it directly; the rest are
closed on the archived pass's own evidence and were not re-attacked here.

| ID | Finding | Resolution |
|---|---|---|
| **D-4 / D-5** | Shadow + Tier 0 decision-path composition, filed as in-repository | **RECLASSIFIED, not fixed.** `outbox` and `reconciler` are wired via `workers/leaderWorkers.js`; `coordinator` and `shadow` are **EXTERNAL — B1**. This reclassification is the correct one and is confirmed by `gate:composition`'s own owner field (verified 2026-08-29) |
| **D-6** | Socket handlers read half the staging switch | **FIXED** — `cutover/agentGate.js` evaluates the full conjunction; all five handlers call it; identity bound at AUTH and refreshed. Live-DB verified, mutation-tested |
| **D-7** | Rehearsal/cutover circularity — the gate set was unsatisfiable | **FIXED under ADR-34** — a `REHEARSAL` purpose requiring a declared non-production environment, setting aside exactly one gate. No gate weakened |
| **D-8** | `SHARD_MIGRATE` undelivered | **FIXED** by the D-5 wiring |
| **D-9** | §4.5 timer expiry semantics — 16 declared `on expiry` actions with no implementation | **RETURNED TO PHASE 5 and closed there** (`PHASE_5_ADVERSARIAL_REMEDIATION_AND_CLOSURE.md`, 2026-08-22): 17 expiry actions implemented, timer worker composed. **Not a Phase 15 blocker** |
| **D-10** | Composition gate used a path proxy | **FIXED** — gate strengthened |
| **D-11** | Duplicate-writer test could not fail | **FIXED** |
| **D-12** | 100/279 modules unreachable | **MEASURED**, informational — reframes D-4/D-5 |
| **D-13** | Fail-open in the D-6 gate | **FIXED** (would have been blocking had it shipped) |
| **P15-R1** | The automatic rollback published nothing | **FIXED** — `cutover/rollbackPublisher.js`, wired at `server.js:207` |
| **P15-R2** | No process ever re-read the pinned configuration | **FIXED** — `cutover/configPropagation.js`; the pull loop runs and is stopped on shutdown |
| **P15-R3** | §18.5's command suspension was unwired | **FIXED** — the shard's open degraded modes are an accessor, not a constant `[]` |
| **P15-R4** | Socket intake read a snapshot that does not exist | **FIXED** |
| **P15-R5** | Intake inherited the global binding when no region was named | **FIXED** (permissive) |
| **P15-R6** | Timer worker composed with no operating region | **FIXED** |
| **X2a / X2b** | `OFFERED → ACCEPTED` and outbox-withdrawal `→ QUEUED` had no deadline | **FIXED** in pass 1, verified in pass 2 |
| **P15-C1** | Evidence-binding context was half-mandatory | **FIXED** (permissive) — with an age bound |
| **P15-C2** | The authority accepted a guardrail declaration its own reader refuses | **FIXED** (permissive) |
| **P15-C3** | A gate flag its adjudicator would silently ignore | **FIXED** (latent) |
| **P15-C4** | No cutover audit event could ever be written | **FIXED** — verified 2026-08-29 by `phase15EvidenceBinding.js` D2/D3 (17/17) |
| **P15-E1** | PRODUCTION observation window that is not a window — `NaN`/`±Infinity`/future windows ADMITTED+PASS on all four B-P gates | **FIXED** (permissive, blocking) — `Number.isFinite` on both endpoints, refusal by name, and a window may not close in the future. Verified 2026-08-29 by `phase15VersionInForce.js` C1–C3 (19/19) |
| **P15-E2** | The automatic rollback's base configuration was the wrong version | **FIXED** — the version **in force**, not the latest published |
| **P15-E3** | The same `NaN` shape in `guardrails.assess()` | **FIXED** (latent, permissive) — verified 2026-08-29 (C1) |
| **P15-E4** | A caller-supplied minimum-observation bound of zero | **FIXED** (permissive) |
| **P15-E5** | The lifecycle model check claimed an exhaustion that was impossible | **FIXED** — the claim was corrected. The underlying gap is now tracked as **B-M** |
| **P15-E6** | Cutover runbook prerequisite 2 could not be discharged by the check it names | **FIXED (documentation).** The producer gap remains — residual observation 3 |
| **P15-F1** | A caller could weaken a release requirement by stating a smaller number (a 72-hour soak discharged by a 1-second window) | **FIXED** — the authority resolves the bound from the register and refuses a caller who states one, in both directions. Reproduced BEFORE the fix, re-attacked with 12 mandated attack cases and 8 distinct mutants across three concurrent sessions |
| **P15-F3** | Every malformed `--max-age-hours` refused except the one a shell produces | **FIXED** (low) |
| **P15-F7** | The only documented invocation of `authoriseEnable()` could not authorise anything | **FIXED (documentation)**, and the fix itself was then corrected for a gate-id collision divergence. Verified present 2026-08-29 at `docs/runbooks/cutover.md:220–229` |
| **A1** | `assertSelfHosted` accepted all six public hosted routing services written as a trailing-dot FQDN | **FIXED** — the most serious finding of the B1 prerequisite pass; §32.4 marks this requirement non-negotiable |
| **A2–A8** | Seven further B1-prerequisite validator defects (V-11 dropping the region under assessment; V-12 skipped silently; V-13 uncalled; a future vintage clearing every cadence; two authorities disagreeing about dates; `stepEvidenceAdmissible` true while Step 1 `NOT_CONFIGURED`; whitespace satisfying every "name the source" check) | **FIXED** — every fix moves a verdict in the strict direction only (`PASS`→`FAIL`, `ACCEPTED`→`refused`, `admissible`→`inadmissible`) |
| **R-1 / R-2 / R-3** | Residual validator defects found during the B1 pass's own final verification | **FIXED** — 5 mutants, 5 killed |

**Carried forward, unchanged, from the B1 prerequisite pass** (specification/governance, not
Phase-15-owned): **F2** (`route.matrix_timeout` / `route.path_timeout` unregistered — §22.1
governance), **F3** (the GraphHopper snap-radius asymmetry — must appear in the B1 ADR as a real
difference between candidates), **N29** (`travelTimeSpread`'s source — open for every candidate; the
engine choice does not close it).
