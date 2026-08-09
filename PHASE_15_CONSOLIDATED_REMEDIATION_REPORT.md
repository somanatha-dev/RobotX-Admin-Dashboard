# Phase 15 Consolidated Remediation Report

**Role:** Principal Engineer, closing every Phase 15 blocker that can genuinely be closed and
preparing the evidence procedure for every one that cannot.
**Date:** 2026-08-08 · **Branch:** `feature/dashboard` · **Baseline:** `cf9103f`, with Phases 6–15
present as one uncommitted working tree.
**Node:** v22.17.0 · **Machine:** the build machine; not representative production hardware.

**Authoritative inputs, read in full:** `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` (§5.2, §9.3–9.6,
§18.3, §20.1–20.5, §21.5–21.7, §22.1–22.5, §24.1–24.7, §26), `IMPLEMENTATION_EXECUTION_PLAN.md`
(§5.4, §6.1–6.2, §7, Phase 10/14/15/16 rows), `PHASE_15_INDEPENDENT_VERIFICATION.md`,
`PHASE_15_BLOCKER_RESOLUTION_PLAN.md`, `PHASE_15_IMPLEMENTATION_REPORT.md`,
`PHASE_10_COST_SCALING_IMPLEMENTATION_REPORT.md`,
`PHASE_10_COST_SCALING_INDEPENDENT_VERIFICATION.md`, `docs/runbooks/rollback.md`,
`docs/runbooks/cutover.md`.

**No commit was created. No threshold was changed. No gate was bypassed. No test was weakened.
No calibration value was invented. No solver code was touched.**

---

## Revision History

This document is the single living record for Phase 15. Later passes **append and annotate**;
they do not delete earlier evidence or rewrite earlier conclusions in place. Where a conclusion
has been refined, the previous finding, the new evidence, the corrected conclusion and the reason
for the correction are all recorded together (§21).

