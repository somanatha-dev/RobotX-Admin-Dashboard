# Phase 3 — Commitment core · Implementation & Verification Report

**Phase:** 3 of 16 · **Status:** see §28
**Original implementation:** 2026-07-29 · **This re-verification:** 2026-08-14/15
**Branch:** `feature/dashboard` · **Working tree:** `63f5c58` + uncommitted Phase 3 changes
**Authority:** `IMPLEMENTATION_EXECUTION_PLAN.md` §3 "PHASE 3" and §7 "Phase 3" checklist
**Specification:** `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` (FROZEN) — §2.6, §3.3, §4.1, §10, §12.2, §19.3, §19.5, §24.2, §26

> This report **supersedes** the 2026-07-29 edition. That edition described an
> implementation that had never been executed against a database. This one describes an
> implementation that has, and corrects three claims the earlier one made that live
> execution did not support. Where a claim here is not backed by a command that was run,
> it says so.

---

## 1. Executive summary

Phase 3 delivers §10: exclusivity as a durable, fenced, database-enforced property. The
implementation was already substantially complete and, on inspection, correct. What was
missing was **evidence**, and the missing evidence was the kind that only a real database
produces.

A disposable PostgreSQL 18.3 cluster was built, the migration chain applied to it, and the
shipped `commit.js` driven against it. That produced:

- **The migration executes.** Phases 1→3 (10 migrations) and the full chain (21 migrations)
  both apply cleanly. The partial unique index, the `plpgsql` trigger function, the CHECK
  constraints, and the seeded shard row are all present with the definitions the
  specification requires, read back from `pg_index`, `pg_constraint`, `pg_trigger` and
  `pg_proc`.
- **The database backstops hold.** 17 direct writes bypassing the entire application path —
  no guards, no row locks, no fence allocation — produced 17 correct verdicts.
- **Blocking decision B9 is discharged by execution**, all six questions, including the two
  that had only ever been reasoned about.
- **One real defect was found and fixed.** `isCapacityConstraintViolation` did not classify
  the error PostgreSQL and Prisma actually produce when the capacity backstop fires, so
  `commit()` would have re-thrown a raw driver error instead of returning the graceful
  abort §10.3.2 prescribes. It was invisible to a fully green suite because the JavaScript
  store model authors its own error text.
- **A second defect was found and fixed in the verification apparatus.** The model
  checker's `exhaustive` flag ignored its own depth bound, so every "exhaustive" claim in
  the previous report was a claim about a truncated search. Fixing it also falsified a
  prominent narrative claim, which is corrected here rather than restated.
- **TLC has now been run**, which every report since Phase 3 recorded as not done.

Full suite after the changes: **145 suites, 6 378 tests, 0 failures, 7/7 gates PASS.**

Three claims from the 2026-07-29 report are **withdrawn** (§22). None of them was a safety
claim; all three were characterisations of evidence that a model produced and PostgreSQL
does not.

---

## 2. Phase objective

> **Purpose.** Deliver §10 in full — the correctness core's centre. After this phase,
> exclusivity is a durable, fenced, database-enforced property.

The operative requirement, §10.1:

> for every agent, at every instant, the set of HARD commitments MUST have cardinality ≤
> `capacity[agent]`, under every failure mode including worker crash, network partition,
> cache loss, leader change, duplicate request, and clock skew.

---

## 3. Scope

**In scope and delivered:** the commitment model; two fencing scopes; authority epoch;
per-commitment fence; fence floor; fence allocation; the normative command-class →
fence-scope table; guards G1–G6; the transactional commit path; SERIALIZABLE isolation and
`FOR UPDATE` row locks; schema backstops; capacity enforcement; the partial unique index;
slot allocation; the slot-bound trigger; shard leadership and its fence; `AgentFenceAudit`;
lease grant; idempotency with disjoint namespaces; store-clock discipline; monotonic time;
skew budget; leadership self-removal; the formal model; correctness, concurrency, chaos and
failure-path tests; cache-independence of the durable path.

**Explicitly out of scope** (§26): REST changes · Socket.IO changes · background workers ·
outbox processing · offer semantics · agent-side deduplication · timers · the reconciler ·
lease renewal · settlement · cancellation · reassignment · preemption · scheduling · routing
optimisation · allocation heuristics. None was implemented or modified in this pass.

---

## 4. Files created

| File | Purpose |
|---|---|
| `Backend/tools/verify/phase3LiveDatabase.js` (≈840 lines) | The live-PostgreSQL verification harness. Drives the **shipped** `commit.js`, `db/prisma.js` and `shard/leadership.js` against a real instance: 82 checks across B9, the nominal commit, idempotency, three concurrency scenarios, three guard races under two isolation levels, error classification, the store clock, and cache independence. Deliberately **not** a Jest suite — it requires a database, and a test that silently skips when its environment is absent reports green for having done nothing |

The commitment core's own eight modules, the migration, and the TLA+ module were created in
the original Phase 3 pass and are unchanged in this one except as listed in §5.

---

## 5. Files modified

| File | Change | Why |
|---|---|---|
| `Backend/src/engine/commitment/commit.js` | +68 / −4 | **Defect fix D1** — `isCapacityConstraintViolation` rewritten to match the three error shapes PostgreSQL and Prisma actually produce (§22.1) |
| `Backend/tests/engine/helpers/commitmentModel.js` | +52 / −7 | **Defect fix D2** — `check()` now reports `exhaustive`, `depthTruncated` and `stateCapExceeded` separately, so a depth-truncated search can no longer report itself as a proof (§22.2) |
| `Backend/tests/engine/commitmentModelCheck.test.js` | +170 / −51 | Rewritten around D2: closed searches where affordable, bounded searches asserted *as* bounded, and the corrected capacity-1 narrative |
| `Backend/tests/engine/commitmentTransaction.test.js` | +99 / −7 | Regression tests for D1, built from error objects transcribed verbatim from the live run |
| `formal/README.md` | Status section rewritten | TLC has now been executed; the file said it had not, and separately made an exhaustion claim that was not true of either checker |

