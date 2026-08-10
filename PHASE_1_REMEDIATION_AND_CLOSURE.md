# Phase 1 — Remediation and Closure

**Scope:** the seven findings of `PHASE_1_INDEPENDENT_VERIFICATION.md`, plus the database
verification gap that report inherited.
**Date:** 2026-08-10 · **Branch:** `feature/dashboard` · **HEAD at remediation:** `62d8141`
**Authority order applied:** `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` (FROZEN) → `IMPLEMENTATION_EXECUTION_PLAN.md`
→ repository/code → independent verification report → implementation report.

> **This document does not replace `PHASE_1_INDEPENDENT_VERIFICATION.md`.** That report's
> original findings are preserved verbatim; this is the remediation record laid alongside
> them. Where remediation found the verification report itself to be wrong (Finding 5), the
> original text is left standing and corrected here, with the evidence.

> **No Phase 2 functionality was introduced.** No domain model, no `Agent`/`Mission`/`Leg`/
> `Stop`, no commitment model, no solver, no routing migration. The frozen specification was
> not modified. No gate was weakened. No test was deleted, skipped, or re-baselined.

---

## 0. Status summary

| # | Finding | Classification | Status |
|---|---|---|---|
| 1 | `fixedPoint.toMilliCU()` misrounds exact decimal half boundaries | Implementation defect | ✅ **FIXED** |
| 2 | `POST /api/config/publish` returns 500 for malformed input | Implementation defect | ✅ **FIXED** |
| 3 | Exported Phase 1 functions lack direct test coverage | Coverage gap | ✅ **FIXED** (+ one further defect found and fixed) |
| 4 | `cost.reference_agent_class` undercounted in the report | Documentation | ✅ **DOCUMENTATION CORRECTED** |
| 5 | Baseline commit citation inaccurate | Documentation | ✅ **DOCUMENTATION CORRECTED** — *the verification report's own claim was the inaccurate one* |
| 6 | §22.2 post-`site` branch precedence | Architecture ambiguity | ⚠️ **ARCHITECTURE AMBIGUITY — EXPLICITLY DOCUMENTED, NOT RESOLVED** (exposure has grown; see §6) |
| 7 | V9 combined conservatism rejects the seeded defaults | External decision | ⚠️ **VERIFIED / NO DEFECT — EXTERNAL SAFETY DECISION REQUIRED** |
| DB | Migration and immutability triggers never executed | Environmental | ✅ **EXECUTED** — 18/18 against a disposable PostgreSQL 18.3; one residual limitation stated in §8 |

**Two findings remain open by design.** Finding 6 is an ambiguity in the frozen specification
that no implementation phase has the authority to resolve. Finding 7 is a Safety-class
decision with a named owner. Both are preserved, tested, and escalated — neither is closed.

---

## 1. Finding 1 — `fixedPoint.toMilliCU()` rounding

### Original finding
> Brute-force testing ~1.3M exact-half-boundary milli-CU values found **738–3,934 cases
> (≈0.2–0.4%) where `toMilliCU()` rounds toward zero instead of away from zero**, due to
> IEEE754 representation error in the `cu * 1000` intermediate.

**Confirmed.** Reproduced exactly, including the verifier's own example.

### Root cause

`toMilliCU()` scaled by multiplying and then compared the product against `0.5`:

```js
const scaled = cu * MILLI_PER_CU;
const rounded = scaled >= 0 ? Math.floor(scaled + 0.5) : Math.ceil(scaled - 0.5);
```

A float64 cannot hold most decimal fractions exactly, so `cu * 1000` is not the mathematical
product. Measured directly:

```
-32.7615 * 1000  ===  -32761.499999999996     // not -32761.5
```

The product of an exact decimal half boundary therefore lands *below* the boundary, and
`Math.ceil(scaled − 0.5)` rounds it **toward** zero — the opposite of the stated
`ROUND_HALF_AWAY_FROM_ZERO`. No epsilon fixes this: any epsilon large enough to rescue this
case misrounds a neighbouring one.

### The supported input representation, identified

Required by the remediation brief, and now stated in the module header. `toMilliCU()` accepts
a JavaScript `number`. The values that actually reach it are of two kinds:

- **Decimal quantities** — exchange rates and cost figures, which §1.3 requires to be
  "traceable to an accounting figure" and which are written and reviewed as decimals
  (`0.0035` CU·Wh⁻¹, a `-32.7615` CU credit). Every seeded cost value in the register is one.
- **Float estimates** from continuous arithmetic upstream, which §9.6 requirement 1 names.

The conversion must be correct for the decimal reading of the float64 it is given, because
that is what every register value and every operator-entered figure is.

### Fix

`Backend/src/engine/determinism/fixedPoint.js` — the scaling is now **exact, in base ten, with
no float arithmetic at all**:

1. `decimalParts(value)` reads `String(value)`. ECMA-262 specifies this as the shortest
   decimal that round-trips to the same float64 — a total, deterministic, host-independent
   function — and parses it into an exact `(negative, digits: BigInt, exponent)` triple.
