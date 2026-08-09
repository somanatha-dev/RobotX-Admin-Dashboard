# PHASE 6 — FEASIBILITY GATE (L4)

**Implementation Report**

Date: 2026-08-04
Phase: 6 of 16 — *Feasibility gate*
Scope authority: `IMPLEMENTATION_EXECUTION_PLAN.md` §3 "PHASE 6", §7 checklist
Architecture authority: `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` §7, §7.2–§7.7, §14.5, §10.3.2
Status: **complete, pending independent verification**

---

## 1. Executive Summary

Phase 6 delivers §7 in full: the 38-predicate constraint register as pure functions,
three-valued evaluation with the four indeterminate policies, the
systemic-indeterminacy guard, three-tier caching with reason-derived negative TTLs, the
enumerated volatile subset wired into the commit path, and structured rejection
telemetry with the two derived SLIs §7.7 makes first-class.

The gate is now the only path by which a candidate becomes visible to cost evaluation.
Phase 0 built the type-separation apparatus — a non-enumerable `Symbol` brand,
`assertFeasible()`, and a build gate over the cost scope — and left one thing missing:
a caller of `brandFeasible()`. `evaluate.js` is that caller, and it is the only one in
the codebase. Invariant **I14** is now structural rather than aspirational.

**Everything is additive and inert.** No legacy code path changed behaviour. Two files
the plan marks *replaced* — `robotValidator.service.js` and `logger.dtaro` — are
annotated as superseded and left byte-identical in behaviour; they retire with the
legacy dispatcher at Phase 15. Nothing in `server.js` starts the new worker.

| Measure | Before | After |
|---|---|---|
| Build gates | 3 / 3 pass | **3 / 3 pass** |
| Engine lane | 32 suites, 1 017 tests | **36 suites, 1 332 tests** |
| Gates lane | 3 suites, 49 tests | **3 suites, 49 tests** |
| Legacy lane | 22 suites, 169 tests | **22 suites, 169 tests** (no regression) |
| **Total** | **1 235 tests** | **1 550 tests** |

### ⚠ One deviation from the frozen plan, stated up front

**Phase 6's hard prerequisite Phase 7 is not implemented.** The plan states this in
three places (`:466`, `:471`, `:787`) and puts Phase 7 on the critical path *before*
Phase 6. It was raised before any code was written and the instruction to proceed with
Phase 6 alone was reaffirmed. §10 records exactly what this costs and what it does not.
It is the single most important item for independent verification to scrutinise.

---

## 2. Objectives Achieved

Every line of the plan's §7 Phase 6 checklist:

| # | Checklist item | Status | Where |
|---|---|---|---|
| 1 | `threeValued.js` — three outcomes and the four policies | ✅ | `feasibility/threeValued.js` |
| 2 | Predicates **F1–F6** (identity and lifecycle) | ✅ | `predicates/f01–f06.js` |
| 3 | Predicates **F7–F12** (safety and health), F10 **with independent corroboration** | ✅ | `predicates/f07–f12.js` |
| 4 | Predicates **F13–F16** (connectivity and commandability) | ✅ | `predicates/f13–f16.js` |
| 5 | Predicates **F17–F20**, F17 as a property of the **plan** | ✅ | `predicates/f17–f20.js` |
| 6 | Predicates **F21–F26** (capability and payload) | ✅ | `predicates/f21–f26.js` |
| 7 | Predicates **F27–F33** (spatial, temporal, regulatory) | ✅ | `predicates/f27–f33.js` |
| 8 | Predicates **F34–F38**, F34 at **all three tiers** | ✅ | `predicates/f34–f38.js` |
| 9 | Every class I and R predicate declares `DENY` on indeterminate | ✅ | machine-checked, `register.assertRegister()` |
| 10 | `systemicGuard.js` → Restricted Operation, suspending no invariant | ✅ | `feasibility/systemicGuard.js` |
| 11 | Three-tier `cache.js` with **reason-derived** negative TTLs | ✅ | `feasibility/cache.js` |
| 12 | `volatileSubset.js` as the enumerated machine-checkable list, wired into commit step 3 | ✅ | `feasibility/volatileSubset.js` |
| 13 | `rejectionTelemetry.js` — structured tuples, aggregation **before** sampling | ✅ | `feasibility/rejectionTelemetry.js` |
| 14 | Record the binding **tier** for F34 rejections | ✅ | `f34.js` + `RejectionAggregate.tier` |
| 15 | REST `GET /api/diagnostics/rejections` | ✅ | `controllers/diagnostics.controller.js` |
| 16 | Type separation so cost cannot receive an infeasible pairing (**I14**) | ✅ | `evaluate.js` — sole `brandFeasible()` caller |
| 17 | Tests: all 38 predicates at boundaries, three outcomes, declared policy | ✅ | 213 tests |
| 18 | **Gate:** static analysis proves I14; guard trips without relaxing any I/R predicate | ✅ | 59 tests |

