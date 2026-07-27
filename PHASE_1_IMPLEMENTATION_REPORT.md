# Phase 1 — Configuration, units, and determinism substrate · Implementation Report

**Phase:** 1 of 16 · **Status:** ✅ **COMPLETE — awaiting independent verification before Phase 2**
**Date:** 2026-07-28 · **Branch:** `feature/dashboard` · **Baseline commit:** `e558243`
**Authority:** `IMPLEMENTATION_EXECUTION_PLAN.md` §3 "PHASE 1" and §7 "Phase 1" checklist
**Specification:** `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` (FROZEN) — §1.3, §3.3, §3.5, §6.4, §8.6, §8.10, §9.6, §14.3, §14.5, §22, Appendix A

> **Phase 2 has NOT been started.** No `Agent`, no `Mission`/`Leg`/`Stop`, no `Commitment`,
> no spatial hierarchy, no domain mappers, no backfill. `ENGINE_ENABLED` remains `false`
> in every environment and no round runs.

---

## 1. Executive summary

Phase 1 delivers the two roots every later phase reads from, and the substrate that
makes any of it replayable:

- **The Config Service (§22)** — a versioned, immutable, scope-resolved, publish-time
  validated configuration store with derived parameters, calibration status, kill
  switches, and operating regimes. **148 parameters** are registered, seeded from
  Appendix A (89), §8.10 (29), the §22.5 switch table (12), the specification's own
  text where Appendix A is non-exhaustive (12), and the two legacy constant files (6).
- **The CU (§1.3)** — an absolute, additive, dimensioned cost unit with exchange rates
  that cannot price the wrong quantity, replacing the baseline's min-max normalised
  dimensionless score.
- **The determinism substrate (§9.6)** — int64 milli-CU arithmetic, canonical total
  orders with the stated tie-break, and content-addressed round input pinning.

Three properties now hold that did not before:

1. **A behavioural constant outside the register fails the build.** The Phase 0
   parameter gate was inert (0 modules, 0 parameters); it is now load-bearing —
   12 engine modules checked against 148 registered parameters.
2. **A derived parameter cannot be hand-set.** `α[tier]`, `energy.contingency_quantile`,
   `Ω_policy`, and both combined-conservatism products are computed by the Config
   Service, and a binding for any of them is rejected at publish.
3. **Every effective value names the scope level that supplied it.** "Why is this
   threshold 34?" has one immediate answer, returned by `GET /api/config/resolve`.

`npm run verify` is green: **3 gates PASS, 38 suites, 490 tests, 0 failures.** The
legacy lane is **169 tests, identical to the Phase 0 baseline** — no legacy test was
modified, skipped, or re-baselined.

**One finding requires a decision before the first production publish** (§7.1): the
specification's own Appendix A defaults for the four energy-domain conservatism
factors compose to 2.0125, above the 1.60 default cap `energy.max_combined_conservatism`,
so validation V9 rejects the seeded register as published. This is the mechanism
working exactly as §14.3 designed it, and resolving it is a Safety-class decision that
Phase 1 must not take on its own.

---

## 2. Objective achieved

The plan's stated purpose:

> Deliver §22 (Config Service), §1.3 (CU and exchange rates), and §9.6 (determinism)
> **before any component that consumes a parameter is written** — so that no phase ever
> introduces a bare constant that has to be retro-registered.

That ordering is now enforced mechanically rather than remembered. Phase 2 cannot
introduce a constant without registering it, because `npm run gate:params` fails the
build, and it cannot introduce one *quietly* because the register entry demands a unit,
a range, a scope, an owner, a change class, a blast radius, and a calibration status
before the constant compiles.

---

## 3. Files created

### 3.1 The parameter register — `src/engine/config/register/*.json` (838 lines, 148 entries)

| File | Entries | Source |
|---|---|---|
| `appendixA.json` | 89 | Appendix A, transcribed with its Scope, Class and Owner columns intact |
| `cost.json` | 29 | §8.10, the cost-function register |
| `killSwitches.json` | 12 | Generated from the §22.5 switch table; agreement asserted in both directions |
| `supplementary.json` | 12 | Parameters the specification's *text* requires that Appendix A's table does not tabulate — each cites the rule that reads it |
| `legacy.json` | 6 | Migrated from `dtaro.constants.js` and `liveness.constants.js` |

By change class: **36 Safety · 49 Policy · 36 Tuned · 19 Structural · 6 Derived · 2 Contractual.**
By calibration status: **29 DERIVED · 96 PROVISIONAL · 23 UNCALIBRATED.**