2. The milli- prefix is a *decimal* prefix, so scaling is `exponent + 3`, not a multiply.
3. Rounding is the exact integer comparison `2·remainder ≥ denominator`, taken on the
   **magnitude**, with the sign reattached afterwards and never participating — which makes
   negation symmetry hold by construction rather than by coincidence.

Both conversions in the module now funnel through one function,
`roundScaledHalfAwayFromZero()`, so "which rounding did this use?" is answered by one
implementation rather than one per call site. `scaleByRate()` was moved onto it too.

**What was preserved:** the rounding mode name and semantics; integer milli-CU
representation; overflow-as-error; negation symmetry; determinism. **What improved:**
determinism is strengthened, because no float intermediate remains to vary; and the
representable range widens from the float64 *safe-integer* range to `int64` — the width §9.6
actually specifies — because the old guard existed only to protect a float intermediate that
no longer exists. Overflow past `int64` is still a `RangeError` via `assertInt64`.

### Regression tests

`Backend/tests/engine/determinism.test.js` — new describe block, **16 tests**:

positive exact half boundaries · negative exact half boundaries · immediately below ·
immediately above · zero and negative zero · ordinary non-boundary values (pinning that the
fix moved nothing else) · representative real cost values · very large values · overflow ·
the verifier's own reproduction case · spelling-independence · **two property tests**, one
sweeping 40,000 consecutive exact half boundaries and one sweeping 60,000 mixed-magnitude
values at 3, 4 and 5 decimal places, both asserting `toMilliCU(-x) === -toMilliCU(x)`.

### Verification evidence

Fresh sweep against the fixed module:

```
verifier example -32.7615 -> -32762   (want -32762)     ✓
verifier example  32.7615 ->  32762   (want  32762)     ✓
exact half-boundary sweep, 800 000 cases, wrong = 0
negation asymmetries over 400 000 half-boundaries = 0
overflow still an error: RangeError: milli-CU overflow in toMilliCU
```

The same sweep against the **old** implementation: `5 900 / 800 000 wrong`, first failures
`0.5005, 0.5015, 0.5025, 0.5035, 0.5045`. Ordinary (non-boundary) 3-decimal values, 300 000
sampled: **zero divergence** between old and new — the fix corrects half boundaries and
nothing else.

**No later-phase regression.** The full engine lane — **115 suites, 5 994 tests**, covering
every phase through 15 — passed unchanged immediately after this fix and before any other
change.

### Final status — **FIXED**

---

## 2. Finding 2 — `POST /api/config/publish` returns 500 for malformed input

### Original finding
> Sending `{"killSwitchState": {"not_a_real_switch": true}}` or a binding with an
> unrecognized `level` returns **`500 {"message":"Internal Server Error"}`**, not the
> documented/tested 422-with-findings.

**Confirmed and reproduced**, including a controlled counterfactual (below).

### Root cause

`killSwitches.normaliseState()` and `resolver.indexBindings()` threw a plain `Error` for
invalid input, and both run inside `buildSnapshot()` → `validateCandidate()` → `publish()` —
**entirely upstream** of the controller's boundary:

```js
catch (error) {
  if (error instanceof configService.ConfigValidationError) { /* 422 + findings */ }
  throw error;   // → 500
}
```

The boundary discriminates on error *type*, and the type said "unexpected fault". An
operator's typo in a switch name or a scope level — both entirely plausible — was reported as
a server fault and bypassed the endpoint's own designed, tested contract.

**A third site of the same class was found during remediation** and is fixed with the other
two: `regimes.activeRegime()` threw a plain `Error` for two simultaneously active regimes,
and `regimes` is also caller-supplied on this endpoint.

### Fix

New module `Backend/src/engine/config/errors.js` holding `ConfigValidationError`. It lives in
its own module because the three modules that detect malformed input are ones `service.js`
depends on; an error type they all import must sit below all of them. `service.js` re-exports
it, so `configService.ConfigValidationError` remains the name callers already use.

The three throw sites now raise it with **structured findings in the same shape
`validators.js` emits** (`{ id, severity, rule, message }`), so a caller reads one structure
regardless of which stage rejected the publish:

| Site | Finding id | Rule | Rejects |
|---|---|---|---|
| `killSwitches.normaliseState()` | `P5` | §22.5 | unknown switch name(s); a state that is not an object |
| `resolver.indexBindings()` | `P6` | §22.2 | a binding naming a non-§22.2 level; a binding that is not an object |
| `regimes.activeRegime()` | `P7` | §22.2 | a non-array `regimes`; a non-object regime; two active regimes |

Each site collects **every** problem before throwing, so one round-trip reports them all. Each
summary message carries the first problem verbatim, so a caller reading only `error.message`
still learns what is wrong — which preserves the two existing assertions that match on it.

**This is not a catch-all.** Nothing was widened; each throw site names the specific input it
rejected. A plain `Error` from a config module still means "something unexpected went wrong"
and still surfaces as a 500. Auth, valid-publish, Safety-class approval, and the V1–V10/A1–A3
matrix are untouched.

### Regression tests

