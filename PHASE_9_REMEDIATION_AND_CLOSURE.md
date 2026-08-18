# Phase 9 — Remediation and Closure

**Candidate Generation and the Admissible Bound**

Date: 2026-08-18 · Branch: `feature/dashboard` · Working tree: `63f5c58` + uncommitted Phases 3–9
Role: Principal Distributed-Systems / Reliability / Safety / Independent Verification Engineer
Authority order: `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` §6 (frozen) → `IMPLEMENTATION_EXECUTION_PLAN.md`
Phase 9 row → current repository → `PHASE_9_INDEPENDENT_VERIFICATION.md` → `PHASE_9_IMPLEMENTATION_REPORT.md`

Historical reports are preserved unmodified. This document does not replace them; it records what
the **current** tree does, what was wrong with it, and what was changed.

---

## 1. Final Status

# PHASE 9 CLOSED

Seven genuine defects were found, fixed, and covered by 18 new regression tests, 9 live-PostgreSQL
checks, and 7 production-path checks including one planted violation.

Three of the seven sat on the *same* production request path, each sufficient on its own to make
Phase 9's only live runtime surface report nothing at all. None was reachable by re-reading the
historical reports, and none was reachable by any test in the existing suite — every one of them
required composing the real producer with the real consumer, or driving the real HTTP route
against a real database, rather than exercising a module against a fixture built to satisfy it.

The Phase 8 rule, restated as this phase's acceptance rule and applied:

> A unit-tested bound that production never computes is not a verified bound.

Phase 9's suite ran 2 566 admissibility scenarios green while the production endpoint that
consumes that same bound returned `null` for every agent on every request.

---

## 2. Starting State

### 2.1 What the historical reports claimed

`PHASE_9_IMPLEMENTATION_REPORT.md` (2026-08-05) claimed all 15 execution-plan checklist items
complete: nine engine modules, the `AgentCellPosition` migration, the index-maintainer worker, the
`GET /api/diagnostics/candidates/:legId` endpoint, and nine test files totalling 2 682 tests, with
`npm run verify` green at 78 suites / 4 705 tests.

`PHASE_9_INDEPENDENT_VERIFICATION.md` (2026-08-05) returned **PASS WITH MINOR ISSUES** —
15/15 checklist items independently confirmed, §6.4's formula confirmed term-by-term against the
frozen text, and exactly one finding:

| # | Historical finding | Its stated severity |
|---|---|---|
| 1 | `taskAssignment.service.js` and `robotRegistry.service.js` are named in the plan's "Files to modify" but carry no superseded banner | *"Minor … zero behavioural or correctness impact … does not block Phase 10."* |

The verification report's closing sentence: *"No other issues — blocking, moderate, or minor — were
found."*

### 2.2 What was actually true

That single historical finding was accurate and is now discharged (§4, F9-8). Everything else the
two reports asserted about the *modules* was also accurate — the formula in `lowerBound.js` does
match §6.4 term for term, the seven tiers are present, the comparators do delegate to
`determinism/ordering.js`, and the migration is Prisma's own SQL plus two hand-written CHECKs.

What neither report examined was whether any of it **runs**. Both reviews verified functions.
Neither verified the one composition that exists.

---

## 3. Current Repository State

### 3.1 Phase ownership map for every module Phase 9 touches

