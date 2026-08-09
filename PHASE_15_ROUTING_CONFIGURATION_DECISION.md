# Phase 15 Routing Configuration Decision

**Role:** Principal Systems Engineer, removing the repository-side prerequisites that prevent
blocking decision **B1** from being *specified*.
**Date:** 2026-08-09 · **Branch:** `feature/dashboard` · **Baseline:** `cf9103f`, Phases 6–15 as
one uncommitted working tree · **Node:** v22.17.0

**Authoritative inputs, read before anything was written:** `NEXT_GENERATION_ASSIGNMENT_ENGINE.md`
(§2.1–2.2, §3.5, §3.6, §5.2, §6.1–6.2, §15.5, §20.1–20.3, §22.1–22.3, §25.2–25.4, §27),
`IMPLEMENTATION_EXECUTION_PLAN.md` (§6.1 B1/B5), `PHASE_15_B1_ROUTING_DECISION_REPORT.md`,
`PHASE_15_CONSOLIDATED_REMEDIATION_REPORT.md`, `PHASE_15_INDEPENDENT_VERIFICATION.md`,
`PHASE_15_BLOCKER_RESOLUTION_PLAN.md`.

**No production configuration was changed. No region was invented. No mobility model was
created. No calibration value was derived, edited, or reclassified. No commit was created.**

---

## 1. Current State

Re-derived by execution, not quoted.

```
$ node -e "…service.defaultSnapshot()…"
spatial:       null
shards:        null
bindings size: 0
```

The B1 report's finding holds exactly. But the search for an authoritative definition turned up
**two artefacts the B1 report does not record**, and both change what the missing decision
actually is.

### 1.1 A region-shaped artefact exists, and it is a seed fixture

`Backend/prisma/seed.js` declares `SEED_SPATIAL_MAP`:

| Unit | Declared |
|---|---|
| Region | `RGN-BLR` — "Bengaluru operating region" |
| Zones | `ZN-RRNAGAR` (Rajarajeshwari Nagar), `ZN-RNSIT` (RNSIT campus and approaches) |
| Sites | `STE-RNSIT` (RNS Institute of Technology) |
| Cells | 4 FINE (`cell-rrnagar-fine-01/02`, `cell-rnsit-fine-01/02`), 1 COARSE (`cell-blr-coarse-01`) |

It is validated against §3.6 by `spatialHierarchy.validate()` before it is written, and mirrored
into the durable `Region`, `Site`, `Zone.regionId` and `CellAssignment` tables. It is real, it is
consistent, and **it is not an authoritative target-region declaration.** Four independent reasons,
each from the repository rather than from judgement:

1. **It is never published as a configuration version.** The seed's own comment draws exactly this
   line for the register — *"Seeding the register is NOT publishing a configuration version. A
   version is an explicit, approved, validated act (§22.1 rule 5, §22.3)"* — and the spatial map
   travels the same path: mirrored to tables, absent from `snapshot.spatial`, which is `null`.
2. **Its cell ids are placeholders, not H3 cells.** `spatial/cells.js` states that a cell id is
   *"an opaque token supplied by the published map"*, and the seed repeats it. `cell-rrnagar-fine-01`
   is not an H3 index. Since B5 resolved to H3 (execution plan §6.1), the published map's cell ids
   must be H3 indices, and none of these is one.
3. **Four fine cells is not a region.** §3.6 sizes a region at **10³–10⁵ fine cells**. Four fine
   cells at §6.2's ~200–500 m edge covers under a square kilometre.
4. **There is no geometry anywhere, and geometry is what names an extract.** The `Zone` rows carry
   a deliberately degenerate bounding box, and the seed says why: *"containment is by assignment
   (§3.6), so these bounds are never read by the engine … the legacy column is NOT NULL."* No
   `Region` row carries a boundary at all. **A routing extract is specified by a bounding geometry,
   and the repository contains none.**

