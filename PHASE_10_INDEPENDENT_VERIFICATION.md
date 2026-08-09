# Phase 10 — Independent Verification Report

**Role:** Independent Software Verification Engineer. Did not implement Phase 10.
**Scope:** `IMPLEMENTATION_EXECUTION_PLAN.md` Phase 10 ("Round loop and solve"), `NEXT_GENERATION_ASSIGNMENT_ENGINE.md`
§9 in full, cross-referenced against §1.4, §2.6, §3.1–§3.6, §20.5; cross-checked against
`PHASE_10_IMPLEMENTATION_REPORT.md` and against Phase 0–9's implementation and independent
verification reports for continuity.
**Date:** 2026-08-05 · **Branch:** `feature/dashboard` · **Baseline:** uncommitted working tree on
top of `cf9103f`, Phase 9 independently verified PASS WITH MINOR ISSUES ("Phase 10 may begin").
**Method:** Full re-read of §9 (all six subsections, verbatim) and §1.4, §2.6, §3.1–§3.6, §20.5;
full read of the Phase 10 execution-plan row (lines 1194–1215); line-by-line reading of every
Phase 10 source file, not sampled (`intake/intake.js`, `intake/admission.js`, `shard/planState.js`,
`solve/cadence.js`, `solve/regime.js`, `solve/budgets.js`, `solve/objective.js`,
`solve/minCostFlow.js`, `solve/round.js`, `workers/coordinator.worker.js`); independent
re-execution of all three build gates and all three Jest lanes; independent read of the migration
SQL and the `schema.prisma` diff; an **independent brute-force correctness check of the min-cost-flow
solver** (not part of the shipped test suite — written for this review) across 8,000 randomised
instances, including negative costs and multi-augmentation reassignment; grep-based verification of
every "not touched" / "no leakage" claim in the implementation report.

---

## 1. Phase 10 checklist completion

Independently re-verified against `IMPLEMENTATION_EXECUTION_PLAN.md`'s Phase 10 row (lines
1194–1215), item by item, by reading the actual code:

| # | Checklist item | Independent finding |
|---|---|---|
| 1 | Migration: `WorkQueue`, `Round` | **Confirmed.** Both tables present in `schema.prisma` and in `migration.sql`; the two are consistent with each other; `npx prisma validate` re-run independently and passes. |
| 2 | `intake/intake.js` — validate, admit, deduplicate, resolve shard, enqueue durably | **Confirmed**, read in full. `admit()` runs `validate()` → `admission.assess()` → `resolveShard()` → idempotent `enqueue()` → `queuePositionOf()` → `predictAssignmentWindow()`, in that order, matching §3.4's own ordering. |
| 3 | `POST /api/tasks/assign` returns task id, idempotency echo, queue position, honest predicted window | **Confirmed.** `tasks.controller.js` returns `{ ok, task, intake }` additively; `intake` carries all four §3.4 fields plus the `accepted`/`assigned` split. |
| 4 | **Remove the `setImmediate` detached assignment from `task.service.js`** | **Partial, and honestly disclosed as partial.** See §2 below — this is the one item this review spent the most time on. |
| 5 | `intake/admission.js` — purpose-keyed then class-keyed shedding; `custodial_purposes` never shed | **Confirmed, with one undisclosed extension** — see Finding 1 in the summary table. The core claim (custodial purposes never reach the shed ladder) is correct and structural, exactly as claimed. |
| 6 | `solve/cadence.js` — fast/nominal/loaded/saturated; early close on material supply change | **Confirmed.** All four regimes present; `boundBySlaBudget()` and `shouldCloseEarly()` both implement the two prose requirements §9.2's table does not carry. |
| 7 | Fast path **literally** the batch path at `|L| = 1`, enforced by a build-time test | **Confirmed and independently re-derived.** `assertFastPathIsBatchPath()` asserts a fast-path verdict differs from every other verdict in exactly the `windowMs`/`maxLegsThisRound` fields; `solveCadenceRegimeBudgets.test.js` additionally source-scans for `FAST_PATH` outside `cadence.js` and finds none. `solve/round.js` itself contains no regime branch — read in full, confirmed. |
| 8 | `shard/planState.js` — round-local SOFT reservations, in memory only | **Confirmed.** `makeReservation()`'s `toJSON()` throws `SoftReservationPersistenceError`; no store, no clock in the module; `reserve()` returns a `durableEffect` description for the caller to perform rather than performing any write itself. |
| 9 | `solve/objective.js` — coverage and exclusivity per §1.4 | **Confirmed.** `buildInstance()` implements exactly the two constraint families of §1.4's programme; exclusivity is `≤ 1` per agent (not per capacity slot), stated in three independent places (`objective.js`, `minCostFlow.js`, and asserted in both test files) — confirmed by direct read of all three. |
| 10 | `solve/minCostFlow.js` for the singleton regime | **Confirmed, and independently verified for correctness — see §3 below.** This is the item that received the deepest scrutiny in this review. |
| 11 | `solve/regime.js` — regime per round, recorded; never assert a guarantee out of regime | **Confirmed.** `CLAIMS_BY_REGIME[COLUMN]` is the empty array; `assertClaim()` throws for any of the four claims in the column regime; `dualsFor()` labels every dual vector with `EXACT_INTEGER_MARGINAL_PRICE` or `LP_RELAXATION_PRICE` rather than returning bare numbers. |
| 12 | `solve/budgets.js` — all five §9.4 bounds, anytime behaviour | **Confirmed.** All five bounds present (`BOUND` enum matches §9.4's table exactly); `emptyIncumbent()` plus monotone `offer()` gives the anytime property structurally rather than by convention; `replayOf` correctly separates the wall-clock bound (machine-dependent) from the other four (deterministically reproducible), which is the one place §9.4's anytime requirement and §9.6's replay requirement genuinely trade off. |
| 13 | Spatial partitioning that never severs a column | **Confirmed.** `round.partition()`'s union-find unions **every** Leg a column covers together with its agent, not just the `(Leg, agent)` pair — read in full at `round.js:158–224`; in the singleton regime this extra union is a no-op (confirmed by tracing: singleton columns have exactly one `legIds` entry, so the "remaining Legs" loop never executes), which is exactly the claimed harmlessness. |
| 14 | `workers/coordinator.worker.js` — the full round pipeline | **Confirmed**, read in full. Leadership → cadence → pin snapshot → claim → plan → commit → settle → record, in that order. |
| 15 | Wire commit (Phase 3), dispatch (Phase 4), supervision (Phase 5) into the round | **Confirmed.** `deps.commit` is injected into `round.execute()`, never imported by `solve/`; `tools/gates/checkTierDependencies.js` independently re-run and confirms zero Tier 0/1 → Tier 2 edges across 224 modules / 288 edges (matching the report's own numbers exactly, reproduced fresh in this review's own shell, not copied from the report). |
| 16 | Emit a Tier A decision record for every decision incl. deferral reason | **Confirmed**, with the Phase 10/11 boundary honestly stated. `recordRound()` writes one `DecisionRecordA` per Leg in `result.decisions`, covering every claimed Leg (confirmed via `round.assertEveryLegRecorded()`, which the coordinator's own settlement loop is consistent with); unpopulated §21.2 sections are `null`, not fabricated. |
| 17 | Tests: singleton reports zero LP–IP gap; multi-Leg round never reports exact-integer duals | **Confirmed** in `solveMinCostFlow.test.js` and `solveCadenceRegimeBudgets.test.js`'s "REGIME GUARANTEE TEST". |
| 18 | Test: replay reproduces the allocation and per-candidate costs byte-for-byte | **Confirmed, with the report's own scope caveat independently verified accurate** — see §13 item 2 of the implementation report, which this review agrees is honestly stated: the shipped test proves **run-to-run** determinism over identical inputs, not replay from a **stored** `Round` row, because the latter needs `InputSnapshot` and `tools/replay/replayDecision.js`, both named as Phase 11's. This is a real scope narrowing relative to §9.6's literal acceptance test, and it is disclosed rather than glossed. |
| 19 | Chaos: kill the coordinator with SOFT reservations outstanding | **Confirmed**, via the correct mechanism. See §13 below — a coordinator holds no durable trace of a SOFT reservation to "lose", so the shipped chaos coverage is (a) a round that throws mid-execution returns its whole claimed batch to `QUEUED` (`coordinatorRound.test.js`, "CHAOS" describe block, read in full), and (b) `resumeAfterFailover()` reconstructs from the durable `Leg.state = PLANNED` proxy that a SOFT reservation's one durable side effect leaves behind (§19.5 describe block, read in full, including the guard-G1 "left alone" case). Together these are the correct discharge of the checklist item given what is actually durable under §2.6; splitting the coverage into two describe blocks rather than one is not a gap. |
| 20 | **Gate:** no detached background assignment remains; every round produces a decision record | **Partial (item 4, disclosed) / Confirmed (second half).** |

All 20 items are either fully confirmed or confirmed with the same disclosed scope narrowing the
implementation report itself states. No item was found to be overstated.

---

## 2. The `setImmediate` disposition (§14 of the implementation report)

This is flagged by the implementation report itself as "the one deliberate deviation" and "the
single most important item for the reviewer," so it received first attention here.

**The conflict is real, not manufactured.** Independently re-read both plan lines:

- Phase 10's checklist (execution plan line 1199): "**Remove the `setImmediate` detached
  assignment from `task.service.js`**."
- Phase 15's row (execution plan line 1315): "Remove the legacy assignment path from
  `task.service.js`," with `ENGINE_ENABLED=true` staged **in that phase** (line 1313) and "every
  engine worker moves from shadow to production scheduling" also in that phase.

These cannot both be satisfied literally at Phase 10: `workers/coordinator.worker.js` is
confirmed **not called** from `server.js` or `src/app.js` (grep, zero matches, independently
re-run), consistent with every engine worker since Phase 4. Deleting the detach now would leave
the durable `WorkQueue` with nothing draining it, and — independently traced through
`task.service.js` — no task would be assigned by any path between this phase and Phase 15's
cutover. This is a genuine five-phase functional-outage risk, not a hypothetical one.

**The chosen resolution is sound and is the same discipline the codebase already uses.**
`legacyDetachedAssignment()` is a single, named, extracted function (`task.service.js:520–532`)
containing the one remaining `setImmediate` in the file (grep-confirmed: exactly one match in the
whole file, inside this function); it is reached only when `engineEnabled()` is false
(`task.service.js:588,610` — read in full, confirmed the engine branch is checked and returns
before the legacy branch is reached). With the engine on, `selectNearestRobot` (the legacy
selector) is asserted **never called** — confirmed directly in
`intakeStranglerSeam.test.js:157–160`, which mocks it to throw if reached, and the test passes.
This is the identical strangler-gate shape Phase 5 used for `socket.server.js`'s offline sweep,
which this review confirms by re-reading that phase's own file.

**Disclosure quality.** The file header states the conflict, quotes both plan lines, and states
the consequence in the same words a reviewer would use, independently re-read at
`task.service.js:1–71`. This is not a claim taken on trust from the implementation report; it was
re-derived from the source and from the execution plan's own text.

**This review's judgment: the strangler gate is the correct reading, not merely an acceptable
one.** The literal alternative — deleting the detach now — would satisfy one checklist line's
wording while violating the plan's own higher-order intent (a phased rollout with no functional
gap) and would make Phase 10 net-negative for production task assignment while `ENGINE_ENABLED`
remains false. The chosen disposition is the same one this review would have arrived at
independently, and the escalation-before-coding discipline (stated in §1 of the implementation
report) is exactly the process Phase 8's `p ≠ 1` ambiguity and Phase 9's citation questions used
successfully.

**Verdict on item 4/20: not a blocking gap.** It is the deliberate, disclosed, and correctly
reasoned deferral of one sub-clause to the phase that already owns its completion.

---

## 3. Independent correctness verification of `solve/minCostFlow.js`

The implementation report's own §16 explicitly asks a verifier to "independently re-derive"
three things about this module. All three were re-derived from the code, not from the report's
prose, and then checked against an independent brute-force implementation.

### 3.1 The lexicographic cost construction

Re-derived independently: `(unassigned, milliCU)` under componentwise addition and lexicographic
comparison is a totally ordered abelian group — addition is associative and commutative
componentwise, the identity is `(0,0)`, every element has an inverse under the group operation as
implemented (`addCost`/`subtractCost` on `BigInt` pairs, unbounded), and lexicographic comparison
is a total order compatible with the group operation (translation-invariant: if `a < b` then
`a+c < b+c` for any `c`, which holds because the first component dominates and addition is
componentwise). Successive shortest paths with Johnson potentials requires exactly this — an
ordered abelian group of arc costs — so the construction is valid. It is also a faithful
expression of §22.5 rule 1: with the `deferral` switch thrown, the `REMAIN_QUEUED` arc costs
`(1, 0)` and every other arc costs `(0, …)`, so no finite real-cost path can ever be lexicographically
cheaper than an assignment when one exists — confirmed directly in `solveMinCostFlow.test.js`'s
"an expensive assignment still beats leaving the Leg unassigned, at any price" test (9,000,000 CU),
and independently re-confirmed by this review's own brute-force harness (§3.3 below), which
reproduces the identical priority ordering on instances the shipped suite does not cover.

### 3.2 The exactness argument with negative `γ`

Re-derived independently: the network is `S(node 0) → Leg(1..n) → Agent(n+1..n+m) → T(n+m+1)`,
and every forward arc — `addArc()`'s first argument in each of the four construction loops in
`buildNetwork()` — goes from a strictly lower node index to a strictly higher one (`S→Leg`,
`Leg→Agent`, `Leg→T`, `Agent→T` are all index-ascending by construction). This makes the initial
network a DAG in node-index order, so `initialPotentials()`'s single forward relaxation pass in
node-index order is exact — including for negative `γ` — by the standard DAG shortest-path
argument (no back edges exist to invalidate a single forward pass, and there is no negative cycle
in a DAG). This was independently confirmed, not assumed from the module's own comment.

The post-augmentation potential update (`potential[node] += distance[node] === null ? sinkDistance
: distance[node]`, at `minCostFlow.js:464–467`) advances **unreached** nodes by the sink's own
distance rather than leaving them unchanged, which is a variant of the textbook Johnson-potential
update (Ahuja–Magnanti–Orlin's usual formulation leaves unreached potentials unchanged). This
review could not derive a short, general proof that this specific variant preserves non-negative
reduced costs on every residual arc for every network `buildNetwork()` can produce armchair-style
in the time available, and elected instead to check it the way the implementation report's own
§16 invites: empirically, against ground truth, under adversarial conditions (negative costs,
sparsity, multiple augmentations forcing reassignment through previously-unreached nodes).

### 3.3 Independent brute-force verification (this review's own artefact)

A standalone script (not part of the shipped suite) was written against the actual
`solve/objective.js` and `solve/minCostFlow.js` modules — not a reimplementation — generating
randomised instances of 1–6 Legs × 1–6 agents, densities from 40–100%, costs in `[-200, +200]` CU,
deferral randomly enabled/disabled, and comparing `minCostFlow.solve()`'s reported objective
against an exhaustive enumeration of every feasible assignment (including partial assignments and
the unassigned/deferred options), scored by the **same lexicographic objective** the module
implements (re-derived from §3.1, not copied from the module).

- **First run surfaced an apparent mismatch** that on inspection was not a defect: the brute
  force initially minimised raw milli-CU only, and the solver correctly preferred a
  positive-cost assignment over a zero-cost "remain queued" outcome, per §22.5 rule 1's priority
  — confirming §3.1's claim empirically rather than refuting the solver. The brute force was
  corrected to use the same two-component lexicographic objective, matching the module's own
  documented semantics.
- **8,000 trials total (4,000 at ≤5×5, 4,000 at ≤6×6), 0 mismatches** against brute-force optimal
  after the correction, including the unassigned-count component, the milli-CU component, feasibility
  (`objective.validate()`), and cross-consistency against `objective.objectiveValue()`.

This is strong, adversarial, independent evidence — not merely a re-run of the vendor's own
tests — that the solver is exact, including specifically the potential-update rule this review
could not fully hand-verify analytically. **Given the extent of this empirical confirmation, this
review is satisfied the exactness claim holds**, while noting for the record that a from-scratch
formal proof of the specific potential-update variant was not attempted and would strengthen the
claim further if the architecture's owner wants it before Phase 16 raises the stakes (branch-and-bound
in the column regime does not use this code path, so this is not urgent).

### 3.4 Exclusivity, feasibility branding, determinism

Independently confirmed by direct read: exclusivity arcs (`Agent → T`, capacity 1) enforce `≤ 1`
per agent regardless of `capacity[agent_class]`, matching §9.3; `objective.buildInstance()` and
`regime.determine()` both call `assertFeasible()` on every column's plan before doing anything
else (T1/I14); node ordering is canonical (Legs then agents, each sorted by id) and the heap
breaks ties on node index, so no comparison anywhere in the module depends on insertion or
iteration order (T6, §9.6 requirement 2) — confirmed by reading `compareByLegId`, `createHeap()`'s
`less()`, and the absence of any `Date.now()`/`Math.random()` token in the file (grep-confirmed).

---

## 4. Execution-plan compliance

**Files created** — all nine `solve/*.js` and `intake/*.js` modules, `shard/planState.js`,
`workers/coordinator.worker.js`, the migration, and the nine new `tests/engine/*.test.js` files
were independently located and read (all fully, none sampled below ~150 lines; the four largest —
`round.js`, `coordinator.worker.js`, `intake.js`, `minCostFlow.js` — read in full at their actual
622–676 lines each). All present, all match the report's stated purpose.

**Files modified** — `task.service.js`, `tasks.controller.js`, `socket.server.js`,
`commitmentSchema.test.js`, `costSchema.test.js`, `phase0Scaffold.test.js`, and
`supplementary.json` were each independently diffed against the report's claims:

- `task.service.js` — confirmed as described in §2 above.
- `tasks.controller.js` — confirmed additive; a decline surfaces as 400 (`INVALID`) or 429
  (quota/shed/queue-delay), read at `tasks.controller.js:58–80`. One cosmetic observation, not a
  defect: the success-path response nests `intake` twice — once inside `task` (because
  `task.service.js`'s `admitToRound` branch returns `Object.assign({}, pending, { intake:
  admitted })`) and once again at the top level (`res.json({ ok: true, task: created, intake })`).
  Harmless (identical data, not a correctness or security issue), but worth a one-line cleanup at
  Phase 15 when the legacy contract is retired anyway.
- `socket.server.js` — confirmed: `assign_task` is routed through the same `taskService.assignTask`
  router (one call site, not two), `task_accepted` is emitted beside the unchanged legacy
  `task_assigned`, matching the REST endpoint's own additive strategy applied consistently to the
  socket surface.
- `commitmentSchema.test.js` / `costSchema.test.js` — confirmed the Phase 11 boundary assertions
  (no `DecisionRecordB`/`InputSnapshot`/`CalibrationObservation`/`AuditEvent`, `WorkQueue`/`Round`
  present) and the new I18 schema assertion (no provisional-agent column/relation on either new
  table) — read in full, both pass under independent re-execution.
- `phase0Scaffold.test.js` — `PHASE_10_OWNED = ["intake/", "solve/", "shard/planState.js"]`
  confirmed added and folded into the cumulative `LANDED_PHASE_OWNED` walk alongside every prior
  phase's own array.
- `supplementary.json` — the claimed reformatting was independently checked: the 17 entries
  present in `HEAD` were diffed key-by-key against the current working-tree file and found
  identical in value, range, tier, and owner (only formatting/whitespace differs); the 33 entries
  from uncommitted Phases 6–9 are present and unchanged in substance. No parameter, value, or
  field was lost.

**No file outside the declared lists was touched** — independently confirmed via `git status`
(the file list in the environment's git status matches exactly the report's "Files Created" and
"Files Modified" sections, with no additional Backend source file appearing modified).

**Dependencies (Phases 2, 7, 8)** — `plan/columnBuilder.js` (Phase 8) is consumed via
`round.js`'s import and used as-is; `domain/mappers/legacyTask.taskToWork()` (Phase 2) is called,
not redefined, from `task.service.js`'s `admitToRound()`.

---

## 5. Architecture compliance

Independently re-read §9 in full (lines 2384–2596) and §1.4 (lines 179–258), term by term against
the code, in addition to the targeted deep-dive in §3 above.

- **§9.1/§9.2 cadence** — matches, confirmed in §1 item 6–7 above.
- **§9.3 formulation** — the set-partitioning instance (`objective.js`) and the singleton-regime
  flow (`minCostFlow.js`) both match §9.3's stated formulation exactly, confirmed by direct
  side-by-side comparison of the code against the architecture document's own displayed equations
  (§9.3's `minimise Σ γ(c)·z[c] + Σ C_defer[l]·y[l]` reproduced verbatim in `objective.js`'s header
  comment and matched against the actual constraint construction in `buildInstance()`).
- **§9.4 solve size control** — all five bounds present with the exact §9.4-specified remedy
  named per bound (`ON_EXCEED` table in `budgets.js`, matched word-for-word against §9.4's own
  "Behaviour on exceed" column).
- **§9.4 partitioning's second condition** — independently re-derived as correct in §1 item 13
  above; this is the one place an obvious implementation gets it wrong, and it is implemented
  correctly here, confirmed by reading the union-find logic rather than trusting the module's own
  comment.
- **§9.6 determinism** — all seven numbered requirements independently checked: (1) integer
  milli-CU throughout (`BigInt` used exclusively for costs, confirmed by grep for `costMilliCU`/
  `gammaMilliCU` type checks); (2) canonical ordering (confirmed in §3.4 above); (3) tie-break
  policy — **not fully wired in Phase 10.** §9.6 requirement 3 specifies "lower cumulative duty
  cycle, then higher health tier, then agent id" as the tie-break; `minCostFlow.js`'s own tie-break
  is agent-id-only (via node index, itself derived from sorted agent id), because duty-cycle and
  health-tier data are not threaded into the flow network at this phase. This is not flagged as a
  defect: the input columns arrive already in the canonical order `objective.js`'s
  `compareColumnsForSolve` establishes (price, then agent, then identity — not duty-cycle/health
  tier either), and neither Phase 8's `columnBuilder.js` nor Phase 10 claims to have wired §17.2's
  duty-cycle regularizer into candidate ordering yet. This is a pre-existing scope boundary carried
  forward from Phase 8/9, not something Phase 10 introduced or silently narrowed, and it does not
  affect the byte-for-byte-reproducibility property that is under test (which only requires *a*
  fixed canonical order, not specifically the duty-cycle-first one) — noted here for completeness,
  non-blocking; (4) `decision_time` is an input, confirmed via `decisionTimeMs` threading and the
  single `captureDecisionTime()` call sitting in the coordinator, outside `solve/`; (5) snapshot
  isolation — the `snapshot` object is pinned once per round and passed through, confirmed; (6)
  pinned versions — `Round.snapshotRefs`/`seed` recorded, though the full §21.2 version set is
  correctly deferred to Phase 11 as disclosed; (7) no unseeded randomness — `deriveSeed(roundId)`
  is deterministic from the round id, confirmed by reading `determinism/snapshot.js`.
- **§3.1 layering (L4→L3)** — confirmed: `solve/round.js`'s `plan()` performs no store access
  (grep for `prisma`/`kv` inside `solve/round.js` — zero matches, confirmed independently);
  `execute()` is the only function that crosses into L3, via the injected `deps.commit`.
- **§3.4 request/round path decoupling** — confirmed structurally distinct: `intake/intake.js`
  never imports `solve/` or `workers/coordinator.worker.js` (grep-confirmed), and the coordinator
  reads the queue the intake path wrote, with no shared process-local state between the two.
- **§2.6 SOFT-reservation durability rule** — confirmed structurally enforced (not merely
  documented) via `SoftReservationPersistenceError` on `toJSON()`, confirmed to actually throw by
  reading the property definition, and via the migration's absence of any provisional-agent column
  (§5 below).
- **§20.5 admission control** — confirmed with one disclosure gap; see Finding 1.

---

## 6. Module ownership and dependency direction

- `PHASE_10_OWNED` confirmed added and correctly folded into the cumulative ownership walk (§4
  above).
- Tier placement: `tools/gates/checkTierDependencies.js` independently re-run — **PASS, 224
  modules, 288 governed import edges, zero Tier 0/1 → Tier 2 edges** (identical to the report's
  own claimed figures, reproduced fresh). Confirmed by direct read of `tierAssertions.js` that
  none of Phase 10's ten new modules needed an explicit `MODULE_TIERS` entry: they fall to the
  existing `["src/engine/", TIER.OPERATIONAL_INTEGRITY]` / `["src/workers/",
  TIER.OPERATIONAL_INTEGRITY]` catch-all rows (`tierAssertions.js:563–564`), and the three
  Tier-2-named `solve/` modules this phase does **not** create (`batch.js`, `setPartitioning.js`,
  `localSearch.js`) are independently confirmed absent from the tree.
- `guards/tenets.js`'s `DECISION_PATH_SCOPE` independently confirmed to already list
  `src/engine/solve/` (line 134) ahead of this phase, consistent with Phase 0's anticipatory
  authoring pattern already noted by the Phase 9 review for `candidates/`.
- `Ω_terminal`/`C_defer` injection seams: independently confirmed by grep that no `solve/` module
  requires `cost/cDefer`, `cost/cChurn`, `pricing/`, or `plan/insertion` — the deferral price and
  the churn price both arrive as data on the Leg/column, exactly as claimed.

---

## 7. Runtime behaviour

`ENGINE_ENABLED` independently confirmed to gate the router in `task.service.js:588` and nowhere
else duplicates the check. `coordinator.worker.js`'s `start()` independently confirmed **not**
called from `server.js` or `src/app.js` (grep, zero matches in both, re-run fresh). The two load-
bearing orderings — leadership-before-planning and settle-after-commit — were independently traced
through `runRound()` and found correctly sequenced (§1 item 14 above).

One runtime-behaviour item independently confirmed **as a disclosed, non-blocking gap**: the
round's own early-close/window-elapsed logic (`cadence.shouldCloseEarly()`,
`cadence.windowElapsed()`) is implemented and unit-tested but is not called from anywhere in
`coordinator.worker.js` — confirmed by grep, zero call sites outside the test file. The
implementation report's own §13 item 5 discloses this accurately ("nothing schedules it yet...
belongs with Phase 15's production scheduling"); this review agrees with that disposition, since
wiring a wait-loop around an unscheduled worker would be dead code exercising nothing.

---

## 8. Database

`WorkQueue` and `Round` migration independently re-verified: `npx prisma validate` passes;
`npx prisma generate` was not re-run against a live DB (none available in this environment, matching
every phase since 6 — independently confirmed by absence of a reachable `DATABASE_URL` and by
`roundSchema.test.js`'s own `prisma migrate diff --from-empty` self-check, re-executed as part of
`npm test`, passing). The three hand-written CHECK constraints (`WorkQueue_state_known`,
`Round_regime_known`, `WorkQueue_deferral_counts_non_negative`) are present in `migration.sql` and
confirmed absent from Prisma's own generated-SQL diff by the same reasoning `roundSchema.test.js`
applies (re-run, passes) — proving they are genuine hand-written additions. Additive-only:
independently confirmed no `DROP`/`ALTER COLUMN` anywhere in the migration file. No SOFT-reservation
table and no provisional-agent column anywhere on `WorkQueue` — independently confirmed by reading
every column in both the migration and the schema model.

---

## 9. Redis

Both new keys (`engine:queue:{shard}`, `engine:round:{shard}:current`) independently confirmed
advisory: both writes in `coordinator.worker.js` are wrapped in `try { … } catch { /* Advisory */ }`
(`publishQueueMirror` and the liveness-key write in `runRound`), and the round itself never reads
either key back for correctness — confirmed by reading every `deps.kv` call site in the file (three
total: one write in `publishQueueMirror`, one write in `runRound`, zero reads). No new `kv`
capability was added — only the existing `kv.set` primitive is used, confirmed by grep.

---

## 10. Socket.IO

Confirmed in §4 above: additive, one call site, `task_assigned` unchanged for backward
compatibility, `task_accepted` new and carries the honest §3.4 fields.

---

## 11. APIs, concurrency, determinism

**APIs** — covered in §4/§1 above; no existing endpoint's behaviour, response shape, or route
changed; no new REST endpoint added, matching the plan's Phase 10 row (which specifies none).

**Concurrency** — `claimBatch()`'s conditional write on `(id, state, version)` and `settleBatch()`'s
conditional write on `(id, version)` were both independently re-read for the exact defect class the
implementation report says it self-caught (§11 of the report: a double-incremented version from
re-reading a mutated row after `updateMany`). The **fix** — capturing `observedVersion`/
`claimedVersion` before the write, at `claimBatch()`'s `coordinator.worker.js:173–174` — was
independently confirmed present and correct: the returned row uses `claimedVersion` (computed
before the database call), never a post-write re-read of `row.version`. This review independently
re-ran the full suite (§12 below) and confirms all coordinator tests pass, including the five
settlement tests the report says originally caught this bug.

**Determinism** — covered in depth in §3.4/§5 above. `solve/round.js` independently grep-checked
for `Date.now`/`Math.random`/`performance.now` — zero matches; the sole wall-clock read in the
whole Phase 10 surface is `determinism/snapshot.captureDecisionTime()`, called once, from the
coordinator, outside `solve/`.

---

## 12. Regression safety / build gates / test suite

**Independently re-executed, not trusted from the report:**

```
npx prisma validate                        → valid

