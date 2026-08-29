# Phase 15 — Final Implementation and Closure Report

**Date:** 2026-08-21
**Branch:** `feature/dashboard`
**Baseline commit:** `e5c9655` ("phase 14 closed")
**Verdict:** **PHASE 15 BLOCKED — PHASE 16 NOT READY**

> ### ⚠ PARTIALLY SUPERSEDED — read `PHASE_15_REMEDIATION_AND_CLOSURE.md` (2026-08-22) with this
>
> That document is the successor and it corrects this one on four points. This report is
> left unedited apart from this notice, because a report that is quietly rewritten to look
> right is the failure mode this whole exercise is about. What changed:
>
> | This report says | Now |
> |---|---|
> | **D-6** (socket handlers read half the switch) — reported, not fixed | **FIXED.** `cutover/agentGate.js` evaluates the full conjunction; all five handlers call it; identity is bound at AUTH and refreshed. Verified fail-closed on null snapshot, missing env, stale identity, and a throwing resolver. |
> | **D-7** (rehearsal/cutover circularity) — reported, needs an ADR | **FIXED** under **ADR-34**. `authoriseEnable` gains a `REHEARSAL` purpose that requires a declared non-production environment and sets aside **exactly one** gate. Verified: a production-purpose enable is still refused, and a rehearsal cannot set aside any other gate. |
> | **D-5 / D-4** classified as "**in-repository**, fixable here" | **Misclassified.** `outbox` and `reconciler` are now wired via `workers/leaderWorkers.js`. `coordinator` cannot be composed because the decision path bottoms out in a **routing engine B1 has not selected** — an external dependency, not unfinished wiring. |
> | Composition-root gate: 4 violations | **2**, and the gate now distinguishes `LEADER_ONLY_UNREACHABLE` (a commit fixes it) from `LEADER_ONLY_NOT_COMPOSABLE` (a dependency does not exist). |
>
> One finding is **new** and appears only in the successor: **§4.5 timer expiry semantics are
> unimplemented** — sixteen `on expiry` actions are declared across `legMachine.js` and
> `taskMachine.js`, and none has an implementation under `src/`. Independently verified.
>
> The verdict — **BLOCKED, Phase 16 not ready** — is unchanged, and the successor's reasoning
> for it is stronger than this one's.

---

## 1. Executive summary

Phase 15 is **not complete**, and the reason it is not complete changed during this work.

The repository arrived in a state that looked finished: 151 test suites and 6 741 tests
green, every build gate passing, a twenty-three-row release-gate table, a staged cutover
controller with five refusals, runbooks, a safety case, and honest tooling that refused to
fabricate B1 routing evidence. The single known blocker was calibration — 39 Safety-class
parameters awaiting data the fleet cannot produce before it operates.

That picture was wrong in one structural way and several specific ones. **The release gate
that the entire phase exists to install was not enforcing anything.** `gates.evaluate()`
read `record.pass === true` and asked no further question, and nothing in the repository
ever produced a record — `req.app.locals.releaseEvidence` was read in two places and
assigned in none. Twenty-three hand-typed booleans authorised a real cutover:

```
for (const gate of RELEASE_GATES) fake[gate.id] = { pass: true, detail: "looks fine to me" };
→ authorised: true, binding { level: "region", name: "cutover.engine_enabled", value: true }
```

