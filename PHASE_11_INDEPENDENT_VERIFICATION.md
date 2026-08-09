# Phase 11 — Independent Verification Report

**Role:** Independent Software Verification Engineer. Did not implement Phase 11.
**Scope:** `IMPLEMENTATION_EXECUTION_PLAN.md` Phase 11 ("Observability and explainability", lines
598-623 and checklist lines 1217-1236); `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` §21 in full
(§21.1-§21.7), cross-referenced against §20.1 (release-gate targets) and §24.3 (reconstruction and
replay gates); cross-checked against `PHASE_11_IMPLEMENTATION_REPORT.md` and against every prior
implementation and independent verification report (Phase 0-10) for continuity.
**Date:** 2026-08-06 · **Branch:** `feature/dashboard` · **Baseline:** uncommitted working tree on
top of `cf9103f`, Phase 10 independently verified PASS WITH MINOR ISSUES
(`PHASE_10_INDEPENDENT_VERIFICATION.md` — "Phase 11 may begin").
**Method:** Full re-read of §21 (all seven subsections, verbatim) and the cross-referenced §20.1,
§24.3; full read of the Phase 11 execution-plan row and checklist; independent re-execution of all
three build gates and all three Jest lanes in this reviewer's own shell; six parallel, independently
scoped code-reading passes — one per functional area (schema/migration; Tier A/B and sampling core;
Explanation API, metrics and SLIs; calibration/shadow/counterfactual/audit/logging;
build-gates/module-ownership/Phase-12-absence; runtime/concurrency/determinism) — each of which read
the actual source files in full (not sampled) and, where the report made a numeric or mechanical
claim, re-derived or re-ran it independently rather than trusting the report's own figure; this
reviewer's own direct re-reads of the two most consequential findings surfaced by that process
(the `metrics.js` shadow-filter gap and the counterfactual-evaluator CI wiring) to confirm them a
second time from a fresh reading of the code and of `.github/workflows/ci.yml`.

---

## 1. Phase 11 checklist completion

Independently re-verified against `IMPLEMENTATION_EXECUTION_PLAN.md`'s Phase 11 row (lines
1217-1236), item by item, by reading the actual code and, in most cases, by running it:

| # | Checklist item | Independent finding |
|---|---|---|
| 1 | Migration: `DecisionRecordA`, `DecisionRecordB`, `InputSnapshot`, `CalibrationObservation`, `AuditEvent` | **Confirmed.** All five present in `schema.prisma` and `migration.sql` (20260806090000); additive-only (no `DROP`, no `ALTER COLUMN`); `npx prisma validate` re-run independently, passes. One prose defect, no functional defect — see Finding 4. |
| 2 | Tier A with every §21.2 section incl. leadership fence, regime, kill-switch state, Ω values, both gaps | **Confirmed.** All 14 §21.2 sections present in `tierA.js`'s `SECTIONS`/`build()`; asserted by `assertComplete()`, independently re-run, passes. |
| 3 | Verify Tier A is `O(1)` in candidate count and ≤ 2 KB per decision | **`O(1)` independently reproduced and confirmed (200→2000 candidates: only `runnerUpAndTopN` differs, +1 byte). The 2 KB bound is independently confirmed exceeded** — reviewer's own rebuild of the worst-case fixture measured 2,689 bytes against a registered target of 2,048 (`perf.tier_a_record_bytes`), consistent with the report's disclosure. The report's more precise "2,373 bytes" figure for a 6-predicate case is not backed by any test assertion (only a 2,000-3,000-byte range is asserted) — Finding 9, cosmetic. |
| 4 | Tier B with deterministic sampling seeded from the decision id | **Confirmed**, and the sampling-defect fix independently re-derived from first principles, not from the report's prose — see §3 below. |
| 5 | The **bounded** exemption list — shard-wide degradation at mode level, not per decision | **Confirmed.** `classifyExemption()` refuses `SHARD`-scope degradations by real code (not merely a comment); tested both directions. |
| 6 | `tier_b_write_budget` with reservoir fallback and counted shedding | **Confirmed.** Bottom-k reservoir independently confirmed order-independent (forward/reversed fill produce identical reservoirs) and free of any randomness beyond the already-computed deterministic draw; shedding is counted and separately audited via `AuditEvent`. |
| 7 | `tools/replay/replayDecision.js` | **Confirmed** present and read; reuses `decision_time`/`killSwitchState` from the persisted snapshot rather than reading either live — zero `Date.now()` calls in the file. |
| 8 | `observability/explanation.js` with `TIER_A` / `TIER_B` / `RECONSTRUCTED` labelling | **Confirmed.** `answerOf()` genuinely throws without a source label — structurally mandatory. The two queries §21.3 requires to never be sampled (`why_still_waiting`, `why_deferred`) are hard-wired to `TIER_A` with no code path to any other source. |
| 9 | REST `GET /api/explain/:decisionId` answering all seven §21.3 queries incl. the deferral query | **Confirmed, with eight**, matching the report's own resolution of the plan-vs-spec discrepancy under the plan's own §0.1 rule. Independently re-counted §21.3's table at 8 rows and the plan's checklist at 7; the spec, not the plan, governs per §0.1, and all eight are implemented and independently exercised via `explainApi.test.js`. |
| 10 | The full §21.4 metric set across all six groups | **Confirmed, with seven** (independently recounted from spec prose: Service quality, Allocation quality, Fleet health and utilisation, Constraint and capacity diagnostics, System health, Human capacity and escalation, Safety and integrity), same §0.1 resolution. 83 metrics independently counted by executing the module. **But the "derived for real" claim for this item is overstated — see Findings 1-3.** |
| 11 | `observability/calibration.js` — bias, dispersion, probabilistic calibration per tier at its own timescale | **Confirmed.** T3's refusal to compute an event frequency is a real code path (`observedFrequencyDeliberatelyNotComputed: true`, set on every T3 return, not merely documented); the KS-distance-from-uniform formula is the correct textbook one-sample statistic, not a placeholder. |
| 12 | `observability/shadow.js` | **Confirmed structurally sound**, with one claim held to a lower standard than stated — see Finding 6. `run()` never references `round.execute`; `assertNoEffects()` genuinely throws on any of the seven forbidden dependency keys. |
| 13 | `tools/evaluator/counterfactual.js`, wired as a release gate for column-generation changes | **The gate logic itself is confirmed correctly implemented (fail-closed, non-zero exit, covers all four relaxations and both named budget parameters) — but "wired as a release gate" is CONTRADICTED.** Nothing in `package.json`, `npm run verify`, or `.github/workflows/ci.yml` invokes it. See Finding 1 (the most consequential finding of this review). |
| 14 | Log-volume discipline: per-candidate detail leaves the log stream | **Confirmed.** `withoutPerCandidateDetail()` strips array-valued per-candidate fields; `emitStructured()` throws outside production and annotates-and-omits in production. `logger.dtaro` (legacy, superseded) independently confirmed byte-identical to its pre-Phase-11 body via `git diff`. |
| 15 | The hash-chained audit stream | **Confirmed** as a mechanism (real SHA-256 chaining over a canonical payload that includes the previous hash; DB-unique `(streamId, sequence)`; a collision is surfaced to the caller, not swallowed). One completeness caveat — Finding 7. |
| 16 | **Build gate:** reconstruction-equivalence — Tier A alone reproduces Tier B byte for byte | **Confirmed.** `reconstructionEquivalence.test.js` independently re-run, passes, including its five planted-divergence negative cases. |
| 17 | Golden replay corpus on every build; continuous production replay on a sample | **Confirmed.** Three-entry corpus present incl. a milli-CU value past float precision (`9007199254740993`), independently located and read. |
| 18 | **Gate:** aggregate SLIs exact over 100 % of decisions despite Tier B sampling | **Confirmed** for the histograms this item is actually about (§7.7's binding-constraint aggregation, computed at decision time before Tier B is discarded) — independently re-run test compares the same round written at 0% and 100% sampling and finds byte-identical histograms. |

All 18 items are either fully confirmed or confirmed with a disclosed or newly-found scope
qualification. **Item 13 is the one checklist line whose "Done" verdict this review does not
accept as stated** — the mechanism exists and is well-built, but the specific claim checked off
("wired as a release gate") is false as of this code.

---

## 2. The counterfactual-evaluator wiring gap (Finding 1 — the review's principal finding)

This is not a claim the implementation report discloses as a limitation; §2's table marks
checklist item 13 **"Done"** without qualification, and the Executive Summary lists no caveat
about it (contrast with items 3, 21.4's null-metric boundary, and the known sampling/leak/size
findings, all of which the report *does* disclose candidly). This review actively looked for the
gap because one of the six parallel verification passes flagged it, and independently confirmed
it twice more — once by re-reading `tools/evaluator/counterfactual.js` and
`counterfactual.worker.js` directly, and once by re-reading `Backend/package.json`'s `scripts`
block and the full `.github/workflows/ci.yml` end to end.

**What is true:** `tools/evaluator/counterfactual.js`'s `gate()` function (a) computes the
regression between a baseline and a candidate run for all four §21.6 relaxations
(`CANDIDATE_SET`, `SHARD_BOUNDARY`, `BATCH_WINDOW`, `COLUMN_GENERATION`), reported separately, not
summed; (b) fails closed on `NO_MEASUREMENT` as well as on an actual regression past
`solve.max_generation_gap_regression`; (c) covers `plan.max_columns_per_round` and
`plan.max_bundle_size` as gated changes, matching §21.6's explicit instruction that a budget
change is a heuristic change in effect; (d) as a CLI (`require.main === module`), exits non-zero
on a failed gate. This is a correctly built mechanism.

**What is also true:** nothing in this repository currently invokes it. `package.json` has no
`gate:counterfactual` (or similarly named) script; `npm run verify` (`gates && test`) never
reaches it; `.github/workflows/ci.yml`'s two jobs (`gates`, `test`) run exactly `gate:tiers`,
`gate:params`, `gate:tenets`, `test:gates`, `test:legacy`, `test:engine` — no counterfactual step
anywhere. The scheduled half, `counterfactual.worker.js`, is (correctly, per every other Phase-11
worker) not started from `server.js`. Its own docstring states plainly that it is "the periodic
report half" and that the CLI tool "carries the gate that a release runs" — which means, read
against the actual CI file, that **neither half currently runs anywhere**, not even on a
schedule. `tests/engine/observabilityCounterfactual.test.js` unit-tests `gate()` and
`gateRequiredFor()` directly but contains no `spawnSync`/CLI/exit-code assertion, so the suite
being green says nothing about whether the gate is reachable from a release process.

**Why this matters more than a typical disclosed limitation.** §21.6 states the failure mode by
name: "Running the evaluator only on a schedule would mean a generation regression ships,
degrades allocation quality silently, and is discovered weeks later." The current state is worse
than "only on a schedule" — it is not run at all unless a human remembers to invoke the CLI by
hand and checks the exit code. This is exactly the gap the architecture was written to close, and
it is currently open. It does not corrupt any decision today, because no column-generation
heuristic has changed since this tool was built and `ENGINE_ENABLED` is `false`, but the checklist
item's "Done" status should read "implemented, not yet wired," and the gap should be closed before
Phase 16 (or any earlier phase) changes `plan/columnBuilder.js`'s clustering, bundling, or pruning
logic, or either of the two named budget parameters.

**Severity: Moderate.** Not blocking Phase 12 (Phase 12 — failure handling, degraded modes,
invariants — has no dependency on this mechanism), but it is a materially inaccurate completion
claim on a named checklist item, not merely an under-disclosed edge case, and it should be
corrected — either by adding a CI step that runs the evaluator against the golden corpus on every
PR touching `plan/columnBuilder.js` / the two named parameters, or by explicitly re-scoping the
checklist item and recording the gap in Known Limitations.

---

## 3. The shadow/production metric leak — confirmed only partially fixed (Finding 2)

The implementation report's own Executive Summary and §11 present this as a genuine, fully-closed
finding: "`metrics.js` queried `DecisionRecordA` without the shadow filter, so §21.6 shadow
decisions... would have entered the SLIs. Caught by a source-scanning test written for exactly
that class of mistake." This review independently confirms the fix is real for `DecisionRecordA`
— but incomplete for its sibling table.

Read directly, `Backend/src/engine/observability/metrics.js:373-381` builds
`decisionFilter = { ...shardFilter, ...decisionRecord.PRODUCTION_ONLY }` and this filter is
correctly applied to every `decisionRecordA.*` query in the file (`tier_a_write_rate`,
`commit_abort_rate`, `zero_feasible_fraction`, and others). But `tier_b_write_rate`
(`metrics.js:409-414`) queries `deps.prisma.decisionRecordB.groupBy(...)` using only
`shardFilter` — `decisionFilter` is never applied there. `DecisionRecordB` has no `shadowLabel`
column of its own (it relates to `DecisionRecordA` only via `decisionId`), and shadow-mode rounds
do write `DecisionRecordB` rows: `workers/shadow.worker.js` calls `decisionRecord.writeRound(...)`
with a shadow label set, and `decisionRecord.js`'s writer creates a `DecisionRecordB` row whenever
Tier B is selected, regardless of shadow status. The result is that the `tier_b_write_rate` SLI —
"Tier-B write rate against `observability.tier_b_write_budget`," §21.4 System health — can
currently be inflated by shadow-mode decisions that were never executed, which is precisely the
class of contamination §21.6 requires shadow mode to never cause ("recorded and never executed").

This review also confirmed the stated safeguard does not catch it: the "source-scanning test"
(`tests/engine/observabilityShadowAudit.test.js:164`) matches only
`/decisionRecordA\.(findFirst|findMany|findUnique|count|groupBy)\(...\)/` — it never scans
`decisionRecordB.*` calls at all, so the exact regression this test exists to prevent is invisible
to it in this one location.

**Severity: Minor.** Confined to a single SLI reading, does not affect commitment, dispatch, or
any decision-path behaviour, and does not block Phase 12. It should be fixed before shadow mode is
relied on for the coefficient-tuning decisions §21.6 requires it to gate (i.e., before Phase 16),
either by adding a `decision: { shadowLabel: null }` relation filter to the `decisionRecordB.groupBy`
call or by extending the source-scan test to cover `decisionRecordB` as well as `decisionRecordA`.

**A related, smaller consequence (Finding 3, minor):** `column_generation_gap` — one of the two
gaps §21.4 requires to be "reported separately" from the proven search gap — is written to the SLI
registry by `counterfactual.worker.js` (`sli.column_generation_gap`) but `metrics.js`'s
registry-readback allowlist (`metrics.js:588`) does not include that key, so the metric always
resolves to `null`. Known Limitations §13 item 3 states "both gaps" among the metrics "derived for
real from the durable record"; independently re-running `derive()` against a populated fixture
confirms only `search_gap` actually resolves — `column_generation_gap` is always `null`,
compounding Finding 1 (the same underlying mechanism that would populate this metric is also the
one that is not wired to run).

---

## 4. Execution-plan compliance

**Files created** — all ten `observability/*.js` modules, the two tools
(`tools/replay/replayDecision.js`, `tools/evaluator/counterfactual.js`), the four workers, the
REST controller/route pair, and the ten new `tests/engine/*.test.js` files were independently
located and read in full across the six verification passes; line counts independently verified
by `wc -l` against the report's own §3 table (`tierA.js` 683, `tierB.js` 335, `sampling.js` 523,
`decisionRecord.js` 540 — exact match). All present, all match the report's stated purpose.

