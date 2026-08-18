# Phase 4 — Remediation, Re-verification and Closure

**Date:** 2026-08-17 · **Branch:** `feature/dashboard` · **Working tree at closure:** `63f5c58` + uncommitted
**Role:** Principal distributed-systems / reliability / independent verification engineer
**Authority order:** `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` (FROZEN) → `IMPLEMENTATION_EXECUTION_PLAN.md` → the repository → `PHASE_4_INDEPENDENT_VERIFICATION.md` → `PHASE_4_IMPLEMENTATION_REPORT.md`

This document does not replace the two Phase 4 documents. It sits on top of them and records
what was reproduced, what was already fixed, what was fixed here, and what remains open.
**Neither original document has been edited to remove a finding.**

---

## 1. Final status

# PHASE 4 CLOSED

Both blocking findings are resolved and independently re-verified. Every non-blocking issue is
either fixed or explicitly recorded with its owner. Phase 4's migration has now been executed
against a real PostgreSQL instance and its constraints exercised — discharging the gap four
consecutive phases carried forward.

### A correction to the premise this remediation started from

The remediation brief assumed both blocking findings were open. **They were not.** Findings 1 and 2
and non-blocking issue 4 were remediated in commit `cf9103f` (2026-08-03) — the same day the
verification was written — and the two Phase 4 documents were never updated to say so. Phases 1–5
all landed in that single commit, so the defective code the verification reviewed was never
committed and cannot be recovered from git.

That is a documentation failure, not an engineering one, and it is the reason this exercise began
by reproducing rather than by fixing. The verification's `FAIL` verdict has been the repository's
standing statement about Phase 4 for two weeks while the code had already moved on.

**What this exercise actually contributed:** independent reproduction of every finding against the
current code; proof that the shipped fixes are load-bearing rather than incidental; the fix for the
one blocking-adjacent defect that genuinely remained open (issue 3, retry backoff); four new
concurrency regression tests including a 200-iteration randomised search; and the first live-database
verification of Phase 4's schema.

---

## 2. Files changed

Phase 3 work already in the tree (`commit.js`, `adminBootstrap.service.js`, `commitmentModel*.js`,
`commitmentTransaction.test.js`, `AppProvider.jsx`, the Phase 3 documents, `formal/README.md`,
`tools/verify/phase3LiveDatabase.js`) was **not touched**.

| File | Why | Scope | Spec requirement | Finding | Regression test |
|---|---|---|---|---|---|
| `Backend/src/engine/dispatch/escalation.js` | Added `jitterFractionFor`, `retryDueAt`, `isRetryDue` — the schedule `backoffSeconds` computes, expressed as a decision the claim path can act on | Phase 4 (§11.3, T0-09) | §11.3 "Retries use bounded exponential backoff with jitter" | Issue 3 | `dispatchEscalation.test.js` — "the backoff actually paces retries (§11.3)", 5 tests |
| `Backend/src/engine/dispatch/outbox.js` | `claim` accepts an `isRetryDue` predicate and over-reads its candidate window so deferred rows cannot starve ready ones | Phase 4 (§11.1/§11.3, T0-09) | §11.3 | Issue 3 | `dispatchEscalation.test.js` — "a backlog of backing-off rows does not starve a fresh command behind it" |
| `Backend/src/workers/outbox.worker.js` | Supplies the pacing predicate to `claim`; reports the *jittered* backoff and the due instant, so the logged schedule and the enforced schedule are one number | Phase 4 (§11.3) | §11.3 | Issue 3 | as above, plus live group 5 |
| `Backend/tests/engine/helpers/commitmentStore.js` | The store model now maintains `updatedAt` on create/update/updateMany/upsert, as PostgreSQL does | Phase 4 test infrastructure | — | Issue 3 | without it the backoff filter passes vacuously and reports green for a schedule it never applies |
| `Backend/tests/engine/dispatchEscalation.test.js` | 6 new tests; 1 existing test corrected (it asserted the pre-§11.3 hot-loop) | Phase 4 tests | §11.3 | Issue 3 | — |
| `Backend/tests/engine/dispatchAgentProtocol.test.js` | 3 new tests: two overlap scenarios the brief required and the shipped suite lacked, plus a 200-iteration seeded interleaving search | Phase 4 tests | §11.5, §10.3.1, I21 | Finding 1 | — |
| `Backend/tools/verify/phase4LiveDatabase.js` | **New.** 55 checks driving the shipped Phase 4 code against real PostgreSQL | Phase 4 verification | §11 | Issue 6 | — |
| `README.md` | Records that Phase 0 was never independently verified | Programme documentation | — | Issue 5 | — |
| `PHASE_4_REMEDIATION_AND_CLOSURE.md` | **New.** This document | Programme documentation | — | all | — |

