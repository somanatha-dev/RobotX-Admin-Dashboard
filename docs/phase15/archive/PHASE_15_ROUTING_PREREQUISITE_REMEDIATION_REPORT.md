# Phase 15 Routing Prerequisite Remediation Report

**Role:** Principal Systems Engineer, removing the repository-side prerequisites that prevent
blocking decision **B1** from being legitimately specified.
**Date:** 2026-08-09 · **Branch:** `feature/dashboard` · **Baseline:** `cf9103f`, Phases 6–15 as one
uncommitted working tree · **Node:** v22.17.0 · **Machine:** the build machine — a Windows 11
laptop. **Not representative production hardware, and not a shard.**

**Authoritative inputs, read in full before anything was written:**
`NEXT_GENERATION_ASSIGNMENT_ENGINE.md` (§2.1–2.2, §3.3, §3.5, §3.6, §5.2, §6.1–6.2, §9.6, §15.5,
§20.1–20.3, §22.1–22.3, §25.2–25.4, §27), `IMPLEMENTATION_EXECUTION_PLAN.md` (§6.1 B1/B5),
`PHASE_15_B1_ROUTING_DECISION_REPORT.md`, `PHASE_15_CONSOLIDATED_REMEDIATION_REPORT.md`,
`PHASE_15_INDEPENDENT_VERIFICATION.md`, `PHASE_15_BLOCKER_RESOLUTION_PLAN.md`.

**No routing engine was installed. No solver file was read for defects or modified. No calibration
value was derived, invented, edited, or reclassified. No threshold was changed. No gate was
bypassed. No test was weakened. No production configuration was published. No shadow was started.
No commit was created.**

---

## 1. Executive Summary

Three things were done, and one deliberately was not.

**1. The region and mobility-model prerequisites are documented, not fabricated** —
`PHASE_15_ROUTING_CONFIGURATION_DECISION.md`. The search for an authoritative definition turned up
**two artefacts the B1 report does not record**, and both sharpen the blocker rather than removing
it:

- `prisma/seed.js` declares `SEED_SPATIAL_MAP` — region **`RGN-BLR`**, two zones, one site, four
  fine cells — §3.6-validated and mirrored into the durable tables. It is a **Phase 2 containment
  demonstration, not a target region**: it is never published as a config version, its cell ids are
  placeholder tokens rather than the H3 indices B5 resolved to, four fine cells against §3.6's
  10³–10⁵ per region is under a square kilometre, and **no region, zone or site carries any
  geometry** — the zone bounding boxes are degenerate by design. **A routing extract is specified by
  a bounding geometry, and this repository contains none.** That it names Bengaluru is exactly the
  trap the brief warned against, and it was not taken.
- `prisma/seed.js` also declares **one** MobilityModel, `MOB-SIDEWALK-DEFAULT`, with all six §2.2
  elements present and `validateModel()` passing. So "zero mobility models are declared" is true of
  *configuration* and false of the *durable seed*. The profile set is therefore **derivable**:
  `MOB-SIDEWALK-DEFAULT:SIDEWALK_GRAPH:{loaded,unloaded}` — two profiles, two hierarchies, per
  region. But its **`speedModel` is a stub whose own text defers to B1**, and a contraction
  hierarchy is a precomputation over edge costs. There are no edge costs.

  A third finding falls out of reading §15.5 against the schema: **`MobilityModel` declares neither
  mass nor centre of gravity.** §15.5 makes both a *routing* constraint and is the cited reason
  loaded and unloaded are distinct profiles. The split is implemented; the quantity that gives it
  meaning is absent from the model.

**2. The cache-tier prerequisite is addressed, measured, and honestly short of its target.**
`src/engine/routing/inProcessCache.js` — a bounded, version-namespaced, clock-free in-process tier
plus a **kv-shaped façade**, so `cellPairCache.js` and `chargerReachabilityCache.js` compose with it
**without either changing by one character** and the §6.2 routing seam is preserved intact. Measured
at §20.1's own 500 × 200 / 25-cluster shape against the **shipped** configuration (ioredis):

| | Shipped (Redis) | With the tier | Change |
|---|---:|---:|---|
| Cache path, whole shape, median of 5 | **20 910 ms** | **1 463 ms** | **14.3× faster** |
| `charger_reachability_cached` p50 | 302 µs | **6.4 µs** | **47× faster** |
| Cross-round-tier reads per round | 105 000 | **2 500** | **42× fewer** (L1 serves 97.6 %) |

**And it still does not meet §20.1's targets, which is the finding, not a caveat.** The < 10 µs p99
row is missed by *every* configuration measured — including two with **no network in them at all**
(in-memory kv: p99 20.8 µs and 22.2 µs). The residual is not the store; it is
`chargerReachabilityCache.read()`'s own async-plus-`JSON.parse` path. A clean synchronous
pre-parsed read of the same tier measures **p50 0.90 µs, p99 2.10 µs — within target** — so 10 µs
*is* reachable in process, but only through a change to the cache modules' value contract, which is
Phase 8 routing-client work and outside this task's boundary.

**3. A quantitative model (§12) that says what the tier must still achieve** — and reaches a
conclusion that is not about the tier: at a real round's ~200 000 per-candidate routing reads, even
a *perfect* in-process tier at row F's 0.9 µs costs **180 ms of a 250 ms whole-round budget**. The
read *count* has to come down, which is what §6.4's admissible lower-bound pruning is for. It is a
Phase 8/9 integration property, not a cache property, and nobody has scoped it.

**What was deliberately not done:** no region was declared, no mobility model was created, no
schema was extended, no parameter was registered, no engine was installed, no client was written.
Each is recorded in the decision document as a named decision with a named owner.

**Regression:** 141 suites, **6 154 tests, 0 failures** — exactly the baseline 140/6 111 plus one
new suite of 43 tests. All four build gates PASS. `gate:calibration` remains FAIL at **39**,
unchanged.

---

## 2. Starting State

Re-derived by execution, not quoted.

```
$ node -e "…service.defaultSnapshot()…"
spatial:       null
shards:        null
bindings size: 0

route.degraded_max_radius              = null   UNCALIBRATED  SAFETY
route.degraded_reserve_factor          = 1.4    PROVISIONAL   SAFETY
route.cell_pair_cache_ttl              = 900    PROVISIONAL   TUNED
route.cell_pair_min_hit_rate           = 0.95   PROVISIONAL   TUNED
route.charger_reachability_k           = 5      PROVISIONAL   TUNED
route.charger_reachability_min_hit_rate= 0.9    PROVISIONAL   TUNED
route.intra_cell_offset_m              = 250    PROVISIONAL   TUNED

perf.charger_reachability_cached_p99   = 10 µs
perf.charger_reachability_miss_p99     = 2 ms
perf.approach_routing_matrix_p99       = 20 ms
perf.round_wall_clock_p99              = 250 ms
```

