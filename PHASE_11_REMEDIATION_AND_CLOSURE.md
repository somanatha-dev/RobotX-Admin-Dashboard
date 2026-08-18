# Phase 11 — Remediation, Independent Re-Verification & Closure

**Date:** 2026-08-18
**Branch:** `feature/dashboard`
**Scope:** §21 (decision records, explanation, metrics, calibration, shadow, counterfactual, audit),
§20.1's release-gate targets, §24.3's reconstruction/replay gates, and Phase 10's four handoffs.

This document does **not** replace `PHASE_11_IMPLEMENTATION_REPORT.md` or
`PHASE_11_INDEPENDENT_VERIFICATION.md`. Both are preserved unmodified as evidence of what was
known when they were written. This is the authoritative statement of the final remediated state.

---

## 1. Final Status

# PHASE 11 — CLOSED

**Gates 7/7. 150 suites / 6,579 tests / 0 failures / 0 skips. Live database 31/31.**

BLOCKER-1 — the one item that held this phase open — was discharged on 2026-08-18 by
**RD-2026-08-18-01**, an explicit release-owner classification recorded at
[`docs/release-decisions/RD-2026-08-18-01-columnbuilder-singleton-guard.md`](docs/release-decisions/RD-2026-08-18-01-columnbuilder-singleton-guard.md).
**§20 is the authoritative account of that discharge and of this phase's closure.**

Everything below §1 is preserved as written at the close of remediation, before BLOCKER-1 was
discharged. §17 states the blocker as it stood. §19 records the decision that stood at that
moment — **PHASE 11 — NOT CLOSED** — and is superseded by §20 rather than rewritten, because
what the phase knew and when it knew it is itself the evidence.

The honest summary of how this phase got here is uncomfortable and worth keeping plainly stated:
**fixing the gate is what made the build red.** The §21.6 column-generation release gate was wired
into `npm run gates` and into CI, ran on every build, reported `PASS — NOT_REQUIRED` every time,
and was structurally incapable of reporting anything else. Every "7/7 gates" claim in this
programme since the gate was written — Phase 10's closure included — was measured against a gate
that could not see. That is now fixed, and the first thing the working gate saw was a real,
undischarged §21.6 condition. The 7/7 above is the first such claim in this programme measured
against a §21.6 gate that can see the change set it is given.

---

## 2. Starting State

`PHASE_11_IMPLEMENTATION_REPORT.md` (2026-08-06) reported 97 suites / 5,132 tests / 0 failures /
7 gates, implementing §21.1–§21.7, §20.1's targets and §24.3's gates.
`PHASE_11_INDEPENDENT_VERIFICATION.md` returned **PASS WITH MINOR ISSUES** with nine findings.

Measured baseline of the repository at the start of this remediation, before any change:

| Quantity | Value |
|---|---|
| Test suites | 148 passed / 148 |
| Tests | 6,507 passed / 6,507 |
| Failures | 0 |
| Skips | 0 |
| Build gates | 7/7 reported passing |
| Working tree | 88 modified/untracked paths (a multi-phase uncommitted backlog) |

The suite and gate figures match Phase 10's closure exactly, which is what made them a usable
baseline. The seventh gate's "pass" is the one this remediation found to be vacuous.

---

## 3. Phase 11 Independent Verification — Findings 1–9

Every finding was **independently reproduced against the current repository before being fixed**.
Three of them turned out to be understated; the reproduction of two of them found further defects
of the same class that the historical review did not reach.

### Finding 1 — Moderate — the counterfactual release gate is not wired

**Reproduced?** Partially, and the finding was **already addressed by later work** — then found to
be addressed *in name only*.

**What was already true.** `Backend/package.json` now carries `gate:columngen`, `npm run gates`
invokes it, `npm run verify` is `gates && test`, and `.github/workflows/ci.yml` runs it as a
pull-request-scoped step with `--base "${{ github.event.pull_request.base.sha }}"`. That wiring
was added by Phase 15's CI reconciliation, which cites this finding by name. `tools/gates/
checkColumnGeneration.js` supplies the trigger and delegates the verdict to `counterfactual.gate()`
unchanged. So the *reachability* half of the finding was closed before this remediation began.

**What was not true, and is the new defect.** The gate could not see a worktree change.
`changedPaths()` shared a `lines()` helper with `git diff --name-only` that trimmed each line
before a 3-character `slice(3)` removed `git status --porcelain`'s status field. Porcelain writes
`XY<space><path>`, and an *unset* status character is a **space**: an unstaged modification reads
`" M Backend/…"`. Trimming first produces `"M Backend/…"`, and `slice(3)` then removes `"M B"`,
yielding `"ackend/…"`. Every worktree path silently lost its first character, so no worktree path
could ever equal a gated path.

Reproduced directly:

```
$ node -e "require('./tools/gates/checkColumnGeneration').changedPaths({}).paths
             .filter(p => p.includes('columnBuilder'))"
[ 'ackend/src/engine/plan/columnBuilder.js' ]

$ node tools/gates/checkColumnGeneration.js
  PASS — NOT_REQUIRED …   change set from git worktree: 73 path(s)
EXIT=0
```

…while `Backend/src/engine/plan/columnBuilder.js` was modified in that very tree.

This mattered because `npm run gates` invokes the gate with **no `--base`**, which makes the
worktree the only source of the change set. The gate therefore reported `NOT_REQUIRED` on every
local run and every `npm run verify`. It survived because all fifteen existing self-tests passed
`changed:` explicitly and so never exercised the parser at all.

**Fixed?** Yes. `parsePorcelain()` is now a named function that parses the record without trimming
its leading field, resolves renames to their destination, and unwraps C-quoted paths.
`git diff --name-only` keeps its own trimming helper, because a bare path per line may be trimmed
freely and the two formats are not the same format.

**Regression test?** `tests/gates/checkColumnGeneration.test.js`, +14 tests (15 → 29):

- the six porcelain status forms (` M`, `M `, `MM`, `??`, `A `, `R … -> …`) each parse to the whole path;
- a realistic porcelain block driven end to end through `checkColumnGeneration` makes the gate **fire**;
- an unrelated worktree still passes, with both paths intact (silent truncation is not visible in a count);
- committed-against-base **and** worktree changes are both seen;
- the workflow file is read and asserted to invoke `gate:columngen` **with a `--base`**;
- **CLI exit codes**, via `spawnSync`: `1` on a gated change with no report, `0` on an ungated one, `1` on a measured regression through `--report`.

**Final evidence.**

```
$ node tools/gates/checkColumnGeneration.js
  FAIL — REPORT_REQUIRED. …
  gate required because:
    - Backend/src/engine/plan/columnBuilder.js is a column-generation module (§21.6, §9.3)
