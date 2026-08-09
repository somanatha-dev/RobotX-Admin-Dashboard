# Phase 12 — Implementation Report

**Role:** Senior Distributed Systems Engineer implementing the frozen architecture
**Scope:** `IMPLEMENTATION_EXECUTION_PLAN.md` §3 "PHASE 12 — Failure handling, degraded modes,
invariant checker" (rows 626–653) and its §7 checklist (lines 1238–1258), implementing
`NEXT_GENERATION_ASSIGNMENT_ENGINE.md` §18 and §26 in full
**Date:** 2026-08-07 · **Branch:** `feature/dashboard` · **Baseline:** Phase 11, independently
verified ("PASS WITH MINOR ISSUES" — `PHASE_11_INDEPENDENT_VERIFICATION.md` — "**Phase 12 may
begin**"), uncommitted on top of `cf9103f`
**Phase 13 or later:** not implemented. `src/engine/shard/` still holds only `leadership.js` and
`planState.js`; no `Shard`, `ShardMembership`, `CrossRegionSaga`, or `TransferPoint` table; no
`shardSupervisor.worker.js`. `src/engine/fairness/` remains empty — §17.4's ladder is its own
phase's.

---

## 1. Executive Summary

Phase 12 delivers §18 and §26 of the frozen architecture: the six-mode degraded register with its
four governing rules and the complete §26.2 matrix (§18.5), the agent and infrastructure failure
catalogues with §18.1's five principles enforced rather than described (§18.2, §18.3), obstruction
classification with `INDETERMINATE` resolving to `STRANDED_OBSTRUCTING` (§4.3), the five-step
external escalation chain with step 4 human-gated (§18.6), and the Invariant Checker reporting
`ENFORCED` / `VIOLATED` / `SUSPENDED` across all twenty-two invariants from a position genuinely
independent of the code paths that maintain them (§26).

Eight new engine modules, one background worker (unscheduled, per the convention every worker since
Phase 4 has followed), one REST route pair, three new Prisma models, seven new registered
parameters, and nine new test files (**240 tests**). Five existing files were rewired:
`commandDispatcher.service.js`, `supervision/leases.js`, `sockets/handlers/dtaro.handler.js`,
`app.js`, and `routes/index.js`.

`npm run verify` (all three build gates, then all three Jest lanes) is green: **106 suites, 5,373
tests, 0 failures.** The legacy lane is unchanged at **169/169** — Phase 10's and Phase 11's own
baseline — confirming zero behavioural regression in the path Phase 15's cutover has not yet
reached. The gates lane is unchanged at **49/49**.

**Three findings are worth a verifier's attention up front**, and each is recorded rather than
smoothed over:

1. **The §26.2 matrix is cross-checked against the frozen document itself, not against a second
   copy of my own transcription.** `degradedModeRegister.test.js` parses §26.2's markdown table out
   of `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` and compares all **132 cells**. That is the assertion
   most worth having, because a transcription error in this table is invisible to every other test
   in the tree — the checker would simply report the wrong status, confidently, forever.
2. **The Invariant Checker's independence is enforced by source scan, and it cost something.**
   §26.1 says "a checker sharing logic with the enforcer verifies nothing", so the module imports
   exactly one thing (`degraded/modeRegister.js`, which is §26.2's matrix — the checker's own
   requirements), performs no writes at all, reads no clock, and **re-declares the §4.3 state
   vocabulary locally** rather than importing `lifecycle/legMachine.js`. §13 item 2 states what
   that trade costs and how the drift it risks is caught at build time instead.
3. **I6's high-water marks are the checker's own, not `AgentFenceAudit`'s.** Phase 3 already
   persists a per-agent `fenceHighWater`, and reusing it would have been the obvious economy — but
   that column is maintained by the commit path, and verifying the commit path's monotonicity
   against a number the commit path writes verifies self-consistency rather than I6. The Checker
   keeps its own mark on its own rows. §5 states the schema consequence.

**One counting discrepancy between the plan and the specification was resolved by the plan's own
§0.1 rule** ("*Where this plan and the specification appear to disagree, the specification wins and
this plan is defective*"): the plan's checklist says "`failure/agentFailures.js` — A1–A20", and
§18.2's table indeed has twenty rows, but it orders them A1–A17, **A20**, A18, A19. The catalogue
preserves the specification's order and a test asserts it. Not an architectural ambiguity — so no
stop was warranted.

---

## 2. Objectives Achieved

Cross-referencing `IMPLEMENTATION_EXECUTION_PLAN.md`'s Phase 12 checklist (§7, lines 1238–1258)
item by item:

| # | Checklist item | Status |
|---|---|---|
| 1 | Migration: `DegradedModeEvent`, `InvariantStatus`, `ExternalEscalation` | **Done** — §5 |
| 2 | `degraded/modeRegister.js` with all six named modes and the four governing rules | **Done** — each rule is an assertion over the table, not prose; §10 |
| 3 | **Restricted Operation** (suspends no invariant) | **Done** — declared with an empty suspension set, and the empty set is *recorded* rather than omitted |
| 4 | **Custodial Operation** — no commits, **no commands**, I2 explicitly suspended, agents autonomous | **Done** — and the "no commands" half is enforced at the single exit every §10.3.1 command passes through |
| 5 | **Unsupervised Commitment**, **Degraded Routing**, **Cold Index**, **Shed Load** | **Done** — all four, with their envelopes and exit criteria |
| 6 | Verify no mode promotes the cache to an authority and none relaxes a class I or R constraint | **Done** — `assertNoCacheAuthority()` and `assertRelaxesNoConstraint()`, both by enumerated forbidden field name and by knob direction |
| 7 | `failure/agentFailures.js` — A1–A20 with detection, latency, response, escalation | **Done** — 20 rows, cross-checked against §18.2's own table including its ordering |
| 8 | Bounded dead-zone lease extension (p95, capped, corroborated exit required) | **Done** — a mean is refused *by name*; an uncapped extension is refused rather than defaulted |
| 9 | `failure/infraFailures.js` — B1–B20 | **Done** — 20 rows, plus B16's ordering and B20's quarantine as functions rather than prose |
| 10 | `map/obstructionClass.js`; `INDETERMINATE` resolves to `STRANDED_OBSTRUCTING` | **Done** — in all three ways a class becomes indeterminate, each distinguished |
| 11 | `failure/externalEscalation.js` — five steps, step 4 human-gated | **Done** — the gate is three independent refusals, none of which is a flag; §10 |
| 12 | `observability/invariantChecker.js` — independent of the enforcing code paths | **Done** — and the independence is checked by source scan rather than asserted |
| 13 | All 22 invariant checks with `ENFORCED` / `VIOLATED` / `SUSPENDED` | **Done** — each with the §26.1 instrument it names, and each proved to fail on a planted defect |
| 14 | The §26.2 matrix — every invariant × every mode | **Done** — 132 cells, cross-checked against the frozen document |
| 15 | Windowed monotonicity audit with persisted high-water mark (I6) | **Done** — the checker's own mark, and it never retreats past a regression |
| 16 | REST: `GET /api/health/invariants`, `GET /api/health/modes` | **Done** — §7 |
| 17 | Simulation: drive entry/exit of every mode; observed statuses match the §26.2 matrix exactly | **Done** — driving the real modules against a store, not asserting the matrix against itself |
| 18 | Chaos: Commitment Store removed beyond the autonomy limit — full Custodial Operation behaviour | **Done** — all five clauses of the plan's own scenario; §11 |
| 19 | **Gate:** invariant-violation SLI is zero in nominal operation; suspensions explicit, time-boxed, alertable | **Done** — with the honest caveat in §13 item 1 about what "nominal operation" can mean before Phase 15 |

---

## 3. Files Created

**Engine modules:**

| File | Lines | Purpose |
|---|---|---|
| `src/engine/observability/invariantChecker.js` | 1,410 | §26 — all 22 checks, three statuses, independence, I6's windowed audit |
| `src/engine/degraded/modeRegister.js` | 951 | §18.5 — six modes, four rules as assertions, §26.2's 132 cells |
| `src/engine/failure/agentFailures.js` | 710 | §18.2 — A1–A20, and A3's bounded dead-zone extension |
| `src/engine/failure/externalEscalation.js` | 525 | §18.6 — five steps, step 4 human-gated, the contact set and its review state |
| `src/engine/degraded/transitions.js` | 462 | §18.5 — entry, exit, exit criteria, the advisory mirror, the socket payloads |
| `src/engine/failure/infraFailures.js` | 445 | §18.3 — B1–B20, B16's buffering order, B20's quarantine |
| `src/engine/map/obstructionClass.js` | 416 | §4.3 — classification, A10's lowest-reachable choice, step 5's reclassification |
| `src/engine/failure/catalogue.js` | 325 | §18.1 — the index over both halves, and the five principles as assertions |

**Worker (unscheduled):** `src/workers/invariant.worker.js` (476) — the check pass, §18.5 rule 2's
time-box sweep, and §18.6 step 5's re-evaluation sweep, as three separate passes.

**REST:** `src/controllers/health.controller.js` (249), `src/routes/health.routes.js` (25).

**Migration:** `prisma/migrations/20260807090000_degraded_modes_failure_handling_invariants/migration.sql`
(214 lines).

**Tests (`Backend/tests/engine/`):** `invariantChecker` (629), `degradedTransitions` (470),
`helpers/degradedFixture.js` (373), `degradedModeRegister` (346), `degradedSchema` (332),
`failureCatalogue` (309), `externalEscalation` (307), `healthApi` (278), `invariantWorker` (270),
`mapObstructionClass` (258) — **240 tests**.

**Two files created beyond the plan's enumerated list, and why.** The plan's Phase 12 "Files to
create" row names nine modules and no REST files, while its "REST API changes" row specifies two new
endpoints. `health.controller.js` and `health.routes.js` are those endpoints' home, mounted at
`/api/health` beside every other authenticated read since Phase 5. The alternative — hanging them off
`app.js`'s existing unauthenticated `/health` — was rejected because that route is an infrastructure
liveness probe and these two name the invariants a shard has suspended and why it entered a degraded
mode, which is operational detail rather than a liveness signal. `app.js`'s `/health` gains a
*summary* instead (§7).

`tests/engine/helpers/degradedFixture.js` is a **separate** in-memory store from Phase 11's
`roundFixture.memoryPrisma`. Extending that one to the eleven further tables the checker reads would
have given two phases one fixture to disagree over, and Phase 11's own report already records its
`groupBy` implementations as minimal.

## 4. Files Modified

| File | Change |
|---|---|
| `Backend/prisma/schema.prisma` | Three models added; `Leg` gains a **back-relation only** (`externalEscalations`), which adds no column |
| `Backend/src/engine/config/register/supplementary.json` | 7 new entries. Purely additive; no existing entry touched |
| `Backend/src/services/commandDispatcher.service.js` | `deliverOutboxCommand` gains an optional `options.activeModes` and refuses under Custodial Operation; `outboxDeliveryArm` accepts a mode reader. Both backwards compatible — see §7 |
| `Backend/src/engine/supervision/leases.js` | `renew()` gains the explicit `storeAvailable === false` halt, a new `HALTED_STORE_UNAVAILABLE` outcome, and `custodialDirective()` |
| `Backend/src/sockets/handlers/dtaro.handler.js` | `ROBOT_FAULT` is classified against §18.2 (A5/A6) alongside the unchanged legacy handling |
| `Backend/src/app.js` | `/health` gains a `degraded` summary block |
| `Backend/src/routes/index.js` | `/api/health` mounted |
| `Backend/tests/engine/phase0Scaffold.test.js` | `PHASE_12_OWNED = ["degraded/", "failure/", "map/"]` added to the cumulative ownership walk |
| `Backend/tests/engine/commitmentSchema.test.js` | Table boundary moved to Phase 13; Phase 12's three tables asserted **present** |
| `Backend/tests/engine/costSchema.test.js` | Same boundary move, plus its module-presence boundary narrowed to `fairness/` |
| `Backend/tests/engine/observabilitySchema.test.js` | Same; `invariantChecker.js` named explicitly as a Phase 12 module in a Phase 11 directory rather than the assertion being relaxed to a superset |

No file outside these lists was touched. In particular **`src/engine/TIERS.md` and
`guards/tierAssertions.js` were not modified**: Phase 0 declared T0-10, T0-11 and T1-07 against
exactly the module paths this phase creates, so the declaration was already correct and this is the
phase that makes it *true*. `degradedSchema.test.js` asserts that every module those three rows name
now exists.

---

## 5. Database Changes

Additive only. No `DROP`, no `ALTER COLUMN`, and no `ALTER TABLE` on any pre-existing table — the
`Leg` change is a back-relation, which Prisma resolves without a column.

**`DegradedModeEvent`** — §18.5 rule 1's entry and exit events. Three properties of the shape are
load-bearing. `cause` and `enteringComponent` are **NOT NULL**, because a mode entered for no
recorded reason cannot be exited on evidence either and one nobody entered is one nobody will exit.
`suspendedInvariants` is an **array**, and an empty array is a legitimate recorded value: four of the
six modes suspend nothing, and recording that explicitly is what lets a reader tell "suspended
nothing" from "nobody wrote it down". `timeBoxExpiresAt` carries rule 2's box as a queryable column
rather than a duration somebody must recompute, because §26.1 makes a suspension that outlives its
box alertable.

**`InvariantStatus`** — one row per invariant per shard, **plus** I6's per-agent high-water rows,
discriminated by `subjectType`. The second use is the one worth defending: §26.1 requires "a
windowed monotonicity audit against a persisted high-water mark per agent", and `AgentFenceAudit`
already has one — but that column is written by the commit path, and checking the commit path
against its own bookkeeping is the circularity §26.1 warns about when it says a checker sharing
logic with the enforcer verifies nothing. Putting the Checker's own mark on the Checker's own table
keeps the phase to the three tables the plan names *and* keeps the verification honest.
`subjectId` defaults to `""` rather than NULL because a NULL in a unique key does not collide in
Postgres, and upsert-by-key is exactly what the worker needs.

**`ExternalEscalation`** — one row **per step attempt**, not per stranding. Step 5 is "continuous
until cleared" and writes on every re-evaluation; step 4's operator decision, *including a declined
one*, is a fact worth keeping. A status column the next step overwrote would destroy precisely the
record a dispute months later would need — §21.7's argument applied to the one chain that reaches
outside the operator.

**Ten hand-written CHECK constraints and one partial unique index Prisma cannot express:**
`DegradedModeEvent_mode_known`, `DegradedModeEvent_exit_is_evidenced`,
`DegradedModeEvent_one_open_per_shard_mode` (the partial index), `InvariantStatus_invariant_known`,
`InvariantStatus_status_known`, `InvariantStatus_suspension_names_its_mode`,
`InvariantStatus_violation_count_non_negative`, `InvariantStatus_subject_type_known`,
`ExternalEscalation_step_in_range`, `ExternalEscalation_step_four_is_human_gated`,
`ExternalEscalation_disposition_known`.

Three deserve a word.

`InvariantStatus_suspension_names_its_mode` enforces §18.5 rule 2 **in both directions**: a
`SUSPENDED` status without an authorising mode cannot be stored, and a non-suspended status *with*
one cannot either — so the column cannot decay into a general-purpose annotation. Rule 2's "no
invariant is ever suspended implicitly by a component finding it inconvenient" is thereby a property
of the table rather than of every writer's diligence.

`ExternalEscalation_step_four_is_human_gated` is the third of three independent enforcement points
for §18.6's human gate (§10 lists the other two). A schema constraint is the one a future writer
cannot route around by calling a different function.

`DegradedModeEvent_one_open_per_shard_mode` is the schema's backstop for entry idempotence. Two open
rows for one mode would double-count "time spent in each mode" — which §18.5 rule 1 makes an SLI —
and would leave an exit closing an arbitrary one of them.

Every `CREATE TABLE` / `CREATE INDEX` / `ADD CONSTRAINT … FOREIGN KEY` was taken verbatim from
`prisma migrate diff --from-empty --to-schema-datamodel`; `tests/engine/degradedSchema.test.js`
re-runs that diff, asserts byte equality modulo whitespace, and asserts the ten CHECKs and the
partial index are **absent** from Prisma's output — which is what proves they are genuine
hand-written additions rather than an echo.

**Not applied to a live database**, consistent with every phase since 6. `npx prisma validate`
succeeds; `prisma migrate diff --from-empty` needs no connection and was used instead.

---

## 6. Runtime Behaviour

`ENGINE_ENABLED` remains `false`. `invariant.worker.js` is not started from `server.js` or
`src/app.js` — asserted mechanically, not by inspection.

**With the engine off**, three changes are reachable:

- `/health` gains a `degraded` block. Best-effort: it returns `null` if the register cannot be read,
  which costs visibility and never availability (§3.3). With no Phase 12 rows written it reports an
  empty mode list and zero counts.
- `/api/health/invariants` and `/api/health/modes` answer from an empty register — the first reports
  all twenty-two as **unreported**, which is the honest answer and not "all clear".
- `ROBOT_FAULT` carries a `classification` block on the dashboard payload beside every field it
  carried before. The legacy DB write, Event row, registry update and ACK are unchanged; the 169-test
  legacy lane confirms it.

**With the engine on**, the mode register interposes at three points:

```
  detector (B1/B3/B4/B5/B19, or §7.4's guard)
        │
        ▼
  transitions.enter()  →  DegradedModeEvent row  →  engine:mode:{shard} (advisory)
        │                                        →  DEGRADED_MODE_ENTERED (dashboard)
        ▼
  commandDispatcher.deliverOutboxCommand()   refuses under Custodial Operation
  supervision/leases.renew()                 halts when the store is unavailable
  invariantChecker.checkAll()                resolves each status against §26.2
```

Two orderings are load-bearing and stated in the code rather than left implicit:

- **The check runs before the matrix is applied**, never instead of it. Skipping a check because a
  mode suspends the invariant would mean the register learned nothing during exactly the periods it
  most needs evidence from — and §26.2's eleven `D` cells are cells where the invariant is *still
  enforced*, only verified more coarsely, so a checker that short-circuited on any non-`E` cell
  would silently stop verifying eleven live guarantees.
- **I6's marks are written after the comparison.** Writing first would advance the mark past a
  regression and make the next pass report the fleet as monotone.

**Custodial Operation's exit is two-step, and `mayResumeRounds()` is the query the coordinator asks
before its first round back.** A mode that exited on "the store answered a health check" would
restore I2 while the divergence the outage created was still unreconciled — the window in which a
mission that exceeded its autonomy limit is still unaccounted for.

**Determinism.** Every Phase 12 module takes time as an argument. `invariantChecker.js` is asserted
clock-free and randomness-free by source scan; `modeRegister.js` and `obstructionClass.js` evaluate
their time boxes and staleness budgets against a supplied instant, exactly as
`feasibility/systemicGuard.js` does, so a replay of a round taken under a mode reaches the same
conclusion about whether its box had expired.

---

## 7. API Changes

**New: `GET /api/health/invariants`** — per-invariant status, driven by §26.1's register rather than
by what happens to be in the table, so an invariant the checker has never reported on appears as
`reported: false` rather than being silently absent. Each row carries its stored status, its age, the
instrument that produced it, the **mode that authorised any suspension**, its obligation tier (§1.8),
and — separately — what §26.2 *expects* under the modes currently open, with a `matchesMatrix` flag.
That last field makes the specific failure the plan's testing row names ("no invariant reports
`VIOLATED` where the matrix says `SUSPENDED`") visible on the wire rather than only in a test.

**New: `GET /api/health/modes`** — the open modes with their causes, envelopes, exit criteria and time
boxes; the recently exited ones with their durations; and **the whole register**, so an operator can
read what Custodial Operation will do *before* the Commitment Store fails rather than during. It
names `DegradedModeEvent` as the authority explicitly, so no consumer mistakes the advisory mirror
for the source.

Both sit behind the same `authUser` middleware every authenticated read since Phase 5 has used, at a
higher rate limit (240/min) than the Explanation API's, because during an incident these are the
pages an operator refreshes and rate-limiting the register at the moment it matters would be an
observability failure arrived at from the transport layer.

**`/health` gains a `degraded` block** — the mode list, the union of suspended invariants, and the
three status counts. Deliberately the *summary*: `/health` is unauthenticated and polled on a short
interval, and the per-invariant detail names what a shard cannot currently guarantee, which is
operational detail rather than a liveness signal. A test asserts the entry cause does not appear
there.

**Backwards compatibility.** `deliverOutboxCommand(io, agentSocketId, envelope)` keeps its three-arity
signature; the fourth parameter defaults to `{}`, and an absent `activeModes` suspends nothing — the
correct default for the legacy path, which has no modes and is unchanged until Phase 15, and safe for
the engine path because the drain worker always supplies it. `outboxDeliveryArm(io)` is likewise
unchanged for its existing caller. **No existing endpoint's behaviour, response shape, or route
changed**, and the legacy lane is unchanged at 169/169.

---

## 8. Redis Changes

One new advisory key, exactly the one the plan's row reserves:

- `engine:mode:{shard}` — the shard's open modes, the union of their suspended invariants, and the
  two "may we command / may we commit" booleans, with a 120 s TTL.

**The durable `DegradedModeEvent` stream is the authority and this is a hint.** Two properties keep
that honest rather than merely stated. `publishAdvisory()` returns rather than throws on a cache
failure — losing the mirror costs visibility, never correctness. And **nothing in `transitions.js`
ever reads the mode back from the cache**: a test source-scans the module for `kv.get`. That
restraint is §18.5 rule 3 applied to the register's own implementation — a mode register that cached
its own state and then trusted the cache would have promoted the cache tier to an authority in the
course of implementing the rule that forbids it.

The payload is deliberately not the whole envelope. A reader that needed the envelope needs the
authority, and a mirror rich enough to make decisions from is a mirror somebody will make decisions
from.

## 9. Socket.IO Changes

Four dashboard-facing events, exactly the four the plan's row names. All four are **payload builders
that return their message** rather than emitters: no Phase 12 module takes a Socket.IO dependency,
matching every engine worker since Phase 4, and `invariant.worker.socketMessages(tick)` is what a
caller holding an `io` emits.

| Event | Emitted on | Carries |
|---|---|---|
| `DEGRADED_MODE_ENTERED` | `transitions.enter()` | mode, cause, entering component, suspended and degraded invariant sets, time-box expiry, exit criterion |
| `DEGRADED_MODE_EXITED` | `transitions.exit()` | mode, evidence, exiting component, duration (the §21.4 SLI), restored invariants |
| `INVARIANT_STATUS_CHANGED` | a status **transition**, not every pass | invariant, from, to, authorising mode, violation count, instrument |
| `STRANDING_ESCALATED` | `openChain()` and step 5's sweep | Leg, obstruction class, hazard state, steps emitted, whether emergency services remain gated |

`INVARIANT_STATUS_CHANGED` fires on change rather than on every pass deliberately: a dashboard told
twenty-two times a minute that everything is still fine learns nothing, and the one transition that
matters would arrive in the same shape as the noise.

No existing socket event's name or payload changed. `ROBOT_UPDATED` gains a `classification` field
additively.

---

## 10. Architecture Compliance

**Tier placement.** `degraded/`, `failure/` and `map/` resolve to **Tier 0** by the path-prefix table
Phase 0 wrote; `observability/invariantChecker.js` and `workers/invariant.worker.js` resolve to
**Tier 1** (T1-07). No new `MODULE_TIERS` row was needed and none was added. The tier gate confirms
mechanically: 251 modules, 333 governed import edges, zero Tier 0/1 → Tier 2 edges.

**The four governing rules are each an assertion over the table, not a paragraph.** Rule 1 by
mandatory fields on `entryEvent()`/`exitEvent()`, which *throw* rather than defaulting. Rule 2 by
`suspensionsFor()` being unary — there is no parameter through which a caller could contribute a
suspension, which is what "no invariant is ever suspended implicitly by a component finding it
inconvenient" means expressed as an API. Rule 3 by an enumerated list of forbidden envelope field
names, so a future field called `readLeasesFromCache` fails the build rather than quietly working.
Rule 4 by the same forbidden-name discipline `feasibility/systemicGuard.js` established for
Restricted Operation, extended to all six — plus a direction check: every reserve knob is a named
*multiplier parameter*, so it can only enlarge, and a divisor or a bare reserve value fails.

**§26.2's third load-bearing property is proved, not assumed.** `assertNoSafetyInvariantSuspended()`
checks I1, I7, I8, I9, I17 and I19 are `E` in every column, and
`assertSuspensionsAreExactlyTheTwo()` checks that the only two `S` cells in the whole matrix are I2
under Custodial Operation and I4 under Unsupervised Commitment. The simulation drives both properties
rather than only asserting them: it enters each of the six modes for real, runs the real checker, and
compares.

**Step 4's human gate is three independent refusals, and none of them is a flag.** By the **absence
of a code path** — `openChain()` cannot produce step 4, and `AUTOMATIC_STEPS` does not contain it,
which `assertStepFourIsUnreachable()` proves so that a future edit adding it fails here rather than
shipping. By **signature** — `confirmEmergencyServices()` takes an operator identity and throws
without one. And by **schema** — `ExternalEscalation_step_four_is_human_gated`. A flag would be a
gate somebody can set; an absent code path is not. The configured threshold does not open step 4
either: `emergencyServicesEligible()` decides whether a *person is asked*, which is the part
automation is entitled to do.

**The Invariant Checker's independence, concretely.** It imports exactly one module
(`degraded/modeRegister.js` — §26.2's matrix, which is the checker's own requirements rather than an
enforcer). It contains no `create`, `update`, `upsert` or `delete` call, so every write is the
worker's, made from the checker's *returned* findings — a checker that shared a pass with a repair
loop could paper over the divergence it exists to report. It reads no clock. And it re-declares the
§4.3 terminal, recovery and stranded state partitions locally rather than importing
`lifecycle/legMachine.js`, because a checker that read its state partition from the module under
test would inherit that module's mistake and report `ENFORCED` on it.
`assertVocabularyAgreesWithDomain()` compares the two at build time, so independence at runtime costs
nothing in drift. All four properties are checked by source scan in `invariantChecker.test.js`.

**A check that could not run reports neither `ENFORCED` nor `VIOLATED`.** A query that throws is a
fact about the checker, not about the invariant, and returning `ENFORCED` would produce a green
register from a broken query — strictly worse than no register. The status is `null`, `checkError` is
set, the previously stored row is left standing, and `summary.checkerHealthy` goes false. §26.1's
three statuses are preserved exactly; what is added is a field about the *checker*, which is a
different subject.

**Custody-awareness is a field rather than a paragraph, with one declared exception.** §18.1
principle 3 splits half of §18.2's rows in two, and `assertCustodyAwareRowsSplitTheirResponse()`
fails a custody-aware row that gives one undifferentiated response. A2 is the single exception and it
is declared, not silent: §18.2 words A2's response as "… then §4.7" and its escalation as "as A1", so
its custody branch is §4.7's — evaluated once, in `supervision/leases.assessRecovery`. Restating
§4.7's three lawful outcomes in a catalogue row would be a second implementation of them, and two
implementations of a custody decision is the drift §2.5 is least able to tolerate. The row carries
`custodyResolvedBy` and the assertion accepts that; what it refuses is a row that is *silently*
undifferentiated.

**The catalogue↔register join is checked in both directions.** A row naming a seventh mode is a
defect; a mode whose entry trigger names no catalogue row is also one, because it would be a shard
state nothing can cause. Restricted Operation is the one declared exception — §7.4's measured
indeterminacy fraction is its trigger, not a catalogue row — and it is named as such rather than left
as a gap.

**Where the mode gate sits, and why there.** `deliverOutboxCommand` is the *only* route by which a
§10.3.1 command reaches an agent (§4.1 rule 5), so the "no commands" refusal sits at that single exit
rather than one level up in the drain worker, where a future caller could route around it. The
service takes no engine store dependency: `activeModes` is supplied by the caller, because a
legacy-tree service that queried the mode register would be a second place the shard's mode is
determined. `outboxDeliveryArm` accepts a *function* so the set is re-read per row — a value captured
at bind time would let a command out after Custodial Operation opened mid-drain, and a test drives
exactly that.

**Why `supervision/leases.js` needed a change at all.** Its header has stated since Phase 5 that
renewal "stops" when the store is unavailable rather than falling back to a cached lease, and that
was true as a property of what the module *imports* — no cache. That is a real guarantee against one
mistake and none at all against another: a caller that kept renewing against a store it already knew
was unreachable would produce a stream of failed writes and, worse, would leave the shard supervising
on the belief that renewal was still happening. `storeAvailable === false` is the caller stating what
it knows, and the refusal turns that knowledge into a stop. Only an explicit `false` halts — an
absent flag means the caller has no health signal, and refusing on an unknown would convert a missing
argument into a shard that stops supervising.

**The seven new register entries, and why each was needed.** Five carry inputs a §18 mechanism reads
that Appendix A does not tabulate: `map.obstruction_class_max_age` (§4.3 defines `INDETERMINATE` as
"unavailable **or stale beyond its budget**" and tabulates no budget; registered SAFETY-class,
because it decides whether the §18.6 chain opens), `failure.poison_quarantine_threshold` (B20's "after
`n` failures"), `ops.external_escalation_contacts` and `ops.escalation_contact_review_period` (§18.6's
per-region contact set "with a named owner, reviewed on the same cadence as the safety case"), and
`ops.emergency_services_hazard_threshold` (step 4's "configured threshold"). Two carry the checker's
own cadence: `invariant.check_interval` (§26.1 says "continuously verified" without fixing a period)
and `invariant.monotonicity_window` (I6's audit is specified as *windowed*). The two contact-set
parameters are seeded **null and `required`** rather than with placeholders, because a fabricated
contact is worse than a recorded absence — the chain would report success into a number nobody
answers.

---

## 11. Test Results

`npm run verify` (all three build gates, then all three Jest lanes):

```
gate: tier-dependencies (§1.8 rule 2)      PASS — 251 modules, 333 edges, 0 violations
gate: parameter-register (§22, Appendix A) PASS — 161 modules, 217 registered params, 0 bare constants
gate: tenets (T1 type separation, T6)      PASS — 248 modules, 0 violations

Test Suites: 106 passed, 106 total
Tests:       5373 passed, 5373 total
```

By lane:

- **engine**: 81 suites (72 pre-existing + **9 new**), **5,155 tests**. Phase 12's own nine files
  contribute **240**.
- **legacy**: **169/169**, unchanged from Phase 10's and Phase 11's reported baseline — zero
  behavioural regression in the legacy dispatcher.
- **gates**: **49/49**, unchanged.

**The plan's named testing requirements, and where each is discharged:**

| Requirement | Where |
|---|---|
| **Simulation (§24.4):** drive entry into and exit from **every** named mode; observed statuses match §26.2 exactly | `degradedTransitions.test.js` — a `test.each` over all six modes, driving `transitions.enter` → the real `invariantChecker.checkAll` → `transitions.exit` against a store, with two defects planted so a suspension has something real to suspend |
| …including that no invariant reports `VIOLATED` where the matrix says `SUSPENDED` or `D` | The same test, in both directions: a matrix `S` cell must produce `SUSPENDED` **naming that mode**, and a checker `SUSPENDED` with no `S` cell authorising it is equally a failure |
| **Chaos:** Commitment Store removed beyond `agent.autonomous_continuation_limit` | `degradedTransitions.test.js` — six tests covering all five of the plan's clauses; §11 below |
| **Unit:** obstruction class `INDETERMINATE` resolves to `STRANDED_OBSTRUCTING` | `mapObstructionClass.test.js` — in all three ways a class becomes indeterminate, plus the two derived decisions (A10's stopping choice, step 5's re-evaluation) |

**The chaos scenario, clause by clause.** *Custodial Operation entered* — driven through
`infraFailures.modeFor("B1")` so the catalogue and the register are joined rather than assumed. *No
commands issued* — a real emit counter stays at zero under the mode and increments outside it, so the
refusal is the mode's and not a broken dispatcher. *I2 `SUSPENDED` not `VIOLATED`* — every lease
expired, the checker run past the autonomy limit, and `summary.pageWorthy` is false. *Agents halt at
safe locations* — the register names `agent.autonomous_continuation_limit` and the test asserts the
registered default is 900 s, the bound being enforced on the agent rather than by the server. *Full
reconciliation precedes round resumption* — the store returning is shown to be **insufficient**: the
exit is refused, `mayResumeRounds()` stays false, and only reconciliation completes it.

**Three things worth a verifier's independent re-derivation:**

1. **The §26.2 cross-check parses the frozen document.** `degradedModeRegister.test.js` reads
   §26.2's markdown table out of `NEXT_GENERATION_ASSIGNMENT_ENGINE.md`, asserts it parses to 22 × 6,
   and compares every cell against the register. It also parses §18.5's table and asserts six rows,
   and `failureCatalogue.test.js` parses §18.2's and §18.3's and asserts twenty each *in the
   specification's own order*. Worth re-running against a deliberately corrupted cell.
2. **Every check is proved to fail.** `invariantChecker.test.js` plants one defect at a time into an
   otherwise healthy world — 24 planted defects across the 22 invariants — and asserts exactly the
   governing invariant turns `VIOLATED`. A check that cannot fail is not a check, which is the same
   argument the Phase 0 gate self-tests make.
3. **The fixture models the partial unique index.** `degradedFixture.memoryStore` refuses a second
   open row for one `(shardId, mode)`, so the idempotence test passes against a store the database
   would also accept. It also coerces an unset column to NULL, because a real row always has every
   column — without which `{ exitedAt: null }` would fail to match a row created without the key, and
   a test would pass against a store Postgres would never produce. That defect was found and fixed
   during this phase's own test run.

---

## 12. Self-Verification

- [x] **Every Phase 12 checklist item implemented** (§2), all nineteen, with the one caveat in §13
      item 1 disclosed rather than claimed complete.
- [x] **No Phase 13 functionality** — `src/engine/shard/` holds only `leadership.js` and
      `planState.js`; no `election.js`, `failover.js`, `membership.js`, `sizing.js`, `crossRegion.js`
      or `shardModel.js`; no `shardSupervisor.worker.js`; no `Shard`, `ShardMembership`,
      `CrossRegionSaga` or `TransferPoint` table. All asserted mechanically in
      `degradedSchema.test.js`, not merely stated.
- [x] **No §17.4 ladder functionality** — `src/engine/fairness/` holds no `.js`. Asserted.
- [x] **Architecture unchanged** — no `.md` specification file was edited. §18 and §26 implemented as
      written, with the one plan-versus-specification ordering discrepancy resolved by the plan's own
      §0.1 rule and disclosed in §1 rather than silently.
- [x] **Tests pass** — 5,373/5,373 across all three lanes.
- [x] **Build passes** — `npx prisma validate`, all three build gates.
- [x] **APIs remain compatible** — two new routes; `/health` additive; no existing shape changed;
      `deliverOutboxCommand` and `outboxDeliveryArm` keep their existing arities working; the legacy
      lane is unchanged at 169/169.
- [x] **Architectural layering maintained** — Tier 0 modules (`degraded/`, `failure/`, `map/`) import
      only Tier 0 and Tier 1 data modules; the Tier 1 checker imports one Tier 0 data module; the
      legacy-tree dispatcher imports the mode register for pure queries and takes no store dependency.
- [x] **Ownership boundaries maintained** — no module enters a mode except through
      `degraded/transitions.js`; `escalation.js` and `timers.js` still only *name* their modes, as
      they were written to; the checker writes nothing and the worker performs every write.
- [x] **Concurrency guarantees maintained** — no new lock and no new exclusivity mechanism. Entry
      idempotence is a partial unique index; a concurrent close is surfaced to the caller rather than
      swallowed.
- [x] **Determinism maintained** — every Phase 12 module takes time as an argument; the checker is
      clock-free and randomness-free by source scan.
- [x] **Backwards compatibility maintained** — with `ENGINE_ENABLED` false the only reachable changes
      are the `/health` summary, the two new authenticated routes, and an additive field on
      `ROBOT_UPDATED`.

---

## 13. Known Limitations

1. **The §26.1 gate — "invariant-violation SLI is zero in nominal operation" — is verified against
   fixtures, not against a running fleet, and cannot yet be otherwise.** The checker reports zero
   violations over a healthy world and detects every planted defect, which is what this phase can
   establish. What it cannot establish is the *production* claim, because `ENGINE_ENABLED` is false
   and no shard has ever run a round: there is no nominal operation to be zero over. This is the
   honest input to Phase 15's release gate rather than a claim to have passed it.

2. **The checker's locally-declared state vocabulary is a real trade, and it can drift.** Declaring
   the terminal, recovery and stranded partitions locally is what makes the checker independent at
   runtime; the cost is a second copy of three short lists.
   `assertVocabularyAgreesWithDomain()` compares them against `lifecycle/legMachine.js` and
   `supervision/leases.js` in the test lane, so a drift fails the build — but it is a *test-lane*
   comparison rather than a build gate, and a phase that added a Leg state without running the engine
   lane would not see it. Worth considering for promotion to `npm run gates` if a later phase adds
   more such vocabulary.

3. **Six checks read evidence streams that no production code writes yet, and they say so rather than
   reporting a confident zero.** I5's fence-rejection counters read `Outbox.lastError`; I21's
   duplicate-application counter reads the same column for an agent-reported marker; I9's audit reads
   `outcome.chosenBindingPredicateId`; I13 reads `WorkQueue.roundsConsidered`; I14 reads
   `runnerUpAndTopN[].bindingPredicateId`; I17 reads `CalibrationObservation` rows with
   `predictor = ENERGY_SHORTFALL`. Every one of those columns exists and every query is real — a
   healthy world genuinely returns zero rows — but until the engine runs, "zero violations" for these
   six means "nothing has been written to look at". Each check names its instrument in its result, so
   the distinction is visible in the API response and in the stored row rather than only here.

4. **I3's SOFT-reservation arm depends on an injected set.** I18 forbids persisting SOFT reservations,
   so the leader's plan state is in coordinator memory and unreachable from a checker in another
   process. `context.softReservedLegIds` is the seam; its absence is recorded in the check's `detail`
   rather than assumed empty, so a `PLANNED` Leg held only in coordinator memory appears as a
   *counted-separately* `PLANNED` orphan rather than as a defect orphan or as nothing. Wiring the
   coordinator's plan state to the checker is a composition-root concern Phase 13 or Phase 15 owns.

5. **I16's continuous check is a corroboration, not the invariant's verification.** §26.1 verifies
   I16 by chaos test (§24.5), which is a build-time instrument. What runs continuously here is a
   double-grant scan — the production shadow of the same property — and the result says so rather
   than claiming to have verified I16. The chaos suite itself is Phase 15's.

6. **§21.4's metric registry was deliberately not rewired.** Phase 11 declares
   `degraded_mode_time`, `suspensions_over_time_box`, `stranding_events_by_obstruction_class`,
   `stranding_response_time`, `invariant_violations` and the three A3 dead-zone metrics with "Phase
   12" named as their producer, and those producers now exist. Wiring the queries is a change to
   `observability/metrics.js`, which the Phase 12 row does not list among its files to modify, and
   Phase 11's report frames the null readings as "a boundary, not a gap". The SLI those metrics most
   need — the invariant-violation count — is served by this phase's own surfaces
   (`invariantChecker.summarise()`, `InvariantStatus`, `GET /api/health/invariants`). Recorded here as
   the follow-up it is; §14 item 5.

7. **The escalation sweep runs in the invariant worker.** §18.6 step 5 is "continuous until cleared"
   and needs a loop; Phase 12 creates exactly one worker. The three passes are separate exported
   functions and the checker still writes nothing, so the independence property is not weakened — but
   a reviewer should confirm that reading rather than take it from this paragraph.
   `sweepEscalations: false` disables it independently.

8. **Migration not applied to a live database** (§5) — a deployment step, matching every phase since
   6.

## 14. Remaining Non-Blocking Issues

1. **Phase 11's principal finding is still open**: `tools/evaluator/counterfactual.js` is built and
   correct but invoked by nothing — no npm script, no CI step, no scheduled worker. Phase 11's
   verification recorded it as not blocking Phase 12, and it is not in Phase 12's path, but it should
   close before Phase 16 touches column generation.
2. **Phase 11's second finding is still open**: the shadow/production filter is applied to
   `DecisionRecordA` and not to `DecisionRecordB`. Not in Phase 12's path.
3. **Phase 9's verification finding is still open**, as Phases 10 and 11 also recorded:
   `taskAssignment.service.js` and `robotRegistry.service.js` still lack the "superseded banner only"
   header comment every prior phase applied to its own named-but-unmodified legacy files.
4. **`PHASE_0_INDEPENDENT_VERIFICATION.md` still does not exist**, as every review since Phase 1 has
   recorded.
5. **Phase 10's three verification findings remain open and untouched by this phase** — the
   `admission.js` queue-delay disclosure, the §9.6 requirement-3 tie-break scope, and the doubled
   `intake` object in the `POST /api/tasks/assign` response.
6. **Phase 11's `rejectionTelemetry.retainRow` hash weakness remains open** — the un-avalanched FNV-1a
   in a Phase 6 file that no production code calls.
7. **Prisma reports a major version update available (5.22.0 → 7.9.1).** Not evaluated or acted on — a
   major-version bump warrants its own review.
8. **`schema.prisma`'s line endings are now uniformly CRLF.** The file was already CRLF; the Phase 12
   append arrived as LF and was normalised in place. Git will convert on commit either way, and
   `prisma validate` is indifferent, but a reviewer diffing the file should know the normalisation
   happened.

## 15. Readiness for Independent Verification

**Ready.** Suggested focus, in priority order:

1. **The §26.2 matrix.** Independently re-derive a sample of the 132 cells from
   `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` §26.2 and check them against `modeRegister.MATRIX`. Then
   corrupt one cell and confirm `degradedModeRegister.test.js` catches it — the parse is doing the
   work only if it fails.
2. **The Invariant Checker's independence (§10, §13 item 2).** Is "imports one data module, writes
   nothing, reads no clock, re-declares its own state vocabulary" the right reading of §26.1's "a
   checker sharing logic with the enforcer verifies nothing"? The locally-declared vocabulary in
   particular is a judgement call, and the alternative — importing `legMachine.js` — is defensible.
3. **Whether each check actually verifies its invariant.** Twenty-two checks, each a query I wrote
   against the durable schema. §13 item 3 discloses six whose evidence streams are not yet written to.
   The four most worth challenging are I5 (a *rising baseline* rather than a non-zero count), I13
   (`roundsConsidered === 0` as the reading of "not progressing through the ladder"), I16 (a
   corroboration rather than the verification), and I21 (whose authoritative counter is agent-side).
4. **Step 4's human gate.** Verify independently that no argument to any exported function can place
   an emergency-services call without an operator identity, and that the schema CHECK would refuse a
   row if one somehow did.
5. **The chaos scenario.** Re-run it and confirm each of the plan's five clauses is genuinely
   exercised rather than asserted — particularly "agents halt at safe locations", which this phase
   verifies as *the bound being enforced on the agent* rather than by simulating the halt.
6. **The Custodial Operation two-step exit.** Confirm that no path restores I2 on the store
   returning alone, and that `mayResumeRounds()` is the only query a coordinator would need.
7. **The `commandDispatcher` seam.** Is passing `activeModes` in from the caller the right division —
   or should the service read the register itself? The argument for the seam is in §10; the argument
   against is that a caller can forget, and the drain worker is the only caller that must not.

---

*End of Phase 12 Implementation Report.*
