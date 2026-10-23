#!/usr/bin/env node
"use strict";

/**
 * Publish and pin the validated G4 RNSIT zone map through the AUTHORISED HTTP route — the
 * operator's tool. It never writes to the database itself.
 *
 *   ROBOTX_OPERATOR_PASSWORD=…  (or ROBOTX_SESSION_COOKIE=token=…)  node tools/deploy/publishG4.js \
 *     --api https://<backend> --database-url <url> --confirm-host <exact db hostname> \
 *     --email <your SUPER_ADMIN login> --second-approver <User.id of the second approver> \
 *     --reason "<why>" [--expect-active-version N] [--restore-version N] [--apply]
 *
 * `--restore-version N` is the RECOVERY path: it republishes version N exactly (its map, bindings,
 * kill switches, regimes, delivery domain) through the same guarded route and pins it — e.g.
 * `--restore-version 1` returns the cover to `rnsit-z1`. Nothing is deleted; versions are immutable.
 *
 * Dry run unless `--apply`. Credentials come only from the environment and are never printed.
 *
 * ── What it does ────────────────────────────────────────────────────────────
 *   1. READ ONLY (a `READ ONLY` transaction): the pinned version and its payload, Region `rnsit`,
 *      the `Zone` rows. Builds the candidate exactly as the rehearsal did: the pinned version
 *      restated — every binding, kill-switch state, regime, site, the delivery domain — with ONLY
 *      the 64 RNSIT cover cells reassigned to the validated G4 zones (digest 13be3a93…).
 *   2. Checks it: the engine's publish validators, the Zone-row references (the same check the
 *      route's guard makes), that only the 64 cells change, and that the API serves the same
 *      pinned version the database holds (the API runs on this database).
 *   3. With `--apply`: `POST /api/config/publish` — authentication, SUPER_ADMIN, the
 *      SAFETY_CONFIG_CHANGE action class with the named second approver and the reason, then the
 *      route's Zone-reference guard, then publish and pin. Nothing here bypasses any of them.
 *   4. Verifies through authoritative reads: the route's answer, `GET /api/config/versions`
 *      (active version), the database pin and the 64 cells resolved through the alert path
 *      (`dtaroZoneAlert.resolvePoint`), and `GET /api/dtaro/zones` after the propagation tick.
 *
 * Rollback: re-pin the previous version (the tool prints it). Published versions are immutable.
 */

const path = require("path");
const BACKEND_ROOT = path.resolve(__dirname, "..", "..");
const rehearsal = require(path.join(BACKEND_ROOT, "tools/demo/dtaro/rehearseG4Publication"));

const redact = (text) => String(text).replace(/postgres(ql)?:\/\/\S+/g, "<url>");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const flag = (name) => {
    const at = argv.indexOf(name);
    return at === -1 ? null : argv[at + 1];
  };
  return {
    api: flag("--api"),
    url: flag("--database-url"),
    confirmHost: flag("--confirm-host"),
    email: flag("--email"),
    secondApproverId: flag("--second-approver"),
    reason: flag("--reason"),
    expectActive: flag("--expect-active-version") === null ? null : Number(flag("--expect-active-version")),
    restoreVersion: flag("--restore-version") === null ? null : Number(flag("--restore-version")),
    apply: argv.includes("--apply"),
  };
}

/** Read the pinned version, Region rnsit and the Zone rows in one READ ONLY transaction. */
async function readState(prisma) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    const pin = await tx.configActiveVersion.findFirst();
    const row = pin ? await tx.configVersion.findUnique({ where: { version: pin.version } }) : null;
    const region = await tx.region.findUnique({ where: { regionId: "rnsit" } });
    const zones = await tx.zone.findMany({ select: { id: true, regionId: true, name: true } });
    const versions = await tx.configVersion.findMany({ select: { version: true }, orderBy: { version: "asc" } });
    return { pin, row, region, zones, versions: versions.map((v) => v.version) };
  });
}

