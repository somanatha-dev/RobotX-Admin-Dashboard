# Phase 5 — Implementation Report

**Phase:** 5 of 16 · **Status:** ✅ **COMPLETE — awaiting independent verification before Phase 6**
**Date:** 2026-08-03 · **Branch:** `feature/dashboard` · **Base:** `4244b3d` + uncommitted Phases 1–4
**Scope:** `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` §4.2, §4.3, §4.4, §4.5, §4.6, §4.7, §4.9, §12
(Supervision and Reconciliation) · §26 invariants I3, I4, I7, I8, I12, I13
**Governing plan:** `IMPLEMENTATION_EXECUTION_PLAN.md` §3 "PHASE 5" and its §7 checklist

> **Phase 6 has NOT been started.** There is no feasibility predicate, no `RejectionAggregate`,
> no `NearMissSketch`, no energy model, no packing tier, no candidate index, and no cost term.
> `src/engine/feasibility/`, `energy/`, `payload/`, `candidates/`, `solve/`, `plan/` and
> `routing/` remain empty of runtime code — asserted mechanically by
> `tests/engine/phase0Scaffold.test.js` and verified by `find … -name "*.js" | wc -l` → **0**.

---

## 0. A prerequisite this phase had to discharge first

`PHASE_4_INDEPENDENT_VERIFICATION.md` (dated 2026-08-03) is a **FAIL** and states: *"Phase 5
must NOT begin until the blocking issues below are resolved and independently re-verified."*
Both issues were still present in the working tree and were independently reproduced before
any Phase 5 code was written. **They were corrected first**, on the tech lead's instruction,
and are reported here in §0 rather than folded into the Phase 5 narrative, because they are
Phase 4's scope and must be re-verified as such.

### 0.1 Blocking issue 1 — the dedup revert clobbered a concurrent command

`VirtualRobot._onMissionCommand` and `_onAgentCommand` each wrote the deduplication state,
awaited the durable persist, and **unconditionally restored a snapshot taken before the
await** on failure. With two commands in flight for one commitment id, the failing one's
revert overwrote the successful one's write — the agent then believed one authority while its
flash held another, having already `COMMAND_ACK`ed the second. That is a direct breach of
§11.5's *"durable **before** any externally observable effect"* and of invariant I21.

**Correction (`src/simulation/VirtualRobot.js`):**

1. A promise-chain mutex (`_withDedupLock`) serialises the whole read-decide-write-persist
   critical section. One lock, not one per commitment id: §10.3.1's interaction rule has an
   agent-scope command *discard the entire per-commitment table*, so an agent command and a
   mission command that overlap are two writers of one object.
2. Both reverts became **compare-and-restore** — each restores only what that call actually
   wrote. This is belt and braces against `adoptDedupAcknowledgement`, which is synchronous
   and deliberately unlocked (§11.5's AUTH path must leave no window in which handlers are
   live under a superseded authority) and can therefore land inside the await.

**Regression tests** (`tests/engine/dispatchAgentProtocol.test.js`, +2): both construct
genuinely overlapping in-flight delivery, not sequential `await`s. Both were **proved to fail
against the old semantics** by temporarily restoring them behind an env probe, and to pass
against the fix; the probe was then removed. The discriminating assertion is a property rather
than a state: *the agent's in-memory belief and its durable record are the same object's two
copies and may not diverge*, and *nothing is acknowledged beyond what the flash can prove*.

### 0.2 Blocking issue 2 — §11.4 step 2 had no production caller

`offers.withdrawExpiredOffer` — the fence advance, commitment release, Leg requeue and
`WITHDRAW` dispatch that §11.4 step 2 prescribes — had **zero** callers outside its own tests
(`grep -rn withdrawExpiredOffer` → definition + 2 test files). The `UNACKNOWLEDGED` state it
did produce was excluded from `OUTSTANDING_STATES`, so it was invisible to `readSli`'s depth,
to `expirePastValidity`, and to §11.5's reset-path suppression.

Investigating it surfaced a **third, unreported defect** that would have made any wiring inert:
an `OFFER`'s `not_valid_after` **is** its offer TTL (`enqueueOffer` sets them to the same
instant, deliberately), and the drain pass expired rows *before* escalating — so every
unanswered offer reached the terminal `EXPIRED` state in the very pass its TTL lapsed, and
step 2, whose trigger is exactly "no ACK within `dispatch.offer_ttl`", found nothing to act on.

**Corrections:**

