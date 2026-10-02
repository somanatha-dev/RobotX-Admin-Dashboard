"use strict";

/**
 * Bootstrap a **LABELLED V1 DEMONSTRATION ENVIRONMENT** on a named database — the deployment
 * metadata the V1 engine needs, and nothing else.
 *
 * ── What it writes (find-or-create, by business key, in foreign-key order) ──────────────
 *   1. Region            `regionId = "rnsit"`
 *   2. Zone              `id = "rnsit-z1"`, the bounding box of the validated RNSIT boundary
 *   3. CellAssignment    the 64 FINE cells of D6's boundary-overlap cover, `mapVersion = 1`
 *   4. ShardLeadership   `shardId = --shard-id`, fence 1 (unheld)
 *   5. Shard             `shardId = --shard-id`, ACTIVE, owning the region
 *   6. Charger           one depot-class charger in the region (`isDepot = true`)
 *   7. ConfigVersion     the V1 demonstration configuration, labelled with this environment
 *   8. ConfigActiveVersion  that version, pinned
 *
 * Every value is the one `tools/demo/seedV1Demonstration.js` writes for the same rows, and the
 * configuration is assembled from the same producers it uses (`publishV1Demonstration.
 * publishRequest`, `v1DemonstrationConfig.executionBindings`). It is published through
 * `config/service.publish`, whose validators are untouched: V9 is satisfied only by the same
 * labelled `route.degraded_reserve_factor` accommodation the demonstration takes, and §22.3's
 * two-person rule (S2) by **two named human approvers** supplied on the command line — never by
 * the tool's own identity standing in for one of them.
 *
 * ── What it never writes ─────────────────────────────────────────────────────────────
 * Robots, agents, users, positions, observations, tasks, missions, legs, commitments, outbox rows.
 * Simulated robots are commissioned through the dashboard's real API (`POST /api/simulator/robot`);
 * placement, shard membership and the availability index are the running engine's own work.
 * It deletes nothing and updates no existing row. A pinned configuration it did not publish is a
 * refusal, not something to overwrite.
 *
 * ── Why this is not the demonstration seed pointed elsewhere ─────────────────────────────
 * The seed and the demonstration publisher refuse any non-loopback database, deliberately, and they
 * stay that way. A labelled environment on a hosted database is a separate, explicit act: the host
 * must be named twice (`--database-url` and `--confirm-host`), the environment must be named, and
 * the approvers must be people. The note on the published version says, in words, that this is a
 * labelled non-production environment and that B8 / D-1 remain open.
 *
 * Usage (dry run is the default; nothing is written without --apply):
 *   node tools/deploy/bootstrapV1Environment.js \
 *     --database-url <postgresql url> --confirm-host <exact hostname of that url> \
 *     --environment-label <name> --shard-id <id> \
 *     --approver <person 1> --approver <person 2> [--apply] [--json]
 *
 * Exit codes: 0 = plan clean (dry run) or applied and verified; 1 = refused (arguments, a
 * conflict, or a failed verification); 2 = unexpected error.
 */

const path = require("path");
const h3 = require("h3-js");

const BACKEND_ROOT = path.resolve(__dirname, "..", "..");

const seed = require(path.join(BACKEND_ROOT, "tools/demo/seedV1Demonstration"));
const publishTool = require(path.join(BACKEND_ROOT, "tools/config/publishV1Demonstration"));
const demonstration = require(path.join(BACKEND_ROOT, "tools/config/v1DemonstrationConfig"));
const configService = require(path.join(BACKEND_ROOT, "src/engine/config/service"));
const deliveryDomain = require(path.join(BACKEND_ROOT, "src/engine/spatial/deliveryDomain"));
const cells = require(path.join(BACKEND_ROOT, "src/engine/spatial/cells"));
const cutoverEnabled = require(path.join(BACKEND_ROOT, "src/engine/cutover/enabled"));

/** The identity this tool publishes and pins under; also how it recognises its own version. */
const TOOL_ID = "tools/deploy/bootstrapV1Environment.js";

/** The rows' business keys — the same the demonstration seed uses. */
const REGION_KEY = "rnsit";
const REGION_NAME = "RNSIT";
const ZONE_ID = "rnsit-z1";
const ZONE_NAME = "RNSIT Zone 1";
const MAP_VERSION = 1;
const DEPOT_CHARGER_ID = "V1DEMO-DEPOT-01";
const DEPOT_POINT = "rnsit-innovation-center";
/** D6's boundary-overlap cover of the adopted boundary has exactly this many FINE cells. */
const EXPECTED_COVER_CELLS = 64;

