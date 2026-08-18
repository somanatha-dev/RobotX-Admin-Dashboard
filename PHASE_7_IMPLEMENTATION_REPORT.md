# PHASE 7 — ENERGY AND PAYLOAD MODELS

**Implementation Report**

Date: 2026-08-04
Phase: 7 of 16 — *Energy and payload models*
Scope authority: `IMPLEMENTATION_EXECUTION_PLAN.md` §3 "PHASE 7", §7 checklist
Architecture authority: `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` §14, §15, §13.4, §13.5, §20.3
Status: **complete, pending independent verification**

---

## 1. Executive Summary

Phase 7 delivers §14 and §15: energy modelled in watt-hours with a fitted consumption
model, usable energy against state of health and temperature, four layered reserves that
cannot be traded, the three simultaneous shortfall tiers of F34 with `α[tier]` derived
from a governed fleet-year budget, `E_return` against a pinned charger projection,
battery wear priced into `C_lifecycle`, a nonlinear charge curve, the five mid-mission
rows, the Charging Scheduler contract, and the payload spec, container, tiered packing,
per-stop load state, and custody-evidence models.

The line this phase exists to remove is §14.1's:

> a robot at 20.1 % is eligible for a mission of unbounded length.

It is gone from the decision path. No engine module reads a percentage floor, imports
`dtaro.constants.js`, or resolves `legacy.dtaro.*`; every reserve field is denominated
`…Wh`; and charge interruption — the baseline's fixed 30 % — now reads no state of
charge at all. A source scan proves each of those rather than asserting it.

**Phase 6's seven waiting predicates now have producers.** F22, F23, F24, F25, F26, F34,
and F35 returned `INDETERMINATE` on absent Phase 7 inputs and, under class I's mandatory
`DENY`, denied every candidate. Each now receives real inputs, and the tests assert the
round trip end to end: `tiers.planEnergyFragment()` → `F34.SATISFIED`,
`packing.evaluate()` → `F23/F25/F26.SATISFIED`, `loadState.project()` →
`F22/F24.SATISFIED`. **No predicate module was modified.** Phase 6's claim that "the
predicate modules will not change when Phase 7 lands" held exactly.

| Measure | Before | After |
|---|---|---|
| Build gates | 3 / 3 pass | **3 / 3 pass** |
| Engine lane | 36 suites, 1 332 tests | **40 suites, 1 561 tests** |
| Gates lane | 3 suites, 49 tests | **3 suites, 49 tests** |
| Legacy lane | 22 suites, 169 tests | **22 suites, 169 tests** (no regression) |
| **Total** | **1 550 tests** | **1 779 tests** |

**Everything is additive and inert.** No round runs. `ENGINE_ENABLED` is still false,
neither new worker is started from `server.js`, and the only behaviour change outside the
engine tree is in `VirtualRobot` — which is the simulator, and which §14.6 explicitly
requires to reason from the server's inputs.

### ⚠ One pre-existing defect found, not introduced, and not silently fixed

**The seeded parameter register cannot publish.** `energy.combined_degraded_conservatism`
derives to **2.0125** against a cap of **1.6**, so validator V9 blocks. This has been true
since Phase 1 and is not a Phase 7 regression, but §14.3's combined-conservatism rule is
Phase 7's completion criterion, so it is Phase 7's to report. §14 below gives the
arithmetic and the three Safety-class options. **I did not change a Safety-class
parameter to make a validator pass.**

---

## 2. Objectives Achieved

Every line of the plan's §7 Phase 7 checklist:

| # | Checklist item | Status | Where |
|---|---|---|---|
| 1 | `energy/consumption.js` with all β terms **including `β_payload_thermal` over `t_occupied(k)`** | ✅ | `energy/consumption.js`; occupancy intervals from `payload/loadState.js` |
| 2 | `energy/usable.js` — SoH, `f_temp`, `f_derate`; publish combined nominal and degraded conservatism | ✅ | `energy/usable.js` |
| 3 | Enforce `energy.max_combined_conservatism` at config publish | ✅ (V9, Phase 1) + runtime half | `config/validators.js` V9 · `usable.assertWithinCap()` — see §14 |
| 4 | `energy/wear.js` — DoD-weighted cycle cost into `C_lifecycle` | ✅ | `energy/wear.js`, in integer milli-CU |
| 5 | `energy/reserves.js` — four layers, never traded against one another | ✅ | `energy/reserves.js`, `assertNoTrade()` |
| 6 | `energy/tiers.js` — T1/T2/T3 with `α[tier]` **derived** from fleet-year budgets | ✅ | `energy/tiers.js`, `alphaFor()` |
| 7 | F34 as three simultaneous conditions with the binding tier recorded | ✅ | `tiers.evaluate()` → Phase 6's `f34.js`, unmodified |
| 8 | `energy/eReturn.js` against the **pinned previous-round** projection | ✅ | `energy/eReturn.js` |
| 9 | `chargingSchedulerClient.js` — consume reservations, target SoC, projection; **never compute a target** | ✅ | `energy/chargingSchedulerClient.js`, `assertNotEngineComputed()` |
| 10 | Priced-request path to the Scheduler (refusable, recorded) | ✅ | `buildRequest()` / `recordDisposition()` |
| 11 | `energy/chargeCurve.js` — nonlinear `P_charge(SoC, T, chargerClass)` | ✅ | `energy/chargeCurve.js` |
| 12 | `energy/midMission.js` — the five §14.8 rows, each counted against its tier budget | ✅ | `energy/midMission.js`, `budgetEvent()` |
| 13 | Charger-reachability cache keyed with `charger_availability_version` | ✅ | `routing/chargerReachabilityCache.js` |
| 14 | `payload/spec.js`, `container.js` (aperture separate), `loadState.js` (per stop) | ✅ | three modules |
| 15 | `payload/packing.js` — tiers 1–4; tier-3 exhaustion ⇒ `INDETERMINATE`/`DENY` | ✅ | `payload/packing.js` |
| 16 | `custodyEvidence.js` — manifest reconciliation at every custody event | ✅ | `payload/custodyEvidence.js` |
| 17 | Align `simulation/constants.js` and VirtualRobot battery behaviour with the server model | ✅ | both files; VirtualRobot imports the server's `chargeCurve` |
| 18 | REST `GET /api/diagnostics/energy/:agentId` | ✅ | `controllers/diagnostics.controller.js` |
| 19 | Tests: energy conservation; charge-curve integration; each tier independently; reserve layers never traded | ✅ | 229 new tests |
| 20 | Simulation: realised T1/T2 event rates match budgeted rates | ✅ | `energySimulation.test.js`, 60 000-mission run |
| 21 | **Gate:** no percentage-based energy floor remains anywhere in the decision path | ✅ | source scan over 108 engine modules |

---

## 3. Pre-Implementation Analysis

### 3.1 What the substrate already provided

| Provided by | What | Consumed by |
|---|---|---|
| Phase 0 | `tenets.js` already scopes `src/engine/energy/` into the T6 decision path, with `chargingSchedulerClient.js` and `midMission.js` pre-excluded as L1/L2 | every energy module |
| Phase 0 | `tierAssertions.js` already maps `energy/`, `payload/`, and `routing/chargerReachabilityCache.js` to Tier 0, and T0-03/T0-04 already name the module paths | no gate edit needed |
| Phase 1 | `energy.shortfall_probability` **already derived** as `α[tier]`; `energy.contingency_quantile` as `1 − α₁`; V9 already enforces the conservatism cap | `tiers.js`, `reserves.js`, `usable.js` |
| Phase 1 | 15 of §14/§15's parameters already registered | throughout |
| Phase 1 | `determinism/snapshot.js` already reserves `chargerProjectionVersion` in `DEFERRED_PINS`, naming Phase 7 | `eReturn.js` |
| Phase 2 | `EnergyModel`, `ContainerModel`, `Compartment`, `PayloadSpec`, `PayloadManifest` schema; `EnergyModel`'s doc already names Phase 7's two tables | migration |
| Phase 4 | `offers.buildOfferPayload()` already declares `energyReserveParams` and `targetSoc` as pass-through fields | `reserves.offerParams()` |
| Phase 5 | `supervision/verification.js`'s L0–L3 ladder and `progress.assessEnergyDeviation()` | `custodyEvidence.js`, `midMission.js` |
| Phase 6 | seven predicates written against named Phase 7 inputs, with the shapes pinned by `feasibilityFixture.js` | every producer |

### 3.2 Analysis outputs

- **Modules affected:** `engine/energy/**` (new), `engine/payload/**` (new),
  `engine/routing/chargerReachabilityCache.js` (new), `workers/**` (2 new),
  `controllers/diagnostics.controller.js`, `routes/diagnostics.routes.js`,
  `simulation/constants.js`, `simulation/VirtualRobot.js`.
