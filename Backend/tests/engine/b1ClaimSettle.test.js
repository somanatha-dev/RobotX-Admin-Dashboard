"use strict";

/**
 * B1 — queue claim and settlement, grouped, must keep every per-row guarantee.
 *
 * Characterization (green on the pre-B1 tree, where both are one row at a time):
 *   C1  claim: the rows returned, and the rows written, are exactly the per-row result
 *   C2  claim is a CAS on (id, state QUEUED, version): a row changed after it was read is not
 *       claimed and not touched
 *   C3  two concurrent claimers never claim the same row, and between them claim every row
 *   C4  settle: assigned+committed and deferred rows leave the queue, everything else returns,
 *       with the counters exactly as before
 *   C5  settle is a CAS on (id, version): replaying a settlement is a no-op
 *   C6  a row recovered by B3 meanwhile (its version moved) is not overwritten by a late settle
 *   C7  a write that fails mid-claim leaves no row in an illegal state
 *
 * The B1 property (red before B1): the number of writes is bounded by the number of distinct
 * row shapes, not by the number of rows.
 *
 * Store: `helpers/roundFixture.memoryPrisma`, the same double B3's tests use.
 */

const coordinator = require("../../src/workers/coordinator.worker");
const intake = require("../../src/engine/intake/intake");
const round = require("../../src/engine/solve/round");
const fixture = require("./helpers/roundFixture");

const SHARD = "shard-b1-queue";
const NOW = new Date(Date.UTC(2026, 9, 1, 12, 0, 0));
const { QUEUED, CLAIMED, SOLVED } = intake.QUEUE_STATE;

async function enqueue(prisma, legId, overrides) {
  return prisma.workQueue.create({
    data: {
      shardId: SHARD,
      legId,
      purpose: "PRIMARY",
      slaClass: "STANDARD",
      idempotencyKey: `idem-${legId}`,
      enqueuedAt: new Date(NOW.getTime() - 60_000 + Number(legId.replace(/\D/g, "") || 0) * 1000),
      ...overrides,
    },
  });
}

/** A queue of rows with three different (version, roundsConsidered) shapes. */
async function mixedQueue() {
  const prisma = fixture.memoryPrisma();
  await enqueue(prisma, "L1");
  await enqueue(prisma, "L2");
  await enqueue(prisma, "L3", { version: 4, roundsConsidered: 2 });
  await enqueue(prisma, "L4", { version: 4, roundsConsidered: 2 });
  await enqueue(prisma, "L5", { version: 7, roundsConsidered: 3, consecutiveDeferrals: 1, firstDeferredAt: new Date(NOW.getTime() - 5000) });
  await enqueue(prisma, "L6", { availableAt: new Date(NOW.getTime() + 60_000) }); // not yet available
  return prisma;
}

/** Count writes to the queue table. */
function countWrites(prisma) {
  const counts = { updateMany: 0 };
  const orig = prisma.workQueue.updateMany.bind(prisma.workQueue);
  prisma.workQueue.updateMany = async (args) => {
    counts.updateMany += 1;
    return orig(args);
  };
  return counts;
}

const rows = (prisma) => prisma.__tables.workQueue.map((row) => ({ ...row })).sort((a, b) => (a.legId < b.legId ? -1 : 1));

