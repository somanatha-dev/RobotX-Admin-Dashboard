# Phase 10 — Remediation and Closure

**Scope.** The Cost-Scaling Solver (§9.3, §9.4, §9.6, §20.2) — `solve/costScaling.js`,
`solve/minCostFlow.js`, `solve/objective.js`, `solve/regime.js`, `solve/budgets.js`,
`solve/round.js`, and the one line of `workers/coordinator.worker.js` that feeds §9.4's budget.

**Date.** 2026-08-18.
**Machine.** Windows 11 laptop, Node v22.17.0, x64. **Not representative production hardware,
and not a shard.** Every number below carries that caveat.

**Predecessor documents (neither overwritten).**
`PHASE_10_COST_SCALING_IMPLEMENTATION_REPORT.md` (Parts I and II),
`PHASE_10_COST_SCALING_INDEPENDENT_VERIFICATION.md`.

---

## 1. Final Status

    PHASE 10 CLOSED

Closed on solver correctness, exactness, determinism, anytime semantics, verified production
dispatch, and Phase 10-owned performance. **Eight defects were found in this pass and all eight
are fixed, tested, and re-verified.**

Closed **does not** mean the following, and none of them is Phase 10's to deliver alone:

| | Status |
|---|---|
| §20.1 whole-round target | **NOT PASSED** (§8) |
| `scale_targets` release gate | **NOT PASSED** — two independent causes, one of which is B1 routing |
| Phase 16 | **NOT UNBLOCKED** — its prerequisite is Phase 15, which is incomplete |

---

## 2. Starting State

The latest engineering handoff reported 148 suites / 6 497 tests / 0 failures / 0 skips, 7/7
gates, 30 000 oracle instances with 0 mismatches, 292/300 differential allocations reproduced
exactly, cost scaling ~391–408 ms against SSP ~23 455 ms (58.6×), and §20.1 **not** passed.

**Every one of those was reproduced or re-measured here rather than carried forward.** Where this
machine disagrees, it is slower, and the disagreement is stated in §7.

The handoff left two items open and this pass disagrees with the disposition of one of them:

| Handoff item | Handoff's disposition | This pass |
|---|---|---|
| §II.10 #1 — a budget exhausted before `prepare()` returns an allocation naming no Leg | *"Unfixed, deliberately… the right owner is **Phase 11**"* | **Rejected. Phase 10 owns it and it is fixed here** — §4 D1 |
| §13 #4 — the budget-limited bound is reported as exact | *"raised here rather than made unilaterally"* | **Decided: made honest** — §4 D3 |

---

## 3. Issues Investigated

Every issue named by the brief, the handoff, or found in this pass, with its owner.

| # | Issue | Real defect? | Owner | Action |
|---|---|---|---|---|
| 1 | Budget exhausted before `prepare()` → allocation naming zero Legs, `ok: true`, `feasible: true` with deferral off | **Yes** | **Phase 10** | Fixed — D1 |
| 2 | Reference solver's budget-limited stop returns a partially routed batch; unrouted Legs appear in no list | **Yes** | **Phase 10** | Fixed — D2 |
| 3 | Budget-limited result publishes `bound = objective`, `gap = 0` — a proven optimum it did not prove | **Yes** | **Phase 10** | Fixed — D3 |
| 4 | Budget-limited result publishes its prices as `EXACT_INTEGER_MARGINAL_PRICE`, valid for §8.3.1 calibration | **Yes** | **Phase 10** | Fixed — D4 |
| 5 | `round.plan` offers each partition to `budgets.offer()` as a *competing* solution; incumbent = cheapest partition | **Yes** | **Phase 10** | Fixed — D5 |
| 6 | Every unassigned Leg labelled `LOST_TO_ANOTHER_LEG`, including Legs the solve never priced | **Yes** | **Phase 10** | Fixed — D6 |
| 7 | `certify()`'s stated capacity condition was argued, not computed | **Yes** | **Phase 10** | Fixed — D7 |
| 8 | Round's §9.4 budget measured as `Date.now() − decisionTimeMs` — two different clocks | **Yes** | Phase 9 file, **Phase 10 contract** | Fixed — D8 (§13) |
| 9 | Round result drops `solver` / `optimalityCertified`, so a production fallback is invisible | **Yes**, observability | **Phase 10** | Fixed with D8's test |
| 10 | §20.1 whole-round 250 ms not met | Not a defect — a target | Phase 15 + architecture (**OAD-2**) | Measured, **NOT PASSED** (§8) |
| 11 | `buildInstance` is a large minority of build+solve; canonical sort ~40 % of it | Not a defect | Phase 10 | Measured, no change justified (§7.4) |
| 12 | ε-scaling factor α = 2 | Not a defect | Phase 10 | Swept α ∈ {2,3,4,8,16,32}; **keeping 2** (§7.3) |
| 13 | Scale-lane exponent gate was flaky; floor raised 20 → 80 candidates | Already fixed | Phase 10 | Re-verified 11/11 (§9) |
| 14 | 8 of 300 differential instances pick a different member of a tied optimum | Not a defect | — | Confirmed; §15 of the brief permits it |
| 15 | Reference solver reachable in production on the exactness-fallback path | Not a defect | Phase 10 | Now *observable* — issue 9 |
| 16 | Money lower bound is trivially 0 when deferral is disabled | Not a defect | Formulation | Documented (§5, §12) |
| 17 | Relabel guard is a bound on a defect, not on an instance | Not a defect | Phase 10 | Unchanged; never tripped |

---

## 4. Defects Found

### D1 — a budget exhausted before `prepare()` returned an allocation naming no Leg

- **Severity** High. Silent, and shaped exactly like a legitimate outcome.
- **Reproduction.** `tools/verify/phase10Profile.js budgets 500 200`. Before the fix, every
  budget ≤ 100 ms (deferral off) / ≤ 75 ms (deferral on) produced:

  ```
  budget  elapsed  phases  assigned deferred queued  TOTAL   ok    feasible  objective  certified
       0       98       0         0        0      0   0/500  true      true          0      false
      50       88       0         0        0      0   0/500  true      true          0      false
     100      135       0         0        0      0   0/500  true      true          0      false
  ```

