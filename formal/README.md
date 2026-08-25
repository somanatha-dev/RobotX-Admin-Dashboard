# `formal/` — the model-checked specifications (§24.2)

> The lifecycle and the commitment protocol are the parts where subtle concurrency
> defects hide. Both are specified formally (TLA+ **or an equivalent model checker**) and
> the following properties are model-checked …
>
> — `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` §24.2

Two modules, six configurations, and one honest statement about what has actually been
executed.

| File | Covers | Delivered by |
|---|---|---|
| `commitment.tla` | §10.3's commit procedure, guards G1–G6, the two fencing scopes, leadership | Phase 3 |
| `lifecycle.tla` | §4.2/§4.3's state machines, §4.4's transitions, §4.5's timers, §2.5's custody | Phase 15 |
| `commitment_c{1,2,3}.cfg` | The same module at `Capacity` 1, 2 and 3 | Phase 15 |
| `lifecycle_c{1,2,3}.cfg` | The same module at `Capacity` 1, 2 and 3 | Phase 15 |

## Running them

```
java -jar tla2tools.jar -config commitment_c2.cfg -workers auto commitment.tla
java -jar tla2tools.jar -config lifecycle_c2.cfg  -workers auto lifecycle.tla
```

## What has and has not been executed — read this before citing the gate

**Updated 2026-08-15 during the Phase 3 re-verification. TLC has now been run on
`commitment.tla`; it has not been run on `lifecycle.tla`.** The earlier statement here —
"there is no Java toolchain" — was true when it was written and is no longer: the
implementation environment carries Java 20, and TLA+ 1.8.0 (`tla2tools.jar`) was fetched
and executed against this module.

### `commitment.tla` — executed

| Configuration | `Legs` / `Workers` / `MaxFence` | Result |
|---|---|---|
| `commitment_c1.cfg` — **as checked in** | 3 / 2 / 5 | **Complete state graph.** 17 991 520 states generated, 2 375 660 distinct, graph diameter 21, **no error found**, 48 s |
| Capacity 2, **reduced** | 2 / 2 / 4 | **Complete state graph.** 37 633 116 states generated, 4 769 532 distinct, diameter 21, **no error found**, 69 s |
| `commitment_c2.cfg` — as checked in | 3 / 2 / 5 | **Did not converge here.** Stopped after >1 h with an 11 GB disk queue still growing. Not a failure — an unfinished search, reported as such |
| `commitment_c3.cfg` / capacity 3 reduced | 3 / 2 / 4 and 3 / 1 / 4 | **Not completed** within this session's budget |

The reduced capacity-2 configuration is the one that matters for §24.2's own argument: it
keeps `Capacity = 2`, so the concurrent-commitment case the two-scope fencing exists to
protect is exhibited, and lowers only the Leg count and the fence bound. Its search closed.

**What remains open:** a completed TLC run at capacity 3, and at capacity 2 with the
checked-in configuration. Both need more compute than a workstation session, not a
different specification.

### The executable equivalents

§24.2 permits "TLA+ **or an equivalent model checker**", and the equivalent checkers run on
every build. Their distinct value is that their transitions call the **shipped modules**
rather than a transcription of them.

| TLA+ module | Executable equivalent | Driven by |
|---|---|---|
| `commitment.tla` | `Backend/tests/engine/helpers/commitmentModel.js` | `Backend/tests/engine/commitmentModelCheck.test.js` |
| `lifecycle.tla` | `Backend/tests/engine/helpers/lifecycleModel.js` | `Backend/tests/engine/lifecycleModelCheck.test.js` |

Both are explicit-state checkers with a visited set over canonical state serialisations.

**A correction to what this file used to claim.** It said each "reports whether it
exhausted the state space or hit its depth bound, and each test asserts exhaustion". That
was not true of either checker: the flag was set by the **state cap** alone, so the depth
bound — which every run hit — left it reading `true`. `commitmentModel.js` now reports
`exhaustive`, `depthTruncated` and `stateCapExceeded` separately, and its suite asserts a
closed search where one is affordable and asserts *truncation* where it is not.

