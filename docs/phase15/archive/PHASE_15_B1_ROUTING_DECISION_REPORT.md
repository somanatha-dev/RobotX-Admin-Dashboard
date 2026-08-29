# Phase 15 B1 Routing Decision Report

**Role:** Principal Systems Engineer, resolving the Phase 15 B1 routing-engine decision as far as
the available evidence legitimately permits.
**Date:** 2026-08-08 · **Branch:** `feature/dashboard` · **Baseline:** `cf9103f`, with Phases 6–15
present as one uncommitted working tree.
**Node:** v22.17.0 · **Machine:** the build machine — a Windows 11 laptop. **Not representative
production hardware, and not a shard.**

**Authoritative inputs, read in full:** `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` (§5.1–5.2, §6.1–6.5,
§18.3, §18.5, §20.1–20.5, §22.1–22.4, §24.6–24.7, §25.2, §27), `IMPLEMENTATION_EXECUTION_PLAN.md`
(§2.5, §2.9, §5.3, §6.1–6.2, Phase 8/9 rows), `PHASE_15_CONSOLIDATED_REMEDIATION_REPORT.md`
(authoritative for current state), `PHASE_15_INDEPENDENT_VERIFICATION.md`,
`PHASE_15_BLOCKER_RESOLUTION_PLAN.md`, `PHASE_10_COST_SCALING_INDEPENDENT_VERIFICATION.md`.

**No solver file was read for defects or modified. No calibration value was derived, invented, or
edited. No threshold was changed. No gate was bypassed. No test was weakened. No routing engine
was simulated, and no B1 measurement was manufactured. No commit was created.**

---

## 1. Executive Summary

**B1 is BLOCKED, and the blocking prerequisite is one step earlier than "deploy a routing
engine."** No routing engine can be selected, deployed, or benchmarked for this system because
**the target region, its spatial map, and the fleet's mobility profiles do not exist in
configuration.** Verified live: `service.defaultSnapshot()` returns `spatial: null`,
`shards: null`, `bindings: {}`. A routing deployment is defined by three things — *which extract*,
*which profiles*, *which cells* — and this repository declares none of them. Procuring an engine
before those exist would produce contraction hierarchies over an unknown area for an unknown
vehicle set.

Everything the consolidated report records about B1 was checked rather than believed, and all of
it holds: the two caches exist, `src/engine/routing/client.js` does not, the register holds seven
`route.*` entries and none is a timeout or a detour factor, the degraded mode is fully modelled
with nothing that enters it, and `route.degraded_max_radius` resolves to `null` today.

Four things this pass adds that no prior document records:

1. **The B1 evidence procedure was itself broken, and it would have ruled out every candidate
   engine.** `npm run routing:b1` compares both §20.3 hit-rate rows against their registered
   targets. Neither figure is produced by the engine: the harness warms the approach population
   and then reads it (**1.00, always**) and walks the return-leg population once cold and once warm
   (**0.50, always**). Verified invariant across two engines and two workload shapes. The 0.50 is
   below `route.charger_reachability_min_hit_rate` (0.90), so the row came back `EXCEEDED` and the
   tool exited 1 — meaning **every** candidate engine, at any speed, would have been reported as
   failing §20.1's routing budget on this file's loop structure. **Fixed this pass** (§3.4, §16),
   with four regression tests, including the end-to-end proof that a zero-latency adapter is no
   longer failed.

2. **§20.1's `charger_reachability_cached` target of < 10 µs cannot be served by the shipped cache
   tier, and this has nothing to do with which engine is chosen.** The caches take an injected
   `kv`; the shipped `kv` is Redis (`src/cache/kv.js`, `ioredis`). Measured on this machine against
   **loopback** Redis: `GET` p50 **304 µs**, p99 **1 156 µs** — 30× to 115× the target. The Phase 8
   routing client therefore needs an in-round, in-process tier in front of Redis, and that is a
   design prerequisite discoverable now, without an engine.

3. **The routing cache path alone consumes almost the entire round budget before any engine
   exists.** Driving the shipped caches at §20.1's own 500 × 200 / 25-cluster shape with a
   **zero-latency** stand-in and an in-memory kv costs **241–246 ms** wall clock (three runs after
   a warm-up) against §20.1's **250 ms whole-round** target — with no engine, no candidate
   generation, no feasibility, no pricing, no solve, and no commit in it.

4. **The approach-population wiring is missing too, not only the client.** `cellPairCache.hopsFor()`
   has **no consumer anywhere under `src/`** — `planBuilder` takes `hopsForSequence` as an injected
   function, and only tests supply it. So B1's repository-side shape is larger than `client.js`.

The `charger_reachability_hit_rate` and `cell_pair_hit_rate` rows are honestly `NOT_MEASURED` for
every engine, now and permanently, from any single-process run. Every engine row is `NOT_MEASURED`
because no engine exists to measure.

Separately, running the full suite surfaced a **pre-existing ~1-in-256 flaky test** in
`privacySurrogateKeys.test.js`, unrelated to B1. Its mechanism was established by measurement
(50 000 trials) rather than guessed, and it was **deliberately not fixed** — §16 records both the
proof and the one-line fix for whoever owns it.

**Nothing was manufactured.** `route.degraded_max_radius`, `route.degraded_reserve_factor`, the
detour factor, and the two §5.2 timeouts were all left exactly as found.

---

## 2. Frozen B1 Requirements

Read from the frozen architecture, not summarised from a planning document.

### 2.1 The interface and its budgets (§5.2)

| Requirement | §5.2's own words | Status in repository |
|---|---|---|
| Matrix query latency budget | 150 ms p99 | **Absent** — no client |
| Matrix query timeout | **hard**, "with `AbortController`-equivalent" | **Absent**, and **unregistered** |
| Path query latency budget | 400 ms p99 | **Absent** |
| Path query timeout | **hard** | **Absent**, and **unregistered** |
| Matrix failure behaviour | "Fall back to cached matrices; then to geometric bound × **detour factor**" | Ladder declared in prose only; **detour factor unregistered** |
| Path failure behaviour | "Cached path; then corridor-following fallback" | **Absent** |
| Matrix envelope reduction | "Max mission radius reduced to `route.degraded_max_radius`; energy reserve multiplied by `route.degraded_reserve_factor`" | Both parameters registered; **the first resolves to `null`** |
| Path envelope reduction | "only pre-surveyed corridors dispatched" | Declared in the degraded-mode register; no enforcement path |
| **Deployment mode** | **"Routing MUST be self-hosted"**; a metered per-request external API is "architecturally incompatible"; MUST be "colocated with the shard", "with precomputed contraction hierarchies or equivalent"; any external provider "MUST" be "a map-data source consumed offline rather than … a hot-path dependency" | **No engine deployed.** The only routing credential in the working tree is a `MAPBOX_TOKEN` in `.env.benchmark`, serving the legacy path §5.2 rules out |