- **Root cause.** `solveByCostScaling` consults the budget once *before* `prepare()` — correctly,
  because collapsing a 100 000-column network is tens of milliseconds a spent round should not
  spend. That branch returned `assemble(network, () => 0, …)`: the **zero** flow. `assemble()`
  reads the allocation off the arcs carrying flow, finds none, and reports assigned, deferred and
  queued all empty for a batch of 500 — with `ok: true`. With the `deferral` kill switch thrown a
  coverage row reads `≤ 1`, which zero satisfies, so `objective.validate()` called it **feasible**.
- **Why previous tests missed it.** The suite's `assertSolutionInvariants` does check that every
  Leg is accounted for exactly once — and was never applied to this path. The one test that
  covered it (`"an exhausted budget returns the incumbent"`) asserted `Array.isArray(assignments)`,
  which an empty array satisfies.
- **Why the handoff's Phase 11 attribution is wrong.** It considered two remedies — spending
  ~100 ms on `prepare()`, or "fabricating a decision" — judged both worse, and handed the result
  shape to Phase 11. There is a third: the **trivial feasible flow**. Every Leg carries an arc
  straight to the sink (its `y[l]`, or the remain-queued arc that replaces it), so sending one
  unit `S → l → T` for every Leg is a feasible flow on *any* network this module builds — it meets
  every coverage row with equality and consumes no agent's exclusivity row. It is one pass over the
  arcs, it needs no `prepare()`, it invents no field, and it is not a fabrication: it is verbatim
  the incumbent `budgets.emptyIncumbent()` has always *described* — *"no Leg assigned. Feasible by
  construction: every Leg remains queued… this is the one it holds before it has found a better
  one"* — computed instead of described. **No Phase 11 contract change is required, and
  `decidedNothingBecause` is not needed.**
- **Fix.** `minCostFlow.completeToFeasibleFlow()`, used on that branch.
- **Regression test.** `solveCostScaling.test.js` — *"a budget already exhausted BEFORE the network
  is collapsed returns the trivial feasible flow, not an empty one"*, both switch states, asserting
  the full `assertSolutionInvariants` battery.

### D2 — the reference solver's budget-limited stop lost Legs

- **Severity** High. Reachable in production: cost scaling hands instances whose costs exceed the
  exact-integer range to the reference solver, which then runs under the same budget.
- **Reproduction.** Budget expiring after *n* augmentations, 20 Legs:
  `n = 0 → 0/20 Legs named; n = 1 → 1/20; n = 3 → 3/20; n = 10 → 10/20` — all with `ok: true`,
  and `feasible: true` with deferral off.
- **Root cause.** SSP augments once per Leg. Stopping between augmentations leaves an *integral*
  flow, which the comment correctly claimed — but not a *complete* one: Legs the loop had not
  reached carry no flow on any arc and so appear in none of `assignments`, `deferred`, `unassigned`.
- **Fix.** The same trivial completion, applied to the Legs the search never reached; every unit the
  search did place is left exactly where it placed it.
- **Regression test.** *"the reference solver's budget-limited stop is completed too"* — asserts
  `assigned === passes` as well as `accounted === 5`, so completion cannot silently re-decide.

### D3 — a budget-limited result reported its incumbent as proven optimal

- **Severity** High.
- **Reproduction.** 500 × 200, 250 ms budget, deferral off: objective **6 825 000** milli-CU
  published with `boundMilliCU: 6 825 000` and `lpIpGapMilliCU: 0`, against a true optimum of
  **5 000 000** — a 36.5 % error published as a zero gap, in the same object as
  `optimalityCertified: false`.
- **Root cause.** `assemble()` computed `boundMilliCU = objectiveMilliCU` unconditionally. On a
  completed singleton solve that is correct and earned — §9.3's total unimodularity makes the LP
  relaxation integral. On a truncated one it asserts a proof the run explicitly declined to make.
- **Fix.** On a budget-limited result the bound becomes a real one:
  `relaxedMoneyLowerBound()` — drop the exclusivity rows and let every Leg take its cheapest arc.
  Every feasible flow routes exactly one unit out of each Leg node, so its money cost is a sum of
  one arc price per Leg, each at least that Leg's minimum. Valid for every feasible flow, hence for
  the optimum. `lpIpGapMilliCU` stays exactly zero, because the *integrality* gap is zero in this
  regime whatever the clock did; the truncation gap is `objective − bound`, a different quantity,
  and §9.3 requires distinct approximations be reported separately rather than summed.
- **Regression test.** *"§9.4's bound is a bound"* — asserts `bound ≤ objective`, `bound ≤` the
  completed solve's objective, and that a completed solve still reports `bound === objective`.

### D4 — a budget-limited result published its prices as exact marginal prices

- **Severity** High. Live consumer: §8.3.1 feeds singleton-regime duals into λ_zone calibration and
  reads `validForCalibrationWithoutQualification` to decide whether it may.
- **Root cause.** `regime.dualsFor()` labels by *regime alone*. The regime is not the only axis that
  can void a dual claim: a singleton round is **entitled** to exact integer duals, and a singleton
  round that ran out of time did not **earn** them. Cost scaling publishes `approximatePrices` there
  (ε-optimal, `O(n)`, and its own header says they are not exact) and the reference solver publishes
  potentials of a partially routed network. Both were labelled `EXACT_INTEGER_MARGINAL_PRICE` with
  `validForCalibrationWithoutQualification: true`. The solver's header argues that
  `optimalityCertified: false` protects downstream — but the duals object itself says otherwise, and
  a consumer reading the field designed for exactly this question has no reason to look further.
- **Fix.** `DUAL_KIND.BUDGET_LIMITED` (`EPSILON_OPTIMAL_UNPROVEN_PRICE`), and `dualsFor()` takes an
  explicit `{ proven }` defaulting to the regime's entitlement, so no existing call site changes
  meaning. This uses `regime.js`'s labelling mechanism as designed rather than inventing a field.
- **Regression test.** *"a budget-limited round does not publish its prices as exact marginal prices
  either"* — all three stopping points, both solvers, plus the completed solve as the control.

