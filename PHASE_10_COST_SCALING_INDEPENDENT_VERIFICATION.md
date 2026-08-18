# Phase 10 (Reopened) — Cost-Scaling Solver: Independent Verification

**Role:** Independent Software Verification Engineer (did not implement the change under review).
**Scope:** `PHASE_10_COST_SCALING_IMPLEMENTATION_REPORT.md` and the code it describes —
`Backend/src/engine/solve/costScaling.js` (new), `Backend/src/engine/solve/minCostFlow.js` (modified
dispatch), `Backend/src/engine/solve/objective.js` (buildInstance), and their tests.
**Method:** Read the frozen architecture and every planning/report document myself; read the
production code myself; **re-ran the tests and the scale benchmark independently** rather than
trusting the report's numbers; cross-checked every load-bearing claim against the code or a live
run before accepting it.

---

## Verdict

**PASS WITH RESERVATIONS. The reopened solver is correctly implemented, mathematically sound, and
regression-safe. It does not, and does not claim to, close the Phase 15 blocker by itself.**

- The algorithm, its exactness argument, its determinism, and its anytime behaviour are all
  independently reproducible and correct as implemented.
- Regression safety is confirmed directly: I ran the full backend suite myself
  (`jest --runInBand --forceExit`) to completion and got **136 suites, 6,059 tests, 0 failures**,
  matching the report's claim exactly — this is not taken on the report's word.
- §20.1 (250 ms wall-clock) is **not met** on this hardware, and the report is honest that it isn't.
  The gap has gone from ~94–151× to roughly 3–8× depending on what is counted, which is genuine,
  large progress, not gate discharge.
- The `scale_targets` release gate cannot turn GREEN from this work alone: `PHASE_15_BLOCKER_RESOLUTION_PLAN.md`
  itself names **two** independent causes — the solver algorithm class (this workstream) and **B1
  routing**, an unrelated, still-open execution-plan blocking decision that §20.3 calls the
  *dominant* term. This workstream does not touch routing and the report does not claim to.
- One finding below (buildInstance vs. solve time ratio) contradicts the report's own framing badly
  enough that it should be corrected before this document is cited as closing anything.

Recommendation: **accept the algorithm as correct and Phase-16-eligible on its own merits; do not
read this report, or this verification, as discharging `scale_targets` or unblocking Phase 16.**
That was never claimed by the implementer either — §14 of the cost-scaling report says so explicitly
— but it is worth stating plainly here since it is the reason Phase 10 was reopened in the first
place.

---

## 1. What I checked and how

I did not treat any number in `PHASE_10_COST_SCALING_IMPLEMENTATION_REPORT.md` as fact until I
reproduced it myself or found the code that would produce it. Concretely:

| Claim | How I checked it | Result |
|---|---|---|
| Algorithm is Goldberg–Tarjan push-relabel with ε-scaling, collapsed lexicographic cost | Read `costScaling.js` in full (684 lines) | Confirmed; matches the module's own header proof and the actual arithmetic |
| Network unchanged, dispatch added | Read `minCostFlow.js` in full (767 lines) | Confirmed; `solve()` tries cost scaling, falls back to SSP only on refusal or failed certificate |
| `buildInstance`'s prior O((m+n)·q) hot spot was fixed | Read `objective.js` in full | Confirmed — grouping is one O(columns) pass (lines 193–221), not the naive per-row filter |
| 129 solver unit/differential/determinism tests pass | Ran them myself: `npx jest tests/engine/solveMinCostFlow.test.js tests/engine/solveCostScaling.test.js tests/engine/solveObjective.test.js tests/engine/solveRound.test.js tests/engine/solveCadenceRegimeBudgets.test.js` | **5 suites, 129 tests, all pass** |
| "292/300 identical allocations" on the seeded differential sweep | Ran `solveCostScaling.test.js` with `-t "300 generated instances"` and read the console output | **Reproduced exactly**: `292/300` |
| §20.1/§20.2 scale benchmark numbers | Ran `tests/scale/round.scale.test.js` myself (twice) | Solve time and exponents reproduce; **buildInstance/solve ratio does not match the report's framing** — see Finding 2 |
| Locality (§24.6) and overload/soak scale tests | Ran `tests/scale/locality.scale.test.js` and `tests/scale/overloadAndSoak.scale.test.js` myself | 2 suites, 14 tests, all pass |
| Regime discipline (§9.3 — engine never asserts a guarantee it isn't entitled to) | Read `regime.js` in full | Confirmed; column regime is recognised-and-refused, not silently solved as singleton |
| Anytime discipline (§9.4) | Read `budgets.js` in full, and the forced-budget tests in `solveCostScaling.test.js` | Confirmed at both the algorithm level (`costScaling.run`, stops only between phases) and the tracker level |
| Production code path actually calls the new solver | Read `round.js`'s solve call site | Confirmed: `minCostFlow.solve(instanceResult.instance, { budgets })` — no forced solver option, so the real dispatch (cost scaling first) is what runs |
| T1/T6 module-boundary and legacy-retirement gates still hold | Ran `npm run gate:tenets` and `npm run gate:legacy` myself | Both PASS (271 modules checked; 4 retired modules confirmed absent) |
| Full regression suite ("136 suites, 6,059 tests, all pass") | Ran `npm test` (`jest --runInBand --forceExit`) myself, full run to completion | **Reproduced exactly: 136 suites, 6,059 tests, all pass, 0 failures**, in 231 s |

---

## 2. Correctness of the algorithm (independently re-derived, not just re-read)

**The collapse.** `costScaling.js` reduces the lexicographic pair `(unassigned, milliCU)` to a
single scalar `w = unassigned·K + milliCU` with `K = 1 + 2·n·max|milliCU|`. I re-derived this myself
rather than accepting the module comment: any simple path or cycle in the network has at most `n`
arcs (source → Leg → agent → sink is the longest, and `n` here is the node count, a safe
over-count), so the money component of any sum the algorithm ever forms is bounded in absolute value
by `n·max|milliCU| < K/2`. Two such sums can therefore never cross an `unassigned`-count boundary of
one unit's worth of `K`, which is exactly what makes `compare(w_a, w_b)` agree with
`compare_lexicographic((u_a, m_a), (u_b, m_b))` on every pair the algorithm ever compares. This is
correct, and it is the same argument the module's header makes — I did not find a flaw in it, and
the differential tests (below) are consistent with it holding in practice, not just in theory.

**The certificate is real, not decorative.** `solveCostScaling.test.js` (lines ~474–516, verified by
reading) manually drives `costScaling.prepare()`/hand-routes a *known-suboptimal* flow (cost 110
where the optimum is 50) and asserts `certify()` returns `ok:false`. A rubber-stamp certificate
cannot fail this test; this one does fail it, so the certificate is discriminating. I consider this
one of the strongest pieces of evidence in the whole submission, because a solver that publishes an
"optimality certificate" is only as trustworthy as this exact test.

**The certificate is exercised on the differential sweep, not just on hand-built cases.** 300 seeded
random instances (varying leg/agent/candidate count, cost sign and magnitude, deferral) are solved by
both algorithms and checked for equal objective, equal flow value, and equal feasible/assigned/
deferred/unassigned counts — I ran this myself and reproduced `292/300` byte-identical allocations
exactly, with objective/flow-value agreement on all 300 (the test asserts this, and it passed). The
8 divergent allocations are consistent with the report's own explanation (non-unique optima; the two
algorithms may land on different optimal columns of equal cost) and are **not** a correctness gap: no
test anywhere claims allocation-uniqueness, only cost/feasibility equivalence, which is the property
that actually matters for §9.3.

**Overflow/exactness fallback is real, not just claimed.** `prepare()` computes exact bounds on every
intermediate the algorithm can produce (`moneyCeiling`, `collapseK`, scaled-cost headroom) *before*
running, and refuses the instance with a named reason rather than running and hoping. I read this
code directly; it is conservative (checks against `Number.MAX_SAFE_INTEGER` with margin) rather than
optimistic, which is the correct direction for a Tier-1 correctness guard.

**Regime discipline holds.** `regime.js` grants the four §9.3 guarantees (exact, no branching, zero
gap, exact duals) only in the singleton regime and grants nothing in the column regime — `assertClaim`
throws rather than silently degrading. This means the reopened solver cannot accidentally leak an
"exact" claim onto a multi-Leg-column round, because Phase 10 still structurally cannot generate one
(`plan/columnBuilder.js` is singleton-only) and `regime.determine()` would classify it COLUMN and
refuse the flow-network representation outright (confirmed by the negative test in
`solveCostScaling.test.js`, also reproduced in my own run).

