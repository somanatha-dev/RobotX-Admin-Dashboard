#!/usr/bin/env node
"use strict";

/**
 * Create the four `Zone` rows the G4 RNSIT layout names — the prerequisite of publishing it — on a
 * NAMED database. Nothing else.
 *
 *   node tools/deploy/createG4ZoneRows.js --database-url <url> --confirm-host <exact hostname> [--apply] [--json]
 *
 * Dry run unless `--apply`. The host must be named twice (`--database-url` and `--confirm-host`),
 * as `bootstrapV1Environment.js` requires for a hosted database.
 *
 * ── What it writes ──────────────────────────────────────────────────────────
 * Only `Zone` rows `rnsit-z-west`, `rnsit-z-east`, `rnsit-z-south`, `rnsit-z-southwest`, in the
 * Region `rnsit`, named as the validated G4 proposal names them, with DEGENERATE boxes (0,0,0,0):
 * the legacy bounding-box lookup (`zoneManager.getZoneForCoordinates`) then never matches them,
 * so it answers exactly as before (owner decision Q10, 2026-10-23). A row that already exists
 * with the same id, region and name is left alone; one that exists differently is a refusal.
 * One transaction: all four or none.
 *
 * ── What it never does ──────────────────────────────────────────────────────
 * It publishes nothing and pins nothing — the map goes through `POST /api/config/publish`, whose
 * guard checks these rows (`services/spatialZoneReferences`). It deletes nothing and updates no
 * row. The rows are inert until a published map names them: F27 authorises them, no cell is in
 * them, no lookup matches them. Undo (before publication only): delete these four ids.
 */

const path = require("path");
const BACKEND_ROOT = path.resolve(__dirname, "..", "..");
const rehearsal = require(path.join(BACKEND_ROOT, "tools/demo/dtaro/rehearseG4Publication"));

function parseArgs(argv) {
  const flag = (name) => {
    const at = argv.indexOf(name);
    return at === -1 ? null : argv[at + 1];
  };
  return { url: flag("--database-url"), confirmHost: flag("--confirm-host"), apply: argv.includes("--apply"), json: argv.includes("--json") };
}

/** The plan against the rows that exist: create / unchanged / conflict, per G4 zone. Pure. */
function planRows(wanted, existingById, existingByName) {
  return wanted.map((row) => {
    const byId = existingById.get(row.id);
    if (byId) {
      if (byId.regionId === row.regionId && byId.name === row.name) return { id: row.id, action: "UNCHANGED" };
      return { id: row.id, action: "CONFLICT", reason: `exists with region ${byId.regionId} / name "${byId.name}"` };
    }
    const byName = existingByName.get(row.name);
    if (byName) return { id: row.id, action: "CONFLICT", reason: `the name "${row.name}" is already Zone ${byName.id}` };
    return { id: row.id, action: "CREATE", row };
  });
}

async function run({ url, confirmHost, apply }, { log = console.log } = {}) {
  if (!url) throw new Error("--database-url is required");
  const host = new URL(url).hostname;
  if (!confirmHost || confirmHost !== host) throw new Error(`--confirm-host must repeat the database host exactly ("${host}")`);
  const { PrismaClient } = require("@prisma/client");
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    const { proposal } = rehearsal.loadValidated();
    const region = await prisma.region.findUnique({ where: { regionId: "rnsit" } });
    if (!region) throw new Error("no Region rnsit on this database");
    const wanted = rehearsal.zoneRowPlan(proposal, region.id);
    const existing = await prisma.zone.findMany({ select: { id: true, name: true, regionId: true } });
    const plan = planRows(wanted, new Map(existing.map((z) => [z.id, z])), new Map(existing.map((z) => [z.name, z])));
    log(`host ${host} · region rnsit (${region.id}) · existing Zone rows: ${existing.map((z) => z.id).sort().join(", ")}`);
    for (const p of plan) log(`  ${p.action.padEnd(9)} ${p.id}${p.reason ? ` — ${p.reason}` : ""}`);
    const conflicts = plan.filter((p) => p.action === "CONFLICT");
    if (conflicts.length) throw new Error(`refused: ${conflicts.length} conflicting row(s); nothing written`);
    const toCreate = plan.filter((p) => p.action === "CREATE");
    if (!apply) {
      log(`DRY RUN: ${toCreate.length} row(s) would be created. Re-run with --apply to write.`);
      return { applied: false, plan };
    }
    if (toCreate.length) await prisma.$transaction(toCreate.map((p) => prisma.zone.create({ data: p.row })));
    const after = await prisma.zone.findMany({ where: { regionId: region.id }, select: { id: true } });
    const ids = after.map((z) => z.id);
    const missing = rehearsal.G4_ZONE_IDS.filter((id) => !ids.includes(id));
    if (missing.length) throw new Error(`after apply, still missing: ${missing.join(", ")}`);
    log(`APPLIED: created ${toCreate.length}; Zone rows in rnsit now: ${ids.sort().join(", ")}`);
    return { applied: true, plan, rowsInRegion: ids };
  } finally {
    await prisma.$disconnect();
  }
}

module.exports = { planRows, run };

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  run(args)
    .then((result) => {
      if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exit(0);
    })
    .catch((error) => {
      process.stderr.write(`FAILED: ${String(error.message).replace(/postgres(ql)?:\/\/\S+/g, "<url>")}\n`);
      process.exit(1);
    });
}
