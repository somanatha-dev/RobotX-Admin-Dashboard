# Phase 15 — Independent Verification Report

**Role:** Independent Software Verification Engineer. Did not implement Phase 15.
**Scope:** `IMPLEMENTATION_EXECUTION_PLAN.md` §3 "PHASE 15 — Verification, release gates, and
production cutover" (rows 712–735) and its §7 checklist (lines 1297–1318);
`NEXT_GENERATION_ASSIGNMENT_ENGINE.md` §24 in full, cross-referenced against §20.1, §22.4, §26;
cross-checked against `PHASE_15_IMPLEMENTATION_REPORT.md` and `PHASE_14_INDEPENDENT_VERIFICATION.md`
for continuity at the Phase 14/15 boundary.
**Date:** 2026-08-08 · **Branch:** `feature/dashboard` · **Baseline:** `cf9103f` ("3rd aug 2026
phase 5 implemented and verified"), with **all of Phases 6–15 present only as one uncommitted
working tree** on top of it (confirmed by `git log`/`git status`; this matches Phase 14's own
verification report, which recorded the same fact one phase earlier). No commit boundary exists
between phases in this repository state, so cross-phase regression below is assessed by
re-running the full test suite and the build gates rather than by `git diff`.
**Method:** Independent re-execution of every command named in the audit brief, in this
reviewer's own shell; direct, full reads of the highest-risk modules (`cutover/enabled.js`,
`gates.js`, `guardrails.js`, `stage.js`, `store.js`, `cutover.worker.js`, `checkCalibration.js`,
`checkLegacyRetirement.js`, `task.service.js`, `minCostFlow.js`, `kv.js` §reserveRobot,
`health.controller.js`, `tasks.controller.js`, `workers/registry.js`, `formal/README.md`);
independent recomputation of the parameter register (Node one-liner against `config/service.js`)
and of Safety-class entry counts (`grep` across all four register JSON files); repository-wide
`grep` sweeps for reintroduced legacy symbols; four parallel read-only sub-investigations
(scale-suite statistical claims, formal/model-checker claims, safety-case + socket contract,
chaos-suite code quality + Phase 16 boundary), each independently re-run and cross-checked
against this reviewer's own spot reads before being accepted into this report. No file was
modified, fixed, or reverted. No shard was enabled. No configuration was changed.

---

## 1. Executive Summary

Every load-bearing claim in `PHASE_15_IMPLEMENTATION_REPORT.md` was independently reproduced.
The six build gates, the calibration gate, the chaos suite, the scale suite, the simulator
fidelity gate, the safety-case assembler, and the full five-lane Jest suite were all re-run in
this reviewer's own shell and matched the report's figures **exactly** — including the two red
findings (calibration, scale) and the `NOT_EVALUATED` production gates. The Frontend build was
independently re-run and succeeds. The cutover machinery (`enabled.js`, `gates.js`,
`guardrails.js`, `stage.js`, `store.js`, `cutover.worker.js`) was read in full and its five
refusals, its one-directional automatic rollback, and its "no shard has a decision path when
disabled" behaviour all check out against the code, not merely the report's description of it.
Legacy retirement was independently confirmed at the file level (four services deleted), the
gate level (`gate:legacy` re-run, PASS), and by a repository-wide semantic grep that found the
retired symbols and modules referenced **only** in comments, docstrings, and register
`retirementNote` strings — never in executable code. A test (`intakeStranglerSeam.test.js:201-224`)
independently confirmed to genuinely assert it, not merely claim it: a refused request creates
**zero** `Task` rows and leaves `WorkQueue` empty.

Four background sub-investigations independently corroborated the report's claims about the
scale suite, the chaos suite, the formal/model-checking machinery, the safety-case assembler, and
the socket/Frontend contract. All five areas check out as described. Two non-blocking precision
gaps were found in the process (§16, Findings 2 and 4) — neither invalidates the report's central
claims, and neither is a claim the report makes incorrectly so much as a claim the report does not
make as narrowly as the underlying code would support.

**The calibration gate is genuinely, mechanically red** (39 Safety-class parameters not
`DERIVED`, independently recomputed at 242 total register entries / 54 Safety-class / 52
`DERIVED` overall), it is genuinely absent from `npm run gates` and genuinely present in
`npm run release:gates` (which independently reproduces exit code 1, stopping at the calibration
step before chaos/scale/safety-case ever run), and `cutover/stage.authoriseEnable()` genuinely
refuses every shard while it is red — traced through the actual gate-blocking logic, not assumed.
**The scale finding is genuinely reproducible**: `minCostFlow.js`'s own header states "successive
shortest paths with Johnson potentials," the scale suite's exponent measurement is a real
`process.hrtime.bigint()`-timed benchmark over real solver calls (not a mock), and the suite
asserts `record.attained === false` — a test that is proven able to fail in the direction that
matters, and would fail today if the gap were closed without updating the report. No shard is
staged. No calibration value was fabricated. Nothing from Phase 16 is present.

**Final decision: PASS WITH MINOR ISSUES — code and machinery correct; production release
genuinely and correctly blocked.**

> **PHASE 16: NOT READY.**

This is not a defect in Phase 15's implementation. It is Phase 15's release-gate machinery
correctly reporting that the organisational and production prerequisites for Phase 16 do not yet
exist — which is a different fact from "Phase 15 is unfinished," and the distinction is preserved
throughout this report.

---

## 2. Verification Methodology

1. Read `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` §20 (Performance), §22.4 (Calibration discipline),
   §24 (Testing and Verification, in full), §26 (Invariants Register) verbatim.
2. Read `IMPLEMENTATION_EXECUTION_PLAN.md`'s Phase 15 row and its §7 checklist (lines 1297–1318)
   verbatim, plus the Phase 13/14 rows for continuity context.
3. Read `PHASE_15_IMPLEMENTATION_REPORT.md` in full and `PHASE_14_INDEPENDENT_VERIFICATION.md` in
   full to establish the Phase 14→15 boundary this review inherits.
4. Recorded the baseline (§3 below) before running anything.
5. Independently re-executed every command named in the audit brief, in this reviewer's own
   shell, capturing exact output and exit codes rather than trusting the report's transcripts.
6. Read the highest-risk source files directly and in full (listed above), rather than sampling.
7. Ran targeted repository-wide `grep` sweeps for legacy-symbol reintroduction and for
   Phase 16 modules.
8. Delegated four narrowly-scoped, independent read-only fact-finding passes (scale-suite
   statistics, formal/model-checker internals, safety-case + socket contract, chaos-suite code
   quality + Phase 16 boundary) to sub-investigations, each given the specific claims to verify
   and told to cite file:line for everything. Their findings were cross-checked against this
   reviewer's own direct reads (the cutover machinery, the calibration gate, legacy retirement,
   the solver header, `intakeStranglerSeam.test.js`, `formal/README.md`, the kill-switch defaults,
   the parameter register recomputation, `custodyState`/`solve.time_budget`) before being accepted.
9. No fix, revert, configuration change, or shard enable was made at any point.

---

## 3. Baseline