Seven `route.*` entries, none a timeout, none a detour factor. `src/engine/routing/` held exactly
two files. Every B1-report claim checked in this pass held.

---

## 3. Target Region Decision

**NOT TAKEN — it is external, and taking it would have been fabrication.**

Full analysis in `PHASE_15_ROUTING_CONFIGURATION_DECISION.md` §1–§3. In summary:

| Question | Answer |
|---|---|
| Is there an authoritative region definition? | **No.** `snapshot.spatial` is `null` |
| Is there anything region-shaped? | **Yes — `SEED_SPATIAL_MAP` (`RGN-BLR`)**, and it is a Phase 2 §3.6 containment demonstration |
| Can it be adopted? | **No.** Not published as a config version; placeholder cell ids, not H3; 4 fine cells against §3.6's 10³–10⁵; **no geometry anywhere** |
| Can the region be derived from the architecture? | **No.** §3.5 says what an OperatingRegion *is* ("a site, campus, depot catchment, or metro service area"), never which one this is |
| What is needed? | A stable `regionId`, a name, and **a boundary as GeoJSON or a bbox with its CRS** — decision **D1** |

The causal chain that makes D1 binding:

```
target region → bounding geometry → OSM extract → per-profile contraction hierarchies
                                                → extract size, build time, build memory
                                                → runtime memory per profile
                                                → per-shard resource cost → §3.5 sizing
```

Every row of the B1 report's §8 ("Precomputation / Operational Requirements") is downstream of the
first arrow. **There is no ordering in which the engine is chosen first.**

---

## 4. Spatial / Shard Configuration

### 4.1 The containers exist and are enforced; the content does not

**No schema change is required to publish either a spatial map or shard definitions.** Verified by
reading `validators.v8SpatialContainment()`, `spatial/hierarchy.js`, `spatial/cells.js`,
`shardModel.validateDefinition()`, `shardModel.validateDefinitions()` and `sizing.js`:

| Enforced today, blocking at publish | Rule |
|---|---|
| every zone names a region, and only one | §3.6 — else `Ω_terminal` bounds nothing the shard can reach |
| every fine cell maps to **exactly one** zone | §3.6 — containment by assignment, not geometry |
| every fine cell maps to **at most one** site | §3.6 |
| every shard names a `shardId` and a `regionId` | §3.5 |
| region → shard is a **function**; shard ids unique | §3.5 — else intake's "determined by its first Stop's region" has no rule |
| `N · r · k_txn · t_txn ≤ ρ_max · 3600`, **per shard** as well as globally | §3.5 bound 2 |

### 4.2 The five spatial gaps

| # | Gap | State |
|---|---|---|
| **S1** | **Region bounding geometry** — the field does not exist in the payload shape or on `Region` | **MISSING — binding** |
| S2 | H3 resolutions for FINE / COARSE (§6.2 wants ~200–500 m / ~5–10 km) | MISSING |
| S3 | The fine-cell set as H3 indices | PLACEHOLDER (4 tokens) |
| S4 | `Site.graphZones` for indoor/multi-level sites (§6.2) — column exists, unused | UNPOPULATED |
| S5 | Map extract vintage/provenance; `CellAssignment.mapVersion` defaults to `0` | PARTIAL |

### 4.3 The three shard gaps

| # | Gap | Why it cannot be defaulted |
|---|---|---|
| H1 | The region's **measured** `r` | §3.5: *"A dense urban shard running short hops at `r = 20` admits roughly 4 400 agents, not 20 000."* The register's `4` is PROVISIONAL and global |
| H2 | Number of regions/shards | Multiplies the hierarchy count |
| **H3** | **Routing colocation topology** | §5.2 requires the engine *"colocated with the shard"* — **and §3.5's sizing inequality carries no term for the routing engine's per-shard footprint at all.** Once runtime memory per profile is known, a shard may be bound by a resource §3.5 does not currently state |

---

## 5. Mobility Model Decision

**NOT TAKEN — external (decision D3). But the minimum set and the domain scope are now derivable
and are recorded as recommendations for the ADR to ratify.**

### 5.1 Which traversal domains the current architecture requires

| Domain | Required now? | Evidence |
|---|---|---|
| `SIDEWALK_GRAPH` | **YES** | The only declared model. §25.2: ground robots are the "Baseline case … Reuses everything" |
| `ROAD_GRAPH` | Not by the current fleet; same extract serves it | §25.2 puts vans under "Additions required". No such model declared |
| `INDOOR_GRAPH` | **NO — a different mechanism, not a routing profile** | §6.2: indoor and multi-level sites *"use site-local graph zones rather than geodesic cells … The index abstraction is 'proximity partition,' and its implementation is per-region configuration."* **Not something an OSM engine provides.** Scoping it into B1 would mis-specify the procurement |
| `AIRSPACE_VOLUME` | **NO — §25 future modality** | §25.2 lists UAS under "Additions required: 3D routing with airspace volumes…" |

**Recommendation for the ADR (decision D4): B1 scopes the outdoor geodesic graph.** §27 item 2 makes
the engine choice depend on "multi-modal networks" with the stated dependency "Modality roadmap", so
this must be written down — it is the difference between procuring one OSM engine and procuring a
multi-modal platform.

### 5.2 The minimum legitimate model set — and why none was created

**One**, if the fleet is homogeneous sidewalk couriers. Provisional, because nothing states fleet
composition. §25.4 is why no model was invented to make the count non-zero:

> every agent class needs its own `λ_time`, energy coefficients, wear coefficients, reliability
> priors, and mobility profile. A heterogeneous fleet with copy-pasted parameters will make
> confidently wrong cross-class comparisons, which is worse than not comparing at all — so class
> parameter completeness MUST be a **commissioning gate**.

**A mobility model created to make the profile count non-zero would be exactly that copy-pasted
parameter set. None was created.**

### 5.3 The §2.2 elements, against the one declared model

| Element | `MOB-SIDEWALK-DEFAULT` | Blocking for B1? |
|---|---|---|
| Traversal domain | `"SIDEWALK_GRAPH"` (scalar `String` column — **cannot hold a §25.3 composition**) | Yes |
| Permission set | partial — road classes + stair capability only | **Yes — a profile *is* a permission set plus a speed model** |
| **Speed model** | **stub: `{ note: "Populated by the routing integration in Phases 7–9 (blocking decision B1)" }`** | **Yes — a contraction hierarchy is a precomputation over edge costs, and there are none** |
| Kinematic limits | partial — max speed, max gradient | Partly |
| Envelope constraints | declared, both null | No |
| Dimensional footprint | complete | Yes — gates passage |
| **Mass (tare / laden)** | **absent from the schema entirely** | **Yes — it is what makes `:loaded` mean anything (§15.5)** |
| **Centre of gravity** | **absent from the schema entirely** | **Yes — same** |

