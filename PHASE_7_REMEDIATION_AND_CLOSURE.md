# Phase 7 — Remediation and Closure

**Role:** Principal Safety Engineer / Distributed-Systems Engineer / Independent Software
Verification Engineer
**Date:** 2026-08-18 · **Branch:** `feature/dashboard` · **Working tree at closure:** `63f5c58`
+ the pre-existing uncommitted work described in §2.2 + the four files listed in §3
**Subject:** `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` §14 (Battery and Energy Strategy) and §15
(Payload Strategy), against `IMPLEMENTATION_EXECUTION_PLAN.md` §3 "PHASE 7" and its 21-item
checklist.

**Authority order used throughout:** the frozen specification first, then
`IMPLEMENTATION_EXECUTION_PLAN.md`, then the repository, then
`PHASE_7_INDEPENDENT_VERIFICATION.md`, then `PHASE_7_IMPLEMENTATION_REPORT.md`. Where a report and
the specification disagreed, the specification won. No frozen document, no ADR, no `TIERS.md`, and
no Safety-class parameter was modified.

---

## 1. Final status

# PHASE 7 CLOSED

Phase 7's own deliverable — the nine energy modules, the five payload modules, the
charger-reachability cache, the six database tables, and the twelve registered parameters — is
complete, unchanged since it was independently verified, and now verified further by three things
the original review could not do: a **live PostgreSQL 18.3 database**, a **producer/predicate
divergence probe**, and **execution** rather than field-name comparison.

One real defect was found during this closure, on the permissive side of a class **R** safety
boundary, which two prior reviews had seen and both classified as benign. It is fixed, covered by
six regression tests, and re-verified. One issue is **DEFERRED** with a named owner: the V9
combined-conservatism block, which this closure establishes is not a Phase 7 defect at all but an
internal inconsistency in the frozen specification's own Appendix A default table, and which no
implementation phase has the authority to resolve.

This is `CLOSED` rather than `CLOSED WITH LIMITATIONS` because every limitation the two Phase 7
reports recorded has been either resolved (live database), correctly re-classified with evidence
(V9, Phase 0), or is a *deployment* fact about a phase that is deliberately unwired (§12).

---

## 2. Starting state

### 2.1 What the independent verification concluded

`PHASE_7_INDEPENDENT_VERIFICATION.md` (2026-08-04) returned:

> **PASS WITH MINOR ISSUES** — 21 of 21 checklist items pass.

with four issues, reproduced here verbatim in substance:

| # | Issue as recorded | Severity as recorded |
|---|---|---|
| 1 | `F26` reads `item.requiredLockClass`, which no Phase 6 or Phase 7 producer populates, leaving one of its two security branches permanently unreachable | LOW, informational, newly found by that review |
| 2 | The seeded parameter register cannot publish — V9 blocks on combined degraded energy conservatism 2.0125 against a cap of 1.6 | Informational, already disclosed |
| 3 | The migration has not been applied to a live database; no PostgreSQL was reachable | Informational, not a defect |
| 4 | `PHASE_0_INDEPENDENT_VERIFICATION.md` still does not exist | Informational |

Its verified test state was `3/3` gates, `40/1561` engine, `3/49` gates lane, `22/169` legacy —
**1 779 tests, 0 failures** — and it recorded that Phase 8 was absent and "Phase 8 may begin."

### 2.2 The most important thing about that report: **it is two weeks stale**

This closure states this before anything else, because every number and one whole finding in the
verification report is measured against a tree that no longer exists.

`PHASE_7_INDEPENDENT_VERIFICATION.md` was written on **2026-08-04** against a working tree holding
Phases 0–7. The repository today holds **Phases 0–15**. Reproduced directly:

```
$ npm run gates                        # the verification recorded "3 gates"
  gate: tier-dependencies    PASS — 277 module(s), 387 governed import edge(s)     (report: 185 / 178)
  gate: parameter-register   PASS — 183 engine module(s) / 242 parameter(s)        (report: 108 / 172)
  gate: tenets               PASS — 274 module(s) checked                          (report: 182)
  gate: identity-isolation   PASS
  gate: erasure              PASS
  gate: legacy-retirement    PASS
  gate: column-generation    PASS — NOT_REQUIRED for this change set
                             7 of 7 gates PASS, not 3 of 3

$ ls Backend/src/engine/plan Backend/src/engine/solve Backend/src/engine/candidates
  column.js columnBuilder.js insertion.js planBuilder.js timeline.js
  budgets.js cadence.js costScaling.js minCostFlow.js objective.js regime.js round.js
  admissibilityGate.js availabilityIndex.js clusterShare.js expansion.js lowerBound.js omega.js ordering.js
```

**Phase 8 is not absent; it is implemented, along with Phases 9–15.** The instruction governing this
task — "the following should remain absent unless they already existed as earlier-phase
infrastructure" — is answered honestly here rather than by pretending otherwise: `plan/`, `solve/`,
`pricing/`, `candidates/` and ten of the twelve `cost/` modules exist **because Phases 8–15 were
implemented after Phase 7's verification was written**, and are recorded in
`PHASE_8_IMPLEMENTATION_REPORT.md` through `PHASE_15_INDEPENDENT_VERIFICATION.md`. This closure
implemented none of it, changed none of it, and §8 gives the evidence for that claim rather than
asserting it.

The practical consequence for Phase 7 is *favourable*: three of the seven Phase 7-dependent
predicates now have a second, real downstream consumer (`plan/planBuilder.js`), and the one Phase 8
module that carries Phase 7 output — `planBuilder.js:417`, `compartmentLoads: packed.compartmentLoads
|| []` — was checked and is a pass-through of `payload/packing.js`'s own output, not a second,
divergent producer.

**Phase 7's own 15 modules are committed at `cbe540e` and are byte-identical in the working tree:**

```
$ git diff --stat -- Backend/src/engine/energy Backend/src/engine/payload \
                     Backend/src/engine/routing/chargerReachabilityCache.js \
                     Backend/prisma/migrations/20260804180000_energy_and_payload_models
(no output — unchanged)
```

So Phase 7's deliverable is exactly the artefact that was verified. What changed around it is later
phases, and what this closure changed is listed in §3 and nothing else.

### 2.3 Pre-existing uncommitted work, left alone

`git status` at the start of this task showed 32 modified and 7 untracked paths, all of which
pre-date it: Phases 3–6's report addenda, the Phase 4/5/6 closure records, Phase 6's `f34.js` fix and
its `rejection_aggregate_nulls_not_distinct` migration, `tools/verify/`'s seven earlier harnesses,
`ROBOTX_SYSTEM_HANDBOOK.md`, and unrelated frontend/service edits. **None was reset, reverted,
stashed permanently, or reformatted.** The one `git stash` this closure performed was scoped to a
single file, used to capture before/after evidence in §4, and popped immediately; the full working
tree was re-listed afterwards and matched.

---

## 3. Files changed by this closure