| Item | Value |
|---|---|
| Branch | `feature/dashboard` |
| HEAD commit | `cf9103f7df444483f5234fa92b1be98937ec8853` ("3rd aug 2026 phase 5 implemented and verified") |
| Working tree | Phases 6–15 present as one uncommitted diff on top of HEAD (68 files changed, 11,529 insertions, 2,839 deletions vs. HEAD at review start; 4 legacy service files staged as deleted (`D`); numerous new files under `src/engine/cutover/`, `src/engine/candidates/`, `src/engine/cost/`, `formal/`, `docs/`, `tools/safetyCase/`, `tools/simFidelity/` untracked) |
| Node | v22.17.0 |
| npm | 11.12.1 |
| `ENGINE_ENABLED` | `false` in `.env`, `.env.benchmark`, and `tests/setup/env.js` (all three independently read) |
| `AGENT_MTLS_REQUIRED` | `false` in the same three files |
| Cutover configuration | No shard live: `cutover/stage.authoriseEnable()` refuses every shard because the calibration gate (and, absent supplied evidence, every other release gate) is not GREEN |
| Kill switches (`killSwitches.normaliseState()`, independently invoked) | All 12 Tier 2 mechanisms default `true` (thrown) — `reposition_injection`, `preemption`, `deferral`, `cross_region_candidacy`, `chaining`, `multi_leg_columns`, `reliability_based_gating`, `batch_solving`, `opportunity_cost_term`, `churn_pricing`, `local_search`, `duty_cycle_regulariser` |
| Parameter register (independently recomputed via `config/service.js`) | 242 total entries, 54 Safety-class, 52 `DERIVED` overall |
| Database/test state | No live DB required for gates/tests; Jest's `tests/setup/env.js` boots `kv.js` into in-memory fallback and unsets Redis/Mapbox env vars deliberately, confirmed by direct read |

Note: the Phase 15 report's own baseline line names 2026-08-10 as its date and this review's
system date is 2026-08-08 — two days apart in the same direction phase reports have run ahead of
calendar date in this repository before (Phase 14's report is dated 2026-08-09 against this
review's clock too). Not investigated further; it does not affect any verification finding.

---

## 4. Build and Release-Gate Re-Execution

All commands were independently re-run in this reviewer's own shell.

| Command | Result | Independent match to report |
|---|---|---|
| `npm run gates` (6 build gates) | **PASS**, all six | Exact: tier-dependencies 273/375/0; parameter-register 179/242/0; tenets 270/0; identity-isolation 16/0; erasure-reconstruction 3 corpus/0 erased/byte-identical; legacy-retirement 4 modules absent/285 files |
| `npm run gate:calibration` | **FAIL**, 39 blocking findings | Exact: 242 entries (52 DERIVED/152 PROVISIONAL/38 UNCALIBRATED), 54 Safety-class, 39 `SAFETY_NOT_DERIVED` findings by name. Independently recomputed the same 242/54/52 via a direct call to `config/service.loadRegister()` |
| `npm run test:chaos` | **PASS** | Exact: 3 suites, 44 tests, 0 failures |
| `npm run test:scale` | **PASS** | Exact: 3 suites, 21 tests, 0 failures |
| `npm run sim:fidelity` | Reports `NOT_MEASURED` on all 7 models (no `--input` supplied) | Exact: matches report §12's "NOT_EVALUATED — No study; every model reports NOT_MEASURED" |
| `npm run safety:case` | **PASS**, "every reference resolves" | Exact: 12 hazards / 38 predicates / 22 invariants; 0 green, 0 red, 23 not evaluated; regenerated `docs/safety-case/SAFETY_CASE.md` independently diffed byte-identical against the committed copy |
| `npm run release:gates` | **Exit code 1**, stops after `gate:calibration` fails | Correct and expected: the `&&`-chained script never reaches `test:chaos`/`test:scale`/`safety:case` in this invocation, because calibration is checked first in the chain and is red. This is the release/build distinction working as designed, independently traced through `package.json`'s script definition, not assumed |
| `npm test` (all 5 lanes) | **PASS** | Exact: 135 suites, 6,008 tests, 0 failures, 249.6s |
| Per-lane: `test:legacy` | **PASS** | Exact: 17 suites, 126 tests |
| Per-lane: `test:gates` | **PASS** | Exact: 6 suites, 84 tests |
| Per-lane: `test:engine` | **PASS** | Exact: 106 suites, 5,733 tests |
| `npx vite build` (Frontend) | **PASS** | Exact: "✓ built in 7.49s"; matches report §4's "npx vite build succeeds" |

No discrepancy was found between this reviewer's own execution and the report's claimed figures
on any of the above. The calibration gate's 39 findings were read in full; every one names a
Safety-class parameter, its exact status (`PROVISIONAL` or `UNCALIBRATED`), and what data it
awaits — spot-checked against `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` §22.4's own list of examples
(zone-level price priors, failure costs by mission class, per-class wear coefficients,
per-site-per-stop-type service-time models) and found consistent.

---

## 5. Phase 15 Checklist Verification (execution plan, lines 1297–1318)

| # | Requirement | Evidence (independently checked) | Verdict | Blocking? |
|---|---|---|---|---|
| 1 | Complete `formal/commitment.tla` and `formal/lifecycle.tla`; all §24.2 properties checked | `formal/lifecycle.tla` confirmed 451 lines at repo root; `formal/README.md` (69 lines) discloses TLC has never been run and names the executable equivalent by file. §24.2's liveness properties **are** written in full temporal-logic form in the `.tla` file (`WF_vars(Next)`, lines ~360-450) but this file has never been executed | **PASS WITH MINOR ISSUE** — written and internally consistent, but "checked" is true only via the executable equivalent, not TLC, and the report says so | Not blocking (§24.2 permits an equivalent checker) |
| 2 | Model check at `capacity = 2` and `3`, not only 1 | Independently re-ran `model.check()` at all three configurations: capacity 1 → 5,706 states, capacity 2 → 29,691, capacity 3 → 68,934, all `exhaustive: true`, 0 violations — exact match to the report | **PASS** | — |
| 3 | Complete the chaos suite (§24.5), whole suite at capacity 2 and 1 | `test:chaos` independently re-run: 3 suites/44 tests/0 failures; confirmed both capacities are exercised via `describe.each(harness.eachCapacity())`, `CAPACITIES = [1, 2]` | **PASS** | — |
| 4 | Cache-tier flush under load (I16) | `cacheFlush.chaos.test.js` independently confirmed to import and exercise the real `commitment/commit.js`, not a mock; asserts exact active-commitment counts and unique `(legId, fence, capacitySlot)` after a flush mid-load | **PASS** | — |
| 5 | Deliver the fleet simulator (§18.2/§18.3/§18.5) | Confirmed no standalone demand generator with controllable burstiness/spatial correlation exists; injection surfaces (`failure/agentFailures.js`, `infraFailures.js`, `degraded/modeRegister.js`) and `VirtualRobot`/`SimulationEngine` do exist and are exercised by the chaos suite | **PARTIAL** — accurately reported as partial in §14 item 4 | Feeds the `simulator_fidelity` PRODUCTION gate, which is separately blocking |
| 6 | `tools/simFidelity/validate.js` — per-model comparison | Independently re-ran: reports per-model, per-slice `NOT_MEASURED` with no `--input`; module exists and is wired into `sim:fidelity` and `release:gates` | **PASS** | — |
| 7 | One-sided fidelity gate | Confirmed via re-run: `sim:fidelity`'s output states the gate is one-sided at a 5.0% optimistic bound; source not separately re-audited for the pessimistic-permits assertion beyond the report's own description, which is consistent with the gate's stated design | **PASS** | — |
| 8 | Label unvalidatable scenarios | Not independently re-derived beyond confirming `VERDICT.UNVALIDATABLE` is a distinct status from `PASS`/`NOT_MEASURED` in the fidelity tool's output vocabulary (seen in the `sim:fidelity` re-run's own status column) | **PASS** | — |
| 9 | Scale/perf suite incl. both p99.9 targets | `round.scale.test.js:158-171` independently confirmed to assert `sli.assertTargets()` and that exactly `commit_transaction_p999` and `decision_to_dispatch_p999` carry a non-null `window` field naming the safety window each bounds — a schema/documentation check, not a latency check, and correctly characterised as such by the report's own wording ("asserted to carry the window they bound") | **PASS** | — |
| 10 | Soak/overload tests | `overloadAndSoak.scale.test.js` independently confirmed to run real admission-control logic (`admission.rungAt()`/`assess()`) and a genuine soak-detector self-test that plants an unbounded `Set` and asserts the harness flags it (`outcome.bounded === false`); the multi-day duration itself is not run, correctly disclosed | **PASS AS SHAPE CHECK; DURATION NOT DISCHARGED** | `soak` PRODUCTION gate remains blocking |
| 11 | Shadow mode ≥ 2 weeks, agreement report | No live traffic exists in this environment; `cutover.shadow_agreement_window` confirmed registered (14 days, DERIVED). Correctly reported as impossible here | **NOT EVALUATED (correctly so)** | Blocking |
| 12 | Calibration: every Safety-class `DERIVED` | Independently re-run and recomputed: 39 blocking, 54 Safety-class total, 52 DERIVED overall (not all Safety) | **FAIL, genuinely and correctly** | Blocking |
| 13 | Assemble the safety case (§24.7) | Independently re-run: PASS, every reference resolves; regenerated document byte-identical to the committed one; three planted-failure tests (dangling predicate, dangling invariant, unmitigated hazard) independently confirmed to exist and pass | **PASS** | — |
| 14 | `cutover.md` / `rollback.md`; rehearse rollback | Both runbooks read in full; both are substantive and internally consistent (§7 below). Rehearsal is explicitly named an ORGANISATIONAL gate `rollback_rehearsed` and not discharged | **PASS ON THE DOCUMENT; REHEARSAL NOT DISCHARGED, CORRECTLY DISCLOSED** | `rollback_rehearsed` PRODUCTION/ORGANISATIONAL gate remains blocking |
| 15 | Stage `ENGINE_ENABLED=true` per shard | Confirmed: machinery complete (§7 below), zero shards staged, `authoriseEnable()` genuinely refuses on the calibration gate first | **PASS (machinery); NOT STAGED, correctly so** | — |
| 16 | Retire the four legacy services | Confirmed at the filesystem level (`git status` shows `D`) and at the gate level (`gate:legacy` PASS) | **PASS** | — |
| 17 | Remove the legacy path from `task.service.js` | `task.service.js` read in full: no `_processAssignment`, `_finalizeAssignment`, `legacyDetachedAssignment`, `seedTaskKeys`, `selectNearestRobot`; `assignTask` is one path with a pre-write cutover gate | **PASS** | — |
| 18 | Update Frontend socket contracts | Independently confirmed (§9 below): all four named files, correct event semantics | **PASS** | — |
| 19 | Retire legacy socket events/Redis keys after retention window | Confirmed deliberately not done, condition-gated in `cutover.md` §5; `robotReserve:*` correctness-reliance confirmed retired (production callers: zero, `reserveRobot` called only from test files) | **PASS (deliberately deferred, as designed)** | — |
| 20 | Gate: every §24 gate green; every §26 invariant `ENFORCED`; legacy removed | One of three true (legacy removal). §24 gates: 2 genuinely RED, 4 genuinely `NOT_EVALUATED`. §26: no production operation has occurred, so no invariant has been observed `ENFORCED` in production | **NOT MET, correctly and honestly reported as not met** | Blocking — this is the Phase 16 gate itself |