**No frozen specification was modified. No gate was weakened. No test was deleted, skipped or
re-baselined.** One test was corrected: `dispatchEscalation.test.js`'s "an offline agent leaves the
row PENDING for the next pass" asserted that the immediately following drain pass re-delivers. That
assertion *encoded* issue 3 — it is precisely the hot loop §11.3 forbids. It now asserts both halves
of the specified behaviour: the immediate pass does not retry, and the pass after the backoff does.

---

## 3. Finding disposition

### Finding 1 — stale revert in `VirtualRobot.js` erases a concurrently applied command · **HIGH, blocking** → **FIXED (was already fixed; now independently proven load-bearing)**

**Root cause.** `_onMissionCommand` / `_onAgentCommand` mutated `this.dedup` synchronously, awaited a
durable write, and on failure restored a snapshot captured at the *start of that call* — blind to a
second command that had succeeded and persisted inside that await.

**Fix, as shipped.** Two mechanisms, and they are complementary rather than redundant:

1. **`_withDedupLock` — a promise-chain mutex over the whole dedup state.** Not per commitment id:
   §10.3.1's interaction rule has an agent-scope command discard the entire per-commitment table, so
   an agent command and a mission command that overlap are two writers of one object. The lock's
   scope is the honest scope of the critical section. `then(fn, fn)` runs the next section whether
   the previous settled or rejected, so one command's failure cannot wedge the chain.
2. **Compare-and-restore inside the revert.** The lock excludes another *command*, but
   `adoptDedupAcknowledgement` is synchronous and unlocked by design (§11.5's AUTH path must leave
   no window in which handlers are live under a superseded authority), so a session handshake can
   still land inside the await. The revert therefore restores only if the current value is still
   the one this call wrote.

**The concurrency invariant, precisely.** Let *S* be the dedup state and let each handler be the
sequence *read(S) → decide → write(S) → persist → (effect ∨ revert)*. The defect was that
`write` and `revert` were not atomic with respect to another handler's `write`: with two handlers
*A*, *B* interleaved as `write_A → write_B → persist_B(ok) → persist_A(fail) → revert_A`,
`revert_A` restored *S* to its value before `write_A`, discarding `write_B` — even though *B*'s
effect had already been observed and *B*'s state durably written. The mutex makes the whole
sequence a critical section, so for any two handlers either *A* ≺ *B* or *B* ≺ *A* entirely; a
revert can then only ever undo the most recent write, which is its own. The compare-and-restore
closes the one writer the mutex does not cover.

**Independent reproduction.** A reproduction script was rebuilt from the verification's Part 3.1
description and run against (a) a variant with the lock neutralised and the unconditional revert
restored — the code the verification quoted — and (b) the current shipped class.

```
(a) PRE-FIX variant
    resultA (OFFER  f5 s0): { applied: false, reason: 'DEDUP_STATE_NOT_DURABLE' }
    resultB (REROUTE f7 s1): { applied: true, reason: null }
    in-memory mark for C1 after both settle: undefined
    durable store now: {"highWaterMarks":{"C1":{"fence":"7","sequence":1}} …}
    observable effects per command identity:
      REROUTE@C1/f7/s1: 2          ← applied twice
      OFFER@C1/f5/s0: 1
    I21 VERDICT: VIOLATED
      - a successfully applied command's durable state was erased by another command's failed persist
      - command identity REROUTE@C1/f7/s1 produced its observable effect 2 times

(b) CURRENT SHIPPED CODE
    resultA (OFFER  f5 s0): { applied: false, reason: 'DEDUP_STATE_NOT_DURABLE' }
    resultB (REROUTE f7 s1): { applied: false, reason: 'HELD_FOR_ORDER' }
    observable effects per command identity:
      OFFER@C1/f5/s0: 1
      REROUTE@C1/f7/s1: 1
    I21 VERDICT: HELD
```

The pre-fix run is *worse* than the verification recorded: it reproduces the stale re-admission the
report described **and** a straightforward double application of `REROUTE`.

Under the fix, *B* is `HELD_FOR_ORDER` rather than applied — which is correct, not a regression:
*A* never applied, so *B* at sequence 1 has a gap below it, and §11.3 requires the agent to hold
rather than skip. Each command is subsequently applied exactly once on redelivery.

**Regression tests.** Two shipped (added with the fix) and three added here. All five fail against
the pre-fix variant and pass against the current code:

```
pre-fix variant:  Tests: 4 failed, 32 passed, 36 total
current code:     Tests: 36 passed, 36 total
```

| Test | Scenario the brief required |
|---|---|
| "two mission commands in flight for one commitment id never acknowledge more than was persisted (I21)" | same commitment |
| "a failed agent command cannot roll back a mission command that overlapped it" | mixed mission + agent |
| **"a failed command for one commitment cannot erase another commitment's applied state"** *(new)* | different commitments, same agent |
| **"two overlapping agent-scope commands leave the agent under exactly one authority"** *(new)* | two agent-scoped commands |
| **"200 seeded interleavings never double-apply a command and never divide belief from proof"** *(new)* | §8's stress requirement |

**Final status: FIXED and independently re-verified.**

---

### Finding 2 — escalation step 2 has zero production callers · **HIGH, blocking** → **FIXED (was already fixed; now verified end-to-end against live PostgreSQL)**

**Reproduced as resolved.** The verification's own command now returns a production caller:

```
$ grep -rn "withdrawExpiredOffer" src/ tests/
src/engine/dispatch/offers.js:469          ← definition
src/workers/outbox.worker.js:296           ← PRODUCTION CALLER
src/workers/outbox.worker.js:326           ← its explanatory comment
tests/engine/dispatchOffers.test.js:405,472
```

**The production call graph, traced end to end:**

```
drainOnce
  └─ escalateOutstanding                      (worker, per outstanding row)
       └─ escalation.assessRow → step 2       (§11.4)
            ├─ outbox.settleRow → UNACKNOWLEDGED   ← the "mark agent dispatch_unresponsive"
            │                                        of §11.4 step 2, written first and
            │                                        unconditionally so it survives a failed
            │                                        withdrawal
            └─ withdrawIfOwed
                 └─ performWithdrawal          ← ONE transaction
                      ├─ offers.withdrawExpiredOffer
                      │    ├─ Agent.fenceCounter advance   (I6, strict)
                      │    ├─ outbox.enqueue(WITHDRAW)     (§4.1 rule 5 — same transaction)
                      │    ├─ Leg → QUEUED                 (conditional on version)
                      │    ├─ Commitment.releasedAt        (capacity returned)
                      │    └─ AgentFenceAudit upsert       (I6 high-water mark)
                      └─ outbox.settleRow → FAILED, "WITHDRAWN_AT_ADVANCED_FENCE"
```

**The `UNACKNOWLEDGED` visibility problem is also resolved**, and resolved better than the
verification's suggested "widen the filters everywhere". `outbox.js` now distinguishes two sets:

- `OUTSTANDING_STATES` = `PENDING, CLAIMED, DELIVERED, **UNACKNOWLEDGED**` — what the depth SLI
  counts and what §11.5's reset-path suppression covers. An unanswered offer stays visible exactly
  when it matters most.
- `DELIVERY_OBLIGATION_STATES` = `PENDING, CLAIMED, DELIVERED` — what `claim` and
  `expirePastValidity` operate on. `UNACKNOWLEDGED` is deliberately absent: expiring it on
  `not_valid_after` would discharge the bookkeeping while leaving the commitment held — a row that
  looks finished and an agent that was never told.

This answers the brief's six questions for a widened filter: `UNACKNOWLEDGED` is included because
the obligation is undischarged; it stops being included when step 2's withdrawal moves it to
`FAILED`; infinite redelivery is prevented because it is *not* in the delivery set; premature
suppression is prevented because the mark is written before the withdrawal is attempted; after
restart the next pass finds it again via `assessRow`; after escalation it is terminal.

**Live evidence** (group 6 of the live harness, real PostgreSQL, real transactions):

```
PASS  the ladder reached step 2 and performed a withdrawal
PASS  the commitment is released — the capacity slot is returned
PASS  the Leg returned to QUEUED for the next round to re-plan
PASS  the agent's fence counter strictly advanced (invariant I6)     41 → 42
PASS  a WITHDRAW was dispatched through the outbox, at the advanced fence
PASS  the unanswered OFFER is terminal as FAILED, carrying the completion marker
PASS  and it still counts as the agent's step-3 mark — the action did not erase its own evidence
PASS  the SLI counted the unanswered offer while outstanding, and stopped counting once withdrawn
PASS  a second escalation pass does not withdraw twice, nor advance the fence again
```

**Transactional integrity** (group 7 — the brief's §11 requirement that the step-2 action cannot
partially succeed). A seam that fails *after* the shipped withdrawal has done all its work:

```
PASS  the failed withdrawal is reported, not counted as done
PASS  no fence was advanced                                   41 → 41
PASS  the commitment was not released
PASS  the Leg did not move                                    still OFFERED
PASS  no WITHDRAW escaped into the outbox
PASS  the offer stays UNACKNOWLEDGED — outstanding, counted, and retried next pass
PASS  the next pass performs the withdrawal that failed — retried, never absorbed (§11.3)
```

**Final status: FIXED and independently re-verified against live PostgreSQL.**

---

### Issue 3 — `backoffSeconds` computed and logged but never consulted · Low-moderate → **FIXED HERE (this was genuinely open)**

**Confirmed still open at `63f5c58`.** `outbox.claim` selected every `PENDING` row on every pass
regardless of `attempts`; `backoffSeconds` was read only by the telemetry sink. The actual retry
cadence was `setInterval(tick, intervalMs)` — constant, unjittered, and identical across every
worker and every row in the fleet. §11.3 says "Retries use bounded exponential backoff with jitter",
so this is a genuine semantic gap, not a naming question, and the brief's alternative (justify it as
a reported schedule) is not available against that sentence.

**Fix.**

- `escalation.retryDueAt({ row, retryWindowSeconds })` → the instant an already-attempted row
  becomes eligible: `updatedAt + backoffSeconds(attempts, jitter)`. A row with `attempts === 0` is
  due immediately — backoff paces *retries*, and delaying first delivery would add latency to the
  healthy path to solve a problem only the unhealthy path has.
- **The last-attempt instant is `Outbox.updatedAt`**, not a new column. A row sitting in `PENDING`
  with `attempts > 0` was last written by `recordAttempt`'s undelivered branch; every other
  transition moves it out of `PENDING`. This was chosen over adding a `nextAttemptAt` column
  because that column would have to appear in the `Outbox` `CREATE TABLE` that
  `dispatchSchema.test.js` asserts byte-identical against Prisma's own generated SQL — so it would
  have forced a later `ALTER TABLE` and a dilution of a drift check that has real value. The
  trade-off is that the predicate is evaluated in the worker rather than in the index; see
  "Remaining limitations".
- **Jitter is derived from the row id** (`jitterFractionFor`, FNV-1a → `[0,1)`), not drawn from a
  random source. Distinct rows decorrelate — which is the entire purpose of jitter — while one row
  yields the same fraction on every pass, in every worker, after every restart. A redrawn fraction
  would make `retryDueAt` non-monotonic (due, then not due, then due), which is worse than no
  jitter, and would break T6 replay determinism.
- **`claim` over-reads its candidate window** (`CANDIDATE_WINDOW_MULTIPLE = 4`). Candidates arrive
  oldest-first and the oldest rows are exactly the ones most likely to be inside a backoff interval,
  so a window equal to the batch size would let a cohort of backing-off rows sit at the head of the
  queue and starve never-attempted rows behind them — converting one agent's outage into a
  fleet-wide delivery stall.
- **The telemetry now reports the jittered value and the due instant**, so the logged schedule and
  the enforced schedule are one number rather than two that can disagree.

**Regression tests.** 6 new tests. Verified load-bearing by disabling the wiring:

```
pacing disabled:  Tests: 2 failed, 43 passed, 45 total
pacing enabled:   Tests: 45 passed, 45 total
```

Plus live group 5, which proves the mechanism against the `updatedAt` PostgreSQL itself maintains:

```
PASS  a failed attempt returns the row to PENDING with the attempt counted
PASS  PostgreSQL maintained updatedAt on the updateMany the attempt record performed
PASS  the row's next attempt is scheduled in the future, not immediately
PASS  the pass that follows immediately does not retry — the backoff is enforced, not logged
PASS  the pass after the backoff has elapsed does retry — the row is paced, not abandoned
```

**Final status: FIXED.**

---

### Issue 4 — `OUTBOX_STATE.FAILED` declared but never assigned · Moderate → **FIXED (was already fixed)**

`FAILED` is now assigned at five sites in `outbox.worker.js`, and the verification's own grep
confirms it. The lifecycle the brief asked to be pinned down:

| Question | Answer |
|---|---|
| When does a row become `FAILED`? | When step 2's withdrawal completes (`WITHDRAWN_AT_ADVANCED_FENCE`), or when the obligation is moot: commitment already released, Leg superseded, agent missing, or the row is an unanswered non-`OFFER` for which no withdrawal applies |
| What makes it terminal? | Membership of `TERMINAL_STATES`; `settleRow` refuses to move a row out of any terminal state |
| Can it be retried? | No. It is not in `DELIVERY_OBLIGATION_STATES`, so `claim` never sees it |
| Does it remain visible to SLIs? | Not to depth — the obligation is discharged. It remains visible to step 3 via `isMarkedUnresponsive`, which reads `FAILED` + the completion marker as the agent's `dispatch_unresponsive` evidence, so a successful withdrawal does not erase the evidence step 3 counts |
| Can it be redelivered? | No |
| Can a new obligation replace it? | Yes — the `WITHDRAW` enqueued in the same transaction is that obligation |