| Rev | Date | Pass | Sections added | Sections annotated |
|---|---|---|---|---|
| 1 | 2026-08-08 | Consolidated remediation | §1–§20 | — |
| **2** | **2026-08-09** | **Pre-B1 readiness audit** | **§21–§28** | §6, §7, §8, §13, §16, §17, §20 |
| **3** | **2026-08-09** | **D1 decision-readiness audit** | **§30–§31** | §22.2 (contract refined, §30.1), §22.3 (D2 residual sharpened, §30.5 N23), §27 C/E/F (§30.7) |
| **4** | **2026-08-09** | **D4 decision + implementation-readiness audit** | **§32–§33** | §22.5 (D4 scope sharpened, §32.1), §22.8 (D7 rider carried into the ADR text, §32.10), §30.6.2 (Step 2's contract split, §32.5) |
| **5** | **2026-08-09** | **D4 ratified (ADR-33); B1 Step 2 implemented** | **§34–§35** | §32.9 (D4 now RATIFIED, §34.1), §32.11 (its "nothing was built" table superseded for the four rows D4 released, §34.7), §33 (superseded by §35) |

**Revision 5 is the first pass in this record that changed source files, and it did so because
`docs/adr/ADR-33-b1-traversal-domain-scope.md` now exists.** D4 is ratified; its `## Consequences`
clause releases B1 Step 2 explicitly. Revision 5 implements Step 2 and nothing else: four benchmark
adapters under `tools/`, their tests, the ADR register row, and this section. **No routing engine
was installed, no map extract created, no region or polygon invented, no extract vintage or refresh
cadence chosen, no threshold or calibration value changed, no solver file touched, no test weakened,
and no engine selected.** Full change-control record in §34.8.

**Revision 4 made no repository change of any kind either.** It located D4's authoritative
definition, traced every routing-engine and engine-abstraction consumer in the tree, inventoried
all four existing routing abstractions against the frozen contract, proved that D4 carries no D1
term, and reduced the decision to one freezeable ADR sentence. **No routing engine was installed,
no adapter was written, no extract was created, no solver or calibration value was touched, and no
test was weakened.** Full change-control record in §32.11.

**Revision 4 sharpens §30.6.2 and does not retract it.** §30.6.2 records B1 Step 2 as *"not behind
D1 … behind D4 instead"*, on the basis that the adapter contract `{ id, description, matrix(),
nearestChargers() }` is *"region-agnostic by construction"*. That remains true of **the benchmark
adapter**. §32.5 shows that the repository holds **four different routing abstractions with three
mutually incompatible `route` shapes** (N25), and that the benchmark adapter covers **two of the
five capabilities** `src/engine/ARCHITECTURE.md:90` assigns to the Routing Service (N24). Step 2 is
therefore genuinely unblocked by D4 — and it delivers the *benchmark* adapter, not the production
one. The earlier statement was right about the blocker and imprecise about the deliverable.

**Revision 3 made no repository change of any kind either.** It traced D1 through every consumer,
established the exact D1 contract from the frozen architecture and the frozen execution plan,
classified every geometry-shaped artefact in the tree, and reduced the owner's decision to the
smallest legitimate question. **No region was chosen, no geometry invented, no seed promoted, no
schema altered, no solver or calibration value touched.** Full change-control record in §30.10.

**Revision 3 refines one earlier conclusion and does not delete it.** §22.2 and the three routing
documents record D1's missing input as *"a boundary as GeoJSON or a bounding box with its CRS"*,
implicitly placed in configuration as `regions[].boundary`. §30.1 shows from the frozen
architecture and the frozen execution plan that **no runtime consumer requires region geometry at
all** — geometry is required by the *extract cut*, which is an operational artefact outside the
published configuration schema. The earlier conclusion was right that the shape is unreviewed and
D1-dependent; it was imprecise about *where the geometry lives*, and that imprecision made D1 look
like a schema change when it is not one.

**Revision 2 made no repository change of any kind.** No source file, no test, no tool, no
register entry, no configuration and no generated artefact was modified. The only file written
was this one. Everything in §21–§28 is an audit finding, verified by execution against the
working tree, and every implementation it identifies is assigned to an owner rather than
performed. Full change-control record in §28.3.

**Two additional authoritative inputs were read in full for revision 2**, and are reconciled
against this document in §21: `PHASE_15_B1_ROUTING_DECISION_REPORT.md` (2026-08-08),
`PHASE_15_ROUTING_CONFIGURATION_DECISION.md` and
`PHASE_15_ROUTING_PREREQUISITE_REMEDIATION_REPORT.md` (both 2026-08-09).

---

## 1. Executive Summary

Phase 15 remains **STILL BLOCKED**, and Phase 16 remains **NOT READY**. That conclusion is
unchanged from the two prior verifications, and this remediation did not attempt to change it by
any means other than evidence.

What this pass did change is how much of the remaining work is *understood* rather than
estimated. Six things were closed or materially advanced:

1. **The solver report-precision finding is not merely corrected — its root cause is found.**
   `PHASE_10_COST_SCALING_INDEPENDENT_VERIFICATION.md` Finding 2 recorded a 4× contradiction in
   the `buildInstance`/`solve` ratio and correctly judged that a uniformly slower machine could
   not produce it. It could not. **The cause is the measurement harness.** Running both harnesses
   on one machine, back to back, reproduces both figures exactly: a standalone Node process gives
   `buildInstance` 34.8–36.9 % (the implementer's 40 %), the Jest `scale` lane gives 61.4–67.7 %
   (the verifier's 64 %). Jest inflates `buildInstance` ~4× and `solve` ~1.4×. Both prior numbers
   were right; neither was labelled. §4 records the correction and §8 of the cost-scaling report
   now carries a four-class taxonomy so a figure cannot be quoted without its class again.

2. **The Phase 16 ownership guard is hardened.** `solve/` and `lifecycle/` were whole-directory
   grants — the residual risk Finding 3 of the Phase 15 verification named, and the one that was
   most dangerous precisely while Phase 10 was re-opened inside `solve/`. Both are now
   file-by-file, with a planted-violation test proving five named Phase 16 modules are refused
   and a negative control proving the real files are still admitted.

3. **B1 routing is now measurable rather than merely open,** and its true blast radius is
   recorded. B1 blocks four things, not one: `scale_targets` (§20.3's dominant term),
   `shadow_agreement` (the composition root needs travel times), two of the 39 Safety-class
   calibration parameters, and the `charger_reachability` worker. A benchmark harness
   (`tools/routing/b1Benchmark.js`, `npm run routing:b1`) measures any candidate engine against
   §20.1's own registered routing targets **through the two shipped caches**, so the decision is
   made on architectural evidence rather than on raw query speed. It reports `NOT_MEASURED` on
   every row today, and exits 0 because no claim was made.

4. **Two new findings were discovered that neither prior document records.** Both are stated in
   full in §17: the shadow composition root is *not* independent of B1 (the blocker plan
   scheduled it as concurrent with everything), and eleven worker rows name a cadence parameter
   that is not in the parameter register — five of them belonging to workers this process claims
   it starts.

5. **The `soak` gate's evidence infrastructure now exists.** The shipped harness checks a
   *shape* on one scalar, which is correct and is not a filable record. `tools/soak/collect.js`
   assembles the eleven quantities the gate's evidence must carry, reports `NOT_COLLECTED` rather
   than absent for anything unobserved, and refuses to judge a run measured against
   `release.soak_duration` while that parameter is still `PROVISIONAL`.

6. **Every remaining blocker has an exact, executable evidence procedure** (§18), and every one
   of them requires something this repository does not contain: a deployed routing engine, an
   operating fleet, vendor documentation, an external authority's agreement, a staging
   environment, or an accountable human decision.

**Nothing was manufactured.** Of the 39 blocking Safety-class calibration parameters, **zero can
be legitimately derived from this repository** — §7 classifies all 39 individually and says why
for each. The calibration gate is still red at exactly 39. The scale gate is still red. Four
production gates are still `NOT_EVALUATED`. All 23 release gates still block with no evidence
filed.

---

## 2. Starting State

Established by direct re-execution before any file was modified.

| Item | Value |
|---|---|
| `npm run gates` (6 build gates) | **PASS**, all six |
| `gate:tiers` | 274 modules, 376 governed edges, 0 Tier 0/1 → Tier 2 |
| `gate:params` | 180 engine modules, 242 registered parameters, 0 bare constants |
| `gate:tenets` | 271 modules, 0 violations |
| `gate:privacy` | 16 modules, 0 identifying fields |
| `gate:erasure` | 3 corpus decisions, byte-identical reconstruction |
| `gate:legacy` | 4 retired modules absent, 286 files scanned |
| `npm run gate:calibration` | **FAIL — 39 blocking findings.** 242 entries: 52 DERIVED / 152 PROVISIONAL / 38 UNCALIBRATED; 54 Safety-class |
| `npm test` (baseline) | **136 suites, 6 061 tests, 0 failures, 242.8 s** |
| Release gates | 23 rows, all `blocking: true`; `blockers({})` returns all 23 |
| Shards staged | Zero |
| Phase 16 leakage | None |

The 6 061 baseline figure is 2 above the 6 059 the independent verifications recorded, and the
difference is exactly the two ownership-guard tests added by this pass (§5); the run picked them
up mid-flight. The pre-change reference remains **136 / 6 059**.

Module counts moved by one against the Phase 15 verification's figures (273→274 tiers, 270→271
tenets, 285→286 legacy) — this is `solve/costScaling.js`, the reopened Phase 10 deliverable, and
is expected.

---

## 3. Phase 10 Solver Status

**Independently verified. Verdict: PASS WITH RESERVATIONS. Treated as complete and not reopened.**

`PHASE_10_COST_SCALING_INDEPENDENT_VERIFICATION.md` established, by re-execution rather than by
reading: the algorithm is genuine Goldberg–Tarjan push-relabel with ε-scaling; the K-collapse
exactness argument reproduces independently; 129 solver tests pass; 300/300 differential
instances agree on cost and feasibility with 292/300 identical allocations; determinism and
anytime behaviour hold; production routing uses the new solver; the full backend suite passes at
136/6 059/0; `gate:tenets` and `gate:legacy` pass.

**No solver code was read for defects and none was changed by this pass.** `costScaling.js`,
`minCostFlow.js`, `objective.js`, `regime.js`, `budgets.js`, `cadence.js` and `round.js` are
byte-identical to their state at the start of this remediation. No new reproducible correctness
defect was discovered, so the standing instruction to leave the solver alone was followed.

### The five reservations, and whether each affects Phase 15 readiness

| # | Reservation | Affects readiness? |
|---|---|---|
| 1 | Algorithm choice (general push-relabel) differs from the blocker plan's suggested auction/JV | **No.** §27 of the frozen spec names "cost-scaling push-relabel" explicitly; the blocker plan is a planning document. The verifier reached the same conclusion |
| 2 | `buildInstance`/`solve` ratio contradicted the report's framing | **No — and now resolved.** §4 below identifies the cause as the harness and corrects the report. Not a solver property |
| 3 | The `solve/` ownership guard was not tightened first, as the blocker plan recommended | **Was a live risk; now closed.** §5 |
| 4 | §20.1 is not met | **Yes — but this is the `scale_targets` gate, not a solver defect.** The report and the verifier both say so. §13 |
| 5 | `scale_targets` cannot go GREEN from the solver work alone | **Yes, and this is the central fact of §13.** B1 routing is an independent, additive cause |

The 8 divergent allocations out of 300 are consistent with non-unique optima and are **not**
treated here as a correctness defect, per the standing instruction and the verifier's own
finding: no test anywhere claims allocation uniqueness, only cost and feasibility equivalence,
which is the property §9.3 turns on.

---

## 4. Report-Precision Correction

### What was wrong

`PHASE_10_COST_SCALING_IMPLEMENTATION_REPORT.md` §13 item 2 read: *"`buildInstance` is now 40 %
of the measured total (347 ms of 869 ms at 500 × 200)."* The independent verification
reproduced 64 % over two runs of `tests/scale/round.scale.test.js` (763/1347 and 727/1275 ms) and
observed, correctly, that *"a 4× discrepancy in the ratio (not just the absolute numbers) is
larger than a uniform slowdown would produce, since a uniform slowdown would preserve the ratio."*

### What the cause actually is

Not the machine. Not the solver. **The measurement harness.** Both harnesses were run on this one
machine, on the same code, against the same fixture:

| Environment | `solve` | `buildInstance` | `buildInstance` share of the two |
|---|---:|---:|---:|
| Standalone Node process, run 1 | 576 ms | 337 ms | **36.9 %** |
| Standalone Node process, run 2 | 607 ms | 324 ms | **34.8 %** |
| Jest `scale` lane, run 1 | 898 ms | 1 430 ms | **61.4 %** |
| Jest `scale` lane, run 2 | 759 ms | 1 594 ms | **67.7 %** |

Jest inflates `buildInstance` by roughly 4× and `solve` by roughly 1.4×. The asymmetry is
explicable: `buildInstance` allocates and freezes one variable record per column — 100 000 of
them — plus a canonical sort, and allocation-heavy work is far more sensitive to an instrumented
module registry, a VM context and garbage-collection pressure than the solver's tight numeric
loop over pre-sized structures.

§8 of the cost-scaling report states its protocol as *"standalone processes outside Jest"*, so its
40 % is a standalone figure and reproduces here at 34.8–36.9 %. The verification ran the Jest
suite, so its 64 % is a Jest-lane figure and reproduces here at 61.4–67.7 %. **Both were correct.
Neither was labelled.**

### What was changed

`PHASE_10_COST_SCALING_IMPLEMENTATION_REPORT.md` only, in two places:

- **§13 item 2** rewritten with the four-run table above, the mechanism, and the two conclusions
  that survive regardless of harness: the solver is no longer the sole dominant term, and
  `buildInstance` is linear in column count (exponent 1.087 standalone; 1.010 and 1.118 measured
  in the Jest lane this pass, r² 0.981 and 0.999) so its share is a constant-factor question.
- **§8 "Against §20.1"** gains an explicit four-class taxonomy distinguishing
  **implementation-author benchmark** / **independent verification benchmark** / **diagnostic
  measurement** / **formal §20.1 gate evidence**, with only the fourth able to discharge the
  gate, and a statement that the first three differ from each other by harness and machine and
  from the fourth *in kind*.

**The 250 ms threshold was not altered. No benchmark was manipulated. `scale_targets` did not
move.** No verification report was edited — the correction belongs in the implementation report
that made the claim.

---

## 5. Phase 16 Ownership Guard

**Closed.** `PHASE_15_INDEPENDENT_VERIFICATION.md` Finding 3 and
`PHASE_10_COST_SCALING_INDEPENDENT_VERIFICATION.md` Finding 3 both recorded that
`tests/engine/phase0Scaffold.test.js` granted `solve/` (and `lifecycle/`) as whole-directory
ownership prefixes, unlike the file-by-file treatment of `shard/`, `security/` and `cutover/`.
The boundary held only because the files did not exist.

### The change

| Before | After |
|---|---|
| `PHASE_10_OWNED = ["intake/", "solve/", "shard/planState.js"]` | seven named files: `solve/{budgets,cadence,costScaling,minCostFlow,objective,regime,round}.js`, plus `intake/` and `shard/planState.js` unchanged |
| `PHASE_5_OWNED = ["supervision/", "lifecycle/"]` | six named files: `lifecycle/{legMachine,taskMachine,transitions,settlement,cancellation,reassignment}.js`, plus `supervision/` unchanged |

Three tests were added and the ownership predicate was lifted out of the tree walk so the same
rule the walk applies to the real tree can be applied to a planted list:

- **the planted-violation proof** — `solve/setPartitioning.js`, `solve/branchAndBound.js`,
  `solve/localSearch.js`, `lifecycle/preemption.js` and `fairness/ladder.js` are all refused,
  with a negative control asserting `solve/costScaling.js` and `lifecycle/transitions.js` are
  still admitted, so the refusal is not a predicate that refuses everything.
- **a completeness check against the filesystem** — every `.js` file actually on disk in `solve/`
  and `lifecycle/` is asserted still owned, so converting a prefix into a list cannot lock out a
  legitimate file through an omission.
- the original tree walk, unchanged in behaviour.

`npx jest tests/engine/phase0Scaffold.test.js` → **1 suite, 56 tests, 0 failures** (54 before).

This is safety-net hardening. No Phase 16 module was added, and none exists:
`src/engine/fairness/` still holds only `.gitkeep`.

---

## 6. B1 Routing Status

**OPEN. Cannot be closed in this repository. Now measurable, and its blast radius is recorded.**

### What is actually missing

`src/engine/ARCHITECTURE.md:90` maps the §3.2 Routing Service to
`src/engine/routing/client.js`, `cellPairCache.js`, `chargerReachabilityCache.js`, and assigns it
to **Phase 8**. Two of those three exist.

**`src/engine/routing/client.js` does not exist.** With it are absent:

- §5.2's hard timeouts — 150 ms for the matrix query, 400 ms for the path query;
- §5.2's declared degradation ladder — cached matrices, then a geometric bound × detour factor,
  with the mission radius reduced to `route.degraded_max_radius` and reserves multiplied by
  `route.degraded_reserve_factor`;
- §18.3 failure B6's **uniform-treatment rule**: *"if any candidate's route is unavailable, all
  candidates in that decision use the degraded estimator"* — which exists specifically to prevent
  the baseline's partial-failure bias, where a candidate scored best purely because its data was
  missing;
- **registered parameters for those two timeouts and for the detour factor.** The register holds
  seven `route.*` entries — `cell_pair_cache_ttl`, `cell_pair_min_hit_rate`,
  `charger_reachability_k`, `charger_reachability_min_hit_rate`, `degraded_max_radius`,
  `degraded_reserve_factor`, `intra_cell_offset_m` — and **none of them is a timeout or a detour
  factor**. `gate:params` passes today only because no module implements them yet; the moment
  `client.js` is written, §22.1 requires all three registered.

The degraded *mode* is fully modelled (`degraded/modeRegister.js`, `degraded/transitions.js`,
`failure/infraFailures.js` rows B5 and B6 all name it correctly with the right parameters). What
is missing is the client that would enter it.

### Why no routing client was written by this pass

Deliberately, for four reasons:

1. It is **Phase 8 capability**, not Phase 15 remediation. Phase 15 ships no new capability.
2. Its degradation ladder needs a **detour factor**, which multiplies energy reserves under
   §18.3 — a Safety-relevant value. Writing one would be inventing a calibration value, which is
   the one thing this remediation must not do.
3. A client with no engine behind it cannot be validated, and would create the appearance of
   progress on a gate only a deployed, benchmarked engine can close.
4. B1 is a **procurement and deployment decision** (§6.1 explicitly: *"These are procurement,
   deployment, and interface decisions… None changes the architecture"*), and §20.3 item 5 makes
   the precomputation — per-profile contraction hierarchies over a region extract — the point.
   Neither can exist here.

### What was built instead: the evidence procedure, executable

`Backend/tools/routing/b1Benchmark.js` (`npm run routing:b1`), modelled on
`tools/simFidelity/validate.js`:

- Measures a candidate engine **through the two shipped caches** at §20.1's own 500 × 200
  workload in 25 cell clusters (§20.3 item 4's batching), because an engine's steady-state cost
  is a function of the cache hit rate it sustains, not of its cold query time. An engine twice as
  fast per query that cannot be precomputed is the worse choice, and only this shape shows that.
- Reports six rows: `approach_routing_matrix` (§20.1, < 20 ms), `cell_pair_hit_rate` (§20.3,
  ≥ 95 %), `charger_reachability_cached` (< 10 µs), `charger_reachability_miss` (< 2 ms),
  `charger_reachability_hit_rate` (≥ 90 %), and `cost_per_candidate`.
- **Every threshold is resolved from the register through `observability/sli.js`**, so a target
  cannot drift from §20.1 here without `sli.assertTargets()` failing first.
- `cost_per_candidate` stays `NOT_MEASURED` even on a fully successful run, because §20.1's row
  covers the whole §8 cost evaluation and reporting routing under it would attribute a budget the
  tool did not measure.
- Reports `NOT_MEASURED`, never `PASS`, for anything unmeasured; exits 0 with no engine
  **because no claim was made**, and says so in those words.
- Carries a provenance line on every report: *"This measurement can rule an engine OUT; it cannot
  rule one IN."*
- Nothing under `src/engine/` gains a dependency on it — the adapter is the only thing that talks
  to an engine, through the same injected-`route()` seam `chargerReachabilityCache.js` already
  documents as existing *"so that this module carries no dependency on the routing engine, whose
  selection is blocking decision B1."*

`tests/engine/routingB1Benchmark.test.js` — **12 tests** — proves the tool is a measurement and
not a form: the targets come from the register; the default workload is §20.1's own shape; every
row is `NOT_MEASURED` without an engine and none reads as `PASS`; the measured half genuinely
drives both caches and reports a real hit rate for each population; **a slow engine genuinely
fails** its row; and a slow return-leg population fails its own row independently of the approach
one, because §20.3 gives the second population its own budget line.

### B1's blast radius — recorded because no prior document states it in full

| Blocked | Why |
|---|---|
| `scale_targets` | §20.3 calls routing *"the dominant cost"*; the solver is one of **two** independent causes of this gate |
| `shadow_agreement` | **New finding.** See §8 — the composition root needs travel times |
| `calibration_safety_derived` | `route.degraded_max_radius` and `route.degraded_reserve_factor` are 2 of the 39, and both await a comparison against a network route |
| `charger_reachability` worker | `DEFERRED` for want of *"a routing client this process does not construct"* |

**B1 is NOT claimed closed.** The evidence that closes it is in §18.

### Update — revision 2 (2026-08-09): B1 status after the routing-prerequisite work

**Still OPEN. Nothing in this section is retracted.** Two passes have since worked the
repository-side half of B1, and the net effect is that the blocker is better specified and
*not* smaller:

- **The blocking prerequisite is one step earlier than this section states.** No engine can be
  selected, because no *extract* can be named, because no *region geometry* exists anywhere in
  the repository (§22, decision **D1**). Re-verified live this pass: `snapshot.spatial` is
  `null`, `snapshot.shards` is `null`, `bindings` is empty, and the `Region` model carries no
  boundary column at all.
- **An in-process routing cache tier now exists** — `src/engine/routing/inProcessCache.js`, 43
  tests, engine-independent, composing in front of both shipped caches without either changing.
  It is a genuine prerequisite closure and it is **not** B1 progress: §20.1's `< 10 µs` row is
  still missed by every shipped configuration including two with no network in them. §24 audits
  the contract and assigns the residual.
- **Two findings about the routing *budget* that are not about any engine** are now recorded:
  §6.4's per-candidate lower-bound filter does not exist (§23), and §20.1's per-unit budgets do
  not compose into its round budget under any stated rule (§25). Both are engine-independent,
  both can be worked before an engine exists, and neither was known when this section was
  written.
- `route.matrix_timeout`, `route.path_timeout` and the detour factor remain unregistered, and
  `src/engine/routing/client.js` remains absent. Re-verified: `src/engine/routing/` holds
  exactly `cellPairCache.js`, `chargerReachabilityCache.js` and `inProcessCache.js`.

---

## 7. Calibration Status

**RED, at exactly 39 blocking Safety-class findings — unchanged. Zero were derived by this pass,
and zero could honestly have been.**

Re-run: `npm run gate:calibration` → FAIL, 39 findings. 242 entries; 52 DERIVED / 152
PROVISIONAL / 38 UNCALIBRATED; 54 Safety-class.

### Classification of all 39

Classes are the brief's: **A** derivable now · **B** requires measurement · **C** requires shadow ·
**D** requires production evidence · **E** requires an accountable/architectural decision ·
**F** retired/replaced, must **not** be re-derived.

**Class A is empty.** Not one of the 39 can be derived from anything inside this repository. The
blocker plan's "Group A — derivable immediately" (13 entries) assumed a named calibration owner
with access to safety analyses, vendor datasheets and external authorities; from the repository's
standpoint every one of those is class **E** or a measurement of an artefact that does not exist
here.

| # | Parameter | Status | Class | What it actually requires |
|---|---|---|---|---|
| 1 | `agent.autonomous_continuation_limit` | PROVISIONAL | **E** | Per-class on-agent safety analysis, signed |
| 2 | `connectivity.max_deadzone_extension` | PROVISIONAL | **B** | Per-zone p95 dead-zone traversal times from fleet telemetry |
| 3 | `connectivity.max_heartbeat_age` | PROVISIONAL | **B** | Heartbeat inter-arrival distribution per radio class |
| 4 | `degraded.max_duration` | PROVISIONAL | **E** | A Safety decision per degraded mode |
| 5 | `degraded.max_last_known_age` | PROVISIONAL | **E** (+B) | Staleness tolerance decision, informed by #3's telemetry cadence |
| 6 | `degraded.max_mission_scope` | PROVISIONAL | **E** | An operations decision on scopes admissible under degraded observability |
| 7 | `degraded.reserve_factor` | PROVISIONAL | **B** | Observed consumption error during a real telemetry degradation; inducible in staging chaos |
| 8 | `energy.charger_availability_margin` | PROVISIONAL | **E** | Blocked on **B2** (Charging Scheduler must exist and publish) |
| 9 | `energy.charger_projection_max_age` | PROVISIONAL | **E** | Blocked on **B2** — the entry names B2 itself |
| 10 | `energy.deviation_tolerance` | PROVISIONAL | **D** | §14.2 consumption-model residuals per class; needs #15 first |
| 11 | `energy.event_budget_per_fleet_year` | PROVISIONAL | **E** | Ops/finance/safety sign-off — **B8**. Every `α[tier]` derives from it |
| 12 | `energy.f_derate` | UNCALIBRATED | **B** | Vendor capacity curve validated against measured pack behaviour |
| 13 | `energy.kappa_bounds` | PROVISIONAL | **B** | Realised κ distribution across a commissioned fleet |
| 14 | `energy.max_combined_conservatism` | PROVISIONAL | **E** | An explicit Safety decision on total intended energy margin |
| 15 | `energy.model_residual_cv` | UNCALIBRATED (`null`) | **D** | Fitted residual variance vs realised Wh. `energy_calibration` worker is DEFERRED. **Highest fabrication risk in the register** — its own description says a fabricated dispersion would produce three fabricated probabilities and F34 would admit or reject on them |
| 16 | `energy.reserve_floor_wh` | UNCALIBRATED (`null`) | **B** | Per-class pack specification + controlled-shutdown energy (vendor) |
| 17 | `energy.uncalibrated_reserve_factor` | PROVISIONAL | **B** | Per-agent κ calibration coverage; needs #13 |
| 18 | `feasibility.systemic_indeterminacy_threshold` | PROVISIONAL | **C** | Observed INDETERMINATE rates per predicate — produced by shadow, not production |
| 19 | `health.required_tier` | UNCALIBRATED (`null`) | **E** | An operations decision per SLA class. Unset means F9 is INDETERMINATE and denies |
| 20 | `lease.duration` | PROVISIONAL | **B** | Measured evidence cadence per class |
| 21 | `legacy.dtaro.battery_threshold_pct` | UNCALIBRATED | **F** | **Retirement.** `retiredInPhase: 15`, `consumers: []`. Its own description: *"A percentage floor cannot express a tail requirement and is replaced, not re-tuned"* |
| 22 | `legacy.dtaro.charging_interrupt_battery_pct` | UNCALIBRATED | **F** | **Retirement**, after repointing its one consumer, `src/simulation/constants.js` |
| 23 | `localisation.max_odometry_divergence` | PROVISIONAL | **B** | Per-class odometry drift measurements (bench) |
| 24 | `localisation.min_confidence` | UNCALIBRATED (`null`) | **B** | Per-environment localisation accuracy measurements (field trials) |
| 25 | `map.obstruction_class_max_age` | PROVISIONAL | **E** | Blocked on **B6** — the region's map hazard-data publication cadence |
| 26 | `ops.emergency_services_hazard_threshold` | UNCALIBRATED (`null`) | **E** | A safety decision with local emergency services and the site authority. **Long lead** |
| 27 | `ops.external_escalation_contacts` | UNCALIBRATED (`null`) | **E** | The responsible infrastructure operator per region, with a named owner and last-review instant. **Long lead** |
| 28 | `ops.stranded_obstructing_response_target` | PROVISIONAL | **E** | A safety decision with the local highway or site authority. **Long lead** |
| 29 | `payload.mass_discrepancy_tolerance_kg` | PROVISIONAL | **B** | On-board scale accuracy per container model (vendor/bench) |
| 30 | `payload.safety_factor` | PROVISIONAL | **B** | Per-class rated-mass certification (vendor) |
| 31 | `route.degraded_max_radius` | UNCALIBRATED (`null`) | **E** | Blocked on **B1** — needs an engine to compare a straight line against |
| 32 | `route.degraded_reserve_factor` | PROVISIONAL | **E** | Blocked on **B1** — degraded-estimate error distribution |
| 33 | `security.attestation_max_age` | PROVISIONAL | **B** | Firmware/hardware change cadence per agent class, from ops records |
| 34 | `security.certificate_revocation_recheck_interval` | PROVISIONAL | **B** | The operated CA's revocation-publication latency |
| 35 | `security.energy_rate_tolerance` | PROVISIONAL | **D** | §14.2 residuals vs reported SoC; needs #15 |
| 36 | `security.implausible_report_quarantine_threshold` | PROVISIONAL | **C** | Background rate of refused reports on healthy agents — `trustBoundaries` observation |
| 37 | `security.position_plausibility_tolerance` | PROVISIONAL | **B** | Distribution of implied speed between accepted fixes, per class |
| 38 | `shard.store_round_trip_budget` | PROVISIONAL | **E** | Blocked on **B3** — p99 RTT to the *operated* consensus store |
| 39 | `sim.max_optimistic_bias` | PROVISIONAL | **E** | A Safety tolerance decision. **Circular as registered** — see below |

| Class | Count |
|---|---|
| **A** — derivable now, in this repository | **0** |
| **B** — requires measurement of an existing fleet, bench, vendor document or CA | **15** |
| **C** — requires shadow observation | **2** |
| **D** — requires production/fleet-operation evidence | **3** |
| **E** — requires an accountable or architectural decision | **17** |
| **F** — retirement, must not be re-derived | **2** |
| **Total** | **39** |

Seven are blocked behind unresolved §6.1 decisions: **B1** (#31, #32), **B2** (#8, #9), **B3**
(#38), **B6** (#25), and **B8** (#11, which governs the register as a whole).

### The two structural problems, re-verified as still present

**(a) `sim.max_optimistic_bias` is circular.** Confirmed from the live register: its `awaits`
reads *"the first one-sided simulator fidelity study against production"*, and
`cutover/gates.js`'s `simulator_fidelity` statement is *"no safety-relevant model exceeds
`sim.max_optimistic_bias`"*. A tolerance cannot be an output of the study it bounds. §24.4 is
unambiguous that the parameter is a Safety **decision** — how much optimism Safety will accept
before refusing to let the simulator discharge a Tier 0 obligation.

**This was not corrected by this pass, deliberately.** It is a SAFETY-class register change
requiring two-person approval under §22.3 and an entry in the hash-chained audit stream. Editing
`awaits` unilaterally would be exactly the quiet edit §22.4 warns against.

**(b) Two entries need retirement, not derivation.** Both confirmed intact:
`legacy.dtaro.battery_threshold_pct` has `retiredInPhase: 15`, `consumers: []`;
`legacy.dtaro.charging_interrupt_battery_pct` has one consumer, `src/simulation/constants.js` —
the simulator, not the decision path.

### What was implemented: guards against the wrong closure

`tools/gates/checkCalibration.js` is strong in the direction it was built for — it blocks a
Safety-class entry that is not `DERIVED`, **and** one that claims `DERIVED` without stating a
derivation. What it cannot check is whether a stated derivation is the *right kind*.

`tests/engine/calibrationDisposition.test.js` — **8 tests** — closes that, without asserting that
any entry is still open (so none needs updating on the day it is closed *correctly*, and all fail
on the day it is closed *incorrectly*):

- the two `legacy.dtaro.*` entries retain `retiredInPhase: 15`, a `replacedBy`, and an `awaits`
  naming replacement;
- **if either is ever marked `DERIVED`, its derivation must name the replacement and say
  retire/replace** — it may not be closed by deriving the percentage the architecture has already
  rejected as unable to express the requirement;
- the only remaining consumer of either is under `src/simulation/`, never the decision path;
- the `sim.max_optimistic_bias` circularity is asserted as a fact about the register and the gate
  together; and **if it is ever marked `DERIVED`, its derivation may not cite the fidelity
  study** — which would be the circle closed rather than broken, and would pass
  `checkCalibration.js`, since that gate only checks a derivation exists.

**No status, value, `awaits` field or derivation was changed. The gate is red at 39 and this
report does not assert the count downward anywhere.**

### Update — revision 2 (2026-08-09): re-verified, and grouped by what blocks it

`npm run gate:calibration` re-run on the current working tree: **FAIL — 39 blocking findings.
242 entries; 52 DERIVED / 152 PROVISIONAL / 38 UNCALIBRATED; 54 Safety-class.** Byte-for-byte
the same figures. **Nothing was derived, edited, reclassified, or added, and no register file was
touched.** `sim.max_optimistic_bias` was specifically not touched; no detour or reserve factor
was invented.

The 39-row classification above is by *what the entry needs*. §26 adds the orthogonal view the
dependency plan needs — **what each is blocked behind, at the earliest** — so the ones that move
when B1 moves can be separated from the ones that never depended on it. The headline of that
regrouping: **only 2 of the 39 are behind B1**, and **37 are not**, which is why §27 puts B8 and
B1 on the same day by different people rather than in sequence.

---

## 8. Shadow Status

**`shadow_agreement`: NOT_EVALUATED. Correctly so. The worker remains `DEFERRED`.**

### The new finding: the composition root is not independent of B1

`PHASE_15_BLOCKER_RESOLUTION_PLAN.md` finding N4 identified the shadow composition root as the
unscheduled critical-path item and placed it in Track C as *"concurrent with everything"*. **It
is not.**

`workers/registry.js` names the five missing collaborators: `round`, `expandCandidates`,
`pricedCandidateFor`, `budgetsFor`, `deferPriceFor`. Reading `candidates/expansion.js`'s own
contract, `expandCandidates` requires an injected `evaluateExact(agentId, leg, snapshot)` that
returns feasibility and `gammaMilliCU`. That evaluation needs travel times for both §20.3
populations. **Travel times need a routing engine. That is B1.**

Two consequences neither prior document records:

1. **The shadow composition root cannot be completed before B1 is resolved**, so the 14-day
   window — the longest irreducible wall-clock item in the whole programme — sits *behind* the
   longest-lead-time procurement decision, not beside it.
2. `workers/coordinator.worker.js` takes the same five collaborators as injected `deps`. **The
   composition root is missing for the production round loop too**, not only for shadow. Nothing
   in this repository constructs a real solve path outside a test fixture.

Building a stub `evaluateExact` would produce precisely what `registry.js`'s own header names as
the worst of the three possible states: *"a worker that runs, reports success, and computes
nothing."* No stub was written.

### What was verified, and what was added

`tests/engine/workerRegistry.test.js` — **13 tests**:

- **Registration** — the registry loads; every row carries its four mandatory fields; every
  `DEFERRED` row names a blocker and no other row does; the three dispositions partition the
  registry with nothing unaccounted for.
- **Disabled by default** — `server.js` does not reference `shadow.worker`; `shadow` is in
  neither `scheduledAtBoot()` nor `scheduledOnLeadership()`.
- **Observation isolation** — `shadow.assertNoEffects()` is asserted to throw for **each**
  forbidden dependency individually (so shortening the list is a visible change), with a negative
  control proving a legitimate bundle is accepted.
- **Error handling and lifecycle** — `start()` returns a working stop handle; a pass that throws
  is delivered to `onError` and **not** rethrown; after `stop()` no further pass runs.
- **Duplicate prevention** — asserted as the honest shape rather than a guarantee the code does
  not make: `start()` returns one handle per call and stopping one does not stop the other, so a
  future composition root knows it owns the singleton decision.
- **Input pinning** — a round whose `InputSnapshot` is gone is refused with `NO_SNAPSHOT` rather
  than compared against current state (§9.6 requirement 5), which is what prevents a
  plausible-looking agreement report computed over two different worlds.
- **A pass over no stored rounds** is a clean no-op with `executed: false`.

### Second new finding: eleven worker cadence parameters are not in the register

`assertRegistry()` checks that `cadenceParameter` is a non-empty string. It is not checked
against the parameter register, and **eleven of the nineteen rows name a key the register does
not hold**:

`feasibility.rejection_flush_interval`, `energy.calibration_interval`, `index.sweep_interval`,
`observability.calibration_score_interval`, `observability.counterfactual_interval`,
`observability.shadow_interval`, `plan.service_time_refit_interval`, `pricing.refresh_interval`,
`reconciler.sweep_interval`, `route.charger_cache_refresh`, `supervision.timer_tick`.

**Five belong to workers this process claims it starts** — `reconciler` and `timer`
(`LEADER_ONLY`), `rejection_aggregation`, `calibration` and `counterfactual` (`SCHEDULED`). That
is a live gap in Phase 15's own checklist item *"All engine workers move from shadow to
production scheduling"*: a scheduler needs an interval, and §22.1 admits no bare behavioural
constant for one.

It is **inert today** — verified mechanically: no worker resolves its `cadenceParameter` through
the config service; each uses a local `@structural` constant, which is admissible only because
nothing schedules it. The test asserts that too, so the finding is a precondition of scheduling
rather than a live defect, and it pins the list in both directions so it can neither grow
silently nor be struck off without the registration.

**No cadence value was invented and no register entry was added.**

### Correction — revision 2 (2026-08-09): the denominator is 18, not 19

**Previous finding (this section):** *"eleven of the **nineteen** rows name a key the register
does not hold."*

**New evidence:** `require("./src/workers/registry").WORKERS.length` returns **18** —
8 `SCHEDULED`, 4 `LEADER_ONLY`, 6 `DEFERRED`, which partition the registry exactly.

**Corrected conclusion:** **eleven of the eighteen rows.** The substantive finding is unchanged
and reproduced exactly: the same eleven keys are absent from the register
(`reconciler.sweep_interval`, `supervision.timer_tick`,
`feasibility.rejection_flush_interval`, `observability.calibration_score_interval`,
`observability.counterfactual_interval`, `observability.shadow_interval`,
`index.sweep_interval`, `pricing.refresh_interval`, `route.charger_cache_refresh`,
`energy.calibration_interval`, `plan.service_time_refit_interval`), and **five of them belong to
workers this process schedules** — `rejection_aggregation`, `calibration` and `counterfactual`
(`SCHEDULED`, started by `startScheduledWorkers` in `server.js`) plus `reconciler` and `timer`
(`LEADER_ONLY`, started on leadership).

**Reason for the correction:** an arithmetic slip in the row count. It changes nothing
downstream; it is recorded rather than silently fixed because a count in this document is
evidence, and evidence that was quietly adjusted is not evidence.

**N11 re-confirmed independently**, from the registry itself rather than from this document:
the `shadow` row's `blockedBy` reads *"needs a constructed solve path (round, expandCandidates,
pricedCandidateFor, budgetsFor, deferPriceFor)"* — and §26 traces every one of those five to a
routing engine. §26 also records which worker dependencies are genuinely critical-path and
which are not.

---

## 9. Simulator Fidelity Status

**NOT_EVALUATED. Correctly so.**

`npm run sim:fidelity` re-run: all seven models report `NOT_MEASURED`, six of them
safety-relevant, with the tool's own conclusion — *"one or more safety-relevant models are
unmeasured or unvalidatable, so the simulator MAY NOT discharge a Tier 0 verification obligation
(§24.4, §1.8)"*.

The repository-side tooling is **complete and correct**. `tools/simFidelity/validate.js` reads
realised and simulated distributions in the shape `observability/calibration.js` produces, is
one-sided with the optimism direction declared per model rather than assumed, refuses to average
a bias across slices (it fails on the worst slice and names it), and distinguishes
`UNVALIDATABLE` from `NOT_MEASURED` from `PASS`. No repository-side infrastructure is missing
from the *comparison* half.

Three things are missing from the *evidence* half, and none can be produced here:

1. **The fleet demand generator** with controllable burstiness and spatial correlation
   (§18.2/§18.3/§18.5, checklist item 5) — correctly reported PARTIAL by Phase 15. The injection
   surfaces (`failure/agentFailures.js`, `infraFailures.js`, `degraded/modeRegister.js`) and the
   `VirtualRobot`/`SimulationEngine` substrate exist; the generator does not. Without it the
   study can only cover replayed historical demand, which cannot exercise the §18 catalogue the
   study exists to validate the simulator *for*.
2. **Realised production data** per model, per slice (zone × agent class × time bucket).
3. **`sim.max_optimistic_bias` re-derived as a decision** — §7(a).

**No fleet trace was fabricated.** The gate stays `NOT_EVALUATED`.

---

## 10. Soak Status

**NOT_EVALUATED. No soak was run and none is claimed. The evidence infrastructure now exists.**

### The gap that was closed

`tests/scale/helpers/scaleHarness.js`'s `soak()` samples **one scalar** in windows and reports
whether the last exceeds the first. That is the right check for §24.6's four shapes — leaks,
unbounded caches, timer accumulation, queue drift — and its header is right that it is a shape
rather than a duration. It is not a filable soak record.

The quantities such a record must carry are spread across five places that nothing assembles:
`observability/sli.js` (latency, p99/p99.9, throughput), `observability/invariantChecker.js`
(violations), `cutover/guardrails.js` (rollback signal), the process (CPU, memory), and the scale
harness (drift shapes).

### What was built

`Backend/tools/soak/collect.js` — the assembly, and nothing more. It collects all eleven
quantities the brief and the gate name: duration, workload, throughput, latency, **latency tail
(both §20.1 p99.9 rows specifically)**, CPU, memory, errors, invariant violations, rollback
signals, and unbounded growth per named series.

Three refusals, each mirroring an existing repository idiom:

1. **It never invents a sample.** Anything unobserved is `NOT_COLLECTED`, and `assess()` returns
   `INCOMPLETE` — an unobserved field is not a field that was fine. An unhealthy invariant checker
   (`checkerHealthy: false`) is `INCOMPLETE` for the same reason: *"we did not look"* is not
   *"nothing was wrong"*.
2. **It never decides a run was long enough.** `release.soak_duration` is **PROVISIONAL** and
   awaits *"the observed time constant of the slowest accumulating resource"*. A record measured
   against it returns `DURATION_TARGET_NOT_DERIVED` — verified live, the parameter is still
   `PROVISIONAL`, so that is the branch a real run hits today.
3. **It never produces a GREEN `soak` verdict.** It produces the record; filing it is a human act
   with a named operator.

`drift()` is deliberately the identical definition `scaleHarness.soak()` uses, so two soak
artefacts from different runners stay comparable.

`tests/engine/soakEvidence.test.js` — **13 tests** — exercises both directions: a complete clean
run reports all eleven `COLLECTED` and passes; and all four failing branches genuinely fail — an
unbounded timer table is `DRIFTED` (naming the series and the percentage), an invariant violation
is `VIOLATED` (naming the invariant and §26.1's zero target), a guardrail signal during the run is
`VIOLATED`, and latency missing a §20.1 target throughout is `VIOLATED`.

**What is still required** is a staging environment carrying production-shaped load, a derived
`release.soak_duration`, and the solver that will actually ship. §18.

---

## 11. Production Invariant Status

**`invariants_enforced`: NOT_EVALUATED. Correctly so, and irreducibly so.**

The mechanism is complete. `observability/invariantChecker.js` holds all 22 checks with
`assertEveryInvariantIsChecked()` guaranteeing register and checker agree;
`summarise()` returns per-status counts, the total violation count (§21.4's metric, target exactly
zero), the violated and suspended invariant lists with their authorising mode, and — the field
that matters most — `checkerHealthy`, which preserves the distinction between *"nothing is
wrong"* and *"we did not look."* `workers/invariant.worker.js` runs them independently of the code
paths that maintain them and emits `INVARIANT_STATUS_CHANGED`. `observability/sli.js` provides
the histogram registry, cross-process merge, and an `attainment()` that returns `meets: null` for
an unobserved target — never a false pass.

Evidence capture for all nine quantities the brief names — safety predicates, invariant
enforcement, gate state, shard state, assignment outcomes, rollback triggers, violations,
timestamps, provenance — is reachable through those modules plus `cutover/gates.evaluate()`,
`cutover/store.js`'s audit-stream reads, and the Tier A/Tier B decision record. The new soak
collector (§10) assembles the subset a long run needs.

**What cannot be produced here is the observation itself.** This gate requires a live, deciding
shard, and it is downstream of every other gate. It is Phase 15's completion criterion E2 and by
construction cannot be evaluated before a cutover.

**One definitional gap remains open and is restated here because it is easy to lose:** nothing in
the repository states how long *"ENFORCED in nominal operation"* must be observed for.
`cutover.observation_window` (3 600 s, PROVISIONAL) governs the per-shard staging hold, not the
invariant-enforcement evidence window. Until that window is registered and derived, E2 is
discharged by whoever decides they have watched long enough. **This must be closed before the
cutover, not during it.**

---

## 12. Rollback Status

**`rollback_rehearsed`: NOT_EVALUATED. No rehearsal was performed and none is claimed.**

### Runbook / implementation consistency — checked, and consistent

`docs/runbooks/rollback.md` §5's six steps were read against the code:

| Runbook claim | Implementation | Consistent? |
|---|---|---|
| `rollback_rehearsed` is blocking and ORGANISATIONAL; no build can close it | `gates.js` — the row is `blocking: true`, `EVIDENCE.ORGANISATIONAL` | **Yes** |
| An automatic rollback must be triggered by the controller, not by calling the API | `cutover.worker.js`'s `assessShard()` is the only automatic caller of `stage.authoriseRollback()` | **Yes** |
| Only `DISABLE` may be automatic | `guardrails.AUTOMATIC_ACTIONS` is a frozen one-element array; `assertOneDirectional()` throws on anything else; `authoriseEnable()` separately refuses `automated: true` | **Yes — three independent enforcement points** |
| Rollback needs no gate, only a reason | `authoriseRollback()`'s only refusal is a missing reason | **Yes** |
| Setting `ENGINE_ENABLED=false` is **not** a rollback (§6) | `enabled.forShard()` is a conjunction of process and config; clearing the process half stops every shard | **Yes** |

Re-verified live: `gates.RELEASE_GATES` is 23 rows, all blocking; `gates.evaluate({})` returns
`ok: false`; `gates.blockers({})` returns all 23. There is no state of this repository in which a
shard can be enabled.

### Why the rehearsal cannot be run here

`rollback.md` §5 step 1 requires taking a **staging** shard live through the full §3 of
`cutover.md`. That needs, none of which this environment has: a staging environment with a
working config-publish path; two distinct human approvers (refusal #3 refuses `automated: true`
and a missing second approver); a pre-Phase-15 build artefact retained and deployable for step 4;
`cutover.worker.js` scheduled against the staging shard; and release evidence sufficient for
refusal #1.

The last of those is the one real obstacle, and the honest handling of it is unchanged from the
blocker plan §12.6: run the rehearsal against **staging-scoped release evidence, labelled as
such in the rehearsal record and never filed against the production gate table** — the gate object
already carries `source` and `observedAt` for exactly this. Adding a "rehearsal mode" bypass to
`authoriseEnable()` would put a route around refusal #1 into the code, which is the one control
the design has no waiver for. **No such bypass was added.**

**The runbook's own warning is repeated here because it is the single most likely failure:**
*"Step 4 is the one that will be skipped and it is the one that matters."* A rehearsal record
without rollback B performed end to end does not discharge the gate.

---

## 13. Scale-Target Status

**RED. `scale_targets` is not discharged and cannot be discharged from this repository.**

**Nothing about the gate was changed.** The 250 ms target is untouched; `perf.round_wall_clock_p99`
is STRUCTURAL and DERIVED; the candidate count is untouched; no p99 became a p50; no exponent
bound was widened; no budget was increased; no run was cherry-picked. `npm run test:scale` →
3 suites, 23 tests, 0 failures.

### The honest decomposition, measured

At §20.1's own shape — 500 Legs × 200 candidates, 100 000 columns — standalone Node, median of 5
after one warm-up, two independent runs:

| Stage | Run 1 | Run 2 | Share of measured |
|---|---:|---:|---:|
| `objective.buildInstance` | 337 ms | 324 ms | 34.8–36.9 % |
| `minCostFlow.solve` | 576 ms | 607 ms | 63.1–65.2 % |
| `objective.validate` | < 1 ms | < 1 ms | ~0 % |
| **Measured subtotal** | **913 ms** | **931 ms** | **3.7× the whole-round target** |

Solver correctness at that shape confirmed in the same run: `optimalityCertified: true`, all 500
Legs assigned, solver `COST_SCALING`.

The Jest `scale` lane on the same machine measures 759–898 ms solve and 1 430–1 594 ms
`buildInstance` — the harness difference of §4.

### What is **not** in that 913 ms, and why the true gap is unknown rather than 3.7×

§20.1's target is the **whole round**, and §20.2 budgets stages this measurement does not touch:

| Stage | Why it is absent | Bounded by |
|---|---|---|
| Candidate generation (§6.3) | Needs an availability index and agent snapshots | `perf.candidate_generation_per_leg_p99` < 5 ms **per Leg** |
| Feasibility (§7) | Needs agent state | < 50 µs per candidate, ×100 000 |
| **Routing — approach (§20.3)** | **Needs a routing engine: B1** | < 20 ms per cached 200×1 matrix |
| **Routing — return leg (§20.3)** | **Needs a routing engine: B1** | < 10 µs cached / < 2 ms on miss, ×`m·k` |
| Plan pricing / column building (§8, §13) | Needs the cost clients | O(q·s) |
| Commit (§10.3) | Needs the database | < 20 ms p99, < 100 ms p99.9 |

**§20.3 states plainly that routing is the dominant term**, and it is entirely absent from every
measurement anyone has taken. The measured 3.7× is therefore a **lower bound on the gap, not the
gap**, and it is a lower bound taken at p50 in one process on a build machine, against a target
stated at p99 per shard on representative hardware under nominal operation.

### The two independent causes, restated

1. **Solver algorithm class** — addressed by the reopened Phase 10 work, ~30–60× improvement,
   independently verified, and **not sufficient alone**.
2. **B1 routing** — untouched, unmeasured, and the term §20.3 calls dominant.

`scale_targets` cannot go GREEN until both are resolved and a whole-round p99 is measured on
representative hardware. **No further solver optimisation should be scoped until routing has a
number**, because scoping the second-largest term while the largest is unmeasured is how a
programme optimises the wrong half.

### Update — revision 2 (2026-08-09): the gap is still a lower bound, and there is now a third cause

**RED, unchanged. The 250 ms target, the p99 statistic, the 500 × 200 shape and every registered
threshold are exactly as found.** Nothing in this section is retracted, and the two independent
causes it names both stand. Three things sharpen it:

1. **The routing cache path was measured, twice, and it is not small.** Driving the shipped
   caches at §20.1's own 500 × 200 / 25-cluster shape with a **zero-latency** stand-in costs
   241–246 ms on one machine session and 381–387 ms on another — 96–155 % of the whole-round
   budget *before any engine exists*. Through the shipped Redis kv it is 18.8–20.9 s; with the
   new in-process tier, 1.46 s. All diagnostic measurements, all engine-free.
2. **A third, independent cause is now identified, and it is neither the solver nor the
   engine: the routing read *count*.** §23 establishes that §6.4's per-candidate lower-bound
   filter does not exist, so every agent the expansion enumerates receives a full exact
   evaluation — up to `candidate.max_evaluated` (200) per Leg, 100 000 per round, and about
   200 000 per-candidate routing reads across §20.3's two populations. At the measured
   in-process floor of 0.9 µs per read that is ~180 ms of a 250 ms round for *lookups alone*,
   with no engine, no solver and no commit in it. **A faster tier cannot fix a read count.**
3. **The target this gate is measured against is not yet arithmetically defined.** §25 shows
   that §20.1's per-unit budgets, taken as per-round aggregates at §9.4's own caps, exceed the
   250 ms round budget by 2×–40× on **five separate rows** — candidate generation, feasibility,
   cost per candidate, both routing populations — and that `solve.time_budget` (250 ms, §9.4)
   equals `perf.round_wall_clock_p99` (250 ms, §20.1) exactly. The frozen architecture states no
   aggregation rule and no intra-round concurrency model, so this is an open architecture
   question (**Q-20.1**), not an engineering one, and it must be answered before a benchmark can
   gate on anything.

**The measured 913–931 ms therefore remains a lower bound on the gap, not the gap**, and the
number it will eventually be compared against is not yet defined. Neither fact moves the gate,
and neither was used to move it.

---

## 14. Safety-Case Status

**GREEN, and re-verified after every change in this pass.**

`npm run safety:case` re-run after all edits: 12 hazards assembled from 38 predicates and 22
invariants; **PASS — every reference resolves**; release gates reported as 0 green, 0 red, 23 not
evaluated (correct: no evidence is filed).

**Deterministic generation confirmed by re-execution**, not asserted: two consecutive
regenerations produce the identical MD5 (`e2a3abcd163622501c96d3646c5109f2`).

- No dangling predicates — the assembler queries `feasibilityRegister.predicate()` live.
- No dangling invariants — it checks `invariantChecker.CHECKS` live.
- No unmitigated hazards — a hazard with neither a mitigating constraint nor a monitoring
  invariant is a reported problem, and the three planted-failure tests covering all three
  conditions pass in the engine lane.
- Gate classifications are current: 23 not evaluated is the correct rendering of a repository
  with no evidence filed.

**The generated document was not manually edited.**

---

## 15. Full Regression Results

All figures from this reviewer's own runs on the final working tree.

| Suite / gate | Result |
|---|---|
| `npm run gate:tiers` | **PASS** — 274 modules, 376 governed edges, 0 violations |
| `npm run gate:params` | **PASS** — 180 engine modules, 242 parameters, 0 bare constants |
| `npm run gate:tenets` | **PASS** — 271 modules, 0 violations |
| `npm run gate:privacy` | **PASS** — 16 modules, 0 identifying fields |
| `npm run gate:erasure` | **PASS** — 3 corpus decisions, byte-identical |
| `npm run gate:legacy` | **PASS** — 4 retired modules absent, 287 files scanned |
| `npm run gate:calibration` | **FAIL — 39 blocking findings** (correct and unchanged) |
| `npm run test:chaos` | **PASS** — 3 suites, 44 tests |
| `npm run test:scale` | **PASS** — 3 suites, 23 tests |
| `npm run test:gates` | **PASS** — 6 suites, 84 tests |
| `npm run safety:case` | **PASS** — every reference resolves; byte-identical regeneration |
| `npm run sim:fidelity` | 7 models `NOT_MEASURED` (correct — no study supplied) |
| `npm run routing:b1` | 6 rows `NOT_MEASURED` (correct — no engine supplied) |
| `npm test` (all 5 lanes) | **PASS — 140 suites, 6 107 tests, 0 failures, 309.8 s** |
| `npm run release:gates` | **Exit 1** at `gate:calibration`, as designed |

### The regression arithmetic reconciles exactly

| | Suites | Tests |
|---|---:|---:|
| Baseline (independent verifications, pre-change) | 136 | 6 059 |
| `phase0Scaffold.test.js` — ownership-guard hardening | — | +2 |
| `routingB1Benchmark.test.js` — new | +1 | +12 |
| `workerRegistry.test.js` — new | +1 | +13 |
| `calibrationDisposition.test.js` — new | +1 | +8 |
| `soakEvidence.test.js` — new | +1 | +13 |
| **Final, measured** | **140** | **6 107** |

Every one of the 48 added tests is accounted for, and the delta is entirely additive: **no
pre-existing test changed, and 6 059 of the 6 107 are the same assertions the independent
verifications ran.**

**Per-file, for the files this pass touched or added:**

| Suite | Tests | Before |
|---|---|---|
| `tests/engine/phase0Scaffold.test.js` | 56 | 54 |
| `tests/engine/routingB1Benchmark.test.js` | 12 | new |
| `tests/engine/workerRegistry.test.js` | 13 | new |
| `tests/engine/calibrationDisposition.test.js` | 8 | new |
| `tests/engine/soakEvidence.test.js` | 13 | new |

**No test was weakened, skipped, deleted, or had a threshold relaxed.** Every added test is an
additional assertion, and four of the five new suites contain a deliberately-failing branch
exercised to prove the check can fail.

### Change control — the complete list of files this pass touched

Isolated by modification time against the moment this pass's first edit landed, which also
separates it cleanly from the preceding Phase 10 cost-scaling workstream (whose last file was
written 9 minutes earlier).

| File | Change | Kind |
|---|---|---|
| `Backend/tests/engine/phase0Scaffold.test.js` | `solve/` and `lifecycle/` to file-by-file ownership; +3 tests, predicate lifted out of the walk | Modified |
| `Backend/tools/routing/b1Benchmark.js` | B1 routing-engine benchmark | **New** |
| `Backend/tests/engine/routingB1Benchmark.test.js` | 12 tests for the above | **New** |
| `Backend/tools/soak/collect.js` | `soak` gate evidence collector | **New** |
| `Backend/tests/engine/soakEvidence.test.js` | 13 tests for the above | **New** |
| `Backend/tests/engine/workerRegistry.test.js` | 13 tests: registry discipline, cadence finding, shadow lifecycle | **New** |
| `Backend/tests/engine/calibrationDisposition.test.js` | 8 tests: retirement and circularity guards | **New** |
| `Backend/package.json` | one line: `"routing:b1"` | Modified |
| `PHASE_10_COST_SCALING_IMPLEMENTATION_REPORT.md` | §8 taxonomy, §13 item 2 rewritten | Modified |
| `docs/safety-case/SAFETY_CASE.md` | Regenerated; **byte-identical** (MD5 unchanged) | Regenerated |
| `PHASE_15_CONSOLIDATED_REMEDIATION_REPORT.md` | This document | **New** |

**Zero files under `Backend/src/` were modified — verified mechanically, not asserted.** The
entire production source tree, including all seven `solve/` modules, is byte-identical to its
state at the start of this pass.

Checked and confirmed: only intended files changed; no threshold was modified; no gate was
bypassed or given a waiver; no test was weakened; no unrelated source was changed; no generated
artefact was hand-edited; no register value, status, `awaits` field or derivation was altered;
and **no commit was created**.

---

## 16. Complete Phase 15 Readiness Matrix

| Gate | Status | Evidence | Remaining Requirement |
|---|---|---|---|
| `tier_dependencies` | **GREEN** | `gate:tiers` re-run: 274/376/0 | Re-run each build |
| `parameter_register` | **GREEN** | `gate:params` re-run: 180/242/0 | Re-run each build |
| `design_tenets` | **GREEN** | `gate:tenets` re-run: 271/0 | Re-run each build |
| `identity_isolation` | **GREEN** | `gate:privacy` re-run: 16/0 | Re-run each build |
| `erasure_reconstruction_equivalence` | **GREEN** | `gate:erasure` re-run: 3 corpus, byte-identical | Re-run each build |
| `legacy_removed_from_build` | **GREEN** | `gate:legacy` re-run: 4 absent, 287 files | Re-run each build |
| `lower_bound_admissibility` | **GREEN** | Engine lane passes | Re-run each build |
| `model_check_capacity_1_2_3` | **GREEN** | Engine lane passes; exhaustive at 1/2/3 | Re-run each build |
| `determinism_replay` | **GREEN** | Engine lane + `gate:erasure` | Re-run each build |
| `snapshot_retention` | **GREEN** | Engine lane passes | Re-run each build |
| `chaos_capacity_1` | **GREEN** | `test:chaos`: 3 suites, 44 tests | Re-run each build |
| `chaos_capacity_2` | **GREEN** | `test:chaos`: same run, `CAPACITIES = [1, 2]` | Re-run each build |
| `cache_tier_flush` | **GREEN** | `cacheFlush.chaos.test.js` against real `commit.js` | Re-run each build |
| `calibration_safety_derived` | **RED** | `gate:calibration`: 39 findings, re-run | 39 × (`DERIVED` + stated derivation), §22.3-approved. **0 derivable here** (§7) |
| `scale_targets` | **RED** | Measured 913–931 ms for 3 of ~7 round stages at 500 × 200; routing absent | Whole-round p99 < 250 ms at 500 × 200 on representative hardware, **with routing** — needs **B1** *and* the solver |
| `locality` | **PARTIAL** | Structural halves genuine; T9 cross-scale claim not build-closable as classified | Reclassify or split the row (§17), then a staging cross-scale benchmark |
| `overload_admission_control` | **GREEN** | `test:scale`, real admission logic | Re-run each build |
| `simulator_fidelity` | **NOT_EVALUATED** | `sim:fidelity` re-run: 7 models `NOT_MEASURED` | Fleet demand generator; realised production data per slice; `sim.max_optimistic_bias` re-derived |
| `soak` | **NOT_EVALUATED** | Collector built and tested; no run performed | Staging env at production-shaped load; derived `release.soak_duration`; the shipping solver |
| `shadow_agreement` | **NOT_EVALUATED** | Worker `DEFERRED`; lifecycle and isolation verified | Composition root — **which needs B1** (§8) — then live traffic, then ≥ 14 days, then the published report |
| `invariants_enforced` | **NOT_EVALUATED** | Mechanism complete; no shard has operated | Live deciding shard; 22/22 `ENFORCED` over a **registered** observation window that does not yet exist |
| `safety_case_assembled` | **GREEN** | `safety:case` re-run, byte-identical regeneration confirmed twice | Re-run after any predicate/invariant/gate change |
| `rollback_rehearsed` | **NOT_EVALUATED** | Runbook/implementation consistency verified; no rehearsal performed | All six `rollback.md` §5 steps in staging, **including step 4**, dated with named operators |

**16 GREEN · 2 RED · 1 PARTIAL · 4 NOT_EVALUATED.** Unchanged in count from the Phase 15
independent verification. `gates.blockers({})` returns all 23 with no evidence filed.

### Entry conditions

| # | Condition | State |
|---|---|---|
| **E1** | Every §24 gate GREEN | **NOT MET** — 2 RED, 1 partial, 4 unevaluated |
| **E2** | Every §26 invariant `ENFORCED` in nominal operation, zero-violation SLI | **NOT MET** — no shard has operated; the observation window is still undefined |
| **E3** | Safety case assembled from queries | **MET** — re-verified this pass |
| **E4** | Legacy path removed from build | **MET** — re-verified this pass |
| **E5** | Rollback rehearsed | **NOT MET** |

### Update — revision 2 (2026-08-09): matrix re-verified, and what moved

Every gate was re-evaluated against the current working tree. **No gate changed status. The
count is still 16 GREEN · 2 RED · 1 PARTIAL · 4 NOT_EVALUATED, and `gates.blockers({})` still
returns all 23 rows with no evidence filed** — re-verified live: `RELEASE_GATES.length === 23`,
every row `blocking: true`.

The rows whose **remaining requirement** is now more precisely known:

| Gate | Status | What revision 2 adds to its remaining requirement |
|---|---|---|
| `scale_targets` | **RED**, unchanged | Three independent causes, not two — solver class, B1 routing, **and the routing read count (§23)**. And its target is not yet arithmetically defined (**Q-20.1**, §25), so the gate cannot be benchmarked against a settled number even once an engine exists |
| `shadow_agreement` | `NOT_EVALUATED`, unchanged | Adds a prerequisite that was not previously stated: **N18 (§23) must be fixed before the composition root lands.** A shadow decision record carrying an understated search gap contaminates the agreement evidence and the §21.4 SLI at the same time |
| `calibration_safety_derived` | **RED**, 39, unchanged | §26 regroups the 39 by *what blocks each*: **2 behind B1, 37 not**. B8 is not downstream of B1 and must not be scheduled as if it were |
| `lower_bound_admissibility` | **GREEN**, unchanged | **Legitimately green and stated so explicitly.** The gate is the exhaustive `LB ≤ γ` sweep, which §23's findings do not touch: N16/N17/N18 are about *which* candidates are exactly evaluated and *what gap is reported*, never about whether the bound is admissible. No green gate is challenged by this pass |
| `locality` | **PARTIAL**, unchanged | Unchanged and still the only finding that could let a gate close on evidence that does not support it. Its reclassification has **no B1 dependency** and belongs in the parallel track (§27, F) |
| `invariants_enforced` | `NOT_EVALUATED`, unchanged | Now known to be behind the coordinator composition root, hence behind B1 (§26), in addition to needing the undefined observation window |

**Nothing about the gate table, the evidence classes, the thresholds or the blocking flags was
changed by revision 2.**

---

## 17. Remaining Blockers

### Pre-existing, confirmed still open

| # | Blocker | Nature |
|---|---|---|
| **A** | **Calibration** — 39 Safety-class parameters not `DERIVED` | 17 accountable decisions, 15 measurements, 3 production-evidence, 2 shadow, 2 retirements. **Zero derivable here** |
| **B** | **`scale_targets`** — two independent causes: solver algorithm class (addressed, insufficient alone) and **B1 routing** (untouched, the dominant term) | Engineering + procurement |
| **C** | **Four production-evidence gates** — `shadow_agreement`, `simulator_fidelity`, `soak`, `invariants_enforced` | Empirical, wall-clock-bound |
| **D** | **`rollback_rehearsed`** | Organisational + staging |
| **E** | **§6.1 blocking decisions B1, B2, B3, B6, B8** all unresolved | Procurement/deployment/appointment |

### Newly found by this pass

| # | Finding | Severity | Consequence |
|---|---|---|---|
| **N11** | **The shadow composition root is not independent of B1.** `expandCandidates` needs `evaluateExact`, which needs travel times, which need a routing engine | **High** | The 14-day shadow window sits *behind* the longest-lead-time procurement item, not beside it. The blocker plan's schedule (Track C1 "concurrent with everything") is wrong, and this lengthens the critical path materially |
| **N12** | **No composition root exists for the production coordinator either.** `coordinator.worker.js` takes the same five collaborators as injected `deps`; nothing in the repository constructs a real solve path outside a test fixture | **High** | The cutover cannot happen without it, and it is not on anyone's plan. Same B1 dependency |
| **N13** | **Eleven worker rows name a cadence parameter absent from the register; five belong to workers this process claims it starts** | **Medium** | A precondition of Phase 15's own checklist item *"All engine workers move to production scheduling."* Inert today (verified: none resolves the key), live the moment a scheduler does |
| **N14** | **`src/engine/routing/client.js` is named in `ARCHITECTURE.md` as Phase 8's and does not exist**, and with it §5.2's two timeouts, the degradation ladder, §18.3 B6's uniform-treatment rule, and three unregistered parameters | **High** | This is B1's concrete repository-side shape. It was previously recorded only as "the routing directory contains caches only" |

### Carried forward, unresolved, from prior reviews

| # | Finding | Disposition |
|---|---|---|
| Ph15 F4 | `locality` gate classified `EVIDENCE.SUITE` but the T9 cross-scale claim is not build-closable | **Still open.** Not touched by this pass — it is a gate-table change and the only minor finding that could let a gate close on evidence that does not support it. Must be fixed before cutover |
| Ph14 F2 | `surrogateKeys` written by no engine code path | **Still open.** Decide before cutover: thread the lookup into `decisionRecord.js`, or reword the checklist disposition |
| Blocker plan §11.4 | The §26 invariant-observation window is undefined anywhere in the repository | **Still open.** Must be registered and derived *before* the cutover, not while watching it |
| Ph15 F1 | `formal/README.md` says "no Java toolchain"; the precise blocker is that `tla2tools.jar` is not vendored | **Deferred**, as recommended. Not blocking; §24.2 permits an equivalent checker |

### Newly found by revision 2 (2026-08-09)

Each was verified against the working tree — by execution where a behaviour is claimed, by
reading the file where a shape is claimed. Full analysis in the section named.

| # | Finding | Severity | Consequence | Section |
|---|---|---|---|---|
| **N15** | **Decision D2 (H3 FINE/COARSE resolution) was recorded as MISSING and is in fact DECIDED and implemented.** `spatial/cells.js:181–183` pins `FINE: 8` / `COARSE: 5` as `@structural` under B5, justified against `h3.getHexagonEdgeLengthAvg`, and `edgeLengthMetres()` — which §6.4's ring floor depends on — already consumes it | **Correction** | One of the eight ADR decisions is not open. What remains open is narrower and different: whether the *global* 8/5 pair survives D1's regional density, and whether §6.2's "per-region configuration" requires an override path that does not exist | §21, §22 |
| **N16** | **§6.4's per-candidate lower-bound filter does not exist.** `candidates/expansion.js:182–199` computes `LB(a, l)`, records it as `lbMilliCU`, and then calls `evaluateExact` **unconditionally**. §20.3 item 1 — *"Exact routing is requested only for the shortlist that survives geometric pruning"* — therefore has no implementation at the candidate level. Proven by execution, not by reading: an agent whose `LB` is 100 573 132 milliCU against an established `C*` of 1 000 milliCU is still exactly evaluated | **High** | This is the mechanism the entire routing budget depends on. It is why a round performs ~200 000 per-candidate routing reads, and why ~180 ms of a 250 ms budget goes to lookups even at the measured in-process floor. Cell-level pruning **does** exist and is active; the candidate-level filter does not | §23 |
| **N17** | **§9.4's "Truncate by lower bound" is implemented as truncation by enumeration order.** On reaching `candidate.max_evaluated`, `expansion.js:261–264` stops, retaining the first 200 agents in canonical (ring, then `agent_id`) order rather than the 200 with the smallest `LB` | **Medium** | A quality defect, not an admissibility defect: the retained set may exclude the true optimum where the cap binds. `LB ≤ γ` is untouched, so `lower_bound_admissibility` stays legitimately GREEN | §23 |
| **N18** | **The recorded search gap understates the proven bound on exactly the truncation paths §6.4 names.** The final floor is taken at `ring + 1` while the frontier is still inside `ring`. Measured: on a cap truncation, `achievedGapMilliCU` was reported as **4 817 548** where the bound the search actually proved is **5 000 000**. I20's continuous instrument checks only for *combined or negative* gaps and would not detect it | **High** | §6.4 requires the recorded number to be `C* − min LB over unexplored`, "a *proven* bound". On the cap, wall-clock and max-radius paths it is smaller than that — the decision record advertises a tighter guarantee than the search established. **Inert today** (no composition root, `ENGINE_ENABLED=false`, no round has ever run), and it must be fixed **before** the composition root lands, because shadow's decision records are the `shadow_agreement` evidence | §23 |
| **N19** | **§20.1's per-unit budgets do not compose into its round budget under any rule the frozen architecture states.** At §9.4's own caps, five rows exceed the 250 ms round budget as per-round aggregates by 2×–40×, and `solve.time_budget` (250 ms) equals `perf.round_wall_clock_p99` (250 ms) exactly. The document states the statistic and the scope but no aggregation rule and no intra-round concurrency model | **High** | `scale_targets` has no arithmetically defined target. A benchmark built on the aggregate reading gates on an unreachable number; one built on the single-unit reading gates on nothing. **Not a routing problem** — it applies identically to candidate generation and feasibility, so it is answerable **now**, with no engine and no region | §25 |
| **N20** | **Changing the routing cache read contract to meet §20.1's `< 10 µs` row is a Tier 0 change, not a Phase 8 refactor.** `chargerReachabilityCache.js` is registered `TIER.SAFETY_CORE` at `guards/tierAssertions.js:540` | **Medium** | Raises the bar on the one item the routing-prerequisite pass identified as "Phase 8 cache-contract work": it carries §1.8's Tier 0 discipline, not merely Phase 8 ownership | §24 |

---

## 18. Exact Evidence Needed to Close Each Remaining Blocker

### B1 — routing engine (closes nothing alone; unblocks three gates)

1. Deploy each candidate (OSRM / Valhalla / GraphHopper / in-house) against the target region
   extract **with per-profile contraction hierarchies built** — §20.3 item 5 makes the
   precomputation the point, so an engine measured without it is not measured.
2. Write one adapter per candidate to the contract in `tools/routing/b1Benchmark.js`'s header.
3. `npm run routing:b1 -- --engine <adapter> --json` per candidate **on representative
   hardware**; record all six rows.
4. Record hierarchy build time and extract refresh cadence per candidate — operational costs
   §20.1 does not name and the decision must still carry.
5. Choose on the recorded evidence; write the ADR. §6.1 makes B1 a decision, not a benchmark
   result.
6. Then: write `src/engine/routing/client.js` (Phase 8) with §5.2's two timeouts, the degradation
   ladder, and §18.3 B6's uniform-treatment rule; **register** `route.matrix_timeout`,
   `route.path_timeout` and the detour factor, the last of which is Safety-relevant because it
   multiplies reserves.

### `scale_targets`

Everything under B1, **plus** a whole-round p99 at 500 Legs × 200 candidates on representative
production hardware under production-shaped traffic, with candidate generation, feasibility, both
routing populations, pricing, the solve, and the commit inside the same 250 ms. Nothing less
discharges it; the 913 ms measured here covers three stages of roughly seven and omits the
dominant one.

### `calibration_safety_derived`

1. **Name the calibration owner (B8).** A decision, not a project. It gates the other 38.
2. **17 class-E decisions** — signed safety analyses (#1, #4, #5, #6, #14), an ops/finance/safety
   fleet-year budget sign-off (#11), operations decisions per SLA class (#19), external-authority
   agreements (#26, #27, #28 — start first, longest lead), §6.1 resolutions (#8, #9 via B2; #25
   via B6; #31, #32 via B1; #38 via B3), and the `sim.max_optimistic_bias` re-derivation (#39)
   **as a Safety tolerance decision under §22.3 two-person approval, with `awaits` corrected in
   the same change** — never edited quietly.
3. **15 class-B measurements** — each a *distribution* per the entry's declared `specScope`, not
   a point estimate, citing the dataset, the window and the slice. Where a slice is thin, §22.4's
   bootstrap sequence with §16.3 shrinkage, stated in the derivation.
4. **3 class-D** — fit the §14.2 consumption model against realised Wh (#15) after landing the
   `energy_calibration` worker's scheduler; #10 and #35 follow from it. **#15 is the highest
   fabrication risk in the register.**
5. **2 class-C** — derived from the *same* shadow run that discharges `shadow_agreement`, citing
   it. One artefact, two uses.
6. **2 class-F retirements** — repoint `src/simulation/constants.js` off
   `legacy.dtaro.charging_interrupt_battery_pct` first, then retire both entries via a §22.3
   two-person-approved register change with an ADR. `tests/engine/calibrationDisposition.test.js`
   will refuse a percentage derivation.

### `shadow_agreement`

1. **B1** (N11 — this is the newly-discovered prerequisite).
2. Build the composition root that constructs `round`, `expandCandidates`, `pricedCandidateFor`,
   `budgetsFor`, `deferPriceFor` outside a test fixture — **which N12 shows the production
   coordinator needs too**, so build it once.
3. Register `observability.shadow_interval` (N13).
4. Move the row from `DEFERRED` to `SCHEDULED`; confirm `assertNoEffects()` still refuses the
   coordinator's bundle.
5. Run against live inputs for **≥ 14 days** (`cutover.shadow_agreement_window`, DERIVED, not
   re-derivable).
6. Publish the agreement report naming the window's start and end instants and the traffic
   volume. File `{ pass: true, source, observedAt, detail }` against the gate.

### `simulator_fidelity`

1. Build the fleet demand generator with controllable burstiness and spatial correlation
   (checklist item 5).
2. Exercise §24.4's full brief: replayed **and** synthetic demand; every §18.2/§18.3 failure
   individually and in combination; entry into and exit from every §18.5 degraded mode with
   observed statuses matching §26.2's matrix exactly; the named adversarial scenarios; the aging
   cap.
3. Collect realised production data per model, per slice (zone × agent class × time bucket).
4. Re-derive `sim.max_optimistic_bias` as a decision first (§7a) — the gate is otherwise circular.
5. `npm run sim:fidelity -- --input <study>` exiting 0 with no safety-relevant model
   `OPTIMISTIC_BIAS_EXCEEDED`, `NOT_MEASURED` or `UNVALIDATABLE`.

### `soak`

1. Re-derive `release.soak_duration` from the observed time constant of the slowest accumulating
   resource. Until then `tools/soak/collect.js` returns `DURATION_TARGET_NOT_DERIVED`.
2. Settle the solver first — a soak of an artefact about to be replaced is a soak of the wrong
   artefact.
3. Run in staging at production-shaped load for at least that duration, driving
   `soak.createCollector()` once per window with the SLI snapshot, invariant summary, guardrail
   verdict, throughput, errors, CPU, memory, and the named growth series.
4. `assess()` must return `PASS` — meaning all eleven quantities `COLLECTED`, no drift, no
   invariant violation, no guardrail signal, and no §20.1 target missed throughout.

### `invariants_enforced`

1. Every other gate GREEN, and the staged cutover under way.
2. **Register and derive the invariant-observation window first** — long enough for each
   invariant's slowest-firing check to have fired. It does not exist today.
3. The invariant worker's SLI over that window on live shards: 22/22 `ENFORCED`, zero violations,
   `SUSPENDED` only where §26.2 authorises it and names the mode.

### `rollback_rehearsed`

1. Confirm a staging environment, the config-publish path, and **that a pre-Phase-15 artefact is
   still retained** — if retention has aged it out, rollback B is not merely untestable, it is
   unavailable in a real incident.
2. Schedule `cutover.worker.js` against the staging shard.
3. File **staging-scoped** release evidence, labelled as such in the rehearsal record and never
   against the production gate table.
4. All six `rollback.md` §5 steps, with **step 4 performed end to end** — artefact identified by
   `checkLegacyRetirement.js` *failing* on it, deployed, legacy path confirmed serving.
5. Retain: both audit events with their hash links proving ordering, `GET /api/health/cutover`
   before and after, the `error`-level log line, the 503 body from a refused intake, the deploy
   record, every timestamp, and the free-text "anything that surprised you".
6. Record the date and the named operators.

### `locality` (PARTIAL)

Reclassify the row to `PRODUCTION`, or split it into a `SUITE` row for the two structural
properties the test genuinely verifies and a `PRODUCTION` row for the T9 cross-scale claim; then
run the cross-scale benchmark in staging. **This is the only finding that could let a gate close
on evidence that does not support it, and it should be fixed before cutover.**

---

## 19. Phase 15 Recommendation

# PHASE 15: STILL BLOCKED

Two gates are RED, one is partially discharged against the wrong evidence class, and four require
evidence no repository can produce. Three of the five entry conditions are unmet. `gates.blockers({})`
returns all 23 rows with no evidence filed, and the machinery is correct to refuse.

**This is the release-gate machinery working exactly as designed, not a defect in Phase 15's
implementation.** Phase 15's code was independently verified as correct, and nothing in this pass
contradicts that.

**The single recommended next action is to resolve B1.** It has displaced the solver as the
critical path, on the evidence of this report:

- it is the dominant term in the gate the solver work could not close alone (§13);
- it is a newly-discovered prerequisite of the shadow composition root, which is itself the
  longest wall-clock item in the programme (§8, N11);
- the same composition root is missing for the production coordinator, so the cutover needs it
  too (N12);
- it blocks two of the 39 calibration parameters and one deferred worker;
- and it carries the longest lead time of any §6.1 item, by the execution plan's own assessment.

`npm run routing:b1` now exists so that decision is made against §20.1's registered targets rather
than against raw query speed. Two things should start on the same day, by different people:
**name the calibration owner (B8)**, which is a decision rather than a project and gates 38 of the
39 parameters; and **rehearse the rollback in staging**, which depends on nothing else and remains
the earliest gate that can close.

---

## 20. Phase 16 Recommendation

# PHASE 16: NOT READY

Phase 16 must not begin. Its entry condition — every §24 gate green and every §26 invariant
observed `ENFORCED` in production — is not close to satisfied, and the following Phase 15 entries
are RED, `NOT_EVALUATED`, or missing required evidence:

- `calibration_safety_derived` — **RED**, 39 findings
- `scale_targets` — **RED**, and its dominant term has never been measured
- `locality` — **PARTIAL**, against the wrong evidence class
- `shadow_agreement`, `simulator_fidelity`, `soak`, `invariants_enforced` — **NOT_EVALUATED**
- `rollback_rehearsed` — **NOT_EVALUATED**
- **Missing routing decision** — B1, unresolved
- **Missing production evidence** — no shard has ever decided a Leg
- **Missing rollback evidence** — no rehearsal has been performed

**No Phase 16 work was performed and no Phase 16 module exists.** `src/engine/fairness/` holds
only `.gitkeep`; there is no `preemption.js`, `setPartitioning.js`, `branchAndBound.js`, or
`localSearch.js`; all 12 Tier 2 kill switches default thrown. The boundary is now enforced
file-by-file in `solve/` and `lifecycle/` as well as in `shard/`, `security/` and `cutover/`
(§5), which is a stronger guarantee than existed when this pass began.

### Explicit statement on evidence that cannot be produced here

The following **cannot** be produced from this environment, and none of it was manufactured:

- a deployed routing engine with built contraction hierarchies, or any measurement of one;
- any of the 39 Safety-class calibration values — no fleet, no vendor documentation, no external
  authority, no accountable owner;
- 14 days of shadow agreement against live traffic;
- a per-model, per-slice simulator fidelity study against realised production data;
- a multi-day soak at production-shaped load;
- any observation of a §26 invariant in nominal operation;
- a rollback rehearsal — no staging environment, no config-publish path, no second approver, no
  retained pre-Phase-15 artefact.

Every one of these has an exact executable procedure in §18. None of them has a shortcut.

### Update — revision 2 (2026-08-09)

**Phase 16 remains NOT READY, and revision 2 moved it further away rather than closer.** Every
row in the list above is unchanged, and three prerequisites were added to the path in front of
it: N16/N17/N18 (a Phase 9 defect pass, §23), Q-20.1 (an architecture answer, §25), and the
Tier 0 cache-contract decision (§24).

Re-verified mechanically on the current tree: **no Phase 16 module exists.**
`src/engine/fairness/` holds only `.gitkeep`; there is no `preemption.js`,
`setPartitioning.js`, `branchAndBound.js` or `localSearch.js`; the file-by-file ownership guard
in `tests/engine/phase0Scaffold.test.js` still refuses all five by name; and the full suite
passes at **141 / 6 154 / 0**. **No Phase 16 work was performed by revision 2, and none was
scoped.**

---

## 21. Pre-B1 Readiness Audit — Reconciling the Four Routing Documents

**Revision 2. Role: Principal Systems Engineer, determining the exact next legitimate action.**

Four documents now describe B1's state, written across two days by three passes. They are
consistent in substance, and reading them in isolation is misleading in three places. This
section resolves only what repository evidence can resolve, and preserves rather than
overwrites what it corrects.

### 21.1 What each document is authoritative for

| Document | Date | Authoritative for | Superseded in |
|---|---|---|---|
| `PHASE_15_B1_ROUTING_DECISION_REPORT.md` | 2026-08-08 | The candidate-engine survey, the environment audit, the corrected B1 evidence procedure, and the finding that Redis cannot serve the 10 µs row | Its §17 row 2 ("no declared mobility models") — see C3 |
| `PHASE_15_ROUTING_CONFIGURATION_DECISION.md` | 2026-08-09 | The D1–D8 decision list, the seed-artefact analysis, the required-field enumeration | Its §3.2 row S2 and §8 row D2 — see **C1** |
| `PHASE_15_ROUTING_PREREQUISITE_REMEDIATION_REPORT.md` | 2026-08-09 | The in-process cache tier, its measurements, and the read-count arithmetic of its §12.5 | Nothing. Its §12.5 item 2 is *strengthened* by §23 and its item 3 by §25 |
| **This document** | 2026-08-08 / **-09** | **Everything. The single living Phase 15 record.** | — |

### 21.2 Corrections, with the reason for each

Three, and only three. Each is a refinement supported by repository evidence, not a reversal.

#### C1 — Decision D2 is not missing; it is decided and implemented

**Previous finding.** `PHASE_15_ROUTING_CONFIGURATION_DECISION.md` §3.2 row S2: *"H3 resolution
for FINE and COARSE … `spatial.h3` or a register entry. Neither exists. **MISSING**."* §8 row D2
repeats it as an open ADR decision owned by Engineering.

**New evidence.** `Backend/src/engine/spatial/cells.js:172–184`, read in full:

```js
/**
 * The H3 resolution each §3.6 band maps to, chosen against `h3.getHexagonEdgeLengthAvg`:
 * resolution 8 averages ≈531 m/edge (§6.2's "~200–500 m" fine band …); resolution 5
 * averages ≈9.85 km/edge (squarely inside the "~5–10 km" coarse band). A discrete
 * resolution choice is an architectural primitive (B5), not a calibratable behavioural
 * constant, so it is `@structural` rather than a register entry …
 * @structural B5 — H3 resolution per §3.6 band, not a tunable value
 */
