# RD-2026-10-12-01 — V1 RNSIT physical-pilot routing source

| | |
|---|---|
| **Recorded** | 2026-10-12 |
| **Owner** | Project owner |
| **Status** | **PROPOSED — NOT EFFECTIVE.** See §8. This record grants no operating authority until every acceptance criterion in §5 is met and recorded |
| **Subject** | The in-house campus router that prices physical agents (`fleetProviders/physicalRouter.js` over `simulation/campusTraversalNetwork.js`) |
| **Scope** | A bounded RNSIT physical pilot only. JSSATE Bengaluru is excluded |
| **Answers** | [`V1_CONTRACT_AND_STOP_CONDITION.md`](../v1/V1_CONTRACT_AND_STOP_CONDITION.md) §F.1 row **F** |
| **Supersedes** | Nothing |
| **Contradicts a frozen record?** | **No** — only because §3 holds. Recorded as the B1 engine, it would contradict frozen ADR-11 |
| **Status of B1 / D1 / D3 / D8** | **Unchanged — all BLOCKED.** This record supplies none of them. See §3 |
| **Gates and verdicts** | **Unchanged.** See §10 |
| **Machine-readable record** | **None, deliberately.** See §11 |

---

## 0. Why this record exists

Since Gate 1 (`cfd6a51`, 2026-10-04), any process started with `PHYSICAL_FLEET_ENABLED=true` and a
valid physical fleet declaration prices and routes physical agents over an in-process campus router.
No decision record names that router, states what it is for, or bounds its use. The Phase 15 / B1
audit of 2026-10-12 classified this as finding **F9**, a human decision.

This record makes that decision explicit. It does not change what the code does.

---

## 1. The decision

> **Project-owner decision, 2026-10-12 (approved direction):** the existing in-house campus router
> is recorded as a **proposed, bounded RNSIT physical-pilot routing source**. It is **not B1**, **not
> the selected production routing engine**, and **not release evidence**. The pilot is **NOT
> EFFECTIVE** until every acceptance criterion in §5 is satisfied and that satisfaction is recorded
> as a dated amendment to this record.
>
> **AC1 policy, decided:** a route must remain within the declared operating boundary. A route that
> leaves the boundary is **not permitted**. Site entry and exit are handled by a **separately
> approved procedure**, not by the router.
>
> **AC2:** no numerical snap radius is chosen here. AC2 stays pending until a defensible value is
> determined **and** enforced.
>
> **AC3 and AC4** stay pending until map provenance and freshness are verified and Operations
> resolves GAP-5.

---

## 2. What is designated, named by content

### 2.1 Call path

