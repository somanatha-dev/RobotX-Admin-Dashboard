# Phase 15 — Historical Archive

> ## ⚠ EVERY DOCUMENT IN THIS DIRECTORY IS HISTORICAL EVIDENCE ONLY.
>
> **CURRENT SOURCE OF TRUTH: [`../PHASE_15_MASTER.md`](../PHASE_15_MASTER.md)**
>
> **No document in this directory may be used to determine current implementation state.**
> Each was measured against a tree that no longer exists, and several were corrected by later
> passes. Reading one to decide what to implement is the specific failure the consolidation
> exists to prevent.

**Archived:** 2026-08-29 · **Files:** 15 · **Deleted:** 0 · **Duplicates:** 0
**Integrity re-verified:** 2026-08-29 — 15/15 blob-identical to `HEAD`; 15 distinct SHA-256 content
hashes, so no two archived reports are copies of one another.

---

## Why these files carry no archive banner

**They are preserved byte-for-byte.** Not one character was added, removed or altered — verified by
SHA-256 before and after the move. These are audit records, and several contain a later pass's
explicit correction *of* an earlier pass. That correction history is itself the evidence; stamping
a banner into the files would modify audit records to make a filing system tidier.

**Re-verified independently on 2026-08-29** by the documentation-integrity audit, by a method that
does not depend on trusting the sentence above: for all 15 files, the **git blob hash of the
archived path equals the git blob hash of the original root path at `HEAD` (`b68dc5d`)** — 15 of
15 identical, 0 differing. `git status` records all 15 as renames.

> ### ⚠ If you compare the working-tree files to `git show HEAD:<name>` you will see 4 "differences". They are not differences.
>
> `PHASE_15_IMPLEMENTATION_REPORT.md`, `PHASE_15_ADVERSARIAL_REMEDIATION_AND_CLOSURE.md`,
> `PHASE_15_REMEDIATION_AND_CLOSURE.md` and `PHASE_15_REMEDIATION_AND_CLOSURE_2026-08-22.md` were
> authored with **CRLF** line endings. This repository sets **`core.autocrlf = input`**, which
> normalises CRLF→LF *on commit* and does **not** convert *on checkout* — so the stored blob is LF
> while the working-tree file is CRLF, and a naïve `sha256sum` of `git show HEAD:<file>` against the
> file on disk reports every line as changed. Strip `\r` from both and the diff is **empty**; the
> byte-count delta is exactly one byte per line. **The blob comparison above is the correct test,
> and it passes.** This was checked, and is written down here so the next auditor does not spend
> the time re-deriving it or, worse, conclude the archive was tampered with.

Their status is declared **here instead**. Read this table before opening any file below.

---

## The trees these documents were measured against

A report's numbers are only meaningful against the tree it measured. **The current tree is
`431010ace188c4b1…` (565 files).** Anything measured against a different digest does not transfer.

| Digest | Files | Which reports | Relationship to now |
|---|---|---|---|
| `cf9103f` (commit, pre-digest era) | — | The 2026-08-08/09 reports | Ancient. Phases 6–15 were one uncommitted working tree |
| `e5c9655` (commit) | — | 2026-08-21/22 reports | Pre-Phase-5-closure |
| `22ca9143…` | 560 | Pass 1 arrival | Superseded |
| `134ebc0d…` | 562 | Pass 2 closure / pass 3 arrival | Superseded |
| `801ed1df…` | — | Pass 3 mid-flight | Superseded |
| `72f943df…` | 565 | B1 decision preparation | Superseded |
| `d9fdb79a…` | 565 | B1 prerequisite pass closure | Superseded |
| **`431010ace1…`** | **565** | **Parts IV, V, VI of the third-pass report** | **This is the current tree** |

---

## Index