| File | Change | Why | Frozen requirement | Defect | Test that proves it |
|---|---|---|---|---|---|
| `Backend/src/engine/feasibility/predicates/f26.js` | the dead `item.requiredLockClass` branch is replaced by the specification's own security-class ↔ lock-class compatibility check (20 insertions, 9 deletions, of which 14/3 are the doc comment) | F26 admitted a strict **superset** of what the container model admits, on a class R predicate — a permissive-direction divergence | §15.1, §15.2, §15.3 tier 1, §7.5 F26 | **R3** | `feasibilityPhase7Integration.test.js` → "§15.3 — F26 and the container model agree on security class ↔ lock class" (6 tests) |
| `Backend/tests/engine/feasibilityPhase7Integration.test.js` | +6 tests, +2 requires (26 → 32) | the seam had no test asserting the *direction* of F26's agreement with its producer | §15.3, §7.5 | R3 | itself |
| `Backend/tools/verify/phase7SecurityClassProbe.js` | **new** verification harness | reproduces R3 at verdict level across the whole class matrix, before and after | §15.3 | R3 | — |
| `Backend/tools/verify/phase7LiveDatabase.js` | **new** verification harness | the first live-database execution of Phase 7's schema in this programme | §14, §15, §9.6 | — | — |
| `Backend/tools/verify/phase7ClosureProbe.js` | **new** verification harness | re-derives the seven register rows, the INDETERMINATE⇒DENY direction, the no-trade asymmetry, α derivation, cache authority, and the V9 arithmetic by execution | §7.3, §7.5, §14.3, §14.5, §15.3, §3.3 I16 | — | — |
| `PHASE_7_IMPLEMENTATION_REPORT.md`, `PHASE_7_INDEPENDENT_VERIFICATION.md` | closure addendum **appended**; nothing removed, edited or rewritten | a reader arriving at either report must not act on "Phase 8 may begin", on the 1 779-test counts, or on Finding 1 as still open | — | — | — |
| `PHASE_7_REMEDIATION_AND_CLOSURE.md` | **new** — this record | — | — | — | — |

**No other file was touched.** In particular: no file under `src/engine/energy/`, `src/engine/payload/`,
`src/engine/routing/`, `src/engine/cost/`, `src/engine/plan/`, `src/engine/solve/`,
`src/engine/candidates/`, `src/engine/pricing/`; no migration; no `schema.prisma`; no register JSON;
no Safety-class parameter; no predicate other than `f26.js`; and neither historical Phase 7 report,
which are preserved unedited.

---

## 4. F26 disposition — **RESOLVED**

### 4.1 The question the brief asks, answered from the specification first

> Is `requiredLockClass` actually required by the Phase 7 payload model?

**No.** §15.1's task-side payload attribute table — the authoritative list of what an item declares —
contains exactly one security attribute:

> | Security class | Requires a lockable compartment, tamper evidence, or chain-of-custody |

There is no second, per-item lock-class declaration anywhere in §15, in §7.5's F26 row, or in
Appendix A. §15.2 gives the *compartment* a **lock class**; §15.1 gives the *item* a **security
class**; §15.3 tier 1 states the relation between them:

> thermal, hazard, and **security classes have a compatible compartment**

`requiredLockClass` is therefore a field with **no specification authority**, and adding it to
`payload/spec.js` would have duplicated security semantics — exactly what the brief forbids and what
§14.3 calls, in the adjacent case, "a defect, not extra safety". Option (B) is refused.

### 4.2 …but option (A) alone would have left F26 weaker than its producer

The verification report's finding is correct as far as it goes: the branch is dead, and no producer
sets the field. Its conclusion — "not a safety gap, because `container.satisfiesSecurityClass()`
already requires an exact match" — is also correct **about today's producer**, and this closure
independently re-confirmed the invariant it rests on by reading all three placement paths:

```
packing.tierOne   → container.admissibleCompartments()  (packing.js:256)
packing.tierTwo   → container.admissibleCompartments()  (packing.js:444)
packing.tierThree → container.admissibleCompartments()  (packing.js:477)
```

and `admissibleCompartments()` runs `satisfiesSecurityClass()` as one of its five checks
(`container.js:347`), which requires `compartment.lockClass === item.securityClass` exactly
(`container.js:259`).

What neither prior review asked is what **F26 itself** says once the dead branch is gone. With the
branch deleted and nothing put in its place, F26 reads:

> a security-classified item requires **a** lock class

while its producer reads:

> a security-classified item requires **its own** lock class.

F26 would then admit a strict superset of what the container model admits. That is the identical
structural hazard Phase 6's closure fixed as **R1** in F34, stated in that record as the property
worth having: *"the set of maps F34 accepts is a strict subset of the set `energy/tiers.js` accepts,
which is what makes 'F34 admits ⟹ the energy model agrees' hold structurally rather than
coincidentally."* A class **R** predicate — never overridable operationally, indeterminate policy
`DENY` — that is looser than the module whose output it checks is safe only for as long as that
module stays strict, and the entire purpose of the gate is that it does not have to trust it.

### 4.3 The divergence, reproduced at verdict level rather than argued

`tools/verify/phase7SecurityClassProbe.js` enumerates the full 4 × 4 security-class × lock-class
matrix and compares F26's outcome against `container.satisfiesSecurityClass()`'s.

```
$ git stash push -- Backend/src/engine/feasibility/predicates/f26.js
$ node tools/verify/phase7SecurityClassProbe.js          # against the pre-remediation f26.js

  FAIL  security=SEALED_LOCKER    lock=TAMPER_EVIDENT     — F26 admitted a placement the container model refuses
  FAIL  security=SEALED_LOCKER    lock=CHAIN_OF_CUSTODY   — F26 admitted a placement the container model refuses
  FAIL  security=TAMPER_EVIDENT   lock=SEALED_LOCKER      — F26 admitted a placement the container model refuses
  FAIL  security=TAMPER_EVIDENT   lock=CHAIN_OF_CUSTODY   — F26 admitted a placement the container model refuses
  FAIL  security=CHAIN_OF_CUSTODY lock=SEALED_LOCKER      — F26 admitted a placement the container model refuses
  FAIL  security=CHAIN_OF_CUSTODY lock=TAMPER_EVIDENT     — F26 admitted a placement the container model refuses
  20 passed, 12 failed.       (6 subset violations, each also counted as an agreement violation)

$ git stash pop
```

Six of the sixteen cells: **F26 returns `SATISFIED` — admitting the candidate — for a
security-classified item sitting in a compartment whose lock class is the wrong one.** Not
"unreachable"; reachable, and permissive, for any `plan.packing.compartmentLoads` that F26 did not
personally watch `payload/packing.js` build.

### 4.4 The change

The dead branch is replaced by the relation §15.3 tier 1 states, transcribed **independently** of
`container.satisfiesSecurityClass()` rather than imported from it — a predicate must not take its
rule from the module whose output it is checking, which is the same reason `f35.BASIS` is a second
transcription of `eReturn.BASIS` rather than an import. A test asserts the two agree.

The two refusals stay **distinguishable**, because "this compartment is not lockable" and "this
compartment has the wrong lock" are different operator instructions and §7.7 aggregates the reason:

| Case | Before | After |
|---|---|---|
| item unclassified, any compartment | SATISFIED | SATISFIED (unchanged) |
| item classified, compartment has no lock class | VIOLATED, `required.lockClass = "any"` | VIOLATED, `required.lockClass = "any"` (unchanged) |
| item classified, compartment lock class **matches** | SATISFIED | SATISFIED (unchanged) |
| item classified, compartment lock class **differs** | **SATISFIED** | **VIOLATED**, `required.lockClass = securityClass` |
| item declares `requiredLockClass` | branch unreachable | field no longer read |

**F26 is strictly stronger.** Its `SATISFIED` set shrank by exactly the six cells above and grew by
none; no case that previously denied now admits. No specification-authorised behaviour was removed:
the deleted branch honoured a field the specification does not define.

### 4.5 Fresh evidence

```
$ node tools/verify/phase7SecurityClassProbe.js          # after
  Subset property — F26 SATISFIED ⟹ the container model admits the placement     7/7 PASS
  Exact agreement — the two transcriptions decide every cell the same way        16/16 PASS
  Upstream — the real packing module refuses a mismatched pairing outright         3/3 PASS
  26 passed, 0 failed.
```

The last group matters as much as the first two: the change adds a **second, independent** barrier
rather than relocating the first. Driven through the real `payload/packing.js`, a matching security
class packs `FEASIBLE`, a mismatched one is `INFEASIBLE`, and an unclassified item packs.

### 4.6 Regression tests

Six, in `feasibilityPhase7Integration.test.js` — the Phase 6/7 seam suite:

1. a mismatched lock class is `VIOLATED`, with `required.lockClass` naming the item's own class;
2. a compartment with no lock class at all is `VIOLATED`, with `required.lockClass = "any"` — the
   two refusals remain distinguishable;
3. a matching lock class is `SATISFIED`, and an unclassified item needs no lock;
4. across the whole 4 × 4 matrix, **F26 `SATISFIED` ⟹ the container model admits it**, plus exact
   agreement in both directions and an explicit count of the admitted cells (7);
5. **no producer in the tree supplies a per-item required lock class** — `spec.normalise()` leaves
   `requiredLockClass` `undefined` and `spec.ATTRIBUTES` does not contain it, so a future
   reintroduction of the field fails the suite;
6. the **real** packing producer never places an item under a mismatched lock class, and the load it
   does produce is `SATISFIED` at F26.

Test 4 is the one that pins the direction. A future container model that *widened* compatibility —
a lattice of lock classes, say — would break the exact-agreement assertion while leaving the subset
assertion intact, which is the conservative direction for a class R gate and is stated as such in
the test's own comment.

### 4.7 Authority for changing a Phase 6 file

`f26.js` belongs to Phase 6, and Phase 6 is closed (2026-08-17). Three things authorise this change
rather than deferring it a third time:

1. **The task brief authorises it explicitly** — "remove the dead branch cleanly and update its
   tests/documentation" if the specification does not require the field, which §4.1 establishes it
   does not.
2. **Phase 6's closure declined it for reasons that no longer apply.** That record refused the
   change because it "fails on *which frozen requirement* and *which defect*". Both are now
   answered: the frozen requirement is §15.3 tier 1 and §15.1/§15.2; the defect is §4.3's six-cell
   permissive divergence, which that review did not look for because it accepted Phase 7's
   framing of the branch as merely dead.
3. **The payload model is Phase 7's**, and the relation being enforced is §15's. F26 is where the
   §15 rule meets the gate; deciding what "a security class has a compatible compartment" means is
   Phase 7 scope even though the file it lands in is Phase 6's.

**Final status: R3 FIXED and verified.**

---

## 5. V9 disposition — **DEFERRED / GOVERNED SAFETY DECISION**

**This is a deferral, not a fix. Nothing about V9 was resolved by this closure, and the register
still cannot publish.**

### 5.1 The arithmetic, re-derived from the current repository

```
$ node tools/verify/phase7ClosureProbe.js

  energy.charger_availability_margin     1.15   (nominal)
  energy.uncalibrated_reserve_factor     1.25   (nominal)
  energy.f_derate                        1      (nominal)
  route.degraded_reserve_factor          1.4    (degraded-only)

  nominal   = 1.4375                (published 1.4375)
  degraded  = 2.0124999999999997    (published 2.0124999999999997)
  cap       = 1.6

$ node -e '… config/service.validateCandidate({ enforceLaunchGate: true }) …'
  V9  BLOCKING  combined degraded energy conservatism 2.0124999999999997 exceeds
                energy.max_combined_conservatism 1.6 (nominal 1.4375 ×
                route.degraded_reserve_factor=1.4). Raising the cap is an explicit
                Safety-class decision …
```

Both products were re-multiplied by hand and matched the published values to within 1e-12. The
mechanism itself is `config/derived.js`'s `deriveCombinedConservatism()`, which walks the register
for entries carrying a `conservatism` declaration, keeps those in the energy domain, and computes
`nominal = ∏(activeInNominal)` and `degraded = nominal × ∏(degraded-only)`.

**One correction to both prior reports.** They quote the degraded product as including
`× degraded.reserve_factor=1`. On the current tree it does not: `degraded.reserve_factor`'s register
entry carries no `conservatism` declaration at all, so it is not a factor in this product. The
arithmetic is unchanged (it was the identity), but the implementation report's **option (c)** —
"reconsider whether `route.degraded_reserve_factor` and `degraded.reserve_factor` compensate for the
same uncertainty" — is now **moot**, because only one of the two is in the product.

### 5.2 Every factor, with its ownership and phase

| Parameter | Value | Appendix A default | Governance | Calibration status | In product | Registered by |
|---|---|---|---|---|---|---|
| `energy.charger_availability_margin` | 1.15 | **1.15** (spec line 5684) | **Safety** | PROVISIONAL | nominal | Phase 1 |
| `energy.uncalibrated_reserve_factor` | 1.25 | **1.25** (spec line 5689) | **Safety** | PROVISIONAL | nominal | Phase 1 |
| `energy.f_derate` | 1.00 | — (named in §14.3, no Appendix A row) | Safety | — | nominal (identity) | Phase 1/7 |
| `route.degraded_reserve_factor` | 1.40 | **1.40** (spec line 5733) | **Safety** | PROVISIONAL — *awaits measured degraded-estimate error distribution* | degraded-only | Phase 1 |
| `energy.max_combined_conservatism` | 1.60 | **1.60**, range 1.0–3.0 (spec line 5690) | **Safety** | — | the cap | Phase 1 |

### 5.3 The root cause, stated plainly

**Every one of these values is the frozen specification's own Appendix A default, unmodified.** And:

```
1.15 × 1.25 × 1.00 × 1.40  =  2.0125   >   1.60
```

**Appendix A's own defaults are mutually inconsistent with §14.3's own cap.** This is not four
engineers each choosing 1.15–1.25 and compounding by accident — which is the failure §14.3 exists to
make visible, and which the implementation report reasonably read it as. It is the specification's
default table failing its own publish-time rule on the very first evaluation. §14.3's mechanism is
working exactly as designed; what it has caught is its own seed values.

The Phase 7 implementation is faithful. This closure independently confirms the prior finding that
Phase 7 changed no Safety-class parameter: the four factors are Phase 1 registrations at Appendix
A's values, `f_derate` is seeded at the identity, and Phase 7's own additions to the register
(12 parameters) contain none of them.