| Module | Owning phase | Producer | Consumer | Current production caller | Runtime reachable today |
|---|---|---|---|---|---|
| `candidates/availabilityIndex.js` | 9 | `indexMaintainer.worker` | `expansion.js`, diagnostics endpoint | `diagnostics.controller.getLegCandidates`; `indexMaintainer.worker` | **Yes** (endpoint). Worker `DEFERRED` |
| `candidates/lowerBound.js` | 9 | — | `expansion.js`, diagnostics endpoint | `diagnostics.controller.getLegCandidates` | **Yes** |
| `candidates/omega.js` | 9 | `config/derived.js` (Ω_policy), `pricing/vTerminal.js` (Ω_terminal, injected) | `lowerBound.js` | `diagnostics.controller.getLegCandidates` | **Yes** |
| `candidates/ordering.js` | 9 | — | `expansion.js`, diagnostics endpoint | `diagnostics.controller.getLegCandidates` | **Yes** |
| `candidates/expansion.js` | 9 | — | `solve/round.js` via `deps.expandCandidates` | `unexploredRingFloorMilliCU`/`READY_CLASSES` from the endpoint; `expandCandidates` from nothing | **Partly** — see §3.2 |
| `candidates/clusterShare.js` | 9 | — | Phase 10's composition root | **none** | No |
| `candidates/admissibilityGate.js` | 9 | — | tests | **none** (test-only by design) | No |
| `spatial/cells.js` H3 wrapper | 9 (added to Phase 2's file) | — | `availabilityIndex`, `expansion`, `lowerBound`, endpoint | via all of the above | **Yes** |
| `workers/indexMaintainer.worker.js` | 9 | `Agent`/`Commitment`/`Observation` | `AgentCellPosition`, Redis | `workers/registry.js` marks it `DEFERRED` | No |
| `AgentCellPosition` (Prisma) | 9 | `indexMaintainer.worker` | `rebuildIndexFromMirror`, endpoint | endpoint reads it | **Yes** |
| `solve/round.js` `candidatesFor()` | **10** | `deps.expandCandidates` | `runRound` | `workers/coordinator.worker.js` | No — see §3.2 |
| `workers/coordinator.worker.js` | **10** | — | — | `workers/registry.js` marks it `LEADER_ONLY`; nothing constructs its solve path | No |

### 3.2 What is and is not reachable, precisely

Phases 10–15 have all landed since the Phase 9 reports were written: `src/engine/solve/` and
`src/engine/intake/` are populated, `workers/registry.js` exists, and `server.js` starts six
`SCHEDULED` workers.

`candidates/expansion.expandCandidates` is consumed by `solve/round.js:239` as an **injected**
dependency (`deps.expandCandidates`), supplied by `workers/coordinator.worker.js:501`. The
coordinator is `LEADER_ONLY` in the worker registry and is **not required by any file in `src/` or
`server.js`** — verified by repository-wide grep, not inferred. So the full §6.3 hierarchical
expansion is complete, wired to its Phase 10 consumer by interface, and started by nothing. That
is Phase 10/15 composition-root work, explicitly recorded as such in `workers/registry.js`'s
`blockedBy` column, and it is **not** re-classified as a Phase 9 defect here.

Phase 9's own reachable production path today is exactly one:

```
GET /api/diagnostics/candidates/:legId          (routes/diagnostics.routes.js:29, behind authUser)
  → diagnostics.controller.getLegCandidates
    → candidates/omega.combinedCorrection()                     Ω_policy + Ω_terminal
    → candidates/availabilityIndex.candidatesInFineCell()       live Redis index, rings 0..3
    → candidates/lowerBound.lowerBound()                        LB(a, l) per agent
    → candidates/expansion.unexploredRingFloorMilliCU()         smallest unexplored bound
    → candidates/ordering.orderCandidates()                     canonical order
    → §6.1's three reported quantities
```

Every defect in §4 was found by taking that path seriously.

### 3.3 One registry claim corrected

`workers/registry.js`'s `index_maintainer` row said the index *"is otherwise maintained on the
telemetry path."* Repository-wide grep finds `availabilityIndex.applyPosition` called from exactly
one file — `indexMaintainer.worker.js` itself. No telemetry handler, socket handler, or service
writes the index. The row's disposition (`DEFERRED`) is right; its parenthetical was not. Recorded
here rather than edited, because `workers/registry.js` is Phase 15's file (§10).

---

## 4. Findings

Seven defects (F9-1 … F9-7) plus the discharge of the one historical finding (F9-8).

---

### F9-1 — The Ω correction was never applied, on the only path that computes it

| | |
|---|---|
| **Severity** | **Critical** — §6.4's admissibility correction absent from every production bound |
| **Discovery** | Composing the real producer with the real consumer, outside a fixture |
| **Files** | `src/engine/candidates/omega.js`, `src/controllers/diagnostics.controller.js` |

**Root cause.** `omega.combinedCorrection()` returned the quantity under the field name
`correctionMilliCU`. Both consumers — `lowerBound()` and `expansion.unexploredRingFloorMilliCU()` —
read `correction.milliCU` and reject anything that is not a `bigint`. `lowerBound()`'s own JSDoc
documents the contract correctly (`{ milliCU: bigint, breakdown?: object }` *"from
`candidates/omega.combinedCorrection()`"*); the producer did not satisfy the contract its consumer
documents.

**Observable effect before the fix**, reproduced against the live route:

```
combinedCorrection -> { ok: true, keys: ['ok','correctionMilliCU','policy','terminal','problems'],
                        correctionMilliCU: 100000n, milliCU: undefined }
lowerBound(...)    -> { ok: false, milliCU: null, missing: ['correction (candidates/omega.combinedCorrection)'] }
```

Every request to `GET /api/diagnostics/candidates/:legId` returned `lbCu: null` for every agent,
and `bestLbCu`, `smallestUnexploredBoundCu`, `achievedGapCu` all `null` — §6.1's three required
quantities, absent on every request, on every deployment, since the endpoint shipped.

**Why two reviews missed it.** `tests/engine/helpers/candidateFixture.js` exposes
`zeroCorrection()`, which returns a hand-built `{ milliCU, breakdown }`. Every Phase 9 test —
including all 2 566 admissibility scenarios — used it. The producer was tested (`candidatesOmega.test.js`
asserts `correctionMilliCU`), the consumer was tested (`candidatesLowerBound.test.js` passes
`{ milliCU }`), and the join between them was never executed. This is §24's permissive-fixture
failure mode in its purest form.

**Fix.** `combinedCorrection()` now returns `milliCU` as the canonical field, satisfying the
consumer contract directly, plus a `breakdown` carrying both halves for the decision record;
`correctionMilliCU` is retained as an alias so no existing reader diverges. On failure both are
`null`, which keeps the consumer's rejection fail-closed rather than accidental. The endpoint now
answers `422` with the unresolved reasons instead of relying on that accidental rejection.

**Regression tests.** `candidatesPhase9Remediation.test.js` F9-1 block (5 tests) — the real
`combinedCorrection()` output fed to both consumers; the correction proven *subtracted* (LB falls
by exactly Ω); the unresolved case proven fail-closed; both field names proven equal.

**Independent evidence.** `tools/verify/phase9ProductionPath.js` P9-RT-3, P9-RT-4, P9-RT-5 —
through the real Express app, real route, real auth, real Redis, real PostgreSQL 18.3.

**Status: FIXED.**

---

### F9-2 — A charging robot was classified `IDLE_READY` and searched at tier 1

| | |
|---|---|
| **Severity** | **High** — permissive direction; defeats §6.3's tier ordering entirely |
| **Discovery** | Enumerating the state space `indexMaintainer.assembleRecord()` actually produces |
| **File** | `src/engine/candidates/availabilityIndex.js` |

**Root cause.** `classify()` tested `idle` before charging. `indexMaintainer.assembleRecord()`
derives `idle` from the commitment count alone (`idle: activeCommitmentCount === 0`), so a robot
parked on a charger with no commitments satisfied `!hasActiveCommitment && idle` and classified
`IDLE_READY` — regardless of whether its charging session could be interrupted at all.

Two consequences, both against the frozen text:

1. §6.3 places `CHARGING_INTERRUPTIBLE` at **tier 5**, *"considered when tiers 0–4 yield no
   acceptable option."* A charging robot in `IDLE_READY` is searched at **tier 1** and can win
   against a genuinely idle one. The tier ordering §6.3 specifies was unreachable for the common
   case.
2. A robot charging **non-interruptibly** — one that physically cannot leave — was also
   `IDLE_READY`, i.e. offered work it cannot take.

`CHARGING_INTERRUPTIBLE` was in practice reachable only for an agent simultaneously executing a
mission *and* charging *and* out of queue capacity.

A second defect in the same function: `QUEUE_CAPACITY_AVAILABLE` required only
`queueDepth < capacity`. The maintainer always supplies both, so every uncommitted agent with a
configured `capacity` also matched. §6.3 tier 0 defines that class as *"agents **already
committed** to a compatible nearby Leg with spare queue capacity."*

**Fix.** The priority order now is: lifecycle-ineligible → not indexed; charging and
non-interruptible → not indexed; uncommitted, idle **and not charging** → `IDLE_READY`;
**committed** with spare queue capacity → `QUEUE_CAPACITY_AVAILABLE`; charging and interruptible →
`CHARGING_INTERRUPTIBLE`; projected free within the horizon → `FINISHING_SOON`. All five existing
`classify()` tests pass unchanged — none of them constructed the states above.

The narrowing direction is deliberate and matches the maintainer's own stated principle
(defaults *"only narrow eligibility, never fabricate it"*): the index is advisory (§3.3, I16) and
feasibility is re-verified at commit, so an agent wrongly omitted costs quality, while an agent
wrongly offered costs a dispatch to a robot that cannot move.

**Regression tests.** F9-2 block (5 tests), including the exact state shape
`indexMaintainer.assembleRecord()` emits.

**Independent evidence.** `phase9LiveDatabase.js` P9-DB-8 / P9-DB-9 — the real worker, against a
real PostgreSQL, writes neither a mirror row nor an index key for a non-interruptible charging
agent, and still indexes the same agent as `IDLE_READY` once it stops charging.

**Status: FIXED.**

---

### F9-3 — Tiers 3 and 4 substituted a constant for §6.4's pruning quantity

| | |
|---|---|
| **Severity** | **Critical** — unsound pruning; discards the optimum while reporting `pruning_rule_satisfied` |
| **Discovery** | Reading §6.4's rule against the code, then constructing an admissible counter-example |
| **File** | `src/engine/candidates/expansion.js` |

**Root cause.** §6.4's rule is

```
min LB over all unexplored cells  ≥  C* − Δ_opt      → stop
```

The k-ring loop computed the left-hand side geometrically. The tier 3 (zone) and tier 4 (region)
sweeps passed a literal `0n` for it, and passed `minBoundMilliCU: 0n` for every cell to the
ordering comparator as well — so cells were also visited in **cell-id order**, not §6.4's
*"increasing order of their minimum possible `LB`"*.

Substituting `0n` makes the stop condition fire whenever `C* ≤ Δ_opt`. §6.4 states plainly that
`C*` *"may be zero or negative once `C_opportunity` is negative"* — that is the stated reason the
tolerance must be additive rather than multiplicative — and `Δ_opt` defaults to 25 CU, so the
condition is ordinary, not exotic.

**Reproduction** (admissible by construction — `LB ≤ γ` asserted for both agents before the run):

```
admissibility check  agent-near: LB=-4426868  gamma=20000     LB<=gamma: true
admissibility check  agent-far : LB=-1800829  gamma=-1000000  LB<=gamma: true

truncatedBy       : pruning_rule_satisfied
agentsEvaluated   : 1
candidates        : [ 'agent-near@20000' ]
agent-far (the true optimum) was NEVER EVALUATED
true regret       : 1020000 milli-CU  (1 020 CU)
```

The search stopped after one zone cell, announced that the pruning rule was satisfied, and never
looked at the cell holding the optimum. §6.4 names this exact outcome: *"pruning would then
silently discard cells containing the true optimum while the decision record advertised a proven
guarantee."*

**Fix.** `unexploredCellFloorMilliCU()` derives a cell's geometric floor from its grid distance to
the origin (fine resolution for zone cells, coarse for region and cross-region cells), reusing the
same `unexploredRingFloorMilliCU` arithmetic. Tier 3 and tier 4 now score every cell, **order** by
that bound, and pass the minimum floor over the *remaining* cells — which, in ascending order, is
simply the next entry's — to the stop condition. When a floor cannot be resolved the sweep reports
a problem instead of assuming one.

After the fix, the same fixture evaluates both agents and returns `agent-far` at the head of the
canonical list. Regret: `0`.

**Regression tests.** F9-3 block (2 tests) — the planted-regret scenario, and a case where cell-id
order and bound order disagree, asserting the nearer cell is visited first.

**Status: FIXED.**

---

### F9-4 — The "proven" search gap was under-reported on budget truncation

| | |
|---|---|
| **Severity** | **High** — a false guarantee written into the decision record and §21.4's SLI |
| **Discovery** | Tracing which ring is actually unexplored when a cap binds mid-ring |
| **File** | `src/engine/candidates/expansion.js` |

**Root cause.** The achieved bound was computed against `ring + 1`'s floor unconditionally. When a
budget truncates part-way through ring `r`, the rest of ring `r` is itself unexplored, and its
floor is strictly lower — so the reported gap was strictly smaller than the proven one.

**Reproduction** — 19 agents indexed across ring 0 and ring 3, `candidate.max_evaluated = 2`:

```
truncatedBy        : candidate.max_evaluated
agentsEvaluated    : 2 of 19 indexed
reported gap       : 70994 milli-CU
floor(ring 3)      : 552671      floor(ring 4) : 829006
honest gap         : 347329 milli-CU
under-reported by  : 276335 milli-CU   (a factor of 4.9)
```

§6.4: *"`C* − min LB over unexplored` is a **proven** bound on the search gap for that decision …
That number is written into the decision record and aggregated into an SLI (§21.4)."* An
under-reported proven bound is precisely the *"false guarantee … already written into production
decision records and consumed by a first-class SLI"* the section calls worse than no bound.

**Fix.** The lowest still-unqueried ring is tracked explicitly (`unexploredRingDistance`, set to
`r` on entering ring `r` and to `r + 1` only once ring `r` is queried in full), and cells left
unvisited by a tier 3/4/6 truncation contribute their own floors to the same minimum. The reported
gap takes the **lower** of the two floors — the conservative direction, which can only widen a
proven bound, never narrow it.

Two further honesty changes in the same return value: when no floor resolves, and when nothing was
priced at all, the gap is `null` with `achievedGapProven: false`, instead of `0n` — which in a
decision record reads as *"proven optimal"*.

**Regression tests.** F9-4 block (2 tests) — the mid-ring truncation asserted against ring 3's
floor exactly, and asserted strictly greater than the old ring-4 figure; and the nothing-priced
case asserted `null`/`false`.

**Status: FIXED.**

---

### F9-5 — Silent candidate loss, and an expansion that could not terminate

| | |
|---|---|
| **Severity** | **High** — §6.1's two headline properties (bounded work, no silent truncation) both breached |
| **Discovery** | Running the module with inputs that fail to resolve; the harness hung |
| **File** | `src/engine/candidates/expansion.js` |

**Two defects, one reproduction.**

**(a) Silent loss.** An agent whose `LB` could not be resolved was dropped: it never reached
`evaluateExact`, its `lbProblems` were stored on an internal result and never surfaced, `ok` stayed
`true`, and `problems` stayed empty. A systematic input gap therefore reported *"no candidates, gap
0"* — an unbounded, silent truncation, which is the baseline behaviour §6.1 exists to end
(*"with more than 100 eligible robots the globally best agent may simply never be scored, silently,
with no signal"*).

**(b) Non-termination.** §6.3 bounds expansion by *"`candidate.max_expansion_tiers`,
`candidate.max_radius_by_sla_class`, and a wall-clock budget."* The tier cap does not bound ring
growth — tier 2 is one tier however many rings it grows. `candidate.max_radius_by_sla_class` is
registered with `default: null` (`required: true`, UNCALIBRATED — Ops' containment limit), and
`stillWithinDeadline()` returned `true` whenever `deadlineMs`/`elapsedMs` were absent. With neither
supplied and nothing ever priced, `shouldStopExpanding` can never fire and the k-ring loop grows
without limit. The reproduction script had to be killed. Every existing expansion test avoided this
only by capping tiers at 1 or by finding a candidate.

A third, narrower case: a wall-clock budget was consulted only inside `considerAgentIds`, so a run
of empty rings never read the clock at all.

**Fix.**
- Unresolved bounds are collected into `unresolvedBoundAgentIds`, reported in `problems`, and set
  `truncatedBy = "lower_bound_unresolved"`; `ok` becomes `false`.
- With tier 2 enabled and neither a radius nor a clock budget supplied, `expandCandidates` refuses
  up front (`truncatedBy: "unbounded_search_refused"`) and names the missing parameter. It does
  **not** invent a default radius — that is a POLICY value Ops owns (§6.3), and inventing one here
  would be this module making an operational decision silently.
- The deadline is now checked on each ring iteration, not only per agent.

`tests/engine/candidatesExpansion.test.js`'s one tier-2 test gained `maxRadiusMetres: 5_000`. That
is a strengthening, not a weakening: the register marks the parameter `required: true`, so a caller
omitting it was already out of contract.

**Regression tests.** F9-5 block (4 tests) — unresolved bounds reported; unbounded search refused;
a clock budget alone accepted; tier 1 alone still needs no radius.

**Status: FIXED.**

---

### F9-6 — The endpoint read an `EnergyModelParams` column that does not exist

| | |
|---|---|
| **Severity** | **Critical** — second and third independent breaks on the same production path |
| **Discovery** | The live route reported `lbUnresolvedBecause: ["energy.model.beta_dist", …]` *after* F9-1 was fixed |
| **File** | `src/controllers/diagnostics.controller.js` |

**Root cause.** Both Phase 9 read sites did `params.coefficients[COEFFICIENT.DIST]`.
`EnergyModelParams` has no `coefficients` column — it has camelCase scalars (`betaDist`,
`betaMass`, …), and the engine's model contract is an object keyed by §14.2's snake_case names
(`beta_dist`, …). Nothing in the tree converted between the two; Phase 9 invented a column.

The effect compounded: `lowerBound()` failed on `energy.model.beta_dist` for every agent, **and**
`fleetBestCaseFrom()` returned `null`, so `unexploredRingFloorMilliCU` failed too. Either alone
nulls the whole response.

This is why fixing F9-1 in isolation would not have restored the endpoint — and why finding it
required actually issuing the request rather than reasoning about the module.

**Fix.** `energyCoefficientsFrom(params)` maps the Prisma row to the coefficient object
`energy/consumption.js` documents, used at both read sites. Kept beside the endpoint rather than
added to `consumption.js`, whose contract is the coefficient object, not the row it came from.

**Independent evidence.** `phase9ProductionPath.js` P9-RT-3 — `lbCu=-888.542`,
`unresolvedBecause: []` against a real `EnergyModelParams` row.

**Status: FIXED.**

---

### F9-7 — The response's own ordering was not canonical, and round-tripped exact values through floats

| | |
|---|---|
| **Severity** | **Moderate** — §6.6 prohibits it explicitly; diagnostic scope |
| **Discovery** | §6.6 read against the endpoint's `findMany` + `sort` |
| **File** | `src/controllers/diagnostics.controller.js` |

**Root cause.** `positions` comes from an unordered `findMany`. The returned `candidates` array was
then sorted with `(a.lbCu ?? Infinity) - (b.lbCu ?? Infinity)` — a plain numeric comparator with no
tie-break — so exact ties resolved to whatever physical order PostgreSQL happened to return. §6.6:
*"Any set ordering that depends on a query planner, hash iteration order, or concurrent-response
arrival order is prohibited."* That is the baseline's arbitrary tie-breaking, reproduced.

Separately, the ranking round-tripped an exact int64 through a float and back
(`BigInt(Math.round(row.lbCu * 1000))`) — a silent narrowing of the milli-CU quantity §1.3 and
§8.10 keep exact.

**Fix.** The exact `lbMilliCU` is carried alongside the human-readable `lbCu`; every comparison uses
the bigint; the response order is the canonical `orderCandidates` rank, with unresolved rows
ordered by `agentId` rather than arbitrarily.

**Note.** `rebuildIndexFromMirror()` reads `findMany()` with no `ORDER BY` too, but
`rebuildFromRecords()` sorts by `agentId` before writing, so the rebuild is order-independent —
verified on a live database rather than assumed (P9-DB-7, §6).

**Status: FIXED.**

---

### F9-8 — The historical Minor finding, discharged

`taskAssignment.service.js` no longer exists: Phase 15 retired it, and
`tools/gates/checkLegacyRetirement.js` now enforces its absence from the build and its
non-importation across 315 files. That is a stronger disposition than the banner the finding asked
for, and the finding is closed by supersession.

`robotRegistry.service.js` still exists and still exposes `getAllRobotIds()` reading `robots:all` —
the unpartitioned global enumeration §6.1's T9 forbids of a decision path. A superseded banner was
added, naming the replacement (`availabilityIndex.candidatesInFineCell` / `candidatesInCoarseCell`)
and the reason. Zero executable-line change, matching the convention Phases 5, 6 and 8 used.

**Status: DISCHARGED.**

---

## 5. Production Reachability

This section is mandatory and is the point of the exercise.

### 5.1 The chain, end to end

```
SPECIFICATION      §6.4  LB(a,l) = travel·λ_min + wait·λ_min + E_min·cu_per_wh
                         + C_delay(earliest) − Ω_terminal − Ω_policy
        ↓
IMPLEMENTATION     candidates/lowerBound.js:107  lowerBound()
                   candidates/omega.js:173       combinedCorrection()
        ↓
PRODUCTION CALLER  controllers/diagnostics.controller.js:getLegCandidates
                   registered at routes/diagnostics.routes.js:29, behind authUser
        ↓
RUNTIME PATH       GET /api/diagnostics/candidates/:legId
                   → Redis rings 0..3 (37 cells) → AgentCellPosition → LB per agent
        ↓
DECISION           orderCandidates() ranks by exact milli-CU; the ring floor bounds the rest
        ↓
OBSERVABLE RESULT  { bestLbCu: -888.542, smallestUnexploredBoundCu: -666.177, achievedGapCu: 0 }
```

Verified by `tools/verify/phase9ProductionPath.js`, **7/7**:

| Check | Result |
|---|---|
| P9-RT-1 the route exists and is behind `authUser` | PASS — unauthenticated → 401 |
| P9-RT-2 the live Availability Index lookup finds the seeded agent | PASS — 1 agent, 37 cells explored |
| P9-RT-3 `LB(a, l)` resolves in production | PASS — `lbCu=-888.542`, `unresolvedBecause: []` |
| P9-RT-4 §6.1's three quantities are all reported | PASS — all three numeric |
| P9-RT-5 the Ω correction is genuinely subtracted | PASS — raising the `C_policy` ceiling lowers `LB` by exactly the increase in Ω_policy |
| P9-RT-6 **planted violation** fails closed | PASS — 422, naming `omegaTerminalCu` |
| P9-RT-7 the refusal was the planted cause, not a broken endpoint | PASS — restored → 200 with a resolving bound |

Before the fixes this harness scored **1/7**: only the auth check passed.

### 5.2 Planted-violation evidence

The violation is planted in the **configuration the running server reads**, never by calling a
guard directly: `configService.buildSnapshot({ killSwitchState: { opportunity_cost_term: false } })`.
With the opportunity term live, `C_opportunity` may be negative, and this endpoint has no round
price snapshot from which to compute `Ω_terminal`. §6.4 makes an `LB` missing that correction not a
lower bound at all. The production path must refuse rather than publish one — and does:

```
status 422
{"error":"the Ω correction LB(a, l) requires did not resolve for leg \"p9-path-leg\"",
 "unresolvedBecause":["opportunity_cost_term is active this round but no non-negative
  omegaTerminalCu was supplied. C_opportunity may be negative whenever this term is
  registered, and an admissible bound cannot omit its correction while the term is live
  (§6.4, I20)"]}
```

Restoring the register restores a resolving bound at the same URL, so the refusal is the planted
cause and not a blanket failure. The register was restored to its original state and the process's
`defaultSnapshot` reference put back; no repository file was modified by the harness.

A second planted violation runs at the database (P9-DB-1): a raw `INSERT` with a fifth availability
class, rejected by `AgentCellPosition_availability_class_known`.

### 5.3 Error-propagation audit

Every pattern §9 of the closure brief names was searched for across `src/engine/candidates/**` and
the endpoint:

| Pattern | Found | Disposition |
|---|---|---|
| `try { guard() } catch { continue }` | `availabilityIndex.applyPosition`/`membersOf` | **Correct by specification** — §3.3/I16 make the index advisory: *"loss must be survivable"*, and a swallowed failure narrows the search, never fabricates a candidate. Feasibility is re-verified at commit. |
| `if (!result) { /* ignore */ }` | `evaluateOne`'s unresolved bound | **Was a defect (F9-5a); fixed** — now reported and `ok: false`. |
| `result ?? true` / `?? 0n` | `solve/round.js:248` `expansion.achievedGapMilliCU ?? 0n` | **Phase 10-owned** — see §9. Phase 9 now reports `null` + `achievedGapProven: false` + `problems` rather than a false `0n`. |
| A later function overriding the decision | none | The endpoint's only writer is `res.json`. |
| An unchecked return value | `combinedCorrection` | **Was a defect (F9-1); fixed** — explicit 422. |

---

## 6. Database Verification

**PostgreSQL 18.3** on x86_64-windows, a disposable cluster on `127.0.0.1:55433` built from the
installed binaries. Neither the shared Neon instance nor the user's own cluster on 5432 was
touched. The **complete migration chain — 23 migrations, applied in directory-name order with
`ON_ERROR_STOP=1` — applied cleanly**, producing 73 tables.

`tools/verify/phase9LiveDatabase.js`, **9/9**:

| Check | Result |
|---|---|
| P9-DB-1 `availabilityClass` CHECK rejects a fifth class | PASS — `AgentCellPosition_availability_class_known` raised |
| P9-DB-2 coordinate CHECK rejects out-of-range lat/lon | PASS — 4/4 edges (lat ±90, lon ±180) |
| P9-DB-3 `agentId` is UNIQUE | PASS — a second placement rejected |
| P9-DB-4 upsert supersedes the mirror row | PASS — 1 row, superseding class |
| P9-DB-5 `observedAtMs` round-trips as exact `BigInt` | PASS — `1798761600123` in, `1798761600123` out |
| P9-DB-6 `ON DELETE CASCADE` on `Agent` | PASS — no orphan mirror row |
| P9-DB-7 Cold Index rebuild is order-independent | PASS — physical order changed; index **and** Redis command trace byte-identical |
| P9-DB-8 charging non-interruptible agent is not indexed | PASS — no mirror row, 0 index writes |
| P9-DB-9 the same agent, not charging, IS indexed | PASS — `IDLE_READY` |

**Migration safety.** `20260805100000_candidate_generation_and_availability_index` contains no
`DROP`, `DELETE`, `TRUNCATE`, `RENAME`, or `ALTER COLUMN` — one `CREATE TABLE`, four
`CREATE INDEX`, one foreign key, two `CHECK` constraints. Additive only. **No down migration
exists, so rollback was not tested and is not claimed.**

**NULL semantics.** `AgentCellPosition` has **no nullable column in any unique constraint** — the
only unique index is on `agentId`, which is `NOT NULL`. The `NULLS NOT DISTINCT` question that
produced defects in `RejectionAggregate` (Phase 6) and `ServiceTimeModel` (Phase 8) does not arise
here, and P9-DB-3 confirms the single-column uniqueness fires.

**Replay / determinism.** P9-DB-7 is the §6.6 / T6 check: `rebuildIndexFromMirror()` reads
`findMany()` with no `ORDER BY`, so the query planner's order is not fixed — but
`rebuildFromRecords()` sorts by `agentId` before writing, and the harness proves that on a live
database by forcing two different physical orders and comparing both the resulting index **and**
the full Redis command trace.

---

## 7. Integration

### 7.1 Phase 8 → Phase 9

Traced module by module: Phase 9 does **not** rebuild the plan, recompute cost, normalise cost, or
mutate a priced plan. It consumes Phase 8's `cost/cDelay.forLeg()` unchanged (in both `lowerBound()`
and `unexploredRingFloorMilliCU()`), Phase 8's `cost/exchangeRates.apply()` for both rate
applications, and Phase 7's `energy/consumption.COEFFICIENT.DIST` as a key rather than redefining
it. Every exact evaluation is `evaluateExact`, injected — Phase 9 never assembles the
feasibility → Plan Builder → Φ → γ pipeline itself.

Exact arithmetic: `determinism/fixedPoint`'s `subtract`/`sum`/`compare`/`assertInt64` throughout.
The one float round-trip found in the whole phase was in the endpoint's ranking, and is fixed
(F9-7). `Number()`, `parseFloat()`, `Math.round/floor/ceil` appear nowhere in
`src/engine/candidates/**` on a milli-CU quantity; the remaining `Math.max`/`Math.ceil` calls
operate on metres and ring counts, both of which are genuinely real-valued inputs to the geometry.

**Phase 8 was not reopened.** No Phase 8 file was modified. The A2 specification issue is untouched.

### 7.2 Phase 9 → Phase 10+

`solve/round.js` consumes `expandCandidates` through injection and reads
`candidates`, `achievedGapMilliCU`, `truncatedBy`, `cellsExplored`, `agentsEvaluated`, `problems`.
Every one of those fields still exists with the same type, except `achievedGapMilliCU`, which may
now be `null` when nothing was priced or no floor resolved — a case that previously reported a false
`0n`. Two additive fields (`achievedGapProven`, `unexploredRingDistance`, `unresolvedBoundAgentIds`)
were added; no consumer breaks on an added field.

`solve/round.js:248` coerces that `null` with `?? 0n`, which converts *"no bound was proven"* into
*"gap 0 = proven optimal"* at the consumer. That is a Phase 10-owned permissive default, recorded in
§9 rather than fixed here: the ownership rule is to fix the Phase 9 side, and the Phase 9 side now
reports the truth in three places (`achievedGapMilliCU: null`, `achievedGapProven: false`, and a
`problems` entry) that Phase 10 can read.

No later-phase logic was rewritten. `observability/shadow.js` and `workers/shadow.worker.js` take
`expandCandidates` by injection too and are unaffected.

---

## 8. Test Results

Run fresh in this session, not copied from any report.

**Build gates — `npm run gates`, 7/7 PASS:**

| Gate | Result |
|---|---|
| `gate:tiers` | PASS — 277 modules, 388 governed import edges, no Tier 0/1 → Tier 2 dependency |
| `gate:params` | PASS — 183 engine modules against 242 registered parameters; no bare behavioural constants |
| `gate:tenets` | PASS — 274 modules, no T1/T6 violations |
| `gate:privacy` | PASS — 16 modules in the cost and decision-record scopes hold no identifying field |
| `gate:erasure` | PASS — 3 corpus decisions reconstructed byte for byte from Tier A alone |
| `gate:legacy` | PASS — 4 retired modules absent and unimported across 315 files |
| `gate:columngen` | PASS — NOT_REQUIRED (no column-generation module changed) |

**Jest — `npm test`, all five projects:**

```
Test Suites: 147 passed, 147 total
Tests:       6480 passed, 6480 total
Snapshots:   0 total
Time:        193.699 s
Ran all test suites in 5 projects.
```

**0 failures. 0 skips.**

### 8.1 Full-sweep reconciliation

Baseline, independently re-run at the start of this session before any change:
**146 suites / 6 462 tests / 0 failures / 0 skips** — identical to the Phase 8 closure's figure.

| Lane | Suites | Tests |
|---|---|---|
| `engine` | 117 | 6 187 |
| `gates` | 7 | 100 |
| `legacy` | 17 | 126 |
| `chaos` | 3 | 44 |
| `scale` | 3 | 23 |
| **Sum** | **147** | **6 480** |
| Reported by the full run | 147 | 6 480 |

The lane sums reconcile exactly with the full-sweep total, and the delta against the baseline is
**+1 suite / +18 tests** — precisely `candidatesPhase9Remediation.test.js`. Nothing else moved: the
`legacy` lane is unchanged, and no existing suite gained or lost a test.

Phase 9's own lane (`candidate*`, `indexMaintainer`, `spatial` — 12 suites) runs **2 756 tests**,
of which 2 566 are the admissibility sweep and 18 are new.

**Live PostgreSQL 18.3:** `phase9LiveDatabase.js` — **9/9**.
**Production path (real app/route/auth/Redis/DB):** `phase9ProductionPath.js` — **7/7**.

### 8.2 No test was deleted, skipped, or weakened

- **0 tests deleted.** **0 tests skipped.** **0 assertions loosened.**
- Exactly one existing test line changed: `candidatesExpansion.test.js` gained
  `maxRadiusMetres: 5_000` on its one tier-2 case. That **adds** a required input the register
  already marks `required: true`; it removes no assertion. Justified from §6.3 and the register,
  per §29.
- All five pre-existing `classify()` tests pass unchanged against the F9-2 fix — the fix changes
  only states no test constructed.
- All 2 566 admissibility-sweep scenarios pass unchanged.

---

## 9. Remaining Limitations

| # | Limitation | Classification |
|---|---|---|
| L1 | `candidates/expansion.expandCandidates` — the full §6.3 seven-tier search — has no running production caller. `solve/round.js` consumes it by injection; `workers/coordinator.worker.js` supplies it; the coordinator is `LEADER_ONLY` and nothing constructs its solve path. | **Later-phase ownership** (Phase 10/15 composition root). Recorded in `workers/registry.js`. Not a Phase 9 defect. |
| L2 | `candidates/clusterShare.js` (§6.5 per-cell-cluster sharing) has no production caller for the same reason. | **Later-phase ownership.** |
| L3 | `solve/round.js:248` coerces a `null` (unproven) search gap to `0n`, which reads as "proven optimal". | **Implementation defect, Phase 10 ownership.** Phase 9 now reports `achievedGapProven: false` and a `problems` entry alongside the `null`, so the information Phase 10 needs is present. Recommend Phase 10 propagate rather than coerce. |
| L4 | `workers/registry.js`'s `index_maintainer` row states the index "is otherwise maintained on the telemetry path". Grep finds no such writer. | **Documentation defect, Phase 15 ownership.** The `DEFERRED` disposition itself is correct. |
| L5 | `candidates/admissibilityGate.checkOmegaNonNegative()` has no production caller. | **Not a defect.** The property it checks (Ω_terminal ≥ 0) is enforced at the point the value enters the system — `omega.omegaTerminalMilliCU` rejects a negative `omegaTerminalCu` — and that rejection *is* tested (`candidatesOmega.test.js`) and *is* on the production path (P9-RT-6 exercises the sibling branch). The gate function is a redundant second copy; recorded so it is not mistaken for an installed guard. |
| L6 | `cost.energy.cu_per_wh` ships UNCALIBRATED with no default, so on register defaults alone `LB` is genuinely unresolvable and the endpoint says so. | **Environmental / configuration.** Correct behaviour: §22.4 classes it among the values requiring data the fleet does not yet produce. The production-path harness binds it, exercising the same code a publish would. |
| L7 | Index-lookup cost independent of fleet size (T9) is structural, not load-tested. The endpoint issues 37 cells × 2 classes = 74 sequential Redis round trips per request; against the configured remote Redis this measured ≈18 s. | **Environmental limitation**, unchanged from the historical report's own disclosure. §6.5's cluster-shared reads are the specified remedy and belong to the round path (L2). Recorded because §20.1 targets < 5 ms for candidate generation and the current sequential-read shape will not reach it. |
| L8 | No down migration exists for `20260805100000_…`, so rollback was not tested. | **Environmental limitation**, stated rather than papered over. |
| L9 | The regenerative-braking caveat in `lowerBound.js`'s docstring — a steeply net-descending route could realise `E_leg` below `β_dist · distance` — remains open. | **Specification issue**, unchanged. §6.4 names this exact formula as the intended underestimate without qualifying it against regeneration; the module implements the frozen text literally. |
| L10 | Concurrency was not exercised with multiple simultaneous coordinators. | **Not applicable at this phase.** Phase 9 introduces no lock, no transaction, and no shared mutable state: the index is advisory and idempotent by construction (P9-DB-7), and `expandCandidates` is a pure function of its injected reads. The concurrency surface belongs to Phase 10's round loop. |

**No unresolved safety-critical defect remains.**

---

## 10. Phase Boundary — what was NOT implemented

- **Nothing from Phase 10 or later.** No round loop, coordinator wiring, min-cost flow, or column
  regime was written, and no Phase 10+ file was modified.
- **`workers/registry.js` was not edited**, though L4 records an inaccurate claim in it. It is
  Phase 15's file and the correction is a documentation change in another phase's scope.
- **`solve/round.js` was not edited**, though L3 records a permissive default in it.
- **Phase 8 was not reopened.** A2 is untouched. No `src/engine/cost/**` or `src/engine/plan/**`
  file was modified.
- **No default search radius was invented.** `candidate.max_radius_by_sla_class` is a POLICY
  parameter owned by Ops with no default by design; F9-5's fix refuses rather than substitutes.
- **`checkOmegaNonNegative` was not wired into `validatePublish()`.** It adds nothing A1/V2 and
  `omega.js`'s own entry check do not already enforce, and `Ω_terminal` does not exist at publish
  time — a category difference, not a gap.
- **The index maintainer was not scheduled.** Its two missing classifiers are composition-root work
  the registry already names.

---

## 11. Final Recommendation

# PHASE 9 CLOSED

Every §6 requirement is enumerated against the frozen text (not a checklist copied from the
implementation report), has a real implementation, and — for every requirement whose production
caller exists today — has a proven runtime path with an observable effect and a planted violation
demonstrating the guard is installed rather than merely present.

The requirements whose only caller is Phase 10's unbuilt composition root are named explicitly in
§9 as later-phase ownership, not silently counted as verified.

**Phase 10's remaining work on Phase 9's behalf** is one line of composition (`expandCandidates`
into the coordinator's dependency set) and one correction (L3). Neither is a Phase 9 defect.

---

### Files changed by this closure

| File | Why | Finding | Regression test |
|---|---|---|---|
| `Backend/src/engine/candidates/omega.js` | correction returned under a field its consumers do not read | F9-1 | F9-1 block |
| `Backend/src/engine/candidates/availabilityIndex.js` | charging agents classified into a tier 1–4 class | F9-2 | F9-2 block |
| `Backend/src/engine/candidates/expansion.js` | tier 3/4 pruning constant; achieved-gap ring; silent loss; unbounded loop | F9-3, F9-4, F9-5 | F9-3/4/5 blocks |
| `Backend/src/controllers/diagnostics.controller.js` | explicit fail-closed on unresolved Ω; `EnergyModelParams` adapter; canonical ordering; exact arithmetic | F9-1, F9-6, F9-7 | `phase9ProductionPath.js` |
| `Backend/src/services/robotRegistry.service.js` | superseded banner (comment only) | F9-8 | `gate:legacy` |
| `Backend/tests/engine/candidatesPhase9Remediation.test.js` | **new** — 18 regression tests | all | — |
| `Backend/tests/engine/candidatesExpansion.test.js` | `maxRadiusMetres` added to the one tier-2 case | F9-5 | — |
| `Backend/tools/verify/phase9LiveDatabase.js` | **new** — 9 live-PostgreSQL checks | F9-2 and the schema claims | — |
| `Backend/tools/verify/phase9ProductionPath.js` | **new** — 7 production-path checks incl. planted violation | F9-1, F9-6, F9-7 | — |

No file outside this table was modified by this closure.

---

*End of Phase 9 Remediation and Closure.*
