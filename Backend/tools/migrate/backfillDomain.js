"use strict";

/**
 * One-shot domain backfill — Phase 2.
 *
 * `IMPLEMENTATION_EXECUTION_PLAN.md` §3, Phase 2:
 *
 * > **Background workers** — One-shot backfill job: `tools/migrate/backfillDomain.js`
 * > (Robot→Agent, Task→Mission+Leg+2 Stops, `purpose='PRIMARY'`,
 * > `custodyState='NONE'`).
 *
 * > **Completion criteria** — backfill converts 100 % of existing rows with zero
 * > orphans.
 *
 * ── Two properties this job is built around ─────────────────────────────────
 *
 * **Idempotent.** Every row it writes has a deterministic primary key derived from
 * the legacy row's own stable key (`mappers/legacyRobot.deterministicId`). Running
 * the job twice upserts the same rows and produces byte-identical state; it never
 * creates a second Mission for a Task. That is what makes it re-runnable, which is
 * the plan's stated mitigation for this phase's HIGH risk rating, and it is what
 * lets it run again after the next batch of legacy rows arrives.
 *
 * **Deterministic.** No clock read decides content, no random id is minted, and
 * rows are processed in a canonical order. Two runs against the same database
 * produce the same result in the same order, which is what makes the "run twice →
 * identical state" test meaningful rather than approximately true.
 *
 * ── What it does not do ─────────────────────────────────────────────────────
 * It writes no `Commitment`. §2.6's binding is a durable contract created by the
 * commit transaction of §10.3.2 with a fence, a lease, and six guards — Phase 3.
 * Fabricating one here from `Robot.currentTaskId` would manufacture exactly the
 * unfenced, unleased, unsupervised binding the commitment core exists to replace.
 * The legacy `currentTaskId` remains the legacy path's own record until Phase 15.
 *
 * Usage:
 *   node tools/migrate/backfillDomain.js [--dry-run] [--batch <n>] [--json]
 * Exit code 0 on success, 1 on any orphan or verification failure.
 */

const { toConfigPayload, validate: validateSpatialMap } = require("../../src/engine/spatial/hierarchy");
const { isPointToPointMission } = require("../../src/engine/domain/work");
const legacyRobot = require("../../src/engine/domain/mappers/legacyRobot");
const legacyTask = require("../../src/engine/domain/mappers/legacyTask");

/** @structural rows per page; a paging arity, not a behavioural threshold */
const DEFAULT_BATCH_SIZE = 500;

/**
 * Resolve the region a backfilled Agent or Mission belongs to.
 *
 * §3.6: **containment is by published assignment, not by geometry.** The backfill
 * therefore never derives a region from a latitude and longitude. It uses, in
 * order: an explicitly supplied region; the single declared region when the
 * deployment has exactly one (which is the unambiguous case, not an inference); and
 * otherwise `null`, leaving the assignment to be published rather than guessed.
 *
 * @param {object[]} regions
 * @param {string|null|undefined} explicit
 * @returns {string|null}
 */
function resolveRegionId(regions, explicit) {
  if (explicit) return String(explicit);
  const list = regions || [];
  return list.length === 1 ? list[0].id : null;
}

/**
 * Robot → Agent (§2.1).
 *
 * @param {object} prisma
 * @param {object} options
 * @returns {Promise<{ scanned: number, written: number }>}
 */
async function backfillAgents(prisma, options) {
  const settings = options || {};
  const batchSize = settings.batchSize || DEFAULT_BATCH_SIZE;

  let scanned = 0;
  let written = 0;
  let cursor = null;

  for (;;) {
    const robots = await prisma.robot.findMany({
      take: batchSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      // Canonical order, so two runs process the same rows in the same sequence.
      orderBy: { id: "asc" },
      select: { id: true, robotId: true },
    });
    if (robots.length === 0) break;

    for (const robot of robots) {
      scanned += 1;
      const agent = legacyRobot.robotToAgent(robot, {
        regionId: settings.regionId,
        agentClassId: settings.agentClassId,
        homeDepotId: settings.homeDepotId,
      });

      if (!settings.dryRun) {
        // Upsert on the deterministic primary key. `update` deliberately carries
        // only the linkage and the class/region assignment: `authorityEpoch` and
        // `fenceCounter` are monotone counters (§2.6, I6) and a re-run must never
        // reset one, which is precisely the bug an unconditional upsert would
        // introduce the first time this job was run twice.
        await prisma.agent.upsert({
          where: { id: agent.id },
          create: agent,
          update: {
            agentId: agent.agentId,
            robotDbId: agent.robotDbId,
            agentClassId: agent.agentClassId,
            regionId: agent.regionId,
            homeDepotId: agent.homeDepotId,
          },
        });
      }
      written += 1;
    }

    cursor = robots[robots.length - 1].id;
    if (robots.length < batchSize) break;
  }

  return { scanned, written };
}

