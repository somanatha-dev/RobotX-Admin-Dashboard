"use strict";

/**
 * The tied-cell evidence report for the RNSIT four-zone proposal: read-only decision support.
 * It must reproduce the generator's ties exactly, settle none of them, and be deterministic.
 */

const proposalTool = require("../../tools/campus/rnsitZoneMap");
const { buildTieEvidence, toMarkdown } = require("../../tools/campus/rnsitZoneTieEvidence");

describe("RNSIT tied-cell evidence", () => {
  const report = buildTieEvidence();
  const proposal = proposalTool.buildProposal();

  test("the ties are exactly the generator's unresolved cells, none settled", () => {
    expect(report.ties.map((t) => t.cellId).sort()).toEqual([...proposal.unresolved].sort());
    expect(report.ties).toHaveLength(14);
    for (const tie of report.ties) expect(tie.tiedZones.length).toBeGreaterThanOrEqual(2);
    expect(report).not.toHaveProperty("assignments");
    expect(report.approved).toBe(false);
    expect(report.status).toBe("UNRESOLVED");
  });

  test("resolved counts match the generator; resolved + tied = the 64-cell cover", () => {
    expect(report.zones.map((z) => [z.zoneId, z.resolvedCells])).toEqual([
      ["rnsit-z2", 10],
      ["rnsit-z3", 7],
      ["rnsit-z4", 6],
      ["rnsit-z5", 27],
    ]);
    expect(report.zones.reduce((n, z) => n + z.resolvedCells, 0) + report.ties.length).toBe(64);
  });

  test("deterministic: two builds give the same report and the same markdown", () => {
    const again = buildTieEvidence();
    expect(again).toEqual(report);
    expect(toMarkdown(again)).toBe(toMarkdown(report));
  });

  test("it does not invent places: every listed outline is an id from the repository's extract", () => {
    const ids = new Set(proposalTool.loadInputs().osm.features.map((f) => f.id));
    for (const tie of report.ties) {
      for (const outline of tie.outlines) {
        const id = outline.match(/\((way\/\d+|relation\/\d+)\)$/)[1];
        expect(ids.has(id)).toBe(true);
      }
    }
  });
});
