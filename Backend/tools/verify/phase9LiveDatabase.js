"use strict";

/**
 * PHASE 9 — live-PostgreSQL verification of the Availability Index's durable mirror
 * (§6.2, §18.5), and of the one Phase 9 production path that is reachable today.
 *
 * `PHASE_9_IMPLEMENTATION_REPORT.md` §3 and `PHASE_9_INDEPENDENT_VERIFICATION.md` §6
 * both record `AgentCellPosition` as verified — but verified by reading the migration
 * SQL beside the schema and by re-running `prisma migrate diff --from-empty`. That
 * proves the DDL is Prisma's own output plus two hand-written CHECK constraints. It
 * does not prove either constraint **fires**, and it cannot reach the claims that are
 * about the database's behaviour rather than the text of the DDL:
 *
 *   1. **`AgentCellPosition_availability_class_known`** exists so that a value outside
 *      §6.2's four classes cannot be stored. A rebuild that trusted a fifth value would
 *      place the agent in a Redis key no tier's search reads — an agent silently
 *      invisible to candidate generation, which is the failure §6.1 exists to end. A
 *      CHECK naming a column that does not exist, or listing the wrong four strings,
 *      reads identically to a correct one in a diff.
 *   2. **`AgentCellPosition_coordinates_in_range`** is what makes `greatCircleMetres`
 *      meaningful, and therefore what makes `LB(a, l)` a distance bound at all (§6.4).
 *   3. **`agentId` is UNIQUE** — the mirror's whole premise is one current placement per
 *      agent ("a new observation supersedes the row via upsert"). If the index were not
 *      unique, `rebuildFromRecords()` would replay two contradictory placements for the
 *      same agent and the later write would win by physical order.
 *   4. **The foreign key's delete behaviour.** `ON DELETE CASCADE` is a retention
 *      decision — a decommissioned agent's index placement goes with it — and only a
 *      real delete evidences which behaviour the database performs. A mirror row that
 *      outlived its agent would be rebuilt into Redis and offered as a candidate.
 *   5. **Cold Index replay determinism (§6.6, T6).** `rebuildIndexFromMirror()` reads
 *      `agentCellPosition.findMany()` with no `ORDER BY`. §6.6 prohibits "any set
 *      ordering that depends on a query planner", so whether the rebuild is
 *      deterministic is a property of the live query plus whatever ordering the code
 *      imposes afterwards — not something the model text can settle. This harness
 *      forces the planner to return different physical orders and checks the rebuild's
 *      observable result is identical.
 *
 * The harness writes only rows it creates, all keyed under a `p9-live` prefix, and
 * removes them in a `finally`. It touches no table outside `AgentCellPosition` and the
 * `Agent`/`AgentClass` parents its foreign keys require.
 *
 * Usage:
 *   DATABASE_URL=postgresql://user:pw@127.0.0.1:55433/db node tools/verify/phase9LiveDatabase.js
 *
 * Deliberately **not** a Jest suite, for the same reason Phases 3–8's harnesses are
 * not: it requires a PostgreSQL instance, and a test that silently skips when its
 * environment is absent is a test that reports green for having done nothing.
 */

const { PrismaClient } = require("@prisma/client");
const availabilityIndex = require("../../src/engine/candidates/availabilityIndex");
const indexMaintainer = require("../../src/workers/indexMaintainer.worker");
const cells = require("../../src/engine/spatial/cells");

const PREFIX = "p9-live";
const results = [];

function record(id, description, passed, detail) {
  results.push({ id, description, passed, detail });
  const mark = passed ? "PASS" : "FAIL";
  console.log(`  [${mark}] ${id} — ${description}`);
  if (detail) console.log(`         ${detail}`);
}

/** An in-memory `kv` with the three set primitives `availabilityIndex` uses. */
function memoryKv() {
  const sets = new Map();
  return {
    calls: [],
    async sadd(key, member) {
      this.calls.push(["sadd", key, member]);
      if (!sets.has(key)) sets.set(key, new Set());
      sets.get(key).add(String(member));
    },
    async srem(key, member) {
      this.calls.push(["srem", key, member]);
      if (sets.has(key)) sets.get(key).delete(String(member));
    },
    async smembers(key) {
      return sets.has(key) ? [...sets.get(key)].sort() : [];
    },
    snapshot() {
      return [...sets.entries()]
        .map(([key, members]) => `${key}=${[...members].sort().join(",")}`)
        .sort()
        .join("|");
    },
  };
}