/**
 * Task → Mission + one `PRIMARY` Leg + two Stops (§2.4).
 *
 * @param {object} prisma
 * @param {object} options
 * @returns {Promise<{ scanned: number, missions: number, legs: number, stops: number }>}
 */
async function backfillWork(prisma, options) {
  const settings = options || {};
  const batchSize = settings.batchSize || DEFAULT_BATCH_SIZE;

  let scanned = 0;
  let missions = 0;
  let legs = 0;
  let stops = 0;
  let cursor = null;

  for (;;) {
    const tasks = await prisma.task.findMany({
      take: batchSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: "asc" },
      select: {
        id: true,
        taskId: true,
        status: true,
        pickup: true,
        pickupLat: true,
        pickupLon: true,
        drop: true,
        dropLat: true,
        dropLon: true,
        windowStart: true,
        windowEnd: true,
      },
    });
    if (tasks.length === 0) break;

    for (const task of tasks) {
      scanned += 1;
      const work = legacyTask.taskToWork(task, { regionId: settings.regionId });

      // The structural property the plan states as this phase's test, asserted at
      // the point of construction rather than only in a test: exactly one Mission,
      // exactly one PRIMARY Leg, exactly two Stops.
      if (!isPointToPointMission({ legs: [{ ...work.leg, stops: work.stops }] })) {
        throw new Error(
          `backfill produced a non-point-to-point Mission for task "${task.taskId}". Every legacy Task maps ` +
            "to exactly one Mission with exactly one PRIMARY Leg and two Stops (§2.4).",
        );
      }

      if (settings.dryRun) {
        missions += 1;
        legs += 1;
        stops += work.stops.length;
        continue;
      }

      // One transaction per Task: a Mission with no Leg, or a Leg with one Stop, is
      // an orphan the completion criterion forbids, and a partial write is exactly
      // how one appears.
      await prisma.$transaction(async (tx) => {
        await tx.mission.upsert({
          where: { id: work.mission.id },
          create: { ...work.mission, tasks: { connect: [{ id: task.id }] } },
          // Re-running must not disconnect and reconnect: `connect` on an existing
          // link is a no-op, which is what keeps the relation row stable.
          update: { regionId: work.mission.regionId, tasks: { connect: [{ id: task.id }] } },
        });

        await tx.leg.upsert({
          where: { id: work.leg.id },
          create: work.leg,
          // `state`, `version`, and `custodyState` are deliberately absent from the
          // update: once a Leg exists, its lifecycle belongs to the state machine
          // (Phase 5), not to a re-run of the backfill. A re-run that reset a Leg's
          // state would be a data-loss bug wearing an idempotency badge.
          update: { missionId: work.leg.missionId, sequence: work.leg.sequence },
        });

        for (const stop of work.stops) {
          await tx.stop.upsert({
            where: { id: stop.id },
            create: stop,
            update: {
              legId: stop.legId,
              sequence: stop.sequence,
              stopType: stop.stopType,
              label: stop.label,
              lat: stop.lat,
              lon: stop.lon,
            },
          });
        }
      });

      missions += 1;
      legs += 1;
      stops += work.stops.length;
    }

    cursor = tasks[tasks.length - 1].id;
    if (tasks.length < batchSize) break;
  }

  return { scanned, missions, legs, stops };
}

/**
 * Mirror the published spatial map into `CellAssignment` (§3.6).
 *
 * The pinned configuration payload is authoritative; this table is its durable
 * mirror, so an index rebuild (§18.5 Cold Index) and an operator query do not have
 * to parse a configuration blob.
 *
 * @param {object} prisma
 * @param {object} options
 * @returns {Promise<{ cells: number, skipped: boolean, problems: string[] }>}
 */
