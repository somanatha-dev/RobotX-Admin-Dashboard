# Phase 0 — Program setup and guardrails · Implementation Report

**Phase:** 0 of 16 · **Status:** ✅ **COMPLETE — awaiting approval to begin Phase 1**
**Date:** 2026-07-28 · **Branch:** `feature/dashboard` · **Baseline commit:** `e558243`
**Authority:** `IMPLEMENTATION_EXECUTION_PLAN.md` §3 "PHASE 0" and §7 "Phase 0" checklist
**Specification:** `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` (FROZEN) — §1.5, §1.8, §3, §22, §26, Appendix C

> **Phase 1 has NOT been started.** No configuration service, no parameter register
> content, no units, no determinism substrate. Nothing in this phase alters runtime
> behaviour.

---

## 1. Objective

Phase 0 establishes the structures every later phase depends on — **tier tagging, the
engine module tree, and the build gates that will refuse defective work** — before any
behaviour changes.

The reasoning behind putting this first is stated by the specification itself (§1.8):
a document in which thirty-eight feasibility predicates, column generation, deferral,
preemption, and hierarchical Bayesian reliability estimation all appear at the same
level of obligation **will** be partially implemented, and the subset that ships will
be self-selected by whoever implements it first, with no analysis of whether that
subset is safe on its own.

Phase 0 removes that possibility mechanically. After this phase:

- Every mechanism §1.8 names has a **declared tier** and a **named owning module**,
  in a form a program reads rather than a human remembers.
- A Tier 0 or Tier 1 module that comes to depend on a Tier 2 mechanism **fails the
  build** (§1.8 rule 2), rather than being caught in review or not at all.
- A behavioural constant written outside the parameter register **fails the build**
  (§22, Appendix A), so no phase can introduce a constant that has to be
  retro-registered — a constant retro-registered later is one that shipped
  uncalibrated, unowned, and unscoped.
- Cost evaluation that can see an unvetted candidate **fails the build** (T1, I14),
  and a wall-clock read in the decision path **fails the build** (T6, I10).
- Every architectural decision of Appendix C is an individually citable, frozen
  record.

**Nothing runs.** `src/engine/**` contains no runtime code, and `ENGINE_ENABLED`
defaults to `false` in every environment.

---

## 2. Files created

### 2.1 Guardrails and documentation — the substance of the phase

| File | Purpose |
|---|---|
| `Backend/src/engine/TIERS.md` | Every §1.8 Tier 0 / 1 / 2 mechanism with its owning module path, invariants, kill switch, and degraded behaviour. **Generated from `tierAssertions.js`**, so prose cannot drift from the data the gate enforces |
| `Backend/src/engine/ARCHITECTURE.md` | Every §3.2 component mapped to its module path and owning phase; the §3.1 layering; the full directory tree; the rules each gate enforces |
| `Backend/src/engine/guards/tierAssertions.js` | **The machine-readable tier registry** — 31 mechanisms, the module→tier table, the §26.1 invariant partition, the §22.5 kill-switch ladder, and the assertions that prove the registry coherent |
| `Backend/src/engine/guards/tenets.js` | T1 (type separation) as a runtime feasibility brand *and* a build-time assertion; T6 (no wall-clock reads in the decision path) as a build-time assertion. Runnable as a gate |
| `Backend/src/engine/guards/sourceScan.js` | Dependency-free JavaScript lexer shared by the three gates (Phase 0 adds no npm dependencies, so no parser is available) |
| `Backend/tools/gates/checkTierDependencies.js` | **Build gate** — §1.8 rule 2 over the static import graph, plus registry-coherence checks |
| `Backend/tools/gates/checkParameterRegister.js` | **Build gate** — §22 / Appendix A: no behavioural constant outside the parameter register |
| `.github/workflows/ci.yml` | CI. Gates run first, as their own named steps, ahead of the test lanes |

### 2.2 Test suites

