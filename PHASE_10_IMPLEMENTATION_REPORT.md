# Phase 10 — Implementation Report

**Role:** Senior Distributed Systems Engineer implementing the frozen architecture
**Scope:** `IMPLEMENTATION_EXECUTION_PLAN.md` §3 "PHASE 10 — Round loop and solve (L4 → L3)",
implementing `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` §9 in full together with §3.4's request path,
§3.2's Work Queue, §2.6's round-local plan state, and §20.5's admission control
**Date:** 2026-08-05 · **Branch:** `feature/dashboard` · **Baseline:** Phase 9, independently
verified ("PASS WITH MINOR ISSUES" — `PHASE_9_INDEPENDENT_VERIFICATION.md` — "**Phase 10 may
begin**"), uncommitted on top of `cf9103f`
**Phase 11 or later:** not implemented. `src/engine/observability/`, `degraded/`, `failure/`,
`map/`, and `fairness/` remain empty.

---

## 1. Executive Summary

Phase 10 delivers §9 of the frozen architecture — the adaptive round cadence (§9.2), the
set-partitioning formulation over columns with its deferral variable (§9.3), the singleton-regime
min-cost flow with exact integer duals and zero LP–IP gap (§9.3), the five solve budgets with
anytime behaviour (§9.4), spatial partitioning that provably never severs a column (§9.4), and the
determinism requirements that make a round replayable (§9.6) — together with §3.4's request path,
§3.2's durable Work Queue, §2.6's in-memory-only SOFT reservations, and §20.5's admission control.

Ten new modules, two new Prisma models (`WorkQueue`, `Round`) with a hand-written migration
cross-checked against Prisma's own generated SQL, one new background worker (unscheduled, per the
established convention), two new registered parameters, and nine new test files (212 tests). Three
existing files were rewired: `task.service.js`, `tasks.controller.js`, and `socket.server.js`.

`npm run verify` (all three build gates, then all three Jest lanes) is green: **87 suites, 4,917
tests, 0 failures.** The legacy lane is unchanged at 169/169 — Phase 9's own baseline — confirming
zero behavioural regression in the path Phase 15's cutover has not yet reached.

**One deviation from the checklist's literal wording is recorded rather than glossed, and it was
put to the architecture's owner before any code was written.** The checklist says "Remove the
`setImmediate` detached assignment from `task.service.js`"; Phase 15's own row says it retires "the
legacy assignment path in `task.service.js`" and is where `ENGINE_ENABLED=true` is staged and every
engine worker moves "from shadow to production scheduling". Deleting the detach now, with the
coordinator unscheduled like every other engine worker, would leave the durable queue with nothing
draining it and no task assigned between this phase and the cutover. The strangler gate every phase
since 3 has used was applied instead: **the engine path contains no detached background assignment;
the legacy branch still does, reachable only while `ENGINE_ENABLED` is false, and Phase 15 removes
it entirely.** §14 records the full disposition, and `tests/engine/intakeStranglerSeam.test.js`
asserts the shape rather than leaving it to prose.

One genuine implementation bug was found and fixed during self-verification (§11): `claimBatch()`
re-read a row's own `version` field *after* writing it, so with a client returning live references
the claimed version was double-incremented and settlement silently matched nothing — every claimed
Leg would have been stranded in `CLAIMED` forever. It was caught by this phase's own coordinator
tests, not by inspection.

---

## 2. Objectives Achieved

Cross-referencing `IMPLEMENTATION_EXECUTION_PLAN.md`'s Phase 10 checklist (§7) item by item:

