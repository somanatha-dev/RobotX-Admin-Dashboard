"use strict";

/**
 * Cells (§3.6, §6.2).
 *
 * > **Cell** — the **index and cache** unit: a discrete geospatial cell (H3/S2).
 * > The generic fine scale is ~200–500 m and the coarse scale ~5–10 km; a bounded
 * > deployment whose physical extent makes the generic fine scale unsuitable MAY
 * > adopt a finer fine-cell resolution through an explicitly declared spatial model
 * > (§3.6, §6.2). A fine cell lies in exactly one zone **by assignment**, not by
 * > geometry.
 *
 * ── A cell is an index bucket, never a delivery-domain claim (D1, D6) ────────
 * §3.6 calls a cell "the **index and cache** unit", and RD-2026-09-14-01 makes that
 * exact and binding: **an H3 cell being present in the published index does not
 * establish that the ground it covers is inside the RobotX delivery domain.** The
 * authoritative membership test for an actual destination is the exact coordinate
 * against the published delivery-domain geometry — `spatial/deliveryDomain.js`,
 * evaluated once at intake/seal and pinned on `Stop.geofenceResult`.
 *
 * Two inferences are therefore forbidden outright, and both are the kind an
 * implementation makes by accident:
 *
 *   · *"the cell is indexed, so the point is in the campus"* — **NO.**
 *   · *"the cell intersects the campus, so the cell is serviceable"* — **NO.**
 *
 * Nothing in this module answers a delivery-domain question, and nothing in it may
 * be made to.
 *
 * ── What this module deliberately does not do ────────────────────────────────
 * It computes no geometry. Choosing the spatial index primitive — H3 versus S2
 * versus site-local graph zones — is **blocking decision B5**, which the plan
 * assigns to Phase 9. Phase 2 does not need it and must not pre-empt it, because
 * §3.6 already settles the only question Phase 2 has to answer:
 *
 * > **Containment is by assignment, not by geometry.** A zone is defined as a *set
 * > of fine cells*, and a site as a *set of fine cells plus its indoor graph zones*.
 * > Deriving containment from polygon intersection at query time would make a cell's
 * > zone depend on floating-point geometry evaluated per round, which is both slow
 * > and non-deterministic (T6).
 *
 * So a cell id is an **opaque token supplied by the published map**. This module
 * gives it identity, validation, canonical ordering, and the resolution
 * distinction — everything the containment maps and the round snapshot need — and
 * nothing that would have to be rewritten once B5 is settled. Phase 9 adds the
 * primitive wrapper (k-rings, parent/child, geodesic lookup) beside this, not
 * instead of it.
 *
 * ── Phase 9 — B5 settled: H3 ─────────────────────────────────────────────────
 * `IMPLEMENTATION_EXECUTION_PLAN.md` §6.1 B5 resolves the choice: "H3 preferred
 * outdoors for uniform k-ring metrics" (§6.2 gives the same reason — H3's uniform
 * hexagons make k-ring expansion's distance bounds tight, which S2's mixed cell
 * shapes do not). The functions below are a thin wrapper over `h3-js`: nothing
 * upstream of them (the containment-by-assignment functions above, `hierarchy.js`,
 * every published cell/zone/site map) changes, because those were deliberately
 * built against an opaque token and never needed to know which primitive produced
 * it. Only the *outdoor* geodesic case is handled here — §6.2's indoor/multi-level
 * "site-local graph zones" are a distinct, per-region proximity-partition
 * implementation this module does not touch.
 */

const h3 = require("h3-js");
const { compareStrings } = require("../determinism/ordering");

/**
 * The two resolutions §3.6 names. A string rather than a database enum, because the
 * plan's Phase 2 migration group (i) enumerates exactly five new enums and this is
 * not among them.
 * @structural resolution labels, not tunable values
 */
const RESOLUTION = Object.freeze({
  FINE: "FINE",
  COARSE: "COARSE",
});

