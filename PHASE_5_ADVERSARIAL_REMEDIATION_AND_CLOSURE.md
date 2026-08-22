# Phase 5 — Adversarial Remediation, Re-verification and Closure

**Date:** 2026-08-22 · **Branch:** `feature/dashboard` · **Baseline commit:** `e5c9655` ("phase 14 closed") + uncommitted Phase 15 work
**Trigger:** the Phase 15 integration audit's finding **D-9** — *"the timer worker's handler map has no producer at all … sixteen actions are declared … and **none has an implementation anywhere under `src/`**"* — classified **Phase 5-owned, in-repository**.
**Authority order:** `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` (FROZEN) → `IMPLEMENTATION_EXECUTION_PLAN.md` → the repository → the Phase 5 and Phase 15 documents.

This document does not replace `PHASE_5_REMEDIATION_AND_CLOSURE.md` (2026-08-17). It sits on top of it and **corrects it on one point**, which is stated in full in §2. No earlier document has been edited to remove a finding.

---

## 1. Final verdict

# PHASE 5 — CLOSED

§4.5's expiry semantics are implemented, wired into the production composition root, and
verified against a real PostgreSQL instance driving the shipped modules. The blocker
Phase 15 returned is discharged at its root rather than suppressed: the composition-root
gate's `timer` violation is gone because the worker composes and starts, not because the
gate was changed.

**Nine defects were found. All nine are Phase 5-owned and all nine are fixed**, each with a
regression test that was mutation-tested — the fix removed, the test proven to fail, the fix
restored. **Four further findings are cross-phase or external**; they are reproduced by name
in the live harness, classified with their owners, and **not fixed here**.

| | Baseline | After |
|---|---|---|
| §4.2/§4.3 expiry actions declared | 17 | 17 |
| …with a production implementation | **0** | **17** |
| `transitions.apply` production callers | **0** | 1 (`supervision/expiryActions.js`) |
| `gate:composition` violations | 2 (`coordinator`, `timer`) | **1** (`coordinator` — external, B1) |
| Test suites / tests | 155 / 6 850 | **156 / 6 909** |
| Live-PostgreSQL checks | 105 | **208** (106 + 102) |
| Mutations caught | — | **11 / 11** |

**Phase 5 does not close the release.** `gate:composition` is still red and the release
verdict is still `BLOCKED`, for the `coordinator` worker's dependency on the **B1 routing
engine**, which is an external decision no commit in this repository can take. That is Phase
15's blocker and it is unchanged by this work.

---

## 2. Baseline state, and the one correction to the earlier closure

### What the tree looked like on arrival

- 155 test suites, 6 850 tests, all green.
- 7 of 8 build gates green; `gate:composition` **RED with two violations**.
- `PHASE_5_REMEDIATION_AND_CLOSURE.md` said **PHASE 5 CLOSED**, on 105 live-database checks.

### The correction

That document's *Remaining limitations* item 1 reads:

> **`EVENT.LEASE_EXPIRY` still has no production caller — DEFERRED TO PHASE 15, by design.**
> `transitions.apply` is not yet reached by a fired timer: **the handler map that connects the
> two is Phase 15's bootstrap**, and the phase disclosed this as its own Known Limitation 7.

**That deferral was wrong, and it is the whole of this exercise.** It conflated two different
things:

- **constructing** a handler map from existing handlers and injecting it at boot — genuinely
  Phase 15's composition work;
- **the handlers existing at all** — the implementation of §4.2's and §4.3's "On expiry"
  columns, which are Phase 5-owned tables in Phase 5-owned modules.

Phase 5 deferred the first and, by doing so, deferred the second without noticing. Phase 15
then found the second and returned it. **Neither phase was being evasive; the sentence simply
described a smaller gap than the one that existed**, and no test could tell, because every
test drove `fireDue` with a hand-built `handlers` object of its own.

This is the same failure the programme has now recorded four times — Phase 12's *"Phase 15
owns the composition root"*, Phase 13's routed blockers, Phase 14's nine written-and-never-
called guards, and now this. The shape is constant: **a deferral whose wording is true of a
narrower thing than the reader will take it to mean.**

### What this exercise re-derived rather than inherited

Nothing in §3–§5 below is taken from either prior document. The matrix in §4 is generated
from `legMachine.LEG_DEADLINES`, `taskMachine.TASK_DEADLINES` and `transitions.TRANSITIONS`
by reading the shipped modules; the ownership claims in §7 are `grep` results against the
current tree, quoted with their file and line.

---

## 3. Phase 5 requirements audited

Every box the execution plan puts under **Phase 5 — Supervision and reconciliation** was
re-checked against the tree. The four that this exercise found unmet are marked.

| Plan item | Status |
|---|---|
| Migration: `Timer`, `ReconcilerRepair`, `VerificationEvidence` | MET (re-applied from empty, §13) |
| `supervision/timers.js`, keyed on the entity's own version | MET — **and 3 defects found in it** (D5-3, D5-4, D5-5) |
| `workers/timer.worker.js` — at-least-once, idempotent handlers, timers attempt not force | **NOT MET at baseline** — D5-1, D5-2, D5-6 |
| `lifecycle/legMachine.js`, all §4.3 states incl. `STRANDED_*` | MET |
| `lifecycle/taskMachine.js` per §4.2 incl. `AT_RISK` | MET |
| `lifecycle/transitions.js` — the complete §4.4 table with guards | **NOT MET at baseline** — D5-7: three §4.3-mandated transitions had no row |
| `supervision/leases.js` — per-commitment renewal | MET |
| lease expiry → custody-aware recovery (§4.7) | MET; now reachable from a fired timer |
| `supervision/progress.js` — all five §12.3 signals | MET; its own header said the acting was *"the reconciler's and the timer handlers'"* — the second half did not exist |
| `supervision/reconciler.js` — all ten §12.4 classes | MET |
| `lifecycle/cancellation.js`, `reassignment.js`, `settlement.js`, `verification.js` | MET |
| REST `GET /api/legs/:legId/supervision` | MET |
| **Tests: every non-terminal state registers and cancels a timer (I4)** | **NOT MET at baseline** — D5-1/D5-3/D5-5 each break it, and X2 breaks it outside Phase 5 |
| Model check: every non-terminal state eventually leaves | MET — and now stronger: `ABORTING`'s exit exists (D5-7) |
| **Gate:** reconciler repair rate alertable; I3, I4, I7, I8, I12, I13 verifiable | MET |

**Not a Phase 5 requirement, and confirmed so:** the §17.4 escalation ladder. The execution
plan §6.3 assigns `fairness/ladder.js`, `operatorCapacity.js` and `agentStarvation.js` to
**REMEDIAL PHASE T1-04** and explicitly re-affirms the *"Phase 5 contrary-claim row"* as
**"Unchanged and still correct"**. See finding X1.

---

## 4. The complete timer-action matrix

Generated from the shipped modules. `§4.4 row` names the transition each handler attempts;
`*` marks a row this remediation added under §4.3's own wording (D5-7, and §18 for why).

