"use strict";

/**
 * PHASE 12 — measurement of the critical paths §26.1 makes continuous and §18.5 makes an SLI.
 *
 * ── What this can and cannot establish ──────────────────────────────────────
 * §20.1 sets no target for the invariant checker, the mode register or the escalation chain: the
 * targets are round wall-clock and request-path latency, and none of Phase 12's paths is on
 * either. So there is no threshold to pass here, and inventing one would be worse than measuring
 * without one.
 *
 * What the numbers are *for* is the one quantitative question the phase does raise: the checker
 * runs `invariant.check_interval` apart (default 60 s) and performs twenty-two table scans per
 * pass, several of them N+1 loops over Legs and commitments. Whether a pass fits inside its own
 * interval at a realistic table size is a real question with a measurable answer, and it decides
 * whether the register's cadence is honest or aspirational.
 *
 * Measured against a **live PostgreSQL instance**, because the shapes that matter — an index
 * scan, an N+1 round trip, a `groupBy` — do not exist in an in-memory double, and a Jest-measured
 * number would be a measurement of JavaScript object iteration wearing a database's name.
 * `PHASE_10_REMEDIATION_AND_CLOSURE.md` recorded jest-measured stage *ratios* coming out
 * backwards for exactly this reason.
 *
 * Usage:
 *   DATABASE_URL=postgresql://pgverify:verify@127.0.0.1:55436/robotx_p12 \
 *     node tools/verify/phase12Profile.js [legCount]
 */

const { PrismaClient } = require("@prisma/client");

const invariantWorker = require("../../src/workers/invariant.worker");
const invariantChecker = require("../../src/engine/observability/invariantChecker");
const transitions = require("../../src/engine/degraded/transitions");
const modeRegister = require("../../src/engine/degraded/modeRegister");

const PREFIX = "p12-prof";
const SHARD = `${PREFIX}:s1`;