async function http(api, cookie, method, route, body) {
  const response = await fetch(`${api}${route}`, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  return { status: response.status, json, setCookie: response.headers.get("set-cookie") };
}

async function run(args, { log = console.log } = {}) {
  const FLAG = { api: "--api", url: "--database-url", confirmHost: "--confirm-host", email: "--email", secondApproverId: "--second-approver", reason: "--reason" };
  for (const [key, flag] of Object.entries(FLAG)) if (!args[key]) throw new Error(`${flag} is required`);
  if (!/^https?:\/\//.test(args.api)) throw new Error("--api must be an http(s) URL");
  const host = new URL(args.url).hostname;
  if (args.confirmHost !== host) throw new Error(`--confirm-host must repeat the database host exactly ("${host}")`);
  const report = { api: args.api, databaseHost: host, apply: args.apply, steps: [] };
  const step = (name, detail) => {
    report.steps.push({ name, ...detail });
    log(`${name}: ${JSON.stringify(detail)}`);
  };

  const { PrismaClient } = require("@prisma/client");
  const prisma = new PrismaClient({ datasources: { db: { url: args.url } } });
  try {
    // 1 — read only.
    const { proposal, context, digest } = rehearsal.loadValidated();
    const before = await readState(prisma);
    if (!before.row || !before.region) throw new Error("no pinned version or no Region rnsit");
    if (args.expectActive !== null && before.pin.version !== args.expectActive) throw new Error(`the pinned version is ${before.pin.version}, not the expected ${args.expectActive}`);
    let payload = before.row.payload;
    let spatial;
    if (args.restoreVersion !== null) {
      // RECOVERY: version N exactly, as published then.
      const target = await prisma.configVersion.findUnique({ where: { version: args.restoreVersion } });
      if (!target) throw new Error(`no version ${args.restoreVersion} to restore`);
      payload = target.payload;
      spatial = target.payload.spatial;
    } else {
      spatial = rehearsal.g4SpatialFrom(payload.spatial, { proposal, rnsitRowId: before.region.id });
    }
    const diff = rehearsal.spatialDiff(before.row.payload.spatial, spatial);
    step("1 read (READ ONLY)", { pinned: before.pin.version, versions: before.versions, signature: `${before.row.signature.slice(0, 16)}…`, g4Digest: `${digest.slice(0, 12)}…`, zoneRows: before.zones.map((z) => z.id).sort() });

    // 2 — checks.
    const engine = rehearsal.engineFindings(spatial);
    const references = rehearsal.zoneRowFindings(spatial, before.zones);
    const onlyCells =
      diff.cellsOtherwiseChanged === 0 && diff.regionsIdentical && diff.sitesIdentical && diff.cellsBefore === diff.cellsAfter &&
      (args.restoreVersion !== null ? true : diff.cellsWithNewZone === 64);
    step("2 checks", { engineFindings: engine, zoneReferenceFindings: references, onlyTheRnsitCellsChange: onlyCells, diff });
    if (engine.length || references.length || !onlyCells) throw new Error("the candidate is not publishable; nothing was sent");

    const cookie = process.env.ROBOTX_SESSION_COOKIE || null;
    let session = cookie;
    if (!session) {
      if (!process.env.ROBOTX_OPERATOR_PASSWORD) throw new Error("set ROBOTX_OPERATOR_PASSWORD (or ROBOTX_SESSION_COOKIE) in the environment");
      const login = await http(args.api, null, "POST", "/api/auth/login", { email: args.email, password: process.env.ROBOTX_OPERATOR_PASSWORD });
      if (login.status !== 200 || !login.setCookie) throw new Error(`login refused (HTTP ${login.status})`);
      session = login.setCookie.split(";")[0];
    }
    const listed = await http(args.api, session, "GET", "/api/config/versions?limit=5");
    if (listed.status !== 200) throw new Error(`GET /api/config/versions: HTTP ${listed.status}`);
    if (listed.json.activeVersion !== before.pin.version) throw new Error(`the API serves version ${listed.json.activeVersion}, the database pins ${before.pin.version}: not the same environment`);
    step("2b API agrees with the database", { apiActiveVersion: listed.json.activeVersion });

    if (!args.apply) {
      step("DRY RUN", { wouldPublish: args.restoreVersion !== null ? `version ${args.restoreVersion} restored` : "G4 (64 RNSIT cells → 4 zones)", via: "POST /api/config/publish", rollbackTarget: before.pin.version });
      return report;
    }

    // 3 — the authorised route.
    const published = await http(args.api, session, "POST", "/api/config/publish", {
      bindings: payload.bindings || [],
      killSwitchState: payload.killSwitchState,
      regimes: payload.regimes || [],
      spatial,
      deliveryDomain: payload.deliveryDomain || null,
      note:
        args.restoreVersion !== null
          ? `RECOVERY: version ${args.restoreVersion} republished exactly (replacing version ${before.pin.version}).`
          : `G4 RNSIT four-zone layout (digest ${digest.slice(0, 12)}…): version ${before.pin.version} restated with the 64 RNSIT cells reassigned to rnsit-z-west/east/south/southwest. Owner-authorised 2026-10-23.`,
      reason: args.reason,
      secondApproverId: args.secondApproverId,
    });
    step("3 POST /api/config/publish", { status: published.status, ok: published.json?.ok, version: published.json?.version, pinned: published.json?.pinned, safetyClassChanges: published.json?.safetyClassChanges, message: published.json?.message, refusal: published.json?.refusal, findings: published.json?.findings });
    if (published.status !== 200 || !published.json?.ok) throw new Error("the route refused the publish; the pin is unchanged");

    // 4 — authoritative reads.
    const after = await readState(prisma);
    const resolved = rehearsal.resolveCover({ spatial: after.row.payload.spatial }, context.cover);
    const counts = {};
    for (const z of resolved.values()) counts[z] = (counts[z] || 0) + 1;
    const restoredZones = args.restoreVersion !== null ? rehearsal.resolveCover({ spatial }, context.cover) : null;
    const allG4 =
      args.restoreVersion !== null
        ? context.cover.every((c) => resolved.get(c) === restoredZones.get(c))
        : proposal.cells.every((r) => resolved.get(r.cellId) === r.zoneId);
    const listedAfter = await http(args.api, session, "GET", "/api/config/versions?limit=5");
    step("4 database + API", { dbPinned: after.pin.version, dbVersions: after.versions, apiActiveVersion: listedAfter.json?.activeVersion, coverResolvesTo: counts, matchesTarget: allG4, rollbackTarget: before.pin.version });
    let served = null;
    for (let i = 0; i < 40; i += 1) {
      const z = await http(args.api, session, "GET", "/api/dtaro/zones");
      served = z.json;
      if (served && served.configVersion === after.pin.version) break;
      await wait(5000);
    }
    step("4b GET /api/dtaro/zones", { configVersion: served?.configVersion, zones: (served?.zones || []).map((z) => `${z.zoneId}(${z.cellCount})`), alertsEnabled: served?.alertsEnabled });
    report.ok = after.pin.version === published.json.version && allG4 && served?.configVersion === after.pin.version;
    return report;
  } finally {
    await prisma.$disconnect();
  }
}

module.exports = { run, readState };

if (require.main === module) {
  run(parseArgs(process.argv.slice(2)))
    .then((report) => process.exit(report.apply && !report.ok ? 1 : 0))
    .catch((error) => {
      process.stderr.write(`STOPPED: ${redact(error.message)}\n`);
      process.exit(1);
    });
}