### D5 — the round's incumbent was the cheapest partition, not the round

- **Severity** Medium-High. Live whenever the feasibility graph is disconnected — the ordinary case
  for a shard with spatially separated clusters.
- **Reproduction.** Three Legs with disjoint agent sets at 10 / 20 / 30 CU:
  `budgets.incumbent` held **one** assignment and an objective of 10 CU for a round that assigned
  three Legs at 60 CU.
- **Root cause.** `round.plan` called `budgets.offer()` once per partition. `offer()` accepts a
  solution only while it improves the objective — right for competing solutions to one problem,
  wrong for disjoint sub-problems whose allocations *compose*.
- **Consumers.** `observability/shadow.js` compares `budgets.incumbent.objectiveMilliCU` between the
  production and shadow rounds; `workers/counterfactual.worker.js` reads it as the round's realised
  objective (§21.6). Neither can detect an under-reported total.
- **Fix.** One offer, after the loop, of the union with the summed objective and summed bound.
- **Regression test.** `solveRound.test.js` — *"the round's incumbent is the UNION of its
  partitions, not the cheapest of them"*.

### D6 — a Leg the clock stopped was recorded as having lost a competition

- **Severity** Medium. It puts a false causal claim into the per-Leg decision record, which is what
  §17.4's anti-starvation ladder reads.
- **Root cause.** Any Leg neither assigned nor deferred fell through to `LOST_TO_ANOTHER_LEG` with
  the detail *"every agent that could serve this Leg was allocated to a Leg the objective priced
  more cheaply"*. After a budget-limited solve — at a zero budget, one that priced nothing at all —
  no such competition happened. `LEG_OUTCOME.BUDGET_TRUNCATED` already existed and is the honest label.
- **Fix.** Legs in a partition whose solve was budget-limited resolve to `BUDGET_TRUNCATED`.
- **Regression test.** *"a Leg the clock stopped is recorded as BUDGET_TRUNCATED"* — asserts the
  detail no longer contains the causal claim.

### D7 — the certificate's stated capacity condition was never computed

- **Severity** Low, but it is load-bearing by design.
- **Root cause.** The module header states condition 1 as *"the flow is feasible — every node's
  excess is zero **and every arc is within capacity**"*. Only the excess half was computed; the
  capacity half was argued from the push and relabel invariants — precisely the kind of argument
  the certificate exists so that nothing has to rely on.
- **Fix.** `prepare()` retains the capacities; `certify()` checks `residual ≥ 0` on both directions
  and `residual + residual(reverse) === capacity + capacity(reverse)` for every pair — the arc-pair
  identity that is invariant under push and relabel, so a violation means flow was created or
  destroyed rather than moved. Cost: **+1.5 ms** on a ~510 ms solve.
- **Regression test.** *"the certificate's OTHER condition is capacity, and it fails on a flow that
  exceeds one"* — certifies a good flow, breaks one arc, and requires the certificate to fail.

### D8 — the round's §9.4 budget was measured across two different clocks

- **Severity** High, latent. **Found by the new production-dispatch test failing**, not by reading.
- **Root cause.** `coordinator.worker.js` computed `elapsedMs = Date.now() − decisionTimeMs`.
  `decisionTimeMs` is an **input** (§9.6 requirement 4), and a caller that pins it pins it to the
  **store's** clock, which §10.6 makes the authority for anything durable. The subtraction therefore
  charges the store-vs-local clock skew to §9.4's solve budget. The coordinator's own config carries
  `maxClockSkewMillis: 1000` — a skew four times the entire 250 ms `solve.time_budget` is *within
  specification*, and would exhaust the budget before the first candidate is expanded. The round
  then returns its trivial incumbent, assigning nothing, on a shard whose only fault is a clock a
  second out. Before D1's fix it returned an allocation naming no Leg at all.
- **Why it was invisible.** The failure produces a complete, feasible, correctly-labelled
  budget-limited round — indistinguishable from a genuinely slow one.
- **Fix.** `const startedAtMs = Date.now();`. Two clocks, two jobs: the store's instant decides what
  the round *sees* (pinned, recorded, replayed); the local clock measures how long the round has
  *taken*. The read is in the worker, outside the decision path, exactly as before.
- **Ownership.** The file is Phase 9's; the contract is §9.4's, which is Phase 10's. Phase 10 cannot
  honour its anytime budget through the only round entry point that exists if that budget is fed a
  clock difference. Fixed here, recorded as a boundary crossing in §13.
- **Regression test.** `coordinatorRound.test.js`, asserted against the source because the failure
  mode is silent by construction.

---

## 5. Anytime Correctness — the budget matrix

`node tools/verify/phase10Profile.js budgets 500 200`, real clock, bare process, 500 Legs × 200
candidates × 100 000 columns. **Every row after the fixes:**

**Deferral DISABLED** (coverage reads `≤ 1` — the sense that hid the defect)

| budget | elapsed | over | phases | assigned | deferred | queued | accounted | ok | feasible | objective consistent | objective | bound | certified |
|---:|---:|---:|---:|---:|---:|---:|---:|---|---|---|---:|---:|---|
| 0 | 97 | +97 | 0 | 0 | 0 | 500 | **500/500** | true | true | true | 0 | 0 | false |
| 1 | 127 | +126 | 0 | 0 | 0 | 500 | **500/500** | true | true | true | 0 | 0 | false |
| 5 | 91 | +86 | 0 | 0 | 0 | 500 | **500/500** | true | true | true | 0 | 0 | false |
| 10 | 76 | +66 | 0 | 0 | 0 | 500 | **500/500** | true | true | true | 0 | 0 | false |
| 25 | 69 | +44 | 0 | 0 | 0 | 500 | **500/500** | true | true | true | 0 | 0 | false |
| 50 | 72 | +22 | 0 | 0 | 0 | 500 | **500/500** | true | true | true | 0 | 0 | false |
| 75 | 148 | +73 | 1 | 451 | 0 | 49 | **500/500** | true | true | true | 4 510 000 | 0 | false |
| 100 | 159 | +59 | 0 | 0 | 0 | 500 | **500/500** | true | true | true | 0 | 0 | false |
| 150 | 172 | +22 | 3 | 500 | 0 | 0 | **500/500** | true | true | true | 6 300 000 | 0 | false |
| 250 | 273 | +23 | 17 | 500 | 0 | 0 | **500/500** | true | true | true | 5 205 000 | 0 | false |
| ∞ | 601 | — | 40 | 500 | 0 | 0 | **500/500** | true | true | true | **5 000 000** | 5 000 000 | **true** |

