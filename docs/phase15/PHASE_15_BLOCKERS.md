# Phase 15 — Blocker Register

**The canonical list of what prevents Phase 15 from closing.**

> Current source of truth for navigation and verdict: **[`PHASE_15_MASTER.md`](PHASE_15_MASTER.md)**.
> Evidence for every "last verified" line below: [`PHASE_15_VERIFICATION_STATE.md`](PHASE_15_VERIFICATION_STATE.md).

**Last verified:** 2026-08-29 · **Tree:** digest `431010ace188c4b1…` (565 files), HEAD `b68dc5d`
**Re-verified 2026-08-29** by the documentation-integrity audit: every blocker below re-derived from
the current repository; blocker count and classifications unchanged. The audit added the
§ *Cross-phase documentation discrepancies* register at the end and found **no new blocker**.

## Summary

| Count | |
|---:|---|
| **8** | Open blockers |
| **0** | REPOSITORY-OWNED and actionable |
| **2** | EXTERNAL (B1, B8) |
| **2** | SPECIFICATION / ADR (X3, X1/T1-04) |
| **3** | EVIDENCE / OPERATIONS (B-P, B-O, B-M) |
| **1** | REPOSITORY-OWNED but correctly deferred to another phase (A9) |
| **0** | NOT EVALUATED |

Plus **7 residual in-repository observations** — reported, not fixed, none permissive. They are
listed at the end and are **not** counted as blockers.

**Standing rule for this register.** A blocker is not re-opened because an archived report carries
an older classification, and not closed because an archived report says "FIXED". Each entry below
was re-derived from the current repository on 2026-08-29.

---

## B1 — No routing engine is selected

**Status:** OPEN
**Classification:** **EXTERNAL**
**Owner:** Operations + Commercial (D1) · Product + Fleet Engineering (D3) · Operations (D8)
**First discovered:** 2026-08-08 (`PHASE_15_B1_ROUTING_DECISION_REPORT.md`). Originally recorded as
in-repository composition work (D-4 / D-5); **reclassified to EXTERNAL on 2026-08-22** and
re-confirmed EXTERNAL by every pass since.
**Last verified:** 2026-08-29

**Current evidence:**
- `npm run gate:composition` → exit **1**, 1 violation of 18 workers: `coordinator`
  `[LEADER_ONLY_NOT_COMPOSABLE]`, owner declared **EXTERNAL** by the gate itself.
- `npm run release:verdict` → §24 gate `engine_decision_path_wired` **RED**.
- `npm run routing:readiness` → `OVERALL: BLOCKED`; D1, D3, D8 each BLOCKED; Steps 1, 3, 4, 5
  BLOCKED; Step 2 PASS.
- `tools/verify/phase15CurrentTree.js` check **G2** confirms coordinator and shadow remain
  uncomposable.

**Why it blocks:** `coordinator`'s round loop needs `expandCandidates`, `pricedCandidateFor` and
`commit`. The first two resolve through `plan/insertion.js → planBuilder.hopsForSequence →
routing/cellPairCache.hopsFor` to an injected `route` function — the routing engine. With no engine
selected, the Tier 0 decision path has no leaf. `engine_decision_path_wired` is one of 24 blocking
§24 gates.

**Three workers, not one, are held by B1.** `gate:composition` fails on `coordinator` alone,
because it is the only one *declared* `LEADER_ONLY` and therefore expected to start. Two more are
`DEFERRED` on the same dependency and so pass the gate by declaration:

| Worker | Readiness | Consequence of B1 |
|---|---|---|
| `coordinator` | `LEADER_ONLY` | Gate violation. No round can execute |
| `shadow` | `DEFERRED` | **`shadow_agreement` cannot begin accumulating evidence at all.** The system is not merely short of the 14-day window — it cannot start the clock. This is why **B-P** is gated by B1 |
| `charger_reachability` | `DEFERRED` | Scheduling it needs the routing client this process does not construct (Phase 8's `routing/client.js`) |

Full readiness breakdown: [`PHASE_15_IMPLEMENTATION_STATE.md`](PHASE_15_IMPLEMENTATION_STATE.md)
§ *Workers and the composition root*.

**Can repository code solve it?** **No.** Selection is B1 Step 5: a choice made on recorded
benchmark evidence and written into an ADR. Step 3 evidence cannot be produced because Step 1
(deploy each candidate against the target region extract, build per-profile contraction hierarchies)
requires a region that does not exist.

**Required external input:**

| | Owner | What is missing |
|---|---|---|
| **D1** | Operations + Commercial | The authoritative operating region: `regionId` + `name`, `kind`, the serviceable boundary as GeoJSON Polygon/MultiPolygon in **WGS-84 `[lon, lat]`**, the CRS, and a version label with a date |
| **D3** | Product + Fleet Engineering | The agent classes this deployment operates and, per distinct mobility model, §2.2's six elements with a real speed model over `roadClass`, `gradient`, `surface`, `payloadMass`, `congestion`, `weather` |
| **D8** | Operations | Extract identity, source, vintage (ISO date, never a file timestamp), refresh cadence, re-contraction downtime budget, **plus `extract.bbox` and `extract.marginDegrees`** (read by validator V-13) |

D1 additionally releases: the cell cover (Engineering), the charger catalogue (Ops / Charging — now
required, not optional), V-11 disjointness, V-12 containment, V-13 margin, D2's residual (N23), and
`projectCell()` (N27).

**Required engineering work after the dependency arrives:**
1. B1 Steps 1, 3, 4 — deploy, benchmark, record.
2. B1 Step 5 — write the ADR selecting the engine.
3. `src/engine/routing/client.js` — the production Routing Service client (§5.2's degradation ladder,
   §18.3 B6's uniform-treatment rule, the `route(parts)` seam). **Phase 8**, also blocked by N25/N26.
4. Composition-root construction at `server.js`: `evaluateExact`, `pricedCandidateFor`,
   `hopsForSequence`, plus the routing client and charger precompute trigger. **Estimate as
   composition-root work, not adapter wiring.**

**Do not:**
- Select, rank, recommend or hint at an engine. `b1Readiness.js` explicitly refuses to, and so must you.
- Invent a region, boundary, CRS, speed model, extract vintage or bbox.
- Treat `prisma/seed.js`'s `SEED_SPATIAL_MAP` / `RGN-BLR` as production configuration. It is a Phase 2
  containment demonstration: four fine cells, placeholder cell ids, never published as a config version.
- Write a stub, fake or in-process router to make `gate:composition` pass. Starting the coordinator
  against an invented router assigns real work on invented travel times.
- Use `DEGRADED_ROUTING` as a substitute for a routing service.

**Closure condition:** D1, D3 and D8 answered; Steps 1/3/4 executed and recorded; Step 5 ADR
written; the routing client and composition root built; `gate:composition` exits 0;
`engine_decision_path_wired` GREEN.

---

## B8 — Safety-class parameters are not DERIVED

**Status:** OPEN
**Classification:** **EXTERNAL**
**Owner:** §22.4's named calibration owner
**First discovered:** 2026-08-08 · **Last verified:** 2026-08-29

**Current evidence:** `npm run gate:calibration` → exit **1**, `FAIL — 39 blocking finding(s)`.
242 registered entries: **52 DERIVED, 152 PROVISIONAL, 38 UNCALIBRATED; 54 Safety-class.**
`phase15CurrentTree.js` check **G3** confirms the gate and the publish validator agree that B8
blocks the cutover (190 launch-gate findings; defaults refused by V9).

**Why it blocks:** §22.4 — no Tier 0 parameter may be `PROVISIONAL` or `UNCALIBRATED` at launch.
§24 gate `calibration_safety_derived` is `NOT_EVALUATED`, which blocks exactly as RED.

**Can repository code solve it?** **No.** Every one of the 39 findings names what it awaits, and
none of them is a code change — e.g. *"per-class rated-mass certification"*, *"the operated CA's
revocation-publication latency"*, *"a safety decision with the local highway or site authority"*,
*"measured on-board scale accuracy per container model"*.

**Required external input:** a named calibration owner, and per-parameter derivation from a stated
accounting or measured basis (§22.4's `DERIVED` definition).

**One worker is held by B8.** `energy_calibration` is `DEFERRED` — it exposes a pass function
rather than a scheduler, and its inputs are realised-outcome rows the fleet has not produced. The
registry records it as one of the loops B8's calibration owner governs. It does not fail
`gate:composition`, because the deferral is declared.

**Required engineering work after the dependency arrives:** record the derived values and their
bases in the register; `gate:calibration` then passes without any code change.

**Do not:** derive, invent, edit, promote or reclassify any calibration value. **§22.3 forbids any
automated process from changing a Safety-class parameter.** Note in particular that
`release.soak_duration` is still `PROVISIONAL` and was deliberately **not** promoted — an earlier
pass made the system *use* it, which is a different act from calibrating it.

**Closure condition:** 39 findings → 0; `gate:calibration` exit 0; `calibration_safety_derived` GREEN.

---

## B-P — Four PRODUCTION gates are NOT_EVALUATED

**Status:** OPEN
**Classification:** **EVIDENCE / OPERATIONS**
**Owner:** Operations — requires an operating fleet
**First discovered:** 2026-08-08 · **Last verified:** 2026-08-29

**Current evidence:** `release:verdict` shows `invariants_enforced`, `simulator_fidelity`, `soak`
and `shadow_agreement` all `NOT_EVALUATED`. `npm run sim:fidelity` → exit **1**, all 7 models
`NOT_MEASURED`, 6 safety-relevant, no study supplied.

**Why it blocks:** these four gates are discharged by *observed production behaviour over a
declared window*. There is no collector for them; an operator files them by hand. `NOT_EVALUATED`
blocks exactly as RED.

**Can repository code solve it?** **No.** Worse — **the observation cannot even begin**: the shadow
worker cannot compose, for the same reason `coordinator` cannot (B1). The 14-day shadow-agreement
window has no start.

**Required external input:** an operating fleet; a simulator-fidelity study against realised
production data (`sim:fidelity --input <file.json>`); a completed soak; a completed shadow window;
an invariant-observation window (execution-plan **OP-8**, a pre-existing gap — I13 consumes the
window, no phase creates it).

**Do not:** fabricate an observation window, a soak record, a fidelity study or a shadow-agreement
result. This is the exact attack surface finding **P15-E1** closed — malformed windows
(`NaN`, `±Infinity`, entirely-in-the-future) were being ADMITTED and PASSED on precisely these four
gates, and would have taken a shard live. The authority now refuses them by name. **Do not weaken
that, and do not route around it.**

**Closure condition:** each of the four filed with a valid, finite, past, sufficiently long
observation window and a genuine result.

---

## B-O — Three ORGANISATIONAL gates are NOT_EVALUATED

**Status:** OPEN
**Classification:** **EVIDENCE / OPERATIONS**
**Owner:** Named humans — the release owner, the calibration owner, the rehearsal operator
**First discovered:** 2026-08-08 · **Last verified:** 2026-08-29

**Current evidence:** `calibration_safety_derived`, `safety_case_assembled` and `rollback_rehearsed`
are all `NOT_EVALUATED`. **0 attestations are filed** — `release-evidence.json` carries 17 build
records and no attestation block.

**Why it blocks:** these are human sign-offs. `npm run safety:case` exits 0 and every reference
resolves, but **the assembler files no evidence** — it reports "0 green, 0 red, 24 not evaluated"
itself. An assembling safety case is not a discharged §24.7 gate.

**Can repository code solve it?** **No.**

**Required external input:** a filed safety-case attestation; a recorded rollback rehearsal per
`docs/runbooks/rollback.md` §5, in a declared non-production environment (ADR-34's `REHEARSAL`
purpose exists for exactly this and sets aside exactly one gate); the B8 calibration attestation.

**Do not:** file an attestation on anyone's behalf. Note that `verdict.js` (and now
`cutover.md` §3.2) forces a gate **RED** when a build record and an attestation collide for the
same gate id — do not attempt to override a build record with an attestation.

**Closure condition:** three attestations filed by named humans and admitted by `evidence.admit()`.

---

## B-M — `model_check_capacity_1_2_3` is GREEN and NOT PROVEN

**Status:** OPEN
**Classification:** **EVIDENCE / OPERATIONS** (compute provisioning)
**Owner:** Release owner + compute
**First discovered:** pass 3 (as **P15-E5**) · **Last verified:** 2026-08-29

**Current evidence:** `release:verdict` prints the gate as GREEN with an inline `[NOT PROVEN]`
annotation generated by the tool: *"the discharging suite asserts `exhaustive: false` for the
lifecycle at capacities 1, 2 and 3, and `lifecycle.tla` has never been run under TLC; the commitment
half is exhaustive only at capacity 1."* A repository-wide search confirms **`tla2tools.jar` is
absent** — TLC is not runnable on this tree.

**Why it blocks:** the gate's *statement* is an exhaustive model check. A passing exit code from the
discharging command does not establish it. The `[NOT PROVEN]` annotation is the honest record of
that gap, deliberately made visible rather than silent.

**Can repository code solve it?** **No** — it needs `tla2tools.jar` and a compute run. The artefacts
it would check (`formal/commitment.tla`, `formal/lifecycle.tla`, six `.cfg` configurations) all
exist.

**Required external input:** `tla2tools.jar` and machine time.

**Required engineering work after the dependency arrives:** run the six configurations per
`formal/README.md`; then, and only then, remove `establishedByCommand` from the gate.

**Do not:** remove the `[NOT PROVEN]` annotation, change the gate algebra, or mark the gate proven.
The GREEN status is *not* a discharge and must not be read as one.

**Closure condition:** a completed exhaustive TLC run recorded as evidence.

---

## X3 — No `TASK` timer producer; §4.2 has no transition table

**Status:** OPEN
**Classification:** **SPECIFICATION / ADR**
**Owner:** The frozen-specification owner
**First discovered:** adversarial pass 1, 2026-08-22 · **Last verified:** 2026-08-29

**Current evidence:** `tools/verify/phase15CurrentTree.js` check **G1** — *"FINDING X3 — no §4.2 Task
state is written anywhere, so no TASK timer has a producer."* Passes as a finding assertion, i.e. it
confirms the gap is still present.

**Why it blocks:** the timer subsystem implements expiry for entities whose §4.x transition tables
exist. §4.2 (`TASK`) has none, so there is nothing to produce a `TASK` timer *from*.

**Can repository code solve it?** **No — and it must not.** Pass 2 recorded this explicitly as
*"NOT FIXED, and must not be"*: inventing a TASK transition table would be writing specification,
and `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` is **FROZEN**.

**Required external input:** a §4.2 transition table from the specification owner, or an ADR
declaring that `TASK` has no timed transitions.

**Do not:** invent a TASK state machine, a TASK timer producer, or a §4.2 transition table.

**Closure condition:** the specification decision is recorded, and the repository implements it.

---

## X1 / T1-04 — The §17.4 escalation ladder and the three fairness modules

**Status:** OPEN
**Classification:** **SPECIFICATION / ADR** — *phase ownership is closed; the work is not done*
**Owner:** **REMEDIAL PHASE T1-04** (`IMPLEMENTATION_EXECUTION_PLAN.md` §3, §6.3)
**First discovered:** recorded as ARCHITECTURE.md gap 16 / OAD-7 · **Last verified:** 2026-08-29

**Current evidence:** `src/engine/fairness/` **exists and is empty**. `ladder.js`,
`operatorCapacity.js` and `agentStarvation.js` are absent. `src/engine/lifecycle/preemption.js` is
absent.

**Why it blocks:** these are **T1-04, Tier 1**, invariant **I13**. §1.8 places the anti-starvation
*guarantee* in this ladder; Phase 8's aging-multiplier cap was justified *because* the guarantee
lives here. The cap shipped; the guarantee did not. Phase 15's completion criteria **E1** and **E2**
cannot be honestly discharged until the remedial phase *completes*, and Phase 16's only prerequisite
is Phase 15.

**Ownership is resolved (OAD-7):** the plan's §3 now carries REMEDIAL PHASE T1-04, prerequisites
Phases 11–14, parallel with Phase 15, preceding Phase 15's E1/E2. **Registration is authorisation,
not implementation.** Do not re-litigate which phase owns it — that decision is closed.

**Required engineering work:** implement the three modules per §1.8 and §17.4, under the remedial
phase.

**Do not:** implement them as part of a Phase 15 task, or treat the resolved ownership as though the
modules now exist.

**Closure condition:** REMEDIAL PHASE T1-04 completes; E1/E2 dischargeable.

---

## A9 — `assertVersionInKey` is implemented, tested, and called by nothing

**Status:** OPEN — **correctly deferred**
**Classification:** **REPOSITORY-OWNED**, deferred to **Phase 8**
**Owner:** Phase 8
**First discovered:** B1 prerequisite pass, 2026-08-28 · **Last verified:** 2026-08-29

**Current evidence:** defined at `src/engine/routing/chargerReachabilityCache.js:124`, exported at
`:375`. The only callers on the whole tree are `tests/engine/energySchema.test.js:268–269` (both
directions asserted) and one explanatory comment in `tools/routing/adapters/contract.js:340`. No
production caller exists.

**Why it does not block now:** its discharge point is `src/engine/routing/client.js` — a Phase 8
module that **does not exist** and cannot exist before B1. Meanwhile `read()` already carries a
genuine independent cross-check that a self-built key could not provide, so nothing is currently
unguarded.

**Can repository code solve it?** Only by manufacturing a caller, which would be a fake seam.

**Do not:** manufacture a caller. A guard called from a synthetic site is not a guard.

**Closure condition:** `src/engine/routing/client.js` is built (post-B1, Phase 8) and calls it.

---

## Residual in-repository observations — reported, not fixed, none permissive

These are **not blockers**. They are carried forward so a future pass inherits named gaps instead of
rediscovering them. Each was re-confirmed present on 2026-08-29.

| # | Observation | Evidence | Why it is not a blocker |
|---|---|---|---|
| 1 | **P15-F7a — nothing binds a runbook to the API it documents.** `docs/` is outside the source-digest scope by design, so no gate detects a runbook drifting from a signature it calls. `docs/runbooks/cutover.md` §3.2 drifted through two contract changes with every build gate green | `tools/release/sourceDigest.js` scope; the P15-F7 defect | Structural gap, not a live defect. Fixing it means either digest-scoping `docs/` (which would void a ~25-min evidence collection on every prose edit — the exact behaviour the exclusion prevents) or adding a prose-parsing gate (an unmaintained future false green). **Recorded deliberately rather than fixed.** |
| 2 | **`docs/runbooks/rollback.md` has never had its procedure executed against the current API.** | No pass has done it | An **unexamined surface**, not a known defect. Status: **UNKNOWN**. Naming it is the honest alternative to implying the runbook class is clean because one file in it was fixed |
| 3 | **`app.locals.releaseEvidence` has no producer** (P15-E6). The cutover health endpoint always evaluates against `{}` | `grep`: no assignment; read with `\|\| {}` at `health.controller.js:319` | **Fails closed** — every gate reads as not-green |
| 4 | **`gates.blockers()` ignores `unknownEvidence`.** Evidence filed against an unknown gate id never appears as a blocker | `src/engine/cutover/gates.js` — `blockers()` filters `results` only | `evaluate()` does fold it into `ok`, and `verdict.js` prints it |
| 5 | **The evidence schema cannot distinguish a gate that failed from a gate that never ran** | Discovered when a gate process failed to start (`0xC0000142 STATUS_DLL_INIT_FAILED`) and the collection was discarded rather than reported | Detected in practice; the affected collection was voided, not published |
| 6 | **The register accessor is injected**, and pass 2's **X-C1** / **X-C2** | Archived third-pass report §33.3, probe 12d | Carried forward, none permissive |
| 7 | **CI does not run `gate:composition`** — CI is green on a tree where a blocking §24 gate is RED | `.github/workflows/ci.yml` — 7 gate steps, no `gate:composition`; the workflow header enumerates exactly **two** deliberate absences (`gate:calibration`, `safety:case`) and this is not one of them, so **no reason is recorded**. `npm run gates` runs 8 and exits 1; CI runs 7 of those 8 and exits 0, and the omitted one is the only one that fails | The gate is authoritative via `npm run gates` and `release:verdict`; CI is not the §24 authority. **Recorded by the consolidation; extended by the 2026-08-29 audit**, which additionally found that `gate:columngen` is pull-request-only (a push runs 6 gate steps) and that `ARCHITECTURE.md` §9.1 and `ROBOTX_SYSTEM_HANDBOOK.md` §42 both described CI as running the complete gate set. Those two prose statements were corrected; **CI itself was not changed** — that is a code change and is out of scope for a documentation pass |

---

## Cross-phase documentation discrepancies — recorded, not owned by Phase 15

**These are not blockers and not Phase 15 findings.** They are places where documentation outside
`docs/phase15/` disagrees with the current repository. The audit of 2026-08-29 classified each by
**who owns the correction**, corrected only the Phase-15-owned ones, and left the rest in place
with the reasoning below. Nothing here was silently discarded.

**Standing rule.** Where any of these documents and the five canonical Phase 15 documents disagree
about Phase 15, the canonical documents win — `PHASE_15_MASTER.md` §1's authority order, rank 3
(the repository) then rank 5. `ARCHITECTURE.md` ranks itself below both, in its own words.

### Corrected on 2026-08-29 — Phase-15-owned and provably false

| # | Statement | Where | Truth | Why Phase 15 owned it |
|---|---|---|---|---|
| **C1** | "None of the 19 workers is on production scheduling" | `ARCHITECTURE.md` §4.2 · `ROBOTX_SYSTEM_HANDBOOK.md` §3.3 | **11 of 18 start.** 8 `SCHEDULED` at boot + 3 of 4 `LEADER_ONLY` on promotion | "All engine workers move to production scheduling" **is** Phase 15's execution-plan row |
| **C2** | "No production composition root exists" (archived finding **N12**) | `ROBOTX_SYSTEM_HANDBOOK.md` §3.3 · §51.2 · §2 summary | **`Backend/server.js` is the composition root.** What is absent is a constructible *solve path* — a different claim, and the one that is still true | Phase 15 built the composition root |
| **C3** | "19 workers" | `ARCHITECTURE.md` §1.4, §4.2 · `ROBOTX_SYSTEM_HANDBOOK.md` §0.1, §3.3, §51.2 | **18 registered.** `src/workers/` holds **20** `.js` files (18 `*.worker.js` + `registry.js` + `leaderWorkers.js`). "19" is wrong under every reading — and `leaderWorkers.js`, which broke the old file count, is Phase 15's own D-5 fix | Phase 15 wrote the registry and `leaderWorkers.js` |
| **C4** | "`gates.blockers({})` returns all **23** rows" / "23 release gates" | `ARCHITECTURE.md` §1.5 · `ROBOTX_SYSTEM_HANDBOOK.md` §60.4, §87 | **24 rows**, all blocking; `blockers({})` returns 24 | The §24 gate table is Phase 15's deliverable |
| **C5** | "16 GREEN, 2 RED, 1 **PARTIAL**, 4 NOT_EVALUATED" | `ROBOTX_SYSTEM_HANDBOOK.md` §60.4 | **16 GREEN, 1 RED, 7 NOT_EVALUATED.** Doubly wrong: the counts moved, **and there is no `PARTIAL` status in the gate algebra** — `gates.js` defines GREEN, RED and NOT_EVALUATED only | It misstates the release verdict, which is the closure surface |
| **C6** | "the seven build gates" | `ARCHITECTURE.md` §2 rank 6 · `ROBOTX_SYSTEM_HANDBOOK.md` §0.2 item 6 · `README.md` verification block | **`npm run gates` runs 8** and **exits 1**. Phase 15 added the eighth, `gate:composition`, and it is the one that fails | Phase 15 added the gate; a "seven gates, all passing" reading hides the RED one |
| **C7** | `gate:legacy` quoted as *"…across 301 file(s)"* | `ARCHITECTURE.md` §1.3 | **340 files**, re-measured 2026-08-29. The load-bearing number is *4 absent*, not the corpus size | `gate:legacy` is Phase 15's gate |
| **C8** | Authority table lists ADR-33 but **not ADR-34** | `ARCHITECTURE.md` §2 rank 2 · `README.md` doc table (said "38 records") | **40 ADR files** = 38 frozen Appendix C records + ADR-33 + **ADR-34**. `docs/adr/README.md`'s "38 records are the complete set" is correct *for the frozen set* and is not a defect | **ADR-34 is Phase 15's own ADR** (cutover rehearsal purpose, resolving D-7) |
| **C9** | CI described as running the complete build-gate set | `ARCHITECTURE.md` §9.1 · `ROBOTX_SYSTEM_HANDBOOK.md` §42 | CI runs **7 of 8** gate steps (6 on a push — `gate:columngen` is pull-request-only) and omits `gate:composition` **without stating a reason** | See residual observation 7 |

### Recorded and deliberately NOT corrected — cross-phase drift

**Reason, stated once and applying to every row below: these are general project counts, not Phase
15 facts, and re-counting the whole handbook is a handbook re-audit rather than a Phase 15
documentation audit.** Correcting them here would also mean Phase 15 silently asserting numbers for
phases it did not measure. A **currency banner** was added at the head of
`ROBOTX_SYSTEM_HANDBOOK.md` instead, and `ARCHITECTURE.md`'s baseline header was relabelled
**historical**, so every figure below is now reachable as dated rather than current.

| # | Drift | Where | Current, measured 2026-08-29 | Owner |
|---|---|---|---|---|
| **D1** | "145 suites · 6 363 tests" (and "6 287", "6 357") | `ROBOTX_SYSTEM_HANDBOOK.md` lines 53, 55, 1136, 1895, 2915, 3858, 3860, 4081, 4083, 4120, 4132, 4350, 4525, 4553 · `ARCHITECTURE.md` header | **160 suites / 7 162 tests / 0 failures**, exit 0 | Whoever next re-compiles the handbook |
| **D2** | "185 engine modules" / "186 `.js` files" | `ROBOTX_SYSTEM_HANDBOOK.md` lines 64, 146, 247, 299, 2911, 3243, 3247, 4110, 4553 · `ARCHITECTURE.md` §1.4 | **Approximate, and each gate scopes its own:** `gate:tiers` governs **285**, `gate:params` scans **189**, `find src/engine -name '*.js'` gives **192**. The handbook's own advice — quote a gate's number with the gate's name attached — is the right rule | Programme-wide |
| **D3** | `gate:tiers` quoted as "277 modules / 386 edges" and `gate:params` as "183 modules" | `ROBOTX_SYSTEM_HANDBOOK.md` §0.1 | **285 / 423** and **189 / 242** | Phase 0's gates |
| **D4** | "39 ADR files … ADR-01 through ADR-33 plus six lettered sub-records" — presented as a *corrected* count | `ROBOTX_SYSTEM_HANDBOOK.md` §0.1 | **40 files**, ADR-01…**34** plus six lettered. The handbook corrected 38→39 and was then overtaken by ADR-34 | Whoever next re-compiles the handbook |
| **D5** | Phase 15 row: "16 GREEN · 2 RED · 1 PARTIAL · 4 NOT_EVALUATED … **BLOCKED**", entry conditions, findings N11–N20 | `ROBOTX_SYSTEM_HANDBOOK.md` §29 phase table, line 1694 | Superseded by this register and by `PHASE_15_CLOSURE_CHECKLIST.md`. Left intact because it is one row of a 16-row cross-phase table whose other rows this audit did not verify | Whoever next re-compiles the handbook |
| **D6** | The label "**Ph15 F1**" applied to the `tla2tools.jar` gap | `ROBOTX_SYSTEM_HANDBOOK.md` §41 | **Naming collision.** In the current ledger **P15-F1** is the observation-bound weakening finding (fixed); the `tla2tools.jar` gap is **B-M**. The handbook's label predates both IDs | Whoever next re-compiles the handbook |

**None of the above blocks anything.** They are registered so the next pass inherits them by name
rather than rediscovering them, and so no one mistakes a dated figure for a current one.

---

## Findings that are CLOSED — do not re-open

Every entry below was raised by an earlier pass and is closed. **Do not re-open one because an
archived report shows it OPEN** — archived reports were frozen at the moment they were written.
Where "verified 2026-08-29" appears, this consolidation re-confirmed it directly; the rest are
closed on the archived pass's own evidence and were not re-attacked here.

| ID | Finding | Resolution |
|---|---|---|
| **D-4 / D-5** | Shadow + Tier 0 decision-path composition, filed as in-repository | **RECLASSIFIED, not fixed.** `outbox` and `reconciler` are wired via `workers/leaderWorkers.js`; `coordinator` and `shadow` are **EXTERNAL — B1**. This reclassification is the correct one and is confirmed by `gate:composition`'s own owner field (verified 2026-08-29) |
| **D-6** | Socket handlers read half the staging switch | **FIXED** — `cutover/agentGate.js` evaluates the full conjunction; all five handlers call it; identity bound at AUTH and refreshed. Live-DB verified, mutation-tested |
| **D-7** | Rehearsal/cutover circularity — the gate set was unsatisfiable | **FIXED under ADR-34** — a `REHEARSAL` purpose requiring a declared non-production environment, setting aside exactly one gate. No gate weakened |
| **D-8** | `SHARD_MIGRATE` undelivered | **FIXED** by the D-5 wiring |
| **D-9** | §4.5 timer expiry semantics — 16 declared `on expiry` actions with no implementation | **RETURNED TO PHASE 5 and closed there** (`PHASE_5_ADVERSARIAL_REMEDIATION_AND_CLOSURE.md`, 2026-08-22): 17 expiry actions implemented, timer worker composed. **Not a Phase 15 blocker** |
| **D-10** | Composition gate used a path proxy | **FIXED** — gate strengthened |
| **D-11** | Duplicate-writer test could not fail | **FIXED** |
| **D-12** | 100/279 modules unreachable | **MEASURED**, informational — reframes D-4/D-5 |
| **D-13** | Fail-open in the D-6 gate | **FIXED** (would have been blocking had it shipped) |
| **P15-R1** | The automatic rollback published nothing | **FIXED** — `cutover/rollbackPublisher.js`, wired at `server.js:207` |
| **P15-R2** | No process ever re-read the pinned configuration | **FIXED** — `cutover/configPropagation.js`; the pull loop runs and is stopped on shutdown |
| **P15-R3** | §18.5's command suspension was unwired | **FIXED** — the shard's open degraded modes are an accessor, not a constant `[]` |
| **P15-R4** | Socket intake read a snapshot that does not exist | **FIXED** |
| **P15-R5** | Intake inherited the global binding when no region was named | **FIXED** (permissive) |
| **P15-R6** | Timer worker composed with no operating region | **FIXED** |
| **X2a / X2b** | `OFFERED → ACCEPTED` and outbox-withdrawal `→ QUEUED` had no deadline | **FIXED** in pass 1, verified in pass 2 |
| **P15-C1** | Evidence-binding context was half-mandatory | **FIXED** (permissive) — with an age bound |
| **P15-C2** | The authority accepted a guardrail declaration its own reader refuses | **FIXED** (permissive) |
| **P15-C3** | A gate flag its adjudicator would silently ignore | **FIXED** (latent) |
| **P15-C4** | No cutover audit event could ever be written | **FIXED** — verified 2026-08-29 by `phase15EvidenceBinding.js` D2/D3 (17/17) |
| **P15-E1** | PRODUCTION observation window that is not a window — `NaN`/`±Infinity`/future windows ADMITTED+PASS on all four B-P gates | **FIXED** (permissive, blocking) — `Number.isFinite` on both endpoints, refusal by name, and a window may not close in the future. Verified 2026-08-29 by `phase15VersionInForce.js` C1–C3 (19/19) |
| **P15-E2** | The automatic rollback's base configuration was the wrong version | **FIXED** — the version **in force**, not the latest published |
| **P15-E3** | The same `NaN` shape in `guardrails.assess()` | **FIXED** (latent, permissive) — verified 2026-08-29 (C1) |
| **P15-E4** | A caller-supplied minimum-observation bound of zero | **FIXED** (permissive) |
| **P15-E5** | The lifecycle model check claimed an exhaustion that was impossible | **FIXED** — the claim was corrected. The underlying gap is now tracked as **B-M** |
| **P15-E6** | Cutover runbook prerequisite 2 could not be discharged by the check it names | **FIXED (documentation).** The producer gap remains — residual observation 3 |
| **P15-F1** | A caller could weaken a release requirement by stating a smaller number (a 72-hour soak discharged by a 1-second window) | **FIXED** — the authority resolves the bound from the register and refuses a caller who states one, in both directions. Reproduced BEFORE the fix, re-attacked with 12 mandated attack cases and 8 distinct mutants across three concurrent sessions |
| **P15-F3** | Every malformed `--max-age-hours` refused except the one a shell produces | **FIXED** (low) |
| **P15-F7** | The only documented invocation of `authoriseEnable()` could not authorise anything | **FIXED (documentation)**, and the fix itself was then corrected for a gate-id collision divergence. Verified present 2026-08-29 at `docs/runbooks/cutover.md:220–229` |
| **A1** | `assertSelfHosted` accepted all six public hosted routing services written as a trailing-dot FQDN | **FIXED** — the most serious finding of the B1 prerequisite pass; §32.4 marks this requirement non-negotiable |
| **A2–A8** | Seven further B1-prerequisite validator defects (V-11 dropping the region under assessment; V-12 skipped silently; V-13 uncalled; a future vintage clearing every cadence; two authorities disagreeing about dates; `stepEvidenceAdmissible` true while Step 1 `NOT_CONFIGURED`; whitespace satisfying every "name the source" check) | **FIXED** — every fix moves a verdict in the strict direction only (`PASS`→`FAIL`, `ACCEPTED`→`refused`, `admissible`→`inadmissible`) |
| **R-1 / R-2 / R-3** | Residual validator defects found during the B1 pass's own final verification | **FIXED** — 5 mutants, 5 killed |

**Carried forward, unchanged, from the B1 prerequisite pass** (specification/governance, not
Phase-15-owned): **F2** (`route.matrix_timeout` / `route.path_timeout` unregistered — §22.1
governance), **F3** (the GraphHopper snap-radius asymmetry — must appear in the B1 ADR as a real
difference between candidates), **N29** (`travelTimeSpread`'s source — open for every candidate; the
engine choice does not close it).
