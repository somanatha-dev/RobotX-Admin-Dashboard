# Phase 6 — Remediation, Re-verification and Closure

**Role:** Principal Safety Engineer / Distributed-Systems Engineer / Formal Verification Engineer /
Independent Software Verification Engineer
**Date:** 2026-08-17 · **Branch:** `feature/dashboard` · **Working tree at closure:** `63f5c58`
+ the changes listed in §2
**Subject:** `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` §7 — Feasibility (Eligibility), the L4 gate

**Authority order used throughout:** the frozen specification first, then
`IMPLEMENTATION_EXECUTION_PLAN.md`, then the repository, then
`PHASE_6_INDEPENDENT_VERIFICATION.md`, then `PHASE_6_IMPLEMENTATION_REPORT.md`. Where a report and
the specification disagreed, the specification won. No frozen document, no ADR, `TIERS.md`, or
safety-case requirement was modified.

---

## 1. Final status

# PHASE 6 CLOSED

The Phase 7 prerequisite that Phase 6's original review recorded as an open sequencing violation is
**resolved**: Phase 7 is implemented, independently verified, and — as of this remediation —
composed end-to-end into the Phase 6 gate and exercised, not merely compared field-name by
field-name. Two defects were found during this closure that neither the Phase 6 review nor the
Phase 7 review caught, both on the permissive side of a safety boundary, both fixed, both covered by
regression tests, and both re-verified — one against a live PostgreSQL 18.3 instance.

This is `CLOSED`, not `CLOSED WITH DOCUMENTED INTEGRATION LIMITATION`, because the integration
limitation the earlier reviews recorded no longer exists. The limitations that remain (§10) are
about *deployment* — nothing in Phase 6 is wired into a running round yet, which is Phase 10's job —
and not about whether Phase 6's own deliverable is correct.

---

## 2. Files changed

| File | Change | Why | Frozen requirement | Defect | Test that proves it |
|---|---|---|---|---|---|
| `Backend/src/engine/feasibility/predicates/f34.js` | `alphaFor()` helper replaces the generic indexed read of `energy.shortfall_probability` | F34's α resolution disagreed with the authoritative energy model's, in the permissive direction | §14.5 (`α₁(class)`), §7.3, Appendix A `energy.shortfall_probability` | R1 | `feasibilityPhase7Integration.test.js` → "§14.5 — F34 resolves α[tier] the same way the authoritative energy model does" (5 tests) |
| `Backend/src/workers/rejectionAggregation.worker.js` | the `RejectionAggregate` flush becomes a parameterised `INSERT … ON CONFLICT … DO UPDATE` | the typed `upsert()` **threw** for 37 of the 38 predicates, so the §7.7 SLIs were not exact over 100 % of decisions | §7.7 ("exact over **100 % of decisions**") | R2 | `feasibilityTelemetry.test.js` → 4 new tests against a mock that refuses NULLs the way a real client does; `tools/verify/phase6NullTierProbe.js` live |
| `Backend/prisma/migrations/20260817120000_rejection_aggregate_nulls_not_distinct/migration.sql` | **new**: folds any duplicate groups, then redeclares the seven-column unique key `NULLS NOT DISTINCT` | the key could not address a row whose dimensions are NULL, which is the ordinary case | §7.7 (the aggregation key) | R2 | applied to a live PostgreSQL 18.3 database, including its de-duplication path, against real duplicates |
| `Backend/prisma/schema.prisma` | **doc comment only** (14 lines, zero semantic change — verified by diff): records that this index is `NULLS NOT DISTINCT` in the database, which Prisma cannot express, and warns that `migrate dev` will propose dropping the clause | the drift is permanent and must not be "fixed" | §7.7 | R2 | `tools/verify/phase6NullTierProbe.js` catches a regression live |
| `Backend/tests/engine/feasibilityPhase7Integration.test.js` | **new**, 26 tests | the Phase 6 ↔ Phase 7 seam had never been exercised by composition | plan §3 "PHASE 6" integration requirements | R1 + the sequencing finding | itself |
| `Backend/tests/engine/feasibilityTelemetry.test.js` | the flush mock is made strict; 4 tests added; the pre-existing "folds into both tables" test is reinstated against the strict mock with the same three assertions | a permissive mock is why R2 went unseen | §7.7 | itself |
| `Backend/tools/verify/phase6AlphaProbe.js` | **new** verification harness | reproduces R1 at verdict level across every map shape | — | — |
| `Backend/tools/verify/phase6PlantedViolations.js` | **new** verification harness | proves the register and volatile-subset self-checks *reject* defects rather than merely agreeing with a correct table | §7.5, §10.3.2 step 3 | — | — |
| `Backend/tools/verify/phase6LiveDatabase.js` | **new** verification harness | the first live-database execution of Phase 6's schema in this programme | §7.7 | — | — |
| `Backend/tools/verify/phase6NullTierProbe.js` | **new** verification harness | reproduces R2 against a real client and proves the fix | §7.7 | R2 | — |
| `PHASE_6_IMPLEMENTATION_REPORT.md`, `PHASE_6_INDEPENDENT_VERIFICATION.md` | closure addendum appended; **nothing removed or rewritten** | history is preserved, per §51 of the closure brief | — | — | — |

**No other file was touched.** In particular: no predicate other than `f34.js`, no frozen
specification, no ADR, no `TIERS.md`, nothing in `src/engine/cost/`, `solve/`, `plan/`,
`candidates/`, `energy/` or `payload/`, and none of the pre-existing uncommitted modifications from
earlier phases that were already in the working tree when this task began.

---

## 3. Findings

### R1 — F34 and the authoritative energy model resolved `α[tier]` differently, and F34's reading was the looser one

**Severity: HIGH (latent safety, class I predicate, permissive direction).**

**Root cause.** F34 deliberately re-derives its own α targets rather than reading the `target` field
`energy/tiers.js` already computed — a predicate must not take its threshold from the module whose
output it is checking. That independence is only safe while the two transcriptions agree on how
`energy.shortfall_probability` is indexed, and they did not:

