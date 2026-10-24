# RNSIT zone-mapping proposal (DTARO Step 5)

| | |
|---|---|
| **Status** | **PROPOSAL, awaiting owner review.** Nothing in this document is implemented, published, pinned or written to any database |
| **Prepared** | 2026-10-22 |
| **Baseline** | `feature/dashboard` @ `5e94a1ab35b41072bcfa11a77a13bd1b340fd5c9`. `git diff` is empty: tracked files are identical to HEAD |
| **Untracked files at baseline** | This directory's five earlier documents; `Backend/tests/unit/dtaro/obstaclePipeline.test.js`; and `Backend/tests/unit/dtaro/obstacleRecipientPolicyExperiment.test.js`. **The last file appeared during this step (mtime 2026-10-22 14:05:51 +0530). This step did not create it, read it or change it.** Another session is apparently working in the same checkout |
| **Companion documents** | [README](README.md) · [CURRENT_IMPLEMENTATION_MAP](CURRENT_IMPLEMENTATION_MAP.md) · [DTARO_GAP_ANALYSIS](DTARO_GAP_ANALYSIS.md) · [IMPLEMENTATION_READINESS_AND_TEST_PLAN](IMPLEMENTATION_READINESS_AND_TEST_PLAN.md) · [DTARO_OBSTACLE_POLICY_DECISIONS](DTARO_OBSTACLE_POLICY_DECISIONS.md) |
| **Decides** | Nothing. It answers OD-1 option (a)'s practical question: *what* a multi-zone RNSIT map would look like, and *what* publishing it would require. It does not touch OD-2 (recipients) |

### Evidence labels

| Label | Meaning |
|---|---|
| **[S]** | Read in the current source during this step. The line was confirmed |
| **[E]** | Computed during this step by a read-only script over repository files (Appendix A). Reproducible. **Derived index facts, not proposed assignments** |
| **[A]** | Carried from an earlier audit document or project memory, not re-proved here |
| **[O]** | Owner instruction (this task) or a recorded owner decision |
| **[P]** | **Proposal.** A design choice for the owner to accept, change or reject |
| **[U]** | Unverified or assumed |

**No live database was inspected.** No connection was made to Neon, Docker :5433 or any other database. Every statement about `Zone`, `Region`, `CellAssignment` or `ConfigVersion` describes source code and bootstrap definitions, not deployed rows.

---

## 1. Executive summary

1. **Today RNSIT has exactly one engine zone, `rnsit-z1`, covering all 64 index cells** [S]. Every spatial-map producer in the tree (the V1 bootstrap and the demonstration seed) publishes that single zone. With one zone, "zone-scoped" obstacle delivery is the same as campus-wide delivery.
2. **A zone per destination is not achievable at H3 resolution 11.** A fine cell is about 57 m across. Of the 42 cover cells that any listed RNSIT destination feature touches (footprints, declared points, verified access points), **21 are shared by two or more building footprints** [E]. Since a cell belongs to exactly one zone (V8), destinations that share a cell cannot be in different zones. Examples: Mechanical & EEE shares cells with the MBA block and the Basketball Court; the Canara Bank building shares its only cell with the Main Building.
3. **Proposed instead [P]: four area-level zones**, each named after the destinations it contains:
   - west academic & hostels;
   - north-east (Main Building · Canara Bank · northern Canteen);
   - east (Mechanical & EEE · MBA);
   - south (Auditorium · Innovation Center · PU College · southern Canteen).

   A dry run of the proposed assignment rule over the 64-cell cover gave non-overlapping anchors but **14 tied cells** that the owner must assign [E]. No cell list is proposed here.
4. **Several requested destinations have weak or no map evidence:**
   - **Library:** no feature anywhere in the RNSIT data [E]. Not proposed.
   - **Canteen:** two OSM buildings are both named "Canteen", 215 m apart in different areas.
   - **Playground:** three different candidates.
   - **PU College:** one unverified, user-supplied point and no footprint.
   - **Canara Bank:** the point and the OSM building are 53.5 m apart.
5. **The proposal keeps the cover unchanged.** It reassigns the zone of each of the same 64 cells and adds or removes no cell. So region resolution, the `assigned` test, F33 serviceability and shard placement are not changed by it [S trace, not executed].
6. **Database alignment is mandatory, and the order matters.** F27 takes a route's traversed zones from the **published map**, but takes an agent's authorised zones from **database `Zone` rows** in its region. If a new zone ID is published before a matching `Zone` row exists, every assignment touching that zone is **denied by F27** (§6.2) [S trace].
7. **Publishing needs a complete restated version.** It must carry every existing binding, including `cutover.engine_enabled`, plus the same delivery-domain declaration. Without them the engine is disabled or every geofence verdict is INDETERMINATE.
   - **No existing tool can do it.** The V1 bootstrap refuses once a version it did not publish is pinned.
   - **The publish-time validators do not run `hierarchy.validateForPublish`.** So a cell that names an undeclared zone would pass V8 (§6.4) [S].
8. **Out of scope and unchanged:** authoritative rerouting, allocation, pricing, feasibility, commit/fence, offers, outbox, routes and completion verification. **Authoritative rerouting is deferred and needs a separate, future owner authorisation.**

---

## 2. Verified current spatial configuration

### 2.1 The model and its rules

