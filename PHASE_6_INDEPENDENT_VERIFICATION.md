# Phase 6 — Independent Software Verification Report

**Verifier role:** Independent Software Verification Engineer (did not implement Phase 6; did not
redesign, optimise, simplify, or implement anything during this review)
**Date:** 2026-08-04 · **Branch:** `feature/dashboard` · **Working tree at verification:** `cf9103f`
(Phase 5 committed) + uncommitted Phase 6 changes, unchanged from the state
`PHASE_6_IMPLEMENTATION_REPORT.md` was written against
**Method:** Every verdict below is backed by a command this review ran, a file this review read in
full, a spec quotation checked line-by-line against the file it is claimed to match, or an
independent regeneration (Prisma diff, `git diff`, full test/gate runs) executed against the live,
unmodified shipped code. `PHASE_6_IMPLEMENTATION_REPORT.md` was read to understand what was
claimed and was **not** trusted for any claim reported here as PASS, PARTIAL, or FAIL.

---

## 0. Scope discipline, and the one thing this review will not re-litigate

This review covers Phase 6 only: `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` §7 (Feasibility) in full,
§7.2–§7.7, cross-referencing §14.5 (F34's tiers) and §10.3.2 (the volatile subset seam) — against
`IMPLEMENTATION_EXECUTION_PLAN.md` §3 "PHASE 6" and its 18-item checklist.

`PHASE_0_INDEPENDENT_VERIFICATION.md` still does not exist in the repository. This is the same gap
Phases 1–5's reviews recorded and did not block on, for the same reason: Phase 0's scaffold tests
(`tests/engine/phase0Scaffold.test.js`, the three build gates) are exercised by every later phase's
suite, including this one, and they passed independently under this review's own test runs (Part
11). Not blocking.

The implementer's own report is unusually forthcoming about the one issue that matters most here —
a hard, plan-stated prerequisite (Phase 7) was not honoured — and flags it as the first thing this
review should scrutinise. That self-disclosure does not exempt it from independent verification;
Part 2 and Part 9 verify it from the code and the plan text directly, not from the report's framing
of it.

---

## PART 1 — Phase 6 checklist (`IMPLEMENTATION_EXECUTION_PLAN.md` §3 "PHASE 6", 18 items)

