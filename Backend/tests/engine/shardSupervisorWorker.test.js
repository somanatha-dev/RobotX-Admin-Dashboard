"use strict";

/**
 * Engine lane — Phase 13: the shard supervisor (§19.2, §19.3, §19.5).
 *
 * The plan's row names three jobs — "lease renewal, failover detection, membership
 * migration one agent at a time" — and the tests below are organised around the ordering
 * that makes them safe rather than merely present:
 *
 *   1. Renewal decides whether this process leads at all.
 *   2. Failover decides whether it may *act*.
 *   3. Sizing and migration are actions, and neither runs for a session that failed 1 or 2.
 *
 * A supervisor that ran any action before renewal would act on a leadership belief one tick
 * out of date, which over a lease duration is the whole vulnerability window §19.5 is
 * written about.
 */

const election = require("../../src/engine/shard/election");
const shardSupervisor = require("../../src/workers/shardSupervisor.worker");
const { createCommitmentStore, fixture } = require("./helpers/commitmentStore");

const SHARD_LEASE_SECONDS = 5;
const SKEW_MS = 500;
const ROUND_TRIP_MS = 500;
const NOW = new Date("2026-07-29T12:00:00.000Z");

function seeded(options) {
  const settings = options || {};
  const seed = fixture({ legs: 1 });
  const store = createCommitmentStore({
    agent: [seed.agent],
    leg: seed.legs,
    shardLeadership: [{ ...seed.leadership, shardId: "shard-a", holder: null, leaseExpiry: null }],
    shard: [
      {
        id: "s-a",
        shardId: "shard-a",
        regionId: "region-a",
        state: "ACTIVE",
        drainingSince: null,
        agentCount: settings.agentCount === undefined ? 1 : settings.agentCount,
        bindingBound: "NEITHER_EVALUATED",
      },
      { id: "s-b", shardId: "shard-b", regionId: "region-b", state: "ACTIVE", drainingSince: null, agentCount: 0, bindingBound: "NEITHER_EVALUATED" },
    ],
    shardMembership: [
      {
        id: "m-1",
        agentId: seed.agent.id,
        shardId: "shard-a",
        fromShardId: null,
        movedAt: NOW,
        supersededAt: null,
        authorityEpochBefore: seed.agent.authorityEpoch,
        authorityEpochAfter: seed.agent.authorityEpoch,
        reason: "COMMISSIONING",
        movedBy: "seed",
      },
    ],
  });
  return { seed, store };
}

function deps(store, overrides) {
  return {
    prisma: store.client,
    store: election.postgresLeadershipStore(store.client, { replicationPosture: "SYNCHRONOUS_QUORUM" }),
    runSerializable: (client, fn) => client.$transaction(fn),
    selectForUpdate: async (tx, table, column, value) => {
      const rows = await tx.$queryRawUnsafe(`SELECT * FROM "${table}" WHERE "${column}" = $1 FOR UPDATE`, value);
      return rows.length > 0 ? rows[0] : null;
    },
    reconcile: async () => ({ total: 0, results: [] }),
    ...(overrides || {}),
  };
}