Live-verified: `PASS the unanswered OFFER is terminal as FAILED, carrying the completion marker`
and `PASS it still counts as the agent's step-3 mark`.

**Final status: FIXED.**

---

### Issue 5 — `PHASE_0_INDEPENDENT_VERIFICATION.md` does not exist · Low → **DOCUMENTATION CORRECTED**

Confirmed absent. Phases 1–15 each have both documents; Phase 0 has only its implementation report.

**Not fabricated.** Writing a retrospective "independent verification" of a phase whose working tree
no longer exists would produce an artefact indistinguishable from evidence while containing none.
The gap is now recorded in `README.md`'s document index and in a note beneath it, stating plainly
that Phase 0's report is an implementer's claim no independent reviewer has checked, and noting what
*is* continuously exercised: Phase 0's tests run in every later suite, and the gates it introduced
govern 183–277 modules on every `npm run verify`.

**Final status: DOCUMENTATION CORRECTED. The underlying gap is real and remains open by design.**

---

### Issue 6 — no migration executed against live PostgreSQL · Elevated (inherited) → **DISCHARGED for Phase 4**

A disposable PostgreSQL **18.3** cluster was built from the installed binaries on port **55432**.
The user's own cluster on 5432, and the shared Neon instance in `DATABASE_URL`, were never
contacted.

All **21 migrations** applied cleanly in directory order, Phase 4's included:

```
OK   20260729120000_commitment_core
OK   20260730090000_dispatch_and_agent_protocol      ← Phase 4
OK   20260803210000_supervision_and_reconciliation
… 21/21 applied, zero errors
```