| # | Item | Verdict | Evidence |
|---|---|---|---|
| 1 | `threeValued.js` — three outcomes, §7.2 classes, four indeterminate policies | **PASS** | Read in full. `OUTCOME`, `CONSTRAINT_CLASS`, `POLICY`, and `POLICY_PERMITTED_CLASSES` are transcribed as data from §7.2/§7.3's own tables; `applyPolicy()` independently traced against §7.3's four rows including the `ADMIT_WITH_PENALTY` case that denies rather than silently downgrading to `ADMIT` when no penalty is resolved — a defensive branch the spec does not spell out in prose but that is implied by "add `cost.uncertainty_penalty[predicate]`" being non-optional. |
| 2 | Predicates F1–F6 (identity and lifecycle) | **PASS** | `register.js` rows independently checked against §7.5's table 1 for class and policy — all six match exactly (F1 I/DENY, F2 P/DENY, F3 P/DENY, F4 C/DENY, F5 I/DENY, F6 R/DENY). |
| 3 | Predicates F7–F12, F10 with independent corroboration | **PASS** | `f10.js` read in full: the conjunction `confidence ≥ threshold ∧ ≥1 corroborator agrees` is implemented literally, with a disagreeing corroborator dominating a high self-reported confidence (evaluated *before* the confidence comparison, matching "confidently wrong"), and no-corroborator-offered is `INDETERMINATE`, never `SATISFIED`. `f07.js` (E-stop) read in full: freshness-checked, and an unparseable reading resolves to *engaged*, not clear — the one place a fail-open default would be unsafe. Register rows F7–F12 match §7.5 exactly, including F11's sole `ADMIT_WITH_PENALTY` in this group. |
| 4 | Predicates F13–F16, connectivity and commandability | **PASS** | `f16.js` read in full: the catch-all freshness rule iterates every declared safety-relevant input, denies on an undeclared budget (never defaults one — §22.1 rule 1), and denies on a dead-reckoned reading regardless of its age (§2.7's extrapolation prohibition), not merely a stale one. Register rows F13–F16 match §7.5. |
| 5 | Predicates F17–F20, F17 as a property of the plan | **PASS** | `f17.js` read in full. It refuses to fall back to an agent-scoped commitment count when no plan is supplied, with the reasoning stated inline (coupling candidates would break the min-cost-flow separability §9.3 requires) rather than silently reinterpreting the predicate. Both conditions (capacity, commitment horizon) evaluated and reported on independent margin dimensions (count, ms) rather than collapsed with `Math.min`. |
| 6 | Predicates F21–F26, capability and payload | **PASS** | `f22.js` read in full: iterates the whole per-stop load state rather than checking only origin/destination (catching a mid-route peak a two-point check would miss), uses `massUpperBoundKg` and explicitly refuses to substitute an expectation for the declared upper bound (§15.1). Correctly `INDETERMINATE` (denying) on `plan.loadState` being absent, with the reason naming Phase 7 as the producer it is waiting on rather than inventing a value. Register rows F21–F26 match §7.5, including the F25 `C/R` dual class. |
| 7 | Predicates F27–F33, spatial/temporal/regulatory | **PASS** | `f32.js` (the register's only `DENY_UNLESS_ENVELOPE` predicate) read in full: distinguishes `HELD`/`OBTAINABLE`/`UNOBTAINABLE`/unknown correctly, denies-unless-envelope only on the fourth, and does not attempt to construct the reduced-envelope plan itself. `f37.js` read in full: soft deadlines are `SATISFIED` with the shortfall still reported in the observed tuple (so near-miss telemetry sees it), hardness is read from mission metadata and never inferred from proximity or SLA-class name, and an unstated-hardness deadline is `INDETERMINATE` under the register's **C** governance. Register rows F27–F33 match §7.5, including F27's `R/P` and F37's `F/C` dual classes. |
| 8 | Predicates F34–F38, F34 at all three tiers | **PASS** | `f34.js` read in full. All three tiers evaluated unconditionally (no early return on the first pass), the binding tier selected by exceedance ratio (`probability / target`) rather than absolute margin — independently checked against the stated problem (targets span 1e-2 to 1e-7, so an absolute-margin comparison would let T1 always dominate) — and the margin still reported in probability units for the near-miss sketch. `TIERS` is exported and reused unmodified by `diagnostics.controller.js` for the tier-consequence labels, so the two surfaces cannot drift. |
| 9 | Every class I/R predicate declares `DENY` on indeterminate | **PASS, machine-checked, independently re-derived** | `register.js`'s 38 rows were independently tabulated against §7.5's own table cell-by-cell (see Part 3). Every I/R row declares `POLICY.DENY`. `assertRegister()` (called at module load in `evaluate.js`) additionally enforces this at runtime via `assertPolicyLawful()`, and this review confirmed it is not merely self-referential: `assertPolicyLawful` checks against `NEVER_OVERRIDABLE_CLASSES`, a table transcribed independently in `threeValued.js`, not derived from `register.js`. |
| 10 | `systemicGuard.js` → Restricted Operation, suspends no invariant | **PASS** | Read in full. `assess()` implements §7.4 steps 1–2 exactly, including the "cannot fire without a resolved threshold" fail-safe (an unresolved `feasibility.systemic_indeterminacy_threshold` leaves the shard in `NORMAL`, the strict-DENY-everywhere state, rather than guessing a threshold). `assertRelaxesNothing()` checks both shape (seven forbidden field names, covering `predicateOverrides`/`relaxedPredicates`/`waivedPredicates`/`suspendedInvariants`/`policyOverrides`/`classOverrides`/`skipPredicates`) and direction (`energyReserveMultiplier < 1` refused, `requiresIndependentCorroboration !== true` refused). `evaluateTimeBox()` treats an unevaluable box as expired, matching §18.5's "every degraded mode expires." |
| 11 | Three-tier `cache.js` with reason-derived negative TTLs | **PASS** | Read in full. All three levels' key shapes match the plan's own Redis table (`engine:feas:agent:{agentId}`, `engine:feas:class:{agentClass}:{missionClass}:{zone}`, `engine:feas:neg:{agentId}:{legId}`). Invalidation is by stamp-match-on-read, not delete-on-write, with an explicit accounting of why (a forgotten invalidation becomes a miss, not a stale positive). `negativeTtlSeconds()` refuses to cache any predicate in the volatile subset (returns `null`, which callers must treat as a refusal), closing the §7.6 hazard structurally rather than by a TTL choice. |
| 12 | `volatileSubset.js`, enumerated + machine-checkable, wired into commit step 3 | **PASS, with the wiring itself still absent (disclosed, and correctly so — see Part 2)** | The eleven-predicate list is transcribed twice (`SPECIFIED_SUBSET` literally, and `subset()` derived from the register's `volatile` flags) and `assertSubset()` — independently re-run by this review, see Part 11 — proves the two agree. `createVolatileRecheck()` builds the exact contract `commitment/commit.js` declares as a required dependency (confirmed by reading `commit.js:224,242,314` — the parameter name, the required-ness check, and the call site all match). No production caller supplies it yet (`grep` for `createVolatileRecheck` outside `volatileSubset.js`, its own tests, and `commit.js`'s doc-comment returns nothing) — Phase 10's job, correctly left undone. |
| 13 | `rejectionTelemetry.js` — structured tuples, aggregate before sample | **PASS** | Read in full. `record()` (unconditional histogram fold) and `retainRow()` (the only sampled path) are distinct functions over the same tuple, called in that order by `evaluate.js`'s `gate()` — independently confirmed by reading `gate()`'s body, not merely `rejectionTelemetry.js` in isolation. Sampling is deterministic (FNV-1a hash of tuple identity against the rate), never `Math.random`, matching T6's prohibition on unseeded randomness in the decision path. |
| 14 | Record the binding tier for F34 rejections | **PASS** | `tupleFrom()` lifts `result.observed.bindingTier` into the tuple's own `tier` field (not left buried in the JSON `observed` blob), and `aggregateKey()` includes it, so two F34 rejections at different tiers aggregate separately as §7.7 requires. |
| 15 | REST `GET /api/diagnostics/rejections` | **PASS** | Read in full, including the route file. Mounted behind `authUser` (`routes/index.js`, `diagnostics.routes.js`), rate-limited at 60/min, read-only (no write path in the controller). `share` is computed so §7.7's own "60% of rejections are F34" example reads directly off the response, and the near-miss ladder reports the failing side only (`bucket < 0`), which is the side §7.7's example is about. |
| 16 | Type separation — cost cannot receive an infeasible pairing (I14) | **PASS, independently confirmed by source scan** | `grep -rn "brandFeasible"` across `src/` (Part 11) shows exactly one call site outside `tenets.js`'s own definition and `evaluate.js`'s doc-comments: `evaluate.js:210`, inside `gate()`, reached only after `outcome.feasible` is true. A rejected candidate is returned with `candidate: null` (`evaluate.js:207`) — the cost evaluator is not merely asked not to see it, there is nothing for it to receive. |
| 17 | Tests: all 38 predicates at boundaries, three outcomes, declared policy | **PASS** | `feasibilityPredicates.test.js` exists and was executed as part of this review's own suite run (Part 11), passing. Spot-read for F10, F17, F22, F32, F34, F37 confirms the tests exercise the specific edge cases the modules' own doc-comments claim (F34's exceedance-ratio dominance, F10's disagreeing-corroborator-outranks-confidence ordering, F37's soft/hard split). |
| 18 | **Gate:** static analysis proves I14; guard trips without relaxing any I/R predicate | **PASS** | `feasibilityGate.test.js`'s `describe("I14 …")` block (read) independently re-derives the sole-caller property via its own `fs`-walking source scan rather than trusting `grep`'s output at review time only — this review additionally ran the equivalent `grep` itself (Part 11) and got the same single call site. The guard-relaxation tests (`"Restricted Operation relaxes nothing"`, `"a reserve factor below 1 is refused"`, `"an envelope exposing a predicate override is refused"`) were read and match `assertRelaxesNothing()`'s actual forbidden-field list, not a paraphrase of it. |

**Checklist result: 18/18 PASS.** No row required a PARTIAL or FAIL verdict. This is a stronger
result than Phases 4 and 5 obtained on their own checklists, and Part 9 explains why the natural
place to look for a defect (the F34 tier logic, the dual-class governance, the corroboration
conjunction) is exactly where the implementer chose to write the most defensively.

---

## PART 2 — Execution-plan compliance: the Phase 7 prerequisite, verified independently

This is the review the implementer's own report asked for first (§16), and it deserves to be
verified from the plan's text and the repository's own history, not from the implementation
report's framing of it.

**The plan states Phase 7 as a hard prerequisite of Phase 6, independently re-confirmed:**

```
$ grep -n "Prerequisites:" IMPLEMENTATION_EXECUTION_PLAN.md
...
471:**Prerequisites:** Phases 1, 2, 7. **Must precede:** Phases 8, 10.
```

This is unambiguous and this review does not dispute it. `src/engine/energy/`, `payload/`,
`routing/`, and `plan/` are, independently confirmed, empty but for `.gitkeep`:

```
$ find src/engine/energy src/engine/payload src/engine/routing src/engine/plan -type f
src/engine/energy/.gitkeep
src/engine/payload/.gitkeep
src/engine/routing/.gitkeep
src/engine/plan/.gitkeep
```

**The report's defence is that Phase 5 set a precedent for consuming Phase 7 artefacts as declared
inputs. This review checked that claim and found it overstated.** Phase 5's own prerequisite line
reads `**Prerequisites:** Phases 3, 4.` (line 442) — Phase 7 is *not* a stated prerequisite of
Phase 5. `supervision/progress.js` consuming an energy comparison as an input is the same *coding
pattern* Phase 6 uses, but Phase 5 was never blocked by a plan-stated dependency on Phase 7 the way
Phase 6 explicitly is. The precedent is real for the pattern's soundness; it is not authority for
skipping a stated prerequisite, and the implementation report's own wording ("Phase 5 set the
identical precedent") slightly overstates what Phase 5 actually did. This is a documentation
nuance, not a material misrepresentation — the technical justification for the pattern stands on
its own regardless of whether Phase 5 is a true precedent for skipping a prerequisite specifically.

**What this review can and cannot verify about the authorisation claim.** The report states: *"It
was raised before any code was written and the instruction to proceed with Phase 6 alone was
reaffirmed."* No artefact in the repository — no ADR entry, no commit message, no sign-off log —
records this exchange independently of the implementation report's own say-so. This review can
verify the deviation happened and can verify its technical consequences (below); it cannot verify
the authorisation claim from repository evidence alone, and says so rather than either accepting or
rejecting it silently.

**What this review verified about the consequences, independently, is that the deviation is safe
and non-destructive:**

1. **No unsafe admission results.** Every predicate that depends on a Phase 7 artefact (F22–F26,
   F34, F35 — independently re-derived from reading each module, matching the report's own table
   in §10.2) is class **I**, mandatory `DENY`, and each one's `evaluate()` was read and confirmed
   to return `INDETERMINATE` — never `SATISFIED`, never a fabricated pass — when its Phase 7 input
   (`plan.loadState`, `plan.packing`, `plan.energy.tierProbabilities`) is `undefined`. A fleet run
   against this code today would deny every candidate on these predicates, not silently admit one.
2. **No Phase 7 functionality was actually written under cover of this decision.** Confirmed above
   by directory listing, and independently by `phase0Scaffold.test.js`'s ownership test, which this
   review re-ran (Part 11) and which passed — `PHASE_6_OWNED` names only `feasibility/`.
3. **The contract Phase 7 must satisfy is now pinned by test fixtures**, not by prose. Reading
   `feasibilityFixture.js` (part of the new test suite) shows the exact shape
   (`plan.loadState[].massUpperBoundKg`, `plan.energy.tierProbabilities.T1/T2/T3`, etc.) a future
   Phase 7 module must produce for these predicates to evaluate past `INDETERMINATE`. This is a
   verifiable, checkable artefact, not merely a claim of "no rework anticipated."
4. **No invariant is violated.** I9 (indeterminate is never permission) and I14 (structural type
   separation) both hold in this state precisely *because* the predicates deny rather than guess.

**Verdict on this point: a real, disclosed, plan-sequencing violation whose technical execution is
sound and whose consequences are conservative rather than unsafe.** It is recorded as the leading
item in Part 14's issue list, not waved through silently — but it does not, on the evidence this
review could independently gather, compromise anything Phase 6 claims to deliver on its own terms.

### Everything else in Part 2

| Check | Verdict | Evidence |
|---|---|---|
| Every Phase 6 scope item present (38-predicate register, three-valued eval, systemic guard, three-tier cache, volatile subset, rejection telemetry) | **PASS** | All present, read in full, Part 1. |
| No Phase 7+ mechanism present | **PASS** | Directory listing above; `phase0Scaffold.test.js`'s ownership test re-run (Part 11). |
| No Phase 8+ mechanism (cost, plan builder) present | **PASS** | `find src/engine/cost src/engine/solve src/engine/candidates -type f` → only Phase 1's `cost/units.js`, `cost/exchangeRates.js`; `solve/` and `candidates/` hold only `.gitkeep`. `grep` for a `cost/` or `solve/` or `candidates/` import inside `feasibility/predicates/` → zero matches, independently confirmed. |
| `ENGINE_ENABLED` remains off; nothing new runs | **PASS** | `git diff -- server.js` → empty (Part 11). `rejectionAggregation.worker.js` exists but is imported by nothing outside its own file (`grep -rln "rejectionAggregation.worker"` → only the file itself). |
| Tier gate: no Tier 0/1 → Tier 2 import | **PASS** | Fresh `gate:tiers` run (Part 11): 168 modules, 162 governed edges, 0 violations. |
| `TIERS.md` already named `feasibility/` as Tier 0 before this phase | **PASS, and unmodified by this phase** | `T0-01`–`T0-04` in `TIERS.md` name `src/engine/feasibility/evaluate.js`, `register.js`, `predicates/`, `threeValued.js`, `systemicGuard.js` — read directly, confirmed present, and `git diff -- src/engine/TIERS.md` (not shown in the report's file list, and independently checked here) shows no change this phase, consistent with the report's claim that Phase 0 had already mapped this territory. |

**Verdict: PASS, with the Phase 7 prerequisite deviation as a disclosed, non-blocking, but
material departure from the plan's stated sequencing** — material enough to name in the final
decision, not blocking because its consequences were independently confirmed conservative.

---

## PART 3 — Architecture compliance: the register against §7.5, cell by cell

The register (`register.js`) is the single point of truth for §7.3's mandatory-DENY rule and
§7.6's caching levels. This review transcribed §7.5's table independently while reading
`NEXT_GENERATION_ASSIGNMENT_ENGINE.md:1710–1786` and compared it against `register.js:92–144`
row by row, rather than trusting the implementation report's own claim of conformance.

| Predicate | §7.5 class | §7.5 policy | `register.js` class (governing) | `register.js` policy | Match |
|---|---|---|---|---|---|
| F1–F6 | I,P,P,C,I,R | all DENY | I,P,P,C,I,R | all DENY | ✅ |
| F7–F10 | I,I,P,I | DENY,DENY,DENY,DENY | I,I,P,I | DENY,DENY,DENY,DENY | ✅ |
| F11 | P | ADMIT_WITH_PENALTY | P | ADMIT_WITH_PENALTY | ✅ |
| F12 | R | DENY | R | DENY | ✅ |
| F13,F14 | I,I | DENY,DENY | I,I | DENY,DENY | ✅ |
| F15 | P | ADMIT_WITH_PENALTY | P | ADMIT_WITH_PENALTY | ✅ |
| F16 | I | DENY (subj. §7.4) | I | DENY | ✅ (the §7.4 qualifier is a shard-level behaviour, not a predicate-level policy value — correctly not represented as a fifth policy) |
| F17,F18 | I,I | DENY,DENY | I,I | DENY,DENY | ✅ |
| F19 | F | DENY | F | DENY | ✅ |
| F20 | P | DENY | P | DENY | ✅ |
| F21–F24 | I,I,I,I | DENY×4 | I,I,I,I | DENY×4 | ✅ |
| F25 | **C/R** | DENY | governed **R** (declared `"C/R"`) | DENY | ✅ — stricter half governs, per `assertRegister()`'s own rule, independently re-checked (below) |
| F26 | R | DENY | R | DENY | ✅ |
| F27 | **R/P** | DENY | governed **R** (declared `"R/P"`) | DENY | ✅ |
| F28–F31 | I,I,R,I | DENY×4 | I,I,R,I | DENY×4 | ✅ — F30 is R (regulatory: curfews/event closures), not I; independently re-checked against spec text, correct |
| F32 | F | DENY_UNLESS_ENVELOPE | F | DENY_UNLESS_ENVELOPE | ✅ |
| F33 | C | DENY | C | DENY | ✅ |
| F34,F35 | I,I | DENY,DENY | I,I | DENY,DENY | ✅ |
| F36 | P | DENY | P | DENY | ✅ |
| F37 | **F/C** | DENY when hard | governed **C** (declared `"F/C"`) | DENY | ✅ — the stricter half (C, an external contractual obligation) governs; correctly the predicate itself special-cases the soft/hard split rather than the register, since hardness is a per-mission fact the register cannot know |
| F38 | F | DENY | F | DENY | ✅ |

**All 38 rows match. Zero discrepancies found against an independent transcription of the
specification's own table.**

**The dual-class rule (A2) was independently checked, not merely read.** §7.5 gives three
predicates two classes: F25 `C/R`, F27 `R/P`, F37 `F/C`. `register.js`'s `declaredClass` field
preserves the specification's literal string in every case, and `assertRegister()`'s final check
(read at `register.js:262–276`) independently verifies that wherever `I` or `R` appears in that
declared string, the *governing* class is one of them — this review confirmed by hand that F25
(declared `C/R`, governed `R`), F27 (declared `R/P`, governed `R`), and F37 (declared `F/C`,
governed `C`) all satisfy this, and that the rule is enforced structurally (a future edit that
recorded, say, F25 as governed-`C` would fail `assertRegister()` at module load) rather than by
convention. This is the correct resolution: §7.2 makes I and R "never overridable," and governing
by the looser half of a dual-class predicate would let §7.3's mandatory-DENY rule be evaded by
recording the permissive reading.

### The volatile subset (§10.3.2 step 3), independently re-derived

Read directly from §7.5's own indeterminate column plus the volatile-subset prose at
`IMPLEMENTATION_EXECUTION_PLAN.md`'s Phase 6 checklist line 12 ("F7, F8, F10, F13, F14, F16, F17,
F18, F20, F34, F35"): this review independently marked which of the 38 rows are safety-relevant,
live-state, or capacity/exclusivity predicates most exposed to the routing-window race the audit
names, and arrived at the same eleven predicates *before* reading `volatileSubset.js`'s own
`SPECIFIED_SUBSET` constant. They matched exactly. `register.js`'s `volatile` boolean column was
then checked against this same list and matches on every row (F7✅ F8✅ F10✅ F13✅ F14✅ F16✅ F17✅
F18✅ F20✅ F34✅ F35✅, all others `false`).

### Cache tiers (§7.6), independently re-derived

§7.6 names three explicit ranges: F1–F12 (level 1, agent), F21/F25/F26/F28/F29 (level 2, class),
F22–F24 and F30–F38 (level 3, not cached). It does not explicitly classify F13–F20. `register.js`
places F13–F20 at `NONE` (not cached). This is not textually mandated by §7.6, but it is the only
defensible reading available: F13–F20 (connectivity, capacity, availability) are, by their own
rationale column in §7.5, live-state predicates that change every round or every heartbeat, so a
cache entry for them would either be stale on arrival or require an invalidation rule §7.6 never
states for this range. Treating them as level 3 (not cached) is conservative and consistent with
every one of them except F19 and F15 being marked `volatile` or `ADMIT_WITH_PENALTY` elsewhere in
the register — nothing in the implementation contradicts §7.6's explicit ranges, and the ambiguous
range is resolved in the direction §7.6 itself favours (§7.6's stated bias is toward correctness
over hit rate: "Caching too coarsely is a correctness hazard; too finely is only a lower hit
rate," per the implementer's own note, which this review independently agrees reads §7.6
correctly). Not a defect. Worth a one-line note in `register.js` for a future reader, but not
required.

**Verdict: PASS.** No architectural drift found in the register, the caching levels, or the
volatile subset. The dual-class governance rule (A2) is exactly right and enforced structurally,
not by convention.

---

## PART 4 — Database review

### 4.1 Independent regeneration of Prisma's own SQL

This review ran `npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma
--script` independently (no live Postgres was available in this environment either — the same
`P1000` limitation the implementation report discloses) and extracted the `RejectionAggregate` and
`NearMissSketch` `CREATE TABLE`/`CREATE INDEX` statements from the regenerated output. Compared
whitespace-normalised against the hand-written migration's equivalent statements:

```
$ diff <(tr -s ' \t' ' ' < regen_all_phase6.txt) <(tr -s ' \t' ' ' < hand_all_phase6.txt)
(no output — identical)
```

**Byte-for-byte identical**, independently reproduced. The claim in the implementation report's §6
is confirmed, not merely repeated.

### 4.2 Additivity, independently re-checked (not just diff --stat)

`git diff --stat -- prisma/schema.prisma` initially reports a large diff (606 insertions / 506
deletions) that would look alarming taken at face value for an "additive only" migration. This
review investigated rather than accepted the report's characterisation, and found the cause:
running `git diff --ignore-all-space` on the same file collapses to **103 insertions, 3
deletions**, and every substantive insertion is one of the two new models; the remaining ~500
lines either side are `prisma format`'s column-alignment re-wrap, triggered whenever any field
name's length changes anywhere in the file (confirmed by inspecting several of the reformatted
hunks — e.g. the `Zone` model's fields realign from an old alignment column to a new one with no
type, relation, or attribute changed). **This is legitimate collateral of running `prisma format`,
not a hidden schema change**, and this review flags it here precisely because it is the kind of
diff that looks like undisclosed scope creep on a superficial read and is not.

`prisma.migrate diff`'s regenerated file for the *entire* schema was also compared model-by-model
against the working tree's `schema.prisma` for the two new models only (Part 4.1) and no other
model's generated SQL differs from what a from-empty regeneration produces — meaning the
reformatting genuinely touched no semantics anywhere in the file, independently confirmed rather
than inferred from the whitespace-only diff alone.

### 4.3 CHECK constraints, independently re-derived

Five hand-written constraints, each re-derived from source rather than taken on trust:

- `predicateId ~ '^F([1-9]|[12][0-9]|3[0-8])$'` (both tables) — independently evaluated against
  the regex: matches F1–F9 (`[1-9]`), F10–F29 (`[12][0-9]`), F30–F38 (`3[0-8]`), and rejects F0 and
  F39+. This is exactly `register.js`'s `PREDICATE_COUNT = 38`, expressed as a regex rather than a
  literal enumeration — a defensible compression, and this review confirmed by hand that the three
  alternations partition 1–38 exactly with no gap and no overlap.
- `marginUnit IN ('count','ms','m','kg','Wh','prob','ratio','rank','degC')` — compared against
  `threeValued.MARGIN_UNIT`'s nine values directly; matches exactly, in the same order the object
  declares them.
- `bucketEnd > bucketStart` (both tables) — a correct backstop against the collision scenario the
  migration's own comment names (a zero-width bucket colliding on the unique key while describing
  a different period).

**Verdict: PASS.** No live-database application was possible (same environment limitation as every
prior phase since Phase 2); `prisma validate` passes; the SQL is independently confirmed to be
Prisma's own generated output plus exactly the five documented hand-written constraints.

---

## PART 5 — API review

`GET /api/diagnostics/rejections` read in full, including its controller, route file, and
middleware chain.

| Property | Verdict | Evidence |
|---|---|---|
| Behind existing auth, no new auth mechanism | **PASS** | `router.use(authUser)` in `diagnostics.routes.js`, the same middleware `legs.routes.js` and every other `/api` route uses. |
| Rate-limited | **PASS** | `createRateLimiter({ windowMs: 60_000, limit: 60, keyPrefix: "diag_rejections" })`, a dedicated key prefix so it cannot share a bucket with another endpoint. |
| Read-only | **PASS** | Controller body read in full: two `prisma....groupBy`/`findMany` calls, zero writes. |
| Input validation | **PASS, and stricter than the report describes** | `from`/`to` are parsed with `Date.parse` and rejected with 400 on `NaN`; the window is bounded to `MAX_WINDOW_MS` (30 days) to prevent an unbounded aggregation scan, a control the implementation report does not call out but this review verified is present and correctly ordered (checked *after* the `from < to` check, so a malformed window cannot both pass the ordering check and exceed the size check inconsistently). |
| No existing endpoint's shape changed | **PASS** | `git diff -- src/routes/index.js` shows only an added `require` and an added `router.use` line; no existing route's handler or path touched. |

**Verdict: PASS.**

---

## PART 6 — Runtime behaviour

| Claim | Verdict | Evidence |
|---|---|---|
| No round calls `evaluate.gate()` yet | **PASS** | `grep -rn "feasibility/evaluate\"\|require(\"\.\./feasibility/evaluate\|require(\"\.\./\.\./feasibility/evaluate" src/` outside `feasibility/`, `diagnostics.controller.js` (which imports `register`/`predicates/f34`/`rejectionTelemetry`, not `evaluate`), and the test suite → no production caller. |
| `createVolatileRecheck()` not wired into `commit.js` | **PASS** | Confirmed in Part 1 item 12 and independently via `grep` (Part 11): only `volatileSubset.js` itself, its tests, and `commit.js`'s doc-comment reference the symbol; `commit.js`'s actual dependency-injection call site (`commit.js:242`) still throws if `deps.volatileRecheck` is not a function, and nothing supplies one outside tests. |
| `server.js` unchanged | **PASS** | `git diff -- server.js` → empty. |
| Determinism (T6, I10) — no clock, no random, in the feasibility path | **PASS, independently re-scanned** | `grep -rn "Date\.now\|new Date(\|Math\.random" src/engine/feasibility/predicates/*.js src/engine/feasibility/*.js` → two matches, both inside a doc-comment in `threeValued.js` explaining *why* the module avoids the `new Date()` constructor form; zero matches in executable code. `epochMs()` uses `Date.parse`/`.getTime()` on a supplied value only. |
| Purity — order-independence | **PASS** | `feasibilityGate.test.js`'s `"the verdict is order-independent"` test read; independently reasoned about from `evaluate.js`'s `evaluateCandidate()` body, which threads no mutable state between predicate calls other than local accumulator variables scoped to the function call. |
| Backwards compatibility | **PASS** | Legacy lane 22/169, independently re-run (Part 11), unchanged from the pre-Phase-6 baseline the report cites. |

**Verdict: PASS.**

---

## PART 7 — Concurrency review

Phase 6 introduces no new concurrent-write surface of its own — the aggregator (Part 8) is
in-memory and per-round, and the flusher worker that would drain it to the database is written but
not scheduled (independently confirmed, Part 11). The one concurrency-relevant claim worth
checking is the negative cache's non-authority:

| Property | Verdict | Evidence |
|---|---|---|
| A cache read failure is a miss, never a verdict | **PASS** | `cache.js`'s `read()`, `recordRejection()`, `readRejection()` all wrap their `kv` calls in `try/catch` and return a miss/false on any error — read in full, independently traced through all three functions rather than sampled from one. |
| The negative cache cannot mask a re-evaluation | **PASS** | `negativeTtlSeconds()` returns `null` — a **refusal**, not a zero-length TTL — for any predicate in the volatile subset, and `write()`/`recordRejection()` both refuse to write an entry with no derivable TTL or no stamps. A caller that ignored the `null` return and cached anyway would be a caller-side defect; no such caller exists yet because nothing calls `cache.js` in production (Part 6). |
| Aggregator drain cannot double-count | **PASS** | `drain()` hands the accumulated maps over by reference and then calls `.clear()` on the same maps in the same synchronous call — read in full; there is no `await` between snapshot and clear, so no interleaving window exists within a single `drain()` invocation. Whether the *worker* that calls `drain()` is itself safe under concurrent invocation is Phase 10/15's question (the worker is not started), correctly out of this phase's scope. |

**Verdict: PASS** for what this phase actually introduces into the running system (nothing, by
design). No concurrency claim in the report was found to be premature.

---

## PART 8 — Implementation quality

- **The migration-generation discipline** (Part 4.1) and **the dual-representation subset check**
  (`SPECIFIED_SUBSET` vs. the register-derived `subset()`, Part 3) are the same pattern used
  throughout: a machine-checkable cross-reference between a literal transcription of the
  specification and a derived value, rather than a single source of truth that could silently
  drift. This is good practice and was independently useful to this review — it is exactly what
  let this review confirm the volatile subset without having to trust either representation alone.
- **The F34 exceedance-ratio resolution (A4)** is the correct fix for the problem it names.
  Independently re-derived: with targets at 1e-2, 1e-5, 1e-7, an absolute-margin comparison would
  make a T1 probability of 0.011 (10% over its own budget) always outrank a T3 probability of
  2e-7 (100% over *its* budget, i.e. double) as "more binding," which is backwards — the T3 case is
  the one with the catastrophic consequence. The ratio comparison fixes this, and the fix is
  applied consistently in both the `satisfied` and `violated` branches (the "worst" tier is
  selected by exceedance ratio in both), which this review checked because a fix applied to only
  one branch is a common class of defect in this kind of code.
- **The A5 decision (per-predicate indeterminate policy as code, not config)** was independently
  weighed against the plan's literal text, which does list it under "Configuration updates." This
  review's own reading agrees with the implementer's: §7.2 states class I and R are "never
  overridable by anyone, including operators and manual assignment," and a config key capable of
  changing a class-I predicate's policy from `DENY` to something permissive would be exactly such
  an override, reachable by anyone with config-publish access rather than only by "operators." The
  plan's own precedence rule ("where this plan and the specification appear to disagree, the
  specification wins and this plan is defective," `IMPLEMENTATION_EXECUTION_PLAN.md:7`) supports
  reading it this way. Flagged, correctly, for Safety review rather than presented as
  self-evidently correct — appropriate given it is a judgment call on an underspecified plan line,
  not a specification requirement.
- **No dead code, no unreachable branches found** in the seven core modules or the nine predicates
  read in full. The `default:` case in `applyPolicy()`'s switch (unreachable because
  `assertPolicyLawful` already rejects an unknown policy) is explicitly commented as defence for a
  future policy added without a corresponding case — a reasonable and disclosed reason to keep
  otherwise-dead code.

**Verdict: PASS.** No implementation-quality defect found across the modules read in full.

---

## PART 9 — Findings, independently sought

This review actively looked for a defect of the shape Phase 5's review found (a logic error in one
comparison, disagreeing with a parallel correct implementation elsewhere) by cross-checking every
predicate that has more than one plausible reading against both the specification text and, where
one exists, a second consumer of the same fact. None was found. The candidates this review checked
most aggressively, and why each cleared:

- **F34's binding-tier selection**, cross-checked in both the `violated` and `satisfied` branches
  (Part 8) — consistent.
- **F10's corroboration ordering**, cross-checked against the stated requirement that a
  disagreeing corroborator must dominate a high confidence reading — the code evaluates
  corroboration before the confidence comparison and returns `VIOLATED` on disagreement
  unconditionally, independent of the confidence value — correct.
- **The dual-class governance rule**, cross-checked by hand against all three affected predicates
  (Part 3) — correct in all three cases, and enforced structurally rather than by convention.
- **The negative-cache/volatile-subset interaction** — a predicate that is both volatile and
  otherwise eligible for negative caching could, if wired wrong, have its rejection cached with a
  guessed TTL. Checked: `negativeTtlSeconds()` checks `entry.volatile` **before** consulting any
  TTL map, so this is structurally impossible, not merely untested.
- **The systemic guard's interaction with a candidate that is both `VIOLATED` and
  `INDETERMINATE` on different predicates** — checked against `evaluateCandidate()`'s
  `deniedForIndeterminacyOnly` flag, which is `true` only when `anyDeniedForIndeterminacy &&
  !anyViolated`. A candidate denied on both grounds correctly does not count toward the guard's
  trip fraction, matching §7.4's own caveat ("solely due to INDETERMINATE").