---

## 6. Routing Profile Derivation

`mobilityModel.routingProfileKey()`, read and verified:

```js
routingProfileKey(model, { loaded }) = `${modelId}:${domains}:${loaded ? "loaded" : "unloaded"}`
```

`domains` is produced by `traversalDomains()`: filtered to recognised values, de-duplicated, and
**code-unit sorted**, so two models declaring the same networks in different orders key identically.
That is §9.6's determinism discipline applied to a cache key, and it is correct.

**Verified semantics:**

- The key is **derived, never stored beside the model** — *"so that a model change cannot leave a
  cache keyed under a profile that no longer describes it."* This is what makes the scalar-column
  gap safe: a model that gains a domain gets a new key and therefore new entries, automatically.
- **One sharp edge, worth recording:** the function is *total*. An absent `modelId` or an
  unrecognised domain yields the literal `"unknown"`, so two differently-broken models both key as
  `unknown:unknown:unloaded` and would **share cache entries**. `validateModel()` refuses such a
  model; `routingProfileKey()` does not. **The Phase 8 routing client must validate before it keys.**
- Loaded and unloaded are distinct profiles, per §15.5.

**Hierarchy count:**

```
contraction hierarchies = (declared mobility models) × 2 × (regions)
                        = 1 × 2 × 1 = 2      ← at the seeded state
```

**Provisional in all three factors**, over an undeclared extract, from a speed model that does not
exist. Not yet a procurement input.

---

## 7. Configuration Changes

**NONE.** No production configuration was published, no register entry was added, changed or
removed, and no schema was altered.

| Considered | Done? | Why not |
|---|---|---|
| Publish a spatial map | **NO** | Container and validation exist; the region (D1) does not |
| Publish shard definitions | **NO** | Every field is enforced; `regionId` has no value to carry |
| Add `regions[].boundary` to the payload schema | **NO** | Its shape depends on D1's answer (polygon vs bbox, CRS). §22.1 rule 5 refuses a schema admitting an unreviewed shape |
| Add mass / CoG to `MobilityModel` | **NO** | Decision D6 — where they live is an architecture call |
| Make `traversalDomain` a composition | **NO** | Decision D7 — the need depends on D4 |
| Register `route.l1_max_entries` / `route.l1_ttl` | **NO** | §22.1 requires an owner, and **no module reads them** — the tier takes both as *required constructor arguments that throw when absent*, so the policy lives at the composition root that does not exist yet. Registering them now would be exactly the uncalibrated, unowned constant the gate exists to refuse |
| Register `route.matrix_timeout` / `route.path_timeout` / detour factor | **NO** | No module implements them; the third needs §22.3 two-person Safety approval and a deployed engine for its value |

---

## 8. Routing Cache Architecture

Derived from the frozen architecture before any code was written.

```
                    cellPairCache / chargerReachabilityCache
                         (unchanged — inject a `kv`)
                                     │
                              layeredKv façade
                                     │
                     ┌───────────────┴───────────────┐
                     ▼                               ▼
             InProcessTier (L1)                Redis kv (L2)
        per-process, bounded, namespaced     cross-round, cross-worker
        TTL ≤ L2's, clock injected           registered TTLs, shipped `src/cache/kv.js`
```

**The load-bearing design choice is that the façade is kv-shaped.** Both caches already take their
kv as an injected dependency, so a façade satisfying the same two-method contract composes in front
of them with **zero change to either**. `cellPairCache.js` and `chargerReachabilityCache.js` are
byte-identical to their state at the start of this pass, and a test asserts neither mentions the new
module. The §6.2 seam that has kept B1 from contaminating the rest of the engine stays where it is.

| Question (Part E) | Answer, and where it comes from |
|---|---|
| What belongs in process memory | Both §20.3 populations' entries. The approach population is read 100 000× over ~2 500 distinct keys (40× reuse); the return-leg row's 10 µs budget admits no network |
| What belongs in Redis | The same entries, as the cross-round and cross-worker tier, under the registered TTLs. The §20.3 item 3 precompute worker writes here on projection publication |
| Ownership | L1 is the process's; neither tier is an authority (§3.3, I16). L1 ⊆ L2 ⊆ recomputable |
| TTL | Injected, required, no default. **Effective lifetime = min(tier TTL, the TTL the caller passed the kv)** — an L1 entry that outlived its L2 counterpart would turn a deliberate expiry into a stale answer served from memory |
| Versioning | Three layers: **(a)** the key already carries profile + time bucket + projection version (§20.3 items 2 and 3), so a version change is a *new key*, never an overwritten one; **(b)** a required **namespace** (config version + spatial map version + shard) carries what the key cannot, because a cell id is *"an opaque token supplied by the published map"* and two config versions may name different geography with the same token; **(c)** TTL bounds everything else |
| Invalidation | Epoch by namespace — no sweep, no bulk delete, no cross-process messaging. Plus `delete`/`clear` for operational flush |
| timeBucket semantics | Unchanged and untouched: an input, derived from the round's pinned decision time, never read from a clock |
| Spatial version semantics | Carried by the namespace. This is the gap the key discipline does not close on its own |
| Mobility-profile semantics | Already in the key. `:loaded` and `:unloaded` are distinct keys and cannot alias |
| Stale data | An entry past its TTL is **deleted and reported as a miss**, never returned. The TTL is **never extended on read** — refresh-on-access would let the hottest cell pair outlive every congestion bucket indefinitely, which is the entry most consulted and least able to afford being wrong |
| Worker / process isolation | L1 is per-process and never shared. No coherency protocol is required, because coherency comes from the key discipline. Which *tier* served a read is deliberately **not** in any decision record — it is an SLI |
| Shard isolation | Via the namespace. `route.*` is region-scoped (§22.2), so a process serving two shards MUST namespace each separately |
| Memory bounds | `maxEntries`, required, no default. *An unbounded process-local cache in front of a 100 000-lookup round is a memory leak with good latency* |
| Eviction | Least-recently-used and **deterministic** — recency is the store's own insertion order, so the same access sequence always evicts the same entry |
| Warmup | The §20.3 item 3 precompute writes through both tiers. Cell pairs warm lazily from L2 within the round |
| Rebuild | None needed: L1 is rebuildable from L2, and L2 from the engine |
| Failure behaviour | Every path degrades toward a miss. An L2 read error is a miss and is **not** promoted. An L2 **write** failure leaves no process-local copy — otherwise one worker's hit rate would be a function of another worker's Redis errors |
| Observability | Per-tier counters: L1 hits/misses/expiries/evictions/writes/size/hit-rate; L2 reads/hits/misses/errors/writes/write-errors/coalesced/promotions. No target is applied to the hit rate here, because §20.3's targets are *steady-state* rates and one process's counters since start-up are not that quantity |

