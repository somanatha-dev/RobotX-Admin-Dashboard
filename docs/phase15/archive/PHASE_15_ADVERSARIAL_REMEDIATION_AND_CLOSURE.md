# Phase 15 — Current-Tree Adversarial Re-audit, Remediation, Re-verification and Closure

**Second pass · Date:** 2026-08-23 · **Branch:** `feature/dashboard` · **Baseline commit:** `3f0e522` ("maps enhanced"); the Backend tree is unchanged since `450d829` ("phase 15 blocker still exists")
**Source digest at arrival:** `22ca91435d46cf2abf03932637637bcb7986f23c71090211637190305fbb5b00` (560 files)
**Source digest at closure:** `134ebc0d1d6cd047b5ebb62de9808489274520c9c9607795a9ef0d9e43373a2c` (562 files)
**Authority order:** `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` (FROZEN) → `IMPLEMENTATION_EXECUTION_PLAN.md` → the repository → the phase documents.

---

## 0. Which documents this supersedes, and which it does not

Three Phase 15 closure documents now exist. Nothing in any of them has been edited, softened
or deleted, and no finding of any of them has been removed.

| Document | Written against | Status |
|---|---|---|
| `PHASE_15_REMEDIATION_AND_CLOSURE.md` (2026-08-22) | 155 suites / 6 850 tests; `gate:composition` = 2; timer unimplemented; **D-9 the headline blocker** | **Superseded.** Predates the Phase 5 closure. |
| `PHASE_15_FINAL_IMPLEMENTATION_AND_CLOSURE_REPORT.md` (2026-08-21) | the same pre-Phase-5 tree | **Superseded.** |
| `PHASE_15_ADVERSARIAL_AUDIT_PASS_1_2026-08-22.md` | 156 → 157 suites; post-Phase-5; found and fixed **P15-R1…R6**, X2a, X2b | **Preserved verbatim; its findings stand. Its verdict is superseded by this pass.** |
| **this document** | 157 → 158 suites, current tree | **Current.** |

### On the preserved pass-1 document

The first current-tree adversarial audit was written into this filename on 2026-08-22. Its
content has been **copied byte-for-byte** to `PHASE_15_ADVERSARIAL_AUDIT_PASS_1_2026-08-22.md`
before this file was rewritten, and the copy was verified by hash:

```
$ sha256sum PHASE_15_ADVERSARIAL_REMEDIATION_AND_CLOSURE.md PHASE_15_ADVERSARIAL_AUDIT_PASS_1_2026-08-22.md
2ebae392422bf45a197cf312c6a3e094239070f3f2051de91a558c544313224b  (both)
```

Not one character of it was altered. Its six findings (P15-R1 … P15-R6) and its X2a/X2b fixes
were **re-derived against the current tree by this pass and all hold** (§6). It is superseded
only in its verdict, and only because this pass found four further defects it did not.

### The mandate's premise, checked rather than accepted

The instruction for this exercise describes the stale baseline as *"155 suites / 6 850 tests,
gate:composition = 2 violations, timer unimplemented, D-9 blocker"*. That is an accurate
description of `PHASE_15_REMEDIATION_AND_CLOSURE.md`. It is **not** a description of the tree
this pass found: the tree had already absorbed both the Phase 5 closure **and** pass 1's six
fixes, measuring 157 suites / 6 960 tests with one `gate:composition` violation.

The premise was therefore one revision out of date, and it is recorded here rather than
quietly worked around. The instruction's substance — *re-derive everything from the current
tree, inherit nothing* — is what this pass did, and it is what produced the four new findings.

---

## 1. Final verdict

# PHASE 15 — BLOCKED. PHASE 16 — NOT READY.

**Four new Phase-15-owned defects were found on the current tree. All four are fixed**, each
reproduced before the fix, attacked after it, mutation-tested, and verified against a real
PostgreSQL instance driving the shipped modules.

The verdict is unchanged from both earlier passes and it is unchanged **for the same reason**:
the decision path terminates in a routing engine that B1 has not selected. Nothing here moves
that, and nothing here pretends to.

| | Baseline (current tree, before this pass) | After |
|---|---|---|
| Test suites / tests | 157 / 6 960 | **158 / 7 001** |
| Build gates | 7 PASS, `gate:composition` FAIL (1) | **7 PASS, `gate:composition` FAIL (1)** — unchanged, still `coordinator`, still external |
| `gate:calibration` | FAIL — 39 findings | FAIL — 39 findings, **unchanged** |
| `sim:fidelity` | exit 1, 7 models `NOT_MEASURED` | exit 1 — **unchanged** |
| Live-PostgreSQL checks | 252 | **269** (17 new) |
| Migrations applied from empty | 26 | **27** |
| Mutations caught | — | **14 / 14** |
| `npm run release:gates` | — | **16 green, 1 red, 7 not evaluated → BLOCKED** (§21) |
| Source digest | `22ca9143…` (560) | `134ebc0d…` (562) |

### What the four findings have in common

Pass 1 recorded its six as *"a real producer, a real consumer, and nothing joining them."*
These four are the next layer down, and they are a different shape:

> **A rule that is stated, tested, and enforced only when the caller happens to supply the
> input it is enforced against.**

Every one of the four *has* a passing test. `evidence.admit()` has a staleness test.
`guardrails.declare()` has an empty-set test. `auditStream` has a vocabulary-drift test that
was correct and complete. What no test asked was **what happens when the input is absent** —
and the answer, four times, was: the check does not run, nothing says so, and the request is
authorised.

The most consequential of the four (**P15-C4**) was invisible to a suite of 6 960 tests
because no test had ever written a cutover audit event to a database. The first thing that
tried was the verification harness written for a *different* finding in this same pass.

---

## 2. Current baseline, measured before anything was changed

```
$ git log --oneline -1
3f0e522 maps enhanced          (Backend unchanged since 450d829; 47 uncommitted paths, all Frontend/maps)

$ npx jest --runInBand --forceExit
Test Suites: 157 passed, 157 total
Tests:       6960 passed, 6960 total
Time:        336.876 s

$ npm run gates
gate: tier-dependencies          PASS   (counts not captured — see note)
gate: parameter-register         PASS   (counts not captured — see note)
gate: tenets                     PASS   (counts not captured — see note)
gate: identity-isolation         PASS — 16 modules
gate: reconstruction-equivalence PASS — 3 decisions, byte for byte
gate: legacy-retirement          PASS — 4 retired modules absent, 338 files
gate: column-generation          PASS — NOT_REQUIRED
gate: composition-root           FAIL — 1 violation: coordinator [LEADER_ONLY_NOT_COMPOSABLE, EXTERNAL, B1]

$ npm run gate:calibration   exit 1 — 39 blocking findings; 242 entries (52 DERIVED, 152 PROVISIONAL, 38 UNCALIBRATED), 54 Safety-class
$ npm run sim:fidelity       exit 1 — 7 models NOT_MEASURED, 6 of them safety-relevant
$ npm run routing:readiness  OVERALL: BLOCKED — D1, D3, D8; no engine selected
$ node tools/release/sourceDigest.js
22ca91435d46cf2a…  (560 files)

# live PostgreSQL 18.3, disposable cluster on 55437, 26 migrations from empty
tools/verify/phase15CurrentTree.js      32/32
tools/verify/phase15LiveDatabase.js     12/12
tools/verify/phase5ExpirySemantics.js  102/102
tools/verify/phase5LiveDatabase.js     106/106
```

**Release-gate table: 24 gates** — 7 `BUILD`, 10 `SUITE`, 4 `PRODUCTION`, 3 `ORGANISATIONAL`,
all blocking.

**Note on the first three gate rows.** This pass's baseline capture was truncated and their
module counts were not recorded; by the time that was noticed the tree had moved and the
baseline could not be re-measured. Their **PASS is sound rather than assumed** — `npm run
gates` is a `&&` chain, and `gate:identity-isolation` onward were observed to run, which they
could not have done otherwise. The counts are therefore reported as not captured rather than
filled in from pass 1's document, which is the number this section exists not to inherit. The
final counts in §18 **were** measured, and are the ones any comparison should use.

### One inconsistency in pass 1's own record, noted not corrected

Pass 1's header and its §2 both print `22ca9143… (560 files)` — once as *"the tree everything
below was measured against"* and once inside its **baseline** block. Those cannot both be
true: pass 1 added three `src/` modules and a test suite, which necessarily moves the digest
and the file count. `22ca9143…` is in fact pass 1's **final** digest, and this pass measured
it unchanged on arrival, which is what proves the tree had not moved since.

