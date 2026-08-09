# PHASE 8 — COST FUNCTION AND PLAN BUILDER (L4)

**Implementation Report**

Date: 2026-08-04
Phase: 8 of 16 — *Cost function and plan builder*
Scope authority: `IMPLEMENTATION_EXECUTION_PLAN.md` §3 "PHASE 8", §7 checklist
Architecture authority: `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` §8, §13, cross-referencing §1.3, §1.4, §5.2, §6.4, §9.3, §9.4, §9.6, §20.3 item 2
Status: **complete, pending independent verification**

---

## 1. Executive Summary

Phase 8 delivers §8 and §13: `Φ(plan)` in absolute CU with every term, the seven cost
terms with their declared signs and bounds, the Leg-level delay attribution rule, the
Plan Builder whose output is the single artefact feasibility and cost share, the
opportunity model derived from one calibrated primitive, insertion priced as one
functional at two plans, and the singleton column price.

The line this phase exists to remove is §1.3's:

> Under min-max the best candidate always scores exactly 0 however bad it is.

It is gone. No module in the cost path rescales anything; `units.refuseNormalisation()`
is the explicit failure a contributor meets if they try, and a source scan over the
twelve cost modules proves the shape of a min-max rescale is absent rather than merely
unused. Every cost is an int64 milli-CU quantity, summed with `BigInt` arithmetic that is
exact and order-independent.

**The central structural change is the artefact.** §13.1's "a candidate is feasible if
and only if a valid plan exists" is now literally true in the code: `planBuilder.build()`
produces one object, `feasibility/evaluate.gate()` admits and brands it, and `Φ` prices
that same branded object. The baseline computed mission distance only after the robot was
chosen; this phase makes that ordering structurally impossible.

| Measure | Before | After |
|---|---|---|
| Build gates | 3 / 3 pass | **3 / 3 pass** |
| Engine lane | 40 suites, 1 562 tests | **44 suites, 1 805 tests** |
| Gates lane | 3 suites, 49 tests | **3 suites, 49 tests** |
| Legacy lane | 22 suites, 169 tests | **22 suites, 169 tests** (no regression) |
| **Total** | **1 780 tests** | **2 023 tests** |

**Everything is additive and inert.** No round runs. `ENGINE_ENABLED` is still false,
neither new worker is started from `server.js`, no REST endpoint or Socket.IO event
changed, and the two superseded legacy services are annotated rather than modified — so
the legacy dispatcher behaves exactly as it did.

### Four ambiguities found; three resolved with the resolution recorded, one escalated

§8.2 and §8.5 both state `cost.wear.cu_per_metre · d_mission`, and §8.7 raises lateness to
a power while §8.10 registers its rate as CU·s⁻¹. Neither is a coding question. §3.3 below
gives all four, what was done, and why. **The `p ≠ 1` dimensional coupling (A2) is
escalated rather than resolved**, because resolving it means changing §8.7.

---

## 2. Objectives Achieved

Every line of the plan's §7 Phase 8 checklist:

| # | Checklist item | Status | Where |
|---|---|---|---|
| 1 | `plan/planBuilder.js` — stop sequence, per-stop timeline/energy/payload/custody, terminal state | ✅ | `plan/planBuilder.js`; all seven §13.1 bullets asserted in `planBuilder.test.js` |
| 2 | `plan/timeline.js` with uncertainty bands | ✅ | `plan/timeline.js`; travel and service variances composed in quadrature |
| 3 | `cost/cDirect.js` — all six time components, energy, wear | ✅ | `cost/cDirect.js`; a plan missing any one component is refused, not priced at zero |
| 4 | `pricing/capacityPricingClient.js` and `vTerminal.js` (`V_avail`, `V_terminal`, **no weighting coefficients**) | ✅ | both; the no-coefficients property is a build gate in `pricingModel.test.js` |
| 5 | `cost/cOpportunity.js` — origin-zone integral **plus** same-time terminal difference | ✅ | `cost/cOpportunity.js`; `unavailability()` has no route parameter, `relocation()` has one instant |
| 6 | Verify the telescoping identity numerically | ✅ | `telescopingResidual()` returns **exactly 0**, including past the horizon |
| 7 | `cost/cRisk.js` — per-tier energy consequence terms summed separately | ✅ | `cost/cRisk.js`; an absent tier price is refused, never zeroed |
| 8 | `cost/cLifecycle.js`, `cost/cPolicy.js` (every adjustment declares a credit ceiling) | ✅ | both; `assertRegisterCoverage()` ties the register to `Ω_policy`'s derivation |
| 9 | `cost/cDelay.js` with the §8.7 **Leg attribution rule** | ✅ | `cost/cDelay.js`; a Leg with no stated role is **refused** — neither default is safe |
| 10 | Bounded `aging_multiplier` capped at `cost.aging.max_multiplier` | ✅ | `agingMultiplier()`, and the cap binds inside the priced term as well |
| 11 | `cost/cDefer.js` (present, switched off) and `cost/cChurn.js` | ✅ | both, each behind its own kill switch with a named degraded behaviour |
| 12 | `cost/signDiscipline.js` — assert declared signs and lower bounds at runtime | ✅ | `cost/signDiscipline.js`; `check()` always runs, `assertOrThrow()` escalates in dev/test |
| 13 | `cost/phi.js` — sum over **every** Leg, committed Legs included | ✅ | `cost/phi.js`; asserted with a two-Leg plan, one committed |
| 14 | `plan/insertion.js` and `plan/column.js` — `γ(c) = Φ(plan(c)) − Φ(plan₀) + C_churn` | ✅ | both; the difference is taken on `BigInt`, so no rounding occurs at all |
| 15 | `plan/columnBuilder.js` (singleton columns only) | ✅ | `plan/columnBuilder.js`; `assertSingletonRegime()` refuses a multi-Leg column |
| 16 | Enforce F17 and the commitment horizon as **plan feasibility**, not arc capacity | ✅ | `column.assertQueueDepthIsPlanFeasibility()`; the column exposes no capacity field |
| 17 | `ServiceTimeModel` fitter with hierarchical shrinkage | ✅ | `workers/serviceTimeModel.worker.js`; fitter and reader share one `shrink()` |
| 18 | Cell-pair travel-time cache | ✅ | `routing/cellPairCache.js`; offset added at both ends, never subtracted |
| 19 | Tests: unit correctness of each term; 10 km > 1 km; sign discipline; attribution rule | ✅ | 243 new tests |
| 20 | Test: `γ(c)` recomputed from `Φ` equals the solver's value exactly in integer milli-CU | ✅ | `column.recompute()`; a one-milli-CU disagreement is caught with no tolerance |
| 21 | **Gate:** no normalisation anywhere in the cost path; `V_terminal` has no weighting coefficients | ✅ | two source-scan gates in `costFunction.test.js` and `pricingModel.test.js` |

---

## 3. Pre-Implementation Analysis

### 3.1 What the substrate already provided

| Provided by | What | Consumed by |
|---|---|---|
| Phase 0 | `tenets.js`'s T1 brand, `assertFeasible()`, and the build assertion over `src/engine/cost/` | every cost module |
| Phase 0 | `tierAssertions.js` already places `cOpportunity.js`, `cDefer.js`, `cChurn.js`, `pricing/`, and `plan/insertion.js` at Tier 2, and states the registration pattern Φ must use | `phi.js`, `column.js` |
| Phase 1 | `units.js`, `exchangeRates.js`, `fixedPoint.js`, `ordering.js` — the whole CU substrate | every term |
| Phase 1 | 29 of §8.10's parameters already registered; V1, V2, V7 already validate the horizon, the ceilings, and the cap; `Ω_policy` already derived at publish | `cPolicy.js`, `cDelay.js`, `cOpportunity.js` |
| Phase 1 | `snapshot.js` already reserves `priceSnapshotVersion` and `forecastVersion` in `DEFERRED_PINS`, naming Phase 8 | `capacityPricingClient.js`, `forecastClient.js` |
| Phase 2 | `Stop.serviceTimeModelRef` already declared, naming §13.2 | `ServiceTimeModel` |
| Phase 6 | 38 predicates written against a named plan shape, pinned by `feasibilityFixture.js` | `planBuilder.js` |
| Phase 7 | `consumption`, `reserves`, `tiers`, `eReturn`, `chargeCurve`, `wear`, `packing`, `loadState` — every physical model the plan projects | `planBuilder.js`, `cLifecycle.js` |

### 3.2 Analysis outputs

- **Modules affected:** `engine/cost/**` (10 new), `engine/plan/**` (5 new),
  `engine/pricing/**` (3 new), `engine/routing/cellPairCache.js` (new), `workers/**`
  (2 new), `engine/cost/exchangeRates.js` (extended), two legacy services (annotated).
