# Phase 9 — Implementation Report

**Role:** Senior Distributed Systems Engineer implementing the frozen architecture
**Scope:** `IMPLEMENTATION_EXECUTION_PLAN.md` §3 "PHASE 9 — Candidate generation and the admissible bound",
implementing `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` §6 in full
**Date:** 2026-08-05 · **Branch:** `feature/dashboard` · **Baseline:** Phase 8, independently verified
("PASS WITH MINOR ISSUES" — `PHASE_8_INDEPENDENT_VERIFICATION.md` — "**Phase 9 may begin**"), uncommitted
on top of `cf9103f`
**Phase 10 or later:** not implemented. `src/engine/solve/` and `src/engine/intake/` remain empty.

---

## 1. Executive Summary

Phase 9 delivers §6 of the frozen architecture: the Availability Index, the seven-tier
hierarchical expansion (§6.3), the admissible lower bound `LB(a, l)` with its `Ω_terminal`/
`Ω_policy` corrections (§6.4), canonical candidate ordering (§6.6), per-cell-cluster candidate
sharing (§6.5), and the admissibility build gate (§24.1). Blocking decision B5 (spatial index
primitive) is resolved in favour of H3, per the plan's own guidance ("H3 preferred outdoors for
uniform k-ring metrics").

Nine new engine modules, one new Prisma model (`AgentCellPosition`) with a hand-written migration
cross-checked against Prisma's own generated SQL, one new background worker (unscheduled, per the
established convention), one new read-only diagnostics endpoint, and nine new test files (2,682
tests) were added. Two existing files were extended: `src/engine/spatial/cells.js` (the H3
wrapper, additive) and `src/controllers/diagnostics.controller.js`/`diagnostics.routes.js`
(the new endpoint). Two test files whose "no Phase 9+" boundary assertions existed specifically to
catch this phase's work landing early (`commitmentSchema.test.js`, `costSchema.test.js`,
`phase0Scaffold.test.js`) were updated to move that boundary to Phase 10, exactly as their own
comments anticipated.