| # | Checklist item | Status |
|---|---|---|
| 1 | Migration: `WorkQueue`, `Round` | **Done** — §5 |
| 2 | `intake/intake.js` — validate, admit, deduplicate, resolve shard, enqueue durably | **Done** |
| 3 | `POST /api/tasks/assign` returns task id, idempotency echo, queue position, honest predicted window | **Done**, additively — §7 |
| 4 | **Remove the `setImmediate` detached assignment from `task.service.js`** | **Partial and disclosed** — removed from the engine path; retained on the legacy branch behind `ENGINE_ENABLED`. See §1 and §14 |
| 5 | `intake/admission.js` — purpose-keyed then class-keyed shedding; `custodial_purposes` never shed | **Done** — the refusal is structural, read before the ladder |
| 6 | `solve/cadence.js` — fast / nominal / loaded / saturated; early close on material supply change | **Done**, plus the two prose bounds §9.2's table does not carry — §6 |
| 7 | Fast path **literally** the batch path at `|L| = 1` (enforced by a build-time test) | **Done** — four assertions, including a source scan proving nothing downstream branches on the regime |
| 8 | `shard/planState.js` — round-local SOFT reservations, **in memory only** | **Done** — serialisation throws; I18 checkable against a real store |
| 9 | `solve/objective.js` — coverage and exclusivity per §1.4 | **Done** — exclusivity is `≤ 1` per **agent**, never per capacity slot |
| 10 | `solve/minCostFlow.js` for the singleton regime | **Done** — exact, integral, zero LP–IP gap, exact integer duals |
| 11 | `solve/regime.js` — regime per round, recorded; never assert a guarantee out of regime | **Done** — `assertClaim()` throws; duals are labelled, not bare |
| 12 | `solve/budgets.js` — all five §9.4 bounds with anytime behaviour | **Done** |
| 13 | Spatial partitioning that never severs a column spanning a boundary | **Done** — §9.4's *second* condition implemented, not just the first |
| 14 | `workers/coordinator.worker.js` — the full round pipeline | **Done**, unscheduled |
| 15 | Wire commit (Phase 3), dispatch (Phase 4), supervision (Phase 5) into the round | **Done** — commit injected; dispatch rides the commit's outbox row (§10.3.2 step 5) |
| 16 | Emit a Tier A decision record for every decision incl. deferral reason | **Done**, with the Phase 11 boundary stated — §6 |
| 17 | Tests: singleton reports zero LP–IP gap; multi-Leg round never reports exact-integer duals | **Done** — the regime-guarantee test (§24.1) |
| 18 | Test: replay reproduces the allocation and per-candidate costs byte-for-byte | **Done**, with a scope caveat — §13 item 2 |
| 19 | Chaos: kill the coordinator with SOFT reservations outstanding | **Done** — all re-planned, none lost, none double-committed |
| 20 | **Gate:** no detached background assignment remains; every round produces a decision record | **Partial (item 4) / Done** — the second half is mechanically asserted |

---

## 3. Files Created

**Engine modules (`Backend/src/engine/`):**

| File | Lines | Purpose |
|---|---|---|
| `intake/intake.js` | 626 | §3.4 — the request path: validate, admit, deduplicate, resolve shard, enqueue durably, quote an honest window |
| `intake/admission.js` | 385 | §20.5 — quotas, global admission, the published shed ladder; `custodial_purposes` structurally never shed |
| `shard/planState.js` | 417 | §2.6 — round-local SOFT reservations that refuse to serialise; §19.5's reconstruction procedure |
| `solve/cadence.js` | 350 | §9.2 — the four regimes, the SLA-fraction bound, early close, the fast-path-is-batch-path assertion |
| `solve/regime.js` | 298 | §9.3 — regime from the generated column set; guarantee entitlement; labelled duals |
| `solve/budgets.js` | 390 | §9.4 — the five bounds, the monotone incumbent, the replay-pinned wall clock |
| `solve/objective.js` | 408 | §1.4/§9.3 — the set-partitioning instance, its two constraint families, the deferral variable |
| `solve/minCostFlow.js` | 558 | §9.3 — successive shortest paths with Johnson potentials over lexicographic costs |
| `solve/round.js` | 676 | §9 — the round: candidates → columns → regime → partition → solve → reserve → commit → record |

**Worker:** `Backend/src/workers/coordinator.worker.js` (622 lines) — leadership, claim, plan,
commit, settle, record, plus `resumeAfterFailover()`. Unscheduled, per the convention every worker
since Phase 4 has followed while `ENGINE_ENABLED` is false.

**Migration:** `prisma/migrations/20260805170000_round_loop_and_work_queue/migration.sql` (160 lines).

**Tests (`Backend/tests/engine/`):** `solveMinCostFlow.test.js`, `solveObjective.test.js`,
`solveCadenceRegimeBudgets.test.js`, `intakeRequestPath.test.js`, `shardPlanState.test.js`,
`solveRound.test.js`, `coordinatorRound.test.js`, `roundSchema.test.js`,
`intakeStranglerSeam.test.js`, plus `tests/engine/helpers/roundFixture.js`.

## 4. Files Modified