const H3_RESOLUTION = Object.freeze({ FINE: 8, COARSE: 5 });
```

It is not inert. `h3ResolutionOf()` consumes it, `edgeLengthMetres()` is defined in terms of it,
and `candidates/expansion.js`'s `minimumPossibleDistanceForRingMetres()` — the geometric floor
§6.4's whole pruning rule turns on — is a multiple of `edgeLengthMetres(FINE)`. **The resolution
choice is already load-bearing in the decision path.**

**Corrected conclusion.** **D2 is CLOSED as a global default.** The residual open question is
narrower and different in kind: §6.2 states that the proximity-partition abstraction's
*"implementation is per-region configuration"*, and the repository implements it as a **single
global structural constant with no per-region override**. So what D1 actually reopens is not
*"which resolution"* but *"does res 8 / res 5 sit inside §6.2's bands for **this** region's
density, and if some future region needs a different pair, where does the override live?"*

**Reason for the correction.** The earlier pass searched for a `spatial.h3` payload field and a
register entry, and correctly found neither — because neither is where the decision belongs.
§22.1 requires *behavioural constants* in the register; a discrete spatial-index resolution is an
architectural primitive resolved by **B5**, which the execution plan §6.1 records as already
answered ("H3 preferred outdoors for uniform k-ring metrics"). `@structural` is the correct home
and `gate:params` passes because of it, not in spite of it. The earlier finding looked for the
answer in the two places the answer must not be.

#### C2 — The worker registry has 18 rows, not 19

Recorded in place at §8. Substance unchanged: 11 cadence keys absent from the register, 5 of them
on workers this process schedules.

#### C3 — "No declared mobility models" and "one declared mobility model" are both true

**Apparent contradiction.** `PHASE_15_B1_ROUTING_DECISION_REPORT.md` §17 row 2 states *"No
declared mobility models, so the profile set and therefore the hierarchy count are unknown"* and
its §4 concludes the count is *"currently zero and unknowable"*.
`PHASE_15_ROUTING_PREREQUISITE_REMEDIATION_REPORT.md` §14 marks the same row *"PARTIALLY
REMOVED"* on the evidence that one model **is** declared.

**Resolution from repository evidence.** They describe different objects and both hold.
Re-verified live this pass: `service.defaultSnapshot()` returns `bindings` of size 0 and
`spatial: null` — **no mobility model exists in published configuration**;
`Backend/prisma/seed.js` declares exactly one, `MOB-SIDEWALK-DEFAULT`, mirrored into the durable
`MobilityModel` table and attached to agent class `AC-SIDEWALK-DEFAULT`.

**Corrected conclusion.** The profile set is **derivable and provisional**, not unknowable:
`MOB-SIDEWALK-DEFAULT:SIDEWALK_GRAPH:{loaded,unloaded}`, two profiles per region. It is not
*usable*, for a reason neither document should let the reader lose: the model's `speedModel` is
the literal stub `{ note: "Populated by the routing integration in Phases 7–9 (blocking decision
B1)" }`, and **a contraction hierarchy is a precomputation over edge costs**. The profiles can be
named. They cannot be built. **The distinction that matters for B1 is not how many profiles there
are; it is that none of them has a cost model.**

### 21.3 Non-contradictions, recorded so they are not re-litigated