const RESOLUTIONS = Object.freeze(Object.values(RESOLUTION));

/**
 * @param {unknown} resolution
 * @returns {boolean}
 */
function isResolution(resolution) {
  return typeof resolution === "string" && RESOLUTIONS.includes(resolution);
}

/**
 * A cell id is a non-empty opaque token. It is compared, keyed, and ordered — never
 * parsed for geometry, which is what keeps this module independent of B5.
 *
 * @param {unknown} cellId
 * @returns {boolean}
 */
function isCellId(cellId) {
  return typeof cellId === "string" && cellId.length > 0;
}

/**
 * Normalise a cell id for use as a key.
 *
 * Whitespace is trimmed and nothing else is changed: case is significant in both
 * H3 and S2 token encodings, so lower-casing would silently merge distinct cells.
 *
 * @param {string} cellId
 * @returns {string}
 * @throws {Error} on an unusable id
 */
function normaliseCellId(cellId) {
  if (typeof cellId !== "string") {
    throw new Error(`cell id must be a string, received ${typeof cellId}`);
  }
  const trimmed = cellId.trim();
  if (trimmed.length === 0) throw new Error("cell id is empty");
  return trimmed;
}

/**
 * Canonical order over cell ids (§9.6 requirement 2).
 *
 * Code-unit comparison, host-independent by construction — `localeCompare` depends
 * on the host's ICU data, and a total order whose result depends on where it ran is
 * not a total order for replay purposes.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareCellIds(a, b) {
  return compareStrings(a, b);
}

/**
 * Sort cell ids canonically, returning a new array.
 *
 * @param {string[]} cellIds
 * @returns {string[]}
 */
function canonicalCellOrder(cellIds) {
  return [...(cellIds || [])].sort(compareCellIds);
}

/**
 * The cache key component §20.3's cell-pair travel-time cache is keyed by
 * (`engine:route:cell:{originCell}:{destCell}:{profile}:{bucket}`).
 *
 * Defined here rather than at the cache so that the ordering convention — origin
 * first, destination second, never sorted — is stated once. Travel time is not
 * symmetric: a downhill leg and its uphill return are different queries, and a
 * cache that sorted the pair would answer one with the other.
 *
 * @param {string} originCell
 * @param {string} destinationCell
 * @returns {string}
 */
function cellPairKey(originCell, destinationCell) {
  return `${normaliseCellId(originCell)}:${normaliseCellId(destinationCell)}`;
}

/**
 * Validate a published cell assignment row — one entry of the cell→zone and
 * cell→site maps of §3.6.
 *
 * @param {object} assignment
 * @returns {string[]} problems, empty when well-formed
 */
function validateAssignment(assignment) {
  if (!assignment || typeof assignment !== "object") return ["cell assignment is not an object"];
  const problems = [];
  const id = isCellId(assignment.cellId) ? assignment.cellId : "<unnamed>";

  if (!isCellId(assignment.cellId)) problems.push("cell assignment has no cellId");
  if (!isResolution(assignment.resolution)) {
    problems.push(`cell "${id}" declares resolution "${String(assignment.resolution)}"; §3.6 defines ${RESOLUTIONS.join(", ")}`);
  }
  if (typeof assignment.regionId !== "string" || assignment.regionId.length === 0) {
    problems.push(`cell "${id}" names no region; every cell lies in exactly one region (§3.6)`);
  }
  if (assignment.resolution === RESOLUTION.FINE && !assignment.zoneId) {
    problems.push(
      `fine cell "${id}" names no zone. Every fine cell maps to exactly one zone by published ` +
        "assignment (§3.6); an unassigned fine cell is a hole in the pricing surface",
    );
  }

  return problems;
}