- **New files:** 19 engine modules + 2 workers + 6 test files.
- **Database:** two additive tables, four CHECK constraints, two foreign keys.
- **Redis:** two new key families, both read-through and non-authoritative.
- **Socket.IO:** none.
- **REST:** none.
- **Runtime behaviour:** nothing new runs; no existing path changed.

### 3.3 Ambiguities found and how each was resolved

| # | Ambiguity | Resolution |
|---|---|---|
| **A1** | **§8.2's `C_direct` and §8.5's `C_lifecycle` both state `cost.wear.cu_per_metre[class] · d_mission`.** Summing both as written charges one registered exchange rate twice. | Charged **once, in `C_lifecycle`**. `cDirect` computes the addend faithfully and reports it separately with `attributedTo: "C_lifecycle"`; `phi.assertWearChargedOnce()` proves the property from the two breakdowns rather than trusting the call site, and a test shows the check catching a Φ that summed it twice. `C_lifecycle` was chosen because §17.1 makes that term the basis for wear levelling, and a wear-levelling term with no distance in it would be strange. The alternative reading — that the two price different mechanisms sharing a coefficient name — would require §8.10 to register two rates, which it does not. |
| **A2** | **⚠ §8.7 raises lateness to `p` (default 2) while §8.10 registers `cost.sla.cu_per_second_late` as CU·s⁻¹.** Those are dimensionally consistent only at `p = 1`: at `p = 2` the product is CU·s, not CU. | **Implemented exactly as §8.7 writes it** — `w_sla · aging · lateness^p` — and **escalated, not resolved**. The practical consequence is stated in the module header and in §13 below: the rate's calibration is exponent-dependent, and `cost.sla.lateness_exponent` (POLICY) and `cost.sla.cu_per_second_late` (CONTRACTUAL) are owned by different people, which is exactly the situation in which an unstated coupling causes trouble. Resolving it means changing §8.7, and the architecture is frozen. |
| **A3** | **§8.2 tabulates service time at the first and last stop only.** A plan with intermediate stops would leave their dwell unpriced — the precise defect §8.2 exists to close. | Intermediate dwell is carried in `t_linehaul`, which §8.2 defines as "travel time across the remaining stop sequence"; for a sequence with intermediate stops, traversing it includes stopping at them. Reported separately as `intermediateServiceSeconds` so the split is auditable, and a test asserts the six components sum to the whole elapsed plan — nothing is unpriced. |
| **A4** | **§8.5 names five addends; §8.10 registers coefficients for two of them.** The actuator, tyre-and-brake, and thermal-stress coefficients have no register entries. | Registered in `supplementary.json` with the derivation §8.5 states ("replacement cost divided by rated life"), rather than accepted as bare CU inputs. §8.10 registers `cost.battery.cu_per_equivalent_cycle`, which is one of the same five, so registering the others follows the table's own precedent. Four entries, each naming §8.5 and its owner. |
| A5 | §8.9's `C_churn` formula names `churn.wasted_travel_cost` and `churn.notification_cost`; §8.10's table registers only `base_cost` and `per_second_elapsed`. | Both registered, marked with the section that requires them. Same disposition as A4. |
| A6 | §8.8's `penalty_for_wasted_round` is a configured CU price with no §8.10 entry. | Registered as `defer.wasted_round_penalty`, non-negative by range. |
| A7 | §13.3 names `plan.max_exhaustive_stops` for the exhaustive enumeration and "bounded heuristic beyond" without naming that bound. | Registered `plan.max_heuristic_insertions` (default 24). §9.4's discipline applies: exceeding it returns the best position found with the truncation recorded. |
| A8 | §5.2 gives the Forecast Service and Capacity Pricing soft timeouts and named fallbacks, but the price surface must cover `T_H` for `V_avail` to be well defined. | `capacityPricingClient.padToHorizon()` closes gaps with `cost.opportunity.lambda_zone_prior` — §5.2's own declared degradation — and **records every padded interval**, per zone, in the published snapshot and per row in `ZonePriceSnapshot.estimator`. `vTerminal.vAvail()` refuses an uncovered horizon rather than treating the gap as zero. |
| A9 | Should the λ_zone refresh worker import the Tier 2 pricing client? | **No.** `src/workers/` is Tier 1 and §1.8 rule 2 forbids it; the gate would fail. The client is **injected**, which is the pattern the gate's own documentation names — and the worker checks the kill switch first and refuses to run when thrown, so the injection is a real control rather than a way past the gate. |
| A10 | Should `src/engine/pricing/` be added to `guards/tenets.js`'s T6 decision-path scope? | **No.** Phase 0 chose that list deliberately and the architecture is frozen; adding to it is not Phase 8's call. The property is asserted anyway, by a Phase 8 test that scans all three pricing modules directly for clock and random reads. Flagged for verification. |