| Historical document | Date / state measured | Purpose | Why superseded |
|---|---|---|---|
| [`PHASE_15_IMPLEMENTATION_REPORT.md`](PHASE_15_IMPLEMENTATION_REPORT.md) | 2026-08-10, baseline `cf9103f` | The original Phase 15 implementation report — §24 suite, §22.4 staging, the cutover, legacy deletion, 164 new tests | Every count is stale (the tree has grown from 164 new tests to 7 162 total). Six adversarial passes have since found and fixed defects it did not report |
| [`PHASE_15_INDEPENDENT_VERIFICATION.md`](PHASE_15_INDEPENDENT_VERIFICATION.md) | 2026-08-08, baseline `cf9103f` | Independent verification of the implementation report | Same tree, same staleness. Its method (independent re-execution, full reads of the highest-risk modules) is worth reading as method; its numbers are not current |
| [`PHASE_15_BLOCKER_RESOLUTION_PLAN.md`](PHASE_15_BLOCKER_RESOLUTION_PLAN.md) | 2026-08-08, baseline `cf9103f` | Blocker-resolution planning + Phase 16 readiness analysis. Analysis-only; modified nothing | Its blocker list predates the B1 reclassification and five subsequent passes. **Still cited by `IMPLEMENTATION_EXECUTION_PLAN.md` §3 for one specific argument** — that "Phase 15.1" is terminology the architecture does not use. That citation remains valid; its state assessment does not |
| [`PHASE_15_CONSOLIDATED_REMEDIATION_REPORT.md`](PHASE_15_CONSOLIDATED_REMEDIATION_REPORT.md) | 2026-08-08 → 2026-08-10, rev 8.1, baseline `cf9103f` · **6 233 lines** | The append-only "living Phase 15 status register" of its era. Findings N1–N23+, §36 B1 analysis, §17 OP-8 | **The single most dangerous file in this archive.** It described itself as "the living register, authoritative for current programme state", and `ARCHITECTURE.md`, `README.md` and `docs/history/README.md` all pointed at it as *current programme status*. It is 19 days and six passes stale. Those three pointers were redirected to `PHASE_15_MASTER.md` by this consolidation. **Its §36.3.1 five-field D1 specification is still the live definition of what D1 requires** — that content is carried forward in `../PHASE_15_BLOCKERS.md` |
| [`PHASE_15_B1_ROUTING_DECISION_REPORT.md`](PHASE_15_B1_ROUTING_DECISION_REPORT.md) | 2026-08-08, baseline `cf9103f` | The first B1 analysis — established that B1 is blocked one step earlier than "deploy an engine": the region, map and mobility profiles do not exist | Conclusion still correct; superseded as *state* by `b1Readiness.js`, which now reports this mechanically and is re-runnable. Prefer running the tool |
| [`PHASE_15_ROUTING_CONFIGURATION_DECISION.md`](PHASE_15_ROUTING_CONFIGURATION_DECISION.md) | 2026-08-09, baseline `cf9103f` | Removing the repository-side prerequisites blocking B1 from being *specified* | Superseded by `B1_ROUTING_ENGINE_DECISION_PREPARATION.md` and then by the B1 prerequisite pass, which found 9 defects in the validators this report's work created |
| [`PHASE_15_ROUTING_PREREQUISITE_REMEDIATION_REPORT.md`](PHASE_15_ROUTING_PREREQUISITE_REMEDIATION_REPORT.md) | 2026-08-09, baseline `cf9103f` | The companion remediation. **Records the finding that `prisma/seed.js`'s `SEED_SPATIAL_MAP` / `RGN-BLR` is a Phase 2 containment demonstration, not a target region** | Superseded as state. That one finding is load-bearing and is carried forward into `../PHASE_15_MASTER.md` §10 and `../PHASE_15_BLOCKERS.md` — it is the reason nobody may treat the seed as production configuration |
| [`PHASE_15_FINAL_IMPLEMENTATION_AND_CLOSURE_REPORT.md`](PHASE_15_FINAL_IMPLEMENTATION_AND_CLOSURE_REPORT.md) | 2026-08-21, commit `e5c9655` | Called itself "Final". Verdict: PHASE 15 BLOCKED, PHASE 16 NOT READY | **Superseded on four points by its own successor**, which is stamped into its header as a `⚠ PARTIALLY SUPERSEDED` notice: D-6 and D-7 are now FIXED, and D-4/D-5 were **misclassified as in-repository** when they are external (B1). Filename says "Final"; it was the first of six |
| [`PHASE_15_REMEDIATION_AND_CLOSURE_2026-08-22.md`](PHASE_15_REMEDIATION_AND_CLOSURE_2026-08-22.md) | 2026-08-22, 155 suites / 6 850 tests | Targeted remediation of D-4…D-7; the **D-4/D-5 reclassification from in-repository to EXTERNAL** — the most consequential classification change in the programme. Full D-series table (D-4…D-13) | Preserved verbatim from a file that was later rewritten. Findings stand; verdict superseded. Its 155/6 850 counts and "2 composition violations" are stale (now 160/7 162, 1 violation) |
| [`PHASE_15_ADVERSARIAL_AUDIT_PASS_1_2026-08-22.md`](PHASE_15_ADVERSARIAL_AUDIT_PASS_1_2026-08-22.md) | 2026-08-22, digest `22ca9143…` (560 files) | Pass 1: found and fixed **P15-R1…R6**, X2a, X2b. Discovered that the automatic rollback published nothing and that no process ever re-read the pinned configuration | Findings stand and are fixed; verdict superseded by pass 2. Byte-identical copy of what `PHASE_15_ADVERSARIAL_REMEDIATION_AND_CLOSURE.md` held before that file was rewritten |
| [`PHASE_15_ADVERSARIAL_REMEDIATION_AND_CLOSURE.md`](PHASE_15_ADVERSARIAL_REMEDIATION_AND_CLOSURE.md) | 2026-08-23, digest `134ebc0d…` (562 files) | Pass 2: **P15-C1…C4**, including the cutover control plane that could never write its own audit event. Verified X2a/X2b; recorded **X3 as "NOT FIXED, and must not be"** | Findings stand and are fixed; verdict superseded by pass 3. **Claimed "in-repository: none remaining"; pass 3 then found six.** Its X3 reasoning is still current and is carried forward |
| [`PHASE_15_REMEDIATION_AND_CLOSURE_2026-08-24_PASS3_ASWRITTEN.md`](PHASE_15_REMEDIATION_AND_CLOSURE_2026-08-24_PASS3_ASWRITTEN.md) | 2026-08-24, §19 unfilled | **Pass 3 exactly as it left the tree, before verification.** Kept as the record of what pass 3 *claimed* | **Contains claims its own verification pass then refuted** — it says "158 → 160 suites" (measured: 159) and "40 tests" for a suite that has 52, because **pass 3 closed on a §19 it never ran**. Keep it only to see what an unverified closure looks like. Never cite a number from it |
| [`PHASE_15_REMEDIATION_AND_CLOSURE.md`](PHASE_15_REMEDIATION_AND_CLOSURE.md) | 2026-08-24 → 2026-08-29 · **2 855 lines, six parts** | The most recent and most complete report. Part I pass 3 (**P15-E1…E6**); Part II independent verification (**P15-F1**, **P15-F3**); Part III P15-F1 closure; Part IV final closure + evidence reconciliation; Part V the BEFORE reproduction + two corrections; Part VI a third concurrent session (**P15-F7a**, the evidence/attestation collision fix) | **Its Parts IV–VI were measured against digest `431010ace1…`, which IS the current tree** — so its late numbers were correct when written and were independently re-measured by this consolidation. It is archived because it is a 2 855-line append-only narrative in which Part I contradicts Part II, not because it is wrong. Everything current in it is carried into the five canonical documents. **Its Parts I–III are measured against superseded trees** |
| [`B1_ROUTING_ENGINE_DECISION_PREPARATION.md`](B1_ROUTING_ENGINE_DECISION_PREPARATION.md) | 2026-08-25, digest `72f943df…` (565 files) | Prepares B1 for a real decision: every input enumerated with owner, shape and the shipped validator that judges it. **Selects nothing** | Superseded as state by the B1 prerequisite pass three days later, which found **9 defects in exactly those validators**. The decision framing remains sound; the validator behaviour it describes was subsequently corrected |
| [`PHASE_15_B1_PREREQUISITE_ADVERSARIAL_PASS.md`](PHASE_15_B1_PREREQUISITE_ADVERSARIAL_PASS.md) | 2026-08-28, digest `d9fdb79a…` (565 files) | Found the defects waiting *underneath* B1 for when its external decisions arrive: **A1–A9** plus residuals **R-1…R-3**. A1 — `assertSelfHosted` accepted all six public hosted routing services written as a trailing-dot FQDN — is the most serious, on the one requirement §32.4 marks non-negotiable | Findings stand and 8 of 9 are fixed (**A9** remains, correctly deferred to Phase 8). Superseded as state by the P15-F1 work that followed. Note its own "8/7" miscount |

