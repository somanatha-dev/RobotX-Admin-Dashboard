# V1 Discovery and Owner Questions

**An operational discovery pass over the complete repository and the Phase 0–15 record, taken to
find out which of the outstanding V1 items the project can already answer for itself.**

| | |
|---|---|
| **Created** | 2026-09-05 |
| **Tree** | HEAD `4e2155a`; working tree carrying the repository-only pass (uncommitted). No file outside this one was created or modified by this pass |
| **What this is** | A discovery document. It records what was searched, what was found, and which questions genuinely remain for a human |
| **What this is NOT** | **Not a contract. Not a status document. Not a second owner request. Not a replacement for [`V1_OWNER_ACTION_CHECKLIST.md`](V1_OWNER_ACTION_CHECKLIST.md).** It carries **no authority**, defines **no requirement**, changes **no stop condition**, and does not alter **S-1…S-8** |
| **Authority above it** | 1 [`V1_CONTRACT_AND_STOP_CONDITION.md`](V1_CONTRACT_AND_STOP_CONDITION.md) (canonical) · 2 [`V1_IMPLEMENTATION_CONTROL.md`](V1_IMPLEMENTATION_CONTROL.md) · 3 [`RD-2026-09-05-01`](../release-decisions/RD-2026-09-05-01-v1-external-input-and-owner-decision-request.md) + Amendment 1 · 4 `docs/phase15/*` · 5 the frozen engineering specification. **Where this file and any of those differ, they govern and this file is wrong** |
| **Relationship to the checklist** | `V1_OWNER_ACTION_CHECKLIST.md` **remains intact and remains the operational collection sheet.** Nothing in it was rewritten. Where this pass found a classification in it that needs correcting, the discrepancy is recorded in **§3.6** of this document and nowhere else |
| **No value is proposed here** | **Not one.** No router, region, charger, terrain figure, calibration constant, temperature, mass, `p_fail`, hazard cost, wear quantity, energy rate, consensus posture or Safety value is proposed, defaulted, illustrated or suggested anywhere in this file. Where a *shape* or a *convention already implemented in this repository* is named, it is read out of the code that defines it and cited by file and line |

---

## 1. Executive result

### 1.1 The eight stop conditions, as they stand

| | S-1 | S-2 | S-3 | S-4 | S-5 | S-6 | S-7 | S-8 |
|---|---|---|---|---|---|---|---|---|
| **Status** | **MET** | **MET** | **NOT MET** | **NOT MET** | **NOT MET** | **NOT MET** | **NOT MET** | **MET** |

**Score: 3 of 8 — unchanged by this pass.** This discovery changed nothing and closed nothing.

Re-measured on this tree during this pass, not quoted from a document:

- `npm run gates` — **7 PASS, 1 FAIL.** The single failure is `gate:composition`,
  `LEADER_ONLY_NOT_COMPOSABLE` for `coordinator`, printing a `requires` list of exactly **34**
  rows. That is the correct output while the inputs are absent.
- `npm test` — run during this pass; result recorded in **§10** of this document.

### 1.2 What is actually blocking V1

**S-3.** Nothing else is an independent blocker. S-4, S-6 and S-7 are mechanical consequences of
S-3; S-5 is one owner configuration act that itself depends on the region decision.

**What this pass adds to that statement:** S-3 is not a single wall of 28 equally-unknown values.
Investigated against the whole record, it separates into four very different things:

1. **Things the project already decided and then never carried into the V1 boundary.** The
   operating-region identities are the largest: the owner declared two named campus regions with
   `kind`, `crs`, `version` and `versionDate` on **2026-08-30**
   (`docs/phase15/B1_EXTERNAL_INPUT_HANDOFF.md` §1.8.1, `RD-2026-08-30-01`), and the V1 checklist
   still carries the region row as *"OPEN — unanswered."*
2. **Things whose mechanism is written and whose value is not.** The travel-time spread, the
   time bucket, the region assignment publish path and the charger read path are all implemented
   and all refuse by name.
3. **Things that are genuinely absent, and that no amount of searching produces** — vehicle mass,
   ambient and pack temperature, per-agent failure probability, route hazard cost, the mission-side
   battery quantities, and the return-leg energy rate.
4. **Four items that are on none of the current lists at all**, found by this pass. They are in
   **§2** as **N-1 … N-4** and reconciled in **§3.5**.

### 1.3 The counts

**26 V1 requirements were investigated** — the 22 rows of the owner checklist plus four items this
pass found that appear on neither the 28-row S-3 list nor the 34-row composition contract.

| Result | Count | Where |
|---|---:|---|
| **A — already exists and is usable** (the requirement is closed) | **0** | no V1 input row is closed |
| **B — exists but needs integration** (repository work, once a value exists) | **4** | A1 · A3 · A5 · A12 |
| **C — exists but is outdated or scoped to something else** | **2** | A12's *"unanswered"* status · A13's 2026-08-30 *"no chargers"* declaration |
| **D — exists only as demo/test data and cannot be promoted** | **3** | the seeded spatial map · the test-fixture `EnergyModelParams` · the S-6 harness's own environment |
| **E — genuinely missing** | **9** | A2-terrain · A4 · A7 · A8 · A9 · A10 · A11-mission · A14 · N-2 |
| **F — requires an owner decision** | **8** | A1-authorisation · A5-convention · D-2 · D-3 · D-4 · D-5 · D-6 · N-4 |
| **G — requires an external authority or source** | **12 supply acts** across **9 distinct external parties** | §6 |
| **H — not required for V1** | **17 families** | §7 |

**Rows carry more than one classification where they genuinely have more than one part**, and
this table does not collapse them: A12 is **C + F + B**, A13 is **C + F + G**, A1 is **B + F + G**.
The per-row breakdown is §2.

**Genuine owner questions: 13**, of which **12 are V1-blocking** and **1 (MaxTicks) is not.**
That is the whole of §9.

**Existing-checklist classifications this pass found need correcting: 2** (A12, A13), plus **4
factual discrepancies** in shipped source and in the owner request. All six are in §3.6. **None of
them was corrected in place by this pass** — the checklist and the contract are untouched.

---

## 2. Complete V1 requirement inventory

**Every conclusion below cites the file, line, schema declaration or command output it rests on.**
Rows A1…D-6 are the 22 rows of `V1_OWNER_ACTION_CHECKLIST.md` §1. Rows N-1…N-4 are new.