| File | Change |
|---|---|
| `src/engine/dispatch/outbox.js` | `UNACKNOWLEDGED` added to `OUTSTANDING_STATES`; new `DELIVERY_OBLIGATION_STATES` (PENDING/CLAIMED/DELIVERED) is what `expirePastValidity` sweeps, so an unanswered offer is not discharged by its own envelope going stale; `readSli` counts undelivered off `deliveredAt` and reports `unacknowledged` separately |
| `src/workers/outbox.worker.js` | Pass order is now claim → deliver → record → **escalate** → expire → SLI. `escalateOutstanding` performs step 2 via new `withdrawIfOwed` / `performWithdrawal`, in the worker's own transaction; a successful withdrawal settles the row to `FAILED` (resolving non-blocking issue 4 — `FAILED` previously had no writer); a row with no transaction seam stays `UNACKNOWLEDGED` and outstanding; a non-`OFFER` row goes terminal rather than waiting for a withdrawal that cannot apply |
| `src/engine/dispatch/escalation.js` | New `isMarkedUnresponsive` / `WITHDRAWN_MARK`. Step 3 counts consecutive marks, and a successful step 2 would otherwise have erased its own evidence — an agent that never answers would be withdrawn from indefinitely and never investigated |

**Regression tests** (`tests/engine/dispatchEscalation.test.js`, +6): an offer that times out is
actually withdrawn (fence 42 → 43, `WITHDRAW` enqueued, commitment released, Leg `QUEUED`, row
terminal); the SLI reflects the unanswered offer while outstanding; a withdrawn offer still
counts as the agent's step-3 mark; a commitment released in the meantime is closed rather than
withdrawn at a fence nobody holds; an unanswered non-offer goes terminal; and an unanswered
offer is **not** swept away by its own envelope expiring.

### 0.3 Result

`npm run verify` after the remediation: 3 gates PASS, **53 suites / 1,075 tests**, up from the
1,067 the Phase 4 report and its verification both recorded. Legacy lane unchanged at 22/169.
Phase 5 was then begun.

---

## 1. Executive Summary

Phase 5 delivers §12 and §4.5 — *"the mechanism that makes 'stuck forever' structurally
impossible, which is the audit's largest single class of defect"*.

Thirteen new modules, three new tables, one additive column, two new workers, one REST route,
and four socket-surface modifications. The centre of it is the **durable timer store**, keyed
on each supervised entity's own version, and the **reconciler**, a control loop that repairs
all of §12.4's divergence classes and counts every repair against a per-category rate.

| | |
|---|---|
| **Files created** | 13 engine modules + 2 workers + 1 controller + 1 route + 4 test suites |
| **Files modified** | 8 (schema, register, 4 socket/service files, 2 test files) |
| **Migration** | `20260803210000_supervision_and_reconciliation` — 3 tables, 1 column, 7 CHECK backstops |
| **LOC added** | 5,339 runtime + 2,368 test |
| **Tests** | **1,235 passing** across 57 suites (from 1,075); legacy lane unchanged at 22/169 |
| **Gates** | tier-dependencies PASS (120 modules), parameter-register PASS (48 modules / 153 parameters), tenets PASS (117 modules) |
| **Register** | 5 new parameters, all named by §4.2/§4.3 and absent from Appendix A |
| **Invariants newly verifiable** | I3, I4, I7, I8, I12, I13 |

Three specification/plan discrepancies were found and are recorded rather than resolved (§14):
§12.4 tabulates **ten** divergence classes where the plan says nine; §4.3 gives `LOADED` no
deadline; and the plan's Phase 5 migration list names no column where §4.1 rule 2 requires one.

---

## 2. Phase 5 Objectives

From `IMPLEMENTATION_EXECUTION_PLAN.md` §3:

> **Purpose.** Deliver §12 and §4.5 — the mechanism that makes "stuck forever" structurally
> impossible, which is the audit's largest single class of defect.
>
> **Scope.** Durable timer store keyed on entity version, timer worker, per-commitment lease
> renewal requiring positive evidence, lease expiry → custody-aware recovery, progress
> supervision, reconciliation loop, graded completion verification with the three
> track-plausibility tests.

Completion criteria, each addressed in §12:

> Every §4.2/§4.3 deadline has a durable timer; reconciler repairs all nine §12.4 divergences
> and counts each; repair rate is an alertable SLI; completion verification graded L0–L3 with
> stated thresholds; settlement enforces custody-release-before-commitment-release (I7); I3,
> I4, I7, I8, I12, I13 verifiable.

---

## 3. Pre-Implementation Analysis

### 3.1 Modules affected

| Concern | Location | Disposition |
|---|---|---|
| Durable timers | `src/engine/supervision/timers.js` | New — T0-08 |
| Lease renewal and expiry | `src/engine/supervision/leases.js` | New — T0-08. Phase 3's `commitment/leases.js` keeps the **grant**; this owns renewal |
| Progress supervision | `src/engine/supervision/progress.js` | New — T0-08 |
| Reconciliation loop | `src/engine/supervision/reconciler.js` | New — T0-08 |
| Completion verification | `src/engine/supervision/verification.js` | New — T0-08 |
| Leg / Task state machines | `src/engine/lifecycle/legMachine.js`, `taskMachine.js` | New |
| §4.4 transition table | `src/engine/lifecycle/transitions.js` | New |
| Settlement | `src/engine/lifecycle/settlement.js` | New — T0-07 |
| Cancellation, reassignment | `src/engine/lifecycle/cancellation.js`, `reassignment.js` | New — T1-05 |
| Workers | `src/workers/timer.worker.js`, `reconciler.worker.js` | New — Tier 0 by path |
| Offline sweep | `src/sockets/socket.server.js` | Absorbed — stands down when the engine is on |
| Task recovery | `src/services/taskRecovery.service.js` | Absorbed — documented, behaviour unchanged, retires at Phase 15 |
| Telemetry | `src/sockets/handlers/telemetry.handler.js` | Feeds §12.3 progress supervision |
| `TASK_COMPLETE` | `src/sockets/handlers/dtaro.handler.js` | Routed through the §12.5 verification pipeline |