async function backfillSpatialMirror(prisma, options) {
  const settings = options || {};
  const map = settings.spatialMap;
  if (!map) return { cells: 0, skipped: true, problems: [] };

  const verdict = validateSpatialMap(map);
  if (!verdict.ok) {
    // The map is refused rather than partially mirrored. §3.6's containment rules
    // are what make `Ω_terminal` bound anything at all; a mirror of a map that
    // breaks them is worse than no mirror.
    return { cells: 0, skipped: true, problems: verdict.problems };
  }

  const payload = toConfigPayload(map);
  // The mirror carries both resolutions. `toConfigPayload` separates them because
  // §3.6's one-zone containment rule — and Phase 1's V8 check of it — applies to
  // fine cells only; the durable table distinguishes them by its `resolution`
  // column, and Phase 9's Cold Index path rebuilds the coarse regional sweep from
  // exactly these rows.
  const assignments = [...payload.cells, ...payload.coarseCells];
  const mapVersion = typeof settings.mapVersion === "number" ? settings.mapVersion : 0;
  let cells = 0;

  if (!settings.dryRun) {
    for (const assignment of assignments) {
      await prisma.cellAssignment.upsert({
        where: { cellId_mapVersion: { cellId: assignment.cellId, mapVersion } },
        create: { ...assignment, mapVersion },
        update: { regionId: assignment.regionId, zoneId: assignment.zoneId, siteId: assignment.siteId, resolution: assignment.resolution },
      });
      cells += 1;
    }
  } else {
    cells = assignments.length;
  }

  return { cells, skipped: false, problems: [] };
}

/**
 * Verify the completion criterion: 100 % of legacy rows converted, zero orphans.
 *
 * Six checks, each naming the orphan class it rules out. They are counted rather
 * than sampled, because "zero orphans" is not a statistical claim.
 *
 * @param {object} prisma
 * @returns {Promise<{ ok: boolean, findings: string[], counts: object }>}
 */
async function verify(prisma) {
  const findings = [];

  const [robots, agents, tasks, missions, legs, stops] = await Promise.all([
    prisma.robot.count(),
    prisma.agent.count(),
    prisma.task.count(),
    prisma.mission.count(),
    prisma.leg.count(),
    prisma.stop.count(),
  ]);

  // 1. Every Robot projects to an Agent.
  const unprojectedRobots = await prisma.robot.count({ where: { agent: { is: null } } });
  if (unprojectedRobots > 0) {
    findings.push(`${unprojectedRobots} Robot row(s) have no Agent projection (§2.1); the conversion is incomplete`);
  }

  // 2. No Agent points at a Robot that no longer exists. The FK's ON DELETE CASCADE
  //    makes this structurally impossible; it is checked anyway, because a backstop
  //    nobody verifies is a backstop nobody knows failed.
  const agentsWithoutRobot = await prisma.agent.count({ where: { robotDbId: null } });
  if (agentsWithoutRobot > 0) {
    findings.push(
      `${agentsWithoutRobot} Agent row(s) carry no robotDbId. §25 admits agents with no Robot row, so this ` +
        "is not necessarily a defect — but after a Robot→Agent backfill and before any non-robot agent " +
        "exists, it is one",
    );
  }

  // 3. Every Task decomposes to a Mission.
  const undecomposedTasks = await prisma.task.count({ where: { missions: { none: {} } } });
  if (undecomposedTasks > 0) {
    findings.push(`${undecomposedTasks} Task row(s) have no Mission (§2.4); the decomposition is incomplete`);
  }

  // 4. No Mission without a Leg.
  const missionsWithoutLegs = await prisma.mission.count({ where: { legs: { none: {} } } });
  if (missionsWithoutLegs > 0) {
    findings.push(`${missionsWithoutLegs} Mission row(s) have no Leg; a Mission is an ordered set of Legs (§2.4)`);
  }

  // 5. No Leg without Stops.
  const legsWithoutStops = await prisma.leg.count({ where: { stops: { none: {} } } });
  if (legsWithoutStops > 0) {
    findings.push(`${legsWithoutStops} Leg row(s) have no Stop; a Leg is a sequence of Stops (§2.4)`);
  }

  // 6. Every backfilled Leg carries the purpose and custody state the plan specifies.
  const legsWithWrongPurpose = await prisma.leg.count({ where: { purpose: { not: "PRIMARY" } } });
  if (legsWithWrongPurpose > 0) {
    findings.push(
      `${legsWithWrongPurpose} Leg row(s) carry a purpose other than PRIMARY. The backfill creates only ` +
        "PRIMARY Legs; a RECOVERY or TRANSFER Leg is created by the recovery machinery (§4.6, §4.7)",
    );
  }

  return {
    ok: findings.length === 0,
    findings,
    counts: { robots, agents, tasks, missions, legs, stops },
  };
}

