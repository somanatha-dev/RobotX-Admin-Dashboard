# Phase 1 — Independent Architecture Verification Report

**Verifier role:** Independent Architecture Verification Engineer (did not implement Phase 1)
**Date:** 2026-07-28 · **Branch:** `feature/dashboard` · **HEAD at verification:** `4244b3d`
**Method:** Evidence re-derived from spec text, code execution, and byte-level diffs — the
implementation report was not trusted for any claim reported here as PASS. Every claim below is
backed by a command, a diff, or a spec quotation reproduced in this document.

---

## 0. A note on the cited baseline

Both `IMPLEMENTATION_EXECUTION_PLAN.md` and the Phase 0/Phase 1 reports cite **baseline commit
`e558243`**. `git log` shows `e558243` is not HEAD's parent — HEAD (`4244b3d`, "bugs fixed and
also the allocation logic implementation in progress") sits one commit ahead of it, and that
commit already contains **all** of Phase 0's and Phase 1's deliverables bundled together with
unrelated legacy-dispatcher fixes (`commandDispatcher.service.js`, `VirtualRobot.js`,
`robot.handler.js`, `socket.server.js`, five new legacy test files). Content review of those
files (§8 below) confirms they are dispatcher-domain bug fixes unrelated to config/units/
determinism, not something Phase 1 introduced. This is a **documentation-accuracy defect** in
the plan/reports' citation, not a Phase 1 regression — recorded here once, not repeated as a
finding against every part it touches.

---

## PART 1 — Phase 1 checklist (`IMPLEMENTATION_EXECUTION_PLAN.md` §7)