**No findings to report.** This is stated plainly rather than manufactured: the checklist,
architecture-compliance, and implementation-quality reviews above are the record of what was
checked, and nothing in that record rose to a defect.

---

## PART 10 — Regression review

Legacy lane: **22 suites, 169 tests**, independently re-run (Part 11), identical to the
pre-Phase-6 baseline the implementation report cites (`PHASE_5_IMPLEMENTATION_REPORT.md`'s own
"after" figures). The two files the plan marks "replaced" were diffed directly rather than
sampled:

- `src/services/robotValidator.service.js` — `git diff` shows only a prose banner inserted before
  the file's existing docblock; the executable code (six checks: online, IDLE/CHARGING, no active
  task, percentage battery floor, no active fault, socket auth) is untouched, character for
  character, after the inserted comment block.
- `src/config/logger.js` — same pattern: a banner inserted immediately before `rootLogger.dtaro`'s
  existing function body, which is untouched.

**Verdict: PASS.** Zero regression risk from either "superseded" file, independently confirmed
rather than taken on the report's word.

---

## PART 11 — Build and test review (reproduced independently, not read from the report)

Every command below was run by this review against the unmodified working tree, with the shell's
own output captured verbatim (elided only for length where noted):

```
$ npm run gates
gate: tier-dependencies (§1.8 rule 2)
  PASS — 168 module(s), 162 governed import edge(s), no Tier 0/1 → Tier 2 dependency.
gate: parameter-register (§22, Appendix A)
  PASS — 93 engine module(s) checked against 160 registered parameter(s); no bare behavioural constants.
gate: tenets (T1 type separation, T6 decision-path determinism)
  PASS — 165 module(s) checked, no violations.

$ npm run test:engine
Test Suites: 36 passed, 36 total
Tests:       1332 passed, 1332 total

$ npm run test:gates
Test Suites: 3 passed, 3 total
Tests:       49 passed, 49 total

$ npm run test:legacy
Test Suites: 22 passed, 22 total
Tests:       169 passed, 169 total
```

