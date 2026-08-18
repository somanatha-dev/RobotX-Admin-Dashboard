"use strict";

/**
 * PHASE 11 — live-PostgreSQL verification of §21's five tables, and of the two claims
 * that a green Jest suite structurally cannot reach.
 *
 * `PHASE_11_IMPLEMENTATION_REPORT.md` §5 and `PHASE_11_INDEPENDENT_VERIFICATION.md` §8
 * both record the schema as verified — by reading `migration.sql` beside `schema.prisma`
 * and re-running `prisma migrate diff --from-empty`. That proves the DDL is Prisma's own
 * output plus seven hand-written CHECK constraints. It does not prove that a single one
 * of them **fires**, and a CHECK naming the wrong column, or listing the wrong strings,
 * reads identically to a correct one in a diff.
 *
 * Two Phase 11 claims are about the database's behaviour rather than the text of the DDL,
 * and neither is reachable from `tests/engine/helpers/roundFixture.js`:
 *
 *   1. **`tier_b_write_rate`'s production filter is a RELATION condition.**
 *      `PHASE_11_INDEPENDENT_VERIFICATION.md` Finding 2. `DecisionRecordB` carries no
 *      `shadowLabel` — §21.6's marker lives on the `DecisionRecordA` it points at — so
 *      the fix is `decision: { shadowLabel: null }`, which is a JOIN. The in-memory
 *      double was taught to resolve to-one relations for the regression test, and a
 *      double that was taught the answer is not evidence that Prisma emits the join, or
 *      that PostgreSQL executes it the way the SLI needs. Only a real client against a
 *      real server settles that.
 *
 *   2. **`DecisionRecordA.inputSnapshotId` is `ON DELETE SET NULL`, not `CASCADE`.**
 *      §24.3 makes "a decision whose Tier A record is retained but whose input snapshot
 *      has expired" a defect that must stay *visible*. `CASCADE` would delete the
 *      evidence of the defect along with the snapshot. Which behaviour the database
 *      actually performs is only observable by performing a delete.
 *
 * Everything else here is the same discipline applied to the rest of §21's schema: the
 * seven CHECKs, the two unique indexes the audit chain depends on, `DecisionRecordB`'s
 * `ON DELETE CASCADE`, and the retention columns.
 *
 * The harness writes only rows it creates, all keyed under a `p11-live` prefix, and
 * removes them in a `finally`. It touches no table outside §21's five.
 *
 * Usage:
 *   DATABASE_URL=postgresql://pgverify:verify@127.0.0.1:55434/robotx_p11 \
 *     node tools/verify/phase11LiveDatabase.js
 *
 * NEVER point this at `DATABASE_URL`'s shared Neon instance or at any production
 * database. It is deliberately **not** a Jest suite, for the same reason Phases 3–10's
 * harnesses are not: it requires a PostgreSQL instance, and a test that silently skips
 * when its environment is absent is a test that reports green for having done nothing.
 */

const { PrismaClient } = require("@prisma/client");

const metrics = require("../../src/engine/observability/metrics");
const decisionRecord = require("../../src/engine/observability/decisionRecord");
const auditStream = require("../../src/engine/observability/auditStream");

const PREFIX = "p11-live";
const results = [];

function record(id, description, passed, detail) {
  results.push({ id, description, passed, detail });
  console.log(`  [${passed ? "PASS" : "FAIL"}] ${id} — ${description}`);
  if (detail) console.log(`         ${detail}`);
}

/** Run something that MUST be rejected by the database, and report what rejected it. */
async function refused(id, description, run) {
  try {
    await run();
    record(id, description, false, "the database ACCEPTED a row the constraint exists to refuse");
  } catch (error) {
    const message = String((error && error.message) || error).replace(/\s+/g, " ").slice(0, 220);
    record(id, description, true, message);
  }
}

