# Phase 12 — Independent Verification Report

**Role:** Independent Software Verification Engineer. Did not implement Phase 12.
**Scope:** `IMPLEMENTATION_EXECUTION_PLAN.md` Phase 12 ("Failure handling, degraded modes, invariant
checker", lines 626-653) and its checklist (lines 1238-1258); `NEXT_GENERATION_ASSIGNMENT_ENGINE.md`
§18 (Failure Handling, §18.1-§18.6) and §26 (Invariants Register, §26.1-§26.2) in full; cross-checked
against `PHASE_12_IMPLEMENTATION_REPORT.md` and against every prior implementation and independent
verification report (Phase 0-11) for continuity and non-leakage.
**Date:** 2026-08-07 · **Branch:** `feature/dashboard` · **Baseline:** Phase 11, independently
verified PASS WITH MINOR ISSUES (`PHASE_11_INDEPENDENT_VERIFICATION.md` — "Phase 12 may begin"),
uncommitted working tree on top of `cf9103f`.
**Method:** Full re-read of §18 and §26 verbatim, and of the Phase 12 execution-plan row and
checklist; independent re-execution of all three build gates and all three Jest lanes in this
reviewer's own shell; five parallel, independently scoped code-reading passes — one per functional
area (schema/migration; degraded-mode register and transitions; the Invariant Checker and its
independence properties; failure catalogues, obstruction classification, external escalation;
integration points and backward compatibility) — each of which read the actual source files in full
(not sampled), independently transcribed spec tables from the frozen document to cross-check the
code's own data structures, and, for the highest-risk properties, performed live tampering tests
(corrupt a matrix cell, neutralise a check's defect-detection logic, attempt to bypass the emergency-
services human gate) with the repository verified restored to a clean state afterward; this
reviewer's own direct re-derivation of the two most safety-relevant claims (the §26.2 matrix and the
step-4 human gate) from the source files and the frozen specification a second time, independent of
the five passes.

---

## 1. Phase 12 checklist completion

Independently re-verified against `IMPLEMENTATION_EXECUTION_PLAN.md`'s Phase 12 checklist (lines
1238-1258), item by item:

| # | Checklist item | Independent finding |
|---|---|---|
| 1 | Migration: `DegradedModeEvent`, `InvariantStatus`, `ExternalEscalation` | **Confirmed.** All three present in `schema.prisma` and `migration.sql` (20260807090000), field-for-field matching; additive-only (no `DROP`, no `ALTER COLUMN`, no `ALTER TABLE` on a pre-existing table — `Leg`'s only change is a back-relation adding no column); `npx prisma validate` re-run independently, passes. |
| 2 | `degraded/modeRegister.js` with all six named modes and the four governing rules | **Confirmed.** All six modes present with entry conditions, envelopes, `suspendsInvariants`, exit criteria matching §18.5's table verbatim. All four rules are live code assertions (`entryEvent()`/`exitEvent()` throw on missing mandatory fields; `suspensionsFor()` is unary; `assertNoCacheAuthority()` scans an enumerated forbidden-field list; a direction check requires reserve knobs to be multiplier parameters), independently read and quoted. |
| 3 | **Restricted Operation** (suspends no invariant) | **Confirmed.** `suspendsInvariants: []`, recorded rather than omitted. |
| 4 | **Custodial Operation** — no commits, no commands, I2 explicitly suspended, agents autonomous | **Confirmed.** The "no commands" refusal is enforced at `commandDispatcher.deliverOutboxCommand`, the single §10.3.1 command exit point; a real emit counter independently confirmed to stay at zero under the mode in the chaos test and to increment outside it. I2 = `S` in the matrix, independently cross-checked against §26.2's text. |
| 5 | **Unsupervised Commitment**, **Degraded Routing**, **Cold Index**, **Shed Load** | **Confirmed.** All four present with envelopes and exit criteria matching §18.5. |
| 6 | Verify no mode promotes the cache to an authority and none relaxes a class I or R constraint | **Confirmed**, and independently proven live: `transitions.js` was grepped in full for any cache-read call (`.get(`, `kv.`, `redis.`) — the only cache calls in the file are `kv.set` (the advisory publish); no read-back exists anywhere in the module. Reserve-knob direction is enforced by a regex requiring any `/reserve/i`-named envelope field to end in `MultiplierParameter`. |
| 7 | `failure/agentFailures.js` — A1-A20 | **Confirmed.** 20 entries present in the specification's own unusual order (A1..A17, **A20**, A18, A19), independently cross-checked by a test that parses §18.2's own markdown table and compares row order, not merely row membership. |
| 8 | Bounded dead-zone lease extension (p95, capped, corroborated exit) | **Confirmed.** The extension function requires a `P95` statistic and explicitly refuses `MEAN`/`NOMINAL` inputs by name; capped via `connectivity.max_deadzone_extension` (registered, default 300s) with an unresolved cap refused rather than defaulted; restoration requires `acceptedPositionFixOutsideZone === true` — the extension elapsing alone produces `UNCORROBORATED_EXPIRY` with `escalate: true`, not restoration. |
| 9 | `failure/infraFailures.js` — B1-B20 | **Confirmed.** 20 entries present in specification order (test-verified). B16's Tier-A-over-Tier-B buffer priority is a computed function output (`BUFFER_PRIORITY = ["TIER_A","TIER_B"]`), not a comment. B20's quarantine is a real threshold comparison (`crashCount >= threshold`, default 3, registered as `failure.poison_quarantine_threshold`). |
| 10 | `map/obstructionClass.js`; `INDETERMINATE` → `STRANDED_OBSTRUCTING` | **Confirmed.** Three independently distinct code paths (data absent/unavailable, an unrecognised class label, and data stale beyond `map.obstruction_class_max_age`) all route through the same `indeterminate()` closure to `STRANDED_OBSTRUCTING`. A10's lowest-reachable-class stop selection sorts by severity first and distance only as a tie-break (independently confirmed against a "far CLEAR beats near BLOCKING_CRITICAL" test case). |
| 11 | `failure/externalEscalation.js` — five steps, step 4 human-gated | **Confirmed**, and independently stress-tested — see §2 below, the review's principal focus. |
| 12 | `observability/invariantChecker.js` — independent of the enforcing code paths | **Confirmed**, with one qualification — see Finding 1. |
| 13 | All 22 invariant checks with `ENFORCED`/`VIOLATED`/`SUSPENDED` | **Confirmed.** All 22 (I1-I22) present; `assertEveryInvariantIsChecked()` independently confirmed to prove the join is total in both directions. Each check's query plausibly verifies its §26.1 "Verified by" column. A live tampering test (neutralising I1's violation-detection logic to always return `ENFORCED`) caused exactly one test to fail, and only the test governing I1 — confirming the defect-detection tests are real rather than incidental. |
| 14 | The §26.2 matrix — every invariant × every mode | **Confirmed by independent transcription.** This reviewer's agents independently transcribed 30+ cells directly from the frozen document's §26.2 table (including all cells the review specifically targeted: I2 `S` under Custodial, I4 `S` under Unsupervised, I1/I7/I8/I9/I17/I19 `E` in every column, I11/I13 `D` under Custodial, I20 `D` under Degraded Routing, I22 `D` under Restricted Operation and Degraded Routing) against `modeRegister.MATRIX` and found **zero mismatches**. The cross-check test genuinely parses the markdown table out of `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` by regex, not a hardcoded re-transcription — independently confirmed by reading the parsing code. A live tampering test (flipping I11's cell under Custodial Operation from `D` to `E` in the source) caused exactly the expected single-test failure with the exact expected diagnostic message; the file was then confirmed byte-identical to its original after revert. |
| 15 | Windowed monotonicity audit with persisted high-water mark (I6) | **Confirmed.** The Checker keeps its own mark on its own `InvariantStatus` rows rather than reusing `AgentFenceAudit.fenceHighWater` (which is written by the commit path itself — reusing it would verify self-consistency, not I6). Independently confirmed the write ordering: the worker loads the previous high-water mark, runs the check/comparison, and persists the new mark only afterward — a comment states the rationale and the code order matches it. |
| 16 | REST: `GET /api/health/invariants`, `GET /api/health/modes` | **Confirmed.** Both behind `authUser` middleware (not open). An invariant never checked reports `reported: false` rather than being silently absent (independently confirmed the endpoint iterates the canonical 22-invariant list, not merely the rows present in the table). Each row carries a `matchesMatrix` flag; disagreements are surfaced separately in a summary field. |
| 17 | Simulation: drive entry/exit of every mode; observed statuses match §26.2 exactly | **Confirmed.** `degradedTransitions.test.js` independently re-run: 62 tests pass (combined with the matrix cross-check suite), including a `test.each` over all six modes driving the real `transitions.enter()` → real `invariantChecker.checkAll()` → real `transitions.exit()` against a store, with planted defects giving suspensions something real to suspend. |
| 18 | Chaos: Commitment Store removed beyond the autonomy limit | **Confirmed**, all five of the plan's clauses independently traced: Custodial Operation entered via the catalogue-to-register join (not assumed); a real emit counter proves the command refusal is the mode's, not a broken dispatcher; I2 reports `SUSPENDED` with `summary.pageWorthy` false past the autonomy limit; the registered `agent.autonomous_continuation_limit` default of 900s is asserted; and exit is independently confirmed to require **both** `storeAvailable === true` **and** `reconciliationComplete === true` — the store returning alone is insufficient and `mayResumeRounds()` stays false until reconciliation completes. |
| 19 | Gate: invariant-violation SLI is zero in nominal operation; suspensions explicit, time-boxed, alertable | **Confirmed as far as a system with `ENGINE_ENABLED=false` can establish**, matching the report's own disclosed caveat (Known Limitation 1) rather than a claim to have observed production nominal operation. Not a defect — an honest scope statement. |

All 19 items are independently confirmed. Item 12 carries one qualification, not a contradiction —
detailed as Finding 1 below.

---

## 2. The step-4 human gate — independently stress-tested (principal safety-critical claim)

§18.6 makes contacting emergency services the one automated-response path in the entire failure-
handling design that is "deliberately human-gated", because "automatic calls to emergency services
are not an appropriate output of an allocation engine, and a false positive has real external cost."
This is the single highest-consequence property in Phase 12's scope, and it was verified past the
level the implementation report itself argues for.

Independently confirmed at three layers:

1. **Structural absence.** `AUTOMATIC_STEPS` (the array `openChain()` draws from) does not contain
   step 4, and `openChain()`'s returned step list is hardcoded to exactly three entries with no
   branch, flag, or configuration value that appends a fourth.
2. **A throwing guard on the only function capable of "contacting".** `confirmEmergencyServices()`
   throws a `TypeError` naming §18.6 explicitly whenever `operator.operatorId` is falsy, with no
   `force`/`auto`/override parameter in its signature.
3. **A database-level `CHECK` constraint** — `ExternalEscalation_step_four_is_human_gated`,
   independently read from the migration SQL — requiring `operatorId IS NOT NULL` whenever
   `step = 4`, enforced independent of any application code path.

A live tampering pass attempted seven distinct bypasses against the running module directly (empty
operator object, absent operator field, empty-string operator id, a `force`/`autoEscalate` context
smuggled into `openChain()`, an exhaustive check of every exported function for an escape hatch, and
a getter-based proxy attempting to defeat a naive truthiness check). **Every attempt was refused.**
No path was found by which step 4 can be produced or executed without a truthy `operator.operatorId`.

One minor robustness note, not a bypass: the guard's `!operator.operatorId` check would also reject a
literal numeric operator id of `0`, since `0` is falsy in JavaScript. This fails **closed** — it would
produce a spurious refusal, never an unauthorised call — so it is not a safety defect, only a
robustness nitpick worth a one-line fix (`operator.operatorId == null` or an explicit type check)
if operator ids are ever numeric.

---

## 3. Findings

| # | Severity | Category | Affected files | Recommendation |
|---|---|---|---|---|
| 1 | Minor | Architecture compliance — independence claim precision | `Backend/src/engine/observability/invariantChecker.js`, `Backend/tests/engine/invariantChecker.test.js` | The report claims the Checker "re-declares the §4.3 state vocabulary locally" and that `assertVocabularyAgreesWithDomain()` "compares the two at build time, so independence at runtime costs nothing in drift." This is fully true for `TERMINAL_LEG_STATES` and `RECOVERY_LEG_STATES`, both of which the test compares against genuine domain-module exports (`lifecycle/legMachine.js` and `supervision/leases.js` respectively). It is only partially true for `STRANDED_LEG_STATES`: `legMachine.js` exports no such list, so the test's comparison is checker-literal against a second, independent test-file literal, not checker-against-domain. There is no current drift to catch (the stranded-state pair is fixed by design), so this has no present functional consequence, but the "costs nothing in drift" claim is overstated for this one constant. Recommendation: either export `STRANDED_LEG_STATES` (or equivalent) from `legMachine.js` for the test to compare against, or narrow the report's own claim to the two constants it actually holds for. |
| 2 | Cosmetic | Documentation precision | `Backend/prisma/migrations/20260807090000_degraded_modes_failure_handling_invariants/migration.sql:11` | The file's own header comment states "the eight CHECK constraints at the foot of this file"; the actual count is ten CHECK constraints plus one partial unique index (eleven hand-written items total). `degradedSchema.test.js`'s own header and test name correctly say "ten." No functional effect — the test asserts against the real constraints, not the comment. Recommendation: fix the comment. |
| 3 | Cosmetic | Robustness, not a safety defect | `Backend/src/engine/failure/externalEscalation.js` (`confirmEmergencyServices`) | `!operator.operatorId` treats a literal numeric `0` as absent, which would wrongly refuse a legitimate all-numeric, zero-based operator id. Fails closed (over-refuses, never under-refuses), so this cannot produce an unauthorised call — see §2. Recommendation: use an explicit presence check (`operator.operatorId == null` or a type/length check) if operator ids are ever numeric; otherwise no action needed. |

No blocking issue was found. All three findings above are confined to documentation precision or a
single non-safety-relevant robustness nitpick; none touches a decision path, a commit path, the
degraded-mode matrix, or the human-gated escalation chain. This mirrors the pattern of every prior
phase's independent verification (Phase 0-11), each of which closed with minor/cosmetic findings
only.

**Items already disclosed by the implementation report and independently confirmed as accurately
described, not new findings:** the six invariant checks whose evidence streams are not yet written to
by production code (§13 item 3 of the implementation report — I5, I9, I13, I14, I17, I21's
supporting columns); I3's dependency on an injected `softReservedLegIds` set pending Phase 13/15
composition (§13 item 4); I16's continuous check being a corroboration rather than §26.1's actual
chaos-test verification instrument, and stated as such in both the code and the API response (§13
item 5); §21.4's metric registry not yet wired to Phase 12's new surfaces (§13 item 6); and the
seven Remaining Non-Blocking Issues carried forward from Phases 9-11 untouched by this phase (§14
items 1-8). All were independently spot-checked during this review and found to be accurately
disclosed, not misrepresented as complete.

Of the four invariant checks the implementation report itself flags as "most worth challenging" (I5,
I13, I16, I21), independent review agrees with the report's own framing on all four: I5 and I21 are
sound but genuinely dependent on plumbing outside this phase's scope; I13 is a defensible proxy over
the ladder's own progress counters rather than a direct read of ladder state; I16 is honestly and
explicitly labelled in both code and API output as a continuous corroboration rather than the
invariant's actual (chaos-test) verification instrument. None of the four is circular or tautological.

---

## 4. Execution-plan and architecture compliance

- **Files to modify / create** — independently confirmed to match the plan's Phase 12 row exactly:
  `commandDispatcher.service.js`, `supervision/leases.js`, `dtaro.handler.js`, `app.js`,
  `routes/index.js` modified; `degraded/modeRegister.js`, `transitions.js`, `failure/catalogue.js`,
  `agentFailures.js`, `infraFailures.js`, `externalEscalation.js`,
  `observability/invariantChecker.js`, `map/obstructionClass.js`, `workers/invariant.worker.js`
  created. The two REST-support files (`health.controller.js`, `health.routes.js`) are outside the
  plan's "Files to create" enumeration but inside its "REST API changes" row, and the report discloses
  this explicitly rather than silently exceeding the file list — accepted as reasonable.
- **Database migrations, Redis, Socket.IO, REST API** — each independently confirmed to match the
  plan's row: three tables; one new advisory Redis key (`engine:mode:{shard}`, confirmed never read
  back by the register itself); four Socket.IO events, all independently confirmed to be pure payload
  builders (`socketMessages()`-style functions) with **zero** `io.emit`/`socket.emit` calls in any
  Phase 12 module — no module takes a Socket.IO dependency, consistent with every engine worker since
  Phase 4; two new REST routes, both authenticated.
