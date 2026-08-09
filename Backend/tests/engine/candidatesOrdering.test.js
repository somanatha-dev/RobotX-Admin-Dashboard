"use strict";

/**
 * `candidates/ordering.js` — the three orderings §6.6 names, and the tie-break
 * discipline §9.6 requirement 2 requires of each.
 */

const ordering = require("../../src/engine/candidates/ordering");

describe("§6.4 — cell visiting order", () => {
  test("orders ascending by minimum-possible bound", () => {
    const cells = [
      { cellId: "c2", minBoundMilliCU: 500n },
      { cellId: "c1", minBoundMilliCU: 100n },
      { cellId: "c3", minBoundMilliCU: 900n },
    ];
    expect(ordering.orderCellsForExpansion(cells).map((c) => c.cellId)).toEqual(["c1", "c2", "c3"]);
  });

  test("ties on bound resolve by cell id, never by input order", () => {
    const cells = [
      { cellId: "z", minBoundMilliCU: 100n },
      { cellId: "a", minBoundMilliCU: 100n },
    ];
    expect(ordering.orderCellsForExpansion(cells).map((c) => c.cellId)).toEqual(["a", "z"]);
  });

  test("does not mutate its input", () => {
    const cells = [{ cellId: "b", minBoundMilliCU: 2n }, { cellId: "a", minBoundMilliCU: 1n }];
    const copy = [...cells];
    ordering.orderCellsForExpansion(cells);
    expect(cells).toEqual(copy);
  });

  test("assertCellOrderIsTotal reports no collision for distinct cell ids at equal bounds", () => {
    const cells = [
      { cellId: "a", minBoundMilliCU: 1n },
      { cellId: "b", minBoundMilliCU: 1n },
    ];
    expect(ordering.assertCellOrderIsTotal(cells)).toEqual({ ok: true, collisions: [] });
  });
});

describe("§6.6 — agent order within a cell", () => {
  test("orders by agent id alone, by code unit", () => {
    expect(ordering.orderAgentsWithinCell(["b", "A", "a"])).toEqual(["A", "a", "b"]);
  });

  test("does not mutate its input and handles an empty/undefined list", () => {
    const ids = ["b", "a"];
    ordering.orderAgentsWithinCell(ids);
    expect(ids).toEqual(["b", "a"]);
    expect(ordering.orderAgentsWithinCell(undefined)).toEqual([]);
  });
});

describe("§6.6/§9.6 — the final candidate list", () => {
  test("orderCandidates delegates to the engine-wide compareScored (cost, then tie-break)", () => {
    const candidates = [
      { agentId: "b", costMilliCU: 200n },
      { agentId: "a", costMilliCU: 100n },
      { agentId: "c", costMilliCU: 100n }, // ties with "a" on cost, breaks on agentId
    ];
    expect(ordering.orderCandidates(candidates).map((c) => c.agentId)).toEqual(["a", "c", "b"]);
  });
});