| # | Item | Verdict | Evidence |
|---|---|---|---|
| 1 | `ConfigVersion`, `ParameterRegisterEntry`, `OperatingRegime` schema + migration | **PASS** | `prisma validate` clean. `npx prisma migrate diff --from-empty --to-schema-datamodel` (no live DB needed) regenerated Prisma's own authoritative SQL; diffed byte-for-byte against the hand-written migration's table/enum/index definitions — **identical** except two `CREATE INDEX` statements in harmless swapped order (confirmed via sorted diff, exit 0). Plus `ConfigScopeBinding`, `ConfigActiveVersion` as the plan's own §3 Phase-1 row also requires |
| 2 | `config/service.js` (publish, pin, load) | **PASS** | Exercised end-to-end via mocked Prisma: publish→pin→load round-trip returns the bound value; signature is a pure content hash (two independent stores publishing identical content produce identical signatures — verified); versions monotone; cache-flush and no-cache paths both resolve correctly. **One defect found**, see Part 7 |
| 3 | `resolver.js`, scope order `global→region→zone→site→agent_class→agent` | **PASS** | Order string-matches §22.2 exactly (re-extracted from spec text: `sed -n '4823,4832p'`). Manual from-scratch resolution test (independent of the shipped test suite) confirms region→site precedence, wrong-key fallback, and no-context default all resolve correctly |
| 4 | `derived.js`: α[tier], Ω_policy, `energy.contingency_quantile`, combined conservatism | **PASS** | All four re-derived by hand from the register's live values and compared byte-for-byte against computed output: α = `{T1:0.01, T2:0.00001, T3:1.0958904109589041e-7}` matches §14.5's worked example (N=5000, r_d=20/day) exactly; quantile = `1 − α₁` = 0.99 exact; Ω_policy = 900 = sum of five seeded ceilings, exact; nominal/degraded conservatism = 1.4375 / 2.0125, exact per §14.3's factor list |
| 5 | `validators.js` — "all eight §22.1 rule-5 checks" | **PASS, with a plan defect confirmed** | Independently re-extracted §22.1 rule 5 from spec text: **ten** bullets, not eight (`sed`-verified). All ten implemented as V1–V10, each isolated to trigger *only* its own check via a fresh test matrix I ran against the actual validator (not the shipped tests) |
| 6 | `calibrationStatus.js` (DERIVED/PROVISIONAL/UNCALIBRATED) | **PASS** | 148/148 register entries carry one of the three statuses (`checkRegister()` output: 96 PROVISIONAL / 29 DERIVED / 23 UNCALIBRATED, summing to 148); every non-DERIVED entry names `awaits`; §22.4 Tier 0 (Safety-class) gate confirmed to escalate from report to blocking under `enforceLaunchGate: true` |
| 7 | `killSwitches.js`, nine switches + monotone ladder | **PASS** | Ladder order string-matches §22.5's printed order exactly. Register file (`killSwitches.json`, generated) confirmed **not stale** — regenerating from the live `registerEntries()` function produces byte-identical JSON to what's on disk |
| 8 | `regimes.js` — named, forecast-triggerable, operator-confirmed | **PASS** | Operator-only transition list correctly blocks `FORECAST` actor from `PROPOSED_ENTRY→ACTIVE` and `PROPOSED_EXIT→INACTIVE`; both directions tested live against the module, not just via the shipped suite |
| 9 | Seed register from Appendix A and §8.10 | **PASS** | Re-parsed Appendix A and §8.10 directly from spec markdown independent of any implementation code: Appendix A = 89 unique parameter names (91 rows, 3 of which are the same `energy.event_budget_per_fleet_year[Tn]` collapsing to one indexed entry), §8.10 = 29. Cross-checked against `appendixA.json`/`cost.json`: **zero missing, zero unexplained extras** in either direction |
| 10 | `cost/units.js`, `exchangeRates.js` with explicit dimensions | **PASS** | A rate constructed for one dimension refuses `apply()` against a mismatched quantity unit (`prices Wh, not m`); an unregistered rate name is refused at construction; the 10km-vs-1km monotonicity property holds under exact milli-CU comparison |
| 11 | `determinism/fixedPoint.js`, int64 milli-CU, one rounding mode | **PASS, with a real minor defect found** | See Part 5/10. Core properties (order-independent summation, overflow-as-error, negation symmetry) hold under brute-force testing across hundreds of thousands of sampled values. One narrow rounding-correctness bug found and characterized, does not break the properties this requirement actually protects |
| 12 | `determinism/ordering.js`, `snapshot.js` | **PASS** | `canonicalJson` proven key-order-independent at nested depth; string comparator proven to differ from `localeCompare` in a case that would matter (`compareStrings("a","B")` vs locale collation); snapshot correctly refuses construction missing any required pin, hashes identically for identical input, differently for any single changed pin (tested pin-by-pin) |
| 13 | Migrate `dtaro.constants.js`/`liveness.constants.js` behind a shim | **PASS** | Shim files re-read: contain zero numeric literals of their own (grep against a comment/string-stripped view of the file returns empty); resolved values match the pre-Phase-1 literals exactly (20, 30, 15000, 30000, 10000, 500) |
| 14 | REST: resolve / versions / publish | **PASS, with a real defect found** | All three endpoints reachable, auth-gated, return documented shapes for well-formed input. **A real, reproducible defect found in error handling for malformed input** — see Part 7 (blocking-severity classification below) |
| 15 | Tests: scope precedence incl. zone, derived params, rule-5 rejections, fixed-point order-independence | **PASS** | 272 engine tests exist and pass; I additionally ran fresh, independent reproductions of the load-bearing claims (not just re-running the shipped suite) for every item in this row |
| 16 | Gate: no bare constant outside register; derived params not hand-settable | **PASS** | Planted a genuine bare numeric literal (`47281`) into live Phase 1 code (`resolver.js`) and confirmed `gate:params` catches it with the correct file/line/message, then confirmed it passes clean again after removal. A2/V3 refuse hand-entered derived values, reproduced directly against `validatePublish` |

**Checklist result: 16/16 PASS**, two with real defects noted (items 2, 11, 14) that do not
invalidate the checklist item's substance but are reported in Part 10/12.

---

## PART 2 — Completion criteria (`IMPLEMENTATION_EXECUTION_PLAN.md` §3 "PHASE 1")