### 2.2 Failure semantics (§18.3 B5, B6)

- **B5 — Routing Service unavailable.** Detection: timeout. Response: enter **Degraded Routing**
  (§18.5): cached matrices, then geometric bound × detour factor. Envelope:
  `route.degraded_max_radius`; reserves × `route.degraded_reserve_factor`; only pre-surveyed
  corridors hardened; reported optimality gaps widen and carry a degradation flag.
- **B6 — Routing Service partially failing.** Detection: per-request errors. Response —
  **the uniform-treatment rule**: *"if any candidate's route is unavailable, **all** candidates in
  that decision use the degraded estimator."* Its stated purpose is to prevent the baseline's
  partial-failure bias, "where candidates in a failed batch received the best possible travel-time
  score purely because their data was missing."

### 2.3 Performance targets (§20.1) — resolved live from the register

| Row | Registered parameter | Value | Statistic |
|---|---|---:|---|
| Approach routing matrix, 200×1, cached | `perf.approach_routing_matrix_p99` | 20 ms | p99 |
| Return-leg charger reachability, cached | `perf.charger_reachability_cached_p99` | 10 µs | p99 |
| Return-leg charger reachability, on miss | `perf.charger_reachability_miss_p99` | 2 ms | p99 |
| Cost per candidate (routing cached) | `perf.cost_per_candidate_p99` | 100 µs | p99 |
| **Round wall clock (500 × 200)** | `perf.round_wall_clock_p99` | **250 ms** | p99 |
| Return-leg lookups per round | — | ≤ `m · k`, same caps as approach | budgeted |

All stated **per shard, at p99, under nominal operation**, on representative production hardware.

### 2.4 The routing cost model (§20.3)

- **Two per-candidate populations, not one**, and the second is as large as the first. Approach and
  linehaul are anchored on mission origins, which cluster; return-leg queries are anchored on
  projected mission-*end* positions, which do not, so the second **does not share the first's
  cache** and carries its own budget line.
- Seven mitigations, of which item 5 is the decisive one for B1: *"**Precomputed hierarchies.**
  Contraction hierarchies or equivalent, so a query is microseconds rather than milliseconds.
  **This is the reason routing must be self-hosted (§5.2): the precomputation is the optimisation**,
  and a metered request-per-query API cannot provide it."*
- Item 4: one **batched matrix per cell cluster**, shared across the Legs in that cluster.
- Steady-state cache hit-rate targets: **> 95 %** cell-pair, **> 90 %** charger-reachability, both
  reported separately and both alertable.

### 2.5 Governance (§22.1, §22.3)

- §22.1 item 1: **no behavioural constant in code** — "Every threshold, weight, **timeout**, …
  is configuration." The moment `client.js` exists, `gate:params` requires the matrix timeout, the
  path timeout, and the detour factor to be registered with unit, range, owner, change class, and
  blast radius.
- §22.3: the **detour factor multiplies energy reserves through §18.3 B5**, which makes it
  **Safety-class** — safety review, **two-person approval**, staged rollout, mandatory post-change
  monitoring, and "cannot be changed by any automated process."

### 2.6 Verification (§24.6) and the open decision (§27 item 2, plan §6.1)

- §24.6 requires round time measured against §20.1, the cross-scale locality test, soak, and
  overload tests — none of which is a routing micro-benchmark.
- §27 item 2: *"Routing engine — OSRM, Valhalla, GraphHopper, or in-house. **Whichever supports
  per-profile contraction hierarchies and multi-modal networks; self-hosted is non-negotiable
  (§5.2).** Depends on: modality roadmap."*
- Execution plan §6.1: B1 blocks **Phases 7, 8 and 9**, and is "the **longest lead time** of any
  item here." §6.2 records the mitigation actually taken: *"the cell-pair cache interface can be
  developed against a stub."*

---

## 3. Current Repository State

Every claim in this section was re-derived by execution or by reading the file, not taken from the
consolidated report.

### 3.1 What exists

| File | Role | Verified |
|---|---|---|
| `src/engine/routing/cellPairCache.js` | §20.3 item 2, approach population; `key`, `buildEntry`, `applyIntraCellOffset`, `read`, `write`, `hopsFor`, `Counters` | Read in full |
| `src/engine/routing/chargerReachabilityCache.js` | §20.3 item 3, return-leg population, **Tier 0**; adds `assertVersionInKey`, `precompute` | Read in full |
| `src/engine/degraded/modeRegister.js` | `DEGRADED_ROUTING` mode, naming both envelope parameters and `uniformDegradedEstimation: true` | Read |
| `src/engine/failure/infraFailures.js` | B5 and B6 rows, `uniformTreatment: true` | Read |
| `src/workers/chargerReachability.worker.js` | Precompute on projection publication; takes `route()` injected | Read |
| `tools/routing/b1Benchmark.js` | The B1 evidence procedure | Read in full, run, **corrected** (§3.4) |

Both caches take the routing call as an **injected function** and carry no dependency on any
engine — the seam §6.2 prescribes. That is intact and is the reason B1 has not contaminated the
rest of the engine.

### 3.2 What does not exist

| Missing | Evidence |
|---|---|
| `src/engine/routing/client.js` | `ls src/engine/routing/` returns exactly two files. `src/engine/ARCHITECTURE.md` maps the §3.2 Routing Service to `client.js`, `cellPairCache.js`, `chargerReachabilityCache.js`, phase **8** |
| §5.2's two hard timeouts | `grep -rn "timeout" src/engine/routing/` matches **prose in one doc comment** and no code |
| The degradation ladder | No module computes a geometric bound × detour factor. `grep -rn "detour" src/` returns four hits, all prose |
| §18.3 B6's uniform-treatment rule | `uniformDegradedEstimation` and `uniformTreatment` have **no consumer**: the only references outside their own definitions are two assertions in `tests/engine/failureCatalogue.test.js` |
| Registered timeout / detour parameters | The register holds exactly seven `route.*` entries — `cell_pair_cache_ttl`, `cell_pair_min_hit_rate`, `charger_reachability_k`, `charger_reachability_min_hit_rate`, `degraded_max_radius`, `degraded_reserve_factor`, `intra_cell_offset_m`. **None is a timeout or a detour factor** |
| Any approach-population wiring | **New finding.** `cellPairCache.hopsFor()` has no consumer under `src/`. `plan/planBuilder.js` takes `hopsForSequence` injected; only `tests/engine/helpers/planFixture.js` supplies one |
| A composition root | `grep -rn "expandCandidates" server.js src/` finds only definitions and injected `deps` — `server.js` constructs neither the coordinator's nor the shadow's bundle |

