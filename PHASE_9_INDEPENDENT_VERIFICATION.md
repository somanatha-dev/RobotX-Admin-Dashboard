# Phase 9 — Independent Verification Report

**Role:** Independent Software Verification Engineer. Did not implement Phase 9.
**Scope:** `IMPLEMENTATION_EXECUTION_PLAN.md` Phase 9 ("Candidate generation and the admissible
bound"), `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` §6, cross-checked against `PHASE_9_IMPLEMENTATION_REPORT.md`.
**Date:** 2026-08-05 · **Branch:** `feature/dashboard` · **Baseline:** uncommitted working tree on
top of `cf9103f`, Phase 8 independently verified PASS WITH MINOR ISSUES.
**Method:** Full re-read of §6 (all six subsections, verbatim) and cross-referenced §1.8, §3.3,
§18.5, §24.1, §27 item 1; full re-read of the Phase 9 execution-plan row; independent re-execution
of all build gates and all three test lanes; line-by-line reading of every new/modified Phase 9
source file (not sampled); independent read of the migration SQL and schema diff; grep-based
verification of every "not touched" / "not wired" claim in the implementation report; summary
cross-check against all eight prior independent verification reports.

---

## 1. Phase 9 checklist completion

Independently re-verified against `IMPLEMENTATION_EXECUTION_PLAN.md`'s Phase 9 row (execution
plan lines 538–563), item by item, by reading the actual code rather than trusting the
implementation report's table:

| # | Checklist item | Independent finding |
|---|---|---|
| 1 | H3 wrapper + Availability Index | **Confirmed.** `spatial/cells.js` H3 wrapper (`cellForPoint`, `ringAt`, `diskAround`, `coarseParentOf`, `greatCircleMetres`, `edgeLengthMetres`, etc.) reads correctly against `h3-js`; `H3_RESOLUTION.FINE=8` (~531 m), `COARSE=5` (~9.85 km) — both within §6.2's stated bands. `h3-js` is imported **only** in `spatial/cells.js` (grep across `src/` confirms exactly one importer). |
| 2 | Four availability classes incl. `FINISHING_SOON`, `QUEUE_CAPACITY_AVAILABLE` | **Confirmed.** `availabilityIndex.AVAILABILITY_CLASS` has exactly the four classes; `classify()`'s priority order (IDLE_READY → QUEUE_CAPACITY_AVAILABLE → CHARGING_INTERRUPTIBLE → FINISHING_SOON) is internally consistent with `expansion.js`'s `READY_CLASSES`/`WIDENED_CLASSES` split. |
| 3 | Secondary indices on capability/container class | **Confirmed.** `capabilityKey()`/`containerKey()` exist and are intersected in `membersOf()`. |
| 4 | `expansion.js` tiers 0–6, pruning-driven | **Confirmed**, read in full. All seven tiers present and gated correctly, including the fixed off-by-one (ring-0/ring-≥1 gating verified at lines 341–342 of `expansion.js`, matching the report's description exactly). |
| 5 | `omega.js` — Ω_terminal/Ω_policy | **Confirmed.** Injection-seam design verified: no `require()` of `pricing/` anywhere in `omega.js` (grep-confirmed); `checkOmegaNonNegative`/`0n`-when-inactive behaviour read and correct. |
| 6 | `lowerBound.js` | **Confirmed exact formula match** against §6.4's literal text — see §3 below. |
| 7 | Additive CU tolerance | **Confirmed.** `optimality_tolerance_cu` registered in `appendixA.json` (default 25 CU, range 0–5000, unit `"CU"` — not a ratio), pre-seeded by Phase 1, consumed additively in `expansion.js`'s `shouldStopExpanding()`. |
| 8 | Achieved-bound recording, clamped ≥ 0 | **Confirmed.** `achievedGapMilliCU` computed via `subtract` then clamped with `compareMilliCU(raw, 0n) > 0 ? raw : 0n`. |
| 9 | `ordering.js` + `clusterShare.js` | **Confirmed**, both read in full; `ordering.js` correctly delegates final-list and agent-in-cell comparators to the existing `determinism/ordering.js` rather than inventing new comparison logic. |
| 10 | Cold Index rebuild | **Confirmed present**, with the disclosed scope limitation (rebuilds from `AgentCellPosition`, not raw `Observation`) verified accurate — see §6 below. |
| 11 | `GET /api/diagnostics/candidates/:legId` | **Confirmed.** Read in full; additive, read-only, behind `authUser`, its own rate limiter, matches the `getRejections`/`getAgentEnergy` pattern exactly. Scope disclosure (`basis` field explaining LB-ranking vs. exact γ) is present in the actual response object, not just asserted in prose. |
| 12 | Admissibility build gate | **Confirmed and independently re-derived.** `candidateAdmissibility.test.js` read in full; the 2,560-scenario nested sweep (`routeFactor × speedFactor × extraWaitS × extraEnergyWh × extraCompletionS × realLambdaTime × betaDist × omegaPolicyCu × policySlackCu × [opportunityActive-dependent inner combinations]`) was independently recomputed by hand: 2⁹ × (1 + 4) = 2,560, plus 6 fixed tests (grid-non-trivial, boundary-exact, 3 register-prerequisite tests, 1 monotonicity test) = 2,566 test cases from this one file — matches the report's count exactly, not merely asserted. |
| 13 | Re-run at config publish | **Confirmed, with the report's own honest scoping verified accurate.** `a1LambdaFloorAdmissible` (A1) and `v2PolicyCreditCeilings` (V2) are wired into `validatePublish()` in `config/validators.js` (grep-confirmed at the call site, not just present as functions). `admissibilityGate.checkRegisterPrerequisites()` is a test-only re-composition, correctly **not** re-wired into `validatePublish()` since it adds nothing A1/V2 don't already cover; `checkOmegaNonNegative()` is correctly **not** wired into publish-time validation because `Ω_terminal` depends on the round's live price snapshot, which does not exist at publish time — this is not a gap, it is a category difference the report states accurately. |
| 14 | Determinism / index-cost independence | **Confirmed for determinism** (all comparators trace back to `determinism/ordering.js`/`fixedPoint.js`, no new comparator invented — grep-confirmed). **Index-cost independence (T9) is structural, not load-tested**, exactly as disclosed — no benchmark was run, and none exists to run it against at this phase. This is an honestly labelled gap, not a false claim. |
| 15 | Admissibility as build gate | **Confirmed** — see item 12. |

All 15 checklist items independently confirmed **Done**, with the caveats each carries in the
implementation report itself also independently confirmed accurate (not overstated).

---

## 2. Execution-plan compliance

**Files created** — all nine `candidates/*.js` modules, `spatial/cells.js`'s H3 addition,
`indexMaintainer.worker.js`, the diagnostics controller/route additions, the migration, and all
nine `tests/engine/candidates*.test.js` files were independently located and read in full (not
sampled). All present, all match the report's stated purpose per file.

**One real compliance gap, not disclosed in the report.** The execution plan's Phase 9 row states
under "Files to modify":

> `src/services/taskAssignment.service.js` (**replaced** — retires at Phase 15),
> `src/services/robotRegistry.service.js` (`robots:all` superseded by the cell-partitioned index)

Neither file was touched. Grep for `Phase 9`, `candidates/`, or `availabilityIndex` inside both
files returns zero matches — no superseded-banner comment, no docstring update, nothing.

This matters because every prior phase facing an identically-worded plan row (`costEvaluator.service.js`
at Phase 8, `robotValidator.service.js` at Phase 6, `task.service.js`/`taskRecovery.service.js` at
Phase 5) applied a **"superseded banner only"** header comment — zero executable-line change, purely
a traceability marker — and every one of those banner-only edits was independently re-verified by
the corresponding phase's reviewer (confirmed in this review's own read of the Phase 2/6/7/8
verification-report summaries). Phase 9's own report (§4) explicitly explains why four *other* named
files (`guards/tenets.js`, `guards/tierAssertions.js`, `TIERS.md`, `config/validators.js`) were
correctly left untouched — but is silent on `taskAssignment.service.js` and `robotRegistry.service.js`,
which the plan names in the same "Files to modify" column Phase 8 used for `costEvaluator.service.js`.
The report's own closing claim in §4 — "No file outside this list and the 'Files Created' list was
touched" — is technically true but conceals an omission rather than justifying it the way the report
justifies its other four omissions.

