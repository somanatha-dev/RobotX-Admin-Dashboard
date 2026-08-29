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
| `PHASE_15_REMEDIATION_AND_CLOSURE_2026-08-24_PASS3_ASWRITTEN.md` | pass 3 exactly as it left the tree, §19 unfilled | **Preserved verbatim** (sha256 `55d77027…`) |
| **this document** | 158 → 159 suites, current tree | **Current** — pass 3 plus its independent verification (§23–§26). |

> **Correction, made by the verification pass and not by pass 3.** This row previously read
> "158 → 160 suites". The measured count is **159**; only one suite file was added
> (`phase15ObservationWindowRemediation.test.js`). The claim was never measured because
> pass 3 never ran its own §19. See §23.

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
| `tests/engine/phase15ObservationWindowRemediation.test.js` | Phase 15 | **NEW** — **52** tests (this row said 40; §17 said 52; the measured count is 52 — §23) |
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

**Pass 3 left this section as a placeholder and closed on it.** Every number below was
measured by the verification pass (§23–§26) on the settled tree, on a disposable
PostgreSQL 18.3 cluster built from empty. Nothing here is inherited from a report and
nothing is predicted.

### 19.1 Tests

```
$ npx jest --runInBand --forceExit          # re-run after the last source change, on digest 801ed1df
Test Suites: 159 passed, 159 total
Tests:       7061 passed, 7061 total
Snapshots:   0 total
Time:        323.961 s
exit 0
```

| | Pass-3 arrival baseline | Measured now |
|---|---:|---:|
| Test suites | 158 | **159** |
| Tests | 7 001 | **7 061** |
| Failures | 0 | **0** |
| Skips | 0 | **0** |