**Nothing else was touched.** `git diff --name-only` over the whole repository lists exactly
these files plus the new `tools/verify/`. No migration, no schema, no route, no socket
handler, no worker, no later-phase module.

---

## 6. Architecture implemented

```
Coordinator pins a round snapshot
        │  (leadershipFence, authorityEpoch, legVersion, expectedLegState)
        ▼
runSerializable  ──►  BEGIN ISOLATION LEVEL SERIALIZABLE
        │
        ├─ idempotency: findUnique(commitmentId)  ──► ALREADY_COMMITTED
        │
        ├─ 1. SELECT … FOR UPDATE  "Agent"   (always first)
        │     SELECT … FOR UPDATE  "Leg"
        │     SELECT … FOR SHARE   "ShardLeadership"
        │
        ├─ 2. G1 G2 G3 G4 G5 G6 — all six evaluated, none short-circuits
        │
        ├─ 3. volatileRecheck seam (required; Phase 6 populates)
        │
        ├─ 4. fence = fenceCounter + 1;  UPDATE Agent SET fenceCounter
        │     slot  = lowestFreeSlot;    INSERT Commitment (HARD)
        │     lease = storeNow + lease.duration
        │     UPDATE Leg SET state, version+1 WHERE id = ? AND version = ?
        │     UPSERT AgentFenceAudit          (I6 high-water)
        │
        ├─ 5. sideEffects seam (required; Phase 4's outbox row)
        ├─ 6. decisionRef carried in the same insert
        └─ 7. COMMIT
                    │
   database backstops, independent of every line above:
     partial unique index (agentId, capacitySlot) WHERE releasedAt IS NULL
     CHECK capacitySlot >= 0 · CHECK kind = 'HARD' · slot-bound trigger
```

---

## 7. Commitment model

`model.js` is the single definition of the §2.6 shape. Verified:

| Property | Result | Evidence |
|---|---|---|
| The §2.6 field list is carried in full | PASS | `commitmentFencing.test.js`; the live row read back carries every field |
| Active ≡ `releasedAt IS NULL` — the same predicate the index is built on | PASS | Code read; the live partial index's predicate read back from `pg_index` is literally `("releasedAt" IS NULL)` |
| Deterministic lowest-free-slot allocation, order-independent, reused after release | PASS | Unit tests; live: slot 0 after release is reusable (backstop B7) |
| Soft-persistence refusal | PASS | `refuseSoftPersistence` throws; the CHECK rejects a `SOFT` row written through Prisma and through raw SQL |
| Malformed commitments refused before the write | PASS | `validateCommitment` |

---

## 8. Fencing model

**The normative table was checked in both directions, mechanically**: all 18 commands the
specification names are present with the correct scope, and the implementation contains no
command the specification does not name. An unrecognised command **throws** rather than
being treated as unfenced.

| Scope | Commands | Rejection rule | Verified |
|---|---|---|---|
| Commitment (mission) | `OFFER`, `WITHDRAW`, `REROUTE`, `RESEQUENCE`, `RECALL`, `RESUME`, `TRANSFER_CUSTODY`, `ABORT_MISSION` | reject if `fence ≤ highest_seen[commitment_id]` **or** `fence ≤ fence_floor` | PASS |
| Agent | `STAND_DOWN_ALL`, `QUARANTINE`, `RELEASE_QUARANTINE`, `ESTOP_CLEAR`, `SHARD_MIGRATE`, `SESSION_REKEY`, `PARAMETER_PUSH` | reject if `authority_epoch < highest_seen_authority` | PASS |
| Query | `STATUS_REQUEST`, `PROBE`, `MANIFEST_QUERY` | never fenced | PASS |

The `≤` / `<` asymmetry between the two rules is the specification's own and is asserted as
such. The comparison is **per commitment id**: `acceptsMissionCommand` takes a map keyed by
commitment id and will not accept a scalar maximum at all, so the defect §10.3.1 names
cannot be reintroduced by passing the wrong argument.

`fence_floor`: `applyAgentCommand` returns an empty per-commitment table, so one
`STAND_DOWN_ALL` fences every commitment the agent holds without enumerating them. Driven
with three commitments in the unit suite and exercised by both model checkers.

**Multi-fence scenarios exercised:** multiple commitments; multiple fences; an agent-level
command; a commitment-level command; a stale command; a fresh command; equal, lower and
higher fences — `commitmentFencing.test.js` covers each, and the model checkers explore
every interleaving of them.

---

## 9. G1–G6

Each guard is a separate pure function with its own abort reason; `evaluateGuards` runs all
six without short-circuiting, so a test that violates one can assert the other five passed.
That is exactly what the unit suite does for all six.

| # | Guard | Owns exactly | Unit | Live DB |
|---|---|---|---|---|
| G1 | `shard.leadership_fence` equals the pinned value — **equality**, not `≥` | Leadership superseded, or absent, or the round pinned nothing | PASS | PASS |
| G2 | active HARD count `< capacity[agent_class]` | Over-commitment; refuses a non-positive-integer capacity rather than defaulting | PASS | PASS |
| G3 | agent `authority_epoch` equals the snapshot — **agent scope** | Quarantine, e-stop, migration, stand-down since the snapshot | PASS | PASS |
| G4 | Leg `version` equals the snapshot | Concurrent Leg modification | PASS | PASS |
| G5 | `cancel_requested_at IS NULL` **OR** `purpose ∈ custodial_purposes` | Cancelled work, while admitting the recovery Legs cancellation mandates | PASS | PASS — a cancelled `PRIMARY` Leg is refused and a cancelled `RECOVERY` Leg commits |
| G6 | Leg state is the expected one; an undeclared expectation is itself a failure | Committing from an unexpected state | PASS | PASS |

Two counterfactuals are executed rather than argued: a G3 written against `fence_counter`
rejects the second commit of the same round, and an unqualified G5 refuses exactly the
`RECOVERY` and `TRANSFER` Legs that §4.6 mandates.

---

## 10. Transaction semantics

