# RD-2026-09-14-01 — V1 two-layer spatial model (D1 – D7)

| | |
|---|---|
| **Recorded** | 2026-09-14 |
| **Owner** | Project owner |
| **Subject** | The V1 spatial model: what an H3 cell means, what decides delivery-domain membership, and where each is evaluated |
| **Scope** | RNSIT V1. JSSATE is untouched by this record |
| **Reviewed input** | *Two-Layer Spatial Model Impact Analysis* (read-only, 2026-09-14) and the resolution-11 experimental worktree |
| **Records** | **ADR-35** (D2, resolution) · **ADR-36** (D1/D6/D7, the two layers) |
| **Specification amendments** | `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` **§3.6**, **§6.2**, **§20.3** — see §D3 |
| **Status of B1 / D1(routing)** | **Unchanged — still BLOCKED.** This record decides a model; it supplies no external input |
| **V1 stop conditions** | **Unchanged at 3 of 8.** See §9 |

---

## 0. Why this record exists

Two questions had been answered by one mechanism, and the conflation was invisible because
for a large region the two answers usually agree. They do not agree at campus scale.

* *"Which index bucket is this point in?"* — a cheap, arithmetic question, asked constantly,
  answered by an H3 cell.
* *"Is this destination inside the area RobotX has committed to serve?"* — a commercial and
  safety question, asked once per destination, answerable only against published geometry.

Deriving the second from the first is what produced every open spatial blocker: an empty
cover at resolution 8, 10.34 % of RNSIT unrepresentable at resolution 11, and a standing
refusal of boundary-overlapping cells that could not be relaxed without over-assigning
non-campus ground. This record separates the two questions.

---

## D1 — The two-layer spatial model

**Adopted.**

> **H3 is the indexing, caching and candidate-expansion representation. The exact
> coordinate is the authoritative delivery-domain membership test.**
>
> **An H3 cell does NOT itself establish that the contained area is inside the RobotX
> delivery domain.**

For an actual destination:

```
exact coordinate
    ↓
authoritative delivery-domain geofence
    ↓
outside → VIOLATED → DENY
inside  → continue
    ↓
routing / serviceability
    ↓
assignment
```

**The exact-coordinate verdict is evaluated at intake/seal and pinned. It is NOT recomputed
against polygon geometry inside a coordinator round.** This is what keeps D1 compatible with
**ADR-28**, whose decision text is *"containment by published assignment, **not by
query-time geometry**"*. Evaluating the polygon per round would contradict that verbatim and
would require the architecture to be unfrozen, which this record does not do.

Therefore:

* **No query-time polygon geometry inside F33 or `serviceabilityFor`.**
* **No cell → zone/region containment derived from polygon geometry.**

Serviceability becomes a conjunction:

```
serviceable = assigned ∧ inDeliveryDomain ∧ routable
```

evaluated under the existing three-answer discipline, unchanged:

| | |
|---|---|
| absent information | **INDETERMINATE** |
| definite outside | **VIOLATED** |
| definite valid | **SATISFIED** |

**Never default absent domain information to true. Never default absent geofence
information to "inside". Never default absent routing information to routable.**

---

## D2 — H3 resolution

**Adopted.** `FINE = H3 resolution 11`. `COARSE = H3 resolution 5`.

No further resolution search. No per-region resolution overrides. No second spatial
indexing system. Recorded as **ADR-35**.

---

## D3 — Specification amendment (Option 3B)

**Approved.** The generic/default fine scale remains approximately 200–500 m, **and** a
bounded deployment whose physical extent makes that default unsuitable **may** adopt a finer
fine-cell resolution through an **explicitly declared spatial model**.

A declared model **must** name:

1. its indexing primitive;
2. its fine resolution;
3. its coarse resolution;
4. the spatial verification evidence it requires.

and must be verified for **coverage, safety, determinism, performance and privacy** before
publication.

