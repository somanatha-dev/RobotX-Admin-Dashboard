"use strict";

/**
 * PHASE 6 — live-PostgreSQL verification of the rejection-telemetry tables (§7.7).
 *
 * Phase 6's independent verification recorded, in its Part 4, that no migration in this
 * programme had been executed against a real PostgreSQL instance, and confirmed the
 * migration SQL only by regenerating it with `prisma migrate diff` and diffing. That
 * proves the SQL is Prisma's own output plus five hand-written CHECK constraints. It
 * does not prove any of them *fires*, and it cannot touch the claims that are about
 * concurrency rather than about DDL:
 *
 *   1. **Five hand-written CHECK constraints**, absent from Prisma's generated SQL by
 *      design. A CHECK with a typo in a column name is a constraint that never fires,
 *      and the regex one has to partition F1–F38 exactly — no F0, no F39.
 *   2. **The compound unique keys.** §7.7 aggregates by
 *      `(shard, zone, missionClass, legPurpose, predicateId, tier, bucket)`. If two
 *      rejections that differ in a correctness-relevant dimension collide on that key,
 *      the binding-constraint distribution silently merges two different populations.
 *      A `NULL` in any dimension is where that goes wrong, because `NULL` is not equal
 *      to `NULL` in a UNIQUE index.
 *   3. **Aggregation idempotency under a crashed flusher.** §7.7 requires the SLIs be
 *      exact over 100 % of decisions. `rejectionAggregation.worker.js` flushes with an
 *      upsert that *adds*, so a retry after a partial flush double-counts unless the
 *      drain-then-write ordering holds. Only a real transaction, really aborted, can
 *      evidence what happens.
 *   4. **`count` is `BIGINT`** and is incremented as a `BigInt` through the driver. A
 *      count that round-trips as a Number is silently wrong above 2^53 and right
 *      everywhere a hand-written test would look.
 *
 * This harness drives the **shipped** `rejectionTelemetry.js` and the shipped worker's
 * own flush shape against a real instance carrying the real migration chain. It writes
 * only rows it creates, under a shard id prefixed `p6-`, and deletes them at the end.
 *
 * Usage:
 *   DATABASE_URL=postgresql://user:pw@127.0.0.1:55432/db node tools/verify/phase6LiveDatabase.js
 *
 * Deliberately **not** a Jest suite, for the same reason Phases 3–5's harnesses are
 * not: it requires a PostgreSQL instance, and a test that silently skips when its
 * environment is absent is a test that reports green for having done nothing.
 */

const { PrismaClient } = require("@prisma/client");

const telemetry = require("../../src/engine/feasibility/rejectionTelemetry");
const register = require("../../src/engine/feasibility/register");

const prisma = new PrismaClient();
const SHARD = "p6-live";
const BUCKET_START = new Date("2026-08-17T10:00:00.000Z");
const BUCKET_END = new Date("2026-08-17T10:01:00.000Z");

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
 * Run a statement expected to be refused by a constraint.
 *
 * @param {string} label
 * @param {() => Promise<unknown>} run
 * @param {RegExp} expected
 */
async function expectRefused(label, run, expected) {
  try {
    await run();
    check(label, false, "the database accepted it");
  } catch (error) {
    check(label, expected.test(String(error.message)), `refused, but for the wrong reason: ${String(error.message).slice(0, 120)}`);
  }
}

/**
 * @param {object} overrides
 * @returns {object} a `RejectionAggregate` row
 */
function row(overrides) {
  return {
    id: `p6-${Math.random().toString(36).slice(2, 12)}`,
    shardId: SHARD,
    zoneId: "zone-1",
    missionClass: "PARCEL",
    legPurpose: "DELIVER",
    predicateId: "F34",
    tier: "T3",
    bucketStart: BUCKET_START,
    bucketEnd: BUCKET_END,
    count: BigInt(1),
    updatedAt: new Date(),
    ...overrides,
  };
}

