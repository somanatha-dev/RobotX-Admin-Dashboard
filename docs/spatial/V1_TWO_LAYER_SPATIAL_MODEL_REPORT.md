# V1 TWO-LAYER SPATIAL MODEL — IMPLEMENTATION REPORT

> # FINAL STATUS: **ACCEPTED WITH BLOCKERS**

**Not "accepted because the tests are green."** 190 suites / 7 999 tests pass, 22 of 22
spatial mutants are dead, 31 of 31 live-database checks pass, and **three things are open**,
two of which are external inputs and one of which is a target this work **measured and did
not meet**:

1. **§20.3's > 95 % cell-pair cache hit rate is NOT met at resolution 11** — 11 %–87 %
   across arrival rates 0.1–10 req/s under a declared workload, against 95 %+ at resolution
   8. The target was **not** adjusted.
2. **F33 cannot reach `SATISFIED` until R13 (`snapRadiusM`) is supplied.** The `routable`
   conjunct has no producer on the decision path. This is a deliberate tightening.
3. **S-3 row 29 is not discharged.** The adopted RNSIT geometry is a development artefact;
   the signed owner declaration does not exist and no validator can produce one.

**V1 stop conditions: 3 of 8. UNCHANGED.**

**One previously escalated blocker is refuted and closed** — see §3.

---

## 1. Worktree and base commit

| | |
|---|---|
| **Base commit** | `c94e13e7e073d065007d255e09abb22084e7eac5` ("13 sept", `feature/dashboard`) |
| **Worktree** | `C:/Users/soman/robotx-v1-spatial` — branch `worktree-v1-spatial` |
| **Shared checkout** | `C:/Users/soman/OneDrive/Desktop/RobotX` — verified clean at start and at end, never modified |
| **res11 experimental worktree** | `C:/Users/soman/robotx-v1-res11` — **read only**, never modified |
| **Committed** | **Nothing.** No commit, no merge, no push |
| **Database** | Disposable PostgreSQL **18.3**, loopback, port **55432**, database `robotx_spatial`, 32 migrations, 75 tables. **Never Neon. Never 5432** |

---

## 2. Files changed

**Modified (20)** — 943 insertions, 109 deletions.

| File | What changed |
|---|---|
| `spatial/cells.js` | `H3_RESOLUTION.FINE` 8 → 11; `SPATIAL_MODEL`; `fineCellDiameterMetres`; the D1/D6 index-is-not-a-domain header; `resolutionOfH3Cell` documented as the single production decoder |
| `spatial/regionBoundary.js` | V-9 / D2 explanatory text derived from the resolution in force; `pointInRing` exported for the one domain primitive |
| `spatial/deliveryDomain.js` | **NEW** — the authoritative point-in-domain primitive |
| `workers/coordinatorSolvePath.js` | `serviceabilityFor` → the three-way conjunction; the stop projection now carries `geofenceResult` |
| `services/task.service.js` | `sealIdentities` produces and pins the verdict; `admitToRound`/`assignTask` thread the declaration; `sealIdentities` exported for test |
| `feasibility/predicates/f33.js` | Docstring only — its "intake applies the same rule" claim is now true. **Logic unchanged** |
| `config/service.js` | `deliveryDomain` as a published payload, sibling of `spatial` |
| `config/validators.js` | **A7** — the declaration is well formed (BLOCKING) and attested (WARNING) |
| `controllers/config.controller.js`, `cutover/rollbackPublisher.js` | Carry the new payload |
| `routing/cellPairCache.js` | Header: which half of §20.3's quotation survives, and the measured consequence |
| `config/register/supplementary.json` | `route.intra_cell_offset_m` **held at 250**; `awaits` corrected |
| `tools/routing/b1Readiness.js` | One stale "res 8" sentence |
| 4 test files | Re-pointed at the new model; two repaired; none weakened |
| `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` | **§3.6, §6.2, §20.3** amended (D3) |
| `docs/adr/README.md`, `V1_CONTRACT_AND_STOP_CONDITION.md`, `B1_EXTERNAL_INPUT_HANDOFF.md` | Registers, §M.2 re-interpretation, S-3 row 29, the D6 ruling |