---

## 9. In-Process Tier Design

`src/engine/routing/inProcessCache.js` — 1 module, no `require` of anything (asserted by test).

**`InProcessTier`** — `createTier({ maxEntries, ttlMs, namespace, population })`

- `maxEntries`, `ttlMs`, `namespace` are **required and throw when absent**. This is how §22.1
  rule 1 is satisfied without registering a parameter no module reads: the mechanism is here, the
  policy is at the composition root.
- `get(key, nowMs)` → `{ hit, value, reason }`. `set(key, value, nowMs, maxLifetimeMs)`.
- **The clock is injected, never read** (T6, §9.6). A missing `nowMs` **fails closed to a miss**
  rather than guessing an instant — a tier that supplied its own clock there would be the wall-clock
  read T6 prohibits, one indirection away. A test greps the module for `Date.now`, `new Date`,
  `process.hrtime` and `Math.random`.
- Values are **opaque**: whatever was written is what a hit returns, byte for byte. This is forced,
  not chosen — `cellPairCache.read()` calls `JSON.parse(raw)` unconditionally, so a tier that handed
  back a parsed object would turn every cell-pair hit into a silent miss (the parse throws inside a
  `catch` that yields a miss). It also avoids one round's mutation reaching the next round's read.

**`layeredKv({ tier, kv, nowMs })`** → kv-shaped `{ get, set, size, stats, tier, kv }`

- **Read:** L1 hit → return. L1 miss → L2, **promote**, return. L2 error → miss, no promotion.
- **Write:** write-through, **L2 first**; L1 populated only if L2 accepted.
- **Single flight:** concurrent L1 misses for one key share **one** L2 read. Two candidates asking
  for the same cell pair simultaneously is the common case, not the exotic one. **Boundary:** this
  collapses duplicate *cache* reads only. §20.3 item 7's duplicate-*engine*-query collapsing belongs
  to the routing client and is deliberately not implemented.
- Refuses to construct without a pinned `nowMs`, and refuses to construct its own tier.

**What it is not:** it issues no query, holds no adapter, knows no engine, and implements no part of
§5.2's degradation ladder. A miss is a miss; what to do about one is the round's decision.

---

## 10. Redis Interaction

| Property | Behaviour |
|---|---|
| Role | Cross-round and cross-worker tier. Unchanged, still `src/cache/kv.js` (ioredis) |
| TTL | The caller's, passed through **verbatim**. Both argument shapes the shipped caches use are read for the L1 clamp: `cellPairCache` uses ioredis positional `("EX", seconds)`, `chargerReachabilityCache` uses object `({ ex: seconds })`. Both are parsed here rather than either being normalised at the call site — normalising would mean editing a **Tier 0** module to accommodate a Tier 1 optimisation |
| Read failure | Miss (I16). Not promoted, counted as `l2Errors` |
| Write failure | Silent, as both cache modules already are; L1 is **not** populated |
| Promotion TTL | The tier's own — L2's remaining TTL is unknowable from a `GET`, and the conservative direction is that the promoted copy is shorter-lived than its source |
| Reads eliminated | **105 000 → 2 500 per round, measured** (97.6 % L1 hit). In a warm shard the residual 2 500 is the cold fill and would already be resident |

---

## 11. Cache Correctness

**43 tests, all passing.** Every Part H requirement is covered.

| Required | Test | Result |
|---|---|---|
| hit | value returned byte-for-byte | ✔ |
| miss | absent key → `{hit:false, reason:"miss"}` | ✔ |
| expiry | past TTL → miss, entry dropped, `expiries` incremented; **TTL not extended on read** | ✔ |
| version mismatch | different `projectionVersion` → different key → miss (§20.3 item 3) | ✔ |
| profile mismatch | `:loaded` vs `:unloaded` → different key → miss (§15.5) | ✔ |
| time-bucket mismatch | different bucket → different key → miss | ✔ |
| concurrent fill | 3 concurrent misses → **1** L2 read, 2 coalesced | ✔ |
| duplicate fill | overwrites, does not accumulate; recency refreshed | ✔ |
| bounded memory | 100 writes into `maxEntries: 10` → size 10, 90 evictions | ✔ |
| eviction | LRU, and **byte-identical across repeated runs** | ✔ |
| Redis fallback | L1 miss → L2 → promote; second read costs no round trip | ✔ |
| Redis failure | read error → miss, not promoted; write error → no L1 copy; **mid-round outage degrades to a miss, never a stale entry** | ✔ |
| deterministic lookup | no clock, no randomness (source-scanned); missing `nowMs` fails closed | ✔ |

Plus the properties that make it safe in *this* system specifically:

- **Namespace isolation** — an entry cannot cross a config/map-version epoch, and two shards in one
  process do not share entries.
- **L1 never outlives L2** — both TTL argument shapes clamp correctly; the tier's own TTL still
  binds when the caller asks for longer.
- **Both shipped cache modules work through the façade unchanged** — end to end, including that the
  intra-cell offset is still applied to an L1-served entry (2 × 250 m added pessimistically, and the
  time with it), that the projection-version check still rejects a mismatch, and that a **router**
  failure is still reported to the caller rather than answered from the tier.
- **The tier changes where a read is served from, never what it answers** — the B1 workload driven
  with and without the tier produces identical amortisation and identical hit rates.
- **Engine independence** — the module `require`s nothing, and neither cache module mentions it.

**No existing test was modified, skipped, deleted, or had a threshold relaxed.** §20.1's workload
shape is asserted untouched (500 × 200 × 25).

---

## 12. Performance Model

At the registered workload: **500 Legs × 200 candidates, 25 clusters**, unchanged.

### 12.1 The shape

| Quantity | Value | Source |
|---|---:|---|
| `m · k` candidate evaluations | 100 000 | §9.4 caps (`solve.max_legs_per_round`, `candidate.max_evaluated`) |
| Destination cells per cluster | 100 | harness: `ceil(k/2)` |
| **Distinct cell pairs** | **2 500** | 25 × 100 |
| **Distinct return-leg destination cells** | **2 500** | 25 × 100 |
| Approach cache reads | 100 000 | measured |
| Approach engine queries | **25** | §20.3 item 4 — one matrix per cluster |
| **Approach amortisation** | **4 000×** | measured; batching working as designed |
| Return-leg engine queries | 2 500 | measured |

### 12.2 The nine cost components