### 5.4 Why the three proposed options do not let Phase 7 act

| Option (from the implementation report) | This closure's assessment |
|---|---|
| **(a)** Raise `energy.max_combined_conservatism` to ≥ 2.0125 | **The only option that actually resolves V9.** 2.0125 is inside Appendix A's stated range (1.0–3.0), so it is expressible — but §14.3 says in terms that raising the cap "requires an explicit Safety-class decision … which is where a deliberate choice to be very conservative belongs — stated once". Phase 7 making it is precisely the accident §14.3 forbids. |
| **(b)** Make `energy.uncalibrated_reserve_factor` conditional (`activeInNominal: false`) | **Arithmetically ineffective, and this is a new finding.** `degraded = nominal × ∏(degraded-only)`, so moving a factor between the two sets leaves the *degraded* product unchanged at 2.0125. It would lower `nominal` from 1.4375 to 1.15 and V9 would still block on `degraded`. Asserted as a number in `phase7ClosureProbe.js`, not argued. |
| **(c)** Ask whether `route.degraded_reserve_factor` and `degraded.reserve_factor` double-count | **Moot** (§5.1): `degraded.reserve_factor` is not in the product. `deriveCombinedConservatism()`'s duplicate-compensation check reports **no duplication** — the four factors declare four distinct uncertainties, and they are exactly the four §14.3 itself names. |

The only remaining lever is lowering one of the three Safety-class factors below its Appendix A
default. Every one of them is `PROVISIONAL` and `route.degraded_reserve_factor`'s register entry
states what it awaits: *"measured degraded-estimate error distribution"*. Choosing a number for it
now would be fabricating calibration data, which the brief forbids and which §22.4 forbids
independently.

### 5.5 Disposition

- **Classification: DEFERRED.** Not resolved, not fixed, not worked around.
- **Owner: Safety / the calibration owner**, tracked as blocking decision **B8**, and discharged by
  Phase 15's calibration criterion *"every Safety-class parameter `DERIVED`, none `PROVISIONAL`"*.
- **Why Phase 7 cannot decide it:** all four inputs and the cap are Safety-class; §14.3 reserves
  raising the cap to an explicit Safety decision; §22.4 forbids launching on a PROVISIONAL or
  UNCALIBRATED Tier 0 parameter regardless of what number is chosen; and the plan gives Phase 7
  authority to *register* these parameters (its "Configuration updates" row names
  `max_combined_conservatism` and `uncalibrated_reserve_factor`), not to choose Safety values
  differing from the specification's.
- **Consequence, and its direction: conservative.** V9 is `BLOCKING`, so the register cannot be
  published, so the engine cannot be launched on these values. Nothing is admitted that should be
  denied. Additionally, V9 is **not the sole publication blocker** — `validateCandidate({
  enforceLaunchGate: true })` returns **40 BLOCKING findings**, of which **39 are V10** for Tier 0
  parameters at PROVISIONAL or UNCALIBRATED across many phases, and `npm run gate:calibration`
  enumerates them by name with what each awaits. The register is in a pre-calibration state **by
  design**; V9 is one symptom of that state, not a Phase 7 regression that stands alone.
- **What must resolve it:** a Safety ratification recorded against §14.3 that either states the
  intended combined degraded conservatism and raises the cap to match, or supplies measured values
  for the three PROVISIONAL factors. Either way the arithmetic is pinned by test, so the change is
  visible.

**Final status: DEFERRED. Unchanged and unresolved by this closure.**

---

## 6. Database verification — **live PostgreSQL 18.3, 82 checks, 0 failures**

Phase 7's third recorded issue — "the migration has not been applied to a live database" — is
**RESOLVED**. It was an environmental limitation of the reviewing environment, not a Phase 7 defect
and not a deployment defect; a database is available now and the migration was applied.

### 6.1 Environment

| Property | Value |
|---|---|
| Server | **PostgreSQL 18.3** on x86_64-windows |
| Host / port | `127.0.0.1:55432` — a **disposable** cluster, never port 5432, never the user's Neon database |
| Database | `robotx_p7`, created empty for this closure |
| Migration chain | **the complete real chain, all 22 migrations**, applied with `prisma migrate deploy` |
| Result | `All migrations have been successfully applied.` |

### 6.2 What was verified

```
$ DATABASE_URL=… node tools/verify/phase7LiveDatabase.js
  82 passed, 0 failed.
```

| Group | Result |
|---|---|
| **Six tables** — `EnergyModelParams`, `BatteryState`, `Charger`, `ChargerReservation`, `ChargerAvailabilityProjection`, `PackingResultCache` | all present |
| **Columns** — every §14.2 β term (`betaDist … betaPayloadThermal`, `etaRegen`, `residualCv`), `ChargerReservation.targetSoc` | all present |
| **§9.6 immutability** — `ChargerAvailabilityProjection` carries **no `updatedAt` column** | confirmed against the live table, not the model text |
| **κ's identity seed** — `BatteryState.kappa` defaults to `1`, `kappaSampleCount` to `0` | confirmed; matches `consumption.updateKappa()`'s contract |
| **23 indexes** including both compound unique keys | all present |
| **7 foreign keys** with their declared `ON DELETE` mode | all present and correct |
| **All five hand-written CHECK constraints, each made to fire** | see below |
| **Uniqueness** — projection `version`, `(containerConfig, itemSignature)`, `(agentClassId, modelVersion)` | each refuses a duplicate |
| **Delete behaviour, actually performed** | see below |
| Cleanup | the harness left no rows behind |

### 6.3 The five CHECK constraints — each refused a real violating write

This is the class of claim `prisma migrate diff` regeneration cannot reach: a CHECK naming a column
that does not exist, or bounding the wrong side of an interval, is a constraint that never fires and
reads identically to a correct one in a diff.

| Constraint | Refused | Accepted |
|---|---|---|
| `BatteryState_soh_fraction` | `soh = 1.4`, `soh = 0`, `soh = -0.1` | `soh = 1.0`, `soh = NULL` |
| `BatteryState_kappa_positive` | `kappa = 0`, `kappa = -1` | `kappa = 1.12` |
| `ChargerReservation_target_soc_fraction` | `targetSoc = 80` — the 80-versus-0.8 unit confusion the migration's own comment names — and `-0.1` | `targetSoc = 0.8` |
| `ChargerReservation_window_ordered` | `reservedUntil == reservedFrom`, `reservedUntil < reservedFrom` | an ordered window |
| `PackingResultCache_verdict_decided` | `'BUDGET_EXHAUSTED'`, `'INDETERMINATE'` | `'FEASIBLE'`, `'INFEASIBLE'` |

The last one is enforced from **both ends**, and both ends were exercised: the database refuses the
write, and `packing.evaluateMemoised()` — driven in `phase7ClosureProbe.js` with a node budget of 1
and a kv that records every write attempted — returned `BUDGET_EXHAUSTED` and attempted **zero**
writes. A future caller bypassing the application code still cannot memoise an indecision.

### 6.4 Delete behaviour, performed rather than read off the DDL