/* ═══════════════════════════════════════════════════════════════════════════
   H3 wrapper (§6.2, §6.3) — Phase 9, B5
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * The H3 resolution each §3.6 band maps to. A discrete resolution choice is an
 * architectural primitive, not a calibratable behavioural constant, so it is
 * `@structural` rather than a register entry — the same status `RESOLUTION` itself
 * already carries above.
 *
 * ── FINE = 11 — ADR-35, RD-2026-09-14-01 (D2) ────────────────────────────────
 * Phase 9 set FINE to resolution 8 (≈531 m/edge) as "the nearest fit outdoors" to
 * §3.6's then-unqualified "~200–500 m" band. That value is **not usable for the
 * region RobotX actually deploys into**, and the reason is arithmetic rather than
 * preference.
 *
 * `way/1120154292` — the RNSIT boundary `RD-2026-08-30-01` adopts unmodified — is
 * **0.0995 km²**. Measured against it with centre containment:
 *
 *     res  8 → 0 cells          res 10 → 5 cells, 67.8% of campus ground
 *     res  9 → 0 cells          res 11 → 45 cells, 89.7% of campus ground
 *
 * An empty cover fails **V-8**, so at resolution 8 or 9 the region cannot be
 * published at all. Resolution 10 is the trap rather than the answer: it produces a
 * cover that looks valid while leaving `rnsit-canara-bank` — an in-campus point —
 * permanently unindexed. **11 is the only resolution that is non-empty and strands
 * no in-campus verification point.**
 *
 * ── What the D3 amendment settles, and what it does not ──────────────────────
 * §3.6 and §6.2 now read that the generic fine scale is ~200–500 m **and** that a
 * bounded deployment may adopt a finer fine-cell resolution through an explicitly
 * **declared spatial model** naming its indexing primitive, its fine and coarse
 * resolutions, and its required verification evidence. `SPATIAL_MODEL` below is that
 * declaration for V1. It does **not** settle the §3.6 cardinality band — 45 cells is
 * far under 10³ and the sanctioned mechanism remains a declared
 * `cover.cardinalityException`, which V-9 reads (see `regionBoundary.js`).
 *
 * COARSE is unchanged: resolution 5 averages ≈9.85 km/edge, squarely inside the
 * "~5–10 km" coarse band. No per-region override exists and none is to be added
 * (RD-2026-09-14-01 D2).
 *
 * @structural ADR-35 / RD-2026-09-14-01 — H3 resolution per §3.6 band, not a tunable value
 */
const H3_RESOLUTION = Object.freeze({
  FINE: 11, // @structural ADR-35 — H3 resolution for §3.6's fine band
  COARSE: 5, // @structural ADR-35 — H3 resolution for §3.6's coarse band, unchanged
});

/**
 * The spatial model's own identity, so a decision record, a published configuration,
 * a diagnostic or a cutover report can **name** which model a body of persisted state
 * was written under instead of inferring it.
 *
 * This is deliberately **not** a new persisted column. An H3 index encodes its own
 * resolution, so *"which spatial model does this persisted cell identity belong to?"*
 * is already answerable from any single token via `resolutionOfH3Cell`, which returns
 * `null` for a token minted under a different model. A discriminator column would
 * store a fact the token already carries, and the fail-closed behaviour comes from
 * the decode, not from a label. Provenance for an artefact that has no token — a
 * route-cache generation, a rebuilt index — is carried by `mapVersion`/`configVersion`
 * where those already exist (RD-2026-09-14-01 D4).
 *
 * `evidence` is the list §3.6's amended "declared spatial model" clause requires a
 * model to name. It is a statement of what must be verified, not a claim that it has
 * been: `PERFORMANCE` and `PRIVACY` are measured elsewhere and one of them —
 * §20.3's cache hit rate — is **not** currently met. See `docs/spatial/`.
 * @structural derived from `H3_RESOLUTION`; never written by hand
 */