| # | Component | Measured | Note |
|---|---|---:|---|
| 1 | **Redis access** | `GET` p50 **382–485 µs**, p99 **996–1 810 µs** | B1 §7.1 measured 304 / 1 156 µs. This machine is ~1.3–1.6× slower this session; every figure here is read against **this pass's own baseline**, not §7.1's |
| 2 | **In-process lookup** | p50 **0.60 µs**, p95 1.2, p99 **1.7**, p99.9 19.5, amortised **0.61 µs/call** | Instrument floor is p50 0.10 µs, so this is real |
| 3 | **Deserialisation** | `JSON.parse` of an 828-byte k=5 entry: p50 **4.9 µs**, amortised 6.7 µs | **In-situ attribution not established** — see §12.4 |
| 4 | **Cache miss** | zero-latency engine: 0.01 ms, against a 2 ms target | Miss cost is the engine's, and there is no engine |
| 5 | **Cache fill** | 2 500 L2 writes (warm L2) / 5 000 (cold) per round, **measured** | Dominates the tier's residual |
| 6 | **Candidate-level lookup count** | approach **100 000**; return-leg **5 000 in the harness** | **See §12.3 — the harness under-represents the second population by ~20×** |
| 7 | **Cell-cluster batching** | 25 matrices → 100 000 reads | §20.3 item 4 |
| 8 | **Approach population** | 100 000 reads / 2 500 distinct = **40× reuse**; L1 hit **97.6 %** | |
| 9 | **Return-leg population** | 2 500 distinct cells; a real round reuses them **40×** too | The harness's 2× is a loop artefact |

### 12.3 The harness under-represents the return-leg population, and §20.1 says so

§20.1 states: *"**Return-leg lookups per round** ≤ `m · k`, bounded by the same caps as approach
queries — explicitly budgeted rather than assumed free."* `E_return` is evaluated **per candidate**
by F34/F35, so a real round performs **~100 000** return-leg reads, not the harness's 5 000.

**A real round therefore performs ~200 000 per-candidate routing cache reads, roughly double what
the measured cache path exercises.** Every figure in §13 should be read as covering about half the
read volume of a live round. This is a property of the harness's loop, is stated here rather than
corrected (correcting it is a change to the B1 evidence procedure, which this pass was instructed
not to reopen), and it makes §12.5's conclusion stronger rather than weaker.

### 12.4 Why no parse attribution is claimed

Two isolation attempts disagree, so neither is reported as a result:

- **Standalone**: `JSON.parse` amortised at **6.7 µs/call**.
- **In situ (row E)**: removing the parse from the read path changed the row by less than run-to-run
  variance — and row E is confounded, because the wrapper that removes the parse **adds an async
  hop**, so it isolates neither.

**The claim is not made.** What *is* established is §12.5's bound, which does not depend on the
attribution.

### 12.5 What the tier must still achieve — and the part that is not the tier's to fix

The budget arithmetic, at a real round's ~200 000 reads against §20.1's **250 ms whole-round**
target (of which routing is one stage among candidate generation, feasibility, pricing, solve and
commit):

| Read path | µs/read | 200 000 reads | Verdict |
|---|---:|---:|---|
| Redis, no L1 (**shipped**) | ~300 | **60 s** | 240× the whole-round budget |
| L1 + current `chargerReachabilityCache.read()` | ~6.0 | **1.2 s** | 4.8× over |
| L1 + a **synchronous, pre-parsed** read (row F) | **0.9** | **180 ms** | **72 % of the whole round, for routing lookups alone** |
| The tier's `get` alone (the floor) | 0.61 | 122 ms | 49 % of the whole round |

**Three conclusions, in order of how much they change the plan:**

1. **The tier is necessary.** Without it the path is two orders of magnitude out. This is settled
   and needed no engine to settle.
2. **The tier is not sufficient, and the next step is not a faster tier.** Even at the measured
   floor, 200 000 lookups consume half the whole-round budget. **The read *count* has to come down**
   — which is precisely what §6.4's admissible lower-bound pruning exists for: *"Exact routing is
   requested only for the shortlist that survives geometric pruning … `LB` deliberately requires no
   routing of either population."* Whether the surviving shortlist is 200 or 20 per Leg is a Phase
   8/9 integration property that **nobody has scoped and no measurement in this programme covers**.
3. **A reading question §20.1 must answer before any of this is gated.** §20.1 budgets *feasibility
   per candidate (cached) < 50 µs* with the note "100 000 evaluations per round must be affordable",
   and *cost per candidate (routing cached) < 100 µs*. Taken as per-round aggregates those are 5 s
   and 10 s against a 250 ms round — a 20×–40× inconsistency. The charitable and probably intended
   reading is that they are **p99 ceilings on a single candidate** while the round budget is against
   the aggregate mean, with intra-round parallelism. **That reading should be stated explicitly in
   the ADR**, because a benchmark built on the other reading would gate on an impossible target.

### 12.6 Expected memory footprint

| Scope | Entries | Measured / projected |
|---|---:|---|
| Measured, per entry (k = 5 charger entry) | — | **1 108 B** |
| The measured round's working set | 5 000 | **~5.3 MiB** (L1 size 5 000, evictions 0) |
| Region at §3.6's low end (10³ cells × 2 profiles) | 2 000 | ~2.2 MiB |
| Region at §3.6's high end (10⁵ cells × 2 profiles) | 200 000 | **~211 MiB** |

The high-end figure is charger-reachability **alone**, at one time bucket and one projection
version. Cell pairs are larger and are not derivable without D1 and D2. **This is the number that
sets `maxEntries` and that feeds H3 — the routing engine's per-shard resource cost, which §3.5's
sizing inequality does not currently carry a term for.**

---

## 13. Benchmark Results

`tools/routing/inProcessCacheBenchmark.js`. **Diagnostic measurement, not §20.1 gate evidence** —
single process, build machine, one stage, zero-latency engine. Every run is published; none is
cherry-picked.

### 13.1 The tier in isolation

```
0. INSTRUMENT FLOOR   n=200000   p50 0.100 µs   p99 0.200 µs
1. TIER get()         n=200000   p50 0.600  p95 1.200  p99 1.700  p99.9 19.500  max 6118.6 µs
                                 amortised over batches of 1000: 0.6079 µs/call
2. JSON.parse (828 B)            p50 4.900  p99 18.800 µs   amortised 6.7265 µs/call
3. MEMORY                        2500 entries   2.64 MiB   1108 B/entry
```

The `max` of 6.1 ms and the p99.9 of 19.5 µs are **GC pauses**, not lookups — the amortised figure
(0.61 µs) and the floor (0.10 µs) together establish that the lookup itself is sub-microsecond.

### 13.2 §20.1's `charger_reachability_cached` row — target **< 10 µs p99**