- **Module ownership** — `degraded/`, `failure/`, `map/` are asserted Tier 0 by Phase 0's path-prefix
  table; `observability/invariantChecker.js` and `workers/invariant.worker.js` are asserted Tier 1.
  Independently confirmed the tier-dependency gate re-run reports **251 modules, 333 edges, zero
  Tier 0/1 → Tier 2 violations** — identical to the report's claimed figures, from this reviewer's own
  shell, not copied from the report.
- **Dependency direction** — independently confirmed the Invariant Checker's only internal `require`
  is `degraded/modeRegister.js` (the matrix data, not enforcement logic); zero `create`/`update`/
  `upsert`/`delete` calls anywhere in the file (all writes are the worker's, from the checker's
  *returned* findings); zero `Date.now()`/`new Date()`-no-arg/`performance.now()` calls (time is
  always an explicit parameter).
- **T0-10, T0-11, T1-07** — independently confirmed in `Backend/src/engine/TIERS.md` (lines 64, 65,
  85) to name exactly the module paths Phase 12 created (`map/obstructionClass.js` +
  `failure/externalEscalation.js` for T0-10; `degraded/modeRegister.js` + `failure/catalogue.js` for
  T0-11; `observability/invariantChecker.js` + `workers/invariant.worker.js` for T1-07), confirming
  the report's claim that Phase 0's declaration is made *true* by this phase rather than newly written.
