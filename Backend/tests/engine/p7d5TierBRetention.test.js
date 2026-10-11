"use strict";

/**
 * P7-D5 D1 — Tier B retention never leaves Tier A and Tier B inconsistent.
 *
 * Found (P7-D5 evidence completeness audit, 2026-10-11): `tierB.worker.expireTierB` deleted
 * the due `DecisionRecordB` rows and THEN ran `decisionRecordA.updateMany({ tierBWritten:
 * false })` as a separate statement. `20260818120000_decision_record_immutability_scope`
 * refuses exactly that UPDATE (`tierBWritten` may go false → true and never back), so on
 * PostgreSQL every pass deleted a batch and then threw. The in-memory double has no
 * triggers, so the old unit test asserted the un-set and passed. P7-D5 Step 1 armed the
 * path: it supplied `observability.tier_b_retention` (30 d), so `retainUntil` stopped being
 * null.
 *
 * The invariant these tests pin: `tierBWritten`/`tierBReason` are history ("a Tier B was
 * written, and why"); retention is the `DecisionRecordB` row's existence; expiry is one
 * DELETE and nothing else.
 *
 * MOCKED BOUNDARY: the store (`roundFixture.memoryPrisma`), with the Tier A UPDATE trigger
 * emulated from the migration's own allowlist. `tools/verify/p7d5TierBRetentionLive.js`
 * exercises the real trigger on a disposable PostgreSQL.
 */

const fs = require("fs");
const path = require("path");

const worker = require("../../src/workers/tierB.worker");
const fixture = require("./helpers/roundFixture");

const MIGRATION = path.join(
  __dirname,
  "../../prisma/migrations/20260818120000_decision_record_immutability_scope/migration.sql",
);

/** The trigger's own allowlist, read from the SQL so this emulation cannot drift from it. */
function mutableColumns() {
  const sql = fs.readFileSync(MIGRATION, "utf8");
  const match = sql.match(/mutable\s+text\[\]\s*:=\s*ARRAY\[([^\]]*)\]/);
  if (!match) throw new Error("the immutability migration no longer declares its mutable allowlist");
  return match[1].split(",").map((item) => item.trim().replace(/^'|'$/g, ""));
}

/**
 * `decision_record_is_immutable()` as `memoryPrisma` behaviour: statement-atomic (any row
 * refused → no row changed), the allowlist subtracted from the row, the three directional
 * guards. Raised with PostgreSQL's RAISE EXCEPTION code.
 */
function withImmutabilityTrigger(prisma) {
  const mutable = new Set(mutableColumns());
  const original = prisma.decisionRecordA.updateMany.bind(prisma.decisionRecordA);
  const refuse = (message) => Object.assign(new Error(message), { code: "P0001" });
  prisma.decisionRecordA.updateMany = async ({ where, data }) => {
    const rows = await prisma.decisionRecordA.findMany({ where });
    for (const before of rows) {
      const after = { ...before, ...data };
      const changed = Object.keys(data).filter((key) => !mutable.has(key) && data[key] !== before[key]);
      if (changed.length > 0) throw refuse(`DecisionRecordA is immutable (§21.2): ${changed.join(", ")}`);
      if (before.tierBWritten === true && after.tierBWritten !== true) {
        throw refuse(`DecisionRecordA.tierBWritten may not be un-set on ${before.decisionId} (§21.2)`);
      }
      if (after.tierBWritten === true && (after.tierBReason === null || after.tierBReason === undefined)) {
        throw refuse(`DecisionRecordA.tierBReason is required whenever tierBWritten on ${before.decisionId}`);
      }
    }
    return original({ where, data });
  };
  return prisma;
}

/** `findMany` honouring `take`, which the double ignores and the batch bound depends on. */
function withTake(prisma) {
  const original = prisma.decisionRecordB.findMany.bind(prisma.decisionRecordB);
  prisma.decisionRecordB.findMany = async (args = {}) => {
    const rows = await original(args);
    return Number.isFinite(args.take) ? rows.slice(0, args.take) : rows;
  };
  return prisma;
}