---

## 3. Pre-Implementation Analysis

### 3.1 What the substrate already provided

Reading the codebase before writing showed Phase 6 had been anticipated in unusual
detail by earlier phases. Almost nothing had to be invented:

| Provided by | What | Consumed by |
|---|---|---|
| Phase 0 | `guards/tenets.js` — `FEASIBLE` brand, `brandFeasible`, `assertFeasible`, T1/T6 build gates | `evaluate.js` |
| Phase 0 | `tierAssertions.js` — `src/engine/feasibility/` already mapped **Tier 0**; T0-01/T0-02 already name the exact module paths | no change needed |
| Phase 1 | `energy.shortfall_probability` **already derived** as α[tier] in `config/derived.js` | `f34.js` |
| Phase 1 | `feasibility.systemic_indeterminacy_threshold`, `localisation.max_odometry_divergence` (cited "§7.5 F10"), `connectivity.*`, `capacity`, `plan.commitment_horizon`, `payload.safety_factor` | throughout |
| Phase 2 | `domain/capability.js` — the typed algebra, written naming F21 as its consumer | `f21.js`, `f06.js` |
| Phase 2 | `domain/observation.js` — `assess()`, `isAdmissibleFor()`, three-outcome freshness | `f07.js`, `f16.js` |
| Phase 2 | `domain/agent.js`, `work.js`, `mobilityModel.js`; `PayloadSpec`, `ContainerModel`, `Compartment` schema | `f02`, `f28`, `f29`, `f38` |
| Phase 3 | `commitment/commit.js` — the `volatileRecheck` **required seam**, naming Phase 6 as its supplier | `volatileSubset.js` |

### 3.2 Analysis outputs

- **Modules affected:** `engine/feasibility/**` (new), `cache/robotStateCache.js`,
  `config/logger.js`, `services/robotValidator.service.js`, `routes/index.js`.
- **New files:** 8 infrastructure + 38 predicates + 1 controller + 1 route + 1 worker.
- **Database:** two additive tables, five CHECK constraints.
- **Redis:** three new key families, all read-through and non-authoritative.
- **Socket.IO:** none, as the plan states.
- **REST:** one new read-only endpoint.
- **Runtime behaviour:** no existing path changed. The gate is built and unwired.

### 3.3 Ambiguities found and how each was resolved

| # | Ambiguity | Resolution |
|---|---|---|
| A1 | **Phase 7 is a hard prerequisite and is not implemented.** | Raised and escalated before writing code; instruction to proceed reaffirmed. See §10. |
| A2 | §7.5 gives three predicates **two classes** — F25 `C/R`, F27 `R/P`, F37 `F/C`. Which governs §7.3's mandatory `DENY`? | The **stricter** governs (R, R, C). `declaredClass` preserves the specification's own string; `assertRegister()` refuses a row whose declared string contains I or R while governed as something looser — otherwise mandatory DENY would be evadable by recording the looser half. |
| A3 | §7.6 lists **F21 at two cache tiers** ("F1–F12, F21 partially" *and* the class tier). | Assigned the **more specific** (CLASS). The requirement set varies by mission class, so a per-agent key would serve one class's verdict to another's. Caching too coarsely is a correctness hazard; too finely is only a lower hit rate. |
| A4 | §14.5 says the binding F34 tier is "whichever target is tightest **relative to the distribution's shape**". Absolute probability margins are not comparable across targets spanning 1e-2 → 1e-7. | Binding tier selected by **exceedance ratio** (`probability / α[tier]`), reported margin remains the probability distance. Documented in `f34.js`. A test proves T3 binds over T1 when T1 is 2× its budget and T3 is 10 000×. |
| A5 | The plan lists "per-predicate indeterminate policy" under *Configuration updates*, but §7.2 makes class I and R **never overridable by anyone**. | The policy is declared in `register.js` (code, machine-checked), **not** made config-settable. A config key able to relax a class I predicate would be the bypass §7.2 exists to prevent. Recorded as a deliberate reading in §14. |

