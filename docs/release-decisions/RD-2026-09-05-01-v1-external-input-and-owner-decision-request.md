# RD-2026-09-05-01 — V1 external-input and owner-decision request

**One complete request covering the entire current V1 external/owner boundary.**

| | |
|---|---|
| **Date issued** | 2026-09-05 |
| **Requesting party** | The RobotX V1 implementation session (repository-owned), acting under [`docs/v1/V1_IMPLEMENTATION_CONTROL.md`](../v1/V1_IMPLEMENTATION_CONTROL.md) §14, work item **W-D2** |
| **Recorded by** | Repository maintainer of record — git identity `Somanatha Basavanuty <peakmind.me@gmail.com>`, branch `feature/dashboard` |
| **Addressed to** | The **project owner**, the **§22.4 calibration owner**, **Safety**, **Engineering**, **Operations**, and the **operator of the target deployment**. Each item names its own accountable party in §4 and §5 |
| **Status of this record** | **ISSUED — AWAITING RESPONSE.** No item is answered. This record does not close S-3; it is the request whose *answers* close it |
| **Amendments** | **Amendment 1 — 2026-09-05, §4.11 (A11), before any response.** A11 is **narrowed**: the pack's stress **curves** have a schema column (`EnergyModelParams.stressCurves`) that the repository now reads, so that half is supplied as a **column value and needs no code from anyone**; the **mission** quantities (`socThroughput`, `dod`, `socMid`, `tempC`, `cRate`) are unchanged and still open. **Nothing was added to this request, no item was withdrawn, no value was proposed, and no stop condition moved — A11 is still open and S-3 is still NOT MET.** Recorded per §14 of the control document, which requires an existing record to be amended rather than a second request issued. Full reasoning: control document **§9.1** |
| **Governing documents** | [`V1_CONTRACT_AND_STOP_CONDITION.md`](../v1/V1_CONTRACT_AND_STOP_CONDITION.md) (canonical) · [`V1_IMPLEMENTATION_CONTROL.md`](../v1/V1_IMPLEMENTATION_CONTROL.md) §9, §10, §11, §12 (operational) |
| **Supersedes** | Nothing. No prior owner request for the V1 boundary has ever been issued |
| **Machine-readable record** | **None, deliberately.** A JSON companion would have to carry value fields, and every value field in it would be empty or invented. It is created when the response arrives |

---

## 1. STATUS — STATED BEFORE ANYTHING IS ASKED

> ## V1 is not complete; S-3 is not met.

Three of the eight canonical stop conditions hold. Five do not.

| Condition | Requirement (abbreviated — §I.2 of the contract is authoritative) | Status |
|---|---|---|
| **S-1** | No reported optimality gap is a value the engine did not prove, and no absent physical input is read as a benign one | **MET** |
| **S-2** | Every worker names a register parameter that exists, or a `@structural` constant with a stated reason | **MET** |
| **S-3** | The external values are supplied by the owner, in writing, in a decision record under `docs/release-decisions/` | **NOT MET** |
| **S-4** | The coordinator's solve path is composed and `COMPOSERS.coordinator` returns a started handle | **NOT MET** |
| **S-5** | A config version binding `cutover.engine_enabled = true` at region scope is published and pinned, and the process runs with `ENGINE_ENABLED=true` | **NOT MET** |
| **S-6** | One real request over HTTP against a live PostgreSQL reaches a durable `Commitment` and `Outbox` row in one transaction, with a `Round` row and a per-Leg decision record | **NOT MET** |
| **S-7** | `npm test` exit 0 **and** `npm run gates` exit 0 | **NOT MET** — `npm test` exits 0; `npm run gates` exits 1 |
| **S-8** | The V1 documentation states plainly what V1 does **not** guarantee | **MET** |

**Score: 3 of 8.** S-4, S-6 and S-7 are mechanical consequences of S-3 and S-5; the repository closes none of them.

### 1.1 Repository / tree context

| | |
|---|---|
| **HEAD** | **`4e2155a`** — `4e2155a9a25f7b9d71842ce971a625a1fecaba6e`, *"docs(v1): record E-11's committed source digest"* |
| **E-11 implementation commit** | `3ff92ae02b3a406ba77a5a9555a5e8eadfd67013` |
| **Branch** | `feature/dashboard` |
| **Committed source digest** | `023906bef5b23c34f71b64f78419d4d6562813a74f5dd9ca95c48ef719a1017a` / **581 files**, measured at `3ff92ae` |
| **`npm test`** | **exit 0** — 166 suites / 7 411 tests / 0 failures / 0 skips |
| **`npm run gates`** | **exit 1** — 7 PASS, 1 FAIL (`gate:composition`, `LEADER_ONLY_NOT_COMPOSABLE` for `coordinator`) |
| **Live S-3 measurement** | **`26 of 34` inputs unresolved**, measured 2026-09-05 on a running deployment (control document §5.6) |
| **Authoritative S-3 count** | **28** — the 26 measured, plus the 2 rows the instrument structurally cannot see (§4.15 below) |

### 1.2 The three numbers, so that no answer to this request is measured against the wrong one

| Number | What it is | Do **not** read it as |
|---|---|---|
| **28** | The authoritative **S-3 input count** — the rows this request asks for | a gate output |
| **34** | The **declared size of the coordinator's composition contract**, six rows of which this repository already supplies itself | an S-3 figure |
| **26** | The **measured live unresolved count** on a running deployment, 2026-09-05 | the S-3 total — it excludes the 2 rows no dependency probe can see |
| **33/38, 31/38, 30/38** | **§7.5 feasibility-predicate denial counts** on one composition fixture | anything about S-3 — it counts predicates, not inputs |

**A response that closes some rows will move 26 and will not move 34.** 34 changes only when the coordinator starts.

---

## 2. PURPOSE OF THIS REQUEST

S-3's closure act, as the contract defines it, is **one decision record under `docs/release-decisions/`**, naming its author and date, covering every row of the boundary. This is that record, issued.

**It is deliberately one request and not several.** Five separate counts of the V1 external boundary have been taken in this project's history — at §K, §L.2, §M.6, §N.2 of the contract, and again at §5.6 of the control document. The first four each widened after being stated confidently, always for the same reason: *each count was taken at whichever seam the reader reached.* The fifth was taken by the code, against a running process, and **it did not widen** — 26 measured rows, all 26 already on the 28-row list, nothing added, nothing removed, nothing reclassified.

The boundary in §4 and §5 is therefore issued **from a measured position rather than an inferred one**, and issuing it in pieces would recreate exactly the failure the measurement was taken to end: a second request, later, for rows that were already known.

**What this request is:** a statement of what is being asked for, from whom, where it enters the system, what will prove it closed, and what happens if it stays absent.

**What this request is not:** it proposes, defaults, illustrates and suggests **nothing**. There is no example value anywhere in this document — not for a router, a region, a charger, a terrain figure, a calibration constant, a temperature, a mass, a failure probability, a hazard cost, a battery-wear quantity or an energy rate — and most emphatically not for the two Safety-class rows, where §22.3 forbids an automated process from choosing at all. *A worked example in an owner request is a fabricated input with a disclaimer on it.*

---

## 3. HOW TO RESPOND — THE FOUR CATEGORIES, WHICH MUST NOT BE COLLAPSED