| §10.3.2 step | Implementation | Live evidence |
|---|---|---|
| 1 — agent `FOR UPDATE`, Leg `FOR UPDATE` | `lockRows`, **agent first, always** | Lock order instrumented on the real client: `Agent,Leg`. A second `FOR UPDATE` on the same row waited for the first transaction to commit (measured) |
| 2 — the guard set, every guard aborting | `evaluateGuards` | All six exercised against real rows |
| 3 — volatile-subset re-check | required injected dependency; absence throws | Unit |
| 4 — allocate fence, advance counter, insert commitment, update Leg | `applyCommit` | Counter 0 → 1, commitment carries fence 1, `authority_epoch` unmoved, Leg `PLANNED`/0 → `OFFERED`/1 |
| 5 — outbox row in the same transaction | `sideEffects` seam, required | Unit; Phase 4 owns the writer |
| 6 — decision-record reference | `Commitment.decisionRef` | Row read back |
| 7 — commit | return from the callback | — |

**Isolation.** Both legs of the specification's disjunction, and this is now measured rather
than assumed: inside `runSerializable`, `SHOW transaction_isolation` returns
`serializable`. The ergonomic path (`$transaction` with no options) returns
`read committed` — which confirms the premise B9 rests on, that the default path does not
satisfy §10.3.2.

**Rollback.** Any guard failure, any lost volatile predicate, any thrown side effect
discards every write. Asserted individually on the live database after each of nine aborted
attempts: no commitment row, no fence advance, no Leg transition, no audit row.