`chargerReachabilityCache.read()` end to end, including the JSON parse and the projection-version
check. Two independent runs of the latency section:

| Configuration | p50 | p95 | p99 | p99.9 | vs target |
|---|---:|---:|---:|---:|---|
| A memory | 5.90 / 6.10 | 10.40 / 12.50 | **20.80 / 24.70** | 82 / 148 | OVER |
| B memory + L1 | 6.20 / 6.40 | 10.50 / 11.40 | **22.20 / 25.60** | 105 / 149 | OVER |
| **C redis (SHIPPED)** | **302.50 / 361.10** | 525 / 515 | **694.60 / 683.10** | 1 097 / 1 787 | **OVER, 69×** |
| **D redis + L1** | **6.40 / 6.10** | 11.70 / 9.80 | **39.40 / 23.30** | 352 / 132 | OVER |
| E memory + L1, no parse *(confounded)* | 7.20 | 12.80 | 39.10 | 200 | — |
| **F sync, pre-parsed** *(not the shipped contract)* | **0.90** | 1.60 | **2.10** | 25.50 | **WITHIN** |

Raw Redis `GET`: p50 **484.6 / 383.0 µs**, p99 **1 810.0 / 995.8 µs** (n = 2 000 each) — reproducing
B1 §7.1's 304 / 1 156 µs on a slower session.

**The two findings, stated plainly:**

- **C → D is a 47× improvement at p50 and ~18–29× at p99**, and it takes the row from 69× over
  target to within 2.3–3.9× of a pure in-memory floor.
- **No shipped configuration meets 10 µs — including A and B, which have no network in them at
  all.** The residual is `chargerReachabilityCache.read()`'s own async-plus-parse path, not the
  store. **Row F establishes that 10 µs is reachable in process** (p99 2.10 µs) via a synchronous
  pre-parsed read — a change to the cache modules' value contract, which is Phase 8 routing-client
  work and outside this task's boundary. It is priced here so the decision is taken against a
  number.

### 13.3 The cache path at §20.1's own shape — two independent 5-run measurements

Both in fresh processes (`--only cache-path`), because a figure measured after the latency sections
is measured under GC pressure the round would not have:

| Configuration | Run A (5 runs, ms) | median | Run B (5 runs, ms) | median |
|---|---|---:|---|---:|
| A memory | 427.1, 343.9, 432.1, 387.2, 291.2 | **387.2** | 469.9, 430.1, 372.3, 381.3, 283.0 | **381.3** |
| B memory + L1 | 406.5, 373.0, 397.9, 464.6, 384.5 | **397.9** | 389.7, 402.8, 368.9, 464.1, 360.0 | **389.7** |
| **C redis (SHIPPED)** | 20 022, 19 199, 18 027, 17 782, 18 768 | **18 768** | 20 724, 26 603, 20 910, 24 442, 19 133 | **20 910** |
| **D redis + L1** | 1 439, 1 653, 1 620, 1 464, 1 416 | **1 464** | 1 419, 1 580, 1 463, 1 201, 1 527 | **1 463** |

Measured L1/L2 operation counts (so the attribution is measured, not inferred from wall clock):

```
D  redis + L1   L1 reads 105000  hits 102500 (97.6%)  size 5000  evictions 0
                L2 reads   2500  writes 2500  coalesced 0
amortisation    approach: 25 engine queries → 100000 cache reads
                return leg: 2500 → 5000
```

**Reading this honestly:**

- **C → D is 12.8×–14.3×**, consistent across two independent runs. That is the improvement the
  shipped deployment would see.
- **A is 381–387 ms, where B1 §7.1 recorded 241–246 ms** for the same configuration. This machine is
  ~1.6× slower this session (the raw Redis `GET` moved the same way). **Every comparison here is
  against this pass's own baseline A, and no claim is made against §7.1's number.**
- **The tier costs ~2–3 % over a free store** (A 381–387 → B 390–398 ms). That is the price of the
  namespace, the TTL check and the LRU bookkeeping.
- **D's residual over B (~1 070 ms) is fill I/O, measured**: 2 500 L2 reads + 2 500 L2 writes ≈
  5 000 network operations at ~210 µs each. It is a **cold-start** cost — the harness starts cold
  every run, and §20.3 item 3's precompute worker exists precisely so the steady-state path is a
  lookup rather than a query.
- **D is still ~5.9× the 250 ms whole-round budget**, and per §12.3 covers about half a real round's
  read volume. **The cache-tier prerequisite is addressed, not closed.**

---

## 14. B1 Dependencies Removed

Against the B1 report's §17 blocker list:

| # | Blocker | Status after this pass |
|---|---|---|
| **7** | **The per-candidate lookup path cannot meet §20.1 through Redis (N16)** | **ADDRESSED.** The tier exists, is tested (43 tests), is measured, and removes 97.6 % of cross-round-tier reads for a 12.8×–14.3× improvement on the shipped configuration. **Not closed** — see §15 |
| **2** | No declared mobility models, so the profile set is unknown | **PARTIALLY REMOVED.** One model *is* declared in the durable seed; the profile set is **derivable** (`MOB-SIDEWALK-DEFAULT:SIDEWALK_GRAPH:{loaded,unloaded}`) and the hierarchy count is *models × 2 × regions*. Its speed model is a stub, so the profiles can be *named* but not *built* |
| **1** | No declared target region | **SPECIFIED, NOT REMOVED.** Every required field is now enumerated with its container and its enforcement (§4), so publishing is a data-entry task the moment D1 is answered. **S1 (bounding geometry) has no field to go in and is the binding gap** |

Also removed, as work that no longer has to be discovered:

- The **exact** field list for a spatial map and for shard definitions, with what is already enforced
  at publish and what is missing (§4).
- The **traversal-domain scope recommendation** for B1 (§5.1) — the answer to §27 item 2's stated
  "Modality roadmap" dependency, with §6.2's and §25.2's own words behind it.
- **Three schema findings** nobody had recorded: mass/CoG absent from `MobilityModel` (D6),
  `traversalDomain` unable to hold a §25.3 composition (D7), and `routingProfileKey()`'s total
  behaviour aliasing broken models to `unknown:unknown:*`.
- **H3**: §3.5's sizing inequality carries no term for the routing engine's per-shard footprint,
  which §5.2 requires to exist on every shard.

---

## 15. B1 Dependencies Remaining