---

## 4. Files Created

**Feasibility gate — `Backend/src/engine/feasibility/` (2 466 lines):**

| File | Purpose |
|---|---|
| `threeValued.js` | §7.3 outcomes, §7.2 classes, four policies, `applyPolicy`, result constructors, `MARGIN_UNIT` |
| `register.js` | The 38 predicates as data: class, policy, cache tier, volatility, group; `assertRegister()` |
| `evaluate.js` | The gate. Sole caller of `brandFeasible()`. `evaluateCandidate`, `gate`, `gateAll` |
| `systemicGuard.js` | §7.4 steps 1–4, Restricted Operation envelope, `assertRelaxesNothing()` |
| `cache.js` | §7.6 three tiers, stamp-based invalidation, reason-derived negative TTLs |
| `volatileSubset.js` | §10.3.2 step 3 list (twice, cross-checked), `recheck`, `createVolatileRecheck` |
| `rejectionTelemetry.js` | §7.7 tuples, aggregate-before-sample, binding-constraint distribution, near-miss sketch |

**Predicates — `predicates/f01.js … f38.js` (5 341 lines).** One module per predicate,
each a pure function of `(agentSnapshot, mission, plan, config)` plus the pinned
`decisionTimeMs`.

**Surrounding surface (477 lines):** `controllers/diagnostics.controller.js`,
`routes/diagnostics.routes.js`, `workers/rejectionAggregation.worker.js`.

**Migration:** `prisma/migrations/20260804120000_feasibility_rejection_telemetry/`.

**Tests (2 559 lines):** `tests/engine/helpers/feasibilityFixture.js`,
`feasibilityPredicates.test.js`, `feasibilityGate.test.js`,
`feasibilityTelemetry.test.js`, `feasibilitySchema.test.js`.

## 5. Files Modified

| File | Change | Behaviour |
|---|---|---|
| `prisma/schema.prisma` | +2 models | additive |
| `src/engine/config/register/supplementary.json` | +7 parameters | additive |
| `src/cache/robotStateCache.js` | +`getVerdicts`/`setVerdicts`/`invalidateVerdicts`; `del()` now clears both maps | additive; existing API unchanged |
| `src/routes/index.js` | mount `/diagnostics` | additive |
| `src/services/robotValidator.service.js` | **superseded banner only** | **none** — byte-identical logic |
| `src/config/logger.js` | **superseded banner only** | **none** — byte-identical logic |
| `tests/engine/phase0Scaffold.test.js` | `PHASE_6_OWNED = ["feasibility/"]` | phase-boundary marker, extended as each phase lands |
| `tests/engine/commitmentSchema.test.js` | boundary moved to "no Phase 7+ table" | same discipline |

---

## 6. Database Changes

Migration `20260804120000_feasibility_rejection_telemetry`. **Additive only** — two new
tables, nothing dropped, renamed, or re-typed; no existing write path acquires a
requirement. Rollback is `DROP TABLE` on both, with no data loss outside them.

**`RejectionAggregate`** — §7.7 SLI 1. Keyed `(shardId, zoneId, missionClass,
legPurpose, predicateId, tier, bucketStart)`. The unique key is what makes the
at-least-once flusher's upsert-and-add idempotent; against a non-unique key it would
silently inflate the very SLI the table exists to make trustworthy.