| ACTION | ENTITY:STATE | DECLARED | IMPLEMENTED | PRODUCER (who arms it) | CONSUMER | PRODUCTION CALLER | DB EFFECT | STATE EFFECT | EVENT EFFECT | IDEMPOTENT | TESTED |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `ESCALATION_LADDER` | LEG:QUEUED | ✔ | ✔ | `transitions.apply`, `reconciler.scanOrphanLegs`, `expiryActions.withdrawExcludeReplan` | `expiryActions.escalationLadder` | `leaderWorkers.COMPOSERS.timer` | timer re-armed | **none — refuses** (X1) | `timer.rearmed` | version CAS / re-arm | live B, unit, M7 |
| `FORCE_WIDEN_AND_ESCALATE` | LEG:DEFERRED | ✔ | ✔ | `transitions.apply` | `expiryActions.forceWidenAndEscalate` | ” | Leg row + new `QUEUED` timer | `DEFERRED → QUEUED` | `timer.widen_directive` | version CAS | live B, unit |
| `HARDEN_OR_REPLAN` | LEG:PLANNED | ✔ | ✔ | `transitions.apply` | `expiryActions.hardenOrReplan` | ” | Leg row + timer | `PLANNED → OFFERED` \| `→ QUEUED`\* | — | version CAS | live B, unit |
| `WITHDRAW_EXCLUDE_REPLAN` | LEG:OFFERED | ✔ | ✔ | `commit.js` (X2), `transitions.apply` | `expiryActions.withdrawExcludeReplan` | ” | agent fence↑, `WITHDRAW` outbox row, commitment released, `AgentFenceAudit`, timers | `OFFERED → QUEUED` via `WITHDRAWN` | `timer.offer_withdrawn` | version CAS; whole tx | live B, unit |
| `PROBE_THEN_REASSIGN` | LEG:ACCEPTED | ✔ | ✔ | `offers.applyAccept` (X2a), `transitions.apply` | `expiryActions.probeThenReassign` | ” | agent fence↑, `RECALL` outbox row, commitment released, timers | `ACCEPTED → REASSIGNING` | `timer.start_grace_probe` | version CAS; whole tx | live B, unit |
| `PROGRESS_PROBE` | LEG:EN_ROUTE_PICKUP | ✔ | ✔ | `transitions.apply` | `expiryActions.progressProbe` | ” | Leg row + timer at new version | `ETA_BREACH` self-transition | `timer.progress_probe` | version CAS | live B, unit |
| `PROGRESS_PROBE` | LEG:EN_ROUTE_DROP | ✔ | ✔ | `transitions.apply` | ” | ” | ” | `ETA_BREACH`\* self-transition | ” | version CAS | live B, M8/M11 |
| `OPERATOR_ALERT` | LEG:AT_PICKUP | ✔ | ✔ | `transitions.apply` | `expiryActions.operatorAlert` | ” | timer re-armed, `attempts`++ | **none by design** | `timer.operator_alert` | re-arm; no external effect | live B, unit |
| `OPERATOR_ALERT` | LEG:AT_DROP | ✔ | ✔ | ” | ” | ” | ” | ” | ” | ” | live B, unit |
| `VERIFICATION_ESCALATION` | LEG:RELEASED | ✔ | ✔ | `transitions.apply`, `settlement.js` | `expiryActions.verificationEscalation` | ” | Leg row + timer | `EVIDENCE_INSUFFICIENT` self-transition | `timer.verification_escalation` | version CAS | live B, unit |
| `FORCE_STRANDED` | LEG:ABORTING | ✔ | ✔ | `cancellation.js`, `transitions.apply` | `expiryActions.forceStranded` | ” | Leg row + timer | `ABORTING → STRANDED_*`\* by obstruction class | `timer.force_stranded` | version CAS | live B ×4, unit ×4, M8 |
| `PAGE_OPERATIONS` | LEG:STRANDED_SAFE | ✔ | ✔ | `transitions.apply`, `leases.assessRecovery` path | `expiryActions.pageOperations` | ” | timer re-armed | **none by design** | `timer.stranding_response_target_missed` | claim + re-arm | live B, unit |
| `PAGE_OPERATIONS_AND_EXTERNAL_ESCALATION` | LEG:STRANDED_OBSTRUCTING | ✔ | ✔ | ” | ” | ” | 3 × `ExternalEscalation` (§18.6 steps 1–3) | **none by design** | ” + `STRANDING_ESCALATED` | claim makes it exactly-once | live B, live C (2 workers → 1 page) |
| `ESCALATE` | LEG:REASSIGNING | ✔ | ✔ | `reassignment.reassign`, `transitions.apply` | `expiryActions.escalate` | ” | timer re-armed | **none — §4.3 gives no Leg `SUSPENDED`** | `timer.reassignment_escalated` | re-arm | live B, unit |
| `REJECT_OR_ESCALATE` | TASK:RECEIVED | ✔ | ✔ | **none (X3)** | `expiryActions.taskDeadlinePassed` | ” | timer re-armed | none — §4.2 has no transition table | `timer.task_deadline_passed` | re-arm | unit |
| `DECOMPOSITION_STALLED` | TASK:PLANNABLE | ✔ | ✔ | **none (X3)** | ” | ” | ” | ” | ” | ” | unit |
| `ESCALATION_LADDER` | TASK:WAITING / AT_RISK | ✔ | ✔ | **none (X3)** | `expiryActions.escalationLadder` | ” | ” | ” | ” | ” | unit |
| `REPROJECT_TIMELINE` | TASK:IN_EXECUTION | ✔ | ✔ | **none (X3)** | `expiryActions.taskDeadlinePassed` | ” | ” | ” | ” | ” | unit |
| `OPERATOR_REVIEW` | TASK:SUSPENDED | ✔ | ✔ | **none (X3)** | ” | ” | ” | ” | ” | ” | unit |
| `VERIFICATION_ESCALATION` | TASK:VERIFYING | ✔ | ✔ | **none (X3)** | `expiryActions.verificationEscalation` | ” | ” | ” | ” | ” | unit |
| `LEASE_EXPIRY_RECOVERY` | COMMITMENT:* | ✔ | ✔ | **none — `reconciler.scanExpiredLeases` covers it by scan, not by timer** | `expiryActions.leaseExpiryRecovery` | ” | `RECALL`/stranding per §4.7 | by `leases.assessRecovery` | `timer.lease_expiry_recovery` | version CAS | unit; §19 |

**Nothing is marked implemented because a function or enum exists.** Every ✔ in the
IMPLEMENTED column is backed by a live-PostgreSQL check in §13 that arms a real timer,
lets it come due, fires it through the composed production worker, and reads the resulting
row back — except the seven Task rows and the commitment row, whose producers do not exist
(X3), and which are marked accordingly and tested at the handler boundary only. **That
limitation is stated again in §22.**

---

## 5. Findings — Phase 5-owned, all fixed

### D5-1 — the handler contract could not perform a transition · **BLOCKING** · FIXED

**Root cause.** `fireOne` called `handler({ timer, entity, storeTime, config })`. No `tx`,
no `prisma`. But §4.5 says a handler *attempts* a transition, §4.1 rule 2 makes every
transition a conditional write, `transitions.apply` takes a transaction client as its first
argument, and `timers.register` **refuses anything that is not one**.

So the contract described a supervisor that could only observe. **The seventeen missing
handlers could not have been written against it by anyone who tried** — which reframes D-9:
the map had no producer partly because the contract admitted no producer.

**Reproduction (before).**

```
$ node -e '<call fireOne with a handler that inspects its argument>'
handler received: timer, entity, storeTime, config
handler received: tx        → undefined
handler received: prisma    → undefined
```

**Fix.** `fireOne` runs the whole fire inside `deps.runInTransaction` and passes
`{ tx, prisma, timer, entity, storeTime, config, record }`. `runInTransaction` is now a
**required** dependency, refused by name in `requireDeps`.

**Regression.** `supervisionWorkers.test.js` — *"it refuses to run without a transaction seam
— a handler with no transaction can observe and never act"*; and the fire test asserts
`typeof context.tx === "object"`. **Mutation M10: caught.**

---

### D5-2 — a refused attempt left the entity permanently unsupervised · **BLOCKING** · FIXED

**Root cause.** `fireOne` resolved the timer `FIRED` whatever the handler returned. But §4.5
is explicit that a timer *"never forces a state change; it attempts one"*, so a **refusal is
a normal outcome** — and three §4.3 actions (`OPERATOR_ALERT` twice, `PAGE_OPERATIONS`) are
not transitions at all and never move the entity by design.

In every one of those cases the entity is still sitting in the state whose deadline that
was, and the timer is now resolved. **A non-terminal state with no pending timer is
invariant I4's violation** — and it is the exact defect §4.5 exists to prevent, produced by
the mechanism built to prevent it, silently and permanently.

