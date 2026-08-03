# Phase 3 — Commitment core · Implementation Report

**Phase:** 3 of 16 · **Status:** ✅ **COMPLETE — awaiting independent verification before Phase 4**
**Date:** 2026-07-29 · **Branch:** `feature/dashboard` · **Working tree at implementation:** `4244b3d` + uncommitted Phases 1–3
**Authority:** `IMPLEMENTATION_EXECUTION_PLAN.md` §3 "PHASE 3" and §7 "Phase 3" checklist
**Specification:** `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` (FROZEN) — §2.6, §3.3, §4.1, §10, §12.2, §19.3, §19.5, §24.2, §26

> **Phase 4 has NOT been started.** There is no `Outbox` table, no `AgentDedupState`,
> no offer handler, no outbox worker, and no socket event of any kind. No routing
> optimisation, no scheduling, no allocation heuristic. `ENGINE_ENABLED` remains
> `false` in every environment; nothing in the running system calls `commit()`.

---

## 1. Executive summary

Phase 3 delivers §10 in full. After it, exclusivity is a durable, fenced,
database-enforced property rather than a Redis key with a timeout.

**8 new engine modules, 2 new tables, 1 new column, 1 partial unique index, 1 CHECK,
1 trigger, 1 static shard row, 1 TLA+ module, and 5 new test suites (200 tests).**

Four properties hold that did not before:

1. **Exclusivity survives a process pause.** §10.2's argument — that a lock with a
   timeout cannot provide mutual exclusion across a pause, because a paused holder
   cannot know it was preempted — is answered structurally: a coordinator that pauses
   mid-finalisation and resumes finds its leadership fence or its `authority_epoch`
   stale and aborts. Both cases are chaos-tested, and the abort leaves the Leg
   byte-identical to how it started.
2. **The fences are two, and the comparison is per commitment id.** §10.3.1's own
   worked example — the one where a single per-agent counter makes the fleet seize
   after the second concurrent commitment on any agent — is a test case that passes
   under the shipped comparison and a **model-check counterexample** under the
   defective one.
3. **The database refuses what a defective code path would allow.** The capacity
   backstop is a *partial unique index*, not a counting trigger, so it is immune to
   the very interleaving it exists to catch. It is exercised by writes that bypass
   every guard.
4. **The model check is a gate, and it can fail.** The protocol is checked
   exhaustively at capacity 1, 2 and 3 — 6 443, 42 123 and 135 001 states, search
   exhausted in every case, zero violations. A mutation suite then breaks one guard at
   a time and asserts the checker finds each. §10.3.1's named defect is found at
   capacity 2 and 3 and **is invisible at capacity 1**, which is precisely why §24.2
   makes the configuration part of the requirement.

`npm run verify` is green: **3 gates PASS, 47 suites, 871 tests, 0 failures.** The
legacy lane is **22 suites / 169 tests, identical to the Phase 0, 1 and 2 baselines** —
no legacy test was modified, skipped, or re-baselined.

**One inherited risk is not discharged** (§20): no migration in this programme has been
applied to a live PostgreSQL instance. Phase 3 makes that gap materially more
consequential than Phases 1 and 2 did, because Phase 3's DDL is the first that
contains a partial index, a trigger function, and a seeded row rather than only
`CREATE TABLE`. This is stated plainly in §18 and §20 rather than mitigated by
assertion.

---

## 2. Objective achieved

The plan's stated purpose:

> Deliver §10 in full — the correctness core's centre. After this phase, exclusivity is
> a durable, fenced, database-enforced property.

> **Scope.** Two fencing scopes, commit transaction with guards G1–G6, SERIALIZABLE
> isolation, schema backstops, lease grant, idempotency namespaces, clock discipline,
> advisory-only cache lock.

Every item in that scope landed. The one item conditioned on a later event — removing
`reserveRobot`'s fail-closed *throw* — is deliberately not done, because the plan
conditions it on the durable path being live and it is not (§10.3 below).

---

## 3. Files created

### 3.1 The commitment core — `src/engine/commitment/**` (1 515 lines)

| File | Lines | Purpose | Tier |
|---|---|---|---|
| `model.js` | 183 | §2.6's Commitment shape; `refuseSoftPersistence` (I18's application-side half); `isActive` as `releasedAt IS NULL` — the same predicate the index is built on; deterministic lowest-free-slot allocation | **0** |
| `fencing.js` | 299 | §10.3.1: the two scopes, the **normative** command-class → fence-scope table, fence allocation, `fence_floor`, and the two rejection predicates — stated once here because Phase 4 mirrors them on the agent side | **0** |
| `guards.js` | 346 | G1–G6 as six independent pure predicates, one abort reason each; `evaluateGuards` runs all six without short-circuiting | **0** |
| `clock.js` | 189 | §10.6: the store's clock as the sole authority, the monotonic source, the skew budget, leadership self-removal | **0** |
| `idempotency.js` | 186 | §10.5: the deterministic `commitment_id`, and two provably disjoint command namespaces | **0** |
| `leases.js` | 110 | §12.2: the lease granted at commit from the store's clock; the commitment-scoped-evidence rule renewal will need | **0** |
| `commit.js` | 392 | §10.3.2 steps 1–7 as one transaction | **0** |

### 3.2 Shard leadership — `src/engine/shard/` (208 lines)

| File | Lines | Purpose |
|---|---|---|
| `leadership.js` | 208 | The plan's cycle-C1 resolution: a single static shard row with a manually-advanced fence, read in-transaction by G1. Phase 13 replaces its *management*; **G1's code does not change** |

### 3.3 Migration and formal model

| File | Lines | Purpose |
|---|---|---|
| `prisma/migrations/20260729120000_commitment_core/migration.sql` | 185 | `ShardLeadership`, `AgentFenceAudit`, `Commitment.capacitySlot`, the partial unique index, the slot CHECK, the slot-bound trigger, the static shard row |
| `formal/commitment.tla` | 408 | The §24.2 formal model, with its three capacity configurations |

### 3.4 Tests — `tests/engine/**` (2 489 lines, 200 tests)