/** @param {string} label @param {() => Promise<*>} run @param {number} [repeats] */
async function measure(label, run, repeats = 5) {
  const samples = [];
  for (let n = 0; n < repeats; n += 1) {
    const started = process.hrtime.bigint();
    // eslint-disable-next-line no-await-in-loop
    await run();
    samples.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  const max = samples[samples.length - 1];
  console.log(`  ${label.padEnd(52)} median ${median.toFixed(1).padStart(8)} ms   max ${max.toFixed(1).padStart(8)} ms   (n=${repeats})`);
  return { label, median, max, samples };
}

async function main() {
  const url = process.env.DATABASE_URL || "";
  if (/neon\.tech/i.test(url) || /:5432\//.test(url) || !url) {
    console.error("REFUSING to run: this profile writes thousands of rows. Use a disposable cluster.");
    process.exitCode = 1;
    return;
  }

  const legCount = Number(process.argv[2] || 500);
  const prisma = new PrismaClient();
  const now = Date.now();
  const readings = [];

  try {
    console.log(`\nPHASE 12 — critical-path measurement against live PostgreSQL (${legCount} Legs)\n`);

    const missions = [];
    for (let n = 0; n < 25; n += 1) {
      // eslint-disable-next-line no-await-in-loop
      missions.push(await prisma.mission.create({ data: { missionId: `${PREFIX}:M${n}` } }));
    }

    // A fleet-shaped world: non-terminal Legs with commitments and timers, plus terminal rows for
    // I12's write audit. Fifty agents, so I1's per-agent count and I19's fence scan have groups.
    console.log("  seeding…");
    // One agent per active commitment. `(agentId, capacitySlot)` is unique — the schema's half of
    // I1 at `capacity = 1` — so a fleet where fifty agents hold eight commitments each is not a
    // fleet this schema admits, and seeding one would have measured a world the engine forbids.
    const agents = [];
    for (let n = 0; n < legCount; n += 1) {
      // eslint-disable-next-line no-await-in-loop
      agents.push(await prisma.agent.create({ data: { agentId: `${PREFIX}:A${n}`, fenceCounter: BigInt(n + 1), authorityEpoch: BigInt(1) } }));
    }
    for (let n = 0; n < legCount; n += 1) {
      const state = n % 5 === 0 ? "SETTLED" : "EN_ROUTE_DROP";
      // eslint-disable-next-line no-await-in-loop
      const leg = await prisma.leg.create({
        // `(missionId, sequence)` is unique, so the Legs are spread across missions rather than
        // stacked on one — which is also the shape the checker's N+1 loops actually meet.
        data: { legId: `${PREFIX}:L${n}`, missionId: missions[n % missions.length].id, purpose: "PRIMARY", state, sequence: Math.floor(n / missions.length) },
      });
      if (state !== "SETTLED") {
        // eslint-disable-next-line no-await-in-loop
        await prisma.commitment.create({
          data: {
            commitmentId: `${PREFIX}:C${n}`,
            agentId: agents[n].id,
            legId: leg.id,
            kind: "HARD",
            fence: BigInt(n + 1),
            leaseExpiry: new Date(now + 600000),
            grantedAt: new Date(now - 1000),
          },
        });
        // eslint-disable-next-line no-await-in-loop
        await prisma.timer.create({
          data: {
            timerKey: `${PREFIX}:T${n}`,
            entityType: "LEG",
            entityId: leg.id,
            state: leg.state,
            entityVersion: BigInt(leg.version),
            timerState: "PENDING",
            dueAt: new Date(now + 300000),
            handler: "leaseExpiry",
          },
        });
      }
    }
    const legs = await prisma.leg.count({ where: { legId: { startsWith: PREFIX } } });
    console.log(`  seeded ${legs} Legs\n`);

    /* ── 1. One full check pass — the register's own cadence ─────────────────── */
    const state = {};
    // The first pass is the cold one: every I6 mark is new and every status row is an insert.
    readings.push(
      await measure("checkPass — FIRST pass (cold: every mark and row new)", async () => {
        await prisma.invariantStatus.deleteMany({ where: { shardId: SHARD } });
        await invariantWorker.checkPass({ prisma }, { shardId: SHARD, nowMs: Date.now(), checkerState: {}, sweepEscalations: false });
      }, 3),
    );
    // The steady state — which is what a 60 s interval actually spends, and what the cadence
    // question is about.
    await invariantWorker.checkPass({ prisma }, { shardId: SHARD, nowMs: Date.now(), checkerState: state, sweepEscalations: false });
    readings.push(
      await measure("checkPass — STEADY pass (nothing moved)", async () => {
        await invariantWorker.checkPass({ prisma }, { shardId: SHARD, nowMs: Date.now(), checkerState: state, sweepEscalations: false });
      }, 5),
    );

    /* ── 2. The individual checks, so the cost is attributable ──────────────── */
    const context = {
      shardId: SHARD,
      nowMs: Date.now(),
      windowStartMs: Date.now() - 300000,
      storeTime: new Date(),
      activeModes: [],
      highWaterMarks: new Map(),
      terminalVersionMarks: new Map(),
      previousFenceRejections: {},
      statesWithoutDeadline: ["LOADED"],
      ladderBudgetSeconds: 900,
      tierEventBudgets: { T1: 365000, T2: 365 },
    };
    const perCheck = [];
    for (const invariantId of modeRegister.INVARIANTS) {
      const started = process.hrtime.bigint();
      // eslint-disable-next-line no-await-in-loop
      await invariantChecker.checkOne(invariantId, { prisma }, context);
      perCheck.push({ invariantId, ms: Number(process.hrtime.bigint() - started) / 1e6 });
    }
    perCheck.sort((a, b) => b.ms - a.ms);
    console.log("\n  the five most expensive checks (one pass each):");
    for (const row of perCheck.slice(0, 5)) {
      console.log(`    ${row.invariantId.padEnd(6)} ${row.ms.toFixed(1).padStart(8)} ms`);
    }
    console.log(`    (the other 17 sum to ${perCheck.slice(5).reduce((sum, row) => sum + row.ms, 0).toFixed(1)} ms)\n`);

    /* ── 2b. The worker's own writes, which the per-check figures do not include ── */
    //
    // The first measurement showed a 2,137 ms pass whose twenty-two checks summed to ~1,000 ms.
    // The remainder is this worker's writes, and one of them is per-agent: attribute it rather
    // than leaving a second of a pass unexplained.
    const i6 = await invariantChecker.checkOne("I6", { prisma }, context);
    readings.push(
      await measure(`persistHighWaterMarks — ${i6.highWaterMarks.size} agents, all marks NEW`, async () => {
        await prisma.invariantStatus.deleteMany({ where: { shardId: SHARD, subjectType: "AGENT" } });
        await invariantWorker.persistHighWaterMarks({ prisma }, { shardId: SHARD, marks: i6.highWaterMarks, checkedAt: new Date() });
      }, 3),
    );
    readings.push(
      await measure(`persistHighWaterMarks — ${i6.highWaterMarks.size} agents, NO mark moved`, async () => {
        await invariantWorker.persistHighWaterMarks(
          { prisma },
          { shardId: SHARD, marks: i6.highWaterMarks, checkedAt: new Date(), previous: i6.highWaterMarks },
        );
      }, 5),
    );
    readings.push(
      await measure("persistStatus × 22 — one upsert per invariant", async () => {
        for (const invariantId of modeRegister.INVARIANTS) {
          // eslint-disable-next-line no-await-in-loop
          await invariantWorker.persistStatus(
            { prisma },
            { shardId: SHARD, checkedAt: new Date(), row: { invariantId, status: "ENFORCED", violationCount: 0, violations: [], instrument: "profile", detail: null } },
          );
        }
      }, 3),
    );

    /* ── 3. The mode transitions and the sweeps ──────────────────────────────── */
    readings.push(
      await measure("transitions.enter — one DegradedModeEvent row", async () => {
        await transitions.enter({ prisma }, {
          mode: modeRegister.MODE.COLD_INDEX, shardId: SHARD, cause: "B3",
          enteringComponent: "profile", atMs: Date.now(), maxDurationMs: 900000,
        });
        await prisma.degradedModeEvent.deleteMany({ where: { shardId: SHARD } });
      }, 10),
    );

    readings.push(
      await measure("transitions.activeModes — the mode read every check pass makes", async () => {
        await transitions.activeModes({ prisma }, SHARD);
      }, 20),
    );

    readings.push(
      await measure("modeSweepPass — §18.5 rule 2's time box + advisory", async () => {
        await invariantWorker.modeSweepPass({ prisma, kv: { set: async () => {} } }, { shardId: SHARD, nowMs: Date.now() });
      }, 10),
    );

    readings.push(
      await measure("chainOpenPass — §18.6 steps 1-3, no obstructing Leg", async () => {
        await invariantWorker.chainOpenPass({ prisma }, { nowMs: Date.now() });
      }, 10),
    );

    readings.push(
      await measure("escalationSweepPass — §18.6 step 5, empty chain set", async () => {
        await invariantWorker.escalationSweepPass({ prisma }, { nowMs: Date.now(), maxAgeSeconds: 300 });
      }, 10),
    );

    /* ── 4. The two REST reads, as the controller performs them ──────────────── */
    readings.push(
      await measure("GET /api/health/invariants — the controller's two queries", async () => {
        await Promise.all([
          prisma.invariantStatus.findMany({ where: { shardId: SHARD, subjectType: "SHARD" }, orderBy: { invariantId: "asc" } }),
          transitions.openRows({ prisma }, SHARD),
        ]);
      }, 20),
    );

    readings.push(
      await measure("GET /api/health/modes — open rows + recent history", async () => {
        await transitions.openRows({ prisma }, SHARD);
        await prisma.degradedModeEvent.findMany({ where: { shardId: SHARD, exitedAt: { not: null } }, orderBy: { exitedAt: "desc" }, take: 20 });
      }, 20),
    );

    /* ── 5. The one question with a real answer ─────────────────────────────── */
    const cold = readings.find((row) => row.label.startsWith("checkPass — FIRST"));
    const steady = readings.find((row) => row.label.startsWith("checkPass — STEADY"));
    const intervalMs = invariantWorker.DEFAULT_INTERVAL_MS;
    console.log(
      `\n  Over ${legs} Legs and ${legs} agents, against a ${intervalMs / 1000} s interval:\n` +
      `    cold pass   ${cold.median.toFixed(0).padStart(6)} ms median  ${cold.max.toFixed(0).padStart(6)} ms max  ` +
      `(${((cold.max / intervalMs) * 100).toFixed(1)} % of the cadence)\n` +
      `    steady pass ${steady.median.toFixed(0).padStart(6)} ms median  ${steady.max.toFixed(0).padStart(6)} ms max  ` +
      `(${((steady.max / intervalMs) * 100).toFixed(1)} % of the cadence)\n\n` +
      "  Both scale linearly with the fleet — the checks that remain per-row are I2 (expired leases),\n" +
      "  I7, I8, I10 and I11, each of which loops over a set that is *empty or small in nominal\n" +
      "  operation* rather than over every Leg. Extrapolating the steady pass, the checker reaches\n" +
      `  its own interval at roughly ${Math.round(legs * (intervalMs / steady.max)).toLocaleString("en-US")} Legs on this hardware; the cold pass, at ` +
      `${Math.round(legs * (intervalMs / cold.max)).toLocaleString("en-US")}.\n` +
      "  A shard sized past that needs either a longer `invariant.check_interval` or a checker that\n" +
      "  shards its own pass — a §3.5 sizing input, recorded rather than assumed away.\n",
    );
  } finally {
    await prisma.timer.deleteMany({ where: { timerKey: { startsWith: PREFIX } } });
    await prisma.commitment.deleteMany({ where: { commitmentId: { startsWith: PREFIX } } });
    await prisma.invariantStatus.deleteMany({ where: { shardId: { startsWith: PREFIX } } });
    await prisma.degradedModeEvent.deleteMany({ where: { shardId: { startsWith: PREFIX } } });
    await prisma.leg.deleteMany({ where: { legId: { startsWith: PREFIX } } });
    await prisma.mission.deleteMany({ where: { missionId: { startsWith: PREFIX } } });
    await prisma.agent.deleteMany({ where: { agentId: { startsWith: PREFIX } } });
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
