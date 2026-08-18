> ## ⚠️ Two claims in this report were overstated — read this first
>
> This report is preserved unedited as the historical record. **Phase 4 is now CLOSED** — see
> [`PHASE_4_REMEDIATION_AND_CLOSURE.md`](PHASE_4_REMEDIATION_AND_CLOSURE.md) (2026-08-17) — but two
> of its claims were not true when written, and a reader should not take them at face value:
>
> 1. **"Escalation ladder steps 1–4 operational"** drew a distinction between steps 1–2 ("acted on")
>    and steps 3–4 ("assessed, with their owning phase named"). At the time of writing, step 2's
>    substantive action — the fence advance, commitment release, Leg requeue and `WITHDRAW` dispatch
>    — had **no production caller at all**. It does now (`outbox.worker.js:296`), and is verified
>    end-to-end against live PostgreSQL, but the claim preceded the wiring.
> 2. **"not one command was applied twice … Invariant I21"** held only for the sequential scenarios
>    the shipped suite constructed. Under two genuinely overlapping in-flight commands the agent's
>    persist-failure revert restored a stale snapshot and a command could be applied **twice**.
>    Fixed in `cf9103f`; reproduced, and the fix proven load-bearing, on 2026-08-17.
>
> Both were found by `PHASE_4_INDEPENDENT_VERIFICATION.md`, which is why that review exists. A third
> claim — that `escalation.backoffSeconds` implements §11.3's "bounded exponential backoff with
> jitter" — was true of the *function* but not of the *system*: nothing consulted it until
> 2026-08-17. The §11.3 retry cadence is now enforced rather than reported.

---

# Phase 4 — Dispatch and the agent protocol · Implementation Report

**Phase:** 4 of 16 · **Status:** ✅ **CLOSED** (2026-08-17) — originally written as "COMPLETE — awaiting independent verification before Phase 5"
**Date:** 2026-07-30 · **Branch:** `feature/dashboard` · **Working tree at implementation:** `4244b3d` + uncommitted Phases 1–4
**Authority:** `IMPLEMENTATION_EXECUTION_PLAN.md` §3 "PHASE 4" and §7 "Phase 4" checklist
**Specification:** `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` (FROZEN) — §2.5, §2.6, §4.1, §10.3.1, §10.5, §10.6, §11, §18.5, §23.3, §24.5, §26

> **Phase 5 has NOT been started.** There is no `Timer` table, no `ReconcilerRepair`, no
> `VerificationEvidence`, no timer worker, no reconciler, no lease-renewal loop, no Leg
> state machine, no settlement, no cancellation, no reassignment. No scheduling, no
> routing optimisation, no allocation heuristic. `ENGINE_ENABLED` remains `false` in
> every environment; nothing in the running system calls `commit()` or starts the
> outbox worker.

---

## 1. Executive summary

Phase 4 delivers §11 in full and the §23.3 command-integrity rules the agent must
enforce. After it, **no command can reach an agent except by draining an outbox row
written in the same transaction as the state transition and fence advance that
authorise it** — §4.1 rule 5 as a structural property rather than a convention.

**6 new engine modules, 1 new worker, 1 new socket handler, 2 new tables, 5 CHECK
constraints, and 6 new test suites (188 tests).**

Five properties hold that did not before:

1. **A correct decision cannot silently produce no physical effect.** The baseline
   committed the task, attempted dispatch afterwards, discarded the result and
   swallowed the exception. Now the commitment and its dispatch obligation are one
   write, the drain worker owns the obligation until it is acknowledged or escalated,
   and outbox depth and oldest-undelivered-age are readable from the day the table
   exists.
2. **The agent has a voice.** `ACCEPT` / `REJECT` / `DEFER` are implemented as three
   state transitions, not three log lines. The deferral §11.2 calls out by name — an
   agent holding an assignment while charging, invisible to the server for half an
   hour — now releases the commitment, records a start-not-before, and returns the Leg
   to the next round.
3. **The agent has a durable memory, and its loss is detectable.** `dedup_state_generation`
   is persisted alongside the dedup table and advanced whenever that table is created,
   cleared, or found corrupt. §11.5's three server paths are implemented; the third —
   suppress redelivery, advance `authority_epoch`, reconcile custody — is what makes a
   routine power cycle safe.
4. **The two fence scopes are compared the way §10.3.1 requires, on both sides.** The
   agent-side rules are the *same functions* Phase 3 wrote for the server, imported
   rather than restated, so the two halves of the protocol cannot drift. §10.3.1's own
   worked example — the one where a single per-agent counter seizes the fleet after the
   second concurrent commitment — is a passing conformance test against `VirtualRobot`.
5. **The chaos gate passes.** A simulated agent is power-cycled mid-mission with its
   dedup state wiped, every applied command is redelivered, and: the generation
   advanced, all three rows were suppressed, `authority_epoch` advanced, and **not one
   command was applied twice** — verified both at the store (the suppressed rows are
   unclaimable) and at the agent (each redelivery is rejected `FENCE_AT_OR_BELOW_FLOOR`).
   Invariant I21.

`npm run verify` is green: **3 gates PASS, 53 suites, 1 067 tests, 0 failures.** The
legacy lane is **22 suites / 169 tests, identical to the Phase 0, 1, 2 and 3
baselines**.

**Two inherited risks are not discharged** (§18): no migration in this programme has
been applied to a live PostgreSQL instance, and Phase 4's outbox row is written inside
the exact transaction Phase 3 built — so it inherits every unverified property of it.
The Phase 3 independent verification recommended discharging this "before, or very
early within, Phase 4". It has not been discharged, and this report does not pretend
otherwise.

---

## 2. Objective achieved

The plan's stated purpose:

> Deliver §11 — transactional outbox, offer semantics, durable agent-side dedup — and
> the §23.3 command-integrity rules that the agent must enforce.