**All three frozen locations are amended coherently:**

| Location | What was false | What it now says |
|---|---|---|
| **§3.6** | the fine scale stated unconditionally as ~200–500 m | the generic scale, plus the declared-model exemption |
| **§6.2** | the same size clause, restated for the index | the same amendment, in the index's terms |
| **§20.3** | *"**Because** cells are ~200–500 m, the cache is small … and its hit rate is high"* — an **argument** whose premise the resolution change deleted | the hit rate is a property of the declared model and the deployment's traffic, and is **measured against the target**, not inherited from cell size |

**§20.3 no longer inherits a high cache hit rate from the default cell size.** Amending §3.6
alone would have left a conclusion standing with its premise removed.

**The 10³–10⁵ cardinality rule itself is NOT weakened.** RNSIT's out-of-band count is
carried by the **already sanctioned `cover.cardinalityException`** mechanism
(`B1_EXTERNAL_INPUT_HANDOFF.md` §1.8.4 item 1), on the recorded reasoning that this is a
deliberately small bounded deployment whose physical scale the generic envelope does not
represent. **No second exemption mechanism is created.**

---

## D4 — Versioned spatial cutover

**Adopted.** A spatial-model change is a **versioned cutover event**.

* **A historical H3-8 token is never reinterpreted as H3-11.** Historical identities retain
  their historical identity.
* Active V1 identities use the currently published spatial model.
* Where coordinates survive: `AgentCellPosition` is **recomputed**; `Stop.fineCell` **may**
  be recomputed.
* Where a `Stop` coordinate was permanently erased (§23.7): **do not reconstruct, do not
  reinterpret, leave it foreign, and fail closed if any reader attempts to use it.**
* **No schema discriminator is introduced** to duplicate the resolution an H3 token already
  encodes. Provenance for artefacts carrying no token uses **`mapVersion`** where it already
  exists.

---

## D5 — Intra-cell offset

**`route.intra_cell_offset_m` is HELD AT 250 m. It is NOT changed to 58 m.**

Two quantities were being conflated, and the record separates them permanently:

| | |
|---|---|
| **H3-11 geometric diameter** | ≈ **57.33 m** — a straight-line bound on within-cell error |
| **Operational within-cell network correction** | **250 m** — the distance actually travelled inside a cell, which follows the road network |

Network distance is never below straight-line, so the geometric diameter is provably a
**lower bound** on the correction required, never the correction itself. Adopting it would
have been a move in the **less conservative** direction on a value that feeds
`chargerReachabilityCache` → `eReturn` → reserves → **F34/F35**.

**250 m remains `PROVISIONAL`. It is not calibrated and must not be described as
calibrated.** Its `awaits` text is corrected: it no longer waits on the H3 edge-length
decision — that is settled, and settling it did not calibrate this parameter. **It awaits
legitimate network-distance / circuity evidence, which is not fabricated here.**

**The runtime must not silently treat 58 m as an adequate operational network correction.**

---

## D6 — Boundary-overlapping index cells

**OWNER DECISION: boundary-overlapping H3 cells are PERMITTED as INDEX MEMBERSHIP. They do
NOT confer delivery-domain membership.**

**This is the critical semantic distinction in this record.**

The published H3 index may therefore include cells that intersect the RNSIT boundary even
where the H3 centre is outside the campus and part of the cell's area lies outside it. This
is allowed **only** because H3 is an index.

For every actual destination:

* the exact coordinate geofence remains authoritative;
* an outside coordinate → **VIOLATED**;
* an inside coordinate → may proceed to routing/serviceability.

**Never infer** *"cell indexed ⇒ point is in campus"*.
**Never infer** *"cell intersects campus ⇒ cell is serviceable"*.
**Never use boundary overlap to authorise an outside destination.**

### D6.1 Relationship to the standing `containmentOverlapping` refusal