/** A label or shard id: short, printable, no whitespace. */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{1,62}$/;

/** The line that marks a version as this tool's, for this environment. */
function labelMarker(label) {
  return `[LABELLED V1 DEMONSTRATION ENVIRONMENT: ${label}]`;
}

/* ═══════════════════════════════════════════════════════════════════════════
   Arguments
   ═══════════════════════════════════════════════════════════════════════════ */

function parseArguments(argv) {
  const args = { approvers: [], apply: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const name = argv[i];
    const next = () => {
      const value = argv[i + 1];
      i += 1;
      return value;
    };
    if (name === "--database-url") args.databaseUrl = next();
    else if (name === "--confirm-host") args.confirmHost = next();
    else if (name === "--environment-label") args.label = next();
    else if (name === "--shard-id") args.shardId = next();
    else if (name === "--approver") args.approvers.push(next());
    else if (name === "--apply") args.apply = true;
    else if (name === "--json") args.json = true;
    else throw refusal(`unknown argument "${name}"`);
  }
  return args;
}

function refusal(message) {
  const error = new Error(message);
  error.refusal = true;
  return error;
}

/**
 * Every argument rule, checked before anything connects.
 *
 * @returns {{ host: string }}
 */
function validateArguments(args) {
  if (!args.databaseUrl) throw refusal("--database-url is required");
  let url;
  try {
    url = new URL(args.databaseUrl);
  } catch {
    throw refusal("--database-url could not be parsed");
  }
  if (!/^postgres(ql)?:$/.test(url.protocol)) throw refusal("--database-url must be a postgresql:// URL");
  if (!args.confirmHost) throw refusal("--confirm-host is required: name the database host you mean, exactly");
  if (url.hostname !== args.confirmHost) {
    throw refusal(`--confirm-host "${args.confirmHost}" does not match the database host "${url.hostname}"; nothing was read or written`);
  }
  if (!args.label || !NAME_PATTERN.test(args.label)) {
    throw refusal("--environment-label is required: 2–63 characters of letters, digits, '.', '_' or '-'");
  }
  if (!args.shardId || !NAME_PATTERN.test(args.shardId)) {
    throw refusal("--shard-id is required: 2–63 characters of letters, digits, '.', '_' or '-'");
  }
  const approvers = args.approvers.map((name) => String(name || "").trim());
  if (approvers.length !== 2 || approvers.some((name) => name === "")) {
    throw refusal("exactly two --approver names are required (§22.3's two-person rule)");
  }
  if (approvers[0].toLowerCase() === approvers[1].toLowerCase()) {
    throw refusal("the two --approver names must be two different people");
  }
  if (approvers.some((name) => name === TOOL_ID)) {
    throw refusal("an approver must be a person, not this tool");
  }
  return { host: url.hostname, database: url.pathname.replace(/^\//, "") };
}

/* ═══════════════════════════════════════════════════════════════════════════
   The intended world — derived, never read from the database
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * The rows and the configuration this environment needs, computed from the adopted boundary.
 * The same derivations `seedV1Demonstration.seedWorld` performs for the same rows.
 */
function intendedWorld() {
  // Digest-checked: refuses if the committed boundary file is not the adopted one.
  const { boundary, points } = seed.loadGeometry();

  const declaration = {
    regionId: "rnsit-campus",
    name: "RNSIT Campus",
    kind: "CAMPUS",
    crs: "EPSG:4326",
    version: "way/1120154292",
    versionDate: "2026-08-30",
    boundary,
  };
  const domain = deliveryDomain.validateDomainDeclaration(declaration);

  const indexCover = h3.polygonToCellsExperimental(
    boundary.coordinates,
    cells.H3_RESOLUTION.FINE,
    h3.POLYGON_TO_CELLS_FLAGS.containmentOverlapping,
    true,
  );
  if (indexCover.length !== EXPECTED_COVER_CELLS) {
    throw refusal(`the boundary cover has ${indexCover.length} FINE cells, not the adopted ${EXPECTED_COVER_CELLS}`);
  }

  const depot = points[DEPOT_POINT];
  if (!depot) throw refusal(`the campus reference point "${DEPOT_POINT}" is missing`);

  return {
    declaration,
    zoneBox: domain.bbox,
    indexCover: [...indexCover].sort(),
    depot: { lat: depot.lat, lon: depot.lon, cellId: cells.cellForPoint(depot.lat, depot.lon, cells.RESOLUTION.FINE) },
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   The plan — read only
   ═══════════════════════════════════════════════════════════════════════════ */

/** The rows nobody should find a bootstrap adding; counted before and after `--apply`. */
const UNTOUCHED_TABLES = ["robot", "agent", "user", "task", "mission", "leg", "commitment", "outbox", "agentCellPosition", "observation"];

async function untouchedCounts(prisma) {
  const out = {};
  for (const table of UNTOUCHED_TABLES) {
    // eslint-disable-next-line no-await-in-loop
    out[table] = await prisma[table].count();
  }
  return out;
}

/**
 * Compare the database with the intended world. Each step is CREATE, EXISTS (already exactly
 * what is intended), or CONFLICT (something is there that this tool must not overwrite).
 */
async function plan(prisma, args, world) {
  const steps = [];
  const step = (row, action, detail) => steps.push({ row, action, detail });

  const region = await prisma.region.findUnique({ where: { regionId: REGION_KEY } });
  if (!region) step("Region", "CREATE", `regionId="${REGION_KEY}" name="${REGION_NAME}"`);
  else step("Region", "EXISTS", `regionId="${REGION_KEY}" id=${region.id}`);

  const zoneById = await prisma.zone.findUnique({ where: { id: ZONE_ID } });
  const zoneByName = await prisma.zone.findUnique({ where: { name: ZONE_NAME } });
  if (zoneById) {
    if (region && zoneById.regionId === region.id && zoneById.name === ZONE_NAME) step("Zone", "EXISTS", `id="${ZONE_ID}"`);
    else step("Zone", "CONFLICT", `zone "${ZONE_ID}" exists but does not belong to region "${REGION_KEY}" under the name "${ZONE_NAME}"`);
  } else if (zoneByName) {
    step("Zone", "CONFLICT", `a zone named "${ZONE_NAME}" already exists with id ${zoneByName.id}; it is not this tool's and will not be changed`);
  } else {
    step("Zone", "CREATE", `id="${ZONE_ID}" name="${ZONE_NAME}" bbox=${JSON.stringify(world.zoneBox)}`);
  }

  const existingCells = await prisma.cellAssignment.findMany({
    where: { cellId: { in: world.indexCover }, mapVersion: MAP_VERSION },
    select: { cellId: true, regionId: true, zoneId: true, resolution: true },
  });
  const foreign = existingCells.filter(
    (row) => !region || row.regionId !== region.id || row.zoneId !== ZONE_ID || row.resolution !== "FINE",
  );
  const missingCells = world.indexCover.filter((cellId) => !existingCells.some((row) => row.cellId === cellId));
  if (foreign.length > 0) {
    step("CellAssignment", "CONFLICT", `${foreign.length} of the ${world.indexCover.length} cover cells are already assigned elsewhere at mapVersion ${MAP_VERSION}`);
  } else if (missingCells.length === 0) {
    step("CellAssignment", "EXISTS", `${world.indexCover.length} FINE cells, mapVersion ${MAP_VERSION}`);
  } else {
    step("CellAssignment", "CREATE", `${missingCells.length} of ${world.indexCover.length} FINE cells, mapVersion ${MAP_VERSION}`);
  }

  const leadership = await prisma.shardLeadership.findUnique({ where: { shardId: args.shardId } });
  if (!leadership) step("ShardLeadership", "CREATE", `shardId="${args.shardId}" leadershipFence=1 (unheld)`);
  else step("ShardLeadership", "EXISTS", `shardId="${args.shardId}" fence=${leadership.leadershipFence} holder=${leadership.holder || "none"}`);

  const shard = await prisma.shard.findUnique({ where: { shardId: args.shardId } });
  const shardOfRegion = region ? await prisma.shard.findUnique({ where: { regionId: region.id } }) : null;
  if (shard) {
    if (region && shard.regionId === region.id) step("Shard", "EXISTS", `shardId="${args.shardId}" state=${shard.state}`);
    else step("Shard", "CONFLICT", `shard "${args.shardId}" already exists for a different region`);
  } else if (shardOfRegion) {
    step("Shard", "CONFLICT", `region "${REGION_KEY}" is already owned by shard "${shardOfRegion.shardId}"; --shard-id must name it`);
  } else {
    step("Shard", "CREATE", `shardId="${args.shardId}" state=ACTIVE region="${REGION_KEY}"`);
  }

  const charger = await prisma.charger.findUnique({ where: { chargerId: DEPOT_CHARGER_ID } });
  if (!charger) step("Charger", "CREATE", `chargerId="${DEPOT_CHARGER_ID}" isDepot=true cell=${world.depot.cellId}`);
  else if (region && charger.regionId === region.id && charger.isDepot === true) step("Charger", "EXISTS", `chargerId="${DEPOT_CHARGER_ID}" (depot)`);
  else step("Charger", "CONFLICT", `charger "${DEPOT_CHARGER_ID}" exists but is not a depot of region "${REGION_KEY}"`);

  // ── The configuration ────────────────────────────────────────────────────────────
  const marker = labelMarker(args.label);
  const versions = await prisma.configVersion.findMany({
    orderBy: { version: "asc" },
    select: { version: true, publishedBy: true, note: true },
  });
  const ours = (row) => row.publishedBy === TOOL_ID && typeof row.note === "string" && row.note.includes(marker);
  const pin = await prisma.configActiveVersion.findFirst();
  const foreignVersions = versions.filter((row) => !ours(row));
  let config = { publish: false, pinVersion: null, verify: false };

  if (pin) {
    const pinned = versions.find((row) => row.version === pin.version);
    if (pinned && ours(pinned)) {
      step("ConfigVersion", "EXISTS", `version ${pin.version}, published by this tool for "${args.label}"`);
      step("ConfigActiveVersion", "EXISTS", `pinned to version ${pin.version}`);
      config = { publish: false, pinVersion: null, verify: true };
    } else {
      step("ConfigActiveVersion", "CONFLICT", `version ${pin.version} is pinned and was not published by this tool for "${args.label}"; it will not be replaced`);
    }
  } else if (foreignVersions.length > 0) {
    step("ConfigVersion", "CONFLICT", `${foreignVersions.length} configuration version(s) exist that this tool did not publish (e.g. version ${foreignVersions[0].version} by "${foreignVersions[0].publishedBy}")`);
  } else {
    const mine = versions.filter(ours);
    if (mine.length > 0) {
      const latest = mine[mine.length - 1];
      step("ConfigVersion", "EXISTS", `version ${latest.version}, published by this tool, not yet pinned`);
      step("ConfigActiveVersion", "CREATE", `pin version ${latest.version}`);
      config = { publish: false, pinVersion: latest.version, verify: true };
    } else {
      step("ConfigVersion", "CREATE", `the labelled V1 demonstration configuration, approved by ${args.approvers.join(" and ")}`);
      step("ConfigActiveVersion", "CREATE", "pin the version just published");
      config = { publish: true, pinVersion: null, verify: true };
    }
  }

  return {
    steps,
    conflicts: steps.filter((entry) => entry.action === "CONFLICT"),
    region,
    missingCells,
    leadership,
    shard,
    charger,
    config,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   The configuration request — the demonstration's, with named approvers
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * `seedV1Demonstration.publishConfiguration` assembles this request with the demonstration
 * tool's own two approver identities; a deployed environment needs people instead, so the same
 * parts are assembled here and only `approvals`, `publishedBy` and the label line differ.
 */
function publishRequest(args, world, regionRowId) {
  const base = publishTool.publishRequest({ accommodate: true });
  const approvedAt = new Date().toISOString();
  return {
    publishedBy: TOOL_ID,
    bindings: [
      ...base.bindings,
      ...demonstration.executionBindings(),
      { level: "region", key: regionRowId, name: "cutover.engine_enabled", value: true },
    ],
    approvals: args.approvers.map((approverId) => ({ approverId, approvedAt })),
    spatial: {
      version: MAP_VERSION,
      regions: [{ id: regionRowId }],
      zones: [{ id: ZONE_ID, regionId: regionRowId }],
      sites: [],
      cells: world.indexCover.map((cellId) => ({ cellId, resolution: "FINE", regionId: regionRowId, zoneId: ZONE_ID })),
    },
    deliveryDomain: world.declaration,
    note:
      `${labelMarker(args.label)} NOT PRODUCTION. Bootstrapped by ${TOOL_ID}: the V1 execution parameters ` +
      `are bound and cutover.engine_enabled is bound for region ${REGION_KEY} (${regionRowId}); the spatial ` +
      "index is D6's boundary-overlap cover of the adopted RNSIT boundary and the delivery domain is that same " +
      `adopted declaration. Approved for this labelled environment by ${args.approvers.join(" and ")}. | ` +
      base.note,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   Apply
   ═══════════════════════════════════════════════════════════════════════════ */

async function applyWorld(prisma, args, world, found) {
  return prisma.$transaction(
    async (tx) => {
      const region =
        found.region || (await tx.region.create({ data: { regionId: REGION_KEY, name: REGION_NAME } }));

      if (!(await tx.zone.findUnique({ where: { id: ZONE_ID } }))) {
        await tx.zone.create({
          data: {
            id: ZONE_ID,
            name: ZONE_NAME,
            regionId: region.id,
            minLat: world.zoneBox.minLat,
            maxLat: world.zoneBox.maxLat,
            minLon: world.zoneBox.minLon,
            maxLon: world.zoneBox.maxLon,
          },
        });
      }

      if (found.missingCells.length > 0) {
        await tx.cellAssignment.createMany({
          data: found.missingCells.map((cellId) => ({
            cellId,
            resolution: "FINE",
            regionId: region.id,
            zoneId: ZONE_ID,
            mapVersion: MAP_VERSION,
          })),
        });
      }

      if (!found.leadership) await tx.shardLeadership.create({ data: { shardId: args.shardId, leadershipFence: 1 } });
      if (!found.shard) await tx.shard.create({ data: { shardId: args.shardId, regionId: region.id, state: "ACTIVE" } });

      if (!found.charger) {
        await tx.charger.create({
          data: {
            chargerId: DEPOT_CHARGER_ID,
            regionId: region.id,
            cellId: world.depot.cellId,
            chargerClass: "STANDARD",
            isDepot: true,
            latitude: world.depot.lat,
            longitude: world.depot.lon,
          },
        });
      }
      return region;
    },
    { timeout: 60_000, maxWait: 20_000 },
  );
}

/**
 * Read back what a running `server.js` will read: the pinned snapshot, the V1 execution bindings,
 * the cutover binding for the region, the spatial cover, and the world rows.
 */
async function verify(prisma, args, world) {
  const problems = [];
  const region = await prisma.region.findUnique({ where: { regionId: REGION_KEY } });
  if (!region) problems.push(`no region "${REGION_KEY}"`);
  const shard = await prisma.shard.findUnique({ where: { shardId: args.shardId } });
  if (!shard || !region || shard.regionId !== region.id || shard.state !== "ACTIVE") problems.push(`shard "${args.shardId}" is not ACTIVE for region "${REGION_KEY}"`);
  const cellCount = region ? await prisma.cellAssignment.count({ where: { regionId: region.id, zoneId: ZONE_ID, mapVersion: MAP_VERSION, resolution: "FINE" } }) : 0;
  if (cellCount !== world.indexCover.length) problems.push(`${cellCount} cover cells, not ${world.indexCover.length}`);
  const depots = region ? await prisma.charger.count({ where: { regionId: region.id, isDepot: true } }) : 0;
  if (depots < 1) problems.push("no depot charger in the region");

  const pinned = await configService.loadPinnedSnapshot({ prisma });
  if (!pinned) {
    problems.push("no configuration version is pinned");
  } else {
    for (const binding of demonstration.executionBindings()) {
      const actual = pinned.values.get(binding.name);
      if (JSON.stringify(actual) !== JSON.stringify(binding.value)) problems.push(`pinned ${binding.name}=${JSON.stringify(actual)}, expected ${JSON.stringify(binding.value)}`);
    }
    if (!region || !cutoverEnabled.configEnabled(pinned, { regionId: region.id })) problems.push("cutover.engine_enabled does not resolve true for the region");
    const spatialCells = pinned.spatial && Array.isArray(pinned.spatial.cells) ? pinned.spatial.cells.length : 0;
    if (spatialCells !== world.indexCover.length) problems.push(`the pinned spatial index has ${spatialCells} cells`);
    if (!pinned.deliveryDomain) problems.push("the pinned version carries no delivery-domain declaration");
  }
  return {
    ok: problems.length === 0,
    problems,
    summary: {
      region: region ? { regionId: region.regionId, id: region.id } : null,
      shard: shard ? { shardId: shard.shardId, state: shard.state } : null,
      cells: cellCount,
      depotChargers: depots,
      pinnedVersion: pinned ? pinned.version : null,
      cutoverEngineEnabled: Boolean(region && pinned && cutoverEnabled.configEnabled(pinned, { regionId: region.id })),
    },
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   Main
   ═══════════════════════════════════════════════════════════════════════════ */

async function main(argv) {
  const args = parseArguments(argv);
  const target = validateArguments(args);
  const world = intendedWorld();

  const { PrismaClient } = require(path.join(BACKEND_ROOT, "node_modules/@prisma/client"));
  const prisma = new PrismaClient({ datasources: { db: { url: args.databaseUrl } } });
  const report = { mode: args.apply ? "APPLY" : "DRY RUN", target: `${target.host}/${target.database}`, label: args.label, shardId: args.shardId };
  try {
    const found = await plan(prisma, args, world);
    report.plan = found.steps;

    if (found.conflicts.length > 0) {
      report.result = "REFUSED: conflicts found; nothing was written";
      return { code: 1, report };
    }
    if (!args.apply) {
      report.result = found.steps.some((entry) => entry.action === "CREATE")
        ? "DRY RUN: nothing was written; re-run with --apply to perform the CREATE steps above"
        : "DRY RUN: the environment is already bootstrapped; nothing to do";
      return { code: 0, report };
    }

    const before = await untouchedCounts(prisma);
    const region = await applyWorld(prisma, args, world, found);

    let version = found.config.pinVersion;
    if (found.config.publish) {
      const published = await configService.publish(prisma, publishRequest(args, world, region.id));
      version = published.version;
    }
    if (version !== null && version !== undefined) {
      await configService.pinVersion(prisma, null, version, TOOL_ID);
    }

    const after = await untouchedCounts(prisma);
    const verification = await verify(prisma, args, world);
    report.verification = verification;
    report.untouched = { before, after, unchanged: JSON.stringify(before) === JSON.stringify(after) };
    if (!report.untouched.unchanged) verification.problems.push("rows outside the bootstrap's scope changed during apply");
    report.result = verification.ok && report.untouched.unchanged ? "APPLIED AND VERIFIED" : "APPLIED BUT VERIFICATION FAILED";
    return { code: verification.ok && report.untouched.unchanged ? 0 : 1, report };
  } finally {
    await prisma.$disconnect();
  }
}

function print(report, asJson) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, (key, value) => (typeof value === "bigint" ? String(value) : value), 2)}\n`);
    return;
  }
  const lines = [
    "═══════════════════════════════════════════════════════════════════════",
    ` V1 LABELLED DEMONSTRATION ENVIRONMENT BOOTSTRAP — ${report.mode}. NOT PRODUCTION.`,
    `   target   ${report.target}`,
    `   label    ${report.label}    shard ${report.shardId}`,
    "───────────────────────────────────────────────────────────────────────",
    ...(report.plan || []).map((entry) => `   ${entry.action.padEnd(8)} ${entry.row.padEnd(20)} ${entry.detail}`),
    "───────────────────────────────────────────────────────────────────────",
  ];
  if (report.verification) {
    lines.push(`   verify   ${JSON.stringify(report.verification.summary)}`);
    for (const problem of report.verification.problems) lines.push(`   PROBLEM  ${problem}`);
    lines.push(`   scope    robots/agents/users/tasks/missions/legs/commitments/outbox/positions/observations unchanged: ${report.untouched.unchanged}`);
  }
  lines.push(` ${report.result}`, "═══════════════════════════════════════════════════════════════════════");
  process.stdout.write(`${lines.join("\n")}\n`);
}

module.exports = { TOOL_ID, labelMarker, parseArguments, validateArguments, intendedWorld, plan, publishRequest, verify };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const asJson = argv.includes("--json");
  main(argv)
    .then(({ code, report }) => {
      print(report, asJson);
      process.exit(code);
    })
    .catch((error) => {
      if (error && error.refusal) {
        process.stderr.write(`REFUSED: ${error.message}\n`);
        process.exit(1);
      }
      const detail = error && error.findings ? ` ${JSON.stringify(error.findings)}` : "";
      process.stderr.write(`ERROR: ${error && error.message}${detail}\n`);
      process.exit(2);
    });
}
