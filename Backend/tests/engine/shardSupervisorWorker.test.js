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

/** `fixture()`'s agent id, named so a plan can be built before the store exists. */
const AGENT_ID = "agent-1";
/** `extraMembers()`'s ids, for the same reason. */
const EXTRA_AGENT_IDS = ["agent-extra-0", "agent-extra-1"];

/**
 * PHASE 13 REMEDIATION — extra members in `shard-a`, so a plan longer than one move has
 * agents that are genuinely current members of the source shard.
 *
 * `shardModel.outstandingMoves()` derives what is left to do from **current membership**
 * rather than from a counter, which is what makes execution crash-safe and idempotent. A
 * fixture that named agents with no membership row would therefore exercise the
 * already-resolved branch rather than the migration branch.
 *
 * @param {number} count
 * @returns {{ agents: object[], memberships: object[] }}
 */
function extraMembers(count) {
  const agents = [];
  const memberships = [];
  for (let index = 0; index < count; index += 1) {
    const id = `agent-extra-${index}`;
    agents.push({ id, agentId: id, lifecycleState: "ACTIVE", authorityEpoch: 3n, fenceCounter: 11n, capacityOverride: null });
    memberships.push({
      id: `m-extra-${index}`,
      agentId: id,
      shardId: "shard-a",
      fromShardId: null,
      movedAt: NOW,
      supersededAt: null,
      authorityEpochBefore: 3n,
      authorityEpochAfter: 3n,
      reason: "COMMISSIONING",
      movedBy: "seed",
    });
  }
  return { agents, memberships };
}

