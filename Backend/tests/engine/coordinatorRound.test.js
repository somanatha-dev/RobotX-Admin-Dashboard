"use strict";

/**
 * §3.2 / §9 / §19.5 — the Assignment Coordinator: leadership before work, claim before
 * plan, settle after commit, and a failover that reconstructs rather than recovers.
 *
 * This is the file that tests the four properties §5.2 item C6 says the round loop must
 * have and the `setImmediate` detach did not: an owner, a timeout, retry, and
 * observability.
 */

const coordinator = require("../../src/workers/coordinator.worker");
const planState = require("../../src/engine/shard/planState");
const intake = require("../../src/engine/intake/intake");
const round = require("../../src/engine/solve/round");
const leadership = require("../../src/engine/shard/leadership");
const fixture = require("./helpers/roundFixture");

const NOW = new Date("2026-08-05T12:00:00.000Z");
const SHARD = leadership.DEFAULT_SHARD_ID;

/**
 * The store double: the memory Prisma plus the two things the coordinator reads through
 * raw SQL — the store clock (§10.6) and the leadership row (§10.3.2 guard G1).
 *
 * @param {object} [options] `{ leaseExpiry, legs }`
 */
function store(options) {
  const settings = options || {};
  const prisma = fixture.memoryPrisma();
  const legs = settings.legs || [];

  prisma.$queryRawUnsafe = async (sql) => {
    if (sql.includes("NOW()")) return [{ now: NOW }];
    if (sql.includes("ShardLeadership")) {
      return [
        {
          shardId: SHARD,
          leadershipFence: "7",
          holder: "instance-1",
          leaseExpiry:
            settings.leaseExpiry === undefined ? new Date(NOW.getTime() + 60_000) : settings.leaseExpiry,
        },
      ];
    }
    return [];
  };

  prisma.leg = {
    async findMany() {
      return legs.map((leg) => ({ ...leg }));
    },
    async updateMany({ where, data }) {
      const matched = legs.filter((leg) => leg.id === where.id && leg.version === where.version && leg.state === where.state);
      for (const leg of matched) Object.assign(leg, data);
      return { count: matched.length };
    },
  };

  return { prisma, legs };
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
      state: intake.QUEUE_STATE.QUEUED,
      enqueuedAt: new Date(NOW.getTime() - 1000),
      ...(overrides || {}),
    },
  });
}

/** A coordinator dependency set whose round returns a scripted result. */
function deps(prisma, scriptedResult, extra) {
  const state = planState.create({ shardId: SHARD });
  return {
    prisma,
    planState: state,
    expandCandidates: async () => ({ candidates: [], achievedGapMilliCU: 0n, problems: [] }),
    pricedCandidateFor: () => null,
    commit: async () => ({ committed: true, outcome: "COMMITTED", commitment: { commitmentId: "c1" } }),
    __scripted: scriptedResult,
    ...(extra || {}),
  };
}

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

describe("§10.3.2 guard G1 — leadership is checked before any work is done", () => {
  test("a coordinator whose lease has expired refuses to PLAN, not merely to commit", async () => {
    const { prisma } = store({ leaseExpiry: new Date(NOW.getTime() - 1) });
    await enqueue(prisma, "L1");

    const result = await coordinator.runRound(deps(prisma), {
      shardId: SHARD,
      config: CONFIG,
      feasibleSupply: 3,
      nowMs: NOW.getTime(),
      instanceId: "instance-1",
    });

    expect(result.ran).toBe(false);
    expect(result.reason).toBe("NOT_LEADER");
    // Nothing was claimed: the row is untouched for the real leader.
    expect(prisma.__tables.workQueue[0].state).toBe(intake.QUEUE_STATE.QUEUED);
  });

  test("no leadership record at all also stops the round", async () => {
    const { prisma } = store({ leaseExpiry: null });
    await enqueue(prisma, "L1");

    const result = await coordinator.runRound(deps(prisma), {
      shardId: SHARD,
      config: CONFIG,
      feasibleSupply: 3,
      nowMs: NOW.getTime(),
    });

    expect(result.ran).toBe(false);
    expect(result.detail).toBe("NO_LEADERSHIP_LEASE");
  });
});

