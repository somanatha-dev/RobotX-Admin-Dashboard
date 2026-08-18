# Phase 5 — Independent Software Verification Report

> **RESOLUTION UPDATE — 2026-08-17.** Every finding below was independently reproduced against the
> current tree and resolved. **No finding in this document has been removed, softened, or reworded**;
> this banner and the closing table are the only additions.
>
> | # | Finding | Severity | Resolution |
> |---|---|---|---|
> | 1 | `transitions.leaseExpiryTarget` treats `DISPUTED` custody as `NONE` | Medium-High | **FIXED.** Reproduced exactly as described. Fixed at root cause — the resolver now reports `leases.assessRecovery`'s decision instead of restating it — which also closed two further drifts in the same function this review did not reach. 5 regression tests, all proved to fail against the old semantics. |
> | 2 | A third Phase-4-scope fix (`registerOfferHandlers` wiring) was undisclosed | Low-Moderate | **DOCUMENTATION CORRECTED.** Disclosed as §0.3 of `PHASE_5_IMPLEMENTATION_REPORT.md`. The code was already correct. |
> | 3 | `timers.register`'s `FORBIDDEN_VERSION_SOURCES` check inspects the wrong object | Low | **FIXED.** The guard now inspects `input.entity`. Verified against the live schema that no supervised entity kind carries an agent-scope counter, so no legitimate row can be refused. 6 regression tests. |
> | — | Part 7's *unverified* caveat: concurrent registration of one timer key | Low | **VERIFIED SAFE.** Reproduced against live PostgreSQL by forcing the interleaving: the loser receives `P2002` and one timer exists. The documented "return the existing row" is not safely implementable inside the caller's transaction, so the module's comment was corrected rather than its code. |
> | — | Part 4.4's inherited gap: no migration executed against live PostgreSQL | Elevated | **DISCHARGED for Phase 5.** 21/21 migrations applied to a disposable PostgreSQL 18.3 instance; `tools/verify/phase5LiveDatabase.js` drove the shipped modules against it — **105/105 checks**. Including this review's own named highest-risk item: `Timer.entityVersion` round-trips `2^53 + 1` exactly. |
>
> One finding this review did **not** make was found during remediation: four of §12.4's ten
> divergence classes had no test that constructed their divergence, and passed the full-sweep
> assertion vacuously (a scan that detects nothing reports zero and passes). Fixed; see
> **`PHASE_5_REMEDIATION_AND_CLOSURE.md`** §3, finding 4.
>
> **Phase 5 is now CLOSED.** This review's verdict of *PASS WITH MINOR ISSUES* was accurate when
> written and remained accurate until 2026-08-17.

**Verifier role:** Independent Software Verification Engineer (did not implement Phase 5; did not
redesign, optimise, simplify, or implement anything during this review)
**Date:** 2026-08-03 · **Branch:** `feature/dashboard` · **Working tree at verification:** `4244b3d`
+ uncommitted Phases 1–5 (unchanged from the state `PHASE_5_IMPLEMENTATION_REPORT.md` was written
against)
**Method:** Every PASS below is backed by a command this review ran, a file this review read in
full, a spec quotation checked against the file and line it cites, or a reproduction script this
review wrote and executed against the live, unmodified shipped code. `PHASE_5_IMPLEMENTATION_REPORT.md`
was read to understand what was claimed and was **not** trusted for any claim reported here as
PASS, PARTIAL, or FAIL.

---

## 0. Scope discipline, and the prerequisite the implementer discharged first

This review covers Phase 5 only: `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` §4.2, §4.3, §4.4, §4.5,
§4.6, §4.7, §4.9, §12 (Supervision and Reconciliation) — against `IMPLEMENTATION_EXECUTION_PLAN.md`
§3 "PHASE 5" and its §7 checklist.

**The Phase 4 remediation claimed in the implementation report's §0 was independently re-verified,
not trusted.** `PHASE_4_INDEPENDENT_VERIFICATION.md` recorded a **FAIL** with two blocking issues.
Both are confirmed corrected in the current working tree:

| Phase 4 blocking issue | Independently confirmed |
|---|---|
| Finding 1 — `VirtualRobot._onMissionCommand`/`_onAgentCommand` revert-on-failure could erase a concurrent, already-applied command | **Confirmed fixed.** `VirtualRobot.js:523-530` (`_withDedupLock`) is a real promise-chain mutex serialising the whole read-decide-write-persist critical section; both handlers (`:614-665`, `:685-...`) now compare-and-restore (`stillOurs` check) rather than unconditionally overwrite. Read in full. |
| Finding 2 — `offers.withdrawExpiredOffer` had zero production callers; `UNACKNOWLEDGED` rows were invisible to the SLI and reset-suppression | **Confirmed fixed.** `outbox.worker.js:257-319` (`performWithdrawal`) calls `offers.withdrawExpiredOffer` inside its own transaction and settles the row to `FAILED`; `outbox.js:105-109` now includes `UNACKNOWLEDGED` in `OUTSTANDING_STATES`, and a separate `DELIVERY_OBLIGATION_STATES` (excluding it) governs `expirePastValidity` so an unanswered offer is not discharged by its own envelope going stale. |

