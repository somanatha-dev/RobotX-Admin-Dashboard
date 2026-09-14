# ADR-35 — V1 fine-cell resolution

| Field | Value |
|---|---|
| **Status** | **Accepted** |
| **Kind** | **Integration decision under a frozen architecture** |
| **Recorded** | 2026-09-14 |
| **Owner decision** | [`RD-2026-09-14-01`](../release-decisions/RD-2026-09-14-01-v1-two-layer-spatial-model.md) **D2** |
| **Specification** | `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` §3.6, §6.2, §20.3 (all three **amended** by the same decision — see *Dependency*) |
| **Decision area** | The H3 resolution each §3.6 band maps to |
| **Frozen record it serves** | [ADR-28](ADR-28-spatial-hierarchy.md) — not contradicted, not amended |

## Context

§3.6 names two cell scales and §6.2 names the primitive; neither names a resolution.
Phase 9 settled B5 as H3 and chose **resolution 8** (≈531 m/edge) as "the nearest fit
outdoors" to the then-unqualified "~200–500 m" fine band.

That value cannot be used for the region RobotX actually deploys into, and the reason is
arithmetic rather than preference. `way/1120154292` — the RNSIT boundary `RD-2026-08-30-01`
adopts unmodified — is **0.0995 km²**, roughly one seventh of a single resolution-8 cell.
Measured with centre containment:

| resolution | edge | accepted cells | campus ground covered |
|---:|---:|---:|---:|
| 8 | 531.41 m | **0** | 0 % |
| 9 | 200.79 m | **0** | 0 % |
| 10 | 75.86 m | 5 | 67.8 % |
| **11** | **28.66 m** | **45** | **89.66 %** |

An empty cover fails **V-8**, so at resolution 8 or 9 the region cannot be published at
all. Resolution 10 is the trap rather than the answer: it yields a cover that looks valid
while leaving `rnsit-canara-bank`, an in-campus point, permanently unindexed.

## Decision

**`FINE` = H3 resolution 11. `COARSE` = H3 resolution 5, unchanged.**

One global pair. **No per-region resolution override**, no third resolution class, and no
second spatial indexing system.

The pair is published as a **declared spatial model**, `SPATIAL_MODEL` in
`spatial/cells.js`, with identity `H3-F11-C5`, naming its primitive, both resolutions, and
the verification evidence §3.6's amended clause requires of a declared model.

## Rejected

* **Resolution 8 or 9** — an empty cover; the region cannot be published (V-8).
* **Resolution 10** — strands an in-campus verification point while appearing valid.
* **Resolution 12 or finer** — covers more ground and admits `rnsit-parking-lot`, measured
  outside the adopted perimeter, into the centre-contained cover. Finer is not monotonically
  safer.
* **A per-region resolution override** (§6.2 mentions the possibility) — one global pair is
  simpler to reason about, and `B1_EXTERNAL_INPUT_HANDOFF.md` §1.8.4 item 1's parenthetical
  already records that a per-region override is not the sanctioned mechanism for the
  cardinality residual.
* **A second spatial indexing system beside H3** — two indexes are two answers.

## Dependency — discharged by the same decision

An earlier form of this record was **defective by `docs/adr/README.md`'s own rule**: a
resolution-11 cell is ≈49.6 m across, §3.6's fine clause read "~200–500 m" unconditionally,
and *"where a record and the specification disagree, the specification wins and the record
is defective"*.

`RD-2026-09-14-01` **D3** resolves this at the specification, not in this record: §3.6, §6.2
and §20.3 are amended together so that the generic fine scale remains ~200–500 m **and** a
bounded deployment may adopt a finer fine cell through an explicitly declared spatial model.
`SPATIAL_MODEL` is that declaration. **This record is no longer defective, and it is the
amendment rather than this record that made it so.**

## Consequences

1. **V-8 passes for RNSIT for the first time.** No validator was changed to achieve it.
2. **V-9 still fires** — 45 (or 64 under D6) fine cells is far below §3.6's 10³ floor. The
   sanctioned mechanism is a declared `cover.cardinalityException`. **The band is not
   weakened and no second exemption mechanism exists.**
3. **V-10 and A6 now enforce resolution 11.** They derive the resolution rather than
   hard-coding it, so they were re-pointed, not relaxed: a resolution-8, -9, -10 or -12
   token is refused **by name**.
4. **D2's residual still reports `fits: false`** for a campus, correctly. It was deliberately
   not taught to accept `cardinalityException`: V-9 is where a declared exception is read.
5. **The FINE→COARSE span widens to six levels** (7⁶ = 117 649 children). `fineChildrenOf`
   has no production caller and must not acquire one that enumerates the full child list.
6. **A persisted resolution-8 token decodes to `null`, never to `FINE`.** There is **one
   production decoder**, `resolutionOfH3Cell`, and exactly four enforcement points built on
   it: the decode itself; `coarseParentOf` refusing rather than coercing;
   `hierarchy.indexMap().resolve()` returning `assigned: false`; and V-10 / A6 refusing such
   a cover at publish. **No fifth layer exists.** Wrapper predicates over the decode were
   written for this model and removed in the 2026-09-14 pre-commit audit: they had no
   production caller, added a name and no behaviour, and a guard that restates a check
   already made is a guard whose absence nobody notices. See `RD-2026-09-14-01` **D4**.
7. **§20.3's cache hit rate must now be measured, not inherited** — see D3 and
   `tools/verify/spatialCacheHitRate.js`. At resolution 11 the target is **not met** under
   the measured declared workload. Recorded, not adjusted.
8. **No schema change.** An H3 index encodes its own resolution.

## Changing this record

This record is an integration decision under a frozen architecture. It is superseded only by a
later integration record that names it. It may never contradict a frozen record, and it does
not: ADR-28 is untouched.