| File | Tests | Covers |
|---|---|---|
| `commitmentFencing.test.js` | 72 | The command table in both directions; the per-commitment comparison including §10.3.1's worked example; `fence_floor`; idempotency and namespace disjointness; clock discipline; the lease; the §2.6 model; parameter-register integration |
| `commitmentGuards.test.js` | 31 | Each guard aborting **on its own violation and only its own**; the two counterfactuals (a per-commitment G3, an unqualified G5) asserted rather than argued |
| `commitmentTransaction.test.js` | 38 | The nominal commit; idempotency; the storm at capacity 1 and 2; the two chaos scenarios; the schema backstops driven **without** the commit path; both seams; every failure path |
| `commitmentSchema.test.js` | 36 | Additivity; migration ⟷ `schema.prisma` against Prisma's own SQL; the backstop DDL as written; `ShardLeadership` and `AgentFenceAudit` |
| `commitmentModelCheck.test.js` | 23 | The §24.2 gate at capacity 1, 2, 3; exhaustiveness; the mutation suite |
| `helpers/commitmentStore.js` | — | A store model with blocking row locks, atomic overlays, and the two backstops evaluated at apply time |
| `helpers/commitmentModel.js` | — | The exhaustive explicit-state checker, whose transitions call the **shipped** modules |

---

## 4. Files modified

| File | Change | Why |
|---|---|---|
| `prisma/schema.prisma` | +106 lines, **zero removed** | `ShardLeadership`, `AgentFenceAudit`, `Commitment.capacitySlot` |
| `src/db/prisma.js` | +103 lines, **zero removed** | Blocking decision B9: neither SERIALIZABLE nor `FOR UPDATE` is reachable through the ergonomic Prisma path. Adds `runSerializable`, `selectForUpdate`, and serialisation-failure classification |
| `src/cache/kv.js` | +78 / −14 (14 = comment reflow + the signature line) | §10.4's demotion, as an **opt-in**: `reserveRobot(key, value, ttl, { advisory: true })` gets §10.4 semantics; a caller passing nothing gets byte-identical behaviour to before |
| `src/services/task.service.js` | +21, **comment only** (verified: zero non-comment lines added or removed) | The plan lists it because its *role* changes — it is no longer the only writer — not its behaviour. The comment records why the fail-closed lock stays until Phase 15 |
| `tests/engine/phase0Scaffold.test.js` | Ownership assertion widened to Phase 3; two presence tests added | The assertion narrows rather than disappears: a module under `feasibility/`, `dispatch/`, or `supervision/` still fails it |
| `tests/engine/domainSchema.test.js` | Drift-check generalised | See §4.1 |

### 4.1 One Phase 2 test needed a general fix, not a re-baseline