**`NearMissSketch`** — §7.7 SLI 2. Keyed `(shardId, predicateId, marginUnit,
bucketStart)`. **`marginUnit` is part of the key**: F17 bounds a count *and* a duration,
F29 metres *and* kilograms, and a quantile over pooled dimensions has no interpretation.

**Five hand-written CHECK constraints**, each asserted present *and* asserted absent
from Prisma's generated output so a reviewer can tell an addition from an echo:

- `predicateId ~ '^F([1-9]|[12][0-9]|3[0-8])$'` on both tables — tested against the
  register itself, not a transcription.
- `marginUnit IN (…)` — the nine values `threeValued.MARGIN_UNIT` publishes.
- `bucketEnd > bucketStart` on both — a zero-width window would make two flushes
  collide on the unique key while describing different periods.

Both `CREATE TABLE` blocks are byte-equal (whitespace-normalised) to
`prisma migrate diff --from-empty`, asserted in `feasibilitySchema.test.js`.

> **Not applied to a live database.** No Postgres was reachable in this environment
> (`P1000`). `prisma validate` passes and the SQL is Prisma's own generated output.
> Applying it is a deployment step. Recorded in §15.

---

## 7. Runtime Behaviour

**Nothing runs yet.** The gate is complete, tested, and unwired — the same disposition
Phases 3, 4, and 5 gave their surfaces. No round calls `evaluate.gate()`; Phase 10 does.
No caller passes `createVolatileRecheck()` into `commit.js`; the seam stays required and
unfilled, so nothing can commit without one being supplied explicitly.

Properties preserved:

- **Determinism (T6, I10).** No feasibility module reads a clock, a random source, or a
  store. `decisionTimeMs` is the round's pinned time. Verified by `gate:tenets` over all
  46 modules and by a test asserting identical verdicts on repeated evaluation.
- **Purity (§7.5).** Every predicate is a pure function of its arguments, so the verdict
  is order-independent; the cheapest-first ordering is a performance property only.
  Asserted by comparing short-circuit and `collectAll` passes.
- **Transaction correctness.** Untouched. The volatile re-check runs inside the existing
  transaction under the existing row locks.
- **Idempotency / retry safety.** The flusher is at-least-once with an
  upsert-and-add against a unique key; `drain()` hands counts over and clears in one
  call so one flush cannot double-count.
- **Backwards compatibility.** Legacy lane unchanged at 169/169.

---

## 8. API Changes

**New:** `GET /api/diagnostics/rejections?zone=&class=&purpose=&from=&to=&shard=`

Behind the same `authUser` middleware as every other `/api` route (§23.4), rate-limited
at 60/min, **read-only**. Returns the binding-constraint distribution (sorted
descending, with `share` so §7.7's own "60 % of rejections are F34" example reads
directly off the response) and the near-miss ladders for whatever bound. Each row is
annotated with the predicate's name, class, group, and — for F34 — §14.5's `tierEvent`
and `tierConsequence`, so "F34/T3" is legible as *immobilisation risk* without a trip to
the specification.

**No existing endpoint changed.** No breaking change to any request or response shape.

## 9. Redis and Socket.IO Changes

**Redis — three new key families**, exactly as the plan names them:

| Key | Contents | Invalidation |
|---|---|---|
| `engine:feas:agent:{agentId}` | F1–F12 verdicts | stamp mismatch on lifecycle / health / capability / firmware / certification |
| `engine:feas:class:{agentClass}:{missionClass}:{zone}` | F21, F25, F26, F28, F29 | stamp mismatch on config or map version |
| `engine:feas:neg:{agentId}:{legId}` | rejecting predicate | TTL **derived from the rejecting predicate** |

Invalidation is **by stamp checked on read**, not by delete-on-write. §7.6 states the
rule as an event; implementing it as a broadcast delete works exactly as long as every
writer remembers and fails silently the first time one does not — producing a stale
*positive*, the failure that matters. A forgotten invalidation now produces a **miss**.
The cache remains non-authoritative (§10.4, I16): a read error is a miss, never a
verdict.

**Socket.IO:** none, as the plan states.

---

## 10. ⚠ The Phase 7 Prerequisite — Full Disclosure

### 10.1 The gap