**Every number in the implementation report's §12 table is reproduced exactly**: 3/3 gates,
36/1332 engine, 3/49 gates lane, 22/169 legacy, 1550 total.

**The "315 new tests" headline was independently reconciled, not merely repeated.** Running the
four new suites together:

```
$ npx jest --selectProjects engine tests/engine/feasibilityPredicates.test.js \
    tests/engine/feasibilityGate.test.js tests/engine/feasibilityTelemetry.test.js \
    tests/engine/feasibilitySchema.test.js
Test Suites: 4 passed, 4 total
Tests:       314 passed, 314 total
```

314, not 315 — a one-test gap against the headline figure. This review traced the gap rather than
flagging it as a discrepancy: `git diff -- tests/engine/commitmentSchema.test.js` (Part 1 item 12
context) shows one pre-existing test replaced by two ("no Phase 6+ table appears" →
"no Phase 7+ table appears" plus a new "Phase 6's two rejection-telemetry tables are present"), a
net +1 test in a *modified* file that is not one of the "four new suites." 314 + 1 = 315. **The
headline figure is correct; it was just not decomposable from the four-suite breakdown table
alone**, which this review notes as a minor presentation gap in the report, not a numerical error.

**Predicate registry and volatile-subset self-checks**, run directly rather than only through
Jest:

