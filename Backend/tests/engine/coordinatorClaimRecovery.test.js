"use strict";

/**
 * B3 — recovery of queue claims left CLAIMED by a coordinator round that died.
 *
 * A round claims rows and settles them; its catch path returns them if it throws. A process
 * that dies between the claim and the settlement does neither, and `claimBatch` takes only
 * QUEUED rows, so the Leg was never served again (measured 2026-10-01: CLAIMED for 39
 * minutes across a restart, Task PENDING). `coordinator.worker.recoverOrphanedClaims` runs at
 * the start of every round and releases such a claim only when:
 *   - its round is not running in this process;
 *   - this process still holds the leadership fence it pinned (re-read in the transaction);
 *   - the Leg (row-locked) has no live commitment and is QUEUED. With a live commitment the
 *     row goes to SOLVED, never back to QUEUED.
 *
 * These tests use the same in-memory store as `coordinatorRound.test.js`. The races against
 * a real PostgreSQL (row locks, two processes) are in `tools/verify/b3OrphanClaimRecovery.js`.
 */

const coordinator = require("../../src/workers/coordinator.worker");
const planState = require("../../src/engine/shard/planState");
const intake = require("../../src/engine/intake/intake");
const round = require("../../src/engine/solve/round");
const leadership = require("../../src/engine/shard/leadership");
const fixture = require("./helpers/roundFixture");

const NOW = new Date("2026-08-05T12:00:00.000Z");
const SHARD = leadership.DEFAULT_SHARD_ID;
const { CLAIMED, QUEUED, SOLVED } = intake.QUEUE_STATE;

const CONFIG = {
  windowMinMs: 500,
  windowMaxMs: 3000,
  saturatedWindowMs: 10000,
  batchGrowthThreshold: 10,
  fastPathClasses: [],
  maxLegsPerRound: 500,
  maxWindowSlaFraction: 0.05,
  maxEvaluatedPerLeg: 200,
  maxColumnsPerRound: 2000,
  branchNodeBudget: 5000,
  timeBudgetMs: 250,
  maxClockSkewMillis: 1000,
  storeRoundTripMillis: 100,
};

/** The in-memory store, plus the Leg rows, commitments, leadership fence and row lock recovery reads. */
function world(options) {
  const settings = options || {};
  const prisma = fixture.memoryPrisma();
  const legs = (settings.legs || []).map((leg) => ({ version: 1, ...leg }));
  const commitments = settings.commitments || [];
  const lead = { fence: settings.fence === undefined ? 7n : settings.fence };
  const locks = [];

  prisma.$queryRawUnsafe = async (sql) => {
    if (sql.includes("NOW()")) return [{ now: NOW }];
    if (sql.includes("ShardLeadership")) {
      return [{ shardId: SHARD, leadershipFence: String(lead.fence), holder: "instance-1", leaseExpiry: new Date(NOW.getTime() + 60_000) }];
    }
    return [];
  };
  prisma.commitment = {
    async count({ where }) {
      return commitments.filter((row) => row.legId === where.legId && (where.releasedAt !== null || row.releasedAt == null)).length;
    },
  };
  prisma.leg = {
    async findMany() {
      return [];
    },
    async updateMany() {
      return { count: 0 };
    },
  };
  // One store, so a "transaction" is the callback run against it; what isolation would add
  // is modelled by the conditional write, which is what the tests below exercise.
  prisma.$transaction = async (fn) => fn(prisma);

  const selectForUpdate = async (tx, table, column, value) => {
    locks.push({ table, column, value });
    if (typeof settings.onLock === "function") await settings.onLock({ table, value, legs, commitments });
    return table === "Leg" ? legs.find((leg) => leg.id === value) || null : null;
  };

  return { prisma, legs, commitments, lead, locks, selectForUpdate };
}