The number is right and one of its two labels is wrong. It is recorded here rather than
edited there, because pass 1's document is historical evidence.

---

## 3. Phase 5's closure incorporated as new evidence

Phase 5 handed this phase three named inputs. All three were **re-audited end to end on the
current tree**, not accepted from pass 1's report.

### X2a — `offers.applyAccept` → `OFFERED → ACCEPTED` · **FIXED (pass 1), verified here**

Traced in full, producer to recovery:

```
producer      OFFER_ACCEPT (socket)      sockets/handlers/offer.handler.js:189
transition    offers.applyAccept()       dispatch/offers.js:316  writeLegState(…, ACCEPTED)
timer         legEntryDeadline.superviseEntry(tx, …)   offer.handler.js:155  ← in the same tx
persistence   Leg.state=ACCEPTED, version+1; Timer PENDING keyed on the entered version
timer worker  leaderWorkers.COMPOSERS.timer → timerWorker.start(...)  (composed, leader-only)
expiry action expiryActions.probeThenReassign          (execute.start_grace)
recovery      ACCEPTED → REASSIGNING, fence↑, RECALL outbox row, commitment released
```

`legEntryDeadline.superviseEntry` has exactly **two** production consumers —
`sockets/handlers/offer.handler.js:155` and `workers/outbox.worker.js:332` — and both were
verified live. All three dispositions (accept, reject, defer) are armed, not only the accept.

### X2b — outbox withdrawal → `QUEUED` · **FIXED (pass 1), verified here**

`workers/outbox.worker.js:332` calls the same `legEntryDeadline.superviseEntry`, in the same
transaction as `offers.withdrawExpiredOffer`. Its `assignmentDeadlineSeconds` has a real
production producer — `leaderWorkers.js:250`, `finite(values, "sla.assignment_deadline")` —
not a test fixture.

**The two paths to `QUEUED` now share one implementation of the obligation.** That was the
mandate's specific requirement (*"there must not be two production paths to the same state
with different supervision semantics"*) and it is met: `expiryActions.withdrawExcludeReplan`
and `outbox.worker.performWithdrawal` both arm `sla.assignment_deadline` on entry, and the
timer payloads are deliberately identical so the two are indistinguishable afterwards.

### X3 — no `TASK` timer producer · **NOT FIXED, and must not be**

Re-derived on the current tree, live: `phase15CurrentTree.js` check **G1** reports
`TASK-entity timers in the store after this whole harness: 0`, and a structural scan in
`phase15CurrentTreeRemediation.test.js` confirms **no `timers.register` call anywhere under
`src/` names the TASK entity**, while LEG producers do exist.

The mandate asks this pass to separate *"missing production composition"* from *"missing
specification semantics."* The separation is unambiguous and it is the second:

- §4.3 has §4.4, a complete transition table. **§4.2 has no transition table at all** — a
  state table with an exit-deadline column and nothing saying what a Task moves to on any
  event.
- Intake writes the **legacy** `PENDING` vocabulary. Adopting `RECEIVED` would arm
  `intake.validation_budget` on a state with **no defined exit**, which is invariant I4's
  violation created deliberately rather than found.
- `taskMachine.js` declines to map the legacy vocabulary in its own words, and Phase 5's
  closure §17 A3 records the same conclusion independently.

**Phase 15's cutover does not own this, because there is nothing to compose.** Wiring a
producer would require inventing the §4.2 transition semantics the frozen specification does
not contain. Classified **SPECIFICATION**, unchanged from pass 1, and re-derived rather than
carried.

---

## 4. The Phase 15 requirement matrix, re-derived

| §24 / plan requirement | Status on the current tree |
|---|---|
| `cutover/enabled.js` — the two-half switch | MET; P15-R5's fix re-attacked and holds |
| `cutover/agentGate.js` — every agent path held to both halves | MET; two raw `ENGINE_ENABLED` reads exist and both are legitimate (§6.1) |
| `cutover/stage.js` — refusals, staging order, purposes | **MET after this pass** — P15-C1, P15-C2, P15-C4 all landed here |
| `cutover/gates.js` + `evidence.js` — the §24 table and its admission rules | **MET after this pass** — P15-C1, P15-C3 |
| `cutover/store.js` — the pre-declaration read back from §21.7 | **MET after this pass** — P15-C4 |
| `tools/release/{collectEvidence,verdict,sourceDigest}.js` | **MET after this pass** — P15-C1 |
| `workers/leaderWorkers.js` — the LEADER_ONLY promotion hook | MET; 3 composers start, 1 refuses (external) |
| A published binding reaching a running process | MET (P15-R2); `configPropagation` composed at `server.js:397` |
| §22.4 item 4 — automatic rollback | **MET after this pass.** P15-R1 fixed the publisher; **P15-C4 was why the controller could never reach it** |
| §18.5 — no commands under Custodial Operation | MET (P15-R3) |
| Intake path gated on the per-shard switch | MET (P15-R4, P15-R5) |
| §4.5 / I4 on the paths the cutover makes live | MET (X2a, X2b) |
| `workers/invariant.worker.js` composed | MET — **WIRED, not OBSERVED** (§9) |
| `workers/shadow.worker.js` composed | **NOT MET — EXTERNAL (B1)**, unchanged |
| `workers/coordinator.worker.js` composed | **NOT MET — EXTERNAL (B1)**, unchanged |
| §4.2's half of §4.5 reachable | **NOT MET — SPECIFICATION** (X3) |
| Every §24 gate green | **NOT MET** — 7 of 24 cannot be closed by a build; `engine_decision_path_wired` red |

---

## 5. New findings — all Phase-15-owned, all fixed

### P15-C1 — the evidence binding context was half-mandatory · **BLOCKING (permissive)** · FIXED

**Root cause.** `evidence.admit()` made the **source digest** mandatory, with an argument
stated in its own source:

> A run record is a claim about a particular tree. Judging one without knowing which tree is
> being judged is not a weaker check; it is no check.

The identical argument governs the **age bound**, and the module's header says so —
*"what is **not** negotiable is that both have an answer"*. It was not enforced. Both `nowMs`
and `maxAgeMs` were read through `typeof … === "number"` guards, so a caller that omitted
either got **no staleness check and no future-stamp check at all**, silently.

`stage.authoriseEnable()` forwarded both straight through from its request. And
`requestedAtMs` is read a second time, to decide whether the guardrails were declared *before*
the request — so **one missing field switched off three protections**.

It matters most for exactly the records the digest cannot bind. `PRODUCTION` and
`ORGANISATIONAL` records carry no digest by construction — a soak is about the fleet, a
rehearsal is about a person — so for **7 of the 24 gates the age bound is the only binding to
reality there is**.

**Reproduction (before).** A complete, well-formed rollback rehearsal record, three years old,
against an otherwise fully green table:

```
=== B. admit() with the age bound simply OMITTED ===
{ "admissible": true, "pass": true, "code": null, "detail": "recorded by alice, approved by bob" }

=== D. stage.authoriseEnable() — the authority — with evidenceMaxAgeMs omitted ===
  authorised=true
  ACTION: {"level":"region","key":"region-alpha","name":"cutover.engine_enabled","value":true}

=== 6. authoriseEnable with requestedAtMs OMITTED ===
  authorised=true   ACTION {"level":"region",…,"value":true}
  (evidence 3 years stale AND guardrails declared a year after the request)
```

A production cutover, authorised on a three-year-old rehearsal of a system that no longer
exists, because a field was absent.

**A third trigger, at the CLI.** `tools/release/verdict.js` computed
`Number(maxAgeHours) * MS_PER_HOUR`. `Number("banana")` is `NaN`, `typeof NaN === "number"`,
and every comparison against `NaN` is false — so `--max-age-hours <typo>` meant *no record is
ever stale*, with no message anywhere.

**Corroboration from the repository itself.** `GET /api/health`'s cutover view had already
named both fields together as the two things that make an evaluation authoritative:

```js
authoritative: false,
notCheckedHere: ["sourceDigest binding", "evidence age bound"],
```

The endpoint that declares itself *non*-authoritative knew the age bound was part of the
binding. The authoritative path enforced only the other half — so `stage.authoriseEnable()`
could silently be exactly as permissive as the view standing in for it.

**Fix.**
- `evidence.admit()` requires `nowMs` and `maxAgeMs`, refusing by name
  (`EVALUATION_INSTANT_REQUIRED`, `AGE_BOUND_REQUIRED`) and rejecting `NaN`, `Infinity`,
  negatives and non-numbers. The two downstream comparisons are now unconditional, so a
  `typeof` guard cannot reintroduce the hole.