```
$ node -e 'const r=require("./src/engine/feasibility/register"); console.log(r.assertRegister())'
{ ok: true, problems: [] }
$ node -e 'const v=require("./src/engine/feasibility/volatileSubset"); console.log(v.assertSubset())'
{ ok: true, problems: [] }
```

**Sole-caller scan for `brandFeasible`**, run directly:

```
$ grep -rn "brandFeasible" --include="*.js" src/ | grep -v node_modules
src/engine/feasibility/evaluate.js:17 (doc)
src/engine/feasibility/evaluate.js:19 (doc)
src/engine/feasibility/evaluate.js:56 (import)
src/engine/feasibility/evaluate.js:168 (doc)
src/engine/feasibility/evaluate.js:210 (call site)
src/engine/guards/tenets.js:12 (doc)
src/engine/guards/tenets.js:66 (definition)
src/engine/guards/tenets.js:361 (export)
```

Exactly one call site, confirming Part 1 item 16 independently of the test suite that also asserts
this.

**Verdict: PASS.** Every quantitative claim in the implementation report's test and gate sections
was independently reproduced and matches.

---

## PART 12 — Failure analysis

Nothing in Phase 6 is wired into a running path (Part 6), so there is no failure mode to analyse
for the shard, the commit path, or dispatch — those remain exactly as Phase 5 left them, and this
review's own re-run of the legacy and gates lanes (Part 11) confirms no regression there. The one
failure mode worth naming explicitly, because it is the direct consequence of the Part 2 finding:

**If the feasibility gate were wired into a round today (it is not), every candidate would be
denied**, because F22–F26/F34/F35 would return `INDETERMINATE` on every evaluation (no Phase 7
producer exists) and, under class I, deny. §7.4's systemic guard would correctly trip — more than
30% of candidates rejected solely for indeterminacy is not a plausible outcome here, it is a
certainty — and the shard would enter Restricted Operation, then, after `degraded.max_duration`,
halt new commitments pending operator acknowledgement. This is the conservative failure mode §7.4
is designed to produce, not a defect, and it is the reason Phase 6 is correctly not wired into
anything yet: the gate is complete and correct in isolation, and completing it in isolation was
the deliberate scope boundary, not an oversight.

---

## PART 13 — Evidence summary

- 7 core feasibility modules read in full: `threeValued.js`, `register.js`, `evaluate.js`,
  `systemicGuard.js`, `cache.js`, `volatileSubset.js`, `rejectionTelemetry.js`.
- 9 of 38 predicate modules read in full, chosen to cover every indeterminate policy
  (`DENY`, `DENY_UNLESS_ENVELOPE`, `ADMIT_WITH_PENALTY`), every dual-class predicate's sibling
  behaviour, the Phase-7-input-consuming pattern, and the two most safety-sensitive predicates
  (E-stop, localisation): F7, F10, F11, F16, F17, F22, F32, F34, F37.
- `register.js`'s all-38-row class/policy/cache-tier/volatile assignment independently
  transcribed from `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` §7.5 and compared cell-by-cell — zero
  discrepancies.
- Migration SQL independently regenerated via `prisma migrate diff --from-empty` and diffed
  byte-for-byte (whitespace-normalised) against the hand-written migration.
- Every file the report claims as "additive" or "banner only" diffed directly:
  `schema.prisma` (confirmed reformatting-only beyond the two new models),
  `robotValidator.service.js` (banner only), `logger.js` (banner only), `routes/index.js`
  (additive), `robotStateCache.js` (additive), `supplementary.json` (+7 parameters, 0 removed, 0
  semantically changed, confirmed via structural JSON diff, not text diff).
- All three build gates and all three test lanes re-run from a clean invocation; every number
  matches the report exactly.
- `assertRegister()` and `assertSubset()` invoked directly outside the test harness.
- Sole-caller property for `brandFeasible` re-derived via direct `grep`, independent of the test
  that also asserts it.
- Directory listings for `energy/`, `payload/`, `routing/`, `plan/`, `cost/`, `solve/`,
  `candidates/` independently confirm the Phase 7/8 non-leakage claim.

---

## PART 14 — FINAL DECISION

# PASS WITH MINOR ISSUES

Eighteen of eighteen checklist items pass. The register, the systemic guard, the cache, the
volatile subset, the telemetry, and the nine predicates read in full are all faithful to §7 —
in several places (F34's exceedance ratio, F10's corroboration ordering, the dual-class
governance) more carefully reasoned than a literal reading of the specification alone would
require. Independent reproduction of every gate and every test number, and independent
regeneration of the migration SQL, found no gap between what was claimed and what is true.

### Issues

**1. (MEDIUM, process/sequencing) The plan's stated hard prerequisite — Phase 7 — was not
implemented before Phase 6, contrary to `IMPLEMENTATION_EXECUTION_PLAN.md:471`'s explicit
`Prerequisites: Phases 1, 2, 7`.**
*Affected:* the phase as a whole; concretely, predicates F22–F26, F34, F35.
*Independently confirmed consequence:* conservative, not unsafe — every affected predicate denies
(never admits) in the absence of its Phase 7 input, and no Phase 7 functionality was written under
cover of the decision. The claimed precedent (Phase 5) is weaker than stated — Phase 5 was not
formally blocked on Phase 7 the way Phase 6 is — though the underlying coding pattern (declared
inputs, `INDETERMINATE`-and-deny on absence) is sound regardless.
*Recommendation:* Phase 7 should be implemented next, both because it is next in the plan's
original order and because Phase 6 cannot be integration-tested — nor made usable — without it.
No rework of Phase 6's predicates is anticipated; `feasibilityFixture.js` is a concrete, checkable
statement of the contract Phase 7 must satisfy.

**2. (LOW, documentation) The claimed Phase 5 precedent for consuming Phase 7 artefacts overstates
what Phase 5's own prerequisites actually required.**
*Affected:* `PHASE_6_IMPLEMENTATION_REPORT.md` §10.2's framing only; no code.
*Recommendation:* none required; noted for the record.

**3. (LOW, documentation) The "315 new tests" headline is not directly decomposable from the
report's own four-row breakdown table (which sums to 314); the missing test is a net +1 inside a
modified file, `commitmentSchema.test.js`, not counted among the "four new suites."**
*Affected:* `PHASE_6_IMPLEMENTATION_REPORT.md` §12 only; the total is correct.
*Recommendation:* none required; noted for the record.

**4. (LOW, Safety-review item, correctly already flagged by the implementer) Per-predicate
indeterminate policy is declared in code (`register.js`), not in the Config Service, departing
from the plan's literal listing of it under "Configuration updates."**
*Affected:* `register.js`.
*Independent assessment:* the correct reading of §7.2 given the "never overridable by anyone"
requirement for class I/R; recommend Safety formally ratify this reading so it is a settled
decision rather than a standing question by Phase 15.

**5. (Informational, not a defect, already disclosed) The migration has not been applied to a live
database; no Postgres was reachable in this review's environment either.** Same limitation as
every phase since Phase 2; not blocking, as in every prior phase's review.

### Phase 7 may begin.

None of the above blocks it — issue 1 is, if anything, the argument for starting Phase 7
immediately rather than a reason to withhold sign-off on Phase 6, since Phase 6's own deliverable
is complete, correct, and inert on its own terms, and Phase 7 is what makes it usable.

---

## Appendix — Commands and scripts run for this verification (reproducible)