`npm run verify` (all three build gates, then all three Jest lanes) is green: **78 suites, 4,705
tests, 0 failures.** The legacy lane is unchanged at 169/169 (Phase 8's own baseline), confirming
zero behavioural regression in the path Phase 15's cutover has not yet reached.

One genuine implementation bug was found and fixed during self-verification (§12.2): a tier-gating
condition in `expansion.js` that would have silently skipped tier 1 (the origin cell — "the
overwhelmingly common answer", §6.3) whenever `candidate.max_expansion_tiers` was configured to
exactly `1`. It was caught by this phase's own tests, not by inspection, which is recorded here as
the argument for the test suite's coverage rather than glossed over.

---

## 2. Objectives Achieved

Cross-referencing `IMPLEMENTATION_EXECUTION_PLAN.md`'s Phase 9 checklist (§7) item by item:

| # | Checklist item | Status |
|---|---|---|
| 1 | `spatial/cells.js` (H3/S2 per B5) and `candidates/availabilityIndex.js` | **Done** — H3 chosen; `H3_RESOLUTION.FINE = 8` (~531 m avg edge), `COARSE = 5` (~9.85 km avg edge) |
| 2 | Four availability classes incl. `FINISHING_SOON`, `QUEUE_CAPACITY_AVAILABLE` | **Done** — `availabilityIndex.AVAILABILITY_CLASS`, priority-ordered `classify()` |
| 3 | Secondary indices on capability class and container class | **Done** — `capabilityKey()`/`containerKey()`, intersected in `membersOf()` |
| 4 | `candidates/expansion.js` — tiers 0–6, driven by the pruning rule | **Done** — see §6 below for the one bug found and fixed |
| 5 | `candidates/omega.js` — `Ω_terminal` from the round's price snapshot; `Ω_policy` from config publish | **Done**, with a tier-boundary design decision recorded in §10 |
| 6 | `candidates/lowerBound.js` — four non-negative components minus `Ω_terminal`/`Ω_policy` | **Done** |
| 7 | The pruning rule with an additive CU tolerance | **Done** — `candidate.optimality_tolerance_cu`, milli-CU throughout |
| 8 | Record the achieved bound in CU on every budget-truncated search | **Done** — `achievedGapMilliCU`, clamped at zero by construction |
| 9 | `candidates/ordering.js` (canonical) and `clusterShare.js` (per cell cluster) | **Done** |
| 10 | Index rebuild from the observation log (Cold Index path) | **Done**, with a scope decision recorded in §13 (rebuilds from the durable `AgentCellPosition` mirror, not by re-deriving from raw `Observation` rows each time) |
| 11 | REST: `GET /api/diagnostics/candidates/:legId` | **Done**, with an honest scope limitation recorded in §7 and §13 |
| 12 | Build gate: exhaustive `LB ≤ γ` check over the configured parameter space | **Done** — `tests/engine/candidateAdmissibility.test.js`, 2,566 combinations, all passing, including the exact tight-boundary case |
| 13 | Re-run the admissibility check at every config publish | **Already satisfied** — see §10; Phase 1's A1 and V2 validators already cover the register-level prerequisites this bound depends on |
| 14 | Tests: determinism across runs/processes; index cost independent of fleet size | **Done** — determinism via the shared `determinism/ordering.js`/`fixedPoint.js` primitives (no new comparator invented); index cost independence follows from the cell-partitioned key scheme (§20's T9) — not independently load-tested (see §13) |
| 15 | Gate: admissibility is a build gate, not a sampled property; I20 search-gap half verifiable | **Done** |

---

## 3. Files Created

**Engine modules (`Backend/src/engine/`):**

| File | Purpose |
|---|---|
| `candidates/availabilityIndex.js` | §6.2 — four-class index, secondary indices, Redis key scheme, Cold Index rebuild |
| `candidates/expansion.js` | §6.3/§6.4 — hierarchical tiers 0–6, the pruning rule, achieved-gap recording |
| `candidates/lowerBound.js` | §6.4 — `LB(a, l)`, the four-term admissible bound |
| `candidates/omega.js` | §6.4 — `Ω_policy` (resolved) and `Ω_terminal` (consumed via injection) |
| `candidates/ordering.js` | §6.6 — cell-visiting order, agent-within-cell order, the canonical candidate list |
| `candidates/clusterShare.js` | §6.5 — Leg clustering by coarse cell; a memoising `kv` wrapper for shared reads |
| `candidates/admissibilityGate.js` | §24.1 — the register-level admissibility prerequisites, reused by tests |

**Spatial (extended, not replacing Phase 2's file):** `spatial/cells.js` gained the H3 wrapper —
`cellForPoint`, `centreOfCell`, `resolutionOfH3Cell`, `coarseParentOf`, `fineChildrenOf`,
`diskAround`, `ringAt`, `gridDistanceBetween`, `greatCircleMetres`, `edgeLengthMetres` — beside
its existing opaque-token functions, exactly as that file's own Phase 2 docstring anticipated
("Phase 9 adds the primitive wrapper... beside this, not instead of it").

**Worker:** `Backend/src/workers/indexMaintainer.worker.js` — the periodic sweep that assembles
each agent's current index placement from `Agent`/`Commitment`/`Observation` and applies it via
`availabilityIndex.applyPosition()`; plus `rebuildIndexFromMirror()` for the Cold Index path.
Unscheduled, per the convention every worker since Phase 4 has followed while `ENGINE_ENABLED` is
false.

**Controller/route:** `getLegCandidates` in `src/controllers/diagnostics.controller.js`, wired at
`GET /api/diagnostics/candidates/:legId` in `src/routes/diagnostics.routes.js`.

**Migration:** `prisma/migrations/20260805100000_candidate_generation_and_availability_index/migration.sql`.

**Tests (`Backend/tests/engine/`):** `candidateAdmissibility.test.js`, `candidatesSchema.test.js`,
`candidatesSpatialH3.test.js`, `candidatesOmega.test.js`, `candidatesLowerBound.test.js`,
`candidatesOrdering.test.js`, `candidatesAvailabilityIndex.test.js`, `candidatesExpansion.test.js`,
`candidatesClusterShare.test.js`, plus `tests/engine/helpers/candidateFixture.js`.

## 4. Files Modified

| File | Change |
|---|---|
| `Backend/package.json`, `package-lock.json` | Added `h3-js` (B5) |
| `Backend/prisma/schema.prisma` | New `AgentCellPosition` model; new `Agent.cellPosition` back-relation |
| `Backend/src/engine/spatial/cells.js` | H3 wrapper added beside the existing opaque-token functions (additive) |
| `Backend/src/controllers/diagnostics.controller.js` | New `getLegCandidates` handler and its two helpers (`readDelayParameters`, `fleetBestCaseFrom`) |
| `Backend/src/routes/diagnostics.routes.js` | New `GET /candidates/:legId` route with its own rate limiter |
| `Backend/tests/engine/commitmentSchema.test.js` | Boundary moved: "no Phase 9+ table" → "no Phase 10+ table"; `AgentCellPosition` removed from the forbidden list and given its own presence assertion |
| `Backend/tests/engine/costSchema.test.js` | Same boundary move; "no Phase 9 candidate-generation module exists" removed (superseded by `candidatesSchema.test.js`'s presence assertions) |
| `Backend/tests/engine/phase0Scaffold.test.js` | `PHASE_9_OWNED = ["candidates/"]` added to the engine-tree ownership walk |

No file outside this list and the "Files Created" list was touched. In particular,
`src/engine/guards/tenets.js`, `src/engine/guards/tierAssertions.js`, `src/engine/TIERS.md`, and
`src/engine/config/validators.js` were **not** modified — see §10 for why each was unnecessary.

---

## 5. Database Changes

One new table, additive only:

**`AgentCellPosition`** — one row per agent, the durable mirror `availabilityIndex.rebuildFromRecords()`
reads to reconstruct Redis on Cold Index (§18.5, B3). Columns: `agentId` (unique FK → `Agent.id`,
`onDelete: Cascade`), `shardId` (plain string, following the `DecisionRecordA`/`RejectionAggregate`
precedent ahead of Phase 13's `Shard` table), `lat`/`lon`, `fineCellId`/`coarseCellId`,
`availabilityClass`, `capabilityClasses`/`containerClasses` (`TEXT[]`), `observedAtMs`, `updatedAt`.
Indexes: `(shardId, fineCellId, availabilityClass)`, `(shardId, coarseCellId, availabilityClass)`,
`(availabilityClass)`. Two hand-written CHECK constraints (Prisma cannot express either):
`availabilityClass IN (...)` (the four classes) and a WGS84 coordinate-range check.

The migration's `CREATE TABLE`/`CREATE INDEX`/`ADD CONSTRAINT` (foreign key) statements were taken
verbatim from `prisma migrate diff --from-empty --to-schema-datamodel` — confirmed byte-for-byte
identical (modulo whitespace) by `candidatesSchema.test.js`. Only the two CHECK constraints are
hand-written, and the same test confirms they are *absent* from Prisma's generated output (proving
they are genuine hand-written additions, not an echo).

**Not applied to a live database.** No reachable Postgres was used for this work — consistent with
every phase since Phase 6's report first recorded the same limitation. `npx prisma validate` and
`npx prisma generate` both succeed against the updated schema. A local Postgres instance was found
listening on `localhost:5432` during this work (matching `.env`'s `DATABASE_URL_LOCAL`) and a
remote Neon instance is configured in `DATABASE_URL`; neither was touched, deliberately — running
`prisma migrate dev` against either without being certain of its contents and without being asked
to is exactly the kind of hard-to-reverse action this project's operating guidelines call for
holding back on. `prisma migrate diff --from-empty` requires no live connection and was used
instead to obtain the authoritative generated SQL.

---

## 6. Runtime Behaviour

`ENGINE_ENABLED` remains `false`; nothing in this phase runs on any request path yet.
`indexMaintainer.worker.js` is not started from `server.js` (confirmed by grep and by
`candidatesSchema.test.js` — no, that assertion lives in the module-presence tests, not a
"not started" test; the absence was verified directly: `server.js`/`src/app.js` contain no
reference to `indexMaintainer`).

The one genuinely new runtime surface reachable today is the diagnostics endpoint (§7), which is
read-only, rate-limited, and behind the existing `authUser` middleware every other `/api/diagnostics`
route uses.

`candidates/expansion.js` never reads a wall clock or random source directly — confirmed
mechanically by `guards/tenets.js`'s T6 scan (0 violations across the whole tree, including
`candidates/`, which `tenets.js` already listed in `DECISION_PATH_SCOPE` before this phase began).
Wall-clock budget enforcement is via an injected `elapsedMs()` function reference the caller
(outside the decision path) supplies; `expansion.js`'s own source contains no `Date.now()` /
`performance.now()` / `Math.random()` token for the scanner to find.

---

## 7. API Changes

**New:** `GET /api/diagnostics/candidates/:legId` — cells explored, the admissible-lower-bound-ranked
candidate list, the smallest unexplored ring's geometric floor, and an achieved-gap figure, exactly
as §6.1's REST-API-changes row names ("cells explored, smallest unexplored bound, achieved gap in CU").

**Honest scope limitation, stated in the response itself (`basis` field), not silently
approximated:** this endpoint ranks candidates by `LB(a, l)`, not by an exact price `γ`. Phase 9
does not assemble the Plan Builder → `Φ` → `γ` pipeline standalone — that wiring is explicitly
Phase 10's ("the coordinator loop that ties candidate generation, feasibility, pricing, solving,
and commitment into one supervised round", per Phase 10's own purpose statement in the execution
plan). So `achievedGapCu` here is the gap between the best `LB` found and the next unexplored
ring's floor — a weaker, honestly-labelled cousin of §6.4's `C* − min LB`, which needs a real `C*`
(an exact `γ`) this endpoint does not produce. Every prior diagnostics endpoint
(`/rejections`, `/energy/:agentId`) reports **live, currently-complete** subsystem state; this one
is the first whose full accuracy depends on a phase that has not landed yet, and the response says
so rather than presenting an approximation as the real thing.

No existing endpoint's behaviour, response shape, or route changed.

---

## 8. Redis Changes

New key prefixes, all advisory (§3.3 — the cache tier carries no correctness-critical sole copy;
loss narrows candidate search, never breaks correctness, because feasibility is re-verified at
commit, I16):

- `engine:idx:{shard}:{fineCell}:{availabilityClass}` — SET of agent ids, the fine-cell/class partition
- `engine:idx:{shard}:{coarseCell}:{availabilityClass}` — SET of agent ids, the tier-4 regional sweep
- `engine:idx:cap:{shard}:{capabilityClass}` — SET of agent ids, the capability secondary index
- `engine:idx:container:{shard}:{containerClass}` — SET of agent ids, the container secondary index

All four use the existing `kv.sadd`/`kv.srem`/`kv.smembers` primitives (no new `kv` capability was
added). `applyPosition()` diffs a previous and next position record and issues `SADD`/`SREM` only
for the keys that actually changed. Every read degrades to an empty result on a `kv` failure rather
than throwing (verified in `candidatesAvailabilityIndex.test.js`), matching the fail-open discipline
`feasibility/cache.js` already established for advisory reads. No existing Redis key or its
semantics changed.

---

## 9. Socket.IO Changes

None. §6 specifies none, and none was added.

---

## 10. Architecture Compliance

**B5 (spatial index primitive) resolved: H3.** `h3-js@4.5.0` added as a dependency; the wrapper is
confined to `spatial/cells.js`, which remains the single module in the tree that imports `h3-js`
directly (a stated, not yet machine-checked, convention — see §13).

**Tier placement.** §1.8 names candidate generation in none of its three tier lists (Tier 0's
eleven-item bullet list, Tier 1's seven, Tier 2's twelve) — confirmed by re-reading §1.8 directly
rather than assuming. Per `TIERS.md`'s own stated Convention 1 ("modules not named by §1.8 default
to Tier 1... conservative: it can only over-constrain the rule-2 gate, never relax it"), every
`candidates/` module lands at Tier 1 (`OPERATIONAL_INTEGRITY`) via the existing `src/engine/`
catch-all in `MODULE_TIERS` — no new row was needed, and none was added. `tests/engine/
candidatesSchema.test.js` asserts this directly against `tierOf()` for all seven new modules, and
asserts (by source-grep) that `omega.js` contains no `require()` of `pricing/`.

**The one non-trivial tier-boundary decision: `Ω_terminal`.** `pricing/vTerminal.js`'s
`omegaTerminal()` already implements exactly §6.4's formula, and its own docstring states the seam
explicitly: *"Phase 9's `candidates/omega.js` consumes what this produces; it does not recompute
it."* But `pricing/` is classified Tier 2 (`TIERS.md`'s T2-06, the opportunity-cost/terminal-value
model), and `omega.js` is Tier 1 — a static `require("../pricing/vTerminal")` from `omega.js` would
be exactly the shape §1.8 rule 2 forbids, the same shape `TIERS.md`'s own "compliant pattern for an
optional Tier 2 enhancement" section rejects for `cost/phi.js`/`cost/cOpportunity.js`
(`phi.registerTerm(cOpportunity)` at composition time, never a static import). So
`omega.omegaTerminalMilliCU()` takes the already-computed CU figure as a plain data argument; the
composition root (Phase 10's coordinator) is where `pricing/vTerminal.omegaTerminal()` is actually
called and its result handed across the tier boundary. When `opportunity_cost_term` is thrown
(the §1.8 rule 3 baseline — every switch thrown), `omega.js` returns exactly `0n` rather than
requiring a figure for a term that contributes nothing to `Φ` this round. Verified in
`tests/engine/candidatesOmega.test.js` and exercised across both states in the admissibility sweep.
`tools/gates/checkTierDependencies.js` confirms mechanically: 214 modules, 261 governed import
edges, zero Tier 0/1 → Tier 2 edges.

**"Re-run at every config publish" (§24.1) — already satisfied, not newly wired.** The two
register-level prerequisites `LB(a, l)`'s admissibility depends on — `cost.lambda_time_floor ≤
cost.lambda_time[class]` and every `C_policy` adjustment declaring a ceiling summing exactly to
`Ω_policy` — turned out to already exist as `config/validators.js`'s **A1** and **V2** checks,
already wired into `validatePublish()`, evidently anticipated by Phase 1 (their docstrings cite
§6.4 by name). `candidates/admissibilityGate.js` composes and re-exposes them
(`checkRegisterPrerequisites()`) for Phase 9's own tests to depend on directly rather than
re-deriving the same logic a second time; no change to `config/validators.js` was needed or made.
The one prerequisite genuinely new to Phase 9 — `Ω_terminal` is never negative — is a round-time
check (there is no live price snapshot at config-publish time to check it against), so it lives in
`omega.js`'s own input validation (already present) and is re-asserted by
`admissibilityGate.checkOmegaNonNegative()` for the test suite, not wired into `validatePublish()`.

**The admissibility argument, and where each of its six claims is discharged:**

| Claim (§6.4) | Where it is proven |
|---|---|
| Great-circle ≤ any real route | `spatial/cells.greatCircleMetres()` — geometric identity |
| `λ_min ≤ real λ_time` | Register invariant A1 (Phase 1, unmodified) |
| `E_min ≤ real E_leg` (mod. one recorded caveat) | Structural — §14.2's other addends are ≥ 0; see §13 for the regeneration caveat |
| `C_delay` non-decreasing in completion time | `cost/cDelay.js`'s own formula (Phase 8, unmodified); directly property-tested in `candidateAdmissibility.test.js` |
| `C_risk + C_lifecycle + C_churn ≥ 0` | §6.4's own table; omitted from `LB` entirely, which is always safe for a non-negative omission |
| `−Ω_policy ≤ C_policy`, `−Ω_terminal ≤ C_opportunity` | V2 (Phase 1) and `pricing/vTerminal.js` (Phase 8) respectively, both unmodified |

`candidateAdmissibility.test.js` does not re-verify each claim in isolation only — it also builds an
independent reference `γ` from real (non-underestimated) values across 2,566 swept scenarios and
asserts `LB ≤ γ_reference` holds for the *composition*, including the exact all-zero-slack boundary
where the two are equal (mod milli-CU rounding). This is the concrete instantiation of §24.1's
"exhaustive... over the configured parameter space" for the terms this phase owns.

---

## 11. Test Results

`npm run verify` (all three build gates, then all three Jest lanes):

```
gate: tier-dependencies (§1.8 rule 2)         PASS — 214 modules, 261 edges, 0 violations
gate: parameter-register (§22, Appendix A)     PASS — 134 modules, 186 registered params, 0 bare constants
gate: tenets (T1 type separation, T6)          PASS — 211 modules, 0 violations

Test Suites: 78 passed, 78 total
Tests:       4705 passed, 4705 total
```

Broken down by lane:

- **engine** (`npm run test:engine`): 53 suites total (44 pre-existing, unchanged, + **9 new**),
  **4,487 tests**. Phase 9's own 9 files contribute **2,682** of those
  (dominated by the 2,566-scenario admissibility sweep in `candidateAdmissibility.test.js`).
- **legacy** (`npm run test:legacy`): **169/169**, unchanged from Phase 8's own reported baseline —
  zero behavioural regression in the legacy dispatcher.
- **gates** (`npm run test:gates`): **49/49**, unchanged.

One real bug was caught by this suite, not by review, and is recorded rather than smoothed over:
`candidatesExpansion.test.js`'s "truncates at `candidate.max_evaluated`" and "canonical order"
tests both initially failed with zero agents evaluated. The cause: `expansion.js`'s ring-expansion
loop gated *both* tier 1 (the origin cell, ring 0) and tier 2 (the k-ring proper, ring ≥ 1) behind
a single `maxTiers >= TIER.KRING` (i.e. `≥ 2`) condition, so `maxExpansionTiers: 1` — a
configuration meaning "search up to and including tier 1" — silently searched nothing at all. Fixed
by gating ring 0 behind `maxTiers >= TIER.ORIGIN_CELL` (`≥ 1`) and adding a separate check inside
the loop body (`if (ring >= 1 && maxTiers < TIER.KRING) break;`) so ring ≥ 1 still requires tier 2.
Re-verified: all 94 `candidates*.test.js` tests pass after the fix, and the fix is covered by the
tests that caught it.

---

## 12. Self-Verification

- [x] Every Phase 9 checklist item implemented (§2 above; item 14's load-independence claim is
      structural, not load-tested — see §13).
- [x] No Phase 10 functionality present — `src/engine/solve/` and `src/engine/intake/` remain empty
      (unchanged from Phase 8; not touched this phase). `candidates/expansion.js` explicitly takes
      `evaluateExact` as an injected dependency rather than assembling the feasibility→plan→cost
      pipeline itself, which is the structural form of not pre-empting Phase 10.
- [x] Architecture unchanged — no `.md` specification file was edited; §6 implemented as written,
      with one recorded ambiguity (E_min vs. regeneration, §13) disclosed rather than silently
      resolved.
- [x] Tests pass — 4,705/4,705 across all three lanes (§11).
- [x] Build passes — `npx prisma validate`, `npx prisma generate`, and all three build gates green.
- [x] APIs remain compatible — one new endpoint added; nothing existing changed.

---

## 13. Known Limitations

1. **`E_min`'s regeneration caveat, disclosed rather than resolved.** §6.4 states `E_min` "uses the
   best-case consumption coefficient over the straight-line distance" as its own justification for
   why the term is a safe underestimate, without qualifying that reasoning against §14.2's
   regenerative term (which is *subtracted* inside the energy model's bracket before it is floored
   at zero). A sufficiently steep, net-descending real route can in principle realise a true
   `E_leg` below `β_dist · distance`, which this distance-only estimate does not see — because the
   climb/descent profile it would need comes from routing, which §6.4 explicitly puts out of scope
   for this bound ("computable without routing"). §6.4's own text names exactly the formula this
   module implements as the intended underestimate; this is recorded as a specification-level
   escalation (in the same spirit as Phase 8's A2 disposition — implement literally, disclose the
   consequence, do not silently strengthen or weaken what is written) rather than treated as a
   Phase 9 defect to fix unilaterally.

2. **The diagnostics endpoint ranks by `LB`, not by exact `γ`**, and says so in its own response
   (§7). This is a structural consequence of Phase 9 not owning the Plan Builder/`Φ`/round-loop
   wiring, not an oversight.

3. **Index-cost-independent-of-fleet-size (T9) is a structural property, not a load-tested one.**
   The cell-partitioned key scheme (`engine:idx:{shard}:{fineCell}:{class}`) makes a lookup's cost a
   function of local cell membership by construction — the same argument `benchmark/**`'s existing
   harness would need to confirm empirically at scale, which this phase did not run (no populated
   index at fleet scale exists to benchmark against yet).

4. **The Cold Index rebuild reads `AgentCellPosition`, not the raw `Observation` log directly.**
   §6.2 says the index is "rebuildable from the observation log"; `availabilityIndex.
   rebuildFromRecords()` takes pre-assembled records as its input (by design — see that module's
   docstring), and `indexMaintainer.worker.rebuildIndexFromMirror()` supplies them from
   `AgentCellPosition` rather than re-deriving each one fresh from `Observation` rows. This is
   faithful in spirit (the mirror **is** durable state derived from the observation log, kept
   current by the same worker that would otherwise re-derive it) and considerably cheaper for a
   rebuild, but it means a rebuild's freshness is bounded by the sweep interval
   (`SWEEP_INTERVAL_MS`, 5 s) rather than being instantaneous from the raw log. Worth a decision at
   whichever phase first exercises Cold Index in anger.

5. **`indexMaintainer.worker.js`'s two extension seams are stubbed, not implemented.**
   `chargingStatusFor()` and `capabilityAndContainerClassesFor()` default to conservative empty/
   false values (documented in the worker's own header) because assembling them correctly requires
   reading subsystems (mission progress, the `CapabilityBundle`/`ContainerModel` relations) whose
   exact query shape was not independently re-verified in this phase. The defaults only *narrow*
   which agents get indexed under `CHARGING_INTERRUPTIBLE`/`FINISHING_SOON` or matched by the
   secondary indices — never widen eligibility — so an unwired deployment degrades to a smaller
   candidate pool, not an incorrect one.

6. **Migration not applied to a live database** (§5) — a deployment step, matching every phase since 6.

## 14. Remaining Non-Blocking Issues

1. Items 4 and 5 above (`indexMaintainer.worker.js`'s scope) are worth closing before Phase 10's
   round loop starts depending on `FINISHING_SOON`/`CHARGING_INTERRUPTIBLE` candidates in earnest,
   or before Cold Index is exercised outside a test.
2. `PHASE_0_INDEPENDENT_VERIFICATION.md` still does not exist, as every review since Phase 1 has
   recorded. Not a Phase 9 blocker.
3. Prisma reports a major version update is available (5.22.0 → 7.9.1). Not evaluated or acted on —
   out of this phase's scope, and a major-version bump is exactly the kind of change that warrants
   its own review rather than riding in on a phase implementation.

## 15. Readiness for Independent Verification

**Ready.** Suggested focus, in priority order:

1. **The `Ω_terminal` injection-seam decision (§10).** Is taking the CU figure as an injected
   argument, rather than a static import, the correct resolution of the Tier 1/Tier 2 boundary here
   — and is the `0n`-when-inactive behaviour the right reading of "no correction is owed when the
   term is not registered into `Φ`"?
2. **The `E_min`/regeneration disclosure (§13, item 1).** Does this rise to the level the
   architecture's owner should resolve explicitly, the way Phase 8's A2 was escalated, or is the
   literal reading of §6.4's own text sufficient disposition?
3. **The admissibility sweep's construction (`candidateAdmissibility.test.js`).** Independently
   re-derive whether the six inequalities it composes are individually sound and whether the swept
   grid (2,566 combinations, curated per-dimension rather than a full Cartesian product of a finer
   grid) is the right shape for "exhaustive... over the configured parameter space", or whether a
   wider/differently-shaped sweep is warranted.
4. **The tier-gating bug (§11) and its fix.** Confirm the fix is complete — that no other tier
   boundary in `expansion.js` has the same off-by-one class of defect (tiers 3/4/6 were not exposed
   to the same bug because they are not part of the shared ring-loop the bug was in, but an
   independent pass over each tier's own gate condition is warranted).
5. **The Cold Index rebuild's source (§13, item 4).** Whether reading `AgentCellPosition` rather
   than `Observation` directly is a legitimate reading of §6.2's "rebuildable from the observation
   log," or whether it should be escalated the way Phase 8 escalated its own interpretive calls.

---

*End of Phase 9 Implementation Report.*