- `stage.authoriseEnable()` refuses an incomplete request up front with a new refusal code,
  `EVIDENCE_CONTEXT_INCOMPLETE`, naming the missing field(s). Kept distinct from
  `RELEASE_GATE_NOT_GREEN` deliberately: a refusal that names the wrong thing sends the next
  operator to look at the release instead of at their own request.
- `verdict.js` refuses a `--max-age-hours` that does not parse, exit 2.
- `health.controller.js` supplies the clock it does have, and no longer claims that omitting
  these can only be *more* permissive.

**Regression.** 18 tests. **Mutations M1–M5, M7, M9: caught.** Live: A1–A4.

---

### P15-C2 — the authority accepted a guardrail declaration its own reader refuses · **BLOCKING (permissive)** · FIXED

**Root cause.** `stage.authoriseEnable()` checked two things about the declaration it was
handed: that it existed, and that its `shardId` matched. Nothing else. It was then copied
verbatim into the action as `guardrailDeclaration` and written into §21.7's stream.

The **read** side does not accept what the **write** side was accepting. `cutover/store.js`
states its own rule:

> `declarationFor` returns exactly what was written at enable time, **re-validated through
> `guardrails.declare()`** so that a corrupted or truncated payload is refused rather than
> partially honoured.

— and returns `null` when that re-validation throws.

So a hand-built `{ shardId, declaredAtMs }`, or any declaration with an empty guardrail set,
was authorised, written to the audit, and then **refused by the controller on its very first
pass**. `cutover.worker.assessShard` reports such a shard as *"live with no pre-declared
guardrails"* and returns `HOLD` **without assessing it** — on that pass and every pass after.
The shard is live, unguarded, and the automatic rollback can never fire for it.

That is the same end state P15-R1 found from the rollback side, reached from the enable side,
and it is worse here: there the shard had at least breached something first.

**Reproduction (before).**

```
=== A. guardrails.declare() refuses an empty guardrail set, by name ===
   refused: a guardrail declaration with no guardrails is a stage with no guardrails…

=== B. authoriseEnable with that declaration — every other check satisfied ===
   authorised = true
   ACTION: {"level":"region","key":"region-alpha","name":"cutover.engine_enabled","value":true}
```

**Fix.** `authoriseEnable` validates through **`guardrails.declare()` — the same function the
reader uses** — and refuses `GUARDRAILS_NOT_DECLARED` naming the validation error. The
**normalised** result is what goes into the action, so what the audit records is exactly what
the controller will later accept. A second implementation of "is this declaration well
formed" is how the two sides came to disagree; there is now one.

**Regression.** 11 tests including the round trip through a real audit stream. **Mutations M6,
M7: caught.** Live: B1–B4, C1–C3.

---

### P15-C3 — a gate flag its adjudicator would silently ignore · **Low (latent)** · FIXED

**Root cause.** `evidence.admit()` adjudicates `runnable` and `rehearsal` inside the
`ORGANISATIONAL` branch, which is reached **after** the `PRODUCTION` branch has already
returned. A `PRODUCTION` row carrying either flag would have it silently ignored: no
corroborating run required, no rehearsal record checked, the gate discharged by an observation
window and a hand-written `pass: true`.

No row in the shipped table does this, so it is a trap rather than a live defect — and
`simulator_fidelity` is one plausible edit away from it. It is `PRODUCTION` evidence that
already names a runnable command (`node tools/simFidelity/validate.js`), so adding
`runnable: true` to it is a natural change that would **weaken** the gate while appearing to
strengthen it.

**Fix.** `assertGates()` refuses such a row at load, beside the existing evidence-kind check
and for the reason that check gives.

**Regression.** 4 tests. **Mutation M8: caught.**

---

### P15-C4 — no cutover audit event could ever be written · **BLOCKING** · FIXED

The most serious of the four, and it was found by the verification harness written for
P15-C2 — the first thing in the programme's history to write a cutover audit event to a
database.

**Root cause, part one: the vocabulary.** `stage.auditEventFor()` has always emitted
`CUTOVER_SHARD_ENABLED` / `CUTOVER_SHARD_ROLLED_BACK`, and `cutover/store.js` has always read
them back. **Neither name was ever in `auditStream.EVENT_TYPE`**, and neither was in the
`AuditEvent_event_type_known` CHECK constraint that mirrors it.

**Root cause, part two: the instant.** `auditStream.link()` builds `recordedAt` as
`new Date(source.recordedAtMs)`. `stage.auditEventFor()` supplied no `recordedAtMs`, so even
once the vocabulary admitted the event it produced an **Invalid Date**, which PostgreSQL
refused. Two independent reasons, either of which alone was fatal.

**Reproduction (before), live:**

```
1. the audit stream's declared vocabulary
    OPERATOR_ACTION, OVERRIDE, CONFIG_CHANGE, QUARANTINE, CONSTRAINT_RELAXATION,
    MANUAL_ASSIGNMENT, CANCELLATION, DEGRADED_MODE, TIER_B_SHEDDING
   contains CUTOVER_SHARD_ENABLED?     false

3. auditStream.append() with the event stage.auditEventFor() produces
    REFUSED: "CUTOVER_SHARD_ENABLED" is not one of the audit stream's event types.

4. the same row inserted with raw SQL, bypassing the application entirely
    REFUSED BY POSTGRES: violates check constraint "AuditEvent_event_type_known"

5. therefore, for ANY shard, what does the controller's reader return?
    declarationFor(...) = null
```

**The consequence, stated plainly.** `store.declarationFor()` finds a shard's pre-declared
guardrails by querying for exactly these two event types. With no row able to exist, it
returned `null` for **every shard, always**. `cutover.worker.assessShard` treats a null
declaration as a finding and returns `HOLD` without assessing.

> **The staged-rollout controller of §22.4 item 4 could never assess a single shard, and the
> automatic rollback could never fire** — on a deployment where the publisher, the guardrail
> evaluator, the controller, and its composition into `server.js` were all correct and all
> wired.

Pass 1 fixed the publisher this controller calls (P15-R1). The controller could never reach
it. And every automatic rollback that *did* fire would have published the binding and then
thrown on the audit write, leaving the record and the effect disagreeing — the exact property
`cutover.worker`'s own header says it exists to preserve.

**Why no test caught it, precisely.** `tests/engine/observabilitySchema.test.js` **has** a
drift guard pinning `auditStream.EVENT_TYPES` to the CHECK constraint. That guard was correct
and it held: the two agreed exactly, and both were missing the cutover types. The missing leg
was the third one — **nothing checked that the event types `stage.auditEventFor()` actually
emits are in that vocabulary.** Two of three pairs pinned is how a vocabulary drifts from its
only producer.

**Fix.**
1. `auditStream.EVENT_TYPE` gains the two names — the single owner of the vocabulary.
2. A migration, `20260823120000_audit_stream_admits_the_cutover_events`, widens the CHECK
   constraint to match. Strictly additive (§13).
3. `stage.js` and `store.js` read the names **from that vocabulary** instead of restating
   them, removing the two duplicate copies that caused the drift.
4. `auditEventFor()` carries `recordedAtMs: action.requestedAtMs` — the authorisation's clock,
   not the writer's — and **refuses** an action without one rather than defaulting to
   `Date.now()`. An audit event is a non-repudiation record; a plausible number in place of a
   missing fact is the failure §21.7 exists to prevent.
5. The drift guard in `observabilitySchema.test.js` now reads the constraint **in force after
   the whole chain**, not one migration's snapshot; and the third leg is pinned in the new
   suite.

**Regression.** 8 tests. **Mutations M10–M14: caught.** Live: B1–B3, D1–D3.

---

## 6. Severity and ownership