**Added (11):** `spatial/deliveryDomain.js` · three test suites · four verification
instruments · `ADR-35` · `ADR-36` · `RD-2026-09-14-01` · this report.

### 2.1 Files deliberately NOT changed

| File | Why |
|---|---|
| `docs/adr/ADR-28-spatial-hierarchy.md` | **Frozen, and not contradicted.** Pinning at intake is what keeps D1 compatible with *"containment by published assignment, not by query-time geometry"* |
| `docs/adr/ADR-35` (as it existed in the res11 worktree) | Rewritten here rather than edited in place — it was never committed |
| `feasibility/predicates/f33.js` **logic** | The three-valued reading is exactly what makes the conjunction safe. Only the docstring changed |
| `spatial/hierarchy.js` | `CellAssignment` semantics are untouched. It still answers the index question and only the index question |
| `privacy/surrogateKeys.js` | `geofenceResult` was **already** one of §23.7's six. No seventh field, no widened exemption |
| `prisma/schema.prisma` | **No schema change.** An H3 token encodes its own resolution; `Stop.geofenceResult` already existed |
| `resolutionOfH3Cell`, `coarseParentOf`, `fineChildrenOf`, `normaliseCellId` **logic** | The four fail-closed mechanisms. Only a docstring was added (naming the decoder and enumerating the enforcement points); the diff shows **zero** logic change in any of them |
| Phase 15 documents other than the B1 handoff | Not touched to manufacture a green status |

---

## 2.2 Pre-commit audit corrections (2026-09-14)

A final pre-commit audit raised two findings against this work. Both are corrected here;
neither changed a D1–D7 decision, the §3.6/§6.2/§20.3 amendments, the 250 m default or the
§20.3 target.

**A-1 — a weakened positive assertion, restored.** The `planInputFor` test had been reduced
to `every(s => s.serviceable === undefined)`, which **also passes if `planInputFor` stops
calling `serviceabilityFor` altogether** — raw `leg.stops` satisfy it equally. The seam was
therefore not integration-tested. It is replaced by a six-case block driving the **real**
`legLoaderFor` → `serviceabilityFor` → `planInputFor` → `f33.evaluate` chain, proving
invocation, consumption, pin survival through both callers, the INSIDE positive, the OUTSIDE
definite refusal under full assignment and routability, and absent-stays-absent. **Mutant
S22** now anchors the call site, so deleting it fails.

> One thing that surfaced and is worth stating: **F33 returns on the first stop it cannot
> satisfy.** A plan whose first stop is absent reports `INDETERMINATE` even when a later
> stop is a definite `OUTSIDE`. That is F33's pre-existing, unchanged behaviour, both
> answers deny, and the per-stop conjunction is asserted directly rather than through F33's
> scan order.

**A-2 — two helpers with no production caller, removed.** `isFineCell` and `assertFineCell`
were one-line wrappers over `resolutionOfH3Cell` called only by tests and tools. The
production resolution path was traced first, and the trace is the reason for removing rather
than wiring them:

| Where a cell token could be foreign | What actually happens |
|---|---|
| `expansion.js:293` origin cell | **Recomputed from lat/lon** — cannot be foreign, so `coarseParentOf` at :294 never sees a persisted token |
| `hierarchy.indexMap().resolve()` | `assigned: false` — enforcement point 3 |
| published cover | V-10 / A6 refuse at publish — enforcement point 4 |
| routing / index keys | The token is embedded in the key, so a stale entry is an **orphan**, never a wrong hit |

Wiring a wrapper anywhere on that path would have been the **fifth layer** the correction
brief forbids: every reachable path is already fail-closed. `resolutionOfH3Cell` is now
documented in code as the single production decoder with its four enforcement points
enumerated, a test pins that no fifth layer has drifted back in, and **mutant S9 was
re-anchored from the deleted wrapper onto `coarseParentOf`'s real guard** — a mutant aimed at
dead code proves nothing about the running system.