**Deferral ENABLED** (coverage is an equality — the sense that *reported* the defect as infeasible)

| budget | elapsed | over | phases | assigned | deferred | queued | accounted | ok | feasible | objective | bound | certified |
|---:|---:|---:|---:|---:|---:|---:|---:|---|---|---:|---:|---|
| 0 | 84 | +84 | 0 | 0 | 500 | 0 | **500/500** | true | true | 50 000 000 | 5 000 000 | false |
| 5 | 76 | +71 | 0 | 0 | 500 | 0 | **500/500** | true | true | 50 000 000 | 5 000 000 | false |
| 25 | 109 | +84 | 0 | 0 | 500 | 0 | **500/500** | true | true | 50 000 000 | 5 000 000 | false |
| 50 | 75 | +25 | 0 | 0 | 500 | 0 | **500/500** | true | true | 50 000 000 | 5 000 000 | false |
| 75 | 163 | +88 | 1 | 451 | 49 | 0 | **500/500** | true | true | 9 410 000 | 5 000 000 | false |
| 100 | 152 | +52 | 0 | 0 | 500 | 0 | **500/500** | true | true | 50 000 000 | 5 000 000 | false |
| 150 | 164 | +14 | 3 | 500 | 0 | 0 | **500/500** | true | true | 5 607 000 | 5 000 000 | false |
| 250 | 263 | +13 | 23 | 500 | 0 | 0 | **500/500** | true | true | 5 000 000 | 5 000 000 | false |
| ∞ | 296 | — | 28 | 500 | 0 | 0 | **500/500** | true | true | **5 000 000** | 5 000 000 | **true** |

**Before this pass the first six rows of each table read `0/500`.**

Properties now holding at every budget, both switch states:

- every Leg accounted for exactly once — assigned, deferred, or queued;
- `objective.validate()` feasible — under **both** coverage senses, not just the equality one;
- `assertObjectiveIsAllocationCost()` exact;
- `bound ≤ objective`, and a bound that is valid for every feasible flow;
- `optimalityCertified: true` **only** on the completed solve;
- duals labelled `EPSILON_OPTIMAL_UNPROVEN_PRICE` and not calibratable on every truncated row.

**Overshoot.** Below the first scaling phase the round exits in `solveByCostScaling` and the elapsed
time is `buildNetwork` plus the trivial completion — 69–159 ms, which is the cost of having built
the network at all. Above it, overshoot is one scaling phase: **+13 to +23 ms against a 250 ms
budget**, 5–9 %.

**On the bound of 0 with deferral disabled.** With the switch thrown, a Leg's alternative to
assignment is the remain-queued arc priced `(1, 0)` — one unit of assignment *priority* and **zero
money**. Zero is therefore a genuinely valid lower bound on the money objective. A tighter bound
would have to bound the lexicographic pair rather than its money component, and `boundMilliCU` is a
money field (§1.3: publishing the priority component as a price would be a dimensioned quantity
fabricated from an ordering). Weak, valid, and honest — where the previous value was precise and
false.

---

## 6. Solver Correctness

### 6.1 Independent brute-force oracle — 30 000 instances, 0 mismatches

`node tools/verify/phase10Oracle.js oracle 30000`. A **third** enumeration of §1.4's objective,
written from the specification, sharing no code with either solver or with the repository's own
8 000-instance oracle test. Instances are driven through `minCostFlow.solve()` with **no `solver`
option** — the production dispatch, not a named algorithm.

Each instance checks seven things at once: queued count, exact objective in milli-CU, coverage and
exclusivity feasibility, objective-equals-allocation-cost, every-Leg-accounted-for,
`solver === COST_SCALING`, and `optimalityCertified === true`.

Coverage: 1–6 Legs, 1–6 agents, dense and sparse graphs, and five cost regimes — all-positive,
all-negative, mixed-sign, tie-heavy (four distinct prices, so ties are common), and all-zero — with
priced deferral on one instance in three.

    30000 instances (0 unbuildable) — mismatches: 0

Run twice, before and after the final code change. The repository's own oracle (8 000 instances,
`engine` lane) passes as part of §11.

### 6.2 Differential against the reference solver

| shape | columns | cost scaling | SSP | speed-up | objectives equal |
|---|---:|---:|---:|---:|---|
| 100 × 200 | 20 000 | 116.4 ms | 895.2 ms | **7.7×** | **true** |
| 250 × 200 | 50 000 | 242.4 ms | 7 102.8 ms | **29.3×** | **true** |
| 500 × 200 | 100 000 | 487.3 ms | 29 626.8 ms | **60.8×** | **true** |

Plus the suite's 300-instance and 30-instance generated sweeps. The 8 instances that select a
different member of a tied optimal set are unchanged and are not a defect: objective, flow value,
feasibility and all three counts agree, and no specification names one member of a tied optimum.

### 6.3 The certificate can fail

Two tests, both required to fail the certificate:

- a hand-built **suboptimal** flow (routes L1→A1 and L2→A2 at 110 against an optimum of 50) —
  fails on dual feasibility;
- a flow with one arc's capacity **broken** — fails on the capacity condition added in D7.

### 6.4 Exact scalarisation, re-derived and stressed at the boundary

`prepare()` collapses `(unassigned, milliCU)` to `w = unassigned · K + milliCU` with
`K = 1 + 2 · n · max|milliCU|`, `n = nodeCount`.

**Re-derivation.** Any simple path or cycle in this network has at most `n` arcs, so
`|Σ milliCU| ≤ n · max|milliCU| = K/2 − ½ < K/2` along anything the algorithm ever compares. A
one-unit difference in the `unassigned` component therefore moves `w` by `K`, which strictly exceeds
the largest money difference `K/2 − ½` that could oppose it. The collapse is order-**identical** to
the lexicographic pair, not an approximation of it. (The bound is loose: money-carrying arcs leave
distinct Leg nodes, so `|L| < n` would also serve. Loose in the safe direction, and left alone.)

