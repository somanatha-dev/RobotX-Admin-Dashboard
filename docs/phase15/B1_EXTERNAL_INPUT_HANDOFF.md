# B1 — EXTERNAL INPUT PACKAGE AND EXECUTION READINESS

**The single source of truth for what humans must supply before B1 execution can begin.**

> This document does **not** unblock B1, does not implement B1, and does not begin B1.
> It states exactly what must arrive from outside this repository, in what form, from whom,
> validated by what, and in what order it is consumed.

| | |
|---|---|
| **Written** | 2026-08-29 |
| **Last synchronised** | 2026-08-30 — documentation-only synchronisation of the D1 owner-decision session. **No status changed**; §1.8 was added (owner declarations, the JSSATE snapshot, the V-8 finding, the standing refusals, the undefined escalation target) and §1.1 gained a narrow declaration cross-reference. Previously 2026-08-29 — see §10.2 |
| **Branch / HEAD** | `feature/dashboard` · **`9e1d871`** *(2026-09-01, the X7 pass)* · **no application source modified by any commit since `7335260`** — the four since it (`ef0d65f`, `22411e8`, `09e91a5`, `9e1d871`) touch only `docs/` and `formal/`, both outside the source-digest scope, so **the digest below is unmoved** *(this row said `7335260`, and before that "`67b7c7c` · working tree NOT clean", and before that "working tree clean". It has now been stale four times, and the digest row below is the one that has not)* |
| **Source digest verified live** | **`4d94ef18e52b59532837d86fc34ac12f496251f446226693def982070a0e2ab5` (574 files)** — measured live 2026-09-01. *(`d033038cb261c3de…` / 573 and `431010ace188c4b1…` / 565 are both **superseded**. T1-04, V-10 and now the V1 audit each changed files inside the digest scope.)* **Nothing this handoff cites moved with it**: `b1Readiness.js`, `regionBoundary.js`, `mobilityModel.js` and `tools/routing/adapters/` are all untouched, and `npm run routing:readiness` was re-run on the new tree — **D1, D3 and D8 all still BLOCKED, OVERALL BLOCKED, exit 0** |
| **V1 boundary** | **A V1 contract and a finite V1 stop condition now exist**, and they are **not** this handoff's subject. See **[`../v1/V1_CONTRACT_AND_STOP_CONDITION.md`](../v1/V1_CONTRACT_AND_STOP_CONDITION.md)** §F.1, which answers what B1 V1 actually needs (**four values**: a `route(parts)` source, a `travelSdSeconds` source, a per-profile `speedMetresPerSecond`, and `candidate.max_radius_by_sla_class`) and what is strictly production and therefore V2 (**Steps 1/3/4/5, the selection ADR, all of D8, and D1's governance sign-off, cover and charger estate**). **Nothing in this handoff is weakened by that split**, and a V1 traversal source **does not discharge B1, close `engine_decision_path_wired`, or make any Step 3 evidence admissible** |
| **Verified by** | `node -e "require('./tools/release/sourceDigest.js').sourceDigest()"` from `Backend/` |
| **Does the digest move affect this handoff?** | **No.** Nothing D1, D3, D8 or B-M requires changed, no validator moved, and **B1 is still BLOCKED — EXTERNAL** on the same three decisions. The digest is recorded here only so a reader can tell which tree the file/line citations below were read against |
| **Phase 15 implementation** | **CLOSED** |
| **Release** | **BLOCKED** — 8 of 24 blocking §24 gates not green |
| **B1** | **BLOCKED — EXTERNAL.** D1 BLOCKED · D3 BLOCKED · D8 BLOCKED |
| **B1 steps** | Step 2 **PASS**; Steps 1, 3, 4, 5 **BLOCKED** |
| **Engine selected** | **NONE.** No engine is selected, ranked, recommended or hinted at anywhere in this document |
| **B-M (TLC)** | **NOT MEASURED / OPEN.** An **independent release-evidence item, not a B1 sub-step** — see §7. It neither blocks nor is blocked by D1, D3, D8 or any B1 step |

**Authority order for this document** — where it and another source disagree, resolve in this order:

1. `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` (FROZEN)
2. `IMPLEMENTATION_EXECUTION_PLAN.md`
3. **The actual current repository** — the validators named below are the binding contract
4. `docs/phase15/PHASE_15_MASTER.md` and the other four canonical Phase 15 documents
5. This document

If a field name here and the validator disagree, **the validator wins and this document is
defective**. Every field below was read out of the source on 2026-08-29 and the file and line are
given so that claim is checkable rather than asserted.

---

## 0. The contract in one page

There is exactly **one** input seam. It is an environment variable naming **one CommonJS module the
operator writes**:

```
ROUTING_B1_DEPLOYMENT=/absolute/path/to/b1Deployment.js
```