| # | Blocker | Workable in this repository? |
|---|---|---|
| **1** | **Target region and its bounding geometry (D1)** | **NO — external.** Nothing else can start until it is answered |
| **2** | **Fleet mobility models with real speed models and mass/CoG (D3, D6)** | **NO — external** (product) **+ schema** (architecture) |
| 3 | No engine deployed; no extract; no contraction hierarchies | **NO** — procurement + representative hardware |
| 4 | `routing/client.js` absent, with §5.2's two timeouts, the ladder, and §18.3 B6's uniform-treatment rule | **NO** — blocked on 1, 2, 3 |
| 5 | Three unregistered parameters — matrix timeout, path timeout, **detour factor** (Safety) | Registration possible once an owner exists; **the detour factor's value is not derivable here** |
| 6 | `route.degraded_max_radius` (`null`), `route.degraded_reserve_factor` (PROVISIONAL) | **NO** — both `awaits` require a deployed engine |
| **7a** | **§20.1's 10 µs row still unmet by every shipped configuration** | **YES** — row F shows the target reachable via a synchronous pre-parsed read; it is a **Phase 8 cache-contract decision**, priced in §13.2 |
| **7b** | **~200 000 per-candidate reads do not fit 250 ms even at the measured floor** | **YES, and unscoped.** §6.4's LB pruning is the mechanism; how far it reduces the shortlist is unmeasured (§12.5) |
| **7c** | **§20.1's per-candidate budgets vs its round budget are 20×–40× inconsistent as aggregates** | **A reading the ADR must state** (§12.5 item 3) |
| 8 | No composition root; `cellPairCache.hopsFor` has no production consumer | **NO** — blocked on 3 |
| 9 | Charger-reachability worker `DEFERRED` for want of a routing client | **NO** |

---

## 16. Calibration Status

**UNCHANGED. Nothing was derived, edited, reclassified, or created.**

```
$ npm run gate:calibration
  FAIL — 39 blocking finding(s).
```

**39, exactly as before.** Specifically untouched, as instructed:

| Parameter | State, verified live | Left as |
|---|---|---|
| `route.degraded_max_radius` | `null`, UNCALIBRATED, SAFETY | untouched |
| `route.degraded_reserve_factor` | 1.4, PROVISIONAL, SAFETY | untouched |
| detour factor | not in the register | **not added** |
| `sim.max_optimistic_bias` | PROVISIONAL, SAFETY | untouched |

**No new parameter was registered**, so the count could not move in either direction. The tier's two
policy values are required constructor arguments precisely so that no unowned, uncalibrated
constant entered the register ahead of the composition root that will own them (§7).

---

## 17. Shadow Status

**NOT STARTED. Nothing was moved.**

- The 14-day `cutover.shadow_agreement_window` was **not** started.
- No worker was moved from `DEFERRED`; `shadow` remains absent from `scheduledAtBoot()` and
  `scheduledOnLeadership()`; `server.js` still does not reference it.
- `ENGINE_ENABLED=false`. No shard staged, no scheduling enabled, no cutover step taken.
- No composition root was built and no stub was written.

The §13 dependency chain of the B1 report is unchanged: `shadow.run → expandCandidates →
evaluateExact →` feasibility (F34/F35 → `E_return` → charger-reachability cache) **and** planBuilder
→ timeline → cell-pair cache **→ a routing engine.** Shadow remains behind B1.

---

## 18. Tests and Regression

### Changes requiring tests

| Suite | Tests | Change |
|---|---:|---|
| `tests/engine/routingInProcessCache.test.js` | **43** | **New** — the whole Part H matrix, plus namespace/epoch isolation, TTL clamping in both argument shapes, both cache modules end to end through the façade, and engine independence |
| `tests/engine/phase0Scaffold.test.js` | 56 | **+1 ownership entry, +9 explanatory lines.** No assertion changed |

### Results

| Suite / gate | Result |
|---|---|
| `npx jest tests/engine/routingInProcessCache.test.js` | **PASS — 43 tests** |
| `npx jest tests/engine/routingB1Benchmark.test.js` | **PASS — 16 tests, unchanged** |
| `npm run gate:params` | **PASS — 181 engine modules, 242 parameters, 0 bare constants** |
| `npm run gate:tenets` | **PASS — 272 modules, 0 violations** |
| `npm run gate:legacy` | **PASS — 4 retired modules absent, 290 files scanned** |
| `npm run gate:tiers` | **PASS — 275 modules, 376 governed edges, no Tier 0/1 → Tier 2** |
| `npm run gate:calibration` | **FAIL — 39** (unchanged; this is B8, not a code defect) |
| `npm test -- --runInBand --forceExit` | **PASS — 141 suites, 6 154 tests, 0 failures, 164.5 s** |

The arithmetic reconciles exactly against the B1 report's baseline:

| | Suites | Tests |
|---|---:|---:|
| Baseline (`PHASE_15_B1_ROUTING_DECISION_REPORT.md` §16) | 140 | 6 111 |
| `routingInProcessCache.test.js` | **+1** | **+43** |
| **Final, measured** | **141** | **6 154** |

**Entirely additive. No suite was removed, no test was skipped, deleted, or had a threshold relaxed,
and 6 111 of the 6 154 are the same assertions the B1 pass ran.**

### One genuine failure, found and fixed rather than excluded

The **first** full run came back **1 failed / 6 153 passed**: `phase0Scaffold.test.js`, *"holds
runtime code only where a landed phase owns it"*, reporting `routing/inProcessCache.js` as unowned.

**This is the gate working correctly**, not a flaky test: a new engine module must be assigned to a
landed phase, and mine was not. It was fixed by **adding the module to `PHASE_15_OWNED` with a
comment stating why it is a Phase 15 B1 *prerequisite* rather than a Phase 8 deliverable** — it
ships no capability, issues no query, holds no adapter, and `client.js` remains absent and remains
Phase 8's. **No assertion was weakened**; the ownership predicate, the walk, and the planted-module
rejection test are untouched.

### On the known flaky test

`privacySurrogateKeys.test.js` — the ~1-in-256 flake the B1 report established by measurement — **did
not fire in either full run of this pass**. It was **not** modified, and its one-line fix remains
with whoever owns it.

---

## 19. Change-Control Verification

Captured before the first edit and again at the end, and compared rather than eyeballed.

```
BEFORE   git status --porcelain | wc -l   →  371
AFTER                                     →  375
         git diff --stat  →  59 files changed, 11603 (+), 1593 (−)   BEFORE
                          →  59 files changed, 11613 (+), 1593 (−)   AFTER
```

**+4 porcelain entries, all new files.** **+10 insertions on tracked files, 0 deletions** — exactly
the 10 lines added to `phase0Scaffold.test.js` (1 ownership entry + 9 comment lines). **No tracked
file's content was otherwise altered, and no tracked file was deleted.**

**Complete list of files this pass touched — verified mechanically by `find -newermt`:**