const NOW = 10_000;
const PAST = new Date(NOW - 1);
const FUTURE = new Date(NOW + 1);

/** A store with the trigger, and Tier A/B pairs as given. */
function store(pairs) {
  const prisma = withTake(withImmutabilityTrigger(fixture.memoryPrisma()));
  for (const pair of pairs) {
    prisma.__tables.decisionRecords.push({
      decisionId: pair.decisionId,
      tierBWritten: pair.written !== false,
      tierBReason: pair.written === false ? null : "SAMPLED",
    });
    if (pair.retainUntil !== undefined) {
      prisma.__tables.tierBRecords.push({ id: `b-${pair.decisionId}`, decisionId: pair.decisionId, retainUntil: pair.retainUntil });
    }
  }
  return prisma;
}

/** The three states the invariant admits, read the way every reader reads them. */
function stateOf(prisma, decisionId) {
  const a = prisma.__tables.decisionRecords.find((row) => row.decisionId === decisionId);
  const retained = prisma.__tables.tierBRecords.some((row) => row.decisionId === decisionId);
  if (!a.tierBWritten) return retained ? "INCONSISTENT_UNCLAIMED_ROW" : "NEVER_WRITTEN";
  return retained ? "RETAINED" : "WRITTEN_NOT_RETAINED";
}

describe("P7-D5 D1 — the emulated trigger is the real one's rules", () => {
  test("the allowlist is read from the migration, and is the three post-write columns", () => {
    expect(mutableColumns().sort()).toEqual(["inputSnapshotId", "tierBReason", "tierBWritten"]);
  });

  test("the pre-fix second statement is refused — the defect, reproduced against the trigger's rules", async () => {
    const prisma = store([{ decisionId: "d1", retainUntil: PAST }]);
    await prisma.decisionRecordB.deleteMany({ where: { id: { in: ["b-d1"] } } });
    await expect(
      prisma.decisionRecordA.updateMany({ where: { decisionId: { in: ["d1"] } }, data: { tierBWritten: false } }),
    ).rejects.toMatchObject({ code: "P0001" });
    // What the old code left behind on PostgreSQL: the row is gone, and nothing says so but its absence.
    expect(stateOf(prisma, "d1")).toBe("WRITTEN_NOT_RETAINED");
  });
});

