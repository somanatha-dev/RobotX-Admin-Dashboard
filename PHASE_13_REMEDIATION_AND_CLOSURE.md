# Phase 13 — Adversarial Remediation, Re-Verification & Closure

**Role:** Adversarial remediation engineer. Did not implement Phase 13 and did not write its
independent verification.
**Date:** 2026-08-19 · **Branch:** `feature/dashboard` · **Baseline commit:** `1f4bfaf`
("Phase 12 closed").
**Scope:** `IMPLEMENTATION_EXECUTION_PLAN.md` §3 "PHASE 13 — Sharding, leadership, and the
single writer" (rows 656–678) and its checklist (lines 1895–1912);
`NEXT_GENERATION_ASSIGNMENT_ENGINE.md` §3.5 and §19; cross-read against
`PHASE_13_IMPLEMENTATION_REPORT.md` and `PHASE_13_INDEPENDENT_VERIFICATION.md`.

**This document does not replace those two reports.** They are preserved unedited. Where
their conclusions are now wrong, the correction is recorded here and cross-referenced, never
written back into them.

**Two passes are recorded here.** Pass 1 (earlier on 2026-08-19) found three composition
defects, fixed them, and concluded **NOT CLOSED** because one Phase-13-owned HIGH defect —
P13-R4, the stranding rebalance — was a design decision it declined to make. Pass 2 (this
one) makes that decision, implements it, and finds **ten further defects**, nine of them on
the same production path. Pass 1's findings are retained in full: they are the evidence for
why pass 2's technique was the right one.

---

## 1. FINAL STATUS

# PHASE 13 — CLOSED

Every Phase-13-owned HIGH and CRITICAL defect found across both passes is fixed,
regression-tested, and verified against live PostgreSQL 18.3. **P13-R4 is genuinely
resolved**: §19.2's rebalance intent is now a durable row with an explicit lifecycle that
the shard supervisor executes one agent per tick and that terminates by restoring the shard
to a serving state — and the schema makes any other terminal disposition unrepresentable.

**Final figures.** 150 suites · **6,685 tests** · 0 failures · 0 skips · exit 0.
**7/7 gates**, exit 0, no threshold moved. **73/73 live-PostgreSQL checks.** Phases 0–12
byte-identical to `HEAD`.

**Two of the plan's six completion criteria are discharged only in part, and neither can be
discharged from inside Phase 13.** They are stated here rather than in a footnote:

| Plan criterion | Status | Why, and who owns the remainder |
|---|---|---|
| "both sizing bounds monitored with the binding one reported" | **Bound 2 ✓ · Bound 1 partial** | Bound 2 (serial commit) is arithmetic and now evaluates and records on every tick (live Z4). Bound 1 (round wall-clock) is a **measurement**, and its only producer would be the round loop — which is one of the four Tier-0 `LEADER_ONLY` workers **nothing starts** (P13-R6, **Phase 15**). `sizing.js` reports it unevaluated and never as satisfied, which is the correct behaviour for an unmeasured bound |
| "locality test passes" | **Criterion ships · not run** | The §24.6 criterion and its tolerance ship and are unit-tested in both directions. Running it needs a million-agent fleet, which is Phase 15's scale suite (H4) |

Both were disclosed by the original implementation report (§13.2, §13.4) and are unchanged
by this pass. Neither is a Phase 13 defect; both are blocked behind other phases' work.
**"Closed" here means Phase-13-owned work is complete and adversarially verified**, not that
every criterion whose input another phase owes has been satisfied.

**Three external HIGH findings must be routed before a multi-shard fleet is published**, and
each now has executable evidence rather than an argument:

- **P13-R6** (Phase 15) — four Tier-0 `LEADER_ONLY` workers the registry says the shard
  supervisor starts, and which nothing starts. `registry.scheduledOnLeadership()` has **zero
  callers** outside its own module and one test.
- **P13-R7** (Phase 5) — §12.4's sweep is fleet-wide, and §19.5 obliges Phase 13 to delegate
  to exactly that sweep. **Reproduced on live PostgreSQL** (W1): shard A's leader requeued
  shard C's Leg and recorded the repair as shard A's. W2 shows Phase 13's own
  `failover.legsInShard()` scopes correctly in both directions, which is what makes the
  finding external rather than a misuse.
- **P13-R18 / P13-R19** (Phase 1/22's config publish, Phase 2's commissioning) — shard
  definitions are *validated* at publish and never materialised as `Shard` rows, and
  `membership.place()` has no production caller. Until both are wired, no `Shard` row exists
  on any deployment, so the entire multi-shard surface — including the rebalance this pass
  repaired — is reachable only by an operator inserting the rows by hand.

---

## 2. BASELINE

Recorded before anything was modified, as the brief requires.

| | Value |
|---|---|
| Baseline commit | `1f4bfaf` ("Phase 12 closed") |
| Working tree at start | **not clean** — 7 modified + 2 new files, all from remediation pass 1 |
| Baseline test suites | **150 passed, 150 total** |
| Baseline tests | **6,630 passed, 6,630 total**, 0 failures, 0 skips, exit 0 |
| Baseline gates | **7/7 PASS**, exit 0 (277 modules / 390 edges; 183 modules / 242 parameters; 274 modules) |
| Migrations in chain | 25 |

**Ownership of every pre-existing modification**, determined before touching any of them:

```
 M Backend/server.js                                  pass 1 — P13-R1 (supervisor deps), P13-R3 (socket wire)
 M Backend/src/engine/config/validators.js            pass 1 — H2 (dead constants)
 M Backend/src/engine/shard/failover.js               pass 1 — P13-R2 (single-shard persist)
 M Backend/src/engine/shard/membership.js             pass 1 — H1 (write enumeration)
 M Backend/src/workers/shardSupervisor.worker.js      pass 1 — P13-R1 (boot assertion)
 M Backend/tests/engine/shardFailover.test.js         pass 1 — P13-R2 regression tests
 M Backend/tests/engine/shardSupervisorWorker.test.js pass 1 — P13-R1 regression tests
?? Backend/tools/verify/phase13LiveDatabase.js        pass 1 — 46-check live harness
?? Backend/tools/verify/phase13Profile.js             pass 1 — latency profiler
```

All nine are Phase-13-owned. **Nothing was overwritten, reset, stashed or deleted.** Pass 2
extended five of them and added to the two harnesses; pass 1's fixes and its regression
tests are all still present and still passing.

---

## 3. SCOPE AND OWNERSHIP, RECONSTRUCTED

Taken from the frozen plan and from the repository's own ownership record — the
`PHASE_13_OWNED` walk in `tests/engine/phase0Scaffold.test.js:225-232` — not from the
reports.

**Phase-13-owned engine modules:** `shard/shardModel.js`, `shard/election.js`,
`shard/failover.js`, `shard/sizing.js`, `shard/membership.js`, `shard/crossRegion.js`.

**Phase-13-owned by the plan's own rows:** `server.js` (coordinator lifecycle, leadership
acquisition, shutdown drain), `src/engine/intake/intake.js`,
`src/workers/shardSupervisor.worker.js`, `src/controllers/shards.controller.js`,
`src/routes/shards.routes.js`. `src/engine/config/validators.js` carries the phase's V4/A4
changes.