**Determinism holds under exact equality, not tolerance.** Both the algorithm module (comment-audited:
every loop is over an index range, active nodes are FIFO-ordered, no Map/Set/object-key iteration)
and the test suite (10 repeated runs, `JSON.stringify` byte-equality including duals and diagnostics
— I ran this test myself, it passed) support this. I did not find a hidden source of nondeterminism
(no `Date.now`, `Math.random`, or object-key iteration) in `costScaling.js` or in the dispatch path
of `minCostFlow.js`.

**Anytime holds at the only point that matters.** The scaling loop in `costScaling.run()` consults
the budget **only between phases** (line ~468–479 of `costScaling.js`), which is the only point at
which the pseudoflow is a complete, feasible, integral flow — every Leg routed to either an agent or
the sink. Stopping mid-phase would return a pseudoflow, which is not an allocation. I checked this is
actually where the budget check sits (not, e.g., inside `discharge()` or `refine()` mid-loop), and it
is. The forced-budget tests (`timeBudgetMs: 0`, and a fake clock that expires between the first and
second phase) reproduce this correctly when I ran them.

**Production actually uses this path.** `round.js`'s only call to the solver is
`minCostFlow.solve(instanceResult.instance, { budgets })`, with no `solver` override — so the
production decision path is the same dispatch order the tests exercise (cost scaling first, SSP as
fallback), not a code path that only exists in test fixtures.

---

## 3. Findings

### Finding 1 (informational, not blocking) — Algorithm choice differs from the blocker plan's specific
recommendation, but not from the frozen architecture's

`PHASE_15_BLOCKER_RESOLUTION_PLAN.md` (§9) suggests auction/Jonker–Volgenant (its "O4") as the
concrete realisation of §20.2's cost-scaling requirement, citing correctness risk in a general
push-relabel solver around the lexicographic cost not scaling componentwise. The implementation ships
general Goldberg–Tarjan push-relabel (not auction/JV) instead. I checked whether this is a deviation
from anything binding: **`NEXT_GENERATION_ASSIGNMENT_ENGINE.md` §27 (line 5574) explicitly names
"cost-scaling push-relabel" as an option and recommends cost-scaling generally** ("for its
bounded-suboptimality behaviour under a time budget, which suits the anytime requirement") — it does
not name auction/JV. The blocker plan is a planning document, not the frozen spec; the frozen spec's
own §27 table is satisfied by what was built. The lexicographic-scaling risk the blocker plan raised
is the exact risk the `K`-collapse argument in §2 above addresses, and it is backed by a runtime
certificate that would catch a violation rather than silently trust the argument. **Not a
conformance problem.**

### Finding 2 (should be corrected in the report) — buildInstance is not a minor residual cost; it is
now the larger of the two measured stages, and this contradicts the report's own framing

The cost-scaling report's §13 says buildInstance is "now 40% of the measured total (347ms of
869ms)" and frames the ~1%/99% build/solve split (from before this rework) as having shifted only
modestly. I ran `tests/scale/round.scale.test.js` **twice**, independently, on this machine:

```
Run 1: solve 763 ms, buildInstance 1347 ms   (buildInstance = 64% of the two combined)
Run 2: solve 727 ms, buildInstance 1275 ms   (buildInstance = 64% of the two combined)
```

In both of my runs, and independently in a separate research agent's own run (727ms/1275ms range,
consistent), **buildInstance is the larger of the two costs**, not 40% of a combined total dominated
by the solver. This is a stable, reproducible qualitative result (not a one-off noisy sample — two
independent processes on two independent invocations agree), so I do not believe it is measurement
noise. It may well be explained by this sandboxed environment being slower/differently-shaped than
the implementer's machine (the report itself documents ~1.3× session drift and disclaims
"representative hardware"), but a 4× discrepancy in the *ratio* (not just the absolute numbers) is
larger than a uniform slowdown would produce, since a uniform slowdown would preserve the ratio.
**This should be re-measured and the report's characterization corrected**, because it changes where
the next optimization effort should go: the report's own §13 recommendation ("the next measurement
should be taken before the next optimisation") is correct, but its premise — that the solver is still
"~99%" or even "~60%" of the cost — appears to already be wrong on the evidence in front of me.
This does not affect correctness, determinism, or the solver's own conformance to §20.2; it affects
only the accuracy of the report's performance narrative and where Phase 16-readiness effort should
be spent next.