- **Concurrency** — no new lock or exclusivity mechanism; entry idempotence is the partial unique
  index `DegradedModeEvent_one_open_per_shard_mode`, independently confirmed to be a
  `CREATE UNIQUE INDEX ... WHERE "exitedAt" IS NULL`, not a CHECK constraint, matching the "concurrent
  close surfaced to the caller rather than swallowed" claim.
- **Determinism** — `modeRegister.js` and `obstructionClass.js` independently confirmed to evaluate
  time boxes and staleness against a supplied instant parameter in every call site read; the Checker
  is clock-free by grep, confirmed above.
- **Failure handling (§18 in full)** — independently confirmed complete: five principles as live
  assertions in `catalogue.js`; A1-A20 and B1-B20 both present, in the specification's own row order,
  cross-checked by tests that parse the markdown tables directly rather than a hardcoded
  re-transcription; A2's custody-aware exception correctly delegates to
  `supervision/leases.assessRecovery`, independently read and confirmed to implement three named
  §4.7 outcomes (`RESUME`, `TRANSFER`, `PHYSICAL_RECOVERY` as an explicit default) rather than a stub.
- **Regression safety** — independently re-run: **legacy lane 169/169**, identical to the Phase 10/11
  baseline; **full suite 106 suites / 5,373 tests / 0 failures**, matching the report's figures
  exactly from this reviewer's own execution. Diffs of all five modified files independently reviewed
  against `cf9103f`: `dtaro.handler.js`'s change is purely additive (the pre-existing DB write, Event
  row, and ACK are outside the diff entirely); `app.js`'s `/health` `degraded` block is best-effort
  (returns `null` on read failure, confirmed by test) and a summary only (confirmed by a test that
  asserts the entry *cause* does not appear in the response body); `deliverOutboxCommand`'s new 4th
  parameter defaults to `{}` and no 3-arg call site exists anywhere in the tree to contradict backward
  compatibility; `outboxDeliveryArm` independently confirmed to re-invoke a supplied mode-reader
  function per row (not a value captured once at bind time), via a test that mutates the active-mode
  set between two calls through the same arm and observes the outcome flip.