`fineCellDiameterMetres` is **kept**. It is not dead: it is the derived evidence the D5 test
uses to pin that the 250 m default exceeds the geometric bound, and hard-coding 57.33 there
would reintroduce exactly the stale literal this codebase removes elsewhere.

> **Finding raised, not fixed — for the owner.** The trace found that
> `AgentCellPosition.fineCellId`/`.coarseCellId` are read straight from the database onto the
> agent snapshot (`coordinatorSolvePath.js:366-367`) and into the Redis index keys
> (`indexMaintainer.worker.js:379`) **without passing through any of the four enforcement
> points**. A deployment that did not run the spatial cutover would find such agents
> **silently invisible** to candidate expansion — their index keys are written under a
> foreign token that no current-model lookup reads. That is fail-closed (no wrong
> assignment, no wrong answer) but it is silent, and `spatialModelCutover.js --apply` is what
> repairs it. **No production behaviour was changed for this**, because doing so is outside
> D1–D7 and outside the audit's scope. Recorded as **Y-7**.

## 3. The headline result — X-1 is refuted, not worked around

The res11 batch escalated **X-1**: *"the whole-campus requirement is unachievable at any
resolution; centre containment converges on 100 % and never reaches it."* That was measured
correctly and the conclusion was wrong, because it was a property of **centre containment**,
not of H3.

Measured here on the adopted boundary, **0.7 m raster**:

| cover | cells | campus ground covered | campus ground unrepresentable |
|---|---:|---:|---:|
| centre-contained | 45 | **89.660 %** | **10 277 m²** |
| **D6 index (boundary-overlapping)** | **64** | **100.000 %** | **0 m²** |

**The index also overlays 30 088 m² of non-campus ground, and every point in it geofences
`OUTSIDE` and is DENIED** by the exact-coordinate test. That is the trade D6 makes, and it is
strictly tighter than the refusal it narrows: the owner's concern — *"no geographic
over-assignment of non-campus area"* — is now enforced **per destination** rather than
approximated by the shape of the cover.

The coverage-semantics escalation of `B1_EXTERNAL_INPUT_HANDOFF.md` §1.8.4 item 4, recorded
as `D — NOT DECIDED / ESCALATE` with **no defined escalation target**, is therefore
**decided**. It never needed the authority §1.8.5 says does not exist; it needed the two
questions separated.

---

## 4. The D1 architecture, as built

```
intake / seal  (services/task.service.sealIdentities)
    ↓  exact coordinate + the PINNED published declaration
spatial/deliveryDomain.evaluatePoint        ← the ONE primitive
    ↓  INSIDE | OUTSIDE | INDETERMINATE
Stop.geofenceResult                          ← persisted, §23.7's existing derived quantity
    ↓  legLoaderFor's projection (now carries it)
coordinatorSolvePath.serviceabilityFor       ← reads the pin; evaluates NO geometry
    ↓  assigned ∧ inDeliveryDomain ∧ routable
f33.evaluate                                 ← logic unchanged, three-valued
    ↓
SATISFIED | VIOLATED | INDETERMINATE → DENY
```

**Why this is compatible with the frozen ADR-28**, stated once: the round consumes a
*published, pinned* verdict, exactly as it consumes a published cell assignment. No polygon
is evaluated per round. Two tests enforce it — a spy proving this call did not, and a source
scan (comments stripped) proving no call can.

### 4.1 The three-valued conjunction

| assigned | inDeliveryDomain | routable | serviceable | F33 |
|---|---|---|---|---|
| ✓ | INSIDE | ✓ | `true` | SATISFIED |
| ✓ | **OUTSIDE** | any | `false` | **VIOLATED** |
| ✗ (unassigned) | INSIDE | ✓ | absent | INDETERMINATE |
| ✓ | absent | ✓ | absent | INDETERMINATE |
| ✓ | INSIDE | **absent** | absent | INDETERMINATE |