| File | Contents |
|---|---|
| `Backend/tests/gates/fixtureTree.js` | Helper that materialises a source tree with a **planted violation**, using real engine module paths so the real tier table applies |
| `Backend/tests/gates/checkTierDependencies.test.js` | 16 tests — planted Tier 0→Tier 2 and Tier 1→Tier 2 imports, ESM syntax, commented-out imports, compliant downward edges, the dependency-inverted pattern, registry coherence, the real tree |
| `Backend/tests/gates/checkParameterRegister.test.js` | 14 tests — planted bare constant, unknown register entry, unexplained exemption, hex/exponent/separator forms, compliant annotations, numbers in comments and strings, the real tree |
| `Backend/tests/gates/tenets.test.js` | 19 tests — the runtime brand (including that it does **not** survive spread or JSON round-trip), planted T1 and T6 violations, every prohibited non-deterministic source, `Date.UTC` correctly permitted, scope exclusions, the real tree |
| `Backend/tests/engine/tierRegistry.test.js` | 12 tests binding `TIERS.md` to `tierAssertions.js` in both directions, plus mechanism-path existence and tier agreement |
| `Backend/tests/engine/phase0Scaffold.test.js` | 43 tests — the master switch, all 33 module-tree directories, the assertion that the engine holds **no runtime code yet**, the §3.2 component map, and ADR-log completeness against Appendix C |

### 2.3 Architecture Decision Log

| File | Contents |
|---|---|
| `docs/adr/README.md` | Index of all 38 records; what the log is and is not; the supersession rule; how integration decisions (numbered from 33) differ from frozen ones |
| `docs/adr/ADR-*.md` | **38 records**, generated verbatim from Appendix C, every one `Accepted — frozen`. Covers ADRs 01–32 plus the six lettered sub-records 02b, 02c, 02d, 04b, 04c, 09b |

### 2.4 Module tree

**33 directories** under `Backend/src/engine/`, plus `Backend/src/workers/` and
`Backend/tools/gates/`, each held by a `.gitkeep` (34 placeholders):

```
candidates · commitment · config · config/register · cost · degraded · deps
determinism · dispatch · domain · domain/mappers · energy · failure · fairness
feasibility · feasibility/predicates · guards · intake · lifecycle · map
observability · payload · plan · pricing · privacy · reliability · routing
security · shard · solve · spatial · stores · supervision
```

---

## 3. Files modified

| File | Change | Why |
|---|---|---|
| `Backend/package.json` | Added `gate:tiers`, `gate:params`, `gate:tenets`, `gates`, `verify`, `test:legacy`, `test:gates`, `test:engine` | Gates runnable individually and as a set; lanes runnable individually. **No dependencies added** — the plan specifies none |
| `Backend/jest.config.js` | Converted to three Jest **projects**: `legacy`, `gates`, `engine` | Test lanes per the plan. `npm test` still runs everything; CI reports which lane broke |
| `Backend/.gitignore` | Ignore `/tests/gates/.fixtures/` | Gate fixtures contain deliberate rule-2 violations and bare constants. One left behind by an interrupted run must never be committed — a reader would take it for a real defect |
| `Backend/tests/setup/env.js` | `ENGINE_ENABLED = "false"` | Engine tests opt in explicitly; the legacy suite can never be silently routed down a new code path |
| `Backend/.env` | `ENGINE_ENABLED=false` | Master switch, default off |
| `Backend/.env.benchmark` | `ENGINE_ENABLED=false` | The benchmark must keep measuring the legacy dispatcher until the Phase 15 gate, or the before/after comparison the cutover depends on is invalid |

**Not modified:** every file under `Backend/src/services/`, `Backend/src/controllers/`,
`Backend/src/sockets/`, `Backend/src/cache/`, `Backend/prisma/`. Phase 0 is additive
only, exactly as its **LOW** risk rating requires.

---

## 4. Checklist — `IMPLEMENTATION_EXECUTION_PLAN.md` §7, Phase 0

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Create `Backend/src/engine/` module tree per §2 of the plan | ✅ | 33 directories; `phase0Scaffold.test.js` asserts each exists |
| 2 | Write `src/engine/ARCHITECTURE.md` mapping every §3.2 component to its module path | ✅ | All 23 catalogue components mapped, each with a `src/...` path and owning phase; asserted per-component in `phase0Scaffold.test.js` |
| 3 | Write `src/engine/TIERS.md` listing every Tier 0/1/2 mechanism (§1.8) with owning module | ✅ | 11 Tier 0 · 7 Tier 1 · 13 Tier 2 mechanisms; bidirectional agreement with the registry asserted in `tierRegistry.test.js` |
| 4 | Implement `tools/gates/checkTierDependencies.js` — fails on any Tier 0/1 module importing a Tier 2 module | ✅ | Demonstrated failing below (§6.2); 16 self-tests |
| 5 | Implement `tools/gates/checkParameterRegister.js` — fails on any behavioural constant absent from the register | ✅ | Demonstrated failing below (§6.2); 14 self-tests |
| 6 | Implement `src/engine/guards/tenets.js` — build-time assertions for T1 and T6 | ✅ | Both implemented; T1 additionally carries a runtime Symbol brand; 19 self-tests |
| 7 | Add `ENGINE_ENABLED=false` to `.env`, `.env.benchmark`, `tests/setup/env.js` | ✅ | All three; asserted in `phase0Scaffold.test.js` |
| 8 | Add engine test lane to `jest.config.js`; wire both gates into CI | ✅ | Three lanes; `.github/workflows/ci.yml` runs all three gates as named steps before the test job |
| 9 | Create `docs/adr/` and record ADRs 01–32 from Appendix C as accepted-and-frozen | ✅ | 38 records (01–32 plus 02b/02c/02d/04b/04c/09b), all `Accepted — frozen`; completeness asserted against Appendix C by parsing the specification |
| 10 | **Gate:** both build gates demonstrably fail on planted violations; full existing suite green | ✅ | §6 below |