| File | Change |
|---|---|
| `Backend/prisma/schema.prisma` | New `WorkQueue` and `Round` models; new `Leg.workQueueEntry` back-relation |
| `Backend/src/engine/config/register/supplementary.json` | Two new entries — `solve.batch_growth_threshold`, `solve.max_window_sla_fraction`. See §10 for the reformatting note |
| `Backend/src/services/task.service.js` | `assignTask` becomes a router; `admitToRound()` bridges a legacy Task to §3.4's request path; the detach extracted into the single named, gated `legacyDetachedAssignment()` |
| `Backend/src/controllers/tasks.controller.js` | §3.4 fields added **beside** `{ ok, task }`; an intake decline surfaces as 429 (or 400 for invalid) with its honest sentence |
| `Backend/src/sockets/socket.server.js` | `assign_task` routed to intake through the same router; `task_accepted` emitted beside the unchanged legacy `task_assigned` |
| `Backend/tests/engine/commitmentSchema.test.js` | Boundary moved to Phase 11; `WorkQueue`/`Round` presence asserted; new I18 schema assertion (no provisional agent binding on either table) |
| `Backend/tests/engine/costSchema.test.js` | Same boundary move; the `solve`/`intake` emptiness assertion becomes the Phase 11/12 directory assertion |
| `Backend/tests/engine/phase0Scaffold.test.js` | `PHASE_10_OWNED = ["intake/", "solve/", "shard/planState.js"]` added to the engine-tree ownership walk |

No file outside this list and the "Files Created" list was touched. In particular
`src/engine/guards/tierAssertions.js`, `src/engine/TIERS.md`, `src/engine/guards/tenets.js`, and
`src/engine/config/validators.js` were **not** modified — see §10 for why each was unnecessary.

---

## 5. Database Changes

Two new tables, additive only.

**`WorkQueue`** — §3.2's "durable priority queue of pending Legs per shard". One row per Leg
(`legId` unique, FK → `Leg.id`, `onDelete: Cascade`), `idempotencyKey` unique, `purpose` and
`slaClass` denormalised so admission control can decide without a join, a derived `priority`, a
`state`, `availableAt` for §4.3 DEFERRED, `claimedByRoundId`/`claimedAt`, `roundsConsidered`,
`consecutiveDeferrals`/`firstDeferredAt`, the `predictedWindow` as quoted (so §21.5 can score it),
and a `version` for the conditional writes every transition is. Four indexes.

**`Round`** — one row per round: `roundId` unique, `shardId`, `decisionTime`, `leadershipFence`,
`coordinatorInstance`, `snapshotRefs`, `seed`, `cadenceRegime`/`windowMs`, `regime`, `budgets`,
three counts, `outcome`, and the two gaps **as separate string columns** (`searchGapMilliCU`,
`lpIpGapMilliCU` — strings because int64 milli-CU does not survive a JSON number). Three indexes.

**What the migration deliberately does not contain.** No SOFT-reservation table and **no
provisional-agent column on `WorkQueue`**. §2.6 is categorical, and a `plannedAgentId` column would
be that forbidden state under a different table name — it would put the re-planning rate inside the
durable path that §3.5's shard-sizing arithmetic depends on it not being.
`commitmentSchema.test.js` asserts this against the schema text, not against the modules that
respect it.

Three hand-written CHECK constraints Prisma cannot express: `WorkQueue_state_known`,
`Round_regime_known` (the closed regime vocabulary — a round claiming an unrecognised regime could
claim any guarantee), and `WorkQueue_deferral_counts_non_negative`.

Every `CREATE TABLE`/`CREATE INDEX`/`ADD CONSTRAINT` was taken verbatim from
`prisma migrate diff --from-empty --to-schema-datamodel`; `roundSchema.test.js` re-runs that diff
and asserts byte equality modulo whitespace, and asserts the three CHECKs are **absent** from
Prisma's output — which is what proves they are genuine hand-written additions rather than an echo.

**Not applied to a live database**, consistent with every phase since 6. `npx prisma validate` and
`npx prisma generate` both succeed. `prisma migrate diff --from-empty` requires no live connection
and was used instead.

---

## 6. Runtime Behaviour