Underneath that, a second finding: **the engine's Tier 0 decision path is not wired into
the composition root at all.** `coordinator.worker` (the round loop: "drain the queue,
generate, gate, price, solve, commit"), `outbox.worker`, `reconciler.worker` and
`timer.worker` are required by nothing outside tests. Every test drives them with a
hand-built dependency object, which is why 6 741 tests passed over an engine that does not
run.

Eight defects were found. **Four are fixed at the root, with regression and adversarial
tests, and the fixes were themselves attacked and mutation-tested** — including one defect
in the fix, caught by running it end to end. Four are reported with mechanical
demonstrations and left unfixed for stated reasons: three are substantial integration or
contract work that should not be improvised, and one is a contract change requiring an ADR.

The measured verdict, from `npm run release:gates` run to completion on an unmodified tree:

```
16 green, 1 red, 7 not evaluated  →  RELEASE: BLOCKED  (exit 1)
```

Sixteen gates are green **for the first time on evidence rather than on assertion** — each
carries the exit code of a command that actually ran, bound to a digest of the tree it ran
against. One is red: the Tier 0 decision path is not wired. Seven are not evaluated, and no
build can close any of them.

The work did **not** make anything green that was not already true. It made the green
mean something, made the red honest, and made several things red that had been quietly
passing.

---

## 2. Initial actual state (measured, not read from reports)

| Check | Result at baseline |
|---|---|
| `npm test` | 151 suites, 6 741 tests, **all pass** |
| `npm run gates` | **PASS** (7 build gates) |
| `npm run gate:calibration` | **FAIL** — 39 blocking findings; 242 entries, 52 DERIVED, 152 PROVISIONAL, 38 UNCALIBRATED, 54 Safety-class |
| `npm run safety:case` | exit **0** — while printing "release gates: 0 green, 0 red, 23 not evaluated" |
| `npm run sim:fidelity` | exit **0** — while reporting all 7 models `NOT_MEASURED`, 5 of them safety-relevant |
| `node tools/routing/b1Readiness.js` | **BLOCKED** on D1/D3/D8; correctly refuses to fabricate |
| `npm run release:gates` | shell conjunction of 5 commands; `sim:fidelity` not among them |
| Release-gate evidence producer | **none existed** |

Java 20 is present in this environment, so the earlier "no Java toolchain" limitation on
formal verification no longer applies; `formal/README.md` already records that TLC has been
run on `commitment.tla` and not on `lifecycle.tla`.

---

## 3. Every finding

### D-1 — Calibration gate: a one-word edit satisfied it (FIXED)

`tools/gates/checkCalibration.js:hasSubstantiation` accepted `(section && requiredBy)` as
proof that a `DERIVED` claim had a source. Both fields are the register's **universal
cross-reference convention** and are carried by essentially every row, so the check was
inert for exactly the entries it existed to protect.

**Attack.** Copy the register, flip all 39 Safety-class non-`DERIVED` entries to `DERIVED`
— one word each, nothing else changed. 28 were caught. **11 passed the gate clean:**

```
energy.model_residual_cv                        map.obstruction_class_max_age
ops.emergency_services_hazard_threshold         ops.external_escalation_contacts
payload.mass_discrepancy_tolerance_kg           security.attestation_max_age
security.certificate_revocation_recheck_interval security.energy_rate_tolerance
security.implausible_report_quarantine_threshold security.position_plausibility_tolerance
shard.store_round_trip_budget
```

Among them the kinematic ceiling on position reports and the emergency-services escalation
contact set. No owner, no source data, no evidence window and no approval was required.

**Fix.** The fallback is no longer available to a Safety-class entry. §22.4 defines the
status as "`DERIVED` (from a stated accounting or measured source)", and a cross-reference
is neither; the row must *state* its derivation, in the row. Re-attack: **0 escape.**

The thirteen Safety-class entries legitimately holding `DERIVED` today were unaffected —
nine Tier 2 kill switches cite §1.8 rule 3, which fixes their value directly, and
`agent.dedup_retention` records a measured span.

**Side finding.** The stricter rule surfaced two entries genuinely claiming `DERIVED` with
no stated derivation: `security.elevated_roles` and
`security.second_approver_action_classes`. Both already carried the derivation reasoning in
their `description` — citing §23.4/§23.6 and the pre-register constant the value came from.
The reasoning was moved into an explicit `derivation` field. **No value was invented and no
status was changed.**

### D-2 — Two tools exited 0 while reporting failure (FIXED)

`tools/simFidelity/validate.js` computed `ok = failed.length === 0`, counting only models
it had *measured* and found biased. With no study supplied, nothing is measured, nothing
fails, and the process **exited 0** while printing that five safety-relevant models were
`NOT_MEASURED`. The module separately computes `mayDischargeTierZero`, which accounts for
unmeasured models, and the comment at its definition explicitly anticipated "a caller that
only checks `ok`". Line 356 was that caller.

**Fix.** The exit code is now `mayDischargeTierZero`. Verified: exits **1**.

`tools/safetyCase/assemble.js` exits 0 on "23 not evaluated", but its `ok` is about whether
every hazard reference resolves — a different and fair question. It was left alone; the
release verdict (below) is what aggregates.

The combined consequence was the real defect: `npm run release:gates` was
`gates && gate:calibration && test:chaos && test:scale && safety:case`. It touched evidence
for fewer than half the table, omitted `sim:fidelity` entirely, and nothing anywhere
returned non-zero because a gate was `NOT_EVALUATED`. **Discharge calibration and that
chain exits 0 with six blocking gates never evaluated.**

### D-3 — No release-evidence producer; fabricated evidence authorised a cutover (FIXED — root defect)

`cutover/gates.js` argues, correctly, that "a release gate recorded in prose is a gate that
is satisfied by someone writing that it is satisfied", and makes each gate an object. The
argument was applied one level too high: the *gate* stopped being prose, the *evidence* did
not.

**Attack.** 23 records of the form `{ pass: true, detail: "looks fine to me", source: "trust
me" }` → `stage.authoriseEnable()` returned `authorised: true` and produced a publishable
binding of `cutover.engine_enabled = true`. No run, no exit code, no timestamp, no identity,
no configuration version was required by anything.

**Fix — `src/engine/cutover/evidence.js`** (new, Tier 0 by consequence): an admission
contract, keyed off the evidence taxonomy `gates.js` already declared.

- **BUILD / SUITE** — a *run record* is required: the command, its exit code, when it ran,
  and the source state it ran against. `pass` is **derived** from `exitCode === 0`, never
  read, so a producer cannot report success for a failing command. The command must match
  the gate's declared command. The record is bound to a digest of the tracked source, so
  "satisfy the gate, collect the evidence, restore the file" is refused. Records expire.
- **PRODUCTION** — a run record is **refused**, not ignored: a build emitting one would be a
  build closing a gate that requires the fleet to have operated. An observation window,
  its source and an owner are required, and for `shadow_agreement` and `soak` the window
  must meet the duration the **register** states (`cutover.shadow_agreement_window`,
  `release.soak_duration`). A bound that does not resolve **refuses the gate rather than
  unbounding it**.
- **ORGANISATIONAL** — a named recorder and a **distinct** approver. Where the gate declares
  a machine-checkable command (`calibration_safety_derived`, `safety_case_assembled`), a
  **corroborating run that exited 0** is required alongside the two signatures: an
  attestation cannot outrank the check it is an attestation about.

An inadmissible record is `RED`, not a fourth status — `gates.js` already defines `RED` as
"evidence was supplied and it does not satisfy the gate", and a record nobody can rely on is
precisely that. `NOT_EVALUATED` stays reserved for "nobody ran it".

**Fix — the producer and the judge** (new, `Backend/tools/release/`):

| Tool | Role |
|---|---|
| `sourceDigest.js` | Stable SHA-256 over `src/`, `tools/`, `tests/`, `package.json`, `jest.config.js` (542 files, 0.2 s). Documentation is deliberately out of scope: a gate verdict must not change because a runbook was reworded. |
| `collectEvidence.js` | **Runs the gates** and records exit codes with provenance. Emits `BUILD`/`SUITE` records only; files the two runnable `ORGANISATIONAL` commands as *corroboration*, which discharges nothing on its own. Dedupes identical commands. Exits non-zero if any gate it ran failed. |
| `verdict.js` | Judges the **whole** table through `gates.evaluate()` with the binding context, and exits non-zero unless every blocking gate is `GREEN`. `NOT_EVALUATED` is not a pass. |

`npm run release:gates` is now `node tools/release/verdict.js --collect` — one aggregator
rather than a shell conjunction, because a conjunction short-circuits and would skip the
verdict on exactly the runs whose verdict matters most.

**Re-attack:** the fabricated set is refused; `authoriseEnable` returns
`RELEASE_GATE_NOT_GREEN`. **Mutation-tested:** reverting `evaluate()` to trust `record.pass`
makes the headline test fail, then restored.

#### D-3b — a defect in the fix, found by running it (FIXED)

The first full `npm run release:gates` returned **17 gates RED with
`SOURCE_DIGEST_MISMATCH`** despite every one of the 17 runs having exited 0. The cause was
this work: a full collection takes ~25 minutes, and files were edited during that window.

The digest binding was doing its job — evidence from a different tree was refused — but the
producer was wrong in a way only a real run exposes. It took the digest **once, up front**,
so records claimed a tree state the later gates never ran against, and the verdict then
reported "evidence about a program nobody is shipping" with no way for an operator to tell
an edit-during-collection from a genuinely stale artefact.

**Fix.** `collectEvidence` now takes the digest **before the first gate and after the last**,
and the collection is void unless they agree. A void collection stamps every record
`VOID:tree-changed-during-collection:<before>-><after>`, which is inadmissible against *any*
tree rather than merely against this one. The condition is named in the report instead of
surfacing later as a confusing mismatch. Covered by three new tests, including the planted
mid-collection edit.

#### D-3c — a fail-open inside the fix, found by the final hostile pass (FIXED)

The §27 re-audit attacked the new contract without trusting the notes that produced it, and
found one:

```js
if (nonEmpty(at.sourceDigest)) { /* …bind the record to the tree… */ }
```

The binding was **conditional on the caller having supplied a tree**. A caller who simply
omitted `sourceDigest` from the context got no binding at all, and any run record — stale,
foreign, from another build — was admitted. `stage.authoriseEnable()` passes the field
straight through from its request, so the omission was reachable **at the one call site
whose entire job is to be the authority**. A fail-open in the middle of a fail-closed
design, and one that no existing test caught because every fixture happened to supply a
digest.

Demonstrated: `admit(tier_dependencies, <record claiming digest "deadbeef">, { nowMs,
maxAgeMs })` → `{ admissible: true, pass: true }`.

**Fix.** The digest is now **mandatory** for every run record and every corroborating run;
its absence is `SOURCE_DIGEST_REQUIRED`. Judging a run record without knowing which tree is
being judged is not a weaker check — it is no check. Two test fixtures had to be taught to
build fully bound evidence, which is the cost the mechanism is meant to impose.

### D-4 — The shadow worker has no composition root (REPORTED)

`workers/registry.js` marks `shadow` as `DEFERRED` with `blockedBy` naming what is missing:
"a constructed solve path (round, expandCandidates, pricedCandidateFor, budgetsFor,
deferPriceFor) … what is missing is the composition root that builds those five
collaborators outside a test fixture. A stub would produce a worker that runs, reports
success, and compares nothing."