---

## 4. Files Created

**Cost — `Backend/src/engine/cost/` (3 123 lines):**

| File | Purpose |
|---|---|
| `phi.js` | §8.1's functional; the Tier 2 registration seam; the wear attribution rule; `Φ(∅) = 0` |
| `cDirect.js` | §8.2's six time components, energy, and the distance-wear addend reported apart |
| `cOpportunity.js` | §8.3.3's derivation: the origin-zone integral, the same-time relocation difference, and the telescoping residual |
| `cRisk.js` | §8.4's five addends with the three energy tiers priced separately |
| `cLifecycle.js` | §8.5's five addends, with §14.4's battery term called rather than reimplemented |
| `cPolicy.js` | §8.6's five-adjustment register, credit ceilings, expiry refusal, `Ω_policy` coverage |
| `cDelay.js` | §8.7's functional and the Leg attribution rule; the bounded aging multiplier |
| `cDefer.js` | §8.8's arc, its structural bounds, and the operator-facing reason |
| `cChurn.js` | §8.9's per-column hysteresis and the protocol-not-bypassed guard |
| `signDiscipline.js` | §8.1's sign declarations as a checked property, and §6.4's two corrections derived from them |

**Plan — `Backend/src/engine/plan/` (2 197 lines):** `planBuilder.js`, `timeline.js`,
`column.js`, `columnBuilder.js`, `insertion.js`.

**Pricing — `Backend/src/engine/pricing/` (1 161 lines):** `vTerminal.js`,
`capacityPricingClient.js`, `forecastClient.js`.

**Routing (328 lines):** `routing/cellPairCache.js`.

**Workers (608 lines):** `workers/serviceTimeModel.worker.js`,
`workers/capacityPricing.worker.js`.

**Migration:** `prisma/migrations/20260804220000_cost_function_and_plan_builder/`
(157 lines).

**Tests (3 155 lines):** `tests/engine/helpers/costFixture.js`,
`tests/engine/helpers/planFixture.js`, `costFunction.test.js`, `planBuilder.test.js`,
`pricingModel.test.js`, `costSchema.test.js`.

## 5. Files Modified

| File | Change | Behaviour |
|---|---|---|
| `prisma/schema.prisma` | +2 models, +2 back-relations | additive |
| `src/engine/config/register/supplementary.json` | +13 parameters | additive |
| `src/engine/cost/exchangeRates.js` | +3 rate dimensions, +4 absolute-CU parameters | additive; no existing entry changed |
| `src/services/costEvaluator.service.js` | header only — **replaced by Phase 8, retires at Phase 15** | **behaviour unchanged** |
| `src/services/task.service.js` | header only — route helpers superseded | **behaviour unchanged** |
| `tests/engine/phase0Scaffold.test.js` | `PHASE_8_OWNED` | phase-boundary marker |
| `tests/engine/commitmentSchema.test.js` | boundary moved to "no Phase 9+ table" | same discipline |

The two legacy services follow the precedent Phase 6 set with
`robotValidator.service.js`: a header stating precisely what supersedes them and why,
with the code untouched, because the legacy dispatcher is the production path until the
Phase 15 cutover.

---

## 6. Runtime Behaviour

**Nothing new runs on the server.** The cost function and Plan Builder are complete,
tested, and unwired: no round calls `phi.evaluate()`, no caller supplies a plan, and
neither new worker is started from `server.js`. `ENGINE_ENABLED` is false. Phase 10's
round loop is what wires them.

**No existing behaviour changed at all** — this phase touched no runtime path outside the
engine tree. The legacy lane is green at 169/169 without a single file's behaviour being
modified.

Properties preserved:

- **T1 type separation (I14).** Every cost entry point calls `assertFeasible()`, so `Φ`
  and its terms are structurally incapable of pricing a candidate the gate did not admit.
  Tested six ways, including that the brand survives neither a JSON round trip nor an
  object spread.