### 3.2 The Config Service — `src/engine/config/**` (2 430 lines)

| File | Purpose |
|---|---|
| `service.js` | Register loading, snapshot construction, publish, pin, cache-read/DB-authoritative load, boot, register mirroring |
| `resolver.js` | The §22.2 hierarchy, most-specific-wins resolution, and the resolution-explain contract |
| `validators.js` | Publish-time validation: P-series (form, type, range, scope), V1–V10 (§22.1 rule 5), A1–A3 |
| `derived.js` | `α[tier]`, `energy.contingency_quantile`, `Ω_policy`, combined nominal/degraded conservatism, and the rule-6 refusal |
| `calibrationStatus.js` | The three §22.4 statuses and the tiered launch gate |
| `killSwitches.js` | The nine §22.5 switches, the monotone ladder, prefix classification, the order-dependent pairs |
| `regimes.js` | Named, forecast-triggerable, operator-confirmed regimes and their delta application |

### 3.3 Units and determinism (1 673 lines)

| File | Purpose |
|---|---|
| `src/engine/cost/units.js` | The CU, milli-CU carriage, additive totals, the currency view, the normalisation refusal |
| `src/engine/cost/exchangeRates.js` | Dimensioned rates, denominator checking, the dimensionless-factor allowlist |
| `src/engine/determinism/fixedPoint.js` | int64 milli-CU arithmetic, one specified rounding mode, overflow as an error |
| `src/engine/determinism/ordering.js` | Code-unit string order, the §9.6 tie-break, column identity, canonical JSON |
| `src/engine/determinism/snapshot.js` | Round input pinning, content hash, deterministic seed, replayability report |

### 3.4 REST surface

| File | Purpose |
|---|---|
| `src/controllers/config.controller.js` | `resolve`, `versions`, `publish` |
| `src/routes/config.routes.js` | `authUser` + elevated role + rate limits |

### 3.5 Database

| File | Purpose |
|---|---|
| `prisma/migrations/20260728093000_config_registry_and_governance/migration.sql` | Five tables, three enums, indexes, foreign keys, and the immutability triggers |

### 3.6 Tests — `tests/engine/**` (2 651 lines, 217 new tests)

| File | Tests | Covers |
|---|---|---|
| `configRegister.test.js` | 16 | Appendix A and §8.10 parsed from the spec and matched against the register; entry form; scope legality; calibration discipline |
| `configResolver.test.js` | 17 | Scope precedence level by level including zone; explanation contents; indexed parameters; scope admissibility |
| `configDerived.test.js` | 15 | Each derived identity against the numbers §14.5/§8.6 state; re-derivation on fleet growth; hand-entry refusal |
| `configValidators.test.js` | 24 | The V1–V10 + A1–A3 matrix — each violation triggers **its own check and no other** |
| `configKillSwitches.test.js` | 24 | The nine switches, ladder prefixes, unrehearsed combinations, §22.5 rules 3 and 4 |
| `configRegimes.test.js` | 20 | Declaration validity, operator-only transitions, delta precedence, single active regime |
| `configService.test.js` | 20 | Publish/pin/load, signatures, monotone versions, §22.3 approval, cache-flush behaviour, bootstrap |
| `configApi.test.js` | 14 | The three endpoints, authorisation, 400/404/422 paths |
| `costUnits.test.js` | 20 | Absolute additive costs, the currency view, dimension enforcement, normalisation refusal |
| `determinism.test.js` | 34 | Order-independent summation, rounding symmetry, total orders, snapshot pinning, seeded randomness |
| `legacyConstantShim.test.js` | 13 | The migrated values are unchanged and now come from the register |

---

## 4. Files modified

| File | Change | Why |
|---|---|---|
| `Backend/prisma/schema.prisma` | +157 lines, additive only | The five Config Service models and three enums. No existing model, field, or index altered |
| `Backend/prisma/seed.js` | Mirrors the register into `ParameterRegisterEntry` | The register must be queryable for the resolution-explain endpoint. Idempotent; seeding the register is **not** publishing a version |
| `Backend/server.js` | `app.locals.config = await configService.bootstrap(...)` | The plan's "load pinned version at boot" |
| `Backend/src/app.js` | `app.locals.config = defaultSnapshot()`; `/health` reports the config version and register digest | The plan's "config bootstrap". Defaults are available from module load with no database, so the legacy path acquires no new startup dependency |
| `Backend/src/routes/index.js` | Mounts `/api/config` | The three new endpoints |
| `Backend/src/config/dtaro.constants.js` | **Retired to a shim** — resolves from the register, re-exports the same names | Plan: "retire — values migrate to register". `robotValidator.service.js` and `simulation/constants.js` are untouched |
| `Backend/src/config/liveness.constants.js` | **Migrated to a shim** — same treatment | Plan: "migrate". `robot.handler.js`, `telemetry.handler.js`, `socket.server.js` untouched |
| `Backend/tests/engine/phase0Scaffold.test.js` | "holds no runtime code" narrowed to "holds runtime code only where Phase 1 owns it", plus a new presence check | Phase 1 legitimately adds the first runtime code. The assertion narrows rather than disappearing, so a Phase 2+ module leaking in still fails |