> **Scope.** Outbox write inside the commit transaction, outbox drain worker,
> OFFER/ACCEPT/REJECT/DEFER, offer TTL and withdrawal, escalation ladder, per-commitment
> sequence ordering, durable dedup with `dedup_state_generation` handshake, fence
> rejection on the agent side.

Every item in that scope landed. Nothing in it was conditioned on a later event.

---

## 3. Files created

### 3.1 The dispatch surface — `src/engine/dispatch/**` (1 592 lines)

| File | Purpose | Tier |
|---|---|---|
| `outbox.js` | §11.1: the row's shape, the §10.3.1 scope discipline enforced at construction, `enqueue` that refuses a non-transaction client, claim with an expiring lease, attempt recording, suppression, expiry, and the two SLIs | **0** (T0-09) |
| `sequence.js` | §11.3: two sequence namespaces following the two fence scopes, and the application rule under which a gap **holds** rather than skips — which is what makes "`RECALL` never before its `OFFER`" a property rather than a hope | **0** (T0-09) |
| `offers.js` | §11.2: the offer's content, the three responses, and §11.4 step 2's withdrawal at an **advanced** fence | **0** (T0-09) |
| `escalation.js` | §11.4: the four rungs, bounded backoff with caller-supplied jitter, and the systemic directive | **0** (T0-09) |
| `dedupHandshake.js` | §11.5: the three server paths, the custody hold of invariant I7, and the agent-side admission rules delegated to Phase 3's `fencing.js` | **0** (T0-06) |

### 3.2 Security and the worker

| File | Purpose | Tier |
|---|---|---|
| `src/engine/security/commandSigning.js` | §23.3: the canonical form, the HMAC signature over the whole payload **including the agent id**, constant-time verification, and the two envelope rules (addressee, expiry) | **1** by path |
| `src/workers/outbox.worker.js` | §11.1 item 2 / §11.3 / §11.4: expire → claim → deliver → record → escalate → emit SLIs, plus the two advisory cache mirrors | **0** by path |
| `src/sockets/handlers/offer.handler.js` | The agent→server half of §11.2 | — |

### 3.3 Migration