describe("§3.2 — claim, then plan, then settle", () => {
  test("an empty queue runs no round and says why", async () => {
    const { prisma } = store();
    const result = await coordinator.runRound(deps(prisma), {
      shardId: SHARD,
      config: CONFIG,
      feasibleSupply: 3,
      nowMs: NOW.getTime(),
    });

    expect(result).toMatchObject({ ran: false, reason: "QUEUE_EMPTY" });
  });

  test("claiming is a conditional write on (state, version) — a second claim finds nothing", async () => {
    const { prisma } = store();
    await enqueue(prisma, "L1");

    const first = await coordinator.claimBatch({ prisma }, { shardId: SHARD, roundId: "r1", storeTime: NOW, limit: 10 });
    const second = await coordinator.claimBatch({ prisma }, { shardId: SHARD, roundId: "r2", storeTime: NOW, limit: 10 });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    expect(prisma.__tables.workQueue[0]).toMatchObject({
      state: intake.QUEUE_STATE.CLAIMED,
      claimedByRoundId: "r1",
      roundsConsidered: 1,
      version: 1,
    });
  });

  test("claiming honours priority then arrival, and the round's batch cap", async () => {
    const { prisma } = store();
    await enqueue(prisma, "L-bulk", { priority: 204, idempotencyKey: "k1" });
    await enqueue(prisma, "L-critical", { priority: 200, idempotencyKey: "k2" });

    const claimed = await coordinator.claimBatch({ prisma }, { shardId: SHARD, roundId: "r1", storeTime: NOW, limit: 1 });

    expect(claimed).toHaveLength(1);
    expect(claimed[0].legId).toBe("L-critical");
  });

  test("a row whose availableAt is in the future is not claimed (§4.3 DEFERRED)", async () => {
    const { prisma } = store();
    await enqueue(prisma, "L1", { availableAt: new Date(NOW.getTime() + 60_000) });

    const claimed = await coordinator.claimBatch({ prisma }, { shardId: SHARD, roundId: "r1", storeTime: NOW, limit: 10 });
    expect(claimed).toHaveLength(0);
  });
});