**HTTP** — `Backend/tests/engine/configApi.test.js`, new describe block, **8 tests**: unknown
kill-switch name → 422 + findings · malformed kill-switch shape → 422 · invalid binding level
→ 422 · invalid binding type → 422 · no stack trace or internal path in the body · **genuine
internal error still → 500** · valid publish still → 200 · business-rule rejection still →
422 with `V5`.

Each test presents its own `X-Forwarded-For`, because the publish route's rate limit is
10/minute per client. **The rate limit is production behaviour and was left exactly as it
is** — the tests work within it rather than around it.

**Service level** — `Backend/tests/engine/configService.test.js`, new describe block,
**11 tests**, including multi-problem batching, regime shape, valid publish unaffected, V5
still reached, and **a genuine store fault propagating unconverted**.

### Verification evidence

Counterfactual, run to prove the tests actually catch the original defect. `killSwitches.js`
was temporarily reverted to `throw new Error(...)` and the new HTTP tests re-run:

```
expected 422 "Unprocessable Entity", got 500 "Internal Server Error"
expected 422 "Unprocessable Entity", got 500 "Internal Server Error"
Tests: 2 failed, 17 skipped, 6 passed, 25 total
```

Exactly the failure the verifier reported. The fix was then restored and the file
byte-verified:

```
Test Suites: 1 passed, 1 total
Tests:       25 passed, 25 total
```

Both halves of the contract hold: malformed input is a 422 with findings, and a genuine
internal fault is still a 500 carrying no findings and no internal detail.

### Final status — **FIXED**

---

## 3. Finding 3 — exported Phase 1 functions lack direct test coverage

### Original finding
> `fixedPoint.subtract()`, `multiplyByCount()`, `ordering.compareColumns()`,
> `ordering.thenBy()`/`descending()`, `snapshot.deepFreeze()`/`captureDecisionTime()` are
> exported but have no direct test coverage.

**Confirmed.** All seven now have focused tests written against their actual contracts.

### Fix and regression tests

`Backend/tests/engine/determinism.test.js` — **26 tests** across five new describe blocks:

| Function | Tests | Contract pinned |
|---|---|---|
| `subtract()` | 4 | normal · across zero · two negatives · exact inverse of `add` · overflow both directions · float refused |
| `multiplyByCount()` | 5 | BigInt and number counts · zero count · negative count (signed arithmetic, not a refusal) · non-integer count refused rather than truncated · overflow · float refused |
| `thenBy()` | 3 | later comparators consulted only on ties · no comparators ties everything · composition is associative |
| `descending()` | 3 | reverses verdicts · is its own inverse · absent values still sort last, not first |
| `compareColumns()` | 5 | orders by canonical identity · leg-list order cannot reach the comparator · distinguishes insertion positions · is a total order · absent legs/positions treated as empty |
| `deepFreeze()` | 5 | freezes at every depth · mutation at depth throws · returns its argument · passes primitives through · terminates on a cycle |
| `captureDecisionTime()` | 3 | epoch ms within bounds · usable directly as the snapshot pin · the captured time is an input, never re-read |

### Two things testing revealed

**A real defect, fixed.** `deepFreeze()` recursed into children *before* freezing the node, so
its `Object.isFrozen` short-circuit could never fire on a cycle and a cyclic graph overflowed
the stack. Freezing before recursing is behaviour-identical for every acyclic graph (freezing
a parent does not prevent freezing its children) and makes the short-circuit terminate a
cycle. Fixed in `Backend/src/engine/determinism/snapshot.js`, with the reasoning recorded in
the docstring.

**A non-defect, documented rather than "fixed".** `descending()` returns `-0` for a tie,
because it negates `0`. This is *not* a defect: `-0 === 0`, so both `thenBy` (`verdict !==
EQUAL`) and `Array.prototype.sort` treat it as equal. The test asserts equality by value and
says why over-specifying the sign of zero would pin an artefact rather than a behaviour. No
implementation change was made.

### Final status — **FIXED** (coverage added; one further implementation defect found and fixed)

---

## 4. Finding 4 — `cost.reference_agent_class` documentation

### Original finding
> The implementation report's Assumption 3 claims "twelve parameters were added that Appendix
> A does not tabulate". There is in fact a **thirteenth** — `cost.reference_agent_class`.

**Confirmed against the register and the specification**, and the parameter is correctly
registered. Verified at the Phase 1 commit `4244b3d`, which is the state the report describes:

```
appendixA.json: 89   cost.json: 29   killSwitches.json: 12   supplementary.json: 12   legacy.json: 6
§8.10 tabulates 29 parameter names
does §8.10 tabulate cost.reference_agent_class?  false
does §8.10 tabulate cost.cu_per_currency_unit?   true
§8.10 names not in cost.json:  [ 'candidate.optimality_tolerance_cu' ]
cost.json names not in §8.10:  [ 'cost.reference_agent_class' ]
```

`cost.reference_agent_class` is registered in `cost.json`, sourced from **§1.3**'s prose
("where the reference class and its cost are configuration"), as `STRUCTURAL` /
`UNCALIBRATED` / `required: true`. §8.10's `candidate.optimality_tolerance_cu` is registered
in `appendixA.json` because Appendix A tabulates it too — so nothing is missing in either
direction, which is what `configRegister.test.js` already asserts.