| Fact | Evidence | Label |
|---|---|---|
| ADR-28 (frozen): "Region ⊃ zone ⊃ cell, with site orthogonal to zone; containment by published assignment, not by query-time geometry; zone admitted to the config scope hierarchy" | `docs/adr/ADR-28-spatial-hierarchy.md` (Decision) | [S] |
| Zone is a configuration scope level: `global → region → zone → site → agent_class → agent` | `Backend/src/engine/config/resolver.js:8, 45` | [S] |
| H3 FINE = resolution 11, COARSE = 5 (ADR-35, RD-2026-09-14-01) | `Backend/src/engine/spatial/cells.js:230-231` | [S] |
| A point becomes a cell by `cells.cellForPoint(lat, lon, FINE)` (`h3.latLngToCell`). It is the only geometry the containment path performs | `cells.js:305` | [S] |
| A cell resolves to `{zoneId, siteId, regionId, assigned}` by **lookup** in the published map. `resolve()` takes no coordinates. An unlisted cell returns `assigned:false`, never a guess | `Backend/src/engine/spatial/hierarchy.js:63, 114, unassigned()` | [S] |
| A cell in the index is **not** a delivery-domain claim. Delivery-domain membership is the exact coordinate against the published declaration, evaluated once at intake and pinned on `Stop.geofenceResult` | `cells.js` header (RD-2026-09-14-01 D1/D6); `Backend/src/engine/spatial/deliveryDomain.js` | [S] |
| `toConfigPayload` publishes zones as `{id, regionId}` only. **A zone's human name is not in the published map**; it lives only on the database `Zone.name` | `hierarchy.js:375` | [S] |

### 2.2 The single RNSIT zone today

| Fact | Evidence | Label |
|---|---|---|
| V1 bootstrap: region `regionId="rnsit"`, zone `id="rnsit-z1"` / `name="RNSIT Zone 1"`, **all** 64 FINE cells assigned to it at `mapVersion 1`. It refuses unless the cover is exactly 64 cells | `Backend/tools/deploy/bootstrapV1Environment.js:66-74, 175-183, 342` | [S] |
| The demonstration seed writes the same region, zone and cover | `Backend/tools/demo/seedV1Demonstration.js:161, 172-186, 338-349` | [S] |
| The published map's `regionId` is the database **`Region.id` row key**, not the business key `rnsit`. A map is therefore specific to an environment's database | `bootstrapV1Environment.js:340-343` (`regionRowId`); `seedV1Demonstration.js:340-347` | [S] |
| The `rnsit-z1` row carries a **real** bounding box (the delivery-domain bbox), so the legacy DTARO bbox lookup also matches it | `bootstrapV1Environment.js:367-376`; seed `seedV1Demonstration.js:159-168` | [S] |
| The delivery-domain declaration is a sibling of `spatial`, `regionId: "rnsit-campus"`, version `way/1120154292`, digest-pinned boundary | `bootstrapV1Environment.js:160-173`; `seedV1Demonstration.js:69-71, 112-130` | [S] |
| Other in-tree references to `rnsit-z1`: `tools/verify/spatialDeliveryDomainLive.js`, `tools/verify/v1DemonstrationSolvePath.js`, `tests/fixtures/phase7/local-2026-10-09.json`, `tests/unit/dtaro/obstaclePipeline.test.js` (a bbox KV fixture) | grep | [S] |

### 2.3 The cover

| Fact | Value | Label |
|---|---|---|
| Boundary | OSM `way/1120154292`, adopted unmodified (RD-2026-08-30-01). SHA-256 of `rnsit-campus-osm.geojson` = `04cb64c4…dc08b4`, matching the pinned digest | [S] [E] |
| D6 index cover (boundary-overlapping, res 11) | **64** cells | [E] |
| Centre-contained cells | **45**. The other **19** are boundary cells, whose centres lie outside the campus. They are index buckets only (D6) | [E] |
| Cover cells crossed by a permitted way (`footway`/`path`/`service`, sampled every 2 m inside the boundary) | **43 of 64**. The road-class set is taken from the access register's `validation.roadClasses`; each agent class's own `permissionSet.roadClasses` was not re-read | [E] / [U] |
| Fine-cell size | ≈57 m vertex to vertex (`fineCellDiameterMetres`) | [A] spatial memory |

### 2.4 How a simulated robot's position and route reach the zone model

| Step | Evidence | Label |
|---|---|---|
| A `VirtualRobot` drives the per-stop `path` of its signed OFFER: the priced campus-network route from `campusTraversalNetwork` | CURRENT_IMPLEMENTATION_MAP §4; `Backend/src/simulation/campusTraversalNetwork.js` header | [A] [S] |
| The network is built from the campus OSM extract's `highway` ways permitted by `MobilityModel.permissionSet.roadClasses`. Endpoints are projected onto the nearest permitted segment. No maximum access distance is applied (R13 `snapRadiusM` is undeclared) | `campusTraversalNetwork.js:15-36` | [S] |
| Telemetry places the agent: observed position → `cellForPoint` → `indexMap(snapshot.spatial).resolve` → region | `Backend/src/workers/indexMaintainer.worker.js:181-191` | [S] |
| The route's **traversed zones** for F27 = the zones of the **agent's cell and the stop cells only**, resolved from the pinned map. An unresolved one gives `zonesTraversed=null` and F27 denies | `Backend/src/services/v1DemonstrationComposition.js:363-375`; same pattern in `fleetProviders/physicalProvider.js:175-191` | [S] |
| Interior route cells are **not** resolved to zones anywhere today | same | [S] |

### 2.5 The legacy bounding-box zone path (unchanged, but affected by new `Zone` rows)

| Fact | Evidence | Label |
|---|---|---|
| `loadZones` reads **every** `Zone` row, `orderBy: { name: "asc" }`. `getZoneForCoordinates` returns the **first** row whose bbox contains the point | `Backend/src/services/zoneManager.service.js:57, 95-101` | [S] |
| Telemetry and AUTH drive legacy membership and `zone:{id}` rooms from this lookup. No code emits to a zone room | CURRENT_IMPLEMENTATION_MAP §5.1, §6.2 | [A] |

### 2.6 Not verified

- Which `Region`, `Zone`, `CellAssignment` and `ConfigVersion` rows exist in LOCAL (Docker :5433), the original Neon, or RobotX-2.
- Whether any environment's pinned version was published by the bootstrap, the seed, or by hand.

---

## 3. Proposed zone catalogue

### 3.1 Design principles [P]