`gate:params` passes today **only because no module implements the missing parameters**.

### 3.3 The two calibration values the ladder needs, as they actually stand

Resolved live from `service.defaultSnapshot()`:

| Parameter | Registered value | Status | Change class | `awaits` |
|---|---:|---|---|---|
| `route.degraded_max_radius` | **`null`** | UNCALIBRATED | **SAFETY** | "per-region straight-line-versus-network error measurements" |
| `route.degraded_reserve_factor` | 1.4 | PROVISIONAL | **SAFETY** | "measured degraded-estimate error distribution" |
| detour factor | — | **not in the register at all** | would be SAFETY (§22.3) | — |

Both `awaits` clauses require **an engine to compare a straight line against**. This is the
circularity at the centre of B1: the degradation ladder needs a value that only a deployed engine
can produce.

### 3.4 The B1 benchmark — understood, run, and corrected

`npm run routing:b1` was run before anything was changed. It reported `NOT_MEASURED` on all six
rows and exited 0, exactly as documented.

The tool was then read in full and driven with a **zero-latency in-process stand-in that routes
nothing**, to exercise its measured half. That is where the defect surfaced:

```
  PASS      approach_routing_matrix        observed  0.17 ms   target < 20 ms
  PASS      cell_pair_hit_rate             observed  100.0 %   target ≥ 95 %
  EXCEEDED  charger_reachability_cached    observed  20.8 µs   target < 10 µs
  PASS      charger_reachability_miss      observed  0.01 ms   target < 2 ms
  EXCEEDED  charger_reachability_hit_rate  observed   50.0 %   target ≥ 90 %

  2 row(s) EXCEEDED. This engine does not meet §20.1's routing budget in this shape.
```

Two of those verdicts are about nothing the engine did.

- **`charger_reachability_hit_rate` is 0.50 by construction.** `measure()` walks the return-leg
  cells once cold (every read a miss) and once warm (every read a hit). Confirmed invariant across
  two engines and two workload shapes. Being below the 0.90 target, it returned `EXCEEDED` and
  `main()` returned 1 — **so every candidate engine ever measured would have been rejected**, on a
  number that is a property of the loop.
- **`cell_pair_hit_rate` is 1.00 by construction** — the same defect with the opposite sign: an
  unearned `PASS`, since the harness warms every cluster before reading it.
- **`charger_reachability_cached` calls no engine at all.** A cache hit is `chargerCache.read()`
  plus the kv client; the adapter is never invoked on that path.

Neither hit rate is the *steady-state* rate §20.3 states a target for. A steady state is a property
of live demand, cell size and TTL expiry over hours, and a cold single process cannot observe one.