**Overflow.** Three checks in BigInt before any float appears — `n · max|milliCU|`, `K`, and the
largest scaled cost with an 8× headroom margin — then a runtime price bound in `run()` that aborts
to the exact fallback if a price would leave the exactly-representable range.

**Stressed** (`phase10Oracle.js scalarisation`), against the all-BigInt reference solver as arbiter:

| max\|γ\| milli-CU | K | prepare refuses? | agrees with exact reference | solver used |
|---:|---:|---|---|---|
| 10³ … 10¹² | 1.2×10⁴ … 1.2×10¹³ | no | **true** | COST_SCALING |
| 10¹³ | 1.2×10¹⁴ | no | **true** | SUCCESSIVE_SHORTEST_PATH *(declined later, fell back)* |
| 10¹⁴ … 10¹⁸ | — | **yes** | **true** | SUCCESSIVE_SHORTEST_PATH |

**The property is "exact or refuse", and it holds at every magnitude tested.** No wrong answer at
any width. Priority dominance re-checked separately: an assignment at γ = 10¹³ milli-CU still beats
leaving a Leg queued, which is what `K` buys.

### 6.5 Determinism

- Suite: ten runs byte-identical in allocation, objective and duals; a rebuilt instance solves
  identically; column arrival order does not reach the solver.
- **New, at §20.1's own shape:** `phase10Profile.js determinism 500 200 10` — 10 runs, instance
  **rebuilt each time**, comparing a canonical-JSON digest over allocation, objective, bound, LP–IP
  gap, Leg duals, agent duals, solver diagnostics and the certificate flag.
  **Byte-identical across 10 runs (27 213-character digest).** This covers `buildInstance`'s
  ordering too, and at a scale where an unstable sort or a rehashing Map would show.

### 6.6 Fallback, and verified production dispatch

Refusal paths exercised: `MONEY_TOO_WIDE`, `COLLAPSE_TOO_WIDE`, `SCALED_COST_TOO_WIDE`,
post-`prepare` decline, certificate failure, multi-Leg column (refused identically by both solvers),
and the `STUCK` / `OVERFLOW` / `RELABEL_LIMIT` outcomes. Every refusal reaches the exact reference
solver and returns a correct answer; none returns a fast wrong one.

**Production dispatch, proven by execution** — new in this pass. `coordinatorRound.test.js` runs
`coordinator.runRound()` end to end: real leadership check, real batch claim, real
`columnBuilder.build()` pricing through the real `Φ`, real `objective.buildInstance()`, real
`minCostFlow.solve()`. Nothing about the solve is stubbed. It asserts that **every partition**
reports `solver: COST_SCALING`, `optimalityCertified: true`, `fallbackFrom: null`,
`budgetLimited: false`, and that the round actually assigned something.

Before this pass the only assertions that cost scaling is the decision path called
`minCostFlow.solve()` directly, which tests the dispatch inside that module and not that a round
ever reaches it — and the round dropped `solver` from its report, so a production fallback to the
30-second reference solve would have been invisible. That is issue 9, fixed with this test.

---

## 7. Performance

All figures: bare `node` process, 500 Legs × 200 candidates, 100 000 columns, 9 repetitions after
one warm-up, `tools/verify/phase10Profile.js stages 500 200 9`.

### 7.1 Stage profile, after the fixes

| stage | min | median | p95 |
|---|---:|---:|---:|
| `objective.buildInstance` | 282.4 | **308.7** | 373.8 |
| `minCostFlow.buildNetwork` | 60.1 | 70.4 | 156.1 |
| `costScaling.prepare` (collapse + flatten) | 55.0 | 62.5 | 80.8 |
| `costScaling.run` (the ε-scaling loop) | 323.3 | **411.8** | 545.0 |
| `costScaling.certify` | 4.8 | 6.0 | 23.5 |
| **`minCostFlow.solve` (whole)** | **475.1** | **511.4** | 685.8 |
| **`buildInstance` + `solve`** | | **820.2** | |

Shares: ε-loop **80.5 %** of the solve; certificate **1.2 %**; `buildInstance` **37.6 %** of the two
stages. The handoff's profile (72 % / 2.5 % / 34.8–36.9 %) **reproduces**. Its absolute numbers do
not: this machine measures the solve 25–30 % slower today (511 ms median against 391–408 ms). The
shape of the profile, not its absolute values, is what the optimisation decision rests on.

Cost of the D7 certificate fix: 4.5 → 6.0 ms median, **+1.5 ms on a 511 ms solve**.

### 7.2 Jest is not a measurement environment, re-confirmed

Same code, same shape, same machine, `scale` lane: solve **558 ms**, `buildInstance` **965 ms** —
against 511 ms and 309 ms bare. `buildInstance` is inflated **3.1×** and the solve **1.1×**, which
reproduces the handoff's explanation (allocation-heavy work is far more sensitive to a test runner's
module registry and collector pressure than a tight numeric loop over pre-sized typed arrays).
**Every performance number in this document is a bare-process number.**

### 7.3 The ε-scaling factor — swept, and deliberately not changed

`SCALING_ALPHA` is a schedule parameter, not the algorithm: `refine()` saturates every
negative-reduced-cost arc at the start of each phase, making the pseudoflow 0-optimal and therefore
ε-optimal for *any* ε, so correctness is independent of α and the loop still terminates at ε = 1.
It is therefore a legitimate lever, and it was measured — one process per α, so eight copies of
`discharge()` could not make each other megamorphic:

| α | phases | relabels | pushes | `run` min | `run` median |
|---:|---:|---:|---:|---:|---:|
| **2** | 40 | **132 666** | 376 535 | 506.3 | 918.6 |
| 3 | 26 | 117 885 | 325 945 | 402.7 | 667.9 |
| 4 | 21 | 128 693 | 314 296 | 445.6 | 776.4 |
| 8 | 14 | 198 770 | 397 459 | 1 067.2 | 1 217.7 |
| 16 | 11 | 256 537 | 509 779 | 1 463.4 | 2 436.9 |
| 32 | 9 | 405 911 | 835 498 | — | 2 688.4 |