| Action | Observed |
|---|---|
| delete a `Charger` | its reservations' `chargerDbId` is **nulled**; the reservations survive |
| delete an `Agent` | its `BatteryState` and `ChargerReservation` rows **cascade away** |
| delete an `AgentClass` | its `EnergyModelParams` rows **cascade away** |
| delete a `Region` | a projection's `regionId` is **nulled**; the projection survives — which is what a pinned, replayable decision input must do |

### 6.5 Schema alignment and migration safety

```
$ npx prisma validate
  The schema at prisma\schema.prisma is valid

$ npx prisma migrate diff --from-url postgresql://…/robotx_p7 \
                          --to-schema-datamodel prisma/schema.prisma --script
  -- DropForeignKey
  ALTER TABLE "ConfigActiveVersion" DROP CONSTRAINT "ConfigActiveVersion_version_fkey";
```

**Zero drift on any Phase 7 table** — the six tables, their columns, indexes and foreign keys match
`schema.prisma` exactly after the real chain is applied. The single drift statement concerns
`ConfigActiveVersion`, a **Phase 1** table whose migration
(`20260728093000_config_registry_and_governance`) creates a foreign key that `schema.prisma`'s model
no longer declares as a relation. It is pre-existing, outside Phase 7's scope, and this closure did
not change it; it is recorded in §12 for whoever owns Phase 1's schema.

**Migration safety.** `20260804180000_energy_and_payload_models` was scanned for
`DROP` / `DELETE` / `TRUNCATE` / `RENAME` / `ALTER COLUMN` / `SET NOT NULL`. It contains **none** —
the only occurrence of the word "DROP" is in a comment stating that rollback is `DROP TABLE` on the
six. It is purely additive: six `CREATE TABLE`, 23 index creations, seven `ADD CONSTRAINT … FOREIGN
KEY`, five `ADD CONSTRAINT … CHECK`. No existing table gains a column, a NOT NULL, or a
requirement.

**Rollback was not exercised**, because no down migration exists — Prisma's migration model has
none, and inventing one to test would be creating an artefact the programme does not use. The
migration's own stated rollback (`DROP TABLE` on the six, no data loss outside them) is consistent
with what the live schema shows: nothing outside the six tables references them.

---

## 7. Phase 0 documentation gap — **documentation gap only; does not block closure**

**What was found, exactly:** `PHASE_0_INDEPENDENT_VERIFICATION.md` does not exist.
`PHASE_0_IMPLEMENTATION_REPORT.md` does. **No historical evidence was created, reconstructed, or
inferred.**

**Is it required?** No. This closure checked the process authority rather than repeating the
observation a seventh time:

- `IMPLEMENTATION_EXECUTION_PLAN.md` §3's **PHASE 0** entry lists no verification document among its
  deliverables, and its completion criteria are *"`npm test` green; both gates run in CI and
  demonstrably fail on planted violations; `src/engine/TIERS.md` enumerates every §1.8 Tier 0/1/2
  mechanism"*.
- §7's **Phase 0** checklist (10 items) names no verification document either.
- The only place the plan requires *"Implementation report and independent verification"* as a
  checklist line is **Remedial Phase T1-04** (§7 line 1956, §3 lines 759/1152/1159), which is that
  phase's own requirement and states its own document name.

So the per-phase independent-verification report is a **convention this programme has followed**
since Phase 1, not a plan requirement, and its absence for Phase 0 cannot block Phase 7.

**The minimum evidence that is genuinely required** is Phase 0's own stated completion criterion:
that the gates demonstrably fail on planted violations. This closure produced that evidence **now**,
labelled as current, not as history:

```
$ cat > src/engine/energy/plantedTierBypass.js     # a Tier 0 module importing Tier 2 pricing
$ npm run gate:tiers
  FAIL — 1 forbidden dependency edge(s):
    src/engine/energy/plantedTierBypass.js:3  →  src/engine/pricing/vTerminal.js
        Tier 0 — Safety core module imports Tier 2 — Allocation quality module. §1.8 rule 2 …
$ rm src/engine/energy/plantedTierBypass.js && npm run gate:tiers
  PASS — 277 module(s), 387 governed import edge(s), no Tier 0/1 → Tier 2 dependency.

$ cat > src/engine/energy/plantedBareConstant.js   # a bare behavioural constant 1.37
$ npm run gate:params
  FAIL — 1 violation(s) across 184 module(s):
    src/engine/energy/plantedBareConstant.js:4  [bare-constant]
        bare behavioural constant 1.37 is absent from the parameter register …
$ rm src/engine/energy/plantedBareConstant.js && npm run gate:params
  PASS — 183 engine module(s) checked against 242 registered parameter(s).

$ git status --short | grep -i planted        # tree verified clean afterwards
(no output)
```

Both of Phase 0's gates are real checks, today, on this tree. Phase 6's closure separately planted a
T1 type-separation bypass and watched `gate:tenets` fail. Phase 0's substance is therefore evidenced
continuously by every later phase's sweep; what is missing is a document, and this closure records
that as a **documentation gap** and nothing more.

---

## 8. Phase boundary verification

### 8.1 What this closure implemented

Nothing beyond Phase 7's scope. The complete change set is the four files in §3: one Phase 6
predicate strengthened, one Phase 6/7 seam test extended, and three verification harnesses under
`tools/verify/`. No plan builder, no cost term, no solver, no candidate generation, no pricing, no
optimisation, no exchange or insertion pricing, no round wiring, no reliability, no worker
scheduling.

```
$ git status --short
 M Backend/src/engine/feasibility/predicates/f26.js     ← the only source file
?? Backend/tests/engine/feasibilityPhase7Integration.test.js
?? Backend/tools/verify/
   (+ 30 pre-existing modifications and 5 pre-existing untracked paths, untouched — §2.3)

$ git diff --stat -- Backend/src/engine/plan Backend/src/engine/solve Backend/src/engine/cost \
                     Backend/src/engine/candidates Backend/src/engine/pricing \
                     Backend/src/engine/reliability Backend/src/engine/energy Backend/src/engine/payload
(no output)
```

### 8.2 The honest statement about `plan/`, `solve/`, `cost/`, `candidates/`, `pricing/`

These directories are **populated**, and they were **not** populated by this closure. They hold
Phases 8–11's implementations, which landed between Phase 7's verification (2026-08-04) and today
(§2.2) and are documented in their own reports. Treating their existence as "Phase 8 leakage into
Phase 7" would be a misreading of the repository's history; this closure states the fact rather than
suppressing it.

The boundary that *is* Phase 7's and that this closure verified:

| Check | Result |
|---|---|
| `src/engine/reliability/` — §1.8 Tier 2, owned by Phase 16c | **still holds only `.gitkeep`** |
| `phase0Scaffold.test.js`'s `PHASE_7_OWNED` | unchanged: `["energy/", "payload/", "routing/chargerReachabilityCache.js"]` — exactly the 15 modules Phase 7 shipped |
| Phase 7's 15 modules | committed at `cbe540e`, byte-identical in the working tree |
| The one Phase 8 module carrying Phase 7 output | `plan/planBuilder.js:417` passes `packed.compartmentLoads` through from `payload/packing.js`; it is not a second producer, and the F26 change therefore constrains it too |
| `gate:tiers` — no Tier 0/1 → Tier 2 dependency | **PASS**, 277 modules, 387 governed edges |
| `gate:tiers` proven to be a real check | planted Tier 0 → Tier 2 import caught (§7) |
| `server.js` | unchanged by this closure |
| `ENGINE_ENABLED` | still `false` |