Declared at [`deployment.js:48`](../../Backend/tools/routing/adapters/deployment.js#L48); loaded by
`loadDeployment()` at [`deployment.js:56-80`](../../Backend/tools/routing/adapters/deployment.js#L56-L80).

That one module carries **four independent blocks**:

| Block | Decision | Owner | Consumed by |
|---|---|---|---|
| `region`, `cover`, `chargers`, `regions?` | **D1** | Operations + Commercial | `b1Readiness.assessD1` → `src/engine/spatial/regionBoundary.js` |
| `mobility[]` | **D3** | Product + Fleet Engineering | `b1Readiness.assessD3` → `src/engine/domain/mobilityModel.js` |
| `extract` | **D8** | Operations | `b1Readiness.assessD8` → `regionBoundary.validateExtractMargin` (V-13) |
| `osrm`, `valhalla`, `graphhopper` | Step 1 deployment facts | whoever performs Step 1 | `tools/routing/adapters/contract.js` `normaliseConfig` |

**With `ROUTING_B1_DEPLOYMENT` unset, `loadDeployment` returns `ok: false` and `assess()` passes
`config = null` into all three assessors** ([`b1Readiness.js:716-719`](../../Backend/tools/routing/b1Readiness.js#L716-L719)).
That is the current state: D1, D3 and D8 all report `BLOCKED`, which is *neither* a failure *nor* a
pass — it is the absence of a decision.

### 0.1 A property of the tool the next session must know before it runs it

**`npm run routing:readiness` can never print `OVERALL: PASS`, and it always exits 0.**

- Step 5's status is the literal constant `READINESS.BLOCKED`
  ([`b1Readiness.js:675-683`](../../Backend/tools/routing/b1Readiness.js#L675-L683)) — by design:
  *"§6.1 makes B1 a decision, not a benchmark result"*, so the tool refuses to compute a selection.
- `overall` is `BLOCKED` whenever any step is `BLOCKED`
  ([`b1Readiness.js:732-733`](../../Backend/tools/routing/b1Readiness.js#L732-L733)), so Step 5 pins
  it there permanently.
- `main()` returns 0 unconditionally ([`b1Readiness.js:808-816`](../../Backend/tools/routing/b1Readiness.js#L808-L816)),
  because *"a command that exits 0 is read as a green one"* was the failure to avoid, and making a
  missing decision a build failure would only teach people to stop running it.

**Therefore: do NOT treat `OVERALL` or the exit code as B1's progress signal.** The signals that
actually move are, in `--json`:

| Field | What it means when it moves |
|---|---|
| `decisions.D1.status` | `BLOCKED` → `PASS` — D1 arrived and validates end-to-end |
| `decisions.D3.status` | `BLOCKED` → `PASS` — D3 arrived and every model is routable and distinctly keyed |
| `decisions.D8.status` | `BLOCKED` → `PASS` — D8 arrived, V-13 ran, and the extract is not stale |
| `steps[0].status` | `BLOCKED` → `NOT_CONFIGURED` (D1+D3 in, nothing deployed) → `NOT_MEASURED` (a candidate is AVAILABLE) |
| `steps[2].status` | `BLOCKED` → `NOT_MEASURED` |
| `steps[3].status` | `BLOCKED` → `NOT_MEASURED` |
| `stepEvidenceAdmissible` | `false` → `true` — **only then may a benchmark run be quoted as Step 3 evidence** |

`stepEvidenceAdmissible` is `(steps[0].status ∈ {NOT_MEASURED, PASS}) && steps[2].status !== BLOCKED`
([`b1Readiness.js:761-762`](../../Backend/tools/routing/b1Readiness.js#L761-L762)).

**Nothing in this section is a defect to be fixed.** It is the tool's stated contract, and a session
that "fixed" it to reach `PASS` would be manufacturing the exact false green the whole programme
exists to prevent.

---

## 1. PART 1 — D1 HANDOFF: the authoritative operating region

**Owner: Operations + Commercial.**
**Validator: [`src/engine/spatial/regionBoundary.js`](../../Backend/src/engine/spatial/regionBoundary.js), driven by `b1Readiness.assessD1` ([`b1Readiness.js:145-281`](../../Backend/tools/routing/b1Readiness.js#L145-L281)).**

### 1.1 What is forbidden as D1 data — read this first

| Do NOT use | Why | Evidence |
|---|---|---|
| **`RGN-BLR`** | It is a Phase 2 §3.6 **containment demonstration**, never a published configuration version. One region, two zones, one site, **five** cell assignments, all at `mapVersion: 0` | `Backend/prisma/seed.js:31-45` |
| **`SEED_SPATIAL_MAP`** | Same object. Its cell ids are `cell-rrnagar-fine-01`, `cell-rnsit-fine-01`, … — **opaque placeholder tokens, not H3 indices.** V-10 refuses every one of them by name (`"a map of placeholder tokens can no longer be published as an operating region"`) | `seed.js:38-44`; `regionBoundary.js:505-511` |
| **The campus GeoJSON files** | `Frontend/src/features/maps/campus/data/**/*.geojson` and the three copies at the repository root are **frontend map demo data**. They carry no `regionId`, no `kind`, no declared CRS, no `version`, no `versionDate`, and no commercial commitment | 6 files, verified present 2026-08-29 |

> **Narrow exception recorded 2026-08-30, and it does not widen this row.** The project owner has
> since made the §1.2 declaration for **two named features inside two of these files** —
> `way/106873634` (JSSATE) and `way/1120154292` (RNSIT) — supplying the `regionId`, `kind`, `crs`,
> `version` and `versionDate` this row says are absent. §1.8 records those declarations. **The files
> themselves remain forbidden as D1 data**, the other 46 JSSATE features and 56 RNSIT features are
> explicitly excluded, and no undeclared feature in any of the six files becomes admissible because
> of this. A declaration covers a named geometry, never a file.
| **Zone bounding boxes in the database** | Deliberately degenerate — `minLat/maxLat/minLon/maxLon` all `0`, written because the legacy column is `NOT NULL`. `seed.js:223-230` states outright *"these bounds are never read by the engine"* | `seed.js:223-230` |

### 1.2 Mechanically derivable vs. requires human declaration

This distinction is the point of §1.1, and it must never be collapsed.

| Quantity | Mechanically derivable? | Still requires human declaration/approval? |
|---|---|---|
| A polygon's *coordinate array* | **Yes** — a `.geojson` file can be read by any tool | **YES.** A geometry extracted from a demo file is not a *serviceable boundary*. The boundary is a **commercial commitment** (what we commit to serve) intersected with an **operations judgement** (what we can operate). Extraction produces coordinates; it does not produce that decision |
| `bbox` of a validated geometry | **Yes** — `regionBoundary.boundingBoxOf()` derives it from the polygons, and it is explicitly *"a derivation from a supplied geometry, not a declaration"* (`regionBoundary.js:413-439`) | No — but it exists only once a *declared* geometry exists |
| `crs` | **No.** §4.1 rule 3 forbids inferring it. An omitted CRS is a rejection, never an assumed `EPSG:4326` | **YES** — whoever authored the file states it |
| `kind` | **No** | **YES** — Operations, from §3.5's four |
| `regionId`, `name`, `version`, `versionDate` | **No** | **YES** |
| `cover.fineCells` / `coarseCells` | **Partly** — a polygon→H3 cover is computable, but **this repository refuses to write that utility** while D1 is open: *"it would have no input, and its only test data would be invented geometry"* (`regionBoundary.js:22-25`). The cover is **validated here, never computed here** | **YES** — Engineering derives it from the *approved* boundary, and Operations approves the boundary first |
| `chargers[]` | **No** | **YES** — Operations / Charging, from the real charger estate |

**The rule:** a geometry may be *transcribed* from an existing file only if a named human in
Operations + Commercial declares that file to be the authoritative serviceable boundary and signs the
`version` / `versionDate` that pins it. Absent that declaration, extracting it is **promoting demo
data**, and it is forbidden. There is no automated check that can tell the two apart — that is
precisely why it is a human sign-off.

### 1.3 `region` — the five fields of §36.3.1

Validated by `validateRegionDeclaration` ([`regionBoundary.js:317-411`](../../Backend/src/engine/spatial/regionBoundary.js#L317-L411)).

| # | Field | Type | Allowed values / range | Source | Owner | Validator | Missing → | Malformed → | Derivable? |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `regionId` | string | Non-empty; **must equal its own `.trim()`** — *"a key that differs from its own trimmed form is two keys"* | Human | Operations | V-7, `regionBoundary.js:340-344` | `INVALID` → D1 **FAIL** | `INVALID` | **No** |
| 1 | `name` | string | Non-empty. The human-readable name the commercial commitment is written against | Human | Commercial confirms | `regionBoundary.js:345` | `INVALID` | `INVALID` | **No** |
| 2 | `kind` | string | Exactly one of `SITE`, `CAMPUS`, `DEPOT_CATCHMENT`, `METRO_SERVICE_AREA` (§3.5's four, `regionBoundary.js:70-77`) | Human | Operations | `regionBoundary.js:348-354` | `INVALID` | `INVALID` — a fifth value is refused | **No** |
| 3 | `boundary` | GeoJSON object | `{ type: "Polygon" \| "MultiPolygon", coordinates: … }`. Only areal geometry — Point, LineString and GeometryCollection are refused (`regionBoundary.js:395-401`) | Human | Commercial + Operations, **one** geometry | V-1…V-5, `regionBoundary.js:380-401` | `INVALID` | `INVALID` | Coordinates yes, **the decision no** — §1.2 |
| 4 | `crs` | string | Case-insensitive, trimmed, one of `EPSG:4326`, `OGC:CRS84`, `CRS84`, `URN:OGC:DEF:CRS:OGC::CRS84`, `WGS84` (`regionBoundary.js:88`) | Human | The file's author | V-6, `regionBoundary.js:357-370` | `INVALID` — **never assumed** | `INVALID`. Reprojection is the authoring side's to perform and record; it is deliberately not performed here | **No** |
| 5 | `version` | string | Non-empty, **immutable label** — so a re-cut extract and a re-derived cover can name the geometry they came from | Human | Operations | `regionBoundary.js:373-375` | `INVALID` | `INVALID` | **No** |
| 5 | `versionDate` | string | ISO calendar date `YYYY-MM-DD`, **real-calendar valid** — `2026-02-31` matches the shape and is refused (`regionBoundary.js:119-124`) | Human | Operations | `regionBoundary.js:376-378` | `INVALID` | `INVALID` | **No** |

**Geometry checks applied to `boundary` (V-1 … V-5)** — `regionBoundary.js:145-308`:

| Check | Rule | Refusal reason |
|---|---|---|
| V-1 | `coordinates` is a non-empty array of linear rings; MultiPolygon's is a non-empty array of those | A cover cannot be cut from a non-areal geometry |
| V-2 | Each ring has **≥ 4 positions** and is **closed** (first position === last), per RFC 7946 | Structural |
| V-5 | Each position is `[lon, lat]`, both finite; `lat ∈ [-90, 90]`; `lon ∈ [-180, 180]` | A second element outside ±90° **cannot** be a latitude → the file is `[lat, lon]` or projected-read-as-degrees. **It is refused, never re-ordered:** *"a re-ordered or reprojected geometry is a new authoritative file from its author, not an adjustment made by the consumer"* |
| V-3 | No non-adjacent segment pair crosses; collinear doubling-back also refused. Runs **before** V-4 deliberately | A self-intersecting ring has no well-defined interior, so a cover derived from it is undefined rather than approximate |
| V-4 | Signed (shoelace) ring area ≠ 0 | §3.6 keys a region's pricing surface to its cell set; a region enclosing nothing has none |

> **Honest gap, recorded not hidden:** `contract.isPlaceholder` is **deliberately not applied** to
> `regionId`, `name` or `version` (`contract.js:194-197`). A region literally named `"TBD"` would pass
> V-7. That is a stated scoping decision, not an oversight — do not "fix" it, and do **not** rely on
> the validator to catch a placeholder identifier. **A human must read the declaration.**

### 1.4 `cover` — the cell cover derived from the approved boundary

Validated by `validateCover` ([`regionBoundary.js:533-581`](../../Backend/src/engine/spatial/regionBoundary.js#L533-L581)).
**Supplied, never computed** (§1.2).

| Field | Type | Rule | Owner | Validator |
|---|---|---|---|---|
| `fineCells` | array | **V-8** — must be non-empty. **V-9** — cardinality must sit in §3.6's band **1 000 – 100 000**, or `cardinalityException` must be supplied. **V-10** — each entry checked below | Engineering, from the **approved** boundary | `regionBoundary.js:548-566` |
| `coarseCells` | array | **V-10** at the coarse resolution | Engineering | `regionBoundary.js:572-574` |
| `cardinalityException` | string, optional | Required **only** when `fineCells.length` is outside 1 000–100 000. Must be a non-empty string stating *why* | Human — Architecture/Operations | `regionBoundary.js:556-566` |

**V-10, per cell entry** (`validateCellIdentity`, `regionBoundary.js:479-521`):

| Entry field | Rule |
|---|---|
| `cellId` | Default (no `indexing` declared) → treated as **H3** and must be a **valid H3 index at the expected resolution**: fine → **H3 resolution 8**, coarse → **H3 resolution 5** (`cells.js:181-184`). A wrong-resolution index *"silently changes the cache key space (§20.3) and the k-ring distance bounds (§6.3)"* |
| `indexing` | Optional. If present must be `H3` or `SITE_LOCAL_GRAPH_ZONE` (`regionBoundary.js:457-464`). Any other value is refused |
| `siteId` | **Required** when `indexing === "SITE_LOCAL_GRAPH_ZONE"` — §6.2's indoor / multi-level carve-out is *site-local*, and a token claiming it without a site *"cannot be told apart from a fabricated cell id"* (N21) |

> **Field-name discrepancy, recorded:** `b1Readiness.js`'s seam docstring writes a fine cell as
> `{ cellId, zoneId, siteId? }` ([`b1Readiness.js:47`](../../Backend/tools/routing/b1Readiness.js#L47)),
> but **no validator reads `zoneId`** — `validateCellIdentity` reads `cellId`, `indexing` and `siteId`
> only, and `validateChargerContainment` reads `cellId` only. Supplying `zoneId` is harmless and is
> consistent with §3.6's zone membership; **relying on it being validated is not.** Zone membership is
> checked elsewhere (`spatial/hierarchy.js`, the Config Service V8 check), not by the B1 readiness path.

**D2's residual (N23)** rides on D1's verdict but is **not charged to it**
([`b1Readiness.js:260-268`](../../Backend/tools/routing/b1Readiness.js#L260-L268)). Once `kind` and a
cover exist, `d2ResidualCheck` reports whether `fineCells.length` sits in the 1 000–100 000 band for
that kind. **If it does not, the answer is Architecture's, not Operations'** — do not send it back to
the people who supplied a valid boundary, and do not change any resolution to make it fit.

### 1.5 `chargers[]` — V-12 containment

Validated by `validateChargerContainment` ([`regionBoundary.js:848-885`](../../Backend/src/engine/spatial/regionBoundary.js#L848-L885)),
called **unconditionally** ([`b1Readiness.js:259`](../../Backend/tools/routing/b1Readiness.js#L259)).

| Field | Type | Rule | Owner |
|---|---|---|---|
| `chargers` | array | **Required, not optional.** The seam writes `regions?` and `cardinalityException?` with a question mark; `chargers` carries none. An absent or wrongly-typed `chargers` makes V-12 report `NOT_CONFIGURED`, whose problem is folded into D1 → **D1 FAILs** | Operations / Charging |
| `chargers[].chargerId` | string | Non-empty | Operations / Charging |
| `chargers[].cellId` | string | Non-empty **and present in `cover.fineCells ∪ cover.coarseCells`** | Operations / Charging |

Why it is strict: §14.5's return leg would otherwise route to a destination outside the region's
routing graph — *"an unreachable fallback is worse than a missing one, because it is selected before
it fails"*.

### 1.6 `regions[]` — optional additional region declarations (V-11)

| Field | Type | Rule |
|---|---|---|
| `regions` | array, **optional** | Carries the **OTHER** regions this deployment operates, for the disjointness comparison. **Omit the key entirely if there are none** — a value that is present and not an array is a *wrong answer*, not an absence, and is refused ([`b1Readiness.js:215-222`](../../Backend/tools/routing/b1Readiness.js#L215-L222)) |

Rules, all enforced in `assessD1`:

- The **region under assessment is always the first member** of the comparison set
  ([`b1Readiness.js:247`](../../Backend/tools/routing/b1Readiness.js#L247)). Do not add it to `regions[]`.
- An entry that **re-declares the primary's `regionId`** is reported as a duplicate — §3.5 makes
  region → shard a function, so one id naming two declarations is ill-formed.
- An entry that does **not validate** is **reported, never dropped** (R-1,
  [`b1Readiness.js:224-237`](../../Backend/tools/routing/b1Readiness.js#L224-L237)). A `null`, a bare
  string, a three-position ring — each is named with its index.
- **Overlap means shared *area*.** Regions meeting along an edge or at a corner are **disjoint and
  accepted** — adjacent operating regions are the ordinary case (R-2, `regionBoundary.js:767-779`).
- **No tolerance.** Every comparison is exact. How close two boundaries may be drawn is a geographic
  decision this module holds no authority to make.

### 1.7 D1 status transitions

| Condition | `decisions.D1.status` |
|---|---|
| `region` absent (`null`/`undefined`) | **`BLOCKED`** ← current state |
| `region` supplied and fails V-1…V-7 | **`FAIL`** — *"somebody answered, and the answer is unusable"*. A different message to a different person than `BLOCKED` |
| `region` valid, but cover / chargers / `regions[]` / V-11 / V-12 produce any problem | **`FAIL`** |
| Every check clean | **`PASS`** |

### 1.8 D1 owner decisions received 2026-08-30 — and the V-8 finding that blocks the cover

**D1 remains `BLOCKED`.** This section records what the project owner has actually declared, what
was measured from it, and the one architectural question that stopped the work. **Nothing here is a
`PASS`**, and none of it may be read as B1 readiness or release readiness.

#### 1.8.1 Scope and region model

**Two independent regions**, owner decision, with **per-region clearance** — JSSATE may clear D1
independently of RNSIT. Consequence under §1.6: `assessD1` validates **one** primary region, and
`regions[]` is disjointness-only (no cover, no chargers). Two regions therefore means **two
deployment modules**, and a JSSATE-primary module must **omit the `regions` key entirely** while
RNSIT has no admissible geometry.

| Field | `rnsit-bengaluru` | `jssate-bengaluru` |
|---|---|---|
| `name` | RNSIT Bengaluru Campus | JSSATE Bengaluru Campus |
| `kind` | `CAMPUS` | `CAMPUS` |
| `crs` | `OGC:CRS84` | `OGC:CRS84` |
| `version` | `rnsit-boundary-v1` | `jssate-boundary-v1` |
| `versionDate` | `2026-08-30` | `2026-08-30` |
| Environment | `OUTDOOR` | `OUTDOOR` |
| ADR-33 traversal domain | `SIDEWALK_GRAPH` | `SIDEWALK_GRAPH` |
| `ROAD_GRAPH` | **Deliberately excluded** | **Deliberately excluded** |
| Production chargers | **NONE currently exist** | **NONE currently exist** |

`versionDate` is the **owner-declared** date. It is not a file timestamp, a git date, or an export
timestamp, and §3.2 rule 1's prohibition applies here exactly as it does to `extract.vintage`.

**Chargers are an answered field whose value is empty**, not an unanswered one. The owner states
explicitly that no production chargers exist at either campus, and that no ids or locations are to
be inferred from OSM, repository, demo or test data. Note the mechanical consequence: `chargers: []`
is an array, so `validateChargerContainment` iterates zero times and V-12 returns `VALID`
(`regionBoundary.js:848-885`). **A D1 `PASS` reached with an empty catalogue is not evidence that a
charger estate exists**, and §14.5's return leg would have no population.

#### 1.8.2 Boundaries — what is adopted

| | RNSIT | JSSATE |
|---|---|---|
| Adopted feature | `way/1120154292`, **exact geometry** | `way/106873634`, **exact geometry** |
| Excluded | The 56 other features in the source collection | The 46 other features in the source collection |
| Snapshot artefact | **DOES NOT EXIST — required before D1 evidence** | **EXISTS** (below) |

No buffering, simplification, snapping, repair, rounding, coordinate reordering or reprojection is
authorised for either geometry. V-5's rule governs: a re-ordered or reprojected geometry is a new
authoritative file from its author, never an adjustment made by the consumer.

**RNSIT — recorded in full elsewhere; not restated here.**
[`docs/release-decisions/RD-2026-08-30-01-rnsit-serviceable-boundary.md`](../release-decisions/RD-2026-08-30-01-rnsit-serviceable-boundary.md)
is the authoritative record of the RNSIT boundary decision: `way/1120154292` adopted exactly, the
manually extended boundary **withdrawn in full**, the supplemental-point discrepancy resolved as
**Option 1** (the polygon is authoritative), and the **main gate outside the serviceable routing
boundary**, measured 33.4 m beyond the perimeter. That record also carries RNSIT's own evidence
gaps (GAP-1…GAP-5), including that the parking lot's exclusion rests on 0.7 m and that no mapped
gate or entrance now lies inside the serviceable area. **Do not duplicate it here.**

What that record explicitly leaves to D1: **RNSIT still requires an admissible external
snapshot/evidence artefact.** It has not been created, and no path or hash for it exists. RD-2026-08-30-01
§7 states the four independent reasons the tracked GeoJSON is not itself external supply.

**JSSATE snapshot — created and verified 2026-08-30:**

```
C:\ProgramData\robotx\evidence\jssate-bengaluru-boundary-v1.geojson
SHA-256  b774cf1bfbfa98cf7eb0853b277e4245bf483f56e2fe54d5ae693ae822b1cb66
```

One feature, geometry verified identical to the owner-confirmed source, all 36 coordinate literals
preserved, stored outside the source-digest scope per §4.1. **The upstream OSM revision is NOT
pinned** — overpass-turbo emitted no per-feature version, and the collection's `timestamp` is
**export/provenance metadata that must never be represented as an upstream OSM revision**. The
snapshot's own SHA-256 is currently the only pin on that geometry.

**The snapshot does not resolve the spatial-model question in §1.8.3.** It pins a geometry; it
decides nothing about how that geometry is covered.

#### 1.8.3 The V-8 finding — measured, and it is not §1.4's V-9 problem

Derived from the pinned JSSATE snapshot with `h3-js@4.5.0`, at the resolutions `cells.js:181-184`
fixes as `@structural B5`. **No resolution was changed.**

| Quantity | Measured |
|---|---|
| Approved JSSATE polygon area | **0.1022 km²** |
| Average H3 res-8 cell area | **0.7373 km²** |
| Standard `polygonToCells`, res 8 | **0 cells** |
| Standard `polygonToCells`, res 5 | **0 cells** |

The approved region is roughly **one seventh of a single fine cell**, so no res-8 cell centre falls
inside it. **V-8 fires** (`regionBoundary.js:548-553`), and the cover is `INVALID` → D1 **FAIL**.

**V-8 is not rescued by `cover.cardinalityException`.** The exception is read only inside the V-9
branch, which is itself guarded by `fineCells.length > 0` (`regionBoundary.js:556-566`). On an
empty cover V-9 never runs and the exception is never consulted. **There is no V-8 exception
mechanism.** §1.4's cardinality band is therefore not the binding constraint here, and treating
this as a V-9 problem is the specific misreading to avoid.

**Recorded as measured fact, not as options to pick from:**

| Containment semantics | res 8 | Geographic consequence |
|---|---|---|
| `containmentOverlapping` | **1 cell** — `886014513dfffff` | ≈**86%** of the assigned cell lies **outside** the approved campus |
| `containmentOverlappingBbox` | **7 cells** | ≈**50×** the approved campus area |

Coarse res-5 is stable at `85601453fffffff` under every non-empty path, including the repository's
own `cellToParent` relation (`cells.js:279`).

**Why the question exists at all:** this repository has never chosen a polygon→H3 containment
semantics. `polygonToCells` appears **nowhere** in `Backend/src` — §1.2's refusal to write a cover
utility left the containment mode undefined rather than defaulted.

#### 1.8.4 Standing owner decisions and refusals — do not overturn by inference

1. **V-9 / D2 mechanism = `cover.cardinalityException`** (not a resolution change, and not a
   per-region resolution override). Reason: the campuses are intentionally small bounded
   deployments and the generic envelope does not represent their physical scale. **This decision
   governs an out-of-band *count*. It is not an answer to whether a count should exist at all.**
2. **`containmentOverlapping` is REFUSED. `containmentOverlappingBbox` is REFUSED.** The owner does
   not authorise geographic over-assignment of non-campus area into a RobotX region. This is a
   **standing refusal, not an unfilled blank.** A later session that selects `containmentOverlapping`
   because it yields a non-empty cover is overturning a recorded decision, and a mode chosen for
   validator success is the check answering itself.
3. **The standard empty result is not acceptable either** — it fails V-8.
4. **The coverage-semantics question is `D — NOT DECIDED / ESCALATE`.** E6 is **BLOCKED**; E7 (the
   `cardinalityException` text) is **BLOCKED** because no accepted fine-cell count exists.

#### 1.8.5 Escalation target — NOT DEFINED

**There is currently no separate Architecture, Commercial, product-governance or approval authority
established for RobotX that can independently resolve the spatial-model question.** The escalation
is **OPEN with no target.**

- **Do not invent one**, and do not infer one from git ownership, commit authorship, repository
  structure, project structure or job titles.
- The current Architecture decision owner is **explicitly not** an independent escalation target
  for this issue, being the same person who raised the escalation.
- No approval record, no Commercial confirmation and no Architecture approval record exists for any
  of §1.8. All three are **declared absences**, recorded as such, and none may be manufactured.
  §5's D1.1 — *"a signed declaration naming the geometry, its `version` and `versionDate"* — is
  therefore **not yet discharged**, and no validator can discharge it: §1.3 records that
  `isPlaceholder` is not applied to `regionId`, `name` or `version`, so **a human must read the
  declaration.**

**D1 is consequently blocked on a governance vacuum, not on missing evidence.** Nothing in this
repository, its tooling, or the passage of time resolves it.

#### 1.8.6 What this does not touch

**D3 and B-M are not behind this escalation.** D3 blocks Step 1 independently of D1
(`b1Readiness.js:288-292`) and is unaffected by the spatial-model question. §7's B-M remains an
independent release-evidence item that neither blocks nor is blocked by D1, D3, D8 or any B1 step.

---

## 2. PART 2 — D3 HANDOFF: agent classes and mobility models

**Owner: Product + Fleet Engineering.**
**Validator: [`src/engine/domain/mobilityModel.js`](../../Backend/src/engine/domain/mobilityModel.js), driven by `b1Readiness.assessD3` ([`b1Readiness.js:296-379`](../../Backend/tools/routing/b1Readiness.js#L296-L379)).**

**Who answers what — the same three-way split §1.2 makes for D1, and it must not be collapsed either:**

| Party | Owns | Does NOT own |
|---|---|---|
| **Product** | **Which real agent classes this deployment operates**, and which of them share a way of moving. This is a fleet fact, not a modelling choice | The measured values |
| **Fleet Engineering** | **The fleet's measured behaviour** — the six-factor speed model and every value inside `kinematicLimits`, `envelopeConstraints` and `dimensionalFootprint`, each with its measurement basis (class **B**, §2.2) | Which classes exist |
| **Engineering** | The **mechanical representation only**: transcribing the answers into `mobility[]`, keeping `modelId`s distinct so profile keys cannot collide (§2.4), and running the validator | **No value.** `validateModel` reports; `validateRoutingReadiness` states outright *"This function decides no value"* and names D3's owner ([`mobilityModel.js:255-274`](../../Backend/src/engine/domain/mobilityModel.js#L255-L274)) |

**The repository validates structure, never provenance.** `validateModel` checks that each of the
six §2.2 elements is *declared* and non-null and nothing more
([`mobilityModel.js:112-138`](../../Backend/src/engine/domain/mobilityModel.js#L112-L138)); only
`speedModel` gets a further check, and even that is the **presence** of the six factors, never their
values (§2.3). The contents of `kinematicLimits`, `envelopeConstraints`, `dimensionalFootprint` and
`permissionSet` are not schema-checked at all. **A declared-but-invented value passes every check in
this repository.** Only the covering note's (A)/(B)/(C)/(D) classification distinguishes a
measurement from a guess, and only a human reads it.

### 2.1 ADR-33 restricts B1's scope — and the validator does not enforce that restriction

**[ADR-33](../adr/ADR-33-b1-traversal-domain-scope.md) (Accepted, 2026-08-09):**

> **B1 procures a self-hosted outdoor geodesic routing engine that serves `SIDEWALK_GRAPH` and
> `ROAD_GRAPH` from one OSM extract per region; `INDOOR_GRAPH` and `AIRSPACE_VOLUME` are excluded
> from B1's scope.**

Its riders, which bind this handoff:

1. **D7 deferred, not decided.** `MobilityModel.traversalDomain` stays a scalar column while B1's
   scope is single-domain-plus-`ROAD_GRAPH`-on-one-extract.
2. **Validate before you key.** `routingProfileKey()` is total and yields `unknown:unknown:*` for a
   broken model, so two differently-broken models would **share cache entries**. The Phase 8 client
   MUST call `validateModel()` before it keys.
3. **Scope is conditional on outdoor operation.** If D1 returns a **purely indoor footprint, B1 does
   not apply** rather than ADR-33 being wrong. Operations + Commercial must say which it is.

> **Recorded honestly:** `mobilityModel.TRAVERSAL_DOMAINS` accepts all four domains including
> `INDOOR_GRAPH` and `AIRSPACE_VOLUME` (`mobilityModel.js:47-54`) — it implements §2.2, not ADR-33.
> **A model declaring `AIRSPACE_VOLUME` will pass D3 and is still outside B1's procurement scope.**
> No code catches that. **Product must not submit out-of-scope models to B1**, and the B1 ADR must
> record which models were in scope.

### 2.2 Per-model fields — and the four-way classification each one requires

Every entry of `mobility[]` is validated by `validateRoutingReadiness`
([`mobilityModel.js:261-274`](../../Backend/src/engine/domain/mobilityModel.js#L261-L274)).

For **every** item, Product + Fleet Engineering must state which of the following it is:

| Class | Meaning | Admissible as D3 truth? |
|---|---|---|
| **A. Structural declaration** | The field exists and names a category (e.g. `traversalDomain: "SIDEWALK_GRAPH"`) | **Yes** — structure is a declaration, not a measurement |
| **B. Real fleet-measured value** | Derived from the operated fleet, with a stated measurement basis | **Yes** — this is what D3 means |
| **C. Benchmark assumption** | A number chosen to make a benchmark run | **NO. Prohibited.** |
| **D. Repository seed/demo value** | Anything traceable to `prisma/seed.js` | **NO. Prohibited.** |

| Field | Type / rule | Validator | A/B expected |
|---|---|---|---|
| `modelId` | Non-empty string. **One entry per DISTINCT mobility model, not per agent class** — the FK is class → model, so classes that move identically share one model | `mobilityModel.js:117-119` | **A** |
| *(agent classes using the model)* | **Not a field the validator reads.** State it in the covering note: which agent classes map to this `modelId` | — (schema FK class → model) | **A** |
| `traversalDomain` | A value or array of values from `SIDEWALK_GRAPH`, `ROAD_GRAPH`, `INDOOR_GRAPH`, `AIRSPACE_VOLUME`. At least one must be recognised. Normalised to a de-duplicated, code-unit-sorted array | `mobilityModel.js:60-77`, `:121-126` | **A** (constrained by ADR-33) |
| `permissionSet` | Must be **declared** and non-null. Content is not schema-checked here | `mobilityModel.js:128-135` | **A** |
| `speedModel` | Must be a **non-array object** addressing **all six** §2.2 factors — see §2.3 | `mobilityModel.js:188-237` | **B — real fleet measurement, mandatory** |
| `speedModel.roadClass` | Present and non-null | `mobilityModel.js:207-210` | **B** |
| `speedModel.gradient` | Present and non-null | idem | **B** |
| `speedModel.surface` | Present and non-null | idem | **B** |
| `speedModel.payloadMass` | Present and non-null | idem | **B** |
| `speedModel.congestion` | Present and non-null | idem | **B** |
| `speedModel.weather` | Present and non-null | idem | **B** |
| `kinematicLimits` | Declared, non-null | `mobilityModel.js:128-135` | **A** structurally; any *value* inside it is **B** |
| `envelopeConstraints` | Declared, non-null | idem | **A** structurally; values **B** |
| `dimensionalFootprint` | Declared, non-null | idem | **A** structurally; values **B** |

### 2.3 Why the speed model must be a real fleet measurement

`speedModelStatus` ([`mobilityModel.js:188-237`](../../Backend/src/engine/domain/mobilityModel.js#L188-L237))
returns one of four states, and **only `DECLARED` makes a model routable**:

| Status | Condition | Routable? |
|---|---|---|
| `ABSENT` | No `speedModel`, or it is not a non-array object | **No** |
| `STUB` | An object addressing **none** of the six factors | **No** |
| `INCOMPLETE` | Addresses some but not all six | **No** |
| `DECLARED` | Addresses all six | **Yes** — *"Whether its VALUES are the fleet's is commissioning evidence, which this check cannot and does not assert"* |

**The four sources that are explicitly not admissible, and why:**

1. **The repository seed.** `prisma/seed.js:274` declares
   `speedModel: { note: "Populated by the routing integration in Phases 7–9 (blocking decision B1)" }`.
   It is an object, so every *"is it declared?"* check passes, and it addresses **zero** of the six
   factors → `STUB`. *"A stub that reads as present is more dangerous than an absent field, because
   absence is at least visible."*
2. **Benchmark defaults.** `b1Benchmark.js:632-636` keeps the vehicle profile deliberately **off the
   parameter register** because *"they describe the vehicle the candidate engine is routing, and a
   benchmark that resolved them from the engine's config would be measuring the config."* A default
   promoted into fleet truth turns a harness constant into a safety input.
3. **`maxSpeedMps`.** The seed's `kinematicLimits: { maxSpeedMps: 1.5, maxGradient: 0.08 }`
   (`seed.js:275`) is a **kinematic limit** — a ceiling. §2.2 defines the speed model as *speed as a
   function of road class, gradient, surface, payload mass, congestion, and weather*. A ceiling is not
   a function of six variables, and substituting one asserts that the fleet always travels at its
   maximum, in every condition, on every surface — in the **optimistic** direction.
4. **Arbitrary assumptions.** §25.4 makes this a commissioning-gate violation in its own words:
   *"a heterogeneous fleet with copy-pasted parameters will make confidently wrong cross-class
   comparisons, which is worse than not comparing at all."*

And the mechanical reason it blocks Step 1: **a contraction hierarchy is a precomputation over edge
*costs*** (§20.3 item 5). With no cost function there is nothing to precompute over — *"a hierarchy
built behind it would be a precomputation over numbers nobody chose."* This is why **D3 blocks Step 1
independently of D1** ([`b1Readiness.js:288-292`](../../Backend/tools/routing/b1Readiness.js#L288-L292)).

### 2.4 Routing-profile collision freedom (closure criterion C4)

`routingProfileKey(model, { loaded })` = `` `${modelId}:${sortedDomains.join("+")}:${loaded ? "loaded" : "unloaded"}` ``
([`mobilityModel.js:95-100`](../../Backend/src/engine/domain/mobilityModel.js#L95-L100)).

`assessD3` groups the supplied models by this key and **fails D3 on any collision**
([`b1Readiness.js:345-359`](../../Backend/tools/routing/b1Readiness.js#L345-L359)):

- That key is the **first component of every §20.3 cache key** and names **one contraction hierarchy
  per region**. Two models deriving one key share both, and **one model's edge costs are served for
  the other**.
- The load bit is a fixed suffix, so two models collide under `:loaded` exactly when they collide
  under `:unloaded`. One comparison covers both.
- `MobilityModel.modelId` being `@unique` in `schema.prisma` **does not help here**: a
  `ROUTING_B1_DEPLOYMENT` module is a hand-written file the durable store never sees.

**What Product must therefore guarantee:** each distinct locomotion behaviour gets its **own**
`modelId`; agent classes that genuinely move identically share **ONE** model rather than being
declared twice under one id.

### 2.5 `engineProfile`, `energyWhPerMetre`, `speedMetresPerSecond` — D3-owned, supplied elsewhere

These three are **D3 facts** but they are **not** fields of `mobility[]`. They live in the
**per-candidate** block and are validated by `contract.normaliseConfig`:

| Field | Location | Rule | Validator |
|---|---|---|---|
| `engineProfile` | `<candidate>.engineProfile` | Non-empty string — *"the engine-side profile/costing name whose contraction hierarchy was built. It is D3's … and is never chosen here"*. **The placeholder check is deliberately NOT applied to it** (`contract.js:194-197`) | `contract.js:312-317` |
| `profile.energyWhPerMetre` | `<candidate>.profile` | Finite number **> 0** | `contract.js:428` |
| `profile.speedMetresPerSecond` | `<candidate>.profile` | Finite number **> 0** | `contract.js:429` |

`profile.speedMetresPerSecond` is a scalar and **is not the speed model.** It describes the vehicle
the candidate engine is routing, for the benchmark's own arithmetic. **It must not be back-filled
into `speedModel`, and `speedModel` must not be collapsed into it.**

### 2.6 D3 status transitions

| Condition | `decisions.D3.status` |
|---|---|
| `mobility` absent, not an array, or empty | **`BLOCKED`** ← current state |
| Any model not routable, **or** any profile-key collision | **`FAIL`** |
| Every model routable and distinctly keyed | **`PASS`** |

---

## 3. PART 3 — D8 HANDOFF: the extract, its vintage, and the re-contraction window

**Owner: Operations.**
**Validator: `b1Readiness.assessD8` ([`b1Readiness.js:434-585`](../../Backend/tools/routing/b1Readiness.js#L434-L585)) plus `regionBoundary.validateExtractMargin` (V-13, [`regionBoundary.js:899-938`](../../Backend/src/engine/spatial/regionBoundary.js#L899-L938)).**

### 3.1 The seven required fields

All seven are required. **None is defaulted, inferred or assumed.**

| Field | Exact format | Validation | Owner | Determinable now? | Human judgement? |
|---|---|---|---|---|---|
| `extract.identity` | Non-empty string, **not a placeholder** | `isNonEmptyString` **and** `!contract.isPlaceholder` (`b1Readiness.js:454`, `:464-473`) | Operations | **After D1** — it names the extract every measurement is attributed to | **Yes** |
| `extract.source` | Non-empty string, **not a placeholder** | idem | Operations | **After D1** | **Yes** |
| `extract.vintage` | `YYYY-MM-DD`, **real-calendar valid**, **not in the future**, **age ≤ `refreshCadenceDays`** | `regionBoundary.isIsoDate` (`b1Readiness.js:479`); future → **FAIL** (`:559-571`); stale → **FAIL** (`:572-583`) | Operations | **After the extract is cut** | **Yes** — it is a fact about the snapshot, stated |
| `extract.refreshCadenceDays` | **Positive integer** | `Number.isInteger && > 0` (`b1Readiness.js:486`) | Operations | **Yes, now** — it trades against the region's real rate of physical change | **Yes** |
| `extract.recontractionDowntimeBudgetSeconds` | Finite number **> 0** | `isPositiveNumber` (`b1Readiness.js:492`) | Operations | **Stated now, confirmed at Step 4** — the number is Operations' to state and Step 4's to measure against | **Yes** |
| `extract.bbox` | `{ minLon, minLat, maxLon, maxLat }`, **four finite numbers**, `minLon ≤ maxLon`, `minLat ≤ maxLat`. **In the region's own CRS** | `isBoundingBox` (`b1Readiness.js:395-401`) | Operations | **After D1 + the cut** | Partly — it is the box the extract was **actually** cut to, a fact |
| `extract.marginDegrees` | Finite number **≥ 0**, in degrees | `isFiniteNumber && >= 0` (`b1Readiness.js:513`) | Operations | **DEPENDS ON STEP 1/3** — its size is a property of the chosen engine's snapping and border behaviour | **Yes**, informed by measurement |

**Placeholder tokens refused for `identity` and `source`** (`contract.js:171`, compared lower-cased
with trailing whitespace/periods stripped):
`tbd`, `tba`, `todo`, `n/a`, `unknown`, `unspecified`, `pending`, `?`, `-`, `--`, `xxx`, `fixme`, `placeholder`.

### 3.1.1 What substantiates each field, and what it waits on

**All seven are Operations' (§3.1 above).** What differs is the *record* each one needs and the
thing it is waiting for — so that six of the seven are not held up behind the one that genuinely
cannot be answered yet. The validator checks form only; none of the evidence below is machine-checkable.

| Field | Evidence that substantiates it | Knowable now? | Waits on D1? | Waits on Step 1/3 measurement? |
|---|---|---|---|---|
| `identity` | The extract's provenance record — the name every Step 3 row will be attributed to | Once the extract is cut | **Yes** — the extract is cut from D1's boundary | No |
| `source` | The provenance record, in enough detail that a third party could re-cut the same extract | Once the extract is cut | **Yes** | No |
| `vintage` | The **snapshot's own date**, stated by Operations from the provenance record — **never a filesystem, repository or file-creation timestamp** (§3.2 rule 1) | Once the extract is cut | **Yes** | No |
| `refreshCadenceDays` | A written operations judgement trading the cadence against the region's real rate of physical change | **Yes, now** | No | No |
| `recontractionDowntimeBudgetSeconds` | A written operations statement of tolerable routing downtime for a full rebuild (§5.2). **Stated now, measured against at Step 4** — never adjusted afterwards to fit what was measured | **Yes, now** | No | No — but Step 4 compares against it |
| `bbox` | The cut record: the box the extract was **actually** cut to, in the region's declared CRS. Derived from the extract, not from the region, and not invented | Once the extract is cut | **Yes** — it is compared against D1's own bbox by V-13 | No |
| `marginDegrees` | The **Step 1/3 record** naming the snapping and border behaviour actually observed on the deployed candidate (§3.2 rule 2) | **No** | **Yes** | **YES — this is the one field that does** |

**Consequence for sequencing (this is why §6 puts D8 after Step 3):** send items 1–6 as soon as D1
is agreed and the extract is cut; `marginDegrees` follows the measurement. A margin chosen so that
V-13 passes is not a margin — it is the check answering itself.

### 3.2 Three prohibitions, stated in the code itself

1. **Never infer `vintage` from a file timestamp.** `b1Readiness.js:479-485`:
   *"It is never inferred from a file timestamp: a copied file has a new timestamp and the same
   vintage."* A future-dated vintage is a **FAIL**, not a stale warning: *"a vintage in the future
   clears every refresh cadence for as long as it stands — the staleness check would never fire
   again"* (`b1Readiness.js:559-571`).
2. **Never invent `marginDegrees`.** `regionBoundary.js:910-915`: *"The margin's size is a property of
   the chosen engine's snapping and border behaviour, which is measured at B1 Step 1/3 — so no margin
   is assumed here and this check does not pass by default."*
3. **Never invent the downtime budget.** `b1Readiness.js:492-499`: §5.2 requires the routing service
   colocated with the shard and available **throughout**, and a re-contraction is a **rebuild**, not a
   reload. *"The number is Operations' to state and B1 Step 4's to measure against."*

### 3.3 V-13 — the check that only runs once D1 exists

Once all seven fields are present, `validateExtractMargin` compares `extract.bbox` against the
**region's** bounding box expanded by `marginDegrees`
([`regionBoundary.js:918-936`](../../Backend/src/engine/spatial/regionBoundary.js#L918-L936)):

```
extract.bbox.minLon ≤ region.bbox.minLon − marginDegrees
extract.bbox.minLat ≤ region.bbox.minLat − marginDegrees
extract.bbox.maxLon ≥ region.bbox.maxLon + marginDegrees
extract.bbox.maxLat ≥ region.bbox.maxLat + marginDegrees
```

Failing it is a **D8 FAIL**: *"an extract that does not cover the region answers every query and
answers some of them wrongly."*

**If D1 has not produced a valid region, V-13 returns `NOT_CONFIGURED` and D8 reports `BLOCKED` on
D1 — never `PASS`** ([`b1Readiness.js:530-538`](../../Backend/tools/routing/b1Readiness.js#L530-L538)).
**D8 cannot complete before D1.**

### 3.4 Staleness is evaluated against the run date

`assessD8` takes `asOf` as a **parameter, not a clock read** — *"a readiness report that changed
because it was run at a different minute would not be reproducible"*. The CLI supplies today's date
([`b1Readiness.js:812`](../../Backend/tools/routing/b1Readiness.js#L812)).

**Consequence for planning:** an extract that passes D8 today will begin FAILing
`refreshCadenceDays` days after its vintage. **D8's PASS has an expiry.** Steps 1/3/4 must be
executed and recorded inside that window, or the extract must be re-cut and the vintage re-stated.

### 3.5 Representative hardware — required for Step 3

`b1Benchmark.js:562-565` states the provenance rule verbatim:

> **PROVENANCE: single process, this machine, one stage of the round. NOT §20.1 gate evidence —
> §20.1 is stated per shard, at p99, under nominal operation, on representative production hardware,
> over the whole round. This measurement can rule an engine OUT; it cannot rule one IN.**

Operations must therefore additionally supply, and record alongside every Step 3 row:

| Item | Why |
|---|---|
| **A machine representative of production shard hardware** | §20.1's targets are stated on it. A workstation run can only rule a candidate **out** |
| The **colocation** of engine and shard, per §5.2 | §5.2 requires the routing service colocated with the shard and available throughout |
| A written record of CPU / memory / disk / storage class, and whether the run was contended | A number without its hardware is not a measurement of anything |

**None of this is determinable from the repository.** It is Operations' declaration.

### 3.6 D8 status transitions

| Condition | `decisions.D8.status` |
|---|---|
| `extract` absent or not an object | **`BLOCKED`** ← current state |
| Any of the seven fields missing or malformed | **`BLOCKED`** — *"the missing fields are decisions, not derivations"* |
| Fields complete, D1 not valid → V-13 cannot run | **`BLOCKED`** on D1 |
| V-13 runs and the extract does not cover the region + margin | **`FAIL`** |
| Vintage in the future | **`FAIL`** |
| Age > `refreshCadenceDays` | **`FAIL`** |
| Fields complete, V-13 valid, no `asOf` supplied | `NOT_MEASURED` (not reachable from the CLI, which always supplies one) |
| All clean | **`PASS`** |

---

## 4. PART 4 — THE OPERATOR MODULE CONTRACT

### 4.1 Where the file must live, and why it must not live in the repository

| Requirement | Reason |
|---|---|
| **A CommonJS `.js` file** — `module.exports = { … }` | It is loaded with `require()` (`deployment.js:72`) and two required seams, `projectCell` and `chargerCatalogue`, are **functions**. JSON cannot express it |
| **Exports an object** | A non-object export is refused: *"did not export an object keyed by candidate id"* (`deployment.js:76-78`) |
| **An absolute path is strongly preferred** | A relative path is resolved against `process.cwd()` (`deployment.js:72`), so the same command run from a different directory loads a different file — or none |
| **It MUST NOT be placed under `Backend/src/`, `Backend/tools/` or `Backend/tests/`** | Those three directories, plus `Backend/package.json` and `Backend/jest.config.js`, are the **source-digest scope** (`tools/release/sourceDigest.js:33-36`). Adding a file there moves the digest and **unbinds every release-evidence record from the tree it was collected against.** *(This is not hypothetical: T1-04 and V-10 both added files in scope, the digest moved `431010ace1…` → `d033038c…`, and all 17 checked-in records are now `[STALE]`. Recorded here as the demonstration, not as a reason to weaken the rule.)* |
| **Outside the repository entirely is the intended home** | `deployment.js:38-42`: *"the region facts belong outside this repository until D1 answers. **Nothing in `Backend/` ships such a file, and this module never writes one**"* |

**Recommended location:** an operator-controlled path outside the working tree, e.g.
`/etc/robotx/b1Deployment.js` or `C:\ProgramData\robotx\b1Deployment.js`, with the same access
control as any other production configuration.

### 4.2 How it is passed to the tool

```bash
# From Backend/ — POSIX shell
ROUTING_B1_DEPLOYMENT=/abs/path/b1Deployment.js node tools/routing/b1Readiness.js
ROUTING_B1_DEPLOYMENT=/abs/path/b1Deployment.js node tools/routing/b1Readiness.js --json
```

```powershell
# From Backend/ — PowerShell
$env:ROUTING_B1_DEPLOYMENT = "C:\abs\path\b1Deployment.js"
node tools/routing/b1Readiness.js
```

The same variable is read by the benchmark and the candidate roster:

```bash
node tools/routing/b1Benchmark.js --candidates          # roster + why each row is where it is
node tools/routing/b1Benchmark.js --readiness [--json]  # the same readiness report
node tools/routing/b1Benchmark.js --engine osrm         # by candidate id, through the registry
node tools/routing/b1Benchmark.js --engine ./path.js    # the original module seam
```

`npm run routing:readiness` and `npm run routing:b1` are the registered equivalents
(`package.json`). **The environment variable must be set for the process that runs them.**

### 4.3 SAFE TEMPLATE — documentation only

> **This template contains NO production values and MUST NOT be used as one.**
> Every value is a bracketed placeholder. It is deliberately **not runnable**: loading it as written
> will produce `FAIL`/`BLOCKED` on every decision, which is the correct outcome for a file nobody has
> answered.
>
> **No coordinate, no H3 cell, no speed, no charger id, no date, no bounding box and no margin is
> supplied here — because supplying a plausible one is exactly the failure this document exists to
> prevent.** A placeholder that reads like an answer is worse than one that does not.

```js
"use strict";

/**
 * ROUTING_B1_DEPLOYMENT — operator-supplied. NOT part of the RobotX repository.
 *
 * Owners:  region/cover/chargers = D1, Operations + Commercial
 *          mobility[]            = D3, Product + Fleet Engineering
 *          extract               = D8, Operations
 *          osrm/valhalla/graphhopper = whoever performs B1 Step 1
 *
 * Every <<PLACEHOLDER>> below is an unanswered question. Replacing one with a
 * plausible-looking value rather than a real one is the failure mode this file's
 * validators exist to catch; several of them cannot catch it, so a human must.
 */

module.exports = {
  // ══ D1 — Operations + Commercial ══════════════════════════════════════════
  region: {
    regionId:    "<<YOUR_REGION_ID>>",        // stable; must equal its own trim()
    name:        "<<YOUR_REGION_NAME>>",      // the commercial commitment's name
    kind:        "<<SITE | CAMPUS | DEPOT_CATCHMENT | METRO_SERVICE_AREA>>",
    boundary:    "<<YOUR_BOUNDARY>>",         // GeoJSON Polygon or MultiPolygon,
                                              // WGS-84 [lon, lat], rings closed,
                                              // >= 4 positions, non-self-intersecting,
                                              // non-zero area. NOT a demo file unless a
                                              // named human has declared it authoritative.
    crs:         "<<YOUR_CRS>>",              // stated explicitly; never assumed
    version:     "<<YOUR_VERSION_LABEL>>",    // immutable
    versionDate: "<<YOUR_VERSION_DATE_YYYY_MM_DD>>",
  },

  // Derived by Engineering from the APPROVED boundary. Validated here, never computed here.
  cover: {
    fineCells:   "<<YOUR_FINE_CELL_COVER>>",   // [{ cellId: <H3 res 8>, siteId?, indexing? }]
    coarseCells: "<<YOUR_COARSE_CELL_COVER>>", // [{ cellId: <H3 res 5>, … }]
    // cardinalityException: "<<REQUIRED ONLY IF fineCells.length IS OUTSIDE 1000..100000>>",
  },

  // Required, not optional. V-12: every cellId must be in the cover above.
  chargers: "<<YOUR_CHARGER_CATALOGUE>>",     // [{ chargerId, cellId }]

  // OPTIONAL. Omit the key entirely if this deployment operates no other regions.
  // Do NOT list the region above — it is always the first member of the comparison.
  // regions: "<<YOUR_OTHER_REGION_DECLARATIONS>>",

  // ══ D3 — Product + Fleet Engineering ══════════════════════════════════════
  // One entry per DISTINCT mobility model, not per agent class.
  // Profile keys must not collide: `${modelId}:${sortedDomains}:${loaded}`.
  mobility: [
    {
      modelId:         "<<YOUR_MOBILITY_MODEL_ID>>",
      traversalDomain: "<<SIDEWALK_GRAPH | ROAD_GRAPH | [both]>>", // ADR-33 excludes
                                                                   // INDOOR_GRAPH and
                                                                   // AIRSPACE_VOLUME from B1
      permissionSet:   "<<YOUR_PERMISSION_SET>>",
      speedModel: {
        // ALL SIX REQUIRED. Real fleet measurement only.
        // NOT a benchmark default. NOT the seed. NOT maxSpeedMps. NOT an assumption.
        roadClass:   "<<YOUR_MEASURED_ROAD_CLASS_RESPONSE>>",
        gradient:    "<<YOUR_MEASURED_GRADIENT_RESPONSE>>",
        surface:     "<<YOUR_MEASURED_SURFACE_RESPONSE>>",
        payloadMass: "<<YOUR_MEASURED_PAYLOAD_MASS_RESPONSE>>",
        congestion:  "<<YOUR_MEASURED_CONGESTION_RESPONSE>>",
        weather:     "<<YOUR_MEASURED_WEATHER_RESPONSE>>",
      },
      kinematicLimits:      "<<YOUR_KINEMATIC_LIMITS>>",
      envelopeConstraints:  "<<YOUR_ENVELOPE_CONSTRAINTS>>",
      dimensionalFootprint: "<<YOUR_DIMENSIONAL_FOOTPRINT>>",
      // Not read by the validator; state it in the covering note:
      // agentClasses: "<<WHICH AGENT CLASSES USE THIS MODEL>>",
    },
  ],

  // ══ D8 — Operations ═══════════════════════════════════════════════════════
  extract: {
    identity:                          "<<YOUR_EXTRACT_IDENTITY>>",   // not a placeholder token
    source:                            "<<YOUR_EXTRACT_SOURCE>>",     // not a placeholder token
    vintage:                           "<<YOUR_EXTRACT_VINTAGE_YYYY_MM_DD>>", // never a file timestamp
    refreshCadenceDays:                "<<YOUR_REFRESH_CADENCE_DAYS>>",       // positive integer
    recontractionDowntimeBudgetSeconds:"<<YOUR_DOWNTIME_BUDGET_SECONDS>>",    // > 0
    bbox: {
      minLon: "<<YOUR_EXTRACT_BBOX_MIN_LON>>",
      minLat: "<<YOUR_EXTRACT_BBOX_MIN_LAT>>",
      maxLon: "<<YOUR_EXTRACT_BBOX_MAX_LON>>",
      maxLat: "<<YOUR_EXTRACT_BBOX_MAX_LAT>>",
    },
    marginDegrees: "<<YOUR_EXTRACT_MARGIN_DEGREES>>", // measured at Step 1/3; never assumed
  },

  // ══ Per-candidate deployment — B1 Step 1 ══════════════════════════════════
  // One block per candidate that has actually been deployed. Omit a candidate
  // that has not been: an absent block reports NOT_DEPLOYED, which is the truth.
  // The roster order below is §27 item 2's own and is NOT a ranking.
  osrm: {
    baseUrl:        "<<YOUR_SELF_HOSTED_BASE_URL>>",   // http/https; a public hosted
                                                       // service is refused (R1)
    engineProfile:  "<<YOUR_ENGINE_PROFILE_NAME>>",    // the profile whose hierarchy was built
    snapRadiusM:    "<<YOUR_SNAP_RADIUS_METRES>>",     // required for osrm and valhalla
    matrixTimeoutMs:"<<YOUR_MATRIX_BUDGET_MS>>",       // §5.2's budget; not a registered parameter
    // chargerTimeoutMs: "<<OPTIONAL — defaults to matrixTimeoutMs>>",
    // maxLocationsPerQuery: "<<OPTIONAL — the deployment's own location cap, integer > 1>>",
    profile: {
      energyWhPerMetre:     "<<YOUR_ENERGY_WH_PER_METRE>>",     // > 0
      speedMetresPerSecond: "<<YOUR_SPEED_M_PER_S>>",           // > 0; NOT the speed model
    },
    travelTimeSpread: {
      source: "<<YOUR_NAMED_SPREAD_SOURCE>>",                   // N29: must be NAMED, not a placeholder
      model:  "<<PROPORTIONAL | ABSOLUTE_SECONDS>>",
      value:  "<<YOUR_SPREAD_VALUE>>",                          // finite, >= 0
    },
    projectCell:      "<<YOUR_PROJECT_CELL_FUNCTION>>",         // (cellId) => ({ lat, lon })
    chargerCatalogue: "<<YOUR_CHARGER_CATALOGUE_FUNCTION>>",    // async ({ destCellId, profileKey, timeBucket })
                                                                //   => [{ chargerId, lat, lon }]
    deployment: {
      shape:             "<<YOUR_DEPLOYMENT_SHAPE>>",
      extract:           "<<YOUR_EXTRACT_DESCRIPTION>>",
      profilesBuilt:     "<<YOUR_PROFILES_BUILT>>",
      hierarchyBuildTime:"<<YOUR_HIERARCHY_BUILD_TIME>>",
    },
    // transport: "<<OPTIONAL — injected; defaults to the shipped jsonTransport>>",
  },

  // valhalla: { … same shape; snapRadiusM REQUIRED … },
  // graphhopper: { … same shape; snapRadiusM NOT required (see F3);
  //                matrixConcurrency optional, positive integer, defaults to 1 … },
  // inhouse: NOT_IMPLEMENTED by design — no in-house engine exists to adapt to.
};
```

### 4.4 Per-candidate field contract, verified against `normaliseConfig`

`contract.normaliseConfig` ([`contract.js:300-365`](../../Backend/tools/routing/adapters/contract.js#L300-L365))
collects **every** problem and throws once, so a misconfigured candidate reports all its defects at
one go and is marked `MISCONFIGURED` rather than silently repaired
([`deployment.js:114-125`](../../Backend/tools/routing/adapters/deployment.js#L114-L125)).

| Field | Required | Rule |
|---|---|---|
| `baseUrl` | **Yes** | Parseable URL; `http:` or `https:` only; canonical host (trailing dots stripped, lower-cased) **must not** be, or be a subdomain of: `router.project-osrm.org`, `routing.openstreetmap.de`, `valhalla1.openstreetmap.de`, `valhalla.mapzen.com`, `graphhopper.com`, `api.mapbox.com` (`contract.js:151-158`, `:244-280`) |
| `engineProfile` | **Yes** | Non-empty (trimmed) string |
| `projectCell` | **Yes** | `function`. Must return `{ lat, lon }`, both finite and in range; otherwise `MALFORMED_REQUEST` (`contract.js:579-593`) |
| `chargerCatalogue` | **Yes** | `function`. Must resolve an array of `{ chargerId, lat, lon }` (`contract.js:689-705`) |
| `matrixTimeoutMs` | **Yes** | Finite number **> 0** |
| `snapRadiusM` | **osrm, valhalla: YES. graphhopper: NO** | Finite **> 0** where required. **This asymmetry is finding F3** and *"must appear in the B1 ADR as a real difference between candidates"* — the self-hosted GraphHopper `/route` endpoint has no radius parameter (`graphhopper.js:148-150`) |
| `travelTimeSpread.source` | **Yes** | Non-empty **and not a placeholder** (N29 — no shortlisted engine returns a spread, so every `travelSdSeconds` is derived from this field and the name is the only record of whose number it is) |
| `travelTimeSpread.model` | **Yes** | Exactly `"PROPORTIONAL"` or `"ABSOLUTE_SECONDS"` |
| `travelTimeSpread.value` | **Yes** | Finite **≥ 0** |
| `profile.energyWhPerMetre` | **Yes** | Finite **> 0** |
| `profile.speedMetresPerSecond` | **Yes** | Finite **> 0** |
| `deployment.shape` / `.extract` / `.profilesBuilt` / `.hierarchyBuildTime` | **Yes** (all four) | Non-empty **and not a placeholder**. Note `"none"` and `"not built"` are **honest answers and are accepted** — the token list is deliberately narrow (`contract.js:167-171`) |
| `chargerTimeoutMs` | Optional | Finite **> 0**; **falls back to `matrixTimeoutMs`** — reusing a supplied number, not inventing one. **The only fallback in the function** |
| `maxLocationsPerQuery` | Optional | Integer **> 1**; the deployment's own location cap |
| `transport` | Optional | `function` |
| `matrixConcurrency` | Optional, **graphhopper only** | Positive integer; defaults to `1` |

**`inhouse` is `NOT_IMPLEMENTED` by design** and must stay so: `src/engine/routing/` holds three
**caches**, each taking the routing call as an injected function; there is no graph, no edge-cost
model, no contraction hierarchy and no query engine. The nearest module runs A\* over a supplied
waypoint array using a **metered external API** — the option ADR-11 records as **rejected**
(`inhouse.js:14-42`). **Do not write an `inhouse` adapter to fill the roster.**

---

## 5. PART 5 — READINESS CHECKLIST

Each item is checked in order. **An item may not be marked complete on assertion.**

### D1 COMPLETE

| # | Check | Evidence required | Not acceptable |
|---|---|---|---|
| D1.1 | A named human in Operations + Commercial has **declared** the serviceable boundary authoritative | A signed declaration naming the geometry, its `version` and `versionDate` | A geometry extracted from a demo file without that declaration |
| D1.2 | All five §36.3.1 fields supplied | `decisions.D1.region.status === "VALID"` in `--json` | A `region` block that "looks right" |
| D1.3 | Cover supplied and V-8/V-9/V-10 clean | `decisions.D1.cover.status === "VALID"` | Placeholder cell tokens; wrong-resolution H3 |
| D1.4 | `chargers[]` supplied, V-12 clean | No `V-12` problems in `decisions.D1.problems` | An omitted `chargers` key |
| D1.5 | V-11 clean (if `regions[]` supplied) | No `V-11` problems | Dropping a malformed neighbour to make it pass |
| D1.6 | D2 residual reviewed | `decisions.D1.d2Residual.status` read and, if `INVALID`, **routed to Architecture** | Changing a resolution to make the band fit |
| **D1 COMPLETE** | | **`decisions.D1.status === "PASS"`** | Any other value |

### D3 COMPLETE

| # | Check | Evidence required | Not acceptable |
|---|---|---|---|
| D3.1 | Agent classes enumerated and mapped to distinct mobility models | The covering note | — |
| D3.2 | Every model declares all six §2.2 elements | `decisions.D3.models[*].problems` empty | A declared-but-empty element |
| D3.3 | Every `speedModel` addresses all six factors **from fleet measurement** | `decisions.D3.models[*].speedModelStatus === "DECLARED"` **plus** a written measurement basis per factor | `STUB` / `INCOMPLETE`; benchmark defaults; the seed; `maxSpeedMps`; assumptions |
| D3.4 | No routing-profile key collision | `decisions.D3.problems` contains no collision message | Merging two behaviours under one `modelId` to dodge it |
| D3.5 | ADR-33 scope respected | The covering note states each model's domain is `SIDEWALK_GRAPH` and/or `ROAD_GRAPH` | `INDOOR_GRAPH` / `AIRSPACE_VOLUME` models submitted to B1 — **the validator will not stop you** |
| **D3 COMPLETE** | | **`decisions.D3.status === "PASS"`** | Any other value |

### D8 COMPLETE

| # | Check | Evidence required | Not acceptable |
|---|---|---|---|
| D8.1 | All seven `extract` fields supplied | `decisions.D8.problems` empty | Any placeholder token in `identity` / `source` |
| D8.2 | `vintage` stated by Operations from the snapshot | The extract's provenance record | A file timestamp; a future date |
| D8.3 | V-13 ran and passed | `decisions.D8.status !== "BLOCKED"` and no V-13 problems | A `NOT_CONFIGURED` V-13 read as a pass |
| D8.4 | `marginDegrees` justified by Step 1/3 measurement | The Step 1/3 record naming the snapping/border behaviour observed | A number chosen to make V-13 pass |
| D8.5 | Representative hardware identified and recorded (§3.5) | A written hardware declaration | A workstation, unless the run is used only to rule a candidate **out** |
| **D8 COMPLETE** | | **`decisions.D8.status === "PASS"`** | Any other value |

### `b1Readiness`

```bash
cd Backend
ROUTING_B1_DEPLOYMENT=/abs/path/b1Deployment.js node tools/routing/b1Readiness.js --json
```

| Expected transition | Value |
|---|---|
| `deploymentConfigured` | `false` → **`true`** |
| `decisions.{D1,D3,D8}.status` | `BLOCKED` → **`PASS`** (all three) |
| `steps[0].status` (Step 1) | `BLOCKED` → `NOT_CONFIGURED` → `NOT_MEASURED` |
| `steps[2].status` (Step 3) | `BLOCKED` → `NOT_MEASURED` |
| `steps[3].status` (Step 4) | `BLOCKED` → `NOT_MEASURED` |
| `stepEvidenceAdmissible` | `false` → **`true`** |
| `overall` | **stays `BLOCKED`.** See §0.1 — this is by design and is not a defect |
| `engineSelected` | **stays `false`.** Hard-coded (`b1Readiness.js:763`) |
| exit code | **stays 0** throughout. See §0.1 |

### STEP 1 — deploy each candidate; build per-profile contraction hierarchies

| | |
|---|---|
| **Prerequisites** | D1 `PASS` **and** D3 `PASS`. Both, independently (`b1Readiness.js:616-618`) |
| **Command / tool** | **None in this repository.** *"the deployment and hierarchy build are an infrastructure action this tool does not perform and cannot observe"* (`b1Readiness.js:637`) |
| **Evidence required** | Per candidate: the deployed engine, self-hosted, colocated per §5.2; the extract it was built from (matching D8's `identity`/`vintage`); the **built** per-profile contraction hierarchies, one per `routingProfileKey`; the hierarchy build time |
| **State transition** | `steps[0]`: `BLOCKED` → `NOT_CONFIGURED` (D1+D3 in, no candidate block) → **`NOT_MEASURED`** (a candidate reports `AVAILABLE`) |
| **NOT acceptable** | An engine deployed **without** hierarchies — §20.3 item 5 makes the precomputation the point, and *"an engine measured without it is not measured"*. A hosted service. A candidate whose block is present but whose engine is not actually running |

### STEP 2 — one executable benchmark adapter per candidate

| | |
|---|---|
| **Status** | **PASS — already complete.** Released by ADR-33 |
| **Prerequisites** | None. Its contract is region-agnostic by construction |
| **Evidence** | `3 adapter(s) implemented (osrm, valhalla, graphhopper); 1 candidate(s) correctly NOT_IMPLEMENTED (inhouse)` — verified live 2026-08-29 |
| **Command** | `node tools/routing/b1Benchmark.js --candidates` |
| **NOT acceptable** | Writing an `inhouse` adapter to make the count four. *"An adapter written now could only measure itself"* |

### STEP 3 — run the benchmark per candidate on representative hardware

| | |
|---|---|
| **Prerequisites** | Step 1 not `BLOCKED`; **`stepEvidenceAdmissible === true`** |
| **Command** | `ROUTING_B1_DEPLOYMENT=… node tools/routing/b1Benchmark.js --engine <osrm\|valhalla\|graphhopper> --json` |
| **Evidence required** | **Every row recorded**, per candidate, on representative hardware, with the hardware declared |
| **State transition** | `steps[2]`: `BLOCKED` → `NOT_MEASURED` → rows recorded |
| **NOT acceptable — the attribution rule** | The six rows are attributed as follows, and **only `ENGINE` rows may rule a candidate out**: |

| Row | Attribution | May it be quoted as engine evidence? |
|---|---|---|
| `approach_routing_matrix` | **ENGINE** | **Yes** — the timer brackets `engine.matrix()` |
| `charger_reachability_miss` | **ENGINE** | **Yes** — brackets `engine.nearestChargers()` |
| `cost_per_candidate` | **ENGINE** | **Yes** |
| `charger_reachability_cached` | **CACHE_PATH** | **NO.** The engine is never called — this is cache code plus the kv client. A row over budget here is a real §20.1 finding about the **deployment**, not evidence against any candidate |
| `cell_pair_hit_rate` | **HARNESS_ARTIFACT** | **NO.** 1.00 **by construction** — warmed once per cluster, then read |
| `charger_reachability_hit_rate` | **HARNESS_ARTIFACT** | **NO.** 0.50 **by construction** — one cold pass, one warm pass |

> This is not theoretical. Before the attribution discipline existed, the 0.50 produced by
> construction was compared against `route.charger_reachability_min_hit_rate` (0.90), came back
> `EXCEEDED` and exited 1 — so **every** candidate engine ever measured, of any speed, would have
> been reported as failing §20.1's routing budget on a number that was a property of the harness's
> loop structure (`b1Benchmark.js:76-82`).

### STEP 4 — record hierarchy build time and extract refresh cadence per candidate

| | |
|---|---|
| **Prerequisites** | D1 `PASS` **and** D8 `PASS` (`b1Readiness.js:658-660`) |
| **Command / tool** | Recorded through the per-candidate `deployment` block; carried into `description` (`contract.js:493-499`) |
| **Evidence required** | Per candidate: measured hierarchy build time; the extract refresh cadence; the measured re-contraction downtime, **compared against `recontractionDowntimeBudgetSeconds`** |
| **State transition** | `steps[3]`: `BLOCKED` → `NOT_MEASURED` → recorded |
| **NOT acceptable** | A placeholder in any of the four `deployment` fields. A build time copied between candidates. A downtime budget adjusted after the fact to fit the measurement |

### STEP 5 — ENGINE SELECTION

| | |
|---|---|
| **Prerequisites** | Steps 1, 3 and 4 all carry recorded evidence |
| **Command / tool** | **NONE, deliberately.** §6.1 makes B1 **a decision, not a benchmark result.** `b1Readiness.js` reports Step 5 as `BLOCKED` unconditionally and `engineSelected: false` unconditionally |
| **Evidence required** | A **written ADR** (see §6) recording: every candidate's ENGINE-attributed rows; the hardware; the extract identity and vintage; the hierarchy build times; the re-contraction downtime against budget; **F3** (the GraphHopper snap-radius asymmetry) as a real difference between candidates; **N29** (the travel-time spread source, still open for *every* candidate — the engine choice does not close it); and the reasoning |
| **Decision owner** | The release owner, on the recorded evidence, with Architecture |
| **NOT acceptable** | A tool's output presented as the decision. A ranking derived from HARNESS_ARTIFACT or CACHE_PATH rows. A selection made before Steps 1/3/4 are recorded |

### 5.1 Transitions that are forbidden outright

| Forbidden | Why |
|---|---|
| `BLOCKED` → `PASS` **by assertion** | `BLOCKED` means an external decision is missing. *"Collapsing `BLOCKED` into `NOT_MEASURED` is how a blocker becomes a to-do; collapsing either into `PASS` is how a benchmark becomes a formality"* |
| `NOT_MEASURED` → `PASS` **by assumption** | `NOT_MEASURED` is **never a pass** |
| Benchmark assumption → production evidence | §25.4: copy-pasted parameters make *"confidently wrong cross-class comparisons, which is worse than not comparing at all"* |
| Hosted routing service → self-hosted evidence | §5.2 + ADR-11 (rejected: *"metered external API in the hot path"*) + §32.4 **R1, the one requirement marked non-negotiable**. A measurement against a hosted host is *"evidence about somebody else's cluster"* |
| `CACHE_PATH` row → ENGINE evidence | The engine is never called on that path |
| `HARNESS_ARTIFACT` row → ENGINE evidence | The figure is fixed by the harness's own access pattern and is identical for every engine |
| Editing the gate to make B1 pass | §10 of `PHASE_15_MASTER.md`; the gate's own owner field says `EXTERNAL` |
| A stub / fake / in-process router | *"Starting the coordinator against an invented router assigns real work on invented travel times"* |

---

## 6. PART 6 — B1 EXECUTION ORDER

**Execute in this order. Do not skip ahead.**

```
        D1 (Ops + Commercial)          D3 (Product + Fleet Eng)
                   │                              │
                   └──────────────┬───────────────┘
                                  ▼
                              STEP 1  — deploy each candidate against the region
                                        extract; BUILD per-profile hierarchies
                                  │
                                  ▼
                              STEP 3  — benchmark per candidate on representative
                                        hardware; record EVERY row
                                  │
                                  ▼
                    D8 completion / validation  — vintage, cadence, downtime budget,
                                        bbox, and marginDegrees now justified by
                                        Step 1/3's observed snapping behaviour; V-13 runs
                                  │
                                  ▼
                              STEP 4  — record hierarchy build time and refresh
                                        cadence per candidate; compare downtime
                                        against budget
                                  │
                                  ▼
                    HUMAN STEP-5 DECISION  — the release owner selects, on the
                                        recorded evidence. No tool does this.
                                  │
                                  ▼
                              ADR-35  — the B1 selection record
                                  │
                                  ▼
                 PHASE-8 ROUTING COMPOSITION WORK
                   · src/engine/routing/client.js — §5.2's degradation ladder,
                     §18.3 B6's uniform-treatment rule, the route(parts) seam
                     (also blocked by N25/N26)
                   · it must call validateModel() before it keys (ADR-33 rider 2)
                   · it discharges A9 by calling assertVersionInKey
                   · composition-root construction at server.js: evaluateExact,
                     pricedCandidateFor, hopsForSequence, the routing client,
                     the charger-precompute trigger
                                  │
                                  ▼
                    COORDINATOR COMPOSABLE  — npm run gate:composition exits 0
                                  │
                                  ▼
                        RELEASE GATES  — engine_decision_path_wired GREEN.
                                        7 blocking gates still not green
                                        (B8, B-P ×4, B-O ×2) and B-M unproven.
                                        B1 alone does not release.
```

**Notes that bind this order:**

- **D8 sits after Step 3, not before it.** Six of its seven fields can be stated earlier, but
  `marginDegrees` *"is a property of the chosen engine's snapping and border behaviour, which is
  measured at B1 Step 1/3"*. State the other six early; justify the margin from measurement.
- **D8's `PASS` expires** (§3.4). Sequence Steps 1/3/4 inside the cadence window.
- **`ADR-35` is the next free ADR number as of 2026-08-29** — the directory holds ADR-01…ADR-34 plus
  six lettered sub-records (40 files). **Re-verify it is still free before claiming it.**
- **Composition-root construction is composition-root work, not adapter wiring.** Estimate it as such.
- **B1 closing does not close Phase 15.** After `engine_decision_path_wired` turns GREEN, **7 blocking
  gates remain not green** and `model_check_capacity_1_2_3` remains GREEN-but-NOT-PROVEN.

---

## 7. PART 7 — PARALLEL HANDOFF: B-M / TLC (`model_check_capacity_1_2_3`)

# B-M IS AN INDEPENDENT RELEASE-EVIDENCE ITEM. IT IS **NOT** A B1 SUB-STEP.

It appears in this document only so that it can be started **today, in parallel**, by different
people. Nothing about it is downstream of B1 and nothing about B1 is downstream of it:

| B-M is independent of | Consequence |
|---|---|
| **D1** | No operating region is needed. The models are about the commitment protocol and the lifecycle, not about geography |
| **D3** | No mobility model, speed model or fleet measurement is needed |
| **D8** | No extract, vintage or bbox is needed |
| **Routing-engine selection** | B-M closing selects nothing; an engine selection discharges nothing here |
| **B1 Steps 1, 3, 4 and 5** | None is a prerequisite of B-M, and B-M is a prerequisite of none of them |

**Therefore: B-M progress is not B1 progress, and B1 progress is not B-M progress.** Reporting them
as one workstream is how a release comes to look half-finished twice and finished never. Equally,
B-M closing does not release anything on its own — after it closes, the eight blocking §24 gates are
unchanged, because the gate it concerns already renders GREEN (§7.5).

### 7.0 Current authoritative state

# B-M = **NOT MEASURED / OPEN evidence requirement**

**It is NOT `PASS`, and the release gate rendering GREEN is not evidence that it is.** Three
different things are routinely collapsed into one here, and they must be kept apart:

| Thing | What it actually is | Established? |
|---|---|---|
| **`model_check_capacity_1_2_3` renders GREEN** | A machine-readable status computed from the exit code of `npm run test:engine -- ModelCheck`. It says a command exited 0 | **Yes** — and it establishes only that |
| **The `[NOT PROVEN]` annotation** | The tool's own, machine-generated statement that *this command cannot establish this gate's statement* — carried on the row by `gates.js` (`establishedByCommand: false`) and printed by `verdict.js`. **It is the authoritative warning that the claim is not established, and it outranks the GREEN** | **Yes** — it is the current truth of the row |
| **Exhaustive TLC evidence** | Completed exhaustive runs of the checked-in configurations, recorded with their provenance (§7.3a) | **NO. This is what B-M is** |

**The gate's status will not move when B-M is discharged** — it is GREEN now and will be GREEN
after. What changes is that `establishedByCommand` and the `[NOT PROVEN]` annotation are removed.
So **the gate table cannot be used to track B-M**; this document and the blocker register are where
its state lives.

### 7.1 Current state, verified 2026-08-29

| Fact | Verified how |
|---|---|
| **`tla2tools.jar` is ABSENT** | `find . -iname "tla2tools*" -not -path "*/node_modules/*"` → no matches |
| **Java IS available** | `java -version` → `openjdk 20.0.2 2023-07-18` (HotSpot 64-Bit Server VM) |
| **Six checked-in configurations exist** | `formal/` holds `commitment_c{1,2,3}.cfg` and `lifecycle_c{1,2,3}.cfg`, plus `commitment.tla` and `lifecycle.tla` |
| **No model or spec modification is required** | `formal/README.md`: *"the modules and their configurations are complete and are checked in"* |
| **The gate renders GREEN and is NOT PROVEN** | `release:verdict` prints an inline `[NOT PROVEN]` annotation generated by the tool itself |
| **`lifecycle.tla` has NEVER been run under TLC — at any capacity, by any pass** | `formal/README.md:94-100`; `gates.js`'s own `notEstablishedReason` says the same |
| **`commitment.tla` HAS been run — twice, on 2026-08-15, under TLA+ 1.8.0** | `formal/README.md:34-45`: `commitment_c1.cfg` **as checked in** closed (17 991 520 states / 2 375 660 distinct / diameter 21 / no error / 48 s), and a **reduced** capacity-2 form closed (37 633 116 / 4 769 532 / diameter 21 / 69 s). `commitment_c2.cfg` as checked in did **not** converge; `commitment_c3.cfg` did not complete |

> **Precision that matters, because four of the canonical documents phrased it loosely and have been
> corrected (MASTER §5, IMPLEMENTATION_STATE, VERIFICATION_STATE §7, CLOSURE_CHECKLIST V-7):** the
> honest statement is **not** "TLC has never been run". It is that **TLC has
> never been run on this tree** (`tla2tools.jar` is absent, so it is not runnable here), **has never
> been run on `lifecycle.tla` at all**, and that **one of the six checked-in configurations has a
> completed run recorded** — against a different tree, without a recorded tool checksum, operator or
> hardware statement, and therefore not meeting §7.3a. **Whether that historical run may be counted
> toward the six is the release owner's acceptance decision (§7.6), not Engineering's.** Recording
> it as "never run" understates what exists; recording it as a discharge overstates it by five
> configurations.

> **Provenance discrepancy in that historical record — found 2026-08-29, recorded and NOT resolved
> here. It bears directly on the §7.6 acceptance decision above.**
> `formal/README.md:36-41` records the completed 48-second run as **`commitment_c1.cfg` — as
> checked in**, with `Legs / Workers / MaxFence` = **3 / 2 / 5**. The checked-in
> `commitment_c1.cfg` on this tree is `Legs = {l1,l2}`, `Workers = {w1,w2}`, `Capacity = 1`,
> `MaxFence = 4` — i.e. **2 / 2 / 4** — which is also `commitment.tla`'s own MODEL CONFIGURATIONS
> trailer for capacity 1. **3 / 2 / 5 is `commitment_c2.cfg`'s triple**, and the README's
> `commitment_c2.cfg` row carries that same 3 / 2 / 5 with the **opposite** outcome ("did not
> converge"). The README's *reduced* capacity-2 row, 2 / 2 / 4, is the checked-in `c1` file's
> constants. **So the record does not establish which configuration the closed run actually used**,
> and §7.5 gap 2 is precisely why nothing else recorded it: `formal/` is outside the digest scope,
> so no digest would have moved if a `.cfg` changed between the run and its citation.
> **Neither file is edited to reconcile this** — §7.4 forbids editing any `.cfg` or `.tla`, and
> `formal/README.md` is the historical record of a run this repository did not observe; rewriting it
> would destroy the evidence rather than correct it.
> **Consequence for intake:** §7.3a item 6 now requires the **constants actually used, quoted
> verbatim**, alongside the configuration's file name; and the release owner's §7.1 / §7.6 decision
> about the historical run must be taken on that basis, not on the file name alone. If the
> constants cannot be established from the retained output, the run cannot be counted toward the
> six — that is a `NOT MEASURED` answer, not a smaller number of runs remaining.

### 7.2 Exact commands — from `formal/README.md:21-24`, unchanged

```bash
java -jar tla2tools.jar -config commitment_c2.cfg -workers auto commitment.tla
java -jar tla2tools.jar -config lifecycle_c2.cfg  -workers auto lifecycle.tla
```

Run from `formal/`, substituting `_c1`, `_c2`, `_c3` for each module. **All six configurations must
complete.**

### 7.3 What the release owner must supply

| Item | Requirement |
|---|---|
| **`tla2tools.jar`** | The version **must be pinned and checksummed** and recorded with the run. The last recorded execution used **TLA+ 1.8.0** (`formal/README.md:30-32`); a different version is a different tool and must be stated |
| **Compute and disk** | Non-trivial. `commitment_c2.cfg` **as checked in** previously *"did not converge — stopped after >1 h with an 11 GB disk queue still growing"*. `commitment_c3.cfg` and the capacity-3 reduced form did not complete within a workstation session |
| **All six configurations completing** | The gate's *statement* is an exhaustive model check |

### 7.3a What must be recorded and retained — the run is not the evidence until it is written down

**A result that does not say which tool produced it, on what, by whom, is not a result.** None of
the following is machine-checked (§7.5), so each is a written obligation on the person who runs it.
All of it is retained — the **raw TLC output** included, not a summary of it.

| # | Must be recorded | Why |
|---|---|---|
| 1 | **The `tla2tools.jar` version, pinned, and its SHA-256** | A different version is a different tool. The last recorded execution used TLA+ 1.8.0 (`formal/README.md:30-32`); a run that does not name its tool cannot be reproduced or disputed |
| 2 | **The JDK version** | The checker runs on it, and its memory behaviour is part of whether a search closed or was starved |
| 3 | **The machine and its compute characteristics** — CPU, memory, disk size and class, and whether the run was contended | Two of the six have never completed *anywhere*; "did not converge" is a statement about a machine as much as a model |
| 4 | **The operator (a named human) and the run date** | §24.7 asks the safety evidence to be reproducible and attributable |
| 5 | **Whether each state graph actually CLOSED** — per configuration, explicitly | The only fact that distinguishes a discharge from an unfinished search. `commitment_c2.cfg` previously ran over an hour with an 11 GB queue still growing: **not a failure, and not a pass** |
| 6 | **States generated, distinct states, graph diameter and wall-clock runtime** — per configuration — **and the constants the run actually used, quoted verbatim from the `.cfg` (`Legs`, `Workers`, `Capacity`, `MaxFence` / `MaxTicks`)** | They are how a later reader tells a closed search from a truncated one without re-running it, and how the next run's compute is budgeted. The constants are recorded **as well as** the file name because a file name is not a configuration: the one completed run this project has on record cites a triple that does not match the file it names — see §7.1 |
| 7 | **Which §24.2 properties each run actually covered** — explicitly, property by property | The gate's statement is *"every §24.2 safety and liveness property"*. A run that checked a subset discharges a subset. **Include the known correspondence gap: guard G5 (cancellation, purpose-conditioned) has no counterpart in either model, so a completed run does not cover it** |
| 8 | **The boundedness of each model, explicitly accepted** | `lifecycle.tla`'s executable counterpart was **unbounded** in `leg.version` until `MAX_VERSION` was added — no search of it could ever close, at any depth (`formal/README.md:84-92`). A bound is what makes exhaustion *possible*; accepting one is a judgement about whether the bounded model is still the system, and it must be signed rather than assumed |
| 9 | **The capacity scope, explicitly addressed** | The gate names capacities **1, 2 and 3**. State what completed at each, for each module, and say plainly which capacities are not covered |
| 10 | **Release-owner acceptance** | §7.6. The runs are input to a decision; they are not themselves the decision |

**Retention:** the raw output of every run is kept as release evidence alongside items 1–10.
A summary written from memory after the fact is not the raw evidence and does not replace it.

### 7.4 What does NOT discharge the gate

| Not acceptable | Why |
|---|---|
| **Reduced configurations** | A reduced capacity-2 run *did* close previously (2/2/4, 37 633 116 states) and is recorded — **it is evidence about a smaller shape, not a discharge of the checked-in configuration.** Do not substitute it |
| The executable checkers alone | §24.2 permits *"TLA+ or an equivalent model checker"*, and the executable checkers run on every build — but `lifecycleModelCheck.test.js` **asserts truncation**, and *"no exhaustive lifecycle model check exists at any capacity, by either checker"* |
| Removing the `[NOT PROVEN]` annotation | It is the honest record of the gap, made visible deliberately |
| Changing the gate algebra | Forbidden |
| Editing any `.cfg` or `.tla` | Forbidden — no model or spec modification is required |

**Only after all six exhaustive runs actually complete** may `establishedByCommand` be removed from
the gate. **Do not claim B-M is discharged before then.**

> One correspondence gap, restated rather than left to be found: **guard G5** (cancellation,
> purpose-conditioned) has **no counterpart in either model** — neither `commitment.tla`'s
> `GuardsPass` nor `commitmentModel.js` models a cancelled Leg, so G5 is vacuous in both. A completed
> TLC run does **not** cover it. Its evidence is `commitmentGuards.test.js` plus the live-database
> run (`formal/README.md:130-134`).

### 7.5 Two structural gaps the runner must know about — recorded, NOT to be fixed

Both are properties of the current machinery, verified against it on 2026-08-29. **Neither is a
defect to close as part of B-M**, and closing either is a source change that is out of scope here:
do not modify `gates.js`, `evidence.js`, `sourceDigest.js` or any test to accommodate a TLC run.
They are registered in [`PHASE_15_BLOCKERS.md`](PHASE_15_BLOCKERS.md) under **B-M**.

**1. A completed TLC run has no normal evidence-admission path.** `model_check_capacity_1_2_3` is
declared `EVIDENCE.SUITE` with `command: "npm run test:engine -- ModelCheck"`
([`gates.js:186-190`](../../Backend/src/engine/cutover/gates.js#L186-L190)), and `evidence.admit()`
refuses any `BUILD`/`SUITE` record whose `run.command` is not that exact command
(`COMMAND_MISMATCH`), then binds it to the **`Backend/` source digest**
([`evidence.js:342-405`](../../Backend/src/engine/cutover/evidence.js#L342-L405)). A
`java -jar tla2tools.jar …` run therefore **cannot be filed against this gate at all**, and the
schema carries no field for any of §7.3a's items 1–10. **Consequence:** the six runs' evidence lives
in the written record and its retained raw output — nothing admits, checks or ages it. The only
mechanical act that reflects a discharge is the removal of `establishedByCommand` and
`notEstablishedReason` from the gate row, which is an Engineering source change made **on the
release owner's acceptance** (§7.6), not a consequence of any run.

**2. `formal/` is outside the source-digest scope.** The digest covers `Backend/{src,tools,tests}`
plus `package.json` and `jest.config.js`, rooted at `Backend/`
([`sourceDigest.js:33-36`](../../Backend/tools/release/sourceDigest.js#L33-L36)); `formal/` sits at
the **repository root**. **Consequence:** no evidence record is bound to the state of
`commitment.tla`, `lifecycle.tla` or the six `.cfg` files. A configuration could be altered between
a run and its citation and **no digest would move and no gate would notice**. That is precisely why
§7.4 forbids editing them and why the run record must state that each configuration was executed
**as checked in**, quoting its parameters. Do **not** propose putting `formal/` into the digest
scope as a fix — the scope exclusion is deliberate (see `PHASE_15_MASTER.md` §10).

**3. And restating the one that both of the above make possible:** the gate's **GREEN is not a
proof**, and the `[NOT PROVEN]` annotation is the authoritative record that the claim is not
established. Do not remove it, do not change the gate algebra, and do not report B-M as satisfied
because the release verdict shows the row green.

### 7.6 B-M ownership — four parties, and release authority stays where it is

| Party | Owns |
|---|---|
| **Release owner** | **Provisions `tla2tools.jar`** (pinned + checksummed) and **executes or coordinates the six runs**; owns §7.3a items 1–6 and 9 being recorded |
| **Compute / Platform** | **Supplies suitable compute** — memory and disk for the capacity-2 and capacity-3 queues, and the machine statement for §7.3a item 3. Two of the six have never completed on any machine tried so far |
| **Safety engineer** | The **property-coverage and boundedness safety judgement** — §7.3a items 7 and 8. Whether the checked properties are §24.2's, and whether a bounded model is still the system, are safety questions and not engineering conveniences |
| **Engineering** | **Repository implementation and mechanical support only** — the modules, the configurations, the gate row, and (after acceptance) removing `establishedByCommand`. **Engineering does not accept the evidence and does not decide that the gate is discharged** |
| **Release owner** | **Final acceptance.** Including the §7.1 decision about the historical 2026-08-15 `commitment_c1.cfg` run |

**Release authority is not transferable to Engineering.** An Engineering commit that removes
`establishedByCommand` without a recorded acceptance is the false green in its purest form: the
annotation gone, the runs unrecorded, and the row still GREEN.

---

## 8. PART 8 — HUMAN REQUESTS (copy-paste ready)

> Each request below is self-contained. **The recipient does not need to read the repository.**

---

### REQUEST A — Operations + Commercial (decision **D1**)

**Subject: RobotX — we need you to declare the authoritative operating region (blocking decision D1)**

We cannot procure or benchmark a routing engine until you tell us, authoritatively, **where we
operate**. This is not an engineering question and we have deliberately built the system so that no
engineer can answer it on your behalf — the software refuses to invent a region, and reports
"BLOCKED — owner: Operations + Commercial" instead.

**What we need from you — seven items:**

1. **`regionId`** — a short, stable identifier for this region. Every parameter binding and every
   decision record will cite it forever, so it must never change. No leading or trailing spaces.
2. **`name`** — the human-readable name the commercial commitment is written against.
3. **`kind`** — exactly one of: **`SITE`**, **`CAMPUS`**, **`DEPOT_CATCHMENT`**,
   **`METRO_SERVICE_AREA`**.
4. **`boundary`** — the **serviceable boundary** as a **GeoJSON Polygon or MultiPolygon**, in
   **WGS-84**, coordinates written **`[longitude, latitude]`** (in that order). Rings must be closed
   (first point repeated as the last), have at least 4 points, must not cross themselves, and must
   enclose real area. This is the intersection of *what we commit to serve* (Commercial) and *what
   we can operate* (Operations) — **one** geometry, not two.
5. **`crs`** — state the coordinate reference system **explicitly**, even if it is the obvious one.
   Accepted: `EPSG:4326`, `OGC:CRS84`, `CRS84`, `URN:OGC:DEF:CRS:OGC::CRS84`, `WGS84`. We will not
   assume it: a boundary authored in a projected system and read as degrees produces a perfectly
   plausible boundary **in the wrong place**, and that is the single most common failure in this class.
6. **`version`** — an immutable label for this exact geometry, so a later map extract can name what
   it was cut from.
7. **`versionDate`** — the date of that version, as `YYYY-MM-DD`.

**Plus, from Operations / Charging:** the **charger catalogue** — every charger's id and the cell it
sits in. This is now **required**, not optional. A charger outside the region's own cells is a
recharge destination our routing cannot reach, and the system would select it before discovering that.

**What NOT to send us:**

- **Do not** point us at the seeded demo region `RGN-BLR` / `SEED_SPATIAL_MAP`. It is a five-cell
  test fixture with placeholder cell names, built to demonstrate a containment rule. It is not a
  commercial commitment and our validator rejects its cell ids by name.
- **Do not** point us at the campus GeoJSON files in the frontend. They are map display data. They
  carry no region id, no kind, no declared coordinate system, no version and no commitment.
- **Do not** send a bounding box in place of a boundary. We derive the box ourselves from the polygon.
- **Do not** send a geometry "for now, to unblock us". A provisional boundary becomes the production
  boundary the moment anyone builds on it.

**Why we need it:** the routing map extract is **cut from this boundary**; the map cells we price and
schedule against are **derived from it**; and three separate correctness checks (regions must not
overlap, chargers must be inside, the extract must cover the region) have **nothing to compare
against** until it exists.

**Format:** a `.geojson` or `.json` file for the boundary, plus a short covering note giving items 1,
2, 3, 5, 6, 7 and naming who approved it. Engineering will translate it into the configuration file.

**Who owns this decision:** Operations (region identity, kind, what we can operate, version) with
Commercial confirming the name and the served area.

**Where the final answer will be placed:** into the operator-owned deployment configuration module
(`ROUTING_B1_DEPLOYMENT`), held **outside** the code repository. Its acceptance is recorded by
`npm run routing:readiness`, which will move decision **D1** from `BLOCKED` to `PASS`.

---

### REQUEST B — Product + Fleet Engineering (decision **D3**)

**Subject: RobotX — we need the fleet's real speed models (blocking decision D3)**

We cannot build the routing precomputation until you tell us **how fast each kind of robot actually
moves, and under what conditions**. The system currently holds one placeholder mobility model whose
speed model is literally a note saying "to be populated by the routing integration" — so the
software reports "BLOCKED — owner: Product + Fleet Engineering" rather than guessing.

**What we need from you:**

**(a)** The **agent classes** this deployment operates, and which **mobility model** each one uses.
Note: **one entry per distinct way of moving, not per class.** Classes that genuinely move
identically should share one model. Classes that move differently must have different models — if two
end up with the same identifier, they would share one precomputed road network and **one class's
travel times would be served for the other**.

**(b)** For each distinct mobility model, all six of the following:

1. **`traversalDomain`** — which network it uses: **`SIDEWALK_GRAPH`** and/or **`ROAD_GRAPH`**.
   *(Indoor and airspace are explicitly out of scope for this procurement — see "What NOT to send".)*
2. **`permissionSet`** — what it is permitted to traverse.
3. **`speedModel`** — **the critical one.** Speed as a function of **all six** of:
   **road class · gradient · surface · payload mass · congestion · weather.** All six must be
   addressed. A model addressing five is rejected as incomplete.
4. **`kinematicLimits`** — e.g. maximum speed, maximum gradient.
5. **`envelopeConstraints`** — e.g. wind, visibility limits.
6. **`dimensionalFootprint`** — width, height, length.

**(c)** For **every number** you send, state which it is:
**(A)** a structural declaration · **(B)** a **real fleet measurement**, with its measurement basis ·
**(C)** a benchmark assumption · **(D)** a value copied from our demo data.
**Only (A) and (B) are admissible.** We will reject (C) and (D).

**The speed model in particular must be measured, not assumed. It cannot be:**

- **a maximum speed.** A ceiling is not a function of six variables. Substituting one asserts the
  fleet always travels at its maximum, in every condition, on every surface — an **optimistic** error
  that propagates into every delivery-time promise we make.
- **a benchmark default.** Those describe the vehicle a *test harness* is simulating.
- **the demo/seed value.** It is a text note, not a model.
- **a plausible guess.** Our own commissioning rules state it directly: *"a heterogeneous fleet with
  copy-pasted parameters will make confidently wrong cross-class comparisons, which is worse than not
  comparing at all."*

**Why it must be real:** the routing engine precomputes a shortcut network over **edge costs**, and
edge costs come from the speed model. A network precomputed behind a guessed speed model is a
precomputation over numbers nobody chose — and every downstream ETA, feasibility check, energy
estimate and delivery promise inherits it, invisibly and confidently.

**What NOT to send:**

- **Do not** send indoor (`INDOOR_GRAPH`) or drone/airspace (`AIRSPACE_VOLUME`) models for this
  procurement. Our architecture decision **ADR-33** scopes this to **outdoor** sidewalk and road
  routing from one map extract. Our validator will *accept* an out-of-scope model without complaint —
  **it does not enforce the scope, so please do not submit them.**
- **Do not** declare two different behaviours under one model identifier.
- **Do not** fill a factor with a placeholder to make the form complete.

**Format:** a table or spreadsheet, one row per distinct mobility model, one column per field, with a
provenance column stating (A)/(B)/(C)/(D) and the measurement basis for every (B).

**Who owns this decision:** Product (which classes we operate) with Fleet Engineering (the measured
values).

**Where the final answer will be placed:** the `mobility[]` block of the operator-owned deployment
configuration module. Acceptance is recorded by `npm run routing:readiness`, which will move decision
**D3** from `BLOCKED` to `PASS`.

---

### REQUEST C — Operations (decision **D8**)

**Subject: RobotX — we need the map extract's provenance and refresh policy (blocking decision D8)**

Before we can benchmark routing engines we need to know **which map snapshot we are routing over,
how often it is refreshed, and how much routing downtime a rebuild may take.** None of these is
recorded anywhere today, and the software will not guess any of them.

**What we need from you — seven items:**

1. **`identity`** — a stable name for this map extract. Every measurement we take will be attributed
   to it.
2. **`source`** — where the snapshot came from, in enough detail that someone else could cut the
   same extract again.
3. **`vintage`** — the date of the map snapshot the extract was cut from, as `YYYY-MM-DD`.
4. **`refreshCadenceDays`** — how often this extract is re-cut, in whole days. This trades against
   how fast the region physically changes, which is your judgement, not ours.
5. **`recontractionDowntimeBudgetSeconds`** — how much routing downtime a map rebuild may take. The
   routing service must be available to the fleet throughout, and a rebuild is a full rebuild, not a
   reload.
6. **`bbox`** — the bounding box the extract was **actually** cut to: minimum/maximum longitude and
   latitude, in the same coordinate system as the region boundary.
7. **`marginDegrees`** — how much margin, in degrees, the extract was cut with beyond the region's
   own bounding box. **This one depends on measurement** — see below.

**Sequencing, so nobody waits on the wrong thing:** items 1–6 can be answered as soon as the region
(request A) is agreed and the extract is cut. **Item 7 cannot be answered up front** — the right
margin depends on how the chosen engine snaps points near the boundary, which we measure during the
benchmark. Please send 1–6 first, and item 7 once we give you the measurement.

**Three things we will reject, and why:**

- **A vintage taken from a file's timestamp.** A copied file has a new timestamp and the same
  vintage. We need the date of the *snapshot*, from you.
- **A vintage in the future.** A single mistyped year would make the extract permanently "fresh" and
  our staleness check would never fire again. We reject it outright rather than correcting it.
- **An invented margin, or an invented downtime budget.** Both are yours to state; neither will be
  defaulted.

We will also reject `TBD`, `TODO`, `N/A`, `unknown`, `pending`, `?` and similar in items 1 and 2 —
those fields exist so that someone can later ask *"where did this come from?"* and get an answer.

**Additionally, for the benchmark itself:** we need **representative production hardware** to run on,
and a written statement of what it is (CPU, memory, disk, storage class, and whether the run was
contended). A benchmark on a laptop can only rule an engine **out** — it can never rule one **in**.

**Why we need it:** an out-of-date map routes over roads and paths the region no longer has, and it
does so **silently — every query still returns an answer.** An extract that does not fully cover the
region does the same. These are the two failure modes that do not announce themselves.

**Format:** a short structured note or JSON fragment with items 1–6, plus the hardware statement.
Item 7 to follow after measurement.

**Who owns this decision:** Operations.

**Where the final answer will be placed:** the `extract` block of the operator-owned deployment
configuration module. Acceptance is recorded by `npm run routing:readiness`, which will move decision
**D8** from `BLOCKED` to `PASS`.

---

### REQUEST D — Release owner (blocker **B-M** — formal verification / TLC)

**Subject: RobotX — we need a tool licence artefact and machine time to prove a release gate we are currently only asserting**

One of our release gates, `model_check_capacity_1_2_3`, currently reports **GREEN** while carrying a
machine-generated annotation that reads **`[NOT PROVEN]`**. That annotation is deliberate and honest:
the gate's *statement* is an **exhaustive** formal model check, and the command that currently
discharges it does not establish that statement. We are not going to remove the annotation; we want
to earn its removal.

**What we need from you — three things:**

1. **`tla2tools.jar`** — the TLA+ model-checking tool. It is **not present** in our repository and
   must not be committed to it. **The exact version must be pinned and its checksum recorded**
   alongside the run: a different version is a different tool, and a result that does not say which
   tool produced it is not a result. The last recorded execution in this project used **TLA+ 1.8.0**.
2. **Machine time and disk.** This is not a laptop task. A previous attempt at one of the six
   configurations ran for **over an hour and was still growing an 11 GB on-disk queue when it was
   stopped**. Two of the six have never completed anywhere. Please budget a machine with substantial
   memory and disk, and expect hours, not minutes.
3. **A named owner to run all six configurations and record the results.** Nothing here is checked
   automatically — our tooling has no way to admit a model-checking run as evidence — so the written
   record **is** the evidence, and it must carry all of:
   the **tool version and its SHA-256**; the **JDK version**; the **machine** (CPU, memory, disk size
   and class, and whether the run was contended); the **operator's name and the run date**; **whether
   each state graph actually closed**, stated per configuration — an unfinished search is neither a
   failure nor a pass; the **states generated, distinct states, graph diameter and wall-clock time**
   per configuration; **which properties each run actually covered**, including the one gap noted
   below; that the **bounds** each model uses are accepted as still describing the real system; and
   **which of capacities 1, 2 and 3 are and are not covered**, per module. **The raw tool output is
   retained**, not just a summary. Finally, the results are **accepted by you as release owner** —
   engineering does not accept this evidence on your behalf.

**What we already have, so that nothing is duplicated:** Java 20 is installed and working. Both
formal specifications and all six configurations are written and checked in. **No specification and
no configuration needs to be modified** — this is purely a matter of the tool artefact and compute.

**What will NOT count as done, and why we are saying so in advance:**

- **Reduced configurations do not discharge the gate.** A smaller variant *has* completed
  successfully before, and it is recorded as what it is: evidence about a smaller problem. Six
  configurations are checked in; all six must complete.
- **The existing automated checks do not discharge it.** They run on every build and they are
  genuinely valuable, but they stop early by design and our own test suite asserts that they stop
  early.
- **We will not remove the `[NOT PROVEN]` annotation, change the gate's logic, or edit a
  configuration** to make this pass. The only thing that closes it is six completed exhaustive runs.

**One limitation to record with the result:** one guard in the commitment protocol (cancellation) has
no counterpart in either formal model, so a completed run does **not** cover it. Its evidence is the
unit test suite and a live-database run. This should be stated in whatever attestation is filed, not
discovered later.

**Important scoping note:** this work is **independent of, and does not unblock, our main routing
blocker (B1)**. It can proceed in parallel starting today. Please do not treat progress here as
progress on the release as a whole — after this closes, seven other blocking gates remain.

**Who owns this decision:** the release owner, with whoever provisions compute.

**Where the final answer will be placed:** the run records become release evidence; only then is
`establishedByCommand` removed from the gate.

---

## 9. PART 9 — STOP CONDITIONS

**Any of the following means: stop, do not proceed, escalate to the named owner.**

| # | STOP condition |
|---|---|
| 1 | **STOP if D1 is incomplete.** `decisions.D1.status !== "PASS"`. Steps 1, 3, 4 and 5 stay BLOCKED. Escalate to Operations + Commercial |
| 2 | **STOP if D3 is incomplete.** `decisions.D3.status !== "PASS"`. Step 1 stays BLOCKED independently of D1. Escalate to Product + Fleet Engineering |
| 3 | **STOP if D8 is incomplete.** `decisions.D8.status !== "PASS"`. Step 4 stays BLOCKED. Escalate to Operations |
| 4 | **STOP if any field is invented.** Not defaulted, not "filled in to unblock", not inferred from an absence. §4.1 rule 3: state is never inferred from the absence of data |
| 5 | **STOP if seed or demo data is promoted without human approval.** `RGN-BLR`, `SEED_SPATIAL_MAP`, `MOB-SIDEWALK-DEFAULT`, the campus GeoJSON files, the degenerate zone boxes. **"Mechanically derivable" is not "approved"** — see §1.2 |
| 6 | **STOP if a benchmark assumption is treated as a fleet measurement.** Especially `profile.speedMetresPerSecond` → `speedModel`, or `kinematicLimits.maxSpeedMps` → `speedModel` |
| 7 | **STOP if a routing engine is selected, ranked, recommended or hinted at before Steps 1, 3 and 4 are complete and recorded.** The roster order is §27 item 2's own and is **not** a ranking |
| 8 | **STOP if anyone proposes editing the gate to make B1 pass.** `gate:composition`'s own output declares the owner `EXTERNAL — B1` and states *"no commit here closes it"* |
| 9 | **STOP if anyone proposes creating a fake, stub or in-process router to satisfy composition.** *"Starting the coordinator against an invented router would assign real work on invented travel times, which is worse than not assigning it"* |
| 10 | **STOP if `DEGRADED_ROUTING` is proposed as a substitute for a routing service.** It is a rung on a degradation ladder, not an engine |
| 11 | **STOP if a hosted routing service is used for any measurement.** §32.4 **R1 is the one requirement marked non-negotiable** |
| 12 | **STOP if a CACHE_PATH or HARNESS_ARTIFACT row is quoted as engine evidence** (§5, Step 3) |
| 13 | **STOP if the deployment module is placed inside `Backend/src`, `Backend/tools` or `Backend/tests`** — it voids the source digest and all 17 bound release-evidence records |
| 14 | **STOP if `routing:readiness`'s `OVERALL` or exit code is used as the progress signal.** It cannot leave `BLOCKED` and it always exits 0 (§0.1) |
| 15 | **STOP if B-M is claimed discharged before all six exhaustive TLC runs complete**, or if a reduced configuration is substituted, or if a run is cited without §7.3a's record. **B-M is `NOT MEASURED / OPEN`** |
| 15a | **STOP if `model_check_capacity_1_2_3`'s GREEN is presented as proof**, or the `[NOT PROVEN]` annotation is removed, weakened or omitted from a report (§7.0, §7.5) |
| 15b | **STOP if B-M progress is reported as B1 progress, or B-M is treated as a B1 sub-step.** They are independent in both directions (§7) |
| 16 | **STOP if this document and the validators disagree.** The validator wins; this document is then defective and must be corrected — **not the validator** |

---

## 10. PART 10 — FINAL VERIFICATION OF THIS DOCUMENT

Performed 2026-08-29 against the live tree, after writing. **§10 and §10.1 record the original
write; the later synchronisation is recorded separately in §10.2 rather than folded into them.**

| # | Verification | Result |
|---|---|---|
| 1 | Claims checked against actual current source | **Done.** Every field, status, threshold and quoted sentence was read out of the files cited. Files read in full or in the cited range: `tools/routing/b1Readiness.js`, `tools/routing/adapters/{deployment,contract,index,inhouse}.js`, `tools/routing/b1Benchmark.js` (header, ROWS, OPEN_DECISION, main), `src/engine/spatial/regionBoundary.js`, `src/engine/domain/mobilityModel.js`, `src/engine/spatial/cells.js` (resolutions), `tools/release/sourceDigest.js` (scope), `prisma/seed.js` (D1/D3 seed blocks), `formal/README.md`, `docs/adr/ADR-33-*.md`, and all five canonical Phase 15 documents |
| 2 | Every field name checked against the current loader/validators | **Done.** Two discrepancies found and **recorded rather than silently corrected**: (a) `cover.fineCells[].zoneId` appears in the seam docstring and **no validator reads it** (§1.4); (b) `contract.isPlaceholder` is **deliberately not applied** to `regionId`, `name`, `version` or `engineProfile` (§1.3, §2.5) |
| 3 | Every command checked against `package.json` / current tools | **Done.** `routing:readiness`, `routing:b1`, `gate:composition`, `gates`, `release:verdict` all confirmed present. The TLC commands are `formal/README.md:21-24` verbatim |
| 4 | No fake production value inserted | **Confirmed.** The template contains **zero** coordinates, H3 cell ids, speeds, charger ids, dates, bounding-box numbers, margins, timeouts or base URLs. Every slot is a bracketed placeholder |
| 5 | Does not claim B1 is ready | **Confirmed.** B1 is stated BLOCKED in the header, in §0, in §5, in §6 and in §9 |
| 6 | Does not select or recommend an engine | **Confirmed.** The only candidate ordering used is §27 item 2's own roster order, labelled *not a ranking* at every occurrence. No comparative claim about any candidate appears. F3 is recorded as a **difference to be documented in the ADR**, not as a preference |
| 7 | Does not modify application source | **Confirmed.** One file created, under `docs/`. No source, test, schema, migration, gate, threshold, config or specification file was touched |
| 8 | Only safe read-only validation run | **Confirmed.** Commands executed: `sourceDigest()` (read-only), `node tools/routing/b1Readiness.js` (exit 0, read-only, no engine deployed), `node tools/gates/checkCompositionRoot.js` (exit 1, read-only), `java -version`, `find` for `tla2tools*`, `git status`, `ls`. **No test suite, no database, no network call, no write outside `docs/`** |
| 9 | Files changed | **One file created:** `docs/phase15/B1_EXTERNAL_INPUT_HANDOFF.md`. **Nothing modified. Nothing deleted.** The source digest is unchanged at `431010ace188c4b1b91415821e8cebc7beeb8f3f378a1b39fb77986fb3b22470` / 565 files — verified after writing, because `docs/` is outside the digest scope by design |
| 10 | Current B1 blocker state | **Unchanged and re-measured below** |

### 10.1 B1 blocker state — re-measured 2026-08-29, after this document was written

```
npm run routing:readiness   → exit 0    OVERALL: BLOCKED
    D1  BLOCKED   [Operations + Commercial]
    D3  BLOCKED   [Product + Fleet Engineering]
    D8  BLOCKED   [Operations]
    step 1  BLOCKED   (D1, D3)
    step 2  PASS      3 adapters implemented; inhouse correctly NOT_IMPLEMENTED
    step 3  BLOCKED   (D1, D3)
    step 4  BLOCKED   (D1, D8)
    step 5  BLOCKED   (D1, D3, D8, Steps 1/3/4)
    stepEvidenceAdmissible = false
    engineSelected         = false

npm run gate:composition    → exit 1    1 violation of 18 workers
    coordinator [LEADER_ONLY_NOT_COMPOSABLE]
    owner: EXTERNAL — B1 — "this blocker is EXTERNAL to this repository and no commit here closes it"

Release verdict (unchanged):  16 GREEN · 1 RED · 7 NOT_EVALUATED — BLOCKED
Actionable repository-owned Phase 15 blockers: 0
```

> **The block above is the 2026-08-29 reading and is kept as the dated record. Two of its lines no
> longer render that way on the current tree** (re-measured 2026-08-30 at digest `d033038c…`),
> **and neither changes B1's state:**
>
> - `gate:composition` prints **"1 violation across 19 registered worker(s)"**, not 18. T1-04 added
>   a 19th worker; the violation is still `coordinator` and still owned **EXTERNAL — B1**.
> - `release:verdict` prints **0 GREEN · 17 RED · 7 NOT_EVALUATED**, because the checked-in
>   evidence collection is bound to the superseded digest and has aged past every gate's
>   `maxAgeMs`. **Every extra RED is `[STALE]`, not a gate failing**, and `engine_decision_path_wired`
>   was RED on its own merits before and after.
>
> **Everything B1-specific is unchanged:** `routing:readiness` still exits 0 with `OVERALL: BLOCKED`,
> D1/D3/D8 all `BLOCKED`, Step 2 `PASS`, Steps 1/3/4/5 `BLOCKED`, `stepEvidenceAdmissible` false,
> `engineSelected` false, and **actionable repository-owned Phase 15 blockers: 0**.

### 10.2 Documentation synchronisation, 2026-08-29

Persisting the completed D1 / D3 / D8 / B-M external-input analysis. **Documentation only.**

| What changed | Kind | Source of the fact |
|---|---|---|
| Header: B-M row; §7 rewritten as an **independent** release-evidence item with §7.0 (state), §7.3a (what must be recorded), §7.5 (two structural gaps) and §7.6 (ownership) | Evidence + ownership clarification | `gates.js:186-232`, `evidence.js:342-405`, `sourceDigest.js:33-36`, `formal/README.md`, `verdict.js` |
| §7.1: `lifecycle.tla` never run; `commitment.tla` run twice on 2026-08-15 under TLA+ 1.8.0 | Requirement/state precision | `formal/README.md:28-45, 94-100` |
| §2: the Product / Fleet Engineering / **Engineering** split, and that the validator checks structure and never provenance | Ownership clarification | `mobilityModel.js:112-138`, `:255-274` |
| §3.1.1: per-field evidence and dependency for D8's seven fields | Requirement clarification | `b1Readiness.js:434-585`, `regionBoundary.js:899-938`, §3.2, §6 |
| §9: STOP conditions 15a, 15b | Requirement clarification | §7.0, §7.5 |

**No status moved.** D1, D3, D8 remain `BLOCKED`; B-M remains `NOT MEASURED / OPEN`; Step 1 has not
started; no engine is selected. **D1 needed no change** — its requirements, ownership split, cover,
charger and D2-residual rules were already complete and correct in §1.

### 10.3 Intake-preparation pass, 2026-08-29 — documentation only

Preparing the real external-input collection. **No value was supplied, no status moved, no source,
test, gate or configuration file was touched.** Re-measured on this tree before and after: source
digest `431010ace188c4b1b91415821e8cebc7beeb8f3f378a1b39fb77986fb3b22470` (565 files, unchanged);
`node tools/routing/b1Readiness.js` → exit 0, D1/D3/D8 **BLOCKED**, Step 2 **PASS**, Steps 1/3/4/5
**BLOCKED**, `engineSelected` false.

| What changed | Kind | Source of the fact |
|---|---|---|
| §7.3a item 6 additionally requires the **constants actually used**, quoted verbatim per configuration | Requirement precision — a file name is not a configuration | `formal/commitment_c{1,2,3}.cfg`, `formal/lifecycle_c{1,2,3}.cfg`, `commitment.tla` MODEL CONFIGURATIONS trailer, read on this tree |
| §7.1 records the **provenance discrepancy** in the historical 2026-08-15 run: `formal/README.md:36-41` cites `commitment_c1.cfg` "as checked in" at 3 / 2 / 5, which is `commitment_c2.cfg`'s triple; the checked-in `c1` is 2 / 2 / 4 | Provenance gap, recorded not resolved — it is an input to the release owner's §7.6 acceptance decision | `formal/README.md:36-41` compared against the six `.cfg` files as checked in |

**Nothing in `formal/` was edited** (§7.4), and `formal/README.md` was deliberately left intact as
the historical record of a run this repository did not observe.

---

## 11. What happens next — and what does not

**This document is the end of this session's work.** It does not begin B1.

**The next B1 session may begin only when a real `ROUTING_B1_DEPLOYMENT` module exists**, written by
the owners named in Part 8, containing values none of which came from this repository. Its first
action is:

```bash
cd Backend
ROUTING_B1_DEPLOYMENT=/abs/path/b1Deployment.js node tools/routing/b1Readiness.js --json
```

and its first obligation is to read §0.1 before interpreting the output.

**If any decision still reports `BLOCKED`, that session stops too**, and says which one and to whom.

---

**TRUTH > COMPLETENESS > CONVENIENCE > GREEN.**

# B1: BLOCKED — EXTERNAL. D1 BLOCKED · D3 BLOCKED · D8 BLOCKED.
# NO ROUTING ENGINE IS SELECTED, RANKED OR RECOMMENDED.
# B-M: NOT MEASURED / OPEN — INDEPENDENT OF B1, IN BOTH DIRECTIONS.
# PHASE 15 IMPLEMENTATION: CLOSED. RELEASE: BLOCKED. PHASE 16: NOT READY.