**No internal retry.** A serialisation failure returns `SERIALIZATION_FAILURE` and writes
nothing; the round loop owns the retry decision (§10.3.2's own disposition).

---

## 11. Database schema

Read back from the live catalogue, not from the migration file:

| Object | Definition as it exists in PostgreSQL 18.3 |
|---|---|
| `Commitment.capacitySlot` | `integer NOT NULL DEFAULT 0` |
| `Commitment_agent_capacity_slot_active_key` | `CREATE UNIQUE INDEX … ON "Commitment" ("agentId","capacitySlot") WHERE ("releasedAt" IS NULL)` — `indisunique = t`, `indpred = ("releasedAt" IS NULL)` |
| `Commitment_capacity_slot_non_negative` | `CHECK (("capacitySlot" >= 0))` |
| `Commitment_kind_hard_only` | `CHECK ((kind = 'HARD'::text))` — Phase 2's, correctly not restated by Phase 3 |
| `Commitment_capacity_slot_in_bounds` | `BEFORE INSERT OR UPDATE … FOR EACH ROW EXECUTE FUNCTION commitment_capacity_slot_in_bounds()` |
| `commitment_capacity_slot_in_bounds()` | `plpgsql`, volatile — **compiled by the server**, which no static check establishes |
| `ShardLeadership` | 10 columns; `leadershipFence BIGINT NOT NULL DEFAULT 0`; unique on `shardId`; index on `leaseExpiry` |
| `AgentFenceAudit` | 7 columns; both high-water marks `BIGINT`; unique on `agentId`; index on `observedAt` |
| Seed row | `shard-leadership-default` / `default` / fence `1` / `lastAdvancedBy = migration:20260729120000_commitment_core` |
| FKs | `Commitment_agentId_fkey` and `Commitment_legId_fkey`, both `ON DELETE RESTRICT` |

**The seed is idempotent in fact, not by inspection**: re-executing the migration's
`INSERT … ON CONFLICT ("shardId") DO NOTHING` reported `INSERT 0 0` and left the row count
at 1 and the fence at 1.

**The trigger reads correctly.** `SELECT COALESCE("capacityOverride", 1) INTO
"effective_capacity" FROM "Agent" WHERE "id" = NEW."agentId"`, with a NULL result meaning
"no such agent". That branch is **reachable and correct**: an insert naming a non-existent
agent raised `P0001 Commitment … names agent … which does not exist` — the trigger fires
before the foreign key does. It does not count rows, which is what keeps it immune to the
interleaving the index closes.

---

## 12. Migration

| Run | Migrations | Result |
|---|---|---|
| Phases 1 → 3 | 10, in directory order, `psql -v ON_ERROR_STOP=1` | **All applied.** `20260729120000_commitment_core` applied cleanly |
| Full chain | 21 | **All applied** |

Both against a disposable PostgreSQL 18.3 cluster built from the installed binaries on port
55432. Neither the shared Neon instance nor the developer's own cluster on 5432 was
touched.

Forward-only, matching the repository's convention: no migration in this programme carries a
`down`, so **rollback was not executed** and is not claimed.

---

## 13. PostgreSQL verification

**Environment.** PostgreSQL 18.3 (x86_64-windows), fresh cluster, `initdb … -A trust`, port
55432, two databases: `robotx_phase3` (Phases 1→3 only) and `robotx_full` (all 21).

### 13.1 The harness result

`tools/verify/phase3LiveDatabase.js` — **82 checks, 82 passed, 0 failed**, run twice:

- against `robotx_full` — 82/82;
- against `robotx_phase3` — 82/82. This second run establishes something the first cannot:
  **Phase 3's own migration is sufficient for the commitment core.** No later phase's DDL is
  required for any part of §10.

### 13.2 Database backstops, driven without the application (§11 of the brief)

17 writes issued as raw SQL with no guards, no locks and no fence allocation:

| # | Attempt | Expected | Actual | SQLSTATE |
|---|---|---|---|---|
| B1 | first active commitment, slot 0 | accepted | accepted | — |
| B2 | second active commitment, same (agent, slot) | rejected | rejected | `23505` `Commitment_agent_capacity_slot_active_key` |
| B3 | slot 1 on a capacity-1 agent | rejected | rejected | `P0001` trigger |
| B4 | negative slot | rejected | rejected | `23514` |
| B5 | `kind = 'SOFT'` (I18) | rejected | rejected | `23514` `Commitment_kind_hard_only` |
| B6 | duplicate `commitmentId` | rejected | rejected | `23505` |
| B7 | slot 0 reused after release | accepted | accepted | — |
| B8 | un-releasing into an occupied slot | rejected | rejected | `23505` |
| B9 | capacity-2 agent, slot 0 | accepted | accepted | — |
| B10 | capacity-2 agent, slot 1 | accepted | accepted | — |
| B11 | capacity-2 agent, slot 2 | rejected | rejected | `P0001` |
| B12 | capacity lowered to 1, then an UPDATE touching the slot-1 row | rejected | rejected | `P0001` |
| B13 | commitment naming a non-existent agent | rejected | rejected | `P0001` |
| B14 | deleting an agent that holds a commitment | rejected | rejected | `23001` RESTRICT |
| B15 | second `ShardLeadership` row for one shard | rejected | rejected | `23505` |
| B16 | first `AgentFenceAudit` row | accepted | accepted | — |
| B17 | duplicate `AgentFenceAudit` row for one agent | rejected | rejected | `23505` |

B7, B8 and B12 are the three that a static reading of the DDL cannot settle, and all three
behave as the design requires.

### 13.3 Blocking decision B9 — discharged, question by question

| # | Question | Answer | Evidence |
|---|---|---|---|
| 1 | Does Prisma actually execute the commitment transaction at the requested isolation level? | **Yes** | `SHOW transaction_isolation` inside `runSerializable` → `serializable`; inside a bare `$transaction` → `read committed` |
| 2 | Does PostgreSQL provide the expected SERIALIZABLE behaviour? | **Yes** | Two transactions with a read/write dependency cycle: one committed, one aborted with `40001 could not serialize access due to read/write dependencies among transactions`, which `isSerializationFailure` classified |
| 3 | Do `SELECT … FOR UPDATE` statements behave as intended? | **Yes** | A second `FOR UPDATE` on the same Agent row acquired 3–4 ms *after* the first transaction released it, never before |
| 4 | Is the lock ordering correct? | **Yes** | Instrumented on the real client: `Agent` then `Leg`, every time |
| 5 | Does the partial unique index enforce the intended invariant? | **Yes** | B2, B7, B8 above, plus every concurrency run |
| 6 | Does the planner recognise and use the partial index? | **Yes** | Over 16 000 rows, 8 000 active, after `ANALYZE`: the point lookup uses `Index Scan using "Commitment_agent_capacity_slot_active_key"`, and the commit path's own active-set read uses `Bitmap Index Scan` on the same index. The partial index is 528 kB against a 2 264 kB table |

---

## 14. Concurrency verification

All against real PostgreSQL MVCC, driving the shipped `commit()`.

| Scenario | Result |
|---|---|
| **Storm, capacity 1** — 8 concurrent commits, one agent, distinct Legs and rounds | Exactly **one** committed. Census: 1 committed, 6 × `G2_AGENT_AT_CAPACITY`, 1 × `SERIALIZATION_FAILURE`, **0 threw**. Database: 1 active commitment, 1 fence allocated, `authority_epoch` unmoved, exactly one Leg moved |
| **Storm, capacity 2** — 8 concurrent commits | Round 1: 1 committed, 7 × `SERIALIZATION_FAILURE`, never more than capacity active. After the next round (the losers re-presented, as §10.3.2 prescribes): exactly **2** active, slots `[0,1]`, two distinct fences, `authority_epoch` unmoved, exactly two Legs moved. **See §22.3 — this corrects a claim in the previous report** |
| **Sequential capacity 2** (I19) | Both commits succeed **against the same pinned `authority_epoch`**, slots 0 and 1, fences 1 and 2; a third is refused by G2 |
| **Retry storm** — 8 concurrent commits with an **identical** idempotency key | Exactly one durable commitment, one fence, one Leg version increment, one audit row, **0 threw**. This was the gap the independent verification flagged as reasoned-but-untested; it is now executed |
| **Leadership race (G1)** | See §15 |
| **Authority-epoch race (G3)** | See §15 |
| **Leg-version race (G4)** | See §15 |

---

## 15. Failure and chaos verification

Each guard race was run in **three** configurations, because the two isolation levels give
different — and both correct — answers:

| Race | At SERIALIZABLE | At READ COMMITTED |
|---|---|---|
| **A — the world moved *before* the transaction began** (the pinned snapshot is stale) | The guard aborts: `G1_LEADERSHIP_FENCE_ADVANCED`, `G3_AUTHORITY_EPOCH_CHANGED`, `G4_LEG_VERSION_CHANGED` respectively. Nothing written | — |
| **B — the world moved *while* the transaction was open** | PostgreSQL aborts the transaction with `40001` **before the guard is evaluated**, classified as `SERIALIZATION_FAILURE`. Nothing written | **The guard aborts**, with its own reason. Nothing written |

Race B at READ COMMITTED is the configuration §10.3.2 prohibits, driven deliberately to
establish that the guards are load-bearing rather than decorative: with the store declining
to intervene, G1, G3 and G4 are what fence the write. That is the strongest available
demonstration that the guard set is not merely redundant with the isolation level.

"Nothing written" is checked component by component after every abort: no commitment row, no
fence advance, no Leg state change, no Leg version change, no audit row.

Also verified live: advancing the shard leadership fence touches **no** `Agent` row —
neither `authority_epoch` nor `fence_counter` moves (§19.5).

The repository's own chaos suite (`tests/chaos/commitment.chaos.test.js`, 6 tests including
thirty kills at random moments and a worker paused past its lease) passes unchanged.

---

## 16. Idempotency verification

| Property | Result | Evidence |
|---|---|---|
| `commitment_id = f(leg_id, agent_id, decision_round_id)`, deterministic, no clock, no randomness | PASS | Unit; the live row's id equals the independently derived one |
| A sequential retry returns the original result and allocates no second fence | PASS | Live: `ALREADY_COMMITTED`, `fenceCounter` still 1, one row |
| A **concurrent** retry storm never double-commits | PASS | Live, 8-way, §14 |
| The two command namespaces are disjoint | PASS | By construction (namespace is the first field; the separator cannot appear inside a component) and by test |
| A component containing the separator is refused | PASS | Unit |

---

## 17. Lease verification