**10 of 10 complete. No item skipped, deferred, or partially satisfied.**

---

## 5. Completion criteria — §3 "PHASE 0"

| Criterion | Result |
|---|---|
| `npm test` green | ✅ **27 suites, 273 tests, 0 failures.** The 169 pre-existing tests are all still green and unmodified |
| Both gates run in CI | ✅ `.github/workflows/ci.yml`, job `gates`, one named step per gate, ahead of the test job |
| Both gates demonstrably fail on planted violations | ✅ §6.2 — both exit `1` with a specific, actionable message |
| `src/engine/TIERS.md` enumerates every §1.8 Tier 0/1/2 mechanism with its owning module path | ✅ 31 mechanisms, each with owning module(s), spec sections, and invariants; Tier 2 additionally with kill switch and degraded behaviour |

---

## 6. Verification results

### 6.1 Full suite and gate run — `npm run verify`

```
> gate:tiers
gate: tier-dependencies (§1.8 rule 2)
  PASS — 64 module(s), 2 governed import edge(s), no Tier 0/1 → Tier 2 dependency.

> gate:params
gate: parameter-register (§22, Appendix A)
  PASS — 0 engine module(s) checked against 0 registered parameter(s); no bare behavioural constants.

> gate:tenets
gate: tenets (T1 type separation, T6 decision-path determinism)
  PASS — 61 module(s) checked, no violations.

> test
Test Suites: 27 passed, 27 total
Tests:       273 passed, 273 total
Ran all test suites in 3 projects.
```

| Lane | Suites | Tests | Note |
|---|---|---|---|
| `legacy` | 22 | 169 | **Identical to the pre-Phase-0 baseline.** No legacy test was modified, skipped, or re-baselined |
| `gates` | 3 | 49 | New |
| `engine` | 2 | 55 | New |
| **Total** | **27** | **273** | |

The parameter gate reporting `0 engine module(s)` is correct and expected: Phase 0
creates no runtime engine code, and `phase0Scaffold.test.js` asserts that fact
independently. The gate becomes load-bearing in Phase 1, when the register is seeded
and the first parameters are consumed.

### 6.2 Gates failing on planted violations

Planted tree: a Tier 0 module importing a Tier 2 module; a bare constant; a
candidate-shaped parameter without a brand assertion; a wall-clock read in cost.

```
########## GATE 1: tier dependencies ##########
gate: tier-dependencies (§1.8 rule 2)
  FAIL
  1 forbidden dependency edge(s):
    src/engine/commitment/commit.js:1  →  src/engine/cost/cDefer.js
        Tier 0 — Safety core module imports Tier 2 — Allocation quality module.
        §1.8 rule 2: no Tier 0 or Tier 1 guarantee may depend on a Tier 2 mechanism.
        Invert the dependency — the Tier 2 module registers with, or is injected
        into, the Tier 1 module.
>>> exit code: 1

########## GATE 2: parameter register ##########
gate: parameter-register (§22, Appendix A)
  FAIL — 1 violation(s) across 3 module(s):
    src/engine/cost/cDelay.js:1  [bare-constant]
        bare behavioural constant 30000 is absent from the parameter register.
        Register it (§22, Appendix A) and annotate the default "@param <name>", or
        annotate "@structural <reason>" if it encodes structure rather than behaviour
>>> exit code: 1

########## GATE 3: design tenets ##########
gate: tenets (T1 type separation, T6 decision-path determinism)
  FAIL — 2 violation(s) across 3 module(s):
  T1  src/engine/cost/cDelay.js:2
      accepts candidate-shaped parameter "candidate" but the module never calls
      assertFeasible(); cost evaluation must be structurally unable to see an
      infeasible candidate (§1.5 T1, §7.1, I14)
  T6  src/engine/cost/cDelay.js:2
      reads Date.now() in the decision path; a decision that cannot be replayed
      from its pinned snapshot is prohibited (§1.5 T6, §9.6, I10)
>>> exit code: 1
```