function context(store, overrides) {
  return {
    shardId: "shard-a",
    candidateId: "coordinator-a",
    storeTime: store.now(),
    leaseDurationSeconds: SHARD_LEASE_SECONDS,
    maxClockSkewMillis: SKEW_MS,
    storeRoundTripMillis: ROUND_TRIP_MS,
    ...(overrides || {}),
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   Pass 1 — renewal
   ═══════════════════════════════════════════════════════════════════════════ */

describe("renewalPass — hold the lease, take it, or let it go", () => {
  test("a follower stands for election and acquires an unheld shard", async () => {
    const { store } = seeded();
    const outcome = await shardSupervisor.renewalPass(deps(store), context(store));
    expect(outcome.transition).toBe("ACQUIRED");
    expect(outcome.session.state).toBe(election.LEADERSHIP_STATE.LEADER);
  });

  test("a follower that loses stays a follower and says why", async () => {
    const { store } = seeded();
    await shardSupervisor.renewalPass(deps(store), context(store));
    const other = await shardSupervisor.renewalPass(deps(store), context(store, { candidateId: "coordinator-b" }));
    expect(other.transition).toBe("STILL_FOLLOWER");
    expect(other.session.lastRefusal).toBe(election.CAS_REFUSAL.HELD_BY_ANOTHER);
  });

  test("a leader renews without advancing the fence", async () => {
    const { store } = seeded();
    const first = await shardSupervisor.renewalPass(deps(store), context(store));
    store.advanceClock(1);
    const second = await shardSupervisor.renewalPass(deps(store), context(store, { session: first.session, storeTime: store.now() }));

    expect(second.transition).toBe("RENEWED");
    expect(second.session.leadershipFence).toBe(first.session.leadershipFence);
  });

  test("a leader that cannot renew steps down, and a stepping-down session releases rather than re-acquiring in the same tick", async () => {
    const { store } = seeded();
    const first = await shardSupervisor.renewalPass(deps(store), context(store));
    store.advanceClock(SHARD_LEASE_SECONDS + 1);

    const lost = await shardSupervisor.renewalPass(deps(store), context(store, { session: first.session, storeTime: store.now() }));
    expect(lost.transition).toBe("LOST_LEASE");
    expect(lost.session.state).toBe(election.LEADERSHIP_STATE.STEPPING_DOWN);

    const stoodDown = await shardSupervisor.renewalPass(deps(store), context(store, { session: lost.session, storeTime: store.now() }));
    expect(stoodDown.session.state).toBe(election.LEADERSHIP_STATE.FOLLOWER);
    // Not re-acquired in the same tick: advancing the fence twice for one leadership change
    // would give a standby no window at all.
    expect(stoodDown.session.leadershipFence).toBeNull();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   Pass 2 — failover, and the promotion it gates
   ═══════════════════════════════════════════════════════════════════════════ */

describe("failoverPass — §19.5's reconciliation before rounds", () => {
  test("a fresh leader reconciles, is promoted, and only then may commit", async () => {
    const { store } = seeded();
    const renewal = await shardSupervisor.renewalPass(deps(store), context(store));
    expect(renewal.session.mayCommit).toBe(false);

    const recovery = await shardSupervisor.failoverPass(deps(store), context(store, { session: renewal.session }));
    expect(recovery.ran).toBe(true);
    expect(recovery.result.complete).toBe(true);
    expect(recovery.session.mayCommit).toBe(true);
  });

  test("an incomplete reconciliation leaves the session un-promoted — the shard runs no round", async () => {
    const { store } = seeded();
    const renewal = await shardSupervisor.renewalPass(deps(store), context(store));

    // A sweep that keeps finding post-failover orphans and never clears them.
    const stuck = deps(store, {
      reconcile: async () => ({
        total: 1,
        results: [{ category: "ORPHAN_LEG", repaired: 1, counts: { EXPECTED_POST_FAILOVER: 1, DEFECT: 0 } }],
      }),
    });
    // A Leg the sweep never actually requeues, attributed to this shard by the `WorkQueue`
    // row that records intake's routing decision — the same record `legsInShard` reads.
    await store.client.leg.update({ where: { id: "leg-0" }, data: { state: "PLANNED" } });
    await store.client.workQueue.create({
      data: { id: "wq-0", legId: "leg-0", shardId: "shard-a", state: "CLAIMED", priority: 200, version: 0 },
    });

    const recovery = await shardSupervisor.failoverPass(stuck, context(store, { session: renewal.session, maxPasses: 2 }));
    expect(recovery.result.complete).toBe(false);
    expect(recovery.session.mayCommit).toBe(false);
  });

  test("the failover is recorded on the shard row whether or not it completed", async () => {
    const { store } = seeded();
    const renewal = await shardSupervisor.renewalPass(deps(store), context(store));
    await shardSupervisor.failoverPass(deps(store), context(store, { session: renewal.session }));

    const row = store.rows("shard").find((entry) => entry.shardId === "shard-a");
    expect(row.lastFailoverAt).toBeInstanceOf(Date);
    expect(row.roundsResumableAt).toBeInstanceOf(Date);
  });

  test("it does not run for a follower, and does not run twice for one leadership", async () => {
    const { store } = seeded();
    const follower = election.followerSession({ shardId: "shard-a", candidateId: "coordinator-a" });
    expect((await shardSupervisor.failoverPass(deps(store), context(store, { session: follower }))).ran).toBe(false);

    const renewal = await shardSupervisor.renewalPass(deps(store), context(store));
    const first = await shardSupervisor.failoverPass(deps(store), context(store, { session: renewal.session }));
    const second = await shardSupervisor.failoverPass(deps(store), context(store, { session: first.session }));
    expect(second.ran).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   Pass 3 — sizing
   ═══════════════════════════════════════════════════════════════════════════ */

describe("sizingPass — both bounds, recorded by the single writer", () => {
  test("a leader records the binding bound and both evaluations", async () => {
    const { store } = seeded({ agentCount: 5000 });
    const renewal = await shardSupervisor.renewalPass(deps(store), context(store));
    const recovery = await shardSupervisor.failoverPass(deps(store), context(store, { session: renewal.session }));

    const evaluation = await shardSupervisor.sizingPass(
      deps(store),
      context(store, {
        session: recovery.session,
        config: {
          missionRatePerAgentHour: 4,
          txnPerMissionLifecycle: 2.05,
          commitTxnServiceTimeMs: 5,
          maxSerialUtilisation: 0.25,
          roundWallClockBudgetMs: 250,
        },
        measurement: { roundWallClockP99Ms: 200, samples: 500 },
      }),
    );

    expect(evaluation.bindingBound).toBe("ROUND_WALL_CLOCK");
    const row = store.rows("shard").find((entry) => entry.shardId === "shard-a");
    expect(row.bindingBound).toBe("ROUND_WALL_CLOCK");
    expect(Object.keys(row.sizingDetail.bounds)).toHaveLength(2);
  });

  test("it evaluates the **observed** membership, not the configured maximum", async () => {
    const { store } = seeded({ agentCount: 30000 });
    const renewal = await shardSupervisor.renewalPass(deps(store), context(store));
    const recovery = await shardSupervisor.failoverPass(deps(store), context(store, { session: renewal.session }));

    const evaluation = await shardSupervisor.sizingPass(
      deps(store),
      context(store, {
        session: recovery.session,
        config: { missionRatePerAgentHour: 4, txnPerMissionLifecycle: 2.05, commitTxnServiceTimeMs: 5, maxSerialUtilisation: 0.25 },
        measurement: {},
      }),
    );

    // 30 000 agents at the default rate exceeds the ≈ 21 950 the inequality admits.
    expect(evaluation.bindingBound).toBe("SERIAL_COMMIT");
    expect(evaluation.rebalanceIndicated).toBe(true);
  });

  test("a follower records nothing — two coordinators writing one shard's row is what §19.3 forbids", async () => {
    const { store } = seeded();
    const follower = election.followerSession({ shardId: "shard-a", candidateId: "coordinator-a" });
    expect(await shardSupervisor.sizingPass(deps(store), context(store, { session: follower }))).toBeNull();
    expect(store.rows("shard").find((entry) => entry.shardId === "shard-a").bindingBound).toBe("NEITHER_EVALUATED");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   Pass 4 — migration, one per tick
   ═══════════════════════════════════════════════════════════════════════════ */

describe("migrationPass — §19.2's pacing", () => {
  const SIGNING_KEY = "a-signing-key-long-enough-for-§23.3-to-accept-it";

  async function committingLeader(store) {
    const renewal = await shardSupervisor.renewalPass(deps(store), context(store));
    const recovery = await shardSupervisor.failoverPass(deps(store), context(store, { session: renewal.session }));
    return recovery.session;
  }

  test("**at most one agent moves per tick**, however long the plan is", async () => {
    const { seed, store } = seeded();
    const session = await committingLeader(store);

    const outcome = await shardSupervisor.migrationPass(
      deps(store),
      context(store, {
        session,
        plan: {
          moves: [
            { agentId: seed.agent.id, targetShardId: "shard-b", reason: "REBALANCE_MERGE" },
            { agentId: "another", targetShardId: "shard-b", reason: "REBALANCE_MERGE" },
            { agentId: "a-third", targetShardId: "shard-b", reason: "REBALANCE_MERGE" },
          ],
        },
        commandTtlSeconds: 60,
        signingKey: SIGNING_KEY,
      }),
    );

    expect(shardSupervisor.MIGRATIONS_PER_TICK).toBe(1);
    expect(outcome.outcomes).toHaveLength(1);
    expect(outcome.migrated).toBe(1);
    expect(outcome.remaining).toBe(2);
  });

  test("the pace is respected — a tick too soon after the last migration moves nothing", async () => {
    const { seed, store } = seeded();
    const session = await committingLeader(store);

    const outcome = await shardSupervisor.migrationPass(
      deps(store),
      context(store, {
        session,
        plan: { moves: [{ agentId: seed.agent.id, targetShardId: "shard-b", reason: "REBALANCE_MERGE" }] },
        lastMigrationAtMs: store.now().getTime() - 500,
        minIntervalMs: 2000,
        commandTtlSeconds: 60,
        signingKey: SIGNING_KEY,
      }),
    );

    expect(outcome.migrated).toBe(0);
    expect(outcome.skipped).toBe("PACED");
    expect(store.rows("outbox")).toEqual([]);
  });

  test("a session that may not commit migrates nothing — a rebalance is a write", async () => {
    const { seed, store } = seeded();
    const renewal = await shardSupervisor.renewalPass(deps(store), context(store));

    const outcome = await shardSupervisor.migrationPass(
      deps(store),
      context(store, {
        // Un-promoted: reconciliation has not completed.
        session: renewal.session,
        plan: { moves: [{ agentId: seed.agent.id, targetShardId: "shard-b", reason: "REBALANCE_MERGE" }] },
        commandTtlSeconds: 60,
        signingKey: SIGNING_KEY,
      }),
    );

    expect(outcome.migrated).toBe(0);
    expect(outcome.skipped).toBe("NOT_A_COMMITTING_LEADER");
  });

  test("an absent plan is not an error — the supervisor does not choose which agents move", async () => {
    const { store } = seeded();
    const session = await committingLeader(store);
    const tick = await shardSupervisor.runOnce(deps(store), context(store, { session }));
    expect(tick.migration.skipped).toBe("NO_PLAN");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   The tick, the advisory hint, and the drain
   ═══════════════════════════════════════════════════════════════════════════ */

describe("runOnce — the four passes in order", () => {
  test("one tick takes the shard, reconciles it, and reports that a round may run", async () => {
    const { store } = seeded();
    const tick = await shardSupervisor.runOnce(deps(store), context(store));

    expect(tick.transition).toBe("ACQUIRED");
    expect(tick.failoverRan).toBe(true);
    expect(tick.mayRunRound).toBe(true);
  });

  test("a tick that loses the lease reports that no round may run", async () => {
    const { store } = seeded();
    const first = await shardSupervisor.runOnce(deps(store), context(store));
    store.advanceClock(SHARD_LEASE_SECONDS + 1);
    const second = await shardSupervisor.runOnce(deps(store), context(store, { session: first.session, storeTime: store.now() }));

    expect(second.transition).toBe("LOST_LEASE");
    expect(second.mayRunRound).toBe(false);
  });
});

describe("the advisory leadership hint (§3.3)", () => {
  test("it is published to `engine:shard:leader:{shardId}` with a TTL", async () => {
    const { store } = seeded();
    const writes = [];
    const kv = { set: async (key, value, options) => writes.push({ key, value, options }) };

    const tick = await shardSupervisor.runOnce({ ...deps(store), kv }, context(store));
    expect(tick.leaderHintPublished).toBe(true);
    expect(writes[0].key).toBe("engine:shard:leader:shard-a");
    expect(writes[0].options.ex).toBe(shardSupervisor.LEADER_HINT_TTL_SECONDS);
    expect(JSON.parse(writes[0].value)).toMatchObject({ shardId: "shard-a", holder: "coordinator-a", mayCommit: true });
  });

  test("a cache failure costs visibility and never correctness", async () => {
    const { store } = seeded();
    const kv = { set: async () => { throw new Error("redis down"); } };

    const tick = await shardSupervisor.runOnce({ ...deps(store), kv }, context(store));
    expect(tick.leaderHintPublished).toBe(false);
    // The leadership itself is unaffected.
    expect(tick.mayRunRound).toBe(true);
  });

  // §18.5 rule 3's argument, applied to this worker: a supervisor that cached its own
  // leadership and then trusted the cache would have promoted the cache to an authority
  // over the one fact §19.3 is least able to tolerate being wrong about.
  test("the worker never **reads** the hint back", () => {
    const source = require("fs").readFileSync(require.resolve("../../src/workers/shardSupervisor.worker.js"), "utf8");
    expect(source).not.toMatch(/kv\.get|kv\.mget/);
  });
});

describe("the shutdown drain (§19.3)", () => {
  test("draining releases the lease and advances the fence, so a standby takes over at once", async () => {
    const { store } = seeded();
    const tick = await shardSupervisor.runOnce(deps(store), context(store));

    const drained = await shardSupervisor.drain(deps(store), tick.session, { storeTime: store.now() });
    expect(drained.released).toBe(true);
    expect(store.rows("shardLeadership")[0].holder).toBeNull();

    const standby = await shardSupervisor.runOnce(deps(store), context(store, { candidateId: "coordinator-b" }));
    expect(standby.transition).toBe("ACQUIRED");
  });

  test("draining a follower is a no-op that reports itself", async () => {
    const { store } = seeded();
    const follower = election.followerSession({ shardId: "shard-a", candidateId: "coordinator-a" });
    expect(await shardSupervisor.drain(deps(store), follower, { storeTime: store.now() })).toMatchObject({ released: false, refusal: "NOT_LEADER" });
  });
});

describe("start() — the store is asserted once, at start", () => {
  test("a store that cannot provide §19.5's guarantee is refused at start, not per tick", () => {
    const { store } = seeded();
    const unsafe = election.postgresLeadershipStore(store.client, { replicationPosture: "ASYNCHRONOUS_FAILOVER" });
    expect(() => shardSupervisor.start({ prisma: store.client, store: unsafe }, context(store))).toThrow(
      /No leader election over a non-consensus store/,
    );
  });

  test("a started loop is stoppable and exposes its session for the drain", async () => {
    const { store } = seeded();
    const handle = shardSupervisor.start(deps(store), { ...context(store), intervalMs: 60000 });
    expect(typeof handle.stop).toBe("function");
    expect(handle.session().state).toBe(election.LEADERSHIP_STATE.FOLLOWER);
    handle.stop();
  });
});

describe("socket messages", () => {
  test("a leadership change produces `SHARD_LEADERSHIP_CHANGED`, with the fence as a string", async () => {
    const { store } = seeded();
    const tick = await shardSupervisor.runOnce(deps(store), context(store));
    const messages = shardSupervisor.socketMessages(tick);

    expect(messages[0].event).toBe("SHARD_LEADERSHIP_CHANGED");
    expect(messages[0].payload).toMatchObject({ shardId: "shard-a", holder: "coordinator-a", transition: "ACQUIRED" });
    expect(typeof messages[0].payload.leadershipFence).toBe("string");
  });

  test("a renewal produces no message — a dashboard told every tick that nothing changed learns nothing", async () => {
    const { store } = seeded();
    const first = await shardSupervisor.runOnce(deps(store), context(store));
    store.advanceClock(1);
    const second = await shardSupervisor.runOnce(deps(store), context(store, { session: first.session, storeTime: store.now() }));
    expect(shardSupervisor.socketMessages(second)).toEqual([]);
  });

  // §11.1 — a command reaches its agent through the outbox and the drain worker, never
  // through a broadcast.
  test("`SHARD_MIGRATE` is **not** among the socket messages — it is an outbox command", () => {
    const source = require("fs").readFileSync(require.resolve("../../src/workers/shardSupervisor.worker.js"), "utf8");
    const messages = source.slice(source.indexOf("function socketMessages"), source.indexOf("function start"));
    expect(messages).not.toMatch(/event: "SHARD_MIGRATE"/);
    expect(messages).toMatch(/SHARD_MIGRATED/);
  });

  test("the worker takes no Socket.IO dependency", () => {
    const source = require("fs").readFileSync(require.resolve("../../src/workers/shardSupervisor.worker.js"), "utf8");
    expect(source).not.toMatch(/socket\.io|require\(["']socket/);
    expect(source).not.toMatch(/\bio\.(to|emit)\b/);
  });
});