EXIT=1
```

The gate is reachable from the release command, and it now sees. What it sees is §17's blocker.

---

### Finding 2 — Minor — shadow leak in `DecisionRecordB` metrics

**Reproduced?** Yes, twice: on the in-memory double and on a live PostgreSQL 18.3 cluster.

`metrics.js` built `decisionFilter = { ...shardFilter, ...decisionRecord.PRODUCTION_ONLY }` and
applied it to every `decisionRecordA` query, while `tier_b_write_rate`'s `decisionRecordB.groupBy`
carried only `shardFilter`. `DecisionRecordB` has no `shadowLabel` of its own — §21.6's marker is
on the `DecisionRecordA` it points at — and shadow rounds do write Tier B rows, because
`shadow.worker.js` calls the same `decisionRecord.writeRound()`.

Live PostgreSQL, one production and one shadow decision each with a Tier B row:

```
[PASS] F2a — the UNFILTERED Tier B query counts the shadow row: unfiltered = 2
[PASS] F2b — the relation filter `decision: { shadowLabel: null }` excludes it: filtered = 1
[PASS] F2c — the shipped tier_b_write_rate SLI counts one production Tier B, not two
```

**Fixed?** Yes. The query now carries `decision: { ...decisionRecord.PRODUCTION_ONLY }` — spelled
from the shared constant rather than as a literal, so the two tables' filters cannot drift apart.

**Regression test?** Three, plus a fixture change:

- `observabilityMetrics.test.js` — a shadow Tier A + Tier B in the store; `tier_a_write_rate.count === 1` and `tier_b_write_rate.value === 1`.
- `observabilityMetrics.test.js` — the *old* query shape run against the same store, showing it returns 2 while the new one returns 1. This exists so the fix cannot be "correct" merely because the double is unable to express the filter.
- `observabilityShadowAudit.test.js` — the source scan extended to `decisionRecordB`, requiring specifically a **relation** guard (`/decision:\s*\{[^}]*PRODUCTION_ONLY/`). A scan accepting a bare `shadowLabel` mention would accept a filter that can never match a column of that table. The scan asserts it matched at least one query, because a regex that silently finds nothing reports green for having looked at nothing.
- `tests/engine/helpers/roundFixture.js` — the double now resolves to-one relations, so a relation filter is executed rather than silently compared against `undefined`.

**Regression search (§21).** Every `decisionRecordB` aggregate in the tree was enumerated: the
leak was the only SLI one. `tierB.worker.js`'s `findMany`/`deleteMany` are the retention path and
correctly operate on both populations. Every `decisionRecordA` consumer was re-checked:
`explain.controller.js`, `replayDecision.js` (which additionally refuses a shadow record outright)
and `invariantChecker.js` (which takes a caller-supplied `productionOnly` filter) are all guarded.

---

### Finding 3 — Minor — `column_generation_gap` always null

**Reproduced?** Yes — and the finding was **understated in two ways**, both the same defect class.

1. **Its sibling has the identical defect.** `counterfactual_regret` is written by the same worker,
   on the adjacent line, and had no readback either. Fixing only the named metric would have left it broken.
2. **The recommended fix would not have worked.** Finding 3 says "add the key to the allowlist".
   The readback scanned `snapshot.counters` only, and both metrics are published with
   `registry.gauge()`. Adding the key to that allowlist would still have produced `null`.

**Fixed?** Yes, at the level of the defect class rather than the instance. `readBackSeries()`
reads counters, gauges **and** histograms, and reports which instrument supplied the value. The
allowlist is now a named `REGISTRY_BACKED` list of five. Both metrics' `source` was corrected from
`DURABLE` to `REGISTRY` — the mis-declaration is *why* the readback was written against the wrong
surface.

**Final evidence.**

```
column_generation_gap  {"sli.column_generation_gap|{\"shardId\":\"s1\"}":4200}  instrument=gauges
counterfactual_regret  {"sli.counterfactual_regret|{\"shardId\":\"s1\"}":1700}
```

**Distinctness (§7).** Four quantities, four approximations, never one number. Asserted as failing
conditions, not prose — see §8 below and `observabilityPhase10Integration.test.js`.

**Null semantics preserved.** `readBackSeries()` returns `null`, never `0` and never `{}`, when
nothing has been published. A metric reading zero because nothing feeds it is indistinguishable
from a system that is behaving.

---

### Finding 4 — Cosmetic — `DecisionRecordA` added-column count

**Reproduced?** Yes, and settled against the database rather than against either document. The
migration's header comment says "seven"; `PHASE_11_IMPLEMENTATION_REPORT.md:163` says "nine". The
actual count is **eight**: `inputSnapshotId`, `fullRetentionUntil`, `sizeBytes`, `tierBWritten`,
`tierBReason`, `samplingDraw`, `samplingRate`, `shadowLabel`.

Verified twice: `grep -c "ADD COLUMN"` returns 8, and the live cluster's
`information_schema.columns` confirms all eight present (`phase11LiveDatabase.js` check T2).
`observabilitySchema.test.js` already asserted eight, so the tested count was right all along.

**Fixed?** The count is corrected **here**, and the migration file is deliberately **left
unedited**. Prisma records a checksum of each applied migration; editing an applied file — even a
comment — makes `prisma migrate deploy` fail with a checksum mismatch on every environment that
already ran it. Correcting a comment is not worth breaking deployment for, and the correction is
now recorded in the authoritative document and enforced by a live-database check.

---

### Finding 5 — Cosmetic — metrics wrongly attributed to future phases

**Reproduced?** Yes. `derive()` gave every unproduced metric one reason:
`"no producer has landed yet — <producer>"`. For 39 of the 83 that sentence is **false** — the
producing phase shipped, and what is missing is a query. The finding named four; the full set is 39.

**Fixed?** Yes, and made checkable rather than editorial. `PRODUCER_LANDED_QUERY_NOT_WIRED` is an
explicit list of 39 ids — deliberately a flat list and not a regex over the `producer` prose,
because a regex over prose is how the wrong attribution was made in the first place.
`derive()` now emits:

- producer landed: `"the producer has landed (…) and no query reads it yet — observability wiring, not a missing mechanism"`, with `producerLanded: true`;
- producer not landed: the original sentence, with `producerLanded: false`.

`assertCoverage()` refuses an id on that list that is not a §21.4 metric, and the regression test
additionally asserts no id on the list is one `derive()` actually produces.

**Why it matters, and it is not cosmetic.** The two states have different owners and different
remedies. "The producer has not landed" is a schedule fact nobody should act on. "The producer
exists and nothing reads it" is observability debt with a name. A reader who cannot tell them
apart defers the wiring to a phase with no reason to do it — which is exactly what the finding
observed happening in prose.

---

### Finding 6 — Cosmetic — "no `Commitment.decisionRef` can ever resolve to a shadow record"

**Reproduced?** Yes; the framing was one enforcement level stronger than the mechanism.
`commit.js` does not itself validate against the `shadow:` namespace.

**Fixed?** The claim is now backed by a **planted execution test** rather than restated.
`observabilityShadowExecution.test.js` drives `shadow.worker.runOne()` against a Prisma double
that records every write to every table, and asserts:

- `round.plan()` called once, `round.execute()` **zero** times (it throws if reached);
- tables written: exactly `inputSnapshot` and `decisionRecordA`;
- `commitment`, `outbox`, `round`, `workQueue`: **no writes at all**;
- the snapshot write is the idempotent `upsert` with an empty `update`, so the production round's pinned inputs are not overwritten;
- the record is marked in both places — the `shadow:` id prefix and the `shadowLabel` column;
- handing the runner `commit`, `dispatch`, `outbox`, `planState` or `emit` throws `ShadowSideEffectError` **before any planning happens** (asserted with a call counter, not by inspection).

The structural claim now reads as it should: no commitment is written, therefore nothing can join
to one — proven by observing that no commitment write occurred, not by asserting that none could.

---

### Finding 7 — Cosmetic — §21.7 event-type coverage

**Reproduced?** Yes, unchanged. Of the nine `EVENT_TYPE` values, exactly **one**
(`TIER_B_SHEDDING`) has a production call site today, in `workers/tierB.worker.js`. The schema and
enum support the other eight; nothing writes them.

**Fixed?** No, and correctly not: writing operator actions, overrides, config changes, quarantine
decisions, constraint relaxations, manual assignments and cancellations is other phases' work, and
fabricating call sites to improve a coverage number is the opposite of what an audit stream is
for. Recorded in §17 as an open item with a named owner.

---

### Finding 8 — Cosmetic — a stale scaffold test naming three of seven workers

**Reproduced?** Yes. `phase0Scaffold.test.js` still names three unscheduled workers. It is
harmless: the comprehensive check lives in `observabilitySchema.test.js` and was independently
confirmed to catch a wiring regression.

**Fixed?** No. Editing a Phase 0 scaffold test to be a worse duplicate of a Phase 11 test that
already works is churn. Recorded in §17.

---

### Finding 9 — Cosmetic — the "2,373 bytes" figure is unbacked

**Reproduced?** Yes, and superseded by fresh measurement. See §8's size table: the figures are now
measured directly and the assertion range in `observabilityDecisionRecord.test.js` is pinned to
them, with the reason for every byte of movement recorded.

---

## 4. Phase 10 Integration

Every field below is traced from the **real producer** — `solve/round.js` calling
`solve/minCostFlow.js` — into the **real consumer**. Nothing is asserted against a hand-written
partition report: a fixture that names `optimalityCertified: true` proves only that the fixture
says so. `tests/engine/observabilityPhase10Integration.test.js` (new, 15 tests) is the evidence.

### P11-1 — `decidedNothingBecause` — WITHDRAWN, and stays withdrawn

Not implemented. A regression test asserts the string appears nowhere in a written record, and
asserts the state it was proposed for is distinguishable without it: `budgetLimited: true`,
`optimalityCertified: false`, `legsUnassignedByIncumbent`, and `LEG_OUTCOME.BUDGET_TRUNCATED`
per Leg.

### P11-2 — solver, certification, fallback in Tier A — DONE

`tierA.searchAndSolveBounds` now carries `solver`, `optimalityCertified`, `fallbackFrom`,
`objectiveMilliCU` and `boundMilliCU`, resolved from **the partition that contained this Leg**.

One enabling change to Phase 10 was required and is the smallest possible: `round.js`'s partition
report carried `legCount` and never *which* Legs. §21.2's record is per Leg, and "the partition's
solver" is not resolvable from a count, so `legIds` was added to the report. It is additive and
read-only; no solve, price or outcome depends on it. Phase 10's own suite was re-run and is green.

| Result type | `solver` | `optimalityCertified` | `fallbackFrom` | `budgetLimited` | Verified by |
|---|---|---|---|---|---|
| Exact cost scaling | `COST_SCALING` | `true` | `null` | `false` | real `round.plan()` → `writeRound()` → stored row |
| Budget-limited | `COST_SCALING` | `false` | `null` | `true` | zero wall-clock budget, real trivial incumbent |
| SSP fallback | `SUCCESSIVE_SHORTEST_PATH` | `null` | the refusal reason | `false` | `costScaling.prepare()` forced to refuse, so the real dispatch takes the real fallback branch |
| No solve at all | `null` | `null` | `null` | `false` | COLUMN regime → `partitions: []` |

Two of those rows are worth stating because they contradict the obvious reading:

- **`optimalityCertified` is `null`, not `false`, after an SSP fallback.** The reference solver
  produces no certificate. "No proof was attempted" and "a proof failed" are different statements
  and only the first is true.
- **A Leg with no feasible candidate *was* solved.** §9.4 admits `NO_FEASIBLE_CANDIDATE` Legs into
  the batch, so such a Leg is a real member of a real sub-problem that a real solver decided — it
  simply had no column to assign. The record says `COST_SCALING`/`certified`, which is correct and
  is the opposite of what intuition predicts.

Round-trip through PostgreSQL JSONB confirmed on the live cluster (check `P11-2`).

### P11-3 — the truncation gap — DONE, with a correction the handoff did not anticipate

`truncationGapMilliCU = objectiveMilliCU − boundMilliCU`, computed in `bigint` throughout by
`decisionRecord.truncationGapOf()`. `null` — never `0n` — when either side is unmeasured, because
an unmeasured gap and a proven-zero gap are opposite claims. A negative result is reported as
computed rather than clamped: it would mean the bound is not a bound, and clamping would hide a
solver defect behind the field whose job is to show one.

**The correction.** §9.3's objective is **lexicographic** — `(unassigned, milliCU)` — and Phase 10
publishes only the money component as `objectiveMilliCU`/`boundMilliCU`. Driving a real
budget-limited round found the consequence:

```
gamma +10, zero budget:  objective 0,  bound 0,       gap 0      unassigned 1
gamma −10, zero budget:  objective 0,  bound −10000,  gap 10000  unassigned 1
gamma +10, exact:        objective 10000, bound 10000, gap 0      unassigned 0
```

With positive prices the trivial incumbent queues every Leg at money cost zero against a money
lower bound of zero — so **`objective − bound` is exactly zero on the worst incumbent the round
can produce**. A reader who saw `truncationGapMilliCU: "0"` and stopped there would read that
incumbent as proven optimal.

P11-3 as written ("`objective − bound`") is implemented exactly as specified, and the record
additionally carries `legsUnassignedByIncumbent` — the *dominant* component of the same
lexicographic gap — so the misreading is not available. The Explanation API states the scope in
words (`truncationGapScope`), and `optimalityCertified: false` and `budgetLimited: true` sit
beside it. A dedicated test asserts the whole configuration on the zero-money-gap case.

### P11-4 — round-union semantics at every consumer — DONE

Phase 10's D5 made `budgets.incumbent.objectiveMilliCU` the union of the partitions rather than
the cheapest of them. Verified at all three consumers on a real three-partition round
(10 + 20 + 30 CU):

- `result.budgets.incumbent.objectiveMilliCU === 60 CU`, and explicitly **not** 10 CU;
- `shadow.compare()`'s `objectiveDeltaMilliCU` is a union-to-union comparison (55 − 60 = −5 CU);
- `counterfactual.worker.loadRounds()` revives the union from the stored `Round` row as a `bigint`;
- a milli-CU objective of `9007199254740993` (2^53 + 1) survives the corpus round trip and is **not** equal to `BigInt(Number(…))`.

No Phase 11 consumer computes a best-of-partitions figure anywhere; the tree was searched for
`partitions` reductions and there are none.

---

## 5. Remediation Performed

### Production code

| File | Change | Why |
|---|---|---|
| `Backend/tools/gates/checkColumnGeneration.js` | `parsePorcelain()` added; `changedPaths()` no longer trims before slicing the porcelain status field | Finding 1's second layer — the gate ran and could not see a worktree path |
| `Backend/src/engine/observability/metrics.js` | `tier_b_write_rate` gains `decision: { …PRODUCTION_ONLY }` | Finding 2 |
| `Backend/src/engine/observability/metrics.js` | `readBackSeries()` reads counters/gauges/histograms; `REGISTRY_BACKED` gains `column_generation_gap`, `counterfactual_regret`; both re-declared `SOURCE.REGISTRY` | Finding 3 and its unnamed sibling |
| `Backend/src/engine/observability/metrics.js` | `PRODUCER_LANDED_QUERY_NOT_WIRED` (39 ids); `derive()` emits the correct reason and `producerLanded`; `assertCoverage()` validates the list | Finding 5 |
| `Backend/src/engine/observability/tierA.js` | `searchAndSolveBounds` gains `solver`, `optimalityCertified`, `fallbackFrom`, `objectiveMilliCU`, `boundMilliCU`, `truncationGapMilliCU`, `legsUnassignedByIncumbent` | P11-2, P11-3 |
| `Backend/src/engine/observability/decisionRecord.js` | `partitionFor()`, `truncationGapOf()`; `tierAInputFor()` resolves the deciding partition | P11-2, P11-3 |
| `Backend/src/engine/observability/explanation.js` | `solveProvenance()`; surfaced in `why_this_agent` and `why_still_waiting` | §21.3 must state what an answer stands on |
| `Backend/src/engine/observability/auditStream.js` | `verify()` gains `expectedFirstSequence`/`expectedLastSequence` and a `truncations` array; `verifyStream()` defaults the head check on a whole-stream read; module header corrected | live-database finding, §12 |
| `Backend/src/engine/solve/round.js` | partition report gains `legIds` | the smallest enabling change for P11-2 |
| `Backend/prisma/migrations/20260818120000_decision_record_immutability_scope/` | new migration scoping `DecisionRecordA`'s immutability to the decision | live-database finding, §14 |

### Tests

| File | Change |
|---|---|
| `tests/gates/checkColumnGeneration.test.js` | +14 (15 → 29): porcelain forms, end-to-end firing, CI workflow assertion, CLI exit codes |
| `tests/engine/observabilityMetrics.test.js` | +5: shadow isolation, the old query's double count, gauge readback, instrument selection, producer-landed semantics |
| `tests/engine/observabilityShadowAudit.test.js` | +5, 1 corrected: `decisionRecordB` source scan; tail/head/window truncation semantics; the reused-ordinal case |
| `tests/engine/observabilityDecisionRecord.test.js` | +1, 1 updated: the solver fields' measured byte cost; the size fence re-pinned with its reason |
| `tests/engine/observabilitySchema.test.js` | +4: the immutability allowlist, its subtraction direction, its three directional guards, and a source scan for refused writes |
| `tests/engine/observabilityPhase10Integration.test.js` | **new**, 15 tests: P11-1/2/3/4 end to end from producer to record to explanation |
| `tests/engine/observabilityShadowExecution.test.js` | **new**, 7 tests: planted shadow non-execution; the exemption bound at all three layers |
| `tests/engine/helpers/roundFixture.js` | the double resolves to-one relations |
| `tools/verify/phase11LiveDatabase.js` | **new**: 31 live-PostgreSQL checks |

### Not changed, deliberately

- `PHASE_11_IMPLEMENTATION_REPORT.md`, `PHASE_11_INDEPENDENT_VERIFICATION.md` — preserved.
- `prisma/migrations/20260806090000_…/migration.sql` — its "seven columns" comment is wrong; editing an applied migration breaks Prisma's checksum. Corrected in §3 Finding 4 and enforced by live check T2.
- `sampling.js` — verified correct (§10); §9 of the brief says not to modify it unless demonstrably wrong, and it is not.
- The §21.6 gate's trigger — not narrowed, not moved out of `npm run gates`, not made bypassable.

---

## 6. Counterfactual Gate

**Mechanism.** `tools/evaluator/counterfactual.js` `gate()` compares a baseline and a candidate
`run()` report over one corpus, for all four §21.6 relaxations reported separately, fails closed on
`NO_MEASUREMENT`, and exits non-zero as a CLI. `tools/gates/checkColumnGeneration.js` supplies the
**trigger** — "does this change touch column generation?" — and delegates the verdict unchanged.

**Invocation.**

```
npm run gate:columngen  →  node tools/gates/checkColumnGeneration.js
npm run gates           →  … && npm run gate:columngen
npm run verify          →  npm run gates && npm test
npm run release:gates   →  npm run gates && …
.github/workflows/ci.yml, job `gates`, pull_request only:
                           npm run gate:columngen -- --base "${{ github.event.pull_request.base.sha }}"