**Severity assessment:** zero behavioural or correctness impact — these are legacy files on the
strangler-pattern's still-live path, and skipping a documentation banner cannot regress anything.
This is a **Minor** finding, of the same class as documentation gaps flagged non-blocking in Phases
1 and 2. It should be closed with a two-line banner addition before Phase 9 is considered fully
closed out, but it does not block Phase 10.

**Configuration updates** — the plan requires `candidate.target_feasible`, `max_evaluated`,
`max_expansion_tiers`, `max_radius_by_sla_class`, `optimality_tolerance_cu`, `finishing_soon_horizon`
to be registered. All six are present in `src/engine/config/register/appendixA.json` (lines
49–69) with correct defaults (12, 200, 5, null, 25 CU, 300 s respectively) and correct ranges.
These were pre-seeded by Phase 1's own "seed the full Appendix A register" scope (confirmed by file
modification timestamp predating this phase and by Phase 1's verification report, which already
lists Appendix A as seeded in full) — Phase 9 correctly needed to add nothing here, and added
nothing here. Not a gap.

**Database migrations, Redis changes, REST API changes, background workers** — all match the plan's
Phase 9 row exactly (see §5–§8 below for independent verification detail).

**Dependencies (Phases 2, 7, 8)** — correctly consumed without modification: `cost/cDelay.js`
(Phase 8) is imported and used as-is in `lowerBound.js`/`expansion.js`; `energy/consumption.js`'s
`COEFFICIENT.DIST` (Phase 7) is read, not redefined; `spatial/cells.js`'s Phase 2 opaque-token
functions are extended, not replaced (confirmed side-by-side in the same file).

---

## 3. Architecture compliance — §6, verbatim cross-check

The full text of §6.1–§6.6 was read directly from `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` (lines
1413–1624), not paraphrased from the implementation report, and compared term-by-term against the
code.

**§6.4's formula, exact match confirmed.** The architecture's literal formula:

```
LB(a, l) =   ( great_circle(position(a), first_stop(l)) / v_max(class(a)) ) · λ_min
           + wait_until_available(a) · λ_min
           + E_min(a, l) · cu_per_wh
           + C_delay[l]( earliest_possible_completion(a, l) )
           − Ω_terminal(region, decision_time)
           − Ω_policy
```

`lowerBound.js`'s `lowerBound()` implements exactly these six terms, in this order, with no added
or missing term: `travelAndWait = apply(λ_min, distance/maxSpeed + wait, "s")`, `energyTerm =
apply(cu_per_wh, κ·β_dist·distance, "Wh")`, `delayResult = cDelay.forLeg(leg, earliestCompletion,
...)`, then `subtract(positiveSum, correction.milliCU)` where `correction` is `omega.js`'s combined
`Ω_terminal + Ω_policy`. Confirmed by direct code read, not inference from comments.

**The C_risk/C_lifecycle/C_churn omission is architecture-compliant, not a shortcut.** §6.4's
sign-safety table groups `C_direct, C_risk, C_lifecycle` as "≥ 0 always... safe to bound loosely"
and separately states `C_churn` is "safe to omit entirely." Since the six-term formula contains no
explicit term for `C_risk` or `C_lifecycle`, the only internally-consistent reading is that all
three are bounded at their trivial zero floor (i.e., omitted) — exactly what `candidateAdmissibility.test.js`
asserts (claim 5) and exactly what the implementation report claims in its own admissibility table.
This was checked against the primary text directly, not accepted on the report's authority alone.