| Criterion | Verdict | Evidence |
|---|---|---|
| Every constant in `dtaro.constants.js`/`liveness.constants.js` resolvable through the Config Service | **PASS** | Re-verified independently (Part 1 item 13) |
| Publish-time validator rejects each of the §22.1 rule-5 violations in a test matrix | **PASS** (plan says 8, spec has 10, both fully covered) | See Part 1 item 5 |
| Ω_policy and α[tier] computed, never hand-entered | **PASS** | Hand-entry of `cost.policy.max_total_credit` and `energy.contingency_quantile` both independently confirmed refused (A2/V3) |
| Resolution-explain returns the supplying scope level for any parameter | **PASS** | `explain()` returns `{level, key, chain}` for every resolution tested; the `GET /api/config/resolve` HTTP path reproduced this over supertest independently |

**Result: 4/4 PASS.**

---

## PART 3 — Architecture compliance

| Check | Verdict | Evidence |
|---|---|---|
| Layering / module placement | **PASS** | All Phase 1 modules resolve to `Tier 1 — Operational integrity` via `tierAssertions.tierOf()`, matching the T1-01/T1-02 mechanism table Phase 0 froze |
| ADR compliance | **PASS** | `ADR-01` (Cost representation: "Absolute additive CU with dimensioned exchange rates" / rejects "Min-max normalised weighted sum") — `units.js` implements exactly this and `refuseNormalisation()` exists specifically to reject the rejected alternative. `ADR-32` (Conservatism: "Every derating factor declares the uncertainty it compensates; the Config Service publishes the combined product and rejects it beyond a stated cap") — `derived.js`/V9 implement this verbatim; the §7.1 finding in the implementation report is this ADR **firing correctly**, not a violation of it |
| Invariant / tier compliance | **PASS** | `gate:tiers` PASS, 20 governed edges, 0 forbidden Tier 0/1→Tier 2 dependencies, reproduced fresh |
| Dependency direction | **PASS** | Same evidence as above |
| Feature-flag (kill switch) behaviour | **PASS** | Launch state (every switch thrown) classifies `TIER_ONE_BASELINE` and does not alert; every other combination not a ladder prefix classifies `UNREHEARSED` and requires acknowledgement — both reproduced directly against the module |
| No architecture drift | **PASS** | No file outside `src/engine/config/`, `src/engine/cost/{units,exchangeRates}.js`, `src/engine/determinism/` contains new runtime logic (`phase0Scaffold.test.js`'s narrowed assertion re-run and independently spot-checked by walking the `src/engine` tree by hand) |

---

## PART 4 — Configuration system

Covered in depth in Parts 1–2. Additional finding: the **linearisation of the §22.2 branch**
(the spec draws three lines branching after `site`; the implementation linearises
`agent_class→agent→tenant→sla_class→mission_class→time_window`) is a genuine, honestly-flagged
architecture ambiguity. I independently confirmed **no currently-registered parameter's
`scopes` array spans both branches** (`agent_class`/`agent` vs `tenant`/`sla_class`/
`mission_class`), so the ambiguity has zero live exposure today — this is an accurate
self-assessment by the implementer, not an understated risk.

**Verdict: PASS**, ambiguity correctly disclosed rather than silently resolved.

---

## PART 5 — Determinism

| Requirement (§9.6) | Verdict | Evidence |
|---|---|---|
| 1. Integer arithmetic, order-independent summation | **PASS** | 400,001-value brute-force shuffle test (independent of the shipped suite) confirms `sum()` is exactly order-independent; a same-magnitude float-sum comparison on a realistic mixed set (`[1e11, 0.001, 0.007, -1e11, 0.003]`) shows genuine float order-dependence that milli-CU summation does not exhibit |
| — rounding correctness | **PARTIAL — real defect found** | Brute-force testing ~1.3M exact-half-boundary milli-CU values found **738–3,934 cases (≈0.2–0.4%) where `toMilliCU()` rounds toward zero instead of away from zero**, due to IEEE754 representation error in the `cu * 1000` intermediate (e.g. `-32.7615 * 1000` evaluates to `-32761.499999999996`, not exactly `-32761.5`, pushing the `Math.ceil(scaled − 0.5)` epsilon check to the wrong side). Error is bounded to exactly ±1 milli-CU when it occurs, **does not affect non-half-boundary values** (1,000,001 ordinary 3-decimal values tested, zero mismatches), and **does not break negation symmetry** (400,001 values tested, zero asymmetries) — so the specific claims in `determinism.test.js` are not false, but the broader claim of "correctly implements round-half-away-from-zero" is not universally true. See Part 10 for severity classification |
| 2. Canonical ordering, unique-id-terminated total order | **PASS** | `assertTotalOrder()` correctly flags a comparator that ties two distinct members when tested against a deliberately weakened comparator (cost-only, no tie-break) |
| 3. Explicit tie-break (duty cycle → health tier → agent id) | **PASS** | Reproduced with a 4-way candidate set; correct order `["q","m","a","z"]` for a case exercising all three tie-break levels |
| 4. `decision_time` as an input | **PASS** | `snapshot.js` is the only Phase 1 module excluded from the T6 decision-path scope, and `gate:tenets` (re-run fresh) confirms no other in-scope module reads a wall clock |
| 5. Snapshot isolation | **PASS** | `captureSnapshot()` refuses construction missing any of the 5 required pins (tested pin-by-pin); is deep-frozen; content hash changes for each of 5 independently-varied pins tested one at a time |
| 6. Pinned versions | **PASS** | `configVersion`, `codeVersion`, `chargerProjectionVersion` etc. all carried in the snapshot structure |
| 7. No unseeded randomness | **PASS** | `deriveSeed()` is a pure function of `roundId`; empty round id refused |

**Verdict: PASS overall**, with the rounding defect noted above as a real, narrow,
non-blocking implementation quality issue (Part 10).

---

## PART 6 — Database

| Check | Verdict | Evidence |
|---|---|---|
| Schema changes additive-only | **PASS** | `git diff e558243 4244b3d -- prisma/schema.prisma` shows 5 new models + 3 new enums appended; no existing model/field/index touched |
| Migration correctness | **PASS, substantially more verified than the implementation report could claim** | The implementation report disclosed it could not reach a live database. I found and used `npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script`, which needs **no live database connection**, to obtain Prisma's own authoritative SQL for the full schema, and byte-diffed it against the hand-written migration's table/enum/index/FK sections — **identical** (one harmless statement-order swap). This substantially de-risks the single largest open item the implementation report flagged |
| Immutability triggers | **PASS on static review, NOT executed against a live instance** | Both `plpgsql` trigger functions use a well-established idiom (unconditional `RAISE EXCEPTION` in a `BEFORE UPDATE OR DELETE` trigger); placeholder-count in each `RAISE EXCEPTION` format string exactly matches the argument count supplied; `TG_OP` and `COALESCE(OLD.x, NEW.x)` usage is correct for both UPDATE and DELETE trigger contexts. **I did not have credentials to a live Postgres instance in this environment and did not attempt to guess or bypass them** (a local Postgres 18 service was running, but authentication failed under the two credential pairs on file, and I stopped rather than brute-force it; the project's live Neon database was not used since it is shared infrastructure, not a disposable test target) |
| FK / constraint ordering | **PASS** | `ConfigVersion_version_key` (unique index) is created at line 103; `ConfigActiveVersion_version_fkey`, which requires that unique index to exist, is added at line 174 — correct order confirmed by direct line inspection |
| Rollback safety | **Not independently verified** | No `down` migration exists for this SQL system (Prisma migrations are forward-only by convention here, consistent with every prior migration in `prisma/migrations/`) |

**Verdict: PASS**, with the live-execution gap explicitly inherited and disclosed (same as the
implementation report), but substantially better evidenced via the Prisma-diff cross-check.

---

## PART 7 — API review

| Check | Verdict | Evidence |
|---|---|---|
| Routes, auth | **PASS** | All three endpoints require `authUser` + `SUPER_ADMIN`; reproduced 401 for unauthenticated and 403 for wrong-role over real HTTP |
| `GET /api/config/resolve` | **PASS** | 400 on unknown scope level, 404 on unregistered parameter, correct `chain`/`level` in response, index-parameter handling correct |
| `GET /api/config/versions` | **PASS** | Returns versions + active pointer |
| `POST /api/config/publish` — well-formed input | **PASS** | 422 + findings on a business-rule rejection (V5); 200 + signature + pin on a valid publish; 422 on an automated Safety-class change |
| `POST /api/config/publish` — malformed input | **FAIL (real, reproduced defect)** | Sending `{"killSwitchState": {"not_a_real_switch": true}}` or a binding with an unrecognized `level` (e.g. `"not_a_level"`) to `POST /api/config/publish` returns **`500 {"message":"Internal Server Error"}`**, not the documented/tested 422-with-findings. Reproduced twice over real HTTP via supertest against the actual app, with forced-failure assertions surfacing the exact response. **Root cause:** `killSwitches.normaliseState()` and `resolver.indexBindings()` both throw a plain `Error` (not `ConfigValidationError`) for invalid input, and this throw happens *inside* `buildSnapshot()`, called from `validateCandidate()`, called from `publish()` — entirely before the `try { publish() } catch (error) { if (error instanceof ConfigValidationError) {...} throw error; }` boundary in the controller can distinguish it from an unexpected server fault. No information is leaked (the error handler genericizes the 500 message), so this is **not** a security defect, but it is a genuine, verified robustness gap: an operator's typo in a kill-switch name or scope level, both entirely plausible mistakes, produces an opaque 500 instead of the endpoint's own designed, tested contract |
| Response models | **PASS for the valid-input path** | Shapes match what the shipped tests assert |

**Verdict: PARTIAL.** The endpoint is correctly authorised, correctly implements its documented
contract for well-formed input, and correctly implements the extensive V1–V10/A1–A3 validation
matrix — but has an input-validation completeness gap for two identifiable malformed-input
shapes that bypasses that matrix entirely. Classified in Part 12 as an **implementation** defect,
**not blocking Phase 2** (no data corruption, no legacy-path impact, no information disclosure).

---

## PART 8 — Regression review

| System | Verdict | Evidence |
|---|---|---|
| Legacy assignment engine, telemetry, Redis, Socket.IO, auth, simulator, benchmarks | **PASS** | `npm run test:legacy` fresh: **22 suites, 169 tests**, all green. This number is identical to what `PHASE_0_IMPLEMENTATION_REPORT.md` recorded as ITS OWN baseline (§6.1: "169 pre-existing tests are all still green and unmodified"), confirming Phase 1 introduced zero legacy regressions |
| Files `commandDispatcher.service.js`, `VirtualRobot.js`, `robot.handler.js`, `socket.server.js` show diffs against the cited `e558243` baseline | **Investigated, not a Phase 1 issue** | Content review of the diff shows dispatcher-domain fixes (a `dispatchCommand`/`dispatchStop` typed-helper refactor, an `assertIoServer` guard against a specific historical bug) entirely unrelated to config/units/determinism. These changes pre-date Phase 0's own reported baseline (Phase 0's report already counted 169 legacy tests as inherited, unmodified state) and are not attributable to Phase 1. See §0 above |
| Existing APIs | **PASS** | No existing route file modified except `routes/index.js` (2-line addition mounting `/api/config`) |
| `/health` endpoint | **PASS, additive** | New `configVersion`/`configRegisterDigest` fields added; existing fields (`server`, `redis`, `db`, `uptime`, etc.) unchanged, reproduced over HTTP |

**Verdict: PASS.** No Phase-1-attributable regression found anywhere in the legacy path.

---

## PART 9 — Build gates

| Check | Verdict | Evidence |
|---|---|---|
| `gate:tiers` still functions | **PASS** | Fresh run: PASS, 78 modules, 20 governed edges |
| `gate:params` still functions, and is now load-bearing | **PASS** | Fresh run: PASS, 12 modules / 148 parameters (Phase 0 baseline was 0/0 — confirmed load-bearing transition) |
| `gate:tenets` still functions | **PASS** | Fresh run: PASS, 75 modules |
| Gates not weakened | **PASS** | I independently planted a real bare constant (`47281`) into **live Phase 1 code** (not a test fixture) and confirmed `gate:params` caught it with file/line/message, then confirmed clean-pass restoration. This is materially stronger evidence than re-running the shipped fixture-based self-tests alone, since it rules out the gate being scoped to only see fixture directories |
| Gate self-tests (planted-violation fixtures) | **PASS** | `test:gates` fresh: 3 suites, 49 tests |

**Verdict: PASS.** No weakening found; gates independently confirmed to fail on a genuine,
freshly-planted violation in real (non-fixture) Phase 1 code.

---

## PART 10 — Code quality

Genuine, independently-verified defects only — no redesign suggestions.

1. **`fixedPoint.toMilliCU()` rounding-correctness bug** (Part 5). Severity: **LOW**. Affects only
   inputs whose true decimal value lands exactly on a milli-CU half-boundary (4th decimal digit
   exactly 5, nothing beyond) — an input shape essentially never produced by real cost
   computations (which come from continuous arithmetic, not hand-typed decimal literals). Does
   not break replay determinism (the bug is itself perfectly deterministic and reproducible
   across any IEEE754-conformant host) or negation symmetry (both independently verified). A more
   robust implementation would avoid binary-float multiplication for the scaling step (e.g. a
   string-based decimal parse for literal inputs), but this is a real fix, not a redesign.

2. **`POST /api/config/publish` unhandled-500 on malformed `killSwitchState`/binding `level`**
   (Part 7). Severity: **MEDIUM**. Reachable, reproducible, does not leak information, does not
   corrupt data, but violates the endpoint's own documented and tested error contract.

3. **Minor test-coverage gaps**: `fixedPoint.subtract()`, `multiplyByCount()`,
   `ordering.compareColumns()`, `ordering.thenBy()`/`descending()` as standalone units, and
   `snapshot.deepFreeze()`/`captureDecisionTime()` are exported but have no direct test coverage
   (confirmed via bare-word grep across `tests/` and `src/`, not just a `.methodName` pattern
   match). I hand-verified `subtract()` directly (70, -100, overflow-caught — correct) to bound
   the risk; the others are thin, low-complexity wrappers. Severity: **LOW** — these are
   substrate functions Phase 1 is building ahead of their first real consumer (Phase 8+), and
   their absence from the test suite is a coverage gap, not a known defect.

4. **`cost.reference_agent_class` documentation inconsistency.** The implementation report's
   Assumption 3 claims "twelve parameters were added that Appendix A does not tabulate" and lists
   exactly the twelve in `supplementary.json`. There is in fact a **thirteenth** —
   `cost.reference_agent_class`, required by §1.3's prose ("where the reference class and its
   cost are configuration") but not in Appendix A's or §8.10's tables — which lives in
   `cost.json` rather than `supplementary.json`. The parameter itself is correctly registered
   and required; this is a documentation-completeness gap in the report, not a register defect.
   Severity: **DOCUMENTATION, trivial**.

No duplicated logic, no dead code beyond item 3 above, no inconsistent naming, and no incorrect
tier/module ownership found on inspection of all Phase 1 files.

---

## PART 11 — Phase 0 follow-up

Phase 0's carried-forward TODO list (`PHASE_0_IMPLEMENTATION_REPORT.md` §9.1) named six items.
Independently checked which were, and were not, touched:

| # | Item | Owner phase | Verdict |
|---|---|---|---|
| 1 | Resolve §1.8/§22.5 kill-switch discrepancy | Phase 1 | **Correctly handled** — Phase 1 did not unilaterally resolve it (resolving is an architecture change outside any phase's authority), but implemented `killSwitches.js` faithfully carrying Phase 0's recorded treatment forward, with the discrepancy re-escalated explicitly (`killSwitches.js` comment block, and report §7.3) |
| 2 | Seed parameter register | Phase 1 | **Done** — 148 entries, verified (Part 1 item 9) |
| 3 | Confirm `settlement.js` Tier 0 assignment | Phase 5 | **Correctly deferred** — `find src/engine -iname "*settlement*"` returns nothing; not touched |
| 4 | Extend T1 assertion to call-site level | Phase 8 | **Correctly deferred** — no "call-site" language added to `tenets.js`, confirmed by grep |
| 5 | Add layer-direction gate | Phase 10 | **Correctly deferred** — `tools/gates/` contains exactly the same two gates Phase 0 shipped, no third gate added |
| 6 | Add §24.3 erasure-corpus gate | Phase 14 | **Correctly deferred** — no "erasure" reference anywhere in `tools/` or `src/engine/guards/` |

**Verdict: PASS.** Phase 1 addressed exactly the two items assigned to it and touched none of
the four assigned to later phases.

---

## PART 12 — FINAL DECISION

# PASS WITH MINOR ISSUES

### Every issue, classified

| # | Issue | Classification | Blocking? |
|---|---|---|---|
| 1 | `fixedPoint.toMilliCU()` misrounds ~0.2–0.4% of exact-half-boundary decimal inputs (toward zero instead of away from zero), due to float64 representation error in the scaling multiply | **Implementation** | No — narrow, does not break replay determinism or negation symmetry, unlikely to occur on real (non-literal) cost values |
| 2 | `POST /api/config/publish` returns an unhandled 500 instead of the documented 422+findings for a malformed `killSwitchState` name or an invalid binding `level` | **Implementation** | No — not reachable by the legacy path, doesn't corrupt data, doesn't leak information; should be fixed before Phase 15's operator-facing surface hardens, not before Phase 2 |
| 3 | Minor exported-function test-coverage gaps (`subtract`, `multiplyByCount`, `compareColumns`, `thenBy`/`descending` standalone, `deepFreeze`, `captureDecisionTime`) | **Implementation** | No |
| 4 | Implementation report's Assumption 3 undercounts non-tabulated register additions by one (`cost.reference_agent_class` not listed alongside the twelve in `supplementary.json`) | **Documentation** | No |
| 5 | Plan and both phase reports cite baseline commit `e558243`, which is not HEAD's actual ancestry point — one intervening, uncredited commit of legacy-dispatcher fixes sits between it and Phase 0's actual starting state | **Documentation** | No — content-verified unrelated to Phase 1's scope, and both phase reports' own inherited-baseline numbers (169 legacy tests) are internally consistent with each other regardless of the stale citation |
| 6 | §22.2's three-way branch after `site` is linearised by implementation choice rather than resolved by the spec, which draws it as an unordered tree | **Architecture ambiguity** | No — verified zero current parameters expose the ambiguity; correctly disclosed as Assumption 2 in the implementation report |
| 7 | The §14.3 combined-degraded-conservatism validation (V9) correctly rejects the seeded register as a publish, because the specification's own stated Appendix A defaults (1.15 × 1.25 × 1.40 ≈ 2.0125) exceed its own stated cap (1.60) | **Architecture ambiguity, already correctly surfaced by the implementer** | No — this is ADR-32's mechanism working exactly as designed; the implementer neither hid it nor silently patched around it. Confirmed independently in Part 3 |

### Phase 2 may begin.

Nothing above touches domain modeling, schema for `Agent`/`Mission`/`Leg`/`Stop`, or any
capability Phase 2 depends on. Issues 1–4 are narrow, low-severity, and isolated to code paths
Phase 2 does not call. Issues 5–7 are documentation/disclosure matters already handled
appropriately by the implementer, not defects requiring rework.

**One recommendation, not a blocker:** issue 2 (the unhandled-500 path) should be fixed before
any operator relies on `POST /api/config/publish` in a context where a malformed switch/scope
name is a realistic occurrence — i.e., before or during whichever phase first exercises this
endpoint operationally. It does not need to hold up Phase 2, which does not call this endpoint.

---

## Appendix — Commands run for this verification (representative, not exhaustive)

```
npm test                                    # 38 suites / 490 tests, fresh
npm run gates                               # 3/3 PASS, fresh
npx jest --selectProjects legacy            # 22 suites / 169 tests, fresh
npx jest --selectProjects gates             # 3 suites / 49 tests, fresh
# planted a real bare constant in live resolver.js, confirmed gate:params catches it, restored
node -e '<independent Appendix A / §8.10 spec-table parser, cross-checked against register>'
node -e '<independent α/Ω_policy/conservatism re-derivation from live register values>'
node -e '<brute-force rounding correctness sweep, ~1.3M values>'
npx prisma validate
npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script
diff <(sort mine) <(sort prisma-generated)  # tables/enums/indexes byte-identical
# supertest reproduction of the two malformed-publish-input 500s, forced-failure to surface body
git log / git diff e558243 4244b3d --stat   # baseline citation and regression-path investigation
```

Working tree left clean; no scratch files or planted violations remain in the repository.

---

# ADDENDUM — Remediation outcome (2026-08-10)

**Everything above this line is the original 2026-07-28 verification, preserved verbatim.**
Nothing in it has been edited, softened, or removed, including the one claim that remediation
found to be wrong. This addendum records what happened to each finding. The full per-finding
record — root cause, fix, regression test, evidence — is
[`PHASE_1_REMEDIATION_AND_CLOSURE.md`](PHASE_1_REMEDIATION_AND_CLOSURE.md).

**Remediation HEAD:** `62d8141` (the verification HEAD `4244b3d` is four commits behind;
Phases 2–15 have since landed).

| Part 12 # | Finding | Outcome | Where |
|---|---|---|---|
| 1 | `toMilliCU()` misrounds exact-half-boundary decimals | ✅ **FIXED** — scaling replaced by an exact base-ten `BigInt` conversion with no float intermediate. Re-swept: **0 wrong in 800 000** half boundaries (was 5 900); **0 divergence** on 300 000 ordinary values; 13 regression tests | §1 |
| 2 | `POST /api/config/publish` 500s on malformed input | ✅ **FIXED** — `ConfigValidationError` moved into its own module below the three modules that detect malformed input; each now raises it with structured findings. Proven by counterfactual: reverting one throw site reproduces the exact 500, restoring it passes 25/25. A genuine internal fault still returns 500 | §2 |
| 3 | Exported functions lack direct coverage | ✅ **FIXED** — all 7 covered, 26 tests. Testing found a further real defect: `deepFreeze()` overflowed the stack on a cyclic graph; fixed by freezing before recursing | §3 |
| 4 | `cost.reference_agent_class` undercounted | ✅ **DOCUMENTATION CORRECTED** — Assumption 3 now says thirteen and names it, its §1.3 source, and why it sits in `cost.json`. The parameter was not changed | §4 |
| 5 | Baseline commit citation | ⚠️ **THIS REPORT'S CLAIM WAS THE INACCURATE ONE.** `git rev-parse 4244b3d^` returns `e558243` — it **is** the direct parent, and `git log e558243..4244b3d` shows exactly one commit. There is no intervening commit. The real, accurate finding is that `4244b3d` bundles Phase 0 + Phase 1 + unrelated legacy-dispatcher fixes in a single commit, so the two phases are not individually attributable from history. Corrected in the implementation report's header, with evidence | §5 |
| 6 | §22.2 post-`site` branch linearisation | ⚠️ **PRESERVED, NOT RESOLVED** — no rule resolving it exists anywhere in the frozen specification, so runtime behaviour was deliberately left alone and the convention documented and pinned by 5 tests. **This report's "zero live exposure" no longer holds:** at the current register, `energy.model_residual_cv` and `payload.packing_node_budget` each declare `agent_class` *and* `mission_class`. Still latent, no longer hypothetical | §6 |
| 7 | V9 rejects the seeded conservatism defaults | ⚠️ **VERIFIED / NO DEFECT — EXTERNAL SAFETY DECISION REQUIRED.** Arithmetic re-derived from Appendix A; the register still holds 1.00/1.15/1.25/1.40 and a 1.60 cap **unchanged**; V9 and the publish path both behave correctly. No authorised decision exists — `PHASE_15_BLOCKER_RESOLUTION_PLAN.md` row 14 still carries it open and blocking. 4 tests added to guard the defaults against a silent edit | §7 |
| Part 6 | Immutability triggers not executed against a live instance | ✅ **EXECUTED** — **18/18** against a disposable PostgreSQL 18.3 (PGlite, in memory, installed outside the repository). `ConfigVersion` `UPDATE` and `DELETE` both refused with the intended message. The shared Neon database was not used; the local PG18 service was not used because it requires `scram-sha-256` and no credentials are on file — they were not guessed and `pg_hba.conf` was not modified | §8 |

**Two findings remain open by design**, because closing either is outside any implementation
phase's authority: the §22.2 ambiguity (architecture) and the §14.3 conservatism margin
(Safety, blocking decision B8). **Two environmental limitations remain**: the migration was
exercised on PostgreSQL-compiled-to-WASM rather than the deployment platform, and against an
empty database rather than a production-shaped dump.

The Part 12 verdict — **PASS WITH MINOR ISSUES** — stands, with all three implementation
issues now fixed rather than carried.