- **New files:** 9 energy + 5 payload + 1 routing + 2 workers + 5 test files.
- **Database:** six additive tables, five CHECK constraints, six foreign keys.
- **Redis:** three new key families, all read-through and non-authoritative.
- **Socket.IO:** no new events; the OFFER payload's two declared fields gain a producer.
- **REST:** one new read-only endpoint.
- **Runtime behaviour:** no existing path changed except the simulator's charge model.

### 3.3 Ambiguities found and how each was resolved

| # | Ambiguity | Resolution |
|---|---|---|
| A1 | The plan lists `src/config/dtaro.constants.js` as **retired** by Phase 7, but `robotValidator.service.js` and `simulation/constants.js` still read it and both retire at Phase 15. | Retired **from the decision path**, which is what the phase gate actually says ("no percentage-based energy floor remains anywhere in *the decision path*"). The shim stays for its legacy consumers, and a test asserts both halves: no engine module reads it, and it still resolves to 20/30 for the dispatcher. Deleting it now would break a path Phase 7 was not asked to change and redden the legacy lane. |
| A2 | §14.5 supplies two moments of `E_mission` and no distribution family. | Gaussian, **stated as a modelling choice** in `consumption.js` with its own justification and its own failure mode: it is the optimistic choice against a heavier-tailed truth, which `energy.model_residual_cv`'s calibration must absorb and §21.5's loop measures. Recorded rather than assumed. |
| A3 | §14.5 says the variance is "inflated for route novelty, forecast horizon, and weather uncertainty" but does not say by how much per mission. | Each source carries a `severity` in [0,1] and the applied multiplier is `1 + severity·(m−1)`. An **unstated** severity inflates in full — an unquantified uncertainty is not an absent one (T2). Tested. |
| A4 | §14.2 writes `β_thermal(T_ambient, T_pack)` without a functional form. | Sum of two measured curves (vehicle HVAC against ambient, pack conditioning against pack temperature), because those are two physically distinct loads measured separately and a 2-D surface would need an uncalibrated interpolation scheme. Stated in the module. |
| A5 | §15.2 puts the CoG envelope on the container but tabulates no compartment positions, and a centre of mass cannot be computed without them. | Read from the container's `cogEnvelope` payload as `compartmentCentroids`, so geometry and envelope are published together and cannot drift. A container publishing an envelope but no centroids yields `withinEnvelope: null` → F24 `INDETERMINATE` → `DENY`. No schema change. |
| A6 | The plan's migration group says "`EnergyModelParams` per agent class (β coefficients …, κ per agent)" — one table for a per-class and a per-agent quantity. | β on `EnergyModelParams` (per class), κ on `BatteryState` (per agent). A nullable agent discriminator on the class table would make the class row's uniqueness ambiguous. |
| A7 | §15.3 runs tier 3 "only when tier 2 fails **and the pairing is otherwise attractive**" — whose judgement is attractiveness? | The candidate pipeline's, not the packing module's. It arrives as `exactSearchPermitted`, defaulting true so a direct caller gets the strongest available answer. |
| A8 | Should `src/engine/reliability/**` (§16) land here? §5.3's row F5 says "Phase 7, 16c". | **No.** Phase 7's scope statement, file list, and 21-item checklist name it nowhere; §1.8 makes reliability-priced risk **Tier 2** behind the `reliability_based_gating` kill switch, and Phase 16c owns it. Building it here would ship a Tier 2 mechanism inside a Tier 0 phase. |

---

## 4. Files Created

**Energy — `Backend/src/engine/energy/` (3 152 lines):**

| File | Purpose |
|---|---|
| `consumption.js` | §14.2's equation term by term; the predictive distribution and its CDF/quantile; the κ EWMA and drift signal |
| `usable.js` | §14.3's five-factor product; `f_temp` from the chemistry curve; the two published conservatism products and the cap; the resistance signal |
| `wear.js` | §14.4's `C_battery` in integer milli-CU, from the vendor cycle-life curves |
| `reserves.js` | §14.5's four layers; `assertNoTrade()`; derived contingency sizing; the offer's `energyReserveParams` |
| `tiers.js` | §14.5's three conditions, the nesting assertion, the binding tier, and the `plan.energy` fragment F34/F35 read |
| `eReturn.js` | §14.5's pinned-projection reachability, the depot-only fallback, and the settlement accuracy tuple |
| `chargeCurve.js` | §14.6's `P_charge` integration, mean C-rate, and the three interruption conditions |
| `midMission.js` | §14.8's five rows, custody-split T2, and the tier budget event |
| `chargingSchedulerClient.js` | §14.7's contract: projection, reservations, target SoC, priced requests, the three degradations |

**Payload — `Backend/src/engine/payload/` (2 101 lines):** `spec.js`, `container.js`,
`packing.js`, `loadState.js`, `custodyEvidence.js`.

