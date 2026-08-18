"use strict";

/**
 * Phase 6 closure probe — does the aggregation flusher accumulate for the 37 predicates
 * that carry no tier, and for decisions that carry no zone / mission class / purpose?
 *
 * §7.7 makes the binding **tier** part of the aggregation key, but only F34 has one:
 * every other predicate's tuple carries `tier: null`. Three more of the seven key
 * dimensions — `zoneId`, `missionClass`, `legPurpose` — are equally absent whenever the
 * decision did not supply them.
 *
 * This probe drives the **shipped** `rejectionAggregation.worker.js` `flushOnce()`
 * against a real database, three times over the same aggregator content, and checks
 * that one logical bucket becomes one row carrying the summed count. Before the
 * remediation the typed `upsert()` refused a compound-unique lookup containing NULL
 * outright ("Argument `tier` must not be null") and the flush threw, so §7.7's
 * "exact over 100 % of decisions" held for F34 alone.
 *
 *   run: DATABASE_URL=... node tools/verify/phase6NullTierProbe.js
 */

const { PrismaClient } = require("@prisma/client");

const telemetry = require("../../src/engine/feasibility/rejectionTelemetry");
const worker = require("../../src/workers/rejectionAggregation.worker");

const prisma = new PrismaClient();
const SHARD = "p6-nulltier";
const AT_MS = Date.parse("2026-08-17T12:00:00.000Z");

let passed = 0;
let failed = 0;

/**
 * @param {string} label
 * @param {boolean} condition
 * @param {string} [detail]
 */
function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/**
 * Drive the shipped worker `flushes` times over an aggregator holding one rejection of
 * the given shape, and report what landed.
 *
 * @param {string} label
 * @param {string} predicateId
 * @param {object} dimensions
 * @param {object} observed
 * @param {number} flushes
 */
async function scenario(label, predicateId, dimensions, observed, flushes) {
  await prisma.rejectionAggregate.deleteMany({ where: { shardId: SHARD, predicateId } });

  let thrown = null;
  for (let index = 0; index < flushes; index += 1) {
    const aggregator = telemetry.createAggregator();
    aggregator.record(
      telemetry.tupleFrom({
        agentId: `agent-${index}`,
        predicateId,
        result: { outcome: "VIOLATED", observed, margin: -0.01, marginUnit: "prob", reason: "probe" },
        dimensions: { shardId: SHARD, ...dimensions },
      }),
    );
    try {
      await worker.flushOnce({ prisma, aggregator, now: () => AT_MS }, { shardId: SHARD });
    } catch (error) {
      thrown = error;
      break;
    }
  }

  const rows = await prisma.rejectionAggregate.findMany({ where: { shardId: SHARD, predicateId } });
  const total = rows.reduce((sum, entry) => sum + entry.count, BigInt(0));

  console.log(`\n${label}`);
  if (thrown) {
    console.log(`  the flush THREW: ${String(thrown.message).split("\n").slice(-1)[0].trim().slice(0, 90)}`);
  }
  console.log(`  ${flushes} flushes → ${rows.length} row(s), SUM(count) = ${total}`);

  check(`${predicateId}: the flush does not throw`, thrown === null);
  check(`${predicateId}: one logical bucket is one row`, rows.length === 1, `got ${rows.length}`);
  check(`${predicateId}: every decision is counted (${flushes} expected)`, total === BigInt(flushes), `got ${total}`);
}

async function main() {
  console.log("PHASE 6 — the flusher over NULL key dimensions (§7.7)\n");

  await scenario(
    "F34 — every key dimension present (the case the existing test covers)",
    "F34",
    { zoneId: "zone-1", missionClass: "PARCEL", legPurpose: "DELIVER" },
    { bindingTier: "T3" },
    3,
  );

  await scenario(
    "F13 — tier null (the shape 37 of the 38 predicates produce)",
    "F13",
    { zoneId: "zone-1", missionClass: "PARCEL", legPurpose: "DELIVER" },
    {},
    3,
  );

  await scenario(
    "F16 — tier, zone, mission class and purpose all null",
    "F16",
    {},
    {},
    3,
  );

  // Two rejections that differ in a correctness-relevant dimension must still not merge.
  await prisma.rejectionAggregate.deleteMany({ where: { shardId: SHARD, predicateId: "F22" } });
  for (const zoneId of ["zone-a", "zone-b"]) {
    const aggregator = telemetry.createAggregator();
    aggregator.record(
      telemetry.tupleFrom({
        agentId: "a",
        predicateId: "F22",
        result: { outcome: "VIOLATED", observed: {}, margin: -1, marginUnit: "kg", reason: "probe" },
        dimensions: { shardId: SHARD, zoneId, missionClass: null, legPurpose: null },
      }),
    );
    await worker.flushOnce({ prisma, aggregator, now: () => AT_MS }, { shardId: SHARD });
  }
  const split = await prisma.rejectionAggregate.findMany({ where: { shardId: SHARD, predicateId: "F22" } });
  console.log("\nNULLS NOT DISTINCT must not over-merge");
  check("two zones stay two rows even with the other dimensions NULL", split.length === 2, `got ${split.length}`);

  const removed = await prisma.rejectionAggregate.deleteMany({ where: { shardId: SHARD } });
  console.log(`\ncleanup: removed ${removed.count} row(s).`);
  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main()
  .catch((error) => {
    console.error("\nprobe error:", error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