The frozen plan makes Phase 7 a hard prerequisite of Phase 6 and puts it earlier on the
critical path (`0 → 1 → 2 → 7 → 6 → 8 → 9 → 10`). Phase 7 is not implemented:
`src/engine/energy/`, `payload/`, `routing/`, and `plan/` are empty directories.

### 10.2 What was implemented, and on what basis

The plan specifies predicates as *"pure functions of `(agentSnapshot, mission, plan,
config)`"*. Under that contract Phase 7 **produces** energy and payload projections and
Phase 6 **evaluates predicates over them**. Phase 5 set the identical precedent, in a
module that has already passed independent verification —
`supervision/progress.js`:

> *"Energy's own model is Phase 7's. This module compares realised against predicted Wh
> as §12.3 states, and takes both as inputs; it does not compute a prediction, which
> would be building a second energy model."*

Seven predicates consume Phase 7 artefacts as **declared inputs** and return
`INDETERMINATE` when they are absent — which, under class I's mandatory `DENY`, denies:

| Predicate | Input consumed | Phase 7 producer |
|---|---|---|
| F22 | `plan.loadState[].massUpperBoundKg` | `payload/loadState.js` |
| F23 | `plan.packing.verdict` | `payload/packing.js` |
| F24 | `plan.loadState[].cog` | `payload/loadState.js` |
| F25 | `plan.packing.thermalAssignment` | `payload/packing.js` |
| F26 | `plan.packing.compartmentLoads` | `payload/packing.js` |
| F34 | `plan.energy.tierProbabilities` | `energy/tiers.js` |
| F35 | `plan.energy.chargerReachability` | `energy/eReturn.js`, `routing/chargerReachabilityCache.js` |

**No energy or payload model was written.** No consumption model, no reserve layering,
no packing search, no charger reachability computation. Doing so would have been
implementing Phase 7.

Note F25 and F26 do substantive work *given* the compartment assignment: F25 evaluates
the thermal-class coverage and the passive-hold duration arithmetic; F26 evaluates
pairwise segregation and lock-class requirements. Only the assignment itself is Phase 7's.

### 10.3 What this costs

1. **Until Phase 7 lands, every candidate is denied** — correctly and conservatively,
   by class I predicates on absent safety inputs. The gate is not usable end-to-end
   before Phase 7, and Phase 10 cannot run a round without it.
2. **Those seven predicates are tested against fixtures, not against a real energy
   model.** Their comparison logic, boundaries, and all three outcomes are exercised;
   the *physics feeding them* is not, because it does not exist. §24.1's requirement is
   met at the predicate level; §14.5's simulation requirement (T1/T2/T3 event
   frequencies over a long run) is Phase 7's and is untouched.
3. **The `INDETERMINATE`-everywhere state would trip §7.4's systemic guard** in a live
   round, since >30 % of candidates would be denied solely for indeterminacy. That is
   the guard behaving correctly — it is genuinely an infrastructure gap — but it means
   Phase 6 cannot be integration-tested against a fleet until Phase 7 lands.

### 10.4 What this does not cost

The predicate modules will not change when Phase 7 lands. Their contract is the plan's
own signature, their inputs are named and documented per predicate, and the fixture in
`feasibilityFixture.js` is the executable specification of the shape Phase 7 must
produce. **No rework is anticipated** — only the arrival of real inputs.

---

## 11. Architecture Compliance

| Property | How held | Evidence |
|---|---|---|
| **Architectural layering** | `feasibility/` reads domain and config only; never a store, a clock, or cost | `gate:tiers` PASS |
| **Ownership boundaries** | No energy, payload, routing, plan, or cost module written | `phase0Scaffold` ownership test |
| **Dependency direction** | Tier 0 imports no Tier 2 | `gate:tiers`, 162 governed edges |
| **Determinism** | No `Date.now`, `new Date()`, `Math.random` in the decision path | `gate:tenets` PASS over 165 modules |
| **No bare constants** | Every literal `@param`-registered or `@structural`-annotated | `gate:params` PASS, 160 parameters |
| **T1 / I14** | `evaluate.js` is the only `brandFeasible()` caller | asserted by source scan in test |
| **§7.2 no bypass** | No `skipPredicates`, no `manual` flag, no privileged entry point | asserted against 5 attempted option shapes |
| **§7.4 relaxes nothing** | Envelope is additive-only; forbidden field names refused | `assertRelaxesNothing()` + tests |
| **Backwards compatibility** | Legacy lane green; two superseded files behaviourally untouched | 169/169 |

**No architecture was changed.** `tierAssertions.js` needed no edit — Phase 0 had
already mapped `src/engine/feasibility/` to Tier 0 and named T0-01's and T0-02's exact
module paths. Phase 6 is where that inventory and the module tree converge.

---

## 12. Test Results

```
gate:tiers   PASS — 168 modules, 162 governed edges, no Tier 0/1 → Tier 2 dependency
gate:params  PASS — 93 engine modules against 160 registered parameters
gate:tenets  PASS — 165 modules, no T1 or T6 violations

