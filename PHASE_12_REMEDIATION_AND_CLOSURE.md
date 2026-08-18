# Phase 12 — Remediation and Closure

**Role:** Independent remediation engineer. Did not implement Phase 12 and did not write either of
its prior reports.
**Scope:** `IMPLEMENTATION_EXECUTION_PLAN.md` Phase 12 (line 626 ff. and its checklist) and
`NEXT_GENERATION_ASSIGNMENT_ENGINE.md` §18 (Failure Handling) and §26 (Invariants Register) in full,
re-read verbatim against the frozen document rather than against the implementation.
**Date:** 2026-08-18 · **Branch:** `feature/dashboard` · **Baseline:** the working tree on top of
`63f5c58`, with `PHASE_12_IMPLEMENTATION_REPORT.md` (2026-08-07) and
`PHASE_12_INDEPENDENT_VERIFICATION.md` (2026-08-07, **PASS WITH MINOR ISSUES**, three findings, all
"minor or cosmetic", "**No blocking issue was found**").
**Method:** specification re-read → dependency map → reproduction of every historical finding →
adversarial search for the defect classes prior phases' closures found → fixes → regression tests →
live PostgreSQL 18.3 execution → measurement → full gates and suite.

---

## 1. Final status

# PHASE 12 — CLOSED

**Eleven genuine defects were found and fixed**, of which the prior implementation report and the
prior independent verification between them reported **none**. Both reports were substantially
accurate about the *shape* of what was built — the six modes, the 132-cell matrix, the twenty-two
checks, the step-4 gate, the ten CHECK constraints — and both were wrong in the same way: they
verified the modules and never verified the **composition**. Every defect below lives at a join.

| Class | Count | Where they were invisible |
|---|---|---|
| Checks that could not fail in any composition | 2 (I5, I12) | Unit tests injected the evidence the worker never supplied |
| Guaranteed false pages on a healthy fleet | 2 (I4, I13) | The unit test supplied a context `server.js` does not |
| Dimensionally meaningless comparison | 1 (I17) | A 5-minute count against a fleet-**year** budget |
| Unbounded/incorrect durable writes | 3 (§18.6 sweep ×2, I6 marks) | Every test ran exactly one tick |
| Producer with no production consumer | 2 (advisory key, socket events) | The worker returned them and `server.js` dropped them |
| Mechanism with no production caller at all | 1 (§18.6 `openChain`) | Tested directly, called by nothing |
| Safety-gate weakness at the schema | 1 (step 4 accepted `''`) | Only observable by inserting the row |
| Aggregation that defeated §26.1's third status | 1 (API SLI) | Producer and consumer tested separately |

Plus the three findings the prior verification did report (all still open when this began), and one
prior-report claim that was simply false (the "eleven `D` cells").