```bash
# Directory / leakage checks
find Backend/src/engine/feasibility -type f | sort
find Backend/src/engine/energy Backend/src/engine/payload Backend/src/engine/routing Backend/src/engine/plan -type f
find Backend/src/engine/cost Backend/src/engine/solve Backend/src/engine/candidates -type f

# Static checks
grep -rhn "require(" Backend/src/engine/feasibility/predicates/*.js | sort -u
grep -rln "Date\.now\|new Date(\|Math\.random" Backend/src/engine/feasibility/predicates/*.js Backend/src/engine/feasibility/*.js
grep -rn "brandFeasible" --include="*.js" Backend/src/
grep -rn "createVolatileRecheck|volatileRecheck" --include="*.js" Backend/src/
grep -rn "rejectionAggregation.worker" Backend/server.js Backend/src/workers/*.js

# Diffs (run from Backend/)
git diff --stat -- prisma/schema.prisma
git diff --ignore-all-space -- prisma/schema.prisma
git diff -- src/services/robotValidator.service.js src/config/logger.js src/routes/index.js \
  src/cache/robotStateCache.js server.js
git diff -- tests/engine/commitmentSchema.test.js tests/engine/phase0Scaffold.test.js

# Migration regeneration and comparison
npx prisma validate
npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script

# Parameter-register structural diff (Node, not text diff)
node -e "const fs=require('fs');const old=JSON.parse(require('child_process')
  .execSync('git show HEAD:Backend/src/engine/config/register/supplementary.json').toString())
  .parameters; const now=JSON.parse(fs.readFileSync(
  'src/engine/config/register/supplementary.json','utf8')).parameters; /* diff by name, then by
  JSON.stringify equality per matched name */"

# Gates and test lanes
npm run gates
npm run test:engine
npm run test:gates
npm run test:legacy
npx jest --selectProjects engine tests/engine/feasibilityPredicates.test.js \
  tests/engine/feasibilityGate.test.js tests/engine/feasibilityTelemetry.test.js \
  tests/engine/feasibilitySchema.test.js

# Direct module self-checks, outside Jest
node -e 'console.log(require("./src/engine/feasibility/register").assertRegister())'
node -e 'console.log(require("./src/engine/feasibility/volatileSubset").assertSubset())'
```

*End of Phase 6 Independent Verification Report.*

---

# ADDENDUM — Closure re-verification, 2026-08-17

*Appended at Phase 6 closure. Nothing above this line has been altered. In particular, the
`PASS WITH MINOR ISSUES` verdict, the five issues, and Part 2's finding that a plan-stated hard
prerequisite was not honoured are preserved exactly as recorded on 2026-08-04. They were correct
then and the record of them is not rewritten now.*

**Closure verdict: PHASE 6 CLOSED.** Full evidence in `PHASE_6_REMEDIATION_AND_CLOSURE.md`.

## Disposition of this review's five issues

| # | Issue as recorded | Disposition at closure |
|---|---|---|
| 1 | MEDIUM — Phase 7 was a hard prerequisite and was not implemented first | **RESOLVED.** Phase 7 is implemented and independently verified (21/21, `PASS WITH MINOR ISSUES`). This review's recommendation — "Phase 7 should be implemented next … Phase 6 cannot be integration-tested without it" — was followed, and the integration test it called for now exists: `feasibilityPhase7Integration.test.js`, 26 tests, every plan built by running the real producers. This review's prediction that "no rework of Phase 6's predicates is anticipated" was **very nearly** right: one predicate, F34, needed a change, for a reason only composition could expose (R1 below). |
| 2 | LOW — the claimed Phase 5 precedent was overstated | **STANDS.** Re-checked against `IMPLEMENTATION_EXECUTION_PLAN.md:442`; this review's reading was correct. Documentation only, no action. |
| 3 | LOW — "315 new tests" not decomposable from the four-row table | **STANDS.** Re-checked; the total was correct. The closure report states its own decomposition explicitly so the same gap is not reintroduced. |
| 4 | LOW — indeterminate policy in `register.js`, not the Config Service | **ASSESSED AND CONFIRMED COMPLIANT.** The closure examined whether the architecture actually satisfies the frozen requirement rather than deferring again, and agrees with this review: §7.2's "never overridable by anyone, including operators and manual assignment" is incompatible with a config key that could change a class I policy. Additionally proven non-decorative by planting a class I predicate declaring `ADMIT` — the register rejects it and `evaluate.js` refuses to load. Remains an item for formal Safety ratification. |
| 5 | Informational — no live database | **RESOLVED.** The full migration chain has been applied to a disposable PostgreSQL 18.3 cluster on port 55432, and Phase 6's two tables and five CHECK constraints were exercised against it (17 live checks, all passing). This is how R2 was found. |

## Two defects this review did not find, and why

Both were on the permissive side of a safety boundary, and neither was reachable by the methods this
review used — which were sound, and are not being criticised here; they are being characterised, so
the next review knows where to point a different instrument.

**R1 — F34 and `energy/tiers.js` transposed the SLA-class index of `energy.shortfall_probability`.**
This review checked Part 1 item 8 and Part 8 that F34's binding-tier selection was consistent across
its own two branches, which it was. The defect was not inside F34 and not inside the producer; it
was in the *relationship* between two modules that did not yet both exist, and it is invisible under
the flat tier-keyed map published today. Under a class-keyed map, F34 returned `SATISFIED` against
the fleet default while the energy model called the plan infeasible — a false positive on a class I
predicate. Found by running one module through the other under every map shape the configuration
system permits. Fixed; five regression tests.

**R2 — the aggregation flusher threw for 37 of the 38 predicates.** This review's Part 1 item 13 and
Part 7 correctly established that `record()` and `retainRow()` are distinct paths called in the
right order, and that `drain()` cannot double-count. All true. What no static reading could reach is
that `RejectionAggregate`'s compound unique key contains four dimensions that are NULL in the
ordinary case, that PostgreSQL's UNIQUE default is `NULLS DISTINCT`, and that the client refuses a
compound-unique `where` containing a NULL. The flush did not fragment — it *threw*, so §7.7's
"exact over 100 % of decisions" held for F34 alone. It went unseen because the single flush test
drove F34, the one predicate of the 38 that always carries a tier, against a mock that accepted any
argument shape. Both halves of that were needed for it to hide. Fixed by a parameterised
`ON CONFLICT` upsert against a `NULLS NOT DISTINCT` index; four regression tests; the mock is now
strict.

## Everything this review verified that closure re-verified and confirmed

The 18/18 checklist, the 38-row register transcription, the volatile subset, the cache tiers, the
dual-class governance, the sole-caller property for `brandFeasible`, and the determinism scan were
all independently re-derived at closure and **found correct exactly as this review reported them**.
Three properties were additionally strengthened from *asserted* to *proven*: the I14 bypass now
fails a planted violation in `src/engine/cost/` (and passes when it is removed); the register and
volatile-subset self-checks now catch five planted defects out of five; and the brand is shown to
survive no copy path — spread, JSON round trip, `Object.assign`, `structuredClone` — and to be
unforgeable by re-branding.

*End of addendum.*