**This is a Phase 2 demonstration that §3.6 containment works. It is not a production region, and
the fact that it names Bengaluru is not evidence that the production target region is Bengaluru.**
The instruction not to adopt Bengaluru merely because seed coordinates are Indian is correct, and
this artefact is precisely the trap it names.

### 1.2 A mobility model exists, and it is structurally valid and semantically empty

`Backend/prisma/seed.js` also declares exactly **one** MobilityModel, mirrored into the
`MobilityModel` table and attached to agent class `AC-SIDEWALK-DEFAULT`:

| §2.2 element | `MOB-SIDEWALK-DEFAULT` | Assessment |
|---|---|---|
| Traversal domain | `"SIDEWALK_GRAPH"` | **Declared.** Note it is a scalar `String` column, so a §25.3 composition cannot be stored |
| Permission set | `{ roadClasses: ["footway","path","service"], stairCapable: false }` | Declared; partial against §2.2's list (no surface types, gradients, kerb heights, restricted areas) |
| Speed model | `{ note: "Populated by the routing integration in Phases 7–9 (blocking decision B1)" }` | **Declared, empty.** §2.2 requires speed as a function of road class, gradient, surface, payload mass, congestion and weather. None is present |
| Kinematic limits | `{ maxSpeedMps: 1.5, maxGradient: 0.08 }` | Declared; no acceleration, braking distance, or turning radius |
| Envelope constraints | `{ maxWindMps: null, minVisibilityM: null }` | Declared, both null |
| Dimensional footprint | `{ widthMm: 600, heightMm: 900, lengthMm: 800 }` | **Declared and complete** |

`domain/mobilityModel.validateModel()` passes it: every §2.2 element is non-null, which is all that
function requires, and deliberately so — *"an absent element is a gap, not a permissive default."*

**So the B1 report's "zero mobility models are declared" is true of *configuration* and false of
the *durable seed*.** The distinction matters, because it moves the profile count from *unknowable*
to *known-and-provisional*:

```
routingProfileKey(MOB-SIDEWALK-DEFAULT, { loaded })
  = "MOB-SIDEWALK-DEFAULT:SIDEWALK_GRAPH:loaded"
  = "MOB-SIDEWALK-DEFAULT:SIDEWALK_GRAPH:unloaded"
```

**Two profiles, therefore two contraction hierarchies, per region** — if this seeded model is the
fleet. Whether it is, is the open decision (§5).

### 1.3 Neither mass nor centre of gravity is declared anywhere on the mobility model

Searched across `src/` and `prisma/`. `MobilityModel` has no mass field and no CoG field. What
exists is elsewhere and is a different quantity: `ContainerModel.totalMassLimitKg` (a payload
limit, §15.2) and the container model's CoG envelope (`payload/loadState.js`, F24).

§15.5 is explicit that this is a routing input:

> **Gradient**: mass and CoG limit traversable inclines, which is a *routing* constraint, so the
> routing query for a loaded leg differs from the unloaded one.

`mobilityModel.js` cites that sentence as the justification for loaded/unloaded being distinct
profiles. **The profile split therefore exists, and the quantity that gives it meaning does not.**
An engine can build two hierarchies named `:loaded` and `:unloaded`, but nothing in the repository
says what the loaded one should be built *against* — there is no agent tare mass, no laden mass,
and no CoG to gate a gradient with. This is a schema gap, not a calibration gap, and it is
recorded here as decision **D6** (§8).

---

## 2. Missing Region Decision

**The decision:** *which OperatingRegion(s) does this deployment serve, and what is each one's
boundary?*

It cannot be derived. §3.5 defines an OperatingRegion as "a site, campus, depot catchment, or metro
service area" — a statement of what kind of thing it is, not of which one this is. Nothing in the
architecture, the execution plan, or the repository selects one. It is an operations and commercial
decision with a §22.3 change class, and the correct output of this pass is to state it precisely
rather than to guess it.

