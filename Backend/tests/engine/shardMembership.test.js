"use strict";

/**
 * Engine lane — Phase 13: the transactional membership handoff (§3.5, §19.2).
 *
 * > Shard rebalancing […] migrates agents **one at a time**, advancing each migrated
 * > agent's **`authority_epoch`** — the agent-scope fence (§10.3.1) — **never a bulk
 * > reassignment**. […] Migration correctness then follows from guard G3 (§10.3.2): an
 * > agent migrated mid-round has a changed `authority_epoch`, so the old shard's pending
 * > commitment fails its guard.
 *
 * That last sentence is the one this file proves rather than restates: the final block
 * drives the **real `commit()`** with a round's pinned epoch and asserts G3 aborts it.
 * Everything above it establishes that the migration produces the state G3 then acts on.
 */

const { commit, OUTCOME, ABORT_REASON } = require("../../src/engine/commitment/commit");
const fencing = require("../../src/engine/commitment/fencing");
const membership = require("../../src/engine/shard/membership");
const shardModel = require("../../src/engine/shard/shardModel");
const { createCommitmentStore, fixture } = require("./helpers/commitmentStore");

const NOW = new Date("2026-07-29T12:00:00.000Z");
const SIGNING_KEY = "a-signing-key-long-enough-for-§23.3-to-accept-it";
const COMMAND_TTL_SECONDS = 60;

/**
 * The store every test in this file uses.
 *
 * `helpers/commitmentStore.js`, not the cheap double, for two reasons that are the same
 * reason: a migration's whole claim is that five writes land together or not at all, and
 * it takes the agent row under the same `FOR UPDATE` lock the commit transaction takes.
 * A store that could not block, and could not discard an overlay, would let both
 * assertions pass vacuously.
 *
 * Phase 13 extended that helper with `Shard` and `ShardMembership` and with **their schema
 * backstops** — the four CHECKs and the partial unique index — evaluated at apply time
 * against the global view, exactly as Phases 3, 4 and 5's are. So a handoff that failed to
 * advance the epoch, or that left two current memberships, is refused *by the store* here
 * and not merely by the code under test.
 */