(The dynamic module load costs ~1.5–2× against the require-loaded profiler, uniformly across α; the
relabel and push counts are deterministic and harness-independent.)

**Decision: keep α = 2.** α = 3 does 11 % fewer relabels and 13 % fewer pushes — real, deterministic,
and small. It would buy roughly 40 ms on a 511 ms solve against a target 3.3× away, it changes no
verdict, and it trades the textbook constant for which the `O(log(n · C))` phase count is stated for
a constant-factor gain this machine cannot resolve from noise. α ≥ 8 is clearly worse, exactly as
the Goldberg–Tarjan bound predicts: fewer phases, proportionally more relabels in each.

### 7.4 Two further optimisations measured and rejected

| candidate | measured | decision |
|---|---|---|
| Inline `compareColumnsForSolve` instead of composing `thenBy(compareMilliCU, compareStrings, compareStrings)` | 140.0 → 99.4 ms median on the 100 000-column sort; **output order verified identical** | **Rejected.** −29 % on the sort is +4 % on build+solve, and it duplicates the canonical order outside the `determinism/ordering` primitives — the §9.6 discipline that a comparator is *built from* the shared primitives so a divergence is visible rather than silent. Bad trade in a Tier 1 module where that discipline is the product. |
| Replace `prepare()`'s per-arc BigInt collapse with Number arithmetic guarded by an analytic worst-case bound | BigInt collapse loop is 31–71 ms of `prepare`'s 95–131 ms; the typed-array fill it would become is ~5 ms | **Rejected.** ~5 % of build+solve, and the brief is explicit: *"Do not replace exact arithmetic with Number."* The current argument — compute in BigInt, then check it fits — is the one a reader can verify in one pass. |

### 7.5 The one large lever, and why it is not the algorithm's

The scaling loop runs **40 phases with deferral disabled and 28 with it enabled**, at the same shape.
The difference is the collapse constant: with the switch thrown, remain-queued arcs cost `(1, 0)`,
whose collapsed magnitude is `K · scale ≈ 1.05 × 10¹¹`, while every priced arc is ~10³ times
smaller. Twelve of the forty phases — roughly 30 % of the ε-loop, ~120 ms — exist only to scale ε
down through the range the *priority* component occupies.

That is a property of the **lexicographic formulation**, not of the algorithm, and reducing it means
changing how §22.5 rule 1's priority is represented — which is §9.3's and §1.3's, not Phase 10's to
re-decide. Recorded here as the largest identified lever so the next measurement starts from it.

### 7.6 Memory

`--expose-gc`, forced collection between solves, instance retained throughout:

| | value |
|---|---|
| RSS with the instance built | 117.7 MB |
| retained heap after solve 1 → 5 | 31.7, 33.8, 31.8, 31.8, **31.8 MB** |
| RSS after solve 5 | 130.8 MB |
| peak RSS | 158.5 MB |

**No leak.** Retained heap is flat from the second solve; the allocation is `O(|V| + |E|)` typed
arrays sized once per solve and released with it.

---

## 8. §20.1 Status

    NOT PASSED

**The target, read from the frozen specification.** §20.1's table:
*"Round wall-clock (500 Legs × 200 candidates) | < 250 ms | Keeps the batch window meaningful"*,
stated **per shard, at the 99th percentile, under nominal operation**, and *"requirements for the
release gate, not aspirations"*. It is a **whole-round** target: §3.4's round path is collect the
batch, discover candidates, evaluate feasibility, evaluate cost, solve, commit, dispatch, record.

**The evidence.** On this machine, at exactly that shape, counting **two** of those stages:

| | ms (median) |
|---|---:|
| `objective.buildInstance` | 308.7 |
| `minCostFlow.solve` (cost scaling, certified optimal) | 511.4 |
| **two stages alone** | **820.2** |
| §20.1 target for the **whole round** | **250** |

Two stages are **3.3× the whole round's budget** before candidate generation, feasibility, routing
or commit are counted at all, and at p50 rather than the p99 the target names. Since the whole is at
least the sum of its parts, no further measurement can rescue the verdict *on this machine*.

**Four quantities, kept apart:**

| | value | status |
|---|---|---|
| A. solver alone | 475–686 ms | 1.9–2.7× the whole-round target on its own |
| B. solver + `buildInstance` | 820 ms median | **3.3× over** |
| C. whole round | **not measured** | the remaining stages are not instrumented; routing is not implemented (B1) |
| D. representative production hardware, p99 | **never measured** | the only kind of run that can *discharge* §20.1 |

**Two separate facts, and both belong in the record:**

1. **NOT PASSED on the available evidence** — measured, reproducible, and not close.
2. **NOT DISCHARGEABLE from any measurement here** — C and D are unmeasured, and more fundamentally
   `ARCHITECTURE.md` §8.1 records consolidated finding **N19 / OAD-2**: *"§20.1's per-unit budgets
   do not compose into its round budget under any rule the frozen architecture states… there is no
   stated aggregation rule and no intra-round concurrency model. `scale_targets` therefore has no
   arithmetically defined target."* `solve.time_budget` (250 ms) **equals**
   `perf.round_wall_clock_p99` (250 ms) exactly, so a round that spends its entire permitted solve
   budget has by construction consumed the whole round's wall clock. That is an **open architectural
   decision owned by the architecture authority**, not a Phase 10 defect, and it is answerable now.

**What did change.** Against the same shape on the same machine, the gap moved from ~94× (SSP,
23 455 ms) to 3.3× on the two measured stages, at 60.8× on the solve. That is a large, real
improvement and **it is not gate discharge.**

No language in this document says "effectively passed", "solver passes", or "close enough". The
budget was not widened, `solve.time_budget`'s registered default is untouched, no threshold moved,
and no stage was hidden.

---

## 9. Scale Gate

`npx jest --selectProjects scale`, run **11 times** on the final code:

    11 / 11 PASS — 3 suites, 23 tests, every run

