"use strict";

/**
 * P7-D5 D1 — live-PostgreSQL verification that Tier B retention leaves Tier A and Tier B
 * consistent under the real `decision_record_is_immutable()` trigger.
 *
 * `tests/engine/p7d5TierBRetention.test.js` emulates the trigger from the migration's own
 * allowlist. An emulation that was taught the rule is not evidence that PostgreSQL enforces
 * it, nor that one Prisma `deleteMany` is one atomic statement — only a real server settles
 * either. This harness:
 *
 *   L1  shows the real trigger refuses un-setting `tierBWritten` (the precondition);
 *   L2  reproduces the pre-fix two-statement sequence: Tier B deleted, then the Tier A
 *       update refused — the orphaned claim the old `expireTierB` left behind;
 *   L3  runs the shipped `expireTierB`: no error, only due rows removed, Tier A byte-identical;
 *   L4  a repeated pass removes nothing and changes nothing;
 *   L5  the batch bound (`take`) is honoured by the real query;
 *   L6  a row expiring exactly at `now` is not yet due;
 *   L7  a DELETE that fails on ONE row (a temporary trigger in this disposable database)
 *       removes NO row — the batch is all or nothing — and Tier A is unchanged;
 *   L8  `InputSnapshot` is untouched, so the expired record stays reconstructible;
 *   L9  read the way the Explanation API reads it: written, not retained.
 *
 * It writes only rows under the `p7d5-d1` prefix and removes them in a `finally`.
 *
 * Usage (a DISPOSABLE cluster only — see the guard below):
 *   P7D5_LIVE_DATABASE_URL=postgresql://pgverify@127.0.0.1:55437/robotx_p7d5d1 \
 *     node tools/verify/p7d5TierBRetentionLive.js
 *
 * Deliberately not a Jest suite, for the reason every `tools/verify/*Live*` harness gives:
 * a test that silently skips without a database reports green for having done nothing.
 */

const { PrismaClient } = require("@prisma/client");

const worker = require("../../src/workers/tierB.worker");

const PREFIX = "p7d5-d1";
const results = [];

function record(id, description, passed, detail) {
  results.push({ id, description, passed });
  console.log(`  [${passed ? "PASS" : "FAIL"}] ${id} — ${description}`);
  if (detail) console.log(`         ${detail}`);
}

/**
 * Refuse anything that is not a loopback cluster on a non-default port. LOCAL's database is
 * Docker on 5433 and a stock cluster listens on 5432; Neon is never loopback.
 *
 * @param {string} url
 * @returns {string|null} why it is refused, or null
 */
function refusalFor(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return "P7D5_LIVE_DATABASE_URL is not a URL";
  }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) return `host ${parsed.hostname} is not loopback`;
  if (["", "5432", "5433"].includes(parsed.port)) return `port ${parsed.port || "(default)"} is a shared or LOCAL cluster`;
  return null;
}

const tierA = async (prisma) =>
  prisma.decisionRecordA.findMany({ where: { decisionId: { startsWith: PREFIX } }, orderBy: { decisionId: "asc" } });
const tierBIds = async (prisma) =>
  (await prisma.decisionRecordB.findMany({ where: { decisionId: { startsWith: PREFIX } }, select: { decisionId: true } }))
    .map((row) => row.decisionId)
    .sort();
const same = (a, b) => JSON.stringify(a, (key, value) => (typeof value === "bigint" ? String(value) : value)) ===
  JSON.stringify(b, (key, value) => (typeof value === "bigint" ? String(value) : value));