### Fix — documentation only

`PHASE_1_IMPLEMENTATION_REPORT.md` Assumption 3 corrected from twelve to **thirteen**, naming
`cost.reference_agent_class`, its §1.3 source, and the fact that it lives in `cost.json`
rather than `supplementary.json`. §3.1's register table annotated with the same fact. **The
parameter itself was not changed** — the register was right and the prose was wrong.

### Final status — **DOCUMENTATION CORRECTED**

---

## 5. Finding 5 — baseline commit documentation

### Original finding
> Both `IMPLEMENTATION_EXECUTION_PLAN.md` and the Phase 0/Phase 1 reports cite **baseline
> commit `e558243`**. `git log` shows `e558243` is not HEAD's parent — HEAD (`4244b3d`) sits
> one commit ahead of it […]

### What the repository history actually shows

The verification report's claim is **factually incorrect, and self-contradictory**: "sits one
commit ahead of it" *is* the parent relationship. Verified directly:

```
$ git rev-parse 4244b3d^
e5582431091e9b8ddb96c2f22802da8d40081355        # e558243 IS the direct parent

$ git log --oneline e558243..4244b3d
4244b3d bugs fixed and also the allocation logic implementation in progress   # one commit, no intervening commit
```

**There is no intervening commit.** The cited baseline `e558243` is correct.

What *is* true, and is the accurate form of the finding:

| Fact | Evidence |
|---|---|
| `e558243` contains **no** Phase 0 or Phase 1 code | `git ls-tree -r e558243 --name-only \| grep -c "Backend/src/engine/"` → **0** |
| `4244b3d` contains **both** Phase 0 and Phase 1 deliverables in one commit | 51 files under `Backend/src/engine/`, including Phase 0's `TIERS.md`, `guards/tenets.js`, `guards/tierAssertions.js` and both gate tools, alongside Phase 1's `config/`, `cost/`, `determinism/` |
| `4244b3d` **also** carries unrelated legacy-dispatcher fixes | `commandDispatcher.service.js` (+76), `VirtualRobot.js` (+85), `robot.handler.js` (+22), `socket.server.js` (+9) — all four already existed at `e558243` and were *modified*, not introduced; plus 4 new legacy test files (16 → 20 under `tests/unit/`) |
| The verification HEAD `4244b3d` is **no longer HEAD** | HEAD is now `62d8141`; Phases 2–15 have landed since |

So the defect is not a wrong baseline citation. It is that **`4244b3d` is a single commit
bundling Phase 0 + Phase 1 + unrelated legacy work, which makes Phase 0 and Phase 1
individually unattributable from history.** That limitation cannot be repaired without
rewriting history, which was not done and must not be.

### Fix — documentation only

`PHASE_1_IMPLEMENTATION_REPORT.md` header now records: baseline `e558243` (**confirmed** as
the direct parent), the Phase 1 landing commit `4244b3d`, the fact that it bundles Phase 0 and
unrelated legacy-dispatcher fixes, and the current HEAD. The legacy test baseline (169 tests)
is unchanged and remains accurately described. **No unrelated legacy fix is attributed to
Phase 1.** No history was rewritten and no commit was removed.

### Final status — **DOCUMENTATION CORRECTED** (the verification report's own claim was the inaccurate one)

---

## 6. Finding 6 — §22.2 post-`site` scope precedence

### Original finding
> The **linearisation of the §22.2 branch** is a genuine, honestly-flagged architecture
> ambiguity. I independently confirmed **no currently-registered parameter's `scopes` array
> spans both branches**, so the ambiguity has zero live exposure today.

### Specification evidence

§22.2 (`NEXT_GENERATION_ASSIGNMENT_ENGINE.md` lines 4826–4831), reproduced verbatim:

```
global → region → zone → site → agent_class → agent
                              → tenant → sla_class → mission_class
                              → time_window (scheduled overrides, including regimes)
```

Three lines branch after `site`. The specification states precedence **along** each line and
says nothing about precedence **between** them. §22.2 was read in full, together with §22.3,
§22.4, §3.6 and every cross-reference to §22.2 elsewhere in the specification: **no
authoritative rule resolving inter-branch precedence exists.**

### Treatment — preserved, not resolved

Resolution needs a total order, so the implementation linearises the branches in the order the
specification prints them, with `time_window` last. That remains **an implementation
convention, not a specification rule**, and Phase 1 has no authority to promote it into one.
Runtime behaviour was **not changed**. The convention is now documented in `resolver.js`, in
the test suite, and here.

### ⚠️ The exposure has grown since the verification — the ambiguity is no longer dormant

The verifier's "zero live exposure" was correct for Phase 1's 148-entry register. **It is no
longer true.** Measured against the current 242-entry register:

| Parameter | Declared scopes | Branches touched |
|---|---|---|
| `energy.model_residual_cv` (§14.5) | `global`, `agent_class`, `mission_class` | agent + subject |
| `payload.packing_node_budget` (§15.3) | `global`, `mission_class`, `agent_class` | agent + subject |