| Property | Result | Evidence |
|---|---|---|
| Granted at commit, from the **store's** clock | PASS | Live: `expiry − grantedAt = 60 000 ms` exactly; `grantedAt` within 24 ms of the store's `NOW()` |
| Absolute expiry, not a duration | PASS | Column is `timestamp` |
| A non-positive duration is refused rather than silently granted | PASS | Unit |
| Renewal requires commitment-scoped evidence — id **and** fence | PASS | Unit; evidence naming another commitment, or carrying a different fence, is insufficient |
| Renewal itself | **Out of scope** — Phase 5 | `commitment/leases.js` implements no renewal path |

---

## 18. Clock verification

| §10.6 claim | Result | Evidence |
|---|---|---|
| Deadlines are absolute timestamps from the store's clock | PASS | Live |
| `NOW()` inside a transaction is the transaction's start time, so one commit has one origin | **PASS — measured** | Live: two `NOW()` readings 250 ms apart inside one transaction are byte-identical, while `clock_timestamp()` advanced by 260 ms in the same transaction. The claim in `clock.js`'s header is now a measurement |
| The store clock is read through the transaction client, never a wall clock | PASS | `readStoreTime` refuses a non-transaction client |
| Monotonic source independent of the wall clock | PASS | `process.hrtime.bigint()` |
| Skew is signed; both directions distinguishable | PASS | Unit |
| A node beyond `time.max_clock_skew` removes itself from leadership eligibility | PASS | `assessLeadershipEligibility` |
| Safety does not depend on synchronised clocks | PASS | No branch in `commit.js` reads a clock for a safety decision; the chaos suite shows a skewed coordinator's late commit still aborts at G1 |

---

## 19. Formal model

### 19.1 TLC — executed, which no previous report could say

TLA+ 1.8.0 (`tla2tools.jar`), Java 20, `formal/commitment.tla`:

| Configuration | Model | Result |
|---|---|---|
| `commitment_c1.cfg` (**as checked in**) | 3 Legs, 2 Workers, Capacity 1, MaxFence 5 | **Complete state graph.** 17 991 520 states generated, **2 375 660 distinct**, diameter **21**, **no error found**, 48 s |
| Capacity 2, **reduced** | 2 Legs, 2 Workers, Capacity 2, MaxFence 4 | **Complete state graph.** 37 633 116 generated, **4 769 532 distinct**, diameter 21, **no error found**, 69 s |
| `commitment_c2.cfg` (as checked in) | 3 Legs, 2 Workers, MaxFence 5 | **NOT COMPLETED** — stopped after >1 h with an 11 GB disk queue still growing |
| Capacity 3 | 3 Legs, MaxFence 4 | **NOT COMPLETED** within this session's budget |

The completed capacity-2 run is the one §24.2's argument turns on: it keeps `Capacity = 2`,
so the concurrent-commitment case exists in the model, and reduces only the Leg count and
the fence bound.

**Model written: YES. TLC executed: YES, at capacity 1 (full configuration) and capacity 2
(reduced). TLC completed at capacity 3: NO — resource-bound, not a failure.**

### 19.2 Correspondence between the model and the implementation

Checked line by line. `Commit(w)` allocates `fenceCounter + 1`, takes the lowest free slot,
advances the Leg's state and version, and leaves `authorityEpoch` `UNCHANGED` — which is
`applyCommit`'s behaviour. The safety conjunction maps to the invariants: `AtMostCapacity`
→ I1, `DistinctSlots` → the partial unique index, `DistinctFences` → I6, `TerminalIsFinal`
→ I12, `OnlyHardCommitments` → I18, `AllActiveCommandable` → I19, and the witness counters
→ I5.

**One correspondence gap, disclosed:** `GuardsPass == G1 ∧ G2 ∧ G3 ∧ G4 ∧ G6`. **G5 is
absent from both models** — neither models a cancelled Leg, so the guard would be vacuous.
G5's evidence is the unit suite and the live-database run, not the formal one. This is
recorded in `formal/README.md` as well.

### 19.3 The executable equivalent, corrected

The JavaScript checker's distinct value is that its transitions call the shipped modules.
Its results, with the **kind** of result each is now stated:

| Shape | States | Transitions | Max depth | Search | Violations |
|---|---|---|---|---|---|
| Capacity 1, 2 Legs, 2 workers, depth 21 | 44 124 | 160 486 | 21 | **closed** | 0 |
| Capacity 2, 2 Legs, 2 workers, depth 21 | 114 848 | 455 718 | 21 | **closed** | 0 |
| Capacity 1, 2 Legs, 2 workers, depth 9 | 6 443 | 28 852 | 9 | bounded | 0 |
| Capacity 2, 3 Legs, 2 workers, depth 9 | 42 123 | 245 725 | 9 | bounded | 0 |
| Capacity 3, 4 Legs, 2 workers, depth 9 | 135 001 | 902 537 | 9 | bounded | 0 |

The bounded shapes carry more Legs than capacity, so over-commitment is *reachable* in them
and the G2 mutation has something to violate; the closed shapes are where the frontier
genuinely empties. The suite now asserts closure where it holds and asserts **truncation**
where it does not.

The mutation suite is unchanged in substance and still has teeth: dropping G1, G2, G3 or G4
is caught; dropping G6 is not, because in this model every state change also moves the
version — that is §4.1 rule 2 holding, and it is asserted rather than left silent.

---

## 20. Test results

```
npm run verify
  gate:tiers      PASS — no Tier 0/1 → Tier 2 dependency
  gate:params     PASS — 183 engine modules against 242 registered parameters
  gate:tenets     PASS — 274 modules, no violations
  gate:privacy    PASS — 16 modules, no identifying field
  gate:erasure    PASS — 3 decisions reconstructed byte for byte
  gate:legacy     PASS — 4 retired modules absent across 303 files
  gate:columngen  PASS (NOT_REQUIRED)

  Test Suites: 145 passed, 145 total
  Tests:       6 378 passed, 6 378 total
  Time:        1 301 s
```