async function enqueue(prisma, legId, overrides) {
  return prisma.workQueue.create({
    data: {
      legId,
      shardId: SHARD,
      idempotencyKey: `k-${legId}`,
      purpose: "PRIMARY",
      slaClass: "standard",
      priority: 0,
      state: QUEUED,
      version: 0,
      roundsConsidered: 0,
      consecutiveDeferrals: 0,
      enqueuedAt: new Date(NOW.getTime() - 1000),
      ...(overrides || {}),
    },
  });
}

const recover = (w, fence = w.lead.fence) =>
  coordinator.recoverOrphanedClaims({ prisma: w.prisma, selectForUpdate: w.selectForUpdate }, { shardId: SHARD, storeTime: NOW, leadershipFence: fence });

const rowFor = (prisma, legId) => prisma.__tables.workQueue.find((row) => row.legId === legId);

/** The production composition's two queue hooks, over this store. */
function roundDeps(w, extra) {
  const recorded = [];
  return {
    recorded,
    deps: {
      prisma: w.prisma,
      planState: planState.create({ shardId: SHARD }),
      expandCandidates: async () => ({ candidates: [], achievedGapMilliCU: 0n, problems: [] }),
      pricedCandidateFor: () => null,
      commit: async () => ({ committed: true, outcome: "COMMITTED" }),
      recoverOrphanedClaims: (input) => coordinator.recoverOrphanedClaims({ prisma: w.prisma, selectForUpdate: w.selectForUpdate }, input),
      record: (event, detail) => recorded.push({ event, detail }),
      ...(extra || {}),
    },
  };
}

const runRound = (deps) =>
  coordinator.runRound(deps, { shardId: SHARD, config: CONFIG, feasibleSupply: 3, nowMs: NOW.getTime(), instanceId: "instance-1" });

describe("B3-01 — a claim whose round is gone is released", () => {
  test("CLAIMED by a round with no Round row, Leg QUEUED, no commitment → QUEUED and claimable", async () => {
    const w = world({ legs: [{ id: "L1", state: "QUEUED" }] });
    await enqueue(w.prisma, "L1", { state: CLAIMED, claimedByRoundId: "shard:1790826690549", claimedAt: NOW, version: 4 });

    const outcome = await recover(w);

    expect(outcome).toMatchObject({ requeued: 1, solved: 0, refusal: null });
    expect(rowFor(w.prisma, "L1")).toMatchObject({ state: QUEUED, claimedByRoundId: null, claimedAt: null, version: 5 });
    expect(w.locks).toEqual([{ table: "Leg", column: "id", value: "L1" }]);
    const claimed = await coordinator.claimBatch({ prisma: w.prisma }, { shardId: SHARD, roundId: "r-next", storeTime: NOW, limit: 10 });
    expect(claimed.map((row) => row.legId)).toEqual(["L1"]);
  });

  test("a Round row that exists does not keep a claim its settlement never released", async () => {
    const w = world({ legs: [{ id: "L1", state: "QUEUED" }] });
    w.prisma.__tables.rounds.push({ roundId: "r-recorded" });
    await enqueue(w.prisma, "L1", { state: CLAIMED, claimedByRoundId: "r-recorded", version: 2 });

    expect((await recover(w)).requeued).toBe(1);
    expect(rowFor(w.prisma, "L1").state).toBe(QUEUED);
  });
});