const SPATIAL_MODEL = Object.freeze({
  id: `H3-F${H3_RESOLUTION.FINE}-C${H3_RESOLUTION.COARSE}`,
  primitive: "H3",
  fine: H3_RESOLUTION.FINE,
  coarse: H3_RESOLUTION.COARSE,
  adr: "ADR-35",
  decision: "RD-2026-09-14-01",
  evidence: Object.freeze(["COVERAGE", "SAFETY", "DETERMINISM", "PERFORMANCE", "PRIVACY"]),
});

/**
 * @param {string} resolution one of `RESOLUTION`
 * @returns {number} the H3 resolution it maps to
 * @throws {Error} on an unrecognised resolution label
 */
function h3ResolutionOf(resolution) {
  if (resolution === RESOLUTION.FINE) return H3_RESOLUTION.FINE;
  if (resolution === RESOLUTION.COARSE) return H3_RESOLUTION.COARSE;
  throw new Error(`h3ResolutionOf: unknown resolution "${String(resolution)}"; §3.6 defines ${RESOLUTIONS.join(", ")}`);
}

/**
 * @param {unknown} lat
 * @param {unknown} lon
 * @returns {boolean}
 */
function isFiniteCoordinate(lat, lon) {
  return (
    // @structural WGS84 latitude range
    typeof lat === "number" && Number.isFinite(lat) && lat >= -90 && lat <= 90 &&
    // @structural WGS84 longitude range
    typeof lon === "number" && Number.isFinite(lon) && lon >= -180 && lon <= 180
  );
}

/**
 * The H3 cell containing `(lat, lon)` at the given §3.6 resolution band.
 *
 * This is the one function in the module that touches geometry — everything above
 * it works from the token alone. It is the seam §6.2's Availability Index uses to
 * place a live observation into the index, and nothing else in the engine tree may
 * call `h3-js` directly (a build-time convention, not yet a machine-checked one).
 *
 * @param {number} lat
 * @param {number} lon
 * @param {string} resolution one of `RESOLUTION`
 * @returns {string} an H3 cell id — still just an opaque token to every other
 *   function in this module
 * @throws {Error} on a non-finite or out-of-range coordinate
 */
function cellForPoint(lat, lon, resolution) {
  if (!isFiniteCoordinate(lat, lon)) {
    throw new Error(`cellForPoint: (${lat}, ${lon}) is not a finite lat/lon pair`);
  }
  return h3.latLngToCell(lat, lon, h3ResolutionOf(resolution));
}

/**
 * @param {string} cellId an H3 cell id
 * @returns {{ lat: number, lon: number }} the cell's centre
 * @throws {Error} on a cell id H3 cannot parse
 */
function centreOfCell(cellId) {
  const id = normaliseCellId(cellId);
  if (!h3.isValidCell(id)) {
    throw new Error(`centreOfCell: "${id}" is not a valid H3 cell id`);
  }
  const [lat, lng] = h3.cellToLatLng(id);
  return { lat, lon: lng };
}

/**
 * Which §3.6 band an H3 cell id was minted at, or `null` when it was minted at
 * neither of the two resolutions this module recognises (e.g. a site-local graph
 * zone token, or an H3 cell at some other resolution).
 *
 * ── This is the ONE production resolution decoder (RD-2026-09-14-01 D4) ─────
 * Every fail-closed behaviour the spatial-model cutover relies on is built on this
 * one function returning `null` — never `FINE` — for a token minted under a
 * different model. There are exactly four enforcement points and no others:
 *
 *   1. **this decode** — `null` for a foreign token;
 *   2. **`coarseParentOf`** — throws rather than coercing one;
 *   3. **`hierarchy.indexMap().resolve()`** — `assigned: false`, so a foreign token
 *      is never assigned and F33 stays INDETERMINATE;
 *   4. **V-10 / A6 at publish** — a cover holding one is refused before it is pinned.
 *
 * **A fifth layer is deliberately absent.** Wrapper predicates over this decode were
 * written and then removed: they added a name at a call site and no behaviour, and a
 * guard that restates a check already made is a guard whose absence nobody notices.
 * Readers that need this question answered call this function directly.
 *
 * @param {string} cellId
 * @returns {string|null}
 */
