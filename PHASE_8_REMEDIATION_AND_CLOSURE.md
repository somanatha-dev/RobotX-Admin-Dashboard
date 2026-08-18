# Phase 8 — Remediation and Closure

**Cost Function & Plan Builder**

Date: 2026-08-18 · Branch: `feature/dashboard` · Working tree: `63f5c58` + uncommitted Phases 6–8
Role: Principal Distributed-Systems / Optimization / Safety / Independent Verification Engineer
Authority order: `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` (frozen) → `IMPLEMENTATION_EXECUTION_PLAN.md`
→ current repository → `PHASE_8_INDEPENDENT_VERIFICATION.md` → `PHASE_8_IMPLEMENTATION_REPORT.md`

Historical reports are preserved unmodified. This document does not replace them; it records what
the **current** tree does, what was wrong with it, and what was changed.

---

## 1. Final Status

# PHASE 8 CLOSED

Four genuine defects were found, fixed, and covered by 20 new regression tests. Two of them
could not have been found by re-reading the historical reports: one was created by the passage
of time (Phase 10 arrived and turned a "dormant" finding into a live one), and one was only
visible against a real PostgreSQL instance.

---

## 2. Starting State

### 2.1 What the historical reports claimed

`PHASE_8_IMPLEMENTATION_REPORT.md` (2026-08-04) claimed all 21 execution-plan checklist items
complete, 2 023 tests passing, ten disclosed limitations, and one escalated specification
ambiguity (**A2**, the `p ≠ 1` dimensional coupling).

`PHASE_8_INDEPENDENT_VERIFICATION.md` (2026-08-04) returned **PASS WITH MINOR ISSUES**:
21/21 checklist items PASS, with two "minor, not blocking" findings:

| # | Historical finding | Its stated severity |
|---|---|---|
| 1 | `signDiscipline.assertOrThrow()` is never called from `src/`; a violation leaves `phi.evaluate()` returning `ok: true` | *"Minor, not blocking. Nothing in Phase 8 calls `phi.evaluate()` from a live path… it is dormant until Phase 10 wires a round loop."* |
| 2 | `columnBuilder.assertSingletonRegime()` is not called by `build()` | *"Minor, lower than Finding 1. No code path exists today that could produce a multi-Leg column."* |

Both severities rested on the same premise, stated explicitly in Part 6 of that review:
**"nothing in Phase 8 is called from a live path."**

### 2.2 What was re-verified against the current tree, and what that premise is worth now

That premise is **false today**. Phase 10 exists. The live path is:

```
workers/coordinator.worker.js → solve/round.js:345 columnBuilder.build()
                              → plan/columnBuilder.js:98  column.price()
                              → plan/column.js:186        phi.evaluate()
```

The historical review's own recommendation — *"close Findings 1 and 2 before Phase 10 starts
calling `phi.evaluate()` from a live path"* — was never actioned, and Phase 10 landed. This is
the third consecutive phase whose verification verdict was stale by the time it was read
(Phase 4's was two weeks stale; Phase 7's was two weeks stale). **The pattern is now established
enough to be worth naming: a phase verification's severity ratings expire when later phases land,
and nothing in this repository re-checks them.**

Every substantive claim in both reports was re-verified against the current tree by independent
reproduction rather than by reading: two purpose-built harnesses (62 and 42 checks), a live
PostgreSQL instance, a planted structural violation, and full re-runs of every lane.

**Claims re-verified and confirmed still true:** the telescoping identity at residual exactly 0;
§8.3.3(b) and (c) as structural properties of the signatures; the Leg attribution rule for a
three-Leg Mission; the aging cap; `γ` exactness in integer milli-CU; no normalisation anywhere;
`V_terminal` carrying no weighting coefficients; the six §8.2 time components; the single cost
authority; T1/I14 enforcement.

**Claims re-verified and found wrong or incomplete:** the four defects in §4 below.

---

## 3. Current Repository State

### 3.1 Phases present

The repository now contains **Phases 0–15**. `candidates/`, `solve/`, `intake/`, `observability/`,
`reliability/`, `fairness/`, `cutover/`, `security/`, `privacy/`, `shard/`, `degraded/` and
`failure/` are all populated — every one of them empty at the time Phase 8 was verified.

| Phase | State entering this remediation | Treatment here |
|---|---|---|
| 6 — Feasibility | **CLOSED** (38/38 predicates, I14 planted bypass, live PG) | Verified against, **not modified** |
| 7 — Energy & payload | **CLOSED** (F26 fixed, 82 DB checks, V9 deferred) | Verified against, **not modified**; V9 untouched |
| **8 — Cost & Plan Builder** | PASS WITH MINOR ISSUES, verification 2 weeks stale | **This remediation** |
| 9 — Candidates & bound | Present | Interface verified; **not modified** |
| 10 — Round loop & solve | Present | Consumer identified; **not modified** |
| 11–15 | Present | Not touched |

### 3.2 Phase-8 ownership map

| Path | Owner | Phase 8 depends on it? | Phase 8 modifies it? | Touched here? |
|---|---|---|---|---|
| `src/engine/cost/**` (12 modules) | **Phase 8** | — | yes | `cDelay.js`, `cRisk.js`, `phi.js` |
| `src/engine/plan/**` (5 modules) | **Phase 8** | — | yes | `columnBuilder.js` |
| `src/engine/pricing/**` (3 modules) | **Phase 8** | — | yes | no change needed |
| `src/engine/routing/cellPairCache.js` | **Phase 8** | — | yes | no change needed |
| `src/workers/serviceTimeModel.worker.js` | **Phase 8** | — | yes | `loadVersion()` |
| `src/workers/capacityPricing.worker.js` | **Phase 8** | — | yes | no change needed |
| `src/engine/feasibility/**` | Phase 6 (closed) | yes — brands the plan | **no** | **not touched** |
| `src/engine/energy/**`, `payload/**` | Phase 7 (closed) | yes — physical models | **no** | **not touched** |
| `src/engine/determinism/fixedPoint.js` | Phase 1 | yes — the arithmetic | **no** | **not touched** |
| `src/engine/candidates/**` | Phase 9 | consumes `cDelay.forLeg` | **no** | **not touched** |
| `src/engine/solve/**` | Phase 10 | consumes `columnBuilder`, `column` | **no** | **not touched** |
| `src/engine/observability/**` | Phase 11 | consumes column/pruning output | **no** | **not touched** |