describe("P7-D5 D1 — expireTierB", () => {
  test("removes only due Tier B rows, never touches Tier A, and does not throw under the trigger", async () => {
    const prisma = store([
      { decisionId: "due", retainUntil: PAST },
      { decisionId: "kept", retainUntil: FUTURE },
      { decisionId: "unsampled", written: false },
    ]);
    const tierABefore = JSON.parse(JSON.stringify(prisma.__tables.decisionRecords));

    const result = await worker.expireTierB({ prisma }, { nowMs: NOW });

    expect(result).toMatchObject({ expired: 1, selected: 1 });
    expect(prisma.__tables.tierBRecords.map((row) => row.decisionId)).toEqual(["kept"]);
    expect(prisma.__tables.decisionRecords).toEqual(tierABefore);
    expect(stateOf(prisma, "due")).toBe("WRITTEN_NOT_RETAINED");
    expect(stateOf(prisma, "kept")).toBe("RETAINED");
    expect(stateOf(prisma, "unsampled")).toBe("NEVER_WRITTEN");
  });

  test("a row expiring exactly at now is not yet due (strict <)", async () => {
    const prisma = store([{ decisionId: "edge", retainUntil: new Date(NOW) }]);
    expect(await worker.expireTierB({ prisma }, { nowMs: NOW })).toEqual({ expired: 0, selected: 0 });
    expect(stateOf(prisma, "edge")).toBe("RETAINED");
  });

  test("repeated passes are idempotent: the second finds nothing and changes nothing", async () => {
    const prisma = store([{ decisionId: "d1", retainUntil: PAST }, { decisionId: "d2", retainUntil: PAST }]);
    expect((await worker.expireTierB({ prisma }, { nowMs: NOW })).expired).toBe(2);
    const after = JSON.parse(JSON.stringify(prisma.__tables));
    expect(await worker.expireTierB({ prisma }, { nowMs: NOW })).toEqual({ expired: 0, selected: 0 });
    expect(JSON.parse(JSON.stringify(prisma.__tables))).toEqual(after);
  });

  test("the batch bound holds, and the next pass continues where the last stopped", async () => {
    const prisma = store(["a", "b", "c", "d", "e"].map((id) => ({ decisionId: id, retainUntil: PAST })));
    expect((await worker.expireTierB({ prisma }, { nowMs: NOW, batch: 2 })).expired).toBe(2);
    expect(prisma.__tables.tierBRecords).toHaveLength(3);
    expect((await worker.expireTierB({ prisma }, { nowMs: NOW, batch: 2 })).expired).toBe(2);
    expect((await worker.expireTierB({ prisma }, { nowMs: NOW, batch: 2 })).expired).toBe(1);
    expect(prisma.__tables.tierBRecords).toHaveLength(0);
    expect(prisma.__tables.decisionRecords.every((row) => row.tierBWritten === true)).toBe(true);
  });

  test("a failed delete changes nothing: every Tier B row and every Tier A row as it was", async () => {
    const prisma = store([{ decisionId: "d1", retainUntil: PAST }, { decisionId: "d2", retainUntil: PAST }]);
    const before = JSON.parse(JSON.stringify(prisma.__tables));
    prisma.decisionRecordB.deleteMany = async () => {
      throw Object.assign(new Error("connection reset"), { code: "P1017" });
    };

    await expect(worker.expireTierB({ prisma }, { nowMs: NOW })).rejects.toMatchObject({ code: "P1017" });
    expect(JSON.parse(JSON.stringify(prisma.__tables))).toEqual(before);
    expect(stateOf(prisma, "d1")).toBe("RETAINED");
  });

  test("the delete re-applies the retention test: a selected row that is no longer due survives", async () => {
    const prisma = store([{ decisionId: "d1", retainUntil: PAST }, { decisionId: "d2", retainUntil: PAST }]);
    const select = prisma.decisionRecordB.findMany;
    prisma.decisionRecordB.findMany = async (args) => {
      const rows = await select(args);
      // Between the select and the delete, d2's retention is extended.
      prisma.__tables.tierBRecords.find((row) => row.decisionId === "d2").retainUntil = FUTURE;
      return rows;
    };

    const result = await worker.expireTierB({ prisma }, { nowMs: NOW });

    expect(result).toMatchObject({ expired: 1, selected: 2 });
    expect(stateOf(prisma, "d2")).toBe("RETAINED");
  });

  test("rows another writer removed first are not counted as expired by this pass", async () => {
    const prisma = store([{ decisionId: "d1", retainUntil: PAST }, { decisionId: "d2", retainUntil: PAST }]);
    const select = prisma.decisionRecordB.findMany;
    prisma.decisionRecordB.findMany = async (args) => {
      const rows = await select(args);
      prisma.__tables.tierBRecords.splice(0, 1);
      return rows;
    };
    expect(await worker.expireTierB({ prisma }, { nowMs: NOW })).toMatchObject({ expired: 1, selected: 2 });
  });

  test("flushOnce completes under the trigger and reports the expiry", async () => {
    const prisma = store([{ decisionId: "d1", retainUntil: PAST }]);
    const budget = require("../../src/engine/observability/sampling").createBudget({});
    const result = await worker.flushOnce({ prisma, budget, now: () => NOW }, {});
    expect(result.expired).toBe(1);
    expect(stateOf(prisma, "d1")).toBe("WRITTEN_NOT_RETAINED");
  });

  test("source guard: the worker never writes DecisionRecordA's tierBWritten to false", () => {
    const source = fs.readFileSync(path.join(__dirname, "../../src/workers/tierB.worker.js"), "utf8");
    expect(source).not.toMatch(/tierBWritten:\s*false/);
  });
});