**Reproduction (live).** Planted in `phase5ExpirySemantics.js` group E, check **P3**: fire
`OPERATOR_ALERT` and resolve instead of re-arming. `timers.findUnsupervised()` then reports
the Leg, and goes on reporting it for ever.

**Fix.** `timers.reschedule()` — the row stays `PENDING`, `dueAt` moves forward, `attempts`
counts the passed deadline, `lastOutcome` records what the attempt did, `firedAt` stays
null. The worker decides **structurally**, from the entity's own version after the handler,
not from what the handler claims:

```
version moved  → resolve FIRED (apply already registered the target's timer)
version same   → reschedule    (the deadline was not discharged)
```

**Regression.** Three tests in `supervisionWorkers.test.js`, six in `supervisionTimers.test.js`.
**Mutations M1 and M3: caught.**

---

### D5-3 — the effect and the resolution were in different transactions · **BLOCKING** · FIXED

**Root cause.** The handler ran, then `resolve` was called on the **base client**. A crash
between them leaves a deadline acted on and unresolved (it fires again, the action repeats)
or — with any write ordering — one resolved with its action lost. §4.1 rule 5 states this
for a fence and the command it authorises; a deadline and the action it authorises are the
same shape.

**Reproduction (live).** Group C: a handler that mutates the Leg and then throws. Before:
the mutation persisted. After: `state=DEFERRED version=0`, and the timer is still `PENDING`
with `HANDLER_THREW:process died after the mutation`.

**Fix.** One transaction: claim → act → resolve-or-re-arm. A throw rolls the claim back with
everything else, and the deadline is re-armed **outside** the failed transaction so a
deterministic handler defect retries on the state's own cadence instead of hot-looping.

**Regression.** `supervisionWorkers.test.js` — *"a handler's effect and the timer's
resolution commit together"*. Live group C. **Mutation M1: caught.**

---

### D5-4 — two workers both ran the handler · **BLOCKING** · FIXED

**Root cause.** `resolve` was conditional on `PENDING`, so only one worker *recorded* the
fire — after both had already acted. §4.5's at-least-once firing makes that sound for a
handler whose effect is a conditional write, and **unsound for one whose effect is a page**:
there is no version to make the second responder call a no-op.

**Reproduction (live).** Group C fires one `STRANDED_OBSTRUCTING` timer from two workers
concurrently and counts `ExternalEscalation` rows. Before the fix that is two chains — two
responder pages and two infrastructure notifications for one incident.

**Fix.** `timers.claim()` is the transaction's first statement, and asserts **both** facts
the fire rests on: still `PENDING`, and still due **at this pass's store time**. The second
half is load-bearing — a re-armed timer stays `PENDING`, so `timerState` alone would let the
very next pass fire it again.

**Evidence (live).**

```
two workers firing one timer concurrently produce ONE page, not two
    ExternalEscalation rows: 3 (3 = one chain of steps 1–3); dispositions REARMED / NOT_CLAIMED
  the loser did no work at all         REARMED / NOT_CLAIMED
  the deadline was re-armed exactly once   attempts=1
```

**Regression.** `supervisionTimers.test.js` × 4. **Mutation M4: caught.**

---

### D5-5 — `register` handed back a **resolved** row, so a state could not be re-supervised · **BLOCKING** · FIXED

**Root cause.** `register` was idempotent on the key and returned the existing row for
**any** `timerState`. A caller asking for a live state to be supervised was handed a
`FIRED`, `CANCELLED` or `DISCARDED` row and got **no pending timer at all**.

Reachable, and not only in theory: `transitions.apply` cancels every pending timer for the
entity on state exit; a reconciler repairing an unsupervised state finds the same key at the
same version; and any handler that acts without moving the entity leaves a resolved row on a
live state.

**Reproduction (live).** Found by the *restore* half of planted check P3: after re-registering
the same key, `findUnsupervised` **went on reporting the Leg**. The repair was a no-op and
nothing said so.

**Fix.** A resolved row at a live key is **re-armed**, not returned: back to `PENDING` with
the new `dueAt`, `attempts` preserved, `lastOutcome = REARMED_FROM_<state>`. One row still
exists, which is the idempotency `register` has always promised.

**Regression.** `supervisionTimers.test.js` — the re-arm, and its converse (a `PENDING` row
is returned unchanged, so a retried transition cannot push a live deadline further out).
Live group C. **Mutation M3: caught.**

---

### D5-6 — a fired deadline was recorded as the cancellation it had itself caused · Medium · FIXED

**Root cause.** `transitions.apply` cancels **every** pending timer for the entity on state
exit — including the one that is at that moment firing. The fire's own resolution, being
conditional on `PENDING`, then matched nothing. A deadline that *was acted on* ended up
`CANCELLED`, `firedAt` null, `lastOutcome` reading `EXITED_PLANNED`.

The deadline was discharged either way. What was lost is the only evidence distinguishing a
timer that supervised something from one that was tidied away — which is exactly what an
incident review reads.

**Reproduction (live).** Group B, first run: `the old timer is resolved FIRED —
timerState=CANCELLED`, for both `DEFERRED` and `PLANNED`.

**Fix.** `timers.resolve(..., owned: true)` drops the `PENDING` condition. Only the firing
transaction may pass it: it holds the row's lock from `claim`, so there is no race for the
condition to decide, and there **is** a real writer to overrule.

**Regression.** Two paired tests in `supervisionTimers.test.js` — one asserting the fire is
recorded, one asserting that **without** `owned` the same sequence loses it, so the
distinction cannot quietly collapse. Plus a worker-level test. **Mutation M2: caught.**

---

### D5-7 — three transitions §4.3 mandates had no row in §4.4 · **BLOCKING** · FIXED

**Root cause.** §4.4 is titled *"Complete transition table"*, and it is complete over the
transitions §4.4 itself enumerates. It is **not** complete over **§4.3's "On expiry"
column**, which is the other half of the same frozen specification:

| §4.3 state | §4.3 "On expiry" | What §4.4 contained |
|---|---|---|
| `ABORTING` | *"force to the applicable `STRANDED_*` state"* | **no outgoing row at all** |
| `PLANNED` | *"harden **or re-plan**"* | the harden half only |
| `EN_ROUTE_DROP` | *"progress probe"* | no ETA-breach row (`EN_ROUTE_PICKUP` has one) |

`ABORTING` is the serious one. Its timer fired, `transitions.find` returned nothing, and
§4.3's *force* could never happen — so a Leg in `ABORTING` past `recover.abort_budget`, very
possibly with goods aboard, had a deadline **no component could discharge**. `EN_ROUTE_DROP`
is the second half of every mission, and it is the state a Leg carrying goods is in longest.

**Fix.** Three rows, each marked `SECTION_4_3_SOURCED`, under a rule stated once in the
module and repeated in §18 of this document: *a row may carry the marker only where §4.3
states the consequence in its own words, and must perform that consequence and nothing
more.* `transitions.sectionFourThreeSourcedRows()` enumerates them and
`statesWhoseExpiryHasNoDedicatedRow()` reports what is left (`REASSIGNING`, correctly).

**Regression.** `supervisionExpiryActions.test.js` — the enumeration is pinned to exactly
these three, the four obstruction classes are exercised through `ABORTING`, and the absent
class is asserted to resolve to `STRANDED_OBSTRUCTING` (I22). **Mutations M8 and M11: caught.**

---

### D5-8 — the armed interval was inferred, and the inference was wrong · Medium · FIXED

**Root cause.** The re-arm derived the interval as `dueAt − createdAt`. That is wrong for
every row registered with a `dueAt` already in the past — a reconciler repair, and every
harness — and it cannot express §4.3's two **projected** deadlines at all, whose value is
`projected ETA × execute.eta_tolerance` and lives in the plan rather than the register.

