#!/usr/bin/env node
"use strict";

/**
 * Evidence for the owner's decision on the RNSIT four-zone proposal's TIED cells — read-only.
 *
 *   node tools/campus/rnsitZoneTieEvidence.js            # markdown report on stdout
 *   node tools/campus/rnsitZoneTieEvidence.js --json     # the same facts as JSON
 *
 * The proposal generator (`tools/campus/rnsitZoneMap.js`, owned by the zoning work) leaves a cell
 * without a zone when two or more proposed zones' anchors are equally near, and its rule is that
 * a tie is settled ONLY by an owner-reviewed override (proposal §5 step 4, Q3). This tool does not
 * settle anything. For each tied cell it lists what the repository's own data says is in it —
 * which named outlines, user-supplied points and verified access points touch the cell, and
 * which walkway classes cross it — so the owner can decide with the evidence in front of them.
 *
 * Writes nothing, assigns nothing, publishes nothing. Deterministic: same inputs, same output.
 */

const path = require("path");
const h3 = require("h3-js");

const proposalTool = require(path.join(__dirname, "rnsitZoneMap"));

const RES = 11;

function cellsOfPolygon(coordinates) {
  try {
    return h3.polygonToCellsExperimental(coordinates, RES, h3.POLYGON_TO_CELLS_FLAGS.containmentOverlapping, true);
  } catch {
    return [];
  }
}

/** Cells a line passes through, sampled every ~2 m along each segment. */
function cellsOfLine(coords) {
  const out = new Set();
  for (let i = 1; i < coords.length; i++) {
    const [lon1, lat1] = coords[i - 1];
    const [lon2, lat2] = coords[i];
    const metres = Math.hypot((lon2 - lon1) * 111320 * Math.cos((lat1 * Math.PI) / 180), (lat2 - lat1) * 111320);
    const steps = Math.max(1, Math.ceil(metres / 2));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      out.add(h3.latLngToCell(lat1 + (lat2 - lat1) * t, lon1 + (lon2 - lon1) * t, RES));
    }
  }
  return out;
}

function featureLabel(f) {
  const p = f.properties || {};
  return p.name || p["@id"] || f.id || "(unnamed)";
}

/**
 * @returns {{ status: string, approved: boolean, zones: object[], ties: object[] }}
 */
function buildTieEvidence() {
  const inputs = proposalTool.loadInputs();
  const proposal = proposalTool.buildProposal();
  const tied = proposal.cells.filter((c) => !c.zoneId);
  const tiedSet = new Set(tied.map((c) => c.cellId));
  const byCell = new Map(tied.map((c) => [c.cellId, { outlines: [], points: [], access: [], walkways: new Set() }]));

  for (const f of inputs.osm.features || []) {
    const g = f.geometry || {};
    const p = f.properties || {};
    if (g.type === "Polygon" || g.type === "MultiPolygon") {
      if (p.boundary || p.amenity === "college") continue; // the campus outline itself touches every cell
      const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
      const hit = new Set(polys.flatMap((poly) => cellsOfPolygon(poly)));
      for (const cellId of hit) if (tiedSet.has(cellId)) byCell.get(cellId).outlines.push(`${featureLabel(f)} (${f.id})`);
    } else if (g.type === "LineString" && p.highway) {
      for (const cellId of cellsOfLine(g.coordinates)) if (tiedSet.has(cellId)) byCell.get(cellId).walkways.add(p.highway);
    }
  }
  for (const f of inputs.supplemental.features || []) {
    if (f.geometry?.type !== "Point") continue;
    const [lon, lat] = f.geometry.coordinates;
    const cellId = h3.latLngToCell(lat, lon, RES);
    if (tiedSet.has(cellId)) byCell.get(cellId).points.push(`${featureLabel(f)} (user-supplied point)`);
  }
  for (const f of inputs.access.features || []) {
    if (f.geometry?.type !== "Point") continue;
    const [lon, lat] = f.geometry.coordinates;
    const cellId = h3.latLngToCell(lat, lon, RES);
    if (tiedSet.has(cellId)) byCell.get(cellId).access.push(featureLabel(f));
  }

  const ties = tied.map((c) => {
    const e = byCell.get(c.cellId);
    const tiedZones = c.nearest.slice().sort();
    const evidence = e.outlines.length + e.points.length + e.access.length;
    return {
      cellId: c.cellId,
      centreInBoundary: c.centreInBoundary,
      tiedZones,
      gridDistance: c.distances[tiedZones[0]],
      outlines: e.outlines.sort(),
      points: e.points.sort(),
      access: e.access.sort(),
      walkways: [...e.walkways].sort(),
      // What the owner needs to decide: a cell holding a named place can be settled by naming
      // which area that place belongs to; an empty cell needs only a boundary call.
      decisionNeeded:
        evidence > 0
          ? "Owner names the zone of the place(s) in this cell (Q3)"
          : e.walkways.length > 0
            ? "Owner chooses which zone the walkway through this cell belongs to (Q3)"
            : "Owner chooses a zone for this empty cell, or confirms it stays index-only (Q3/Q9)",
    };
  });

  const counts = {};
  for (const c of proposal.cells) if (c.zoneId) counts[c.zoneId] = (counts[c.zoneId] || 0) + 1;
  return {
    status: proposal.status,
    approved: proposal.approved === true,
    layout: proposal.layout,
    zones: proposalTool.PROPOSED_ZONES.map((z) => ({ zoneId: z.id, name: z.name, resolvedCells: counts[z.id] || 0 })),
    ties,
  };
}

function toMarkdown(report) {
  const lines = [];
  lines.push(`# RNSIT four-zone proposal — tied-cell evidence (generated)`);
  lines.push("");
  lines.push(`Generated by \`Backend/tools/campus/rnsitZoneTieEvidence.js\` from the proposal generator's own inputs. Read-only: nothing is assigned, written or published.`);
  lines.push("");
  lines.push(`Proposal status: **${report.status}**, approved: **${report.approved}**, layout ${report.layout}.`);
  lines.push("");
  lines.push("| Proposed zone | Name | Resolved cells |");
  lines.push("|---|---|---|");
  for (const z of report.zones) lines.push(`| \`${z.zoneId}\` | ${z.name} | ${z.resolvedCells} |`);
  lines.push(`| (tied, no zone) | — | ${report.ties.length} |`);
  lines.push("");
  lines.push("| Cell | Centre in boundary | Tied between (grid distance) | Named outlines touching it | Points / access points in it | Walkways | Decision needed |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const t of report.ties) {
    const places = [...t.points, ...t.access].join("; ") || "—";
    lines.push(
      `| \`${t.cellId}\` | ${t.centreInBoundary ? "yes" : "no"} | ${t.tiedZones.join(", ")} (${t.gridDistance}) | ${t.outlines.join("; ") || "—"} | ${places} | ${t.walkways.join(", ") || "—"} | ${t.decisionNeeded} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

module.exports = { buildTieEvidence, toMarkdown };

if (require.main === module) {
  const report = buildTieEvidence();
  process.stdout.write(process.argv.includes("--json") ? `${JSON.stringify(report, null, 2)}\n` : toMarkdown(report));
}