### Finding 3 (informational) — the `phase0Scaffold.test.js` ownership guard was not tightened before
this workstream, as the blocker plan recommended

`PHASE_15_BLOCKER_RESOLUTION_PLAN.md` recommends converting `solve/`'s directory-wide ownership grant
to file-by-file (matching `routing/`, `plan/`, etc.) *before* the solver workstream begins, specifically
so a stray Phase-16 module dropped into `solve/` would be caught. I read `phase0Scaffold.test.js`
directly: `PHASE_10_OWNED` still lists `"solve/"` as a directory prefix, not file-by-file. This means
the guard-hardening prerequisite was not executed. It does not invalidate the current work — `costScaling.js`
is legitimately Phase 10's own file, and the guard would have passed it either way — but the residual
risk the blocker plan was trying to close (an undetected future module drop into `solve/`) is still
open. Low severity; worth a follow-up ticket, not a blocker for this verification.

### Finding 4 (informational, already disclosed) — §20.1 is not met, and the report says so; do not let
that get lost

At 500×200: solve alone (727–763ms measured here) already exceeds the 250ms *whole-round* target
before buildInstance, candidate generation, feasibility, routing, or commit are even counted. The
report is explicit that §20.1 is not declared passed and that representative-hardware measurement is
still required. I confirm this is accurate and not an understatement — if anything, Finding 2 suggests
the true gap (solve + buildInstance alone, ignoring the rest of the round) is closer to 2000ms/250ms
≈ 8× on this hardware, not the 2.4–3.5× the report's own headline table states, though the report's
mitigating language ("on this machine, in one process") already partially covers this.

### Finding 5 (not a defect) — `scale_targets` cannot go GREEN from this workstream alone

`PHASE_15_BLOCKER_RESOLUTION_PLAN.md`'s own Phase 16 Readiness Matrix (§16) names the `scale_targets`
gate's cause as **"Solver algorithm class; and B1 routing, which §20.3 makes the dominant term"** —
two independent, additive blockers. B1 (routing engine selection, execution-plan §6.1) is untouched
by this workstream and remains an open decision. §20.3 itself calls routing "the dominant cost" of
any real allocator round. This means even a hardware re-measurement that fully vindicates the solver
cannot by itself turn `scale_targets` GREEN. The cost-scaling report does not claim otherwise (§14:
"Phase 15 is not complete and is not claimed complete... Phase 16 is not started"), and I want that
scoping preserved rather than lost if this document is read out of context later.

---

## 4. What I did not verify (explicitly out of my scope, matching the report's own disclosure)

Calibration, shadow worker, soak (beyond the seconds-scale structural soak tests), simulator
fidelity, production invariant evidence, rollback rehearsal, and anything requiring Redis, the
database, or the frontend. The report discloses these as out of scope for this workstream, and I did
not attempt them either — they are Phase 15/16 concerns unrelated to the solver's own correctness.

---

## 5. Summary for whoever reads only this section

The cost-scaling solver is **correct, deterministic, exact where it claims to be exact, honest where
it cannot be, and safely backstopped by a real fallback**. I re-derived its central mathematical
claim myself and it holds; I re-ran its differential, determinism, and anytime tests myself and they
pass; I confirmed production code actually calls it. It is a large, genuine improvement over the
previous solver (roughly 30–45× faster at the reference shape, confirmed independently in direction
if not in every exact ratio). It does **not** close the §20.1 gate, and it **cannot by itself** close
the `scale_targets` release gate or unblock Phase 16, because a second, independent, unrelated
blocker (B1 routing) shares that gate. Treat this as a correct and valuable Phase 10 deliverable, not
as evidence that Phase 15/16 can proceed.

---
---

# PART II — SECOND INDEPENDENT VERIFICATION (2026-08-18)

**Role:** Independent Software Verification Engineer, reviewing Part II of
`PHASE_10_COST_SCALING_IMPLEMENTATION_REPORT.md` and the code it describes.
**Relationship to Part I of this document:** Part I is preserved unchanged. It was a mandatory
input to this pass. Two of its five findings do **not** survive re-measurement and §5 below says
so with the evidence; the rest of it stands and is confirmed.
**Method:** every number below was produced by executing this repository on this machine. No figure
was taken from Part I of this document, from Part I of the implementation report, or from Part II of
it. Where a figure agrees with one of those, it is because it was independently reproduced.