Phase 2's drift-check compares its historical migration against `prisma migrate diff
--from-empty`, which generates the schema **as it stands now**. Phase 3's additive
`Commitment.capacitySlot` therefore appears in the generated `CREATE TABLE` and
correctly does not appear in Phase 2's migration file.

Left alone, that test would fail on *every* future additive column — a test that
re-baselines itself out of existence rather than one that detects drift. It now
subtracts exactly the columns that migrations dated **after** it add, read from those
migration files rather than hard-coded, and compares the remainder verbatim. A test
asserts the subtraction is non-empty, so it cannot silently become a no-op. Drift in
anything Phase 2's migration *does* declare still fails.

---

## 5. Transaction design

**One transaction is introduced.** `commit()` — a single serialised transaction per
(Leg, Agent) pairing, executing §10.3.2's seven steps in order.

| Step | §10.3.2 | Implementation |
|---|---|---|
| 1 | Read the agent row `FOR UPDATE`; read the Leg row `FOR UPDATE` | `lockRows` — **agent first, then Leg, always**. A fixed global lock order removes deadlock by construction rather than relying on the database to detect it; agent first because the agent is the resource whose exclusivity is the invariant |
| 2 | Verify G1–G6; every guard aborts | `guards.evaluateGuards`, which evaluates all six and returns every failure |
| 3 | Re-verify the volatile subset of feasibility | The `volatileRecheck` seam, a **required** dependency (§5.2) |
| 4 | Allocate `fence = fence_counter + 1`; update the counter; insert the Commitment; update Leg state and version. **`authority_epoch` is not touched** | `applyCommit` — plus the I6 high-water write |
| 5 | Insert the outbox row **in the same transaction** | The `sideEffects` seam (§5.2). Phase 4 |
| 6 | Insert the decision-record reference | `Commitment.decisionRef`, carried in the same insert |
| 7 | Commit | Returning from the transaction callback |

**Isolation.** The plan permits `SERIALIZABLE` **or** `REPEATABLE READ` + `FOR UPDATE`
on both rows. The implementation does **both**: `runSerializable` requests
`isolationLevel: "Serializable"` and step 1 takes explicit `FOR UPDATE` locks, which is
what §10.3.2 step 1 asks for in its own words ("an explicit row lock, not an optimistic
read"). This is not belt-and-braces for its own sake: it means the guarantee survives a
future change to the connection's default isolation.

**Failure.** Any guard failure, any lost volatile predicate, and any thrown side effect
abort the whole transaction. Nothing partial is representable, and this is asserted:
after a failing `sideEffects` callback the commitment count, the fence counter, the Leg
state, the Leg version, and the fence-audit table are all exactly as they were.

**No internal retry.** A serialisation failure returns `SERIALIZATION_FAILURE` and
writes nothing. A retry loop would need a bound; a bound is a behavioural constant that
would have to be registered, owned, and calibrated (§22.1); and §10.3.2 already says
what happens to a failed commit — it "returns the pairing to the next round with the
cause recorded", which is the round loop's decision (Phase 10), not this module's.

### 5.1 Leadership fence advance

A second, unrelated transaction: `leadership.advanceFence()` — one short write to
`ShardLeadership`. It is a control-plane operation, deliberately not part of commit, and
it touches **no** `Agent` row (§19.5: "Advancing the shard leadership fence does not
advance any agent's `authority_epoch`").

### 5.2 The two seams, and why they are seams rather than stubs

Steps 3 and 5 belong to phases that have not landed. Both are **injected dependencies**,
not optional hooks with permissive defaults:

- **`volatileRecheck`** — Phase 6 supplies the enumerated volatile subset (F7, F8, F10,
  F13, F14, F16, F17, F18, F20, F34, F35). Its **absence is refused**: `commit()` throws
  a configuration error rather than proceeding. A re-check that silently passes when
  nobody registered it is exactly the "informal bypass under latency pressure" §7.1
  names as a predicted failure mode. Anything other than `{ ok: true }` — `null`,
  `undefined`, `{}`, `{ ok: "yes" }` — is treated as failure; all four are tested.
- **`sideEffects`** — Phase 4's outbox writer, run *inside* this transaction, which is
  §4.1 rule 5. An empty seam is admissible **here and only here**, because in Phase 3
  there is no dispatcher with a row to write.

---

## 6. Database changes

Additive only. Zero lines removed from `schema.prisma`. The only pre-existing table
altered is `Commitment`, and the added column is `NOT NULL DEFAULT 0`, so no backfill is
required — and the table is empty in any case, because nothing has written it since
Phase 2 created it.

| Object | Purpose |
|---|---|
| `ShardLeadership` (table) | `shardId` unique, `leadershipFence` BIGINT, `holder`, `leaseExpiry`, `lastAdvancedBy/At`. Guard G1's subject |
| `AgentFenceAudit` (table) | `agentId` unique, `fenceHighWater` BIGINT, `epochHighWater` BIGINT, `lastFenceSource`. Invariant I6's **persisted** high-water mark |
| `Commitment.capacitySlot` (column) | INTEGER NOT NULL DEFAULT 0 — the slot an active commitment occupies on its agent |
| `Commitment_agent_capacity_slot_active_key` | **Partial unique index** on `("agentId", "capacitySlot") WHERE "releasedAt" IS NULL` — invariant I1's backstop |
| `Commitment_capacity_slot_non_negative` | CHECK `"capacitySlot" >= 0` |
| `Commitment_capacity_slot_in_bounds` | BEFORE INSERT OR UPDATE trigger bounding the slot by `COALESCE("Agent"."capacityOverride", 1)` |
| Static `ShardLeadership` row | `shardId = 'default'`, `leadershipFence = 1`, inserted `ON CONFLICT DO NOTHING` |

`Commitment_kind_hard_only` (I18) landed with Phase 2 and is **not restated** — asserted
by a test, so a future duplicate would be caught.

### 6.1 Why the capacity backstop is an index plus a trigger, and why the column exists

§10.3.2 requires "a partial unique index (**or equivalent**) enforcing at most
`capacity[agent_class]` active commitments per agent". Three readings were available and
two were rejected:

| Candidate | Rejected because |
|---|---|
| `UNIQUE ("agentId") WHERE "releasedAt" IS NULL` | Expresses I1 only at `capacity = 1`. Phase 16e raises capacity and the plan records that Phase 16 requires **no migrations** ("schema already supports all of it"). This would need one |
| A trigger counting active commitments | Inherits the hazard it guards. Two transactions that each count zero and both insert is *exactly* the interleaving §10.2 describes and exactly what a defective code path — one that failed to take the agent row lock — produces. A count-based backstop is only as good as the locking it is meant to backstop |
| **A partial unique index on `(agentId, capacitySlot)`, plus a trigger bounding the slot** | Chosen. The index is immune to concurrency by construction and generalises to any capacity; the trigger bounds the number of slots without counting anything |

The `capacitySlot` column is what makes the chosen reading expressible. The plan's Phase 3
migration list names constraints and no column, so this is a **recorded assumption**
(§19 A1) — and it follows the precedent Phase 2 set when it added `Leg.cancelRequestedAt`
and `Commitment.releasedAt` for the same reason: "adding them now is what makes Phase 3's
stated migration possible as stated."

The trigger reads `COALESCE("Agent"."capacityOverride", 1)`: the durable per-agent record
Phase 2 established, falling back to `capacity`'s registered structural default. The
decision path still resolves capacity through the Config Service (§22.2); this is a
second, independent line of defence, which is the point.

### 6.2 Why `AgentFenceAudit` is a separate table

I6 is verified by "a windowed monotonicity audit against a **persisted high-water
mark**". A high-water mark read back off the `Agent` row cannot detect the one defect it
exists to detect — a counter that went backwards — because it *is* that counter. Two
rows that disagree are evidence; one row that agrees with itself is not. The commit
transaction writes both atomically, so a disagreement is genuine rather than a
write-ordering artefact.

---

## 7. Concurrency guarantees

| # | Guarantee | Mechanism | Evidence |
|---|---|---|---|
| 1 | Two coordinators cannot both commit the same agent | SERIALIZABLE **and** `FOR UPDATE` on agent and Leg, in a fixed global order | Storm test: 8 concurrent attempts → exactly one winner, 7 abort on G2, one fence allocated |
| 2 | A coordinator whose leadership lapsed mid-transaction cannot commit | **G1**, re-read inside the transaction | Chaos test: pause, leadership change, resume → `G1_LEADERSHIP_FENCE_ADVANCED`, nothing written. Model check: dropping G1 produces a counterexample |
| 3 | A paused worker cannot commit against a stale agent | **G3** on the agent-scope epoch | Chaos test: pause, quarantine, resume → `G3_AUTHORITY_EPOCH_CHANGED` |
| 4 | Several commits to one agent in one round do not invalidate each other | `authority_epoch` untouched by commit; G3 guards the agent scope, never a per-commitment counter | Guard test asserts the counterfactual explicitly; storm at capacity 2 → two winners, two slots, two fences, epoch unmoved |
| 5 | An agent never applies a superseded command, in either scope | Per-commitment comparison; `fence_floor` | 72 fencing tests; model check at capacity 1, 2, 3 |
| 6 | A retried commit never double-commits | `commitment_id = f(leg, agent, round)`, uniquely indexed | Retry returns `ALREADY_COMMITTED`, allocates no second fence |
| 7 | A defective code path cannot exceed capacity | Partial unique index + slot trigger, evaluated against globally committed state | Direct writes bypassing every guard are rejected; a deliberately defective slot allocator is caught and reported |
| 8 | Cache loss cannot lose, duplicate, or double-grant a commitment (I16) | The commit path takes **no** cache dependency | Asserted structurally: no module under `commitment/` imports `cache/kv` or `ioredis` |
| 9 | Safety does not depend on synchronised clocks | Deadlines from the store's clock; the two fences and G1 carry safety; clocks affect liveness only | Clock tests; `shouldStopCommitting` shown to fire *before* the lease expires, and the chaos tests show that ignoring it still ends in an abort |

---

## 8. State-transition rules

Phase 3 performs exactly one Leg transition — the one commit authorises — and it is a
conditional write on the Leg's own version (§4.1 rule 2):

```
UPDATE "Leg" SET state = <target>, version = version + 1
 WHERE id = <legId> AND version = <snapshot version>