`tests/engine/observabilitySchema.test.js:406` asserts `server.js` does **not** include it.

Consequence: the `shadow_agreement` gate cannot begin accumulating evidence at all. The
system is not merely short of the fourteen-day window — it cannot start the clock. Same root
cause as D-5.

### D-5 — The Tier 0 decision path is not wired into production (REPORTED — largest remaining)

All four `LEADER_ONLY` workers are required by **nothing** outside tests:

| Worker | Tier | What it is |
|---|---|---|
| `coordinator.worker` | 0 | "The round loop: drain the queue, generate, gate, price, solve, commit." |
| `outbox.worker` | 0 | Dispatch |
| `reconciler.worker` | 0 | §19.5 reconciliation |
| `timer.worker` | 0 | §4.5 durable timers |

Each worker's own `start()` docstring says so — *"Not called from `server.js`:
`ENGINE_ENABLED` is false and Phase 15 owns moving engine workers from shadow to production
scheduling."* `server.js` says they "belong to the shard supervisor's leadership lifecycle";
`shardSupervisor.worker.js` has **no promotion hook** and starts none of them.

So `ENGINE_ENABLED=true` would take a shard live onto a decision path that never executes:
tasks accepted, nothing assigned, nothing dispatched, no timers, no reconciliation. This is
the deepest unclosed Phase-15 deliverable, and it was invisible — no test failed, no gate
reddened.