---

## Verdict

# PASS WITH RESERVATIONS

**The cost-scaling solver is correct, exact, deterministic, certified, and regression-safe. The
three fixes made in the reopened audit are sound and none of them weakens a test or a gate. §20.1
is NOT PASSED, `scale_targets` is NOT GREEN, and one anytime path remains honestly under-reported.**

The verdict is not "PASS" for exactly two reasons, both recorded as reservations rather than
defects:

1. **§20.1 remains undischarged and the whole round has still never been measured.** Two stages
   alone are 2.5x the whole-round budget. This is disclosed rather than hidden, which is why it is
   a reservation and not a failure.
2. **The zero-budget path still returns an allocation naming no Leg.** The reopened audit fixed the
   worse half of this (the in-loop stop) and left the pre-`prepare()` half deliberately, with a
   stated rationale I accept. It is a real gap in §9.4's reporting contract and it has an owner
   (Phase 11), but it is not closed.

---

## 1. What I ran

| Check | Command / method | Result |
|---|---|---|
| Full regression suite, before the audit's changes | `npx jest --runInBand --forceExit` | **147 suites, 6 480 tests, 0 failures**, 186 s |
| Full regression suite, after | same | **148 suites, 6 497 tests, 0 failures**, 213 s |
| All release gates | `npm run gates` | **7/7 PASS** |
| Engine lane alone | `--selectProjects engine` | 118 suites, 6 201 tests, 0 failures |
| Scale lane, before the fix | `--selectProjects scale`, 5 runs | **2 failures in 5** |
| Scale lane, after the fix | same, 5 runs | **5/5 pass** |
| Brute-force oracle | 30 000 seeded instances vs independent enumeration | **0 mismatches** |
| Differential sweep | repository's own 300-instance test | 292/300 identical allocation |
| Anytime stopping points | injected-clock sweep, deferral on and off | defect confirmed before, absent after |
| Budget overshoot | real clock, 500 x 200, 8 budgets | +11 ms at the 250 ms default |
| Sub-stage profile | 500 x 200, median of 5, 3 runs | see §3 |
| jest vs bare process | 3 runs each | ratio inverts, see §5 |
| Memory | per-process, forced GC, both solvers | see §6 |
| Nondeterminism scan | source scan of `solve/` for clocks, randomness, unordered iteration | clean in `costScaling.js` |
| Phase boundary | directory walk + `phase0Scaffold.test.js` | clean |

The gates in full: tier-dependencies (277 modules, 388 governed edges, no Tier 0/1 -> Tier 2),
parameter-register (183 engine modules against 242 registered parameters, no bare behavioural
constants), tenets (274 modules, T1/T6), identity-isolation (16 modules), reconstruction-equivalence
over an erased corpus (3 decisions, byte-for-byte), legacy-retirement (4 retired modules absent,
315 files), column-generation (NOT_REQUIRED and correctly so).

---

## 2. The algorithm — re-derived, not re-read

**The collapse.** I derived `K = 1 + 2*n*max|milliCU|` myself before reading the module's argument.
Every quantity the algorithm compares is a sum of at most `n` arc costs, so its money component is
bounded by `n*max|milliCU|`, strictly inside `K/2`. A one-unit difference in the `unassigned`
component is worth `K`, which no money difference can reach. The scalar comparison is therefore
*identical* to the lexicographic one rather than an approximation of it. Confirmed. The factor 2 is
arithmetic, not tuning.

**The epsilon schedule.** Costs are pre-multiplied by `n+1`, so `epsilon < 1` on the scaled costs is
`epsilon < 1/(n+1)` on the originals. An improving cycle on integer costs improves by at least 1 and
has at most `n` arcs, so `1/(n+1)`-optimality is optimality. The loop ends at `epsilon = 1` and the
answer is exact, not near-optimal. Confirmed at 500 x 200: `finalEpsilon: 1` after 40 phases.