### 3.2 Database, API, Redis, Socket.IO

| Surface | Change |
|---|---|
| **Database** | `Timer`, `ReconcilerRepair`, `VerificationEvidence`; `Task.version`; 7 CHECK constraints |
| **REST** | **New** `GET /api/legs/:legId/supervision`. No existing route altered |
| **Redis** | One advisory gauge, `engine:timerlag`, written by the worker. Timers are DB-authoritative; **no module under `src/engine/supervision/` imports the cache**, and a test asserts it |
| **Socket.IO** | **No new events.** §12.3's probes reuse Phase 4's `PROBE` / `STATUS_REQUEST` / `MANIFEST_QUERY`. One dashboard-only emit (`SUPERVISION_SIGNAL`) and one added field on the existing `TASK_UPDATED` |
| **Config** | 5 new register entries: `intake.validation_budget`, `sla.assignment_deadline`, `stop.service_time_limit`, `recover.abort_budget`, `recover.reassign_budget` |

### 3.3 Test impact

Two existing engine assertions had to widen by exactly what this phase owns, not be deleted —
the discipline every prior phase followed: `phase0Scaffold.test.js`'s engine-tree ownership
list, and `commitmentSchema.test.js`'s "no future table" assertion (now Phase 6+). The Phase 3
store model gained four tables and their CHECK constraints.

---

## 4. Files Added

### Engine — supervision (Tier 0, T0-08)

| File | LOC | What it is |
|---|---|---|
| `src/engine/supervision/timers.js` | 539 | §4.5's durable timer store: the keying rule, registration inside the transition's transaction, atomic cancellation, the discard rule, the lag SLI, and I4's cross-audit |
| `src/engine/supervision/leases.js` | 307 | §12.2 renewal on commitment-scoped positive evidence; expiry detection; §4.7's custody-aware recovery assessment; I2's audit |
| `src/engine/supervision/progress.js` | 304 | §12.3's five signals as pure assessors |
| `src/engine/supervision/reconciler.js` | 808 | §12.4's ten divergence classes, each detected, repaired and counted; the per-category repair rate; I3's audit |
| `src/engine/supervision/verification.js` | 494 | §12.5's L0–L3 grading and the three track-plausibility tests |

### Engine — lifecycle

| File | LOC | What it is |
|---|---|---|
| `src/engine/lifecycle/legMachine.js` | 257 | §4.3's nineteen states, their deadlines, and the obstruction-class → stranding derivation (I22's first half) |
| `src/engine/lifecycle/taskMachine.js` | 165 | §4.2's eleven states and their deadlines, kept separate from the legacy vocabulary |
| `src/engine/lifecycle/transitions.js` | 795 | §4.4's complete table with guards, the write-scope classification, and the one `apply` that performs guard → conditional write → timer obligations as one transaction |
| `src/engine/lifecycle/settlement.js` | 315 | §4.9's steps, with custody discharge **checked** before commitment release (I7) |
| `src/engine/lifecycle/cancellation.js` | 354 | §4.6's protocol: the flag, the three resolutions, the `RECOVERY` Leg, I11's termination rule |
| `src/engine/lifecycle/reassignment.js` | 401 | §4.7's custody-`NONE` protocol as one transaction; the bounded chain; the transfer gate |

### Workers, API, tests

| File | LOC | What it is |
|---|---|---|
| `src/workers/timer.worker.js` | 280 | Fires due timers, at-least-once, idempotent handlers, refuses to fire an unregistered handler |
| `src/workers/reconciler.worker.js` | 181 | Periodic full sweep (bounded < 60 s) plus the event-driven `nudge` |
| `src/controllers/legs.controller.js` | 121 | `GET /api/legs/:legId/supervision` |
| `src/routes/legs.routes.js` | 18 | The route, behind the existing `authUser` |
| `tests/engine/supervisionTimers.test.js` | 372 | 30 tests — §4.5, §4.3, §4.2 |
| `tests/engine/lifecycleTransitions.test.js` | 413 | 27 tests — §4.4 and the §24.2 model check |
| `tests/engine/supervisionReconciler.test.js` | 863 | 59 tests — §12.2–§12.5 and §4.9 |
| `tests/engine/supervisionWorkers.test.js` | 720 | 41 tests — the two workers, §4.6, §4.7, the schema, and the §24.5 chaos case |
| `prisma/migrations/20260803210000_supervision_and_reconciliation/migration.sql` | 232 | The migration |