**Reproduction (live).** `EN_ROUTE_PICKUP` and `EN_ROUTE_DROP` both returned
`DEADLINE_UNRESOLVED:execute.eta_tolerance` and refused to transition — correct fail-closed
behaviour, and a supervisor that could never supervise the moving half of a mission.

**Fix.** `register` records `armedSeconds` on the row's payload; `timers.armedSecondsOf()`
reads it and falls back to the old inference for rows written before this landed. Passed at
every registration site: `transitions.apply`, `reassignment.js`, `cancellation.js`,
`reconciler.js`, `expiryActions.js`.

**Regression.** `lifecycleTransitions.test.js` asserts `apply` records it;
`supervisionTimers.test.js` asserts all three resolution paths. **Mutation M9: caught.**

---

### D5-9 — a handler of this remediation's own was laxer than §4.4's guard · **PERMISSIVE** · FIXED

Found by attacking the fix, which is the part of the protocol that earned its keep.

**Root cause.** `probeThenReassign` restated §4.4's `no custody` guard as
`custody.holdsGoods(leg.custodyState)`. Those are **different predicates**:

```
NONE              holdsGoods=false   §4.4 `no custody`: PASS
HELD              holdsGoods=true    REFUSE
DISPUTED          holdsGoods=true    REFUSE
PENDING_TRANSFER  holdsGoods=false   REFUSE   ← the restatement let this through
RELEASED          holdsGoods=false   REFUSE   ← and this
```

`PENDING_TRANSFER` is custody **mid-handoff** — §4.7's Transfer outcome in flight. The
restatement would have reassigned a Leg whose goods were being physically handed between two
parties, away from both.

This is the identical shape to the defect Phase 5's *previous* remediation fixed between
`transitions.leaseExpiryTarget` and `leases.assessRecovery`: a second copy of a decision,
drifting in the permissive direction.

**Fix.** The guard is **evaluated**, not restated:
`transitions.GUARD_EVALUATORS[transitions.GUARD.NO_CUSTODY]({ leg })`.

**Regression.** `supervisionExpiryActions.test.js` runs all four non-`NONE` custody states
and asserts the trap explicitly (`expect(custody.holdsGoods("PENDING_TRANSFER")).toBe(false)`).
**Mutation M6: caught.**

---

### One further defect, found live, fixed, and worth naming for its cause

`withdrawExcludeReplan` omitted `nackCooloffSeconds` from its call to
`offers.withdrawExpiredOffer`, which computes §11.2's exclusion window from it. **Every
withdrawal threw**, rolled back, and was reported as `HANDLER_THREW` rather than as the
missing argument it was. Invisible in unit tests, because the store model never reached that
line. Fixed by supplying it, by taking the window from the function's own return rather than
recomputing it, and by pre-checking both durations so the outcome names the parameter.
Regression: `supervisionExpiryActions.test.js`.

---

## 6. Severity and ownership

| ID | Finding | Severity | Owner | Status |
|---|---|---|---|---|
| **D5-1** | handler contract cannot transition | Blocking | **Phase 5** | FIXED |
| **D5-2** | refused attempt leaves entity unsupervised (I4) | Blocking | **Phase 5** | FIXED |
| **D5-3** | effect and resolution not atomic | Blocking | **Phase 5** | FIXED |
| **D5-4** | two workers both run the handler | Blocking | **Phase 5** | FIXED |
| **D5-5** | `register` returns a resolved row | Blocking | **Phase 5** | FIXED |
| **D5-6** | a fired deadline recorded as cancelled | Medium | **Phase 5** | FIXED |
| **D5-7** | three §4.3 transitions absent from §4.4 | Blocking | **Phase 5** | FIXED |
| **D5-8** | armed interval inferred, wrongly | Medium | **Phase 5** | FIXED |
| **D5-9** | custody guard restated laxer than §4.4 | Permissive | **Phase 5** (introduced here) | FIXED |
| **X1** | §17.4 escalation ladder unimplemented | Blocking for `ESCALATION_LADDER` only | **REMEDIAL PHASE T1-04** | REPORTED |
| **X2 / X2a / X2b** | live paths write Leg states with no timer obligations (I4) | **Blocking, and live today** | **Phase 4 modules; Phase 15 cutover to route them through §4.4** | REPORTED, not fixed |
| **X3** | no producer of `TASK` timers | Blocking for §4.2's half of §4.5 | **Phase 15 cutover** | REPORTED, not fixed |
| **X4** | `coordinator` worker not composable | Blocking for the release | **B1 — external** | REPORTED (unchanged) |

---

## 7. Cross-phase findings, reproduced rather than asserted

Each is a **live check** in `phase5ExpirySemantics.js` group F, so the handoff stays true as
the tree moves: if an owner closes one, the check fails and says so.

### X1 — §17.4's escalation ladder has no implementation · owner: REMEDIAL PHASE T1-04

```
FINDING X1 — §17.4's escalation ladder (T1-04) has no implementation
    src/engine/fairness/ holds 0 module(s).
```

`ESCALATION_LADDER` is the expiry action for `QUEUED`, `WAITING` and `AT_RISK` — the
anti-starvation guarantee. §4.4 gives it two rows and the guard's evidence is §17.4's.

**The handler refuses by name and re-arms.** It must never take the second row:
`LADDER_EXHAUSTED → FAILED` terminates a customer's Leg, and reading an *unimplemented*
ladder as an *exhausted* one would fail real work because a module is missing — §4.1 rule 3
in its most expensive form. Mutation **M7** plants exactly that shortcut and the regression
test catches it.

**Consequence, stated plainly:** until T1-04 lands, a `QUEUED` Leg past
`sla.assignment_deadline` is re-armed and counted and **not relaxed**. It is supervised and
visible; it is not progressed. That is strictly better than the baseline (nothing happened
and nothing knew) and strictly worse than §17.4.

### X2 — `transitions.apply` still has no production caller outside supervision

`offers.js`'s own header says why: every Leg write there is conditional on the version,
*"which is the property Phase 5's machine will preserve **when it takes ownership of the
transitions**"*. That ownership transfer is the Phase 15 cutover's, and it touches Phase 4
modules and the socket layer. **Not fixed here**, per this exercise's mandate to preserve
Phases 0–4 and not to fix other phases silently.

Two instances are live **today** and both leave an I4 violation:

```
FINDING X2a — `offers.applyAccept` moves OFFERED→ACCEPTED and registers no ACCEPTED deadline
    state=ACCEPTED version=1; pending timers at that version: 0.
    The Leg is ACCEPTED and unsupervised: `execute.start_grace` will never expire, so a
    silent agent is never probed and never reassigned.

FINDING X2b — `outbox.worker`'s §11.4 withdrawal requeues a Leg with no QUEUED deadline
    state=QUEUED version=1; pending timers at that version: 0.
```

X2b is the sharper one: **Phase 5's own `WITHDRAW_EXCLUDE_REPLAN` handler registers that
timer** — group B proves it — and `outbox.worker` calls the same underlying function
directly and does not. The two paths to one outcome now differ, which is a divergence worth
closing early.

`commit.js` (Phase 3) has the same shape at `PLANNED → OFFERED` and is not live, because
nothing calls it.

### X3 — nothing anywhere registers a `TASK` timer

```
FINDING X3 — no path anywhere registers a TASK timer, so §4.2's half of §4.5 is dormant
    TASK-entity timers in the store: 0.
```

No engine path writes a §4.2 Task state at all. `taskMachine.js` declines to map the legacy
vocabulary because *"inventing one would be deciding the cutover semantics four phases
early, and Phase 15 owns that."* Phase 5 supplies the seven Task expiry handlers so the
deadlines are **owned** when the cutover lands. **Today they are unreachable, and that is
stated again in §22.**

### X4 — the `coordinator` worker (unchanged)

`gate:composition` remains RED for it. External (B1 routing engine, blocked on D1/D3/D8).
Untouched by this work.

---

## 8. Production composition verification