| ID | Finding | Severity | Owner | Status |
|---|---|---|---|---|
| **P15-C1** | evidence binding context half-mandatory; a stale rehearsal authorised a cutover | **Blocking (permissive)** | **Phase 15** | FIXED |
| **P15-C2** | the authority accepted a declaration its own reader refuses | **Blocking (permissive)** | **Phase 15** | FIXED |
| **P15-C3** | `runnable`/`rehearsal` silently ignored on a PRODUCTION row | Low (latent) | **Phase 15** | FIXED |
| **P15-C4** | no cutover audit event could be written; the controller could never assess a shard | **Blocking** | **Phase 15** | FIXED |
| **X-C1** | `auditStream.link()` turns an absent `recordedAtMs` into an Invalid Date rather than refusing | Low | **Phase 12** (observability) | **REPORTED, not fixed** |
| **X-C2** | `guardrails.assess()` throws on a malformed declaration rather than reporting | Low | Phase 15 — **unreachable** after P15-C2 | REPORTED, not fixed |
| **X1** | §17.4 escalation ladder unimplemented | Blocking for `ESCALATION_LADDER` only | REMEDIAL PHASE T1-04 | REPORTED (unchanged) |
| **X3** | no producer of `TASK` timers | Blocking for §4.2's half of §4.5 | **SPECIFICATION** | REPORTED, correctly not fixed |
| **B1** | routing engine not selected | Blocking for the release | **EXTERNAL** | REPORTED (unchanged) |
| **B8** | 39 Safety-class parameters not DERIVED | Blocking for the release | **EXTERNAL** | REPORTED (unchanged) |

### The two cross-phase findings, not silently repaired

**X-C1 — `auditStream.link()` is lax about its instant.** `new Date(undefined)` is an Invalid
Date, and `link()` produces one without complaint; the hash is computed over
`recordedAtMs: undefined` before Prisma rejects the write. **Owner: Phase 12.** Not fixed
here: it is a shared module, the failure is loud (nothing persists), and the mandate is
explicit that a defect owned elsewhere is classified before it is touched. Phase 15's half —
supplying the instant — is fixed in Phase 15's own module.

**X-C2 — `guardrails.assess()` throws on a declaration with no `guardrails` array.**
Reproduced during this pass. It is **unreachable in production**: the only producer of a
declaration reaching `assess()` is `store.declarationFor()`, which re-validates through
`guardrails.declare()` first, and after P15-C2 the write side does too. Recorded rather than
hardened, because a change to a Tier 1 control on an unreachable path is a change without a
reason.

---

## 7. Old findings, re-derived rather than carried forward

Each was reproduced against the current tree. None was accepted on the strength of a report.

### 7.1 D-6 — the socket cutover conjunction · **HOLDS**

```
$ grep -rn "ENGINE_ENABLED" src/ --include=*.js   (prose excluded)
src/engine/config/service.js:629   (bootstrap's own decision)
src/engine/cutover/enabled.js:107  (processEnabled — the owning module)
→ zero raw reads anywhere else
```

P15-R5's `REGION_UNRESOLVED` fix re-attacked: `configEnabled()` returns `false` for an empty
region before it resolves anything, so a caller naming no region still cannot inherit a global
binding. Live check F4 confirms it against a snapshot holding a real global `true`.

### 7.2 D-7 — the rehearsal circularity · **HOLDS**

```
REHEARSAL_EXCLUDED_GATES: ["rollback_rehearsed"]     — exactly one
PURPOSE: {"PRODUCTION","REHEARSAL"};  ELIGIBLE_SHARD_STATES: ["ACTIVE"]
```

An unnamed purpose defaults to `PRODUCTION` (reduces nothing); an unrecognised one is refused
rather than defaulted. The rehearsal exclusion still requires a declared non-production
environment, and `evidence.admit()` still requires the rehearsal record itself — now, after
P15-C1, **with an age bound**, which is what stops the exclusion being discharged by a
rehearsal of a system that no longer exists.

### 7.3 D-5 / D-4 — the coordinator and the shadow worker · **UNCHANGED, EXTERNAL**

`leaderWorkers.UNCOMPOSABLE` holds exactly one row (`coordinator`). The registry's `shadow`
row still names the same solve path. `npm run routing:readiness` re-run:

```
step 1  BLOCKED — authoritative operating region unavailable; fleet mobility/speed model unavailable  [D1, D3]
step 2  PASS    — 3 adapters implemented; 1 candidate correctly NOT_IMPLEMENTED
step 3  BLOCKED — nothing deployed to measure                                                          [D1, D3]
step 4  BLOCKED — extract vintage/refresh decision unavailable                                         [D1, D8]
step 5  BLOCKED — ENGINE SELECTION: no recorded evidence exists                                        [D1, D3, D8]
```

### 7.4 D-8, D-9, D-10 – D-13 · **HOLD**

D-8's `SHARD_MIGRATE` deliverer is composed. D-9 (timer expiry semantics) re-verified live
rather than assumed: `phase5ExpirySemantics.js` **102/102** and `phase5LiveDatabase.js`
**106/106** against a fresh database on this tree. D-10/D-11/D-13 present and mutation-tested
by pass 1's suite, which still passes.

### 7.5 P15-R1 … P15-R6 · **ALL HOLD**

Pass 1's own suite (`phase15CurrentTreeRemediation.test.js`) and live harness
(`phase15CurrentTree.js`, **32/32**) both pass unchanged on this tree. P15-R1's publisher is
re-verified end to end by this pass's live check **B3**, which is the first time a real
guardrail breach has reached it through a real `declarationFor` read — something P15-C4 made
impossible until now.

---

## 8. Production composition verification

The mandate's primary audit: *module → producer → consumer → composition root → configuration
→ real database → observable side effect*, and **no dependency whose only producer is a test
fixture**.

### The LEADER_ONLY lifecycle

`server.js:600` builds `leaderWorkers.create({…})`; `shardSupervisor` drives `apply(tick)` on
`mayRunRound`. Three composers start, one refuses:

| Worker | Outcome | Every dependency's production producer |
|---|---|---|
| `outbox` | STARTED | `deliver` = `dispatchOutboxCommand(io, { activeModes: () => degradedTransitions.activeModes({ prisma }, shardId) })`; `assignmentDeadlineSeconds` = `finite(values, "sla.assignment_deadline")`; `signingKey` = `process.env.COMMAND_SIGNING_KEY` |
| `reconciler` | STARTED | `runInTransaction` = `runSerializable`; `readStoreTime` = `clock.readStoreTime` |
| `timer` | STARTED | `handlers` = `expiryActions.handlers({})`, checked by `assertComplete` **before** starting; `regionId` resolved through `Region.regionId` (P15-R6) |
| `coordinator` | **REFUSED** | `expandCandidates` / `pricedCandidateFor` bottom out in an unselected routing engine — **B1, external** |

`values` is an **accessor** (P15-R2), so a promotion composes against the version in force at
the moment leadership is acquired, not the one the process booted on.

### The scheduled workers, and the cutover control plane

`invariant` (composed with `kv`, `emit`, and its check context), `tier_b`,
`rejection_aggregation`, `calibration`, `counterfactual`, `cutover`, and the config
propagator are all started at `server.js`. The cutover controller's dependencies are all real
producers: `liveShards` reads the shard table through the published snapshot,
`declarationFor` reads §21.7's stream, `publish` is `rollbackPublisher.create({…})` over
`configService.publish`/`pinVersion`, `audit` is `auditStream.append`.

**And that last one is where P15-C4 lived.** Every dependency had a production producer; the
producer and the consumer agreed with each other; and the *store* refused what they agreed on.
This pass's addition to the audit method is that a producer/consumer pair agreeing is not
sufficient — **the thing that persists must accept it**, and only a real database can say.

---

## 9. Invariants — WIRED, not OBSERVED

`modeRegister.INVARIANTS` declares **22** (I1 … I22). `invariantWorker.start(…)` is composed
and started at `server.js:142` with `prisma`, `kv`, `emit`, and its full check context.

**WIRED: yes.** It runs, on an interval, against the real store, and writes `InvariantStatus`
rows and `INVARIANT_STATUS_CHANGED` events.

**OBSERVED: no.** The `invariants_enforced` gate is `PRODUCTION` evidence requiring a
zero-violation SLI over an observation window. No such window exists, because no production
fleet exists. The mandate is explicit that this must not be recorded as a wiring defect, and
it is not: **the missing requirement is production observation, not composition.** The gate is
`NOT_EVALUATED` and blocks, which is the honest state.

---

## 10. Shadow path and B1

```
production decision → coordinator.worker   ✗ NOT COMPOSED (B1)
                    → shadow.worker        ✗ NOT COMPOSED (same solve path, B1)
                    → solve path           reachable from server.js, never executed
                    → shadow result        no producer
                    → comparison           no producer
                    → agreement metric     no producer
                    → release gate         shadow_agreement — NOT_EVALUATED
```

**Can the 14-day window begin? No.** It cannot begin until the shadow worker composes, which
cannot happen until B1 selects a routing engine. No observation data was fabricated.

`cutover.shadow_agreement_window` is a registered parameter and `evidence.resolveMinObservationMs`
resolves the bound from it, so the gate is *refused for want of a window* rather than
*unbounded* — which after P15-C1 is now true of the age bound as well.

