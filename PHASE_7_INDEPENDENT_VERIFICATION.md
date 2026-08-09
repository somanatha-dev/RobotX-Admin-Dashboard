# Phase 7 — Independent Software Verification Report

**Verifier role:** Independent Software Verification Engineer (did not implement Phase 7; did not
redesign, optimise, simplify, or implement anything during this review)
**Date:** 2026-08-04 · **Branch:** `feature/dashboard` · **Working tree at verification:** `cf9103f`
(Phase 5 committed) + uncommitted Phase 6 and Phase 7 changes, unchanged from the state
`PHASE_7_IMPLEMENTATION_REPORT.md` was written against
**Method:** Every verdict below is backed by a command this review ran, a file this review read in
full, a spec quotation checked line-by-line against the file it is claimed to match, or an
independent regeneration (Prisma diff, structural JSON diff, direct module invocation, full
test/gate runs) executed against the live, unmodified shipped code.
`PHASE_7_IMPLEMENTATION_REPORT.md` was read to understand what was claimed and was **not** trusted
for any claim reported here as PASS, PARTIAL, or FAIL.

---

## 0. Scope discipline and the git-history limitation, stated once

This review covers Phase 7 only: `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` §14 (Battery and Energy
Strategy) and §15 (Payload Strategy) in full, cross-referencing §13.4, §13.5, and §20.3 item 3 —
against `IMPLEMENTATION_EXECUTION_PLAN.md` §3 "PHASE 7" and its 21-item checklist.

**A limitation this review will not paper over.** Phases 0 through 7 have never been committed as
separate commits — `git log` shows the last commit as `cf9103f "3rd aug 2026 phase 5 implemented and
verified"`, and every file Phase 6 and Phase 7 created is `git status`-untracked (`??`) or shows as
a modification against a *pre-Phase-6* baseline. This means the technique Phase 6's own review used
to prove "zero predicate modules changed" — a direct `git diff` against a known-good baseline — is
**not reproducible for this review** the same way, because there is no committed snapshot of
"Phase 6, complete, before Phase 7 started" to diff against. This review says so rather than
re-running a command that would silently prove nothing. In its place, Part 3 below verifies the
same claim by independent, structural means: reading every one of F22–F26/F34/F35 in full and
comparing their content, field-for-field, against Phase 6's own independent verification report's
transcriptions (which *was* checked against a real baseline) and against `register.js`'s current
class/policy table.

`PHASE_0_INDEPENDENT_VERIFICATION.md` still does not exist. This is the same gap every review since
Phase 1 has recorded and not blocked on. Not blocking here either.

---

## PART 1 — Phase 7 checklist (`IMPLEMENTATION_EXECUTION_PLAN.md` §3 "PHASE 7", 21 items)