```

The CI step is `--base`-scoped on purpose: a CI checkout's worktree is clean, so without a base the
gate would see nothing on every run. `npm run gates` has no base and reads the worktree, which is
the local belt-and-braces check — and the one that fires here.

**Pass case.** `node tools/gates/checkColumnGeneration.js --changed Backend/src/engine/solve/minCostFlow.js`
→ `PASS — NOT_REQUIRED`, exit **0**. The solver is not the generator, and widening the gate to it
would make it fire so often it would be routed around.

**Fail case — no measurement.** `--changed Backend/src/engine/plan/columnBuilder.js`
→ `FAIL — REPORT_REQUIRED`, exit **1**.

**Fail case — measured regression.** `--changed … --report <run.json>` with a candidate gap 500
milli-CU wider than baseline against a zero allowance → `FAIL — REGRESSION`, exit **1**,
`verdict.regressionMilliCU === "500"`, `verdict.parameter === "solve.max_generation_gap_regression"`.

**Fail case — budget parameter moved.** A `plan.max_columns_per_round` or `plan.max_bundle_size`
change dressed as an ordinary register edit → `REPORT_REQUIRED`. The gate reads the before/after
*values*, not the file, so touching the register without moving either budget does not fire.

**Fail-closed on an unresolvable change set.** `indeterminate: true, required: true`.

All six are asserted, three of them through `spawnSync` on the real CLI with real exit codes.

**Current verdict against this working tree:** `REPORT_REQUIRED`, exit 1. See §17.

---

## 7. Metrics — full audit

**83 metrics, seven groups.** `assertCoverage()` returns no problems; every metric names a
question, a unit, a declared source and a producer.

| Group | Total | Real query | Registry readback | Producer landed, no query | Future producer |
|---|---|---|---|---|---|
| Service quality | 8 | 0 | 0 | 8 | 0 |
| Allocation quality | 13 | 3 | 2 | 5 | 3 |
| Fleet health and utilisation | 9 | 0 | 0 | 4 | 5 |
| Constraint and capacity diagnostics | 5 | 2 | 0 | 3 | 0 |
| System health | 30 | 10 | 3 | 12 | 5 |
| Human capacity and escalation | 8 | 2 | 0 | 0 | 6 |
| Safety and integrity | 10 | 0 | 0 | 7 | 3 |
| **Total** | **83** | **17** | **5** | **39** | **22** |

**Classification, against the brief's own six categories.**

- **REAL PRODUCER + REAL QUERY — 22.** 17 derived from the durable record or §7.7's aggregate, 5 read back from the SLI registry.
- **REAL PRODUCER + MISSING QUERY — 2, both fixed.** `column_generation_gap` and `counterfactual_regret`.
- **FUTURE PRODUCER — 22.** Phase 12's degraded-mode register, dependency registry, circuit breakers, escalation ladder, A3 handling, obstruction classification and invariant checker; Phase 16's Tier 2 mechanisms. Each reports `null` naming the producing phase, with `producerLanded: false`. Verified to have no computation behind them.
- **INTENTIONALLY NULL — the whole of the above 22**, plus every metric whose window is empty. `null`, never zero.
- **INCORRECTLY NULL — 0 after remediation.** Two before (Finding 3 and its sibling).
- **INCORRECTLY NON-NULL — 0.** `tier_b_write_rate` was *inflated* rather than wrongly non-null; fixed.

**The 39 that are producer-landed but unwired.** These are the honest residual, and they are not
Phase 11's to close by wiring blind. Phase 11's obligation was that a reader can tell them apart
from the future-phase 22, and that is now true and machine-checked. Five of the 39 are
registry-sourced with no registry *instance* anywhere in `src/` — `sli.createRegistry()` is never
called in production code — which is a composition-root decision Phase 15 owns, exactly as it owns
starting the four Phase 11 workers that take `deps.registry` and are not started. `explanation_
answers_by_source` is the clearest case: `explain.controller.js` computes `bySource` on every
response and has nowhere to publish it. Deliberately **not** wired, because creating a
process-global registry singleton is an architectural decision outside this phase, and publishing
per request would be the unbounded per-decision write volume §21.2 exists to replace.

**Shadow isolation.** Every `decisionRecordA` **and** `decisionRecordB` aggregate in the
observability layer was enumerated and is guarded, by source scan and by live execution. Shadow
metrics are separated where §21.6 requires exclusion; production metrics ≠ shadow metrics is
asserted on both tables.

---

## 8. Decision Records

**Tier A — completeness.** All fourteen §21.2 sections present; `assertComplete()` distinguishes an
absent section from an empty one.

**Tier A — `O(1)` in candidate count.** `assertBoundedInCandidateCount()` builds the same decision
against 2 and 500 candidates and requires only `runnerUpAndTopN` to differ. Measured growth from
4 → 200 candidates: **< 100 bytes**.

**Tier A — size against §20.1's `< 2 KB`.**

| Case | Before remediation | After | Δ |
|---|---|---|---|
| 6 binding predicates, k = 200 | 2,623 B | 2,756 B | +133 |
| 38 binding predicates, k = 200 (worst case) | 2,929 B | 3,062 B | +133 |
| 38 predicates, solver fields populated | — | 3,081 B | — |

Section breakdown at the worst case (before the new fields): `runnerUpAndTopN` 473,
`searchAndSolveBounds` 435, `rejectionSummary` 352, `costTotals` 274, `versions` 262, `outcome` 238,
`identity` 213, `leg` 150, `inputSnapshotRefs` 144, `degradation` 129, `predictions` 33, `trigger` 13.

**The decision required by §8 of the brief: the 2 KB bound remains OPEN as a measured release
target, and is not a Phase 11 correctness defect.** The reasoning, in order:

1. **What the specification requires.** §20.1's table row is "Tier-A decision-record write — < 2 KB per decision, always retained", in a table §20.1 calls "requirements for the release gate, not aspirations". It is a *release-gate* target. §21.2's own prose says the record "sizes to roughly 1–2 KB".
2. **What Phase 11 owes.** That the bound is measured, recorded per row, and visible. It is: `sizeBytes` on every `DecisionRecordA` (with a `>= 0` CHECK proven to fire), `perf.tier_a_record_bytes` = 2048 as an SLI target in `sli.TARGETS`, and an `oversize[]` list from the writer. An oversized record is **recorded, never dropped** — refusing it would remove the evidence that the bound was exceeded, which is the one thing the target exists to surface.
3. **Why it is not closed by compression.** The overshoot is field names, not data: the record is ~1.8 KB before a single candidate is considered. Closing it would mean abbreviating the field names of the one artefact in the system whose purpose is that a human can read it — which §8 of the brief explicitly forbids.
4. **Why P11-2/P11-3 did not create it.** Measured directly by a new test: stripping all six solver fields still leaves the record **over 2,048 bytes**. The fields cost ~133 B against a ~900 B overshoot. Reverting them would not close the target and would lose the evidence P11-2 exists to produce.
5. **The test fence moved from `< 3000` to `< 3200`**, and this is stated rather than absorbed: it tracks a measurement that grew for a recorded reason. The *requirement* — `limitBytes: 2048`, `withinLimit: false` — is asserted unchanged and still fails, which is the point.

Owner: the release process (§20.1/§24). Recorded in §17.

**Sampling (§9 of the brief).** Verified, not modified.

| Property | Evidence |
|---|---|
| Pre-fix pathology reproduced | FNV-1a alone over 200 sequential ids at 10 %: **0/200** retained |
| Post-fix | with MurmurHash3 `fmix32`: **21/200** (~20 expected) |
| Deterministic | identical draws across calls |
| Order independent | reversing the id order yields identical draws |
| No collisions introduced | 0 collisions over 200,000 distinct inputs — `fmix32` is a bijection |
| No `Math.random()` | the only occurrence in the file is the word inside a comment |
| No `Date.now()` | absent |
| Reservoir deterministic | the same exempt population offered forwards and backwards retains the identical set |

**Tier B exemption bound (§10 of the brief).** All three layers proven to bind:

- **Scope.** 50 simultaneous `SHARD`-scoped degradations produce `exempt: false`, `reasons: []`, and 50 entries in `shardWideRefused`, each `recordedAt: "MODE_LEVEL"`.
- **Budget, shared across rounds.** Ten rounds × ten exempt decisions against a budget of 25 in one window: exactly **25** written, 5 held in the reservoir, the remainder shed and counted. Full retention would be 100. The budget rolls with the minute and demonstrably does **not** roll within one.
- **Schema.** `DecisionRecordA_tier_b_reason_present` proven to fire on the live cluster; `DecisionRecordB_written_because_known` closes the vocabulary at three values.
- **Shedding counted and audited.** `flushOnce()` writes a `TIER_B_SHEDDING` audit event carrying `shed: 4` and increments `sli.tier_b_shedding_count`.

---

## 9. Explanation

**Eight queries, not seven.** §21.3's table states eight; the execution plan's checklist says
seven; `IMPLEMENTATION_EXECUTION_PLAN.md` §0.1 makes the specification win. All eight implemented
and `assertCoverage()` pins the count.

**Source labelling.** `source` is mandatory on every answer — `answerOf()` throws without one.
Asserted across all eight answers of a real decision: `reconstructed === (source === RECONSTRUCTED)`,
a `reconstructionNote` naming byte-identity present on exactly the reconstructed ones and `null`
elsewhere. The API never presents recomputation as retrieval.

**Tier A-only queries.** `why_still_waiting` and `why_deferred` are `TIER_A` with no fallback —
the rejection histogram is folded at decision time and exact over 100 % of decisions, and §8.8
puts the deferral reason where it is never sampled away.

**Phase 10 information exposed.** `solveProvenance()` reports `solver`, `optimalityCertified`,
`fallbackFrom`, `budgetLimited`, `objectiveMilliCU`, `boundMilliCU`, the truncation gap in
milli-CU **and** CU, `legsUnassignedByIncumbent`, `truncationGapScope`, and a
`gapsReportedSeparately` map naming all four gaps and what each bounds. Rendered as one sentence
per state: certified, budget-limited, uncertified, or no solve.

---

## 10. Shadow

Proven by planted execution, not by source inspection. See Finding 6 in §3 for the full list. The
load-bearing observations: `round.execute()` reached **zero** times; tables written exactly
`{inputSnapshot, decisionRecordA}`; `commitment`/`outbox`/`round`/`workQueue` untouched; the
dependency refusal throws before the planner is called even once.

---

## 11. Counterfactual

Round-union semantics verified at all three consumers — see P11-4 in §4. The evaluator's four
relaxations are reported separately and never summed; `counterfactualRegretMilliCU` is the
`CANDIDATE_SET` relaxation's own gap, `columnGenerationGapMilliCU` the `COLUMN_GENERATION` one, and
both now reach `metrics.derive()`.

---

## 12. Audit

Verified on the in-memory double **and** on live PostgreSQL. The live run found a defect the unit
suite could not.

| Property | Result |
|---|---|
| Canonical serialisation | `canonicalJson`, predecessor hash first, so a chain cannot be re-rooted |
| SHA-256 chaining | first event at sequence 0 with `previousHash: null`; each subsequent covers its predecessor |
| Duplicate detection | `AuditEvent_streamId_sequence_key` proven to refuse a duplicate ordinal on the live cluster |
| Duplicate hash | `AuditEvent_hash_key` proven to refuse |
| In-place edit | caught by recomputation; the live `UPDATE` **succeeded**, so detection is the application's, not the database's |
| Middle removal | the database allows it; `verify()` reports a gap **and** a broken link |
| Head removal | named as a `HEAD` truncation on a whole-stream read, by default |
| Tail removal | **see below** |
| Concurrent append | collides on `(streamId, sequence)` and is surfaced, never swallowed |

**The distinction the brief insists on is preserved and is now precise.** The unique index prevents
**duplicates**. It cannot prevent a **removal**: a DELETE leaves every remaining link intact.
Application verification detects removals — but not all of them.

**The defect the live database found.** The module header claimed the dense sequence covered
removals. It covers a *hole*, not a *truncation*. Deleting the tail leaves a chain that is dense,
correctly linked, and verifies completely clean. Worse, `append()` reads the tail and takes the
next number, so the freed ordinal is **reused**: deleting the last event and appending a
replacement produces a stream in which nothing is detectably missing. Both are now asserted as
tests — including the reused-ordinal case, which is the sharpest form.

**The fix.** `verify()` accepts `expectedLastSequence`, an anchor recorded outside the table, and
reports a shortfall as a **truncation** rather than a gap — different failures, different
remedies. `verifyStream()` applies the starts-at-zero check by default on a whole-stream read
(a windowed read is exempt, because a window is not a whole stream) and never defaults the tail
anchor, because the database cannot supply an anchor for itself. Live evidence:

```
[PASS] A8  — a TAIL removal verifies CLEAN without an anchor        ok=true  checked=2
[PASS] A9  — the SAME truncation is caught against a high-water mark
             {"end":"TAIL","expected":"2","found":"1", …}   gaps=[]  brokenLinks=0