- **Determinism (T6, I10).** No cost, plan, or pricing module reads a clock, a random
  source, or a store. `gate:tenets` passes over 203 modules, and a Phase 8 test scans the
  three `pricing/` modules directly because Phase 0 placed that directory outside the
  gate's scope.
- **Integer arithmetic (§9.6 requirement 1).** Every cost is `BigInt` milli-CU. `γ` is a
  subtraction of two exact integers, so `column.recompute()` reproduces the solver's value
  byte-for-byte with no tolerance.
- **Purity.** Every kv client, router, and Tier 2 client is injected.
- **Backwards compatibility.** Legacy lane 169/169. No endpoint, event, or exported
  function signature changed.

---

## 7. API Changes

**None.** The plan's Phase 8 row states "REST API changes: None (cost is exposed via the
Explanation API in Phase 11)", and no route, controller, or middleware was touched.

## 8. Redis Changes

| Key | Contents | Notes |
|---|---|---|
| `engine:price:{version}` | the pinned λ_zone surface with `Ω_terminal` | cache, not authority — the `ZonePriceSnapshot` rows are |
| `engine:route:cell:{originCell}:{destCell}:{profile}:{bucket}` | §20.3 item 2's cell-pair travel time, with its distribution | all four key components required; `key()` refuses a partial one |

Both are read-through and non-authoritative: a read error is a miss, a write failure is
silent, and neither can produce a verdict (I16). The cell-pair entry carries
`travelSdSeconds` as well as the mean, because §8.4 prices `p_late` from the ETA
distribution and a cache storing only a mean would make punctuality unpriceable for every
cached pair — which is every pair in steady state.

## 9. Socket.IO Changes

**None.** No new events, no wire-format change, no new field on an existing payload.

## 10. Database Changes

Migration `20260804220000_cost_function_and_plan_builder`. **Additive only** — two new
tables, two foreign keys, four CHECK constraints; nothing dropped, renamed, or re-typed.
Rollback is `DROP TABLE` on the two.

- **`ServiceTimeModel`** — §13.2's learned dwell distribution. The four discriminators are
  **nullable**, and that is the hierarchy: a row with `hourOfWeek IS NULL` is the cohort
  marginalised over the hour. The fitter writes one row per level it can estimate and
  `timeline.js` walks them broadest-first. Storing only leaf cohorts would make the
  shrinkage ladder unreconstructable, and `sampleCount` is stored because it is the
  shrinkage weight's numerator.
- **`ZonePriceSnapshot`** — §8.3.1's surface, insert-only, `version` in every unique key,
  **no `updatedAt`**. `omegaTerminalCu` lives on the row because §6.4's admissibility
  argument is about the surface actually in use, and a bound updatable independently of
  the prices would eventually be a proof about a surface nobody evaluated.

**Four hand-written CHECK constraints**, each asserted present *and* asserted absent from
Prisma's generated output so a reviewer can tell an addition from an echo:

- `lambdaCuPerSecond >= 0` — §8.3.3's unavailability component is non-negative *because*
  λ ≥ 0, and that is what leaves `C_opportunity` bounded below by `−Ω_terminal` alone.
- `omegaTerminalCu >= 0` — it is subtracted; a negative value would raise the lower bound
  instead of lowering it.
- `estimator IN (…)` — §8.3.1 names exactly three estimators and §5.2 requires the
  degraded one to be flagged rather than inferred.
- `meanSeconds >= 0 AND sdSeconds >= 0 AND sampleCount >= 0` — a model with no dispersion
  tells the cost function that every stop in that cohort is perfectly punctual.

Every `CREATE TABLE`, index, and foreign key is byte-equal (whitespace-normalised) to
`prisma migrate diff --from-empty`, asserted in `costSchema.test.js`.

> **Not applied to a live database.** No Postgres was reachable in this environment.
> `prisma validate` passes and the SQL is Prisma's own generated output. Applying it is a
> deployment step. Recorded in §14.

---

## 11. Architecture Compliance