```

Guard G4 already checked the version under the row lock; the `WHERE` clause is the
second line, and a match count other than 1 throws rather than proceeding. This is the
structural answer to the baseline's silent cancellation reversion, in which finalisation
overwrote `CANCELLED` back to `ASSIGNED` without reading the current status.

Every other state machine — the Task machine, the full Leg machine, cancellation,
reassignment, settlement — is **Phase 5** and is not implemented here. `commit()` takes
its target state as an input and validates it only against G6's declared expectation; it
does not know the §4.4 transition table, and inventing one would be Phase 5 work.

**What is validated at every commit:**

- the expected Leg state, declared by the decision, against the actual (G6);
- the Leg version, against the snapshot (G4);
- cancellation, purpose-conditioned (G5), using `domain/purpose.isCustodial()` as the
  single definition of `custodial_purposes`;
- the agent's `authority_epoch` (G3) and the shard's leadership fence (G1);
- capacity (G2), plus the volatile feasibility subset (step 3).

---

## 9. Rollback strategy

**Within a commit.** There is nothing to roll back by hand: the transaction is the unit.
A guard failure, a lost volatile predicate, or a thrown side effect discards every write.
This is asserted, not assumed — the side-effect failure test checks the commitment table,
the fence counter, the Leg state, the Leg version, and the fence-audit table individually.

**Of the migration.** Forward-only, matching this repository's convention (no prior
migration carries a `down`). The rollback path is the additive-only property: an
unapplied Phase 3 leaves a `Commitment` table that nothing writes, exactly as Phase 2 left
it. The one statement with any persistence beyond DDL — the static `ShardLeadership` row
— is `ON CONFLICT DO NOTHING`, so re-applying cannot reset a fence that has since
advanced.

**Of the phase.** No runtime behaviour changed. `ENGINE_ENABLED` is false, no route, no
socket event, and no worker was added, and the only live-path file touched is `kv.js`,
whose default behaviour is unchanged. Reverting Phase 3 removes capability; it restores
nothing, because nothing was taken away.

---

## 10. API, Redis, and Socket.IO changes

### 10.1 REST API

**None.** The plan specifies "None", and none was made. No route file was touched.

### 10.2 Redis

The plan's row: *"`robotReserve:{agentId}` **retained but advisory** (§10.4) — loss
degrades throughput only; the fail-closed throw is removed *after* the durable guard set
is proven, not before."*

**No key was added, removed, or renamed.** The change is to `reserveRobot`'s contract:

```js
kv.reserveRobot(key, value, ttl)                      // legacy — unchanged, fail-closed
kv.reserveRobot(key, value, ttl, { advisory: true })  // §10.4 — grants on cache loss
```

### 10.3 Why the fail-closed throw is still there

The plan conditions its removal twice, and the condition is not met:

> remove the fail-closed *throw* only after the durable path is **live** — see Risk
> Demote `kv.reserveRobot` to advisory (§10.4) — **only after** the durable path passes
> its gate

`ENGINE_ENABLED` is false and `task.service.js` is still the only writer of assignments.
For that caller this lock remains the *sole* exclusivity mechanism. Removing the throw
today would delete the only protection the live path has, months before the Phase 15
cutover replaces it — trading a real, present safety property for a cosmetic match to a
checklist line the plan itself qualifies. The default flips at Phase 15, when the legacy
path is removed from the build rather than merely bypassed.

The demotion that Phase 3 *can* make is made, and it is the substantive one: **the commit
path takes no cache dependency at all**, asserted structurally rather than by review.

### 10.4 Socket.IO

**None.** The plan specifies "None (dispatch is Phase 4)". `src/sockets/` is byte-for-byte
unchanged.

### 10.5 Background workers

**None.** The plan specifies "None".

---

## 11. Compatibility guarantees

| Surface | Guarantee | Evidence |
|---|---|---|
| **Data** | No legacy row read or written differently. The one added column is `NOT NULL DEFAULT 0` on a table that has never held a row | §6, `commitmentSchema.test.js` |
| **Schema** | Zero lines removed from `schema.prisma`; no `DROP`, `RENAME`, or `ALTER COLUMN` anywhere in the migration | `git diff | grep -c '^-[^-]'` = 0; four dedicated tests |
| **API** | No route, response shape, or status code changed | §10.1 |
| **Redis** | No key added, read, written, or retired; the legacy call signature and behaviour are unchanged | §10.2 |
| **Socket.IO** | No event added, changed, or removed | §10.4 |
| **Legacy tests** | 22 suites / 169 tests, identical to the Phase 0, 1 and 2 baselines; not one file touched | `git diff --stat -- tests/unit tests/integration` is empty |
| **Legacy behaviour** | `task.service.js` changed by comment only — verified by filtering the diff to non-comment lines, which is empty | §4 |
| **Determinism** | The commitment id derives from three facts with no clock and no randomness; slot allocation is order-independent; no module in `commitment/` reads a wall clock outside `clock.readStoreTime`, which reads the *store's* | `commitmentFencing.test.js`; `gate:tenets` PASS |
| **Parameter register** | No behavioural constant introduced. All five Phase 3 parameters were already registered by Phase 1 and resolve through the real Config Service | `gate:params` PASS (31 modules / 148 parameters); 8 register-integration tests |

---

## 12. Tests added

**200 new tests across 5 suites.** Every plan-named requirement and where it is met:

| Plan requirement | Where | Result |
|---|---|---|
| **Model checking at capacity 1, 2 and 3** under worker pause, leader change, partition, duplicate delivery, reordering | `commitmentModelCheck.test.js` | Exhaustive, 0 violations at all three |
| **≤ capacity HARD commitments** under all interleavings | Model check property `S1`; storm test | Held |
| **Commanding/reassigning/settling one commitment leaves another commandable (I19)** | Model check property `S3` + the `crossCommitmentInvalidation` counter; capacity-2 storm | Held |
| **No commit under a superseded leadership fence, including a transaction spanning the change (G1)** | Model check counter; chaos test | Held |
| **Each guard G1–G6 aborts on its own violation and only its own** | `commitmentGuards.test.js` — every case asserts the failing id **and** that the other five passed | 31 tests |
| **Concurrent commit storm against one agent yields exactly one winner** | `commitmentTransaction.test.js` | 8 attempts → 1 winner, 7 × G2, 1 fence |
| **Chaos: worker paused mid-finalisation beyond lease duration, resumed → abort** | `commitmentTransaction.test.js`, two variants (G1 and G3) | Abort, nothing written |
| **Schema constraints reject violations independently of application logic** | `commitmentTransaction.test.js` — writes that bypass every guard | Index, trigger, and CHECK each rejected |

### 12.1 Two things the tests do that a weaker suite would not

**The mutation suite.** A model check that has never rejected anything is evidence about
nothing. Five mutations are injected and four are caught by the model check:

| Mutation | Caught | Property |
|---|---|---|
| Drop G1 | ✅ | `commitUnderSupersededLeadership` |
| Drop G2 | ✅ | `overCapacity` |
| Drop G3 | ✅ | `commitAfterAuthorityChange` |
| Drop G4 | ✅ | `commitOnStaleLegVersion` |
| Drop G6 | ❌ — and the test says so | Every transition that moves a Leg's state also moves its version, which is §4.1 rule 2 holding, so G4 subsumes G6 *in this model*. G6's independence is established in the unit suite instead, and the model-check file asserts both facts rather than leaving the gap silent |
| Per-agent fence maximum (§10.3.1's named defect) | ✅ at capacity 2 and 3, ❌ at capacity 1 | Exactly §24.2's stated reason for requiring capacity ≥ 2 |

**The counterfactuals are asserted, not argued.** Where the specification explains why a
design is wrong, the test executes the wrong design and shows it failing:

- a G3 written against `fence_counter` rejects the second commit of the same round;
- an unqualified cancellation guard refuses exactly the `RECOVERY` and `TRANSFER` Legs
  that cancellation itself mandates;
- a per-agent fence maximum rejects a command for C1 that the per-commitment rule accepts.

---

## 13. Checklist completion — `IMPLEMENTATION_EXECUTION_PLAN.md` §7, Phase 3

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | `commitment/fencing.js` — `authority_epoch` and per-commitment `fence` from `fence_counter` | ✅ | `fencing.js`; `allocateFence` strictly advances, refuses a negative counter |
| 2 | The normative command-class → fence-scope table (§10.3.1) | ✅ | All 18 commands, checked against the spec's table **in both directions**; an unknown command throws rather than being treated as unfenced |
| 3 | `fence_floor` semantics — agent-scope command invalidates all commitment authorities | ✅ | `applyAgentCommand` discards the per-commitment table; test drives three commitments fenced by one `STAND_DOWN_ALL` |
| 4 | `commit.js` at SERIALIZABLE (or RR + `FOR UPDATE` on agent **and** Leg) | ✅ | **Both**: `runSerializable` + `selectForUpdate` on each, agent first |
| 5 | Guard **G1** — leadership fence re-read inside the transaction | ✅ | `g1LeadershipFence`; `readLeadership` uses `FOR SHARE` inside the tx |
| 6 | Guard **G2** — active HARD count < `capacity[agent_class]` | ✅ | `g2Capacity`; refuses a non-positive-integer capacity rather than defaulting |
| 7 | Guard **G3** — `authority_epoch` equals snapshot (agent scope, not per-commitment) | ✅ | `g3AuthorityEpoch`; the per-commitment counterfactual asserted |
| 8 | Guard **G4** — Leg `version` equals snapshot | ✅ | `g4LegVersion` |
| 9 | Guard **G5** — `cancel_requested_at IS NULL OR purpose ∈ custodial_purposes` | ✅ | `g5Cancellation`, reading `domain/purpose.isCustodial()` |
| 10 | Guard **G6** — Leg state is the expected one | ✅ | `g6LegState`; an undeclared expectation is itself a failure |
| 11 | Volatile-subset re-check hook (populated in Phase 6) | ✅ | A **required** dependency; absence throws |
| 12 | Migration: partial unique index enforcing ≤ capacity (I1) | ✅ | `Commitment_agent_capacity_slot_active_key`, plus the slot-bound trigger |
| 13 | Migration: CHECK admitting HARD only (I18) | ✅ | Present since Phase 2; asserted, not restated |
| 14 | Migration: `ShardLeadership` static row + fence; `AgentFenceAudit` | ✅ | Both tables; row seeded `ON CONFLICT DO NOTHING` at fence 1 |
| 15 | `leases.js` (grant at commit), `idempotency.js` (two disjoint namespaces), `clock.js` | ✅ | Disjointness proven by construction and by test |
| 16 | Demote `kv.reserveRobot` to advisory — **only after** the durable path passes its gate | ⚠️ **Conditioned, per the plan's own wording** | Advisory mode implemented and tested; the fail-closed throw retained for legacy callers because the durable path is not live. §10.3 |
| 17 | `formal/commitment.tla` — check at capacity 1, 2 and 3 | ⚠️ **Written; TLC not executed** | 408-line module with all three configurations. The equivalent checker §24.2 permits **was** executed at all three. §20 |
| 18 | Tests: each guard aborts on its own violation only; storm yields exactly one winner | ✅ | 31 + 38 tests |
| 19 | Chaos: worker paused beyond lease duration, resumed → abort | ✅ | Two variants |
| 20 | **Gate:** model check clean at capacity ≥ 2; I1, I5, I6, I18, I19 verifiable; schema constraints reject violations independently of application code | ✅ | §14 |

**18 of 20 fully complete. Two are qualified, both deliberately and both disclosed:**
item 16 is conditioned by the plan itself and the condition is unmet; item 17's artefact
exists and its property set is checked by the executable equivalent §24.2 permits, but
TLC did not run here.

---

## 14. Completion criteria — §3 "PHASE 3"

| Criterion | Result |
|---|---|
| Commit runs at SERIALIZABLE (or REPEATABLE READ + `FOR UPDATE` on both agent and Leg) | ✅ **Both**, not either |
| All six guards implemented and individually tested | ✅ 31 tests; each case asserts the failing guard **and** the five that passed |
| Schema constraints reject violations independently of application logic | ✅ Direct writes bypassing every guard are rejected by the index, the trigger, and the CHECK; a deliberately defective slot allocator is caught by the database and reported as `CAPACITY_CONSTRAINT_VIOLATED` |
| Two-scope fence allocation correct and monotonic | ✅ `allocateFence` strictly advances; `DistinctFences` holds in every reachable state at all three capacities; `AgentFenceAudit` persists the high-water mark |
| TLA+ (or equivalent) model checked clean at `capacity ≥ 2` | ✅ **Equivalent executed** — exhaustive and clean at 1, 2 and 3, with a mutation suite proving it can fail. TLA+ module written but not TLC-executed (§20) |
| I1, I5, I6, I18, I19 verifiable | ✅ §14.1 |

### 14.1 Invariants, and how each is verified

| Invariant | Enforced by | Verified here by |
|---|---|---|
| **I1** ≤ `capacity[class]` active HARD commitments | G2 + partial unique index + slot trigger | Model check `S1` and `DistinctSlots` at capacity 1/2/3; storm test; direct-write rejection |
| **I5** no superseded fence applied, either scope | Per-commitment comparison; `fence_floor` | 72 fencing tests; model-check counters `standDownNotHonoured`, `doubleApplication` |
| **I6** both counters strictly monotone | Transactional increment under the agent row lock; `AgentFenceAudit` | `isStrictAdvance`; `DistinctFences` in every reachable state; the audit row written in the commit transaction |
| **I18** no SOFT reservation persisted | Phase 2's CHECK + `model.refuseSoftPersistence` | Direct write of `kind = 'SOFT'` rejected; the refusal names the rule |
| **I19** no cross-commitment invalidation | `authority_epoch` untouched; per-commitment fences | Model check at capacity 2 and 3, where the defective comparison **is** detected and at capacity 1 is not; capacity-2 storm |
| **I16** cache loss harmless | The commit path has no cache dependency | Structural assertion over every module in `commitment/` |
| **I2** every commitment has a valid lease | Lease granted at commit from the store's clock | A zero or absent duration is refused; expiry is `store_now + lease.duration` |

---

## 15. Verification evidence

### 15.1 `npm run verify`

```
> gate:tiers
gate: tier-dependencies (§1.8 rule 2)
  PASS — 97 module(s), 44 governed import edge(s), no Tier 0/1 → Tier 2 dependency.