Both were added by later phases. The exposure is still **latent** — declaring a scope is not
binding at one, and neither parameter is bound at both levels in any published version — but
it is no longer hypothetical.

### Regression tests

`Backend/tests/engine/configResolver.test.js` — new describe block, **5 tests**: precedence
within each branch is the specification's own order · precedence between branches is the
linearisation · **a parameter bound in two branches at once resolves by the linearisation**
(the behaviour the ambiguity governs, made explicit) · a scheduled override still wins over
every branch · and a **guard** asserting the exact set of registered parameters that can reach
the ambiguity, so a future phase widening the exposure must come past this test and read the
reasoning rather than discovering it in production.

### The decision still required

**When a parameter is bound at two levels in different post-`site` branches and a resolution
context addresses both, which branch wins?** Until an authority answers that, the printed
order stands. **Owner:** architecture (the specification is frozen; resolving this requires
unfreezing it or an authoritative clarification). **Needed by:** whichever phase first binds
`energy.model_residual_cv` or `payload.packing_node_budget` at both `agent_class` and
`mission_class` simultaneously.

### Final status — **ARCHITECTURE AMBIGUITY — EXPLICITLY DOCUMENTED, NOT RESOLVED**

---

## 7. Finding 7 — V9 combined energy conservatism

### Original finding
> The §14.3 combined-degraded-conservatism validation (V9) correctly rejects the seeded
> register as a publish, because the specification's own stated Appendix A defaults
> (1.15 × 1.25 × 1.40 ≈ 2.0125) exceed its own stated cap (1.60).

### 1. The arithmetic, re-derived from the frozen specification

Appendix A, quoted by line:

| Parameter | Default | Range | Class | Appendix A line |
|---|---|---|---|---|
| `energy.f_derate` | 1.00 | 1.0–2.0 | **Safety** | §14.3 names it; no default tabulated |
| `energy.charger_availability_margin` | 1.15 | 1.0–2.0 | **Safety** | 5684 |
| `energy.uncalibrated_reserve_factor` | 1.25 | 1.0–2.0 | **Safety** | 5689 |
| `route.degraded_reserve_factor` | 1.40 | 1.0–3.0 | **Safety** | 5733 |
| `energy.max_combined_conservatism` | **1.60** | 1.0–3.0 | **Safety** | 5690 |

```
nominal  = 1.00 × 1.15 × 1.25          = 1.4375   ≤ 1.60  ✓
degraded = 1.4375 × 1.40               = 2.0125   > 1.60  ✗
```

### 2. The register still holds exactly those values — no silent alteration

Read from the live register at HEAD:

```
energy.f_derate                          = 1      [SAFETY/UNCALIBRATED] range {"min":1,"max":2}
energy.charger_availability_margin       = 1.15   [SAFETY/PROVISIONAL]  range {"min":1,"max":2}
energy.uncalibrated_reserve_factor       = 1.25   [SAFETY/PROVISIONAL]  range {"min":1,"max":2}
route.degraded_reserve_factor            = 1.4    [SAFETY/PROVISIONAL]  range {"min":1,"max":3}
energy.max_combined_conservatism         = 1.6    [SAFETY/PROVISIONAL]  range {"min":1,"max":3}
```

**Nothing was changed.** No factor was reduced, no cap was raised.

### 3. V9 is correctly implemented, and the publish path fails correctly

The Config Service's own derivation evidence, and the validator's verdict on the seeded
register with no bindings:

```
nominal  1.4375
degraded 2.0124999999999997          // float rendering of 2.0125; the comparison is unambiguous
factors.nominal      { charger_availability_margin: 1.15, uncalibrated_reserve_factor: 1.25, f_derate: 1 }
factors.degradedOnly { route.degraded_reserve_factor: 1.4 }

V9  BLOCKING  §22.1 rule 5 · §14.3
    "combined degraded energy conservatism 2.0124999999999997 exceeds
     energy.max_combined_conservatism 1.6 (nominal 1.4375 × route.degraded_reserve_factor=1.4).
     Raising the cap is an explicit Safety-class decision…"
```

The product is taken over the energy domain specifically, which is what §14.3 requires
("these factors all multiply the same quantity, a reserve in Wh").

### 4. No authorised decision exists in the repository