A response to this record is composed of four distinct things. They have different meanings, different authors and different consequences, and this record keeps them apart.

| Category | What it means | Who does it | What it closes |
|---|---|---|---|
| **1 — VALUE SUPPLIED** | A quantity, declaration or artefact that **exists** and is being transmitted | the accountable party in §4 | the corresponding §4 row |
| **2 — DECISION MADE** | An **act of authority** by a named person. Not discharged by transmitting a number | the accountable party in §5 | the corresponding §5 decision |
| **3 — EVIDENCE ATTACHED** | The artefact that lets a later reader verify 1 or 2 without trusting this record — a pinned config version id, a `Charger` row id, a named source, a signed approval, a command output | the same party | nothing on its own; it is what makes 1 or 2 checkable |
| **4 — ITEM DECLINED** | The party has decided **not** to supply or decide the item, for a stated reason | the same party | **nothing** |

### 3.1 Declining does not make anything pass

> **An item intentionally declined leaves its V1 condition NOT MET.** Declining changes who is accountable for the gap and why it exists. It does not change the gap, it does not permit a substitute, and it does not authorise the repository to supply the item itself, to default it, or to proceed as though it were present.

If a row is declined, the correct outcome is that **V1 does not ship** until it is supplied or the V1 contract itself is amended by the owner — and amending the contract is a separate, explicit act, not a consequence of a decline.

### 3.2 No absent physical input may be treated as benign

> **An absent physical input is not a zero, a default, a neutral value, or a conservative one.** A router that reports a level hop has measured something; a router that omits the field has not, and the two must never produce the same plan. An absent climb understates mission energy and thereby overstates the projected charge the §14 reserves are held against. An absent ETA spread prices a certain arrival. An absent mass, ambient temperature, failure probability, hazard cost or wear quantity does the same at its own term.

This is not a caution — it is enforced code, and the enforcement was restored by fixing three fail-**open** coercions that had been defeating it (contract §E.2). Any response that supplies a value **must supply a measured or declared one**; "assume flat", "assume nominal", "use the limit as the mass" and "treat it as zero for now" are all refusals dressed as answers, and the repository will not accept them under this record.

### 3.3 UNKNOWN remains DENY

> **UNKNOWN IS NOT PERMISSION — all the way down**, including at `ADMIT_WITH_PENALTY` and `DENY_UNLESS_ENVELOPE` when their admitting inputs are absent.

Every feasibility predicate that cannot determine its answer returns `INDETERMINATE`, and `INDETERMINATE` resolves to **DENY**, never to permission. An unassigned cell is not an out-of-area one; an unread exclusion set is not an empty one; an unpopulated access-rules column means *"nobody established what this site requires"*, not *"none required"*. **No response to this record may ask for that behaviour to be relaxed**, and no answer will be accepted that is only correct if it is.

### 3.4 V1 is complete only when all eight conditions hold

> **V1 will not be declared complete until all eight canonical S-conditions hold simultaneously, at one tree.** There is no S-9 and none may be added. A partial response closes partial rows and closes no stop condition. Answering every item in this record closes S-3 and makes S-4, S-5, S-6 and S-7 *reachable* — it does not make them met, and each is re-verified at the closing tree in its own right.

---

## 4. CATEGORY A — EXTERNAL INPUTS / VALUES

**These are values that exist in the world and must be transmitted. None of them is a decision.** Calling a missing measurement a "decision" would suggest someone can close it by choosing, and for these rows nobody can.

**A1 … A14 are the 28 S-3 inputs**, grouped by supply act exactly as §9 rows 1–14 of the control document group them. The arithmetic: **5 routing (A1–A5) + 15 register (A6) + 6 no-producer (A7–A11, A14) + 1 region (A12) + 1 charger (A13) = 28.**