Phase 3's own suites: `commitmentFencing` (72), `commitmentGuards` (31),
`commitmentSchema` (63), `commitment.chaos` (6) — 172 together — plus
`commitmentTransaction` **45** (+7) and `commitmentModelCheck` **31** (+8).

Live-database harness: **82 checks, 82 passed**, twice. Database backstops: **17/17**.

**Note on runtime.** `commitmentModelCheck.test.js` now takes ~154 s, up from ~50 s, because
a closed search costs more than a truncated one. That is the price of the claim being true.

---

## 21. Requirement matrix

| Requirement | Spec | Code | Migration | PostgreSQL | Test | Status |
|---|---|---|---|---|---|---|
| Commitment shape and durability rule | §2.6 | `model.js` | `Commitment` | verified | unit | **PASS** |
| Only HARD commitments persist (I18) | §2.6 | `refuseSoftPersistence` | `Commitment_kind_hard_only` | rejects `SOFT` via Prisma **and** raw SQL | unit + live | **PASS** |
| Two fencing scopes | §10.3.1 | `fencing.js` | `Agent.authorityEpoch`, `fenceCounter`, `Commitment.fence` | columns verified | 72 tests + both model checkers | **PASS** |
| Normative command table, both directions | §10.3.1 | `fencing.js` | n/a | n/a | mechanical both-direction check, 18/18 | **PASS** |
| Unknown command is never unfenced | §10.3.1, T2 | `fenceScopeOf` throws | n/a | n/a | unit | **PASS** |
| `fence_floor` invalidates all commitment authorities | §10.3.1 | `applyAgentCommand` | n/a | n/a | unit + model | **PASS** |
| Fence allocation, strictly monotone (I6) | §10.3.2 §4 | `allocateFence` | `BIGINT` | counter 0→1, audit row written atomically | unit + live | **PASS** |
| G1 leadership fence, re-read in-transaction | §10.3.2 | `g1LeadershipFence` | `ShardLeadership` | aborts at both isolation levels | unit + live + TLC | **PASS** |
| G2 capacity | §10.3.2 | `g2Capacity` | index + trigger | aborts; backstop independently rejects | unit + live + TLC | **PASS** |
| G3 agent-scope epoch | §10.3.2 | `g3AuthorityEpoch` | `Agent.authorityEpoch` | aborts | unit + live + TLC | **PASS** |
| G4 Leg version | §10.3.2, §4.1 r2 | `g4LegVersion` | `Leg.version` | aborts | unit + live + TLC | **PASS** |
| G5 cancellation, purpose-conditioned | §10.3.2, §4.6 | `g5Cancellation` | `Leg.cancelRequestedAt` | PRIMARY refused, RECOVERY admitted | unit + live | **PASS** (no formal-model counterpart — §19.2) |
| G6 expected Leg state | §10.3.2 | `g6LegState` | `Leg.state` | aborts | unit + live | **PASS** |
| SERIALIZABLE isolation | §10.3.2 | `runSerializable` | n/a | `SHOW transaction_isolation` = `serializable` | live | **PASS** |
| `FOR UPDATE` on agent **and** Leg, fixed order | §10.3.2 §1 | `lockRows` | n/a | blocks; order `Agent,Leg` | live | **PASS** |
| Partial unique index (I1) | §10.3.2 | slot allocator | `Commitment_agent_capacity_slot_active_key` | predicate verified; rejects; planner uses it | live | **PASS** |
| Slot-bound trigger | §10.3.2 | — | `commitment_capacity_slot_in_bounds()` | compiles; rejects; all branches reachable | live | **PASS** |
| Capacity cannot be violated | §10.1, I1 | G2 + slot allocator | index + trigger | never exceeded in any concurrency run | live + model | **PASS** |
| `ShardLeadership` + static row | plan C1 | `leadership.js` | table + seed | seeded at fence 1; re-insert is a no-op | live | **PASS** |
| `AgentFenceAudit` (I6) | §26 | `applyCommit` upsert | table | written in the same transaction; absent after every abort | live | **PASS** |
| Lease granted at commit (I2) | §12.2 | `leases.grant` | `leaseExpiry` | exactly `store_now + 60 s` | live | **PASS** |
| Idempotency on derived id | §10.5 | `idempotency.js` | unique index | sequential **and** concurrent | live | **PASS** |
| Disjoint command namespaces | §10.5 | `idempotency.js` | n/a | n/a | unit | **PASS** |
| Store-clock discipline | §10.6 | `clock.js` | n/a | `NOW()` transaction-stable, measured | live | **PASS** |
| Skew budget, leadership self-removal | §10.6 | `assessLeadershipEligibility` | n/a | n/a | unit + chaos | **PASS** |
| Conditional versioned Leg write | §4.1 r2 | `updateMany` + count check | `Leg.version` | one row, version +1 | live | **PASS** |
| Cache independence (I16) | §10.4, §26 | no import anywhere under `commitment/` | n/a | commits succeed with no cache in the module graph | live | **PASS** |
| Formal model, capacity 1 | §24.2 | — | — | — | **TLC complete, 0 errors** | **PASS** |
| Formal model, capacity 2 | §24.2 | — | — | — | **TLC complete on a reduced model, 0 errors**; JS checker closed, 0 violations | **PASS** |
| Formal model, capacity 3 | §24.2 | — | — | — | JS checker **bounded**, 0 violations; TLC did not complete | **PARTIAL** |
| Migration applies | plan | — | 10 and 21 migrations | applied cleanly | live | **PASS** |
| Migration rollback | repo convention | — | forward-only, no `down` | not executed | — | **OUT OF SCOPE** |
| Volatile-subset re-check | §10.3.2 §3 | required seam | n/a | n/a | unit | **PASS** (Phase 6 populates) |
| Outbox in the same transaction | §11.1 | required seam | n/a | n/a | unit | **OUT OF SCOPE** (Phase 4 owns the writer) |
| `reserveRobot` demoted to advisory | §10.4 | opt-in advisory mode | n/a | n/a | unit | **PARTIAL — conditioned by the plan itself**, §25 |