| File | Purpose |
|---|---|
| `prisma/migrations/20260730090000_dispatch_and_agent_protocol/migration.sql` | `Outbox`, `AgentDedupState`, their indexes and foreign keys (Prisma's own SQL, verbatim), plus five hand-written CHECK constraints |

### 3.4 Tests — `tests/engine/**` (188 tests across 6 suites)

| File | Tests | Covers |
|---|---|---|
| `dispatchOutbox.test.js` | 42 | The scope discipline in both directions; the two idempotency namespaces; `enqueue` refusing the base client; commit refusing an absent writer; claim/reclaim/attempt/expiry/suppression; the five CHECK constraints driven **without** `buildRow`; sequencing and the RECALL-before-OFFER property |
| `dispatchOffers.test.js` | 26 | §11.2's content; the offer written by the commit that authorises it; the three responses and their state effects; the withdrawal's advanced fence and its all-or-nothing transaction |
| `dispatchDedup.test.js` | 28 | §10.3.1's worked example; `fence_floor`; the unknown-commitment rule; §11.5's three paths plus the case its table does not name; the custody hold; I21 at the store |
| `dispatchEscalation.test.js` | 35 | The four rungs; bounded backoff; "consecutive" as opposed to a rate; the empty shard; the drain worker end-to-end; the advisory mirrors and their irrelevance to correctness |
| `dispatchAgentProtocol.test.js` | 31 | `VirtualRobot` as the conformance fixture: durability before effect, the §23.3 envelope rules, both fence scopes, ordering, the three offer responses, §18.5's continuation limit, and **the I21 chaos gate** |
| `dispatchSchema.test.js` | 32 | Migration ⟷ `schema.prisma` against Prisma's own SQL; the CHECKs asserted as written *and* asserted absent from the generated output; §23.3's envelope; parameter-register integration; the Phase 4 gate as a structural property |
| `helpers/dispatchFixture.js` | — | Fixtures in which `Agent.id ≠ Agent.agentId` and `Leg.id ≠ Leg.legId` — closing the Phase 3 verification's finding #4 |

---

## 4. Files modified

| File | Change | Why |
|---|---|---|
| `prisma/schema.prisma` | +150 lines, **zero removed** | `Outbox`, `AgentDedupState`, and three back-relations |
| `src/engine/commitment/commit.js` | `sideEffects` becomes **required**; the writer receives the locked rows' ids; a business-identifier misuse aborts loudly | The only place Phase 4's gate can be enforced rather than reviewed (§5.1); Phase 3 verification finding #4 |
| `src/engine/commitment/guards.js` | Two new abort reasons | The misuse above needs a name distinct from "not found" |
| `src/engine/guards/tierAssertions.js`, `src/engine/TIERS.md` | T0-09 gains `offers.js` and `escalation.js`; T0-05 gains `commitment/leases.js` | Register Phase 4's modules; Phase 3 verification finding #5 |
| `src/services/commandDispatcher.service.js` | +86, **zero removed** | Becomes the outbox's delivery arm. Legacy helpers byte-identical |
| `src/sockets/handlers/robot.handler.js` | AUTH carries the §11.5 report; the handshake runs before `AUTH_SUCCESS` | Checklist item 12 |
| `src/sockets/handlers/command.handler.js` | +82, **zero removed** | ACK correlation extended from `Command` rows to `Outbox` rows |
| `src/sockets/socket.server.js` | Registers the offer handler; the init signature gains one optional field | Checklist item 6 |
| `src/simulation/VirtualRobot.js` | **major** — the agent-side contract | The plan makes it the reference implementation and the conformance fixture |
| `tests/engine/phase0Scaffold.test.js` | Ownership widened to Phase 4; four presence tests added | The assertion narrows rather than disappears |
| `tests/engine/commitmentTransaction.test.js` | The central `deps()` helper supplies the now-required `sideEffects` | One line; the contract it exercises got stricter |
| `tests/engine/commitmentSchema.test.js` | The "no Phase 4+ table" assertion narrows to Phase 5+, and Phase 4's two tables are asserted **present** | Same discipline; a `Timer` appearing early still fails |
| `tests/engine/helpers/commitmentStore.js` | Three tables, five CHECKs, and the Prisma filter/ordering subset the Phase 4 modules use | A matcher that ignored `{ lt: … }` would let the conditional claim pass vacuously |

---

## 5. Runtime flow

```
  ROUND (Phase 10)                    COMMIT TRANSACTION (Phase 3 + 4)
       │                                        │
       └──► commit(deps, request) ──────────────┤
                                                │  1  FOR UPDATE agent, then Leg
                                                │  2  guards G1–G6
                                                │  3  volatileRecheck  (Phase 6 seam)
                                                │  4  fence = counter+1; Commitment;
                                                │     Leg state+version; I6 audit
                                                │  5  offers.enqueueOffer ──► Outbox
                                                │       ├ sequence.allocate (per commitment)
                                                │       ├ commandSigning.sign (§23.3)
                                                │       └ outbox.enqueue (refuses base client)
                                                │  6  decisionRef
                                                │  7  COMMIT  ── both rows, or neither
                                                ▼
  OUTBOX WORKER (not started; Phase 15 schedules it)
       expire past validity ──► EXPIRED
       claim (conditional; expired claims reclaimable) ──► CLAIMED
       deliver via commandDispatcher.deliverOutboxCommand
             │  io.to("robot:{id}").emit(envelope.command, envelope)
             ├─ ok    ──► DELIVERED  (+ advisory engine:offer:{id})
             └─ not   ──► PENDING, attempts+1, lastError  (never swallowed)
       escalate (§11.4)  1 retry · 2 UNACKNOWLEDGED · 3 agent health · 4 systemic
       emit outbox depth + oldest-undelivered-age

  AGENT (VirtualRobot / firmware)
       admit envelope   signature · addressee · not_valid_after            (§23.3)
       admit fence      mission: ≤ highest_seen[commitment_id] or ≤ floor  (§10.3.1)
                        agent:   < highest_seen_authority
       admit sequence   apply · duplicate · held-for-order                 (§11.3)
       PERSIST dedup state ──► only then apply the effect and ACK          (§11.5)
       respond          OFFER_ACCEPT / OFFER_REJECT / OFFER_DEFER          (§11.2)

  SESSION ESTABLISHMENT
       AUTH{dedupState} ─► parse ─► classify ─► RESUME
                                             ├► REDELIVER_FROM_MARK
                                             ├► FIRST_CONTACT
                                             └► SUPPRESS_AND_REFENCE
                                                  suppress every outstanding row
                                                  advance authority_epoch + I6 audit
                                                  hold for custody reconciliation (I7)
       AUTH_SUCCESS{dedup} ─► agent adopts epoch + floor, discards its table
```

---

## 6. Persistence flow

| Write | Where | Transaction |
|---|---|---|
| `Outbox` row (OFFER) | `offers.enqueueOffer` | **the commit transaction** (§10.3.2 step 5) |
| `Outbox` row (WITHDRAW) + `Agent.fenceCounter` + `Leg` + `Commitment.releasedAt` + `AgentFenceAudit` | `offers.withdrawExpiredOffer` | one transaction (§4.1 rule 5) |
| `Leg.state`/`version` (+ `startNotBefore`) | `offers.applyAccept/Reject/Defer` | the response's transaction; **conditional on the Leg's own version** (§4.1 rule 2) |
| `Commitment.leaseExpiry`/`releasedAt`/`version` | same | same |
| `Outbox.state`/`attempts`/`claimedBy` | `outbox.claim` / `recordAttempt` / `settleRow` / `expirePastValidity` | each its own atomic conditional `updateMany` |
| `Outbox.state = SUPPRESSED` + `Agent.authorityEpoch` + `AgentFenceAudit` + `AgentDedupState` | `dedupHandshake.apply` | one transaction |
| `Observation` (offer rejection) | `offer.handler.js` | the response's transaction |
| Agent-side dedup state | `VirtualRobot.persistDedupState` | non-volatile storage, **before** any observable effect |

**No SOFT reservation is persisted anywhere in the deferral path** — asserted (invariant
I18). **No module under `src/engine/dispatch/` imports the cache** — asserted
structurally (invariant I16).

---

## 7. Event flow

Ordering is a protocol requirement, not a transport hope (§11.3). Per commitment:

```
  OFFER(seq 0, fence f)  ──►  agent applies, persists, ACKs, responds
  REROUTE(seq 1, fence f+1) ─►  applied only after seq 0
  RECALL(seq 2, fence f+2)  ─►  applied only after seq 1
```

A command arriving with a gap below it is **held**, not applied. That is what makes
"reordering a `RECALL` before an `OFFER` would be a serious defect" a defect the
protocol cannot commit: the held command waits for the missing one, which is still in
the outbox being retried, and the hold is bounded by the command's own
`not_valid_after`.

---

## 8. API changes

**None.** The plan specifies "REST API changes: None", and none was made. No route file
was touched — confirmed by an empty `git diff --stat -- src/routes/`.

---

## 9. Redis changes

The plan's row: *"New: `engine:outbox:claim:{workerId}` (claim lease, advisory),
`engine:offer:{commitmentId}` (offer TTL mirror, advisory). Retire nothing."*

Both keys are written, by the **worker**, and both are advisory in the §3.3 sense: the
database holds `claimedBy`/`claimExpiresAt` and `notValidAfter`, and those are what the
reclaim path, the expiry sweep, and the escalation ladder read. Nothing was retired.

Two placement decisions, both deliberate:

- **The writes live in the worker, not in `dispatch/**`.** No dispatch module imports
  the cache, and a test asserts it — invariant I16 as a structural property, which an
  import a later change could quietly make load-bearing would weaken.
- **The offer mirror is written at delivery, never at enqueue.** Writing it at enqueue
  would put a cache write inside the commit transaction: an external side effect before
  the write authorising it commits, which is what §4.1 rule 5 forbids.

Every advisory write is wrapped and every failure swallowed. A test drives a full drain
pass against a cache that throws on every call and asserts the command is still
delivered and marked.

`vr:dedup:{robotId}` is added on the **agent** side, standing in for firmware's
non-volatile storage. Its TTL is `agent.dedup_retention` (30 min), which §22.1 validates
to be at least `dispatch.offer_ttl + dispatch.max_delivery_delay`; a test asserts that
inequality holds at the seeded defaults.

---

## 10. Socket.IO changes

### 10.1 Server → agent (new)

All eighteen §10.3.1 commands, each as its own wire event, so an agent subscribes to the
commands it implements rather than switching on a type field inside one opaque envelope:

| Class | Events | Fenced by |
|---|---|---|
| Mission | `OFFER`, `WITHDRAW`, `REROUTE`, `RESEQUENCE`, `RECALL`, `RESUME`, `TRANSFER_CUSTODY`, `ABORT_MISSION` | commitment `fence` |
| Agent | `STAND_DOWN_ALL`, `QUARANTINE`, `RELEASE_QUARANTINE`, `ESTOP_CLEAR`, `SHARD_MIGRATE`, `SESSION_REKEY`, `PARAMETER_PUSH` | `authority_epoch` + `fence_floor` |
| Query | `STATUS_REQUEST`, `PROBE`, `MANIFEST_QUERY` | never fenced; answered as `{COMMAND}_RESULT` |

### 10.2 Agent → server (new / extended)

`OFFER_ACCEPT`, `OFFER_REJECT`, `OFFER_DEFER`; `COMMAND_ACK` **extended** to carry
`outboxId` (the legacy `commandId` form is unchanged and still handled); the §11.5
deduplication high-water mark carried on `AUTH` as `dedupState`, and the server's
handshake outcome returned on `AUTH_SUCCESS`/`AUTH_OK` as `dedup`.

### 10.3 Legacy events

`TASK_ASSIGN`, `REROUTE_ALERT`, `COMMAND`, `STOP`, `task_assigned`, `assign_task` are
**retained and unchanged** until the Phase 15 cutover, as the plan requires. A test
asserts no §10.3.1 command name is emitted by any legacy helper, and that no legacy
event name appears in the §10.3.1 table.

---

## 11. Compatibility guarantees

| Surface | Guarantee | Evidence |
|---|---|---|
| **Data** | No legacy row read or written differently. Both new tables are empty; no pre-existing table gains a column | §12, `dispatchSchema.test.js` |
| **Schema** | Zero lines removed from `schema.prisma`; no `DROP`, `RENAME`, or `ALTER COLUMN` in the migration; every `ALTER TABLE` targets one of the two new tables | Four dedicated tests |
| **API** | No route, response shape, or status code changed | `git diff --stat -- src/routes/` is empty |
| **Redis** | No key retired; two advisory keys added, written only by a worker that is not started | §9 |
| **Socket.IO** | Every legacy event retained with its payload shape. `AUTH_SUCCESS`/`AUTH_OK` gain one **additional** field (`dedup`, null while the engine is off); a client destructuring `{ token }` is unaffected | §10.3 |
| **Legacy tests** | 22 suites / 169 tests, identical to the Phase 0, 1, 2 and 3 baselines | `npx jest --selectProjects legacy` |
| **Timing** | `VirtualRobot._registerHandlers()` runs on the same tick as before — the handshake adoption is synchronous, and the durable write follows. An `await` there would have deferred registration by a microtask and dropped anything arriving inside it | §16 assumption 6; `dispatchAgentProtocol.test.js` |
| **Inertness** | Every Phase 4 write path is gated on `ENGINE_ENABLED`; the worker is not started from `server.js`, and a test asserts that | `phase0Scaffold.test.js` |
| **Determinism** | Backoff jitter is supplied by the caller, never drawn; the canonical signing form is key-order independent; no dispatch module reads a wall clock for a safety decision | `dispatchEscalation.test.js`, `dispatchSchema.test.js` |
| **Parameter register** | No behavioural constant introduced. All seven Phase 4 parameters were registered by Phase 1 and resolve through the real Config Service | `gate:params` PASS; 9 register-integration tests |

---

## 12. Database changes

Additive only.

| Object | Purpose |
|---|---|
| `Outbox` (table) | §11.1's durable dispatch obligation. 24 columns; the plan's named `(state, notValidAfter)` index plus three more |
| `AgentDedupState` (table) | §11.5's reported high-water mark — the only thing that makes a *second* reset detectable |
| `Outbox_command_class_known` | CHECK: `MISSION` or `AGENT`. A `QUERY` row would be a fenced query, which §10.3.1 row 3 forbids |
| `Outbox_fence_scope_columns` | CHECK: a row carries the columns **its own** scope requires and not the other's. This is the backstop that stops a future writer populating both and leaving the comparison to be chosen at delivery time — which is how a single per-agent maximum would be reintroduced |
| `Outbox_sequence_non_negative` | CHECK: an ordering counter that could go negative is not an ordering counter |
| `Outbox_state_known` | CHECK: the eight states. An unknown state is a row no sweep matches and no worker claims |
| `AgentDedupState_counters_non_negative` | CHECK: the monotone counters' shape, mirrored from I6 |
| `Outbox_idempotencyKey_key` | The unique index that makes §10.5's two namespaces enforceable rather than conventional |

Every `CREATE TABLE`, `CREATE INDEX` and `ADD CONSTRAINT … FOREIGN KEY` is Prisma's own
generated SQL, taken verbatim; a test regenerates it and diffs. Each CHECK is asserted
present in the migration **and asserted absent** from the generated output, so a
reviewer can tell a hand-written addition from an echo.

---

## 13. Tests added

**188 new tests across 6 suites.** Every plan-named requirement and where it is met:

| Plan requirement | Where | Result |
|---|---|---|
| Unit: fence rejection **per commitment id**, not per agent max | `dispatchDedup.test.js`, `dispatchAgentProtocol.test.js` | §10.3.1's worked example passes; the per-agent maximum is shown to disagree |
| `fence_floor` invalidates all mission authorities | Both suites | One `STAND_DOWN_ALL` fences three commitments; the table is discarded |
| Unknown-commitment command rejected **via `fence_floor`**, not admitted for lack of history | Both suites | `FENCE_AT_OR_BELOW_FLOOR`, not "accepted" |
| Integration: full offer round-trip incl. REJECT and DEFER | `dispatchOffers.test.js`, `dispatchAgentProtocol.test.js` | All four dispositions, with their state effects |
| **Chaos (§24.5): power-cycle wiping dedup state; redeliver every applied command; assert advanced generation, suppressed redelivery, advanced `authority_epoch`, zero double-application (I21)** | `dispatchAgentProtocol.test.js` | ✅ All four, plus zero externally observable effects on the rebooted agent |
| Ordering: `RECALL` never applied before its `OFFER` | `dispatchOutbox.test.js`, `dispatchAgentProtocol.test.js` | The gap holds it; it applies once the OFFER arrives |
| **Gate:** no command reaches an agent except from an outbox row written in its authorising transaction | `dispatchOutbox.test.js`, `dispatchSchema.test.js` | `enqueue` refuses the base client; `commit` refuses an absent writer; the delivery arm has no literal engine event name of its own |

### 13.1 Three things the suite does that a weaker one would not

**The fixtures break the coincidence the Phase 3 review found.** Every Phase 3 fixture
set `Agent.id === Agent.agentId`, so "no test in the suite could distinguish a caller
using the wrong field". Phase 4's fixtures make them differ, and a test asserts they
differ — so the assertion that the outbox writer receives row ids is not satisfied by
accident.

**The store model gained the operators, not a stub.** `claim`'s correctness is a claim
about a *conditional* write (`state = PENDING`, or `CLAIMED` with an expired lease). A
matcher that ignored `{ lt: … }` and `{ in: [ … ] }` would let that condition pass
vacuously, so the model implements the Prisma filter subset the modules actually use.

**The gate is asserted from both ends.** "No command except from an outbox row" is
checked as a refusal (`enqueue` and `commit` both throw) *and* as a structural property
of the delivery arm (it emits `envelope.command` and holds no engine event name of its
own, so its reachable event set is exactly §10.3.1's table).

### 13.2 A real bug the tests caught during implementation

`VirtualRobot`'s rollback after a failed durable write restored `mark || { fence: 0n,
sequence: -1 }` — which *inserted* a zero-valued high-water mark where there had been
none. The agent would then have asserted a history for a commitment it had never
applied anything for, and §23.3 specifically distinguishes that case: the `fence_floor`
rule, not the per-commitment rule, is meant to govern an unknown commitment. Caught by
the assertion that the mark is absent after a failed persist, not by inspection.

---

## 14. Checklist completion — `IMPLEMENTATION_EXECUTION_PLAN.md` §7, Phase 4

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Migration: `Outbox` with `(state, notValidAfter)` index; `AgentDedupState` | ✅ | Both tables; the named index; 5 CHECKs |
| 2 | `dispatch/outbox.js` — row written **inside** the commit transaction | ✅ | `enqueue` refuses a base client, by a checked property not a comment |
| 3 | `workers/outbox.worker.js` — claim, deliver, bounded retry, escalate | ✅ | `drainOnce`; expired claims reclaimable; a thrown transport error is recorded, never swallowed |
| 4 | Route **every** server→agent message through the outbox | ✅ | The arm emits only `envelope.command`; legacy helpers hold no §10.3.1 name; both asserted |
| 5 | `offers.js` — OFFER content per §11.2 incl. reserve params and target SoC | ✅ | All eleven fields; the two §14.6 fields declared and empty for Phase 7 |
| 6 | `sockets/handlers/offer.handler.js` | ✅ | Three events, `ENGINE_ENABLED`-gated, each its own transaction |
| 7 | DEFER: release the HARD commitment, Leg → `PLANNED` with start-not-before | ✅ | Plus a deferral to the past refused as a rejection wearing a deferral's name |
| 8 | `escalation.js` — steps 1–4 incl. systemic threshold | ✅ | Four rungs; "consecutive" not a rate; an empty shard is not faulty |
| 9 | `sequence.js` — per-commitment ordering; `RECALL` never before its `OFFER` | ✅ | Two namespaces; a gap **holds** |
| 10 | `security/commandSigning.js` — fence scope, fence value, sequence, `not_valid_after`, signature | ✅ | All eleven signed fields; constant-time verify; short key refused |
| 11 | `dedupHandshake.js` — three server paths | ✅ | Plus the case §11.5's table does not name, resolved conservatively |
| 12 | Extend AUTH to carry `dedup_state_generation`, `authority_epoch`, `fence_floor`, per-commitment high-water marks | ✅ | All four; opt-in, so legacy AUTH is unchanged |
| 13 | **VirtualRobot:** durable dedup persisted before any observable effect | ✅ | A failed persist applies nothing and sends no ACK |
| 14 | **VirtualRobot:** reject mission command at `≤ highest_seen[commitment_id]` or `≤ fence_floor` | ✅ | Delegates to Phase 3's `fencing.js`; both rules tested |
| 15 | **VirtualRobot:** reject agent command at `authority_epoch < highest_seen` | ✅ | Including the `<` vs `≤` asymmetry |
| 16 | **VirtualRobot:** answer queries unfenced; enforce `agent.autonomous_continuation_limit` | ✅ | Queries answered from a maximally-fenced state; the limit halts at the bound, not before |
| 17 | Tests: fence compared **per commitment id**, never as a per-agent maximum | ✅ | §10.3.1's worked example, on the agent |
| 18 | Chaos: power-cycle; redeliver; suppression + epoch advance + zero double-application (I21) | ✅ | §13 |
| — | **Gate:** no command reaches an agent except from an outbox row written in its authorising transaction | ✅ | §14.1 |

**18 of 18 complete.** None qualified.

### 14.1 Completion criteria — §3 "PHASE 4"

| Criterion | Result |
|---|---|
| No command reaches an agent except via an outbox row written in the authorising transaction | ✅ Enforced three ways: `enqueue` refuses a non-transaction client; `commit` refuses an absent outbox writer; the delivery arm has no engine event name of its own |
| Agent dedup durable across restart with generation counter | ✅ Persisted before every observable effect; created/cleared/corrupt all advance the generation |
| Command→fence-scope table (§10.3.1) implemented exactly | ✅ Phase 3's table, consumed by construction — `buildRow`, `sequence`, and the agent all derive scope from it rather than restating it |
| Escalation ladder steps 1–4 operational | ✅ Steps 1 and 2 acted on; steps 3 and 4 assessed and reported as directives with their owning phase named |
| I21 verifiable | ✅ The chaos gate, at the store and at the agent |

---

## 15. Verification evidence

### 15.1 `npm run verify`

```
> gate:tiers
gate: tier-dependencies (§1.8 rule 2)
  PASS — 105 module(s), 64 governed import edge(s), no Tier 0/1 → Tier 2 dependency.

> gate:params
gate: parameter-register (§22, Appendix A)
  PASS — 37 engine module(s) checked against 148 registered parameter(s); no bare behavioural constants.

> gate:tenets
gate: tenets (T1 type separation, T6 decision-path determinism)
  PASS — 102 module(s) checked, no violations.

> test
Test Suites: 53 passed, 53 total
Tests:       1067 passed, 1067 total
```

| Lane | Suites | Tests | Δ vs Phase 3 |
|---|---|---|---|
| `legacy` | 22 | 169 | **unchanged** |
| `gates` | 3 | 49 | unchanged |
| `engine` | 28 | 849 | +6 suites, +196 tests |
| **Total** | **53** | **1 067** | +6 / +196 |

### 15.2 The gate fired during implementation

`gate:params` rejected the three §11.4 step numbers in `ESCALATION_STEP`. They are step
numbers from a normative table rather than thresholds, so each was annotated
`@structural` with that reason rather than registered — recorded because a gate that
never fires during a phase is a gate nobody has evidence about.

### 15.3 Architectural compliance, item by item

| Requirement | Evidence |
|---|---|
| §4.1 rule 5 — no side effect before its authorising write | `enqueue` and `dedupHandshake.apply` both refuse a non-transaction client; `commit` refuses an absent writer; a thrown writer rolls the whole commit back, asserted field by field |
| §10.3.2 step 5 — the outbox row in the same transaction, carrying the fence from step 4 | The row's `fence` is asserted equal to the commitment's after a nominal commit |
| §10.3.1 — the two scopes carried in separate columns and compared differently | The `Outbox_fence_scope_columns` CHECK; the mission rule at `≤`, the agent rule at `<` |
| §10.5 — the two namespaces disjoint, on the row | The row's `idempotencyKey` matches Phase 3's key functions exactly; disjointness re-asserted |
| §10.6 — deadlines from the store's clock | The worker refuses to run without a store-clock reader |
| §11.1 — either both exist or neither | Both directions tested: a failing writer leaves no commitment; an aborted commit leaves no row |
| §11.1 — outbox depth and oldest-undelivered-age as primary SLIs | Emitted every pass |
| §11.2 — the agent may refuse, and a REJECT is a safety signal | The rejection is returned as a **feasibility observation** and written to §2.7's append-only table, not logged |
| §11.2 — DEFER releases rather than holds | `releasedAt` set; capacity freed at the database |
| §11.3 — ordered per agent; `RECALL` never before its `OFFER` | The gap holds |
| §11.3 — bounded retry with escalation, not silent retry | A thrown transport error becomes an undelivered attempt with a recorded cause |
| §11.4 — four rungs, and step 4's count | Step 4 tested at, above, and below the threshold, and on an empty shard |
| §11.5 — durable before the effect | A failed persist applies nothing and sends no ACK |
| §11.5 — suppression is the correct response to a reset | All outstanding rows, terminal ones untouched, unclaimable afterwards |
| §11.5 — custody reconciled before any re-offer (I7) | The hold is reported on every path, including `HELD` and `DISPUTED` |
| §23.3 — signature over the whole payload **including the agent id** | Re-addressing the same payload invalidates the signature |
| §23.3 — the agent's rejection order | Envelope, then fence, then sequence — asserted by the reason a verbatim redelivery produces |
| §18.5 — the on-agent continuation limit | Halts at the bound, not before; an unsupervised-from-birth agent is not halted for it |
| §2.6 / I18 — no SOFT reservation persisted | Asserted through the deferral path |
| §3.3 / I16 — cache loss is harmless | No dispatch module imports the cache; a hostile cache does not stop a delivery |
| §1.8 rule 2 — no Tier 0/1 → Tier 2 dependency | `gate:tiers` PASS over 64 governed edges |

---

## 16. Known assumptions

Each is an implementation choice not dictated by the plan, stated so it can be overruled.

1. **`sideEffects` becomes a required dependency of `commit()`.** Phase 3 admitted its
   absence because no dispatcher existed. §10.3.2 step 5 is unconditional, and this is
   the only place Phase 4's gate can be enforced rather than reviewed. It also
   discharges the Phase 3 verification's finding #6 (the two seams described identically
   but enforced asymmetrically). **This is the most consequential change to a landed
   phase's code in this report.**
2. **The §11.5 report rides on `AUTH` as a `dedupState` field rather than as a separate
   `DEDUP_STATE` event.** The plan's Socket.IO row names `DEDUP_STATE (at AUTH)` and its
   checklist item 12 says "Extend AUTH to carry …". The checklist is the more specific
   instruction and is what was implemented; a separate event would complete after
   `AUTH_SUCCESS`, weakening the guarantee that the handshake finishes before
   authentication does.
3. **§11.1 item 3's `dispatch.delivery_deadline` is not a registered parameter**, and
   the ladder's own two — `dispatch.retry_window` and `dispatch.offer_ttl` — are used
   instead, with `dispatch.max_delivery_delay` bounding a non-offer command's validity.
   The plan's Phase 4 configuration row names exactly seven parameters and this is not
   among them; introducing one would be Phase 1's register work done late.
4. **§11.5's third row is read as being about the *agent's* state.** Where the server
   has no stored generation it cannot tell whether the agent's advanced, so: active
   commitments ⇒ treat as a reset; none ⇒ `FIRST_CONTACT`, which records the mark and
   advances nothing. **This is the only judgement in the phase the specification does
   not make explicitly.** A generation that went *backwards* is also treated as a reset.
5. **The escalation ladder's steps 3 and 4 are assessed and reported, not acted on.**
   Their actions — availability-index removal and degraded-mode entry — belong to
   Phase 9 and Phase 12; each directive names its owner. `dispatch_unresponsive` is
   **derived** from the outbox rather than stored on the agent row, so there is no
   second counter that could disagree with the evidence it summarises.
6. **`VirtualRobot` adopts the handshake acknowledgement synchronously**, then registers
   handlers, then persists. Both alternatives leave a window; this one leaves none and
   keeps handler registration on the tick it was on before Phase 4.
7. **Outbox columns beyond the plan's list:** `idempotencyKey` (§10.5's durable
   expression), `command` (`commandClass` alone does not say *which* command),
   `fenceFloor` (§10.3.1 requires every agent command to carry it), `claimExpiresAt` (a
   claim with no expiry is a lease with no expiry), `ackedAt`, `lastError`.
8. **The advisory Redis mirrors are written by the worker, not by `dispatch/**`**, and
   the offer mirror at delivery rather than at enqueue. §9.
9. **HMAC-SHA256 with an injected key.** Phase 14 owns mTLS and per-device certificates
   and replaces the key material and algorithm, not the envelope. No module reads
   `process.env` for it; a key shorter than 32 bytes is refused.
10. **Each §10.3.1 command is its own wire event**, rather than one envelope event with
    a type field. An agent subscribes to what it implements.
11. **The offer handler resolves a socket's `Agent` row via `Agent.agentId`**, and a
    robot with no projected Agent row is a no-op. Creating one would be a second
    backfill.
12. **`TRANSFER_CUSTODY` is recorded but not simulated.** `custody_transfer_capable`
    defaults false (§2.3); simulating a handover the model does not describe would be
    Phase 7 work done badly.
13. **The Phase 3 store model gained tables, CHECKs, and a Prisma filter subset.** It is
    still not PostgreSQL, and every concurrency claim built on it inherits that caveat.

---

## 17. Remaining TODOs

### 17.1 Carried out of Phase 4

| # | Item | Owner | Due |
|---|---|---|---|
| 1 | Provision the command signing key (`commandSigning` takes it injected; no env read exists yet) as part of turning the engine on | SRE | Phase 15 |
| 2 | Start `outbox.worker.js` — deliberately not wired into `server.js` | Phase 15 | Phase 15 |
| 3 | Wire step 3's directive into the availability index | Phase 9 | Phase 9 |
| 4 | Wire step 4's directive into the named degraded-mode register | Phase 12 | Phase 12 |
| 5 | Consume `custodyReconciliationRequired` in the reconciler's custody audit (§12.4), and refuse re-offer while it holds | Phase 5 | Phase 5 |
| 6 | Route the Leg transitions this phase performs through the §4.4 transition table | Phase 5 | Phase 5 |
| 7 | Take over lease renewal from `applyAccept` into the Supervisor | Phase 5 | Phase 5 |
| 8 | Populate `energyReserveParams` and `targetSoc` in the offer payload | Phase 7 | Phase 7 |
| 9 | Replace HMAC signing with mTLS + per-device certificates | Phase 14 | Phase 14 |

### 17.2 Carried forward, still open

| # | Item | Owner | Origin |
|---|---|---|---|
| 1 | **Apply Phases 1–4 to a production-shaped PostgreSQL dump.** Phase 3's verification recommended this "before, or very early within, Phase 4"; it was not done, and Phase 4 writes inside Phase 3's transaction | Verifier / SRE | Phase 2, compounded |
| 2 | Discharge blocking decision B9 by execution on the target PostgreSQL | Eng / SRE | Phase 3 |
| 3 | Correct the model checker's `exhaustive` claim and the "invisible at capacity 1" narrative | Implementation | Phase 3 verification §3.5 |
| 4 | Add a concurrent identical-idempotency-key commit test | Implementation | Phase 3 verification §4.1 |
| 5 | Confirm `isCapacityConstraintViolation`'s string matching against Prisma's real error format | Implementation | Phase 3 verification §7.1 |
| 6 | Run `formal/commitment.tla` under TLC | Verifier | Phase 3 |
| 7 | Resolve the combined-conservatism V9 finding | Safety | Phase 1 |
| 8 | Resolve the §1.8 / §22.5 kill-switch discrepancy | Tech lead | Phase 0 |
| 9 | Name the calibration owner; set the fleet-year energy budgets (B8) | Ops / Finance / Safety | Phase 1 |
| 10 | Supply the 15 unset `required` register values | Ops, Finance, Account management | Phase 1 |
| 11 | `fixedPoint.toMilliCU()` half-boundary rounding | Implementation | Phase 1 verification |
| 12 | `POST /api/config/publish` 500 on malformed input | Implementation | Phase 1 verification |

**Items 3–6 and 11–12 were deliberately not fixed**, per the instruction to carry
forward only Phase 3 follow-up work that belongs to Phase 4. Findings #4 (the
business-key hazard) and #5 (`TIERS.md`'s omission of `commitment/leases.js`) **were**
carried forward, because Phase 4 wires the first external caller of `commit()` and
lands modules in the same tier registry.

### 17.3 Explicitly out of scope for Phase 4

Durable timers · the reconciler · lease renewal beyond the grant at ACCEPT · progress
supervision · completion verification · settlement · cancellation · reassignment ·
preemption · the Leg and Task state machines · the availability index · degraded modes ·
scheduling · routing optimisation · allocation heuristics — **the plan assigns each to a
later phase, and none was implemented.**

---

## 18. Risks

| Risk | Assessment |
|---|---|
| **No migration has been applied to a real database** | The largest residual risk, inherited and now compounded for the third time. Phase 4 adds two tables, five CHECKs, and two foreign keys — one of which references a non-primary-key unique column (`Commitment.commitmentId`), which is valid PostgreSQL but is the first such reference in this schema. Every statement is cross-checked against Prisma's own generated SQL; static checking cannot confirm the CHECK expressions parse |
| **Making `sideEffects` required changed a landed phase's contract** | Deliberate and disclosed (assumption 1). The blast radius is one line in one test helper, and the alternative — leaving the gate to code review — is what §7.1 predicts will erode under latency pressure. If overruled, the correction is to restore the `typeof` check and accept that the gate becomes prose |
| **The protocol requires coordinated firmware work** | Inherent to Phase 4 and anticipated by the plan. `VirtualRobot` is the reference implementation and its conformance tests are the specification a firmware author works to. The risk is that firmware implements the *fence comparison* as a per-agent maximum, which behaves perfectly until the second concurrent commitment — which is why that specific case is a named, passing test rather than a paragraph |
| **The store model is not PostgreSQL** | Unchanged from Phase 3 and now carrying more weight: the claim/reclaim race and the conditional `updateMany`s are claims about a model with atomic overlays, not about MVCC. The claims least exposed are the pure ones — the scope discipline, the fencing rules, the ladder, the signing |
| **The advisory Redis keys are written but read by nothing** | By construction, and asserted: their loss is tested to be harmless. The risk is that a later phase reads one and quietly promotes it to an authority, which is what §3.3's cache-authority rule forbids. Recorded here so the next reader knows they are mirrors |
| **`agent.dedup_retention` is Safety-class and `DERIVED`, but the durations it is derived from are `PROVISIONAL`** | `dispatch.offer_ttl` awaits measured agent acceptance latency. The inequality holds at the seeded defaults and is tested; it is only as meaningful as the defaults, which is item 9's territory and a Phase 15 launch gate |
| **A held-for-order command depends on the missing one being redelivered** | Bounded by `not_valid_after`, so a hold cannot become a wait forever — but the *bound* is an expiry, not a repair. Phase 5's reconciler is what turns an expired held command into a re-plan |

---

## 19. Readiness for Phase 5

| Prerequisite | State |
|---|---|
| Phase 3 complete | ✅ Approved after independent verification |
| Phase 4 complete | ✅ 18/18 checklist items, 5/5 completion criteria |
| Phase 5's dependencies | Phases 3 and 4 — both satisfied |
| Blocking decisions for Phase 5 | **B4 (durable timer store technology) and B6 (map obstruction classification source)** — neither is affected by Phase 4's output, and neither was pre-empted |
| What Phase 5 gets | A durable dispatch obligation whose lifecycle is already a state machine with an expiry; per-commitment sequencing to key its recall and reroute commands on; `offers.withdrawExpiredOffer` as the worked example of "fence advance and command in one transaction" that §4.7 step 2 requires; the `custodyReconciliationRequired` hold to feed into the §12.4 custody audit; §11.4's step-2 mark as the evidence its progress supervision will read; a `VirtualRobot` that already answers `PROBE`, `STATUS_REQUEST` and `MANIFEST_QUERY` unfenced, which is what §12.3's supervision probes need |
| What Phase 5 must add | `Timer`, `ReconcilerRepair`, `VerificationEvidence`; the timer worker and reconciler; the Leg and Task state machines and the §4.4 transition table; lease renewal on commitment-scoped evidence; the nine §12.4 divergence classes; graded completion verification; settlement with custody-before-commitment ordering |
| What Phase 5 must take over | The Leg transitions this phase performs directly (`OFFERED` → `ACCEPTED`/`QUEUED`/`PLANNED`) must route through `lifecycle/transitions.js`; lease renewal must move from `applyAccept` to the Supervisor. Both are §17.1 items 6 and 7 |
| Guardrails Phase 5 will meet | Tier gate (`supervision/**` and `lifecycle/settlement.js` are Tier 0), parameter gate (37 modules / 148 parameters), tenet gate, and the Phase-4-ownership assertion in `phase0Scaffold.test.js`, which will fail on any `supervision/` or `lifecycle/` module until this report's successor widens it |
| **Strongly recommended first** | §17.2 item 1, for the third time. Phase 5 adds durable timers whose correctness is a claim about the database's behaviour under concurrent firing, and it will be the fourth phase built on migrations nobody has run |

---

## 20. Stop

**Phase 4 is complete. Phase 5 has not been started and will not be started without
independent verification and explicit approval.**

No supervision, no reconciliation, no timers, no lease renewal, no settlement, no
cancellation, no reassignment, no scheduling, no routing optimisation, and no allocation
heuristic beyond Phase 4 was implemented. `ENGINE_ENABLED` is `false`; no running code
path calls `commit()`, and the outbox worker is not started.
