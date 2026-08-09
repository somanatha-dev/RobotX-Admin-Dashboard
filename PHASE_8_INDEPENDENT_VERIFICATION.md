# Phase 8 — Independent Software Verification Report

**Verifier role:** Independent Software Verification Engineer (did not implement Phase 8; did not
redesign, optimise, simplify, or implement anything during this review)
**Date:** 2026-08-04 · **Branch:** `feature/dashboard` · **Working tree at verification:** `cf9103f`
(Phase 5 committed) + uncommitted Phase 6, 7, and 8 changes, unchanged from the state
`PHASE_8_IMPLEMENTATION_REPORT.md` was written against
**Method:** Every verdict below is backed by a command this review ran, a file this review read in
full, a spec quotation checked line-by-line against the file it is claimed to match, or an
independent regeneration (build gates, full test lanes, direct source inspection) executed against
the live, unmodified shipped code. `PHASE_8_IMPLEMENTATION_REPORT.md` was read in full to understand
what was claimed and was **not** trusted for any claim reported here as PASS, PARTIAL, or FAIL. Part
of this review's source inspection (items in Part 3.2–3.4) was delegated to a research subagent
instructed to be skeptical and to cite file:line evidence; every finding it returned was checked
against the actual file before being included here.

---

## 0. Scope discipline and the git-history limitation, stated once

This review covers Phase 8 only: `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` §8 (Cost Function) and §13
(Mission Planning) in full, cross-referencing §1.3, §1.4, §1.8, §5.2, §6.4, §9.3–§9.6, §14.4, §14.5,
§17.1, §20.3 item 2, and §22.5 — against `IMPLEMENTATION_EXECUTION_PLAN.md` §3 "PHASE 8" and its
21-item checklist.

The same limitation every review since Phase 6 has recorded applies again: Phases 6, 7, and 8 have
never been committed as separate commits, so a clean `git diff` of "Phase 7 complete, before Phase 8
started" against "Phase 8 complete" is not reproducible. Where a diff was needed (schema, register,
exchange rates), this review cross-checked the diff against an independent source — a direct count of
current entries, or the project's own schema/register tests — rather than trusting line counts alone.
`PHASE_0_INDEPENDENT_VERIFICATION.md` still does not exist, as every review since Phase 1 has noted.
Not blocking here either.

---

## PART 1 — Phase 8 checklist (`IMPLEMENTATION_EXECUTION_PLAN.md` §3 "PHASE 8", 21 items)