async function main() {
  const url = process.env.P7D5_LIVE_DATABASE_URL || "";
  const refusal = refusalFor(url);
  if (refusal) {
    console.error(`REFUSING to run: ${refusal}. Use a disposable cluster.`);
    process.exitCode = 1;
    return;
  }

  const prisma = new PrismaClient({ datasources: { db: { url } } });
  const decisionTime = new Date("2026-10-11T00:00:00.000Z");
  const NOW = decisionTime.getTime() + 31 * 86_400_000;
  const PAST = new Date(NOW - 1);
  const FUTURE = new Date(NOW + 86_400_000);

  /**
   * Remove fixture rows with triggers bypassed. Tier A refuses DELETE by trigger
   * (`decision_record_is_immutable`), so the fixture's own rows are removed under
   * `SET LOCAL session_replication_role = replica` — scoped to one transaction on one
   * connection, on a disposable database. Tier B first: replica mode also skips FK cascades.
   *
   * @param {string[]} statements
   */
  const bypassingTriggers = async (statements) =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
      for (const statement of statements) await tx.$executeRawUnsafe(statement);
    });

  const cleanup = async () => {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "p7d5_d1_refuse_one_delete" ON "DecisionRecordB"`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "p7d5_d1_refuse_one_delete"()`);
    await bypassingTriggers([
      `DELETE FROM "DecisionRecordB" WHERE "decisionId" LIKE '${PREFIX}%'`,
      `DELETE FROM "DecisionRecordA" WHERE "decisionId" LIKE '${PREFIX}%'`,
      `DELETE FROM "InputSnapshot" WHERE "snapshotId" LIKE '${PREFIX}%'`,
    ]);
  };

  const snapshot = async () =>
    prisma.inputSnapshot.create({
      data: { snapshotId: `${PREFIX}:snap`, roundId: `${PREFIX}:r1`, shardId: `${PREFIX}:s1`, decisionTime, hash: "h", pins: {} },
    });

  const pair = async (snapshotId, suffix, options) => {
    const decisionId = `${PREFIX}:${suffix}`;
    const written = !(options && options.written === false);
    await prisma.decisionRecordA.create({
      data: {
        decisionId,
        roundId: `${PREFIX}:r1`,
        shardId: `${PREFIX}:s1`,
        decisionTime,
        legId: `${PREFIX}:L-${suffix}`,
        inputSnapshotId: snapshotId,
        outcome: { outcome: "ASSIGNED" },
        sizeBytes: 100,
        tierBWritten: false,
        tierBReason: null,
        samplingDraw: 0.004,
        samplingRate: 0.01,
      },
    });
    if (!written) return decisionId;
    await prisma.decisionRecordB.create({
      data: {
        decisionId,
        roundId: `${PREFIX}:r1`,
        shardId: `${PREFIX}:s1`,
        decisionTime,
        writtenBecause: "SAMPLED",
        candidateSet: [],
        feasibility: [],
        costs: [],
        contentHash: `${PREFIX}-${suffix}`,
        retainUntil: options.retainUntil,
      },
    });
    // The writer's own order (`decisionRecord.writeRound`): Tier B first, then the claim.
    await prisma.decisionRecordA.updateMany({ where: { decisionId }, data: { tierBWritten: true, tierBReason: "SAMPLED" } });
    return decisionId;
  };

  try {
    console.log("\nP7-D5 D1 — live PostgreSQL verification of Tier B retention\n");
    await cleanup();
    const snap = await snapshot();

    /* ── L1 / L2 — the trigger, and the defect it produced ───────────────────── */
    const old = await pair(snap.id, "old", { retainUntil: PAST });
    let l1Message = null;
    try {
      await prisma.decisionRecordA.updateMany({ where: { decisionId: old }, data: { tierBWritten: false } });
    } catch (error) {
      // The trigger's own message, not Prisma's call-site preamble: any error would otherwise pass.
      const match = String(error.message).match(/DecisionRecordA\.tierBWritten may not be un-set[^\n]*/);
      l1Message = match ? match[0].slice(0, 200) : null;
    }
    record("L1", "the real trigger refuses un-setting tierBWritten", l1Message !== null, l1Message || "not refused by the trigger");

    await prisma.decisionRecordB.deleteMany({ where: { decisionId: old } });
    let l2Refused = false;
    try {
      await prisma.decisionRecordA.updateMany({ where: { decisionId: old }, data: { tierBWritten: false } });
    } catch (error) {
      l2Refused = /tierBWritten may not be un-set/.test(String(error.message));
    }
    const oldA = await prisma.decisionRecordA.findUnique({ where: { decisionId: old }, include: { tierB: true } });
    record(
      "L2",
      "the pre-fix sequence (delete, then un-set) leaves Tier B deleted and Tier A still claiming it",
      l2Refused && oldA.tierBWritten === true && oldA.tierB === null,
      `update refused = ${l2Refused}; tierBWritten = ${oldA.tierBWritten}; Tier B row = ${oldA.tierB === null ? "gone" : "present"}`,
    );
    await bypassingTriggers([`DELETE FROM "DecisionRecordA" WHERE "decisionId" = '${old}'`]);

    /* ── L3 — the shipped expireTierB ────────────────────────────────────────── */
    const due = await pair(snap.id, "due", { retainUntil: PAST });
    const kept = await pair(snap.id, "kept", { retainUntil: FUTURE });
    const edge = await pair(snap.id, "edge", { retainUntil: new Date(NOW) });
    const unsampled = await pair(snap.id, "unsampled", { written: false });
    const tierABefore = await tierA(prisma);

    let l3Error = null;
    let l3 = null;
    try {
      l3 = await worker.expireTierB({ prisma }, { nowMs: NOW });
    } catch (error) {
      l3Error = String(error.message).slice(0, 200);
    }
    const tierBAfter = await tierBIds(prisma);
    record(
      "L3",
      "expireTierB completes, removes only the due row, and leaves every Tier A row byte-identical",
      l3Error === null &&
        l3.expired === 1 &&
        same(tierBAfter, [edge, kept].sort()) &&
        same(await tierA(prisma), tierABefore),
      l3Error ? `threw: ${l3Error}` : `result = ${JSON.stringify({ expired: l3.expired, selected: l3.selected })}; Tier B left = ${tierBAfter.join(", ")}`,
    );
    record("L6", "a row expiring exactly at now is not yet due (strict <)", tierBAfter.includes(edge));

    /* ── L4 — repeated pass ──────────────────────────────────────────────────── */
    const again = await worker.expireTierB({ prisma }, { nowMs: NOW });
    record(
      "L4",
      "a repeated pass removes nothing and changes nothing",
      again.expired === 0 && same(await tierBIds(prisma), tierBAfter) && same(await tierA(prisma), tierABefore),
      `result = ${JSON.stringify(again)}`,
    );

    /* ── L5 — the batch bound on a real query ────────────────────────────────── */
    const batch = [];
    for (const suffix of ["b1", "b2", "b3"]) batch.push(await pair(snap.id, suffix, { retainUntil: PAST }));
    const first = await worker.expireTierB({ prisma }, { nowMs: NOW, batch: 2 });
    const left = (await tierBIds(prisma)).filter((id) => batch.includes(id));
    const second = await worker.expireTierB({ prisma }, { nowMs: NOW, batch: 2 });
    record(
      "L5",
      "the batch bound holds on PostgreSQL, and the next pass finishes the backlog",
      first.expired === 2 && left.length === 1 && second.expired === 1,
      `first = ${first.expired}, left = ${left.length}, second = ${second.expired}`,
    );

    /* ── L7 — one statement, all or nothing ──────────────────────────────────── */
    const f1 = await pair(snap.id, "f1", { retainUntil: PAST });
    const f2 = await pair(snap.id, "f2", { retainUntil: PAST });
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION "p7d5_d1_refuse_one_delete"() RETURNS trigger AS $$
      BEGIN
        IF OLD."decisionId" = '${f2}' THEN RAISE EXCEPTION 'p7d5-d1: injected failure deleting %', OLD."decisionId"; END IF;
        RETURN OLD;
      END; $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER "p7d5_d1_refuse_one_delete" BEFORE DELETE ON "DecisionRecordB" FOR EACH ROW EXECUTE FUNCTION "p7d5_d1_refuse_one_delete"()`,
    );
    const tierABeforeFailure = await tierA(prisma);
    let l7Threw = false;
    try {
      await worker.expireTierB({ prisma }, { nowMs: NOW });
    } catch {
      l7Threw = true;
    }
    const survivors = await tierBIds(prisma);
    record(
      "L7",
      "a DELETE refused on one row removes no row of the batch, and Tier A is unchanged",
      l7Threw && survivors.includes(f1) && survivors.includes(f2) && same(await tierA(prisma), tierABeforeFailure),
      `threw = ${l7Threw}; f1 ${survivors.includes(f1) ? "retained" : "DELETED"}; f2 ${survivors.includes(f2) ? "retained" : "DELETED"}`,
    );
    await prisma.$executeRawUnsafe(`DROP TRIGGER "p7d5_d1_refuse_one_delete" ON "DecisionRecordB"`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION "p7d5_d1_refuse_one_delete"()`);

    /* ── L8 / L9 — reconstructibility, and the reader's view ────────────────── */
    const snapshotStill = await prisma.inputSnapshot.findUnique({ where: { snapshotId: `${PREFIX}:snap` } });
    record("L8", "InputSnapshot is untouched by expiry", snapshotStill !== null);

    const read = await prisma.decisionRecordA.findUnique({ where: { decisionId: due }, include: { tierB: true, inputSnapshot: true } });
    const unsampledRead = await prisma.decisionRecordA.findUnique({ where: { decisionId: unsampled }, include: { tierB: true } });
    record(
      "L9",
      "read as the Explanation API reads it: the expired decision is written-not-retained, the unsampled one never-written",
      read.tierBWritten === true && read.tierBReason === "SAMPLED" && read.tierB === null && read.inputSnapshot !== null &&
        unsampledRead.tierBWritten === false && unsampledRead.tierB === null,
      `expired: tierBWritten=${read.tierBWritten}, tierBRetained=${Boolean(read.tierB)}, snapshot=${Boolean(read.inputSnapshot)}; ` +
        `unsampled: tierBWritten=${unsampledRead.tierBWritten}`,
    );
  } finally {
    await cleanup().catch((error) => console.error(`cleanup failed: ${error.message}`));
    await prisma.$disconnect();
  }

  const failed = results.filter((row) => !row.passed);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { refusalFor };
