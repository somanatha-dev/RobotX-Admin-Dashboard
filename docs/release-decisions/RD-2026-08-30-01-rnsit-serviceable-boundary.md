# RD-2026-08-30-01 — RNSIT authoritative RobotX serviceable operating boundary

| | |
|---|---|
| **Recorded** | 2026-08-30 |
| **Owner** | Project owner |
| **Supersedes** | All prior conversational RNSIT boundary decisions (§3) — none were persisted to this repository |
| **Subject** | OSM feature `way/1120154292` — RNS Institute of Technology, Bengaluru |
| **Scope** | RNSIT only. JSSATE Bengaluru is untouched by this record |
| **Machine-readable record** | **None, deliberately** — see §10 |
| **Status of B1 / D1** | **Unchanged — still BLOCKED.** This record is an intent declaration, not a D1 supply. See §7 |

---

## 1. The decision

> **Project-owner decision, 2026-08-30:** OSM feature `way/1120154292` is the authoritative RobotX
> serviceable operating boundary for RNSIT Bengaluru. Its exact geometry is to be used **without
> extension, buffering, simplification, snapping, coordinate modification, reprojection, repair, or
> manual enlargement.** The original OSM geometry is the final intended RNSIT RobotX serviceable
> boundary.

The owner's previous decision — to use a manually extended RNSIT boundary — is **withdrawn in
full**. No extended geometry is part of the RobotX deployment boundary.

---

## 2. What is being adopted, named by content

A boundary decision that names a campus rather than a byte sequence is not a boundary decision. The
geometry adopted is the one at these git object names, in this tree, today:

| | |
|---|---|
| **Feature id** | `way/1120154292` |
| **Containing file** | `rnsit-campus-osm.geojson` (repository root) |
| **Identical copy** | `Frontend/src/features/maps/campus/data/rnsit/rnsit-campus-osm.geojson` |
| **git blob (both paths)** | `a82f61e35a8445f9ee818cb8a24f0dcfc8412341` |
| **SHA-256 of file** | `04cb64c4205dc59462e149501fdd93b412106cfdc8d7249661bc8f3f47dc08b4` |
| **Added in** | `3f0e522` "maps enhanced", 2026-08-23 |
| **Overpass export timestamp** | `2026-08-23T04:59:06Z`, `generator: overpass-turbo` |
| **Licence** | ODbL (OpenStreetMap) |

Both paths resolve to the same git blob, so the root copy is not a second source — it is the same
object stored twice.

### 2.1 The geometry, as measured on this tree

Measured 2026-08-30 by direct read of the file. Nothing was written, and no file was modified.

| Property | Value |
|---|---|
| Geometry type | `Polygon`, 1 ring (no holes) |
| Vertices | 19 listed, 18 unique, ring explicitly closed |
| Bounding box | lon `77.515009` … `77.5197566`, lat `12.8988932` … `12.9025796` |
| Approximate area | **0.0998 km²** |
| Coordinate precision | 6–7 decimal places |
| Duplicate consecutive vertices | 0 |
| Self-intersections | **0** |
| Exterior ring winding | **counter-clockwise** — RFC 7946 right-hand rule already satisfied |
| OSM tags | `amenity=college`, `name=RNS Institute of Technology`, `wikidata=Q7277277`, `source=Local knowledge` |

**Why §2.1 matters to §1:** the owner forbade repair, snapping and coordinate modification. That
constraint is *mechanically satisfiable* — the ring is closed, simple, non-degenerate and already
wound in the direction RFC 7946 requires for an exterior ring. **No repair, no rewinding and no
snapping is needed to use this polygon as it stands.** Had the ring self-intersected or been wound
clockwise, §1 and a future D1 declaration would have been in direct conflict; they are not.

---

## 3. Decision history — corrected

**Every entry below marked WITHDRAWN existed only in conversation. None was ever written to this
repository.** A search of the tracked tree and of every untracked file found no RNSIT boundary
decision record, no extended-boundary artefact, and no file whose name contains "extended". There
is therefore no contradictory persisted statement to retract — but the withdrawals are recorded here
in full so the history is legible rather than merely absent.

| # | Previous statement | Status as of 2026-08-30 |
|---|---|---|
| 1 | The original OSM polygon `way/1120154292` was **incomplete** | **WITHDRAWN.** The polygon is adopted as complete and authoritative |
| 2 | A **manually extended** RNSIT boundary would be used | **WITHDRAWN.** No extended geometry is part of the deployment boundary. No such artefact exists or is to be created |
| 3 | The **main gate is inside** the intended RobotX serviceable area | **WITHDRAWN.** Superseded by §5 |
| 4 | `rnsit-playground-1` and `rnsit-parking-lot` are **inside** the intended serviceable area | **WITHDRAWN.** Superseded by §4 |
| 5 | The **extended geometry is the candidate** RNSIT deployment boundary | **WITHDRAWN.** The candidate and the adopted boundary are both exactly `way/1120154292` |
| 6 | Step 3 supplemental-point discrepancy resolved as **Option 2** | **SUPERSEDED by Option 1** — see §4 |

