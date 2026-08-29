# Phase 15 — Implementation State

**What actually exists in the current repository.**

> Current source of truth for navigation and verdict: **[`PHASE_15_MASTER.md`](PHASE_15_MASTER.md)**.
> This document answers *what exists*. It does **not** answer *what is proven* — that is
> [`PHASE_15_VERIFICATION_STATE.md`](PHASE_15_VERIFICATION_STATE.md).

**Measured:** 2026-08-29 · **HEAD** `b68dc5d` · **digest** `431010ace188c4b1…` (565 files)
**Re-verified:** 2026-08-29 by the documentation-integrity audit, on the same digest.
Every path below was confirmed to exist (or confirmed absent) by direct filesystem inspection on
that tree.

**Path convention — read this before going looking for a file.** Paths are relative to `Backend/`
unless stated otherwise. **Four things live at the repository root, not under `Backend/`,** and the
distinction is load-bearing because two of them are outside the source-digest scope:

| At the repository root | At `Backend/` |
|---|---|
| `docs/safety-case/hazards.json` and `SAFETY_CASE.md` — `assemble.js` resolves them from `REPO_ROOT` (`assemble.js:54–56`), **not** from its own cwd | `Backend/docs/release-evidence.json` — the only file in `Backend/docs/` |
| `docs/runbooks/cutover.md`, `rollback.md` | |
| `docs/adr/`, `docs/phase15/` (these five documents) | |
| `formal/` — the TLA+ modules and `.cfg` files | |

---

## Cutover

**Implemented.** `src/engine/cutover/` — 10 modules:

| File | Role |
|---|---|
| `stage.js` | The cutover authority. `authoriseEnable()` — the single decision point |
| `gates.js` | The §24 gate table (24 gates, all blocking) — `evaluate()`, `blockers()` |
| `evidence.js` | Evidence admission, including the PRODUCTION observation-window rules and `resolveMinObservationMs` |
| `guardrails.js` | `assess()`; `assertOneDirectional` — admits only `DISABLE` |
| `enabled.js` | Is the engine the decision path for this shard |
| `store.js` | Cutover state persistence |
| `configPropagation.js` | The pull half of pull-with-pin |
| `rollbackPublisher.js` | Makes an automatic rollback take effect |
| `agentGate.js` | The two-half socket staging switch |
| `legEntryDeadline.js` | Leg-entry deadline semantics |

**Current behaviour, load-bearing:**
- `ENGINE_ENABLED` is resolved at **region scope**, not process scope — one shard owns one
  operating region (§3.5 / §22.2).
- The enable/disable asymmetry is enforced in code: `guardrails.assertOneDirectional` admits only
  `DISABLE`, and `stage.authoriseEnable` **refuses an automated enable request outright**. The only
  automatic transition is the one that lowers risk.