**Files modified** — `prisma/schema.prisma`, `src/engine/config/register/supplementary.json`,
`src/services/metrics.service.js`, `src/app.js`, `src/config/logger.js`, `src/routes/index.js`,
`src/workers/coordinator.worker.js`, `tests/mocks/silentLogger.js`,
`tests/engine/phase0Scaffold.test.js`, `tests/engine/commitmentSchema.test.js`,
`tests/engine/costSchema.test.js`, `tests/engine/domainSchema.test.js`,
`tests/engine/helpers/roundFixture.js` — each independently read and confirmed consistent with
the report's claimed diff:

- `metrics.service.js` / `app.js` — confirmed purely additive (`getEngineMetrics`/`getSliSummary`
  added beside an untouched legacy pair; `/health` gains only the `sli` key).
- `logger.js` — confirmed additive; `logger.dtaro`'s body independently diffed against HEAD and
  found byte-identical (only comments added above it).
- `coordinator.worker.js` — confirmed `recordRound()` now writes only the `Round` row itself and
  delegates the per-Leg loop to `decisionRecord.writeRound(...)` at the claimed call site.
- `domainSchema.test.js` — the claimed regex defect independently re-derived as real: Prisma's
  generated `ADD COLUMN` style is five spaces (confirmed by measuring both an old migration and
  the new Phase 11 migration), the pre-fix pattern required exactly one, so the later-column
  subtraction mechanism was silently inert since its introduction; the fix (`\s+`) was
  independently re-run and confirmed to now correctly extract all eight Phase-11-added columns.