**Routing (372 lines):** `routing/chargerReachabilityCache.js`.

**Workers (332 lines):** `workers/chargerReachability.worker.js`,
`workers/energyCalibration.worker.js`.

**Migration:** `prisma/migrations/20260804180000_energy_and_payload_models/` (321 lines).

**Tests (2 767 lines):** `tests/engine/helpers/energyFixture.js`, `energyModel.test.js`,
`payloadModel.test.js`, `energySchema.test.js`, `energySimulation.test.js`.

## 5. Files Modified

| File | Change | Behaviour |
|---|---|---|
| `prisma/schema.prisma` | +6 models, +6 back-relations | additive |
| `src/engine/config/register/supplementary.json` | +12 parameters | additive |
| `src/engine/guards/tierAssertions.js` | T0-03's inventory names 3 more modules | inventory only; the gate's prefix table is unchanged |
| `src/engine/TIERS.md` | mirrors the above; notes why `wear.js` is unlisted | documentation |
| `src/controllers/diagnostics.controller.js` | +`getAgentEnergy` | additive; `getRejections` untouched |
| `src/routes/diagnostics.routes.js` | +`GET /energy/:agentId` | additive |
| `src/simulation/constants.js` | +modelled pack, charge curve, target-SoC fallback | **all legacy exports retained unchanged** |
| `src/simulation/VirtualRobot.js` | integrates the server's charge curve; consumes `energyReserveParams`/`targetSoc` | changed — see §6 |
| `src/engine/payload/loadState.js` | occupancy interval fix found by test | new file; noted in §12.2 |
| `tests/engine/phase0Scaffold.test.js` | `PHASE_7_OWNED` | phase-boundary marker |
| `tests/engine/commitmentSchema.test.js` | boundary moved to "no Phase 8+ table" | same discipline |

---

## 6. Runtime Behaviour

**Nothing new runs on the server.** The energy and payload models are complete, tested,
and unwired: no round calls `tiers.evaluate()`, no caller supplies
`plan.energy`/`plan.loadState`/`plan.packing` — Phase 8's plan builder and Phase 10's
round do. Neither new worker is started from `server.js`; `ENGINE_ENABLED` is false.

**The one behaviour change is in the simulator**, and §14.6 requires it:

> the *agent* receives the reserve parameters and the target SoC as part of the offer, so
> the two sides reason from identical inputs by construction rather than by a shared
> constant that a future edit could desynchronise.

Three changes, each stated:

1. **Charging integrates the server's curve.** `VirtualRobot` imports
   `engine/energy/chargeCurve` — the same module, not a second implementation — so the
   constant-voltage taper past 80 % is modelled on both sides. `CHARGING_RATE_PER_TICK`
   is retained and is now reachable only when the curve cannot be evaluated at all.
2. **It charges to a target it did not choose.** `targetSoc` off the offer where the
   Scheduler published one; `energy.target_soc_fallback` (0.8) otherwise. Previously it
   charged to 100 %. §14.6: "partial charging is usually optimal."
3. **Its offer response is in watt-hours when the server sends them.** Where an offer
   carries `energyReserveParams`, the agent compares available Wh against `E_floor` and
   `E_floor + E_return`. Where none arrives — every legacy `TASK_ASSIGN` — it falls back
   to the legacy percentage thresholds **unchanged**, which is why the legacy lane is
   green at 169/169 and `dispatchAgentProtocol`'s deferral test still passes verbatim.

Properties preserved:

- **Determinism (T6, I10).** No energy or payload module reads a clock, a random source,
  or a store. `gate:tenets` passes over 182 modules. The tail probabilities, the charge
  integral, and the packing order are all bit-reproducible; tests assert each.
- **Purity.** Every kv client is injected, exactly as `feasibility/cache.js`'s is.
- **Idempotency.** The projection is insert-only; a duplicate version is reported, never
  merged.
- **Backwards compatibility.** Legacy lane 169/169. No existing endpoint or event shape
  changed.

---

## 7. API Changes

**New:** `GET /api/diagnostics/energy/:agentId`

Behind the same `authUser` middleware as every other `/api` route, rate-limited at
120/min, **read-only**. It exists because §14.1 replaced a number an operator could read
off a dashboard with a probabilistic constraint over four layers and three tiers, and the
gap between the two is where operator trust is lost.