A **definite** negative wins over an absent conjunct: a point measured outside the campus is
refused even while R13 is unsupplied. Verified live.

---

## 5. Cache measurement — §20.3, and it does NOT pass

`node tools/verify/spatialCacheHitRate.js`. Production key function
(`cellPairCache.key`), production counter (`cellPairCache.Counters`), TTL from the register
(`route.cell_pair_cache_ttl` = 900 s). **No route value is invented** — counting hits needs
none, and supplying them would have meant fabricating `EXTERNAL_ROUTING` inputs to produce a
performance number.

Workload, **declared not observed**: 20 000 requests per cell; 6 origin anchors, Zipf 1.0
(§20.3's own "clusters around restaurants, depots and pickup points"); 120 in-campus
destinations, geofence-rejected; 1 profile; 4 time buckets; seed 20260914; deterministic
exponential inter-arrivals; first TTL window excluded as warm-up.

| res | edge | req/s | distinct keys | steady-state hit rate | vs § 20.3 |
|---:|---:|---:|---:|---:|---|
| 8 | 531.41 m | 0.1 | 12 | 88.63 % | NOT MET |
| 8 | 531.41 m | 0.25 | 12 | **95.01 %** | MET |
| 8 | 531.41 m | 1 | 12 | 98.68 % | MET |
| 8 | 531.41 m | 10 | 12 | 99.78 % | MET |
| **11** | **28.66 m** | 0.1 | **1 267** | **11.28 %** | **NOT MET** |
| **11** | 28.66 m | 1 | 1 267 | **50.13 %** | **NOT MET** |
| **11** | 28.66 m | 5 | 1 267 | 79.77 % | **NOT MET** |
| **11** | 28.66 m | 10 | 1 267 | **86.70 %** | **NOT MET** |

**At resolution 11 the target is met at no tested arrival rate.** The key space grows
**105×** for the same traffic.

**The target was not changed.** §20.3 was amended to say the hit rate is *measured* rather
than inherited from cell size — which is D3's instruction — and the measurement's verdict is
reported as a miss. **This is a declared-synthetic workload, not a production measurement**:
no RNSIT demand trace exists and none can, so §20.3 is **unverified for production** in
either direction. That is recorded as **BLOCKER Y-1**, not resolved.

---

## 6. Specification amendments (D3) — all three, coherently

| § | Before | After |
|---|---|---|
| **§3.6** | *"a discrete geospatial cell (H3/S2), fine (~200–500 m) and coarse (~5–10 km)"* — unconditional | the **generic** scales, **plus** a new subsection *"The declared spatial model"*: a bounded deployment MAY adopt a finer fine cell through a model naming its primitive, both resolutions and its required evidence, verified for coverage/safety/determinism/performance/privacy before publication |
| **§6.2** | *"a fine cell (~200–500 m edge) … and a coarse cell (~5–10 km)"* | the same amendment in the index's terms, and every resolution-dependent quantity derived from the declared model rather than the generic scales |
| **§20.3** | *"**Because** cells are ~200–500 m, the cache is small … and its hit rate is high"* — an **argument** | the hit rate is a property of the declared model and the deployment's traffic and **MUST be measured against the target**; plus an explicit statement that the intra-cell offset is a **separate quantity from the cell diameter** and is not derived from it; plus, at the target itself, that targets are **measured, not assumed**, are reported with their workload, and are **not adjusted to the model** |

**Two limits written into §3.6 so the exemption cannot spread:** the 10³–10⁵ cardinality band
is **not** relaxed by a declared model, and a cell remains the index unit — a finer cell does
not become a delivery-domain boundary.

**RNSIT's out-of-band count uses the already sanctioned `cover.cardinalityException`.** No
second exemption mechanism was created. `FINE_CELL_BAND` is unchanged at `{1000, 100000}` and
a test pins it.

---

## 7. D5 — the two quantities, kept apart

**`route.intra_cell_offset_m` is HELD AT 250.** The res11 worktree had moved it to 58
(= 2 × edge); that change is **not carried forward**.

| | |
|---|---|
| H3-11 geometric diameter | **57.33 m** — `fineCellDiameterMetres()`, a straight-line bound |
| Operational network correction | **250 m** — PROVISIONAL, **not calibrated** |

`fineCellDiameterMetres()` exists and is **deliberately not wired** to the register default;
a test asserts the default is 250, is strictly greater than the diameter, and that the
`awaits` text no longer names the H3 edge-length decision. Mutant **S15** kills the
collapse-onto-the-geometry change; **S16** kills omitting the correction.

`awaits` now reads: *a measured within-cell **network** distance … It does NOT await the H3
edge-length or resolution decision: that is settled, and settling it did not calibrate this
parameter.*

---

## 8. Tests

**190 suites / 7 999 tests, 0 failed** (baseline `c94e13e`: 187 / 7 926 with 1 failure, an
environment artefact resolved by copying the two untracked env files). **+3 suites, +73
tests** — the last +5 are the A-1 correction's integration block and the A-2 no-fifth-layer
pin (§2.2).

| Owner-required D1 test | Where | Verdict |
|---|---|---|
| 1. assigned + INSIDE → may continue | `spatialDeliveryDomain.test.js` | ✓ |
| 2. assigned boundary-overlap + OUTSIDE → VIOLATED | ✓ (real `rnsit-parking-lot`) | ✓ |
| 3. assigned boundary-overlap + INSIDE → domain satisfied | ✓ | ✓ |
| 4. unassigned + INSIDE → INDETERMINATE, not true | ✓ | ✓ |
| 5. missing declaration → INDETERMINATE, not true | ✓ | ✓ |
| 6. missing coordinate → no verdict, fail closed | ✓ | ✓ |
| 7. coordinator consumes the pinned verdict | ✓ | ✓ |
| 8. coordinator performs no query-time polygon evaluation | ✓ spy **and** source scan | ✓ |
| 9. mutation removing the domain conjunct fails | mutant **S3** | KILLED |
| 10. mutation defaulting absent domain to true fails | mutant **S4** | KILLED |
| 11. historical res-8 token never read as res-11 | ✓ | ✓ |
| 12. cache invalidation / rebuild is idempotent | `spatialModelCutover.js`, live | ✓ |
| 13. spatial-model identity is deterministic | ✓ | ✓ |
| 14. boundary overlap does not authorise an outside point | ✓ | ✓ |
| 15. CellAssignment semantics intact | ✓ | ✓ |

**Two assertions were changed rather than added, and neither is a weakening.** The loose
band check (`100 < edge < 1000`, which would have passed at resolutions 8, 9 and 10 alike)
became an **exact** assertion on the declared model; and `{fine: 8}` became `{fine: 11}`,
still written as a **literal**, because reading the constant back would agree with any value.

**One test was repaired, and the repair is the interesting one.** `candidatesPhase9Remediation`
F9-3 assumed `ringAt(origin, 1)[0]` had a ring-4 cell sorting before it — true at resolution
8, false at 11. It now **searches** for a disagreeing pair, so the property (visit order
follows the bound, not the cell id) holds at any resolution. A hidden fixture dependency, not
a property, and it is now neither.

---

## 9. Mutation results — **21 KILLED, 0 SURVIVED, 0 NOT_APPLICABLE**

`node tools/verify/spatialMutants.js`. Anchors must match exactly once; a drifted anchor is
`NOT_APPLICABLE`, never a pass; originals restored on every exit path.

Every property `RD-2026-09-14-01`'s testing instruction names has a mutant: removing the
geofence conjunct (S3) · defaulting absent domain to true (S4) · accepting an outside point
(S5) · confusing index membership with serviceability (S6) · live polygon geometry at
coordinator time (S7) · deriving the verdict from the cell rather than the coordinate (S8) ·
reinterpreting historical tokens (S9) · accepting a foreign resolution (S10, S11) ·
bypassing model-version identity (S12) · weakening cache invalidation (S13, S14) · widening
the privacy exemption (S17). Plus the resolution itself (S1, S2), D5 (S15, S16), attestation
(S18), A7 (S19), and the two seam mutants below.

> **Three mutants SURVIVED the first run, and all three were real gaps in the tests.**
> **S8** (verdict derived from the cell centre instead of the coordinate) and **S21** (intake
> writes no verdict) survived because the intake producer had **no direct test at all** — it
> was only ever reached through `admitToRound`'s database machinery. **S14** (mobility profile
> dropped from the cache key) survived because no suite in scope asserted that the profile
> *discriminates*, only that it is *required* — and a key that demands a component then omits
> it from the string passes the second check while silently applying one profile's matrix
> under another.
>
> All three were closed **by adding tests**, not by removing or weakening mutants:
> `spatialIntakeGeofencePin.test.js` (9 tests, including a fixture point that is inside the
> campus while its own cell's centre is outside — the only fixture that can tell a coordinate
> test from a cell test), and a cache-key test asserting all four components are both required
> and discriminating. `sealIdentities` was exported so the producer is testable directly.

