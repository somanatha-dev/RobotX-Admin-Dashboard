# Phase 11 — Implementation Report

**Role:** Senior Distributed Systems Engineer implementing the frozen architecture
**Scope:** `IMPLEMENTATION_EXECUTION_PLAN.md` §3 "PHASE 11 — Observability, decision records,
explainability", implementing `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` §21 in full, together with
§20.1's release-gate targets and §24.3's determinism-and-replay gates
**Date:** 2026-08-06 · **Branch:** `feature/dashboard` · **Baseline:** Phase 10, independently
verified ("PASS WITH MINOR ISSUES" — `PHASE_10_INDEPENDENT_VERIFICATION.md` — "**Phase 11 may
begin**"), uncommitted on top of `cf9103f`
**Phase 12 or later:** not implemented. `src/engine/degraded/`, `failure/`, `map/`, and
`fairness/` remain empty; no `invariantChecker.js`, no `DegradedModeEvent`, `InvariantStatus`, or
`ExternalEscalation` table.

---

## 1. Executive Summary

Phase 11 delivers §21 of the frozen architecture — the two-tier Decision Record with its
deterministic sampler and **bounded** exemption list (§21.2), the Explanation API with
`TIER_A` / `TIER_B` / `RECONSTRUCTED` source labelling (§21.3), the full metric set across all
seven groups (§21.4), the prediction-calibration loop with a different instrument per shortfall
tier (§21.5), shadow mode and the offline counterfactual evaluator with its release gate (§21.6),
and the hash-chained audit stream with log-volume discipline (§21.7) — together with §20.1's
release-gate targets and §24.3's reconstruction-equivalence and golden-replay-corpus gates.

Ten new engine modules, two tools, four background workers (unscheduled, per the convention every
worker since Phase 4 has followed), one REST route, four new Prisma models plus nine additive
columns on `DecisionRecordA`, twenty-three new registered parameters, and ten new test files
(**214 tests**). Five existing files were rewired: `metrics.service.js`, `app.js`, `logger.js`,
`routes/index.js`, and `coordinator.worker.js`.

`npm run verify` (all three build gates, then all three Jest lanes) is green: **97 suites, 5,132
tests, 0 failures.** The legacy lane is unchanged at **169/169** — Phase 10's own baseline —
confirming zero behavioural regression in the path Phase 15's cutover has not yet reached.

**Three findings surfaced from this phase's own tests rather than from inspection**, and each is
recorded rather than smoothed over:

1. **A measured sampling defect, fixed.** The deterministic Tier B draw was asymptotically
   uniform but avalanched weakly on short, nearly-identical inputs: over 200 sequentially
   numbered decision ids — *the shape of one round's batch* — a 10 % rate retained **zero**. A
   MurmurHash3 `fmix32` avalanche step now redistributes; the same batch retains 19–20. §11 and
   §13 give the numbers.
2. **A production/shadow leak, fixed.** `metrics.js` queried `DecisionRecordA` without the
   shadow filter, so §21.6 shadow decisions — "recorded and never executed" — would have entered
   the SLIs. Caught by a source-scanning test written for exactly that class of mistake.
3. **The §20.1 2 KB Tier A bound is exceeded, and is reported rather than asserted away.** A
   fully populated §21.2 record serialised as self-describing canonical JSON measures ~2.3–2.7 KB
   against `< 2 KB`. The load-bearing property — `O(1)` in candidate count — holds strictly (196
   extra candidates cost under 100 bytes). §13 item 1 states the arithmetic, what was trimmed,
   and what closing it would cost.

**Two counting discrepancies between the execution plan and the specification were resolved by
the plan's own §0.1 rule** ("*Where this plan and the specification appear to disagree, the
specification wins and this plan is defective*"): §21.3 states **eight** queries where the plan's
checklist says seven, and §21.4 states **seven** metric groups where the checklist says six. All
eight and all seven are implemented. Neither is an architectural ambiguity — the plan states the
tie-break itself — so neither warranted a stop.

---

## 2. Objectives Achieved

Cross-referencing `IMPLEMENTATION_EXECUTION_PLAN.md`'s Phase 11 checklist (§7, lines 1217–1236)
item by item:

| # | Checklist item | Status |
|---|---|---|
| 1 | Migration: `DecisionRecordA`, `DecisionRecordB`, `InputSnapshot`, `CalibrationObservation`, `AuditEvent` | **Done** — §5 |
| 2 | Tier A with every §21.2 section incl. leadership fence, regime, kill-switch state, Ω values, both gaps | **Done** — all 14 sections, asserted against one list |
| 3 | Verify Tier A is `O(1)` in candidate count and ≤ 2 KB per decision | **`O(1)` done and proved; the 2 KB bound is missed and reported** — §13 item 1 |
| 4 | Tier B with deterministic sampling seeded from the decision id | **Done** — and a real distribution defect found and fixed (§11) |
| 5 | The **bounded** exemption list — shard-wide degradation at mode level, not per decision | **Done** — bounded by *scope*, by *budget*, and by a schema CHECK |
| 6 | `tier_b_write_budget` with reservoir fallback and counted shedding | **Done** — bottom-k reservoir, order-independent; shedding counted **and** audited |
| 7 | `tools/replay/replayDecision.js` | **Done** |
| 8 | `observability/explanation.js` with `TIER_A` / `TIER_B` / `RECONSTRUCTED` labelling | **Done** — source is mandatory on every answer; `answerOf()` throws without one |
| 9 | REST `GET /api/explain/:decisionId` answering all seven §21.3 queries incl. the deferral query | **Done, with eight** — §7 |
| 10 | The full §21.4 metric set across all six groups | **Done, with seven groups / 83 metrics** — §7 |
| 11 | `observability/calibration.js` — bias, dispersion, probabilistic calibration per tier at its own timescale | **Done** — T3 *refuses* to compute an event frequency |
| 12 | `observability/shadow.js` | **Done** — "never executed" enforced three ways, none of them a convention |
| 13 | `tools/evaluator/counterfactual.js`, wired as a release gate for column-generation changes | **Done** — fails closed on an unmeasured change; budget changes are gated |
| 14 | Log-volume discipline: per-candidate detail leaves the log stream | **Done** — the logger *refuses* a candidate array outside production |
| 15 | The hash-chained audit stream | **Done** — `observability/auditStream.js` (§3, disclosed as beyond the plan's file list) |
| 16 | **Build gate:** reconstruction-equivalence — Tier A alone reproduces Tier B byte for byte | **Done** — and the gate is proved to fail on five kinds of planted divergence |
| 17 | Golden replay corpus on every build; continuous production replay on a sample | **Done** — 3-entry corpus incl. a milli-CU value past float precision; `replaySample()` |
| 18 | **Gate:** aggregate SLIs exact over 100 % of decisions despite Tier B sampling | **Done** — proved by writing the same round at 0 % and 100 % sampling and comparing histograms |

---

## 3. Files Created

**Engine modules (`Backend/src/engine/observability/`):**

| File | Lines | Purpose |
|---|---|---|
| `tierA.js` | 683 | §21.2 — the compact record: all 14 sections, the `O(1)` proof, §20.1 sizing, row mapping |
| `explanation.js` | 644 | §21.3 — the eight queries, exact sensitivity, mandatory source labelling |
| `metrics.js` | 630 | §21.4 — 83 metrics across seven groups, derived from the durable record |
| `decisionRecord.js` | 540 | The single writer: snapshot → Tier A per Leg → Tier B where selected; retention ordering |
| `sampling.js` | 523 | §21.2 — the deterministic draw, the bounded exemption list, the write budget, the bottom-k reservoir |
| `sli.js` | 518 | §20.1 — the 20 release-gate targets incl. the two p99.9s; the advisory `engine:sli:*` registry |
| `calibration.js` | 459 | §21.5 — bias, dispersion, per-tier probabilistic calibration, drift alarms |
| `tierB.js` | 335 | §21.2 — the four full-fidelity sections; a pure function with a content digest |
| `auditStream.js` | 285 | §21.7 — the hash-chained, append-only, gap-detecting audit stream |
| `shadow.js` | 255 | §21.6 — shadow mode, with a structural refusal to execute |

**Tools:** `tools/replay/replayDecision.js` (458) — replay, the reconstruction-equivalence gate,
the golden corpus, continuous production replay, and the §24.3 snapshot-retention audit;
`tools/evaluator/counterfactual.js` (332) — the four relaxations and the column-generation
release gate.

**Workers (all unscheduled):** `tierB.worker.js` (206), `shadow.worker.js` (219),
`calibration.worker.js` (200), `counterfactual.worker.js` (184).

**REST:** `src/controllers/explain.controller.js` (173), `src/routes/explain.routes.js` (22).

**Migration:** `prisma/migrations/20260806090000_decision_records_and_observability/migration.sql`
(270 lines).

**Golden corpus:** `tests/fixtures/replayCorpus/{assigned-three-candidates,no-feasible-candidate,large-milli-cu}.json`.

**Tests (`Backend/tests/engine/`):** `observabilitySchema`, `observabilityDecisionRecord`,
`observabilitySampling`, `observabilityExplanation`, `observabilityMetrics`,
`observabilityCalibration`, `observabilityShadowAudit`, `reconstructionEquivalence`,
`observabilityCounterfactual`, `explainApi` — **214 tests**.

**One file created beyond the plan's enumerated list, and why.** The plan's "Files to create" row
names nine `observability/*` modules and does not name a home for checklist item 15, "Implement
the hash-chained audit stream". `auditStream.js` is that home. Putting it inside
`decisionRecord.js` would have merged two concerns the specification separates explicitly —
§21.7 calls the audit stream "separate", and the separation is not filing: a decision record may
be *reconstructed by replay* (§21.2) and an audit event may not be reconstructed by anything,
because the thing it attests to is exactly the human action no deterministic function reproduces.

## 4. Files Modified

| File | Change |
|---|---|
| `Backend/prisma/schema.prisma` | `DecisionRecordA` completed (9 additive columns, 3 indexes, 1 relation); `DecisionRecordB`, `InputSnapshot`, `CalibrationObservation`, `AuditEvent` added |
| `Backend/src/engine/config/register/supplementary.json` | 23 new entries — 18 `perf.*` §20.1 targets, 4 observability/calibration, 1 reservoir size. Purely additive; no existing entry touched |
| `Backend/src/services/metrics.service.js` | `getEngineMetrics` and `getSliSummary` added beside the legacy pair, which is unchanged |
| `Backend/src/app.js` | `/health` gains an `sli` block — the summary, deliberately not the full derivation |
| `Backend/src/config/logger.js` | §21.7 — `logger.round()`, `logger.anomaly()`, `TRACE_FIELDS`, and the log-volume refusal. `logger.dtaro` untouched |
| `Backend/src/routes/index.js` | `/api/explain` mounted |
| `Backend/src/workers/coordinator.worker.js` | `recordRound` delegates its per-Leg loop to `decisionRecord.writeRound` — see §10 |
| `Backend/tests/mocks/silentLogger.js` | Carries the new emitters, delegating to the *real* discipline so a test cannot pass against a payload production would refuse |
| `Backend/tests/engine/phase0Scaffold.test.js` | `PHASE_11_OWNED = ["observability/"]` added to the cumulative ownership walk |
| `Backend/tests/engine/commitmentSchema.test.js` | Boundary moved to Phase 12; Phase 11's four tables asserted present |
| `Backend/tests/engine/costSchema.test.js` | Same boundary move |
| `Backend/tests/engine/domainSchema.test.js` | Two latent defects in Phase 2's own later-migration subtraction, fixed — see §10 |
| `Backend/tests/engine/helpers/roundFixture.js` | `memoryPrisma` extended with the four new tables and two missing `groupBy`s |

No file outside these lists was touched. In particular `src/engine/TIERS.md`,
`guards/tierAssertions.js`, `guards/tenets.js`, and `config/validators.js` were **not** modified —
§10 states why each was unnecessary.

---

## 5. Database Changes

Additive only. No `DROP`, no `ALTER COLUMN`; every `ALTER TABLE` in the file only adds.

**`DecisionRecordA` completed** with nine columns: `inputSnapshotId` (FK → `InputSnapshot`,
`SetNull`), `fullRetentionUntil`, `sizeBytes`, `tierBWritten`, `tierBReason`, `samplingDraw`,
`samplingRate`, `shadowLabel`, plus three indexes.

Two of those deserve a word. `inputSnapshotId` is a **relation** rather than only the pre-existing
JSON reference, because §24.3's snapshot-retention check is "a decision whose Tier A record is
retained but whose input snapshot has expired" — expressed as a foreign key that audit is a join,
and expressed only as a JSON blob it is a table scan nobody runs. It is `SetNull` and never
`Cascade`: an expired snapshot must leave its decision record standing and *visibly* unreplayable,
because deleting the record would erase the evidence of the defect.

`shadowLabel` is a discriminator rather than a second table, so a §21.6 shadow decision is the
*same shape* as the production one it is compared against — an agreement report between two
differently-shaped records would be comparing the schemas as much as the decisions.

**`DecisionRecordB`** — the four §21.2 sections, `writtenBecause` (SAMPLED · EXEMPT · RESERVOIR),
`exemptionReason`, `contentHash` (the digest §24.3's gate compares), `sizeBytes`, `retainUntil`.

**`InputSnapshot`** — immutable and content-addressed: no `updatedAt`, and nothing updates a row.
One per round, referenced by every decision record of that round, because the pinning is a
property of the round (§9.6) and duplicating it per decision would make "same inputs" a comparison
rather than an identity.

**`CalibrationObservation`** — §21.5's slices as columns rather than as a JSON blob, because
"drift alarms per slice" means the slice is a `GROUP BY`, and a dimension inside JSON is a
dimension nobody groups by. Carries `tailQuantile` beside `eventOccurred` so T3 can be scored by
its own instrument.

**`AuditEvent`** — hash-chained, with a **dense** `sequence` unique per stream. Two properties,
because neither alone catches both attacks: the chain catches an *edit*, the dense sequence
catches a *removal*.

**Seven hand-written CHECK constraints Prisma cannot express:**
`DecisionRecordB_written_because_known`, `DecisionRecordA_tier_b_reason_present`,
`DecisionRecordA_size_non_negative`, `CalibrationObservation_predictor_known`,
`CalibrationObservation_probability_in_unit_interval`, `AuditEvent_event_type_known`,
`AuditEvent_sequence_non_negative`.

The second is the schema's own backstop for the bounded exemption list: a Tier B written with no
stated reason is precisely the unbounded exemption §21.2 identifies as the failure that "converts
to full retention across the entire shard at exactly the moment volume spikes hardest". Requiring
the reason at the schema means a future writer cannot reintroduce it by forgetting a field.

Every `CREATE TABLE` / `CREATE INDEX` / `ADD CONSTRAINT … FOREIGN KEY` was taken verbatim from
`prisma migrate diff --from-empty --to-schema-datamodel`;
`tests/engine/observabilitySchema.test.js` re-runs that diff, asserts byte equality modulo
whitespace, and asserts the seven CHECKs are **absent** from Prisma's output — which is what
proves they are genuine hand-written additions rather than an echo.

**Not applied to a live database**, consistent with every phase since 6. `npx prisma validate`
succeeds; `prisma migrate diff --from-empty` needs no connection and was used instead.

---

## 6. Runtime Behaviour

`ENGINE_ENABLED` remains `false`. None of the four new workers is started from `server.js` or
`src/app.js` — asserted mechanically, not by inspection.

**With the engine off**, the only reachable change is `/health`'s new `sli` block, which is
best-effort and returns `null` if the SLI tier cannot be read. The 169-test legacy lane is
unchanged.

**With the engine on**, a round now records as follows:

```
  InputSnapshot (once, upsert)  →  DecisionRecordA (per Leg)  →  DecisionRecordB (selected only)
```

Two orderings are load-bearing and stated in the writer rather than left implicit:

- **The snapshot first.** §24.3 makes "a Tier A record retained but its input snapshot expired" a
  defect; a Tier A row written before its snapshot exists *is* that defect at time zero, and it is
  the state the record can never recover from — the inputs are gone by then. Writing the snapshot
  first means a crash between the two leaves an orphan snapshot, which costs storage and nothing
  else.
- **Tier B last.** It is the only one of the three that may legitimately not be written. A failure
  there degrades an explanation from `TIER_B` to `RECONSTRUCTED`; a failure in either of the other
  two loses the decision.

**The sampling decision is taken once**, from the decision id, and recorded with the record
(`samplingDraw`, `samplingRate`). A coordinator that built its own record and a writer that built
another would give the two a chance to disagree about which decisions were sampled, and §24.3's
gate would then be comparing populations rather than content.

**Determinism.** `sampling.js` reads no clock and no random source — asserted by source scan as
well as by construction. `tierB.build()` is a pure function of a round result, and
`round.plan()` is a pure function of the pinned inputs, so the composition is a pure function of
Tier A. The reconstruction-equivalence property is therefore a theorem about two pure functions
rather than a property maintained by care.

---

## 7. API Changes

**New: `GET /api/explain/:decisionId`** — the only new endpoint, matching the plan's row exactly.
Behind the same `authUser` middleware and rate limiter every authenticated read since Phase 5 has
used. Read-only: an endpoint that could amend a decision record would destroy the non-repudiation
the record exists for.

```
GET /api/explain/:decisionId?query=<one of eight>&agentId=<required by why_not_agent>
GET /api/explain/queries          — the self-describing index
```

The response carries `answers[]` (each with a mandatory `source`), a `sources` roll-up feeding
§21.4's "Explanation API answers served by source", and a `record` block stating retention and
reconstruction state up front — including, when the input snapshot has expired, that this is the
§24.3 **defect** rather than a capacity signal.

**Eight queries, not seven.** §21.3's table has eight rows; the plan's checklist lists seven,
omitting *"why did this task go to a distant agent?"*. The plan's §0.1 settles it. Answering
eight satisfies "all seven" on any reading of which seven were meant.

Omitting `?query=` returns every answer except `why_not_agent`, which is **skipped rather than
guessed** when no agent is named.

**`/health` gains an `sli` block** (§21.4, §20.1): target inventory, how many are measured, how
many are breached, and — separately — any **safety-window** breach, because §20.1 singles out two
targets that bound windows rather than describing latency, and a breach of either is a different
fact from a slow p99. Deliberately the *summary* and not the full §21.4 derivation: `/health` is
polled on a short interval, and running the metric set there would put its cost on the
availability path.

**No existing endpoint's behaviour, response shape, or route changed.**

---

## 8. Redis Changes

Two new advisory keys, both in the namespace §21.2 reserves:

- `engine:sli:{shard}:{instance}` — one process's counter/gauge/histogram snapshot, with a TTL.
- `engine:sli:instances:{shard}` — the instance set, so a reader can merge across processes.

**No decision data in Redis** — the Decision Log is durable and append-only (§3.3). Every read and
write is wrapped; a failure loses visibility and never correctness, and no engine decision reads
one back. Only the existing `kv` primitives (`set`, `sadd`, `smembers`, `mget`) are used; **no new
`kv` capability was added**, matching Phase 10's disposition.

Two quantities are explicitly excluded from this tier and say so in the source: §7.7's
binding-constraint distribution (exact over 100 % of decisions, folded into `RejectionAggregate`
at decision time) and §26's invariant-violation count (produced by a checker that must run
independently of the enforcing paths — a checker reading a counter written by the enforcer
verifies nothing).

## 9. Socket.IO Changes

**None.** The plan's Phase 11 row specifies none, and none was added.

---

## 10. Architecture Compliance

**Tier placement.** Every Phase 11 module lands at **Tier 1** (T1-03, "The Tier A decision record
and the Explanation API"). `TIERS.md`'s T1-03 row already names `observability/decisionRecord.js`,
`controllers/explain.controller.js`, and `routes/explain.routes.js`; the remaining modules fall to
the existing `["src/engine/", TIER.OPERATIONAL_INTEGRITY]` and `["src/workers/", …]` catch-alls,
so **no new `MODULE_TIERS` row was needed and none was added** — the same disposition Phase 10
recorded. The tier gate confirms mechanically: 240 modules, 318 governed import edges, zero
Tier 0/1 → Tier 2 edges.

**The three sections §21.2 puts in Tier A specifically so they are never sampled away** are each
implemented as unconditional: the deferral reason (§8.8 — "the decision most often challenged"),
the rejection histogram (§7.7 — aggregated at decision time, exact over 100 % of decisions), and
the kill-switch state (§22.5 rule 4 — "a thrown switch that is not recorded would silently break
replay determinism").

**The exemption bound is enforced three ways, none of which is "the caller remembers".** By
**scope** — `classifyExemption()` admits only `DEGRADATION_SCOPE.DECISION`, and refuses a
`SHARD` degradation with the reason stated. By **budget** — exempt writes draw on
`observability.tier_b_write_budget` per shard per minute, with a reservoir and counted shedding
past it. And by **schema** — `DecisionRecordA_tier_b_reason_present`. The refusal is by scope and
not by counting, because a scheme that admitted shard-wide degradations and then capped the
resulting volume would still have converted the sample into "whatever arrived first", which is
the failure mode.

**The reservoir is bottom-k over the deterministic draw, not Algorithm R.** §21.2 requires it to be
"uniform over the exempt population". The textbook reservoir needs a fresh random number per
candidate, which the decision path prohibits (T6, §9.6 requirement 7), and its content depends on
arrival order. Bottom-k over `draw(decisionId)` is uniform by the uniformity of the hash, needs no
randomness beyond the draw already computed, and is **order-independent** — which is what makes a
shed episode reproducible after the fact rather than a story about scheduling. Tested by filling
the same reservoir forwards and backwards and comparing.

**T3 refuses to be scored by an event count, and that refusal is the deliverable.** §21.5 is
categorical: T3 is validated "from the *predictive distribution's tail calibration* rather than
from event counts", and "validating a 1e-7 target by counting its occurrences is a category
error". `probabilisticCalibration()` returns a Kolmogorov–Smirnov distance from uniform and an
upper-decile excess for T3, and sets `observedFrequencyDeliberatelyNotComputed`. The calibration
worker publishes a frequency gauge only for the tiers whose instrument is an event count. An
implementation that silently counted T3 events would produce a confident "0 observed, 0 expected,
within budget" for a target it has no power to test — worse than no answer.

**"Never executed" is structural in shadow mode.** `shadow.run()` calls `round.plan()`, which
§3.1 makes side-effect-free, and never `round.execute()`, the only function in that module that
crosses into L3 — the shadow path does not contain the crossing. `assertNoEffects()` throws on a
dependency bundle carrying `commit`, `dispatch`, `outbox`, `record`, `planState`, `emit`, or
`publish`. And its records are marked in two independent places, the `shadow:` decision-id prefix
and the `shadowLabel` column, so no `Commitment.decisionRef` can ever resolve to one.

**Sensitivity is exact rather than sampled.** For an additive objective the flip margin is a
subtraction: the chosen candidate loses as soon as its total rises by `γ(runner-up) − γ(chosen)`,
and because `Φ` is a sum, *any single term* rising by that amount does it. No search, no
perturbation, no local linearisation. A rejected candidate's lever is its binding predicate and
never a price — reporting a cost sensitivity for a candidate the gate never admitted would be
arithmetic about an ineligible pairing (T1, I14).

**Metrics are derived from the durable record rather than instrumented at the call site.** Three
consequences, stated in the module: it needs no edit to `commitment/`, `dispatch/`,
`supervision/`, or `solve/` (Phase 11's mandate is to modify only what Phase 11 needs); it cannot
double-count on retry (a counter incremented in a transaction that later aborts has counted
something that did not happen, a `GROUP BY` over committed rows has not); and it is replayable.
A metric whose producer has not landed reports `null` **with the producer named**, never zero — a
metric reporting zero because nothing feeds it is indistinguishable from a system that is
behaving, which is the failure mode an observability phase is least entitled to ship.

**Why `coordinator.worker.js` was modified, and what changed.** Phase 10 assembled a *partial*
Tier A record inline and disclosed it as partial. Phase 11 owns the complete shape, and the
per-Leg loop now delegates to `decisionRecord.writeRound`. The delegation matters beyond
tidiness: §21.2 requires the sampling draw to be taken once and recorded with the record, and two
independent builders would give them a chance to disagree about which decisions were sampled. The
`Round` row stays in the coordinator — it is the round's own entity (§9), not a decision record,
and Phase 10 owns it.

**Two latent defects in Phase 2's own test, fixed rather than worked around.**
`domainSchema.test.js` carries a mechanism that subtracts later-added columns from its
generated-SQL comparison, so the test does not "re-baseline itself out of existence" on every
additive change. Its regex required a *single* space in `ADD COLUMN "x"`, but Prisma's own
generated style — which every migration in this tree copies — uses five, so the subtraction had
never matched anything and was silently inert. Phase 11 is the first later migration to add a
column to a table Phase 2 creates, which is why it surfaced now. The same mechanism had no
equivalent for indexes or constraints, which a later-added FK column always brings with it. Both
are fixed in place, with the reasoning recorded in the test. The alternative — excluding
`DecisionRecordA` from the comparison — would have weakened a Phase 2 guarantee to make a Phase 11
change fit.

**Files deliberately not modified.** `TIERS.md` needed no new row (T1-03 exists and covers this
phase). `guards/tierAssertions.js` needed no new entry (the catch-alls resolve every new module
correctly, asserted). `guards/tenets.js` was not extended to cover `observability/` under T6:
those modules legitimately read clocks (SLIs, workers), and the one that must not — `sampling.js`
— is asserted clock-free and randomness-free by a source scan in this phase's own tests, matching
how Phase 10 scanned `solve/`. `config/validators.js` needed no new rule: V6 already validates the
snapshot-retention ordering §21.2 requires, and `decisionRecord.retentionFor()` refuses the same
pair a second time so a defect in the resolution path cannot produce it either.

**The 23 new register entries, and why each was needed.** §20.1 calls its table "requirements for
the release gate, not aspirations", and a release-gate threshold is a threshold — §22.1 rule 1
admits no exception for the ones that only decide whether a build ships. The precedent is already
in the register: `route.cell_pair_min_hit_rate` and `route.charger_reachability_min_hit_rate` are
§20.3 monitoring targets registered by Phase 7/8. So the 18 `perf.*` entries carry §20.1's table.
The remaining five are inputs a §21 mechanism reads and Appendix A does not tabulate:
`observability.tier_b_reservoir_size` (a reservoir needs a size),
`observability.calibration_bias_alarm` (seeded at §21.5's own worked example of 20 %),
`observability.calibration_min_samples`, and `observability.calibration_tier_window` (a map keyed
by the three §14.5 tiers, seeded at a week, a quarter, and a fleet-year, exactly as §21.5
describes the three timescales).

---

## 11. Test Results

`npm run verify` (all three build gates, then all three Jest lanes):

```
gate: tier-dependencies (§1.8 rule 2)      PASS — 240 modules, 318 edges, 0 violations
gate: parameter-register (§22, Appendix A) PASS — 153 modules, 210 registered params, 0 bare constants
gate: tenets (T1 type separation, T6)      PASS — 237 modules, 0 violations

Test Suites: 97 passed, 97 total
Tests:       5132 passed, 5132 total
```

By lane:

- **engine**: 72 suites (62 pre-existing + **10 new**), **4,914 tests**. Phase 11's own ten files
  contribute **214**.
- **legacy**: **169/169**, unchanged from Phase 10's reported baseline — zero behavioural
  regression in the legacy dispatcher.
- **gates**: **49/49**, unchanged.

**The plan's named testing requirements, and where each is discharged:**

| Requirement | Where |
|---|---|
| **Reconstruction-equivalence build gate** — Tier A alone reproduces Tier B byte for byte | `reconstructionEquivalence.test.js` — the gate, plus **five** planted divergences it must catch, plus a CLI exit-code check |
| Golden replay corpus on every build | `reconstructionEquivalence.test.js` — 3 entries incl. `9007199254740993` milli-CU, past float precision |
| Continuous production replay on a sample | `replaySample()` — samples with the *same* deterministic draw, so which decisions were checked is itself auditable; a divergence is marked release-blocking |
| Sizing: Tier A `O(1)` in candidate count | `observabilityDecisionRecord.test.js` — 200 vs 2,000 candidates differ in `runnerUpAndTopN` alone, growth ≤ 4 bytes |
| Sizing: Tier A ≤ 2 KB per decision | Measured at 2,373–2,693 bytes and **reported as exceeded** — §13 item 1 |
| Aggregation exact over 100 % of decisions despite Tier B sampling | `observabilityDecisionRecord.test.js` — the same round written at 0 % and 100 % sampling; histograms byte-identical |
| Exemption bound: a shard-wide mode does **not** convert to full retention | `observabilitySampling.test.js` — refused by scope, with the mode-level record returned instead |

**Three real findings, all from this suite rather than from review.**

1. **The sampling distribution defect.** `replaySample`'s test asked for a 10 % sample of 200
   sequentially numbered decision ids and got **zero**. Measured across three id families: FNV-1a
   alone was fine asymptotically (1,920 of an expected 2,000 at n = 20,000) and badly clustered at
   batch scale (0, 1, and 10 of an expected 20 at n = 200) — because neighbouring inputs produced
   neighbouring hashes and a whole round's batch fell on one side of the threshold. A
   MurmurHash3 `fmix32` avalanche step now redistributes: the same three families return 19, 20,
   and 16. `fmix32` is a bijection, so it adds no collisions and changes no cardinality; it only
   spreads. The regression test asserts 12–30 of 200 for each family, which the pre-fix behaviour
   fails on all three. **Why it mattered:** §21.2's sample must be representative of the
   *population*, because every rate computed over the sampled records assumes it is — and a
   sampler that retains none of one round and all of the next produces a bias that is invisible in
   the aggregate counts (exact by construction) exactly where it would mislead most.
2. **The production/shadow leak in `metrics.js`**, described in §1. Fixed by building one
   `decisionFilter` from the shared `PRODUCTION_ONLY` constant and spreading it into every
   decision-record query; the test source-scans all three consumers and additionally pins that the
   named filter is built from the shared constant, so it cannot quietly stop excluding shadow rows.
3. **Two `bindingPredicateId` truthiness bugs**, introduced by my own size optimisation: dropping
   the key from priced top-N rows made `!== null` sweep every candidate into the feasibility
   levers and label every candidate "rejected". Caught by the explanation tests.

---

## 12. Self-Verification

- [x] Every Phase 11 checklist item implemented (§2), with item 3's size half disclosed as missed
      rather than claimed complete.
- [x] **No Phase 12 functionality** — `degraded/`, `failure/`, `map/`, `fairness/` hold no `.js`;
      no `invariantChecker.js`, no `invariant.worker.js`; no `DegradedModeEvent`,
      `InvariantStatus`, `ExternalEscalation`, `Shard`, or `CrossRegionSaga` table. All asserted,
      not merely stated.
- [x] **No Phase 16 functionality** — `solve/batch.js`, `setPartitioning.js`, `localSearch.js`
      still absent. Deferral, preemption, duty-cycle, and reliability metrics are *declared* in
      the §21.4 registry with Phase 16 named as their producer, and report `null`.
- [x] Architecture unchanged — no `.md` specification file was edited. §21 implemented as
      written, with the two plan-versus-specification counting discrepancies resolved by the
      plan's own §0.1 rule and disclosed in §1 rather than silently.
- [x] Tests pass — 5,132/5,132 across all three lanes.
- [x] Build passes — `npx prisma validate`, all three build gates, and the reconstruction gate.
- [x] APIs remain compatible — one new route; `/health` additive; no existing shape changed; the
      legacy lane is unchanged at 169/169.
- [x] Concurrency guarantees maintained — no new lock and no new exclusivity mechanism. The audit
      stream's one tail is held by a unique index, and a collision is **surfaced to the caller**
      rather than swallowed, because a silently dropped audit event is the failure that module
      exists to prevent.
- [x] Determinism maintained — the sampler is clock-free and randomness-free by source scan;
      Tier B is a pure function; replay reuses the stored `decision_time` and the stored
      `killSwitchState` rather than reading either.
- [x] Ownership boundaries maintained — `observability/` reads no store directly except through
      an injected `prisma`; `shadow.js` and `counterfactual.js` receive the round module and the
      resolver as injected seams rather than importing the decision path they observe.

---

## 13. Known Limitations

1. **Tier A exceeds §20.1's 2 KB bound, at 2,373–2,693 bytes.** The most important item for a
   verifier after §11's findings.

   Measured: a §21.2 record with `candidate.max_evaluated` = 200 candidates behind it and 6
   distinct binding predicates is **2,373 bytes**; with all 38 register predicates binding it is
   **2,693**. The target is 2,048.

   The overshoot is **field names, not data**. The record is ~1,840 bytes before a single
   candidate is considered, and adding 196 candidates costs under 100 bytes — which is the `O(1)`
   property holding exactly as specified. Section breakdown at the worst case: `runnerUpAndTopN`
   467, `searchAndSolveBounds` 457, `rejectionSummary` 381, `outcome` 215, `versions` 185,
   `identity` 183, `costTotals` 153, `leg` 150, `degradation` 132, the rest under 80 each.

   Two structural trims were made during implementation, both of which also brought the record
   closer to §21.2's literal wording rather than merely smaller:
   - The rejection summary is a **map** (`{"F34:T2": 12}`) rather than an array of
     `{predicateId, tier, count}` objects — identical information, a quarter the bytes, and
     §7.7's F34 tier is still part of the key. This alone saved 1,368 bytes.
   - The top-N is **one** list of `observability.compact_top_n` entries, as §21.2 words it,
     rather than the parallel priced-and-rejected lists I first wrote. Saved 208 bytes.

   What was **not** done, and why: closing the remaining ~325–645 bytes would mean abbreviating
   the field names of the one artefact in the system whose purpose is that a human can read it.
   A second option — dropping `searchAndSolveBounds.guarantees`, which is derivable from `regime`
   by a pure function — was rejected because Phase 10 added it deliberately, its report and the
   independent verification both endorsed it, and Phase 11's instruction is to modify only what
   Phase 11 needs.

   What Phase 11 does owe, and does deliver: the bound is **measured, recorded per row
   (`DecisionRecordA.sizeBytes`), registered as `perf.tier_a_record_bytes`, surfaced as an SLI
   target, and returned in the writer's `oversize` list**. An oversize record is written anyway —
   refusing it would remove the evidence that the bound was exceeded, which is the one thing the
   target exists to surface. §20.1 is a Phase 15 release-gate target; this is the honest input to
   that gate.

2. **The identical hash weakness exists in `feasibility/rejectionTelemetry.retainRow`** (Phase 6),
   which uses the same un-avalanched FNV-1a. It is **not** called by any production code — it is a
   forward-looking seam exercised only by its own tests — and `sampling.js` is the live sampler.
   Fixing a Phase 6 file was outside Phase 11's mandate, so it is reported here instead. Worth
   closing before anything begins calling it.

3. **The §21.4 metric set is complete as a registry; its feeds are not, and cannot be.** 83
   metrics across seven groups are declared, each with its question, unit, source, and producer.
   The subset with a landed producer is derived for real from the durable record (write rates,
   regimes, budget-limited fraction, both gaps, commit abort rate and reasons, zero-feasible
   fraction, queue and outbox depth and age, reconciler repairs by category, §7.7's histogram,
   register calibration status, thrown kill switches). The rest — duty cycle, health tiers,
   degraded-mode time, escalation capacity, stranding response, invariant violations — report
   `null` with the producing phase named. This is a boundary, not a gap: those mechanisms are
   Phase 12's and Phase 16's.

4. **Shadow mode and the counterfactual evaluator are exercised against injected resolvers, not
   against a live round.** Both take the round module and the re-solver as injected seams by
   design (§10), and no fixture yet assembles a complete agent-plus-Leg world across expansion,
   gate, Plan Builder, `Φ`, and solve — the same limitation Phase 10 recorded as its item 3. The
   golden replay corpus is the piece that would need it, and it is built from stored round
   fragments instead.

5. **`InputSnapshot.resolvedValues` is written from whatever the caller pins.** §21.2 requires the
   record to store the config values the round actually used, not merely the version. The column
   and the plumbing exist; populating it densely depends on the composition root Phase 15 wires.

6. **Migration not applied to a live database** (§5) — a deployment step, matching every phase
   since 6.

7. **Two `groupBy` implementations were added to the shared `roundFixture.memoryPrisma` double.**
   They are minimal and adequate for the assertions that use them; a real Prisma `groupBy` has
   semantics they do not model (`having`, multi-aggregate). Worth knowing before a later phase
   leans on them harder.

## 14. Remaining Non-Blocking Issues

1. **Phase 9's verification finding is still open**, as Phase 10 also recorded:
   `taskAssignment.service.js` and `robotRegistry.service.js` still lack the "superseded banner
   only" header comment every prior phase applied to its own named-but-unmodified legacy files.
2. **`PHASE_0_INDEPENDENT_VERIFICATION.md` still does not exist**, as every review since Phase 1
   has recorded.
3. **Phase 10's three verification findings remain open and untouched by this phase** — the
   `admission.js` queue-delay disclosure, the §9.6 requirement-3 tie-break scope, and the doubled
   `intake` object in the `POST /api/tasks/assign` response. None is in Phase 11's path.
4. **Prisma reports a major version update available (5.22.0 → 7.9.1).** Not evaluated or acted
   on — a major-version bump warrants its own review.
5. **`logger.dtaro` still renders per-candidate detail in development.** It is the *legacy*
   dispatcher's, already marked superseded by Phase 6, and retires with that path at Phase 15.
   §21.7's discipline is implemented for the engine's own emitters, which refuse a candidate array
   outright; extending the refusal to the legacy logger would change legacy dev behaviour for no
   benefit before its removal.

## 15. Readiness for Independent Verification

**Ready.** Suggested focus, in priority order:

1. **The Tier A size finding (§13 item 1).** Is reporting the overshoot the right call, or should
   the record be compressed further — and if so, at what cost to legibility? Independently
   re-measure: `tierA.size(tierA.build(…), 2048)`.
2. **The sampling avalanche fix (§11 finding 1).** Independently re-derive that a 10 % rate over
   200 sequential ids should retain ~20, confirm the pre-fix behaviour on the reverted hash, and
   check that `fmix32` genuinely preserves the reproducibility the sampler depends on.
3. **The reconstruction-equivalence gate.** Is "Tier B is a pure function of a round result, and
   `round.plan()` is a pure function of the pinned inputs, therefore reconstruction from Tier A is
   a theorem" the right formulation of §24.3 — or does the gate need to re-run a *real* round
   pipeline to be worth its name? The corpus is data rather than a database fixture precisely so
   the gate runs on every build; that trade is worth challenging.
4. **The bounded exemption list.** Verify independently that a shard-wide degraded mode cannot
   reach Tier B by any path, and that the budget genuinely binds across rounds (the per-process
   budget in `coordinator.worker.defaultRecordBudget` is created once by design — a per-round
   budget would reset every window and never bind).
5. **The T3 refusal.** Confirm that no code path can produce a T3 event frequency, and that the
   KS-distance-from-uniform statistic is a defensible reading of §21.5's "predictive
   distribution's tail calibration".
6. **The two fixes to `domainSchema.test.js` (§10).** Verify the subtraction mechanism now does
   real work rather than being inert, and that Phase 2's guarantee is not weakened by it.

---

*End of Phase 11 Implementation Report.*