- **Schema-boundary test edits** (`commitmentSchema.test.js`, `costSchema.test.js`,
  `observabilitySchema.test.js`) — independently reviewed for the specific risk that a self-authored
  boundary-test edit could quietly weaken a gate. **No weakened assertion was found**: every boundary
  narrowing (old forbidden-table lists shrinking) is matched by a newly added, exact-match
  presence test for the tables that moved from "forbidden" to "owned"; the one non-boundary diff
  found (`domainSchema.test.js`'s regex fix for Prisma's actual whitespace in `ADD COLUMN` output)
  makes an existing check *stricter*, not weaker.
- **Build gates** — independently re-run in this reviewer's own shell, exact match to the report:
  tier-dependencies PASS (251/333/0), parameter-register PASS (161/217/0 bare constants),
  tenets PASS (248/0).
- **Test suite** — independently re-run, exact match: 106 suites, 5,373 tests, 0 failures.
- **Phase 13 non-leakage** — independently confirmed by direct filesystem inspection
  (`src/engine/shard/` contains only `leadership.js` and `planState.js`; `src/engine/fairness/`
  contains no `.js` files) and by a full-tree grep for `shard/election`, `shard/failover`,
  `shard/membership`, `shard/sizing`, `shard/crossRegion`, `shardSupervisor`, `ShardMembership`,
  `CrossRegionSaga`, `TransferPoint` — every hit is either a pre-existing (pre-`cf9103f`) forward
  reference in `TIERS.md`/`tierAssertions.js` documentation or a Phase-12 catalogue row's prose
  pointer to where the *future* B13/B14 handling belongs (`infraFailures.js`'s
  `implementedBy: "Phase 13 — shard/failover.js"` field), never an actual implementation. No
  `model Shard`, `ShardMembership`, `CrossRegionSaga`, or `TransferPoint` exists in `schema.prisma`.
  **Confirmed: nothing from Phase 13 has been implemented.**