describe("B3-02 — a live claim is never released", () => {
  test("a round still running in this process keeps its claim", async () => {
    const w = world({ legs: [{ id: "L1", state: "QUEUED" }] });
    await enqueue(w.prisma, "L1");
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const { deps } = roundDeps(w, {
      expandCandidates: async () => {
        await gate;
        return { candidates: [], achievedGapMilliCU: 0n, problems: [] };
      },
    });

    const running = runRound(deps);
    // eslint-disable-next-line no-await-in-loop
    for (let i = 0; i < 50 && rowFor(w.prisma, "L1").state !== CLAIMED; i += 1) await new Promise((r) => setImmediate(r));
    const liveRoundId = rowFor(w.prisma, "L1").claimedByRoundId;
    expect(rowFor(w.prisma, "L1").state).toBe(CLAIMED);

    const outcome = await recover(w);
    expect(outcome.requeued).toBe(0);
    expect(outcome.left).toEqual([{ legId: "L1", claimedByRoundId: liveRoundId, reason: "ROUND_IN_FLIGHT" }]);
    expect(rowFor(w.prisma, "L1")).toMatchObject({ state: CLAIMED, claimedByRoundId: liveRoundId });

    release();
    await running;
    // The round settled its own claim; recovery never touched it.
    expect(rowFor(w.prisma, "L1")).toMatchObject({ state: QUEUED, claimedByRoundId: null });
  });

  test("a process that no longer holds the fence it pinned releases nothing", async () => {
    const w = world({ legs: [{ id: "L1", state: "QUEUED" }], fence: 8n });
    await enqueue(w.prisma, "L1", { state: CLAIMED, claimedByRoundId: "new-leaders-round", version: 3 });

    const outcome = await recover(w, 7n);

    expect(outcome).toMatchObject({ requeued: 0, solved: 0, refusal: "LEADERSHIP_FENCE_ADVANCED" });
    expect(rowFor(w.prisma, "L1")).toMatchObject({ state: CLAIMED, claimedByRoundId: "new-leaders-round", version: 3 });
    expect(w.locks).toEqual([]);
  });

  test("with no pinned fence or no row lock, recovery refuses rather than guessing", async () => {
    const w = world({ legs: [{ id: "L1", state: "QUEUED" }] });
    await enqueue(w.prisma, "L1", { state: CLAIMED, claimedByRoundId: "dead" });

    expect((await recover(w, null)).refusal).toBe("NO_PINNED_LEADERSHIP_FENCE");
    const noLock = await coordinator.recoverOrphanedClaims({ prisma: w.prisma }, { shardId: SHARD, storeTime: NOW, leadershipFence: 7n });
    expect(noLock.refusal).toBe("NO_ROW_LOCK");
    expect(rowFor(w.prisma, "L1").state).toBe(CLAIMED);
  });
});

describe("B3-03 — a live commitment is never reopened", () => {
  test("Leg holding a live commitment → SOLVED, not QUEUED, and the Leg is untouched", async () => {
    const w = world({ legs: [{ id: "L1", state: "OFFERED", version: 6 }], commitments: [{ legId: "L1", releasedAt: null }] });
    await enqueue(w.prisma, "L1", { state: CLAIMED, claimedByRoundId: "dead", version: 2 });

    const outcome = await recover(w);

    expect(outcome).toMatchObject({ requeued: 0, solved: 1 });
    expect(rowFor(w.prisma, "L1")).toMatchObject({ state: SOLVED, settledAt: NOW, version: 3 });
    expect(w.legs[0]).toEqual({ id: "L1", state: "OFFERED", version: 6 });
    const claimed = await coordinator.claimBatch({ prisma: w.prisma }, { shardId: SHARD, roundId: "r-next", storeTime: NOW, limit: 10 });
    expect(claimed).toEqual([]);
  });

  test("a released commitment does not count as live", async () => {
    const w = world({ legs: [{ id: "L1", state: "QUEUED" }], commitments: [{ legId: "L1", releasedAt: NOW }] });
    await enqueue(w.prisma, "L1", { state: CLAIMED, claimedByRoundId: "dead" });
    expect((await recover(w)).requeued).toBe(1);
  });

  test.each(["PLANNED", "SETTLED", "CANCELLED", "EN_ROUTE_PICKUP"])(
    "a Leg in %s with no live commitment is left for its own owner",
    async (state) => {
      const w = world({ legs: [{ id: "L1", state }] });
      await enqueue(w.prisma, "L1", { state: CLAIMED, claimedByRoundId: "dead", version: 1 });

      const outcome = await recover(w);

      expect(outcome.left).toEqual([{ legId: "L1", claimedByRoundId: "dead", reason: "LEG_NOT_RECOVERABLE", legState: state }]);
      expect(rowFor(w.prisma, "L1")).toMatchObject({ state: CLAIMED, version: 1 });
    },
  );

  test("a commit that wins the Leg lock first is seen: the row goes SOLVED, never QUEUED", async () => {
    const w = world({
      legs: [{ id: "L1", state: "QUEUED" }],
      // The commit holds the Leg lock and inserts its Commitment; recovery's lock returns after it.
      onLock: async ({ legs, commitments }) => {
        commitments.push({ legId: "L1", releasedAt: null });
        legs[0].state = "OFFERED";
      },
    });
    await enqueue(w.prisma, "L1", { state: CLAIMED, claimedByRoundId: "dead" });

    expect((await recover(w)).solved).toBe(1);
    expect(rowFor(w.prisma, "L1").state).toBe(SOLVED);
  });
});

