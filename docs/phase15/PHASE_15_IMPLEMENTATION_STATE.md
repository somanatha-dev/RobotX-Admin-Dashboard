# Phase 15 — Implementation State

**What actually exists in the current repository.**

> Current source of truth for navigation and verdict: **[`PHASE_15_MASTER.md`](PHASE_15_MASTER.md)**.
> This document answers *what exists*. It does **not** answer *what is proven* — that is
> [`PHASE_15_VERIFICATION_STATE.md`](PHASE_15_VERIFICATION_STATE.md).

**Current tree:** **2026-08-30** · **HEAD** **`7335260`**, **no application source modified** (the
only modified paths are these five canonical documents, which `docs/` keeps outside the digest
scope) — T1-04, the
`Leg.slaDeadline` producer and V-10 were committed as a snapshot before closure item V-9 ran ·
**digest `d033038cb261c3de…` (573 files) — unchanged by that commit and unchanged by V-9, which
wrote no code**
**Originally measured:** 2026-08-29 · HEAD `b68dc5d` · digest `431010ace188c4b1…` (565 files) — **superseded**
**Re-verified:** 2026-08-29 by the documentation-integrity audit, on that digest;
**re-measured 2026-08-30** by the post-V-10 current-state audit, on this one.
Every path below was confirmed to exist (or confirmed absent) by direct filesystem inspection on
that tree.

> **Current tree: digest `d033038cb261c3de…` (573 files), HEAD `7335260`, 2026-08-30.** T1-04, the
> `Leg.slaDeadline` producer and closure item V-10 all landed after the "originally measured"
> line above and were **committed as the snapshot `7335260`** before V-9 ran, so **the
> `b68dc5d` / `431010ace1…` / 565 line describes a superseded tree**. *(This block opened
> "HEAD `67b7c7c` … have all landed uncommitted", which contradicted this document's own header;
> corrected 2026-08-31 by the freeze audit. `67b7c7c` is `7335260`'s parent and carries the same
> digest-scope content.)* Counts corrected in place, each re-measured 2026-08-30 against
> `d033038c…`:
>
> - the registry registers **19** workers, not 18 (T1-04 added `fairness.worker.js`), which starts
>   at boot — so `SCHEDULED` is **9** and **12 of 19** workers start, not 11 of 18;
> - `src/workers/` holds **21** `.js` files, not 20;
> - **28** Prisma migrations, not 29 — the "29" was arithmetically inconsistent with its own
>   "27 + T1-04's one" and is corrected everywhere it appeared;
> - `gate:legacy`'s corpus is **346** files, not 340 (the load-bearing number, *4 absent*, is
>   unchanged);
> - **`Backend/docs/release-evidence.json` is STALE** and is no longer current-tree evidence —
>   see *Release gates and evidence* below;
> - the runbook section is rewritten, and V-10 added `tests/engine/phase15RollbackRunbook.test.js`
>   and `tools/verify/v10RollbackRunbook.js` (`npm run verify:v10`).
>
> Everything else was re-confirmed present. `gate:composition`'s violation count is **unchanged at
> 1** (`coordinator`), and no blocker, classification or verdict moved.

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

**Current generated artefact:** `Backend/docs/release-evidence.json` — **STALE. It is NOT current
release evidence and must not be cited as any gate's discharge.**
- producer `tools/release/collectEvidence.js`, produced `2026-08-29T06:28:45.657Z`
- `sourceDigest` = `431010ace188c4b1…` — **a tree that no longer exists.** The current tree is
  `d033038c…` (573 files). *(This line previously read "**matches the current tree**". That was
  true when written on 2026-08-29 and is false now; it also contradicted
  `PHASE_15_VERIFICATION_STATE.md` §3.0, which is the correct account.)*
