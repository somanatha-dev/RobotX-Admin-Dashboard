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

> ### Updated 2026-08-31 — `lifecycle.tla` HAS now been run under TLC, twice, and the module was changed between the two runs.
>
> The sentence above ("it has not been run on `lifecycle.tla`") **was true when written and is no
> longer.** It is left in place because the paragraph is dated and the correction belongs beside it,
> not on top of it.
>
> **First pass.** All three `lifecycle_c*.cfg` were run as checked in. **All three aborted on TLC's
> default deadlock check at depth 6**, so `INVARIANT Safety` and `PROPERTY TerminalIsFinal, Liveness`
> **never reached a verdict at any capacity.** That opened two blockers — **X4** (a real safety
> violation the abort was hiding: `CustodyMatchesState` forbade the stranded-with-custody states
> that §4.4 enters under the guard "custody `HELD`") and **X5** (the abort itself).
>
> **Second pass — both were decided by the sole project owner/reviewer and `lifecycle.tla` was
> changed.** There is **no independent safety-engineering or release-owner sign-off**; this is a
> solo project and none was obtained or is claimed.
>
> | Decision | Change |
> |---|---|
> | **X4** — the `STRANDED_*` states **are** custody-bearing | `CustodyLawfulStates` (new) is the invariant's domain; `CustodyBearingStates` keeps its old value and is documented as the **guard** it always was in `Dispute` and `TimerFires`. **No transition changed** |
> | **X5** — terminal deadlock freedom is a genuine §24.2 obligation | New `TaskQuiescent == AllLegsTerminal /\ UNCHANGED vars`, added to `Next`. **`CHECK_DEADLOCK FALSE` was REJECTED and no `.cfg` was edited** |
>
> **Current status of the three lifecycle configurations, run as checked in:**
>
> | Configuration | Result |
> |---|---|
> | `lifecycle_c1.cfg` | **State graph CLOSES** — 8 030 states, 1 909 distinct, depth 27, 0 on queue. `Safety` **PASS**, `TerminalIsFinal` **PASS**, **`Liveness` VIOLATED** |
> | `lifecycle_c2.cfg` | **`Liveness` VIOLATED**; run ends there with 2 474 states on queue. `Safety` clean **in a partial search** |
> | `lifecycle_c3.cfg` | **`Liveness` VIOLATED**; run ends there with 3 722 states on queue. `Safety` clean **in a partial search** |
>
> **The `Liveness` failure is blocker X6**: a Leg can cycle `QUEUED → Plan → Offer → Reject → QUEUED`
> forever and never settle, violating `EveryLegSettles`. **It is pre-existing** — the deadlock abort
> had prevented any liveness property from ever being evaluated — and it is **not** decided yet. The
> likely cause is that this module never transcribed §4.4's `QUEUED` → `FAILED` *"ladder exhausted"*
> row, so there is no bound on re-planning; the §17.4 ladder exists in
> `Backend/src/engine/fairness/` and has **no counterpart here**.
>
> **So `lifecycle.tla` still produces no passing evidence for `model_check_capacity_1_2_3`**, and
> B-M remains open. Full record, with raw output and the before/after retained separately:
> `docs/phase15/PHASE_15_BM_TLC_RUN_RECORD.md` §15.
>
> **A correspondence defect this found, worth stating where the obligation is stated (below).** The
> two checkers had disagreed since Phase 15: `lifecycleModel.js`'s `CUSTODY_BEARING` listed both
> `STRANDED_*` states; `lifecycle.tla`'s `CustodyMatchesState` forbade them. **The review obligation
> at the end of this file is what should have caught it, and it did not, because nothing enforces
> it.** That gap is unchanged.