**Not modified:** every file under `src/services/`, `src/sockets/`, `src/cache/`,
`src/simulation/`, and every existing controller except the routing index. The legacy
decision path is byte-for-byte unchanged.

---

## 5. Database changes

Five tables, three enums, additive only — no `ALTER` of an existing object.

| Object | Notes |
|---|---|
| `ConfigVersion` | `version` unique and monotone, `signature` over the canonical payload, `payload` JSONB self-contained for replay, `approvals`, `safetyClassChanges`, `launchGateFindings` |
| `ConfigScopeBinding` | Per-version bindings, unique on `(version, parameter, level, key)` |
| `ConfigActiveVersion` | Single row (`CHECK id = 'singleton'`), FK to `ConfigVersion.version` with `ON DELETE RESTRICT` |
| `ParameterRegisterEntry` | The register mirrored for query; PK is the parameter name |
| `OperatingRegime` | Trigger condition, deltas, entry/exit criteria, owner, lifecycle state, per-regime calibration status |
| enums | `ConfigChangeClass`, `CalibrationStatus`, `OperatingRegimeState` |

**Schema backstops.** §22.1 rule 3 requires a published version to be immutable. A
published version that can be edited in place makes every decision record citing it
unreplayable, and no amount of application discipline prevents an `UPDATE` from a
console. Two `BEFORE UPDATE OR DELETE` triggers therefore refuse the operation in the
database, independently of application logic — the same discipline the commitment core
will carry in Phase 3.

---

## 6. Configuration changes

| Item | State |
|---|---|
| `ENGINE_ENABLED` | Unchanged: `false` in `.env`, `.env.benchmark`, `tests/setup/env.js` |
| Register seeded | 148 entries with unit, range, scope, class, owner, description, blast radius, calibration status |
| Safety-class entries | 36, all `PROVISIONAL` or `UNCALIBRATED`, each naming the data it awaits, each blocked from a launch-gated publish by V10 — exactly the staging the plan specifies |
| Kill-switch ship state | Every switch thrown = the §1.8 rule 3 Tier 0 + Tier 1 engine. Classified `TIER_ONE_BASELINE`; does not alert |
| Published versions | **None.** Seeding the register is not publishing a configuration. A version is an explicit, validated, approved act |
| Values still unset (`required: true`) | 15, listed in §14.2 below. Each is deployment-specific or awaits an accounting figure; each is refused rather than defaulted |

---

## 7. Findings requiring a decision — please read before approving

### 7.1 ⚠️ BLOCKING for the first production publish: the specification's own conservatism defaults exceed its own cap

**Found by the validator, on the seeded register.** §14.3 enumerates four energy-domain
conservatism factors. With Appendix A's stated defaults:

```
nominal   = f_derate 1.00 × charger_availability_margin 1.15 × uncalibrated_reserve_factor 1.25  =  1.4375   ≤ 1.60 ✓
degraded  = 1.4375 × route_degraded_reserve_factor 1.40                                          =  2.0125   > 1.60 ✗
```

`energy.max_combined_conservatism` defaults to **1.60**, and §22.1 rule 5 requires
*both* products to be at or under it. **Validation V9 therefore rejects the seeded
register as a publish.**

This is not a defect in the implementation and it is not obviously a defect in the
specification: §14.3 anticipates this arithmetic almost exactly — *"a fleet whose
effective energy margin is 1.8× because four people each chose 1.15–1.25 will be
quietly uneconomic without anyone having decided that"* — and states that exceeding
the cap *"is rejected at publish time and requires an explicit Safety-class decision to
raise, which is where a deliberate choice to be very conservative belongs — stated
once, rather than assembled by accident from four reasonable-looking numbers."*

The register defaults are, per §22.4 and §8.10, *"starting points for calibration, not
recommendations."* So the correct reading is that the spec's defaults are deliberately
in tension and the first publish is meant to force the decision. **Phase 1 has not
taken that decision.** The defaults are seeded exactly as Appendix A states them, V9 is
implemented exactly as §22.1 rule 5 states it, and the finding is escalated here.