**Why B1 cannot proceed without it,** stated as the causal chain rather than asserted:

```
target region  →  bounding geometry  →  OSM extract  →  per-profile contraction hierarchies
                                                     →  extract size, build time, build memory
                                                     →  runtime memory per profile
                                                     →  per-shard resource cost  →  §3.5 sizing
```

Every entry in §8 of the B1 report ("Precomputation / Operational Requirements") is downstream of
the first arrow. There is no ordering of these steps in which the engine is chosen first.

---

## 3. Required Spatial Fields

Derived from what `validators.v8SpatialContainment()`, `spatial/hierarchy.js` and `spatial/cells.js`
actually consume, plus what §3.6 requires and the current shape does not carry.

### 3.1 What the shipped schema already accepts

`snapshot.spatial` is validated as `{ regions[], zones[], sites[], cells[] }`:

| Object | Field | Required by | Enforced today |
|---|---|---|---|
| `zones[]` | `id` | §3.6 | V8 |
| | `regionId` | §3.6 "a zone MUST NOT straddle a region boundary" | **V8, blocking** |
| `cells[]` | `cellId` | §3.6 | V8 |
| | `zoneId` | §3.6 "a fine cell lies in exactly one zone **by assignment**" | **V8, blocking — exactly one** |
| | `siteId` | §3.6 "a site as a set of fine cells plus its indoor graph zones" | **V8, blocking — at most one** |
| | `resolution` | §3.6 FINE / COARSE | `cells.validateAssignment()` |
| | `regionId` | §3.5 | `hierarchy.validate()` |
| `regions[]` | `id`, `name` | §3.5 | `hierarchy.validate()` |
| `sites[]` | `id`, `regionId`, `name` | §3.6, §22.2 | `hierarchy.validate()` |

**No schema change is needed to publish a region map.** The container exists and is validated.

### 3.2 What a *routing-ready* region map additionally requires, and does not have

These are the gaps. Each is a schema/ADR decision, not a value to be guessed.

| # | Field | Why B1 needs it | Where it would live | State |
|---|---|---|---|---|
| S1 | **Region bounding geometry** (polygon or bbox, with a stated CRS) | It is what names the OSM extract. §5.2 requires a self-hosted engine built over *some* extract | `regions[].boundary` — **the field does not exist** in the payload shape or on the `Region` table | **MISSING** |
| S2 | **H3 resolution for FINE and COARSE** | §6.2 wants ~200–500 m fine and ~5–10 km coarse. In H3 that is roughly res 8 (~460 m edge) and res 5 (~8.5 km), but the *choice* fixes every cache key and every k-ring bound | `spatial.h3` or a register entry. Neither exists | **MISSING** |
| S3 | **The fine-cell set itself, as H3 indices** | The cell-pair and charger-reachability caches are keyed on it; the charger precompute walks "every populated cell in the region" (§20.3 item 3) | `cells[].cellId` — the container exists, the content is 4 placeholder tokens | **PLACEHOLDER** |
| S4 | **Site graph zones** for indoor/multi-level sites | §6.2: such sites "use site-local graph zones rather than geodesic cells". `Site.graphZones` is a nullable `Json` column, unused | `Site.graphZones` — **column exists, empty** | **UNPOPULATED** |
| S5 | **Map version / provenance** — which extract vintage this map was cut from | §5.2 makes the map service's snapshot "version pinned"; §9.6 replay needs it; `CellAssignment.mapVersion` defaults to `0` and is *"not a foreign key"* | `CellAssignment.mapVersion` exists; the map's own provenance does not | **PARTIAL** |

**S1 is the binding one.** Without a boundary there is no extract, and without an extract there is
nothing for any candidate engine to be benchmarked over.

---

## 4. Required Shard Fields

`shardModel.validateDefinition()` and `validators.v4ShardSizing()` between them already define
exactly what a shard definition must carry, and every field is enforced at publish.