| Step | Location |
|---|---|
| The declaration is loaded only under `PHYSICAL_FLEET_ENABLED=true` | [`Backend/server.js:666-670`](../../Backend/server.js#L666-L670) |
| The physical provider builds the router | [`Backend/src/services/fleetProviders/physicalProvider.js:83`](../../Backend/src/services/fleetProviders/physicalProvider.js#L83) |
| Route production (`route(parts)`) | [`Backend/src/services/fleetProviders/physicalRouter.js:117-194`](../../Backend/src/services/fleetProviders/physicalRouter.js#L117-L194) |
| Network build and shortest path | [`Backend/src/simulation/campusTraversalNetwork.js:151`](../../Backend/src/simulation/campusTraversalNetwork.js#L151) (`createCampusTraversalNetwork`) |
| Travel time | [`Backend/src/engine/routing/campusTravelModel.js`](../../Backend/src/engine/routing/campusTravelModel.js) (`travelTimeFor`) |
| Endpoint serviceability | `Backend/src/engine/routing/cellProjection.js` with `campusServiceability.js` |

The self-hosted OSRM seam ([`Backend/src/engine/routing/productionRouter.js`](../../Backend/src/engine/routing/productionRouter.js))
is **not** this router. `server.js` does not wire it. The B1 benchmark adapters under
`Backend/tools/routing/adapters/` are not this router either.

### 2.2 The network source

| | |
|---|---|
| **File** | `rnsit-campus-osm.geojson` (repository root); identical copy at `Frontend/src/features/maps/campus/data/rnsit/rnsit-campus-osm.geojson` |
| **git blob** | `a82f61e35a8445f9ee818cb8a24f0dcfc8412341` (the same blob [`RD-2026-08-30-01`](RD-2026-08-30-01-rnsit-serviceable-boundary.md) §2 adopts) |
| **SHA-256** | `04cb64c4205dc59462e149501fdd93b412106cfdc8d7249661bc8f3f47dc08b4` |
| **Origin** | overpass-turbo export, collection `timestamp` 2026-08-23T04:59:06Z (the export time, not an OSM revision), added in `3f0e522` |
| **How it is selected** | `extractForDeclaration` matches the pinned delivery-domain declaration's boundary way id **and** exact geometry |
| **Graph** | undirected; edges are OSM `highway` LineStrings of the agent's permitted classes; edge weight is haversine length; plain Dijkstra with memoised trees; RNSIT has 93 vertices and 1 connected component for `footway+path+service` |

### 2.3 The travel model

```
travelSeconds   = distanceM / nominalSpeedMps  +  distanceM × 15 / 100
travelSdSeconds = (distanceM × 15 / 100) × route.declared_travel_sd_buffer_multiple
```

- `nominalSpeedMps` is the **operator-entered** commissioning value "normal speed (m/s)"
  ([`Backend/src/services/robotSpecification.js:449`](../../Backend/src/services/robotSpecification.js#L449)).
- The 15 s per 100 m buffer is the owner's declared V1 campus allowance of 2026-09-13. That
  decision exists only in `campusTravelModel.js` and commit `c97956a`; no other decision record
  holds it.
- The spread is declared, not measured (`DECLARED_V1_OPERATIONAL_UNCERTAINTY`).
- Terrain is `0` only under the declaration `site.terrain = FLAT_DECLARED`.
- Stop-start cycles are the declared `site.stopStartCyclesPerHop`.
- Without either declaration, the route is refused by name.

---

## 3. What this record is NOT

| It is not | Why |
|---|---|
| **B1**, or any B1 step | B1 Step 5 selects an engine "on recorded evidence" in an ADR ([`B1_EXTERNAL_INPUT_HANDOFF.md`](../phase15/B1_EXTERNAL_INPUT_HANDOFF.md) STEP 5 and §5.1). No Step 1, 3 or 4 evidence exists |
| **The selected production routing engine** | Frozen [`ADR-11`](../adr/ADR-11-routing.md) fixes routing as *"Self-hosted with **precomputed hierarchies**"*. This router precomputes nothing. An integration record *"may never contradict a frozen record"* ([`docs/adr/README.md`](../adr/README.md)). So this router cannot be recorded as the engine without the architecture being unfrozen, and that decision is outside this record |
| **Release evidence** | Row F states that such a source *"would not discharge B1, close `engine_decision_path_wired`, or make any release evidence admissible"* |
| **A D1 supply** | It reads the owner-adopted boundary (`RD-2026-08-30-01`). The B1 D1 handoff (§1.4, §1.8) still lacks the signed five-field declaration, the cell-count exception and the RNSIT snapshot artefact |
| **A D3 supply** | One operator-entered scalar speed is not the measured six-factor model of handoff Part 2. `campusTravelModel.js` itself says a physical fleet's speed is D3's |
| **A D8 supply** | The extract has no stated vintage, refresh cadence, re-contraction budget or provenance record (handoff Part 3) |
| **A way past `gate:composition`** | [`PHASE_15_MASTER.md:655`](../phase15/PHASE_15_MASTER.md) forbids an in-process router written to make that gate pass. This record touches no gate (§10) |

---

## 4. Scope and restrictions

These apply once the record is effective. Until then they define what an effective pilot would be.

| Restriction | Value |
|---|---|
| **Region** | RNSIT only, bounded by `way/1120154292` exactly as `RD-2026-08-30-01` adopts it |
| **Excluded** | JSSATE Bengaluru: its campus network has 4 disconnected components, and no pilot is proposed there |
| **Named units** | **PENDING — owner to list.** The pilot covers only robot ids listed in this record. The `robots[]` entries of the physical fleet declaration (`PHYSICAL_FLEET_DECLARATION_FILE`) must equal that list. No unit is named here because none has been supplied |
| **Operator supervision** | **Required.** The physical unit has no hardware e-stop ([`physicalPolicy.js:7`](../../Backend/src/services/fleetProviders/physicalPolicy.js#L7)); F7 is satisfied by a software stop latch. The supervision procedure is **PENDING — owner to define**: who supervises, from where, and with what means to stop the unit |
| **Environment** | A declared **non-production** pilot environment. Nothing produced under it is production or release evidence |
| **Expiry** | **PENDING — owner to set.** No date is inferred. An effective pilot must carry an expiry date, and it lapses on that date unless renewed by amendment |
| **Rollback** | Restart the process with `PHYSICAL_FLEET_ENABLED=false`. No physical declaration is then loaded (`server.js:666-670`), no physical routing producer is composed, and a physical agent's route is refused by name (`physicalProvider.js:154-165`). The simulated fleet is not affected. No data migration is involved |
| **Site entry and exit** | **Not by the router.** AC1 forbids boundary exits. Entry and exit follow a separately approved procedure (AC4) |

---

## 5. Acceptance criteria

**Every criterion is required.** The pilot becomes effective only when all seven are met and §8 is
followed. The current status was measured or read on `769bba2`, 2026-10-12.

| # | Criterion | Decided policy / threshold | Current status | What would close it | Owner |
|---|---|---|---|---|---|
| **AC1** | Route containment | **No route may leave the declared operating boundary.** Entry and exit go through the separately approved procedure (AC4) | **FAILS.** 21.3 % of the permitted network length lies outside the boundary (661 m of 3,099 m; 19 of 119 vertices), and **9.2 %** of in-campus to in-campus routes (372 of 4,032) pass through at least one point outside it. Method: §7 | A change to the router or to the network source, **separately authorised**, plus the AC7 test | Owner, then Engineering |
| **AC2** | Snap radius (R13 `snapRadiusM`) | **PENDING — no value is chosen here.** It must be defensible and enforced | **FAILS.** No bound is applied. Straight-line access connectors reached **112.9 m** in the §7 probe, unchecked against buildings | A determined value, with its basis recorded, enforced in code under separate authorisation | Owner |
| **AC3** | Map provenance and freshness | The network source is verified on the ground, and its vintage is stated | **PENDING.** Content identity is pinned (§2.2), but no OSM revision is pinned. The extract has **0 barrier nodes**. All 21 highway ways are `access=private`. No site survey exists | A written survey of the permitted ways (traversability, kerbs, steps, gates, width) and a stated vintage. The snapshot is re-pinned by SHA-256 if it changes | Operations |
| **AC4** | Site entry and exit (GAP-5) | Handled by a separately approved procedure | **PENDING.** `RD-2026-08-30-01` §8.5 records that the adopted boundary contains no mapped gate or entrance, and leaves entry and exit open with Operations | An approved procedure, recorded | Operations |
| **AC5** | Unit speed | Each named unit's `nominalSpeedMps` is measured, not only entered on the form | **PENDING.** The value is operator-entered | A measured speed per named unit, with its method | Owner / Fleet |
| **AC6** | Travel-time validation | Measured traversals are compared with predicted `travelSeconds`, against a tolerance **stated before measuring** | **PENDING.** No tolerance is set and no traversal is measured | A stated tolerance, then a recorded comparison | Owner |
| **AC7** | Tests and labels | A test asserts the AC1 containment rule. Stale labels are corrected | **PENDING.** No test asserts route containment. Stale labels are listed in §6 items 6–9 | A test, plus comment and label corrections, under separate authorisation | Engineering |

---

## 6. Unresolved limitations

These remain true after this record. Items 1–4 stay true after an effective pilot unless separately
addressed.

1. **No access, barrier, one-way, surface or width handling.** The router reads only the `highway`
   class.
2. **Flat terrain is declared, not measured.** There is no elevation source.
3. **Travel time is declared, not measured.** This covers the buffer and the spread.
4. **No precomputed hierarchies.** Plain Dijkstra is adequate at 93 vertices and is not a B1
   candidate (ADR-11).
5. **No closure or obstacle knowledge** beyond the static extract.
6. `campusTraversalNetwork.js:36-40` says the module is DEVELOPMENT_SIMULATION and *"reachable only
   through `simulationRouter`"*. Since Gate 1, `physicalRouter.js:24` requires it directly. Its
   `describe()` still prints "DEVELOPMENT_SIMULATION" for physical routes.
7. `physicalRouter` labels `distanceM` with provenance `CAMPUS_OSM_NETWORK`, which is outside
   `productionRouter.FIELD_PROVENANCE`. The route does not pass through `productionRouter`'s
   PRODUCTION-mode provenance check.
8. `campusTravelModel.js:75` cites `routingProvenance.js`, and no such file exists.
9. `Backend/tools/routing/adapters/inhouse.js` states that no graph builder exists in `src/`. That is
   stale, although its NOT_IMPLEMENTED verdict on the B1 candidate still holds.
10. **No independent safety sign-off exists.** This is a solo project, and none is claimed.
11. **`RD-2026-08-30-01` §5** calls the polygon the *"RobotX serviceable **routing** boundary"*. AC1
    adopts the reading that routes must stay inside it.
12. The **2026-09-13 travel-model decision** has no dedicated decision record. This record cites it
    (§2.3) but does not re-decide it.

---

## 7. Measurement basis for AC1 and AC2

This was a read-only probe of router behaviour on `769bba2`, 2026-10-12, run offline with the shipped
`createCampusTraversalNetwork`. **It is not operational evidence.**

- **Inputs:** `rnsit-campus-osm.geojson` (§2.2); classes `footway+path+service`; boundary
  `way/1120154292`, ray-cast point-in-polygon.
- **Network length outside:** each permitted segment's haversine length, counted as outside when its
  midpoint lies outside the boundary.
- **Route exits:** an 11 × 11 grid over the boundary's bounding box keeps the 64 points inside it.
  All 4,032 ordered pairs were routed. A route counts as an exit if any path point lies outside the
  boundary. 0 pairs were refused.
- **Access connectors:** the largest `accessM.origin` or `accessM.destination` over those routes.
- **Permission sets:** a unit with a different permission set gives different figures. AC1 and AC2
  must hold for the permission set of every named unit.

---

## 8. How this record becomes effective

1. Each of AC1–AC7 is satisfied, and its evidence is recorded in a dated amendment section appended
   to this record. The amendment names the evidence by path or hash.
2. The pending values in §4 (named units, supervision procedure, expiry) are supplied in the same
   amendment.
3. The **Status** row is changed to EFFECTIVE in that amendment, with its date. Nothing else makes
   this record effective. No criterion is waived implicitly.

**Until then, this record grants no authority for physical operation.** A physical run made before
then is outside this record and is not a pilot under it.

---

## 9. Relationship to existing records

| Record | Relationship |
|---|---|
| `V1_CONTRACT_AND_STOP_CONDITION.md` §F.1 row F | **Answered.** A real, declared, owner-supplied source in a declared non-production environment, recorded as such |
| `ADR-11` (frozen) | **Not contradicted**, because §3 holds |
| `ADR-33` | Untouched. It scopes B1's traversal domains |
| `ADR-34` | The precedent row F cites, for a declared non-production act. Not amended |
| `ADR-35` / `ADR-36` / `RD-2026-09-14-01` | Untouched. Task destinations are still geofenced at intake (ADR-36) |
| `RD-2026-08-30-01` | Its boundary is the pilot boundary (§4). Its §5 wording grounds AC1. Its §8.5 is AC4 |
| `B1_EXTERNAL_INPUT_HANDOFF.md` | Untouched. B1, D1, D3 and D8 remain as it states |
| `docs/phase15/`, `docs/v1/` | Not edited. Phase 15 is frozen and `docs/v1` is closed |

---

## 10. Effect on gates and verdicts

**None.** A Markdown file under `docs/` is read by no gate.

| Gate / verdict | What it reads | After this record |
|---|---|---|
| `gate:composition` | `leaderWorkers.UNCOMPOSABLE` (a fixed table) | **RED**, unchanged |
| `routing:readiness` | `ROUTING_B1_DEPLOYMENT` only; Step 5 is constant `BLOCKED` | **BLOCKED**, unchanged |
| `release:verdict` | `Backend/docs/release-evidence.json`, `Backend/docs/release-attestations.json` | **BLOCKED**, unchanged |
| Source digest | `Backend/{src,tools,tests}`, `package.json`, `jest.config.js` (`tools/release/sourceDigest.js`) | Unchanged; `docs/` is outside its scope |
| `gate:columngen` | `docs/release-decisions/*.json` only (`checkColumnGeneration.js:166`) | Unaffected, because this record is Markdown |
| V1 stop conditions | — | Unchanged |

---

## 11. Machine-readable record

**None, deliberately.** `gate:columngen` reads every `.json` in this directory as a §21.6
column-generation classification. A JSON twin of this record would be misread there. This matches
the reasoning of `RD-2026-08-30-01` §10 and `RD-2026-09-14-01` §10.

---

## 12. Pending owner and Operations inputs

| Item | Section | Owner |
|---|---|---|
| Named unit list | §4 | Project owner |
| Operator supervision procedure | §4 | Project owner |
| Expiry date | §4 | Project owner |
| Snap radius value and basis (AC2) | §5 | Project owner |
| Site survey and stated vintage (AC3) | §5 | Operations |
| Site entry and exit procedure (AC4) | §5 | Operations |
| Measured unit speeds (AC5) | §5 | Project owner / Fleet |
| Travel-time tolerance, stated before measuring (AC6) | §5 | Project owner |
| Authorisation for the AC1, AC2 and AC7 code changes | §5 | Project owner |