- **Runtime behaviour with the engine off** — independently confirmed `ENGINE_ENABLED` remains the
  governing flag and `invariant.worker.js` is referenced by no file except its own module, its own
  test, `health.controller.js`, `modeRegister.js`, and `tierAssertions.js` — never by `server.js` or
  `app.js`'s startup path.

---

## Final decision

# PASS WITH MINOR ISSUES

Three findings, all minor or cosmetic: an overstated (but currently harmless) drift-detection claim
for one of three locally-declared state-vocabulary constants (Finding 1); a stale constraint count in
a migration file's header comment (Finding 2); and a fails-closed robustness nitpick in the emergency-
services operator-id check that could produce a spurious refusal but never an unauthorised bypass
(Finding 3). None is a decision-path, commitment, dispatch, supervision, or degraded-mode-matrix
defect. None weakens any invariant Phase 12 is responsible for (I2, I3, I6, I16, I22, and the general
Checker infrastructure for all 22). None touches the step-4 human gate, which was independently
stress-tested past seven distinct bypass attempts and held in every case.

Independently confirmed, by direct code inspection, a full-tree grep for every named Phase-13
artifact, and re-execution of the schema/module-ownership tests: **nothing from Phase 13 has been
implemented ahead of schedule.**

**Phase 13 may begin.**

---

*End of Phase 12 Independent Verification Report.*