---

## 10. Live verification — 31 of 31

`node tools/verify/spatialDeliveryDomainLive.js` against PostgreSQL 18.3 on 55432. Boundary
digest verified before use. Guarded by allow-list (loopback **and** non-default port),
evaluated before a client is constructed.

Covered: H3-11 index creation from the adopted boundary (45 centre / 64 index / 19 added, all
with centres outside) · `CellAssignment` rows and `mapVersion` · intake pinning the verdict ·
the declaration as a snapshot **sibling** of `spatial` · the pin reaching the round through
the production query · `assigned + OUTSIDE → VIOLATED` with the cell genuinely in the
published index · unassigned → INDETERMINATE not VIOLATED · a stranded res-8 token failing
closed four ways · `AgentCellPosition` recomputability.

**Cutover, live:** report → `--apply --rebuild-stops` → re-report.

| run | result |
|---|---|
| report, 3 seeded res-8 `AgentCellPosition` rows | `FOREIGN_RES_8` ×3, 3 differing |
| apply | 3 recomputed from their own lat/lon; 1 foreign `Stop.fineCell` **cleared, not reinterpreted**; 1 re-derived from retained lat/lon |
| re-report | `CURRENT_FINE` ×3, **0 differing, 0 foreign — idempotent** |
| unambiguity | 73 tokens inspected, **0** whose model cannot be decided from the token alone |