---

## 5. Files Modified

| File | Change | Backwards compatible |
|---|---|---|
| `prisma/schema.prisma` | 3 models, `Task.version`, one back-relation on `Leg` | Yes — additive only |
| `src/engine/config/register/supplementary.json` | 5 entries | Yes |
| `src/routes/index.js` | `router.use("/legs", legsRoutes)` | Yes — new mount point |
| `src/sockets/socket.server.js` | `startOfflineDetector` runs only while `ENGINE_ENABLED` is false | Yes — with the engine off, byte-for-byte the previous behaviour |
| `src/services/taskRecovery.service.js` | Documentation only; behaviour untouched | Yes |
| `src/sockets/handlers/telemetry.handler.js` | `feedProgressSupervision` after the dashboard emit | Yes — returns immediately unless `ENGINE_ENABLED` |
| `src/sockets/handlers/dtaro.handler.js` | `TASK_COMPLETE` graded before the legacy completion | Yes — returns `null` unless `ENGINE_ENABLED` **and** an Agent, a commitment, a Leg and resolved thresholds all exist |
| `tests/engine/phase0Scaffold.test.js` | Ownership list widened by `supervision/` and `lifecycle/`; two presence tests added; `server.js` assertion extended to the two new workers | n/a |
| `tests/engine/commitmentSchema.test.js` | "No future table" narrows to Phase 6+; Phase 5's three asserted present | n/a |
| `tests/engine/helpers/commitmentStore.js` | 4 tables and their CHECK backstops | n/a |

Plus the three Phase 4 remediation files (§0): `VirtualRobot.js`, `dispatch/outbox.js`,
`dispatch/escalation.js`, `workers/outbox.worker.js`, and their two test suites.

---

## 6. Database Changes

### 6.1 `Timer` — the durable timer store (§4.5, §3.3)

The whole module's correctness rests on one column:

> **Timers are keyed on the supervised entity's own version, never on the agent's authority
> epoch.** […] Keying timers on the agent's epoch would mean that committing or releasing *any
> unrelated Leg on the same agent* invalidates every timer for every other Leg that agent is
> carrying — silently removing supervision from missions that are executing normally.

`entityVersion` holds `Leg.version` for a Leg timer and `Commitment.fence` for a commitment
timer. It never holds `Agent.authorityEpoch`: `VERSION_SOURCE` maps no entity kind to one, and
`register` refuses a key drawn from one **by name**. That failure mode is silent by
construction — an over-invalidated timer does not throw, it simply never fires — so it is
refused rather than reviewed.

Indexes: `(dueAt)` — the plan's named index — plus `(timerState, dueAt)` for the due sweep and
`(entityType, entityId, timerState)` for the cancel sweep and the operator view.

### 6.2 `ReconcilerRepair` — the repair ledger (§12.4)

One row per repair, categorised by divergence class. `category` is CHECK-constrained because
§12.4 makes the per-category rate the release gate, and *a repair filed under a name the gate
does not know is a repair the gate cannot see*. `escalated` is separate from the count: §12.4's
"Escalate when" column makes an escalated repair a different event from an ordinary one, and
summing them would hide the distinction the column exists to draw.

### 6.3 `VerificationEvidence` — graded completion (§12.5)

The three plausibility **measurements** are stored, not just the verdict: §12.5's thresholds are
configuration, and a record holding only "failed" could not be re-evaluated when a threshold is
re-derived. A verification record that cannot be re-evaluated is not evidence.

### 6.4 `Task.version` — the one column beyond the plan's list

The plan's Phase 5 migration list names three tables and no column. It is nonetheless required,
and the plan states its own precedence:

> where this plan and the specification appear to disagree, the specification wins and this plan
> is defective

§4.1 rule 2 admits no unconditional state write, and §4.5 keys every timer on "the supervised
entity's own version". A Task machine with no version column could satisfy neither — its writes
would be the unconditional ones that produced the baseline's silent cancellation reversion, and
its timers would have to borrow another entity's counter, which §4.5 names as a correctness
defect rather than a shortcut. Additive and defaulted; every existing row remains valid.

### 6.5 The seven CHECK backstops

`Timer_entity_type_known`, `Timer_state_known`, `Timer_entity_version_non_negative`,
`Timer_attempts_non_negative`, `ReconcilerRepair_category_known`,
`VerificationEvidence_levels_known`, `VerificationEvidence_outcome_known`.

Each holds when the application logic that should have prevented the write is defective, and
none can be bypassed by a new call site — the same standard §10.3.2's backstops set.

### 6.6 Migration provenance