### Blocker taxonomy, as the mandate requires

| Class | Items |
|---|---|
| **In-repository** | none remaining — P15-C1…C4 were the last four and are fixed |
| **External** | **B1** (routing engine: D1, D3, D8) · **B8** (39 Safety-class parameters) |
| **Observation** | `invariants_enforced`, `soak`, `shadow_agreement`, `simulator_fidelity` — 4 PRODUCTION gates |
| **Evidence** | `rollback_rehearsed`, `safety_case_assembled`, `calibration_safety_derived` — 3 ORGANISATIONAL gates |
| **Specification ambiguity** | **X3** (§4.2 has no transition table) |
| **Future-phase** | **T1-04** (§17.4 escalation ladder) · Tier 2 enablement (Phase 16) |

---

## 11. Attacking the release gate

The mandate's §6 list, each attacked against the current tree.

| Requirement | Result |
|---|---|
| gates are actually executed | `collectEvidence.run()` spawns each command and captures its real exit code |
| evidence contains their real exit codes | `pass` is **derived** from `exitCode === 0`; a contradicting `pass` is refused |
| evidence is bound to the exact source digest | mandatory; **demonstrated** — the digest moved `22ca9143…` → `134ebc0d…` as this pass edited the tree |
| stale evidence is rejected | **WAS NOT** — P15-C1. Now refused, and the bound is mandatory |
| changed source invalidates evidence | `SOURCE_DIGEST_MISMATCH`; the collector also takes the digest **twice** and voids the collection if the tree moved mid-run |
| `NOT_EVALUATED` cannot become PASS | `evaluate()` returns GREEN only for `admissible && pass`; `ok` requires every blocking gate GREEN |
| malformed evidence fails closed | a non-object, a missing `gateId`, a missing `producer`, a missing instant — each refused with a distinct code |
| omitted digest fails closed | `SOURCE_DIGEST_REQUIRED` |
| omitted age bound fails closed | **WAS NOT** — P15-C1. Now `AGE_BOUND_REQUIRED` |
| hand-authored booleans cannot authorise cutover | a bare `{ pass: true }` is refused (`GATE_ID_MISMATCH`); BUILD/SUITE need a run record; ORGANISATIONAL needs two distinct people |
| collection failure cannot silently become green | a killed process records exit 1, never 0; the collector exits non-zero; the verdict judges independently |
| a declaration the reader refuses cannot authorise | **WAS NOT** — P15-C2. Now refused |
| the audit event the authority writes can be written | **WAS NOT** — P15-C4. Now written, read back, and acted on |

---

## 12. Calibration — re-run, nothing manufactured

```
$ npm run gate:calibration
FAIL — 39 blocking finding(s). This is execution-plan pre-work item B8.
242 entr(ies): 52 DERIVED, 152 PROVISIONAL, 38 UNCALIBRATED. 54 are Safety-class.
```

Identical to the arrival baseline. **No value was manufactured, promoted or defaulted.**

Each of the 39 names what it awaits, and none is an engineering task: *per-class rated-mass
certification*; *the operated CA's revocation-publication latency*; *measured p99 round-trip
to the operated consensus store*; *a safety decision with the local highway or site
authority*; *the first one-sided simulator fidelity study against production*.

| Class | Count | Can a build close it? |
|---|---|---|
| DERIVED | 52 | already closed |
| PROVISIONAL | 152 | **no** — requires measurement or attestation |
| UNCALIBRATED | 38 | **no** — requires production/fleet data |
| Safety-class | 54, of which **39 are not DERIVED** | **no** — B8, external |

**Can any value be incorrectly promoted?** No path was found. The publish validator refuses
the register's own defaults (V9), so a deployment cannot even publish its first configuration
version from defaults — a consequence of B8 sharper than "the calibration gate is red", and
one this pass re-confirmed live (`phase15CurrentTree.js` G3, 190 launch-gate findings against
the publish path).

**Can the gate be bypassed?** `calibration_safety_derived` is ORGANISATIONAL with
`runnable: true`, so an attestation must be accompanied by a corroborating run of
`npm run gate:calibration` that **exited 0**. An attestation cannot outrank the check it is
about. P15-C3 closes the one way that pairing could have been silently skipped, and the
strengthened test in `checkCalibration.test.js` now proves the gate is the *only* blocker in
an otherwise-green table rather than merely one of twenty-four.

---

## 13. Test integrity

**No test was deleted, skipped, weakened or retargeted.** One was **strengthened**, and one
was **corrected at its source**; both are named individually.

### `checkCalibration.test.js` — *"no shard can be enabled while it is red"* · STRENGTHENED

**What it did.** Filed `{ pass: <bool> }` for every gate, supplied no `sourceDigest` and no
`evidenceMaxAgeMs`, and handed over `{ shardId, declaredAtMs, guardrails: [] }`.

**Why that was wrong.** A bare `{ pass }` carries no `gateId`, so **all twenty-four** gates
were inadmissible, and `toMatch(/calibration_safety_derived \(RED\)/)` only asked that
calibration appear somewhere in a list of twenty-four red rows. **Remove the calibration
gate's blocking flag entirely and the test still passed.** It could not fail for the reason
its own title gives.

Worse, and worth recording: its fixture was P15-C2's exact reproduction shape (an empty
guardrail set) sitting next to P15-C1's (a missing context). *A fixture built to be ignored by
the code under test is a fixture that will not notice when the code stops ignoring it.*

**How the replacement is stronger.** The request is now valid in every respect **except** the
gate under test, which is red for its own reason (a corroborating run exiting 1). It asserts
`refusal.detail` has **length 1** and names calibration — and then flips the exit code to 0
and asserts the same request **is authorised**. It now fails if the gate stops blocking, not
merely if it stops existing.

### `observabilitySchema.test.js` — the audit vocabulary drift guard · CORRECTED AT ITS SOURCE

**What it did.** Read the CHECK list out of the Phase 11/12 migration that first created it
and compared that to `auditStream.EVENT_TYPES`.

**Why that was wrong.** The pairing was right; the source was not. A later migration may
supersede the constraint, and then the test compares the application against a list the
database stopped using.

**How the replacement is stronger.** It resolves the constraint **in force after the whole
chain** — the last migration to define it — and asserts the original is still among the
definers, so it cannot pass by finding nothing. This is the same subtraction
`columnsAddedLater()` already performs for columns, under the header's own rule: *"a
subtraction and not a relaxation … while letting the schema move forward."*

**Recorded explicitly:** this guard did **not** cause P15-C4 and did not fail to do its job.
It kept the two things it pinned in exact agreement. The missing leg was a third pair nobody
had pinned — the types the producer emits — and that is now pinned in the new suite.

### The new suite

`tests/engine/phase15EvidenceBindingRemediation.test.js` — **41 tests**.

### Regression tests, per defect

| Defect | What is pinned | Where |
|---|---|---|
| P15-C1 | a missing age bound is refused, not treated as unbounded | `phase15EvidenceBinding…` ×2 |
| P15-C1 | a missing evaluation instant is refused (staleness **and** future-stamp) | ×1 |
| P15-C1 | `NaN` / `Infinity` / negative / string / null bounds each refused | ×1 (5 cases) |
| P15-C1 | a zero bound is honoured — a stated bound is a bound | ×1 |
| P15-C1 | the requirement holds for **all 24 gates**, not only digest-bearing ones | ×1 |
| P15-C1 | `evaluate()` reports RED with a reason, and `NOT_EVALUATED` stays distinct | ×1 |
| P15-C1 | `authoriseEnable` refuses each of the three context fields **by name** | ×3 |
| P15-C1 | the refusal is `EVIDENCE_CONTEXT_INCOMPLETE`, **not** `RELEASE_GATE_NOT_GREEN` | ×1 |
| P15-C1 | **the defect**: a 3-year-old rehearsal is refused both ways | ×1 |
| P15-C1 | a missing `requestedAtMs` also disabled the pre-declaration ordering check | ×1 |
| P15-C1 | `verdict.js` exits 2 on an unparseable bound, **and 1 on a valid one** | ×3 |
| P15-C2 | a hand-built declaration does not authorise a cutover | ×1 |
| P15-C2 | an empty guardrail set is refused by **both** sides | ×1 |
| P15-C2 | five malformed declarations, each refused | ×1 (5 cases) |
| P15-C2 | **the round trip**: `auditEventFor` → `guardrails.declare` does not throw | ×1 |
| P15-C2 | the action carries the **normalised** declaration | ×1 |
| P15-C2 | a wrong-shard declaration is refused and says which | ×1 |
| P15-C2 | an absent declaration keeps the original message | ×1 |
| P15-C3 | the shipped table is well formed; no non-ORGANISATIONAL row is flagged | ×2 |
| P15-C3 | PRODUCTION returns before the branch that reads either flag | ×1 |
| P15-C3 | `simulator_fidelity` — the row the guard exists for — is unflagged | ×1 |
| P15-C4 | both cutover types are in the vocabulary | ×1 |
| P15-C4 | writer and reader take the names from that one vocabulary | ×1 |
| P15-C4 | **the drift guard**: every declared type is admitted by the constraint in force, and no other | ×1 |
| P15-C4 | `append()` reaches the store rather than refusing by type | ×1 |
| P15-C4 | an unrecognised type is still refused — widened, not removed | ×1 |
| P15-C4 | the event carries a valid `recordedAt`, from the authorisation's clock | ×1 |
| P15-C4 | an action with no instant is refused, not stamped with `Date.now()` | ×1 |
| P15-C4 | whatever `authoriseEnable`/`authoriseRollback` emit **is writable** | ×1 |