---

## 9. Phase 6 → Phase 7 integration, re-verified field by field

### 9.1 The register rows, re-queried rather than transcribed

```
$ node tools/verify/phase7ClosureProbe.js
  F22  class I  DENY  volatile=false  cache=NONE     PASS
  F23  class I  DENY  volatile=false  cache=NONE     PASS
  F24  class I  DENY  volatile=false  cache=NONE     PASS
  F25  class R  DENY  volatile=false  cache=CLASS    PASS
  F26  class R  DENY  volatile=false  cache=CLASS    PASS
  F34  class I  DENY  volatile=true   cache=NONE     PASS
  F35  class I  DENY  volatile=true   cache=NONE     PASS
```

Identical, cell for cell, to Phase 7's verification Part 3 and to Phase 6's own review. No drift.
`assertRegister()` and `assertSubset()` both return `{ ok: true, problems: [] }`; all 38 predicates
are registered.

### 9.2 Producer output against predicate reads, re-derived by running the producers

| Predicate reads | Producer emits (printed from a live run) | Match |
|---|---|---|
| `plan.loadState[].massUpperBoundKg` (F22) | `sequence, stopType, projectedArrivalMs, massUpperBoundKg, massExpectationKg, volumeLitres, onboardItemIds, compartmentMassKg, cog` | ✅ — and it is the *upper* bound, not the expectation, both being present and distinct |
| `plan.packing.{verdict, tier, bindingConstraint}` (F23) | `verdict, tier, bindingConstraint, thermalAssignment, compartmentLoads, loadingPlan, nodesExplored, diagnostics` | ✅ — and `f23.PACKING_VERDICT` is asserted equal to `packing.VERDICT`, three values, `BUDGET_EXHAUSTED` distinct |
| `plan.loadState[].cog.{withinEnvelope, envelopeMarginMm, longitudinalMm, lateralMm, heightMm}` (F24) | `withinEnvelope, envelopeMarginMm, bindingAxis, longitudinalMm, lateralMm, heightMm, reason` | ✅ all five |
| `plan.packing.thermalAssignment.{compartmentId, thermalMinC, thermalMaxC, activeThermal, thermalHoldSeconds}` (F25) | `compartmentId, thermalClass, thermalMinC, thermalMaxC, activeThermal, thermalHoldSeconds, itemIds` | ✅ all five |
| `plan.packing.compartmentLoads[].lockClass` and `.items[].{hazardClasses, securityClass, segregation}` (F26) | compartment: `compartmentId, lockClass, ordinal, items`; item: `itemId, hazardClasses, securityClass, segregation, massKg, massToleranceKg, volumeLitres, thermalMinC, thermalMaxC` | ✅ — and **`requiredLockClass` is confirmed absent from the item shape**, which is the whole basis of §4 |
| `plan.energy.tierProbabilities.{T1,T2,T3}` (F34) | `tierProbabilities{T1,T2,T3}, chargerReachability, bindingTier, tiers` | ✅ |
| `plan.energy.chargerReachability.{basis, reachable, projectionVersion, chargerId, eReturnWh, surplusWh}` (F35) | `reachable, basis, projectionVersion, chargerId, eReturnWh, surplusWh, considered` | ✅ |

### 9.3 Null semantics and the INDETERMINATE ⇒ DENY direction, by execution

Each of the seven was evaluated against a context whose plan carries **none** of the three Phase 7
fragments — the state Phase 6 shipped in, and the state a Phase 7 producer outage reproduces:

```
  F22 on an empty plan → INDETERMINATE, policy DENY     PASS
  F23 on an empty plan → INDETERMINATE, policy DENY     PASS
  F24 on an empty plan → INDETERMINATE, policy DENY     PASS
  F25 on an empty plan → INDETERMINATE, policy DENY     PASS
  F26 on an empty plan → INDETERMINATE, policy DENY     PASS
  F34 on an empty plan → INDETERMINATE, policy DENY     PASS
  F35 on an empty plan → INDETERMINATE, policy DENY     PASS
```

One note worth recording, because it looked like a defect and is not: F25 returns `SATISFIED` on a
mission whose payload declares **no thermal range at all**, and that is correct — F25 does not bind
on a non-thermal payload, and the probe was corrected to carry a real cold-chain requirement rather
than the finding being written up. With a thermal payload and no assignment, F25 is
`INDETERMINATE` as above.

### 9.4 Verdict and class semantics

- **§15.3 tier-3 exhaustion.** `BUDGET_EXHAUSTED` is a distinct verdict; F23 maps the three
  verdicts three ways (`FEASIBLE`→SATISFIED, `INFEASIBLE`→VIOLATED, `BUDGET_EXHAUSTED`→INDETERMINATE);
  a node-starved search returns it and writes **nothing** to the memo. Verified by execution.
- **Class/policy.** Every one of the seven declares `DENY`; F25 and F26 are class R (F25 `C/R`
  governed as the stricter half), neither operationally overridable.
- **F34's α resolution** remains Phase 6's closure fix (R1) and is unaffected by anything here.
- **F26** is now strictly stronger than it was (§4.4) and is a strict subset of its producer.

---

## 10. Architecture and safety verification