Every `CREATE TABLE`, `CREATE INDEX`, `ALTER TABLE … ADD COLUMN` and `ADD CONSTRAINT … FOREIGN
KEY` is Prisma's own generated SQL, taken verbatim from `prisma migrate diff --from-empty
--to-schema-datamodel`. **Independently re-generated and byte-diffed during this phase**: all
three `CREATE TABLE` stanzas are identical. The hand-written additions are the seven CHECKs.
`npx prisma validate` passes.

---

## 7. API Changes

### 7.1 New: `GET /api/legs/:legId/supervision`

The plan's stated operator visibility — *"current state, deadline, owning timer"*.

```jsonc
{
  "legId": "leg-alpha", "state": "OFFERED", "custodyState": "NONE", "version": 3,
  "supervision": {
    "terminal": false,
    "deadline": { "parameter": "dispatch.offer_ttl", "onExpiry": "WITHDRAW_EXCLUDE_REPLAN", "projected": false },
    "supervised": true,
    "owningTimer": { "timerKey": "LEG:…:OFFERED:3:WITHDRAW_EXCLUDE_REPLAN", "entityVersion": "3", "dueAt": "…" },
    "staleTimers": [], "history": [ … ]
  }
}
```

Three design points worth stating: the **owning** timer is the pending one keyed on the Leg's
*current* version — a pending timer on an older version is not supervising this state and
presenting it as the owner would tell an operator a state was supervised when it was not;
`staleTimers` is shown so that `supervised: false` distinguishes "no timer" from "a timer for a
version that has moved on"; and the endpoint **reads and never repairs**, because an operator
endpoint that could force a transition would be a command path outside the outbox and outside
the §4.4 guards.

`legId` is the business identifier — what a decision record, an offer payload and an operator's
incident notes all carry. BigInt renders as a decimal string.

### 7.2 Unchanged

No existing REST route, request shape, response shape or status code changed. No socket event
was renamed, removed or re-typed.

---

## 8. Runtime Behaviour

### 8.1 The timer lifecycle

Registration happens **inside the transition's own transaction** (`transitions.apply` does it;
callers cannot forget, because it is not a step they perform). A timer written afterwards is
lost by a crash between the two writes — an unsupervised state, the whole class of defect the
store exists to prevent — and one written before can supervise a transition that rolled back.

Firing is at-least-once. `assessFire` discards a timer whose entity version moved on, which is
what makes late firing harmless *without requiring reliable cancellation*; cancellation is
therefore a tidiness and load property, and the correctness comes from the version.

A timer **never forces** a transition. The handler attempts one, through `transitions.apply`,
under the same conditional-write discipline as any other writer — so a timer handler racing a
reconciler repair produces one winner and one no-op.

An **unregistered handler leaves the timer `PENDING`**. Resolving it would discharge a deadline
nobody acted on, which is the failure §12.1 names, rebuilt inside the mechanism designed to
remove it. It stays due, it keeps counting towards the lag SLI, and the lag SLI is what pages.

### 8.2 Lag and the degraded directive

> If the timer store falls behind by more than `supervise.max_timer_lag`, the shard enters
> degraded mode and stops issuing new HARD commitments, because it can no longer supervise them.

Lag is the **age of the oldest overdue timer**, not the count: a thousand timers one second late
is a busy shard; one timer a minute late is a shard that has stopped supervising something.
Beyond the bound, `assessLag` returns a directive with `stopNewHardening: true`, naming
`UNSUPERVISED_COMMITMENT` and the invariant it suspends (I4) — named, not entered, because
Phase 12 owns the mode register. Entering one here would be a second, undocumented register.

### 8.3 Lease renewal and the custody-aware recovery

Renewal takes §12.2's positive evidence — the commitment id **and** its fence — through Phase
3's `isRenewalEvidenceSufficient`, called rather than restated so the two definitions cannot
drift. The write is conditional on the commitment's version, so a renewal racing a recovery
loses rather than resurrecting a commitment somebody has already recovered from.

`assessRecovery` chooses **explicitly** between §4.7's outcomes and never falls through: an
unhandled combination returns `PHYSICAL_RECOVERY`, the conservative one, and says so. The
`TRANSFER` outcome requires `transferCapableReceiverAvailable === true` — unknown is not
permission, which is §4.7's own instruction (*"the engine MUST NOT select an agent-to-agent
transfer"*) applied as a positive test.

### 8.4 The reconciler

Ten scans, each idempotent, each writing a categorised repair row. Every repair is a conditional
write, so a sweep that runs twice repairs once. The reconciler **issues no command directly**:
repairs that command an agent route through modules that write their outbox row in the
authorising transaction, and the module imports no socket and no dispatcher (asserted by test).

Three behaviours worth calling out:

- **Orphans are classified.** A `PLANNED` orphan is `EXPECTED_POST_FAILOVER`; anything else is
  `DEFECT`. Counting them together would hide a defect inside an expected number.
- **Goods are never repaired automatically.** Custody held with no active mission escalates and
  changes nothing — §4.1 rule 4: *"when goods or motion are involved, escalates to a human
  rather than assuming its own record is correct."*
- **Unknown is not a divergence.** The availability-index scan reports nothing when no index
  exists to be absent from, because reporting every idle agent as a defect would make the repair
  rate meaningless before the mechanism it measures is built.

### 8.5 Verification

Each plausibility test rejects **its own** crafted failure and no other — proved by three tests
that craft one failure each and assert the other two still pass. The continuity test's two
halves report separately: a gap is a telemetry problem and goes to an operator; a speed beyond
the agent's kinematic limits is a claim it could not have performed, and sets `securityEvent`.
Collapsing them would page an operator for a lost signal and file a compromised agent as one.

An unmapped mission class defaults to **L1**, not L0 — L0 would silently accept the agent's
assertion, which is the baseline behaviour §12.5 exists to remove.

### 8.6 Settlement

`settle` **reads the manifest and the custody state and refuses**, rather than trusting that
step 2 ran. The way I7 fails in practice is not that somebody writes the steps backwards; it is
that step 2 silently does nothing — an empty manifest query returning zero rows because the
manifest was never created — and step 3 then proceeds against a custody state nobody checked.
`DISPUTED` is checked before `holdsGoods` (which answers true for it) so an operator is sent
looking for a contested handover rather than for goods aboard.

The four §4.9 steps this phase does not own are returned as a `pending` list, so a caller cannot
mistake a partial settlement for a complete one.

### 8.7 What runs today

Nothing. `ENGINE_ENABLED` is false, no worker is started from `server.js` (asserted), the two
socket feeds return immediately, and the offline sweep runs exactly as before. Phase 15 owns
turning any of it on.

---

## 9. Architecture Compliance

| Rule | Compliance |
|---|---|
| §4.1 rule 1 — every non-terminal state has an owner and a deadline | `statesWithoutDeadline()` returns `["LOADED"]` for the Leg (§4.3's own em dash) and `[]` for the Task; asserted |
| §4.1 rule 2 — every transition is a conditional write | `transitions.apply`, `settlement.settle`, `cancellation.*`, `reassignment.reassign`, `leases.renew` all `updateMany` on the observed version and report `LOST_RACE` on a miss |
| §4.1 rule 3 — state is never inferred from absence | Guards with no evidence fail `*_INDETERMINATE`; unmeasurable route progress is a signal; an unreadable custody state is not discharge; an absent obstruction class is `INDETERMINATE` |
| §4.1 rule 4 — physical reality outranks the database | Custody-held divergences escalate and repair nothing |
| §4.1 rule 5 — no side effect before its authorising write | The reconciler issues no command; `reassignment.reassign` writes the fence advance and its `RECALL` in one transaction |
| §4.5 — keyed on the entity's own version | `VERSION_SOURCE` maps no kind to an agent counter; `FORBIDDEN_VERSION_SOURCES` refuses one by name |
| §3.3 — cache authority | No `src/engine/supervision/` module imports the cache; asserted per file. `engine:timerlag` is advisory and lives in the worker |
| §10.6 — the store's clock | Both workers refuse to run without `readStoreTime` |
| §22.1 — no behavioural constant outside the register | Parameter gate PASS; 5 entries added; every remaining literal `@structural` with a reason |
| §1.8 rule 2 — no Tier 0/1 → Tier 2 | Tier gate PASS, 120 modules, 102 edges |
| §2.6 / I18 — no SOFT reservation persisted | The re-plan row is `durable: false` and writes nothing; asserted |
| I19 — settlement and reassignment leave `authority_epoch` alone | Both return `authorityEpochTouched: false`; asserted against the row |

### 9.1 Tier assignment

No change to `TIERS.md` was needed: T0-08 already names all five supervision modules and both
workers, T0-07 already names `lifecycle/settlement.js`, and T1-05 already names
`lifecycle/cancellation.js` and `reassignment.js`. The remaining lifecycle modules fall to the
`src/engine/` → Tier 1 default, which §1.8's convention 1 makes the conservative choice.

---

## 10. Backwards Compatibility

| Surface | Status |
|---|---|
| Legacy dispatcher | **Unchanged.** Legacy lane 22 suites / 169 tests, identical to Phase 4 |
| Existing REST routes | Unchanged; one new mount point |
| Existing socket events | Unchanged; no rename, removal or re-type |
| Existing DB rows | Unchanged; `Task.version` defaults to 0 |
| Offline sweep | Byte-for-byte previous behaviour while `ENGINE_ENABLED` is false |
| `taskRecovery.service.js` | Behaviour untouched; documentation only |
| `TASK_COMPLETE` | Legacy completion path unchanged unless the engine is on **and** an Agent, an active commitment, a Leg and a full threshold set all resolve |

---

## 11. Testing Performed

```
npm run verify
  gate: tier-dependencies    PASS — 120 module(s), 102 edges
  gate: parameter-register   PASS — 48 module(s) / 153 parameter(s)
  gate: tenets               PASS — 117 module(s)
  Test Suites: 57 passed, 57 total
  Tests:       1235 passed, 1235 total