Exponents from a verbose run:

| fit | measured | r² | bound | verdict |
|---|---:|---:|---|---|
| singleton solve, exponent in **Legs** | **1.094** | 0.9988 | `0.7 < e < 1.6` | PASS — the cost-scaling regime; SSP measures 2.13 on the same grid |
| singleton solve, exponent in **candidates** | **0.706** | 0.9714 | `0.3 < e < 1.3` | PASS |
| `buildInstance`, exponent in Legs | **1.063** | 0.9998 | `e < 1.4` | PASS — linear, as grouping the columns bought |

**Methodology of the earlier flakiness fix, audited.** The previous pass raised
`BATCH_FIT_CANDIDATES` from 20 to 80 rather than loosening the bound, because the fit's smallest
point (50 Legs × 20 candidates ≈ 3 ms) was being dominated by a single collection pause. This is the
correct direction and I confirm it: the **bound was not touched** (still 1.6), 400 Legs stays inside
`solve.max_legs_per_round` (500), 80 candidates stays inside `candidate.max_evaluated` (200) and is
nearer §20.1's own 200 than 20 was, and the bound still separates the two regimes it was chosen to
separate — SSP measures 2.134 (r² 0.9996) on the same grid. Raising the measurement floor is not
weakening a gate; lowering the bound would have been. 11/11 across the whole lane, with r² ≥ 0.97,
is the evidence that the fix took.

---

## 10. Architecture Gates

`npm run gates` — **7 / 7 PASS**, run twice (before and after the final change):

| gate | result |
|---|---|
| `gate:tiers` | PASS — 277 modules, 388 governed import edges, no Tier 0/1 → Tier 2 dependency |
| `gate:params` | PASS — 183 engine modules against 242 registered parameters; no bare behavioural constants |
| `gate:tenets` | PASS — 274 modules, T1 type separation and T6 decision-path determinism |
| `gate:privacy` | PASS — 16 modules in cost and decision-record scopes hold no identifying field |
| `gate:erasure` | PASS — 3 corpus decisions reconstructed byte for byte from Tier A alone |
| `gate:legacy` | PASS — 4 retired modules absent and unimported across 317 files |
| `gate:columngen` | PASS — `NOT_REQUIRED`; no column-generation module and neither budget parameter changed |

`gate:params` passing matters here specifically: every constant added in this pass
(`DUAL_KIND.BUDGET_LIMITED`, the trivial-completion diagnostics) is structural or a label, not a
behavioural threshold, and the gate confirms none of them is an unregistered number deciding
behaviour (§1.3).

---

## 11. Test Results

`npm test` — all five projects, final code:

    Test Suites: 148 passed, 148 total
    Tests:       6507 passed, 6507 total
    Snapshots:   0 total
    Failures:    0
    Skips:       0

| lane | suites | tests |
|---|---:|---:|
| engine | 118 | 6 214 |
| gates | 7 | 100 |
| legacy | 17 | 126 |
| chaos | 3 | 44 |
| scale | 3 | 23 |
| **total** | **148** | **6 507** |

**+10 tests against the handoff's 6 497.** No test was weakened, skipped, deleted, or made less
strict; no bound was moved; no gate was modified. The ten additions are the regression tests named
in §4, plus the production-dispatch integration test in §6.6.

Verification artefacts outside the suite, all re-runnable:

| command | result |
|---|---|
| `node tools/verify/phase10Oracle.js oracle 30000` | 30 000 instances, **0 mismatches** |
| `node tools/verify/phase10Oracle.js scalarisation` | exact or refuses at every magnitude; agrees with the exact reference at all 10 |
| `node tools/verify/phase10Profile.js budgets 500 200` | 22 budget rows, **500/500 Legs accounted in every one** |
| `node tools/verify/phase10Profile.js determinism 500 200 10` | byte-identical, 10/10 |
| `node tools/verify/phase10Profile.js stages 500 200 9` | §7.1 |
| `node tools/verify/phase10Profile.js tiers 3` | §6.2 |
| `node --expose-gc tools/verify/phase10Profile.js memory` | §7.6 |

---

## 12. Remaining Issues

### Phase 10 defects

**None.** All eight found in this pass are fixed, tested, and re-verified.

### Phase 11 ownership

| | Item |
|---|---|
| P11-1 | **`decidedNothingBecause` is no longer needed.** The handoff proposed it to close §II.10 #1. D1 closes that issue inside Phase 10 with no contract change, and the state is already distinguishable: `budgetLimited: true` + `solverDiagnostics.trivialIncumbent: true` + `scalingPhases: 0` + `legsDecidedByTrivialCompletion`, and `LEG_OUTCOME.BUDGET_TRUNCATED` per Leg. **This handoff is withdrawn**; Phase 11 should record the fields rather than invent one. |
| P11-2 | The §21.2 Tier A record should carry the partition's `solver`, `optimalityCertified` and `fallbackFrom` (now on the round result) so an exactness fallback in production is visible in the record, not only in the round object. |
| P11-3 | The decision record should carry the **truncation gap** (`objective − bound`) as a quantity distinct from `lpIpGapMilliCU`, which stays exactly zero in the singleton regime. Phase 10 publishes both inputs; naming the derived field is §21.2's. |
| P11-4 | `observability/shadow.js` and `workers/counterfactual.worker.js` read `budgets.incumbent.objectiveMilliCU`, which was under-reported before D5. Any comparison already recorded against the old behaviour is invalid and should be re-baselined. |

### Phase 15 ownership

| | Item |
|---|---|
| P15-1 | **Stages C and D of §8** — a whole-round measurement, and any measurement at all on representative production hardware at p99. Nothing here measures either. |
| P15-2 | **B1 routing.** §20.3 calls routing the dominant term and it was not touched, measured, or analysed. `scale_targets` names it as an independent cause alongside the solver algorithm. |
| P15-3 | The composition root (`ARCHITECTURE.md` §10 gap 1). The production-dispatch test in §6.6 composes the round through the coordinator inside a test; there is still no production composition root. |

### Phase 16 ownership