- `commitmentSchema.test.js` / `costSchema.test.js` — confirmed the Phase 11 boundary: the four
  new tables asserted present, `DegradedModeEvent`/`InvariantStatus`/`ExternalEscalation`/`Shard`/
  `CrossRegionSaga` (Phase 12/13) still asserted absent.
- `phase0Scaffold.test.js` — `PHASE_11_OWNED = ["observability/"]` confirmed present and folded
  into the cumulative ownership walk; independently re-run, 54/54 pass.
- `roundFixture.js` — confirmed extended with model doubles for all four new tables including a
  `P2002`-emulating `auditEvent` create and two minimal `groupBy` implementations, matching the
  report's own disclosed limitation about what they do not model.

**Files claimed untouched** (`TIERS.md`, `guards/tierAssertions.js`, `guards/tenets.js`,
`config/validators.js`) — each independently read. `TIERS.md`'s T1-03 row already names Phase 11's
three primary modules and was not edited to add a new row; `tierAssertions.js`'s `MODULE_TIERS`
has no `observability/`-specific entry, resolution falling through to the existing
`src/engine/`/`src/workers/` catch-alls exactly as claimed; `tenets.js` has zero references to any
Phase 11 concept. `config/validators.js` contains a pre-existing `v6SnapshotRetention` check that
is consistent with — and does not require any Phase-11-specific edit to satisfy — the codebase's
established pattern of pre-writing cross-cutting validators ahead of the phase that populates their
referenced parameters (the same pattern already used for `TIERS.md`'s and `tierAssertions.js`'s
forward-declared Phase-12/16 rows). This could not be fully proven as an absence of a diff (no
committed Phase-10 checkpoint exists to diff against, since Phases 6-11 are all uncommitted on top
of one base commit — the same limitation the Phase 10 review recorded), only as an absence of any
Phase-11-shaped content in the current file.

**No file outside the declared lists was found to carry Phase-11-shaped content.** Independently
cross-referenced the full `git status --porcelain -uall` listing against the report's declared
lists; the files that show modified but are *not* in Phase 11's list (`costEvaluator.service.js`,
`robotValidator.service.js`, `VirtualRobot.js`, `simulation/constants.js`, `robotStateCache.js`,
`cells.js`, `exchangeRates.js`, `package.json`) were grepped for Phase-11 vocabulary
(observability/explain/calibration/shadow/sampling/audit/decisionRecord) and returned nothing —
consistent with these being earlier-phase (6-10) modifications carried in the same uncommitted
tree, not Phase 11 work.

---

## 5. Architecture compliance

Independently re-read §21 in full (lines 4461-4782) and §20.1/§24.3 by cross-reference, term by
term against the code, in addition to the targeted deep-dives above.

- **§21.2 two-tier design** — confirmed exactly: Tier A's 14 sections, `O(1)`-in-candidate-count
  property (independently reproduced), the two-tier retention table, and — the one place the
  report's own numbers were checked against a fresh rebuild — the 2 KB overshoot, independently
  reproduced at 2,689 bytes against a 2,048-byte target (report: 2,693; same order, well past the
  bound either way, and correctly reported as exceeded rather than hidden).
- **§21.2 bounded exemption list** — confirmed enforced three independent ways, exactly as
  claimed: by scope (`classifyExemption()` refuses `SHARD`), by budget (per-shard-per-minute
  `tier_b_write_budget`, config-registered, not hardcoded), and by schema
  (`DecisionRecordA_tier_b_reason_present` CHECK). The bottom-k reservoir was independently
  confirmed order-independent by construction (bottom-k over a deterministic per-item draw) and
  by test (forward/reversed fill produce identical reservoirs).
- **§21.2 sampling determinism** — the single most rigorously re-derived claim in this review.
  The MurmurHash3 `fmix32` finalizer was checked against the standard construction
  (shift-16/×0x85ebca6b/shift-13/×0xc2b2ae35/shift-16) and confirmed a bijection both by
  construction (odd multipliers, invertible xor-shifts) and empirically (200,000 sequential
  integers hashed, zero collisions). The specific defect-and-fix numbers were independently
  reproduced from a standalone script calling the real module, not copied from the report or its
  tests: **pre-fix, 200 sequential decision ids at a 10% rate retained 0, 1, and 10** across three
  id families (report: identical); **post-fix, 19, 20, and 16** (report: identical); asymptotic
  check at n=20,000 reproduced 1,920 of an expected 2,000 pre-fix (report: identical). This is an
  exact independent confirmation of the report's most technical claim, not a re-reading of its
  prose.
- **§21.3 Explanation API** — confirmed: mandatory source labelling is structural
  (`answerOf()` throws without one); the two queries required to never be sampled
  (`why_still_waiting`, `why_deferred`) are hard-wired to `TIER_A` with no alternate code path;
  the sensitivity query is exact recomputation (`γ(runner-up) − γ(chosen)`), not search, matching
  §21.3's own stated reason this query is only possible because the objective is a transparent sum.