async function main() {
  const url = process.env.DATABASE_URL || "";
  if (/neon\.tech/i.test(url) || /:5432\//.test(url)) {
    console.error("REFUSING to run: DATABASE_URL looks like a shared or default cluster. Use a disposable one.");
    process.exitCode = 1;
    return;
  }

  const prisma = new PrismaClient();
  const now = new Date("2026-08-18T12:00:00.000Z");

  try {
    console.log("\nPHASE 11 — live PostgreSQL verification (§21)\n");

    /* ── 1. The five tables exist, with the columns §21.2 names ─────────────── */
    const columns = await prisma.$queryRawUnsafe(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('DecisionRecordA','DecisionRecordB','InputSnapshot','CalibrationObservation','AuditEvent')`,
    );
    const byTable = new Map();
    for (const row of columns) {
      if (!byTable.has(row.table_name)) byTable.set(row.table_name, new Set());
      byTable.get(row.table_name).add(row.column_name);
    }

    record(
      "T1",
      "all five §21 tables exist",
      ["DecisionRecordA", "DecisionRecordB", "InputSnapshot", "CalibrationObservation", "AuditEvent"].every((name) =>
        byTable.has(name),
      ),
      [...byTable.keys()].sort().join(", "),
    );

    // Finding 4: the report says "nine", the migration's header comment says "seven".
    const phase11Columns = ["inputSnapshotId", "fullRetentionUntil", "sizeBytes", "tierBWritten", "tierBReason", "samplingDraw", "samplingRate", "shadowLabel"];
    record(
      "T2",
      "DecisionRecordA carries EIGHT Phase 11 columns — not the seven the migration comment claims, nor the nine the report does",
      phase11Columns.every((name) => byTable.get("DecisionRecordA").has(name)),
      `${phase11Columns.length} columns, all present: ${phase11Columns.join(", ")}`,
    );

    /* ── 2. Seed one production decision and one shadow decision ────────────── */
    const snapshot = await prisma.inputSnapshot.create({
      data: {
        snapshotId: `${PREFIX}:snap`,
        roundId: `${PREFIX}:r1`,
        shardId: `${PREFIX}:s1`,
        decisionTime: now,
        hash: `${PREFIX}-hash`,
        seed: "seed",
        pins: {},
        retainUntil: new Date(now.getTime() + 86_400_000),
      },
    });

    const makeDecision = async (decisionId, shadowLabel) =>
      prisma.decisionRecordA.create({
        data: {
          decisionId,
          roundId: `${PREFIX}:r1`,
          shardId: `${PREFIX}:s1`,
          decisionTime: now,
          legId: `${PREFIX}:L1`,
          inputSnapshotId: snapshot.id,
          outcome: { outcome: "ASSIGNED" },
          searchAndSolveBounds: {
            solver: "COST_SCALING",
            optimalityCertified: true,
            fallbackFrom: null,
            objectiveMilliCU: "9007199254740993",
            boundMilliCU: "9007199254740993",
            truncationGapMilliCU: "0",
            lpIpGapMilliCU: "0",
            legsUnassignedByIncumbent: 0,
          },
          sizeBytes: 2400,
          tierBWritten: true,
          tierBReason: "SAMPLED",
          samplingDraw: 0.004,
          samplingRate: 0.01,
          shadowLabel,
        },
      });

    await makeDecision(`${PREFIX}:r1:L1`, null);
    await makeDecision(decisionRecord.shadowDecisionIdFor("cand-a", `${PREFIX}:r1`, "L1"), "cand-a");

    for (const decisionId of [`${PREFIX}:r1:L1`, decisionRecord.shadowDecisionIdFor("cand-a", `${PREFIX}:r1`, "L1")]) {
      await prisma.decisionRecordB.create({
        data: {
          decisionId,
          roundId: `${PREFIX}:r1`,
          shardId: `${PREFIX}:s1`,
          decisionTime: now,
          writtenBecause: "SAMPLED",
          candidateSet: [],
          feasibility: [],
          costs: [],
          contentHash: `${PREFIX}-${decisionId}`,
          retainUntil: new Date(now.getTime() + 86_400_000),
        },
      });
    }

    /* ── 3. FINDING 2, on a real join ───────────────────────────────────────── */
    const unfiltered = await prisma.decisionRecordB.groupBy({
      by: ["writtenBecause"],
      where: { shardId: `${PREFIX}:s1` },
      _count: { _all: true },
    });
    const filtered = await prisma.decisionRecordB.groupBy({
      by: ["writtenBecause"],
      where: { shardId: `${PREFIX}:s1`, decision: { ...decisionRecord.PRODUCTION_ONLY } },
      _count: { _all: true },
    });

    record(
      "F2a",
      "the UNFILTERED Tier B query counts the shadow row — the leak reproduces on PostgreSQL",
      Number(unfiltered[0]._count._all) === 2,
      `unfiltered = ${unfiltered[0]._count._all}`,
    );
    record(
      "F2b",
      "the relation filter `decision: { shadowLabel: null }` excludes it — Prisma emits the join and PostgreSQL executes it",
      Number(filtered[0]._count._all) === 1,
      `filtered = ${filtered[0]._count._all}`,
    );

    const derived = await metrics.derive(
      { prisma },
      {
        shardId: `${PREFIX}:s1`,
        fromMs: now.getTime() - 60_000,
        toMs: now.getTime() + 60_000,
        config: { get: () => 5000 },
      },
    );
    const reading = derived.readings.find((row) => row.id === "tier_b_write_rate");
    const tierARate = derived.readings.find((row) => row.id === "tier_a_write_rate");
    record(
      "F2c",
      "the shipped tier_b_write_rate SLI counts one production Tier B, not two",
      reading && reading.byWrittenBecause.SAMPLED === 1 && tierARate.count === 1,
      `tier_b byWrittenBecause = ${JSON.stringify(reading && reading.byWrittenBecause)}, tier_a count = ${tierARate && tierARate.count}`,
    );

    /* ── 4. The Phase 10 solver metadata survives the JSON column ───────────── */
    const stored = await prisma.decisionRecordA.findUnique({ where: { decisionId: `${PREFIX}:r1:L1` } });
    record(
      "P11-2",
      "solver, optimalityCertified and fallbackFrom round-trip through the JSONB column",
      stored.searchAndSolveBounds.solver === "COST_SCALING" &&
        stored.searchAndSolveBounds.optimalityCertified === true &&
        stored.searchAndSolveBounds.fallbackFrom === null,
      JSON.stringify({
        solver: stored.searchAndSolveBounds.solver,
        certified: stored.searchAndSolveBounds.optimalityCertified,
        fallbackFrom: stored.searchAndSolveBounds.fallbackFrom,
      }),
    );
    record(
      "P11-3",
      "a milli-CU objective past 2^53 survives PostgreSQL's JSONB as a STRING, and the truncation gap stays distinct from the LP/IP gap",
      stored.searchAndSolveBounds.objectiveMilliCU === "9007199254740993" &&
        BigInt(stored.searchAndSolveBounds.objectiveMilliCU) === 9007199254740993n &&
        stored.searchAndSolveBounds.truncationGapMilliCU === "0" &&
        stored.searchAndSolveBounds.lpIpGapMilliCU === "0" &&
        Object.prototype.hasOwnProperty.call(stored.searchAndSolveBounds, "truncationGapMilliCU"),
      `objective = ${stored.searchAndSolveBounds.objectiveMilliCU} (a JSON number would have become 9007199254740992)`,
    );

    /* ── 5. The seven hand-written CHECK constraints, made to FIRE ──────────── */
    await refused("C1", "DecisionRecordB_written_because_known refuses a fourth writtenBecause value", () =>
      prisma.decisionRecordB.create({
        data: {
          decisionId: `${PREFIX}:r1:L1`,
          roundId: `${PREFIX}:r1`,
          shardId: `${PREFIX}:s1`,
          decisionTime: now,
          writtenBecause: "BECAUSE_I_SAID_SO",
          contentHash: `${PREFIX}-bad`,
        },
      }),
    );

    await refused("C2", "DecisionRecordA_tier_b_reason_present refuses tierBWritten with no reason", () =>
      prisma.decisionRecordA.create({
        data: {
          decisionId: `${PREFIX}:bad-reason`,
          roundId: `${PREFIX}:r1`,
          shardId: `${PREFIX}:s1`,
          decisionTime: now,
          tierBWritten: true,
          tierBReason: null,
        },
      }),
    );

    await refused("C3", "DecisionRecordA_size_non_negative refuses a negative record size", () =>
      prisma.decisionRecordA.create({
        data: {
          decisionId: `${PREFIX}:bad-size`,
          roundId: `${PREFIX}:r1`,
          shardId: `${PREFIX}:s1`,
          decisionTime: now,
          sizeBytes: -1,
        },
      }),
    );

    await refused("C4", "CalibrationObservation_predictor_known refuses an unlisted predictor", () =>
      prisma.calibrationObservation.create({
        data: { predictor: "ASTROLOGY", observedAt: now, predicted: 1, realised: 1 },
      }),
    );

    await refused("C5", "CalibrationObservation_probability_in_unit_interval refuses a probability above 1", () =>
      prisma.calibrationObservation.create({
        data: { predictor: "FAILURE_PROBABILITY", observedAt: now, predicted: 1.5, realised: 1 },
      }),
    );

    await refused("C6", "AuditEvent_event_type_known refuses an event type nobody defined", () =>
      prisma.auditEvent.create({
        data: {
          streamId: `${PREFIX}:s1`,
          sequence: 0n,
          eventType: "SOMETHING_NEW",
          hash: `${PREFIX}-bad-type`,
          recordedAt: now,
        },
      }),
    );

    await refused("C7", "AuditEvent_sequence_non_negative refuses a negative ordinal", () =>
      prisma.auditEvent.create({
        data: {
          streamId: `${PREFIX}:s1`,
          sequence: -1n,
          eventType: auditStream.EVENT_TYPE.OVERRIDE,
          hash: `${PREFIX}-bad-seq`,
          recordedAt: now,
        },
      }),
    );

    /* ── 6. The audit chain's two unique indexes, made to FIRE ──────────────── */
    const first = await auditStream.append({ prisma }, {
      streamId: `${PREFIX}:s1`,
      eventType: auditStream.EVENT_TYPE.OVERRIDE,
      actorId: "ops-7",
      actorRole: "SUPER_ADMIN",
      subjectType: "LEG",
      subjectId: `${PREFIX}:L1`,
      reason: "live verification",
      payload: { note: "first" },
      recordedAtMs: now.getTime(),
    });
    record("A1", "the first append lands at sequence 0 with no predecessor", first.ok && String(first.event.sequence) === "0" && first.event.previousHash === null);

    const second = await auditStream.append({ prisma }, {
      streamId: `${PREFIX}:s1`,
      eventType: auditStream.EVENT_TYPE.CONFIG_CHANGE,
      reason: "second link",
      payload: { note: "second" },
      recordedAtMs: now.getTime() + 1000,
    });
    record(
      "A2",
      "the second append chains to the first's hash",
      second.ok && second.event.previousHash === first.event.hash && String(second.event.sequence) === "1",
    );

    await refused("A3", "AuditEvent_streamId_sequence_key refuses a DUPLICATE ordinal — a chain has one tail", () =>
      prisma.auditEvent.create({
        data: {
          streamId: `${PREFIX}:s1`,
          sequence: 1n,
          eventType: auditStream.EVENT_TYPE.OVERRIDE,
          hash: `${PREFIX}-dup-seq`,
          recordedAt: now,
        },
      }),
    );

    await refused("A4", "AuditEvent_hash_key refuses a duplicate hash", () =>
      prisma.auditEvent.create({
        data: {
          streamId: `${PREFIX}:other`,
          sequence: 0n,
          eventType: auditStream.EVENT_TYPE.OVERRIDE,
          hash: first.event.hash,
          recordedAt: now,
        },
      }),
    );

    const verified = await auditStream.verifyStream({ prisma }, `${PREFIX}:s1`);
    record("A5", "verifyStream accepts the intact live chain", verified.ok, `checked ${verified.checked} event(s)`);

    // A third event, so the removals below have a middle and a tail to remove.
    await auditStream.append({ prisma }, {
      streamId: `${PREFIX}:s1`,
      eventType: auditStream.EVENT_TYPE.QUARANTINE,
      reason: "third link",
      payload: { note: "third" },
      recordedAtMs: now.getTime() + 2000,
    });

    // The distinction §21.7 turns on, and the one the reports must not overstate: the
    // unique index prevents DUPLICATES. It cannot prevent a REMOVAL — a DELETE leaves
    // every remaining link intact — and only application verification detects one.
    // MIDDLE removal: leaves a hole, caught twice.
    await prisma.$executeRawUnsafe(`DELETE FROM "AuditEvent" WHERE "streamId" = $1 AND "sequence" = 1`, `${PREFIX}:s1`);
    const afterMiddle = await auditStream.verifyStream({ prisma }, `${PREFIX}:s1`);
    record(
      "A6",
      "the database ALLOWED a MIDDLE removal — application verify(), not the index, detects the hole",
      afterMiddle.ok === false && afterMiddle.gaps.length > 0 && afterMiddle.brokenLinks.length > 0,
      `gaps=${JSON.stringify(afterMiddle.gaps)} brokenLinks=${afterMiddle.brokenLinks.length}`,
    );

    // TAIL removal, on a clean stream. Undetectable from the stream alone — and this is
    // the claim the module header used to overstate. It is detectable only against an
    // anchor recorded outside the table.
    await prisma.auditEvent.deleteMany({ where: { streamId: `${PREFIX}:s1` } });
    let anchor = null;
    for (const note of ["one", "two", "three"]) {
      // eslint-disable-next-line no-await-in-loop
      const appended = await auditStream.append({ prisma }, {
        streamId: `${PREFIX}:tail`,
        eventType: auditStream.EVENT_TYPE.OVERRIDE,
        reason: note,
        payload: { note },
        recordedAtMs: now.getTime(),
      });
      anchor = appended.event.sequence;
    }

    await prisma.$executeRawUnsafe(`DELETE FROM "AuditEvent" WHERE "streamId" = $1 AND "sequence" = 2`, `${PREFIX}:tail`);

    const unanchored = await auditStream.verifyStream({ prisma }, `${PREFIX}:tail`);
    record(
      "A8",
      "a TAIL removal verifies CLEAN without an anchor — stated as a limit rather than implied away",
      unanchored.ok === true && unanchored.checked === 2 && unanchored.tailIsAnchored === false,
      `ok=${unanchored.ok} checked=${unanchored.checked} lastSequence=${unanchored.lastSequence}`,
    );

    const anchored = await auditStream.verifyStream({ prisma }, `${PREFIX}:tail`, { expectedLastSequence: anchor });
    record(
      "A9",
      "the SAME truncation is caught against a recorded high-water mark, and reported as a truncation rather than a gap",
      anchored.ok === false && anchored.truncations.length === 1 && anchored.truncations[0].end === "TAIL" && anchored.gaps.length === 0,
      JSON.stringify(anchored.truncations),
    );

    // And a HEAD removal is named as such on a whole-stream read, without the caller
    // having to know to ask.
    await prisma.$executeRawUnsafe(`DELETE FROM "AuditEvent" WHERE "streamId" = $1 AND "sequence" = 0`, `${PREFIX}:tail`);
    const headless = await auditStream.verifyStream({ prisma }, `${PREFIX}:tail`);
    record(
      "A10",
      "a HEAD removal is caught on a whole-stream read, by default",
      headless.ok === false && headless.truncations.some((row) => row.end === "HEAD"),
      JSON.stringify(headless.truncations),
    );

    await prisma.auditEvent.deleteMany({ where: { streamId: `${PREFIX}:tail` } });

    // Rebuild a short intact chain for the tamper check below.
    await auditStream.append({ prisma }, {
      streamId: `${PREFIX}:s1`,
      eventType: auditStream.EVENT_TYPE.OVERRIDE,
      reason: "rebuilt",
      payload: {},
      recordedAtMs: now.getTime() + 3000,
    });

    // Tamper detection: edit an event's payload in place and recompute.
    await prisma.$executeRawUnsafe(
      `UPDATE "AuditEvent" SET "reason" = 'edited after the fact' WHERE "streamId" = $1 AND "sequence" = 0`,
      `${PREFIX}:s1`,
    );
    const tampered = await auditStream.verifyStream({ prisma }, `${PREFIX}:s1`);
    record(
      "A7",
      "an in-place EDIT is caught by recomputation, not by trust — and the AuditEvent table is NOT immutable at the database level, so the edit succeeded",
      tampered.ok === false && tampered.brokenLinks.some((row) => /altered in place/.test(row.why)),
      `brokenLinks = ${tampered.brokenLinks.length}`,
    );

    /* ── 6b. §21.2's immutability, scoped to the DECISION ───────────────────── */
    // The defect this section exists for: `DecisionRecordA_immutable` refused EVERY
    // UPDATE, and Phase 11 added three columns written after the row exists plus two
    // production paths that write them. Both paths raised P0001 on a real database and
    // passed every unit test, because the in-memory double has no triggers.
    const marked = await prisma.decisionRecordA.updateMany({
      where: { decisionId: `${PREFIX}:r1:L1` },
      data: { tierBWritten: true, tierBReason: "RESERVOIR" },
    });
    record(
      "I1",
      "the reservoir flush's own UPDATE is ACCEPTED — `tierBWritten`/`tierBReason` are post-write bookkeeping, not the decision",
      marked.count === 1,
      `rows updated = ${marked.count}`,
    );

    await refused("I2", "editing the DECISION is still refused — the §21.2 guarantee is unchanged", () =>
      prisma.decisionRecordA.updateMany({
        where: { decisionId: `${PREFIX}:r1:L1` },
        data: { outcome: { outcome: "EDITED_AFTER_THE_FACT" } },
      }),
    );

    await refused("I3", "un-setting tierBWritten is refused — evidence is added, never removed", () =>
      prisma.decisionRecordA.updateMany({
        where: { decisionId: `${PREFIX}:r1:L1` },
        data: { tierBWritten: false },
      }),
    );

    await refused("I4", "re-pointing inputSnapshotId at DIFFERENT inputs is refused — it may only be cleared (§24.3)", async () => {
      const other = await prisma.inputSnapshot.create({
        data: { snapshotId: `${PREFIX}:snap-2`, roundId: `${PREFIX}:r1`, shardId: `${PREFIX}:s1`, decisionTime: now, hash: "other", pins: {} },
      });
      return prisma.decisionRecordA.updateMany({
        where: { decisionId: `${PREFIX}:r1:L1` },
        data: { inputSnapshotId: other.id },
      });
    });

    await refused("I5", "a column added in a LATER phase is immutable by default — the allowlist is subtracted, not enumerated", () =>
      prisma.decisionRecordA.updateMany({
        where: { decisionId: `${PREFIX}:r1:L1` },
        data: { surrogateKeys: ["added-later"] },
      }),
    );

    /* ── 7. The two delete behaviours, performed rather than read ───────────── */
    // `DecisionRecordB` → `DecisionRecordA` is CASCADE: Tier B is a cache of a computable
    // function, and a cache row outliving its record would be unreachable evidence.
    await prisma.decisionRecordA.delete({ where: { decisionId: decisionRecord.shadowDecisionIdFor("cand-a", `${PREFIX}:r1`, "L1") } });
    const orphanTierB = await prisma.decisionRecordB.count({
      where: { decisionId: decisionRecord.shadowDecisionIdFor("cand-a", `${PREFIX}:r1`, "L1") },
    });
    record("D1", "deleting a DecisionRecordA CASCADEs to its DecisionRecordB", orphanTierB === 0, `orphans = ${orphanTierB}`);

    // `DecisionRecordA` → `InputSnapshot` is SET NULL, and §24.3 depends on it: an expired
    // snapshot must leave its decision record standing and visibly unreplayable.
    await prisma.decisionRecordB.deleteMany({ where: { roundId: `${PREFIX}:r1` } });
    await prisma.inputSnapshot.delete({ where: { snapshotId: `${PREFIX}:snap` } });
    const survivor = await prisma.decisionRecordA.findUnique({ where: { decisionId: `${PREFIX}:r1:L1` } });
    record(
      "D2",
      "expiring an InputSnapshot SETs NULL and leaves the Tier A record standing — deleting it would erase the evidence of the §24.3 defect",
      survivor !== null && survivor.inputSnapshotId === null,
      survivor === null ? "the decision record was DELETED — this is ON DELETE CASCADE, and §24.3 requires SET NULL" : "record retained, inputSnapshotId = NULL",
    );
  } finally {
    await prisma.decisionRecordB.deleteMany({ where: { roundId: { startsWith: PREFIX } } });
    await prisma.decisionRecordA.deleteMany({ where: { roundId: { startsWith: PREFIX } } });
    await prisma.inputSnapshot.deleteMany({ where: { roundId: { startsWith: PREFIX } } });
    await prisma.auditEvent.deleteMany({ where: { streamId: { startsWith: PREFIX } } });
    await prisma.calibrationObservation.deleteMany({ where: { decisionId: { startsWith: PREFIX } } });
    await prisma.$disconnect();
  }

  const failed = results.filter((row) => !row.passed);
  console.log(`\n  ${results.length - failed.length}/${results.length} checks passed.\n`);
  if (failed.length > 0) {
    console.log("  FAILED:");
    for (const row of failed) console.log(`    ${row.id} — ${row.description}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
