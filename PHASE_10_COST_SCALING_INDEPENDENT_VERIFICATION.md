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