| Property | How held | Evidence |
|---|---|---|
| **Architectural layering** | `cost/` and `plan/` read domain, config, determinism, energy, and payload only; never a store or a clock | `gate:tiers` PASS, 238 governed edges |
| **§1.8 rule 2** | `phi.js` (Tier 1) obtains `C_opportunity` by **registration**; `column.js` obtains `C_churn` the same way; the pricing worker takes its client by **injection** | `gate:tiers` PASS + a Phase 8 test scanning all eleven Tier 1 modules for a Tier 2 `require` |
| **§22.5 rule 1** | each of the four Tier 2 mechanisms names its switch and its degraded behaviour, and each degraded path is a tested function | `cChurn.degraded()`, `cDefer.degraded()`, `insertion.degraded()`, Φ's `omittedTerms` |
| **T1 type separation (I14)** | every cost entry point asserts the brand; only `evaluate.js` may brand, and `insertion.js` takes the gate by injection so it cannot | 6 tests + a source assertion that `insertion.js` never mentions `brandFeasible` |
| **T6 determinism** | no clock, no randomness, no store in the decision path | `gate:tenets` PASS over 203 modules + a direct scan of `pricing/` |
| **§1.3 no normalisation** | no rescaling anywhere; the prohibited shapes are scanned for | source scan over 12 cost modules |
| **§8.10 `V_terminal` has no coefficients** | the function is `a − b − c` with no multiplication and no config read | three independent assertions |
| **§9.6 integer arithmetic** | every cost is `BigInt` milli-CU; `γ` is exact | `recompute()` with zero tolerance |
| **§9.6 canonical ordering** | columns ordered by `(γ, agentId, identity)`; adjustments, Legs, and buckets all sorted | determinism tests |
| **Backwards compatibility** | legacy lane green | 169/169 |

**No architecture was changed.** `MODULE_TIERS`, `MECHANISMS`, and the three gate scripts
are untouched; `guards/tenets.js` is untouched. The only architecture-adjacent edit is
`exchangeRates.js`, which gained three rate dimensions and four absolute-CU parameter
names — additive entries in a table Phase 1 built for exactly that purpose.

---

## 12. Test Results

```
gate:tiers   PASS — 206 modules, 238 governed edges, no Tier 0/1 → Tier 2 dependency
gate:params  PASS — 127 engine modules against 186 registered parameters
gate:tenets  PASS — 203 modules, no T1 or T6 violations

engine       44 suites, 1805 tests passed      (was 40 / 1562)
gates         3 suites,   49 tests passed      (unchanged)
legacy       22 suites,  169 tests passed      (unchanged — no regression)
──────────────────────────────────────────────────────────────────
TOTAL                   2023 tests passed, 0 failed
```

**243 new tests across four new suites:**

| Suite | Tests | Covers |
|---|---|---|
| `costFunction` | 83 | T1 separation six ways; the no-normalisation gate; every term by hand; the §8.7 attribution rule including a three-Leg Mission priced once; the aging cap; the telescoping identity at residual **exactly 0**; §8.3.3(b) and (c) as structural assertions; sign discipline; 10 km > 1 km; the single-candidate case |
| `planBuilder` | 52 | all seven §13.1 bullets; precedence; `hour_of_week` before and after the epoch; shrinkage continuity; waiting priced so speed buys nothing; charging insertion and its refusals; the absence of a return-to-base rule; F17 as plan feasibility; `γ` exactness; singleton-regime column building |
| `pricingModel` | 40 | the `V_terminal` build gate three ways; `V_avail` additivity — the property the telescoping rests on; `Ω_terminal` derived from the surface it publishes; the dual-regime discipline; §5.2's forecast ladder; the cell-pair cache's key, offset, and degradations |
| `costSchema` | 68 | migration vs Prisma-generated SQL; additive-only; four CHECK constraints present *and* absent from the generated output; §8.10 register completeness; Redis key shapes; tier assignments; a direct T6 scan of `pricing/`; both workers; the phase boundary |

### 12.1 Notable properties proven

- **The telescoping identity holds at residual exactly 0**, not approximately — including
  for a commitment that runs past the valuation horizon. The implementation obtains it by
  construction: `unavailability()` is computed as a *difference of two `V_avail`
  integrals* rather than as a fresh integral, so the two halves are literally the same
  function evaluated twice and cannot desynchronise.
- **§8.3.3(b) is a structural property, not a numeric one.** `unavailability()` has no
  route parameter — a test reads the function body and asserts the absence — so there is
  no argument through which a caller could integrate along a path.
- **A three-Leg Mission is priced once.** One terminal Leg carries the full term and the
  whole breach step; two upstream Legs carry slack consumption at 0.15. A plan with two
  terminal Legs for one Mission is refused by name.
- **A Leg with no stated role is refused.** Both defaults are unsafe in opposite
  directions, so there is none — the failure states why.
- **`γ` recomputed from `Φ` matches the solver's value with no tolerance**, and a
  one-milli-CU disagreement is caught.