It returns `E_usable` with **every factor** of §14.3's product (so "usable at 70 % SoH"
is legible), each of the four reserve layers **separately** with its purpose and whether
policy may override it (summing them would hide the no-trade rule), the three tier
conditions with their derived `α`, both published conservatism products against the cap,
κ with its drift signal, the resistance signal, and the Scheduler's reservations labelled
`ownedBy: "CHARGING_SCHEDULER"`.

Two honesty properties worth flagging to verification: `E_return` and `E_contingency` are
reported as `planDependent: true` rather than given a number — neither is a property of
an agent at rest — and `E_usable` is labelled `fTempBasis: "RATED_TEMPERATURE"`, because
a live pack temperature is telemetry and an assumed temperature is an assumed range.

**No existing endpoint changed.**

## 8. Redis Changes

| Key | Contents | Notes |
|---|---|---|
| `engine:charger:proj:{version}` | the pinned projection mirror | cache, not authority — the DB row is (§3.3) |
| `engine:charger:reach:{cell}:{profile}:{bucket}:{projVersion}` | nearest-k chargers, ordered, with travel time and energy | the version is **last in the key**, and `key()` refuses to build one without it |
| `engine:pack:{containerConfig}:{itemSignature}` | §15.3 tier-4 memo | `BUDGET_EXHAUSTED` is never written |

All three are read-through and non-authoritative: a read error is a miss, a write failure
is silent, and neither can produce a verdict (I16).

`vr:battery:*` is unchanged in shape; its **semantics** now sit inside the modelled path
— the simulator's percentage is a projection of a Wh model rather than the model itself.

## 9. Socket.IO Changes

**No new events, and no wire-format change.** Phase 4 declared `energyReserveParams` and
`targetSoc` on the OFFER payload and left them null "so that Phase 7 fills a declared
field rather than widening a wire contract that firmware has already implemented." Phase 7
is the producer: `reserves.offerParams()` builds the layers **unsummed, in watt-hours**,
with the pack capacity the agent needs to convert its own SoC, the names of the
overridable layers, and the target SoC with its provenance. `VirtualRobot` consumes it.

---

## 10. Database Changes

Migration `20260804180000_energy_and_payload_models`. **Additive only** — six new tables,
six foreign keys, five CHECK constraints; nothing dropped, renamed, or re-typed; no
existing write path acquires a requirement. Rollback is `DROP TABLE` on the six.

- **`EnergyModelParams`** — §14.2's fitted β set per class, versioned so a decision can
  name the model it was taken under. Separate from Phase 2's `EnergyModel`, which holds
  the declarative vendor data.
- **`BatteryState`** — per agent: SoH, resistance and its trend, throughput, and κ with
  its sample count.
- **`Charger`**, **`ChargerReservation`** — §5.2/§14.7. Read-only to the engine.
  `targetSoc` lives on the reservation, which is the schema-level expression of §14.6's
  ownership decision.
- **`ChargerAvailabilityProjection`** — insert-only, `version` unique, **no `updatedAt`**.
  A projection editable after a round consumed it would make that round unreplayable.
- **`PackingResultCache`** — §15.3 tier 4.

**Five hand-written CHECK constraints**, each asserted present *and* asserted absent from
Prisma's generated output so a reviewer can tell an addition from an echo:

- `soh ∈ (0,1]` and `kappa > 0` — a SoH above 1 would claim a pack larger than the one
  built; a non-positive κ would zero or invert every estimate.
- `targetSoc ∈ [0,1]` and `reservedUntil > reservedFrom` — both cross a service boundary,
  which is exactly where a unit confusion (80 vs 0.8) survives review.
- `verdict IN ('FEASIBLE','INFEASIBLE')` — the memo may hold only a **decided** verdict.
  Memoising an indecision would turn a transient node-budget limit into a standing
  refusal for the entry's lifetime.

Every `CREATE TABLE`, index, and foreign key is byte-equal (whitespace-normalised) to
`prisma migrate diff --from-empty`, asserted in `energySchema.test.js`.

> **Not applied to a live database.** No Postgres was reachable in this environment.
> `prisma validate` passes and the SQL is Prisma's own generated output. Applying it is a
> deployment step. Recorded in §15.

---

## 11. Architecture Compliance