describe("B1 C — claimBatch keeps the per-row CAS", () => {
  test("C1: the claimed rows, and the rows written, are exactly the per-row result", async () => {
    const prisma = await mixedQueue();
    const claimed = await coordinator.claimBatch({ prisma }, { shardId: SHARD, roundId: "r1", storeTime: NOW, limit: 10 });

    expect(claimed.map((row) => row.legId)).toEqual(["L1", "L2", "L3", "L4", "L5"]);
    for (const row of claimed) {
      expect(row).toMatchObject({ state: CLAIMED, claimedByRoundId: "r1", claimedAt: NOW });
    }
    expect(claimed.map((row) => [row.version, row.roundsConsidered])).toEqual([[1, 1], [1, 1], [5, 3], [5, 3], [8, 4]]);
    const stored = rows(prisma);
    expect(stored.map((row) => [row.legId, row.state, row.version, row.roundsConsidered, row.claimedByRoundId])).toEqual([
      ["L1", CLAIMED, 1, 1, "r1"],
      ["L2", CLAIMED, 1, 1, "r1"],
      ["L3", CLAIMED, 5, 3, "r1"],
      ["L4", CLAIMED, 5, 3, "r1"],
      ["L5", CLAIMED, 8, 4, "r1"],
      ["L6", QUEUED, 0, 0, null],
    ]);
    // Untouched columns stay untouched.
    expect(stored.find((row) => row.legId === "L5")).toMatchObject({ consecutiveDeferrals: 1 });
  });

  test("C1b: the limit takes the head of the queue in (priority, enqueuedAt) order", async () => {
    const prisma = await mixedQueue();
    const claimed = await coordinator.claimBatch({ prisma }, { shardId: SHARD, roundId: "r1", storeTime: NOW, limit: 2 });
    expect(claimed.map((row) => row.legId)).toEqual(["L1", "L2"]);
    expect(rows(prisma).filter((row) => row.state === CLAIMED).map((row) => row.legId)).toEqual(["L1", "L2"]);
  });

  test("C2: a row that moved after it was read is neither claimed nor touched", async () => {
    const prisma = await mixedQueue();
    const findMany = prisma.workQueue.findMany.bind(prisma.workQueue);
    prisma.workQueue.findMany = async (args) => {
      const read = await findMany(args);
      // Another writer bumps L3 once, between the claim's read and its write.
      prisma.workQueue.findMany = findMany;
      const live = prisma.__tables.workQueue.find((row) => row.legId === "L3");
      live.version += 1;
      return read;
    };
    const claimed = await coordinator.claimBatch({ prisma }, { shardId: SHARD, roundId: "r1", storeTime: NOW, limit: 10 });

    expect(claimed.map((row) => row.legId)).toEqual(["L1", "L2", "L4", "L5"]);
    expect(rows(prisma).find((row) => row.legId === "L3")).toMatchObject({ state: QUEUED, version: 5, roundsConsidered: 2, claimedByRoundId: null });
  });

  test("C3: two concurrent claimers never claim the same row and between them claim all", async () => {
    const prisma = await mixedQueue();
    const [a, b] = await Promise.all([
      coordinator.claimBatch({ prisma }, { shardId: SHARD, roundId: "rA", storeTime: NOW, limit: 10 }),
      coordinator.claimBatch({ prisma }, { shardId: SHARD, roundId: "rB", storeTime: NOW, limit: 10 }),
    ]);
    const idsA = a.map((row) => row.legId);
    const idsB = b.map((row) => row.legId);
    expect(idsA.filter((id) => idsB.includes(id))).toEqual([]);
    expect([...idsA, ...idsB].sort()).toEqual(["L1", "L2", "L3", "L4", "L5"]);
    for (const row of rows(prisma).filter((entry) => entry.state === CLAIMED)) {
      expect(row.claimedByRoundId).toBe(idsA.includes(row.legId) ? "rA" : "rB");
    }
  });

  test("C7: a claim write that fails leaves every row QUEUED or CLAIMED by this round, nothing else", async () => {
    const prisma = await mixedQueue();
    const updateMany = prisma.workQueue.updateMany.bind(prisma.workQueue);
    let n = 0;
    prisma.workQueue.updateMany = async (args) => {
      n += 1;
      if (n === 2) throw new Error("TEST DOUBLE — write failed");
      return updateMany(args);
    };
    await expect(coordinator.claimBatch({ prisma }, { shardId: SHARD, roundId: "r1", storeTime: NOW, limit: 10 })).rejects.toThrow(/write failed/);
    for (const row of rows(prisma)) {
      if (row.state === CLAIMED) expect(row.claimedByRoundId).toBe("r1");
      else expect(row.state).toBe(QUEUED);
    }
  });
});