- **17 evidence records, 0 VOID, 17/17 bound to that superseded digest** — and on the current tree
  every one of them is `[STALE]` (~126 000 s against each gate's 86 400 s bound), so
  `npm run release:verdict` reads **0 green / 17 red / 7 not evaluated**, re-confirmed 2026-08-30
- plus a `corroboration` block (e.g. `calibration_safety_derived`, exit 1)
- **Re-collection is the release owner's step at a quiescent, committed tree** — not a
  documentation act, and not something to run to make the current tree look green

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

**Implemented.** `src/workers/` — `registry.js` registers **19 workers** *(18 before REMEDIAL
PHASE T1-04 added `fairness.worker.js` for §17.5; re-measured 2026-08-30 —
`require('./src/workers/registry.js').WORKERS.length` → 19)*, exporting `READINESS`, `WORKERS`,
`WORKER_BY_ID`, `assertRegistry`, `scheduledAtBoot`, `scheduledOnLeadership`, `report`.
The directory holds **21 `.js` files**: 19 `*.worker.js` modules, `registry.js`, and
`leaderWorkers.js` (the LEADER_ONLY wiring).

> **`gate:composition` prints "1 violation(s) across 19 registered worker(s)"** — re-run and
> re-read 2026-08-30. The violation count did not move: it is `coordinator`, and it is B1's.

Worker modules present (**19**): `calibration`, `capacityPricing`, `certificateRotation`,
`chargerReachability`, `coordinator`, `counterfactual`, `cutover`, `energyCalibration`,
**`fairness`**, `indexMaintainer`, `invariant`, `outbox`, `reconciler`, `rejectionAggregation`,
`serviceTimeModel`, `shadow`, `shardSupervisor`, `tierB`, `timer`.
*(`fairness` was missing from this list while the sentence above it already said 19 — corrected
2026-08-30.)*

**The production composition root is `Backend/server.js`.** It starts the registry's `SCHEDULED`
set, runs the shard supervisor with its promotion hook, wires both halves of the cutover switch,
publishes automatic rollbacks, and runs the configuration pull loop (stopped on shutdown).

### How many workers actually run — read this before quoting a number

`registry.report({running:[]})` on the current tree, **re-measured 2026-08-30 at digest
`d033038c…`**:

| `readiness` | Count | Started by | Actually starts |
|---|---:|---|---:|
| `SCHEDULED` | **9** | `server.js` at boot | **9** |
| `LEADER_ONLY` | 4 | `leaderWorkers.js`, on leadership promotion | **3** — `coordinator` is refused |
| `DEFERRED` | 6 | nothing, by declaration | 0 |
| **Total** | **19** | | **12** |

*(This table read 8 / 4 / 6 → 18 total, 11 starting, which was the 2026-08-29 tree. T1-04's
`fairness.worker.js` is `SCHEDULED`, so the `SCHEDULED` row and both totals moved by one.)*

- `SCHEDULED` (9): `shard_supervisor`, `invariant`, `cutover`, `tier_b`, `rejection_aggregation`,
  `certificate_rotation`, `calibration`, `counterfactual`, **`fairness`**.
- `LEADER_ONLY` (4): `coordinator`, `outbox`, `reconciler`, `timer`.
  `leaderWorkers.COMPOSERS` covers all four; `leaderWorkers.UNCOMPOSABLE` currently holds exactly
  one entry — `coordinator`.

> **`gate:composition`'s "1 violation across 19 registered workers" is a *compliance* count, not a
> *start* count.** A `DEFERRED` row is compliant because `assertRegistry()` forces it to name a
> `blockedBy`; the gate accepts a declared, reasoned deferral and fails only an undeclared one.
> **Do not read "18 of 19 pass the gate" as "18 of 19 workers run."** 12 run.

**NOT composable — 1 of 19:**
- **`coordinator`** — `LEADER_ONLY_NOT_COMPOSABLE`. Its round loop needs `expandCandidates`,
  `pricedCandidateFor` and `commit`. The first two resolve through
  `plan/insertion.js → planBuilder.hopsForSequence → routing/cellPairCache.hopsFor` to an injected
  `route` function — **the routing engine, which B1 has not selected**. `gate:composition` exits 1
  on exactly this one violation, with owner **EXTERNAL**.

**DEFERRED — 6 of 19, each with the blocker the registry itself records.** Only the first is B1's:

| Worker | Tier | Why it is not scheduled | Released by |
|---|---:|---|---|
| `shadow` | 1 | Needs the same constructed solve path as `coordinator` — `round`, `expandCandidates`, `pricedCandidateFor`, `budgetsFor`, `deferPriceFor`, all bottoming out in the injected `route`. **Consequence: `shadow_agreement` cannot begin accumulating evidence at all — the 14-day clock cannot start** | **B1** (EXTERNAL) |
| `index_maintainer` | 1 | Needs the capability/container and charging classifiers (`capabilityAndContainerClassesFor`, `chargingStatusFor`). The index is maintained on the telemetry path; the sweep is the self-healing pass, and a classifier answering "unknown" would evict live agents | Those classifiers |
| `charger_reachability` | 1 | Exposes a pass function rather than a scheduler; driven by the routing layer's cache-miss path today. Scheduling it needs a routing client this process does not construct | **B1** → Phase 8's `routing/client.js` |
| `energy_calibration` | 1 | Exposes a pass function rather than a scheduler; its inputs are realised-outcome rows the fleet has not produced. One of the loops **B8**'s calibration owner governs | **B8** + an operating fleet |
| `service_time_model` | 1 | Exposes a pass function rather than a scheduler; §22.4 names per-site service-time models among the values that "require data the fleet does not yet produce" | An operating fleet |
| `capacity_pricing` | 2 | Tier 2. `killswitch.opportunity_cost_term` is thrown at launch (§1.8 rule 3), so `C_opportunity` reads static priors and nothing consumes a live λ_zone | **Phase 16a**, under its own gate |

**Consequence for Phase 15's own stated purpose.** The plan's Phase 15 row is "all engine workers
move from shadow to production scheduling". On the current tree that is satisfied for **12 of 19**.
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

**Current state (re-measured 2026-08-30):** **250** registered entries — 52 `DERIVED`, **160**
`PROVISIONAL`, 38 `UNCALIBRATED`; **54 Safety-class**; **39 blocking findings**. Every finding names
what it awaits (a measurement, a certification, or an operations/safety decision).

*(Was 242 / 152 on 2026-08-29. T1-04 added 8 `PROVISIONAL` §17.4 ladder-rung fractions, **none
Safety-class**, so the 54 and the 39 are unchanged — T1-04 added no Safety-class calibration debt.)*

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
search — so **TLC is not runnable on this tree**. The discharging suite asserts `exhaustive: false`
for the lifecycle at capacities 1, 2 and 3; the commitment half is exhaustive only at capacity 1.
This is blocker **B-M**, whose evidence state is **NOT MEASURED / OPEN**.

**What has and has not been run, precisely** — `formal/README.md` is the record, and a blanket "TLC
has never been run" understates it:

| Module | TLC execution |
|---|---|
| `lifecycle.tla` | **Never run under TLC, at any capacity, by any pass** (`formal/README.md:94-100`) |
| `commitment.tla` | **Run on 2026-08-15 under TLA+ 1.8.0**, in an environment that then had the jar (`formal/README.md:34-45`): `commitment_c1.cfg` **as checked in** closed with no error (17 991 520 states / 2 375 660 distinct / diameter 21 / 48 s), and a **reduced** capacity-2 form closed (37 633 116 / 4 769 532 / diameter 21 / 69 s). `commitment_c2.cfg` as checked in did **not** converge (stopped past 1 h, 11 GB queue still growing); `commitment_c3.cfg` did not complete |

Neither recorded run discharges the gate: it was executed against a different tree, without a
recorded tool checksum, operator or hardware statement, and five of the six checked-in
configurations remain uncompleted. **Whether the historical `commitment_c1.cfg` run counts toward
the six is the release owner's acceptance decision**, not Engineering's — see
[`B1_EXTERNAL_INPUT_HANDOFF.md`](B1_EXTERNAL_INPUT_HANDOFF.md) §7.

**Two structural gaps, recorded and not to be fixed:** a completed TLC run has **no normal
evidence-admission path** (the gate is `EVIDENCE.SUITE` and `evidence.admit()` refuses any run
record whose command is not `npm run test:engine -- ModelCheck`), and **`formal/` is outside the
source-digest scope**, so no evidence record binds the state of the `.tla` modules or the six
`.cfg` files. Both are detailed in [`PHASE_15_BLOCKERS.md`](PHASE_15_BLOCKERS.md) § **B-M**.

---

## Legacy retirement

**Complete.** Four modules were deleted, not bypassed: `taskAssignment.service.js`,
`costEvaluator.service.js`, `robotValidator.service.js`, `taskRecovery.service.js`.
`tools/gates/checkLegacyRetirement.js` fails the build if any returns — currently PASS across
**346** files *(340 on 2026-08-29; the corpus grew with T1-04's and V-10's files — the load-bearing
number is **4 absent**, not the corpus size)*, 0 retired symbols redefined.
`src/engine/config/register/legacy.json` records the
retirement note for each.

**There is no legacy dispatcher to fall back to.** After Phase 15, `ENGINE_ENABLED=false` for a
shard means *that shard has no decision path*, not *another one serves it*.

---

## Database

**Implemented.** `prisma/schema.prisma`, **28 migrations** under `prisma/migrations/`
*(27 on 2026-08-29; T1-04 added exactly one, `20260830120000_ladder_escalation_t1_04`)*.
**Re-counted directly 2026-08-30 — 28 directories, 28 `migration.sql` files.** *This said "29",
which its own parenthetical refutes; the 29 was wrong wherever it appeared.*
**Six** live-database harnesses under `tools/verify/`:

| Harness | Checks | Owner |
|---|---:|---|
| `phase15LiveDatabase.js` | 12 | Phase 15 |
| `phase15CurrentTree.js` | 32 | Phase 15 |
| `phase15EvidenceBinding.js` | 17 | Phase 15 |
| `phase15VersionInForce.js` | 19 | Phase 15 |
| `t104LadderLiveDatabase.js` | 72 | T1-04 + the `Leg.slaDeadline` producer |
| **`v10RollbackRunbook.js`** | **15** | **V-10 — `rollback.md` §2.1 against the live API** |
| | **167** | |

**Every one refuses to run against Neon or a default-port (5432) instance by name.** They require a
disposable cluster. Applying all **28** migrations to an empty database yields the Phase 15 74 domain
tables plus `LadderEscalation`, plus `_prisma_migrations` — re-applied from empty on 2026-08-30
for V-10 (`prisma migrate deploy`, *"All migrations have been successfully applied"*), and **again
from empty on 2026-08-30 for V-9: 28/28 applied, 0 failed, 0 rolled back, 76 base tables.**

### The Phase 0–14 harnesses — 22 more, and what V-9 established about them

`tools/verify/` holds **28** harnesses in total: the six above, plus **22 belonging to Phases
3–14**. They are not Phase 15's, but Phase 15's tree movement is what put them back in question,
and **closure item V-9 answered that on 2026-08-30**:

- **4 of the 22 carry a changed module in their transitive `require()` closure** —
  `phase5ExpirySemantics` (5, two of them direct), `phase9ProductionPath` (5, all via the real
  HTTP intake path), `phase14LiveDatabase` (3, and it calls the changed `admitToRound`),
  `phase11LiveDatabase` (1, `observability/metrics`). **The other 18 carry none.**
- **7 were executed** on a disposable PostgreSQL 18.3 cluster: **315 / 317 checks**. The 2
  failures are `phase5ExpirySemantics` **FINDING assertions** that §17.4's ladder does not
  exist — which **T1-04 deliberately made false** — and neither is a regression.
- **`phase12LiveDatabase.js` cannot run from an empty cluster**, and not for a Phase 15 reason:
  `prisma/seed.js` aborts silently and exits 0 (residual observation 8), so no `Mission` row is
  ever created. **Pre-existing since 2026-08-09, proven by construction.**

Full scope table, exit codes and classifications: `PHASE_15_VERIFICATION_STATE.md` **§7c**.

---

## Frontend contracts

`Frontend/` was rewired by Phase 15 for the §3.4 task contract and the cutover posture surface.
`src/controllers/tasks.controller.js` carries the API version and the retention-window note;
`src/controllers/health.controller.js` exposes `GET /api/health/cutover`.
**No Phase 15 blocker is frontend-owned.**

---

## Runbooks

`<repo root>/docs/runbooks/cutover.md` and `rollback.md` — repository root, **not**
`Backend/docs/`.

- `cutover.md` §3.2 mirrors `verdict.js`'s merge exactly, including **gate-id collision
  detection** that forces a colliding gate `pass: false` (the P15-F7 fix, corrected).
- `rollback.md` documents Rollback A (disable one shard, manual and automatic), Rollback B
  (redeploy the previous artefact), and the §5 rehearsal that the `rollback_rehearsed` gate is
  evidence for.

**Both were traced against the current API on 2026-08-30 — closure item V-10, the first time any
pass had done it.** Five defects were found and fixed. The one that mattered: §2 step 1 told an
operator to *"Publish `authorisation.action.binding`"*, and a configuration version is a
**complete set**, so the manual Rollback A reverted every other parameter in the deployment to
its register default. `rollback.md` gained **§2.1** (the carry-forward recipe, the endpoint and
the pin) and **§7** (the date of this trace and what it found). The full list is in
[`PHASE_15_BLOCKERS.md`](PHASE_15_BLOCKERS.md) § **V-10**.

**Structural gap (P15-F7a) — unchanged and still open: nothing binds a runbook to the API it
documents.** `docs/` is outside the digest scope by design, so no gate anywhere detects a
runbook drifting from the signature it calls. V-10 did **not** close this and deliberately built
neither of the two things that would appear to: digest-scoping `docs/` (which voids a ~25-minute
evidence collection on every prose edit) or a prose-parsing gate (an unmaintained future false
green). What now exists instead are two partial compensating controls, and they are the most
that should be built:

- **`rollback.md` §7** records the date of the last hand-trace and the digest it ran against, so
  a reader can tell how old the last check is instead of assuming there was one.
- **`Backend/tests/engine/phase15RollbackRunbook.test.js`** pins the two *constants* the runbook
  enumerates — the carry-forward binding set and `evidence.REHEARSAL_STEPS`' six keys. It parses
  no prose and reads no markdown.

---

## Tests

**162 suites / 7 275 tests**, exit 0, re-measured 2026-08-30 at digest `d033038c…` *(160 /
7 162 on 2026-08-29)*. Five Jest projects (`jest.config.js`): `legacy`, `gates`, `engine`,
`chaos`, `scale`.

Phase 15-specific suites under `tests/engine/`:
`phase15CurrentTreeRemediation.test.js`, `phase15EvidenceBindingRemediation.test.js`,
`phase15ObservationAuthority.test.js`, `phase15ObservationWindowRemediation.test.js`,
**`phase15RollbackRunbook.test.js`** (V-10, 7 tests — the carry-forward binding set and
`evidence.REHEARSAL_STEPS`' six keys).

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
verify:t104        node tools/verify/t104LadderLiveDatabase.js      (T1-04, live DB)
verify:v10         node tools/verify/v10RollbackRunbook.js          (V-10, live DB)
```

Both `verify:*` scripts require a `DATABASE_URL` pointing at a **disposable** cluster and refuse
`neon.tech` and port 5432 by name.

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
| ~~`src/engine/fairness/ladder.js`, `operatorCapacity.js`, `agentStarvation.js`~~ | **NO LONGER ABSENT — REMEDIAL PHASE T1-04 ran on 2026-08-30.** All three exist, are composed into the production timer and worker paths, and are verified against live PostgreSQL. See `PHASE_15_BLOCKERS.md` § *X1 / T1-04* for what is implemented, where it runs, and the four parts of §17.4/§17.5 that genuinely remain. **`Leg.slaDeadline` gained its producer on 2026-08-30** (`task.service.superviseQueuedEntry`, same transaction and same resolved budget as the §4.5 `QUEUED` timer), so §17.4's third triage key — SLA breach proximity — is no longer inert |
| `src/engine/lifecycle/preemption.js` | Phase 16. **Tier 2** — §17.4 rung 4 emits a `PERMIT_PREEMPTION_OF_LOWER_CLASS` directive rather than calling it, because §1.8 rule 2 forbids a Tier 1 guarantee from depending on a Tier 2 mechanism |
| `src/engine/solve/setPartitioning.js`, `branchAndBound.js`, `localSearch.js` | Phase 16 |
| `src/engine/routing/client.js` | Phase 8, blocked by N25/N26 and B1 |
| `tla2tools.jar` | B-M — needs compute provisioning |
| Any Tier 2 mechanism | Phase 16. Every §22.5 kill switch remains thrown |
| A `TASK`-entity timer producer | **X3** — §4.2 has no transition table. Specification-owned |
| A production caller for `stage.authoriseEnable()` | By design — the operator procedure is the caller |
| A production caller for `assertVersionInKey` | **A9** — its Phase 8 seam does not exist |