| ID | V1 requirement | Evidence found | Current state | Classification | V1 blocking? | Owner question? | External party? | Next action |
|---|---|---|---|---|---|---|---|---|
| **A1** | A declared, self-hosted `route` traversal source | **Four complete executable adapters exist**: `Backend/tools/routing/adapters/{osrm,valhalla,graphhopper,inhouse}.js` over an 820-line shared `contract.js`, with an operator-supplied configuration seam `deployment.js` (`ROUTING_B1_DEPLOYMENT`). **They are benchmark adapters in `tools/`, not the production seam** — `contract.js:12-18` says so itself, and contract §F.1 row C already recorded *"Partly, and not as-is."* `server.js:657-722` passes **no `route`**. `ROUTING_B1_DEPLOYMENT` is unset and **nothing in `Backend/` ships a `b1Deployment.js`** (`deployment.js:40-42`) | Adapter layer complete; no engine deployed; no seam wired | **B** (adapter→`route(parts)` adaptor) **+ G** (a deployed engine) **+ F** (contract §F.1 row F: whether a declared non-production source is acceptable *"is the owner's decision and nobody else's"*) | **YES** | **YES** — Q6, Q7 | **YES** — whoever hosts the engine | Owner answers Q6/Q7; then Claude writes the adaptor and wires `leaderWorkers.create({ route })` |
| **A2** | The six-field `route` answer | `cellPairCache.buildEntry` refuses the first three; `plan/timeline.project` refuses the terrain three (contract §F.2). The adapter layer normalises **only** `distanceM`, `travelSeconds`, `travelSdSeconds` (`contract.js:616-651`); **no adapter produces `climbM`, `descentM` or `stopStartCycles`** | First three: shape exists. Terrain three: no producer anywhere | **B** (first three) **+ E** (terrain three) | **YES** | **No** — part of A1's declaration | **YES** — the same source | Falls out of A1. A declared `0` is accepted in every field; silence is not |
| **A3** | `travelSdSeconds` spread model with a named source | **The mechanism is already implemented and already refuses without a named source.** `contract.js:368-401` requires `travelTimeSpread: { source, model: "PROPORTIONAL"\|"ABSOLUTE_SECONDS", value }` and `spreadSeconds()` (`:602-605`) computes the field from it. `:387-395` states why no engine supplies one | Mechanism written; model and source absent | **B + G** | **YES** | **No** — supplied with A1 | **YES** — whoever declares the spread model | Reuse the existing `travelTimeSpread` shape when A1's source is declared |
| **A4** | `speedMetresPerSecond` per routing profile | The only `MobilityModel` is a seed whose `speedModel` is the note *"Populated by the routing integration in Phases 7–9 (blocking decision B1)"* (`prisma/seed.js:274`). `kinematicLimits.maxSpeedMps: 1.5` exists (`seed.js:275`) — **a limit, not a profile speed**, the same error class as A8's mass limit. Profile **keys** are derivable: `domain/mobilityModel.routingProfileKey` (`:95`) exists and `b1Readiness.js:319` already calls it. `contract.js:429` requires a positive `profile.speedMetresPerSecond` per candidate | Key derivable; value absent | **E + G** | **YES** | **YES** — reached via Q1 (is there a fleet to measure?) | **YES** — Fleet Engineering (D3) | Owner answers Q1; a fleet measurement is then either obtainable or it is not |
| **A5** | The `timeBucket` convention | **A bucketing convention is already implemented and already in use in two other subsystems.** `plan/timeline.hourOfWeek(epochMs, utcOffsetSeconds)` (`timeline.js:131`) derives an hour-of-week arithmetically, with no clock; `ServiceTimeModel.hourOfWeek` is declared *"0–167, Sunday 00:00 **site-local** being 0"* (`schema.prisma:2827`); `CalibrationObservation.timeBucket` is *"the hour-of-week bucket, in `[0, 168)`, matching `ServiceTimeModel`'s own"* (`:2317`). The adapter layer requires the caller to supply it and forbids an adapter from reading a clock (`contract.js:531`) | A candidate convention exists, is implemented, and is deterministic. **Whether it is the bucket the traversal source is queried under is not a repository fact** | **F + B** — **not E** | **YES** | **YES** — Q12 | No | Owner answers Q12; if YES, no new convention is invented and `timeline.hourOfWeek` is reused |
| **A6** | The 13 non-Safety register / calibration values | All 13 verified present in `src/engine/config/register/{cost,supplementary}.json` with `"default": null` and `"calibrationStatus": "UNCALIBRATED"`. Each is named at its refusing function in `coordinatorPipeline.js:181-268`. Measured unresolved on a running process (control §5.6.2) | Declared, unresolved | **G** (the §22.4 calibration owner) **+ F** (will the owner author provisional values) | **YES** | **YES** — Q10 | **YES** — the calibration owner | A provisional value with a **named author** is enough for V1 for these 13 |
| **A6a** | `energy.model_residual_cv` · `energy.reserve_floor_wh` | Verified: these are the **only two** of the fifteen carrying `"changeClass": "SAFETY"` (register scan, this pass). Both `required: true`, `default: null`, `UNCALIBRATED`. §22.3 forbids an automated process from choosing a Safety-class parameter | Declared, unresolved, and **not** openable by anyone but Safety | **G — external authority** | **YES** | **Only Q9** (does a Safety authority exist) | **YES — Safety** | Nothing but Safety's own decision and value closes these. **No value is proposed anywhere** |
| **A7** | `environment.ambientC` / `packC` | **No schema column**: `Telemetry` carries `lat, lon, speed, battery` only (`schema.prisma:466-481`); the only `ambient`/`pack` mentions are the two comments on `EnergyModelParams.betaThermal`. **No producer** in `src/`. **Hidden prerequisite found this pass**: `consumption.betaThermal` (`:174-186`) needs the temperatures **and** the model's `ambientCurve`/`packCurve` — which live on the same absent `EnergyModelParams` row as **N-1** | Genuinely absent, and gated behind N-1 | **E + G** | **YES** | **No** (reached via Q1) | **YES** — a telemetry or forecast source | Held behind Q1 |
| **A8** | `masses.vehicleMassKg` | **No vehicle-mass column exists.** The four mass columns are `ContainerModel.totalMassLimitKg` (`:1021`, a limit), `Compartment.maxMassKg` (`:1055`), `PayloadSpec.massKg` (`:1244`) and `PayloadManifest.declared/observedMassKg` (`:1295-1296`) — all loads or limits. Consumed as `profile.vehicleMassKg` (`consumption.js:232`, `planBuilder.js:347`) | Genuinely absent | **E + G** | **YES** | **YES** — Q11 | **YES** — the fleet specification | Owner answers Q11 |
| **A9** | `p_fail` per agent | `Backend/src/engine/reliability/` holds a **single 0-byte `.gitkeep`**, dated 2026-07-28 (directory listing, this pass). No schema column. `cRisk.evaluate` refuses without it, so **no candidate is priced at all** | Genuinely absent. Needs a model **and realised failure data** | **E + G** | **YES** | **No** (reached via Q1 — realised failure data needs an operating fleet) | **YES** — Engineering | Held behind Q1 |
| **A10** | `route_hazard_cost` | `map/obstructionClass.js` **consumes** `hazardData.obstructionClass` — an obstruction *class* for stranding disposition, **not** a per-route CU cost. No client fetches any. **Adjacent artefact found**: a live legacy obstacle-reporting substrate exists — `model ObstacleEvent` with `lat/lon/severity/expiresAt` (`schema.prisma:308-326`) fed by `sockets/handlers/dtaro.handler.js`. **It reports obstacles; it does not price routes**, and converting a severity label into a CU cost is a modelling act nobody has performed | Genuinely absent; a reporting substrate exists and is not the same thing | **E + G** | **YES** | **No** | **YES** — Engineering + the Map service (§5.2) | Recorded so the substrate is not mistaken for the input |
| **A11 · curves** | §14.4 pack stress curves | Column exists (`EnergyModelParams.stressCurves`, `:2575`) and the read path is **closed** (W-A5). **The column is empty everywhere**: `prisma/seed.js` creates **no `EnergyModelParams` row at all** | Home exists; value absent | **G** — the pack manufacturer's characterisation | **YES** | **No** | **YES** — the pack manufacturer | Populate the column. **See N-1: the row itself does not exist yet** |
| **A11 · mission** | `socThroughput`, `dod`, `socMid`, `cRate` | No column carries any of them. `BatteryState.socThroughput` (`:2617`) is *cumulative lifetime* throughput, written by `energyCalibration.worker.js:118`, and is **not** §14.4's per-plan Σ\|ΔSoC\| | Genuinely absent | **E** | **YES** | **No** | **YES** — Engineering | — |
| **A12** | Minimal serviceable-region assignment | **Three findings.** (1) **The owner already declared the region identities** on 2026-08-30: `rnsit-bengaluru` and `jssate-bengaluru`, `kind: CAMPUS`, `crs: OGC:CRS84`, `version`, owner-declared `versionDate` (B1 handoff §1.8.1; `RD-2026-08-30-01` §1). (2) **The cell ids are mechanically derivable, not owner-supplied**: `spatial/cells.cellForPoint(lat, lon, FINE)` (`cells.js:305`) is pure H3 at **resolution 11** (`:230`, `@structural ADR-35` — **amended 2026-09-19**; this read *"resolution 8 (`:181`)"* under the superseded model). (3) **The V-8 empty-cover blocker does not apply here** — `regionBoundary.validateCover` is reached only from `tools/routing/b1Readiness.js` (the D1 acceptance gate); the config publish path validates `v8SpatialContainment` and `a6SpatialCellIdentity` (`validators.js:520`, `:620`) and neither computes a polygon cover. *(Separately, since `RD-2026-09-14-01` D2 the empty-cover condition no longer fires for either approved campus at all: the adopted resolution-11 covers are non-empty, so the binding condition on the acceptance gate is **V-9**, discharged by the declared `cardinalityException`.)* The read seam is **written**: `serviceabilityFor` (`coordinatorSolvePath.js:1184`) → `hierarchy.indexMap()` | The decision half is largely made; the publish half is repository work; **which single region is V1's is undecided** | **C + F + B** — **not E** | **YES** | **YES** — Q2 | No | Owner answers Q2; Claude then derives the cells and publishes one pinned config version |
| **A13** | One depot-class `Charger` with a `cellId` | Schema is ready: `model Charger` with `cellId`, `isDepot`, `chargerClass` (`:2633-2673`). The read seam is **written** (`chargerCandidatesFor`, `coordinatorSolvePath.js:834`). **No `Charger` row is seeded anywhere.** **And the owner has already answered this once, in the negative**: *"Production chargers — **NONE currently exist**"* at either campus, *"no ids or locations are to be inferred from OSM, repository, demo or test data"* (B1 handoff §1.8.1). Contract §M.3 addresses exactly that: the declaration *"is a statement about production and is exactly the decision this row now needs re-taken for a V1 environment"* | Mechanism ready; **the standing declaration is that none exists** | **C + F + G** | **YES** | **YES** — Q8 | **YES** if one must be procured or installed | Owner answers Q8. **If the answer is NO, that is a real outcome with a real consequence — §5.6** |
| **A14** | Return-leg Wh per metre, per profile | No register entry and no schema column. **The shape is precedented**: the benchmark adapter layer already requires `profile.energyWhPerMetre` as a positive number per candidate (`contract.js:425-431`), and B1 handoff §2.5 classes it D3-owned. Consumed at `chargerReachabilityCache.buildEntry` via `coordinatorSolvePath.js:779-781` | Shape precedented; value absent | **E** (value) **+ B** (shape) | **YES** | **No** — supplied with A13 under D-4 | **YES** — Fleet/Engineering | `β_dist` is not a substitute (control §9 row 14) |
| **D-1** | B8 — one V9/S2 Safety decision | Verified: `route.degraded_reserve_factor` (`default 1.4`, SAFETY, PROVISIONAL) and `energy.max_combined_conservatism` (`default 1.6`, SAFETY, PROVISIONAL) — register scan, this pass. §22.3's two-person rule needs **two named approvers** | Open | **G — external authority (Safety), two people** | **YES** (narrow) | **Only Q9** | **YES — Safety** | Confirmed by the record: this is **not** the technical unblock for S-5 or S-6 (control §4.2) |
| **D-2** | `cutover.engine_enabled = true` at region scope **+** `ENGINE_ENABLED=true` | Mechanism implemented and verified live (`cutover/enabled.js`; the E-11 run's real HTTP 503). Register entry verified: `default false`, `STRUCTURAL`, `DERIVED`, scopes `global`/`region` (`supplementary.json`). **`ENGINE_ENABLED=false` in `Backend/.env:17`** | Open; depends on D-3 | **F** | **YES** — S-5 | **YES** — Q5 | No | No code change. **Claude will not enable it** |
| **D-3** | Declare the V1 operating region | See A12. The act is distinct from the data | Open | **F** | **YES** | **YES** — Q2 | No | Q2 |
| **D-4** | Declare the depot charger **and** the return-leg rate | See A13 + A14. Either alone changes nothing | Open | **F + G** | **YES** | **YES** — Q8 | Possibly | Q8 |
| **D-5** | `SHARD_CONSENSUS_REPLICATION` posture | Verified: **set nowhere except the S-6 harness**, which declares it about its own disposable cluster (`v1CorePath.js:350`). Vocabulary verified at `shard/election.js:95-100`; only `SYNCHRONOUS_QUORUM` and `SINGLE_PRIMARY_NO_AUTOMATIC_FAILOVER` are `safe: true`. **Evidence about the deployment**: `Backend/.env`'s `DATABASE_URL` names a **Neon** pooled endpoint (`…-pooler.ap-southeast-1.aws.neon.tech`) and `REDIS_URL` a Redis Cloud endpoint. **That is evidence, not a declaration** — §19.5's prohibition *"cannot be discharged by assumption"* and this pass makes none | Undeclared | **F — a declaration of fact by the operator** | **YES** | **YES** — Q3 + Q4 | Possibly, if the operator is not the owner | Q3/Q4. **Claude will not pick one** |
| **D-6** | `MaxTicks = 3` boundedness acceptance | Verified: `formal/lifecycle_c1.cfg:20` reads `MaxTicks = 3`. Enters no runtime path | Open | **F — non-blocking** | **NO** | **YES** — Q13 | No | Sign or decline; closes no stop condition either way |
| **N-1** ⚠ | **The fitted `EnergyModelParams` row itself** — 9 β scalars + `betaThermal` ambient/pack curves | **NEW — on neither the 28-row S-3 list nor the 34-row probe.** `consumption.legEnergyWh` refuses without `model` and every scalar in `SCALAR_COEFFICIENTS`, then calls `betaThermal` which needs `ambientCurve` and `packCurve` (`consumption.js:251-275`). `coordinatorSolvePath.js:308,319,373` loads the row onto every agent snapshot. **`prisma/seed.js` creates no `EnergyModelParams` row** — `EnergyModel.consumptionCoefficients` is the note *"β coefficients are fitted in Phase 7 (§14.2); none is asserted here"* (`seed.js:289`). **The only source of one anywhere is a test fixture**: `tests/engine/coordinatorSolvePathComposition.test.js:161-173` builds it from `energyFixture.energyModelParams()`. Contract §F.0 recorded it as *"Schema-backed … assembly code absent — V1-MUST-FIX (code)"*; the code half is done and **the data half was never carried onto the S-3 list**. Invisible to the probe for §5.6.6's exact reason — data inside a satisfied dependency | Column home exists, loader exists, **no real row exists in any deployment** | **D + G** | **YES** — no plan can be priced without it | **No** (reached via Q1) | **YES** — a fitted energy model / vendor characterisation | Record it on the boundary. **A11's curves are one column of this same row** |
| **N-2** ⚠ | **`BatteryState.lastObservedSoc` has no producer** | **NEW.** Read at `coordinatorSolvePath.js:381` as the agent's `soc`; the file's own header says *"an agent with no `BatteryState` row carries `soc: null`, and F7/F34 refuse it"* (`:284-286`). **Nothing in `src/` writes it**: the only `batteryState` writer is `energyCalibration.worker.js:118`, which sets `kappa`, `socThroughput` and `cycleCount` and **not** `lastObservedSoc`. A legacy percentage exists — `Robot.battery` / `Telemetry.battery`, written by `sockets/handlers/telemetry.handler.js` — and **nothing maps it across**. It is not a free mapping: §14.1 explicitly rejects a percentage floor because *"at 70 % state of health, 30 % SoC is 21 % of the nominal energy"*, so whether the legacy percentage is an admissible SoC is a real question | Consumer written; no producer; a legacy percentage exists and is not the same quantity | **E + F** | **YES** for a real end-to-end request | Deferred — routed with A7/N-1 | Possibly | Record on the boundary; do not map the legacy percentage without a decision |
| **N-3** ⚠ | **`COMMAND_SIGNING_KEY` is not declared for this deployment** | **NEW.** `server.js:718` reads `process.env.COMMAND_SIGNING_KEY`. **It is absent from `Backend/.env`.** The S-6 harness generates a random one for its own process (`v1CorePath.js:353`). So E-11's `signingKey: satisfied` is a fact about the harness's environment, **not about any deployment** — the same class of artefact as D-5's posture. `shards.controller.js:331` already has an explicit refusal for a deployment that declares none | Wired; unset | **G — an operator-declared deployment secret** | **YES** for a real end-to-end request | Reached via Q3 | **YES** — the operator | Declare it on whichever deployment Q3 names |
| **N-4** ⚠ | **No target deployment has ever been identified** | **NEW.** D-2, D-3 and D-5 are each *about a specific deployment*, and the checklist's own completion test says so (§4 item 6). **No deployment record exists anywhere under `docs/`.** The available evidence is `Backend/.env` (Neon + Redis Cloud + a localhost frontend) and the S-6 harness's disposable PostgreSQL on port 55432 | Unidentified | **F** | **YES** — it gates D-2, D-5 and N-3 | **YES** — Q3 | No | Q3 |

---

## 3. Historical evidence reconciliation

**For every item the current lists call missing, the Phase 0–15 record and the repository were
searched for a prior supply, decision or artefact. Nothing found is silently reused.**

### 3.1 The operating region — the largest historical finding

| | |
|---|---|
| **What exists** | Two named region declarations with five of §36.3.1's fields already stated: `rnsit-bengaluru` / `jssate-bengaluru`, `kind: CAMPUS`, `crs: OGC:CRS84`, `version: rnsit-boundary-v1` / `jssate-boundary-v1`, `versionDate: 2026-08-30` (owner-declared, not a file timestamp), `OUTDOOR`, ADR-33 traversal domain `SIDEWALK_GRAPH`, `ROAD_GRAPH` deliberately excluded |
| **Where** | `docs/phase15/B1_EXTERNAL_INPUT_HANDOFF.md` §1.8.1 (the table), and `docs/release-decisions/RD-2026-08-30-01-rnsit-serviceable-boundary.md` §1 for RNSIT's geometry |
| **What phase introduced it** | The B1/D1 prerequisite pass, 2026-08-30 |
| **Still valid under the current V1 contract?** | **The region *identities* are valid and are owner-declared facts. The *boundary geometry* is D1/production scope and V1 does not need it** — contract §M.2 states this in terms: V1's runtime needs *"the minimal assignment, not the cover"*, and §D.3 shows a k-ring-bounded expansion runs from `cells.cellForPoint` with no published cover at all |
| **Can it legally be reused?** | **The identities, yes — they are the owner's own declaration.** What may **not** be reused is the RNSIT/JSSATE GeoJSON as D1 supply: `B1_EXTERNAL_INPUT_HANDOFF.md` §1.1 names those six files as forbidden as D1 data and its STOP rule 5 refuses promotion of demo data without human approval, and `RD-2026-08-30-01` §7 gives four independent reasons the tracked GeoJSON is not external supply. **V1 does not need it to be** |
| **Does it need integration?** | **Yes.** A12 is a published, pinned config version carrying `{ cellId, resolution: "FINE", regionId, … }` rows. That is repository work on a payload shape `config/service.publish` already accepts and `validators.a6SpatialCellIdentity` already validates |
| **Would promoting it violate the no-fabrication rule?** | **Reusing the region *identity* — no.** It is the owner's recorded declaration. **Reusing the boundary polygon as D1 evidence — yes**, and this pass does not |
| **What is genuinely undecided** | **Which single region is V1's.** The owner declared *two*, with per-region clearance, and B1 handoff §1.8.1 records that two regions means two deployment modules. V1's S-5 binds `cutover.engine_enabled` at **one** region scope. **Nothing in the record picks one** — that is Q2 |

**The V-8 empty-cover blocker does not reach A12, and this was checked rather than assumed.**
*(Amended 2026-09-19: the res-8 premise below is historical. Since `RD-2026-09-14-01` D2 adopted
`FINE` = H3 resolution 11, the covers are non-empty — RNSIT 45 centre-contained / 64 D6 index — so
V-8 does not fire at all; the binding condition is **V-9**, discharged by the declared
`cardinalityException`, and D6 decided the containment-semantics question without an escalation
target. The conclusion of this paragraph — that none of it reaches A12 — is unchanged and now holds
for two independent reasons.)*
`polygonToCells` at res 8 returned 0 cells for a 0.10 km² campus (B1 handoff §1.8.3), and the
escalation target for the containment-semantics question was then **NOT DEFINED** (§1.8.5). That
fired `regionBoundary`'s V-8, which is reached **only** from `tools/routing/b1Readiness.js`. The config
publish path calls `v8SpatialContainment` (assignment containment) and `a6SpatialCellIdentity`
(H3 identity at the declared band) and **computes no cover** (`validators.js:969,977`). So the
governance vacuum that has D1 deadlocked is a **D1 validator and production-coverage** problem, and
**not a V1 runtime prerequisite** — which is what contract §D.3 already concluded and what this
pass re-verified against the validator source.

### 3.2 The charger — a prior answer exists, and it is "none"

The owner's 2026-08-30 declaration is explicit: *"Production chargers — **NONE currently exist**"*
at either campus, and *"no ids or locations are to be inferred from OSM, repository, demo or test
data"* (B1 handoff §1.8.1). The handoff also records the mechanical consequence: `chargers: []` is
an *answered* field with an empty value, so V-12 returns `VALID` vacuously and **a D1 PASS reached
with an empty catalogue is not evidence that a charger estate exists.**

**Is it still applicable to the current V1 contract? Partly, and the difference is the whole
question.** It is a statement about **production**. Contract §M.3 says so directly and says what
follows: it *"is exactly the decision this row now needs re-taken for a V1 environment."*

**Can it be reused?** As a statement of the production estate, yes and it stands. As an answer to
A13, **no** — A13 asks whether *one depot-class charging location* can be declared for a V1
environment, which is a narrower and different question. **Nothing may be inferred, and no
location is proposed here.** That is Q8.

### 3.3 Routing — B1's Step 2 is complete, and it is not the V1 seam

**What exists, from the B1 programme:** four executable benchmark adapters, a hardened shared
contract with a seven-value status discriminator and a four-value availability discriminator, an
operator configuration seam, a readiness tool (`npm run routing:readiness`) and a benchmark
(`npm run routing:b1`). This is real, complete work.

**What it is not.** `contract.js:12-18` states it itself: *"It is **not** `src/engine/routing/
client.js`"*, it lives outside the production require graph, and it answers **matrix** queries
rather than the `route(parts)` cell-pair shape. Contract §F.1 row C already recorded the honest
verdict — *"Partly, and not as-is … An adaptor from that layer to the `route(parts)` seam is
small — but it does not exist, and it cannot close F-2."* **This pass confirms that verdict
against the code and adds two facts to it:**

1. **The spread mechanism A3 asks for is already built.** `travelTimeSpread { source, model,
   value }` with a mandatory named source, and an adapter constructed without one does not start
   (`contract.js:368-401`, `:602`). So A3 is not *"invent a spread model"* — it is *"declare the
   model and its source into a shape that already exists and already refuses without it."*
2. **The energy rate A14 asks for is already shaped.** `profile.energyWhPerMetre`, required
   positive, per candidate (`contract.js:425-431`).

**Neither of those supplies a value, and neither is reused here.** No routing engine is selected,
ranked, recommended or hinted at by this document.

### 3.4 The register — nothing was ever supplied

Every one of the fifteen was re-read out of `src/engine/config/register/*.json` during this pass.
All fifteen carry `"default": null` and `"calibrationStatus": "UNCALIBRATED"`. No phase ever
published a value for any of them; `prisma/seed.js:169` mirrors the register into
`ParameterRegisterEntry` rows and its own comment says *"Seeding the register is NOT publishing a
configuration version."* **Nothing to reuse. Nothing was reused.**

### 3.5 The four items on no current list — how they were missed, and why that is the same defect

**N-1, N-2, N-3 and N-4 are all the same shape**, and it is a shape this programme has named
before: **`coordinatorPipeline.requirements()` is a composition-time dependency probe, and it
cannot see data inside a satisfied dependency.** Control §5.6.6 established that for A12 and A13
and stated it as a permanent property, not a fixable gap:

> *"A dependency-resolution probe cannot see an empty table or an absent snapshot field at any
> depth of walk."*

The same sentence is true of an **absent `EnergyModelParams` row** (N-1), an **unwritten column on
an existing row** (N-2), and an **unset environment variable that the harness sets for itself**
(N-3). §5.6.6 drew the boundary at two rows because two were what had been looked for.

**N-4 is different in kind:** it is not invisible to an instrument, it is a question nobody has
been asked. The checklist's own completion test already requires it (§4 item 6, *"The target
deployment is identified"*) and no record identifies one.

**Do these change S-3's count?** **This document does not move any count.** Changing the
authoritative 28 is an act for the control document and the owner request, under their own
amendment rules — not for a discovery pass. What is recorded here is that **four rows exist that
those documents do not carry**, with the evidence for each, so that the decision to carry them is
taken deliberately.

### 3.6 Discrepancies found — recorded here, corrected nowhere

**Per the instruction, `V1_OWNER_ACTION_CHECKLIST.md` was left intact. These are the six things
this pass would otherwise have changed.**

| # | Where | What it says | What this pass measured | Consequence |
|---|---|---|---|---|
| **1** | Checklist §1 row **A12**, status column | *"OPEN — unanswered"* | The **region identities are declared** (B1 handoff §1.8.1; `RD-2026-08-30-01`). What is unanswered is **which of the two is V1's**, and the publish | The row is closer to done than its status suggests, and the *question* is narrower than the row implies |
| **2** | Checklist §1 row **A13**, status column | *"OPEN — unanswered"* | It **was answered on 2026-08-30 — in the negative**, for production. Contract §M.3 calls for it to be **re-taken** for V1 | The owner should be told he is being asked again, and why, rather than asked as if for the first time |
| **3** | `RD-2026-09-05-01` §4.6 | *"Each is a `required: true` register entry with **no default**"* | **False for one of the fifteen.** `plan.service_time_prior` carries **no `required` field at all** (`supplementary.json`). Its refusal comes from `planBuilder.resolveServiceTimes`, not from the register flag | The value is still needed. The stated *reason* is wrong for that row |
| **4** | `RD-2026-09-05-01` §4.8, checklist row **A8**, **and `coordinatorPipeline.js:410`** | *"`AgentClass.totalMassLimitKg` is a limit, not a mass"* | The column is on **`ContainerModel`**, not `AgentClass` (`schema.prisma:1021`). `AgentClass` has no mass column of any kind | The argument is sound and the citation names the wrong model — **in shipped source**, which is the `EnergyModel`/`EnergyModelParams` defect family again (control §9.1.1) |
| **5** | Checklist §2, *"the six process dependencies"* | *"Supplied by the repository's own composition root (`server.js:657-722`) and **measured in the runtime `satisfied` array**"* | True of five. **`signingKey` is `process.env.COMMAND_SIGNING_KEY`, which is absent from `Backend/.env`**; the harness generated one for itself (`v1CorePath.js:353`). `server.js` supplies the **wiring**, not the **value** | **N-3.** One of the six is an operator-declared secret this deployment does not have |
| **6** | Contract §I.2, the S-3 row | *"The **four** external values **F-1…F-4**"* | The operative count is **28** (control §5.4), and §N.8 restates it — but **the canonical S-3 sentence in §I.2 was never itself restated** | A reader who stops at §I.2 gets a four-value S-3. Correcting a canonical stop-condition sentence is not a discovery pass's act |

---

## 4. Current repository evidence

**For each input: who produces it today, who consumes it, whether a column exists, whether a
configuration or fixture source exists, and — the question that matters — whether it reaches the
V1 composition root and the actual coordinator.**

**The single most important fact in this section:** `Backend/server.js:657-722` passes
`prisma`, `kv`, `io`, `values`, `snapshot`, `shardId`, `regionId`, `instanceId`,
`runInTransaction`, `runSerializable`, `selectForUpdate`, `isSerializationFailure`, `deliver`,
`signingKey`, `record`, `onError`, `logger` — **and not one input accessor.** A `grep` for
`environmentFor`, `vehicleMassKgFor`, `failureProbabilityFor`, `routeHazardCuFor`,
`batteryWearInputsFor`, `returnLegEnergyWhPerMetreFor` and `speedMetresPerSecondFor` over
`server.js` returns **nothing**. So **every supplied value will still need a wiring step**, even a
value as simple as a constant. That is §8 step 3, and it is real work rather than a formality.

| Input | Producer today | Consumer | Schema column | Config source | Fixture/test source | Reaches the composition root? | Reaches the coordinator? |
|---|---|---|---|---|---|---|---|
| `route` | **none** | `cellPairCache.read` | n/a | `ROUTING_B1_DEPLOYMENT` (benchmark layer only, unset) | benchmark adapters, `tools/` | **NO** — not passed by `server.js` | NO |
| six `route` fields | **none** | `buildEntry` + `timeline.project` | n/a | adapter normalises 3 of 6 | as above | NO | NO |
| `travelSdSeconds` | **mechanism only** (`contract.js:602`) | `buildEntry` | n/a | `travelTimeSpread` (benchmark layer) | as above | NO | NO |
| `speedMetresPerSecond` | **none** | `applyIntraCellOffset` | `MobilityModel.speedModel` — **a deferral note** | `profile.speedMetresPerSecond` (benchmark layer) | seed note only | NO | NO |
| `timeBucket` | **`timeline.hourOfWeek`** (a *service-time* bucket) | `cellPairCache.key` | `ServiceTimeModel.hourOfWeek`, `CalibrationObservation.timeBucket` | none for routing | — | NO | NO |
| 15 register values | register declares them `null` | 8 refusing functions | `ParameterRegisterEntry` mirror | **no published binding for any** | test fixtures only | snapshot **is** wired; **the values are null** | refuses by name |
| `environment.ambientC/packC` | **none** | `legProfiles` → `betaThermal` | **NO** | none | — | seam exists, unwired | NO |
| `masses.vehicleMassKg` | **none** | `legProfiles` | **NO** | none | — | seam exists, unwired | NO |
| `p_fail` | **none** (`reliability/` = `.gitkeep`) | `cRisk.evaluate` | **NO** | none | — | seam exists, unwired | NO |
| `route_hazard_cost` | **none** (`ObstacleEvent` is a different quantity) | `cRisk.evaluate` | **NO** | none | — | seam exists, unwired | NO |
| battery wear — curves | **none** | `wear.batteryWear` | **`EnergyModelParams.stressCurves`** | none | test fixture | **read path CLOSED (W-A5)** | refuses on an empty column |
| battery wear — mission | **none** | `wear.batteryWear` | **NO** | none | — | NO | NO |
| region assignment | **none published** | `serviceabilityFor` → `hierarchy.indexMap` | `CellAssignment` mirror + config `spatial` payload | `configService.publish({ spatial })`, validated by V8 + A6 | **`SEED_SPATIAL_MAP` in `prisma/seed.js:31-45`** | **read seam WRITTEN** (`coordinatorSolvePath.js:941`) | F33 `INDETERMINATE` → DENY |
| depot charger | **none** | `chargerCandidatesFor` | **`model Charger`** with `cellId`, `isDepot` | none | none | **read seam WRITTEN** (`:834`) | F34/F35 `INDETERMINATE` |
| return-leg Wh/m | **none** | `chargerReachabilityCache.buildEntry` | **NO** | `profile.energyWhPerMetre` (benchmark layer) | — | seam exists, unwired | NO |
| **fitted `EnergyModelParams`** | **none** | `consumption.legEnergyWh` | **YES — the whole model** | none | **`energyFixture.energyModelParams()`** | **loader WRITTEN** (`:308,373`) | refuses: no row exists |
| **`BatteryState.lastObservedSoc`** | **none** (`energyCalibration.worker` writes other fields) | `coordinatorSolvePath:381` → F7/F34 | **YES** | none | — | loader WRITTEN | `soc: null` → refuse |
| `cutover.engine_enabled` | register default `false` | `cutoverEnabled.forShard` | via config version | **no binding published** | harness deliberately declines | **mechanism verified live** | 503 `ENGINE_NOT_LIVE` |
| `SHARD_CONSENSUS_REPLICATION` | **none** | `election.assertConsensusStore` | n/a | **unset** | harness sets it for itself | n/a | **no leader is elected** |
| `COMMAND_SIGNING_KEY` | **none** | `server.js:718` | n/a | **absent from `.env`** | harness generates one | wired to an unset variable | — |

### 4.1 "Exists somewhere" versus "usable by V1" — the three traps this table is drawn to expose

1. **The seeded spatial map exists and cannot be used.** `SEED_SPATIAL_MAP` (`prisma/seed.js:31`)
   has exactly the right *shape* — regions, zones, sites and `RESOLUTION.FINE` cells — and its cell
   ids are opaque demo tokens (`"cell-rnsit-fine-01"`). `a6SpatialCellIdentity` refuses a token
   that is neither a valid H3 cell at the declared band nor a declared site-local graph zone
   (`validators.js:617-637`), so **the seeded map would be rejected at publish.** That is the
   validator working. **Category D, and it must not be promoted.**
2. **The benchmark adapters exist and are not the seam.** §3.3.
3. **The E-11 run's `satisfied` array is partly a fact about the harness.** `signingKey` and the
   consensus posture were supplied by `v1CorePath.js`'s own environment. On any real deployment
   both are absent, and the coordinator would not even reach leadership.

---

## 5. Owner decisions only

**This is the section that needs you. Everything above it was worked out from the repository.**

Thirteen questions. Twelve block V1; the thirteenth does not and is marked. Each is stated in
plain English, and none requires you to know an internal variable name.

---

### Question 1 — Do the robots physically exist yet?

**Are there real RobotX robots built and running today?**

Options:
- **A** — Yes, robots are built and operating
- **B** — Robots are built but not yet operating
- **C** — No hardware yet; this is software only for now
- **I don't know**

*Why this matters:* five of the outstanding items — the fleet's measured speed, the robot's own
weight, its failure rate from real breakdowns, its battery temperature readings and its measured
energy model — can only come from a real robot. If the answer is C, those items are not "late",
they are **not yet obtainable**, and that is a completely different conversation from the one the
current checklist implies.

---

### Question 2 — Which single campus is V1's operating area?

**You declared two campuses on 30 August 2026. V1 runs against exactly one.**

Options:
- **A** — RNSIT Bengaluru
- **B** — JSSATE Bengaluru
- **C** — Somewhere else
- **I don't know**

*Why this matters:* the engine denies every possible assignment until one named area is declared,
and the "turn the engine on" switch is set per area, so it cannot be set until you name one. **You
do not need to supply any map data or coordinates** — the system computes those itself from the
request. What it cannot do is choose which campus.

---

### Question 3 — Where will V1 actually run?

**Which machine and which database?**

Options:
- **A** — This laptop, using the existing cloud database it is already configured against
- **B** — A dedicated server with its own PostgreSQL database
- **C** — Not decided yet
- **I don't know**

*Why this matters:* three of the remaining items are statements *about a specific deployment* — the
engine switch, the database's failover behaviour, and a signing secret this machine does not
currently have. None of them can be recorded until the deployment has a name.

---

### Question 4 — Can that database be failed over automatically, without a person?

**About whichever database Question 3 names.**

Options:
- **A** — No. Promoting a backup requires a person to do it
- **B** — Yes. A backup can be promoted automatically if the main one fails
- **C** — It is a cluster that writes to several machines before confirming a write
- **I don't know**

*Why this matters:* the engine refuses to elect a coordinator over a database whose behaviour has
not been stated, because two coordinators running at once would be silent and serious. **A and C
allow V1 to run. B does not.** The rule is explicit that this cannot be assumed — so I have not
assumed it, and I will not pick one to make the harness proceed.

---

### Question 5 — Do you authorise turning the engine on for that area?

**Once its inputs are supplied.**

Options:
- **YES**
- **NO**

*Why this matters:* the engine is currently switched off by design, and every request gets a
polite refusal instead of an assignment. Turning it on is your act, not mine. I will not do it on
your behalf and the verification harness deliberately refuses to do it either.

---

### Question 6 — Do you have something that can answer "how far and how long from A to B" on that campus?

**A navigation/routing service you can run yourself.**

Options:
- **A** — Yes (please name it)
- **B** — No
- **I don't know**

*Why this matters:* without it, not one step of any delivery can be measured, so nothing can be
priced and nothing can be assigned. **You are not being asked to choose a vendor or sign off a
procurement** — that is explicitly out of scope for V1. You are being asked whether one exists.

---

### Question 7 — If we obtain one, do you authorise declaring it as V1's route source in a clearly-labelled non-production environment?

Options:
- **YES**
- **NO**

*Why this matters:* the project's own rules forbid me from writing a fake router to make a check
go green. They do **not** forbid you from declaring a real one for a labelled test environment —
but the contract says in terms that this *"is the owner's decision and nobody else's."* So I am
asking rather than assuming.

---

### Question 8 — Is there a charging dock for the robots at that campus?

**You said on 30 August 2026 that no chargers exist at either campus. This asks again, for a
smaller and different reason.**

Options:
- **A** — Yes, there is at least one (please say roughly where)
- **B** — No, there is none
- **I don't know**

*Why this matters:* before committing any job the engine checks that the robot could still reach a
charging point afterwards. With no charging point declared at all it cannot answer that question,
and an unanswerable safety question is treated as "no" — so **every** job is refused, even a fully
charged robot on a short trip. **If the answer is B, V1 cannot be completed as it is currently
defined**, and the only honest options are to install or declare one, or for you to change the V1
definition — which is your decision to make explicitly, not something I can quietly work around.

---

### Question 9 — Is there a safety authority on this project, and is there a second person who can co-approve?

Options:
- **A** — Yes, and there are two people who can co-sign
- **B** — Yes, but only one person
- **C** — No one but me
- **I don't know**

*Why this matters:* two of the required values are classed safety-critical, and the rules forbid
any automated process — including me — from choosing them. A separate rule requires **two
different named people** to approve the first safety configuration. If the answer is B or C, those
items cannot be closed by anyone currently on the project, and you need to know that now rather
than at the end.

---

### Question 10 — Will you supply provisional values, with your name on them, for the 13 non-safety cost settings?

**These are things like "what is a watt-hour worth" and "what does a minute late cost".**

Options:
- **A** — Yes, I will provide them and be named as their author
- **B** — No; they must be properly calibrated first
- **C** — I need help identifying who should own these

*Why this matters:* V1 explicitly does **not** require these to be properly calibrated — a stated
provisional value with a named author is enough. It does require them to exist, because each one
is a separate refusal inside the pricing code. This is the single largest group of outstanding
items and it may be the easiest to close.

---

### Question 11 — Do you have the robot's own weight in kilograms, from its specification?

**Its empty weight — not what it can carry.**

Options:
- **YES**
- **NO**
- **I don't know**

*Why this matters:* the energy calculation needs the vehicle's own mass. The database records what
the robot's container is *allowed to carry*, which is a different number, and using a carrying
limit as a weight would misstate the energy of every option by the same amount — an error that
looks cautious and is simply wrong.

---

### Question 12 — Should time-of-day for routing use the convention this system already uses elsewhere?

**That convention is: the hour of the week, 0 to 167, with Sunday 00:00 local time as hour 0.**

Options:
- **A** — Yes, use that
- **B** — No, use something else (please say what)
- **I don't know**

*Why this matters:* travel times are cached per time-of-day so that a quiet-Sunday estimate is
never reused at Monday rush hour. The system already has exactly this convention implemented and
in use for service-time estimates. Reusing it invents nothing. Whether it is the right bucket
depends on how the routing service in Question 6 is actually asked, which is why it is your call
and not mine.

---

### Question 13 — MaxTicks = 3 *(does not block V1)*

**A formal-verification model was checked with a budget of 3 clock ticks. Someone has to sign that
this budget was adequate — or decline to.**

Options:
- **A** — Sign it
- **B** — Decline it
- **C** — Leave it open for now

*Why this matters:* it changes nothing that runs. It is listed only because it is a genuine
outstanding decision and you should not be asked for it twice. **V1 can be declared complete with
this outstanding**, and answering it closes no V1 condition either way.

---

## 6. External information still required

**These are not questions for you personally. They are things that must come from a party, an
instrument or a supplier, and no project document says you are the source.** They are listed so
the boundary is complete, not so you can answer them.

| # | Information needed | Why V1 needs it | Legitimate source / authority | V1-critical? | Does an existing artefact partly satisfy it? |
|---|---|---|---|---|---|
| **X1** | A deployed, self-hosted traversal engine answering for the chosen campus | Nothing is priced without traversal | Whoever hosts and operates it | **YES** | **Partly.** Four executable adapters and an operator configuration seam already exist (`tools/routing/adapters/`). **No engine is deployed and no `b1Deployment.js` exists** |
| **X2** | A declared travel-time spread model, with its source named | §8.4 prices lateness from a distribution; a silent zero asserts a certain arrival | Whoever declares the routing source | **YES** | **YES — the shape.** `travelTimeSpread { source, model, value }` is implemented and refuses without a named source (`contract.js:368-401`) |
| **X3** | A measured per-profile fleet speed | The intra-cell travel correction refuses without it | Fleet Engineering (D3) | **YES** | **No.** `MobilityModel.speedModel` is a deferral note; `maxSpeedMps` is a limit, not a profile speed |
| **X4** | The 13 non-Safety calibration values | Eight separate refusals in pricing and plan building | The §22.4 calibration owner | **YES** | **No.** All declared `null`/`UNCALIBRATED` |
| **X5** | `energy.model_residual_cv` and `energy.reserve_floor_wh` | Energy uncertainty and the reserve floor | **Safety only.** §22.3 forbids an automated choice | **YES** | **No, and none may be proposed** |
| **X6** | Two named approvers for the first safety configuration publish | §22.3's two-person rule | **Safety** | **YES** (narrow — one V9/S2 decision) | **No.** Note the recorded scope correction: this is **not** the technical unblock for S-5 or S-6 |
| **X7** | Ambient and pack temperature, from a named telemetry or forecast source | The thermal term of the consumption model | Engineering + a telemetry/forecast provider | **YES** | **No column, no producer.** `Telemetry` carries `lat/lon/speed/battery` only |
| **X8** | The vehicle's own mass per agent class | Energy of every leg | Fleet specifications | **YES** | **No.** All four mass columns are loads or limits |
| **X9** | A per-agent failure probability, from a reliability model plus **realised failure data** | Nothing is priced at all without it | Engineering | **YES** | **No.** `src/engine/reliability/` is an empty `.gitkeep`. **Realised failure data requires an operating fleet — see Q1** |
| **X10** | A per-route hazard cost, from the Map service | The hazard term of risk pricing | Engineering + the Map service (§5.2) | **YES** | **Partly, and not as the same quantity.** A live obstacle-reporting substrate exists (`ObstacleEvent`, `dtaro.handler.js`) — it reports obstacles; it does not price routes |
| **X11** | The pack manufacturer's cycle-life-versus-DoD characterisation | §14.4 battery wear | The pack manufacturer, via Engineering | **YES** | **YES — the column.** `EnergyModelParams.stressCurves`, and the repository now reads it (W-A5). **The row that column lives on does not exist — see X12** |
| **X12** ⚠ | **The fitted energy model itself** — the nine β coefficients and the ambient/pack thermal curves | `legEnergyWh` refuses without every one of them, before it ever reaches temperature or mass | Engineering — a fitted `EnergyModelParams` row per agent class | **YES** | **Only as a test fixture**, which cannot be promoted. **On no current V1 list — this pass's finding N-1** |
| **X13** | The per-profile return-leg energy rate | The charging-reachability check | Fleet/Engineering, with the charger declaration | **YES** | **YES — the shape.** `profile.energyWhPerMetre` (`contract.js:425-431`) |
| **X14** | A signing secret for the target deployment | Every dispatched command is signed | The operator of whichever deployment Q3 names | **YES** for a real end-to-end request | **No.** Absent from `.env`; the harness generates its own — this pass's finding N-3 |

---

## 7. Things that are NOT required for V1

**Using the current canonical boundary — contract §G, control §11.E and §12, `RD-2026-09-05-01`
§8. Nothing is added to this list and nothing is removed from it.**

Do not collect, commission, decide, or start any of these to close V1:

- A routing-engine **procurement decision or selection ADR** (B1 Steps 1/3/4/5). **V1 needs a
  declared source, not a vendor.**
- The **full D1 governance package**: the signed boundary polygon, the CRS attestation, the full
  campus H3 cover, the charger **estate**, governance sign-off, and the containment-semantics
  escalation whose target is undefined. **§D.3 and §M.2 establish that V1's runtime needs the
  minimal cell assignment, not the cover** — and §3.1 of this document re-verified that against
  the validator source.
- **D8** in full — extract identity, vintage, refresh cadence, re-contraction budget.
- The **39 Safety-class B8 parameters** beyond D-1's single V9/S2 decision.
- **Production calibration** of `plan.service_time_prior`. A declared provisional value with a
  named author is enough for V1. **`energy.model_residual_cv` is the exception.**
- `candidate.max_radius_by_sla_class` — satisfied by §6.3's wall-clock disjunction, still owed by
  Operations, **not a V1 blocker**. Confirmed again this pass: it is in the composer's `satisfied`
  array.
- **B-P** — soak, shadow window, simulator fidelity, `invariants_enforced`, `shadow_agreement`.
- **B-O** — `safety_case_assembled`, `rollback_rehearsed`.
- **B-M / TLC** beyond §G.1's V1 subset; boundedness sign-off beyond D-6; the §7.6 acceptance.
- **Phase 15 §24 closure** and re-collecting `release-evidence.json`. **Phase 15 is FROZEN.**
- **Chaining / Tier-2**, **Phase 16**, and every module on §11.E's do-not-create list —
  `stores/roles.js`, `deps/registry.js`, `circuitBreaker.js`, `routing/client.js`, `A9`,
  `preemption.js`, `setPartitioning.js`, `branchAndBound.js`, `localSearch.js`.
- **X3 (the specification's missing `TASK` transition table)** — recorded at contract §G.2 as
  V1-EXTERNAL-INPUT (specification), **non-blocking**.

**And one addition to how this list is read, not to the list itself:** the four items this pass
found (N-1…N-4) are **not** scope creep and are **not** V2. Each is required by code already on
the V1 core path, each has its consumer cited in §2, and none of them creates a module, a gate or
a condition. Recording them is the opposite of widening scope — it is refusing to declare a
boundary complete while knowing it is not.

---

## 8. Proposed order of operations

**Nothing below was started by this pass.** This is the minimum sequence, and the ordering is
load-bearing: several steps are wasted work if taken before the one above them.

### Step 1 — You answer §9's questionnaire
Thirteen answers. **Q1, Q2 and Q3 are the ones that unlock the most**: Q1 tells us whether five
items are obtainable at all, Q2 unblocks the region and the engine switch, and Q3 gives the
other deployment-scoped items something to attach to. Nothing else in this list can start first.

### Step 2 — External information is obtained
§6's X1…X14, from their own parties. Some are quick (X4's provisional values with a named author).
Some are not (X1 needs an engine deployed; X9 needs realised failure data, which needs an operating
fleet). **Q1's answer determines which of these are even possible now**, and that is why it is
first.

### Step 3 — Claude integrates, at the seams the documents already name
Only after the values exist:
- the declared traversal source at `leaderWorkers.create({ route })`, with the adaptor §3.3
  describes, reusing the existing `travelTimeSpread` shape;
- the per-profile speed, environment, mass, `p_fail`, hazard cost, battery-wear and return-leg
  accessors that `coordinatorPipeline` already declares — **all of which need wiring into
  `server.js`, which currently passes none of them** (§4);
- one published, pinned config version carrying the 15 register bindings **and** the derived
  fine-cell assignments for the region Q2 names;
- the `Charger` row, if Q8 says one exists.

**Within §17's do-not-touch rules, and creating no module on §11.E's list.**

### Step 4 — Re-measure, do not re-argue
Re-run `node tools/verify/v1CorePath.js` and drive the live `N of 34 inputs unresolved` numerator
down from **26**, recording each measurement and the tree it was taken at. **A12, A13, N-1, N-2 and
N-3 will never appear in that number** — they are invisible to a dependency probe by construction
(§3.5). Their closure is the pinned config version, the `Charger` row, the `EnergyModelParams` row,
a written SoC, the declared secret, and the F33/F34/F35 outcomes on a real request.

### Step 5 — Real V1 end-to-end
`node tools/verify/v1CorePath.js` against a live PostgreSQL, expecting a durable `Commitment` **and**
an `Outbox` row in one transaction, a `Round` row and a per-Leg decision record. **Two integration
notes for whoever runs it, recorded here so they are not discovered as surprises:** the harness
currently seeds its agent at 12.9716, 77.5946 — central Bengaluru, roughly 10 km from either
campus — so the region Q2 names and the fixture's coordinates must be reconciled; and the harness
supplies its own signing key and consensus posture, which a real deployment must supply for itself.

### Step 6 — Final S-1…S-8 closure at one tree
S-4 by `npm run gates` exit 0 with `gate:composition` at 0 violations; S-5 by
`cutoverEnabled.describe(...)` reporting `live: true`; S-6 by the harness exiting 0; S-7 by both
commands at one tree; and **S-1, S-2 and S-8 re-verified at the closing tree** — a condition met at
one tree is not met at another.

---

## 9. Final owner questionnaire

**Answer these and nothing else. Everything not on this page was worked out from the repository.**

---

**Q1. Do the robots physically exist yet?**
- [ ] A — Yes, built and operating
- [ ] B — Built, not operating
- [ ] C — No hardware yet; software only
- [ ] I don't know

**Q2. Which single campus is V1's operating area?**
- [ ] A — RNSIT Bengaluru
- [ ] B — JSSATE Bengaluru
- [ ] C — Somewhere else: ______________
- [ ] I don't know

**Q3. Where will V1 actually run?**
- [ ] A — This laptop, with the cloud database it already points at
- [ ] B — A dedicated server with its own PostgreSQL
- [ ] C — Not decided yet
- [ ] I don't know

**Q4. Can that database be failed over to a backup automatically, without a person?**
- [ ] A — No, a person must do it
- [ ] B — Yes, automatically
- [ ] C — It is a cluster that confirms writes on several machines
- [ ] I don't know

**Q5. Do you authorise turning the engine on for that area, once its inputs are supplied?**
- [ ] YES
- [ ] NO

**Q6. Do you have a navigation/routing service you can run yourself for that campus?**
- [ ] A — Yes: ______________
- [ ] B — No
- [ ] I don't know

**Q7. Do you authorise declaring such a source for a clearly-labelled non-production V1 environment?**
- [ ] YES
- [ ] NO

**Q8. Is there a charging dock for the robots at that campus?**
- [ ] A — Yes, at least one: ______________
- [ ] B — No, there is none
- [ ] I don't know

**Q9. Is there a safety authority, and a second person who can co-approve?**
- [ ] A — Yes, two people can co-sign
- [ ] B — Yes, but only one person
- [ ] C — No one but me
- [ ] I don't know

**Q10. Will you supply provisional values, named as their author, for the 13 non-safety cost settings?**
- [ ] A — Yes
- [ ] B — No; they must be properly calibrated first
- [ ] C — I need help identifying who should own these

**Q11. Do you have the robot's own empty weight in kilograms, from its specification?**
- [ ] YES
- [ ] NO
- [ ] I don't know

**Q12. Should routing's time-of-day use the existing hour-of-week convention (0–167, Sunday 00:00 local)?**
- [ ] A — Yes
- [ ] B — No, use: ______________
- [ ] I don't know

**Q13. MaxTicks = 3 formal-verification budget — *does not block V1*.**
- [ ] A — Sign it
- [ ] B — Decline it
- [ ] C — Leave it open

---

---

## 10. Verification of this pass

**Everything asserted in this document was checked against the tree, the schema, the register, the
tests or a command output. The two commands below were re-run during this pass rather than quoted.**

### 10.1 Commands run

| Command | Result | Where it is used above |
|---|---|---|
| `npm test` (from `Backend/`) | **exit 0** — **167 suites / 7 429 tests / 0 failures / 0 skips**, 326 s, 5 projects | §1.1. Matches the checklist's figure exactly |
| `npm run gates` (from `Backend/`) | **7 PASS, 1 FAIL.** `gate:tiers`, `gate:params`, `gate:tenets` (289 modules), `gate:privacy` (16 modules), `gate:erasure` (3 decisions), `gate:legacy` (4 retired modules, 350 files), `gate:columngen` (NOT_REQUIRED) pass; **`gate:composition` FAILS** with 1 violation across 19 workers — `coordinator`, `LEADER_ONLY_NOT_COMPOSABLE` — printing a `requires` list of exactly **34** rows | §1.1, and the 34-row contract in §2 |

**The 34 printed rows were counted rather than assumed:** 5 routing + `candidate.max_radius_by_sla_class`
+ 15 register + 6 no-producer + 6 process + 1 Ω = 34. This reproduces control §5.6's decomposition
from the gate's own output.

**No database was contacted, no server was started, and the S-6 harness was not run.** Those need a
disposable PostgreSQL and would produce a measurement, not a discovery.

### 10.2 What was searched

Repository root and `docs/` (Phase 0–15 reports, `docs/phase15/*` including `archive/`,
`docs/adr/`, `docs/history/`, `docs/runbooks/`, `docs/safety-case/`), all four
`docs/release-decisions/` records, the three current `docs/v1/` documents, `prisma/schema.prisma`
(all 4 028 lines / 74 models scanned for the relevant columns), all 28 migration directories,
`prisma/seed.js` and `seed-pin.js`, all five `src/engine/config/register/*.json` (250 entries,
scanned programmatically), `Backend/src/` (engine, workers, services, controllers, sockets),
`Backend/tools/` (routing adapters, gates, verify harnesses), `Backend/tests/` fixtures,
`Backend/.env`, and `formal/`.

### 10.3 Claims verified rather than accepted

| Claim | How it was verified |
|---|---|
| *"`src/engine/reliability/` holds only a `.gitkeep`"* | Directory listing — one 0-byte file, dated 2026-07-28 |
| *"No mass column exists"* | `grep` over the schema for `massKg`/`MassKg`; four hits, every one a load or a limit |
| *"No temperature column exists"* | `Telemetry` read in full — `lat, lon, speed, battery` |
| *"All fifteen register values are null and UNCALIBRATED"* | All five register JSONs parsed programmatically; all fifteen printed with their flags |
| *"Only two of the fifteen are Safety-class"* | Every `changeClass: SAFETY` entry in the register enumerated — 55 rows, of which exactly two are among the fifteen |
| *"No `Charger` row is seeded"* | `grep` over both seed files — no hit |
| *"`server.js` wires no input accessor"* | `grep` for all seven accessor names over `server.js` — no hit; `leaderWorkers.create({...})` read in full |
| *"The seeded spatial map cannot be published"* | `validators.a6SpatialCellIdentity` read in full; it refuses a token that is neither valid H3 at the band nor a declared site-local graph zone |
| *"V-8 does not reach the config publish path"* | `validators.js:969,977` — the publish path calls `v8SpatialContainment` and `a6SpatialCellIdentity` and computes no cover |
| *"The benchmark adapters produce three of the six fields"* | `contract.js` normalisation read in full — `distanceM`, `travelSeconds`, `travelSdSeconds`; no terrain field anywhere in the directory |
| *"An hour-of-week convention is already implemented"* | `plan/timeline.js:131`, `schema.prisma:2827` and `:2317` read directly |
| *"No `EnergyModelParams` row exists outside a test fixture"* | `seed.js` read in full; `coordinatorSolvePathComposition.test.js:161-173` read; `consumption.legEnergyWh` read for what it requires |
| *"Nothing writes `BatteryState.lastObservedSoc`"* | `grep` for `batteryState` over `src/` — three hits, two reads and one `upsert` that writes `kappa`, `socThroughput` and `cycleCount` only |
| *"`COMMAND_SIGNING_KEY` is unset"* | `grep` over `Backend/.env` — no hit; `v1CorePath.js:353` generates one |
| *"`ENGINE_ENABLED=false`"* | `Backend/.env:17` |
| *"`MaxTicks = 3`"* | `formal/lifecycle_c1.cfg:20` |

### 10.4 Every "missing" and "already exists" claim is cited

**No claim of absence in this document rests on a document sentence alone.** Each was re-tested
against the schema, the register or `src/` during this pass, and §2 carries the citation. Where a
document's sentence and the code disagreed, the disagreement is recorded in §3.6 and **the code
governs**.

### 10.5 No fabricated value was introduced

Searched this file for a proposed value: **none exists.** No router, region, charger, coordinate,
terrain figure, calibration constant, temperature, mass, failure probability, hazard cost,
battery-wear quantity, energy rate, consensus posture or Safety value is proposed, defaulted,
illustrated or suggested anywhere in it. Where a *shape* or an *already-implemented convention* is
named, it is read out of the code that defines it and cited by file and line.

### 10.6 What this pass changed on disk

**Exactly one file: this one.** `git status` before and after is otherwise identical — the eight
modified files and the four untracked files of the repository-only pass, unchanged. **No source,
no test, no configuration, no schema, no migration, no formal model, no gate, no register entry,
no stop condition, no existing document.** Nothing was committed.

---

> **This document closed no stop condition and changed no count. The score is 3 of 8, exactly as
> before.**
>
> **TRUTH > GREEN.**

---

## 11. Owner Answer Reconciliation

**Added 2026-09-05, same tree (HEAD `4e2155a` + the uncommitted repository-only pass). This section
applies the owner's answers to §9 and records what they do and do not close. It is a reconciliation,
not a second audit: §§1–10 above are not restated and not revised.**

**What this section changed on disk: this file only.** No source, test, schema, migration, register
entry, formal model, gate, contract, stop condition, or S-1…S-8 definition was touched. No value was
invented. No routing vendor was selected. No charger was created. No Safety value was proposed.

---

### 11.1 Answers received

| Q | Question, in brief | Owner's answer |
|---|---|---|
| **Q1** | Do the robots physically exist? | **C — no RobotX hardware yet; software-only** |
| **Q2** | Which single campus is V1's? | **BOTH** — RNSIT Bengaluru *and* JSSATE Bengaluru. Café/IT/Library zoning is explicitly future refinement, not now |
| **Q3** | Where will V1 run? | **Not deployed.** A local development/database environment exists |
| **Q4** | Automatic database failover? | **Don't know** — deployment-specific, and there is no deployment |
| **Q5** | Authorise turning the engine on? | **YES**, once the required inputs and region binding exist |
| **Q6** | A routing service you can run? | **Don't know.** New lead: earlier frontend phases had task → assignment → simulation → route on the Mapbox map |
| **Q7** | Declare a found source for a labelled non-production V1 environment? | **YES** |
| **Q8** | A charging dock? | **NO** — none physical or declared |
| **Q9** | Safety authority with a second co-approver? | **NO** — owner is alone (equivalent to §9's option C) |
| **Q10** | Supply provisional values for the 13 non-Safety settings, named as author? | **YES** |
| **Q11** | Robot's own mass? | Obtainable later, by weighing or specification. **No robot exists yet** |
| **Q12** | Use the existing hour-of-week convention? | **YES** — 0–167, Sunday 00:00 local = 0 |
| **Q13** | MaxTicks = 3? | **Conditional:** *"If it is simple/low-risk, accept it. Otherwise leave it for later."* |

**Q2 is the only answer that does not fit the shape of its question.** §9's Q2 asked for one campus
and offered A/B/C. The owner answered "both". That is not treated here as an invalid answer — it is
treated as the requirement, and §11.3 tests the *contract* against it rather than trimming the answer
to fit the form.

---

### 11.2 Routing historical investigation

**The lead is real. The old flow existed, most of it is gone, and the part that survives is a live
call to a metered third-party HTTP API — which is the one thing F-1 names as unacceptable.**

#### 11.2.1 What the old flow actually was

Reconstructed from `docs/history/legacy-assignment-engine-audit.md` §1.3/§2.1 and re-verified against
the current tree file by file:

```
POST /api/tasks/assign
  -> task.service.assignTask              validation, PENDING create, reservation loop
  -> taskAssignment.service               candidate query, Mapbox MATRIX batching, argmin
  -> robotValidator.service               hard constraints
  -> costEvaluator.service                normalisation + weighted sum (w1..w4)
  -> task.service._finalizeAssignment     bind + dispatch transaction
  -> mapbox.service.directionsWithDistance    ROUTE GEOMETRY, per segment
  -> seedTaskKeys                         Redis `taskPath:{taskId}` = { toPickup, toDrop, pickup, drop }
  -> commandDispatcher TASK_ASSIGN        -> simulation/VirtualRobot.js walks the path
  -> socket TASK_ASSIGNED                 -> Frontend draws the polyline on Mapbox GL
```

#### 11.2.2 The nine questions, answered exactly

| # | Question | Finding |
|---|---|---|
| **1** | **What did it do?** | Two distinct things, and they must not be conflated. **(a) Selection:** `matrixDurationsToDestination` called the **Mapbox Matrix API** with `annotations=duration` for robot→pickup durations, one input of a weighted sum (`w4 = 0.05`). **(b) Route geometry:** `directionsWithDistance` called the **Mapbox Directions API v5** (`geometries=geojson`, `overview=full`, `steps=false`) and returned `{ points[], distanceMeters, durationSec }`, tried over profiles `driving → walking → cycling` in order |
| **2** | **Did it actually calculate routes, or merely display them?** | **It genuinely obtained real routes — but it did not calculate them.** The calculation happened on Mapbox's servers; this repository issued an HTTP request and parsed the answer. Two things in the tree *do* compute locally, and neither is a router: `routing.service.astar` (`routing.service.js:34-97`) is A\* **over the waypoint array Mapbox already returned** — a k=6 nearest-neighbour re-ordering of an existing polyline for obstacle avoidance, not a graph search over a campus network; and `Frontend/.../operational/routeGeometry.js` projects a live robot position onto a polyline the browser already holds (`projectOntoPath`), which its own header states is arithmetic that "asks the backend for nothing" |
| **3** | **What data source?** | **Mapbox's own hosted global road/path network**, reached at `api.mapbox.com`. Not a campus graph, not OSM held in this repository, not a local extract. A `MAPBOX_TOKEN` **is present in `Backend/.env`**, so the path is not merely coded, it is credentialed |
| **4** | **Does it still exist?** | **Partly — and the halves matter.** **Gone from the build** (verified by directory listing and by `node tools/gates/checkLegacyRetirement.js`, which PASSES over 4 retired modules / 350 files): `taskAssignment.service.js`, `costEvaluator.service.js`, `robotValidator.service.js`, `taskRecovery.service.js`, and inside `task.service.js` the symbols `_processAssignment`, `_finalizeAssignment`, `legacyDetachedAssignment`, `seedTaskKeys`, `getRoutesWithDistance`, `pathDistanceMeters`. **Still present:** `src/services/mapbox.service.js` (155 lines, all three exports), `src/services/routing.service.js` (A\* + `replanRoute` + `rerouteRobot`), `task.service.rerouteTask`, `straightLineRoute`, `simulation/VirtualRobot.js`, and the whole frontend map/route-rendering feature |
| **5** | **Is it still reachable?** | **YES — two live entry points, both traced.** (a) `POST /api/tasks/:taskId/reroute` → `tasks.routes.js:62` → `tasks.controller.js:317` → `task.service.rerouteTask:635` → `directionsWithDistance:672`. (b) `alertDissemination.service.js:21` → `routing.rerouteRobot` → `replanRoute` → `directionsPolyline`. `task.service.js:20-26` states this is deliberate: rerouting an in-flight legacy `Task` "is not the assignment path — it is an operator action on work already committed", retired "**after cutover**", not at it. **What is *not* reachable is any assignment decision** — `assignTask` now validates, creates the row and admits to a round, and returns 503 when the engine is not live |
| **6** | **Can it legally be reused under the current V1 contract?** | **NO, not as the F-1 traversal source.** F-1 requires *"one declared, real, **self-hosted** source"*. Mapbox is a metered third-party SaaS on the hot path. This is not a new judgement invented here — it is the recorded position of three prior artefacts, re-verified: `IMPLEMENTATION_EXECUTION_PLAN.md:1464` lists **F6** as *"Mapbox external metered API on the hot path, with a straight-line fallback"* against a required *"**Self-hosted** routing with precomputed hierarchies"*, notes the specification calls a metered per-request API **"architecturally incompatible"**, and marks `mapbox.service.js` **R (retire)** for the hot path (`:163`, `:240`); `PHASE_15_CONSOLIDATED_REMEDIATION_REPORT.md` §30.2 row 9 classifies it **OBSOLETE**; and `PHASE_15_B1_ROUTING_DECISION_REPORT.md:272` had already examined `routing.service.js` specifically and called it *"the exact F6 anti-pattern §5.2 calls architecturally incompatible"*. **The lead was worth chasing and it does not clear F-1** |
| **7** | **Is an adaptor required?** | **Yes, and an adaptor is not sufficient** — the shortfall is data, not shape. The V1 seam is `route({ originCell, destCell, profileKey, timeBucket })` → **six** fields (§F.2). Mapbox supplies **two** of them: `route.distance` → `distanceM`, `route.duration` → `travelSeconds`. It supplies **none** of `travelSdSeconds` (F-2 — a single Directions call returns one ETA, not a distribution), `climbM`, `descentM`, or `stopStartCycles` (F-6). It is also keyed by **lat/lon pairs**, not H3 cells, and knows nothing of a `timeBucket`. So an adaptor closes the calling convention and leaves 4 of 6 fields unproduced |
| **8** | **Is it demo/test data only?** | **The Mapbox call is real, and it has a fabricating fallback that V1 must not inherit.** `routing.planRoute` returns `[from, to]` on any failure (`routing.service.js:114`) and `rerouteTask` falls back to `straightLineRoute({ … points: 100 })` (`task.service.js:682`), logging a warning. Under the legacy path a straight line was a degraded display; **on the V1 decision path it would be an invented traversal presented as a measured one**, which is precisely what S-1 exists to forbid. `Backend/tests/setup/env.js:5` deliberately unsets the token so tests fail fast rather than hitting the network |
| **9** | **Would using it violate a frozen Phase 15 / V1 rule?** | **Reading and describing it — no, and that is what this pass did.** **Wiring it to `leaderWorkers.create({ route })` — yes, three ways.** (i) F-1's *self-hosted* requirement, above. (ii) `PHASE_15_MASTER.md` §10's forbidden-actions table bars a router written to make `gate:composition` pass; contract §F.1 row F permits *"a **real, declared, owner-supplied** source in a **declared non-production environment**"* — Mapbox is real and could be declared, so **row F does not by itself bar it; F-1's self-hosted clause does**. (iii) The straight-line fallback would have to be removed, not merely disabled, before any such source could be declared. **Nothing was wired in this pass** |

#### 11.2.3 What the old system genuinely leaves behind that is still useful

Recorded so it is neither lost nor overclaimed. **None of these is a V1 input and none is reused here.**

- **An anticorruption boundary that already exists.** `mapbox.service.js` exposes
  `{ points, distanceMeters, durationSec }`, not Mapbox response shapes.
  `docs/history/legacy-architecture-proposal.md:623` records the consequence: *"the swap is genuinely
  a swap."* If a self-hosted engine is ever obtained, this is the shape the two-of-six mapping is
  already written against.
- **`VirtualRobot.js` is not a router and is still the agent-protocol conformance fixture** (§10.3.1,
  §11.5, §23.3). It executes an assigned path; it does not produce one. It cannot answer any part of
  F-1, and Q1's "no hardware" answer does **not** make it a substitute for a fleet measurement.
- **A live obstacle substrate**, already recorded at §2 row A10: `ObstacleEvent` +
  `dtaro.handler.js`. It reports obstacles; it does not price routes. Unchanged by this pass.
- **The frontend is a renderer, and only a renderer.** The only browser-side `api.mapbox.com` calls
  are `LocationCombobox.jsx` (Search/geocoding — address lookup, not routing) and Mapbox GL tiles.
  **No frontend code requests directions.** So "the map drew the route" is display of a
  backend-obtained polyline, and the Q6 lead resolves entirely to `mapbox.service.js`.

---

### 11.3 Both-campus V1 scope

**Verdict: YES — the current contract supports both campuses, and no contract change is needed. What
it does not do is make two campuses cost the same as one.**

#### 11.3.1 The exact existing mechanism

Verified in code, not inferred from prose:

| Layer | Evidence | Multi-region? |
|---|---|---|
| **The cutover switch** | `cutover.engine_enabled` declares `"scopes": ["global", "region"]`, `"blastRadius": "region"`, `specScope: "shard"` (`register/supplementary.json`). Its own description states the purpose: *"a process-scoped environment variable cannot express 'shard A is live and shard B is not'"* | **Yes — this is what it is for** |
| **Resolution** | `cutover/enabled.js:30-38` — resolved at `region` scope, §22.2's alias for a shard, *"one shard owns one operating region (§3.5)"*. `forShard` is a pure function of (snapshot, shard, process flag) | **Yes — per shard, per region** |
| **The spatial payload** | `spatial/hierarchy.js:60,190,336` takes `{ regions?: [], zones?: [], sites?: [], cells?: [] }` — `regions` is an **array**, iterated. `:222` refuses a *zone* spanning two regions, which is a constraint on zones, not a limit on region count | **Yes** |
| **The frontend** | `Frontend/src/features/maps/campus/campusRegistry.js` with `CAMPUS_REGISTRY`, and `__architecture__/campusMultiCampus.test.mjs`, whose header states *"A second campus is not a feature. It is a MEASUREMENT"* and guards against a second implementation, RNSIT drift, geometry surviving a switch, and provenance leakage. Both `RNSIT_CAMPUS_OSM` and `JSSATE_BENGALURU_CAMPUS_OSM` datasets exist | **Yes — already built and tested** |
| **The owner's own prior act** | Two region identities were declared on 2026-08-30 with `kind: CAMPUS`, `crs: OGC:CRS84`, `version`, `versionDate` — `rnsit-bengaluru` and `jssate-bengaluru` (B1 handoff §1.8.1; `RD-2026-08-30-01` §1) | **Two already declared** |

**So the "one declared operating region" language in the contract is not an architectural ceiling.**
Re-read against the code, F-5 (*"A staged operating region"*) and S-5 (*"A config version binding
`cutover.engine_enabled = true` at region scope is published and pinned"*) describe **the unit of
staging**, not a fleet-wide maximum. §1.2's rule is *"No partial cutover … **per shard**, with
rollback"* — a rule that is meaningless unless more than one shard can exist. Two campuses are two
regions, two shards, and two bindings, staged one at a time. **Nothing in §I.2 forbids the second.**

#### 11.3.2 What remains to bind — and the honest cost of "both"

**Per campus, not once:**

1. **A published, pinned config version** carrying `{ cellId, resolution: "FINE", regionId, … }`
   assignment rows for the fine cells that campus's requests actually touch (§M.2's minimum region
   contract), plus its `regions[]`/`zones[]`/`sites[]` rows. Cell ids are **derived**, not
   owner-supplied — `spatial/cells.cellForPoint(lat, lon, FINE)` is pure H3 at **resolution 11**
   (ADR-35; amended 2026-09-19, this read "resolution 8").
2. **A `Shard` row** with `state: ACTIVE` bound to that `regionId`.
3. **`cutover.engine_enabled = true` at that region's scope.**
4. **A charger** — see §11.4. F35 is evaluated per candidate per round, so **each region needs at
   least one depot-class charging location of its own**; a charger at RNSIT does not make JSSATE's
   missions feasible.
5. **A traversal source that answers for that campus's geography.**

**Shared across both, supplied once:** the register values, the fitted `EnergyModelParams`, mass,
`p_fail`, temperatures, the spread model and the return-leg rate. None of these is per-region.

**Two facts the owner should have before choosing "both" over "one then the other":**

- **The S-6 harness is single-region by construction.** `tools/verify/v1CorePath.js:119-125` creates
  exactly **one** `Region` and one `Shard` per run. Two campuses means **two harness runs**, or a
  harness change. It is not a change this pass made, and it is repository work, not owner input.
- **B1 handoff §1.8.1 records that two regions means two deployment modules.** That is a D1/production
  statement, not a V1 one — but it is the same doubling.

**Recommendation, stated as a recommendation and not as a decision:** nothing in the contract blocks
both, and the cheapest honest path is to **declare both regions and stage them one at a time**, since
S-5 is a per-region act and the second costs one config version and one charger declaration. **This
is not a decision this pass may take** — it is the narrowed form of Q2, re-asked as **RQ-1** in
§11.10.

**No contract condition prevents the owner's answer. Nothing was modified.**

---

### 11.4 Charger consequence

**Plainly: with no charger declared for a region, V1 cannot be completed for that region — S-6 is
unreachable, and no amount of repository work changes that.**

The mechanism is §M.3, re-verified against `f35.js` and `eReturn.evaluate` during this pass:

```
chargerCandidates = []
  -> eReturn: chosen = null, verdict.reachable = false, eReturnWh = null
  -> returnLayerWh: ok = false
  -> reserves.compose({ returnWh: undefined })  REFUSES
        (§14.5: a zero return reserve is "a reachability question nobody answered")
  -> composed.ok = false -> tiers.ok = false -> energyFragment = null
  -> plan.energy = null
  -> F34 INDETERMINATE ("the plan's energy projection is unreadable")
     F35 INDETERMINATE ("the plan's energy projection is absent")
  -> class I, policy DENY  ->  EVERY candidate denied, for EVERY Leg, at EVERY state of charge
```

**Four consequences, stated exactly:**

1. **It is not a charging failure — it is an absent energy projection.** The denial arrives at F34
   and F35 as *"the plan's energy projection is absent"*, so a reader debugging it will not find a
   charging error message. A fully-charged robot on a 50-metre trip is refused identically.
2. **It is required for every mission, not only when reserves demand a charge.** §F.0's *"empty is
   survivable"* and §K.3's *"do not ask for the charger estate"* were **already SUPERSEDED** by §M.3
   before this pass. This reconciliation does not reopen that; it confirms the owner's NO lands on
   the superseding text.
3. **S-6 is the condition that fails.** S-1, S-2, S-8 are unaffected. S-3 is unaffected (a charger is
   not a register value). S-4 is unaffected (`gate:composition` is a dependency probe and, per §3.5,
   cannot see an empty table). **S-6 — "one real request … reaches a durable `Commitment` row" —
   cannot pass.** S-7 then cannot be reported at a closing tree with S-6 open.
4. **The minimum is one, and it must be `isDepot: true`.** With no availability projection the basis
   is `DEPOT_ONLY` and only depot-class candidates are admissible (§M.3). The contract per candidate
   is `{ chargerId, energyWh, travelSeconds, isDepot }`.

**What this pass did not do.** No charger was created. No `Charger` row was seeded. No location,
power rating or capability is proposed anywhere in this section. No F35 weakening, no
`uncalibrated_reserve_factor` adjustment, no contract edit. The owner's instruction *"if this makes
current V1 completion impossible, state that plainly"* is answered above, and the three honest
options remain exactly what §9's Q8 said they were: **install or declare one**, or **the owner
explicitly changes the V1 definition** — which is the owner's act, in a decision record, not a
quiet workaround. **RQ-2** in §11.10.

**One thing that is genuinely narrower than it sounds, recorded because it sharpens the question.**
F35 needs a *declared depot-class charging location with the energy and time to reach it* — it is a
**feasibility reserve, not a booking** (§14.7): a `SATISFIED` asserts a viable destination exists,
never that one is held. For a labelled non-production V1 engineering environment, the question
*"is there a location where a robot could be plugged in"* is a smaller question than *"is there a
commissioned charging dock"*, and it is the same class of act as Q7's routing declaration — which
the owner has already authorised in principle. **No such location is proposed here**, and whether
one exists is the owner's to state.

---

### 11.5 Safety consequence

**Plainly: with one person, S-3 cannot be closed, and therefore neither can S-4, S-6 or S-7. This
is a hard stop and it is not negotiable by any repository act.**

**The rule, in code rather than in prose.** `config/service.js:62` —
`const SAFETY_APPROVAL_QUORUM = 2;` (`@structural`, §22.3) — and `checkSafetyApproval` at `:322`:

```js
function checkSafetyApproval(request, changes) {
  if (changes.length === 0) return [];        //  <- the gate only fires on Safety-class changes
  ...
  if (identities.size < SAFETY_APPROVAL_QUORUM) { findings.push({ id: "S2", severity: BLOCKING, ... }) }
```

Identities are counted as a `Set` over `publishedBy` ∪ `approvals[].approverId`, so **the same person
cannot be both**. A publish marked `automated: true` that touches a Safety parameter is refused
outright as finding **S1** — which is the rule that forbids *me* from supplying these.

**Exactly two of the fifteen required register values are Safety-class**, re-enumerated
programmatically during this pass:

| Value | Unit | Why it cannot be provisional |
|---|---|---|
| `energy.model_residual_cv` | ratio | Coefficient of variation of the consumption model's residual, before §14.5's inflations. Its register entry states it is *"seeded null, not with a plausible number"* |
| `energy.reserve_floor_wh` | Wh | *"E_floor — the hardware protection floor below which the pack risks damage or the agent loses controlled shutdown. **Never overridable**"* |

**What follows, precisely:**

- **S-3 is blocked.** It requires the external values supplied *in writing, in a decision record*.
  Two of them cannot be authored by one person, and cannot be authored by me at all.
- **S-4 and S-6 follow.** `energy.reserve_floor_wh` is on the coordinator's `requires` list (verified
  in this pass's `gate:composition` output), so composition cannot resolve without it, and no request
  can be priced.
- **The good news, and it is real: the other thirteen are NOT blocked by this.** Because
  `checkSafetyApproval` returns `[]` when no Safety parameter is in the change set, **the owner can
  publish every non-Safety value alone, as sole named author**, exactly as Q10 offers. That is a
  genuine, large, unblocked piece of work.
- **The spatial cells and `cutover.engine_enabled` are also not blocked by it.**
  `cutover.engine_enabled` is `changeClass: STRUCTURAL`, deliberately — its own register entry
  explains that it is *"STRUCTURAL rather than SAFETY on purpose"* so that §22.4's automatic rollback
  can set it false. A one-person config publish therefore satisfies S-5 as S-5 is written and checked
  (`cutoverEnabled.describe(...)` → `live: true`).

**One tension found and recorded rather than resolved.** The *cutover control plane* is stricter than
the config layer: `cutover/stage.authoriseEnable` takes `approvedBy` — *"the second approver; must
differ from the requester"* — and `guardrails.assertOneDirectional` states *"enabling a shard is an
operator action with a second approver"*. So **S-5 as written (a config publish) admits one person,
while the documented operator path for taking a shard live requires two.** Both are true; they are
different paths to the same binding. **This pass does not pick one** — resolving it by choosing the
weaker path would be exactly the kind of quiet workaround this programme forbids. It is **RQ-3**.

**What this pass did not do.** No Safety value proposed, defaulted, illustrated or suggested. No
self-approval. No quorum weakened. No second identity invented. No Safety parameter moved out of the
Safety class.

---

### 11.6 Deployment consequence

**The headline finding of this section, and it is good news: V1's stop condition never requires a
deployed environment. The owner's local development environment is a sufficient V1 environment.**

This was verified against the harness rather than argued. `tools/verify/v1CorePath.js:337-354` starts
the **real `server.js`** with an environment it supplies itself:

```js
DATABASE_URL: databaseUrl,          // a disposable PostgreSQL, not a production one
ENGINE_ENABLED: "true",
SHARD_CONSENSUS_REPLICATION: "SINGLE_PRIMARY_NO_AUTOMATIC_FAILOVER",
COMMAND_SIGNING_KEY: crypto.randomBytes(32).toString("hex"),
NODE_ENV: "production",
```

with the comment stating in terms that the posture is *"a **statement of fact about the cluster this
harness was pointed at**, not a claim about production"*.

**So the three-way split the owner asked for:**

| | Item | Verdict |
|---|---|---|
| **A — genuinely requires a deployed environment NOW** | — | **NOTHING.** No S-condition names a deployment. §2's N-4 ("no target deployment identified") is a real gap in the *checklist's* completion test, **not in S-1…S-8** |
| **B — completable in local engineering, today** | S-1, S-2, S-8 (already MET); the non-Safety value publish; the derived fine-cell assignments and config version; the `Charger` row **if** one is declared; S-4's composition once inputs exist; **S-6 in full**, against a disposable local PostgreSQL; S-5, by publishing the binding against the local environment | **All of it** |
| **C — only becomes meaningful when a deployment exists** | **D-5** (`SHARD_CONSENSUS_REPLICATION` for a real cluster) · **N-3** (`COMMAND_SIGNING_KEY` as an operator-declared secret) · **N-4** (identifying the deployment) · the Neon/Redis-Cloud endpoints currently in `Backend/.env` · B1's R1 self-hosting evidence · every D8 refresh-cadence question | **Deferred, legitimately** |

**Three corrections this makes to earlier framing in this same document — recorded, not silently applied:**

1. **§2 row N-3 and §6 row X14 rate `COMMAND_SIGNING_KEY` as V1-blocking for "a real end-to-end
   request".** Measured against the harness, it is **not**: the harness generates one, and S-6 is
   defined as *the harness exiting 0*. It is a **deployment** requirement (bucket C), not a V1 one.
2. **§2 row D-5 is the same.** The posture is undeclared *for a deployment*; the harness declares its
   own truthfully for its own disposable cluster. Bucket C.
3. **§2 row N-4 says "it gates D-2, D-5 and N-3".** True — and since D-5 and N-3 are bucket C, and
   D-2 can be satisfied against the local environment, **N-4 gates nothing in S-1…S-8**.

**Q4 therefore stays open, and staying open costs nothing.** It is a statement of fact about a
database that does not yet exist. **Do not invent a posture** — and none was invented here. The only
narrowing worth stating: **if** V1 is declared against the local environment, the posture is a fact
about *that* database and the owner can state it directly; **if** against the Neon endpoint currently
in `.env`, it is a question for that provider. That is **RQ-4**, and it is a small question, not a
blocker.

---

### 11.7 The 13 provisional values

**These are the exact 13, and the count was verified rather than inherited.** The `requires` list
`gate:composition` printed on this tree carries **16** register-class names. Removing
`candidate.max_radius_by_sla_class` — which §10.1's decomposition counts **separately** from "the 15
register entries", and which §7 records as owed by Operations — leaves 15; removing the two
Safety-class entries of §11.5 leaves **exactly 13**. Reproduce it with:

```
node tools/gates/checkCompositionRoot.js
```

**Two register entries that look like candidates and are not.** `cost.reference_agent_class` and
`cost.uncertainty_penalty` are both `null` / `UNCALIBRATED` in `register/*.json` but appear
**nowhere** on the coordinator's `requires` list. **Do not collect them for V1.** They are named here
only so that a future reader scanning the register for nulls does not add them back.

**Does any historical Phase 0–15 artefact already contain a legitimate value the owner could review?
Searched, and the answer is NO — with one near-miss worth naming so it is not mistaken for one.**
§3.4 established that no phase ever published a value; this pass re-confirmed all 13 as
`"default": null`, `"calibrationStatus": "UNCALIBRATED"`. The near-miss is the **legacy
`costEvaluator.service.js` weights** (`w1…w4`, e.g. `w4 = 0.05`, recorded in
`legacy-assignment-engine-audit.md` §D13). They are **not** candidates: they are dimensionless
weights in a normalised weighted sum over min-max-scaled inputs, whereas every value below is a
**dimensioned rate in CU** traceable to an accounting, contractual or amortisation figure. Reusing a
tuning weight as a currency rate would be a category error, and the module they lived in was deleted
from the build at Phase 15. **Nothing is reused, and no number is proposed here.**

| # | Value | Plain-English meaning | Unit | What the owner needs to provide |
|---|---|---|---|---|
| 1 | `plan.service_time_prior` | How long a stop is assumed to take, before the system has learned anything | seconds | One starting estimate. §8.2 learns per (site, stop type, mission class, time of day) afterwards; this is only the opening guess |
| 2 | `cost.energy.cu_per_wh` | What one watt-hour of consumed energy is worth | CU per Wh | One rate. The register's stated basis is *"derived from the tariff … never a tuning knob"* — so your electricity price, expressed in CU |
| 3 | `cost.wear.cu_per_metre` | What one metre of ordinary driving costs in wear and tear | CU per metre | One rate. Stated basis: replacement cost ÷ rated life |
| 4 | `cost.battery.cu_per_equivalent_cycle` | What one full charge-and-discharge of the battery costs | CU | One value. Stated basis: pack replacement cost ÷ rated cycles |
| 5 | `cost.failure.cu` | What it costs when a delivery fails | CU | **Not one number — a short table.** Keyed by mission class **and custody state**: failing *while carrying the parcel* is a different event from failing *before pickup*, and the register forbids the two sharing a price |
| 6 | `cost.energy_consequence` | What running short of energy costs | CU | **One value per §14.5 shortfall tier.** The register states these *"are not the same event and must not share a price"* |
| 7 | `cost.sla.cu_per_second_late` | What one second of lateness costs | CU per second | One rate, *"from contract terms — not a tuning weight"* |
| 8 | `cost.sla.breach_penalty` | The one-off penalty when a promised deadline is actually missed | CU | One value. Charged once, by exactly one terminal Leg |
| 9 | `cost.staleness.cu_per_second_age` | The cost of deciding from an observation one second old | CU per second | One rate |
| 10 | `lifecycle.cu_per_actuator_cycle` | Amortised cost of one actuation — a lift, a door, a latch | CU | One value |
| 11 | `lifecycle.cu_per_braking_event` | Amortised cost of one braking event | CU | One value. This is the *event* half of brake wear; #12 is the *exposure* half |
| 12 | `lifecycle.cu_per_gradient_metre` | Amortised cost per metre climbed or descended under load | CU per metre | One rate. Deliberately distinct from #3, which prices flat distance |
| 13 | `lifecycle.cu_per_thermal_stress_second` | Amortised cost of one second running at the reference thermal stress | CU per second | One rate, **at the reference level only**. A mission's actual stress enters later as a measured multiplier — you are not being asked to model that |

**What is explicitly NOT being asked of the owner.** No technical derivation. Where the register names
a basis (a tariff, replacement cost ÷ rated life, contract terms), that basis is the *intended*
eventual derivation, not a precondition: §7 already records that production calibration is **not** a
V1 requirement, `energy.model_residual_cv` excepted. **A stated provisional figure with the owner's
name on it is what V1 requires**, and §11.5 confirms the owner may publish all 13 alone.

**Three of the thirteen are not single scalars** — #5 (per mission class × custody state), #6 (per
§14.5 tier) and, strictly, #1 (a prior that is later learned per cohort). They are flagged here so
that "13 values" is not read as "13 numbers" and the collection is not declared complete when three
of the rows are still one-deep.

---

### 11.8 MaxTicks

**The owner's condition is *"if it is simple/low-risk, accept it; otherwise leave it for later."*
Inspected against the formal artefact and the acceptance requirement: the condition does NOT fire.
MaxTicks stays OPEN.**

**What was inspected:**

- `formal/lifecycle_c1.cfg:20` — `MaxTicks = 3`, with `Legs = {l1,l2}`, `Capacity = 1`.
- `formal/lifecycle.tla:60` — *"bound on timer firings, to keep the space finite"*; `:512` —
  `TimerFires(l)` requires `ticks < MaxTicks`; `:189` — `ticks` is **one scalar**, not per-Leg.
- `docs/phase15/PHASE_15_BM_TLC_RUN_RECORD.md` §7 and §15.10 item 8.

**Three findings, any one of which defeats "simple and low-risk":**

1. **It is classified as a safety question, in writing.** The run record states: *"§7.3a item 8
   requires boundedness to be 'explicitly accepted', signed rather than assumed, and **it is a safety
   question and not an engineering convenience**."* Contract §J.3 agrees and applies §22.3's
   reasoning: *"an automated process must not sign it."* Under Q9's answer the owner does not
   currently hold the authority this acceptance calls for — so accepting it now would collide with
   §11.5's finding rather than sit beside it.
2. **The bound is global, not per-Leg, and the record already flags the consequence.** *"`ticks` is a
   single scalar incremented by every `TimerFires`. At `Capacity = 3` with four Legs, three timer
   firings cannot exercise a timeout on each Leg. **Whether a three-tick lifecycle is still the
   system is a safety judgement.**"*
3. **`MaxTicks` does not scale with `Capacity` while `Legs` does** (`Legs = Capacity + 1` in every
   configuration), so the ratio of Legs to available timer events **worsens** as capacity rises.
   Judging whether that is acceptable is substantive technical judgement by definition.

**Therefore: OPEN, and no acceptance was prepared.** The owner is **not** recorded as having signed
it, and nothing here treats the conditional instruction as a signature. This closes no V1 stop
condition either way — §J.3 and §7 both confirm MaxTicks is **not** V1-blocking — so leaving it open
costs V1 nothing. **It should not be asked a third time until a safety authority exists**, which is
why it is deliberately absent from §11.10's list.

*(One currency note, recorded because a future reader will hit it. §J.3 describes `lifecycle_c1` as
closing exhaustively — 777 942 states, depth 43, `Safety` + `TerminalIsFinal` + `Liveness` all PASS —
while `PHASE_15_BM_TLC_RUN_RECORD.md` §15.10 records the same configuration **failing** on a deadlock
at depth 6. Both are accurate at their own dates: the run record predates X7's closure on 2026-09-01,
which added §4.6's cancellation latch and made the model close. **The MaxTicks conclusion is
unaffected either way** — the acceptance is of the *bound*, not of the run, and a completed
exhaustive run of a bounded model is a completed run **of that bound**.)*

---

### 11.9 Updated V1 reality

**Nothing below is marked resolved because the owner said YES. A YES that authorises an act does not
perform it.**

| Requirement | Now resolved? | Why | Remaining dependency |
|---|---|---|---|
| **A1 · A2 — traversal source + six `route` fields** | **NO** | Q6's lead investigated in full (§11.2). Mapbox is real, live and credentialed — and it is a **metered third-party API**, which F-1's *self-hosted* clause excludes, and it produces **2 of 6** required fields | A self-hosted engine. Q7's YES stands ready and has nothing yet to attach to |
| **A3 — `travelSdSeconds` spread model** | **NO** | Mechanism built and refusing correctly (`contract.js:368-401`); a single Mapbox Directions call returns one ETA, never a distribution | Supplied with the source |
| **A4 — `speedMetresPerSecond`** | **NO — and now correctly reclassified** | Q1 = C. There is no fleet to measure | **Not "late" — not yet obtainable.** External; nothing the owner can do today unblocks it |
| **A5 — `timeBucket` convention** | **DECIDED, not yet bound** | Q12 = YES. `plan/timeline.hourOfWeek` already implements it; nothing new is invented | Reuse at the seam — repository work, once a routing source exists to be queried under it |
| **A6 — the 13 non-Safety values** | **AUTHORISED, not supplied** | Q10 = YES, and §11.5 confirms **one person suffices** for all 13 | The owner writes the figures. **Largest single unblocked item** |
| **A6a — the 2 Safety values** | **NO — hard stop** | Q9 = alone. `SAFETY_APPROVAL_QUORUM = 2`, counted over distinct identities; an automated publish is refused as S1 | **A second qualified person. Nothing else** |
| **A7 — ambient/pack temperature** | **NO** | No column, no producer; and gated behind N-1's absent `EnergyModelParams` row | Q1 = C. Not yet obtainable |
| **A8 — `masses.vehicleMassKg`** | **NO — but reclassified** | Q11: obtainable when hardware exists. Not an immediate blocker in the sense of someone withholding it | **An external dependency, not an owner decision** |
| **A9 · A10 — `p_fail`, `route_hazard_cost`** | **NO** | `reliability/` is an empty `.gitkeep`; `ObstacleEvent` reports obstacles and does not price routes | Q1 = C. `p_fail` needs realised failure data, which needs an operating fleet |
| **A11 · N-1 — the fitted energy model** | **NO** | No `EnergyModelParams` row exists outside a test fixture, which may not be promoted | A vendor characterisation. Q1 = C |
| **A12 · D-3 — operating region** | **PARTLY — and now larger** | Identities were declared 2026-08-30. Q2 answers **both**, and §11.3 verifies the architecture supports both **without a contract change** | Per campus: cells derived, config version published, shard row, binding. **RQ-1** picks the staging order |
| **A13 · D-4 — depot charger** | **NO — and now definitively answered** | Q8 = NO. §11.4: `plan.energy` is null, so F34 **and** F35 deny for every candidate at every state of charge | **This is the item that makes V1 uncompletable as defined.** **RQ-2** |
| **A14 — return-leg Wh/metre** | **NO** | Shape precedented (`profile.energyWhPerMetre`); value absent | Supplied with the charger declaration |
| **D-2 · S-5 — engine on** | **AUTHORISED, not performed** | Q5 = YES. `cutover.engine_enabled` is STRUCTURAL, so the config layer admits one person | Depends on the region binding. **RQ-3** resolves the one-vs-two-approver path |
| **D-5 · N-3 · N-4 — deployment facts** | **CORRECTLY DEFERRED** | §11.6: the S-6 harness supplies all three for itself. **No S-condition names a deployment** | **RQ-4**, and it blocks nothing |
| **D-6 — MaxTicks** | **NO — stays open** | §11.8: the owner's own condition does not fire. It is a safety judgement, the bound is global not per-Leg, and it does not scale with capacity | A safety authority. **Not V1-blocking** |
| **D-1 — the B8 V9/S2 decision** | **NO** | Two SAFETY/PROVISIONAL parameters; §22.3's two named approvers | Same as A6a |

**The eight stop conditions, unchanged by this reconciliation:**

| | S-1 | S-2 | S-3 | S-4 | S-5 | S-6 | S-7 | S-8 |
|---|---|---|---|---|---|---|---|---|
| **Status** | **MET** | **MET** | **NOT MET** | **NOT MET** | **NOT MET** | **NOT MET** | **NOT MET** | **MET** |

**Score: 3 of 8 — unchanged.** The owner's answers moved real information and closed no condition.

**What genuinely cannot be closed, and why — the honest list:**

1. **The 2 Safety values** — one person exists; the rule requires two. *(External: a person.)*
2. **One depot-class charger per region** — none exists. *(External: a physical or declared location.)*
3. **A self-hosted traversal source** — none is deployed, and the historical one is a third-party API.
   *(External: an engine.)*
4. **Mass, temperature, `p_fail`, the fitted energy model, per-profile speed** — **there is no robot.**
   These are not late and nobody is withholding them. *(External: hardware that does not exist yet.)*

**Items 1–3 are the ones a decision could move. Item 4 is not a decision at all**, and Q1's answer is
what makes that visible for the first time. Four of the nine items §1.3 classed as *"genuinely
missing"* are in group 4, which changes how they should be reported — not whether they are missing.

---

### 11.10 ONLY remaining owner questions

**Five. Everything else in §9 is answered, superseded, or answerable from the repository.**

**Explicitly NOT re-asked:** Q1, Q3, Q5, Q7, Q10, Q11, Q12 — answered and applied. **Q6** — the lead
was investigated to conclusion in §11.2; the answer is that the historical system cannot serve as the
V1 traversal source, and no further owner input changes that. **Q13 / MaxTicks** — §11.8; do not ask
again until a safety authority exists.

---

**RQ-1 — Staging order for the two campuses.** *(Replaces Q2. Both campuses are supported; the
contract needs no change.)*

Which campus do you want brought live **first**?

- **A** — RNSIT Bengaluru first, JSSATE second
- **B** — JSSATE Bengaluru first, RNSIT second
- **C** — Both at once *(costs one extra config version, one extra charger declaration, and a second
  S-6 harness run — nothing else)*

*Why this is still a question:* S-5 is a per-region act and the S-6 harness creates one region per
run, so somebody has to say which region the first run is for. Nothing else about "both" needs
deciding.

---

**RQ-2 — The charger. This is the one that decides whether V1 can finish.**

Q8 = NO means **every mission is refused, for every robot, at every state of charge** (§11.4). Three
honest options, and only you can pick:

- **A** — There is a location at one campus where a robot could be plugged in, and I will declare it
  for a labelled V1 engineering environment *(the same kind of act as your Q7 YES)*
- **B** — There is genuinely nowhere. Record that V1 cannot be completed as currently defined, and stop
- **C** — Change the V1 definition so a charger is not required *(your explicit decision, in a
  decision record — I will not do this quietly, and I have not done it)*

*If A: which campus, and roughly where.* No location is proposed here and none may be inferred from
map, repository, demo or test data.

---

**RQ-3 — Who may turn the engine on?**

Two paths in the code disagree, and I will not pick the weaker one on your behalf (§11.5):

- **A** — One person is enough. `cutover.engine_enabled` is STRUCTURAL, and S-5's own test
  (`cutoverEnabled.describe(...)` → `live: true`) is satisfied by a one-person config publish
- **B** — Use the documented operator path (`cutover/stage.authoriseEnable`), which requires a second
  approver — meaning this waits for the same person RQ-5 needs

---

**RQ-4 — Which environment is V1 declared for?** *(Narrowed from Q3/Q4. This blocks nothing — §11.6.)*

- **A** — The local development environment, with a local PostgreSQL *(then the failover posture is a
  fact about that database, and is straightforward for you to state)*
- **B** — The cloud database `Backend/.env` currently points at *(then the failover posture is a
  question for that provider, and I will not assume it)*

---

**RQ-5 — The second person.** *(Restates Q9 as an action rather than a status, because this is the
single hardest blocker and it has no repository workaround.)*

Two of the fifteen required values are hardware-safety parameters — the pack protection floor below
which the battery is damaged, and the consumption model's error margin. The code requires **two
different named people** and refuses an automated publish outright.

- **A** — I can name a second person who could review and co-sign these *(who?)*
- **B** — I cannot, and V1 stops here until I can

*Please answer this one even if the answer is B.* B is a legitimate, recordable outcome and it is
better recorded now than discovered at the end.

---

**Areas with NO remaining owner questions:**

- **Routing history** — investigated to conclusion (§11.2). Nothing further to ask.
- **Time bucket** — settled by Q12; `timeline.hourOfWeek` is reused and nothing is invented.
- **The 13 non-Safety values** — settled by Q10. What remains is you writing the figures, not another
  question. §11.7 is the sheet.
- **Hardware-derived inputs** (mass, temperature, `p_fail`, the fitted energy model, per-profile
  speed) — **no question exists.** Q1 = C means these become available when hardware does. Asking
  again before then would be asking you for something that does not exist.
- **Deployment** — no blocking question. RQ-4 is a labelling choice, not a prerequisite.
- **MaxTicks** — deliberately not asked (§11.8).

---

### 11.11 Verification of this section

| Claim | How it was verified in this pass |
|---|---|
| The old assignment engine is gone from the build | `node tools/gates/checkLegacyRetirement.js` → **PASS**, 4 retired modules absent and unimported across 350 files; directory listing confirms `taskAssignment/costEvaluator/robotValidator/taskRecovery.service.js` absent |
| `mapbox.service.js` and `routing.service.js` still exist and are reachable | Both files read in full; `grep` for their importers over `src/` + `server.js` — `task.service.js:51`, `routing.service.js:15`, `alertDissemination.service.js:21`; route traced to `tasks.routes.js:62` |
| Mapbox is the router, not the renderer | `mapbox.service.js:55-107` (Directions v5) and `:121-148` (Matrix) read in full; frontend searched for `directions`/`api.mapbox.com` — only Search/geocoding in `LocationCombobox.jsx` |
| A Mapbox token is configured | `grep -i mapbox Backend/.env` — `MAPBOX_TOKEN` present *(value not reproduced here)* |
| Mapbox supplies 2 of the 6 `route` fields | §F.2's six-field contract compared against `directionsWithDistance`'s return shape |
| Multi-region is supported | `register/supplementary.json` `cutover.engine_enabled` (`scopes: ["global","region"]`, `blastRadius: "region"`) printed programmatically; `cutover/enabled.js:30-38`; `spatial/hierarchy.js:60,190,336`; `campusMultiCampus.test.mjs` read |
| The S-6 harness is single-region | `tools/verify/v1CorePath.js:119-125` — one `prisma.region.create`, one `prisma.shard.create` per run |
| No deployment is required for V1 | `tools/verify/v1CorePath.js:337-354` read in full — the harness supplies `DATABASE_URL`, `ENGINE_ENABLED`, `SHARD_CONSENSUS_REPLICATION`, `COMMAND_SIGNING_KEY` itself |
| The charger consequence | §M.3's trace re-read against the contract; F35's `DEPOT_ONLY` basis and `{ chargerId, energyWh, travelSeconds, isDepot }` contract confirmed |
| The two-person rule fires only on Safety changes | `config/service.js:322` — `if (changes.length === 0) return [];`; `:62` — `SAFETY_APPROVAL_QUORUM = 2`; `:341-356` — identities counted as a `Set` |
| The stage path requires a second approver | `cutover/stage.js:262` (`approvedBy` "must differ from the requester"); `cutover/guardrails.js:302` |
| Exactly 13 non-Safety register values | `node tools/gates/checkCompositionRoot.js`, `requires` list filtered to register-class names → **16**; minus `candidate.max_radius_by_sla_class`, minus 2 SAFETY → **13**. Units and descriptions read programmatically from `register/*.json` |
| `cost.reference_agent_class` / `cost.uncertainty_penalty` are not required | Absent from the same `requires` list |
| MaxTicks | `formal/lifecycle_c1.cfg:20`; `formal/lifecycle.tla:60,189,512`; `PHASE_15_BM_TLC_RUN_RECORD.md` §7 |

**Commands run in this pass:** `node tools/gates/checkLegacyRetirement.js` (PASS),
`node tools/gates/checkCompositionRoot.js` (FAIL — 1 violation, the expected
`LEADER_ONLY_NOT_COMPOSABLE`), and two `node -e` reads of the register JSON. **`npm test` and
`npm run gates` were not re-run** — §10.1 measured them on this same tree and nothing in this pass
changed a file they read. **No database was contacted, no server started, and the S-6 harness was
not run.**

**No value was fabricated.** Searched this section for a proposed number: **none exists.** No router,
region, charger, coordinate, calibration constant, temperature, mass, failure probability, hazard
cost, energy rate, consensus posture or Safety value is proposed, defaulted, illustrated or suggested
anywhere in §11.

---

> **This reconciliation closed no stop condition and changed no count. The score is 3 of 8, exactly
> as before. Two things it did establish that were not known this morning: V1 needs no deployment,
> and the historical Mapbox flow cannot serve as V1's traversal source.**
>
> **TRUTH > GREEN.**

---

## 12. Final feasibility analysis — *can V1 be completed exactly as contracted?*

**Added 2026-09-05, same tree (HEAD `4e2155a` + the uncommitted repository-only pass). A feasibility
decision, not a discovery pass. §§1–11 are not restated and not revised.**

**What this section changed on disk: this file only.** No source, test, schema, migration, register
entry, formal model, gate, contract, stop condition, S-1…S-8 definition or verification result was
touched. No value was invented. No charger, router, telemetry reading, measurement, failure history
or Safety approval was proposed, defaulted or illustrated.

---

### 12.1 Executive verdict

> ## **V1 is NOT feasible as currently contracted.**
>
> It is not blocked at one boundary that a decision could move. **S-6 — the condition that makes
> V1 a working engine rather than a composed one — is unreachable under these circumstances by
> three independent hard stops, each sufficient on its own.** Two were already on the record. The
> third is larger than all of them and appears on **no owner-facing list in this repository**.

| | Hard stop | Why it is a stop, not a delay | Already on a list? |
|---|---|---|---|
| **HS-1** | **§7.5 admission requires agent facts only a physical robot and an operating control plane produce** | S-6 requires one candidate to survive `feasibility.gate`, and `evaluate.js:152` sets `feasible: denials.length === 0` — no skip flag, no manual override, no privileged caller (`evaluate.js:38-40`). §N.5 measured **30 of 38 predicates still denying** with the region, the charger *and* all fifteen register values supplied. About twenty of those read commissioning, e-stop, faults, health, localisation, heartbeat, link quality, intervention rate, advisories, attested firmware and maintenance counters. **No robot exists to emit them** | **NO — see §12.6** |
| **HS-2** | **The two Safety-class register values need two named approvers; one person exists** | `config/service.js:62` `SAFETY_APPROVAL_QUORUM = 2`, counted as a `Set` over `publishedBy` ∪ `approvals[].approverId`; an `automated: true` publish touching a Safety parameter is refused outright as **S1**. `energy.reserve_floor_wh` is on the coordinator's 34-row `requires` list — verified in this pass's `checkCompositionRoot.js` output — so this blocks **S-3, S-4 and S-6** | YES — §11.5, RQ-5 |
| **HS-3** | **No charger is declared for any region** | §11.4's trace, re-verified: `chargerCandidates = []` → `plan.energy = null` → F34 **and** F35 `INDETERMINATE`, class I, policy `DENY` → **every candidate, every Leg, every state of charge** | YES — §11.4, RQ-2 |

**HS-2 and HS-3 are each removable by one owner act** — naming a second person, declaring one
depot-class location. **HS-1 is not.** It is removable only by hardware, or by an explicit owner
decision that changes what S-6 means — which is a contract change, and therefore the owner's act
and not this repository's.

**What remains true and is worth stating plainly:** nothing found here contradicts §11's
conclusion that V1 needs **no deployment**, that **both campuses are supported without a contract
change**, or that the **13 provisional values are unblocked**. The repository is not the problem.
Every one of the three hard stops is a fact about the world, and the code refusing on each of them
is the code working.

---

### 12.2 S-1 … S-8 feasibility matrix

| # | Condition (§I.2, verbatim intent) | Status | What remains | Achievable now? | Exact prerequisite |
|---|---|---|---|---|---|
| **S-1** | No unproven optimality gap; no absent physical input read as benign | **MET** | Re-verification at the closing tree only | **YES** | Nothing. Re-run `npm test` at whatever tree closes V1 |
| **S-2** | Every worker names a real register parameter or a stated `@structural` constant | **MET** | Re-verification at the closing tree only | **YES** | Nothing |
| **S-3** | The external values supplied in writing, in a decision record | **NOT MET** | 28 authoritative inputs; **26 measured unresolved** live | **NO** | **Blocked by HS-2.** 13 are owner-only and closable today; 2 need a second person; 5 need a self-hosted traversal source; 6 need hardware, a vendor characterisation or a named data source |
| **S-4** | `gate:composition` exit 0, coordinator returns a **started** handle | **NOT MET** | 34 declared inputs must all resolve | **NO** | Every S-3 input **plus** the accessor wiring at `server.js:657-722`, which currently passes **none** of the six input accessors. `energy.reserve_floor_wh` is on the list, so HS-2 blocks S-4 directly |
| **S-5** | A pinned config version binding `cutover.engine_enabled = true` at region scope, + `ENGINE_ENABLED=true` | **NOT MET** | One publish, one pin, one env var | **YES — the only unmet condition that is achievable today** | A published fine-cell assignment for one campus (derived, not owner-supplied) and a `Shard` row. `cutover.engine_enabled` is `STRUCTURAL`, so **one person suffices** (§11.5). **RQ-3** is the open question about which path is authorised, not whether one exists |
| **S-6** | One real HTTP request reaches a durable `Commitment` + `Outbox` in one transaction, with a `Round` row and a per-Leg decision record | **NOT MET** | All 38 §7.5 predicates must admit for one agent–Leg pairing (§M.8) | **NO — and not by any repository act** | **HS-1 + HS-2 + HS-3.** See §12.6. The environment is *not* the obstacle: the disposable-PostgreSQL harness is sufficient (§12.9) |
| **S-7** | `npm test` exit 0 **and** `npm run gates` exit 0 at one tree | **NOT MET** | Only `gate:composition` fails | **NO** | Mechanical consequence of S-4. Confirmed live this pass: **1 violation, `coordinator`, `LEADER_ONLY_NOT_COMPOSABLE`, 34 requires** |
| **S-8** | The documentation states what V1 does not guarantee | **MET** | Re-verification at the closing tree | **YES** | Nothing |

**Score: 3 of 8 — unchanged. This analysis closed nothing and was not intended to.**

**The shape of the answer, stated once:** S-5 is reachable today. S-3 and S-4 are reachable if one
second person exists. **S-6 is not reachable at all**, and S-7 cannot be reported at a closing tree
while S-6 is open.

---

### 12.3 Missing-input classification

**Seven categories, exactly one per row.**
**1** repository/project · **2** owner provisional · **3** external source/spec/vendor ·
**4** physical hardware/measurement · **5** second Safety authority · **6** deployment ·
**7** impossible without a contract change.

#### 12.3.1 The 28 authoritative S-3 inputs

| Row | Input | Class | Note — why this class and not the adjacent one |
|---|---|---|---|
| A1 | `route(parts)` traversal source | **3** | A deployed, self-hosted engine. Not a procurement decision (§7); not hardware |
| A2 | `distanceM`, `travelSeconds` | **3** | Falls out of A1 |
| A2 | `climbM`, `descentM` | **3** | Elevation is available from Valhalla/GraphHopper, not OSRM (contract §F, F-6) |
| A2 | `stopStartCycles` | **3** | **No shortlisted engine returns it.** A separately declared model with a named source, like A3 |
| A3 | `travelSdSeconds` spread model | **3** | The shape is already built and already refuses without a named source (`contract.js:368-401`) |
| A4 | `speedMetresPerSecond` per profile | **3 or 4** | **3** if the design specification states a nominal *profile cruise speed*. **4** if only a limit exists — `kinematicLimits.maxSpeedMps` is a limit, and the repository already names limit-read-as-value as a defect class (§2 row A4, mirroring A8) |
| A5 | `timeBucket` convention | **1 — DECIDED** | Q12 = YES. `plan/timeline.hourOfWeek` is implemented and reused; nothing is invented. Repository wiring only |
| A6 × 13 | The 13 non-Safety cost/plan values | **2** | Owner-only, sole named author, one publish. **The largest genuinely unblocked item in the project** |
| A6a × 2 | `energy.model_residual_cv`, `energy.reserve_floor_wh` | **5** | **Not 2.** §22.3 forbids an automated choice; `SAFETY_APPROVAL_QUORUM = 2` forbids a solo one |
| A7 | `environment.ambientC` | **3** | A named weather/forecast source. **No robot is required for ambient air temperature** |
| A7 | `environment.packC` | **4** | A battery-pack temperature is a sensor reading off a pack that does not exist |
| A8 | `masses.vehicleMassKg` | **3** | **Not 4.** A fleet/design specification is a legitimate named source; the checklist says so (*"from the fleet's own specifications"*). Weighing is one way to get it, not the only legitimate one |
| A9 | `p_fail` per agent | **3 + 1** | A declared reliability model with a named source (e.g. a vendor MTBF basis) is legitimate; §8.3.1's *posterior* then needs realised data, which needs a fleet. **The producer is also absent code** — `src/engine/reliability/` is a `.gitkeep` |
| A10 | `route_hazard_cost` | **3 + 1** | The Map service is the declared producer (§5.2) and **no client in `src/` fetches any**. `ObstacleEvent` is a different quantity and is not a substitute |
| A11 curves | §14.4 pack stress curves | **3** | A pack manufacturer's datasheet characterisation. The column and the read path both exist (W-A5) |
| A11 mission | `socThroughput`, `dod`, `socMid`, `cRate` | **1** | **Not 3 or 4.** These are *computed per plan*. No column carries them and no code computes them — repository work, once the curves exist |
| N-1 | The fitted `EnergyModelParams` row (9 β + thermal curves) | **3 or 4** | **3** if a vendor or engineering model is declared with its source. **4** if "fitted" is read strictly — a fit to this vehicle's measured consumption. **On no current V1 list; this pass does not move it** |
| A12 | Serviceable-region cell assignments | **1** | **Not owner data.** Cell ids are derived by `cells.cellForPoint(lat, lon, FINE)`. The owner's act is D-3 (naming the region); the data is repository work |
| A13 | One depot-class `Charger` with a `cellId` | **2** | **A declarable engineering fact, if such a location exists.** F35 is a feasibility reserve, not a booking (§14.7) — the question is *"is there somewhere a robot could be plugged in"*, not *"is there a commissioned dock"*. Owner answered NO. **RQ-2** |
| A14 | Return-leg Wh per metre | **3** | Supplied with A13 or F35 stays `INDETERMINATE`. `β_dist` is not a substitute |
| D-1 | B8 — one V9/S2 Safety decision | **5** | Two named approvers. Not the technical unblock for S-5 or S-6 (§11.5, control §4.2) |
| D-2 | `cutover.engine_enabled` + `ENGINE_ENABLED` | **2** | Authorised (Q5 = YES), not performed. `STRUCTURAL`, so one person suffices for S-5 as written |
| D-3 | Declare the V1 operating region | **2** | Identities declared 2026-08-30. **RQ-1** is only the staging order |
| D-4 | Declare charger + rate together | **2** | With A13/A14 |
| D-5 | `SHARD_CONSENSUS_REPLICATION` posture | **6** | Correctly deferred. The harness declares a true posture about its own disposable cluster (§11.6) |
| D-6 | `MaxTicks = 3` | **5** | A safety judgement (§11.8). **Non-blocking either way** |
| N-2 | `BatteryState.lastObservedSoc` producer | **1 + 4** | Consumer written, **no producer**. The legacy `Robot.battery` percentage is not the same quantity (§14.1) and mapping it is a decision, not a fix |
| N-3 | `COMMAND_SIGNING_KEY` | **6** | Harness generates its own; not V1-blocking (§11.6 correction 1) |
| N-4 | A target deployment | **6** | Gates nothing in S-1…S-8 (§11.6 correction 3) |

#### 12.3.2 The §7.5 agent-record inputs — **not on the 28, and the reason V1 cannot finish**

Grouped by class. **Every one of these is additionally missing its schema column, its producer, or
both — so each carries repository work on top of its real-world source.** See §12.6 for the
measurement.

| Group | Predicates | Class | What it would take |
|---|---|---|---|
| **Live fleet telemetry** | F7 e-stop · F8 faults · F9 health tier · F10 localisation · F11 intervention rate · F13 session/heartbeat · F14 command round-trip · F15 link quality · F16 observation freshness | **4** | A machine emitting timestamped observations. F7 additionally requires **freshness within `connectivity.max_heartbeat_age` = 10 s of the pinned decision time**, and `observation.js:113` makes `observedAt` mandatory and never defaults it to receipt time |
| **Signed attestations about physical hardware** | F1 commissioning · F5 attested firmware · F6 calibration/certification · F12 advisories/recalls · F21 attested capability bundle · F36 maintenance counters | **4, arguably 7** | §23.2, in the schema itself (`schema.prisma:3773-3774`): *"**Capabilities are never accepted from agent telemetry.** They derive from the commissioning record plus a signed firmware/hardware attestation."* **There is no machine to attest to, and signing a manifest for one would be forging a safety credential** |
| **Fleet-specification data, obtainable without a robot** | F23 `ContainerModel` · F24 `cogEnvelope` · F28/F29 `MobilityModel` columns · F31 environmental envelope | **3** | A design specification, seeded into columns that already exist. **This group is genuinely obtainable now** |
| **Operator / control-plane records** | F3 operator hold · F18 reservations · F27 zone authorisations · F32 `Site.accessRules` | **2 + 1** | Declarable by the owner **and** unmapped by the loader. F32's column exists and is unpopulated; F3's does not exist at all |
| **Plan- and repository-shaped** | F19 `latestFeasibleStartMs` · F20 exclusion set · F30 `plan.route` · F37 deadline hardness | **1, 3 and 7** | F20 is persisted to no column and *"an unread exclusion set is not an empty one"* (§N.3). F30 needs zones/surfaces/constrictions the six-field `route` contract does not return. **F37 needs `deadlineIsContractuallyHard` — a contract term no column in this schema carries** |

---

### 12.4 The specific determinations asked for

| Question | Determination |
|---|---|
| **Is a physical RobotX required by S-1…S-8?** | **Not by S-1, S-2, S-3, S-5, S-7 or S-8. Required by S-6, and therefore by V1.** S-4 is blocked by HS-2 before hardware becomes the question. This is the first time the boundary has been stated at that granularity |
| **Can mass, speed, temperature, failure probability and battery-wear inputs come from specification rather than measurement?** | **Partly — and the split is the useful part.** **Yes, legitimately from a named specification:** vehicle mass, pack stress curves, ambient temperature (a forecast source), the container/CoG/mobility/environmental-envelope columns, and a declared reliability basis for `p_fail`. **No:** pack temperature (a sensor on a pack), a *profile cruise speed* if only a limit is specified, §8.3.1's realised-failure posterior, and the *fitted* β coefficients if "fitted" is read as fitted-to-this-vehicle. **The rule that decides each one:** a manufacturer or design figure with a named source is a legitimate declared input; a number standing in for a measurement nobody took is not, and neither is a limit read as a value |
| **Is a charger an absolute V1 requirement or only a production one?** | **Absolute for V1, and the mechanism is not about charging.** An empty estate makes `plan.energy` null, so F34 **and** F35 deny for every candidate at every state of charge (§11.4). It is *not* the production charger **estate** — §7 correctly excludes that |
| **Does the depot/charger contract permit a legitimate engineering setup without hardware?** | **YES.** `model Charger` requires `chargerId`, `cellId`, `isDepot` — it does **not** require a commissioned dock, a rated power, or an availability projection; with no projection the basis is `DEPOT_ONLY` by design (§M.3). So **one real physical location where a robot could be plugged in, declared with its cell, is sufficient and is legitimate.** It needs no robot. It does need to be real: no location may be inferred from map, repository, demo or test data. **This is RQ-2 and it is still open** |
| **Does the absence of a second Safety approver make V1 impossible, or only block particular changes?** | **It makes V1 as contracted impossible — it is not a narrow block.** It stops S-3 (two of the fifteen values), and because `energy.reserve_floor_wh` sits on the coordinator's `requires` list it stops **S-4 and S-6** too. What it does **not** stop: the other 13 values, the region publish, and **S-5** (`cutover.engine_enabled` is `STRUCTURAL`). **It is the one hard stop a single named person removes entirely** |
| **Is the local disposable-PostgreSQL S-6 harness sufficient for S-4, S-6 and S-7?** | **Sufficient as an *environment*; insufficient as an *agent*.** §11.6 established and this pass re-confirms that no S-condition names a deployment and the harness supplies `DATABASE_URL`, `ENGINE_ENABLED`, the consensus posture and the signing key truthfully for its own cluster. But it seeds an `Agent`, a `BatteryState` and a position — **and there is no column to seed a commissioning record, an e-stop observation or an attestation into.** The harness is not the limit; §7.5 is |
| **Can both RNSIT and JSSATE be handled without a contract change?** | **YES — confirmed, and nothing in this analysis disturbs §11.3.** `cutover.engine_enabled` declares `scopes: ["global","region"]`; `spatial/hierarchy.js` iterates a `regions[]` array; the frontend campus registry and its multi-campus architecture test already exist. **Per campus** you additionally need a config version, a `Shard` row, a binding, **a charger of its own** and a traversal source answering for that geography; the harness creates one region per run, so two campuses means two runs |
| **Which of the 28 input rows are genuinely blocking?** | **All 28 block S-3 by its own definition**, but they are not equally live. **Closable today by the owner alone: 13** (the provisional values) **+ 3** owner decisions (D-2, D-3, D-4's decision half). **Blocked on one second person: 3** (A6a's two, D-1). **Blocked on an external engine: 5** (A1–A5, less the decided A5). **Blocked on hardware or a vendor: 6–7** (A4 possibly, A7's `packC`, A9, A10, A11's mission half, N-1, N-2). **Not blocking at all: 4** — `candidate.max_radius_by_sla_class` (satisfied by §6.3's wall-clock disjunction), D-5, N-3, N-4. **And the 28 are not the ceiling** — §12.6 |
| **Minimum real-world prerequisites for S-3, S-4, S-5, S-6, S-7** | §12.5 |

---

### 12.5 Minimum real-world prerequisites

**The smallest set of things that must be obtained or done outside this repository.** Nothing here
is a repository task; every repository task it implies is already scoped in the control document.

| # | Prerequisite | Unlocks | Class | Obtainable today? |
|---|---|---|---|---|
| **P1** | **A second named person** who can review and co-sign two hardware-safety values | S-3, and through it S-4 and S-6 | 5 | **Owner's answer — RQ-5** |
| **P2** | **One real location, at one campus, where a robot could be plugged in**, declared with roughly where it is | S-6 (F34, F35) | 2 | **Owner's answer — RQ-2** |
| **P3** | **A self-hosted traversal engine**, deployed and reachable, answering for that campus | S-3, S-4 | 3 | Yes in principle; nothing is deployed. **Mapbox does not qualify** (§11.2) |
| **P4** | **A declared travel-time spread model**, and a **stop-start-cycles model**, each with a named source | S-3, S-4 | 3 | Yes — declarations, not measurements. **No engine supplies either** |
| **P5** | **The 13 provisional cost values**, written down with the owner as named author | S-3 (13 of 28) | 2 | **Yes, today, by the owner alone.** §11.7 is the sheet |
| **P6** | **A fleet/design specification** giving vehicle mass, the container geometry and CoG envelope, the mobility permission set and envelope, the environmental envelope, and a nominal profile cruise speed | S-3, and 5 of §7.5's 38 | 3 | **Yes if a design specification exists.** No robot needed |
| **P7** | **A pack manufacturer's cycle-life-vs-DoD characterisation** and a **declared energy model** (the 9 β + thermal curves) | S-3, S-6 | 3 | Vendor-dependent |
| **P8** | **A named ambient-temperature source** (forecast or station) | S-3 | 3 | **Yes, today.** No robot needed |
| **P9** | **A declared reliability basis for `p_fail`** and a **Map-service hazard-cost source** | S-3 | 3 | Basis yes; a §8.3.1 posterior needs a fleet |
| **P10** | **A physical RobotX emitting telemetry, and a control plane holding its commissioning record and signed firmware/hardware attestation** | **S-6, and nothing else** | 4 | **NO. This is the ceiling** |

**P1, P2, P5, P6 and P8 are obtainable now.** P3, P4, P7 and P9 are obtainable with effort and
money. **P10 is not obtainable at all**, and it is the one S-6 cannot be reached without.

---

### 12.6 The finding that decides the verdict — recorded because it is on no owner-facing list

**Measured in this pass, against this tree.**

1. **`coordinatorPipeline.REQUIREMENT_IDS` declares 34 inputs.** Enumerated programmatically:
   5 `EXTERNAL_ROUTING`, 16 `REGISTER_UNRESOLVED`, 6 `NO_PRODUCER`, 6 `PROCESS_DEPENDENCY`,
   1 `ADMISSIBILITY`. **Not one of them is a §7.5 agent record.**
2. **The agent snapshot the composition root builds carries none of them either.**
   `coordinatorSolvePath.js:323-393` returns identity, lifecycle, position, mobility model,
   container model, capability bundle, energy model, battery, commitments and the injected
   ambient/pack temperatures — and **no** `commissioning`, `operatorHold`, `emergencyStop`,
   `faults`, `healthTier`, `localisation`, `session`, `heartbeat`, `linkQuality`, `calibrations`,
   `certifications`, `advisories`, `maintenance`, `environmentalEnvelope`, `zoneAuthorisations`,
   `interventionRate`, attested firmware, `reservations` or `projectedAvailableAtMs`.
3. **Most have no schema column to load from.** Measured over `schema.prisma`: `emergencyStop`,
   `healthTier`, `operatorHold`, `heartbeat`, `linkQuality`, `odometer`, `environmentalEnvelope`,
   `zoneAuthorisation` and `interventionRate` occur **zero** times.
4. **S-6 requires every one of the 38 to admit** for the one agent–Leg pairing —
   `evaluate.js:152`, `feasible: denials.length === 0`, with §M.8 already establishing the
   consequence and `evaluate.js:38-40` stating that there is deliberately no `skipPredicates`,
   no `manual` flag and no privileged caller.
5. **§N.5 measured the residue: 30 of 38 still deny** with the region, the charger and all fifteen
   register rows supplied.

**So the 28-row S-3 list, the 22-row owner checklist and `RD-2026-09-05-01` are all describing a
smaller boundary than S-6 actually has.** They are not wrong about what they cover — the contract
records the §7.5 mapping honestly at §M.4/§M.5, and §M.8 draws exactly the right conclusion. **What
never happened is that conclusion being carried onto the sheets the owner is asked to fill in.**
§11.9's *"honest list"* names hardware for mass, temperature, `p_fail`, the energy model and speed —
and does not name it for commissioning, e-stop, faults, health, localisation, heartbeat, link
quality, advisories, firmware attestation or maintenance, which are the predicates that actually
stop the request.

**This is the same defect this programme has now recorded six times, in a sixth place: a count taken
at whichever seam the reader reached.** The requirements probe walks the composition's *constructor*
seams; §7.5 reads *inside* `planInputFor`; and §M.6 already said the instrument, not the reader, was
short. **This pass extends that finding from two rows (F33, F35) to the whole gate**, and it is the
reason a feasibility verdict differs from the six status reports before it.

**One legitimate narrowing, stated so it is not overlooked and not taken as a route.** The
repository ships `simulation/VirtualRobot.js`, which connects over `socket.io-client` and speaks
the **identical wire protocol** as physical hardware, with no privileged path
(`ROBOTX_SYSTEM_HANDBOOK.md:2350-2352`). A running VirtualRobot's session, heartbeat and command
round-trip are **real facts about a real running process** — so F13, F14 and part of F16 could in
principle be satisfied without fabricating anything. **That does not rescue V1**, for two reasons
that are not close: it cannot touch F1, F5, F6, F7, F8, F9, F12 or F36, which are attestations and
sensor readings about physical hardware; and **whether a declared simulated agent may stand as V1's
agent at all is a change to what S-6 means.** That is the owner's decision, in a decision record.
**It is not taken here, not recommended here, and no such wiring exists or was written.**

---

### 12.7 What NOT to spend time on

**Each row would either produce no movement, or produce a green that is not true.**

| Do not | Why |
|---|---|
| **Collect mass, pack temperature, `p_fail`, the fitted energy model or per-profile speed *first*** | They close S-3 rows and reach nothing. S-6 stays blocked by HS-1 and S-4 by HS-2 regardless. **Collect them when P1 and P2 are answered, not before** |
| **Procure or deploy a routing engine before RQ-2 and RQ-5 are answered** | It is the most expensive prerequisite on the list, and if either answer is *"none"* it buys a condition that cannot close. **P3 is real work; it is not the first work** |
| **Stand up a deployment, choose a hosting provider, or resolve the consensus posture / signing key** | §11.6, re-confirmed: **no S-condition names a deployment.** The disposable-PostgreSQL harness is a sufficient V1 environment. D-5, N-3 and N-4 are bucket C and block nothing |
| **Write a `route` adaptor over Mapbox, or keep the straight-line fallback anywhere near the decision path** | §11.2: metered third-party SaaS fails F-1's self-hosted clause, supplies 2 of 6 fields, and `routing.service.js:114`'s two-point fallback would be **an invented traversal presented as a measured one** — precisely what S-1 forbids |
| **Seed a commissioning record, an e-stop observation, a heartbeat, an attestation, a fault list or a health tier for an agent row** | This is the specific way a fake green would be manufactured here. It would take `gate:composition` and the harness to exit 0 while the engine asserted safety facts about a machine that does not exist. **Do not ask for it and do not accept it** |
| **Sign a firmware/hardware attestation for a robot that does not exist** | §23.2 makes it the credential capabilities derive from. Forging it is worse than leaving F5/F21 denied |
| **Propose, bracket or "temporarily" set either Safety value, or self-approve the quorum** | `SAFETY_APPROVAL_QUORUM = 2`; an automated publish is refused as S1. There is no provisional route and none is offered |
| **Weaken F34/F35, adjust `energy.uncalibrated_reserve_factor`, or declare a charger that is not a real location** | The charger question is RQ-2 and it has three honest answers, one of which is *"V1 cannot be completed as defined"* |
| **Re-open Phase 15, re-collect `release-evidence.json`, or work B-P / B-O / B-M / D8 / the full D1 package** | Phase 15 is **FROZEN**. §7 and checklist §3 already exclude all of it |
| **Ask about MaxTicks again** | §11.8: the owner's own condition does not fire, it is a safety judgement, and it closes no V1 condition either way |
| **Run another discovery pass** | §§1–11 are current on this tree. The gap this analysis found is a *classification* gap, not a search gap, and it is now recorded |

---

### 12.8 Owner decision list

**Three decisions. Everything else in §11.10 either waits on these or blocks nothing.**

---

**FD-1 — What is V1's agent?** *(NEW. This is the decision the verdict turns on, and it did not
exist before this analysis.)*

The engine will not commit a task until it can read, for one specific robot: a commissioning
record, a signed firmware attestation, a fresh emergency-stop reading, a fault list, a health tier,
a localisation fix, a live heartbeat, a proven command path, and maintenance counters. **There is
no robot.** Three honest options:

- **A** — **Accept that V1 stops at S-5** until hardware exists. S-1, S-2, S-5 and S-8 close; S-3
  closes as far as one person can take it; S-4, S-6 and S-7 are recorded as *awaiting hardware*,
  which is a true and defensible state to be in.
- **B** — **Change the V1 definition**, in a decision record, so that S-6 may be demonstrated
  against a **declared, labelled simulated agent** — and state explicitly which facts that agent
  is permitted to assert about itself and which it is not. *(This is a contract change and it is
  yours. It is substantial repository work afterwards — schema, ingestion, and a mapper for
  ~20 predicates — and none of it is currently scoped anywhere.)*
- **C** — **Obtain hardware**, and treat V1 as gated on it.

*Why this is the question:* every other blocker has a route through it. This one does not, and
answering it early is the difference between a bounded programme and an open one.

---

**FD-2 — RQ-2, the charger. Unchanged and still decisive.**

Is there **one real location at one campus where a robot could be plugged in** — not a commissioned
dock, just a place — that you are willing to declare for a labelled V1 engineering environment?

- **A** — Yes *(which campus, roughly where)*
- **B** — No, genuinely nowhere → record that V1 cannot be completed as defined
- **C** — Change the V1 definition so a charger is not required *(your explicit decision, in a
  decision record)*

---

**FD-3 — RQ-5, the second person. Unchanged and still decisive.**

- **A** — I can name someone who could review and co-sign the two hardware-safety values *(who?)*
- **B** — I cannot

*Please answer even if it is B.* B is legitimate and recordable, and it is better recorded now.

---

**Deferred until FD-1…FD-3 are answered, and not re-asked here:** **RQ-1** (staging order — matters
only once a campus can actually run) and **RQ-3** (one-vs-two approvers for the engine switch —
matters only once S-5 is the next act). Both are recorded in §11.10 and neither has changed.

---

### 12.9 Recommended execution order

**From where the repository stands to the earliest legitimate V1 completion. The ordering is
load-bearing: several steps are wasted if taken before the one above.**

| Step | Action | Owner | Depends on |
|---|---|---|---|
| **0** | **Answer FD-1, FD-2, FD-3.** If FD-2 = B or FD-3 = B, **stop and record that V1 cannot be completed as currently defined** — that is the deliverable, and it is an honest one | Owner | — |
| **1** | **Write the 13 provisional values** and publish them as one config version, sole named author | Owner | Nothing. **Start here in parallel with step 0 — see §12.10** |
| **2** | Derive the fine-cell assignments for the first campus and publish + pin them; create the `Shard` row | Claude | FD-2/RQ-1 |
| **3** | **S-5** — bind `cutover.engine_enabled = true` at that region's scope, pin, run with `ENGINE_ENABLED=true` | Owner | 2, RQ-3. **This is the first stop condition that will actually close** |
| **4** | Safety publish of the two Safety-class values, two named approvers; and the B8 V9/S2 decision | Safety ×2 | FD-3 = A |
| **5** | Obtain and deploy a self-hosted traversal engine; declare it, its environment, the spread model, the stop-start model and the per-profile speed | Owner + external | 0 |
| **6** | Declare the charger **and** the return-leg Wh/metre together | Owner | FD-2 = A |
| **7** | Supply the specification data — mass, container geometry, CoG, mobility columns, environmental envelope, pack curves, energy model, ambient source, reliability basis, hazard source | Engineering / vendors | 0 |
| **8** | Wire the six input accessors into `server.js` and build the remaining producers | Claude | 5, 6, 7 |
| **9** | **S-4** — `gate:composition` exit 0, coordinator starts | Claude | 4, 5, 6, 7, 8 |
| **10** | **The §7.5 agent-record programme** — schema, ingestion and mapping for ~20 predicates, plus the data source behind each | **Unscoped. Blocked on FD-1** | FD-1 |
| **11** | **S-6** — the harness against a live PostgreSQL, expecting a durable `Commitment` **and** `Outbox` in one transaction, a `Round` row and a per-Leg decision record | Claude | 3, 9, 10 |
| **12** | **S-7**, then re-verify **S-1, S-2, S-8** at the closing tree | Claude | 11 |

**Steps 1–3 are reachable now and would take V1 from 3 of 8 to 4 of 8.** Steps 4–9 are reachable
with a second person, an engine and a specification. **Step 10 is the wall**, and steps 11–12 sit
behind it.

---

### 12.10 HARD BOUNDARY — when to start collecting the remaining owner inputs

> **Not yet — with exactly one exception.**
>
> **The earliest legitimate point to begin collecting is the moment FD-1, FD-2 and FD-3 are
> answered, and not one item before.** If FD-2 or FD-3 comes back *"no"*, every input collected in
> the meantime closes a row that leads nowhere; if FD-1 comes back **A**, the §7.5 inputs are not
> worth pursuing at all until hardware exists.
>
> **The exception — start it today: the 13 provisional cost values (P5).** They are owner-only,
> need no second person, no hardware, no engine and no deployment; they are required by *every*
> version of V1, including one that stops at S-5; **no answer to FD-1, FD-2 or FD-3 can invalidate
> them**; and they are the single largest genuinely unblocked item on the boundary. §11.7 is the
> collection sheet and it needs no further preparation.
>
> **Everything else waits on the three answers.** Not because the work is hard, but because
> collecting an input against a stop condition that cannot close is how a programme spends six more
> passes arriving at the same place.

---

> **This analysis closed no stop condition, changed no count, and moved no gate. The score is
> 3 of 8, exactly as before.** What it establishes that was not established this morning: **S-6's
> real prerequisite is a physical robot and an operating control plane**, that requirement is on
> none of the owner-facing lists, and it is the reason V1 is not feasible as currently contracted —
> independently of the charger and independently of the second Safety approver.
>
> **TRUTH > GREEN.**

---

## 13. The three answers, and what they change

> **§12 is NOT edited.** This file's own convention is that **a correction sits beside the record,
> not on top of it** — the mechanism §3.6 and §11 already use — so §12 stands exactly as written on
> 2026-09-05 and every correction to it lives here. Where §12 and §13 disagree, **§13 governs and
> §12 is the record of what was believed before the answers arrived.**

### 13.1 The answers

FD-1, FD-2 and FD-3 were asked at §12.8. All three are answered.

| | Question | Answer |
|---|---|---|
| **FD-1** | What is V1's agent? | **A** — accept that V1 stops at S-5 until hardware exists. The V1 contract is unchanged, a real commissioned physical agent is required for S-6, and RobotX hardware is in active development |
| **FD-2** | RQ-2, the charger | **YES** — one real plug-in location will be provided. **NOT YET SUPPLIED.** This is an authorisation, not a supply |
| **FD-3** | RQ-5, the second person | **NO FOR NOW** — there is no second Safety approver, and there is to be no self-approval. **Satisfiable later by one named person** |

**They are recorded, for signature, in
[`docs/release-decisions/RD-2026-09-05-02-v1-agent-boundary-and-simulation-track.md`](../release-decisions/RD-2026-09-05-02-v1-agent-boundary-and-simulation-track.md).**
That record is the decision; this section is the reconciliation of this file to it. **It is
drafted and unsigned**, and until the owner completes its author and date fields it does not
satisfy S-3's own closure requirement.

### 13.2 Correction to §12.8 option A — **"S-3 closes as far as one person can take it" is wrong**

Option A's text, as offered at §12.8 and as accepted, contains one clause that does not survive
contact with the contract:

> *"S-1, S-2, S-5 and S-8 close; **S-3 closes as far as one person can take it**; S-4, S-6 and S-7
> are recorded as awaiting hardware…"*

**S-3 does not close at all, to any degree.** It is a single stop condition over **28** inputs
(§5.4 of `V1_IMPLEMENTATION_CONTROL.md`), and §I.2 admits no partial satisfaction of any of the
eight. What one person can supply today is **13 provisional cost values** (§11.7) plus, once
FD-2's location is named, the charger and its return-leg rate — and even the most favourable
reading of that leaves **13 of 28 rows plus 3 owner decisions supplied and S-3 NOT MET.**

**Why the phrasing matters rather than being a quibble.** "Closes as far as one person can take
it" is the exact shape of sentence this programme has recorded going wrong six times: a partial
quantity stated in the vocabulary of a completed one. A future reader summarising option A would
carry "S-3 closed (partially)" forward, and one summary later that becomes "S-3 closed". **S-3 is
NOT MET, and supplying 13 rows leaves it NOT MET.**

The rest of option A stands unamended, including its concluding clause — that awaiting hardware is
*"a true and defensible state to be in"* — which this section does not weaken.

### 13.3 §12.9's execution order, re-derived under the three answers

**§12.9 is not edited.** Its ordering was derived before the answers existed and remains the record
of that derivation. The order that governs now is §11 of the approved decision plan, and the
material differences are these:

| Change | Detail |
|---|---|
| **Steps 1–3 are promoted** | Recording the decisions, **N-1** (`targetSoc`) and **N-2** (the §7.5 nineteen-field inventory) now come first. All three need nothing from anyone, and §12.9 placed none of them in its first three positions because none of them existed as a named item when it was written |
| **§12.9 step 5 is stood down** | *"Obtain and deploy a self-hosted traversal engine"* — §12.7 already named it the most expensive prerequisite on the list, and under FD-1 = A it buys progress toward conditions that cannot close until hardware exists. It is not cancelled; it is **not next** |
| **§12.9 step 7 is stood down** | *"Supply the specification data — mass, container geometry, CoG, mobility columns, environmental envelope, pack curves, energy model, ambient source, reliability basis, hazard source"* — the same reasoning, and §12.7's own first row says so: collect them when the answers are in, not before |
| **§12.9 step 10 is stood down** | *"The §7.5 agent-record programme"* — explicitly **blocked on FD-1**, and FD-1 = A means blocked on hardware. §13.5 carries it onto the sheets rather than leaving it unlisted |
| **What replaces them at the front** | §11 steps 5 and 6 for the owner (the charger location **and** its rate, both or neither; and the 13 provisional values), then S5-2…S5-4, then the V1-ENG simulation track (SIM-1…SIM-5), which discharges no stop condition |

### 13.4 §12.10's hard boundary is **DISCHARGED**

§12.10 set one condition and it is met:

> *"The earliest legitimate point to begin collecting is the moment FD-1, FD-2 and FD-3 are
> answered, and not one item before."*

**All three are answered, so collection may begin — for a strictly bounded set.**

| May be collected now | May **NOT** be collected now |
|---|---|
| **A13** — the depot charger: a place, a region, `isDepot` | Every **hardware-gated** row (§13.5). Collecting them closes rows that lead nowhere until RobotX exists |
| **A14** — the per-profile return-leg Wh/metre. **A13 and A14 together, both or neither** — the estate and the rate are one supply act (§11.4, §N.2) | The traversal source and its five routing rows — stood down by §13.3 |
| **P5** — the 13 provisional cost values, sole named author, one config version. §12.10's own named exception, unchanged: they need no second person, no hardware, no engine and no deployment | The specification data of §12.9 step 7 — stood down by §13.3 |

**§12.10's exception is not widened by this section.** P5 was always collectible; what has changed
is that A13 and A14 join it, because FD-2 = YES is the authorisation §12.10 was waiting on.

### 13.5 §12.6's §7.5 finding is carried onto the owner sheets

§12.6 established that S-6's real prerequisite is a physical robot and an operating control plane,
and recorded that **this requirement is on none of the owner-facing lists**. That was the finding
that decided the verdict, and leaving it unlisted is the defect §12.6 itself named — *"what never
happened is that conclusion being carried onto the sheets the owner is asked to fill in."*

**It is carried now.** The nineteen §7.5 agent-record fields were inventoried field by field
against `prisma/schema.prisma` and `src/` on 2026-09-05 and the result is
`V1_IMPLEMENTATION_CONTROL.md` **§9.2**. Every row of that inventory that is not a repository
defect is to appear on `V1_OWNER_ACTION_CHECKLIST.md` marked **"awaiting hardware (FD-1 = A) — do
not collect"**, rather than being absent from it.

**Two measured corrections to §12.6, recorded here because §12.6 is not edited:**

1. **§12.6's list is right about the schema and understates the read paths.** Two of the nineteen —
   `supportedFirmwareByMissionType` and `hardwareRevision` — were **columns that already existed**
   on the `AgentClass` row the composition root already fetched, dropped by the snapshot mapper.
   They were repository defects, not owner inputs, and they are fixed. **They never belonged on an
   owner sheet.**
2. **`AgentCertificate` and `CapabilityAttestation` do not have live producers.** The writer
   functions exist and **nothing in `src/` calls them**. So the attested-firmware family is a data
   gap behind hardware, not a read path anyone can write today — and any sheet that listed it as
   collectible would be asking for something that has nowhere to be stored.

**Nothing in this section closes a stop condition, changes a count, or moves a gate. The score is
3 of 8.**