### 3.1 Adjacent records that are *not* withdrawn

Two existing statements sit near this decision and are deliberately left standing, because neither
contradicts it:

- **`Frontend/src/features/maps/ARCHITECTURE.md:110`** — RNSIT campus map data is
  `VERIFIED_BY_USER` (project owner, 2026-08-23). That is a *map-display provenance* record about
  feature identity and placement. It is not a serviceable-boundary declaration and does not become
  one by this decision.
- **`ARCHITECTURE.md:324`** — "a main gate is outside the perimeter almost by definition." This
  *agrees* with §5 and predates it.

One existing statement is in **numerical tension** with §4 and is addressed head-on in §8.1 rather
than quietly left in place.

---

## 4. Supplemental-point discrepancy — Option 1, the polygon is authoritative

> **Decision:** the polygon is authoritative. The three supplemental points falling outside
> `way/1120154292` are **outside the RobotX serviceable area** and must **NOT** be treated as
> RobotX-routable destinations under this boundary.

### 4.1 Containment, recomputed on this tree

All 11 features of `rnsit-campus-supplemental.geojson` (SHA-256 `fad25fef54ab…`, blob
`8ef604a4f46e…`) tested against `way/1120154292` by ray-casting point-in-polygon, with distance
measured point-to-**edge** in metres:

| Supplemental point | In / out | Distance to boundary |
|---|---|---|
| `rnsit-main-gate` | **OUT** | 33.4 m |
| `rnsit-playground-1` | **OUT** | 58.0 m |
| `rnsit-parking-lot` | **OUT** | **0.7 m** |
| `rnsit-food-court` | in | 112.3 m |
| `rnsit-playground-2` | in | 41.7 m |
| `rnsit-pre-university-college` | in | 37.4 m |
| `rnsit-innovation-center` | in | 92.3 m |
| `rnsit-canara-bank` | in | **22.0 m** |
| `rns-first-grade-college` | in | 84.2 m |
| `rns-evening-college` | in | 84.2 m (co-located with the above) |
| `rnsit-cyber-security-department` | in | 84.8 m |

**Outside count = 3, and they are exactly the three the owner named.** The owner's factual premise
is confirmed independently, not accepted on assertion.

### 4.2 Consequence

`rnsit-main-gate`, `rnsit-playground-1` and `rnsit-parking-lot` are **non-serviceable** under this
boundary. They are not deleted from the supplemental dataset, not moved, and not reclassified in the
map layer — that dataset is frontend display data and is out of scope for this decision. They are
excluded from *RobotX routable destinations*, which is a different and narrower claim.

---

## 5. Main gate — corrected operational decision

> **Decision:** the RNSIT main gate lies outside the adopted `way/1120154292` polygon and is
> therefore **outside the RobotX serviceable routing boundary**. Robots are **not required** to
> route to or from the main gate under the current RNSIT deployment boundary.

Measured position: `77.519241, 12.902682`, **33.4 m outside** the adopted perimeter.

This withdraws history item 3 (§3) without qualification. No implicit gate corridor, gate buffer,
access stub or "gate is special" exception is created by this record; creating one would be a
manual extension of the boundary by another name, which §1 forbids.

---

## 6. What was NOT done

Explicitly, and in line with the owner's instructions for this step:

- **No manually extended boundary artefact was created or used.** None exists anywhere in the tree.
- **No GeoJSON file was modified.** Both RNSIT files hash identically to their committed blobs.
- **No geometry was altered** — not extended, buffered, simplified, snapped, reprojected or repaired.
- **`npm run routing:readiness` was not run.**
- **`b1Deployment.js` was not created.**
- **`ROUTING_B1_DEPLOYMENT` was not created.**
- **No H3 index, cell cover or fine-cell count was computed.**
- **No routing engine was selected, ranked, recommended or hinted at.**
- No source, test, gate or specification file was touched. This record is documentation only.

---

## 7. What this decision does *not* settle

**D1 remains BLOCKED, and this record does not move it.** Adopting a geometry as *intended* is not
the same as supplying it as *authoritative external input*. Four independent reasons, each of which
is on its own sufficient:

1. **The file is this repository's own tracked demo data, not external supply.** It is tracked in
   git (added `3f0e522`, 2026-08-23) and is byte-identical to
   `Frontend/src/features/maps/campus/data/rnsit/`. `B1_EXTERNAL_INPUT_HANDOFF.md` §1.1 names these
   six files as forbidden as D1 data, and its STOP rule 5 refuses promotion of demo data without
   human approval. **A decision to adopt the geometry is not the external supply the handoff asks
   for; it is a statement of what the owner intends that supply to contain.**
2. **The container's type is refused by V-1.** `regionBoundary.js:397` accepts only `Polygon` and
   `MultiPolygon` as D1 field 3. A `FeatureCollection` is refused outright.
3. **The declaration fields do not exist.** The file carries no `crs` member, no `regionId`, `kind`,
   `version`, `versionDate` and no approver. Its top-level keys are exactly
   `type, generator, copyright, timestamp, features`.
4. **The commitment is absent.** An overpass-turbo export with a `source=Local knowledge` tag is not
   a commercial serviceable-area commitment, whatever its geometric quality.

### 7.1 The one thing §2.1 *does* unblock

`way/1120154292`'s own `geometry` member **is** a GeoJSON `Polygon` with a clean, correctly-wound,
non-self-intersecting ring. So when D1 is answered properly, its field 3 can be that Polygon's
coordinate array **copied verbatim** — which satisfies V-1 without extension, buffering,
simplification, snapping, coordinate modification, reprojection or repair. Extraction into a
declaration wrapper is re-expression of the same coordinates, not alteration of them.

**This reading should be confirmed by the owner before D1 is answered**, since §1's prohibition list
is written against the geometry and is silent on the container.

---

## 8. Remaining RNSIT evidence gaps

Recorded, not resolved. None of them is a reason to reopen §1.

### 8.1 The parking lot's exclusion rests on 0.7 m of unverified line — GAP-1

`rnsit-parking-lot` is outside the polygon by **0.7 m**. That margin is far below the accuracy of
either input: the point is `source: USER_SUPPLIED_LOCATION`, `coordinateBasis:
USER_SUPPLIED_COORDINATE`, `verificationStatus: UNVERIFIED`, and the polygon is unverified
community-mapped OSM geometry at 6–7 decimal places.

This repository's own map layer already says so. `ARCHITECTURE.md:321-328` classifies anything
within **25 m** of the perimeter as `UNCERTAIN`, on the stated reasoning that *"a point 1 m outside
an unverified line is not evidence the thing is off campus, it is evidence that we do not know"* —
and records RNSIT as **"7 inside, 2 outside (Main Gate +33 m, Playground 1 +58 m), 2 uncertain
(Parking Lot +1 m, CANARA BANK −22 m)."**

**These two classifications do not contradict each other and neither is being retracted.** They are
different instruments answering different questions: the map layer asks *"do we know where this is?"*
and the boundary decision asks *"is it serviceable?"* Under §1 the polygon is authoritative and
tolerance is zero, so the parking lot is out. That is the owner's decision and it stands as written.

What must not be lost is the symmetric half: **`rnsit-canara-bank` is *inside* by only 22.0 m**, also
within the 25 m uncertainty band. So GAP-1 cuts both ways — one exclusion and one inclusion rest on
margins the repository's own map declares unknowable. A site survey settles both; nothing on this
tree can.

### 8.2 The adopted boundary is unverified OSM geometry — GAP-2

`way/1120154292` has never been checked against the physical site. The `VERIFIED_BY_USER` record at
`ARCHITECTURE.md:110` is a map-data provenance statement dated 2026-08-23 for the RNSIT campus
dataset; it is not a survey of this perimeter as a serviceable-area boundary, and it does not become
one by being cited here.

### 8.3 V-9 / D2-residual will fire on this boundary — GAP-3

The adopted polygon is **0.0998 km²**. `FINE_CELL_BAND` in `regionBoundary.js` is `1000 … 100000`
fine cells — a band on the **count**, independent of which resolution produces it — and
`d2ResidualCheck()` returns `INVALID` outside that band. A campus of this size cannot reach the
lower bound at res 8.

> **Still true at the adopted resolution — annotated 2026-09-19.** At `FINE` = H3 resolution 11
> (ADR-35) the adopted boundary yields **45** centre-contained cells and **64** under the D6 index
> cover. Both are still below the band's lower bound of 1 000, so **GAP-3's prediction holds and is
> now the operative one**: V-9 fires and the declared `cardinalityException` is its documented
> discharge. What the 2026-08-30 note below got wrong was only *which* condition binds — it named
> V-8 (empty cover), which no longer applies. See the supersession box after that note.