**The certificate is real.** I re-ran the hand-built suboptimal-flow test: a flow of cost 110 is
constructed by hand where the optimum is 50, and `certify()` returns `ok: false`. A rubber stamp
cannot fail that test. I also confirmed the certificate is *not* trivially cheap because it does
nothing — it is 8.4–9.6 ms of a 364–388 ms solve, running `|V|` Bellman-Ford relaxation passes in
the exact uncollapsed lexicographic pair, and the dispatch refuses to return an uncertified result.

**Exactness guards.** `prepare()` refuses on three named conditions before running, each checked
against `Number.MAX_SAFE_INTEGER` with margin. The runtime price guard checks the only direction
prices move. I confirmed the refusal path end to end: an instance with `gamma = 4e18` milli-CU
falls back with `MONEY_TOO_WIDE`, the reference solver answers, and `optimalityCertified` is `null`
rather than `true` — an unchecked claim and a checked one are not conflated.

**Negative costs.** Exercised in the oracle sweep (an all-negative cost mode and a mixed-sign mode)
and in the hand-built family. Exact. Nothing clamps, nothing assumes non-negativity.

**Determinism.** `costScaling.js` contains no `Math.random`, no `Date.now`, no `performance.now`, no
`new Date`, and no iteration over a `Map`, a `Set` or an object's keys. Every loop is an index
range. The one `Map` iteration in `minCostFlow.js` (`agentNodeOf.values()` at line 201) assigns a
constant per node and is order-independent. The repository's own 10-run byte-equality test covers
allocation, objective, bound, gap, flow value, both dual vectors and the diagnostics, and passes.

---

## 3. The independent brute-force oracle — the strongest new evidence

Before this pass the repository's correctness evidence was a *differential* comparison against the
successive-shortest-path solver. That is real evidence, but it has a structural blind spot the
implementation report's Part II states correctly and which I verified myself: **both solvers read
the same network from `minCostFlow.buildNetwork()`**. A misunderstanding of the formulation — which
arc a deferred Leg leaves by, whether queueing costs a lexicographic unit or a price, whether
exclusivity binds per agent or per capacity slot — would be inherited by both arms, and the two
would agree exactly on the wrong answer.

`tests/engine/solveCostScalingOracle.test.js` closes that. I read it in full to confirm it does not
smuggle in solver logic, and it does not: it enumerates partial injective maps from Legs to agents,
prices each from the instance's own `costMilliCU`, and takes the lexicographic minimum of
`(Legs queued, milli-CU)`. It touches no arc, no potential, no residual capacity.