npx jest --selectProjects legacy   → 22 suites / 169 tests (unchanged)
npx prisma validate               → valid
npx prisma migrate diff --from-empty --to-schema-datamodel  → all 3 CREATE TABLE stanzas byte-identical
```

### 11.1 The plan's stated testing requirements

| Requirement | Where | Verdict |
|---|---|---|
| Every non-terminal state registers a timer on entry and cancels atomically on exit (I4) | `supervisionTimers` (machine level) + `lifecycleTransitions` (transition level) | ✅ checked twice, deliberately — the first can hold while the second fails |
| A timer whose entity version moved on is discarded on fire | `supervisionTimers`, `supervisionWorkers` | ✅ including the handler never running |
| Lease renewal requires commitment-scoped evidence, not a generic ping | `supervisionReconciler` | ✅ 4 refusal cases |
| Model check: every non-terminal state eventually leaves | `lifecycleTransitions` — exhaustive reachability over §4.4 | ✅ |
| Model check: custody never lost | `lifecycleTransitions` | ✅ over §2.5's machine |
| Chaos: kill the timer worker mid-sweep; assert no missed transition after restart | `supervisionWorkers` | ✅ plus the two-worker resolution race |
| Each plausibility test rejects its own crafted failure and no other | `supervisionReconciler` | ✅ three crafted failures, each isolated |

### 11.2 What the suite does not cover

Stated plainly rather than implied by omission:

- **No migration has been applied to a live PostgreSQL instance.** This is the fifth consecutive
  phase carrying that recommendation forward (§14 item 6). Every schema claim here is a claim
  about SQL that has been generated, byte-diffed and reviewed — not one that has been executed.
- The store model is not PostgreSQL. It models `SELECT … FOR UPDATE` and the CHECK constraints;
  it does not implement predicate locking.
- The §24.2 model check is exhaustive reachability over a finite table, not TLA+. The part that
  needed a model checker — concurrency — is Phase 3's `formal/commitment.tla`.

---

## 12. Self-Verification Results

| Completion criterion | Status | Evidence |
|---|---|---|
| Every §4.2/§4.3 deadline has a durable timer | ✅ | `statesWithoutDeadline()` = `["LOADED"]` (§4.3's own gap) and `[]`; `transitions.apply` throws if a target state's deadline is unresolved |
| Reconciler repairs all §12.4 divergences and counts each | ✅ | **Ten**, not nine (§14 item 1); `Object.keys(DIVERGENCE).length === 10`; each writes a categorised row |
| Repair rate is an alertable SLI | ✅ | `readRepairRate` per category over a window; emitted every sweep; every category present even at zero, so a rate that *stopped* being reported is distinguishable from one that is zero |
| Completion verification graded L0–L3 with stated thresholds | ✅ | Four levels, cumulative; thresholds resolved from the register, never defaulted |
| Settlement enforces custody-release-before-commitment-release (I7) | ✅ | `assertCustodyDischarged` checked, not assumed; over the manifest as well as the flag |
| I3 verifiable | ✅ | `reconciler.auditI3` |
| I4 verifiable | ✅ | `timers.findUnsupervised`, reported separately from the repair count |
| I7 verifiable | ✅ | `settlement.auditI7` |
| I8 verifiable | ✅ | The custody audit; `assessRecovery`'s DISPUTED handling |
| I12 verifiable | ✅ | Terminal states refuse modification in `settle`, `requestCancellation`, and `find` |
| I13 verifiable | ⚠️ **partially** | The queue-age audit is here (`scanWaitingTasks`); the ladder it is measured against is §17.4's, which is Phase 8's T1-04. See §13 |
| Architecture unchanged | ✅ | No specification file edited |
| No Phase 6 functionality | ✅ | 0 runtime modules under `feasibility/`, `energy/`, `payload/`, `candidates/`, `solve/`, `plan/`, `routing/` |
| No regressions | ✅ | Legacy lane identical; 1,235/1,235 |
| Migrations valid | ✅ | `prisma validate`; byte-diff against generated SQL |
| APIs compatible | ✅ | §10 |

---

## 13. Known Limitations

1. **I13 is half-implemented, and that is the plan's sequencing, not an omission.** §17.4's
   escalation ladder is T1-04 and belongs to Phase 8. Phase 5 registers the `QUEUED` and
   `WAITING` timers whose expiry invokes it, and audits queue age; the ladder *step* the audit
   compares against does not exist yet. `LADDER_STEP_AVAILABLE` is a declared guard with no
   evidence supplier, so it fails `INDETERMINATE` — visibly, rather than passing vacuously.
2. **Progress supervision measures one signal from the telemetry stream.** Rows 2, 3 and 5 of
   §12.3 need the committed plan (a projected ETA, a predicted Wh figure, a route corridor),
   which the legacy telemetry path does not hold. The assessors are complete and tested; the
   *feed* covers stall detection only, and says so in the module rather than presenting partial
   coverage as whole.
3. **Timer handlers are injected and none is registered in production.** The worker refuses to
   fire an unregistered handler. Registration belongs to the Phase 15 bootstrap, alongside
   resolving the parameters from the Config Service.
4. **Reassignment's aging credit and incumbent cooloff are returned, not written.** §8.7 prices
   aging (Phase 8) and Phase 9's index consumes the exclusion. Writing them somewhere neither
   reads would be a record nobody honours — the treatment `offers.applyReject` established.
5. **The energy divergence scan compares figures it is given.** Phase 7 owns the model; a
   reconciler that estimated energy would be a second one.
6. **`GET /api/legs/:legId/supervision` shows Leg timers only.** Task and commitment timers are
   in the same store and readable; no operator surface was specified for them, and inventing one
   would be beyond the plan's stated route.

---

## 14. Outstanding Non-Blocking Observations

| # | Observation | Severity | Recommendation |
|---|---|---|---|
| 1 | **§12.4 tabulates ten divergence classes; the plan says nine.** The tenth ("Energy accounting inconsistent with telemetry") is a full row with a detection, a repair and an escalation condition | Low — resolved by the plan's own precedence rule | All ten implemented, counted, and admitted by the CHECK. Recorded in the migration and in `reconciler.js`. **The plan should be corrected**; the architecture should not |
| 2 | **§4.3 gives `LOADED` no deadline.** It is the only non-terminal Leg state with none | Low — believed deliberate | Reported rather than invented: an agent holding goods and moving is supervised by the next state's deadline and by the lease, and a deadline on custody itself would express "you have held these goods too long", which is an operations question and not a transition. Confirm with the architecture owner |
| 3 | **The plan's Phase 5 migration list names no column, but §4.1 rule 2 requires `Task.version`** | Low — resolved by precedence | Implemented; documented in the schema and the migration |
| 4 | **`tests/engine/helpers/dispatchFixture.js` generates colliding Leg ids.** `seed({ legs: 3 })` derives ids by replacing the last character of `LEG_ROW_ID`, so index 2 collides with index 0 and the store holds two rows for a three-Leg fixture | Low — test infrastructure, pre-dates this phase | Phase 5's tests use `legs: 2` and document why. Fix the generator before a phase needs three distinct Legs (Phase 10's round will) |
| 5 | **The Phase 4 verification's non-blocking items 3 and 5 remain open.** `escalation.backoffSeconds` is still computed and logged rather than pacing redelivery; `PHASE_0_INDEPENDENT_VERIFICATION.md` still does not exist | Low | Item 4 (`OUTBOX_STATE.FAILED` never assigned) **is now resolved** — §0.2. Items 3 and 5 are unchanged and out of Phase 5's scope |
| 6 | **No migration in this programme has been applied to a live PostgreSQL instance.** Fifth consecutive phase | **Elevated (inherited)** | Discharge before Phase 6. Phase 5's migration is the first to add a `BIGINT` column that application code compares as `BigInt`, and the first whose CHECK list must stay in step with a runtime enum (`ReconcilerRepair_category_known` ↔ `DIVERGENCE`) — both are cheap to verify against a real instance and expensive to discover in production |
| 7 | **`transitions.js` (Tier 1) is imported by nothing in Tier 0 yet.** The supervision modules assess and the workers fire, but the handler map that would connect a fired timer to `transitions.apply` is Phase 15's bootstrap | Low — by design | Verify at Phase 15 that every `onExpiry` action in `legMachine.LEG_DEADLINES` and `taskMachine.TASK_DEADLINES` has a registered handler. The worker's refusal to fire an unregistered one makes the gap loud, but it is a runtime signal rather than a build gate |

---

## 15. Readiness for Independent Verification

| Item | Status |
|---|---|
| Phase 5's dependencies | Phases 3 and 4 — both satisfied, **and Phase 4's two blocking issues corrected and re-verified** (§0) |
| Blocking decisions | **B4 (durable timer store technology)** — resolved as PostgreSQL, DB-authoritative, per §3.3's assignment of the timer store to the Commitment Store tier; no new technology introduced. **B6 (map obstruction classification source)** — *not* resolved. `legMachine.strandingStateFor` consumes a classification and derives the state; the Map service that supplies it is §5.2's and its integration is Phase 12's (T0-10). The `INDETERMINATE` default means an unresolved B6 is safe rather than silent: every stranding classifies as `STRANDED_OBSTRUCTING` until a source exists |
| What Phase 6 gets | A Leg state machine with an enumerated deadline per state; a transition table with declared guards whose evidence Phase 6's predicates will supply; a reconciler with a per-category repair rate to gate on; a timer store the feasibility cache's invalidation can hang from |
| What a verifier should attack first | (a) the timer keying — try to construct a path that registers a timer on an agent-scope counter; (b) `transitions.apply`'s atomicity — a crash between the conditional write and the timer registration; (c) the reconciler's idempotence under a concurrent timer handler; (d) whether any of the three plausibility tests can be made to reject a failure it does not own |
| Guardrails met | Tier gate, parameter gate, tenet gate, the widened engine-tree ownership assertion, and the narrowed schema assertion |
| **Strongly recommended first** | §14 item 6, for the fifth time. This phase's migration is the first with a runtime enum that a CHECK constraint must track |

---

**Phase 5 is complete. Phase 6 has not been started and will not be started without
independent verification of this phase.**
