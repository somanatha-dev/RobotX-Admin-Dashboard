# B1 — Routing Engine Decision Preparation & Readiness

**Date:** 2026-08-25 · **Branch:** `feature/dashboard` · **Baseline commit:** `3f0e522`
**Source digest at preparation:** `72f943df83416c7317b107a903efedee1863459ea3839ccd2b016a69e43e8c81` (565 files)
**Scope:** prepare B1 for a real engineering / product / operations decision. **No engine is selected, ranked or recommended by this document.**

> The digest is identical to the one `PHASE_15_REMEDIATION_AND_CLOSURE.md` §28 records at P15-F1's
> closure. This exercise changed no file under `Backend/{src,tools,tests}`, `package.json` or
> `jest.config.js` — the four things that digest covers. This document sits at the repository root
> and is therefore outside it by construction.

---

## 0. Verdict of this exercise

# B1 — EXTERNAL / BLOCKED. UNCHANGED.

Nothing here moves B1's status and nothing here pretends to. What this document adds is that the
decision is now **specified**: every input the choice needs is enumerated with its owner, its
shape, and the shipped validator that will judge it; every consequence of the choice is enumerated
with the exact file that will carry it; and every claim below was measured on this tree rather than
carried from a report.

**Nothing was invented.** No engine, no region geometry, no speed distribution, no benchmark
number, no extract vintage, no threshold. `DEGRADED_ROUTING` was not used as a substitute for a
routing service, no fake router was written, no release threshold was touched, and no gate was
marked PASS.

---

## 1. The measured result — `node tools/routing/b1Readiness.js`

Run on this tree, at digest `72f943df…`, exit code **0** (by design: reporting a missing decision
is not a build failure — `b1Readiness.js:72–73`).

```
gate: B1 readiness (§5.2, §20.3, execution plan §6.1; report §36.8)
  OVERALL: BLOCKED

  EXTERNAL DECISIONS — none of these is an engineering task:
    BLOCKED         D1  [owner: Operations + Commercial]
                        no authoritative operating region has been declared —
                        the boundary B1's extract is cut from does not exist
                    · Supply the five fields of §36.3.1: regionId + name, kind, the serviceable
                      boundary as GeoJSON Polygon/MultiPolygon in WGS-84 [lon, lat], the CRS,
                      and a version label with a date
                    D2 residual (N23): NOT_CONFIGURED — needs D1 field 2 (region kind) and a
                      cover derived from D1's geometry

    BLOCKED         D3  [owner: Product + Fleet Engineering]
                        no fleet speed model exists — routing edge costs cannot be derived
                    · the repository's only MobilityModel is the durable seed's
                      MOB-SIDEWALK-DEFAULT, whose speedModel is a note deferring to this
                      decision — a declaration, not a model. Required: the agent classes this
                      deployment operates and, per class, §2.2's six elements with a real speed
                      model over roadClass, gradient, surface, payloadMass, congestion, weather

    BLOCKED         D8  [owner: Operations]
                        extract vintage, refresh cadence and re-contraction budget are all undecided
                    · none of the three is recorded anywhere in this repository.
                      CellAssignment.mapVersion defaults to 0 and is explicitly not a foreign key,
                      so there is not even a site to record a vintage at

  B1 CLOSING STEPS (b1Benchmark.js:584–593):
    BLOCKED         step 1  deploy each candidate against the target region extract,
                            per-profile contraction hierarchies BUILT        blocked by: D1, D3
    PASS            step 2  one executable benchmark adapter per candidate
                            3 implemented (osrm, valhalla, graphhopper); 1 correctly
                            NOT_IMPLEMENTED (inhouse) — no engine exists to adapt to
                            and none was fabricated
    BLOCKED         step 3  run the benchmark per candidate on representative hardware
                            BLOCKED via Step 1 — nothing deployed to measure  blocked by: D1, D3
    BLOCKED         step 4  record hierarchy build time and extract refresh cadence
                            blocked by: D1, D8
    BLOCKED         step 5  ENGINE SELECTION — choose on recorded evidence and write the B1 ADR
                            BLOCKED — no recorded evidence exists
                            blocked by: D1, D3, D8, Steps 1, 3, 4

  A benchmark run now would NOT be admissible as B1 Step 3 evidence.
  NO ENGINE IS SELECTED, RANKED OR RECOMMENDED BY THIS TOOL.
```

**Corroborating measurements taken at the same digest:**

| Command | Exit | Result |
|---|---:|---|
| `node tools/routing/b1Readiness.js` | 0 | `OVERALL: BLOCKED` — D1, D3, D8; steps 1, 3, 4, 5 |
| `node tools/gates/checkCompositionRoot.js` | **1** | FAIL — 1 violation / 18 workers: `coordinator` `[LEADER_ONLY_NOT_COMPOSABLE]`, EXTERNAL, B1 |
| `node tools/routing/b1Benchmark.js` | 0 | `NOT_MEASURED` on every row — *"Exit 0 because no claim was made — not because any target was met"* |
| `npx jest --selectProjects engine --testPathPatterns routingB1` | 0 | 3 suites, **95 tests**, 0 failures |
| `node tools/release/sourceDigest.js` | 0 | `72f943df…` (565 files) |

`b1Readiness.assess()` also reports two machine-readable facts consumed elsewhere:
`stepEvidenceAdmissible: false` (read by `b1Benchmark.js`, so a number produced today cannot later
be quoted as Step 3 evidence) and `engineSelected: false`.

---

## 2. The coordinator → routing dependency, traced completely

### 2.1 The chain

```
server.js  (composition root)
  └─ leaderWorkers.create({...}).apply(tick)      on the shard supervisor's mayRunRound
       └─ COMPOSERS.coordinator()                  leaderWorkers.js:313
            └─ return { ok: false, ...UNCOMPOSABLE.coordinator }
                                                   ← REFUSED HERE. Nothing below ever runs.

  the chain the refusal is about:

  coordinator.worker.runRound(deps, input)         coordinator.worker.js:417
    └─ round.execute({ expandCandidates, pricedCandidateFor, planState,
                       budgets, deferPriceFor, commit }, …)      :515
         └─ deps.expandCandidates({...})           solve/round.js:239
              └─ candidates/expansion.expandCandidates(input)    expansion.js:289
                   └─ input.evaluateExact(agentId, leg, snapshot)   :260   ← injected
                        └─ plan/insertion.js:230
                             planBuilder.buildVariant(
                               { ...builderInput, hops: builderInput.hopsForSequence(stops) })
                             └─ planBuilder.js:649  hops = source.hopsForSequence(candidateStops)
                                  └─ routing/cellPairCache.hopsFor(deps, input)   cellPairCache.js:258
                                       └─ cellPairCache.read(deps, parts, options)      :171
                                            └─ if (typeof deps.route !== "function")
                                                 return { ok:false,
                                                   reason: "no router is available
                                                            and the entry is not cached" }   :194–196
                                            └─ routed = await deps.route(parts)             :200
                                                                            ← THE ROUTING ENGINE
```

**The terminus is one line.** `cellPairCache.js:194` is where the decision path stops being a
decision path, and it is explicit about it: with no `route` function and no cached entry, the read
returns `ok: false` and every hop in the sequence becomes `null`.

### 2.2 The second, independent routing population

§20.3 has **two** routing populations, not one. The second is the return leg, and it has its own
cache, its own key and its own injected seam:

```
workers/chargerReachability.worker.onProjectionPublished(deps, input)
  └─ chargerReachabilityCache.precompute(deps, input)      chargerReachabilityCache.js:282
       └─ if (typeof deps.route !== "function")
            return { problems: ["no routing client supplied to the
                                charger-reachability precompute"] }        :288–290
       └─ routed = await deps.route(cellId, profileKey, timeBucket)        :299
```

Registry disposition: `charger_reachability` is **DEFERRED**, `blockedBy` *"Scheduling it needs a
routing client this process does not construct."* Its output is Tier 0's input — `E_return` for
F34/F35 (§14.5) — so it is not optional once the coordinator runs.

### 2.3 The same blocker, one worker along

`shadow` is DEFERRED for the identical reason, stated in `registry.js:184–202`:

> The blocker is the **SAME** as the coordinator's and is EXTERNAL … Consequence: the
> `shadow_agreement` release gate cannot begin accumulating evidence at all — the system is not
> merely short of the fourteen-day window, it cannot start the clock.

### 2.4 What is *not* blocked, and this matters for scoping the work after selection

| Collaborator the coordinator requires | State | Producer |
|---|---|---|
| `commit` | **exists** | `src/engine/commitment/commit.js:241` |
| `pricedCandidateFor` | consumed at `solve/round.js:326`; **no production producer** | composition root's |
| `expandCandidates` | **exists** | `candidates/expansion.js:289` |
| `expandCandidates`'s `evaluateExact` | consumed at `expansion.js:260`; **no production producer** | composition root's |
| `builderInput.hopsForSequence` | consumed at `insertion.js:230` and `planBuilder.js:649`; **no production producer** — grep over `src/` finds only the two consumers | composition root's |
| `cellPairCache.hopsFor` | **exists**; **called from no production module** (only `tests/engine/pricingModel.test.js:493`) | — |

So the gap after an engine is chosen is **larger than one adapter**: three functions on the
decision path (`evaluateExact`, `pricedCandidateFor`, `hopsForSequence`) have consumers and no
producers anywhere under `src/`. That is composition-root work that cannot begin until the engine
exists, and it is why `gate:composition` is one violation rather than one missing import.

---

## 3. All routing adapters

Roster from `tools/routing/adapters/index.js`, in §27 item 2's own order (**that order is not a
preference** — `index.js:12–13`).