**Ω_terminal / Ω_policy corrections** — formula in `omega.js` matches §6.4's derivation
(`Ω_policy = cost.policy.max_total_credit`, derived at publish time via `config/derived.js`'s
`derivePolicyTotalCredit()`, resolved not recomputed; `Ω_terminal` consumed as injected data from
the Tier 2 composition root, never statically imported). The Tier 1/Tier 2 boundary reasoning in
the module docstring was checked against `TIERS.md`'s own stated pattern for `cost/phi.js` and
found consistent — the same `registerTerm()`/injection shape, not a special case invented for this
module.

**§6.6 canonical ordering** — three distinct orderings (cell-visiting order by bound then cell id;
agent-within-cell by `agent_id` alone; final list via the shared `compareScored`) are each present
in `ordering.js` as separate, named functions rather than conflated into one comparator, matching
§6.6's literal three-part requirement.

**§6.5 candidate sharing** — `clusterShare.js`'s `clusterLegs()` (coarse-cell partition) and
`sharedIndexReader()` (memoising `smembers` wrapper) independently verified to match §6.5's stated
mechanism ("candidate sets are computed once per cell cluster and shared").

**§27 item 1 / B5 — H3 resolved correctly, and the "B5" citation is accurate, contrary to an initial
concern raised during this review.** `IMPLEMENTATION_EXECUTION_PLAN.md` line 960 independently
confirms the execution plan itself defines `B5` as "Spatial index primitive (H3 vs S2 vs
site-local graph zones) | Phase 9 | §6.2, §27 item 1 | H3 preferred outdoors for uniform k-ring
metrics" — this is the execution plan's own risk/blocking-decision table, distinct from
`NEXT_GENERATION_ASSIGNMENT_ENGINE.md`'s unrelated `B5` failure-mode code in §18.3 (Routing
Service outage). Phase 9's citation of "B5" for the H3 decision is citing the execution plan
correctly. (An initial research pass during this review flagged this as a possible mislabeling
before the execution plan's own §6 table was located and read — recorded here so the false lead
is not silently dropped.)

**§1.8 tier-list gap — correctly surfaced by the implementation, not concealed.** Independently
re-read §1.8 in full: no §6 mechanism (candidate generation, Availability Index, hierarchical
expansion, admissible bound) is named in any of the three tier lists. This is a genuine gap in the
frozen specification itself, not an implementation defect. Phase 9's report (§10) discloses this
directly ("confirmed by re-reading §1.8 directly rather than assuming") and resolves it via
`TIERS.md`'s own stated Convention 1 (undeclared modules default to Tier 1, the conservative
direction). `candidatesSchema.test.js` asserts this tier placement mechanically for all seven
modules. This is the correct, conservative disposition and matches how this review would have
resolved the same ambiguity.