- **The six §8.2 time components sum to the whole elapsed plan**, for two- and three-stop
  plans alike — nothing is unpriced.
- **An agent arriving 20 minutes early is not rewarded**: fast and slow approaches to the
  same window produce identical committed time.

### 12.2 Defects found and fixed during testing

| Found | Nature | Fix |
|---|---|---|
| `planBuilder` reserve composition | `eReturn.returnLayerWh()` returns `{ok, returnWh}`, and the return layer was being passed as the whole object. `reserves.compose()` correctly refused it, so every plan reported no reserves and every candidate would have gone to F34 as indeterminate — a **silent, total** loss of the energy path, visible only because a test asserted the composed layers rather than the call's return shape. | The layer is unwrapped, and an absent one is left **absent** rather than defaulted to zero, because §14.5 calls a zero return reserve "a reachability question nobody answered". |
| `phi.assertWearChargedOnce()` | The first draft could not actually detect double-charging: it inspected what `cDirect` *reported* rather than what `Φ` *summed*. | Rewritten to compare the summed value against both candidate totals; a test now feeds it the double-charged total and asserts it is caught. |
| `cPolicy.assertRegisterCoverage()` | Read a derivation-evidence shape that `config/derived.js` does not publish, so it would have passed vacuously. | Reads the ceilings the derivation actually summed. A test asserts the covered set equals the module's own register, and a second asserts a missing ceiling is caught. |

---

## 13. Self-Verification

| Claim | Verified by |
|---|---|
| Every Phase 8 checklist item implemented | §2 table; all 21 traced to code |
| **No Phase 9+ functionality exists** | `candidates/`, `solve/`, `intake/` still empty; `plan/` holds exactly five files; `commitmentSchema`'s "no Phase 9+ table"; `phase0Scaffold`'s ownership test |
| **No Tier 2 mechanism statically linked into a Tier 1 path** | `gate:tiers` PASS + an independent scan of all eleven Tier 1 Phase 8 modules |
| Architecture unchanged | `MODULE_TIERS`, `MECHANISMS`, `tenets.js`, and all three gate scripts untouched |
| Build passes | `npm run gates` 3/3 |
| Tests pass | 2 023 / 2 023 |
| Migration valid | `prisma validate` ✅; SQL byte-equal to Prisma's own generation |
| APIs compatible | no REST, Socket.IO, or exported-signature change; legacy lane green |
| No normalisation in the cost path | source scan over 12 modules + `refuseNormalisation()` |
| `V_terminal` has no weighting coefficients | signature, source, and behaviour |
| Every cost in int64 milli-CU | `assertCost()` on Φ's total; `recompute()` refuses a non-`BigInt` |
| Aging multiplier capped | `agingMultiplier()` and the priced term, tested independently |
| Delay attribution rule implemented | 8 tests including the three-Leg Mission |
| Plan is the sole shared artefact | `planBuilder.build()` → `evaluate.gate()` → `phi.evaluate()`, on one object |
| Insertion priced as one functional at two plans | `insertion.js` calls `Φ`; it contains no cost model of its own |

---

## 14. Known Limitations

1. **⚠ A2 — the `p ≠ 1` dimensional coupling is escalated, not resolved.** §8.7's
   `lateness^p` with §8.10's CU·s⁻¹ rate is dimensionally consistent only at `p = 1`. The
   implementation follows §8.7 exactly. The consequence is that
   `cost.sla.cu_per_second_late` must be calibrated **at the exponent in force**, and
   changing `cost.sla.lateness_exponent` without recalibrating rescales every delay cost
   in the fleet. The two parameters have different owners and different change classes
   (POLICY and CONTRACTUAL), which is precisely when an unstated coupling causes trouble.
   **Escalated to the architecture owner.** Nothing in Phase 8 depends on the resolution;
   the arithmetic is pinned by test so a change is visible.

2. **A1's wear attribution is a stated reading**, not specification text. Φ charges
   `cost.wear.cu_per_metre · d_mission` once, in `C_lifecycle`. Flagged for verification.

3. **The seeded register still cannot publish — V9 blocks on combined degraded
   conservatism.** Pre-existing since Phase 1, reported in full by Phase 7 §14 item 1, and
   unchanged here. Phase 8 added no Safety-class parameter and changed none.