| Property | How held | Evidence |
|---|---|---|
| **Architectural layering** | `energy/` and `payload/` read domain, config, and determinism only; never a store, a clock, or cost | `gate:tiers` PASS, 178 governed edges |
| **Ownership boundaries** | No plan builder, no cost term, no solver, no reliability estimator | `phase0Scaffold` ownership test, `PHASE_7_OWNED` |
| **Tier discipline** | Tier 0 imports no Tier 2 | `gate:tiers` PASS |
| **Determinism (T6)** | No `Date.now`, `new Date()`, `Math.random` in the decision path | `gate:tenets` PASS over 182 modules |
| **No bare constants** | Every literal `@param`-registered or `@structural`-annotated | `gate:params` PASS, 172 parameters |
| **§14.6 ownership** | No function anywhere computes a target SoC; provenance is checked, not the value | `assertNotEngineComputed()` + 4 tests |
| **§14.5 no-trade** | A protected layer falling is refused whatever the call site calls it | `assertNoTrade()` + 4 tests |
| **§7.5 predicate contract** | Zero predicate modules modified | `git diff --stat src/engine/feasibility/` empty |
| **Backwards compatibility** | Legacy lane green | 169/169 |

**No architecture was changed.** `tierAssertions.js`'s prefix table — the part the gate
reads — is untouched; only T0-03's human-readable module inventory grew, following the
precedent Phase 4 set when Phase 3's verification found `leases.js` missing from T0-05.

---

## 12. Test Results

```
gate:tiers   PASS — 185 modules, 178 governed edges, no Tier 0/1 → Tier 2 dependency
gate:params  PASS — 108 engine modules against 172 registered parameters
gate:tenets  PASS — 182 modules, no T1 or T6 violations

engine       40 suites, 1561 tests passed      (was 36 / 1332)
gates         3 suites,   49 tests passed      (unchanged)
legacy       22 suites,  169 tests passed      (unchanged — no regression)
──────────────────────────────────────────────────────────────────
TOTAL                   1779 tests passed, 0 failed
```

**229 new tests — 228 in four new suites, plus one phase-boundary assertion added to
`commitmentSchema.test.js`:**

| Suite | Tests | Covers |
|---|---|---|
| `energyModel` | 96 | Every §14.2 term by hand; κ convergence to 1.12 in 20 missions; variance-not-sd inflation; the three tier conditions independently; the nesting assertion; binding-tier agreement with F34; `E_return` determinism and depot-only fallback; the charge-curve taper; wear superlinearity; the five §14.8 rows; the Scheduler contract |
| `payloadModel` | 60 | The aperture as a distinct constraint; the two mass readings; tiers 1–4 including a case FFD gets wrong and the exact search gets right; the tier-4 multiset key; per-stop CoG; access ordering; I7's four refusal cases |
| `energySchema` | 52 | Migration vs Prisma-generated SQL; additive-only; five CHECK constraints present *and* absent from the generated output; register completeness; the three Redis key shapes; tier mapping |
| `energySimulation` | 20 | The I17 rate gate over 60 000 missions; the percentage-floor source scan; simulator/server charge-model agreement |

### 12.1 Notable properties proven

- **Realised T1 and T2 event rates sit at or below their budgeted `α`** over a
  60 000-mission run admitting 30 %+ of what it is offered, with a **counterfactual**:
  the same fleet planned on a deterministic mean margin instead of the derived
  contingency quantile *breaches* its T1 budget. Without that second half the first
  would prove only that the numbers were small.
- **T3 is declared unestimable at this sample size** rather than passed silently:
  `α₃ = 1e-7` needs ~10⁸ missions, and the test asserts the arithmetic so nobody mistakes
  "0 events in 60 000" for evidence.
- **No percentage floor in the decision path**, proven four ways over 108 modules: no
  import of `dtaro.constants`, no read of `legacy.dtaro.*`, no threshold identifier, and
  every reserve field named `…Wh`. Plus: `interruptionPermitted()`'s body contains
  neither `soc` nor `battery`.
- **A 10 km mission costs more than a 1 km one** — and, more sharply, `β_payload_thermal`
  over half the occupancy costs exactly half.
- **The packing memo cannot store an indecision**, enforced by the module *and* by a
  CHECK constraint.

### 12.2 Defects found and fixed during testing

| Found | Nature | Fix |
|---|---|---|
| `loadState.project()` occupancy | `t_occupied(k)` was sampled from onboard membership per stop, which closes the interval at the **last stop the goods were still aboard** — on a two-stop plan, the pickup. Result: a zero-length interval and **an unpriced conditioning load on exactly the cold-chain missions §14.2 says the omission hurts most.** | Occupancy is now recorded on the load and unload *events*. A test asserts the conditioned mission costs strictly more than the unconditioned one. |
| `VirtualRobot._respondToOffer` | One shared `reason` string for two conditions meant a charging agent's ordinary wait was reported as a safety refusal — §11.2 reconciles a REJECT against the server's energy model as a possible calibration defect, so the conflation would have generated false calibration alerts. | Separate `interruptReason` and `floorReason`. |
| Register defaults | `energy.combined_degraded_conservatism` 2.0125 > cap 1.6 — a **pre-existing** V9 block. | **Not fixed.** Reported in §14 with three Safety-class options. |