| Field | Required by | Enforced |
|---|---|---|
| `shardId` | §3.5 "the unit of scaling, failure isolation, leader election, and configuration scope" | `validateDefinition` — blocking |
| `regionId` | §3.5 "every Leg is routed to exactly one shard at intake, determined by its first Stop's region" | `validateDefinition` — blocking |
| `state` | §3.5 ACTIVE / REBALANCING / DRAINING / RETIRED | `validateDefinition` — blocking on an unknown value |
| *(set)* region → shard is a **function** | §3.5; else `Ω_terminal` bounds nothing either shard can reach | `validateDefinitions` — blocking |
| *(set)* shard ids unique | §3.5 | `validateDefinitions` — blocking |
| `maxAgents` | §3.5 bound 2 | `v4ShardSizing`, falls back to `shard.max_agents` (20 000) |
| `missionRatePerAgentHour` | §3.5 *"configured per region against that region's measured `r`"* | `v4ShardSizing`, falls back to `shard.mission_rate_per_agent_hour` (4) |
| `commitTxnServiceTimeMs` | §3.5 `t_txn` | `v4ShardSizing`, falls back to `shard.commit_txn_service_time` (5 ms) |

**No schema change is needed to publish shard definitions either.** What is missing is the input:

| # | Input | Why it cannot be defaulted | State |
|---|---|---|---|
| H1 | The region's **measured** `r` (missions per agent per hour) | §3.5: *"It is inversely proportional to mission rate. A dense urban shard running short hops at `r = 20` admits roughly 4 400 agents, not 20 000."* The register's `4` is PROVISIONAL and global | **NOT MEASURED** — needs a region and its demand |
| H2 | Number of shards, hence number of regions | §3.5; and it multiplies the hierarchy count: hierarchies = *models × 2 × regions* | **NOT DECIDED** |
| H3 | Routing colocation topology | §5.2 requires the engine *"colocated with the shard"*, which makes it a per-shard resource cost and therefore an input to the §3.5 sizing inequality — a term the inequality does not currently carry at all | **NOT DECIDED** |

H3 is worth stating plainly: **§3.5's sizing inequality does not yet account for the routing
engine's own per-shard footprint**, and §5.2 requires that footprint to exist on every shard. Once
the engine is chosen and its runtime memory per profile is known, the shard-sizing report gains a
resource that may bind before either of the two bounds §3.5 currently states.

---

## 5. Missing Mobility-Model Decision

**The decision:** *which agent classes will this deployment operate, and therefore which mobility
models — and which traversal domains — must the routing engine serve?*

### 5.1 Which of the four traversal domains the current architecture actually requires

`domain/mobilityModel.js` declares four. Assessed against what the architecture says about each,
not against what an engine could do:

| Domain | Required by the **current** system? | Evidence |
|---|---|---|
| `SIDEWALK_GRAPH` | **YES** | The only seeded model uses it. §25.2 makes ground robots "Baseline case … Reuses everything" |
| `ROAD_GRAPH` | **Not by the current fleet; declared and reachable** | §25.2 puts delivery vehicles/vans under "Additions required: road routing with vehicle restrictions; driver-hours regulations". No such model is declared. But the same OSM extract serves both, so including it costs an extract nothing and a hierarchy something |
| `INDOOR_GRAPH` | **NO — and it is architecturally a *different mechanism*, not a routing profile** | §6.2: indoor and multi-level sites "use site-local graph zones rather than geodesic cells, because in a multi-storey building geodesic proximity is a poor proxy for travel time. The index abstraction is 'proximity partition,' and its implementation is per-region configuration." §3.6 repeats it. **This is not something OSRM/Valhalla/GraphHopper over an OSM extract provides**, and scoping it into B1 would mis-specify the procurement |
| `AIRSPACE_VOLUME` | **NO — a §25 future modality** | §25.2 lists drones/UAS under "Additions required: 3D routing with airspace volumes; airspace authorisation as a hard constraint (class R)…". §25 is titled "Extension Points and **Future** Modalities" |

