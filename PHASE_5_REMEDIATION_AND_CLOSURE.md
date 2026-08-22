# Phase 5 — Remediation, Re-verification and Closure

> ### ⚠ PARTIALLY SUPERSEDED — read `PHASE_5_ADVERSARIAL_REMEDIATION_AND_CLOSURE.md` (2026-08-22) with this
>
> That document is the successor. This report is left unedited apart from this notice,
> because a report quietly rewritten to look right is the failure mode the exercise is about.
>
> **It corrects this document on one point, and that point is §13 item 1:**
>
> | This report says | Now |
> |---|---|
> | *"`EVENT.LEASE_EXPIRY` still has no production caller — **DEFERRED TO PHASE 15, by design**. `transitions.apply` is not yet reached by a fired timer: the handler map that connects the two is Phase 15's bootstrap"* | **The deferral was wrong.** It conflated *constructing* a handler map (Phase 15's composition work) with *the handlers existing at all* (§4.2's and §4.3's "On expiry" columns — Phase 5-owned tables in Phase 5-owned modules). Phase 15's audit found the second and returned it as **D-9**. Seventeen expiry actions were declared and **none had an implementation anywhere under `src/`**. |
>
> The successor implements all seventeen, finds **eight further Phase 5-owned defects** in the
> timer store and the timer worker — five of them only visible against a live database — and
> discharges the composition-root gate's `timer` violation at its root.
>
> **Everything else in this document stands.** Findings 1–5 remain fixed, the 105 live checks
> remain valid (the harness now reports 106, with four assertions corrected where they
> described the defective behaviour), and the verdict **PHASE 5 CLOSED** is re-affirmed on
> stronger evidence — 208 live checks, 11/11 mutations caught.


**Date:** 2026-08-17 · **Branch:** `feature/dashboard` · **Working tree at closure:** `63f5c58` + uncommitted
**Role:** Principal distributed-systems / reliability / safety / independent verification engineer
**Authority order:** `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` (FROZEN) → `IMPLEMENTATION_EXECUTION_PLAN.md` → the repository → `PHASE_5_INDEPENDENT_VERIFICATION.md` → `PHASE_5_IMPLEMENTATION_REPORT.md`

This document does not replace the two Phase 5 documents. It sits on top of them and records what
was reproduced, what was fixed, what was verified and found sound, and what remains open by design.
**Neither original document has been edited to remove a finding.**

---

## 1. Final status

# PHASE 5 CLOSED

Both of the original review's code findings are fixed and independently re-verified. One further
defect and one coverage gap found during this exercise are fixed. Phase 5's migration has now been
executed against a real PostgreSQL instance and its behaviour — not merely its DDL — exercised,
discharging the gap five consecutive phases carried forward.

### How this differs from Phase 4's remediation

Phase 4's exercise discovered that its findings had already been fixed and the documents never
updated. **That is not the case here.** Both of Phase 5's code findings were still present in the
working tree, in the form the review described, and were independently reproduced before being
fixed:

```
$ node -e '<leaseExpiryTarget vs. leases.assessRecovery, all five custody states>'
NONE               holds=false  leaseExpiryTarget=REASSIGNING     assessRecovery=REASSIGN
HELD               holds=true   leaseExpiryTarget=STRANDED_SAFE   assessRecovery=PHYSICAL_RECOVERY
DISPUTED           holds=true   leaseExpiryTarget=REASSIGNING     assessRecovery=PHYSICAL_RECOVERY   ← finding 1
PENDING_TRANSFER   holds=false  leaseExpiryTarget=REASSIGNING     assessRecovery=REASSIGN
RELEASED           holds=false  leaseExpiryTarget=REASSIGNING     assessRecovery=REASSIGN
```

The review's verdict — PASS WITH MINOR ISSUES, with issue 1 to be fixed "before Phase 15 wires a
`LEASE_EXPIRY` timer handler" — was accurate and remained accurate. Phase 15 has since landed
(`cbe540e`, `62d8141`), which makes discharging it now the right time rather than a formality.

### What this exercise contributed

1. Independent reproduction of all three original findings against the current code.
2. The fix for finding 1, at its **root cause** rather than at the symptom the review named — and
   with it, two further drifts in the same function that the review did not reach.
3. The fix for finding 3, which turned out to be reachable and useful once corrected, not merely
   cosmetic.
4. A fourth finding of this exercise's own: four of §12.4's ten divergence classes had **no test
   that constructed their divergence**, and passed the full-sweep assertion vacuously.
5. A fifth: the review's one *unverified* concurrency caveat, now reproduced against real
   PostgreSQL and resolved as safe — with the module's comment corrected to say what actually
   happens.
6. The first live-PostgreSQL verification of Phase 5: `tools/verify/phase5LiveDatabase.js`,
   **105 checks**, driving the shipped modules against a real instance.

---

## 2. Files changed

Work already in the tree from Phases 3 and 4 (`commit.js`, `escalation.js`, `outbox.js`,
`adminBootstrap.service.js`, `outbox.worker.js`, the Phase 3/4 documents, `AppProvider.jsx`,
`README.md`, `formal/README.md`, `tools/verify/phase3LiveDatabase.js`,
`tools/verify/phase4LiveDatabase.js`) was **not touched**.

| File | Why it changed | Scope | Spec requirement | Finding | Regression test |
|---|---|---|---|---|---|
| `Backend/src/engine/lifecycle/transitions.js` | `leaseExpiryTarget` now reports `supervision/leases.assessRecovery`'s decision instead of restating it | Phase 5 (§4.4, §4.7, §12.2) | §12.2 lease-expiry row; §4.7's three lawful custody-`HELD` outcomes; §2.5's conservative reading of `DISPUTED` | 1 | `lifecycleTransitions.test.js` — 5 tests |
| `Backend/src/engine/supervision/timers.js` | `FORBIDDEN_VERSION_SOURCES` now inspects `input.entity` rather than the call arguments; `register`'s idempotency comment corrected to the guarantee actually delivered | Phase 5 (§4.5, T0-08) | §4.5 "keyed on the supervised entity's own version, never on the agent's authority epoch" | 3, 5 | `supervisionTimers.test.js` — 6 tests |
| `Backend/tests/engine/lifecycleTransitions.test.js` | 5 new tests for the lease-expiry row | Phase 5 tests | §4.4, §4.7, §12.2 | 1 | — |
| `Backend/tests/engine/supervisionTimers.test.js` | 6 new tests for the timer-keying guard | Phase 5 tests | §4.5 | 3 | — |
| `Backend/tests/engine/supervisionReconciler.test.js` | 8 new tests constructing the divergences of three previously untested §12.4 classes, plus one recording why the fourth is verified live | Phase 5 tests | §12.4 rows 5, 7, 8, 10 | 4 | — |
| `Backend/tools/verify/phase5LiveDatabase.js` | **New.** 105 checks driving the shipped Phase 5 code against real PostgreSQL | Phase 5 verification | §4.5, §12.2–§12.5, §4.4, §4.9 | inherited live-DB gap; 4; 5 | — |
| `PHASE_5_IMPLEMENTATION_REPORT.md` | Status corrected; the undisclosed Phase-4-scope fix disclosed; two claims that have gone stale marked as such | Programme documentation | — | 2 | — |
| `PHASE_5_INDEPENDENT_VERIFICATION.md` | Resolution status appended per finding; **no finding removed or reworded** | Programme documentation | — | all | — |
| `PHASE_5_REMEDIATION_AND_CLOSURE.md` | **New.** This document | Programme documentation | — | all | — |

**No frozen specification was modified. No gate was weakened. No test was deleted, skipped, or
weakened. No threshold was changed to make a test pass. No later-phase functionality was
implemented.**

Every changed runtime file is a Phase 5 module. `git diff --stat` over the runtime surface:

```
Backend/src/engine/lifecycle/transitions.js   |  49 +++-
Backend/src/engine/supervision/timers.js      |  32 ++-
```

---

## 3. Defects fixed

### Finding 1 — `transitions.leaseExpiryTarget` disagreed with `leases.assessRecovery` · Medium-High → **FIXED**

**Original finding (review Part 9.1).** The §4.4 lease-expiry row's target resolver tested
`source.custodyState !== "HELD"` as a literal string, so `DISPUTED` custody — which
`domain/custody.holdsGoods` answers **true** for, deliberately, because contested evidence resolves
to the conservative case (§2.5, T2) — took `REASSIGNING`, the treatment §4.7 reserves for an agent
carrying nothing. `supervision/leases.assessRecovery`, the phase's own cited evidence for invariant
I8, returned `PHYSICAL_RECOVERY` for the identical input.

**Reproduction.** Confirmed present and reproduced exactly as described (table in §1 above).

**Root cause.** Not the string comparison. The string comparison was a *symptom* of §4.7's recovery
decision having **two implementations**. `failure/catalogue.js` and `failure/agentFailures.js` both
already name `assessRecovery` as the single implementation and warn in their own comments against
restating it; the §4.4 table did restate it, and the restatement drifted.

**Two further drifts the review did not reach**, found by comparing the two implementations across
their whole input space rather than at the one input the review tested:

| Input | Old `leaseExpiryTarget` | `assessRecovery` | §4.7 |
|---|---|---|---|
| `DISPUTED` custody | `REASSIGNING` | `PHYSICAL_RECOVERY` | Physical recovery (the review's finding) |
| `HELD`, reachable, in window, **not feasible** | `REASSIGNING` | `PHYSICAL_RECOVERY` | Resume requires "and remains feasible" — the inline copy omitted the condition entirely |
| `HELD`, reachable, in window, feasible (Resume) | `REASSIGNING` | the Leg's own state | *"Lease renewed, replan route, continue"* — the code took the Leg away from an incumbent that had just recovered, contradicting its own comment |

**Fix.** `leaseExpiryTarget` now calls `leases.assessRecovery` and reports the Leg state that
assessment names. §4.7's Resume outcome returns the Leg's current state — a self-transition through
`apply`, which re-arms supervision at the new version, which is what a renewed lease needs. An
unreadable custody state now throws rather than silently reassigning, because §2.5 states that "an
unrecognised custody state is never treated as `NONE`".

**Regression tests** (`lifecycleTransitions.test.js`, +5). The load-bearing one is a property rather
than a case: for **every** custody state × obstruction class, the §4.4 table's target equals
`assessRecovery`'s. A future edit reintroducing an inline comparison fails it before it can reach a
live timer handler.

**Evidence.** All 5 fail against the old semantics and pass against the fix — proved by temporarily
restoring the old function body behind the same test file and re-running:

```
● lease expiry … › DISPUTED custody takes the physical-recovery path, not the custody-NONE one
● lease expiry … › the table's target agrees with leases.assessRecovery for every custody state …
● lease expiry … › §4.7 Resume continues the Leg where it is — it does not reassign it away …
● lease expiry … › an incumbent inside its resume window but no longer feasible is assessed, not resumed
● lease expiry … › an unrecognised custody state is refused, never read as NONE
```

Also exercised end-to-end against live PostgreSQL (harness group 4): `assessRecovery →
STRANDED_SAFE; transitions.leaseExpiryTarget → STRANDED_SAFE`.

**Status: FIXED.**

---

### Finding 2 — an undisclosed Phase-4-scope fix · Low-Moderate → **DOCUMENTATION CORRECTED**

**Original finding (review Part 9.2).** `registerOfferHandlers` was wired into `socket.server.js`
during Phase 5 — a correct fix to a Phase 4 gap — but was not disclosed in the implementation
report's §0 alongside the two corrections that were.

**Reproduction.** The wiring is present and is the only caller:

```
$ grep -rn "registerOfferHandlers" src/
src/sockets/handlers/offer.handler.js:67    (definition)
src/sockets/handlers/offer.handler.js:201   (export)
src/sockets/socket.server.js:7              (import)
src/sockets/socket.server.js:276            (call, per connection)
```

**Fix.** Disclosed as a third item in `PHASE_5_IMPLEMENTATION_REPORT.md` §0, naming it as closing a
gap in Phase 4's checklist item 6. No code change: the code was already correct.

**Status: DOCUMENTATION CORRECTED.**

---

### Finding 3 — the `FORBIDDEN_VERSION_SOURCES` guard could not fire · Low → **FIXED**

**Original finding (review Part 9.3).** The guard inspected `source` — the call arguments — rather
than `source.entity`, the object whose fields could be mistaken for a version. None of these names
is ever passed as a top-level argument, so the check could not fire through the module's own call
pattern, and both the module header and the guard's own error message overstated what it did.

**Reproduction.** Confirmed: `register()` did not throw when handed an entity carrying
`authorityEpoch` alongside a real `version`.

**Root cause.** A one-token error (`source` for `source.entity`) in a defence-in-depth check.

**Fix.** The guard now inspects `input.entity`. Verified safe before changing it, against the live
schema rather than by assumption — **no supervised entity kind carries an agent-scope counter**, so
no legitimate row can be refused:

```sql
select table_name, column_name from information_schema.columns
where column_name in ('authorityEpoch','fenceCounter','version','fence');

Agent|authorityEpoch     Agent|fenceCounter        ← the agent scope, and Agent has no `version`
Commitment|fence         Commitment|version        ← the entity scope
Leg|version              Task|version
```

All four `timers.register` call sites (`transitions.js`, `cancellation.js`, `reassignment.js`,
`reconciler.js`) pass a spread Leg row. The structural guarantee — `VERSION_SOURCE` reading only
`version`/`fence` — is unchanged and remains the primary protection; the guard now catches the case
that guarantee cannot see, which is an object carrying a plausible `version` *and* an agent-scope
counter, where the key would be right by luck rather than by construction.

**Regression tests** (`supervisionTimers.test.js`, +6): each of the four forbidden names refused,
the refusal's reasoning asserted, and — the counterpart that keeps the fix honest — an ordinary Leg
row still registering. All 6 fail against the old semantics. Also exercised live (harness group 2).

**Status: FIXED.**

---

### Finding 4 (new, this exercise) — four §12.4 divergence classes had no test that constructed their divergence · Medium → **FIXED**

**How it was found.** The plan's completion criterion is that the reconciler "repairs all nine
§12.4 divergences and counts each", and the acceptance criterion is that **every divergence class
is tested**. Counting test references per scan function rather than trusting the suite's own
summary:

```
scanCommitmentsUnknownToAgent: 1     scanCustodyWithoutMission: 1
scanUnknownCommitmentReports:  2     scanWaitingTasks:          0   ←
scanOrphanLegs:                3     scanUndeliveredOutbox:     0   ←
scanCommitmentsOnTerminalLegs: 1     scanAvailabilityIndex:     2
scanExpiredLeases:             0   ← scanEnergyAccounting:      0   ←
```

**Why it was invisible.** The suite's full-sweep test asserts that all ten classes run and report a
per-category count. **A scan that detects nothing reports a count of zero and passes that
assertion.** The four classes ran on every sweep and detected nothing, because no fixture ever built
their divergence. The original review read all ten scan functions in full and passed them on that
reading — which was correct as a code review and is exactly what a constructed-divergence test is
for.

**Fix** (`supervisionReconciler.test.js`, +8 tests): `LEASE_EXPIRED_UNPROCESSED`,
`OUTBOX_UNDELIVERED_PAST_DEADLINE` and `ENERGY_ACCOUNTING_INCONSISTENT` now each have their
divergence constructed, their repair asserted, their category counted, their escalation policy
checked at both sides of its threshold, and their negative case (no divergence → no repair) pinned.

`TASK_WAITING_BEYOND_SLA` turns on a nested relation filter
(`mission: { tasks: { some: { id } } }`) the JavaScript store model does not implement — it throws
rather than matching nothing, which is the right behaviour and the reason the class cannot be
tested there in either direction. **It is verified against live PostgreSQL instead** (harness group
6: the positive case, the "still has a queue entry" negative case that only a real relation can
express, and the inside-SLA boundary). A test named for the class records that split, and the
suite's header comment no longer claims all ten are exercised in-suite.

**Status: FIXED.** All ten classes now have detection, repair, idempotency, a counted repair, and a
test — nine in-suite, the tenth live. Table in §7.

---

### Finding 5 (new, this exercise) — concurrent registration of one timer key · Low → **VERIFIED SAFE; COMMENT CORRECTED**

**Origin.** The review's Part 7 recorded this as reasoned but *not verified*: `timers.register` is a
check-then-act, so under genuine concurrency the loser's `create` "would raise a unique-constraint
violation … rather than return the existing row", which is "a gap between the documented guarantee
and what happens under true concurrent registration". A single-threaded store model cannot lose that
race, so the suite could not settle it.

**Reproduced against live PostgreSQL**, by forcing the interleaving the check-then-act permits —
both transactions read the key as absent, then both create:

```
A: CREATED
THREW: P2002 (Unique constraint failed on the fields: (`timerKey`))
timer rows for one deadline: 1
```

**Resolution — the code is right and the comment was wrong.** One timer exists either way, which is
the property the comment is about, and the guarantee is the database's rather than the function's.
The documented "return the existing row" is **not safely implementable** inside the caller's
transaction: PostgreSQL aborts the entire transaction on a constraint violation, so there is no
"read it again" to perform without a savepoint this module has no business opening. A loser that
rolls back its whole transition and retries is §4.1 rule 2's discipline applied to the timer store,
and leaves no partial state. The comment now states the guarantee actually delivered and records
where it was reproduced.

**Status: VERIFIED / NO DEFECT — documentation corrected.**

---

### Inherited — no migration executed against live PostgreSQL · Elevated (five phases) → **DISCHARGED for Phase 5**

A disposable PostgreSQL **18.3** cluster was built from the installed binaries on port **55432**.
The user's own cluster on 5432 and the shared Neon instance in `.env` were never contacted.

All **21 migrations** applied cleanly in directory order:

```
OK  20260729120000_commitment_core
OK  20260730090000_dispatch_and_agent_protocol
OK  20260803210000_supervision_and_reconciliation      ← Phase 5
…  21/21 applied, zero errors
```

`tools/verify/phase5LiveDatabase.js` then drove the shipped modules against that instance:
**105/105 checks passed.** See §11.

**Status: DISCHARGED for Phase 5.** The programme-wide recommendation stands for Phases 6–15, which
have not had the same treatment.

---

## 4. Timer verification

| Property | Result | Evidence |
|---|---|---|
| Timer count and types | **PASS** | Three supervised kinds (`LEG`, `TASK`, `COMMITMENT`), matching `Timer_entity_type_known`'s live CHECK, which rejects a fourth |
| Keyed on the entity's own version | **PASS** | `VERSION_SOURCE` maps `LEG→version`, `TASK→version`, `COMMITMENT→fence`; no kind maps to an agent-scope counter. Live: a commitment timer keyed at fence 42 while its agent's epoch is 7 and fence counter 41 |
| Never keyed on the agent epoch | **PASS** | Finding 3's guard now fires; all four forbidden names refused live and in-suite |
| Stale timer discarded on fire | **PASS** | Live: entity advanced to v1, timer at v0 → `DISCARDED` / `ENTITY_VERSION_MOVED_ON`, **handler never called** |
| Entity gone under a pending timer | **PASS** | `DISCARDED` / `ENTITY_NO_LONGER_EXISTS`, reported as its own reason |
| Timers attempt, never force | **PASS** | Nothing in `timers.js` writes an entity; the attempt is the handler's, through `transitions.apply`'s conditional write |
| At-least-once firing | **PASS** | `resolve` is conditional on `PENDING`: two resolutions → `1` and `0`, `attempts` stays 1 |
| Duplicate delivery is harmless | **PASS** | Second delivery is a no-op, not a second side effect (live) |
| Handler idempotency | **PASS** | Guaranteed structurally: a re-delivered timer re-reads the entity and discards on the version that the first delivery's transition moved |
| Unregistered handler | **PASS** | Stays `PENDING` and is reported — a deadline nobody owns is never silently discharged (§12.1's own failure mode) |
| Handler that throws | **PASS** | Recorded as `HANDLER_THREW:…`; the pass continues |
| Worker restart | **PASS** | A timer due while no worker ran is discovered and fired by a freshly constructed worker with no memory of it |
| Registration atomicity | **PASS** | A transaction that fails after the timer write leaves **no timer** — deadline and state commit together or not at all |
| Multi-worker correctness | **PASS** | Two concurrent workers over 8 due timers: 0 left pending, 0 resolved twice |
| Timer-lag SLI | **PASS** | `dueAt = T − 45 s` → `lagSeconds 45.2`, `overdue 1`; `assessLag` degrades above the configured bound and not below it; an absent bound is refused, never defaulted |
| Lag threshold from configuration | **PASS** | `supervise.max_timer_lag` is a supplied parameter; `assessLag(lag, undefined)` throws |
| `engine:timerlag` stays advisory | **PASS** | Written only by the worker, outside `supervision/`; write failure is swallowed by design |
| DB-authoritative, no Redis | **PASS** | No module under `src/engine/supervision/` imports the cache; asserted by a test |

---

## 5. Lease and recovery verification

| Property | Result | Evidence |
|---|---|---|
| Renewal requires positive, commitment-scoped evidence | **PASS** | Live: evidence naming the commitment and its fence renews and the expiry advances durably |
| A generic ping renews nothing | **PASS** | Refused — it proves the link, not the mission |
| Evidence for another commitment | **PASS** | Refused; leases are per commitment |
| Stale/superseded fence | **PASS** | Refused |
| Released commitment | **PASS** | `NOT_RENEWABLE` — renewal cannot resurrect a commitment already recovered from |
| Store unavailable | **PASS** | `HALTED_STORE_UNAVAILABLE` with the Custodial Operation directive (Phase 12's addition; §12.2's "renewal stops, it does not fall back") |
| Expiry detection | **PASS** | Live expiry scan finds the expired commitment |
| Custody-aware recovery | **PASS** | `NONE`/`PENDING_TRANSFER`/`RELEASED` → `REASSIGN`; `HELD`/`DISPUTED` → `PHYSICAL_RECOVERY`, stranding at the class the location implies |
| `HELD` reaches `RELEASED` or `DISPUTED`, never silent loss | **PASS** | Settlement refuses `HELD` and refuses `DISPUTED` **as its own distinct case**; `scanCustodyWithoutMission` escalates and repairs nothing |
| `DISPUTED` treated conservatively everywhere | **PASS** | Now including the §4.4 table (finding 1) |
| Three lawful `HELD` outcomes chosen explicitly | **PASS** | Resume / Transfer / Physical recovery, with Transfer gated on `transferCapableReceiverAvailable === true` — positive evidence, not "unknown" |
| Commitment release cannot precede custody release | **PASS** | §6 below |

---

## 6. Lifecycle verification

| Property | Result | Evidence |
|---|---|---|
| Leg states | **PASS** | 19, matching §4.3, including `STRANDED_SAFE` and `STRANDED_OBSTRUCTING` |
| Task states | **PASS** | 11, matching §4.2, including `AT_RISK` |
| Stranding derivation | **PASS** | `CLEAR`/`RESTRICTIVE` → `STRANDED_SAFE`; `BLOCKING_CRITICAL`/absent/unrecognised → `STRANDED_OBSTRUCTING` under DENY semantics |
| Every non-terminal state has a deadline | **PASS** | `statesWithoutDeadline()` → `["LOADED"]`, matching §4.3's own em dash; Task's is empty |
| Every non-terminal state has an exit | **PASS** | `statesWithoutExit()` → `[]` |
| Legal transitions apply | **PASS** | Live: `OFFERED → ACCEPTED`, version 0 → 1, timer registered at v1 in the same transaction |
| Illegal transitions refused | **PASS** | `NO_SUCH_TRANSITION`, never guessed at |
| Guards refuse on absent evidence | **PASS** | `REFUSED`, nothing written — §4.1 rule 3 |
| Conditional writes | **PASS** | Two concurrent applications → `APPLIED` / `LOST_RACE`, final version 1 |
| Timer coupling atomic | **PASS** | Cancel-on-exit and register-on-entry inside the transition's transaction; a crash leaves neither |
| Purpose-conditioned cancellation | **PASS** | The §4.6 rule 2 guard applies to every transition except `CANCEL_REQUEST`, with the load-bearing `RECOVERY`/`TRANSFER` exemption |
| Cancellation with custody held | **PASS** | Spawns a `RECOVERY` Leg; refuses without a `recoveryDestination` rather than inventing one |
| Reassignment invalidates old authority | **PASS** | Fence advance, `AgentFenceAudit`, `RECALL` outbox row and commitment release in **one** transaction; `authorityEpochTouched: false` (I19) |
| Reassignment is bounded | **PASS** | `assessChainBound` derives chain length from released-commitment count; `SUSPENDED` on exhaustion |
| Preemption | **PASS** | Routed through the same fence-advance protocol; a preempted agent cannot act under stale authority |
| Terminal states cannot be reopened | **PASS** | Live: **no** §4.4 event has a row out of any terminal state (28 events checked); settlement refuses a terminal Leg naming I12 |

---

## 7. Reconciler verification — all ten §12.4 classes

§12.4's table has **ten** rows; the plan's Phase 5 row says nine. The specification wins by the
plan's own precedence rule, and the implementation implements ten. Independently recounted from the
frozen specification during this exercise: ten.

| # | Class | Detection | Repair | Idempotency | Counted | Test | Result |
|---|---|---|---|---|---|---|---|
| 1 | `COMMITMENT_UNKNOWN_TO_AGENT` | Agent report vs store; skipped by name without a report | Re-dispatch at an advanced fence, that commitment only | Conditional write | ✅ | in-suite | **PASS** |
| 2 | `AGENT_REPORTS_UNKNOWN_COMMITMENT` | Report vs store | `ABORT_MISSION` per id; `STAND_DOWN_ALL` at an advanced epoch if wholly unrecognisable | Conditional write | ✅ | in-suite | **PASS** |
| 3 | `ORPHAN_LEG` | Orphan scan | Requeue with aging credit + timer; escalate if custody held | Conditional write; second sweep repairs nothing | ✅ | in-suite + **live** | **PASS** |
| 4 | `COMMITMENT_ON_TERMINAL_LEG` | Cross-check | Release, retire fence, return capacity | `releasedAt IS NULL` predicate | ✅ | in-suite | **PASS** |
| 5 | `LEASE_EXPIRED_UNPROCESSED` | Timer-lag scan | Run the §4.7 recovery path | Legs already in a recovery state skipped | ✅ | **new** in-suite + **live** | **PASS** |
| 6 | `CUSTODY_HELD_WITHOUT_MISSION` | Custody audit | **No automatic repair** — operator escalation only (§4.1 rule 4) | Escalation, not repair | ✅ | in-suite | **PASS** |
| 7 | `TASK_WAITING_BEYOND_SLA` | Queue audit | Requeue and investigate; escalates **always** | Re-observed while true, by design | ✅ | **live** (relation filter) | **PASS** |
| 8 | `OUTBOX_UNDELIVERED_PAST_DEADLINE` | Outbox scan | Defer to the §11.4 ladder; escalate at strike 3+ | Observation, not repair | ✅ | **new** in-suite + **live** | **PASS** |
| 9 | `AGENT_ABSENT_FROM_AVAILABILITY_INDEX` | Index audit | Reinsert; not reported against an index that does not exist yet | Conditional | ✅ | in-suite | **PASS** |
| 10 | `ENERGY_ACCOUNTING_INCONSISTENT` | Accounting audit | Recompute and flag calibration; escalate on large divergence | Skipped by name without a model | ✅ | **new** in-suite + **live** | **PASS** |

**Ten scan functions, ten `DIVERGENCE` enum members, ten names in the live
`ReconcilerRepair_category_known` CHECK.** The lock-step is now verified rather than read: every one
of the ten enum members was inserted against the live constraint and accepted, and an eleventh
category was rejected.

| Reconciler property | Result | Evidence |
|---|---|---|
| Periodic full sweep below the required interval | **PASS** | `MAX_SWEEP_INTERVAL_MS = 60_000` and `start()` **throws** on `intervalMs >= 60_000` — the bound is enforced, not documented |
| Event-driven plus periodic | **PASS** | `nudge` calls `sweepOnce` with `batch: 1`; both run the identical scans |
| Repairs are idempotent | **PASS** | Live: second sweep over repaired state leaves version and state unchanged |
| Concurrent reconcilers | **PASS** | Live: two concurrent sweeps repair one divergence once (version 0 → 1) and leave **one** supervising timer, not two |
| Repair-rate SLI | **PASS** | `readRepairRate` reports all ten categories even at zero, so a category that stopped reporting is distinguishable from an idle one — asserted live at `ORPHAN_LEG 27, COMMITMENT_UNKNOWN_TO_AGENT 0` |
| Issues no command directly | **PASS** | Imports no socket and no dispatcher; commands only via injected callbacks that write their outbox row in the authorising transaction |
| Refuses to run without a transaction | **PASS** | Throws |
| Offline sweep absorbed | **PASS** | `socket.server.js`'s `startOfflineDetector` gated on `ENGINE_ENABLED !== "true"`; `taskRecovery.service.js` documented and behaviour-unchanged pending its Phase 15 retirement. One authoritative recovery path when the engine is on |

---

## 8. Completion verification

| Level | Requirement | Result | Evidence (live) |
|---|---|---|---|
| L0 | The claim itself | **PASS** | Accepts the assertion alone, and at no level above it |
| — | No claim at all | **PASS** | `INSUFFICIENT` at L0 with `NO_COMPLETION_CLAIM` — distinct from a failed check |
| L1 | Arrival radius + plausible track | **PASS** | Reached on a well-formed claim; a claim a kilometre away fails `ARRIVAL_RADIUS`; **no position fails L1 rather than being assumed to have arrived** |
| L2 | L1 + a physical event | **PASS** | Reached with one; **grades down to L1** without one rather than passing |
| L3 | L2 + an external attestation | **PASS** | Reached with one; unreachable when the L1 geometric check failed, however good the attestation — the grading is cumulative |

**The three track-plausibility tests — each rejects its own crafted failure and no other.** This is
the phase's stated requirement, and it is now demonstrated by *isolation*: all three failures are
perturbations of one well-formed track, and each fixture trips exactly one test.

| Fixture | `TRACK_COVERAGE` | `TRACK_CORRIDOR` | `TRACK_CONTINUITY` | Security event |
|---|---|---|---|---|
| Well-formed (121 fixes, 12.1/min, on corridor) | — | — | — | — |
| A fix every 15 s (4.1/min against a 6/min floor; 15 s gaps against a 60 s limit; on corridor) | **rejects** | — | — | — |
| Every fix present and evenly spaced, 1.1 km off route | — | **rejects** | — | — |
| One 110 s hole; 100 fixes survive at 10/min; all on corridor | — | — | **rejects** | — |
| One fix displaced 5 km | — | — | `KINEMATICALLY_IMPOSSIBLE` | **yes** |

The last two rows are the distinction that matters operationally: an ordinary gap is a telemetry
problem and an impossible implied speed is a security one, and only the latter raises the flag.

| Evidence property | Result | Evidence |
|---|---|---|
| Durable and attributed | **PASS** | Live row keyed to its Leg, timestamped, cascading with it |
| Carries what it graded on | **PASS** | `121 fixes at 12.1/min, corridor 1.0` persisted alongside the verdict, not just the verdict |
| Security event is its own flag | **PASS** | Durable boolean, not inferred from the failure list |
| Levels and outcomes constrained | **PASS** | Live CHECKs reject `L4` and `MAYBE` |
| A `TASK_COMPLETE` is not a completion | **PASS** | Settlement refuses without archived, sufficient verification |

**Settlement result.** §4.9's ordering holds and is asserted as an ordering, not as an outcome:

```
steps: VERIFICATION_ARCHIVED → CUSTODY_CLOSED → COMMITMENT_RELEASED
```

---

## 9. "Stuck forever" verification

The phase's central property is that no non-terminal entity remains stuck because an expected event
never arrives. It is established here as a chain of separately-evidenced links, not as one
assertion:

| Link | Result | Evidence |
|---|---|---|
| Every non-terminal state has a deadline | **PASS** | `statesWithoutDeadline()` → `["LOADED"]`, matching §4.3 exactly |
| Every non-terminal state has an exit | **PASS** | `statesWithoutExit()` → `[]` |
| Every non-terminal state eventually leaves under fair timer firing | **PASS** | `lifecycleModelCheck.test.js`'s exhaustive reachability search over §4.4 — a finite table with finite guards, so decidable by search; the two wildcard rows (`LEASE_EXPIRY`, `CANCEL_REQUEST`) apply from every non-terminal state, and that is **checked** rather than assumed |
| The deadline is durable, not process-local | **PASS** | Live: a timer due while no worker ran is fired by a freshly constructed worker |
| A missing deadline is detectable | **PASS** | Live: I4's `findUnsupervised` audit reports a non-terminal Leg with no timer at its current version, and stops once registered |
| A late timer cannot corrupt newer state | **PASS** | Live: stale-version timer discarded, handler never called |
| The reconciler catches what timers miss | **PASS** | Live: orphan repaired by the periodic sweep with no event at all; sweep interval bound enforced below 60 s |
| Custody stays safe throughout | **PASS** | Recovery is custody-aware at every entry point (§5) |
| The commitment stays correctly fenced | **PASS** | Reassignment advances only that commitment's fence, in one transaction with its recall |
| Losing supervision reduces what is attempted | **PASS** | Lag beyond `supervise.max_timer_lag` raises `stopNewHardening` — T3 applied |

---

## 10. Chaos and concurrency verification

Every row below was executed against live PostgreSQL unless marked otherwise.

| Failure injected | Expected recovery | Result |
|---|---|---|
| Timer worker crashes mid-handler | Recorded as an outcome; pass continues | **PASS** |
| Timer worker not running when a deadline passes | Fired after restart | **PASS** |
| Timer duplicated / delivered twice | Idempotent; one resolution, one no-op | **PASS** |
| Stale timer fires | Discarded; handler never called | **PASS** |
| Entity deleted under a pending timer | Discarded with its own distinct reason | **PASS** |
| Two timer workers over one due set | No timer lost, none resolved twice | **PASS** |
| Transaction fails after the timer write | No timer survives | **PASS** |
| Transaction fails inside a transition | Neither state change nor timer survives | **PASS** |
| Two concurrent transitions on one Leg | One `APPLIED`, one `LOST_RACE` | **PASS** |
| Two concurrent reconciler sweeps | One repair, one supervising timer | **PASS** |
| Reconciler misses an event | Periodic full sweep finds it (< 60 s, enforced) | **PASS** |
| Two concurrent registrations of one timer key | Exactly one timer; loser's transaction aborts and retries | **PASS** (finding 5) |
| Lease renewal evidence stops | Lease expires; expiry scan finds it | **PASS** |
| Custody held at expiry | Custody-aware recovery, not a bare failure | **PASS** |
| Completion event lost | Leg keeps its deadline and its timer; reconciler sweep observes | **PASS** |
| Settlement retried | `ALREADY_SETTLED` — no second release | **PASS** |
| Two concurrent settlements | One `SETTLED`, one `LOST_RACE` | **PASS** |
| Settlement fails mid-transaction | Neither a `SETTLED` Leg nor a released commitment | **PASS** |
| Stale agent command | Rejected by Phase 3/4 fencing (unchanged, re-verified compatible) | **PASS** |

**Crash points exercised:** after read; after guard evaluation; inside the transaction after the
state write; after the timer write; after the custody check; after the commitment release; before
commit. No impossible intermediate state survived any of them, because in every case the state
write, the timer write and the commitment write share one transaction.

---

## 11. Database verification

**Instance:** disposable PostgreSQL **18.3**, port **55432**, database `robotx_p5`, built from the
installed binaries. Production and the Neon instance in `.env` were never contacted.

| Property | Result | Evidence |
|---|---|---|
| Migration chain applies | **PASS** | 21/21 in directory order, zero errors |
| `Timer` | **PASS** | 17 columns; `entityVersion` is `BIGINT`; `timerState` defaults `PENDING`; `attempts` defaults 0 |
| `ReconcilerRepair` | **PASS** | Present with its category CHECK and three indexes |
| `VerificationEvidence` | **PASS** | Present with typed measurement columns and `securityEvent` defaulting false |
| `Task.version` | **PASS** | `INTEGER NOT NULL DEFAULT 0` — additive, every existing row valid |
| Indexes | **PASS** | `Timer(dueAt)` (the plan's named index), `(timerState, dueAt)`, `(entityType, entityId, timerState)`, unique `timerKey`; three on `ReconcilerRepair`; four on `VerificationEvidence` |
| Foreign keys | **PASS** | `VerificationEvidence.legId → Leg(id)` — enforced (a non-existent Leg is refused) and cascading (deleting a Leg removes its evidence), both exercised |
| CHECK constraints | **PASS** | All 7 present and **each exercised with a row it must reject**: unknown entity type, unknown timer state, negative version, unknown repair category, `L4`, `MAYBE` |
| Enum ↔ CHECK lock-step | **PASS** | All ten `DIVERGENCE` members accepted live; an eleventh rejected |
| `BigInt` marshalling | **PASS** | `2^53 + 1` written and read back **exactly**, as a `bigint` — the review's highest-risk untested item, since the §4.5 discard rule turns on this column |
| Transaction behaviour | **PASS** | Rollback verified at four distinct points (§10) |
| Migration safety | **PASS** | The Phase 5 migration contains **no** `DROP`, `DELETE`, `TRUNCATE`, or `RENAME`; its only pre-existing-table change is one additive `ADD COLUMN … NOT NULL DEFAULT 0` |
| `npx prisma validate` | **PASS** | `The schema at prisma\schema.prisma is valid` |
| `npx prisma migrate diff` (live DB → datamodel) | **PASS for Phase 5** | Three lines of drift, **none of them a Phase 5 object**: one extra FK on `ConfigActiveVersion` (Phase 1 scope). Recorded in §13 |

**Live harness result: 105/105 checks passed**, across ten groups.

---

## 12. Tests and gates

| Command | Suites | Tests | Failures |
|---|---|---|---|
| `npm run verify` (7 gates + all 5 projects) | **145** | **6406** | **0** |
| `npx jest --selectProjects legacy` | 17 | 126 | 0 |
| `npx jest tests/engine/supervisionTimers.test.js tests/engine/lifecycleTransitions.test.js` | 2 | 68 | 0 |
| `npx jest tests/engine/supervisionReconciler.test.js` | 1 | 67 | 0 |
| Phase 5's five suites together | 5 | 188 | 0 |
| `node tools/verify/phase5LiveDatabase.js` | 10 groups | **105 checks** | 0 |
| `npx prisma validate` | — | — | 0 |

**Gates, all PASS:**

```
tier-dependencies (§1.8 rule 2)      277 modules, 387 governed edges, 0 violations
parameter-register (§22, App. A)     183 modules / 242 parameters, 0 bare constants
tenets (T1, T6)                      274 modules, 0 violations
identity-isolation (§23.7)           16 modules, no identifying field in cost/decision scope
reconstruction-equivalence (§24.3)   3 decisions, byte-for-byte from Tier A alone
legacy-retirement (Phase 15)         4 retired modules absent, 305 files checked
column-generation (§21.6)            NOT_REQUIRED for this change set
```

Phase 5's five suites grew from **169** tests to **188** (+19: 5 + 6 + 8). No test was deleted,
skipped, weakened, or serialized to pass. The suite counts reported here differ from the original
Phase 5 documents (57 suites / 1,235 tests; legacy 22/169) because Phases 6–15 have since landed;
these are the current tree's numbers, freshly run.

---

## 13. Remaining limitations

Genuine unresolved items only. None blocks Phase 5.

1. **`EVENT.LEASE_EXPIRY` still has no production caller — DEFERRED TO PHASE 15, by design.**
   `transitions.apply` is not yet reached by a fired timer: the handler map that connects the two is
   Phase 15's bootstrap, and the phase disclosed this as its own Known Limitation 7. Finding 1's fix
   is precisely what had to land before that wiring, which is why it was fixed now rather than
   deferred with it.
2. **`ENGINE_ENABLED` is false and neither Phase 5 worker is started from `server.js`** — by design;
   Phase 15 owns moving engine workers to production scheduling. Everything above was therefore
   exercised by driving the modules and workers directly, which is what the harness does.
3. **`TASK_WAITING_BEYOND_SLA` is covered live but not in-suite** — the store model does not
   implement nested relation filters. Recorded in the suite itself. Closing it means extending the
   store model, which is test-infrastructure work outside Phase 5's scope and carries its own risk
   of modelling a relation differently from PostgreSQL.
4. **One schema drift outside Phase 5** — `prisma migrate diff` reports an extra
   `ConfigActiveVersion_version_fkey` in the migration chain relative to `schema.prisma`. Phase 1
   scope, pre-existing, untouched here. **Flagged for Phase 1's owner**, not fixed, because fixing
   unrelated phases is outside this exercise's mandate.
5. **`reconciler.HOLDING_CUSTODY_STATES` is still a hand-maintained array** (`["HELD",
   "PENDING_TRANSFER", "DISPUTED"]`) rather than derived from `custody.isDischarged`. Currently
   correct; the review rated it low severity and it remains a latent drift risk if §2.5 ever gains a
   sixth state. **Not fixed** — it is a different set from `holdsGoods` (it deliberately includes
   `PENDING_TRANSFER`), so collapsing it onto the predicate would change behaviour, and that is a
   decision for the tech lead rather than a defect to correct silently.
6. **`assessRecovery` defaults an absent `custodyState` to `NONE`.** Every production caller reads a
   Leg row, whose `custodyState` column is `NOT NULL DEFAULT 'NONE'`, so absence cannot occur
   through any current path. Recorded as an observation rather than a finding.
7. **Phases 6–15 have not had live-database verification.** The programme-wide recommendation from
   Phases 3, 4 and 5's reviews stands.

---

## 14. Phase boundary

**No Phase 6 functionality was implemented in this exercise.** No feasibility predicate, no
three-valued feasibility logic, no feasibility cache, no rejection telemetry, no
`RejectionAggregate`, no `NearMissSketch`, no feasibility REST API, and no Phase 6 systemic guard
were written, modified, or extended.

**No Phase 7, 8, 9, 10, or later functionality was introduced.** Every runtime change is inside
`src/engine/lifecycle/transitions.js` and `src/engine/supervision/timers.js`, both Phase 5 modules,
and every test change is inside Phase 5's own three suites.

A note on a stale claim rather than a boundary violation: the Phase 5 implementation report asserts
that `src/engine/feasibility/`, `energy/`, `payload/`, `candidates/`, `solve/`, `plan/` and
`routing/` are empty of runtime code. That was true when written on 2026-08-03 and is **no longer
true** — Phases 6–15 landed afterwards (45, 9, 5, 7, 7, 5 and 3 modules respectively). The report has
been marked accordingly. Those modules are later phases' work, not this exercise's.

**No frozen specification was modified.**

---

## 15. Final recommendation

**Phase 5 is ready for Phase 10 and Phase 12 consumption**, on the evidence above.

The two consumers depend on different halves of it, and both are now evidenced rather than reasoned:

- **Phase 10** (rounds and the assignment loop) consumes the lifecycle machine and the transition
  table. Every legal transition applies under a conditional write; every illegal one is refused;
  guards fail closed on absent evidence; timers are registered and cancelled inside the transition's
  own transaction; concurrent transitions produce one winner and one `LOST_RACE`; and no terminal
  state has an outgoing row. The one place where the table disagreed with the rest of the engine —
  the lease-expiry row — is fixed and pinned by a property test rather than by an example.
- **Phase 12** (degraded modes and the invariant checker) consumes the supervision surface and the
  audit queries. `auditI2`, `auditI3`, `auditI7` and `findUnsupervised` all execute against the live
  schema; the timer-lag SLI and the reconciler repair rate are both measurable, alertable, and
  reported per category even at zero; and the degraded directives the phase names — Unsupervised
  Commitment, Custodial Operation — are returned in the shape that phase consumes.

The one thing Phase 5 does not yet have is a **live wire**: `ENGINE_ENABLED` is false, no worker is
started from `server.js`, and no fired timer reaches `transitions.apply`. That is Phase 15's
bootstrap and was always scheduled there. What this exercise establishes is that when Phase 15
connects those wires, it connects them to mechanisms that have been driven against a real database,
under concurrency, across process restarts, and through rollback at every crash point that matters —
rather than to mechanisms that had only ever been read.

---

## Appendix — commands run for this remediation (reproducible)

```bash
# Reproduction, before any change
node -e '<leaseExpiryTarget vs. leases.assessRecovery across all five custody states>'
node -e '<FORBIDDEN_VERSION_SOURCES guard, entity carrying authorityEpoch>'

# Disposable PostgreSQL 18.3 — never 5432, never Neon
initdb -D <scratch>/pgdata5 -U p5user --pwfile=… -E UTF8 --no-locale
pg_ctl -D <scratch>/pgdata5 -o "-p 55432" start
createdb -h 127.0.0.1 -p 55432 -U p5user robotx_p5
for d in prisma/migrations/*/; do psql -v ON_ERROR_STOP=1 -f "$d/migration.sql"; done   # 21/21 OK

# Live schema inspection
psql -c "<tables, columns, CHECK constraints, indexes, foreign keys for the three Phase 5 tables>"
psql -c "<every table/column named authorityEpoch|fenceCounter|version|fence>"           # finding 3

# Live verification of the shipped code
DATABASE_URL=postgresql://p5user:***@127.0.0.1:55432/robotx_p5 \
  node tools/verify/phase5LiveDatabase.js                                                # 105/105

# The finding-5 race, forced rather than reasoned
node <two transactions that both read the key absent, then both create>                  # P2002, one row

# Regression: the new tests must fail against the old semantics
<temporarily restore both old function bodies>
npx jest tests/engine/supervisionTimers.test.js tests/engine/lifecycleTransitions.test.js  # 10 failed
<restore the fixes>
npx jest tests/engine/supervisionTimers.test.js tests/engine/lifecycleTransitions.test.js  # 68 passed

# Full regression
npm run verify                                                    # 7 gates PASS, 145 suites / 6406 tests
npx jest --runInBand --forceExit --selectProjects legacy          # 17 / 126
npx prisma validate                                               # valid
npx prisma migrate diff --from-schema-datasource --to-schema-datamodel --script
git status --short && git diff --stat
```

The disposable cluster was left running on port 55432 for re-verification and can be discarded with
`pg_ctl -D <scratch>/pgdata5 stop`; it holds no data other than this harness's own rows, which the
harness deletes on exit.