---

## 13. Self-Verification

| Claim | Verified by |
|---|---|
| Every Phase 7 checklist item implemented | §2 table; all 21 traced to code |
| **No Phase 8+ functionality exists** | `plan/`, `solve/`, `pricing/`, `cost/` beyond Phase 1's two files still empty; `phase0Scaffold` ownership test; `commitmentSchema`'s "no Phase 8+ table" |
| **No Tier 2 mechanism shipped** | `reliability/` still empty; `gate:tiers` PASS |
| Architecture unchanged | `MODULE_TIERS` untouched; 3 gates pass |
| Build passes | `npm run gates` 3/3 |
| Tests pass | 1 779 / 1 779 |
| Migration valid | `prisma validate` ✅; SQL byte-equal to Prisma's own generation |
| APIs compatible | one new read-only endpoint; no existing shape changed; legacy lane green |
| Phase 6's predicates unmodified | `git diff` over `src/engine/feasibility/` is empty |
| Energy is Wh, never a percentage | source scan over 108 modules, 4 independent assertions |
| Reserve layers never traded | `assertNoTrade()`, 4 tests including the release case |
| `α[tier]` derived, never hand-set | `alphaFor()` refuses an unresolved derivation; `rejectHandEnteredDerived` tested |
| Contingency quantile derived from `α₁` | `deriveContingencyQuantile` test; hand-entry refused |
| Target SoC consumed, never computed | provenance check + no such function in `chargeCurve.js` |
| I17 verifiable | 60 000-mission run with counterfactual |

---

## 14. Known Limitations

1. **⚠ The seeded register cannot publish — V9 blocks on combined degraded
   conservatism.** Pre-existing since Phase 1; surfaced here because §14.3 is Phase 7's.

   ```
   nominal  = charger_availability_margin 1.15 × uncalibrated_reserve_factor 1.25 × f_derate 1.00 = 1.4375
   degraded = nominal 1.4375 × route.degraded_reserve_factor 1.40 × degraded.reserve_factor 1.00 = 2.0125
   cap      = energy.max_combined_conservatism                                                    = 1.6
   ```

   This is §14.3's mechanism working exactly as designed — "a fleet whose effective
   energy margin is 1.8× because four people each chose 1.15–1.25 will be quietly
   uneconomic without anyone having decided that" — and it is now visible. Three
   Safety-class options, none of which I took:

   (a) Raise `energy.max_combined_conservatism` to ≥ 2.02, which §14.3 says "is where a
   deliberate choice to be very conservative belongs — stated once".
   (b) Reconsider whether `energy.uncalibrated_reserve_factor` should declare
   `activeInNominal: true`. §14.3 describes it as compensating for *missing per-agent
   calibration*, which is conditional; it is currently unconditional in the nominal
   product. Changing it is a semantic change to a Safety parameter.
   (c) Reconsider whether `route.degraded_reserve_factor` and `degraded.reserve_factor`
   are two factors compensating for the same uncertainty — which §14.3 calls "a defect,
   not extra safety". Phase 6's report raised the same question as its non-blocking
   item 5.

   **Escalated to the calibration owner (blocking decision B8).** Nothing in Phase 7
   depends on the resolution; the arithmetic is pinned by test so a change is visible.

2. **Four Safety-class inputs ship uncalibrated with `null` defaults** —
   `energy.model_residual_cv` (new), `energy.reserve_floor_wh` (Phase 1). Each states
   what it `awaits`. Null denies loudly; a fabricated dispersion would produce three
   fabricated tier probabilities and F34 would admit or reject on them.

3. **The routing engine does not exist (blocking decision B1).**
   `chargerReachabilityCache.precompute()` takes `route(cell, profile, bucket)` as an
   injected dependency and is tested against a stub — the mitigation §6.2 names. Nothing
   in Phase 7 depends on which engine is chosen.

4. **The Charging Scheduler does not exist (blocking decision B2).** The engine's half of
   the contract is complete and validated at the boundary; the publisher is out of the
   engine's boundary (§1.6). Until one exists, `resolveTargetSoc()` returns the class
   default with a degradation flag and `E_return` falls back to depot-only — which is
   §14.7's own declared unavailability envelope, not a workaround.

