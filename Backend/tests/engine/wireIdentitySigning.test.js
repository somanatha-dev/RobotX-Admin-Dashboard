/**
 * P2B-2 follow-up — every signed command names the agent by its **wire identity**.
 *
 * The delivery arm (`workers/leaderWorkers.js`) addresses an outbox envelope to the robot
 * code, `Agent.agentId`, falling back to the row id only when the Agent row has no
 * `agentId`. The agent verifies the signature over the envelope it receives. OFFER and
 * WITHDRAW were signed for `agent.agentId || agent.id`; RECALL (`lifecycle/reassignment.js`)
 * and SHARD_MIGRATE (`shard/membership.js`) were signed for the row id, so a verifying agent
 * rejected every one (measured on a live V1 run: RECALL 0/1 while OFFER 7/7 and WITHDRAW 1/1).
 *
 * Each test below builds the command through the real engine function, then delivers it
 * exactly as production does — `outbox.worker.envelopeOf`, the addressee rewrite, JSON —
 * and verifies it with the wire-only canonicaliser the Pi's implementation mirrors.
 */

const fixtures = require("./helpers/dispatchFixture");
const { createCommitmentStore, fixture: commitmentFixture } = require("./helpers/commitmentStore");
const reassignment = require("../../src/engine/lifecycle/reassignment");
const membership = require("../../src/engine/shard/membership");
const shardModel = require("../../src/engine/shard/shardModel");
const offers = require("../../src/engine/dispatch/offers");
const { envelopeOf } = require("../../src/workers/outbox.worker");
const wire = require("../../tools/verify/wireCanonical");

/** The addressee exactly as `leaderWorkers`' delivery arm resolves it from the Agent row. */
const deliveryKeyFor = (agentRow) => (agentRow && agentRow.agentId ? agentRow.agentId : agentRow.id);

/** An outbox row as the agent receives it: enveloped, addressed, sent as JSON. */
function delivered(row, addressee) {
  return JSON.parse(JSON.stringify({ ...envelopeOf(row), agentId: addressee }));
}

const verifies = (row, addressee, key) => wire.verifyFromWire(delivered(row, addressee), key).ok;

/* ── RECALL ───────────────────────────────────────────────────────────────── */

describe("RECALL is signed for the agent's wire identity", () => {
  const config = {
    maxReassignmentsPerLeg: 3,
    incumbentCooloffSeconds: 300,
    reassignBudgetSeconds: 300,
    maxDeliveryDelaySeconds: 30,
    signingKey: fixtures.TEST_SIGNING_KEY,
    trigger: reassignment.TRIGGER.LEASE_EXPIRY,
  };

  async function recallFor(agentOverride) {
    const seed = fixtures.seed();
    const store = fixtures.storeFor(seed, { commitments: [fixtures.commitmentRow(seed, { fence: 42n })] });
    await store.client.leg.update({ where: { id: fixtures.LEG_ROW_ID }, data: { state: "ACCEPTED" } });
    const leg = await store.client.leg.findUnique({ where: { id: fixtures.LEG_ROW_ID } });
    const agentRow = await store.client.agent.findUnique({ where: { id: fixtures.AGENT_ROW_ID } });
    const agent = { ...agentRow, ...(agentOverride || {}) };
    const commitment = await store.client.commitment.findUnique({ where: { commitmentId: "commitment-c1" } });

    const result = await store.client.$transaction((tx) =>
      reassignment.reassign(tx, { leg, agent, commitment, legCommitments: [commitment], storeTime: store.now(), ...config }),
    );
    expect(result.outcome).toBe(reassignment.OUTCOME.REASSIGNED);
    return { agent, recall: store.rows("outbox").find((row) => row.command === "RECALL") };
  }

  test("1/2. a RECALL for an agent with an agentId verifies at that agent (its robot code)", async () => {
    const { agent, recall } = await recallFor();
    expect(agent.agentId).not.toBe(agent.id);
    expect(deliveryKeyFor(agent)).toBe(agent.agentId);
    expect(verifies(recall, agent.agentId, fixtures.TEST_SIGNING_KEY)).toBe(true);
  });

  test("3. the row id is NOT what it is signed for when an agentId exists", async () => {
    const { agent, recall } = await recallFor();
    expect(verifies(recall, agent.id, fixtures.TEST_SIGNING_KEY)).toBe(false);
  });

  test("4. fallback to the row id only where the delivery arm falls back too: an Agent with no agentId", async () => {
    const { agent, recall } = await recallFor({ agentId: null });
    expect(deliveryKeyFor(agent)).toBe(agent.id);
    expect(verifies(recall, agent.id, fixtures.TEST_SIGNING_KEY)).toBe(true);
  });

  test("the Outbox row keeps the row id as its FK — only the signed addressee changed", async () => {
    const { agent, recall } = await recallFor();
    expect(recall.agentId).toBe(agent.id);
  });
});

/* ── SHARD_MIGRATE ────────────────────────────────────────────────────────── */