**And the property D1 was adopted for:** the pinned verdicts (1 INSIDE, 2 OUTSIDE) are
**identical before and after the cutover**. A spatial-model change does not disturb a
geofence verdict, because the verdict is a coordinate against a geometry and contains no
cell.

---

## 11. Routing

**Unchanged. Nothing was added, removed or substituted.** Routing Batch 1's architecture —
RNSIT OSM extract → self-hosted OSRM → the existing adapter → `productionRouter` → the
RobotX travel model → the engine route contract — is untouched. No Google Directions, no
Mapbox, no hosted OSRM.

The six route fields (`distanceM`, `travelSeconds`, `travelSdSeconds`, `climbM`, `descentM`,
`stopStartCycles`) are unchanged and **still refuse**: no climb, descent or stop-start value
was fabricated.

**`snapRadiusM` (R13) was not chosen.** The res11 measurement of a 137.7 m worst cell-centre
snap is evidence *for* that decision, not the decision, and D1's `routable` conjunct is
**left without a producer** rather than stubbed.

> **Not run here:** the Routing Batch 1 live and mutation verifications. Those instruments
> live in `C:/Users/soman/robotx-routing-batch-1`, which is a separate uncommitted worktree
> and is not part of this tree. Their absence is recorded rather than papered over; nothing
> in this work changes the routing path they exercise.

---

## 12. Regression