No unexplained discrepancy remains between specification, schema, migration, database,
application code and tests.

---

## 22. Defects found

### 22.1 D1 — CRITICAL-adjacent (severity **HIGH**, robustness): the capacity backstop's rejection was not classified

**What was wrong.** `isCapacityConstraintViolation` matched on the index's name, on the
literal string `capacity slot`, and on SQLSTATE `23505` in `error.code`. Executing each
rejection against PostgreSQL 18.3 through Prisma 5.22 shows that the shape the commit path
actually produces carries **none** of those:

```
prisma.commitment.create() → partial unique index violation
  constructor : PrismaClientKnownRequestError
  code        : "P2002"                       ← not 23505
  meta.target : ["agentId","capacitySlot"]    ← the only place the columns appear
  message     : "Unique constraint failed on the fields: (`agentId`,`capacitySlot`)"
                                              ← the index's NAME appears nowhere
```

**What it violated.** §10.3.2 requires a failed commit to return the pairing to the next
round with the cause recorded. Unclassified, the error propagated out of `commit()` as a
raw driver rejection instead of an `ABORTED` result carrying
`CAPACITY_CONSTRAINT_VIOLATED`.

**Why it survived a green suite.** The JavaScript store model authors its own error text,
and that text contains the constraint name — so the classifier matched the fixture and
would not have matched production. This is the same class of defect Phase 2's closure
found: an in-memory double cannot evidence a schema-facing claim.

**Severity.** Not a safety violation — the database still refused the write and nothing was
persisted in any case. It is a failure-mode defect: the graceful abort is what returns the
pairing to the round loop, and a thrown driver error does not.

**The fix.** Four recognisers, one per shape the backstop can produce, plus the explicit
non-recognition of a `commitmentId` collision (an idempotency-key collision, not a capacity
violation). Smallest change that covers the executed evidence.

**Regression test.** Six tests built from the error objects **transcribed verbatim** from
the live run, plus one that drives `commit()` into the real shape and asserts a graceful
`ABORTED`. Live re-run: `isCapacityConstraintViolation` now classifies both the index and
the trigger rejection.

### 22.2 D2 — MEDIUM (verification rigour): the model checker reported truncated searches as exhaustive

**What was wrong.** `check()` set `exhaustive = false` only when the 400 000-state cap was
hit. The **depth bound** — which every caller set to 9 and every run hit — did not move the
flag at all.

**What it violated.** §24.2's gate is a model check, and the previous report cited
"exhaustive, search exhausted in every case" as its discharge. Re-running the same
unmodified checker at greater depth shows the capacity-2 space growing 8.6× within three
more actions; the true diameter of that space is 21, not 9.

**The fix.** `exhaustive`, `depthTruncated` and `stateCapExceeded` are reported separately,
and detecting depth truncation precisely costs one extra expansion per node sitting at the
bound. The suite now runs closed searches where they are affordable and asserts *truncation*
where they are not, and a dedicated test fails if the distinction is ever collapsed again.

**What the fix then falsified.** The claim that §10.3.1's named defect is "invisible at
capacity 1" is **false**. Searched to closure, the same checker finds it at capacity 1 in a
trace of 14 actions. What is actually true, and is now what the suite asserts: at capacity 1
the counterexample requires a commitment to **settle** first — it is a stale redelivery for
a commitment that is no longer active, and it never involves two commitments held at once.
§10.3.1's own worked example is the concurrent one, and only capacity ≥ 2 can exhibit it.
That is the precise version of §24.2's argument.

### 22.3 D3 — MEDIUM (documentation accuracy): three claims the model supported and PostgreSQL does not

| Withdrawn claim (2026-07-29 report) | What PostgreSQL does |
|---|---|
| "Storm at capacity 2 → **two winners**, two slots, two fences" | One winner per round. All eight attempts take `FOR UPDATE` on the same Agent row; under SERIALIZABLE a blocked reader whose row was updated by a committed concurrent transaction is aborted with `40001`, not allowed to re-read. Two winners require **two rounds** — which is §10.3.2's own disposition. Safety is unaffected: capacity was never exceeded |
| "Chaos test: pause, leadership change, resume → `G1_LEADERSHIP_FENCE_ADVANCED`" | At SERIALIZABLE the store aborts the transaction with `40001` **before G1 is evaluated**. G1's abort is observable when the world moves *before* the transaction begins, or at READ COMMITTED. Both are now tested; the guard is still load-bearing, and is now shown to be |
| "Storm at capacity 1 → 7 abort on G2" | 6 abort on G2 and 1 on serialisation failure, varying with connection-pool timing. Exactly one winner either way |

None of the three is a safety claim. All three were true of the JavaScript store model and
are not true of PostgreSQL, which is why the model's limitations were listed as a risk in
the original report and why that risk was correctly identified.

### 22.4 Findings **not** fixed, with the reason

| Finding | Classification | Why not fixed here |
|---|---|---|
| `tests/engine/helpers/lifecycleModel.js` carries the **same** `exhaustive` defect as D2 (flag set only at `maxStates`) | **B — later phase.** Phase 15's artefact | Fixing it would change what Phase 15's own gate reports. Recorded here, and in `formal/README.md`, as a carried-forward finding for Phase 15 |
| A concurrent duplicate that survived to the insert would surface a `P2002` on `commitmentId` rather than `ALREADY_COMMITTED` | **A — Phase 3, but not reachable** | With SERIALIZABLE + `FOR UPDATE` on the agent row it cannot occur, and the 8-way retry storm confirmed it does not. Reachable only if the isolation level were weakened, which §10.3.2 prohibits. Recorded, not changed — a speculative fix to an unreachable path is not a justified change |
| `commitment_c2.cfg` / `c3.cfg` do not converge on a workstation | **F — environment limitation** | The configurations are correct; they need CI-scale resources |

---

## 23. Defects fixed

