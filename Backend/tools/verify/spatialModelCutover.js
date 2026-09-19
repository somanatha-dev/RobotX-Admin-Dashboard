"use strict";

/**
 * ADR-35 / `RD-2026-09-14-01` — the V1 spatial-model cutover, and its live verification.
 *
 * ── D1's effect on this tool, stated first because it is counter-intuitive ───
 * `Stop.geofenceResult` is a **coordinate** verdict against a **published domain
 * declaration**. It contains no cell, was derived from no cell, and does not change when
 * the spatial model changes. So a spatial-model cutover leaves every pinned verdict
 * **untouched and still valid**, and this tool reports them without rewriting them.
 *
 * That is not an accident of implementation; it is the property D1 was adopted for. The
 * thing a cutover invalidates is the *index*, and the index was never what decided
 * whether a destination was in the delivery domain. A verdict is re-taken only when the
 * **domain declaration** is republished — a different event, with a different owner
 * (S-3 row 29), which this tool deliberately does not perform.
 *
 * ── The question this tool has to answer ─────────────────────────────────────
 * *"Which spatial model does this persisted cell identity belong to?"*
 *
 * It already has an answer, and the answer is **the token itself**. An H3 index encodes
 * its own resolution, so `cells.resolutionOfH3Cell` returns `null` — never `FINE` — for a
 * cell minted under the previous model, and `cells.coarseParentOf` refuses one rather
 * than coercing it. **No discriminator column was added**, because a column
 * would store a fact the token already carries and the fail-closed behaviour comes from
 * the decode, not the label (§12: "Do NOT add schema fields merely for convenience").
 *
 * ── What is rebuilt, and what cannot be ──────────────────────────────────────
 * | State | Under the new model | Why |
 * |---|---|---|
 * | `AgentCellPosition.fineCellId` / `.coarseCellId` | **Recomputed** | The row keeps its own `lat`/`lon`, so the cell is derivable without any other source |
 * | `Redis engine:idx:*` | **Invalidated** | Advisory (§3.3, I16); rebuildable from `AgentCellPosition` |
 * | `Redis engine:route:cell:*` | **Invalidated** | Keyed by cell token, so stale entries are orphans that can never be hit — dropped to reclaim, not for correctness |
 * | `CellAssignment` | **Reported, never rewritten** | Published configuration pinned into round snapshots (§9.6). A cover is *republished* by its owner, not edited by a migration |
 * | `Stop.fineCell` | **REPORTED AND REFUSED — see below** | |
 *
 * ── The finding this tool exists to surface: `Stop.fineCell` is not universally
 *    recomputable ─────────────────────────────────────────────────────────────
 * `Stop.lat` and `Stop.lon` are *"retained and nulled by the backfill"* (§23.7 identity
 * isolation, `schema.prisma`), so a sealed Stop no longer carries the coordinate its
 * `fineCell` was derived from. The coordinate survives only inside `IdentityRecord`'s
 * ciphertext — and for an **erased** Stop it does not survive at all, by design.
 *
 * So a resolution-8 `Stop.fineCell` on an erased Stop is **permanently underivable**.
 * That is §23.7 working correctly, and it means a spatial-model change is not a
 * migration a production deployment can simply run. This tool therefore **counts** such
 * rows and **refuses to touch them**; reinterpreting a res-8 token as res-11 is the one
 * thing §14 forbids outright. In this repository the answer is the clean cutover
 * `--rebuild-stops` performs, and it is legitimate **only** because the target is
 * disposable and no production deployment exists (`cutover.engine_enabled` is unbound;
 * every assign request returns `503 ENGINE_NOT_LIVE`).
 *
 * ── Running it ───────────────────────────────────────────────────────────────
 *   node tools/verify/spatialModelCutover.js <postgres-url> [--apply] [--rebuild-stops]
 *
 * Without `--apply` it only reports. The target must be loopback on a non-default port;
 * anything else is refused before a client is constructed.
 */

/* ── Target guard: an allow-list, evaluated before anything connects ───────── */