> ### Updated 2026-08-31, THIRD pass — **X6 was a transcription defect and is CLOSED. `Liveness` still fails, on a new finding, X7.**
>
> The block above says the `Liveness` failure "is **not** decided yet" and names its likely cause.
> **That cause was right, and there were two of them.** The block is left in place because this
> file's convention is that a correction belongs beside the record, not on top of it.
>
> **Two things the block above records are corrected.** The `c1` counterexample is not the
> `QUEUED → Plan → Offer → Reject → QUEUED` cycle — it is a *reassignment* cycle,
> `ACCEPTED → REASSIGNING → QUEUED → PLANNED → OFFERED → ACCEPTED`. (The `Reject` cycle is real; it
> is simply not what TLC emitted.) And **all three `Liveness` conjuncts failed independently**, not
> one. **The state counts are not amended.**
>
> **What X6 turned out to be — the same correspondence failure as X4.** §4.4 has **two** `QUEUED`
> assignment-deadline rows and this module transcribed **neither**; `TimerFires` had no `QUEUED`
> case at all. `lifecycleModel.js` traverses both (`QUEUED--LADDER_EXHAUSTED-->FAILED` is emitted
> from its initial state), the shipped engine implements both end to end
> (`lifecycle/transitions.js:203-217` → `fairness/ladder.js` → `supervision/expiryActions.js` →
> `workers/leaderWorkers.js`), and **no `Backend/` change was needed.** Per the review obligation at
> the end of this file, the defect was in whichever checker was not updated: **this module.**
> Separately, `WF_vars(Next)` — weak fairness on the whole disjunction — does not transcribe
> §24.2's own hypothesis, "**given fair timer firing**".
>
> | Change to `lifecycle.tla` | |
> |---|---|
> | `VARIABLE ladder`, `[Legs -> 0..LadderSteps]`, **monotone — no transition into `QUEUED` resets it**, and **not charged against `MaxTicks`** | §17.4's rung. The shipped ladder reads queue age from `enqueuedAt`, which survives every requeue; §17.4's ladder is finite in the specification, so it carries its own bound |
> | `LadderSteps == 8` — a **definition**, not a CONSTANT. **No `.cfg` supplies it** | §17.4's table has exactly eight rungs, as does `fairness/ladder.js`'s `STEPS` |
> | `LadderAdvance(l)` / `LadderExhausted(l)` | §4.4's two rows, verbatim |
> | `Fairness == WF_vars(Next) ∧ ∀l : SF_vars(LadderAdvance(l)) ∧ ∀l : SF_vars(LadderExhausted(l))`. **`WF_vars(Next)` kept, not replaced** | §24.2's "given fair timer firing". **Strong** fairness because a Leg in a re-plan cycle leaves `QUEUED` between rungs — §17.4: "it advances … **regardless of cost dynamics**". Measured: `WF` is not sufficient |
>
> **No `.cfg` was edited, `CHECK_DEADLOCK FALSE` is still absent, `EveryLegSettles` was not
> weakened, and no boundedness or timeout constant was added.**
>
> **Current status of the three lifecycle configurations, run as checked in:**
>
> | Configuration | Result |
> |---|---|
> | `lifecycle_c1.cfg` | **`Liveness` VIOLATED** — 64 835 / 15 486 / depth 14 / **4 260 on queue**. A *partial* search: TLC stops at the first temporal violation, so `Safety` here is partial too |
> | `lifecycle_c2.cfg` | **`Liveness` VIOLATED** — 2 856 353 / 480 326 / depth 16 / 159 266 on queue |
> | `lifecycle_c3.cfg` | **NO VERDICT — did not converge**, interrupted at a stated budget after ≈54 min; last progress 16 247 475 / 2 388 556 / depth 15 / 1 014 936 on queue, **no violation reported**. **UNKNOWN, not FAIL.** See `docs/phase15/PHASE_15_BM_TLC_RUN_RECORD.md` §16.5a |
>
> **Partial-search counts above are not reproducible between runs** — TLC stops at the first
> violation found by twelve workers, and the same configuration reported different stopping points
> on repeat runs in this pass. **The verdicts were identical every time.** The closed-graph figures
> (8 030 / 1 909 / 27, 676 854 / 156 941 / 43, 662 454 / 156 941 / 43) *are* exact and did reproduce.
>
> **Capacity 3 does not converge because of the state-space cost of the fix, and that is arithmetic
> rather than an excuse:** `ladder` multiplies the space by up to `(LadderSteps + 1)^|Legs|` — 81× /
> 729× / 6 561× at capacity 1 / 2 / 3 — and capacity 1 confirms the factor (1 909 → 156 941 = 82.2×).
> **Neither `MaxTicks` nor `LadderSteps` was reduced to make it converge.**
>
> **One conjunct at a time at capacity 1**, with `INVARIANT Safety` and `PROPERTY TerminalIsFinal`
> retained — **`QueuedLegsProgress` PASSES on a complete state graph**, 676 854 states / 156 941
> distinct / depth 43 / **0 on queue**, with `Safety` and `TerminalIsFinal` also passing. That is
> **the first passing lifecycle liveness verdict this project has produced — at CAPACITY 1 ONLY.**
> `EveryLegSettles` (174 320 / 39 036) and `CustodyNeverLost` (159 731 / 35 834) still fail. **The
> same per-conjunct configuration at capacity 2 does NOT converge** (terminated at a 1 500 s budget,
> last progress 7 809 667 / 1 238 659 / depth 19 / 358 738 queued), and §24.2 makes the configuration
> under check part of the requirement — so this **does not discharge** §24.2's liveness clause.
>
> **They fail on X7, and on nothing else.** A `STRANDED_*` Leg can be cancelled back into
> `ABORTING` and re-stranded for ever, holding custody the whole time. Blocking that one edge as a
> **diagnostic** makes every declared property pass exhaustively — 662 454 / 156 941 / depth 43 / 0
> on queue. **That diagnostic is not checked in and decides nothing:** §4.4's cancel row says "any
> non-terminal", its stranded rows enumerate exits that do not include `ABORTING`, and §24.2 states
> the custody clause unconditionally. **A genuine specification ambiguity, reported rather than
> resolved** — `docs/phase15/PHASE_15_BLOCKERS.md` § **X7**.
>
> **So `lifecycle.tla` still produces no passing evidence for `model_check_capacity_1_2_3`, and B-M
> remains open.** `commitment_c2`/`c3` were not re-run and are unchanged — `commitment.tla` neither
> `EXTENDS` nor `INSTANCE`s this module, so the change cannot affect them. **7 model mutants built,
> 7 killed**, including M1 (revert only the X4 widening → `Safety` violated) and M2 (remove only
> `TaskQuiescent` → deadlock), so both earlier changes are still load-bearing. Full record: §16 of
> the run record.

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

> **Corrected 2026-08-31 (third pass).** Two sentences above are now stale and the correction
> belongs beside them. `lifecycle.tla` **has** been run under TLC — three times on 2026-08-31 — and
> **one exhaustive lifecycle TLC search now exists**: capacity 1, `Safety` + `TerminalIsFinal` +
> `QueuedLegsProgress`, 676 854 states / 156 941 distinct / depth 43 / **0 on queue**, all passing.
> **What remains true, and is the part that matters for the gate:** that run is a *per-conjunct*
> configuration rather than a checked-in one; `EveryLegSettles` and `CustodyNeverLost` still fail
> (X7); no exhaustive lifecycle check of *every* §24.2 property exists at *any* capacity; and the
> **executable** checker's shipped configurations are still depth-truncated at all three
> capacities, exactly as described. `model_check_capacity_1_2_3` is unaffected either way.

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