---

## 6. Architecture Compliance

- **§1.8 no partial cutover** — `enabled.forShard()` is the single conjunction point; `tierTwoAtShipState()` in `stage.js` independently read and confirmed to refuse if any Tier 2 kill switch is not thrown, checked as refusal #2 in `authoriseEnable()`.
- **§22.2 no new scope level** — `cutover.engine_enabled` resolves at `region` scope; `enabled.js`'s own comment and `stage.js`'s binding construction (`{ level: "region", key: regionId, ... }`) both confirm no new hierarchy level was introduced.
- **§22.3 no automated Safety change** — independently traced at three points (§8 below): `guardrails.AUTOMATIC_ACTIONS` has exactly one member; `assertOneDirectional()` throws on anything else; `authoriseEnable()` refuses `automated: true` outright, checked as refusal #3.
- **§22.4 pre-declared guardrails** — `guardrails.assess()` independently read and confirmed to refuse (return `HOLD` with an explicit `refusal` string) any observation window that opened before its guardrails were declared.
- **§21.7 audit** — `stage.auditEventFor()` independently read: carries the guardrail declaration inline in the audit event payload, and `store.js`'s `declarationFor()` reads it back exclusively from the audit stream (`AuditEvent`), never from an in-memory cache.
- **Tier discipline** — `gate:tiers` independently re-run: 273 modules / 375 edges / 0 Tier 0/1 → Tier 2 violations.
- **§22.1 no bare constants** — `gate:params` independently re-run: 179 modules / 242 parameters / 0 bare constants.
- **T1/T6** — `gate:tenets` independently re-run: 270 modules / 0 violations.

No architecture-compliance discrepancy was found.

---

## 7. Cutover Machinery — Full Read

`src/engine/cutover/enabled.js`, `gates.js`, `guardrails.js`, `stage.js`, `store.js`, and
`src/workers/cutover.worker.js` were each read in full by this reviewer (not sampled, not
delegated). Findings:

- **The conjunction is real and correctly ordered.** `forShard()` is `processEnabled(env) &&
  configEnabled(snapshot, shard)`, both pure functions of their inputs, and `configEnabled` fails
  closed (`false`) on any snapshot that cannot resolve, including a missing or malformed one —
  confirmed by reading the `try { ... } catch { return false; }` wrapper directly.
- **The five refusals in `authoriseEnable()` are all present, all early-return, and all
  individually unit-tested** (`tests/engine/cutoverStaging.test.js`, 5 tests named "1 —" through
  "5 —" exactly matching the five refusal reasons). Order: reason present → release gates →
  Tier 2 ship state → two-person approval (and a separate check for `automated: true`) →
  pre-declared guardrails (existence, shard match, and timestamp ordering) → staging order.
- **`gates.blockers()` genuinely blocks on all 23 gates, all `blocking: true`, and defaults every
  unsupplied gate id to `NOT_EVALUATED`**, which `evaluate()`'s `ok` computation treats identically
  to `RED`. Read `assertGates()`, which runs at module load and throws on a malformed row — this
  is a load-time invariant, not a test-only one.
- **`authoriseRollback()` genuinely has no gate.** The only refusal is a missing reason. The
  automatic path is forced through `guardrails.assertOneDirectional("DISABLE")` before
  `authoriseRollback` is even called from `cutover.worker.js`, and `assertOneDirectional` itself
  throws on any action other than `"DISABLE"` — read directly, not inferred from the module's
  docstring.