`ENGINE_ENABLED` remains `false`. `coordinator.worker.js` is not started from `server.js` or
`src/app.js` (grep-confirmed, and `roundSchema.test.js` asserts the worker's only timer is its own
supervised loop and that it is `unref`'d).

**With the engine off**, `assignTask` behaves exactly as before: a `PENDING` row, a `TASK_CREATED`
emit, and the legacy DTARO continuation. The 169-test legacy lane is unchanged.

**With the engine on**, `assignTask` materialises the Mission/Leg/Stops from the legacy Task via
Phase 2's `domain/mappers/legacyTask.taskToWork()` (deterministic ids, so a retry converges),
writes one durable `WorkQueue` row, and returns the §3.4 contract. The legacy selector is never
reached — asserted, not assumed.

**The round, end to end:** leadership → store clock → cadence → claim batch (conditional write on
`(state, version)`) → pin the snapshot → `round.plan()` (L4, pure) → `commit` (L3, injected) →
settle the queue → write `Round` + one `DecisionRecordA` per Leg → publish the advisory liveness key.

Two orderings are load-bearing and are stated in the worker rather than left implicit:

- **Leadership before anything.** Guard G1 fences the commit itself, so a stale leader could not
  write in any case; one that *planned* would still spend routing budget and emit decision records
  for a shard it does not own.
- **Settle after the commit, never before.** A queue row moved to `SOLVED` before its commit landed
  would be a Leg removed from the queue with no commitment to show for it — the audit's "stuck at
  PENDING with no record" reproduced one layer down. An assignment whose commit aborted returns to
  `QUEUED`, and a round that *throws* returns its whole batch.

**Determinism.** `solve/` reads no clock and no random source — asserted by a source scan in
`roundSchema.test.js` in addition to `guards/tenets.js`'s T6 gate. The single wall-clock read is
`determinism/snapshot.captureDecisionTime()` in the coordinator, and the §9.4 wall-clock budget is
an injected `elapsedMs()` function reference.

**Tier A records, and the Phase 11 boundary.** Phase 10 writes one `DecisionRecordA` row per Leg
per round — identity, leadership fence, decision time, outcome, and the search/solve bounds
including the regime and the guarantees it is entitled to assert. Phase 11 owns the full §21.2
shape (every version, the Ω values, degradation, sampling, the Explanation API). Sections this
phase cannot yet populate are left `null` rather than fabricated: a record with an honestly empty
section is reconstructible; an absent record is not.

---

## 7. API Changes

**`POST /api/tasks/assign` — additive.** `{ ok, task }` is unchanged for every existing consumer;
`intake` arrives beside it when the engine's request path ran:

```json
{ "ok": true, "task": { … }, "intake": {
    "outcome": "ACCEPTED", "accepted": true, "assigned": false,
    "taskId": "TSK-1", "legId": "…", "shardId": "default",
    "idempotencyKey": "derived:…", "idempotencyKeyEchoed": false,
    "queuePosition": 1,
    "predictedAssignmentWindow": { "basis": "QUEUE_AND_CADENCE", "earliestMs": …,
        "expectedMs": …, "latestMs": …, "roundsAhead": 1, "atRisk": false, "sentence": "…" },
    "sentence": "intake succeeded and assignment is in progress. …" } }
```

`accepted` and `assigned` are separate fields precisely so that no rendering can conflate them —
§3.4's "the response MUST NOT imply an assignment has occurred" is a property of the shape, not of
the caller's discipline. An intake **decline** (§20.5) returns HTTP 429 (or 400 for a validation
failure) with the honest sentence in the body; a decline is a first-class outcome, not an error.