The delta is +1 suite / +60 tests: `phase15ObservationWindowRemediation.test.js` (**52**,
pass 3's) and **5** added by the verification pass for blocker B-M, plus 3 net from pass 3's
rewrite of `lifecycleModelCheck.test.js`.

### 19.2 Build gates

```
$ npm run gates                                              exit 1
gate: tier-dependencies          PASS — 285 modules, 422 governed import edges
gate: parameter-register         PASS — 189 engine modules against 242 registered parameters
gate: tenets                     PASS — 282 modules
gate: identity-isolation         PASS — 16 modules in the cost/decision-record scopes
gate: reconstruction-equivalence PASS — 3 corpus decisions, byte for byte
gate: legacy-retirement          PASS — 4 retired modules absent, 340 files
gate: column-generation          PASS — NOT_REQUIRED
gate: composition-root           FAIL — 1 violation across 18 registered workers:
                                        coordinator [LEADER_ONLY_NOT_COMPOSABLE] — B1, EXTERNAL
```

**7 PASS, 1 FAIL.** The one failure is B1 and no commit in this repository closes it.

### 19.3 Standing gates — re-run, nothing manufactured

```
$ node tools/gates/checkCalibration.js                       exit 1
FAIL — 39 blocking finding(s).
242 entries: 52 DERIVED, 152 PROVISIONAL, 38 UNCALIBRATED. 54 are Safety-class.

$ node tools/simFidelity/validate.js                         exit 1
7 models NOT_MEASURED, 6 safety-relevant. No study was supplied.

$ node tools/routing/b1Readiness.js                          OVERALL: BLOCKED
steps 1, 3, 4, 5 blocked by D1, D3, D8. No engine selected, ranked or recommended.
```

All three are **identical to arrival**. No value was manufactured, promoted or defaulted.

### 19.4 Live PostgreSQL — 288 checks

Disposable **PostgreSQL 18.3**, port **55441**, built from the installed binaries into the
scratchpad and destroyed afterwards. Never Neon, never the user's 5432 cluster; every harness
refuses both by name.

```
tables before: 0
APPLIED 27 migrations from empty      FAILED: (none)
tables after: 75  (74 application tables + _prisma_migrations)
AuditEvent_event_type_known admits CUTOVER_SHARD_ENABLED and CUTOVER_SHARD_ROLLED_BACK
```

| Harness | Checks |
|---|---|
| `tools/verify/phase15VersionInForce.js` | **19 / 19** |
| `tools/verify/phase15EvidenceBinding.js` | **17 / 17** |
| `tools/verify/phase15CurrentTree.js` | **32 / 32** |
| `tools/verify/phase15LiveDatabase.js` | **12 / 12** |
| `tools/verify/phase5ExpirySemantics.js` | **102 / 102** |
| `tools/verify/phase5LiveDatabase.js` | **106 / 106** |
| **total** | **288 / 288** |

*(Pass 3 reported "74 tables". The measured count is 75 including `_prisma_migrations`;
the two reconcile and neither is wrong — the unit is now stated.)*

### 19.5 The §24 release table — collected on this tree

```
$ npm run release:gates                                      exit 1
source digest 801ed1df30791c13…   evidence: docs/release-evidence.json   attestations: (none)
16 green, 1 red, 7 not evaluated

RED            engine_decision_path_wired          BUILD           execution plan, Phase 15   [B1]

NOT_EVALUATED  calibration_safety_derived          ORGANISATIONAL  §22.4     [B8]
NOT_EVALUATED  invariants_enforced                 PRODUCTION      §26       [B-P]
NOT_EVALUATED  simulator_fidelity                  PRODUCTION      §24.4     [B-P]
NOT_EVALUATED  soak                                PRODUCTION      §24.6     [B-P]
NOT_EVALUATED  shadow_agreement                    PRODUCTION      §21.6     [B-P]
NOT_EVALUATED  safety_case_assembled               ORGANISATIONAL  §24.7     [B-O]
NOT_EVALUATED  rollback_rehearsed                  ORGANISATIONAL  exec plan [B-O]

GREEN          model_check_capacity_1_2_3          SUITE           §24.2
  [NOT PROVEN] the discharging suite asserts `exhaustive: false` for the lifecycle at
  capacities 1, 2 and 3, and `lifecycle.tla` has never been run under TLC; the commitment
  half is exhaustive only at capacity 1. A passing exit code from this command therefore
  does not establish the gate's statement.

RELEASE: BLOCKED — 8 blocking gate(s) are not green.
```

**16 / 1 / 7 — identical to the arrival baseline**, on a freshly collected evidence set bound
to this tree's digest. The one change is the `[NOT PROVEN]` line, which is new this pass
(§24, P15-F2) and is the first time the release table has said out loud that one of its green
rows is not a proof.

*(An earlier collection during this pass returned 0 green / 17 red / 7 not evaluated. That was
not a regression: the tree was edited while the collector was running, and every record was
correctly voided with `SOURCE_DIGEST_MISMATCH`. The digest binding doing its job, observed by
accident.)*

### 19.6 Source digest

```
$ node tools/release/sourceDigest.js
at pass-3 arrival   134ebc0d1d6cd047b5ebb62de9808489274520c9c9607795a9ef0d9e43373a2c  (562 files)
after pass 3        4b45415aab0d78505603b86c9344cd32b0845592c9a55ff24f887df0174cf412  (564 files)
at closure          see §26.5
```

---

## 20. Remaining blockers

| ID | Description | Owner | Class | Why no commit here closes it | What is required |
|---|---|---|---|---|---|
| **B1** | No routing engine selected | Ops + Commercial (D1), Product + Fleet Eng (D3), Ops (D8) | **EXTERNAL** | Selecting an engine is an Operations, Product and Commercial decision. `coordinator` and `shadow` cannot compose; `gate:composition` and `engine_decision_path_wired` stay red. | An authoritative operating region as GeoJSON; a real fleet speed model over roadClass/gradient/surface/payload/congestion/weather; an extract vintage, cadence and re-contraction budget. Then B1 steps 1, 3, 4 and the Step 5 ADR. |
| **B8** | 39 Safety-class parameters not `DERIVED` | §22.4's calibration owner | **EXTERNAL** | Requires measurement, certification and named-owner attestation. §22.4 itself: values that *"require data the fleet does not yet produce and cannot produce before it operates."* | Per-class rated-mass certification; the operated CA's revocation latency; measured p99 to the consensus store; a safety decision per degraded mode; and 35 more, each named in the gate output. |
| **B-P** | 4 PRODUCTION gates `NOT_EVALUATED` — `invariants_enforced`, `simulator_fidelity`, `soak`, `shadow_agreement` | — | **OBSERVATION** | Require a fleet that has operated. The 14-day shadow window cannot *begin* until B1. | Production traffic; a 72 h soak; a one-sided fidelity study against realised distributions; a zero-violation invariant SLI over a window. |
| **B-O** | 3 ORGANISATIONAL gates `NOT_EVALUATED` — `calibration_safety_derived`, `safety_case_assembled`, `rollback_rehearsed` | named humans | **EVIDENCE** | Require named people to have acted, with a corroborating run that exited 0 where the gate declares one. `gate:calibration` exits 1. | Two distinct signatures per gate; a real rehearsal record carrying all six §5 steps and `automaticRollbackFired`. |
| **B-M** *(sharpened in §24: the gate is not merely unproven — its own discharging suite asserts the negation of its statement. Repository half closed there; compute half stands.)* | **`model_check_capacity_1_2_3` is GREEN and NOT PROVEN** — no exhaustive lifecycle check exists at any capacity, by either checker; commitment is exhaustive only at capacity 1 | Release owner + compute | **EVIDENCE (compute)** · **found by this pass** | A completed TLC run on `lifecycle.tla`, and on `commitment.tla` at capacities 2 and 3, needs more compute than a workstation session. Not a different specification and not more code. | Either the compute to close those runs, or an explicit decision by the release owner about what this gate's statement means given a bounded executable checker. |
| **X3** | No `TASK` timer producer; §4.2's half of §4.5 unreachable | — | **SPECIFICATION** | §4.2 contains no Task transition table. Inventing one is not remediation. | A §4.2 transition table in the frozen specification, or an explicit decision to scope the gate to §4.3. |
| **X1** | §17.4 escalation ladder unimplemented | REMEDIAL PHASE T1-04 | **FUTURE PHASE** | Not Phase 15's deliverable. | T1-04. |

### Blocker taxonomy

| Class | Items |
|---|---|
| **In-repository, Phase-15-owned** | ~~**none remaining**~~ — **this claim was false when pass 3 made it.** The verification pass found **P15-F1** (open), **P15-F2/B-M's repository half** (closed) and **P15-F3** (closed). See §24. The claim has now been made and falsified in three consecutive passes. |
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

# PART II — INDEPENDENT VERIFICATION OF PASS 3

**Date:** 2026-08-25 · **Mandate:** zero-trust re-derivation — *"Do NOT trust any previous
verdict. Re-derive it from the current tree."*

Everything above this line is pass 3's own account of its work. Everything below is a
separate exercise that trusted none of it, re-measured every claim, re-attacked every fix
with probes written for this purpose rather than borrowed from pass 3's suites, and looked
for what pass 3 missed.

---

## 23. Pass 3's claims, re-derived

### 23.1 The six fixes are real, and they are at the authority boundary

Each was located in the shipped module, not in a test, and then attacked independently. The
probe used for E1/E3/E4 is 119 admissions built from the mandate's own malformed-value matrix
(§4, §6, §7) and shares no code with `phase15ObservationWindowRemediation.test.js`.

**The probe was made to fail first.** Its first run refused all 119 probes *including the
honest controls*, which proves nothing — a fixture refused for the wrong reason is not
evidence. The cause was a missing `producer` field (`SELF_ASSERTED`). Only once the honest
controls were admitted did the refusals below mean anything.

| | Verified how | Result |
|---|---|---|
| **E1** | 84 malformed endpoint shapes × 4 PRODUCTION gates: `NaN`, `±Infinity`, `undefined`, `null`, empty string, whitespace, numeric string, boolean, object, array, `MAX_VALUE`, `MIN_VALUE`, unsafe integers, negative and zero spans, fractional endpoints, a window wholly in the future, a window ending in the future, an absent `observation`, an absent `source` | **all 84 refused** |
| **E1 controls** | honest 100-day and 73 h soak; honest 15-day shadow | **admitted** — and honest 71 h soak / 13-day shadow refused `OBSERVATION_WINDOW_TOO_SHORT`. The fix does not over-refuse. |
| **E2** | live, 19/19, on a database built from empty — including the **pre-fix producer reproduced against the same rows** and the rollback firing correctly once the candidate is resolved | **holds** |
| **E3** | honest 2 h window → `PROCEED`; 11 malformed endpoints → 8 throw, 3 `HOLD`; the pre-declaration and window-length rules still fire on real windows | **holds** |
| **E4** | 12 caller-supplied bound shapes × 2 register-bounded gates | **11 of 12 refused — see P15-F1** |
| **E5** | `MAX_VERSION` present and bounding; `check()` reports `exhaustive`, `depthTruncated`, `stateCapExceeded`, `maxDepthReached` separately; the shipped capacity-1 shape measured `exhaustive:false, depthTruncated:true` | **holds** |
| **E6** | `grep` over `src/`, `server.js`, `tools/`: `app.locals.releaseEvidence` has **three readers** (`health.controller.js:319, 320, 341`) and **no producer anywhere** | **confirmed** |

### 23.2 Three of pass 3's own numbers were wrong, and it could not have known

Pass 3 wrote §19 as a placeholder — *"(filled in from the final run)"* — and closed without
ever running it. Its narrative numbers were therefore never checked against a measurement.

| Pass 3 said | Measured | Disposition |
|---|---|---|
| "158 → **160** suites" (§0) | **159** | corrected in §0; one suite file was added, not two |
| new suite is "**40** tests" (§18) vs "**52** tests" (§17) | **52** | §18 corrected; §17 was right |
| "**74** tables" (§15) | **75** incl. `_prisma_migrations` | reconciled, unit stated |

None of these changes a verdict. They are recorded because a closure document whose numbers
were never measured is the same class of defect this programme has spent four passes finding:
**a claim that could not be false.**

---

## 24. New findings

### P15-F1 — a caller may still weaken a release requirement, by stating a smaller number · **BLOCKING (permissive)** · **REPORTED, NOT FIXED**

**P15-E4 closed the degenerate values and left the class open.** It refuses a bound of `0`,
`NaN`, `±Infinity`, a string, `null` or `true`. It admits **any positive finite number**,
however small, because nothing at the authority compares the caller's bound against the
register's.

Measured, against the shipped module:

```
register (authoritative):  release.soak_duration = 72 hours
                           cutover.shadow_agreement_window = 14 days

*** ADMITTED+PASS ***  soak: window = 2 000 ms, caller bound = 1 000 ms
*** ADMITTED+PASS ***  soak: window = 1 ms,     caller bound = 0.5 ms
*** ADMITTED+PASS ***  shadow_agreement: window = 1 000 ms, caller bound = 1 000 ms
```

A gate whose entire content is *"72 hours of production soak"* is discharged by a
**one-second** window, by supplying `{ soak: 1000 }` in the request object.

**This is not hypothetical — the repository already does it.** `tools/verify/phase15EvidenceBinding.js:162`
supplies `soak: DAY` — **24 hours against a register value of 72** — and its 17/17 green
includes a soak gate discharged against a bound a third of the required one. Nothing refuses
it, because nothing compares it to anything.

**Why P15-E4's own reasoning demands this too.** Pass 3 wrote that the bound *"is
caller-supplied — `stage.authoriseEnable()` passes `request.minObservationMs` straight
through — so the attack is a field in the request object."* That is exactly as true of `1000`
as of `0`. The lesson pass 3 wrote for itself applies to its own fix: **a pass that names a
defect shape and does not sweep for it has found one instance, not the class.**

Traced to the authority: `stage.js:348` — `minObservationMs: source.minObservationMs` — with
`stage.js:345` stating the intended contract in a comment, *"Resolved by the caller from the
register"*, and nothing enforcing it. `tools/release/verdict.js:127` **does** resolve from the
register, which is why the release table is not affected; the cutover authority is.

**Reachability: latent.** `stage.authoriseEnable()` has **no production call site** — only
`tools/verify/*` and tests. Same standing as P15-E3, which pass 3 fixed anyway on the
principle *"a fail-open on a path nobody reaches today is a fail-open waiting for the caller
that does."*

**Why this pass reports rather than fixes it.** The correct fix removes the number from the
caller: `authoriseEnable` should take the register accessor and call
`evidence.resolveMinObservationMs()` itself, so the bound cannot be stated in a request at
all. That changes the authority's request contract and touches six fixture builders across
tests and harnesses. This pass had already measured what a contract change at this exact
point costs (§24, P15-F2: 29 tests failing at their fixtures rather than on their subject),
and a second such change, made late in a verification pass and verified only by the pass that
made it, is how a remediation becomes the next pass's defect. **It is recorded with its
reproduction, its owner and its patch rather than attempted in haste.**

**Exact discharge.** In `stage.authoriseEnable()`, replace the pass-through with
`evidence.resolveMinObservationMs(source.parameterValues)`, make `parameterValues` a required
dependency (absent ⇒ `{}` ⇒ the two windowed gates refuse, which is the fail-closed
direction), and update the six fixture builders to inject `service.loadRegister()`. Then
mutation-test it by substituting a caller-supplied bound for the register's and requiring the
suite to fail.

---

### P15-F2 / blocker B-M — a GREEN gate whose own evidence refutes it · **Repository-owned (evidence mapping)** · **ANNOTATED; algebra deliberately unchanged**

The mandate asked whether B-M is *"a repository-owned implementation/evidence defect or a
genuinely external computation/evidence dependency."* **It is both, and the halves have
different owners.**

`model_check_capacity_1_2_3` is a blocking §24.2 gate. Its statement:

> The commitment protocol **and the lifecycle** are model-checked **exhaustively** at capacity
> 1, 2 and 3 for every §24.2 safety and liveness property.

Its evidence is the exit code of `npm run test:engine -- ModelCheck`. Measured: **exit 0, 2
suites, 46 tests** — so the gate reads GREEN.

**After P15-E5, that command asserts the negation of the gate's statement.** Measured in the
discharging suite itself:

```
lifecycleModelCheck.test.js:101
  expect({ capacity, exhaustive: result.exhaustive })
    .toEqual({ capacity, exhaustive: false });          // capacities 1, 2 and 3

lifecycleModelCheck.test.js:163
  test("no exhaustive lifecycle model check exists at any shipped capacity — pinned, not implied")
```

and the suite's own header says it outright: *"This suite exits 0 and cannot establish that."*

So this is **stronger than "GREEN and not established"**, which is how pass 3 recorded it. The
repository holds, in writing and in passing assertions, the proof that the gate's central
claim is false for the lifecycle at every shipped capacity — and the gate is green because the
run that proves it exits 0. **A green gate whose own evidence refutes it is a failed safety
mechanism, not a passing one.** That half is repository-owned and nothing external is needed
to see it.

**What was implemented, measured, and then not kept.** Suppressing the promotion to GREEN —
the mandate's §8 option C, `NOT_EVALUATED` until an actual model check exists — was
implemented first and measured:

```
passing run (exit 0)  -> NOT_EVALUATED  [promotion suppressed]
failing run (exit 1)  -> RED            [refusals never suppressed]
control gate, exit 0  -> GREEN          [no other gate affected]

$ npx jest --selectProjects engine gates
Test Suites: 5 failed, 131 passed      Tests: 29 failed, 6834 passed
```

Those 29 failures are **not** the change working as intended. They are fixtures: five suites
build a hypothetical all-green table in order to verify *other* refusals — the guardrail
declaration (P15-C2), the five refusals, ADR-34's purpose handling, the staging order — and a
gate that can never be green makes the cutover authority permanently unexercisable, so they
fail at their fixture rather than on their subject. The trade was **a status change on a
cutover that B1 already blocks absolutely, paid for with the loss of verification of every
other refusal the authority makes.** That is a worse system, not a more honest one.

**What was kept.** The fact is now machine-readable on the gate row
(`establishedByCommand: false` + `notEstablishedReason`), surfaced by `gates.evaluate()` as
`notEstablished`, and printed by `verdict.js` against the row as `[NOT PROVEN] …`. The gate
algebra is untouched, and the reason it is untouched is recorded in the code at the point of
the decision rather than only here. **Five regression tests** pin it, including one asserting
that no other gate carries the flag and one that re-derives the contradiction from the checker
itself. Mutation **MA** (remove the flag) is caught.

**Ownership, as the mandate asked:**

| Half | Class | Owner | Discharge |
|---|---|---|---|
| The gate reported GREEN with no indication its command cannot establish it | **B — repository-owned evidence defect** | Phase 15 | **Done this pass** (annotation + 5 tests) |
| No exhaustive model check exists for the lifecycle at any capacity | **G — formal/model-checking computation dependency** | Release owner + compute | A completed TLC run |

**Can TLC be run here? No, and this was checked rather than assumed.** Java 20 is present.
`lifecycle.tla` and `lifecycle_c{1,2,3}.cfg` are checked in and complete. **`tla2tools.jar` is
not in the tree** — no `.jar` exists anywhere under the repository. `formal/README.md` records
that Phase 3 *fetched* it from the network in 2026-08-15 and ran it against `commitment.tla`.
Fetching a toolchain from an external host is not something this pass did on its own
initiative, and **no TLC run was performed.** The exact discharge command is already recorded
in `formal/README.md`:

```
java -jar tla2tools.jar -config lifecycle_c1.cfg -workers auto lifecycle.tla
```

**No result was fabricated, and the gate was not weakened, reddened or bypassed.**

---

### P15-F3 — every malformed `--max-age-hours` was refused except the one a shell produces · **Low** · **FIXED**

`verdict.js` validated the age bound carefully and never saw the empty string. Line 198 read
`argv[index + 1] ? argv[index + 1] : undefined` — a **truthiness** test that ran *before* the
validator, so an empty value made the flag read as **absent** and the run silently took
`DEFAULT_MAX_AGE_HOURS = 24`.

Measured before:

```
--max-age-hours NaN       exit 2      --max-age-hours -1     exit 2
--max-age-hours Infinity  exit 2      --max-age-hours 0      exit 1  (bound 0 — strict, correct)
--max-age-hours banana    exit 2      --max-age-hours ""     exit 1  ← silently defaulted
```

The realistic producer is not a typo but a shell: `--max-age-hours "$MAX_AGE"` with `MAX_AGE`
unset expands to exactly this, and an operator who intended a **stricter** bound gets 24 hours
with no message. The distinction that matters is *"the flag is absent"* versus *"the flag was
given a value I cannot use"*, and only the first may fall back to a default.

**Fixed.** After: `""` and `"   "` and a trailing `--max-age-hours` with no value all exit 2;
an absent flag still defaults; `0` and `720` still behave exactly as before.

---

## 25. Mutation results — 6 / 6 caught

Each protection was removed from the shipped source, the guard that covers it was required to
**fail**, the file was restored and byte-compared against an in-memory copy, and the guard was
required to pass again. These are the verification pass's own mutations, run against the
current tree.

| | Protection removed | Guard | Verdict |
|---|---|---|---|
| **MA** | `establishedByCommand: false` — the B-M annotation (P15-F2) | `cutoverEvidence.test.js -t 'B-M'` | **CAUGHT** |
| **MB** | PRODUCTION window endpoints must be finite (P15-E1) — reverted to `typeof` | `phase15ObservationWindowRemediation` | **CAUGHT** |
| **MC** | the minimum-observation bound must be positive (P15-E4) — reverted to `typeof` | `phase15ObservationWindowRemediation` | **CAUGHT** |
| **MD** | `guardrails.assess()` requires finite endpoints (P15-E3) — reverted to `typeof` | `phase15ObservationWindowRemediation` | **CAUGHT** |
| **ME** | `versionInForceReader` resolves the **pin** (P15-E2) — substituted "latest published" for "in force" | `phase15VersionInForce.js`, **live DB** | **CAUGHT** |
| **MF** | a rollback may not supersede an unpinned version (P15-E2) | `phase15VersionInForce.js`, **live DB** | **CAUGHT** |

**No mutation survived.** ME and MF are the two the mandate asked for by name — *"mutate the
lookup so that 'latest published' is deliberately substituted for 'in force' and prove the
tests/gates catch it"* — and both were run against real rows in a real database, because that
is the only place the two versions differ.

All six guards were confirmed restored to their fixed form by content match after the run.

---

## 26. Final verification, and the closure decision

### 26.1 Measured on the settled tree

Everything in §19 was measured after all changes below were complete. Headline:

```
npx jest --runInBand --forceExit    159 suites, 7 061 tests, 0 failures, 0 skips, exit 0
npm run gates                       7 PASS, 1 FAIL (composition-root — coordinator, B1)
node tools/gates/checkCalibration.js   exit 1 — 39 findings, unchanged
node tools/simFidelity/validate.js     exit 1 — 7 NOT_MEASURED, unchanged
node tools/routing/b1Readiness.js      OVERALL: BLOCKED, unchanged
live PostgreSQL 18.3                288 / 288 checks, 27 migrations from empty, 0 failures
mutations                           6 / 6 caught, 0 survivors
```

### 26.2 What this pass changed

| File | Owner | Change |
|---|---|---|
| `src/engine/cutover/gates.js` | Phase 15 | P15-F2 — the `[NOT PROVEN]` annotation, its reason, and the recorded decision not to change the algebra |
| `tools/release/verdict.js` | Phase 15 | P15-F2 — prints the annotation; **P15-F3** — an empty flag value is refused |
| `tests/engine/cutoverEvidence.test.js` | Phase 15 | **+5 tests** pinning P15-F2 |

**No file owned by Phases 0–14 was modified. No migration was added or edited. No test was
deleted, skipped, weakened or retargeted. No gate was weakened, no threshold moved, no
`NOT_EVALUATED` converted to `PASS`.** The three source files pass 3 changed under `src/`
(`evidence.js`, `guardrails.js`, `rollbackPublisher.js`) were mutated and restored, and were
confirmed byte-identical to their pre-mutation state.

### 26.3 Cross-phase integrity

`Backend/src/db`, `src/engine/{commitment,dispatch,domain,shard}` and `prisma/schema.prisma`
are untouched. Phase 5's two harnesses pass **102/102** and **106/106** against a database
built from empty. Phase 12's audit contract, Phase 13's leadership/fencing and Phase 14's
security/privacy were not modified and their suites pass. **Phase 16 contamination: clean.**

### 26.4 Remaining blockers — unchanged in substance, one sharpened

| ID | Class | Owner | Blocks Phase 16? |
|---|---|---|---|
| **B1** — no routing engine selected | EXTERNAL | Ops + Commercial (D1), Product + Fleet Eng (D3), Ops (D8) | **Yes, absolutely** |
| **B8** — 39 Safety-class parameters not DERIVED | EXTERNAL | §22.4's calibration owner | Yes |
| **B-P** — 4 PRODUCTION gates NOT_EVALUATED | OBSERVATION | needs an operating fleet | Yes |
| **B-O** — 3 ORGANISATIONAL gates NOT_EVALUATED | EVIDENCE | named humans | Yes |
| **B-M** — no exhaustive model check exists | **split: repository half CLOSED this pass; compute half EVIDENCE** | Release owner + compute | Yes |
| **X3** — §4.2 has no transition table | SPECIFICATION | frozen-spec owner | No |
| **P15-F1** — caller may state a weaker observation bound | ~~**IN-REPOSITORY, Phase-15-owned, OPEN**~~ → **CLOSED 2026-08-25, see Part III (§28–§35)** | Phase 15 | No (latent; no production caller) |

**Is controlled or shadow execution still safe?** Shadow execution cannot start — the shadow
worker cannot compose, for the same reason the coordinator cannot (B1). Controlled execution
is refused by the authority itself while any blocking gate is not GREEN, and seventeen are
not. **Nothing this pass found makes the current state less safe; P15-F1 is the one item that
would become live the moment a production caller of `authoriseEnable` is written, and it must
be closed before that caller exists.**

### 26.5 Final source digest

```
$ node tools/release/sourceDigest.js
801ed1df30791c13d697fca3892af220c2f4e666a402a2903329bf6d9143676c  (564 files)
```

---

## 27. Closure decision

# PHASE 15 — BLOCKED. PHASE 16 — NOT READY.

The verdict is unchanged from four passes, and it is unchanged for the same reason: **the
decision path terminates in a routing engine that B1 has not selected**, and selecting one is
an Operations, Product and Commercial decision that no commit in this repository makes.

What this pass adds is not a different verdict but a more honest basis for it:

1. **Pass 3's six fixes are real.** Five were verified at the authority boundary against
   probes that share no code with pass 3's tests; the sixth (E2) was verified live, and both
   of its mutations were caught against real rows.
2. **Pass 3 closed on an unmeasured §19.** It has now been measured, and three of its
   narrative numbers were wrong. None changed a verdict; all are corrected in place with the
   correction marked rather than silently applied.
3. **Two new Phase-15-owned findings.** P15-F3 is fixed. **P15-F1 is open, and is stated as
   open rather than deferred into a sentence that reads like closure** — the failure mode this
   programme has now recorded in four separate passes. *(P15-F1 was subsequently closed on
   2026-08-25 — see Part III, §28–§35. This paragraph is left as it was written.)*
4. **B-M is answered.** Its repository-owned half — a green gate whose own discharging suite
   asserts the negation of its statement — is closed by annotation, five regression tests and
   a caught mutation. Its remaining half needs a completed TLC run, the command for which is
   recorded. **No TLC evidence was manufactured and the gate was not weakened.**

**"In-repository: none remaining" is not claimed by this pass, and that is deliberate.** Pass
2 claimed it and pass 3 found six. Pass 3 claimed it and this pass found three. The claim
itself has been wrong every time it has been made, and P15-F1 is left standing in the blocker
table as the honest form of it.

**Nothing was invented.** No calibration value, no routing engine, no observation window, no
attestation, no TASK timer semantics, no formal-verification evidence, no TLC run.

---

**TRUTH > GREEN.**

# PHASE 15 — BLOCKED

---

# PART III — P15-F1: ADVERSARIAL REMEDIATION, RE-VERIFICATION AND CLOSURE

**Date:** 2026-08-25 · **Branch:** `feature/dashboard` · **Scope:** close **P15-F1** and nothing
else. This is not a fourth Phase-15 audit; it is the discharge of the one in-repository,
Phase-15-owned blocker Part II left open, together with the verification that closing it moved
nothing else.

**Digest at arrival:** `801ed1df30791c13d697fca3892af220c2f4e666a402a2903329bf6d9143676c` (564 files)
**Digest at closure:** `72f943df83416c7317b107a903efedee1863459ea3839ccd2b016a69e43e8c81` (565 files)

---

## 28. Root cause — exactly

### 28.1 What the defect was

`stage.authoriseEnable()` took the minimum observation window **from the request**:

```js
// Backend/src/engine/cutover/stage.js:348, before
const blocking = gates.blockers(source.releaseEvidence, {
  nowMs: source.requestedAtMs,
  maxAgeMs: source.evidenceMaxAgeMs,
  sourceDigest: source.sourceDigest,
  // Resolved by the caller from the register (`evidence.resolveMinObservationMs`). …
  minObservationMs: source.minObservationMs,
});
```

The comment on line 345 stated the contract — *"Resolved by the caller from the register"* — and
**nothing enforced it**. That is the whole root cause in one sentence: *a contract stated in a
comment and enforced nowhere is not a contract, and the field it describes is an override with the
register's name on it.*

The authoritative register says:

| Parameter | Registered value | Gate it bounds |
|---|---|---|
| `release.soak_duration` | **72** hours (`§24.6`, PROVISIONAL) | `soak` |
| `cutover.shadow_agreement_window` | **14** days (`§21.6`, DERIVED) | `shadow_agreement` |

Neither number reached the decision. Whatever the request said did.

### 28.2 Why P15-E4 did not close it

P15-E4 added a guard **in the adjudicator** (`evidence.admit()`) requiring the resolved bound to be
a finite positive number. That refuses `0`, `NaN`, `±Infinity`, a string and `null` — and admits
**any positive finite number, however small**, because `admit()` can only ask whether a bound is
*usable*. It cannot ask whether it is *the* bound: §22.1 keeps the number out of that module
deliberately, and `MIN_OBSERVATION_PARAMETER` holds gate → parameter names and no values.

So the fix had to be at the **authority**, not the adjudicator. Part II reported this and did not
attempt it; this pass performed it.

### 28.3 Reproduced before the fix — measured, not argued

The pre-fix source was restored by mutation **MU3** (§31) and the attack run against the shipped
modules with the real register loaded:

```
register: soak=72h  shadow_agreement=14d

*** AUTHORISED ***  soak: window 2 000 ms, caller bound 1 000 ms
*** AUTHORISED ***  soak: window 1 ms,     caller bound 0.5 ms
*** AUTHORISED ***  shadow_agreement: window 1 000 ms, caller bound 1 000 ms
*** AUTHORISED ***  soak: window 25 h, caller bound 24 h   ← the shipped harness's own value
FAIL-OPEN x4
```

Every one of those four is a **complete authorisation to take a shard live**: `authorised: true`,
with `binding { level: "region", name: "cutover.engine_enabled", value: true }`.

The fourth line is not a hypothetical. `tools/verify/phase15EvidenceBinding.js:162` supplied
`minObservationMs: { shadow_agreement: 14 * DAY, soak: DAY }` — **24 hours against a registered
72** — and that harness's 17/17 green included a soak gate judged against a third of the required
duration. Nothing refused it because nothing compared it to anything.

---

## 29. The authority boundary, exactly

```
authoriseEnable(request)
    │
    ├─ request.minObservationMs present?  → REFUSE  [OBSERVATION_BOUND_NOT_THE_CALLERS]
    │                                        (whatever it says, in either direction)
    ├─ request.parameterValues absent /
    │  not `{ get(name) }`?               → REFUSE  [EVIDENCE_CONTEXT_INCOMPLETE]
    │
    ├─ evidence.resolveMinObservationMs(request.parameterValues)
    │        └─ accessor throws           → REFUSE  [PARAMETER_REGISTER_UNREADABLE]
    │
    ├─ gates.blockers(evidence, { nowMs, maxAgeMs, sourceDigest, minObservationMs })
    │        └─ evidence.admit(...)
    │              └─ bound absent / not finite-positive
    │                                     → that gate RED [OBSERVATION_WINDOW_REQUIRED]
    │              └─ window < bound       → that gate RED [OBSERVATION_WINDOW_TOO_SHORT]
    └─ release decision
```

**What sits on each side of the boundary:**

| | Owner |
|---|---|
| *What the requirement is* (72 h, 14 days) | the **register**, resolved by the **authority** |
| *Which parameter bounds which gate* | `evidence.MIN_OBSERVATION_PARAMETER` (names only, no values — §22.1) |
| *Whether a resolved bound is usable* | the **adjudicator** (`evidence.admit`, P15-E4's guard, unchanged) |
| *Which register to read* | the **caller**, by injection — see the limit stated in §33.2 |
| *What the bound is* | **nobody but the register** |

### The four states the mandate asks to be kept apart, kept apart

| State | Outcome | Code |
|---|---|---|
| **malformed caller input** — the request states a bound at all | whole request refused | `OBSERVATION_BOUND_NOT_THE_CALLERS` |
| **absent** parameter source | whole request refused, naming the missing dependency | `EVIDENCE_CONTEXT_INCOMPLETE` |
| **absent parameter** in a readable register | that gate inadmissible; the rest of the table still judged | `OBSERVATION_WINDOW_REQUIRED` |
| **invalid parameter** (`0`, `NaN`, `−1`, `Infinity`, `"72"`, `null`, `true`, an object) | that gate inadmissible | `OBSERVATION_WINDOW_REQUIRED` |
| **valid authoritative parameter** | it, and only it, is the requirement | — |

Nothing invents a default, reads a missing value as zero, or reads one as unlimited. A register
that lost `release.soak_duration` **reddens** the soak gate and leaves `shadow_agreement` green —
pinned by a test (§30, "one parameter present and the other absent").

### Why a caller-supplied *larger* bound is refused too

Requirement 8 taken literally: *the authority owns the requirement.* A bound that happens to agree
with the register today is still a bound the request declared. An authority that accepts an
agreeing one has conceded that the number is the caller's — the next caller states a smaller one,
and a register moving from 72 h to 96 h silently stops applying to every request that hard-coded
72. The mandate's case D says such a request *"MAY PASS"*; it does not pass here, which is
stricter and not looser. The half of case D that matters is pinned separately: **the identical
request with the field removed is authorised**, so nothing about a genuine 72-hour soak was made
unpassable.

---

## 30. Files changed

| File | Owner | Change |
|---|---|---|
| `Backend/src/engine/cutover/stage.js` | Phase 15 | **the fix.** Requires `parameterValues`; refuses `minObservationMs`; resolves the bound through `evidence.resolveMinObservationMs`; two new refusal codes; `require("./evidence")` added |
| `Backend/src/engine/cutover/evidence.js` | Phase 15 | **comment only.** The P15-E4 block said the bound "is caller-supplied"; corrected at its source and the P15-F1 half recorded there. No executable line changed |
| `Backend/tests/engine/phase15ObservationAuthority.test.js` | Phase 15 | **NEW — 50 tests.** The adversarial suite, cases A … M |
| `Backend/tests/engine/phase15ObservationWindowRemediation.test.js` | Phase 15 | fixture supplies `parameterValues`; P15-E4's authority test split in two (§30.1) |
| `Backend/tests/engine/phase15EvidenceBindingRemediation.test.js` | Phase 15 | fixture: `soak: DAY` → the register |
| `Backend/tests/engine/cutoverEvidence.test.js` | Phase 15 | fixture: request context separated from adjudicator context |
| `Backend/tests/engine/cutoverStaging.test.js` | Phase 15 | fixture: `evidenceContext()` supplies the register |
| `Backend/tests/gates/checkCalibration.test.js` | Phase 15 | fixture: `soak: day` → the register |
| `Backend/tools/verify/phase15EvidenceBinding.js` | Phase 15 | **the 24 h-against-72 fixture**, corrected |
| `Backend/tools/verify/phase15VersionInForce.js` | Phase 15 | fixture supplies the register |

**Six fixture/builders were named in the mandate; the sweep found eight call sites and all eight
were updated.** The ninth (`tools/verify/phase15CurrentTree.js` F5) passes a deliberately
incomplete request that is refused before the bound is reached, and was left alone.

Every fixture now injects **`service.loadRegister()`**, not a stub. A hand-rolled accessor would
be a caller-supplied bound with an extra function call in front of it — the defect wearing the
fix's clothes.

### 30.1 Test integrity

**No test was deleted, skipped, weakened, retargeted or threshold-relaxed.** One test changed its
assertion and it is named here in full:

`phase15ObservationWindowRemediation.test.js` — *"the defect, at the authority: a request cannot
bring its own zero bound"* asserted `RELEASE_GATE_NOT_GREEN` for a request carrying
`{ soak: 0, shadow_agreement: 0 }`. Under the new contract that request is refused **earlier** and
by name (`OBSERVATION_BOUND_NOT_THE_CALLERS`), so the assertion was updated — and the original
claim it was making (*a one-millisecond window discharges neither windowed gate*) was **not**
dropped: it is now a second test immediately below, made against the **register's** bound instead
of the caller's, which is a strictly stronger statement than the one it replaces. Net +1 test.

Two fixtures were made **stricter**, not looser: `phase15EvidenceBinding.js` and
`checkCalibration.test.js` each judged `soak` against 24 h and now judge it against 72 h. Their
observation windows (40 days and 40 days) clear both, so no assertion moved.

---

## 31. Attack cases — the mandate's A … M

Run by `tests/engine/phase15ObservationAuthority.test.js` (50 tests, all passing), plus an
independent probe sharing no code with it.

### Controls first — a refusal from an unauthorisable fixture proves nothing

| | Result |
|---|---|
| the register is measured, not assumed | `release.soak_duration` = **72** `hours`; `cutover.shadow_agreement_window` = **14** `days`; resolved = 72 h / 14 d |
| the gates the register bounds | exactly `soak` and `shadow_agreement` |
| a complete honest request | **AUTHORISED** |
| 73 h soak + 15-day shadow | **AUTHORISED** — the fix does not over-refuse |

### The attacks

| Case | Attack | Required | Result |
|---|---|---|---|
| **A** | authoritative soak 72 h, caller **1 ms** | REFUSE | **REFUSED** `OBSERVATION_BOUND_NOT_THE_CALLERS` |
| **B** | caller **1 000 ms** | REFUSE | **REFUSED**, same code |
| **C** | caller **24 h** | REFUSE | **REFUSED**, same code |
| **D** | caller **72 h** (equal to authoritative) | *may* pass | **REFUSED** — the authority owns the requirement (§29). The same request with the field removed is **AUTHORISED**, pinned separately |
| **D′** | caller **100 days** (larger) | must not replace | **REFUSED**, same code |
| **E** | authoritative shadow 14 d, caller **1 ms** | REFUSE | **REFUSED**, same code |
| **F** | caller **omits** the bound | must still evaluate the register | **the register is evaluated**: 71 h soak → RED `OBSERVATION_WINDOW_TOO_SHORT`, *"requires 72h"*; 73 h → GREEN; 13-day shadow → RED; 15-day → GREEN |
| **G** | caller supplies **0** | must not weaken | **REFUSED**, same code |
| **H** | caller supplies **NaN** | must not weaken | **REFUSED**, same code |
| **I** | caller supplies **±Infinity** | must not weaken | **REFUSED**, same code |
| **J** | caller supplies **negative** | must not weaken | **REFUSED**, same code |
| **K** | authoritative parameter **missing** | FAIL CLOSED | source absent / `null` / `{}` / no `get` / string / number → `EVIDENCE_CONTEXT_INCOMPLETE`. Source readable but answers nothing → both windowed gates RED `OBSERVATION_WINDOW_REQUIRED`, a 60-day window notwithstanding |
| **L** | authoritative parameter **invalid** | FAIL CLOSED | `0`, `−1`, `NaN`, `Infinity`, `"72"`, `null`, `true`, `{hours:72}` → both windowed gates RED `OBSERVATION_WINDOW_REQUIRED` |
| **M** | substitute the caller's value for the register's | the test MUST catch it | **caught by MU1 and MU3** (§32) |

Additional cases this pass added because the sweep found them:

| Attack | Result |
|---|---|
| `minObservationMs: undefined` — the spread-from-a-context producer | **REFUSED**. Presence is the test, not `typeof` — the off-switch shape P15-C1/E1/E3/E4 were each an instance of |
| `minObservationMs: {}` — present and saying nothing | **REFUSED** |
| the parameter accessor **throws** | **REFUSED** `PARAMETER_REGISTER_UNREADABLE` — not a half-judged table |
| one parameter present, the other absent | exactly **one** gate red; no default invented for the other |
| a **REHEARSAL** carrying a 1-second soak window | **REFUSED**. ADR-34 excludes exactly `rollback_rehearsed`; neither windowed gate is in the exclusion set |
| a **REHEARSAL** stating its own bound | **REFUSED** `OBSERVATION_BOUND_NOT_THE_CALLERS` |
| `invariants_enforced` / `simulator_fidelity` with 1-second windows | **AUTHORISED** — correct. Those two have no registered duration and none was invented for them |

Each refusal was additionally checked *not* to be `SHARD_NOT_ELIGIBLE`, `NO_REASON_GIVEN` or
`EVIDENCE_CONTEXT_INCOMPLETE`, so no case above is a refusal for an unrelated reason.

---

## 32. Mutation results — 4 / 4 caught, 0 survivors

Each protection was removed from the shipped `stage.js`, the suite was required to **fail**, the
file was restored from an in-memory copy and **byte-compared**, and the suite was required to pass
again. The baseline was proven green before any mutation and again after all of them.

| | Protection removed | Failures | Verdict |
|---|---|---|---|
| **MU1** | the authoritative resolution — `minObservationMs` in the `blockers()` context replaced by `source.minObservationMs` (the guard left in place) | **11 / 50**, including both controls and every case-F test | **CAUGHT** |
| **MU2** | the guard refusing a caller-stated bound (`Object.hasOwn`) | **19 / 50** — cases A–J | **CAUGHT** |
| **MU3** | **both — the exact pre-P15-F1 source** | **27 / 50** | **CAUGHT** |
| **MU4** | the `parameterValues` requirement in the evidence-context check | **7 / 50** — case K | **CAUGHT** |

**MU3 is the mutation the mandate asks for by name**, and it is the one that demonstrates a hole
rather than a diagnostic difference. Under it the independent probe reports:

```
[MU3 APPLIED]  *** AUTHORISED ***  soak: window 2 000 ms, caller bound 1 000 ms
[MU3 APPLIED]  *** AUTHORISED ***  soak: window 1 ms,     caller bound 0.5 ms
[MU3 APPLIED]  *** AUTHORISED ***  shadow_agreement: window 1 000 ms, caller bound 1 000 ms
[MU3 APPLIED]  *** AUTHORISED ***  soak: window 25 h, caller bound 24 h
               FAIL-OPEN x4

[restored]     refused [OBSERVATION_BOUND_NOT_THE_CALLERS]  × 4
               NO FAIL-OPEN: every attack refused
```

**Stated plainly, because the mandate asks that a mutation not be accepted for the wrong reason:**

- **MU1 and MU3 demonstrate the intended protection.** Under MU1 the register's 72 h stops being
  what is applied, and the tests that fail are precisely the ones that assert *"71 h is refused
  **as TOO_SHORT, naming 72h**"* and *"73 h passes"*. That distinction is load-bearing: under MU1
  a 71-hour window is still refused — as `OBSERVATION_WINDOW_REQUIRED`, because the caller states
  nothing and the bound resolves to nothing. **"Refused" is not evidence that the register was
  consulted; "refused for being 71 hours against 72" is**, and only the latter is asserted.
- **MU2 and MU4 are honestly weaker, and are reported as such.** Removing either leaves the system
  **fail-closed**: under MU2 a stated bound is ignored rather than honoured (the register still
  decides), and under MU4 an absent register yields no bound and the two windowed gates go red.
  What each removal loses is a *refusal that names the right thing* — the P15-C1 argument, which
  this module already makes for `requestedAtMs`: an operator told *"soak and shadow_agreement are
  not green"* goes to look at the release, when the defect is in their request. They are caught
  because the tests assert the code, and that is what those guards are for. Neither is claimed as
  the load-bearing protection; **MU3 is.**

---

## 33. Verification

### 33.1 Measured on the settled tree

```
$ npx jest --runInBand --forceExit                    (= npm test)
Test Suites: 160 passed, 160 total
Tests:       7112 passed, 7112 total
Snapshots:   0 total          Time: 317.261 s         exit 0

$ npm run gates                                                      exit 1
gate: tier-dependencies          PASS — 285 modules, 423 governed import edges
gate: parameter-register         PASS — 189 engine modules / 242 registered parameters
gate: tenets                     PASS — 282 modules
gate: identity-isolation         PASS — 16 modules
gate: reconstruction-equivalence PASS — 3 corpus decisions, byte for byte
gate: legacy-retirement          PASS — 4 retired modules absent, 340 files
gate: column-generation          PASS — NOT_REQUIRED
gate: composition-root           FAIL — 1: coordinator [LEADER_ONLY_NOT_COMPOSABLE, EXTERNAL, B1]

$ npm run release:gates                                              exit 1
source digest 72f943df83416c73…    16 green, 1 red, 7 not evaluated
RED            engine_decision_path_wired      BUILD           [B1]
NOT_EVALUATED  calibration_safety_derived      ORGANISATIONAL  [B8]
NOT_EVALUATED  invariants_enforced             PRODUCTION      [B-P]
NOT_EVALUATED  simulator_fidelity              PRODUCTION      [B-P]
NOT_EVALUATED  soak                            PRODUCTION      [B-P]
NOT_EVALUATED  shadow_agreement                PRODUCTION      [B-P]
NOT_EVALUATED  safety_case_assembled           ORGANISATIONAL  [B-O]
NOT_EVALUATED  rollback_rehearsed              ORGANISATIONAL  [B-O]
GREEN          model_check_capacity_1_2_3      SUITE   [NOT PROVEN — unchanged, B-M]
RELEASE: BLOCKED — 8 blocking gate(s) are not green.

$ node tools/gates/checkCalibration.js                               exit 1
FAIL — 39 blocking findings. 242 entries: 52 DERIVED, 152 PROVISIONAL, 38 UNCALIBRATED.
54 Safety-class.

$ node tools/simFidelity/validate.js                                 exit 1
7 models NOT_MEASURED, 6 safety-relevant. No study was supplied.

$ node tools/routing/b1Readiness.js                       OVERALL: BLOCKED (D1, D3, D8)
```

| | Part II baseline | Now | |
|---|---:|---:|---|
| Test suites / tests | 159 / 7 061 | **160 / 7 112** | +1 suite, +51 tests |
| Failures / skips | 0 / 0 | **0 / 0** | |
| Build gates | 7 PASS, 1 FAIL | **7 PASS, 1 FAIL** | identical; the one FAIL is B1 |
| Governed import edges | 422 | **423** | the one new edge is `cutover/stage → cutover/evidence`, same tier |
| `release:gates` | 16 / 1 / 7 | **16 / 1 / 7** | identical |
| `gate:calibration` | 39 findings | **39 findings** | identical |
| `sim:fidelity` | 7 NOT_MEASURED | **7 NOT_MEASURED** | identical |
| `routing:readiness` | BLOCKED | **BLOCKED** | identical |
| Live-PostgreSQL checks | 288 | **288** | identical |
| Source digest | `801ed1df…` (564) | `72f943df…` (565) | +1 file: the new suite |

### 33.2 Live PostgreSQL

Disposable **PostgreSQL 18.3**, port **55443**, `initdb` into the scratchpad from the installed
binaries. **Never Neon, never the user's 5432 cluster** — every harness refuses both by name, and
the cluster was created for this pass and destroyed after it. No production data was read or
written.

```
tables before: 0
APPLIED 27 migrations from empty      FAILED: (none)
tables after: 75  (74 application tables + _prisma_migrations)
```

| Harness | Checks |
|---|---|
| `tools/verify/phase15VersionInForce.js` | **19 / 19** |
| `tools/verify/phase15EvidenceBinding.js` — *fixture corrected this pass* | **17 / 17** |
| `tools/verify/phase15CurrentTree.js` | **32 / 32** |
| `tools/verify/phase15LiveDatabase.js` | **12 / 12** |
| `tools/verify/phase5ExpirySemantics.js` | **102 / 102** |
| `tools/verify/phase5LiveDatabase.js` | **106 / 106** |
| **total** | **288 / 288** |

`phase15EvidenceBinding.js` is the harness that carried the defect (`soak: DAY` against a
registered 72 h). It is 17/17 **against the register's real bound**, which is a stricter run than
its previous 17/17, not the same one.

**Does this path touch persistence?** `stage.authoriseEnable()` writes nothing — it returns an
authorisation. It reaches the database only through the audit event its action produces, and that
path was re-verified live: `phase15EvidenceBinding` (producer → `EVENT_TYPE` → the
`AuditEvent_event_type_known` CHECK constraint → persistence → readback → the staged controller)
and `phase15VersionInForce` group B (the observation window judged by `authoriseEnable` against
real rows) both drive the changed request contract.

### 33.3 The limit of the fix, stated rather than implied

**The register accessor is injected, and injection is a trust boundary this fix does not close.**
`evidence.js`'s own header gives the reason: *"no `src/engine/**` module reads the Config Service
directly, and this one must not become the first."* So a caller can still hand the authority an
accessor that answers `1` for `release.soak_duration` — and `1 hour` would then be the bound.

That is a **smaller and different** hole than the one closed, and the difference matters:

- the bound is no longer a number in a request; it is the answer the *configuration system* gives
  for a *registered parameter*, at the same trust level as `killSwitchState` and `releaseEvidence`;
- it is the identical boundary `tools/release/verdict.js:127` already uses, which Part II named as
  the reason *"the release table is not affected"*;
- a weakened accessor is a lie about the configuration, not an extra field — it would have to be
  written deliberately, and every fixture in the tree now injects `service.loadRegister()`, pinned
  by a test that the resolved values equal the register's own defaults.

Closing it completely would mean the engine module reading the Config Service, which §22 forbids,
or the register being compiled into `evidence.js`, which §22.1 forbids. **It is recorded as a
limit, not fixed, and it is not a permissive path any caller reaches today.**

---

## 34. What was NOT done

**No gate was weakened. No threshold moved. No `NOT_EVALUATED` was converted to `PASS`. No
external evidence was fabricated.**

Asserted, not promised: a test in the new suite pins that the bound the fix applies is exactly
`release.soak_duration × 1 h` and `cutover.shadow_agreement_window × 1 day` as the register holds
them, so a future change to either number fails the suite rather than passing silently.

### The other blockers were not artificially closed — explicitly

| | State after this pass | What this pass did to it |
|---|---|---|
| **B1** — no routing engine selected | **OPEN, EXTERNAL.** `gate:composition` FAIL, `engine_decision_path_wired` RED, `routing:readiness` BLOCKED | **Nothing.** No engine invented, selected, ranked or recommended |
| **B8** — 39 Safety-class parameters not DERIVED | **OPEN, EXTERNAL.** `gate:calibration` exit 1, 39 findings, byte-identical to arrival | **Nothing.** No value manufactured, promoted or defaulted. `release.soak_duration` is still **PROVISIONAL** and this pass did not promote it — it made the system *use* it, which is a different act |
| **B-P** — 4 PRODUCTION gates | **OPEN, OBSERVATION.** All four still `NOT_EVALUATED` | **Nothing.** No observation window was manufactured. The 14-day shadow window still cannot begin, because the shadow worker cannot compose (B1) |
| **B-O** — 3 ORGANISATIONAL gates | **OPEN, EVIDENCE.** All three still `NOT_EVALUATED` | **Nothing.** No attestation filed, no rehearsal recorded |
| **B-M** — `model_check_capacity_1_2_3` GREEN and NOT PROVEN | **OPEN (compute half).** The `[NOT PROVEN]` annotation is unchanged and still prints | **Nothing.** No TLC run was performed; `tla2tools.jar` is still not in the tree; the gate algebra is untouched |
| **X3** — no `TASK` timer producer | **OPEN, SPECIFICATION.** `phase15CurrentTree` G1 still reports **0** TASK-entity timers | **Nothing.** No §4.2 transition table invented |
| **B-P/B-O evidence** | — | Nothing in `docs/release-evidence.json` was edited by this pass |

**Cross-phase integrity.** `Backend/src/db`, `src/engine/{commitment,dispatch,domain,shard}` and
`prisma/schema.prisma` are untouched; `git status --porcelain` over them is empty. No migration was
added or edited. Phase 5's two harnesses pass 102/102 and 106/106 against a database built from
empty. Phases 0–14 own none of the ten files changed. **Phase 16 contamination: clean** —
`killSwitches.defaultState()` has **0** Tier 2 mechanisms live, `tierTwoAtShipState` returns
`{ ok: true, enabled: [] }`, and it still refuses a cutover with any Tier 2 mechanism live
including under `PURPOSE.REHEARSAL`, by test.

**Reachability, restated.** `stage.authoriseEnable()` still has **no production call site** —
re-derived by grep over `src/` and `server.js`, where every occurrence of the name is a comment.
P15-F1 was **latent**, exactly as Part II classified it, and it is closed on the principle pass 3
applied to P15-E3: *a fail-open on a path nobody reaches today is a fail-open waiting for the
caller that does.*

---

## 35. Closure

# P15-F1: **CLOSED**

Against the mandate's criteria, each answered:

| Criterion | |
|---|---|
| caller cannot weaken the authoritative observation requirement | **yes** — the field is refused outright; the bound is resolved from the register by the authority |
| missing/invalid authoritative data fails closed | **yes** — absent source → request refused by name; absent/invalid parameter → that gate inadmissible. No default, no zero, no unlimited |
| adversarial positive-small-value attacks fail | **yes** — 1 ms, 1 000 ms, 24 h, 72 h and 100 days all refused |
| mutation attack fails | **yes** — 4 / 4 caught, 0 survivors; MU3 restores the pre-fix source and the probe shows the fail-open return and then vanish |
| full suite passes | **yes** — 160 suites / 7 112 tests / 0 failures / 0 skips |
| existing release gates not weakened | **yes** — `release:gates` 16 / 1 / 7, identical to arrival; `gates` 7 PASS / 1 FAIL, identical |
| no threshold changed | **yes** — pinned by test against the register's own defaults |
| no `NOT_EVALUATED` converted to `PASS` | **yes** — all seven still `NOT_EVALUATED` |
| no external evidence fabricated | **yes** — no calibration value, no observation window, no attestation, no TLC run, no routing engine |

### Phase 15 is not closed. P15-F1 being closed does not close it.

# PHASE 15 — BLOCKED. PHASE 16 — NOT READY.

**Remaining blockers, precisely:**

| ID | Description | Class | Owner | Blocks Phase 16? |
|---|---|---|---|---|
| **B1** | No routing engine selected. `coordinator` and `shadow` cannot compose; `gate:composition` FAIL; `engine_decision_path_wired` RED | **EXTERNAL** | Ops + Commercial (D1), Product + Fleet Eng (D3), Ops (D8) | **Yes, absolutely** |
| **B8** | 39 Safety-class parameters not `DERIVED`; `gate:calibration` exit 1 | **EXTERNAL** | §22.4's calibration owner | Yes |
| **B-P** | 4 PRODUCTION gates `NOT_EVALUATED` — `invariants_enforced`, `simulator_fidelity`, `soak`, `shadow_agreement`. The 14-day shadow window cannot *begin* until B1 | **OBSERVATION** | needs an operating fleet | Yes |
| **B-O** | 3 ORGANISATIONAL gates `NOT_EVALUATED` — `calibration_safety_derived`, `safety_case_assembled`, `rollback_rehearsed` | **EVIDENCE** | named humans | Yes |
| **B-M** | `model_check_capacity_1_2_3` GREEN and NOT PROVEN — no exhaustive lifecycle check exists at any capacity, by either checker. Repository half closed in Part II; **compute half open** | **EVIDENCE (compute)** | Release owner + compute | Yes |
| **X3** | No `TASK` timer producer; §4.2 has no transition table | **SPECIFICATION** | frozen-spec owner | No |
| **X1** | §17.4 escalation ladder unimplemented | **FUTURE PHASE** | REMEDIAL PHASE T1-04 | No |

**In-repository, reported and not fixed** (carried forward unchanged, none permissive):
`app.locals.releaseEvidence` has no producer (P15-E6, fails closed); `blockers()` ignores
`unknownEvidence` (§7); pass 2's **X-C1** (Phase 12) and **X-C2** (unreachable);
and, new this pass, **the register accessor is injected** (§33.2).

**"In-repository: none remaining" is not claimed.** Pass 2 claimed it and pass 3 found six. Pass 3
claimed it and Part II found three. This pass closed the one item Part II left open and does not
extend that to a claim about the class — the claim has been wrong every time it has been made, and
the one honest thing to say is: *P15-F1 is closed; nothing here searched for its successor.*

---

**TRUTH > GREEN.**

# P15-F1 — CLOSED.  PHASE 15 — BLOCKED.

---
---

# PART IV — FINAL P15-F1 CLOSURE, EVIDENCE RECONCILIATION AND STOP-GATE

**Date:** 2026-08-29 · **Branch:** `feature/dashboard` · **Scope:** re-verify the P15-F1
remediation independently, reconcile the release evidence, classify the producer/consumer
composition honestly, and stop — or find a reason not to.

**Digest, arrival and closure (unchanged across this whole pass):**
`431010ace188c4b1b91415821e8cebc7beeb8f3f378a1b39fb77986fb3b22470` (565 files)

Nothing in `src/`, `tools/` or `tests/` was changed by this pass. One documentation file was
changed (§40), and `docs/` is outside the digest scope by `sourceDigest.js`'s own definition, so
the release collection below binds the same tree that arrived.

---

## 36. The release collection — one was discarded, and why

**The collection that was on disk at arrival passed every criterion the mandate lists and was
still not usable.** It is worth stating exactly, because "it met the stated criteria" was very
nearly enough to ship it:

| Mandate criterion | The arrival collection |
|---|---|
| tree unchanged during collection | **yes** — endpoints agreed, digest `431010ace…` |
| zero records VOID | **yes** — 0 of 17 |
| every record bound to the final digest | **yes** — 17 of 17 |
| no evidence manually edited | **yes** — sole producer `tools/release/collectEvidence.js` |
| no `NOT_EVALUATED` converted to `GREEN` | **yes** — all 7 still `NOT_EVALUATED` |
| no external evidence fabricated | **yes** |

And its verdict was **8 green, 9 red, 7 not evaluated**, against the clean collection's 16/1/7.
Eight gates were RED that are not red. Six carried exit code **3221225794** — `0xC0000142`,
Windows `STATUS_DLL_INIT_FAILED`: *the gate process never started*. The seventh,
`determinism_replay`, recorded `106 failed, 6601 passed` from a run whose `-- determinism` path
filter had not applied and which ran the whole engine project against a contended machine.

`npm test` passes **7 162 / 7 162** on that same tree. So those eight REDs were an artefact of
the collector competing for the process table, and the mandate's criteria cannot see it: every
one of them is about *provenance* and *binding*, and this was a failure of *execution*.

**Recorded as a gap in the criteria, not just as an incident.** A collection can be perfectly
bound, perfectly attributed, entirely un-edited, and still be evidence about a machine rather
than about a program. `collect()` already returns `ok: false` when any gate exits non-zero — the
information was there; nothing downstream distinguishes *"this gate is red"* from *"this gate
did not run"*. `0xC0000142` is not a gate verdict. That distinction has no representation in the
evidence schema today, and this pass does not add one — it is named here so the next collection
that reads strangely is diagnosed rather than believed.

**One fresh collection was then performed serially**, with nothing else running, per §1 of the
mandate. No source was modified during it.

## 37. Why the machine was contended — and what it means for this evidence

`ListAgents` reports **three other interactive Claude Code sessions live in this repository**
during this pass (`robotx-0e`, `robotx-11`, `robotx-e5`). That is the mundane explanation for
the `0xC0000142` failures, and it is also a standing hazard for every measurement in this
programme: **the tree is not under any one pass's exclusive control.**

Two consequences, both handled rather than assumed away:

- The digest was recomputed **after** every long-running step — the collection, the mutation
  attack, the live-database run — and is `431010ace188c4b1…` at each. The collector's own
  before/after endpoints agreed, which is what makes the 17 records non-VOID.
- One file *did* change under this pass, at 11:36, written by another session:
  `docs/runbooks/cutover.md`. It is outside the digest scope, so no evidence record is affected.
  It is dealt with on its merits in §40, **and its authorship is disclosed there** rather than
  absorbed into this pass's account of itself.

## 38. P15-F1 — final adversarial verification

Re-run **outside jest and outside the digest scope**, sharing no code with
`phase15ObservationAuthority.test.js`, deriving the authoritative requirement from the shipped
register rather than restating it.

```
register: release.soak_duration = 72 hours, cutover.shadow_agreement_window = 14 days
authority resolves: { shadow_agreement: 1209600000, soak: 259200000 } = 72 h, 14 d

CONTROL 1 — honest request authorised: true
CONTROL 2 — 73 h soak / 15 d shadow authorised: true
```

The controls come first because *a refusal from a fixture that could never be authorised proves
nothing*. Both pass, so every refusal below is a refusal of the attack and not of the fixture.

| # | Attack | Result |
|---|---|---|
| 1 | 1 ms caller bound | refused `OBSERVATION_BOUND_NOT_THE_CALLERS` |
| 2 | 1 second caller bound | refused `OBSERVATION_BOUND_NOT_THE_CALLERS` |
| 3 | 24 hour caller bound (against 72 h) | refused `OBSERVATION_BOUND_NOT_THE_CALLERS` |
| 4 | 0 | refused `OBSERVATION_BOUND_NOT_THE_CALLERS` |
| 5 | negative | refused `OBSERVATION_BOUND_NOT_THE_CALLERS` |
| 6 | `NaN` | refused `OBSERVATION_BOUND_NOT_THE_CALLERS` |
| 7 | `Infinity` | refused `OBSERVATION_BOUND_NOT_THE_CALLERS` |
| 8 | **omitted caller field** | refused `RELEASE_GATE_NOT_GREEN` → `shadow_agreement` + `soak`, both `OBSERVATION_WINDOW_TOO_SHORT`, naming **72h** |
| 9 | missing authoritative register | refused `EVIDENCE_CONTEXT_INCOMPLETE` |
| 10 | invalid authoritative register (`get` not a function) | refused `EVIDENCE_CONTEXT_INCOMPLETE` |
| 10b | register accessor throws | refused `PARAMETER_REGISTER_UNREADABLE` |
| 10c | register resolves nothing | refused → both gates `OBSERVATION_WINDOW_REQUIRED`, reported `(got undefined)`, **no fabricated zero** |
| 11 | oversized (100 days) | refused `OBSERVATION_BOUND_NOT_THE_CALLERS` |
| 11b | oversized (`Number.MAX_VALUE`) | refused `OBSERVATION_BOUND_NOT_THE_CALLERS` |
| 12a | caller states **exactly** the authoritative 72 h / 14 d | refused `OBSERVATION_BOUND_NOT_THE_CALLERS` |
| 12b | field present as `undefined` (the spread shape) | refused `OBSERVATION_BOUND_NOT_THE_CALLERS` |
| 12c | empty object | refused `OBSERVATION_BOUND_NOT_THE_CALLERS` |
| 13 | `Object.create({ soak: 1 })` — the field reached by prototype | refused `OBSERVATION_BOUND_NOT_THE_CALLERS` |

**Attack 8 is the one that proves the register was consulted.** "Refused" is not evidence of
that; *refused for being one second against seventy-two hours, by name* is. Attack 10c is the
producer-side half: the authority reports that nothing resolved rather than reporting a number
the register never gave.

**0 of the mandate's 12 attacks weaken the authoritative observation requirement.**

### 38.1 The one probe that is not refused, and why it is not a thirteenth attack

A **nineteenth** probe was added beyond the mandate's twelve: a caller who supplies a *lying
register* — an accessor answering `1` for `release.soak_duration` — together with a 2-hour soak
window. It is **authorised**.

That is not a new finding. It is §33.3's recorded limit, reproduced deliberately to confirm the
limit is where §33.3 says it is and no wider: the bound is now the answer *the configuration
system gives for a registered parameter*, at the same trust level as `killSwitchState` and
`releaseEvidence`, and closing it completely would require an `src/engine/**` module to read the
Config Service, which §22 forbids. **It is reported, not fixed, and not counted as a bypass of
the twelve.**

## 39. Mutation — 5 mutants, 5 killed, 0 survivors

Each protection removed from the shipped `stage.js`; the P15-F1 suite required to **fail**; the
file restored from an in-memory copy and **SHA-256 compared**; the suite required to pass again.
Baseline proven green before and after.

```
target sha256 BEFORE: b72ce3f6fea1669d1f792caad03cc8c3e04b096dde2551bcbb1ee30981242d4b
BASELINE  exit 0

MU1  KILLED   11/51 failing   the authoritative resolution — the applied bound reverts to `source.minObservationMs`
MU2  KILLED   18/51 failing   the guard refusing a caller-stated bound (`Object.hasOwn`)
MU3  KILLED   27/51 failing   BOTH — the exact pre-P15-F1 source: a caller-supplied bound, honoured
MU4  KILLED    7/51 failing   the `parameterValues` requirement in the evidence-context check
MU5  KILLED    1/51 failing   PRODUCER SIDE — the authority fabricates a zero bound for a parameter the register did not answer

BASELINE AFTER  exit 0
target sha256 AFTER : b72ce3f6fea1669d1f792caad03cc8c3e04b096dde2551bcbb1ee30981242d4b   identical: true
mutants: 5   killed: 5   survivors: 0
```

**MU5's count is the finding, not its verdict.** It is killed by **exactly one** test — the
regression added for it. Every other mutant is caught many times over; this one is caught once,
which means the producing side has a single point of failure in the suite and would have
**survived** before that test existed. It is recorded as a thin margin rather than as a pass.

MU2 and MU4 remain honestly weaker, as §32 already states: removing either leaves the system
fail-closed and loses a refusal that *names the right thing*. **MU3 is the load-bearing one**,
and it is the mutation the mandate names.

## 40. Producer / consumer composition — stated exactly

### `authoriseEnable()` has no production runtime caller. None was manufactured.

Re-derived on this tree, three independent ways:

- **grep over `src/` and `server.js`** — every occurrence of the name is a comment
  (`server.js:573`, `health.controller.js:294,333`, `cutover.worker.js:59,67`,
  `guardrails.js:35,302`, `rollbackPublisher.js:42,230`, `evidence.js` ×5, `gates.js:497`).
- **the two production modules that require `cutover/stage`** call something else:
  `health.controller.js:329` calls `cutoverStage.plan(shards)`; `cutover.worker.js:81` calls
  `stage.authoriseRollback(...)`.
- **no HTTP surface reaches it** — `src/routes/` exposes exactly one cutover path,
  `GET /health/cutover`, which is read-only and self-describes as `authoritative: false`.

### Classification: **OPERATOR/ENABLE SURFACE — NO PRODUCTION CALLER PRESENT**

**This is an intentionally external/operator surface. It is not a Phase-15 defect, and it is
not a later phase's debt.** The repository decides this itself; nothing here is inferred:

| Evidence | Where |
|---|---|
| the module names its own caller: *"the caller — the cutover worker **or an operator's tooling** — publishes the configuration binding"* | `stage.js` header |
| §22.3 forbids the automated caller: *"no automated process makes the change that raises risk"*, and the function **refuses `automated: true`** and refuses requester ≡ approver | `stage.js:503–516` |
| only a rollback may be published without a human | `rollbackPublisher.js:224–230` |
| the worker is written to call the rollback half **only**, and says so | `cutover.worker.js:59–67, 81` |
| the operator's tooling exists and is a **written procedure**, not code | `docs/runbooks/cutover.md` §3.2–3.3 |
| the composition gate's scope is *workers*, not every export — so this is outside it by design, not by omission | `checkCompositionRoot.js` header |

An in-repository production caller would be a process taking a shard live, which is the precise
act §22.3 prohibits. **A caller here would be the defect.** The honest statement is therefore
*not* "this is uncomposed and someone should compose it" but: **the enable half is exercised by
a human following a runbook, and the runbook is the artefact that must be correct.**

Which is where this pass found its one new defect.

### P15-F7 — the documented invocation could not authorise anything · **Medium (procedure)** · FIXED (documentation)

**`docs/runbooks/cutover.md` §3.2 is the only documented invocation of `authoriseEnable()` in
the repository** — it *is* the "operator's tooling" the module header names. Its code block
passed ten fields and stopped, omitting `sourceDigest` and `evidenceMaxAgeMs` (required since
P15-C1) and `parameterValues` (required since P15-F1).

**Reproduced, against an otherwise perfect, fully green fixture:**

```
RUNBOOK §3.2, AS WRITTEN — an operator copying the documented call
  authorised: false
  refusal:    EVIDENCE_CONTEXT_INCOMPLETE
    missing: `evidenceMaxAgeMs` — how stale a record may be and still describe this system
    missing: `sourceDigest` — the tree the build gates' run records must have run against
    missing: `parameterValues` — the authoritative parameter source … from which the minimum
             observation windows for shadow_agreement and soak are read

THE SAME CALL WITH THE REQUIRED FIELDS SUPPLIED
  authorised: true

DIRECTION: fail-closed (refused)
```

**The refusal is correct and nothing about the authority was changed.** The defect is in the
procedure: it asked an operator to make a call that cannot succeed. Same class and same
direction as **P15-E6**, which this document already fixed as documentation.

**The fix documents where the three values legitimately come from**, with an acquisition step
each rather than a suggested literal — `releaseEvidence` **read** from
`docs/release-evidence.json` (never authored), `sourceDigest` **computed from the tree** and
explicitly not copied out of the evidence file, `evidenceMaxAgeMs` declared to match the
verdict's bound, and `parameterValues` taken from `loadPinnedSnapshot()` — the configuration
**in force**, not the register's defaults.

**Every factual claim in that fix was checked against the code before it was allowed to stand:**

| Claim | Verified |
|---|---|
| `configService.loadPinnedSnapshot({ prisma, kv })` exists with that signature | `service.js:526–527` |
| `snapshot.resolve(name)` exists | `service.js:229` |
| `verdict.js` defaults to a 24 h bound, `--max-age-hours` overrides | `DEFAULT_MAX_AGE_HOURS = 24`, `verdict.js:66` |
| the evidence/attestation spread matches what `verdict.js` itself does | `verdict.js:101–104` |
| `docs/release-attestations.json` is absent today | `Backend/docs/` holds `release-evidence.json` only |
| `loadPinnedSnapshot()` returns `null` on a schema built from empty | **measured** on a virgin migrated database: 0 `ConfigVersion`, 0 `ConfigActiveVersion`, `null` |

**Authorship disclosed.** That runbook edit was written at 11:36 by **another Claude Code session
working concurrently in this repository** (§37), not by this pass. It is retained because the
defect it addresses is real and was reproduced here independently, and because every claim in it
verifies against the code — **not** because it was found in the tree. It is named as another
session's work rather than absorbed into this pass's account of itself.

**One divergence, reported and not fixed:** the runbook assembles evidence and attestations with
a plain spread, while `verdict.js:103–107` additionally detects gate-id **collisions** between
the two and forces the colliding gate RED. With `release-attestations.json` absent the two agree
today, and the runbook says to spread nothing when it is absent. It is recorded so the next
person to file an attestation knows the procedure is a shade more permissive than the tool.

## 41. Cross-phase integrity — Phases 0–14

**Every file modified in the working tree, with its owner:**

| File | Owner | Why it is modified |
|---|---|---|
| `Backend/tests/engine/phase15ObservationAuthority.test.js` | **Phase 15** | +47 lines: the MU5 producer-side regression (§39) |
| `Backend/docs/release-evidence.json` | **Phase 15** | regenerated by `collectEvidence.js` — sole producer, no hand edit |
| `Backend/src/engine/spatial/regionBoundary.js` | **B1 prerequisite** | R-2: `polygonsOverlap` — boundary contact is not shared area |
| `Backend/tools/routing/b1Readiness.js` | **B1 prerequisite** | A2–A7, R-1, R-3 |
| `Backend/tools/routing/adapters/contract.js` | **B1 prerequisite** | A8, R-3 |
| `Backend/tests/engine/spatialRegionBoundary.test.js` | **B1 prerequisite** | R-2 regressions |
| `Backend/tests/engine/routingB1Readiness.test.js` | **B1 prerequisite** | A2–A7, R-1, R-3 regressions |
| `Backend/tests/engine/routingB1Adapters.test.js` | **B1 prerequisite** | A8 regressions |
| `docs/runbooks/cutover.md` | **Phase 15** | P15-F7 (§40) — another session's edit, verified and disclosed |

**`regionBoundary.js` is the one file here that a Phase-2-era commit created, and it is not an
unrelated change.** The diff is confined to `boxesOverlap`, two new private helpers,
`polygonsOverlap`, `validateRegionsDisjoint` and the export list — the V-11 geometry B1's D1
assessment depends on, documented in full in `PHASE_15_B1_PREREQUISITE_ADVERSARIAL_PASS.md`
§R-2, with the contract derived from three statements already in the tree and a mutation (M-R2)
that kills the old behaviour across two suites. **No Phase-0–14 change is silently accepted
here; this one is named, attributed and justified.**

**Byte-identical to `HEAD`, verified by blob hash:**

| | |
|---|---|
| `prisma/schema.prisma` | `c039c40ae7146726cfd96870f58065be76092a69` — same |
| all 5 register files (`appendixA`, `cost`, `killSwitches`, `legacy`, `supplementary`) | same |
| `cutover/gates.js`, `cutover/evidence.js`, `cutover/stage.js` | same |
| `release/sourceDigest.js`, `release/verdict.js`, `release/collectEvidence.js` | same |
| `gates/checkCompositionRoot.js` | same |
| **27 migrations** | 0 modified, 0 added |

`git status --porcelain` over `Backend/src/db`, `src/engine/{commitment,dispatch,domain,shard}`
and `prisma/` is **empty**. **No gate definition, no threshold and no migration moved.**

## 42. Final measured results

All on the stable final tree at digest `431010ace188c4b1b91415821e8cebc7beeb8f3f378a1b39fb77986fb3b22470` (565 files).

```
$ npm test                                                                     exit 0
Test Suites: 160 passed, 160 total
Tests:       7162 passed, 7162 total
Snapshots:   0 total                    Time: 334.241 s

$ npm run gates                                                                exit 1
gate: tier-dependencies          PASS — 285 modules, 423 governed import edges
gate: parameter-register         PASS
gate: tenets                     PASS — 282 modules
gate: identity-isolation         PASS — 16 modules
gate: reconstruction-equivalence PASS — 3 corpus decisions, byte for byte
gate: legacy-retirement          PASS — 4 retired modules absent, 340 files
gate: column-generation          PASS — NOT_REQUIRED
gate: composition-root           FAIL — 1 of 18 workers: coordinator
                                        [LEADER_ONLY_NOT_COMPOSABLE] owner EXTERNAL — B1

$ npm run release:gates                            (clean serial collection)   exit 1
source digest 431010ace188c4b1…    16 green, 1 red, 7 not evaluated
17 records, 0 VOID, 17/17 bound to the final digest, 1 non-zero exit
  (engine_decision_path_wired, exit 1 — B1)
RELEASE: BLOCKED — 8 blocking gate(s) are not green.

$ node tools/routing/b1Readiness.js                                            exit 0
OVERALL: BLOCKED    D1 BLOCKED · D3 BLOCKED · D8 BLOCKED
Steps 1, 3, 4, 5 BLOCKED · Step 2 PASS
NO ENGINE IS SELECTED, RANKED OR RECOMMENDED

$ node tools/gates/checkCalibration.js                                         exit 1
FAIL — 39 blocking findings. 242 entries: 52 DERIVED, 152 PROVISIONAL,
38 UNCALIBRATED. 54 Safety-class.

$ node tools/simFidelity/validate.js                                           exit 1
7 models NOT_MEASURED, 6 safety-relevant. No study was supplied.

$ node tools/safetyCase/assemble.js                                            exit 0
12 hazards from 38 predicates and 22 invariants; every reference resolves.
release gates: 0 green, 0 red, 24 not evaluated   (the assembler files no evidence)
```

**Live PostgreSQL.** Disposable **PostgreSQL 18.3**, port **55437**, `initdb` into the scratchpad
from the installed binaries — never Neon, never the default 5432 cluster, both of which every
harness refuses by name. Schema applied with `prisma migrate deploy`: **27/27 migrations, 0
failed, 0 rolled back.**

| Harness | Result |
|---|---|
| `tools/verify/phase15LiveDatabase.js` | **12/12**, exit 0 |
| `tools/verify/phase15CurrentTree.js` | **32/32**, exit 0 |
| `tools/verify/phase15EvidenceBinding.js` | **17/17**, exit 0 |
| `tools/verify/phase15VersionInForce.js` | **19/19**, exit 0 |
| | **80/80** |

The cluster was created for this pass and destroyed after it. No production data was read or
written.

### 42.1 The §24 table, by status

| | Gates |
|---|---|
| **GREEN (16)** | `tier_dependencies`, `parameter_register`, `design_tenets`, `identity_isolation`, `erasure_reconstruction_equivalence`, `legacy_removed_from_build`, `lower_bound_admissibility`, `model_check_capacity_1_2_3` *(NOT PROVEN — B-M)*, `determinism_replay`, `snapshot_retention`, `chaos_capacity_1`, `chaos_capacity_2`, `cache_tier_flush`, `scale_targets`, `locality`, `overload_admission_control` |
| **RED (1)** | `engine_decision_path_wired` — B1 |
| **NOT_EVALUATED (7)** | `calibration_safety_derived` (B8) · `invariants_enforced`, `simulator_fidelity`, `soak`, `shadow_agreement` (B-P) · `safety_case_assembled`, `rollback_rehearsed` (B-O) |

**No `NOT_EVALUATED` was converted to `GREEN`.** All seven are the same seven.

## 43. Remaining blockers

| ID | Description | Class | Owner | State after this pass |
|---|---|---|---|---|
| **B1** | No routing engine selected. `coordinator` uncomposable; `gate:composition` FAIL; `engine_decision_path_wired` RED; `b1Readiness` OVERALL BLOCKED with D1, D3, D8 each BLOCKED and Steps 1/3/4/5 BLOCKED | **EXTERNAL** | Ops + Commercial (D1), Product + Fleet Eng (D3), Ops (D8) | **OPEN — unchanged.** No engine selected, ranked or recommended. No operating region, fleet-speed or extract-vintage data invented |
| **B8** | 39 Safety-class parameters not `DERIVED`; `gate:calibration` exit 1; 242 entries, 52 DERIVED / 152 PROVISIONAL / 38 UNCALIBRATED, 54 Safety-class | **EXTERNAL** | §22.4's calibration owner | **OPEN — unchanged.** `release.soak_duration` is still PROVISIONAL and was not promoted; P15-F1 made the system *use* it, which is a different act |
| **B-P** | 4 PRODUCTION gates `NOT_EVALUATED` — `invariants_enforced`, `simulator_fidelity`, `soak`, `shadow_agreement`. `sim:fidelity` reports 7 models NOT_MEASURED, 6 safety-relevant | **OBSERVATION** | needs an operating fleet | **OPEN — unchanged.** No observation window manufactured. The 14-day shadow window still cannot *begin*, because the shadow worker cannot compose (B1) |
| **B-O** | 3 ORGANISATIONAL gates `NOT_EVALUATED` — `calibration_safety_derived`, `safety_case_assembled`, `rollback_rehearsed` | **EVIDENCE** | named humans | **OPEN — unchanged.** No attestation filed, no rehearsal recorded. `safety:case` assembles and every reference resolves, which is not the same as the gate being discharged |
| **B-M** | `model_check_capacity_1_2_3` GREEN and **NOT PROVEN** — the `[NOT PROVEN]` annotation still prints in the verdict | **EVIDENCE (compute)** | Release owner + compute | **OPEN — unchanged.** No TLC run performed; `tla2tools.jar` still absent; gate algebra untouched |
| **X3** | No `TASK` timer producer; §4.2 has no transition table | **SPECIFICATION** | frozen-spec owner | **OPEN — unchanged.** `phase15CurrentTree` G1 still reports 0 TASK-entity timers |
| **A9** | `assertVersionInKey` implemented, exported, tested both directions, genuinely uncalled | **DEFERRED — Phase 8** | Phase 8 | **OPEN — correctly deferred.** No caller manufactured. It guards a Phase 8 seam (`src/engine/routing/client.js`) that does not exist; `read()` already carries a genuine independent cross-check that a self-built key could not provide |
| **X1** | §17.4 escalation ladder unimplemented | **FUTURE PHASE** | REMEDIAL PHASE T1-04 | OPEN — unchanged |

**In-repository, reported and not fixed** (carried forward, none permissive): the register
accessor is **injected** (§33.3, reproduced as probe 12d in §38.1); `app.locals.releaseEvidence`
has no producer (P15-E6, fails closed); `blockers()` ignores `unknownEvidence`; pass 2's X-C1 and
X-C2; the runbook/`verdict.js` attestation-collision divergence (§40); and, new here, the
evidence schema cannot distinguish *a gate that failed* from *a gate that never ran* (§36).

## 44. What this pass did NOT do

**No gate was weakened. No threshold moved. No `NOT_EVALUATED` was converted to `GREEN`. No
external evidence was fabricated. No engine was selected. No D1/D3/D8 value was invented. No
implementation source was changed.**

The only file this pass altered is a runbook, outside the digest scope, and its authorship is
disclosed in §40. `src/`, `tools/` and `tests/` are byte-identical at arrival and at closure —
digest `431010ace188c4b1…` at both ends, and again after the mutation attack restored.

## 45. Closure

# P15-F1 — CLOSED

| Stop-gate condition | |
|---|---|
| P15-F1 is closed | **yes** — 0 of 12 mandated attacks weaken the requirement; the authority resolves the bound from the register and refuses a caller who states one, in both directions |
| no new Phase-15-owned defect exists | **no — one was found**, P15-F7 (§40), and it is **fixed**: the only documented invocation of `authoriseEnable()` could not authorise anything. Fail-closed, procedure-class, documentation-only fix |
| mutation testing passes | **yes** — 5 / 5 killed, 0 survivors, tree restored SHA-256-identical. MU5's single-test margin is recorded as thin |
| full suite passes | **yes** — 160 suites / 7 162 tests / 0 failures / 0 skips |
| gates remain honest | **yes** — `gates` 7 PASS / 1 FAIL (B1); `release:gates` 16 / 1 / 7, BLOCKED; the arrival collection was **discarded** rather than reported, and why is in §36 |
| release evidence is digest-bound | **yes** — 17 records, 0 VOID, 17 / 17 bound to `431010ace188c4b1…`, sole producer `collectEvidence.js` |
| B1 remains correctly external | **yes** — OVERALL BLOCKED, D1/D3/D8 BLOCKED, no engine selected, ranked or recommended |

# PHASE 15 IMPLEMENTATION — CLOSED

# RELEASE / PHASE 16 — BLOCKED BY EXTERNAL PREREQUISITES

Phase 15's implementation obligations are discharged: the cutover authority, its evidence
binding, its observation-window authority, its rollback publisher and its configuration
propagation are implemented, adversarially attacked, mutation-tested and verified against a live
database. What remains open is **not code**. B1, B8, B-P, B-O and B-M each require a decision, a
measurement, an attestation or a compute run that no commit in this repository can supply.

**"In-repository: none remaining" is still not claimed.** Every pass that has claimed it has been
wrong — pass 2 claimed it and pass 3 found six; pass 3 claimed it and Part II found three; Part
III closed Part II's item and this pass found P15-F7 in the procedure half nobody had executed.
The honest statement is the narrow one: **P15-F1 is closed, P15-F7 is closed, and this pass
searched the composition surface rather than the whole system.**

---

**TRUTH > GREEN.**

# PHASE 15 IMPLEMENTATION — CLOSED.  RELEASE / PHASE 16 — BLOCKED BY EXTERNAL PREREQUISITES.

---
---

# PART V — ADDENDUM TO PART IV: THE BEFORE REPRODUCTION, AND TWO CORRECTIONS TO THE RECORD

**Date:** 2026-08-29 · **Branch:** `feature/dashboard` · **Base commit:** `9cf6fb3`
**Digest:** `431010ace188c4b1b91415821e8cebc7beeb8f3f378a1b39fb77986fb3b22470` (565 files) — the
same tree Part IV measured.

> **Why this is an addendum and not a fifth pass.** Part IV and this work were carried out
> **concurrently by two different sessions on the same tree**, without either knowing the other
> was writing until both had finished. Part IV names the hazard itself (§37: *"the tree is not
> under any one pass's exclusive control"*), and it is the reason this section exists in the form
> it does: an earlier draft of this material was appended as a **second** "PART IV" with colliding
> section numbers, and was withdrawn intact rather than left to overwrite the first.
>
> **Part IV's findings and this pass's agree on every measured value** — digest, 7 162 tests,
> 16/1/7, `gates` 7 PASS / 1 FAIL, B1 BLOCKED, and the four live-database harnesses at 17/17,
> 12/12, 19/19 and 32/32. None of that is restated here. What follows is only what this pass
> measured that Part IV did not, and two places where the record needs correcting.

---

## 46. The BEFORE reproduction — the fail-open, executed

**Part IV verifies the fix; it does not reproduce the defect.** Its §38 runs nineteen attacks
against the current tree and records that all are refused, which establishes that the authority is
closed *now*. The mandate asks for something stricter — *"Do not call the defect fixed until the
vulnerable behaviour is reproduced"* — and this pass did that, because a suite of refusals cannot
distinguish a fix from a path that was never open.

A **pre-fix variant** of the shipped `stage.js` was generated by cutting exactly the three
fragments the fix consists of, and nothing else (`git diff` against the shipped file: **1
insertion, 20 deletions**):

```
-  if (Object.hasOwn(source, "minObservationMs")) { … OBSERVATION_BOUND_NOT_THE_CALLERS … }
-  if (!source.parameterValues || typeof source.parameterValues.get !== "function") { … }
-    minObservationMs = evidence.resolveMinObservationMs(source.parameterValues);
+    minObservationMs = source.minObservationMs;
```

The probe harness shares no code with `tests/` or with Part IV's: its evidence table is generated
row by row from `gates.RELEASE_GATES`, and its parameter source is
`configService.loadRegister({ reload: true })`. Each of the mandate's twelve cases was run three
ways — against a **1-second** observed window, against a window **exactly as long as the bound the
caller stated**, and against an **honest 72 h / 14 d** window as a control.

| | caller states | **pre-fix authority** | current tree |
|---|---|---|---|
| **A** | 1 ms | **AUTHORISED — production cutover on a 1-second soak** | refused `OBSERVATION_BOUND_NOT_THE_CALLERS` |
| **B** | 1 s | **AUTHORISED — production cutover on a 1-second soak** | refused, same code |
| **C** | 24 h | **AUTHORISED on a 24-hour window, against a 72-hour register** | refused, same code |
| **I** | *omits the field* | refused — **no bound ever resolved**, even on an honest 72 h / 14 d window | **AUTHORISED** on 72 h / 14 d |
| **L** | 999 days | **refused an honest 72 h / 14 d window** | refused, same code |

```
BEFORE  probes weakening the requirement: 3 of 12
AFTER   probes weakening the requirement: 0 of 12
```

**Three readings, each of which the AFTER-only table cannot yield.**

- **C is the shipped shape of the attack, not a contrived one.** 24 hours is exactly what
  `tools/verify/phase15EvidenceBinding.js` was passing (`soak: DAY`) while reporting 17/17 green —
  a soak gate judged at one third of its requirement, inside the harness whose purpose is to
  verify the authority.
- **L is the proof the register was never consulted.** A caller-supplied *larger* bound refused a
  window the register would have accepted. An implementation that took the stricter of the two
  would have authorised it. The caller's number was not compared against the requirement; it *was*
  the requirement — which is why refusing the larger direction is not excess caution but the same
  defect.
- **I is the proof the fix is live rather than vacuous.** Pre-fix, omitting the field refused
  everything, because nothing resolved a bound. On the current tree the identical request is
  authorised. Part IV's attack 8 establishes the same thing from the other side — refused *for
  being one second against seventy-two hours* — and the two together are what separate "the
  register is read" from "everything is refused".

---

## 47. Correction 1 — the producer-side mutant was **observed** surviving, not inferred

Part IV §39 records MU5 (*"the authority fabricates a zero bound for a parameter the register did
not answer"*) as **KILLED, 1/51 failing**, and adds, correctly, that it *"would have **survived**
before that test existed."*

**It did survive, and this pass watched it happen.** The mutation attack here was run *before* the
regression test was written:

```
MUTANT missingDefaultsZero: *** SURVIVED *** (exit 0) — Tests: 239 passed, 239 total
```

`{ soak: 0, shadow_agreement: 0, ...resolveMinObservationMs(…) }` passed the entire P15-F1 suite.
It was caught only by the consuming-side guard at `evidence.js:535`, which independently refuses a
bound of zero — re-run through the §46 probe harness the mutant weakens **0 of 12**, so it opened
no permissive path and did not re-open P15-F1. But nothing on the **producing** side stood against
it, which is the same producer/consumer asymmetry this programme has now found four times
(P15-C1's age bound, P15-E4's zero bound, P15-F1 itself) — and in each previous instance the
saving guard did not yet exist. `evidence.js:535` is itself only as old as P15-E4.

The distinction matters because Part IV's *"would have survived"* is an inference from a failure
count, and this is a measurement. A suite that catches a mutant once catches it by one test; a
suite that lets it through catches it by none, and only running the attack in that order tells
them apart.

**One honesty note on the fix for it.** The first version of that regression test asserted that a
register holding `0` would be reported as `(got 0)`, distinguishing *invalid* from *missing*. It
failed. `resolveMinObservationMs` **omits** a zero exactly as it omits an absent parameter, so
both report `(got undefined)`; missing and invalid are deliberately merged at the producer because
both mean the same thing to the decision. The test was corrected to the tree's actual behaviour
rather than the behaviour being changed to suit the test, and the assertion that survives is the
one that matters: the authority never reports a bound the register did not state.

Counting the two attacks together — Part IV's five and this pass's six — the union is **seven
distinct mutants, all killed**, and one of them is on record as having survived a full suite
first.

---

## 48. Correction 2 — the regression test's authorship

Part IV states, accurately for itself, that *"Nothing in `src/`, `tools/` or `tests/` was changed
by this pass"*, and its §39 refers to MU5 being killed by *"the regression added for it"*. A
reader would reasonably take that test to have been present at arrival. **It was not.**

`Backend/tests/engine/phase15ObservationAuthority.test.js` is **+47 / −0** in the working tree,
and that change was written by **this** pass, during Part IV's, in response to §47's surviving
mutant. It is the reason Part IV's suite counts 51 tests rather than 50, and the reason its MU5 is
recorded as killed rather than as a survivor.

**That is the complete change set of this pass.** No production source was modified: `git diff` is
empty over `Backend/src/engine/cutover/`, `Backend/tools/release/`, `Backend/prisma/` and
`Backend/src/engine/config/register/`, and the mutation attack restored `stage.js` byte-for-byte
(`sha256 b72ce3f6fea1669d1f792caad03cc8c3e04b096dde2551bcbb1ee30981242d4b` before and after —
the same value Part IV §39 records).

The test is named *"an unresolvable parameter yields no bound — the authority never fabricates a
zero"*. It runs through `stage.authoriseEnable` — the real authority boundary, not the helper —
with one parameter source answering `undefined` and one answering `0`, and requires both to fail
closed on exactly the two windowed gates **and** neither to report a bound the register never
gave.

---

## 49. What this addendum does not change

**Every conclusion in Part IV stands.** P15-F1 is closed; P15-F7 is closed; `authoriseEnable()`
has no production runtime caller and none was manufactured; B1, B8, B-P, B-O and B-M are
unresolved and external; no `NOT_EVALUATED` became `GREEN`; no threshold moved; no evidence was
fabricated. This pass re-derived each of those independently and reached the same answer.

**Nor does it claim the in-repository defect class is empty.** Two sessions attacked this one
function on the same day and between them produced seven mutants, one survivor, one BEFORE
reproduction and one documentation defect. The honest statement remains the narrow one: *P15-F1 is
closed, and the coverage that closes it is one mutant stronger than either pass alone made it.*

---

**TRUTH > GREEN.**

# P15-F1 — CLOSED (reproduced, re-attacked, mutation-killed).
# PHASE 15 IMPLEMENTATION — CLOSED.  RELEASE / PHASE 16 — BLOCKED BY EXTERNAL PREREQUISITES.

---
---

# PART VI — THIRD CONCURRENT SESSION: ONE MUTANT, ONE FIX, ONE STRUCTURAL GAP

**Date:** 2026-08-29 · **Branch:** `feature/dashboard` · **Digest, arrival and closure:**
`431010ace188c4b1b91415821e8cebc7beeb8f3f378a1b39fb77986fb3b22470` (565 files)

> **Disclosure first, because it is the context for everything below.** This is a **third**
> session that worked the same mandate concurrently with Parts IV and V, on the same tree, none
> of the three aware of the others until their writes collided. It is the session that wrote the
> `docs/runbooks/cutover.md` fix at 11:36 which Part IV §40 assesses and attributes.
>
> Its findings were **first appended as a second "PART IV"** with section numbers colliding with
> the existing one, and were **withdrawn intact** — the first PART IV was restored byte-for-byte
> before anything else was written. What follows is only the residue: the four things this
> session measured that Parts IV and V did not. **Everything else it produced was independently
> covered by them, and in two places covered better** (§53).
>
> **It agrees with Parts IV and V on every shared measurement** — digest, 160 suites / 7 162
> tests / 0 failures, `gates` 7 PASS / 1 FAIL, `release:gates` 16 / 1 / 7 BLOCKED, 17 records /
> 0 VOID / 17 bound, B1 BLOCKED on D1/D3/D8, P15-F1 closed, P15-F7 closed. None of that is
> restated.

---

## 50. An eighth distinct mutant — the producer helper, not the authority

Part V counts the union of Parts IV and V at **seven distinct mutants, all killed**. This
session's attack ran six, five of which are Part IV's MU1–MU5 under the same names. The sixth is
not in either union:

| | Protection removed | Result |
|---|---|---|
| **MU6** | `evidence.resolveMinObservationMs` — the filter `Number.isFinite(value) && value > 0` relaxed to `typeof value === "number"`, so a register answering `0`, `NaN` or `−1` yields a **bound** instead of being omitted | **KILLED — 2 / 51** |

Every other mutant in this programme's P15-F1 attacks has been on `stage.js`, the authority.
MU6 is on the **helper the authority delegates to**, and it targets a different requirement:
not *"the caller may not state the bound"* but *"an invalid authoritative value fails closed."*
Under it the register's own bad answer becomes the requirement — a `0` in the register would
mean *"any window discharges soak"* rather than *"soak cannot be judged."*

It is killed, and killed by the two attacks that assert the register's answer is *validated* and
not merely *read*. **The union across all three sessions is therefore eight distinct mutants,
eight killed, one of them observed surviving first** (Part V §47).

Tree restored: `stage.js` and `evidence.js` byte-identical by sha256, digest back to
`431010ace188c4b1…` — measured after the attack, not assumed.

---

## 51. P15-F7a — nothing binds a runbook to the API it documents · **reported, NOT fixed**

P15-F7 is fixed. The reason it was *possible* is not, and it is structural rather than
incidental.

`tools/release/sourceDigest.js` excludes documentation from the digest scope, deliberately:

> *"Documentation is deliberately outside it: a gate's verdict must not change because a runbook
> was reworded, and a digest that moved on every prose edit would train its readers to re-collect
> evidence without reading why."*

That reasoning is sound and this session does not propose changing it. But the same property
means **no gate anywhere binds a runbook to the signature it documents.** §3.2 drifted through
two contract changes — `sourceDigest` and `evidenceMaxAgeMs` at P15-C1, `parameterValues` at
P15-F1 — and every build gate stayed green across both. P15-F7 is the first *measured* instance
of that gap; it is not evidence that it is the only one.

**Not fixed, and the reasons are given rather than implied.** Putting `docs/` in the digest would
make every prose edit void a ~25-minute evidence collection, which is precisely the behaviour the
exclusion exists to prevent. A bespoke doc/API linter is a new gate, and this session has neither
a mandate to add one nor any evidence it would be maintained — an unmaintained gate that parses
prose is a future false green. It is recorded so the next pass inherits a named gap instead of
rediscovering it through a second broken procedure.

**The exposure this leaves, stated plainly:** `docs/runbooks/rollback.md` documents the other
half of the same subsystem and has had no equivalent execution check applied to it by any pass.
Nobody has run its procedure against the current API. That is not a finding — it is an
unexamined surface, and naming it is the honest alternative to implying the runbook class is now
clean because one file in it was fixed.

---

## 52. The evidence/attestation collision — Part IV reported it; it is now fixed

Part IV §40 closes with a divergence it found in the runbook fix and recorded rather than
corrected:

> *"the runbook assembles evidence and attestations with a plain spread, while `verdict.js:103–107`
> additionally detects gate-id **collisions** between the two and forces the colliding gate RED …
> the procedure is a shade more permissive than the tool."*

**That was a real defect in the fix, found by a reader of it and not by its author.** A build
record and an attestation filed for the same gate is a contradiction, and under a plain spread
the attestation — the human-authored half — silently wins. The runbook now does what the tool
does:

```js
const collisions = Object.keys(fromAttestations).filter((id) => Object.hasOwn(fromEvidence, id));
const releaseEvidence = { ...fromEvidence, ...fromAttestations };
for (const id of collisions) {
  releaseEvidence[id] = { gateId: id, producer: "collision", producedAtMs: Date.now(), pass: false };
}
```

Verified against `verdict.js`'s own merge on three scenarios — no attestations file (today's
state), attestations with no overlap, and a genuine collision — **identical output on all three**,
the colliding gate forced `pass: false`, and the old plain spread confirmed to have let the
attestation win. The procedure is no longer more permissive than the tool whose verdict it acts
on.

This is documentation-only. The digest is unchanged and the §40.5 / Part IV §36 collection
remains bound to the tree it was taken against.

---

## 53. Where Parts IV and V were better, and the live-database delta

**Recorded because a third account of the same work is only worth keeping if it is honest about
being third.**

- **Authorship of the regression test.** This session inferred from `git status` that
  `phase15ObservationAuthority.test.js` arrived modified from *"the preceding B1 prerequisite
  pass"* and had drafted that into its account. **That was wrong.** Part V §48 establishes it was
  written by the Part V session during Part IV's run. The incorrect attribution was never
  published; it is recorded here because the inference was reasonable and still false, and a
  concurrent tree makes `git status` a poor witness to authorship.
- **The BEFORE reproduction.** This session verified the fix; Part V §46 *reproduced the defect*,
  which is strictly stronger and is what the mandate asked for.
- **The arrival collection's diagnosis.** This session identified the contamination as
  concurrency and voided it. Part IV §36 went further and decoded the exit code —
  `3221225794` = `0xC0000142` `STATUS_DLL_INIT_FAILED`, *the gate process never started* — and
  named the resulting gap in the mandate's own acceptance criteria, which are all about
  provenance and cannot see a failure of execution.

**The one measured delta:** Part IV §45 records the four Phase-15 live harnesses (19/19, 17/17,
32/32, 12/12 = 80 checks). This session also re-ran Phase 5's two against a cluster built from
empty for this pass:

```
Disposable PostgreSQL 18.3, port 55444, initdb into the scratchpad, destroyed after.
Never Neon, never the user's 5432 cluster.
tables before: 0   →   27 migrations applied from empty, 0 failed   →   74 tables

tools/verify/phase5ExpirySemantics.js    102 / 102
tools/verify/phase5LiveDatabase.js       106 / 106
                          Phase 15 (4)    80 /  80
                                 total   288 / 288
```

**288 / 288**, which is the figure §33.2 records and confirms Phase 5's contracts are undisturbed
by everything three sessions did to this tree today.

---

## 54. Closure — this part changes no verdict

**Every conclusion of Parts IV and V stands, and this session reached each of them
independently.** P15-F1 is closed; P15-F7 is closed and its fix is now one defect better than it
was; `authoriseEnable()` has no production caller and none was manufactured; B1, B8, B-P, B-O and
B-M are unresolved and external; no `NOT_EVALUATED` became `GREEN`; no threshold moved; no
evidence was fabricated; Phases 0–14, the schema and the migration history are untouched.

**What this part adds is one mutant, one fix and one named gap** — not a new verdict.

**And the thing three concurrent passes over one function on one day actually demonstrates:** the
in-repository defect class is not empty, and the reason it keeps not being empty is that each
pass searches the surface the previous one's fix created. Part III's P15-F1 fix created the
`parameterValues` requirement; P15-F7 is the runbook not knowing about it; §51 is the absence of
anything that would have told it. **"In-repository: none remaining" is still not claimed, and on
today's evidence it should stop being claimed at all.**

---

**TRUTH > GREEN.**

# P15-F1 — CLOSED.  P15-F7 — CLOSED (fix corrected, §52).
# PHASE 15 IMPLEMENTATION — CLOSED.  RELEASE / PHASE 16 — BLOCKED BY EXTERNAL PREREQUISITES.