- **`cutover.worker.js`'s `assessShard()` treats a live shard with no declaration as a finding**,
  not as "no guardrails, therefore fine" — read directly at lines 57-69, confirming the report's
  characterisation.
- **No alternate enable path was found.** The only production caller of a `region`-scope
  `cutover.engine_enabled = true` binding traced in this review is the object
  `authoriseEnable()` returns, which nothing but a caller with a second approver can obtain, and
  the automatic controller cannot construct that object at all (`assertOneDirectional` would
  throw first).
- **`GET /api/health/cutover`** (`health.controller.js`, read in full) is genuinely read-only: it
  renders `cutoverGates.evaluate(req.app?.locals?.releaseEvidence || {})` and states in its own
  comment "Evidence is not manufactured here" — confirmed no code path in this controller writes
  evidence, only reads whatever a caller has filed on `app.locals`.

No bypass, waiver, or alternate enable path was found anywhere in the cutover surface.

---

## 8. Legacy Retirement Verification

- **Filesystem.** `git status` independently confirms `taskAssignment.service.js`,
  `costEvaluator.service.js`, `robotValidator.service.js`, `taskRecovery.service.js` are staged
  as deleted (`D`), along with their five corresponding legacy test files.
- **Gate.** `tools/gates/checkLegacyRetirement.js` read in full. Three checks: (1) the four
  files do not exist on disk; (2) no `require(...)` of any of them exists anywhere in `src/` or
  `tools/`, scanned with comments stripped but **string literals preserved** — confirmed this
  distinction is real by reading `findImports()`'s use of `stripComments()` versus
  `findDefinitions()`'s use of `codeOnly()`, exactly as the module's own header explains the
  difference matters (a module specifier is a string literal, and `codeOnly()` would blank it,
  producing a false pass); (3) none of five named retired symbols
  (`_processAssignment`, `_finalizeAssignment`, `legacyDetachedAssignment`, `seedTaskKeys`,
  `selectNearestRobot`) is *defined* (not merely referenced) in `task.service.js`. Independently
  re-ran: PASS, 285 files scanned.
- **Repository-wide semantic grep**, run independently of the gate's own logic, for
  `taskAssignment|costEvaluator\.service|robotValidator|taskRecovery|_processAssignment|
  _finalizeAssignment|legacyDetachedAssignment|robotReserve\(` across `Backend/src`: 9 files
  matched, and every single match, read in context, is a comment, a module docstring, or a
  `retirementNote` string in `config/register/legacy.json` — never executable code. The pattern
  `setImmediate` was separately grepped (4 files): three are comments describing what the
  *removed* pattern used to look like, and the one live call
  (`socket.server.js:219`) is a dashboard-rehydration convenience on socket connect, unrelated to
  task assignment, pre-dating Phase 15 and outside its scope.
- **`kv.reserveRobot`** — read in full. Advisory by default now (`advisory = !options ||
  options.advisory !== false`), with the fail-closed throw reachable only via an explicit
  `{ advisory: false }`. Grepped every call site of `.reserveRobot(` in the repository: all
  production call sites are gone; the only remaining callers are in
  `tests/unit/redis/lockFailClosed.test.js`, `tests/unit/dtaro/reservationLocking.test.js`, and
  `tests/engine/commitmentTransaction.test.js` — exercising the function directly, not through
  any live request path. This independently confirms the report's claim that "no caller in the
  repository passes it {advisory: false}" and, more strongly, that no production code calls
  `reserveRobot` at all any more.
- **`gate:legacy` can fail** — confirmed via its own self-test suite
  (`tests/gates/checkLegacyRetirement.test.js`), which plants a restored module, an import (in
  code, in a comment, and via every specifier spelling), and a redefined symbol (in the target
  file and, as a negative control, in an unrelated file) and asserts each case's correct verdict.
  13 distinct test cases read by name; all pass.

**Routing correctness — independently traced.** `tasks.controller.js`'s `assignTask` handler
calls `taskService.assignTask`, which (read directly, `task.service.js:220-237`) evaluates
`cutoverEnabled.describe(...)` and throws a `503`/`ENGINE_NOT_LIVE` error **before** the
`prisma.task.create(...)` call that follows it. This was independently verified not just by
reading the code but by reading the test that exercises exactly this ordering:
`tests/engine/intakeStranglerSeam.test.js:201-224`, `"with the shard NOT live, assignTask refuses
with 503 and writes nothing"`, which counts actual `prisma.task.create` invocations (asserts
`created === 0`) and asserts `prisma.__tables.workQueue` has length 0 after the refusal. This is
a genuine, falsifiable assertion, not a description.

---

## 9. Socket / Frontend Contract Verification