**Cache-authority rule (§3.3) and Cold Index (§18.5)** — independently confirmed the Availability
Index is treated as advisory throughout: every Redis write in `availabilityIndex.js` is wrapped in
try/catch degrading to a no-op failure result (`applyPosition`'s catch block, `membersOf`'s catch
block), matching §3.3's "loss must be survivable" and I16. `rebuildFromRecords()` exists and is
idempotent by construction (keyed by each record's own current cell/class, not accumulated).

---

## 4. Module ownership and dependency direction

- `tests/engine/phase0Scaffold.test.js`'s `PHASE_9_OWNED = ["candidates/"]` independently read and
  confirmed added, following the exact same pattern as `PHASE_6_OWNED`/`PHASE_7_OWNED`/`PHASE_8_OWNED`
  before it. The cumulative `LANDED_PHASE_OWNED` walk test was re-run (part of `npm test`) and
  passes.
- `src/engine/solve/` and `src/engine/intake/` independently confirmed **empty** (only `.gitkeep`
  in each, verified by direct directory listing) — no Phase 10 leakage.
- `h3-js` independently confirmed imported in exactly one file (`spatial/cells.js`) via a
  repository-wide grep for `require("h3-js")` / `require('h3-js')`.
- `omega.js` independently confirmed to contain no `require()` of anything under `pricing/`.
- `guards/tenets.js`'s `DECISION_PATH_SCOPE` independently confirmed to have already listed
  `"src/engine/candidates/"` **before** Phase 9 — this file is not in the modified-files set
  (absent from `git status` diff list) and the surrounding array (`feasibility/`, `cost/`, `plan/`,
  `solve/`, `determinism/`, `energy/`) is clearly Phase-0-authored, anticipating the full eventual
  decision-path tree rather than being incrementally amended per phase. The claim in the
  implementation report that this was "already listed... before this phase began" is independently
  confirmed true, not merely asserted.

## 5. Runtime behaviour

`ENGINE_ENABLED` remains `false`. `indexMaintainer.worker.js` independently confirmed **not**
referenced in `server.js` or `src/app.js` (grep, zero matches in both). The only new reachable
runtime surface is `GET /api/diagnostics/candidates/:legId`, confirmed read-only (no write
operation anywhere in `getLegCandidates`), behind `authUser` (via `diagnostics.routes.js`'s
`router.use(authUser)`), and its own rate limiter (`diag_candidates`, 120/60s — matching the
point-read pattern of `/energy/:agentId`, not the heavier aggregate pattern of `/rejections`).

## 6. Database

`AgentCellPosition` migration independently verified: read the full `migration.sql` and the full
`schema.prisma` model definition side by side. The `CREATE TABLE`/`CREATE INDEX`/`ADD CONSTRAINT`
(foreign key) statements are consistent with the schema; the two hand-written `CHECK` constraints
(`availabilityClass IN (...)`, WGS84 coordinate range) are present in the migration and absent from
the schema (as expected — Prisma cannot express CHECK constraints), matching the report's claim.
`candidatesSchema.test.js`'s own automated byte-diff against `prisma migrate diff --from-empty`
was re-run as part of the independently-executed `npm test` and passes, which is a stronger
verification than manual inspection alone. `npx prisma validate` independently re-run and passes.
Migration additive-only (no `DROP`/`ALTER COLUMN`, confirmed by direct read).

Cold Index rebuild's disclosed limitation (`rebuildFromRecords()` consumes `AgentCellPosition`
records, not raw `Observation` rows) independently confirmed accurate by reading
`indexMaintainer.worker.js`'s `rebuildIndexFromMirror()`, which reads only
`prisma.agentCellPosition.findMany()`. This is a legitimate, disclosed interpretive choice (§6.2's
"rebuildable from the observation log" is satisfied in spirit — `AgentCellPosition` is itself
durable state derived from the observation log by the same worker), not a defect, and the report's
own framing of it as worth a decision "at whichever phase first exercises Cold Index in anger" is a
reasonable disposition, not an evasion.

## 7. Redis

All four new key prefixes (`engine:idx:{shard}:{fineCell}:{class}`, `engine:idx:{shard}:{coarseCell}:{class}`,
`engine:idx:cap:{shard}:{capabilityClass}`, `engine:idx:container:{shard}:{containerClass}`)
independently confirmed present in `availabilityIndex.js`, using only the existing `sadd`/`srem`/`smembers`
primitives (no new `kv` method added — confirmed by reading every `deps.kv.*` call site in the file).
Fail-open behaviour on read/write failure independently confirmed via the `try { ... } catch { return
{ ok: false, ... } }` structure in both `applyPosition()` and `membersOf()`.

## 8. Socket.IO

None added — confirmed by absence (no `io.emit`/`socket.on` reference anywhere under `src/engine/candidates/`
or `src/workers/indexMaintainer.worker.js`).