---

## Upstream documents and source that still cite these files **by name**

The move repaired every broken *markdown link*. It deliberately did **not** rewrite citations that
appear as plain names inside historical documents or as provenance comments in code — those are
historical references, and rewriting them would edit records of what an author actually consulted.
They resolve here.

| Citing file | Cites | Kind |
|---|---|---|
| `IMPLEMENTATION_EXECUTION_PLAN.md` §3, §6.3, and lines 730/731/836/1567 | `PHASE_15_BLOCKER_RESOLUTION_PLAN.md`, `PHASE_15_CONSOLIDATED_REMEDIATION_REPORT.md` §17 | Historical citation of a specific argument (that "Phase 15.1" is not architecture terminology; the OP-8 observation-window gap). **Both arguments remain valid.** The plan is authority #2 and was not edited |
| `docs/adr/ADR-33-b1-traversal-domain-scope.md` | `PHASE_15_CONSOLIDATED_REMEDIATION_REPORT.md` §32, `PHASE_15_ROUTING_CONFIGURATION_DECISION.md` §5.1/§8 | Provenance of the ADR's own text. ADRs are read from disk by tests and were not edited |
| `PHASE_1_*`, `PHASE_7_*`, `PHASE_10_*` reports | various | Historical cross-references between historical reports |
| `Backend/src/engine/spatial/regionBoundary.js:8, :324` · `config/validators.js:590` · `routing/inProcessCache.js:16` | `PHASE_15_CONSOLIDATED_REMEDIATION_REPORT.md` §30.5.2 / §30.5.5 / **§36.3.1** · `PHASE_15_B1_ROUTING_DECISION_REPORT.md` §7.1 | **Comments, plus one runtime message.** `regionBoundary.js:324` prints "the five fields of `PHASE_15_CONSOLIDATED_REMEDIATION_REPORT.md` §36.3.1" — you will see it in `npm run routing:readiness` output. **Source was not modified** (this was a documentation-only operation). Those five D1 fields are restated in [`../PHASE_15_BLOCKERS.md`](../PHASE_15_BLOCKERS.md) under **B1** |
| `Backend/tools/routing/b1Readiness.js:415`, `b1Benchmark.js:321`, `inProcessCacheBenchmark.js:7` · 9 test files | `B1_ROUTING_ENGINE_DECISION_PREPARATION.md`, `PHASE_15_B1_ROUTING_DECISION_REPORT.md`, `PHASE_15_BLOCKER_RESOLUTION_PLAN.md`, `PHASE_15_IMPLEMENTATION_REPORT.md`, `PHASE_15_INDEPENDENT_VERIFICATION.md` | Provenance comments only. **No test or tool reads any of these files from disk**, so the move broke no build dependency — verified 2026-08-29 |

---

## Reading order, if you must

You almost certainly must not. But if a question genuinely requires history:

1. **What is true now?** → `../PHASE_15_MASTER.md`. Stop.
2. **Why is B1 external rather than a wiring task?** → `PHASE_15_REMEDIATION_AND_CLOSURE_2026-08-22.md` §1, then run `npm run routing:readiness`.
3. **What exactly does D1/D3/D8 need?** → `../PHASE_15_BLOCKERS.md` first (it is current); `PHASE_15_CONSOLIDATED_REMEDIATION_REPORT.md` §36.3.1 for the original five-field specification.
4. **What defect classes have been found, and how?** → the six parts of `PHASE_15_REMEDIATION_AND_CLOSURE.md`, in order.
5. **What is waiting underneath B1?** → `PHASE_15_B1_PREREQUISITE_ADVERSARIAL_PASS.md`.

---

## What this archive teaches, in one line

Four of these fifteen files declare themselves **final**, **consolidated**, **current** or
**authoritative**. All four were superseded, three of them within days. **A document's own claim to
be current is worth nothing; the source digest it was measured against is worth everything.**