4. **Thirteen Phase 8 inputs ship uncalibrated with `null` defaults** — the four §8.5
   coefficients, the two churn coefficients, the deferral penalty, and the service-time
   priors among them. Each states what it `awaits`. Null denies loudly; a fabricated
   coefficient would produce a plausible-looking wrong cost, which is the failure §1.3's
   unit discipline exists to prevent.

5. **The Capacity Pricing Service does not exist** (a Phase 8 analogue of blocking
   decisions B1/B2). The engine's half of the contract is complete and validated at the
   boundary; the publisher is outside the engine's boundary (§1.6). Until one exists,
   `publish()` pads the whole surface with `cost.opportunity.lambda_zone_prior` and
   records the degradation per zone and per row — which is §5.2's own declared
   unavailability envelope, not a workaround.

6. **The routing engine does not exist (blocking decision B1).** `cellPairCache.read()`
   takes `route()` as an injected dependency and is tested against a stub — the mitigation
   §6.2 names. The §5.2 geometric-bound fallback is **not** implemented: the cache reports
   the router failure with the declared degradation named, and choosing among §5.2's
   fallbacks is the round's decision, which is Phase 10's. Recorded so verification does
   not read the absence as an oversight.

7. **`plan/insertion.js` is complete but has no in-repo caller.** Chaining is T2-03 and
   the round loop that would use it is Phase 10's. It is tested directly.

8. **Per-stop energy bands apportion the mission's standard deviation by cumulative
   consumption share.** A stated approximation, consistent with a multiplicative residual
   model and with how `energy.model_residual_cv` is fitted. F34 evaluates against the
   mission distribution regardless, so the per-stop band informs explanation rather than
   the gate.

9. **The migration has not been applied to a live database.**

10. **Everything is unwired.** No round consumes any of it; Phase 10 does.

## 15. Remaining Non-Blocking Issues

1. **`PHASE_0_INDEPENDENT_VERIFICATION.md` still does not exist**, as Phases 1–7 all
   recorded.
2. **Migration application** is a deployment step, pending a reachable database.
3. **Neither new worker is scheduled.** Correct for this phase: `ENGINE_ENABLED` is false
   and Phase 15 owns production scheduling, matching the six workers already in the tree.
4. **`ServiceTimeModel` and `ZonePriceSnapshot` have no seed data.** Both are read through
   modules that report a missing input by name rather than defaulting one.
5. **`src/engine/pricing/` is outside `guards/tenets.js`'s T6 build scope** by Phase 0's
   choice (A10). Phase 8 asserts the property with its own test instead of editing a
   Phase 0 file. Worth a decision at Phase 9, which adds `candidates/` — already in scope.
6. **`route.detour_factor` is deliberately unregistered.** §5.2 names it for the geometric
   fallback, which Phase 8 does not implement (limitation 6). Registering an unused
   parameter would be the kind of speculative entry §22.1 exists to discourage.

---

## 16. Readiness for Independent Verification

**Ready.** Suggested focus, in priority order:

1. **A2 — the `p ≠ 1` dimensional coupling.** Is "implement §8.7 literally and escalate"
   the right disposition for a phase that owns the term but not the specification?
2. **A1 — charging the distance-wear addend once, in `C_lifecycle`.** The alternative
   reading is that §8.2 and §8.5 price different mechanisms; §8.10 registers one rate.
3. **The telescoping implementation.** `unavailability()` is a difference of two `V_avail`
   integrals rather than a fresh integral. That is what makes the residual exactly zero —
   is it also what §8.3.3 means?
4. **A3 — intermediate-stop dwell carried in `t_linehaul`.** The alternative is a seventh
   component §8.2 does not name.
5. **A9 — injecting the Tier 2 pricing client into a Tier 1 worker.** The kill switch is
   checked first, so the injection is a real control; is that sufficient under §1.8 rule 2?
6. **A10 — asserting T6 over `pricing/` in a test rather than extending the Phase 0 gate.**
7. **The `assertWearChargedOnce` and `assertRegisterCoverage` defects in §12.2** — both
   were checks that would have passed vacuously, and both were caught only because a test
   asserted the property rather than the return shape. Worth checking whether the same
   class of error survives elsewhere.

Every claim in this report is reproducible with:

```bash
cd Backend
npm run gates        # 3/3
npm run test:engine  # 44 suites, 1805 tests
npm run test:gates   # 3 suites, 49 tests
npm run test:legacy  # 22 suites, 169 tests
```

**Phase 9 has not been implemented. No Phase 9 functionality exists in this change.**

---

*End of Phase 8 Implementation Report.*