## 9–11. APIs, Concurrency, Determinism

Covered in §1/§5/§4 above. No new locking or concurrency primitive introduced; the Availability
Index's advisory nature and commit-time feasibility re-verification (an existing Phase 3/Phase 6
guarantee, not something Phase 9 introduces or depends on for correctness) mean Phase 9 adds no new
concurrency surface. Determinism independently confirmed structurally sound: no direct `Date.now()`,
`performance.now()`, or `Math.random()` token found in `expansion.js`, `lowerBound.js`, `omega.js`,
or `ordering.js` (grep-confirmed across all four files) — every time value is either a caller-supplied
argument or routed through the injected `elapsedMs()` reference.

## 12. Failure handling

Consistent with the cache-authority rule throughout (§6/§7 above). `indexMaintainer.worker.js`'s two
extension seams (`chargingStatusFor`, `capabilityAndContainerClassesFor`) independently confirmed to
default to conservative values that only **narrow** eligibility, never fabricate it — read directly
in `assembleRecord()`'s default branches.

## 13. Regression safety / 14. Build gates / 15. Test suite

**Independently re-executed, not trusted from the report:**

```
npm run gate:tiers   → PASS — 214 modules, 261 edges, 0 violations   (report claims: identical)
npm run gate:params  → PASS — 134 modules, 186 params, 0 bare consts (report claims: identical)
npm run gate:tenets  → PASS — 211 modules, 0 violations              (report claims: identical)

npm test (all lanes) → 78 suites / 4,705 tests, 0 failures           (report claims: identical)
  test:engine         → 53 suites / 4,487 tests                     (report claims: identical)
  test:legacy         → 22 suites / 169 tests, unchanged             (report claims: identical)
  test:gates          → 3 suites / 49 tests                         (report claims: identical)
```

Every number in the report's §11 was independently reproduced exactly, run fresh in this review's
own shell, not copied from the report. The 2,566-scenario admissibility sweep's count was
independently recomputed by hand from the nested-loop structure (§1, item 12 above) and matches.

No discrepancy found between claimed and actual test/gate results anywhere.

## 16. Confirm nothing from Phase 10 implemented

**Confirmed.** `src/engine/solve/` and `src/engine/intake/` contain only `.gitkeep`. No round-loop,
coordinator, min-cost-flow, or column-regime code exists anywhere in the tree. `expansion.js`
correctly takes `evaluateExact` as an injected async function rather than assembling the
feasibility → Plan Builder → Φ → γ pipeline itself, which is the structural form of not pre-empting
Phase 10 — independently verified by reading the function signature and its call sites, not merely
the module docstring's claim.

---

## Summary of findings

| # | Severity | Category | Affected files | Recommendation |
|---|---|---|---|---|
| 1 | Minor | Execution-plan compliance / documentation | `Backend/src/services/taskAssignment.service.js`, `Backend/src/services/robotRegistry.service.js` | Add the same "superseded banner only" header comment convention every prior phase applied to its own named-but-unmodified legacy files (Phase 5's `task.service.js`/`taskRecovery.service.js`, Phase 6's `robotValidator.service.js`, Phase 8's `costEvaluator.service.js`). Zero behavioural change required — a documentation/traceability fix only. Does not block Phase 10. |

No other issues — blocking, moderate, or minor — were found. Every claim in
`PHASE_9_IMPLEMENTATION_REPORT.md` that was checked (all of them) was independently confirmed
accurate, including its own self-disclosed limitations (§13 items 1–5), which this review found to
be honest and correctly scoped rather than minimized.

---

## Final decision

# PASS WITH MINOR ISSUES

One issue (documentation/traceability only, zero behavioural impact) listed above.

**Phase 10 may begin.** The one finding does not touch anything Phase 10 depends on — it concerns
two legacy files on the still-live strangler path that Phase 10 does not read from or write to.

---

*End of Phase 9 Independent Verification Report.*