| # | Principle | Reason |
|---|---|---|
| P-1 | **Cover-preserving.** Same 64 cells, same region; only `zoneId` per cell changes | No change to region resolution, the `assigned` test, F33 or shard placement (§2.1, §2.4) |
| P-2 | **Area zones, not building zones** | 21 of the 42 feature-touched cells are shared by more than one footprint (§4.2). Building-level zones would need cells split, which V8 forbids |
| P-3 | **Few zones (about 4)** | ~0.1 km² campus, ~10 simulated robots. The paper's n/Z saving is small at this scale, and each extra zone adds boundary crossings (§7) |
| P-4 | **Each zone is contiguous** under H3 adjacency | Stable membership; a robot is not moved between zones by a single-cell island |
| P-5 | **Boundaries should cross paths, not run along them** | A robot driving along a boundary path would change zone membership on every few telemetry frames |
| P-6 | **RNSIT only.** No JSSATE region, zone or cell | OD-9, owner instruction |
| P-7 | **A zone name says what the zone contains**, and nothing is named after a destination that has no evidence | Avoids the "Library zone with no library" problem (§3.3) |

### 3.2 Candidate layout L4 (four area zones) [P]

The zone IDs follow the existing `rnsit-z…` convention. The IDs themselves are an owner decision (Q2).

"Anchor cells" are the cells of the cited evidence. They seed the assignment rule (§5); they are not the zone's full cell set.