Both corrections are structurally sound (read in full, not sampled). `PHASE_0_INDEPENDENT_VERIFICATION.md`
still does not exist in the repository — the same documentation gap Phase 4's review disclosed
and did not block on; this review does not block on it either, for the same reason (Phase 0's
scaffold tests are still exercised by every later phase's suite, including this one).

A **third, undisclosed** Phase-4-scope change was found bundled into the same diff — see Part 9,
finding 2. It is a correct fix, not a defect, but it was not reported the way the other two were.

---

## PART 1 — Phase 5 checklist (`IMPLEMENTATION_EXECUTION_PLAN.md` §7)

| # | Item | Verdict | Evidence |
|---|---|---|---|
| 1 | Migration: `Timer`, `ReconcilerRepair`, `VerificationEvidence` | **PASS** | Independently regenerated via `npx prisma migrate diff --from-empty --to-schema-datamodel`; all three `CREATE TABLE` stanzas are **byte-for-byte identical** to the hand-written migration (Part 4). `Task.version` (an undocumented-by-the-plan but spec-required addition) also matches byte-for-byte inside the regenerated `CREATE TABLE "Task"`. |
| 2 | `supervision/timers.js` keyed on the supervised entity's own version, never the agent epoch | **PASS, with one documentation overstatement** | `VERSION_SOURCE` maps only `LEG→version`, `TASK→version`, `COMMITMENT→fence` — no entity kind maps to an agent-scope counter, which is the structural guarantee. The **auxiliary** `FORBIDDEN_VERSION_SOURCES` runtime check in `register()` (`timers.js:222-230`) does not actually inspect `input.entity`'s fields — it inspects the top-level call arguments — so it cannot catch an entity object that carries `authorityEpoch` alongside its `version`. Independently reproduced (Part 9, finding 1): `register()` does not throw and silently keys on the correct field anyway, because the *real* protection is the fixed `VERSION_SOURCE` lookup, not this check. Non-blocking; the invariant the row exists to protect still holds. |
| 3 | `workers/timer.worker.js` — at-least-once firing, idempotent handlers, timers attempt not force | **PASS** | `fireOne` (`timer.worker.js:100-141`) discards on stale version/state/entity-gone via `timers.assessFire` before ever calling a handler; an unregistered handler leaves the timer `PENDING` (not resolved) rather than silently discharging a deadline. Handler failures are caught and recorded as an outcome, never thrown into the pass loop. |
| 4 | `lifecycle/legMachine.js` — all §4.3 states incl. `STRANDED_SAFE`/`STRANDED_OBSTRUCTING` | **PASS** | 19 states verified against §4.3's table one row at a time; `LEG_DEADLINES` matches the deadline/on-expiry columns verbatim, including `LOADED: null`; `strandingStateFor` correctly resolves `CLEAR`/`RESTRICTIVE`→`STRANDED_SAFE` (different response targets) and `BLOCKING_CRITICAL`/absent/unrecognised→`STRANDED_OBSTRUCTING` under `DENY` semantics. |
| 5 | `lifecycle/taskMachine.js` — all §4.2 states incl. `AT_RISK` | **PASS** | 11 states verified against §4.2's table; `AT_RISK` is a first-class enum member with its own deadline (`sla.assignment_deadline`, matching the ladder it is supervised by); `statesWithoutDeadline()` is empty, matching the report's claim. |
| 6 | `lifecycle/transitions.js` — the complete §4.4 table with guards | **PARTIAL — one row is wrong for one custody state.** | The table's 27 rows were checked one at a time against §4.4. All match, **except** the `LEASE_EXPIRY` wildcard row's target resolver, `leaseExpiryTarget` (`transitions.js:402-409`), which tests `source.custodyState !== "HELD"` (a literal string comparison) rather than the domain predicate `custody.holdsGoods(...)`. **Independently reproduced** (Part 9, finding 1 — the review's principal finding): for `custodyState: "DISPUTED"`, `leaseExpiryTarget` returns `REASSIGNING` (the custody-`NONE` treatment), while the parallel, correctly-written implementation of the same §12.2/§4.7 decision, `supervision/leases.assessRecovery`, returns `PHYSICAL_RECOVERY` for the identical input. Every other guard and every other custody comparison in `transitions.js`, `cancellation.js`, `reassignment.js`, and `settlement.js` uses `custody.holdsGoods`/`custody.isDischarged` correctly; this one row is the outlier. |
| 7 | `supervision/leases.js` — per-commitment renewal on commitment-scoped positive evidence only | **PASS** | `renew()` delegates to Phase 3's `commitment/leases.isRenewalEvidenceSufficient` rather than restating it (no drift risk); the write is conditional on the commitment's version; `assessRecovery` chooses explicitly among Resume/Transfer/Physical-recovery/Reassign and never falls through silently — the unhandled case is the named, conservative default. |
| 8 | Lease expiry → custody-aware recovery assessment (§4.7) | **PASS in `leases.assessRecovery`; see item 6 for the parallel, disagreeing implementation in `transitions.js`.** | |
| 9 | `supervision/progress.js` — all five §12.3 signals | **PASS** | All five assessors read, each pure, each independently checked against its own row of §12.3's table (stall, ETA drift as a *multiplier* not an absolute, energy deviation one-sided and Wh-based, replan rate per-km against baseline with no invented tolerance, off-route excursion excluding agent-reported deviations). `assessAll` evaluates all five without short-circuiting. |
| 10 | `supervision/reconciler.js` — all nine (in fact ten, see Part 2) §12.4 divergence classes, each counted | **PASS** | All ten scan functions read in full; each records a categorised `ReconcilerRepair` row; escalation policy per row matches §12.4's "Escalate when" column; orphan Legs are correctly split into `EXPECTED_POST_FAILOVER` (a `PLANNED` Leg) vs `DEFECT` (anything else) and counted separately. The reconciler imports no socket and no dispatcher module directly (`grep` on its `require` list confirms), and commands an agent only through injected `deps.redispatch`/`deps.recover`/`deps.abortPhantom` callbacks whose implementations (in `reassignment.js`/`dispatch/*`) write their outbox row in the authorising transaction. |
| 11 | Distinguish post-failover `PLANNED` orphans from defect orphans in the orphan scan | **PASS** | `scanOrphanLegs` (`reconciler.js:152-231`): `ORPHAN_KIND.EXPECTED_POST_FAILOVER` for `PLANNED`, `ORPHAN_KIND.DEFECT` otherwise; both counted separately in the returned `counts` object. |
| 12 | `lifecycle/cancellation.js` — purpose-conditioned guard; custody-held spawns a `RECOVERY` Leg | **PASS** | `requestCancellation` writes only the flag and version (never a terminal state directly); `resolutionFor` correctly derives `CANCELLED_IMMEDIATELY`/`RECALL_THEN_CANCEL`/`RECOVERY_LEG_REQUIRED` from `custody.holdsGoods` and `hasHardCommitment`; `spawnRecoveryLeg` creates the `ABORTING` transition, the `RECOVERY` Leg, and its drop Stop, and refuses without a `recoveryDestination` rather than inventing one. |
| 13 | `lifecycle/reassignment.js` — fence advance and recall written in **one** transaction | **PASS** | `reassign()` (`reassignment.js:152-317`) performs the Leg freeze, fence allocation, `AgentFenceAudit` upsert, `RECALL` outbox enqueue, and commitment release inside the caller's single transaction; the custody bar (`custody.holdsGoods` refuses the custody-`NONE` protocol when goods are aboard) and the chain bound (`assessChainBound`, derived from released-commitment count rather than a separate counter) are both enforced before any write. `authorityEpochTouched: false` is asserted in the return value, matching I19. |
| 14 | Three lawful custody-`HELD` outcomes incl. `custody_transfer_capable` gating | **PASS** | `leases.assessRecovery` implements Resume/Transfer/Physical-recovery exactly per §4.7's table; `transferMissionSpecification` in `reassignment.js` requires `transferCapableReceiverAvailable === true` (positive evidence, not "unknown"), matching "the engine MUST NOT select an agent-to-agent transfer" when no transfer-capable class is deployed. |
| 15 | `lifecycle/settlement.js` — custody release strictly before commitment release (I7) | **PASS** | `settle()` checks `assertCustodyDischarged` (which itself checks the manifest, not only the custody enum, and treats `DISPUTED` as neither discharged nor "still held" — a third, correctly distinct refusal) **before** writing `SETTLED`, and only releases the commitment after the Leg write succeeds. `DISPUTED` is checked ahead of `holdsGoods` so an operator is routed to a contested-handover queue rather than a goods-aboard one, exactly as the report claims. |
| 16 | `supervision/verification.js` — L0–L3 with the three track-plausibility tests | **PASS** | All three tests (`testCoverage`, `testCorridor`, `testContinuity`) independently checked against §12.5's prose; each is shown to reject only its own class of crafted failure by inspection of its logic (coverage measures fixes/minute only; corridor measures corridor-membership fraction only, correctly `OR`-ing the planned and any reported corridors; continuity separates the gap failure from the kinematic-impossibility failure, and only the latter sets `securityEvent`). `verify()`'s level accumulation is correctly cumulative (L2/L3 cannot be reached if the L1 geometric check failed). |
| 17 | Absorb the offline sweep and `taskRecovery.service.js` into the reconciler | **PASS** | `socket.server.js`'s `startOfflineDetector` is now gated on `process.env.ENGINE_ENABLED !== "true"` (diff read in full); `taskRecovery.service.js` gained a documentation-only header, behaviour unchanged (`git diff --stat` shows only insertions, and every insertion is a comment block). |
| 18 | Add REST: `GET /api/legs/:legId/supervision` | **PASS** | Read in full. Returns 404 for an unknown Leg; the "owning" timer is correctly scoped to a `PENDING` timer matching **both** the Leg's current version and current state; `staleTimers` and `history` are correctly partitioned; the endpoint issues no write. Mounted behind the existing `authUser` middleware and a dedicated rate limiter. |
| — | **Gate:** reconciler repair rate is an alertable SLI; I3, I4, I7, I8, I12, I13 verifiable | **PASS for I3, I4, I7, I12; PARTIAL for I8 (see item 6); PARTIAL for I13 as the report itself discloses** | `readRepairRate` reports every category (even at zero) over a window, so a category that stopped reporting is distinguishable from one that is genuinely idle. I13 is honestly disclosed as half-implemented (the ladder itself is Phase 8's) rather than claimed complete. |

**Checklist result: 16/18 rows fully PASS as claimed. One row (6, and its consequence on 8 and the
I8 gate) is a genuine, reproduced defect: the `LEASE_EXPIRY` transition's target resolver disagrees
with the module the phase itself cites as I8's evidence, for `custodyState: "DISPUTED"`. One row (2)
carries a documentation overstatement about a defence-in-depth check that is not reachable through
the module's own call pattern but whose absence causes no actual defect, because the real protection
is structural.**

---

## PART 2 — Execution plan compliance: everything required, nothing omitted, nothing from later phases

| Check | Verdict | Evidence |
|---|---|---|
| Every Phase 5 scope item present | **PASS** | Durable timer store, timer worker, per-commitment lease renewal, lease-expiry recovery, progress supervision, reconciliation loop (all ten classes), graded completion verification (all three plausibility tests) — all present and read in full. |
| §12.4's class count: plan says nine, spec's table has ten | **Confirmed a real spec/plan discrepancy, correctly resolved by implementing the specification.** | `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` §12.4's table independently counted: 10 rows (Commitment-unknown-to-agent, Agent-reports-unknown-commitment, Orphan Leg, Commitment-on-terminal-Leg, Lease-expired-unprocessed, Custody-held-without-mission, Task-WAITING-beyond-SLA, Outbox-undelivered, Agent-absent-from-index, Energy-accounting-inconsistent). `reconciler.js`'s `DIVERGENCE` enum and the migration's `ReconcilerRepair_category_known` CHECK both admit exactly these ten. The plan's own stated precedence rule ("where this plan and the specification appear to disagree, the specification wins and this plan is defective") makes this the correct resolution, and it is recorded rather than silently reconciled in both documents — matching the discipline Phase 2 established for `TaskStatus`. |
| No Phase 6+ mechanism present | **PASS** | `find src/engine/feasibility src/engine/energy src/engine/payload src/engine/candidates src/engine/solve src/engine/plan src/engine/routing -name "*.js"` → **0 files** for every directory, independently re-run. |
| `ENGINE_ENABLED` remains the master switch and is off | **PASS** | Every new integration point checked: `feedProgressSupervision` (`telemetry.handler.js`) returns `null` immediately if `process.env.ENGINE_ENABLED !== "true"`; `verifyCompletionClaim` (`dtaro.handler.js`) does the same; `offer.handler.js`'s `handle()` checks the switch as the first statement inside its `try`; neither `timer.worker.js` nor `reconciler.worker.js` is started from `server.js` (`grep -n "timer.worker\|reconciler.worker" server.js` → no matches). |
| Tier gate: no Tier 0/1 → Tier 2 import | **PASS** | Fresh `gate:tiers` run (Part 10): 120 modules, 102 governed edges, 0 violations. |
| TIERS.md completeness for Phase 5's own modules | **PASS** | `T0-08` names all five `supervision/*.js` modules and both new workers; `T0-07` names `lifecycle/settlement.js`; `T1-05` names `lifecycle/cancellation.js` and `reassignment.js`; the remaining lifecycle modules (`legMachine.js`, `taskMachine.js`, `transitions.js`) correctly fall to the `src/engine/` → Tier 1 default under the documented "longest prefix wins" rule — read directly from `TIERS.md:150-186`. |

**Verdict: PASS**, with the ten-vs-nine discrepancy correctly identified, disclosed, and resolved
per the plan's own precedence rule (not a Phase 5 defect).

---

## PART 3 — Architecture compliance

| Rule | Verdict | Evidence |
|---|---|---|
| §4.1 rule 1 — every non-terminal state has an owner and a deadline | **PASS** | `legMachine.statesWithoutDeadline()` independently evaluated: returns `["LOADED"]`, matching §4.3's own em-dash and the report's claim. `taskMachine.statesWithoutDeadline()` returns `[]`. |
| §4.1 rule 2 — every transition is a conditional write | **PASS** | `transitions.apply`, `settlement.settle`, `cancellation.requestCancellation`/`spawnRecoveryLeg`, `reassignment.reassign`, `leases.renew` — every write path read and confirmed to use `updateMany` keyed on the observed version, checking `.count !== 1` for a lost race, never an unconditional `update`. |
| §4.1 rule 3 — state never inferred from absence | **PASS** | `transitions.js`'s `required()` helper fails `*_INDETERMINATE` (not silently true) when evidence is absent; `progress.assessStall` treats an unmeasurable route progress as a *fired* stall signal rather than a clear one; `settlement.assertCustodyDischarged` treats an unrecognised custody state as not discharged. |
| §4.1 rule 4 — physical reality outranks the database | **PASS** | `reconciler.scanCustodyWithoutMission` performs **no repair**, only escalation, when custody is held with no active mission — verified by reading the function; there is no code path in it that writes to the Leg or Commitment tables. |
| §4.1 rule 5 — no side effect before its authorising write | **PASS** | `reassignment.reassign` writes the `RECALL` outbox row inside the same transaction as the fence advance and commitment release (single `tx` parameter, no `$transaction` call inside the function — it *is* the transaction body); `cancellation.spawnRecoveryLeg` creates the `RECOVERY` Leg inside the same transaction as the `ABORTING` write. |
| §4.5 — keyed on the entity's own version | **PASS structurally; see Part 1 item 2 for the one non-functional auxiliary check.** | |
| §3.3 — cache authority | **PASS** | `grep -rln "cache/kv\|ioredis" src/engine/supervision/` → zero matches, independently confirmed. `engine:timerlag` is written only from `timer.worker.js`, outside `supervision/`. |
| §10.6 — the store's clock | **PASS** | Both workers' `requireDeps`/construction paths require `readStoreTime` as a function and throw otherwise; deadlines are computed from `storeTime`, never `Date.now()`, in every scan and handler read. |
| §22.1 — no behavioural constant outside the register | **PASS, with one item flagged for attention before it matters.** | Fresh `gate:params` run: PASS, 48 modules / 153 parameters, 0 bare constants (Part 10). Two integration points (`telemetry.handler.js`'s `feedProgressSupervision`, `dtaro.handler.js`'s `readVerificationThresholds`) resolve thresholds via `process.env.SUPERVISE_STALL_TIME_SECONDS` / `VERIFY_*` environment variables rather than the Config Service register directly — acceptable as inert, transitional wiring (both are dead while `ENGINE_ENABLED` is false and the gate does not cover env-var reads), but the env var names are a second naming scheme alongside the register's dotted names and are not verified to agree with anything the register will eventually resolve to. Not a gate violation; a forward-looking wiring note for Phase 15. |
| §1.8 rule 2 — no Tier 0/1 → Tier 2 | **PASS** | Confirmed in Part 2 and Part 10. |
| §2.6 / I18 — no SOFT reservation persisted | **PASS** | The one `durable: false` row in `TRANSITIONS` (`PLANNED`→`PLANNED` on `REPLAN_SELECTS_ANOTHER_AGENT`) is handled by `apply()` with an early return before any `tx.leg.updateMany` call — verified by reading the function; no write occurs on that path. |
| I19 — settlement and reassignment leave `authority_epoch` alone | **PASS** | Neither `settlement.settle` nor `reassignment.reassign` writes `agent.authorityEpoch` anywhere in the function body (confirmed by reading both in full); both return `authorityEpochTouched: false` as an explicit, checkable claim rather than a silent omission. |

**Verdict: PASS.** No architectural drift found. The one genuine defect (Part 1 item 6) is a logic
error within a Tier 1 module, not a boundary or layering violation.

---

## PART 4 — Database review

### 4.1 Independent regeneration of Prisma's own SQL

```
$ npx prisma validate
The schema at prisma\schema.prisma is valid

$ npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > gen_full.sql
$ grep -A24 'CREATE TABLE "Timer"' gen_full.sql                # byte-identical to migration.sql
$ grep -A16 'CREATE TABLE "ReconcilerRepair"' gen_full.sql      # byte-identical
$ grep -A24 'CREATE TABLE "VerificationEvidence"' gen_full.sql  # byte-identical
$ awk '/^CREATE TABLE "Task" \(/,/^\);/' gen_full.sql | grep version
    "version" INTEGER NOT NULL DEFAULT 0,                       # matches the hand-written ADD COLUMN
$ grep -n "CHECK" gen_full.sql | grep -i "Timer_\|ReconcilerRepair_\|VerificationEvidence_"
(zero matches — confirms the seven CHECKs are genuine hand-written additions, not derivable from
 schema.prisma alone; schema.prisma has no `@@check`/native-check preview feature enabled)
```

**Verdict: PASS**, independently reproduced, same technique the Phase 3 and Phase 4 reviews used.

### 4.2 Additivity

- `Task` gains one column (`version`, defaulted, `INTEGER NOT NULL DEFAULT 0`) — every existing row
  remains valid.
- No pre-existing table is altered beyond the one `ADD COLUMN`; the only new foreign key
  (`VerificationEvidence.legId → Leg.id`) points *from* the new table, not into any existing one.
- `Commitment_kind_hard_only` (Phase 3) and the five Phase 4 CHECKs are untouched — confirmed not
  restated or modified in this migration.

**Verdict: PASS.**

### 4.3 Indexes, constraints, and the CHECK backstops

Read all seven CHECK constraints in full against their justifying comments. `ReconcilerRepair_category_known`
correctly admits all **ten** divergence-class names (matching Part 2's finding, and matching
`reconciler.js`'s `DIVERGENCE` enum exactly, member for member). `VerificationEvidence_levels_known`
and `_outcome_known` match `verification.js`'s `LEVEL`/`OUTCOME` enums exactly. `Timer_entity_type_known`
matches `timers.js`'s `ENTITY_TYPE`. Every CHECK is a closed enumeration that mirrors a JS enum
module exports — if a future call site introduced a new category string without updating both, the
CHECK (not the application) would be what caught it, matching the report's stated design intent.

Indexes: `Timer(dueAt)` (the plan's named index) plus `(timerState, dueAt)` for the due-sweep query
and `(entityType, entityId, timerState)` for the cancel-sweep/operator-view query — both composite
indexes are actually used by the queries `timers.due()` and `legs.controller.js`'s lookup issue,
respectively (read and confirmed the `where` clauses match the index columns' left-to-right prefix).

**Verdict: PASS.**

### 4.4 What remains unverified against a live database

Unchanged from every prior phase's disclosure: no migration in this programme has been applied to a
live PostgreSQL instance, and this review did not have access to one and did not attempt to obtain
or bypass credentials for the instance referenced in `.env`. This is the **fifth** consecutive phase
to carry this recommendation forward. This phase's migration is, in one respect, higher-risk than
Phase 4's: it is the first to add a `BIGINT` column (`Timer.entityVersion`) compared against a JS
`BigInt` throughout the application code, and the first whose CHECK list must stay in lock-step with
a runtime enum with **ten** members rather than a handful — both are cheap to verify against a real
instance and, per the pattern in Part 9's findings, exactly the kind of thing static review is
weakest at catching.

**Verdict: PASS on every statically verifiable property; the live-execution gap is inherited and
disclosed, not new. Given this is now the fifth phase to carry it, this review repeats the
recommendation with the same force Phase 4's review did: discharge it before Phase 6 adds a sixth
untested migration.**

---

## PART 5 — API review

| Check | Verdict | Evidence |
|---|---|---|
| Request validation | **PASS — N/A input, N/A validation surface** | `GET /api/legs/:legId/supervision` takes only a path parameter, coerced with `String(req.params.legId \|\| "")`; no body, no query parameters to validate. |
| Response contracts | **PASS** | No existing REST route, request shape, response shape, or status code changed — confirmed by `git diff --stat` scoped to `src/routes/` and `src/controllers/` showing only new files plus the one-line mount in `index.js`. |
| Backwards compatibility | **PASS** | New mount point only; no socket event renamed, removed, or re-typed (`SUPERVISION_SIGNAL` is additive-only, emitted to the `dashboard` room exactly like the pre-existing `robot:update`). |
| Authorisation/authentication | **PASS** | The route sits behind the pre-existing `authUser` middleware (`legs.routes.js:8`), inheriting the same authentication as every other `/api` route, plus its own rate limiter (120/min, distinct key prefix). |
| Error handling | **PASS** | `getSupervision` is wrapped in the codebase's standard `asyncHandler`; a missing Leg returns 404 with a small, non-leaking body (`{ error, legId }`) rather than a stack trace or a 500. |
| Idempotency | **PASS — read-only** | The endpoint performs zero writes (confirmed by reading the full controller: only `findUnique`/`findMany` calls), so idempotency is structural rather than a property to test. |

---

## PART 6 — Runtime behaviour

| Property | Verdict | Evidence |
|---|---|---|
| Execution order (guard → conditional write → timer cancel/register, one transaction) | **PASS** | Traced `transitions.apply` line by line (`transitions.js:634-752`): cancellation guard → per-row guards → conditional `leg.updateMany` → `timers.cancelFor` → `timers.register`, all inside the caller's `tx`, matching §4.5's "in the transaction that enters or exits the supervised state" requirement. |
| State transitions (the §4.4 table) | **PASS for 26 of 27 rows; FAIL for 1 — see Part 1 item 6 / Part 9 finding 1.** | |
| Retry/at-least-once firing | **PASS** | `timer.worker.js`'s `resolve()` is conditional on the timer still being `PENDING` (`updateMany` with `timerState: PENDING` in the `where`), so two workers racing the same due timer produce one resolution and one no-op — traced by hand, consistent with the Phase 3/4 pattern for the same race shape. |
| Timeout handling (deadline expiry → attempted transition) | **PASS** | `fireOne` discards stale-version/state-changed/entity-gone timers before invoking a handler, and an unregistered handler leaves the row `PENDING` (counted toward lag) rather than silently resolving — matches the report's claim and §12.1's own stated failure mode being avoided. |
| Failure recovery / consistency under restart | **PASS for the timer store's own crash safety** | Registration inside the transition's transaction (not a separate write) is what the report claims prevents "written afterwards is lost by a crash between the two writes" — verified structurally: there is no code path where `transitions.apply` commits the Leg write without also having registered/cancelled timers in the same `tx`, because both happen before the function returns and nothing between them awaits an external call. |
| Reconciler idempotence | **PASS** | Every scan's repair action is itself a conditional write (`updateMany` on version/`releasedAt IS NULL`, or an unconditional `create` on the append-only `ReconcilerRepair`/audit tables) — a sweep that runs twice over the same divergence performs the state repair once (second `updateMany` matches 0 rows) but **does write a second `ReconcilerRepair` row** each time it observes the divergence (e.g. `scanCustodyWithoutMission`, `scanWaitingTasks`, `scanUndeliveredOutbox` write on every sweep that still finds the condition true, by design — they are escalations, not one-shot repairs). This is consistent with §12.4 ("every repair is counted") for genuinely recurring escalations, but means "idempotent" in the plan's sense applies to the *state repair*, not to the *repair ledger volume*, for the `ALWAYS`/`ON_LADDER_STEP_3` escalation rows — worth noting for whoever sets the per-category rate's alert threshold, not a defect. |

---

## PART 7 — Concurrency review

| Scenario | Verdict | Evidence |
|---|---|---|
| Two supervisors (timer handler vs. reconciler) racing the same Leg | **PASS** | Both ultimately route through `transitions.apply`/direct `updateMany` calls conditioned on `leg.version`; the loser's write affects 0 rows and returns `LOST_RACE`/is silently skipped — traced for the specific pairing `scanExpiredLeases` (reconciler) vs. a lease-expiry timer handler (not yet wired, but the code path both would call, `leases.assessRecovery` + a conditional write, is symmetric). |
| Two reconciler sweeps overlapping (event-driven `nudge` vs. periodic `sweepOnce`) | **PASS** | `nudge` calls `sweepOnce` with `batch: 1`; both run the identical scan functions, each of which is individually idempotent per Part 6, so an overlapping pair produces at most one applied repair and one no-op. |
| Registering a timer twice for the same (entity, state, version, handler) | **PASS** | `timers.register` reads-before-write (`findUnique` on the unique `timerKey`) and returns the existing row rather than creating a duplicate — correct, though note this is a check-then-act rather than a database-level `upsert`/unique-constraint-catch; the `timerKey` column *is* `@unique`, so a genuine race between two concurrent `register()` calls for the same key would raise a unique-constraint violation on the loser's `create` rather than silently returning the winner's row. This is safe (no duplicate is possible) but the loser's caller receives a thrown error rather than the idempotent "return the existing row" the comment describes as the intended behaviour for a "retried transition, or a reconciler repair racing a timer handler." Low severity — within one transaction this is not reachable (transactions in this codebase are not otherwise shown to run two `register()` calls for the same key concurrently), but it is a gap between the documented guarantee ("Idempotent on the key… yields one timer rather than two") and what happens under true concurrent registration from two different transactions. |
| Reassignment vs. cancellation on the same Leg | **PASS** | Both are conditional on `leg.version`; `reassign`'s custody bar (`custody.holdsGoods`) and `cancellation`'s purpose-conditioned guard are independent checks that both correctly refuse when the Leg has already moved (via the version CAS) rather than by coordinating with each other directly. |
| Cache loss (I16) | **PASS** | `grep -rln "cache/kv\|ioredis" src/engine/supervision/` → zero matches (Part 3); `writeAdvisory` in `timer.worker.js` catches and swallows any cache write failure, explicitly documented as advisory-only. |

**Concurrency finding:** the one genuine defect in this review (Part 9, finding 1) is **not** a
concurrency defect — `leaseExpiryTarget`'s wrong answer for `DISPUTED` custody is deterministic and
reproducible with no race involved; it is a pure logic error.

---

## PART 8 — Implementation quality

Genuine, independently-verified findings only, reported in full in Part 9. Summary:

1. **No duplicated logic across the bulk of the surface.** `cancellation.js`, `reassignment.js`,
   `settlement.js`, and `reconciler.js` all correctly call `custody.holdsGoods`/`custody.isDischarged`
   rather than reimplementing custody semantics — a real strength, and why the one place that does
   *not* (`transitions.leaseExpiryTarget`) stands out as an inconsistency rather than a house style.
2. **Consistent naming and tier ownership** across all thirteen new modules and two workers; `TIERS.md`
   was updated correctly and completely for this phase (Part 2).
3. **One minor duplicated-logic-by-value risk**: `reconciler.js`'s `HOLDING_CUSTODY_STATES =
   ["HELD", "PENDING_TRANSFER", "DISPUTED"]` is exactly the complement of `custody.isDischarged`'s
   `{NONE, RELEASED}` set, maintained as a separately-listed array rather than derived from the
   canonical predicate. Currently correct (verified by cross-checking against `custody.js`'s five
   states), but a future addition to `CUSTODY_STATES` would need this array updated by hand in a
   second place, which is exactly the drift risk the module's own comments elsewhere warn against
   ("Restating it would produce two definitions… that could drift, invisible until…"). Low severity.
4. **The `FORBIDDEN_VERSION_SOURCES` runtime guard in `timers.register` does not do what its own
   error message and the module's header comment claim** — see Part 9, finding 3. Low severity, no
   actual correctness consequence, but a documentation/implementation-quality gap of the same shape
   Phase 4's review flagged for `escalation.js`'s own comments being more honest than the
   implementation report in one place and less complete in another.

---

## PART 9 — Findings, independently reproduced

### 9.1 Finding 1 (MEDIUM-HIGH, reproduced): `transitions.leaseExpiryTarget` resolves a `DISPUTED`-custody Leg as if custody were `NONE`, contradicting the module the phase's own completion table cites as I8's evidence

**What the specification requires (§12.2):** *"Lease expiry does not itself abort the mission. It
transitions the Leg to a recovery assessment whose outcome depends on custody (§4.7): `REASSIGNING`
when custody is `NONE`, `STRANDED_SAFE` or `STRANDED_OBSTRUCTING` … when custody is `HELD` and the
agent is unreachable."* Custody has five states (§2.5), not two; `DISPUTED` ("evidence conflicts…
not knowing resolves to the conservative case") is used *everywhere else* in this phase's own code
as the same conservative case as `HELD` — `custody.holdsGoods("DISPUTED") === true`, and every other
module in this phase (`settlement.assertCustodyDischarged`, `cancellation.resolutionFor`,
`reassignment.reassign`'s custody bar, `reconciler.scanOrphanLegs`) treats it that way.

**What `transitions.js` actually does** (`transitions.js:402-409`):

```js
function leaseExpiryTarget(context) {
  const source = context || {};
  if (source.custodyState !== "HELD") return S.REASSIGNING;
  if (source.agentReachable === true && source.withinResumeWindow === true) return S.REASSIGNING;
  return legMachine.strandingStateFor(source.obstructionClass).state;
}
```

A literal string comparison against `"HELD"`. `DISPUTED` fails this test and falls straight into
`REASSIGNING` — the treatment §4.7 reserves for custody `NONE`, a "scheduling problem." This is the
wildcard row applied to `EVENT.LEASE_EXPIRY` from `ANY_NON_TERMINAL`, so it is reachable, once wired,
from **any** non-terminal Leg state whose lease expires, including `RELEASED` — the state in which a
`DISPUTED` classification (conflicting release evidence) is most likely to actually occur, and in
which the Leg's HARD commitment is still active (commitments are released at settlement, not at
release, per §4.9).

**Independently reproduced**, against the real, unmodified module, with no changes to any shipped file:

```
$ node -e '
const transitions = require("./src/engine/lifecycle/transitions");
const leases = require("./src/engine/supervision/leases");
const custody = require("./src/engine/domain/custody");

const legContext = { custodyState: "DISPUTED", obstructionClass: "CLEAR" };
console.log("custody.holdsGoods(DISPUTED) =", custody.holdsGoods("DISPUTED"));
console.log("transitions.leaseExpiryTarget(...) =", transitions.leaseExpiryTarget(legContext));
console.log("leases.assessRecovery(...) outcome =", leases.assessRecovery({ leg: {}, custodyState: "DISPUTED" }).outcome);
'
custody.holdsGoods(DISPUTED) = true
transitions.leaseExpiryTarget(...) = REASSIGNING
leases.assessRecovery(...) outcome = PHYSICAL_RECOVERY
```

Two implementations of the same §12.2/§4.7 decision, both shipped in this phase, disagree on the
identical input. `leases.assessRecovery` (used by `reconciler.scanExpiredLeases`, the reconciler's
own safety-net path for a lease that expired and was not yet processed) gives the conservative,
spec-conforming answer. `transitions.leaseExpiryTarget` (embedded directly in the §4.4 table that
`transitions.apply` executes, and the surface the phase's own test suite exercises for this decision
— `tests/engine/lifecycleTransitions.test.js:86-101` tests only `"NONE"` and `"HELD"`, never
`"DISPUTED"`) gives the wrong one.

**Why this matters for the phase's own claims, not just as an abstract inconsistency:** the Phase 5
self-verification table states *"I8 verifiable ✅ — The custody audit; `assessRecovery`'s DISPUTED
handling"* — citing `assessRecovery`'s correct `DISPUTED` handling as the evidence for I8
("Custody `HELD` always has exactly one accountable agent or custodian"). That citation is accurate
for `assessRecovery`, but the phase also ships a second code path, tested and graded as part of the
same §4.4 completion criterion, that does not have the property being cited. A future caller reading
"I8 verifiable" and choosing `transitions.apply`'s `LEASE_EXPIRY` event (the one visible in the
public transition table, rather than reaching for `leases.assessRecovery` directly) inherits the
wrong answer.

**Reachability today:** not live. `EVENT.LEASE_EXPIRY` has no production caller anywhere in
`src/` outside `transitions.js` itself and its own tests (`grep -rn "EVENT.LEASE_EXPIRY"` confirms
this) — consistent with the phase's own Known Limitation #7 ("`transitions.js` is imported by
nothing in Tier 0 yet… the handler map that would connect a fired timer to `transitions.apply` is
Phase 15's bootstrap"). This is why the finding is rated MEDIUM-HIGH and not HIGH/blocking: unlike
Phase 4's two blocking findings, which were reproduced against code paths that **are** exercised by
running production code today (the simulator's command handlers; the outbox worker's drain pass),
this defect sits in a data table with zero current callers. It is nonetheless a genuine,
specification-violating logic error in delivered, tested, and completion-graded code, on a Tier 0
safety invariant (I8), and it must be corrected before Phase 15 wires a `LEASE_EXPIRY` timer handler
to `transitions.apply` — wiring it unfixed would introduce exactly the failure class §4.1 rule 4
exists to prevent ("physical reality outranks the database… escalates to a human") for the one
custody state designed to be the most conservative.

**Classification:** correctness / specification compliance, Tier 1 module (`src/engine/lifecycle/`),
invariant I8. **Required correction:** replace the literal `source.custodyState !== "HELD"` test with
`!custody.holdsGoods(source.custodyState)` (matching every other custody comparison in this phase),
and add a test case for `custodyState: "DISPUTED"` to `lifecycleTransitions.test.js` alongside the
existing `"NONE"`/`"HELD"` cases, asserting agreement with `leases.assessRecovery`.

### 9.2 Finding 2 (LOW-MODERATE, documentation/disclosure): a third Phase-4-scope fix — wiring `registerOfferHandlers` into `socket.server.js` — was made but not disclosed in §0

Phase 4 shipped `src/sockets/handlers/offer.handler.js` (the `OFFER_ACCEPT`/`OFFER_REJECT`/
`OFFER_DEFER` handlers) and `PHASE_4_INDEPENDENT_VERIFICATION.md` passed it ("Three events, gated on
`ENGINE_ENABLED` and `socket.data.isAuthed`, each its own `prisma.$transaction`"). Neither that
review nor the Phase 4 implementation report checked whether the function was ever *called* from
`initSocketServer`. Independently confirmed it was not, at the Phase 4 base state:

```
$ git show 4244b3d:Backend/src/sockets/socket.server.js | grep -n "offer"
(no matches)
$ grep -rn "registerOfferHandlers" Backend/src/
src/sockets/handlers/offer.handler.js:67   (definition)
src/sockets/socket.server.js:7             (import — added in the current working tree)
src/sockets/socket.server.js:276           (call — added in the current working tree)
```

The current working tree's `socket.server.js` diff (which, like every phase's diff in this
programme, is layered uncommitted on the same base commit) now calls `registerOfferHandlers` for
every socket connection, labelled in its own inline comment `// PHASE 4 — §11.2 offer responses`.
This is a **correct fix** — without it, Phase 4's offer-response mechanism could never receive a
real socket event regardless of `ENGINE_ENABLED`, which is a gap of the same shape as Phase 4's
disclosed Finding 2 (a mechanism built and tested but never reachable). The fix is inert today
(`offer.handler.js`'s `handle()` checks `engineEnabled()` as its first statement), so it introduces
no behavioural change while the engine is off.

What is missing is disclosure. `PHASE_5_IMPLEMENTATION_REPORT.md` §0 explicitly enumerates two
Phase-4-scope corrections made before Phase 5 began, with reproduction detail for each, "because
they are Phase 4's scope and must be re-verified as such." This third correction is not mentioned
there, and the report's "Files Modified" entry for `socket.server.js` describes only the offline-sweep
gating (item 17 of Part 1), not the offer-handler wiring — so the entry undersells what changed in
that file. Given the report's own stated standard for disclosing Phase-4-scope fixes, this should
have been listed alongside the other two.

**Classification:** documentation / process, not a code defect. **Recommendation:** add this as a
third item to §0 of the implementation report (or a note in Part 1's checklist), naming it as a
correction to Phase 4's checklist item 6, so the record of what Phase 4 actually shipped is complete.

### 9.3 Finding 3 (LOW, implementation quality): `timers.register`'s `FORBIDDEN_VERSION_SOURCES` check inspects the wrong object and cannot fire through the module's own call pattern

Covered in Part 1 item 2 and Part 8 item 4. Reproduced in Part 1's evidence column (`register()`
does not throw when the `entity` object carries an `authorityEpoch` field alongside its real
`version`). **No correctness consequence** — the actual protection (`VERSION_SOURCE` mapping only
`version`/`fence`, never reading anything named `authorityEpoch`) is sound and independently
verified to hold. **Recommendation:** either change the check to inspect `source.entity`'s own keys,
or remove it and rely on (and document reliance on) the structural guarantee alone, so the code does
not claim a defence it does not provide.

---

## PART 10 — Regression review

```
$ npm run gates
gate: tier-dependencies (§1.8 rule 2)          PASS — 120 module(s), 102 governed edge(s), 0 violations
gate: parameter-register (§22, Appendix A)     PASS — 48 module(s) / 153 parameter(s), 0 bare constants
gate: tenets (T1, T6)                          PASS — 117 module(s), 0 violations

$ npx jest --selectProjects legacy --runInBand --forceExit
Test Suites: 22 passed, 22 total
Tests:       169 passed, 169 total
```

Identical to the count every prior phase (0, 1, 2, 3, 4) recorded as its own inherited baseline —
independently re-run, not copied from the report. `git diff --stat` confirms no existing REST route,
no existing socket event, and no existing test file lost coverage (only `phase0Scaffold.test.js` was
modified among pre-existing tracked test files, and its diff is purely additive: +137/-8, the -8
being widened assertions that grew rather than shrank the ownership list, read in full).

**Verdict: PASS.** Zero legacy regressions, zero prior-phase gate regressions.

---

## PART 11 — Build and test review

```
$ npm run verify
gate: tier-dependencies (§1.8 rule 2)          PASS — 120 module(s), 102 governed edge(s), 0 violations
gate: parameter-register (§22, Appendix A)     PASS — 48 module(s) / 153 parameter(s), 0 bare constants
gate: tenets (T1 type separation, T6 decision-path determinism)   PASS — 117 module(s), 0 violations
Test Suites: 57 passed, 57 total
Tests:       1235 passed, 1235 total
```

Fresh run, matches the report's own numbers exactly (module counts, edge counts, parameter counts,
suite/test totals). This review did not independently re-derive every one of the 1,235 tests' logic,
but did read all four new Phase 5 test files' structure and a substantial sample of their assertions
against the modules they cover, and independently exercised the one path (`leaseExpiryTarget` with
`DISPUTED`) the suite does not cover (Part 9, finding 1).

**Verdict: PASS on everything the shipped suite checks.** The suite has one coverage gap identified
in Part 9 (finding 1) large enough to hide a real, specification-violating defect — the same shape
of gap Phase 4's review found twice in that phase's suite.

---

## PART 12 — Failure analysis

| Scenario | Verdict | Evidence |
|---|---|---|
| Invalid/malformed request (supervision endpoint) | **PASS** | `getSupervision` coerces `legId` to a string and returns 404 for a non-existent one; no other input surface exists on this endpoint. |
| Duplicate/concurrent timer registration for one key | **PASS, with the caveat in Part 7** | Read-before-write returns the existing row for a sequential retry; a genuinely concurrent race across two transactions would raise a unique-constraint error rather than return the existing row — safe, but not the described idempotent return. |
| Process crash / restart (timer worker mid-sweep) | **PASS, reasoned** | At-least-once firing plus the version-staleness discard rule is exactly what the plan's stated chaos requirement ("kill the timer worker mid-sweep; assert no missed transition after restart") needs: a timer not yet resolved when the worker dies is simply picked up by the next pass, and if the underlying transition already happened by some other path, the discard rule (not reliable cancellation) is what makes the late fire harmless. `tests/engine/supervisionWorkers.test.js` is described by the report as covering this chaos case; this review did not independently re-run a live process-kill but did verify the discard-rule code path that makes such a test meaningful. |
| Database failure mid-sweep | **Not independently verifiable against a live instance (inherited, Part 4.4)** | Reasoned: `sweepOnce`/`fireDue`'s per-scan and per-timer operations are each their own store call; a thrown error from one would propagate to the worker's own `tick`/`catch`, recorded as `*.pass_failed`/`*.sweep_failed`, with the next tick retrying — reasoned safe, consistent with Phase 4's equivalent finding, not proven against a live outage. |
| Custody `HELD`/`DISPUTED` with no active mission | **PASS** | `scanCustodyWithoutMission` escalates and writes nothing else — verified no repair write exists on this path (Part 3). |
| Settlement racing a concurrent custody-flag write | **PASS** | `settle()` reads the manifest and custody state and refuses if either shows goods outstanding, rather than trusting a prior check — matches I7's "highest-severity alert on violation" framing; the check is re-performed at settlement time, not assumed from an earlier read. |
| Lease expiry with `DISPUTED` custody | **FAIL — Part 9, finding 1.** | The one reproduced defect in this review. |
| Cancellation racing an in-flight round | **PASS** | The purpose-conditioned guard (`cancel_requested_at IS NULL OR purpose ∈ custodial_purposes`) is applied to every transition except `CANCEL_REQUEST` itself in `transitions.apply` (`transitions.js:655-665`), matching §4.6 rule 2 exactly, including the load-bearing exemption for `RECOVERY`/`TRANSFER` Legs. |
| Retry exhaustion (reassignment chain) | **PASS** | `assessChainBound` derives the chain length from released-commitment count (no separate counter to fall out of step) and correctly returns `SUSPENDED` with the Task-level disposition, rather than looping, once `recover.max_reassignments_per_leg` is reached. |

---

## PART 13 — Evidence summary

- **Files inspected in full:** `supervision/timers.js`, `leases.js`, `progress.js`, `reconciler.js`
  (808 lines), `verification.js`; `lifecycle/legMachine.js`, `taskMachine.js`, `transitions.js`
  (795 lines), `settlement.js`, `cancellation.js`, `reassignment.js`; `workers/timer.worker.js`,
  `reconciler.worker.js`; `controllers/legs.controller.js`, `routes/legs.routes.js`; the full diffs
  of `socket.server.js`, `taskRecovery.service.js`, `telemetry.handler.js`, `dtaro.handler.js`,
  `routes/index.js`, `config/register/supplementary.json`; `simulation/VirtualRobot.js`'s
  `_withDedupLock` and both critical sections (re-verification of Phase 4's remediation);
  `workers/outbox.worker.js`'s `performWithdrawal`/`escalateOutstanding` (same); the migration SQL
  in full; `domain/custody.js` in full (as the cross-reference for Part 9's principal finding).
- **Tests executed:** `npm run verify` (fresh); `npx jest --selectProjects legacy --runInBand
  --forceExit` (fresh); `npx prisma validate`; `npx prisma migrate diff --from-empty
  --to-schema-datamodel` (fresh, byte-diffed by hand against the migration); two standalone
  reproduction scripts executed directly against the shipped, unmodified code (the
  `FORBIDDEN_VERSION_SOURCES` non-functional-check reproduction, and the `leaseExpiryTarget`
  vs. `assessRecovery` disagreement reproduction).
- **Runtime verification performed:** both reproduction scripts (real execution, not reasoning);
  the byte-diff of all three `CREATE TABLE` stanzas plus the `Task.version` column addition and the
  absence of the seven CHECKs from the fresh generation (real execution).
- **Migrations reviewed:** `20260803210000_supervision_and_reconciliation/migration.sql`,
  independently regenerated and byte-diffed against a fresh `prisma migrate diff --from-empty`.
- **APIs inspected:** `GET /api/legs/:legId/supervision` (new); confirmed zero other REST or socket
  surface changed shape.
- **Architecture sections verified:** §4.1 (all five rules), §4.2, §4.3, §4.4 (all 27 rows), §4.5,
  §4.6, §4.7, §4.9, §12.1–§12.5, §26 (I2, I3, I4, I7, I8, I11, I12, I13, I18, I19).

---

## PART 14 — FINAL DECISION

# PASS WITH MINOR ISSUES

Phase 6 may begin.

This decision reflects that the overwhelming majority of Phase 5 — the durable timer store and its
keying discipline, the timer and reconciler workers, all ten §12.4 divergence scans, the three
track-plausibility verification tests, settlement's I7 ordering, cancellation's purpose-conditioned
guard, and reassignment's single-transaction protocol — was read in full, independently
cross-checked against the specification section by section, and found to match. The migration is
byte-identical to independently regenerated Prisma SQL. All build gates and all 1,235 tests pass,
freshly re-run rather than trusted from the report. Both of Phase 4's disclosed blocking issues are
genuinely corrected, not merely marked so.

One reproduced defect, one disclosure gap, and one non-functional defence-in-depth check keep this
from a clean PASS:

| # | Issue | Severity | Category | Affected files | Recommendation |
|---|---|---|---|---|---|
| 1 | `transitions.leaseExpiryTarget` treats `DISPUTED` custody as `NONE` (routes to `REASSIGNING`), disagreeing with `supervision/leases.assessRecovery` (routes to `PHYSICAL_RECOVERY`) for the identical input, and disagreeing with every other custody comparison in this phase's own code | **Medium-High** — a genuine, reproduced, specification-violating logic error in delivered, completion-graded code touching a Tier 0 invariant (I8); not currently live because nothing calls `transitions.apply` with `EVENT.LEASE_EXPIRY` yet (Phase 15's bootstrap wires it) | Implementation / specification compliance | `Backend/src/engine/lifecycle/transitions.js:402-409`; contrast with `Backend/src/engine/supervision/leases.js:187-247` | Replace the literal comparison with `!custody.holdsGoods(source.custodyState)`; add a `DISPUTED` test case to `tests/engine/lifecycleTransitions.test.js` asserting agreement with `leases.assessRecovery`. **Must be fixed before Phase 15 wires a `LEASE_EXPIRY` timer handler to `transitions.apply`**; does not block Phase 6, which does not depend on this wiring. |
| 2 | A third Phase-4-scope correction (wiring `registerOfferHandlers` into `socket.server.js`) was made in this phase's diff but not disclosed in §0 alongside the other two, and the "Files Modified" entry for `socket.server.js` describes only the offline-sweep change | Low-Moderate | Documentation / process | `Backend/src/sockets/socket.server.js` (diff); `PHASE_5_IMPLEMENTATION_REPORT.md` §0, §5 | Add this as a third disclosed correction to §0, naming it as closing a gap in Phase 4 checklist item 6. |
| 3 | `timers.register`'s `FORBIDDEN_VERSION_SOURCES` runtime check inspects the top-level call arguments, not the `entity` object it is meant to guard, so it cannot actually catch an entity carrying an agent-scope field — the module's real protection is the fixed `VERSION_SOURCE` map, which is sound, but the auxiliary check and its own error message overstate what it does | Low | Implementation quality | `Backend/src/engine/supervision/timers.js:203-230` | Either fix the check to inspect `source.entity`'s keys, or remove it and document that the `VERSION_SOURCE` map is the sole guarantee. |

None of these three issues indicates the phase's design is wrong. Issue 1 is a one-line logic error
in an otherwise carefully and consistently written module, in code with no current production
caller; issues 2 and 3 have no correctness consequence at all. **Phase 6 may begin.** Issue 1 should
be tracked and fixed before Phase 15's bootstrap connects `transitions.js`'s `LEASE_EXPIRY` row to a
live timer handler — at that point, unfixed, it would put a `DISPUTED`-custody Leg through the
custody-`NONE` reassignment protocol instead of §4.7's physical-recovery path, which is precisely
the class of error §4.1 rule 4 exists to prevent.

### What must happen before Phase 15 (not before Phase 6)

1. Fix and add regression coverage for issue 1 (`leaseExpiryTarget`'s `DISPUTED` handling).
2. Disclose issue 2 in the phase's own record, for the same reason the report's §0 discipline exists.
3. Issue 3 may be scheduled at the tech lead's discretion.
4. §14 item 6 of the implementation report (no migration applied to a live PostgreSQL instance) is
   now five phases deep; this review repeats the recommendation to discharge it before it compounds
   further, without making it a blocking condition for Phase 6 — consistent with how Phase 3 and
   Phase 4's reviews treated the same inherited item.

> **[2026-08-17] All four discharged.** Items 1–3 are fixed or disclosed and item 4 is discharged
> for Phase 5, as recorded in the banner at the top of this document and in detail in
> `PHASE_5_REMEDIATION_AND_CLOSURE.md`.
>
> This list was written as a pre-Phase-15 condition. Phase 15 has since landed (`cbe540e`,
> `62d8141`) **with item 1 still open** — the condition was not enforced at the time, and the defect
> reached the tree Phase 15 was built on. It caused no live harm, because Phase 15's bootstrap does
> not yet connect a fired timer to `transitions.apply` and `EVENT.LEASE_EXPIRY` still has no
> production caller, which is exactly the reachability this review used to rate the finding
> Medium-High rather than blocking. The sequencing risk it identified was real nonetheless, and is
> worth recording: a finding scheduled against a future phase needs an owner at that phase, not only
> a note in the phase that found it.

---

## Appendix — Commands and scripts run for this verification (reproducible)

```
npm run verify                                                     # 3 gates PASS, 57/1235, fresh
npx jest --selectProjects legacy --runInBand --forceExit           # 22/169, fresh
npx prisma validate
npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > gen_full.sql
grep -A24 'CREATE TABLE "Timer"' gen_full.sql                       # byte-diff against migration.sql
grep -A16 'CREATE TABLE "ReconcilerRepair"' gen_full.sql
grep -A24 'CREATE TABLE "VerificationEvidence"' gen_full.sql
awk '/^CREATE TABLE "Task" \(/,/^\);/' gen_full.sql | grep version  # matches the ADD COLUMN
grep -n "CHECK" gen_full.sql | grep -i "Timer_\|ReconcilerRepair_\|VerificationEvidence_"  # zero
find src/engine/{feasibility,energy,payload,candidates,solve,plan,routing} -name "*.js" | wc -l  # 0, each
grep -rn "registerOfferHandlers" Backend/src/                       # confirms the undisclosed wiring fix
git show 4244b3d:Backend/src/sockets/socket.server.js | grep -n "offer"   # confirms absent at Phase-4 base
node -e '<FORBIDDEN_VERSION_SOURCES non-functional-check reproduction; full output in Part 1 item 2>'
node -e '<leaseExpiryTarget vs. leases.assessRecovery DISPUTED-custody disagreement; full output in Part 9.1>'
git diff --stat -- Backend/src/sockets/socket.server.js Backend/src/services/taskRecovery.service.js \
  Backend/src/sockets/handlers/telemetry.handler.js Backend/src/sockets/handlers/dtaro.handler.js \
  Backend/src/routes/index.js
git diff -- Backend/src/sockets/socket.server.js                   # read in full
git diff -- Backend/src/services/taskRecovery.service.js           # read in full
git diff -- Backend/src/sockets/handlers/telemetry.handler.js      # read in full
git diff -- Backend/src/sockets/handlers/dtaro.handler.js          # read in full
git diff -- Backend/src/engine/config/register/supplementary.json  # read in full
grep -n "T0-08\|T0-07\|T1-05\|supervision/\|lifecycle/" src/engine/TIERS.md
```

Working tree left clean; no scratch files remain in the repository (the two reproduction scripts and
`gen_full.sql` were run from the session's own scratch area / inline `node -e`, not committed).
