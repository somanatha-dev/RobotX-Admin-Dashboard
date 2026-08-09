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

**TLC has not been run in the implementation environment.** There is no Java toolchain
there. This has been recorded in every phase report since Phase 3 rather than glossed, and
Phase 15 does not change it: a release gate is worth exactly as much as the honesty of its
status, and "the TLA+ module exists" is not "the TLA+ module was checked".

§24.2 permits "TLA+ **or an equivalent model checker**", and the equivalent checkers *have*
been executed, exhaustively, at capacity 1, 2 and 3, on every build:

| TLA+ module | Executable equivalent | Driven by |
|---|---|---|
| `commitment.tla` | `Backend/tests/engine/helpers/commitmentModel.js` | `Backend/tests/engine/commitmentModelCheck.test.js` |
| `lifecycle.tla` | `Backend/tests/engine/helpers/lifecycleModel.js` | `Backend/tests/engine/lifecycleModelCheck.test.js` |

Both are explicit-state checkers with a visited set over canonical state serialisations.
Each reports whether it **exhausted** the state space or hit its depth bound, and each
test asserts exhaustion — because a truncated search is not a proof and must not be
reported as one.

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

Running TLC in CI needs a JDK in the build image and nothing else — the modules and their
configurations are complete and are checked in. Until then, the `model_check_capacity_1_2_3`
release gate in `Backend/src/engine/cutover/gates.js` is discharged by the executable
checkers, and this file is the record of what that means.
