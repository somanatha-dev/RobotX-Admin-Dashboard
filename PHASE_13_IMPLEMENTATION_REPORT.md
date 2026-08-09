# Phase 13 — Implementation Report

**Role:** Senior Distributed Systems Engineer implementing the frozen architecture
**Scope:** `IMPLEMENTATION_EXECUTION_PLAN.md` §3 "PHASE 13 — Sharding, leadership, and the single
writer" (rows 656–682) and its §7 checklist (lines 1260–1277), implementing
`NEXT_GENERATION_ASSIGNMENT_ENGINE.md` §19 and §3.5 in full
**Date:** 2026-08-08 · **Branch:** `feature/dashboard` · **Baseline:** Phase 12, independently
verified — uncommitted on top of `cf9103f`
**Phase 14 or later:** not implemented. `src/engine/security/` still holds only Phase 4's
`commandSigning.js`; `src/engine/privacy/` holds no `.js`; no `AgentCertificate`,
`CapabilityAttestation`, `IdentityRecord` or `OverrideAudit` table. `src/engine/fairness/` remains
empty — §17.4's ladder is its own phase's. All asserted mechanically.

---

## 1. Executive Summary

Phase 13 delivers §19 and §3.5 of the frozen architecture: the shard model with its region→shard
map (§3.5), leader election with a fenced lease over a consensus-store **port** (§19.3, §19.5),
failover's recover-durable / reconstruct-volatile split with the reconstructed-Leg count reported
apart from the reconciler's repair rate (§19.5), both sizing bounds with the binding one reported
(§3.5), the transactional membership handoff that migrates one agent at a time and advances
`authority_epoch` (§19.2), and §19.6's cross-region decomposition with a saga whose compensation is
decided at decomposition and whose transfer points cannot exist without a custodian.

Six new engine modules, one background worker, one REST route pair, four new Prisma models, six new
registered parameters, and ten new test files (**271 tests**). Five existing files were rewired:
`server.js`, `src/engine/shard/leadership.js`, `src/engine/intake/intake.js`,
`src/engine/config/validators.js`, and `src/app.js` — plus `routes/index.js`,
`config/register/supplementary.json` and `config/service.js`.

`npm run verify` (all three build gates, then all three Jest lanes) is green: **116 suites, 5,647
tests, 0 failures.** The legacy lane is unchanged at **169/169** — the baseline every phase since 10
has reported — confirming zero behavioural regression in the path Phase 15's cutover has not yet
reached. The gates lane is unchanged at **49/49**.

**Four things are worth a verifier's attention up front**, and each is recorded rather than smoothed
over:

1. **`commit.js` was not modified, and the migration contains no `ALTER TABLE "ShardLeadership"`.**
   Phase 3 resolved the near-circular dependency on the promise that Phase 13 would replace the
   static row with real election and "**G1's code does not change**". That promise is about the
   database as much as about the source, so `shardSchema.test.js` asserts both: `readLeadership`'s
   SQL is character-for-character the statement Phase 3 shipped, `commit.js` contains no Phase 13
   identifier, and the migration's only `ALTER TABLE` targets are the four new tables.

2. **A defect in my first compare-and-set was found by the Phase 3 store model, and the fix is a
   real strengthening.** The first `tryAcquire` was a bare conditional `UPDATE … WHERE fence =
   expected`, which is safe under PostgreSQL's READ COMMITTED — where the second updater blocks and
   re-evaluates — and *not* under the REPEATABLE READ/SERIALIZABLE the commit path requests. The
   store model made ten acquirers race and all ten won. The three CAS operations now take an
   explicit `FOR UPDATE` lock on the leadership row inside a transaction, so leadership is safe
   **under every isolation level** rather than under the one the caller happened to open. §10's
   discussion states the reasoning; §11 records the test that found it.

3. **Blocking decision B3 is not pre-empted, and not assumed away either.** `election.js` defines a
   **port** with one named guarantee (`LINEARISABLE_COMPARE_AND_SET`) and refuses any store that does
   not declare it. The shipped adapter is PostgreSQL over the `ShardLeadership` row — B3's own
   "DB primitives" option — and it declares the guarantee **only for a declared-safe replication
   posture**. An undeclared or asynchronously-replicated deployment is *refused at boot*, not warned
   about, because §19.5's sentence is a prohibition. §13 item 1 records what that leaves open.

4. **`POST /api/shards/:id/rebalance` moves no agents.** §19.2 forbids a bulk reassignment, and an
   HTTP request that synchronously moved four hundred agents would be one reached through a different
   door — four hundred `authority_epoch` advances inside one request, every round holding any of those
   agents aborted through G3, and a fence-rejection burst that invariant I5's verification reads as a
   rising baseline. The endpoint records the intent and returns the ordered plan; the supervisor
   performs the moves one per tick. The response carries `executed: false` as a field, not only in
   prose.

---

## 2. Objectives Achieved

Cross-referencing `IMPLEMENTATION_EXECUTION_PLAN.md`'s Phase 13 checklist (§7, lines 1260–1277) item
by item:

| # | Checklist item | Status |
|---|---|---|
| 1 | Migration: `Shard`, `ShardMembership`, `CrossRegionSaga`, `TransferPoint` | **Done** — §5 |
| 2 | `shard/election.js` on the consensus store (B3) | **Done** — as a port with one declared guarantee, plus the PostgreSQL adapter; §1 item 3, §10 |
| 3 | Replace the static leadership row with real election; **G1 unchanged** | **Done** — and "unchanged" asserted against the SQL, the caller, and the migration; §1 item 1 |
| 4 | `shard/failover.js` — recover durable state, **reconstruct** volatile state | **Done** — the durable half is an inventory plus §12.4's own sweep; the volatile half is `planState.reconstructionPlan` predicting what that sweep will requeue |
| 5 | Emit reconstructed-Leg count as a failover metric, separate from reconciler orphan repairs | **Done** — read out of Phase 5's own `EXPECTED_POST_FAILOVER` counter and **never** written as a `ReconcilerRepair` row; asserted by source scan and by row count |
| 6 | `shard/sizing.js` — both bounds monitored, binding one reported | **Done** — including the case that matters: an unevaluated bound is reported unevaluated, never satisfied |
| 7 | Enforce the §3.5 sizing inequality at config publish | **Done** — V4 now delegates to `sizing.js` and additionally validates **per shard definition**, because §3.5 sizes shards "per region against that region's measured `r`" |
| 8 | `shard/membership.js` — transactional handoff, one agent at a time, advancing `authority_epoch` | **Done** — "one at a time" is a signature refusal, not a comment; five writes in one transaction |
| 9 | `shard/crossRegion.js` — decomposition at intake, saga with explicit compensation | **Done** — compensation decided at decomposition; Tier 2 with the dependency inverted so intake never imports it |
| 10 | Require a defined custodian at every transfer point | **Done** — NOT NULL columns, two CHECK constraints, and `requireCustodian()` refusing at three call sites |
| 11 | REST: `GET /api/shards`, `POST /api/shards/:id/rebalance` | **Done** — §7 |
| 12 | `workers/shardSupervisor.worker.js` | **Done** — four passes, gated on `ENGINE_ENABLED` in `server.js` |
| 13 | Chaos: coordinator kills at random and mid-commit; asymmetric partitions | **Done** — `shardChaos.test.js`, driving the real `commit()` against Phase 3's store model; §11 |
| 14 | Verify the isolated coordinator stops committing and its late commits abort via G1 | **Done** — both halves, including the case where the coordinator *ignores* the margin entirely |
| 15 | **Scale gate: the locality test** | **Partially — and disclosed.** The criterion is implemented, registered, and tested in both directions; the *paired benchmark against a million-agent fleet* is Phase 15's scale suite. §13 item 2 |
| 16 | **Gate:** exactly one active coordinator per shard, enforced by consensus **and** by the database | **Done** — the consensus half in `shardElection.test.js` (a ten-way storm yields one winner), the database half in `shardChaos.test.js` (G1 aborts the loser) |

---

## 3. Files Created

**Engine modules:**

| File | Lines | Purpose |
|---|---|---|
| `src/engine/shard/crossRegion.js` | 649 | §19.6 — decomposition, transfer points, the saga, compensation, late binding. **Tier 2** |
| `src/engine/shard/membership.js` | 568 | §3.5, §19.2 — the transactional handoff, one agent at a time |
| `src/engine/shard/election.js` | 514 | §19.3, §19.5 — the consensus-store port, the session state machine, the margin rule |
| `src/engine/shard/failover.js` | 476 | §19.5 — recover durable, reconstruct volatile, and the metric separation |
| `src/engine/shard/shardModel.js` | 440 | §3.5 — the shard vocabulary, definition validation, the region→shard map |
| `src/engine/shard/sizing.js` | 433 | §3.5's two bounds and §24.6's locality criterion |

**Worker (gated, not scheduled):** `src/workers/shardSupervisor.worker.js` (507) — renewal,
failover, sizing, and at most one migration per tick.

**REST:** `src/controllers/shards.controller.js` (293), `src/routes/shards.routes.js` (44).

**Migration:** `prisma/migrations/20260808090000_sharding_leadership_single_writer/migration.sql`
(314 lines).

**Tests (`Backend/tests/engine/`):** `shardElection` (512), `shardSupervisorWorker` (472),
`shardMembership` (469), `shardChaos` (449), `helpers/shardFixture.js` (415),
`shardCrossRegion` (405), `shardSchema` (361), `shardsApi` (328), `shardFailover` (290),
`shardSizing` (283), `shardModel` (247) — **271 tests**.

**Three files created beyond the plan's enumerated list, and why.** The plan's "Files to create" row
names six engine modules and one worker, while its "REST API changes" row specifies two new
endpoints. `shards.controller.js` and `shards.routes.js` are those endpoints' home, mounted at
`/api/shards` beside every other authenticated read since Phase 5 — the same disposition, and the
same justification, Phase 12 recorded for `health.controller.js`.

`tests/engine/helpers/shardFixture.js` is a **third** in-memory store, alongside Phase 11's
`roundFixture` and Phase 12's `degradedFixture`. Its header states the rule it follows and that a
reviewer should hold it to: **a test whose claim is about concurrency does not use it.** Every
leadership, membership and chaos test in this phase runs against Phase 3's `commitmentStore.js`
instead, because a store that cannot make two callers race proves nothing about mutual exclusion.

## 4. Files Modified

