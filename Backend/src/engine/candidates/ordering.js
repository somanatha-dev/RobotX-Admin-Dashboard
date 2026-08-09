"use strict";

/**
 * Canonical ordering for candidate generation (§6.6). **Tier 1.**
 *
 * > Candidate enumeration MUST be deterministic: cells visited in a canonical order,
 * > agents within a cell ordered by `(agent_id)`, and the resulting list ordered
 * > canonically before cost evaluation. Any set ordering that depends on a query
 * > planner, hash iteration order, or concurrent-response arrival order is
 * > prohibited.
 *
 * Three distinct orderings, each named separately because they order different
 * things at different points in `expansion.js`'s search and must not be conflated:
 *
 *   1. **Cell visiting order** (§6.4's pruning rule: "cells are visited in
 *      increasing order of their minimum possible `LB`") — a priority order, tied
 *      by cell id so two cells with an identical bound still have one order.
 *   2. **Agent order within a cell** (§6.6) — by `agent_id` alone; the index never
 *      exposes an internal iteration order.
 *   3. **The final candidate list, before cost evaluation** (§6.6, §9.6 requirement
 *      3) — the engine-wide canonical comparator `determinism/ordering.compareScored`:
 *      cost, then the duty-cycle/health-tier/agent-id tie-break.
 *
 * This module contributes no new comparison logic for (2) and (3) — both already
 * exist in `determinism/ordering.js`, which §9.6 requires every module to share
 * rather than each re-deriving its own. It exists to state (1), which is specific to
 * candidate expansion, and to give all three a single, tested home.
 */

const {
  compareStrings,
  compareNumbers,
  thenBy,
  compareScored,
  canonicalSort,
  assertTotalOrder,
} = require("../determinism/ordering");
const { compare: compareMilliCU } = require("../determinism/fixedPoint");

/**
 * Cell visiting order: ascending minimum-possible bound, tied by cell id.
 *
 * @param {{ cellId: string, minBoundMilliCU: bigint }} a
 * @param {{ cellId: string, minBoundMilliCU: bigint }} b
 * @returns {number}
 */
const compareCellsByBound = thenBy(
  (a, b) => compareMilliCU(a.minBoundMilliCU, b.minBoundMilliCU),
  (a, b) => compareStrings(a.cellId, b.cellId),
);

/**
 * Sort cells for expansion under `compareCellsByBound`.
 *
 * @param {Array<{ cellId: string, minBoundMilliCU: bigint }>} cells
 * @returns {Array<{ cellId: string, minBoundMilliCU: bigint }>}
 */
function orderCellsForExpansion(cells) {
  return canonicalSort(cells, compareCellsByBound);
}

/**
 * Agent order within one cell (§6.6): by `agent_id` alone.
 *
 * @param {string[]} agentIds
 * @returns {string[]}
 */
function orderAgentsWithinCell(agentIds) {
  return [...(agentIds || [])].sort(compareStrings);
}

/**
 * The final candidate list, canonically ordered before cost evaluation (§6.6, §9.6
 * requirement 3) — the engine-wide `compareScored`, unchanged and re-exported here
 * so `expansion.js` and its tests have one import for every ordering candidate
 * generation performs.
 *
 * @param {Array<{ costMilliCU: bigint, dutyCycle?: number, healthTier?: number, agentId: string }>} candidates
 * @returns {Array<object>}
 */
function orderCandidates(candidates) {
  return canonicalSort(candidates, compareScored);
}

/**
 * §9.6 requirement 2's own check, specialised to cell visiting order: no two
 * distinct cells in the same expansion may compare equal, or their relative order
 * is left to the sort implementation.
 *
 * @param {Array<{ cellId: string, minBoundMilliCU: bigint }>} cells
 * @returns {{ ok: boolean, collisions: string[] }}
 */
function assertCellOrderIsTotal(cells) {
  return assertTotalOrder(cells, compareCellsByBound, (cell) => cell.cellId);
}

module.exports = {
  compareCellsByBound,
  orderCellsForExpansion,
  orderAgentsWithinCell,
  orderCandidates,
  assertCellOrderIsTotal,
  // Re-exported for convenience so callers need not also import determinism/ordering.
  compareStrings,
  compareNumbers,
};
