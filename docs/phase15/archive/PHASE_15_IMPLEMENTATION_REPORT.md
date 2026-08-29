# Phase 15 — Implementation Report

**Role:** Senior Distributed Systems Engineer implementing the frozen architecture
**Scope:** `IMPLEMENTATION_EXECUTION_PLAN.md` §3 "PHASE 15 — Verification, release gates, and
production cutover" (rows 712–735) and its §7 checklist (lines 1297–1318), implementing
`NEXT_GENERATION_ASSIGNMENT_ENGINE.md` §24 in full plus §20.1's release-gate targets, §22.4's
staging discipline, and the cutover the plan's §1.2 describes
**Date:** 2026-08-10 · **Branch:** `feature/dashboard` · **Baseline:** Phase 14,
independently verified PASS WITH MINOR ISSUES — "Phase 15 may begin"
**Phase 16 or later:** not implemented. No Tier 2 mechanism is enabled, every §22.5 kill
switch remains thrown, `src/engine/fairness/` and `src/engine/lifecycle/preemption.js` do not
exist, and `src/engine/solve/` gains no `setPartitioning.js`, `branchAndBound.js` or
`localSearch.js`. All asserted mechanically — see §13.

---

## 1. Executive Summary

Phase 15 delivers §24's verification suite, the §22.4 staging machinery, and the cutover
itself. **The legacy decision path is removed from the build, not merely bypassed**:
`taskAssignment.service.js`, `costEvaluator.service.js`, `robotValidator.service.js` and
`taskRecovery.service.js` are deleted; `task.service.js` contains no selection, no
finalisation, no `setImmediate` and no `robotReserve` retry loop; and a new build gate fails
the build if any of them returns.

Six new engine modules (`src/engine/cutover/**`, `src/workers/registry.js`), one background
worker, two build/launch gates, two verification tools, one TLA+ module with six TLC
configurations, one executable lifecycle model checker, two new Jest lanes, one new REST
surface, four Frontend files rewired, and 164 new tests (99 engine + gates, 44 chaos, 21 scale).

`npm run gates` — now **six** build gates — is green, and all five Jest lanes pass:
**135 suites, 6 008 tests, 0 failures.**

| Lane | Suites | Tests | Note |
|---|---|---|---|
| legacy | 17 | 126 | Was 169. The 43 that left tested the four retired services; see §13 item 1 |
| gates | 6 | 84 | Was 58 |
| engine | 106 | 5 733 | |
| **chaos** *(new)* | 3 | 44 | §24.5, every scenario at capacity 1 **and** 2 |
| **scale** *(new)* | 3 | 21 | §24.6 |

**Six things need a verifier's attention up front. Two of them are red, and they are red on
purpose.**

1. **The calibration launch gate is RED, and it blocks the cutover mechanically.** 39 of the
   54 Safety-class parameters are `PROVISIONAL` or `UNCALIBRATED`. §22.4 makes this a hard
   launch gate, and `cutover/stage.authoriseEnable()` refuses **every** shard while it is not
   green. This is execution-plan blocking pre-work item **B8** — a named calibration owner
   and data the fleet does not yet produce — not a code change, and §14 item 1 records why
   fabricating the values would be worse than reporting the gap.

2. **The scale suite found a real §20.1 gap, and it is recorded rather than smoothed away.**
   §20.2 says the singleton solve is "O(m · k · log) typical for min-cost flow **with cost
   scaling**". The shipped `solve/minCostFlow.js` is **successive shortest paths with Johnson
   potentials** — its own header says so — which is O(m² · k · log). The measured exponents
   match the prediction exactly (≈ 2.0 in Legs, ≈ 0.65 in candidates, r² > 0.99), and at
   §20.1's own shape the round takes seconds rather than the target 250 ms. `scale_targets`
   is therefore a blocking red gate with a stated, reproducible cause. §14 item 2.

3. **The calibration gate is deliberately NOT in `npm run gates`.** The other six gates
   assert properties of the *code*, which a commit introduced and a commit can fix. This one
   asserts a property of the *organisation*. Blocking every build on it would produce exactly
   the outcome §22.4 predicts — pressure to make the red go away rather than to do the
   derivation. It blocks the cutover instead, which is what "hard launch gate" means and what
   "build gate" does not. `tests/gates/checkCalibration.test.js` asserts both halves.