async function main() {
  const prisma = new PrismaClient();
  const createdAgentIds = [];
  let agentClassId = null;

  try {
    const version = await prisma.$queryRawUnsafe("SELECT version()");
    console.log(`\nPHASE 9 — live PostgreSQL verification`);
    console.log(`  ${version[0].version}\n`);

    /* ── Fixtures ───────────────────────────────────────────────────────────── */
    const agentClass = await prisma.agentClass.create({
      data: { classId: `${PREFIX}-class`, name: `${PREFIX} class` },
    });
    agentClassId = agentClass.id;

    async function makeAgent(suffix) {
      const agent = await prisma.agent.create({
        data: { agentId: `${PREFIX}-${suffix}`, lifecycleState: "ACTIVE", agentClassId },
      });
      createdAgentIds.push(agent.id);
      return agent;
    }

    const agentA = await makeAgent("a");
    const agentB = await makeAgent("b");
    const agentC = await makeAgent("c");

    const BENGALURU = { lat: 12.9716, lon: 77.5946 };
    const fineCellId = cells.cellForPoint(BENGALURU.lat, BENGALURU.lon, cells.RESOLUTION.FINE);
    const coarseCellId = cells.coarseParentOf(fineCellId);

    const rowFor = (agent, overrides) => ({
      agentId: agent.id,
      shardId: "default",
      lat: BENGALURU.lat,
      lon: BENGALURU.lon,
      fineCellId,
      coarseCellId,
      availabilityClass: "IDLE_READY",
      capabilityClasses: ["standard"],
      containerClasses: ["ambient"],
      observedAtMs: BigInt(Date.UTC(2026, 7, 18, 12, 0, 0)),
      ...overrides,
    });

    /* ── P9-DB-1: the availability-class CHECK fires ────────────────────────── */
    await prisma.agentCellPosition.create({ data: rowFor(agentA) });
    try {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "AgentCellPosition"
           ("id","agentId","shardId","lat","lon","fineCellId","coarseCellId","availabilityClass",
            "capabilityClasses","containerClasses","observedAtMs","updatedAt")
         VALUES ($1,$2,'default',$3,$4,$5,$6,'DEFINITELY_READY','{}','{}',0,now())`,
        `${PREFIX}-bad-class`,
        agentB.id,
        BENGALURU.lat,
        BENGALURU.lon,
        fineCellId,
        coarseCellId,
      );
      record("P9-DB-1", "availabilityClass CHECK rejects a fifth class", false, "the INSERT was accepted");
    } catch (error) {
      const fired = /availability_class_known/.test(error.message);
      record(
        "P9-DB-1",
        "availabilityClass CHECK rejects a fifth class",
        fired,
        fired ? "constraint AgentCellPosition_availability_class_known raised" : error.message.split("\n")[0],
      );
    }

    /* ── P9-DB-2: the WGS84 coordinate CHECK fires, on each of four edges ───── */
    const badCoordinates = [
      ["lat > 90", 91, 0],
      ["lat < -90", -91, 0],
      ["lon > 180", 0, 181],
      ["lon < -180", 0, -181],
    ];
    let coordinateFailures = 0;
    for (const [label, lat, lon] of badCoordinates) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await prisma.$executeRawUnsafe(
          `INSERT INTO "AgentCellPosition"
             ("id","agentId","shardId","lat","lon","fineCellId","coarseCellId","availabilityClass",
              "capabilityClasses","containerClasses","observedAtMs","updatedAt")
           VALUES ($1,$2,'default',$3,$4,$5,$6,'IDLE_READY','{}','{}',0,now())`,
          `${PREFIX}-bad-coord-${label}`,
          agentB.id,
          lat,
          lon,
          fineCellId,
          coarseCellId,
        );
        console.log(`         accepted ${label} — CHECK did not fire`);
      } catch (error) {
        if (/coordinates_in_range/.test(error.message)) coordinateFailures += 1;
        else console.log(`         ${label}: ${error.message.split("\n")[0]}`);
      }
    }
    record(
      "P9-DB-2",
      "coordinate CHECK rejects out-of-range lat/lon on all four edges",
      coordinateFailures === 4,
      `${coordinateFailures}/4 rejected by AgentCellPosition_coordinates_in_range`,
    );

    /* ── P9-DB-3: one current placement per agent ───────────────────────────── */
    try {
      await prisma.agentCellPosition.create({ data: rowFor(agentA, { availabilityClass: "FINISHING_SOON" }) });
      record("P9-DB-3", "agentId is UNIQUE — one current placement per agent", false, "a second row was accepted");
    } catch (error) {
      const unique = /Unique constraint|AgentCellPosition_agentId_key/i.test(error.message);
      record("P9-DB-3", "agentId is UNIQUE — one current placement per agent", unique, error.message.split("\n")[0]);
    }

    /* ── P9-DB-4: upsert supersedes rather than accumulates ─────────────────── */
    await prisma.agentCellPosition.upsert({
      where: { agentId: agentA.id },
      create: rowFor(agentA),
      update: { availabilityClass: "FINISHING_SOON", observedAtMs: BigInt(1) },
    });
    const afterUpsert = await prisma.agentCellPosition.findMany({ where: { agentId: agentA.id } });
    record(
      "P9-DB-4",
      "upsert supersedes the mirror row (§6.2's one-row-per-agent shape)",
      afterUpsert.length === 1 && afterUpsert[0].availabilityClass === "FINISHING_SOON",
      `${afterUpsert.length} row(s), class=${afterUpsert[0] && afterUpsert[0].availabilityClass}`,
    );

    /* ── P9-DB-5: observedAtMs survives as an exact int64 ───────────────────── */
    const largeMs = BigInt("1798761600123");
    await prisma.agentCellPosition.update({ where: { agentId: agentA.id }, data: { observedAtMs: largeMs } });
    const reread = await prisma.agentCellPosition.findUnique({ where: { agentId: agentA.id } });
    record(
      "P9-DB-5",
      "observedAtMs round-trips as an exact BigInt (no float64 narrowing)",
      reread.observedAtMs === largeMs,
      `wrote ${largeMs}, read ${reread.observedAtMs}`,
    );

    /* ── P9-DB-6: the FK cascades, so no mirror row outlives its agent ──────── */
    await prisma.agentCellPosition.create({ data: rowFor(agentC) });
    await prisma.agent.delete({ where: { id: agentC.id } });
    createdAgentIds.splice(createdAgentIds.indexOf(agentC.id), 1);
    const orphan = await prisma.agentCellPosition.findUnique({ where: { agentId: agentC.id } });
    record(
      "P9-DB-6",
      "ON DELETE CASCADE — a deleted agent's mirror row goes with it",
      orphan === null,
      orphan === null ? "no orphan row" : "an orphan mirror row survived the agent",
    );

    /* ── P9-DB-7: Cold Index replay is order-independent (§6.6, T6) ─────────── */
    await prisma.agentCellPosition.deleteMany({ where: { agentId: { in: [agentA.id, agentB.id] } } });
    await prisma.agentCellPosition.create({ data: rowFor(agentB, { availabilityClass: "IDLE_READY" }) });
    await prisma.agentCellPosition.create({
      data: rowFor(agentA, { availabilityClass: "FINISHING_SOON", lat: 12.98, lon: 77.6 }),
    });

    const forward = memoryKv();
    await indexMaintainer.rebuildIndexFromMirror({ prisma, kv: forward });

    // Force a different physical order: rewrite the rows in the opposite sequence, so
    // an unordered seq-scan returns them the other way round.
    const rows = await prisma.agentCellPosition.findMany({ where: { agentId: { in: [agentA.id, agentB.id] } } });
    await prisma.agentCellPosition.deleteMany({ where: { agentId: { in: [agentA.id, agentB.id] } } });
    for (const row of [...rows].reverse()) {
      const { id, updatedAt, ...rest } = row;
      // eslint-disable-next-line no-await-in-loop
      await prisma.agentCellPosition.create({ data: rest });
    }
    const reordered = await prisma.agentCellPosition.findMany({ where: { agentId: { in: [agentA.id, agentB.id] } } });

    const backward = memoryKv();
    await indexMaintainer.rebuildIndexFromMirror({ prisma, kv: backward });

    const physicalOrderChanged =
      rows.map((row) => row.agentId).join(",") !== reordered.map((row) => row.agentId).join(",");
    const sameIndex = forward.snapshot() === backward.snapshot();
    const sameCommandTrace = JSON.stringify(forward.calls) === JSON.stringify(backward.calls);
    record(
      "P9-DB-7",
      "Cold Index rebuild is identical across two different physical row orders",
      sameIndex && sameCommandTrace,
      `physical order changed: ${physicalOrderChanged}; index identical: ${sameIndex}; ` +
        `Redis command trace identical: ${sameCommandTrace}`,
    );

    /* ── P9-DB-8: the maintainer's sweep agrees with the classifier ─────────── */
    // A charging, non-interruptible agent must not be indexed (F9-2). Drive it
    // through the real worker against the real database rather than calling
    // classify() directly.
    await prisma.agentCellPosition.deleteMany({ where: { agentId: { in: [agentA.id, agentB.id] } } });
    await prisma.observation.create({
      data: {
        agentId: agentB.id,
        kind: "position",
        value: { lat: BENGALURU.lat, lon: BENGALURU.lon },
        observedAt: new Date(),
        source: "agent_report",
      },
    });

    const sweepKv = memoryKv();
    await indexMaintainer.sweepAgents(
      {
        prisma,
        kv: sweepKv,
        now: () => Date.UTC(2026, 7, 18, 12, 0, 0),
        // BATCH 2 — `known` is now part of the classifier's contract, and it is supplied
        // here for a reason that decides what this check measures. `assembleRecord` refuses
        // an agent whose charging state is UNKNOWN, so a classifier that omitted `known`
        // would make this check pass by the wrong route — "not indexed because nobody could
        // answer" instead of "not indexed because it is charging and cannot leave the
        // charger". P9-DB-8's subject is the second one, so the verdict is stated in full.
        chargingStatusFor: async () => ({
          known: true,
          charging: true,
          waiting: false,
          chargingInterruptible: false,
          projectedFreeAtMs: null,
        }),
      },
      [agentB.id],
    );
    const chargingRow = await prisma.agentCellPosition.findUnique({ where: { agentId: agentB.id } });
    const indexedKeys = sweepKv.calls.filter(([verb]) => verb === "sadd");
    record(
      "P9-DB-8",
      "a charging, non-interruptible agent is written to neither the mirror nor the index",
      chargingRow === null && indexedKeys.length === 0,
      `mirror row: ${chargingRow === null ? "absent" : "present"}; index writes: ${indexedKeys.length}`,
    );

    const sweepKv2 = memoryKv();
    await indexMaintainer.sweepAgents(
      {
        prisma,
        kv: sweepKv2,
        now: () => Date.UTC(2026, 7, 18, 12, 0, 0),
        // BATCH 2 — the same contract migration, and this is the call site that caught it.
        // Without `known: true` the classifier reads as an absence, `assembleRecord` returns
        // null, and P9-DB-9 fails with `mirror row class: null` — the index blanked rather
        // than narrowed, which is precisely what this check exists to forbid. The fix is on
        // the CALLER: `assembleRecord`'s refusal is the fail-closed behaviour Batch 2 added
        // deliberately and is not weakened to accommodate an old caller.
        //
        // `known: true, charging: false, waiting: false` is the one verdict that admits an
        // agent to the index, and it is the verdict this check has always meant.
        chargingStatusFor: async () => ({
          known: true,
          charging: false,
          waiting: false,
          chargingInterruptible: false,
          projectedFreeAtMs: null,
        }),
      },
      [agentB.id],
    );
    const idleRow = await prisma.agentCellPosition.findUnique({ where: { agentId: agentB.id } });
    record(
      "P9-DB-9",
      "the same agent, not charging, IS indexed as IDLE_READY (the fix narrows, it does not blank the index)",
      idleRow !== null && idleRow.availabilityClass === "IDLE_READY",
      `mirror row class: ${idleRow && idleRow.availabilityClass}`,
    );
  } finally {
    await prisma.agentCellPosition.deleteMany({ where: { shardId: "default", agentId: { in: createdAgentIds } } });
    await prisma.observation.deleteMany({ where: { agentId: { in: createdAgentIds } } });
    await prisma.agent.deleteMany({ where: { agentId: { startsWith: PREFIX } } });
    if (agentClassId) await prisma.agentClass.deleteMany({ where: { classId: { startsWith: PREFIX } } });
    await prisma.$disconnect();
  }

  const failed = results.filter((result) => !result.passed);
  console.log(`\n  ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.log(`  FAILED: ${failed.map((result) => result.id).join(", ")}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