[PASS] A10 — a HEAD removal is caught on a whole-stream read, by default
```

**What remains open.** Nothing in this repository *records* a high-water mark. Publishing one to a
store outside `AuditEvent` is a deployment decision and §21.7 names none. Phase 11's obligation was
that the limit is stated rather than implied away and that a caller holding an anchor can use it;
both are now true and neither was before. Recorded in §17.

**Event-type coverage.** One of nine event types has a production call site. Not fabricated —
Finding 7.

---

## 13. Replay

- `npm run gate:erasure` — `PASS`, 3 corpus decisions, 3 with a Tier B record, reconstruction from Tier A alone reproduces every one **byte for byte**; erasure changed no replayed cost.
- `reconstructionEquivalence.test.js` already carries the milli-CU precision boundary: `9007199254740993` survives as a string, and `BigInt(Number("9007199254740993"))` is asserted to be `9007199254740992n` — so the test cannot pass by accident on a rounded literal.
- Same-snapshot / same-config / same-kill-switch / same-solver-metadata replay produces the equivalent result; `replayDecision` refuses a shadow record outright (`reason: "SHADOW_RECORD"`).
- The precision boundary additionally survives the **counterfactual corpus** round trip and PostgreSQL JSONB (new tests, and live check `P11-3`).

---

## 14. Database

Verified against a **disposable PostgreSQL 18.3** cluster built from installed binaries on port
55434, with all 23 migrations applied in directory order. Neon and the default 5432 cluster were
not touched; the harness refuses to start if `DATABASE_URL` looks like either.

**`tools/verify/phase11LiveDatabase.js` — 31/31 checks passed.** Every constraint was made to
**fire**, not merely read:

- 7/7 hand-written CHECK constraints refused the value they exist to refuse.
- 2/2 unique indexes on `AuditEvent` refused duplicates.
- `DecisionRecordB → DecisionRecordA` CASCADE performed and observed.
- `DecisionRecordA → InputSnapshot` SET NULL performed and observed.
- Finding 2 reproduced and its fix confirmed through a real join.
- 8 Phase 11 columns confirmed against `information_schema` (Finding 4).

### The defect the live database found — and it is the most serious in this remediation

`20260728140000_domain_model_and_spatial_hierarchy` installed `DecisionRecordA_immutable`, a
`BEFORE UPDATE` trigger refusing **every** UPDATE. That was correct when it landed, because nothing
updated the table. Phase 11 then added three columns written *after* the row exists, and two
production paths that write them. **Neither path could run.**

Reproduced through the shipped code, not a hand-written query:

```
R1   REFUSED  P0001   decisionRecordA.updateMany({ tierBWritten, tierBReason })
R1b  THREW            tierB.worker.flushOnce()   ← the shipped reservoir flush
R2   REFUSED          inputSnapshot.delete()     ← SET NULL is an UPDATE
R3   REFUSED          an actual content edit (correct, and must stay so)
```

Consequences: **every exempt Tier B record the reservoir holds was lost** — §21.2's "retention
degrades visibly and uniformly rather than by arrival order" degraded invisibly and totally — and
**`InputSnapshot` retention could never execute at all**, so §24.3's "Tier A retained, snapshot
expired" state was unreachable by making retention impossible, which is not the same thing as
making it correct.

Invisible to the entire suite because the in-memory Prisma double has no triggers, and invisible to
schema review because the trigger and the two paths live in migrations written seven phases apart.

**The fix** — `20260818120000_decision_record_immutability_scope` — scopes immutability to the
**decision**. The comparison is an **allowlist subtracted from the whole row**
(`to_jsonb(NEW) - mutable IS DISTINCT FROM to_jsonb(OLD) - mutable`), not an enumeration of
protected columns, so a column added by a later phase is immutable by default and must be named to
become otherwise. Three directional guards stop the allowlist being a hole: `tierBWritten` may go
false → true and never back; `tierBReason` must accompany a written Tier B; `inputSnapshotId` may
only be **cleared**, never re-pointed — re-pointing would silently change what a stored decision
replays against while every hash still matched.

Verified on the live cluster:

```
[PASS] I1 — the reservoir flush's UPDATE is ACCEPTED
[PASS] I2 — editing the DECISION is still refused        ← the §21.2 guarantee, unchanged
[PASS] I3 — un-setting tierBWritten is refused
[PASS] I4 — re-pointing inputSnapshotId is refused
[PASS] I5 — a column added in a LATER phase is immutable by default
[PASS] D2 — expiring an InputSnapshot leaves the record standing, inputSnapshotId = NULL
```

Plus four `observabilitySchema.test.js` tests, including a source scan asserting no production
module writes a `DecisionRecordA` column outside the allowlist. `tools/verify/` is exempt from that
scan, because those harnesses plant refused writes deliberately — the same exemption the gate
self-tests have.

**Ownership.** The trigger is Phase 2's; the columns, the FK behaviour and the worker are Phase
11's. Phase 11 introduced the conflict, so Phase 11 owns it. The change is the smallest one that
makes Phase 11's own paths executable while preserving Phase 2's guarantee exactly — verified by
`I2`, which still refuses a content edit.

---

## 15. Performance

Measured after correctness, on the remediated code. Median of 5,000 iterations unless stated.

| Operation | Cost |
|---|---|
| `tierA.build()`, k = 200 | 55.5 µs |
| `tierA.serialise()` | 86.2 µs |
| `tierA.size()` (serialises) | 73.4 µs |
| `tierA.fromRow()` | 1.1 µs |
| `tierB.build()`, k = 200 | 11.2 µs |
| `explanation.explain()`, all eight queries | 52.0 µs |
| `sampling.draw()` | 0.1 µs |
| `sampling.offer()` | 0.4 µs |
| `auditStream.hashOf()` (SHA-256) | 8.6 µs |
| `auditStream.verify()`, 1,000 links | 10.9 ms |
| **Production Tier A path** (`build` → `size` → `toRow`) | **153.7 µs / decision** |

At §20.1's reference round of 500 Legs, the Tier A record path costs **76.9 ms**, against a 250 ms
round wall-clock budget. It runs in `coordinator.worker.recordRound()`, after the decision, so it
does not extend the solve — but it is not free and it is a third of the round budget, so it is
recorded here rather than left to be discovered.

**Non-opportunities, deliberately not taken.**

- **Canonical serialisation is not changed to hit 2 KB.** §8 of the brief forbids it, and it would break §24.3's byte-for-byte reconstruction gate.
- **`size()` and `toRow()` both serialise**, and `writeRound()` already avoids the second by passing `sizeBytes` through. Caching the serialisation inside the record would make an immutable value stateful for ~70 µs.
- **`auditStream.verify()` at 10.9 ms per 1,000 links** is an offline audit path, not a request path. Optimising it would be optimising something measurable rather than something that matters.

---

## 16. Tests and Gates

### Before remediation

```
Test Suites: 148 passed, 148 total
Tests:       6507 passed, 6507 total
Failures:    0
Skips:       0
Gates:       7/7 reported passing (the seventh vacuously — see §3, Finding 1)
```

### After remediation

```
Test Suites: 150 passed, 150 total
Tests:       6557 passed, 6557 total
Failures:    0
Skips:       0
Time:        467.3 s
```

**Reconciliation.** 6,557 − 6,507 = **+50**, and every one is accounted for. The "before" column
was measured by running each file's `HEAD` version, not inferred from a diff:

| File | Before | After | Δ |
|---|---|---|---|
| `tests/gates/checkColumnGeneration.test.js` | 16 | 29 | +13 |
| `tests/engine/observabilityPhase10Integration.test.js` | — | 15 | +15 |
| `tests/engine/observabilityShadowExecution.test.js` | — | 7 | +7 |
| `tests/engine/observabilityMetrics.test.js` | 23 | 28 | +5 |
| `tests/engine/observabilityShadowAudit.test.js` | 28 | 33 | +5 |
| `tests/engine/observabilitySchema.test.js` | 23 | 27 | +4 |
| `tests/engine/observabilityDecisionRecord.test.js` | 30 | 31 | +1 |
| **Total** | | | **+50** |

+2 suites: `observabilityPhase10Integration`, `observabilityShadowExecution`.

No test was deleted, skipped, weakened, or had an assertion relaxed. One test
(`"truncating the tail is caught too"`) was **corrected**: it asserted `ok: true` under a name
claiming the opposite. It is now named for what it proves, and three stronger tests were added
beside it.

One threshold moved: `observabilityDecisionRecord.test.js`'s size fence, `< 3000` → `< 3200`, for
the reason and with the measurement recorded in §8. The requirement it guards (`limitBytes: 2048`,
`withinLimit: false`) is unchanged and still fails.

### Gates

| Gate | Result | Exit |
|---|---|---|
| `gate:tiers` — §1.8 rule 2 | **PASS** — 274 modules, no violations | 0 |
| `gate:params` — §22, Appendix A | **PASS** | 0 |
| `gate:tenets` — T1, T6 | **PASS** — 274 modules | 0 |
| `gate:privacy` — §23.7 | **PASS** — 16 modules in scope hold no identifying field | 0 |
| `gate:erasure` — §24.3 | **PASS** — 3 decisions, all byte-identical from Tier A alone | 0 |
| `gate:legacy` — Phase 15 | **PASS** — 4 retired modules absent across 317 files | 0 |
| `gate:columngen` — §21.6 | **FAIL — REPORT_REQUIRED** | 1 |
| **`npm run gates`** | **6/7** | 1 |

### Live database

`tools/verify/phase11LiveDatabase.js` — **31/31 passed** against disposable PostgreSQL 18.3.

---

## 17. Remaining Issues

### BLOCKER-1 — the working tree carries an ungated column-generation change

| | |
|---|---|
| **Description** | `Backend/src/engine/plan/columnBuilder.js` has an uncommitted modification. §21.6 requires any change to a column-generation module to be "gated on an evaluator run over a fixed historical corpus showing that the column-generation gap has not widened beyond `solve.max_generation_gap_regression`". No such report accompanies it, so `gate:columngen` returns `REPORT_REQUIRED` and exits 1. |
| **Severity** | **Blocker** for release and for this phase's closure checklist item "all build gates pass". |
| **Owner** | The release process. Not Phase 11, and not Phase 11's to discharge. |
| **Phase** | The change itself originates in the Phase 8 remediation (wiring `assertSingletonRegime()` into `columnBuilder.build()`, which had shipped correct, unit-tested and uncalled). |
| **Blocker / non-blocker** | **Blocker.** Calling it non-blocking would be calling it inconvenient. |
| **Why it remains open** | It cannot currently be discharged. `counterfactual.run()` needs a `resolve` bound to `solve/round.js` over a corpus of **stored rounds**, and no round has ever executed in production — `ENGINE_ENABLED` is `false` and no composition root is started. Manufacturing a corpus to satisfy the gate would be fabricating the measurement §21.6 exists to require, which rule 7 of the brief forbids and which the gate's own docstring anticipates: "any corpus this gate manufactured would be fiction." |
| **What closes it** | Either (a) a real corpus, once rounds execute, and an evaluator run over it showing the gap has not widened — the specification's own discharge path; or (b) an explicit, recorded decision by the release owner that this specific change is outside §21.6's enumerated surfaces (it wires a guard; it alters no clustering rule, bundle-size policy, enumeration order or pruning rule, and does not touch `kept`). **(b) is a judgement call that belongs to a human, not to this phase**, and the gate was deliberately not narrowed to make it automatic. |

**One consequence deserves its own sentence.** Because the gate was blind until now, every prior
phase's "7/7 gates" claim — Phase 10's closure included — was measured against a gate that could
not see a worktree change. Those closures are not thereby wrong, but their gate count was
one gate more optimistic than the evidence supported.

### OPEN-1 — Tier A exceeds §20.1's 2 KB

Severity: **medium**, a release-gate target. Owner: release process (§20.1/§24). **Non-blocking for
Phase 11**, and this is a classification with a stated basis rather than a convenience: Phase 11's
obligation is that the bound is measured, recorded per row and visible, and all three are proven
(§8). Measured 2,756–3,081 B. Remains open because closing it requires either abbreviating the
field names of the system's one human-readable artefact — which §8 of the brief forbids — or
changing the specification.

### OPEN-2 — no high-water anchor is recorded for any audit stream

Severity: **medium**. Owner: deployment/Phase 15 composition. **Non-blocking for Phase 11**: the
mechanism now exists and is proven (§12), and §21.7 names no anchor store. Remains open because
publishing the mark to a store outside `AuditEvent` is a deployment decision. Until then, tail
truncation of an audit stream is undetectable — now *stated* rather than implied away.

### OPEN-3 — eight of nine §21.7 event types have no production call site

Severity: **low**. Owner: the phases that own operator actions, overrides, config changes,
quarantine, relaxations, manual assignments and cancellations. **Non-blocking**: the schema, enum
and append path are complete and proven; only callers are missing. Fabricating them to improve a
coverage number is what the brief's rule 8 forbids.

### OPEN-4 — no process-level SLI registry instance exists

Severity: **low**. Owner: Phase 15 composition root. **Non-blocking**: `sli.createRegistry()` is
never called in `src/`, so the five registry-backed metrics have nowhere to publish to and the four
Phase 11 workers that take `deps.registry` are not started. This is the same, already-disclosed
boundary; it is recorded here because it is the reason `explanation_answers_by_source` remains null
despite its producer existing.

### OPEN-5 — 39 metrics have a landed producer and no query

Severity: **low**. Owner: split across the producing phases and the composition root.
**Non-blocking**: each now reports the accurate reason and `producerLanded: true`, which is the
whole of what Finding 5 asked for. Wiring 39 queries blind, without the producing phases' input on
what each should aggregate, would be worse than the honest null.

### OPEN-6 — `phase0Scaffold.test.js` names three of seven unscheduled workers

Severity: **cosmetic**. Owner: none assigned. **Non-blocking**: the comprehensive check exists in
`observabilitySchema.test.js` and was proven by mutation to catch a wiring regression.

### OPEN-7 — the Phase 11 migration's header comment says "seven columns"

Severity: **cosmetic**. Owner: none. **Non-blocking**, and deliberately unfixed: editing an applied
migration breaks Prisma's checksum. The correct count (eight) is recorded in §3 and enforced by
live check T2.

---

## 18. Phase Boundary — what Phase 11 did NOT implement

- **No Phase 12 work.** No REST route (`/api/health/invariants`, `/api/health/modes`), no Socket.IO event (`DEGRADED_MODE_ENTERED`, `INVARIANT_STATUS_CHANGED`, `STRANDING_ESCALATED`), no degraded-mode register, no dependency registry, no circuit breakers, no escalation ladder, no A3 handling, no obstruction classification. `invariantChecker.js` is Phase 12's and was not modified; its `decisionRecordA` queries were audited for the Finding 2 defect class and are guarded via a caller-supplied filter.
- **No Phase 13–16 work.** No Tier 2 mechanism enabled, no duty-cycle regulariser, no reliability model, no preemption, no deferral, no learned column proposer.
- **No metric wired to a future producer.** The 22 future-producer metrics remain declared and null.
- **No fabricated audit event types**, no fabricated SLI producers, no manufactured counterfactual corpus.
- **Phase 10 was reopened once**, minimally and with cause: `round.js`'s partition report gained `legIds`, without which P11-2's "the partition's solver" is not resolvable per Leg. Additive, read-only, no behavioural effect; Phase 10's own suite is green.
- **Phase 2's immutability trigger was rescoped once**, with cause and with its guarantee proven intact (§14).
- **`sampling.js` was not modified.** It was verified and found correct.
- **The §21.6 gate was not weakened** — not narrowed, not moved out of `npm run gates`, not made bypassable — even though doing so would have produced a green build.

---

## 19. Decision at the close of remediation — SUPERSEDED by §20

> **Superseded 2026-08-18 by §20.** BLOCKER-1 was discharged by release-owner decision
> RD-2026-08-18-01 and the phase is now **CLOSED**. This section is preserved verbatim as the
> record of what was true before that decision was taken. It is not a current statement of status.

# PHASE 11 — NOT CLOSED

**Exact blocker:** `npm run gates` is **6/7**. `gate:columngen` returns `REPORT_REQUIRED` and exits
1, because `Backend/src/engine/plan/columnBuilder.js` carries an uncommitted change that §21.6
requires a counterfactual evaluator report to accompany, and no such report can be produced while
no round has ever executed. See BLOCKER-1 in §17.

**Everything Phase 11 owns is complete and verified.** All nine historical findings reproduced and
dispositioned; all four Phase 10 handoffs integrated and traced end to end from the real producer;
two further defects of the same class found by regression search (`counterfactual_regret`, the
counters-only readback); three defects found by live PostgreSQL that no unit test could reach (the
immutability conflict blocking the reservoir flush and snapshot retention, and the audit stream's
overstated removal detection); 150 suites / 6,553 tests / 0 failures / 0 skips; 31/31 live-database
checks; six of seven build gates green and the seventh green-capable but truthfully red.

**To close Phase 11**, the release owner must discharge BLOCKER-1 by one of the two paths in §17 —
a real evaluator run over a real corpus, or a recorded human decision that the `columnBuilder.js`
change falls outside §21.6's enumerated surfaces. Neither is an engineering task and neither should
be performed by the phase whose gate is doing the asking.

**Phase 12 should not begin until that decision is recorded.** Phase 12 has no technical dependency
on the counterfactual evaluator, so the risk of proceeding is low — but "low risk" is a reason to
make the call quickly, not a reason to skip it.

---

## 20. BLOCKER-1 Discharged — Release-Owner Classification and Final Closure

**Date:** 2026-08-18. **Path taken:** §17's option **(b)** — a recorded human decision, not a
manufactured corpus.

### 20.1 The decision

> **Release-owner decision:** the current `columnBuilder.js` modification only wires the existing
> `assertSingletonRegime()` invariant guard into the column-builder execution path. It does not
> alter clustering rules, bundle-size policy, enumeration order, pruning rules, or kept-column
> selection. Therefore this change is outside the §21.6 counterfactual surfaces enumerated by the
> specification and does not require a counterfactual corpus/report for release gating. The §21.6
> gate remains fully enabled for changes that do affect those surfaces.

Recorded permanently as **RD-2026-08-18-01**:

- [`docs/release-decisions/RD-2026-08-18-01-columnbuilder-singleton-guard.md`](docs/release-decisions/RD-2026-08-18-01-columnbuilder-singleton-guard.md) — the decision in full
- [`docs/release-decisions/RD-2026-08-18-01-columnbuilder-singleton-guard.json`](docs/release-decisions/RD-2026-08-18-01-columnbuilder-singleton-guard.json) — the machine-readable record the gate reads

**This is not a general exemption.** It is not an exemption for `columnBuilder.js` and it is not an
exemption for future changes to it. It is pinned to one pair of file contents, by git object name:

| | git blob |
|---|---|
| `Backend/src/engine/plan/columnBuilder.js` before | `748372cb054fbeda3e22d7c4813ad763ef76a199` |
| `Backend/src/engine/plan/columnBuilder.js` classified | `78fa8756381cd013d5cebf2e58895c84e4963fd6` |

### 20.2 What the change actually does — verified against the diff, not against the report

The diff was read before it was classified. It has three effects and no fourth: it calls
`assertSingletonRegime(kept)`, appends that function's problems to `problems`, and makes the
builder's `ok` field the guard's verdict rather than the constant `true`.

**Effects two and three are unreachable for any input `build()` accepts.** `build()` constructs
every column through `column.make({ agentId, legIds: [candidate.legId], … })` — one `legId` per
candidate, wrapped in a one-element array. `plan/column.js:92` normalises that array with
`[...(source.legIds || [])].map(String).sort(compareStrings)`, which neither de-duplicates nor
expands, so `legIds.length === 1` holds for every entry `build()` can emit.
`assertSingletonRegime()` raises a problem only when `legIds.length !== 1`, so it returns
`{ ok: true, problems: [] }` for every column set this builder can produce.

That is the point of the change rather than an objection to it: the module's documented
restriction becomes enforced by the named check instead of resting on the incidental shape of the
loop that feeds it, and the guard is proven live *before* Tier 2's T2-02 work can rely on it.

### 20.3 Why the change is outside §21.6

Each surface §21.6 enumerates, checked against the diff:

| §21.6 surface | Verdict | Evidence |
|---|---|---|
| Clustering rule | **Not modified** | The generation loop (`columnBuilder.js:89–128`) is byte-identical; still one column per surviving candidate. |
| Bundle-size policy | **Not modified** | The module sets and reads no bundle size, before or after. |
| Enumeration order | **Not modified** | `comparePriced` and `canonicalSort(priced, comparePriced)` are byte-identical. The inserted code runs *after* ordering and truncation, reads `kept`, and reorders nothing. |
| Pruning rule | **Not modified** | Both `pruned.push(...)` sites and `bestPrunedGammaMilliCU` are byte-identical. The guard writes to `problems`, never to `pruned`. |
| Kept-column selection | **Not modified** | `kept` is fully determined at line 150 by the pre-existing budget-truncation block and is never reassigned. The guard reads it and does not write it. |
| Learned proposer (§25.5) | **Not present** | No proposer exists in this module or this repository. |
| `plan.max_columns_per_round` | **Unchanged** | `config/register/appendixA.json` is not part of this change. |
| `plan.max_bundle_size` | **Unchanged** | As above. |

Because no enumerated surface moves, the quantity §21.6 exists to protect — the column-generation
gap — cannot move. The generated set is the same set, in the same order, with the same truncation
and the same prunings.

The gate fired anyway because its trigger is a **path** proxy for those four surfaces, a proxy
being necessarily coarser than what it stands for. That is the exact case §17's BLOCKER-1
anticipated and assigned to a human.

### 20.4 Why no corpus was manufactured

**No counterfactual corpus was created and no counterfactual report was produced for this
decision.**

`counterfactual.run()` requires a `resolve` bound to `solve/round.js` over a corpus of *stored
rounds*. No round has ever executed: `ENGINE_ENABLED` is `false` and no composition root is
started. Any corpus assembled to satisfy the gate would be fiction — a fabricated measurement of
precisely the quantity §21.6 exists to require an honest measurement of. The gate's own docstring
says so ("any corpus this gate manufactured would be fiction"), and it is why an unaccompanied
gated change fails there rather than passing on an empty measurement.

This decision therefore does **not** assert that the column-generation gap was measured. It
asserts that the change cannot move it, on the structural grounds in §20.3 — a different claim,
resting on the diff rather than on data, and recorded as such.

### 20.5 The §21.6 gate itself — unchanged and still enforced

Unchanged and still in force:

- `gate:columngen` remains in `npm run gates`; `npm run verify` still reaches it.
- CI still runs it on every pull request with `--base "${{ github.event.pull_request.base.sha }}"`.
- All four gated source paths, both gated parameters, the register value comparison, the
  fail-closed indeterminate branch and the `NO_MEASUREMENT` verdict are untouched.
- `tools/evaluator/counterfactual.js` was **not modified**. No threshold moved.
  `solve.max_generation_gap_regression` is unchanged.
- The `columnBuilder.js` change was **not** reverted to obtain a green gate.

What `tools/gates/checkColumnGeneration.js` gained is the ability to *read* a decision like this
one, under constraints that keep it a classification rather than a waiver:

- **Pinned to two git blob names**, both resolved from git (`rev-parse <base>:<path>`,
  `hash-object`) and never from the record itself. Drift on either side and it stops applying.
- **`surfacesAffected` must be empty.** A record conceding a §21.6 surface is invalid — that is a
  waiver, and this gate implements no waivers.
- **Source-path triggers only.** A record can never suppress a budget move, because a budget value
  changing *is* the heuristic change, with no proxy in between to misclassify.
- **Fail-closed.** Malformed, unreadable, non-matching, or git-unresolvable records suppress
  nothing, and the mismatch is named in the failure output rather than passed over.
- **Never silent.** Every applied classification is printed on every run, passing or failing.

**Proven, not asserted.** `tests/gates/checkColumnGeneration.test.js` gained 22 tests covering
each of the above, including two mutation tests — one for drift in the classified content, one for
drift in the base. Both were also confirmed against the real repository end to end: appending a
single newline to `columnBuilder.js` moved its blob to `29b72393…`, and `npm run gate:columngen`
immediately returned `FAIL — REPORT_REQUIRED`, naming RD-2026-08-18-01 as a record that no longer
applies. The file was then restored to `78fa8756…`, byte-identical.

### 20.6 Nature of this decision

**This is an explicit release-owner classification, not an engineering bypass.**

- The gate was not weakened, narrowed, disabled, or moved out of `npm run gates`.
- The counterfactual evaluator was not altered and no threshold was moved.
- No measurement was fabricated; no corpus was manufactured.
- The change was not reverted to make the gate green.
- The decision is in version control, pinned to the content it classifies, and surfaced in the
  gate's own output on every run.

If `Backend/src/engine/plan/columnBuilder.js` changes again by so much as one byte, RD-2026-08-18-01
ceases to apply, `gate:columngen` returns to `REPORT_REQUIRED`, and §21.6 must be discharged by a
new decision or — preferably, once rounds have executed — by a real evaluator run over a real
corpus.

### 20.7 Final verification

All measured on 2026-08-18 after the decision was recorded.

| Gate | Result | Exit |
|---|---|---|
| `gate:tiers` — §1.8 rule 2 | **PASS** — 277 modules, 388 governed import edges, no Tier 0/1 → Tier 2 dependency | 0 |
| `gate:params` — §22, Appendix A | **PASS** — 183 modules against 242 registered parameters | 0 |
| `gate:tenets` — T1, T6 | **PASS** — 274 modules, no violations | 0 |
| `gate:privacy` — §23.7 | **PASS** — 16 modules in scope hold no identifying field | 0 |
| `gate:erasure` — §24.3 | **PASS** — 3 decisions, all byte-identical from Tier A alone | 0 |
| `gate:legacy` — Phase 15 | **PASS** — 4 retired modules absent across 318 files | 0 |
| `gate:columngen` — §21.6 | **PASS — NOT_REQUIRED** (RD-2026-08-18-01, §21.6 surfaces affected: none) | 0 |
| **`npm run gates`** | **7/7** | **0** |

```
gate: column-generation release gate (§21.6)
  PASS — NOT_REQUIRED. 1 change(s) in a column-generation module are covered by a recorded
  release-owner classification pinned to their exact before/after blob names, and no other
  §21.6 surface was touched. …
  release-owner classification (§21.6 surfaces affected: none):
    - Backend/src/engine/plan/columnBuilder.js
        classified by RD-2026-08-18-01 — 2026-08-18, release owner
        pinned to its exact before/after blob names; any edit re-raises the gate