npm run gate:tiers   → PASS — 224 modules, 288 edges, 0 violations   (report claims: identical)
npm run gate:params  → PASS — 143 modules, 188 params, 0 bare consts (report claims: identical)
npm run gate:tenets  → PASS — 221 modules, 0 violations              (report claims: identical)

npm test (all lanes) → 87 suites / 4,917 tests, 0 failures           (report claims: identical)
```

Every number in the report's §11 was independently reproduced exactly in this review's own shell.
No discrepancy found between claimed and actual test/gate results anywhere. The legacy lane
(169 tests, embedded in the 4,917 total) is unchanged from Phase 9's own independently-verified
baseline, confirming zero behavioural regression in the still-live legacy dispatcher.

**This review's own additional artefact** — the 8,000-trial brute-force correctness check of
`minCostFlow.js` (§3.3) — is not part of the shipped suite and was written specifically for this
verification; it is not reflected in the counts above.

---

## 13. Failure handling / chaos

Covered in §1 item 19 above. Independently read both relevant describe blocks in
`coordinatorRound.test.js` in full (`CHAOS` at lines 289–316, `§19.5 — failover` at lines 318–360)
and confirm they correctly discharge the checklist's chaos requirement given what is actually
durable under §2.6: a SOFT reservation itself cannot be "found" after a coordinator death because
none is ever written anywhere (by design), so the only faithful chaos test is over the durable
proxy the architecture specifies — `Leg.state = PLANNED` — which is exactly what
`resumeAfterFailover()` and its tests exercise, including the guard-G1 "a Leg PLANNED with a live
commitment is left alone" case that prevents double-commitment.

---

## 14. Confirm nothing from Phase 11 implemented

**Confirmed independently**, not merely re-stated from the report:

- `src/engine/observability/`, `degraded/`, `failure/`, `map/`, `fairness/` each contain only a
  `.gitkeep` — independently listed, confirmed empty.
- No `DecisionRecordB`, `InputSnapshot`, `CalibrationObservation`, or `AuditEvent` model anywhere
  in `schema.prisma` — independently grepped, zero matches.
- No `solve/batch.js`, `solve/setPartitioning.js`, or `solve/localSearch.js` — independently
  confirmed absent (Phase 16's Tier 2 mechanisms).
- No Explanation API route (`GET /api/explain/:decisionId`) — independently grepped across
  `src/routes/` and every controller, zero matches; the only new/changed reachable endpoint is the
  additive `POST /api/tasks/assign` response shape.
- Tier A decision records write only the fields Phase 10 owns and leave every Phase-11-owned
  section (`versions` beyond the basics, calibration, sampling) `null` rather than fabricated —
  independently confirmed by reading `recordRound()`'s `decisionRecordA.create()` call in full.

---

## Summary of findings

| # | Severity | Category | Affected files | Recommendation |
|---|---|---|---|---|
| 1 | Minor | Architecture-compliance / disclosure | `Backend/src/engine/intake/admission.js` (`assess()`, line 347) | `assess()` exempts custodial-purpose Legs (`RECOVERY`, `TRANSFER`) from the queue-delay decline (`checkQueueDelay`) in addition to the shed ladder. §20.5's literal text ties "custodial_purposes are never shed" specifically to the class-based-shedding row; the queue-delay row names no purpose exemption. On inspection this review judges the extension **correct in spirit** — a queue-delay decline and a shed are both "not admitted, caller told," and admitting the shed exemption without the queue-delay one would let queue-delay quietly re-introduce exactly the stranding outcome §20.5 says custodial work must never suffer — but it is a real extension of the specification's literal scope, and unlike `resolveShard`, the lexicographic cost construction, and four other interpretive calls this phase discloses individually in §10 of the implementation report, this one is not named as an interpretive call anywhere in the report. Recommend adding one sentence to the report (or a code comment cross-reference, which already exists at the call site) is not itself required to be re-verified — the fix is documentation-only, zero behavioural change. Does not block Phase 11. |
| 2 | Minor / informational | Determinism scope (§9.6 requirement 3) | `Backend/src/engine/solve/minCostFlow.js`, `Backend/src/engine/solve/objective.js` | The tie-break policy actually in force (agent id only, via canonical column order) does not yet implement §9.6 requirement 3's full "duty cycle, then health tier, then agent id" — it implements a subset. This is a pre-existing boundary inherited from Phase 8's `columnBuilder.js` canonical order, not something Phase 10 narrows or hides, and it does not compromise the byte-for-byte reproducibility property under test. No correction required of Phase 10; worth a one-line note in whichever phase (11 or 16) first wires duty-cycle/health-tier data into candidate/column ordering, so the gap is closed rather than rediscovered. |
| 3 | Cosmetic | Response-shape hygiene | `Backend/src/services/task.service.js` (`admitToRound` return path), `Backend/src/controllers/tasks.controller.js:79` | The successful `POST /api/tasks/assign` response nests the `intake` object twice (once inside `task`, once at the top level) — identical data, zero correctness or security impact. Worth a one-line cleanup opportunistically at Phase 15 when the legacy response contract is retired; not worth a dedicated fix now. |

No blocking issue was found. Every claim in `PHASE_10_IMPLEMENTATION_REPORT.md` that was checked
(all twenty checklist items, all eleven numbered sections, and the six items the report's own §16
asked a verifier to prioritise) was independently confirmed accurate, including the report's own
self-disclosed limitations (§13 items 1–7), which this review found honestly stated and, where
checked against the code directly, correctly scoped rather than minimised. The one item this
review scrutinised beyond the report's own suggested focus — the Johnson-potential update rule for
unreached nodes in `minCostFlow.js` — could not be fully hand-verified analytically in the time
available, but survived 8,000 adversarial randomised trials against an independent brute-force
oracle with zero mismatches, which this review considers strong evidence of correctness for a
Tier 1, safety-relevant solver.

---

## Final decision

# PASS WITH MINOR ISSUES

Three issues listed above (one architecture-compliance/disclosure, one determinism-scope
informational note, one cosmetic). None is behavioural, none is blocking, and none touches
anything Phase 11 depends on — Phase 11 consumes the Tier A decision record's populated fields and
the `replayOf` seam in `budgets.js`, not `admission.js`'s queue-delay exemption or the tie-break
policy's current scope.

**Phase 11 may begin.** Confirmed independently that nothing from Phase 11's own scope
(`observability/`, `degraded/`, `failure/`, `map/`, `fairness/`, the four Phase-11-owned tables,
the Explanation API, sampling, calibration, shadow mode) has been implemented ahead of schedule.

---

*End of Phase 10 Independent Verification Report.*
