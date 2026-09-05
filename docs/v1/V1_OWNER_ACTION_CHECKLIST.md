# V1 Owner Action Checklist

**An operational collection sheet for the human/external items already defined by
[`RD-2026-09-05-01`](../release-decisions/RD-2026-09-05-01-v1-external-input-and-owner-decision-request.md).**

| | |
|---|---|
| **Created** | 2026-09-05 |
| **Tree** | HEAD `4e2155a`; working tree carrying the repository-only pass (uncommitted) |
| **What this is** | A checklist for collecting and deciding the inputs the owner request already defines. Nothing more |
| **What this is NOT** | **Not a contract. Not a status document. Not a second owner request. Not a source of truth.** It carries **no authority**, defines **no requirement**, and changes **no stop condition**. Every row traces to a row of `RD-2026-09-05-01`, and where it and that record differ, **the record governs and this file is wrong** |
| **Precedence above it** | 1 [`V1_CONTRACT_AND_STOP_CONDITION.md`](V1_CONTRACT_AND_STOP_CONDITION.md) · 2 [`V1_IMPLEMENTATION_CONTROL.md`](V1_IMPLEMENTATION_CONTROL.md) · 3 `RD-2026-09-05-01` (+ Amendment 1) · 4 `docs/phase15/*` · 5 the frozen engineering specification |
| **Nothing is proposed here** | **No value is proposed, defaulted, illustrated or suggested in this file** — no router, region, charger, terrain figure, calibration constant, temperature, mass, `p_fail`, hazard cost, battery-wear quantity or energy rate. Where a *format* is stated it is read out of the code that consumes it, never out of a value |

---

## Current state

| | S-1 | S-2 | S-3 | S-4 | S-5 | S-6 | S-7 | S-8 |
|---|---|---|---|---|---|---|---|---|
| **Status** | **MET** | **MET** | **NOT MET** | **NOT MET** | **NOT MET** | **NOT MET** | **NOT MET** | **MET** |

**Score: 3 of 8.**

**The exact reason V1 is stopped:**

> **S-3 is not met: the 28 external input values and the 5 V1-blocking owner decisions do not
> exist.** `RD-2026-09-05-01` was issued 2026-09-05 and **not one item in it is answered**.
>
> **S-4, S-6 and S-7 are mechanical consequences of S-3 and S-5, not independent defects.**
> `npm test` is **exit 0 — 167 suites / 7 429 tests / 0 failures**; `npm run gates` is **exit 1 —
> 7 PASS / 1 FAIL**, the single failure being `gate:composition` / `coordinator`
> (`LEADER_ONLY_NOT_COMPOSABLE`), which is **the correct output** while the inputs are absent.
> The live shortfall measured on a running deployment is **26 of 34 declared inputs unresolved**
> (control §5.6); 26 + the region + the charger = the authoritative **28**.
>
> **No repository-owned V1 work remains.** W-A1…W-A5, W-B4's repository side, W-D1 and W-D2 are
> closed; control §14.6 is empty. **The next state change is an owner act.**

---

## 1. Must provide / decide

**Type key — exactly one per row.** **A** = you personally supply a real value or data artefact ·
**B** = you personally make an owner decision/approval · **C** = another real-world
person/team/source must supply or decide it.

**Read the "Blocks" column as:** `S-3` = blocks S-3 directly · the further S-numbers are what its
supply *unlocks* (makes reachable — never *met*; each is proved separately at the closing tree).