Independently confirmed (cross-checked between a dedicated sub-investigation and this reviewer's
own direct reads of the report's claims):

- `socket.server.js` emits `task_accepted` before the `task_assigned` echo (lines ~320 and ~331
  respectively; comment states "task_accepted is emitted first, because it is the true one").
- `task_error` carries `code` (e.g. `ENGINE_NOT_LIVE`), distinguishing it from an ordinary
  validation failure.
- `Frontend/src/lib/socket.js` defines `DASHBOARD_EVENTS` (including `TASK_ACCEPTED:
  "task_accepted"`, `TASK_ASSIGNED: "TASK_ASSIGNED"`, `TASK_ERROR: "task_error"`),
  `RETIRED_AFTER_RETENTION_WINDOW`, and `ENGINE_NOT_LIVE`.
- `Frontend/src/context/AppProvider.jsx` subscribes to `TASK_ACCEPTED`, `TASK_ERROR`,
  `OFFER_RESPONSE`, and the all-caps `TASK_ASSIGNED` — and does **not** subscribe to the
  lowercase `task_assigned` echo anywhere in the file (grep for the literal string finds only
  explanatory comments stating the non-subscription is deliberate, because that event's payload
  carries `PENDING`/null-robot and reading it as an assignment would be the exact conflation
  §3.4 forbids).
- `TASK_ASSIGNED` (all caps) is unchanged and its handler still reads `pathToPickup`/`pathToDrop`
  to draw a route — genuinely means an assignment occurred.

No discrepancy found.

---

## 10. Release-Gate Verification — the Two Red Findings, in Depth

### A. Calibration

- **Exact count, independently recomputed twice** (once via `npm run gate:calibration`'s own
  formatted output, once via a direct Node call to `config/service.loadRegister()`): 242 total
  entries, 54 Safety-class, 52 `DERIVED` overall, 39 blocking `SAFETY_NOT_DERIVED` findings.
  Cross-checked the 54 Safety-class figure a third way — `grep`-counting `"changeClass": "SAFETY"`
  across all four register JSON files individually — `appendixA.json` 21 + `killSwitches.json` 12
  + `legacy.json` 2 + `supplementary.json` 19 = **54**, matching exactly. The register is
  distributed across four files by convention (not only `appendixA.json`, despite the
  specification's shorthand "every Safety-class entry in Appendix A"); this is consistent with
  how `config/service.js` aggregates the register and is not a discrepancy.
- **Gate implementation** (`tools/gates/checkCalibration.js`, read in full): a Safety-class entry
  that is not `DERIVED` is unconditionally blocking (`SAFETY_NOT_DERIVED`); a Safety-class entry
  that claims `DERIVED` but states no `derivation` (or `section`+`requiredBy` pair) is
  **also** blocking (`SAFETY_DERIVATION_NOT_STATED`) — read this as a deliberately stronger check
  than a status-field toggle, since a status field alone can be edited without the underlying
  derivation existing.
- **Gate tests** — `tests/gates/checkCalibration.test.js` read by name: 12 distinct cases,
  including "a Safety-class parameter that is PROVISIONAL blocks," "...claiming DERIVED with no
  stated source blocks," "a NON-Safety PROVISIONAL entry does not block," "`npm run gates` does
  not run it," "it blocks the thing it is a gate on: no shard can be enabled while it is red," and
  "the gate's evidence kind is ORGANISATIONAL." All represent genuine, falsifiable assertions
  about the gate's own behaviour, independently confirmed to pass.
- **Exclusion from build gates / inclusion in release gates** — independently confirmed by
  reading `package.json`'s script definitions directly: `gates` chains six commands, none of
  which is `gate:calibration`; `release:gates` chains `gates && gate:calibration && test:chaos &&
  test:scale && safety:case`. Independently re-running `release:gates` produces exit code 1
  after the calibration step, before chaos/scale/safety-case run — the chain genuinely stops
  there, not merely "would stop there" per the report's prose.
- **`authoriseEnable()` refusal while RED** — traced directly in `stage.js`: refusal #1 calls
  `gates.blockers(source.releaseEvidence)`, and `calibration_safety_derived` is one of the 23
  rows in `gates.RELEASE_GATES`, `blocking: true`. With no evidence supplied (the default state
  of a fresh process), **every** gate — not only calibration — reads `NOT_EVALUATED` and blocks,
  which is a stronger refusal than calibration alone but consistent with it: there is no path by
  which a shard could be enabled while calibration evidence is absent or red.
- **Absence of bypass/override** — grepped `stage.js`, `gates.js`, and `checkCalibration.js` for
  any waiver, skip, or override parameter related to the calibration gate specifically; found
  none. The only override mechanism in the cutover surface (`options.overrideOrder`) applies
  exclusively to the staging-order refusal (#5) and is unrelated to gate status (#1).

**Determination: the RED state is legitimate.** It reflects a real, independently recomputed
count of un-derived Safety-class parameters, is correctly excluded from the build gate and
correctly included in the release gate, and mechanically blocks the cutover through code this
reviewer traced end to end rather than accepted on the report's word.

### B. Scale target

- `src/engine/solve/minCostFlow.js`'s own header (read in full) states the algorithm is
  "Successive shortest paths with Johnson potentials" — one Dijkstra-class search per
  augmentation, one augmentation per Leg — and explicitly contrasts this with §20.2's "typical"
  complexity table, which assumes cost scaling. This is a fact about the shipped algorithm, not
  an assertion the report makes unsupported by the code.
- The scale suite's exponent measurement (`round.scale.test.js`, `scaleHarness.js`) genuinely
  times real calls to `minCostFlow.solve()` over real solver instances (built via
  `objective.buildInstance`/`fixture.column`, with deliberately non-monotone costs "so the solve
  has real work to do") across four batch sizes and four candidate counts, using
  `process.hrtime.bigint()` and a real least-squares log-log fit — **not** a mock, hardcoded
  value, or stub.
- **Finding (non-blocking, precision only):** the report's headline figures ("≈2.0 in Legs,
  r² > 0.99," "≈0.65 in candidates") are the output of one specific measured run, and are quoted
  verbatim from a `console.log` line and the test file's own header comment — they are **not**
  the thresholds the test actually enforces. The enforced bounds are considerably wider:
  `expect(fit.exponent).toBeGreaterThan(1.5)` / `.toBeLessThan(2.6)` for Legs,
  `.toBeGreaterThan(0.3)` / `.toBeLessThan(1.3)` for candidates, and `expect(fit.rSquared)
  .toBeGreaterThan(0.9)` — not `> 0.99`. The test file's own comment explains this is deliberate
  ("bounds wide enough to survive a loaded CI runner and narrow enough to catch a real change of
  algorithm"), which is a defensible engineering choice, but a reader who takes the report's
  quoted figures as the release gate's enforced tolerance would be mistaken about what
  `npm run test:scale` actually guards. See Finding 4, §16.
- The suite separately, and genuinely, measures the concrete §20.1 shape: 500 Legs × 10
  candidates against the 250 ms round-wall-clock target, and asserts
  `expect(record.attained).toBe(false)` and `expect(record.measured).toBeGreaterThan
  (record.target)` — with an explicit comment that asserting `attained` (the naive-looking
  assertion) would have made the gate pass "by measuring nothing." This is proven able to fail in
  the direction that matters: it would fail today if the solver were fast enough, and it will fail
  in the future if the gap closes without the report being updated. This directly satisfies the
  audit brief's "determine whether the RED gate is genuine" question: **yes**, both by
  independent re-execution (`npm run test:scale` passes because the gap is correctly detected and
  asserted, not despite it) and by reading the assertion's polarity directly.
- **Locality test — finding, not a defect.** `locality.scale.test.js`'s "measured round-time
  comparison" section builds a **single** solver instance and solves that same instance object
  twice, comparing the two timings; the claimed "5,000-agent fleet" and "1,000,000-agent fleet"
  figures are passed only as inert labels into the comparator instrument
  (`sizing.compareLocality`), which never reads them as an input to solve behaviour. The file's
  own header discloses this plainly ("Both runs solve the *identical* instance… A million agents
  cannot be created in a test process… The actual million-agent benchmark is a staging exercise")
  — so this is not a misrepresentation by the test author, and the suite does genuinely verify two
  narrower, real properties instead: that `sizing.js` contains no fleet-wide term (via source
  grep) and that the comparator instrument itself is correctly two-sided (via a separate synthetic
  test). But the `locality` row in `gates.js` is classified `EVIDENCE.SUITE` — "closable by a
  build" — and the actual T9 claim ("statistically indistinguishable round times... small fleet
  and... million-agent fleet") is **not** discharged by anything closable by a build in this
  repository; it remains dependent on an external staging exercise not present here. See
  Finding 5, §16.

**Determination: the RED `scale_targets` finding is genuine and reproduces.** Independently
re-measured via `npm run test:scale`, confirmed the assertion's polarity is correct (fails if the
target were met without being updated), and confirmed the algorithm-class claim against the
solver's own source. No optimisation or fix was attempted, per the audit's explicit prohibition.

---

## 11. Automatic Rollback — Disable-Only, Traced

Three independent enforcement points, each read directly rather than inferred:

1. `guardrails.AUTOMATIC_ACTIONS = Object.freeze(["DISABLE"])` — a frozen array of length 1.
2. `guardrails.assertOneDirectional(action)` throws unless `AUTOMATIC_ACTIONS.includes(action)`;
   called unconditionally inside `cutover.worker.js`'s `assessShard()` before any rollback is
   authorised, and separately inside `stage.authoriseRollback()` when `source.automatic === true`.
3. `stage.authoriseEnable()` refuses outright (`REFUSAL.NO_SECOND_APPROVER`) any request carrying
   `automated: true`, independent of the guardrails module entirely — a second, structurally
   different enforcement point, so a future change that routed an "automated enable" around
   `guardrails.js` would still be refused at `stage.js`.

No path was found — in `stage.js`, `guardrails.js`, or `cutover.worker.js` — by which an
automated process could construct or publish an `ENABLE` action. `cutover.worker.js`'s
`runOnce()`/`assessShard()` was read in full: it only ever calls `stage.authoriseRollback()`,
never `stage.authoriseEnable()`.

---

## 12. Formal / Model Verification

- `formal/lifecycle.tla` (451 lines), `formal/README.md` (69 lines), and all six `.cfg` files
  (`commitment_c{1,2,3}.cfg`, `lifecycle_c{1,2,3}.cfg`) independently confirmed present at the
  repository root (not under `Backend/`, matching how `docs/` and the plan's own citations are
  also rooted).
- `formal/README.md` is explicit and consistent with the implementation report: TLC has not been
  run; the executable equivalents are named by file; the two forms are stated to "fail
  differently," with the TLA+ module checkable by reading against the spec and the JS checker
  checkable by running against the shipped code; and it explicitly instructs that the JS checker
  must not be described as TLC. This report does not describe it as TLC.
- **`tests/engine/helpers/lifecycleModel.js` genuinely imports and drives the real production
  modules** — `src/engine/lifecycle/legMachine.js`, `taskMachine.js`, `transitions.js` — calling
  `transitions.find()`, `transitions.GUARD_EVALUATORS`, `transitions.evaluateGuards()`,
  `transitions.targetOf()`, `transitions.cancellationGuard()` directly. It does not call
  `transitions.apply()` (the Prisma-transactional write), which is correct: a model checker
  should drive the pure transition function, not perform durable writes.
- **State counts independently reproduced** by directly invoking `model.check()` at all three
  configurations: capacity 1 → 5,706 states; capacity 2 → 29,691; capacity 3 → 68,934; all
  `exhaustive: true`; 0 violations. Exact match to the report.
- **Note on what "asserted" means here:** the test file does not hardcode these three integers as
  literal assertions. It asserts `exhaustive === true`, a floor (`states > minStates`, with floors
  of 5,000/25,000/60,000), and monotonic growth across capacities. The exact figures quoted in
  the report are this reviewer's and the report's independently reproduced *run output*, not a
  compile-time guarantee — a reasonable design choice (a hardcoded exact count would make the
  test brittle to legitimate table growth) but worth stating precisely for the record.
- **`exhaustive: true` is a genuine claim, not an assumption**: `check()` performs a real BFS with
  a canonical-state `visited` set; `exhaustive` is forced `false` only if the visited set reaches
  a 300,000-state cap before the frontier empties. None of the three runs approached that cap and
  each frontier fully drained. Exhaustiveness is explicitly bounded by a finite search depth
  (12/9/7 respectively) — a stated, disclosed bound, not an unbounded claim, and the report never
  claims otherwise.
- **`CANCELLED`/`WITHDRAWN` non-reachability is genuine and documented, not silent.**
  `transitions.js` has no row targeting `S.CANCELLED`; `S.WITHDRAWN` appears only as an annotative
  `via:` field on a row whose actual `to` target is `S.QUEUED`. `lifecycleModelCheck.test.js`
  contains a dedicated block that asserts the 17 reached states by name and separately asserts
  `CANCELLED`/`WITHDRAWN` are **not** reached, with commentary explaining this is a fact about the
  shipped §4.4 table. Independently re-ran and printed the reached-state set at all three
  capacities: confirmed absent in every one.
- **Liveness is checked only as reachability, not fairness — exactly as claimed.**
  `checkNoDeadEnds()` has its own doc comment stating plainly that a bounded explicit-state search
  cannot express fairness or infinite traces, and its implementation only checks that every
  non-terminal state has at least one enabled outgoing transition. By contrast, `formal/
  lifecycle.tla` **does** state the two liveness properties in full fairness-qualified temporal
  form (`WF_vars(Next)`, `<>`/`~>` operators) — but that file has never been executed. The report's
  characterisation ("checked in their reachability form... rather than under fairness") is
  accurate on both halves of the comparison.

**Minor precision nuance, not blocking:** this review found a Java runtime **is** present in this
verification environment (`java -version` → 20.0.2), which slightly overstates the report's
absolute framing of "no Java toolchain there." However, `tla2tools.jar` (the actual TLA+ model
checker) is not vendored anywhere in the repository, and fetching it would require network access
outside this audit's read-only scope. TLC was **not** run by this review, consistent with the
audit's prohibition on fixing or completing findings — but the precise blocker is "no TLA+
tooling is vendored in the repository," not strictly "no Java toolchain," and the report's wording
should be read with that nuance. This does not change the substantive finding: TLC has not been
executed, and the executable equivalent's coverage and limitations are accurately described.

---

## 13. Safety-Case Verification

- `Backend/tools/safetyCase/assemble.js` (271 lines, confirmed) reads `docs/safety-case/
  hazards.json` (114 lines, repo root — the report itself cites this path correctly; the
  audit brief's `Backend/docs/...` framing was the imprecise part, not the report) and writes
  `docs/safety-case/SAFETY_CASE.md` (292 lines).
- **`hazards.json` genuinely contains identifiers only.** Every one of its 12 hazard objects has
  exactly the keys `id, title, severity, section, description, mitigatedByPredicates,
  monitoredByInvariants` — no `class`, `status`, `policy`, or `verdict` field. This is enforced
  by a test that asserts the exact key set and regex-validates every referenced id
  (`/^F\d+$/`, `/^I\d+$/`), not merely a convention.
- **`assemble.js` genuinely queries live registers**, not hardcoded strings: it calls
  `feasibilityRegister.predicate(predicateId)` and reads `constraintClass`/`policy`/`group`/
  `volatile` directly off the live register object; it checks `invariantChecker.CHECKS
  [invariantId]` for existence and `INVARIANT_TIERS[invariantId]` for tier, both live lookups
  against `src/engine/` modules, not a restated copy.
- **Byte-identical regeneration independently re-verified twice**: once by this reviewer's own
  `npm run safety:case` invocation (which reports "PASS — every reference resolves" and rewrites
  the file in place with no `git status` diff against the freshly-created untracked copy), and
  once by a sub-investigation that ran the assembler to a scratch path and diffed it against the
  committed copy (`diff` exit 0).
- **All three planted-failure properties confirmed enforced and passing**, in
  `simFidelityAndSafetyCase.test.js`: a dangling predicate reference (`"F99"`) produces a problem
  string matching `/F99/` and `/worse than no safety case/`; a dangling invariant reference
  (`"I99"`) produces a problem matching `/I99/` and `/An invariant nobody checks is a comment/`;
  a hazard with both `mitigatedByPredicates` and `monitoredByInvariants` empty produces a problem
  matching `/neither a mitigating constraint nor a monitoring invariant/`.

No discrepancy found. This is the strongest-evidenced claim in the entire report: independently
reproduced by two separate execution paths with identical byte-for-byte results.

---

## 14. Chaos Suite — Code Quality (Not Merely Test Count)

Independently confirmed, via direct reading of `tests/chaos/helpers/chaosHarness.js` and
`commitment.chaos.test.js` (with `cacheFlush.chaos.test.js` and `agentAndStore.chaos.test.js`
spot-checked), that the suite exercises real production logic rather than tautological mocks:

- The harness's own header states it models `SELECT … FOR UPDATE` as a genuine blocking mutex
  with a FIFO wait queue and enforces the actual database CHECK constraints and partial unique
  indexes at apply time — explicitly contrasted, in the header comment, with "a mock that returns
  canned values [that] would let every one of those properties pass vacuously."
- All three chaos test files `require()` real engine modules directly:
  `src/engine/commitment/commit.js`, `commitment/fencing.js`, `commitment/model.js`,
  `shard/leadership.js`, `dispatch/dedupHandshake.js`, `degraded/modeRegister.js`,
  `observability/invariantChecker.js`. The guard/fencing/commit logic under test is not stubbed;
  only narrow injection seams (`volatileRecheck`, `sideEffects`) are overridden per scenario.
- **Representative assertion, read in full**: the 30-randomised-coordinator-kills scenario
  (seeded LCG, `commitment.chaos.test.js:26-69`) asserts each stale in-flight commit aborts with
  the real `ABORT_REASON.G1_LEADERSHIP_FENCE_ADVANCED`, then reads the store's rows through the
  **shipped** `model.isActive` predicate and asserts zero active commitments landed after 30
  kills — a meaningful, falsifiable claim verified against production code, not a locally
  redefined notion of "active."
- **Kill-mid-commit** races a real in-flight `commit()` transaction against a leadership-row
  update and asserts the store shows zero commitment rows and an unchanged Leg version — proving
  no partial write survived, not merely that a function returned without throwing.
- **Cache-flush/I16** flushes a real cache model mid-load and checks the resulting store rows for
  exact capacity-bounded uniqueness, plus a companion test that greps the actual `commit.js`
  source for any cache-client identifier and asserts none exists — confirming I16 by construction
  as well as by behaviour.
- **Capacity 1 and 2 both genuinely exercised**: `CAPACITIES = [1, 2]`, `eachCapacity()` feeds
  `describe.each`, confirmed present in 9 `describe.each` blocks across the three files.
  Independently re-run: 44/44 tests pass, consistent with the claimed scenario count.

No tautological or mock-only test was found among the cases examined.

---

## 15. Phase 16 Boundary Verification

| Item | Finding |
|---|---|
| `src/engine/fairness/` | Empty — only `.gitkeep`. Confirmed via `Glob`. |
| `src/engine/lifecycle/preemption.js` | Absent. Confirmed via `Glob`. |
| `src/engine/solve/{setPartitioning,branchAndBound,localSearch}.js` | Absent. Confirmed via `Glob`. |
| Kill switches default thrown | Confirmed: all 12 (`normaliseState()` independently invoked) default `true`; `killSwitches.json` register entries each carry `"default": true`. |
| `phase0Scaffold.test.js` module-tree walk | Exists (`"holds runtime code only where a landed phase owns it"`): walks `ENGINE_ROOT`, asserts every file matches a declared per-phase ownership prefix, and `fairness/` is explicitly and repeatedly named as forbidden in the comments for phases 10–15. |

**Finding (non-blocking, worth flagging):** the module-tree walk grants `lifecycle/` and `solve/`
as **whole-directory** ownership prefixes (unlike `shard/`, `security/`, and `cutover/`, which are
listed file-by-file specifically, per the test's own comments, "because a directory prefix here
would stop this walk catching a Phase 16 module dropped into the same folder"). This means that,
today, `src/engine/lifecycle/preemption.js` or `src/engine/solve/setPartitioning.js` would **not**
be caught by this particular mechanical safety net if added, because both directories are already
wholesale-owned by earlier phases. The boundary currently holds — both files were independently
confirmed absent by `Glob` — but it holds because the files do not exist, not because this test
would refuse their addition, which is a narrower guarantee than the test provides for the other
three Phase-16-adjacent directories. See Finding 3, §16.

No Phase 16 functionality — fairness, preemption, a Tier 2 solver mechanism, or a live Tier 2
kill switch — was found anywhere in the repository.

---

## 16. Findings

| # | Severity | Category | Affected files | Description |
|---|---|---|---|---|
| 1 | Informational | Environment precision | `formal/README.md`, `formal/lifecycle.tla` header | Both state "no Java toolchain" in the implementation environment. This verification environment has Java 20.0.2 present, though `tla2tools.jar` is not vendored in the repository and was not fetched (out of this audit's read-only scope), so TLC remains unrun regardless. The precise blocker is "no TLA+ tooling is checked in," not strictly "no Java." Does not change the substantive finding that TLC has not been executed. |
| 2 | Minor | Documentation precision | `PHASE_15_IMPLEMENTATION_REPORT.md` §1, §14 item 2 | The quoted exponent/r² figures ("≈2.0 in Legs," "≈0.65 in candidates," "r² > 0.99") are one measured run's `console.log` output and the test file's own header comment, not the thresholds `round.scale.test.js` actually enforces (which are considerably wider: 1.5–2.6, 0.3–1.3, r² > 0.9 respectively). The underlying finding — quadratic-class behaviour, target missed at the stated shape — is genuine and independently reproduced; only the precision of the quoted statistic is looser than presented. |
| 3 | Minor | Test-coverage gap | `Backend/tests/engine/phase0Scaffold.test.js` | The module-tree walk that guards against Phase 16 leakage grants `lifecycle/` and `solve/` as whole-directory ownership, unlike the file-by-file ownership used for `shard/`, `security/`, and `cutover/`. A future `lifecycle/preemption.js` or `solve/{setPartitioning,branchAndBound,localSearch}.js` would not be caught by this specific test today. No leakage currently exists (independently confirmed absent), so this is a gap in the safety net's uniformity, not a live defect. |
| 4 | Minor | Release-gate evidence classification | `Backend/src/engine/cutover/gates.js` (`locality` row) | The `locality` gate is classified `EVIDENCE.SUITE` ("closable by a build"), but the shipped `locality.scale.test.js`'s timing comparison solves the identical solver instance twice rather than at two different fleet scales — genuinely verifying two narrower properties (no fleet-wide term in `sizing.js`; the comparator instrument's own correctness) rather than the T9 claim itself. This is disclosed candidly in the test file's own comments, so it is not a misrepresentation by the implementation, but a reader relying on `gates.js`'s one-line `statement` field alone could reasonably believe the T9 claim is build-closable when it is not; the real cross-scale benchmark remains an external staging exercise not present in this repository. |
| 5 | Informational | None — confirms report | — | No blocking or previously-undisclosed defect was found in the cutover machinery, legacy retirement, the calibration gate, the scale gate's core assertion polarity, the safety case, the socket contract, the formal-verification disclosure, or the chaos suite's fidelity to production code. |

None of the five findings touches correctness of the cutover gate, the absoluteness of the
one-directional rollback, the legacy-retirement guarantee, or the genuineness of either red
release gate. All are precision or coverage-uniformity notes.

---

## 17. Release-Gate Matrix (independently evaluated against `cutover/gates.js`'s own 23 rows)

| Gate | Evidence kind | Status (this review) | Basis |
|---|---|---|---|
| `tier_dependencies` | BUILD | GREEN | `npm run gate:tiers` re-run |
| `parameter_register` | BUILD | GREEN | `npm run gate:params` re-run |
| `design_tenets` | BUILD | GREEN | `npm run gate:tenets` re-run |
| `identity_isolation` | BUILD | GREEN | `npm run gate:privacy` re-run |
| `erasure_reconstruction_equivalence` | BUILD | GREEN | `npm run gate:erasure` re-run |
| `calibration_safety_derived` | ORGANISATIONAL | **RED, genuinely** | `npm run gate:calibration` re-run; 39 findings independently recomputed |
| `legacy_removed_from_build` | BUILD | GREEN | `npm run gate:legacy` re-run |
| `lower_bound_admissibility` | SUITE | GREEN (inferred) | Part of the 106/5,733 passing `engine` lane |
| `model_check_capacity_1_2_3` | SUITE | GREEN | State counts independently reproduced, `exhaustive: true`, 0 violations at all 3 capacities |
| `determinism_replay` | SUITE | GREEN (inferred) | Part of the passing `engine` lane; golden-corpus reconstruction independently confirmed byte-identical via `gate:erasure` |
| `snapshot_retention` | SUITE | GREEN (inferred) | Part of the passing `engine` lane |
| `chaos_capacity_1` | SUITE | GREEN | `npm run test:chaos` re-run, capacity-1 scenarios independently spot-read |
| `chaos_capacity_2` | SUITE | GREEN | Same re-run, capacity-2 scenarios independently spot-read |
| `cache_tier_flush` | SUITE | GREEN | `cacheFlush.chaos.test.js` independently spot-read against real `commit.js` |
| `scale_targets` | SUITE | **RED, genuinely** | `npm run test:scale` re-run; `record.attained === false` assertion independently confirmed correct in polarity |
| `locality` | SUITE (see Finding 4) | **PARTIALLY DISCHARGED** — structural halves genuine, cross-scale claim not build-closable as classified | §10.B, §16 Finding 4 |
| `overload_admission_control` | SUITE | GREEN | `overloadAndSoak.scale.test.js` independently spot-read, real admission logic |
| `invariants_enforced` | PRODUCTION | NOT_EVALUATED, correctly | No production operation has occurred |
| `simulator_fidelity` | PRODUCTION | NOT_EVALUATED, correctly | `npm run sim:fidelity` re-run, no study supplied |
| `soak` | PRODUCTION | NOT_EVALUATED, correctly | Shape-checked only; multi-day run not performed |
| `shadow_agreement` | PRODUCTION | NOT_EVALUATED, correctly | No live traffic exists here |
| `safety_case_assembled` | ORGANISATIONAL | GREEN | `npm run safety:case` re-run, byte-identical regeneration independently confirmed |
| `rollback_rehearsed` | ORGANISATIONAL | NOT_EVALUATED, correctly | `docs/runbooks/rollback.md` §5 names the rehearsal steps; none recorded as performed |

**2 genuinely RED, 1 partially discharged against its stated evidence class, 4 correctly
`NOT_EVALUATED` (PRODUCTION evidence unavailable in a repository), 2 `ORGANISATIONAL`
(1 GREEN, 1 unevaluated), remainder GREEN.** This independently reproduces the report's own §12
table exactly, with the addition of the `locality` nuance in Finding 4.

---

## 18. Final Decision

### Implementation correctness vs. production/release readiness — kept distinct throughout

**Phase 15's code is correctly implemented.** Every module this review read in full — the cutover
conjunction, the five refusals, the one-directional automatic rollback, the 23-gate table, the
calibration gate, the legacy-retirement gate (and its own proven-failable self-tests), the
runtime routing (gate-before-write, independently confirmed by a test that counts actual writes),
the socket/Frontend contract, the safety-case assembler (independently reproduced byte-for-byte
twice), and the formal-verification disclosure (accurately distinguishing an executed reachability
checker from an unexecuted fairness-qualified TLA+ specification) — matches its own documentation
and behaves as claimed under direct, independent re-execution.

**Mandatory production evidence is legitimately unavailable, not fabricated and not glossed
over.** Four release gates require realised production or staging operation (shadow agreement,
soak duration, fidelity study, invariants-enforced SLI) and cannot be discharged by any build in
this repository — a fact this review independently confirmed by re-running the tools that would
discharge them and observing them correctly report `NOT_EVALUATED` rather than a fabricated pass.
Two release gates are RED for reasons this review independently reproduced and traced to their
root cause in the source: 39 Safety-class parameters genuinely lack a derivation, and the shipped
solver is genuinely a quadratic-class algorithm against a sub-quadratic target. Both are reported,
neither is hidden, and neither was worked around by this review or (as far as this review's
reading of the code shows) by the implementation.

**The architecture and execution plan themselves require these gates before Phase 16**, and
Phase 15's own §24 gate table (independently confirmed to have no `WAIVED` status and no override
path for calibration or scale) makes that requirement mechanical rather than aspirational. The
release is correctly classified as blocked by that machinery, not by this review's judgement.

### Blocking findings requiring resolution before Phase 16

1. **Calibration** (violates §22.4, execution-plan checklist item 12) — 39 Safety-class
   parameters not `DERIVED`. Evidence: `npm run gate:calibration`, independently reproduced.
   Reproduction: `cd Backend && npm run gate:calibration`. Required correction: execution-plan
   pre-work item B8 — a named calibration owner deriving each value from measured or accounted
   data. **Must be resolved before Phase 16.**
2. **Scale** (violates §20.1, execution-plan checklist item 9) — round wall-clock at §20.1's own
   shape misses target by roughly an order of magnitude; root cause is the solver's algorithm
   class. Evidence: `npm run test:scale`, independently reproduced, assertion polarity confirmed
   correct. Reproduction: `cd Backend && npm run test:scale`. Required correction: a solver
   capable of meeting §20.2's "typical" complexity (e.g., cost-scaling min-cost flow), which is
   new capability outside Phase 15's stated scope. **Must be resolved before Phase 16**, since
   §20.1 targets are stated as release-gate requirements, not aspirations.
3. **Four PRODUCTION-evidence gates** (shadow agreement, soak, simulator fidelity, invariants
   enforced) — cannot be discharged by any repository build; require the fleet to have actually
   operated. **Must be resolved before Phase 16**, and no code change in this repository can
   resolve them.
4. **Rollback rehearsal** (ORGANISATIONAL) — the runbook is written and internally consistent, but
   §5's rehearsal has not been performed and recorded. **Must be resolved before Phase 16.**

None of these four is a defect in Phase 15's code. All four are exactly the categories of evidence
§22.4 and §24 predict will be organisationally, not technically, the harder half of the work — and
the machinery correctly refuses to let a build manufacture evidence it cannot honestly produce.

---

# PASS WITH MINOR ISSUES

Phase 15's implementation is correct, complete, and independently verified against its own claims
at every level this review could reach: build gates, release gates, cutover authorisation,
automatic rollback's one-directional guarantee, legacy retirement (file, gate, and repository-wide
semantic sweep), runtime routing, the socket/Frontend contract, the safety-case assembler, the
formal-verification disclosure, and the chaos and scale suites' fidelity to real production code.
Five non-blocking findings were recorded (one environmental-precision note, two report-precision
notes, one test-coverage-uniformity gap, and a release-gate-classification nuance); none affects
correctness or safety.

Production readiness is genuinely blocked — by calibration, by the solver's complexity class, by
the absence of production operation, and by an unperformed rollback rehearsal — and this is the
release-gate machinery working exactly as designed, not a gap in the implementation.

> **PHASE 16: NOT READY.**

Phase 16 must not begin. Its prerequisite, per the execution plan's own gate (checklist item 20),
is every §24 gate green and every §26 invariant observed `ENFORCED` in production; neither
condition holds, and this review found no evidence that either condition was worked around,
approximated, or misrepresented as holding.

---

*End of Phase 15 Independent Verification Report.*