| Property | Evidence |
|---|---|
| **Tier dependencies** (§1.8 rule 2) | `gate:tiers` PASS — 277 modules, 387 governed edges, no Tier 0/1 → Tier 2. Proven to be a real check by a planted violation (§7) |
| **Parameter register** (§22) | `gate:params` PASS — 183 engine modules against 242 parameters, no bare behavioural constants. Proven real by a planted constant (§7) |
| **Determinism** (T6, I10) | `gate:tenets` PASS — 274 modules, no violations. The composed producer→predicate pipeline replays identically 100 times and survives a JSON round trip (`feasibilityPhase7Integration.test.js`) |
| **Energy is Wh in the decision path** (§14.1) | `reserves.LAYER_FIELDS` are all `…Wh`, asserted by regex. `grep -rn "dtaro\|BATTERY_THRESHOLD\|CHARGING_INTERRUPT_BATTERY" --include=*.js src/engine/` → **zero matches in any engine module**. `legacy.dtaro.battery_threshold_pct` and `…charging_interrupt_battery_pct` are resolved by exactly one file — `src/config/dtaro.constants.js`, the Phase 1 shim outside the engine tree — whose only non-test consumer is `src/simulation/constants.js`, the simulator. That is ambiguity A1's disposition holding exactly: retired *from the decision path*, retained for the legacy dispatcher until Phase 15. `chargeCurve.interruptionPermitted`'s body contains neither `soc` nor `battery` as a token |
| **Four reserve layers, never traded** (§14.5) | Four layers declared. `assertNoTrade()` **refuses** a protected layer falling and **permits** it rising — the asymmetry, not a symmetric equality check. `PROTECTED_FIELDS` has three entries and excludes `operationalWh`, the only releasable layer |
| **α[tier] derived, never hand-entered** (§14.5) | `energy.shortfall_probability` resolves, and so does `energy.event_budget_per_fleet_year`, the governed input it is derived from. `tiers.alphaFor()` refuses a hand-set α supplied through an unregistered config object |
| **Target SoC is Scheduler-owned** (§14.6) | `TARGET_SOC_SOURCE = {SCHEDULER, CLASS_DEFAULT}` — two values, no third. `assertNotEngineComputed()` accepts those two and **refuses** `ENGINE`, `COMPUTED`, `optimiser`, `null`, `undefined`. `resolveTargetSoc()` refuses outright when neither a fresh published target nor a class fallback resolves. `grep -rln targetSoc src/engine` → four modules, and the one later-phase consumer (`plan/planBuilder.js`) **refuses to plan a charging stop** when no target is available rather than computing one, quoting §14.6 in its refusal. At the schema level, `targetSoc` lives on `ChargerReservation` — the Scheduler's row |
| **Tier 3 budget exhaustion ⇒ INDETERMINATE/DENY** (§15.3) | §9.4 above |
| **Cache failures cannot create authoritative decisions** (§3.3 I16) | Driven with a kv that throws on every call: the packing memo falls through to full recomputation and still returns `FEASIBLE`; the charger-reachability cache returns `hit: false`. A reachability key **cannot be built at all** without `projectionVersion` — `key()` returns `{ok:false, key:null}` naming the missing field rather than composing a key that would silently apply an entry computed under one projection to a decision taken under another (§20.3 item 3) |
| **Database and schema aligned** | §6.5 — zero drift on any Phase 7 table against a live database carrying the real chain |
| **All 21 checklist items** | Re-verified against the current tree: every named module resolves and exports its named contract; V9 exists in `config/validators.js`; `VirtualRobot.js:86` imports `engine/energy/chargeCurve` — the server's module, not a reimplementation; `GET /api/diagnostics/energy/:agentId` is registered and rate-limited. **21/21 still satisfied** |

---

## 11. Test results

All numbers below are from runs executed for this closure against the current working tree, after
the R3 fix.

### 11.1 Build gates

```
$ npm run gates
  gate: tier-dependencies    PASS — 277 module(s), 387 governed import edge(s), no Tier 0/1 → Tier 2
  gate: parameter-register   PASS — 183 engine module(s) against 242 registered parameter(s)
  gate: tenets               PASS — 274 module(s) checked, no violations
  gate: identity-isolation   PASS — 16 module(s) in cost/decision-record scope hold no identifying field
  gate: erasure              PASS — 3 corpus decision(s) reconstruct byte for byte
  gate: legacy-retirement    PASS — 4 retired module(s) absent and unimported across 312 file(s)
  gate: column-generation    PASS — NOT_REQUIRED for this change set (40 path(s))
                             7 of 7 gates PASS
```

The Phase 7 verification recorded "3/3 gates". Seven exist now (§2.2); all seven pass, and two of
them were proven to be real checks by planted violations (§7).

### 11.2 Test lanes

```
$ npx jest --runInBand --forceExit                 (all five projects)
  Test Suites: 146 passed, 146 total
  Tests:       6442 passed, 6442 total

$ npx jest --runInBand --forceExit --selectProjects <lane>     (each lane, run serially)
  engine    116 suites   6149 tests
  gates       7 suites    100 tests
  legacy     17 suites    126 tests
  chaos       3 suites     44 tests
  scale       3 suites     23 tests
           ─────────────────────────
             146 suites   6442 tests   = the five-project total above, reconciled exactly

$ npx jest --runInBand --forceExit --testPathPatterns "feasibility"
  Test Suites: 5 passed, 5 total
  Tests:       350 passed, 350 total

$ npx jest --runInBand --forceExit --testPathPatterns "feasibility|payload|energy"
  Test Suites: 9 passed, 9 total
  Tests:       578 passed, 578 total

$ npx prisma validate
  The schema at prisma\schema.prisma is valid
```

**Failures: 0. Skipped: 0. Intentional skips: 0. Tests deleted, weakened, re-baselined, made
conditional, or changed from strict to permissive: 0.**

### 11.3 Reconciliation against the baseline

Two baselines are relevant, and conflating them is exactly the mistake §2.2 warns about.

| Baseline | Suites | Tests | Note |
|---|---|---|---|
| `PHASE_7_INDEPENDENT_VERIFICATION.md`, 2026-08-04 | 65 | **1 779** | Measured against a Phases 0–7 tree that no longer exists. **Not a valid comparator** for this closure, and no attempt is made to reconcile against it. |
| `PHASE_6_REMEDIATION_AND_CLOSURE.md`, 2026-08-17 | 146 | **6 436** | The immediately preceding measurement of *this* tree. This is the comparator. |

| | Suites | Tests |
|---|---|---|
| Baseline before this closure (Phase 6 closure, all five projects) | 146 | 6 436 |
| `feasibilityPhase7Integration.test.js` — the F26 security-class describe block (**6 new tests**) | 0 | **+6** |
| **After this closure** | **146** | **6 442** |

The delta is `+6` and nothing else. `feasibilityPhase7Integration.test.js` went 26 → 32 tests; the
`feasibility` pattern went 344 → 350; the engine lane went 6 143 → 6 149. Every one of those four
figures is the same six tests counted through a different filter, and all four were measured.

**No existing test changed.** The F26 fixtures in `feasibilityPredicates.test.js` and
`helpers/feasibilityFixture.js` declare `lockClass: null` with `securityClass: null` or absent, and
`payloadModel.test.js`'s F26 case uses a `SECURE_A` item that the real packing module places in the
fixture container's `SECURE_A` compartment — so all of them were already on the matching side of the
relation and none needed adjusting. That they all passed unchanged is itself evidence that R3 was a
latent divergence rather than a behaviour anyone was relying on.

### 11.4 Verification harnesses run outside Jest

Not test suites, deliberately: two require an environment or a before/after tree state, and a test
that silently skips when its environment is absent reports green for having done nothing.

```
$ node tools/verify/phase7SecurityClassProbe.js                          26 passed, 0 failed
    (against the pre-remediation f26.js: 20 passed, 12 failed — §4.3)
$ node tools/verify/phase7ClosureProbe.js                                35 passed, 0 failed
$ DATABASE_URL=… node tools/verify/phase7LiveDatabase.js                 82 passed, 0 failed
```

---

## 12. Remaining limitations

Each is labelled with what kind of thing it is, as the brief requires.

1. **[GOVERNED SAFETY DECISION] The parameter register cannot publish.** V9 blocks on combined
   degraded conservatism 2.0125 against a cap of 1.6, and 39 further V10 findings block on Tier 0
   parameters at PROVISIONAL/UNCALIBRATED. Owner: Safety / calibration (blocking decision **B8**);
   discharged by Phase 15's calibration criterion. **Not resolved by this closure** (§5).