| # | Defect | Fix | Verified by |
|---|---|---|---|
| D1 | Capacity-backstop rejection not classified | `commit.js` +68/−4 | 6 regression tests from verbatim live errors; live re-run 82/82 |
| D2 | Model checker reported truncation as exhaustion; a narrative claim built on it was false | `commitmentModel.js` +52/−7; suite rewritten | 31 tests including three that assert the checker's own honesty |
| D3 | Three inaccurate claims in the previous report | Withdrawn and corrected in §22.3 | The live runs that falsified them |

---

## 24. Remaining risks

| Risk | Assessment |
|---|---|
| **The verification database is not the production database** | The cluster was PostgreSQL 18.3 built from local binaries; production is Neon. Version, extensions, connection pooling (PgBouncer semantics for interactive transactions) and network latency all differ. Everything B9 asked is answered *for PostgreSQL 18.3*; a pooled Neon endpoint could behave differently for interactive transactions specifically, and that is worth confirming before cutover |
| **TLC has not completed at capacity 3** | The JavaScript checker's capacity-3 run is bounded (depth 9, 135 001 states, 0 violations) and TLC completed at capacity 1 and at a reduced capacity 2. Capacity 3 is a resource gap, not a modelling one |
| **G5 has no formal-model counterpart** | Covered by unit and live tests; disclosed in §19.2 and in `formal/README.md` |
| **The JavaScript store model's concurrency results do not transfer** | Established, not suspected — §22.3. The model remains useful for guard and fencing semantics, which are pure functions; its *storm* results should not be cited as statements about PostgreSQL. The live harness is now the instrument for those |
| **`lease.duration` is `PROVISIONAL` and Safety-class** | Unchanged by this phase. A commitment's lease is only as good as the number, and the number is not yet calibrated. Phase 15 launch gate |
| **The advisory/fail-closed split in `reserveRobot`** | Deliberate and time-boxed to Phase 15; two callers of one function get different failure semantics until then |
| **Model-check suite runtime** | 154 s, up from ~50 s. A closed search costs more than a truncated one; the alternative is a cheaper claim that is not true |

---

## 25. Carried-forward items

| # | Item | Owner | Status after this pass |
|---|---|---|---|
| 1 | Apply Phases 1–3 to a production-shaped PostgreSQL dump | Verifier / SRE | **DISCHARGED** for a real PostgreSQL 18.3 instance. Not discharged against a production-shaped *dump* with production data volumes |
| 2 | Discharge blocking decision B9 by execution | Eng / SRE | **DISCHARGED** — all six questions, §13.3 |
| 3 | Run `formal/commitment.tla` under TLC | Verifier | **PARTIALLY DISCHARGED** — complete and clean at capacity 1 (full configuration) and capacity 2 (reduced). Capacity 3 open |
| 4 | Wire the volatile-subset re-check to the real predicate set | Phase 6 | Open — later phase |
| 5 | Wire the outbox row into the `sideEffects` seam | Phase 4 | Open — later phase (the seam is now *required*, so it cannot be forgotten) |
| 6 | Replace the static `ShardLeadership` row with real election | Phase 13 | Open — later phase. G1's code is unchanged, as the plan required |
| 7 | Consume `AgentFenceAudit` in the Invariant Checker | Phase 12 | Open — later phase |
| 8 | Flip `reserveRobot`'s default to advisory and delete the throw | Phase 15 | Open — conditioned by the plan |
| 9 | **NEW** — `lifecycleModel.js` carries D2's defect | Phase 15 | Open |
| 10 | **NEW** — confirm interactive-transaction semantics on the pooled production endpoint | SRE | Open |
| 11 | **NEW** — complete TLC at capacity 3, and at capacity 2 with the checked-in configuration | Verifier / CI | Open |
| 12 | Resolve the V9 combined-conservatism finding; the §1.8/§22.5 kill-switch discrepancy; the calibration owner and fleet-year budgets (B8); the 15 unset `required` register values | Safety / Ops / Tech lead | Open — inherited, none is Phase 3's |

---

## 26. Explicitly out-of-scope items

REST changes · Socket.IO changes · background workers · the outbox · offer semantics ·
agent-side deduplication · timers · the reconciler · lease renewal · settlement ·
cancellation · reassignment · preemption · scheduling · routing optimisation · allocation
heuristics · the full Leg state machine (Phase 5) · the `DecisionRecord` writer (Phase 11).

**None was implemented, and none was modified.** The whole-repository diff is five files.

---

## 27. Environment limitations

| Limitation | What it means for the claims above |
|---|---|
| The database was a disposable local PostgreSQL 18.3, not the shared Neon instance | Deliberate: `DATABASE_URL` names shared production infrastructure and was not touched. Every PostgreSQL claim is a claim about 18.3 on this machine |
| No production-shaped data volume | The planner evidence used 16 000 synthetic rows. A production distribution could plan differently, though a unique-index point lookup is not a plan that changes with scale |
| TLC could not complete capacity 3, or capacity 2 with the checked-in configuration | Reported as not completed. **Not** reported as passing |
| Rollback was not executed | Migrations are forward-only and carry no `down`; there is nothing to execute |
| Redis was never contacted | Correct and intended — I16. `REDIS_URL` was set in the environment throughout and no cache module entered the commit path's module graph |

---

## 28. Final status

Every Phase 3 requirement is implemented and evidenced by execution. The correctness core's
safety properties — capacity never exceeded, fencing per commitment id, the two scopes kept
orthogonal, guards that abort exactly their own condition, a database that refuses what a
defective code path would allow, idempotency under concurrent retry, leases from the store's
clock, and no cache dependency anywhere on the durable path — were all exercised against a
real PostgreSQL instance and held.

Two defects were found by that execution and fixed; three overstated claims were withdrawn.
What remains is one formal-verification configuration that needs more compute than a
workstation, and one confirmation that belongs to the production endpoint rather than to
this phase.

**PHASE 3 CLOSED WITH DOCUMENTED ENVIRONMENTAL LIMITATION**

The limitations, stated once more without softening: TLC has not completed at capacity 3 or
at capacity 2 with the checked-in configuration; and no migration has been applied to the
production database or to a production-shaped dump — only to a disposable PostgreSQL 18.3
instance carrying the real migration chain.