- **§21.4 Metrics** — 83 metrics across 7 groups confirmed by execution, matching the report's
  count exactly, with fence-rejection and the two cache-hit-rate pairs confirmed reported
  separately as the spec requires (not combined). **However**, the "derived for real" claim is
  overstated in two ways found by this review and not disclosed in the report at the same
  precision: the `tier_b_write_rate` shadow leak (Finding 2) and the always-null
  `column_generation_gap` (Finding 3). Separately, Known Limitations §13 item 3 attributes the
  majority of the 70 currently-null metrics uniformly to "Phase 12's and Phase 16's" producers,
  but several — fence-rejection counts (Phase 4), near-miss margins and indeterminate rate
  (Phase 6), several energy diagnostics (Phase 7) — have producers that already landed; the
  correct characterization for these specific metrics is "not yet queried by Phase 11," not "owned
  by a future phase" (Finding 5, cosmetic).
- **§21.5 Calibration** — confirmed exactly: T1/T2 use direct event-frequency counting; T3 sets
  `observedFrequencyDeliberatelyNotComputed: true` on every return path and is scored instead by a
  correctly-implemented one-sample Kolmogorov–Smirnov distance from uniform; the calibration
  worker publishes a frequency gauge only for event-count-instrumented tiers.
- **§21.6 Shadow mode** — confirmed structurally sound: `run()` never references `round.execute`;
  `assertNoEffects()` throws on any of the seven named forbidden dependency keys; shadow records
  are double-marked (`shadow:` id prefix and `shadowLabel` column). One claim held to a lower
  standard than the report's phrasing implies: "no `Commitment.decisionRef` can ever resolve to
  [a shadow record]" is true today only because nothing in the codebase constructs a commit
  request carrying a shadow-prefixed id — `commit.js` accepts `decisionRef` as an unvalidated
  string, so the guarantee is a consequence of `shadow.js`'s dependency-injection boundary, not a
  schema- or validation-level enforcement (Finding 6, cosmetic; the practical protection is real,
  the "structural" framing overstates its enforcement layer).
- **§21.6 Counterfactual evaluator as a release gate** — see Finding 1. The evaluator itself is
  correctly built; being wired as a gate is not, and this is the review's principal finding.
- **§21.7 Tracing and logging** — confirmed: the log-volume refusal throws outside production and
  degrades-and-annotates in production; `TRACE_FIELDS`, `logger.round()`, `logger.anomaly()` all
  present; `logger.dtaro` (legacy, superseded, retiring at Phase 15) confirmed untouched. The
  hash-chained audit stream's chaining and collision-surfacing were independently confirmed real,
  with one completeness note: of the seven §21.7-named event categories, only one
  (`TIER_B_SHEDDING`) currently has a production call site; the module and schema support the
  other six, but nothing in this phase's scope writes them yet (Finding 7, cosmetic — the report
  does not claim otherwise, but a future reader should know the stream is not yet end-to-end wired
  for operator actions, overrides, config changes, etc.).
- **§20.1 release-gate targets** — confirmed 20 targets including exactly two p99.9s
  (independently recomputed from the spec table's 17 rows, two of which carry multiple
  sub-targets), matching `sli.js`'s `TARGETS` array exactly.
- **§24.3 reconstruction-equivalence and replay gates** — confirmed operative: the gate test was
  independently re-run and passes, including catching all five of its own planted divergences;
  the golden corpus is present with the stated float-precision-edge entry.

---

## 6. Module ownership and dependency direction

- `PHASE_11_OWNED = ["observability/"]` confirmed added and correctly folded into the cumulative
  ownership walk in `phase0Scaffold.test.js`; independently re-run, 54/54 pass.
- Tier placement: `tools/gates/checkTierDependencies.js` independently re-run —
  **PASS, 240 modules, 318 governed import edges, zero Tier 0/1 → Tier 2 edges** (identical to the
  report's own claimed figures, reproduced fresh in two independent shells during this review,
  not copied from the report). `TIERS.md`'s T1-03 row confirmed to already name
  `observability/decisionRecord.js`, `controllers/explain.controller.js`, and
  `routes/explain.routes.js`; no new `MODULE_TIERS` row exists for `observability/*` in
  `tierAssertions.js` — resolution falls to the pre-existing `src/engine/`/`src/workers/`
  catch-all rows.
- A full-tree grep for every Phase-12/16 identifier (`invariantChecker`, `DegradedModeEvent`,
  `InvariantStatus`, `ExternalEscalation`, `obstructionClass`, `modeRegister`, `agentFailures`,
  `infraFailures`, `CrossRegionSaga`, `solve/batch`, `setPartitioning`, `localSearch`, etc.)
  independently re-run: every hit is either a documentation forward-declaration, a registry entry
  whose `producer` field names the future phase and whose value resolves to `null`, or a test
  asserting absence. No real Phase-12/16 implementation logic was found anywhere in the tree — see
  §8 below for the detailed breakdown.
- Ownership boundaries: independently confirmed no `observability/*.js` module imports a Prisma
  client module directly (only `crypto` and sibling pure `determinism/`/`observability/` modules
  are required at module scope); `prisma`/`kv` arrive via an injected `deps` parameter throughout.
  `shadow.js` and `tools/evaluator/counterfactual.js` receive the round-planning module and
  re-solver as injected parameters, confirmed by reading their signatures — neither imports
  `solve/round` or a resolver directly.

---

## 7. Runtime behaviour