I ran it myself at **30 000 instances** (the committed test runs 8 000 in eight bands, sized to the
lane's timeout):

```
trials 30000   checked 30000   certifiedOptimal 30000   fellBackToReference 0   mismatches 0
```

Zero mismatches on the *lexicographic optimum*, not merely on money. Every instance reached cost
scaling through the production dispatch and every one carried a certificate. This exceeds the
8 000 trials Part I of this document reports and is, in my assessment, the single strongest piece of
correctness evidence in the Phase 10 submission.

---

## 4. The anytime defect — I reproduced it before and after

I did not take the implementation report's word for either the defect or the fix.

**Before the fix**, with an injected clock expiring after the loop's first consultation, at five
Legs:

```
deferral=false  phases=0  assigned=0 deferred=0 queued=0  accountedFor=0/5   validate.feasible=true
deferral=true   phases=0  assigned=0 deferred=0 queued=0  accountedFor=0/5   validate.feasible=false
```

Five Legs entered and none came out, with `ok: true` — and with deferral disabled
`objective.validate()` called that **feasible**, because a coverage row reading `<= 1` is satisfied
by zero. `round.js` writes `unassigned: solved.unassigned` and `constraintsSatisfied` straight into
the partition report, so a round could record "nothing left unassigned" having decided nothing at
all. That is a genuine §9.4 violation: the specification asks the incumbent to be "a feasible
solution and a bound", and the empty pseudoflow is neither.

I also confirmed it is reachable without an injected clock. With a real clock at 500 x 200, a
`timeBudgetMs: 100` round returned `scalingPhases: 0` and `0/500` Legs accounted for. Since
`prepare()` costs ~45 ms and `buildNetwork()` ~55 ms, the window is roughly 60–100 ms on this
machine — squarely inside the range a round could land in on slower hardware at the default 250 ms
budget.

**After the fix**, the same sweep at every stopping point from 1 to 6 phases returns 5/5 Legs
accounted for, and the real-clock sweep at `timeBudgetMs: 100` returns 500/500 after one phase.

**I checked the fix does not cheat.** It does not widen `solve.time_budget`, does not suppress
`budgetLimited`, and does not claim a certificate it cannot have — every budget-limited row still
reports `optimalityCertified: false` and `dualsTight: false`. It costs one scaling phase, which I
measured independently at **3.5 ms (median of 5)** against a ~380 ms whole solve. Overshoot at the
default 250 ms budget is **+11 ms**, or 4 %.

**I checked it does not change the unbudgeted path.** Identical diagnostics before and after at
500 x 200 — 40 phases, 132 666 relabels, 376 535 pushes, same objective, same allocation — and
30 000/30 000 oracle agreement is unchanged.

---

## 5. Part I of this document — two findings corrected

### Finding 2 (buildInstance is the larger cost) — **NOT REPRODUCED, and I now believe it was an artefact**

Part I measured `solve 727–763 ms` against `buildInstance 1275–1347 ms` and concluded buildInstance
is the dominant local cost. I reproduced that ratio — **inside jest**. Outside it, it inverts:

| | bare `node` process | through jest |
|---|---|---|
| `buildInstance` | 228 – 253 ms | 929 – 988 ms |
| `minCostFlow.solve` | 391 – 428 ms | 577 – 608 ms |
| **ratio build / solve** | **0.56 – 0.62** | **1.59 – 1.62** |

Three runs in each environment; stable within each and inverted between them. I consider this
settled rather than suggestive, because I also tested and eliminated the obvious confound: the
hypothesis that the scale lane's earlier suites leave a large live heap was checked by retaining all
twelve instances the lane's fits build before measuring, which moved the ratio from 0.56 to only
0.62. The measurement was then repeated in a **cold jest process running nothing else**, which
reproduced 1.59–1.62 immediately. The runner is the variable, not the heap.

The mechanism is consistent with the sub-stage profile: `buildInstance` is allocation-bound and the
epsilon-scaling loop is typed-array arithmetic, and a `vm`-sandboxed module registry taxes
allocation far more than arithmetic (~4.1x against ~1.4x).

**Why this matters and is not pedantry.** Production runs in a bare Node process. Part I's Finding 2
would have redirected the next optimisation effort onto the *smaller* of the two stages. The
implementation report's Part II is right to correct it, and right not to have optimised
`buildInstance` on the strength of it.

### Finding 3 (the `solve/` ownership guard) — **STALE, already fixed before this pass**

Part I reported that `phase0Scaffold.test.js` still treats `solve/` as a directory-wide ownership
prefix. I read the file: it does not. `PHASE_10_OWNED` lists `solve/` **file-by-file** — seven
files, named individually — with a comment explaining that a directory prefix would let a Phase 16
module land unremarked. There is also a planted-module test asserting that `solve/setPartitioning.js`,
`solve/branchAndBound.js` and `solve/localSearch.js` are refused, with a negative control asserting
`solve/costScaling.js` is admitted. Both pass. The residual risk Part I flagged is closed.

### Findings 1, 4 and 5 — **confirmed and unchanged**

Finding 1 (Goldberg–Tarjan rather than auction/JV): I agree this is not a conformance problem. The
frozen specification names cost-scaling push-relabel as an option; the blocker plan is a planning
document. Finding 4 (§20.1 not met): confirmed, and §6 below strengthens it. Finding 5
(`scale_targets` needs B1 routing too): confirmed; nothing in this pass touched routing.

---

## 6. §20.1 — I confirm **NOT PASSED**, and I would put the gap higher than "solver-only" framing does

My own measurement, bare process, 500 Legs x 200 candidates:

| stage | ms |
|---|---|
| `buildInstance` | 231 – 253 |
| `minCostFlow.solve` | 391 – 408 |
| **two stages only** | **622 – 661** |
| §20.1 whole-round target | **250** |

Two of the round's stages are **2.5x the whole round's budget**, before candidate generation,
feasibility, plan building, routing or commit are counted. I want the four quantities kept apart, as
the brief asks:

- **A. Solver alone** — 391–408 ms. Over the whole-round target by itself.
- **B. Solve + buildInstance** — 622–661 ms. 2.5x over.
- **C. Whole round** — **never measured**, here or in any Phase 10 document.
- **D. Representative production hardware** — **never measured**, and it is the only kind of run
  that can discharge the gate.

The improvement is real and large: SSP measures **23 455 ms** at the same shape on the same machine
(reproducing Part I's 23 536 ms), so the solver is **58.6x** faster and the exponent in Legs moved
from 2.067–2.134 to 1.03–1.30. The gap went from roughly 94x to roughly 2.6x. **That is progress,
not discharge.** No document should be read as turning `scale_targets` GREEN, and the implementation
report's Part II does not attempt to.

---

## 7. The scale-lane fix — I checked it is not a weakening

This is the change most at risk of being a gate-softening dressed as a fix, so I checked it
specifically.

- **The bound was not touched.** It is still `0.7 < exponent < 1.6`.
- **The grid stays inside the configured envelope.** 400 Legs is under `solve.max_legs_per_round`
  (500); 80 candidates is under `candidate.max_evaluated` (200).
- **The bound still separates the two regimes.** I measured successive shortest paths on the *new*
  grid myself: **exponent 2.134, r-squared 0.9996**. A revert to SSP would still be caught with
  large margin, as would any accidental quadratic.
- **The flakiness was real and is gone.** I ran the whole scale lane 5 times before (2 failures, at
  1.633 and 1.754) and 5 times after (5 passes, 1.032–1.104, r-squared >= 0.9975).
- **The diagnosis is right.** Running the same file *alone* before the fix gave 1.201–1.236 four
  times out of four, which rules out the solver having changed and points at the lane's earlier
  suites — exactly as the implementation report states.

A gate that fails 40 % of the time on correct code is not a gate; it is a test people re-run until
it passes, which the scale harness's own header warns against at length. I accept this fix.

---

## 8. Reservations, stated plainly

1. **The pre-`prepare()` zero-budget path still returns an allocation naming no Leg.** With
   `timeBudgetMs` below ~60 ms at 500 x 200, the round returns `assignments: []`, `deferred: []`,
   `unassigned: []` for 500 Legs. I accept the rationale for not fixing it here — the alternatives
   are doing ~100 ms of work a budget-exhausted round does not have, or fabricating a `deferred`
   decision the solver never made — and I confirm the information is recoverable
   (`augmentations: 0` against `network.requiredFlow: 500`, plus `budgetLimited: true`). But the
   `unassigned` list is empty where 500 Legs are in fact unassigned, and a consumer that reads it at
   face value is misled. **This should not be closed silently. It needs a result-shape change, and
   that is Phase 11's surface, not Phase 10's.**
2. **Stages C and D of §6 are unmeasured.** Until a whole round is measured at 500 x 200 on
   representative hardware, §20.1's status is "not passed and not fully characterised", not merely
   "not passed".
3. **I did not audit `locality.scale.test.js` or `overloadAndSoak.scale.test.js`**, only ran them.
   They pass.
4. **I did not verify anything requiring Redis, PostgreSQL, the frontend, or a live deployment.**
   Calibration, the shadow worker, multi-day soak, simulator fidelity and rollback rehearsal remain
   out of scope, as they were for Part I.

---

## 9. Summary for whoever reads only this section

Phase 10's cost-scaling solver does what §20.2 requires and proves it on every solve. I re-derived
its central mathematical argument and it holds; I checked it against 30 000 brute-force-enumerated
instances and it never differed; I confirmed its certificate can fail and does; I confirmed
production reaches it; I confirmed it is deterministic under byte equality. The reopened audit found
a genuine §9.4 anytime defect that two prior reviews missed, reproduced it deterministically, fixed
it for 3.5 ms of overshoot, and pinned it with tests — and separately diagnosed a release-lane gate
that was failing 40 % of the time on correct code, fixing the measurement rather than the bound.

It also corrected two findings in Part I of this document that would have misdirected the next
round of work: `buildInstance` is **not** the dominant stage in production, and the `solve/`
ownership guard was **already** hardened.

**§20.1 is NOT PASSED. `scale_targets` is NOT GREEN and cannot be from this workstream, because B1
routing shares that gate and was not touched. Phase 16 is not unblocked.** Treat this as a correct,
well-evidenced, now-more-honest Phase 10 deliverable, and nothing more than that.