describe("settlement — the queue is settled AFTER the commit, never before", () => {
  test("a committed assignment leaves the queue as SOLVED", async () => {
    const { prisma } = store();
    const row = await enqueue(prisma, "L1");
    const claimed = await coordinator.claimBatch({ prisma }, { shardId: SHARD, roundId: "r1", storeTime: NOW, limit: 10 });

    await coordinator.settleBatch(
      { prisma },
      {
        claimed,
        storeTime: NOW,
        result: {
          decisions: [{ legId: "L1", outcome: round.LEG_OUTCOME.ASSIGNED }],
          committed: [{ legId: "L1" }],
        },
      },
    );

    expect(prisma.__tables.workQueue.find((entry) => entry.id === row.id).state).toBe(intake.QUEUE_STATE.SOLVED);
  });

  test("an assignment whose COMMIT ABORTED returns to QUEUED — nothing is lost", async () => {
    const { prisma } = store();
    await enqueue(prisma, "L1");
    const claimed = await coordinator.claimBatch({ prisma }, { shardId: SHARD, roundId: "r1", storeTime: NOW, limit: 10 });

    const settlement = await coordinator.settleBatch(
      { prisma },
      {
        claimed,
        storeTime: NOW,
        result: { decisions: [{ legId: "L1", outcome: round.LEG_OUTCOME.ASSIGNED }], committed: [] },
      },
    );

    expect(settlement).toEqual({ settled: 0, requeued: 1 });
    expect(prisma.__tables.workQueue[0]).toMatchObject({
      state: intake.QUEUE_STATE.QUEUED,
      claimedByRoundId: null,
    });
  });

  test("an unassigned Leg returns to QUEUED and keeps its rounds-considered tally", async () => {
    const { prisma } = store();
    await enqueue(prisma, "L1");
    const claimed = await coordinator.claimBatch({ prisma }, { shardId: SHARD, roundId: "r1", storeTime: NOW, limit: 10 });

    await coordinator.settleBatch(
      { prisma },
      {
        claimed,
        storeTime: NOW,
        result: { decisions: [{ legId: "L1", outcome: round.LEG_OUTCOME.NO_FEASIBLE_CANDIDATE }], committed: [] },
      },
    );

    expect(prisma.__tables.workQueue[0]).toMatchObject({ state: intake.QUEUE_STATE.QUEUED, roundsConsidered: 1 });
  });

  test("a Leg with an UNRECOGNISED outcome returns to the queue rather than being dropped", async () => {
    const { prisma } = store();
    await enqueue(prisma, "L1");
    const claimed = await coordinator.claimBatch({ prisma }, { shardId: SHARD, roundId: "r1", storeTime: NOW, limit: 10 });

    await coordinator.settleBatch(
      { prisma },
      { claimed, storeTime: NOW, result: { decisions: [], committed: [] } },
    );

    // Returning is the default. A dropped Leg is exactly the failure this phase removes.
    expect(prisma.__tables.workQueue[0].state).toBe(intake.QUEUE_STATE.QUEUED);
  });

  test("a deferred Leg leaves the queue and its deferral counters advance (§8.8)", async () => {
    const { prisma } = store();
    await enqueue(prisma, "L1");
    const claimed = await coordinator.claimBatch({ prisma }, { shardId: SHARD, roundId: "r1", storeTime: NOW, limit: 10 });

    await coordinator.settleBatch(
      { prisma },
      {
        claimed,
        storeTime: NOW,
        result: { decisions: [{ legId: "L1", outcome: round.LEG_OUTCOME.DEFERRED }], committed: [] },
      },
    );

    expect(prisma.__tables.workQueue[0]).toMatchObject({
      state: intake.QUEUE_STATE.SOLVED,
      consecutiveDeferrals: 1,
      firstDeferredAt: NOW,
    });
  });
});

describe("CHAOS — a round that throws returns its batch to the queue", () => {
  test("nothing stays claimed by a round that vanished", async () => {
    const { prisma } = store();
    await enqueue(prisma, "L1");
    await enqueue(prisma, "L2", { idempotencyKey: "k-L2b" });

    const exploding = deps(prisma, null, {
      expandCandidates: async () => {
        throw new Error("routing service exploded");
      },
    });

    await expect(
      coordinator.runRound(exploding, {
        shardId: SHARD,
        config: CONFIG,
        feasibleSupply: 3,
        nowMs: NOW.getTime(),
        instanceId: "instance-1",
      }),
    ).rejects.toThrow(/routing service exploded/);

    for (const row of prisma.__tables.workQueue) {
      expect(row.state).toBe(intake.QUEUE_STATE.QUEUED);
      expect(row.claimedByRoundId).toBeNull();
    }
  });
});

describe("§19.5 — failover: reconstructed, never recovered", () => {
  test("Legs PLANNED with no live commitment return to QUEUED, in the queue and in the Leg row", async () => {
    const { prisma, legs } = store({
      legs: [
        { id: "leg-a", state: "PLANNED", version: 3, commitments: [] },
        { id: "leg-b", state: "PLANNED", version: 1, commitments: [] },
      ],
    });
    await enqueue(prisma, "leg-a", { state: intake.QUEUE_STATE.CLAIMED, claimedByRoundId: "dead-round" });

    const outcome = await coordinator.resumeAfterFailover({ prisma }, SHARD);

    expect(outcome.requeue).toEqual(["leg-a", "leg-b"]);
    expect(legs.every((leg) => leg.state === "QUEUED")).toBe(true);
    expect(prisma.__tables.workQueue[0]).toMatchObject({
      state: intake.QUEUE_STATE.QUEUED,
      claimedByRoundId: null,
    });
  });

  test("a Leg PLANNED WITH a live commitment is left alone — no double commit (guard G1)", async () => {
    const { prisma, legs } = store({
      legs: [
        { id: "leg-a", state: "PLANNED", version: 3, commitments: [{ id: "c1" }] },
        { id: "leg-b", state: "PLANNED", version: 1, commitments: [] },
      ],
    });

    const outcome = await coordinator.resumeAfterFailover({ prisma }, SHARD);

    expect(outcome.requeue).toEqual(["leg-b"]);
    expect(outcome.leftAlone[0].legId).toBe("leg-a");
    expect(legs.find((leg) => leg.id === "leg-a").state).toBe("PLANNED");
  });

  test("no SOFT reservation is read from anywhere, because none was ever written", async () => {
    const { prisma } = store({ legs: [] });
    const outcome = await coordinator.resumeAfterFailover({ prisma }, SHARD);

    expect(outcome.note).toMatch(/reconstructed, never recovered/);
    expect(outcome.note).toMatch(/none\s+was ever written to one/);
  });
});