`ENGINE_ENABLED` independently confirmed to gate nothing new in Phase 11's own code — no Phase 11
module reads or bypasses the flag, and the one path that would matter,
`coordinator.worker.js` → `decisionRecord.writeRound`, is unreachable while the coordinator itself
is not started. All four new workers (`tierB.worker.js`, `shadow.worker.js`,
`calibration.worker.js`, `counterfactual.worker.js`) independently confirmed **not** called from
`server.js` or `src/app.js` (grep, zero matches in both, re-run fresh), and this review went
further than reading: it planted a deliberate violation (added a `require()` of
`tierB.worker.js` to `server.js`), re-ran the guard test (`observabilitySchema.test.js`), watched
it fail correctly, then reverted the plant — confirming the mechanical assertion the report claims
is real and would actually catch a regression, not merely a comment claiming so. One cosmetic note:
an older, narrower guard in `phase0Scaffold.test.js` still only checks three of the now seven
unscheduled workers and was not extended for Phase 11's four — harmless because the comprehensive
check exists elsewhere and was proven to work, but worth knowing before trusting that specific test
in isolation (Finding 8, cosmetic).

`/health`'s new `sli` block independently confirmed best-effort: wrapped in try/catch, defaults to
`null`, and adds no new key that collides with the pre-existing response shape. The 169-test legacy
lane was independently re-run in isolation (`npm run test:legacy`) and confirmed **169/169**,
unchanged.

---

## 8. Database

All five Phase 11 tables/columns independently re-verified present, additive-only (no `DROP`, no
`ALTER COLUMN`), and matched against `schema.prisma`. `npx prisma validate` independently re-run,
succeeds; no live database available in this environment, consistent with every phase since 6. The
seven hand-written CHECK constraints were independently confirmed present verbatim in
`migration.sql` and confirmed **absent** from Prisma's own `migrate diff --from-empty` output by
re-running `observabilitySchema.test.js` directly (30 tests, all pass) — proving they are genuine
hand-written additions rather than an echo of something Prisma would generate on its own.

**One prose-only defect found and independently confirmed (Finding 4, cosmetic):** the report
states `DecisionRecordA` "gains nine columns" and enumerates exactly eight names; the migration
file's own header comment separately says "seven"; the schema, the migration SQL, and the test
suite's own assertion (`observabilitySchema.test.js`) all agree on **eight**. Three sources, three
different counts, only the prose is wrong — no functional impact, since the code, the migration,
and the test all agree with each other.

The `AuditEvent.sequence` uniqueness was independently re-examined for precisely what it does and
does not guarantee: the DB-level `@@unique([streamId, sequence])` constraint structurally prevents
**duplicates**, but density (no gaps from a deletion) is an application-level property, produced by
`append()`'s read-then-increment logic and checked after the fact by `verify()`'s gap scan — not a
DB-level prevention. This matches the report's own more careful phrasing ("the dense sequence
catches a removal," i.e., detects, not prevents) rather than contradicting it; noted here only
because a reader skimming the "structurally preventable" framing elsewhere in the report could
otherwise draw a stronger conclusion than the schema supports.

---

## 9. Redis

Both new keys (`engine:sli:{shard}:{instance}`, `engine:sli:instances:{shard}`) independently
confirmed advisory: `sli.js`'s `publish()`/`collect()` are both wrapped in try/catch, returning
`false`/empty on failure, never throwing. No decision data reaches Redis from any Phase 11 module —
independently confirmed by reading every `kv` call site inside `observability/**` and the four new
workers (only `sli.js` touches `kv`, using only `set`/`sadd`/`smembers`/`mget`). `cache/kv.js`
independently confirmed to have zero diff against HEAD — no new capability was added there, matching
the report's claim and Phase 10's own disposition.

---

## 10. Socket.IO

Independently confirmed **none**: a full grep of `src/sockets/**` for every Phase 11 vocabulary
term returns only two incidental comment matches (unrelated "audit trail" prose in
`dtaro.handler.js`). The one real diff in `socket.server.js` is explicitly Phase 10's intake
routing work, not Phase 11's, and was correctly excluded from Phase 11's Files Modified list.

---

## 11. APIs, concurrency, determinism

**APIs** — the single new route (`GET /api/explain/:decisionId`, plus `GET /api/explain/queries`)
independently confirmed to match the plan's row exactly, mounted via a purely additive edit to
`routes/index.js` (all eight pre-existing `router.use(...)` lines unchanged in content and order).
Middleware pattern (`authUser` + a dedicated rate limiter) independently confirmed to match the
existing `diagnostics.routes.js` precedent byte-for-byte in structure. No existing endpoint's
behaviour, response shape, or route changed.

**Concurrency** — no new lock, mutex, or semaphore anywhere in `observability/**` (grep-confirmed).
The audit stream's collision handling was independently re-read: a `P2002` unique-constraint
violation on `(streamId, sequence)` is caught, returned as `{ ok:false, collided:true, ... }` to
the caller rather than swallowed, and every other error is re-thrown.

**Determinism** — independently re-confirmed clock/randomness-free by source scan specifically in
`sampling.js` (zero code-level hits for `Date.now`/`Math.random`, one hit only inside a doc
comment) and `tierB.js` (the one `new Date(...)` present constructs from an input parameter, not a
live read). `replayDecision.js` independently confirmed to read `decision_time` and
`killSwitchState` from the persisted snapshot rather than live — zero `Date.now()` calls in the
whole file, with an inline comment stating the reason. Other observability modules that do read
live clocks (`sli.js`, the four workers, one bounded `Date.now()` fallback in `metrics.js` scoped
to an aggregation-window default) are correctly outside the decision path proper, consistent with
the report's own characterization.