function resolutionOfH3Cell(cellId) {
  const id = normaliseCellId(cellId);
  if (!h3.isValidCell(id)) return null;
  const res = h3.getResolution(id);
  if (res === H3_RESOLUTION.FINE) return RESOLUTION.FINE;
  if (res === H3_RESOLUTION.COARSE) return RESOLUTION.COARSE;
  return null;
}

/**
 * The maximum straight-line distance between any two points inside one fine cell, in
 * metres — §20.3's *"within-cell error is bounded by the cell diameter"*.
 *
 * For a hexagon of edge `e` the greatest internal distance is vertex-to-opposite-vertex,
 * `2e` — not the across-flats width `√3·e`, which would under-state the bound.
 * `getHexagonEdgeLengthAvg` is an average over a resolution's cells, so this is the
 * bound for a representative cell rather than a per-cell maximum.
 *
 * ── This is NOT `route.intra_cell_offset_m`, and must never be wired to it ───
 * RD-2026-09-14-01 **D5** separates the two deliberately. This function returns a
 * *geometric* bound on straight-line error (≈57.33 m at resolution 11). The register
 * parameter is an *operational network* correction: distance actually travelled inside
 * a cell follows the road network and is never below the straight line, so the
 * geometric diameter is a provable **lower** bound on the correction required and is
 * not an adequate operational value. The register default stays at 250 m and stays
 * `PROVISIONAL` pending measured network-distance/circuity evidence.
 *
 * @returns {number} metres
 */
function fineCellDiameterMetres() {
  /** @structural a hexagon's vertex-to-opposite-vertex span is twice its edge — geometry, not a margin */
  const EDGES_ACROSS_A_HEXAGON = 2;
  return EDGES_ACROSS_A_HEXAGON * edgeLengthMetres(RESOLUTION.FINE);
}

/**
 * The coarse cell a fine cell lies in, by H3's own hierarchy — a computed geometric
 * relationship, distinct from `hierarchy.js`'s published `zoneId`/`siteId`
 * assignment. §6.2 names both a fine and a coarse index; this is how one is derived
 * from the other without a second published map.
 *
 * @param {string} fineCellId
 * @returns {string} the coarse H3 cell id containing it
 * @throws {Error} when `fineCellId` is not a valid fine-resolution H3 cell
 */
function coarseParentOf(fineCellId) {
  const id = normaliseCellId(fineCellId);
  if (resolutionOfH3Cell(id) !== RESOLUTION.FINE) {
    throw new Error(`coarseParentOf: "${id}" is not a fine-resolution H3 cell`);
  }
  return h3.cellToParent(id, H3_RESOLUTION.COARSE);
}

/**
 * The fine cells a coarse cell contains, canonically ordered.
 *
 * @param {string} coarseCellId
 * @returns {string[]}
 * @throws {Error} when `coarseCellId` is not a valid coarse-resolution H3 cell
 */
function fineChildrenOf(coarseCellId) {
  const id = normaliseCellId(coarseCellId);
  if (resolutionOfH3Cell(id) !== RESOLUTION.COARSE) {
    throw new Error(`fineChildrenOf: "${id}" is not a coarse-resolution H3 cell`);
  }
  return canonicalCellOrder(h3.cellToChildren(id, H3_RESOLUTION.FINE));
}

/**
 * The filled disk of cells within grid distance `k` of `cellId`, **including**
 * `cellId` itself at `k=0`, canonically ordered. This is tier 2's "k-ring
 * expansion, k increasing" (§6.3) — each successive `k` is queried fresh rather
 * than accumulated, so the caller controls when growth stops via §6.4's pruning
 * rule rather than this function guessing a stopping point.
 *
 * @param {string} cellId
 * @param {number} k non-negative grid radius
 * @returns {string[]}
 */