Every one of them fails on the unremediated tree, and the fourteen that guard a removable line
are mutation-tested in §14.

---

## 14. Mutation results — 14 / 14 caught

Each protection was removed from the source, the tests that should catch it were run and
required to **fail**, the file was restored byte-for-byte, and they were required to pass
again.

| | Protection removed | Verdict |
|---|---|---|
| M1 | `admit()` refuses a missing age bound | **CAUGHT** |
| M2 | `admit()` refuses a missing evaluation instant | **CAUGHT** |
| M3 | a `NaN`/`Infinity` age bound is not a bound | **CAUGHT** |
| M4 | the staleness comparison is unconditional | **CAUGHT** |
| M5 | `authoriseEnable()` refuses an incomplete evidence context | **CAUGHT** |
| M6 | `authoriseEnable()` validates the guardrail declaration | **CAUGHT** |
| M7 | the pre-declaration ordering check | **CAUGHT** |
| M8 | `assertGates()` pins `runnable`/`rehearsal` to ORGANISATIONAL | **CAUGHT** |
| M9 | `verdict.js` refuses a `--max-age-hours` that does not parse | **CAUGHT** |
| M10 | the audit vocabulary admits `CUTOVER_SHARD_ENABLED` | **CAUGHT** |
| M11 | the vocabulary and the CHECK constraint in force agree | **CAUGHT** |
| M12 | `auditEventFor` emits types from that vocabulary | **CAUGHT** |
| M13 | a cutover audit event carries the instant it was authorised | **CAUGHT** |
| M14 | a missing instant is refused, not stamped with the writer's clock | **CAUGHT** |

M8 and M14 required a **planted** companion edit to be catchable at all — M8 needs a
PRODUCTION row that declares `runnable: true` (the shipped table has none), and M14 needs the
`Date.now()` fallback the throw exists to prevent. Both are recorded because a mutation that
cannot be expressed without a plant is a protection guarding a shape rather than a line.

```
restoring and re-checking the baseline
  restored GREEN
14/14 mutations caught
```

---

## 15. Live PostgreSQL verification — 269 checks

A disposable PostgreSQL **18.3** cluster on port **55437**, built from the installed binaries
into the scratchpad, with the complete migration chain applied **from an empty database**:

```
$ dropdb --if-exists && createdb && for d in prisma/migrations/*/; do psql -v ON_ERROR_STOP=1 -f "$d/migration.sql"; done
APPLIED 27 migrations from empty; FAILED=''
$ psql -tAc "select pg_get_constraintdef(oid) from pg_constraint where conname='AuditEvent_event_type_known'"
CHECK ("eventType" = ANY (ARRAY['OPERATOR_ACTION', …, 'CUTOVER_SHARD_ENABLED', 'CUTOVER_SHARD_ROLLED_BACK']))
```

No production or Neon data; the harnesses refuse a shared instance and the default port by
name.

| Harness | Checks |
|---|---|
| `tools/verify/phase15EvidenceBinding.js` — **NEW** | **17 / 17** |
| `tools/verify/phase15CurrentTree.js` (pass 1) | 32 / 32 |
| `tools/verify/phase15LiveDatabase.js` | 12 / 12 |
| `tools/verify/phase5ExpirySemantics.js` | 102 / 102 |
| `tools/verify/phase5LiveDatabase.js` | 106 / 106 |
| **total** | **269 / 269** |

### The new harness, group by group

| Group | Checks | What it establishes |
|---|---|---|
| A — P15-C1 | 6 | the authority refuses what it cannot judge; a 3-year-old rehearsal is refused twice over; 7 digest-free gates each refused without a bound |
| B — P15-C2 | 4 | the **round trip**: authorise → `auditEventFor` → §21.7's stream → `declarationFor` → `assess` → a real breach reaching the rollback publisher |
| C — the pre-fix consequence | 3 | an invalid declaration in the stream leaves the shard live and unassessed for ever — reproduced by bypassing the authority, and the authority can no longer produce it |
| D — P15-C4 | 3 | the constraint admits every declared type; a raw insert lands; an undeclared type is still refused |

### What live execution found that a green suite did not

**P15-C4 was found by this harness and by nothing else.** 6 960 tests were green over a
cutover control plane that could not write its own audit event, could not read its own
pre-declaration, and could never assess a shard. The harness was written to prove P15-C2's
round trip; the first `auditStream.append` it attempted returned a refusal, and the finding
was in the refusal.

That is now the **sixth consecutive phase** where live execution found what the store model
could not, and it is the first time the finding was a defect in the *specification of a
vocabulary* rather than in a code path.

---

## 16. Cross-phase integrity — Phases 0–5

**Every file this pass changed, with its owner:**

| File | Owner | Change |
|---|---|---|
| `src/engine/cutover/evidence.js` | Phase 15 | P15-C1 — two required context fields |
| `src/engine/cutover/stage.js` | Phase 15 | P15-C1, P15-C2, P15-C4 |
| `src/engine/cutover/gates.js` | Phase 15 | P15-C3 — a load-time assertion |
| `src/engine/cutover/store.js` | Phase 15 | P15-C4 — reads the vocabulary instead of restating it |
| `src/controllers/health.controller.js` | Phase 15 (cutover view) | P15-C1 — supplies the clock it has |
| `tools/release/verdict.js` | Phase 15 | P15-C1 — CLI argument refusal |
| `tests/engine/phase15EvidenceBindingRemediation.test.js` | Phase 15 | **NEW** — 38 tests |
| `tools/verify/phase15EvidenceBinding.js` | Phase 15 | **NEW** — 17 live checks |
| **`src/engine/observability/auditStream.js`** | **Phase 12** | **+30 lines, −0.** Two vocabulary entries. |
| **`prisma/migrations/20260823120000_…/migration.sql`** | **NEW MIGRATION** | widens one CHECK constraint |
| **`tests/engine/observabilitySchema.test.js`** | **Phase 11/12** | drift guard reads the constraint in force |

### The three changes outside Phase 15, justified individually

**1. `auditStream.js`** — Phase 15 emits two event types that this module owns the vocabulary
for. The omission is Phase 15's (it introduced the names without registering them); the
registry is Phase 12's. The change is **purely additive — 30 insertions, 0 deletions** —
adding two enum entries. No existing type changes meaning, no existing caller changes
behaviour, and an unrecognised type is still refused (verified live, D3). It does not reopen
Phase 12: Phase 12's own drift guard still passes, now against the constraint in force.

**2. The migration** — `AuditEvent` is a **Phase 11/12** table, not a Phase 0–5 one. The
migration creates, drops and alters **nothing**: it replaces one CHECK constraint with the
same constraint plus two permitted values. That is a **strict widening** — every row
admissible before is admissible after — and `AuditEvent` is append-only, so no existing row
can be invalidated. The constraint is kept rather than dropped, for the reason the original
migration gives: *"an append-only stream that accepts an unrecognised event type accepts an
event nobody defined the meaning of."* CHECK constraints are not expressible in
`schema.prisma` and live in migrations throughout this repository; no schema file changed.

**3. `observabilitySchema.test.js`** — a test, corrected at its source and strengthened,
argued in full at §13.

### Phase 0–5 modules: untouched

```
$ git status --porcelain -- Backend/src/db Backend/src/engine/commitment \
    Backend/src/engine/dispatch Backend/src/engine/domain Backend/src/engine/shard
(empty)
```