- `energy/tiers.js`'s `alphaFor()` reads **`map[slaClass][tier]`**, and its own comment states that
  a class-keyed entry wins over the tier-keyed default;
- `f34.js` used `readIndexedParameter(alphaMap, tier, slaClass)`, which reads **`map[tier][slaClass]`**.

The two are transposed. Under the flat tier-keyed map `config/derived.js` publishes today, both land
on the same number and the disagreement is invisible — which is why every existing test passed.

**Consequence, reproduced at verdict level rather than argued.** With a class-keyed map published
(the shape `alphaFor()` documents as supported, and which Appendix A's `specScope: "sla_class"`
invites), for a `CRITICAL` mission:

```
$ node tools/verify/phase6AlphaProbe.js        # against the pre-fix f34.js
SLA-class-keyed (the shape energy/tiers.js documents as winning)
  energy/tiers.js : ok=true targets={"T1":0.0001,"T2":0.000001,"T3":1e-9}
  f34.js          : outcome=SATISFIED targets={"T1":0.01,"T2":0.00001,"T3":1e-7}
  *** DIVERGE ***
```

F34 returned **SATISFIED** — admitting the candidate — on a plan whose shortfall probability exceeds
the class's own target by a factor of ten, because it compared against the looser fleet default.
That is a false positive on a class **I** predicate: precisely the "unknown is never permission"
and "safety constraints are absolute and never priced" properties §7.3 and T1 exist to make
impossible. A second divergence existed in the transposed direction, where `energy/tiers.js`
refused the map outright (`ok=false`) and F34 happily resolved a target from it.