The same violations are planted and asserted in the `gates` lane, so the property is
regression-protected rather than demonstrated once.

### 6.3 Registry coherence, proven mechanically

| Property | Spec | Proof |
|---|---|---|
| The invariant register partitions cleanly across tiers | §26.1 | `assertInvariantPartition()` — I1…I22 assigned; Tier 0 set, Tier 1 set, and `{I20}` match §1.8 exactly |
| Every Tier 2 mechanism is individually disableable and states its degraded behaviour | §22.5 rule 1 | `assertTierTwoIsDisableable()` |
| The supported ladder is exactly nine switches in the stated order | §22.5 rule 2 | `tierRegistry.test.js` |
| Every mechanism's owning module lies in a directory that exists | — | `tierRegistry.test.js` |
| Every mechanism's module resolves to the tier its mechanism declares | §1.8 | `tierRegistry.test.js` |
| `TIERS.md` ⟷ `tierAssertions.js` agree in both directions | — | `tierRegistry.test.js` |
| The ADR log covers Appendix C completely | Appendix C | `phase0Scaffold.test.js` parses the specification and matches every id |

Both coherence assertions run on **every invocation** of the tier gate, so a future
edit to the registry that breaks the §1.8 partition fails CI at the gate step.

---

## 7. Findings requiring a decision — please read before approving

### 7.1 ⚠️ Recorded specification discrepancy: three Tier 2 mechanisms have no §22.5 kill switch

**This was found by the guardrail, not by inspection**, which is the guardrail working
as designed.

§1.8 enumerates **twelve** Tier 2 mechanisms. §22.5 tabulates **nine** kill switches
and then reasons explicitly about "the nine independent switches above" and their 512
combinations. Three §1.8 mechanisms have no row of their own:

| Mechanism | §1.8 cite | Nearest §22.5 row (none is an exact match) |
|---|---|---|
| Churn pricing | §8.9 | — |
| Post-solve local search | §9.5 | — |
| The duty-cycle regulariser | §17.2 | — |

§1.8 rule 1 is unconditional: *"Every Tier 2 mechanism MUST be individually
disableable."* As written, the two sections cannot both be satisfied by nine switches.

**What Phase 0 did:** recorded it, did not resolve it. Resolving it is an architecture
change and the architecture is frozen. The three carry their own switches
(`churn_pricing`, `local_search`, `duty_cycle_regulariser`) so §1.8 rule 1 holds, and
they are marked **off ladder**, leaving §22.5 rule 2's prefix reasoning and its 2⁹
combination count untouched. Throwing one of the three is therefore an *unrehearsed
combination* under §22.5 rule 2 and alerts as such — which is the conservative
reading.

**Owner:** tech lead. **Needed by:** Phase 1, which owns
`src/engine/config/killSwitches.js` and the ladder. **Options** (all architectural,
none taken here): extend the §22.5 table to twelve and restate the ladder; fold each
of the three into an existing switch; or confirm the off-ladder treatment as the
intended reading.

### 7.2 `settlement.js` is dual-tiered by §1.8

§1.8 lists settlement *ordering* under Tier 0 (custody) and settlement under Tier 1.
The gate needs a single tier per module, so `src/engine/lifecycle/settlement.js` is
assigned **Tier 0** — the stricter of the two. This can only over-constrain the rule-2
gate, never relax it. Recorded in `TIERS.md`; no decision needed unless Phase 5
disagrees.

---

## 8. Assumptions

Each is an implementation choice not dictated by the plan, stated so it can be
overruled.

1. **Modules §1.8 does not name default to Tier 1.** §1.8 enumerates mechanisms whose
   absence has a stated cost, not an exhaustive module partition. Only a mechanism
   §1.8 explicitly lists under Tier 2 is Tier 2. The default is conservative — it can
   only over-constrain the gate.
2. **A Tier 2 behaviour gets its own module.** Where a module would host both a base
   behaviour and a Tier 2 enhancement, the enhancement is a separate module, so
   `cost/phi.js` (Tier 1) obtains optional terms by registration rather than static
   import. This follows from §1.8 rule 2 and §22.5 rule 1 read together: a Tier 2
   mechanism statically linked into the Tier 1 path is a kill switch that cannot
   actually be thrown.