| ID | Item — *why V1 needs it* | Type | Exact required value / artefact / decision | Source / owner | Format | Blocks | Validation after submission | Status |
|---|---|---|---|---|---|---|---|---|
| **A1** | **`route` traversal source** — *`cellPairCache.read` falls through to `deps.route(parts)` on a miss; with no source **no hop of any plan resolves and nothing can be priced***  | **A** | One declared, real, **self-hosted** traversal source, **plus an explicit statement of the environment it is declared for**. **A vendor selection/ADR is NOT asked for** | **Project owner (B1)** | A callable `async ({originCell, destCell, profileKey, timeBucket}) => {…}`, reachable from the deployment; the environment stated in writing | **S-3** → S-4, S-6, S-7 · **V1-CRITICAL** | `coordinatorPipeline.requirements()` on a running process no longer lists `route` | **OPEN — unanswered** |
| **A2** | **The six-field `route` answer** — *`buildEntry` refuses the first three so nothing malformed is cached; `timeline.project` refuses the terrain three before any plan is built* | **A** | That A1's source returns **exactly six fields, every one finite and ≥ 0**: `distanceM`, `travelSeconds`, `travelSdSeconds`, `climbM`, `descentM`, `stopStartCycles` (contract §F.2) | **Project owner (B1)** — the same source as A1 | Six numeric fields per answer. **A declared `0` is accepted in every field; silence is not** | **S-3** → S-4, S-6, S-7 · **V1-CRITICAL** | A cell-pair entry builds and caches with all six fields; `hop terrain (climbM / descentM / stopStartCycles)` absent from `requirements()`; no `MISSING_TERRAIN` | **OPEN — unanswered** |
| **A3** | **`travelSdSeconds` spread model (N29)** — *§8.4 prices `p_late` from the predictive distribution; an absent spread asserts a certain arrival, optimistically* | **A** | A **declared spread model with a named source**. **Selecting a routing engine does not close this** — no shortlisted engine returns a spread | **Project owner** | The `travelSdSeconds` field of A2, populated from the declared model; the model and its source recorded in writing | **S-3** → S-4, S-6, S-7 · **V1-CRITICAL** | `travelSdSeconds source (N29)` absent from `requirements()` | **OPEN — unanswered** |
| **A4** | **`speedMetresPerSecond` per routing profile** — *§20.3 intra-cell quantisation; `applyIntraCellOffset` refuses without it and the cached pair is unusable* | **A** | **One declared value per routing profile in use**, from a real fleet measurement. **This is not routing and the router does not supply it** | **Project owner (D3 — Product + Fleet Engineering)** | Metres per second, per profile key | **S-3** → S-4, S-6, S-7 · **V1-CRITICAL** | `speedMetresPerSecond (per routing profile)` absent from `requirements()`; the intra-cell correction applies rather than refuses | **OPEN — unanswered** |
| **A5** | **`timeBucket` convention** — *§20.3 keys an entry on `(origin, dest, profile, time_bucket)` so an entry computed under one congestion bucket is never applied under another; **no query can be formed without it*** | **A** | The congestion-bucket convention **the traversal source is actually queried under** — declared as part of declaring A1. The repository may not derive it | **Project owner** — part of A1 | The bucketing rule, in writing, and the value passed on each `route` call | **S-3** → S-4, S-6, S-7 · **V1-CRITICAL** | `timeBucket (§20.3 congestion bucket)` absent from `requirements()`; cell-pair keys form | **OPEN — unanswered** |
| **A6** | **The fifteen register / calibration values** — *each refuses individually at its own function: `MISSING_SERVICE_TIME`, `MISSING_ENERGY_INPUT`, and a per-term refusal at every cost term. **No plan is built and no candidate priced*** | **C** | All fifteen named at RD §4.6 — `plan.service_time_prior`, `cost.energy.cu_per_wh`, `cost.wear.cu_per_metre`, `cost.failure.cu`, `cost.staleness.cu_per_second_age`, `cost.energy_consequence`, `cost.sla.cu_per_second_late`, `cost.sla.breach_penalty`, `lifecycle.cu_per_actuator_cycle`, `lifecycle.cu_per_braking_event`, `lifecycle.cu_per_gradient_metre`, `lifecycle.cu_per_thermal_stress_second`, `cost.battery.cu_per_equivalent_cycle` **(13 here)** + the two Safety rows in **A6a**. **For these 13, a declared PROVISIONAL value with a named author is enough for V1** — production calibration is not required | **The §22.4 calibration owner** | Register parameter bindings in a **published, pinned config version**, resolved via `snapshot.resolve(name, scope)`; each with its author recorded | **S-3** → S-4, S-6, S-7 · **V1-CRITICAL** | All fifteen resolve non-`null` on the pinned snapshot; `requirements()` reports **zero** `REGISTER_UNRESOLVED` rows; the pinned config version id recorded | **OPEN — unanswered** |
| **A6a** | **The two Safety-class values** — ⚠ *`energy.model_residual_cv` and `energy.reserve_floor_wh`. These are **two of A6's fifteen**, not extra rows* | **C** | **Safety's own decision and value for each.** **Not** a provisional stand-in, **not** an author-named placeholder, **not** a range. §22.3 forbids an automated process from choosing them and **the repository will not** | **Safety** — nobody else can close these | As A6, **plus Safety's recorded authorship on the publish** | **S-3** → S-4, S-6, S-7 · **V1-CRITICAL · ⚠ SAFETY AUTHORITY REQUIRED** | Both resolve non-`null` on the pinned snapshot **and** the publish carries Safety's recorded authorship | **OPEN — unanswered** |
| **A7** | **`environment.ambientC` / `environment.packC`** — *`legEnergyWh` refuses without them; the thermal term is real in §14.2 and omitting it is not a permitted silent degradation* | **C** | Two temperatures in °C — ambient and pack — **and a declared telemetry or forecast source they come from**. **No schema column and no producer exists** (control §9.1) | **Engineering + a declared telemetry/forecast source** | Two °C values per evaluation, from the named source, reachable at `leaderWorkers.create({ environmentFor })` | **S-3** → S-4, S-6, S-7 · **V1-CRITICAL** | `environment.ambientC / packC` absent from `requirements()`; the source named; `legEnergyWh` stops refusing on `profile.ambientC` / `profile.packC` | **OPEN — unanswered** |
| **A8** | **`masses.vehicleMassKg`** — *`legEnergyWh` refuses without it; **`AgentClass.totalMassLimitKg` is a limit, not a mass**, and reading it as one overstates consumption on every candidate equally* | **C** | Vehicle mass in **kg per agent class**, from the fleet's own specifications. **No mass column exists in the schema** | **Engineering + fleet specifications** | Kilograms, per agent class, from the named specification | **S-3** → S-4, S-6, S-7 · **V1-CRITICAL** | `masses.vehicleMassKg` absent from `requirements()`; the specification named; `legEnergyWh` stops refusing on `profile.vehicleMassKg` | **OPEN — unanswered** |
| **A9** | **`p_fail` per agent** — *`cRisk.evaluate` refuses without it, so **no candidate can be priced at all*** | **C** | A per-agent failure probability (§8.3.1's posterior), **and the reliability model + realised failure data it comes from**. `src/engine/reliability/` holds only a `.gitkeep` | **Engineering** | A probability per agent, from the named model/data, reachable at `context.failureProbabilityFor` | **S-3** → S-4, S-6, S-7 · **V1-CRITICAL** | `p_fail (per-agent failure probability)` absent from `requirements()`; the producer and its data source named; `cRisk.evaluate` prices the term | **OPEN — unanswered** |
| **A10** | **`route_hazard_cost`** — *the term refuses without it. §5.2 names the Map service as producer; **no client anywhere in `src/` fetches any*** | **C** | A non-negative per-route hazard cost, **and the Map service it is fetched from** | **Engineering + the Map service (§5.2)** | A non-negative `routeHazardCu` per route, from the named service, at `context.routeHazardCuFor` | **S-3** → S-4, S-6, S-7 · **V1-CRITICAL** | `route_hazard_cost (Map service)` absent from `requirements()`; the client present; the term priced | **OPEN — unanswered** |
| **A11 · curves half** | **§14.4 pack stress curves** — *`batteryWear` names `stressCurves` and refuses; `cLifecycle` carries it up as `battery.*` and **no candidate is priceable*** | **C** | The pack manufacturer's **cycle-life-versus-DoD characterisation**, as a **column value**. **Amendment 1: the repository already reads it — no code is required from anyone** | **The pack manufacturer's characterisation** (via Engineering) | `EnergyModelParams.stressCurves` (`Json?`) for the agent class: one measured curve per stress argument — keys **`dod`, `socMid`, `tempC`, `cRate`**, each an array of `{x, y}` points (`energy/wear.js`, `consumption.evaluateCurve`). **An absent or non-object column stays absent and still refuses by name** | **S-3** → S-4, S-6, S-7 · **V1-CRITICAL** | `battery wear inputs (§14.4)` absent from `requirements()`; the characterisation named; `cLifecycle` free of `battery.*` refusals | **OPEN (the value)** — read path **CLOSED** (W-A5) |
| **A11 · mission half** | **§14.4 mission quantities** — *the other half of the same refusal* | **C** | `socThroughput` and the `conditions` `dod`, `socMid`, `cRate` — **plus the code that computes them**. **No column carries any of them.** `tempC` is **A7**. `BatteryState.socThroughput` is *cumulative lifetime* throughput and **is not** §14.4's per-plan Σ\|ΔSoC\| | **Engineering** (with the pack characterisation) | Per-plan quantities from a named model/source; `socThroughput` as a fraction, the three conditions as numbers | **S-3** → S-4, S-6, S-7 · **V1-CRITICAL** | As the curves half — the row clears only when **both** halves resolve | **OPEN — unanswered** |
| **A12** | **Minimal serviceable-region assignment** — *F33 returns `INDETERMINATE`, which resolves to **DENY for every candidate of every Leg**. §3.6 forbids deriving containment from geometry at query time* | **A** | **The minimum, exactly:** for each fine cell containing the request's origin or any of its stops, **one published assignment row**, plus the `regions[]` / `zones[]` / `sites[]` rows those reference. **NOT** the D1 signed boundary, CRS attestation, full campus cover, charger estate or governance sign-off | **Project owner** — the declaring act is **D-3** | `{ cellId, resolution: "FINE", regionId, zoneId?, siteId? }` per assigned fine cell, in the config `spatial` payload of a **pinned config version** | **S-3** → S-6 · **V1-CRITICAL** · **not visible to the probe** | **Not the probe** (RD §4.15): the **pinned config version carrying the assignments**; F33 no longer `INDETERMINATE` on a real request; §7.5 denial ladder falls to **30/38** with a cover | **OPEN — unanswered** |
| **A13** | **One depot-class `Charger` with a `cellId`** — *without it `chargerCandidatesFor` reports "no `Charger` rows are declared", F34/F35 stay `INDETERMINATE`, `plan.energy` stays `null`* | **A** | **The minimum:** one declared **depot-class `Charger` row carrying a `cellId`**. A charger with no cell is omitted and named, never routed to at a guessed distance | **Project owner** — the declaring act is **D-4** | A `Charger` row in the deployment database with `cellId` populated (plus its latest `ChargerAvailabilityProjection` where one exists) | **S-3** → S-6 · **V1-CRITICAL** · **not visible to the probe** | **Not the probe** (RD §4.15): the `Charger` row present with a `cellId`; F34/F35 no longer `INDETERMINATE`; §7.5 ladder falls to **31/38** with the charger **and** A14 | **OPEN — unanswered** |
| **A14** | **Return-leg Wh per metre, per routing profile** — *`chargerReachabilityCache.buildEntry` computes §14.5's `E_return` as `distance × this rate`; without it the candidate's `energyWh` is absent and **F35 stays `INDETERMINATE`*** | **C** | The profile's **marginal return-leg energy per metre**. **`β_dist` is not a substitute** — it is the distance term alone and would understate `E_return`, overstate the surplus, and admit exactly the missions §14.5's reserve exists to refuse. **Supplied together with A13, or F35 stays `INDETERMINATE`** | **Engineering / Fleet, with the Project owner** — supplied with A13 under **D-4** | `returnLegEnergyWhPerMetre` — Wh per metre, **per routing profile** | **S-3** → S-4, S-6, S-7 · **V1-CRITICAL** | `return-leg Wh per metre (per routing profile)` absent from `requirements()`; the rate recorded; the candidate's `energyWh` resolves | **OPEN — unanswered** |
| **D-1** | **B8 — the single V9/S2 Safety decision** — *an **unaccommodated, production-intent** first publish is rejected. **Not** the technical unblock for S-5 or S-6* | **C** | A Safety decision on **`route.degraded_reserve_factor`** *or* on **`energy.max_combined_conservatism`** such that publish-time validator **V9**'s combined-degraded product clears the cap, **and** discharge of §22.3's **two-person rule (S2)** for a first publish. **The 39 Safety-class B8 parameters in full are NOT asked for** | **Safety** — **two named approvers**, which a single person cannot discharge | A Safety decision record under `docs/release-decisions/`, naming both approvers | **S-3** (as a D-row of the request) · **does not block S-5/S-6** · **V1-CRITICAL (narrow) · ⚠ SAFETY AUTHORITY REQUIRED** | The Safety record with two named approvers **and** an unaccommodated, production-intent first publish that succeeds | **OPEN — unanswered** |
| **D-2** | **`cutover.engine_enabled = true` at region scope + `ENGINE_ENABLED=true`** — *without it `POST /api/tasks/assign` returns **HTTP 503 `ENGINE_NOT_LIVE`** and nothing is written. This is §22.4's designed fail-closed staging, not a defect* | **B** | Publish a config version binding `cutover.engine_enabled = true` at **`region`** scope, **pin it**, **and** run the process with `ENGINE_ENABLED=true`. **Both halves are required** — `forShard` ANDs them. **No code change is needed.** **Do not ask Claude to enable it** | **Project owner** — **depends on D-3** (a region must exist before a region-scope binding means anything) | An ordinary versioned, audited configuration act + the process environment variable | **S-3** → **S-5** → S-6 · **V1-CRITICAL** | `cutoverEnabled.describe(...)` reports **`live: true, decisionPath: ENGINE`** on the target deployment | **OPEN — unanswered** |
| **D-3** | **Declare the V1 operating region** — *the act that A12's data records. F33 denies everything without it* | **B** | A declaration that a **named region is the V1 operating region**, **plus** publication of A12's minimal fine-cell assignment. **The decision and the data are two things and both are needed** | **Project owner** | A decision record under `docs/release-decisions/` naming the region, plus the pinned config version | **S-3** → S-4, S-5 (via D-2), S-6 · **V1-CRITICAL** | The record naming the region **and** the pinned config version carrying the assignments; F33 stops returning `INDETERMINATE` | **OPEN — unanswered** |
| **D-4** | **Declare the depot charger and the return-leg rate** — *supplying either alone changes nothing* | **B** | Declare **one depot-class charger with a `cellId`** (A13) **and** the per-profile **return-leg Wh per metre** (A14) — **together** | **Project owner** (with Engineering/Fleet for the rate) | A decision record under `docs/release-decisions/`, plus the `Charger` row(s) and the declared rate | **S-3** → S-6 · **V1-CRITICAL** | The record, **plus** the `Charger` row(s) **and** the declared rate; F34/F35 stop returning `INDETERMINATE` | **OPEN — unanswered** |
| **D-5** | **`SHARD_CONSENSUS_REPLICATION` posture for the target deployment** — *undeclared → `assertConsensusStore` refuses → **no leader is elected, no round runs, and the coordinator's composer never executes*** | **B** | A **declaration of fact about the store the target deployment actually runs on** — not a choice, not an assumption. **Do not ask Claude to pick one to make the harness proceed.** The E-11 harness's declaration is about its **own disposable cluster** and is not a claim about any real deployment | **Project owner / the operator of the target deployment** | `process.env.SHARD_CONSENSUS_REPLICATION`, one of the declared vocabulary: `SYNCHRONOUS_QUORUM`, `SINGLE_PRIMARY_NO_AUTOMATIC_FAILOVER`, `ASYNCHRONOUS_FAILOVER`, `UNDECLARED`. **Only the first two satisfy §19.5** | **S-3** → S-4, S-6 · **V1-CRITICAL** | The posture **recorded against the named deployment**, and a leader **actually elected** there | **OPEN — unanswered** |
| **D-6** | **`MaxTicks = 3` boundedness acceptance** — *enters no runtime path* | **B** | **Sign or decline** `MaxTicks = 3` as the global tick budget over 2 Legs in `lifecycle_c1` (§7.3a item 8) | **Release owner (§7.6)** | A signed or declined acceptance in the formal-verification acceptance record | **NOTHING** — outside the eight conditions | A signed or declined acceptance. **Closes no V1 stop condition either way** | **OPEN — RECORDED ONLY, non-blocking** |

**Row count: 22 actionable items — 16 input rows and 6 decisions.** The 16 input rows are the
14 §9 boundary rows (**A6a is two of A6's fifteen, not an extra row; A11's two halves are one row**)
and together they carry the **28** S-3 values: 5 routing (A1–A5) + 15 register (A6 incl. A6a) +
6 no-producer (A7–A11, A14) + 1 region (A12) + 1 charger (A13). **21 of the 22 are V1-critical;
D-6 alone is recorded and non-blocking.**

### 1.1 The seven things most easily got wrong — stated once each

1. **Routing (A1–A5).** V1 needs **a declared, real, self-hosted traversal source and the
   environment it is declared for** — **not a vendor, not a procurement decision, not a selection
   ADR** (RD §8). The whole of what the engine asks of it is the **six-field contract of A2**, and
   **A3 and A5 are not closed by picking an engine**: no shortlisted engine returns a spread, none
   returns stop-start cycles, and the congestion bucket is a property of the query.
2. **Region (A12 + D-3).** V1's runtime needs the **minimal fine-cell assignment** for the cells a
   real request actually touches — **not** the D1 signed boundary, CRS attestation, full campus
   cover, charger estate or governance sign-off. **Repository demo geometry must not be promoted
   into this**; the assignment is a published, pinned config version or it is nothing.
3. **Charger (A13 + A14 + D-4).** One depot-class `Charger` **with a `cellId`**, and the per-profile
   **return-leg Wh per metre**, **supplied together**. Either alone leaves F35 `INDETERMINATE`.
4. **⚠ Safety-class values (A6a, and D-1).** `energy.model_residual_cv` and
   `energy.reserve_floor_wh` require **Safety's own decision and value**; D-1 additionally requires
   **two named approvers**. **No provisional number, placeholder or range is acceptable, and none is
   proposed anywhere** — §22.3 forbids an automated process from choosing, and the repository will
   not. *(A related divergence is already recorded and deliberately not acted on: `EnergyModelParams.residualCv`
   exists as a column and two code paths read the same question differently — control §9.1.4. Which
   artefact is authoritative is a Safety/§22.4 question routed to this boundary, not a repository fix.)*
5. **B8 (D-1).** What V1 needs is **one V9/S2 decision**, not the production calibration programme —
   **the 39 Safety-class B8 parameters in full are explicitly not asked for.** And the scope
   correction matters operationally: B8 gates a **production-intent** publish; a **labelled
   verification publish is precedented** and the E-11 run performed one, so **"resolve B8" is not
   the technical unblock for S-5 or S-6** (control §4.2).
6. **Cutover (D-2).** The owner action for S-5 is exactly: **publish a config version binding
   `cutover.engine_enabled = true` at `region` scope, pin it, and run the process with
   `ENGINE_ENABLED=true`.** Both halves. The mechanism is implemented and verified live; **no code
   change is needed and Claude will not enable it** — the S-6 harness deliberately declines to bind
   it (`v1CorePath.js:196-210`).
7. **Consensus store (D-5).** What is needed is a **statement of fact about the store the target
   deployment runs on**, from the four-value vocabulary. The code refuses `UNDECLARED` precisely so
   that **nobody asserts a posture the deployment does not have**; §19.5's prohibition *"cannot be
   discharged by assumption"*. **An implementation must not be chosen merely to let the harness
   proceed.**

### 1.2 Four standing rules that govern every answer

- **Declining an item does not make anything pass.** It changes who is accountable for the gap; it
  does not change the gap and does not authorise a substitute (RD §3.1).
- **No absent physical input is benign.** *"Assume flat"*, *"assume nominal"*, *"use the limit as
  the mass"*, *"treat it as zero for now"* are refusals dressed as answers and will not be
  accepted. **A declared `0` is accepted everywhere; silence is not** (RD §3.2).
- **UNKNOWN remains DENY**, all the way down. No answer may ask for that to be relaxed (RD §3.3).
- **V1 is complete only when all eight conditions hold at one tree.** There is no S-9. A partial
  response closes partial rows and **closes no stop condition** (RD §3.4).

---

## 2. Items already resolved

**Only genuinely resolved things appear here. Nothing below needs any action from you.**

| Item | Why no action is needed |
|---|---|
| **The A11 curves *read path*** | **Amendment 1 / W-A5.** `EnergyModelParams.stressCurves` is declared in the schema and the repository now reads it. **No code is required from anyone** for that half. **The curve *value* is still open** (§1, A11 curves half) |
| **`candidate.max_radius_by_sla_class`** (§9 row 16) | **Not requested and not a V1 blocker.** Satisfied by §6.3's wall-clock disjunction — expansion falls back to the wall-clock bound. Still owed by Operations; recorded so its absence is not mistaken for an oversight |
| **The six process dependencies** — `prisma`, `kv`, `runSerializable`, `selectForUpdate`, `signingKey`, `snapshot` | Supplied by the repository's own composition root (`Backend/server.js:657-722`) and **measured in the runtime `satisfied` array**, not inferred |
| **The Ω admissibility precondition** | A **derived** requirement, not an input anyone supplies. It resolved as soon as the snapshot did |
| **The cutover mechanism itself** | Implemented and verified live over real HTTP (the 503 is the mechanism working). D-2 is a configuration act, **not a code change** |
| **The coordinator's solve-path composition** | Written (E-9/E-11). It refuses **by name, on measured inputs** — which is why `gate:composition` now fails for an external reason rather than an internal one |
| **All repository-owned V1 work** | W-A1…W-A5, W-B4's repository side, W-D1 (the `26 of 34` measurement), W-D2 (the owner request). **Control §14.6 is empty** |
| **The S-6 harness** | Exists, runs, and is registered as `npm run verify:v1CorePath`. It exits **1** at the designed boundaries, which is the correct result until S-3 and S-5 close |

---

## 3. Explicitly not required for V1

**Do not collect, commission, or decide any of these to close V1.** Each is V2, production, or
Phase-15-release scope (RD §8, control §11.E / §12).

- A routing-engine **procurement decision or selection ADR** (B1 Steps 1/3/4/5).
- The **full D1 governance package**: signed boundary polygon, CRS attestation, full campus cover,
  the charger **estate**, governance sign-off, containment-semantics escalation.
- **D8** in full — extract identity, vintage, refresh cadence, re-contraction budget.
- The **39 Safety-class B8 parameters** beyond D-1's single V9/S2 decision.
- **Production calibration** of `plan.service_time_prior` — a declared provisional value with a
  named author is enough for V1. **`energy.model_residual_cv` is the exception** (A6a).
- **B-P**: soak, shadow window, simulator fidelity, `invariants_enforced`, `shadow_agreement`.
- **B-O**: `safety_case_assembled`, `rollback_rehearsed`.
- **B-M / TLC** beyond §G.1's V1 subset; boundedness sign-off beyond D-6; §7.6 acceptance.
- **Phase 15 §24 closure**; re-collecting `release-evidence.json`. Phase 15 is **FROZEN**.
- **Chaining / Tier-2**, **Phase 16**, and every module on §11.E's do-not-create list
  (`stores/roles.js`, `deps/registry.js`, `circuitBreaker.js`, `routing/client.js`, `A9`,
  `preemption.js`, `setPartitioning.js`, `branchAndBound.js`, `localSearch.js`).

---

## 4. Completion test

**Hand the information back only when all of the following are true.** Anything less is a *partial*
response: it closes the rows it answers and **closes no stop condition**.

1. **Every row of §1 has a disposition** — supplied, decided, or explicitly declined with a stated
   reason. No row is left silent. *(D-6 may be signed **or** declined; either way it blocks nothing.)*
2. **Each disposition uses the right category** (RD §3): a **value supplied** for A-rows, a
   **decision made** for D-rows, **evidence attached** for both, or **declined — and why**. Values
   and decisions are not swapped.
3. **The answers are written into `RD-2026-09-05-01`'s response form (§7.1, §7.2, §7.3)** — the
   existing record, amended. **Do not create a second request.** S-3's closure act is a decision
   record under `docs/release-decisions/`, naming its author and date.
4. **The evidence named in RD §6 actually exists**, not merely a claim that it does:
   the pinned **config version id** (A6, A6a, A12); **Safety's recorded authorship** on the two
   Safety-class rows and the **two named approvers** on D-1; the **`Charger` row id** with its
   `cellId` (A13); the **declared rate** (A14); the **named sources** for A3, A7, A8, A9, A10, A11;
   the **populated `EnergyModelParams.stressCurves`** column (A11 curves half); the **declared
   posture recorded against the named deployment** (D-5); the **named region** (D-3).
5. **No fabricated, assumed, or placeholder answer is anywhere in it** — no *"assume flat"*, no
   *"nominal"*, no limit read as a mass, no zero standing in for a missing measurement, and no
   proposed value for either Safety-class row.
6. **The target deployment is identified** — D-2, D-3 and D-5 are each *about a specific
   deployment*, and a posture or a region binding not attached to one is not evidence.

> **A claim that a stop condition is closed is a claim, not a proof.** Each is re-verified by the
> command or artefact named in RD §6 before any status in control §7 changes.

---

## 5. Claude's next integration phase

**High level only. Nothing here starts until the checklist is satisfied, and nothing here is
authorised by this file.**

1. **Record the response** — amend `RD-2026-09-05-01` with the answers and evidence, and update
   control §7, §9, §11 and §16 with the tree each answer was verified against. **Verify each item
   against RD §6's evidence rather than accepting the claim.**
2. **Integrate the supplied inputs at the seams the documents already name** — the declared
   traversal source at `leaderWorkers.create({ route })`, the per-profile speed, the environment,
   mass, `p_fail`, hazard-cost and battery-wear producers at the accessors
   `coordinatorPipeline` already declares. **Within §17's do-not-touch rules**, and **without
   creating any module on §11.E's list**.
3. **Re-measure, not re-argue** — re-run `node tools/verify/v1CorePath.js` and drive the live
   `N of 34 inputs unresolved` numerator down from **26**, recording each measurement and its tree.
   **A12 and A13 will never appear in that number** (RD §4.15); their closure is the pinned config
   version and the `Charger` row, plus the F33/F34/F35 outcomes on a real request.
4. **Then, and only then, the mechanical conditions** — **S-4** by `npm run gates` exit 0 with
   `gate:composition` at 0 violations *(a row leaves `UNCOMPOSABLE` only when the worker actually
   starts — §17 rule 6)*; **S-5** by `cutoverEnabled.describe(...)` reporting `live: true`;
   **S-6** by the harness exiting 0 with a `Commitment` **and** an `Outbox` row in one transaction,
   a `Round` row and a per-Leg decision record; **S-7** by both commands exiting 0 at one tree.
5. **Re-verify S-1, S-2 and S-8 at the closing tree** (W-D6) — a condition met at one tree is not
   met at another.

> **Nothing in this checklist changes any stop condition. The score is 3 of 8, exactly as before.**
> **TRUTH > GREEN.**