describe("observability — every round produces a Round row and a record per Leg", () => {
  test("the Round row carries the regime, the budgets, and both gaps separately", async () => {
    const { prisma } = store();

    await coordinator.recordRound(
      { prisma },
      {
        shardId: SHARD,
        roundId: "r1",
        storeTime: NOW,
        snapshot: { snapshotId: "snap-1", pins: { configVersion: "v1" }, seed: "abc" },
        cadenceVerdict: { regime: "NOMINAL", windowMs: 500 },
        leadershipFence: 7,
        instanceId: "instance-1",
        result: {
          decisionTimeMs: NOW.getTime(),
          regime: "SINGLETON",
          guarantees: { exact: true, exactOver: "the integer problem", dualKind: "EXACT_INTEGER_MARGINAL_PRICE" },
          outcome: "COMPLETED",
          note: null,
          assignments: [{ legId: "L1", agentId: "A1" }],
          deferrals: [],
          committed: [{ legId: "L1" }],
          aborted: [],
          decisions: [{ legId: "L1", outcome: "ASSIGNED", agentId: "A1", searchGapMilliCU: 0n }],
          columns: { generated: 3, kept: 3, pruned: 0, budgetTruncated: false, bestPrunedGammaMilliCU: null },
          partitions: [{}],
          partitionMerges: [],
          searchGapMilliCU: 0n,
          lpIpGapMilliCU: 0n,
          budgets: { budgetLimited: false, exceeded: [], counters: {}, wallClock: {} },
        },
      },
    );

    const [roundRow] = prisma.__tables.rounds;
    expect(roundRow).toMatchObject({
      roundId: "r1",
      shardId: SHARD,
      regime: "SINGLETON",
      searchGapMilliCU: "0",
      lpIpGapMilliCU: "0",
      leadershipFence: 7n,
    });
    expect(roundRow.outcome).toMatchObject({ outcome: "COMPLETED", assigned: 1, committed: 1 });

    const [record] = prisma.__tables.decisionRecords;
    expect(record).toMatchObject({ decisionId: "r1:L1", roundId: "r1", legId: "L1" });
    expect(record.searchAndSolveBounds.guarantees.dualKind).toBe("EXACT_INTEGER_MARGINAL_PRICE");
    // §8.8 — deferral is null because none was taken, not because a reason was omitted.
    expect(record.deferral).toBeNull();
  });
});

describe("the advisory Redis surfaces are advisory (§3.3)", () => {
  test("a kv failure never fails the round", async () => {
    const { prisma } = store();
    const explodingKv = {
      async set() {
        throw new Error("redis down");
      },
    };

    await expect(
      coordinator.publishQueueMirror({ kv: explodingKv }, SHARD, { depth: 3, slaClassesWaiting: [] }),
    ).resolves.toBeUndefined();
  });

  test("the two key names match the plan's own scheme", () => {
    expect(coordinator.KEY.queue("s1")).toBe("engine:queue:s1");
    expect(coordinator.KEY.currentRound("s1")).toBe("engine:round:s1:current");
  });
});