`Backend/prisma/seed.js` shows as modified in `git status`. **It was already modified when
this pass began** — it is in the working tree at session start and no change of this pass
touches it.

**Phase 5's contracts** — `timers.register`, `timers.resolve`, `transitions.apply`,
`expiryActions.handlers` — are unchanged, and its two harnesses pass **102/102** and
**106/106** against a fresh database on this tree.

---

## 17. Attacking the Phase 5 integration points

The mandate's §11 list, verified rather than assumed. The purpose is not to reopen Phase 5 but
to confirm Phase 15's integration consumes its contracts correctly.

| Attack | Result |
|---|---|
| ACCEPTED supervision | armed by `legEntryDeadline.superviseEntry` in the accepting transaction; fires `probeThenReassign` |
| QUEUED supervision | armed on **both** paths, with identical payloads |
| TASK timer reachability | **0 producers — SPECIFICATION blocker (X3)**, re-derived live |
| timer worker composition | `assertComplete` refuses an incomplete handler map **before** starting |
| leader-only execution | `LEADER_ONLY`; nothing in `server.js` calls `start()` directly |
| demotion | `stopAll()` on any tick without `mayRunRound` |
| restart | a deadline that passed while no worker ran is fired by a freshly started one (live) |
| duplicate timers | the §4.5 key is unique; two registrations → one row |
| stale timers | `DISCARDED / ENTITY_VERSION_MOVED_ON` |
| concurrent workers | `claim()` — two workers firing one timer produce one page |
| transaction rollback | effect and resolution commit together; a throw rolls both back |
| stale version | version CAS; the loser writes nothing |
| state changes outside `transitions.apply` | **this is X2a/X2b**, and `legEntryDeadline` is the single implementation that closes them |

**No Phase-5-owned defect was discovered by this pass.**

---

## 18. Exact measured results

### Test suites

```
Test Suites: 158 passed, 158 total
Tests:       7001 passed, 7001 total
Time:        226.844 s
Ran all test suites in 5 projects.
```

Suites per project, as `--listTests` reports them on the final tree:

| Project | Suites |
|---|---|
| engine | 128 |
| gates | 9 |
| legacy | 18 |
| chaos | 4 |
| scale | 4 |
| **total** | **158** |

Test counts are reported only in the aggregate the runner printed — **6 960 → 7 001**. A
per-project test split was not separately measured on this tree and is therefore not quoted;
the +41 are exactly the new suite's 41. `checkCalibration` (13) and `observabilitySchema` (27)
each kept their test count: one test in each was replaced, not added to.

### Build gates — 7 PASS, 1 FAIL (correctly)

```
gate: tier-dependencies          PASS — 285 modules, 422 governed import edges, no Tier 0/1 → Tier 2
gate: parameter-register         PASS — 189 engine modules against 242 registered parameters
gate: tenets                     PASS — 282 modules, no violations
gate: identity-isolation         PASS — 16 modules
gate: reconstruction-equivalence PASS — 3 decisions, byte for byte
gate: legacy-retirement          PASS — 4 retired modules absent, 339 files
gate: column-generation          PASS — NOT_REQUIRED
gate: composition-root           FAIL — 1 violation across 18 registered workers:
    coordinator (tier 0) [LEADER_ONLY_NOT_COMPOSABLE] … B1 … EXTERNAL to this repository
```

The tier gate passes **with** the new `cutover → observability` edge that P15-C4 introduced —
285 modules and 422 governed import edges, no Tier 0/1 → Tier 2 dependency. That edge is the
one structural risk in this pass's changes and it is the gate that would have caught it.

### The other two

```
$ npm run gate:calibration   exit 1 — 39 blocking findings; 242 entries; 54 Safety-class
$ npm run sim:fidelity       exit 1 — 7 models NOT_MEASURED (6 safety-relevant); no study supplied
```

### Source digest

```
arrival: 22ca91435d46cf2abf03932637637bcb7986f23c71090211637190305fbb5b00  (560 files)
closure: 134ebc0d1d6cd047b5ebb62de9808489274520c9c9607795a9ef0d9e43373a2c  (562 files)
```

The digest moved as the tree was edited, which is the evidence-invalidation property
demonstrated rather than asserted.

---

## 19. Explicitly NOT proven

Stated plainly, because a closure that omits this section is not one.

1. **No shard has ever been taken live by this machinery.** What is proven is that the
   authority refuses every incomplete or stale request put to it, and that a *complete* one
   produces an audit event a real database accepts and a real controller acts on.
2. **The automatic rollback has never fired in production.** It is proven end to end against
   a live database — a real breach, a real `declarationFor` read, a real published binding —
   and that is a harness, not a fleet.
3. **The seven `TASK` expiry handlers have never fired and cannot** (X3). `TASK`-entity timers
   in the live store after a full harness run: **0**.
4. **`ESCALATION_LADDER` has never relaxed anything** (X1, T1-04).
5. **No production observation exists for any of the 4 PRODUCTION gates.** The 14-day shadow
   window has not begun and cannot begin until B1.
6. **The 39 Safety-class calibration findings are unchanged and no value was manufactured.**
7. **Nothing here proves the engine assigns work.** `coordinator.worker` remains uncomposable.
   A shard with `ENGINE_ENABLED=true` today would supervise deadlines correctly on Legs that
   nothing creates.
8. **No production environment was used.** All evidence is from a disposable local PostgreSQL
   18.3 instance. No soak, no multi-shard run, no real fleet.
9. **X-C1 is reported, not fixed** — `auditStream.link()` still turns an absent instant into
   an Invalid Date. Phase 15's callers no longer produce one.
10. **X-C2 is reported, not fixed** — `guardrails.assess()` still throws on a malformed
    declaration. No production path can now reach it with one.
11. **`prisma migrate diff` still reports the Phase 1 drift.** Not re-investigated here.
12. **The 24-gate table has never been green**, and 7 of its rows cannot be closed by any
    commit in this repository.

---

## 20. Exact commands

```bash
# ── baseline, before any change ────────────────────────────────────────────
git log --oneline -1 && node tools/release/sourceDigest.js
npx jest --runInBand --forceExit                       # 157 suites / 6960 tests
npm run gates                                          # 7 PASS, composition FAIL(1)
npm run gate:calibration; npm run sim:fidelity; npm run routing:readiness

# ── disposable PostgreSQL 18.3, port 55437, migration chain from empty ─────
initdb -D <scratch>/pg15data -U pgverify --pwfile=<file> -A trust -E UTF8 --locale=C
postgres -D <scratch>/pg15data -p 55437 -c listen_addresses=127.0.0.1   &
createdb -h 127.0.0.1 -p 55437 -U pgverify robotx_phase15
for d in prisma/migrations/*/; do psql -h 127.0.0.1 -p 55437 -U pgverify \
    -d robotx_phase15 -v ON_ERROR_STOP=1 -q -f "${d}migration.sql"; done   # 27 migrations
export DATABASE_URL="postgresql://pgverify:pgverify@127.0.0.1:55437/robotx_phase15"
npx prisma generate

# ── reproductions, before the fixes ────────────────────────────────────────
node <scratch>/repro-age.js      # P15-C1: a 3-year-old rehearsal authorises a cutover
node <scratch>/repro2.js         # P15-C1: requestedAtMs omitted → 3 protections off
node <scratch>/repro3.js         # P15-C2: an empty guardrail set authorises a cutover
node <scratch>/repro4.js         # P15-C4: no cutover audit event can be written, at all

# ── verification, after ────────────────────────────────────────────────────
node tools/verify/phase15EvidenceBinding.js            # 17/17   (new)
node tools/verify/phase15CurrentTree.js                # 32/32
node tools/verify/phase15LiveDatabase.js               # 12/12
node tools/verify/phase5ExpirySemantics.js             # 102/102
node tools/verify/phase5LiveDatabase.js                # 106/106
node <scratch>/mutate.js                               # 14/14 caught
npx jest --runInBand --forceExit                       # 158 suites / 7001 tests
npm run gates                                          # 7 PASS, composition FAIL(1)
npm run release:gates                                  # §21

# ── cross-phase integrity ──────────────────────────────────────────────────
git status --porcelain -- Backend/src/db Backend/src/engine/{commitment,dispatch,domain,shard}
git diff --stat -- Backend/src/engine/observability/auditStream.js   # +30 −0

# ── teardown ───────────────────────────────────────────────────────────────
pg_ctl -D <scratch>/pg15data -m fast stop
```