4. **"Disabled" no longer means "the legacy dispatcher serves it", and every surface says
   so in words.** With the legacy path out of the build, `cutover.engine_enabled = false` for
   a shard means that shard has **no** decision path. Intake refuses with 503 and a sentence
   rather than queueing work nothing will drain — because a task accepted, durably recorded
   and never decided is the precise failure §12.1 exists to eliminate. The sentence is a
   named constant, returned by the health endpoint, written into every rollback audit event,
   and is the first thing `docs/runbooks/rollback.md` says.

5. **The automatic rollback can only ever disable, and the asymmetry is enforced three
   ways.** §22.4 item 4 requires automatic rollback; §22.3 forbids an automated process from
   making the change that raises risk. Resolved rather than papered over:
   `guardrails.AUTOMATIC_ACTIONS` has exactly one member, `assertOneDirectional()` throws on
   anything else, and `authoriseEnable()` refuses an `automated: true` request outright.
   `cutover.engine_enabled` is classified STRUCTURAL rather than SAFETY for this reason, and
   the register entry says so.

6. **TLC still has not been executed.** `formal/lifecycle.tla` is written and six TLC
   configurations are checked in, but there is no Java toolchain in this environment. §24.2
   permits "TLA+ **or an equivalent model checker**", and the equivalent — which drives the
   *shipped* transition table rather than a transcription of it — is executed exhaustively at
   capacity 1, 2 and 3 on every build. `formal/README.md` records exactly what that means.
   §14 item 3.

---

## 2. Objectives Achieved

The Phase 15 checklist (§7, lines 1297–1318), item by item:

| # | Checklist item | Status |
|---|---|---|
| 1 | Complete `formal/commitment.tla` and `formal/lifecycle.tla`; all §24.2 properties checked | **Done, with a stated bound** — `lifecycle.tla` written (451 lines); `commitment.tla` unchanged from Phase 3. Checked by the executable equivalent, not by TLC; `formal/README.md` states it |
| 2 | Model check at `capacity = 2` and `3`, not only 1 | **Done** — six TLC configs checked in; `lifecycleModelCheck.test.js` runs all three exhaustively and asserts exhaustion, not just absence of counterexamples |
| 3 | Complete the chaos suite (§24.5) and run **the whole suite at `capacity = 2` as well as 1** | **Done** — `tests/chaos/**`, every `describe` via `describe.each(eachCapacity())`; 44 tests |
| 4 | Cache-tier flush under load: no commitment lost, duplicated, or double-granted (I16) | **Done** — `cacheFlush.chaos.test.js`; the flush model never serves a pre-flush generation, and the commit module is asserted to hold no cache client at all |
| 5 | Deliver the fleet simulator covering §18.2/§18.3 injection and every §18.5 mode | **Partially — recorded** — the injection surfaces exist and the §18.5 register is exercised; the standalone fleet simulator is not built. §14 item 4 |
| 6 | Implement `tools/simFidelity/validate.js` — per-model distribution comparison | **Done** — 357 lines; per-slice, worst-slice-decides, never averaged |
| 7 | **One-sided fidelity gate**: bias beyond `sim.max_optimistic_bias` fails the simulator | **Done** — a pessimistic bias of the same magnitude is reported and does **not** fail; asserted directly |
| 8 | Label scenarios with no real-world counterpart as unvalidatable stimuli | **Done** — `VERDICT.UNVALIDATABLE`, distinct from `PASS` and from `NOT_MEASURED`, and blocks the Tier 0 discharge |
| 9 | Scale and performance suite against every §20.1 target, incl. the two p99.9 targets | **Done, and it found a gap** — `tests/scale/**`; both p99.9 rows asserted to carry the window they bound. §14 item 2 |
| 10 | Soak tests over days; overload tests through admission control | **Done as shape checks; the duration is not run** — `overloadAndSoak.scale.test.js` checks for unbounded growth and is proven able to fail; `release.soak_duration` names the run that discharges the gate. §14 item 5 |
| 11 | Run shadow mode against live traffic for ≥ 2 weeks; publish the agreement report | **Not possible here** — no live traffic exists. `cutover.shadow_agreement_window` registered (14 days, DERIVED from the plan's own figure); the gate is `PRODUCTION` evidence and blocks. §14 item 5 |
| 12 | Complete calibration: **every Safety-class parameter `DERIVED`** | **Gate implemented; currently RED** — 39 blocking findings. §1 item 1, §14 item 1 |
| 13 | Assemble the safety case (§24.7) from queries over decision records | **Done** — `tools/safetyCase/assemble.js`; 12 hazards, and the only hand-written input carries identifiers and no evidence |
| 14 | Write `docs/runbooks/cutover.md` and `rollback.md`; rehearse rollback | **Written; rehearsal is an ORGANISATIONAL gate and is not discharged** — §5 of `rollback.md` states what a rehearsal must include |
| 15 | Stage `ENGINE_ENABLED=true` per shard with SLI guardrails and automatic rollback | **Machinery done; no shard staged** — the calibration gate refuses every shard, which is the machinery working |
| 16 | Retire `taskAssignment/costEvaluator/robotValidator/taskRecovery.service.js` | **Done** — deleted; `npm run gate:legacy` fails the build if any returns |
| 17 | Remove the legacy assignment path from `task.service.js` | **Done** — five functions removed; zero `setImmediate`, zero `robotReserve` |
| 18 | Update Frontend socket contracts | **Done** — all four named files; the dashboard now reads `task_accepted` and ignores the `task_assigned` echo |
| 19 | Retire legacy socket events and Redis keys **after the retention window** | **Deliberately not done — the plan conditions it** — `cutover.md` §5 tabulates each with its trigger. `robotReserve:*` reliance for correctness **is** retired now |
| 20 | **Gate:** every §24 gate green; every §26 invariant `ENFORCED`; legacy path removed from the build | **One of three met** — legacy removal: done and gated. The other two are not, and §12 says which and why |

---

## 3. Files Created

**Engine modules (6):**

| File | Lines | Purpose |
|---|---|---|
| `src/engine/cutover/enabled.js` | 186 | The conjunction — process `ENGINE_ENABLED` **and** the shard's `cutover.engine_enabled` — and the sentence that says what "off" now means |
| `src/engine/cutover/gates.js` | 406 | The §24 release-gate table as data: 23 gates, three statuses, four evidence kinds |
| `src/engine/cutover/guardrails.js` | 294 | §22.4 item 4's pre-declared guardrails, the three verdicts, and the one-directional rule |
| `src/engine/cutover/stage.js` | 396 | The five refusals, the staging order, and the audit event |
| `src/engine/cutover/store.js` | 150 | Reads the pre-declaration back out of the audit stream and the window out of the SLI store |
| `src/workers/registry.js` | 325 | Every engine worker, its readiness, and — for a deferred one — the collaborator it is missing, by name |

**Workers (1):** `src/workers/cutover.worker.js` (170) — the staged-rollout controller.

**Verification tools (4):**

| File | Lines | Purpose |
|---|---|---|
| `tools/gates/checkCalibration.js` | 255 | §22.4's launch gate. Not in `npm run gates`; blocks the cutover |
| `tools/gates/checkLegacyRetirement.js` | 302 | "Removed from the build, not merely bypassed", enforced |
| `tools/simFidelity/validate.js` | 357 | §24.4's one-sided fidelity gate |
| `tools/safetyCase/assemble.js` | 271 | §24.7's safety case, assembled from queries |

**Formal (8):** `formal/lifecycle.tla` (451), `formal/README.md`, and six `.cfg` files —
`commitment_c{1,2,3}` and `lifecycle_c{1,2,3}`.

**Documentation (4):** `docs/runbooks/cutover.md` (198), `docs/runbooks/rollback.md` (184),
`docs/safety-case/hazards.json` (114, the only hand-written safety input),
`docs/safety-case/SAFETY_CASE.md` (292, generated).

**Tests (15 files, 164 tests):** `tests/chaos/helpers/chaosHarness.js`,
`commitment.chaos.test.js`, `cacheFlush.chaos.test.js`, `agentAndStore.chaos.test.js`;
`tests/scale/helpers/scaleHarness.js`, `round.scale.test.js`, `locality.scale.test.js`,
`overloadAndSoak.scale.test.js`; `tests/engine/helpers/lifecycleModel.js` (521),
`lifecycleModelCheck.test.js`, `cutoverStaging.test.js`, `cutoverGuardrails.test.js`,
`simFidelityAndSafetyCase.test.js`; `tests/gates/checkCalibration.test.js`,
`checkLegacyRetirement.test.js`.

---

## 4. Files Modified

**Deleted (8):** the four retired services and the four legacy test files that exercised
them (`tests/unit/dtaro/{taskAssignment,costEvaluator,robotValidator}.test.js`,
`tests/unit/tasks/{taskRecovery,taskService}.test.js`).

**Backend (11):**

| File | Change |
|---|---|
| `src/services/task.service.js` | 717 → 400 lines. `_processAssignment`, `_finalizeAssignment`, `legacyDetachedAssignment`, `seedTaskKeys`, `getRoutesWithDistance`, `pathDistanceMeters` removed; `assignTask` refuses with 503 when the shard is not live |
| `server.js` | `recoverActiveTasks` import and call removed; `startScheduledWorkers()` added; `engineEnabled` now reads `cutover/enabled.processEnabled()` |
| `src/cache/kv.js` | `reserveRobot` is **advisory by default**; the fail-closed throw is retained behind an explicit `{ advisory: false }`, and the branch ordering fixed so a deliberately Redis-free deployment still gets a real memory lock |
| `src/controllers/tasks.controller.js` | §3.4 contract leads the response; `X-RobotX-API-Version`, `Deprecation`, `Link`, `supersededContract`, `ignoredFields` |
| `src/controllers/health.controller.js` | `GET /api/health/cutover` |
| `src/routes/health.routes.js` | The route |
| `src/sockets/socket.server.js` | `task_accepted` emitted before the `task_assigned` echo; `task_error` carries `code`; `assignTask` receives the config snapshot |
| `src/engine/config/killSwitches.js` | Every generated entry carries a stated `derivation` (§22.4) |
| `src/engine/cutover/stage.js` → register | 6 new parameters in `supplementary.json`; `legacy.json`'s dtaro entries record `retiredInPhase: 15` |
| `jest.config.js` | `chaos` and `scale` lanes, with their own timeouts and the reason stated |
| `package.json` | `test:chaos`, `test:scale`, `gate:calibration`, `gate:legacy`, `safety:case`, `sim:fidelity`, `release:gates`; `gates` gains `gate:legacy` |

**Frontend (4):** `src/lib/socket.js` (the event catalogue and what each name now means),
`src/context/AppProvider.jsx` (`task_accepted`, `task_error`, `OFFER_RESPONSE`),
`src/features/maps/mapControl/hooks/useRobotStream.js`, `src/features/maps/MapControl.jsx`.
`npx vite build` succeeds.

**Phase-boundary tests updated (7):** `costSchema`, `roundSchema`, `degradedSchema`,
`observabilitySchema`, `observabilityCounterfactual`, `phase0Scaffold`, `supervisionWorkers`,
`legacyConstantShim`, `intakeStranglerSeam`, `commitmentTransaction`, `zoneLocality`. Each
asserted "Phase 15 has not happened"; each now asserts the post-cutover fact.

---

## 5. Cut-over Behaviour

### The switch is two things, ANDed

| Half | Scope | Answers |
|---|---|---|
| `ENGINE_ENABLED` (env) | process | May this process stand for election, drain an outbox, run a round? |
| `cutover.engine_enabled` (config, `region` scope) | shard | Is the engine the decision path *for this shard*? |

`cutover/enabled.forShard()` owns the conjunction; no caller re-derives it. Region scope is
§22.2's own alias for a shard (`config/resolver.js`, convention 2) — **no scope level was
added**, which would have been an architecture change.

### What "off" means now

`false` for a shard means that shard has **no** decision path. Intake refuses with
`503 ENGINE_NOT_LIVE`; nothing is queued. `enabled.SHARD_HAS_NO_DECISION_PATH` is the single
sentence, returned by the health endpoint and written into every rollback audit event.

### The five refusals

`authoriseEnable()` refuses on: a blocking §24 gate not GREEN; a Tier 2 mechanism already
enabled (§1.8 rule 3); no second approver (or an automated request); guardrails not
pre-declared for this shard, or stamped after the request; the staging order skipped without
a reasoned override. All five are tested as refusals.

### Order and rollback

Ascending `agentCount`, ties by `shardId` — least blast radius first, publishable before the
cutover begins. `authoriseRollback()` has **no** gate, no quorum and no ordering rule: a
control that can be refused is not a control. The automatic controller may only `DISABLE`.

---

## 6. Runtime Behaviour

**Workers.** `src/workers/registry.js` declares all 18. `server.js` starts six at boot
(`invariant`, `tier_b`, `rejection_aggregation`, `calibration`, `counterfactual`, `cutover`)
plus `shard_supervisor` and `certificate_rotation`, inside the `ENGINE_ENABLED` gate. Four are
`LEADER_ONLY` (coordinator, outbox, reconciler, timer) and belong to the leadership lifecycle:
§19.3 admits one writer per shard, and a standby draining an outbox would be a second. Six are
`DEFERRED`, each with its blocker named — §14 item 6.

**Boot.** The boot-time task recovery pass is gone. Its replacement is not a call site: it is
`reconciler.scanOrphanLegs` running continuously under the shard leader.

**Request path.** One path. Validate → cutover gate (before any write) → create `Task` →
`intake.admit` → durable `WorkQueue` row. No branch, no detach, no background computation.

---

## 7. Database Changes

**None.** No migration was written and no column was dropped.

The plan conditions the only migration it contemplates: "Drop legacy columns **only after** a
full retention window with the new path live (`Robot.currentTaskId` retained as a read-only
mirror until then)." No shard is live, so the window has not started. Writing the drop now
would be writing a migration whose precondition is false.

The durable state the cutover machinery needs is carried by existing tables: the pre-declared
guardrails live in `AuditEvent` — §21.7's append-only hash-chained stream, which is the only
place in the system where the *ordering* of a pre-declaration cannot be edited afterwards —
and the per-shard switch is a `ConfigBinding`, versioned and approved like every other
parameter change.

---

## 8. API Changes

`POST /api/tasks/assign` — the §3.4 contract formally supersedes the legacy one:

- Response leads with `intake` (task id, idempotency echo, queue position, predicted window)
  and `apiVersion`.
- Headers: `X-RobotX-API-Version: 2026-08-15`, `Deprecation: true`, `Link: …rel="deprecation"`.
- `supersededContract` names what replaces what and when the legacy fields go.
- `task` retained through the retention window; `status` is `PENDING` and `robotId` is null on
  every successful call, **by construction** — the decision has not been taken yet.
- `task.robotId` on input is **no longer honoured** and is reported in `ignoredFields` rather
  than dropped silently. §23.6's override is the supported way to force an agent.
- `503 ENGINE_NOT_LIVE` when the shard is not live.

`GET /api/health/cutover` — **new.** Per-shard posture with its consequence in words, the
staging plan, the release-gate table, and the worker registry.

---

## 9. Redis Changes

**`robotReserve:*` reliance for correctness is retired.** `kv.reserveRobot` is advisory by
default; the fail-closed throw is retained and reachable via `{ advisory: false }`, and no
caller in the repository passes it. §3.3's rule — "cache unavailability MUST NOT halt
commitment" — now holds by default rather than by opt-in.

A latent ordering bug was fixed while making the change: the advisory short-circuit ran before
the "was Redis ever configured?" test, so a deliberately Redis-free single-process deployment
would have been handed `true` unconditionally instead of a real memory lock. The branch is now
written out longhand with the two cases distinguished.

**`robotTask:*`, `robotTaskState:*`, `taskPath:*` are retained.** The plan retires them "after
cutover"; `rerouteTask` reads them and deleting them now would strand every mission in flight
across the cutover. `cutover.md` §5 names the trigger.

---

## 10. Socket.IO Changes

**Server.** `task_accepted` is emitted **before** the `task_assigned` echo — the honest event
first. `task_error` gains `code`, so `ENGINE_NOT_LIVE` is distinguishable from a validation
failure. No event was removed: the plan retires them "once no client depends on them", after
the retention window.

**Frontend.** `src/lib/socket.js` is now the contract module: `DASHBOARD_EVENTS`,
`RETIRED_AFTER_RETENTION_WINDOW`, and `ENGINE_NOT_LIVE`, with each name's actual meaning
recorded. The dashboard subscribes to `task_accepted`, `task_error` and `OFFER_RESPONSE`, and
**does not subscribe to `task_assigned`** — its payload says `PENDING` with a null robot, and
reading it as an assignment is the conflation §3.4 forbids. `TASK_ASSIGNED` (capitals) is
unchanged and still means assigned.

---

## 11. Architecture Compliance

| Requirement | How it is met |
|---|---|
| §1.8 no partial cutover | One boolean for the whole decision path; `tierTwoAtShipState()` refuses if any Tier 2 mechanism is on |
| §22.2 no new scope level | Resolution at `region`, the existing alias for a shard |
| §22.3 no automated Safety change | `cutover.engine_enabled` is STRUCTURAL; the automatic path may only disable; an `automated: true` enable is refused |
| §22.4 pre-declared guardrails | `assess()` refuses a window that opened before its declaration |
| §21.7 audit | Every stage and rollback appends a hash-chained event carrying the declaration |
| §7.1 the gate is never traded against cost | No waiver path added; `task.robotId` no longer bypasses the gate |
| §24.7 evidence is a query | `hazards.json` carries identifiers only; class, policy, tier and gate status are read at assembly time; a dangling reference **fails** assembly |
| Tier discipline | `gate:tiers` green: 273 modules, 375 edges, no Tier 0/1 → Tier 2 dependency |
| §22.1 no bare constants | `gate:params` green: 179 engine modules, 242 registered parameters |
| T1/T6 | `gate:tenets` green: 270 modules |

---

## 12. Testing

**Build gates — six, all green.**

```
tier-dependencies          PASS  273 modules / 375 edges / 0 violations
parameter-register         PASS  179 modules / 242 parameters / 0 bare constants
tenets                     PASS  270 modules / 0 violations
identity-isolation         PASS   16 modules / 0 violations
erasure-reconstruction     PASS    3 corpus decisions / byte-identical
legacy-retirement          PASS    4 retired modules absent across 285 files   ← new
```

**Launch and release gates — the honest status.**

| Gate | Status | Why |
|---|---|---|
| `calibration_safety_derived` | **RED** | 39 Safety-class parameters not `DERIVED`. Pre-work B8 |
| `scale_targets` | **RED** | The quadratic solve. §14 item 2 |
| `simulator_fidelity` | **NOT_EVALUATED** | No study; every model reports `NOT_MEASURED`, which is not a pass |
| `shadow_agreement`, `soak`, `invariants_enforced` | **NOT_EVALUATED** | Require production operation |
| `rollback_rehearsed`, `safety_case_assembled` | **NOT_EVALUATED** | ORGANISATIONAL; no build can close them |
| everything else | discharged by the six build gates and the five lanes | |

**Model checking (§24.2).** Exhaustive at capacity 1, 2 and 3: 5 706 / 29 691 / 68 934 states,
`exhaustive: true` asserted in every case, zero violations. Seventeen of the nineteen §4.3 Leg
states are reached; `CANCELLED` and `WITHDRAWN` are not, and that is a fact about the shipped
§4.4 table recorded in the test rather than a search limitation — §15 item 2.

**Chaos (§24.5), at capacity 1 and 2.** Coordinator kills (30 randomised, seeded), kill
mid-commit, worker paused past its lease, clock skew, duplicate/reordered/expired commands,
`STAND_DOWN_ALL`, I19 sibling commandability, dependency latency and error injection, cache-tier
flush under load, agent power-cycle with dedup wipe, coordinator killed with SOFT reservations
outstanding, Commitment Store outage. 44 tests.

**Scale (§24.6).** Complexity exponents, locality, overload ladder monotonicity, soak shape
checks. 21 tests. The soak profile is proven able to fail by planting an unbounded structure.

---

## 13. Self Verification

1. **The legacy path is gone from the build.** `gate:legacy` passes over 285 files, and its
   self-test plants each of the four ways it could return — a restored module, an import
   (including from `server.js`, which sits outside both scanned trees), a redefined symbol —
   and asserts each is caught. The legacy lane fell from 169 to 126 tests; the 43 that left
   are exactly the five deleted files, which tested the retired services.

2. **No Phase 16 functionality.** `src/engine/fairness/` is empty; `preemption.js`,
   `setPartitioning.js`, `branchAndBound.js`, `localSearch.js` do not exist —
   `phase0Scaffold.test.js`'s module-tree walk and `costSchema.test.js` assert it. Every kill
   switch defaults thrown, and `tierTwoAtShipState()` refuses a cutover if one is not.

3. **Build and tests pass.** `npm run gates` green; 135 suites, 6 008 tests, 0 failures.

4. **Routing correctness.** `assignTask` has one path and no branch; the cutover gate runs
   before any write (asserted: a refused request creates no `Task` row).

5. **Cut-over correctness.** All five refusals tested as refusals; the enable produces a
   publishable `{ level: "region", key, name, value }` binding; the rollback is unrefusable
   except for a missing reason.

6. **Both new gates are proven able to fail.** `checkCalibration.test.js` plants four
   distinct violations; `checkLegacyRetirement.test.js` plants five, and three passes proving
   it does not fire on comments, strings, or same-named symbols in other files.

7. **The safety case cannot go stale silently.** A test asserts the on-disk generated document
   is byte-identical to a fresh assembly, and three tests assert that a dangling predicate,
   invariant, or an unmitigated hazard **fails** assembly.

8. **A flaky test was found and fixed twice, rather than retried.** The locality comparison
   failed once in fourteen isolated runs — two arms timed back to back let a garbage-collection
   pause land in one. Interleaving the arms fixed that, and it then failed again under
   *full-suite* load, where the machine is warmer and the noise floor is higher. The second
   fix is the correct one and is a statement about what the test means: "statistically
   indistinguishable" (§24.6) cannot be a fixed number, because two timings cannot be told
   apart below the noise of the measurement that produced them. The tolerance is now the
   declared one **or** the run's own measured within-arm spread, whichever is wider, and the
   floor is printed so a noise-dominated run is visible rather than silently passing on a
   widened bound. It does not mask a real failure: a locality violation is a systematic shift
   of one arm's centre, which separates the medians without widening either arm's spread.
   Recorded at length because a release gate that is re-run until it passes is not a gate, and
   the first fix looked sufficient for fourteen runs.

---

## 14. Known Limitations

1. **39 Safety-class parameters are not `DERIVED`, and the cutover is blocked.** §22.4 says of
   these values that "a significant number of them … require data the fleet does not yet
   produce and cannot produce before it operates", and the plan lists it as blocking pre-work
   B8 requiring ops, finance and safety sign-off. Inventing values to make the gate green
   would be precisely the failure §22.4 predicts. The gate is implemented, it blocks the thing
   it is a gate on, and `gate:calibration --all` prints the list with each parameter's owner
   and the data it awaits. **This is the single item that most blocks Phase 15's completion.**

2. **The singleton solve is quadratic in batch size, against a §20.1 target it cannot meet.**
   Measured: exponent ≈ 2.0 in Legs (r² > 0.99), ≈ 0.65 in candidates; 1 615 ms at 500 Legs ×
   10 candidates against a 250 ms target stated for 500 × 200. Cause: `minCostFlow.js` is
   successive shortest paths with Johnson potentials — one Dijkstra per augmentation, one
   augmentation per Leg — where §20.2's "typical" case assumes cost scaling. The code is
   correct, exact and integral (§9.3); it is slower than the complexity table's typical case.
   §9.4's anytime `solve.time_budget` and spatial partitioning bound the *damage* (the round
   returns an incumbent with its bound, never a hang) but do not close the gap. Replacing the
   solver is new capability and Phase 15 ships none, so this is reported as a blocking finding
   against `scale_targets` rather than fixed here. The measurement is asserted as a finding, so
   the day it is closed the test fails and the report must be updated with it.