**Conclusion, and it is a recommendation the ADR must ratify rather than a decision this pass may
take:** B1 scopes the **outdoor geodesic graph** — `SIDEWALK_GRAPH`, and `ROAD_GRAPH` if the
modality roadmap includes vehicles. `INDOOR_GRAPH` is a separate per-region proximity-partition
implementation and `AIRSPACE_VOLUME` is a separate modality decision. §27 item 2 makes the routing
choice depend on "multi-modal networks" with the stated dependency "Modality roadmap", so **this
has to be written down** — it is the difference between procuring one OSM engine and procuring a
multi-modal platform.

### 5.2 The minimum legitimate mobility-model set

**One** — `MOB-SIDEWALK-DEFAULT`, or its production successor — *if* the fleet is homogeneous
sidewalk couriers. That is the minimum consistent with what is declared, and it is provisional
because nothing states the fleet composition.

§25.4 is the constraint that stops this being answered by adding models speculatively:

> every agent class needs its own `λ_time`, energy coefficients, wear coefficients, reliability
> priors, and mobility profile. A heterogeneous fleet with copy-pasted parameters will make
> confidently wrong cross-class comparisons, which is worse than not comparing at all — so class
> parameter completeness MUST be a **commissioning gate**: an agent class without a complete,
> reviewed parameter set cannot be admitted to production allocation.

**A mobility model created to make the profile count non-zero would be exactly the copy-pasted
parameter set §25.4 prohibits.** None was created.

---

## 6. Required Mobility-Model Fields

For each model the deployment declares:

| # | Field | §2.2 element | Present on the seeded model | Blocking for B1? |
|---|---|---|---|---|
| M1 | `modelId` | identity | ✔ | Yes — it is the profile key's first component |
| M2 | `traversalDomain` | Traversal domain | ✔ scalar | Yes — second component. **Schema gap: a `String` column cannot hold a §25.3 composition, which `traversalDomains()` supports** |
| M3 | `speedModel` — speed as f(road class, gradient, surface, **payload mass**, congestion, weather) | Speed model | **stub** | **Yes — this is what a contraction hierarchy is built from.** A hierarchy is a precomputation over edge *costs*; with no speed model there are no costs |
| M4 | `permissionSet` — road classes, surface types, gradients, kerb heights, stair capability, restricted areas, airspace classes | Permission set | partial | **Yes — it is what makes a profile a profile.** An engine profile is a permission set plus a speed model |
| M5 | `kinematicLimits` — max speed, acceleration, **braking distance (payload-dependent)**, turning radius, max gradient | Kinematic limits | partial | Partly — max gradient gates edges; the rest affects ETA not admissibility |
| M6 | `envelopeConstraints` — weather, wind, temperature, visibility, time-of-day | Envelope constraints | declared, all null | No — F31 reads it; it is not a routing-graph input |
| M7 | `dimensionalFootprint` — width, height, length | Dimensional footprint | ✔ complete | Yes — gates passage (doors, lifts, tunnels, bollards) |
| M8 | **Mass** (tare and laden) | *§2.2 tabulates none; §15.5 requires it* | **absent** | **Yes — it is what makes `:loaded` mean something** |
| M9 | **Centre of gravity** | *§2.2 tabulates none; §15.5 requires it* | **absent** | **Yes — same** |

M8 and M9 are the finding of §1.3: the loaded/unloaded profile split is implemented, and the two
quantities §15.5 says cause it are not in the model. Adding them is a schema decision (**D6**), and
their *values* are per-class commissioning data, not calibration.

---

## 7. Routing Profile Derivation

`mobilityModel.routingProfileKey()`, verified by reading it:

```js
routingProfileKey(model, { loaded }) = `${modelId}:${domains}:${loaded ? "loaded" : "unloaded"}`
```