describe("B3-04 — concurrent recovery", () => {
  test("two recoveries over the same orphan: exactly one releases it", async () => {
    const w = world({ legs: [{ id: "L1", state: "QUEUED" }] });
    await enqueue(w.prisma, "L1", { state: CLAIMED, claimedByRoundId: "dead", version: 4 });

    const [a, b] = await Promise.all([recover(w), recover(w)]);

    expect(a.requeued + b.requeued).toBe(1);
    expect([...a.left, ...b.left].map((entry) => entry.reason)).toEqual(["ROW_CHANGED"]);
    expect(rowFor(w.prisma, "L1")).toMatchObject({ state: QUEUED, version: 5 });
  });
});

describe("B3-05 — recovery against claims and settlement", () => {
  test("a dead round's late settlement cannot overwrite a recovered row", async () => {
    const w = world({ legs: [{ id: "L1", state: "QUEUED" }] });
    await enqueue(w.prisma, "L1");
    const staleClaim = await coordinator.claimBatch({ prisma: w.prisma }, { shardId: SHARD, roundId: "dead", storeTime: NOW, limit: 10 });

    await recover(w);
    const fresh = await coordinator.claimBatch({ prisma: w.prisma }, { shardId: SHARD, roundId: "r-live", storeTime: NOW, limit: 10 });
    expect(fresh).toHaveLength(1);

    // The dead round's settlement arrives late, as an ASSIGNED+committed verdict.
    const late = await coordinator.settleBatch(
      { prisma: w.prisma },
      { claimed: staleClaim, storeTime: NOW, result: { decisions: [{ legId: "L1", outcome: round.LEG_OUTCOME.ASSIGNED }], committed: [{ legId: "L1" }] } },
    );
    expect(late).toEqual({ settled: 1, requeued: 0 }); // what it attempted …
    expect(rowFor(w.prisma, "L1")).toMatchObject({ state: CLAIMED, claimedByRoundId: "r-live", version: fresh[0].version }); // … changed nothing
  });

  test("a recovery that read the row before another round re-claimed it changes nothing", async () => {
    const w = world({ legs: [{ id: "L1", state: "QUEUED" }] });
    await enqueue(w.prisma, "L1", { state: CLAIMED, claimedByRoundId: "dead", version: 2 });
    const originalFindMany = w.prisma.workQueue.findMany.bind(w.prisma.workQueue);
    w.prisma.workQueue.findMany = async (args) => {
      const rows = await originalFindMany(args);
      // Between the read and the write: released by another pass and claimed by a live round.
      const row = rowFor(w.prisma, "L1");
      Object.assign(row, { state: CLAIMED, claimedByRoundId: "r-live", version: 4 });
      return rows;
    };

    const outcome = await recover(w);

    expect(outcome.requeued).toBe(0);
    expect(outcome.left[0].reason).toBe("ROW_CHANGED");
    expect(rowFor(w.prisma, "L1")).toMatchObject({ state: CLAIMED, claimedByRoundId: "r-live", version: 4 });
  });
});