**The correction** (`tools/routing/b1Benchmark.js`, one file, plus its tests): every row now
declares an `attribution` — `ENGINE` (the timer brackets a call into the adapter), `CACHE_PATH`
(the engine is never called), or `HARNESS_ARTIFACT` (fixed by the harness's own access pattern).
`HARNESS_ARTIFACT` rows are reported `NOT_MEASURED` with the figure carried beside them as
`harnessObserved`, so nothing is hidden and nothing is compared against a target it cannot speak
to. An over-budget `CACHE_PATH` row still exits non-zero — it is a real §20.1 finding — but says in
words that the engine was not called on that path. The engine-relevant quantity the hit-rate rows
were reaching for is now reported honestly as an **amortisation** count: queries issued against
reads served, per population, with no threshold attached.

**This is a strengthening, not a weakening.** It removes one unearned `PASS` and one spurious
`EXCEEDED`, and it takes nothing out of the failing path: the "a slow engine fails" and "a slow
return-leg population fails independently" tests are untouched and still pass.

---

## 4. Available Routing Engines

**None. Not one candidate engine is present, installed, or deployable in this environment.**

The candidate set is fixed by the frozen architecture (§27 item 2) and the execution plan (§6.1):
**OSRM, Valhalla, GraphHopper, or in-house.** Nothing in this repository or environment adds to it
or subtracts from it.

| Engine | Present here? | Deployable here today? | Evidence |
|---|---|---|---|
| OSRM | **No** | **No** | `which osrm-routed osrm-extract` → not found. No container image; the Docker daemon is not running |
| Valhalla | **No** | **No** | `which valhalla_service` → not found. Same |
| GraphHopper | **No** | **No** | `which graphhopper` → not found. Java 20.0.2 **is** present, so the runtime exists; the engine, the extract, and the profiles do not |
| In-house | **No** | **No** | Nothing under `src/` or `tools/` routes. The legacy `src/services/routing.service.js` is A\* over a waypoint array with a **Mapbox Directions** call and a **straight-line fallback** — the exact F6 anti-pattern §5.2 calls architecturally incompatible |
| Mapbox (incumbent) | Credential present | **Ruled out by §5.2**, not by measurement | `MAPBOX_TOKEN` in `.env.benchmark`; metered per-request external API on the hot path is prohibited |

**Per-candidate attributes were deliberately not filled in.** The brief requires engine, version,
deployment mode, map data, region availability, matrix support, path support, cache compatibility,
determinism, failure behaviour, timeout support, operational requirements, contraction-hierarchy
support, refresh requirements and resource requirements — **fifteen attributes, per candidate, none
of which can be verified from this environment.** Stating them from recollection would be inventing
availability, which §5 of the brief forbids and which is the one thing that would make this report
worthless. They are obtained by executing §18's procedure, and each must be confirmed against the
**deployed version**, because every one of them has changed across releases of all three engines.

Two scoping questions the ADR must answer before any of them is benchmarked, both derived from the
repository rather than from recollection:

1. **Which traversal domains must the engine serve?** `domain/mobilityModel.js` declares four:
   `ROAD_GRAPH`, `SIDEWALK_GRAPH`, `INDOOR_GRAPH`, `AIRSPACE_VOLUME`. The three named OSM engines
   address the first two. §6.2 already says indoor and multi-level sites "use site-local graph
   zones rather than geodesic cells", and §25.2 makes airspace a drone-modality extension — so the
   honest reading is that B1 scopes the outdoor graph and the other two domains are separate
   decisions. **That has to be written down, because §27 item 2 makes the choice depend on
   "multi-modal networks" and the modality roadmap.**
2. **How many contraction hierarchies is that?** `mobilityModel.routingProfileKey()` is
   `{modelId}:{domains}:{loaded|unloaded}` — **loaded and unloaded are distinct profiles**, because
   §15.5 makes mass and centre-of-gravity a routing constraint. So the hierarchy count is
   *(declared mobility models) × 2*, per region, and **the declared model set is empty**, so the
   count is currently zero and unknowable.

---

## 5. Environment / Deployment Availability

Checked directly. Nothing here is inferred.

| Requirement (brief §5) | Present? | Evidence |
|---|---|---|
| A routing engine binary or service | **NO** | No `osrm-*`, `valhalla_service`, or `graphhopper` on `PATH`; no routing dependency in `package.json` (`h3-js` is the spatial index, not a router) |
| A container runtime to deploy one | **PARTIAL** | Docker CLI **29.5.3** is installed; the daemon is **not running** — `docker info` fails at `npipe:////./pipe/dockerDesktopLinuxEngine`. WSL 2 is present with `docker-desktop` as default distribution |
| A JVM (GraphHopper's runtime) | **YES** | `java version "20.0.2"` |
| The target-region map extract | **NO** | `find` for `*.osm*`, `*.pbf`, `*.osrm*`, `*.gh` across the repository returns **nothing** |
| **A declared target region** | **NO — and this is the binding prerequisite** | `service.defaultSnapshot()` → `spatial: null`, `shards: null`, `bindings: {}`. No region, no zone map, no cell assignment, no shard definition. `validators.v8SpatialContainment(null)` returns `[]`, so the cross-parameter check is vacuous today |
| Required profile data | **NO** | No mobility model is declared anywhere in configuration; the profile key is derivable but there is nothing to derive it from |
| Required preprocessing (per-profile CH) | **NO** | Nothing to preprocess, and nothing to preprocess it for |
| A deployable endpoint | **NO** | No routing host, port, or URL in any `.env` or config file |
| Representative hardware | **NO** | A Windows 11 laptop with 66 GB free of 363 GB. It is not a shard, not colocated with one, and not production-shaped |

**Disposition, stated plainly: no adapter was written, no engine response was faked, and no
benchmark number was fabricated.** The one stand-in used anywhere in this pass routes nothing,
lives under `tests/engine/helpers/`, is named `nullRoutingAdapter.js`, and says in its own header
that it "is not a candidate engine and not B1 evidence." Its only job is to let the CLI's exit-code
path be asserted.

---

## 6. Benchmark Methodology

What was run, and what each run can and cannot support.

| # | Run | What it measures | What it can support |
|---|---|---|---|
| 1 | `npm run routing:b1` | Nothing — no engine supplied | That the procedure reports `NOT_MEASURED` and exits 0 without claiming anything |
| 2 | `tools/routing/b1Benchmark.js --engine <null adapter>`, §20.1's 500 × 200 / 25-cluster shape, 5 runs | **The shipped cache path**, with engine latency held at zero | The `CACHE_PATH` finding (§7, N16) and the harness-artifact proof (§3.4). **Nothing about any engine** |
| 3 | `measure()` at the default shape, 1 warm-up + 3 measured, in a scratchpad script outside the repository | Whole-harness wall clock at §20.1's shape | The cache-path floor (§15, N17) |
| 4 | Loopback Redis `GET` × 2 000 against a realistic charger-reachability entry | The shipped `kv` tier's read latency | That §20.1's < 10 µs cached row is unreachable through Redis (§7, N16) |
| 5 | `npx jest tests/engine/routingB1Benchmark.test.js` | The tool's own correctness, including both failing branches | That the corrected procedure works before an engine is ever attached |

**Measurement class, in the taxonomy `PHASE_10_COST_SCALING_IMPLEMENTATION_REPORT.md` §8 now
carries: every figure in this report is a *diagnostic measurement*.** None is
implementation-author benchmark evidence, none is independent-verification benchmark evidence, and
**none is formal §20.1 gate evidence** — §20.1 is stated per shard, at p99, under nominal
operation, on representative production hardware, over the whole round. Runs 2–4 are a single
process on a build machine measuring one stage. Every one of them can rule something OUT; not one
can rule anything IN.

The benchmark's own workload shape was **not** weakened, and a test pins it: `DEFAULT_WORKLOAD.legs`
must equal `solve.max_legs_per_round` (500) and `candidatesPerLeg` must equal
`candidate.max_evaluated` (200). Runs at any other shape happen only inside the tool's own tests.

---

## 7. Independent B1 Measurements

| Engine | Matrix | Cell Cache Hit | Charger Hit | Charger Miss | Failures | Determinism | Status |
|---|---:|---:|---:|---:|---|---|---|
| OSRM | `NOT_MEASURED` | `NOT_MEASURED` | `NOT_MEASURED` | `NOT_MEASURED` | `NOT_MEASURED` | `NOT_MEASURED` | **NOT DEPLOYED** |
| Valhalla | `NOT_MEASURED` | `NOT_MEASURED` | `NOT_MEASURED` | `NOT_MEASURED` | `NOT_MEASURED` | `NOT_MEASURED` | **NOT DEPLOYED** |
| GraphHopper | `NOT_MEASURED` | `NOT_MEASURED` | `NOT_MEASURED` | `NOT_MEASURED` | `NOT_MEASURED` | `NOT_MEASURED` | **NOT DEPLOYED** |
| In-house | `NOT_MEASURED` | `NOT_MEASURED` | `NOT_MEASURED` | `NOT_MEASURED` | `NOT_MEASURED` | `NOT_MEASURED` | **DOES NOT EXIST** |
| Mapbox (incumbent) | `NOT_MEASURED` | `NOT_MEASURED` | `NOT_MEASURED` | `NOT_MEASURED` | `NOT_MEASURED` | `NOT_MEASURED` | **EXCLUDED BY §5.2** — metered per-request external API, prohibited on the hot path; not a candidate and not benchmarked |

**No engine was measured, because no engine exists to measure.** The two hit-rate columns are
`NOT_MEASURED` for a second, independent reason that will still hold on the day an engine is
deployed: a steady-state hit rate is not observable from a single cold process (§3.4).

### 7.1 What *was* measured — engine-independent, and not an entry in the table above

These are properties of the shipped cache path and the shipped `kv`, measured with engine latency
held at **zero**. They are recorded here because they change B1's scope, not because they say
anything about a candidate.

| Quantity | Observed | §20.1 target | Note |
|---|---:|---:|---|
| `charger_reachability_cached` p99, in-memory kv, 5 runs | **8.9, 9.0, 9.0, 9.2, 15.2 µs** | < 10 µs | `CACHE_PATH`. Straddles the target on this machine; 1 of 5 runs exceeded |
| Loopback Redis `GET` p50 / p99, n = 2 000 | **304 µs / 1 156 µs** | < 10 µs | **30×–115× over.** The shipped `kv` is `ioredis` |
| Whole cache path, §20.1's 500 × 200 shape, 3 runs after warm-up | **246.1, 244.4, 241.3 ms** | 250 ms *whole round* | Zero-latency engine, in-memory kv |
| Approach amortisation | **25 engine queries → 100 000 cache reads** | — | §20.3 item 4's batching, working as designed: 4 000× |
| Return-leg amortisation | **2 500 engine queries → 5 000 cache reads** | — | **2×.** §20.3's warning that the second population does not amortise, quantified |

**N16 — §20.1's cached charger-reachability row is unreachable through the shipped cache tier, for
reasons unrelated to B1.** A Redis round trip is two orders of magnitude above a 10 µs budget, on
loopback, on this machine, before any network. A colocated Linux Redis over a unix socket is
faster, but not by 30×. The Phase 8 routing client therefore requires an **in-round, in-process**
tier in front of Redis, with Redis as the cross-round tier — and the arithmetic makes the point
sharper than the p99 does: **100 000 approach lookups × 304 µs ≈ 30 s per round** if the client
issues one kv read per candidate. This is discoverable now, it needs no engine, and it should be
settled *before* an engine is benchmarked, because it changes what the benchmark should measure.

---

## 8. Precomputation / Operational Requirements

§20.3 item 5 makes the precomputation the point, so an engine measured without it is not measured.
**None of the following can be recorded here, and each must appear in the ADR:**

| Quantity | Value | Why it is unknown |
|---|---|---|
| Region extract identity | `NOT_DETERMINED` | **No target region is declared** (§5). The seed fixtures carry Indian coordinates (20.59, 15.32, 12.97, 12.93) but they are simulator seed data, not a published region map |
| Extract size | `NOT_DETERMINED` | Follows from the region |
| Profile count | `NOT_DETERMINED` | *(declared mobility models) × 2* for loaded/unloaded; **zero models are declared** |
| Hierarchy build time, per profile | `NOT_MEASURED` | Requires the engine and the extract |
| Hierarchy build memory / CPU | `NOT_MEASURED` | Same |
| Runtime memory per profile | `NOT_MEASURED` | Same |
| Extract refresh cadence | `NOT_DECIDED` | An operations decision. Note it interacts with **B6** (map obstruction classification), whose own parameter `map.obstruction_class_max_age` awaits "the region's map hazard-data publication cadence" |
| Refresh procedure and re-contraction window | `NOT_DECIDED` | A re-contraction is a rebuild, not a reload; §5.2 requires the service to stay colocated and available throughout |
| Colocation topology | `NOT_DECIDED` | §5.2 requires it "colocated with the shard" — which makes it a per-shard resource cost, and therefore an input to §3.5's shard-sizing inequality |

**A raw query benchmark alone cannot close B1**, and this report does not present one.

---

## 9. Safety Assessment

Not one of the safety properties can be verified, because the artefact that would have them does
not exist. Recording them as unverified is the point.

| Property | Verifiable? | State |
|---|---|---|
| Travel-time semantics preserved | **No** | No client, no engine |
| Distance semantics preserved | **No** | Same |
| Route feasibility | **No** | Same |
| Energy calculations | **Partially, and unaffected by B1's absence** | `energy/eReturn.js` and F34/F35 are complete and consume the charger-reachability cache; what is missing is the routing that would populate it |
| Reserve calculations | **No, for the degraded path** | The degraded reserve multiplier is registered but `route.degraded_max_radius` is `null` |
| Candidate eligibility | **No** | `expandCandidates` needs `evaluateExact`, which needs travel times |
| Deterministic output | **Structurally yes, empirically no** | Both caches are clock-free and randomness-free, and take the time bucket as an input specifically so two workers in one round cannot key differently. The engine's own determinism is `NOT_MEASURED` and must be measured: an engine that returns different times for identical queries breaks §9.6 replay |
| Timeout behaviour | **No** | Neither timeout exists in code or in the register |
| Failure behaviour | **Partially** | The caches are correct here already: a read error is a miss, a write failure is silent, and a router failure is **reported to the caller rather than guessed at** (I16). That is the right half. The half that decides *what to do about it* is the client |
| Degradation semantics | **No** | The ladder is prose |
| **Uniform treatment of unavailable routes (§18.3 B6)** | **No — and this is the sharpest safety gap** | `uniformDegradedEstimation: true` and `uniformTreatment: true` are **declarations with no consumer**. The rule exists to stop a candidate scoring best *because its data was missing*; today nothing enforces it, and it must be enforced by the client that does not exist |

**No Safety-class value was invented.** Specifically not invented: the detour factor, the degraded
radius, the degraded reserve multiplier, any energy safety margin, and `sim.max_optimistic_bias` —
which was not touched at all, its §22.3 two-person-approval circularity being a governance matter
outside this task.

---

## 10. Calibration Dependencies

**ROUTING → CALIBRATION DEPENDENCY.** B1 cannot be closed past the measurement stage without values
that do not exist, and this report stops at that dependency rather than stepping over it.

| # | Value | State | Blocks | Class |
|---|---|---|---|---|
| 31 | `route.degraded_max_radius` | **UNCALIBRATED, resolves `null`** | The §5.2 / B5 degradation ladder | SAFETY. Awaits per-region straight-line-versus-network error measurements — **which require a deployed engine** |
| 32 | `route.degraded_reserve_factor` | PROVISIONAL (1.4) | The same ladder's reserve inflation | SAFETY. Awaits the measured degraded-estimate error distribution — **same dependency** |
| — | **detour factor** | **Not in the register** | The geometric-bound fallback | Would be SAFETY under §22.3: it multiplies reserves through B5. Requires §22.3 two-person approval to introduce |
| — | `route.matrix_timeout` (150 ms) | **Not in the register** | The hard matrix timeout | Would be TUNED or STRUCTURAL; §22.1 requires it registered before `client.js` ships |
| — | `route.path_timeout` (400 ms) | **Not in the register** | The hard path timeout | Same |

Two of the 39 blocking Safety-class calibration findings are on this list, and both are blocked
*behind* B1 rather than beside it. **The other 37 were not touched, and none of the 39 was derived,
edited, or reclassified by this pass.** `gate:calibration` remains red at 39.

---

## 11. Routing Engine Decision

**NO ENGINE IS SELECTED, AND NONE CAN BE SELECTED ON THE AVAILABLE EVIDENCE.**

§6.1 of the execution plan makes B1 a *decision*, not a benchmark result — and a decision requires
both an evidence base and an accountable decider. Neither exists. What this pass establishes is
that the decision is blocked at a point **earlier** than everyone has assumed:

1. **Declare the target region, its zone and cell map, and its shard definitions.** Until
   `spatial` and `shards` are published configuration, "the region extract" names nothing.
2. **Declare the fleet's mobility models.** They determine the profile set, which determines the
   contraction hierarchies, which §20.3 item 5 makes the whole point of the choice.
3. **Then** deploy the candidates and run §18's procedure.

Steps 1 and 2 need no procurement, no vendor, and no hardware. They are the shortest path to
unblocking the longest-lead item in the programme, and nothing in this repository is doing them.

---

## 12. Composition-Root Implications

**Yes — one shared composition root can satisfy both the shadow runner and the production
coordinator, and it should be built once. Verified by reading both dependency bundles.**

| Collaborator | Coordinator (`coordinator.worker.js`) | Shadow (`shadow.worker.js` → `observability/shadow.js`) |
|---|---|---|
| `round` | yes | yes |
| `expandCandidates` | yes | yes |
| `pricedCandidateFor` | yes | yes |
| `budgetsFor` / `budgets` | yes | yes |
| `deferPriceFor` | yes (Tier 2, injected) | yes |
| `planState` | **yes** | **must never** |
| `commit` | **yes** | **must never** |

The five shared collaborators are exactly the routing-dependent half. The two effect-bearing ones
are exactly the half shadow may not have — and the boundary is already enforced in code:
`shadow.assertNoEffects()` throws if a bundle carries `commit`, `dispatch`, `outbox`, a `prisma`
write client, or the coordinator's plan state, because *"a shadow run handed a commit function
would be a production run with a different label."* `shadow.worker.js` already builds a deliberately
fresh bundle rather than passing the coordinator's through.

**So the correct shape is one factory producing the five, with `planState` and `commit` added only
on the coordinator's side.** It cannot be built yet: `expandCandidates` requires
`evaluateExact(agentId, leg, snapshot)`, which needs the feasibility gate (F34/F35 → `E_return` →
the charger-reachability cache) and the Plan Builder's timeline (→ per-stop hops → the cell-pair
cache). Both terminate at a routing engine.

And it is **larger than `client.js`**: `cellPairCache.hopsFor()` has no production consumer, and
`planBuilder`'s `hopsForSequence` is supplied only by a test fixture. Wiring those is
composition-root work that becomes possible the moment an engine exists — and not before, because
a stub would produce what `workers/registry.js` calls the worst of the three possible states: *"a
worker that runs, reports success, and computes nothing."*

**No composition root was built, and no stub was written.**

---

## 13. Shadow Dependency

The trace the brief asks for, confirmed end to end by reading each link:

```
shadow.worker.runOne  →  observability/shadow.run  →  deps.expandCandidates
                      →  candidates/expansion.expandCandidates
                      →  input.evaluateExact(agentId, leg, agentSnapshot)
                      →  feasibility gate (F34/F35 → energy/eReturn → charger-reachability cache)
                      +  plan/planBuilder → plan/timeline.project({ hops })  → cell-pair cache
                      →  A ROUTING ENGINE.  That is B1.
```

This confirms finding **N11** of the consolidated remediation report: the shadow composition root is
**not** independent of B1, so the 14-day `cutover.shadow_agreement_window` sits *behind* the
longest-lead procurement item rather than beside it. The blocker plan's placement of it as "Track C,
concurrent with everything" remains wrong, and this pass found nothing that softens it — the
dependency is on `expandCandidates`'s own contract, not on an implementation detail that could be
worked around.

**The 14-day shadow window was NOT started. No worker was moved from `DEFERRED`. `shadow` remains
absent from `scheduledAtBoot()` and `scheduledOnLeadership()`, and `server.js` still does not
reference it.**

---

## 14. Production Coordinator Dependency

Confirms **N12**: `coordinator.worker.js` takes the same five collaborators as injected `deps`, and
**nothing in this repository constructs them outside a test fixture.** `grep` over `server.js` and
all of `src/` finds only definitions, JSDoc, and the injection sites themselves. The production
round loop is therefore blocked on B1 by the identical chain as shadow, one link longer (it also
needs `commit` and `planState`, both of which exist).

`ENGINE_ENABLED=false`, all 23 release gates block with no evidence filed, and `gates.blockers({})`
returns all 23. **No shard was staged, no scheduling was enabled, and no cutover step was taken.**

---

## 15. Scale-Target Implications

The decomposition, updated with what this pass measured and honest about what is still absent.

| Stage | Measured | Class | Source |
|---|---:|---|---|
| Candidate generation (§6.3) | `NOT_MEASURED` | needs the availability index + agent snapshots | budget: < 5 ms **per Leg** |
| Feasibility (§7) | `NOT_MEASURED` | needs agent state | budget: < 50 µs per candidate × 100 000 |
| `objective.buildInstance` | **324–337 ms** | diagnostic, standalone Node | consolidated report §13 |
| **Routing — approach, engine** | `NOT_MEASURED` | **B1** | budget: < 20 ms per cached 200×1 matrix |
| **Routing — return leg, engine** | `NOT_MEASURED` | **B1** | budget: < 10 µs cached / < 2 ms miss, × `m·k` |
| **Routing — cache path, engine-free** | **241–246 ms** | **new this pass**, diagnostic; zero-latency engine, in-memory kv | §7.1 |
| `minCostFlow.solve` | **576–607 ms** | diagnostic, standalone Node | consolidated report §13 |
| `objective.validate` | < 1 ms | diagnostic | consolidated report §13 |
| Plan pricing / column building (§8, §13) | `NOT_MEASURED` | needs the cost clients | O(q·s) |
| Commit (§10.3) | `NOT_MEASURED` | needs the database | budget: < 20 ms p99, < 100 ms p99.9 |

Four of roughly seven stages now have a number, and they sum to **1 154–1 177 ms against a 250 ms
whole-round p99 target** — with the dominant term, the engine itself, still entirely absent, and
with the routing figure taken under conditions (zero engine latency, in-process kv) that no
deployment will enjoy.

**The most consequential new fact is that the routing cache path alone is 241–246 ms — 96–98 % of
the entire round budget — before any engine, on a build machine, at p50-ish in one process.** That
does not mean the target is unachievable; it means the per-candidate lookup path is a first-order
design problem for Phase 8 that nobody has been scoping, and it strengthens rather than weakens the
consolidated report's conclusion that **no further solver optimisation should be scoped until
routing has a number.**

**WHOLE-ROUND SCALE COMPLIANCE REMAINS UNKNOWN.** The measured figures remain a **lower bound on
the gap, not the gap**.

**Nothing was changed:** the 250 ms target, the p99 statistic, the 500 × 200 candidate count, the
exponent limits, and every registered threshold are exactly as found. `scale_targets` is still RED
and this report does not move it.

---

## 16. Tests and Regression

### Changes requiring tests

Only one repository-side change was made — the B1 benchmark's attribution discipline (§3.4) — and
it is tested in both directions.

| Suite | Tests | Before | Change |
|---|---:|---:|---|
| `tests/engine/routingB1Benchmark.test.js` | **16** | 12 | +4 new; **1 existing assertion updated** |

The four new tests:

1. **both hit-rate figures are fixed by the harness** — asserted invariant at 1.00 and 0.50 across
   two engines × two workload shapes, pinning them as the constants they are, so that a future
   harness which genuinely observes a steady state must revisit the attribution deliberately;
2. **neither is compared against its target** — `NOT_MEASURED`, attribution `HARNESS_ARTIFACT`,
   `harnessObserved` still carried, note present;
3. **a fast engine is no longer failed by the CLI** — the end-to-end proof, run through `main()` at
   §20.1's full shape, asserting no `ENGINE` row is exceeded and that any surviving exit-1 names a
   `CACHE_PATH` row and says the engine was not called on that path;
4. **the amortisation block** reports queries issued against reads served, per population.

**The one existing assertion changed, disclosed in full:** `cell_pair_hit_rate` was asserted `PASS`
and is now asserted `NOT_MEASURED`. That is a **stronger** claim — the `PASS` it used to make was
produced by the harness pre-warming the cache and reading it back, identical for every engine. The
change is annotated in the test file itself. **No other test was modified, skipped, deleted, or had
a threshold relaxed**, and the tool's two deliberately-failing branches ("a slow engine fails", "a
slow return-leg population fails independently") are untouched and still pass.

One new test helper was added: `tests/engine/helpers/nullRoutingAdapter.js`, whose header states
that it is not a candidate engine and not B1 evidence.

### Results

| Suite / gate | Result |
|---|---|
| `npx jest tests/engine/routingB1Benchmark.test.js` | **PASS — 1 suite, 16 tests, 0 failures** |
| `npm run gate:tenets` | **PASS — 271 modules, 0 violations** |
| `npm run gate:legacy` | **PASS — 4 retired modules absent, 288 files scanned** |
| `npm run gate:params` | **PASS — 180 engine modules, 242 parameters, 0 bare constants** |
| `npm test -- --runInBand --forceExit` | **PASS — 140 suites, 6 111 tests, 0 failures, 199.9 s** |
| `npm run routing:b1` | 6 rows `NOT_MEASURED`, exit 0 — unchanged, correct, and still claiming nothing |

The regression arithmetic reconciles exactly against the consolidated report's baseline:

| | Suites | Tests |
|---|---:|---:|
| Baseline (`PHASE_15_CONSOLIDATED_REMEDIATION_REPORT.md` §15) | 140 | 6 107 |
| `routingB1Benchmark.test.js` — the four regression tests of §16 | — | **+4** |
| **Final, measured** | **140** | **6 111** |

The delta is entirely additive. **No suite was added or removed, and 6 107 of the 6 111 are the same
assertions the consolidated remediation ran** — one of which now asserts something stronger.

### A pre-existing flaky test, found by running the suite and deliberately not fixed

The **first** full run of the suite came back **1 failed, 6 110 passed** —
`tests/engine/privacySurrogateKeys.test.js`, *"an edited ciphertext fails to decrypt rather than
decrypting to something else."* It is unrelated to anything this pass touched, and the mechanism was
established rather than guessed:

`identityStore.seal()` uses a random IV, so the ciphertext differs on every run. The test "tampers"
by replacing the final byte with `ff` — and **when the final byte is already `0xff`, the tampered
ciphertext is byte-identical to the original**, AES-256-GCM authenticates it correctly, and
`unseal()` rightly does not throw. Measured over **50 000 trials**: the last byte was already `0xff`
**182 times (0.364 %)**, against the predicted 1/256 = 0.391 %, and `unseal` failed to throw on
**exactly those 182 and no others**.

So it is a **~1-in-256 flaky test, not a defect** — the cipher behaved correctly in all 50 000
trials. Re-running the suite passes: `privacySurrogateKeys.test.js` alone → 20/20, and the full
suite → **140 / 6 111 / 0**, which is the figure recorded above.

**It was not fixed, deliberately.** It is unrelated to B1, and the brief forbids unrelated source
changes. The one-line fix, for whoever owns it: flip the final byte rather than assign it — e.g.
`(parseInt(last, 16) ^ 0xff).toString(16).padStart(2, "0")` — so the tamper can never be a no-op.

### Change control

`git status --porcelain` was captured before the first edit and again at the end, and the two were
diffed rather than eyeballed: **369 entries → 371**, the delta being exactly two new untracked
files — `Backend/tests/engine/helpers/nullRoutingAdapter.js` and this report.

`git diff --stat` is **byte-for-byte identical** to the baseline before and after —
`59 files changed, 11603 insertions(+), 1593 deletions(-)` — which proves **no tracked file was
modified by this pass at all**.

Stated explicitly so the record is not read as stronger than it is: `tools/routing/b1Benchmark.js`
and `tests/engine/routingB1Benchmark.test.js` were **already untracked** when this pass began (they
are the previous pass's uncommitted work, under `?? Backend/tools/routing/`), so the edits made to
them are genuine changes that do not appear in `git diff`. They are listed in the table below and
are the only two existing files this pass touched.

| File | Change | Kind |
|---|---|---|
| `Backend/tools/routing/b1Benchmark.js` | Attribution discipline; hit-rate rows → `NOT_MEASURED` with `harnessObserved`; amortisation counts; exit message distinguishes `ENGINE` from `CACHE_PATH` | Modified |
| `Backend/tests/engine/routingB1Benchmark.test.js` | +4 tests; 1 assertion updated (§16) | Modified |
| `Backend/tests/engine/helpers/nullRoutingAdapter.js` | Test fixture that routes nothing | **New** |
| `PHASE_15_B1_ROUTING_DECISION_REPORT.md` | This document | **New** |

Verified, mechanically rather than asserted:

- **No solver file was touched.** All seven `src/engine/solve/*.js` retain modification times from
  before this session (`costScaling.js` 19:00, `minCostFlow.js` 19:01, the rest 2026-08-05).
- **Nothing under `Backend/src/` was modified at all** — the entire production source tree is
  byte-identical to its state at the start of this pass.
- No calibration value, status, `awaits` field, or derivation was changed.
- No threshold was changed; no gate was bypassed or waived.
- No Phase 16 file exists or was created; `src/engine/fairness/` still holds only `.gitkeep`.
- No unrelated source was changed.
- **No commit was created.**

---

## 17. Remaining B1 Blockers

| # | Blocker | Nature | Can it be worked here? |
|---|---|---|---|
| **1** | **No declared target region, zone/cell map, or shard definition** (`spatial: null`, `shards: null`) | Configuration + an operations decision | **YES — and nothing else on this list can start until it is done** |
| **2** | **No declared mobility models**, so the profile set and therefore the hierarchy count are unknown | Configuration + the modality roadmap (§27 item 2's stated dependency) | **YES** |
| **3** | No engine deployed; no extract; no contraction hierarchies | Procurement + deployment + representative hardware | **No** |
| **4** | `src/engine/routing/client.js` absent, with §5.2's two timeouts, the degradation ladder, and §18.3 B6's uniform-treatment rule | Phase 8 capability | **No** — blocked on 3 and on 6 |
| **5** | Three unregistered parameters — matrix timeout, path timeout, **detour factor** (Safety-class) | §22.1 registration; the third needs §22.3 two-person approval | Registration is possible; **the detour factor's *value* is not derivable here** |
| **6** | `route.degraded_max_radius` (`null`) and `route.degraded_reserve_factor` (PROVISIONAL) | Safety calibration, both `awaits` requiring a deployed engine | **No** |
| **7** | **The per-candidate lookup path cannot meet §20.1 through Redis** (N16) | Phase 8 design | **YES — measurable and designable now, with no engine** |
| **8** | No composition root for `expandCandidates`/`evaluateExact`, and no production consumer of `cellPairCache.hopsFor` | Composition-root work | **No** — blocked on 3 |
| **9** | Charger-reachability worker `DEFERRED` for want of a routing client | Scheduling | **No** |

Items 1, 2 and 7 are repository- and decision-side work that can proceed immediately, in parallel,
and they are the only ones on the list that can.

---

## 18. Exact External Evidence / Deployment Required

The executable procedure, in order. Steps 1–2 need nothing external.

**1. Declare the region (no procurement required).** Publish `spatial` (zones, fine/coarse cell
assignments, region membership) and `shards` through the Config Service, so that
`validators.v8SpatialContainment` and the §3.5 shard-sizing inequality stop being vacuous. Record
the region's bounding geometry — **that is what names the extract.**

**2. Declare the mobility models (no procurement required).** One per agent class, with all six
§2.2 elements. Then the profile set is
`routingProfileKey(model, {loaded}) = {modelId}:{domains}:{loaded|unloaded}`, and the hierarchy
count is *models × 2*. Decide in the ADR whether `INDOOR_GRAPH` and `AIRSPACE_VOLUME` are in B1's
scope or are separate decisions (§4).

**3. Settle the per-candidate lookup tier (no procurement required).** Design the in-round
in-process tier N16 requires, and re-run the cache-path measurement of §7.1 against it. Do this
before benchmarking engines, because it changes what the benchmark should attribute to the engine.

**4. Deploy each candidate against the region extract, with per-profile contraction hierarchies
BUILT.** §20.3 item 5 makes the precomputation the point; an engine measured without it is not
measured. On this machine that requires, at minimum, starting the Docker daemon (installed, not
running) or provisioning a Linux host — and it should be neither, because §20.1 is stated on
representative production hardware colocated with a shard.

**5. Write one adapter per candidate** to the contract in `tools/routing/b1Benchmark.js`'s header:
`matrix({originCellId, destCellIds, profileKey, timeBucket})` and
`nearestChargers({destCellId, profileKey, timeBucket, k})`. The adapter is the only thing that
talks to an engine; nothing under `src/engine/` may gain a dependency on it.

**6. Measure, per candidate, on representative hardware:**

```
npm run routing:b1 -- --engine <adapter> --json
```

Record all six rows plus the amortisation block. Repeat enough times to show stability, and
**publish every run** — the §7.1 spread here (8.9–15.2 µs across five runs of the same code) is
exactly why a single run must not be quoted. Note that the two hit-rate rows will report
`NOT_MEASURED`, by design: measure them instead from the live cell-pair and charger-reachability
SLIs once a shard serves traffic.

**7. Record what §20.1 does not name but the decision must carry:** hierarchy build time and memory
per profile, extract size, runtime memory, refresh cadence and re-contraction window, colocation
topology, and the per-shard resource cost that feeds §3.5.

**8. Measure engine determinism explicitly.** Identical queries must return identical times, or
§9.6 replay breaks. No row in the current tool covers this; it needs its own check against a
deployed engine.

**9. Choose, and write the ADR.** §6.1 makes B1 a decision, not a benchmark result.

**10. Then, and only then, Phase 8's `client.js`** — with §5.2's two hard timeouts, the degradation
ladder, and §18.3 B6's uniform-treatment rule; with `route.matrix_timeout`, `route.path_timeout`
and the detour factor **registered** under §22.1; and with the detour factor approved under §22.3's
two-person Safety process, because it multiplies energy reserves.

**11. Then the two Safety calibrations** (`route.degraded_max_radius`, `route.degraded_reserve_factor`),
each from a measured straight-line-versus-network error distribution per region, against the
deployed engine.

**12. Then the shared composition root** (§12), then shadow, then the 14-day window.

---

## 19. Recommendation

**Resolve items 1, 2 and 7 of §17 immediately — they need no vendor, no hardware, and no budget,
and every other B1 item is behind them.** The programme has been treating B1 as a procurement
problem with a long lead time. It is, but it also has a configuration prerequisite that nobody has
scheduled, and procurement cannot even be specified until that prerequisite is met: you cannot
order an extract for an undeclared region or build hierarchies for an undeclared profile set.

Second, **fix the per-candidate lookup path before benchmarking engines** (N16, N17). The cache
path alone consumes 96–98 % of the whole-round budget with a free engine, and a Redis round trip is
30×–115× over the row it must serve. Benchmarking engines against a lookup tier that cannot meet its
own budget would attribute the tier's cost to whichever engine happened to be behind it — the same
misattribution this pass just removed from the benchmark itself.

Third, the two items the consolidated report recommends starting on the same day by different
people remain the right advice and are untouched by this work: **name the calibration owner (B8)**,
which gates 38 of the 39 parameters, and **rehearse the rollback in staging**, which depends on
nothing else.

**Do not scope further solver work.** This report changes nothing about that: routing is still
unmeasured, still the dominant term, and now known to carry an engine-independent problem of its
own.

---

# FINAL VERDICT

# B1 BLOCKED — ROUTING ENGINE DEPLOYMENT REQUIRED

*and, prior to it, region and mobility-profile declaration required — no extract can be specified
for an undeclared region, and no contraction hierarchy for an undeclared profile set.*

# PHASE 15: STILL BLOCKED

# PHASE 16: NOT READY

Two release gates remain RED, one PARTIAL, four `NOT_EVALUATED`; three of the five entry conditions
are unmet; `gates.blockers({})` returns all 23 rows with no evidence filed. Nothing in this pass
moved any gate, and nothing in it was intended to.

**The strongest result available here was an honest blocker, and one genuine defect found in the
evidence procedure that would have produced a false one.**

---

*End of Phase 15 B1 Routing Decision Report. No commit was created.*
