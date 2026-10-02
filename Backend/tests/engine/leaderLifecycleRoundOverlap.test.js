"use strict";

/**
 * STEP 1 (tests first) — GROUP 4: a coordinator round in flight across a LEADER_ONLY restart.
 *
 * `leaderLifecycle.apply(tick)` calls `stopAll()` for every tick with `mayRunRound: false` and
 * `startAll()` for every tick with `mayRunRound: true` (`leaderWorkers.js:847`). Step 0 measured
 * the coordinator being composed 4–6× per run at 78 ms RTT and 64–68× at 110 ms, because stale
 * supervisor ticks alternate the verdict (Step 1 report §3). `coordinator.worker`'s `stop()`
 * clears its interval and sets a flag; it does not wait for, or cancel, a round already running
 * (`coordinator.worker.js` `start`). The single-flight guard (`inFlight`) belongs to one
 * coordinator instance, and `startAll()` composes a new instance.
 *
 * This file drives the **real** lifecycle and the **real** `coordinator.worker.start` loop. Only
 * two seams are replaced: `coordinatorSolvePath.create` (the composition the test context cannot
 * satisfy) returns a minimal assembly, and that assembly's `prisma` holds every round at its
 * first statement — `runRound` reads the store clock first (`clock.readStoreTime`) — so "a round
 * in flight" is a fact the test controls rather than a race it hopes for.
 *
 * Step 0 observed **no** overlapping rounds in six runs. Step 1's characterisation showed the
 * structure permitted one (two rounds in flight after a stop/start) and stated, as a future
 * invariant, that it must not. The V1 fix (`coordinator.worker.start`) lets a loop start a round
 * only while no other loop's round for its shard is executing in the process, and refuses every
 * commit a stopped loop's round attempts. The future invariant is now an ordinary test, the
 * characterisation asserts the fixed behaviour, and the last group drives the loop itself.
 */

const leaderWorkers = require("../../src/workers/leaderWorkers");
const coordinatorSolvePath = require("../../src/workers/coordinatorSolvePath");
const coordinator = require("../../src/workers/coordinator.worker");
const planState = require("../../src/engine/shard/planState");
const intake = require("../../src/engine/intake/intake");
const round = require("../../src/engine/solve/round");
const leadership = require("../../src/engine/shard/leadership");
const fixture = require("./helpers/roundFixture");
const outboxWorker = require("../../src/workers/outbox.worker");
const reconcilerWorker = require("../../src/workers/reconciler.worker");
const timerWorker = require("../../src/workers/timer.worker");

const LEADING = Object.freeze({ mayRunRound: true });
const FOLLOWING = Object.freeze({ mayRunRound: false });
const WINDOW_MS = 500;

function context() {
  return {
    prisma: {},
    kv: { set: async () => true },
    io: {},
    values: new Map([
      ["dispatch.max_delivery_delay", 5],
      ["dispatch.retry_window", 30],
      ["dispatch.offer_ttl", 20],
      ["health.unresponsive_strikes", 3],
      ["dispatch.systemic_threshold", 0.5],
      ["dispatch.nack_cooloff", 5],
      ["reconciler.sweep_interval", 10],
      ["sla.assignment_deadline", 600],
      ["energy.deviation_tolerance", 0.2],
      ["supervise.max_timer_lag", 30],
      ["recover.max_reassignments_per_leg", 3],
      ["recover.incumbent_cooloff", 300],
      ["recover.reassign_budget", 900],
      ["execute.eta_tolerance", 1.3],
      ["solve.window_min", WINDOW_MS],
    ]),
    shardId: "shard-a",
    instanceId: "host:1",
    runInTransaction: async (fn) => fn({}),
    deliver: async () => ({ delivered: true }),
    record: () => {},
    logger: { info() {}, warn() {}, error() {} },
  };
}

/**
 * A minimal assembly whose `prisma` parks each round at `SELECT NOW()` until released, and
 * counts how many rounds are parked at once.
 */
function gatedAssembly() {
  const parked = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let rounds = 0;
  const prisma = {
    async $queryRawUnsafe(sql) {
      if (/SELECT NOW\(\)/i.test(sql)) {
        rounds += 1;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => parked.push(resolve));
        inFlight -= 1;
        // The round then fails on its next store call, which the worker contains.
        throw new Error("gated test store: round released");
      }
      throw new Error(`gated test store: unexpected ${sql}`);
    },
  };
  return {
    assembly: { ok: true, satisfied: [], missing: [], missingByClass: {}, context: { expansionWallClockBudgetMs: 2000 }, deps: { prisma, record: () => {} } },
    releaseAll: () => parked.splice(0).forEach((resolve) => resolve()),
    stats: () => ({ inFlight, maxInFlight, rounds }),
  };
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ["nextTick", "queueMicrotask"] });
  for (const worker of [outboxWorker, reconcilerWorker, timerWorker]) {
    jest.spyOn(worker, "start").mockImplementation(() => ({ stop() {} }));
  }
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