Searched. `ADR-32` records the decision *mechanism* as **Accepted — frozen** ("the Config
Service publishes the combined product and rejects it beyond a stated cap") but takes no view
on the margin. The most recent programme-level record,
`PHASE_15_BLOCKER_RESOLUTION_PLAN.md` row 14, still carries it open:

> `energy.max_combined_conservatism` | SAFETY | PROVISIONAL | **DEC** — explicit Safety
> decision on intended total energy margin | Safety | **blocking: YES**

So the decision is unresolved across the whole programme, not merely at Phase 1. **This is
ADR-32 firing exactly as designed, not a defect.**

### 5. Tests distinguish validator correctness from seeded-default publishability

`Backend/tests/engine/configValidators.test.js` — the existing test (seeded register rejected
by exactly one blocking finding, `V9`) is retained, and **4 tests added** to keep the two
concerns from collapsing into each other:

- **the four factors and the cap still hold their Appendix A values**, and all five are still
  `SAFETY` class — a guard that fails if anyone resolves this finding by editing a default;
- **the §14.3 arithmetic is the arithmetic the Config Service performs**, factor by factor;
- **V9's correctness does not depend on the seeded values** — the same factors pass under a
  cap of 2.10 and fail under 2.00, so the seeded failure is a *configuration* verdict, not a
  bug;
- **the publish path, not merely the validator, refuses the seeded register**, and writes no
  version.

### 6. No test masks the issue

The `BASELINE` fixture in `configValidators.test.js` stands in a cap of 2.10 so that every
*other* rule can be exercised in isolation. That is a test fixture, is not seeded, and is
documented as such in the file. The seeded register's failure is asserted in its own test and
escalated here and in the implementation report.

### Final status — **VERIFIED / NO DEFECT — EXTERNAL SAFETY DECISION REQUIRED**

**Owner:** Safety, with the named calibration owner of blocking decision B8.
**Needed by:** the first production publish; hard-blocking by Phase 7.
**Lawful resolutions** remain the three the implementation report lists — raising the cap,
reducing a factor, or reclassifying a factor (the third is unavailable per §14.3). Phase 1
has not taken, and must not take, that decision.

---

## 8. Database verification — executed

### The gap

Both the implementation report and the independent verification disclosed that the migration
had never been applied to a live PostgreSQL instance and the immutability triggers had never
been executed. The verifier validated the SQL statically via `prisma migrate diff` and stopped
at the credential boundary rather than brute-forcing it.

### What was available, and what was refused

| Option | Outcome |
|---|---|
| The project's Neon database | **Refused.** Shared infrastructure, not a disposable test target. |
| The local PostgreSQL 18 service (running) | **Not used.** `pg_hba.conf` requires `scram-sha-256` for every local and loopback connection; there is no `pgpass.conf` and no credentials on file. Credentials were not guessed, and `pg_hba.conf` was not modified. |
| Docker | Unavailable — the daemon is not running. |
| **PGlite** — upstream PostgreSQL compiled to WASM, including `plpgsql` | **Used.** Installed **outside the repository**, in the session scratchpad, so the project's dependency set is unchanged. The database is created in memory and destroyed on process exit. |

### Result — 18/18

```
engine: PostgreSQL 18.3 (PGlite 0.5.4) on wasm32-unknown-linux-gnu

PASS  migration applies cleanly — 176 lines executed
PASS  all five tables exist — ConfigActiveVersion, ConfigScopeBinding, ConfigVersion,
                              OperatingRegime, ParameterRegisterEntry
PASS  all three enums exist — CalibrationStatus(3), ConfigChangeClass(7), OperatingRegimeState(4)
PASS  indexes created — 13 index(es)
PASS  foreign keys created — ConfigActiveVersion_version_fkey, ConfigScopeBinding_configVersionId_fkey
PASS  immutability triggers installed — ConfigScopeBinding_immutable, ConfigVersion_immutable
PASS  a normal INSERT succeeds — {"version":1,"signature":"sig-1"}
PASS  ConfigVersion UPDATE is refused — "ConfigVersion is immutable once published (§22.1 rule 3).
                                        Publish a new version instead of UPDATE on version 1."
PASS  ConfigVersion DELETE is refused — "…instead of DELETE on version 1."
PASS  the published version survived both attempts unchanged — [{"version":1,"signature":"sig-1"}]
PASS  a normal binding INSERT succeeds
PASS  ConfigScopeBinding UPDATE is refused
PASS  ConfigScopeBinding trigger covers UPDATE only, exactly as its comment states — events=UPDATE
NOTE  a direct DELETE on ConfigScopeBinding is ACCEPTED — observation for the schema owner
PASS  ConfigActiveVersion refuses a non-singleton id — CHECK "ConfigActiveVersion_singleton"
PASS  ConfigActiveVersion accepts the singleton row
PASS  ConfigActiveVersion FK rejects a pin at an unpublished version — FK "ConfigActiveVersion_version_fkey"
PASS  the active-version FK is ON DELETE RESTRICT, not CASCADE — confdeltype=r
PASS  ConfigVersion.version is unique — unique constraint "ConfigVersion_version_key"

18/18 checks passed
```

**The largest residual risk the implementation report named (§17, and TODO §16.1 item 2) is
discharged.** The migration applies, and §22.1 rule 3's schema backstop demonstrably refuses
both `UPDATE` and `DELETE` on a published `ConfigVersion` with the intended message.

### One observation, recorded and deliberately not "fixed"

`ConfigScopeBinding_immutable` is `BEFORE UPDATE` **only**. That is deliberate and the
migration says so in a comment directly above the trigger:

> `-- UPDATE only: a DELETE arrives legitimately via the ON DELETE CASCADE of a`
> `-- ConfigVersion removal, which the ConfigVersion trigger already refuses.`

Live execution shows the rationale covers cascade-DELETE but not a **direct** `DELETE FROM
"ConfigScopeBinding"`, which is accepted. It was **not changed**, for three reasons: the
migration has already been applied to the shared database and 20 later migrations sit on top
of it, so it is not editable — a change would be a new migration and a schema decision beyond
remediation scope; replay reads `ConfigVersion.payload`, which is self-contained JSONB, not
these rows, so replayability is unaffected; and inventing a stricter guarantee than the
schema's author documented would be exactly the unauthorised architectural decision this
remediation is required not to make. **Recorded for the schema owner.**

### Remaining environmental limitation

Two, stated plainly rather than papered over:

1. **PGlite is PostgreSQL 18.3 compiled to WASM**, not the deployment target's native server
   build. The DDL, constraints, `plpgsql` and trigger semantics exercised here are upstream
   PostgreSQL, but this is not a substitute for applying the migration on the deployment
   platform.
2. **The migration was applied to an empty database**, not to a production-shaped dump. The
   implementation report's recommendation to exercise it against a production-shaped dump
   before a production migration still stands.

### Final status — **EXECUTED, with two stated environmental limitations**

---

## 9. Files changed

### Source (9 files, one of them new)

| File | Change | Finding |
|---|---|---|
| `Backend/src/engine/determinism/fixedPoint.js` | Exact decimal conversion; one shared rounding site; module header states the supported input representation | 1 |
| `Backend/src/engine/determinism/snapshot.js` | `deepFreeze` freezes before recursing — terminates on a cycle | 3 |
| `Backend/src/engine/config/errors.js` | **New.** `ConfigValidationError`, below the modules that raise it | 2 |
| `Backend/src/engine/config/killSwitches.js` | `normaliseState`/`isEnabled` raise `ConfigValidationError` with `P5` findings; switch-state shape checked | 2 |
| `Backend/src/engine/config/resolver.js` | `indexBindings` raises `ConfigValidationError` with `P6` findings; binding shape checked; all problems batched | 2 |
| `Backend/src/engine/config/regimes.js` | `activeRegime` raises `ConfigValidationError` with `P7` findings; regimes shape checked | 2 |
| `Backend/src/engine/config/service.js` | Re-exports `ConfigValidationError` from `errors.js` | 2 |
| `Backend/src/engine/guards/tierAssertions.js` | `config/errors.js` registered under T1-01 | 2 |
| `Backend/src/engine/TIERS.md` | Same, kept in sync (enforced by `tierRegistry.test.js`) | 2 |

### Tests (5 files, +70 tests)

| File | Added | Finding |
|---|---|---|
| `Backend/tests/engine/determinism.test.js` | +42 (16 rounding, 26 coverage) | 1, 3 |
| `Backend/tests/engine/configApi.test.js` | +8 | 2 |
| `Backend/tests/engine/configService.test.js` | +11 | 2 |
| `Backend/tests/engine/configResolver.test.js` | +5 | 6 |
| `Backend/tests/engine/configValidators.test.js` | +4 | 7 |

### Documentation (3 files)

`PHASE_1_REMEDIATION_AND_CLOSURE.md` (this document, new) ·
`PHASE_1_IMPLEMENTATION_REPORT.md` (Findings 4 and 5 corrected; remediation cross-referenced) ·
`PHASE_1_INDEPENDENT_VERIFICATION.md` (remediation addendum appended; **original findings
preserved verbatim**).

### Incidental observation — `resolver.js` is opaque to diff-based review

Noticed while verifying that my edits had not corrupted the file. `resolver.js` contains two
literal `NUL` bytes, used as the field separator in `bindingKey()`:

```
bindingKey(level, key, name)  →  `${level}\0${key}\0${name}`
```

That is a **deliberate and sound** choice — `NUL` cannot occur in a scope level, a scope key,
or a parameter name, so it is an unambiguous separator where a `:` or a space would not be —
and it is **pre-existing**: the byte count at the Phase 1 commit `4244b3d` is the same 2, and
this remediation added none.

It is recorded because it has a review consequence nobody has flagged: `git` classifies the
file as binary (the Phase 1 commit's own `--stat` reads `resolver.js | Bin 0 -> 9425 bytes`),
so `git diff` shows no content and `grep` reports "Binary file … matches" instead of the
matching line. **Any review of this file that relies on diffs is blind to it.** Not changed —
the separator is doing real work, and swapping it would alter every binding key. Suggested for
the module owner: a two-character `\0` escape sequence would be byte-identical at runtime while leaving
the file textual.

### Not changed

`NEXT_GENERATION_ASSIGNMENT_ENGINE.md` · `IMPLEMENTATION_EXECUTION_PLAN.md` · every ADR ·
`prisma/schema.prisma` · every file under `prisma/migrations/` · every register `*.json` ·
every gate's threshold or scope · any Phase 2+ module.

---

## 10. Verification commands and final counts

| Command | Result |
|---|---|
| Command | Result |
|---|---|
| `npm run gates` | **7/7 PASS** — tiers (277 modules, 386 edges) · params (183 modules / 242 parameters) · tenets (274 modules) · privacy (16 modules) · erasure (3 decisions, byte-identical) · legacy-retirement (4 retired modules, 302 files) · column-generation (NOT_REQUIRED) |
| `npm run verify` | **PASS** — 7/7 gates + full suite, 0 failures |
| `npm test` | **145 suites, 6 357 tests, 0 failures** |
| `npm run test:engine` | green |
| `npm run test:legacy` | **17 suites, 126 tests** — see the note below |
| `npm run test:gates` | **7 suites, 100 tests** |
| `npx prisma validate` | `The schema at prisma\schema.prisma is valid 🚀` |
| Disposable PostgreSQL migration + triggers | **18/18** |

**Tests added by this remediation: 70.** `determinism.test.js` +42 · `configService.test.js`
+11 · `configApi.test.js` +8 · `configResolver.test.js` +5 · `configValidators.test.js` +4.
878 lines, no test deleted, skipped, weakened, or re-baselined.

**On the legacy lane count — stated plainly rather than glossed.** Phase 1's report recorded
this lane at **22 suites / 169 tests**, matching Phase 0's baseline. At HEAD it is **17 suites
/ 126 tests**. That reduction is **not** caused by this remediation and predates it: Phase 15
is the cutover the lane's own charter always pointed at, and it removed the legacy decision
path from the build. `jest.config.js` documents the change in the lane's header comment —
"Phase 15 **is** that cutover, and it removed the legacy decision path from the build. What
remains in the lane is everything the cutover did not retire — auth, CORS, the KV facade, the
command round trip, telemetry, the simulator" — and `gate:legacy` enforces that the retired
modules stay absent. **This remediation modified no file in the legacy lane** (`git status`
shows no change under `tests/unit/` or `tests/integration/`), and the lane is green.

The Phase 1-era claim of "169, unchanged" was true when written and is preserved in the
implementation report as a statement about Phase 1. It is not true of HEAD, and is not
restated here as though it were.

No lint, typecheck or build script exists for these modules; the repository has none
configured.

---

## 11. Acceptance criteria

| Criterion | Status |
|---|---|
| All legitimate implementation defects fixed | ✅ Findings 1, 2, 3 — plus `deepFreeze` and a third error-boundary site found during remediation |
| Every fixed defect has a regression test | ✅ 70 added; Finding 2's proven by counterfactual |
| Fixed-point rounding mathematically correct for the supported representation | ✅ Representation identified and documented; 800 000 half boundaries, 0 wrong |
| Malformed publish input follows the intended validation contract | ✅ 422 + structured findings |
| Unexpected internal errors still distinguishable from client validation errors | ✅ Asserted at both HTTP and service level |
| Missing direct test coverage addressed | ✅ All 7 functions |
| Parameter-register documentation accurate | ✅ Thirteen, with `cost.reference_agent_class` named |
| Baseline/commit documentation accurate | ✅ Corrected from git history; the verification report's claim was the inaccurate one |
| §22.2 precedence resolved or explicitly preserved | ✅ Preserved, documented, tested; grown exposure disclosed |
| V9 behaviour correct and the Safety decision preserved | ✅ No silent alteration; guarded by tests |
| Migration exercised against a safe disposable PostgreSQL | ✅ 18/18; two limitations stated |
| `npm run gates` passes | ✅ 7/7 |
| `npm run verify` passes | ✅ |
| Full test suite passes | ✅ 145 suites / 6 357 tests |
| Legacy suite green | ✅ 17 suites / 126 tests, 0 failures. **Not** the Phase 1-era 169: Phase 15's documented cutover retired the legacy decision path before this remediation began. No legacy file was touched here. See §10 |
| Engine/Phase 1 tests pass | ✅ |
| No Phase 2 functionality introduced | ✅ |
| No frozen specification modified | ✅ |
| No gate weakened | ✅ |
| Working tree free of temporary fixtures and scratch artifacts | ✅ All scratch work in the session scratchpad; the temporary counterfactual revert was restored and verified |

---

## 12. Final status

# PHASE 1 — CLOSED, WITH TWO OPEN ITEMS HELD OPEN ON PURPOSE

Every legitimate implementation defect the independent verification found is fixed and
regression-tested, and remediation found and fixed two further defects the verification did
not reach. The database gap that both reports carried is discharged by real execution.

**This is not "100% verified", and it is not claimed to be.** Two items remain open because
closing them is not within any implementation phase's authority:

| Item | Kind | Owner |
|---|---|---|
| §22.2 post-`site` inter-branch precedence | Specification ambiguity — exposure has grown from 0 to 2 parameters | Architecture |
| §14.3 combined degraded conservatism, 2.0125 vs a 1.60 cap | Safety-class configuration decision | Safety (blocking decision B8) |

And two environmental limitations remain: the migration was exercised on PostgreSQL-in-WASM
rather than the deployment platform, and against an empty database rather than a
production-shaped dump.

**Phase 2 was not started.** Nothing in this remediation touches the domain model, the
commitment core, the solver, or any later-phase capability.