| Lawful resolution | Effect |
|---|---|
| Raise `energy.max_combined_conservatism` to ≥ 2.02 (in range 1.0–3.0) | States the intended total margin once, explicitly, as a Safety decision |
| Reduce one or more of the four factors | Reduces the compounding at source |
| Reclassify `route.degraded_reserve_factor` as acting on a different quantity | **Not available** — §14.3 names it as an energy-domain factor on the same Wh reserve |

**Owner:** Safety (with the named calibration owner of blocking decision B8).
**Needed by:** the first production publish; hard-blocking by **Phase 7**, which is
where these factors are first consumed. It does not block Phase 2.

For test purposes the matrix in `configValidators.test.js` stands in a cap of 2.10 so
that every *other* rule can be exercised in isolation; that value is a test fixture and
is not seeded.

### 7.2 Plan defect: §22.1 rule 5 has ten checks, not eight

`IMPLEMENTATION_EXECUTION_PLAN.md` §7 Phase 1 says *"all eight §22.1 rule-5
cross-parameter checks"*, and the completion criteria say *"rejects each of the eight
§22.1 rule-5 violations in a test matrix"*. §22.1 rule 5 lists **ten** bullets. The plan
states its own precedence — *"Where this plan and the specification appear to disagree,
the specification wins and this plan is defective"* — so **all ten are implemented and
individually tested**. Recorded as a plan defect, not an architecture question.

The two the plan's count omits are V8 (spatial containment) and V10 (calibration
status), which are also the two whose owning data arrives in later phases — which is
probably how the count was lost.

### 7.3 Carried forward, unresolved: the §1.8 / §22.5 kill-switch discrepancy

Phase 0 §7.1 escalated this to the tech lead as an item for Phase 1, which owns
`killSwitches.js`. **No decision has been returned, so Phase 1 has not resolved it
either** — resolving it is an architecture change and the architecture is frozen.

§1.8 names twelve Tier 2 mechanisms; §22.5 tabulates nine switches and reasons about
"the nine independent switches above" and their 512 combinations. Churn pricing (§8.9),
post-solve local search (§9.5), and the duty-cycle regulariser (§17.2) have no §22.5
row. Phase 0's recorded treatment is carried forward unchanged: the three carry their
own switches so §1.8 rule 1 holds, and they sit **off the ladder**, leaving §22.5
rule 2's prefix reasoning and its 2⁹ count untouched.

**One decision rule the code could not avoid making**, stated so it can be overruled:
the §1.8 rule 3 launch state — every switch thrown, including the three off-ladder ones
— is classified `TIER_ONE_BASELINE` and does **not** alert, because it is the state the
specification mandates for launch. Throwing an off-ladder switch in *any other*
combination is `UNREHEARSED` and alerts, which is Phase 0's conservative reading.
Without this the mandated ship configuration would alert as unrehearsed forever, and an
alert that is always on is not an alert.

**Owner:** tech lead. **Needed by:** Phase 16, which stages the ladder. Does not block
Phase 2.

---

## 8. API changes

Three new endpoints, all behind `authUser` + `SUPER_ADMIN`, mounted at `/api/config`.

| Endpoint | Behaviour |
|---|---|
| `GET /api/config/resolve?param=&scope=&index=` | The §22.2 resolution-explain query. Returns the effective value, **the scope level that supplied it**, the levels considered, the unit, change class, owner, range, calibration status, derivation, and the config version. `400` on an unknown scope level (never silently ignored), `404` on an unregistered parameter |
| `GET /api/config/versions` | Published versions newest first, plus which one is pinned |
| `POST /api/config/publish` | Validates, computes derived values, checks §22.3 approval, writes an immutable version, and pins it. `422` with the **findings** — an operator needs to know which rule rejected them, not that something did |

`GET /health` additionally reports `configVersion` and `configRegisterDigest`.

**§22.3 enforcement on publish.** Safety-class changes are identified by change class
*and by an actual change of effective value* against the pinned version — a version is a
complete set, and treating a restated identical value as a change would make every
routine Tuned publish a Safety event, which teaches people to click through safety
reviews. They require two distinct approver identities, each recording who and when,
and **may never be made by an automated process**: `{"automated": true}` on a publish
touching a Safety-class value is refused outright.

---

## 9. Redis changes