describe("B3-06 / B3-07 — existing paths unchanged", () => {
  test("claim → round → settle with nothing orphaned: recovery is a no-op and settlement is as before", async () => {
    const plain = world({ legs: [{ id: "L1", state: "QUEUED" }] });
    const hooked = world({ legs: [{ id: "L1", state: "QUEUED" }] });
    await enqueue(plain.prisma, "L1");
    await enqueue(hooked.prisma, "L1");

    const { deps: withoutRecovery } = roundDeps(plain, { recoverOrphanedClaims: undefined });
    const { deps: withRecovery, recorded } = roundDeps(hooked);
    const a = await runRound(withoutRecovery);
    const b = await runRound(withRecovery);

    expect(b.ran).toBe(a.ran);
    const strip = (row) => ({ state: row.state, claimedByRoundId: row.claimedByRoundId, version: row.version, roundsConsidered: row.roundsConsidered });
    expect(strip(rowFor(hooked.prisma, "L1"))).toEqual(strip(rowFor(plain.prisma, "L1")));
    expect(recorded.filter((entry) => entry.event.startsWith("coordinator.claim"))).toEqual([]);
  });

  test("a round that throws still returns its own batch through its catch path", async () => {
    const w = world({ legs: [{ id: "L1", state: "QUEUED" }] });
    await enqueue(w.prisma, "L1");
    const { deps } = roundDeps(w, { expandCandidates: async () => { throw new Error("routing service exploded"); } });

    await expect(runRound(deps)).rejects.toThrow(/routing service exploded/);
    expect(rowFor(w.prisma, "L1")).toMatchObject({ state: QUEUED, claimedByRoundId: null });
  });

  test("a SOLVED row whose Leg came back to QUEUED is still requeued by requeueReturnedLegs, not by recovery", async () => {
    const w = world({ legs: [{ id: "L1", state: "QUEUED" }] });
    await enqueue(w.prisma, "L1", { state: SOLVED });
    const outcome = await recover(w);
    expect(outcome).toMatchObject({ requeued: 0, solved: 0, left: [] });
    expect(rowFor(w.prisma, "L1").state).toBe(SOLVED);
  });

  test("a round whose own catch path could not release its batch leaves no live marker behind", async () => {
    const w = world({ legs: [{ id: "L1", state: "QUEUED" }] });
    await enqueue(w.prisma, "L1");
    const realUpdateMany = w.prisma.workQueue.updateMany.bind(w.prisma.workQueue);
    let failReset = true;
    w.prisma.workQueue.updateMany = async (args) => {
      if (failReset && args.data && args.data.state === QUEUED && args.data.claimedByRoundId === null) throw new Error("database went away");
      return realUpdateMany(args);
    };
    const { deps } = roundDeps(w, { expandCandidates: async () => { throw new Error("routing service exploded"); } });

    await expect(runRound(deps)).rejects.toThrow(/database went away|routing service exploded/);
    expect(rowFor(w.prisma, "L1").state).toBe(CLAIMED);

    failReset = false;
    expect((await recover(w)).requeued).toBe(1);
    expect(rowFor(w.prisma, "L1").state).toBe(QUEUED);
  });
});

describe("B3-08 — the measured failure: a restart leaves a claim behind", () => {
  test("the next leader's first round releases the dead round's claim and claims the Leg itself", async () => {
    const w = world({ legs: [{ id: "L1", state: "QUEUED" }] });
    await enqueue(w.prisma, "L1", {
      state: CLAIMED,
      claimedByRoundId: "v1demo-shard:1790826690549",
      claimedAt: new Date(NOW.getTime() - 300_000),
      roundsConsidered: 24,
      version: 24,
    });
    const { deps, recorded } = roundDeps(w);

    const result = await runRound(deps);

    expect(result.ran).toBe(true);
    expect(recorded.find((entry) => entry.event === "coordinator.claims_recovered").detail).toMatchObject({ requeued: 1, solved: 0 });
    const row = rowFor(w.prisma, "L1");
    // Recovered (24 → 25), claimed by this round (→ 26), settled unassigned back to QUEUED (→ 27).
    expect(row.roundsConsidered).toBe(25);
    expect(row.version).toBe(27);
    expect(row.state).toBe(QUEUED);
  });
});