**Who starts the timer worker.** `workers/leaderWorkers.js`, on a shard-supervisor tick
reporting `mayRunRound: true` (§19.3's single writer). Stopped on demotion and on shutdown.
Nothing in `server.js` calls `start()` directly, and Phase 0's scaffold guard asserts it
does not — a standby that fired timers would be a second writer.

**Under what conditions.** Leadership held. Idempotent: 26 promotions start one worker.

**Which dependencies it receives** — captured from the production composer, not hand-built:

| | Source |
|---|---|
| `prisma` | process context |
| `runInTransaction` | process context — **refused by name if absent** |
| `readStoreTime` | `timerWorker.storeTimeReader(prisma)` → `clock.readStoreTime` (§10.6) |
| `handlers` | `expiryActions.handlers({})`, checked by `assertComplete` **before** starting |
| `advisoryCache` | `kv` — advisory only (§3.3) |

**Which configuration it reads.** `supervise.max_timer_lag`, `recover.*`, `dispatch.*`,
`execute.eta_tolerance`, `ops.*` — every one a real register entry, resolved through
`deadlineSecondsFrom(values, …)` which takes the parameter **name from the state's own
machine**, so there is no second table of "which parameter supervises which state".

**Leader-only / scheduled.** `LEADER_ONLY`. Interval is `supervise.max_timer_lag / 2`, so a
pass runs at least as often as the SLI it reports.

**Can the production path reach every Phase 5 action?** For the fourteen Leg actions:
**yes, and it is exercised** — group B arms a real timer in each state and fires it through
the composed worker. For the seven Task actions and the commitment action: **no**, because
nothing arms them (X3). Recorded, not glossed.

**Missing dependencies, and their owners.** `ladder` → T1-04 (X1). `probe` → §10.3.1 row 3
makes it a side-effect-free live query `outbox.buildRow` refuses to enqueue, so it is a
transport call; its absence costs a diagnostic and is recorded, and the reassignment §4.4
mandates happens either way. **Neither is stubbed.**

**The composer refuses rather than degrades.** Verified: with no transaction seam it returns
`PROCESS_DEPENDENCY_MISSING` naming *"one transaction"*; with an incomplete handler map it
returns `COLLABORATOR_NOT_IMPLEMENTED` naming the missing actions (mutation **M5**).

---

## 9. Exact remediation — files changed

| File | Why | Scope |
|---|---|---|
| `src/engine/supervision/expiryActions.js` | **NEW.** §4.5's seventeen expiry semantics; `declaredActions`/`assertComplete` derived from the machines | Phase 5 (T0-08) |
| `src/engine/supervision/timers.js` | `claim`, `reschedule`, `armedSecondsOf`; `register` re-arms a resolved key; `resolve` gains `owned` | Phase 5 — D5-2, D5-4, D5-5, D5-6, D5-8 |
| `src/workers/timer.worker.js` | `fireOne` is one transaction; structural re-arm from the entity's version; `runInTransaction` required | Phase 5 — D5-1, D5-2, D5-3, D5-4 |
| `src/engine/lifecycle/transitions.js` | three `SECTION_4_3_SOURCED` rows; `sectionFourThreeSourcedRows`, `statesWhoseExpiryHasNoDedicatedRow`; records `armedSeconds` | Phase 5 — D5-7, D5-8 |
| `src/engine/lifecycle/reassignment.js` | records `armedSeconds` (one line) | Phase 5 — D5-8 |
| `src/engine/lifecycle/cancellation.js` | records `armedSeconds` (one line) | Phase 5 — D5-8 |
| `src/engine/supervision/reconciler.js` | records `armedSeconds` (one line) | Phase 5 — D5-8 |
| `src/workers/leaderWorkers.js` | the `timer` composer; `UNCOMPOSABLE.timer` removed | Phase 15 module, Phase 5 blocker |
| `tests/engine/supervisionExpiryActions.test.js` | **NEW** — 39 tests | Phase 5 tests |
| `tests/engine/supervisionTimers.test.js` | +11 | Phase 5 tests |
| `tests/engine/supervisionWorkers.test.js` | +6, 4 corrected | Phase 5 tests |
| `tests/engine/lifecycleTransitions.test.js` | +1 assertion | Phase 5 tests |
| `tests/engine/leaderWorkerLifecycle.test.js` | timer now composes; new planted test | Phase 15 tests |
| `tests/gates/checkCompositionRoot.test.js` | 1 violation, not 2; new regression | Phase 15 tests |
| `tools/verify/phase5ExpirySemantics.js` | **NEW** — 102 live checks | Phase 5 verification |
| `tools/verify/phase5LiveDatabase.js` | 4 assertions corrected to the fixed semantics; +1 check | Phase 5 verification |

**No frozen specification was modified. No migration was added and the schema is unchanged**
(`armedSeconds` lives inside the existing `Timer.payload` JSON column). **No gate threshold
was changed. No test was deleted, skipped, or weakened.**

### Tests changed rather than added, and why each was wrong

Four assertions described the defective behaviour and had to be corrected rather than kept.
Named individually because "I updated a test" is the sentence this whole exercise exists to
distrust:

1. `supervisionWorkers` — *"a due timer fires its handler and is resolved"*: a handler that
   moves nothing was expected to resolve the timer `FIRED`. That is **D5-2**. Split into two
   tests: one where the handler moves the entity (resolves), one where it does not (re-arms).
2. `supervisionWorkers` — *"a handler that throws still resolves its timer"*: resolving a
   timer whose handler threw discharges a deadline nobody acted on. That is **D5-3**. Now
   asserts the roll-back and the re-arm.
3. `supervisionWorkers` chaos — the kill was modelled as a handler that throws, which now
   exercises the *error* path rather than the *death* path. Re-modelled so the dying process
   writes nothing at all, which is a stricter statement of the same requirement.
4. `phase5LiveDatabase` `handlerMap` — same as (1), against the live database.

Every one of the four is **stronger** after the change, and each is mutation-tested.

---

## 10. Regression tests

| Defect | Test | File |
|---|---|---|
| D5-1 | refuses without a transaction seam; handler asserts it receives `tx` | `supervisionWorkers` |
| D5-2 | refused attempt re-arms; re-arm decided from the version not the claim | `supervisionWorkers`, `supervisionTimers` ×6 |
| D5-3 | effect and resolution commit together | `supervisionWorkers`; live C |
| D5-4 | re-armed timer cannot be claimed at the same clock; claim outside a tx refused | `supervisionTimers` ×3; live C |
| D5-5 | re-registering a resolved key re-arms; a pending key is unchanged | `supervisionTimers` ×2 |
| D5-6 | claimed fire records itself; **and** the converse without `owned` | `supervisionTimers` ×2, `supervisionWorkers` |
| D5-7 | the three rows enumerated exactly; `ABORTING` ×4 obstruction classes | `supervisionExpiryActions` ×7 |
| D5-8 | `apply` records the interval; three resolution paths | `lifecycleTransitions`, `supervisionTimers` |
| D5-9 | four non-`NONE` custody states refuse; the trap asserted | `supervisionExpiryActions` |
| X1 | never reads an unimplemented ladder as an exhausted one | `supervisionExpiryActions` |
| completeness | missing key **and** unexpected key both refuse composition | `supervisionExpiryActions`, `leaderWorkerLifecycle` |

**Phase 5's six suites: 244 tests** (`supervisionTimers`, `supervisionWorkers`,
`supervisionExpiryActions`, `supervisionReconciler`, `lifecycleTransitions`,
`lifecycleModelCheck`).

---

## 11. Adversarial and mutation results

### Mutation pass — 11/11 caught

Each protection was removed from the source, the tests that should catch it were run and
required to **fail**, the file was restored byte-for-byte, and they were required to pass
again. A protection whose removal leaves the suite green is not a protection.