`Backend/tools/verify/phase4LiveDatabase.js` (new, modelled on Phase 3's harness) then drove the
**shipped** modules against that instance: **55/55 checks passed.** See §8.

**Final status: DISCHARGED for Phase 4.** The programme-wide recommendation stands for phases 5–15,
which have not had the same treatment.

---

## 4. Outbox verification

| Property | Result | Evidence |
|---|---|---|
| Transaction enforcement | **PASS** | Live group 3: a failing authorising transaction leaves no obligation; a committed one leaves exactly one; `enqueue` refuses the base client with a `TypeError` |
| Idempotency | **PASS** | The replayed command derives the same key and observes its own prior row; the live unique index refuses a second row for one authority |
| Claim behaviour | **PASS** | Live group 4: three concurrent workers, exactly one winner — a race a single-threaded JS model cannot lose |
| Stale claim handling | **PASS** | Lease expiry makes the row reclaimable; the displaced worker's `recordAttempt` matches 0 rows and is discarded |
| Retry | **PASS** | Now paced by §11.3's schedule (issue 3); retry passes through `claim`, so it cannot bypass fencing, ordering or dedup — the envelope is rebuilt from the row and re-judged by the agent |
| Delivery failure | **PASS** | A thrown transport error is an undelivered attempt with a recorded cause, never swallowed |
| Escalation | **PASS** | §5 below |
| Expiry | **PASS** | A row past `not_valid_after` is expired before it reaches the transport; the sweep runs last so step 2 is reachable |

**The gate — "no command reaches an agent except from an outbox row written in its authorising
transaction" — holds.** `enqueue` and `suppressOutstandingForAgent` both refuse a non-transaction
client structurally; `deliverOutboxCommand` is the only function emitting a §10.3.1 command name;
no legacy helper carries one.

---

## 5. Escalation verification

| Step | Status | Evidence |
|---|---|---|
| 1 — retry with backoff | **Operational, and now actually paced** | `assessRow` reaches step 1 on no delivery within `dispatch.retry_window`; the retry cadence is `retryDueAt` (issue 3) |
| 2 — withdraw, release, mark unresponsive, re-plan | **Operational** | Production caller in `outbox.worker.js:296`; the full transaction verified live (§3, Finding 2) |
| 3 — availability-index removal | **Assessed and recorded as a directive; owner named (Phase 9)** | `assessAgent` correct at the boundary; "consecutive" broken by a single ACK |
| 4 — systemic threshold | **Assessed and recorded as a directive; owner named (Phase 12)** | `assessShard`; `fraction > threshold`, not `≥`; an empty shard is `EMPTY_SHARD`, not systemic |

Steps 3 and 4 remain deliberately non-acting. That is unchanged from the original report and is
correctly disclosed there: building an availability index or a degraded-mode register inside the
dispatch worker would be building a second one. **The distinction the verification objected to —
step 2 claimed as "acted on" while its substantive action was absent — no longer exists.**

**SLI behaviour.** `readSli` returns `depth`, `oldestUndeliveredAgeSeconds` and a separate
`unacknowledged` count. An offer that fails the ladder stays counted until its withdrawal lands.
**Dedup behaviour.** `suppressOutstandingForAgent` covers `UNACKNOWLEDGED`, so §11.5's reset path
suppresses every outstanding obligation as specified.

---

## 6. Dedup / I21 verification

I21, stated as the property rather than as a test name: *for any command identity, the observable
effect occurs at most once — under retry, restart, persistence failure, overlapping in-flight
operations, stale delivery, or dedup-state recovery.*

| Scenario | Result |
|---|---|
| Sequential duplicate | **PASS** — rejected at `fence ≤ highest_seen[commitment_id]` |
| Concurrent duplicate / overlapping commands | **PASS** — 5 regression tests; all fail against the pre-fix variant |
| Persistence failure | **PASS** — no effect, no ACK, state reverted only if still ours |
| Restart / power cycle | **PASS** — dedup state lost → generation advances → AUTH reports it → server suppresses outstanding rows |
| Dedup generation | **PASS** — `classify()` covers all three named rows plus "no stored generation"; a generation that went *backwards* is treated as a reset |
| Stale redelivery | **PASS** — the reproduction script's stale fence-5 `OFFER` is rejected on the fixed code |
| Stress | **PASS** — 200 seeded interleavings, mixed mission/agent scopes, chaotic persistence (40% failure, 0–2 macrotask stalls), each command issued twice; zero double applications, zero divergence between believed and persisted state |
| Zero double-application | **HELD** |

**A fixture defect found and fixed by the stress search.** The first run reported double
applications. Investigation showed the cause was the *fixture*, not the code: it gave an agent-scope
command a `fence_floor` of 4 while missions ran at fences 5–7. §10.3.1's interaction rule has an
agent command discard the per-commitment table and substitute the floor — so a floor below an
outstanding fence clears a mark the floor then fails to replace, and a redelivered stale `OFFER` is
correctly admitted. **No Phase 4 code path can construct that state**: `fencing.fenceFloorFor` reads
the floor from `agent.fenceCounter`, the monotonic counter every one of those fences was drawn from.
The test now pins that precondition with an explicit assertion so it cannot silently drift back.

---

## 7. Command integrity

| Property | Result |
|---|---|
| Signed field set | **PASS** — all eleven `SIGNED_FIELDS`; §23.3's set exactly |
| Canonical serialization | **PASS** — independent of key order; a BigInt fence and its decimal string sign identically |
| Signature verification | **PASS** — `timingSafeEqual`, not `===`; never throws on malformed input |
| Tamper detection | **PASS** — changing any signed field invalidates the signature |
| Key length | **PASS** — a 31-byte key is refused; 32 accepted |
| Expiry | **PASS** — `not_valid_after` enforced at the agent, at `claim`, and again at `assessDeliverability` |
| Fence / sequence / scope validation | **PASS** — mission at `≤`, agent at `<`; the asymmetry is §10.3.1's and is preserved |
| Ordering | **PASS** — `RECALL` never before its `OFFER`; a gap **holds** rather than skipping (`HELD_FOR_ORDER`), independently observed in the reproduction script |
| Queries | **PASS** — unfenced, no dedup write, always answered |

---

## 8. Database verification

**Instance:** disposable PostgreSQL 18.3, port 55432, database `robotx_p4`. Production and the
shared Neon instance untouched.

```
migrations applied            21 / 21, zero errors
npx prisma validate           The schema at prisma\schema.prisma is valid 🚀
live harness                  55 / 55 checks passed
```

| Group | Checks | Result |
|---|---|---|
| 1 — schema objects from PostgreSQL's own catalogue | 13 | PASS |
| 2 — every CHECK / unique / FK exercised with a row it must refuse | 11 | PASS |
| 3 — §4.1 rule 5, against a real transaction | 6 | PASS |
| 4 — claim atomicity under a real race | 4 | PASS |
| 5 — §11.3 backoff against a real `updatedAt` | 5 | PASS |
| 6 — §11.4 step 2 end to end | 9 | PASS |
| 7 — withdrawal atomicity under failure | 7 | PASS |

**The FK the report flagged as the migration's novel risk** —
`Outbox.commitmentId → Commitment.commitmentId`, the schema's first foreign key to a
non-primary-key unique column — exists in the live catalogue, refuses a row naming a
non-existent commitment, and genuinely restricts deletes:

```
ERROR 23001: update or delete on table "Commitment" violates RESTRICT setting of
foreign key constraint "Outbox_commitmentId_fkey" on table "Outbox"
```

**All five hand-written CHECK constraints bite.** Each was exercised with a row it must refuse and
each returned `23514` naming itself: `Outbox_state_known`, `Outbox_command_class_known`,
`Outbox_sequence_non_negative`, `Outbox_fence_scope_columns` (twice — a mission row without a
fence, and an agent row naming a commitment), `AgentDedupState_counters_non_negative`.

**BigInt marshalling.** A fence of `9007199254740993` (2^53 + 1) round-trips through the Prisma
driver exactly — the value a Number-typed column would silently corrupt.

**Destructive-operation scan.** The Phase 4 migration contains no `DROP`, `TRUNCATE`, `DELETE`,
`RENAME` or `ALTER COLUMN`; its only `ALTER TABLE` statements are the five `ADD CONSTRAINT` CHECKs on
its own two new tables. Asserted by `dispatchSchema.test.js` and re-confirmed by reading the file.
The programme is **forward-only**; no rollback evidence is claimed, because no down-migration exists.

**Drift.** `prisma migrate diff --from-url <live> --to-schema-datamodel prisma/schema.prisma`
returns exactly one statement, and it is **not** in Phase 4's scope:

```sql
-- DropForeignKey
ALTER TABLE "ConfigActiveVersion" DROP CONSTRAINT "ConfigActiveVersion_version_fkey";
```

This is a hand-written FK added by the Phase 0/1 config-registry migration
(`20260728093000_config_registry_and_governance:174`) that `schema.prisma` does not declare as a
Prisma relation. It is deliberate and annotated in the migration. It appears in the diff because
`prisma migrate diff` models foreign keys but ignores CHECK constraints — which is also why Phase
4's five hand-written CHECKs do *not* appear. **Phase 4's two tables produce zero drift.** Recorded
here so a future reader running the same command knows why the line is there; it is a pre-existing
observation, not a Phase 4 defect, and it was not "fixed" because declaring or dropping it is a
Phase 0/1 decision.

---

## 9. Test results

**Baseline before any change** (`63f5c58`, whole repository):

```
npm run verify        7 gates PASS · 145 suites · 6378 tests · 0 failures · 394.3 s
```

**After remediation:**

```
npm run verify        7 gates PASS · 145 suites · 6387 tests · 0 failures · 200.9 s   (exit 0)
```

| Gate | Result |
|---|---|
| tier-dependencies (§1.8 rule 2) | PASS — 277 modules, 386 governed edges, 0 violations |
| parameter-register (§22, Appendix A) | PASS — 183 modules, 242 registered parameters, 0 bare constants |
| tenets (T1, T6) | PASS — 274 modules, 0 violations |
| identity-isolation (§23.7) | PASS — 16 modules |
| reconstruction-equivalence over ERASED corpus | PASS — 3 decisions, byte-for-byte |
| legacy-retirement | PASS — 4 retired modules absent across 304 files |
| column-generation (§21.6) | PASS — NOT_REQUIRED |

**Lanes:**

```
npx jest --selectProjects legacy    17 suites · 126 tests · 0 failures ·  9.7 s
npm run verify (all 5 projects)    145 suites · 6387 tests · 0 failures · 200.9 s
```

The legacy lane is 17/126, not the 22/169 the Phase 4 verification recorded. That is not a
regression: Phase 15 **retired four legacy modules from the build**, which the legacy-retirement
gate asserts on every run. The count moved because the legacy surface shrank by design.

**Phase 4 suites, individually:**

| Suite | Tests | Result |
|---|---|---|
| `dispatchOutbox.test.js` | 42 | PASS |
| `dispatchEscalation.test.js` | 45 | PASS (**+6**) |
| `dispatchOffers.test.js` | 26 | PASS |
| `dispatchAgentProtocol.test.js` | 36 | PASS (**+3**) |
| `dispatchDedup.test.js` | 28 | PASS |
| `dispatchSchema.test.js` | 32 | PASS |
| `commitmentFencing.test.js` | 72 | PASS |
| `commitmentTransaction.test.js` | 45 | PASS |
| `commitmentGuards.test.js` | 31 | PASS |

**Live database:** `node tools/verify/phase4LiveDatabase.js` → **55/55 checks passed** (exit 0).

**Regression tests proven load-bearing** (each run against a deliberately reverted variant, then
restored and re-diffed byte-identical):

| Defect reverted | Result |
|---|---|
| `_withDedupLock` neutralised + unconditional revert restored | **4 failed**, 32 passed |
| `isRetryDue` wiring replaced with `() => true` | **2 failed**, 43 passed |
| neither reverted (shipped code) | **0 failed** |

---

## 10. Remaining limitations

1. **§11.3's backoff predicate is evaluated in the worker, not in the index.** `claim` over-reads
   its candidate window by 4× and filters in JavaScript, because the due instant is derived from
   `updatedAt + f(attempts)` and cannot be expressed in Prisma's filter language. At very large
   outbox depths a `nextAttemptAt` column with its own index would be the scalable form. It was not
   added here because it would have forced a dilution of `dispatchSchema.test.js`'s byte-identical
   `CREATE TABLE` drift check. **Recorded as a scaling consideration, not a correctness gap** — the
   over-read is bounded and the starvation case is tested.
2. **The drain worker does not validate its own configuration up front.** A missing
   `nackCooloffSeconds` surfaces only when a step-2 withdrawal runs, where it is caught, recorded as
   `dispatch.withdrawal_failed`, and retried forever without succeeding. Found while building the
   live harness (the harness omitted the parameter). It is loud rather than silent, and §22's
   parameter register supplies these in production — but a `requireConfig` alongside `requireDeps`
   would turn a permanently-retrying withdrawal into a wiring-time failure. **Not fixed: outside the
   findings this remediation was scoped to, and it changes a shipped module's contract.**
3. **Phases 5–15 have still never had a migration executed against live PostgreSQL.** Phase 4's is
   now discharged; the other seventeen migrations in the chain applied cleanly as a side effect of
   this exercise, but their *semantics* were not exercised the way Phase 4's were.
4. **Phase 0 was never independently verified**, and now says so in `README.md`.
5. **`ENGINE_ENABLED` remains `false` and nothing starts the outbox worker.** Everything verified
   here was exercised through `drainOnce` and through the live harness, which is the shape Phase 10's
   coordinator will drive. No claim is made about production behaviour under load.
6. **One pre-existing schema drift outside Phase 4** (`ConfigActiveVersion_version_fkey`, §8),
   recorded rather than changed.

---

## 11. Phase boundary

> **No Phase 5 functionality was implemented.**

- `git diff -- Backend/src/` scanned for `timer`, `reconcil`, `supervis`, `progress`, `settlement`,
  `verification`, `recovery worker`, `lifecycle` — **zero matches**.
- The three source files changed are `dispatch/escalation.js`, `dispatch/outbox.js` and
  `workers/outbox.worker.js`, all Phase 4 modules (T0-09 / Tier 0 by path), all changed for §11.3.
- No Phase 5 table, worker or state machine was created, imported or called. `performWithdrawal`
  returns the Leg to `QUEUED`; **re-planning it is the round's job**, and the round already handles
  any Leg in `QUEUED` — the seam is consumed, not built.
- Phase 5's own files (`timer.worker.js`, `reconciler.worker.js`, and the supervision modules) exist
  from the earlier commit and were **not touched**.

---

## 12. Final recommendation

**Phase 4 is genuinely ready for Phase 5.**

This recommendation rests on evidence gathered against the current code, not on the original
implementation report:

- Both blocking findings were independently reproduced against a reconstruction of the defective
  code, shown to be fixed in the shipped code, and the fixes shown load-bearing by reverting them
  and watching the tests fail.
- The one genuinely open defect (issue 3) is fixed, with regression tests that fail without the fix
  and live evidence that the schedule is enforced against PostgreSQL's own `updatedAt`.
- The transactional-outbox invariant, claim atomicity, escalation step 2, and withdrawal atomicity
  are all now verified against real PostgreSQL rather than against a JavaScript model — including
  the FK form and the five CHECK constraints that no static check could evaluate.
- I21 survives a 200-iteration randomised search over interleavings, not merely the sequential
  scenarios the original suite constructed.

Two caveats a reader should carry forward. First, the limitations in §10 are real, and item 2 (the
worker's unvalidated configuration) is the one most likely to bite whoever wires the Phase 10
coordinator. Second, and more important than any of the technical findings: **the Phase 4 documents
asserted a `FAIL` verdict for two weeks after the code had been fixed.** The engineering lesson the
verification drew — *do not accept existence as execution* — has a documentation counterpart that
this exercise ran straight into. A finding is not closed when the code changes; it is closed when the
record says so.