2. **[DEPLOYMENT] Nothing in Phase 7 runs.** No round consumes `tiers.evaluate()`,
   `packing.evaluate()` or `loadState.project()` in production; `ENGINE_ENABLED` is `false`; neither
   `chargerReachability.worker.js` nor `energyCalibration.worker.js` is scheduled — production worker
   scheduling is Phase 15's. Correct for this phase, and unchanged by this closure.
3. **[DEPLOYMENT / COMMISSIONING] `EnergyModelParams` and `BatteryState` hold no seed data.** The
   tables exist, are correct, and are read; fitting β coefficients and measuring SoH per agent is a
   commissioning activity. Every module reports a missing coefficient by name rather than defaulting
   one, which is why the absence is safe.
4. **[DEPLOYMENT] The migration has been applied to a disposable database, not to production.**
   Applying it to production is a deployment step. Its correctness is no longer in question (§6).
5. **[EXTERNAL DEPENDENCY] The Charging Scheduler does not exist** (blocking decision **B2**), and
   **the routing engine is undecided** (**B1**). The engine's half of both contracts is complete and
   validated at the boundary; `resolveTargetSoc()` returns the class default with a degradation flag
   and `E_return` falls back to depot-only, which is §14.7's own declared unavailability envelope.
6. **[DOCUMENTATION] `PHASE_0_INDEPENDENT_VERIFICATION.md` does not exist**, and is not required by
   the plan (§7). Phase 0's substance was evidenced live for this closure by planting violations in
   both of its gates.
7. **[PRE-EXISTING, PHASE 1] `ConfigActiveVersion_version_fkey` drifts** between the applied
   migration chain and `schema.prisma` (§6.5). Outside Phase 7's scope; recorded for Phase 1's owner.
8. **[MODELLING ASSUMPTION, DISCLOSED] The Gaussian tail is an approximation** and is optimistic
   against a heavier-tailed truth, stated in `consumption.js`, absorbed by `energy.model_residual_cv`'s
   calibration, and measured by §21.5's loop. Unchanged; re-recorded here so it is not lost.

None of these can cause an unsafe permissive decision. Items 1 and 2 make the engine *unable to run*;
items 3–5 make it deny or degrade; items 6–8 change no behaviour.

---

## 13. Final recommendation

**Phase 7 is genuinely closed and ready for the phases that consume it.**

All fourteen closure criteria are met:

| | Criterion | Status |
|---|---|---|
| A | All 21 checklist items remain satisfied | ✅ re-verified against the current tree (§10) |
| B | Every verification issue has a documented disposition | ✅ RESOLVED ×2 (F26, live DB), DEFERRED ×1 (V9), documentation gap ×1 (Phase 0) |
| C | No unresolved issue can cause an unsafe permissive decision | ✅ §12 — the one deferral blocks publication rather than admitting anything |
| D | No Phase 8+ functionality leaked into Phase 7 | ✅ §8 — and the pre-existing Phases 8–15 are stated plainly rather than suppressed |
| E | Phase 6 predicate contracts remain intact | ✅ 38/38 registered, `assertRegister()`/`assertSubset()` clean; the one predicate changed became **stricter** |
| F | Energy remains Wh-based in the decision path | ✅ §10 |
| G | Four reserve layers remain non-tradeable | ✅ §10, asymmetry verified |
| H | α[tier] remains derived rather than hand-entered | ✅ §10 |
| I | Target SoC remains Scheduler-owned | ✅ §10, including through Phase 8's plan builder |
| J | Tier 3 budget exhaustion remains INDETERMINATE/DENY | ✅ §9.4, and enforced from the storage side too |
| K | Cache failures cannot create authoritative decisions | ✅ §10, driven with a throwing client |
| L | Database migration and schema remain aligned | ✅ §6.5, zero Phase 7 drift against a live database |
| M | All available verification passes | ✅ §11 |
| N | Environment limitations distinguished from defects | ✅ §12, each item labelled |

Two things are worth carrying forward:

- **R3 is the argument for asking which direction an agreement runs.** Two prior reviews saw the
  same dead branch and both stopped at "it cannot fire, and the producer is stricter anyway". Both
  were right about the branch and both missed that removing it — the recommended fix — would have
  left a class R predicate permanently looser than the module whose output it checks. The question
  that found it is not "does this code run?" but "if the producer were wrong, would the gate catch
  it?". Phase 6's R1 was the same question at a different seam.
- **The live database keeps earning its cost.** Phase 6's closure found a real defect the first time
  one was used. Phase 7's schema turned out to be correct — but "the five CHECK constraints fire" is
  now a fact rather than an inference from a diff, and that is a different kind of statement to hand
  to whoever deploys this.

---

## Appendix — commands run for this closure (reproducible)

```bash
cd Backend

# State reconstruction
git status --short && git log --oneline -12
git diff --stat -- src/engine/energy src/engine/payload src/engine/routing/chargerReachabilityCache.js
ls src/engine/plan src/engine/solve src/engine/candidates src/engine/pricing src/engine/reliability

# R3 — the F26 divergence, reproduced before and after
git stash push -- src/engine/feasibility/predicates/f26.js
node tools/verify/phase7SecurityClassProbe.js      # 12 divergences, F26 the looser
git stash pop
node tools/verify/phase7SecurityClassProbe.js      # 26 passed, 0 failed

# Phase 7 closure evidence, by execution
node tools/verify/phase7ClosureProbe.js            # 35 passed, 0 failed

# Disposable PostgreSQL 18.3 — never 5432, never Neon
createdb -h 127.0.0.1 -p 55432 -U p5user robotx_p7
DATABASE_URL=postgresql://p5user@127.0.0.1:55432/robotx_p7 npx prisma migrate deploy
DATABASE_URL=postgresql://p5user@127.0.0.1:55432/robotx_p7 node tools/verify/phase7LiveDatabase.js
npx prisma validate
npx prisma migrate diff --from-url postgresql://p5user@127.0.0.1:55432/robotx_p7 \
                        --to-schema-datamodel prisma/schema.prisma --script
grep -niE "drop |delete |truncate |rename |alter column" \
     prisma/migrations/20260804180000_energy_and_payload_models/migration.sql

# Phase 0's gates, proven to be real checks (current evidence, not reconstructed history)
cat > src/engine/energy/plantedTierBypass.js && npm run gate:tiers && rm …
cat > src/engine/energy/plantedBareConstant.js && npm run gate:params && rm …

# Scans
grep -rn "dtaro\|BATTERY_THRESHOLD\|CHARGING_INTERRUPT_BATTERY" --include=*.js src/engine/
grep -rn "requiredLockClass" --include=*.js --include=*.json --include=*.prisma .
grep -rln "targetSoc" src/engine/

# V9, reproduced two ways
node -e '… defaultSnapshot().resolve("energy.combined_degraded_conservatism") …'
node -e '… validateCandidate({ enforceLaunchGate: true }) …'
npm run gate:calibration

# Full regression
npm run gates
npx jest --runInBand --forceExit
npx jest --runInBand --forceExit --selectProjects <each lane>
npx jest --runInBand --forceExit --testPathPatterns "feasibility|payload|energy"
```

*End of Phase 7 Remediation and Closure Report.*