function seeded(options) {
  const settings = options || {};
  const seed = fixture({ legs: 1 });
  const extra = extraMembers(settings.extraMembers || 0);
  const store = createCommitmentStore({
    agent: [seed.agent, ...extra.agents],
    leg: seed.legs,
    shardRebalance: settings.rebalance ? [settings.rebalance] : [],
    shardLeadership: [{ ...seed.leadership, shardId: "shard-a", holder: null, leaseExpiry: null }],
    shard: [
      {
        id: "s-a",
        shardId: "shard-a",
        regionId: "region-a",
        state: "ACTIVE",
        drainingSince: null,
        agentCount: settings.agentCount === undefined ? 1 + (settings.extraMembers || 0) : settings.agentCount,
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
      ...extra.memberships,
    ],
  });
  return { seed, store, extraAgentIds: extra.agents.map((agent) => agent.id) };
}

/**
 * A durable `ShardRebalance` row shaped as `shardModel.openRebalance()` writes one.
 *
 * @param {object} overrides
 * @returns {object}
 */
function rebalanceRow(overrides) {
  const settings = overrides || {};
  const moves = settings.moves || [];
  return {
    id: settings.id || "rb-1",
    sourceShardId: "shard-a",
    targetShardId: "shard-b",
    state: "PENDING",
    reason: "REBALANCE_MERGE",
    restoreState: "ACTIVE",
    plan: { moves, surplus: moves.length, note: "test plan" },
    plannedMoves: moves.length,
    completedMoves: 0,
    blocked: null,
    requestedBy: "operator-1",
    requestedAt: NOW,
    startedAt: null,
    lastMoveAt: null,
    closedAt: null,
    closedReason: null,
    detail: null,
    ...settings,
  };
}

/** One planned move, in the shape `membership.planRebalance()` emits. */
function move(agentId, overrides) {
  return {
    order: 0,
    agentId,
    fromShardId: "shard-a",
    targetShardId: "shard-b",
    reason: "REBALANCE_MERGE",
    liveCommitments: 0,
    allowCustodyTransfer: false,
    ...(overrides || {}),
  };
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

  const credentials = { commandTtlSeconds: 60, signingKey: SIGNING_KEY };

  /**
   * PHASE 13 REMEDIATION (P13-R4) — every test below drives the pass through the **durable
   * intent** rather than through an injected `settings.plan`.
   *
   * The injected form is gone, and its removal is the point rather than a refactor: nothing
   * in production ever set `settings.plan`, so `migrationPass` returned `NO_PLAN` on every
   * tick of every deployment while `POST /api/shards/:id/rebalance` moved shards to
   * DRAINING and returned plans into HTTP response bodies that were their only copy. Thirty-
   * two tests passed against a plan source that did not exist. These now seed the row the
   * controller writes.
   */
  test("**at most one agent moves per tick**, however long the plan is", async () => {
    const { seed, store } = seeded({
      extraMembers: 2,
      rebalance: rebalanceRow({
        moves: [move(AGENT_ID), move(EXTRA_AGENT_IDS[0], { order: 1 }), move(EXTRA_AGENT_IDS[1], { order: 2 })],
      }),
    });
    const session = await committingLeader(store);

    const outcome = await shardSupervisor.migrationPass(deps(store), context(store, { session, ...credentials }));

    expect(shardSupervisor.MIGRATIONS_PER_TICK).toBe(1);
    expect(outcome.outcomes).toHaveLength(1);
    expect(outcome.migrated).toBe(1);
    expect(outcome.remaining).toBe(2);
    // The intent advanced with it, and only once.
    const row = store.rows("shardRebalance")[0];
    expect(row).toMatchObject({ state: "EXECUTING", completedMoves: 1 });
    expect(row.lastMoveAt).toEqual(store.now());
  });

  test("the pace is respected, timed from the **durable** last move rather than from memory", async () => {
    const { seed, store } = seeded({
      rebalance: rebalanceRow({
        moves: [move(AGENT_ID)],
        state: "EXECUTING",
        startedAt: new Date(NOW.getTime() - 500),
        // The row a previous process — or a previous leader — left behind.
        lastMoveAt: new Date(NOW.getTime() - 500),
      }),
    });
    const session = await committingLeader(store);

    const outcome = await shardSupervisor.migrationPass(
      deps(store),
      context(store, { session, minIntervalMs: 2000, ...credentials }),
    );

    expect(outcome.migrated).toBe(0);
    expect(outcome.skipped).toBe("PACED");
    expect(outcome.waitedMs).toBe(500);
    expect(store.rows("outbox")).toEqual([]);
  });

  test("a session that may not commit migrates nothing — a rebalance is a write", async () => {
    const { seed, store } = seeded({ rebalance: rebalanceRow({ moves: [move(AGENT_ID)] }) });
    const renewal = await shardSupervisor.renewalPass(deps(store), context(store));

    const outcome = await shardSupervisor.migrationPass(
      deps(store),
      // Un-promoted: reconciliation has not completed.
      context(store, { session: renewal.session, ...credentials }),
    );

    expect(outcome.migrated).toBe(0);
    expect(outcome.skipped).toBe("NOT_A_COMMITTING_LEADER");
    expect(store.rows("shardRebalance")[0].state).toBe("PENDING");
  });

  test("no open intent is not an error — the supervisor does not choose which agents move", async () => {
    const { store } = seeded();
    const session = await committingLeader(store);
    const tick = await shardSupervisor.runOnce(deps(store), context(store, { session, ...credentials }));
    expect(tick.migration.skipped).toBe("NO_OPEN_REBALANCE");
  });

  test("the migration pass runs on every tick — it is no longer gated on a settings key nothing sets", async () => {
    const { seed, store } = seeded({ rebalance: rebalanceRow({ moves: [move(AGENT_ID)] }) });
    // No `plan` anywhere in the context, which is exactly the production composition.
    // One tick acquires, reconciles, promotes, and migrates — because the pass now finds
    // the plan for itself instead of waiting for a settings key nothing sets.
    const tick = await shardSupervisor.runOnce(deps(store), context(store, credentials));
    expect(tick.migration.migrated).toBe(1);
    expect(store.rows("shardMembership").filter((row) => row.shardId === "shard-b" && row.supersededAt === null)).toHaveLength(1);

    // And the next tick terminalises it and restores the shard, still with no injected plan.
    const second = await shardSupervisor.runOnce(deps(store), context(store, { session: tick.session, ...credentials }));
    expect(second.migration.skipped).toBe("PLAN_EXHAUSTED");
    expect(store.rows("shardRebalance")[0].state).toBe("COMPLETED");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   Pass 4 continued — the rebalance lifecycle (§19.2), which is what P13-R4 was
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the rebalance intent terminates, and cannot strand a shard", () => {
  const SIGNING_KEY = "a-signing-key-long-enough-for-§23.3-to-accept-it";
  const credentials = { commandTtlSeconds: 60, signingKey: SIGNING_KEY };

  async function committingLeader(store) {
    const renewal = await shardSupervisor.renewalPass(deps(store), context(store));
    const recovery = await shardSupervisor.failoverPass(deps(store), context(store, { session: renewal.session }));
    return recovery.session;
  }

  /** Drive ticks until the intent is terminal or the bound is reached. */
  async function drive(store, session, ticks) {
    let last = null;
    for (let index = 0; index < (ticks || 6); index += 1) {
      // eslint-disable-next-line no-await-in-loop
      last = await shardSupervisor.migrationPass(deps(store), context(store, { session, ...credentials }));
      if (last.skipped === "PLAN_EXHAUSTED") break;
    }
    return last;
  }

  test("the last move completes the intent **and restores the shard**", async () => {
    const { seed, store } = seeded({
      agentCount: 1,
      rebalance: rebalanceRow({ moves: [move(AGENT_ID)] }),
    });
    // The state the endpoint would have left behind: a full drain.
    await store.client.shard.update({ where: { shardId: "shard-a" }, data: { state: "DRAINING", drainingSince: NOW } });
    const session = await committingLeader(store);

    await drive(store, session);

    const intent = store.rows("shardRebalance")[0];
    expect(intent.state).toBe("COMPLETED");
    expect(intent.closedAt).not.toBeNull();
    expect(intent.closedReason).toMatch(/restored to ACTIVE/);

    const shard = store.rows("shard").find((row) => row.shardId === "shard-a");
    expect(shard.state).toBe("ACTIVE");
    expect(shard.drainingSince).toBeNull();
  });

  test("a crash between the migration and its bookkeeping is resumed, and the agent is not moved twice", async () => {
    const { seed, store } = seeded({ rebalance: rebalanceRow({ moves: [move(AGENT_ID)] }) });
    await store.client.shard.update({ where: { shardId: "shard-a" }, data: { state: "DRAINING", drainingSince: NOW } });
    const session = await committingLeader(store);

    // The migration commits…
    const first = await shardSupervisor.migrationPass(deps(store), context(store, { session, ...credentials }));
    expect(first.migrated).toBe(1);

    // …and the process dies before the intent could be closed. Simulated by rewinding the
    // intent to exactly what it was before the bookkeeping: still open, still PENDING.
    await store.client.shardRebalance.updateMany({
      where: { id: "rb-1" },
      data: { state: "PENDING", completedMoves: 0, startedAt: null, lastMoveAt: null },
    });

    const resumed = await shardSupervisor.migrationPass(deps(store), context(store, { session, ...credentials }));

    // Nothing re-migrated: the agent is no longer a member of the source shard, so the
    // move is no longer outstanding. Progress is derived, not counted.
    expect(resumed.migrated).toBe(0);
    expect(resumed.skipped).toBe("PLAN_EXHAUSTED");
    expect(store.rows("shardRebalance")[0].state).toBe("COMPLETED");
    expect(store.rows("shard").find((row) => row.shardId === "shard-a").state).toBe("ACTIVE");
    // One migration, one command — not two.
    expect(store.rows("outbox").filter((row) => row.command === "SHARD_MIGRATE")).toHaveLength(1);
  });

  test("a target that stopped admitting members cancels the intent rather than retrying forever", async () => {
    const { seed, store } = seeded({ rebalance: rebalanceRow({ moves: [move(AGENT_ID)] }) });
    await store.client.shard.update({ where: { shardId: "shard-a" }, data: { state: "DRAINING", drainingSince: NOW } });
    // The target drains after the intent was opened — legal, and previously a permanent stall.
    await store.client.shard.update({ where: { shardId: "shard-b" }, data: { state: "DRAINING", drainingSince: NOW } });
    const session = await committingLeader(store);

    const outcome = await shardSupervisor.migrationPass(deps(store), context(store, { session, ...credentials }));

    expect(outcome.migrated).toBe(0);
    const intent = store.rows("shardRebalance")[0];
    expect(intent.state).toBe("CANCELLED");
    expect(intent.closedReason).toMatch(/TARGET_SHARD_DOES_NOT_ADMIT_MEMBERS/);
    // And the source shard is serving again rather than draining into nowhere.
    expect(store.rows("shard").find((row) => row.shardId === "shard-a").state).toBe("ACTIVE");
  });

  test("an agent holding goods is retired from the plan, with the reason, so the intent still terminates", async () => {
    const { seed, store } = seeded({ rebalance: rebalanceRow({ moves: [move(AGENT_ID)] }) });
    await store.client.shard.update({ where: { shardId: "shard-a" }, data: { state: "DRAINING", drainingSince: NOW } });
    // A live commitment on a Leg whose goods are aboard. §2.5 makes the transfer accountable.
    await store.client.leg.update({ where: { id: "leg-0" }, data: { custodyState: "HELD" } });
    await store.client.commitment.create({
      data: { id: "c-1", commitmentId: "c-1", legId: "leg-0", agentId: AGENT_ID, agentCapacitySlot: 0, kind: "HARD", releasedAt: null, leadershipFence: 1n, fenceCounter: 41n, authorityEpoch: 7n, leaseExpiry: new Date(NOW.getTime() + 60000) },
    });
    const session = await committingLeader(store);

    const first = await shardSupervisor.migrationPass(deps(store), context(store, { session, ...credentials }));
    expect(first.outcomes[0].refusal).toBe("AGENT_HOLDS_CUSTODY");
    expect(store.rows("shardRebalance")[0].blocked.agentIds).toEqual([seed.agent.id]);

    // The next tick finds nothing outstanding — the blocked move is retired, not retried —
    // so the intent terminates and the shard serves again.
    const second = await shardSupervisor.migrationPass(deps(store), context(store, { session, ...credentials }));
    expect(second.skipped).toBe("PLAN_EXHAUSTED");
    expect(store.rows("shardRebalance")[0].state).toBe("COMPLETED");
    expect(store.rows("shardRebalance")[0].closedReason).toMatch(/1 retired unmoved/);
    expect(store.rows("shard").find((row) => row.shardId === "shard-a").state).toBe("ACTIVE");
    // The agent did not move, which is the whole point of refusing.
    expect(store.rows("outbox")).toEqual([]);
  });

  test("**a superseded leader cannot migrate** — the fence is re-read inside the handoff transaction", async () => {
    const { seed, store } = seeded({ rebalance: rebalanceRow({ moves: [move(AGENT_ID)] }) });
    const session = await committingLeader(store);

    // Another coordinator takes the shard. The lease lapses first, so this is an ordinary
    // failover rather than a theft.
    store.advanceClock(SHARD_LEASE_SECONDS + 1);
    const successor = await shardSupervisor.renewalPass(deps(store), context(store, { candidateId: "coordinator-b", storeTime: store.now() }));
    expect(successor.transition).toBe("ACQUIRED");

    // The old leader still believes it leads and still holds a promoted session.
    const outcome = await shardSupervisor.migrationPass(
      deps(store),
      context(store, { session, storeTime: store.now(), ...credentials }),
    );

    expect(outcome.migrated).toBe(0);
    expect(outcome.outcomes[0].refusal).toBe("LEADERSHIP_FENCE_ADVANCED_OR_HELD_BY_ANOTHER");
    // No authority_epoch advanced, no command enqueued, no membership row written.
    expect(store.rows("agent").find((row) => row.id === seed.agent.id).authorityEpoch).toBe(seed.agent.authorityEpoch);
    expect(store.rows("outbox")).toEqual([]);
    expect(store.rows("shardMembership").filter((row) => row.shardId === "shard-b")).toEqual([]);
    // And the intent is untouched, so the successor picks it up.
    expect(store.rows("shardRebalance")[0]).toMatchObject({ state: "PENDING", completedMoves: 0 });
  });

  test("the successor resumes the same intent — the plan survives a leadership handoff", async () => {
    const { seed, store } = seeded({
      extraMembers: 1,
      rebalance: rebalanceRow({ moves: [move(AGENT_ID), move(EXTRA_AGENT_IDS[0], { order: 1 })] }),
    });
    const first = await committingLeader(store);
    await shardSupervisor.migrationPass(deps(store), context(store, { session: first, ...credentials }));

    store.advanceClock(SHARD_LEASE_SECONDS + 1);
    const renewal = await shardSupervisor.renewalPass(deps(store), context(store, { candidateId: "coordinator-b", storeTime: store.now() }));
    const recovery = await shardSupervisor.failoverPass(deps(store), context(store, { session: renewal.session, storeTime: store.now() }));

    const outcome = await shardSupervisor.migrationPass(
      deps(store),
      context(store, { session: recovery.session, storeTime: store.now(), ...credentials }),
    );

    expect(outcome.migrated).toBe(1);
    expect(store.rows("shardRebalance")[0].completedMoves).toBe(2);
    expect(store.rows("shardMembership").filter((row) => row.shardId === "shard-b" && row.supersededAt === null)).toHaveLength(2);
  });

  test("an intent whose moves are already resolved closes on the first tick — no shard stays draining", async () => {
    // The exact durable state P13-R4 left behind, reconstructed: a DRAINING shard whose
    // plan names an agent that is no longer one of its members.
    const { store } = seeded({ rebalance: rebalanceRow({ moves: [move("agent-that-left")] }) });
    await store.client.shard.update({ where: { shardId: "shard-a" }, data: { state: "DRAINING", drainingSince: NOW } });
    const session = await committingLeader(store);

    const outcome = await shardSupervisor.migrationPass(deps(store), context(store, { session, ...credentials }));

    expect(outcome.skipped).toBe("PLAN_EXHAUSTED");
    expect(store.rows("shard").find((row) => row.shardId === "shard-a")).toMatchObject({ state: "ACTIVE", drainingSince: null });
  });

  test("without a signing key nothing is migrated, nothing is signed, and the intent stays cancellable", async () => {
    const { seed, store } = seeded({ rebalance: rebalanceRow({ moves: [move(AGENT_ID)] }) });
    const session = await committingLeader(store);

    const outcome = await shardSupervisor.migrationPass(
      deps(store),
      context(store, { session, commandTtlSeconds: 60 }),
    );

    expect(outcome.skipped).toBe("NO_COMMAND_CREDENTIALS");
    expect(outcome.detail).toMatch(/§23.3/);
    expect(store.rows("outbox")).toEqual([]);
    // Reported rather than thrown: a throw would be swallowed by the interval callback and
    // present as a supervisor that simply never migrates.
    expect(store.rows("shardRebalance")[0].state).toBe("PENDING");
  });

  test("a shard's supervisor reads only its own shard's intents", async () => {
    const { seed, store } = seeded({
      rebalance: rebalanceRow({ id: "rb-other", sourceShardId: "shard-b", targetShardId: "shard-a", moves: [move(AGENT_ID)] }),
    });
    const session = await committingLeader(store);

    const outcome = await shardSupervisor.migrationPass(deps(store), context(store, { session, ...credentials }));

    // `shard-a`'s leader must not execute `shard-b`'s rebalance, even though the agent it
    // names is one of `shard-a`'s members.
    expect(outcome.skipped).toBe("NO_OPEN_REBALANCE");
    expect(store.rows("shardRebalance")[0]).toMatchObject({ state: "PENDING", completedMoves: 0 });
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

/* ═══════════════════════════════════════════════════════════════════════════
   PHASE 13 REMEDIATION — the composition itself, not only the module.

   Every test above this block injects a complete dependency set, which is exactly
   why the production composition could be — and was — incomplete while all of them
   passed. `server.js` supplied four of the seven dependencies `start()` documents.
   The consequences, each reproduced before the fix:

     · no `leaseDurationSeconds` → `tryAcquire` throws RangeError from
       `clock.deadlineFrom`; no leader is ever elected and the fence never moves.
     · no `reconcile`            → `failover.run()` throws by design (§19.5);
       `election.promote()` is never reached and `mayCommit` stays false forever.
     · no `runSerializable` /
       `selectForUpdate`         → `membership.migrate()` cannot take the agent row
       under the commit path's lock; no migration can execute.

   A tick that throws is swallowed by `start()`'s `.catch` (correctly — one lost
   renewal must not take the process down), so none of these was ever visible as a
   failure. They are asserted here in two layers: the module refuses an incomplete
   composition at boot, and `server.js` is checked for actually supplying it.
   ═══════════════════════════════════════════════════════════════════════════ */

describe("start() — an incomplete composition is refused at boot, not swallowed per tick", () => {
  const cases = [
    ["reconcile", /reconcile \(§12\.4's sweep/],
    ["runSerializable", /runSerializable \(§19\.2's handoff/],
    ["selectForUpdate", /selectForUpdate \(§10\.3\.2 step 1's/],
  ];

  test.each(cases)("a composition missing `%s` is refused, naming what it is for", (key, message) => {
    const { store } = seeded();
    const incomplete = deps(store);
    delete incomplete[key];
    expect(() => shardSupervisor.start(incomplete, context(store))).toThrow(message);
  });

  test("a composition missing the store client is refused", () => {
    const { store } = seeded();
    const incomplete = deps(store);
    delete incomplete.prisma;
    expect(() => shardSupervisor.start(incomplete, context(store))).toThrow(/prisma \(the store client\)/);
  });

  test("a missing `shard.lease_duration` is refused, because without it no leader is ever elected", () => {
    const { store } = seeded();
    expect(() => shardSupervisor.start(deps(store), context(store, { leaseDurationSeconds: undefined }))).toThrow(
      /needs `shard\.lease_duration` as a positive number of seconds/,
    );
  });

  test("a non-positive lease duration is refused too", () => {
    const { store } = seeded();
    expect(() => shardSupervisor.start(deps(store), context(store, { leaseDurationSeconds: 0 }))).toThrow(RangeError);
  });

  // The store assertion must still come first: a store that cannot fence a leader is a
  // deployment error of a different and more serious kind, and it kept its own message.
  test("the consensus-store refusal still precedes the dependency check", () => {
    const { store } = seeded();
    const unsafe = election.postgresLeadershipStore(store.client, { replicationPosture: "ASYNCHRONOUS_FAILOVER" });
    expect(() => shardSupervisor.start({ prisma: store.client, store: unsafe }, context(store))).toThrow(
      /No leader election over a non-consensus store/,
    );
  });
});

describe("the production composition in server.js", () => {
  const source = require("fs").readFileSync(require.resolve("../../server.js"), "utf8");
  const call = source.slice(source.indexOf("shardSupervisor.start("), source.indexOf("logger.info(\"Shard coordinator standing for election\""));

  test("the call site is where the plan's Phase 13 row puts it, and it is reachable", () => {
    expect(call).toContain("shardSupervisor.start(");
    expect(source).toContain("const engineEnabled = cutoverEnabled.processEnabled();");
  });

  test.each([
    ["prisma"],
    ["store"],
    ["reconcile"],
    ["runSerializable"],
    ["selectForUpdate"],
  ])("`server.js` supplies the `%s` dependency", (key) => {
    expect(call).toMatch(new RegExp(`\\b${key}\\b`));
  });

  test.each([
    ["shard.lease_duration"],
    ["shard.renewal_interval"],
    ["time.max_clock_skew"],
    ["shard.store_round_trip_budget"],
    ["shard.migration_min_interval"],
  ])("`server.js` reads `%s` from the register rather than hard-coding it", (parameter) => {
    expect(call).toContain(`"${parameter}"`);
  });

  // §19.5's reconciliation must be *the* sweep, not a second implementation. `failover.js`
  // takes it injected precisely so the shard has one requeue path and one set of §4.5
  // timer obligations attached to it.
  test("the injected `reconcile` is §12.4's own sweep", () => {
    expect(call).toMatch(/reconciler\.sweep\(/);
    expect(source).toContain('require("./src/engine/supervision/reconciler")');
  });

  // The plan's Phase 13 Socket.IO row names two dashboard events. The worker returns them
  // rather than emitting them, so a caller must choose the room — and until this remediation
  // no caller did, leaving both events with a producer and no wire.
  test("`server.js` gives the two dashboard events a wire", () => {
    expect(call).toMatch(/onTick:/);
    expect(call).toMatch(/shardSupervisor\.socketMessages\(tick\)/);
    expect(call).toMatch(/io\.to\("dashboard"\)\.emit/);
  });

  // §11.1 — an agent-scope command reaches its agent through the outbox, never a broadcast.
  test("…and does not broadcast the agent-scope command", () => {
    expect(call).not.toMatch(/emit\(\s*["']SHARD_MIGRATE["']/);
  });

  test("the register's units are respected — lease in seconds, the rest in milliseconds", () => {
    expect(call).toMatch(/leaseDurationSeconds:\s*finite\("shard\.lease_duration"\)/);
    expect(call).toMatch(/intervalMs:\s*finite\("shard\.renewal_interval"\)/);
    expect(call).toMatch(/maxClockSkewMillis:\s*finite\("time\.max_clock_skew"\)/);
    expect(call).toMatch(/storeRoundTripMillis:\s*finite\("shard\.store_round_trip_budget"\)/);
    expect(call).toMatch(/minIntervalMs:\s*finite\("shard\.migration_min_interval"\)/);
  });
});

describe("a tick under the production-shaped dependency set", () => {
  // The point of this test is not that a tick works — the tests above already show that.
  // It is that a tick works when the dependencies are the ones `server.js` builds, which
  // is the claim no Phase 13 test made and the one that turned out to be false.
  test("acquires, reconciles, promotes, and reports that a round may run", async () => {
    const { store } = seeded();
    const production = {
      prisma: store.client,
      kv: { set: async () => "OK" },
      store: election.postgresLeadershipStore(store.client, { replicationPosture: "SYNCHRONOUS_QUORUM" }),
      runSerializable: (client, fn) => client.$transaction(fn),
      selectForUpdate: async (tx, table, column, value) => {
        const rows = await tx.$queryRawUnsafe(`SELECT * FROM "${table}" WHERE "${column}" = $1 FOR UPDATE`, value);
        return rows.length > 0 ? rows[0] : null;
      },
      reconcile: async () => ({ total: 0, results: [] }),
      onError: () => {},
    };
    const settings = {
      shardId: "shard-a",
      candidateId: "host:1234",
      leaseDurationSeconds: 5,
      intervalMs: 1500,
      maxClockSkewMillis: 500,
      storeRoundTripMillis: 500,
      minIntervalMs: 2000,
    };

    const tick = await shardSupervisor.runOnce(production, { ...settings, storeTime: store.now() });

    expect(tick.transition).toBe("ACQUIRED");
    expect(tick.session.state).toBe(election.LEADERSHIP_STATE.LEADER);
    expect(tick.failoverRan).toBe(true);
    expect(tick.session.mayCommit).toBe(true);
    expect(tick.mayRunRound).toBe(true);

    const row = await store.client.shardLeadership.findUnique({ where: { shardId: "shard-a" } });
    expect(row.holder).toBe("host:1234");
  });
});