**Explicitly NOT Phase 13's, and confirmed byte-identical to `HEAD` after this pass:**
`commitment/commit.js` (the plan's row says "no change to G1"), `commitment/guards.js`,
`shard/leadership.js` (Phase 3's five G1 functions), `supervision/reconciler.js` and
`workers/reconciler.worker.js` (Phase 5's), `workers/registry.js` and `engine/cutover/**`
(Phase 15's), every one of the 25 pre-existing migrations.

**A new module was deliberately not created.** The rebalance lifecycle went into
`shard/shardModel.js`, which already owns `SHARD_STATE` and `setState`, rather than into a
new `shard/rebalance.js`. A new file would have required adding a row to Phase 0's
`PHASE_13_OWNED` list — editing a Phase 0 guard to admit this phase's own work, which is
the shape of change those guards exist to make visible. The state machine belongs beside the
state vocabulary anyway.

---

## 4. HISTORICAL FINDINGS — RE-EXECUTED, NOT READ

Every finding in both original reports **and** in remediation pass 1 was re-executed against
the current tree. Nothing was preserved on trust.

| # | Source | Finding | Current reproduction | Disposition |
|---|---|---|---|---|
| H1 | Verification F1 | `membership.js` header said "five writes"; there are nine | Fixed in pass 1; re-read and still correct | **CLOSED** |
| H2 | Verification F2 | Dead constants in `validators.js` | Fixed in pass 1; `grep` finds no re-introduction | **CLOSED** |
| H3 | Impl. §13.1 | B3 replication posture is an operator decision | `server.js:376` still reads `SHARD_CONSENSUS_REPLICATION`; live L-series confirms an `ASYNCHRONOUS_FAILOVER` store is refused at boot | **OPERATIONAL** — accurately disclosed |
| H4 | Impl. §13.2 | Locality test's million-agent measurement is Phase 15's | Criterion and tolerance present, tested both directions; no fleet exists | **EXTERNAL (Phase 15)** — see §1 |
| H5 | Impl. §13.3 | `bindingBound` may be `NEITHER_EVALUATED` for a long time | Re-derived: correct by design for an *unmeasurable* bound — but **P13-R9 found it was also happening to the measurable one**, which is a defect | **Superseded by P13-R9** |
| H6 | Impl. §13.4 | `sizingPass` measurement seam has no producer | Repository-wide grep for `roundWallClockP99Ms`: one hit, the consumer. **No producer in `src/`** | **EXTERNAL (Phase 15)** — blocked behind P13-R6 |
| H7 | Impl. §13.5 | `Shard.agentCount` denormalisation can drift | Live K1 (two concurrent handoffs) and live Y3 (a full two-agent drain): counts and rows agreed exactly, both times | **ACCEPTED DESIGN**, now with live evidence in two shapes |
| H8 | Impl. §13.6 | `crossRegion.js` saga is test-only | Re-derived: **zero importers under `src/`**, and `shardSchema.test.js` asserts it | **EXTERNAL (Phase 16f)** — dead, but not *silently*: disclosed, tested, and required to be uncalled by §1.8 rule 2 |
| H9 | Impl. §13.7 | `increment`/`decrement` counts unexercised by the model | Discharged in pass 1 (live K1); re-run this pass | **CLOSED** |
| H10 | Impl. §13.8 | Migration never applied to a live database | Full **26**-migration chain applied from empty this pass; 73 checks | **CLOSED** |
| H11 | Impl. §14.6 | Socket.IO Redis adapter now required; `server.js` still falls back | Re-read: `server.js:250-265` unchanged, still warns and falls back | **EXTERNAL (Phase 15)** — and Phase 13's own two events now go through it |
| H12 | Verification §1.3 | "G1 unchanged" | Re-verified by blob hash, twice | **CONFIRMED** |
| P13-R1 | Pass 1 | Supervisor composed with 4 of 7 deps — no leader elected anywhere | Live X2: the pre-remediation composition is refused at boot | **CLOSED** — and pass 2 found the *same shape* four more times (§5) |
| P13-R2 | Pass 1 | `failover.persist()` raised P2025 in the single-shard deployment | Live X4 | **CLOSED** |
| P13-R3 | Pass 1 | Two dashboard events with a producer and no wire | `server.js` `onTick` → `io.to("dashboard")`; asserted by the new composition test | **CLOSED** |
| P13-R4 | Pass 1 | **The rebalance strands a shard** | Reproduced, then fixed — §6 | **CLOSED** |
| P13-R5 | Pass 1 | Migration comment says "fourteen CHECKs"; there are fifteen | Live N1 re-confirms fifteen | **NOT FIXED — deliberate** (§12) |
| P13-R6 | Pass 1 | Four Tier-0 `LEADER_ONLY` workers nobody starts | Re-derived: `scheduledOnLeadership()` has **zero production callers** | **EXTERNAL (Phase 15)** |
| P13-R7 | Pass 1 | §12.4's sweep is fleet-wide | **Reproduced on live PostgreSQL** — W1/W2 | **EXTERNAL (Phase 5)** |

---

## 5. NEW ADVERSARIAL FINDINGS

The technique is the brief's own: for every mechanism, find the **production** producer of
every value it reads, and then execute that path rather than the test's. Pass 1 applied it
to the supervisor's dependency object. Pass 2 applied it to everything the supervisor's
dependencies in turn read — which is where nine of these ten were hiding.

| ID | Finding | Severity | Owner | Status |
|---|---|---|---|---|
| **P13-R8** | The §12.4 sweep is injected with `{ shardId }` alone. Three of its four inputs have no producer. §19.5's reconciliation therefore **threw on the first Leg it had to reconstruct** — the one case a failover exists for — and, separately, repaired and **escalated every waiting Task** on the first sweep of every deployment | **HIGH** | Phase 13 | **FIXED** |
| **P13-R9** | `sizingPass` is never given its `config`. Both §3.5 bounds reported unevaluated and `Shard.bindingBound` was written `NEITHER_EVALUATED` on every tick, although all four inputs to bound 2 resolve from the register | **HIGH** | Phase 13 | **FIXED** |
| **P13-R10** | The migration path has no producer for `signingKey` or `commandTtlSeconds`. The first executed move would have thrown `TypeError` from `commandSigning.requireKey` and `RangeError` from `clock.deadlineFrom`, into the tick swallow | **HIGH** | Phase 13 | **FIXED** |
| **P13-R11** | `lastMigrationAtMs` has no producer, and `start()`'s settings are frozen at boot, so §19.2's `shard.migration_min_interval` pacing was **inert** | MEDIUM | Phase 13 | **FIXED** |
| **P13-R12** | `migrationPass` performed §19.2's handoff without re-reading the leadership fence. A superseded coordinator could advance an `authority_epoch` and enqueue a `SHARD_MIGRATE` under an authority it no longer held | **HIGH** | Phase 13 | **FIXED** |
| **P13-R13** | `failover.legsInShard()` attributed Legs through the **routing** map, which excludes `DRAINING`. A draining shard's leader attributed **none** of its region's Legs to itself; and with every published shard draining the map was empty, which read as "single-shard deployment" — making **every leader reconcile the whole fleet** | **HIGH** | Phase 13 | **FIXED** |
| **P13-R14** | `failover.inventory()` counted the **fleet's** Timer and Outbox rows and presented them as the shard's inherited durable state | MEDIUM | Phase 13 | **FIXED** |
| **P13-R15** | A rebalance of a shard with no members moved it to `REBALANCING` for a plan containing nothing | MEDIUM | Phase 13 | **FIXED** |
| **P13-R16** | A request losing the partial-index race escaped as a constraint violation the controller rendered as a 500 | LOW | Phase 13 | **FIXED** |
| **P13-R17** | The store model called `checkViolation(constraint, value)` with **three** arguments in all eight Phase 13 assertions, so every modelled constraint violation named the *table* as the constraint | LOW | Phase 13 (test infrastructure) | **FIXED** |
| **P13-R18** | `membership.place()` has **no production caller** — no agent is ever placed in a shard | HIGH | **Phase 2** (commissioning) | **OPEN — external** |
| **P13-R19** | `shardModel.ensureShard()` has **no production caller** — shard definitions are validated at publish and never materialised as rows | HIGH | **Phase 1/22** (config publish) | **OPEN — external** |

### P13-R4 — the rebalance stranded a shard (HIGH, Phase 13) — **the blocker, now resolved**

`POST /api/shards/:id/rebalance` did two durable things: it computed an ordered plan, and it
moved the source shard to `DRAINING` (full drain) or `REBALANCING` (partial). It returned
the plan in the HTTP response body with `executed: false` and this note:

> "the shardSupervisor worker performs the moves at the pace `shard.migration_min_interval`
> sets. Poll GET /api/shards to watch the membership counts change."

Both halves of that sentence were false. The plan was never persisted — the response body
was its only copy. `migrationPass` read its plan from `settings.plan`, a key fixed at boot
and set by nothing, so it returned `{ skipped: "NO_PLAN" }` on every tick of every
deployment. And `shardModel.setState`'s **only caller** was this endpoint, which only ever
set `DRAINING` or `REBALANCING`. Meanwhile `intake.js:351` stops routing new Legs to a shard
that does not `admitNewWork`. One elevated-role POST therefore stopped a shard accepting
work with no API-level recovery; the remedy was database surgery.

**Which design the specification actually requires.** §19.2 is explicit that rebalancing is
"an explicit, **transactional control-plane operation** that migrates agents one at a time".
The plan splits that one sentence across two Phase 13 components: its REST row makes the
endpoint "control plane, elevated role", and its background-worker row makes
`shardSupervisor.worker.js` responsible for "membership migration one agent at a time". A
control plane and an executor that are not in one call stack — and after a restart or a
leadership handoff not even in one process — need a durable place to meet. The specification
therefore requires the **durable rebalance intent**, and the alternative (retract the
promise, add a manual un-drain route) would have delivered neither the plan's worker row nor
§19.2's sentence. §6.1 is the implementation.

### P13-R8 — §19.5's reconciliation was configured with one of its four inputs (HIGH)

Found by asking what `deps.reconcile` — pass 1's own fix — is actually called with.

`failover.run()` calls `deps.reconcile({ ...reconcileConfig, shardId })`. Nothing supplied a
`reconcileConfig`, and `server.js`'s binding passed the callback straight through. The sweep
therefore ran with `assignmentDeadlineSeconds`, `unresponsiveStrikes` and
`energyDeviationTolerance` all `undefined`, and **`undefined` is not neutral here**:

1. `assignmentDeadlineSeconds` reaches `timers.deadlineFrom(storeTime, undefined)` inside
   `scanOrphanLegs`'s requeue, which **throws** `RangeError` on a non-positive duration. So
   §19.5's reconciliation died on the first Leg it had to reconstruct — which is precisely
   the case a failover exists for. Same swallow, same follower loop, same invisible failure
   as P13-R1 and P13-R2. Reproduced as live check **Z1**.
2. The same value is `scanWaitingTasks`'s SLA, and `ageSeconds <= undefined` is **false**, so
   the guard clause never fires: every `WAITING`/`PENDING` Task with no queue entry was
   repaired and recorded with `escalated: true`. §12.4's repair rate is an **alertable SLI**,
   so that is a false alert on the first sweep of every deployment. Reproduced as **Z3** — a
   Task one second old was escalated.

All three are registered parameters that resolve from the default register:
`sla.assignment_deadline` (900 s), `health.unresponsive_strikes` (3),
`energy.deviation_tolerance` (0.15).

### P13-R9 — the phase's own sizing criterion was unmet on every deployment (HIGH)

`sizingPass` reads `settings.config`. `server.js` supplied none, so `sizing.evaluate()`
returned `bindingBound: NEITHER_EVALUATED` with `missing: [missionRatePerAgentHour,
txnPerMissionLifecycle, commitTxnServiceTimeMs, maxSerialUtilisation]` — and the supervisor
wrote that verdict to `Shard.bindingBound` on **every tick**, where `GET /api/shards`
reported it as "what the leader last recorded" beside a live arithmetic that was not
unevaluated.

The plan's completion criterion is "both sizing bounds monitored with the binding one
reported". Bound 2 is pure arithmetic over four registered parameters and the observed
membership count. Every one of them resolves. It was simply never passed. Live check **Z4**
runs the pass both ways against a 30 000-agent shard: without the config,
`NEITHER_EVALUATED`; with it, `SERIAL_COMMIT` recorded with `rebalanceIndicated: true`.

The implementation report's §13.3 recorded "`bindingBound` may be `NEITHER_EVALUATED` for a
long time" as *correct by design*. It is — for bound 1, which is a measurement. It was not
correct for bound 2, and the disclosure's generality is what let the defect sit inside it.

### P13-R10 — the migration path had no command credentials (HIGH)

Repository-wide, `signingKey` has **no production producer anywhere** — every consumer
(`dispatch/offers.js`, `lifecycle/reassignment.js`, `shard/membership.js`,
`workers/outbox.worker.js`) takes it injected, and every injection site is a test or a
verification harness. `commandTtlSeconds` likewise.

`membership.migrate()` calls `clock.deadlineFrom(storeTime, settings.commandTtlSeconds)` and
`commandSigning.sign(envelope, settings.signingKey)`; both refuse an absent value **by
throwing**. So the first move P13-R4's fix would have executed would have thrown into the
interval callback's swallow, and the intent would have sat open forever with no trace beyond
one log line.

Fixed in three places, deliberately, because a missing secret must fail where an operator
sees it:

- `server.js` reads `COMMAND_SIGNING_KEY` from the environment — the same posture
  `SHARD_CONSENSUS_REPLICATION` is read with — and **never defaults it**. A default signing
  key is a key an attacker also has, and the composition test asserts there is no `||`
  fallback.
- `migrationPass` reports `NO_COMMAND_CREDENTIALS` rather than throwing, so the failure
  reaches `GET /api/shards` and the intent stays open and cancellable.
- `POST /api/shards/:id/rebalance` **refuses to record an intent at all** when the
  deployment declares no key. Recording a plan nothing can execute is P13-R4 reached through
  a missing secret instead of a missing table.

### P13-R12 — a superseded leader could perform the handoff (HIGH)

§19.3: "exclusivity of the writer is enforced by the database rather than inferred from a
lease the writer thinks it still holds." That sentence is written about the commit
transaction, and a migration is not a commit — but it is unambiguously *a write by the
shard's single writer*, and it is the one write whose entire purpose is to change **who may
command an agent at all**.

`migrationPass` chose a move from a session, then called `membership.migrate()`, which took
the agent row `FOR UPDATE` and advanced its `authority_epoch` — with nothing between the two
that re-read the leadership fence. A coordinator superseded in that window would advance an
epoch and enqueue a signed `SHARD_MIGRATE` under an authority it no longer held.

`membership.migrate()` now accepts an optional `leadershipGuard` and, when given one,
re-reads the fence **inside the handoff transaction** through Phase 3's own
`leadership.readLeadership` — the same statement, the same `FOR SHARE` lock, that guard G1
performs. Live check **Y5** drives a genuine leadership change on a real row and confirms
the stale leader is refused with **zero side effects** — no epoch advanced, no command
enqueued, no membership row written — while its successor completes the same intent.

### P13-R13 — attribution through the routing map (HIGH)

Found by asking what `failover.legsInShard()` does once the rebalance actually works. Its
whole job is to put a shard into `DRAINING`, and `shardModel.regionShardMap()` — which
`legsInShard` used — deliberately **excludes** draining shards, because it is the map intake
routes *new* work against.

Two consequences, reproduced before the fix:

```
DRAINING shard:    { scoped: true, legIds: [], note: "…the mission regions this shard owns (none)" }
every shard DRAINING: { scoped: false, note: "no region→shard map is published, so this is the single-shard
                         deployment and every Leg belongs to this shard" }
```

The first means §19.5's reconciliation ran over an **empty set** for the shard most likely
to be holding half-written state — the one being rebalanced. The second means every shard's
leader would reconcile the **entire fleet**: a second writer (§19.3), originating inside
Phase 13 rather than in Phase 5's sweep.

`shardModel.regionOwnershipMap()` is the fix: attribution is a different question from
routing, and it includes every published shard regardless of state. It is empty only when no
shard has been published at all, which is the one condition the single-shard branch is
actually about.

### P13-R17 — the store model could misname a constraint (LOW, test infrastructure)

`tests/engine/helpers/commitmentStore.js` defines `checkViolation(constraint, value)`. All
eight Phase 13 assertions called it with **three** arguments — `checkViolation("Shard",
"Shard_state_known", row.state)` — so every modelled Phase 13 constraint violation reported
the *table* as the constraint name and the constraint name as the offending value.

No test failed, because each assertion matched on a substring that appeared either way. That
is precisely why it is recorded: a model that can misname a constraint is worth exactly as
much as the tests it exists to distrust — the same lesson pass 1 recorded about its own
harness reporting four false passes.

### P13-R18 / P13-R19 — the multi-shard surface has no production entry point (HIGH, external)

Two `grep`s, both with the same shape as P13-R1's:

- **`shardModel.ensureShard()` has no caller outside tests.** The config publish path carries
  `shards` definitions and *validates* them — `validators.js:427` calls
  `shardModel.validateDefinitions(shards)`, and V4 blocks a publish that breaks
  region → shard uniqueness — but nothing ever writes a `Shard` row.
- **`membership.place()` has no caller outside tests.** `Agent` rows *are* created in
  production (`robot.service.js`'s `ensureAgentForRobot`, Phase 2's), and none of them is
  ever placed in a shard.

Consequence: on every deployment the `Shard` table is empty, so `readRegionShardMap()`
returns `{}`, intake takes the single-shard path, `GET /api/shards` reports
`singleShardDeployment: true`, and `POST /api/shards/:id/rebalance` returns 404 for every
id. The multi-shard surface — including the rebalance lifecycle this pass repaired — is
reachable today only by an operator inserting `Shard` and `ShardMembership` rows directly,
which is exactly what the live harness does.

**Why external, and not fixed here.** The plan's Phase 13 REST row names exactly two
endpoints and neither publishes a shard. §3.5 puts shard publication with the Config Service
("the Config Service rejects a shard definition whose product … exceeds `ρ_max · 3600` at
publish time (§22.1 rule 5)"), and `config/service.js` is Phase 1/22's. Commissioning is
`robot.service.js`, Phase 2's. Materialising rows from inside Phase 13 would mean editing
one frozen phase or inventing a third endpoint the plan does not name. Both are the trespass
the brief says to stop at and document.

**Why this does not block Phase 13's closure.** No Phase 13 completion criterion names shard
publication. Phase 13 ships the operation (`ensureShard`), the validation (V4), the map, the
routing, the membership handoff and the rebalance — everything a caller needs — and all of
it works the moment a row exists, which §8's 73 live checks demonstrate end to end. What is
missing is the caller, and the caller belongs to phases that are frozen.

---

## 6. REMEDIATION

Eight production files and six test/tooling files changed. One additive migration added.

### 6.1 The durable rebalance intent — `ShardRebalance` (P13-R4)

**A new table, not a column on `Shard`.** The alternative shape would have forced either an
edit to an already-applied migration — Prisma records a checksum per migration, so editing
one causes drift on every environment that has applied it — or a weakening of
`shardSchema.test.js`'s byte-equality assertion between the Phase 13 migration's four
`CREATE TABLE` statements and `prisma migrate diff --from-empty`. A separate table costs
neither: the two relations it adds to `Shard` are **back-relations**, which Prisma resolves
without a column, so `CREATE TABLE "Shard"` is byte-identical to what shipped and the Phase
13 migration file is untouched. A test asserts exactly that.

It is also the better model. A rebalance has a lifecycle, a plan, a requester, a progress
count and a closing reason, none of which is a property of a shard.

**`prisma/migrations/20260819090000_shard_rebalance_intent/`** — one `CREATE TABLE`, two
indexes and two foreign keys taken verbatim from Prisma's own generated SQL, plus **seven
hand-written CHECK constraints and one partial unique index** Prisma cannot express:

| Constraint | What it makes unrepresentable |
|---|---|
| `ShardRebalance_state_known` | A lifecycle state with no transition rule |
| `ShardRebalance_moves_between_two_shards` | An intent that burns an `authority_epoch` per agent for a handoff that changes nothing |
| `ShardRebalance_reason_known` | `COMMISSIONING` — exempt from advancing the epoch, so an intent citing it would request moves the schema refuses one at a time, forever |
| **`ShardRebalance_restore_state_admits_work`** | **A terminal disposition that leaves the source shard unable to accept work.** This is the schema's statement of "no shard can be stranded" |
| `ShardRebalance_plan_is_not_empty` | P13-R15: a shard taken out of service for a plan with nothing in it |
| `ShardRebalance_completed_within_plan` | Progress that exceeds the plan or goes negative |
| `ShardRebalance_terminal_is_timed` | A closed intent nobody can age — the reasoning `Shard_draining_is_timed` is written from |
| `ShardRebalance_one_open_per_source` (partial unique index) | Two concurrent plans over one membership set, whose union is the bulk reassignment §19.2 forbids, reached by issuing two requests |

### 6.2 `shardModel.js` — the lifecycle

`openRebalance()` writes the intent **and** the shard state in one transaction.
`outstandingMoves()` derives what is left to do from **current membership** rather than from
a counter — which is what makes execution idempotent and crash-safe, because
`membership.migrate()` owns its own transaction and a counter advanced outside it would be
wrong exactly when it mattered. `recordRebalanceMove()`, `blockRebalanceMove()` and
`closeRebalance()` are all conditional writes on the intent still being open.

**`closeRebalance()` restores the shard *before* it closes the intent.** Both orderings are
correct when the transaction commits; they differ when the process dies between, and only
this one is safe. Closing first would leave a window with no open intent and a shard still
draining — P13-R4 recreated by a crash. This way the intent stays open, the next tick finds
nothing outstanding, and it closes again. `closeRebalance` is idempotent for that reason and
not by accident.

### 6.3 `shardSupervisor.worker.js` — `migrationPass` reads the row

`settings.plan` is **removed**, not kept as an alternative. Two paths would have meant the
second was the one nobody maintained, and the injected one was the defect: thirty-two tests
passed against a plan source that did not exist in production. The pass now reads
`ShardRebalance` scoped to its own shard as source, executes at most one move per tick, and:

| Outcome | Action | Why |
|---|---|---|
| `ok` | record the move; `PENDING` → `EXECUTING` | |
| no outstanding moves | close `COMPLETED`, restore the shard | Terminating here rather than only after a successful move is what closes the crash window |
| `AGENT_HOLDS_CUSTODY` | retire that move, record the agent and reason | §2.5 makes the transfer accountable; retrying it forever would hold a shard out of service because an agent is carrying a parcel |
| `TARGET_*` | close `CANCELLED`, restore the shard | The plan can no longer be carried out; the agents that did not move are still where they were, which is why cancelling is safe as well as terminating |
| anything else | retry next tick | Transient by construction |

Pacing is timed from the **durable** `lastMoveAt`, so it survives a restart and a leadership
change — the two moments a fleet is least able to absorb a burst of `authority_epoch`
advances, every one of which aborts a round through guard G3.

### 6.4 `shards.controller.js` — the intent, and the route back

The endpoint writes the durable intent transactionally with the state change, refuses an
empty plan, refuses a second open intent, refuses a deployment with no signing key, and
carries §2.5's custody consent onto every move.

**Cancellation shares the same route** — `POST { "cancel": true }` — rather than adding a
third endpoint. The plan's REST row names exactly two Phase 13 endpoints, and withdrawing a
rebalance is the same control-plane operation on the same resource under the same elevated
role. It restores the shard and closes the intent, and leaves already-migrated agents where
they are: each handoff was its own committed transaction with its own epoch advance, and
there is no operation that un-advances one.

`GET /api/shards` now reports the open intent beside the state it caused, so a shard reading
`DRAINING` says **why**.

### 6.5 `server.js` — the rest of the contract (P13-R8, P13-R9, P13-R10)

The `reconcile` binding now applies §12.4's three registered configuration values before
spreading the caller's `shardId` over them, so the sweep **cannot be reached unconfigured by
any caller** — a stronger arrangement than passing them through the supervisor's
`reconcileConfig` seam, which only that one caller would have used. The supervisor is given
`config` (§3.5's four bound-2 inputs plus the round budget), `commandTtlSeconds`
(`dispatch.offer_ttl`) and `signingKey` (`COMMAND_SIGNING_KEY`, never defaulted).

### 6.6 `failover.js` — attribution and scope honesty (P13-R13, P13-R14)

`legsInShard()` uses the ownership map. `inventory()` scopes its Timer counts by
`Timer.shardId` and **labels** its Outbox counts `FLEET`, because `Outbox` carries an
`agentId` and no `shardId` and an `IN` list of five thousand member agents is not a query
for the one path that runs while a shard has no leader. A number reported as the shard's
when it is the fleet's is the kind of quiet wrong answer an incident gets decided on.

### 6.7 `membership.js` — G1's discipline on §19.2's write (P13-R12)

The optional `leadershipGuard`, and `allowCustodyTransfer` carried onto each planned move.

### 6.8 Test infrastructure

`commitmentStore.js` gains the `shardRebalance` table with all seven CHECKs and the partial
unique index modelled at apply time, exactly as Phases 3, 4, 5 and 13's are — and the
`checkViolation` arity defect (P13-R17) is corrected. `shardFixture.js` gains a third timer
**in the other shard**, as the negative control for P13-R14: a fixture holding only one
shard's timers could not tell a scoped count from a fleet-wide one.

### 6.9 A defect in this pass's own work, recorded

Extracting `openRebalanceTransaction()` from `openRebalance()` to give the partial-index race
one place to be caught **dropped the `shard` binding**, so every `openRebalance` call threw
`ReferenceError`. Jest would have caught it; the live harness caught it first, on the re-run
the brief's "do not stop at the first success" rule requires. It is recorded because the
re-run is the only reason this document is not describing a fix that does not work.

---

## 7. PRODUCTION COMPOSITION — VERIFIED BY EXECUTION

Traced by running it, not by reading it. Every row below is executed by a live-database check
or by a composition assertion, both named.

| Component | Composed? | Evidence |
|---|---|---|
| `server.js` → shard supervisor | **YES** | `if (engineEnabled)`; `engineEnabled = cutoverEnabled.processEnabled()` (Phase 15's gate) |
| Consensus store construction + posture refusal | **YES** | `assertConsensusStore` at boot; live L-series |
| Leadership acquisition / renewal / release | **YES** | Live X1, X3, L1–L5 |
| §19.5 failover reconciliation | **YES** | Live X1; **Z1/Z2** (its configuration) |
| §19.5 reconciliation **scoped to the shard's own Legs** | **YES** | Live W2; unit tests for `DRAINING` and all-draining |
| §3.5 sizing — **bound 2** evaluated and recorded | **YES** *(was dead)* | Live **Z4** |
| §3.5 sizing — **bound 1** measured | **NO** | H6: no producer. Blocked behind P13-R6 (Phase 15) |
| Rebalance intent recorded | **YES** *(was dead)* | Live Y1, Y2 |
| `migrationPass` executing the intent | **YES** *(was dead)* | Live Y3, Y4, Y9 |
| Shard restored to a serving state | **YES** *(did not exist)* | Live Y3, Y8; schema CHECK |
| §19.2 pacing | **YES** *(was inert)* | Live Y10 |
| Fence re-read inside the handoff | **YES** *(did not exist)* | Live Y5 |
| Command signing on the migration path | **YES** *(had no producer)* | Live Y3 (2 signed rows) |
| Shutdown drain releasing the lease | **YES** | `server.js` shutdown → `shardSupervisor.drain` |
| `SHARD_LEADERSHIP_CHANGED` / `SHARD_MIGRATED` | **YES** | `onTick` → `io.to("dashboard").emit`; composition test |
| `GET /api/shards`, `POST /:id/rebalance` (+ cancel) | **YES** | Mounted; `authUser` + `requireElevatedRole` |
| Single-shard deployment | **YES** | Live X4 |
| Multi-shard isolation (Phase 13's own writes) | **YES** | Live Y7 |
| Region → shard map **materialised** | **NO** | **P13-R19** — validated at publish, never written |
| Agent placement into a shard | **NO** | **P13-R18** — `place()` has no caller |
| §12.4 sweep **scoped to the shard** | **NO — fleet-wide** | **P13-R7** (Phase 5). Live W1 |
| LEADER_ONLY workers (coordinator, outbox, reconciler, timer) | **NO** | **P13-R6** (Phase 15) |
| `crossRegion.js` saga | **NO — by design** | Zero importers; §1.8 rule 2 requires it. Phase 16f (H8) |

---

## 8. LIVE POSTGRESQL VERIFICATION

**Cluster:** disposable PostgreSQL **18.3** built with `initdb` from the installed binaries
into the session scratchpad, on port **55435**. Never Neon, never 5432 — both harnesses
refuse either by URL inspection before connecting.

**Migrations:** all **26** applied from an empty database in directory order with
`psql -v ON_ERROR_STOP=1`, **zero failures**. Two `NOTICE` lines, both from
`DROP CONSTRAINT IF EXISTS` in later Phase-14/15 remediation migrations — expected.

**Result: 73 / 73 checks passed.**

| Group | Checks | What they exercised |
|---|---|---|
| Fixture | F1, F2 | 4 regions, 4 leadership rows, 3 agents, 5 missions, 3 shards |
| `Shard` | S1–S7 | All four CHECKs made to fire; `DRAINING` accepted when timed; `regionId` uniqueness; the leadership FK |
| `ShardMembership` | M1–M7 | §19.2's placement exemption; all four CHECKs fired; the partial unique index refusing a second *current* membership **and allowing** one after supersession |
| `TransferPoint` | T1–T7 | All four CHECKs; `MODELLED_UNATTENDED` refused without security properties and accepted with them |
| `CrossRegionSaga` | C1–C5 | All three CHECKs; the custody FK |
| Catalogue | N1–N4 | Exactly fifteen CHECKs on the four Phase 13 tables; the partial index predicate; `ShardLeadership` still carrying exactly its nine Phase 3 columns |
| BIGINT | B1, B2 | `leadershipFence` and `authorityEpoch` round-trip `2^53+1` exactly |
| **Leadership CAS** | L1–L5 | Ten simultaneous acquirers → **one winner**; eight-way lapsed-lease storm → **one winner**; a live lease is not stealable and the refusal does not move the fence; a stale `expectedFence` refused even on an unheld shard; **25 renewals moved the fence zero times, release advanced it** |
| **Failover** | FO1, FO2 | Leader A → lapse → leader B; A's renewal refused `FENCE_SUPERSEDED`, holder remains B — **no split brain**; a superseded leader's *release* cannot take the shard from its successor |
| Known Limitation 7 | K1 | Two concurrent handoffs off one shard under SERIALIZABLE: counts and rows agreed exactly |
| Pass-1 remediation | X1–X4 | The remediated composition leads, reconciles and may run a round; the pre-remediation composition **refused at boot**; fence stable across renewals; the **single-shard deployment** completes a tick with the sweep running exactly once |
| **`ShardRebalance` schema** | **R1–R11** | All seven CHECKs made to fire, including `terminal_is_timed` in **both** directions; the source FK; the partial unique index refusing a second *open* intent **and allowing** one after the first closes; the catalogue read from `pg_constraint` and `pg_indexes` |
| **Rebalance lifecycle** | **Y1–Y10** | See below |
| **Sweep & sizing configuration** | **Z1–Z4** | The defect **reproduced** before the fix in each case |
| **P13-R7 (external)** | **W1, W2** | Cross-shard repair reproduced; Phase 13's own scoping shown correct |

### The Y group — P13-R4's actual resolution

| | |
|---|---|
| **Y1** | The intent and the shard state written in one transaction: intent `PENDING` with 2 moves, shard `DRAINING` with a `drainingSince`, `restoreState=ACTIVE` |
| **Y2** | A foreign-key failure **inside** that transaction rolls back **both**: shard still `ACTIVE`, 0 intent rows. This is the check that makes "atomic" a property rather than a claim |
| **Y3** | Two ticks moved two agents, **one each**; intent `COMPLETED`; shard restored to `ACTIVE` with `drainingSince` cleared; counts 0/2; **two signed `SHARD_MIGRATE` rows**; both `authority_epoch` 0→1 |
| **Y4** | **Process death between a committed migration and its bookkeeping**: the resumed tick migrated 0, closed the intent, restored the shard — one migration, one command, epoch advanced once |
| **Y5** | **A fenced leader cannot migrate.** Real fence advance 4→6 on a real row; the stale leader refused `LEADERSHIP_FENCE_ADVANCED_OR_HELD_BY_ANOTHER` with **zero side effects**; the successor completed the same intent |
| **Y6** | Two genuinely concurrent requests → **exactly one open intent**, one winner, one refusal naming the winner |
| **Y7** | **Multi-shard isolation.** Shard A's leader executed only its own intent; shard C's intent, its agent's epoch, its membership row and its `agentCount` all unchanged |
| **Y8** | Closing an intent whose shard an operator already restored writes **zero rows** and reports `shardRestoredTo: null` rather than success; a second close writes nothing |
| **Y9** | **Full restart**: a new `PrismaClient`, a new session and a new candidate finished the plan and restored the shard, with nothing carried across but the database |
| **Y10** | §19.2's pacing enforced from the durable `lastMoveAt`, against a settings object carrying no in-memory state |

The cluster was destroyed after verification: `pg_ctl -m fast stop`, data directory removed,
port confirmed clear. It lived entirely in the session scratchpad. The user's own cluster on
5432 and the shared Neon instance in `DATABASE_URL` were never touched.

---

## 9. FAILURE INJECTION AND CONCURRENCY

The brief's fifteen scenarios, each with where it is settled.

| # | Scenario | Result | Evidence |
|---|---|---|---|
| 1 | Process dies before plan persistence | Nothing durable happened; shard never left `ACTIVE` | Y2 |
| 2 | Process dies after plan persistence | The intent is read from the row by the next leader | Y9 |
| 3 | Process dies halfway through migration | The migration is one SERIALIZABLE transaction; it happened or it did not | Y4 |
| 4 | Leader dies during migration | Lease lapses; successor resumes the same intent | Y5, unit |
| 5 | Successor takes leadership | Fence advances; successor acquires | Y5, FO1 |
| 6 | Successor resumes safely | Same intent, no duplicate move | Y5, unit |
| 7 | Database write fails | Whole transaction rolls back; shard unchanged | Y2 |
| 8 | Database temporarily unavailable | Tick throws, is swallowed, lease lapses, standby takes over — §19.3's designed response | X2's rationale; `start()`'s `.catch` |
| 9 | Duplicate rebalance request | Pre-read refusal; index refusal on a true race; 422 either way | Y6, unit |
| 10 | Stale rebalance intent (agents already moved) | Closes on the first tick and restores the shard | unit; Y4 |
| 11 | Target shard disappears / stops admitting | Intent `CANCELLED` with the reason; shard restored | unit; `FATAL_MIGRATION_REFUSALS` |
| 12 | Membership conflict | `MEMBERSHIP_CHANGED_CONCURRENTLY`; retried next tick | K1; partial unique index |
| 13 | Stale fence | Refused inside the handoff transaction, zero side effects | **Y5** |
| 14 | Stale `expectedFence` | Refused by the CAS predicate even on an unheld shard | L4 |
| 15 | Concurrent handoff | 10-way and 8-way storms → one winner; two same-shard handoffs → counts agree | L1, L2, K1 |

**The invariant held in every case: no duplicate authority, no lost plan, no permanently
stranded shard, no cross-shard write originating in Phase 13, no stale-leader write, no
silent failure.**

---

## 10. PERFORMANCE

`tools/verify/phase13Profile.js`, 200 samples after 20 warm-up iterations, against the live
cluster on an otherwise quiet machine. **Not Jest timings** — every Phase 13 concurrency test
runs against an in-memory model whose "transaction" is a function call.

| Path | mean | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
| `readLeadership` (guard G1's read) | 0.44 ms | 0.37 | 0.71 | 0.89 | 1.27 |
| `tryAcquire` (CAS + `FOR UPDATE`) | 3.46 ms | 2.98 | 5.87 | 7.77 | 12.88 |
| `renewLease` | 2.29 ms | 2.01 | 4.49 | 6.87 | 22.15 |
| `releaseLease` + re-acquire | 4.48 ms | 4.22 | 6.57 | 7.56 | 7.59 |
| Supervisor tick (steady state) | 1.45 ms | 1.30 | 2.29 | 2.80 | 3.09 |
| `failover.run` + `persist` (§19.5) | 5.51 ms | 5.36 | 7.86 | 8.62 | 13.59 |
| **`membership.migrate`** (§19.2's handoff) | **12.65 ms** | 12.54 | 17.01 | **18.50** | 18.68 |

The table is one run. A second quiet run reproduced it within ordinary variance —
`readLeadership` p99 1.00 ms, `tryAcquire` 5.48, `renewLease` 3.46, `releaseLease` 7.43,
tick 3.99, failover 9.67, handoff **19.17** — which is stated so that a reader treats these
as measurements with spread rather than as constants.

§19.5's margin against the register defaults: lease 5 000 ms − skew 500 ms − round-trip
budget 500 ms = **latest lawful renewal at 4 000 ms**; the renewal interval is 1 500 ms, so
validator A4's inequality holds with a wide margin. Measured renewal p99 of 6.87 ms sits well
inside the 500 ms budget on this hardware.

**The one number worth an operator's attention** is the handoff's p99 of 18.50 ms. §20.1
bounds the *commit* transaction's p99 at 20 ms; a migration is not a commit, but it is nine
write statements in one SERIALIZABLE transaction against the same store, and it is
serialised behind the same single writer. At the registered
`shard.migration_min_interval` of 2 000 ms it occupies **0.9 %** of the interval it is paced
by, which is the arrangement working as designed — and it is also the reason §19.2's "one at
a time" is a mechanism rather than a decoration. Under contention (measured while the full
Jest suite ran) the same path reached a p99 of 31.83 ms and a max of 176 ms, which is what
the pacing exists to keep off the commit path.

**This is explicitly not a calibration.** The cluster is loopback PostgreSQL on one machine
with no replication and no synchronous quorum. `shard.store_round_trip_budget` is registered
SAFETY-class `PROVISIONAL` and its `awaits` field names "measured p99 round-trip to the
operated consensus store" — **this is not that store**. These numbers establish only that the
implementation adds no gross overhead of its own. **No threshold was moved.**

---

## 11. PHASE 0–12 INTEGRITY

`git diff --name-only HEAD` lists **exactly fourteen modified files**, plus three untracked
additions:

```
 M Backend/prisma/schema.prisma                        (one new model + two back-relations; 87 added, 0 removed)
 M Backend/server.js                                   (plan's Phase 13 "Files to modify" row)
 M Backend/src/controllers/shards.controller.js        (plan's "REST API changes" row)
 M Backend/src/engine/config/validators.js             (Phase 13 V4/A4; pass 1's H2)
 M Backend/src/engine/shard/failover.js                (PHASE_13_OWNED)
 M Backend/src/engine/shard/membership.js              (PHASE_13_OWNED)
 M Backend/src/engine/shard/shardModel.js              (PHASE_13_OWNED)
 M Backend/src/workers/shardSupervisor.worker.js       (plan's "Background workers" row)
 M Backend/tests/engine/helpers/commitmentStore.js     (shared model — additive table + arity fix)
 M Backend/tests/engine/helpers/shardFixture.js        (Phase 13 fixture — additive timer)
 M Backend/tests/engine/shardFailover.test.js          (Phase 13 test)
 M Backend/tests/engine/shardSchema.test.js            (Phase 13 test)
 M Backend/tests/engine/shardSupervisorWorker.test.js  (Phase 13 test)
 M Backend/tests/engine/shardsApi.test.js              (Phase 13 test)
?? Backend/prisma/migrations/20260819090000_shard_rebalance_intent/
?? Backend/tools/verify/phase13LiveDatabase.js
?? Backend/tools/verify/phase13Profile.js
?? PHASE_13_REMEDIATION_AND_CLOSURE.md                 (this document)
```

`schema.prisma` shows **87 added lines and zero removed** — the change is strictly additive.
`git diff --stat HEAD -- prisma/migrations/` is **empty**: not one of the 25 applied
migrations was touched, so no Prisma checksum moved.

Verified additionally by blob-hash comparison against `HEAD`:

| File | Owner | Result |
|---|---|---|
| `src/engine/commitment/commit.js` | Phase 3 (**G1's caller**) | **UNCHANGED** |
| `src/engine/commitment/guards.js` | Phase 3 (**G1–G6**) | **UNCHANGED** |
| `src/engine/shard/leadership.js` | Phase 3 (**G1's five functions**) | **UNCHANGED** |
| `src/engine/supervision/reconciler.js`, `src/workers/reconciler.worker.js` | Phase 5 | **UNCHANGED** |
| `src/workers/registry.js`, `src/engine/cutover/enabled.js` | Phase 15 | **UNCHANGED** |
| `src/engine/intake/intake.js`, `src/app.js`, `src/db/prisma.js` | Phases 10/13/3 | **UNCHANGED** |
| `src/engine/guards/tierAssertions.js` | Phase 0 | **UNCHANGED** |
| `src/engine/config/register/appendixA.json`, `supplementary.json` | Phases 0–13 | **UNCHANGED** |
| `src/engine/shard/election.js`, `sizing.js`, `crossRegion.js`, `planState.js` | Phases 10/13 | **UNCHANGED** |
| `src/routes/shards.routes.js` | Phase 13 | **UNCHANGED** |
| `prisma/migrations/**` (all 25) | all phases | **UNCHANGED** |

**Phase 0 — unchanged. Phase 1 — unchanged. Phase 2 — unchanged. Phase 3 — unchanged. Phase
4 — unchanged. Phase 5 — unchanged. Phase 6 — unchanged. Phase 7 — unchanged. Phase 8 —
unchanged. Phase 9 — unchanged. Phase 10 — unchanged. Phase 11 — unchanged. Phase 12 —
unchanged.**

**G1, G2 and G3 were not weakened.** `commit.js`, `guards.js` and `leadership.js` are
byte-identical; no migration was edited; live N4 confirms `ShardLeadership` still carries
exactly its nine Phase 3 columns; live FO1 confirms a superseded leader is still fenced; and
P13-R12's fix *adds* a fence check where there was none.

**Two shared test helpers were modified, and both changes are strictly additive.**
`commitmentStore.js` gains a table and its constraints — no existing table's behaviour
changes — plus the `checkViolation` arity correction, which makes error messages *more*
accurate and which no test's assertion depended on. `shardFixture.js` gains one timer row in
a second shard, which the pre-existing assertions were re-run against unchanged (2 pending,
1 overdue for `shard-north`, exactly as before).

**No parameter was added to the register**, no threshold was moved, and no gate was relaxed.

---

## 12. TESTS AND GATES

### 12.1 Tests — exact figures

`npx jest --runInBand --forceExit`, final run after every fix:

```
Test Suites: 150 passed, 150 total
Tests:       6685 passed, 6685 total
Snapshots:   0 total
Ran all test suites in 5 projects.
[exited with code 0]
```

**150 suites · 6,685 tests · 0 failures · 0 skipped · exit code 0.**

| Lane | Suites | Tests |
|---|---|---|
| engine | 120 | 6,357 |
| legacy + gates + chaos + scale | **30** | **328** |
| **total** | **150** | **6,685** |

The four non-engine lanes were re-measured in one run and are **328 tests across 30 suites —
identical to the baseline**, which is the check that this pass's changes are confined to the
engine lane. Engine is the arithmetic remainder.

**Against this pass's baseline: 6,630 → 6,685, +55 tests, no suite added or removed, nothing
skipped.** Against the pre-remediation tree: 6,604 → 6,685, +81.

**Nothing was weakened, deleted or skipped — and one change deserves to be stated
precisely rather than left to the diff.** Three tests in
`shardSupervisorWorker.test.js` previously drove `migrationPass` through an injected
`settings.plan`. That injection **was P13-R4's consumer half**: nothing in production ever set
that key, so thirty-two tests exercised a plan source that did not exist. Those three tests
were rewritten to seed the durable `ShardRebalance` row the controller writes, and eleven
more were added around them. Every assertion they made is still made; what changed is that
they now make it against the composition that ships. That is a strengthening, and the +55
figure is its evidence.

The Phase 13 reports cite **116 suites / 5,647 tests** and three build gates. Those figures
were written on 2026-08-08 against an uncommitted tree; Phases 14 and 15 have since landed.
They are stale, not wrong-at-the-time — the same pattern recorded for Phases 4 and 7.

### 12.2 Gates — 7/7, exit code 0

| # | Gate | Result |
|---|---|---|
| 1 | tier-dependencies (§1.8 rule 2) | **PASS** — 277 modules, **391** governed import edges, 0 Tier 0/1 → Tier 2 |
| 2 | parameter-register (§22, Appendix A) | **PASS** — 183 engine modules against 242 registered parameters, 0 bare behavioural constants |
| 3 | tenets (T1, T6) | **PASS** — 274 modules, 0 violations |
| 4 | identity-isolation (§23.7) | **PASS** — 16 modules |
| 5 | reconstruction-equivalence over an ERASED corpus | **PASS** — 3 decisions, byte-for-byte |
| 6 | legacy-retirement (Phase 15) | **PASS** — 4 retired modules absent and unimported across 322 files |
| 7 | column-generation (§21.6) | **PASS — NOT_REQUIRED** (the gate's own designed verdict; this change set touches none of §21.6's six subjects) |

The tier gate's edge count moved **390 → 391**: `membership.js` now imports
`shard/leadership.js` for P13-R12's fence re-read. Both are Tier 1, so §1.8 rule 2 is
untouched. Module counts are unchanged because no new module was created.

**No threshold was moved, no test was deleted, skipped or weakened, and no gate was
relaxed.**

---

## 13. REMAINING ISSUES

| ID | Issue | Class | Owner | Required action |
|---|---|---|---|---|
| **P13-R6** | Four Tier-0 `LEADER_ONLY` workers (coordinator, outbox, reconciler, timer) that Phase 15's registry says the shard supervisor starts, and nothing starts. `scheduledOnLeadership()` has zero production callers | **BLOCKER for Phase 15** | **Phase 15** | Either the supervisor gains a leader-lifecycle hook (a Phase 13 change Phase 15 must request) or the registry's claim is corrected. **This also blocks §3.5's bound 1**, because the round loop is the only producer of the measurement it needs |
| **P13-R7** | §12.4's sweep is fleet-wide; `shardId` is a label on output rows, never a filter. §19.5 obliges Phase 13 to delegate to it. **Reproduced live (W1)** | **BLOCKER for multi-shard** | **Phase 5** | Scope the scans by shard — the `WorkQueue` routing record is the same one `failover.legsInShard()` uses — or drop §12.4's "per shard" claim. **Must be resolved before a second shard is published.** No Phase-13-local fix exists that is not the forbidden second requeue path |
| **P13-R19** | Shard definitions are validated at publish and never materialised as `Shard` rows | **BLOCKER for multi-shard** | **Phase 1/22** | The config publish path must call `shardModel.ensureShard()` for each definition it accepts. Until then the multi-shard surface is reachable only by direct row insertion |
| **P13-R18** | `membership.place()` has no production caller; no agent is ever placed in a shard | **BLOCKER for multi-shard** | **Phase 2** | Commissioning must place the agent once a shard exists for its region |
| H4 | The §24.6 locality test's million-agent measurement | **DEFERRED** | Phase 15 | Scale suite. Phase 13 completion criterion, discharged only in part |
| H6 | §3.5's bound 1 has no measurement producer | **DEFERRED** | Phase 15 | Wire `solve/round.js` timings to the supervisor's `measurement` seam. Blocked behind P13-R6. Phase 13 completion criterion, discharged only in part |
| H3 | B3 replication posture remains an operator declaration | **OPERATIONAL** | Deployment | Set `SHARD_CONSENSUS_REPLICATION`; an undeclared posture already fails at boot |
| — | `COMMAND_SIGNING_KEY` must be declared for a rebalance to be accepted | **OPERATIONAL** | Deployment | New in this pass. Absent, the endpoint refuses with a 422 naming it, and no shard is taken out of service |
| H8 | `crossRegion.js` has zero production importers | **DEFERRED** | Phase 16f | The saga coordinator reads `CrossRegionSaga.currentStepIndex`. Dead by design, not silently: §1.8 rule 2 requires the dependency to be inverted, and a test asserts it |
| H11 | Socket.IO Redis adapter required but `server.js` still warns and falls back | **DEFERRED** | Phase 15 | Phase 13's own two events now go through this path, so the fallback is no longer only a dashboard concern |
| P13-R5 | The Phase 13 migration's comment says "fourteen CHECK constraints"; there are fifteen | **COSMETIC** | Phase 13 | Leave. Editing an applied migration changes its Prisma checksum on every environment that has applied it, and a one-word comment error is not worth that |
| — | `PHASE_0_INDEPENDENT_VERIFICATION.md` still absent | Documentation | Phase 0 | As every review since Phase 1 has recorded |
| — | Phase 10 (×3), Phase 11 (×3) findings still open | Various | Those phases | Untouched by this pass; re-confirmed present |

**No blocker is hidden by relabelling.** Four issues are labelled BLOCKER above; none of them
is Phase-13-owned, each names its owner, and each states what would discharge it.

---

## 14. PHASE BOUNDARY

- **No Phase 14 functionality was implemented.** `src/engine/security/` and
  `src/engine/privacy/` are byte-identical to `HEAD`. `server.js`'s certificate-rotation
  block is untouched.
- **No Phase 15 functionality was implemented.** `registry.js`, `cutover/**` and
  `startScheduledWorkers` are byte-identical. P13-R6 is documented, not fixed.
- **No Phase 16 functionality was implemented.** `src/engine/fairness/` holds no `.js`; the
  saga coordinator (16f) was not written.
- **No Phase 5 functionality was implemented.** `supervision/reconciler.js` is
  byte-identical. P13-R7 is reproduced and routed, not repaired.
- **No specification file was edited.** `IMPLEMENTATION_EXECUTION_PLAN.md`,
  `NEXT_GENERATION_ASSIGNMENT_ENGINE.md`, `ARCHITECTURE.md` and `ROBOTX_SYSTEM_HANDBOOK.md`
  are unchanged.
- **No historical report was rewritten.** `PHASE_13_IMPLEMENTATION_REPORT.md` and
  `PHASE_13_INDEPENDENT_VERIFICATION.md` are unchanged; every correction is here.
- **One new migration was added**, additive, touching no existing table and editing no
  applied migration file.

---

## 15. FINAL RECOMMENDATION

**Phase 13 is closed, and Phase 14 is authorised to begin.**

Phase 14 delivers §23 — mTLS, attestation, command signing, authorisation scoping, PII
separation. Its declared prerequisites are Phases 3, 4 and 10, not 13, and nothing it touches
depends on an unmeasured sizing bound or an unpublished shard row. The commit path it must
not disturb is byte-identical to what Phase 3 shipped, and this pass proves it twice over.

What changed since the last verification is worth stating plainly. That verification
concluded "PASS WITH MINOR ISSUES" and "Phase 14 may begin" about a phase that, at the moment
it was written, **elected no leader on any deployment**. Remediation pass 1 found that and
two more like it. Pass 2 found that pass 1's own fix had the same shape one layer down — the
sweep it wired in was configured with one of its four inputs, and would have thrown on the
first Leg a failover had to reconstruct. The lesson both passes point at is the same one: a
composition root has no unit test, so every value it fails to supply is invisible until
something executes it. That is why this pass added a composition test that reads `server.js`
and asserts every register name it uses resolves — a mistyped parameter name and an omitted
key produce the same silent failure, and now neither survives a test run.

**Three external blockers must be routed before the first multi-shard cutover**, and the
ordering matters:

1. **P13-R19 and P13-R18** first, because until shard rows exist and agents are placed in
   them, nothing multi-shard is reachable at all — including everything this pass repaired.
2. **P13-R7** before the second shard is published, because it becomes a second-writer
   violation the moment two leaders exist. It is the most dangerous of the three: it is
   silent, §19.5 obliges Phase 13 to delegate to exactly the sweep that has it, and W1 shows
   it repairing another shard's Leg and recording the repair under the wrong shard.
3. **P13-R6**, which today means the outbox, the timer worker, the continuous reconciler and
   the round loop do not run at all — and which is also what keeps §3.5's bound 1 unmeasured.

Phase 13's own work is complete. Leadership, fencing, failover, the membership handoff, the
rebalance lifecycle and the schema are verified where they were previously argued, and the
one durable state a shard could be stranded in is now unrepresentable at the database.

**TRUTH > GREEN.**

---

*End of Phase 13 Remediation & Closure document.*