3. **TLC has not been executed.** No Java toolchain. The equivalent checker drives the shipped
   `lifecycle/transitions.js` table rather than a transcription, which is a property TLC cannot
   have; but it is a bounded explicit-state search rather than a full temporal-logic check, so
   the two §24.2 *liveness* properties are checked in their reachability form (no reachable
   non-terminal state is a dead end) rather than under fairness. Closing this needs a JDK in
   the build image and nothing else.

4. **No standalone fleet simulator.** Checklist item 5 asks for one covering §18.2/§18.3
   injection and every §18.5 mode. The injection surfaces exist (`failure/agentFailures.js`,
   `infraFailures.js`, `degraded/modeRegister.js`) and are exercised by the chaos suite and by
   `degradedTransitions.test.js`, and `VirtualRobot`/`SimulationEngine` provide the agent
   substrate — but the demand generator with controllable burstiness and spatial correlation
   §24.4 describes is not built. `tools/simFidelity/validate.js` is the gate on such a
   simulator and is ready for it.

5. **Four gates require production operation and cannot be discharged here.** Shadow agreement
   over ≥ 2 weeks of live traffic, a soak over days, `invariants_enforced` with a
   zero-violation SLI, and the fidelity study against realised distributions. All four are
   `PRODUCTION` evidence in the gate table, all four block, and none is closable by a build —
   which is the correct behaviour, not a limitation of the implementation.