with `domains` produced by `traversalDomains()`: filtered to recognised values, de-duplicated, and
**sorted by code unit** — so two models declaring the same networks in different orders produce the
same key. That is the §9.6 determinism discipline applied to a cache key, and it is correct.

**Verified semantics:**

- The key is **derived, never stored beside the model** — the module says why: *"so that a model
  change cannot leave a cache keyed under a profile that no longer describes it."* Correct, and it
  is what makes M2's schema gap safe rather than dangerous: a model that gains a second traversal
  domain gets a new key and therefore new cache entries, automatically.
- An unrecognised or absent domain yields the literal `"unknown"`, and an absent `modelId` likewise.
  **This is worth flagging:** two differently-broken models both key as `unknown:unknown:unloaded`
  and would share cache entries. `validateModel()` refuses such a model, but the key function does
  not — it is total by design. The routing client must validate before keying.
- Loaded and unloaded are distinct profiles, per §15.5.

**Hierarchy count:**

```
contraction hierarchies  =  (declared mobility models)  ×  2  ×  (regions)
```

At the seeded state: 1 × 2 × 1 = **2**, for `SIDEWALK_GRAPH` only, over an undeclared extract, from
a speed model that does not exist. That figure is **provisional in all three factors** and is not a
procurement input yet.

---

## 8. Required ADR Decisions

| # | Decision | Owner | Blocks | Derivable here? |
|---|---|---|---|---|
| **D1** | **The target OperatingRegion(s) and each one's bounding geometry** | Operations + Commercial | the extract, hence all of B1 | **NO — external** |
| **D2** | **H3 resolutions for FINE and COARSE** (§6.2 wants ~200–500 m / ~5–10 km) | Engineering, against D1's density | every cache key, every k-ring bound, `route.intra_cell_offset_m`'s meaning | **NO — depends on D1** |
| **D3** | **The fleet's agent classes and their mobility models** | Product + Fleet Engineering | the profile set, hence the hierarchy count | **NO — external** |
| **D4** | **B1's traversal-domain scope** — outdoor geodesic only, or multi-modal | Architecture, against the modality roadmap | which engines are even candidates (§27 item 2) | **RECOMMENDED in §5.1; ratification is external** |
| **D5** | **Number of regions/shards at launch, and each region's measured `r`** | Operations | §3.5 sizing; multiplies the hierarchy count | **NO — needs demand data** |
| **D6** | **Where agent mass and centre of gravity are declared** | Architecture | the `:loaded` profile's meaning (§15.5) | **Schema shape is derivable; the values are commissioning data** |
| **D7** | **Whether `MobilityModel.traversalDomain` becomes a composition** (§25.3) | Architecture | multi-modal profiles | **Schema shape is derivable; the need depends on D4** |
| **D8** | **Region extract vintage, refresh cadence, and re-contraction window** | Operations | §5.2 availability; interacts with `map.obstruction_class_max_age` | **NO — external** |

**D4, D6 and D7 are the three whose *shape* this pass could settle and whose *content* it could
not.** They are written down rather than implemented, because each changes a published schema and
§22.1 rule 5 makes a schema that admits an unreviewed shape a defect discovered at decision time.

---

## 9. Exact Information Required From the System Owner

Answerable without any engineering work, in this order.

1. **Which region(s) does this system serve at launch?** For each: a stable `regionId`, a human
   name, and **a boundary as GeoJSON or a bounding box with its CRS**. *(D1 — everything else is
   behind this.)*
2. **What is each region's expected mission rate `r`, in missions per agent-hour, at peak?** A
   planning figure is enough to size the first shard; §3.5's bound is re-evaluated against the
   measured value once traffic exists. *(D5)*
3. **Which agent classes will operate, and how many of each?** For each class: its mobility model's
   six §2.2 elements, plus **tare mass, laden mass, and centre of gravity**. *(D3, D6)*