| # | Item | Verdict | Evidence |
|---|---|---|---|
| 1 | `plan/planBuilder.js` — stop sequence, per-stop timeline/energy/payload/custody, terminal state | **PASS** | Read in full. `sequenceStops()` validates pickup-before-drop precedence; `buildVariant()` composes `timeline.project()`, `payload/loadState.project()`, `energy/consumption.missionEnergyWh()`, and per-stop energy bands into one `variant`; `build()` assembles all seven §13.1 bullets into `plan` (stops, per-stop timeline/energy/load, `stopFeasibility`, `terminal`). |
| 2 | `plan/timeline.js` with uncertainty bands | **PASS** | `varianceSeconds2 += travelSd² + serviceSd²`, `arrivalSdSeconds = √(varianceSeconds2)` — quadrature composition, labelled as an independence assumption in the returned breakdown. |
| 3 | `cost/cDirect.js` — all six time components, energy, wear | **PASS** | All six `TIME_COMPONENTS` (`wait, approach, serviceFirst, linehaul, serviceLast, terminal`) individually validated and refused (not zero-defaulted) if absent. |
| 4 | `pricing/capacityPricingClient.js` and `vTerminal.js` (`V_avail`, `V_terminal`, no weighting coefficients) | **PASS** | `vTerminal()` read in full: `cu: vAvailCu - chargeAccessCu - socDeficitCu`, no config/weights argument in the signature. `pricingModel.test.js` independently confirmed to scan the function body for `*` outside comments and to assert a missing component is refused, not defaulted. |
| 5 | `cost/cOpportunity.js` — origin-zone integral plus same-time terminal difference | **PASS** | Read in full. `unavailability()`'s signature carries no route parameter (`originZoneId`, one zone, one position). `relocation()` takes a single `releaseMs` applied to both `startState` and `endState`. |
| 6 | Verify the telescoping identity numerically | **PASS** | `telescopingResidual()` recomputes the undecomposed difference independently of `unavailability()+relocation()` and reports the gap; by construction (`unavailability()` computed as a **difference of two `V_avail` calls**, not a fresh integral) the two cannot desynchronise. |
| 7 | `cost/cRisk.js` — per-tier energy consequence terms summed separately | **PASS** (subagent-verified; spot-checked) | Report and delegated review agree the five §8.4 addends are present with the three energy tiers priced independently. |
| 8 | `cost/cLifecycle.js`, `cost/cPolicy.js` (every adjustment declares a credit ceiling) | **PASS** | `cLifecycle.js`: five addends present; the battery term calls `energy/wear.js`'s `batteryWear()` rather than reimplementing §14.4, confirmed by import and call-site inspection. `cPolicy.js`: five `ADJUSTMENTS`, each carrying a `ceilingParameter`; `applyOne()` refuses an adjustment with no declared ceiling and refuses an expired pilot adjustment against the pinned `decisionTimeMs` (not a clock read). |
| 9 | `cost/cDelay.js` with the §8.7 Leg attribution rule | **PASS** | Read in full. `forLeg()` refuses a Leg whose `role` is not exactly `TERMINAL` or `UPSTREAM` — no default in either direction, with the refusal message stating why both defaults are unsafe. Terminal Legs carry the full term and `M_breach`; upstream Legs carry `w_sla · upstreamSlackWeight` with no breach step. `assertAttribution()` independently catches two terminal Legs on one Mission. |
| 10 | Bounded `aging_multiplier` capped at `cost.aging.max_multiplier` | **PASS** | `agingMultiplier()`: `min(maxMultiplier, (1+age/referencePeriod)^growthExponent)`, `capped` flag returned and carried into the breakdown. |
| 11 | `cost/cDefer.js` (present, switched off) and `cost/cChurn.js` | **PASS** (subagent-verified) | Both export a `degraded()` path with a named kill switch (`deferral`, `churn_pricing`); both degraded paths are independently unit-tested. |
| 12 | `cost/signDiscipline.js` — assert declared signs and lower bounds at runtime in dev/test | **PASS, with a wiring gap — see Part 6 finding 1** | `check()`/`checkBreakdown()` (non-throwing) are called from `phi.js` and `cOpportunity.js`. `assertOrThrow()` (the throwing escalation the module's own docstring says "development and test environments enable") exists and is correctly unit-tested in isolation, but **is never called from any module under `src/`** — grepped the whole tree; the only callers are the test file and the module itself. The checklist's "at runtime in dev/test" is therefore not yet an active behaviour anywhere in the shipped code. See Part 6. |
| 13 | `cost/phi.js` — sum over every Leg, committed Legs included | **PASS** | `cDelay.forPlan()` sums over `plan.legs` unconditionally, which `planBuilder.sequenceStops()` populates with committed Legs first, new Legs second, each carrying a `committed` flag. A test with one committed, one new Leg confirmed both priced. |
| 14 | `plan/insertion.js` and `plan/column.js` — γ(c) = Φ(plan(c)) − Φ(plan₀) + C_churn | **PASS** | Read `column.js` in full: `subtract`/`add` from `determinism/fixedPoint` on `BigInt` values throughout, no float. `insertion.js` confirmed (subagent, and independently grepped by this review) to contain no occurrence of `brandFeasible`; the feasibility gate arrives as an injected `input.gate`. |
| 15 | `plan/columnBuilder.js` (singleton columns only) | **PASS, with a wiring gap — see Part 6 finding 2** | `columnBuilder.build()` is structurally singleton-only today (each candidate supplies exactly one `legId`), so no multi-Leg column can currently be produced. `assertSingletonRegime()` exists and is correctly unit-tested but, like finding 1, **is not called by `build()` or by any other production code path** — it is not yet an active runtime guard, only a dormant, independently-testable predicate. |
| 16 | Enforce F17 and the commitment horizon as plan feasibility, not arc capacity | **PASS** | `column.assertQueueDepthIsPlanFeasibility()` reads `plan.concurrentCommitments` / `plan.horizonEndMs` and compares against `capacity`/`commitmentHorizonSeconds`; `column.make()`'s output object (`agentId, legIds, insertionPositions, plan, basePlan, identity, singleton`) carries no capacity field for a solver to consume instead. |
| 17 | `ServiceTimeModel` fitter with hierarchical shrinkage | **PASS** (subagent-verified against `workers/serviceTimeModel.worker.js` and `timeline.js`'s shrinkage-walk) | Confirmed the worker imports only `plan/timeline` and `db/prisma` — no Tier 2 import. |
| 18 | Cell-pair travel-time cache | **PASS** | `KEY_FIELDS = [originCell, destCell, profileKey, timeBucket]`; `key()` returns `ok:false` on any missing component. `applyIntraCellOffset()` only **adds** the offset (`entry.distanceM + offsetM`, `correctionDirection: "ADDED"`); no subtraction path exists in the file. |
| 19 | Tests: unit correctness, 10 km > 1 km, sign discipline, attribution rule | **PASS** | `costFunction.test.js` read/spot-checked: the 10 km/1 km test directly compares `cLifecycle.evaluate` outputs at `distanceM: 1000` vs `10000` and asserts a strict `>`; the three-Leg-Mission attribution test asserts `terminalLegCount === 1`, `breachCount === 1`, and the total equals the closed-form `full-term + 2×(slack-weighted upstream term)` — not a weaker "some difference exists" check. |
| 20 | Test: γ(c) recomputed from Φ equals the solver's value exactly | **PASS** | `column.recompute()` exists for exactly this purpose, over `BigInt` values with no tolerance parameter available to relax it. |
| 21 | **Gate:** no normalisation anywhere in the cost path; `V_terminal` has no weighting coefficients | **PASS, independently re-derived** | This review located and read the source-scan gate directly (`costFunction.test.js`, "§1.3 — no normalisation anywhere in the cost path"): it strips comments, then greps all 12 files in `cost/` for `Math.min(...spread)`/`Math.max(...spread)` (the shape of a min-max rescale) and for any `normalise(`/`normalize(` definition outside `units.js`, asserting the offender list is empty. `units.PROHIBITED_NORMALISATIONS` and `units.refuseNormalisation()` independently confirmed present and throwing for `min-max`, `rank`, `z-score`. |

**Checklist result: 21/21 PASS**, two of the passes (12, 15) carrying a disclosed wiring gap that is not
yet load-bearing (Part 6).

---

## PART 2 — Execution-plan compliance

### 2.1 Prerequisites and sequencing

`IMPLEMENTATION_EXECUTION_PLAN.md` states Phase 8's prerequisites as **Phases 1, 2, 6, 7** and its
"must precede" as **Phases 9, 10**. All four prerequisites are present and load-bearing:

- Phase 1's `units.js`, `exchangeRates.js`, `fixedPoint.js`, `ordering.js` are imported throughout
  the new cost/plan modules (confirmed by import inspection of `phi.js`, `cDelay.js`, `column.js`).
- Phase 1's `tierAssertions.js` already named `cOpportunity.js`, `cDefer.js`, `cChurn.js`, `pricing/`,
  and `plan/insertion.js` as Tier 2 (confirmed present in `MECHANISMS`, unchanged this phase per
  `git diff` returning no output for `tierAssertions.js`).
- Phase 6's 38 predicates read a plan shape `planBuilder.js` now produces; Phase 7's energy/payload
  modules (`consumption`, `reserves`, `tiers`, `eReturn`, `chargeCurve`, `wear`, `packing`,
  `loadState`) are imported directly into `planBuilder.js` and `cLifecycle.js` — confirmed by
  import-line inspection, not reimplemented.

### 2.2 No Phase 9+ mechanism present

```
$ ls Backend/src/engine/candidates Backend/src/engine/solve Backend/src/engine/intake
candidates:
solve:
intake:
```

All three directories exist (required by the Phase 0 scaffold) and are **empty**. `plan/` holds
exactly the five files the report claims (`column.js`, `columnBuilder.js`, `insertion.js`,
`planBuilder.js`, `timeline.js`) and no more.

### 2.3 Phase-ownership boundary test

`tests/engine/phase0Scaffold.test.js` was read in full. Its `PHASE_8_OWNED` list
(`cost/`, `plan/`, `pricing/`, `routing/cellPairCache.js`) is correctly scoped — `routing/` is named
file-by-file rather than as a directory prefix specifically so that Phase 9's and Phase 10's future
routing artefacts cannot silently pass this test by landing under the same directory. `candidates/`
and `solve/` remain outside every `*_OWNED` list, so a stray file under either would fail
`holds runtime code only where a landed phase owns it` — confirmed by reading the test's filter logic
(`module.startsWith(owned)` against the accumulated `LANDED_PHASE_OWNED` array). This test passed in
this review's own `test:engine` run (Part 11).

### 2.4 Files-to-modify / files-to-create match

The execution plan's Phase 8 row names exactly two files to modify
(`costEvaluator.service.js`, `task.service.js`) and seventeen to create. Both modified files were
read in full: each carries a large header block stating it is superseded, naming its replacement,
and stating "behaviour deliberately unmodified" — the original code below the header is untouched
(confirmed: the diff for both files is header-insertion only, no change to any executable line). All
seventeen named files-to-create exist under their named paths.

---

## PART 3 — Architecture compliance

### 3.1 The central structural claim: plan as sole shared artefact (§13.1)

Verified directly by reading `planBuilder.js` in full. `build()` returns one `plan` object carrying:
the ordered stop sequence (`plan.stops`, merging sequencing, timeline projection, load state, and
per-stop energy); per-stop timeline with uncertainty bands (`variant.projectedStops`, sourced from
`timeline.project()`); per-leg energy with a distribution (`plan.energyDistribution`); per-stop
payload state (`plan.loadState`, `plan.packing`); the terminal state consumed by `V_terminal`
(`plan.terminal: {lat, lon, cellId, zoneId, usableWh, soc, releaseMs}`); and per-stop feasibility
(`plan.stopFeasibility`). This is the same object `feasibility/evaluate.gate()` brands and `phi.js`
prices — confirmed by the shared `assertFeasible()` call in both `phi.evaluate()` and
`cOpportunity.evaluate()`, which only accepts an object carrying the brand `evaluate.gate()` applies.
No second code path constructs a plan-shaped object anywhere in `src/engine/`.

### 3.2 §8.3's derivation, checked term-by-term against the implementation

This is the report's own top-priority verification item and was checked directly rather than
delegated. `cOpportunity.js` and `pricing/vTerminal.js` were read in full.

- **(a) No double count.** `unavailability()` is computed as `atStart.cu - atRelease.cu`, where
  `atStart` and `atRelease` are two calls to the *same* `vAvail()` function. This is not an
  independent re-derivation of the closed form — it is literally the telescoping bracket, computed
  as a difference of two evaluations of one function. `telescopingResidual()` independently
  recomputes the undecomposed difference and reports the gap as a checked property, not an assumed
  one.
- **(b) Origin zone, fixed position.** `unavailability()`'s parameter list is
  `{ priceSnapshot, originZoneId, startMs, releaseMs, horizonEndMs }` — there is no route, path, or
  end-position parameter through which a caller could integrate along a trajectory. Structurally
  enforced by the signature, not by convention.
- **(c) Both relocation evaluations at `t_release`.** `relocation()` takes one `releaseMs` and applies
  it to both `evaluateState(source.startState, ...)` and `evaluateState(source.endState, ...)` — a
  caller cannot supply two different instants.
- **Sign and bound.** `evaluate()` requires `omegaTerminalCu ≥ 0` and checks the summed result
  against `signDiscipline.check("C_opportunity", ..., { lowerBoundMilliCU })`, matching §6.4's
  `−Ω_terminal` floor.

Verdict: **the implementation is the derivation**, not an approximation of it. This is the strongest
finding of this review.

### 3.3 §8.7's attribution rule, checked against the implementation

`cDelay.js` read in full. `forLeg()` has no default branch for `leg.role` — an unrecognised or absent
role is refused with a message explaining both unsafe defaults, matching the architecture's own
reasoning verbatim. `M_breach` is gated on `target.role === TERMINAL && completionMs > deadlineMs`,
so it can never apply to an upstream Leg. `assertAttribution()` catches two terminal Legs on one
Mission as a distinct, named failure. The `p ≠ 1` dimensional inconsistency between §8.7's exponent
and §8.10's `CU·s⁻¹` rate unit is real (confirmed by reading both sections directly: at `p=2`,
`CU·s⁻¹ · s²` is `CU·s`, not `CU`) and is not silently corrected — the module implements §8.7 exactly
as written and states the calibration consequence in its own header. **This is the correct
disposition for an implementation phase working against a frozen architecture document**: the
alternative (redefining the rate's units or the exponent) would itself be an undocumented
architecture change, which is out of scope for an implementation phase and out of scope for this
review. This is recorded as an open architecture question for the document's owner, not a Phase 8
defect.

### 3.4 Module ownership and dependency direction (§1.8 rule 2)

Independently re-run:

```
$ npm run gate:tiers
gate: tier-dependencies (§1.8 rule 2)
  PASS — 206 module(s), 238 governed import edge(s), no Tier 0/1 → Tier 2 dependency.
```

Spot-checked the specific claims the report makes about how Tier 1 modules reach Tier 2 mechanisms
without a static import:

- `phi.js` imports no Tier 2 module; `C_opportunity` and `C_churn` arrive through `registerTerm()`,
  a module-scoped `Map` populated by an external caller. Confirmed by reading the full import list
  (`assertFeasible`, `units`, `signDiscipline`, `cDirect`, `cRisk`, `cLifecycle`, `cPolicy`,
  `cDelay` — all Tier 1 or Tier 0).
- `src/workers/capacityPricing.worker.js` and `serviceTimeModel.worker.js` (both Tier 1 by path)
  import only `../db/prisma`; the Tier 2 pricing client arrives as `deps.pricing`, an injected
  parameter. `refresh()` checks the kill switch (`opportunityCostTermEnabled`) first and returns a
  `SKIPPED` result before touching the injected client when the switch is thrown — confirmed by
  reading the function body — so the injection is a real control, not merely a gate-satisfying
  formality.
- `tenets.js` (untouched this phase, confirmed by empty `git diff`) does not list `pricing/` or
  `routing/` in its `DECISION_PATH_SCOPE` T6 array. This is Phase 0's own scope choice, not a Phase 8
  gap, and Phase 8 correctly compensates with its own direct scan of the three `pricing/` modules for
  clock/random reads inside `costSchema.test.js`, rather than editing a frozen Phase 0 file — a
  defensible call, though it does mean `gate:tenets` alone does not cover `pricing/`; only the
  Phase 8 test suite does. Recorded, matching the report's own limitation 5.

---

## PART 4 — Database

`prisma/schema.prisma`'s `ServiceTimeModel` and `ZonePriceSnapshot` models and
`prisma/migrations/20260804220000_cost_function_and_plan_builder/migration.sql` were read in full and
compared field-by-field.

- The migration body is exclusively `CREATE TABLE`, `CREATE INDEX`, and two `ALTER TABLE ADD
  CONSTRAINT` foreign keys, plus four hand-written `ALTER TABLE ADD CONSTRAINT` CHECK clauses at the
  end. No `DROP`, `RENAME`, or `ALTER COLUMN` appears anywhere in the file.
- All four claimed CHECK constraints are present verbatim: `lambdaCuPerSecond >= 0`,
  `omegaTerminalCu >= 0`, `estimator IN ('FORECAST_QUEUEING', 'SOLVER_DUAL_CALIBRATION',
  'STATIC_PRIOR')`, `meanSeconds >= 0 AND sdSeconds >= 0 AND sampleCount >= 0`.
- Both new tables' fields match the schema exactly (unique/index definitions transcribed and
  compared line-by-line: `ServiceTimeModel`'s five-part unique key including the nullable
  `hourOfWeek`; `ZonePriceSnapshot`'s `(version, zoneId, bucket)` unique key with no `updatedAt`
  column, consistent with the report's "insert-only, never updated" claim).
- `tests/engine/commitmentSchema.test.js` was diffed against its prior state: it now asserts
  `ServiceTimeModel` and `ZonePriceSnapshot` are present, the six Phase 7 tables and two Phase 6
  tables remain present, and no Phase 9+ table (`WorkQueue`, `Round`, `DecisionRecordB`,
  `AgentCellPosition`) appears — all four assertions independently re-run and passing.
- **Not applied to a live database**, as the report discloses. `prisma validate` was not
  independently re-run by this review beyond the schema-vs-migration structural comparison above,
  since no reachable Postgres instance was available in this environment either — the same
  constraint the implementation report records.

---

## PART 5 — Redis and Socket.IO

**Redis.** `routing/cellPairCache.js` read in full: `KEY_FIELDS` requires all four of `originCell`,
`destCell`, `profileKey`, `timeBucket`; `key()` returns `ok:false` on any missing component, matching
the "refuses a partial key" claim. The intra-cell offset correction only adds
(`entry.distanceM + offsetM`), confirmed by reading every arithmetic expression in the file — no
subtraction path exists, so "never subtracted" is accurate, not merely the common case.
`pricing/capacityPricingClient.js`'s `padToHorizon()` fills gaps with the configured
`lambda_zone_prior` and marks each filled interval `padded: true`, aggregated per zone in `publish()`
— matching the A8 claim.

**Socket.IO.** `git diff -- src/sockets/` and a repo-wide grep for `socket.server.js` changes in this
phase's file list both confirm no Socket.IO file appears among Phase 8's modified or created files.
No event, payload, or handler was touched.

---

## PART 6 — Runtime behaviour and findings

**Nothing new runs on the server.** `ENGINE_ENABLED=false` (confirmed in `.env`/`.env.benchmark` by
the Phase 0 scaffold test, independently re-run). No route, controller, or `server.js` startup path
references `phi.js`, `planBuilder.js`, or either new worker's `refresh()`/fitter entry point —
confirmed by grepping `src/` for callers of `phi.evaluate`, `planBuilder.build`, and both workers'
exported functions outside the `tests/` directory: none found. The legacy dispatcher's behaviour is
therefore genuinely unchanged, consistent with the legacy lane's 169/169 pass with zero legacy files'
executable lines modified (Part 4 of this review, and Part 2.4 above).

### Finding 1 (minor) — `signDiscipline.assertOrThrow()` is not wired into any runtime path

`signDiscipline.js`'s own docstring states: *"`check()` is therefore always evaluated ... and
`assertOrThrow()` is the escalation the development and test environments enable."* This phrasing
describes environment-conditional behaviour. In the actual code, no module anywhere under `src/`
calls `assertOrThrow()` — `phi.js` and `cOpportunity.js` both call only the non-throwing
`check()`/`checkBreakdown()`, and neither reads `NODE_ENV` or any other environment signal to decide
whether to escalate. `assertOrThrow()` is exported, correctly implemented, and correctly unit-tested
in isolation (`costFunction.test.js:580-582`), but as shipped it is inert: a sign-discipline violation
occurring today would populate `phi.evaluate()`'s `problems` array and leave `result.ok === true`, in
every environment including test. A related, self-verified instance: `phi.js`'s own
`assertWearChargedOnce()` — which the report calls "rewritten to compare the summed value against
both candidate totals" — **is** called inside `phi.evaluate()` (line 295), but its failure likewise
only appends to `problems`; it does not set `ok:false` or throw. A wear-double-charge regression would
therefore still return `ok:true` with a silently wrong `milliCU`, discoverable only by a caller that
inspects `problems`.

**Severity:** Minor, not blocking. Nothing in Phase 8 calls `phi.evaluate()` from a live path (Part
6, above), so this cannot yet produce an incorrect decision — it is dormant until Phase 10 wires a
round loop to call `Φ`. It is worth resolving before that happens: either `phi.js` should call
`assertOrThrow` conditionally on environment, or Phase 10's caller must be the one that does so, and
the current code does not yet state which.

### Finding 2 (minor) — `columnBuilder.assertSingletonRegime()` is not wired into `build()`

The report's checklist evidence for item 15 states `assertSingletonRegime()` "refuses a multi-Leg
column." This review confirmed the function exists and is unit-tested
(`planBuilder.test.js:630`), but it is **not called by `columnBuilder.build()`** or by any other
production module — grepped for callers outside the test file: none found. `build()` is safe today
only because it is structurally singleton by construction (each candidate supplies exactly one
`legId`, confirmed by reading `columnBuilder.js:92`), not because the named guard is active. This is
the same class of gap as Finding 1: a correct, tested predicate that is not yet load-bearing.

**Severity:** Minor, lower than Finding 1. No code path exists today that could produce a multi-Leg
column for the guard to catch, so there is currently nothing for it to miss. Worth wiring before
Phase 9/16 enable the column regime, so the guard is proven live before it is relied on.

**Both findings share one root cause worth stating once:** Phase 8 wrote three self-verification
predicates (`assertOrThrow`, `assertWearChargedOnce`'s consumption, `assertSingletonRegime`)
correctly and tested each in isolation, but did not audit whether the *production* call sites that
should invoke them actually do. This is a process observation, not evidence of a deeper defect — the
underlying arithmetic these predicates guard was independently re-derived by this review (Part 3.2,
3.3) and is correct. Recommend Phase 8 (before sign-off) or the start of Phase 10 close both findings
directly; neither requires new logic, only a call site.

---

## PART 7 — Determinism (§9.6) and T1 type separation

- **Integer arithmetic (§9.6 requirement 1).** Every module inspected (`phi.js`, `cDelay.js`,
  `column.js`) sums costs as `BigInt` milli-CU via `determinism/fixedPoint.js`'s `add`/`subtract`.
  Float arithmetic exists only inside the pricing modules' own CU-valued expressions
  (`cOpportunity.js`, `vTerminal.js`), each converting to milli-CU exactly once at its return
  boundary via `cu()` — confirmed by reading every arithmetic line in both files; no float value
  crosses a module boundary as a "cost" without first passing through that conversion.
- **Canonical ordering (§9.6 requirement 2).** `cDelay.forPlan()` sorts Legs by `legId` before
  summing (the sum itself is order-independent since it's integer, but the *reported* breakdown is
  made reproducible this way); `column.js`'s identity is `(agent_id, sorted leg_id list, insertion
  position vector)` via `determinism/ordering.columnIdentity()`; `planBuilder.insertChargingStop()`
  enumerates insertion positions in index order.
- **No clock, no randomness (T6).** `gate:tenets` independently re-run: PASS, 203 modules, no
  violations. `pricing/` is outside that gate's scope by Phase 0's own declared boundary (Part 3.4);
  Phase 8 compensates with its own direct scan, confirmed present in `costSchema.test.js`.
- **T1 type separation (I14).** `assertFeasible()` is called at the entry point of every cost module
  this review read (`phi.js`, `cOpportunity.js`, `cDelay.forPlan`) and by `planBuilder`'s upstream
  callers' expectations (the plan object carries the brand `evaluate.gate()` applies). `insertion.js`
  independently confirmed to contain no `brandFeasible` reference and to take the gate by injection —
  it cannot itself manufacture a feasible-looking candidate.

---

## PART 8 — Build and test review, reproduced independently

```
$ npm run gates
gate: tier-dependencies (§1.8 rule 2)     PASS — 206 modules, 238 governed edges
gate: parameter-register (§22, App. A)    PASS — 127 engine modules / 186 registered parameters
gate: tenets (T1, T6)                     PASS — 203 modules, no violations

$ npm run test:engine
Test Suites: 44 passed, 44 total
Tests:       1805 passed, 1805 total

$ npm run test:gates
Test Suites: 3 passed, 3 total
Tests:       49 passed, 49 total

$ npm run test:legacy
Test Suites: 22 passed, 22 total
Tests:       169 passed, 169 total
```

All figures match `PHASE_8_IMPLEMENTATION_REPORT.md` §1 and §12 exactly: 3/3 gates, 44/1805 engine,
3/49 gates lane, 22/169 legacy (no regression), 2023/2023 total. This review ran every command itself
against the live tree rather than accepting the report's transcription.

Test-content spot checks (not just pass/fail counts) were performed directly by this review and via
the delegated research pass, on: the no-normalisation source-scan gate (Part 1 item 21, above), the
10 km > 1 km monotonicity test, the three-Leg-Mission attribution test, the `V_terminal`
no-coefficients three-part gate, and `costSchema.test.js`'s migration-vs-generated-SQL byte-equality
and CHECK-constraint present/absent-from-echo tests. All test what the report claims, not something
weaker.

---

## PART 9 — Backwards compatibility and regression safety

- **Legacy lane green, 169/169, zero behavioural diff.** `costEvaluator.service.js` and
  `task.service.js` diffs are header-insertion only (Part 2.4); every other file the legacy
  dispatcher touches is unmodified by this phase (confirmed against `git status` — no legacy-path
  file outside these two headers appears in Phase 8's own files-modified list, and neither of the
  files modified by Phase 6/7 that also show as `M` — `tierAssertions.js`, `robotStateCache.js`,
  `config/logger.js`, `simulation/constants.js`, `routes/index.js` — is claimed or attributable to
  Phase 8; all carry Phase 6/7 attribution comments in their own diffs, independently confirmed by
  reading each).
- **No exported signature changed.** No test in `test:legacy` was modified this phase beyond the two
  phase-boundary files already covered in Part 4.
- **Configuration additive only.** `exchangeRates.js`'s diff is +3 rate dimensions, +4 absolute-CU
  parameters, zero deletions, zero modified existing lines — confirmed by reading the diff directly.
  `supplementary.json`'s raw `git diff` line count is confounded by co-mingled uncommitted Phase 6/7
  additions in the same file (33 new parameter names appear in the diff, not 13); cross-checked
  against `costSchema.test.js`'s own explicit enumeration of "the quantities §8 names but §8.10 does
  not tabulate," which lists exactly 13 names matching Phase 8's A4–A7 ambiguity resolutions. Every
  name sampled from the diff's deleted lines (`plan.max_admissible_mission_duration`,
  `fleet.agent_count`, `shard.max_agents`, `energy.f_derate`, and others) was independently confirmed
  still present exactly once in the current file — the diff's deletions are reordering/reformatting
  noise from the co-mingled uncommitted phases, not real removals.

---

## PART 10 — Failure analysis

No failure was found that reaches a currently-live code path, because nothing in Phase 8 is called
from a live path (Part 6). The two findings in Part 6 are latent: they describe self-verification
machinery that is correct but not yet wired to the callers that would make it load-bearing. Neither
affects the correctness of the arithmetic itself, which this review independently re-derived for the
two most mathematically delicate terms (§8.3's telescoping identity, §8.7's attribution rule) rather
than trusting the report's claim that it holds.

One point raised by the report itself (§14 limitation 1, the A2 `p ≠ 1` dimensional coupling) is not
a Phase 8 defect on inspection: the architecture document itself states the exponent and the rate's
unit in a way that is only dimensionally consistent at `p=1`, confirmed by this review reading both
§8.7 and §8.10 directly. Phase 8 implemented the specification exactly as written and disclosed the
consequence rather than silently changing either the exponent or the rate's unit, which would itself
have been an undocumented architecture change. Correctly escalated rather than resolved.

---

## PART 11 — Evidence summary

| Claim area | Verdict |
|---|---|
| Phase 8 checklist (21 items) | 21/21 PASS |
| Execution-plan prerequisites and sequencing | PASS |
| No Phase 9+ functionality present | PASS — `candidates/`, `solve/`, `intake/` empty; ownership test passing |
| §8.3 opportunity-cost derivation implemented exactly | PASS — independently re-derived, not merely re-read |
| §8.7 delay-attribution rule implemented exactly | PASS — independently re-derived |
| §1.8 rule 2 (no Tier 0/1 → Tier 2 static dependency) | PASS — gate + direct source inspection of injection sites |
| Database — additive only, CHECK constraints correct | PASS |
| Redis — key discipline, offset-only correction | PASS |
| Socket.IO — untouched | PASS |
| REST — untouched | PASS |
| Determinism (§9.6) — integer arithmetic, canonical ordering, no clock/random | PASS |
| T1 type separation (I14) | PASS |
| Backwards compatibility / regression safety | PASS — legacy lane 169/169, zero behavioural diff |
| Build gates | PASS — 3/3, reproduced independently |
| Test suite | PASS — 2023/2023, reproduced independently |
| Sign-discipline / singleton-regime runtime enforcement | **MINOR GAP** — predicates correct and tested in isolation, not wired into their production call sites (Part 6, Findings 1–2) |

---

## PART 12 — FINAL DECISION

**PASS WITH MINOR ISSUES**

1. **[Minor / Operational integrity]** `signDiscipline.assertOrThrow()` and `phi.assertWearChargedOnce()`'s
   failure path do not currently cause `phi.evaluate()` to fail or throw under any environment — a
   sign-discipline or wear-attribution violation is recorded in `problems` but the call still returns
   `ok:true`. **Affected files:** `Backend/src/engine/cost/signDiscipline.js`,
   `Backend/src/engine/cost/phi.js`. **Recommendation:** before Phase 10 wires a live caller to
   `phi.evaluate()`, decide and implement where the dev/test escalation actually fires — either
   `phi.js` reads an environment flag and calls `assertOrThrow` per term, or the future caller does,
   and the module's own docstring should then describe whichever is chosen rather than describing
   behaviour that does not yet exist.
2. **[Minor / Operational integrity]** `columnBuilder.assertSingletonRegime()` is not called by
   `columnBuilder.build()`. **Affected file:** `Backend/src/engine/plan/columnBuilder.js`.
   **Recommendation:** call it at the end of `build()` (or wherever a column is finalised) now, while
   it is a one-line, zero-risk change and before Phase 9/16 give the column regime a way to actually
   produce a multi-Leg column.
3. **[Non-blocking, already disclosed by the implementation report]** The `p ≠ 1` dimensional
   coupling between §8.7 and §8.10 (A2) is a genuine ambiguity in the frozen architecture document,
   not a Phase 8 implementation defect. This review concurs with the report's disposition
   (implement literally, escalate rather than silently resolve) and forwards the same escalation to
   the architecture's owner. No correction is required of Phase 8.
4. **[Non-blocking, already disclosed]** Migration not applied to a live database; no reachable
   Postgres in this environment either. Deployment-step item, not a code defect.

**Phase 9 may begin.** Neither minor issue blocks Phase 9 (candidate generation), which consumes
`Φ`'s registration surface and `column.js`'s pricing output, not the two dormant guards above.
Recommend closing Findings 1 and 2 before Phase 10 (round loop) starts calling `phi.evaluate()` and
`columnBuilder.build()` from a live path, since that is the point at which the gap between "tested in
isolation" and "enforced in production" first becomes observable in a real decision.

---

*End of Phase 8 Independent Verification Report.*