3. **The decision-path scope for T6** is `candidates · feasibility · cost · plan ·
   solve · determinism · energy`, excluding `determinism/snapshot.js` (where the
   round's time is *captured*), `energy/chargingSchedulerClient.js` (an L1 dependency
   client), and `energy/midMission.js` (L2 supervision). Declared as data in
   `tenets.js` and asserted in the gates lane; a phase may extend it.
4. **The cost-evaluation scope for T1** is `cost` and `solve`.
5. **`sourceScan.js` is an unlisted file.** The plan's file list names `tenets.js` and
   the two gate scripts. All three need to lex JavaScript, and Phase 0 adds no
   dependencies, so the lexer is factored into one module inside the listed
   `guards/` directory rather than triplicated. It is implementation support for
   listed modules, not a new architectural component.
6. **Lexical, not syntactic, analysis.** With no parser dependency the gates work on a
   blanked-literal view of the source. Two documented limitations, **both one-sided
   toward false negatives** (a compliant file is never failed): a constant hidden
   inside a template-literal expression is not seen, and a misclassified regex
   literal blanks code rather than revealing it. If a phase needs syntactic
   precision, adding a parser is a dependency decision for the tech lead.
7. **CI is new.** The repository had no `.github/workflows/`. Phase 0 creates a
   GitHub Actions workflow because the plan requires the gates to "run in CI".
   If the programme uses a different CI system, the two jobs translate directly —
   the contract is `npm run gates` then `npm run test:legacy && npm run test:engine`.
8. **ADRs are one file per record.** The plan's file list names only
   `docs/adr/README.md`, while the checklist requires the ADRs to be *recorded*. Both
   are provided: 38 individual records plus an index. Individual files are what make
   `ADR-04` citable from a code comment, which is the log's main purpose.
9. **`.gitkeep` placeholders.** Git does not track empty directories, so the module
   tree is materialised with empty `.gitkeep` files. A directory holding only a
   `.gitkeep` is a placeholder whose owning phase has not landed.

---

## 9. Remaining TODOs

### 9.1 Carried out of Phase 0 — none blocking

| # | Item | Owner | Due |
|---|---|---|---|
| 1 | Resolve the §1.8 / §22.5 kill-switch discrepancy (§7.1) | Tech lead | Phase 1 |
| 2 | Seed `src/engine/config/register/*.json` from Appendix A and §8.10 — the parameter gate is inert until this exists | Phase 1 | Phase 1 |
| 3 | Confirm the `settlement.js` Tier 0 assignment (§7.2) | Phase 5 | Phase 5 |
| 4 | Extend the T1 build assertion from module-level to call-site-level once cost modules exist | Phase 8 | Phase 8 |
| 5 | Add the layer-direction check (§3.1 "a layer may only depend downward") as a fourth gate once modules carry layer tags | Phase 10 | Phase 10 |
| 6 | Add the §24.3 erasure-corpus build gate (ADR-30) | Phase 14 | Phase 14 |

### 9.2 Explicitly out of scope for Phase 0

Database migrations · Redis changes · Socket.IO changes · REST API changes ·
background workers — **the plan specifies "None" for every one of these, and none was
made.**

### 9.3 Programme pre-work the plan flags as startable now

`IMPLEMENTATION_EXECUTION_PLAN.md` §6.2 states: *"Routing migration (B1) slips and
blocks the decision-path track … Start B1 procurement during Phase 0."* This is a
procurement and infrastructure action, not a code change, and is **not** included in
this report. Flagging it so it is not lost between phases.

---

## 10. Phase 1 readiness

| Prerequisite | State |
|---|---|
| Phase 0 complete | ✅ 10/10 checklist, 4/4 completion criteria |
| Dependencies for Phase 1 | Phase 0 only — satisfied |
| Blocking decision | §7.1 should be resolved before `killSwitches.js` is written; it does not block the rest of Phase 1 |
| Locations Phase 1 needs | `src/engine/config/`, `config/register/`, `cost/`, `determinism/` — all created |
| Guardrails Phase 1 will meet | Tier gate (Tier 1 modules), parameter gate (becomes load-bearing), tenet gate (`determinism/` is in the T6 scope) |

---

## 11. Stop

**Phase 0 is complete. Phase 1 has not been started and will not be started without
explicit approval.**

Phase 1 — Configuration, units, and determinism substrate — is a **MEDIUM** risk phase
that retires `src/config/dtaro.constants.js`, touches `robotValidator.service.js` and
`simulation/constants.js` through a shim, and adds four database models and three REST
endpoints. It is the second root of the dependency graph and must precede every phase
that reads a parameter.