### 3.3 Single cost authority — audited, confirmed

A repository-wide scan for every cost expression (`Φ(`, `cost(`, `insertionPrice`,
`singletonColumnPrice`, `opportunityCost`, `delayCost`, `energyCost`, `churnCost`,
`lifecycleCost`, `policyCost`, `directCost`, `riskCost`, `cu_per_metre`, `milliCU`) found
**no second cost authority**:

- Phase 9's `candidates/lowerBound.js` **calls Phase 8's own `cDelay.forLeg()`** rather than
  reimplementing the delay model (`lowerBound.js:153`).
- Phase 10's `solve/minCostFlow.js` and `solve/objective.js` consume `gammaMilliCU`; neither
  computes a cost.
- `plan/insertion.js` calls `phi.evaluate()` and contains no cost model of its own.
- The legacy `src/services/costEvaluator.service.js` — the baseline min-max evaluator §1.3 exists
  to remove — **no longer exists**; `npm run gate:legacy` proves it absent from the build,
  unimported, and with no retired symbol redefined across 312 files.

---

## 4. Files Changed

Nine files. Every one answers all five audit questions.

| File | Reason | Requirement / defect | Regression tests |
|---|---|---|---|
| `Backend/src/engine/cost/cDelay.js` | `forPlan()` now runs §8.7's once-per-Mission check before summing | **D1** — `M_breach` charged twice for one Mission | 3 (`costFunction.test.js`) |
| `Backend/src/engine/cost/phi.js` | A violated sign declaration, or a missing Ω bound, now refuses the price; dev/test escalates by throwing | **D2** — §8.1, §6.4; historical Finding 1 | 5 (`costFunction.test.js`) |
| `Backend/src/engine/cost/cRisk.js` | Lateness scales through `fixedPoint.scaleByRate`, not `Math.round` | **D3** — §9.6's single rounding site | 3 (`costFunction.test.js`) |
| `Backend/src/engine/plan/columnBuilder.js` | `build()` runs `assertSingletonRegime()` over the set it emits | historical Finding 2 | 2 (`planBuilder.test.js`) |
| `Backend/src/workers/serviceTimeModel.worker.js` | `loadVersion()` reads in a total order and refuses a doubly-claimed cohort | **D4** — §9.6 requirement 6 | 2 (`costSchema.test.js`) |
| `Backend/prisma/migrations/20260818090000_service_time_model_nulls_not_distinct/` | Redeclares the five-part cohort key `NULLS NOT DISTINCT` | **D4** | 3 (`costSchema.test.js`) |
| `Backend/prisma/schema.prisma` | Records that the clause lives only in the migration, and why | **D4** | 1 (`costSchema.test.js`) |
| `Backend/tests/engine/planBuilder.test.js` | Strengthens the six-component sum test, which only held at zero release delay | test-coverage gap | 1 |
| `Backend/tools/verify/phase8LiveDatabase.js` | **New.** Discharges the live-DB gap both historical reports carried | §10, §14 item 9 | 42 live checks |

**Not changed, deliberately:** no Phase 6 file, no Phase 7 file, no Phase 9+ file, no Phase 1
arithmetic module, no gate script, no `guards/tenets.js`, no `MODULE_TIERS`, no `MECHANISMS`, no
Safety parameter, no kill switch, no test deleted, skipped, weakened, or re-baselined.

---

## 5. The Four Defects

### D1 — `M_breach` charged more than once per Mission (§8.7)

**Severity: correctness, live.** §8.7 is unambiguous: *"`M_breach` appears **once per Mission**,
on the terminal Leg only."* `cDelay.assertAttribution()` implements exactly that check and is
correct. It had **no production caller**. `cDelay.forPlan()` — the only place a plan's Legs are
summed — counted terminal Legs but never checked them.

Independently reproduced: a plan with Legs `a` and `b`, both `TERMINAL`, both `missionId: "m1"`,
both breaching, priced at **370 000 000 milli-CU with two breach steps** and `ok: true`. The
correct price carries one. The over-charge enters `C_delay`, hence `Φ`, hence `γ`, hence the
solver's objective — it does not fail loudly, it makes the round prefer the wrong agent.

**Fix.** `forPlan()` calls `assertAttribution()` before summing and refuses on failure. A Leg
with no `missionId` keys as the empty Mission, so two unidentified terminal Legs are refused
rather than assumed distinct — the same "neither default is safe" reasoning `forLeg()` already
applies to an unstated role, taken in the direction that cannot silently over-charge.

**Propagation verified:** `cDelay` → `phi.evaluate()` `ok:false` → `column.price()` `ok:false` →
`columnBuilder` prunes the column as `UNPRICEABLE` **with the reason recorded** → Tier A counts it,
Tier B carries the detail. The round proceeds on its remaining candidates.

### D2 — A violated sign declaration was reported into an array nothing reads

**Severity: correctness of the §6.4 admissibility proof, live.** This is historical Finding 1,
whose "minor/dormant" rating expired when Phase 10 landed.

§8.1: *"A cost term whose sign is not stated cannot be safely pruned against, and this document
uses pruning."* §6.4's bound is admissible **only** because exactly two terms may go negative and
each is bounded by exactly the quantity subtracted. As shipped, a term beneath its floor produced
`ok: true`, a full `milliCU` value, and a note in `problems`.

Three facts, each verified directly, make that note worthless:

1. `signDiscipline.assertOrThrow()` — which the module's own docstring says *"the development and
   test environments enable"* — was called from **no module under `src/`**, in any environment.
2. `solve/round.js` receives `built.problems` from `columnBuilder.build()` and **never reads it**
   (grepped; the only `problems` it handles are the expansion's and the solver's).
3. `observability/tierA.js` and `decisionRecord.js` have **no field** carrying Φ's problems.

So a candidate whose `C_policy` credit exceeded `Ω_policy` was priced, selected, committed, and
recorded — while the decision record advertised a pruning proof that no longer held. That is
precisely the failure §6.4 singles out as *worse than having no bound at all*.

A second, quieter half: when `bounds` was **absent entirely**, `check()` reported "no bound was
supplied" and Φ still returned `ok: true`. A caller that simply omitted `bounds` received a priced
column carrying no admissibility guarantee whatsoever.

