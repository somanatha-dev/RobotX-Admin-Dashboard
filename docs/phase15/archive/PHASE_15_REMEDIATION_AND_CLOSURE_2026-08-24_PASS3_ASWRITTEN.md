# Phase 15 — Third-Pass Adversarial Audit, Remediation, Re-verification and Closure

**Date:** 2026-08-24 · **Branch:** `feature/dashboard` · **Baseline commit:** `3f0e522` ("maps enhanced")
**Source digest at arrival:** `134ebc0d1d6cd047b5ebb62de9808489274520c9c9607795a9ef0d9e43373a2c` (562 files)
**Source digest at closure:** *(§19)*
**Authority order:** `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` (FROZEN) → `IMPLEMENTATION_EXECUTION_PLAN.md` → the repository → the phase documents.

---

## 0. What this document supersedes, and what it does not

This file previously held the 2026-08-22 targeted-blocker remediation. **That content is
preserved verbatim** at `PHASE_15_REMEDIATION_AND_CLOSURE_2026-08-22.md`; not one character
of it was altered, and the copy was verified by hash. No finding of any earlier pass has been
removed, softened or rewritten.

| Document | Written against | Status |
|---|---|---|
| `PHASE_15_FINAL_IMPLEMENTATION_AND_CLOSURE_REPORT.md` (2026-08-21) | pre-Phase-5 tree | **Superseded** |
| `PHASE_15_REMEDIATION_AND_CLOSURE_2026-08-22.md` (this file's prior content) | 155 suites / 6 850 tests; D-4 … D-13 | **Preserved. Its findings stand; its verdict is superseded.** |
| `PHASE_15_ADVERSARIAL_AUDIT_PASS_1_2026-08-22.md` | 156 → 157 suites; P15-R1 … R6, X2a, X2b | **Preserved. Findings stand; verdict superseded.** |
| `PHASE_15_ADVERSARIAL_REMEDIATION_AND_CLOSURE.md` (pass 2, 2026-08-23) | 157 → 158 suites; P15-C1 … C4 | **Preserved. Findings stand; verdict superseded by this pass.** |
| **this document** | 158 → 160 suites, current tree | **Current.** |

### The mandate's premise, checked rather than accepted

The instruction for this exercise states the current position as *158 suites, 7 001 tests, 0
failures, 269 live PostgreSQL checks, 14/14 mutations, release:gates 16/1/7, digest
`134ebc0d…`, PHASE 15 BLOCKED* — and adds that *"the remaining blockers now appear to be
external/evidence/specification dependencies rather than ordinary Phase-15 implementation
defects."*

**Every measured number in that premise was re-derived on the current tree and every one of
them was correct.** The qualitative half was not. Pass 2's own §10 states *"In-repository:
none remaining — P15-C1…C4 were the last four and are fixed."*

**Six further Phase-15-owned, in-repository defects were found on this tree. Five are fixed in
full and the sixth in part**, with the unfixed half stated and argued rather than left implied
(§3, P15-E6). Two are permissive fail-opens at the release authority; one is a fail-open in the
automatic rollback's composition root that only a live database could prove; one made the §24
state-machine gate's exhaustiveness claim **unachievable in principle**; one is a permissive
fail-open on a currently-unreachable path; and one is a broken operator procedure whose check can
never pass.

A seventh item is a **blocker this pass discovered rather than closed**: `model_check_capacity_1_2_3`
is GREEN and its statement is not established (§14, B-M).

---

## 1. Final verdict

# PHASE 15 — BLOCKED. PHASE 16 — NOT READY.

The verdict is unchanged from three earlier passes, and it is unchanged for the same reason:
the decision path terminates in a routing engine that B1 has not selected. Nothing here moves
that, and nothing here pretends to.

What *has* changed is that the claim "every repository-owned blocker is closed" was false when
it was made, and the six defects behind it are now closed — plus one blocker this pass
**discovered rather than closed**, which is recorded as such (§14, §22).

| | Baseline (measured, before this pass) | After |
|---|---|---|
| Test suites / tests | 158 / 7 001 | *(§19)* |
| Build gates | 7 PASS, `gate:composition` FAIL (1, `coordinator`, EXTERNAL/B1) | *(§19)* — unchanged in substance |
| `gate:calibration` | exit 1 — 39 findings; 242 entries (52 DERIVED, 152 PROVISIONAL, 38 UNCALIBRATED), 54 Safety-class | **unchanged, nothing manufactured** |
| `sim:fidelity` | exit 1 — 7 models `NOT_MEASURED`, 6 safety-relevant | **unchanged, nothing manufactured** |
| `routing:readiness` | `OVERALL: BLOCKED` — D1, D3, D8; no engine selected | **unchanged** |
| Live-PostgreSQL checks | 269 | **288** (19 new) |
| Migrations applied from empty | 27 | 27, 0 failures, 74 tables |
| Mutations | 14 / 14 (pass 2) | **10 / 12 caught, 2 survivors proven benign** (§16) |
| Source digest | `134ebc0d…` (562) | *(§19)* |

### What the six findings have in common

Pass 1's lesson was *"implemented, unit-tested, never called."* Pass 2's was *"a rule enforced
only when the caller happens to supply the input it is enforced against"*, and it named the
mechanism precisely:

> A protection guarded by `typeof x === "number"` is a protection with an off switch, and the
> off switch is "omit the argument."

Pass 2 then fixed four such guards **and left three standing in the same two files**. Two of
the three are worse than omission, because `typeof NaN === "number"`: the caller need not omit
anything, and every comparison against the value it does supply is false. This pass's lesson is
therefore narrower and less comfortable:

> **A pass that names a defect shape and does not sweep for it has found one instance, not the
> class.** The search that produced P15-E1 and P15-E3 was one `grep` for the pattern pass 2
> wrote down.

And its companion, which accounts for the other three:

> **A claim of completeness must be able to be false.** `lifecycleModel`'s `exhaustive` flag,
> the health endpoint's `releaseGates.blocking` list, and `rollbackPublisher`'s "the version in
> force" all reported a state they were structurally incapable of contradicting.

---

## 2. Current baseline, measured before anything was changed

```
$ git log --oneline -1
3f0e522 maps enhanced        (Backend unchanged since 450d829; uncommitted paths are pass 2's + Frontend/maps)

$ npx jest --runInBand --forceExit
Test Suites: 158 passed, 158 total
Tests:       7001 passed, 7001 total
Time:        221.311 s

$ npm run gates
gate: tier-dependencies          PASS
gate: parameter-register         PASS
gate: tenets                     PASS
gate: identity-isolation         PASS
gate: reconstruction-equivalence PASS — 3 corpus decisions, byte for byte
gate: legacy-retirement          PASS — 4 retired modules absent, 339 files
gate: column-generation          PASS — NOT_REQUIRED
gate: composition-root           FAIL — 1 violation: coordinator [LEADER_ONLY_NOT_COMPOSABLE, EXTERNAL, B1]

$ node tools/gates/checkCalibration.js ; echo $?
FAIL — 39 blocking finding(s).  242 entries: 52 DERIVED, 152 PROVISIONAL, 38 UNCALIBRATED. 54 Safety-class.
1
$ node tools/simFidelity/validate.js ; echo $?        → 7 NOT_MEASURED (6 SAFETY); 1
$ node tools/routing/b1Readiness.js                   → OVERALL: BLOCKED (D1, D3, D8; steps 1,3,4,5)
$ node tools/release/verdict.js ; echo $?             → 1
$ node tools/release/sourceDigest.js
134ebc0d1d6cd047b5ebb62de9808489274520c9c9607795a9ef0d9e43373a2c  (562 files)

# disposable PostgreSQL 18.3, port 55439, chain applied from an empty database
tables before: 0 → APPLIED 27 migrations from empty, FAILED: (none) → 74 tables
AuditEvent_event_type_known admits CUTOVER_SHARD_ENABLED and CUTOVER_SHARD_ROLLED_BACK

tools/verify/phase15EvidenceBinding.js   17 / 17
tools/verify/phase15CurrentTree.js       32 / 32
tools/verify/phase15LiveDatabase.js      12 / 12
tools/verify/phase5ExpirySemantics.js   102 / 102
tools/verify/phase5LiveDatabase.js      106 / 106
                                        ───────────
                                        269 / 269
```

Registry: **18 workers — 8 SCHEDULED, 4 LEADER_ONLY, 6 DEFERRED.** `modeRegister.INVARIANTS`
declares **22** (I1 … I22).

Every number the mandate supplied was reproduced. Nothing below is inherited from a report.

---

## 3. New findings — all Phase-15-owned, all fixed

### P15-E1 — a PRODUCTION observation window that is not a window · **BLOCKING (permissive)** · FIXED

**Root cause.** `evidence.admit()`'s PRODUCTION branch read both window endpoints through
`typeof … === "number"`, which admits `NaN` and `±Infinity`. Every duration comparison against
`NaN` is false, so **the checks did not fail — they did not run**:

```js
const duration = observation.windowEndedAtMs - observation.windowStartedAtMs;   // NaN
if (duration <= 0) …                                    // false
if (typeof required === "number" && duration < required) …   // false
return accept(record.pass === true, …);                 // ADMITTED, PASS
```

**Reproduction (before), against the shipped module.** The asymmetry is the finding:

```
refused/failed [OBSERVATION_WINDOW_TOO_SHORT]  soak: honest 1-second window
      window is 0h and soak requires 72h. The duration is the gate.
*** ADMITTED + PASS ***                        soak: NaN..NaN window
*** ADMITTED + PASS ***                        soak: 0..Infinity window
*** ADMITTED + PASS ***                        shadow_agreement: NaN window
*** ADMITTED + PASS ***                        invariants_enforced: NaN window
*** ADMITTED + PASS ***                        invariants_enforced: window ENTIRELY IN THE FUTURE
```

An honest one-second soak was refused; a malformed one was not. The check was absent **only for
the malformed record**.

**Why it matters most here.** The four gates it lands on — `invariants_enforced`,
`simulator_fidelity`, `soak`, `shadow_agreement` — are precisely the four this programme has
classified, pass after pass, as *"not closable by any commit in this repository"* because they
need a fleet to have operated. There is no collector for them; an operator files them by hand.
Each was dischargeable by `{ windowStartedAtMs: NaN, windowEndedAtMs: NaN, pass: true }`, and
`stage.authoriseEnable()` would then take a shard live.

**Fix.** `Number.isFinite` on both endpoints, refusing by name rather than comparing; and a
window may not close after the instant the record is read — the same argument as
`PRODUCED_IN_THE_FUTURE`, applied to the interval the record is *about* rather than to the
record. A fourteen-day shadow window ending next month has not been observed.

**Regression.** 18 tests — 14 against `evidence.admit()` (eight malformed endpoint shapes, the honest/malformed pair, every PRODUCTION gate, the future window, a window ending exactly now, and the 71 h / 73 h bounds either side of `soak`'s) and 4 against `stage.authoriseEnable()`. **Mutations M1, M2, M3: caught.** Live: B1–B7.

---

### P15-E2 — the automatic rollback's base configuration was the wrong version · **BLOCKING** · FIXED

**Root cause.** `rollbackPublisher.create()` documents its dependency as *"the payload of the
currently **pinned** configuration version"*; its header says *"every other binding, kill-switch
state, regime, spatial declaration and shard definition of **the version in force** is carried
forward unchanged"*; `docs/runbooks/rollback.md` §3 says the same. The composition root supplied
something else:

```js
// Backend/server.js, before this pass
const latest = await prisma.configVersion.findFirst({ orderBy: { version: "desc" }, … });
return (latest && latest.payload) || null;
```

That is the **highest-numbered published** version. It is the version in force only while nobody
has published one without pinning it — and publishing without pinning is a shipped, supported
operation: `config.controller.publishVersion` pins only `if (body.pin !== false)`, which is how a
candidate configuration is put up for review.

**A payload alone cannot say which version it is.** That is why the disagreement between the
module's stated contract and its only production producer survived 7 001 tests: no fixture ever
built a database in which the two differed.

**Reproduction (before), live, driving the shipped modules against real rows:**

```
v6 published AND PINNED  (sla.assignment_deadline = 300)
v7 published, NOT pinned (sla.assignment_deadline = 900) — under review

version IN FORCE (ConfigActiveVersion): v6
version server.js hands the rollback publisher: v7   <-- NOT the one in force

automatic rollback published v8 and pinned it: true

version NOW IN FORCE: v8
  cutover.engine_enabled(repro-region) : {"level":"region","value":false}
  sla.assignment_deadline              : 900

>>> the operator had 300 in force and had NOT pinned 900.
>>> an AUTOMATIC, unreviewed, one-directional "disable one shard" control put 900 into force fleet-wide.
```

**The second consequence, which is structural rather than incidental.** `service.publish()`
computes `safetyClassChanges` by diffing the candidate against the **latest** version's values,
and `checkSafetyApproval` refuses an `automated: true` publish that changes any Safety-class
parameter — finding **S1**, §22.3's absolute rule, *"No automated tuner may modify a Safety-class
parameter."* When the base set **is** the latest version, that diff cannot contain anything the
base did not already contain, **so S1 is structurally unable to fire.** The one automated writer
in the system was laundering arbitrary configuration changes past the check that exists to stop
exactly that, by choosing its own baseline.

**Fix, in three parts.**

1. **`rollbackPublisher.versionInForceReader({ prisma })`** — the production read, resolving
   `ConfigActiveVersion` → that version's payload. It lives in the module that states the
   requirement, not in the composition root, because the composition root held the only
   implementation and its disagreement with the contract was invisible. `server.js` now calls it.
2. **The reading carries its own identity** — `{ version, latestVersion, payload }`. A reading of
   any other shape is refused (`VERSION_IN_FORCE_UNREADABLE`) rather than read as a payload. Made
   mandatory rather than optional deliberately: an optional second field would be pass 2's own
   defect shape reintroduced one module along.
3. **`SUPERSEDES_AN_UNPINNED_VERSION`** — when the two versions differ, the rollback **refuses**.

**Why refusing is the answer, and what it costs.** Version numbering is linear: anything this
control publishes is `latest + 1` and therefore supersedes the unpinned candidate either way.
Carrying the in-force set forward reverts that candidate's content; carrying the candidate's set
forward puts a configuration nobody approved into force. Both are decisions *about the candidate*,
and §22.3 forbids the second absolutely. Neither is a decision an automatic, one-directional
control may take.

The cost is real and is stated in the refusal itself rather than discovered: **the shard stays
live until an operator acts.** The refusal names both versions and the two remedies — resolve the
candidate, or take the runbook's Action A by hand, which is an operator publish and is not subject
to this rule. `docs/runbooks/rollback.md` §3 now carries the same, including the measured
reproduction.

Three refusal codes, deliberately distinct, so an incident review can tell "nothing is published"
from "the dependency is miswired" from "a human left a candidate unpinned".

**Regression.** 14 tests, including five malformed reading shapes, the three refusal codes being distinct, and the pin's singleton key pinned against the Config Service's own constant — if those two ever diverge every rollback refuses with `NO_VERSION_IN_FORCE`, a fail-closed direction for a reason nobody could diagnose. **Mutations M5, M6, M7: caught.** Live: A1–A9, including the pre-fix producer reproduced against the same database (A3) and the rollback firing correctly once the candidate is resolved (A6, A7).

---

### P15-E3 — the same `NaN` shape in `guardrails.assess()` · **Latent (permissive)** · FIXED

`assess()` read `typeof startedAtMs !== "number"`. With a `NaN` endpoint **both** of the
function's own rules silently stopped applying: `startedAtMs < declaration.declaredAtMs` is false,
so the pre-declaration refusal — *"the refusal this module exists for"*, in its own header — never
fired; and `elapsedSeconds < observationWindowSeconds` is false, so a window of no length
satisfied the length requirement. A shard with no breached guardrail then reported `PROCEED`.

Unreachable in production today: `server.js` builds both endpoints from finite values. Fixed
anyway, and the distinction from pass 2's deferred **X-C2** is deliberate — that one *throws* on
a malformed declaration, which is loud; this one is **permissive**, and a fail-open on a path
nobody reaches today is a fail-open waiting for the caller that does. Its reachable sibling
(P15-E1) is the same mechanism one module away.

**Regression.** 8 tests. **Mutation M4: caught.** Live: C1–C3.

---

### P15-E4 — a caller-supplied minimum-observation bound of zero · **BLOCKING (permissive)** · FIXED

Found by **re-attacking pass 2's fixes** against the current tree (§4) rather than by reading:
one of thirty-nine attacks got through.

```
*** AUTHORISED ***  caller-supplied minObservationMs of 0 for soak
```

**Root cause.** `admit()` read `typeof required !== "number"` for the "did this bound resolve?"
check, which admits `0` and `NaN`. Both then sail through the comparison, so a gate **whose whole
content is a duration** was discharged by a one-millisecond window. `required` is
caller-supplied — `stage.authoriseEnable()` passes `request.minObservationMs` straight through —
so the attack is a field in the request object.

The legitimate producer could never emit either value: `resolveMinObservationMs` requires
`Number.isFinite(value) && value > 0` and **omits** the gate otherwise, precisely so that a
parameter which failed to resolve refuses the gate rather than unbounding it. **That guard existed
on the producing side and not on the consuming side** — the same asymmetry P15-C1 found for the
age bound, in the same file, one function down.

**Fix.** A bound for a gate the register bounds must be a finite, **positive** duration. Note the
deliberate difference from `maxAgeMs`, where zero *is* honoured: there zero is the strict
direction and a stated bound is a bound; here zero is the permissive direction, and the same value
cannot mean "as strict as possible" in one place and "no requirement" in another.

**Regression.** 12 tests — six bound shapes (zero, `NaN`, negative, `Infinity`, a numeric string, `null`), an absent bound, the defect at the authority, and one pinning **both sides** of the producer/consumer pair so neither can drift alone. **Mutations M10, M12: caught.** Live: B7.

---

### P15-E5 — the lifecycle model check claimed an exhaustion that was **impossible** · **BLOCKING** · FIXED

`formal/README.md` recorded that `lifecycleModel.js` still carried a defect corrected in its
sibling `commitmentModel.js` during the Phase 3 re-verification, and named the owner: *"It is
Phase 15's artefact and is left for Phase 15 rather than changed here."* This pass took it, and
what was found is worse than what was recorded.

**Part one — the reporting, as recorded.** `exhaustive` was set by the **state cap** alone. The
depth bound — which every configuration sets, and which every one of them hits — did not move it.
Measured on the shipped shapes before the correction:

| Configuration | nodes stopped **at** the bound | successors never explored | reported |
|---|---:|---:|---|
| capacity 1 (legs 2, depth 12) | 1 350 | 26 876 | `exhaustive: true` |
| capacity 2 (legs 3, depth 9) | 12 237 | 348 549 | `exhaustive: true` |
| capacity 3 (legs 4, depth 7) | 37 880 | **1 389 004** | `exhaustive: true` |

At capacity 3 the unexplored frontier was **twenty times** the explored state space.
`lifecycleModelCheck.test.js` asserted that flag — `expect(result.exhaustive).toEqual(true)` — and
its header stated depth was chosen *"to keep every run exhaustive within a test lane's budget"*.
Both were false and neither could fail.

**Part two — and this is the part nobody had recorded: the state space was infinite.**
`leg.version` advances on every applied transition and is part of the state key, and unlike
`fence` — which `MAX_FENCE` bounds, with a comment saying "bounding the space" — it was **not
bounded**. So no search of this model could ever close, at any depth, for any shape. Measured on
the smallest possible configuration:

```
one Leg, capacity 1:   depth   10   20    40    80   160    320    640
                      states  124  334   754  1594  3274   6634  13354      (linear, no convergence)
```

**`exhaustive: true` was therefore not merely unproven. It was unachievable**, and the depth bound
was silently doing all the work of terminating a search that had no other way to stop.

**Why this is blocking rather than cosmetic.** `model_check_capacity_1_2_3` is a **blocking §24
release gate**, discharged by `npm run test:engine -- ModelCheck`, and it is **GREEN** in the
release table. Its statement is that the commitment protocol *and the lifecycle* are model-checked
**exhaustively** at capacity 1, 2 and 3. A green gate rested on a claim of proof for a search that
could not perform one.

**Fix.**
1. `check()` now reports `exhaustive`, `depthTruncated`, `stateCapExceeded` and `maxDepthReached`
   separately, deriving `exhaustive` from both bounds — written to match `commitmentModel.js` line
   for line, because two checkers that report their own completeness differently are two checkers a
   reader has to compare by hand.
2. **`MAX_VERSION` bounds the version counter**, for the reason `MAX_FENCE` bounds the fence. The
   bound is sound: the version's only behavioural use is `expectedVersion: target.version` — always
   the *current* value, so the CAS always matches and the counter can never decide a transition. It
   distinguished histories, not behaviours. With it, one Leg at capacity 1 closes at depth 40 with
   166 states and no violation.
3. **It moves no shipped configuration.** At depths 12 / 9 / 7 no Leg reaches the bound: 5 750
   states at capacity 1 and 30 531 at capacity 2, identical before and after. The bound changes what
   is reachable *in principle*, not what is measured today.
4. The suite asserts the truth — truncation where that is the fact, `maxDepthReached`, and a
   deliberately-failing assertion if a search ever *does* close, so a stronger result must be
   re-declared rather than absorbed silently. Three shapes prove each completeness flag can
   independently be false, and one shape proves `exhaustive: true` is reachable at all.
5. `formal/README.md` is corrected at its source rather than left stale.

**What this does not fix, and §14 records it as a blocker:** the shipped configurations remain
depth-truncated within a test lane's budget, and `lifecycle.tla` has still never been run under
TLC. **No exhaustive lifecycle model check exists at any capacity, by either checker.** What
changed is that it is now *possible* rather than impossible, and what it needs is compute.

**Regression.** Two new tests and three rewritten in `lifecycleModelCheck.test.js`, plus the measurement itself: seven depths per shape at capacity 1 and the smallest shape probed to depth 640.

---

### P15-E6 — the cutover runbook's prerequisite 2 cannot be discharged by the check it names · **Medium (procedure)** · FIXED (documentation); the producer gap is REPORTED

`docs/runbooks/cutover.md` prerequisite 2 reads:

| 2 | Every **§24 release gate** GREEN | `GET /api/health/cutover` → `releaseGates.blocking` is empty | Eng |

That endpoint evaluates `req.app.locals.releaseEvidence`. **Nothing in this repository assigns
that field** — three readers, all in `health.controller.js`, and no producer anywhere under
`src/` or in `server.js`. Every one of the twenty-four gates is therefore reported
`NOT_EVALUATED`, always, whatever the real release state is, and `releaseGates.blocking` is never
empty. An operator following row 2 literally will never see it satisfied.

It **fails closed**, which is why this is a broken procedure rather than an unsafe one — and it is
the "real consumer, no production producer" shape the mandate's §4 asks for by name.

The same note also carried a claim the *previous* pass had already established was false. Pass 2
corrected it in `health.controller.js` — *"omitting the source digest makes BUILD/SUITE records
inadmissible, which is less permissive, not more"* — and left the identical sentence standing in
the runbook. A correction applied to the code and not to the operator procedure that quotes it is
how the two come to disagree at 3 a.m.

**Fixed in the runbook**, with both errors named and the working alternative given
(`npm run release:gates`, which collects the evidence, judges the whole table under a digest and an
age bound, and exits non-zero unless every blocking gate is GREEN).

**The producer gap itself is reported, not fixed, and the reason is specific.** The natural
producer is `Backend/docs/release-evidence.json`. Loading it into a request handler would make the
advisory view assert a table whose freshness it cannot judge — it holds neither the source digest
nor the age bound, and deliberately does not invent them. That is the *exact* failure P15-C1
removed from this file one pass ago. Wiring it correctly is a design decision about where the
release evidence lives at runtime, and inventing one here would be trading a procedure defect for
a permissive one.

---

## 4. Re-attacking the previous passes' fixes

Not trusted. Thirty-nine attacks from the mandate's §5 and §7 lists, run against the current tree.
**One got through** — it is P15-E4 above — and after the fix all thirty-nine hold.

```
baseline — the complete request authorises (or every refusal below is vacuous)   authorised ✓

P15-C1 — the evidence binding context
  refused [EVIDENCE_CONTEXT_INCOMPLETE]  requestedAtMs omitted · evidenceMaxAgeMs omitted ·
                                         sourceDigest omitted · all three omitted · NaN maxAge ·
                                         Infinity maxAge · negative maxAge · string maxAge ·
                                         NaN requestedAtMs · null sourceDigest · empty sourceDigest
  refused [RELEASE_GATE_NOT_GREEN]       wrong sourceDigest · 3-year-old rehearsal ·
                                         rehearsal stamped in the future ·
                                         pass:true over a failing exit code ·
                                         hand-written {pass:true} for all 24 gates
  → AUTHORISED                           caller-supplied minObservationMs of 0    ← P15-E4, now refused

P15-C2 — the guardrail declaration                                        10 / 10 refused
  declaration omitted · hand-built {shardId, declaredAtMs} · empty guardrail set · no declaredBy ·
  no observation window · guardrail with no minSamples · guardrail declared twice ·
  declaration for another shard · declaration stamped after the request · truthy non-declaration

ADR-34 / ship state / approval                                             8 / 8 refused
  unknown purpose · REHEARSAL with no environment · REHEARSAL in production ·
  REHEARSAL with production undefined · a Tier 2 mechanism live · self-approved · automated ·
  draining shard

P15-C2 round trip   authoriseEnable → guardrails.declare, normalised and ordered      holds
P15-C4              eventType in the vocabulary, recordedAt valid                     holds
P15-C4              an action with no instant is refused, not stamped with Date.now() holds
```

**P15-C4's round trip** is additionally re-verified end to end against a real database by
`phase15CurrentTree.js` (32/32) and `phase15EvidenceBinding.js` (17/17), both unchanged and both
passing on this tree: producer → `EVENT_TYPE` → CHECK constraint → persistence → readback →
staged controller → automatic rollback.

---

## 5. Production-composition audit

The mandate's primary audit: *module → producer → consumer → composition root → configuration →
real database → observable side effect*, with **no dependency whose only producer is a test
fixture**.

**Registry: 18 workers — 8 SCHEDULED, 4 LEADER_ONLY, 6 DEFERRED.**

| Worker | Started by | Outcome |
|---|---|---|
| `shard_supervisor`, `invariant`, `cutover`, `tier_b`, `rejection_aggregation`, `certificate_rotation`, `calibration`, `counterfactual` | `server.js` → `startScheduledWorkers()`, inside the `ENGINE_ENABLED` gate | STARTED |
| `outbox`, `reconciler`, `timer` | `server.js:607` → `leaderWorkers.create()` → `apply(tick)` on the supervisor's `mayRunRound` | STARTED on promotion, stopped on demotion |
| `coordinator` | same hook | **REFUSED** — `EXTERNAL_DEPENDENCY_UNAVAILABLE`, B1 |
| `shadow` + 5 others | — | `DEFERRED` with a named blocker (`assertRegistry` refuses an unexplained deferral) |

**Every field Phase-15 code reads, traced to its production producer.** The one that failed is
P15-E2: `versionInForce` had a production producer and it produced the wrong row. The one that has
no producer at all is P15-E6: `app.locals.releaseEvidence`.

**Leader gating, demotion, restart, duplicate start** — re-verified: `leaderLifecycle.stop()` runs
*before* the leadership release at shutdown; `startAll()` is idempotent by call count, not by map
key (pass 1's D-11); a deadline that passed while no worker ran is fired by a freshly started one
(live).

---

## 6. Phase-5 integration — X2a, X2b, X3

Phase 5 is CLOSED and was not reopened. Its consumption by Phase 15 was re-verified.

**X2a — `offers.applyAccept` → `ACCEPTED` → ACCEPTED timer · HOLDS.** `legEntryDeadline
.superviseEntry` is armed in the accepting transaction (`offer.handler.js:155`); expiry fires
`probeThenReassign`; recovery is `ACCEPTED → REASSIGNING`, fence↑, RECALL outbox row, commitment
released. Two production consumers, both verified live.

**X2b — outbox withdrawal → `QUEUED` → QUEUED timer · HOLDS.** `outbox.worker.js:332` arms the
same function in the same transaction as `offers.withdrawExpiredOffer`;
`assignmentDeadlineSeconds` has a real production producer (`leaderWorkers.js`,
`finite(values, "sla.assignment_deadline")`). Both paths to `QUEUED` share one implementation of
the obligation, with deliberately identical payloads.

**X3 — no `TASK` timer producer · NOT FIXED, and must not be.** Re-derived live rather than
carried: `phase15CurrentTree.js` check G1 reports **0** TASK-entity timers in the store after the
whole harness, and a structural scan confirms no `timers.register` call under `src/` names the
TASK entity while LEG producers do.

§4.3 has §4.4, a complete transition table. **§4.2 has no transition table at all** — a state
table with an exit-deadline column and nothing saying what a Task moves to on any event. Adopting
`RECEIVED` would arm `intake.validation_budget` on a state with no defined exit, which is invariant
I4's violation created deliberately rather than found. **Classified SPECIFICATION.** Wiring a
producer would require inventing the §4.2 semantics the frozen specification does not contain.

`phase5ExpirySemantics.js` **102/102** and `phase5LiveDatabase.js` **106/106** against a fresh
database on this tree. **No Phase-5-owned defect was discovered by this pass.**

---

## 7. Release-evidence and cutover-authority audit

The mandate's §7 list, each attacked against the current tree.

| Attack | Result |
|---|---|
| hand-written boolean evidence | refused — a bare `{pass:true}` carries no `gateId` (`GATE_ID_MISMATCH`) |
| gates actually executed | `collectEvidence.run()` spawns each command and captures its real exit code |
| `pass` contradicting the exit code | refused — `pass` is **derived**, never read, for BUILD/SUITE |
| stale evidence | refused (`STALE`); the age bound is mandatory (P15-C1) |
| changed source after collection | `SOURCE_DIGEST_MISMATCH`; the collector takes the digest **twice** and voids a collection whose tree moved |
| missing digest | `SOURCE_DIGEST_REQUIRED`; and `EVIDENCE_CONTEXT_INCOMPLETE` at the authority |
| malformed digest / another tree | `SOURCE_DIGEST_MISMATCH` |
| missing timestamps | `SELF_ASSERTED` / `EVALUATION_INSTANT_REQUIRED` |
| future timestamps | `PRODUCED_IN_THE_FUTURE` |
| **future observation window** | **WAS NOT — P15-E1.** Now refused |
| **NaN / Infinity observation window** | **WAS NOT — P15-E1.** Now refused |
| **caller-supplied zero duration bound** | **WAS NOT — P15-E4.** Now refused |
| NaN CLI arguments | `verdict.js --max-age-hours <typo>` exits 2 |
| expired evidence | refused |
| partial gate collection | `--only build` leaves SUITE gates `NOT_EVALUATED`, which blocks |
| missing gate | `NOT_EVALUATED`, which blocks |
| `NOT_EVALUATED` → PASS | impossible: `evaluate()` returns GREEN only for `admissible && pass` |
| command failure | a killed process records exit 1, never 0; the collector exits non-zero; the verdict judges independently |
| evidence from another environment | PRODUCTION/ORGANISATIONAL rows are refused a run record (`BUILD_CANNOT_CLOSE`) |
| caller-supplied status fields | `pass` is derived for BUILD/SUITE; **the duration bound is now adjudicated too (P15-E4)** |
| a declaration the reader refuses | refused (P15-C2), validated through the reader's own function |
| the audit event the authority writes | writable, read back, and acted on (P15-C4), verified live |
| **the base configuration a rollback carries forward** | **WAS NOT — P15-E2.** Now the version in force, or a named refusal |

**One divergence reported, not fixed.** `gates.evaluate()` reports `unknownEvidence` and folds it
into `ok`; `gates.blockers()` — which `stage.authoriseEnable()` calls — does not. Evidence filed
against a gate id that does not exist therefore blocks `verdict.js` and not the authority. It is
**not permissive**: a mis-filed record leaves its real gate `NOT_EVALUATED`, which blocks. It is a
lost diagnostic, recorded here rather than repaired, because changing what the authority refuses is
a change to the authority and this one buys no safety.

---

## 8. Calibration — re-run, nothing manufactured

```
$ node tools/gates/checkCalibration.js ; echo $?
FAIL — 39 blocking finding(s). This is execution-plan pre-work item B8.
242 entr(ies): 52 DERIVED, 152 PROVISIONAL, 38 UNCALIBRATED. 54 are Safety-class.
1
```

Identical to arrival. **No value was manufactured, promoted or defaulted.** Each of the 39 names
what it awaits, and none is an engineering task: *per-class rated-mass certification*; *the
operated CA's revocation-publication latency*; *measured p99 round-trip to the operated consensus
store*; *a safety decision per degraded mode*; *the first one-sided simulator fidelity study
against production*.

**Can a Safety-class parameter be promoted by editing one word?** No, and this was attacked rather
than assumed. `checkCalibration.hasSubstantiation()` requires a Safety-class entry claiming
`DERIVED` to carry a **`derivation`** — a cross-reference is explicitly not enough for the Safety
class — so a one-word edit yields `SAFETY_DERIVATION_NOT_STATED`, which blocks. §22.4's own words
are the reason, quoted in the gate: *"a status field can be edited without the source existing."*

**Can the gate be bypassed?** `calibration_safety_derived` is ORGANISATIONAL with `runnable: true`,
so an attestation must be accompanied by a corroborating run of `npm run gate:calibration` that
**exited 0**, bound to this tree's digest. The command exits 1. P15-C3 closed the one way that
pairing could have been silently skipped.

**A consequence sharper than the gate.** The publish validator refuses the register's own defaults
(V9) — reproduced live during this pass while building the P15-E2 fixture, which could not publish
a first configuration version until it bound `route.degraded_reserve_factor` explicitly. A
deployment cannot publish from defaults at all.

---

## 9. Invariants — WIRED, not OBSERVED

`modeRegister.INVARIANTS` declares **22** (I1 … I22). `invariantWorker.start(…)` is composed and
started at `server.js:142` with `prisma`, `kv`, `emit`, and its full check context.

| | |
|---|---|
| WIRED | **yes** — it runs on an interval against the real store and writes `InvariantStatus` rows and `INVARIANT_STATUS_CHANGED` events |
| IMPLEMENTED | **yes** — 22 checks |
| EXECUTED | **yes** — in a running process |
| OBSERVED | **no** |
| RELEASE-PROVEN | **no** |

The `invariants_enforced` gate is PRODUCTION evidence requiring a zero-violation SLI over an
observation window. No such window exists, because no production fleet exists. **The missing
requirement is production observation, not composition**, and it is not recorded as a wiring
defect. The gate is `NOT_EVALUATED` and blocks, which is the honest state.

*(P15-E1 is the reason this row deserves a second look: until this pass, `invariants_enforced` —
along with the other three PRODUCTION gates — was dischargeable by a record whose window was
`NaN`. The gate was honest; the adjudicator was not.)*

---

## 10. Shadow / counterfactual

```
real decision  → coordinator.worker   ✗ NOT COMPOSED (B1)
               → shadow.worker        ✗ NOT COMPOSED (same solve path, same blocker)
               → shadow result        no producer
               → persistence          no producer
               → comparison           no producer
               → agreement metric     no producer
               → release evidence     shadow_agreement — NOT_EVALUATED
```

**Can the 14-day window begin? No.** It cannot begin until the shadow worker composes, which
cannot happen until B1 selects a routing engine. The system is not merely short of the window — it
cannot start the clock. **No observation data was fabricated, and no 14-day period was
manufactured.**

`cutover.shadow_agreement_window` is a registered parameter and `evidence.resolveMinObservationMs`
resolves the bound from it, so the gate is *refused for want of a window* rather than
*unbounded* — and after P15-E4 that is true of a **zero** window as well as an absent one.

---

## 11. Simulator fidelity

```
$ node tools/simFidelity/validate.js ; echo $?
simulator fidelity gate (§24.4) — one-sided, bound 5.0 % optimistic
  NOT_MEASURED  TRAVEL_TIME  SAFETY        NOT_MEASURED  SERVICE_TIME
  NOT_MEASURED  ENERGY_CONSUMPTION SAFETY  NOT_MEASURED  CHARGE_DURATION  SAFETY
  NOT_MEASURED  FAILURE_RATE SAFETY        NOT_MEASURED  INTERVENTION_RATE SAFETY
  NOT_MEASURED  DISCONNECT_RATE SAFETY
  No study was supplied (--input <file.json>).
1
```

**7 models NOT_MEASURED, 6 of them safety-relevant.** Unchanged, and nothing was faked.

Classified as the mandate asks:

| Requirement | Answer |
|---|---|
| repository-owned and executable now? | **No.** The tool is executable; the *study* is its input and does not exist. |
| requires real hardware / fleet data? | **Yes.** §24.4 validates model distributions against **realised production data**, one-sided. |
| requires external approval? | Partly — `sim.max_optimistic_bias` is one of B8's 39 Safety-class values. |

A study cannot be performed locally without inventing production distributions, so it was not
performed and the gate stays `NOT_EVALUATED`. **EXTERNAL / OBSERVATION.**

---

## 12. B1 — the routing engine

```
$ node tools/routing/b1Readiness.js
step 1  BLOCKED — authoritative operating region unavailable; fleet mobility/speed model unavailable  [D1, D3]
step 2  PASS    — 3 adapters implemented (osrm, valhalla, graphhopper); 1 correctly NOT_IMPLEMENTED
step 3  BLOCKED — nothing deployed to measure                                                          [D1, D3]
step 4  BLOCKED — extract vintage/refresh decision unavailable                                         [D1, D8]
step 5  BLOCKED — ENGINE SELECTION: no recorded evidence exists                                        [D1, D3, D8]
OVERALL: BLOCKED
```

Traced: `coordinator.runRound → round.execute → expandCandidates → evaluateExact → plan build →
planBuilder.hopsForSequence → routing/cellPairCache.hopsFor → deps.route`. `cellPairCache.read()`
is explicit: *"if `typeof source.route !== 'function'` return `{ ok: false, reason: 'no router is
available and the entry is not cached' }"*.

**No engine was invented.** `DEGRADED_ROUTING` (§18.5) is not an escape: it is the mode entered
when a Routing Service that *exists* is failing, and its `uniformDegradedEstimation` still needs
D3's speed model.

**Is any Phase-15-owned defect hidden behind B1?** This pass looked, and the answer is no for the
coordinator specifically — but it is worth recording *how* that question was answered wrongly
before. Pass 2 concluded "in-repository: none remaining" partly because B1 dominates the picture,
and six in-repository defects were sitting in modules B1 does not touch: the release authority, the
rollback publisher's composition, the model checker, and two runbooks. **B1 blocks the cutover; it
does not block auditing everything the cutover would run through.**

---

## 13. Performance — §20.1

**Not re-profiled by this pass, and no claim is made that it was.** The distinctions the mandate
asks for, kept apart:

| | State |
|---|---|
| solver benchmark | Phase 10's, not re-run here |
| build+solve benchmark | not re-run here |
| **whole-round benchmark (§20.1)** | **NOT genuinely measured.** No whole-round p99 against §20.1's table exists. |
| p99 target | stated in §20.1, which calls the table *"requirements for the release gate, not aspirations"* |
| representative hardware | a workstation; not a representative deployment |
| production fleet | **none exists** |

`scale_targets`, `locality` and `overload_admission_control` are GREEN as **SUITE** evidence — they
are the `test:scale` lane's own measurements, executed by the collector on this machine. That is
what those three gates are; it is **not** a whole-round measurement on representative hardware, and
a solver-only or lane-only measurement is not promoted into one here.

This pass's changes cannot have moved any of it: nothing was touched on the decision or telemetry
paths. The three modules changed under `src/` are the release authority, the guardrail assessor and
the rollback publisher, none of which executes during a round.

---

## 14. Formal verification — the exact state, and a blocker this pass discovered

**No TLC run was performed by this pass.** TLC is not in this closure's command set, and nothing
below is manufactured.

| Module | Checker | State |
|---|---|---|
| `commitment.tla` | TLC | `commitment_c1.cfg` **complete state graph** (17 991 520 states, 2 375 660 distinct, diameter 21, no error). A **reduced** capacity-2 configuration also closed. `commitment_c2.cfg` as checked in and capacity 3: **not completed** — >1 h, 11 GB queue still growing. |
| `lifecycle.tla` | TLC | **never run.** |
| commitment | executable (`commitmentModel.js`) | capacity 1 closes at depth 21; capacities 2 and 3 assert **truncation** explicitly |
| lifecycle | executable (`lifecycleModel.js`) | **truncated at all three shipped capacities** — see below |

### The blocker: `model_check_capacity_1_2_3` is GREEN and NOT PROVEN

The gate's statement is that the commitment protocol **and the lifecycle** are model-checked
**exhaustively** at capacity 1, 2 and 3. Its evidence is the exit code of
`npm run test:engine -- ModelCheck`, which is 0.

That command **cannot establish the statement**, and after P15-E5 the suite says so in its own
assertions rather than in a flag that could not move:

- the lifecycle checker is depth-truncated at capacity 1, 2 **and** 3 within a test lane's budget;
- `lifecycle.tla` has never been run under TLC;
- the commitment checker closes only at capacity 1, and `formal/README.md` already recorded that
  capacity 2 (as checked in) and capacity 3 remain open under TLC.

So **no exhaustive check of the lifecycle exists at any capacity, by either checker**, and the
commitment half is exhaustive only at capacity 1.

**This gate was not flipped to RED by this pass, and that is a decision, not an oversight.** What is
missing is **compute** — `formal/README.md`'s own words, *"Both need more compute than a workstation
session, not a different specification"* — which is an evidence dependency of exactly the class the
mandate says to classify rather than code around. Making the suite exit 1 would manufacture a
permanent red for a fact about available hardware, and the mandate is explicit: *do not keep
modifying code simply because external evidence is missing.*

**It is therefore recorded as a blocker (§22, B-M) and in §21's NOT PROVEN list, and the gate's row
is flagged for the release owner rather than silently redefined.** Before this pass the gap was
invisible: the flag could not be false, the suite asserted it, and the gate was green. It is now
visible in the repository, in the suite's assertions, in `formal/README.md`, and here.

---

## 15. Live PostgreSQL verification — 288 checks

Disposable **PostgreSQL 18.3** cluster on port **55439**, built from the installed binaries into
the scratchpad. **Never Neon, never the user's 5432 cluster** — every harness refuses both by name.

```
tables before: 0
APPLIED 27 migrations from empty   FAILED: (none)
tables after: 74
AuditEvent_event_type_known → CHECK ("eventType" = ANY (ARRAY[…, 'CUTOVER_SHARD_ENABLED', 'CUTOVER_SHARD_ROLLED_BACK']))
```

| Harness | Checks |
|---|---|
| `tools/verify/phase15VersionInForce.js` — **NEW** | **19 / 19** |
| `tools/verify/phase15EvidenceBinding.js` (pass 2) | 17 / 17 |
| `tools/verify/phase15CurrentTree.js` (pass 1) | 32 / 32 |
| `tools/verify/phase15LiveDatabase.js` | 12 / 12 |
| `tools/verify/phase5ExpirySemantics.js` | 102 / 102 |
| `tools/verify/phase5LiveDatabase.js` | 106 / 106 |
| **total** | **288 / 288** |

### The new harness, group by group

| Group | Checks | What it establishes |
|---|---|---|
| A — P15-E2 | 9 | the divergent fixture is built for real (v_n pinned, v_n+1 unpinned); the shipped reader returns the **pinned** payload; **the pre-fix producer returns the candidate, reproduced against the same database**; the rollback refuses rather than superseding; nothing was published or promoted by the refused pass; once an operator resolves the candidate the rollback fires and carries the in-force set forward; a bare payload and an unpinned nothing each refuse by their own code |
| B — P15-E1 / P15-E4 | 7 | the honest fixture authorises, so every refusal is about the window; NaN, Infinity, string endpoints and a not-yet-closed window each refuse **all four** PRODUCTION gates by name; the honest short window still refuses for *its own* reason |
| C — P15-E3 | 3 | a NaN window is refused; the pre-declaration ordering refusal still fires on a real window; a healthy window still PROCEEDs |

### Constraints and triggers made to fire

Judged on SQLSTATE and on the row being absent afterwards, never on message text — Prisma embeds
the calling file's own source in its errors, and a text match reports PASS for a probe that never
reached the database.

Carried and re-run: `ShardMembership_one_current_per_agent` (23505),
`ShardMembership_migration_advances_epoch` (23514), `ShardMembership_move_changes_shard` (23514),
`Shard_regionId_key` (23505), `Outbox_idempotencyKey_key` (23505), `Outbox_fence_scope_columns`
(23514), `AuditEvent_event_type_known` (raw insert of an undeclared type still refused).

**Fired by this pass, unplanned:** `ConfigVersion is immutable once published (§22.1 rule 3)` —
a `P0001` from the row-level trigger, raised when this pass's first reproduction script tried to
`DELETE` a published configuration version to build a clean fixture. The fixture was rewritten to
build forward instead, which is the discipline §22.1 rule 3 exists to impose. A Phase-1 protection
doing its job against a Phase-15 tool.

Also exercised through the shipped modules rather than by probe: `checkSafetyApproval`'s **S2**
(two distinct approver identities) and **S3** (every approval records an identity and a time), and
the publish validator's **V9** (combined degraded energy conservatism against
`energy.max_combined_conservatism`) — all three refused this pass's fixtures until they were made
admissible, which is §22.1 rule 5 rejecting invalid configuration at publish rather than at
decision time.

### What live execution found that a green suite did not

**P15-E2 could not have been found any other way.** Its two candidate rows differ only in *which
row a query selects*, and telling one row from another requires both to exist in a database. 7 001
tests were green over a composition root that handed the one automated writer in the system the
wrong configuration version — and would have pinned it.

That is the **seventh consecutive phase** in which live execution found what the store model could
not.

---

## 16. Mutation results — 10 / 12 caught, 2 survivors proven benign

Each protection was removed from the source, the tests that guard it were required to **fail**, the
file was restored byte-for-byte, and they were required to pass again.

| | Protection removed | Verdict |
|---|---|---|
| M1 | the PRODUCTION window endpoints must be finite (P15-E1) | **CAUGHT** |
| M2 | a PRODUCTION window may not close in the future (P15-E1) | **CAUGHT** |
| M3 | the minimum-duration bound itself | **CAUGHT** |
| M4 | `guardrails.assess()` requires finite endpoints (P15-E3) | **CAUGHT** |
| M5 | the `versionInForce` reading must say which version it is (P15-E2) | **CAUGHT** |
| M6 | a rollback may not supersede an unpinned version (P15-E2) | **CAUGHT** |
| M7 | `versionInForceReader` resolves the **pin**, not the highest version (P15-E2) | **CAUGHT** |
| M8 | the age bound is mandatory — pass 2's P15-C1, re-checked after this pass edited the file | **CAUGHT** |
| M9 | the source-digest binding is mandatory | **survived — benign, proven** |
| M10 | a minimum-observation bound must be a positive duration (P15-E4) | **CAUGHT** |
| M11 | the duration comparison rejects a non-finite bound (P15-E4) | **survived — benign, proven** |
| M12 | `resolveMinObservationMs` omits a non-positive register value (P15-E4) | **CAUGHT** |

**No surviving mutation without a documented explanation, and both explanations are measured
rather than argued.**

**M9.** Removing `if (!nonEmpty(at.sourceDigest))` does not open a hole; it changes a refusal
*code*. With the guard removed the record is still refused, by the comparison two lines down:

```
[M9 APPLIED] digest omitted           refused [SOURCE_DIGEST_MISMATCH]
[M9 APPLIED] no build digest either   refused [SOURCE_DIGEST_MISMATCH]
```

The guard is a diagnostic refinement over a comparison that already fails closed — and
`stage.authoriseEnable()` refuses a missing digest up front with `EVIDENCE_CONTEXT_INCOMPLETE`, so
it is covered three ways.

**M11.** Reverting the comparison's `Number.isFinite` to `typeof` is behaviour-preserving because
**M10's guard already refuses a non-finite bound** for every gate the register bounds:

```
[M11 APPLIED] soak, NaN bound          refused [OBSERVATION_WINDOW_REQUIRED]
[M11 APPLIED] soak, 0 bound            refused [OBSERVATION_WINDOW_REQUIRED]
[M11 APPLIED] shadow, NaN bound        refused [OBSERVATION_WINDOW_REQUIRED]
[M11 APPLIED] invariants, NaN bound    admitted   ← identical unmutated: that gate has no bound
```

The only difference it can make is to a caller's *optional extra strictness* on a gate the register
does not bound — a direction that cannot weaken any declared requirement.

Every mutation was applied to a real file and restored from an in-memory copy; the tree was verified
clean afterwards and the baseline re-run green.

---

## 17. Test integrity

**No test was deleted, skipped, weakened, retargeted or threshold-relaxed.** Two suites were
changed and both are named individually and are strictly stronger.

### `lifecycleModelCheck.test.js` — CORRECTED AT ITS SOURCE

**What it did.** `expect({ capacity, exhaustive: result.exhaustive }).toEqual({ capacity, exhaustive: true })`
at all three capacities, under a header stating depth was chosen "to keep every run exhaustive".

**Why that was wrong.** The flag could not be false: it was set by the state cap alone, and the
depth bound was what actually stopped every run. The assertion was structurally incapable of
failing — the D-11 shape, on a blocking §24 gate.

**How the replacement is stronger.** It asserts what the run establishes — `depthTruncated: true`,
`stateCapExceeded: false`, `maxDepthReached === depth`, no violation, the state floors — and adds
three tests that could not exist before: one proving each completeness flag can independently be
false and that `exhaustive: true` is reachable at all (it is, since `MAX_VERSION`); one pinning the
version bound's soundness and that the shipped numbers are unchanged by it; and one pinning, in the
repository rather than only in a closure document, that **no exhaustive lifecycle check exists at
any shipped capacity**. If a future change ever closes one of these searches, the suite **fails** —
a stronger result must be re-declared deliberately rather than absorbed silently.

### `phase15CurrentTreeRemediation.test.js` — fixture updated to a stricter contract

Pass 1's `publisher()` helper returned a bare payload for `versionInForce`. Under P15-E2's contract
that is now refused, so the fixture states which version it describes. **A field was added; no
assertion was relaxed.** Its "with no version in force it refuses" test is unchanged and still
passes.

### `tools/verify/phase15CurrentTree.js` — fixture strengthened

Group B's publisher fixture copied `findFirst({ orderBy: { version: "desc" } })` **from the
composition root** — so it reproduced the defect rather than catching it, which is exactly why a
32/32 harness could be green over P15-E2. It now calls the shipped
`rollbackPublisher.versionInForceReader`, which makes the check about production rather than about a
fixture. Group B6's fixture was made well-formed as a *reading* so that its refusal is about the
action being an ENABLE, not about the reading — a fixture refused for the wrong reason proves
nothing about the rule under test.

### The new suite

`tests/engine/phase15ObservationWindowRemediation.test.js` — **52 tests**: 18 for P15-E1, 14 for P15-E2, 12 for P15-E4, 8 for P15-E3.

---

## 18. Cross-phase integrity

**Phase 0–5 core modules and the schema: untouched.**

```
$ git status --porcelain -- Backend/src/db Backend/src/engine/{commitment,dispatch,domain,shard} \
                            Backend/prisma/schema.prisma
(empty)
```

**Every file this pass changed, with its owner:**

| File | Owner | Change |
|---|---|---|
| `src/engine/cutover/evidence.js` | Phase 15 | P15-E1, P15-E4 |
| `src/engine/cutover/guardrails.js` | Phase 15 | P15-E3 |
| `src/engine/cutover/rollbackPublisher.js` | Phase 15 | P15-E2 — the production reader, two refusals |
| `server.js` | Phase 15 (composition root) | P15-E2 — reads the version in force |
| `tests/engine/helpers/lifecycleModel.js` | **Phase 15** (`formal/README.md` names the owner) | P15-E5 — completeness reporting + `MAX_VERSION` |
| `tests/engine/lifecycleModelCheck.test.js` | Phase 15 | P15-E5 — corrected at its source |
| `tests/engine/phase15CurrentTreeRemediation.test.js` | Phase 15 | fixture updated to the stricter contract |
| `tools/verify/phase15CurrentTree.js` | Phase 15 | fixture calls the shipped reader |
| `tests/engine/phase15ObservationWindowRemediation.test.js` | Phase 15 | **NEW** — 40 tests |
| `tools/verify/phase15VersionInForce.js` | Phase 15 | **NEW** — 19 live checks |
| `docs/runbooks/rollback.md` | Phase 15 | P15-E2 — the new refusal and its remedy |
| `docs/runbooks/cutover.md` | Phase 15 | P15-E6 — two false claims corrected |
| `formal/README.md` | Phase 15 (its own note names Phase 15) | P15-E5 recorded at its source |

**No file owned by Phases 0–14 was modified by this pass.** No migration was added or edited. No
gate was weakened, no threshold moved, no tolerance widened, no `NOT_EVALUATED` converted to `PASS`.

**Carried from pass 2, unchanged and not touched here:** `src/engine/cutover/{stage,gates,store}.js`,
`src/controllers/health.controller.js`, `tools/release/verdict.js`,
`src/engine/observability/auditStream.js` (Phase 12, +30/−0, justified in pass 2 §16), the
`20260823120000_audit_stream_admits_the_cutover_events` migration, `tests/engine/observabilitySchema.test.js`,
`tests/gates/checkCalibration.test.js`, `tools/verify/phase15EvidenceBinding.js`,
`tests/engine/phase15EvidenceBindingRemediation.test.js`.

`Backend/prisma/seed.js` and `Backend/docs/release-evidence.json` show as modified. Both were
already modified when this pass began and neither was touched by it.

**Phase 5's contracts** — `timers.register`, `timers.resolve`, `transitions.apply`,
`expiryActions.handlers` — unchanged, and its two harnesses pass 102/102 and 106/106 against a fresh
database. **Phase 12's audit contract, Phase 13's leadership/fencing and Phase 14's
security/privacy** were not modified; their suites pass.

**Phase 16 contamination: CLEAN.** No Tier 2 mechanism enabled; `tierTwoAtShipState` refuses a
cutover with any Tier 2 mechanism live, including under `PURPOSE.REHEARSAL`.

---

## 19. Final measured results

*(filled in from the final run — see §19.1–19.4)*

---

## 20. Remaining blockers

| ID | Description | Owner | Class | Why no commit here closes it | What is required |
|---|---|---|---|---|---|
| **B1** | No routing engine selected | Ops + Commercial (D1), Product + Fleet Eng (D3), Ops (D8) | **EXTERNAL** | Selecting an engine is an Operations, Product and Commercial decision. `coordinator` and `shadow` cannot compose; `gate:composition` and `engine_decision_path_wired` stay red. | An authoritative operating region as GeoJSON; a real fleet speed model over roadClass/gradient/surface/payload/congestion/weather; an extract vintage, cadence and re-contraction budget. Then B1 steps 1, 3, 4 and the Step 5 ADR. |
| **B8** | 39 Safety-class parameters not `DERIVED` | §22.4's calibration owner | **EXTERNAL** | Requires measurement, certification and named-owner attestation. §22.4 itself: values that *"require data the fleet does not yet produce and cannot produce before it operates."* | Per-class rated-mass certification; the operated CA's revocation latency; measured p99 to the consensus store; a safety decision per degraded mode; and 35 more, each named in the gate output. |
| **B-P** | 4 PRODUCTION gates `NOT_EVALUATED` — `invariants_enforced`, `simulator_fidelity`, `soak`, `shadow_agreement` | — | **OBSERVATION** | Require a fleet that has operated. The 14-day shadow window cannot *begin* until B1. | Production traffic; a 72 h soak; a one-sided fidelity study against realised distributions; a zero-violation invariant SLI over a window. |
| **B-O** | 3 ORGANISATIONAL gates `NOT_EVALUATED` — `calibration_safety_derived`, `safety_case_assembled`, `rollback_rehearsed` | named humans | **EVIDENCE** | Require named people to have acted, with a corroborating run that exited 0 where the gate declares one. `gate:calibration` exits 1. | Two distinct signatures per gate; a real rehearsal record carrying all six §5 steps and `automaticRollbackFired`. |
| **B-M** | **`model_check_capacity_1_2_3` is GREEN and NOT PROVEN** — no exhaustive lifecycle check exists at any capacity, by either checker; commitment is exhaustive only at capacity 1 | Release owner + compute | **EVIDENCE (compute)** · **found by this pass** | A completed TLC run on `lifecycle.tla`, and on `commitment.tla` at capacities 2 and 3, needs more compute than a workstation session. Not a different specification and not more code. | Either the compute to close those runs, or an explicit decision by the release owner about what this gate's statement means given a bounded executable checker. |
| **X3** | No `TASK` timer producer; §4.2's half of §4.5 unreachable | — | **SPECIFICATION** | §4.2 contains no Task transition table. Inventing one is not remediation. | A §4.2 transition table in the frozen specification, or an explicit decision to scope the gate to §4.3. |
| **X1** | §17.4 escalation ladder unimplemented | REMEDIAL PHASE T1-04 | **FUTURE PHASE** | Not Phase 15's deliverable. | T1-04. |

### Blocker taxonomy

| Class | Items |
|---|---|
| **In-repository, Phase-15-owned** | **none remaining** — P15-E1 … E6 were six more than the previous pass believed existed, and all six are fixed |
| **In-repository, reported not fixed** | `app.locals.releaseEvidence` has no producer (P15-E6, fails closed, §3); `blockers()` ignores `unknownEvidence` (§7, not permissive); pass 2's **X-C1** (Phase 12) and **X-C2** (unreachable) |
| **External** | B1, B8 |
| **Observation** | B-P — 4 PRODUCTION gates |
| **Evidence** | B-O — 3 ORGANISATIONAL gates; **B-M — model checking compute** |
| **Specification** | X3 |
| **Future-phase** | X1 (T1-04); Tier 2 enablement (Phase 16) |

---

## 21. Explicitly NOT PROVEN

Stated plainly, because a closure that omits this section is not one.

1. **No shard has ever been taken live by this machinery.** What is proven is that the authority
   refuses every incomplete, stale, malformed or unbounded request put to it, and that a complete
   one produces an audit event a real database accepts and a real controller acts on.
2. **The automatic rollback has never fired in production.** It is proven end to end against a live
   database — a real breach, a real `declarationFor` read, a real published binding — and that is a
   harness, not a fleet. **New this pass:** it is also proven that it now refuses to fire in a state
   where firing would put an unapproved configuration into force, and that refusal leaves the shard
   live until a human acts.
3. **The lifecycle has never been model-checked exhaustively, at any capacity, by any checker** —
   and until this pass it reported that it had. The commitment protocol is exhaustive at capacity 1
   only. **`model_check_capacity_1_2_3` is GREEN and its statement is not established** (§14, B-M).
4. **§20.1 has not been measured as a whole-round p99 on representative hardware.** The three scale
   gates are the `test:scale` lane's own measurements on a workstation; that is what those gates
   are, and it is not the same claim.
5. **No TLC run was performed by this pass.** `lifecycle.tla` has never been run under TLC at all.
6. **The seven `TASK` expiry handlers have never fired and cannot** (X3). TASK-entity timers in the
   live store after a full harness run: **0**.
7. **`ESCALATION_LADDER` has never relaxed anything** (X1, T1-04).
8. **No production observation exists for any of the 4 PRODUCTION gates.** The 14-day shadow window
   has not begun and cannot begin until B1.
9. **The 39 Safety-class calibration findings are unchanged and no value was manufactured,
   promoted or defaulted.**
10. **Nothing here proves the engine assigns work.** `coordinator.worker` remains uncomposable. A
    shard with `ENGINE_ENABLED=true` today would supervise deadlines correctly on Legs that nothing
    creates.
11. **`GET /api/health/cutover` reports an empty release table and always will** until
    `app.locals.releaseEvidence` has a producer (P15-E6). It fails closed.
12. **No production environment was used.** All evidence is from a disposable local PostgreSQL 18.3
    instance. No soak, no multi-shard run, no real fleet.
13. **X-C1 is reported, not fixed** (Phase 12 — `auditStream.link()` turns an absent instant into an
    Invalid Date). **X-C2 is reported, not fixed** (unreachable after P15-C2).
14. **`prisma migrate diff` still reports the Phase 1 drift.** Not re-investigated here.
15. **The 24-gate table has never been green**, and 7 of its rows cannot be closed by any commit in
    this repository — plus one row (B-M) that is green and should not be read as proven.

---

## 22. Closure decision

# PHASE 15 — BLOCKED

**Outcome B.** Every Phase-15-owned, in-repository blocker this pass could find is closed. Six were
found on a tree the previous pass had declared free of them, and six are fixed — each reproduced
before the fix, attacked after it, mutation-tested, and, where the defect lived in a row rather than
a branch, verified against a real PostgreSQL instance driving the shipped composition.

Phase 15 is **not** closed, and repository-completeness is not closure:

| Blocker | Class |
|---|---|
| **B1** — no routing engine selected | EXTERNAL |
| **B8** — 39 Safety-class parameters not DERIVED | EXTERNAL |
| **B-P** — 4 PRODUCTION gates | OBSERVATION |
| **B-O** — 3 ORGANISATIONAL gates | EVIDENCE |
| **B-M** — no exhaustive state-machine check exists | EVIDENCE (compute) — *new* |
| **X3** — §4.2 has no transition table | SPECIFICATION |

**Nothing was invented.** No calibration value, no routing engine, no observation window, no
attestation, no TASK timer semantics, no formal-verification evidence. No gate was weakened and no
threshold moved.

### Phase 16 — NOT READY, and no limited mode is available

§1.8 rule 3 enables Tier 2 mechanisms one at a time **after** the cutover. There has been no
cutover, and there cannot be one while `coordinator` is uncomposable. There is no limited mode in
which Phase 16 can safely proceed: every Tier 2 mechanism it would enable sits downstream of the
decision path B1 blocks, and `tierTwoAtShipState` refuses a cutover with any of them live —
by test, not by assumption.

### Recommendation

1. **B1 and B8 remain the whole of the critical path.** Both are decisions, not code.
2. **B-M is new and is the cheapest of the remaining blockers to move** — it needs compute, not
   decisions. A completed TLC run on `lifecycle.tla` would close the half of
   `model_check_capacity_1_2_3` that has never been checked at all.
3. **T1-04** (§17.4's escalation ladder) is the next *remedial* phase and is independent of both.
4. **X-C1** should be routed to Phase 12's owner.
5. **On whether a fourth pass is worthwhile.** Pass 2 recommended against a third, on the grounds
   that "the marginal finding is getting deeper and rarer". This pass found six, two of them
   blocking-permissive at the release authority and one that made a green §24 gate's central claim
   unachievable. The marginal finding was neither rare nor deep — **P15-E1 and P15-E3 were one
   `grep` for the pattern pass 2 had itself written down**, and P15-E5 was sitting in a file
   `formal/README.md` had explicitly assigned to Phase 15 and named the defect in.

   So the recommendation is not "audit Phase 15 again". It is: **when a pass names a defect shape,
   sweep the tree for that shape before closing.** Pass 2's two sentences — the `typeof` off switch,
   and producer/consumer agreement not being evidence — are each a mechanical search, and each of
   them was still finding defects in Phase 15's own files a day later. The same two searches across
   the other phases' fail-closed paths is worth more than a fourth pass here.

---

**TRUTH > GREEN.**

# PHASE 15 — BLOCKED