~~**`lifecycleModel.js` still carries the original defect**~~ — **corrected 2026-08-24 by the
Phase 15 third-pass audit (P15-E5).** It was Phase 15's artefact and was left for Phase 15;
this is Phase 15 taking it. What was found is worse than what was recorded here, and both
halves are now fixed:

1. **The reporting**, as recorded: `exhaustive` was set at `maxStates` alone, so the depth
   bound — which every configuration set and every one of them hit — never moved it.
   Measured on the shipped shapes: 1 350 / 12 237 / 37 880 nodes stopped at the bound at
   capacity 1 / 2 / 3, with 26 876 / 348 549 / **1 389 004** successors left unexplored. At
   capacity 3 the unexplored frontier was twenty times the explored space. It now reports
   `exhaustive`, `depthTruncated`, `stateCapExceeded` and `maxDepthReached` separately, as
   `commitmentModel.js` does.

2. **The state space was infinite.** `leg.version` advanced on every applied transition and
   is part of the state key, and unlike `fence` it was **not bounded** — so no search of this
   model could ever close, at any depth, for any shape. One Leg at capacity 1 reached 13 354
   states at depth 640, growing linearly with no convergence. `MAX_VERSION` now bounds it for
   the same reason `MAX_FENCE` bounds the fence; the same shape then closes at depth 40 with
   166 states and no violation. The bound is sound because the version is handed to the
   shipped guard as the *current* value, so it can never make a guard fail — it distinguished
   histories, not behaviours. It does not move any shipped configuration: 5 750 states at
   capacity 1 and 30 531 at capacity 2, before and after.

**What this does not fix.** The shipped configurations at capacity 1, 2 and 3 are still
depth-truncated within a test lane's budget, and `lifecycle.tla` has still never been run
under TLC. So **no exhaustive lifecycle model check exists at any capacity**, by either
checker. `lifecycleModelCheck.test.js` now asserts that truncation rather than a flag that
could not move, and pins the gap explicitly. The consequence for
`model_check_capacity_1_2_3` is in `PHASE_15_REMEDIATION_AND_CLOSURE.md`: exhaustion is now
*possible* rather than impossible, and what it needs is compute.

### Why both forms are kept

They fail differently, and that is the entire argument for the duplication.

- The TLA+ module is checkable **against the specification, by reading**. Its actions are
  written in the specification's own vocabulary, so a safety engineer who has read §4.4
  can confirm that the transition relation is the one §4.4 describes, without reading any
  JavaScript.
- The executable checker is checkable **against the code, by running**. Its transitions
  call the shipped modules — `lifecycle/transitions.js`, `legMachine.js`, `taskMachine.js`,
  `commitment/guards.js`, `fencing.js`, `model.js` — rather than a transcription of them.
  A transcription into a modelling language can be perfectly correct while the
  implementation is wrong. This cannot.

An action added to one without a matching action in the other is a defect in whichever was
not updated. There is no automated check for that correspondence; it is a review
obligation, stated here because an unstated one is not an obligation.

### What closes the gap

Running TLC in CI needs a JDK in the build image and enough memory and disk for the
capacity-2 and capacity-3 queues — the modules and their configurations are complete and
are checked in. The capacity-1 configuration completes in under a minute on a workstation
and is the one to wire up first. Until the larger configurations complete, the
`model_check_capacity_1_2_3` release gate in `Backend/src/engine/cutover/gates.js` is
discharged by the executable checkers plus the two completed TLC runs above, and this file
is the record of exactly what that means.

One correspondence gap, stated rather than left to be noticed: **guard G5** (cancellation,
purpose-conditioned) has no counterpart in either model — neither `commitment.tla`'s
`GuardsPass` nor `commitmentModel.js` models a cancelled Leg, so G5 is vacuous in both. Its
evidence is the unit suite (`commitmentGuards.test.js`, including the counterfactual that an
unqualified guard would block its own mandated recovery path) and the live-database run.