No column-regime solver, set partitioning, local search, or batch solver was written. `solve/`
contains exactly the same seven files it did before this pass. Phase 16's prerequisite is Phase 15.

### Specification / architecture

| | Item |
|---|---|
| A-1 | **OAD-2 / N19** — §20.1's per-unit budgets do not compose into its round budget; `solve.time_budget` equals `perf.round_wall_clock_p99` exactly. `scale_targets` has no arithmetically defined target until the architecture authority states an aggregation rule and an intra-round concurrency model. **Unchanged by this pass, and it blocks the gate independently of any code.** |
| A-2 | The money lower bound is trivially 0 when the `deferral` switch is thrown, because the remain-queued arc is priced `(1, 0)`. Valid and honest; a tighter bound requires bounding the lexicographic pair, which is a formulation question (§5). |

### Environmental limitations

| | Item |
|---|---|
| E-1 | All figures are from one Windows 11 laptop, single process, p50 (p95 where stated), not a shard, not production hardware. This machine measured the solve 25–30 % slower than the handoff's machine on identical code. |
| E-2 | Jest inflates `buildInstance` ~3.1× and the solve ~1.1×. Lane numbers and bare-process numbers are not comparable and are never mixed here. |
| E-3 | `overloadAndSoak.scale.test.js` and `locality.scale.test.js` pass in all 11 lane runs; their internals were not audited, as in the previous pass. |

---

## 13. Phase Boundary

**Deliberately not implemented:**

- **Phase 11** — no observability, calibration, shadow worker, `InputSnapshot`, `DecisionRecordB`,
  `CalibrationObservation`, `AuditEvent`, Explanation API, sampling, or degraded-mode work. The one
  change touching a Phase 11 *consumer* concern (D4's dual label) is made in `solve/regime.js`,
  which is Phase 10's module and whose entire stated purpose is to stop an out-of-regime guarantee
  reaching §8.3.1.
- **Phase 15** — no routing engine decision, **no B1 routing work of any kind**, no cutover, no
  engine enablement. `routing/` was not opened.
- **Phase 16** — no `setPartitioning.js`, no `branchAndBound.js`, no `localSearch.js`, no
  `batch.js`, no column-regime solver, no post-solve local search.
- **The network formulation is unchanged.** `buildNetwork()` has the same nodes, arcs, capacities
  and lexicographic pair costs; exclusivity is still `≤ 1` **per agent**.
- **The reference solver was not removed**, and `SCALING_ALPHA` was not changed (§7.3).

**One deliberate boundary crossing, stated plainly.** D8 modifies
`src/workers/coordinator.worker.js` — a Phase 9 file — by one line plus its comment. The subject is
§9.4's wall-clock budget, which is Phase 10's contract, and the coordinator is the only round entry
point that exists. Phase 10 cannot claim its anytime semantics hold in production while the budget
feeding them is a difference between two different clocks. It is a correctness fix to how a Phase 10
contract is fed, not a Phase 9 feature, and it is recorded here so the owning phase can review it.

---

## 14. Final Recommendation

**Close Phase 10.** The solver is exact, certified on every solve, deterministic at the full shape,
safe at every budget, verified against 30 000 independently enumerated optima through the production
dispatch, and proven — by execution, not by comment — to be the algorithm a real round reaches.

**Proceed to Phase 11**, with the four handoffs in §12 and with P11-1 *withdrawn*: the result-shape
change the previous pass handed forward is not needed, because the contract already had a way to say
what happened and the solver was simply not saying it.

**Do not read this document as** discharging `scale_targets`, passing §20.1, or unblocking Phase 16.

**The next measurement that would change the picture is not a solver measurement.** It is a
whole-round measurement at 500 × 200 on representative hardware — stages C and D — and it cannot be
taken before B1 routing exists, because §20.3 makes routing the dominant term. Before that
measurement is worth taking, the architecture authority should answer **OAD-2**: at present
`solve.time_budget` equals `perf.round_wall_clock_p99` exactly, so a round that spends its permitted
solve budget has by construction spent the whole round's. Until an aggregation rule exists, the gate
has no arithmetic to be measured against, and no amount of solver work will supply it.

---

## Appendix — Files Changed

| File | Change | Defect | Regression test |
|---|---|---|---|
| `src/engine/solve/minCostFlow.js` | `completeToFeasibleFlow()`, `relaxedMoneyLowerBound()`; trivial incumbent on the pre-`prepare` budget exit; completion of the SSP budget-limited stop; honest `boundMilliCU`; duals labelled by proof rather than by regime | D1, D2, D3, D4 | `solveCostScaling.test.js` ×5 |
| `src/engine/solve/costScaling.js` | `prepare()` retains capacities; `certify()` computes its stated capacity condition | D7 | `solveCostScaling.test.js` ×1 |
| `src/engine/solve/regime.js` | `DUAL_KIND.BUDGET_LIMITED`; `dualsFor(regime, duals, { proven })` defaulting to the regime's entitlement | D4 | `solveCostScaling.test.js` ×1 |
| `src/engine/solve/round.js` | One union `offer()` instead of one per partition; `BUDGET_TRUNCATED` for Legs the clock stopped; `solver` / `optimalityCertified` / `fallbackFrom` on the partition report | D5, D6, issue 9 | `solveRound.test.js` ×2, `coordinatorRound.test.js` ×1 |
| `src/workers/coordinator.worker.js` | §9.4's budget measured against the local clock, not the pinned decision time | D8 | `coordinatorRound.test.js` ×1 |
| `tests/engine/solveCostScaling.test.js` | +7 tests | | |
| `tests/engine/solveRound.test.js` | +2 tests | | |
| `tests/engine/coordinatorRound.test.js` | +2 tests, incl. the production-dispatch integration test | | |
| `tools/verify/phase10Profile.js` | **new** — stages, budget matrix, tiers, memory, determinism | | |
| `tools/verify/phase10Oracle.js` | **new** — 30 000-instance independent oracle, scalarisation stress | | |

No production behaviour changed outside the budget-limited paths, the round's per-Leg labelling of
budget-truncated Legs, and the round's incumbent composition. No frozen architecture document was
edited. No gate was modified. No test was weakened.