async function main() {
  console.log(`\nPHASE 6 — live PostgreSQL verification`);
  console.log(`  ${(await prisma.$queryRaw`select version()`)[0].version}\n`);

  // Start from a clean slate: a previous interrupted run must not make this one fail
  // for a reason that has nothing to do with what it is checking.
  await prisma.rejectionAggregate.deleteMany({ where: { shardId: SHARD } });
  await prisma.nearMissSketch.deleteMany({ where: { shardId: SHARD } });

  /* ── 1. The CHECK constraints actually fire ─────────────────────────────── */
  console.log("§7.7 — the five hand-written CHECK constraints");

  await expectRefused(
    "predicateId 'F0' is refused (below the register's range)",
    () => prisma.rejectionAggregate.create({ data: row({ predicateId: "F0" }) }),
    /predicateId_is_registered/,
  );
  await expectRefused(
    "predicateId 'F39' is refused (above §7.5's 38)",
    () => prisma.rejectionAggregate.create({ data: row({ predicateId: "F39" }) }),
    /predicateId_is_registered/,
  );
  await expectRefused(
    "a zero-width bucket is refused (bucketEnd > bucketStart)",
    () => prisma.rejectionAggregate.create({ data: row({ bucketEnd: BUCKET_START }) }),
    /bucket_window_is_ordered/,
  );
  await expectRefused(
    "an unenumerated marginUnit is refused",
    () =>
      prisma.nearMissSketch.create({
        data: {
          id: `p6-${Math.random().toString(36).slice(2, 12)}`,
          shardId: SHARD,
          predicateId: "F34",
          marginUnit: "furlongs",
          bucketStart: BUCKET_START,
          bucketEnd: BUCKET_END,
          buckets: {},
          total: BigInt(0),
          updatedAt: new Date(),
        },
      }),
    /marginUnit_is_enumerated/,
  );

  // Every predicate the register holds must satisfy the regex — the compression from an
  // enumeration to a regex is only safe if it partitions 1–38 exactly.
  let allAccepted = true;
  for (const entry of register.PREDICATES) {
    try {
      const created = await prisma.rejectionAggregate.create({
        data: row({ predicateId: entry.id, tier: null, zoneId: `z-${entry.id}` }),
      });
      await prisma.rejectionAggregate.delete({ where: { id: created.id } });
    } catch (error) {
      allAccepted = false;
      console.log(`        ${entry.id} was refused: ${String(error.message).slice(0, 80)}`);
    }
  }
  check("all 38 registered predicate ids are accepted by the regex", allAccepted);

  // And every marginUnit the runtime can emit.
  const { MARGIN_UNIT } = require("../../src/engine/feasibility/threeValued");
  let allUnits = true;
  for (const unit of Object.values(MARGIN_UNIT)) {
    try {
      const created = await prisma.nearMissSketch.create({
        data: {
          id: `p6-${Math.random().toString(36).slice(2, 12)}`,
          shardId: SHARD,
          predicateId: "F34",
          marginUnit: unit,
          bucketStart: BUCKET_START,
          bucketEnd: BUCKET_END,
          buckets: {},
          total: BigInt(0),
          updatedAt: new Date(),
        },
      });
      await prisma.nearMissSketch.delete({ where: { id: created.id } });
    } catch (error) {
      allUnits = false;
      console.log(`        ${unit} was refused: ${String(error.message).slice(0, 80)}`);
    }
  }
  check("all nine runtime MARGIN_UNIT values are accepted by the CHECK", allUnits);

  /* ── 2. The compound unique key, including its NULL dimensions ──────────── */
  console.log("\n§7.7 — the aggregation key cannot merge two different populations");

  const base = await prisma.rejectionAggregate.create({ data: row({}) });

  await expectRefused(
    "an identical key is refused a second insert",
    () => prisma.rejectionAggregate.create({ data: row({}) }),
    /Unique constraint|duplicate key/i,
  );

  // Each dimension, varied alone, must produce a distinct row.
  const dimensions = [
    ["zoneId", "zone-2"],
    ["missionClass", "GROCERY"],
    ["legPurpose", "COLLECT"],
    ["predicateId", "F22"],
    ["tier", "T1"],
  ];
  let distinct = true;
  const created = [base.id];
  for (const [field, value] of dimensions) {
    try {
      const made = await prisma.rejectionAggregate.create({ data: row({ [field]: value }) });
      created.push(made.id);
    } catch (error) {
      distinct = false;
      console.log(`        varying ${field} collided: ${String(error.message).slice(0, 80)}`);
    }
  }
  check("varying any one aggregation dimension yields a distinct row", distinct);

  // The NULL hazard this phase's remediation closed. PostgreSQL's UNIQUE *default* is
  // NULLS DISTINCT, under which two rows that both say "no tier" do not collide — and
  // §7.7's F34 rows are the only ones that carry a tier at all. The
  // `20260817120000_rejection_aggregate_nulls_not_distinct` migration redeclares the key
  // NULLS NOT DISTINCT, because in this table an absent dimension is a determinate fact
  // about the rejection, not missing information.
  const nullA = await prisma.rejectionAggregate.create({ data: row({ predicateId: "F13", tier: null, zoneId: "zone-null" }) });
  created.push(nullA.id);
  await expectRefused(
    "two rows with tier NULL now collide on the unique key (NULLS NOT DISTINCT)",
    () => prisma.rejectionAggregate.create({ data: row({ predicateId: "F13", tier: null, zoneId: "zone-null" }) }),
    /Unique constraint|duplicate key/i,
  );

  /* ── 3. BIGINT round-trip above 2^53 ────────────────────────────────────── */
  console.log("\n§7.7 — count is BIGINT and survives the driver above 2^53");

  const huge = BigInt(Number.MAX_SAFE_INTEGER) + BigInt(7);
  const bigRow = await prisma.rejectionAggregate.create({
    data: row({ zoneId: "zone-bigint", count: huge }),
  });
  const readBack = await prisma.rejectionAggregate.findUnique({ where: { id: bigRow.id } });
  check(
    `count round-trips as a BigInt, exactly, at ${huge} (> 2^53)`,
    readBack.count === huge && typeof readBack.count === "bigint",
    `read back ${readBack.count} as ${typeof readBack.count}`,
  );
  created.push(bigRow.id);

  /* ── 4. The flusher's upsert adds, and a rolled-back flush loses nothing ── */
  console.log("\n§7.7 — aggregation is exact over 100 % of decisions, and safe under a crashed flusher");

  const key = {
    shardId_zoneId_missionClass_legPurpose_predicateId_tier_bucketStart: {
      shardId: SHARD,
      zoneId: "zone-flush",
      missionClass: "PARCEL",
      legPurpose: "DELIVER",
      predicateId: "F34",
      tier: "T3",
      bucketStart: BUCKET_START,
    },
  };

  /** The worker's own flush shape, applied `n` times. */
  const flush = (n) =>
    prisma.rejectionAggregate.upsert({
      where: key,
      create: { ...row({ zoneId: "zone-flush", count: BigInt(n) }) },
      update: { count: { increment: BigInt(n) }, bucketEnd: BUCKET_END },
    });

  await flush(10);
  await flush(10);
  const afterTwo = await prisma.rejectionAggregate.findUnique({ where: key });
  check("two flushes of 10 accumulate to 20 (the upsert adds, it does not replace)", afterTwo.count === BigInt(20));
  created.push(afterTwo.id);

  // A flush that crashes between its write and its checkpoint must leave nothing behind,
  // so the retry cannot double-count. That is what the transaction is for.
  try {
    await prisma.$transaction(async (tx) => {
      await tx.rejectionAggregate.update({ where: key, data: { count: { increment: BigInt(500) } } });
      throw new Error("simulated flusher crash between write and checkpoint");
    });
  } catch {
    /* expected */
  }
  const afterCrash = await prisma.rejectionAggregate.findUnique({ where: key });
  check("a flush that crashes before its checkpoint rolls back entirely", afterCrash.count === BigInt(20), `count is ${afterCrash.count}`);

  await flush(10);
  const afterRetry = await prisma.rejectionAggregate.findUnique({ where: key });
  check("the retry after the crash counts once, not twice", afterRetry.count === BigInt(30), `count is ${afterRetry.count}`);

  /* ── 5. Concurrent flushers do not lose an increment ────────────────────── */
  console.log("\n§7.7 — concurrent flushers");

  const concurrentKey = { ...key };
  concurrentKey.shardId_zoneId_missionClass_legPurpose_predicateId_tier_bucketStart = {
    ...key.shardId_zoneId_missionClass_legPurpose_predicateId_tier_bucketStart,
    zoneId: "zone-concurrent",
  };
  const seed = await prisma.rejectionAggregate.create({ data: row({ zoneId: "zone-concurrent", count: BigInt(0) }) });
  created.push(seed.id);

  const CONCURRENCY = 25;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, () =>
      prisma.rejectionAggregate.update({ where: concurrentKey, data: { count: { increment: BigInt(1) } } }),
    ),
  );
  const afterConcurrent = await prisma.rejectionAggregate.findUnique({ where: concurrentKey });
  check(
    `${CONCURRENCY} concurrent increments all land (no lost update)`,
    afterConcurrent.count === BigInt(CONCURRENCY),
    `count is ${afterConcurrent.count}`,
  );

  /* ── 6. The in-memory aggregator represents every decision ──────────────── */
  console.log("\n§7.7 — the aggregator folds 100 % of decisions before anything is sampled");

  const aggregator = telemetry.createAggregator();
  const DECISIONS = 100;
  for (let index = 0; index < DECISIONS; index += 1) {
    aggregator.record(
      telemetry.tupleFrom({
        agentId: `agent-${index}`,
        predicateId: index % 2 === 0 ? "F34" : "F13",
        result: { outcome: "VIOLATED", observed: { bindingTier: "T3" }, margin: -0.01, marginUnit: "prob", reason: "r" },
        dimensions: { shardId: SHARD, zoneId: "zone-1", missionClass: "PARCEL", legPurpose: "DELIVER" },
      }),
    );
    aggregator.recordCandidate({ admitted: false, deniedForIndeterminacyOnly: false });
  }
  const drained = aggregator.drain();
  const total = drained.distribution.reduce((sum, entry) => sum + entry.count, 0);
  check(`all ${DECISIONS} rejections are represented in the drain (got ${total})`, total === DECISIONS);
  check(
    "a second drain returns nothing — the maps were cleared in the same synchronous call",
    aggregator.drain().distribution.length === 0,
  );

  // And the shipped flusher writes every one of them, through the NULL-tolerant path.
  const flushed = await require("../../src/workers/rejectionAggregation.worker").flushOnce(
    { prisma, aggregator: (() => {
      const second = telemetry.createAggregator();
      for (let index = 0; index < DECISIONS; index += 1) {
        second.record(
          telemetry.tupleFrom({
            agentId: `agent-${index}`,
            predicateId: index % 2 === 0 ? "F34" : "F13",
            result: { outcome: "VIOLATED", observed: index % 2 === 0 ? { bindingTier: "T3" } : {}, margin: -0.01, marginUnit: "prob", reason: "r" },
            dimensions: { shardId: SHARD, zoneId: "zone-flushed", missionClass: "PARCEL", legPurpose: "DELIVER" },
          }),
        );
      }
      return second;
    })(), now: () => BUCKET_START.getTime() },
    { shardId: SHARD },
  );
  const written = await prisma.rejectionAggregate.findMany({ where: { shardId: SHARD, zoneId: "zone-flushed" } });
  const writtenTotal = written.reduce((sum, entry) => sum + entry.count, BigInt(0));
  check(
    `the flusher writes all ${DECISIONS} decisions across both a tiered and an untiered predicate`,
    flushed.aggregatesWritten === 2 && writtenTotal === BigInt(DECISIONS),
    `wrote ${flushed.aggregatesWritten} row(s) totalling ${writtenTotal}`,
  );

  /* ── cleanup ────────────────────────────────────────────────────────────── */
  const removedAggregates = await prisma.rejectionAggregate.deleteMany({ where: { shardId: SHARD } });
  const removedSketches = await prisma.nearMissSketch.deleteMany({ where: { shardId: SHARD } });
  console.log(`\ncleanup: removed ${removedAggregates.count} aggregate row(s), ${removedSketches.count} sketch row(s)`);

  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main()
  .catch((error) => {
    console.error("\nharness error:", error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