| File | Change |
|---|---|
| `Backend/prisma/schema.prisma` | Four models added; `Region`, `Site`, `Agent`, `Mission` and `ShardLeadership` gain **back-relations only**, which add no columns |
| `Backend/src/engine/shard/leadership.js` | Three compare-and-set primitives added (`tryAcquire`, `renewLease`, `releaseLease`) plus `lockLeadershipRow`. **`readLeadership`, `readLeadershipFence`, `ensureShard`, `advanceFence` and `shouldStopCommitting` are unchanged** |
| `Backend/src/engine/intake/intake.js` | `resolveShard` gains `notAdmittingRegions` (a draining region is refused *by name*); new impure `resolveShardFor`; `admit` gains opt-in `resolveShardFromStore`. The pure routing rule is unchanged for every existing caller |
| `Backend/src/engine/config/validators.js` | V4 delegates its inequality to `sizing.js` and gains per-shard-definition validation; new A4 (§19.5's renewal margin) |
| `Backend/src/engine/config/service.js` | `shards` threaded through `buildSnapshot` → `validateCandidate` → `validatePublish` → the published payload, symmetrically with `spatial` |
| `Backend/src/engine/config/register/supplementary.json` | 6 new entries. Purely additive; no existing entry touched |
| `Backend/server.js` | Coordinator lifecycle: leadership acquisition and the supervisor loop, **gated on `ENGINE_ENABLED`**; shutdown drain releases the lease |
| `Backend/src/app.js` | `/health` gains a `shard` summary block |
| `Backend/src/routes/index.js` | `/api/shards` mounted |
| `Backend/tests/engine/helpers/commitmentStore.js` | Phase 3's store model extended with `Shard`, `ShardMembership`, `Mission`, `WorkQueue`, their four CHECKs, the partial unique index, `findFirst`, and `{ decrement }` |
| `Backend/tests/engine/phase0Scaffold.test.js` | `PHASE_13_OWNED` added to the cumulative ownership walk, named file-by-file |
| `Backend/tests/engine/commitmentSchema.test.js` | Boundary moved to Phase 14; Phase 13's four tables asserted **present**; new assertion that `ShardLeadership`'s columns are exactly those it shipped with |
| `Backend/tests/engine/costSchema.test.js` | Same boundary move |
| `Backend/tests/engine/degradedSchema.test.js` | "no Phase 13 module" inverted to "`shard/` holds exactly what Phases 3, 10 and 13 own"; new Phase 14 boundary |
| `Backend/tests/engine/configValidators.test.js` | V4's expected message updated to `sizing.js`'s wording, with the reason recorded inline |

**`src/engine/commitment/commit.js` was not modified.** Neither were `TIERS.md` or
`guards/tierAssertions.js`: Phase 0 declared T2-13 against `src/engine/shard/crossRegion.js` and set
the Tier 1 default for `src/engine/`, so the declaration was already correct and this is the phase
that makes it *true*. `shardSchema.test.js` asserts that no `MODULE_TIERS` row was added.

---

## 5. Database Changes

Additive only. **No `DROP`, no `ALTER COLUMN`, and no `ALTER TABLE` on any pre-existing table** — the
five relations added to existing models are back-relations, which Prisma resolves without a column.
`shardSchema.test.js` asserts this by enumerating every `ALTER TABLE` target in the migration and
requiring the set to be exactly the four new tables.

**`Shard`** — §3.5's AssignmentShard. Three properties of the shape are load-bearing. `regionId` is
**unique**, because "every Leg is routed to exactly one shard at intake, determined by its first
Stop's region" is only well defined if region→shard is a function; the consequence is §3.5's own,
that a hot shard is split by *redistricting* rather than by a second shard appearing inside its
region. `shardId` is a **foreign key to `ShardLeadership`**, which makes "a shard with no leadership
record" unrepresentable — the converse of `advanceFence`'s refusal to create one implicitly.
`lastFailoverReconstructedLegs` is a column rather than a `ReconcilerRepair` row for the reason §19.5
gives: the count must be "distinguishable from the reconciler's genuine orphan repairs", and §12.4's
repair rate is an alertable SLI that an expected-by-construction event would raise on every failover.

**`ShardMembership`** — one row **per move**, not per agent. A dispute about which coordinator
commanded an agent at a given instant is answered by the membership at that instant and by nothing
else. Both epochs are recorded because §19.2's correctness argument is that "an agent migrated
mid-round has a changed `authority_epoch`, so the old shard's pending commitment fails its guard" —
and a row holding only the new value could not show that G3 had anything to fail against.
`Agent` deliberately gains **no** `currentShardId` column: a denormalised pointer would be a second
place the answer lives, which is the defect §19.4 removes from live state.

**`CrossRegionSaga`** — `steps` holds the decomposition and the per-step compensation decided at
decomposition time; `heldAtTransferPointId` is a **foreign key**, so custody can only be held
somewhere with a modelled custodian. That is §19.6's named failure mode — "goods stranded at a
transfer point" — made unrepresentable rather than guarded against.

**`TransferPoint`** — `custodianType`, `custodianId` and `capacity` are **NOT NULL**, so "a defined
custodian" is a property of the table. `MODELLED_UNATTENDED` is admitted as a fourth kind because
§19.6 conditionally admits it, and the CHECK requires the capacity and security properties that
sentence conditions it on — so choosing it is a modelling act rather than an escape hatch.

**Fifteen hand-written CHECK constraints and one partial unique index Prisma cannot express:**
`Shard_state_known`, `Shard_binding_bound_known`, `Shard_agent_count_non_negative`,
`Shard_draining_is_timed`, `ShardMembership_one_current_per_agent` (the partial index),
`ShardMembership_migration_advances_epoch`, `ShardMembership_epochs_non_negative`,
`ShardMembership_move_changes_shard`, `ShardMembership_reason_known`, `CrossRegionSaga_state_known`,
`CrossRegionSaga_compensation_is_explicit`, `CrossRegionSaga_hold_is_timed`,
`TransferPoint_custodian_type_known`, `TransferPoint_unattended_is_modelled`,
`TransferPoint_capacity_positive`, `TransferPoint_joins_two_regions`.

Three deserve a word.

`ShardMembership_one_current_per_agent` is §3.5's "Every Agent belongs to exactly one shard at a
time" as a schema property. Two current memberships would mean two coordinators each believing they
may command one physical machine — the condition single-writer-per-shard exists to prevent, arrived
at from the membership side instead of the leadership side.

`ShardMembership_migration_advances_epoch` states §19.2's rule with its one exemption: a migration
must advance the epoch, and an initial placement need not, because it supersedes no authority. The
exemption is in the constraint (`"fromShardId" IS NULL OR …`) rather than in a comment, so
`place()` and `migrate()` are genuinely different operations at the database and not only in the
source.

`TransferPoint_unattended_is_modelled` is the half of §19.6 a naive reading loses. Without it,
`MODELLED_UNATTENDED` would be a label that turns the prohibition off; with it, choosing that label
obliges the row to carry the capacity and security properties the sentence conditions it on.

Every `CREATE TABLE` / `CREATE INDEX` / `ADD CONSTRAINT … FOREIGN KEY` was taken verbatim from
`prisma migrate diff --from-empty --to-schema-datamodel`; `tests/engine/shardSchema.test.js` re-runs
that diff, asserts byte equality modulo whitespace, and asserts the fifteen CHECKs and the partial
index are **absent** from Prisma's output — which is what proves they are genuine hand-written
additions rather than an echo.

**Not applied to a live database**, consistent with every phase since 6. `npx prisma validate`
succeeds; `prisma migrate diff --from-empty` needs no connection and was used instead.

---

## 6. Runtime Behaviour

`ENGINE_ENABLED` remains `false`. `shardSupervisor.worker.js` is referenced from `server.js` — the
plan's Phase 13 row names the coordinator lifecycle as `server.js`'s change — but `start()` sits
inside a single `if (engineEnabled)` branch, asserted mechanically rather than by inspection.

**With the engine off**, two changes are reachable:

- `/health` gains a `shard` block: shard count, state, membership count, binding bound, whether the
  shard is led, whether its lease is valid, and whether its rounds have resumed. Best-effort — a null
  `shard` means the model could not be read, which costs visibility and never availability (§3.3).
  With no `Shard` rows it reports `singleShardDeployment: true`, which is the honest answer and not
  "this fleet has no shards". The **holder's identity is deliberately absent** from this
  unauthenticated route.
- `GET /api/shards` and `POST /api/shards/:id/rebalance` answer from an empty table — the first
  reporting the single-shard deployment, the second 404-ing on an undefined shard.

**With the engine on**, the coordinator lifecycle interposes as:

```
  server.js (ENGINE_ENABLED)
        │
        ▼
  election.postgresLeadershipStore(prisma, { replicationPosture })
  election.assertConsensusStore(...)          refuses an undeclared or async posture
        │
        ▼
  shardSupervisor.start() ── tick ──▶ renewalPass()    acquire · renew · step down
                                   ├▶ failoverPass()  §19.5 reconciliation, then promote
                                   ├▶ sizingPass()    both §3.5 bounds → Shard row
                                   └▶ migrationPass() at most ONE agent
        │
        ▼
  SIGTERM ─▶ shardSupervisor.drain() ─▶ release, advancing the fence
```

Three orderings are load-bearing and stated in the code rather than left implicit:

- **Renewal runs first, unconditionally.** Everything below it is lawful only for a leader, and
  running an action before renewal would act on a leadership belief one tick out of date — which over
  a lease duration is the whole vulnerability window §19.5 is written about.
- **A session may not commit until `promote()` has seen a completed reconciliation.** §19.5's
  "before resuming rounds" is a state transition that *requires evidence*, not an ordering somebody
  remembers to observe. A supervisor that omitted the failover pass therefore produces a shard that
  never resumes — loud — rather than one that resumes on half-written state.
- **Acquisition and release advance the fence; renewal never does.** A renewal that advanced it would
  abort the renewing leader's own in-flight commits through G1, at whatever rate it renewed. A
  hundred-renewal test asserts the fence does not move.

**Determinism.** Every Phase 13 module takes time as an argument. `sizing.js` and `failover.js` are
asserted clock-free and randomness-free by source scan; `crossRegion.decompose()` is asserted pure
(no store, no clock) and its transfer-point choice is a deterministic sort, so a decomposition
replays identically (T6). `intake.resolveShard` remains pure, and the store-reading wrapper is a
separate function so a replay can never acquire a query the original decision did not make.

---

## 7. API Changes

**New: `GET /api/shards`** — every shard's membership, leader, and **both** sizing bounds with the
binding one named. Both bounds are returned always; returning only the binding one would make the
other unmonitorable through the only surface that shows it, which is how a shard comes to be sized
against one resource again (§3.5's stated failure).

Two design points a verifier should weigh. The **round wall-clock** half is read from the verdict the
leader last recorded, not recomputed — it is a *measurement*, and two operators refreshing during an
incident must not see two verdicts from two measurement windows; `sizingCheckedAt` makes a stale one
visible as stale. The **serial-commit** half *is* recomputed, because it is arithmetic over
configuration and the observed membership count. The response carries the leader's stored verdict
beside the live arithmetic under `asRecordedByLeader`, so a disagreement is visible rather than
silently resolved in favour of one. The membership count is likewise reported twice — the
denormalised `Shard.agentCount` and the current-row count — with a `consistent` flag, because a
drift means a handoff wrote one and not the other.

**New: `POST /api/shards/:id/rebalance`** — 202 with the ordered plan and `executed: false`. It
performs exactly the two things a control-plane operation legitimately does synchronously: it records
the intent (moving the source shard to `DRAINING` for a full drain, `REBALANCING` for a partial one)
and returns the plan. **Elevated role**, matching `config.routes.js` — §22.3 makes shard definition a
STRUCTURAL change class — at a low rate limit, because re-posting does not make the migrations happen
faster.

**`/health` gains a `shard` block** — the summary, for the same reason Phase 12's `degraded` block is
a summary. It reads the **durable leadership row**, never `engine:shard:leader:{shard}`: a health
probe answering from a cache would report a dead coordinator as leading for the mirror's whole TTL.

**Backwards compatibility.** `intake.resolveShard(input)` keeps its exact signature and behaviour for
every existing caller — `notAdmittingRegions` is optional and absent means the previous behaviour.
`intake.admit()` reads the store only when `resolveShardFromStore` is passed. `validators.v4ShardSizing(values)`
keeps its one-argument form; the second is optional. `validatePublish` ignores an absent
`candidate.shards`. **No existing endpoint's behaviour, response shape, or route changed**, and the
legacy lane is unchanged at 169/169.

---

## 8. Redis Changes

One new advisory key, exactly the one the plan's row reserves:

- `engine:shard:leader:{shardId}` — the shard's holder, its leadership fence (as a string; JSON has
  no BigInt that survives a round trip), and whether the session may commit, with a 30 s TTL.

**The consensus store is the authority and this is a hint**, and two properties keep that honest
rather than merely stated. `publishLeaderHint()` returns rather than throws on a cache failure —
losing the hint costs visibility, never correctness — and **nothing in the supervisor ever reads it
back**: a test source-scans the module for `kv.get`. That restraint is §18.5 rule 3's argument applied
to this worker; a supervisor that cached its own leadership and then trusted the cache would have
promoted the cache tier to an authority over the one fact §19.3 is least able to tolerate being wrong
about.

The **Socket.IO Redis adapter is now required rather than optional**, per the plan's row. `server.js`
retains its existing warn-and-fall-back policy unchanged, and this report records the change of
status rather than the change of code: with more than one coordinator process per fleet — which is
what leader election exists for — a dashboard broadcast from the leading process must reach a client
connected to a standby. §14 item 6 records the follow-up.

## 9. Socket.IO Changes

**`SHARD_MIGRATE` becomes operational**, exactly as the plan's row states. It is an **agent-scope
command** (§10.3.1 row 2) and it reaches its agent through the **outbox**, written in the same
transaction that advances the `authority_epoch` authorising it (§4.1 rule 5) — never through a
broadcast. It carries `authority_epoch` *and* `fence_floor`, which §10.3.1's interaction rule requires
beside it, and a §23.3 signature over the whole envelope including the agent id. `VirtualRobot.js`
has handled the command since Phase 4 and is unchanged.

Two dashboard-facing events are added, as **payload builders that return their message** rather than
emitters — no Phase 13 module takes a Socket.IO dependency, matching every engine worker since
Phase 4:

| Event | Emitted on | Carries |
|---|---|---|
| `SHARD_LEADERSHIP_CHANGED` | acquisition, release, or a lost lease | shard, holder (null when unheld), leadership fence, transition, instant |
| `SHARD_MIGRATED` | a completed migration | agent, from-shard, to-shard, the new `authority_epoch`, instant |

`SHARD_LEADERSHIP_CHANGED` fires on **change** rather than on every tick, for the reason Phase 12
gave for `INVARIANT_STATUS_CHANGED`: a dashboard told forty times a minute that the same coordinator
is still leading learns nothing, and the one transition that matters would arrive in the same shape
as the noise. A test drives a renewal and asserts no message.

No existing socket event's name or payload changed.

---

## 10. Architecture Compliance

**Tier placement.** `shard/crossRegion.js` resolves to **Tier 2** by the row Phase 0 wrote (T2-13,
kill switch `cross_region_candidacy`, degrading to "Region-local only"); every other Phase 13 module
resolves to **Tier 1** by the `src/engine/` and `src/workers/` defaults. No `MODULE_TIERS` row was
needed and none was added. The tier gate confirms mechanically: 260 modules, 353 governed import
edges, zero Tier 0/1 → Tier 2 edges.

**The tier rule cost something, and the cost is the design.** §19.6's decomposition happens "at
intake", and the natural implementation is for `intake.js` to call it. `intake.js` is Tier 1 and must
run with `crossRegion.js` deleted, so the dependency is **inverted**: `crossRegion.js` imports
`intake.js` and calls it; `intake.js` names cross-region work nowhere. Two tests enforce this — one
walks the whole `src/` tree asserting **nothing** requires `crossRegion.js`, the other asserts the
import runs the other way. That is what makes throwing `cross_region_candidacy` a real control rather
than a flag on a code path that is linked in either way (§22.5 rule 1).

**"G1 unchanged" is asserted three ways.** By the SQL — `readLeadership`'s statement is
character-for-character Phase 3's. By the caller — `commit.js` contains no Phase 13 identifier. By the
migration — its only `ALTER TABLE` targets are the four new tables, and `ShardLeadership`'s column set
is asserted to be exactly the ten it shipped with (seven columns, two timestamps, and one
back-relation that adds none).

**Leadership is enforced twice, and this phase's code is the weaker of the two on purpose.** §19.3 is
explicit that guard G1 is what converts leadership "from a coordinator's belief into a
database-enforced property". `election.js` is therefore written on the assumption that it will
sometimes be wrong: `acquire()` returns a *session*, which is a claim one process holds about itself;
`shouldStopCommitting()` is documented as the liveness half; and the chaos suite includes a test in
which a coordinator **ignores the margin entirely** and is still fenced. That test is what makes the
module header's "advisory by design" a safe statement rather than an alarming one.

**The compare-and-set takes an explicit lock, and the reasoning is §10.3.2's.** A bare conditional
`UPDATE … WHERE fence = expected` is correct under READ COMMITTED, where the second updater blocks and
re-evaluates its predicate; under the REPEATABLE READ/SERIALIZABLE the commit path requests, a
concurrent updater raises a serialisation failure instead. Relying on the isolation level would make
leadership safe only for the level the caller happened to open the transaction with — the same
implicit dependency §10.2 rejects for the cache lock. So all three CAS operations take `FOR UPDATE`
on the leadership row inside a transaction, exactly as §10.3.2 step 1 takes the locks the commit
depends on rather than inferring them. The conditional write is **retained beside the lock**, as the
half that survives a future edit that loses it.

**"One at a time" is a signature, not a comment.** `migrate()` takes one agent id; `assertNotBulk()`
refuses an array however it arrives, and refuses `agentIds` as a parameter name outright, so a future
edit adding a batch form fails a test rather than shipping. `planRebalance()` returns an **ordered
list of single migrations**, and the supervisor performs at most one per tick, paced by
`shard.migration_min_interval`. The pacing is the mechanism rather than the decoration: every
migration advances an `authority_epoch` and therefore aborts any round holding that agent through G3,
so an unpaced rebalance produces a fence-rejection burst that I5's verification reads as a rising
baseline.

**The custodian requirement is enforced at four points, and none of them is a flag.** By **NOT NULL
columns** on `TransferPoint`. By **two CHECK constraints**, including the conditional one for
`MODELLED_UNATTENDED`. By `requireCustodian()` refusing a decomposition whose transfer point fails it.
And by `compensate()` refusing to hold goods at a point that fails it — which is §19.6's sentence
enforced rather than restated, because holding goods at a place with no custodian is precisely "in
transit to nowhere" with a location attached.

**Compensation is decided at decomposition, not at failure.** `stepsFor()` assigns each step its
compensating action when the saga is planned: a step ending at a transfer point compensates by
**holding there**, and the final step — which has no downstream transfer point and therefore nowhere
on its own path to hold — compensates by **redirecting**. The stored record says
`decidedAt: "DECOMPOSITION"`. A compensation computed at the moment it is needed is one nobody
rehearsed, which is what §19.6 opens by rejecting.

**Failover writes almost nothing, and that is the design.** Both of §19.5's jobs are performed by
machinery that already exists and already owns the write: §12.4's sweep repairs the durable
divergences, and **the same sweep's orphan scan** performs the volatile reconstruction — Phase 5
already wrote it to distinguish `EXPECTED_POST_FAILOVER` orphans from `DEFECT` ones and to requeue the
first with aging credit. Re-implementing either here would give the shard two requeue paths with two
versions of §4.5's timer obligations, and the second would be the one nobody maintained. What
`failover.js` adds is the three things the sweep cannot supply: an inventory taken *before* anything
is touched (so a leader can say what it inherited, not only what it repaired), **completion** in the
sense §19.5 means (the sweep is batched, so one pass is not "full" on a shard with more orphans than a
batch), and the metric separated at the source.

**`sizing.js` is the one implementation of the inequality.** V4 delegates to it rather than restating
it, and a test asserts the validator's body contains neither `SECONDS_PER_HOUR` nor `MS_PER_SECOND` —
two copies of a sizing bound is two places to update when `k_txn` is re-measured, and the one that is
not updated is the one that admits the oversubscribed shard.

**The six new register entries, and why each was needed.** `shard.renewal_interval` and
`shard.store_round_trip_budget` carry §19.5's margin, which the specification states without
tabulating; the second is registered **SAFETY**-class because it sizes the window in which a
coordinator may still believe it leads. `shard.migration_min_interval` is §19.2's pacing — the *count*
("one at a time") is structural and is deliberately **not** a parameter, because a deployment that
wanted two would be asking for the bulk reassignment §19.2 forbids.
`shard.locality_max_round_time_divergence` is §24.6's "statistically indistinguishable", registered
rather than written into a test file because a threshold inside a test is one nobody owns.
`shard.min_agents` is the lower end of §3.5's stated 1 000–20 000 range, seeded at the range's floor
and marked as an operating-cost judgement rather than a correctness one — §3.5 derives only the upper
bound. `crossregion.downstream_binding_eta_confidence` is §19.6's late-binding threshold.

**A4 is a new publish-time check, and it is labelled as an addition.** §19.5's margin is a coupling
between four parameters that a publish can satisfy individually while making impossible: with a 5 s
lease, a 500 ms skew allowance, a 500 ms store round trip and a 4 500 ms renewal interval, the
leader's *first* renewal already falls after the instant it was required to have stopped committing.
The shard would commit in bursts and idle between them, and nothing about any individual value would
show why. A-series rather than V-series, on the same grounds A1–A3 were admitted: §22.1 rule 5's list
is introduced with "the following are validated at publish and are blocking", not "only the
following", and §19.5 states the requirement in normative language.

---

## 11. Test Results

`npm run verify` (all three build gates, then all three Jest lanes):

```
gate: tier-dependencies (§1.8 rule 2)      PASS — 260 modules, 353 edges, 0 violations
gate: parameter-register (§22, Appendix A) PASS — 167 modules, 223 registered params, 0 bare constants
gate: tenets (T1 type separation, T6)      PASS — 257 modules, 0 violations

Test Suites: 116 passed, 116 total
Tests:       5647 passed, 5647 total
```

By lane:

- **engine**: 91 suites (81 pre-existing + **10 new**), **5,429 tests**. Phase 13's own ten files
  contribute **271**.
- **legacy**: **169/169**, unchanged from Phases 10, 11 and 12's reported baseline — zero behavioural
  regression in the legacy dispatcher.
- **gates**: **49/49**, unchanged.

**The plan's named testing requirements, and where each is discharged:**

| Requirement | Where |
|---|---|
| **Chaos:** kill coordinators at random and mid-commit | `shardChaos.test.js` — twenty random kills leaving one holder and a strictly monotone fence; a kill mid-commit leaving nothing behind and a successor that commits normally |
| **Chaos:** asymmetric partitions (which break naive election) | `shardChaos.test.js` — a coordinator whose *reads* work and whose *writes* do not stops committing, while the row still names it as holder with a live lease. A read-based decision would have been wrong, which is the point |
| **Verify** the isolated coordinator stops committing and its late commits abort via G1 | Both halves. The margin rule refuses commit permission while the lease is still valid; and a coordinator that ignores the margin entirely is still aborted with `G1_LEADERSHIP_FENCE_ADVANCED` |
| **Model check:** no commit succeeds under a superseded fence, **including a transaction spanning the change** | `shardChaos.test.js` — a five-generation chain in which every superseded fence aborts and only the current one commits; plus a commit that begins under valid leadership, blocks inside the transaction while the leadership changes, and does not commit |
| **Failover:** durable state recovered, SOFT reservations reconstructed and counted separately | `shardFailover.test.js` — the inventory across five durable categories, the reconstruction predicted from durable rows alone, and the separation asserted in both directions |
| **Scale: the locality test (§24.6)** | `shardChaos.test.js` and `shardSizing.test.js` — the criterion in both directions, plus the structural half of T9 this phase can establish (§13 item 2) |
| **Gate:** exactly one active coordinator per shard, enforced by consensus **and** by the database | `shardElection.test.js` (a ten-way storm against an unheld shard and an eight-way storm against a lapsed lease each yield exactly one winner) and `shardChaos.test.js` (G1 aborts the loser) |

**Four things worth a verifier's independent re-derivation:**

1. **The store model found a real defect, and re-running it is the way to confirm the fix.** My first
   `tryAcquire` was a bare conditional update. Ten concurrent acquirers all won, because the model
   evaluates a transaction's reads against the committed snapshot as of its start — the REPEATABLE
   READ leg the specification requests. Reverting `lockLeadershipRow` and re-running
   `shardElection.test.js`'s storm tests reproduces it. This is the single most valuable thing Phase
   3's helper did in this phase.
2. **The §3.5 worked example is re-derived, not copied.** `shardSizing.test.js` asserts ≈ 21 950
   admissible agents at the specification's stated defaults and ≈ 4 390 at `r = 20` — both figures
   §3.5 states in prose. If either drifts, the arithmetic or the specification has moved.
3. **The G3 consequence is driven, not reasoned about.** `shardMembership.test.js` migrates an agent
   and then drives the **real `commit()`** with a round's pre-migration pinned epoch, asserting
   `G3_AUTHORITY_EPOCH_CHANGED` and an empty commitment table — then repeats it with the
   post-migration epoch and asserts a successful commit. §19.2's "migration correctness then follows
   from guard G3" is thereby a demonstrated property.
4. **The custodian refusal is checked on the compensation path, not only at decomposition.** A saga
   asked to compensate by holding at a transfer point with no custodian throws, **and** the saga is
   left in `PLANNED` rather than moved to `COMPENSATING` on the way to failing.

**The commitmentStore extension, and what it now proves.** Phase 3's model gained `Shard`,
`ShardMembership`, `Mission` and `WorkQueue`, the four Phase 13 CHECKs, and the partial unique index —
evaluated at apply time against the global view, in the same way Phases 3, 4 and 5's are. So the
membership tests are not asserting against a permissive double: a handoff that failed to advance the
epoch, or that left two current memberships, is refused *by the store*. It also gained `findFirst`
and `{ decrement }`, both of which the handoff genuinely uses.

---

## 12. Self-Verification

- [x] **Every Phase 13 checklist item implemented** (§2), all sixteen, with the one caveat in §13
      item 2 disclosed rather than claimed complete.
- [x] **No Phase 14 functionality** — `src/engine/security/` holds only `commandSigning.js`;
      `src/engine/privacy/` holds no `.js`; no `AgentCertificate`, `CapabilityAttestation`,
      `IdentityRecord` or `OverrideAudit` table; no mTLS, no attestation, no surrogate keys, no
      erasure endpoint. Asserted mechanically in `shardSchema.test.js` and `degradedSchema.test.js`.
- [x] **No §17.4 ladder functionality** — `src/engine/fairness/` holds no `.js`. Asserted.
- [x] **Architecture unchanged** — no `.md` specification file was edited. §19 and §3.5 implemented
      as written. No architectural ambiguity was found that required a stop; §13 item 1 records the
      one *integration* decision (B3) and the form in which it was left open.
- [x] **Tests pass** — 5,647/5,647 across all three lanes.
- [x] **Build passes** — `npx prisma validate`, all three build gates.
- [x] **APIs remain compatible** — two new routes; `/health` additive; no existing shape changed;
      `resolveShard`, `admit`, `v4ShardSizing` and `validatePublish` all keep their existing call
      forms working; the legacy lane is unchanged at 169/169.
- [x] **Architectural layering maintained** — the Tier 2 module imports Tier 1 and nothing imports
      it; Tier 1 shard modules import Tier 0 (`commitment/`, `dispatch/`, `security/`) and Tier 1
      only; the tier gate confirms zero violating edges.
- [x] **Ownership boundaries maintained** — `failover.js` performs no repair, delegating to §12.4's
      sweep; `sizing.js` owns the inequality and `validators.js` calls it; `leadership.js` owns the
      row and `election.js` owns the protocol; the supervisor owns the pacing and the control plane
      owns the plan.
- [x] **Concurrency guarantees maintained** — leadership CAS takes an explicit `FOR UPDATE`; the
      membership handoff takes the agent row under the same lock the commit transaction takes; every
      state transition is a conditional write; **G1 and G3 are unchanged and are what actually
      enforce both properties.**
- [x] **Determinism maintained** — every Phase 13 module takes time as an argument; `sizing.js`,
      `failover.js` and `crossRegion.decompose` are clock-free and randomness-free by source scan;
      `intake.resolveShard` stays pure and its store-reading wrapper is a separate function.
- [x] **Backwards compatibility maintained** — with `ENGINE_ENABLED` false the only reachable changes
      are the `/health` summary and the two new authenticated routes.

---

## 13. Known Limitations

1. **B3 is settled in form but not in fact, and the code says so.** `election.js` defines the port
   and refuses a store that does not declare `LINEARISABLE_COMPARE_AND_SET`; the shipped adapter is
   PostgreSQL, which is one of B3's four enumerated options ("DB primitives"). What remains an
   operator decision is the **replication posture**: the adapter declares the guarantee only for
   `SYNCHRONOUS_QUORUM` or `SINGLE_PRIMARY_NO_AUTOMATIC_FAILOVER`, and a deployment that sets
   `SHARD_CONSENSUS_REPLICATION` to anything else — or leaves it unset — fails at boot rather than
   electing a leader over a store that cannot fence one. That is the honest form of an unmade
   decision, but it is not the decision being made: **an operator must still choose, and an etcd or
   Consul adapter remains a legitimate answer.** Adding one is a change to the construction in
   `server.js` and to nothing else.

2. **The locality test's *criterion* ships; its *measurement* is Phase 15's.** §24.6 requires
   "identical benchmarks against a shard in a small fleet and a shard in a million-agent fleet". This
   phase implements the comparison, registers its tolerance, and tests it in both directions —
   including the half a naive implementation omits, that a large-fleet shard which is materially
   *faster* also fails, because that is evidence the benchmarks were not identical. What it cannot do
   is run the benchmark: no fleet exists, `ENGINE_ENABLED` is false, and no shard has run a round.
   The structural half of T9 that *is* established is that §3.5's bound-2 arithmetic takes no
   global-fleet input at all. This is the honest input to Phase 15's scale suite rather than a claim
   to have passed its gate.

3. **`bindingBound` can be `NEITHER_EVALUATED` for a long time, and that is correct rather than
   convenient.** Bound 1 is measured, so until a shard's leader has recorded a round wall-clock
   measurement the surface reports it unevaluated. A reviewer should confirm this reads as intended
   on `GET /api/shards`: `satisfied: null` with both bounds present is the right answer for a shard
   nobody has measured, and it is deliberately *not* the same sentence as "this shard is correctly
   sized".

4. **`sizingPass` takes its round-time measurement from an injected `measurement` object, and nothing
   supplies one yet.** The round loop (`solve/round.js`, Phase 10) records round timings and
   `observability/sli.js` (Phase 11) holds the §20.1 targets; wiring one to the other is a change to
   modules the Phase 13 row does not list, and the same boundary Phase 11 and Phase 12 each recorded
   for the metric registry. Recorded here as the follow-up it is; §14 item 1.

5. **The `Shard.agentCount` denormalisation can drift, and the API reports the drift rather than
   hiding it.** The count is maintained by the handoff in the same transaction as the membership
   rows, so it cannot drift through that path — but a row inserted by any other means would.
   `GET /api/shards` returns both the counted column and the current-row count with a `consistent`
   flag. A periodic reconciliation of the two is not implemented and is not in this phase's scope.

6. **The saga's step machinery is built and driven only by tests.** `advance()` and `compensate()`
   are correct and tested, but no production code calls them: the round loop does not yet know about
   sagas, and §19.6's "Legs are committed in order" needs a coordinator that reads
   `CrossRegionSaga.currentStepIndex`. That is Phase 16f's ("Cross-region candidacy — saga
   compensation tested"), and T2-13 is off by default until then. What this phase owes and delivers is
   the decomposition, the durable saga, and the compensation *decided in advance*.

7. **Two membership counts are updated with `increment`/`decrement` rather than recomputed.** Both
   writes are inside the handoff's transaction and conditional on nothing, so a concurrent handoff for
   a *different* agent on the same shard could in principle interleave. In PostgreSQL an `UPDATE …
   SET x = x - 1` takes a row lock and serialises, so this is safe on the real store; the model does
   not exercise it. Flagged because it is the one place in this phase where correctness rests on the
   database's behaviour rather than on an explicit lock.

8. **Migration not applied to a live database** (§5) — a deployment step, matching every phase since
   6.

## 14. Remaining Non-Blocking Issues

1. **Phase 12's limitation 6 is still open and Phase 13 adds to it**: §21.4's metric registry names
   producers that now exist and its queries are still unwired. Phase 13 adds `sizingPass`'s
   measurement seam (§13 item 4) to the same list.
2. **Phase 12's limitation 4 is now answerable and half-answered.** The Invariant Checker's I3 seam
   (`context.softReservedLegIds`) has a definitive value immediately after a failover — none, because
   every SOFT reservation died with the previous leader — and `failover.run()` returns it. Wiring a
   *running* coordinator's plan state to the checker remains a composition-root concern Phase 15 owns.
3. **Phase 11's principal finding is still open**: `tools/evaluator/counterfactual.js` is built and
   correct but invoked by nothing. Not in Phase 13's path; it should close before Phase 16 touches
   column generation.
4. **Phase 11's second finding is still open**: the shadow/production filter is applied to
   `DecisionRecordA` and not to `DecisionRecordB`.
5. **Phase 9's verification finding is still open**, as Phases 10–12 also recorded:
   `taskAssignment.service.js` and `robotRegistry.service.js` still lack the "superseded banner only"
   header comment every prior phase applied to its own named-but-unmodified legacy files.
6. **The Socket.IO Redis adapter is now *required* and `server.js` still falls back.** The plan's
   Phase 13 Redis row changes the adapter's status from optional to required. `server.js`'s existing
   policy — warn loudly and fall back to the single-process adapter — was deliberately left unchanged,
   because turning a warning into a boot failure is a behaviour change to the *legacy* path, which is
   live and which Phase 13 has no mandate to make fail. The correct place to make it fatal is
   Phase 15's cutover, alongside `ENGINE_ENABLED`. Recorded so a verifier does not read the retained
   fallback as an oversight.
7. **`PHASE_0_INDEPENDENT_VERIFICATION.md` still does not exist**, as every review since Phase 1 has
   recorded.
8. **Phase 10's three verification findings remain open and untouched by this phase** — the
   `admission.js` queue-delay disclosure, the §9.6 requirement-3 tie-break scope, and the doubled
   `intake` object in the `POST /api/tasks/assign` response.
9. **Phase 11's `rejectionTelemetry.retainRow` hash weakness remains open.**
10. **Prisma reports a major version update available (5.22.0 → 7.9.1).** Not evaluated or acted on.

## 15. Readiness for Independent Verification

**Ready.** Suggested focus, in priority order:

1. **The compare-and-set, and the defect it had.** Revert `lockLeadershipRow` from the three CAS
   operations, re-run `shardElection.test.js`, and confirm the storm tests fail. Then judge whether
   "explicit `FOR UPDATE` plus a retained conditional write" is the right reading of §19.5's
   requirement, or whether relying on READ COMMITTED's update re-check would have been acceptable.
   This is the highest-risk code in the phase and the argument is in §10.
2. **"G1 unchanged", independently.** Diff `src/engine/shard/leadership.js` against its Phase 3 form
   and confirm that `readLeadership`, `readLeadershipFence`, `ensureShard`, `advanceFence` and
   `shouldStopCommitting` are byte-identical, that `commit.js` is untouched, and that the migration
   alters no existing table. The whole phase rests on this.
3. **The fence-advance rule.** Acquisition and release advance; renewal does not. Confirm
   independently that this is right — in particular that re-acquisition by the *same* coordinator after
   its own lease lapsed must advance, which the code does and which a plausible optimisation would
   remove.
4. **Whether `failover.js` delegating to §12.4's sweep is the right division.** The argument is that
   Phase 5's orphan scan already performs §19.5's volatile reconstruction and already counts it
   separately, so re-implementing it would give the shard two requeue paths. The argument against is
   that §19.5 describes failover as its own procedure, and a reader looking for "the reconstruction"
   finds an inventory and a delegation. §10 states the case.
5. **The B3 posture gate.** Verify that no code path constructs a leadership store that declares the
   guarantee while declaring an unsafe posture, and judge whether refusing at boot is the right
   severity for an undeclared posture — the alternative being a loud warning, which §19.5's phrasing
   argues against.
6. **The rebalance endpoint's division of labour.** Is "record the intent, return the plan, let the
   supervisor pace the moves" the right shape, or should the endpoint refuse to change shard state
   until the first migration succeeds? The argument for the current shape is in the controller header;
   the argument against is that a plan returned and never executed leaves a shard `DRAINING` with
   nothing draining it.
7. **§19.6's compensation, decided at decomposition.** Confirm that the two-action rule (hold at a
   transfer point where there is one downstream, redirect where there is not) covers the cases §19.6
   intends, and that no path can hold goods at a point failing `requireCustodian()`.
8. **The `commitmentStore.js` extension.** It is a Phase 3 test helper that four phases now depend
   on. Confirm the four new CHECKs match the migration exactly, and that adding `findFirst` and
   `{ decrement }` did not change any existing behaviour — the legacy and gates lanes are unchanged,
   and the engine lane's pre-existing 5,155 tests still pass.

---

*End of Phase 13 Implementation Report.*