**Action.** `f34.js` now resolves α through a named `alphaFor()` helper that replicates the energy
model's precedence exactly — class-keyed wins over tier-keyed — and **refuses any other shape**
rather than digging into it. It also applies the same range check the producer applies (α strictly
inside `(0, 1)`, Appendix A's own bound), because an α at or above 1 makes a tier vacuously
satisfied for every plan that will ever be evaluated. The set of maps F34 accepts is now a strict
subset of the set `energy/tiers.js` accepts, which is what makes *"F34 admits ⟹ the energy model
agrees"* hold structurally rather than coincidentally.

**Fresh evidence.**

```
$ node tools/verify/phase6AlphaProbe.js        # after the fix
flat tier-keyed …            energy/tiers.js: ok=true  f34.js: SATISFIED       AGREE
SLA-class-keyed …            energy/tiers.js: ok=true  f34.js: VIOLATED        AGREE
tier-then-class …            energy/tiers.js: ok=false f34.js: INDETERMINATE   AGREE
0 divergence(s) across 3 map shapes.
```

**Regression tests.** Five, in `feasibilityPhase7Integration.test.js`: the class-keyed precedence,
the fleet-default fallback for a class with no entry, the transposed shape becoming
`INDETERMINATE`, the α ≥ 1 case, and a loop asserting the two modules agree on resolvability across
five map shapes including α = 0 and α = 1.5.

**Final status: FIXED and verified.**

---

### R2 — the rejection-aggregation flusher threw for 37 of the 38 predicates

**Severity: HIGH (functional; §7.7's exactness requirement unmet). Not currently reachable in
production, because the worker is not scheduled.**

**Root cause.** `RejectionAggregate`'s unique key spans seven dimensions, four of which are nullable
and NULL in the ordinary case: only **F34** carries a `tier`, and `zoneId`, `missionClass` and
`legPurpose` are absent whenever the decision did not supply them. Two things follow:

1. PostgreSQL's UNIQUE default is `NULLS DISTINCT`, so two rows that both say "no zone, no tier" do
   not collide — the constraint that exists to keep one logical bucket in one row did not apply to
   the rows that need it most.
2. `rejectionAggregation.worker.js` addressed the row through that compound key, and a
   compound-unique `where` containing a NULL is **refused outright by the client**. The flush did
   not fragment; it *threw*.

**Why nothing caught it.** The single flush test drove **F34** — the one predicate of the 38 that
always has a tier — against a mock Prisma client that accepted any argument shape. Both halves of
that choice were needed for the defect to hide, and the live-database probe found it in one run:

```
$ DATABASE_URL=… node tools/verify/phase6NullTierProbe.js     # before the fix
F34 — tier 'T3' (the only predicate that carries one)
  three flushes of 10 produced 1 row(s), counts [30]      ← fine
F13 — tier null (the shape 37 of the 38 predicates produce)
  probe error: PrismaClientValidationError: Argument `tier` must not be null.
```

**Consequence.** §7.7 requires the binding-constraint distribution and the near-miss margins be
*exact over 100 % of decisions* — that is the entire justification for aggregating before sampling.
A flusher that throws on the first non-F34 row it meets loses the whole batch. The property Phase 6
claims most loudly was the one that did not hold.

**Action.** Two changes, both minimal:

- **Migration `20260817120000_rejection_aggregate_nulls_not_distinct`** redeclares the seven-column
  unique key `NULLS NOT DISTINCT`. In this table an absent dimension is a *determinate fact about
  the rejection* — "this rejection had no zone" — not missing information, so two rejections
  agreeing on all seven dimensions belong in one bucket. The migration **folds** any pre-existing
  duplicate groups first (`SUM` of counts, widest bucket window, then delete the extras) rather than
  deleting them, because tightening a unique key over a table that already holds duplicates fails
  outright, and because §7.7's exactness requirement binds a repair as much as it binds a flush.
- **The flusher** addresses its conflict target in parameterised SQL
  (`INSERT … ON CONFLICT (…) DO UPDATE SET "count" = "RejectionAggregate"."count" + EXCLUDED."count"`),
  which can express a NULL conflict target where the typed client cannot. Upsert-and-**add**
  semantics are preserved exactly, which is what keeps an at-least-once retry safe.

**Fresh evidence** (live PostgreSQL 18.3, after the fix):

```
$ DATABASE_URL=… node tools/verify/phase6NullTierProbe.js
F34 — every key dimension present     3 flushes → 1 row(s), SUM(count) = 3   PASS ×3
F13 — tier null                       3 flushes → 1 row(s), SUM(count) = 3   PASS ×3
F16 — tier, zone, class, purpose null 3 flushes → 1 row(s), SUM(count) = 3   PASS ×3
NULLS NOT DISTINCT must not over-merge
  PASS  two zones stay two rows even with the other dimensions NULL
10 passed, 0 failed.
```

The last check matters as much as the first three: `NULLS NOT DISTINCT` must close the fragmentation
without *merging* two rejections that genuinely differ, and it does.

**Regression tests.** The mock in `feasibilityTelemetry.test.js` now refuses a NULL inside a
compound-unique `where` exactly as a real client does, so a future revert to the typed `upsert()`
fails the suite rather than passing it. Four tests were added (F13 with a tier only missing, F16
with four dimensions missing, F22 partially specified, and F34's tier still being bound), and the
pre-existing "a snapshot folds into both tables" test was **reinstated against the strict mock**
with the same three assertions expressed through the new mechanism — the predicate id, the binding
tier, and the additive conflict branch. No test was weakened, skipped, or deleted.

**Final status: FIXED and verified live.**

---

### Original Phase 6 issue 1 — the Phase 7 prerequisite (MEDIUM, process/sequencing) → **RESOLVED**

`IMPLEMENTATION_EXECUTION_PLAN.md:471` states `Prerequisites: Phases 1, 2, 7`. At Phase 6's
implementation and review, `src/engine/energy/` and `src/engine/payload/` held only `.gitkeep`.

**Current state, verified from the repository rather than from a report.** Phase 7 is implemented
(`energy/{usable,consumption,reserves,tiers,eReturn,chargeCurve,wear,midMission,chargingSchedulerClient}.js`,
`payload/{spec,container,packing,loadState,custodyEvidence}.js`) and independently verified —
`PHASE_7_INDEPENDENT_VERIFICATION.md` returns **PASS WITH MINOR ISSUES**, 21/21 checklist items,
including a field-by-field check of all seven producer/consumer boundaries Phase 6 was waiting on.

**What this closure added that was still missing.** Phase 7's review compared field names, enums and
units between producer and consumer. `payloadModel.test.js` and `energyModel.test.js` go further and
compose the producers into the seven predicates individually — that coverage is real and this
closure does not repeat it. What no test did was run a plan whose Phase 7 fragments came from the
real producers through the **whole gate**, and that is where the properties Phase 6 actually claims
live. `feasibilityPhase7Integration.test.js` closes it: every plan in that file is built by running
`payload/packing.js`, `payload/loadState.js`, `energy/tiers.js` and `energy/eReturn.js` for real and
grafting their output onto the fixture. Nothing in it hand-writes a `plan.energy`, `plan.loadState`
or `plan.packing`. It proves, by composition:

- all seven Phase 7-dependent predicates are `SATISFIED` on real producer output, and the gate
  brands the candidate with evidence naming all 38 predicates;
- a **physics**-infeasible energy projection (a 560 Wh mission against a 700 Wh pack, failing the
  tier conditions on real arithmetic) leaves the candidate unbranded, and `assertFeasible()` throws
  — the cost evaluator does not decline to price it, it cannot;
- the predicate and the producer name the **same** binding tier on that rejection, so the tier an
  operator reads off a §7.7 rejection is the tier the energy model says binds;
- a stale charger projection degrades the basis to `DEPOT_ONLY` and F35 admits and records it —
  a smaller envelope, not a suspended constraint;
- `f35.BASIS` and `eReturn.BASIS` are two independent transcriptions that agree;
- a producer that resolves *nothing* (`planEnergyFragment()` returning `null`, `project()` returning
  `ok:false`) denies, and all seven are never-overridable with a mandatory `DENY`;
- a fleet-wide producer outage trips the systemic guard, and Restricted Operation relaxes nothing;
- a plan feasible at decision time is re-denied at commit when the energy state moves;
- the composed pipeline replays identically 100 times and survives a JSON round trip.

**Final status: RESOLVED. Phase 6 was implemented out of order; the consequence was conservative,
as both earlier reviews found; and the integration is now verified by execution rather than by
inspection. R1 — a real defect on that exact seam — is what the composition found that inspection
had not.**

---

### Original Phase 6 issue 2 — the overstated Phase 5 precedent (LOW, documentation) → **STANDS, no action**

Phase 6's review found the implementation report's claim that "Phase 5 set the identical precedent"
overstated: Phase 5's own prerequisites are `Phases 3, 4`, so Phase 5 was never blocked on Phase 7
the way Phase 6 explicitly was. This closure re-checked `IMPLEMENTATION_EXECUTION_PLAN.md:442` and
agrees. The finding is correct as recorded, concerns the report's framing only, and touches no code.
It is preserved rather than erased.

### Original Phase 6 issue 3 — the "315 new tests" headline (LOW, documentation) → **STANDS, no action**

Phase 6's review reconciled 314 + 1 and confirmed the total was correct but not decomposable from
the report's own four-row table. Re-checked; still correct; preserved for the record. This closure's
own counts are given in §9 with the decomposition stated explicitly, so the same gap is not
reintroduced.

### Original Phase 6 issue 4 — predicate indeterminate policy declared in code, not in the Config Service (LOW, Safety-ratification) → **ASSESSED, ownership confirmed, remains a Safety sign-off item**

The execution plan lists per-predicate indeterminate policy under "Configuration updates";
`register.js` declares it in code. This closure examined whether the current architecture is
actually compliant with the frozen requirement, as instructed, rather than deferring again.

**It is compliant, and moving it would violate §7.2.** §7.2 states class I is "**Never overridable
by anyone, including operators and manual assignment**" and class R is "Never overridable
operationally". A configuration key capable of changing a class I predicate's policy from `DENY` to
anything else is exactly such an override, and it would be reachable by anyone holding
config-publish rights rather than by nobody, which is what the specification requires. The plan's
own precedence rule (`IMPLEMENTATION_EXECUTION_PLAN.md:7` — "where this plan and the specification
appear to disagree, the specification wins and this plan is defective") settles the conflict in
favour of the code declaration.

The declaration is not merely in code, it is **machine-checked** against §7.3's own permission
table: `assertPolicyLawful()` reads `POLICY_PERMITTED_CLASSES`, transcribed independently in
`threeValued.js`, and `evaluate.js` refuses to load if any row violates it. This closure proved the
check is not self-referential by planting a class I predicate declaring `ADMIT` (§5, planted
violation 1): the register reports the violation and the gate refuses to load.

**No code change made.** The ownership decision is documented and justified here so it is a settled
reading rather than a standing question, and it remains flagged for formal Safety ratification —
which is a governance act, not an engineering one, and not this closure's to perform.

### Original Phase 6 issue 5 — no live database (informational) → **RESOLVED**

Every phase since Phase 2 has recorded this. Phase 6's schema has now been executed against a
disposable **PostgreSQL 18.3** cluster on port 55432 (never 5432, never the user's Neon database),
carrying the complete real migration chain. §8 reports what that found — including R2, which no
amount of `prisma migrate diff` regeneration could have surfaced.

### Carried forward from Phase 7's review — F26's unreachable `requiredLockClass` branch → **DOCUMENTED, deliberately not changed**

Phase 7's review found that `f26.js` reads `item.requiredLockClass`, which no Phase 6 or Phase 7
producer populates, leaving one of its two security-check branches unreachable. Re-confirmed here.

**No change made, deliberately.** The branch is conservative in direction (it can only ever add a
`VIOLATED`, never remove one), `container.satisfiesSecurityClass()` already enforces an exact
lock-class match at placement time, and deleting working defensive code because it is currently
unreachable trades a real regression risk for no safety gain. Under the closure brief's own rule —
a change must be answerable on all five of *why / in scope / which frozen requirement / which defect
/ which test* — this change fails on "which frozen requirement" and "which defect", so it is not
made. Recorded here as a known, benign, forward-compatible branch.

---

## 4. Predicate verification

All 38 predicates were checked in both directions — specification → code and code → specification —
against `NEXT_GENERATION_ASSIGNMENT_ENGINE.md:1710–1786` transcribed independently. **The register
matches §7.5 on all 38 rows for class, indeterminate policy, cache tier and volatility.** That
cell-by-cell table is not reproduced here because Phase 6's own review already published it and this
closure's re-derivation found no discrepancy against it; what follows is the per-predicate status
after this remediation.

| Predicate | Class (governing / declared) | Policy | Volatile | Cache tier | Status |
|---|---|---|---|---|---|
| F1 | I | DENY | — | AGENT | PASS |
| F2 | P | DENY | — | AGENT | PASS |
| F3 | P | DENY | — | AGENT | PASS |
| F4 | C | DENY | — | AGENT | PASS |
| F5 | I | DENY | — | AGENT | PASS |
| F6 | R | DENY | — | AGENT | PASS |
| F7 | I | DENY | ✔ | AGENT | PASS |
| F8 | I | DENY | ✔ | AGENT | PASS |
| F9 | P | DENY | — | AGENT | PASS |
| F10 | I | DENY | ✔ | AGENT | PASS — corroboration verified, §5 |
| F11 | P | ADMIT_WITH_PENALTY | — | AGENT | PASS — cannot silently become ADMIT, §6 |
| F12 | R | DENY | — | AGENT | PASS |
| F13 | I | DENY | ✔ | NONE | PASS |
| F14 | I | DENY | ✔ | NONE | PASS |
| F15 | P | ADMIT_WITH_PENALTY | — | NONE | PASS — cannot silently become ADMIT, §6 |
| F16 | I | DENY | ✔ | NONE | PASS |
| F17 | I | DENY | ✔ | NONE | PASS |
| F18 | I | DENY | ✔ | NONE | PASS |
| F19 | F | DENY | — | NONE | PASS |
| F20 | P | DENY | ✔ | NONE | PASS |
| F21 | I | DENY | — | CLASS | PASS |
| F22 | I | DENY | — | NONE | **PASS — integrated with `payload/loadState.js`, §5** |
| F23 | I | DENY | — | NONE | **PASS — integrated with `payload/packing.js`, §5** |
| F24 | I | DENY | — | NONE | **PASS — integrated with `payload/loadState.js`, §5** |
| F25 | R / `C/R` | DENY | — | CLASS | **PASS — integrated with `payload/packing.js`, §5** |
| F26 | R | DENY | — | CLASS | **PASS — integrated; one benign unreachable branch documented, §3** |
| F27 | R / `R/P` | DENY | — | NONE | PASS |
| F28 | I | DENY | — | CLASS | PASS |
| F29 | I | DENY | — | CLASS | PASS |
| F30 | R | DENY | — | NONE | PASS |
| F31 | I | DENY | — | NONE | PASS |
| F32 | F | DENY_UNLESS_ENVELOPE | — | NONE | PASS — denies absent an envelope answer, §6 |
| F33 | C | DENY | — | NONE | PASS |
| F34 | I | DENY | ✔ | NONE | **PASS after R1 — integrated with `energy/tiers.js`, §5** |
| F35 | I | DENY | ✔ | NONE | **PASS — integrated with `energy/eReturn.js`, §5** |
| F36 | P | DENY | — | NONE | PASS |
| F37 | C / `F/C` | DENY | — | NONE | PASS |
| F38 | F | DENY | — | NONE | PASS |

**38/38 PASS.** Every class I and R predicate declares `DENY`, machine-checked at module load and
proven to be a real check by a planted violation (§5). The three dual-class predicates (F25 `C/R`,
F27 `R/P`, F37 `F/C`) are governed by the stricter half, structurally enforced.

**Purity.** No predicate reads Redis, PostgreSQL, wall-clock time, or a random source; time arrives
as `context.decisionTimeMs`. Re-scanned: zero `Date.now()`, `new Date(…)`, `Math.random()` or
`randomUUID()` in executable code across `feasibility/`. The `gate:tenets` build gate enforces this
over the whole decision path and passes over 274 modules.

---

## 5. Safety verification

**F10 — independent corroboration.** The conjunction is `confidence ≥ threshold ∧ ≥ 1 corroborator
agrees`, with the corroboration evaluated *before* the confidence comparison so a disagreeing
corroborator dominates a high self-reported confidence — the "confidently wrong" failure §7.5's own
rationale names. No corroborator offered is `INDETERMINATE`, never `SATISFIED`. Class I, so all
three paths deny. Re-confirmed by reading and by the existing boundary tests.

**F34 — tier logic.** All three tiers are evaluated unconditionally; the binding tier is selected by
**exceedance ratio** (`probability / target`) rather than absolute margin, in both the satisfied and
the violated branches — necessary because the targets span 1e-2 to 1e-7 and an absolute margin is
not commensurable across them. Boundary and pathological values (0, 1.5, NaN, missing, a tier with
no projected probability, a missing α) all resolve to `INDETERMINATE` or `VIOLATED`; none becomes
`SATISFIED`. **α resolution is the R1 defect, fixed and regression-tested.** F34 and
`energy/tiers.js` now agree on the binding tier and on the target across every map shape tested.

**F35 — Phase 7 energy integration.** F35 consumes `eReturn.evaluate()`'s verdict and models no
energy of its own. Verified live through composition: `reachable: true` → `SATISFIED`, `false` →
`VIOLATED` with the surplus as a Wh margin, a pinned-projection verdict that cannot name its
projection version → `INDETERMINATE` (replayability, ADR 21), an unrecognised basis →
`INDETERMINATE`, and the `DEPOT_ONLY` degraded basis → `SATISFIED` **and recorded**. `f35.BASIS` and
`eReturn.BASIS` are independent transcriptions asserted equal by test.

**F22–F26.** Each consumes its Phase 7 producer's output and computes no physical model of its own.
Verified by composition (§3, and `payloadModel.test.js`'s existing per-predicate coverage): F22
reads the per-stop `massUpperBoundKg` — the *upper* bound, not the expectation, so an 11 kg item
with 0.5 kg tolerance is caught at 11.5 kg; F23 maps the four §15.3 packing verdicts, with
`BUDGET_EXHAUSTED` → `INDETERMINATE` (a search that ran out of budget is not evidence either way);
F24 denies on an unknown envelope verdict rather than assuming an origin; F25 and F26 evaluate after
the compartment assignment, since before assignment there is no combined load to reason about.

**Systemic-indeterminacy guard (§7.4).** Driven here by a *real* fleet-wide producer outage rather
than by fixtures. Healthy fleet → not tripped, 20/20 admitted. One blind agent (5 %) → that agent
denied, shard unaffected. 80 % blind → tripped at the configured 0.30 threshold. **Exactly at the
threshold → not tripped**, matching §7.4's "exceeds". Restoring the producers clears the trip. The
guard cannot fire at all without a resolved threshold, which leaves the shard in the strict
deny-everywhere state rather than guessing.

**Restricted Operation relaxes nothing.** `assertRelaxesNothing()` checks both shape (seven
forbidden field names) and direction (a reserve multiplier below 1 refused, corroboration required).
The envelope carries `recordCommitmentsAsDegraded` and a time box, per §7.4 step 4. Critically, and
asserted directly: there is **no parameter by which the envelope could reach the gate at all** —
with the guard tripped, the same blind candidate is still denied on the same class I predicates.

**I14 — type separation.** Proven structurally, not by inspection:

- `brandFeasible()` has exactly one call site outside its own definition — `evaluate.js:210`, inside
  `gate()`, reached only when `outcome.feasible` is true. A rejected candidate is returned as
  `candidate: null`.
- Every cost entry point (`phi`, `cDirect`, `cRisk`, `cLifecycle`, `cDelay`, `cOpportunity`,
  `cPolicy`, `solve/objective`) calls `assertFeasible()`.
- The brand survives **no** copy path: `{...c}`, `JSON` round trip, `Object.assign`, and
  `structuredClone` all strip it; re-branding an already-branded object throws.
- **Planted violation (§20/§50 of the brief).** A module accepting a raw candidate was planted in
  `src/engine/cost/`:

  ```
  $ node src/engine/guards/tenets.js        # with the plant
  FAIL — 1 violation(s) across 275 module(s):
    T1  src/engine/cost/plantedBypass.js:3
        accepts candidate-shaped parameter "candidate" but the module never calls
        assertFeasible(); cost evaluation must be structurally unable to see an
        infeasible candidate (§1.5 T1, §7.1, I14)

  $ rm src/engine/cost/plantedBypass.js && node src/engine/guards/tenets.js
  PASS — 274 module(s) checked, no violations.
  ```

  The gate proves the architecture, not merely today's implementation.

**Volatile subset (§10.3.2 step 3).** The eleven-predicate list (F7, F8, F10, F13, F14, F16, F17,
F18, F20, F34, F35) is transcribed twice — literally in `SPECIFIED_SUBSET`, and derived from the
register's `volatile` flags — and `assertSubset()` proves the two agree. **Planted violations
(§5 below) confirm the check rejects drift in either direction.**

**Commit-time volatile re-check.** Exercised against a real Phase 7 state change: a candidate
admitted at decision time on a real energy projection is re-denied when usable energy falls to
430 Wh before the commit lands, with `reason: "VOLATILE_FEASIBILITY_LOST"` and a detail naming F34.
The re-check evaluates exactly the eleven-predicate subset and nothing else. A re-check that cannot
build its inputs **throws** rather than reporting success — the informal bypass under latency
pressure §7.1 predicts.

**Register and subset self-checks are real checks, not decoration.** Five defects were planted one
at a time (`tools/verify/phase6PlantedViolations.js`):

| Planted defect | `assertRegister()` | `assertSubset()` | `evaluate.js` loads |
|---|---|---|---|
| F7 (class I) declares `ADMIT` | **false** | true | **refused** |
| F36 removed (37 predicates) | **false** | true | **refused** |
| F37 duplicated | **false** | true | **refused** |
| F34 dropped from the volatile subset (register side) | true | **false** | **refused** |
| the literal subset swaps F35 for F36 | true | **false** | **refused** |

**5 of 5 caught**, and in every case the gate refused to load — an incoherent register is a startup
failure, not a silent mis-evaluation. Files restored in a `finally`; the tree was verified clean
afterwards.

---

## 6. Three-valued logic and the four indeterminate policies

The pipeline is `raw result → three-valued outcome → declared policy → admit / deny / admit-with-penalty`,
and the policy is never applied by the predicate that declares it.

| Policy | Predicates | Behaviour verified |
|---|---|---|
| `DENY` | 35 | Denies, and `deniedForIndeterminacy` is recorded separately from a measured `VIOLATED`, which is what lets §7.4 count only the former |
| `DENY_UNLESS_ENVELOPE` | F32 | Denies unless the caller supplies `envelopeFeasible: true`; **absent, it denies**, which is the policy's name read literally. F32 does not construct the reduced-envelope plan itself |
| `ADMIT_WITH_PENALTY` | F11, F15 | **Denies when no `cost.uncertainty_penalty[predicate]` resolves** — admitting without the penalty would silently downgrade the policy to `ADMIT`, which is a different policy and not the one the predicate declared |
| `ADMIT` | none | Permitted only for class P with no safety or contractual consequence; no predicate in the register uses it |

An unrecognised outcome **throws** rather than being treated as satisfied. An unlawful policy
declaration **denies** rather than taking the gate down or admitting. A measured `VIOLATED` is not a
policy question — no policy admits it, which is what T1 means by "safety constraints are absolute
and never priced".

**Unknown is never permission.** The `value || default`, `value ?? safeDefault` and
`if (!value) return true` patterns were searched for across the feasibility path.
`threeValued.readParameter()` returns `undefined` for an absent value rather than defaulting, and
every one of the 38 modules turns that into `INDETERMINATE`; `epochMs()` returns `null` for an
unreadable timestamp rather than a defaulted "now", which would have made it maximally fresh;
`isNumber()` routes `null`, `undefined` and `NaN` to the `INDETERMINATE` path rather than the
comparison path, because `NaN < x` is `false` and a predicate comparing against it would report
`SATISFIED` for an unreadable value. R1's fix extends the same discipline to an out-of-range α.

---

## 7. Cache verification

| Level | Key | Invalidation | Verified |
|---|---|---|---|
| Tier 1 — agent-invariant (F1–F12) | `engine:feas:agent:{agentId}` | stamp match on read: lifecycle, health, capability, firmware, certification | PASS |
| Tier 2 — agent × class (F21, F25, F26, F28, F29) | `engine:feas:class:{agentClass}:{missionClass}:{zone}` | config or map version stamp | PASS |
| Tier 3 — mission-specific (F22–F24, F30–F38) | not cached, ordered last | — | PASS |
| Negative cache | `engine:feas:neg:{agentId}:{legId}` | reason-derived TTL | PASS |

**Invalidation is by stamp-match-on-read, not delete-on-write.** The consequence is the right one: a
forgotten invalidation becomes a **miss**, never a stale positive.

**The negative TTL is derived from the reason, never global.** `negativeTtlSeconds()` looks the
predicate up in the register and returns `null` — a **refusal**, not a zero TTL — for any predicate
in the volatile subset, *before* consulting any TTL map. §7.6's own two examples land on opposite
sides of this: a capability mismatch (F21, tier CLASS) caches; an energy shortfall (F34, volatile)
is refused outright. The hazard §7.6 names is therefore closed structurally rather than by choosing
a small number.

**A cache is never an authority.** Every `kv` call in `read()`, `write()`, `recordRejection()` and
`readRejection()` is wrapped so that any error is a miss or a `false`, never a verdict. §7.6's
ambiguity about F13–F20 (which it does not explicitly classify) is resolved to "not cached", the
conservative direction, consistent with §7.6's stated bias toward correctness over hit rate.

**Cache keys cannot collide across a correctness-relevant dimension**, and the same property was
verified at the storage layer against a live database: varying any one of the seven
`RejectionAggregate` aggregation dimensions alone yields a distinct row (§8).

**Configuration versioning.** The brand records `configVersion`, and tier-2 entries carry a config
and map version stamp, so a result cannot survive an incompatible configuration version.

---

## 8. Database verification — live PostgreSQL 18.3

The first live execution of Phase 6's schema in this programme. A disposable cluster on port
**55432** (never 5432, never the user's Neon database) carrying the **complete real migration
chain**, `robotx_p6`.

```
$ npx prisma validate                → the schema is valid
$ DATABASE_URL=… npx prisma migrate deploy
   All migrations have been successfully applied.
$ DATABASE_URL=… node tools/verify/phase6LiveDatabase.js
   17 passed, 0 failed.
```

| Check | Result |
|---|---|
| Both tables, all columns, nullability, defaults, PK | as declared |
| Five hand-written CHECK constraints **fire** | `F0` refused, `F39` refused, zero-width bucket refused, `marginUnit 'furlongs'` refused |
| The `predicateId` regex partitions 1–38 exactly | all 38 registered ids accepted; F0 and F39 rejected |
| `marginUnit` CHECK covers the runtime enum | all nine `MARGIN_UNIT` values accepted |
| Compound unique key | identical key refused a second insert; varying any one dimension yields a distinct row |
| **NULL dimensions** | **found R2**; after remediation, two NULL-tier rows collide, and two zones still stay two rows |
| `count` is `BIGINT` through the driver | round-trips exactly at 2^53 + 7, as a `bigint` |
| Upsert-and-add | two flushes of 10 accumulate to 20 |
| **Flusher crash between write and checkpoint** | rolls back entirely; the retry counts **once**, not twice |
| 25 concurrent increments | all land; no lost update |
| Aggregator represents 100 % of decisions | 100 recorded → 100 drained; a second drain returns nothing |
| The shipped flusher writes them all | 100 decisions across a tiered and an untiered predicate, both written |

**Migration safety.** The one new migration was inspected for `DROP` / `DELETE` / `TRUNCATE` /
`RENAME` / `ALTER COLUMN`. It contains a `DROP INDEX` and `DROP CONSTRAINT IF EXISTS` on the unique
key it immediately recreates over the identical column list, and a `DELETE` that removes only rows
whose counts have first been **folded** into the surviving row of their group. No column is dropped,
no table rewritten, no count lost. The de-duplication path was not merely written but **exercised**:
the first `migrate deploy` correctly *refused* because the table held duplicates left by the probe
that discovered R2, and the migration then applied and folded them, preserving the total (2 rows,
total 2 → 1 row, count 2).

---

## 9. Test results

All numbers below are from runs executed for this closure against the current working tree.

```
$ npm run gates
  gate: tier-dependencies    PASS — 277 modules, 387 governed edges, no Tier 0/1 → Tier 2
  gate: parameter-register   PASS — 183 engine modules against 242 registered parameters
  gate: tenets               PASS — 274 modules, no violations
  gate: identity-isolation   PASS — 16 modules in cost/decision-record scope hold no identifying field
  gate: erasure              PASS — 3 corpus decisions reconstruct byte for byte
  gate: legacy-retirement    PASS — 4 retired modules absent and unimported across 309 files
  gate: column-generation    PASS — NOT_REQUIRED for this change set
                             7 of 7 gates PASS

$ npx jest --runInBand --forceExit           (all five projects)
  Test Suites: 146 passed, 146 total
  Tests:       6436 passed, 6436 total

$ npx jest --selectProjects <lane>           (each lane, run serially)
  engine   6143 passed, 6143 total
  gates     100 passed,  100 total
  legacy    126 passed,  126 total
  chaos      44 passed,   44 total
  scale      23 passed,   23 total
           ───────────────────────
           6436  = the five-project total above, reconciled

$ npx jest --testPathPatterns "feasibility"
  Test Suites: 5 passed, 5 total
  Tests:       344 passed, 344 total
  (feasibilityPredicates 
 feasibilityGate 
 feasibilityTelemetry 
 feasibilitySchema 
 feasibilityPhase7Integration)

$ npx prisma validate                        the schema is valid
```

**Decomposition of the change**, stated explicitly so it is reconcilable from this table alone —
the presentation gap Phase 6's own review recorded as issue 3:

| | Suites | Tests |
|---|---|---|
| Baseline, all five projects, before this closure | 146 | 6406 |
| `feasibilityPhase7Integration.test.js` (**new**) | +1 | +26 |
| `feasibilityTelemetry.test.js` (26 → 30) | 0 | +4 |
| **After this closure** | **146**¹ | **6436** |

¹ 145 pre-existing suites + the new one = 146; the baseline figure of 146 above already counts the
new suite because the run that produced it postdated its creation. The pre-closure suite count was
145.

**Failures: 0. Skipped: 0. Intentional skips: 0. Tests weakened, deleted or disabled: 0.** The one
pre-existing test whose mechanism changed ("a snapshot folds into both tables") was reinstated
against the stricter mock with all three of its original assertions preserved.

**Verification harnesses run outside Jest** (not test suites, deliberately: each requires an
environment, and a test that silently skips when its environment is absent reports green for having
done nothing):

```
$ node tools/verify/phase6AlphaProbe.js          0 divergences across 3 map shapes
$ node tools/verify/phase6PlantedViolations.js   5 of 5 planted defects caught
$ DATABASE_URL=… node tools/verify/phase6LiveDatabase.js    17 passed, 0 failed
$ DATABASE_URL=… node tools/verify/phase6NullTierProbe.js   10 passed, 0 failed
```

---

## 10. Remaining limitations

These are genuine and are stated as limitations of **deployment**, not of Phase 6's correctness.

1. **Nothing calls `evaluate.gate()` in production yet.** Wiring the gate into a round is Phase 10's
   scope, and this closure did not do it. Phase 6's deliverable is complete, correct, and inert on
   its own terms. Verified: no production caller of `gate()`, `gateAll()`, or `evaluateCandidate()`.
2. **`createVolatileRecheck()` has no production supplier.** `commit.js` requires
   `deps.volatileRecheck` and throws without it; nothing outside tests supplies one. That is
   Phase 10's `buildContext` adapter — assembling an agent snapshot from a locked transaction is the
   round's work, not this module's. The seam, the contract and the re-check itself are complete and
   exercised against real Phase 7 state changes.
3. **`rejectionAggregation.worker.js` is not scheduled.** R2 was therefore never reachable in
   production — which is why it is a defect found before it could cost anything, not an incident.
   The fix is verified live against the real client and the real schema regardless.
4. **`ENGINE_ENABLED` remains off** and `server.js` is unchanged by this closure.
5. **The parameter register still cannot publish** — Phase 7's review recorded V9 blocking on
   combined degraded energy conservatism 2.0125 against a cap of 1.6, driven by Phase 1's
   `route.degraded_reserve_factor`. That is blocking decision **B8**, a Safety/calibration decision
   explicitly outside any implementation phase's authority. Unchanged and unaffected by this
   closure; F34's α resolution is correct independently of what value is eventually ratified.
6. **`PHASE_0_INDEPENDENT_VERIFICATION.md` still does not exist.** The same gap every review since
   Phase 1 has recorded and not blocked on; Phase 0's scaffold tests and its three build gates are
   exercised by every later phase's suite, including this one.
7. **F26's `requiredLockClass` branch remains unreachable**, deliberately (§3).
8. **`schema.prisma` is permanently in drift against the database on one index.** Prisma cannot
   express `NULLS NOT DISTINCT`, so `prisma migrate dev` and `migrate diff` will report the
   `RejectionAggregate` unique index as changed and propose recreating it without the clause. This
   is the same standing situation as the model's two hand-written CHECK constraints, which also
   live only in the migration; the schema now carries a doc comment saying so, and accepting the
   proposal would silently reintroduce R2. `tools/verify/phase6NullTierProbe.js` catches it against
   a live database if anyone does.

**Phase 6 implementation correctness** and **Phase 6 + Phase 7 integration correctness** are now
both verified. The distinction the closure brief asks to be kept separate has collapsed in the good
direction: the seam is exercised by composition, and doing so is what found R1.

---

## 11. Phase boundary

**No Phase 8 functionality was implemented.**

Scanned for `cost`, `C_direct`, `C_risk`, `C_lifecycle`, `C_delay`, `C_churn`, `C_opportunity`,
`C_policy`, and `Φ(` across every changed file. The only occurrences are in `f34.js`'s and
`evaluate.js`'s existing doc-comments explaining why the gate must *not* see a cost, and in
`evaluate.js`'s accumulation of `penaltyMilliCu` — which it carries for the cost evaluator to apply
and never applies itself, because applying it would be evaluating cost inside the gate.

The architectural direction holds:

```
candidate → FEASIBILITY → FeasibleCandidate → COST
```

and the forbidden direction is structurally impossible, proven by the planted bypass in §5. No
change was made to `src/engine/cost/`, `solve/`, `plan/`, `candidates/`, `energy/` or `payload/`.
The `gate:tiers` build gate confirms no Tier 0/1 → Tier 2 dependency across 387 governed edges.

---

## 12. Final recommendation

**Phase 6 is ready to serve as the feasibility gate for Phase 8 (Cost & Plan) and Phase 10 (Round &
Solve).**

The gate is complete against §7, correct against §7 on all 38 predicates in both directions,
integrated with the real Phase 7 physical models by execution rather than by inspection, and
structurally incapable of letting an infeasible candidate reach cost — a property proven by
planting the bypass and watching the build gate fail, then removing it and watching it pass.

Two things are worth carrying forward to whoever wires this up:

- **R1 is the argument for composition testing.** Two carefully written, independently reviewed
  modules disagreed about the shape of a parameter they both read, in a way no unit test could see
  because the disagreement is invisible under the value that is published today. It took running one
  through the other, under a shape the configuration system permits, to find it. Phase 10 should
  expect the same class of defect at every seam it closes.
- **R2 is the argument for real infrastructure.** A permissive mock and a fixture that happened to
  use the one predicate carrying a tier hid a flusher that could not write 37 of 38 predicates. No
  amount of re-reading the migration would have found it; one query against a real database did.

**Phase 8 and Phase 10 may proceed on Phase 6.**

---

## Appendix — commands run for this closure (reproducible)

```bash
cd Backend

# State reconstruction
git status --short && git log --oneline -15
node -e 'console.log(require("./src/engine/feasibility/register").assertRegister())'
node -e 'console.log(require("./src/engine/feasibility/volatileSubset").assertSubset())'

# Phase 7 state — the prerequisite, checked from the repository not from a report
ls src/engine/energy src/engine/payload
grep -rn "FINAL DECISION" -A20 ../PHASE_7_INDEPENDENT_VERIFICATION.md

# R1 — reproduced at verdict level, before and after
git stash push -- src/engine/feasibility/predicates/f34.js
node tools/verify/phase6AlphaProbe.js       # 2 divergences, f34 the looser
git stash pop
node tools/verify/phase6AlphaProbe.js       # 0 divergences

# I14 — planted bypass, per §20/§50
cp /tmp/planted.js src/engine/cost/plantedBypass.js
node src/engine/guards/tenets.js            # FAIL — 1 violation
rm src/engine/cost/plantedBypass.js
node src/engine/guards/tenets.js            # PASS
node -e 'const t=require("./src/engine/guards/tenets");
  const c=t.brandFeasible({agentId:"a1"},{configVersion:"v1"});
  console.log(t.isFeasible({...c}), t.isFeasible(JSON.parse(JSON.stringify(c))),
              t.isFeasible(Object.assign({},c)), t.isFeasible(structuredClone(c)));'

# Register and volatile-subset planted violations
node tools/verify/phase6PlantedViolations.js   # 5 of 5 caught; files restored in a finally

# Disposable PostgreSQL 18.3 — never 5432, never Neon
createdb -h 127.0.0.1 -p 55432 -U p5user robotx_p6
DATABASE_URL=postgresql://p5user:***@127.0.0.1:55432/robotx_p6 npx prisma migrate deploy
psql -h 127.0.0.1 -p 55432 -U p5user -d robotx_p6 -c '\d "RejectionAggregate"' -c '\d "NearMissSketch"'

# R2 — found live, fixed, re-verified live
DATABASE_URL=… node tools/verify/phase6NullTierProbe.js    # before: threw on F13
DATABASE_URL=… node tools/verify/phase6LiveDatabase.js     # 17 passed
DATABASE_URL=… node tools/verify/phase6NullTierProbe.js    # after: 10 passed
psql … -c "select indexdef from pg_indexes where indexname like 'RejectionAggregate_shardId%';"

# Full regression
npm run gates
npx jest --runInBand --forceExit
npx jest --runInBand --forceExit --testPathPatterns "feasibility"
npx prisma validate

# Final diff audit
git status --short && git diff --stat && git diff
```

*End of Phase 6 Remediation, Re-verification and Closure Report.*