| # | Item | Verdict | Evidence |
|---|---|---|---|
| 1 | `energy/consumption.js` with all β terms, `β_payload_thermal` over `t_occupied(k)` | **PASS** | Read in full. §14.2's equation transcribed term by term in `legEnergyWh()`; `betaPayloadThermal()` reads `profile.compartmentOccupancy[].occupiedSeconds` and distinguishes a stated-absent thermal class (`wh: 0`) from an unfitted curve (reported missing) — the exact distinction §14.2 draws. |
| 2 | `energy/usable.js` — SoH, `f_temp`, `f_derate`; publish combined conservatism | **PASS** | Read in full. §14.3's five-factor product implemented exactly; `f_derate` divides (checked: a ratio ≥ 1 is required, and the comment explicitly guards the sign convention). `declaredConservatism()`/`assertWithinCap()` read the two published products and the cap. |
| 3 | Enforce `energy.max_combined_conservatism` at publish | **PASS, and independently reproduced as still failing** | `validators.v9CombinedConservatism` exists (Phase 1) and this review invoked `service.validateCandidate({ enforceLaunchGate: true })` directly (Part 11) — it returns `ok: false` with a `V9` BLOCKING finding whose message states `2.0124999999999997 exceeds ... 1.6`. This is the seeded register's own state, not a Phase 7 regression (Part 9). |
| 4 | `energy/wear.js` — DoD-weighted cycle cost into `C_lifecycle` | **PASS** | Read in full. `stressMultiplier()` composes four independently-measured curves; `batteryWear()` returns integer milli-CU via `determinism/fixedPoint.js`. |
| 5 | `energy/reserves.js` — four layers, never traded | **PASS** | Read in full. `assertNoTrade()` is one-sided (a protected layer *rising* is always lawful; only a fall is refused) — independently reasoned to be the correct asymmetry, since a later, more pessimistic route producing more reserve is not a trade. |
| 6 | `energy/tiers.js` — T1/T2/T3 with `α[tier]` **derived** | **PASS** | Read in full. `alphaFor()` refuses to read a hand-set value; the parameter it reads (`energy.shortfall_probability`) is the one `config/derived.js` computes from `energy.event_budget_per_fleet_year` (Phase 1's own derivation, confirmed present, Part 9). |
| 7 | F34 as three simultaneous conditions with binding tier recorded | **PASS** | `f34.js` read in full (Part 3): all three tiers evaluated unconditionally, binding tier by exceedance ratio, unmodified from Phase 6. |
| 8 | `energy/eReturn.js` against the pinned **previous-round** projection | **PASS** | Read in full. Takes a pinned `projection` as input, never queries live state; `staleness()` refuses a projection dated after the round's own decision time (§10.6) rather than trusting it. |
| 9 | `chargingSchedulerClient.js` — never compute a target | **PASS, structurally enforced** | Read in full. `assertNotEngineComputed()` refuses any source string outside `{SCHEDULER, CLASS_DEFAULT}`. `resolveTargetSoc()` has exactly two return branches and no third. Grepped the whole engine tree for a target-SoC computation outside this module — none found (Part 11). |
| 10 | Priced-request path to the Scheduler (refusable, recorded) | **PASS** | `buildRequest()` requires a price; `recordDisposition()` has three outcomes including `UNANSWERED`, distinguished from `REFUSED` — read in full and independently agreed this is the correct distinction (silence is a broken integration, refusal is a business outcome). |
| 11 | `energy/chargeCurve.js` — nonlinear `P_charge` | **PASS** | Read in full. `timeToChargeSeconds()` integrates by fixed-step midpoint rule (not adaptive — correctly justified by §9.6 replay-determinism, since an adaptive scheme's step placement is not floating-point-stable across versions). |
| 12 | `energy/midMission.js` — the five §14.8 rows against tier budgets | **PASS** | Read in full. `ROWS` transcribes §14.8's table verbatim; `assess()` tests most-severe-first; `budgetEvent()` returns `countsAgainstBudget: true` unconditionally for every counting row, including the T3 controlled-stop case §14.8 insists must still count. |
| 13 | Charger-reachability cache keyed with the projection version | **PASS** | `chargerReachabilityCache.js` read in full. `key()` refuses to build a key missing `projectionVersion`; `assertVersionInKey()` is a second, independent check available to callers. |
| 14 | `payload/spec.js`, `container.js` (aperture separate), `loadState.js` (per stop) | **PASS** | All three read in full. `fitsAperture()` and `fitsInternal()` are genuinely two functions over two different dimension sets; `itemMassForFeasibilityKg()`/`itemMassForEnergyKg()` are two functions rather than one with a flag, matching §15.1's own reasoning for why a flag is the wrong shape. |
| 15 | `payload/packing.js` — tiers 1–4; tier-3 exhaustion ⇒ `INDETERMINATE`/`DENY` | **PASS** | Read in full. `BUDGET_EXHAUSTED` is a distinct verdict, never folded into `INFEASIBLE`; `evaluateMemoised()` explicitly declines to cache a `BUDGET_EXHAUSTED` result. |
| 16 | `custodyEvidence.js` — manifest reconciliation at every custody event | **PASS** | Read in full. Re-exports `verification.LEVEL`/`requiredLevelFor` rather than restating the L0–L3 ladder — correctly avoiding a second definition of "sufficient evidence" (independently confirmed by reading `supervision/verification.js`'s ladder and finding it is the same one). `assertReleasable()` treats an unreported compartment sensor as non-releasable, not as empty. |
| 17 | Align `simulation/constants.js` / `VirtualRobot.js` with the server model | **PASS** | Diffed in full (Part 6). `VirtualRobot` imports `engine/energy/chargeCurve` directly — the same module, not a parallel reimplementation. |
| 18 | REST `GET /api/diagnostics/energy/:agentId` | **PASS** | Read in full, route and controller. Behind `authUser`, rate-limited (120/min, its own key prefix), read-only. Reports `E_usable` factor-by-factor, all four reserve layers unsummed, both conservatism products against the cap, and labels `E_return`/`E_contingency` `planDependent: true` rather than fabricating a number for them. |
| 19 | Tests: conservation, charge-curve integration, tiers independently, no-trade | **PASS** | `energyModel.test.js` (96 tests) read/spot-checked (Part 8) against the severity-inflation, Gaussian-variance, and no-trade claims — all independently confirmed to test what they claim. |
| 20 | Simulation: realised T1/T2 rates match budgeted rates | **PASS, independently re-run** | `energySimulation.test.js`'s 60 000-mission run re-executed as part of this review's own `test:engine` run (Part 11); additionally read in full (Part 8) — it includes a genuine counterfactual (a fleet planned on the mean alone *breaches* its T1 budget), which is what makes the passing result mean something rather than being a tautology. |
| 21 | **Gate:** no percentage-based energy floor anywhere in the decision path | **PASS, independently re-derived** | This review ran its own scan (Part 11) rather than trusting the suite's: `grep -rn "dtaro.constants\|BATTERY_THRESHOLD\|CHARGING_INTERRUPT_BATTERY" src/engine` → zero matches outside the legacy shim itself. `interruptionPermitted()`'s body independently confirmed to contain neither `soc` nor `battery` as a token. |

**Checklist result: 21/21 PASS.**

---

## PART 2 — Execution-plan compliance

### 2.1 Prerequisites and sequencing

`IMPLEMENTATION_EXECUTION_PLAN.md` states Phase 7's prerequisites as **Phases 1, 2** and its
"must precede" as **Phases 6, 8**. Phase 6 has already landed (and its own independent verification
recorded the prerequisite violation as its leading, disclosed, non-blocking issue). This review
confirms the situation is now resolved, not merely re-flagged:

- Phases 1 and 2 are present and load-bearing: `energy.shortfall_probability`,
  `energy.contingency_quantile`, and 15 of §14/§15's parameters were already registered by Phase 1
  (independently confirmed present in `src/engine/config/register/*.json` and readable via
  `service.defaultSnapshot()`, Part 11); the `EnergyModel`, `ContainerModel`, `Compartment`,
  `PayloadSpec`, `PayloadManifest` tables Phase 2 created are the ones Phase 7's new tables extend
  or sit beside (confirmed by reading `schema.prisma`'s existing models before the Phase 7 diff).
- Phase 6's seven waiting predicates (F22–F26, F34, F35) now have real producers, and this review
  independently confirmed the shapes agree exactly (Part 3) — not merely that both sides claim they
  do.
- **No predicate module changed to accommodate Phase 7.** `register.js`'s current class/policy/
  volatile table for F22, F23, F24, F25, F26, F34, F35 (re-queried directly, Part 11) is
  byte-identical to the table Phase 6's own independent verification transcribed from the frozen
  specification and checked cell-by-cell. The seven predicate files were read in full for this
  review and match Phase 6's own quotations of their reasoning verbatim (the exceedance-ratio
  comparison, the dual-class governance, the corroboration ordering are unrelated to F22–F26/F34/F35
  but confirm the file set is Phase 6's unmodified work).

### 2.2 No Phase 8+ mechanism present

```
$ find src/engine/plan src/engine/solve src/engine/pricing src/engine/cost src/engine/candidates -type f
src/engine/plan/.gitkeep
src/engine/solve/.gitkeep
src/engine/pricing/.gitkeep
src/engine/cost/exchangeRates.js      (Phase 1)
src/engine/cost/units.js              (Phase 1)
src/engine/candidates/.gitkeep

$ find src/engine/reliability -type f
src/engine/reliability/.gitkeep
```

`plan/`, `solve/`, `pricing/`, and `candidates/` hold nothing beyond `.gitkeep`; `cost/` holds
exactly Phase 1's two files. **`reliability/` is empty**, which this review checked specifically
because `IMPLEMENTATION_EXECUTION_PLAN.md`'s §5.3 capability table lists reliability against
"Phase 7, 16c" in one row — a plausible place for scope to leak. It has not: Phase 7's own 21-item
checklist names `reliability/` nowhere, and §1.8 makes reliability-priced risk Tier 2, gated behind
the `reliability_based_gating` kill switch that belongs to Phase 16c. Building it here would ship a
Tier 2 mechanism inside a Tier 0 phase, which the tier gate (Part 10) would have caught in any case.

`tests/engine/phase0Scaffold.test.js`'s ownership test (`PHASE_7_OWNED = ["energy/", "payload/",
"routing/chargerReachabilityCache.js"]`) was read and independently re-run as part of `test:engine`
(Part 11) — passing.

### 2.3 `server.js` and worker scheduling unchanged

```
$ git diff -- server.js
(no output)
```

Neither `chargerReachability.worker.js` nor `energyCalibration.worker.js` is imported by
`server.js` or any file outside its own module and its own tests (`grep -rln`, Part 11).
`ENGINE_ENABLED=false` in both `.env` and `.env.benchmark`, confirmed by direct read.

**Verdict: PASS.** The Phase 6 prerequisite violation is resolved, not merely disclosed a second
time; no Phase 8 functionality exists; nothing new runs.

---

## PART 3 — Architecture compliance: the seven predicate/producer boundaries, checked field by field

This is the check this review weighted most heavily, because it is the one a superficial read is
most likely to get wrong: both sides *say* they agree, and the only way to know is to read the
literal field names each side reads and writes.

| Predicate reads | Phase 7 producer writes | Match |
|---|---|---|
| `plan.loadState[].massUpperBoundKg` (F22) | `loadState.project()`'s per-stop series carries `massUpperBoundKg` explicitly, at the tolerance upper bound (`spec.itemMassForFeasibilityKg`) | ✅ exact field name, exact reading (upper bound, not expectation) |
| `plan.packing.{verdict, tier, bindingConstraint}` (F23) | `packing.result()` returns exactly `{verdict, tier, bindingConstraint, thermalAssignment, compartmentLoads, loadingPlan, nodesExplored, diagnostics}` | ✅ — and F23's three-way verdict mapping (`FEASIBLE`→SATISFIED, `INFEASIBLE`→VIOLATED, `BUDGET_EXHAUSTED`→INDETERMINATE) matches `packing.VERDICT`'s three values exactly, independently re-derived by reading both files rather than trusting either's naming |
| `plan.loadState[].cog.{withinEnvelope, envelopeMarginMm, longitudinalMm, lateralMm, heightMm}` (F24) | `loadState.project()`'s per-stop `cog` object carries exactly these five fields | ✅ exact |
| `plan.packing.thermalAssignment.{compartmentId, thermalMinC, thermalMaxC, activeThermal, thermalHoldSeconds}` (F25) | `packing.thermalAssignmentFrom()` returns exactly these fields plus `itemIds` | ✅ exact |
| `plan.packing.compartmentLoads[].items[].{hazardClasses, securityClass, segregation, lockClass}` (F26) | `packing.compartmentLoadsFrom()` returns `hazardClasses`, `securityClass`, `segregation`, `massKg`, `massToleranceKg`, `volumeLitres`, `thermalMinC`, `thermalMaxC` per item, and `lockClass` per compartment | ✅ for every field the predicate's `SATISFIED`/`VIOLATED` paths actually reach — **with one exception, see Finding 1 below** |
| `plan.energy.tierProbabilities.{T1,T2,T3}` (F34) | `tiers.planEnergyFragment()` returns `{tierProbabilities, chargerReachability, bindingTier, tiers}` | ✅ exact |
| `plan.energy.chargerReachability.{basis, reachable, projectionVersion, chargerId, eReturnWh, surplusWh}` (F35) | `eReturn.evaluate()`'s verdict carries exactly these fields, plus `considered` | ✅ exact, including the `BASIS` enum (`PINNED_PROJECTION`/`DEPOT_ONLY`) transcribed identically in both `eReturn.js` and `f35.js` — checked they are two independent transcriptions of the same two strings, not one importing the other, and confirmed identical |

**Register cross-check, independently re-queried (not read from a report):**

```
$ node -e '... predicate("F22"|"F23"|"F24"|"F25"|"F26"|"F34"|"F35") ...'
F22 I DENY false NONE
F23 I DENY false NONE
F24 I DENY false NONE
F25 C/R DENY false CLASS
F26 R DENY false CLASS
F34 I DENY true NONE
F35 I DENY true NONE
```

Identical, field for field, to Phase 6's own independent verification report's Part 3 table for
these seven rows. No drift.

### Finding 1 (LOW, informational) — `F26`'s `item.requiredLockClass` is read but never produced

`f26.js:148` reads `item.requiredLockClass` to check whether a security-classified item requires a
*specific* lock class beyond "a lock class present and equal to the item's `securityClass`". This
review grepped the entire source tree:

```
$ grep -rn "requiredLockClass" src/ tests/
src/engine/feasibility/predicates/f26.js:148
src/engine/feasibility/predicates/f26.js:149
src/engine/feasibility/predicates/f26.js:152
src/engine/feasibility/predicates/f26.js:155
```

No producer — not `payload/spec.js`'s `normaliseItem()`, not `payload/container.js`'s
`admissibleCompartments()`, not `payload/packing.js`'s `compartmentLoadsFrom()` — ever sets this
field. It is therefore always `undefined` → `null` at F26's read site, and the branch at
`f26.js:149` (`requiredLockClass !== null && requiredLockClass !== lockClass`) can never fire.

**This is not a safety gap.** `container.satisfiesSecurityClass()` — the function every placement
path (`tierTwo`, `tierThree`, via `admissibleCompartments`) calls before an item may be placed in a
compartment at all — already requires `compartment.lockClass === item.securityClass` **exactly**,
not "any lock class." By construction, every item that reaches `compartmentLoads` is already in a
compartment whose lock class equals its security class, so F26's dead branch would never have found
a violation the upstream admission logic did not already prevent. This review independently traced
that invariant through both files to confirm it, rather than assuming it from the naming.

*Affected:* `src/engine/feasibility/predicates/f26.js` (Phase 6, unmodified) and the absence of a
`requiredLockClass` field anywhere in Phase 7's payload model.
*Recommendation:* either remove the dead branch and its field from F26 (a Phase 6 change) or add
`requiredLockClass` to `payload/spec.js`'s item shape if a future payload class genuinely needs a
security class to admit more than one matching lock class (a Phase 7 change). Neither is required
before Phase 8, since the current behaviour is conservative, not permissive.

**Verdict: PASS**, with Finding 1 as the only discrepancy found across seven predicate/producer
boundaries checked field by field.

---

## PART 4 — Database review

### 4.1 Independent regeneration of Prisma's own SQL

```bash
npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script
```

run independently against the current `schema.prisma`. The six `CREATE TABLE` statements for
`EnergyModelParams`, `BatteryState`, `Charger`, `ChargerReservation`,
`ChargerAvailabilityProjection`, and `PackingResultCache`, plus every associated `CREATE INDEX` and
`ADD CONSTRAINT` (foreign keys), were extracted from the regenerated output and compared line by
line against the hand-written migration `20260804180000_energy_and_payload_models/migration.sql`.

**Identical**, table for table, column for column, index for index, foreign key for foreign key —
independently reproduced, not merely repeated from the implementation report's claim.

### 4.2 Additivity, re-checked with `--ignore-all-space`

`git diff --stat -- prisma/schema.prisma` reports 863 insertions / 506 deletions against the Phase
5 baseline — alarming at face value, and this includes both Phase 6's and Phase 7's accumulated,
uncommitted work (Part 0). `git diff --ignore-all-space` collapses this to **360 insertions, 3
deletions**. This review read every hunk of the whitespace-normalised diff (Part 2 of this document
reproduces the relevant sections): the three deletions are a blank-line removal before a comment
block, a reordering of two `@@index`/`@@unique` lines in the pre-existing `Location` model (same
attributes, different order — semantically inert), and are unrelated to anything Phase 7 touched.
Every substantive insertion is one of Phase 6's two rejection-telemetry models or one of Phase 7's
six energy/payload models, plus small, genuinely additive back-relation fields on `Region`, `Site`,
`AgentClass`, and `Agent` (`chargers`, `chargerProjections`, `energyModelParams`,
`batteryState`, `chargerReservations` — none of which adds a column to the existing table side of
the relation, confirmed by reading each hunk).

### 4.3 CHECK constraints, independently re-derived

Five hand-written constraints, each checked against the code path it backstops rather than taken on
trust:

- `BatteryState_soh_fraction` (`soh IS NULL OR (soh > 0 AND soh <= 1)`) — matches `usable.js`'s own
  validation of the `soh` factor (`source.soh <= 0 || source.soh > 1` is rejected there too); the
  schema constraint is a second, independent enforcement of the same bound, which is the
  discipline §10.3.2 sets for the commitment core and this migration's own preamble claims to
  follow — confirmed it actually does.
- `BatteryState_kappa_positive` (`kappa > 0`) — matches `consumption.updateKappa()`'s own guard
  (`previousKappa <= 0` is refused) and `BatteryState`'s Prisma default of `1`, which is the
  identity value the settlement worker seeds an agent with no history at (read in
  `energyCalibration.worker.js`).
- `ChargerReservation_target_soc_fraction` (`targetSoc >= 0 AND targetSoc <= 1`) — a boundary check
  independently useful given `targetSoc` crosses the Charging Scheduler service boundary, exactly
  the place the migration's own comment names as where a unit confusion (80 vs 0.8) would survive
  review.
- `ChargerReservation_window_ordered` (`reservedUntil > reservedFrom`) — a correct backstop; a
  zero-width or inverted window would make F18's "an agent reserved for charging is not available"
  unevaluable.
- `PackingResultCache_verdict_decided` (`verdict IN ('FEASIBLE','INFEASIBLE')`) — independently
  confirmed against `packing.evaluateMemoised()`'s own guard (`computed.verdict !==
  VERDICT.BUDGET_EXHAUSTED` before writing), so the schema and the application code enforce the
  same rule from both ends, which is what makes a future caller bypassing the application code
  still unable to memoise an indecision.

**Verdict: PASS.** No live-database application was possible in this environment (`prisma validate`
passes; the same `P1000`-class limitation every phase since Phase 2 has recorded). The SQL is
independently confirmed to be Prisma's own generated output plus exactly the five documented
hand-written constraints, each independently verified against the application-level rule it
backstops rather than merely against its own comment.

---

## PART 5 — API review

`GET /api/diagnostics/energy/:agentId` read in full, including the route file and the controller.

| Property | Verdict | Evidence |
|---|---|---|
| Behind existing auth, no new mechanism | **PASS** | `router.use(authUser)` in `diagnostics.routes.js`, the same middleware `getRejections` (Phase 6) already uses |
| Rate-limited, own key prefix | **PASS** | `createRateLimiter({ windowMs: 60_000, limit: 120, keyPrefix: "diag_energy" })` — a separate bucket from `diag_rejections`, correctly reasoned (point read of one agent vs. an aggregation query) |
| Read-only | **PASS** | Controller body read in full: `prisma.agent.findFirst` with `include`, zero writes |
| Honest about what it cannot say | **PASS, and independently confirmed non-trivial** | `E_return`/`E_contingency` are reported `planDependent: true` with no number, and `fTempBasis` is explicitly labelled `"RATED_TEMPERATURE"` rather than silently substituting an assumed ambient. This review checked that the labelling is not decorative: `usableFactors.fTemp` is hard-coded to `RATED_TEMPERATURE_F_TEMP = 1` (the identity), so the reported `E_usable` is genuinely an upper bound, not a number dressed up as a live reading |
| No existing endpoint's shape changed | **PASS** | `git diff -- src/routes/index.js` shows only an added `require` and an added `router.use` for `diagnostics.routes.js` (Phase 6), and Phase 7 adds nothing further to this file — the new route is registered inside `diagnostics.routes.js` itself |

**Verdict: PASS.**

---

## PART 6 — Runtime behaviour

| Claim | Verdict | Evidence |
|---|---|---|
| No round consumes any Phase 7 output | **PASS** | `grep -rln "energy/tiers\"\|payload/packing\"\|payload/loadState\"\|energy/reserves\"\|energy/eReturn\"" src` outside `src/engine/`, `src/workers/`, and `src/controllers/diagnostics.controller.js` → no matches |
| `server.js` unchanged | **PASS** | `git diff -- server.js` empty |
| Neither new worker started | **PASS** | `grep -rln "chargerReachability.worker\|energyCalibration.worker"` → only the worker files themselves |
| `ENGINE_ENABLED` still false | **PASS** | Read directly: `.env:12` and `.env.benchmark:22` both `false` |
| Determinism (T6, I10) — no clock, no random, in the nine energy + five payload modules | **PASS, independently re-scanned** | `gate:tenets` re-run (Part 11) reports 182 modules, no violations; this review additionally spot-read `consumption.js`'s Gaussian CDF/quantile functions, which use only fixed rational-approximation coefficients (Part 8) — no `Math.random`, no `Date.now()` anywhere in the nine files |
| Backwards compatibility — VirtualRobot | **PASS, verified by reading the fallback branch, not assumed from the report's framing** | `_assessOfferEnergy()`'s `basis: "LEGACY_PERCENTAGE"` branch is taken whenever `energyReserveParams` is absent from the offer (every legacy `TASK_ASSIGN`), and its thresholds (`BATTERY_CRITICAL_THRESHOLD`, `CHARGING_INTERRUPT_BATTERY`) are the same identifiers the pre-Phase-7 code used, unrenamed. Legacy lane 22/169, independently re-run (Part 11) |

**Verdict: PASS.**

---

## PART 7 — Concurrency and cache-authority review

Phase 7 introduces three new cache key families and one new process-local map extension
(`robotStateCache.js`'s `predicateCache`, actually a Phase 6 addition — confirmed by its own header
comment naming §7.6, not §14/§15). All three Phase 7 Redis families were checked against the
cache-authority rule (§3.3, invariant I16):

| Cache | Read-failure behaviour | Write-failure behaviour | Verdict |
|---|---|---|---|
| `engine:charger:proj:{version}` | falls back to DB (comment states this; the module itself only mirrors, it does not read this key back) | silent (`catch {}` in `mirrorProjection()`) | **PASS** |
| `engine:charger:reach:{cell}:{profile}:{bucket}:{version}` | `read()` returns `{hit:false}` on a thrown error or a version mismatch inside the stored entry itself — read in full, both failure paths traced | silent (`write()`'s `catch`) | **PASS** |
| `engine:pack:{containerConfig}:{itemSignature}` | `evaluateMemoised()`'s `try/catch` around `kv.get` falls through to full recomputation | silent, and additionally **refuses to write `BUDGET_EXHAUSTED`** | **PASS, and stricter than the minimum I16 requires** |

**The version-in-key discipline, independently stress-checked.** `chargerReachabilityCache.read()`
does not only trust the key it was asked to read — it separately checks that the *entry's own*
`projectionVersion` field matches the version the caller asked for (`read()`:
`String(parsed.projectionVersion) !== String(parts.projectionVersion)` → miss). This is a second,
independent check beyond the key string itself, and this review verified it actually matters: a key
collision or a caller passing a stale `parts` object with a correct-looking key but stale
expectations would still be caught by this second check. Belt-and-braces, correctly reasoned.

**Verdict: PASS.** No Phase 7 cache can produce a verdict on a read failure; none of the three
caches is on any path that runs today (Part 6).

---

## PART 8 — Test and simulation review (spot-read against the underlying claims, not the report's framing)

This review does not re-read all 2 767 lines of the four new test files; it selected the tests
behind the report's most consequential and most falsifiable claims and read them against the source
they are supposed to be testing.

- **The Gaussian-variance and severity-interpolation claims** (`energyModel.test.js`, read in the
  relevant section). `"the variance is inflated, not the standard deviation"` independently checked
  against `consumption.predictiveDistribution()`: the product of the three inflation multipliers is
  applied to `varianceWh2`, and `sdWh` is its square root — so a test asserting `sdWh` scales by
  `√product` while `varianceWh2` scales by `product` is asserting the correct, non-trivial
  distinction (conflating the two at T3's 1e-7 tail is not a rounding error). `"an unstated severity
  inflates in full"` independently checked against the source: `predictiveDistribution()`'s
  `severity` lookup defaults to `1` (not `0`, not the multiplier's own identity) when a source's
  severity is unstated — read directly at `consumption.js:428-431` — confirmed the test exercises
  the correct branch.
- **The occupancy-interval defect and its fix** (`payloadModel.test.js` + `energyModel.test.js`,
  read). §12.2 of the implementation report discloses a defect found during testing: sampling
  membership per stop would close a conditioned interval at the *pickup* on a two-stop plan (a
  zero-length interval), rather than recording the true load/unload event times. This review read
  `loadState.js`'s `markOccupancy()` and confirmed the fix is real, not merely claimed: occupancy is
  recorded on `EFFECT.LOAD`/`EFFECT.UNLOAD` **events** as they are processed in the per-stop loop,
  not derived after the fact from onboard-set membership. The corresponding test
  (`"the occupancy it produces is what the consumption model charges β_payload_thermal over"`)
  independently re-run as part of `test:engine` (Part 11) and confirmed to assert the physical
  property (`withConditioning.wh` strictly greater than `without.wh`), not merely a return shape —
  which is the class of test that would have caught the original defect and would catch a
  regression of it.
- **The 60 000-mission simulation and its counterfactual** (`energySimulation.test.js`, read in
  full, Part 1 item 20). The counterfactual test — a fleet admitted on the deterministic mean alone,
  which *breaches* its T1 budget — is not decorative: without it, a passing rate-bound test proves
  only that the chosen thresholds were loose, not that the reserve model is doing anything. This
  review confirms the counterfactual actually removes the mechanism under test (the contingency
  reserve term) rather than merely relabelling the same computation, by reading both code paths
  side by side.
- **The percentage-floor source scan** (`energySimulation.test.js`, read in full, Part 1 item 21).
  Independently re-run as its own `grep` (Part 11) rather than trusted from the suite's own
  assertion, with the same result.

**Verdict: PASS.** Every test this review selected for depth was found to test the property it
claims to, not a weaker proxy for it.

---

## PART 9 — The V9 combined-conservatism finding, independently reproduced

The implementation report's single most consequential self-disclosed item: the seeded parameter
register cannot publish, because `energy.combined_degraded_conservatism` exceeds
`energy.max_combined_conservatism`. This review did not accept the arithmetic as printed — it
re-derived it two ways.

**1. Direct parameter resolution:**

```
$ node -e '... snap.resolve("energy.combined_nominal_conservatism") ...'
nominal:  1.4375
degraded: 2.0124999999999997
cap:      1.6
```

**2. Direct invocation of the publish-time validator itself**, not merely the resolved values:

```
$ node -e '... service.validateCandidate({ enforceLaunchGate: true }) ...'
ok: false
[{ "id": "V9", "severity": "BLOCKING", ...,
   "message": "combined degraded energy conservatism 2.0124999999999997 exceeds
                energy.max_combined_conservatism 1.6 (nominal 1.4375 ×
                route.degraded_reserve_factor=1.4 × degraded.reserve_factor=1). ..." }]
```

Both independently confirm the report's arithmetic exactly, including the specific factor
breakdown. This review additionally traced **whose parameters these are**, to verify the report's
claim that this is "pre-existing since Phase 1" and not something Phase 7 introduced:
`energy.charger_availability_margin` (1.15), `energy.uncalibrated_reserve_factor` (1.25),
`energy.f_derate` (1.0), and `route.degraded_reserve_factor` (1.4) are not among the 12 new
parameters this review's structural diff of `supplementary.json` (Part 10) attributes to Phase 7 —
they are among the "15 of §14/§15's parameters already registered" the report says Phase 1 supplied.
`degraded.reserve_factor` (1.0, the identity — contributing nothing to the overflow) *is* one of
Phase 7's new entries, confirming Phase 7 registered it at a neutral default rather than tuning it
to either cause or hide the overflow.

**Independent assessment of the disposition.** The report's choice — report the finding, propose
three named options, change nothing — is the correct one given the stated discipline (a Safety-class
parameter is not this phase's to change). This review agrees with the report's own framing that
option (c) — asking whether `route.degraded_reserve_factor` and `degraded.reserve_factor` compensate
for the same uncertainty twice — deserves priority, because §14.3 explicitly calls exactly that
situation "a defect, not extra safety," and `degraded.reserve_factor`'s *current* value of 1.0 means
the two factors are not yet actually double-counting anything in the *current* default configuration
— the overflow is driven entirely by `route.degraded_reserve_factor` (1.4) stacking onto the nominal
product (1.4375), which is a single degradation multiplier compounding onto four already-multiplied
nominal factors, not (yet) two factors for one cause. This is a finding this review reached
independently by decomposing the arithmetic, not a restatement of the report's own text.

**Verdict: PASS.** The finding is real, correctly attributed to Phase 1 (not Phase 7), correctly not
worked around by a Safety-class parameter change, and correctly escalated. Not blocking Phase 8, for
the same reason Phase 6's predicates already deny conservatively in this state (Part 12).

---

## PART 10 — Configuration register review

Structural JSON diff (not text diff) between `HEAD:Backend/src/engine/config/register/
supplementary.json` and the working tree:

```
old count: 17   new count: 36
added:     19   removed: 0   changed existing: 0
```

Because `HEAD` predates both Phase 6 and Phase 7 (Part 0), these 19 additions span both phases.
Cross-referencing the implementation report's own "Configuration updates" list for Phase 7 against
the 19 added names isolates exactly **12** as Phase 7's:
`energy.charge_curve_integration_steps`, `energy.kappa_bounds`, `energy.kappa_ewma_alpha`,
`energy.model_residual_cv`, `energy.operational_reserve_wh`, `energy.variance_inflation`,
`payload.mass_discrepancy_tolerance_kg`, `payload.packing_cache_ttl`,
`payload.packing_node_budget`, `route.charger_reachability_k`,
`route.charger_reachability_min_hit_rate`, `route.intra_cell_offset_m` — matching the report's own
"+12 parameters" claim in its Files Modified table exactly. The remaining 7
(`degraded.max_mission_scope`, `degraded.reserve_factor`, `feasibility.negative_cache_ttl`,
`health.required_tier`, `link.min_quality`, `localisation.min_confidence`,
`reliability.max_intervention_rate`) are Phase 6's.

**Zero removed, zero changed.** This is the structural evidence for the report's claim "I did not
change a Safety-class parameter to make a validator pass" (Part 9) — independently confirmed, not
merely taken on the report's word: nothing in the existing 17 entries, including every
conservatism-factor entry the V9 arithmetic depends on, differs by a single character from its
pre-Phase-7 value.

**Verdict: PASS.**

---

## PART 11 — Build and test review, reproduced independently

Every command below was run by this review against the unmodified working tree.

```
$ npm run gates
gate: tier-dependencies (§1.8 rule 2)
  PASS — 185 module(s), 178 governed import edge(s), no Tier 0/1 → Tier 2 dependency.
gate: parameter-register (§22, Appendix A)
  PASS — 108 engine module(s) checked against 172 registered parameter(s); no bare behavioural constants.
gate: tenets (T1 type separation, T6 decision-path determinism)
  PASS — 182 module(s) checked, no violations.

$ npm run test:engine
Test Suites: 40 passed, 40 total
Tests:       1561 passed, 1561 total

$ npm run test:gates
Test Suites: 3 passed, 3 total
Tests:       49 passed, 49 total

$ npm run test:legacy
Test Suites: 22 passed, 22 total
Tests:       169 passed, 169 total
```

**Every number in the implementation report's §12 table reproduced exactly**: 3/3 gates, 40/1561
engine, 3/49 gates lane, 22/169 legacy, 1779 total.

**Migration regeneration**, independently reproduced (Part 4.1):

```
$ npx prisma validate
The schema at prisma\schema.prisma is valid

$ npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script
```

— all six new `CREATE TABLE` statements, their indices, and their foreign keys extracted and
compared line-by-line against the hand-written migration: identical.

**Direct module invocation, outside Jest:**

```
$ node -e 'require("./src/engine/feasibility/register").predicate("F34") ...'
$ node -e '... service.validateCandidate({ enforceLaunchGate: true }) ...'   (Part 9)
```

**Source scans, run directly:**

```
$ find src/engine/plan src/engine/solve src/engine/pricing src/engine/cost src/engine/candidates -type f
$ find src/engine/reliability -type f
$ grep -rln "energy/tiers\"|payload/packing\"|payload/loadState\"" src | grep -v "^src/engine/\|^src/workers/\|^src/controllers/diagnostics"
$ grep -rn "requiredLockClass" src/ tests/
$ git diff -- server.js
$ git diff --ignore-all-space -- prisma/schema.prisma
```

All reproduced above with results matching or (in the `requiredLockClass` case) extending the
implementation report's own claims.

**Verdict: PASS.** Every quantitative claim in the implementation report's test and gate sections
was independently reproduced and matches; the one structural check the report did not perform
(field-by-field predicate/producer shape agreement, Part 3) was performed here and found one
informational, non-blocking discrepancy.

---

## PART 12 — Failure analysis

Nothing in Phase 7 is wired into a running path (Part 6), so as with Phase 6's review, there is no
failure mode in the running system to analyse. The failure mode worth naming is the same one Phase
6's review named and it is now *answerable* rather than hypothetical, because Phase 7 supplies the
missing half:

**If the feasibility gate were wired into a round today (it is not), F22–F26/F34/F35 now have real
producers and would evaluate on genuine plan data**, rather than denying every candidate on
`INDETERMINATE` as they did when Phase 6 alone was live. This is the concrete, checkable
consequence of resolving the Phase 6/7 sequencing gap: the conservative-failure state Phase 6's
review analysed is gone, replaced by a gate that can actually admit a candidate — subject to the one
disclosed blocker (Part 9) that a Safety reviewer, not this phase, must resolve before the register
can be published in production.

---

## PART 13 — Evidence summary

- 9 energy modules and 5 payload modules read in full: `consumption.js`, `usable.js`, `wear.js`,
  `reserves.js`, `tiers.js`, `eReturn.js`, `chargeCurve.js`, `midMission.js`,
  `chargingSchedulerClient.js`, `spec.js`, `container.js`, `packing.js`, `loadState.js`,
  `custodyEvidence.js`.
- `routing/chargerReachabilityCache.js`, both new workers, `diagnostics.controller.js`'s new
  handler, and `diagnostics.routes.js` read in full.
- Seven predicate modules (F22, F23, F24, F25, F26, F34, F35) re-read in full for this review and
  checked field-by-field against their Phase 7 producers — one informational finding (dead
  `requiredLockClass` field, Finding 1).
- Migration SQL independently regenerated via `prisma migrate diff --from-empty` and compared
  table-by-table, index-by-index, foreign-key-by-foreign-key against the hand-written migration —
  identical.
- `schema.prisma`'s whitespace-normalised diff read in full; confirmed additive-only beyond
  formatting collateral unrelated to Phase 7.
- `supplementary.json` structurally diffed by parameter name (not text diff); 12 of 19 additions
  attributed to Phase 7 exactly matching the report's own count; zero removed or changed.
- V9's blocking finding independently reproduced by direct parameter resolution **and** by direct
  invocation of `validatePublish` — both confirm the exact arithmetic the report states, and this
  review additionally traced which parameters are Phase 1's versus Phase 7's.
- All three build gates and all three test lanes re-run from a clean invocation; every number
  matches the report exactly (3/3 gates, 40/1561 engine, 3/49 gates, 22/169 legacy).
- `git diff`/`git diff --ignore-all-space` run directly on every file the report claims as
  "modified" or "additive": `simulation/constants.js`, `simulation/VirtualRobot.js`,
  `cache/robotStateCache.js`, `services/robotValidator.service.js` (confirmed a Phase 6 banner-only
  change, unrelated to Phase 7), `routes/index.js`, `engine/guards/tierAssertions.js`,
  `engine/TIERS.md`, `tests/engine/phase0Scaffold.test.js`, `tests/engine/commitmentSchema.test.js`.
- Directory listings for `plan/`, `solve/`, `pricing/`, `candidates/`, `cost/`, `reliability/`
  independently confirm the Phase 8/16 non-leakage claim.
- Four Phase 7 test suites read in the sections behind their most consequential claims (Gaussian
  variance vs. standard deviation, severity-inflation default, the occupancy-interval defect and
  its fix, the 60 000-mission simulation and its counterfactual, the percentage-floor source scan).

---

## PART 14 — FINAL DECISION

# PASS WITH MINOR ISSUES

Twenty-one of twenty-one checklist items pass. Every energy and payload module was read in full and
found to implement §14 and §15 faithfully — in several places (the Gaussian-choice disclosure, the
severity-default-to-full-inflation rule, the `E_floor`/`E_return`/`E_contingency` layering and its
`assertNoTrade()` enforcement, the target-SoC provenance check) more carefully reasoned than a
literal reading of the specification alone would require. Independent reproduction of every gate and
every test number, independent regeneration of the migration SQL, and an independent field-by-field
check of all seven predicate/producer boundaries Phase 6 was waiting on found the implementation
report's claims accurate, with one addition the report did not itself surface.

### Issues

**1. (LOW, informational, newly found by this review) `F26` reads `item.requiredLockClass`, which
no Phase 6 or Phase 7 producer ever populates, leaving one of its two security-check branches
permanently unreachable.**
*Affected:* `src/engine/feasibility/predicates/f26.js` (unmodified Phase 6 file); the absence of
the field in `src/engine/payload/spec.js` and `src/engine/payload/container.js`'s
`compartmentLoadsFrom()`.
*Independently confirmed consequence:* not a safety gap — `container.satisfiesSecurityClass()`
already enforces an *exact* lock-class match at placement time, so the dead branch would never have
caught a violation the upstream admission logic did not already prevent.
*Recommendation:* either delete the dead branch (a Phase 6 change) or add the field to the payload
model if a future requirement needs it (a Phase 7-scope change). Not blocking Phase 8.

**2. (Informational, already disclosed, independently re-confirmed) The seeded parameter register
cannot publish — V9 blocks on combined degraded energy conservatism 2.0125 against a cap of 1.6.**
*Affected:* the global register's conservatism-factor defaults, none of which Phase 7 changed.
*Independently confirmed:* the overflow is driven by Phase 1's `route.degraded_reserve_factor`
(1.4) compounding onto Phase 1's nominal product (1.4375); Phase 7's own new parameter in this
arithmetic (`degraded.reserve_factor`) is seeded at the identity (1.0) and contributes nothing to
the overflow. Correctly reported rather than silently worked around by editing a Safety-class
value. Escalated to the calibration owner as blocking decision B8, per the report.
*Recommendation:* unchanged from the report's own three options; this review adds no fourth. A
Safety decision, not an engineering one, and not this phase's to make.

**3. (Informational, not a defect, already disclosed) The migration has not been applied to a live
database; no Postgres was reachable in this review's environment either.** Same limitation as every
phase since Phase 2.

**4. (Informational) `PHASE_0_INDEPENDENT_VERIFICATION.md` still does not exist.** Same gap every
review since Phase 1 has recorded and not blocked on.

### Phase 8 may begin.

None of the above blocks it. Issue 1 is cosmetic and conservative in direction. Issue 2 is a
governed Safety decision explicitly out of any implementation phase's authority to resolve
unilaterally, and its consequence — every affected predicate continues to deny rather than admit —
is the same conservative failure mode Phase 6's review already accepted as correct for this state.
Phase 7's own deliverable — the energy and payload models, complete, tested, unwired, and now
verified against their consumers field by field — is what Phase 8's cost function and plan builder
require as an input, and nothing found here changes that.

---

## Appendix — Commands and scripts run for this verification (reproducible)

```bash
cd Backend

# Directory / leakage checks
find src/engine/plan src/engine/solve src/engine/pricing src/engine/cost src/engine/candidates -type f
find src/engine/reliability -type f
grep -rln "energy/tiers\"\|payload/packing\"\|payload/loadState\"\|energy/reserves\"\|energy/eReturn\"" src \
  | grep -v "^src/engine/" | grep -v "^src/workers/" | grep -v "^src/controllers/diagnostics"
grep -rn "requiredLockClass" src/ tests/
grep -rln "chargerReachability.worker\|energyCalibration.worker" src

# Diffs
git diff -- server.js
git diff --stat -- src/simulation/constants.js src/simulation/VirtualRobot.js \
  src/cache/robotStateCache.js src/services/robotValidator.service.js
git diff -- src/routes/index.js src/engine/guards/tierAssertions.js
git diff --ignore-all-space -- prisma/schema.prisma
git diff -- tests/engine/phase0Scaffold.test.js tests/engine/commitmentSchema.test.js

# Migration regeneration and comparison
npx prisma validate
npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script

# Config register structural diff (Node, not text diff)
node -e "const cp=require('child_process');
  const oldJson=JSON.parse(cp.execSync('git show HEAD:Backend/src/engine/config/register/supplementary.json').toString());
  const newJson=JSON.parse(require('fs').readFileSync('src/engine/config/register/supplementary.json','utf8'));
  /* diff by parameter name */"

# V9 finding, reproduced two ways
node -e 'const s=require("./src/engine/config/service"); const snap=s.defaultSnapshot();
  console.log(snap.resolve("energy.combined_nominal_conservatism"), snap.resolve("energy.combined_degraded_conservatism"));'
node -e 'const s=require("./src/engine/config/service"); console.log(s.validateCandidate({enforceLaunchGate:true}).result);'

# Register cross-check
node -e 'const {predicate}=require("./src/engine/feasibility/register");
  for (const id of ["F22","F23","F24","F25","F26","F34","F35"]) console.log(id, predicate(id));'

# Gates and test lanes
npm run gates
npm run test:engine
npm run test:gates
npm run test:legacy
```

*End of Phase 7 Independent Verification Report.*
