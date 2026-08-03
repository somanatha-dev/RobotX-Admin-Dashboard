"use strict";

/**
 * Cells (§3.6, §6.2).
 *
 * > **Cell** — the **index and cache** unit: a discrete geospatial cell (H3/S2),
 * > fine (~200–500 m) and coarse (~5–10 km). A fine cell lies in exactly one zone
 * > **by assignment**, not by geometry.
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
 */

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
};