| File | Change | Kind |
|---|---|---|
| `Backend/src/engine/routing/inProcessCache.js` | The tier and the façade | **New** |
| `Backend/tests/engine/routingInProcessCache.test.js` | 43 tests | **New** |
| `Backend/tools/routing/inProcessCacheBenchmark.js` | Diagnostic measurement | **New** |
| `Backend/tools/routing/b1Benchmark.js` | **+1 optional parameter** (`deps.kvFactory`, defaulting to the existing in-memory kv) and `memoryKv` exported | Modified *(untracked; see below)* |
| `Backend/tests/engine/phase0Scaffold.test.js` | +1 ownership entry, +9 comment lines | Modified *(tracked)* |
| `PHASE_15_ROUTING_CONFIGURATION_DECISION.md` | Part C | **New** |
| `PHASE_15_ROUTING_PREREQUISITE_REMEDIATION_REPORT.md` | This document | **New** |

**The `b1Benchmark.js` change, disclosed in full because the brief said not to reopen that work.**
It is a single optional fourth parameter that defaults to the existing behaviour, so the CLI and
every existing caller are byte-for-byte unaffected. It exists because the §20.1 cache-path finding is
about *which kv the caches are given*, and comparing two of them requires driving **one** workload
loop against both — a second copy would drift, and the drifted copy would be the one quoted. **The
attribution discipline the previous pass added was not touched**, its 16 tests pass unchanged, and
three new tests in *my* suite assert that `measure()` with no `deps` produces identical amortisation
and hit rates to the explicit default, that the layered tier produces identical amortisation to no
tier, and that §20.1's 500 × 200 × 25 workload shape is unchanged. `b1Benchmark.js` and
`routingB1Benchmark.test.js` were **already untracked** before this pass (the previous pass's
uncommitted work), so this edit does not appear in `git diff`.

**Verified, mechanically rather than asserted:**

- **No solver change.** All seven `src/engine/solve/*.js` retain modification times predating this
  session (2026-08-05, and 2026-08-08 13:39/19:00/19:01).
- **No calibration change.** No file under `src/engine/config/register/` was modified — mtimes
  2026-07-28 and 2026-08-08. `gate:calibration` reports the same 39.
- **No threshold change.** `perf.*` and `route.*` resolve to the same values recorded in §2.
- **No gate bypassed or waived.** All four build gates run and pass; the one test failure was fixed
  at its cause.
- **No test weakened.** One test file gained an ownership entry and a comment; no assertion changed.
- **No Phase 16 implementation.** `src/engine/fairness/` still holds only `.gitkeep`.
- **No unrelated source change.** Exactly five source/test/tool files were modified or created.
- **No routing engine installed**, no adapter written, no engine response faked, no benchmark number
  fabricated. The only stand-in routes nothing, lives in the benchmark tool, is named
  `ZERO_LATENCY_STAND_IN`, and states in its own header that it is not a candidate engine.
- **No production configuration published. No shadow started. No commit created.**

---

## 20. Recommended Next Action

**In parallel, by different people, starting the same day:**

1. **Answer D1 — the target region and its bounding geometry.** It needs no vendor, no hardware and
   no budget, it is seven questions in
   `PHASE_15_ROUTING_CONFIGURATION_DECISION.md` §9, and **every other B1 item is behind it.** The
   programme has treated B1 as procurement with a long lead time; it is, but procurement cannot even
   be *specified* for an undeclared region.
2. **Answer D3 and D4 — the fleet's mobility models and B1's traversal-domain scope.** §27 item 2
   makes the engine choice depend on the modality roadmap, and §6.2 already establishes that
   `INDOOR_GRAPH` is a different mechanism rather than another profile. Getting this wrong buys a
   multi-modal platform to serve sidewalk robots, or an OSM engine that cannot serve an indoor site.
3. **Settle D6 — where agent mass and centre of gravity are declared.** The `:loaded` / `:unloaded`
   profile split is implemented and the §15.5 quantity that gives it meaning is absent from the
   schema. This doubles the hierarchy count for a distinction nothing can currently compute.

**Then, and still before any engine is benchmarked:**

4. **Take the Phase 8 cache-contract decision priced in §13.2.** §20.1's 10 µs row is unmet by every
   shipped configuration including two with no network in them; row F shows it reachable at p99
   2.10 µs through a synchronous pre-parsed read. That is a change to `cellPairCache.read()`'s value
   handling, and it should be decided deliberately rather than discovered during a benchmark.
5. **Scope the read *count*, not just the read cost (§12.5 item 2).** Even a perfect tier puts
   200 000 lookups at ~180 ms of a 250 ms whole-round budget. §6.4's admissible lower-bound pruning
   is the mechanism; **how far it actually reduces the shortlist is unmeasured, and it is now the
   largest unknown in the routing budget.**
6. **State §20.1's per-candidate reading in the ADR (§12.5 item 3)**, before a benchmark gates on an
   arithmetically impossible target.

**Unchanged advice from the two prior reports, and untouched by this work:** name the calibration
owner (**B8**, which gates 38 of the 39), rehearse the rollback in staging, and **do not scope
further solver work** — routing is still unmeasured, still the dominant term, and now known to carry
two engine-independent problems of its own.

---

# FINAL DECISION

```
ROUTING PREREQUISITES:
- STILL BLOCKED

B1:
- STILL BLOCKED

PHASE 15:
- STILL BLOCKED

PHASE 16:
- NOT READY
```

**Why the routing prerequisites are still blocked, against the six conditions the brief sets:**

| Condition for B1 engine-deployment readiness | Met? |
|---|---|
| Target region is legitimately declared | **NO** — D1 is external; no geometry exists anywhere in the repository |
| Required spatial/shard configuration exists | **NO** — every field is now specified and enforced; none has a value |
| Required mobility models exist | **PARTIALLY** — one exists and is structurally valid; its speed model is a stub and mass/CoG are absent from the schema |
| Routing profile set is known | **DERIVABLE, PROVISIONAL** — 2 profiles per region from the one declared model, but provisional in all three factors |
| Cache-tier prerequisite is addressed | **ADDRESSED, NOT CLOSED** — 12.8×–14.3× measured on the shipped configuration; §20.1's 10 µs row still unmet, and §12.5's read-count problem is newly quantified and unscoped |
| No Safety calibration fabricated | **YES — none was.** `gate:calibration` remains 39 |

**The cache tier improved, and that is explicitly not a reason to call B1 ready.** The binding
blocker was never the cache; it is that no extract can be specified for an undeclared region and no
contraction hierarchy for a profile set whose speed model does not exist.

**An honest blocker is preferable to an invented configuration, and the strongest result available
here was to make the missing decisions explicit, remove the one prerequisite that needed no external
input, and measure precisely how far that gets — which is: a long way, and not far enough.**

---

*End of Phase 15 Routing Prerequisite Remediation Report. No commit was created.*