The change is additive **deliberately**: Phase 15's own row is where "Legacy `POST
/api/tasks/assign` response contract [is] formally superseded by the §3.4 contract; API version
note published to consumers", and the Frontend is scheduled for update in that same window.

No existing endpoint's behaviour, response shape, or route changed. No new endpoint was added —
§9's execution-plan row specifies none.

---

## 8. Redis Changes

Two new keys, both **advisory** (§3.3 — the cache tier holds no correctness-critical sole copy):

- `engine:queue:{shard}` — the queue-depth mirror for a fast peek. **The database is
  authoritative**; the round reads its own state from Postgres and never from here.
- `engine:round:{shard}:current` — **liveness only**, with a TTL derived from the round window. It
  is never a lock: leadership (§19.5) and guard G1 are, and a Redis key a partitioned coordinator
  could still hold would be exactly the cache-carried exclusivity §3.1 removes.

Both writes are wrapped and degrade to a no-op on failure (asserted). **SOFT reservations are never
written to Redis or Postgres** — `planState.js`'s reservations throw on serialisation, so an
accidental `kv.set(JSON.stringify(...))` fails loudly at the moment of the mistake. No existing key
or its semantics changed. Only the existing `kv.set` primitive is used; no new `kv` capability was
added.

---

## 9. Socket.IO Changes

`assign_task` is routed to intake — structurally, not by a second call site: `taskService.assignTask`
is itself the router, so the socket handler and the REST controller reach §3.4's request path
through one function and cannot disagree about admission, shedding, or the queue position they
quote.

The legacy `task_assigned` emit is **unchanged** (the Frontend listens for it; Phase 15 owns
retiring these events). `task_accepted` is emitted *beside* it when the engine's request path ran,
carrying the honest contract. The event name matters: `task_assigned` for a Leg that has merely been
queued is precisely the conflation §3.4 forbids in the REST response, and it would be no less wrong
over a socket.

No other socket event was added, removed, or changed.

---

## 10. Architecture Compliance

**Tier placement.** §1.8 names admission control explicitly (T1-06,
`intake/intake.js` + `intake/admission.js`) and names three `solve/` modules as **Tier 2** —
`batch.js` (T2-01), `setPartitioning.js` (T2-02), `localSearch.js` (T2-08) — none of which this
phase creates. Every module Phase 10 does create lands at Tier 1 via the existing `src/engine/`
and `src/workers/` catch-alls in `MODULE_TIERS`; **no new row was needed and none was added**.
`roundSchema.test.js` asserts `tierOf()` for all ten. `tools/gates/checkTierDependencies.js`
confirms mechanically: 224 modules, 288 governed import edges, zero Tier 0/1 → Tier 2 edges.

**The two Tier 2 injection seams, and why neither is an import.**

- **`C_defer`** (T2-04, kill switch `deferral`) is Tier 2 and `solve/objective.js` is Tier 1, so the
  deferral price arrives as **data on each Leg**, computed by the composition root — the same shape
  Phase 9 used for `Ω_terminal` and Phase 8 for `C_opportunity`. `roundSchema.test.js` asserts by
  source-grep that no `solve/` module requires `cost/cDefer`, `cost/cChurn`, `pricing/`, or
  `plan/insertion`.
- **The column regime** (T2-02) is *recognised and refused*, not implemented. `regime.determine()`
  classifies a set containing a multi-Leg column honestly, `solverAvailable()` reports that no
  solver is registered, and the round records `REGIME_UNSOLVABLE` per Leg — rather than pretending
  the set is singleton (which would assert an integrality guarantee that does not hold) or throwing
  (which would make the outcome a crash instead of a recorded one). That is §22.5 rule 1's shape.

**§22.5 rule 1 without a big-M — the one non-obvious construction, stated.** With the `deferral`
switch thrown there is no `y[l]` variable, yet the flow still needs every Leg to reach the sink. The
obvious device — a large constant on a "remain queued" arc — is exactly what §1.3 prohibits: an
unregistered number that decides behaviour and that the optimiser is entitled to pay once real costs
grow. So costs in the flow are **lexicographic pairs `(unassigned, milliCU)`**: addition is
componentwise, comparison is lexicographic, and the pair is an ordered abelian group, which is all
successive-shortest-paths requires. The remain-queued arc costs `(1, 0)` and every other arc
`(0, …)`. The result is §22.5's degraded behaviour *exactly as written* — "immediate assignment when
any feasible candidate exists" — expressed as a priority no configuration of real costs can outbid,
with no constant invented. `solveMinCostFlow.test.js` asserts that a 9,000,000 CU assignment still
beats leaving the Leg unassigned.

**Exactness with negative `γ`.** `C_opportunity` can make a column price negative, which a naive
Dijkstra would mis-solve silently. The initial network is a DAG in the order `S < Legs < Agents < T`,
so the initial Johnson potentials are exact from one relaxation pass in node-index order, and every
subsequent search runs on non-negative reduced costs. Tested directly with four negative prices
where the greedy answer differs from the optimum.

**§9.4's second partitioning condition, implemented rather than assumed.** The plan is explicit that
"two components sharing no feasible agent **and no common column** cannot influence each other. The
second condition … is not implied by the first". `round.partition()` therefore unions **every Leg a
column covers** together with its agent, not just the `(Leg, agent)` pair. In the singleton regime
the extra union is a no-op — which is exactly why it had to be written now, while it is provably
harmless, rather than discovered missing when multi-Leg columns arrive at Phase 16d. Tested with a
three-column instance whose two Legs have disjoint agent sets and are linked only by a shared column.

**Exclusivity is `≤ 1` per agent, never per capacity slot.** This is the one line where getting the
formulation wrong reintroduces the arc-capacity error §9.3 rejects, arrived at through the
constraint matrix instead of through the network. It is stated in `objective.js`, in
`minCostFlow.js`, and asserted in both test files.

**T1 / I14.** Both `objective.buildInstance()` and `regime.determine()` assert the feasibility brand
before doing anything. The second may look like an odd place for the check — classification is not
pricing — but the regime is what *authorises the guarantee claims* about the priced allocation, and
a regime determined over a column the gate never admitted would authorise a claim about work that
was never eligible. Tested with an unbranded plan and with a JSON-round-tripped one.

**The two parameters this phase adds, and why they were needed.** §9.2 names
`solve.batch_growth_threshold` in its Loaded row and Appendix A does not tabulate it, so the cadence
rule could not be evaluated without it. §9.2 also requires the window to "be bounded so that [it] can
never consume a meaningful fraction of any mission's SLA budget" without naming a parameter for
"meaningful fraction" — and a bound with no registered number is a bound implemented as a code
constant, which is what §22 and the parameter build gate exist to prevent. Both are in
`supplementary.json`, whose stated purpose is exactly "parameters the specification's text names or
requires, which Appendix A's table does not tabulate". `solve.max_window_sla_fraction` is `POLICY`
and owned by Product, because it trades customer-visible latency against allocation quality, which is
not an engineering tuning decision.

**A disclosed side effect on `supplementary.json`.** A scripted append reformatted the whole file
before the mistake was caught. It was reconstructed so that the 17 entries present in `HEAD` are
**byte-identical** to `HEAD` (verified by reparse and comparison) and the diff is purely additive.
The 33 entries added by the uncommitted Phases 6–9 were re-emitted in the register's original
compact style; no parameter, value, or field was lost or altered — verified programmatically,
key by key. This is disclosed rather than left for a reviewer to notice in a diff.

**`resolveShard`'s two cases — an interpretive call, stated.** §3.5 says every Leg is routed by its
first Stop's region. Read literally against a codebase where regions are not yet a deployed concept
(Phase 13 owns the `Shard` table and its map), that would decline every Leg for the absence of
configuration. The implemented rule turns on whether a **map has been published**: with one, a Leg
with no region or an unmapped region is *refused* (routing it to a fallback shard would hand it to a
coordinator owning none of the agents that could serve it, and it would then age on the §17.4 ladder
against a shard that was never able to help); with none, the single-shard identity every phase since
3 has used applies. The basis is recorded in the result (`resolvedBy`) rather than inferred.

---

## 11. Test Results

`npm run verify` (all three build gates, then all three Jest lanes):

```
gate: tier-dependencies (§1.8 rule 2)      PASS — 224 modules, 288 edges, 0 violations
gate: parameter-register (§22, Appendix A) PASS — 143 modules, 188 registered params, 0 bare constants
gate: tenets (T1 type separation, T6)      PASS — 221 modules, 0 violations