**28 rows are not 28 suppliers.** They resolve to roughly **eight supply acts**: one traversal source (A1, A2, A3, A5), one fleet speed declaration (A4), one calibration publish (A6's fifteen), five engineering/data-source programmes (A7–A11, A14), one region declaration (A12), one charger declaration (A13, supplied with A14).

### 4.1 A1 — `route` traversal source · *§9 row 1*

| | |
|---|---|
| **What is needed** | One declared, real, self-hosted traversal source, **and an explicit statement of the environment it is declared for** |
| **Exact shape / semantics** | `async ({ originCell, destCell, profileKey, timeBucket }) => { … }` — the query shape is fixed; the six-field answer is **A2** |
| **Accountable owner** | **Project owner (B1)** |
| **Where it enters** | `leaderWorkers.create({ route })` → `routing/cellPairCache.read`, which falls through to `deps.route(parts)` on a cache miss |
| **Verification proving closure** | `coordinatorPipeline.requirements()` on a running process no longer lists `route` — the same measurement taken at control-document §5.6, re-run |
| **If it remains absent** | `cellPairCache.read` returns *"no router is available and the entry is not cached"*. **No hop of any plan can be resolved, so no candidate can be priced at all** |

**Explicitly not asked for here:** a routing-engine procurement decision or selection ADR. **V1 needs a declared source, not a vendor** (§8 of this record).

### 4.2 A2 — the exact six-field `route` contract · *§9 row 2*

| | |
|---|---|
| **What is needed** | That the declared source of A1 returns **exactly six fields**, every one finite and ≥ 0 |
| **Exact shape / semantics** | `distanceM`, `travelSeconds`, `travelSdSeconds`, `climbM`, `descentM`, `stopStartCycles` — contract §F.2, `Backend/src/engine/routing/cellPairCache.js` |
| **Accountable owner** | **Project owner (B1)** — the same traversal source as A1 |
| **Where it enters** | Two enforcement points, deliberately: the first three are refused by `cellPairCache.buildEntry` so a malformed row is never cached; the terrain three are carried by `buildEntry` and refused by `plan/timeline.project` at the decision path |
| **Verification proving closure** | `hop terrain (climbM / descentM / stopStartCycles)` no longer listed by `requirements()`; a cell-pair entry is built and cached without `MISSING_TERRAIN` |
| **If it remains absent** | The entry is refused and nothing is cached; or the plan is refused with `MISSING_TERRAIN` before it is built or priced |

> **A declared `0` is accepted in every field. Silence is not.** The two must not produce the same plan (§3.2).

**Note on terrain's classification.** `climbM`, `descentM` and `stopStartCycles` are *not* a family with no producer — they are fields the router produces and the seam was not carrying. §14.2 evaluates climb, regeneration and stop-start **over the traversal**, so terrain is a property of the hop exactly as `distanceM` is.

### 4.3 A3 — `travelSdSeconds` source (N29) · *§9 row 3*

| | |
|---|---|
| **What is needed** | A declared spread model **with a named source** |
| **Exact shape / semantics** | The `travelSdSeconds` field of A2, populated from a declared model rather than from the engine |
| **Accountable owner** | **Project owner** |
| **Where it enters** | `cellPairCache.buildEntry` |
| **Verification proving closure** | `travelSdSeconds source (N29)` no longer listed by `requirements()` |
| **If it remains absent** | The entry is refused and nothing is cached |

> **Selecting a routing engine does not close this row.** No shortlisted engine returns a spread — OSRM's `table`, Valhalla's `sources_to_targets` and GraphHopper's `route` are all point estimates. §8.4 prices `p_late` from the **predictive distribution**, not the point estimate, so turning that silence into zero asserts *"this ETA is certain"*, in the optimistic direction.

### 4.4 A4 — `speedMetresPerSecond` per routing profile · *§9 row 4*

| | |
|---|---|
| **What is needed** | One declared value **per routing profile in use** |
| **Exact shape / semantics** | A per-profile speed in metres per second, from a real fleet measurement |
| **Accountable owner** | **Project owner (D3 — Product + Fleet Engineering)** |
| **Where it enters** | `leaderWorkers.create({ speedMetresPerSecondFor })` → `cellPairCache.applyIntraCellOffset` |
| **Verification proving closure** | `speedMetresPerSecond (per routing profile)` no longer listed by `requirements()`; the intra-cell correction is applied rather than refused |
| **If it remains absent** | The correction is refused and **the cached pair is unusable** |

> **This is not routing and it is not supplied by the router.** It is §20.3's intra-cell quantisation — fleet/profile configuration, supplied alongside the traversal source and never by it. The only `MobilityModel` in this repository is a seed whose `speedModel` is a note deferring to D3.

### 4.5 A5 — `timeBucket` convention · *§9 row 5*

| | |
|---|---|
| **What is needed** | The congestion-bucket convention the traversal source is queried under — declared as part of declaring the source |
| **Exact shape / semantics** | §20.3 item 2 keys a cell-pair entry on `(origin_cell, destination_cell, mobility_profile, time_bucket)`, so that *"an entry computed under one mobility profile or one congestion bucket is never silently applied under another"*. The four key components are frozen at `cellPairCache.js:50` |
| **Accountable owner** | **Project owner** — part of declaring the traversal source (A1) |
| **Where it enters** | The `route` call itself, and `cellPairCache.key`, which refuses an entry without one |
| **Verification proving closure** | `timeBucket (§20.3 congestion bucket)` no longer listed by `requirements()`; cell-pair keys are formed |
| **If it remains absent** | **No query can be formed**, and no entry can be keyed |

> **This repository cannot derive it.** Bucketing the pinned decision time would be this repository choosing a congestion model, and **the bucket has to be the one the traversal source was actually queried under**, or the key describes conditions the router never saw.

### 4.6 A6 — the fifteen register / calibration values · *§9 row 6*

| | |
|---|---|
| **What is needed** | Fifteen register parameters, **all fifteen currently measured `null` on the published register** |
| **Exact shape / semantics** | Each is a `required: true` register entry with **no default**, declared `UNCALIBRATED`. Each is read through `snapshot.resolve(name, scope)` from a **published, pinned config version** |
| **Accountable owner** | **The §22.4 calibration owner** — except the two Safety-class rows, which are **Safety's** (A6a) |
| **Where it enters** | A published config version → `snapshot.resolve(name, scope)` |
| **Verification proving closure** | **All fifteen resolve non-`null` on the pinned snapshot**, and `requirements()` reports zero `REGISTER_UNRESOLVED` rows on a running process |
| **If it remains absent** | `MISSING_SERVICE_TIME`, `MISSING_ENERGY_INPUT`, and a per-term refusal at each cost term. **No plan is built and no candidate is priced** |

**The fifteen, each named at the function that refuses without it:**

| # | Parameter | Refused at | Class |
|---:|---|---|---|
| 1 | `plan.service_time_prior` | `plan/planBuilder.resolveServiceTimes` — `buildVariant` returns before projecting a timeline | §22.4 calibration owner |
| 2 | **`energy.model_residual_cv`** | `energy/consumption.predictiveDistribution`; `buildVariant` returns `MISSING_ENERGY_INPUT` | **SAFETY (§22.3)** — see A6a |
| 3 | `cost.energy.cu_per_wh` | `cost/cDirect.evaluate`, `candidates/lowerBound`, `expansion.unexploredRingFloorMilliCU` | §22.4 calibration owner |
| 4 | `cost.wear.cu_per_metre` | `cDirect.evaluate` and `cLifecycle.evaluate`; `phi.assertWearChargedOnce` keeps it charged exactly once | §22.4 calibration owner |
| 5 | `cost.failure.cu` | `cost/cRisk.evaluate`'s `p_fail · consequence` term (§8.3.1) | POLICY |
| 6 | `cost.staleness.cu_per_second_age` | `cRisk.stalenessPenalty` | POLICY |
| 7 | `cost.energy_consequence` | `cRisk.energyShortfall` — one consequence per §14.5 tier, named individually | POLICY |
| 8 | `cost.sla.cu_per_second_late` | `cost/cDelay.forLeg`, and `LB(a, l)`'s delay term | CONTRACTUAL |
| 9 | `cost.sla.breach_penalty` | `cDelay.forLeg`'s step penalty at the deadline (§8.7) | CONTRACTUAL |
| 10 | `lifecycle.cu_per_actuator_cycle` | `cLifecycle.actuatorCycleCost` (§8.5) | §22.4 calibration owner |
| 11 | `lifecycle.cu_per_braking_event` | `cLifecycle.tyreAndBrakeCost` (§8.5) | §22.4 calibration owner |
| 12 | `lifecycle.cu_per_gradient_metre` | `cLifecycle.tyreAndBrakeCost`'s gradient-exposure addend (§8.5) | §22.4 calibration owner |
| 13 | `lifecycle.cu_per_thermal_stress_second` | `cLifecycle.thermalStressCost` (§8.5) | §22.4 calibration owner |
| 14 | `cost.battery.cu_per_equivalent_cycle` | `energy/wear.batteryWear`; `cLifecycle` carries the refusal up as `battery.*` (§14.4) | §22.4 calibration owner |
| 15 | **`energy.reserve_floor_wh`** | `energy/reserves.compose` — no plan resolves a reserve floor, `reservesHold` is false for every variant | **SAFETY (§22.3)** — see A6a |

> **Production calibration is not required for thirteen of the fifteen.** A declared provisional value with a **named author** is enough for V1 on rows 1 and 3–14. **The two Safety-class rows are the exception**, and they are the subject of A6a.

### 4.6a A6a — the two Safety-class values, identified explicitly · *§9 row 6a*

> ### `energy.model_residual_cv` and `energy.reserve_floor_wh` are **SAFETY-CLASS**.

| | |
|---|---|
| **What is needed** | **Safety's actual decision and value for each of the two parameters.** Not a provisional stand-in, not an author-named placeholder, not a range |
| **Exact shape / semantics** | Two register parameters as described in A6 rows 2 and 15, published in a pinned config version |
| **Accountable owner** | **Safety** |
| **Where it enters** | As A6 |
| **Verification proving closure** | Both resolve non-`null` on the pinned snapshot, **and** the publish carries Safety's recorded authorship |
| **If it remains absent** | As A6, plus: **the repository will not and cannot proceed by choosing them** |

> **§22.3 forbids an automated process from choosing a Safety-class parameter, and the frozen documents offer no provisional route for these two at all.** **No value is proposed for either one anywhere in this record**, and none will be. This request asks Safety for its own decision and its own value.
>
> **They remain external *inputs*, not owner *decisions*.** A value that must be measured and then authorised by a named party is still a value; §10's own exclusion list classifies them this way, and the distinction matters because it identifies **who can close the row** — Safety, by supplying it, and nobody, by choosing it on Safety's behalf.

### 4.7 A7 — `environment.ambientC` / `environment.packC` · *§9 row 7*

| | |
|---|---|
| **What is needed** | Two temperatures in °C — ambient and pack — **and the code that reads them from a declared source** |
| **Exact shape / semantics** | The two temperatures `energy/consumption.betaThermal` evaluates the model's ambient and pack curves at |
| **Accountable owner** | **Engineering + a declared telemetry or forecast source** |
| **Where it enters** | `leaderWorkers.create({ environmentFor })` → `plan/planBuilder.legProfiles` |
| **Verification proving closure** | `environment.ambientC / packC` no longer listed by `requirements()`; `legEnergyWh` stops refusing on `profile.ambientC` / `profile.packC` |
| **If it remains absent** | `legEnergyWh` refuses. The thermal coefficient is a real term in §14.2's consumption model, and **omitting it is not a degradation this path is permitted to take silently** |

> **This is a `NO_PRODUCER` family: missing code *and* a missing named data source.** There is no Prisma column and no producer anywhere in `Backend/src/`. It is nobody's withheld decision.

### 4.8 A8 — `masses.vehicleMassKg` · *§9 row 8*

| | |
|---|---|
| **What is needed** | Vehicle mass in kg **per agent class**, from the fleet's own specifications, and the code that reads it |
| **Exact shape / semantics** | The vehicle's own mass, consumed by `legProfiles` as `profile.vehicleMassKg` |
| **Accountable owner** | **Engineering + fleet specifications** |
| **Where it enters** | `leaderWorkers.create({ vehicleMassKgFor })` → `legProfiles` |
| **Verification proving closure** | `masses.vehicleMassKg` no longer listed by `requirements()`; `legEnergyWh` stops refusing on `profile.vehicleMassKg` |
| **If it remains absent** | `legEnergyWh` refuses |

> **`AgentClass.totalMassLimitKg` is a *limit*, not a mass, and must not be read as one.** Doing so would overstate consumption on every candidate equally — the kind of error that looks conservative and is simply wrong. **No mass column exists in the schema.**

### 4.9 A9 — `p_fail` per agent · *§9 row 9*

| | |
|---|---|
| **What is needed** | A per-agent failure probability, and the producer that computes it |
| **Exact shape / semantics** | §8.3.1's per-agent posterior, consumed by `cost/cRisk.evaluate` as `failure.probability` |
| **Accountable owner** | **Engineering** — §8.3.1's reliability model, plus realised failure data |
| **Where it enters** | `context.failureProbabilityFor` → `cost/cRisk.evaluate` |
| **Verification proving closure** | `p_fail (per-agent failure probability)` no longer listed by `requirements()`; `cRisk.evaluate` prices the term |
| **If it remains absent** | `cRisk.evaluate` refuses, so **no candidate can be priced at all** |

> The Tier 2 module that would produce one lives at `Backend/src/engine/reliability/`, which holds a single `.gitkeep` and has since 2026-07-28. It is injected rather than imported, because §1.8 rule 2 forbids a Tier 1 composition root from linking a Tier 2 producer statically.

### 4.10 A10 — `route_hazard_cost` · *§9 row 10*

| | |
|---|---|
| **What is needed** | A per-route hazard cost, and the client that fetches it |
| **Exact shape / semantics** | A non-negative `routeHazardCu`, consumed by `cRisk.evaluate` |
| **Accountable owner** | **Engineering + the Map service (§5.2)** |
| **Where it enters** | `context.routeHazardCuFor` → `cRisk.evaluate` |
| **Verification proving closure** | `route_hazard_cost (Map service)` no longer listed by `requirements()`; the term is priced |
| **If it remains absent** | The term refuses |

> §5.2 names the Map service as the producer. `Backend/src/engine/map/obstructionClass.js` **consumes** `hazardData`, and **no client anywhere in `src/` fetches any** — so this input has a declared owner and no code path that reaches it.

### 4.11 A11 — §14.4 battery wear inputs · *§9 row 11*

| | |
|---|---|
| **What is needed** | The pack's stress **curves**, and the mission **conditions** the wear model is evaluated at, plus the code that computes the mission-side quantities |
| **Exact shape / semantics** | `energy/wear.batteryWear` refuses without the pack's `curves` and the mission's `conditions` — `dod`, `socMid`, `tempC`, `cRate`. This is §14.4's DoD-weighted wear |
| **Accountable owner** | **Engineering + the pack manufacturer's characterisation** |
| **Where it enters** | `context.batteryWearInputsFor` → `energy/wear.batteryWear` → `cost/cLifecycle` |
| **Verification proving closure** | `battery wear inputs (§14.4)` no longer listed by `requirements()`; `cLifecycle` stops carrying `battery.*` refusals |
| **If it remains absent** | `batteryWear` refuses and `cLifecycle` carries it up as `battery.*` — **no candidate is priceable** |

> ~~`EnergyModel` carries `chargePowerCurve` and `thermalDeratingCurve` and **no wear curve at all**, and nothing in `src/` computes a mission's SoC throughput or C-rate.~~ **CORRECTED — see the amendment below.** **This row is one row covering several §14.4 quantities**, exactly as A7 is one row covering two temperatures.

> #### ⓘ AMENDMENT 1 — 2026-09-05, same day, **before any response.** A11 is **narrowed**; nothing is added to it and nothing is asked for twice.
>
> **The statement above named the wrong table, and the repository has corrected its own code
> rather than leaving the request resting on a false premise.**
>
> `EnergyModel` does hold only `chargePowerCurve` and `thermalDeratingCurve` — that much was
> true, and it was not the relevant row. **`EnergyModelParams.stressCurves` exists**, declared
> in `prisma/schema.prisma` as *"the vendor cycle-life-versus-DoD curves §14.4 prices wear
> from"*; `src/engine/energy/wear.js` documents its own `curves` argument as *"the pack's
> `stressCurves` from `EnergyModelParams`"*; and the coordinator already loaded that row onto
> every agent snapshot. **The value had a home and a read path stopped one line short of it.**
> That read path is now written (`coordinatorSolvePath.js`, `batteryWearInputFor`).
>
> **What this changes for you — A11 splits into two halves with different homes:**
>
> | Half | What it is | How it is supplied |
> |---|---|---|
> | **The pack's stress curves** | The manufacturer's cycle-life-versus-DoD characterisation | **A column value.** Populate `EnergyModelParams.stressCurves` for the agent class. **No code is required from anyone** — the repository reads it as of this amendment |
> | **The mission quantities** | `socThroughput` and `conditions` — `dod`, `socMid`, `tempC`, `cRate` | **Unchanged and still open.** No column carries any of them, nothing in `src/` computes them, and `tempC` is **A7**'s ambient/pack temperature. This half is still *code plus a data source* |
>
> **What this does NOT change.** Nothing. **A11 is still open, still unanswered, and still
> required.** The requirement `battery wear inputs (§14.4)` is still declared by the
> coordinator's contract and still reported unsatisfied — a test asserts exactly that. The
> measured shortfall is still **26 of 34**, S-3 is still **28**, and **S-3 is still NOT MET**.
> An empty or absent `stressCurves` column produces precisely the refusal it produced before:
> `batteryWear` names `stressCurves` and no candidate is priceable.
>
> **No value is proposed here.** No curve, no DoD, no C-rate, no temperature, no throughput
> figure. The amendment names a **column**, not a number.

### 4.12 A12 — minimal serviceable-region assignment · *§9 row 12*

| | |
|---|---|
| **What is needed** | **The minimum, exactly:** for each fine cell containing the request's origin or any of its stops, one published assignment row, plus the `regions[]` / `zones[]` / `sites[]` rows those reference, **in a pinned config version** |
| **Exact shape / semantics** | `{ cellId, resolution: "FINE", regionId, zoneId?, siteId? }` per assigned fine cell |
| **Accountable owner** | **Project owner** — the declaration itself is **D-3** (§5.3) |
| **Where it enters** | The config `spatial` payload → `spatial/hierarchy.indexMap().resolve()` → `stop.serviceable` |
| **Verification proving closure** | **Not the dependency probe** — see §4.15. Closure is: the pinned config version carrying the assignments; F33 no longer `INDETERMINATE` on a real request; the §7.5 denial ladder falls to **30/38** with a region cover present |
| **If it remains absent** | F33 returns `INDETERMINATE`, which resolves to **DENY for every candidate of every Leg**. §3.6 forbids deriving containment from geometry at query time |

> **Explicitly NOT asked for:** the D1 signed boundary polygon, a CRS attestation, the full campus cover, the charger *estate*, or governance sign-off. Those are V2/production (§8). **V1's runtime needs the minimal assignment, not the cover.**
>
> **`serviceabilityFor` never refuses.** With no published map it returns every stop unchanged, leaving `serviceable` **absent** — never `false`. An absent region is a per-request indeterminacy that F33 turns into a DENY later, which is why its absence is invisible to the composition and is carried on this list by hand.

### 4.13 A13 — one depot-class `Charger` with a `cellId` · *§9 row 13*

| | |
|---|---|
| **What is needed** | **The minimum:** one declared depot-class `Charger` row **carrying a `cellId`** |
| **Exact shape / semantics** | A `Charger` row whose `cellId` is populated. A charger with no cell is **omitted and named**, never routed to at a guessed distance |
| **Accountable owner** | **Project owner** — the declaration itself is **D-4** (§5.4) |
| **Where it enters** | `Charger` rows → `chargerCandidates`; the latest `ChargerAvailabilityProjection` → `chargerProjection` |
| **Verification proving closure** | **Not the dependency probe** — see §4.15. Closure is: the `Charger` row present with a `cellId`; F34/F35 no longer `INDETERMINATE`; the §7.5 ladder falls to **31/38** with the charger and its rate (A14) |
| **If it remains absent** | `chargerCandidatesFor` returns `problems: ["no Charger rows are declared in this deployment"]`, F34/F35 stay `INDETERMINATE`, and `plan.energy` stays `null` |

### 4.14 A14 — return-leg Wh per metre, per routing profile · *§9 row 14*

| | |
|---|---|
| **What is needed** | The profile's **marginal return-leg energy per metre**, declared as `returnLegEnergyWhPerMetre` |
| **Exact shape / semantics** | Wh per metre, per routing profile. `routing/chargerReachabilityCache.buildEntry` computes §14.5's `E_return` as `distance × this rate` — an input it asks its **caller** for |
| **Accountable owner** | **Project owner / Engineering — supplied together with A13**, and alongside the profile's `speedMetresPerSecond` (D3) |
| **Where it enters** | `context.returnLegEnergyWhPerMetreFor` → `chargerReachabilityCache.buildEntry`, via `Backend/src/workers/coordinatorSolvePath.js:779-781` |
| **Verification proving closure** | `return-leg Wh per metre (per routing profile)` no longer listed by `requirements()`; the candidate's `energyWh` resolves |
| **If it remains absent** | The candidate's `energyWh` is absent and **F35 stays `INDETERMINATE`** |

> **`β_dist` is not a substitute.** It is the distance term alone and omits the mass, gradient, auxiliary and time terms — which would **understate `E_return`, overstate the surplus, and admit exactly the missions §14.5's reserve exists to refuse.**
>
> **The estate and the rate are supplied together, or F35 stays `INDETERMINATE`.** Supplying A13 without A14 closes nothing.

### 4.15 Two rows whose closure is **not** provable by the dependency probe

**A12 and A13 are the two S-3 rows the running system never mentions** — neither as missing nor as satisfied. This is checked against code, not assumed:

- The dependencies those seams need — `snapshot` and `prisma` — are **both already satisfied**. What is absent is **data inside a satisfied dependency**: an unpopulated field of a published snapshot, and an empty table.
- **No dependency-resolution probe can see an empty table or an absent snapshot field, at any depth of walk.** A12 and A13 will therefore *never* become visible to `coordinatorPipeline.requirements()`, and no work item exists to extend it.

**Consequence for this request:** the closure evidence for A12 and A13 is the **pinned config version and the `Charger` row themselves**, plus the F33/F34/F35 predicate outcomes on a real request — **not** a shrinking `N of 34`. A response that supplies A1–A11 and A14 will drive the measured numerator from 26 toward 0 and will leave A12 and A13 outstanding **without the number changing at all**.

### 4.16 §9 rows 15–18 — the four boundary rows that are **not** S-3 inputs

Recorded here so that every row of the §9 boundary is accounted for exactly once.

| §9 row | Item | Disposition in this record |
|---|---|---|
| **15** | B8 Safety-class calibration and two-person approval | **Requested as decision D-1** (§5.1). An act of authority, not a value |
| **16** | `candidate.max_radius_by_sla_class` | **NOT requested. NOT a V1 blocker.** Satisfied by §6.3's wall-clock disjunction — expansion falls back to the wall-clock bound. **Still owed by Operations**, and recorded here so its absence is not mistaken for an oversight |
| **17** | `SHARD_CONSENSUS_REPLICATION` declared store | **Requested as decision D-5** (§5.5). A declaration of fact about a deployment, made by an accountable party — not a measurement |
| **18** | S-5 engine-enabled region binding | **Requested as decision D-2** (§5.2). Not an input |

---

## 5. CATEGORY B — OWNER / DEPLOYMENT DECISIONS

**A decision is an act of authority by a named person. An input is a value that exists and must be transmitted.** They have different owners, different closure acts and different evidence, and this record does not relabel one as the other.

**None of D-1 … D-6 is discharged by transmitting a number.**

### 5.1 D-1 — B8 Safety-class calibration and two-person approval for production-intent configuration publication

| | |
|---|---|
| **What is needed** | A Safety decision on **`route.degraded_reserve_factor`** *or* on **`energy.max_combined_conservatism`**, such that publish-time validator **V9**'s combined-degraded product falls under the cap — **and** discharge of §22.3's **two-person rule (S2)** for a first publish |
| **Exact shape / semantics** | Both parameters are `SAFETY` class and `PROVISIONAL`. `route.degraded_reserve_factor` awaits *"measured degraded-estimate error distribution"*. V9 is a publish-time algebra check on the combined product against the cap; the current published defaults produce a product **above** the cap, which is why an unaccommodated first publish is rejected. **These are the current state, not proposals — no target value is proposed here, and none will be** |
| **Accountable owner** | **Safety** |
| **Where it enters** | Publish-time validation of a configuration version |
| **Verification proving closure** | A **Safety decision record under `docs/release-decisions/` with two named approvers**, and an **unaccommodated, production-intent** first publish that succeeds |
| **If it remains absent** | An unaccommodated production-intent first publish is rejected |

> **Scope correction, stated so this decision is not over-read.** B8 gates a **production-intent** publish. It does **not** block a *labelled verification environment* from publishing: the S-6 harness at `Backend/tools/verify/v1CorePath.js:180-209` publishes a configuration version by taking a labelled V9/S2 accommodation already precedented by `tools/verify/phase15CurrentTree.js`, and the E-11 run proved it by doing so. **Therefore "resolve B8" is not the technical unblock for S-5 or S-6.** D-1 gates production configuration, and it is asked for here because it is a genuine owner decision on the V1 boundary — not because it is the next mechanical step.
>
> **Explicitly NOT asked for:** the 39 Safety-class B8 parameters in full. **Only this single V9/S2 decision is a V1 prerequisite.**

### 5.2 D-2 — `cutover.engine_enabled = true` at region scope, published and pinned, with `ENGINE_ENABLED=true` at runtime

| | |
|---|---|
| **What is needed** | Publish a config version binding `cutover.engine_enabled = true` at **`region`** scope, **pin it**, and run the process with `ENGINE_ENABLED=true`. **Both halves are required** |
| **Exact shape / semantics** | An ordinary versioned, audited configuration act. `cutoverEnabled.forShard` **ANDs** the process fact and the configuration fact. The register default is `false`, `STRUCTURAL`, `DERIVED`, with scopes `global` / `region`. **No code change is needed** |
| **Accountable owner** | **Project owner** |
| **Where it enters** | `cutoverEnabled.describe({ snapshot, shard: { regionId } })`, read by `task.service.assignTask` (`Backend/src/engine/cutover/enabled.js`) |
| **Verification proving closure** | `cutoverEnabled.describe(...)` reports **`live: true, decisionPath: ENGINE`** on the target deployment |
| **If it remains absent** | `POST /api/tasks/assign` returns **HTTP 503 `ENGINE_NOT_LIVE`** and **nothing is written** |
| **Blocks** | **S-5**, and through it S-6 |
| **Depends on** | **D-3** — a region must exist before a binding at region scope means anything |

> **The mechanism is implemented and verified live.** The E-11 run made a real authenticated HTTP POST and received exactly this 503, with `processEnabled: true, configEnabled: false, live: false, decisionPath: "NONE"`. **This is §22.4's designed fail-closed staging, not a defect.** The verification harness deliberately declines to bind it (`v1CorePath.js:196-210`), because binding it would be a file in this repository deciding that the engine is live for a region.

### 5.3 D-3 — the declared V1 operating region and its minimal serviceable-cell assignments

| | |
|---|---|
| **What is needed** | A declaration that a **named region is the V1 operating region**, and publication of its **minimal fine-cell assignment** (the artefact described at A12) |
| **Exact shape / semantics** | The region's identity, plus the assignment rows and referenced `regions[]` / `zones[]` / `sites[]` of A12, in a pinned config version |
| **Accountable owner** | **Project owner** |
| **Where it enters** | The config `spatial` payload → `spatial/hierarchy.indexMap().resolve()` → `stop.serviceable` |
| **Verification proving closure** | A decision record **naming the region**, **plus** the pinned config version carrying the assignments. F33 stops returning `INDETERMINATE` on a real request |
| **If it remains absent** | F33 denies **every candidate of every Leg** |
| **Blocks** | S-3 → S-4 → S-6; F33; and D-2, which cannot bind at region scope without it |

> **The decision and the data are two different things and both are needed.** D-3 is the act of declaring; A12 is the artefact that act produces. Declaring a region without publishing its cell assignments closes neither.
>
> **Explicitly NOT asked for:** the D1 signed boundary, CRS attestation, full campus cover, or governance sign-off (§8).

### 5.4 D-4 — the depot charger and the return-leg energy-rate declaration

| | |
|---|---|
| **What is needed** | Declare **one depot-class charger with a `cellId`**, **and** the per-profile **return-leg Wh per metre** — the two together |
| **Exact shape / semantics** | The `Charger` row of A13 and the `returnLegEnergyWhPerMetre` of A14 |
| **Accountable owner** | **Project owner** (with Engineering / Fleet for the rate) |
| **Where it enters** | `Charger` rows → `chargerCandidates`; the declared rate → `chargerReachabilityCache.buildEntry` |
| **Verification proving closure** | A decision record, **plus** the `Charger` row(s) **and** the declared rate. F34/F35 stop returning `INDETERMINATE` |
| **If it remains absent** | F34/F35 stay `INDETERMINATE` and `plan.energy` is `null` |
| **Blocks** | S-3; F34; F35 |

> **The estate and the rate are supplied together or F35 stays `INDETERMINATE`.** This is a single decision covering two artefacts precisely because supplying either alone changes nothing.

### 5.5 D-5 — `SHARD_CONSENSUS_REPLICATION` posture for the actual target deployment

| | |
|---|---|
| **What is needed** | A **declaration of fact about the store the target deployment actually runs on** |
| **Exact shape / semantics** | One of the postures in `election.REPLICATION_POSTURE`. The declared vocabulary is `SYNCHRONOUS_QUORUM`, `SINGLE_PRIMARY_NO_AUTOMATIC_FAILOVER`, `ASYNCHRONOUS_FAILOVER`, and `UNDECLARED` (the default when nothing is declared). **Only the first two satisfy §19.5.** **This record states the permitted vocabulary and proposes none of it** — which posture is true is a fact about the deployment, and only the operator knows it |
| **Accountable owner** | **Project owner / the operator of the target deployment** |
| **Where it enters** | `process.env.SHARD_CONSENSUS_REPLICATION` → `election.postgresLeadershipStore(prisma, { replicationPosture })` → `election.assertConsensusStore`, called from `Backend/src/workers/shardSupervisor.worker.js:581` |
| **Verification proving closure** | The declared posture **recorded against the named deployment**, and a leader actually elected on that deployment |
| **If it remains absent** | The posture is `UNDECLARED`, `assertConsensusStore` refuses, **no leader is elected, no round runs, and the coordinator's composer never executes** |

> **Why this is a decision and not a value.** §19.5's prohibition on electing over a non-consensus store *"cannot be discharged by assumption"*. The code refuses `UNDECLARED` **precisely so that nobody asserts a posture the deployment does not have** — the adapter derives its guarantee from the posture rather than asserting it independently, so the two statements cannot disagree. Declaring it is an accountable act about real infrastructure.
>
> **The E-11 harness's declaration is not an answer to this.** `v1CorePath.js:324` declares a posture **about its own disposable single-node cluster**, created for that run. It is not a claim about production and must never be read as one.

### 5.6 D-6 — `MaxTicks = 3` boundedness acceptance

> ## ⚠ **NON-V1-BLOCKING. Outside the eight canonical V1 stop conditions.**

| | |
|---|---|
| **What is needed** | Sign, **or decline**, `MaxTicks = 3` as the global tick budget over 2 Legs in `lifecycle_c1` |
| **Exact shape / semantics** | §7.3a item 8. `commitment_c1` and `lifecycle_c1` both close **exhaustively**; what is unsigned is the **budget under which they close** |
| **Accountable owner** | **Release owner (§7.6)** |
| **Where it enters** | The formal-verification acceptance record. **It enters no runtime path** |
| **Verification proving closure** | A signed or declined acceptance |
| **If it remains absent** | The boundedness budget stays unsigned. **No V1 stop condition is affected** |

> **Why it is in this record at all.** It is a **genuine outstanding owner decision**, and this request is issued as one complete request precisely so that the owner is not asked twice. **It is not one of the eight S-conditions, it blocks none of them, and V1 may be declared complete with D-6 outstanding** provided all eight S-conditions hold.
>
> **It is asked here, and only here, on that explicit footing.** Answering D-6 closes no V1 condition; declining D-6 opens none.

---

## 6. CLOSURE EVIDENCE — CONSOLIDATED

**Exactly what will be accepted as proof that each item is closed.** Nothing else will be, and no item is closed by assertion in this record or in a later one.

| Item | Closure evidence required |
|---|---|
| **A1** | The declared source recorded, with its environment stated; `route` absent from `requirements()` on a running process |
| **A2** | A cell-pair entry built and cached with all six fields; `hop terrain (…)` absent from `requirements()`; no `MISSING_TERRAIN` refusal |
| **A3** | The declared spread model and its named source recorded; `travelSdSeconds source (N29)` absent from `requirements()` |
| **A4** | The per-profile values recorded; `speedMetresPerSecond (per routing profile)` absent from `requirements()`; `applyIntraCellOffset` applies rather than refuses |
| **A5** | The declared bucketing convention recorded; `timeBucket (§20.3 congestion bucket)` absent from `requirements()`; cell-pair keys form |
| **A6** | **All fifteen resolve non-`null` on the pinned snapshot**; zero `REGISTER_UNRESOLVED` rows from `requirements()`; the pinned config version id recorded |
| **A6a** | As A6 **plus** Safety's recorded authorship on the publish of both parameters |
| **A7** | `environment.ambientC / packC` absent from `requirements()`; the telemetry/forecast source named; `legEnergyWh` no longer refuses on those fields |
| **A8** | `masses.vehicleMassKg` absent from `requirements()`; the fleet specification named; `legEnergyWh` no longer refuses on that field |
| **A9** | `p_fail (per-agent failure probability)` absent from `requirements()`; the producer and its data source named; `cRisk.evaluate` prices the term |
| **A10** | `route_hazard_cost (Map service)` absent from `requirements()`; the Map-service client present; the term priced |
| **A11** | `battery wear inputs (§14.4)` absent from `requirements()`; the pack characterisation named; `cLifecycle` free of `battery.*` refusals |
| **A12** | **The pinned config version carrying the assignments** *(not the probe — §4.15)*; F33 not `INDETERMINATE` on a real request; §7.5 ladder at 30/38 with a cover |
| **A13** | **The `Charger` row(s) with `cellId`** *(not the probe — §4.15)*; F34/F35 not `INDETERMINATE`; §7.5 ladder at 31/38 with charger + rate |
| **A14** | `return-leg Wh per metre (per routing profile)` absent from `requirements()`; the declared rate recorded; the candidate's `energyWh` resolves |
| **D-1** | A Safety decision record under `docs/release-decisions/` with **two named approvers**; an unaccommodated production-intent first publish succeeds |
| **D-2** | `cutoverEnabled.describe(...)` reports **`live: true, decisionPath: ENGINE`** on the target deployment |
| **D-3** | A decision record **naming the region**, plus the pinned config version carrying the minimal assignments |
| **D-4** | A decision record, plus the `Charger` row(s) **and** the declared return-leg rate |
| **D-5** | The declared posture **recorded against the named deployment**; a leader actually elected there |
| **D-6** | A signed or declined acceptance. **Closes no V1 stop condition either way** |

### 6.1 What closing every item above does, and does not, achieve

| It closes | It does not close |
|---|---|
| **S-3**, when every A-row is supplied and every D-row decided, in writing, in a record under `docs/release-decisions/` | **S-4** — proved separately by `npm run gates` **exit 0** with `gate:composition` at 0 violations |
| Makes **S-4, S-5, S-6, S-7** *reachable* for the first time | **S-5** — proved separately by `describe(...)` reporting `live: true` |
| | **S-6** — proved separately by `node tools/verify/v1CorePath.js` **exit 0**, with a `Commitment` **and** an `Outbox` row in the same transaction, a `Round` row, and a per-Leg decision record |
| | **S-7** — proved separately by `npm test` and `npm run gates` both exiting 0 **at one tree** |
| | **S-1, S-2, S-8** — **re-verified at the closing tree.** A condition met at one tree is not met at another |

---

## 7. RESPONSE FORM

To be completed by the responding parties. **Every cell below is intentionally empty. Nothing in this record pre-fills, suggests, illustrates or defaults any answer.**

### 7.1 Category A — inputs

| Item | 1 · Value supplied | 2 · Decision made | 3 · Evidence attached | 4 · Declined — and why |
|---|---|---|---|---|
| **A1** `route` traversal source | | *n/a — this is an input* | | |
| **A2** six-field `route` contract | | *n/a* | | |
| **A3** `travelSdSeconds` source | | *n/a* | | |
| **A4** `speedMetresPerSecond` per profile | | *n/a* | | |
| **A5** `timeBucket` convention | | *n/a* | | |
| **A6** the fifteen register values | | *n/a* | | |
| **A6a** `energy.model_residual_cv` **(Safety)** | | *n/a* | | |
| **A6a** `energy.reserve_floor_wh` **(Safety)** | | *n/a* | | |
| **A7** `environment.ambientC` / `packC` | | *n/a* | | |
| **A8** `masses.vehicleMassKg` | | *n/a* | | |
| **A9** `p_fail` per agent | | *n/a* | | |
| **A10** `route_hazard_cost` | | *n/a* | | |
| **A11** §14.4 battery wear inputs | | *n/a* | | |
| **A12** minimal serviceable-region assignment | | *n/a* | | |
| **A13** depot-class `Charger` with `cellId` | | *n/a* | | |
| **A14** return-leg Wh/metre per profile | | *n/a* | | |

### 7.2 Category B — decisions

| Item | 1 · Value supplied | 2 · Decision made | 3 · Evidence attached | 4 · Declined — and why |
|---|---|---|---|---|
| **D-1** B8 Safety calibration + two-person approval | *n/a — this is a decision* | | | |
| **D-2** `cutover.engine_enabled = true` at region scope | *n/a* | | | |
| **D-3** declared V1 operating region | *n/a* | | | |
| **D-4** depot charger + return-leg rate declaration | *n/a* | | | |
| **D-5** `SHARD_CONSENSUS_REPLICATION` posture | *n/a* | | | |
| **D-6** `MaxTicks = 3` acceptance **(non-V1-blocking)** | *n/a* | | | |

### 7.3 Sign-off

| | |
|---|---|
| **Responding party** | |
| **Date of response** | |
| **Tree the response is recorded against** | |
| **Items supplied** | |
| **Items decided** | |
| **Items declined** | |
| **Stop conditions the responding party claims are closed** | |

> **A claim in the last row is a claim, not a proof.** Each is verified by the command or artefact named in §6 before any status in `V1_IMPLEMENTATION_CONTROL.md` §7 changes.

---

## 8. WHAT THIS REQUEST DELIBERATELY DOES **NOT** ASK FOR

**Every item below is classified V2, production, or Phase-15-release scope, with its authority recorded in §12 of the control document.** None of them is a V1 blocker, and none may be imported into this request or into V1 by a later reader.

| Not requested | Classification | Why not |
|---|---|---|
| Routing-engine **procurement / selection ADR** (B1 Steps 1/3/4/5) | V2 / PRODUCTION | A procurement decision on recorded evidence. **V1 needs a declared source, not a vendor** |
| The **full D1 signed boundary**, CRS attestation, full campus cover, charger **estate**, governance sign-off, containment-semantics escalation | V2 / PRODUCTION | Blocked on a governance vacuum with no escalation target. V1's runtime needs the **minimal** assignment (A12) and **one** charger (A13) |
| **D8** in full — extract identity, vintage, refresh cadence, re-contraction budget | V2 / PRODUCTION | Governs a production extract. A V1 environment has no refresh cadence to govern |
| The **39 Safety-class B8 parameters** in full | V2 / PRODUCTION | Only D-1's single V9/S2 decision is a V1 prerequisite |
| **Production calibration** of `plan.service_time_prior` | V2 / PRODUCTION | A declared provisional value with a named author is enough for V1. **`energy.model_residual_cv` is the exception** (A6a) |
| `candidate.max_radius_by_sla_class` | **V1 NON-BLOCKING** | Satisfied by §6.3's wall-clock disjunction. Still owed by Operations; does not block V1 |
| **Soak**, **shadow window**, **simulator fidelity**, `invariants_enforced`, `shadow_agreement` (B-P) | V2 / PRODUCTION | Each requires an operating fleet and an observation window. **Never simulate** |
| `safety_case_assembled`, `rollback_rehearsed` (B-O) | V2 / PRODUCTION | Filed attestations by named humans |
| **B-M / TLC beyond §G.1's V1 subset** — `commitment_c2/c3`, `lifecycle_c2/c3`, boundedness sign-off, named operator, §7.6 acceptance | PHASE 15 RELEASE ONLY | B-M is a §24 **release** gate. **V1 does not require B-M** |
| **Phase 15 §24 closure**; re-collecting `release-evidence.json` | PHASE 15 RELEASE ONLY | The release owner's step at a quiescent tree. Phase 15 is **FROZEN**; its verdict is BLOCKED either way |
| **Chaining / Tier-2** | V2 / PRODUCTION | Becomes free at a time only a chaining projection can state |
| **Phase 16**; `preemption.js`, `setPartitioning.js`, `branchAndBound.js`, `localSearch.js`; `stores/roles.js`, `deps/registry.js`, `circuitBreaker.js`, `routing/client.js`, `A9` | V2 — FUTURE ARCHITECTURE | Every §22.5 kill switch is thrown. **Do not create** |

**§9 of the control document ends with the same list, and this record adds nothing to it and removes nothing from it.**

---

## 9. RULES BINDING THIS RECORD AND ANY RESPONSE TO IT

1. **No value in this record is invented.** No region, charger, routing source, terrain figure, calibration constant, temperature, mass, `p_fail`, hazard cost, battery-wear quantity or energy rate is proposed, defaulted, illustrated or suggested anywhere in it.
2. **No example values.** A worked example in an owner request is a fabricated input with a disclaimer on it. There are none here.
3. **The two Safety-class values are asked for, not proposed** (§4.6a). §22.3 forbids an automated process from choosing them, and the repository will not.
4. **A missing measurement is not relabelled a decision, and a decision is not relabelled a measurement** (§4 vs §5). The former would suggest someone can close it by choosing; the latter would suggest a number discharges an act of authority.
5. **Declining an item does not make its V1 condition pass** (§3.1).
6. **No absent physical input is benign** (§3.2).
7. **UNKNOWN remains DENY / non-permissive** (§3.3).
8. **V1 is complete only when all eight canonical S-conditions hold** (§3.4). There is no S-9.
9. **Nothing in this record authorises fabricating an answer to any row of it** — not to make a gate green, not to reduce a count, not to reach an exit 0.
10. **This record creates no new V1 requirement.** Every row traces to §9 or §10 of the control document, and the trace is stated in §10 below.

---

## 10. TRACEABILITY — EVERY ROW'S SOURCE

**No requirement in this record originates here.** Each maps to exactly one row of the control document, and the mapping is one-to-one in both directions.

| This record | Control document | Live evidence |
|---|---|---|
| A1 … A14 | §9 rows 1 … 14, in the same order | 12 of the 14 measured live 2026-09-05 as part of `26 of 34` (§5.6.2); A12 and A13 are the two the instrument cannot see (§5.6.6) |
| A6a | §9 row 6a | §5.6.4 rows 7 and 20 |
| §4.16 row 15 → D-1 | §9 row 15 → §10 D-1 | E-11 run, §4.1 step 2 |
| §4.16 row 16 | §9 row 16 | `satisfied` array, §5.6.5 |
| §4.16 row 17 → D-5 | §9 row 17 → §10 D-5 | E-11 run, §4.1 step 3 |
| §4.16 row 18 → D-2 | §9 row 18 → §10 D-2 | E-11 run, §4.1 step 4 — a real HTTP 503 |
| D-1 … D-6 | §10 D-1 … D-6, in the same order | §10; D-6 classified non-blocking at §12 |
| §8 exclusions | §9's closing list and §12 | §11.E |
| The eight S-conditions | contract §I.2; control document §7 | §7 of the control document, verified against `4e2155a` |

**Work-item correspondence:** A1–A5 → **W-B1**, **W-B2** · A6/A6a → **W-B3** · A7–A11, A14 → **W-B4** · A12 → **W-B5** · A13, A14 → **W-B6** · D-1 → **W-C1** · D-2 → **W-C2** · D-3 → **W-C3** · D-4 → **W-C4** · D-5 → **W-C5**. This record itself is **W-D2**.

---

## 11. STATUS AFTER THIS RECORD IS ISSUED

| | |
|---|---|
| **S-3** | **STILL NOT MET.** Issuing a request is not receiving an answer |
| **S-4, S-5, S-6, S-7** | **STILL NOT MET.** Unchanged |
| **S-1, S-2, S-8** | **STILL MET.** Unchanged; re-verified at the closing tree |
| **Score** | **3 of 8 — unchanged** |
| **What changed** | The complete boundary is now stated in one place, to the accountable parties, from a **measured** position rather than an inferred one. That is a change in the record, not in the system |
| **Next action after this record** | **Awaiting the owner's response.** No repository work item is unblocked by issuing it |

> ### V1 is not complete; S-3 is not met.
>
> **TRUTH > GREEN.** V1 is a smaller, honest claim than Phase 15's release — not a weaker one.