6. **Six workers are `DEFERRED`, each with its blocker named.** Two for a Tier 2 reason
   (`capacity_pricing`) or a pass-function shape (`charger_reachability`,
   `energy_calibration`, `service_time_model`), and two for a missing composition root:
   `shadow` needs a constructed solve path and `index_maintainer` needs the capability and
   charging classifiers. A stub in either place would produce a worker that runs, reports
   success, and computes nothing — the worst of the three possible states — so the gap is a
   row in a table rather than a silence. This is a partial delivery of the plan's "all engine
   workers move from shadow to production scheduling" and is stated as such.

---

## 15. Remaining Non-Blocking Issues

1. **`lifecycle/transitions.leaseExpiryTarget` reads `context.custodyState` while every guard
   reads `context.leg.custodyState`.** A caller passing only `{ leg }` gets `REASSIGNING` for a
   custodial Leg — the non-custodial answer — where §12.2 requires it to strand. The real
   caller (`reconciler.js`) supplies the field correctly, so there is no live defect; found by
   the model checker, which initially passed the guards' shape. Phase 5's module, not Phase
   15's to change.

2. **The §4.4 table has no row targeting `CANCELLED` or `WITHDRAWN`.** `CANCEL_REQUEST` targets
   `ABORTING` (§4.6 rule 2, working as specified) and `WITHDRAWN` has no incoming row at all —
   the table models a withdrawn offer as the Leg returning to `QUEUED`. Both readings are
   defensible against §4.4; resolving which is intended is an architecture question and the
   architecture is frozen. Recorded in `lifecycleModelCheck.test.js` so the gap is visible.