| Apparent conflict | Resolution |
|---|---|
| Cache-path measurement: **241–246 ms** (B1 report §7.1) vs **381–387 ms** (prerequisite report §13.2), same configuration | Not a conflict. Different machine sessions; the raw Redis `GET` moved by the same factor (304/1 156 µs → 383–485/996–1 810 µs). Both passes disclosed it and both compared only against their own baseline. Neither figure is §20.1 gate evidence |
| `buildInstance` share: **~35 %** vs **~64 %** | Resolved in §4 of this document, revision 1: standalone Node vs the Jest `scale` lane. Both correct, neither was labelled, and the four-class taxonomy in the cost-scaling report now prevents a recurrence |
| Blocker plan places the shadow composition root as "Track C, concurrent with everything" | Wrong, and confirmed wrong twice more since (N11; B1 report §13; the registry's own `blockedBy` text). The blocker plan is a planning document and this record supersedes it on that point |

---

## 22. D1–D8 Decision Audit

Every decision in `PHASE_15_ROUTING_CONFIGURATION_DECISION.md` §8, audited against the working
tree. **No answer was invented.** Where the repository does not support an answer and the frozen
architecture does not supply one, the row is classified **EXTERNAL DECISION** and left open.

### 22.1 Summary

| # | Decision | Status | Derivable by engineering? | Owner |
|---|---|---|---|---|
| **D1** | Target OperatingRegion(s) and each boundary | **OPEN — binding on everything** | **No** | Operations + Commercial |
| **D2** | H3 FINE/COARSE resolution | **CLOSED globally** (§21.2 C1); narrow residual | **Residual: yes, once D1 lands** | Engineering |
| **D3** | Fleet agent classes and mobility models | **OPEN** | **No** | Product + Fleet Engineering |
| **D4** | Required traversal domains | **OPEN — recommendation ready** | Recommendation yes; **ratification no** | Architecture |
| **D5** | Region/shard count and mission rate `r` | **OPEN** | **No** | Operations |
| **D6** | Where mass and centre of gravity are declared | **OPEN — shape derivable, values not** | Shape yes; **values no** | Architecture (shape) + Fleet Engineering (values) |
| **D7** | Whether `traversalDomain` becomes a composition | **OPEN — contingent on D4** | Shape yes; **need depends on D4** | Architecture |
| **D8** | Extract vintage, refresh cadence, re-contraction window | **OPEN** | **No** | Operations |

**Seven of eight are open. Six of the seven are external.** Only D2's residual and the *shapes*
of D6/D7 are engineering's to settle, and each of those is behind D1 or D4.

### 22.2 D1 — target operating region and boundary

| | |
|---|---|
| **Status** | **OPEN. EXTERNAL DECISION. The binding prerequisite for all of B1.** |
| **Evidence** | Re-verified live: `service.defaultSnapshot()` → `spatial: null`, `shards: null`, `bindings.size === 0`. Read from `prisma/schema.prisma`: `model Region` carries `regionId`, `name`, `description` and relations — **and no boundary, bbox, polygon or CRS column of any kind.** `SEED_SPATIAL_MAP` declares `RGN-BLR` with `{ id, name }` only, four FINE cells and one COARSE cell, with placeholder token ids that are not H3 indices |
| **Exact missing input** | Per region: a stable `regionId`, a human name, and **a boundary as a GeoJSON polygon or a bounding box with its CRS stated** |
| **Can engineering derive it?** | **No.** §3.5 defines what an OperatingRegion *is* — "a site, campus, depot catchment, or metro service area" — and never which one this deployment serves. Nothing in the architecture, the execution plan or the repository selects one |
| **External owner** | Operations + Commercial. §22.3 change class |
| **Downstream** | The OSM extract → per-profile contraction hierarchies → extract size, build time, build memory, runtime memory per profile → per-shard resource cost → §3.5 sizing. Also D2's residual, S3 (the fine-cell set), D5, D8, and every row of the B1 report's §8 |
| **Exact closure condition** | An approved region list with geometry, recorded in an ADR, **plus** a schema decision on where `regions[].boundary` lives — because §22.1 rule 5 refuses a published schema that admits an unreviewed shape, and the shape (polygon vs bbox, which CRS) is part of D1's own answer |

**The seed region is not a candidate answer and was not treated as one.** It is a Phase 2
§3.6-containment demonstration: never published as a configuration version, four fine cells
against §3.6's 10³–10⁵, placeholder cell ids, and no geometry anywhere. That it names Bengaluru
is the trap, not the evidence.

### 22.3 D2 — H3 FINE/COARSE resolution

| | |
|---|---|
| **Status** | **CLOSED as a global default.** Corrected this pass — see §21.2 C1 |
| **Evidence** | `spatial/cells.js:181–183`: `H3_RESOLUTION = { FINE: 8, COARSE: 5 }`, `@structural B5`, justified against `h3.getHexagonEdgeLengthAvg` (res 8 ≈ 531 m/edge; res 5 ≈ 9.85 km/edge) against §6.2's ~200–500 m and ~5–10 km bands. Consumed by `h3ResolutionOf()`, `edgeLengthMetres()`, and thence by §6.4's ring floor |
| **Residual missing input** | D1's region and its agent density, to confirm res 8 is the right fit *there* — the module's own comment concedes "H3's discrete resolutions do not land exactly inside every stated band, and 8 is the nearest fit outdoors" |
| **Can engineering derive it?** | **Yes, once D1 lands.** It is an arithmetic check against published edge lengths plus a density judgement |
| **External owner** | None for the residual. Engineering, against D1 |
| **Downstream** | Every cache key, every k-ring bound, `route.intra_cell_offset_m`'s meaning (250 m, PROVISIONAL, against a 531 m average edge), and §6.4's ring floor |
| **Exact closure condition** | (a) D1 answered; (b) a recorded check that 8/5 sits inside §6.2's bands for that region; (c) an explicit decision on whether §6.2's "per-region configuration" requires a per-region override — the repository has **one global pair and no override path**, and adding one is a schema change, not a constant change |

### 22.4 D3 — fleet agent classes and mobility models

| | |
|---|---|
| **Status** | **OPEN. EXTERNAL DECISION.** |
| **Evidence** | Exactly one `MobilityModel` in the durable seed, `MOB-SIDEWALK-DEFAULT`, structurally valid under `domain/mobilityModel.validateModel()`. Its `speedModel` is a stub whose own text defers to B1. Zero in published configuration (`bindings.size === 0`) |
| **Exact missing input** | The list of agent classes this deployment will operate and, per class, the six §2.2 elements **with a real speed model** — speed as a function of road class, gradient, surface, payload mass, congestion and weather |
| **Can engineering derive it?** | **No, and it must not try.** §25.4: *"A heterogeneous fleet with copy-pasted parameters will make confidently wrong cross-class comparisons, which is worse than not comparing at all — so class parameter completeness MUST be a commissioning gate."* A model invented to make the profile count non-zero is exactly that copy-pasted set |
| **External owner** | Product (which classes) + Fleet Engineering (each class's parameters) |
| **Downstream** | The profile set → the hierarchy count (`models × 2 × regions`) → B1's procurement scope; §25.4's commissioning gate; five of the 39 calibration parameters that are per-class vendor/bench measurements |
| **Exact closure condition** | One complete, reviewed parameter set per class admitted to production allocation. **The speed model is the blocking element**, because a contraction hierarchy is a precomputation over edge costs and a stub yields none |

### 22.5 D4 — required traversal domains

| | |
|---|---|
| **Status** | **OPEN. Engineering's recommendation is complete; ratification is external.** |
| **Evidence** | `domain/mobilityModel.js` declares four domains. §6.2: indoor and multi-level sites *"use site-local graph zones rather than geodesic cells … The index abstraction is 'proximity partition,' and its implementation is per-region configuration"* — **not something an OSM engine provides.** §25.2 lists UAS under "Additions required: 3D routing with airspace volumes". §27 item 2 makes the engine choice depend on "multi-modal networks", dependency: "Modality roadmap" |
| **Exact missing input** | Whether the modality roadmap includes vehicles (`ROAD_GRAPH`), indoor sites (`INDOOR_GRAPH`) or drones (`AIRSPACE_VOLUME`) inside the horizon B1's engine must serve |
| **Can engineering derive it?** | **The recommendation, yes — and it stands: B1 scopes the outdoor geodesic graph** (`SIDEWALK_GRAPH`, plus `ROAD_GRAPH` if vehicles are in the horizon, since the same extract serves both). `INDOOR_GRAPH` is a separate per-region proximity-partition implementation; `AIRSPACE_VOLUME` is a separate modality decision. **The roadmap it is evaluated against is not engineering's** |
| **External owner** | Architecture, against a Product roadmap |
| **Downstream** | Which engines are even candidates. This is the difference between procuring one OSM engine and procuring a multi-modal platform |
| **Exact closure condition** | One ADR line stating B1's domain scope and explicitly excluding what it excludes |

### 22.6 D5 — region/shard configuration and mission rate

| | |
|---|---|
| **Status** | **OPEN. EXTERNAL DECISION.** |
| **Evidence** | `snapshot.shards === null`. `shard.mission_rate_per_agent_hour` resolves to **4**, PROVISIONAL and global. Every shard field is already enforced at publish by `shardModel.validateDefinition()` / `validateDefinitions()` and `validators.v4ShardSizing()` — **no schema change is needed; there is no value to carry** |
| **Exact missing input** | The number of regions and shards at launch, and each region's expected `r` in missions per agent-hour at peak (a planning figure suffices to size the first shard) |
| **Can engineering derive it?** | **No.** §3.5: *"A dense urban shard running short hops at `r = 20` admits roughly 4 400 agents, not 20 000."* The register's 4 is a global placeholder, not a measurement |
| **External owner** | Operations |
| **Downstream** | §3.5's sizing inequality; the hierarchy count multiplier; and **H3 — §3.5's inequality carries no term at all for the routing engine's per-shard footprint**, which §5.2 requires on every shard. Once runtime memory per profile is known, a shard may be bound by a resource §3.5 does not currently state |
| **Exact closure condition** | A published shard definition set, and an ADR entry adding the routing footprint to the §3.5 sizing report |

### 22.7 D6 — mass and centre of gravity

| | |
|---|---|
| **Status** | **OPEN. Shape derivable; values external.** |
| **Evidence** | Read from `prisma/schema.prisma`: `model MobilityModel` declares `traversalDomain`, `permissionSet`, `speedModel`, `kinematicLimits`, `envelopeConstraints`, `dimensionalFootprint` — **and no mass field and no CoG field.** What exists elsewhere is a different quantity: `ContainerModel.totalMassLimitKg` (a payload limit, §15.2) and the container CoG envelope (`payload/loadState.js`, F24). §15.5: *"mass and CoG limit traversable inclines, which is a **routing** constraint, so the routing query for a loaded leg differs from the unloaded one"* — and `mobilityModel.js` cites that sentence as the reason `:loaded` and `:unloaded` are distinct profiles |
| **Exact missing input** | (a) An architecture decision on where tare mass, laden mass and CoG are declared; (b) per class, their values |
| **Can engineering derive it?** | **The schema shape, yes. The values, no** — they are per-class commissioning data, not calibration, and not derivable from anything here |
| **External owner** | Architecture (shape) + Fleet Engineering (values) |
| **Downstream** | The meaning of the `:loaded` hierarchy. **The profile split is implemented and the quantity that gives it meaning is absent**, so an engine would build two hierarchies of which one is defined by nothing. It doubles the hierarchy count for a distinction nothing can currently compute |
| **Exact closure condition** | A schema decision (published under §22.1 rule 5 review) plus per-class values at commissioning |

### 22.8 D7 — traversal-domain composition

| | |
|---|---|
| **Status** | **OPEN. Contingent on D4.** |
| **Evidence** | `MobilityModel.traversalDomain` is a scalar `String` column (schema read). `mobilityModel.traversalDomains()` already supports a **composition** — it filters to recognised values, de-duplicates, and sorts by code unit — and `routingProfileKey()` folds the sorted list into the key. So the *code* supports §25.3 composition and the *schema* cannot store one |
| **Exact missing input** | D4's answer. If B1 scopes a single domain, D7 is deferred with a recorded reason rather than decided |
| **Can engineering derive it?** | The shape, yes; the need, no — it follows D4 |
| **External owner** | Architecture |
| **Downstream** | Multi-modal profiles only |
| **Exact closure condition** | Decided in the same ADR as D4. **A related sharp edge must be closed with it:** `routingProfileKey()` is *total* — an absent `modelId` or unrecognised domain yields the literal `"unknown"`, so two differently-broken models both key as `unknown:unknown:unloaded` and **would share cache entries**. `validateModel()` refuses such a model; the key function does not. The Phase 8 routing client must validate before it keys, and that requirement belongs in the ADR |

### 22.9 D8 — extract vintage, refresh cadence, re-contraction window

| | |
|---|---|
| **Status** | **OPEN. EXTERNAL DECISION.** |
| **Evidence** | No map provenance exists anywhere in the repository. `CellAssignment.mapVersion` defaults to `0` and is explicitly *"not a foreign key"*. §5.2 makes the map service's snapshot "version pinned" and requires the routing service colocated and **available throughout**; a re-contraction is a rebuild, not a reload |
| **Exact missing input** | The acceptable extract refresh cadence and the tolerable re-contraction downtime |
| **Can engineering derive it?** | **No** — it is an availability and operations decision |
| **External owner** | Operations |
| **Downstream** | §5.2 availability; §9.6 replay provenance; and it interacts with **B6**, whose parameter `map.obstruction_class_max_age` awaits "the region's map hazard-data publication cadence" — one of the 39 |
| **Exact closure condition** | A stated cadence and a re-contraction procedure in the ADR, plus a decision on where map provenance is recorded |

---

## 23. §6.4 Pruning Audit

**The brief's question was whether §6.4 pruning exists, whether it is active, and how many
candidates survive. The answers are: partly, yes for the half that exists, and unmeasurable
here — and the audit found three defects in the half that does not.**

Every finding below was verified by executing the real module, not by reading it. The probe was
run from the scratchpad against the repository's own `candidateFixture` helper and the real
Availability Index; it is a diagnostic, it is not a repository test, and it was not added to the
suite.

### 23.1 The production path, traced

| Stage | Module | State |
|---|---|---|
| Candidate generation | `candidates/expansion.js` `expandCandidates()` | **Implemented.** All seven §6.3 tiers |
| Cell/ring-level lower-bound pruning | `expansion.js` `unexploredRingFloorMilliCU()` + `shouldStopExpanding()` | **Implemented and ACTIVE** |
| **Per-candidate lower-bound pruning** | — | **ABSENT (N16)** |
| Exact feasibility + price | `input.evaluateExact`, injected | **No production implementation exists** |
| Routing calls | via `evaluateExact` only | **None. No production path calls a router** |
| Approach population | `routing/cellPairCache.js` | **No consumer anywhere under `src/`** |
| Return-leg population | `routing/chargerReachabilityCache.js` | One consumer: `workers/chargerReachability.worker.js`, which is `DEFERRED` |
| Charger reachability | same | Behind the DEFERRED worker and a routing client that does not exist |
| Shortlist formation | `expansion.js` → `ordering.orderCandidates()` | **Implemented**, over whatever survived feasibility |

### 23.2 What exists and is genuinely active

**Cell-level pruning is real and it works.** `unexploredRingFloorMilliCU()` evaluates §6.4's own
`LB` formula at the *closest physically possible* position in the next unexplored ring, using the
fleet's best-case speed and energy coefficients and never a specific agent's — which is exactly
what §6.4 permits to be computed *"without touching [the cell's] members"*. `shouldStopExpanding()`
implements §6.4's termination rule literally:

```js
// §6.4: min LB over unexplored ≥ C* − Δ_opt.
return compareMilliCU(minUnexploredFloorMilliCU, subtract(bestGammaMilliCU, tolerance)) >= 0;
```

It is guarded correctly in both directions: it never stops with nothing found (sparse-fleet
correctness), and it never stops before `candidate.target_feasible` feasible candidates exist.
Tiers 3 and 4 apply it with a floor of `0n`, which is maximally conservative and therefore safe.

**Observed working, in the probe:** an agent seeded 2.2 km from the origin was never enumerated,
because expansion terminated on the pruning rule several rings earlier. That is the mechanism
doing its job.

### 23.3 N16 — the per-candidate filter does not exist

`expansion.js:182–199`, in full:

```js
async function evaluateOne(input) {
  const { agentId, tier, agentSnapshot, leg, /* … */ evaluateExact } = input;
  const bound = lowerBound({ agent: agentSnapshot, /* … */ });
  if (!bound.ok) return { agentId, tier, lbMilliCU: null, lbProblems: bound.missing, exact: null };
  const exact = await evaluateExact(agentId, leg, agentSnapshot);   // ← unconditional
  return { agentId, tier, lbMilliCU: bound.milliCU, lbBreakdown: bound.breakdown, exact };
}
```

`bound.milliCU` is computed, carried into the result for reporting, and **never compared against
`bestGammaMilliCU`.** The function's own docstring says *"One survivor of the LB pre-filter,
exactly evaluated."* There is no pre-filter.

**Proven by execution rather than by reading.** Two agents were seeded in the *same* origin fine
cell — so cell-level pruning cannot separate them — with their `LB` made to differ by the
agent-specific `wait_until_available` term, which §6.4 puts inside `LB` and which no geometric
bound can see:

```
Q1 evaluateExact called for: [ 'agent-a-near', 'agent-b-far' ]
Q1 per-candidate LB (milliCU): {"agent-a-near":"573132","agent-b-far":"100573132"}
Q1 bestGamma: 1000   agentsEvaluated: 2
```

`agent-b-far`'s lower bound is **100 573 132 milliCU against an already-established `C*` of
1 000 milliCU** — five orders of magnitude above it, from a bound the build gate proves satisfies
`LB ≤ γ`. It was still exactly evaluated. Agents are visited in `agent_id` order (§6.6), so
`agent-a-near` had already set `C*` when `agent-b-far` was considered: a filter would have been
both correct and effective here.

**Why this is the centre of the routing budget.** §20.3 item 1 names it as the *first and most
effective* mitigation: *"**Lower-bound pruning first** (§6.4). Exact routing is requested only
for the shortlist that survives geometric pruning."* With no candidate-level filter, the exact
evaluation count per Leg is bounded only by `candidate.max_evaluated` (200) — 100 000 per round,
and about **200 000 per-candidate routing reads** across §20.3's two populations. That is exactly
the number the routing-prerequisite report's §12.5 prices at ~180 ms of a 250 ms round *at the
measured in-process floor*. **The read count, not the read cost, is the binding term, and this is
the mechanism that was supposed to reduce it.**

### 23.4 N17 — §9.4's "truncate by lower bound" is truncation by arrival order

§9.4's size-control table: *"Candidates per Leg | `candidate.max_evaluated` | 200 | **Truncate by
lower bound**; record the search gap in CU (§6.4)."*

`expansion.js:261–264`:

```js
if (agentsEvaluated >= (source.maxEvaluated ?? Number.POSITIVE_INFINITY)) {
  truncatedBy = "candidate.max_evaluated";
  return;
}
```

The cap retains the **first** 200 agents in canonical enumeration order (rings outward, then
`agent_id` within a cell), not the 200 with the smallest `LB`. Where the cap binds, the retained
set can exclude the true optimum even though the bound that would have identified it was
computed.

**This is a quality defect, not an admissibility defect.** `LB ≤ γ` is untouched, the exhaustive
build-time sweep in `tests/engine/candidateAdmissibility.test.js` is unaffected, and the
`lower_bound_admissibility` release gate remains legitimately GREEN.

### 23.5 N18 — the recorded search gap understates the bound the search proved

§6.4 is explicit about what must be recorded, and about when:

> **When a budget truncates the search** — tier cap, candidate cap, or time cap — the engine MUST
> record the achieved bound: `C* − min LB over unexplored` is a *proven* bound on the search gap
> for that decision, in CU, and is non-negative by construction.

`expansion.js:463–479` computes the final gap against `ringDistance: ring + 1`. On the
`pruning_rule_satisfied` path that is correct — ring `r` was fully explored, so the frontier is
`r + 1`. **On every truncation path §6.4 names, it is not**: the loop `break`s mid-ring with
`ring` still equal to `r`, so agents remain unexplored *inside* ring `r`, whose floor is lower.
The same off-by-one applies on the `maxRadiusRings` exit and, more broadly, whenever tiers 3–6
leave cells unvisited that the ring floor does not bound at all.

**Measured, on a deliberate cap truncation:**

```
Q2 truncatedBy: candidate.max_evaluated   agentsEvaluated: 3   cellsExplored: 2   tiersExplored: 1
Q2 bestGamma: 5000000   reported achievedGap: 4817548
  ring 0: floor=0        C*-floor=5000000
  ring 1: floor=0        C*-floor=5000000
  ring 2: floor=182452   C*-floor=4817548
```

Two of ring 0/1's seven cells were queried, so the exploration frontier is **inside ring 1**,
whose floor is `0` and whose proven bound is therefore **5 000 000**. The engine recorded
**4 817 548** — the figure for ring 2, a ring strictly beyond the frontier.

**The direction of the error is the dangerous one.** The recorded gap is *smaller* than the bound
actually proven, so the decision record advertises a tighter optimality guarantee than the search
established. That is the same failure mode §6.4 names when it explains why the `Ω` corrections
exist: *"pruning would then silently discard cells containing the true optimum while the decision
record advertised a proven guarantee."*

**I20's continuous instrument would not detect it.** `observability/invariantChecker.js`'s
`checkI20` audits decision records for *combined or negative* gaps; an understated positive gap
is neither, so I20 would report `ENFORCED` throughout. §26.1 puts I20's real verification at
build and publish time — and the build gate checks admissibility (`LB ≤ γ`), not the arithmetic
of the reported figure.

**It is inert today**, and that matters for its classification: no composition root exists, no
`evaluateExact` implementation exists, `ENGINE_ENABLED` is false, and no round has ever produced
a decision record. It becomes live the moment the composition root does.

### 23.6 How many candidates survive, and how routing-read counts are generated

**Unmeasured, and unmeasurable in this repository. The instruments exist; the population does
not.**

| Question | Answer | Evidence |
|---|---|---|
| Is candidate survival instrumented? | **Yes.** `expandCandidates()` returns `agentsEvaluated`, `cellsExplored`, `truncatedBy` and `achievedGapMilliCU`; `solve/round.js:248–251` carries all four; `observability/decisionRecord.js:258–259` and `observability/tierA.js:417–418` write them into the Tier A record | Read in full |
| Is the per-agent `LB` observable? | **Yes.** `GET /api/diagnostics/candidates/:legId` evaluates the real `LB(a, l)` for every agent the live index returns, ranks by it, and reports `bestLbCu`, `smallestUnexploredBoundCu` and a labelled `achievedGapCu` — with its own honest disclosure that it ranks by `LB` rather than exact `γ` because Phase 10's pipeline is not wired | Read in full |
| So how many survive? | **Cannot be known here.** It needs an operating Availability Index with real agents, a real Leg population, and an `evaluateExact` — none of which exists | `bindings.size === 0`; no composition root |
| How are routing-read counts generated in production? | **They are not.** No production path calls a router. `cellPairCache.js` has **no consumer anywhere under `src/`** (its `hopsFor()` included; `planBuilder`'s `hopsForSequence` is injected and supplied only by `tests/engine/helpers/planFixture.js`). `chargerReachabilityCache.js` has exactly one consumer — the `DEFERRED` precompute worker | `grep` over `src/` and `server.js` |
| Is instrumentation missing? | **Partly.** Both cache modules ship a `Counters` class for §20.3's SLI, and **neither has a consumer** — nothing constructs one and passes it, because the thing that would is the composition root. The counters are not missing; their wiring is, and its absence is a consequence of B1, not an independent gap | Read in full |
| Where does every routing-read number in this programme come from? | `tools/routing/b1Benchmark.js` and `tools/routing/inProcessCacheBenchmark.js` — harnesses, driven by a zero-latency stand-in, explicitly labelled diagnostic and explicitly not §20.1 gate evidence | Read in full |

**§6.4 pruning effectiveness was not estimated, modelled, or assumed.** The routing-prerequisite
report's §12.5 item 2 says it plainly and this audit confirms it: *"whether the surviving
shortlist is 200 or 20 per Leg is a Phase 8/9 integration property that nobody has scoped and no
measurement in this programme covers."* It remains the largest unknown in the routing budget.

### 23.7 Ownership, and why nothing was implemented

**Ownership is unambiguous.** `tests/engine/phase0Scaffold.test.js:167–168` assigns
`candidates/` to `PHASE_9_OWNED`. The execution plan's Phase 9 row lists *"Implement the pruning
rule with an **additive** CU tolerance"* among its deliverables and *"Expansion driven by the
pruning rule, not a fixed ring count; achieved bound recorded in CU on every truncation"* among
its completion criteria. §9.4's table specifies the truncation rule. **All three findings are
Phase 9-owned and already specified by the frozen architecture and the execution plan. None of
them is new capability that needs designing; each is a specified behaviour that was not
implemented as specified.**

**Nothing was implemented by this pass. Four reasons, in order of weight:**

1. **This is a landed, independently verified phase's decision path.** Phase 15 ships no new
   capability, and changing which candidates receive an exact evaluation is a behavioural change
   to the decision path of a phase that has already passed its own verification. It belongs in a
   Phase 9 remediation with its own report and its own verification pass, not folded into a
   readiness audit.
2. **N16's *benefit* cannot be measured here, and an unmeasurable improvement is exactly what
   this programme has been refusing to ship.** The quantity that matters — how far the filter
   reduces the shortlist — needs an operating index, a real Leg population and an
   `evaluateExact`. Implementing the filter now would produce a claim of improvement with no
   number behind it.
3. **N17 carries a real design question, not just a code change.** §6.6 requires agents within a
   cell ordered by `agent_id` for replay determinism. Truncating *by lower bound* means either
   retaining a best-`k` set under a canonical tie-break, or changing visit order — and the second
   would touch §6.6. Which of the two §9.4 intends is a Phase 9 design decision that should be
   recorded, not guessed at by an auditor.
4. **N18 is a correctness fix and deserves to be visible.** Folding it into an audit's diff is
   how a correctness change gets shipped without anyone reviewing it as one.

**N18 is nevertheless the one that carries a deadline.** It must be fixed **before** the
composition root lands, because from that moment every shadow decision record carries a search
gap that is not the bound §6.4 requires — and those records are the `shadow_agreement` evidence
and the §21.4 SLI at the same time. Fixing it afterwards means re-running a 14-day window.

---

## 24. Cache Contract Audit

`src/engine/routing/inProcessCache.js`, its 43 tests, and its measured behaviour, audited
against the frozen architecture. **The threshold was not changed. The architecture was not
changed to hit the number. No additional work was performed.**

### 24.1 Is the architecture correct?

**Yes, and for structural reasons rather than because it is fast.** Re-verified by reading the
module and its test suite, and by the full suite passing at 141 / 6 154 / 0.

| Property | Assessment |
|---|---|
| **The façade is kv-shaped** | The load-bearing choice. Both shipped caches already take their kv injected, so a façade satisfying the same `get`/`set` contract composes in front of them with **zero change to either** — and both are byte-identical. The §6.2 seam that has kept B1 from contaminating the engine stays exactly where it is |
| **Neither tier is an authority** (§3.3, I16) | L1 ⊆ L2 ⊆ recomputable. Every failure path degrades toward a **miss**, never toward an answer: an L2 read error is a miss and is not promoted; an L2 write failure leaves no L1 copy |
| **Versioning** | Three layers, and the first two are already the callers' own discipline: the key carries profile + time bucket + projection version (§20.3 items 2–3), so a version change is a *new key*; the required namespace carries config and map version, which the key cannot, because a cell id is *"an opaque token supplied by the published map"* |
| **Clock-free** (T6, §9.6) | `nowMs` is injected and a missing one **fails closed to a miss** rather than guessing an instant. A test greps the module for `Date.now`, `new Date`, `process.hrtime` and `Math.random` |
| **Bounded and deterministic** | `maxEntries` required with no default; LRU eviction from the store's own insertion order, so the same access sequence always evicts the same entry |
| **TTL discipline** | Effective lifetime is `min(tier TTL, caller's TTL)`, and the TTL is **never extended on read** — refresh-on-access would let the hottest cell pair outlive every congestion bucket |
| **Engine independence** | The module `require`s nothing, and a test asserts neither cache module mentions it |
| **Ownership** | Assigned to `PHASE_15_OWNED` with a stated reason: it ships no capability, issues no query, holds no adapter. `client.js` remains absent and remains Phase 8's |

**No defect was found in the tier.** It is correct, and it is correctly scoped.

### 24.2 Why the async path misses `< 10 µs`

**The residual is not the store, and it is not the tier.** Both are established by the shipped
measurements, and the second by two configurations with **no network in them at all**:

| Configuration | p99 | Against `perf.charger_reachability_cached_p99` = 10 µs |
|---|---:|---|
| A — in-memory kv, no L1 | 20.8 / 24.7 µs | OVER |
| B — in-memory kv + L1 | 22.2 / 25.6 µs | OVER |
| C — Redis (**the shipped configuration**) | 694.6 / 683.1 µs | OVER, 69× |
| D — Redis + L1 | 39.4 / 23.3 µs | OVER |
| **F — synchronous, pre-parsed** *(not the shipped contract)* | **2.10 µs** | **WITHIN** |

The cause is visible in `chargerReachabilityCache.read()` itself, read in full this pass: it is
`async`, it `await`s `deps.kv.get(...)`, and it then `JSON.parse`s the raw value and re-checks
the projection version. **Even on an L1 hit that is a microtask hop plus a parse of an ~828-byte
entry**, and the tier's own `get()` — measured at p50 0.60 µs, p99 1.7 µs — is not what the row
is spending. Row F prices the same tier through a synchronous pre-parsed read at p50 0.90 /
p99 2.10 µs, which is what establishes that 10 µs is reachable *in process* and only through a
change to the caches' **value contract**.

### 24.3 Whose decision the synchronous/pre-parsed contract is — and it is stronger than Phase 8

`src/engine/ARCHITECTURE.md:90` maps the §3.2 Routing Service — `client.js`, `cellPairCache.js`,
`chargerReachabilityCache.js` — to **Phase 8**. So the contract change is Phase 8's.

**And it is more constrained than that (N20).** `guards/tierAssertions.js:540` registers
`src/engine/routing/chargerReachabilityCache.js` as `TIER.SAFETY_CORE` — **Tier 0**. Changing the
value contract of a Tier 0 module carries §1.8's Tier 0 discipline, not merely Phase 8 ownership.
That is a materially higher bar than "a Phase 8 refactor", and it is the reason the earlier pass
was right to price the change rather than make it.

### 24.4 Can the tier remain as the current prerequisite?

**Yes, unchanged.** It closes the prerequisite it was built for and nothing more:

- it is engine-independent and depends on no open decision;
- it **changes where a read is served from, never what it answers** — a test drives the B1
  workload with and without the tier and asserts identical amortisation and identical hit rates;
- it removed 97.6 % of cross-round-tier reads and improved the shipped configuration 12.8×–14.3×;
- its two policy values (`maxEntries`, `ttlMs`) are **required constructor arguments that throw
  when absent**, so no unowned, uncalibrated constant entered the register ahead of the
  composition root that will own them. That is §22.1 rule 1 satisfied by construction.

### 24.5 Is additional work authorized now?

**No.** Recorded as a disposition, not as a preference:

| Candidate | Authorized? | Why |
|---|---|---|
| Change `perf.charger_reachability_cached_p99` | **NO, and it was not** | It is a §20.1 STRUCTURAL target. Moving a threshold to meet it is the one thing this record exists to prevent |
| Change the tier's architecture to hit the number | **NO, and it was not** | The tier is not what is spending the budget. §24.2 |
| Make the caches' read synchronous and pre-parsed | **NO** | Phase 8, **and Tier 0** (§24.3). Requires an ADR and Tier 0 review, and it should be decided deliberately rather than discovered during an engine benchmark |
| Register `route.l1_max_entries` / `route.l1_ttl` | **NO** | §22.1 requires an owner, and no module reads them. The policy lives at the composition root, which does not exist |
| Wire the `Counters` into the caches | **NO** | Needs the composition root. §23.6 |

**The cache prerequisite is ADDRESSED and NOT CLOSED, and the improvement is explicitly not a
reason to call B1 ready.**

---

## 25. §20.1 Budget Interpretation

**The brief asked whether the frozen architecture already resolves the relationship between the
per-candidate budgets, the 100 000 evaluations, the ~200 000 routing reads, and the 250 ms round.
It does not. The exact open question is stated below, and no interpretation was invented.**

### 25.1 The arithmetic, from registered values only

Every value resolved live from the register this pass; every multiplier is §9.4's own cap or
§20.3's own batching rule.

| §20.1 row | Registered parameter | Value | Per-round multiplier | Per-round total | vs 250 ms |
|---|---|---:|---|---:|---:|
| Candidate generation per Leg | `perf.candidate_generation_per_leg_p99` | 5 ms | × 500 Legs (`solve.max_legs_per_round`) | 2 500 ms | **10×** |
| Feasibility per candidate, cached | `perf.feasibility_per_candidate_cached_p99` | 50 µs | × 100 000 | 5 000 ms | **20×** |
| Cost per candidate, routing cached | `perf.cost_per_candidate_p99` | 100 µs | × 100 000 | 10 000 ms | **40×** |
| Approach matrix, 200 × 1, cached | `perf.approach_routing_matrix_p99` | 20 ms | × 25 clusters (§20.3 item 4) | 500 ms | **2×** |
| Return-leg lookup, cached | `perf.charger_reachability_cached_p99` | 10 µs | × 100 000 (§20.1: ≤ `m · k`) | 1 000 ms | **4×** |
| Solve, anytime ceiling | `solve.time_budget` (§9.4) | 250 ms | × 1 | 250 ms | **1.0×** |
| **Round wall clock** | `perf.round_wall_clock_p99` | **250 ms** | — | — | — |

Every `perf.*` row above is `specScope: "shard"`, `changeClass: "STRUCTURAL"`,
`calibrationStatus: "DERIVED"`, `requiredBy: "observability/sli.js — the §20.1 release-gate
targets"` — verified by reading the register entries.

**Two observations neither the routing-prerequisite report nor any earlier document records:**

- **The inconsistency is not confined to routing.** It appears on candidate generation and
  feasibility identically. It is a §20.1 question, not a B1 question, and it is answerable
  **now** — with no engine, no region, and no fleet.
- **`solve.time_budget` (250 ms, §9.4) equals `perf.round_wall_clock_p99` (250 ms, §20.1)
  exactly.** As registered, the solve's anytime ceiling alone consumes the entire round budget
  before candidate generation, feasibility, routing, pricing or commit is counted. The two can
  coexist — one is a worst-case ceiling, the other a p99 target — but **the architecture nowhere
  states their relationship**, and a release gate cannot be discharged against two numbers whose
  relationship is unstated.

### 25.2 Does the frozen architecture resolve it? No

Searched, and each candidate resolution checked against the text:

| Where a resolution might live | What it actually says |
|---|---|
| §20.1's preamble | *"Targets are stated per shard, at the 99th percentile, under nominal (non-degraded) operation. They are requirements for the release gate, not aspirations."* States the **statistic** and the **scope**. States **no aggregation rule** |
| §20.1's per-row rationales | The feasibility row's rationale is *"100 000 evaluations per round must be affordable"* — which asserts the aggregate matters and still supplies no rule for computing it |
| §20.2 Complexity | Gives asymptotic complexity per stage. No constants, no budgets |
| §20.4 Batching and amortisation | *"larger batches share candidate sets, share routing matrices … and amortise fixed round costs."* Amortisation of *fixed* costs, not composition of per-unit budgets |
| §9.4 Solve size control | Gives `solve.time_budget` = 250 ms as an anytime ceiling. Says nothing about §20.1's round target |
| Intra-round concurrency | **Stated nowhere.** The document's uses of "parallel" and "concurrent" are about shards operating independently (§19.2), concurrent commitments on one agent (§2.6, §10.3), and concurrent rounds over disjoint snapshots (§10.3) — never about stages within one round |
| `observability/sli.js` | `attainment()` compares an observed statistic against its target and returns `meets: null` when unobserved. It implements no aggregation and asserts none |

**Conclusion: the frozen architecture does not resolve it, and there is no section to cite.** The
routing-prerequisite report's §12.5 item 3 offered a charitable reading — that the per-unit rows
are p99 ceilings on a single unit while the round budget is against the aggregate mean, with
intra-round parallelism — and was correct to label it *"the charitable and probably intended
reading"* rather than a finding. **This audit does not adopt it, because adopting it would be
inventing the answer to the question.**

### 25.3 The exact question requiring an ADR — Q-20.1

> **Q-20.1 — §20.1 budget composition.**
>
> **(a)** For each per-unit row of §20.1, what is its relationship to
> `perf.round_wall_clock_p99`? Specifically, is the row a p99 ceiling on a *single* unit's
> latency, with the round budget governing the aggregate — and if so, **which statistic of the
> per-unit distribution does the round budget consume** (mean × count, p99 × count, or the
> measured wall clock of the stage as a whole)?
>
> **(b)** What intra-round concurrency, if any, does §20.1 assume? The document states none, and
> the arithmetic in §25.1 above closes only if some is assumed.
>
> **(c)** What is the intended relation between `solve.time_budget` (250 ms, §9.4) and
> `perf.round_wall_clock_p99` (250 ms, §20.1), given that as registered the solve's anytime
> ceiling alone exhausts the round budget?
>
> **(d)** Which of these rows are release-gate requirements in their own right and which are
> diagnostic sub-budgets? §20.1's preamble says *"requirements for the release gate"* of all of
> them, and `cutover/gates.js` carries **one** `scale_targets` row.

**Why it must be answered before B1's benchmark, not after.** `scale_targets` is currently RED
against a target whose arithmetic is undefined. A benchmark built on the aggregate reading gates
every candidate engine on a number no engine can reach; one built on the single-unit reading
gates on nothing at all. The B1 evidence procedure already resolves its thresholds from the
register through `observability/sli.js`, so the moment Q-20.1 is answered the procedure inherits
the answer — and until it is answered, the procedure is measuring against rows whose composition
is unstated.

**Owner: Architecture. No B1 dependency. No engine, region or fleet required. Answerable on the
same day as D1, by a different person.**

---

## 26. Calibration and Worker Dependency Maps

### 26.1 The 39, regrouped by what blocks each at the earliest

§7 classifies the 39 by *what each needs*. This is the orthogonal view the dependency plan
requires: *what each sits behind*. **No parameter was derived, edited, reclassified or modified,
and `sim.max_optimistic_bias` was not touched.** Numbering follows §7's table.

| Blocked behind | # | Parameters (§7 numbering) |
|---|---:|---|
| **Routing (B1)** | **2** | #31 `route.degraded_max_radius`, #32 `route.degraded_reserve_factor` |
| Region configuration (D1/D8, via B6) | 2 | #25 `map.obstruction_class_max_age`; #24 `localisation.min_confidence` (per-environment field trials need a declared operating environment) |
| Fleet/mobility model (D3) — per-class vendor or bench data | 5 | #12 `energy.f_derate`, #16 `energy.reserve_floor_wh`, #23 `localisation.max_odometry_divergence`, #29 `payload.mass_discrepancy_tolerance_kg`, #30 `payload.safety_factor` |
| Other §6.1 decisions (B2, B3) | 3 | #8, #9 (B2 — Charging Scheduler); #38 (B3 — consensus store) |
| Shadow observation | 2 | #18 `feasibility.systemic_indeterminacy_threshold`, #36 `security.implausible_report_quarantine_threshold` |
| Production/fleet-operation evidence | 3 | #10, #15, #35 (all downstream of #15, the highest fabrication risk in the register) |
| Accountable or Safety decision, no technical prerequisite | 11 | #1, #4, #5, #6, #11, #14, #19, #26, #27, #28, #39 |
| Fleet telemetry / CA / ops records — measurement, no decision gate | 9 | #2, #3, #7, #13, #17, #20, #33, #34, #37 |
| Retirement, must not be re-derived | 2 | #21, #22 |
| **Total** | **39** | |

**The load-bearing conclusion: 2 of the 39 are behind B1 and 37 are not.** Several rows have more
than one dependency and are listed under the earliest. Three of the buckets — the 11 accountable
decisions, the 9 measurements, and the 2 retirements, **22 parameters, 56 % of the gate** — have
no dependency on B1, on a region, or on an engine. They are behind **B8** alone: naming the
calibration owner. That is why §27 puts B8 on the critical path *beside* D1 rather than after it.

**Three long-lead items inside the 11 should start first** and are named again here because their
lead time is external: #26 `ops.emergency_services_hazard_threshold`, #27
`ops.external_escalation_contacts` and #28 `ops.stranded_obstructing_response_target` each
require agreement with local emergency services, the responsible infrastructure operator, or the
highway/site authority.

### 26.2 Worker and composition-root dependencies

Re-derived from `src/workers/registry.js` and `server.js` this pass.

| | |
|---|---|
| Registry rows | **18** — 8 `SCHEDULED`, 4 `LEADER_ONLY`, 6 `DEFERRED`. They partition it exactly |
| Started by this process at boot | `invariant`, `tier_b`, `rejection_aggregation`, `calibration`, `counterfactual`, `cutover` — via `startScheduledWorkers()` |
| Deliberately **not** started | The `LEADER_ONLY` four (`coordinator`, `outbox`, `reconciler`, `timer`), stated at `server.js:52`; and `shadow`, which appears in neither `scheduledAtBoot()` nor `scheduledOnLeadership()` and is not referenced by `server.js` |
| Cadence keys absent from the register | **11**, of which 5 belong to workers this process schedules (§8's correction) |

**Which dependencies are genuinely critical-path:**

| Dependency | Critical-path? | Why |
|---|---|---|
| **The shared composition root** (`round`, `expandCandidates`, `pricedCandidateFor`, `budgetsFor`, `deferPriceFor`) | **YES — the single largest one** | Both `shadow.worker` and `coordinator.worker` need the same five. `expandCandidates` needs `evaluateExact`, which needs travel times for both §20.3 populations, which need an engine. It is therefore **behind B1**, and behind it in turn sit `shadow_agreement`'s 14-day window and `invariants_enforced`'s live deciding shard |
| **N18's fix** (§23.5) | **YES, and earlier than the composition root** | Every decision record the composition root produces carries the search gap. Fixing it after shadow starts means re-running 14 days |
| Registering the 11 cadence parameters | **YES for Phase 15's own checklist**, and **NOT behind B1** | The checklist item is *"All engine workers move from shadow to production scheduling."* A scheduler needs an interval and §22.1 admits no bare behavioural constant for one. Blocked only on **naming an owner per parameter** (§22.1's `owner` field) — the smallest external input on the whole board |
| `charger_reachability` worker → `SCHEDULED` | Behind B1 | `DEFERRED` for want of a routing client this process does not construct |
| `capacity_pricing` worker | **NOT behind B1** | `DEFERRED` because it is Tier 2 and `killswitch.opportunity_cost_term` is thrown at launch. Correct as it stands |
| `index_maintainer`, `energy_calibration`, `service_time_model` | **NOT behind B1** | Each `DEFERRED` for its own stated reason — missing classifiers, missing realised-outcome rows, missing per-site models |

**No composition root was built, no stub was written, no worker was moved from `DEFERRED`, and
the 14-day window was not started.** Building a stub `evaluateExact` would produce exactly what
`registry.js`'s own header calls the worst of the three possible states: *"a worker that runs,
reports success, and computes nothing."*

---

## 27. Current Pre-B1 Readiness Assessment

### A. Closed

Genuinely closed, each re-verified against the current working tree rather than quoted.

| # | Item | Evidence |
|---|---|---|
| A1 | **Decision D2 — H3 FINE/COARSE resolution.** Corrected from MISSING to DECIDED | `spatial/cells.js:181–183`; §21.2 C1. Residual is a per-region check behind D1 |
| A2 | **The Phase 16 ownership guard**, file-by-file across `solve/`, `lifecycle/`, `shard/`, `security/`, `cutover/`, with a planted-violation proof and a negative control | `phase0Scaffold.test.js`; `src/engine/fairness/` holds only `.gitkeep` |
| A3 | **The solver report-precision contradiction**, root-caused to the measurement harness, with a four-class taxonomy preventing recurrence | §4 |
| A4 | **The B1 evidence procedure** — attributed per row, incapable of producing a false `PASS` or a false `EXCEEDED`; re-run this pass, `NOT_MEASURED` on all six rows, exit 0 | `npm run routing:b1` |
| A5 | **The in-process routing cache tier's architecture** — correct, engine-independent, changes no answer, composes with both shipped caches unchanged | §24.1; 43 tests inside the passing suite |
| A6 | **The soak evidence collector, worker-registry discipline tests, and calibration-disposition guards** | §5, §8, §10 |
| A7 | **The regression baseline reproduced exactly**: 141 suites, 6 154 tests, 0 failures; all four build gates PASS | §28.1 |

**A5 is closed as a *prerequisite* and explicitly not as a §20.1 row.** The `< 10 µs` target is
still unmet by every shipped configuration.

### B. Safe to Implement Now

**Nothing in the production decision path. This is the finding, not an omission.**

Every candidate the brief named was inspected and each is blocked. Recorded so the analysis is
not repeated:

| Candidate | Verdict | Reason |
|---|---|---|
| §6.4 per-candidate pruning (N16) | **BLOCKED** | Phase 9-owned decision-path behaviour; its benefit is unmeasurable without a fleet (§23.7) |
| §9.4 truncate-by-lower-bound (N17) | **BLOCKED** | Phase 9-owned, and carries a §6.6 ordering design decision that is not an auditor's to take |
| Search-gap arithmetic (N18) | **BLOCKED for this pass, and deadlined** | Phase 9 correctness fix; must land before the composition root, with its own verification |
| Routing-read instrumentation | **BLOCKED** | The `Counters` exist; wiring them needs the composition root, which needs B1 |
| Cache measurement | **BLOCKED — and already done to its limit** | Two independent 5-run measurements exist; the residual is a contract decision, not a measurement |
| Cache contract (synchronous, pre-parsed) | **BLOCKED** | Phase 8 **and Tier 0** (N20, §24.3) |
| Configuration schemas (`regions[].boundary`, mass/CoG, domain composition) | **BLOCKED** | D1, D6, D7. §22.1 rule 5 refuses a schema admitting an unreviewed shape |
| Mobility-model validation strengthening | **BLOCKED** | D3. `validateModel()`'s permissiveness is deliberate — *"an absent element is a gap, not a permissive default"* |
| Composition-root preparation | **BLOCKED** | B1, and a stub is the one thing `registry.js` names as worse than nothing |
| Routing dependency interfaces (`client.js`) | **BLOCKED** | B1, plus three unregistered parameters one of which is Safety-class |
| Worker dependency analysis | **DONE, not implemented** | §26.2 |

**Two items become safe the moment a one-line external answer arrives**, and both are recorded in
C rather than here because neither is actionable today:

- **B-pending-1.** Register and wire the 11 worker cadence parameters. Needs only an **owner per
  parameter** (§22.1). Values exist as `@structural` constants in each worker, so nothing is
  invented; the entries are TUNED/STRUCTURAL, not Safety-class, so `gate:calibration` would not
  move from 39.
- **B-pending-2.** Reclassify or split the `locality` gate row (Ph15 F4). Needs an evidence-class
  decision from SRE/Architecture. **It is the only finding that could let a gate close on
  evidence that does not support it, and it has no B1 dependency.**

### C. External Decisions Required

| # | Decision | Owner | Blocks | B1-dependent? |
|---|---|---|---|---|
| C1 | **D1 — target region(s) and bounding geometry** | Operations + Commercial | **All of B1, and everything behind it** | — |
| C2 | **B8 — name the calibration owner** | Executive | 37 of the 39 calibration parameters | **No** |
| C3 | **Q-20.1 — §20.1 budget composition** (§25.3) | Architecture | `scale_targets`' target being arithmetically defined | **No** |
| C4 | **D3 — fleet agent classes and mobility models** | Product + Fleet Engineering | The profile set; the hierarchy count; 5 calibration parameters | No |
| C5 | **D4 — B1's traversal-domain scope** | Architecture | Which engines are candidates at all | No |
| C6 | **D5 — regions/shards and mission rate `r`** | Operations | §3.5 sizing; the hierarchy multiplier | No |
| C7 | **D6 — where mass and CoG are declared** | Architecture + Fleet Engineering | The `:loaded` profile's meaning | No |
| C8 | **D7 — `traversalDomain` as a composition** | Architecture | Multi-modal profiles; the `unknown:unknown:*` aliasing fix | Behind D4 |
| C9 | **D8 — extract vintage, refresh, re-contraction** | Operations | §5.2 availability; interacts with B6 | No |
| C10 | **Owners for the 11 worker cadence parameters** | Eng management | Phase 15's own "workers move to production scheduling" checklist item | **No** |
| C11 | **`locality` gate evidence class** | SRE + Architecture | The one gate that could close on unsupporting evidence | **No** |
| C12 | **Authorise a Phase 9 defect pass for N16/N17/N18** | Eng management | The routing read count; the integrity of every future decision record | **No** |
| C13 | **The Phase 8 / Tier 0 cache-contract decision** | Architecture (Tier 0 review) | §20.1's `< 10 µs` row | No — but should follow B1's ADR |
| C14 | **Rollback rehearsal authorisation, and confirmation that a pre-Phase-15 artefact is still retained** | SRE + Release | `rollback_rehearsed` | **No — and time-sensitive** |
| C15 | **Register and derive the §26 invariant-observation window** | SRE + Safety | `invariants_enforced`'s completion criterion E2 | **No** |
| C16 | **B2, B3, B6** — the other unresolved §6.1 decisions | Various | 4 calibration parameters | No |

**Eleven of the sixteen have no B1 dependency.** The programme has been treating B1 as the single
gate; it is the largest, and it is not the only thing that can move.

### D. Evidence Required

Unchanged from §18, which remains the executable procedure for each. Revision 2 adds three:

| # | Evidence | Needs |
|---|---|---|
| D-a | **The LB-survivor distribution** — how far §6.4 pruning actually reduces the shortlist | An operating Availability Index with real agents, a real Leg population, and an `evaluateExact`. The instrument exists (`GET /api/diagnostics/candidates/:legId`, plus `agentsEvaluated`/`cellsExplored` in the Tier A record); the population does not |
| D-b | **Routing reads per candidate, per population, in production** | The composition root, plus the `Counters` wired into both caches |
| D-c | **Engine determinism** — identical queries returning identical times, or §9.6 replay breaks | A deployed engine. No row in the current B1 tool covers it |

### E. Blocked by B1

Stated precisely, because three gates are frequently mislabelled as B1-blocked and one of them is
not.

| Item | Behind B1? | Note |
|---|---|---|
| `src/engine/routing/client.js` and §5.2's ladder, timeouts and §18.3 B6 uniform treatment | **Yes** | Plus three unregistered parameters, one Safety-class |
| `route.degraded_max_radius`, `route.degraded_reserve_factor` | **Yes** | Both `awaits` require an engine to compare a straight line against |
| The shared composition root (shadow **and** coordinator) | **Yes** | §26.2 |
| `charger_reachability` worker | **Yes** | |
| `scale_targets` | **Yes** — and also behind N16 and Q-20.1 | Three independent causes, only one of which is B1 |
| `shadow_agreement` | **Yes**, via the composition root | And gated additionally on N18 landing first |
| `invariants_enforced` | **Yes**, indirectly | Needs a live deciding shard, hence the coordinator composition root |
| `soak` | **Indirectly** | Needs the shipping artefact and a staging environment; the round loop is behind the composition root |
| `simulator_fidelity` | **NO — commonly mislabelled** | It needs the fleet demand generator, realised per-slice production data, and `sim.max_optimistic_bias` re-derived as a decision. The generator is not behind B1 |
| `rollback_rehearsed` | **NO** | Depends on nothing else. The earliest gate that can close |
| `locality` reclassification | **NO** | Only its cross-scale staging benchmark is |
| 37 of the 39 calibration parameters | **NO** | §26.1 |

### F. Parallel Phase 15 Work

Work with no B1 dependency, recorded here as the dependency plan requires. **None of it was
performed by this pass; each is an external action or is owned elsewhere.**

| # | Work | Owner | Note |
|---|---|---|---|
| F1 | **Name the calibration owner (B8)** and begin the 22 parameters behind nothing else | Executive → calibration owner | A decision, not a project. Start #26/#27/#28 first — external-authority lead time |
| F2 | **Rehearse the rollback in staging**, all six `rollback.md` §5 steps including step 4 | SRE + Release | *"Step 4 is the one that will be skipped and it is the one that matters."* Confirm artefact retention **first**, before it ages out |
| F3 | **Answer Q-20.1** (§25.3) | Architecture | No engine, region or fleet required |
| F4 | **Resolve the `locality` gate's evidence class** | SRE + Architecture | The only finding that could let a gate close on evidence that does not support it |
| F5 | **Register and derive the §26 invariant-observation window** | SRE + Safety | Must be closed **before** the cutover, not during it |
| F6 | **Assign owners for, then register and wire, the 11 worker cadence parameters** | Eng management → Eng | Phase 15's own checklist item. `gate:calibration` would not move from 39 |
| F7 | **Authorise and run a Phase 9 defect pass for N16/N17/N18** | Eng management → Phase 9 | N18 is deadlined by the composition root |
| F8 | **Decide Ph14 F2** — `surrogateKeys` written by no engine code path | Phase 14 owner | Thread the lookup, or reword the checklist disposition. Before cutover |
| F9 | **Fix the ~1-in-256 flaky `privacySurrogateKeys.test.js`** | Phase 14 owner — `privacy/{surrogateKeys,identityStore,erasure}.js` are `PHASE_14_OWNED`, and `ARCHITECTURE.md:118` maps the surrogate identity store to phase 14 | One line; the mechanism (a tamper that is a no-op when the final ciphertext byte is already `0xff`) and the fix are both recorded in the B1 report §16 |
| F10 | **Build the fleet demand generator** (Phase 15 checklist item 5, PARTIAL) | Phase 15 | Authorized by the checklist and not behind B1 — but spatially correlated demand needs D1's region and D3's classes to be *meaningful*, so it is partly behind those |

### G. Dependency-Ordered Next Steps

```
DAY 0 — five external answers, five different people, no engineering, no procurement
  ├─ D1  target region + bounding geometry ........................ Operations + Commercial
  ├─ B8  name the calibration owner ............................... Executive
  ├─ Q-20.1  §20.1 budget composition ADR ......................... Architecture
  ├─ D3 + D4  fleet classes, mobility models, domain scope ........ Product + Architecture
  └─ C10/C11/C14/C15  cadence owners · locality class ·
                       artefact retention · observation window .... Eng mgmt + SRE + Safety
        │
        ├──────────────────────────────► PARALLEL, starts Day 0, never blocks
        │                                 F1 (22 calibration params) · F2 (rollback rehearsal)
        │                                 F7 (Phase 9 defect pass) · F8 · F9
        ▼
STAGE 1 — repository work, each unblocked by exactly one Day-0 answer
  ├─ D6/D7 schema decisions ─► the MobilityModel schema change
  ├─ register + wire the 11 cadence parameters                (needs C10)
  ├─ Phase 9 remediation of N16 / N17 / N18                   (needs C12; N18 is deadlined)
  └─ D2 residual: validate res 8/5 against D1's density       (needs D1)
        ▼
STAGE 2 — infrastructure, first thing that needs money or hardware
  ├─ publish the spatial map and the shard definitions        (needs D1, D5)
  ├─ cut the region extract                                   (needs D1, D8)
  └─ build per-profile contraction hierarchies per candidate  (needs D3's speed models)
        ▼
STAGE 3 — B1 deployment ──► B1 benchmark ──► B1 verification ──► the ADR
        ▼
STAGE 4 — Phase 8: routing/client.js + §5.2 timeouts + the ladder + §18.3 B6
          register route.matrix_timeout, route.path_timeout, the detour factor (§22.3, 2-person)
          the Tier 0 cache-contract decision (C13)
        ▼
STAGE 5 — route.degraded_max_radius + route.degraded_reserve_factor, from measured
          straight-line-versus-network error distributions per region
        ▼
STAGE 6 — the shared composition root (shadow AND coordinator, built once)
        ▼
STAGE 7 — shadow → the 14-day cutover.shadow_agreement_window  ← longest wall-clock item
        ▼
STAGE 8 — remaining Phase 15 evidence: scale_targets · soak · simulator_fidelity ·
          invariants_enforced · locality cross-scale benchmark
        ▼
STAGE 9 — final Phase 15 verification: all 23 gates, all 5 entry conditions
        ▼
PHASE 16 — not before Stage 9 closes
```

**The critical path runs D1 → extract → hierarchies → B1 → client.js → composition root →
14-day shadow.** Everything in the parallel track is off it, and the 14-day window is the longest
irreducible wall-clock item — which is why it sits *behind* the longest-lead procurement decision
rather than beside it, and why D1 is the single most valuable hour anyone can spend on this
programme.

---

## 28. Verification and Change Control — Revision 2

### 28.1 Verification performed

All figures from this pass's own runs on the current working tree.

| Check | Result |
|---|---|
| `npm run gate:tiers` | **PASS** — 275 modules, 376 governed edges, no Tier 0/1 → Tier 2 |
| `npm run gate:params` | **PASS** — 181 engine modules, 242 registered parameters, 0 bare constants |
| `npm run gate:tenets` | **PASS** — 272 modules, 0 violations |
| `npm run gate:legacy` | **PASS** — 4 retired modules absent, 290 files scanned |
| `npm run gate:calibration` | **FAIL — 39 blocking findings**; 242 entries, 52 DERIVED / 152 PROVISIONAL / 38 UNCALIBRATED, 54 Safety-class. **Correct and unchanged** |
| `npm run routing:b1` | 6 rows `NOT_MEASURED`, exit 0 — correct, no engine supplied, no claim made |
| **`npm test -- --runInBand --forceExit`** | **PASS — 141 suites, 6 154 tests, 0 failures, 183.5 s** |

**The regression figure is byte-for-byte the baseline** the routing-prerequisite pass recorded
(141 / 6 154 / 0). The B1 benchmark tests, the routing-cache tests, the parameter gate, the
tenets gate and the legacy gate are all inside that run and all pass. **No test was weakened,
skipped, deleted, or had a threshold relaxed — none was touched at all.**

The known ~1-in-256 flake in `privacySurrogateKeys.test.js` did not fire.

### 28.2 The diagnostic probe, disclosed in full

§23.3 and §23.5 rest on execution, and the code that executed is disclosed rather than
summarised. It is a two-test Jest file written to the session scratchpad —
**outside the repository** — and run with an explicit `--rootDir` and an inline config so it
joins no Jest project and enters no regression count:

```
npx jest --rootDir <scratchpad> --config '{"testEnvironment":"node","testMatch":["**/pruneProbe.test.js"]}'
```

It imports the **real** `candidates/expansion.js`, the **real** `candidates/availabilityIndex.js`,
the **real** `spatial/cells.js` and the repository's own `tests/engine/helpers/candidateFixture`.
It modifies nothing, writes nothing to the repository, and its results are reported above with
their raw output. **It is a diagnostic measurement and it is not evidence for any gate.**

### 28.3 Change control

Captured before the first edit and again at the end, and compared rather than eyeballed.

```
BEFORE   git status --porcelain | wc -l   →  375
         git diff --stat                  →  59 files changed, 11613 (+), 1593 (−)

AFTER    git status --porcelain | wc -l   →  375                                   (unchanged)
         git diff --stat                  →  59 files changed, 11613 (+), 1593 (−)  (unchanged)
```

**Both figures are unchanged, and each proves a different thing.**

- **`git diff --stat` is byte-for-byte identical**, which proves **no tracked file was modified
  by revision 2 at all** — not one line, anywhere in the repository.
- **The porcelain count did not move** because the only file written, this document, was
  **already untracked** before this pass began: revision 1 created it and no commit was made, so
  it was already one of the 375 entries. A new file would have made it 376.

**Exactly one file was written by revision 2: `PHASE_15_CONSOLIDATED_REMEDIATION_REPORT.md` —
this document.** No new report was created, and the three routing documents were read and
reconciled but not edited; where one of them is corrected, the correction lives here (§21.2), in
the single living record, with the previous finding preserved beside it.

**One caveat, stated so the record is not read as stronger than it is.** `git status` does report
modifications under `Backend/src/` — 59 tracked files in total. Those are the **pre-existing
uncommitted Phases 6–15 working tree**, present before this pass began, and the identical
`git diff --stat` above is the proof that revision 2 contributed none of them.

Verified, mechanically rather than asserted:

- **No source file was changed by this pass.** The unchanged `git diff --stat` establishes it for
  every tracked file, including all seven `src/engine/solve/*.js` — **no solver change**.
- **No calibration change.** No file under `src/engine/config/register/` was modified;
  `gate:calibration` re-run after the edit reports the same **39** against the same **242**
  entries, with the same 52 / 152 / 38 split and the same 54 Safety-class.
- **No threshold change.** Every `perf.*`, `route.*`, `solve.*` and `candidate.*` value resolves
  to exactly what §2 and the routing-prerequisite report's §2 recorded.
- **No gate bypassed or waived.** All four build gates run and pass; `gate:calibration` still
  fails at 39 and was not silenced.
- **No test weakened, added, or removed.** 141 / 6 154 / 0, identical to the baseline.
- **No Phase 16 implementation.** `src/engine/fairness/` still holds only `.gitkeep`.
- **No routing engine installed, no adapter written, no engine response faked, no benchmark
  number fabricated.**
- **No production configuration published, no region invented, no mobility model created, no
  fleet parameter invented, no shadow started, no worker moved from `DEFERRED`.**
- **No commit was created.**

---

## 29. Final Status — Revision 2

```
CURRENT STATUS:
B1:       STILL BLOCKED
PHASE 15: STILL BLOCKED
PHASE 16: NOT READY
```

**NEXT ACTION:**

> **Answer D1 — declare the target OperatingRegion(s) and, for each, a bounding geometry as a
> GeoJSON polygon or a bounding box with its CRS.** It needs no vendor, no hardware and no
> budget; it is one question to Operations; and **every other item in B1 is behind it.** No
> extract can be named for an undeclared region, and no contraction hierarchy can be built over
> an extract that does not exist.

**EXTERNAL DECISIONS REQUIRED:**

1. **D1** — target region(s) and bounding geometry *(Operations + Commercial)* — **binding**
2. **B8** — name the calibration owner *(Executive)* — gates 37 of the 39
3. **Q-20.1** — §20.1 budget composition, §25.3 *(Architecture)* — no B1 dependency
4. **D3** — fleet agent classes and mobility models with real speed models *(Product + Fleet Eng)*
5. **D4** — B1's traversal-domain scope *(Architecture, against the modality roadmap)*
6. **D5** — regions/shards at launch and each region's mission rate `r` *(Operations)*
7. **D6** — where agent mass and centre of gravity are declared *(Architecture + Fleet Eng)*
8. **D7** — whether `traversalDomain` becomes a composition *(Architecture, behind D4)*
9. **D8** — extract vintage, refresh cadence, re-contraction window *(Operations)*
10. **Owners for the 11 worker cadence parameters** *(Eng management)*
11. **The `locality` gate's evidence class** *(SRE + Architecture)*
12. **Authorisation of a Phase 9 defect pass** for N16/N17/N18 *(Eng management)*
13. **The Phase 8 / Tier 0 routing-cache contract decision** *(Architecture, Tier 0 review)*
14. **Rollback rehearsal authorisation, and confirmation a pre-Phase-15 artefact is retained**
    *(SRE + Release)* — **time-sensitive**
15. **Registration and derivation of the §26 invariant-observation window** *(SRE + Safety)*
16. **B2, B3, B6** — the remaining §6.1 decisions *(various)*

**SAFE REPOSITORY WORK:**

**None today, in the production decision path or anywhere else.** Every candidate was inspected
and each is blocked by a decision, by evidence, or by phase ownership (§27 B). Two items become
safe the moment a single external answer arrives, and neither is actionable before then:

- register and wire the **11 worker cadence parameters** — needs only an owner per parameter;
- **reclassify or split the `locality` gate row** — needs an evidence-class decision.

**BLOCKED WORK:**

- `src/engine/routing/client.js`, §5.2's two hard timeouts, the degradation ladder, and §18.3
  B6's uniform-treatment rule — **B1**
- Registration of `route.matrix_timeout`, `route.path_timeout` and the **detour factor** (§22.3
  two-person Safety approval) — **B1 + an owner**
- `route.degraded_max_radius`, `route.degraded_reserve_factor` — **B1**
- The shared composition root, for **both** shadow and the production coordinator — **B1**
- The `charger_reachability` worker — **B1**
- §6.4's per-candidate lower-bound filter (**N16**), §9.4's truncate-by-lower-bound (**N17**) and
  the search-gap arithmetic (**N18**) — **Phase 9 ownership + authorisation**; N18 is deadlined
  by the composition root
- The synchronous, pre-parsed routing-cache read contract — **Phase 8 and Tier 0**
- `regions[].boundary`, mass/CoG, and the traversal-domain composition schemas — **D1, D6, D7**
- Publishing a spatial map or shard definitions — **D1, D5**
- Declaring any mobility model — **D3**, and §25.4's commissioning gate
- `scale_targets`, `shadow_agreement`, `invariants_enforced`, `soak` — **B1**, directly or
  through the composition root
- 2 of the 39 calibration parameters — **B1**

**PARALLEL WORK:**

- **B8 and the 22 calibration parameters behind nothing else** — start #26/#27/#28 first,
  longest external lead time
- **The rollback rehearsal in staging**, all six steps including step 4 — the earliest gate that
  can close, and confirm artefact retention before it ages out
- **Q-20.1**, the §20.1 budget-composition ADR — no engine, region or fleet required
- **The `locality` evidence-class decision** — the only finding that could let a gate close on
  evidence that does not support it
- **The §26 invariant-observation window** — register and derive before the cutover, not during it
- **The Phase 9 defect pass** for N16/N17/N18
- **Ph14 F2** (`surrogateKeys` written by no engine code path) and the one-line
  `privacySurrogateKeys.test.js` flake fix — both **Phase 14's**
- **The fleet demand generator** — authorized by Phase 15's checklist and not behind B1, though
  spatially correlated demand needs D1 and D3 to be meaningful

---

**Do not scope further solver work.** Unchanged across four documents and reinforced by this
audit: routing is still the dominant term, still unmeasured, and now known to carry **three**
engine-independent problems of its own — the cache read contract, the read *count*, and the fact
that its budget does not compose.

**An honest blocker is preferable to an invented configuration, and the strongest result
available from this repository was to establish exactly which blockers are real, which are
external, which have no B1 dependency at all, and what the single next legitimate action is.**

---

*End of Phase 15 Consolidated Remediation Report, revision 2. No new report was created. No
repository file was changed. No commit was created.*

---

## 30. D1 Decision Readiness

**Purpose of this pass.** §27 G names D1 as the single most valuable hour anyone can spend on this
programme, and §29 makes it the next action. It has not been answered. This section does not answer
it either — **no region was chosen, no bounding box invented, no coordinates fabricated, no extract
cut, no routing engine installed, no solver touched, no calibration value changed.** It establishes
exactly what the system owner must supply, what engineering derives afterwards, and what the
publish path must reject, so that D1 becomes a one-sitting decision rather than a research project.

Every claim below was verified against the working tree by reading the module or executing it.
Where a prior document is refined, the previous statement, the new evidence and the reason are
recorded together, per this document's revision discipline.

---

### 30.1 D1 Contract

#### 30.1.1 The trace: every D1 consumer in the system

Traced from configuration outward. The column that matters is the third: **what each consumer
actually reads.**

| # | Consumer | Module / evidence | D1 input it actually requires | Geometry? | CRS | Frozen/versioned? |
|---|---|---|---|---|---|---|
| 1 | **Region record (durable)** | `prisma/schema.prisma:807–832` — `model Region` carries `regionId`, `name`, `description` and relations, **and no boundary, bbox, polygon, CRS or geometry column of any kind** | A stable `regionId` and a human name | **No** | n/a | Yes — durable mirror |
| 2 | **Published spatial map** | `spatial/hierarchy.js:328–347` `toConfigPayload()` emits `regions: [{ id, name }]` — **two fields, verified by execution** | `regionId` + name, plus the zone/site/cell assignment lists | **No** | n/a | Yes — §22.1 rule 3, pinned into the round snapshot |
| 3 | **Publish-time validation** | `config/validators.js:507–…` V8; `spatial/hierarchy.js:186–304` | Region ids unique; every zone and site names a declared region; every fine cell maps to exactly one zone, ≤ one site, and agrees at every level | **No** | n/a | Blocking at publish |
| 4 | **Cell generation / H3 wrapper** | `spatial/cells.js:181–184` `H3_RESOLUTION = { FINE: 8, COARSE: 5 }`; `cellForPoint()`, `coarseParentOf()`, `fineChildrenOf()`, `diskAround()`, `ringAt()` | **The fine-cell set as H3 indices.** The wrapper is global: it needs no region to function | **No** — it *consumes* the derived cell set | WGS-84 implicit in `isFiniteCoordinate` (`cells.js:202–209`) | The cell set is published configuration |
| 5 | **§6.4 candidate generation / ring floor** | `candidates/expansion.js:97–107, 330–374`; `cells.edgeLengthMetres()` | The origin fine cell; `regionCoarseCellIds` and `crossRegionCoarseCellIds` — **cell-id lists, optional, injected** (`expansion.js:18–22`) | **No** | n/a | Pinned per round |
| 6 | **`Ω_terminal` (the pruning bound's floor)** | §6.4: *"a maximum over prices within the search region"*; `candidates/omega.js` | The region's **zone set** — max/min `λ_zone` over `z ∈ region` | **No** | n/a | Published with the price snapshot |
| 7 | **F33 geofence** | `feasibility/predicates/f33.js:103–123` | `stop.serviceable` — an **assignment**, read per stop. §3.6: *"containment is by assignment, not geometry … a point-in-polygon test here would be non-deterministic (T6)"* | **No — explicitly prohibited at query time** | WGS-84 bounds ±90/±180 for well-formedness only (`f33.js:43–46`) | The serviceability assignment is configuration |
| 8 | **Intake shard routing** | `intake/intake.js:220–325` | A published **region→shard map**, keyed by region *id*. A region absent from the map refuses the Leg by name | **No** | n/a | Published configuration |
| 9 | **Availability Index** | `AgentCellPosition` (`schema.prisma:928–964`) — `lat`, `lon`, `fineCellId`, `coarseCellId`, indexed by `(shardId, cell, availabilityClass)` | Cell ids derived from live observations by `cellForPoint()` | **No** | WGS-84 | Live, rebuildable |
| 10 | **Charger placement / depot** | `model Charger` (`schema.prisma:2614–2649`) — `regionId`, `cellId`, `latitude`, `longitude`, `isDepot` | Per-charger coordinates **and** a fine-cell assignment; every charger must fall inside the declared region | Point coordinates, not a boundary | WGS-84 | Durable |
| 11 | **Charger-reachability precompute** | `workers/chargerReachability.worker.js:16, 63, 87` — *"every populated cell in the region"*, taken as `input.cellIds` | The region's populated fine-cell set | **No** | n/a | Keyed by projection version |
| 12 | **Routing caches** | `routing/cellPairCache.js`, `routing/chargerReachabilityCache.js`, `routing/inProcessCache.js` | Cell ids + profile key + time bucket. §20.3 | **No** | n/a | Keyed, TTL'd |
| 13 | **Routing extract / contraction hierarchies** | `tools/routing/b1Benchmark.js:571, 586`: *"any deployed engine, region extract, or built contraction hierarchy"*; §5.2 *"colocated with the shard"*; §27 item 2 | **A bounding geometry to cut the extract against** | **YES — the only consumer that needs one** | Must be stated; OSM extracts are cut in WGS-84 | Must be versioned — §5.2 *"version pinned"*; D8 owns vintage |
| 14 | **Map service (obstruction class)** | `engine/map/obstructionClass.js` | Hazard-data **coverage** over the operating area; `map.obstruction_class_max_age` awaits *"the region's measured map hazard-data publication cadence"* | Coverage extent, not a polygon in this repo | n/a | Publication cadence is D8 |
| 15 | **Mobility model / routing profile** | `domain/mobilityModel.js`; §15.5 | Nothing from D1 directly. Profile key is `modelId:domains:loaded` | **No** | n/a | Derived, never stored |
| 16 | **Shard sizing** | `shard/shardModel.js`, `shard/sizing.js`; §3.5 bound 2 | The region's mission rate `r` and agent count `N` — **D5**, not D1 | **No** | n/a | Blocking at publish |
| 17 | **Fleet simulation / demand generator** | Phase 15 checklist item 5, PARTIAL (§27 F10) | A spatial extent over which to correlate demand — satisfied by the derived fine-cell set | **No** (cell set suffices) | n/a | n/a |
| 18 | **Shadow worker / production coordinator** | `workers/shadow.worker.js`, `workers/coordinator.worker.js`; §26.2 | Nothing from D1 directly. Both need the shared composition root, which needs an engine | **No** | n/a | n/a |
| 19 | **Telemetry / mission assumptions** | `sockets/handlers/telemetry.handler.js`; `security/positionPlausibility` | WGS-84 well-formedness and speed plausibility. No region extent | **No** | WGS-84 | n/a |
| 20 | **Calibration** | Register: **146 of 242 entries carry `region` in `scopes`**; **11 `awaits` a region-specific measurement** (verified by execution — §30.1.3) | A *named* region against which to measure. Not geometry | **No** | n/a | §22.1 rule 2 |
| 21 | **Safety / governance gates** | `gate:calibration` (§22.4); §22.3 change classes | A named region as the scope for region-scoped Safety parameters, and a named owner | **No** | n/a | Blocking at launch |

**Twenty of twenty-one consumers require no geometry.** Exactly one does — the routing extract —
and it is not a runtime consumer at all.

#### 30.1.2 The contract, stated

**A. What constitutes the "target operating region"?**
§3.5: *"partitioned by **OperatingRegion** (a site, campus, depot catchment, or metro service
area)"*. §3.6's table: *"The shard boundary: a metro service area, campus, or depot catchment.
Every Agent and every Leg belongs to exactly one at a time … — (top of the spatial hierarchy) … 1
per shard."* It is **the shard partition unit**, and the architecture deliberately declines to say
which of the four kinds this deployment is. That choice is D1's substance.

**B. Polygon, bbox, set of polygons, or polygon + derived bbox?**
The frozen architecture and the frozen execution plan require **none of them in configuration.**

> `IMPLEMENTATION_EXECUTION_PLAN.md:346`: *"region/zone/site/cell maps published as config (§3.6 —
> **containment by assignment, not geometry**)"*
> `IMPLEMENTATION_EXECUTION_PLAN.md:341` migration (f): *"`Region`, `Zone` (extend: `regionId` FK,
> cell set), `Site`, `CellAssignment`"* — **no boundary column authorised**
> §3.6: *"Deriving containment from polygon intersection at query time would make a cell's zone
> depend on floating-point geometry evaluated per round, which is both slow and non-deterministic
> (T6)."*

The **runtime** contract is therefore: *region id + name + the fine-cell set + the zone/site
assignment*. The **procurement** contract, for the extract only, is a bounding geometry — and a
**polygon is strictly better than a bbox** there, because an extract cut to a bbox over an
irregular service area buys graph the fleet will never traverse, and extract size is what drives
hierarchy build time, build memory and the per-shard runtime footprint §3.5's sizing inequality
does not yet carry (H3, §22.6). A bbox is derivable from a polygon; the converse is not.

> **Refinement of §22.2, recorded rather than substituted.** §22.2, the routing-configuration
> decision (§8 row D1) and the routing-prerequisite report (§4.2 gap S1) each state the missing
> input as *"a boundary as GeoJSON or a bounding box with its CRS"*, with S1 described as *"the
> field does not exist in the payload shape or on `Region`"*. **That field's absence is not a
> defect.** No consumer reads it, the execution plan does not authorise it, and §3.6 forbids the
> query-time use that would motivate it. Whether `regions[].boundary` should exist as a
> *provenance* record — so the cell set can be re-derived and audited against the geometry it came
> from — is a legitimate and separable schema question, and it remains D1-dependent exactly as
> §27 B recorded. The earlier documents were right that the shape is unreviewed; they were
> imprecise in implying a runtime consumer needs it.

**C. Coordinate system.** WGS-84 (EPSG:4326), decimal degrees, latitude ∈ [−90, 90], longitude ∈
[−180, 180] — the only system the tree admits, enforced in two independent places:
`spatial/cells.js:202–209` `isFiniteCoordinate` (`@structural WGS84 latitude range` /
`@structural WGS84 longitude range`) and `feasibility/predicates/f33.js:43–46`
(`MAX_ABS_LATITUDE = 90`, `MAX_ABS_LONGITUDE = 180`, *"the WGS-84 latitude bound in degrees"*).
H3 itself is defined on WGS-84. **No projected CRS is supported anywhere.** The owner does not
choose the CRS; the owner must only **state the CRS their supplied geometry is in**, so that a
geometry authored in a national grid is reprojected once, deliberately, rather than silently
misread as degrees.

**D. Minimum geometry validity rules.** See §30.5. In summary: a closed, non-self-intersecting,
non-zero-area ring set in `[lon, lat]` order, WGS-84, whose H3 res-8 cover is non-empty.

**E. Which definition — campus, operational, geofence, road-network, other?**
The architecture names one boundary and gives it two simultaneous jobs, and the owner must satisfy
both with one answer:

| Job | Section | What the boundary must be |
|---|---|---|
| **Shard partition** — every Agent and every Leg belongs to exactly one region at a time | §3.5 | An **operational** boundary. Merely enclosing is acceptable; overlap between regions is not, because region→shard is a function (`Shard.regionId` is `@unique`) |
| **Serviceable area** — F33 rejects any stop outside it | §7.5 F33 | **Operationally exact**, because it is a customer-visible accept/reject and a `VIOLATED` here refuses a mission |

Because containment is resolved by assignment, the exactness requirement lands on the **derived
cell set**, not on the polygon: the polygon may be approximate provided the cell cover it produces
is the intended serviceable area. The routing extract, by contrast, needs only to be **enclosing** —
an extract larger than the service area is wasteful, never wrong.

**F. Buffer.** **The architecture states no buffer requirement, and none is invented here.** Two
facts make it a real question the owner should be asked once rather than discovered later:
`candidate.max_radius_by_sla_class` and tier 5's *"widened radius"* (§6.3) let candidate search
reach agents outside the origin's immediate area, and §14.5's depot-only fallback destination set
must be routable. A route between two in-region points may legitimately leave the polygon. **The
extract should therefore be cut with a margin; the serviceable region should not be.** Recorded as
a question, not a policy — the margin's size needs the routing engine's own behaviour, which is B1.

**G. Must the region contain all mission origins, destinations, chargers, depots, routing graph?**

| Must lie inside | Yes/No | Evidence |
|---|---|---|
| Mission origins | **Yes** | F33 rejects any stop whose cell is not serviceable |
| Destinations | **Yes** | Same — F33 tests *every* stop in `plan.stops` |
| Chargers | **Yes** | `Charger.regionId` + `Charger.cellId`; the reachability worker precomputes over *"every populated cell in the region"* |
| Depots | **Yes** | `Charger.isDepot`; §14.5's fallback set is *"fixed infrastructure whose availability does not depend on any round's output"* |
| Routing graph | **Enclosing, not equal** | It must cover the region **and** any corridor a legal route may use; see F |
| Zones and sites | **Yes, exactly one region each** | §3.6, enforced by V8 at publish |
| Agents | **Exactly one region at a time** | §3.5; handoffs are transactional, *"never inferred from position drift"* |

Cross-region work is not an exception: §3.5 decomposes it at intake into per-shard Legs joined at
transfer points (§19.6), so each Leg still lies wholly inside one region.

#### 30.1.3 Register evidence for the "named, not shaped" conclusion

Executed against `src/engine/config/register/*.json` this pass:

```
total registered entries                    242
entries whose scopes[] include "region"     146      (60 %)
entries whose awaits names a region/map     11
```

The eleven, verbatim from the register:

| Parameter | Status | `awaits` |
|---|---|---|
| `solve.window_min` | PROVISIONAL | measured arrival rate and round wall-clock per region |
| `solve.window_max` | PROVISIONAL | measured arrival rate and round wall-clock per region |
| `solve.batch_growth_threshold` | PROVISIONAL | measured arrival burstiness and per-round amortisation per region |
| `plan.max_admissible_mission_duration` | PROVISIONAL | the region's measured mission-duration distribution |
| `shard.mission_rate_per_agent_hour` | PROVISIONAL | the region's measured mission rate |
| `shard.max_agents` | PROVISIONAL | the region's measured mission rate |
| `shard.min_agents` | PROVISIONAL | the region's measured mission rate and the operated cost of a coordinator |
| `map.obstruction_class_max_age` | PROVISIONAL | the region's measured map hazard-data publication cadence |
| `ops.escalation_capacity` | UNCALIBRATED | the region's actual staffed operator count |
| `ops.external_escalation_contacts` | UNCALIBRATED | the responsible infrastructure operator per region — rail, tram, highways, or site security |
| `route.degraded_max_radius` | UNCALIBRATED | per-region straight-line-versus-network error measurements |

**Not one awaits a geometry.** Every one awaits a *measurement taken in a named, operating region*.
This is the strongest single piece of evidence that D1's runtime value is an identity and an
operational commitment, and that its geometric value is a procurement input for B1 alone.

---

### 30.2 Existing Candidate Region Data

Every geometry-shaped artefact in the tree, found by searching for boundary/bbox/polygon/GeoJSON/
geofence/CRS terms across `Backend/src`, `Backend/prisma`, `Backend/tests` and `Frontend/src`, and
by enumerating every hard-coded decimal coordinate. **Nothing here was promoted, adopted, copied
into configuration, or treated as an answer.**

| # | Artefact | Location | Classification | Why |
|---|---|---|---|---|
| 1 | `SEED_SPATIAL_MAP` — `RGN-BLR` "Bengaluru operating region", 2 zones, 1 site, 4 FINE + 1 COARSE cells | `prisma/seed.js:31–44` | **DEMO/SEED DATA** | A Phase 2 §3.6 containment demonstration. Never published as a configuration version (`snapshot.spatial === null`, re-verified live this pass). **No geometry of any kind.** Its cell ids are placeholder tokens, not H3 — proven in §30.5. Four fine cells against §3.6's 10³–10⁵. That it names Bengaluru is the trap, not the evidence |
| 2 | `Zone.minLat / maxLat / minLon / maxLon` | `schema.prisma:267–270` | **OBSOLETE** (for D1) | Non-null columns, but the schema's own comment settles it: *"the bounding box above is **legacy DTARO state and is not what the engine resolves containment from**"* (`schema.prisma:291–293`). Read only by `zoneManager.service.js:97`, a legacy point-in-bbox lookup |
| 3 | Auto-generated quadrant zones — four boxes at `±0.005°` (*"~550 m"*) around a campus centre | `services/zoneManager.service.js:223–261` `seedDefaultZones()` | **DERIVED DATA** (legacy, auto-fabricated) | Manufactured from a campus centre point when no zones exist, inside a swallowed `try/catch`. **This is the single most dangerous artefact on this list**: it is a bounding geometry the system invents for itself. It must never be mistaken for an operator-declared region |
| 4 | `Campus.centerLat / centerLon` | `schema.prisma:337–338`; seeded `12.9023, 77.5186` (`seed.js:116–117`) | **DEMO/SEED DATA** | A point, not a boundary. Legacy DTARO filter system |
| 5 | `Location` hierarchy with `slug` (`"india"`, `"karnataka"`, `"bengaluru"`, `"rr-nagar"`) and optional `lat`/`lon` | `schema.prisma:164–185`; `seed.js:62–102` | **DEMO/SEED DATA** | Nominal centroids for a UI filter tree (`20.5937, 78.9629` is the geographic centroid of India). Not an operational boundary and not read by the engine |
| 6 | Simulator spawn default `12.9023, 77.5183` | `simulation/SimulationEngine.js:65–66` | **DEMO/SEED DATA** | A fallback spawn point for the virtual robot when none is supplied |
| 7 | `candidateFixture` origin `{ lat: 12.9716, lon: 77.5946 }`; `candidatesAvailabilityIndex.test.js`; `supervisionReconciler.test.js` (`12.9x, 77.6x`); `securityTrustBoundaries.test.js` (`51.5, −0.1`) | `tests/engine/**` | **TEST FIXTURE** | Deliberately two different cities in the same suite — proof the code is region-agnostic, and proof these are not a declaration |
| 8 | `Frontend` `WORLD_CENTER = [20, 0]` | `Frontend/src/features/maps/MapControl.jsx:27` | **UNRELATED** | A default map camera position for an empty dashboard |
| 9 | `mapbox.service.js` GeoJSON handling | `services/mapbox.service.js:48–86` | **OBSOLETE** | Route geometry from an external provider. §5.2 makes a metered external API *"architecturally incompatible"*; the execution plan marks it **R** (retire) for the hot path |
| 10 | `CellAssignment.mapVersion`, default `0`, *"not a foreign key"* | `schema.prisma:885–904` | **DERIVED DATA — unpopulated** | The only provenance hook that exists. D8 owns what fills it |
| 11 | `Site.graphZones` | `schema.prisma:846` | **UNRELATED to D1** | §6.2's indoor/multi-level proximity partition. Column exists, unused, and §5.1 of the routing-configuration decision excludes it from B1's scope |
| 12 | GIS files — `.geojson`, `.osm`, `.pbf`, `.kml`, `.shp`, `.wkt` | — | **NONE EXIST** | Searched the whole tree excluding `node_modules`. Zero results |
| 13 | Deployment / environment configuration | `Backend/.env`, `.env.benchmark` | **NONE** | No region, bbox, bounds, latitude or longitude key of any kind |
| 14 | Migration history | `prisma/migrations/**` | **NONE** | Every occurrence of "boundary" in a migration is prose in a comment. **No boundary, polygon, geometry or PostGIS column has ever existed** |

**LEGITIMATE PRODUCTION INPUT: zero rows.** There is no production region definition anywhere in
this repository, in any form, at any fidelity. Re-verified live this pass:

```
config service defaultSnapshot():   spatial = null    shards = null    bindings.size = 0
```

**Nothing in rows 1–14 satisfies the D1 contract, and nothing in rows 1–14 may be promoted.** Row 3
deserves the sharpest warning: `seedDefaultZones()` will fabricate four bounding boxes from a
campus centre without anyone deciding anything, and it fails silently. It is legacy DTARO code
outside the engine boundary and it is not on any path that publishes engine configuration — but it
is exactly the shape of artefact a future pass could mistake for a declared region.

---

### 30.3 Missing Owner Decision

D1 is **MISSING**. Not partially decided: there is no region record, no geometry, no published
spatial map, and no candidate that survives classification.

The minimum input is **five fields for one region**, and nothing else. Everything the owner is not
asked for is either derivable (§30.4) or belongs to a different decision.

#### OWNER MUST DECIDE

| # | Field | Why it cannot be derived | Format |
|---|---|---|---|
| **1** | **Region identity** — a stable `regionId` and a human-readable name | An identifier is a naming decision with operational consequences: it keys the region→shard map, every region-scoped parameter binding, and every decision record that cites a config version. It must be stable across redistricting | `regionId`: stable string, e.g. the pattern the seed demonstrates. `name`: free text |
| **2** | **Which kind of region this is** — site, campus, depot catchment, or metro service area | §3.5 offers exactly these four and selects none. It determines whether H3 res 8 survives (§30.5 N23) and whether §3.6's 10³–10⁵ fine-cell cardinality is achievable at all | One of the four words |
| **3** | **The serviceable boundary** — the authoritative geometry of the area the fleet will serve | §22.2 stands: *"§3.5 defines what an OperatingRegion is … and never which one this deployment serves. Nothing in the architecture, the execution plan or the repository selects one."* It is a commercial and operational commitment, not a computation | **A GeoJSON `Polygon` or `MultiPolygon`, WGS-84 (EPSG:4326), `[lon, lat]` order.** A bounding box is accepted as a degraded form; a polygon is materially better (§30.1.2 B). Holes permitted (§30.5) |
| **4** | **The CRS the supplied geometry is authored in** | Only needed if it is *not* EPSG:4326. Silent misreading of a projected coordinate as degrees is the failure this field exists to prevent | An EPSG code, or "WGS-84 / EPSG:4326" |
| **5** | **A version label and date for the geometry** | §22.1 rule 3 makes configuration versioned and immutable once published, and every decision record cites its version. A boundary that changes without a version makes every prior decision unauditable, and §3.5 requires redistricting to redistrict zones with it | Any stable label + an ISO date |

**That is the entire ask.** One region is sufficient to unblock B1; how many regions exist at launch
is **D5**, and it does not gate the first extract.

#### ENGINEERING CAN DERIVE AFTER D1

Explicitly **not** asked of the owner:

- the bounding box — computed from the polygon;
- the H3 fine-cell set and the coarse-cell set — computed from the polygon;
- the zone and site cell assignments — an engineering partition of the derived cell set, subject to
  the owner's zone intent;
- the serviceability assignment F33 reads;
- the routing extract extent and the cache key space;
- the H3 resolution — **already decided**: FINE 8 / COARSE 5 (§21.2 C1, `cells.js:181–184`), subject
  only to the res-8 fitness re-check in §30.5 N23;
- the spatial indexes — they already exist (`AgentCellPosition` carries both).

---

### 30.4 Engineering-Derivable Outputs

Every derivation the moment D1's five fields land. **None was implemented by this pass**; §30.9
records why each is unauthorised today and what authorises it.

| # | INPUT | → TRANSFORMATION | → OUTPUT | OWNER | DEPENDENCY |
|---|---|---|---|---|---|
| **G1** | D1 polygon (WGS-84) | Min/max over all ring vertices | `bbox = [minLon, minLat, maxLon, maxLat]` | Engineering | D1 only |
| **G2** | D1 polygon | `h3.polygonToCells(rings, 8)` — `h3-js@4.5.0`, **already a dependency**, verified present this pass | The region's **fine-cell set** as H3 res-8 indices | Engineering | D1 + D2 (decided) |
| **G3** | Fine-cell set | `cells.coarseParentOf()` over the set, de-duplicated, `canonicalCellOrder` | The **coarse-cell set** — `expansion.js`'s `regionCoarseCellIds` (tier 4 regional sweep) | Engineering | G2 |
| **G4** | Fine-cell set + owner's zone intent | Partition into zones; assign sites; `hierarchy.toConfigPayload()` | The **publishable spatial map**: `{ regions, zones, sites, cells, coarseCells }` | Engineering + Ops (zone intent) | G2, G3 |
| **G5** | Fine-cell set | Every published fine cell is serviceable by construction | **`stop.serviceable`** — the input F33 reads and **which no production code path writes today** (§30.5 N22) | Engineering (Phase 1 intake / Phase 9) | G4 |
| **G6** | `bbox` (G1) or, better, the polygon | Cut the OSM extract to the geometry, with the §30.1.2 F margin | The **region extract** — B1's precondition | Ops/Infra | D1 + D8 (vintage) |
| **G7** | Extract + per-class speed models | Per-profile contraction hierarchy build, `models × 2 × regions` | Built hierarchies — §20.3 item 5 | Infra | G6 + **D3** |
| **G8** | Fine-cell set | Cell-pair enumeration under §20.3's key discipline | The **cache region** — `cellPairCache` / `chargerReachabilityCache` key space, and its size | Engineering | G2 |
| **G9** | Fine-cell set + charger coordinates | `cellForPoint(lat, lon, FINE)` per charger; assert membership | `Charger.cellId` populated; the reachability worker's `cellIds` input | Engineering | G2 + charger inventory |
| **G10** | Region area, from the polygon | `area ÷ h3.getHexagonAreaAvg(8)` ≈ expected cell count | The **§3.6 cardinality check** and the **D2 res-8 fitness re-check** (§30.5 N23) | Engineering | G1, G2 |
| **G11** | Published map | `hierarchy.validate()` + `validators.v8SpatialContainment()` — **both already shipped and blocking** | The region validation artefact | Config Service | G4 |
| **G12** | Region + D5's `r`, `N` | §3.5 bound 2, `validators.v4ShardSizing()` — **already enforced at publish** | Shard definitions | Ops + Engineering | G4 + **D5** |

**Spatial indexes need no derivation.** `AgentCellPosition` already carries `fineCellId`,
`coarseCellId` and both composite indexes (`schema.prisma:962–963`).

---

### 30.5 Validation Requirements

Two categories, kept separate because one is enforcement that exists and one is enforcement that
does not.

#### 30.5.1 Already enforced, blocking at publish

Verified by reading `spatial/hierarchy.js:186–304` and `config/validators.js:507–…`:

| Check | Where | §22.1 rule 5? |
|---|---|---|
| A region declares an id | `hierarchy.js:194–200` | Yes |
| No region declared twice | `hierarchy.js:199` | Yes |
| Every zone names exactly one declared region | `hierarchy.js:206–219`, V8 | Yes |
| Every site names exactly one declared region | `hierarchy.js:229–236` | Yes |
| Every fine cell → exactly one zone, ≤ one site | V8 | Yes |
| Cell/zone/site region agreement at every level | `hierarchy.js:255–277` | Yes |
| No unassigned fine cell (*"a hole in the pricing surface"*) | `cells.js:150–162` | Yes |
| Region → shard is a function; shard ids unique | `shardModel.validateDefinitions()`, `Shard.regionId @unique` | Yes |
| §3.5 sizing inequality, per shard and globally | `validators.v4ShardSizing()` | Yes |
| Coordinate well-formedness, WGS-84 bounds | `cells.js:202–209`, `f33.js:54–61` | At intake/gate |

**Nothing needs to be built for any of these. They are why the region "containers exist and are
enforced; the content does not" (§4.1 of the routing-prerequisite report) remains accurate.**

#### 30.5.2 N21 — the publish path cannot today reject an invented region

**New finding, revision 3. Proven by execution, not by reading.**

```
hierarchy.validate(SEED_SPATIAL_MAP).ok            →  true      (0 problems)
cells.resolutionOfH3Cell("cell-rrnagar-fine-01")   →  null      (declared FINE)
cells.resolutionOfH3Cell("cell-rrnagar-fine-02")   →  null      (declared FINE)
cells.resolutionOfH3Cell("cell-rnsit-fine-01")     →  null      (declared FINE)
cells.resolutionOfH3Cell("cell-rnsit-fine-02")     →  null      (declared FINE)
cells.resolutionOfH3Cell("cell-blr-coarse-01")     →  null      (declared COARSE)
hierarchy.toConfigPayload(SEED_SPATIAL_MAP).regions
                                                   →  [{"id":"RGN-BLR","name":"Bengaluru operating region"}]
fine cells published = 4      coarse cells published = 1
```

**A map whose every cell id is a placeholder token — not an H3 index at any resolution — passes the
full spatial validation with zero problems.** This is correct for Phase 2, where `cells.js`'s own
header states a cell id is *"an opaque token supplied by the published map"* and B5 was deliberately
unsettled. **B5 is now settled** (`cells.js:29–39`, H3, res 8/5) and the validator was never
tightened behind it.

The consequence is precise and it is a D1 concern rather than a general one: **the publish path
would today accept a fabricated, geometry-free region map indistinguishable from a derived one.**
The guard that makes "do not promote seed geometry" mechanical rather than a matter of reviewer
diligence does not exist.

**Not fixed by this pass.** Tightening a shipped publish-time validator changes what configuration
the Config Service accepts; §3.6 explicitly permits non-geodesic tokens for indoor/multi-level
*"site-local graph zones"*, so the correct rule is conditional, not blanket — and choosing that
condition is Phase 9 / Architecture's call, not an auditor's. Recorded as **N21** and assigned in
§30.9.

#### 30.5.3 N22 — F33's containment input is written by no production code path

**New finding, revision 3.** `f33.js:103–123` reads `stop.serviceable`. Searching the entire
`Backend` tree for `serviceable` outside `f33.js` and the feasibility register returns **only test
files**: `tests/engine/helpers/feasibilityFixture.js:241,253` and two assertions in
`feasibilityPredicates.test.js`. **No production module writes it.**

F33 is Class C with indeterminate policy `DENY` (`feasibility/register.js:136`), so for every real
plan the containment arm resolves `ABSENT` → `DENY`: *"containment is by assignment, not geometry
(§3.6); an unassigned cell is not an out-of-area one."* The predicate is behaving exactly as
designed — it refuses to guess. **The producer is the missing artefact, and G5 is that producer.**
This is not a defect in F33; it is the visible end of D1's absence, and it is the cleanest single
demonstration that the system genuinely cannot operate without D1.

#### 30.5.4 N23 — §3.5's region kinds and §3.6's cell cardinality are in tension at res 8

**New finding, revision 3.** From `h3-js@4.5.0`, executed this pass:

```
res 8   avg area 0.7373 km²   avg edge 531.4 m
res 5   avg area 252.90 km²   avg edge 9 854.1 m

§3.6 requires 10³–10⁵ fine cells per region
    →  10³ cells ≈ 737 km²        (lower bound on region area at res 8)
    →  10⁵ cells ≈ 73 733 km²     (upper bound)
```

§3.5 admits four region kinds. **A metro service area sits inside that band. A site, a campus, and
most depot catchments do not** — a 1 km² campus yields roughly **one** res-8 fine cell, four orders
of magnitude below §3.6's stated floor. §6.2's fine band is *"~200–500 m"* edge and `cells.js:172–178`
already concedes res 8 (531 m) is *"the nearest fit outdoors"* rather than an exact one.

**This is why field 2 of §30.3 exists.** If D1 answers *metro service area*, D2's residual closes
with an arithmetic check and res 8 stands. If D1 answers *site* or *campus*, **D2's residual
reopens as a real decision** — either a finer resolution, or §6.2's per-region override, which
`cells.js` does not have (*"one global pair and no override path, and adding one is a schema
change"*, §22.3). §30.4 G10 is that check, and it costs minutes once the polygon exists.

#### 30.5.5 Checks the D1 gate should apply — architecture-supported only

Recorded, not implemented. Each traces to a stated requirement; **no new policy is invented.**

| # | Check | Rejects | Basis |
|---|---|---|---|
| V-1 | Geometry is `Polygon` or `MultiPolygon` | Points, LineStrings, GeometryCollections | Only an areal geometry can be cut into a cover |
| V-2 | Rings are closed; ≥ 4 positions | Malformed geometry | GeoJSON (RFC 7946) |
| V-3 | No self-intersection | An ambiguous interior | A cover of an invalid polygon is undefined |
| V-4 | Non-empty, non-zero-area | A region containing nothing | §3.6 — a region with no cells has no pricing surface |
| V-5 | Every coordinate in WGS-84 range, `[lon, lat]` order | Swapped axes, projected coordinates read as degrees | `cells.js:202–209`, `f33.js:43–46`. **Axis order is the single most common real-world error and V-5 is the only check that catches it before the cover is silently wrong** |
| V-6 | Stated CRS is EPSG:4326, or reprojection is explicit and recorded | Silent misinterpretation | §30.1.2 C |
| V-7 | `regionId` present, unique, stable | An unkeyable region | `hierarchy.js:194–200` — **already enforced** |
| V-8 | Derived cover is non-empty | A polygon finer than one res-8 cell | §3.6 |
| V-9 | Derived fine-cell count within 10³–10⁵, **or an explicit recorded exception** | The N23 mismatch passing unnoticed | §3.6 table. **Not currently enforced anywhere** |
| V-10 | Every published cell id is a valid H3 index at its declared resolution — **except** where §6.2's site-local graph zones apply | A fabricated map (N21) | §6.2, B5 settled. **Not currently enforced** |
| V-11 | Regions do not overlap | An Agent in two regions | §3.5 — region→shard is a function |
| V-12 | Every charger and depot's cell lies in the region's cell set | An unreachable fallback destination | §14.5 |
| V-13 | Extract covers the region's bbox plus the §30.1.2 F margin | A route leaving the graph | §5.2; **needs B1's engine to size the margin** |

V-9, V-10 and V-12 are the three that do not exist. V-13 cannot be written before B1.

---

### 30.6 D1 → B1 Dependency

The dependency is asserted in four prior documents. **It is proven here, and the proof also finds
one part of B1 that is genuinely not behind D1.**

#### 30.6.1 The chain, each link with its evidence

```
D1  serviceable boundary (polygon, WGS-84, versioned)
 │
 ├─(a)─► bbox / cut geometry ──► OSM REGION EXTRACT
 │        Evidence: b1Benchmark.js:571 — the tool names, among what the repository does not have,
 │        "any deployed engine, region extract, or built contraction hierarchy".
 │        b1Benchmark.js:586 — step 1 of the closing procedure is "Deploy each candidate engine
 │        ... AGAINST THE TARGET REGION EXTRACT, with per-profile contraction hierarchies BUILT".
 │        An extract is cut against a geometry. There is no extract without one.
 │                     │
 │                     ▼
 │        PER-PROFILE CONTRACTION HIERARCHIES
 │        Evidence: §20.3 item 5 makes the precomputation the point; b1Benchmark.js:587 — "an
 │        engine measured without it is not measured". A contraction hierarchy is a
 │        precomputation OVER A GRAPH; with no extract there is no graph to contract.
 │                     │
 │                     ▼
 │        THE FOUR B1 EVIDENCE ROWS THAT CARRY ATTRIBUTION
 │        approach_routing_matrix (ENGINE) · charger_reachability_miss (ENGINE) ·
 │        cost_per_candidate (ENGINE) · charger_reachability_cached (CACHE_PATH)
 │        Every one times a call into a deployed engine or a cache populated by one.
 │                     │
 │                     ▼
 │        B1: benchmark, compare, choose, write the ADR
 │
 ├─(b)─► H3 fine-cell set ──► ROUTING CACHE KEY SPACE (§20.3)
 │        cellPairCache and chargerReachabilityCache are keyed by cell id. The cell-pair
 │        population size — the number the routing-prerequisite report §11 calls "the number
 │        that decides the cache sizing" — is O(|cells|²) and is not derivable without D1.
 │        Without it, route.cell_pair_min_hit_rate cannot be evaluated in steady state, and
 │        the two HIT_RATE rows are already only HARNESS_ARTIFACT (1.00 and 0.50 by construction).
 │
 └─(c)─► CHARGER REACHABILITY PRECOMPUTE
          chargerReachability.worker.js:16,63 — entries are precomputed for "every populated
          cell in the region", taken as input.cellIds. Two of the six B1 rows are return-leg
          charger-reachability rows. No cell set, no population to precompute over.
```

**The chain has no alternative ordering.** Link (a) is not a convenience: the object B1 benchmarks
does not exist until a geometry is supplied. §22.2's *"There is no ordering in which the engine is
chosen first"* is confirmed, and now it is demonstrated rather than asserted.

#### 30.6.2 What of B1 can proceed without D1 — stated honestly

The brief asks not to claim B1 blocked merely because it is convenient. Two parts survive:

| B1 work | Behind D1? | Evidence |
|---|---|---|
| **Step 2 of the closing procedure — "write one adapter per candidate to the contract in this file's header"** (`b1Benchmark.js:588`) | **NO** | The adapter contract is `{ id, description, matrix(), nearestChargers() }` (`b1Benchmark.js:89–90`), region-agnostic by construction. It is behind **D4** (which engines are candidates at all) and Phase 8 ownership, **not** behind D1 |
| **The engine shortlist itself** | **NO** | §27 item 2's options are named; the filter is *"per-profile contraction hierarchies and multi-modal networks"* against the modality roadmap. That is **D4** |
| Deploying any candidate | **YES** | Nothing to deploy it against |
| Building hierarchies | **YES**, and also behind **D3** | Two independent blocks: no graph, and no speed model to weight its edges (§22.4) |
| Running the tool, recording any row | **YES** | All six rows require a deployed engine; the tool correctly reports `NOT_MEASURED` and exits 0 |
| Recording hierarchy build time / extract refresh cadence (step 4) | **YES**, and also **D8** | Both are properties of an extract |
| Choosing and writing the ADR (step 5) | **YES** | §6.1 makes B1 a decision on recorded evidence, and there is none |

**Four of the five closing steps are behind D1. Step 2 is not, and it is behind D4 instead.** That
is the honest boundary, and it means answering **D4 alone** unblocks real B1 preparation work
without a single coordinate — which no prior document states.

---

### 30.7 Parallel Work While D1 Is Pending

Classified per the brief's five categories, against the working tree. **None was performed.**

| Item | Classification | Basis |
|---|---|---|
| **D3** — fleet agent classes and mobility models | **WAITING FOR ANOTHER DECISION** (its own; external to D1) | §22.4. Product + Fleet Engineering. Independent of D1 in both directions: classes and speed models are not properties of a place. **Answerable today.** Blocks G7 jointly with D1 |
| **D4** — B1's traversal-domain scope | **CAN PROCEED NOW** | §22.5. Engineering's recommendation is complete (outdoor geodesic graph; `INDOOR_GRAPH` and `AIRSPACE_VOLUME` excluded with reasons). Needs one ADR line ratifying it against the modality roadmap. **Not behind D1, and per §30.6.2 it unblocks B1 adapter work** |
| **D5** — regions/shards at launch and each region's `r` | **WAITING FOR EXTERNAL EVIDENCE**, partly **WAITING FOR D1** | §22.6. The shard *count* follows the region *list*, so it trails D1; `r` is a demand figure and a planning estimate suffices. The §3.5 inequality is already enforced at publish — no code is waiting on it |
| **D6** — where mass and CoG are declared | **CAN PROCEED NOW** (shape); **WAITING FOR EXTERNAL EVIDENCE** (values) | §22.7. The schema decision is Architecture's and needs no region. Values are per-class commissioning data |
| **D7** — `traversalDomain` as a composition | **WAITING FOR ANOTHER DECISION** — D4 | §22.8. Decide in D4's ADR. The `unknown:unknown:*` cache-aliasing sharp edge should be closed in the same ADR |
| **D8** — extract vintage, refresh cadence, re-contraction window | **WAITING FOR D1** for its *values*; **CAN PROCEED NOW** for its *policy shape* | §22.9. "What downtime is tolerable" is answerable without knowing which region; "how often this extract refreshes" is not |
| **B8** — name the calibration owner | **CAN PROCEED NOW** | §26.1. Gates 37 of the 39; **22 are behind B8 alone**. Start `ops.emergency_services_hazard_threshold`, `ops.external_escalation_contacts`, `ops.stranded_obstructing_response_target` first — external-authority lead time. Note `ops.external_escalation_contacts` and `ops.escalation_capacity` are region-scoped and will need D1's region to *bind*, but the owner and the process do not |
| **Rollback rehearsal** | **CAN PROCEED NOW — and time-sensitive** | §12, §27 F2. Depends on nothing else; the earliest gate that can close. Confirm the pre-Phase-15 artefact is still retained **before it ages out** |
| **§20.1 Q-20.1** — budget aggregation/concurrency semantics | **CAN PROCEED NOW** | §25.3. Needs no engine, no region, no fleet. It is an arithmetic-semantics ADR, and until it lands `scale_targets` has no arithmetically defined target |
| **N16 / N17 / N18** — the Phase 9 defect pass | **CAN PROCEED NOW**, pending authorisation | §23, §27 F7. **N18 is deadlined by the composition root** — fixing it after shadow starts means re-running the 14-day window |
| **N21 / N22** (this revision) | **WAITING FOR ANOTHER DECISION** — Phase 9 / Architecture authorisation | §30.5.2, §30.5.3. N21 should land **before** the first spatial map is published, since it is the guard against publishing a fabricated one |
| The 11 worker cadence parameters | **CAN PROCEED NOW** | §26.2 — needs only an owner per parameter. `gate:calibration` would not move from 39 |
| `locality` gate evidence class | **CAN PROCEED NOW** | §27 B-pending-2 — the only finding that could let a gate close on unsupporting evidence |
| §26 invariant-observation window | **CAN PROCEED NOW** | §27 C15 — before the cutover, not during it |
| Ph14 F2 and the ~1-in-256 `privacySurrogateKeys` flake | **CAN PROCEED NOW** | §27 F8, F9 — Phase 14's, one line for the flake |
| Fleet demand generator | **CAN PROCEED NOW** (structure); **WAITING FOR D1** (spatial correlation) | §27 F10 — authorised by the Phase 15 checklist; spatially correlated demand needs D1's cell set and D3's classes to be meaningful |
| `regions[].boundary` / mass-CoG / domain-composition schemas | **WAITING FOR ANOTHER DECISION** | D1, D6, D7. §22.1 rule 5 refuses a schema admitting an unreviewed shape. **§30.1.2 now shows `regions[].boundary` may not be needed at all** — that is part of D1's answer, not a prerequisite for it |
| Publishing a spatial map, publishing shard definitions | **WAITING FOR D1** (and D5) | Containers and validation both exist; there is no content |
| Composition root, `routing/client.js`, `charger_reachability` worker, `route.degraded_*` | **B1-DEPENDENT** | §27 E — unchanged |
| `scale_targets`, `shadow_agreement`, `invariants_enforced`, `soak` | **B1-DEPENDENT** | §27 E — unchanged. `simulator_fidelity` and `rollback_rehearsed` remain **not** B1-dependent |

**The count is unchanged and re-confirmed: 11 of the 16 external decisions have no B1 dependency,
and 37 of the 39 calibration parameters are not behind B1.** Revision 3 adds one item to the
"answerable today, unblocks real work" list that was not there before: **D4**, which per §30.6.2
unblocks B1 adapter work without a coordinate.

---

### 30.8 Exact Decision Request

**To: Operations + Commercial. Copy: Architecture.**
**Subject: Decision D1 — the target operating region. One region is sufficient.**

> The assignment engine cannot select a routing engine, cut a map extract, publish a spatial map,
> validate a delivery address, or calibrate any region-scoped parameter until we declare where we
> operate. Nothing in the codebase declares it, and we have deliberately not guessed.
>
> **Please supply five things, for one region:**
>
> 1. **Region ID and name** — a stable identifier we will key configuration by, and a human name.
> 2. **Which kind of region is it** — a *site*, a *campus*, a *depot catchment*, or a *metro service
>    area*? (One word. It determines whether our spatial grid resolution is still the right one.)
> 3. **The serviceable boundary** — the authoritative outline of the area the fleet will serve, as a
>    **GeoJSON Polygon or MultiPolygon in WGS-84 (EPSG:4326), longitude-then-latitude**. Holes are
>    fine (excluded areas). A rectangular bounding box is accepted if that is all that exists, but a
>    polygon is materially better: we cut the map data to this shape, and a box over an irregular
>    service area costs us build time and memory for roads we will never use.
> 4. **The coordinate system**, if it is *not* WGS-84 — an EPSG code is enough.
> 5. **A version label and a date** for this boundary, so every decision the engine records can cite
>    which boundary it was made under. If the boundary changes later, that is a new version, not an
>    edit.
>
> **Please do not send:** a bounding box computed from the polygon, a cell or grid list, zone
> subdivisions, charger or depot lists, or an H3 resolution. We derive all of those.
>
> **How many regions we launch with, and the expected missions per agent-hour, are a separate
> question (D5) and do not hold this one up. One region unblocks the critical path.**
>
> **Turnaround:** this needs a decision and an authoritative file, not analysis. Every other item on
> the routing critical path is behind it.

---

### 30.9 Implementation Decision — and Why Nothing Was Built

Assessed against §10 of the brief's authorisation test: the frozen execution plan must authorise it,
it must be necessary to establish the D1 contract, it must invent no operational data, and it must
not alter frozen architecture.

| Candidate | Built? | Reason |
|---|---|---|
| A `regions[].boundary` schema field | **NO** | §22.1 rule 5 refuses a schema admitting an unreviewed shape, and §30.1.2 shows the shape itself is part of D1's answer — possibly *no field at all* |
| A polygon → H3 cover derivation utility (G2/G3) | **NO** | It would have no input, no test data that is not invented geometry, and no consumer until a map is published. `IMPLEMENTATION_EXECUTION_PLAN.md:346` authorises publishing maps, not building a derivation tool ahead of the map |
| V-9 / V-10 validators (cell cardinality, H3 validity) | **NO** | Both tighten a **shipped, blocking** publish-time validator. §6.2 permits non-geodesic tokens for site-local graph zones, so the correct rule is conditional; choosing the condition is Phase 9 / Architecture's, not an auditor's. Recorded as **N21** |
| A `serviceable` producer (G5) | **NO** | It is the derivation of a region that does not exist. Recorded as **N22** |
| Populating any region, zone, cell, charger or campus record | **NO** | Every candidate in §30.2 is seed, test, demo, derived or obsolete. Promoting one manufactures D1 |
| Re-deriving H3 resolution | **NO** | D2 is decided (§21.2 C1). Its residual is a *check*, and the check needs D1 |
| Anything in Phase 16, the solver, or the register | **NO** | Out of scope and out of ownership |

**Exactly one file was written: this report.**

---

### 30.10 Change Control — Revision 3

Captured before the first edit and again after, and compared rather than eyeballed.

```
BEFORE   git status --porcelain | wc -l   →  375
         git diff --stat                  →  59 files changed, 11613 (+), 1593 (−)

AFTER    git status --porcelain | wc -l   →  375                                   (unchanged)
         git diff --stat                  →  59 files changed, 11613 (+), 1593 (−)  (unchanged)
```

`git diff --stat` is **byte-for-byte identical** to revision 2's, which proves **no tracked file was
modified by revision 3** — not one line. The porcelain count did not move because this document was
already untracked before the pass began; a new file would have made it 376.

**Verification re-run on the current working tree this pass:**

| Check | Result |
|---|---|
| `npm run gate:tiers` | **PASS** — 275 modules, 376 governed edges, no Tier 0/1 → Tier 2 |
| `npm run gate:params` | **PASS** — 181 engine modules, 242 registered parameters, 0 bare constants |
| `npm run gate:tenets` | **PASS** — 272 modules, 0 violations |
| `npm run gate:legacy` | **PASS** — 4 retired modules absent, 290 files scanned |
| `npm run gate:calibration` | **FAIL — 39 blocking findings**; 242 entries, 52 DERIVED / 152 PROVISIONAL / 38 UNCALIBRATED, 54 Safety-class — **identical to revision 2, and correctly still failing** |

The full suite was **not** re-run by revision 3 and no new figure is claimed for it: no source,
test, tool or configuration file was touched, and the unchanged `git diff --stat` is the evidence
for that. The baseline of record remains **141 suites / 6 154 tests / 0 failures** (§28.1).

**The read-only probes disclosed in full.** Four `node -e` one-liners run from the repository root
against the real modules. They import `config/service.js`, `spatial/hierarchy.js`, `spatial/cells.js`,
`prisma/seed.js` and `h3-js`; they call `defaultSnapshot()`, `validate()`, `toConfigPayload()`,
`resolutionOfH3Cell()`, `getHexagonAreaAvg()` and `getHexagonEdgeLengthAvg()`; they write nothing,
mutate nothing, and touch no database. **They are diagnostics and they are not evidence for any
gate.** Their raw output is reproduced verbatim in §30.2, §30.5.2 and §30.5.4.

Verified mechanically:

- **No new markdown report created.** `PHASE_15_CONSOLIDATED_REMEDIATION_REPORT.md` is the only file
  written, and it is the same file revisions 1 and 2 wrote.
- **No solver change** — the unchanged `git diff --stat` covers all seven `src/engine/solve/*.js`.
- **No calibration change** — no file under `src/engine/config/register/` touched; the gate reports
  the same 39 against the same 242.
- **No threshold change, no gate bypassed or waived, no test weakened, added or removed.**
- **No Phase 16 change** — `src/engine/fairness/` still holds only `.gitkeep`.
- **No production region invented, no seed geometry promoted, no coordinates fabricated, no routing
  extract created, no routing engine installed, no schema altered, no configuration published.**
- **No commit was created.**

---

## 31. Final Status — Revision 3

```
CURRENT STATUS:
B1:       STILL BLOCKED
PHASE 15: STILL BLOCKED
PHASE 16: NOT READY

D1 STATUS:
MISSING
```

**D1 is MISSING, not partially decided.** There is no region record, no boundary in any form, no
published spatial map, and no candidate artefact that survives classification (§30.2 — fourteen
artefacts, zero legitimate production inputs). Verified live: `spatial = null`, `shards = null`,
`bindings.size = 0`.

**D1 OWNER INPUT REQUIRED** *(Operations + Commercial — five fields, one region, §30.8)*:

1. **Region ID and name** — stable identifier + human name
2. **Region kind** — site / campus / depot catchment / metro service area *(one word; determines
   whether H3 res 8 survives — §30.5.4 N23)*
3. **The serviceable boundary** — GeoJSON `Polygon` or `MultiPolygon`, **WGS-84 (EPSG:4326),
   `[lon, lat]` order**, holes permitted. A bbox is accepted as a degraded form
4. **The CRS**, if not EPSG:4326
5. **A version label and date** for the boundary

**ENGINEERING CAN DERIVE** *(§30.4 — none built by this pass)*:

- the bounding box (G1) · the H3 res-8 **fine-cell set** (G2, via `h3-js@4.5.0`, already a
  dependency) · the res-5 **coarse-cell set** (G3)
- the **publishable spatial map** — `{ regions, zones, sites, cells, coarseCells }` (G4)
- **`stop.serviceable`**, the input F33 reads and that nothing currently writes (G5, §30.5.3 N22)
- the **routing extract extent** (G6) and the **cache key space / cell-pair population** (G8)
- charger and depot **cell assignments** (G9)
- the **§3.6 cardinality check and the D2 res-8 fitness re-check** (G10)
- the **region validation artefact** — via validators that already ship and already block (G11)
- **spatial indexes: none needed** — `AgentCellPosition` already carries both

**BLOCKED UNTIL D1**:

- the OSM **region extract**, and therefore every **contraction hierarchy** (§30.6.1)
- **four of B1's five closing steps**, and all six evidence rows
- publishing a **spatial map**; publishing **shard definitions** (with D5)
- **D2's residual** — the res-8 fitness check for *this* region
- **`route.degraded_max_radius`** — awaits *"per-region straight-line-versus-network error
  measurements"*
- everything already behind B1: `routing/client.js`, the shared composition root, the
  `charger_reachability` worker, `scale_targets`, `shadow_agreement`, `invariants_enforced`, `soak`
- **spatially correlated** demand generation (the generator's structure is not blocked)

**CAN PROCEED IN PARALLEL** *(§30.7 — none performed by this pass)*:

- **D4** — ratify B1's traversal-domain scope. **One ADR line, and per §30.6.2 it unblocks B1
  adapter work with no coordinate at all.** Newly identified this revision
- **B8** — name the calibration owner; begin the **22 parameters behind nothing else**, starting
  with `ops.emergency_services_hazard_threshold`, `ops.external_escalation_contacts`,
  `ops.stranded_obstructing_response_target` (external-authority lead time)
- **The rollback rehearsal** in staging, all six steps — the earliest gate that can close;
  **time-sensitive**, confirm artefact retention first
- **Q-20.1** — the §20.1 budget-composition ADR
- **D3** (fleet classes and real speed models) and **D6** (mass/CoG schema shape) — neither is a
  property of a place
- **N16 / N17 / N18** — the Phase 9 defect pass; **N18 is deadlined by the composition root**
- **N21 / N22** — this revision's two findings, once Phase 9 / Architecture authorises. **N21
  should land before the first spatial map is published**
- the **11 worker cadence parameters** · the **`locality` evidence class** · the **§26
  invariant-observation window** · **Ph14 F2** and the one-line `privacySurrogateKeys` flake

**NEXT ACTION:**

> **Send §30.8 verbatim to Operations + Commercial and obtain one GeoJSON `Polygon` (or
> `MultiPolygon`) in WGS-84, with a region ID, a region kind, and a version date.**
>
> It requires no vendor, no hardware, no budget and no engineering. It is one file and one
> paragraph. Until it exists there is no extract, no hierarchy, no benchmark, no ADR, no routing
> client, no composition root, and no shadow window — and the 14-day shadow that sits at the end of
> that chain is the longest irreducible wall-clock item in Phase 15.

---

*End of Phase 15 Consolidated Remediation Report, revision 3. No new report was created — this is
the same single living record revisions 1 and 2 wrote. No repository file was changed, no region was
chosen, no geometry was invented, no seed data was promoted, and no commit was created.*

---

## 32. D4 Decision and Implementation Readiness

**Purpose of this pass.** §30.6.2 established that four of B1's five closing steps are behind D1
and that **Step 2 is not** — it is behind **D4**. §30.7 then listed D4 as the one item newly added
to the "answerable today, unblocks real work" column. This section converts that recommendation
into a freezeable ADR: it establishes what D4 actually decides, traces every consumer of
routing-engine selection and engine abstraction in the tree, audits the four routing abstractions
that exist against the frozen contract, proves D4 carries no D1 term, and states exactly what B1
Step 2 may and may not deliver once D4 is ratified.

**Nothing was implemented.** No routing engine was installed or configured, no adapter was written,
no extract was cut, no solver or calibration value was touched, no schema was altered, no register
entry was added or changed, and no test was weakened. §32.11 is the change-control record.

**One numbering caution, recorded first because it would otherwise corrupt every dependency
answer.** The task brief labels the hidden-dependency candidates *"D5 cost model, D6 constraints,
D7 fleet assumptions, D8 benchmark policy"*. The repository's decision register
(`PHASE_15_ROUTING_CONFIGURATION_DECISION.md` §8, audited in §22 of this document) numbers them
differently: **D5 = region/shard count and mission rate `r`; D6 = where mass and centre of gravity
are declared; D7 = whether `traversalDomain` becomes a composition; D8 = extract vintage, refresh
cadence and re-contraction window.** §32.8 answers **the repository's numbering**, which is
authoritative here, and additionally answers the brief's reading wherever the two diverge, so that
no dependency is silently skipped by a label mismatch.

---

### 32.1 D4 Authoritative Definition

**D4 is not "the engine adapter decision" and it is not "which engine wins".** Both of those are
different decisions, and §32.6 and §32.9 identify which. D4's authoritative wording, located by
searching every architecture, planning and remediation document in the tree:

| Field | Exact content | Source |
|---|---|---|
| **Decision wording (register)** | *"B1's traversal-domain scope — outdoor geodesic only, or multi-modal"* | `PHASE_15_ROUTING_CONFIGURATION_DECISION.md:326` |
| **Decision wording (audit)** | *"D4 — required traversal domains"* | §22.5 of this document |
| **The underlying frozen decision it instantiates** | §27 item 2: *"Routing engine \| OSRM, Valhalla, GraphHopper, or in-house \| **Whichever supports per-profile contraction hierarchies and multi-modal networks**; self-hosted is non-negotiable (§5.2) \| Depends on: **Modality roadmap**"* | `NEXT_GENERATION_ASSIGNMENT_ENGINE.md:5573` |
| **Alternatives considered** | The four values of the closed enum `TRAVERSAL_DOMAIN` — `SIDEWALK_GRAPH`, `ROAD_GRAPH`, `INDOOR_GRAPH`, `AIRSPACE_VOLUME` | `src/engine/domain/mobilityModel.js:47–52` |
| **Current recommendation** | *"B1 scopes the outdoor geodesic graph"* — `SIDEWALK_GRAPH`, plus `ROAD_GRAPH` if vehicles are in the horizon since the same extract serves both; `INDOOR_GRAPH` and `AIRSPACE_VOLUME` excluded, each with a stated reason | `PHASE_15_ROUTING_PREREQUISITE_REMEDIATION_REPORT.md:195` (§5.1); restated §22.5 |
| **Rationale** | §6.2: indoor and multi-level sites *"use site-local graph zones rather than geodesic cells … The index abstraction is 'proximity partition,' and its implementation is per-region configuration"* — **not something an OSM engine provides**. §25.2 lists UAS under *"Additions required: 3D routing with airspace volumes"* | §6.2, §25.2 |
| **Dependencies** | §27 item 2's stated dependency, verbatim: **"Modality roadmap"**. Not "Site mix" — that is §27 item 1's dependency, a different row for a different decision | `NEXT_GENERATION_ASSIGNMENT_ENGINE.md:5572–5573` |
| **Required evidence** | A Product modality roadmap statement of whether vehicles, indoor sites or drones fall inside the horizon B1's engine must serve. **No repository measurement can supply it** | §22.5 |
| **Affected B1 step(s)** | **Step 2** — *"Write one adapter per candidate to the contract in this file's header"* (`tools/routing/b1Benchmark.js:588`); and the **validity of the shortlist** used by Steps 1 and 3 | §30.6.2 |
| **Owner** | **Architecture**, ratifying engineering's recommendation against a Product roadmap. *"The recommendation, yes … The roadmap it is evaluated against is not engineering's"* | §22.5 |
| **Closure condition** | *"One ADR line stating B1's domain scope and explicitly excluding what it excludes"* | §22.5 |

**What D4 decides, stated once and precisely:** *which members of the `TRAVERSAL_DOMAIN` enum the
routing engine procured under B1 must serve.* Its only direct consequence is the second clause of
§27 item 2's filter — whether the candidate must support **multi-modal networks** — and therefore
*"the difference between procuring one OSM engine and procuring a multi-modal platform"* (§22.5).

**What D4 does not decide** (each traced to its real owner in §32.9): which named engine wins
(that is **B1** itself, on Step 3/5 evidence); the shape of the adapter interface (**Phase 8**,
`src/engine/ARCHITECTURE.md:90`); the route-attribution contract the feasibility gate reads
(**Phase 8 + B6**, N26); the caches' synchronous/pre-parsed value contract (**C13**, Tier 0
review, §24.3).

**Ratification status: none.** `docs/adr/` holds ADR-01 through ADR-32; a grep for `traversal`,
`TRAVERSAL`, `SIDEWALK` and `domain scope` across the whole log returns **zero files**. ADR-11
("Routing") records *"Self-hosted with precomputed hierarchies"* against the rejected *"Metered
external API in the hot path"* — that is the **mode**, not the **domain scope**, and it does not
answer D4.

---

### 32.2 Existing Recommendation

Engineering's recommendation is complete and is reproduced here unaltered, with the evidence each
row rests on. **It was not reopened, and no row was re-derived.**

| Domain | Required by B1? | Evidence |
|---|---|---|
| `SIDEWALK_GRAPH` | **YES** | The only declared model in the durable seed (`MOB-SIDEWALK-DEFAULT`). §25.2: ground robots are the *"Baseline case … Reuses everything"* |
| `ROAD_GRAPH` | **Not by the current fleet; the same extract serves it** | §25.2 puts delivery vans under *"Additions required: Road routing with vehicle restrictions…"*. No such model is declared. Including it changes the **profile count**, not the extract and not the candidate set |
| `INDOOR_GRAPH` | **NO — a different mechanism, not a routing profile** | §6.2: indoor and multi-level sites *"use site-local graph zones rather than geodesic cells … The index abstraction is 'proximity partition,' and its implementation is per-region configuration."* Scoping it into B1 would mis-specify the procurement. `Site.graphZones` exists as a column and is unused (gap S4) |
| `AIRSPACE_VOLUME` | **NO — §25 future modality** | §25.2 lists UAS under *"Additions required: 3D routing with airspace volumes; airspace authorisation as a hard constraint (class R)…"* |

**The two exclusions rest on mechanism arguments, not on facts about a place.** That is the
property that makes D4 answerable today, and §32.6 turns it into the formal proof.

---

### 32.3 Repository Evidence

#### 32.3.1 Every D4 consumer, traced INPUT → ENGINE/ABSTRACTION → OUTPUT → DOWNSTREAM USER

Traced from the two shipped caches outward, then from the feasibility gate and the cost path
inward. The column that matters is the last: **what breaks if the engine changes.**

| # | Consumer | INPUT | → ENGINE / ABSTRACTION | → OUTPUT | → DOWNSTREAM USER | Engine-selection sensitive? |
|---|---|---|---|---|---|---|
| 1 | **Approach / linehaul matrix** | `{ originCellId, destCellIds[], profileKey, timeBucket }` | `engine.matrix()` — the benchmark adapter (`b1Benchmark.js:92`) | `[{ destCellId, distanceM, travelSeconds, travelSdSeconds }]` | `cellPairCache.buildEntry()` → `plan/timeline.js:257` hops → `cost/cDirect.js` → `Φ` | **YES — ENGINE-attributed row** |
| 2 | **Cell-pair cache read-through** | `{ originCell, destCell, profileKey, timeBucket }` | `deps.route(parts)` — **one pair, object argument** (`cellPairCache.js:196`) | `{ distanceM, travelSeconds, travelSdSeconds }` | Same as row 1, plus `applyIntraCellOffset()` which **adds** `route.intra_cell_offset_m` = 250 m to distance and to time | **YES** |
| 3 | **Return-leg charger reachability** | `{ destCellId, profileKey, timeBucket, k }` | `engine.nearestChargers()` (`b1Benchmark.js:95`) | `[{ chargerId, distanceM, travelSeconds }]`, optional `chargerClass` / `isDepot` | `chargerReachabilityCache.buildEntry()` → `energy/eReturn.js:155,214` → **F34/F35** | **YES — ENGINE-attributed row** |
| 4 | **Charger-reachability precompute** | `(cellId, profileKey, timeBucket)` — **positional, no `k`** (`chargerReachabilityCache.js:290`) | `deps.route(...)` injected | charger array | `workers/chargerReachability.worker.js` → Tier 0 cache entry | **YES** |
| 5 | **Route cache (L2, cross-round)** | key `engine:route:cell:{origin}:{dest}:{profile}:{bucket}` / `engine:charger:reach:{cell}:{profile}:{bucket}:{version}` | kv client, injected | JSON entry | Both caches | **No** — engine-independent by key discipline |
| 6 | **Route cache (L1, in-round)** | namespace + same keys, `nowMs` injected | `routing/inProcessCache.js` — *"issues no query, holds no adapter, knows no engine"* (`inProcessCache.js:34`) | same value | Façade in front of L2 | **No** — a test asserts neither cache module mentions it (§24.1) |
| 7 | **Lower-bound calculation** | agent lat/lon, leg first-stop lat/lon | `candidates/lowerBound.js:144` — `greatCircleMetres()`, **no routing at all** | `{ distanceM, travelSeconds, eMinWh }` | §6.4 pruning | **NO — §20.3 item 1: *"`LB` deliberately requires no routing of either population"*** |
| 8 | **Cell-level expansion floor** | ring distance, H3 resolution | `candidates/expansion.js:152` — cell-boundary geometry | minimum possible distance | Tier 4 regional sweep | **No** |
| 9 | **Exact route evaluation (F28)** | `plan.route` | *(no producer exists)* | `route.profileKey`, `route.loaded`, `route.surfaceClasses` | Tier 0 predicate F28 | **YES — and unsatisfiable today (N26)** |
| 10 | **Zone traversal (F27)** | `plan.route.zonesTraversed` | *(no producer exists)* | traversed-zone list | Tier 0 predicate F27 | **YES — N26** |
| 11 | **Zone-window traversal (F30)** | `plan.route.zoneTraversals[{ enterMs, exitMs, restrictions }]` | *(no producer exists)* | per-zone windows | Tier 0 predicate F30 | **YES — N26** |
| 12 | **Constrictions (F29)** | `plan.route.constrictions[{ widthMm, heightMm, kerbHeightMm, gradientPct, liftCapacityKg }]` | *(no producer exists)* | route envelope profile | Tier 0 predicate F29 — *"Indeterminate: `DENY`"* | **YES — N26; also requires elevation/gradient from the engine** |
| 13 | **Connectivity dead zones (F15)** | `plan.route.deadZoneExtentM` | *(no producer exists)* | metres of dead zone | F15 supervision clause | **YES — N26** |
| 14 | **Distance / time / cost semantics** | `distanceM` (metres), `travelSeconds`, `travelSdSeconds` | `cost/cDirect.js:151`, `cost/cLifecycle.js:258`, `energy/consumption.js:309` | int64 **milli-CU** (ADR-01, §9.6 item 1) | `Φ`, the objective | **YES — but the adapter returns physics, never CU** (§32.5) |
| 15 | **Failure semantics** | router throw / missing field | `cellPairCache.js:198–210` returns `{ ok:false, reason }`; **never a guess** | a reported failure | The round decides; §18.3 B6 uniform treatment | **YES** |
| 16 | **Timeout semantics** | §5.2: 150 ms matrix hard, 400 ms path hard | *(no implementation)* — `route.matrix_timeout` / `route.path_timeout` **unregistered** (§6) | — | §5.2 degradation ladder | **YES — behind Phase 8** |
| 17 | **Concurrency** | one matrix per cell cluster, shared across the cluster's Legs | §20.3 item 4; `b1Benchmark.js:331–344`, 25 clusters | 25 engine queries serving 100 000 cache reads | The amortisation block | **YES** |
| 18 | **Determinism / reproducibility** | identical `(cells, profile, bucket)` | *(nothing measures it)* | must be identical | §9.6 acceptance test: replay reproduces the allocation and per-candidate costs **byte-for-byte** | **YES — and §27 D-c records that no B1 row covers it** |
| 19 | **Benchmark instrumentation** | §20.1 targets via `observability/sli.js` | `b1Benchmark.js` `ATTRIBUTION.ENGINE` / `CACHE_PATH` / `HARNESS_ARTIFACT` | six rows, four thresholds | The B1 decision | **YES — only `ENGINE` rows can rule a candidate out** |
| 20 | **Calibration** | straight line vs network route, per region | *(needs a deployed engine)* | `route.degraded_max_radius` (resolves **`null`** today), `route.degraded_reserve_factor` (1.4) | 2 of the 39 Safety-class parameters | **YES — and also behind D1** |
| 21 | **Shadow execution** | travel times | shared composition root — **absent** | — | `shadow_agreement` gate | **YES — behind B1 entirely** |
| 22 | **Production execution** | everything above | `src/engine/routing/client.js` — **absent** | — | `scale_targets`, `invariants_enforced`, `soak` | **YES — behind B1 entirely** |
| 23 | **Legacy hot path (still live)** | task origin/destination | `src/services/mapbox.service.js`, required by `src/services/routing.service.js:15` and `src/services/task.service.js:51` | Mapbox Directions / Matrix | The legacy DTARO assignment path | **The ADR-11-rejected alternative, still wired (N30)** |

**Twenty-three consumers. Rows 7 and 8 are the only two that are structurally engine-free**, and
that is by design — §20.3 item 1 makes the admissible bound routing-free precisely so that pruning
is affordable before any engine is called. Rows 5 and 6 are engine-independent by key discipline.
**Every other row changes behaviour when the engine changes**, which is what makes the adapter
seam load-bearing rather than decorative.

#### 32.3.2 The four existing routing abstractions, audited

Every routing interface, adapter, engine wrapper, mock, test implementation and candidate-engine
reference in the tree. **Four exist. No two of them share a `route` shape.**

| # | Abstraction | Location | Signature | Notes |
|---|---|---|---|---|
| **A1** | **Benchmark adapter contract** *(the only thing called "the adapter contract")* | `tools/routing/b1Benchmark.js:84–98` | `{ id, description, matrix({ originCellId, destCellIds, profileKey, timeBucket }), nearestChargers({ destCellId, profileKey, timeBucket, k }) }`, plus an undocumented `profile: { energyWhPerMetre, speedMetresPerSecond }` read at `:635–636` | Batched. Object arguments. **Cell-in, cell-out** |
| **A2** | **Cell-pair read-through router** | `cellPairCache.js:164–210`, `deps.route` | `route(parts) → { distanceM, travelSeconds, travelSdSeconds }` where `parts = { originCell, destCell, profileKey, timeBucket }` | **One pair, not a matrix.** Different field names (`originCell` vs `originCellId`) |
| **A3** | **Charger-reachability precompute router** | `chargerReachabilityCache.js:277–292`; worker at `chargerReachability.worker.js:33` | `route(cellId, profileKey, timeBucket) → charger[]` | **Positional arguments. `k` is never passed to the router** — it is applied afterwards by `buildEntry`'s `.slice(0, k)` |
| **A4** | **Test implementation (`stubEngine`)** | `tests/engine/routingB1Benchmark.test.js:30–58` | Implements A1 exactly, incl. `profile` | Self-described: *"in-process stub; not a routing engine and not a candidate"*. The only existing implementation of any contract |

**Candidate-engine references in code: five, all in one file.** `b1Benchmark.js:6, 7, 89, 107, 585`
name OSRM / Valhalla / GraphHopper / in-house. There is **no** OSRM, Valhalla or GraphHopper client,
config, container definition, extract, or fixture anywhere in the tree. Verified by grep across
`src/`, `tools/` and `tests/`.

#### 32.3.3 ARCHITECTURE CONTRACT vs ACTUAL CODE CONTRACT — six mismatches

Recorded as findings, continuing this document's numbering (§30.5 ended at N23).

> **N24 — the adapter contract covers two of the Routing Service's five catalogued capabilities.**
> `src/engine/ARCHITECTURE.md:90` defines the §3.2 Routing Service as *"Travel time, distance,
> **geometry, matrices, elevation**"*, mapped to `client.js`, `cellPairCache.js`,
> `chargerReachabilityCache.js`, Phase 8. A1 exposes **matrices** (and the travel time and distance
> inside them) and nothing else: **no path/geometry query and no elevation query.** §5.2 gives the
> path query its own dependency row, its own 400 ms hard timeout and its own degradation (*"Cached
> path; then corridor-following fallback"*), and grep confirms **no `path()` in any contract, no
> consumer in `src/`, and no registered `route.path_timeout`.** Elevation is not optional either —
> F29 checks `gradientPct` against `maxGradientPct` (`f29.js:49`) and §15.5 makes inclines a
> routing constraint. **Consequence: a candidate benchmarked through A1 is measured on one of
> §5.2's two routing rows.** An engine could pass every `ENGINE` row and be unable to serve the
> path query at all.

> **N25 — three mutually incompatible `route` shapes, and no translator.** A1 is batched with object
> arguments; A2 is single-pair with object arguments and different field names; A3 is positional and
> drops `k`. **An adapter written to the A1 header contract cannot be handed to either shipped cache
> without a translating client**, and that client — `src/engine/routing/client.js` — does not exist
> (§6, re-verified this pass: `src/engine/routing/` holds exactly `cellPairCache.js`,
> `chargerReachabilityCache.js`, `inProcessCache.js`, and `.gitkeep`). This is not a defect in any
> of the three; it is the missing Phase 8 component, and it means **Step 2's deliverable is a
> benchmark adapter, not a production one.**

> **N26 — the exact-route contract the Tier 0 feasibility gate reads is produced by nothing.** Five
> predicates read `plan.route` fields that appear in **no** adapter, in **no** cache entry, and in
> **no** producer anywhere in `src/`: `route.surfaceClasses` + `route.profileKey` + `route.loaded`
> (F28, `f28.js:76–96`), `route.zonesTraversed` (F27, `f27.js:59`), `route.zoneTraversals` with
> `{ enterMs, exitMs, restrictions }` (F30, `f30.js:58`), `route.constrictions` with five envelope
> dimensions (F29, `f29.js:83`), `route.deadZoneExtentM` (F15, `f15.js:77`). `cellPairCache.buildEntry`
> carries exactly `{ distanceM, travelSeconds, travelSdSeconds, profileKey, timeBucket }` — none of
> them. F27's header states the consequence exactly: *"A plan with no traversed-zone list is
> `INDETERMINATE`, never satisfied … an absent list means the routing service did not say."*
> **Whether route attribution is the engine's output or the routing client's composition of engine
> path + Map service (§5.2's separate row, B6's data source) is undecided — and it is a Phase 8 + B6
> question, not D4.** It does not block freezing D4; it blocks calling A1 "the adapter contract"
> without qualification.

> **N27 — A1's boundary is cell-in/cell-out, so each candidate adapter would carry its own spatial
> projection.** No routing engine accepts an H3 index. Under A1 every adapter must resolve
> `cellId → representative coordinate` itself, which (a) duplicates one function across every
> candidate, (b) puts that resolution **inside the timer** that produces the `ENGINE`-attributed
> `approach_routing_matrix` row, and (c) leaks the spatial-index primitive (B5/§27 item 1) into a
> boundary that §32.5 otherwise keeps engine-facing. The projection itself is region-free —
> `h3.cellToLatLng` is a pure function of a valid H3 index, and `h3-js@4.5.0` is already a
> dependency (§30.4 G2) — so this is a **contract choice, not a blocker**, and the ADR should make
> it explicitly rather than inherit it from a benchmark file's header.

> **N28 — `timeBucket` is a required key component with no producer.** It appears 21 times in
> `src/`, and every one is a consumer or a pass-through: both cache modules, `inProcessCache.js`,
> `calibration.worker.js:63` (as a slice label) and `chargerReachability.worker.js:33,65,89`
> (forwarded from its caller). **Nothing derives a bucket from the round's pinned decision time.**
> Both caches are right to take it as an input — `cellPairCache.js` states *"a cache keyed on a
> locally-read clock would return different entries to two workers in the same round"* — but the
> derivation has to live somewhere, and today it lives nowhere. It belongs to the same composition
> root that is absent. Recorded here because §32.5's time-semantics clause depends on it.

> **N29 — the benchmark converts "the engine did not say" into "zero variance".**
> `b1Benchmark.js:356` writes `travelSdSeconds: answer.travelSdSeconds ?? 0`, while
> `cellPairCache.buildEntry` **requires** a finite non-negative `travelSdSeconds` and rejects the
> entry without one. The `?? 0` therefore rescues a silent adapter — and 0 means *"this ETA is
> certain"*, which is the optimistic direction. §8.4 prices `p_late` *"from the ETA predictive
> distribution, not the point estimate"*, and `cellPairCache`'s own header states that a cache
> storing only a mean *"would make punctuality unpriceable for every cached pair — which is every
> pair in steady state"*. An engine that cannot supply a spread must have one supplied from a named
> source, and **the coalesce hides exactly that question at benchmark time**. One line, in a tool,
> owned by whoever performs Step 2.

> **N30 — B1's closing procedure has no step for retiring the rejected alternative.**
> `src/services/mapbox.service.js` is live and required by `src/services/routing.service.js:15`
> (`directionsPolyline`) and `src/services/task.service.js:51` (`directionsWithDistance`). §6.1 B1
> names it — *"The current Mapbox dependency is explicitly incompatible with the hot path"* — and
> ADR-11 records the metered external API in the hot path as the **rejected** option. The five
> closing steps at `b1Benchmark.js:584–593` deploy, adapt, measure, cost and choose; **none of them
> removes it.** It is a legacy-path dependency and not an `src/engine/` defect, so it is not a Tier 0
> finding — but it is a cutover step that no document currently owns.

---

### 32.4 Candidate Engines

**The authoritative candidate list, verified in two frozen documents:** `NEXT_GENERATION_ASSIGNMENT_ENGINE.md:5573`
(§27 item 2) and `IMPLEMENTATION_EXECUTION_PLAN.md:956` (§6.1 B1), both stating **OSRM, Valhalla,
GraphHopper, or in-house**, both requiring per-profile contraction hierarchies, and both making
self-hosting non-negotiable (§5.2, ADR-11).

**This audit does not rank them, and the reason is a rule rather than a reticence.** The brief
forbids evaluating engines by marketing claims; the repository contains **zero** capability evidence
about any of the four (§32.3.2); and `b1Benchmark.js:549–552` states the discipline in its own
words: *"This measurement can rule an engine OUT; it cannot rule one IN."* Ranking four engines from
outside the repository would be exactly the invented evidence this programme's other decisions were
protected from. **The architecture has not selected an engine and this pass does not select one.**

What the architecture *has* completed is the **filter**, and what D4 ratifies is its second clause.
The full requirement set the repository actually imposes on a candidate — every row traceable to a
module, a target or a specification section, so that Step 3 measures against a list rather than an
impression:

| # | Requirement | Repository source | Ruled on by |
|---|---|---|---|
| R1 | **Self-hosted, offline-operable**; no metered per-request API in the hot path | §5.2; ADR-11 "Rejected: Metered external API in the hot path" | Procurement — non-negotiable |
| R2 | **Per-profile contraction hierarchies** or equivalent precomputation | §20.3 item 5: *"the precomputation is the optimisation"*; `b1Benchmark.js:586–587`: *"an engine measured without it is not measured"* | Step 1 |
| R3 | **Bounded-region operation from a cut extract**, colocated with the shard | §5.2 *"colocated with the shard"*; §3.5 sizing | Step 1 — **behind D1** |
| R4 | **Batched matrix query**, one matrix per cell cluster | §20.3 item 4; `b1Benchmark.js:331–344` | Step 3 — `approach_routing_matrix` < **20 ms p99** |
| R5 | **Nearest-`k` query** from a cell to chargers, `k` = `route.charger_reachability_k` = **5** | §20.3 item 3; `chargerReachabilityCache.buildEntry` | Step 3 — `charger_reachability_miss` < **2 ms p99** |
| R6 | **Distance in metres and travel time in seconds**, both finite and non-negative | `buildEntry` validators in both caches | Contract — §32.5 |
| R7 | **A travel-time spread**, not only a mean | §8.4 `p_late`; `cellPairCache.js` header; **N29** | Contract — source must be named |
| R8 | **Least-cost semantics under the profile's own edge costs** (a profile *is* a permission set plus a speed model) | §5.1 of the prerequisite report; §2.2 | **Behind D3** |
| R9 | **Restrictions honoured per profile** — road class, surface, stairs, gradient | `MOB-SIDEWALK-DEFAULT.permissionSet`; F28; F29 | Step 3 + N26 |
| R10 | **Deterministic output** — identical query, identical result | §9.6 acceptance test, byte-for-byte replay | **Unmeasured — §27 D-c** |
| R11 | **Path / geometry query** with a 400 ms hard budget | §5.2 row 2; `ARCHITECTURE.md:90` | **Not in A1 — N24** |
| R12 | **Elevation / gradient attribution** | F29 `gradientPct`; §15.5; `ARCHITECTURE.md:90` | **Not in A1 — N24** |
| R13 | **A bounded, reported snap radius** — a point outside the extract must fail, not silently snap | Derived: the same failure class `assertVersionInKey` exists to prevent (a plausible wrong answer) | Contract — §32.5 |
| R14 | **Hierarchy build time and extract refresh cadence disclosed** as operational costs | `b1Benchmark.js:590–591` — *"they do not appear in §20.1 and they are operational costs the decision must carry"* | Step 4 — **behind D1 + D8** |
| R15 | **Multi-modal networks** — *if and only if D4 says so* | §27 item 2 | **This is D4** |

**R15 is the whole of D4's effect on this table.** Fourteen of the fifteen requirements are
invariant to D4's answer; one is D4. That is the precise measure of what ratifying D4 changes.

---

### 32.5 Adapter Contract

The minimum engine-neutral interface B1 Step 2 requires. **This is the benchmark adapter contract
(A1), hardened** — it is not the production routing client, which is Phase 8's and is blocked by
N25/N26 as well as by B1. Every clause is grounded in a shipped module, a registered parameter or a
frozen specification section; nothing below is invented.

#### Inputs

| Field | Frozen value | Source |
|---|---|---|
| **Origin representation** | `originCellId` — an **opaque cell token supplied by the published map**, never parsed for geometry by the caller | `spatial/cells.js:68`; `inProcessCache.js` property 2 |
| **Destination representation** | `destCellIds[]` for `matrix()`; `destCellId` for `nearestChargers()` | `b1Benchmark.js:92,95` |
| **Routing options** | `profileKey` — **exactly** `mobilityModel.routingProfileKey(model, { loaded })` = `` `${modelId}:${domains}:${loaded?"loaded":"unloaded"}` ``, domains filtered to recognised values, de-duplicated and **code-unit sorted** | `mobilityModel.js:95–98` |
| **Cost mode** | The profile **is** the cost mode. There is no second selector: `:loaded` and `:unloaded` are distinct profiles because §15.5 makes mass and CoG limit traversable inclines, *"which is a routing constraint"* | §15.5; `mobilityModel.js` |
| **Time** | `timeBucket` — an opaque scalar **supplied by the caller** from the round's pinned decision time. The adapter MUST NOT read a clock | §9.6 item 4; both cache headers; **N28** |
| **`k`** | `nearestChargers` only; `route.charger_reachability_k` = **5** | register, resolved live |
| **Required guard** | The client **MUST call `mobilityModel.validateModel()` before it keys.** `routingProfileKey()` is *total*: an absent `modelId` or unrecognised domain yields the literal `"unknown"`, so two differently-broken models both key `unknown:unknown:unloaded` and **share cache entries** | §22.8 — this requirement belongs in the D4 ADR |

**Open contract choice the ADR must make (N27):** whether the `cellId → coordinate` projection sits
**inside** each adapter (A1 as written) or **in the routing client**, with the adapter taking
WGS-84 coordinates. **Recommendation: in the client** — one implementation instead of four, the
`ENGINE`-attributed timer then brackets the engine rather than the engine plus an H3 call, and B5's
spatial primitive stops leaking into every candidate. This changes `b1Benchmark.js`'s header
contract and is therefore a Phase 8 change, not a Step 2 change.

#### Outputs

| Field | Unit | Required? | Source |
|---|---|---|---|
| `destCellId` / `chargerId` | identifier | **Yes** | `b1Benchmark.js:92,95` |
| `distanceM` | **metres**, finite, ≥ 0 | **Yes** | `cellPairCache.buildEntry`, `chargerReachabilityCache.buildEntry` |
| `travelSeconds` | **seconds**, finite, ≥ 0 | **Yes** | same |
| `travelSdSeconds` | **seconds**, finite, ≥ 0 | **Yes — matrix only.** Not defaultable to 0 (**N29**); if the engine cannot supply it, the ADR must name the source | §8.4; `cellPairCache.js` header |
| `chargerClass`, `isDepot` | — | Optional; accepted and carried | `chargerReachabilityCache.js:165–170` |
| **Cost** | **NOT RETURNED** | The adapter returns physics, never CU. Cost is int64 **milli-CU** and is computed downstream by `cost/cDirect.js:151` from timeline seconds and distance metres | ADR-01; §9.6 item 1 |
| **Route status** | **Required and currently missing** — see Failure below | — | — |
| **Engine metadata** | `id` and `description` only, and `description` must state *"deployment shape, extract, profiles, hierarchy build time"* | `b1Benchmark.js:89–90` |

**Energy is not an adapter output either.** `energyWh` is derived by `buildEntry` as
`distanceM × energyWhPerMetre` from the **profile's** constants, which `b1Benchmark.js:632–636`
deliberately keeps off the register: *"they describe the vehicle the candidate engine is routing,
and a benchmark that resolved them from the engine's config would be measuring the config."*

#### Failure

**The contract as written cannot distinguish six conditions that must be distinguished**, because
an omitted matrix entry and a thrown error are the only two signals it has. §18.3 B6's
uniform-treatment rule makes the distinction load-bearing: *"if any candidate's route is
unavailable, all candidates in that decision use the degraded estimator"*, which exists to prevent
a candidate scoring best because its data was missing. The six, and where each is answered today:

| Condition | Required adapter behaviour | Shipped today |
|---|---|---|
| **No route** (genuinely unreachable) | Return the destination with an explicit no-route status. **Never omit silently, never fabricate a distance** | Omission only — indistinguishable from an error |
| **Timeout** | Hard abort at §5.2's budget — **150 ms matrix, 400 ms path**, `AbortController`-equivalent | Unimplemented; `route.matrix_timeout` and `route.path_timeout` **unregistered** (§6) |
| **Malformed request** | Reject before querying; never substitute a default | `key()` in both caches refuses an incomplete key with a reason |
| **Unavailable engine** | Raise; the **client** then walks §5.2's ladder — cached matrices → geometric bound × detour factor, with `route.degraded_max_radius` (resolves **`null`**) and `route.degraded_reserve_factor` (1.4) | `cellPairCache.js:198–210` reports the failure and explicitly leaves the choice to the round |
| **Extract miss** (point outside the cut region) | **Must fail with a reason.** A silent snap to the nearest edge answers plausibly and wrongly — the failure class `assertVersionInKey` exists to prevent. Snap radius must be bounded and reported (R13) | Not expressible |
| **Internal engine failure** | Distinct from no-route; triggers the ladder | Not expressible |

**The ADR must therefore add a status discriminator to the contract.** That is a contract addition,
not an engine choice, and it is the single most valuable change Step 2 could carry.

#### Determinism

**Identical requests MUST produce identical results. This is a hard requirement, not a preference.**
§9.6's acceptance test: *"replaying any stored decision record MUST reproduce the identical
allocation and identical per-candidate costs, byte-for-byte"*, as a continuous test over production
decisions (§24.3). Travel times enter `Φ` through the timeline, so a non-deterministic engine breaks
replay outright. **No current benchmark row measures it** — recorded already as §27 D-c
(*"Engine determinism … No row in the current B1 tool covers it"*). The ADR must make R10 an
acceptance criterion of Step 3, and Step 2's adapters must not introduce non-determinism of their
own (no unordered map iteration, no ambient clock, no unseeded sampling — §9.6 items 2, 4, 7).

#### Units — frozen explicitly

`distanceM` **metres** · `travelSeconds`, `travelSdSeconds` **seconds** · `k` **count** ·
`route.intra_cell_offset_m` **metres** (250, PROVISIONAL, added never subtracted, in both distance
and time) · `route.cell_pair_cache_ttl` **900 s** · cost **int64 milli-CU, downstream only** ·
`perf.approach_routing_matrix_p99` **20 ms** · `perf.charger_reachability_miss_p99` **2 ms** ·
`perf.charger_reachability_cached_p99` **10 µs** · `perf.cost_per_candidate_p99` **100 µs**.
All resolved live from the register this pass.

#### Time semantics

**Time-dependent routing is NOT required of the engine, and this materially widens the candidate
set.** §20.3 item 6 is explicit: congestion is *"a multiplier layer on cached free-flow times,
updated per time bucket per road class, rather than re-routing on every congestion update."* The
engine therefore supplies **free-flow** distance and time; `timeBucket` is a cache-key discriminator
and the layer's index, not a query parameter the engine must interpret. Candidates need not support
time-dependent contraction hierarchies. **Caveat N28:** nothing in `src/` derives the bucket yet, so
the multiplier layer has an index with no producer — it belongs to the absent composition root.

#### Cache semantics

**Caching belongs OUTSIDE the adapter, at the two levels that already exist. No second cache is
invented here, and none may be added inside an adapter.**

```
round  ──►  L1  routing/inProcessCache.js        in-round, in-process, namespaced, LRU, clock-injected
              │   (kv-shaped façade — composes in front of the two caches unchanged)
              ▼
            L2  the cross-round kv (Redis in the shipped configuration)
              │
              ▼
       cellPairCache / chargerReachabilityCache   §20.3 items 2–3 key discipline
              │
              ▼
            routing client  ── §5.2 timeouts + degradation ladder ──►  ADAPTER  ──►  ENGINE
                                                                       (no cache)
```

Two reasons the adapter must hold no cache, both from shipped code. **First, measurement:**
`b1Benchmark.js` attributes `approach_routing_matrix` and `charger_reachability_miss` to
`ATTRIBUTION.ENGINE` because *"the timer brackets a call into the adapter"* — an adapter-internal
cache would make those rows measure the adapter, invalidating the only rows that can rule a
candidate out. **Second, correctness:** an adapter-internal cache is un-keyed by profile, time
bucket and `charger_availability_version`, which is exactly the stale-answer failure §20.3 item 3's
key discipline exists to prevent — *"an entry computed against one availability projection is never
silently applied under another."*

**The contraction hierarchy is not a cache.** It is engine-internal precomputation, it is required
(R2), and it is the reason routing must be self-hosted at all.

---

### 32.6 D4 → B1 Dependency

#### Can D4 be frozen without D1? — **YES. Proof, not estimate.**

D4's decision variable is a member of a closed four-value enum. The proof is that **no term in
that decision, in its inputs, or in its stated dependency is a function of a place.**

| # | Claim | Evidence |
|---|---|---|
| 1 | **The decision variable is region-free.** `TRAVERSAL_DOMAIN` is a frozen enum of four network identifiers with no spatial parameter | `mobilityModel.js:47–52` |
| 2 | **The key D4 shapes carries no region term.** `routingProfileKey = modelId:domains:loaded` — three components, none spatial. §30.1.1 row 15 already recorded: *"Nothing from D1 directly"* | `mobilityModel.js:95–98`; §30.1.1 |
| 3 | **D4's stated dependency is not a spatial one.** §27 item 2 depends on **"Modality roadmap"**. The row whose dependency is **"Site mix"** is §27 item **1**, the spatial-index primitive (B5) — a different decision, already settled at H3 res 8/5 (§21.2 C1) | `NEXT_GENERATION_ASSIGNMENT_ENGINE.md:5572–5573` |
| 4 | **The `INDOOR_GRAPH` exclusion is a mechanism argument, not a site-count argument.** §6.2 makes indoor a *per-region proximity partition* implemented as site-local graph zones — *"not something an OSM engine provides"*. That is true of every region, so knowing which region cannot change it | §6.2; §22.5 |
| 5 | **The `AIRSPACE_VOLUME` exclusion is a modality fact.** §25.2 lists UAS under *"Additions required: 3D routing with airspace volumes"*. Whether the fleet flies is not a property of where it operates | §25.2 |
| 6 | **Including `ROAD_GRAPH` costs the procurement nothing.** The same OSM extract serves sidewalk and road, so the inclusion changes the **profile count** (`models × 2 × regions`), not the candidate set and not the extract | §5.1 of the prerequisite report |
| 7 | **The adapter contract D4 unblocks is region-free.** A1 takes **opaque cell tokens**; `spatial/cells.js:68` states cell ids are *"parsed for geometry"* nowhere, which is *"what keeps this module independent of B5"* | `b1Benchmark.js:84–98`; `cells.js:68` |

**Conclusion: no coordinate, no polygon, no CRS, no bounding box, no extract, no region kind and no
cell set is an input to D4.** D1 and D4 are independent decisions that meet only at Step 1, where
an extract and a domain scope are *both* required to build a hierarchy.

**One honest asymmetry, recorded rather than smoothed over.** D1's answer cannot change D4's
content, but it can change D4's **applicability**: if D1 returns *"site"* with a purely indoor
footprint, B1's outdoor geodesic engine would serve nothing, and the right response would be that
B1 does not apply — not that D4 was wrong. The ADR should therefore state its scope conditionally
(*"for outdoor operation"*), which costs one clause and removes the only way D1 could embarrass it.
This is a **SOFT** relationship in the applicability direction and **NO DEPENDENCY** in the decision
direction.

#### What freezing D4 does and does not release

| Released by D4 alone | Still blocked after D4 |
|---|---|
| The **validity of the §27 item 2 shortlist** — under the recommendation, the four named OSM engines stand; under a multi-modal scope they may not | Deploying any candidate (**D1** — no extract) |
| **B1 Step 2** — writing one benchmark adapter per candidate (§32.7) | Building hierarchies (**D1** + **D3** — no graph, no speed model) |
| **D7**, decided or explicitly deferred in the same ADR (§22.8) | Running the tool, recording any row (**D1** — all six rows need a deployed engine) |
| The **validate-before-key** rule that closes the `unknown:unknown:*` cache-aliasing edge (§22.8) | Steps 4 and 5 (**D1**, **D8**, and the evidence Steps 1–3 produce) |
| The **profile-set shape** (`domains` component of every cache key) | The profile-set **content** (**D3** — the speed model is a stub) |

---

### 32.7 B1 Step 2 Readiness

#### What "write one adapter per candidate engine" authoritatively means

The wording is `tools/routing/b1Benchmark.js:588`, in the five-step closing procedure:

> 1. Deploy each candidate engine (OSRM / Valhalla / GraphHopper / in-house) against the target
>    region extract, with per-profile contraction hierarchies BUILT …
> **2. Write one adapter per candidate to the contract in this file's header.**
> 3. Run this tool per candidate on representative hardware and record every row.
> 4. Record the hierarchy build time and the extract refresh cadence per candidate …
> 5. Choose on the recorded evidence and write the ADR.

**The answer is D — implement executable adapters for all candidates, for benchmarking.** Not A
(skeletons cannot be run by Step 3), not C (the adapters exist to *produce* the evidence that
selects the winner, so selecting first inverts the procedure), and not B in the production sense —
"the contract in this file's header" is **A1**, the benchmark contract, which N24/N25/N26 show is a
proper subset of the production routing client's surface.

**Precisely: Step 2 delivers four executable benchmark adapters, one per candidate, implementing
`{ id, description, profile, matrix(), nearestChargers() }`, which Step 3 runs against engines that
Step 1 deployed.** They are real code with real HTTP or library calls; they are not the production
routing client and must not be represented as progress toward it.

#### Component classification

| Component | Status | Basis |
|---|---|---|
| **The ADR text freezing D4** | **READY NOW** | §22.5: *"One ADR line stating B1's domain scope and explicitly excluding what it excludes."* §32.10 supplies it |
| **The adapter contract hardening** (status discriminator, `travelSdSeconds` source, projection boundary) | **READY NOW** — decision; **WAITING FOR OTHER DECISION** — Phase 8 to land it in the tool | §32.5; N27, N29 |
| **Adapter module structure per candidate** (`id`, `description`, `profile`, both methods) | **WAITING FOR D4** | The shortlist's validity is D4's (§30.6.2, §32.6) |
| **Engine query mapping** — each candidate's documented matrix / nearest-k API onto A1 | **WAITING FOR D4**, then READY | No repository dependency; verification against a live engine is Step 3's |
| **`cellId → coordinate` projection** | **WAITING FOR OTHER DECISION** (N27: adapter or client). The mechanism needs only a valid H3 index — `h3-js@4.5.0` present, D2 closed at res 8/5 | N27; §21.2 C1; §30.4 G2 |
| **Adapter unit tests against a faked transport** | **READY NOW** — `stubEngine` (A4) is the working precedent | `tests/engine/routingB1Benchmark.test.js:30–58` |
| **Running any adapter against a real engine** | **WAITING FOR D1** (via Step 1) | §30.6.1 — no extract, no graph, no hierarchy |
| **Recording any of the six §20.1 rows** | **WAITING FOR D1** — the tool correctly reports `NOT_MEASURED` and exits 0 | §30.6.2 |
| **A determinism row for the tool (R10 / §27 D-c)** | **READY NOW** to design; **REQUIRES EXTERNAL ARTIFACT** to measure | §9.6; §27 D-c |
| **`src/engine/routing/client.js`** | **WAITING FOR OTHER DECISION** — Phase 8 ownership, plus N25/N26, plus registering `route.matrix_timeout` / `route.path_timeout` / the detour factor under §22.1 | §6; `ARCHITECTURE.md:90` |
| **Route attribution producer** (F27/F28/F29/F30/F15 fields) | **WAITING FOR OTHER DECISION** — Phase 8 + **B6** map data source | **N26** |
| **The §5.2 degradation ladder and its two Safety parameters** | **WAITING FOR D1** (`route.degraded_max_radius` awaits per-region straight-line-versus-network measurements) and **B8** | §6; §7 |
| **Retiring the legacy Mapbox hot path** | **WAITING FOR OTHER DECISION** — unowned; no closing step covers it | **N30** |

#### The B1 readiness table

| B1 Step | Status | Blocking Decision | Can Work Start? | Evidence |
|---|---|---|---|---|
| **1** — Deploy each candidate against the target region extract, hierarchies **built** | **BLOCKED** | **D1** (extract), **D3** (speed model → edge costs) | **No** | `b1Benchmark.js:585–587`; §30.6.1 chain link (a); §22.4 |
| **2** — **Write one adapter per candidate to the contract in this file's header** | **READY THE MOMENT D4 IS FROZEN** | **D4** | **Yes — the only B1 step that can** | `b1Benchmark.js:588`; contract at `:84–98`, region-agnostic; §30.6.2 |
| **3** — Run the tool per candidate on representative hardware, record every row | **BLOCKED** | **D1** (via Step 1) | **No** | All four `ENGINE`/`CACHE_PATH` rows time a call into a deployed engine or a cache it populated |
| **4** — Record hierarchy build time and extract refresh cadence per candidate | **BLOCKED** | **D1**, **D8** | **No** | `b1Benchmark.js:590–591`; §22.9 — both are properties of an extract |
| **5** — Choose on the recorded evidence and write the B1 ADR | **BLOCKED** | Steps 1–4 | **No** | §6.1 makes B1 a decision on recorded evidence, and there is none |

**Unchanged from §30.6.2 and now demonstrated at component granularity: exactly one of five steps
moves without a coordinate, and D4 is the only thing standing in front of it.**

---

### 32.8 Hidden Dependencies

Searched specifically, against the **repository's** D-numbering (§32's preamble records the
brief's differing labels; both readings are answered).

| Decision (repository) | Dependency | Direction and proof |
|---|---|---|
| **D1 — region geometry** | **NO DEPENDENCY** for freezing D4. **HARD** for exercising any adapter (Steps 1, 3, 4) | §32.6, seven-row proof. The two are independent decisions meeting only at Step 1 |
| **D2 — H3 resolution** | **SOFT**, and already closed | Reaches D4 only through N27's `cellId → coordinate` projection, which needs a valid H3 index and nothing else. `H3_RESOLUTION = { FINE: 8, COARSE: 5 }` (`cells.js:181–183`); the residual is D1's, not D4's (§22.3) |
| **D3 — fleet classes and mobility models** | **SOFT for the decision; HARD for the profile set** | `profileKey = modelId:domains:loaded` needs both: **D4 names the `domains` component, D3 names `modelId` and the speed model behind it.** Freezing D4 needs no D3 answer; building a hierarchy does — *"a contraction hierarchy is a precomputation over edge costs and a stub yields none"* (§22.4) |
| **D5 — region/shard count and mission rate `r`** | **NO DEPENDENCY** for the decision; **SOFT** downstream | D4 multiplies the hierarchy count through `models × 2 × regions`; §22.6's H3 records that §3.5's sizing inequality **carries no term for the routing engine's per-shard footprint at all**. That is a sizing gap D4 makes visible, not a D4 input |
| **D6 — where mass and CoG are declared** | **SOFT** | D4 admits `:loaded` profiles, which double the hierarchy count for a distinction *"nothing can currently compute"* — no mass or CoG field exists on `MobilityModel` (§22.7). It also creates an engine requirement: per-profile edge costs must vary with mass (§15.5, F29 `liftCapacityKg`). None of it is an input to D4's answer |
| **D7 — `traversalDomain` as a composition** | **HARD — and inverted.** D7 is behind D4, not the reverse | §22.8. `MobilityModel.traversalDomain` is a scalar `String` column while `traversalDomains()` already supports a composition — *"the code supports §25.3 composition and the schema cannot store one."* If D4 scopes a single domain, D7 is **deferred with a recorded reason**, and the deferral belongs in D4's own ADR |
| **D8 — extract vintage, refresh, re-contraction** | **NO DEPENDENCY** for freezing D4; **HARD** for Step 4 | §22.9. Cadence and re-contraction windows are properties of an extract that does not exist |
| *(brief's reading)* **"D5 cost model"** → ADR-01 / §1.3 | **SOFT** | The adapter returns physics and never CU (§32.5); the profile constants `energyWhPerMetre` / `speedMetresPerSecond` are deliberately off the register (`b1Benchmark.js:632–636`). Cost representation constrains the contract's **outputs**, not D4's answer |
| *(brief's reading)* **"D6 constraints"** → §7.5 feasibility | **SOFT, and it is really N26** | F27/F28/F29/F30/F15 impose a route-attribution contract no abstraction produces. It constrains the **production** client, not D4 |
| *(brief's reading)* **"D8 benchmark policy"** → §20.1 / Q-20.1 | **NO DEPENDENCY** | Q-20.1 (§25.3) is the budget-composition ADR; §27 C3 already records it as not B1-dependent. It does not reach D4 |

#### Apparent D4 dependencies that are actually a different decision

| Appears to be D4 | Actually | Owner |
|---|---|---|
| "Which routing engine do we pick?" | **B1 itself**, decided at Step 5 on Step 3/4 evidence. D4 only validates the shortlist | Procurement + Architecture |
| "What shape is the adapter interface?" | **Phase 8**, `ARCHITECTURE.md:90`. D4 gates *how many* adapters, never *what the interface is* | Phase 8 |
| "Who produces `surfaceClasses`, `zonesTraversed`, `constrictions`?" | **Phase 8 + B6** (map obstruction/attribution data source). **N26** | Phase 8 + Ops |
| "Should the caches' reads be synchronous and pre-parsed?" | **C13**, and it carries **Tier 0** review, not merely Phase 8 (§24.3) | Architecture (Tier 0) |
| "Does the adapter or the client project cells to coordinates?" | A **contract** choice — **N27** — bundled into D4's ADR for convenience, not derived from it | Phase 8 |
| "Is `traversalDomain` a composition?" | **D7**, which is genuinely behind D4 and is decided in the same ADR (§22.8) | Architecture |

---

### 32.9 Decision Status

**D4: READY TO FREEZE. Not DECIDED.**

| Criterion | State |
|---|---|
| Recommendation complete | **Yes** — §5.1 of the prerequisite report; four domains ruled on, each with an evidence row (§32.2) |
| Recommendation supported by repository evidence | **Yes** — §32.3, twenty-three consumers traced; the two exclusions rest on §6.2 and §25.2 mechanism arguments |
| Blocked by D1 | **No** — §32.6, seven-row proof |
| Blocked by any other open decision | **No.** D7 is behind D4, not in front of it |
| Requires external input | **Yes — one input:** an Architecture ratification against the Product modality roadmap |
| Ratified | **NO.** `docs/adr/` holds ADR-01…ADR-32; **zero** mention `traversal`, `TRAVERSAL`, `SIDEWALK` or "domain scope". ADR-11 fixes the routing *mode*, not the domain scope |
| Effect of freezing | Releases **B1 Step 2**, the only B1 step that moves without a coordinate; closes **D7**; closes the `unknown:unknown:*` cache-aliasing edge |

**D4 is the cheapest decision on the Phase 15 board with a non-zero engineering release.** It costs
one ADR file, needs no vendor, no hardware, no budget, no measurement and no coordinate — and it is
the only thing standing between the programme and four adapters' worth of real, reviewable code.

---

### 32.10 Exact ADR Decision

To be recorded as **`docs/adr/ADR-33-b1-traversal-domain-scope.md`**, in the frozen ADR format
(`docs/adr/README.md`), owned by **Architecture**, ratified against the Product modality roadmap.
**Not written by this pass** — §32.11.

> ## Decision
>
> **B1 procures a self-hosted outdoor geodesic routing engine that serves `SIDEWALK_GRAPH` and
> `ROAD_GRAPH` from one OSM extract per region; `INDOOR_GRAPH` and `AIRSPACE_VOLUME` are excluded
> from B1's scope.**
>
> ## Rejected
>
> **Procuring a multi-modal routing platform.** `INDOOR_GRAPH` is a per-region *proximity
> partition* implemented as site-local graph zones (§6.2) and is not something an OSM engine
> provides; `AIRSPACE_VOLUME` is a §25.2 future modality requiring 3D routing with airspace
> volumes. Scoping either into B1 would mis-specify the procurement.
>
> ## Riders — decided in this record, per §22.8
>
> 1. **D7 is deferred, not decided.** `MobilityModel.traversalDomain` remains a scalar column while
>    B1's scope is single-domain-plus-`ROAD_GRAPH`-on-one-extract. `mobilityModel.traversalDomains()`
>    already supports a composition; the schema change is deferred until a modality outside this
>    scope is admitted.
> 2. **Validate before you key.** `routingProfileKey()` is total and yields `unknown:unknown:*` for
>    a model with an absent `modelId` or an unrecognised domain, so two differently-broken models
>    would **share cache entries**. The Phase 8 routing client MUST call `validateModel()` before it
>    keys.
> 3. **Scope is conditional on outdoor operation.** If D1 returns a purely indoor footprint, B1 does
>    not apply rather than this record being wrong.
>
> ## Consequences
>
> The §27 item 2 shortlist — OSRM, Valhalla, GraphHopper, in-house — stands, and the *"multi-modal
> networks"* clause of its filter is **not** applied. **B1 Step 2 is released**
> (`b1Benchmark.js:588`): one executable benchmark adapter per candidate to the contract at
> `b1Benchmark.js:84–98`, hardened per §32.5 of the Phase 15 consolidated report. Steps 1, 3, 4 and
> 5 remain blocked by D1, D3 and D8. This record selects no engine; B1 does that at Step 5 on
> recorded evidence.

---

### 32.11 Implementation Decision — and Why Nothing Was Built

**No implementation was authorized for this task, and none was performed.**

| Candidate work | Performed? | Why not |
|---|---|---|
| Install or configure a routing engine | **NO** | Explicitly prohibited by the brief; §5.2 requires it colocated with a shard, against an extract that does not exist |
| Write any candidate-engine adapter | **NO** | It is **B1 Step 2**, and Step 2 is released *by* D4 — which is not yet frozen. Writing adapters before the ADR would decide D4 by implementation, the exact inversion §22.5 warns against |
| Write `src/engine/routing/client.js` | **NO** | Phase 8 capability; Phase 15 ships none (§6). It also needs three unregistered parameters and a detour factor that is a Safety-relevant calibration value |
| Add the failure-status discriminator to `b1Benchmark.js` | **NO** | It changes the frozen contract other documents cite. It belongs in the ADR first, then to Phase 8 |
| Fix N29's `?? 0` | **NO** | One line, in a tool, and it is Step 2's owner's — recorded, not applied, because this pass changed no source file |
| Write `docs/adr/ADR-33-…` | **NO** | The ADR is **Architecture's** to ratify against a Product roadmap. §32.10 supplies the exact text; drafting it here would be engineering ratifying its own recommendation |
| Add `traversalDomain` composition to the schema | **NO** | **D7**, deferred by rider 1 of the ADR above |
| Touch the solver, calibration, extracts or production config | **NO** | Out of scope in every direction |

**The exact next implementation unit, stated so it can be started the hour D4 is ratified:**

> **`Backend/tools/routing/adapters/osrm.js`** *(then `valhalla.js`, `graphhopper.js`, `inhouse.js`)*
> — one module per candidate exporting `{ id, description, profile, matrix(), nearestChargers() }`
> to the contract at `b1Benchmark.js:84–98` as hardened by §32.5, each with a unit test against a
> faked transport modelled on `stubEngine` (`tests/engine/routingB1Benchmark.test.js:30–58`).
> **Under `tools/`, never under `src/engine/`** — *"Nothing under `src/engine/` gains a dependency
> on it"* (`b1Benchmark.js:100`). They remain unrunnable against a real engine until D1 delivers an
> extract, and that is the honest boundary of what D4 releases.

---

### 32.12 Change Control — Revision 4

**Before this pass** — `git status --porcelain` and `git diff --stat` captured: 69 modified/deleted
tracked files and 25 untracked paths, all pre-existing Phases 6–15 working-tree state carried from
revisions 1–3; `PHASE_15_CONSOLIDATED_REMEDIATION_REPORT.md` **not** among the modified files.

**After this pass** — the only difference is this file:

| Check | Result |
|---|---|
| Files changed by this pass | **Exactly one — `PHASE_15_CONSOLIDATED_REMEDIATION_REPORT.md`** |
| New report created | **No** — §32–§33 appended to the same living record, per the Revision History discipline |
| Existing sections preserved | **Yes** — §1–§31 unmodified except the Revision History table, which gained row 4 and the revision-4 notes |
| Solver changed | **No** |
| Calibration changed | **No** — no register entry added, changed or removed; values in §32.5 were *resolved and read*, never written |
| Routing engine installed or configured | **No** |
| Routing extract created | **No** |
| Adapter implemented | **No** |
| Production configuration changed | **No** — no configuration version published; `snapshot.spatial`, `snapshot.shards`, `bindings` untouched |
| Schema changed | **No** |
| Tests weakened, skipped or deleted | **No — no test file was opened for writing** |
| Commit created | **No** |

**Verification, stated honestly.** This pass changed **no source file**, so the existing
verification baseline stands unchanged: **141 suites / 6 154 tests / 0 failures** as recorded in
§15 and re-confirmed in §28.1. **The full suite was NOT re-run for this pass and no claim is made
that it was.** The only executions performed were read-only diagnostics: `service.defaultSnapshot()`
`.resolve()` calls against eleven `route.*` and `perf.*` parameters, and repository greps. Neither
writes state.

---

## 33. Final Status — Revision 4

```
CURRENT STATUS:
B1:       STILL BLOCKED
PHASE 15: STILL BLOCKED
PHASE 16: NOT READY

D4 STATUS:
READY TO FREEZE
```

**D4 DECISION** *(one sentence, the ADR's `## Decision` clause — §32.10)*:

> **B1 procures a self-hosted outdoor geodesic routing engine that serves `SIDEWALK_GRAPH` and
> `ROAD_GRAPH` from one OSM extract per region; `INDOOR_GRAPH` and `AIRSPACE_VOLUME` are excluded
> from B1's scope.**

**B1 STEP 2:** **READY** — the moment D4 is ratified, and not before.

**CAN PROCEED WITHOUT D1** *(exact work)*:

- **Ratify D4** — one ADR file, `docs/adr/ADR-33-b1-traversal-domain-scope.md`, text supplied
  verbatim in §32.10, including rider 1 (**D7 deferred**) and rider 2 (**validate-before-key**,
  closing the `unknown:unknown:*` cache-aliasing edge).
- **B1 Step 2** — four executable benchmark adapters, `tools/routing/adapters/{osrm,valhalla,graphhopper,inhouse}.js`,
  to the contract at `b1Benchmark.js:84–98` as hardened by §32.5, each with a unit test against a
  faked transport (`stubEngine` is the precedent). **Under `tools/`, never `src/engine/`.**
- **Harden the contract** — add the failure-status discriminator (no-route vs timeout vs extract
  miss vs engine failure, required by §18.3 B6's uniform-treatment rule), name the
  `travelSdSeconds` source and remove the `?? 0` (**N29**), and settle whether the
  `cellId → coordinate` projection lives in the adapter or the client (**N27**).
- Everything §30.7 already lists as parallel-capable: **B8**, the **rollback rehearsal**
  (time-sensitive), **Q-20.1**, **D3**, **D6**, **N16/N17/N18**, **N21/N22**, the 11 worker cadence
  parameters, the `locality` evidence class, the §26 observation window, Ph14 F2.

**STILL BLOCKED BY D1** *(exact work)*:

- **B1 Steps 1, 3, 4 and 5** — deploy each candidate against the target region extract with
  per-profile contraction hierarchies built (also **D3**); run the tool and record any of the six
  rows; record hierarchy build time and extract refresh cadence (also **D8**); choose and write
  the B1 ADR.
- The **OSM region extract** and therefore every **contraction hierarchy**.
- `route.degraded_max_radius` — awaits per-region straight-line-versus-network measurements.
- Publishing a **spatial map**; publishing **shard definitions** (with D5); **D2's residual**.
- Everything already behind B1: `routing/client.js`, the shared composition root, the
  `charger_reachability` worker, `scale_targets`, `shadow_agreement`, `invariants_enforced`, `soak`.

**NEXT ACTION:**

> **Architecture: ratify D4 by committing `docs/adr/ADR-33-b1-traversal-domain-scope.md` with the
> `## Decision`, `## Rejected` and three `## Riders` clauses given verbatim in §32.10.**
>
> It needs no vendor, no hardware, no budget, no measurement and no coordinate — one file, checked
> against the Product modality roadmap — and it releases four adapters' worth of real engineering
> that is otherwise idle behind D1. **§30.8's D1 request to Operations + Commercial remains the
> higher-value action and is unchanged; this is the one that can be done in parallel, today, by a
> different person.**

---

*End of Phase 15 Consolidated Remediation Report, revision 4. No new report was created — this is
the same single living record revisions 1–3 wrote. No repository file was changed other than this
one: no routing engine was installed, no adapter was written, no extract was created, no ADR was
authored, no solver or calibration value was touched, no test was weakened, and no commit was
created.*

---

## 34. D4 Ratified — B1 Step 2 Implemented

**This section supersedes §32.11's "nothing was built" table for exactly the rows D4 released, and
nothing else in §32. Every finding in §1–§33 stands unmodified.**

### 34.1 D4 is ratified

`docs/adr/ADR-33-b1-traversal-domain-scope.md` exists and is `Accepted`. Its `## Decision` clause
is §32.10's, verbatim:

> **B1 procures a self-hosted outdoor geodesic routing engine that serves `SIDEWALK_GRAPH` and
> `ROAD_GRAPH` from one OSM extract per region; `INDOOR_GRAPH` and `AIRSPACE_VOLUME` are excluded
> from B1's scope.**

All three riders of §32.10 are recorded in it: **D7 deferred** with its reason, **validate before
you key** (closing the `unknown:unknown:*` cache-aliasing edge), and **scope conditional on
outdoor operation**. Its `## Consequences` clause releases **B1 Step 2** explicitly, naming the
contract at `b1Benchmark.js:84-98` *"hardened per §32.5"*.

§32.9's row *"Ratified: **NO**"* is therefore superseded: **D4 is RATIFIED, 2026-08-09.** The
record was **not** modified by this pass, and this pass does not reinterpret it.
`docs/adr/README.md` gained a second register table — *integration decisions, numbered 33 upward,
marked `Accepted` rather than `Accepted — frozen`* — with ADR-33 as its first row, in the format
§32.10 specified.

### 34.2 The benchmark contract, verified before anything was written

The frozen contract is `b1Benchmark.js:84-98`. It was audited against §32.5 clause by clause
**before** any adapter was written, on the question the brief asks: does it conflict with the
frozen architecture?

| Clause | Contract as frozen | Verdict |
|---|---|---|
| **Inputs** | `matrix({ originCellId, destCellIds, profileKey, timeBucket })`; `nearestChargers({ destCellId, profileKey, timeBucket, k })` | **Consistent.** Cell tokens are opaque (`cells.js:68`), `profileKey` is `mobilityModel.routingProfileKey`'s output, `k` is `route.charger_reachability_k` resolved by the caller |
| **Outputs** | `[{ destCellId, distanceM, travelSeconds, travelSdSeconds }]`; `[{ chargerId, distanceM, travelSeconds }]` | **Consistent** with both `buildEntry` validators |
| **Units** | metres and seconds throughout | **Consistent**, and now enforced per candidate (§34.3) |
| **No CU** | The adapter returns physics; cost is int64 milli-CU computed downstream by `cost/cDirect.js` | **Consistent.** No adapter returns, accepts or names a cost |
| **Energy** | Derived by `buildEntry` from the profile's constants, kept off the register by `b1Benchmark.js:632-636` | **Consistent.** Each adapter declares `profile { energyWhPerMetre, speedMetresPerSecond }`; none resolves them from a register |
| **Engine metadata** | `id` and `description` only, `description` stating deployment shape, extract, profiles, hierarchy build time | **Consistent.** Each adapter assembles exactly that string from operator-supplied text, plus `availability` (§34.6) |
| **Cache placement** | Outside the adapter, at the two shipped levels; none inside | **Consistent.** No module under `tools/routing/adapters/` holds a cache of any kind |
| **Determinism** | R10 / §9.6 byte-for-byte replay | **Consistent, and now testable.** No adapter reads a clock, samples, or depends on completion or map-iteration order |
| **Failure semantics** | *"an omitted matrix entry and a thrown error are the only two signals it has"* | **INSUFFICIENT — §32.5's own finding, unchanged.** Six conditions, two signals. Resolved at the adapter layer (§34.6), **not** by moving the header contract |
| **Timeout semantics** | §5.2's 150 ms matrix / 400 ms path; `route.matrix_timeout` and `route.path_timeout` **unregistered** | **Absent from the contract, as §32.5 records.** Supplied per adapter through configuration; **no parameter was registered and no default was invented** |
| **Status discriminator** | Absent | **Added at the adapter layer only** (§34.6) |

**No conflict with the frozen architecture was found, and the contract at `:84-98` was not
altered.** The two gaps §32.5 already recorded — failure semantics and timeout semantics — are
answered *around* the contract rather than *in* it, for the reason §32.11 gives: landing them in
the header is a Phase 8 change to a contract other documents cite by line. **ADR-33 cites
`b1Benchmark.js:84-98` and `:588`; both line ranges are byte-identical after this pass.**

### 34.3 What was implemented

Eight modules under `Backend/tools/routing/adapters/` — **under `tools/`, never under
`src/engine/`**, per `b1Benchmark.js:100` (*"Nothing under `src/engine/` gains a dependency on
it"*).

| Module | What it is |
|---|---|
| `contract.js` | The engine-neutral layer: `ROUTE_STATUS`, `AVAILABILITY`, `AdapterError`, configuration validation, request validation, output normalisation, nearest-`k` ordering, the hard timeout, and `assertSelfHosted` |
| `transport.js` | The one place an adapter touches a socket. Injected everywhere, so no test opens one. It resolves for every HTTP status, because a 400 from a routing engine is usually a *routed* answer |
| `deployment.js` | The **D1/D8 configuration seam**: one environment variable, `ROUTING_B1_DEPLOYMENT`, naming a module the operator writes. Unset ⇒ every candidate `NOT_DEPLOYED` |
| `osrm.js` | Table service `GET /table/v1/{profile}/…`, `sources=0`, `annotations=duration,distance`, `radiuses=` |
| `valhalla.js` | `POST /sources_to_targets`, explicit `costing` and `units`, per-location `radius`, answers keyed by `to_index` |
| `graphhopper.js` | `GET /route`, N-query fan-out — **the open-source server ships no matrix endpoint and the hosted one is barred by R1** |
| `inhouse.js` | `NOT_IMPLEMENTED`, carrying the search that established it |
| `index.js` | The candidate roster: discovery and selection, **never ranking** |

**Three seams carry everything this repository must not invent.** `projectCell` (**N27** — one
implementation injected, not four duplicated, and relocatable to the Phase 8 client without
touching an adapter), `chargerCatalogue` (a routing engine does not know where chargers are), and
`deployment` (extract identity, vintage, profiles built, hierarchy build time — **D1** and **D8**,
carried verbatim as operator strings and chosen nowhere). An adapter given none of them **does not
construct**; it does not substitute a default.

### 34.4 Candidate status

| Candidate | Adapter | Availability | Basis |
|---|---|---|---|
| **OSRM** | **IMPLEMENTED**, executable | `NOT_DEPLOYED` | Complete against the Table service. No deployment configured — Step 1 is blocked by **D1** (no extract) and **D3** (no speed model) |
| **Valhalla** | **IMPLEMENTED**, executable | `NOT_DEPLOYED` | Complete against `sources_to_targets`. Same blocker |
| **GraphHopper** | **IMPLEMENTED**, executable | `NOT_DEPLOYED` | Complete against the self-hosted `/route` endpoint. Same blocker. **Two capability facts are recorded in its `description` rather than smoothed over:** the open-source server ships no matrix endpoint, so a cell-cluster matrix is a fan-out of N point-to-point queries; and `/route` accepts no snap radius, so **R13 is PARTIAL** — outside-extract points fail, but the snap distance inside the extract is unbounded and unreported |
| **in-house** | **NOT IMPLEMENTED**, deliberately | `NOT_IMPLEMENTED` | **No in-house routing engine exists to adapt to.** `src/engine/routing/` holds three *caches*, each taking the routing call as an injected function; there is no graph, no per-profile edge-cost model, no contraction-hierarchy precomputation and no query engine in `src/` or `tools/`. `src/services/routing.service.js` runs A* over an already-supplied waypoint array with no precomputation and takes its geometry from the **metered external API ADR-11 records as rejected** — it is the legacy path B1 replaces (**N30**), not a candidate to replace it with. An adapter written now could only measure itself |

**Nothing was fabricated to fill the shortlist.** §27 item 2's fourth candidate is reported absent
rather than simulated, which is the same discipline `b1Benchmark.js` applies to an unmeasured row.

### 34.5 N24–N29 — which of them Step 2 owns

| Finding | Does it affect the **benchmark** adapter contract? | Disposition |
|---|---|---|
| **N24** — A1 covers 2 of the Routing Service's 5 capabilities (no path/geometry, no elevation) | **No.** It bounds what the benchmark *measures*; §5.2's path query has its own row, its own 400 ms budget and its own degradation | **Phase 8 / B6 boundary. Left alone**, and made explicit rather than accidental in `graphhopper.js`, where `calc_points=false` states that geometry is deliberately not requested |
| **N25** — three incompatible `route` shapes, no translator | **No.** It is *why* Step 2's deliverable is a benchmark adapter and not a production one | **Phase 8. Left alone.** No adapter here is wired to either shipped cache; `b1Benchmark.js` remains the only caller |
| **N26** — Tier 0 predicates read `plan.route` fields nothing produces | **No.** F27/F28/F29/F30/F15's attribution contract is the production client's composition of engine output plus **B6**'s map data | **Phase 8 + B6. Left alone.** No adapter invents `surfaceClasses`, `zonesTraversed`, `constrictions`, `zoneTraversals` or `deadZoneExtentM` |
| **N27** — A1 is cell-in/cell-out, so each adapter would carry its own projection | **Yes, structurally** — but §32.5 records that moving the boundary *"changes `b1Benchmark.js`'s header contract and is therefore a Phase 8 change, not a Step 2 change"* | **Resolved without deciding it.** A1 stands as written; the projection is an **injected seam** shared by all four candidates. One implementation, and relocating it into the Phase 8 client later touches no adapter |
| **N28** — `timeBucket` has no producer | **No.** Both caches are right to take it as an input; the derivation belongs to the absent composition root | **Phase 8. Left alone.** Every adapter *requires* the caller to supply it and refuses the request otherwise — an adapter that derived one would be reading a clock |
| **N29** — `travelSdSeconds: answer.travelSdSeconds ?? 0` | **Yes**, and §32.11 assigns it to *"whoever performs Step 2"* | **FIXED** (§34.6). The coalesce is gone, and no adapter defaults a spread: `travelTimeSpread` is required configuration **with a named source** |

### 34.6 The three changes made to `b1Benchmark.js`, and the one deliberately not made

**1. N29 — the coalesce is gone.** One line, one-for-one, no line-count change:

```diff
-        travelSdSeconds: answer.travelSdSeconds ?? 0,
+        travelSdSeconds: answer.travelSdSeconds, // N29 — never `?? 0`: 0 asserts "this ETA is certain" (§8.4)
```

`cellPairCache.buildEntry` requires a finite non-negative spread, so an engine that answers none
now **loses the entry** — visible as a hit rate of 0 — instead of being credited with certainty in
the optimistic direction. A test asserts exactly that, end to end.

**2. Availability is honoured.** `main()` reads an adapter's `availability` and, when it is not
`AVAILABLE`, reports the status and the reason, measures nothing, and leaves every row
`NOT_MEASURED` with exit code 0 — *because no claim was made, not because a target was met*. This
is what stops an undeployed candidate being mistaken for a fast one.

**3. Discovery and selection.** `--engine <id>` resolves a bare candidate id through the roster;
`--engine <path>` is unchanged. `--candidates` prints the roster. Both print *"a roster, NOT a
ranking"*, because selection is Step 5's.

**Not made: the status discriminator was not landed in the header contract.** §32.5 calls it
*"the single most valuable change Step 2 could carry"*, and §32.11 assigns landing it in the tool
to **Phase 8**, because it changes a contract ADR-33 and §32 both cite by line. It is therefore
implemented **at the adapter layer** — `ROUTE_STATUS`, seven values covering §32.5's six
conditions plus success — where it is additive: `b1Benchmark.js` reads `destCellId`, `distanceM`,
`travelSeconds` and `travelSdSeconds`, so a non-`OK` answer carries `null` physics, is correctly
refused by `buildEntry`, and is never cached or counted as reachable. **No distance is ever
fabricated for a destination the engine could not route.** Promoting the discriminator into the A1
header remains Phase 8's — now with a working implementation to promote.

**No threshold, workload or registered parameter was touched.** 20 ms / 2 ms / 10 µs / 100 µs, the
p99 statistic, the 95 % and 90 % hit-rate targets, 500 × 200 in 25 clusters, and every `route.*`
entry are byte-identical. `DEFAULT_WORKLOAD` is unchanged, and the test pinning it to
`solve.max_legs_per_round` × `candidate.max_evaluated` still passes.

### 34.7 One pre-existing red, and why it was fixed rather than left

Ratifying D4 turned `tests/engine/phase0Scaffold.test.js` red **before this pass wrote any code**:
its ADR-log tests assert that `docs/adr/` holds exactly Appendix C's 38 records and that **every**
record contains `**Accepted — frozen**`. `ADR-33` is a 39th record and is `Accepted`, so both
assertions failed the moment the ADR landed.

`docs/adr/README.md` has always described two classes — Appendix C's frozen records, and
integration records numbered 33 upward that are `Accepted` and *"may never contradict a frozen
record"* — and the tests predate the second class having a member. The test now checks the two
classes separately, and the new class is checked **more** strictly than the old one: an
integration record must be `Accepted`, must declare itself an integration decision under a frozen
architecture, must carry `## Decision` and `## Rejected`, and **must not** claim
`Accepted — frozen`, because claiming it would assert an immunity to supersession that the
README's rule reserves for Appendix C. The Appendix C completeness check is unweakened: it now
counts the frozen set, so a record numbered 01–32 that Appendix C does not name is still a
failure.

**No assertion was deleted or relaxed**, and no test was skipped.

### 34.8 Superseding §32.11 — precisely two rows

| §32.11 row | Then | Now |
|---|---|---|
| Install or configure a routing engine | NO | **Still NO.** Nothing was installed, downloaded, containerised or deployed |
| Write any candidate-engine adapter | NO — *"Step 2 is released by D4, which is not yet frozen"* | **DONE.** D4 is frozen; three executable adapters plus one recorded absence |
| Write `src/engine/routing/client.js` | NO | **Still NO.** Phase 8, blocked by N25/N26 and three unregistered parameters |
| Add the failure-status discriminator to `b1Benchmark.js` | NO | **Still NO in the header contract**; implemented at the adapter layer instead (§34.6) |
| Fix N29's `?? 0` | NO — *"it is Step 2's owner's"* | **DONE.** This pass is Step 2's owner |
| Write `docs/adr/ADR-33-…` | NO | **DONE by Architecture, not by this pass.** This pass read it and did not modify it |
| Add `traversalDomain` composition to the schema | NO | **Still NO.** D7, deferred by ADR-33 rider 1 |
| Touch the solver, calibration, extracts or production config | NO | **Still NO** |

### 34.9 Tests — what was run, and what it actually shows

Run on 2026-08-09, Node v22.17.0, this build machine.

| Suite | Result |
|---|---|
| `tests/engine/routingB1Adapters.test.js` (**new**) + `routingB1Benchmark.test.js` (existing) | **2 suites, 63 tests, all passed.** The existing benchmark suite is unchanged by the N29 fix — both of its stand-in adapters supply a spread |
| `tests/engine/phase0Scaffold.test.js` | **57 passed.** Before §34.7's fix: **2 failed / 54 passed** |
| Full **engine** lane | **113 suites, 5 925 tests, 0 failures.** Before §34.7's fix the same lane was **2 failed / 5 918 passed**, and both failures were the pre-existing ADR-33 register assertions |
| Full backend regression, all five lanes (`npm test`) | **142 suites, 6 202 tests, 0 failures**, 167.7 s |
| `npm run gate:tenets` | **PASS** — 272 modules, no violations |
| `npm run gate:legacy` | **PASS** — 4 retired modules absent and unimported across 298 files |
| `npm run gate:params` | **PASS** — 181 engine modules against 242 registered parameters, no bare behavioural constants |
| `npm run routing:b1` | **Exit 0**, every row `NOT_MEASURED`, roster printed, no figure produced |

**Stated precisely, because "the suite passed" is only worth what the ordering makes it worth.**
The full five-lane regression above ran against the code as it stood at that moment. Two edits
landed after it — re-exporting `AVAILABILITY` from the adapter registry and having
`b1Benchmark.js` compare against that enum instead of a string literal — and the three suites they
can affect (`routingB1Adapters`, `routingB1Benchmark`, `phase0Scaffold`: **120 tests**) plus all
three gates and `npm run routing:b1` were re-run afterwards and pass. **The other 139 suites were
not re-run after those two edits**, and neither edit touches any module they load.

**What the 47 new tests establish**, and what they deliberately do not. They establish that each
adapter constructs the request its engine documents, reads that engine's answer **in that engine's
units**, and classifies every one of §32.5's six failure conditions distinctly. They establish it
against a **faked transport**, because Step 1 is blocked and no candidate is deployed. Coverage,
per the brief's list: request construction · response parsing · units · successful route ·
no-route · engine failure · timeout · malformed response · malformed request · deterministic
normalisation · status discriminator · invalid configuration · the D1/D8 configuration seam's
three refusal paths.

Two of them exist for failures that would otherwise be found late and expensively:

- **The unit tests are not ceremony.** Valhalla's matrix returns **kilometres** and GraphHopper
  returns **milliseconds**, while the contract is metres and seconds throughout. A factor of 1000
  in either direction produces a route that looks entirely plausible and is wrong, and it would
  surface — if at all — as an inexplicable candidate ranking at Step 5.
- **Nothing is fabricated.** Every path that could invent a distance is asserted to return `null`
  and a status instead, because §18.3 B6's uniform-treatment rule exists precisely so a candidate
  cannot score best on missing data.

**No test calls a public routing service, and none can:** `assertSelfHosted` refuses
`router.project-osrm.org`, `graphhopper.com` and `valhalla1.openstreetmap.de` outright, and a test
asserts that it does. **No test produces a latency, a throughput or a hit rate for any candidate**,
and none of this is B1 evidence.

### 34.10 Change Control — Revision 5

**Before this pass** — `git status --porcelain` and `git diff --stat` captured: 69 modified/deleted
tracked files and 25 untracked paths, all pre-existing Phases 6–15 working-tree state.
`Backend/tools/routing/`, `PHASE_15_CONSOLIDATED_REMEDIATION_REPORT.md` and
`docs/adr/ADR-33-b1-traversal-domain-scope.md` are **untracked** in that baseline, so `git diff`
produces no hunk for `b1Benchmark.js`. Its three edits are therefore quoted in full in §34.6
rather than referred to a diff git will not print.

**Files changed by this pass — the complete list:**

| Path | Change |
|---|---|
| `Backend/tools/routing/adapters/contract.js` | **NEW** |
| `Backend/tools/routing/adapters/transport.js` | **NEW** |
| `Backend/tools/routing/adapters/deployment.js` | **NEW** |
| `Backend/tools/routing/adapters/osrm.js` | **NEW** |
| `Backend/tools/routing/adapters/valhalla.js` | **NEW** |
| `Backend/tools/routing/adapters/graphhopper.js` | **NEW** |
| `Backend/tools/routing/adapters/inhouse.js` | **NEW** |
| `Backend/tools/routing/adapters/index.js` | **NEW** |
| `Backend/tests/engine/routingB1Adapters.test.js` | **NEW** |
| `Backend/tools/routing/b1Benchmark.js` | **MODIFIED** — the three changes in §34.6; all after line 594 except the one-for-one N29 line |
| `Backend/tests/engine/phase0Scaffold.test.js` | **MODIFIED** — §34.7, the ADR-register discipline split into its two documented classes. This file already carried pre-existing Phase 6–15 working-tree changes (216 lines at the baseline `git diff --stat`); this pass adds ≈42 more, all inside `describe("the ADR log")` |
| `docs/adr/README.md` | **MODIFIED** — integration register added, ADR-33 row |
| `PHASE_15_CONSOLIDATED_REMEDIATION_REPORT.md` | **MODIFIED** — §34–§35 appended, Revision History row 5 |

| Check | Result |
|---|---|
| New report created | **No** — §34–§35 appended to the same living record |
| Historical findings deleted | **No** — §1–§33 unmodified except the Revision History table |
| `ADR-33` modified | **No** — read only; not one byte changed |
| Another ADR created | **No** |
| Another D4 audit created | **No** — D4 is ratified and was not reopened |
| Solver changed | **No** |
| Calibration changed | **No** — no register entry added, changed or removed |
| Threshold changed | **No** — p99 targets, cache-hit targets, 500 × 200 and 25 clusters all byte-identical |
| Routing engine installed, configured or deployed | **No** |
| Map extract created or downloaded | **No** |
| Region, polygon, bounding box or CRS invented (**D1**) | **No** — carried as an opaque operator string |
| Extract vintage, refresh cadence or re-contraction window chosen (**D8**) | **No** — same |
| Fake endpoint or fake engine created | **No** — the in-house candidate is reported absent, not simulated |
| Phase 8 production routing client written | **No** |
| Phase 16 touched | **No** |
| Engine selected | **NO** |
| Tests weakened, skipped or deleted | **No** — one test file was made stricter (§34.7) |
| Commit created | **No** |

### 34.11 Remaining B1 dependencies

| Step | Status | Blocked by |
|---|---|---|
| **1** — deploy each candidate against the target region extract, hierarchies built | **BLOCKED** | **D1** (no extract), **D3** (no speed model ⇒ no edge costs) |
| **2** — one executable benchmark adapter per candidate | **COMPLETE** for the three engines that exist; the in-house candidate is recorded absent | — |
| **3** — run the tool per candidate on representative hardware, record every row | **BLOCKED** | **D1**, via Step 1 |
| **4** — record hierarchy build time and extract refresh cadence per candidate | **BLOCKED** | **D1**, **D8** |
| **5** — choose on the recorded evidence and write the B1 ADR | **BLOCKED** | Steps 1–4 |

Also still open and untouched by this pass: `src/engine/routing/client.js` (Phase 8, plus N25/N26,
plus registering `route.matrix_timeout` / `route.path_timeout` / the detour factor under §22.1);
the route-attribution producer (Phase 8 + **B6**, **N26**); `timeBucket`'s producer (**N28**); the
§5.2 degradation ladder and its two Safety parameters (**D1**, **B8**); retiring the legacy metered
hot path (**N30**, unowned); and N27's contract choice, which this pass made *survivable* rather
than *decided*.

### 34.12 No engine has been selected

**B1's engine selection has NOT been performed, and nothing in this pass advances it.** No
candidate was ranked, preferred, scored, recommended or ordered by anything other than §27 item
2's own stated order. No latency, throughput, hit rate or amortisation figure was produced for any
candidate. Every benchmark row reports `NOT_MEASURED`, because no candidate is deployed — and
`NOT_MEASURED` is not `PASS`. Selection is **B1 Step 5**, on evidence Steps 1, 3 and 4 produce, and
it requires an ADR of its own.

The one candidate-relevant fact this pass *did* establish is a capability fact rather than a
measurement, and it is recorded because hiding it would be worse: **GraphHopper's self-hostable
server has no matrix endpoint**, so its cell-cluster matrix is a fan-out of N point-to-point
queries. That is a property of the product, verifiable without deploying anything, and it will
show up in `approach_routing_matrix` at Step 3 — which is where B1 is supposed to see it. **It is
not a recommendation and it rules nothing out.**

---

## 35. Final Status — Revision 5

```
B1 STEP 2:            COMPLETE
B1 ENGINE SELECTION:  NOT YET PERFORMED
D4:                   RATIFIED (ADR-33, 2026-08-09)
D1:                   STILL PENDING
D8:                   STILL PENDING
B1:                   STILL BLOCKED (Steps 1, 3, 4, 5)
PHASE 15:             STILL BLOCKED
PHASE 16:             NOT READY
```

**ADAPTERS:** OSRM **IMPLEMENTED / NOT_DEPLOYED** · Valhalla **IMPLEMENTED / NOT_DEPLOYED** ·
GraphHopper **IMPLEMENTED / NOT_DEPLOYED** · in-house **NOT_IMPLEMENTED** (no engine exists to
adapt to; not fabricated).

**NEXT ACTION:**

> **Operations + Commercial: answer D1** — the target operating region and its boundary, per
> §30.8's request, which is unchanged and remains the highest-value open item. It is the single
> dependency in front of B1 Steps 1, 3 and 4, and therefore in front of every row of evidence
> Step 5 needs. With D1 answered and **D3**'s speed model supplied, Step 1 can deploy each
> candidate and Step 3 can run `npm run routing:b1 -- --engine <candidate>` against it **without
> any further adapter work** — which is the whole of what Step 2 was for.

---

*End of Phase 15 Consolidated Remediation Report, revision 5. No new report was created — this is
the same single living record revisions 1–4 wrote. D4 was ratified by Architecture in `ADR-33` and
this pass did not modify that record; it implemented B1 Step 2 and updated the ADR register. No
routing engine was installed, no extract created, no region or vintage invented, no threshold or
calibration value changed, no solver file touched, no test weakened, no engine selected, and no
commit created.*