```

**Test suite:** `npx jest --runInBand --forceExit` across all 5 projects —
**150 suites / 6,579 tests / 0 failures / 0 skips.** The 22-test increase over the count recorded
at re-verification is exactly the classification tests described in §20.5; no existing test was
deleted, disabled or skipped. Six tests in the gates lane were retargeted rather than weakened:
those asserting "this path fires the gate" now pass `classifications: []` so that they keep
testing the trigger's own semantics independently of whatever decisions the repository carries,
and two CLI exit-code tests moved from `plan/columnBuilder.js` to `plan/column.js` — an equally
gated, unclassified module — because the real CLI reads real decisions.

**Live database:** `tools/verify/phase11LiveDatabase.js` — **31/31 passed** against a disposable
PostgreSQL 18.3 cluster built for the run and destroyed after it. No shared or production database
was touched.

### 20.8 What did NOT change in this step

- `PHASE_11_IMPLEMENTATION_REPORT.md` — **untouched**.
- `PHASE_11_INDEPENDENT_VERIFICATION.md` — **untouched**.
- §§2–19 of this document — **unmodified**, other than §19's heading gaining a superseded marker.
  Their contents record what was true before this decision and are left that way deliberately.
- `Backend/src/engine/plan/columnBuilder.js` — **unmodified by this step**; it still hashes to
  `78fa8756381cd013d5cebf2e58895c84e4963fd6`, the blob RD-2026-08-18-01 classifies.
- `tools/evaluator/counterfactual.js` — **unmodified**.
- **No Phase 12 work of any kind.**

### 20.9 Open items carried forward

OPEN-1 through OPEN-7 (§17) are unchanged and remain open. Each was classified non-blocking with a
stated basis at re-verification, and nothing in this step alters that. They are carried into the
next phase as recorded, not closed by this decision.

---

# PHASE 11 CLOSED

# READY FOR PHASE 12