**Closure evidence:** 7/7 build gates PASS · 150 suites / 6,604 tests / 0 failures / 0 skips ·
**40/40 live-PostgreSQL checks** on a disposable PG 18.3 cluster with the full migration chain
(24 pre-existing + this remediation's own) applied · measured critical paths against that cluster · no test deleted, skipped or weakened · no
threshold moved · no corpus fabricated.

**Two limitations remain open with named owners, and neither is Phase 12's** (§19). Both were
verified to be outside this phase's plan row before being handed on.

---

## 2. Starting baseline, measured rather than quoted

Run before any change was made:

| | Baseline | Prior report claimed |
|---|---|---|
| Build gates | **7/7 PASS** | 3/3 (there were three gates when it was written) |
| Suites / tests | 150 / 6,579, **1 failure** | 106 / 5,373, 0 failures |
| The failure | `tests/scale/round.scale.test.js` — linearity r² 0.8897 vs 0.9 | — |
| Live database | never applied | "**Not applied to a live database**" (disclosed) |

The one baseline failure is **not Phase 12's**: it is Phase 10's batch-linearity scale test, and it
is load-sensitive — the baseline run shared the machine with this audit's own work, and the same
test passes on every idle run since (r² above threshold). It is recorded here because a closure that
quoted "0 failures" from a run that had one would be the stale-verification pattern the Phase 4 and
Phase 7 closures both found.

The prior reports' figures are not wrong; they are two weeks stale. Phases 13, 14 and 15 landed
after them, and Phase 15 is what makes most of this document necessary: **it started the invariant
worker in production.**

---

## 3. The one fact that changed everything

`PHASE_12_IMPLEMENTATION_REPORT.md` §6 states, and the verification confirms:

> `invariant.worker.js` is not started from `server.js` or `src/app.js` — asserted mechanically, not
> by inspection.

That was true on 2026-08-07. It is false now. `server.js:86` calls
`invariantWorker.start(...)` inside `startScheduledWorkers()`, which Phase 15 added, and the worker's
own header still said "Nothing in `server.js` calls `start()`."

Every deferral in Phase 12's Known Limitations that pointed at "the composition root Phase 15 wires"
therefore came due, and nothing re-examined them when Phase 15 landed. The composition root arrived
and was wired with **two of the worker's three dependencies missing and its entire return value
discarded** — which is not a criticism of Phase 15's row (it says "all engine workers move from
shadow to production scheduling", and it did that) but of the seam between the two, which nobody
owned. This is the same seam class as Phase 8's "three guards written, tested, and never called" and
Phase 9's "three of seven defects on one request path no unit test issued".

---

## 4. Dependency map (Phase 12 requirement → production path)

Built before judging the implementation. `✗` marks a link that was broken when this began.

| §18/§26 requirement | Module | Producer | Consumer | Persistence | API / event | Composition root | Gate |
|---|---|---|---|---|---|---|---|
| §18.5 six modes, 4 rules | `degraded/modeRegister.js` | frozen data | checker, dispatcher, controller | — | `/api/health/modes` | n/a (data) | tiers, params |
| §18.5 entry/exit events | `degraded/transitions.js` | ✗ **no detector calls `enter()`** | worker, controller | `DegradedModeEvent` | `DEGRADED_MODE_ENTERED` ✗ | ✗ | — |
| §18.5 advisory mirror | `transitions.publishAdvisory` | worker | any reader | `engine:mode:{shard}` ✗ | — | ✗ **no `kv` passed** | — |
| §26 twenty-two checks | `observability/invariantChecker.js` | worker | worker, controller | `InvariantStatus` | `/api/health/invariants` | ✓ started | — |
| §26.1 I5 rising baseline | `checkI5` | ✗ **no producer for `previousFenceRejections`** | — | — | — | ✗ | — |
| §26.1 I12 write audit | `checkI12` | ✗ **worker dropped the returned marks** | — | — | — | ✗ | — |
| §26.1 I6 monotonicity | `checkI6` + worker | ✓ | ✓ | `InvariantStatus` (AGENT rows) | — | ✓ | — |
| §26.1 violation SLI | `summarise()` | ✓ | ✗ **API conflated statuses**; metrics null | — | `/api/health/invariants` | ✓ | plan's Phase 12 gate |
| §18.2 A1–A20 | `failure/agentFailures.js` | data | `dtaro.handler` (A5/A6) | — | `ROBOT_UPDATED.classification` | ✓ | — |
| §18.2 A3 dead-zone extension | `deadZoneExtension()` | ✗ **no caller anywhere** | — | — | — | ✗ | — |
| §18.3 B1–B20 | `failure/infraFailures.js` | data | mode register join | — | — | n/a | — |
| §4.3 obstruction class | `map/obstructionClass.js` | escalation, legMachine | ✓ | `Leg.obstructionClass` | — | ✓ | — |
| §18.6 steps 1–3 | `externalEscalation.openChain()` | ✗ **no caller anywhere** | — | `ExternalEscalation` | `STRANDING_ESCALATED` ✗ | ✗ | — |
| §18.6 step 4 gate | `confirmEmergencyServices()` | operator | — | CHECK constraint ✗ **accepted `''`** | — | n/a | — |
| §18.6 step 5 sweep | `invariant.worker.escalationSweepPass` | ✓ | ✓ | `ExternalEscalation` ✗ **exponential** | `STRANDING_ESCALATED` ✗ | ✓ | — |
| §18.5 no commands | `commandDispatcher.deliverOutboxCommand` | ✓ correct seam | outbox worker | — | — | ✗ (outbox is `LEADER_ONLY`) | legacy |

The map is what made the audit tractable: eight broken links, and every one of them a link rather
than a module.

---

## 5. Historical findings, reproduced one at a time

### 5.1 `PHASE_12_INDEPENDENT_VERIFICATION.md`'s three findings

| # | Prior severity | Reproduced? | Disposition |
|---|---|---|---|
| 1 | Minor — `STRANDED_LEG_STATES` compared against a test-file literal, not the domain | **Yes, still present.** `legMachine.js` exported no stranded-state list; `invariantChecker.test.js:92` held `["STRANDED_SAFE","STRANDED_OBSTRUCTING"]` as its own literal | **FIXED.** `legMachine.STRANDED_LEG_STATES` is now *derived* from §4.3's `OBSTRUCTION_DISPOSITION` table, and a new test proves the drift check fails when the domain disagrees — a comparison that cannot fail proves nothing |
| 2 | Cosmetic — migration header says "eight CHECK constraints"; there are ten | **Yes, still present** | **FIXED**, and the live harness now counts them in `pg_constraint`: 10/10 |
| 3 | Cosmetic — `!operator.operatorId` rejects a numeric `0` | **Yes, still present** | **FIXED** to an explicit presence check — and the investigation of it found the *real* defect at the schema layer (§6, D8) |

Finding 3 is worth dwelling on. The prior verification correctly reasoned that the numeric-`0`
weakness "fails **closed** — it would produce a spurious refusal, never an unauthorised call — so it
is not a safety defect". That reasoning is sound and the conclusion was right about the layer it
examined. What it did not do was ask the same question of the *other* two layers, and the schema
layer fails **open** on the neighbouring input: `operatorId = ''` satisfied
`"operatorId" IS NOT NULL` and was accepted by PostgreSQL (§6, D8).

### 5.2 The implementation report's own disclosures

Each was independently checked rather than accepted:

| Report §13 item | Verdict |
|---|---|
| 1. The §26.1 gate is fixture-verified, not production-verified | **Was true and is now false in the worse direction.** With the engine on, the production context produced `pageWorthy: true` on a fleet that is healthy by the specification (§6, D3) |
| 2. The checker's local vocabulary can drift | **Accurate**, and the overstatement the verification identified is now fixed |
| 3. Six checks read streams nothing writes yet | **Accurate for I5, I9, I13, I14, I17, I21's columns** — but I5 was worse than disclosed: it could not report a violation even when the column *was* written (§6, D2) |
| 4. I3's SOFT arm depends on an injected set | **Accurate.** Still the honest position; `shard/failover.js:398` supplies `softReservedLegIds: []`, so a composition exists but is not the checker's caller. Left as disclosed |
| 5. I16 is a corroboration, not the verification | **Accurate**, and stated in the code and the API response |
| 6. §21.4's metric registry not rewired | **Accurate then; the classification had since become actively wrong** (§6, D10) |
| 7. The escalation sweep runs in the invariant worker | **Accurate**, and the sweep is where two of the three worst defects were |
| 8. Migration not applied to a live database | **Accurate. Discharged** — 40/40 checks against PG 18.3 |

### 5.3 One prior-report claim that is simply false

`PHASE_12_IMPLEMENTATION_REPORT.md` §6 states the matrix has "**eleven `D` cells**" and that a
short-circuiting checker "would silently stop verifying eleven live guarantees". §26.2 has **six**:
I2/Unsupervised, I11/Custodial, I13/Custodial, I20/Degraded Routing, I22/Restricted, I22/Degraded
Routing. `modeRegister.MATRIX` is **correct** — it holds exactly those six — so this is an error in
the prose and not in the code, and the parse-the-frozen-document test would have caught a code error.
Recorded here as a correction; the historical report is preserved unedited, per the phase rules.

---

## 6. The eleven defects

Severity is by consequence in production with `ENGINE_ENABLED=true`, which is now a reachable state.

### CRITICAL

**D1 — §18.6 step 5's sweep grew the escalation table exponentially, and never actually cleared a
chain.** `workers/invariant.worker.js`

`escalationSweepPass` iterated every open `ExternalEscalation` **row** and wrote a new row per
iteration, leaving each new row open. One stranding with the three rows `openChain()` produces
therefore became 6 rows, then 12, 24, 48… — one doubling per tick, per stranded agent, for as long as
the agent stayed stranded. Reproduced before the fix, at the real cadence:

```
tick 1: open-at-start=3   total rows now=6
tick 2: open-at-start=6   total rows now=12
tick 3: open-at-start=12  total rows now=24
tick 4: open-at-start=24  total rows now=48
tick 5: open-at-start=48  total rows now=96
tick 6: open-at-start=96  total rows now=192
```

At the registered 60 s interval that is 3·2⁶⁰ rows in an hour. Separately, and worse for correctness:
when the agent *was* moved clear, the sweep set `clearedAt` only on the row that observed the
clearance. Every earlier step stayed open, so the next pass re-evaluated an incident that had already
been resolved — "continuous until cleared" never terminated.

**Root cause.** §18.6 is a chain *per stranding*; the code treated it as a chain per *row*. Both
halves are the same mistake about what the unit of the chain is.

**Fix.** Group open rows by Leg and re-evaluate each chain once; write a row only when the
classification changed or the chain closes; on clearance set `clearedAt` on **every** open row of that
chain. Also — found only by writing the multi-tick test — measure "changed" against the chain's own
last recorded class rather than against `Leg.obstructionClass`, which the sweep deliberately does not
write, and which made one reclassification "changed" on every subsequent pass (a row per tick, the
same defect linearly).

**Why no test caught it.** All four existing sweep tests ran exactly **one** tick.

### HIGH

**D2 — I5 could not report a violation in any composition.** `invariantChecker.js`, `invariant.worker.js`

§26.1 verifies I5 by "fence-rejection counters, reported per scope; **neither may have a rising
baseline**". `checkI5` compared against `context.previousFenceRejections`, which **no caller ever
supplied** — only `invariantChecker.test.js:234` did. `before` was therefore always `null`, the
`before !== null` guard always false, and a Tier 0 invariant was structurally incapable of reporting a
violation. Reproduced: the baseline rose 1 → 3 in the window and I5 reported `ENFORCED`; injecting the
previous window by hand produced `VIOLATED`, proving the check works and the composition did not.

A second permissive path in the same comparison: a scope appearing for the first time was skipped
entirely, so *any* rejection in a new scope was invisible.

**Fix.** The check returns `fenceRejectionsByScope`; the worker carries it between passes in an
explicit `checkerState` object and backs it up in the row's `detail.carry`, so a restart recovers it.
A first pass with no baseline reports `ENFORCED` only when it observed **zero** rejections — zero
cannot be a rise from any non-negative baseline, which is arithmetic and not a guess — and otherwise
reports *not verified* with the reason. An unseen scope now defaults to a baseline of 0, not to
"skip".

**D3 — I12 could not report a violation in any composition, and I4 and I13 pages a healthy fleet.**
`invariantChecker.js`, `invariant.worker.js`, `server.js`

Four checks took their evidence from `context` fields that only the *tests* supplied:

- **I12** (`terminalVersionMarks`) — `checkI12` returned the marks for the caller to persist, exactly
  as I6 does, and `checkPass` persisted **only I6's**. So `marks.get(...)` was always `undefined`, the
  comparison never ran, and terminal-row immutability — Tier 0 — was permanently `ENFORCED`.
  Reproduced: a settled Leg rewritten from v7 to v8 across two real passes reported `ENFORCED`.
- **I4** (`statesWithoutDeadline`) — absent, so a Leg in `LOADED`, which §4.5 gives **no deadline**,
  was reported as having no pending timer.
- **I13** (`ladderBudgetSeconds`) — absent, so the budget defaulted to `0` and *every* queue entry no
  round had yet considered was "past the ladder's total budget".
- **I9/I14/I15/I20** (`productionOnly`) — absent, so §21.6's shadow decision records, "recorded and
  never executed", were audited as though the fleet had executed them.

Reproduced on a fleet that is healthy **by the specification** — a `LOADED` Leg with an active
commitment, and a queue entry enqueued five minutes ago:

```
context as PRODUCTION supplies it:
  I4  = VIOLATED (1) {"legId":"LEG-LOADED","problem":"NO_PENDING_TIMER"}
  I13 = VIOLATED (1) {"legId":"leg-fresh","problem":"QUEUED_PAST_LADDER_BUDGET_AND_NEVER_CONSIDERED"}
  pageWorthy = true    invariantViolations = 2
same world, context the unit test supplies:
  pageWorthy = false   invariantViolations = 0
```

Phase 12's own completion gate is "**invariant-violation SLI is zero in nominal operation**". The
production composition failed it on an empty defect list, which is the failure mode §26.1 spends a
paragraph on: pages that train operators to ignore the register.

**Fix, in two parts.** (a) What is *derivable* now defaults in the worker, so no caller can omit it:
`statesWithoutDeadline` from `legMachine.statesWithoutDeadline()`, `productionOnly` from
`decisionRecord.PRODUCTION_ONLY`. The checker's own import list is untouched — its independence is a
property of *its* module, and the worker is the layer allowed to know both. (b) What is genuinely
configuration stays the caller's, but its absence now makes the check report **unverified** rather
than a verdict, with one exception that is arithmetic rather than optimism: where the observed set is
empty, the comparison's outcome is the same for every admissible budget, so `ENFORCED` is provable.
`server.js` now resolves the rest from the register (`sla.assignment_deadline`,
`energy.event_budget_per_fleet_year`, `invariant.monotonicity_window`,
`map.obstruction_class_max_age`, and §18.6's three `ops.*` entries).

**D4 — I17's comparison was dimensionally meaningless and could not fire.** `invariantChecker.js`

`checkI17` counted shortfall events in the checker's **monotonicity window** (default 5 minutes) and
compared them against `energy.event_budget_per_fleet_year` — a **fleet-year** rate whose registered
defaults are `{T1: 365000, T2: 365, T3: 4}`. 365 events per year is 0.003 events per five minutes, and
no integer count of events in five minutes exceeds 365. The check could not report a violation at any
event rate whatsoever.

§26.1 states the instrument per tier: "T1 by event count over **days**, T2 by event count over
**quarters**". **Fix:** each tier is counted over its own window (7 days, 91 days — transcribed from
the specification and marked `@structural` rather than registered, because re-timing them destroys the
statistical power §26.1 establishes) and the annual budget is pro-rated to it, fractionally. Regression
test: 2 events in a quarter is inside T2's 91-event allowance; 92 is outside. Under the old comparison
`2 > 365` and `92 > 365` were both false.

**D5 — `engine:mode:{shard}` was never written in production.** `server.js`

The one Redis key the plan's Phase 12 row reserves. `startScheduledWorkers` receives `kv` and passed
`{ prisma, onError }` to the invariant worker, so `transitions.publishAdvisory` took its
`no advisory cache configured` branch on every tick. Reproduced: `advisoryPublished = false`.

The failure was silent **by correct design** — `publishAdvisory` returns rather than throws, because
losing an advisory mirror costs visibility and never correctness (§3.3) — which is exactly why nothing
noticed for eleven days. **Fix:** pass `kv`. Regression test asserts the key's payload; the live
harness asserts that a *failing* cache still leaves the durable store as the authority.

**D6 — `INVARIANT_STATUS_CHANGED` and `STRANDING_ESCALATED` had a producer and no wire.**
`server.js`, `invariant.worker.js`

`socketMessages(tick)` built both payloads correctly and **nothing called it**. Reproduced: a tick
produced 22 `INVARIANT_STATUS_CHANGED` messages and discarded all 22.

**Fix:** `runOnce` delivers each message through an optional `deps.emit`, and `server.js` supplies a
sink that emits to the authenticated `dashboard` room. The worker still takes **no** Socket.IO
dependency — `emit` is a function, and the room is chosen at the composition root — so the property
every engine worker since Phase 4 has held is preserved rather than traded away.

**D7 — §18.6's chain had no production caller at all.** `invariant.worker.js` (new pass)

`externalEscalation.openChain()` — steps 1, 2 and 3 of the one response chain §18.6 says "extends
outside the operator" — was called by **nothing but its own test**. Nothing in the tree ever created an
`ExternalEscalation` row for steps 1–3, which also means I22's own audit ("a classification **and a
matching escalation path**") would have reported `VIOLATED` for every genuinely obstructing stranding —
correctly, and for ever.

`supervision/reconciler.js:319` records `escalated: assessment.externalEscalation === true` on a repair
row and calls nothing; `supervision/leases.assessRecovery` returns the flag; both are the right seams
and neither runs in production, because lease renewal and the reconciler are `LEADER_ONLY` workers.

**Fix:** a new `chainOpenPass` in Phase 12's own worker opens the chain for a `STRANDED_OBSTRUCTING`
Leg that has none, idempotently per Leg, recording step 4's *eligibility* on step 1's row and writing
no step-4 row (the schema forbids one without an operator, and this pass must not attempt it). End to
end, against the live database: I22 goes `VIOLATED` → chain opened → `ENFORCED`.

**Honest limitation.** §18.6 marks steps 1–3 "**Immediate**, automatic", and a sweep is not immediate:
a chain opens within one `invariant.check_interval`. The immediate path belongs at the transition site,
which is not composed yet (§19, OPEN-1). One check interval of delay is not "immediate"; it is also not
"no chain", and the difference is stated in the code rather than smoothed over.

**D8 — the schema half of §18.6's step-4 human gate accepted an empty operator.**
new migration `20260818210000`

Found by live execution and by nothing else. `ExternalEscalation_step_four_is_human_gated` was
`"step" <> 4 OR "operatorId" IS NOT NULL`, and PostgreSQL **accepted** a step-4 row with
`operatorId = ''`. The implementation report calls this constraint "the one a future writer cannot
route around by calling a different function"; a writer supplying `''` routed around it.

Reading the DDL could not find this: the constraint is correct *about NULL*, and what is wrong is what
NULL does not cover. The prior verification's seven bypass attempts were all against the **application**
guard, which is the layer that held.

**Fix:** `CHECK ("step" <> 4 OR ("operatorId" IS NOT NULL AND btrim("operatorId") <> ''))`. `btrim`
is deliberate — `'   '` names no operator either. Live harness G2 and G2b now both refuse.

**D9 — the API's zero-target SLI counted suspended findings as violations.**
`controllers/health.controller.js`

`summary.invariantViolations` summed `violationCount` across **every** row. A suspended check keeps its
findings on purpose (`checkOne` retains them, because on mode exit they are the reconciliation input
§18.5 requires), so during a Commitment Store outage the register read "I2 `SUSPENDED`, authorised by
Custodial Operation" and the SLI whose target is exactly zero read one per expired lease. Reproduced:
checker `summarise()` said `invariantViolations: 0`; the controller's aggregation said `1`.

That is precisely the continuous page §26.1 created the third status to prevent, reintroduced one
aggregation later — and it is a producer/consumer disagreement inside a single phase, which is why
testing the producer and the consumer separately could not see it.

**Fix:** count `VIOLATED` rows only, and report `suspendedFindings` under its own name so the
observations are still visible where they cannot be mistaken for violations.

### MODERATE

**D10 — `transitions.enter()` was a read-then-create race that surfaced as an exception.**
`degraded/transitions.js`

Two detectors observing one Commitment Store outage at the same instant both find no open row and both
insert. `DegradedModeEvent_one_open_per_shard_mode` refuses the second — correctly — and that refusal
propagated as a Prisma `P2002` to the **detector**, the component least able to afford one: it would log
an error and move on, having neither entered the mode nor learned that the mode is open. A shard that
believes it may still command while another process has entered Custodial Operation is the failure §18.5
exists to prevent.

**Fix:** resolve the unique violation into the same `alreadyOpen` result the sequential path returns,
after re-reading the winner's row. The swallow is **narrow** — matched on `P2002`/SQLSTATE `23505` — and
a store that is merely down still reaches the caller, because "unavailable" must not look like "already
in the mode". Verified with two genuinely concurrent transactions against PostgreSQL: one `entered`, one
`alreadyOpen`, one open row, zero exceptions.

**D11 — Phase 12's SLIs were `null` with the reason "no producer has landed yet — Phase 12".**
`observability/metrics.js`

Four of these are named as SLIs by the sections that create them, and one is Phase 12's own completion
gate: §18.5 rule 1 ("time spent in each mode is an SLI"), §26.1 (the violation count "whose target is
exactly zero", and the suspension that outlives its box), §26.1 I22 ("response-time SLI per class").
Phase 11 wrote that reason when it was true; Phase 12 landed the three tables and nobody revisited it —
the same misattribution `PRODUCER_LANDED_QUERY_NOT_WIRED` was created to prevent, in the other
direction.

**Fix:** five metrics derived from the durable rows, with a test that drives real rows and checks the
numbers: `degraded_mode_time` (open modes counted at elapsed duration, so an outage is not reported as
zero until it ends), `suspensions_over_time_box` (only modes that suspend something), `invariant_violations`
(`VIOLATED` rows only, carrying `reported`/`expected: 22`/`complete`, because 0 over 3 reported is not 0
over 22), `stranding_events_by_obstruction_class`, `stranding_response_time`.

**Deliberately not wired**, with the reason corrected rather than the query invented:
`outstanding_escalations`, `escalation_saturation_time` and `ladder_step_distribution` are attributed to
"Phase 12 escalation ladder" and are in fact **§17.4's anti-starvation ladder**, which is its own phase's
and which `src/engine/fairness/` still does not contain. `deadzone_extensions_*` have a producing
*function* (`agentFailures.deadZoneExtension`) with **no caller and no durable row**, so there is
genuinely nothing to query (§19, OPEN-2).

---

## 7. Performance — measured against live PostgreSQL, not Jest

`tools/verify/phase12Profile.js`, 500 Legs / 500 agents / 25 missions, PG 18.3 on the disposable
cluster. §20.1 sets **no** target for any Phase 12 path — the targets are round wall-clock and
request-path latency, and none of these is on either — so there is no threshold to pass, and the
measurement exists to answer the one quantitative question the phase does raise: **does a check pass
fit inside its own interval?**

The first measurement said it barely did, and showed why:

| | before | after | change |
|---|---|---|---|
| `checkPass` — steady state | 2,137 ms median | **174 ms** median (204 max) | **12× faster** |
| I3 (orphan scan) | 515 ms | **22 ms** | 2N round trips → 2 set reads |
| I4 (timer cross-audit) | 446 ms | **24 ms** | N round trips → 1 indexed read |
| `persistHighWaterMarks`, nothing moved | 567 ms | **0.6 ms** | ~950× |
| `checkPass` — cold (first pass) | — | 958 ms median (1,345 max) | |

Two of these are genuine defects rather than optimisations:

- **I3 and I4 issued a query per Leg.** §26.1 requires the invariants to be "continuously verified",
  and a pass whose cost is linear in *round trips* stops being continuous at a fleet size §19.2's
  sizing argument treats as small. The set-based form is exactly equivalent — membership in "has an
  unreleased commitment" is what the per-Leg query established one row at a time.
- **I6's marks were upserted for every agent on every pass**, whether or not the counters had moved:
  80 % of the whole pass, an upsert per agent per minute for ever against a table with three indexes.
  A mark that has not moved does not need rewriting, and the audit is the *comparison*, which has
  already happened. A regression test proves a regression is still caught after the skip.

The other paths, all median / max:

| Path | median | max |
|---|---|---|
| `transitions.enter` (one durable row) | 12.4 ms | 15.0 ms |
| `transitions.activeModes` (read per pass) | 2.5 ms | 4.6 ms |
| `modeSweepPass` (time box + advisory) | 6.2 ms | 16.6 ms |
| `chainOpenPass` (§18.6 steps 1–3) | 2.0 ms | 5.6 ms |
| `escalationSweepPass` (§18.6 step 5) | 2.4 ms | 12.6 ms |
| `GET /api/health/invariants` (its two queries) | 4.9 ms | 73.2 ms |
| `GET /api/health/modes` | 3.3 ms | 6.1 ms |

**The honest headroom statement.** Extrapolating linearly from 500 Legs on this hardware, the steady
pass reaches its own 60 s interval at roughly **147,000 Legs** and the cold pass at **22,000**. A shard
sized past that needs a longer `invariant.check_interval` or a checker that shards its own pass. That is
a §3.5 sizing input, recorded rather than assumed away — and it is a linear extrapolation from one
hardware configuration, not a measurement at scale.

---

## 8. Production-path integration evidence

Not "the producer is tested and the consumer is tested". Each of these drives the real producer into the
real consumer:

| Path | Evidence |
|---|---|
| trigger → chain → durable row → checker verdict | `invariantWorker.test.js` "I22 goes from VIOLATED to ENFORCED once the chain the spec requires exists" — real `chainOpenPass`, real `checkAll`, one store |
| mode entry → matrix → checker → status row → API | `degradedTransitions.test.js` §26.2 simulation over all six modes; `healthApi.test.js` against the **real Express app** via supertest |
| check → status change → socket sink | `invariantWorker.test.js` "the socket sink receives every message the tick produced" |
| mode set → advisory mirror → Redis key | `invariantWorker.test.js` asserts the key **and** the payload; live harness M1 asserts a *failing* cache leaves the durable store authoritative |
| two passes → I5 baseline → violation | new regression, and W-series on the live database |
| two passes → I12 marks → violation | new regression, **and** live-database W3/W5 including across a simulated restart |
| eight passes → §18.6 sweep → bounded rows | new regression, and live-database E3 (3 rows after 8 sweeps; 768 before) |
| concurrent entry → unique index → `alreadyOpen` | live-database R1, two genuinely concurrent transactions |

**Where the composition genuinely does not exist, it is named rather than manufactured** (§19). No test
in this remediation constructs a consumer that production does not have.

---

## 9. Live database verification

`Backend/tools/verify/phase12LiveDatabase.js` — new. Disposable PostgreSQL **18.3** on port **55436**,
built from the installed binaries; the pre-existing **24-migration chain** applied in directory order with
`psql -v ON_ERROR_STOP=1` (73 tables created), plus this remediation's own migration
`20260818210000` as the 25th. The harness **refuses to run** against a URL matching
`neon.tech` or `:5432/`, and against no URL at all.

**40/40 checks pass.** Not one aggregate — forty individually reported checks, and every CHECK, FK and
partial index that matters is made to **fire**:

- **T1–T4** — three tables present; **all ten** hand-written CHECKs present in `pg_constraint`
  (the header comment said eight); the idempotence index confirmed **partial**
  (`UNIQUE (shardId, mode) WHERE "exitedAt" IS NULL`).
- **C1–C10** — every one of the ten CHECKs refuses the row it exists to refuse: a seventh mode, an
  unevidenced exit, `I23`, a fourth status, a suspension with no authorising mode, **and its converse**,
  a negative count, an unknown subject type, a step 6, an unknown disposition.
- **I1–I3** — one open row accepted; a second refused; **and the shard can re-enter a mode it has
  exited**. That last is the half a non-partial index would silently break — it would lock a shard out
  of Custodial Operation for ever — and no in-memory double would notice.
- **R1** — two genuinely concurrent `enter()` calls: 1 open row, 1 `entered`, 1 `alreadyOpen`, 0 thrown.
- **A1** — an empty `suspendedInvariants` round-trips as `[]`, not NULL: "suspended nothing" stays
  distinguishable from "nobody wrote it down".
- **U1–U2** — the upsert key collides as intended; a BigInt mark of **2⁵³+1** round-trips exactly (the
  first integer a double cannot hold, so a silent coercion would be visible).
- **G1–G3** — step 4 refused with NULL, refused with `''`, refused with `'   '`, accepted with a named
  operator.
- **E1–E5** — the real `chainOpenPass` writes steps 1–3 and no step 4; a second pass adds nothing;
  **eight sweeps add zero rows**; clearance closes every open row of the chain; the §4.4 transition the
  sweep may *not* perform is reported rather than implied.
- **D1** — deleting a Leg CASCADEs its escalation rows.
- **W1–W6** — the production check pass runs all 22 checks and persists 22 rows; a second pass upserts
  rather than duplicating; **I12 fires across two real passes**; the carries survive; **a restarted
  worker still detects the next modification from the stored row alone**.
- **M1** — a failing advisory publish leaves `DegradedModeEvent` as the authority (§3.3).

One check (**G2**) **failed on the first run** and is the reason migration `20260818210000` exists.
Reported as a failure, fixed, re-run.

---

## 10. Redis verification

Phase 12 owns one advisory key. The properties that matter are behavioural, and all three are tested:
the key is written with its TTL when a cache is supplied (regression test asserts key **and** payload);
a **failing** cache leaves the mode set coming from `DegradedModeEvent` (live harness M1); and nothing
in `transitions.js` ever reads the mode back from the cache — the pre-existing source scan for `kv.get`
still holds, which is §18.5 rule 3 applied to the register's own implementation. Multi-worker
propagation is not applicable: the key is a mirror, not a channel, and no Phase 12 path subscribes.

---

## 11. Concurrency verification

| Scenario | Result |
|---|---|
| Two workers enter the same mode simultaneously | **Was a thrown `P2002`; now `alreadyOpen`.** Verified with two real concurrent transactions (R1) |
| Two workers enter *different* modes | Both open; `resolveBehaviour` resolves `S` > `D` > `E` across the set (pre-existing test) |
| Concurrent close | Surfaced to the caller via `updateMany.count !== 1` rather than swallowed (pre-existing, unchanged) |
| Mode re-entry after exit | **Verified against the partial index** (I3) — the case a plain unique index would break |
| Two passes racing on I6's marks | Marks never retreat; a regression holds the mark and reports `VIOLATED` |
| Duplicate escalation from repeated observation | `chainOpenPass` is idempotent per Leg (E2) |
| Duplicate socket emission | `INVARIANT_STATUS_CHANGED` fires on **change**, not per pass (pre-existing, retested through the new sink) |
| Restart mid-verification | I5's baseline and I12's marks recovered from the durable row (W5, W6) |

**Not verified, and named:** the escalation sweep is **not shard-scoped** — `ExternalEscalation` carries
no `shardId`, so two shard processes would each re-evaluate every open chain. It is idempotent per pass
and writes only on change, so the consequence is duplicated *work*, not duplicated escalation. Adding
the column requires the shard membership Phase 13 owns; recorded as OPEN-2 rather than papered over.

---

## 12. Security and privacy verification

- **Both REST routes require authentication.** `router.use(authUser)` before either handler; verified
  through the real Express app.
- **The socket audience is authenticated.** `io.to("dashboard")` — and `socket.server.js:196-207`
  rejects and disconnects any dashboard socket without a verified user token. The new emit sink adds no
  new audience.
- **The event payloads carry no operational detail that the durable row carries.**
  `STRANDING_ESCALATED` carries `legId`, class, state, hazard state, steps emitted and the gating flag;
  the position, custody manifest, agent condition and physical access instructions §18.6 step 1
  requires stay in the durable row's `detail`, reachable only through the authenticated API. That
  separation was already right and was preserved deliberately.
- **`/health` remains a summary.** The unauthenticated probe still carries the mode list, the union of
  suspended invariants and three counts, and a pre-existing test asserts the entry **cause** does not
  appear there. Unchanged.
- **The privacy gate passes** — 16 modules in the cost and decision-record scopes hold no identifying
  field. §18.6's rows are outside that scope by design: §18.6 step 1 *requires* position and manifest.
- **Step 4 cannot be reached without a named operator** at three layers, and the schema layer is now
  actually one of them (D8).

---

## 13. Files changed

**Modified (9 source, 1 migration comment):**

| File | Change |
|---|---|
| `Backend/src/engine/observability/invariantChecker.js` | I5 carry + provable-zero honesty; I13 and I17 unverifiable-vs-provable; I17 per-tier timescales and pro-rated budget; I3 and I4 set-based; I12 detail states its own comparability. **Import list untouched** — independence preserved |
| `Backend/src/workers/invariant.worker.js` | `defaultContext`, `seedCheckerState`, cross-pass carries, `chainOpenPass` (new), escalation sweep rewritten, `deps.emit` sink, marks written only when moved |
| `Backend/src/engine/degraded/transitions.js` | `enter()` resolves the unique violation into `alreadyOpen`; `isUniqueViolation` exported |
| `Backend/src/controllers/health.controller.js` | SLI counts `VIOLATED` only; `suspendedFindings` added |
| `Backend/src/engine/observability/metrics.js` | Five Phase 12 SLIs derived; `INVARIANT_COUNT` |
| `Backend/src/engine/failure/externalEscalation.js` | Operator presence check instead of truthiness |
| `Backend/src/engine/lifecycle/legMachine.js` | `STRANDED_LEG_STATES` **derived** from §4.3's disposition table and exported |
| `Backend/server.js` | `kv`, `io`, the emit sink, and the resolved check context passed to the worker |
| `…/20260807090000_…/migration.sql` | Header comment: "eight" → "ten", with the correction noted |

**Created:**

- `Backend/prisma/migrations/20260818210000_step_four_gate_requires_a_named_operator/migration.sql`
- `Backend/tools/verify/phase12LiveDatabase.js` (40 checks)
- `Backend/tools/verify/phase12Profile.js`
- `PHASE_12_REMEDIATION_AND_CLOSURE.md`

**Tests changed:** `invariantWorker.test.js` (+13), `invariantChecker.test.js` (+1),
`degradedTransitions.test.js` (+2), `healthApi.test.js` (+1), `observabilityMetrics.test.js` (+1),
`helpers/roundFixture.js` (four Phase 12 tables, backed by real arrays rather than `return []` stubs —
a metric derived from a table the double cannot represent fails as "the derivation query failed", which
reads identically to a metric nobody wired).

**Three existing assertions were changed. None was weakened; each encoded a defect:**

1. `invariantWorker.test.js` — "re-evaluates every open chain and **writes the outcome as a new step
   row**" required a row per pass. That requirement *is* D1. Replaced by: no row when nothing changed, a
   row when the class changes, and the multi-tick growth regression.
2. `invariantWorker.test.js` — "closes the chain when the agent is moved clear" checked only the new
   row's `clearedAt`. Strengthened to assert no row remains open **and** that a second sweep finds
   nothing.
3. `observabilityMetrics.test.js` — asserted `invariant_violations` reports "no producer has landed
   yet". That pinned a stale schedule fact in place, which is the failure mode the test itself was
   written to catch. Replaced by asserting the metric is derived, with `duty_cycle_gini` — genuinely
   unlanded — carrying the unlanded assertion.

---

## 14. Gates

`npm run gates`, exact output, all seven:

```
tier-dependencies (§1.8 rule 2)   PASS — 277 modules, 390 governed edges, 0 Tier 0/1 → Tier 2
parameter-register (§22)          PASS — 183 modules, 242 registered params, 0 bare constants
tenets (T1, T6)                   PASS — 274 modules, 0 violations
identity-isolation (§23.7)        PASS — 16 modules, no identifying field, no address in any cost term
reconstruction-equivalence        PASS — 3 corpus decisions, byte-for-byte from Tier A alone
legacy-retirement (Phase 15)      PASS — 4 retired modules absent, 320 files checked
column-generation (§21.6)         PASS — NOT_REQUIRED, blob-pinned release-owner classification
```

The parameter-register gate **failed** mid-remediation on five new numeric literals and was fixed by
annotating them, not by relaxing the gate: `TIER_WINDOW_DAYS` (§26.1's own timescales),
`DAYS_PER_YEAR`, `MS_PER_DAY`, the two unique-violation codes, `INVARIANT_COUNT`. Two edges and three
modules were added to the tier gate's count by the worker's new imports of `legMachine` (Tier 0) and
`decisionRecord` (Tier 1); no Tier 0/1 → Tier 2 edge was created, and **the checker's own import list
is unchanged at one module**.

## 15. Full test results

```
Test Suites: 150 passed, 150 total
Tests:       6604 passed, 6604 total
Snapshots:   0 total
Ran all test suites in 5 projects.
```

Exit code 0. **0 failures, 0 skipped, 0 todo.** Baseline was 6,579 with 1 failure; +25 tests, and the
baseline's one failure was Phase 10's load-sensitive scale test, which passes on every idle run.

By lane, Phase 12's own files: `invariantWorker` 32, `invariantChecker` 44, `degradedTransitions` 37,
`degradedModeRegister`, `degradedSchema`, `externalEscalation`, `failureCatalogue`,
`mapObstructionClass`, `healthApi` 18.

---

## 16. Scope determinations — three sections of the brief that do not map onto this phase

Recorded because "we found nothing" and "there is nothing here" are different statements:

- **"Dependency registry"** is not a Phase 12 artefact in this specification. The nearest things are
  §5.2's dependency-contract table (latency budget, timeout, failure behaviour, envelope reduction) and
  §18.3's B1–B20 catalogue. B1–B20 is implemented in `failure/infraFailures.js` with detection,
  response, envelope reduction and mode join, and `catalogue.js` asserts the join to the mode register
  is total in both directions. §5.2's **latency budgets and timeouts are unimplemented anywhere in the
  tree**, because no dependency *transport* exists — every client (forecast, pricing, routing) is a pure
  function over supplied data and implements the *behaviour* and *envelope* columns via degradation
  ladders and staleness. Owner: the phase that introduces the transports. Phase 12's row names none of
  them, and nothing here regressed it.
- **"Circuit breakers"** appear **once** in the frozen specification — §23.1's threat-model mitigation
  column for denial of service — and are named in no phase's row. The nearest implemented mechanisms are
  B20's poison-input quarantine (`crashCount >= failure.poison_quarantine_threshold`, verified as a real
  threshold comparison) and §16.4's health-tier quarantine, which is Phase 16's. There is no
  CLOSED/OPEN/HALF_OPEN state machine in this design, and inventing one would have been implementing an
  architecture the frozen document does not have.
- **"A3 handling"** exists and is correct as a decision function — it refuses a `MEAN` statistic by
  name, refuses an unresolved cap rather than defaulting it, and restores supervision only on a
  corroborated exit — and has **no production caller** (OPEN-2). Its natural caller is lease renewal,
  which is not composed.

---

## 17. Phase 11 handoffs

Reviewed each; fixed only what Phase 12 owns.

| Phase 11 open item | Phase 12-owned? | Disposition |
|---|---|---|
| 39 producer-landed-but-unwired metrics | **Partly** | The five Phase 12 SLIs the spec names are now derived (D11); the three §17.4 ladder metrics were **misattributed to Phase 12** and are corrected in prose, not wired; the `deadzone_*` three have no producer to query (OPEN-2). The other phases' remain theirs |
| Tier A > 2 KB | No | Phase 11's sizing requirement |
| Audit high-water anchor | No | Phase 11's `auditStream.js` |
| Missing event-type call sites | No | Phase 11's |
| Missing process-level SLI registry | No | Phase 11's `sli.js`; the invariant worker takes no registry and needs none |
| Phase 0 scaffold test | No | Phase 0's; `PHASE_12_OWNED` row present and passing |
| Migration comment | **Yes** | Fixed (D-cosmetic) |
| BLOCKER-1 / release-owner classification | No | Discharged in `PHASE_11_REMEDIATION_AND_CLOSURE.md` §20; the column-generation gate reports NOT_REQUIRED on that blob-pinned classification |

---

## 18. Corrections to the historical reports

The historical reports are **preserved unedited**. Recorded here instead:

| Claim | Where | Correction |
|---|---|---|
| "§26.2's **eleven** `D` cells" | impl. report §6 | There are **six**. `MATRIX` is correct; the prose is not |
| "the eight CHECK constraints at the foot of this file" | migration header | **Ten**. Fixed in place, with the fix noted in the file |
| "`invariant.worker.js` is not started from `server.js`" | impl. report §6 | True on 2026-08-07; **false since Phase 15**. The worker's own header said so too and is now corrected |
| "`assertVocabularyAgreesWithDomain()` compares the two at build time, so independence costs nothing in drift" | impl. report §10 | Held for two of three constants. The prior verification caught this (Finding 1); now true for all three |
| "the schema constraint … the one a future writer cannot route around" | impl. report §5 | Was routable around with `operatorId = ''` (D8). True now |
| "All 19 items are independently confirmed" | verification §1 | Items 8, 11, 12, 13, 16 and 19 were confirmed **as modules** and were broken **as compositions**. The confirmations are not false; their scope was narrower than the checklist items |

---

## 19. Remaining open issues

Two, both verified as outside Phase 12's plan row before being handed on.

**OPEN-1 — §18.6 steps 1–3 open within one check interval rather than "immediately", and the §4.4
de-escalation has no writer.**
*Owner: whichever phase composes lease renewal and the reconciler — the shard supervisor's leadership
lifecycle (Phase 13's row) or Phase 15's cutover.*
The immediate path is `supervision/leases.assessRecovery` → `supervision/reconciler.js`, both of which
already compute `externalEscalation: true` and neither of which runs in production, because they are
`LEADER_ONLY`. Phase 12's sweep is the difference between a bounded delay and no chain at all. The
de-escalating direction is deliberately not written by the sweep: §4.4's
`STRANDED_OBSTRUCTING → STRANDED_SAFE` carries `GUARD.CORROBORATED_POSITION`, and fresh map data is not
a corroborated position fix — so the sweep reports the transition as *admissible*
(`admissibleTransitions`, verified live at E5) and leaves it to a caller that holds the evidence.

**OPEN-2 — three mechanisms are correct, tested, and have no production caller.**
*Owners named individually.*
(a) `agentFailures.deadZoneExtension()` / `restoreSupervision()` — §18.2 A3. Caller would be lease
renewal (**not composed**; same owner as OPEN-1). Until then `deadzone_extensions_*` have nothing to
query, and no durable row records a granted extension.
(b) `supervision/leases.renew()` — including Phase 12's own `storeAvailable === false` halt and
`custodialDirective()`. Same owner. Phase 5's composition debt, not Phase 12's.
(c) `commandDispatcher.deliverOutboxCommand`'s Custodial Operation refusal — the gate is at the correct
single exit (§4.1 rule 5) and its only caller is the `LEADER_ONLY` outbox worker, which `server.js`
deliberately does not start (§19.3: "a standby process that drained an outbox would be a second
writer"). The gate is right; the drain is not composed.
Also recorded: `ExternalEscalation` carries no `shardId`, so the sweep is fleet-wide. Consequence is
duplicated work, not duplicated escalation. Adding the column needs Phase 13's shard membership.

**Not open, and worth stating so:** the §26.1 gate — "the invariant-violation SLI is zero in nominal
operation" — is now **passable and passing** in the production composition on a healthy fleet, which is
strictly more than the prior report could claim (§13 item 1). What it still cannot be is *observed over
production traffic*, because no shard has run a round. That remains Phase 15's release gate, and it is
now a report rather than a hope.

---

## 20. Phase boundary

**No Phase 13 work.** Nothing in `src/engine/shard/` was touched; no `Shard`, `ShardMembership`,
`CrossRegionSaga` or `TransferPoint` model was added or altered. (Phase 13 has since landed on its own;
this remediation did not enter it.)

**No §17.4 ladder work.** `src/engine/fairness/` holds no ladder, and the three metrics misattributed to
Phase 12's "escalation ladder" were deliberately **not** wired for exactly that reason.

**No Phase 15 work.** `server.js`'s change is confined to the arguments of one `start()` call and one
emit sink; no worker was added to or removed from the schedule, no `LEADER_ONLY` worker was started, and
`cutover/` was not touched.

**One file outside Phase 12's row was modified**, minimally and for a Phase 12 reason:
`lifecycle/legMachine.js` gains a derived `STRANDED_LEG_STATES` export so that the checker's drift check
compares against the domain rather than against a test-file literal — which is the prior verification's
own Finding 1, and cannot be fixed inside the checker without breaking its independence.

**Specifications unchanged.** No `.md` in `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` or
`IMPLEMENTATION_EXECUTION_PLAN.md` was edited. Historical phase reports are preserved unedited.

---

## 21. Recommendation for Phase 13

Phase 13 has already landed in this tree, so the recommendation is addressed to whoever audits it next.

1. **Audit the composition, not the modules.** Every one of the eleven defects here was at a join, and
   both prior reports read every source file in full. The question that finds these is not "is this
   module correct" but "**who calls it, with what, and what happens to what it returns**". Three of the
   eleven were producers whose return value the composition root discarded.
2. **Check every `context.` field a module reads for a production producer.** `grep` for the field name
   across `src/` and `server.js`; if the only hits are the module and its test, the code path is dead in
   production. That single check would have found D2, D3 and D4.
3. **Run every stateful mechanism for more than one tick.** All four escalation-sweep tests ran once;
   the defect was visible on the second tick and catastrophic by the sixth.
4. **Take the live database as mandatory, not as a bonus.** D8 — a weakness in the safety-critical gate
   of this entire phase — is invisible to source review, to `prisma migrate diff`, and to every
   in-memory double. It took one `INSERT`.
5. **Re-examine every deferral when the phase it was deferred to lands.** "Phase 15 owns the
   composition root" was correct when written and became a defect the day Phase 15 shipped. Nothing in
   the process re-opened it. A closure document that names a *phase* as an owner should be re-read when
   that phase closes.
6. **Phase 13's specific exposure:** `shard/leadership.js`, `election.js` and `shardSupervisor.worker.js`
   are exactly the composition that OPEN-1 and OPEN-2 are waiting on. Verify that the `LEADER_ONLY`
   workers it starts pass their full dependency sets — `kv`, an emit sink, and a resolved context — and
   not the two-field subset the invariant worker was given.

---

*End of Phase 12 Remediation and Closure.*