---

## 12. Regression safety / build gates / test suite

**Independently re-executed in this reviewer's own shell, not trusted from the report:**

```
npx prisma validate                        → valid

npm run gate:tiers   → PASS — 240 modules, 318 edges, 0 violations    (report claims: identical)
npm run gate:params  → PASS — 153 modules, 210 params, 0 bare consts  (report claims: identical)
npm run gate:tenets  → PASS — 237 modules, 0 violations               (report claims: identical)

npm run verify (gates + full test, all 3 lanes) → 97 suites / 5,132 tests, 0 failures
                                                     (report claims: identical)

npm run test:legacy  → 169/169, 22 suites          (report claims: identical, unchanged from Phase 9/10)
```

Every number in the report's §11 was independently reproduced exactly, both by this reviewer's own
top-level `npm run verify` run and, separately, by two of the six delegated verification passes
running the same gates and the engine/gates lanes on their own. No discrepancy found between
claimed and actual test/gate results anywhere. This reviewer additionally re-ran the ten Phase-11
test files in isolation (**214/214**, exact match) and independently reproduced — from a standalone
script against the real `sampling.js` module, not from reading the shipped test's assertions — the
report's most technical numeric claim (the pre/post-fix sampling-distribution numbers), obtaining
identical figures.

---

## 13. Failure handling / chaos