| | Baseline `c94e13e` | After | Verdict |
|---|---|---|---|
| `npm test` | 187 suites / 7 926, **1 failed** | **190 / 7 994, 0 failed** | +3 suites, +68 tests |
| `npm run gates` | 7 PASS / 1 FAIL | **7 PASS / 1 FAIL** | unchanged |
| `gate:composition` | FAIL | **FAIL** | pre-existing, external (B1) |
| `gate:calibration` (not in `gates`) | FAIL, B8 | **FAIL, 39 Safety-class findings** | pre-existing; `route.intra_cell_offset_m` is **not** among them |
| `routing:readiness` | BLOCKED | **BLOCKED** (D1, D3, D8; steps 1/3/4/5 blocked, step 2 PASS) | unchanged |
| `v1CorePath` | 26/34 unresolved, HTTP 503 | **26/34 unresolved, HTTP 503** | unchanged |
| `phase9LiveDatabase` | 9/9 | **9/9** | — |
| `phase14LiveDatabase` | 55/55 | **55/55** | — |
| `t104LadderLiveDatabase` | 72 checks, 0 failed | **72, 0 failed** | — |
| `batch2ChargingScheduler` / `batch2Boot` / `batch2Mutants` | pass / 9/9 / 10 killed | **pass / 9/9 / 10 KILLED** | unchanged |
| `verify:step2` / `verify:step3` | pass | **pass / 34-34** | — |
| `verify:step4` | 40/41 | **40/41** | **proven pre-existing — see below** |

### 12.1 The one environmental failure, and how it was proven unrelated

`verify:step4` fails one check: *"the physical robot has no simulator-written live state"*,
scoring **40/41**. This matches the previously recorded X-6 sensitivity exactly.

**It was not taken on trust.** The working tree was stashed (`git stash push -u`), leaving
the worktree at clean `c94e13e` with **zero** modified or untracked files, and `step4` was
re-run against the same database: **40/41, the identical failing check.** The stash was then
restored and all 31 changes verified present. The failure is a property of the freshly
`npm ci`-ed worktree environment, not of this work.

`verify:step5` was not run to completion; it is recorded as hanging on the baseline tree and
was not re-litigated here.

---

## 13. Remaining blockers

### 13.1 Pre-existing, unchanged

B1 (D1-routing, D3, D8) · **R13 `snapRadiusM`** · terrain source (`climbM`/`descentM`) ·
stop/start source · `travelSdSeconds` (N29) · D3 fleet speed model · the Safety-class
residual CV · the reserve floor · the second Safety approver (FD-3 = NO) · the 15
`REGISTER_UNRESOLVED` rows · the 6 `NO_PRODUCER` families · `gate:composition`'s
`LEADER_ONLY_NOT_COMPOSABLE`.

**Nothing on that list was fabricated.** No robot speed, no terrain, no stop-start model, no
Safety approval, no reserve floor, no residual CV, no snap radius, no charger evidence, no
D1 governance sign-off.

### 13.2 Raised or re-stated by this work

| ID | Finding |
|---|---|
| **Y-1** | **§20.3's > 95 % cell-pair hit rate is NOT met at resolution 11** under the declared workload (11 %–87 %). The target is not adjusted. A production measurement is impossible today — no demand trace, no live deployment — so §20.3 is **unverified for production**, and this measurement bounds the question rather than answering it. |
| **Y-2** | **S-3 row 29 is undischarged.** The adopted RNSIT geometry is a development artefact. `A7` reports it unattested at every publish. §1.8.5: no validator can discharge a signature; a human must read the declaration. |
| **Y-3** | **F33 cannot reach `SATISFIED`** until R13 is supplied. Deliberate, fail-closed, and stricter than the previous behaviour — recorded so it is not mistaken for a regression. |
| **Y-4** | **V-5's axis-order check cannot detect a transposed RNSIT file.** lon 77.5 / lat 12.9 are both possible latitudes, so the check — which can only refuse what *cannot* be a latitude — is silent by construction. Asserted as a test rather than assumed away. Mitigation is the D7 attestation, not code. |
| **Y-5** | **`route.intra_cell_offset_m` remains uncalibrated** and PROVISIONAL, awaiting network-distance/circuity evidence. |
| **Y-6** | **On-boundary points are exact-or-ray-cast.** With no tolerance, "on the boundary" means *exactly* on it as a double: 6 of the adopted ring's 18 edge midpoints are exactly collinear, 12 are not and fall through to the ray cast. Every one is **deterministic**. Adding an epsilon would widen the domain by a distance no decision record names, so none was added. Sub-millimetre; recorded. |
| **Y-7** | **Persisted `AgentCellPosition` cell tokens reach the runtime without passing any of the four enforcement points** (`coordinatorSolvePath.js:366-367`, `indexMaintainer.worker.js:379`). An un-migrated deployment's agents would be **silently invisible** to candidate expansion rather than loudly refused. Fail-closed, but silent; `spatialModelCutover.js --apply` repairs it. Raised by the A-2 trace; **no production behaviour changed**, as that is outside D1–D7. |
| **X-5** (carried) | `fineChildrenOf` would materialise 117 649 cells at res 11. No production caller. Must not acquire one that enumerates the full child list. |
| **X-3** (carried) | §23.7's privacy residual at ~50 m. The classification **holds** — §23.7's own six already include `routingNodeId`, strictly finer than any H3 cell — and the residual belongs to its retention and access-control clauses. Unchanged in kind; not resolved here. |