3. **`solve.time_budget` is not enforced inside `minCostFlow.solve`.** §9.4 requires the solver
   to be anytime. The budget is registered and the round consults it, but the inner loop has no
   deadline check, so a single oversized instance runs to completion. Interacts with finding 2
   and is the smaller half of it.

4. **Absolute §20.1 latencies are measured on the build machine.** Every measurement carries a
   `provenance` string saying so. Only finding 2 is large enough that hardware cannot explain
   it away.

---

## 16. Readiness for Independent Verification

Phase 15's **code** is complete and its build is green: six build gates, 135 suites, 6 008
tests. The cutover machinery, the verification suites, both new gates, the fidelity validator,
the safety-case assembler, the runbooks, the Frontend migration, and the removal of the legacy
decision path from the build are all delivered and tested.

Phase 15 is **not complete**, and cannot be from a repository. Two gates are red for stated
reasons (calibration, scale) and four require the fleet to have operated. The staged cutover
itself has not begun, because `stage.authoriseEnable()` refuses every shard while the
calibration gate is red — which is the machinery working as designed.

Suggested verification focus, in order:

1. **The calibration gate's classification.** Confirm it is absent from `npm run gates`,
   present in `release:gates`, and that `authoriseEnable` refuses while it is red. If the
   build/launch distinction is wrong, everything downstream of it is wrong.
2. **The one-directional rule.** Three enforcement points; confirm none can be routed around.
3. **`gate:legacy`'s two strip modes.** The import scan must keep string literals; using
   `codeOnly()` there made the gate pass while an import sat in plain sight, and it was found
   that way.
4. **The scale finding.** Re-run `npm run test:scale` and confirm the exponent and the §20.1
   gap independently. If it does not reproduce, the finding in §14 item 2 is wrong.
5. **The safety case's non-staleness.** Reclassify a predicate in a scratch copy and confirm
   the assembled document changes without anyone editing it.
6. **Phase 16 non-leakage.** `src/engine/fairness/` empty; no Tier 2 solve module; every kill
   switch thrown.

**Phase 16 must not begin.** Its sole prerequisite is Phase 15, and Phase 15's completion
criteria are not met: two §24 gates are red, four are unevaluated, no §26 invariant has been
observed `ENFORCED` in production, and no shard has been cut over.

---

*End of Phase 15 Implementation Report.*