function seeded(options) {
  const settings = options || {};
  const seed = fixture({ legs: 1 });
  const store = createCommitmentStore({
    agent: [seed.agent],
    leg: seed.legs,
    shardLeadership: [seed.leadership],
    outbox: [],
    shard: [
      { id: "s-a", shardId: "shard-a", regionId: "region-a", state: "ACTIVE", drainingSince: null, agentCount: 1, bindingBound: "NEITHER_EVALUATED" },
      {
        id: "s-b",
        shardId: "shard-b",
        regionId: "region-b",
        state: settings.targetState || "ACTIVE",
        drainingSince: settings.targetState === "DRAINING" ? NOW : null,
        agentCount: 0,
        bindingBound: "NEITHER_EVALUATED",
      },
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

  return {
    seed,
    store,
    shardRows: () => store.rows("shard"),
    membershipRows: () => store.rows("shardMembership"),
  };
}

function deps(store) {
  return {
    prisma: store.client,
    runSerializable: (client, fn) => client.$transaction(fn),
    selectForUpdate: async (tx, table, column, value) => {
      const rows = await tx.$queryRawUnsafe(`SELECT * FROM "${table}" WHERE "${column}" = $1 FOR UPDATE`, value);
      return rows.length > 0 ? rows[0] : null;
    },
  };
}

function migrateRequest(seed, overrides) {
  return {
    agentId: seed.agent.id,
    targetShardId: "shard-b",
    reason: shardModel.MEMBERSHIP_REASON.REBALANCE_MERGE,
    movedBy: "operator-1",
    storeTime: NOW,
    commandTtlSeconds: COMMAND_TTL_SECONDS,
    signingKey: SIGNING_KEY,
    ...(overrides || {}),
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   "Never a bulk reassignment" — enforced by signature
   ═══════════════════════════════════════════════════════════════════════════ */

describe("**one at a time** (§19.2)", () => {
  test("migrate() takes one agent id, and an array is refused before any write", async () => {
    const { seed, store } = seeded();
    await expect(membership.migrate(deps(store), migrateRequest(seed, { agentId: ["a", "b"] }))).rejects.toThrow(
      /never a bulk reassignment/,
    );
    await expect(membership.migrate(deps(store), migrateRequest(seed, { agentIds: ["a", "b"] }))).rejects.toThrow(
      /never a bulk reassignment/,
    );
  });

  test("the refusal names the specification's own sentence, so a future batch parameter fails here", () => {
    expect(() => membership.assertNotBulk({ agentIds: [] })).toThrow(/migrates agents one at a time/);
    expect(() => membership.assertNotBulk({ agentId: "" })).toThrow(/takes one Agent\.id/);
  });

  test("the exported surface offers no batch form", () => {
    expect(Object.keys(membership).filter((name) => /migrateMany|migrateAll|migrateBatch/i.test(name))).toEqual([]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   The five writes, and that they land together
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the transactional handoff (§3.5, §19.2)", () => {
  test("a migration advances authority_epoch by exactly one and leaves fence_counter untouched", async () => {
    const { seed, store } = seeded();
    const outcome = await membership.migrate(deps(store), migrateRequest(seed));

    expect(outcome.ok).toBe(true);
    expect(outcome.authorityEpochBefore).toBe(seed.agent.authorityEpoch);
    expect(outcome.authorityEpochAfter).toBe(seed.agent.authorityEpoch + 1n);

    const agent = store.rows("agent")[0];
    expect(agent.authorityEpoch).toBe(seed.agent.authorityEpoch + 1n);
    // §10.3.1 keeps the two scopes orthogonal: bumping the commitment counter here would
    // invalidate commitments in the *new* shard as well as authority in the old one.
    expect(agent.fenceCounter).toBe(seed.agent.fenceCounter);
  });

  test("the previous membership is superseded and exactly one current row remains", async () => {
    const { seed, store, membershipRows } = seeded();
    await membership.migrate(deps(store), migrateRequest(seed));

    expect(membershipRows()).toHaveLength(2);
    expect(membershipRows()[0].supersededAt).toEqual(NOW);
    const current = membershipRows().filter((row) => (row.supersededAt ?? null) === null);
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({ shardId: "shard-b", fromShardId: "shard-a", reason: "REBALANCE_MERGE", movedBy: "operator-1" });
  });

  test("a `SHARD_MIGRATE` outbox row is written in the same transaction, carrying epoch **and** fence_floor", async () => {
    const { seed, store } = seeded();
    const outcome = await membership.migrate(deps(store), migrateRequest(seed));

    const row = store.rows("outbox").find((entry) => entry.command === "SHARD_MIGRATE");
    expect(row).toBeDefined();
    expect(row.commandClass).toBe(fencing.COMMAND_CLASS.AGENT);
    expect(row.fenceScope).toBe(fencing.FENCE_SCOPE.AGENT);
    expect(row.authorityEpoch).toBe(seed.agent.authorityEpoch + 1n);
    // §10.3.1's interaction rule: "Every agent-scope command carries, in addition to
    // `authority_epoch`, the agent's current `fence_counter` value as `fence_floor`."
    expect(row.fenceFloor).toBe(seed.agent.fenceCounter);
    expect(row.commitmentId).toBeNull();
    expect(row.signature).toEqual(expect.any(String));
    expect(outcome.membership.outboxIdempotencyKey).toBe(row.idempotencyKey);
  });

  test("outstanding commands are suppressed — they were authorised under the superseded authority", async () => {
    const { seed, store } = seeded();
    // A mission command already queued for this agent under the old shard's authority.
    // The commitment it names is created first, because the store models
    // `Outbox_commitmentId_fkey` — so this row is one the database would actually hold,
    // and the suppression below is a real state change rather than a no-op against a row
    // Postgres would have rejected.
    await store.client.commitment.create({
      data: {
        id: "c-old",
        commitmentId: "CMT-OLD",
        agentId: seed.agent.id,
        legId: seed.legs[0].id,
        kind: "HARD",
        fence: 1n,
        capacitySlot: 0,
        releasedAt: null,
        leaseExpiry: new Date(NOW.getTime() + 60000),
        version: 0,
        grantedAt: NOW,
        custodyState: "NONE",
      },
    });
    await store.client.outbox.create({
      data: {
        id: "ob-old",
        idempotencyKey: "old-1",
        agentId: seed.agent.id,
        commitmentId: "CMT-OLD",
        commandClass: "MISSION",
        command: "OFFER",
        fenceScope: "COMMITMENT",
        fence: 1n,
        authorityEpoch: null,
        fenceFloor: null,
        sequence: 1,
        payload: {},
        notValidAfter: new Date(NOW.getTime() + 60000),
        signature: "x",
        state: "PENDING",
        attempts: 0,
      },
    });

    const outcome = await membership.migrate(deps(store), migrateRequest(seed));
    expect(outcome.suppressedOutboxRows).toBe(1);
    expect(store.rows("outbox").find((row) => row.id === "ob-old").state).toBe("SUPPRESSED");
  });

  test("invariant I6's high-water mark moves with the epoch, in the same transaction", async () => {
    const { seed, store } = seeded();
    await membership.migrate(deps(store), migrateRequest(seed));

    const audit = store.rows("agentFenceAudit")[0];
    expect(audit.epochHighWater).toBe(seed.agent.authorityEpoch + 1n);
    expect(audit.lastFenceSource).toMatch(/^SHARD_MIGRATE:shard-b$/);
  });

  test("the membership counts move on both shards, in the same transaction", async () => {
    const { seed, store, shardRows } = seeded();
    await membership.migrate(deps(store), migrateRequest(seed));

    expect(shardRows().find((row) => row.shardId === "shard-a").agentCount).toBe(0);
    expect(shardRows().find((row) => row.shardId === "shard-b").agentCount).toBe(1);
  });

  test("a refused migration writes nothing at all", async () => {
    const { seed, store, membershipRows } = seeded({ targetState: "DRAINING" });
    const outcome = await membership.migrate(deps(store), migrateRequest(seed));

    expect(outcome.ok).toBe(false);
    expect(outcome.refusal).toBe(membership.REFUSAL.TARGET_NOT_ACCEPTING);
    expect(store.rows("agent")[0].authorityEpoch).toBe(seed.agent.authorityEpoch);
    expect(membershipRows()).toHaveLength(1);
    expect(store.rows("outbox")).toEqual([]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   The refusals
   ═══════════════════════════════════════════════════════════════════════════ */

describe("refusals", () => {
  test("a move to the shard the agent is already in is refused — an epoch burnt for nothing", async () => {
    const { seed, store } = seeded();
    const outcome = await membership.migrate(deps(store), migrateRequest(seed, { targetShardId: "shard-a" }));
    expect(outcome.refusal).toBe(membership.REFUSAL.ALREADY_THERE);
    expect(outcome.detail).toMatch(/burn an authority_epoch/);
  });

  test("an unknown agent and an unknown target shard are distinguished", async () => {
    const { seed, store } = seeded();
    expect((await membership.migrate(deps(store), migrateRequest(seed, { agentId: "nobody" }))).refusal).toBe(membership.REFUSAL.NO_AGENT);
    expect((await membership.migrate(deps(store), migrateRequest(seed, { targetShardId: "shard-z" }))).refusal).toBe(
      membership.REFUSAL.TARGET_UNKNOWN,
    );
  });

  test("an agent holding goods is refused unless the custody transfer is asked for explicitly (§2.5)", async () => {
    const { seed, store } = seeded();
    await store.client.leg.update({ where: { id: seed.legs[0].id }, data: { custodyState: "HELD" } });
    await store.client.commitment.create({
      data: {
        id: "c-held",
        commitmentId: "CMT-HELD",
        agentId: seed.agent.id,
        legId: seed.legs[0].id,
        kind: "HARD",
        fence: 42n,
        capacitySlot: 0,
        releasedAt: null,
        leaseExpiry: new Date(NOW.getTime() + 60000),
        version: 0,
        grantedAt: NOW,
        custodyState: "HELD",
      },
    });

    const refused = await membership.migrate(deps(store), migrateRequest(seed));
    expect(refused.refusal).toBe(membership.REFUSAL.HOLDS_CUSTODY);
    expect(refused.detail).toMatch(/accountable transfer rather than an implicit one/);
    expect(refused.detail).toMatch(/not forbidden, only not automatic/);

    const allowed = await membership.migrate(deps(store), migrateRequest(seed, { allowCustodyTransfer: true }));
    expect(allowed.ok).toBe(true);
    expect(allowed.membership.detail.custodyStates).toEqual(["HELD"]);
  });

  test("COMMISSIONING is refused as a migration reason — a placement is a different operation", async () => {
    const { seed, store } = seeded();
    await expect(
      membership.migrate(deps(store), migrateRequest(seed, { reason: shardModel.MEMBERSHIP_REASON.COMMISSIONING })),
    ).rejects.toThrow(/COMMISSIONING is the reason for an initial placement/);
  });

  test("an unregistered reason is refused — §22.3 makes shard definition a STRUCTURAL change", async () => {
    const { seed, store } = seeded();
    await expect(membership.migrate(deps(store), migrateRequest(seed, { reason: "BECAUSE" }))).rejects.toThrow(
      /is not a membership reason/,
    );
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   Placement — the operation that is deliberately weaker
   ═══════════════════════════════════════════════════════════════════════════ */

describe("initial placement (§3.5)", () => {
  test("placement advances no epoch and issues no command — there is no authority to supersede", async () => {
    const { seed, store } = seeded();
    // An agent that has never been placed. Seeded directly rather than by deleting a row,
    // because "never placed" and "placed then unplaced" are different states and only the
    // first is what commissioning produces.
    store.committed.shardMembership.clear();

    const outcome = await membership.place({ prisma: store.client }, { agentId: seed.agent.id, shardId: "shard-a", at: NOW, movedBy: "commissioning" });

    expect(outcome.ok).toBe(true);
    expect(outcome.membership.authorityEpochAfter).toBe(outcome.membership.authorityEpochBefore);
    expect(outcome.membership.fromShardId).toBeNull();
    expect(outcome.membership.outboxIdempotencyKey).toBeNull();
    expect(store.rows("outbox")).toEqual([]);
    expect(store.rows("agent")[0].authorityEpoch).toBe(seed.agent.authorityEpoch);
  });

  test("placing an agent that is already placed elsewhere is refused, not silently re-placed", async () => {
    const { seed, store } = seeded();
    const outcome = await membership.place({ prisma: store.client }, { agentId: seed.agent.id, shardId: "shard-b", at: NOW });
    expect(outcome.ok).toBe(false);
    expect(outcome.refusal).toBe(membership.REFUSAL.ALREADY_THERE);
  });

  test("re-placing into the same shard is idempotent", async () => {
    const { seed, store } = seeded();
    const outcome = await membership.place({ prisma: store.client }, { agentId: seed.agent.id, shardId: "shard-a", at: NOW });
    expect(outcome.ok).toBe(true);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   The rebalance plan
   ═══════════════════════════════════════════════════════════════════════════ */

describe("planRebalance — an ordered list of single migrations", () => {
  const members = [
    { agentId: "busy", shardId: "shard-a" },
    { agentId: "idle-b", shardId: "shard-a" },
    { agentId: "idle-a", shardId: "shard-a" },
  ];

  test("idle agents move first — moving a committed one aborts a round through G3", () => {
    const plan = membership.planRebalance({
      members,
      liveCommitmentCountByAgentId: { busy: 2, "idle-a": 0, "idle-b": 0 },
      surplus: 3,
      targetShardId: "shard-b",
    });
    expect(plan.moves.map((move) => move.agentId)).toEqual(["idle-a", "idle-b", "busy"]);
    expect(plan.note).toMatch(/correct, but not free/);
  });

  test("the tie-break is deterministic, so a rebalance plan replays identically (T6)", () => {
    const input = { members, liveCommitmentCountByAgentId: {}, surplus: 3, targetShardId: "shard-b" };
    expect(membership.planRebalance(input)).toEqual(membership.planRebalance(input));
  });

  test("the plan is a list of moves, not a batch operation — each names one agent", () => {
    const plan = membership.planRebalance({ members, liveCommitmentCountByAgentId: {}, surplus: 2, targetShardId: "shard-b" });
    expect(plan.moves).toHaveLength(2);
    for (const move of plan.moves) expect(typeof move.agentId).toBe("string");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §19.2's own correctness argument, driven
   ═══════════════════════════════════════════════════════════════════════════ */

describe("**migration correctness follows from guard G3** (§19.2, §10.3.2)", () => {
  test("a round that pinned the pre-migration epoch has its commit aborted by G3", async () => {
    const { seed, store } = seeded();

    // A round begins and pins the agent's authority epoch, as §9.6 requires.
    const pinnedEpoch = seed.agent.authorityEpoch;

    // The agent migrates mid-round.
    const migrated = await membership.migrate(deps(store), migrateRequest(seed));
    expect(migrated.ok).toBe(true);

    // The old shard's coordinator commits against what it pinned.
    const outcome = await commit(
      {
        ...deps(store),
        isSerializationFailure: () => false,
        volatileRecheck: async () => ({ ok: true }),
        sideEffects: async () => {},
      },
      {
        agentId: seed.agent.id,
        legId: seed.legs[0].id,
        decisionRoundId: "round-1",
        targetLegState: "OFFERED",
        shardId: "default",
        snapshot: {
          leadershipFence: seed.leadership.leadershipFence,
          authorityEpoch: pinnedEpoch,
          legVersion: seed.legs[0].version,
          expectedLegState: "PLANNED",
        },
        config: { capacity: seed.capacity, leaseDurationSeconds: 60 },
      },
    );

    expect(outcome.outcome).toBe(OUTCOME.ABORTED);
    expect(outcome.reason).toBe(ABORT_REASON.G3_AUTHORITY_EPOCH_CHANGED);
    expect(store.rows("commitment")).toEqual([]);
  });

  test("the new shard's coordinator, pinning the post-migration epoch, commits successfully", async () => {
    const { seed, store } = seeded();
    const migrated = await membership.migrate(deps(store), migrateRequest(seed));

    const outcome = await commit(
      {
        ...deps(store),
        isSerializationFailure: () => false,
        volatileRecheck: async () => ({ ok: true }),
        sideEffects: async () => {},
      },
      {
        agentId: seed.agent.id,
        legId: seed.legs[0].id,
        decisionRoundId: "round-2",
        targetLegState: "OFFERED",
        shardId: "default",
        snapshot: {
          leadershipFence: seed.leadership.leadershipFence,
          authorityEpoch: migrated.authorityEpochAfter,
          legVersion: seed.legs[0].version,
          expectedLegState: "PLANNED",
        },
        config: { capacity: seed.capacity, leaseDurationSeconds: 60 },
      },
    );

    expect(outcome.outcome).toBe(OUTCOME.COMMITTED);
  });
});