engine       36 suites, 1332 tests passed      (was 32 / 1017)
gates         3 suites,   49 tests passed      (unchanged)
legacy       22 suites,  169 tests passed      (unchanged — no regression)
──────────────────────────────────────────────────────────────────
TOTAL                   1550 tests passed, 0 failed
```

**315 new tests across four suites:**

| Suite | Tests | Covers |
|---|---|---|
| `feasibilityPredicates` | 213 | All 38 at their boundaries × 3 outcomes × declared policy; F10 corroboration; F34 three tiers; F17 plan-property; F37 soft-vs-hard; F33 malformed coordinates; F7 unparseable E-stop; F8 grading; F6 mission-end validity |
| `feasibilityGate` | 59 | I14 (brand, spread, JSON round-trip, sole-caller scan, no cost import); relaxation monotonicity; §7.4 guard at threshold; time box; volatile subset × 11 stale-positive cases; §7.6 cache stamps and TTLs |
| `feasibilityTelemetry` | 26 | Tuple completeness; **exactness at sample rate 0**; deterministic sampling; §7.7's 60 %-F34 example; tier separation; unit separation; flusher idempotence |
| `feasibilitySchema` | 16 | Migration vs Prisma-generated SQL; additive-only; CHECK constraints vs the register; parameter completeness; tier placement |

### 12.1 Notable properties proven

- **Aggregation is exact at a sample rate of zero.** 100 rejections, not one
  per-candidate row retained, distribution still reports exactly 100. This is the
  property §7.7 says sampling-first would destroy.
- **A stale positive cannot survive the commit-time re-check** — tested individually for
  each of the 11 volatile predicates.
- **A volatile predicate's rejection is never negatively cached** — the §7.6 correctness
  hazard, closed structurally rather than by TTL choice.
- **The guard cannot make an unfit agent feasible** — an E-stopped agent stays
  `VIOLATED` before and after the guard trips.

### 12.2 Defects found and fixed during testing

| Found | Nature | Fix |
|---|---|---|
| F34 binding tier | Absolute probability margins are not comparable across targets spanning five orders of magnitude; T1 always dominated | Binding selected by **exceedance ratio**; margin still reported in probability |
| `threeValued.absent()` | Discarded the caller's own reason, degrading several rejection tuples | Caller reason now **appended** |
| `degraded.reserve_factor` default 1.5 | **Phase 1's V9 validator caught it**: combined degraded conservatism 3.019 > `energy.max_combined_conservatism` 2.1 | Seeded at **1.0**, matching `energy.f_derate`'s precedent; raising it is an explicit Safety-class decision that must also raise the cap |

The third is worth highlighting: a Phase 1 build-time validator, written before the
parameter it names existed, caught a Phase 6 default that would have made the fleet
accidentally over-conservative. The mechanism worked exactly as designed.

---

## 13. Self-Verification

| Claim | Verified by |
|---|---|
| Every Phase 6 checklist item implemented | §2 table; all 18 traced to code |
| **No Phase 7 functionality exists** | `energy/`, `payload/`, `routing/`, `plan/` still empty; `phase0Scaffold` ownership test; §10.2 |
| Architecture unchanged | `tierAssertions.js` untouched; 3 gates pass |
| Build passes | `npm run gates` 3/3 |
| Tests pass | 1 550 / 1 550 |
| Migrations valid | `prisma validate` ✅; SQL byte-equal to Prisma's own generation |
| APIs compatible | one new read-only endpoint; no existing shape changed; legacy lane green |
| 38 predicates, pure, individually tested | `assertRegister()` + 213 tests |
| Class I/R all DENY | machine-checked over `applyPolicy`, not over the register's self-claim |
| Volatile subset is the enumerated list | `assertSubset()` — two independent representations cross-checked |
| Rejection aggregation exact over 100 % | sample-rate-0 test |
| F10 requires independent corroboration | 4 dedicated tests |
| I9, I14 verifiable | I14 by source scan + brand tests; I9 by the register's mandatory-DENY check |

---

## 14. Known Limitations

1. **Phase 7 dependency** — §10, in full. The dominant limitation.
2. **Per-predicate indeterminate policy is code, not configuration.** The plan lists it
   under *Configuration updates*; §7.2 makes class I and R never overridable by anyone.
   A config key able to relax a class I predicate would be a bypass, so the policy lives
   in `register.js` and is machine-checked. **Flagged for verification** as a deliberate
   reading of a plan line.
3. **Four new parameters ship `UNCALIBRATED` with `null` defaults** —
   `health.required_tier`, `localisation.min_confidence`, `link.min_quality`,
   `reliability.max_intervention_rate`. Each states what it `awaits`. Null is
   conservative: the predicates return `INDETERMINATE` and deny. A fabricated threshold
   would silently admit marginal agents, which is worse than denying loudly.
4. **The migration has not been applied to a live database** — no Postgres reachable.
5. **`E_return` and packing remain external dependencies.** §6.1's blocking decision on
   the Charging Scheduler is unresolved and is Phase 7's to carry.
6. **The three-tier cache is implemented but unwired.** `evaluate.js` does not consult
   it; Phase 9/10 wire the candidate pipeline. Building the gate around a cache before a
   round exists would have been speculative.

## 15. Remaining Non-Blocking Issues

1. **`PHASE_0_INDEPENDENT_VERIFICATION.md` does not exist** in the repository, though it
   was named as an authoritative document. Phases 1–5 all have theirs.
2. **Migration application** is a deployment step, pending a reachable database.
3. **`robotValidator.service.js` and `logger.dtaro` still have legacy callers.** Correct
   for this phase — they retire at Phase 15 with the dispatcher.
4. **The aggregation flusher is not scheduled.** `ENGINE_ENABLED` is false and Phase 15
   owns production scheduling, matching the outbox, timer, and reconciler workers.
5. **`route.degraded_reserve_factor` and `degraded.reserve_factor` both multiply into
   §14.3's combined-conservatism product.** With both seeded, the cap leaves ~4 %
   headroom. Not a defect — V9 enforces it correctly — but Safety should review whether
   two independent degraded multipliers is the intended structure.

---

## 16. Readiness for Independent Verification

**Ready.** Suggested focus, in priority order:

1. **§10 — the Phase 7 deviation.** Is the input-consuming seam the right reading of the
   plan's predicate signature, or should Phase 6 have been blocked? This is the decision
   most worth a second opinion.
2. **A4 — the F34 exceedance-ratio choice** for binding-tier selection. It is an
   interpretation of "tightest relative to the distribution's shape at that threshold".
3. **Limitation 2** — per-predicate policy as code rather than configuration.
4. **A2 and A3** — dual-class governance and F21's cache tier.
5. **The four `UNCALIBRATED` parameters** — Safety review of the null-default reasoning.
6. **§7.4's `assertRelaxesNothing()`** — is the forbidden-field-name list the right
   structural guarantee, or is a stronger one available?

Every claim in this report is reproducible with:

```bash
cd Backend
npm run gates        # 3/3
npm run test:engine  # 36 suites, 1332 tests
npm run test:gates   # 3 suites, 49 tests
npm run test:legacy  # 22 suites, 169 tests
```

**Phase 7 has not been implemented. No Phase 7 functionality exists in this change.**

---

*End of Phase 6 Implementation Report.*