| | Protection removed | Verdict |
|---|---|---|
| M1 | `fireOne` re-arms a deadline the fire did not discharge | **CAUGHT** |
| M2 | the fire's resolution is `owned` | **CAUGHT** |
| M3 | `register` re-arms a resolved key | **CAUGHT** |
| M4 | `claim` re-checks `dueAt` | **CAUGHT** |
| M5 | the handler map must cover every declared action | **CAUGHT** |
| M6 | §4.4's `no custody` guard is evaluated, not restated | **CAUGHT** |
| M7 | an unimplemented ladder is never read as an exhausted one | **CAUGHT** |
| M8 | §4.3's `ABORTING → STRANDED_*` row exists | **CAUGHT** |
| M9 | the armed interval is recorded by `transitions.apply` | **CAUGHT** |
| M10 | the worker refuses without a transaction seam | **CAUGHT** |
| M11 | the §4.3-sourced rows are enumerable | **CAUGHT** |

**Three of these survived their first attempt** and the tests were strengthened until they
did not — M2 (no worker-level test exercised the cancellation race), M9 (every test passed
`armedSeconds` explicitly), and M5 (whose first target was a gate that is legitimately red
for another reason, so it could not signal). Recorded because a mutation pass that passes
first time has usually been aimed at what the tests already check.

### Attacks run against the integrated path (live PostgreSQL)

| Attack | Result |
|---|---|
| timer exists but worker never starts | composer refuses by name; `gate:composition` red |
| worker starts with incomplete dependencies | refused — `PROCESS_DEPENDENCY_MISSING` / `COLLABORATOR_NOT_IMPLEMENTED` |
| action declared but not implemented | `assertComplete` refuses composition (M5) |
| action implemented but never dispatched | group B fires all fourteen Leg actions end to end |
| wrong action selected | handler is read from `timer.handler`, written from the state's own machine |
| expired timer ignored | `due()` boundary is inclusive; verified at ±1 ms |
| timer processed twice | `claim`; 3 consecutive expiries → 1 timer, 1 state, `attempts=3` |
| two workers, same timer, concurrently | one page, not two; loser `NOT_CLAIMED` and does no work |
| crash **after** the DB mutation | rolled back; Leg unmoved; timer `PENDING` with the cause |
| crash **before** the mutation | timer untouched and still due; next pass fires it |
| transaction rolls back | re-armed outside the failed transaction, never lost |
| stale timer from an old state | `DISCARDED / ENTITY_VERSION_MOVED_ON`; handler never called |
| entity already terminal | `DISCARDED` |
| entity changed state before expiry | `DISCARDED` |
| state changed **without** its version | `DISCARDED / STATE_CHANGED_WITHOUT_VERSION` (planted with raw SQL) |
| entity gone | `DISCARDED / ENTITY_NO_LONGER_EXISTS` |
| leadership changes during processing | `stopAll()` on demotion; every handle stopped exactly once |
| superseded leader attempts expiry | `claim` + version CAS; loser writes nothing |
| fencing token changes | `WITHDRAW`/`RECALL` at an advanced fence, in the authorising transaction; `authority_epoch` untouched (I19) |
| clock boundary exactly at expiry | selected at `=`, not at `−1 ms` |
| clock skew | every deadline judged against `SELECT NOW()` (§10.6); the worker has no clock |
| batch processing | one pass takes ≤ `FIRE_BATCH` (64); lag reflects what it could not clear |
| multiple timers for one entity | the §4.5 key is unique; two registrations → one row |
| restart between selection and completion | fresh worker discovers and fires the timer |
| duplicate outbox event | `outbox.enqueue` is idempotent on `(commitment, sequence, fence)`; the whole fire is one transaction |
| duplicate state transition | version CAS; concurrent apply → `version=1`, one pending timer |
| retry after partial failure | rollback + re-arm; `attempts` and `lastOutcome` durable |

### Planted violations — the mechanism fails closed

| | Planted | Result |
|---|---|---|
| P1 | a handler removed from the map | timer stays `PENDING`, reported, **never silently discharged** |
| P2 | the completeness check itself, both directions | missing and unexpected both refuse |
| P3 | the re-arm removed | `findUnsupervised` reports the Leg — I4's violation, **detected**; restoring supervision clears it |
| P4 | a re-armed timer re-fired at the same clock | `NOT_CLAIMED`; chain rows 3 → 3 |

---

## 12. Cross-phase integrity

**Phases 0–4 are unchanged.** No file under `prisma/`, `src/db/`, `src/engine/commitment/`,
`src/engine/dispatch/`, `src/engine/domain/` or `src/engine/shard/` appears in the change
set:

```
$ git status --porcelain | grep -E "prisma/|src/db/|src/engine/(commitment|dispatch|domain|shard)/"
NONE — no Phase 0-4 module is modified
$ git diff --stat HEAD -- Backend/prisma Backend/src/engine/commitment Backend/src/engine/dispatch Backend/src/engine/domain
(empty)
```

**No migration was added; the schema is byte-identical.**

**Contracts relied upon by Phases 6–15.** Three changed, all in the strict direction:

1. `timer.worker` now **requires** `runInTransaction`. Its only production composer supplies
   it. Every test that drives it was updated to supply it — the required-dependency refusal
   is itself tested.
2. `timers.resolve` gains an **optional** `owned` flag; absent, behaviour is byte-identical.
3. `timers.register` re-arms a **resolved** row instead of returning it. A `PENDING` row is
   returned unchanged, so every existing caller's behaviour is preserved; the changed case
   is the one that previously produced an unsupervised state.

Phase 12's invariant checker, Phase 12's `modeRegister`, Phase 13's shard supervisor, and
Phase 15's cutover and release-gate machinery are exercised by the full suite: **156 suites,
6 909 tests, all green.**

---

## 13. Live PostgreSQL verification

A disposable PostgreSQL **18.3** cluster on port **55435**, built from the installed
binaries into the scratchpad. The full migration chain applied **from an empty database**:

```
$ dropdb … && createdb … && for d in prisma/migrations/*/; do psql -v ON_ERROR_STOP=1 -f "$d/migration.sql"; done
APPLIED 26 migrations
```

`Timer` verified as PostgreSQL created it: 4 CHECK constraints (`Timer_state_known`,
`Timer_entity_type_known`, `Timer_entity_version_non_negative`, `Timer_attempts_non_negative`),
`Timer_timerKey_key` UNIQUE, and four indices. **No mocked Prisma behaviour is counted
anywhere in this section.**

### `tools/verify/phase5ExpirySemantics.js` — 102 / 102

| Group | Checks | What it establishes |
|---|---|---|
| A — production composition | 9 | leadership starts the worker; all 17 handlers present; no placeholders; the blocker table no longer names it |
| B — every §4.3 Leg action | 51 | armed → due → fired → state, DB, outbox, fence, event, timer disposition, for all fourteen |
| C — adversarial | 22 | staleness ×4, concurrency ×4, crash points ×2, idempotency ×2, clock boundary ×2, batch ×2, key uniqueness, re-arm |
| D — the lag SLI | 4 | lag is the oldest overdue timer; the degraded directive and its `stopNewHardening` half |
| E — planted violations | 8 | the four plants above |
| F — cross-phase findings | 5 | X1, X2, X2a, X2b, X3 reproduced with their owners |

### `tools/verify/phase5LiveDatabase.js` — 106 / 106

The prior harness, re-run against the fixed code with four assertions corrected (§9) and one
added. Its schema, keying, cancellation, lease, reconciler, settlement, verification and
custody groups are unchanged and still pass.

**Live evidence total: 208 checks.**

### What live execution found that a green suite did not

Five of the nine defects — **D5-5, D5-6, D5-8, D5-9 and the `nackCooloffSeconds` omission** —
were found by the first live run of a suite that was **155/155 green at the time**. That is
the fifth consecutive phase where the live database found what the store model could not, and
it is now a programme-level fact rather than an anecdote.

---

## 14. Performance measurements