| Proposed ID | Proposed name (`Zone.name`, unique) | Anchors (map evidence) | Source verification | Robot-accessible area and approach paths [E] | Overlaps / ambiguities | Cells to be assigned | Missing before publication |
|---|---|---|---|---|---|---|---|
| `rnsit-z2` | RNSIT West — CSE/ISE/CSDS, ECE, Civil & AIML, hostels | Verified access points: CSE/ISE/CSDS ×3, ECE ×3, Civil & AIML ×3 (6 distinct cells). Footprints `way/204638929`, `way/204638932`, `way/1486312656`; hostels `way/204638934/935/936` | Access points **VERIFIED** (OWNER_SITE_CHECK, 2026-10-22, reviewer recorded in the register). Footprints are OSM, not site-checked | Anchors are crossed by service ways `204638946`, `204638950`, `768598925`, `788480057`, `1183883496`, `1510483621` and footways `788480058`, `788480059`, `1510483622` | Hostel C shares cells with the central pitch and the southern Canteen. `way/204638950` and `way/1510483621` also reach `rnsit-z3`'s anchors; `768598925` reaches `rnsit-z5`'s. The co-located points (First Grade College, Evening College, Cyber Security) sit in one cell between this area and the south | Anchors plus cells won by the rule; dry run ≈17 including 6 boundary cells | Owner placement of the co-located-points cell and the Hostel C / pitch cells |
| `rnsit-z3` | RNSIT North-east — Main Building, Canara Bank, Canteen (north) | `rnsit-canara-bank` point; OSM node `2146315474`; Canteen `way/204638928` (food_court); Main Building `way/204638937` | Point **UNVERIFIED** (user-supplied). Footprints OSM. Canara Bank 2 candidates, Canteen 4 candidates + 2 needs_review, Main Building 2 candidates + 1 needs_review. **None verified** | Service ways `204638948`, `204638949`, `204638950`, `1510483621`, `1539965405`; footway `655840340` | Canara Bank building's only cell is shared with Main Building, Basketball Court and the pitch. The Canara point and building are 53.5 m apart (§4.3) | Dry run ≈10 including 3 boundary cells | Resolve Canara Bank location (Q8) and which Canteen is meant (Q5) |
| `rnsit-z4` | RNSIT East — Mechanical & EEE, MBA | Verified access points: Mec & EEE ×3, MBA ×3 (5 distinct cells). Footprints `way/204638941`, `way/204638943` | Access points **VERIFIED** (as above) | Service ways `204638948`, `204638949`, `788480061`; footway `788480060` | Mec & EEE and MBA share two cells (`8b6014510492fff`, `8b6014512865fff`) [E]. **They cannot be in different zones.** Mec & EEE also shares `8b6014512860fff` with the Basketball Court (north-east) | Dry run ≈10 including 3 boundary cells | Owner placement of the Basketball Court cells |
| `rnsit-z5` | RNSIT South — Auditorium, Innovation Center, PU College, Canteen (south) | `rnsit-innovation-center` (also the V1 **depot** point), `rnsit-pre-university-college`, `rnsit-food-court` points; Auditorium `way/1224937859`; Canteen `way/1486312655` (fast_food) | Points **UNVERIFIED**. Auditorium 3 needs_review. No verified access point in this area | Service ways `204638949`, `768598925`, `1112008837`, `1539965404` | Auditorium shares cells with the Shiva Temple, the pitch and the southern Canteen. RNS International School (3 verified points, single cell `8b6014512b24fff`) and Playground 2 lie south-west. In the dry run both fell to this zone (International School: 2 grid steps from these anchors vs 3 from `rnsit-z2`'s; Playground 2: 5 vs 6) [E]. That is a nearest-anchor result, not an established boundary | Dry run ≈27 including 7 boundary cells: the largest zone | Confirm PU College and Innovation Center points; decide International School / Playground 2 placement |

**Not proposed as zones:**

- **The central grass pitch** (`way/151617521`, 12 cells) is split across neighbouring zones by the rule. It is not a robot destination. Whether any permitted way crosses it was not checked [U].
- **`rnsit-z1`:** see §3.5.

### 3.3 Requested destinations: assessment [E] [S]

| Requested | Evidence found | Verified? | Can it be its own zone? | Where it goes in L4 [P] |
|---|---|---|---|---|
| **Library** | **None.** No RNSIT OSM feature (57 features), supplemental point (11) or access candidate (32) mentions a library. The only "library" strings are in JSSATE data and a generic classifier pattern (`Frontend/src/features/maps/campus/semantics/campusOperational.js:77, 91`) | — | **No: no location** | **Not proposed.** Needs a source location first (§4.5) |
| **Canteen** | Two OSM buildings named "Canteen": `way/204638928` (amenity=food_court, beside the Basketball Court, north-east) and `way/1486312655` (amenity=fast_food, `level=-1`, beside the Auditorium, south). Plus supplemental `rnsit-food-court`, 40.6 m from the second and 215.2 m from the first | Footprints OSM. Point UNVERIFIED. Access candidates 4 candidate + 2 needs_review, **0 verified**. Proposed labels "Canteen — near Basketball Court" / "Canteen — beside Auditorium" are unconfirmed | No. Two places in different areas; one zone would have to be non-contiguous | North canteen → `rnsit-z3`; south canteen → `rnsit-z5` |
| **Playground** | Three candidates: (a) `way/151617521`, unnamed, `sport=cricket;football`, `surface=grass`, oddly tagged `building=commercial`, at the campus centre, overlapping 12 cells; (b) `rnsit-playground-2`, inside the boundary, 347.5 m from (a), 49.9 m from the sim network [A]; (c) `rnsit-playground-1`, **outside** the boundary and outside the cover. Also the Basketball Court `way/1224941277` | (a) OSM. (b), (c) UNVERIFIED points. No access candidates | (a) would be a 12-cell zone at the centre that every cross-campus route touches; it has no destination point | Not a zone. (a) split by the rule; (b) falls in or near `rnsit-z5` |
| **PU College** | Supplemental `rnsit-pre-university-college` only. No OSM footprint, no access candidate | **UNVERIFIED** point | Possible only as part of an area | `rnsit-z5` (anchor) |
| **Mechanical block** | `way/204638941` "RNSIT Mec and EEE Department". Mechanical and EEE share the building | Footprint OSM. 3 access points **VERIFIED** | No: shares 2 cells with MBA, 1 with the Basketball Court | `rnsit-z4` |
| **Canara Bank** | OSM building `way/204638927` (amenity=bank); OSM node `2146315474`; supplemental `rnsit-canara-bank`. Point ↔ node 10.2 m; point ↔ building 53.5 m. The point is 22 m inside the boundary, within the 25 m UNCERTAIN band (`Frontend/src/features/maps/ARCHITECTURE.md:345-356`) | Point UNVERIFIED. 2 access candidates, 0 verified | No: the building's only cell is shared with Main Building, Basketball Court and the pitch | `rnsit-z3` |

**Other destinations the map does support:**

| Destination | Evidence | Area |
|---|---|---|
| CSE/ISE/CSDS, ECE, Civil & AIML | VERIFIED access points | `rnsit-z2` |
| MBA block | VERIFIED access points | `rnsit-z4` |
| RNS International School | VERIFIED access points | Open (Q3) |
| Main Building | Candidate access points only | `rnsit-z3` |
| Auditorium | needs_review access points | `rnsit-z5` |
| Innovation Center, First Grade/Evening College, Cyber Security dept | UNVERIFIED points | `rnsit-z5` / open |
| Three hostels | All named "Hostel"; role NONE [A] | `rnsit-z2` |
| Shiva Temple | OSM footprint | `rnsit-z5` |
| Basketball Court | OSM footprint | Open (Q3) |

### 3.4 Alternative layouts [P]

| Layout | Shape | For | Against |
|---|---|---|---|
| **L2** | North / south, divided across the central pitch | Fewest boundary crossings; simplest to review | Barely different from campus-wide delivery; little to demonstrate |
| **L4** (§3.2) | Four areas | Every requested destination with evidence gets a named home; zones of 10–27 cells | 14 tied cells to resolve; the spine `way/204638949` touches three zones' anchors (§4.4) |
| **L6** | L4 with west split (academic vs hostels) and south split (auditorium vs International School/Playground 2) | Closer to "destination" zones | Zones of only a few cells; many more crossings; hostel/academic cells are shared (`8b6014512b34fff`, `8b6014512b36fff`, `8b6014512869fff`) |

### 3.5 The fate of `rnsit-z1` [P]

| Option | Effect |
|---|---|
| **(a) Retire it from the published map, keep the row.** New IDs `rnsit-z2…z5` carry all 64 cells | Clear meaning ("z1 = whole campus" is not reused). The row stays in the region, so F27's authorised set stays a superset. The legacy bbox lookup still matches its whole-campus box (§6.5). The `tools/verify` harnesses that name `rnsit-z1` must be updated or pinned to the old version |
| **(b) Keep `rnsit-z1` as one of the four areas** (for example the south, which holds the depot) | Fewer renames, but `rnsit-z1` silently changes meaning from "whole campus" to "one area" in harnesses and fixtures that assume the former |

The audit leans to (a) because (b)'s change of meaning is hard to notice. This is the owner's decision (Q2).

---

## 4. Map evidence and unresolved boundary questions

### 4.1 Sources inspected

| Source | Contents | Status |
|---|---|---|
| `rnsit-campus-osm.geojson` (root; Frontend copy under `Frontend/src/features/maps/campus/data/rnsit/`) | 57 OSM features: 22 buildings (`building=*`, most of them named), 11 other amenity, leisure or memorial features, and 24 highway ways (15 service, 6 footway, 2 steps, 1 residential) | OSM extract. Boundary adopted by RD-2026-08-30-01 |
| `rnsit-campus-supplemental.geojson` | 11 user-supplied points, `verificationStatus: UNVERIFIED`; 3 outside the boundary (main gate, Playground 1, parking lot) | UNVERIFIED |
| `rnsit-campus-access-candidates.geojson` | 32 generated access points: **18 verified** (six departments × 3, OWNER_SITE_CHECK 2026-10-22), 6 needs_review, 8 candidate | Verified entries only are site facts |

### 4.2 Cells shared by more than one building footprint [E]

These are the reason for area zones. Each row is a cover cell that two or more destination footprints overlap.

| Cell | Footprints (and verified access points) in it |
|---|---|
| `8b601451284dfff` | CSE/ISE/CSDS · ECE · Hostel B (+ CSE pt 3, ECE pts 1–2) |
| `8b601451286bfff` | CSE/ISE/CSDS · ECE (+ CSE pt 2) |
| `8b6014512b36fff` | CSE/ISE/CSDS · Hostel A · Civil & AIML (+ CSE pt 1, Civil pt 1) |
| `8b6014512b34fff` | Hostel A · Civil & AIML (+ Civil pt 3) |
| `8b6014512869fff` | Hostel C · Civil & AIML (+ Civil pt 2) |
| `8b6014510492fff` | pitch · Mec & EEE · MBA (+ Mec pt 1) |
| `8b6014512865fff` | Mec & EEE · MBA (+ Mec pt 3, MBA pt 3) |
| `8b6014512860fff` | Mec & EEE · Basketball Court (+ Mec pt 2) |
| `8b6014512863fff` | pitch · Canara Bank building · Main Building · Basketball Court |
| `8b6014512862fff` | Canteen (food_court) · Basketball Court |
| `8b601451049efff` | pitch · Hostel C · Canteen (fast_food) · `rnsit-food-court` point |
| `8b601451049cfff` | Auditorium · Canteen (fast_food) |
| `8b6014510482fff` | Shiva Temple · Auditorium |
| … | 7 further cells shared between the pitch and one or two neighbours (MBA, Auditorium, Mec & EEE, Hostel C, ECE, Main Building), plus `8b6014512b32fff` (CSE/ISE/CSDS · Hostel B, a boundary cell) |

**Totals:** 21 shared cells; 42 cells touched by any listed feature; 22 touched by none.

### 4.3 Per-destination questions the data cannot answer

| # | Question | Why the data cannot answer it |
|---|---|---|
| B-1 | Where is the Library? | No source has it |
| B-2 | Which "Canteen" is the operational canteen, or are both? | Two OSM buildings share the name; the supplemental "Food Court" sits by the southern one. The access importer refuses unlabelled duplicates [A] |
| B-3 | Which "Playground"? | The central pitch, Playground 2 and Playground 1 (outside the boundary) are 347 m or more apart; the central pitch is unnamed and mis-tagged `building=commercial` |
| B-4 | Where is Canara Bank's entrance: at the point/node, or at the building 53.5 m away? | Point and node agree (10 m); the polygon does not. The point is in the 25 m UNCERTAIN band |
| B-5 | Does the PU College have a building, and is the point at it? | Point only, UNVERIFIED |
| B-6 | Do robots actually use the north–south spine (`way/204638949`) and the west service ways (`204638950`, `1510483621`, `768598925`)? Where should zone lines cross them? | OSM tags only; there is no site evidence of robot-usable surfaces |
| B-7 | Which zone owns the 19 boundary cells? | Each must have exactly one zone (V8), yet they confer no serviceability (D6). A rule is needed (§5 step 4) |
| B-8 | Which zone owns the co-located First Grade College / Evening College / Cyber Security cell (`8b601451049afff`)? | It is an exact tie: 1 grid step from both the west and the south anchors [E] |
| B-9 | Which zone owns the Basketball Court? | Its two cells split under the rule: `8b6014512860fff` → east, `8b6014512862fff` → north-east [E]. That is acceptable only if the court is not a destination |

### 4.4 Approach-path evidence [E]

Permitted ways crossing the anchor cells of more than one proposed zone:

| Way | Class | Touches anchors of | Consequence |
|---|---|---|---|
| `way/204638949` | service | `rnsit-z3`, `rnsit-z4`, `rnsit-z5` | Main spine. A robot on it crosses at least two zone lines. Where those lines cut it decides how often membership changes |
| `way/204638950` | service | `rnsit-z2`, `rnsit-z3` | West–north-east link |
| `way/1510483621` | service | `rnsit-z2`, `rnsit-z3` | Same |
| `way/768598925` | service | `rnsit-z2`, `rnsit-z5` | West–south link |
| `way/204638948` | service | `rnsit-z3`, `rnsit-z4` | North-east–east link |

None of these is evidence that a way is robot-usable on site.

### 4.5 Missing evidence and how to obtain it [P]

| Gap | How to obtain | Who |
|---|---|---|
| Library location | Owner site check. Record it as a supplemental point (with review) or an OSM footprint, through the existing campus-data review process (`docs/runbooks/campus-access-point-review.md`) | Owner |
| Canteen identity, labels; Canara Bank entrance; PU College point; Playground meaning | Same site-check method as the 2026-10-22 department review (OWNER_SITE_CHECK) | Owner |
| Usability of the cross-zone service ways | Site walk of `204638949`, `204638950`, `1510483621`, `768598925`, `204638948` | Owner |
| A cell→zone table | Generated by a deterministic tool (§5), reviewed as a dated artefact. **Not hand-written** | Implementation, after approval |

---

## 5. H3 cell-assignment methodology [P]

The method produces a reviewable 64-row cell→zone table. It never computes containment at query time. The table is the published assignment; geometry is used only to **produce** it, once, offline.

| Step | Rule | Dry-run result this step [E] |
|---|---|---|
| 1. Input | The D6 cover reproduced from the digest-checked boundary: `h3.polygonToCellsExperimental(boundary, 11, containmentOverlapping, true)`. Refuse unless exactly 64 cells (as `bootstrapV1Environment.js:181` does). **Never** the 3-argument `polygonToCells`, which silently ignores the flag [A] | 64 cells; digest matched |
| 2. Anchors | Each zone's anchor cells come only from cited evidence (§3.2), preferring VERIFIED access points. Each anchor must belong to exactly one zone | 0 anchor cells claimed by more than one zone |
| 3. Assignment | Each remaining cell goes to the zone of the nearest anchor by H3 grid distance (`gridDistance`) | Sizes 17 / 10 / 10 / 27 |
| 4. Ties and boundary cells | A tie is settled **only** by an explicit owner-reviewed override list, never by label order. Boundary cells (19) follow the same rule and are marked index-only (D6) | **14 tied cells**, broken here by label order for illustration only; boundary cells 6 / 3 / 3 / 7 |
| 5. Shape checks | Each zone non-empty and contiguous under `gridDisk(k=1)` adjacency; each of the 64 cells in exactly one zone; no cell outside the cover | Not run |
| 6. Path check | Count zone transitions along every permitted way and along a sample of V1 routes; flag any boundary that runs along a way (P-5) | Not run |
| 7. Validation | `hierarchy.validateForPublish(map).ok === true` **and** `configService.validateCandidate` with the full restated version → zero blocking findings | Not run |
| 8. Output | A dated, digest-stamped table (cell, zoneId, centre-in/boundary, reason: anchor / nearest / override) for owner sign-off | Not produced |

**Result not claimed:** the dry-run sizes depend on the anchor choice and the tie-break. They show the method is workable. They are not a proposed partition.

---

## 6. Publication and database alignment

### 6.1 Three things that must agree

| # | Thing | Where it lives | Who reads it |
|---|---|---|---|
| 1 | **Cell→zone assignment** | The pinned `ConfigVersion.payload.spatial` (`loadPinnedSnapshot`, `service.js:662`). It is mirrored to `CellAssignment` rows, but **no `src/` code reads the mirror** (grep) | `hierarchy.indexMap().resolve` callers: F27 route descriptors, the index maintainer, coordinator serviceability |
| 2 | **Zones a route traverses** | Computed per round from (1) for the agent cell and stop cells | F27 `plan.route.zonesTraversed` (`f27.js:59-81`) |
| 3 | **Zones an agent is authorised in** | **Database `Zone` rows** with `regionId` = the agent's region: `prisma.zone.findMany({ where: { regionId } })` | Simulated: `agentFacts.service.js:130` → `simulatedAgentState.js:258`. Physical: `physicalFacts.js:136, 180` when `authorisation === "REGION"` |

### 6.2 Why new zone IDs without `Zone` rows break assignment [S trace; not executed]

1. A new map assigns cell *c* to `rnsit-z4`. Only `rnsit-z1` exists as a row.
2. The round resolves the stop at *c*: `zonesTraversed = ["rnsit-z4", …]` (`v1DemonstrationComposition.js:372-375`).
3. `authorisedZoneIds = ["rnsit-z1"]`, from the rows (`agentFacts.service.js:130`, `simulatedAgentState.js:258`).
4. F27: `rnsit-z4` is not authorised → **VIOLATED** (`f27.js:78-81`). F27 is Tier 0, indeterminate → DENY.
5. Every task whose agent cell or any stop cell lies in a new zone is never assigned. With option (a) in §3.5, that is **every task on campus**. The physical path behaves the same way.

The `CellAssignment` mirror would also fail: `CellAssignment.zoneId` is a foreign key to `Zone` (`schema.prisma:998-999`).

The reverse case is harmless for F27: extra `Zone` rows in the region only enlarge the authorised set.

### 6.3 Required sequence [P, based on the source above]

| Order | Act | Verified constraint |
|---|---|---|
| 0 | Owner approves the layout, IDs, tie overrides and the table (§8) | — |
| 1 | Rehearse the whole sequence on a **disposable PostgreSQL** (never Neon or :5432) | Project practice [A] |
| 2 | **Create the `Zone` rows first**, one per new ID: `regionId` = that database's `Region.id`, a unique `name` (`schema.prisma:409`), and a bbox per the Q10 decision | Rows before map, so no round sees a published zone without a row (§6.2) |
| 3 | Write `CellAssignment` mirror rows at a **new** `mapVersion` (unique on `[cellId, mapVersion]`, `schema.prisma:1011`). Keep the `mapVersion 1` rows | The bootstrap's `verify` counts `mapVersion 1` rows for `rnsit-z1` |
| 4 | Build a **complete** version: every binding of the pinned version restated (V1 execution bindings and `cutover.engine_enabled` for the region), the **same** `deliveryDomain` declaration, the new `spatial` map | A version is a complete set (`service.js:307`); an omitted `deliveryDomain` makes every geofence verdict INDETERMINATE (comment in `config.controller.js` `publishVersion`) |
| 5 | Validate: `hierarchy.validateForPublish` (not called by publish; see §6.4) and `configService.validateCandidate` | §6.4 |
| 6 | Publish with `pin: false` | HTTP publish pins by default unless `pin === false` (`config.controller.js:157`, `body.pin !== false`) |
| 7 | Verify the unpinned version: 64 cells, N zones, each anchor resolves to its zone; a dry F27 check passes for one stop per zone | — |
| 8 | Pin with `pinVersion` | The single pointer row; rounds pull-with-pin (`service.js:605`) |
| 9 | Rollback: re-pin the previous version. `Zone` rows may stay (they are a harmless superset for F27) | `pinVersion` accepts any existing version |

### 6.4 Validation and approval, as verified in source

| Check | What it enforces | What it does **not** enforce |
|---|---|---|
| **V8** (`validators.js:520`) | No zone in two regions; every zone names a region; every published fine cell has exactly one zone; at most one site | That a cell's `zoneId` is a zone **declared in the map**; that a cell's `regionId` equals its zone's region; that zones are non-empty or contiguous |
| **A6** (`validators.js:620`) | Every published cell id is a valid H3 index at its declared band (V-10) | Containment |
| **A7** (`validators.js:674`) | A present delivery-domain declaration is well formed; unattested → WARNING | Absence (passes vacuously) |
| `hierarchy.validate` / `validateForPublish` (`hierarchy.js:193, 339`) | Adds the declared-zone and region-agreement checks V8 lacks | **Has no caller in `src/` or `tools/`** (grep). It must be run explicitly before publishing |
| Regionboundary V-8/V-9 (`regionBoundary.js` `validateCover`) | Cover non-empty; cardinality band or recorded exception | **Different checks from config V8 with similar names.** Called only by `tools/routing/b1Readiness.js`, not by publish |
| **S2 two-person rule** (`service.js:79, 324, 358`) | Two distinct approver identities, **only when a Safety-class parameter value changes** against the latest version | A spatial-map change alone changes no parameter, so S2 is **not** triggered by it [S inference; not executed] |
| HTTP gate (`config.routes.js:19-23, 45-50`; `service.js:429`) | Authenticated, elevated role, **SUPER_ADMIN**, action class `SAFETY_CONFIG_CHANGE`, and a gate-verified second approver (S5 refuses without one; S4 limits `approvals[]`) | — |
| V1 bootstrap tool (`bootstrapV1Environment.js:139-147`) | Requires exactly two named, distinct human approvers | It cannot publish a multi-zone map: it hard-codes `rnsit-z1`, and it **refuses (CONFLICT)** when a version it did not publish is pinned (`:289`, `:292`) |

**Consequence:** a direct-tool publish of a spatial-only change would need no second approver, because the code would not ask for one. The owner should decide to require two named approvers anyway (Q11).

### 6.5 Interaction with the legacy bounding-box path

| `Zone` row bbox choice for the new zones | Legacy membership effect |
|---|---|
| **Degenerate `0,0,0,0`** (precedent: `Backend/prisma/seed.js:220-237`) | None. The new rows never match; `rnsit-z1`'s whole-campus box keeps matching. Legacy `zone:{id}` rooms stay campus-wide |
| **Real boxes** | `findMany` is ordered by `name` ascending and the first match wins (`zoneManager.service.js:57, 99`). A new name that sorts before "RNSIT Zone 1" takes over legacy membership for its box. Overlapping boxes resolve by name order, not by the published assignment, which contradicts ADR-28 if used as a decision input |

The audit leans to degenerate boxes, so that published-map membership (DTARO W1) is introduced on its own path and not through the legacy lookup. Q10.

### 6.6 Effect on the frozen V1 engine [S trace; not executed]

- No engine source changes.
- Engine **inputs** change in two ways:
  - F27 sees up to three zone IDs per plan instead of one. It stays satisfied if every new zone has a row (simulated agents are authorised for every zone of their region).
  - Zone-scoped configuration bindings become possible. None exist today.
- `zoneRestrictionsFor` returns `[]` for any zone (`v1DemonstrationProfile.js:163`).
- λ_zone capacity pricing is DEFERRED behind a thrown kill switch (`Backend/src/workers/registry.js:326-338`).
- Whether a configuration-only republish is inside the V1 freeze is an owner question (Q12).

---

## 7. Risks and validation checklist

### 7.1 Risks

| Risk | Effect | Mitigation [P] |
|---|---|---|
| Map pinned before `Zone` rows exist | F27 denies every affected assignment (§6.2) | Rows first (§6.3 step 2); an executed test before publishing |
| Incomplete republish (bindings or `deliveryDomain` omitted) | Engine disabled for the region, or all geofence verdicts INDETERMINATE | Build the version by copying the pinned payload; diff it against the pinned payload |
| A cell names an undeclared zone | Passes V8; `resolve` returns a zone with no declaration and no row → F27 denies | Run `validateForPublish` explicitly (§6.4) |
| A boundary that runs along a way | Membership flapping, and for DTARO, repeated zone-room joins and leaves | Step 6 path check; prefer L2/L4 over L6 |
| Map built against the wrong `Region.id` | V8 passes, but agents are in a different region → unindexed | Generate per environment from the target database's `Region.id`; verify against `indexMaintainer.regionForObservedPosition` |
| Naming over evidence (for example "Canteen zone") | Operators trust a label the map does not support | P-7; names list contents; no Library zone |
| Harnesses and fixtures assume `rnsit-z1` = whole campus | `verify:*` false failures or false passes | Update or pin them in the implementation change |
| Small fleet, few zones | Little message saving; the paper's n/Z figures do not transfer | Report measured counts only |
| Another session is writing in this checkout (see the header table) | Conflicting edits | Owner to confirm who owns `obstacleRecipientPolicyExperiment.test.js` before the next step |

### 7.2 Validation checklist (all before publication)

- [ ] Cover reproduced: 64 cells, digest `04cb64c4…` matches; 45 centre + 19 boundary.
- [ ] Table: 64 rows, each cell exactly once, each zone non-empty and contiguous.
- [ ] Every tie (dry run: 14) has an owner override with a reason.
- [ ] `hierarchy.validateForPublish(map).ok` is true.
- [ ] `configService.validateCandidate(full restated version)`: zero blocking findings. The A7 attestation WARNING is expected and recorded.
- [ ] Payload diff against the pinned version: only `spatial.zones` and `spatial.cells[].zoneId` differ.
- [ ] Every new zone ID has a `Zone` row in the target region before publish; names are unique; the bbox policy is applied.
- [ ] An offline F27 test with a multi-zone map:
  - **without** rows → VIOLATED;
  - **with** rows → SATISFIED;
  - route endpoints in three different zones → SATISFIED.
- [ ] Resolution unchanged: for every one of the 64 cells, `regionId` and `assigned` are identical before and after.
- [ ] Path check: transitions per permitted way reported; no boundary runs along a way.
- [ ] Rehearsed on a disposable PostgreSQL: publish (`pin:false`), verify, pin, assign one task per zone, roll back by re-pin.
- [ ] Assignment regression green: the focused suites in IMPLEMENTATION_READINESS §5.2, plus `verify:v1CorePath` against the disposable database.

---

## 8. Owner approval questions

| # | Question | Options found | Audit view (not a decision) |
|---|---|---|---|
| Q1 | Which layout? | L2 / **L4** / L6 (§3.4) | L4 gives every evidenced destination a home without building-level splits |
| Q2 | Zone IDs, and the fate of `rnsit-z1` | (a) retire from the map, new `rnsit-z2…z5`; (b) keep `rnsit-z1` as one area; or a semantic ID scheme | (a) avoids a silent change of meaning |
| Q3 | Who owns the 14 tied cells, the central pitch cells, the Basketball Court, RNS International School and Playground 2? | Owner override list (§5 step 4) | Needs the generator output to review |
| Q4 | Library | Supply a location (site check), or drop it | Cannot be proposed without a location |
| Q5 | Canteen | North (`way/204638928`), south (`way/1486312655`), or both, with confirmed labels | Both exist; they fall in different areas |
| Q6 | Playground | Central pitch, Playground 2, Basketball Court, or none | None is a robot destination today |
| Q7 | PU College | Confirm the point on site; is there a building? | UNVERIFIED |
| Q8 | Canara Bank | Point/node location vs the building 53.5 m away | Matters for which cell anchors `rnsit-z3` |
| Q9 | Boundary cells | Accept "same rule, index-only" for the 19 boundary cells | Consistent with D6 |
| Q10 | `Zone` row bbox policy | Degenerate (no legacy effect) vs real boxes (§6.5) | Degenerate |
| Q11 | Publication vehicle and approvers | A new reviewed tool, or HTTP publish; require two named approvers even though S2 does not fire for a spatial-only change | Two named approvers, like the bootstrap |
| Q12 | Is a configuration-only republish within the V1 freeze? Which environment first? | LOCAL (Docker :5433) after a disposable rehearsal; Neon only by explicit later approval | — |

---

## 9. Recommended next step after approval, and the DTARO boundary

### 9.1 Immediately after approval [P]

1. **Generator and review artefact (no database, no publish).** A deterministic tool, in the style of `Backend/tools/campus/generateAccessCandidates.js`, that applies §5 to the approved anchors and overrides and writes the dated 64-row table.
2. **Offline tests** for every §7.2 item that needs no database:
   - `validateForPublish`;
   - `validateCandidate` with a restated payload;
   - the F27 with/without-rows cases;
   - resolution-unchanged;
   - contiguity;
   - path transitions.

   Each test must be shown to fail on a broken map before it is trusted.
3. **Disposable-PostgreSQL rehearsal** of §6.3.
4. Then, by separate approval, the publish to LOCAL.

### 9.2 What comes after the map (not started; scope only)

Once a multi-zone map is approved, the intended next work is limited to **cooperative obstacle awareness**:

- deterministic, reproducible simulated world obstacles;
- simulated robots reporting them over their **existing** Socket.IO connections;
- backend validation and storage;
- zone resolution through the **published map** (`cellForPoint` → `indexMap().resolve`), never bounding boxes;
- zone-room membership, including boundary crossings and reconnects;
- alert delivery to relevant simulated robots;
- receiver-side route-relevance and safe-response tests.

**None of this is implemented in this step.**

- **The recipient policy is not chosen here.** OD-2 stays open. Measuring recipient policies is a separate activity from this zone map; this document neither depends on it nor feeds it.
- **Authoritative rerouting is deferred.** It needs a separate, future owner authorisation covering a fenced engine `REROUTE` producer and an outboxed corridor update (DTARO_OBSTACLE_POLICY_DECISIONS A-5, OD-3).
- No allocation, candidate selection, pricing, feasibility, commit/fence, offer, outbox, route or completion-verification change is proposed. The retired DTARO allocator stays retired (`gate:legacy`).

---

## 10. Claims not verified here

- Deployed database contents in every environment.
- The §6.2 failure and the §6.6 neutrality: traced through source, **not executed**.
- S2 not firing for a spatial-only change: read from `safetyClassChanges`, **not executed**.
- Site facts: every OSM footprint, every UNVERIFIED supplemental point, and the robot-usability of every way. Only the 18 department access points are site-verified.
- Each agent class's `permissionSet.roadClasses`. §2.3 used the access register's recorded classes.
- Whether the dry-run zones are contiguous (§5 step 5 was not run).

---

## Appendix A. Reproduction (documentation only; not part of the application)

Four read-only Node scripts (evidence, dry-run partition, a per-cell variant of it, approach ways) were run from the session scratchpad with the repository root as their only argument. They read `rnsit-campus-osm.geojson`, `rnsit-campus-supplemental.geojson` and `rnsit-campus-access-candidates.geojson`, use `Backend/node_modules/h3-js`, and write nothing. `git status` was unchanged by them.

<details>
<summary>Core of the evidence script (cover, footprint cells, shared cells)</summary>

```js
const h3 = require(path.join(ROOT, "Backend/node_modules/h3-js"));
const osm = JSON.parse(fs.readFileSync(path.join(ROOT, "rnsit-campus-osm.geojson")));
const boundary = osm.features.find((f) => f.id === "way/1120154292").geometry;
const OVERLAP = h3.POLYGON_TO_CELLS_FLAGS.containmentOverlapping;
const cover = new Set(h3.polygonToCellsExperimental(boundary.coordinates, 11, OVERLAP, true)); // 64
const centre = new Set(h3.polygonToCells(boundary.coordinates, 11, true));                     // 45
// footprint cells: polygonToCellsExperimental(footprint, 11, OVERLAP, true) ∩ cover
// point cells: h3.latLngToCell(lat, lon, 11)
// network cells: every 2 m along footway/path/service segments inside the boundary
// shared cell: a cover cell overlapped by ≥ 2 destination footprints
```
</details>

<details>
<summary>Dry-run partition (illustrative; ties broken by label order)</summary>

```js
const ANCHORS = {
  A: [...apCells("CSE, ISE & CSDS Department"), ...apCells("ECE Department"), ...apCells("RNSIT Civil and AIML Block")],
  B: [cellOf(sup["rnsit-canara-bank"]), ...fpCells("way/204638928"), ...fpCells("way/204638937")],
  C: [...apCells("RNSIT Mec and EEE Department"), ...apCells("RNSIT MBA block")],
  D: [cellOf(sup["rnsit-innovation-center"]), cellOf(sup["rnsit-pre-university-college"]),
      cellOf(sup["rnsit-food-court"]), ...fpCells("way/1224937859")],
};
// each cover cell → zone with the minimum h3.gridDistance to any of its anchors
// observed: anchor conflicts 0; ties 14; sizes A 17, B 10, C 10, D 27
```
</details>
