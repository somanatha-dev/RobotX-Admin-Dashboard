# ADR-36 — Two-layer spatial model: index vs delivery domain

| Field | Value |
|---|---|
| **Status** | **Accepted** |
| **Kind** | **Integration decision under a frozen architecture** |
| **Recorded** | 2026-09-14 |
| **Owner decision** | [`RD-2026-09-14-01`](../release-decisions/RD-2026-09-14-01-v1-two-layer-spatial-model.md) **D1**, **D6**, **D7** |
| **Specification** | `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` §3.6, §7.5 (F33), §23.7 |
| **Decision area** | What an H3 cell means, what decides delivery-domain membership, and where each is evaluated |
| **Frozen record it serves** | [ADR-28](ADR-28-spatial-hierarchy.md) — **not contradicted, not amended, not superseded** |
| **Related** | [ADR-35](ADR-35-v1-fine-cell-resolution.md) (the resolution), [ADR-11](ADR-11-routing.md) (self-hosted routing) |

## Context

§3.6 calls a cell *"the **index and cache** unit"* and separately requires that containment
be *"by assignment, not by geometry"*. In practice one mechanism — the published cell cover
— was answering two different questions:

* *"Which index bucket is this point in?"* — arithmetic, asked constantly.
* *"Is this destination inside the area RobotX has committed to serve?"* — a commercial and
  safety question, asked once per destination.

For a metro-scale region the two answers largely agree, and the conflation is invisible. At
campus scale they do not agree, and every open spatial blocker was a symptom:

* an **empty** cover at resolution 8 (V-8);
* **10.34 %** of RNSIT unrepresentable at resolution 11 under centre containment, failing
  closed to `INDETERMINATE`;
* a standing refusal of boundary-overlapping cells that could not be relaxed without
  over-assigning non-campus ground as service area.

Meanwhile `Stop.geofenceResult` — one of §23.7's six declared derived quantities — existed
in the schema and **nothing wrote it**, and F33's own frozen rationale claimed intake
applied a coordinate rule that no code performed.

## Decision

**H3 is the index. The exact coordinate is the delivery domain. They are separate layers,
and neither answers the other's question.**

1. **An H3 cell's presence in the published index does not establish that the ground it
   covers is inside the RobotX delivery domain.** *(D1)*
2. **Boundary-overlapping cells are permitted as index membership** — including cells whose
   centre is outside the campus and part of whose area is outside it. They confer **no**
   delivery-domain membership. *(D6)*
3. **Membership is decided by a deterministic point-in-polygon test on the exact
   coordinate**, against an authoritative published geometry, evaluated **once at
   intake/seal** and **pinned** on `Stop.geofenceResult`. *(D1)*
4. **The coordinator consumes the pinned verdict and performs no geometry.** *(D1)*
5. **Serviceability is a three-valued conjunction**:
   `serviceable = assigned ∧ inDeliveryDomain ∧ routable`. *(D1)*
6. **The delivery-domain declaration is a distinct external input** — S-3 **row 29**, a
   sibling of the `CellAssignment` input and never folded into it. *(D7)*

## Rejected

* **Deriving delivery-domain membership from cell membership** — the conflation above. It
  is the reason a 0.0995 km² campus had no publishable cover at all.
* **Evaluating the polygon inside the coordinator round.** This would contradict **ADR-28**
  verbatim (*"containment by published assignment, not by query-time geometry"*) and §3.6's
  stated reason (*"floating-point geometry evaluated per round … is both slow and
  non-deterministic (T6)"*). It would require the architecture to be unfrozen. Pinning at a
  lifecycle boundary and reading the pin is what makes the two layers compatible with the
  frozen record.
* **Duplicating the verdict-producing logic.** One deterministic primitive
  (`spatial/deliveryDomain.js`), one call site. Two producers of one verdict is two verdicts.
* **A second `Stop` column for the verdict.** `geofenceResult` already exists and is already
  one of §23.7's declared six; adding a field would have widened the privacy enumeration to
  seven for no gain.
* **Folding the declaration into the `spatial` payload.** That would let an index
  publication silently redefine the delivery domain, which is the conflation this record
  ends.
* **`containmentOverlappingBbox` as an index.** Still refused. D6 extends to boundary-
  *overlapping* cells only.
* **Treating an unsigned development artefact as the owner declaration.** Reported as
  unattested, every time.

## Consequences

1. **100 % of campus ground becomes representable.** Measured on a 0.7 m raster: the
   centre-contained cover reaches **89.660 %** (10 277 m² unreachable); the D6 index cover
   reaches **100.000 %**. The previously escalated *"whole-campus coverage is unachievable at
   any resolution"* finding was a property of **centre containment**, not of H3.
2. **The index overlays 30 088 m² of non-campus ground, and every point in it is DENIED**
   by the coordinate test. Safety comes from the coordinate, not from the cover being tight.
   This is the trade the owner is making explicitly.
3. **F33 cannot be SATISFIED until R13 (`snapRadiusM`) is supplied.** The `routable`
   conjunct has no producer on the decision path. This is **stricter** than the previous
   behaviour, which asserted routability by omission, and it is fail-closed.
4. **A definite `OUTSIDE` still refuses even while `routable` is absent** — three-valued
   conjunction returns false as soon as any term is false.
5. **An unassigned cell remains `INDETERMINATE`, never `VIOLATED`** (§M.2). Both deny; only
   one tells the truth about why.
6. **`Stop.geofenceResult` is written even when the verdict is `INDETERMINATE`.** An absent
   column and a recorded "no declaration was published when this was sealed" are different
   facts, and only the second is auditable.
7. **An unrecognised pinned value is read as absent** — never as inside, never as outside.
8. **A spatial-model cutover does not invalidate a pinned verdict.** The verdict is a
   coordinate against a geometry and contains no cell. Re-taking one is a *domain*
   republication, a different event with a different owner.
9. **F33's logic is unchanged.** It still reads `stop.serviceable` three-valued. What
   changed is that the value it is handed no longer conflates index membership with domain
   membership.
10. **`CellAssignment` is unchanged and still required.** It remains responsible for cell →
    zone/site/region attribution, which §8.3's `λ_zone` and §3.6's pricing hierarchy have no
    other source for. §M.2 stays the `CellAssignment` contract.
11. **A7** is added at publish: a malformed published declaration is BLOCKING (it would
    otherwise deny every request in the region indefinitely while appearing configured); an
    unattested one is a WARNING, because `B1_EXTERNAL_INPUT_HANDOFF.md` §1.8.5 records that
    no validator can discharge a signature.

## Changing this record

This record is an integration decision under a frozen architecture. It is superseded only by a
later integration record that names it. It may never contradict a frozen record, and it does
not: **ADR-28 is untouched and uncontradicted** —
this record is the mechanism by which containment-by-published-assignment continues to hold
while the delivery domain becomes decidable.