Measured against the live instance, driving the composed production worker over a 512-timer
backlog of `OPERATOR_ALERT` (the non-transitioning action, so the backlog persists across
passes — a saturated supervisor).

| | Measured |
|---|---|
| `FIRE_BATCH` | 64 timers per pass |
| Pass wall-clock — min / p50 / max | 435.5 ms / **479.5 ms** / 582.7 ms |
| Per timer (p50) | **7.5 ms** |
| Passes to drain 512 | 8 (bounded, as designed) |
| Lag SLI during recovery | reported every pass; moved *during* the drain, not after |

Each fire is one transaction containing a claim, the handler's work, and a resolve-or-re-arm,
so ~7.5 ms per timer against a local disposable instance is transaction round-trips rather
than computation. At the configured interval (`supervise.max_timer_lag / 2` = 15 s) one shard
sustains ≈ 4 timers/second before the backlog grows — **and the SLI is what says so**, which
is the property §4.5 asks for.

**Not measured, and not claimed:** behaviour against a production-grade instance, under
concurrent shard load, or at §20.1's target batch size. `scale_targets` remains a Phase 16b
gate with an unresolved aggregation rule (OD-3).

---

## 15. Remaining limitations

Genuine unresolved items only.

1. **`ESCALATION_LADDER` refuses.** A `QUEUED` Leg past its SLA deadline is supervised,
   counted, and **not relaxed**, until T1-04 lands (X1).
2. **Seven Task handlers and the commitment handler have no producer** (X3). Implemented,
   unit-tested at the handler boundary, **unreachable in production**.
3. **Two live paths still leave Legs unsupervised** (X2a, X2b) — Phase 4 modules, Phase 15
   cutover.
4. **`probe` is not injected.** §10.3.1 row 3 makes it a live query; its absence costs a
   diagnostic, not a decision, and is recorded per fire.
5. **`reassignment.reassign`'s own custody bar uses `holdsGoods`**, which admits
   `PENDING_TRANSFER`. Its callers now all apply §4.4's stricter guard first, so no current
   path reaches it with mid-transfer custody. Pre-existing, out of this exercise's scope,
   **flagged for the module's owner**.
6. **The release-gate evidence is stale by source digest.** `release:verdict` reports
   `SOURCE_DIGEST_MISMATCH` on every collected row, because this tree differs from the one
   the records were collected against. That is the mechanism working — *"a gate that passed
   on a different tree is evidence about a program nobody is shipping"* — and re-collecting
   is Phase 15's step. The verdict is `BLOCKED` either way, for B1.
7. **`reconciler.HOLDING_CUSTODY_STATES` is still a hand-maintained array.** Carried forward
   from the 2026-08-17 closure, unchanged, still low severity.
8. **One schema drift outside Phase 5** (`ConfigActiveVersion_version_fkey`, Phase 1).
   Carried forward unchanged.

---

## 16. External dependencies

| | What | Owner | Blocks |
|---|---|---|---|
| **B1** | routing engine selection (D1 region, D3 speed model, D8 extract vintage) | Operations + Commercial + Product + Fleet Engineering | `coordinator.worker`, `gate:composition`, the release |
| **T1-04** | the §17.4 escalation ladder — an *internal* remedial phase, not external, but not Phase 5's | REMEDIAL PHASE T1-04 | `ESCALATION_LADDER`'s relaxation semantics |

No value was manufactured for either. `ladder` is absent rather than stubbed; the coordinator
is refused rather than started against an invented router.

---

## 17. Specification ambiguities

Documented, **not resolved by invention**.

### A1 — §4.4 is incomplete over §4.3's "On expiry" column

Three consequences §4.3 states in its own words have no §4.4 row (D5-7). The rule applied,
stated once in `transitions.js` and once here:

> A row may carry the `SECTION_4_3_SOURCED` marker **only where §4.3 states the consequence
> in its own words**, and must perform *that* consequence and nothing more. Where §4.3 is
> silent, no row is added.

Under that rule `REASSIGNING`'s *"escalate"* and the two `OPERATOR_ALERT` states get **no**
row — §4.3 names an action there and no target state — and their handlers act without moving
the Leg. `sectionFourThreeSourcedRows()` enumerates the three so a fourth cannot join
unannounced (mutation M11).

### A2 — §4.7 sends the Leg to a state §4.3 does not have

> *"on exhaustion the Leg goes to `SUSPENDED` for operator decision"*

§4.3's nineteen Leg states include no `SUSPENDED`; `SUSPENDED` is a §4.2 **Task** state.
`lifecycle/reassignment.js` resolved this before this exercise — the Leg freezes in
`REASSIGNING`, the *Task* suspends — and `ESCALATE` follows that precedent rather than
setting a second one or inventing a twentieth Leg state.

### A3 — §4.2 has no transition table at all

§4.3's machine has §4.4. §4.2's has a state table with an exit-deadline column and nothing
saying what a Task moves to on any event. The seven Task handlers therefore record the
breach, name the operator queue, and re-arm. Writing a Task transition table here would be
inventing the customer-visible contract's semantics.

### A4 — `ABORTING`'s expiry is not custody-conditioned