**What was done:** the gap is now **mechanically enforced** rather than invisible.
`tools/gates/checkCompositionRoot.js` (new) checks the registry's readiness column against
the composition root: `SCHEDULED` workers must be required *and* started; `LEADER_ONLY`
workers must be reachable from production code; `DEFERRED` workers must not be started. It
is wired into `npm run gates` **and** added as a blocking release-gate row,
`engine_decision_path_wired`. It is **RED today**, correctly, naming all four.

**What was not done:** the wiring itself. Building a correct composition root for the Tier 0
solve path means candidate expansion against the availability index, the eight cost terms,
the commit transaction, the dispatch outbox and durable timers, wired to leadership
acquisition, and then validated against a live database. Improvising that would produce
exactly what the registry warns about — a worker that runs and decides wrongly, which is
worse than one that does not run. **This is not claimed fixed.**

### D-6 — The cutover switch is a conjunction everywhere except the socket layer (REPORTED)

`cutover/enabled.js` exists because the switch has two halves — `processEnabled()` and
`forShard()` — and its header says the module was written because
`process.env.ENGINE_ENABLED === "true"` "was scattered across" the codebase.

`src/services/task.service.js` reads both halves. **Every socket handler reads only the
process half.** Three of them guard engine *write* paths:

| Site | Gates |
|---|---|
| `command.handler.js:82` | settles an outbox row to `ACKED` |
| `offer.handler.js:47` | releases a commitment, moves a Leg, renews a lease |
| `robot.handler.js:271` | suppresses outbox rows, advances an agent's `authority_epoch` |

During a staged rollout — with the deployment-wide `ENGINE_ENABLED=true` that staging
*requires* — those write paths are live for **every** shard, including ones the staging
order has deliberately not reached. The refusals in `stage.js` govern the intake path and
not the agent-facing one. The handlers are not wrong about their history: they were written
against Phase 0's single master switch. Phase 15 introduced the second half and converted
one call site; this is the unconverted remainder.