5. **The Gaussian tail is an approximation and is optimistic against a heavier-tailed
   truth.** Stated in `consumption.js`, absorbed by `energy.model_residual_cv`'s
   calibration, and measured by §21.5's loop as realised-vs-budgeted tier rates.

6. **The migration has not been applied to a live database.**

7. **`β_thermal`'s two-curve form and `compartmentCentroids`' placement are stated
   readings**, not specification text (A4, A5). Both are flagged for verification.

8. **Everything is unwired.** No round consumes any of it; Phase 8 and Phase 10 do.

## 15. Remaining Non-Blocking Issues

1. **`PHASE_0_INDEPENDENT_VERIFICATION.md` still does not exist**, as Phases 1–6 all
   recorded.
2. **Migration application** is a deployment step, pending a reachable database.
3. **Neither new worker is scheduled.** Correct for this phase: `ENGINE_ENABLED` is false
   and Phase 15 owns production scheduling, matching the outbox, timer, reconciler, and
   rejection-aggregation workers.
4. **`EnergyModelParams` and `BatteryState` have no seed data.** The tables exist and are
   read; populating them is a commissioning activity, and every module reports a missing
   coefficient by name rather than defaulting one.
5. **`energy.charger_projection_max_age` is 120 s while a round is seconds long.** Not a
   defect — it bounds staleness, not cadence — but Safety should confirm the value once a
   Scheduler publication interval exists.

---

## 16. Readiness for Independent Verification

**Ready.** Suggested focus, in priority order:

1. **§14's V9 blocking finding.** Is (a), (b), or (c) the right resolution, and is
   "report, do not silently change a Safety parameter" the right disposition for a phase
   that owns the rule but not the parameter?
2. **A2 — the Gaussian choice.** It is the single largest modelling assumption in this
   phase, and it is optimistic in the tail where T3 lives.
3. **A3 — the severity interpolation** on variance inflation, and whether "absent
   severity inflates in full" is the right reading.
4. **A5 — `compartmentCentroids` inside `cogEnvelope`**, chosen to avoid a schema change
   to a Phase 2 table. Is avoiding the migration worth the coupling?
5. **A8 — the exclusion of `reliability/`.** Phase 7's checklist names it nowhere and
   §1.8 makes it Tier 2; §5.3's row F5 says "Phase 7, 16c".
6. **The `dtaro.constants.js` disposition (A1)** — retired from the decision path, kept
   for the legacy dispatcher until Phase 15.
7. **The `loadState` occupancy defect in §12.2** — it was caught by a test that asserted
   a physical property rather than a return shape, and it is worth checking whether the
   same class of error survives elsewhere in the per-stop projection.

Every claim in this report is reproducible with:

```bash
cd Backend
npm run gates        # 3/3
npm run test:engine  # 40 suites, 1561 tests
npm run test:gates   # 3 suites, 49 tests
npm run test:legacy  # 22 suites, 169 tests
```

**Phase 8 has not been implemented. No Phase 8 functionality exists in this change.**

---

*End of Phase 7 Implementation Report.*

---

## CLOSURE ADDENDUM — appended 2026-08-18

**Nothing above has been removed, edited, or rewritten.** This note exists so that a reader arriving
at this report is not left acting on its open items.

Phase 7 was formally closed on **2026-08-18**. The authoritative closure record is
[`PHASE_7_REMEDIATION_AND_CLOSURE.md`](PHASE_7_REMEDIATION_AND_CLOSURE.md).

| Item recorded above | Disposition at closure |
|---|---|
| §14.1 — V9 blocks on combined degraded conservatism 2.0125 vs cap 1.6 | **DEFERRED / governed Safety decision** (blocking decision B8). The closure additionally establishes that the four factors are Appendix A's *own defaults*, so the inconsistency is in the specification's default table rather than in any implementation phase; and that the report's option (b) is arithmetically ineffective. Unresolved, and it blocks publication — the conservative direction. |
| §14.6, §15.2 — the migration has not been applied to a live database | **RESOLVED.** Applied to a disposable PostgreSQL 18.3 cluster carrying the complete real migration chain; 82 live checks passed, including all five hand-written CHECK constraints made to fire. |
| §15.1 — `PHASE_0_INDEPENDENT_VERIFICATION.md` does not exist | **Documentation gap only.** The execution plan does not require one for Phase 0. Phase 0's actual completion criterion — both gates fail on planted violations — was evidenced live at closure. |
| Everything else | Phase 7's 15 modules are unchanged since this report was written and are committed at `cbe540e`. |

One defect **not** recorded above was found at closure, in `f26.js` (a Phase 6 file, on the seam this
report's producers feed): see the closure record §4.