- `authoriseEnable()` resolves minimum-observation bounds **from the parameter register**, and
  refuses a caller that states its own bound — in both directions. (This is P15-F1's fix.)
- A `REHEARSAL` purpose exists under **ADR-34**: it requires a declared non-production environment
  and sets aside **exactly one** gate. A production-purpose enable is still refused.

**NOT implemented / deliberately absent:**
- **`authoriseEnable()` has no production caller.** Nothing in `server.js` or the controllers calls
  it. It is invoked by the documented operator procedure in `../runbooks/cutover.md`. No caller was
  manufactured.

---

## Release gates and evidence

**Implemented.** `tools/release/`:

| File | Role |
|---|---|
| `sourceDigest.js` | Exports `SCOPE_DIRECTORIES`, `SCOPE_FILES`, `sourceDigest()`. Scope: `src/`, `tools/`, `tests/`, `package.json`, `jest.config.js`. **`docs/` deliberately excluded** |
| `collectEvidence.js` | The **sole** producer of `docs/release-evidence.json` |
| `verdict.js` | Renders the §24 table; detects gate-id collisions between build records and attestations and forces the colliding gate RED |

**Current generated artefact:** `Backend/docs/release-evidence.json`
- producer `tools/release/collectEvidence.js`, produced `2026-08-29T06:28:45.657Z`
- `sourceDigest` = `431010ace188c4b1…` — **matches the current tree**
- **17 evidence records, 0 VOID, 17/17 bound to that digest**
- plus a `corroboration` block (e.g. `calibration_safety_derived`, exit 1)

**The gate table** lives in `src/engine/cutover/gates.js`: **24 gates, all blocking**, in four
classes — BUILD, SUITE, PRODUCTION, ORGANISATIONAL.

**NOT implemented:**
- **`app.locals.releaseEvidence` has no producer.** `src/controllers/health.controller.js:319`
  reads it as `req.app?.locals?.releaseEvidence || {}`; no assignment to it exists anywhere in
  `src/`, `server.js` or `tools/`. The cutover health endpoint therefore always evaluates against
  an empty evidence set. **This fails closed** (every gate reads as not-green), so it is a reported
  gap, not a permissive defect.
- **The evidence schema cannot distinguish a gate that failed from a gate that never ran.**
- **`gates.blockers()` ignores `unknownEvidence`.** `evaluate()` computes it and folds it into `ok`;
  `blockers()` filters `results` only, so evidence filed against an unknown gate id never appears
  as a blocker.

---

## Workers and the composition root

**Implemented.** `src/workers/` — `registry.js` registers **18 workers**, exporting `READINESS`,
`WORKERS`, `WORKER_BY_ID`, `assertRegistry`, `scheduledAtBoot`, `scheduledOnLeadership`, `report`.
The directory holds **20 `.js` files**: 18 `*.worker.js` modules, `registry.js`, and
`leaderWorkers.js` (the LEADER_ONLY wiring). A count of "19 workers" is wrong under every reading.

Worker modules present: `calibration`, `capacityPricing`, `certificateRotation`,
`chargerReachability`, `coordinator`, `counterfactual`, `cutover`, `energyCalibration`,
`indexMaintainer`, `invariant`, `outbox`, `reconciler`, `rejectionAggregation`, `serviceTimeModel`,
`shadow`, `shardSupervisor`, `tierB`, `timer`.

**The production composition root is `Backend/server.js`.** It starts the registry's `SCHEDULED`
set, runs the shard supervisor with its promotion hook, wires both halves of the cutover switch,
publishes automatic rollbacks, and runs the configuration pull loop (stopped on shutdown).

### How many workers actually run — read this before quoting a number

`registry.report({running:[]})` on the current tree, verified 2026-08-29:

| `readiness` | Count | Started by | Actually starts |
|---|---:|---|---:|
| `SCHEDULED` | 8 | `server.js` at boot | 8 |
| `LEADER_ONLY` | 4 | `leaderWorkers.js`, on leadership promotion | **3** — `coordinator` is refused |
| `DEFERRED` | 6 | nothing, by declaration | 0 |
| **Total** | **18** | | **11** |

- `SCHEDULED` (8): `shard_supervisor`, `invariant`, `cutover`, `tier_b`, `rejection_aggregation`,
  `certificate_rotation`, `calibration`, `counterfactual`.
- `LEADER_ONLY` (4): `coordinator`, `outbox`, `reconciler`, `timer`.
  `leaderWorkers.COMPOSERS` covers all four; `leaderWorkers.UNCOMPOSABLE` currently holds exactly
  one entry — `coordinator`.

> **`gate:composition`'s "1 violation across 18 registered workers" is a *compliance* count, not a
> *start* count.** A `DEFERRED` row is compliant because `assertRegistry()` forces it to name a
> `blockedBy`; the gate accepts a declared, reasoned deferral and fails only an undeclared one.
> **Do not read "17 of 18 pass the gate" as "17 of 18 workers run."** 11 run.

**NOT composable — 1 of 18:**
- **`coordinator`** — `LEADER_ONLY_NOT_COMPOSABLE`. Its round loop needs `expandCandidates`,
  `pricedCandidateFor` and `commit`. The first two resolve through
  `plan/insertion.js → planBuilder.hopsForSequence → routing/cellPairCache.hopsFor` to an injected
  `route` function — **the routing engine, which B1 has not selected**. `gate:composition` exits 1
  on exactly this one violation, with owner **EXTERNAL**.

**DEFERRED — 6 of 18, each with the blocker the registry itself records.** Only the first is B1's:

| Worker | Tier | Why it is not scheduled | Released by |
|---|---:|---|---|
| `shadow` | 1 | Needs the same constructed solve path as `coordinator` — `round`, `expandCandidates`, `pricedCandidateFor`, `budgetsFor`, `deferPriceFor`, all bottoming out in the injected `route`. **Consequence: `shadow_agreement` cannot begin accumulating evidence at all — the 14-day clock cannot start** | **B1** (EXTERNAL) |
| `index_maintainer` | 1 | Needs the capability/container and charging classifiers (`capabilityAndContainerClassesFor`, `chargingStatusFor`). The index is maintained on the telemetry path; the sweep is the self-healing pass, and a classifier answering "unknown" would evict live agents | Those classifiers |
| `charger_reachability` | 1 | Exposes a pass function rather than a scheduler; driven by the routing layer's cache-miss path today. Scheduling it needs a routing client this process does not construct | **B1** → Phase 8's `routing/client.js` |
| `energy_calibration` | 1 | Exposes a pass function rather than a scheduler; its inputs are realised-outcome rows the fleet has not produced. One of the loops **B8**'s calibration owner governs | **B8** + an operating fleet |
| `service_time_model` | 1 | Exposes a pass function rather than a scheduler; §22.4 names per-site service-time models among the values that "require data the fleet does not yet produce" | An operating fleet |
| `capacity_pricing` | 2 | Tier 2. `killswitch.opportunity_cost_term` is thrown at launch (§1.8 rule 3), so `C_opportunity` reads static priors and nothing consumes a live λ_zone | **Phase 16a**, under its own gate |

**Consequence for Phase 15's own stated purpose.** The plan's Phase 15 row is "all engine workers
move from shadow to production scheduling". On the current tree that is satisfied for 11 of 18.
`gate:composition` — the §24 gate — is satisfied by a *declared* deferral, so it does **not** hold
Phase 15 open for the five non-`shadow` deferrals. Two of those five (`charger_reachability`,
`energy_calibration`) are released by B1 and B8 respectively; one is Phase 16a's by design; two
await classifiers or fleet data. **None is an unreported gap, and none is separately tracked as a
blocker** — see [`PHASE_15_BLOCKERS.md`](PHASE_15_BLOCKERS.md).

The remaining composition-root work (`evaluateExact`, `pricedCandidateFor`, `hopsForSequence`, and
their injection alongside the routing client at `server.js`) is **released by B1, not by a commit**.

---

## Routing

**Implemented — tooling only. NO ENGINE IS SELECTED.**

`tools/routing/`:
- `b1Readiness.js` — the readiness gate. Reports `OVERALL: BLOCKED` and **refuses to fabricate**
  a region, speed model or vintage. **Exits 0 by design** (`b1Readiness.js:72–73`): reporting a
  missing decision is not a build failure.
- `b1Benchmark.js` — the benchmark harness and the five closing steps (lines 584–593).
- `inProcessCacheBenchmark.js`
- `adapters/` — `contract.js`, `deployment.js`, `transport.js`, `index.js`, and four candidates:
  `osrm.js`, `valhalla.js`, `graphhopper.js`, `inhouse.js`.

**Current state:** B1 Step 2 **PASS** — 3 adapters implemented (`osrm`, `valhalla`, `graphhopper`);
`inhouse` correctly `NOT_IMPLEMENTED` because no engine exists to adapt to and none was fabricated.
Steps 1, 3, 4, 5 **BLOCKED**.

**NOT implemented, and must not be:**
- `src/engine/routing/client.js` — the production Routing Service client (§5.2's degradation ladder,
  the `route(parts)` seam). Blocked by N25/N26 **and** B1. It is a **Phase 8** module.
- No region geometry, speed model or extract metadata exists anywhere in configuration.
  `prisma/seed.js`'s `SEED_SPATIAL_MAP` / `RGN-BLR` is a **Phase 2 containment demonstration** —
  four fine cells, placeholder cell ids, never published as a config version. It is **not**
  production configuration and must never be treated as one.

---

## Calibration

**Implemented.** `tools/gates/checkCalibration.js`; `src/engine/config/calibrationStatus.js`
records status; register JSON under `src/engine/config/register/`.

**Current state:** 242 registered entries — 52 `DERIVED`, 152 `PROVISIONAL`, 38 `UNCALIBRATED`;
**54 Safety-class**; **39 blocking findings**. Every finding names what it awaits (a measurement,
a certification, or an operations/safety decision).

**Not in CI.** `gate:calibration` is an ORGANISATIONAL release gate, not a build gate; the CI
workflow records the reason inline.

---

## Simulation fidelity

**Implemented.** `tools/simFidelity/validate.js` — the §24.4 one-sided gate, bound 5.0 % optimistic.

**Current state:** **no study has been supplied.** All 7 models report `NOT_MEASURED`
(`TRAVEL_TIME`, `SERVICE_TIME`, `ENERGY_CONSUMPTION`, `CHARGE_DURATION`, `FAILURE_RATE`,
`INTERVENTION_RATE`, `DISCONNECT_RATE`), 6 of them safety-relevant. The tool states plainly that
the simulator therefore **may not discharge a Tier 0 verification obligation**.

Input is supplied via `--input <file.json>`. **Do not synthesise one.**

---

## Safety case

**Implemented.** `tools/safetyCase/assemble.js`; input `<repo root>/docs/safety-case/hazards.json`.
Output: `<repo root>/docs/safety-case/SAFETY_CASE.md` — **generated, not hand-maintained.**
Both paths resolve from `REPO_ROOT`, so they are **not** under `Backend/docs/`.

**Current state:** assembles 12 hazards from 38 predicates and 22 invariants; every reference
resolves; exit 0. Re-run by the 2026-08-29 audit: exit 0, and `git status` for
`docs/safety-case/` was empty afterwards — **regeneration is byte-identical**, so the checked-in
artefact is current.

**Important:** the assembler files **no evidence**. It reports "release gates: 0 green, 0 red, 24
not evaluated" because it does not read `release-evidence.json`. **The assembler passing is not the
§24.7 `safety_case_assembled` gate being discharged.**

---

## Formal verification

**Partially implemented.** `formal/` (repository root): `commitment.tla`, `lifecycle.tla`, and six
TLC configurations (`commitment_c1..c3.cfg`, `lifecycle_c1..c3.cfg`), plus `README.md`.
An executable lifecycle model checker exists in the engine test suite.

**NOT implemented:** **`tla2tools.jar` is absent from the repository** — confirmed by filesystem
search. **TLC has never been run.** The discharging suite asserts `exhaustive: false` for the
lifecycle at capacities 1, 2 and 3; the commitment half is exhaustive only at capacity 1. This is
blocker **B-M**.

---

## Legacy retirement

**Complete.** Four modules were deleted, not bypassed: `taskAssignment.service.js`,
`costEvaluator.service.js`, `robotValidator.service.js`, `taskRecovery.service.js`.
`tools/gates/checkLegacyRetirement.js` fails the build if any returns — currently PASS across
340 files, 0 retired symbols redefined. `src/engine/config/register/legacy.json` records the
retirement note for each.

**There is no legacy dispatcher to fall back to.** After Phase 15, `ENGINE_ENABLED=false` for a
shard means *that shard has no decision path*, not *another one serves it*.

---

## Database

**Implemented.** `prisma/schema.prisma`, **27 migrations** under `prisma/migrations/`.
Four Phase 15 live-database harnesses under `tools/verify/`:

| Harness | Checks |
|---|---|
| `phase15LiveDatabase.js` | 12 |
| `phase15CurrentTree.js` | 32 |
| `phase15EvidenceBinding.js` | 17 |
| `phase15VersionInForce.js` | 19 |

**Every one refuses to run against Neon or a default-port (5432) instance by name.** They require a
disposable cluster. Applying all 27 migrations to an empty database yields 74 domain tables plus
`_prisma_migrations`.

---

## Frontend contracts

`Frontend/` was rewired by Phase 15 for the §3.4 task contract and the cutover posture surface.
`src/controllers/tasks.controller.js` carries the API version and the retention-window note;
`src/controllers/health.controller.js` exposes `GET /api/health/cutover`.
**No Phase 15 blocker is frontend-owned.**

---

## Runbooks

`<repo root>/docs/runbooks/cutover.md` (391 lines) and `rollback.md` (269 lines) — repository
root, **not** `Backend/docs/`. Line counts re-verified 2026-08-29.

- `cutover.md` §3.2 now mirrors `verdict.js`'s merge exactly, including **gate-id collision
  detection** that forces a colliding gate `pass: false` (the P15-F7 fix, corrected).
- `rollback.md` documents Rollback A (disable one shard, manual and automatic), Rollback B
  (redeploy the previous artefact), and the §5 rehearsal that the `rollback_rehearsed` gate is
  evidence for.

**Structural gap (P15-F7a): nothing binds a runbook to the API it documents.** `docs/` is outside
the digest scope by design, so no gate anywhere detects a runbook drifting from the signature it
calls. `rollback.md` in particular **has never had its procedure executed against the current API by
any pass.** It is an unexamined surface, not a known defect.

---

## Tests

**160 suites / 7 162 tests.** Five Jest projects (`jest.config.js`): `legacy`, `gates`, `engine`,
`chaos`, `scale`.

Phase 15-specific suites under `tests/engine/`:
`phase15CurrentTreeRemediation.test.js`, `phase15EvidenceBindingRemediation.test.js`,
`phase15ObservationAuthority.test.js`, `phase15ObservationWindowRemediation.test.js`.

---

## Tooling

`Backend/package.json` scripts relevant to Phase 15:

```
gates            = gate:tiers && gate:params && gate:tenets && gate:privacy
                   && gate:erasure && gate:legacy && gate:columngen && gate:composition
gate:calibration   node tools/gates/checkCalibration.js
release:evidence   node tools/release/collectEvidence.js
release:gates      node tools/release/verdict.js --collect
release:verdict    node tools/release/verdict.js
routing:b1         node tools/routing/b1Benchmark.js
routing:readiness  node tools/routing/b1Readiness.js
safety:case        node tools/safetyCase/assemble.js
sim:fidelity       node tools/simFidelity/validate.js
verify             npm run gates && npm test
```

### CI — what it actually runs

`.github/workflows/ci.yml` has two jobs. The `gates` job runs **7 build-gate steps** —
`gate:tiers`, `gate:params`, `gate:tenets`, `gate:privacy`, `gate:erasure`, `gate:legacy`,
`gate:columngen` — plus `test:gates`. The `test` job runs **4 lanes**: `test:legacy`,
`test:engine`, `test:chaos`, `test:scale`.

**Two precisions that a "7 gates, 5 lanes" summary loses:**
- **`gate:columngen` is `if: github.event_name == 'pull_request'`.** A push to a branch therefore
  runs **6** build-gate steps, not 7. The gate is skipped rather than failed, and §21.6 gates a
  *diff*, so this is deliberate — but "CI runs 7 build gates" is only true on a pull request.
- **There is no fifth test lane in the `test` job.** `jest.config.js` has five projects; the
  `gates` project is run as `test:gates` in the *other* job. 4 lanes + `test:gates` = all five
  projects, run once each.

**CI does NOT run `gate:composition`, `gate:calibration`, `safety:case`, `release:gates`,
`routing:readiness` or `sim:fidelity`.** The workflow comments explain the omission of
`gate:calibration` (an organisational gate) and `safety:case` (it regenerates a file in place).
**The workflow gives no reason for omitting `gate:composition`** — its header enumerates exactly
two deliberate absences and `gate:composition` is not one of them.

**Consequence, stated so it is not rediscovered as a surprise: CI is green on a tree where a
blocking §24 release gate is RED.** `npm run gates` runs **8** gates and exits 1; CI runs 7 of
those 8 and exits 0. The omitted one is the only one that fails. This is recorded as a current
fact. It is not a Phase 15 blocker, and no pass — including this audit — has changed CI.
`ARCHITECTURE.md` §9.1 and `ROBOTX_SYSTEM_HANDBOOK.md` §42 describe CI as running "all seven
gates" without naming this third absence; that discrepancy is registered in
[`PHASE_15_BLOCKERS.md`](PHASE_15_BLOCKERS.md) § *Cross-phase documentation discrepancies*.

---

## Explicitly NOT implemented — do not mistake absence for an oversight

| Absent | Status |
|---|---|
| `src/engine/fairness/ladder.js`, `operatorCapacity.js`, `agentStarvation.js` | **REMEDIAL PHASE T1-04.** The directory `src/engine/fairness/` exists and is empty. Registration is authorisation, not implementation |
| `src/engine/lifecycle/preemption.js` | Phase 16 |
| `src/engine/solve/setPartitioning.js`, `branchAndBound.js`, `localSearch.js` | Phase 16 |
| `src/engine/routing/client.js` | Phase 8, blocked by N25/N26 and B1 |
| `tla2tools.jar` | B-M — needs compute provisioning |
| Any Tier 2 mechanism | Phase 16. Every §22.5 kill switch remains thrown |
| A `TASK`-entity timer producer | **X3** — §4.2 has no transition table. Specification-owned |
| A production caller for `stage.authoriseEnable()` | By design — the operator procedure is the caller |
| A production caller for `assertVersionInKey` | **A9** — its Phase 8 seam does not exist |