Pinned by `tests/engine/cutoverSwitchConjunction.test.js`, including an exhaustiveness check
so the finding cannot widen unnoticed. Not fixed: it needs a design decision (caching the
robot's shard on `socket.data` at AUTH, rather than a per-event lookup on the hot path).

### D-7 — The gate set cannot be brought to green by any legitimate sequence (REPORTED)

`rollback_rehearsed` is discharged by rehearsing the rollback. `docs/runbooks/rollback.md`
§5 step 1 requires taking a staging shard live "through the full §3 of `cutover.md`". That
calls `stage.authoriseEnable()`, which refuses while any blocking gate is not `GREEN` — and
`rollback_rehearsed` is a blocking gate. **The rehearsal requires a cutover and the cutover
requires the rehearsal.** There is no escape by design: `gates.js` has no `WAIVED` status,
and the only override skips the staging order, never a gate.

**Demonstrated mechanically**, not argued: with fully admissible evidence for all
twenty-three other gates, the enable is refused by exactly `rollback_rehearsed
(NOT_EVALUATED)`. Pinned in `tests/engine/cutoverEvidence.test.js`.

Not fixed: resolving it means adding a rehearsal mode to Tier 0 cutover authorisation — one
that binds a non-production region, excludes exactly this gate, and audits itself as a
rehearsal. That is a change to the cutover contract, which §8 of the execution plan puts
behind an ADR and two-person approval. **Inventing an escape hatch in Tier 0 authorisation
unilaterally is the wrong way to close a finding about escape hatches.**

---

## 4. Files changed

**New**

| Path | Purpose |
|---|---|
| `Backend/src/engine/cutover/evidence.js` | The admission contract — what discharges a release gate |
| `Backend/tools/release/sourceDigest.js` | Binds a run record to the tree it ran against |
| `Backend/tools/release/collectEvidence.js` | The producer: runs the gates, records exit codes |
| `Backend/tools/release/verdict.js` | The judge: whole table, meaningful exit code |
| `Backend/tools/gates/checkCompositionRoot.js` | Build gate — workers declared scheduled are actually wired |
| `Backend/tests/engine/cutoverEvidence.test.js` | 31 tests — the original attack plus every planted forgery |
| `Backend/tests/engine/cutoverSwitchConjunction.test.js` | 6 tests — pins D-6 |
| `Backend/tests/gates/checkCompositionRoot.test.js` | 9 tests — gate self-test, incl. a positive case |

**Modified**

| Path | Change |
|---|---|
| `Backend/src/engine/cutover/gates.js` | `evaluate()` adjudicates via `evidence.admit()`; evidence-kind drift assertion; `runnable` flag; new `engine_decision_path_wired` row |
| `Backend/src/engine/cutover/stage.js` | Forwards the binding context (clock, age bound, source digest, duration bounds) to the gate check |
| `Backend/src/controllers/health.controller.js` | Marks the cutover view `authoritative: false` and names what it does not check |
| `Backend/tools/gates/checkCalibration.js` | Safety-class entries may not be substantiated by a cross-reference |
| `Backend/tools/simFidelity/validate.js` | Exit code is `mayDischargeTierZero`, not `ok` |
| `Backend/src/engine/config/register/supplementary.json` | Explicit `derivation` on two entries that already carried the reasoning in `description` |
| `Backend/package.json` | `gate:composition`, `release:evidence`, `release:verdict`; `gates` and `release:gates` rewired |
| `Backend/tests/engine/cutoverStaging.test.js` | `allGreen()` now builds admissible evidence — strictly stronger |
| `Backend/tests/gates/checkCalibration.test.js` | Release-run coverage asserted as a property, not a substring match |
| `Backend/tests/engine/phase0Scaffold.test.js` | `cutover/evidence.js` registered as Phase-15-owned |
| `docs/runbooks/cutover.md` | Corrects "it cannot check 4, 5, 6 or 7" — the record is now checked, the content is not |
| `docs/runbooks/rollback.md` | Records the D-7 circularity as an open finding |
| `docs/safety-case/SAFETY_CASE.md` | Regenerated (24 gates) — by re-running the generator, not by editing |

**Deleted:** none.
**Database changes:** none. No migration was required or written; the Prisma schema and
migration history are untouched.
**API changes:** `GET /api/health/cutover` gains `releaseGates.authoritative` and
`releaseGates.notCheckedHere`. No removals, no breaking changes.
**Socket changes:** none.

---

## 5. Status by area

| Area | Status | Evidence |
|---|---|---|
| **Calibration** | **Gate NOT_EVALUATED; its check RED — externally blocked** | 39 Safety-class parameters `PROVISIONAL`/`UNCALIBRATED`, awaiting measured fleet, vendor and authority data. Execution-plan item **B8**. `npm run gate:calibration` exits 1 and is recorded as corroboration; no attestation exists, so the gate is not evaluated. The bypass is closed; the values are not inventable. |
| **B1 routing** | **BLOCKED — genuinely external** | `b1Readiness.js`: D1 (operating region — Ops + Commercial), D3 (fleet speed model — Product + Fleet Eng), D8 (extract vintage/cadence — Ops). Step 2 (adapters) PASS; steps 1, 3, 4, 5 blocked. No engine is selected, ranked or recommended, and none was fabricated. |
| **Scale / solver** | Suite GREEN; not independently re-profiled here | `scale_targets`, `locality` and `overload_admission_control` are all GREEN with real exit codes. This work did **not** re-derive the §20.1 whole-round measurement or re-profile the solver; no claim is made that it did. The gate asserts the suite's own thresholds held. |
| **Simulator fidelity** | **RED (was falsely 0)** | All 7 models `NOT_MEASURED`, 5 safety-relevant. Now exits 1. Requires a study against realised production data. |
| **Shadow agreement** | **NOT_EVALUATED — cannot start** | D-4: no composition root, so the 14-day clock cannot begin. |
| **Soak** | **NOT_EVALUATED** | `release.soak_duration` is 72 h; the scale lane's soak profile is a shape check and says so. Requires wall-clock time. |
| **Rollback rehearsal** | **NOT_EVALUATED — and unsatisfiable** | D-7 circularity, demonstrated mechanically. |
| **Safety case** | Assembles; every reference resolves | Regenerated from the generator. Reports 24 gates not evaluated. |
| **Formal verification** | Partial, honestly recorded | `formal/README.md`: TLC complete on `commitment.tla` at capacity 1 and reduced capacity 2; not converged at checked-in c2 or c3; `lifecycle.tla` not run under TLC. Executable equivalents run every build and call the shipped modules. Not re-run here; the existing record was verified as accurate rather than restated. |
| **§26 invariants** | **NOT_OBSERVED** (not `ENFORCED`, not `VIOLATED`) | All 22 invariants are implemented in `invariantChecker.js`, and — unlike D-5's workers — the invariant worker **is** started (`server.js:118`). Two checks correctly return `null` rather than `ENFORCED` where they cannot verify. What is missing is production traffic to observe, so this is genuinely external rather than a wiring gap. Not collapsed into `ENFORCED`. |
| **Cutover** | Refusals verified; one contract gap | Gate check, Tier 2 ship state, two-person approval, automated-enable refusal, guardrail pre-declaration and ordering all verified by attack. D-6 and D-7 open. |
| **Legacy retirement** | **VERIFIED** | File-restore and dynamic-require attacks both caught; tree restored clean. |
| **Phase 16 contamination** | **CLEAN** | `src/engine/fairness/` holds no runtime code (a Phase 0 `.gitkeep` scaffold only); `branchAndBound` absent. References to Tier 2 names occur only in kill switches, tier assertions and guards — the mechanisms that keep Tier 2 off. Default kill-switch state: all thrown; enabling one is refused by `tierTwoAtShipState`. |
| **Routing cache** | Sound; no production caller yet | Required namespace, required `maxEntries`, required `ttlMs`, L1 TTL = min(own, L2), clock-free. Only the benchmark tool calls it — consistent with B1 being blocked. |

---

## 6. Test results

| | Suites | Tests | Failures |
|---|---|---|---|
| Baseline | 151 | 6 741 | 0 |
| After remediation | **154** | **6 792** | **0** |

Three new suites (50 tests): `cutoverEvidence` (35), `checkCompositionRoot` (9),
`cutoverSwitchConjunction` (6), plus one added to `checkCalibration`.

No test was deleted, skipped, weakened or threshold-relaxed. Three existing tests were
**replaced with stronger assertions** because the implementation legitimately changed:

- `cutoverStaging.test.js` — `allGreen()` was the attack: six lines of `{ pass: true }`.
  It now builds admissible evidence, which is considerably more work to write, which is the
  point.
- `checkCalibration.test.js` — a substring match on a shell conjunction became a property
  check on the gate row, the collector's command set, and the release script.
- `phase0Scaffold.test.js` — registers the new module against its owning phase.

`docs/safety-case/SAFETY_CASE.md` was regenerated by **re-running the generator**, which is
what its freshness test demands; it was not hand-edited.

---

## 7. Adversarial results

**Planted defects: 32. Detected: 32. Missed: 0.**

27 are encoded as automated tests (25 labelled `PLANTED`, plus the original fabrication
attack and the unknown-gate-id case); 5 were performed by hand against the live tree, which
was restored afterwards and verified clean. Every automated one fails if the protection is
removed.

Two of the 32 were defects **in the remediation itself** — the void-collection case (D-3b),
found by running the pipeline end to end, and the conditional digest binding (D-3c), found
by the §27 hostile pass re-auditing the fix without trusting the notes that produced it.

| Attack | Outcome |
|---|---|
| 23 hand-typed `{pass:true}` records | **REFUSED** (was: authorised) |
| Empty evidence set | RED via `NOT_EVALUATED`, blocks |
| Run record claiming `pass` over a non-zero exit | REFUSED — `PASS_CONTRADICTS_EXIT_CODE` |
| Evidence from a different command | REFUSED — `COMMAND_MISMATCH` |
| Record filed against the wrong gate | REFUSED — `GATE_ID_MISMATCH` |
| Assertion with no run at all | REFUSED — `RUN_RECORD_REQUIRED` |
| Run with no exit code | REFUSED — `EXIT_CODE_MISSING` |
| Gate passed on a different tree (restore-the-file) | REFUSED — `SOURCE_DIGEST_MISMATCH` |
| Run record with no digest | REFUSED — `SOURCE_DIGEST_MISMATCH` |
| Stale evidence / evidence from the future | REFUSED — `STALE` / `PRODUCED_IN_THE_FUTURE` |
| Anonymous or undated record | REFUSED — `SELF_ASSERTED` |
| Build run closing a PRODUCTION gate | REFUSED — `BUILD_CANNOT_CLOSE` |
| 14-day claim over 4 minutes of traffic | REFUSED — `OBSERVATION_WINDOW_TOO_SHORT` |
| Soak shorter than `release.soak_duration` | REFUSED — `OBSERVATION_WINDOW_TOO_SHORT` |
| Missing duration bound | REFUSED (gate red, not unbounded) |
| Unowned production record / inverted window | REFUSED |
| Self-approved attestation | REFUSED — `APPROVER_NOT_DISTINCT` |
| Attestation while its own check exits 1 | REFUSED — `PASS_CONTRADICTS_EXIT_CODE` |
| Runnable organisational gate with no corroboration | REFUSED — `RUN_RECORD_REQUIRED` |
| Evidence against an unknown gate id | Counted and blocks, not ignored |
| Flip all 39 Safety params to `DERIVED` | **0 escape** (was: 11 escaped) |
| Restore a retired legacy module | CAUGHT — `module-restored` |
| Import a retired module from production | CAUGHT — `import-of-retired-module` |
| Route an `ENABLE` through the automatic path | THROWS — `assertOneDirectional` |
| Enable a shard with a Tier 2 mechanism live | REFUSED — `TIER_TWO_NOT_AT_SHIP_STATE` |
| Edit the tree mid-collection (real, unintended) | **CAUGHT** — 17 gates RED on `SOURCE_DIGEST_MISMATCH`; now named as `VOID` |
| Composition root: `SCHEDULED` worker not required | CAUGHT — `SCHEDULED_NOT_REQUIRED` |
| Composition root: required but never started | CAUGHT — `SCHEDULED_NOT_STARTED` |
| Composition root: `LEADER_ONLY` worker unreachable | CAUGHT — `LEADER_ONLY_UNREACHABLE` |
| Composition root: `DEFERRED` worker started anyway | CAUGHT — `DEFERRED_BUT_STARTED` |
| Omit `sourceDigest` from the context to disable binding | REFUSED — `SOURCE_DIGEST_REQUIRED` (was: **admitted**) |
| Same, via an organisational gate's corroborating run | REFUSED — `SOURCE_DIGEST_REQUIRED` |

**Mutation test.** Reverting `evaluate()` to `record.pass === true` makes the headline test
fail. The suite is capable of failing; it was restored and re-verified.

---

## 8. Remaining blockers

**In-repository (fixable here, not fixed):**

1. **D-5** — Wire the Tier 0 decision path (coordinator, outbox, reconciler, timer) to
   leadership acquisition. Blocks: `engine_decision_path_wired`, and transitively
   `shadow_agreement`, `soak`, `invariants_enforced`, `rollback_rehearsed`.
2. **D-4** — Build the shadow worker's solve-path composition root (same collaborators).
3. **D-6** — Convert the six socket-handler call sites to the two-half switch.

**Contract-level (needs an ADR and two-person approval per execution plan §8):**

4. **D-7** — The rehearsal/cutover circularity. The gate set is currently unsatisfiable.

**Genuinely external — no repository work can close these:**

5. **B8 / calibration** — 39 Safety-class values await measured fleet, vendor and authority
   data. §22.4 itself says "a significant number of them … require data the fleet does not
   yet produce and cannot produce before it operates."
6. **B1 / routing** — D1, D3, D8 are Operations, Commercial and Product decisions.
7. **Production observation windows** — shadow agreement (14 days of live traffic), soak
   (72 h), simulator fidelity (realised distributions), §26 invariants (nominal operation
   with a zero-violation SLI).
8. **TLC at capacity 3** and at checked-in capacity 2 — needs compute beyond a workstation
   session, not a different specification.

---

## 9. Phase 16 readiness

**NOT READY.** Phase 16's sole prerequisite is Phase 15, and Phase 15 is blocked. Beyond
the gate arithmetic, Phase 16 enables Tier 2 mechanisms one at a time behind their own
gates — and Tier 2 enablement is not meaningful while the Tier 0 decision path is not
wired into the composition root (D-5).

No Phase 16 functionality was implemented. Verified: `src/engine/fairness/` holds only a Phase 0 `.gitkeep` scaffold and no runtime code,
`branchAndBound` absent, every Tier 2 kill switch thrown by default, and `tierTwoAtShipState`
refuses a cutover with any of them live.

---

## 10. Classification

**FIXED**
- Calibration substantiation bypass (11 Safety-class parameters promotable by a one-word edit)
- `sim:fidelity` false-green exit code
- `release:gates` coverage and aggregation — `NOT_EVALUATED` is no longer a pass
- Release-gate evidence: contract, producer, judge, and binding to the measured tree
- A void-collection case in the new producer (tree edited mid-run) — D-3b
- A fail-open in the new binding (digest optional when the caller omitted it) — D-3c
- Two register entries claiming `DERIVED` without a stated derivation
- Stale claims in `docs/runbooks/cutover.md`; regenerated safety case

**VERIFIED**
- Legacy retirement (attacked two ways)
- Tier 2 ship-state enforcement
- Automatic rollback is one-directional; automated enable refused
- Two-person approval, guardrail pre-declaration and ordering, staging order
- No Phase 16 contamination
- Routing cache key isolation and bounds
- `formal/README.md`'s account of what TLC has and has not run

**EXTERNALLY BLOCKED**
- 39 Safety-class calibration values (B8)
- B1 routing decisions D1, D3, D8
- Shadow agreement, soak, simulator fidelity, §26 invariant observation
- TLC at capacity 3 / checked-in capacity 2

**NOT EVALUATED** (and therefore NOT PASS)
- All four `PRODUCTION` gates; both remaining `ORGANISATIONAL` gates
- Whole-round §20.1 re-profiling was not performed in this work

**NOT APPLICABLE**
- Database migrations — none required
- Socket contract changes — none required

---

## 11. Machine-readable summary

```json
{
  "phase": 15,
  "status": "BLOCKED",
  "phase16Ready": false,
  "releaseGates": {
    "tier_dependencies": "GREEN",
    "parameter_register": "GREEN",
    "design_tenets": "GREEN",
    "identity_isolation": "GREEN",
    "erasure_reconstruction_equivalence": "GREEN",
    "calibration_safety_derived": "NOT_EVALUATED",
    "legacy_removed_from_build": "GREEN",
    "engine_decision_path_wired": "RED",
    "lower_bound_admissibility": "GREEN",
    "model_check_capacity_1_2_3": "GREEN",
    "determinism_replay": "GREEN",
    "snapshot_retention": "GREEN",
    "chaos_capacity_1": "GREEN",
    "chaos_capacity_2": "GREEN",
    "cache_tier_flush": "GREEN",
    "scale_targets": "GREEN",
    "locality": "GREEN",
    "overload_admission_control": "GREEN",
    "invariants_enforced": "NOT_EVALUATED",
    "simulator_fidelity": "NOT_EVALUATED",
    "soak": "NOT_EVALUATED",
    "shadow_agreement": "NOT_EVALUATED",
    "safety_case_assembled": "NOT_EVALUATED",
    "rollback_rehearsed": "NOT_EVALUATED"
  },
  "gateCounts": { "green": 16, "red": 1, "notEvaluated": 7, "total": 24 },
  "releaseGatesExitCode": 1,
  "tests": { "suites": 154, "tests": 6792, "failures": 0 },
  "adversarial": { "plantedDefects": 32, "detected": 32, "missed": 0 },
  "blockers": {
    "inRepository": ["D-5 composition root", "D-4 shadow solve path", "D-6 half-switch in socket layer"],
    "contractLevel": ["D-7 rehearsal/cutover circularity"],
    "external": ["B8 calibration", "B1 routing D1/D3/D8", "production observation windows", "TLC capacity 3"]
  }
}
```

**These are measured, not predicted.** The table above is the output of
`npm run release:gates` on source digest `f0434df24fa04cb9…`, run to completion on an
unmodified tree. Every `GREEN` row carries a real exit code from a real run — e.g.
`scale_targets`: `exit 0 from npm run test:scale`.

The one `RED` is `engine_decision_path_wired` (`exit 1 from npm run gate:composition`) —
finding **D-5**.

The seven `NOT_EVALUATED` rows split into two kinds, and the distinction matters:

- `calibration_safety_derived` and `safety_case_assembled` are `ORGANISATIONAL` gates whose
  machine-checkable half **was** run and recorded as corroboration. Calibration's
  corroborating run exits **1** (39 Safety-class parameters); the safety case's exits 0. But
  neither gate has an attestation filed by two named people, so neither is evaluated. The
  gate is not red because nobody claimed it — which is the honest state.
- `invariants_enforced`, `simulator_fidelity`, `soak`, `shadow_agreement` and
  `rollback_rehearsed` require the fleet to have operated or a person to have acted. **No
  build can close them**, by construction, and none was manufactured here.

---

## 12. Reproducing this report

```
cd Backend
npm test                  # 154 suites, 6 792 tests, 0 failures      (~5 min)
npm run gates             # exit 1 — gate:composition fails (D-5); the other 7 pass
npm run gate:calibration  # exit 1 — 39 Safety-class parameters (B8)
npm run sim:fidelity      # exit 1 — 5 safety-relevant models NOT_MEASURED
npm run routing:readiness # BLOCKED — D1, D3, D8; no engine selected or recommended
npm run release:gates     # exit 1 — 16 green, 1 red, 7 not evaluated  (~25 min)
```

`npm run release:gates` runs every build gate and every suite, then judges the table. **Do
not edit the tree while it runs** — the collection is voided if the source digest moves
between the first gate and the last, and it will say so.

Every number in this report comes from one of those commands. Nothing here is asserted that
a reader cannot re-derive, and no figure was carried over from an earlier report without
being re-measured.