| id | file | Availability today | Notes |
|---|---|---|---|
| `osrm` | `adapters/osrm.js` (240 ln) | `NOT_DEPLOYED` | `matrix()` → **Table** `GET /table/v1/{profile}/{coords}`, `sources=0`. `nearestChargers()` → same Table service against the injected catalogue. `radiuses=` sent for every coordinate (R13) so an unsnappable point returns `NoSegment` → `EXTRACT_MISS` rather than a plausible wrong route. Needs `annotations=distance` (OSRM ≥ 5.20); a response without it is `MALFORMED_RESPONSE`, never defaulted. `requiresSnapRadius: true`. Location cap via `maxLocationsPerQuery` (OSRM `--max-table-size`, default 100 **locations**). |
| `valhalla` | `adapters/valhalla.js` (254 ln) | `NOT_DEPLOYED` | `/sources_to_targets`, `costing: engineProfile`. `requiresSnapRadius: true`. Location cap via `maxLocationsPerQuery` (Valhalla's `max_matrix_locations`, per costing). A null distance/time is returned as `NO_ROUTE`, not omitted. |
| `graphhopper` | `adapters/graphhopper.js` (247 ln) | `NOT_DEPLOYED` | `GET /route` per pair — **the open-source server ships no matrix endpoint**, so the adapter fans out with `matrixConcurrency` (default 1). `requiresSnapRadius: false` (the self-hosted `/route` has no radius parameter) — *this is a real asymmetry the comparison must carry, not an adapter defect.* |
| `inhouse` | `adapters/inhouse.js` (72 ln) | **`NOT_IMPLEMENTED`** — correctly | There is nothing to adapt to. `src/engine/routing/` holds three **caches**, each taking routing as an injected function; no graph, no edge-cost model, no contraction hierarchy, no query engine. `src/services/routing.service.js` runs A* over an already-supplied waypoint array and takes geometry from a metered external API — the option **ADR-11 records as rejected** and §6.1 B1 names as incompatible with the hot path (finding N30). Adapting it would enter the rejected option into the benchmark under the in-house candidate's name. |

**Shared, engine-neutral layer:** `adapters/contract.js` (736 ln) — configuration validation,
request validation, output normalisation, the seven-value `ROUTE_STATUS` discriminator, the
four-value `AVAILABILITY` discriminator, the hard timeout, deterministic `nearestK` ordering, and
`chunkDestinations` for per-deployment location caps. `adapters/transport.js` is the JSON transport;
`adapters/deployment.js` is the single configuration seam.

**Enforced in code, not in a comment:** `contract.assertSelfHosted()` refuses six public hosted
hosts by name (`router.project-osrm.org`, `routing.openstreetmap.de`, `valhalla1.openstreetmap.de`,
`valhalla.mapzen.com`, `graphhopper.com`, `api.mapbox.com`) — §5.2, ADR-11, §32.4 **R1**, the one
requirement marked *non-negotiable*. A measurement against a hosted host is evidence about somebody
else's cluster.

---

## 4. The exact interface required by the coordinator

**There are two interfaces, they are different, and conflating them is the first thing that will go
wrong after selection.**

### 4.1 The production seam — what the decision path actually calls

Consumed by `cellPairCache.read()`. This is the interface the coordinator needs.

```js
// deps.route — cell-pair (approach + linehaul), cellPairCache.js:200
async route({ originCell, destCell, profileKey, timeBucket })
  -> { distanceM: number,          // finite, >= 0
       travelSeconds: number,      // finite, >= 0
       travelSdSeconds: number }   // finite, >= 0   (N29 — see below)
```

```js
// deps.route — return leg, chargerReachabilityCache.js:299
async route(cellId, profileKey, timeBucket)
  -> [ { chargerId, distanceM, travelSeconds }, … ]   // ordered; buildEntry applies k and the offset
```

Hard properties the shipped code enforces on the answer:

- `cellPairCache.buildEntry()` **refuses** a non-finite or negative value in any of the three
  fields — an answer that fails this is silently never cached, so the adapter must not pass one
  through.
- **All four key components are required.** `cellPairCache.key()` refuses a key missing any of
  `originCell`, `destCell`, `profileKey`, `timeBucket`: *"an entry computed under one mobility
  profile or one congestion bucket must never be silently applied under another."*
- The charger key additionally requires `charger_availability_version`, and
  `assertVersionInKey()` exists so a caller can have that checked rather than trusted.
- `applyIntraCellOffset()` adds `route.intra_cell_offset_m` at **both** ends and inflates travel
  time at the profile's own speed. **Added, never subtracted** — the same asymmetry argument
  `chargerReachabilityCache` makes about `E_return`.
- **No clock, no randomness.** `timeBucket` is an input derived from the round's pinned decision
  time (§9.6 item 4). An adapter that derived one would be reading a clock, which §32.5 forbids
  outright.

### 4.2 The benchmark seam — what B1 Step 3 measures

Frozen contract at `b1Benchmark.js:84–98`:

```js
module.exports = {
  id: "osrm" | "valhalla" | "graphhopper" | "…",
  description: "deployment shape, extract, profiles, hierarchy build time",
  async matrix({ originCellId, destCellIds, profileKey, timeBucket }),
  //   -> [{ destCellId, distanceM, travelSeconds, travelSdSeconds }]
  async nearestChargers({ destCellId, profileKey, timeBucket, k }),
  //   -> [{ chargerId, distanceM, travelSeconds }]
};
```

### 4.3 The gap between them, stated so it is not discovered later

| | Production seam | Benchmark seam |
|---|---|---|
| Shape | one pair per call | one **matrix** per cell cluster (§20.3 item 4) |
| Field names | `originCell` / `destCell` | `originCellId` / `destCellIds` |
| Failure signal | `ok:false` + `reason`, or a throw | `ROUTE_STATUS` per destination, returned never omitted |
| Degradation ladder | §5.2's, owned by the **Phase 8** client | none — an adapter reports what happened and stops |
| Who owns it | `src/engine/routing/client.js` — **does not exist** | `tools/routing/adapters/` — exists |

`contract.js:14–17` states the boundary: *"It is **not** `src/engine/routing/client.js` — the
production Routing Service client, which is **Phase 8**'s, is blocked by N25/N26 as well as by B1,
and owns §5.2's degradation ladder and §18.3 B6's uniform-treatment rule."*

**Consequence for planning: writing the production client is a separate deliverable from the
benchmark adapters, and it is not in this repository today.** The adapters do not become the client
by being selected.

### 4.4 `travelSdSeconds` — N29, and why it is not optional

**No shortlisted engine returns a travel-time spread.** OSRM's `table`, Valhalla's
`sources_to_targets` and GraphHopper's `route` all return a point estimate. §8.4 prices `p_late`
*"from the ETA predictive distribution, not the point estimate"*, and `cellPairCache.buildEntry`
requires a finite non-negative `travelSdSeconds`.

Defaulting it to `0` asserts *"this ETA is certain"* — the optimistic direction. So
`travelTimeSpread` is **required configuration with a named source**, and
`contract.normaliseSpread()` refuses an adapter constructed without one:

```js
travelTimeSpread: { source: "<free text — where the spread comes from>",
                    model: "PROPORTIONAL" | "ABSOLUTE_SECONDS",
                    value: <finite, >= 0> }
```

**This is an open evidence item that the engine choice does not close.** Whichever engine is
selected, somebody must state where the spread comes from.

### 4.5 `DEGRADED_ROUTING` is not an alternative to any of this

`modeRegister.js:178–197`. Entered on **B5/B6** — *"the Routing Service is unavailable or partially
failing"* — which presupposes a Routing Service that exists. Its envelope is
`route.degraded_max_radius` (register default **`null`**, **UNCALIBRATED**, **SAFETY** class),
`route.degraded_reserve_factor` (1.4, PROVISIONAL, SAFETY), and `uniformDegradedEstimation: true`
— which is B6's rule that a candidate whose route lookup failed must not score *better* than one
whose succeeded. That estimation still needs **D3's speed model**. Using this mode as a substitute
for a routing service would be operating permanently inside a declared failure envelope, on a
radius parameter that has no value.

---

## 5. Configuration required to activate a selected engine

### 5.1 The one seam that exists today

`tools/routing/adapters/deployment.js` — a **module the operator writes**, named by a single
environment variable:

```
ROUTING_B1_DEPLOYMENT=/absolute/path/to/b1Deployment.js
```

It is a file rather than a set of environment variables because two required seams — `projectCell`
and `chargerCatalogue` — are **functions**. Nothing in `Backend/` ships such a file and
`deployment.js` never writes one: unset, every candidate reports `NOT_DEPLOYED` and every benchmark
row `NOT_MEASURED`.

### 5.2 Per-candidate block — every field validated by `contract.normaliseConfig()`

| Field | Required | Refusal if absent/invalid | Owner |
|---|---|---|---|
| `baseUrl` | yes | `MALFORMED_REQUEST`; a public hosted host is refused by name (R1) | Ops |
| `engineProfile` | yes | *"the engine-side profile/costing name whose contraction hierarchy was built. It is **D3's** and is never chosen here"* | D3 |
| `projectCell(cellId) -> { lat, lon }` | yes | *"No routing engine accepts a cell token (**N27**)"* — one implementation, injected once, shared by all four candidates | Eng (D1's geometry) |
| `chargerCatalogue({destCellId, profileKey, timeBucket}) -> [{chargerId, lat, lon}]` | yes | *"A routing engine does not know where chargers are"* — §20.3 item 3's population, ADR-21's pinned availability projection | Charging Scheduler / D1 |
| `matrixTimeoutMs` | yes, > 0 | §5.2 states 150 ms matrix / 400 ms path; **neither is a registered parameter** (§32.5, §6) — so the budget arrives by configuration and no adapter states one | Ops |
| `chargerTimeoutMs` | no | falls back to `matrixTimeoutMs` — **the only fallback in the whole function**, and it reuses a supplied number rather than inventing one | Ops |
| `snapRadiusM` | osrm ✓ valhalla ✓ graphhopper ✗ | R13: a point outside the extract must **FAIL**, not silently snap | B1 Step 1/3 measurement |
| `maxLocationsPerQuery` | optional | OSRM `--max-table-size`, Valhalla `max_matrix_locations`. Without it a 100-destination cluster is refused as a request rather than measured | deployment |
| `matrixConcurrency` | graphhopper only | the OSS server has no matrix endpoint | deployment |
| `travelTimeSpread {source, model, value}` | yes | N29 — see §4.4 | **open evidence item** |
| `profile { energyWhPerMetre, speedMetresPerSecond }` | yes, both > 0 | the vehicle being routed, deliberately **off** the parameter register (`b1Benchmark.js:632–636`) — *"a benchmark that resolved them from the engine's config would be measuring the config"* | D3 |
| `deployment { shape, extract, profilesBuilt, hierarchyBuildTime }` | yes, all four | carried opaquely into `description` and Step 4's record. **A placeholder is refused**: 13 tokens (`tbd`, `todo`, `n/a`, `pending`, `?`, `-`, …) are rejected because *"a placeholder there is indistinguishable from an answer"*. `none` and `not built` are **allowed** — for an undeployed candidate they are the honest answer | D1 (extract), D8 (vintage/cadence) |

### 5.3 The three top-level decision blocks — read by `b1Readiness.js`

Documented in `b1Readiness.js:44–65` and `deployment.js`. These sit **beside** the per-candidate
blocks because a candidate is deployed *against* them.

```js
module.exports = {
  // ── D1 — Operations + Commercial ────────────────────────────────────────
  region:   { regionId, name, kind, boundary: { type: "Polygon"|"MultiPolygon", coordinates },
              crs: "EPSG:4326", version, versionDate },
  cover:    { fineCells: [{ cellId, zoneId, siteId?, indexing }], coarseCells: [...],
              cardinalityException? },
  chargers: [{ chargerId, cellId }],
  regions?: [ …other region declarations, for V-11 disjointness… ],

  // ── D3 — Product + Fleet Engineering ────────────────────────────────────
  // ONE ENTRY PER DISTINCT MOBILITY MODEL, NOT PER AGENT CLASS.
  mobility: [{ modelId, traversalDomain, permissionSet,
               speedModel: { roadClass, gradient, surface, payloadMass, congestion, weather },
               kinematicLimits, envelopeConstraints, dimensionalFootprint }],

  // ── D8 — Operations ─────────────────────────────────────────────────────
  extract:  { identity, source, vintage: "YYYY-MM-DD", refreshCadenceDays,
              recontractionDowntimeBudgetSeconds, bbox, marginDegrees },

  // ── per candidate ───────────────────────────────────────────────────────
  osrm: { … }, valhalla: { … }, graphhopper: { … },
};
```

### 5.4 Configuration required beyond that seam — none of it exists yet

| Item | State | Why it is not settled here |
|---|---|---|
| `route.matrix_timeout`, `route.path_timeout` | **unregistered** (§32.5 records them so) | registering them is §22.1 governance work; the budget arrives through configuration meanwhile |
| `route.degraded_max_radius` | registered, default **`null`**, **UNCALIBRATED**, SAFETY | one of B8's 39 findings; a value requires a safety decision per degraded mode |
| `route.degraded_reserve_factor` | 1.4, PROVISIONAL, SAFETY | B8 |
| `route.intra_cell_offset_m` | 250 m, PROVISIONAL, TUNED | is a function of the *chosen* engine's snapping and the cell size |
| `route.cell_pair_cache_ttl` | 900 s, PROVISIONAL | B8/tuning |
| `route.cell_pair_min_hit_rate` | 0.95, PROVISIONAL | §20.3's steady-state SLI |
| `route.charger_reachability_min_hit_rate` | 0.90, PROVISIONAL | §20.3's steady-state SLI |
| `route.charger_reachability_k` | 5, PROVISIONAL | resolved from the register by the caller; an adapter that defaulted it would be stating a registered parameter's value |
| `route.charger_cache_refresh` | registry cadence for the DEFERRED `charger_reachability` worker | needs a routing client this process does not construct |
| `ROUTING_B1_DEPLOYMENT` | **unset** | the whole of §5.1 |

**Note the publish-time consequence, already reproduced live during Phase 15's pass 3:** the
publish validator refuses the register's own defaults (V9), so a deployment cannot publish a first
configuration version from defaults at all — `route.degraded_reserve_factor` must be bound
explicitly.

---

## 6. B1 evidence checklist

Eight items. Each has an owner, a validator that already exists (or an explicit *none*), and a
falsifiable acceptance test. **None is dischargeable by a commit in this repository.**

### E1 — Authoritative operating region GeoJSON · owner **Operations + Commercial** (D1)

Five fields, checked by `regionBoundary.validateRegionDeclaration()`:

1. `regionId` (stable, no leading/trailing whitespace — *"a key that differs from its own trimmed
   form is two keys"*) + `name` (the human-readable name **the commercial commitment is written
   against**)
2. `kind` — one of `regionBoundary.REGION_KIND`
3. `boundary` — GeoJSON `Polygon` / `MultiPolygon`, WGS-84 `[lon, lat]`
4. `crs` — **required and never assumed**; must be one of `EPSG:4326`, `OGC:CRS84`, `CRS84`,
   `URN:OGC:DEF:CRS:OGC::CRS84`, `WGS84`
5. `version` (immutable label) + `versionDate` (ISO `YYYY-MM-DD`)

Geometry checks that will run: **V-1** type, **V-2** ring closure and ≥ 4 positions (RFC 7946),
**V-3** no self-intersection (ordered *before* V-4, deliberately), **V-4** non-zero enclosed area,
**V-5** coordinate ranges and `[lon, lat]` order, **V-6** CRS, **V-7** stable id.

> **A supplied-but-invalid region is `FAIL`, not `BLOCKED`.** `b1Readiness.assessD1()` keeps these
> apart because *"somebody answered, and the answer is unusable"* — and the two go to different
> people.

### E2 — Cell cover derived from the boundary · owner **Engineering**, input **D1**

`regionBoundary.validateCover()` — **V-8** the cover is non-empty; **V-9** §3.6's stated
1 000–100 000 fine-cell band, or an explicitly recorded `cover.cardinalityException` (*"an unstated
exception and a defect look identical"*); **V-10** every published cell id is a valid H3 index at
the resolution it claims (FINE 8 / COARSE 5), with §6.2's site-local graph-zone exemption requiring
a named site.

Also released by this: **V-11** region disjointness (§3.5 makes region → shard a function),
**V-12** charger containment (*"an unreachable fallback is worse than a missing one, because it is
selected before it fails"*), and **D2's residual (N23)** — whether H3 res 8 fits *this* region kind,
which is Architecture's to resolve and is reported separately from D1's verdict so an Architecture
question is not sent back to the people who supplied a valid boundary.

### E3 — Fleet speed / mobility model · owner **Product + Fleet Engineering** (D3)

One entry **per distinct mobility model, not per agent class** — the schema FK is class → model
(`schema.prisma:1123`), so classes that move identically share one model and one routing profile
pair. Each entry declares §2.2's six elements: `traversalDomain`, `permissionSet`, `speedModel`,
`kinematicLimits`, `envelopeConstraints`, `dimensionalFootprint`.

`mobilityModel.validateRoutingReadiness()` classifies the speed model into four states:

| Status | Meaning |
|---|---|
| `ABSENT` | no `speedModel` declared |
| `STUB` | declared, addresses **none** of the six factors — *"a stub that reads as present is more dangerous than an absent field, because absence is at least visible"* |
| `INCOMPLETE` | addresses some but not all six |
| `DECLARED` | addresses all six. **Whether the values are the fleet's is commissioning evidence this check cannot and does not assert.** |

**Today's state is `STUB`.** The only `MobilityModel` in the repository is the durable seed's
`MOB-SIDEWALK-DEFAULT`, whose `speedModel` is `{ note: "Populated by the routing integration in
Phases 7–9 (blocking decision B1)" }` — an object, so every structural check passes, containing
nothing an engine could weight an edge with.

**Closure criterion C4, checked by `b1Readiness.assessD3()`:** the supplied set must key
**collision-free** under `mobilityModel.routingProfileKey()`. That key is the first component of
every §20.3 cache key and names one contraction hierarchy per region, so two distinct models
deriving one key would share both, and one model's edge costs would be served for the other. The
`MobilityModel.modelId @unique` constraint does **not** protect this path: a `ROUTING_B1_DEPLOYMENT`
module is a hand-written file the durable store never sees.

### E4 — The six speed-model factors · owner **D3**, evidence **fleet measurement**

`roadClass`, `gradient`, `surface`, `payloadMass`, `congestion`, `weather` —
`mobilityModel.SPEED_MODEL_FACTORS`, the specification's own list (§2.2).

The shipped check asks only whether the declaration **addresses** each factor, and that is
deliberate: *"a speed, a gradient response, a congestion coefficient and a weather coefficient are
**D3** … and §25.4 makes inventing one a commissioning-gate violation: 'a heterogeneous fleet with
copy-pasted parameters will make confidently wrong cross-class comparisons, which is worse than not
comparing at all.'"*

**Nothing in this repository can supply a number for any of the six, and this document supplies
none.**

### E5 — Routing extract vintage · owner **Operations** (D8 part 1)

`extract.identity` (a stable name every measurement is attributed to), `extract.source` (so a
re-cut can be reproduced), `extract.vintage` as ISO `YYYY-MM-DD`.

**Never inferred from a file timestamp** — `b1Readiness.js:347–350`: *"a copied file has a new
timestamp and the same vintage."*

Structural gap Operations should know about: `CellAssignment.mapVersion` defaults to `0` and is
explicitly **not** a foreign key, *"so there is not even a site to record a vintage at."*

### E6 — Refresh cadence · owner **Operations** (D8 part 2)

`extract.refreshCadenceDays`, a positive integer. *"It trades against the region's real rate of
physical change and is Operations', not Engineering's. No cadence is chosen here."*

Once supplied **with** an evaluation date, `assessD8` evaluates staleness and returns `FAIL` if the
vintage is older than the cadence — *"a stale extract routes over a map the region no longer has,
and it does so silently — every query still answers."* `asOf` is a parameter rather than a clock
read, so the report is reproducible (§9.6).

### E7 — Re-contraction downtime budget · owner **Operations** (D8 part 3)

`extract.recontractionDowntimeBudgetSeconds`, positive. §5.2 requires the routing service colocated
with the shard and **available throughout**, and a re-contraction is a *rebuild*, not a reload.

This is the one D8 part Operations can answer without knowing the region — but **its number cannot
be fixed until the chosen engine's hierarchy build time is measured at Step 4**, so it is
provisionally stated and then confirmed against measurement.

### E8 — Engine-selection ADR · owner **B1 Step 5**

`b1Readiness.assessSteps()` will not report Step 5 as anything but `BLOCKED` until Steps 1, 3 and 4
each carry `PASS` — and even then its note is *"the selection is a decision with an ADR and is
deliberately not automated — §6.1 makes B1 a decision, not a benchmark result."*

Minimum contents: the region and extract the measurement was taken against (identity + vintage);
the profiles built and per-profile hierarchy build time; every §20.1 row per candidate with its
attribution; the operational costs of Step 4; the named decision-makers for D1, D3 and D8; the
`travelTimeSpread` source (N29); and the rejected alternatives with the measured reason.

### Checklist summary

| | Item | Owner | Validator that exists | State |
|---|---|---|---|---|
| E1 | operating region GeoJSON | Ops + Commercial | `regionBoundary.validateRegionDeclaration` (V-1…V-7) | **absent** |
| E2 | cell cover + chargers | Eng (from D1) | `validateCover` (V-8…V-10), `validateRegionsDisjoint` (V-11), `validateChargerContainment` (V-12), `d2ResidualCheck` | **absent** |
| E3 | fleet mobility models | Product + Fleet Eng | `mobilityModel.validateRoutingReadiness` + C4 collision check | **STUB** |
| E4 | the six speed-model factors | Product + Fleet Eng | `speedModelStatus` (addresses-only) | **absent** |
| E5 | extract vintage | Ops | `assessD8` | **absent** |
| E6 | refresh cadence | Ops | `assessD8` + staleness | **absent** |
| E7 | re-contraction budget | Ops (+ Step 4 measurement) | `assessD8` | **absent** |
| E8 | engine-selection ADR | B1 Step 5 | `assessSteps` refuses to automate it | **absent** |
| — | extract bbox + margin | Ops | `validateExtractMargin` (V-13) — **exists, and is called by nothing** (§11, F1) | **absent** |
| — | `travelTimeSpread` source | open (N29) | `contract.normaliseSpread` | **absent** |

---

## 7. Routing-engine comparison framework

### 7.1 The property being compared is not query speed

§20.3, quoted in `b1Benchmark.js:25–28`:

> **Precomputed hierarchies.** Contraction hierarchies or equivalent, so a query is microseconds
> rather than milliseconds. **This is the reason routing must be self-hosted (§5.2): the
> precomputation is the optimisation, and a metered request-per-query API cannot provide it.**

Consequence, stated by the tool: *"An engine that is twice as fast per query and cannot be
precomputed is the worse choice, and only a measurement in this shape shows that."*

### 7.2 The workload — §20.1's own shape, not a stress case

`b1Benchmark.DEFAULT_WORKLOAD`: **500 legs · 200 candidates per leg · 25 clusters** (§9.4 caps the
round at `solve.max_legs_per_round` and `candidate.max_evaluated`, so this is the shape the engine
is *sized* for). `clusterCount` is §20.3 item 4's batching — one matrix per cell cluster shared
across the legs in it. *"A benchmark that issued one query per Leg would measure a design the
architecture does not have."*

### 7.3 The rows, and the attribution discipline

**Only `ENGINE` rows may rule a candidate out.** This is the single most important rule in the
framework, and it exists because of a measured defect: before the discipline existed, the 0.50
hit-rate the return-leg loop produces *by construction* was compared against the 0.90 target, came
back `EXCEEDED`, and exited 1 — so **every candidate engine of any speed would have been reported
as failing §20.1's routing budget on a number that was a property of the harness's loop structure.**

| Row | Target (register) | Attribution | What the timer brackets |
|---|---|---|---|
| `approach_routing_matrix` | `perf.approach_routing_matrix_p99` = **20 ms** | **ENGINE** | `engine.matrix()` and nothing else |
| `charger_reachability_miss` | `perf.charger_reachability_miss_p99` = **2 ms** | **ENGINE** | `engine.nearestChargers()` |
| `cost_per_candidate` | `perf.cost_per_candidate_p99` = **100 µs** | **ENGINE** | round-level consequence of the two above |
| `charger_reachability_cached` | `perf.charger_reachability_cached_p99` = **10 µs** | CACHE_PATH | a cache **hit** — cache code + kv client. A real §20.1 finding about the deployment; **not** evidence against any engine |
| `cell_pair_hit_rate` | `route.cell_pair_min_hit_rate` = 0.95 | HARNESS_ARTIFACT | 1.00 **by construction** — reported `NOT_MEASURED`, harness figure carried beside it as `harnessObserved` |
| `charger_reachability_hit_rate` | `route.charger_reachability_min_hit_rate` = 0.90 | HARNESS_ARTIFACT | 0.50 **by construction** — same treatment |

The engine-relevant quantity the hit-rate rows were reaching for is reported honestly instead as
the **amortisation block**: queries issued against cache reads served.

### 7.4 Non-latency criteria the decision must carry, and where each is measured

| # | Criterion | Where the evidence comes from | Auto-checked? |
|---|---|---|---|
| C1 | **Self-hostable** — §5.2, ADR-11, R1 (non-negotiable) | `contract.assertSelfHosted` refuses six hosted hosts by name | **yes, in code** |
| C2 | **Per-profile contraction hierarchies buildable** from D3's speed models | Step 1 — an infrastructure action `b1Readiness` states it *"does not perform and cannot observe"* | no |
| C3 | **Hierarchy build time**, per profile | Step 4 | no |
| C4 | **Re-contraction downtime** vs `extract.recontractionDowntimeBudgetSeconds` | Step 4 vs D8 part 3 | no |
| C5 | **Extract refresh feasibility** at D8's cadence | Step 4 | no |
| C6 | **Bounded snap (R13)** — a point outside the extract must FAIL, not snap | osrm `radiuses=` → `NoSegment`; valhalla radius; **graphhopper `/route` has no radius parameter** | asymmetry recorded in the adapters |
| C7 | **Failure discrimination** — §32.5's six conditions | `ROUTE_STATUS` — `NO_ROUTE` vs `EXTRACT_MISS` is load-bearing for §18.3 B6's uniform-treatment rule | per-adapter mapping |
| C8 | **Matrix capability** | OSRM Table ✓, Valhalla `sources_to_targets` ✓, **GraphHopper OSS: none — per-pair `/route` fan-out** | recorded in the adapter |
| C9 | **Location cap** per query | `maxLocationsPerQuery`; `chunkDestinations` splits so a 100-destination cluster is *measured* rather than refused as a request | in `contract.js` |
| C10 | **Determinism (R10)** | nothing in the adapter layer reads a clock, samples, or iterates unordered; charger ties break on `determinism/ordering.compareStrings`, **not** `localeCompare` (ICU-dependent → a replay defect). **Whether the *engine* is deterministic is Step 3's to measure.** | layer yes, engine no |
| C11 | **Travel-time spread** | **none of the three provides one** — N29, §4.4 | n/a — open for all candidates |
| C12 | **Licence / operational cost / support** | not in this repository | **Commercial** |

### 7.5 The two provenance lines that must survive into the ADR

Printed by `b1Benchmark.js` on every report:

> **PROVENANCE:** single process, this machine, one stage of the round. **NOT §20.1 gate evidence**
> — §20.1 is stated per shard, at p99, under nominal operation, on representative production
> hardware, over the whole round. **This measurement can rule an engine OUT; it cannot rule one IN.**

> **NO ENGINE IS SELECTED, RANKED OR RECOMMENDED BY THIS TOOL.** Selection is Step 5, on recorded
> evidence, in an ADR. **A capability fact about a candidate is a fact, not a recommendation.**

---

## 8. Exact data required *before* selection

Ordered by what unblocks what. **D1 and D3 are on the critical path; D8 parts 1–2 sit behind D1.**

```
D1 region declaration ─┬─→ cell cover (V-8…V-10) ─┬─→ V-12 charger containment
                       │                          ├─→ D2 residual (N23)
                       │                          └─→ projectCell() implementation  (N27)
                       ├─→ V-11 disjointness
                       ├─→ extract cut  ─→ D8 vintage/cadence ─→ V-13 margin check
                       └───────────────────────────────────────────────┐
D3 mobility models ────┬─→ speedModel all six factors                  │
                       ├─→ routingProfileKey collision-free (C4)       ├─→ STEP 1
                       └─→ engineProfile per model ───────────────────┘   hierarchies BUILT
                                                                            │
                                                          STEP 3 ←──────────┤ (representative hw)
                                                          STEP 4 ←──────────┘ (+ D8 part 3)
                                                                            │
                                                          STEP 5 ADR ←──────┘
```

| Datum | Shape | Owner | Blocks |
|---|---|---|---|
| region `regionId`, `name` | strings, trimmed | Ops + Commercial | everything |
| region `kind` | `REGION_KIND` enum | Ops | D2 residual, V-9 |
| region `boundary` | GeoJSON Polygon/MultiPolygon, WGS-84 `[lon,lat]`, closed rings, ≥ 4 positions, non-self-intersecting, non-zero area | Ops | extract cut, cover, V-11, V-13 |
| region `crs` | one of the five accepted WGS-84 spellings | Ops | V-6 |
| region `version`, `versionDate` | label + ISO date | Ops | attribution of every downstream measurement |
| `cover.fineCells[]` | `{ cellId (H3 res 8), zoneId, siteId?, indexing }`, 1 000–100 000 or a recorded exception | Eng | cache key space, precompute, V-12 |
| `cover.coarseCells[]` | H3 res 5 | Eng | expansion tiers |
| `chargers[]` | `{ chargerId, cellId }`, every cell in the cover | Ops / Charging | V-12, `E_return` |
| `mobility[]` | one per **distinct** model; six §2.2 elements | Product + Fleet Eng | Step 1, profile keys |
| `mobility[].speedModel` | all six factors **addressed**, with real values | Product + Fleet Eng | edge costs, hierarchies |
| `extract.identity`, `.source` | strings | Ops | attribution, reproducibility |
| `extract.vintage` | ISO `YYYY-MM-DD`, **never a file timestamp** | Ops | staleness |
| `extract.refreshCadenceDays` | positive integer | Ops | staleness, Step 4 |
| `extract.recontractionDowntimeBudgetSeconds` | positive number | Ops (confirmed at Step 4) | Step 4 |
| `extract.bbox`, `.marginDegrees` | box + degrees | Ops | V-13 (**see §11 F1 — nothing calls this check today**) |
| `travelTimeSpread` | `{ source, model, value }` | open (N29) | every adapter's construction |
| `profile` | `{ energyWhPerMetre, speedMetresPerSecond }`, both > 0 | D3 | benchmark rows |
| representative hardware | a deployment target, not a workstation | Ops | Step 3's admissibility |

---

## 9. Exact configuration required *after* selection

Assume an engine E is chosen and an ADR exists. In order:

1. **Write the deployment module** at `ROUTING_B1_DEPLOYMENT`, containing §5.3's three decision
   blocks and the per-candidate block for E (§5.2). Nothing in `Backend/` ships one and nothing
   generates one.
2. **Implement `projectCell(cellId) -> { lat, lon }` once** and share it across candidates. **N27
   is undecided**: §32.5 recommends the projection live in the Phase 8 client rather than in each
   adapter, and records that moving it *"changes `b1Benchmark.js`'s header contract and is
   therefore a Phase 8 change, not a Step 2 change."* Injecting it keeps it relocatable without
   touching an adapter.
3. **Implement `chargerCatalogue(...)`** against ADR-21's pinned availability projection. **No
   adapter ships one and none may.**
4. **State `travelTimeSpread` with a named source** (N29). Not closed by the engine choice.
5. **Set `engineProfile`** to the engine-side profile/costing name whose hierarchy was actually
   built — one per D3 mobility model, and the profile key must stay collision-free (C4).
6. **Set `matrixTimeoutMs`** (§5.2: 150 ms matrix / 400 ms path). Optionally raise
   `route.matrix_timeout` / `route.path_timeout` through §22.1 register governance so the budget
   stops being deployment-local.
7. **Set `snapRadiusM`** from Step 1/3's measured snapping behaviour (osrm/valhalla). For
   graphhopper, record explicitly that the OSS `/route` endpoint offers no radius bound and how
   R13 is satisfied instead.
8. **Set `maxLocationsPerQuery`** to the deployment's own cap, and `matrixConcurrency` for
   graphhopper.
9. **Bind the register's routing parameters for the region** — at minimum
   `route.degraded_reserve_factor` (V9 refuses publishing from defaults),
   `route.intra_cell_offset_m` against the measured cell geometry, `route.cell_pair_cache_ttl`,
   both hit-rate SLIs, `route.charger_reachability_k`, and `route.charger_cache_refresh`.
   `route.degraded_max_radius` is **UNCALIBRATED with no default** and remains a **B8** item — a
   safety decision, not a configuration one.
10. **Record `deployment { shape, extract, profilesBuilt, hierarchyBuildTime }`** with real
    strings. Placeholders are refused by name.

---

## 10. Exact files and code that will need modification once the decision is made

Grouped by whether the work is *configuration* (no repository change), *new code that does not
exist yet*, or *a change to a shipped file*. Line numbers are on digest `72f943df…`.

### 10.1 Configuration only — no repository change

| Artefact | Action |
|---|---|
| `$ROUTING_B1_DEPLOYMENT` module (operator-owned, outside this repo) | create — §5.3 + §5.2 |
| published `ConfigVersion` for the region | bind the `route.*` parameters of §9 step 9 |

### 10.2 New code that does not exist anywhere today

| Path | What it is | Why it cannot be written now |
|---|---|---|
| `src/engine/routing/client.js` | the **production** Routing Service client — §5.2's degradation ladder, §18.3 B6's uniform-treatment rule, the `route(parts)` seam `cellPairCache` calls | `contract.js:14–17` assigns it to **Phase 8**; blocked by N25/N26 **as well as** B1 |
| production `hopsForSequence` | `(stops) => hops[]`, bottoming out in `cellPairCache.hopsFor` | consumed at `insertion.js:230` and `planBuilder.js:649`; **no producer under `src/`** |
| production `evaluateExact` | `(agentId, leg, snapshot) => { feasible, gammaMilliCU, … }` | consumed at `expansion.js:260`; **no producer under `src/`** |
| production `pricedCandidateFor` | `(agentId, legId, candidate) => entry` | consumed at `solve/round.js:326`; **no producer under `src/`** |
| `tools/routing/adapters/inhouse.js` | only if the in-house engine is the choice — then it implements `create()` exactly as `osrm.js` does; *"the rest of the adapter layer needs no change"* | building the engine is **not** B1 Step 2 |

### 10.3 Shipped files that change

| File | Change | Effect |
|---|---|---|
| `src/workers/leaderWorkers.js:143–158` | **delete the `coordinator` row from `UNCOMPOSABLE`** and implement `COMPOSERS.coordinator(context)` at `:313` to build `{ expandCandidates, pricedCandidateFor, commit, planState, deferPriceFor }` and call `coordinatorWorker.start()` | this is what turns `gate:composition` green. The table's own rule: *"a row may only be removed when the worker actually starts."* |
| `src/workers/registry.js:176–202` | move `shadow` from `DEFERRED` and clear its `blockedBy` **only once** the same solve path is constructed | starts the §21.6 shadow clock — the prerequisite for `shadow_agreement`'s 14-day window |
| `src/workers/registry.js:231–241` | move `charger_reachability` from `DEFERRED` once a routing client exists; wire `onProjectionPublished` to publication (**not** to a timer — `chargerReachability.worker.js:26–29`) | warms the `E_return` cache F34/F35 read |
| `server.js` | inject the routing client, the three new functions, and the charger precompute trigger into the leader-worker context | the composition root |
| `src/engine/commitment/commit.js` | **none** — already exists at `:241` | — |
| `src/engine/routing/cellPairCache.js`, `chargerReachabilityCache.js`, `inProcessCache.js` | **none expected** — both seams are already injected | — |
| `tools/routing/adapters/*` | **none expected** for a shortlisted engine — they are complete to the frozen contract | — |
| `formal/`, gate thresholds, `docs/release-evidence.json` | **none. Not touched by this preparation and not to be touched by the selection.** | — |

### 10.4 What deliberately does **not** change

`b1Readiness.js` decides nothing and must keep deciding nothing — *"It declares no region, no
boundary, no bounding box, no speed model, no fleet class, no extract, no vintage, no refresh
cadence, no downtime budget, no threshold and no engine."* Its five states exist precisely so that
`BLOCKED` cannot collapse into `NOT_MEASURED` (a blocker becoming a to-do) or into `PASS` (a
benchmark becoming a formality). **Selecting an engine is not a reason to relax it.**

---

## 11. Findings observed during this preparation — reported, not fixed

Recorded because leaving them implicit is the failure mode this programme has now documented in
five consecutive passes. **None was fixed here: the mandate was to prepare a decision, and each of
these changes a shipped gate or validator.**

### F1 — **V-13 is implemented, tested, and called by nothing** · Medium · REPORTED

`regionBoundary.validateExtractMargin()` (`:760`) implements V-13 — *"the routing extract covers
the region's bounding box plus a margin"* — and is exported. Measured by grep over the whole tree
excluding `node_modules`:

```
src/engine/spatial/regionBoundary.js:760   the definition
src/engine/spatial/regionBoundary.js:816   the export
tests/engine/spatialRegionBoundary.test.js:334,343,346   three tests
```

**No other caller exists.** `b1Readiness.assessD1()` does not call it and `assessD8()` does not
call it. Correspondingly, `assessD8` validates `identity`, `source`, `vintage`,
`refreshCadenceDays` and `recontractionDowntimeBudgetSeconds` — and **never reads `extract.bbox` or
`extract.marginDegrees`**, the two fields `b1Readiness.js:61–62` and `deployment.js` document as
part of the extract block.

So a deployment could supply an extract whose bounding box does not cover the region, and D8 would
report `PASS`. It is **not permissive today** (D8 is `BLOCKED` for want of every other field), and
V-13 correctly returns `NOT_CONFIGURED` rather than a pass when its inputs are absent — but the
check §30.5.5 says *"cannot be written before B1"* has been written, and the moment B1 supplies its
inputs it will still not run. This is the exact *"implemented, unit-tested, never called"* shape
pass 1 named.

**Owner:** Phase 15 / B1 Step 1. **Discharge:** call `validateExtractMargin({ region: declaration,
extract: source.extract })` from `assessD1` or `assessD8` once a region and an extract both exist,
and fold its problems into the D8 verdict. Deliberately not done here: it changes what a gate
reports, and doing so while every input is absent would be verified by nothing.

### F2 — `route.matrix_timeout` / `route.path_timeout` are unregistered · Low · CARRIED

§5.2 states two hard budgets (150 ms / 400 ms) and §32.5 records both as *"unregistered (§6)"*.
They arrive through the deployment module instead, so two deployments can disagree about §5.2's own
numbers with nothing comparing either to the specification. Registering them is §22.1 governance
work and is **not** B1 Step 2's. Carried into §9 step 6 as an explicit post-selection option.

### F3 — the graphhopper snap-radius asymmetry is a comparison hazard · Informational

`osrm` and `valhalla` are constructed with `requiresSnapRadius: true`; `graphhopper` with `false`,
because the self-hosted `/route` endpoint has no radius parameter. R13's requirement — *"a point
outside the extract must FAIL, not silently snap"* — is therefore satisfied by two candidates
structurally and by the third not at all. **This is a real difference between the candidates and
must appear in the ADR as one**, rather than being read as an adapter inconsistency.

### F4 — three decision-path functions have consumers and no producers · Informational

`evaluateExact`, `pricedCandidateFor` and `hopsForSequence` (§2.4). This is correctly *not* a defect
— they are the composition root's, and the composition root is what B1 blocks — but it means the
post-selection work is **composition-root construction**, not adapter wiring, and should be
estimated as such.

---

## 12. Validation commands

Run from `Backend/`. Every one of these was executed during this preparation; the results are §1.

### 12.1 Today — the honest-state commands

```bash
node tools/routing/b1Readiness.js            # OVERALL: BLOCKED   exit 0 by design
node tools/routing/b1Readiness.js --json     # machine-readable; stepEvidenceAdmissible, engineSelected
npm run routing:readiness                    # the same, by script name
npm run routing:b1                           # every row NOT_MEASURED; exit 0 = no claim made
npm run routing:b1 -- --candidates           # the roster and why each row is where it is
npm run gate:composition                     # FAIL — coordinator [LEADER_ONLY_NOT_COMPOSABLE]  exit 1
node tools/release/sourceDigest.js           # bind any evidence to this digest
npx jest --runInBand --forceExit --selectProjects engine --testPathPatterns routingB1
```

### 12.2 With a deployment module supplied — validating the evidence, not the engine

```bash
ROUTING_B1_DEPLOYMENT=/abs/path/b1Deployment.js node tools/routing/b1Readiness.js
#   D1 → PASS|FAIL   (FAIL = somebody answered and the answer is unusable)
#   D3 → PASS|FAIL   (includes the C4 profile-key collision check)
#   D8 → PASS|FAIL|NOT_MEASURED (staleness needs an evaluation date)
#   step 1 → NOT_MEASURED once D1 and D3 both PASS — the deployment is an
#            infrastructure action this tool does not perform and cannot observe

ROUTING_B1_DEPLOYMENT=/abs/path/b1Deployment.js npm run routing:b1 -- --engine osrm
ROUTING_B1_DEPLOYMENT=/abs/path/b1Deployment.js npm run routing:b1 -- --engine valhalla
ROUTING_B1_DEPLOYMENT=/abs/path/b1Deployment.js npm run routing:b1 -- --engine graphhopper
#   Read ENGINE rows only for candidate comparison.
#   CACHE_PATH rows are findings about the deployment.
#   HARNESS_ARTIFACT rows are NOT_MEASURED by construction — do not quote them.
```

### 12.3 After composition — the gates that must move

```bash
npm run gate:composition     # must reach PASS: 18/18 workers, 0 violations
npm run gates                # 8 gates; today 7 PASS / 1 FAIL
npm run release:gates        # today 16 green / 1 red / 7 not evaluated; exit 1
                             # engine_decision_path_wired is the row B1 turns
npm test                     # 160 suites / 7 112 tests at this digest — must stay green
```

### 12.4 Never

```bash
# Do NOT run the benchmark against a public host — assertSelfHosted refuses six by name,
# and a measurement against one is evidence about somebody else's cluster (R1, ADR-11).
# Do NOT quote a b1Benchmark number while stepEvidenceAdmissible is false.
# Do NOT edit tools/routing/b1Readiness.js to change a BLOCKED into anything else.
```

---

## 13. Acceptance criteria

### 13.1 For the *evidence* — B1 Steps 1, 3, 4

| # | Criterion | Verified by |
|---|---|---|
| A1 | `assessD1` reports **PASS**: region valid, cover valid, V-11 clean, V-12 clean | `b1Readiness.js` |
| A2 | D2's residual (N23) reports `VALID`, **or** its `INVALID` is routed to Architecture as a recorded decision — not silently carried | `d2ResidualCheck` |
| A3 | `assessD3` reports **PASS**: every declared model `routable`, every `speedModel` `DECLARED` (all six factors), **zero** routing-profile-key collisions (C4) | `b1Readiness.js` |
| A4 | `assessD8` reports **PASS**: all five fields present and the vintage inside its own cadence at the evaluation date | `b1Readiness.js` |
| A5 | V-13 passes — the extract covers the region bbox plus the stated margin | `validateExtractMargin` **once F1 is discharged**; until then, by hand |
| A6 | Step 1 reaches `NOT_MEASURED` (D1 + D3 PASS, candidates configured) and hierarchies are **built** per profile per candidate | `assessSteps` + the deployment record |
| A7 | `stepEvidenceAdmissible` is **`true`** before any number is recorded as Step 3 evidence | `b1Readiness.assess()` |
| A8 | Step 3 measured **on representative hardware**, not a workstation, with the provenance line intact | `b1Benchmark.js` |
| A9 | Every `ENGINE` row recorded per candidate; `CACHE_PATH` rows recorded as deployment findings; `HARNESS_ARTIFACT` rows **not** quoted as candidate evidence | the attribution discipline |
| A10 | Step 4 records hierarchy build time per profile and re-contraction time against `recontractionDowntimeBudgetSeconds` | Step 4 |
| A11 | `travelTimeSpread.source` names a real source (N29) | `contract.normaliseSpread` |
| A12 | Determinism (R10) measured **of the engine** — the adapter layer's determinism is not the engine's | Step 3 |

### 13.2 For the *decision* — B1 Step 5

| # | Criterion |
|---|---|
| B1 | An ADR exists, naming the engine, the decision-makers for D1/D3/D8, the evidence, and the **rejected alternatives with their measured reason** |
| B2 | The selection cites only `ENGINE` rows and the C1–C12 criteria — never a `HARNESS_ARTIFACT` figure |
| B3 | R1 holds: the selection is a **self-hosted** deployment. A metered external API in the hot path is ADR-11's rejected option |
| B4 | Every measurement is attributed to a named extract **identity + vintage** and to the hardware it ran on |
| B5 | `b1Readiness.js` reports Step 5 as no longer `BLOCKED` **because Steps 1, 3 and 4 carry evidence** — not because the tool was changed |

### 13.3 For the *integration* — after composition

| # | Criterion |
|---|---|
| C1 | `npm run gate:composition` → **PASS**, 0 violations across 18 workers, and the `coordinator` row is gone from `UNCOMPOSABLE` **because the worker starts** |
| C2 | `shadow` composes on the same solve path, so the §21.6 clock can start — the precondition `shadow_agreement` has never had |
| C3 | `charger_reachability` is driven by **projection publication**, not by a timer |
| C4 | `npm test` stays green: **160 suites / 7 112 tests / 0 failures / 0 skips** at the pre-change digest, plus whatever the new code adds |
| C5 | No gate weakened, no threshold moved, no `NOT_EVALUATED` converted to `PASS`, no tolerance widened |
| C6 | `route.degraded_max_radius` still **UNCALIBRATED** unless a real safety decision was taken — it is B8's, and B1 does not close it |
| C7 | `engine_decision_path_wired` turns **GREEN because `gate:composition` exits 0**, and for no other reason |

### 13.4 What still does **not** close, even when all of the above holds

| Blocker | Why B1 does not close it |
|---|---|
| **B8** — 39 Safety-class parameters not `DERIVED` | requires measurement, certification and named-owner attestation |
| **B-P** — 4 PRODUCTION gates | require a fleet that has operated. B1 lets the 14-day shadow clock **start**; it does not run it |
| **B-O** — 3 ORGANISATIONAL gates | require named humans to have acted |
| **B-M** — `model_check_capacity_1_2_3` GREEN and NOT PROVEN | needs a completed TLC run; compute, not decisions |
| **X3** — no `TASK` timer producer | §4.2 has no transition table. Inventing one is not remediation |

---

## 14. What was NOT done

- **No engine was chosen, ranked, recommended, or hinted at.** The roster order in §3 is §27 item
  2's own, restated; it is not a preference and the shipped registry says so in its own header.
- **No benchmark number was produced or invented.** `b1Benchmark.js` was run and reported
  `NOT_MEASURED` on every row; that output is recorded verbatim and nothing was derived from it.
- **No geographic data was created.** No region, no boundary, no bounding box, no cell cover, no
  charger location.
- **No fleet speed distribution was created.** None of §2.2's six factors was given a value, a
  plausible range, or a default.
- **No extract vintage, cadence or downtime budget was chosen.**
- **B1 was not marked PASS**, and `b1Readiness.js` was not edited.
- **No `ROUTING_B1_DEPLOYMENT` module was written**, and no environment variable was set.
- **Coordinator composition was not bypassed.** `UNCOMPOSABLE.coordinator` stands; `gate:composition`
  still exits 1.
- **No fake router was created.** Nothing was added to `src/engine/routing/`.
- **`DEGRADED_ROUTING` was not used as a substitute for a routing service** — §4.5 records why it
  cannot be one.
- **No release threshold was modified.** No file under `Backend/{src,tools,tests}`, `package.json`
  or `jest.config.js` was changed; the source digest is byte-identical to the one at P15-F1's
  closure.
- **F1 (V-13 uncalled) was reported and not fixed**, because fixing it changes what a gate reports
  and every input that would exercise it is absent.

---

## 15. STOP

**B1 remains EXTERNAL / BLOCKED** until the authoritative decision and its required evidence exist.
The next action is not an engineering task:

1. **Operations + Commercial** answer **D1** — the five region fields.
2. **Product + Fleet Engineering** answer **D3** — the agent classes and, per class, a real speed
   model over the six §2.2 factors.
3. **Operations** answer **D8** — extract vintage, refresh cadence, re-contraction budget.

Only then do Steps 1, 3 and 4 become runnable, and only then is Step 5 a decision that can be made
on evidence rather than on preference.

**TRUTH > GREEN.**

# B1 — EXTERNAL / BLOCKED.