Test Suites: 87 passed, 87 total
Tests:       4917 passed, 4917 total
```

By lane:

- **engine**: 62 suites (53 pre-existing, unchanged, + **9 new**), **4,699 tests**. Phase 10's own
  nine files contribute **212**.
- **legacy**: **169/169**, unchanged from Phase 9's reported baseline — zero behavioural regression
  in the legacy dispatcher.
- **gates**: **49/49**, unchanged.

**The plan's four named testing requirements, and where each is discharged:**

| Requirement | Where |
|---|---|
| Singleton regime solved by min-cost flow, reporting **zero LP–IP gap** | `solveMinCostFlow.test.js` — "reports ZERO LP–IP gap, and the bound equals the objective" |
| A round with any multi-Leg column MUST NOT report exact-integer duals (§24.1) | `solveCadenceRegimeBudgets.test.js` — "REGIME GUARANTEE TEST" |
| Fast path is literally the batch path at one Leg, **enforced by a build-time test** | `solveCadenceRegimeBudgets.test.js` — four assertions incl. a source scan proving no `solve/` module outside `cadence.js` mentions `FAST_PATH`; `solveRound.test.js` — a one-Leg round and a two-Leg round return the same keys, regime, and guarantees |
| Replay reproduces the allocation and per-candidate costs byte-for-byte | `solveRound.test.js` — an all-equal-cost instance, where the allocation is decided entirely by the canonical order |
| Anytime: exceeding the budget returns the incumbent, never nothing, never a hang | `solveCadenceRegimeBudgets.test.js`, `solveMinCostFlow.test.js`, `solveRound.test.js` |
| Failover with SOFT reservations outstanding: all re-planned, none lost, none double-committed | `coordinatorRound.test.js` — "§19.5 — failover" and "CHAOS" |

**One real bug, caught by this suite rather than by review.** `coordinatorRound.test.js`'s five
settlement tests all failed with rows stuck in `CLAIMED`. The cause: `claimBatch()` built its
returned row as `{ ...row, version: row.version + 1 }` **after** the `updateMany` — so with a client
returning live references the version was incremented twice, and `settleBatch()`'s conditional write
on `(id, version)` then matched nothing. Every claimed Leg would have been stranded in `CLAIMED`
forever, which is precisely the failure this phase exists to remove, arrived at from the inside.
Fixed by capturing `observedVersion`/`claimedVersion` before the write; the test double was also
corrected to return copies, as a real Prisma client does, so the class of defect cannot hide again.

---

## 12. Self-Verification

- [x] Every Phase 10 checklist item implemented (§2), with item 4's partial status disclosed in §1,
      §2, and §14 rather than claimed complete.
- [x] No Phase 11 functionality — `src/engine/observability/`, `degraded/`, `failure/`, `map/`, and
      `fairness/` hold no `.js` (asserted in `costSchema.test.js`). No `DecisionRecordB`,
      `InputSnapshot`, `CalibrationObservation`, or `AuditEvent` table (asserted in
      `commitmentSchema.test.js`). No Explanation API, no sampling, no calibration, no shadow mode.
- [x] No Phase 16 functionality — `solve/batch.js`, `setPartitioning.js`, and `localSearch.js` do
      not exist (asserted). The deferral variable and the column regime are present and switched off.
- [x] Architecture unchanged — no `.md` specification file was edited. §9 implemented as written,
      with two interpretive calls (`resolveShard`, the lexicographic cost) disclosed in §10 rather
      than silently resolved.
- [x] Tests pass — 4,917/4,917 across all three lanes.
- [x] Build passes — `npx prisma validate`, `npx prisma generate`, all three build gates green.
- [x] APIs remain compatible — the REST change is additive, the socket change is additive, and the
      legacy lane is unchanged at 169/169.
- [x] Concurrency guarantees maintained — no new lock, no new exclusivity mechanism. The queue's
      claim is a conditional write on `(id, state, version)`; exclusivity remains Phase 3's commit.
- [x] Determinism maintained — `solve/` is clock-free and randomness-free by source scan as well as
      by the T6 gate.

---

## 13. Known Limitations

1. **The `setImmediate` deviation (§14).** The single most important item for the reviewer.

2. **The replay test is over the round's own logic, not over a stored `Round` row.** §9.6's
   acceptance test is "replaying any *stored decision record*". `solveRound.test.js` asserts the
   stronger-per-run but narrower property — two runs over identical inputs produce byte-identical
   decisions and objectives — because replaying from a stored record needs the `InputSnapshot` table
   and `tools/replay/replayDecision.js`, both of which are Phase 11's by name. `solve/budgets.js`
   already carries the `replayOf` seam that pins a recorded round's wall-clock outcome so a replay
   truncates where the original did rather than where its own machine lands; it is tested, and it is
   the piece Phase 11's replayer will consume.

3. **`round.plan()`'s candidate pipeline is exercised through injected readers, not through §6's
   real expansion and §8's real `Φ`.** The round's own arithmetic — partitioning, regime, solve,
   reservation, recording — is what these tests cover; `candidates*`/`costFunction`/`planBuilder`
   have their own suites. The full end-to-end composition (expansion → gate → Plan Builder → `Φ` →
   `γ` → flow → commit) is not exercised in one test, because no fixture yet assembles a complete
   agent-plus-Leg world across all four subsystems. That fixture is worth building at Phase 11,
   where the replay corpus needs it anyway.

4. **`solve.improvement_budget` is registered and read by nothing.** §9.5's post-solve local search
   is T2-08 (`solve/localSearch.js`, kill switch `local_search`), Phase 16. The parameter was
   pre-seeded by Phase 1 and is deliberately left unconsumed rather than given a stub that would be
   a Tier 2 mechanism statically linked into the Tier 1 path.

5. **`Round.windowMs` records the window the cadence *chose*, not the window the round *waited*.**
   The coordinator as written runs a round when called; the window-elapsed/early-close loop
   (`cadence.windowElapsed()` and `shouldCloseEarly()` are both implemented and tested) is driven by
   whatever schedules the worker, and nothing schedules it yet. Wiring the wait into a running loop
   belongs with Phase 15's production scheduling.

6. **Migration not applied to a live database** (§5) — a deployment step, matching every phase
   since 6.

7. **`supplementary.json` reformatting** (§10) — data-preserving and verified, but a cosmetic change
   to lines outside Phase 10's scope, disclosed rather than hidden.

## 14. The `setImmediate` Disposition — Stated in Full

The execution plan states two things that cannot both hold at this phase:

- **Phase 10, checklist item:** "**Remove the `setImmediate` detached assignment from
  `task.service.js`**", with the gate "no detached background assignment remains".
- **Phase 15, files to modify:** "**retire** … the legacy assignment path in `task.service.js`",
  with `ENGINE_ENABLED=true` staged per shard *in that phase* and all engine workers moving "from
  shadow to production scheduling" *in that phase*.

Deleting the detach now means: `assignTask` enqueues durably, nothing drains the queue (the
coordinator is unscheduled, like every engine worker since Phase 4), and **no task is assigned
between this phase and Phase 15** — a five-phase functional outage of the production path, to
satisfy the letter of one checklist line at the cost of the phase that owns the same removal.

The ambiguity was surfaced to the architecture's owner before any code was written, and the
resolution was directed: apply the strangler gate every phase since 3 has used — the closest
precedent being Phase 5's offline sweep in `socket.server.js`, gated on the same switch, legacy
owning the fact while the engine is off and the engine owning it when on.

**What was implemented:**

- `assignTask` is a router. With `ENGINE_ENABLED=true` it runs §3.4's request path and **detaches
  nothing**; the legacy selector is never reached (asserted).
- The detach survives in exactly one function — `legacyDetachedAssignment()` — named, extracted, and
  reachable only when the switch is off, so it is a single greppable, deletable site rather than an
  anonymous closure inside the intake path. Phase 15 removes it with `_processAssignment` and
  `_finalizeAssignment`.
- The file header states the conflict, quotes both plan lines, and states the consequence plainly:
  *"the engine path contains no detached background assignment, and the legacy path still does until
  Phase 15 removes it entirely."*
- `intakeStranglerSeam.test.js` and `roundSchema.test.js` assert the shape mechanically: exactly one
  `setImmediate` in the file, inside that function; `intake.admit` present; the engine branch
  evaluated before the legacy one; and **zero** detaches anywhere in the nine engine-path modules.

**What a verifier should decide:** whether this is the correct disposition, or whether the literal
removal should be taken now and the resulting gap between Phase 10 and Phase 15 accepted. Both the
code and this report are written so that reversing the decision is a small, local change.

## 15. Remaining Non-Blocking Issues

1. **Phase 9's verification finding is still open.** `taskAssignment.service.js` and
   `robotRegistry.service.js` still lack the "superseded banner only" header comment every prior
   phase applied to its own named-but-unmodified legacy files. It was left alone deliberately:
   those two files are Phase 9's row, and Phase 10's instruction was to modify only what Phase 10
   needs. Worth closing before Phase 9 is considered fully closed out.
2. **`PHASE_0_INDEPENDENT_VERIFICATION.md` still does not exist**, as every review since Phase 1 has
   recorded. Not a Phase 10 blocker.
3. **Prisma reports a major version update available (5.22.0 → 7.9.1).** Not evaluated or acted on —
   a major-version bump warrants its own review rather than riding in on a phase implementation.
4. **Items 4 and 5 of Phase 9's own limitations** (`indexMaintainer.worker.js`'s two stubbed
   extension seams, and the Cold Index rebuild's source) are now closer to mattering: the round loop
   will depend on `FINISHING_SOON`/`CHARGING_INTERRUPTIBLE` candidates as soon as it runs against a
   populated index.

## 16. Readiness for Independent Verification

**Ready.** Suggested focus, in priority order:

1. **The `setImmediate` disposition (§14).** The one deliberate deviation. Is the strangler gate the
   right reading of two plan lines that conflict, and is the disclosure sufficient?
2. **The lexicographic cost construction in `minCostFlow.js` (§10).** Independently re-derive
   whether `(unassigned, milliCU)` under componentwise addition and lexicographic comparison is a
   valid cost group for successive shortest paths with Johnson potentials, and whether it is a
   faithful expression of §22.5 rule 1's "immediate assignment when any feasible candidate exists"
   — or whether it over-reaches what the specification asks for.
3. **The exactness argument with negative `γ`.** The initial potentials come from one relaxation
   pass in node-index order, justified by the initial network being a DAG in that order. Confirm the
   claim holds for every network `buildNetwork()` can produce, and that the post-augmentation
   potential update for unreached nodes (advanced by the sink distance) preserves non-negativity of
   reduced costs.
4. **`resolveShard`'s two-case rule (§10).** Is "refuse only when a map is published" a legitimate
   reading of §3.5, or should it be escalated the way Phase 8 escalated its own interpretive calls?
5. **The `supplementary.json` reformatting (§10, §13 item 7).** Verify independently that no
   parameter, value, or field changed — the claim is that the 17 committed entries are byte-identical
   to `HEAD` and the rest are semantically identical to the pre-edit working tree.
6. **The Tier A record's Phase 10/11 boundary (§6).** Are the sections left `null` the right ones,
   and is writing a partial record better than writing none until Phase 11?

---

*End of Phase 10 Implementation Report.*