---

## 21. `npm run release:gates`, measured

Run to completion on the final tree, with nothing edited while it ran. **Measured results
only; no gate status here is predicted.**

### 21.1 The collection

`tools/release/collectEvidence.js` executed **18 distinct commands** and recorded each one's
real exit code. Total wall clock ≈ 14 minutes, dominated by four full `test:engine` runs.

```
release evidence (§24) — produced by running the gates, not by asserting them
  source digest 134ebc0d1d6cd047…
  PASS     1161ms  npm run gate:tiers
  PASS     1071ms  npm run gate:params
  PASS     1070ms  npm run gate:tenets
  PASS     1024ms  npm run gate:privacy
  PASS     1113ms  npm run gate:erasure
  FAIL     1034ms  npm run gate:calibration
  PASS     1457ms  npm run gate:legacy
  FAIL     1890ms  npm run gate:composition
  PASS   186981ms  npm run test:engine -- candidatesLowerBound
  PASS   189344ms  npm run test:engine -- ModelCheck
  PASS   190665ms  npm run test:engine -- determinism
  PASS   189069ms  npm run test:engine -- observabilityDecisionRecord
  PASS     2762ms  npm run test:chaos
  PASS     2703ms  npm run test:chaos -- cacheFlush
  PASS    21887ms  npm run test:scale
  PASS    21743ms  npm run test:scale -- locality
  PASS    21690ms  npm run test:scale -- overload
  PASS      241ms  node tools/safetyCase/assemble.js
  17 gate record(s), 2 corroborating run(s). PRODUCTION and ORGANISATIONAL gates are not
  closable here and remain NOT_EVALUATED.
```

Two of the eighteen failed, and both failures are the honest ones — `gate:calibration` (B8)
and `gate:composition` (B1). Neither was recorded as a pass.

### 21.2 The verdict

```
RELEASE VERDICT — §24 gate table (24 gates, all blocking)
  source digest 134ebc0d1d6cd047…   evidence: docs\release-evidence.json   attestations: (none)
  16 green, 1 red, 7 not evaluated

  GREEN         tier_dependencies                    BUILD           §1.8
  GREEN         parameter_register                   BUILD           §22.1
  GREEN         design_tenets                        BUILD           §1.5
  GREEN         identity_isolation                   BUILD           §23.7
  GREEN         erasure_reconstruction_equivalence   BUILD           §23.7, §24.3
  NOT_EVALUATED calibration_safety_derived           ORGANISATIONAL  §22.4
  GREEN         legacy_removed_from_build            BUILD           execution plan, Phase 15
  RED           engine_decision_path_wired           BUILD           execution plan, Phase 15
    exit 1 from `npm run gate:composition`
  GREEN         lower_bound_admissibility            SUITE           §6.4, §24.1
  GREEN         model_check_capacity_1_2_3           SUITE           §24.2
  GREEN         determinism_replay                   SUITE           §24.3
  GREEN         snapshot_retention                   SUITE           §24.3
  GREEN         chaos_capacity_1                     SUITE           §24.5
  GREEN         chaos_capacity_2                     SUITE           §24.5
  GREEN         cache_tier_flush                     SUITE           §3.3, §24.5, I16
  GREEN         scale_targets                        SUITE           §20.1, §24.6
  GREEN         locality                             SUITE           §24.6, T9
  GREEN         overload_admission_control           SUITE           §20.5, §24.6
  NOT_EVALUATED invariants_enforced                  PRODUCTION      §26
  NOT_EVALUATED simulator_fidelity                   PRODUCTION      §24.4
  NOT_EVALUATED soak                                 PRODUCTION      §24.6
  NOT_EVALUATED shadow_agreement                     PRODUCTION      §21.6
  NOT_EVALUATED safety_case_assembled                ORGANISATIONAL  §24.7
  NOT_EVALUATED rollback_rehearsed                   ORGANISATIONAL  execution plan, Phase 15

  RELEASE: BLOCKED — 8 blocking gate(s) are not green.
```

```
$ node tools/release/verdict.js ; echo $?
1
```

| | Count |
|---|---|
| GREEN | **16** |
| RED | **1** — `engine_decision_path_wired` (B1) |
| NOT_EVALUATED | **7** — 4 PRODUCTION, 3 ORGANISATIONAL |
| **blocking and not green** | **8** |

### 21.3 The binding, demonstrated rather than asserted

```
$ node tools/release/sourceDigest.js
134ebc0d1d6cd047b5ebb62de9808489274520c9c9607795a9ef0d9e43373a2c  (562 files)

$ node -e "…docs/release-evidence.json…"
134ebc0d1d6cd047b5ebb62de9808489274520c9c9607795a9ef0d9e43373a2c
schema: robotx.release-evidence.v1   only: all   records: 17   corroborations: 2
```

The evidence's digest **is** the final tree's digest, and it moved twice during this pass as
the tree was edited (`22ca9143…` → `38d049e2…` → `134ebc0d…`). Evidence collected before those
edits would now be refused with `SOURCE_DIGEST_MISMATCH`. That is the invalidation property
working, observed rather than argued.

### 21.4 Four things this table proves that it could not before this pass

1. **`calibration_safety_derived` is NOT_EVALUATED, not GREEN**, even though the collector ran
   its command. The command **failed**, so its corroborating run cannot support an attestation
   — and no attestation was filed. It stays not-evaluated and it blocks.
2. **The 7 not-evaluated rows cannot be closed here**, and the collector says so in its own
   output rather than leaving their absence to be inferred.
3. **`NOT_EVALUATED` blocks exactly as `RED` does**, and the two stay distinct so an incident
   review can tell *"we ran it and it failed"* from *"nobody ran it"*.
4. **The one RED row is red for B1**, and it is the same row that has been red since the
   composition gate was written.

---

## 22. Closure decision

# PHASE 15 — BLOCKED

**Every Phase-15-owned, in-repository blocker is closed.** Four were found on this tree and
four are fixed, each reproduced before, attacked after, mutation-tested 14/14, and verified
against a real PostgreSQL instance driving the shipped composition.

Phase 15 is **not** closed, and the mandate is explicit that repository-completeness is not
closure:

| Blocker | Class | Why no commit here closes it |
|---|---|---|
| **B1** — no routing engine selected | **EXTERNAL** | D1 (operating region), D3 (fleet speed model), D8 (extract vintage). None is an engineering task. `coordinator` and `shadow` cannot compose; `gate:composition` stays red; `engine_decision_path_wired` stays red. |
| **B8** — 39 Safety-class parameters not DERIVED | **EXTERNAL** | Requires measurement, certification and named-owner attestation. |
| 4 PRODUCTION gates | **OBSERVATION** | Require a fleet that has operated. The 14-day shadow window cannot begin until B1. |
| 3 ORGANISATIONAL gates | **EVIDENCE** | Require named humans to have acted. |
| **X3** — §4.2's half of §4.5 | **SPECIFICATION** | The frozen specification contains no Task transition table. Inventing one is not remediation. |

**Phase 16 — NOT READY.** §1.8 rule 3 enables Tier 2 mechanisms one at a time *after* the
cutover. There has been no cutover.

### Recommendation

1. **B1 and B8 are the whole of the critical path.** Both are decisions, not code.
2. **T1-04** (§17.4's escalation ladder) is the next *remedial* phase and is independent of
   both.
3. **X-C1** should be routed to Phase 12's owner.
4. **A third pass over Phase 15 is not the highest-value next step.** Two passes have now
   found ten defects between them, and the marginal finding is getting deeper and rarer — but
   the four found here share a property worth acting on generally: *every one was a rule
   enforced only when its input happened to be supplied.* A sweep for that shape across the
   other phases' fail-closed paths would likely be worth more than a third pass here.

---

## 23. What this pass changes about how the programme audits

Recorded because it is the transferable part.

Pass 1's lesson was **"implemented + unit-tested + never called."** This pass's is narrower and
sharper:

> **A producer and a consumer that agree with each other are not evidence that either is
> right.** `stage.auditEventFor()` and `cutover/store.js` agreed perfectly on two event type
> names for the entire life of the cutover machinery. The store refused both. Only writing
> the row to a real database could tell.

And its companion, which accounts for the other three findings:

> **A protection guarded by `typeof x === "number"` is a protection with an off switch, and
> the off switch is "omit the argument."** Every such guard on a fail-closed path is a place
> where the check and the check's absence are indistinguishable to every test that supplies
> the argument — which is all of them.

---

# PHASE 15 — BLOCKED