| Key | Role |
|---|---|
| `config:active` | Pinned version pointer (mirror) |
| `config:v:{version}` | Materialised resolved set, TTL from `config.cache_ttl` (3 600 s) |

Config is **DB-authoritative and cache-read** (§3.3). Every read falls back to the
database; a flushed cache costs one query and never a wrong answer, which is asserted
directly (`configService.test.js`, "a flushed cache costs a query, never a wrong
answer") and by running the whole path with `kv: null`. The cache tier holds no
correctness-critical sole copy — the mandatory constraint of §3.3 and a Phase 15
release gate.

The cache TTL is itself a register entry (`config.cache_ttl`) rather than a literal,
because the register admits no exceptions, including for the Config Service.

---

## 10. Socket.IO changes

**None.** The plan specifies none, and none was made.

---

## 11. Tests added

**217 new tests** across 11 new suites in the engine lane. Beyond the counts in §3.6,
the tests the plan names specifically:

| Plan requirement | Where |
|---|---|
| Scope resolution precedence **including zone level** | `configResolver.test.js` — each of region → zone → site → agent_class → agent overrides the level above it in turn, and the explanation names the winner |
| Derived-parameter computation (`α[tier]`, `Ω_policy`, `energy.contingency_quantile`) | `configDerived.test.js` — each against the number the specification states, plus the combined-conservatism products |
| Every §22.1 rule-5 validation rejects a crafted bad config | `configValidators.test.js` — and asserts it triggers **only** its own check |
| **Property:** fixed-point milli-CU arithmetic is associative and order-independent over shuffled sets | `determinism.test.js` — 200 deterministic permutations, plus a companion test showing the same set summed as floats *is* order-dependent |
| **Regression:** existing `tests/unit/dtaro/*` still pass through the shim | Legacy lane: 169 tests, unchanged and unmodified |

---

## 12. Checklist — `IMPLEMENTATION_EXECUTION_PLAN.md` §7, Phase 1

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | `ConfigVersion`, `ParameterRegisterEntry`, `OperatingRegime` schema + migration | ✅ | Plus `ConfigScopeBinding` and `ConfigActiveVersion`, which the §3 table also names. `prisma validate` clean |
| 2 | `config/service.js` (publish, pin, load) | ✅ | `configService.test.js` — 20 tests |
| 3 | `resolver.js` with scope order `global → region → zone → site → agent_class → agent` | ✅ | `configResolver.test.js` asserts the order verbatim and each override in turn |
| 4 | `derived.js`: `α[tier]`, `Ω_policy`, `energy.contingency_quantile`, combined conservatism | ✅ | All four; α reproduces §14.5's stated 1e-2 / 1e-5 / ≈1.1e-7 exactly |
| 5 | `validators.js` — all §22.1 rule-5 cross-parameter checks | ✅ | **Ten**, not the plan's eight — see §7.2. Plus A1–A3 |
| 6 | `calibrationStatus.js` (`DERIVED`/`PROVISIONAL`/`UNCALIBRATED`) | ✅ | With the §22.4 tiered launch gate |
| 7 | `killSwitches.js` with the nine switches and the supported monotone ladder | ✅ | Plus the three §1.8 rule-1 off-ladder switches carried from Phase 0 |
| 8 | `regimes.js` — named, forecast-triggerable, operator-confirmed | ✅ | Operator confirmation enforced in **both** directions |
| 9 | Seed the register from Appendix A and §8.10 (unit, range, scope, class, owner, status) | ✅ | 148 entries; completeness asserted by parsing the specification's own tables |
| 10 | `cost/units.js` (CU) and `exchangeRates.js` with explicit dimensions | ✅ | A rate cannot price the wrong quantity; normalisation is refused by name |
| 11 | `determinism/fixedPoint.js` (int64 milli-CU, single specified rounding mode) | ✅ | `ROUND_HALF_AWAY_FROM_ZERO`, symmetric under negation |
| 12 | `determinism/ordering.js` and `snapshot.js` | ✅ | Code-unit ordering, §9.6 tie-break, column identity, content-addressed pinning |
| 13 | Migrate `dtaro.constants.js` and `liveness.constants.js` behind a shim | ✅ | Values identical; shims hold no numeric literal of their own (asserted) |
| 14 | REST: `GET /api/config/resolve`, `GET /api/config/versions`, `POST /api/config/publish` | ✅ | `configApi.test.js` — 14 tests |
| 15 | Tests: scope precedence incl. zone; each derived parameter; each rule-5 rejection; fixed-point order-independence | ✅ | §11 above |
| 16 | **Gate:** no behavioural constant remains outside the register; derived parameters cannot be hand-set | ✅ | `gate:params` PASS over 12 modules / 148 parameters; A2 and V3 reject hand-entered derived values |

**16 of 16 complete. No item skipped, deferred, or partially satisfied.**

---

## 13. Completion criteria — §3 "PHASE 1"

| Criterion | Result |
|---|---|
| Every constant in `dtaro.constants.js` and `liveness.constants.js` resolvable through the Config Service | ✅ All six, asserted value-by-value in `legacyConstantShim.test.js`; the shim files contain no numeric literal |
| Publish-time validator rejects each of the §22.1 rule-5 violations in a test matrix | ✅ Ten checks, each with a crafted violation, each asserted to trigger **only** itself |
| `Ω_policy` and `α[tier]` are computed, never hand-entered | ✅ Computed by `derived.js`; a binding for either is rejected (A2 / V3) |
| Resolution-explain returns the supplying scope level for any parameter | ✅ `explain()` and `GET /api/config/resolve`, including the full chain of levels considered |

---

## 14. Verification evidence

### 14.1 `npm run verify`

```
> gate:tiers
gate: tier-dependencies (§1.8 rule 2)
  PASS — 78 module(s), 20 governed import edge(s), no Tier 0/1 → Tier 2 dependency.

> gate:params
gate: parameter-register (§22, Appendix A)
  PASS — 12 engine module(s) checked against 148 registered parameter(s); no bare behavioural constants.

> gate:tenets
gate: tenets (T1 type separation, T6 decision-path determinism)
  PASS — 75 module(s) checked, no violations.

> test
Test Suites: 38 passed, 38 total
Tests:       490 passed, 490 total
```

| Lane | Suites | Tests | Δ vs Phase 0 |
|---|---|---|---|
| `legacy` | 22 | 169 | **unchanged** |
| `gates` | 3 | 49 | unchanged |
| `engine` | 13 | 272 | +11 suites, +217 tests |
| **Total** | **38** | **490** | +11 / +217 |

The parameter gate reporting `0 engine module(s) / 0 registered parameter(s)` in
Phase 0 was correct and expected then; it is now load-bearing, which was Phase 0's
stated condition for Phase 1 being complete.

### 14.2 Architectural compliance, checked item by item

| Requirement | Evidence |
|---|---|
| §22.1 rule 1 — no behavioural constant in code | `gate:params` over all engine modules; the shim files hold no literal |
| §22.1 rule 2 — ten required fields per parameter | `checkEntryForm()` run over all 148 entries in `configRegister.test.js` |
| §22.1 rule 3 — versioned, immutable, referenced by version | Content signature, DB triggers refusing `UPDATE`/`DELETE`, version pinned in the round snapshot |
| §22.1 rule 4 — a round observes exactly one version | The snapshot is a value object; `bootstrap` fails closed rather than starting on defaults when `ENGINE_ENABLED=true` |
| §22.1 rule 5 — invalid config rejected at publish | V1–V10 + A1–A3, matrix-tested |
| §22.1 rule 6 — derived parameters never hand-entered | `rejectHandEnteredDerived()`; all six protected |
| §22.2 — scope order, zone as a level, traceability | Order asserted verbatim; zone→site precedence tested; `explain()` returns the supplying level |
| §22.3 — change classes, two-person approval, no automated Safety change | Enforced in `publish()`, tested four ways |
| §22.4 — status per entry, named owner, tiered launch gate | 148/148 have both; V10 reports the Tier 0 gate and blocks it on a launch-gated publish |
| §22.5 — nine switches, monotone ladder, order-dependent pairs, pinned states | `configKillSwitches.test.js`, 24 tests |
| §1.3 — absolute additive CU, dimensioned rates, normalisation prohibited | `costUnits.test.js`; a 10 km mission provably costs more than a 1 km one |
| §3.3 — cache holds no correctness-critical sole copy | Cache-flush and no-cache paths both tested |
| §9.6 — all seven determinism requirements | `determinism.test.js`, 34 tests |
| §1.8 rule 2 — no Tier 0/1 → Tier 2 dependency | `gate:tiers` PASS over 20 governed edges |
| §1.8 rule 3 — the launch state is Tier 0 + Tier 1 | Every switch ships thrown, classified `TIER_ONE_BASELINE` |

### 14.3 What could not be verified here, and why

| Item | Status |
|---|---|
| The migration applied against a live PostgreSQL | **Not run.** No database is reachable from this environment (`prisma migrate diff` returns `P1013` on the configured URL). The schema passes `prisma validate`; the SQL is hand-written in the style Prisma generates and was reviewed line by line against the models. **An independent verifier should apply it to a production-shaped dump before Phase 2 begins**, since Phase 2's migration builds on these tables |
| The immutability triggers firing | **Not run**, for the same reason. They are plain `plpgsql` `BEFORE UPDATE OR DELETE` triggers |
| `energy.reserve_floor_wh`, `route.degraded_max_radius`, `candidate.max_radius_by_sla_class`, `ops.escalation_capacity`, and the 11 unset cost rates | **Deliberately unset** (`required: true`, resolving to `null`). Each is deployment-specific or awaits an accounting figure; each is refused at use rather than defaulted, because a fabricated exchange rate is worse than an absent one (§22.4). They are launch-gate items, not Phase 1 gaps |

---

## 15. Known assumptions

Each is an implementation choice not dictated by the plan, stated so it can be
overruled.

1. **Appendix A's `fleet` and `shard` scopes are mapped, not added as levels.** §22.2's
   hierarchy does not contain them. `fleet` → `global` (a fleet-wide quantity) and
   `shard` → `region` (one shard owns one operating region, §3.5). Each entry records
   the Appendix A value verbatim as `specScope`. No level was added to the hierarchy.
2. **The §22.2 branch is linearised.** §22.2 draws three lines branching after `site`.
   Resolution needs a total order, so they are linearised in the order the
   specification prints them, with `time_window` last — a scheduled override, including
   a regime, is the most specific thing that can apply, which is what makes a regime
   able to move a parameter at all.
3. **Twelve parameters were added that Appendix A does not tabulate.** Appendix A opens
   *"Not exhaustive; it establishes the required form."* Every one of the twelve is read
   by a named §22.1 rule-5 validation or a stated derivation — `plan.max_admissible_mission_duration`
   (V1), `observability.input_snapshot_retention` (V6), the four §3.5 sizing inputs (V4),
   `fleet.agent_count` and `fleet.missions_per_agent_year` (α derivation),
   `energy.f_derate` and the two combined-conservatism outputs (§14.3), and
   `config.cache_ttl`. They are collected in `supplementary.json` with the rule that
   requires each.
4. **`plan.max_admissible_mission_duration` is seeded at 600 s.** V1 requires
   `value_horizon (1800) > commitment_horizon (900) + this`. 600 s is the largest value
   consistent with the specification's own defaults for the other two. It is a
   placeholder for a measured figure, not a service limit.
5. **`energy.f_derate` is seeded at 1.0.** §14.3 names it but gives no default. 1.0 —
   no derating beyond the vendor curve — is seeded `UNCALIBRATED`, because a fabricated
   factor is less honest than none, and because it enters the capped product.
6. **The five `C_policy` credit ceilings are seeded with `PROVISIONAL` placeholders**
   (60/300/120/120/300 CU, Ω_policy = 900 CU). §8.6 rejects an adjustment without a
   ceiling at publish, so `null` would make the register unpublishable by construction;
   §22.4 explicitly permits a Policy-class `PROVISIONAL` placeholder that names what it
   awaits. Each does.
7. **The rounding mode is round-half-away-from-zero.** §9.6 requires "a single specified
   rounding mode" without naming one. This one is symmetric under negation, so
   `toMilliCU(−x) = −toMilliCU(x)` exactly — which matters because `C_opportunity` and
   `C_policy` may be negative, and an asymmetric mode would make the sign of a near-zero
   cost an artefact of rounding.
8. **Safety-class "changes" are diffed against the pinned version**, not taken to be
   every Safety binding present. Rationale in §8 above.
9. **`config.controller.js` and `config.routes.js` are unlisted files.** The plan's
   Phase 1 file list omits them while its REST row requires the three endpoints. They
   follow the existing controller/route conventions exactly.
10. **`register/killSwitches.json` is generated, not hand-written.** The switch states
    are register entries (§22.1 rule 1), and the build gate reads only
    `register/*.json`. Injecting them at load time instead would have given the gate a
    partial view of the register and let it fail a compliant module — the one direction
    Phase 0 declared its gates must never fail in. A test asserts the file and the
    §22.5 switch table agree in both directions.
11. **`.gitkeep` removed from four directories** — `config/`, `config/register/`,
    `cost/`, `determinism/` — now that they hold real modules, per Phase 0's own
    convention that a directory holding only a `.gitkeep` is a placeholder whose owning
    phase has not landed.

---

## 16. Remaining TODOs

### 16.1 Carried out of Phase 1

| # | Item | Owner | Due |
|---|---|---|---|
| 1 | **Resolve the combined-conservatism finding (§7.1)** — the seeded register does not publish until it is settled | Safety | Before the first production publish; hard by Phase 7 |
| 2 | Apply the migration to a production-shaped dump and exercise the immutability triggers (§14.3) | Verifier / SRE | Before Phase 2 |
| 3 | Resolve the §1.8 / §22.5 kill-switch discrepancy (§7.3), carried from Phase 0 | Tech lead | Phase 16 |
| 4 | Name the calibration owner and set the fleet-year energy budgets (blocking decision B8) | Ops / Finance / Safety | Phase 7 and the Phase 15 launch gate |
| 5 | Supply the 15 `required` values still unset (§14.3) | Ops, Finance, Account management | Phase 15 launch gate |
| 6 | Add re-derivation dates (`awaitsBy`) for the 119 Tier 1/2 `PROVISIONAL` entries | Calibration owner | Phase 15 launch gate |

### 16.2 Carried forward from Phase 0, still open

Items 3–6 of `PHASE_0_IMPLEMENTATION_REPORT.md` §9.1 are unchanged and remain with
their owning phases: the `settlement.js` tier confirmation (Phase 5), the call-site-level
T1 assertion (Phase 8), the layer-direction gate (Phase 10), and the §24.3 erasure-corpus
gate (Phase 14). **None was touched**, per the instruction not to fix issues whose owning
phases are later.

### 16.3 Explicitly out of scope for Phase 1

Socket.IO changes · background workers — **the plan specifies "None" for both, and none
was made.** No domain model, no `Agent`, no `Commitment`, no spatial hierarchy: those
are Phase 2.

---

## 17. Risks

| Risk | Assessment |
|---|---|
| **The migration has not been applied to a real database** | The single largest residual risk in this phase. Mitigated by `prisma validate`, hand-written SQL in Prisma's own generated style, and additive-only DDL. **Should be discharged before Phase 2**, whose migration is the largest in the programme and builds on these tables |
| **The shims change legacy startup behaviour** | The two constant files now execute a register load at `require` time and throw if a value does not resolve. Mitigated: the defaults snapshot needs neither database nor cache, the 169-test legacy lane is unchanged, and both shims are covered by direct value-equality tests |
| **96 PROVISIONAL and 23 UNCALIBRATED entries** | This is §22.4's predicted failure mode — *"the engine ships with placeholder coefficients … operators begin overriding it within weeks"* — and the reason the launch gate exists. Every entry names the data it awaits; V10 reports all of them at publish. It becomes a real risk only if nobody owns the register, which is blocking decision B8 |
| **The V9 finding is settled by simply raising the cap** | Raising `energy.max_combined_conservatism` to 2.02 makes the finding disappear without anyone deciding the fleet should carry a 2× energy margin. That is precisely the outcome §14.3 exists to prevent, which is why §7.1 lists all three lawful resolutions rather than the convenient one |
| **The linearised §22.2 branch (assumption 2)** | If the intended precedence among `tenant`, `sla_class`, `mission_class` differs from the printed order, resolutions involving two of them simultaneously would differ. No current parameter is bound at two branch levels at once, so the exposure today is nil, but it should be confirmed |

---

## 18. Readiness for Phase 2

| Prerequisite | State |
|---|---|
| Phase 1 complete | ✅ 16/16 checklist, 4/4 completion criteria |
| Phase 2's dependency | Phase 1 only — satisfied |
| Blocking decisions for Phase 2 | **None.** §7.1 blocks the first production publish and Phase 7, not Phase 2. §7.3 blocks Phase 16 |
| What Phase 2 gets | A register to declare `capacity[agent_class]` in (already seeded, default 1), scope levels to publish the region/zone/site/cell maps at, V8 waiting to validate their containment, and canonical ordering + `canonicalJson` for the domain mappers |
| Guardrails Phase 2 will meet | Tier gate, parameter gate (**now load-bearing**), tenet gate; the narrowed Phase-1-ownership assertion in `phase0Scaffold.test.js` will fail on any Phase 2 module until this report's successor moves it |

---

## 19. Stop

**Phase 1 is complete. Phase 2 has not been started and will not be started without
independent verification and explicit approval.**

Phase 2 — Domain model and schema — is a **HIGH** risk phase and the largest single
migration in the programme. It rewrites `prisma/schema.prisma` across nine migration
groups, backfills every existing `Robot` and `Task` row, and touches every read path.
Its risk mitigation depends on the migration discipline in §16.1 item 2 being
discharged first.