describe("5. SHARD_MIGRATE is signed for the agent's wire identity", () => {
  const NOW = new Date("2026-07-29T12:00:00.000Z");
  const SIGNING_KEY = "a-signing-key-long-enough-for-§23.3-to-accept-it";

  async function migrated(agentId) {
    const seed = commitmentFixture({ legs: 1 });
    // Distinguishable identities: the helper seeds id === agentId, which would hide the defect.
    seed.agent = { ...seed.agent, agentId };
    const store = createCommitmentStore({
      agent: [seed.agent],
      leg: seed.legs,
      shardLeadership: [seed.leadership],
      outbox: [],
      shard: [
        { id: "s-a", shardId: "shard-a", regionId: "region-a", state: "ACTIVE", drainingSince: null, agentCount: 1, bindingBound: "NEITHER_EVALUATED" },
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
    const deps = {
      prisma: store.client,
      runSerializable: (client, fn) => client.$transaction(fn),
      selectForUpdate: async (tx, table, column, value) => {
        const rows = await tx.$queryRawUnsafe(`SELECT * FROM "${table}" WHERE "${column}" = $1 FOR UPDATE`, value);
        return rows.length > 0 ? rows[0] : null;
      },
    };
    const outcome = await membership.migrate(deps, {
      agentId: seed.agent.id,
      targetShardId: "shard-b",
      reason: shardModel.MEMBERSHIP_REASON.REBALANCE_MERGE,
      movedBy: "operator-1",
      storeTime: NOW,
      commandTtlSeconds: 60,
      signingKey: SIGNING_KEY,
    });
    expect(outcome.refusal == null).toBe(true);
    const row = store.rows("outbox").find((entry) => entry.command === "SHARD_MIGRATE");
    return { agent: seed.agent, row, SIGNING_KEY };
  }

  test("verifies at the agent's robot code, not at its row id", async () => {
    const { agent, row, SIGNING_KEY: key } = await migrated("robotx-pi");
    expect(agent.id).not.toBe("robotx-pi");
    expect(verifies(row, "robotx-pi", key)).toBe(true);
    expect(verifies(row, agent.id, key)).toBe(false);
    expect(row.agentId).toBe(agent.id);
  });

  test("an Agent with no agentId falls back to the row id, as the delivery arm does", async () => {
    const { agent, row, SIGNING_KEY: key } = await migrated(null);
    expect(verifies(row, deliveryKeyFor(agent), key)).toBe(true);
  });
});

/* ── OFFER / WITHDRAW, unchanged ──────────────────────────────────────────── */

describe("6. OFFER and WITHDRAW signatures are unchanged", () => {
  test("WITHDRAW verifies at the robot code (and not at the row id)", async () => {
    const seed = fixtures.seed();
    const store = fixtures.storeFor(seed, { commitments: [fixtures.commitmentRow(seed, { fence: 42n })] });
    await store.client.leg.update({ where: { id: fixtures.LEG_ROW_ID }, data: { state: "OFFERED" } });
    const leg = await store.client.leg.findUnique({ where: { id: fixtures.LEG_ROW_ID } });
    const agent = await store.client.agent.findUnique({ where: { id: fixtures.AGENT_ROW_ID } });
    const commitment = await store.client.commitment.findUnique({ where: { commitmentId: "commitment-c1" } });
    await store.client.$transaction((tx) =>
      offers.withdrawExpiredOffer(tx, {
        commitment,
        agent,
        leg,
        storeTime: store.now(),
        nackCooloffSeconds: 120,
        maxDeliveryDelaySeconds: 30,
        signingKey: fixtures.TEST_SIGNING_KEY,
      }),
    );
    const row = store.rows("outbox").find((entry) => entry.command === "WITHDRAW");
    expect(verifies(row, agent.agentId, fixtures.TEST_SIGNING_KEY)).toBe(true);
    expect(verifies(row, agent.id, fixtures.TEST_SIGNING_KEY)).toBe(false);
  });

  test("OFFER verifies at the addressee it is enqueued for", async () => {
    const rows = [];
    const tx = {
      outbox: {
        findMany: async () => [],
        findUnique: async () => null,
        create: async ({ data }) => {
          const row = { id: "ob-1", state: "PENDING", ...data };
          rows.push(row);
          return row;
        },
      },
    };
    await offers.enqueueOffer(tx, {
      commitment: { commitmentId: "CMT-1", fence: 5n, legId: "leg-1", agentId: "agent-row-1" },
      addressee: "robotx-pi",
      storeTime: new Date("2026-09-24T10:00:00.000Z"),
      offerTtlSeconds: 20,
      signingKey: fixtures.TEST_SIGNING_KEY,
      offer: { taskId: "TSK-1", stopSequence: [] },
    });
    expect(verifies(rows[0], "robotx-pi", fixtures.TEST_SIGNING_KEY)).toBe(true);
    expect(verifies(rows[0], "agent-row-1", fixtures.TEST_SIGNING_KEY)).toBe(false);
  });
});