async function restartDuringRound() {
  const gate = gatedAssembly();
  const create = jest.spyOn(coordinatorSolvePath, "create").mockReturnValue(gate.assembly);
  const lifecycle = leaderWorkers.create(context());

  expect(lifecycle.apply(LEADING).running).toContain("coordinator");
  await jest.advanceTimersByTimeAsync(WINDOW_MS);
  const afterFirst = gate.stats();

  // A stale supervisor tick resolves with a follower verdict, then a leader tick follows —
  // the sequence Step 0 measured 64–68 times per run at 110 ms.
  lifecycle.apply(FOLLOWING);
  lifecycle.apply(LEADING);
  await jest.advanceTimersByTimeAsync(WINDOW_MS);
  const afterRestart = gate.stats();

  gate.releaseAll();
  await jest.advanceTimersByTimeAsync(10);
  lifecycle.stop();
  return { afterFirst, afterRestart, composed: create.mock.calls.length };
}

describe("GROUP 4 — a coordinator round in flight across a LEADER_ONLY stop/start", () => {
  test("sanity: one coordinator never overlaps its own rounds (its inFlight guard holds)", async () => {
    const gate = gatedAssembly();
    jest.spyOn(coordinatorSolvePath, "create").mockReturnValue(gate.assembly);
    const lifecycle = leaderWorkers.create(context());
    lifecycle.apply(LEADING);
    await jest.advanceTimersByTimeAsync(WINDOW_MS * 6);
    expect(gate.stats()).toMatchObject({ inFlight: 1, maxInFlight: 1, rounds: 1 });
    gate.releaseAll();
    await jest.advanceTimersByTimeAsync(10);
    lifecycle.stop();
  });

  test("stopAll leaves the round in flight to finish, and startAll's new coordinator does not start a second one beside it", async () => {
    // Defective loop: { inFlight: 2, maxInFlight: 2, rounds: 2 } after the restart.
    const run = await restartDuringRound();
    expect(run.afterFirst).toMatchObject({ inFlight: 1, rounds: 1 });
    expect(run.composed).toBe(2);
    expect(run.afterRestart).toMatchObject({ inFlight: 1, maxInFlight: 1, rounds: 1 });
  });

  test("no two coordinator rounds for one shard are ever in flight in one process", async () => {
    const run = await restartDuringRound();
    expect(run.afterRestart.maxInFlight).toBeLessThanOrEqual(1);
  });

  test("once the superseded round has finished, the new coordinator runs its own", async () => {
    const gate = gatedAssembly();
    jest.spyOn(coordinatorSolvePath, "create").mockReturnValue(gate.assembly);
    const lifecycle = leaderWorkers.create(context());
    lifecycle.apply(LEADING);
    await jest.advanceTimersByTimeAsync(WINDOW_MS);
    lifecycle.apply(FOLLOWING);
    lifecycle.apply(LEADING);
    await jest.advanceTimersByTimeAsync(WINDOW_MS * 4);
    expect(gate.stats()).toMatchObject({ inFlight: 1, rounds: 1 });

    gate.releaseAll();
    await jest.advanceTimersByTimeAsync(WINDOW_MS * 2);
    expect(gate.stats()).toMatchObject({ inFlight: 1, maxInFlight: 1, rounds: 2 });

    gate.releaseAll();
    await jest.advanceTimersByTimeAsync(10);
    lifecycle.stop();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   The loop itself (`coordinator.worker.start`): a stopped loop's round may not commit
   ═══════════════════════════════════════════════════════════════════════════ */

describe("V1 E — coordinator loop lifecycle", () => {
  const NOW = new Date("2026-08-05T12:00:00.000Z");
  const SHARD = leadership.DEFAULT_SHARD_ID;
  const CONFIG = {
    windowMinMs: WINDOW_MS,
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

  /** An in-memory store holding one queued Leg, under a lease this process holds (B3's world). */
  async function world() {
    const prisma = fixture.memoryPrisma();
    prisma.$queryRawUnsafe = async (sql) => {
      if (sql.includes("NOW()")) return [{ now: NOW }];
      if (sql.includes("ShardLeadership")) {
        return [{ shardId: SHARD, leadershipFence: "7", holder: "instance-1", leaseExpiry: new Date(NOW.getTime() + 60_000) }];
      }
      return [];
    };
    prisma.commitment = { count: async () => 0 };
    prisma.leg = { findMany: async () => [], updateMany: async () => ({ count: 0 }) };
    prisma.$transaction = async (fn) => fn(prisma);
    await prisma.workQueue.create({
      data: {
        legId: "L1",
        shardId: SHARD,
        idempotencyKey: "k-L1",
        purpose: "PRIMARY",
        slaClass: "standard",
        priority: 0,
        state: intake.QUEUE_STATE.QUEUED,
        version: 0,
        roundsConsidered: 0,
        consecutiveDeferrals: 0,
        enqueuedAt: new Date(NOW.getTime() - 1000),
      },
    });
    return prisma;
  }

  /**
   * `round.execute` parked until released, then committing one pairing through the loop's
   * `commit` and throwing — the worker returns the batch to the queue, as on any throw.
   */
  function parkedExecute() {
    const parked = [];
    const outcomes = [];
    let inFlight = 0;
    let maxInFlight = 0;
    jest.spyOn(round, "execute").mockImplementation(async (deps, input) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => parked.push(resolve));
      outcomes.push(await deps.commit({ legId: input.legs[0].legId, agentId: "agent-1" }, { roundId: input.roundId }));
      inFlight -= 1;
      throw new Error("parked execute: done");
    });
    return { releaseAll: () => parked.splice(0).forEach((resolve) => resolve()), outcomes, stats: () => ({ inFlight, maxInFlight }) };
  }

  async function startLoop(prisma, commits, recorded) {
    return coordinator.start(
      {
        prisma,
        planState: planState.create({ shardId: SHARD }),
        expandCandidates: async () => ({ candidates: [], achievedGapMilliCU: 0n, problems: [] }),
        pricedCandidateFor: () => null,
        commit: async (assignment) => {
          commits.push(assignment);
          return { committed: true, outcome: "COMMITTED", commitment: { commitmentId: "c-1" } };
        },
        record: (event, detail) => recorded.push({ event, detail }),
      },
      { shardId: SHARD, config: CONFIG, feasibleSupply: 3, nowMs: NOW.getTime(), instanceId: "instance-1", tickMs: WINDOW_MS },
    );
  }

  test("a running loop's round commits through to the composition's commit", async () => {
    const prisma = await world();
    const exec = parkedExecute();
    const commits = [];
    const loop = await startLoop(prisma, commits, []);
    await jest.advanceTimersByTimeAsync(WINDOW_MS);
    exec.releaseAll();
    await jest.advanceTimersByTimeAsync(10);
    loop.stop();

    expect(commits).toHaveLength(1);
    expect(exec.outcomes[0]).toMatchObject({ committed: true });
  });

  test("a loop stopped while its round is in flight: the round finishes, and its commit is refused before reaching the composition", async () => {
    const prisma = await world();
    const exec = parkedExecute();
    const commits = [];
    const recorded = [];
    const loop = await startLoop(prisma, commits, recorded);
    await jest.advanceTimersByTimeAsync(WINDOW_MS);
    expect(exec.stats().inFlight).toBe(1);

    loop.stop();
    exec.releaseAll();
    await jest.advanceTimersByTimeAsync(10);

    expect(commits).toEqual([]);
    expect(exec.outcomes).toEqual([
      expect.objectContaining({ committed: false, outcome: "ABORTED", reason: coordinator.COORDINATOR_STOPPED }),
    ]);
    // The round's own throw path ran: the claim went back to the queue.
    expect(prisma.__tables.workQueue[0]).toMatchObject({ state: intake.QUEUE_STATE.QUEUED, claimedByRoundId: null });
    expect(recorded.map((entry) => entry.event)).toContain("coordinator.round_failed");
  });

  test("a new loop for the same shard defers while the old loop's round runs, then runs its own — never two at once", async () => {
    const prisma = await world();
    const exec = parkedExecute();
    const oldCommits = [];
    const newCommits = [];
    const recorded = [];
    const oldLoop = await startLoop(prisma, oldCommits, recorded);
    await jest.advanceTimersByTimeAsync(WINDOW_MS);
    oldLoop.stop();
    const newLoop = await startLoop(prisma, newCommits, recorded);
    await jest.advanceTimersByTimeAsync(WINDOW_MS * 4);

    expect(round.execute).toHaveBeenCalledTimes(1);
    expect(recorded.filter((entry) => entry.event === "coordinator.round_deferred")).toHaveLength(1);

    exec.releaseAll();
    await jest.advanceTimersByTimeAsync(WINDOW_MS * 2);
    expect(round.execute).toHaveBeenCalledTimes(2);
    exec.releaseAll();
    await jest.advanceTimersByTimeAsync(10);
    newLoop.stop();

    expect(exec.stats().maxInFlight).toBe(1);
    expect(oldCommits).toEqual([]);
    expect(newCommits).toHaveLength(1);
  });
});