const url = process.argv[2];
const APPLY = process.argv.includes("--apply");
const REBUILD_STOPS = process.argv.includes("--rebuild-stops");

function refuse(message) {
  process.stderr.write(`REFUSED: ${message}\n`);
  process.exit(2);
}

if (!url) refuse("usage: node tools/verify/spatialModelCutover.js <postgres-url> [--apply] [--rebuild-stops]");

let target;
try {
  target = new URL(url);
} catch {
  refuse(`"${url}" is not a parseable URL`);
}

// Fail closed by allow-list, not by deny-list. A deny-list that names `neon.tech` is one
// new hostname away from being wrong, and this tool rewrites fleet rows.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
// 5432 is the developer's own cluster and is NOT disposable — see the disposable-cluster
// convention these verifications use (a throwaway PG on 55432).
const DEFAULT_POSTGRES_PORT = "5432";

if (!/^postgres(ql)?:$/.test(target.protocol)) refuse(`protocol ${target.protocol} is not postgres`);
if (!LOOPBACK_HOSTS.has(target.hostname)) {
  refuse(`host "${target.hostname}" is not loopback. This tool rewrites fleet rows and runs only against a throwaway cluster`);
}
if (target.port === "" || target.port === DEFAULT_POSTGRES_PORT) {
  refuse(
    `port "${target.port || "(default)"}" is the developer's own cluster. Build a throwaway cluster on another port ` +
      "(the convention in this repository is 55432) and point this tool at that",
  );
}

process.env.DATABASE_URL = url;
process.env.REDIS_ENABLED = "false";
delete process.env.REDIS_URL;

const h3 = require("h3-js");
const cells = require("../../src/engine/spatial/cells");
const deliveryDomain = require("../../src/engine/spatial/deliveryDomain");
const { getPrisma } = require("../../src/db/prisma");

/** The model a persisted token was minted under, as a label a report can print. */
function modelOf(cellId) {
  if (typeof cellId !== "string" || !h3.isValidCell(cellId)) return "NOT_AN_H3_INDEX";
  const res = h3.getResolution(cellId);
  if (res === cells.H3_RESOLUTION.FINE) return "CURRENT_FINE";
  if (res === cells.H3_RESOLUTION.COARSE) return "CURRENT_COARSE";
  return `FOREIGN_RES_${res}`;
}