> gate:params
gate: parameter-register (§22, Appendix A)
  PASS — 31 engine module(s) checked against 148 registered parameter(s); no bare behavioural constants.

> gate:tenets
gate: tenets (T1 type separation, T6 decision-path determinism)
  PASS — 94 module(s) checked, no violations.

> test
Test Suites: 47 passed, 47 total
Tests:       871 passed, 871 total
```

| Lane | Suites | Tests | Δ vs Phase 2 |
|---|---|---|---|
| `legacy` | 22 | 169 | **unchanged** |
| `gates` | 3 | 49 | unchanged |
| `engine` | 22 | 653 | +5 suites, +203 tests |
| **Total** | **47** | **871** | +5 / +203 |

### 15.2 The model check, run

| Capacity | States | Transitions | Exhaustive | Violations |
|---|---|---|---|---|
| 1 | 6 443 | 17 604 | ✅ | 0 |
| 2 | 42 123 | 102 704 | ✅ | 0 |
| 3 | 135 001 | 313 799 | ✅ | 0 |

The gate is **"exhaustive and clean"**, never "clean": a bounded search that hit its
bound is not a proof, and the test asserts `exhaustive === true` separately from
asserting zero violations.

### 15.3 The gates caught real violations during implementation

Two, recorded because a gate that has never fired during a phase is a gate nobody has
evidence about:

1. `gate:params` fired on bare numerics in `clock.js` and `idempotency.js` — the
   nanoseconds-per-millisecond and milliseconds-per-second conversions, and the digest
   length. Each was annotated `@structural` with its reason (a unit conversion is not a
   threshold) and the gate passed.
2. A **NUL byte** silently replaced the space in `idempotency.js`'s
   `FIELD_SEPARATOR = " "` during file creation, which made the ambiguity check inert:
   `"leg 1"` passed a check that exists to reject it. It was caught by the test that
   asserts the check rejects a component containing the separator, not by inspection.
   Recorded because it is the exact class of defect that "the test looks obviously
   right" reasoning misses.

### 15.4 Architectural compliance, item by item

| Requirement | Evidence |
|---|---|
| §10.3.1 — two scopes, compared differently | The command table asserted in both directions; mission rejection at `≤`, agent rejection at `<`, matching the spec's own asymmetry |
| §10.3.1 — fences compared **per commitment id** | §10.3.1's worked example (C1 at 5, C2 at 6) is a passing test; the per-agent-maximum comparison is a model-check counterexample |
| §10.3.1 — one `STAND_DOWN_ALL` fences everything without enumerating | `applyAgentCommand` returns an empty authority table; three commitments fenced by one command |
| §10.3.2 step 1 — explicit row locks, not optimistic reads | `selectForUpdate` on both, agent first; lock order asserted |
| §10.3.2 step 4 — `authority_epoch` **not** touched | Asserted after every nominal commit and in the capacity-2 storm |
| §10.3.2 — schema constraints as an independent line of defence | Backstops driven by writes that bypass the entire commit path |
| §10.4 — cache unavailability MUST NOT halt commitment | Advisory mode grants on cache loss; the commit path imports no cache module |
| §10.5 — commit idempotent on a derived `commitment_id` | Retry returns `ALREADY_COMMITTED`, allocates no second fence |
| §10.5 — the two namespaces are disjoint | Proven by construction (namespace prefix + a separator no component may contain) and by test |
| §10.6 — the store's clock is the sole authority | `readStoreTime` refuses a non-transaction client; `deadlineFrom` refuses a raw epoch number |
| §10.6 — a skewed node removes itself from leadership eligibility | `assessLeadershipEligibility` |
| §12.2 — leases are per commitment, renewed on commitment-scoped evidence | Evidence naming another commitment, or carrying a different fence, is insufficient |
| §19.5 — leadership fence advance touches no `Agent` row | `advanceFence` writes only `ShardLeadership` |
| §19.5 — stop committing *before* the lease expires; G1 closes the window | `shouldStopCommitting` fires while the lease is still valid; the chaos tests show G1 catching a coordinator that ignored it |
| §2.6 — only HARD commitments are durable | CHECK + `refuseSoftPersistence` |
| §4.1 rule 2 — every transition is a conditional write on the version | The `updateMany` `WHERE version = …`, with a match count other than 1 throwing |
| §4.1 rule 5 — no side effect precedes its authorising write | The `sideEffects` seam runs inside the transaction; a failing side effect rolls the commit back |
| §1.8 rule 2 — no Tier 0/1 → Tier 2 dependency | `gate:tiers` PASS over 44 governed edges |

---

## 16. Redis changes

Covered in §10.2. Summarised: **no key added, removed, or renamed**; `robotReserve:*`
retained; its contract gains an opt-in advisory mode; the commit path depends on neither.

---

## 17. Socket.IO changes

**None.** Covered in §10.4.

---

## 18. Known assumptions

Each is an implementation choice not dictated by the plan, stated so it can be overruled.

1. **`Commitment.capacitySlot` is added, although the plan's Phase 3 migration list names
   only constraints.** It is what makes "a partial unique index enforcing ≤
   `capacity[agent_class]`" expressible for capacity > 1 without a Phase 16 migration.
   The alternatives and why they were rejected are in §6.1. **This is the most
   consequential reading in the phase.**
2. **The fail-closed throw in `reserveRobot` is retained for legacy callers**, with
   advisory semantics offered as an opt-in. The plan conditions removal on the durable
   path being live; it is not. §10.3.
3. **The commit runs at SERIALIZABLE *and* takes `FOR UPDATE` row locks**, rather than
   choosing one leg of §10.3.2's disjunction.
4. **No internal retry on serialisation failure.** §5.
5. **`volatileRecheck` is a required dependency whose absence throws**, rather than an
   optional hook defaulting to pass. §5.2.
6. **Step 6's "decision-record reference" is the `Commitment.decisionRef` column**, not a
   `DecisionRecordA` row. That table's writer is Phase 11; fabricating a record here
   would be Phase 11 work done badly.
7. **The static shard row's fence starts at 1, not 0**, so "the fence has not moved" is
   distinguishable from "there is no leadership record".
8. **`AgentFenceAudit` is written by the commit transaction** and read by Phase 12's
   Invariant Checker. The plan assigns the table to Phase 3 and the audit to Phase 12;
   populating it is what makes the audit possible.
9. **`leases.isRenewalEvidenceSufficient` is stated in Phase 3** although renewal is
   Phase 5's, because the rule constrains the lease's shape and would otherwise be
   discovered late. No renewal path calls it yet.
10. **`task.service.js` is modified by comment only.** The plan lists it among files to
    modify, but its parenthetical — "legacy path left intact but no longer the only
    writer" — describes a change in role, not in behaviour.
11. **Phase 2's schema drift-check was generalised rather than re-baselined.** §4.1.
12. **`readLeadership` uses `FOR SHARE`, not `FOR UPDATE`.** G1 needs the fence stable
    for the transaction's remainder; `FOR UPDATE` would additionally serialise every
    commit in the shard against every other, which is a throughput cost with no
    correctness gain.
13. **The store model in the tests implements `REPEATABLE READ` + `FOR UPDATE`, not true
    `SERIALIZABLE`.** It has no predicate locking. It therefore models the weaker leg of
    §10.3.2's disjunction — which is the honest direction for a model to err in, since
    the production path requests both.

---

## 19. Remaining TODOs

### 19.1 Carried out of Phase 3

| # | Item | Owner | Due |
|---|---|---|---|
| 1 | **Apply Phases 1–3 to a production-shaped PostgreSQL dump.** Phase 3 is the first migration containing a partial index, a trigger function, and a seeded row rather than only `CREATE TABLE` | Verifier / SRE | **Before Phase 4** |
| 2 | **Discharge blocking decision B9 by execution**: confirm Prisma's `isolationLevel: "Serializable"` and `SELECT … FOR UPDATE` behave as expected on the target PostgreSQL, and that the partial unique index is chosen by the planner | Eng / SRE | Before Phase 4 |
| 3 | **Run `formal/commitment.tla` under TLC** at all three capacity configurations | Verifier | Before Phase 15's gate |
| 4 | Wire the volatile-subset re-check to the real predicate set | Phase 6 | Phase 6 |
| 5 | Wire the outbox row into the `sideEffects` seam | Phase 4 | Phase 4 |
| 6 | Replace the static `ShardLeadership` row's management with real election (**G1 unchanged**) | Phase 13 | Phase 13 |
| 7 | Consume `AgentFenceAudit` in the independent Invariant Checker | Phase 12 | Phase 12 |
| 8 | Flip `reserveRobot`'s default to advisory and delete the throw | Phase 15 | Phase 15 |

### 19.2 Carried forward, still open

| # | Item | Owner | Origin |
|---|---|---|---|
| 1 | Resolve the combined-conservatism V9 finding — the seeded register still does not publish | Safety | Phase 1 §7.1 |
| 2 | Resolve the §1.8 / §22.5 kill-switch discrepancy | Tech lead | Phase 0 §7.1 |
| 3 | Name the calibration owner; set the fleet-year energy budgets (B8) | Ops / Finance / Safety | Phase 1 |
| 4 | Supply the 15 unset `required` register values | Ops, Finance, Account management | Phase 1 |
| 5 | `fixedPoint.toMilliCU()` half-boundary rounding | Implementation | Phase 1 verification |
| 6 | `POST /api/config/publish` 500 on malformed input | Implementation | Phase 1 verification |
| 7 | Report line-count accuracy | Documentation | Phase 2 verification |

**Items 5 and 6 were deliberately not fixed**, per the instruction to carry forward only
Phase 2 follow-up work that belongs to Phase 3. Neither is called by any Phase 3 code
path. `lease.duration` is `PROVISIONAL` and is a Safety-class parameter; that is item 3's
territory and a Phase 15 launch gate, not a Phase 3 defect.

### 19.3 Explicitly out of scope for Phase 3

REST changes · Socket.IO changes · background workers · the outbox · offer semantics ·
agent-side dedup · timers · the reconciler · lease renewal · settlement · cancellation ·
reassignment · preemption · scheduling · routing optimisation · allocation heuristics —
**the plan assigns each to a later phase, and none was implemented.**

---

## 20. Risks

| Risk | Assessment |
|---|---|
| **No migration has been applied to a real database** | The largest residual risk, inherited from Phases 1 and 2 and now materially sharper. Phase 3's DDL is the first to contain a `CREATE UNIQUE INDEX … WHERE`, a `plpgsql` trigger function with an `INTO` query, and a data `INSERT`. Every one of those is statically checked against Prisma's own generated SQL where Prisma generates it, and hand-reviewed where it does not — but static checking cannot catch a plpgsql syntax error or a planner that declines the partial index. §19.1 items 1 and 2 |
| **The `capacitySlot` reading (assumption 1)** | If the intended reading was a bare `UNIQUE (agentId) WHERE releasedAt IS NULL`, the correction is a two-line migration change plus deleting the slot allocator — but it would reintroduce a Phase 16e migration the plan says does not exist. Flagged first among the assumptions for that reason |
| **TLC has not run** | The TLA+ module is checked by reading, not by execution. Mitigated more strongly than usual: the executable equivalent explores the same actions exhaustively and, unlike TLC, drives the **shipped code**. The residual risk is that both artefacts share a modelling error — which is why they are kept as two independently-written descriptions rather than one generated from the other |
| **The store model is not PostgreSQL** | Every concurrency claim from `commitmentTransaction.test.js` is a claim about a model with blocking row locks, atomic overlays, and re-checked backstops — not about PostgreSQL's MVCC. Stated at the top of the helper and here. The claims most exposed are the storm results; the claims least exposed are the guard and fencing results, which are pure functions |
| **G6 is not independently detectable in the model check** | Real, disclosed in the test file itself, and covered by the unit suite instead. It arises because the model has no transition that moves a Leg's state without moving its version — which is §4.1 rule 2 holding, not a gap in the guard |
| **`lease.duration` is `PROVISIONAL` and Safety-class** | Unchanged by this phase; §22.4's predicted failure mode, gated at Phase 15 launch. A commitment's lease is only as good as the number, and the number is not yet calibrated |
| **The advisory/fail-closed split is a temporary state with two behaviours** | Deliberate and time-boxed to Phase 15, but until then two callers of one function get different failure semantics. Mitigated by the parameter being explicit at every call site and by a test asserting both behaviours |

---

## 21. Readiness for Phase 4

| Prerequisite | State |
|---|---|
| Phase 3 complete | ✅ 18/20 checklist items complete, 2 qualified and disclosed; 6/6 completion criteria met |
| Phase 4's dependency | Phase 3 only — satisfied |
| Blocking decisions for Phase 4 | **None from Phase 3's output.** Phase 4's own surface (the agent protocol, firmware coordination) is unaffected |
| What Phase 4 gets | A committed fence per commitment, allocated in the authorising transaction; the §10.3.1 command→scope table already implemented and tested, so `offer.handler.js` and `VirtualRobot` implement one definition rather than two; `acceptsMissionCommand` / `acceptsAgentCommand` / `applyAgentCommand` as the agent-side reference; both idempotency namespaces; the `sideEffects` seam already inside the commit transaction, so §4.1 rule 5 is satisfied by construction the moment the outbox writer is attached |
| What Phase 4 must add | `Outbox` and `AgentDedupState` tables; the outbox writer bound into the seam; the drain worker; offer semantics; the escalation ladder; per-commitment sequencing; the durable dedup handshake; the VirtualRobot agent-side contract |
| Guardrails Phase 4 will meet | Tier gate (`dispatch/**` is Tier 0), parameter gate (31 modules / 148 parameters), tenet gate, and the Phase-3-ownership assertion in `phase0Scaffold.test.js`, which will fail on any `dispatch/` module until this report's successor widens it |
| **Strongly recommended first** | §19.1 items 1 and 2 — apply Phases 1–3 to a production-shaped dump and confirm the isolation and locking behaviour on the target PostgreSQL. Phase 4 writes its outbox row *inside* this transaction, so it inherits every property of it |

---

## 22. Stop

**Phase 3 is complete. Phase 4 has not been started and will not be started without
independent verification and explicit approval.**

No dispatch, no outbox, no offers, no supervision, no scheduling, no routing
optimisation, and no allocation heuristic beyond Phase 3 was implemented. `ENGINE_ENABLED`
is `false`; no running code path calls `commit()`.