Phase 11's execution-plan row specifies no chaos-testing requirement distinct from the
reconstruction-equivalence and golden-corpus gates already covered in §1 items 16-17 above, and
none was found beyond those. Concurrency-adjacent failure handling (a collision on the audit
stream's unique tail) is covered in §11 above.

---

## 14. Confirm nothing from Phase 12 (or later) implemented

**Independently confirmed, not merely re-stated from the report:**

- `src/engine/degraded/`, `failure/`, `map/`, `fairness/` each contain only a `.gitkeep` —
  independently listed, confirmed empty of `.js` files.
- No `DegradedModeEvent`, `InvariantStatus`, `ExternalEscalation`, `Shard`, or `CrossRegionSaga`
  model anywhere in `schema.prisma` — independently grepped, zero matches; also independently
  asserted absent by `commitmentSchema.test.js`, re-run, passes.
- No `invariantChecker.js`, `invariant.worker.js`, `modeRegister.js`, `agentFailures.js`,
  `infraFailures.js`, `externalEscalation.js`, or `obstructionClass.js` classifier logic anywhere
  in the tree. A full-tree grep for these names surfaced only: documentation forward-declarations
  in `TIERS.md`/`ARCHITECTURE.md`; catalog rows in `tierAssertions.js` naming future file paths
  that do not exist (the tier gate passing with zero violations proves there are no real import
  edges to them); pre-existing lifecycle/supervision code (from earlier, already-verified phases)
  consuming a nullable `obstructionClass` input and explicitly deferring to "Phase 12 —
  degraded/modeRegister.js" in its own code comments rather than implementing mode entry itself;
  and test files asserting absence. No actual classifier, mode-transition, or invariant-checking
  algorithm exists anywhere.
- No `solve/batch.js`, `solve/setPartitioning.js`, or `solve/localSearch.js` — independently
  confirmed absent (Phase 16's Tier 2 mechanisms).
- No Phase-12-owned REST route (`/api/health/invariants`, `/api/health/modes`) or Socket.IO event
  (`DEGRADED_MODE_ENTERED`, `INVARIANT_STATUS_CHANGED`, `STRANDING_ESCALATED`) — independently
  grepped across `src/routes/`, every controller, and `src/sockets/**`, zero matches.
- §21.4 metric-registry entries whose producer is named as Phase 12 or Phase 16
  (`stranding_events_by_obstruction_class`, `invariant_violations`, duty-cycle, health-tier,
  reliability metrics, etc.) independently confirmed to report `null` with the producing phase
  named, and independently confirmed to have zero computation logic behind them in
  `metrics.service.js`.

---

## Summary of findings

| # | Severity | Category | Affected files | Recommendation |
|---|---|---|---|---|
| 1 | **Moderate** | Execution-plan compliance / release-gate integrity | `Backend/tools/evaluator/counterfactual.js`, `Backend/src/workers/counterfactual.worker.js`, `Backend/package.json`, `Backend/.github/workflows/ci.yml` (verified: no reference exists) | Checklist item 13's "wired as a release gate" is not true — the gate logic is correct but is invoked by nothing (no npm script, no CI step, no scheduled worker start). Add an automated invocation (CI step gated on changes to `plan/columnBuilder.js` or the two named budget parameters, at minimum) before Phase 16 touches column-generation heuristics, or re-scope the checklist item's status and record the gap explicitly in Known Limitations. Does not block Phase 12. |
| 2 | Minor | Architecture compliance (§21.6 shadow/production isolation) | `Backend/src/engine/observability/metrics.js:409-414`, `Backend/tests/engine/observabilityShadowAudit.test.js:161-171` | `tier_b_write_rate`'s `decisionRecordB.groupBy` query omits the `decisionFilter`/`PRODUCTION_ONLY` guard applied to every `decisionRecordA` query in the same file, so shadow-mode Tier B writes can inflate this SLI; the regression test that is supposed to catch exactly this class of mistake only source-scans `decisionRecordA` calls. Add the filter (via a `decision: { shadowLabel: null }` relation condition) and extend the source-scan test to cover `decisionRecordB`. Fix before shadow mode is relied on for tuning decisions (i.e., before Phase 16). |
| 3 | Minor | Metrics completeness claim | `Backend/src/engine/observability/metrics.js:588` (registry-readback allowlist), `PHASE_11_IMPLEMENTATION_REPORT.md` §13 item 3 | `column_generation_gap` is written to the SLI registry by `counterfactual.worker.js` but never read back by `metrics.js`, so it always reports `null` despite being claimed among the metrics "derived for real." Add the key to the allowlist. Related to and partly caused by Finding 1. |
| 4 | Cosmetic | Documentation accuracy | `PHASE_11_IMPLEMENTATION_REPORT.md:163`, `Backend/prisma/migrations/20260806090000_decision_records_and_observability/migration.sql:3` | `DecisionRecordA`'s added-column count is stated as "nine" in the report and "seven" in the migration's own header comment; the actual, tested count is eight. No functional impact — fix the two comments for consistency. |
| 5 | Cosmetic | Documentation accuracy | `PHASE_11_IMPLEMENTATION_REPORT.md` §13 item 3 | Several of the ~70 currently-null §21.4 metrics (fence-rejection counts, near-miss margins, indeterminate rate, some energy diagnostics) are attributed to "Phase 12's and Phase 16's" producers, but those producing phases (4, 6, 7) already landed — the accurate reason is that Phase 11 has not yet wired a query for them, not that the mechanism doesn't exist yet. Worth a one-line correction so a future reader doesn't defer the wiring to the wrong phase. |
| 6 | Cosmetic | Precision of a structural claim (§21.6) | `Backend/src/engine/observability/shadow.js`, `Backend/src/engine/commitment/commit.js:154` | "No `Commitment.decisionRef` can ever resolve to a shadow record" is true today only because no code path constructs a commit request with a shadow-prefixed id; `commit.js` does not itself validate against the `shadow:` namespace. The practical protection (shadow.js's dependency-injection boundary blocks `commit` from ever being reachable) is real; the "structural"/schema-level framing overstates the enforcement layer by one level. No correction required unless a future caller starts constructing commit requests from external ids. |
| 7 | Cosmetic | Completeness, not correctness (§21.7) | `Backend/src/engine/observability/auditStream.js` | Of the seven §21.7-named audit-event categories, only one (`TIER_B_SHEDDING`) has a production call site today; the schema/enum support the other six (operator actions, overrides, config changes, quarantine decisions, constraint relaxations, manual assignments, cancellations) but nothing writes them yet. The report does not claim otherwise, so this is not a contradiction — flagged so a later phase wiring operator actions doesn't assume the stream is already fully populated. |
| 8 | Cosmetic | Test redundancy | `Backend/tests/engine/phase0Scaffold.test.js:319-327` | A pre-Phase-11 "no engine worker started" guard still only names three of the now-seven unscheduled workers. Harmless — the correct, comprehensive check for Phase 11's four workers lives in `observabilitySchema.test.js` and was independently proven (by mutation test) to actually catch a wiring regression — but worth pruning or extending so a future reader doesn't mistake the stale test for full coverage. |
| 9 | Cosmetic | Precision of a measured claim | `PHASE_11_IMPLEMENTATION_REPORT.md` §13 item 1 | The specific "2,373 bytes" (6-predicate case) figure is not backed by any test assertion — only the worst-case range (2,000-3,000 bytes) and the 38-predicate figure (independently reproduced at 2,689 vs. claimed 2,693, within fixture noise) are. The overshoot itself, and the `O(1)` property, are both independently confirmed real regardless. |

No blocking issue was found. Findings 1-3 are the only ones with any behavioural consequence, and
all three are confined to observability surfaces (an unwired release gate and two SLI-derivation
gaps) rather than to commitment, dispatch, supervision, or any decision-path mechanism — none of
Phase 12's dependencies. Findings 4-9 are documentation/precision issues with no functional
effect. Every other claim in `PHASE_11_IMPLEMENTATION_REPORT.md` that was checked — all 18
checklist items, every numbered section, and in particular the report's own most technical claim
(the sampling-avalanche defect and fix) — was independently reproduced from the code itself, not
merely re-read from the report's prose, and held up exactly as claimed.

---

## Final decision

# PASS WITH MINOR ISSUES

One moderate issue (an execution-plan checklist item marked "Done" whose specific claim — release-
gate wiring — is not yet true, though the gate mechanism itself is correctly built) and eight minor/
cosmetic issues, detailed above. None is a decision-path, commitment, dispatch, or supervision
defect; none weakens any of the invariants Phase 11 is responsible for (I10, I15); none touches
anything Phase 12 depends on.

**Phase 12 may begin.** Confirmed independently, by direct code inspection and a full-tree grep for
every named Phase-12/16 artifact, that nothing from Phase 12's own scope (`degraded/`, `failure/`,
`map/`, `fairness/`, `invariantChecker.js`, the three Phase-12 Prisma models, the two Phase-12 REST
routes, the three Phase-12 Socket.IO events) has been implemented ahead of schedule, and that
nothing from Phase 16 (`solve/batch.js`, `setPartitioning.js`, `localSearch.js`) has either.

**Recommended before Phase 16 specifically** (not a Phase 12 blocker): close Finding 1 by wiring
the counterfactual evaluator into an automated gate ahead of any column-generation heuristic or
budget-parameter change, and close Finding 2 by extending the shadow/production filter to
`DecisionRecordB` reads, since Phase 16 is exactly the point at which both the column-generation
gate and shadow-mode-informed tuning decisions become load-bearing.

---

*End of Phase 11 Independent Verification Report.*