§4.3 says *force* to the applicable `STRANDED_*` state, and every other §4.3 stranding path
is custody-conditioned. `ABORTING` is reached both with custody (§4.6 step 3) and without
(§4.4's `pickup impossible` row). The row is **unguarded**, because a recovery that has
exhausted its budget has not recovered the agent either way, and a custody guard would leave
a custody-`NONE` `ABORTING` Leg with a deadline it can never discharge — the defect the row
exists to remove. The custody manifest rides on the page. **This reading is recorded rather
than asserted as obvious.**

### A5 — `REJECT_OR_ESCALATE` is a disjunction with no rule

§4.3's other disjunctions are decided by evidence a timer has. This one is not: rejecting a
Task is terminal and customer-visible, and §4.2 supplies no rule for choosing. The handler
takes the **escalate** branch and never the reject one.

---

## 18. Exact test and gate counts

```
Test Suites: 156 passed, 156 total
Tests:       6909 passed, 6909 total
Time:        216.554 s
```

| Project | Tests |
|---|---|
| engine | 6 568 |
| gates | 148 |
| legacy | 126 |
| chaos | 44 |
| scale | 23 |
| **total** | **6 909** |

Phase 5's six suites: **244 tests**.

### Build gates — 7 PASS, 1 FAIL (correctly)

```
gate: tier-dependencies         PASS — 282 modules, 414 governed edges, no Tier 0/1 → Tier 2
gate: parameter-register        PASS — 186 modules against 242 registered parameters
gate: tenets                    PASS — 279 modules, no violations
gate: identity-isolation        PASS — 16 modules
gate: reconstruction-equivalence PASS — 3 decisions, byte-for-byte
gate: legacy-retirement         PASS — 4 retired modules absent, 334 files
gate: column-generation         PASS — NOT_REQUIRED
gate: composition-root          FAIL — 1 violation across 18 workers:
    coordinator (tier 0) [LEADER_ONLY_NOT_COMPOSABLE] … B1 … EXTERNAL to this repository
```

**Baseline was 2 violations. The `timer` row is gone because the worker starts, not because
the gate was changed.** `checkCompositionRoot.js` is untouched by this exercise.

### Live database

```
tools/verify/phase5ExpirySemantics.js   102/102
tools/verify/phase5LiveDatabase.js      106/106
```

### Mutation pass

```
11/11 mutations caught
```

---

## 19. Exact commands used

```bash
# Disposable PostgreSQL 18.3, port 55435, migration chain from empty
initdb -D <scratch>/pg5data -U pgverify --pwfile=<file> -A trust -E UTF8 --locale=C
Start-Process postgres.exe -ArgumentList "-D",<pgdata>,"-p","55435","-c","listen_addresses=127.0.0.1" -WindowStyle Hidden
createdb -h 127.0.0.1 -p 55435 -U pgverify robotx_phase5
for d in prisma/migrations/*/; do psql -h 127.0.0.1 -p 55435 -U pgverify -d robotx_phase5 \
    -v ON_ERROR_STOP=1 -q -f "${d}migration.sql"; done        # APPLIED 26 migrations

export DATABASE_URL="postgresql://pgverify:pgverify@127.0.0.1:55435/robotx_phase5"
npx prisma generate

# Verification
node tools/verify/phase5ExpirySemantics.js                    # 102/102
node tools/verify/phase5LiveDatabase.js                       # 106/106
node <scratch>/perf.js                                        # §14
node <scratch>/mutate.js                                      # 11/11 caught

# Suites and gates
npx jest --runInBand --forceExit                              # 156 suites / 6909 tests
npx jest --runInBand --forceExit --selectProjects engine|gates|legacy|chaos|scale
npm run gates                                                 # 7 PASS, composition FAIL(1)
npm run release:verdict                                       # BLOCKED (B1; digests stale)

# Cross-phase integrity
git status --porcelain | grep -E "prisma/|src/db/|src/engine/(commitment|dispatch|domain|shard)/"
git diff --stat HEAD -- Backend/prisma Backend/src/engine/commitment Backend/src/engine/dispatch

# Teardown
pg_ctl -D <scratch>/pg5data -m fast stop
```

---

## 20. Phase 6 readiness decision

**Phase 6 was already closed** (2026-08-17) and nothing here re-opens it. The forward
question is the one that matters:

### Is the Phase-5 blocker Phase 15 raised discharged? — **YES**

`gate:composition` no longer names the timer. The worker composes, starts on leadership, and
fires real deadlines into real state changes against a real database. `leaderWorkers.UNCOMPOSABLE`
holds one row and it is external.

### Is Phase 15 unblocked? — **NO, and not by this.**

Phase 15's remaining blockers after this work:

| | Status |
|---|---|
| **D-5 / coordinator** — B1 routing engine | **OPEN — external** |
| **D-9 / timer expiry semantics** | **CLOSED by this exercise** |
| calibration — 39 Safety-class parameters | OPEN — external |
| `shadow_agreement` fourteen-day window | OPEN — cannot start until the shadow worker composes |
| release evidence digests | stale after this change; re-collection is Phase 15's step |
| **X2a / X2b** — live paths leaving Legs unsupervised | **NEW input to Phase 15's cutover scope** |

### Recommendation

**Re-audit Phase 15 next, with X2a/X2b added to its scope**, and treat X1 (T1-04) as the
next remedial phase. Phase 16 remains not ready.

---

## 21. Phase boundary

No Phase 6–16 functionality was implemented. No feasibility predicate, no cost term, no
candidate expansion, no solve path, no round loop, no cutover semantics. `leaderWorkers.js`
is a Phase 15 module and the **only** change to it is its `timer` composer and the removal of
the blocker row that this exercise's own work made false.

The §17.4 ladder was **not** implemented, and no partial ladder, default step, or placeholder
verdict was introduced in its place.

---

## 22. Explicitly NOT proven

Stated plainly, because a closure that omits this section is not one.

1. **The seven `TASK` expiry handlers have never fired in production, and cannot.** Nothing
   registers a `TASK` timer (X3). They are unit-tested at the handler boundary and are
   **not** covered by any end-to-end evidence. `TASK`-entity timers in the live store after a
   full harness run: **0**.
2. **`LEASE_EXPIRY_RECOVERY` has no timer producer either.** Commitment lease expiry is
   handled today by `reconciler.scanExpiredLeases`, by scan. The handler is implemented and
   unit-tested; **no live check fires a commitment timer**, because none is ever registered.
3. **`ESCALATION_LADDER` has never successfully relaxed anything**, in any environment. What
   is proven is that it refuses by name, does not fail the Leg, and re-arms.
4. **The `probe` in "probe, then reassign" has never been sent.** No transport is injected.
   What is proven is that the reassignment happens regardless and the absence is recorded.
5. **Nothing here proves the engine assigns work.** `coordinator.worker` remains uncomposable.
   A shard with `ENGINE_ENABLED=true` today would supervise deadlines correctly on Legs that
   nothing creates.
6. **No production environment was used.** All evidence is from a disposable local
   PostgreSQL 18.3 instance. No soak, no multi-shard run, no real fleet.
7. **The performance figures are local single-process measurements**, not §20.1 targets.
8. **`prisma migrate diff` still reports the Phase 1 drift.** Not re-investigated here.
9. **The §18.6 chain has never contacted anyone.** Step 4 is human-gated and unreachable from
   any automatic path — proven — and steps 1–3 write `ExternalEscalation` rows that no
   transport consumes.
10. **X2a and X2b are reproduced, not fixed.** Two live production paths leave Legs
    non-terminal with no pending timer today. Phase 5's own paths do not, and that asymmetry
    is the finding.

---

## Appendix — the matrix as the tree reports it

```
$ node -e '<read legMachine.LEG_DEADLINES, taskMachine.TASK_DEADLINES, expiryActions.handlers({})>'
LEG:QUEUED               | ESCALATION_LADDER                       | YES | sla.assignment_deadline
LEG:DEFERRED             | FORCE_WIDEN_AND_ESCALATE                | YES | assign.max_deferral_time
LEG:PLANNED              | HARDEN_OR_REPLAN                        | YES | commit.hardening_deadline
LEG:OFFERED              | WITHDRAW_EXCLUDE_REPLAN                 | YES | dispatch.offer_ttl
LEG:ACCEPTED             | PROBE_THEN_REASSIGN                     | YES | execute.start_grace
LEG:EN_ROUTE_PICKUP      | PROGRESS_PROBE                          | YES | execute.eta_tolerance
LEG:AT_PICKUP            | OPERATOR_ALERT                          | YES | stop.service_time_limit
LEG:EN_ROUTE_DROP        | PROGRESS_PROBE                          | YES | execute.eta_tolerance
LEG:AT_DROP              | OPERATOR_ALERT                          | YES | stop.service_time_limit
LEG:RELEASED             | VERIFICATION_ESCALATION                 | YES | verify.evidence_deadline
LEG:ABORTING             | FORCE_STRANDED                          | YES | recover.abort_budget
LEG:STRANDED_SAFE        | PAGE_OPERATIONS                         | YES | ops.stranded_safe_response_target
LEG:STRANDED_OBSTRUCTING | PAGE_OPERATIONS_AND_EXTERNAL_ESCALATION | YES | ops.stranded_obstructing_response_target
LEG:REASSIGNING          | ESCALATE                                | YES | recover.reassign_budget
TASK:RECEIVED            | REJECT_OR_ESCALATE                      | YES | intake.validation_budget
TASK:PLANNABLE           | DECOMPOSITION_STALLED                   | YES | intake.validation_budget
TASK:WAITING             | ESCALATION_LADDER                       | YES | sla.assignment_deadline
TASK:IN_EXECUTION        | REPROJECT_TIMELINE                      | YES | execute.eta_tolerance
TASK:AT_RISK             | ESCALATION_LADDER                       | YES | sla.assignment_deadline
TASK:SUSPENDED           | OPERATOR_REVIEW                         | YES | ops.suspension_review_period
TASK:VERIFYING           | VERIFICATION_ESCALATION                 | YES | verify.evidence_deadline
COMMITMENT:*             | LEASE_EXPIRY_RECOVERY                   | YES | lease.duration

leg states without a deadline : [ 'LOADED' ]   (§4.3's one documented exception)
task states without a deadline: []
leg states without an exit    : []
§4.3-sourced rows             : PLANNED/HARDENING_DEADLINE_ELAPSED, EN_ROUTE_DROP/ETA_BREACH, ABORTING/ABORT_BUDGET_EXPIRY
states whose expiry has no dedicated row: [ 'REASSIGNING' ]   (correct — see §17 A2)
```

At baseline the IMPLEMENTED column read `NONE` for all twenty-two rows.

---

# PHASE 5 — CLOSED