4. **Does the modality roadmap include vehicles (`ROAD_GRAPH`), indoor sites (`INDOOR_GRAPH`), or
   drones (`AIRSPACE_VOLUME`) within the horizon B1's engine must serve?** §27 item 2 makes the
   engine choice depend on this answer, and §6.2 already says indoor is a different mechanism.
   *(D4)*
5. **Are indoor or multi-level sites in scope at launch?** If yes, `Site.graphZones` needs a
   per-region proximity-partition design that is **not** part of B1. *(S4)*
6. **What is the acceptable map-extract refresh cadence, and what re-contraction downtime is
   tolerable?** §5.2 requires the service colocated and available throughout. *(D8)*
7. **Who owns routing operations?** §22.1 requires an owner per parameter, and `route.matrix_timeout`,
   `route.path_timeout` and the detour factor must be registered before `client.js` ships — the third
   under §22.3 two-person Safety approval.

---

## 10. Downstream B1 Dependency

```
D1 region + boundary
      │
      ├──► D2 H3 resolutions ──► S3 fine-cell set ──► cache keys, charger precompute
      │
      └──► OSM extract ─────────┐
                                │
D3 mobility models ──► D4 domain scope ──► profile set ──┤
      │                                                  │
      └──► M3 speed model, M4 permissions, M8/M9 mass ───┤
                                                         ▼
                                    per-profile contraction hierarchies  ◄── §20.3 item 5
                                                         │
                                                         ▼
                              B1: benchmark candidates, choose, write the ADR
                                                         │
                                                         ▼
                       Phase 8 routing/client.js (+ §5.2 timeouts, ladder, §18.3 B6)
                                                         │
                                          ┌──────────────┴──────────────┐
                                          ▼                             ▼
                    route.degraded_max_radius (SAFETY)        shared composition root
                    route.degraded_reserve_factor (SAFETY)              │
                    detour factor (SAFETY, unregistered)                ▼
                                                              shadow → 14-day window
```

**One item on this diagram is off the critical path and was worked in this pass:** the in-process
routing cache tier, which sits between the caches and Redis and depends on no node above it. It is
`src/engine/routing/inProcessCache.js`, and it is reported in
`PHASE_15_ROUTING_PREREQUISITE_REMEDIATION_REPORT.md` §8–§13. Everything else on this diagram
remains blocked behind **D1** and **D3**.

---

## 11. What Can Be Implemented Now, and What Cannot

| Item | Now? | Reason |
|---|---|---|
| Publish a spatial map | **NO** | The container and its validation exist; the region (D1) does not |
| Publish shard definitions | **NO** | Same — every field is enforced; `regionId` has no value to carry |
| Declare mobility models | **NO** | D3 is external, and §25.4 makes a speculative one a commissioning-gate violation |
| Add `regions[].boundary` to the payload schema | **NO** | Its shape depends on D1's answer (polygon vs bbox, CRS), and an unreviewed schema is what §22.1 rule 5 refuses |
| Add mass / CoG to `MobilityModel` | **NO** | D6 — architecture decision on where they live |
| Register `route.matrix_timeout` / `route.path_timeout` | **NO** | §22.1 requires an owner (question 7) and no module reads them yet |
| Register the detour factor | **NO** | §22.3 Safety-class, two-person approval, and its value needs a deployed engine |
| **The in-process routing cache tier** | **YES** | Depends on nothing above. §20.1's budgets, §20.3's key discipline and §3.3's non-authority rule fully determine it. **Done this pass** |

---

## 12. Verdict

**No production configuration was changed, and that is the correct outcome.** The target region and
the mobility-model set are external decisions; the artefacts that look like them
(`SEED_SPATIAL_MAP`, `MOB-SIDEWALK-DEFAULT`) are a Phase 2 containment demonstration and a
structurally-valid stub, and adopting either as production configuration would have manufactured
the answer to D1 and D3.

**An honest blocker is preferable to an invented configuration.**

---

*End of Phase 15 Routing Configuration Decision. No production configuration was changed and no
commit was created.*