**X-1 is CLOSED** (§3). **X-2** (`Stop.fineCell` not universally recomputable after §23.7
erasure) stands for production and is what `spatialModelCutover.js` counts and refuses to
touch.

---

## 14. V1 stop conditions — recomputed, not copied

| | Requirement | Status | Moved? |
|---|---|---|---|
| **S-1** | No unproved optimality gap; no absent input read as benign | **MET** | No — *strengthened*: routability was being read as benign by omission and no longer is |
| **S-2** | Every worker names a register parameter or `@structural` constant | **MET** | No — `gate:params` PASS |
| **S-3** | Every external value supplied in a decision record | **NOT MET** | No. **28 → 29 rows**, and the increase is a **separation, not a new requirement**: row 29 was previously conflated with row 26 |
| **S-4** | Coordinator solve path composed and started | **NOT MET** | No — `gate:composition` still RED, externally |
| **S-5** | `cutover.engine_enabled = true` published and pinned | **NOT MET** | No — still HTTP 503 `ENGINE_NOT_LIVE` |
| **S-6** | One real HTTP request reaches a durable `Commitment` + `Outbox` | **NOT MET** | No — stops at S-5's boundary |
| **S-7** | `npm test` exit 0 **and** `npm run gates` exit 0 | **NOT MET — one half holds** | No — test green (190 / 7 994), gates still exit 1 |
| **S-8** | V1 docs state what V1 does not guarantee | **MET** | No |

### **SCORE: 3 of 8. UNCHANGED. V1 IS NOT COMPLETE.**

**What moved is not a stop condition.** A coverage-semantics escalation with no defined
escalation target is closed; a frozen specification clause that had become false is amended
at all three of its locations; a producer F33's own rationale had claimed for four phases now
exists; and a performance target that was being *assumed* is now *measured* and reported as
missed.

---

## 15. Protected-path verification

| Instruction | Verified |
|---|---|
| Work in a new isolated worktree | `C:/Users/soman/robotx-v1-spatial`, created from `c94e13e` |
| Shared checkout untouched | `git status` clean before and after; no file under `OneDrive/Desktop/RobotX` written |
| `C:/Users/soman/robotx-v1-res11` not modified | Read only; its `git status` is byte-identical to its state at the start |
| No commit, merge or push | `git log` shows `c94e13e` as HEAD; 31 uncommitted changes |
| No Neon | `DATABASE_URL` set to loopback:55432 for every run; both live tools refuse a non-loopback or default-port target **before constructing a client** |
| Disposable PostgreSQL, non-default port | 18.3 on **55432**, created and migrated in this session |
| No fabricated external input | §11, §13.1 |
| No safety gate weakened | V-8/V-9/V-10/A6 unchanged in logic; `FINE_CELL_BAND` unchanged; no test relaxed; A7 **added** |