function diskAround(cellId, k) {
  const id = normaliseCellId(cellId);
  if (!Number.isInteger(k) || k < 0) throw new Error(`diskAround: k must be a non-negative integer, received ${k}`);
  return canonicalCellOrder(h3.gridDisk(id, k));
}

/**
 * The hollow ring of cells at exactly grid distance `k` from `cellId`, canonically
 * ordered — the *new* cells `diskAround` would add going from `k-1` to `k`, without
 * recomputing the whole disk.
 *
 * @param {string} cellId
 * @param {number} k positive grid radius
 * @returns {string[]}
 */
function ringAt(cellId, k) {
  const id = normaliseCellId(cellId);
  if (!Number.isInteger(k) || k < 1) throw new Error(`ringAt: k must be a positive integer, received ${k}`);
  return canonicalCellOrder(h3.gridRing(id, k));
}

/**
 * Grid (hex-hop) distance between two cells at the same H3 resolution — used to
 * derive a cell's *minimum possible* `LB` from cell-boundary geometry alone
 * (§6.4's pruning rule: "a whole cell can be discarded without touching its
 * members"), without a routing query.
 *
 * @param {string} fromCellId
 * @param {string} toCellId
 * @returns {number}
 * @throws {Error} when the two cells are not comparable (different resolutions, or
 *   too far apart for H3's local-IJ algorithm)
 */
function gridDistanceBetween(fromCellId, toCellId) {
  const from = normaliseCellId(fromCellId);
  const to = normaliseCellId(toCellId);
  const distance = h3.gridDistance(from, to);
  if (!Number.isFinite(distance) || distance < 0) {
    throw new Error(`gridDistanceBetween: no defined grid distance between "${from}" and "${to}"`);
  }
  return distance;
}

/**
 * The average hexagon edge length, in metres, at a §3.6 resolution band. Used to
 * derive a geometric floor for a not-yet-queried ring in `candidates/expansion.js`'s
 * pruning rule (§6.4: "derived from cell-boundary geometry, so a whole cell can be
 * discarded without touching its members").
 *
 * @param {string} resolution one of `RESOLUTION`
 * @returns {number} metres
 */
function edgeLengthMetres(resolution) {
  return h3.getHexagonEdgeLengthAvg(h3ResolutionOf(resolution), h3.UNITS.m);
}

/**
 * Great-circle distance in metres between two `(lat, lon)` points — the provable
 * shortest-possible-path underestimate `LB(a, l)`'s first term requires (§6.4:
 * "the great-circle distance is the shortest possible path on any network").
 *
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 * @returns {number} metres
 */
function greatCircleMetres(lat1, lon1, lat2, lon2) {
  if (!isFiniteCoordinate(lat1, lon1) || !isFiniteCoordinate(lat2, lon2)) {
    throw new Error("greatCircleMetres: both points must be finite, in-range lat/lon pairs");
  }
  return h3.greatCircleDistance([lat1, lon1], [lat2, lon2], h3.UNITS.m);
}

module.exports = {
  RESOLUTION,
  RESOLUTIONS,
  isResolution,
  isCellId,
  normaliseCellId,
  compareCellIds,
  canonicalCellOrder,
  cellPairKey,
  validateAssignment,
  // H3 wrapper (§6.2, §6.3; Phase 9, B5. Resolution per ADR-35 / RD-2026-09-14-01).
  H3_RESOLUTION,
  SPATIAL_MODEL,
  h3ResolutionOf,
  cellForPoint,
  centreOfCell,
  resolutionOfH3Cell,
  fineCellDiameterMetres,
  coarseParentOf,
  fineChildrenOf,
  diskAround,
  ringAt,
  gridDistanceBetween,
  greatCircleMetres,
  edgeLengthMetres,
};