**Fix.**
- An absent Ω bound for a `BOUNDED_BELOW` term is a **missing input**, named, `ok: false` — the
  way every other unresolved input in the module is reported, and the way `cOpportunity.evaluate()`
  already treated an absent `Ω_terminal`. Required only for the terms actually summed: an
  unregistered `C_opportunity` needs no bound.
- A **violated** declaration refuses the price (`ok: false`, finding in `problems`), which puts it
  on the one path that is recorded — `columnBuilder`'s pruning — instead of an array with no reader.
- `escalationEnabled()` throws in `NODE_ENV` of `test` or `development`, making the checklist's
  "assert at runtime in dev/test" true for the first time. Enabled on an **explicit** value only:
  an unset `NODE_ENV` is common in production, and treating "not production" as "development"
  would turn a reporting path into a throwing one exactly where throwing is least wanted.

### D3 — A second rounding mode in the priced path (§9.6)

**Severity: latent; no numeric divergence on today's inputs.** `cRisk.js` computed its lateness
term as `BigInt(Math.round(Number(overrunMilliCU) * lateProbability))`, with a comment claiming
"one rounding, at the same boundary as the rest of the term". It was not the same boundary.
`fixedPoint.js` declares `ROUND_HALF_AWAY_FROM_ZERO` as *the* mode and states that "the conversion
boundary is one function"; `Math.round` rounds half toward +∞ and skips the int64 range check that
makes an overflow an error rather than a silently wrapped cost.

The two agree on every reachable input today, because a delay cost is non-negative — **which is
exactly why this would have been found only after some later change made a negative overrun
reachable.** Routed through `scaleByRate`. A source scan now asserts that **no** module under
`cost/` calls `Math.round/floor/ceil/trunc` at all.

### D4 — §13.2's shrinkage ladder was unconstrained by its own unique key

**Severity: §9.6 replay determinism. Found only against a live database.** Both historical reports
recorded the migration as *"not applied to a live database"* and neither could reach this.

`ServiceTimeModel`'s five-part unique key spans four nullable columns, and §13.2's hierarchy **is**
the NULL pattern: `hourOfWeek IS NULL` is the cohort marginalised over the hour. PostgreSQL's
UNIQUE default is `NULLS DISTINCT`. Verified against PostgreSQL 18.3: the index as shipped was
`NULLS DISTINCT`, and **a duplicate broad cohort was ACCEPTED**.

The consequence is not untidiness. `loadVersion()` read a pinned version with `findMany({ where:
{ version } })` — no `ORDER BY` — and assigned `models[key]` as rows arrived. With two rows
claiming one cohort, the surviving dwell distribution is whichever row PostgreSQL happened to
return last. **Two loads of the same pinned model version can therefore produce different service
times, hence a different timeline, a different `Φ`, and a different allocation** — while §9.6
requirement 6 pins the version precisely so that cannot happen.

The duplicate is reachable: `fit()` takes `version` from its caller with no check that the version
is unused, and its write loop catches a per-row failure and continues — so a retry of a partially
failed fit at the same version re-creates every row, refused by the index for the fully-specified
cohorts and **silently duplicated for exactly the broad ones the ladder falls back to**.

This is the same defect, and the same repair, that Phase 6 applied to `RejectionAggregate` in
`20260817120000_rejection_aggregate_nulls_not_distinct`. Closed twice over:

- **Storage:** migration `20260818090000` redeclares the key `NULLS NOT DISTINCT`. Any pre-existing
  duplicate group is reduced first, keeping the **best-supported** fit — greatest `sampleCount`
  (§13.2's shrinkage weight *is* that count, so the largest is the least-shrunk estimate), then
  most recent `fittedAt`, then least `id`. Nothing of value is lost: `loadVersion()` was already
  discarding all but one row of each group; this makes the choice deterministic and explicit
  rather than dependent on physical row order. No column dropped, no table rewritten.
- **Reader:** `loadVersion()` reads in a total order and **refuses** a version whose cohort key is
  claimed twice, rather than resolving it by arrival order.

---

## 6. Plan Builder Verification

| Property | Method | Result |
|---|---|---|
| **Completeness — all seven §13.1 bullets** | Field-by-field against the specification text, on a real `build()` output | **7/7 present** |
| ordered stop sequence incl. inserted charging stops | `plan.stops`, resequenced 1..n | ✅ |
| per-stop arrival / service start / service end / departure, each with a band | all four + `band.arrivalSdSeconds`, `band.departureSdSeconds` | ✅ |
| per-leg route refs, distances, travel-time distributions | `plan.legProfiles`, `plan.distanceM` | ✅ |
| per-stop payload state (mass, volume, compartment, custody) | `plan.loadState` length = stop count | ✅ |
| per-stop energy state with band | `stop.energy.remainingUsableWh` + `band` | ✅ |
| terminal state (position, SoC, time) — `V_terminal`'s input | `plan.terminal {lat, lon, cellId, zoneId, usableWh, soc, releaseMs}` | ✅ |
| per-stop feasibility | `plan.stopFeasibility` length = stop count | ✅ |
| **Determinism** | identical inputs × **1000**, byte-compared | identical every time |
| | source scan for clock / randomness | none |
| **Immutability during costing** | plan serialised before and after `Φ`, compared | **identical** |
| **Rejection of invalid plans** | 6 constructed cases | all refused, each by name |
| — no stops / no Legs | | `NO_STOPS` |
| — drop before pickup | | precedence refusal quoting §13.3 |
| — missing travel times | | `MISSING_TRAVEL_TIME` |
| — missing energy model | | `MISSING_ENERGY_INPUT` |
| — missing service-time inputs | | `MISSING_SERVICE_TIME` |
| **F17 as plan feasibility, not arc capacity** | column exposes no capacity field; over-depth plan refused | ✅ |

**On plan freezing.** §13 states no immutability requirement, and freezing the plan would be
actively wrong: only `feasibility/evaluate.js` may brand, and it brands by defining a Symbol
property on the plan object. The invariant the specification *does* require — a cost calculation
must not mutate the plan — holds and is verified. `Φ`'s own returned breakdown **is** frozen, so a
caller cannot edit a priced result.

---

## 7. Cost Function Verification — all seven terms

§8.1 defines `Φ` over six terms and the column price `γ(c) = Φ(plan(c)) − Φ(plan₀(a)) + C_churn(c)`
over seven. `C_churn` is a term of the **column price**, not of `Φ` — the implementation keeps that
distinction structurally (`phi.js` cannot see it; `column.js` obtains it by registration).

| # | Term | Formula as implemented | Units | Arithmetic | Independent test | Result |
|---|---|---|---|---|---|---|
| 1 | `C_direct` | `λ_time·(t_wait+t_approach+t_service_first+t_linehaul+t_service_last+t_terminal) + cu_per_wh·E + cu_per_metre·d` (last addend reported, charged in `C_lifecycle`) | CU·s⁻¹·s + CU·Wh⁻¹·Wh + CU·m⁻¹·m → CU | BigInt milli-CU; one conversion per addend | hand-computed: 1260 s·1 + 400 Wh·1 = 1 660 000 mCU; wear 30 000 mCU reported apart | **PASS** |
| 2 | `C_opportunity` | `∫[t_start→t_release] λ_zone(origin_zone,τ)dτ + [V_term(start,t_rel) − V_term(end,t_rel)]` | CU·s⁻¹·s → CU | float in the two integrals, one `cu()` conversion at the boundary | telescoping residual **exactly 0**; ∫ = 6 CU by hand; monotone in λ and in duration; antisymmetric relocation | **PASS** |
| 3 | `C_risk` | `p_fail·C_failure + Σ_tier p_energy[tier]·C_cons[tier] + p_late·E[overrun] + staleness + route_hazard` | probability × CU → CU | tiers summed separately; overrun scaled via `scaleByRate` | three tiers priced independently; p ∉ [0,1] refused | **PASS** (fixed, D3) |
| 4 | `C_lifecycle` | `cu_per_metre·d + battery_cycle(§14.4) + actuator + tyre_and_brake + thermal_stress` | CU·m⁻¹·m + CU·cycle + … → CU | BigInt sum; battery term **calls** Phase 7's `wear.batteryWear()` | 5 addends present; 10 km > 1 km strictly | **PASS** |
| 5 | `C_policy` | `Σ` named adjustments, each clamped at its declared credit ceiling | CU | BigInt; `Ω_policy` derived at publish | ceiling clamps; expired pilot refused; unattributed refused; unregistered refused | **PASS** |
| 6 | `C_delay` | `Σ_legs w_sla·aging(age)·max(0,T_c−T_target)^p + M_breach·1[T_c>T_deadline]` (terminal Leg only) | see §8 below | one float expression, one conversion | closed-form by hand at p=2; attribution; aging cap | **PASS** (fixed, D1) |
| 7 | `C_churn` | `1[displaces]·(base + per_second·elapsed + wasted_travel·distance + notification)` | CU + CU·s⁻¹·s + CU·m⁻¹·m → CU | BigInt; term of `γ`, not of `Φ` | degraded path tested; kill switch named | **PASS** |

**Decomposition, verified exactly:**

```
Φ(plan) = Σ terms                     181 728 228 milli-CU = Σ of the five core terms   ✅ exact
Φ with C_opportunity registered       181 693 228 milli-CU = Σ of six terms             ✅ exact
Φ(six) − Φ(five)                          −35 000 milli-CU = C_opportunity exactly       ✅
```

No hidden term (`termsSummed` is the complete key list); no term counted twice
(`assertWearChargedOnce` proves the one shared coefficient is charged in exactly one term, and
catches a Φ that summed it in both); no term silently omitted (an unregistered Tier 2 term is
**recorded as omitted**, never summed as zero — the distinction §22.5 requires).

**No normalisation:** re-derived independently. The gate strips comments and scans all 12 `cost/`
modules for `Math.min(...spread)` / `Math.max(...spread)` and for any `normalise(`/`normalize(`
definition outside `units.js`. `units.refuseNormalisation()` throws for `min-max`, `rank`,
`z-score`. Absolute CU throughout; a single candidate is priced at its own absolute cost, not 0.5
of a range.

**Configuration ownership:** `npm run gate:params` PASS — 183 engine modules against 242 registered
parameters, **no bare behavioural constants**. Every rate is built through `makeRate()`, which
refuses a name absent from the register, refuses a negative rate, and refuses a unit that
disagrees with the dimension it is priced as. `applyDimensionlessFactor()` permits only the four
dimensionless factors the specification itself names. `V_terminal` is `a − b − c` with no
multiplication and no config read.

---

## 8. Mathematical Verification

### 8.1 Exact arithmetic

Every cost is an int64 milli-CU `BigInt`. The float→integer boundary is one function
(`fixedPoint.toMilliCU`), which performs the scaling **exactly in base ten** with no float
intermediate, under `ROUND_HALF_AWAY_FROM_ZERO` — chosen because it is symmetric under negation,
which matters for the two terms that may be negative. Overflow is a `RangeError`, never a wrap.

| Adversarial case | Behaviour | Verdict |
|---|---|---|
| zero, one, exact boundary values | priced exactly | ✅ |
| `NaN` completion / energy | refused by name | ✅ |
| `Infinity` wait / completion | refused by name | ✅ |
| negative distance, negative queue age, negative dispersion | refused by name | ✅ |
| probability outside [0, 1] | refused before it can scale anything | ✅ |
| milli-CU below 2⁵³ | **exact** | ✅ |
| milli-CU above 2⁵³ | loss bounded by **1 milli-CU** (one ULP), never unbounded, never silent | documented (§16) |
| int64 overflow | `RangeError`, not a wrap | ✅ |
| `Φ(plan)` × 1000 | byte-identical every time | ✅ |

Never does a `NaN` or `Infinity` become a valid low-cost plan: the conversion boundary throws on a
non-finite input, and every term validates its inputs before reaching it.

### 8.2 Dimensional analysis

| Quantity | Input unit | Rate | Result |
|---|---|---|---|
| committed time | s | `cost.lambda_time` CU·s⁻¹ | CU ✅ |
| energy | Wh | `cost.energy.cu_per_wh` CU·Wh⁻¹ | CU ✅ |
| distance | m | `cost.wear.cu_per_metre` CU·m⁻¹ | CU ✅ |
| gradient exposure | m | `lifecycle.cu_per_gradient_metre` CU·m⁻¹ | CU ✅ |
| thermal exposure | s | `lifecycle.cu_per_thermal_stress_second` CU·s⁻¹ | CU ✅ |
| staleness | s | `cost.staleness.cu_per_second_age` CU·s⁻¹ | CU ✅ |
| availability | s | `λ_zone` CU·s⁻¹ | CU ✅ |
| probability | dimensionless | CU consequence | CU ✅ |
| **lateness** | **s^p** | **`cost.sla.cu_per_second_late` CU·s⁻¹** | **CU·s^(p−1) — see below** |

Seconds vs milliseconds: every module carries a named `MS_PER_SECOND` and converts once at its
own boundary; no raw millisecond quantity is ever priced. CU vs milli-CU: enforced by
`assertCost()`, which refuses a value whose `dimension` is not CU.

### 8.3 The lateness exponent (A2) — independently re-derived

Reproduced from the frozen text rather than from the reports. §8.7 raises lateness to `p`
(default 2). §8.10 registers `cost.sla.cu_per_second_late` as **CU·s⁻¹**. At `p = 2`,
`CU·s⁻¹ · s² = CU·s`, not CU. **The inconsistency is real and it is in the specification.**

Searched the whole repository for an authoritative resolution — a Safety decision, an architecture
amendment, a governed ruling. **None exists.** Phase 9's report and Phase 10's verification both
refer to A2 as still-open and cite its disposition as precedent.

Disposition, unchanged and correct: **SPECIFICATION ISSUE / awaiting a governed decision.** The
implementation follows §8.7 exactly; the coupling is stated in the module header; the arithmetic
is pinned by test so any change is visible. No formula was invented, and neither the exponent nor
the rate's unit was silently redefined. The practical consequence stands and is worth repeating
because the two parameters have **different owners and different change classes**:
`cost.sla.cu_per_second_late` must be calibrated **at the exponent in force**, and changing
`cost.sla.lateness_exponent` (POLICY) without recalibrating the rate (CONTRACTUAL) rescales every
delay cost in the fleet.

### 8.4 Property-based invariants

All verified, none invented beyond what the specification guarantees:

```
Φ(plan)                = Σ of the seven specified terms, exactly            ✅
γ(c)                   = Φ(plan(c)) − Φ(plan₀) + C_churn, exactly           ✅
Φ(∅)                   = 0 exactly, so γ = Φ(plan) for an idle agent        ✅
zero delay             → zero delay term                                     ✅
identical plans        → identical cost (×1000)                              ✅
one input changed      → only the affected term changes                      ✅
infeasible candidate   → cannot be priced (5 forgery routes refused)         ✅
λ_origin ↑             → unavailability non-decreasing                       ✅
duration ↑             → unavailability non-decreasing                       ✅
relocation(a→b)        = −relocation(b→a)                                    ✅
telescoping residual   = 0 exactly, incl. past the horizon                   ✅
```

---

## 9. Delay Attribution

### 9.1 Leg-level isolation

Three Legs A, B, C, delay injected into **B only** (+60 s):

| Leg | before | after | change |
|---|---|---|---|
| A | 0 | 0 | **unchanged** |
| **B** | 0 | 7 200 000 mCU | `w_sla · (60 s)² = 2 · 3600 = 7200 CU` ✅ exact |
| C | 0 | 0 | **unchanged** |

Delay is attributed at the Leg, not at the Task or Mission. The plan total equals the sum of the
per-Leg terms exactly. Committed Legs are priced too — a three-Leg plan with two committed Legs
reports all three, which is what makes a column pay for the delay it imposes on existing work.

### 9.2 The attribution rule (§8.7)

| Case | Expected | Observed |
|---|---|---|
| terminal Leg, inside deadline | `w·aging·lateness^p`, no breach | 180 000 000 mCU, `breached: false` ✅ |
| terminal Leg, past deadline | above **+ `M_breach` once** | 185 000 000 mCU ✅ |
| upstream Leg, past deadline | `upstream_slack_weight · w · lateness^p`, **no breach** | 27 000 000 mCU (= 0.15 × 180 M), `breached: false` ✅ |
| Leg with no stated role | **refused**, both defaults named unsafe | refused ✅ |
| three-Leg Mission | one full term + two slack terms, one breach | ✅ |
| **two terminal Legs, one Mission** | **refused** | **was: priced with two breaches** → now refused (**D1**) |
| two terminal Legs, **different** Missions | both priced, two breaches — the rule is per Mission | ✅ |

### 9.3 Double-counting

Verified by manual construction that no delay is charged twice. `C_delay` is indexed by Leg and
evaluated at that Leg's own completion time; a downstream Leg's arrival delay is priced as *its*
lateness against *its* target, not re-charged against the upstream Leg. The one place the
specification does price the same functional twice is `C_risk`'s
`p_late · E[C_delay overrun | late]`, which is an **expectation over a worse completion time**,
explicitly required by §8.4 — and it calls `cDelay.overrunGivenLate()`, the same functional, so
the two cannot disagree about the delay model.

---

## 10. Opportunity Cost

Independently re-derived against §8.3.3 rather than re-read.

- **(a) No double count.** `unavailability()` is computed as `atStart.cu − atRelease.cu`, two calls
  to the *same* `vAvail()`. It is the telescoping bracket, not an independent re-derivation of the
  closed form, so the halves cannot desynchronise. `telescopingResidual()` recomputes the
  undecomposed difference: **residual exactly 0**, including for a commitment past the horizon.
- **(b) Origin zone, fixed position.** `unavailability({priceSnapshot, originZoneId, startMs,
  releaseMs, horizonEndMs})` — **no route, path, or end-position parameter exists**. Structurally
  enforced by the signature, verified by scanning the function body.
- **(c) Both relocation evaluations at `t_release`.** `relocation()` takes **one** `releaseMs` and
  applies it to both states. A caller cannot supply two.
- **`V_terminal` has no weighting coefficients.** `cu: vAvailCu − chargeAccessCu − socDeficitCu`.
  No config argument, no multiplication.

| Test | Result |
|---|---|
| ∫λ over origin zone, λ=0.01 CU·s⁻¹ × 600 s | **6 CU** — matches by hand ✅ |
| idle / zero-length commitment | forgoes exactly 0 ✅ |
| commitment past `T_H` | saturates at the remaining-horizon integral **and reports `horizonSaturated`** ✅ |
| `t_release` before `t_start` | refused ✅ |
| zone with no published price | **refused, never valued at zero** ✅ |
| price surface not covering `T_H` | refused — a gap-truncated integral is not a horizon-truncated one ✅ |
| negative λ in the surface | refused, at the module **and** by a database CHECK ✅ |
| missing `Ω_terminal` | refused — an unbounded negative term cannot be pruned against ✅ |
| **monotonicity** where §8.3.3 guarantees it (λ ↑, duration ↑) | non-decreasing across 6 and 6 paired scenarios ✅ |

Monotonicity was **not** imposed on the relocation component, which §8.3.3 explicitly allows to be
negative; it was verified antisymmetric instead, which is the property the derivation does grant.

---

## 11. Insertion Pricing

The identity `insertion price = cost(plan + insertion) − cost(baseline plan)` was proven exactly,
in integer milli-CU, at **every** insertion position:

| Position | `γ` | `Φ(plan+ins) − Φ(base)` | Equal? |
|---|---|---|---|
| beginning | 180 000 000 mCU | 180 000 000 mCU | ✅ exact |
| middle | 180 000 000 mCU | 180 000 000 mCU | ✅ exact |
| end | 180 000 000 mCU | 180 000 000 mCU | ✅ exact |
| idle agent (`plan₀ = ∅`) | `Φ(plan)` | `Φ(plan)` | ✅ exact — `Φ(∅) = 0` |

`column.recompute()` re-derives `γ` from the two stored `Φ` values with **no tolerance parameter**;
a one-milli-CU disagreement is caught.

**No shadow plan.** Verified structurally: `plan/insertion.js` calls
`planBuilder.buildVariant()` — the real Plan Builder — for every candidate position, takes the
feasibility gate by **injection** (it contains no reference to `brandFeasible` and therefore
cannot manufacture a priceable plan), and prices with `phi.evaluate()`. It contains no cost model
of its own. Enumeration is exhaustive below `plan.max_exhaustive_stops` and a **bounded, recorded**
heuristic beyond it; precedence holds at every enumerated position pair. An infeasible insertion is
recorded per position rather than asserted away.

---

## 12. Singleton Column Pricing

| Property | Result |
|---|---|
| singleton price **==** the corresponding plan cost | 181 728 228 mCU both ways — ✅ exact, no alternate formula |
| infeasible candidate receives a valid cost | **impossible** — `assertFeasible` at every entry point |
| deterministic price for a feasible candidate | ✅ (×1000) |
| column exposes a capacity field a solver could consume instead of F17 | **no** — `{agentId, legIds, insertionPositions, plan, basePlan, identity, singleton}` |
| F17 / commitment horizon enforced as **plan** feasibility | ✅ over-depth and over-horizon plans refused |
| generation gap in the singleton regime | **exactly `0n`**, reported separately from §6.4's search gap and never summed with it |
| multi-Leg column | **now refused by `build()` itself**, not merely by an uncalled predicate |

---

## 13. Phase 6 → Plan → Cost Integration

Proven end-to-end against the **current, closed** Phase 6:

```
candidate → evaluate.gate(candidate, context) → branded plan → phi.evaluate() → Φ  ✅
```

- A feasible candidate is admitted, branded, and **the same object** is what `Φ` prices
  (verified by object identity, not by shape).
- An **infeasible** candidate (denied by F2) is returned `candidate: null` — unbranded — and
  cannot reach `Φ`.
- An **indeterminate** candidate is likewise not branded (§7.3's three-valued discipline).

### 13.1 The planted structural violation

Required by the brief, and run:

| Step | Command | Result |
|---|---|---|
| 1. plant | remove `assertFeasible(plan, …)` from `phi.evaluate()` | — |
| 2. gate | `npm run gate:tenets` | **FAIL — 1 violation**: *"`src/engine/cost/phi.js:326` accepts candidate-shaped parameter "plan" but the module never calls assertFeasible(); cost evaluation must be structurally unable to see an infeasible candidate (§1.5 T1, §7.1, I14)"* |
| 3. restore | | file **byte-identical** to its pre-plant state (verified by `diff`) |
| 4. gate | `npm run gate:tenets` | **PASS — 274 modules, no violations** |

### 13.2 Forgery routes, all refused

| Attack | Result |
|---|---|
| raw unbranded object → `Φ` | `T1 violation` ✅ |
| `JSON.parse(JSON.stringify(plan))` | `T1 violation` ✅ |
| object spread `{...plan}` | `T1 violation` ✅ |
| `Object.assign({}, plan)` | `T1 violation` ✅ |
| `structuredClone(plan)` | `T1 violation` ✅ |
| test helper manufacturing a brand | **impossible** — only `feasibility/evaluate.js` may brand; `costFixture` brands by running the real gate |

The structural guarantee is a build gate, not a runtime hope.

---

## 14. Phase 8 → Later-Phase Integration

Interfaces verified; **no later-phase module was modified**.

| Consumer | What it consumes from Phase 8 | Verified |
|---|---|---|
| Phase 9 `candidates/lowerBound.js` | calls `cDelay.forLeg()` directly | one delay model, not two ✅ |
| Phase 9 `candidates/omega.js` | reads `Ω_terminal` / `Ω_policy`, aware `C_opportunity` may be unregistered | ✅ |
| Phase 9 `admissibilityGate.js` | the `LB ≤ γ` relationship | ✅ (Phase 9's gate, not re-implemented here) |
| Phase 10 `solve/round.js` | `columnBuilder.build()` → priced columns, pruning, generation gap | ✅ |
| Phase 10 `solve/regime.js` | `column.singleton` | ✅ |
| Phase 10 `solve/objective.js` / `minCostFlow.js` | `gammaMilliCU` | consumes, never recomputes ✅ |
| Phase 11 `observability/tierA.js`, `tierB.js` | column counts, pruned columns with reasons, Ω values | ✅ — and this is the path D1/D2's refusals now travel |

**One interface observation, recorded with its owner.** `feasibility/evaluate.gate(candidate,
context)` takes the plan twice — once as `candidate` (which it brands) and once as `context.plan`
(which the 38 predicates read). Nothing structurally requires them to be the same object. No
Phase 8 module can decouple them, and no in-repo production caller exists to check (the
`pricedCandidateFor` seam is supplied at deployment). `gate()` is **Phase 6's** module and Phase 6
is closed; adding the identity assertion there is Phase 6's call, not Phase 8's, and would break
several existing fixtures that legitimately pass distinct objects. Recorded in §16 as a
cross-phase item rather than silently fixed or silently ignored.

---

## 15. Database Verification

**Live PostgreSQL 18.3**, disposable cluster on port 55433, built from installed binaries into the
scratchpad and destroyed afterwards. **No production, Neon, or user database was touched.** All 23
migrations applied in directory order with `ON_ERROR_STOP=1`, yielding 73 tables.

New harness: `Backend/tools/verify/phase8LiveDatabase.js` — **42 checks, 42 passed, 0 failed.**
It writes only `p8-live-` prefixed rows and removes them in a `finally`; the run ends by asserting
it left nothing behind.

| Area | Checks | Result |
|---|---|---|
| Tables and columns | 14 | ✅ |
| — `ZonePriceSnapshot` has **no `updatedAt`** (insert-only; §9.6 replay) | | confirmed against the live table |
| — `omegaTerminalCu` rides on the row (§6.4) | | confirmed |
| — all four §13.2 discriminators nullable; mean/sd/count/version NOT NULL | | confirmed |
| CHECK constraints present in `pg_constraint` | 5 | ✅ all four, plus the estimator enumeration |
| **CHECK constraints actually fire** | 13 | ✅ |
| — negative `λ_zone` refused; λ = 0 accepted | | ✅ |
| — negative `Ω_terminal` refused | | ✅ |
| — a fourth estimator refused; all three named ones accepted | | ✅ |
| — negative mean / dispersion / sampleCount refused; zero-with-zero accepted | | ✅ |
| Uniqueness and NULL handling | 6 | ✅ **after D4's fix** |
| — `ZonePriceSnapshot (version, zoneId, bucket)` unique | | ✅ |
| — `ServiceTimeModel` five-part key unique when fully specified | | ✅ |
| — **the key is `NULLS NOT DISTINCT`; a duplicate broad cohort is REFUSED** | | ✅ (was: ACCEPTED) |
| Foreign-key delete behaviour | 2 | ✅ `Zone` delete cascades 5→0 price rows; `Site` delete cascades 2→0 model rows |
| Migration additivity | 1 | ✅ |

**Migration safety audit.** Every occurrence of `DROP`, `DELETE`, `TRUNCATE`, `RENAME`,
`ALTER COLUMN` in both Phase 8 migrations was inspected:

- `20260804220000_cost_function_and_plan_builder`: `CREATE TABLE` ×2, `CREATE INDEX` ×7, foreign
  keys ×2, CHECK constraints ×4. The only `DELETE` tokens are inside `ON DELETE CASCADE` clauses.
  Nothing dropped, renamed, or re-typed.
- `20260818090000_service_time_model_nulls_not_distinct`: one `DELETE` reducing duplicate groups
  (guarded by `ROW_NUMBER() … > 1`, so it can only touch a group of size > 1), a
  `DROP INDEX IF EXISTS` / `DROP CONSTRAINT IF EXISTS` pair replacing the index in place, and the
  `CREATE UNIQUE INDEX … NULLS NOT DISTINCT` over the identical column list. No column dropped,
  no table rewritten.

`npx prisma validate` — **schema valid**.

---

## 16. Test Results — current, measured, not transcribed

```
BUILD GATES                                                          7 / 7 PASS
  gate:tiers      PASS — 277 modules, 388 governed edges, no Tier 0/1 → Tier 2
  gate:params     PASS — 183 engine modules / 242 registered parameters, no bare constants
  gate:tenets     PASS — 274 modules, no T1 or T6 violations
  gate:privacy    PASS — 16 modules in cost/decision scope hold no identifying field
  gate:erasure    PASS — 3 decisions reconstructed byte-for-byte from Tier A alone
  gate:legacy     PASS — 4 retired modules absent and unimported across 312 files
  gate:columngen  PASS — NOT_REQUIRED for this change set

TEST LANES                                     suites     tests   failed   skipped
  engine                                          116      6169        0         0
  gates                                             7       100        0         0
  legacy                                           17       126        0         0
  chaos                                             3        44        0         0
  scale                                             3        23        0         0
  ─────────────────────────────────────────────────────────────────────────────
  TOTAL                                           146      6462        0         0

INDEPENDENT VERIFICATION (this remediation, outside the suite)
  harness 1 — cost function, terms, I14, numerics                62 / 62 passed
  harness 2 — Plan Builder, end-to-end, insertion, singleton     42 / 42 passed
  live PostgreSQL 18.3                                           42 / 42 passed
  planted I14 violation                          gate FAILS planted / PASSES restored
  prisma validate                                                        valid
```

**Engine lane before this remediation: 6 149 tests. After: 6 169. +20 regression tests**, one or
more per defect fixed:

| Suite | New tests | Covering |
|---|---|---|
| `costFunction.test.js` | 11 | D1 (3), D2 (5), D3 (3) |
| `planBuilder.test.js` | 3 | historical Finding 2 (2), six-component identity at non-zero release delay (1) |
| `costSchema.test.js` | 6 | D4 — migration shape, non-destructiveness, deterministic reduction, schema note, reader refusal, reader ordering |

**No test was deleted, skipped, weakened, re-baselined, or had an exact comparison loosened.** No
expected value was changed. No core calculation was mocked; no Plan Builder call was replaced by a
stub; no database behaviour was faked — the live harness uses a real PostgreSQL. Zero skipped tests
in any lane.

---

## 17. Remaining Limitations

Only genuine ones, each classified.

| # | Limitation | Class |
|---|---|---|
| 1 | **A2 — the `p ≠ 1` dimensional coupling.** §8.7's `lateness^p` with §8.10's CU·s⁻¹ rate is dimensionally consistent only at `p = 1`. Implemented literally; no repository-wide authoritative resolution exists. `cost.sla.cu_per_second_late` must be calibrated at the exponent in force, and the two parameters have different owners and change classes. | **SPECIFICATION ISSUE** — awaiting a governed decision |
| 2 | **A1's wear attribution is a stated reading.** §8.2 and §8.5 both name `cost.wear.cu_per_metre · d_mission`; §8.10 registers **one** rate, so Φ charges it once, in `C_lifecycle`, proved by `assertWearChargedOnce()`. The alternative reading would require a second registered rate. | **SPECIFICATION ISSUE** — disposition unchanged and defensible |
| 3 | **Above 2⁵³ milli-CU, `scaleByRate` forms a float64 product**, so applying a probability to such a quantity loses at most one ULP (measured: 1 milli-CU at 2⁵³+1). This is Phase 1's declared conversion boundary in `determinism/fixedPoint.js`, not a Phase 8 module. Below 2⁵³ the conversion is exact; overflow past int64 is an error, never a wrap. | **Later-phase ownership** (Phase 1) — bounded and documented, not silent |
| 4 | **`evaluate.gate(candidate, context)` does not structurally require `candidate === context.plan`.** No Phase 8 module can decouple them and no in-repo production caller exists; the gate is Phase 6's, and Phase 6 is closed. | **Cross-phase ownership** (Phase 6) — §14 |
| 5 | **`Φ`'s `problems` array still has no consumer in `src/`.** D2 removed the reliance on it — a violation now fails the price and travels the recorded pruning path — but forwarding the *text* into the decision record is Phase 10/11's field to add. | **Later-phase ownership** (Phase 10/11) |
| 6 | **13 Phase 8 inputs ship uncalibrated with `null` defaults**, each stating what it `awaits`. Null denies loudly; a fabricated coefficient would produce a plausible-looking wrong cost. | **Environmental** — calibration, by design |
| 7 | **The Capacity Pricing Service does not exist.** The engine's half of the contract is complete and validated at the boundary; `publish()` pads with `cost.opportunity.lambda_zone_prior` and records the degradation per zone and per row — §5.2's own declared envelope. | **Environmental** (blocking decision analogue) |
| 8 | **The routing engine does not exist (B1).** `cellPairCache.read()` takes `route()` by injection and is tested against a stub. §5.2's geometric fallback is deliberately not implemented — choosing among fallbacks is the round's decision, Phase 10's. | **Environmental** (B1) |
| 9 | **V9 — the seeded register still cannot publish** on combined degraded conservatism. Pre-existing since Phase 1, a **governed Safety decision** deferred by Phase 7. Phase 8 added no Safety-class parameter and **changed none**. | **Governed Safety decision** — untouched |
| 10 | **Per-stop energy bands apportion the mission's SD by cumulative consumption share** — a stated approximation consistent with the multiplicative residual model `energy.model_residual_cv` is fitted under. F34 evaluates against the mission distribution regardless. | **Stated approximation** |
| 11 | **Migration `20260818090000` has been applied to a disposable cluster, not to production.** Applying it is a deployment step. | **Environmental** |

Cleared by this remediation, and no longer limitations: the "not applied to a live database" gap
(§15), historical Findings 1 and 2 (§5), and `PHASE_0_INDEPENDENT_VERIFICATION.md`'s absence is
noted but remains outside Phase 8's scope.

---

## 18. Phase Boundary

**No Phase 9, 10, 11, 12, 13, 14, or 15 functionality was implemented as part of this Phase 8
remediation.**

Verified by inspecting the complete diff: every changed file is in `src/engine/cost/`,
`src/engine/plan/`, Phase 8's own worker, Phase 8's schema model and migration, Phase 8's test
suites, and a new Phase 8 verification tool. No file under `candidates/`, `solve/`, `intake/`,
`observability/`, `reliability/`, `fairness/`, `cutover/`, `security/`, `privacy/`, `shard/`,
`degraded/`, or `failure/` was touched. No later-phase code was rewritten, deleted, or
re-attributed. `phase0Scaffold.test.js`'s ownership test and `commitmentSchema.test.js`'s phase
boundary both pass unchanged.

No Phase 6 or Phase 7 file was modified. Phase 7's deferred V9 Safety decision was not altered.
No unrelated user work was reset: the Phase 2–7 changes and the Frontend change already in the
working tree are untouched.

---

## 19. Final Recommendation

# PHASE 8 CLOSED

The central Phase 8 proof holds, and now holds where it is actually used:

```
FeasibleCandidate  →  one deterministic Plan artefact  →  exact seven-term cost function
                   →  exact absolute CU / milli-CU cost  →  downstream optimisation
```

Each dangerous failure mode named in the brief was tested for, not assumed against:

| Failure mode | Status |
|---|---|
| feasibility uses Plan A, cost uses Plan B | **excluded** — one artefact, verified by object identity; planted violation fails the build gate |
| cost uses an approximate Plan C | **excluded** — insertion builds variants with the real Plan Builder |
| insertion pricing uses a shortcut | **excluded** — exact identity at every position, integer milli-CU |
| floating-point arithmetic silently changes ranking | **excluded** — BigInt throughout, one rounding site (D3 closed the second one) |
| delay attributed at the wrong level | **excluded** — Leg-level isolation verified; D1 closed the once-per-Mission hole |
| configuration duplicated | **excluded** — `gate:params`, one registered rate per quantity |
| an infeasible candidate is accidentally priced | **excluded** — 5 forgery routes and a planted code violation all refused |
| later-phase code becomes a second cost authority | **excluded** — Phase 9 calls Phase 8's own term; the legacy evaluator no longer exists |
| **a pinned model version yields two different answers** | **closed by D4** — found only against a live database |

**Ready for downstream Phase 9 / Phase 10 consumption.** Both already consume it; both were
verified against, and neither was modified.

Two things a future reader should carry forward. First, the two defects that mattered most were
invisible to any amount of re-reading: D2 existed only because *time passed* and Phase 10 landed
under a verification that had rated the risk against an empty repository, and D4 existed only in
the gap between a migration's text and a database's behaviour. Second, the three predicates Phase 8
wrote correctly and never called — `assertOrThrow`, `assertAttribution`, `assertSingletonRegime` —
were each tested in isolation and each passed, which is exactly why nobody noticed that none of
them ran. **A guard's unit test proves the guard; it does not prove the guard is installed.**

---

*End of Phase 8 Remediation and Closure Report.*