function tally(values, classify) {
  const counts = new Map();
  for (const value of values) {
    const key = classify(value);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

async function main() {
  const prisma = getPrisma();

  console.log("═══ ADR-35 SPATIAL MODEL CUTOVER ═══");
  console.log(`target             ${target.protocol}//${target.hostname}:${target.port}${target.pathname}`);
  console.log(`mode               ${APPLY ? "APPLY" : "REPORT ONLY"}${REBUILD_STOPS ? " +rebuild-stops" : ""}`);
  console.log(`spatial model      ${cells.SPATIAL_MODEL.id}  (FINE = H3 ${cells.SPATIAL_MODEL.fine}, ${cells.SPATIAL_MODEL.adr})`);

  const identity = await prisma.$queryRawUnsafe(
    "select current_database() as db, inet_server_port() as port, current_user as usr, version() as version",
  );
  console.log(`server identity    db=${identity[0].db} port=${identity[0].port} user=${identity[0].usr}`);
  console.log(`server version     ${String(identity[0].version).split(",")[0]}`);
  console.log("");

  /* ── AgentCellPosition — recomputable from its own lat/lon ──────────────── */

  const positions = await prisma.agentCellPosition.findMany({
    select: { id: true, agentId: true, lat: true, lon: true, fineCellId: true, coarseCellId: true },
  });
  console.log(`── AgentCellPosition (${positions.length} row(s)) ──`);
  for (const [model, count] of tally(positions, (row) => modelOf(row.fineCellId))) {
    console.log(`   fineCellId  ${model.padEnd(18)} ${count}`);
  }

  const restated = positions
    .map((row) => {
      const fineCellId = cells.cellForPoint(row.lat, row.lon, cells.RESOLUTION.FINE);
      return { row, fineCellId, coarseCellId: cells.coarseParentOf(fineCellId) };
    })
    .filter((entry) => entry.fineCellId !== entry.row.fineCellId || entry.coarseCellId !== entry.row.coarseCellId);
  console.log(`   rows whose recomputed cell differs from the stored one: ${restated.length}`);

  if (APPLY && restated.length > 0) {
    for (const entry of restated) {
      // eslint-disable-next-line no-await-in-loop
      await prisma.agentCellPosition.update({
        where: { id: entry.row.id },
        data: { fineCellId: entry.fineCellId, coarseCellId: entry.coarseCellId },
      });
    }
    console.log(`   APPLIED: ${restated.length} row(s) recomputed from their own lat/lon`);
  }
  console.log("");

  /* ── Stop.fineCell — the row that cannot simply be migrated ─────────────── */

  const stops = await prisma.stop.findMany({ select: { id: true, lat: true, lon: true, fineCell: true, identityKey: true } });
  const sealed = stops.filter((row) => row.fineCell !== null);
  const derivable = sealed.filter((row) => row.lat !== null && row.lon !== null);
  const underivable = sealed.filter((row) => row.lat === null || row.lon === null);
  const foreign = sealed.filter((row) => modelOf(row.fineCell).startsWith("FOREIGN"));

  console.log(`── Stop.fineCell (${stops.length} stop(s), ${sealed.length} with a fineCell) ──`);
  for (const [model, count] of tally(sealed, (row) => modelOf(row.fineCell))) {
    console.log(`   ${model.padEnd(18)} ${count}`);
  }
  console.log(`   recomputable from the Stop row itself (lat/lon retained): ${derivable.length}`);
  console.log(`   NOT recomputable — lat/lon nulled by the §23.7 backfill:  ${underivable.length}`);
  console.log(`   carrying a foreign-model token:                           ${foreign.length}`);

  if (underivable.length > 0 && foreign.length > 0) {
    console.log("");
    console.log("   ⚠ FINDING: a foreign-model Stop.fineCell whose coordinate has been sealed away");
    console.log("     cannot be recomputed by any migration. §23.7 holds the coordinate only inside");
    console.log("     IdentityRecord's ciphertext, and for an ERASED Stop not at all. This is the");
    console.log("     reason a spatial-model change is not a routine production migration.");
  }

  if (APPLY && REBUILD_STOPS) {
    // The clean cutover, and it is a DISCARD, not a reinterpretation. Nulling is the only
    // honest option for a value that cannot be re-derived: a null re-seals on next write,
    // a stale res-8 token would be silently wrong forever.
    const cleared = await prisma.stop.updateMany({
      where: { id: { in: foreign.map((row) => row.id) } },
      data: { fineCell: null },
    });
    console.log(`   APPLIED: ${cleared.count} foreign-model Stop.fineCell value(s) CLEARED (not reinterpreted)`);
    for (const row of derivable.filter((entry) => modelOf(entry.fineCell).startsWith("FOREIGN"))) {
      // eslint-disable-next-line no-await-in-loop
      await prisma.stop.update({
        where: { id: row.id },
        data: { fineCell: cells.cellForPoint(row.lat, row.lon, cells.RESOLUTION.FINE) },
      });
    }
    console.log(`   APPLIED: ${derivable.filter((entry) => modelOf(entry.fineCell).startsWith("FOREIGN")).length} re-derived from retained lat/lon`);
  }
  console.log("");

  /* ── CellAssignment — reported, never rewritten ─────────────────────────── */

  const assignments = await prisma.cellAssignment.findMany({ select: { cellId: true, resolution: true, mapVersion: true } });
  console.log(`── CellAssignment (${assignments.length} row(s)) — REPORTED, NEVER REWRITTEN ──`);
  for (const [model, count] of tally(assignments, (row) => `${row.resolution}/${modelOf(row.cellId)}`)) {
    console.log(`   ${model.padEnd(28)} ${count}`);
  }
  const staleAssignments = assignments.filter((row) => row.resolution === "FINE" && modelOf(row.cellId).startsWith("FOREIGN"));
  if (staleAssignments.length > 0) {
    console.log(`   ⚠ ${staleAssignments.length} FINE assignment(s) carry a foreign-model token.`);
    console.log("     These are published configuration pinned into round snapshots (§9.6). They are");
    console.log("     REPUBLISHED by the cover's owner as a new mapVersion, never edited in place, and");
    console.log("     A6/V-10 will reject them at publish — which is the check doing its job.");
  }
  console.log(`   mapVersions present: ${[...new Set(assignments.map((row) => row.mapVersion))].sort((a, b) => a - b).join(", ") || "(none)"}`);
  console.log("");

  /* ── Stop.geofenceResult — D1's pinned verdict, reported and NEVER rewritten ── */

  const pinned = await prisma.stop.findMany({ select: { id: true, geofenceResult: true } });
  console.log(`── Stop.geofenceResult (${pinned.length} stop(s)) — D1's pin, NEVER rewritten by a spatial cutover ──`);
  for (const [verdict, count] of tally(pinned, (row) => String(row.geofenceResult ?? "(null — sealed before D1)"))) {
    console.log(`   ${verdict.padEnd(30)} ${count}`);
  }
  const unrecognised = pinned.filter(
    (row) => row.geofenceResult !== null && !deliveryDomain.GEOFENCE_VERDICTS.includes(row.geofenceResult),
  );
  console.log(`   values outside the declared verdict vocabulary: ${unrecognised.length}`);
  console.log("   A spatial-model change does not invalidate these: the verdict is a COORDINATE against a");
  console.log("   published domain geometry and contains no cell. Re-taking one is a DOMAIN republication");
  console.log("   (S-3 row 29), a different event with a different owner, which this tool does not perform.");
  if (unrecognised.length > 0) {
    console.log("   ⚠ An unrecognised value is read by the round as ABSENT — never as inside, never as outside.");
  }
  const preD1 = pinned.filter((row) => row.geofenceResult === null);
  if (preD1.length > 0) {
    console.log(`   ⚠ ${preD1.length} Stop(s) sealed before the D1 producer existed carry no verdict. They read as`);
    console.log("     ABSENT and DENY, which is correct and is why F33 stayed in the gate as redundancy.");
  }
  console.log("");

  /* ── Redis index and route-cache key spaces ─────────────────────────────── */

  console.log("── Cache and index key spaces ──");
  console.log("   engine:idx:*         INVALIDATED on cutover — advisory (§3.3, I16), rebuilt from AgentCellPosition");
  console.log("   engine:route:cell:*  INVALIDATED on cutover — the key embeds the cell token, so a stale entry is an");
  console.log("                        ORPHAN that can never be hit by a lookup under this model, never a wrong answer");
  console.log("   Neither is rewritten in place, and neither is reinterpreted. Dropping them reclaims space; it is");
  console.log("   not required for correctness, which is what makes this cutover safe to re-run.");
  console.log("");

  /* ── The unambiguity claim, checked rather than asserted ────────────────── */

  console.log("── Unambiguity check ──");
  const everyToken = [
    ...positions.map((row) => row.fineCellId),
    ...positions.map((row) => row.coarseCellId),
    ...sealed.map((row) => row.fineCell),
    ...assignments.map((row) => row.cellId),
  ].filter((value) => typeof value === "string" && value.length > 0);
  const ambiguous = everyToken.filter((token) => modelOf(token) === "NOT_AN_H3_INDEX");
  console.log(`   persisted cell tokens inspected: ${everyToken.length}`);
  console.log(`   tokens whose model cannot be decided from the token alone: ${ambiguous.length}`);
  console.log(`   VERDICT: ${ambiguous.length === 0 ? "every persisted cell identity names its own model" : "AMBIGUOUS TOKENS PRESENT — investigate"}`);

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  process.exit(1);
});