`B1_EXTERNAL_INPUT_HANDOFF.md` §1.8.4 item 2 records a standing refusal of
`containmentOverlapping` and `containmentOverlappingBbox`, on the stated ground that *"the
owner does not authorise geographic over-assignment of non-campus area into a RobotX
region"*.

**That refusal is NOT deleted and NOT overturned. Its scope is narrowed, explicitly.**

| | |
|---|---|
| **What the refusal was against** | **geographic over-assignment** — treating non-campus ground as RobotX service area |
| **What D6 permits** | **index buckets** — cells used for lookup, caching and candidate expansion, which make no claim about the ground they cover |
| **What still holds** | non-campus ground is still not serviceable. It is now refused **by the coordinate test**, per destination, instead of by the shape of the cover |
| **`containmentOverlappingBbox`** | **still REFUSED.** D6 extends to boundary-*overlapping* cells only, not to a bounding-box cover |

The refusal's original concern is **satisfied more strictly than before**, because it is now
enforced on the actual destination coordinate rather than on a cover that could only ever
approximate it.

---

## D7 — Delivery-domain declaration

**The authoritative delivery-domain declaration is a DISTINCT S-3 external input. It is not
hidden inside the existing `CellAssignment` input.**

**S-3 gains row 29.**

| Row | Input | What it is |
|---|---|---|
| **26** | `CellAssignment` | cell → zone / site / region attribution — the **index**, which §8.3's `λ_zone` and the pricing hierarchy read |
| **29** | **Delivery-domain declaration** | signed/published geometry · CRS · version identity · **owner declaration** |

The adopted RNSIT boundary geometry (`RD-2026-08-30-01`, `way/1120154292`) **may be used as
the development artefact**. It must **not** be treated as the production owner declaration:
an unsigned development artefact is not a signed declaration, and
`B1_EXTERNAL_INPUT_HANDOFF.md` §1.8.5 records that **no validator can discharge that** — a
human must read it.

**The V1 contract must state that this declaration is required for D1/F33 to be decidable.**

---

## 8. What this record does NOT do

* It supplies **no external input**. B1 remains BLOCKED; D1(routing), D3 and D8 are unmoved.
* It does **not** supply `snapRadiusM` (**R13**). The measured worst cell-centre snap of
  137.7 m is evidence *for* that decision, not the decision. **R13 remains an owner/external
  input**, and a value must not be chosen because a measurement looks reasonable.
* It does **not** discharge §20.3's >95 % cache hit-rate target. See §9.
* It does **not** unfreeze the architecture. ADR-28 is untouched and uncontradicted.
* It creates **no** new privacy rule. `geofenceResult` was already one of §23.7's six
  declared derived quantities; no seventh field is exempted.

---

## 9. Consequences the owner is accepting, stated plainly

1. **F33 cannot be SATISFIED until R13 is supplied.** The `routable` conjunct has no
   producer in `src/`; `snapRadiusM` exists only in the B1 deployment module. With a perfect
   index and a perfect declaration, serviceability is still absent and F33 still denies.
   This is **stricter** than the previous behaviour, which asserted routability by omission.
2. **§20.3's >95 % cell-pair cache hit-rate target is NOT met at resolution 11** under the
   measured declared workload — 11 %–87 % across arrival rates from 0.1 to 10 req/s, against
   95 %+ at resolution 8. The target is **not** adjusted. Recorded as an open item.
3. **`route.intra_cell_offset_m` stays uncalibrated** and is PROVISIONAL.
4. **V-5's axis-order check cannot detect a transposed RNSIT file** (lon 77.5 / lat 12.9
   both being possible latitudes). The mitigation is the D7 attestation — a human reading
   the declaration — not code.

---

## 10. Machine-readable record

**None, deliberately** — matching `RD-2026-08-30-01`'s reasoning. The declaration this
record *describes* is the machine-readable artefact, and it is the owner's to publish and
sign, not this repository's to synthesise.