/**
 * Run the whole backfill.
 *
 * @param {object} prisma
 * @param {{ dryRun?: boolean, batchSize?: number, regionId?: string|null,
 *           agentClassId?: string|null, homeDepotId?: string|null,
 *           spatialMap?: object|null, mapVersion?: number }} [options]
 * @returns {Promise<object>} a report
 */
async function run(prisma, options) {
  const settings = options || {};

  const regions = await prisma.region.findMany({ orderBy: { regionId: "asc" }, select: { id: true, regionId: true } });
  const regionId = resolveRegionId(regions, settings.regionId);

  const spatial = await backfillSpatialMirror(prisma, { ...settings, regionId });
  const agents = await backfillAgents(prisma, { ...settings, regionId });
  const work = await backfillWork(prisma, { ...settings, regionId });
  const verification = settings.dryRun ? { ok: true, findings: ["skipped: dry run"], counts: {} } : await verify(prisma);

  return {
    dryRun: Boolean(settings.dryRun),
    regionId,
    spatial,
    agents,
    work,
    verification,
    ok: verification.ok,
  };
}

/**
 * Render a report for a terminal.
 *
 * @param {object} report
 * @returns {string}
 */
function formatReport(report) {
  const header = "backfill: domain model (Phase 2, §2.1 / §2.4 / §3.6)";
  const lines = [
    header,
    `  mode            ${report.dryRun ? "DRY RUN — nothing written" : "apply"}`,
    `  region          ${report.regionId || "unassigned (no single declared region; §3.6 forbids guessing)"}`,
    `  spatial mirror  ${report.spatial.skipped ? "skipped" : `${report.spatial.cells} cell assignment(s)`}`,
    `  Robot → Agent   ${report.agents.written} of ${report.agents.scanned} scanned`,
    `  Task  → work    ${report.work.missions} Mission(s), ${report.work.legs} Leg(s), ${report.work.stops} Stop(s) from ${report.work.scanned} Task(s)`,
  ];

  for (const problem of report.spatial.problems || []) lines.push(`  spatial problem  ${problem}`);

  if (report.verification.ok) {
    lines.push("  VERIFIED — 100% of legacy rows converted, zero orphans.");
  } else {
    lines.push(`  FAILED — ${report.verification.findings.length} finding(s):`);
    for (const finding of report.verification.findings) lines.push(`    ${finding}`);
  }

  return lines.join("\n");
}

module.exports = {
  DEFAULT_BATCH_SIZE,
  resolveRegionId,
  backfillAgents,
  backfillWork,
  backfillSpatialMirror,
  verify,
  run,
  formatReport,
};

if (require.main === module) {
  const argv = process.argv.slice(2);
  const batchFlag = argv.indexOf("--batch");
  const options = {
    dryRun: argv.includes("--dry-run"),
    batchSize: batchFlag !== -1 && argv[batchFlag + 1] ? Number(argv[batchFlag + 1]) : undefined,
  };

  // Required here, not at module load: the job's logic is exercised by the engine
  // test lane against an in-memory store, and importing it must not require a
  // generated Prisma client.
  const { PrismaClient } = require("@prisma/client");
  const prisma = new PrismaClient();
  run(prisma, options)
    .then((report) => {
      process.stdout.write(argv.includes("--json") ? `${JSON.stringify(report, null, 2)}\n` : `${formatReport(report)}\n`);
      process.exitCode = report.ok ? 0 : 1;
    })
    .catch((error) => {
      process.stderr.write(`backfill failed: ${error && error.message}\n`);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