describe("B1 C — settleBatch keeps the dispositions and the CAS", () => {
  async function claimedQueue() {
    const prisma = await mixedQueue();
    const claimed = await coordinator.claimBatch({ prisma }, { shardId: SHARD, roundId: "r1", storeTime: NOW, limit: 10 });
    return { prisma, claimed };
  }
  const legIdOf = (claimed, legId) => claimed.find((row) => row.legId === legId).legId;

  /** L1 assigned+committed, L2 assigned but aborted, L3 deferred, L5 deferred again, L4 no decision. */
  function resultFor(claimed) {
    return {
      decisions: [
        { legId: legIdOf(claimed, "L1"), outcome: round.LEG_OUTCOME.ASSIGNED },
        { legId: legIdOf(claimed, "L2"), outcome: round.LEG_OUTCOME.ASSIGNED },
        { legId: legIdOf(claimed, "L3"), outcome: round.LEG_OUTCOME.DEFERRED },
        { legId: legIdOf(claimed, "L5"), outcome: round.LEG_OUTCOME.DEFERRED },
      ],
      committed: [{ legId: legIdOf(claimed, "L1") }],
    };
  }

  test("C4: each Leg's disposition and counters are exactly the per-row result", async () => {
    const { prisma, claimed } = await claimedQueue();
    const out = await coordinator.settleBatch({ prisma }, { claimed, result: resultFor(claimed), storeTime: NOW });

    expect(out).toEqual({ settled: 3, requeued: 2 });
    const byLeg = Object.fromEntries(rows(prisma).map((row) => [row.legId, row]));
    expect(byLeg.L1).toMatchObject({ state: SOLVED, settledAt: NOW, version: 2, claimedByRoundId: "r1" });
    expect(byLeg.L2).toMatchObject({ state: QUEUED, claimedByRoundId: null, claimedAt: null, version: 2 });
    expect(byLeg.L3).toMatchObject({ state: SOLVED, settledAt: NOW, version: 6, consecutiveDeferrals: 1, firstDeferredAt: NOW });
    expect(byLeg.L4).toMatchObject({ state: QUEUED, claimedByRoundId: null, claimedAt: null, version: 6 });
    // A row already deferred keeps its FIRST deferral time and counts on.
    expect(byLeg.L5).toMatchObject({ state: SOLVED, version: 9, consecutiveDeferrals: 2, firstDeferredAt: new Date(NOW.getTime() - 5000) });
    expect(byLeg.L6).toMatchObject({ state: QUEUED, version: 0 });
  });

  test("C5: replaying the same settlement is a no-op (version CAS)", async () => {
    const { prisma, claimed } = await claimedQueue();
    await coordinator.settleBatch({ prisma }, { claimed, result: resultFor(claimed), storeTime: NOW });
    const once = rows(prisma);
    await coordinator.settleBatch({ prisma }, { claimed, result: resultFor(claimed), storeTime: new Date(NOW.getTime() + 1000) });
    expect(rows(prisma)).toEqual(once);
  });

  test("C6: a row B3 recovered meanwhile is not overwritten by the late settlement", async () => {
    const { prisma, claimed } = await claimedQueue();
    const live = prisma.__tables.workQueue.find((row) => row.legId === "L1");
    Object.assign(live, { state: QUEUED, claimedByRoundId: null, claimedAt: null, version: live.version + 1 });
    await coordinator.settleBatch({ prisma }, { claimed, result: resultFor(claimed), storeTime: NOW });
    expect(rows(prisma).find((row) => row.legId === "L1")).toMatchObject({ state: QUEUED, version: 2, claimedByRoundId: null });
  });
});

describe("B1 C — writes bounded by row shapes, not rows (red before B1)", () => {
  test("claim writes once per distinct (version, roundsConsidered); settle once per distinct outcome shape", async () => {
    const prisma = fixture.memoryPrisma();
    for (let i = 1; i <= 12; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await enqueue(prisma, `L${i}`);
    }
    const writes = countWrites(prisma);
    const claimed = await coordinator.claimBatch({ prisma }, { shardId: SHARD, roundId: "r1", storeTime: NOW, limit: 50 });
    expect(claimed.length).toBe(12);
    expect(writes.updateMany).toBe(1);

    writes.updateMany = 0;
    await coordinator.settleBatch({
      prisma,
    }, {
      claimed,
      result: { decisions: [{ legId: claimed[0].legId, outcome: round.LEG_OUTCOME.ASSIGNED }], committed: [{ legId: claimed[0].legId }] },
      storeTime: NOW,
    });
    // One SOLVED group (L1) and one requeue group (the other eleven).
    expect(writes.updateMany).toBe(2);
  });
});
