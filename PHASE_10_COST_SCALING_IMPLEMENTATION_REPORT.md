# Phase 10 — Cost-Scaling Min-Cost-Flow Solver

**Status:** implementation complete, ready for independent verification
**Scope:** the singleton-regime solver only (§9.3, §20.2). No Phase 16 functionality. No other Phase 15 blocker touched.
**Date:** 2026-08-08
**Machine:** build machine, Node v22.17.0, Windows 11

---

## 1. Executive Summary

`PHASE_15_INDEPENDENT_VERIFICATION.md` and the `objective.buildInstance` optimisation report
established that the singleton-regime round misses §20.1's 250 ms target by ~94×, that
instance construction is ~1 % of the round and the solver ~99 %, and that the cause is
algorithmic: the shipped solver was **successive shortest paths with Johnson potentials**,
while §20.2 specifies **min-cost flow with cost scaling**.

Phase 10 is re-opened and that algorithm is now implemented.

- **`Backend/src/engine/solve/costScaling.js`** (new, 684 lines) — Goldberg–Tarjan
  push-relabel with ε-scaling, over exact scaled integers.
- **`Backend/src/engine/solve/minCostFlow.js`** (modified) — unchanged network construction
  (§9.3's arcs and capacities are untouched); now dispatches to cost scaling and retains the
  successive-shortest-path solver as a test oracle and as an exactness fallback.

The result at §20.1's own 500 Legs × 200 candidates shape, measured rather than inferred:

| | successive shortest paths | cost scaling |
|---|---:|---:|
| solve | 23 536 ms → 30 323 ms* | 345 ms → 508 ms* |
| exponent in Legs | 2.089 (r² 1.0000) | 1.075 – 1.28 (r² 0.97 – 0.99) |
| objective | 5 000 000 milli-CU | 5 000 000 milli-CU (identical) |

\* two figures because the machine drifted ~1.3× slower over the session under sustained
load; both arms drifted together and the **ratio** (45× – 68×) and the **exponent** are the
drift-immune evidence. §8 gives the full protocol and both sets.

Correctness was not traded for it. Every cost-scaling solve now returns an **optimality
certificate** — exact lexicographic node potentials recomputed on the final residual network,
checked against LP duality's two conditions. Where the previous solver was exact *by
construction*, this one is exact *and says so from a proof recomputed on every run*. If the
proof ever fails, the round falls back to the reference solver rather than returning an
uncertified answer.

Two defects were found and fixed during implementation, both by measurement rather than by
review: the published duals were dual-feasible but not *marginal* (§4), and a budget-limited
solve spent 2 975 ms against a 250 ms budget proving a negative (§10).

**§20.1 is not declared PASS.** The gap is now 3.6× rather than 94×, on this machine, in one
process. Discharging the gate needs a run on the representative hardware §20.1 names, which
is evidence this repository cannot produce.

---

## 2. The Existing Solver, and Its Verified Limitation

### The network (unchanged)

```
           ┌── cost γ(c) ──► agent a ──┐
  S ──► Leg l                          ├──► T
           └── cost C_defer[l] ────────┘
```

| arc | capacity | cost | meaning |
|---|---|---|---|
| `S → l` | 1 | `(0,0)` | the coverage row: exactly one unit per Leg |
| `l → a` | 1 | `(0, γ(c))` | the singleton column pairing `l` with `a` |
| `l → T` | 1 | `(0, C_defer[l])` | the deferral variable `y[l]`, when priced |
| `l → T` | 1 | `(1, 0)` | remain-queued, when the `deferral` switch is thrown |
| `a → T` | 1 | `(0,0)` | §9.3's exclusivity row, `≤ 1` **per agent** |

Costs are **lexicographic pairs** `(unassigned, milliCU)` of `BigInt`, added componentwise
and compared lexicographically. That is how §22.5 rule 1 — "immediate assignment when any
feasible candidate exists" — is expressed as a *priority* rather than as a big-M *price*.

### The algorithm that was there

Successive shortest paths with Johnson potentials. Initial potentials by one relaxation pass
in topological order (the initial network is a DAG in the order `S < Legs < Agents < T`, so
this is exact even for the negative `γ` that `C_opportunity` produces); then `|L|`
augmentations, each a Dijkstra over the whole residual network on non-negative reduced costs,
each pushing exactly one unit.

**Termination:** `augmentations === requiredFlow`, or the §9.4 budget between augmentations.
**Negative costs:** handled exactly by the initial DAG relaxation.
**Determinism:** canonical node indexing, arcs in canonical column order, heap comparisons
ending in the node index.
**Numerics:** all `BigInt`; no float anywhere in the network.

### Why it is slow, precisely

Two compounding costs, and it is worth separating them because only the first is asymptotic:

1. **The algorithm.** `|L|` Dijkstras over `|L| · k` arcs is `O(m² · k · log)`. Measured
   exponent in Legs: **2.089 at r² = 1.0000** — the prediction, exactly.
2. **The arithmetic.** At 500 × 200 that is ~50 M edge relaxations, and each one allocates
   three `BigInt` pair arrays and performs ~6 `BigInt` operations. ~150 M short-lived array
   allocations per solve.

Cost scaling addresses both: it removes the `|L|` multiplier, and it works on typed arrays of
exact integers rather than on allocated `BigInt` pairs.

---

## 3. Cost-Scaling Design

### The algorithm

Goldberg–Tarjan push-relabel with ε-scaling. Prices `p(v)` per node; the reduced cost of a
residual arc `(v,w)` is `c_p(v,w) = c(v,w) + p(v) − p(w)`. A pseudoflow is **ε-optimal** when
every residual arc has `c_p ≥ −ε`.

| operation | definition | invariant it preserves |
|---|---|---|
| **saturate** (start of `refine`) | push all residual capacity on every arc with `c_p < 0` | makes the pseudoflow 0-optimal, hence ε-optimal for the new ε |
| **push** | move `min(excess(v), residual(v,w))` along an arc with `c_p < 0` | the reverse arc it creates has `c_p > 0 ≥ −ε` |
| **relabel** | `p(v) ← max{ p(w) − c(v,w) − ε : (v,w) residual }` | the maximising arc becomes admissible at exactly `−ε`; every other residual arc keeps `c_p ≥ −ε` because `p(v)` is their maximum |
| **`refine` returns** | no node holds excess | the pseudoflow is a genuine flow, and it is ε-optimal |

Relabel strictly *decreases* `p(v)` by at least `ε` whenever no admissible arc existed, which
is what bounds the number of relabels.

### The scaling schedule, and why the answer is exact

Costs are pre-multiplied by `scale = n + 1`. Then `ε < 1` on the scaled costs is
`ε < 1/(n+1)` on the originals, and a flow that is `1/(n+1)`-optimal on **integer** costs is
**optimal** — any improving cycle would have to improve by at least 1 and can contain at most
`n` arcs. The loop is:

```
ε ← max(1, max|scaled cost|)
loop:  refine(ε);  if ε = 1 break;  ε ← max(1, ⌈ε/2⌉)
```

It always ends with `refine(1)`, so an all-zero-cost instance still routes its flow. At
500 × 200 this is **40 phases**. There is no tolerance in the result.

### Epsilon-scaling on a lexicographic cost

ε-scaling needs one scalar magnitude to halve. The pair is collapsed to

```
w = unassigned · K + milliCU        K = 1 + 2 · n · max|milliCU|
```

`K` is **derived from the instance**, not configured. Any simple path or cycle in this network
has at most `n` arcs, so the money component of any cost the algorithm compares is bounded by
`n · max|milliCU| < K/2`. The collapsed comparison is therefore *identical* to the
lexicographic one, arc for arc — not an approximation, and not the unregistered constant §1.3
prohibits, because nothing can reach `K` by construction rather than by assumption.

### Determinism

Every loop is over an index range — never over a `Map`, a `Set`, or an object's keys.

| decision point | order |
|---|---|
| active nodes | FIFO, seeded in ascending node index |
| residual/admissible arc scan | flat CSR in the order `buildNetwork` appended them, which is the canonical column order `objective.buildInstance` produced |
| push target | first admissible arc in that order |
| relabel | maximum over that order; the **first** maximum wins |
| final extraction | forward arcs in index order, then `canonicalSort` by Leg id |

No clock, no randomness, no hashing, no concurrency. The `gate:tenets` T6 check covers the new
module (`src/engine/solve/` is in `DECISION_PATH_SCOPE`) and passes.

### Data structures and resource shape

Typed arrays sized once per solve, all `O(|V| + |E|)`:
`Int32Array` for arc heads, residual capacities, excess, and current-arc pointers;
`Float64Array` for exact-integer scaled costs and prices; a `Uint8Array` queue flag and an
`Int32Array` ring of size `|V| + 1`. Arc tails are read as `arcHead[arc ^ 1]` rather than
stored. There is no per-relaxation allocation anywhere in the inner loop.

---

## 4. Semantic Preservation

**The network is untouched.** `buildNetwork()` is byte-for-byte the function it was: same
nodes, same arcs, same capacities, same lexicographic costs, same refusal of a multi-Leg
column, same `@structural` annotations. Nothing in the formulation moved to make the solver
faster. `objective.js` is unmodified.

| property | how it is preserved |
|---|---|
| candidate eligibility | assignments are read off `PAIRING` arcs, which exist only for columns `buildInstance` admitted; asserted per assignment in the invariant suite |
| Leg / agent constraints, capacities | unchanged arcs; `objective.validate` asserted feasible on every test instance |
| feasibility | flow conservation is checked as part of the certificate (`excess` all zero) |
| objective coefficients and direction | the objective is summed from the selected arcs' own `γ`, by the same shared code both solvers use |
| cost semantics | `assertObjectiveIsAllocationCost` asserted `ok` on every test instance |
| deterministic output | §6 |
| commitment / fencing / lifecycle | `round.js` and everything downstream are unmodified; the result object gained two fields and changed none |
| provenance / explainability | `duals`, `agentDuals`, `augmentations`, `boundMilliCU`, `lpIpGapMilliCU`, `regime`, `branched`, `network` all retained with identical meaning |
| timeout behaviour | §10 |
| error behaviour | the multi-Leg-column refusal and the network-construction refusal return the same shapes; verified identical on both solvers |
| empty instance | solves to an empty allocation, objective `0n`, `augmentations: 0` |
| infeasible instance | unchanged: a Leg with no feasible candidate remains queued (§22.5 rule 1) rather than making the round infeasible |

### Result-object changes (additive only)

| field | before | after |
|---|---|---|
| `solver` | — | `"COST_SCALING"` or `"SUCCESSIVE_SHORTEST_PATH"` |
| `optimalityCertified` | — | `true` / `false` on the cost-scaling path; **`null`** on the reference path |
| `solverDiagnostics` | — | `{ scalingPhases, relabels, pushes, finalEpsilon, dualsTight }`, or `{ augmentations, fallbackFrom }` |
| `augmentations` | augmentation count | units of flow routed — the same number, computed from the `SUPPLY` arcs, so it is identical for both solvers |

`optimalityCertified` is `null` rather than `true` on the reference path deliberately: successive
shortest paths is exact by construction and computes no proof, and an unchecked claim and a
checked one are not the same fact.

### The duals — a defect found and fixed

§9.3 permits the singleton regime to publish its duals as **"exact marginal prices of the
integer problem"**. The first working implementation seeded the certificate's potentials from
the ε-optimal scaling prices. Measurement against the reference solver showed the result was
dual-*feasible* but landed on an arbitrary vertex of the dual polytope: on the four-column
instance in §5, it published `π[L1] = 75 000` where the reference published `10 000`, and
selected columns carried non-zero reduced cost — not a marginal price.

Two changes fixed it, and both are in the shipped code:

1. **Zero-seeded relaxation.** Relaxing from zero converges to the pointwise *maximal*
   potential satisfying the system; the system is shift-invariant, so a solution exists under
   the zero ceiling exactly when one exists at all — the seed costs nothing in generality.
2. **Complementary slackness forced on the priced arcs carrying flow.** Relaxing a saturated
   `PAIRING`/`DEFER` arc in its forward direction as well as its residual reverse turns the
   pair of inequalities into an equality. The structural arcs (`S → Leg`, `agent → T`) are
   excluded deliberately — forcing them tight over-constrains the dual and admits no solution,
   which is why the reference solver's own potentials do not make them tight either.

Both solvers now publish prices that satisfy, over **every** column of the instance:

```
γ(c) + π[leg] − π[agent] ≥ 0      dual feasibility
                          = 0      on every selected column — complementary slackness
```

which together *are* LP optimality, proven from the published prices rather than from the
solver's internals. Verified at 250 × 200 over all 50 000 columns: **0 violations of either**.

**One caveat, pre-existing and unchanged.** On a round that leaves Legs queued, the dual is a
lexicographic pair and only its milli-CU component is published — publishing §22.5's assignment
priority as a price would be a dimensioned quantity fabricated from an ordering (§1.3). The
projection then omits the term that makes dual feasibility hold across all columns.
Complementary slackness still holds everywhere. **The reference solver behaves identically**
— measured on 15 of 300 generated instances, all of them rounds with queued Legs, with the
same residues. This is the formulation's projection, not the new algorithm's arithmetic, and
`solveCostScaling.test.js` pins it as unchanged rather than newly true.

### The optimality certificate

`certify()` recomputes exact lexicographic potentials by Bellman–Ford on the final residual
network — in the exact `(unassigned, milliCU)` pair, not in the collapsed representation — and
checks:

1. **feasibility** — every node's excess is zero;
2. **dual feasibility** — every residual arc has a lexicographically non-negative reduced cost.

Together those prove the flow is a minimum-cost flow, *for this instance, on this run*. The
collapse and the scaled-integer arithmetic are devices for finding a candidate flow; nothing
downstream trusts them. If `K` were ever wrong, or the scaled arithmetic ever lost exactness,
the certificate would fail and the round would fall back to the exact reference solver.

The certificate is not vacuous: a hand-built suboptimal flow (routing L1→A1 and L2→A2 at cost
110 where the optimum is 50) is fed to `certify()` directly in the test suite and is rejected.

### The exactness fallback

`prepare()` refuses an instance whose costs are too wide for exact float64 integer arithmetic,
with a named reason (`MONEY_TOO_WIDE`, `COLLAPSE_TOO_WIDE`, `SCALED_COST_TOO_WIDE`). Prices are
guarded against the exactly-representable range at every relabel. A refusal, a runtime overflow,
a stuck node, a tripped relabel guard, or a failed certificate all route the round to the
reference solver, which is exact. **Exactness is unconditional; speed is conditional.** That is
the correct direction for a Tier 1 module to fail in.

The fallback is exercised by a test at γ = 4 × 10¹⁸ milli-CU (int64 is what §9.6 requirement 1
permits) and returns the right answer via `SUCCESSIVE_SHORTEST_PATH` with the reason recorded.
At realistic magnitudes it is unreachable: at 500 × 200 with γ ≤ 106 CU the widest scaled
intermediate is ~1 × 10¹¹ against a 9 × 10¹⁵ ceiling.

---

## 5. Reference Equivalence

The reference solver is retained as `minCostFlow.solveSuccessiveShortestPath()` and reachable
from `solve()` only via an explicit `{ solver: "SUCCESSIVE_SHORTEST_PATH" }` option or the
fallback path. The decision path runs cost scaling — asserted by *running* it in the scale
suite, not by reading a comment.

### What equivalence is asserted as, and why

The two are different algorithms reaching the same **optimum**. Where the optimum is unique
they must agree arc for arc, and that is asserted. Where several allocations share the optimal
cost, the specification does not name one: §9.6 requires ties to resolve by an explicit total
order rather than by arrival or storage order, and that identical input produces identical
output. It does not require that two different exact algorithms select the same member of the
optimal set, and §9.6's own acceptance test pins the **code version** (requirement 6), so
replay is unaffected. This was checked against §9.3, §9.4, §9.6 and §24.3 before being relied
on rather than assumed.

Equivalence is therefore asserted as: same `ok`, same objective in exact milli-CU, same flow
value, same counts of assigned / deferred / queued Legs, same feasibility, plus the full
invariant set on **both** results — and identical allocation on instances built to have one
optimum.

### Results

**300 generated instances** (deterministic xorshift, seeds 1–300; 1–12 Legs, 1–10 agents, 1–5
candidates per Leg, cost spans to 500 milli-CU, signed costs on ⅓, priced deferral on ¼):

| checked | result |
|---|---|
| objective identical (exact milli-CU) | **300 / 300** |
| flow value identical | **300 / 300** |
| assigned / deferred / queued counts identical | **300 / 300** |
| cost scaling certified optimal | **300 / 300** |
| full invariant set on both results | **300 / 300** |
| *allocation* byte-identical | 292 / 300 (recorded, not asserted) |

**30 larger instances** (seeds 1000–1029; 30–70 Legs, 5–20 agents so exclusivity binds and
Legs are left queued, 6 candidates each): objective and queued-count identical on all 30,
certified on all 30.

**At the benchmark shape** (250 × 200 and 500 × 200, the deliberately tie-heavy round fixture
where only 97 distinct γ values cover 50 000–100 000 columns):

| | 250 × 200 | 500 × 200 |
|---|---|---|
| objective | identical (2 500 000) | identical (5 000 000) |
| assigned / queued | identical (250 / 0) | identical (500 / 0) |
| set of queued Legs | identical | identical |
| Legs given a different equal-cost agent | 113 | 183 |
| dual feasibility violations over all columns | 0 | 0 |
| complementary slackness violations | 0 | 0 |

The 8/300 and 113/183 divergences are **tie-breaking among equal-cost optima**, and the
certificate proves both selections optimal. The fixture is engineered to be maximally
degenerate; the 292/300 figure on varied generated instances is the better indication of how
often the optimum is actually unique.

**This is the one semantic delta in the change, and it is stated here rather than buried:**
which member of the optimal set is selected can differ from the previous implementation's
choice. Objective, feasibility, cardinality, the queued set, and the published prices do not.

---

## 6. Determinism

| test | result |
|---|---|
| 10 repeated solves of one tie-heavy instance (20 Legs × 6 candidates, 120 columns, 11 distinct prices) — allocation, objective, bound, LP–IP gap, flow value, leg duals, agent duals, and solver diagnostics compared as one serialised value | **byte-identical, 10/10** |
| the same instance rebuilt from scratch and re-solved | identical |
| column arrival order reversed | identical (`buildInstance` canonicalises before the solver sees it) |
| all-equal-cost instance, forward and reversed input | identical agent selected |
| every generated-sweep instance solved twice | identical |

`gate:tenets` confirms no clock and no randomness in `src/engine/solve/` (271 modules checked,
0 violations). The new module contains no `Date`, no `Math.random`, no `process.hrtime`, and
iterates no unordered collection.

---

## 7. Correctness Tests

```bash
npx jest tests/engine/solveCostScaling.test.js      #  36 passed
npx jest tests/engine/solveMinCostFlow.test.js      #  15 passed  (unmodified)
npx jest tests/scale/round.scale.test.js            #   9 passed
npm run gates                                       #   6 gates, all PASS
npx jest --runInBand --forceExit                    # 136 suites, 6059 tests, all passed
```

`tests/engine/solveCostScaling.test.js` is new (949 lines, 36 tests):

| group | covers |
|---|---|
| **Basic** | empty instance; one Leg / one agent / one candidate; several candidates; a Leg with no candidate; an agent with no Leg |
| **Structural** | cannibalisation resolved exactly; two disconnected components; many Legs contending for one agent; dense square instance; sparse instance |
| **Constraint / cost** | zero-cost columns; all-zero instance; negative γ; mixed signs across a wide range; expensive assignment beating a queued Leg; priced deferral both ways; equal-cost alternatives; saturated agents |
| **Certificate** | present on every solve; **rejects a hand-built suboptimal flow**; duals labelled `EXACT_INTEGER`; duals are exact marginal prices on three shapes; both solvers publish the same prices where the optimum is unique; the money-projection caveat holds on **both** solvers; the too-wide-cost fallback is taken and is correct |
| **Determinism** | §6 |
| **Generated sweep** | §5 — 330 instances |
| **§9.4 anytime** | §10 |
| **Refusal** | the multi-Leg column is refused identically by both solvers |

`assertSolutionInvariants` runs on **every** result in the file — both solvers, all 330
generated instances and every hand-built case — and checks: `objective.validate` feasible with
zero violations; `assertObjectiveIsAllocationCost` exact; every Leg accounted for exactly once
across assigned/deferred/queued (flow conservation, read from the allocation); every assignment
naming a column the instance actually contains with matching agent and Leg (candidate
eligibility); no deferral without a priced `y[l]`; at most one column per agent; and — on any
non-budget-limited result — complementary slackness over all columns, plus dual feasibility on
rounds that place every Leg.

No existing test was weakened, skipped, or deleted. `solveMinCostFlow.test.js` is unmodified
and its 15 tests pass against the new solver unchanged. `round.scale.test.js` was updated —
§9 explains each change and why it is not a weakening.

---

## 8. Performance

**Protocol.** Standalone processes outside Jest, one solver per process so neither pays the
other's garbage collection. `buildInstance` and `validate` are medians of 3 after one warm-up;
the cost-scaling solve is a single cold run at the full shape (medians of 3–5 agree within
noise); the reference solve is a single run because one run is 30 s. The instance is
`round.scale.test.js`'s own `inputAt()` fixture.

**Two measurement sets, because the machine drifted.** Sustained load over the session left it
~1.3× slower at the end than at the start: the reference solver at 500 × 200 measured
23 536 ms at session start (reproducing the prior report's 23 289 ms) and 30 323 ms at the end,
and `buildInstance` moved 255 ms → 347 ms with no code change between them. Both arms drifted
together. Both sets are given; the ratio and the exponent are the drift-immune evidence.

### Session start — reproduces the prior report's baseline

| Workload | Build | Old Solver | New Solver | Validate | Total (old) | Total (new) |
|---|---:|---:|---:|---:|---:|---:|
| 100 × 200 | 51 ms | 836 ms | — | 1.7 ms | 889 ms | — |
| 250 × 200 | 149 ms | 6 148 ms | — | 3.6 ms | 6 301 ms | — |
| 500 × 200 | 255 ms | 23 536 ms | **345 ms** | 9.8 ms | 23 801 ms | **610 ms** |

Prior report's figures for comparison: build 236 ms, solver 23 289 ms, validate 8 ms,
total 23 533 ms. Reproduced within 8 %.

### Session end — final code, same protocol, slower machine

| Workload | Build | Old Solver | New Solver | Validate | Total (old) | Total (new) | Speed-up |
|---|---:|---:|---:|---:|---:|---:|---:|
| 100 × 200 | 62 ms | 1 174 ms | **142 ms** | 2.2 ms | 1 238 ms | **206 ms** | 8.2× |
| 250 × 200 | 207 ms | 8 635 ms | **285 ms** | 4.6 ms | 8 847 ms | **497 ms** | 30.3× |
| 500 × 200 | 347 ms | 30 323 ms | **508 ms** | 14.2 ms | 30 684 ms | **869 ms** | 59.7× |

### Interleaved, same process, both arms under identical conditions

The comparison `scaleHarness.interleaved()` exists for — A, B, A, B, … so a garbage-collection
pause lands in both arms:

| Workload | New Solver | Old Solver | Ratio |
|---|---:|---:|---:|
| 100 × 200 (5 trials) | 112.8 ms | 1 036.2 ms | 9.2× |
| 250 × 200 (3 trials) | 282.4 ms | 6 854.7 ms | 24.3× |
| 500 × 200 (3 trials) | 661.2 ms | 30 156.6 ms | **45.6×** |

Cost scaling is inflated in this arm because it pays for the reference arm's garbage; in
production the reference solver does not run.

### Solver work at 500 × 200

40 scaling phases, 132 666 relabels, 376 535 pushes, final ε = 1, certified, duals tight.
Phase count is `log₂` of the largest scaled cost and grows with `log(n · max|γ|)`, which is
why it moves so little across shapes (36 → 38 → 40 for 100 → 250 → 500 Legs).

### Against §20.1

§20.1: *round wall-clock (500 Legs × 200 candidates) < 250 ms*.

**Read the table below as an implementation-author diagnostic, not as gate evidence.** Four
kinds of number appear in this programme's documents and they are not interchangeable; a
figure quoted without its class is how §13 item 2's discrepancy arose in the first place:

| Class | What it is | Where it appears | Can it discharge §20.1? |
|---|---|---|---|
| **Implementation-author benchmark** | Standalone Node process, one solver per process, p50, this build machine | §8's tables, including the one below | **No** |
| **Independent verification benchmark** | The Jest `scale` lane, re-run by a reviewer who did not implement the change, on the reviewer's own machine | `PHASE_10_COST_SCALING_INDEPENDENT_VERIFICATION.md` Finding 2 | **No** |
| **Diagnostic measurement** | Any single-process, p50, in-repository run — including every figure in this report | Everywhere in §8, §9, §13 | **No** |
| **Formal §20.1 gate evidence** | Whole-round p99, per shard, over production-shaped traffic, on representative production hardware, with routing and commit inside the same 250 ms | Nowhere yet | **This alone** |

The first three differ from each other by harness and machine, as §13 item 2 quantifies. All
three differ from the fourth in *kind*: they measure two or three stages of the round in one
process at p50, and §20.1 is the whole round at p99 on hardware nobody here has run on.

| | before | after |
|---|---:|---:|
| solve | 23 536 ms | 345 – 508 ms |
| build + solve + validate | 23 801 ms | 610 – 869 ms |
| multiple of the 250 ms target | **95×** | **2.4× – 3.5×** |

The gap is closed by a factor of ~30 and is not closed. §13 is honest about what is left.

---

## 9. Scaling

Power-law fits by `scaleHarness.scalingOf()`, least squares on the logs, median of 5 trials
per point. The measurement grid was widened from `[25, 50, 100, 200]` at 8 candidates to
`[50, 100, 200, 400]` at 20, and the candidate grid from `[5, 10, 20, 40]` at 40 Legs to
`[10, 20, 40, 80]` at 60: the old grid now runs in 1.7 – 19 ms, and a power-law fit over
single-digit milliseconds on a machine with a garbage collector measures the runtime rather
than the algorithm. This is what keeps the exponent a measurement.

| fit | successive shortest paths | cost scaling |
|---|---|---|
| exponent in **Legs** | **2.089** (r² 1.0000) | **1.075 – 1.284** across repeats (r² 0.965 – 0.995) |
| exponent in **candidates** | 0.667 (r² 0.987) | 0.614 – 0.719 (r² 0.81 – 0.997) |
| exponent in Legs at 100 candidates | — | 1.215 (r² 0.980) |

Measured points, cost scaling, `[50, 100, 200, 400]` Legs × 20 candidates:
`[4.2, 9.5, 19.0, 63.7] ms`. Reference, `[25, 50, 100, 200]` × 8: `[3.5, 15.3, 63.1, 271.1] ms`
— a clean doubling-quadruples curve.

**This is the §20.2 question answered.** §20.2 states `O(m · k · log)` *typical* for the
singleton regime with cost scaling. The exponent in Legs moved from 2.089 to ≈ 1.2 and the
exponent in candidates is unchanged and sub-linear — which is the regime §20.2 describes. The
candidate-count exponent being unchanged is itself informative: §6.5's candidate cap was never
what was expensive.

### Test bounds

`round.scale.test.js` now asserts `0.7 < exponent_Legs < 1.6` (was `1.5 < … < 2.6`), with
`r² > 0.9` unchanged, and `0.3 < exponent_candidates < 1.3` unchanged. The bounds are the two
*regimes*, not a tolerance around a measurement: the reference solver measures 2.089 at
r² = 1.0000 on the same grid, so the upper bound is what catches a revert to it or an
accidental quadratic arrived at any other way.

### Changes to `round.scale.test.js`, and why none is a weakening

| test | before | after |
|---|---|---|
| exponent in Legs | asserted quadratic, 1.5–2.6 | asserts near-linear, 0.7–1.6. The old bound asserted a **defect**; its own comment said *"a cost-scaling replacement would land near 1 and fail the upper end of nothing but this comment"* |
| exponent in candidates | 0.3–1.3 | unchanged |
| r² | > 0.9 | unchanged; grid widened so the fit stays meaningful at the new speed |
| "the solver is the algorithm the exponent implies" | asserted the SSP header string | asserts the cost-scaling header string, **and** that the reference is still present and still named as the reference, **and** — by running it — that the decision path returns `COST_SCALING` with a certificate. Strictly more than before, and no longer satisfiable by a comment |
| §20.1 round wall-clock | measured 500 × **10** and asserted `attained === false` | measures 500 × **200**, the real shape, which is now affordable. Asserts the answer is certified optimal and all 500 Legs assigned, plus a **regression bound of 5 000 ms** — an order of magnitude above the measured 508 ms and two below the 30 323 ms baseline. Asserting 250 ms would be asserting §20.1's gate on unknown hardware, which `scaleHarness.js` explains at length is not a gate |

The old `attained === false` assertion was designed to fail when the gap closed — its comment
says *"that failure is the signal to re-open `scale_targets` and update the report"*. That is
exactly what happened, and this report is the update.

---

## 10. Anytime / Timeout

§9.4: *"The solver MUST be an anytime algorithm: at any point it holds a feasible solution and
a bound. Exceeding the time budget returns the incumbent with its bound, never nothing and
never a hang."*

**Where it stops.** The budget is consulted before the network is collapsed, and then between
scaling phases. Between phases is the only safe point: `refine` returns only when no node holds
excess, so the flow is complete, integral and feasible — every Leg routed, to an agent or to
the sink — and merely ε-optimal rather than optimal. Stopping mid-phase would return a
pseudoflow, which is not an allocation at all.

This is a **stronger** incumbent than the previous solver's. Successive shortest paths stopped
between augmentations and returned a *partially routed* batch; cost scaling returns a **whole
allocation** at every stopping point after the first phase.

**Measured at 500 × 200**, with a real clock:

| `solve.time_budget` | returned in | budget-limited | Legs accounted for | objective | vs optimal | certified | feasible | `assertAnytime` |
|---:|---:|---|---:|---:|---:|---|---|---|
| 0 ms | 74 ms | yes | 0 | 0 | — | false | yes | ok |
| 50 ms | 78 ms | yes | 0 | 0 | — | false | yes | ok |
| 250 ms | **270 ms** | yes | **500 / 500** | 5 442 000 | +8.8 % | false | yes | ok |
| ∞ | 524 ms | no | 500 / 500 | 5 000 000 | optimal | **true** | yes | ok |

Every budget-limited result passes `objective.validate` and
`assertObjectiveIsAllocationCost`. **No partial or invalid allocation is ever returned**: the
0 ms and 50 ms rows return an empty incumbent, exactly as the previous solver did at zero
augmentations, and the 250 ms row returns a complete feasible allocation.

**Two defects found here by measurement, and fixed:**

1. **The certificate was being paid for when it could not exist.** A budget-limited flow is
   ε-optimal, so `certify()` is guaranteed to fail — but it spent `|V|` = 701 relaxation passes
   over 202 000 arcs establishing that, at exactly the moment the round had run out of time.
   Measured: **2 975 ms against a 250 ms budget.** The fix is to skip the certificate on the
   budget-limited path entirely and publish the `O(n)` ε-optimal prices with
   `optimalityCertified: false` — the honest pair. Result: 2 975 ms → **255 ms**.
2. **The budget was first consulted after `prepare()`.** Collapsing and flattening a
   100 000-column network is tens of milliseconds a round that has already spent its budget
   should not spend. Moving the check ahead of `prepare()` took the 0 ms case from 206 ms to
   **74 ms**. It is placed so it happens exactly once — a second call would record a second
   §9.4 wall-clock verdict for one exceedance, which is asserted in the test suite.

**Damage bound and granularity.** Overshoot is one scaling phase; measured 20 ms against a
250 ms budget at the full shape. The budget was **not** widened, no threshold was changed, and
`solve.time_budget`'s registered default is untouched.

**`boundMilliCU` and `lpIpGapMilliCU` are unchanged** — `bound = objective`, `gap = 0`,
computed as an equality exactly as before, on both solvers and in both budget states. Making
the budget-limited bound honest would be an improvement over the previous behaviour and a
change to the reported contract; it is listed in §13 as a decision for verification rather
than taken unilaterally here.

---

## 11. Resource Usage

Measured with `--expose-gc` at 500 × 200, forcing a collection between runs so the numbers are
retention rather than collector lag.

| | cost scaling | successive shortest paths |
|---|---|---|
| heap retained after GC, runs 1–10 | 33.3, 35.6, 33.4, 33.5, 33.5, 33.5, 33.5, 33.5, 33.5, 33.5 MB | 32.0, 34.1 MB (2 runs) |
| transient heap during one solve | ~50 MB (peak 55.3 MB) | 48 – 100 MB |
| RSS, steady | 153 MB | 297 – 357 MB and climbing |

**No leak.** Retained heap is flat at 33.5 MB from run 2 onward across 10 solves — the
allocation is `O(|V| + |E|)` typed arrays sized once per solve and released with it.

**Residual graph growth: none.** Arcs are allocated once by `buildNetwork`; the residual
network is the same arc array with a mutable capacity, and reverse arcs already exist as the
odd indices. Push-relabel adds no nodes, no arcs, and no per-relaxation objects.

The RSS difference is the point of the change as much as the wall clock: the reference solver
allocates ~150 M short-lived `BigInt` pair arrays per solve at this shape, and its RSS climbs
to 357 MB doing so. Cost scaling holds 153 MB flat.

`overloadAndSoak.scale.test.js` and the chaos suite pass unchanged.

---

## 12. Files Changed

Four files. Verified by modification time against the session start, and by
`git status --porcelain` over the solve and test scopes — no unrelated file was touched, no
pre-existing change was reset, nothing was committed.

| file | status | lines | change |
|---|---|---:|---|
| `Backend/src/engine/solve/costScaling.js` | **new** | 684 | the algorithm: `prepare()`, `run()`, `certify()`, `approximatePrices()` |
| `Backend/src/engine/solve/minCostFlow.js` | modified | 767 | header; `require("./costScaling")`; `SOLVER`; `refusal()`; `assemble()` shared by both solvers; `solveByCostScaling()`; `solveSuccessiveShortestPath()` exported; `solve()` dispatches. **`buildNetwork`, `initialPotentials`, `createHeap`, the cost algebra, and the successive-shortest-path loop are unchanged** |
| `Backend/tests/engine/solveCostScaling.test.js` | **new** | 949 | 36 tests — equivalence, invariants, determinism, certificate, duals, anytime, fallback |
| `Backend/tests/scale/round.scale.test.js` | modified | 367 | header rewritten to record the finding as acted on; measurement grids widened; exponent bounds moved to the cost-scaling regime; algorithm assertion strengthened; §20.1 measured at the real 500 × 200 shape |

**Not modified:** `objective.js`, `round.js`, `regime.js`, `budgets.js`, `cadence.js`,
`solveMinCostFlow.test.js`, the register, the kill switches, the release gates, `TIERS.md`, or
anything outside `solve/`.

**No Phase 16 module was created.** `solve/batch.js`, `solve/setPartitioning.js`,
`solve/localSearch.js`, `solve/branchAndBound.js`, `lifecycle/preemption.js` and `fairness/`
do not exist; `roundSchema.test.js`'s guard against their early appearance passes.

`costScaling.js` is Tier 1 by `TIERS.md` Convention 1 (undeclared modules default to Tier 1)
and is covered by every gate that governs `src/engine/solve/`: T1, T6, tier dependencies, the
parameter register, and `roundSchema.test.js`'s no-clock / no-Tier-2-import sweep over the
directory. All pass.

---

## 13. Remaining Issues

1. **§20.1 is not met and is not claimed.** 610–869 ms for build + solve + validate against a
   250 ms round target, on this machine, in one process, at p50. The gate needs a run on the
   representative hardware §20.1 names and a p99 over production-shaped traffic. Note also
   that this measures three stages of the round, not the round: candidate generation,
   feasibility, pricing, routing and commit are not in it.

2. **`buildInstance` is a large minority of the measured total — but the share depends on the
   measurement harness, and this report originally failed to say which harness produced it.**

   As first written, this item read: *"`buildInstance` is now 40 % of the measured total
   (347 ms of 869 ms at 500 × 200)."* `PHASE_10_COST_SCALING_INDEPENDENT_VERIFICATION.md`
   Finding 2 contradicted it, reproducing 64 % over two runs, and correctly judged that a 4×
   difference in a *ratio* is not what a uniformly slower machine produces. The verifier was
   right that the discrepancy was real and right that it was not uniform slowdown. **The cause
   is neither the machine nor the solver: it is that the two measurements were taken in two
   different harnesses**, which the Phase 15 consolidated remediation identified by running
   both on one machine, back to back:

   | Environment (one machine, one code state, same fixture) | `solve` | `buildInstance` | `buildInstance` share of the two |
   |---|---:|---:|---:|
   | Standalone Node process, run 1 | 576 ms | 337 ms | **36.9 %** |
   | Standalone Node process, run 2 | 607 ms | 324 ms | **34.8 %** |
   | Jest `scale` lane, run 1 | 898 ms | 1 430 ms | **61.4 %** |
   | Jest `scale` lane, run 2 | 759 ms | 1 594 ms | **67.7 %** |

   Jest inflates `buildInstance` by roughly 4× and `solve` by roughly 1.4×. The asymmetry is
   explicable rather than mysterious: `buildInstance` allocates and freezes one variable record
   per column — 100 000 of them — and allocation-heavy work is far more sensitive to the
   instrumented module registry, VM context and garbage-collection pressure of a test runner
   than the solver's tight numeric loop over pre-sized structures is.

   **Both prior figures were therefore correct, and neither was labelled.** §8's protocol
   states standalone processes, so this report's 40 % is a standalone figure and reproduces
   (34.8–36.9 % measured independently). The verification ran
   `tests/scale/round.scale.test.js`, so its 64 % is a Jest-lane figure and also reproduces
   (61.4–67.7 % measured independently). The defect was in this report's wording — "the
   measured total", with no statement of which harness measured it — not in either number.

   Two consequences stand regardless of harness, and they are the load-bearing ones:

   - **The solver is no longer the sole dominant term.** Whichever harness is used,
     `buildInstance` is between a third and two thirds of the two stages. The next
     optimisation should be scoped from a fresh measurement rather than from the pre-Phase-10
     assumption that the solve was ~99 % of the cost.
   - **`buildInstance` is linear in the column count** (exponent 1.087 standalone; 1.010 and
     1.118 measured in the Jest lane, r² 0.981 and 0.999). Its share is a constant-factor
     question, not a complexity-class one, and it is out of this task's scope.

   **The 250 ms threshold in §20.1 is unchanged by this correction, and so is `scale_targets`.**
   Nothing here is a gate movement; it is a statement about which of two honest measurements a
   sentence was describing.

3. **Tie-breaking among equal-cost optima can differ from the previous implementation.**
   §5 quantifies it: objective, feasibility, cardinality, the queued set and the published
   prices are identical; which equal-cost agent a Leg receives can differ. §9.6 requires a
   deterministic, canonical, non-storage-order tie-break, which is satisfied and tested. It
   does not require agreement between two exact algorithms, and no acceptance test in §9.6 or
   §24.3 requires it. **Flagged for independent verification** as the one semantic delta.

4. **The budget-limited bound is reported as exact.** `boundMilliCU = objectiveMilliCU` and
   `lpIpGapMilliCU = 0` on a budget-limited result, which is the previous solver's behaviour,
   preserved deliberately. Cost scaling could report a *true* bound there — an ε-optimal flow
   is within `n · ε` of optimal, and §9.4 asks for "the incumbent with its bound". That is a
   change to the reported contract and an improvement, so it is raised here rather than made
   unilaterally. Measured suboptimality at a 250 ms budget on the 500 × 200 shape: +8.8 %.

5. **The reference solver remains reachable in production**, on the exactness-fallback path
   only. It is not the hot path, it requires costs beyond float64's exact-integer range to
   reach, and reaching it produces a correct answer slowly rather than a fast wrong one. The
   `fallbackFrom` reason is recorded on the result so its use is observable rather than silent.

6. **The relabel guard is a bound on a defect, not on an instance.** `8 · n²` per phase, which
   is Goldberg–Tarjan's `O(n²)` with margin. It has never tripped in any measurement here
   (132 666 relabels total across 40 phases at 500 × 200, against a per-phase bound of
   ~3.9 M). Tripping it aborts to the exact reference solver.

7. **Not attempted, and out of scope:** calibration, shadow worker, soak, simulator fidelity,
   production invariant evidence, rollback rehearsal, Redis, database, frontend. These remain
   open Phase 15 readiness items and were not touched.

---

## 14. Recommendation

**The solver appears technically ready for independent verification.**

- §20.2's specified algorithm is implemented and is the decision path, verified by execution
  rather than by comment.
- The measured exponent in Legs moved from 2.089 to ≈ 1.2, which is the complexity regime
  §20.2 describes.
- Correctness is stronger than before, not weaker: every solve carries a recomputed optimality
  certificate, the published duals are now provably exact marginal prices, and the reference
  implementation is retained as both oracle and exactness fallback.
- 6 059 tests pass across 136 suites, including all 15 pre-existing solver tests unmodified;
  all six release gates pass; no test was weakened, skipped or deleted.
- Two real defects were found by measurement during implementation — non-marginal duals, and a
  certificate costing 2 975 ms against a 250 ms budget — and both are fixed and covered by
  tests.

Verification should concentrate on:

1. **Issue 3** — whether selecting a different member of the optimal set is acceptable, and
   whether §9.6 requirement 3's tie-break policy should be pushed into the solver rather than
   left to the canonical column order.
2. **The optimality certificate's completeness** — it is the load-bearing correctness argument
   for the scaled-integer arithmetic and the lexicographic collapse.
3. **The `K` derivation** in `costScaling.prepare()` — the claim that `K = 1 + 2 · n · max|γ|`
   makes the collapse order-identical to the lexicographic pair.
4. **Issue 4** — whether the budget-limited bound should become honest.

**Phase 15 is not complete and is not claimed complete.** This report discharges one blocker —
the §20.2 solver — and the §20.1 release gate remains undischarged pending a run on
representative hardware. **Phase 16 is not started and no Phase 16 module exists.**