**No H3 computation was performed here** — the owner instructed otherwise, and this row is a
predicted exposure, not a measurement. When it is measured, `d2ResidualCheck()`'s own note assigns
the resolution question to **Architecture**: *"which way to resolve it is Architecture's, on this
evidence — it is not resolved here."* It is not a defect in this boundary decision and must not be
routed back to whoever supplied a valid boundary.

> **MEASURED UPDATE, 2026-08-30 — GAP-3's prediction was directionally right and named the wrong
> check.** The cover was derived for JSSATE (0.1022 km², the same scale as RNSIT's 0.0998 km²) from
> a pinned snapshot with `h3-js@4.5.0` at the resolutions then in force (**fine 8 / coarse 5**).
> Standard `polygonToCells`
> returns **0 fine cells**, because a res-8 cell averages 0.7373 km² and no cell centre falls inside
> a polygon roughly one seventh that size. **The binding failure is therefore V-8 (empty cover), not
> V-9** — and `cover.cardinalityException` **cannot** rescue it, because that exception is read only
> inside the V-9 branch, which is itself guarded by `fineCells.length > 0`
> (`regionBoundary.js:548-566`). There is no V-8 exception mechanism. The owner has since **refused**
> both over-assigning containment modes and escalated the coverage-semantics question, and **the
> escalation target is NOT DEFINED**. RNSIT is behind the same blocker on the same arithmetic.
> Measurements, refusals and consequences:
> [`B1_EXTERNAL_INPUT_HANDOFF.md`](../phase15/B1_EXTERNAL_INPUT_HANDOFF.md) §1.8.3–§1.8.5. **This
> note corrects a predicted exposure in §8.3 only; §1's decision is untouched.**

> **⚠ THE NOTE ABOVE IS SUPERSEDED — annotated 2026-09-19. §1's boundary decision is NOT affected.**
>
> **What still stands, unchanged:** §1's adoption of `way/1120154292` **verbatim and unmodified**,
> the parking-lot exclusion by 0.7 m, the prohibition on buffering, enlargement or simplification,
> and every refusal recorded in this document. **This annotation changes no owner decision.** It
> corrects an *engineering measurement note* whose premise — H3 fine = resolution 8 — was later
> changed by a different owner decision.
>
> `RD-2026-09-14-01` **D2** (ADR-35) adopted **`FINE` = H3 resolution 11**. Re-measured on the
> adopted geometry:
>
> | | res 8 (the note above) | res 11 (**adopted**) |
> |---|---|---|
> | RNSIT `way/1120154292` | 0 fine cells | **45** centre-contained · **64** D6 index |
> | JSSATE `way/1120154290` | 0 fine cells | **43** centre-contained · **69** D6 index |
> | Binding condition | **V-8** | **V-9** |
> | `cardinalityException` | cannot rescue (V-9 never runs) | **applies** — the documented discharge |
>
> So *"the binding failure is therefore V-8, not V-9"* is now **inverted**: V-8 does not fire on a
> non-empty cover, and the applicable condition is **V-9**, which the declared
> `cardinalityException` is designed to discharge. *"There is no V-8 exception mechanism"* remains
> true as mechanics, but is no longer the operative constraint.
>
> *"The escalation target is NOT DEFINED"* is also no longer load-bearing for this item: the
> coverage-semantics question was decided by `RD-2026-09-14-01` **D6** — `containmentOverlapping`
> permitted as **index membership only**, conferring **no** delivery-domain membership, with
> `containmentOverlappingBbox` **still REFUSED**. **No approval or escalation authority was invented
> to reach that**; the owner's refusal was narrowed in scope, explicitly and on the record, never
> overturned. Non-campus ground remains non-serviceable — now refused per destination by the
> exact-coordinate geofence pinned on `Stop.geofenceResult`, which is strictly tighter than a cover
> could be.
>
> **Still an owner act, and not claimed as done here:** writing the `cardinalityException`
> declaration. See [`ADR-35`](../adr/ADR-35-v1-fine-cell-resolution.md) and
> [`RD-2026-09-14-01`](RD-2026-09-14-01-v1-two-layer-spatial-model.md).

### 8.4 Two-campus region modelling is unresolved — GAP-4

The D1 seam assesses exactly one `region` per deployment module, and `regions[]` is
disjointness-only. RNSIT + JSSATE is therefore either one `regionId` with a two-part MultiPolygon or
two shards / two deployment modules. **This record decides RNSIT's geometry only and deliberately
does not decide that.**

### 8.5 No gate/entrance is inside the serviceable area — GAP-5

With `rnsit-main-gate` excluded by §5, the adopted boundary contains **no mapped gate, entrance or
barrier at all**. §5 settles that robots need not route to the gate; it does not state how a fleet
physically enters and leaves the site. That question is now open and is Operations'.

---

## 9. Can the RNSIT OSM FeatureCollection be snapshot-pinned "in the same manner as JSSATE"?

**Short answer: yes — and it already is, to exactly the same degree JSSATE is, which is less than
the question presumes.**

**There is no JSSATE snapshot-pin record in this repository.** Searched 2026-08-30: no document under
`docs/` mentions JSSATE except `Frontend/src/features/maps/ARCHITECTURE.md`; no snapshot-pinning
mechanism, manifest, hash file or pin record exists for either campus. The word "pinned" in
`Frontend/src/features/maps/__architecture__/*.test.mjs` refers to *behavioural* assertions about the
importers, not to a pinned data snapshot. Whatever JSSATE pinning was discussed previously was never
written to this tree, so there is no established procedure here to imitate.

What both campuses *actually* have today is identical in kind:

| Pin property | RNSIT | JSSATE |
|---|---|---|
| Tracked in git at a fixed blob | yes — `a82f61e3…` | yes |
| SHA-256 recordable | `04cb64c420…` | `43be2a1af8…` |
| Export timestamp in-file | `2026-08-23T04:59:06Z` | present |
| Declared CRS / version / approver | **none** | **none** |
| Verification status | `VERIFIED_BY_USER` (map data, 2026-08-23) | `NOT_VERIFIED` — nobody has been |

So RNSIT is pinnable on exactly the same terms, and §2 of this record performs that pin: content
named by blob and SHA-256, feature named by id, geometry properties measured and stated.

**Two limits on what that pin buys, which must not be collapsed:**

1. **A snapshot pin is an integrity control, not an authority control.** It proves the bytes have not
   drifted. It does not supply a `crs`, a `regionId`, a `version`, an approver, or a commercial
   commitment, and it does not convert a `FeatureCollection` into something V-1 accepts. All four
   §7 obstacles survive a perfect pin.
2. **RNSIT's `VERIFIED_BY_USER` status does not transfer to JSSATE**, and JSSATE's `NOT_VERIFIED`
   status is not lowered by RNSIT being pinned alongside it. `ARCHITECTURE.md:690-694` makes this
   explicit: the owner's RNSIT confirmation *"is a dated, attributed record scoped to RNSIT and does
   not reach it."*

If a stronger pin is wanted than §2 provides, the honest next step is a checked-in manifest binding
`{path, blob, sha256, feature id, adopted-by decision id}` for both campuses — a small, verifiable
artefact. It was **not** created here, because it was not asked for and because it would still not
move D1.

---

## 10. Why this record has no `.json` twin

`RD-2026-08-18-01` has a machine-readable JSON companion because a gate reads it.
`Backend/tools/gates/checkColumnGeneration.js:108` scans **every** `.json` in
`docs/release-decisions/`, and `classificationProblem()` rejects any document whose `section` is not
`"§21.6"` or whose `path` is not one of the column-generation modules
(`checkColumnGeneration.js:131-134`).

A JSON companion for this boundary decision would therefore be permanently listed in that gate's
`rejected` output, and would become an outright **gate failure reason** the moment any
column-generation module changes (`checkColumnGeneration.js:393-396`). Planting a standing false
alarm inside a working gate is how gates get routed around. **This record is Markdown only, by
design.** No consumer reads it mechanically, and none is claimed to.

---

## 11. Nature of this decision

- It is a **project-owner declaration of intent**, recorded in version control and pinned to the
  content it adopts.
- It **withdraws** five previous statements and **replaces** one Option-2 resolution with Option 1,
  explicitly rather than by omission (§3).
- It **does not** discharge D1, does not unblock B1, does not create or authorise any deployment
  module, and does not select a routing engine.
- It **does not** manufacture a green result anywhere. `routing:readiness` was not run; had it been,
  Step 5's status is the literal constant `BLOCKED` by design.
- Its factual premises — three points outside, and which three — were **independently recomputed**
  from the data on this tree rather than accepted on assertion, and they hold exactly.
- The one place where the repository's own map layer disagrees numerically with the decision's
  consequence is stated in §8.1 rather than reconciled away in either direction.

If `rnsit-campus-osm.geojson` changes by one byte, blob `a82f61e35a8445f9ee818cb8a24f0dcfc8412341`
no longer resolves, and every geometric statement in §2.1 and §4.1 must be re-measured before this
record is relied on again.
