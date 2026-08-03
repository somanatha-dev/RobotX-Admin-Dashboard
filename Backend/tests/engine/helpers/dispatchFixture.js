"use strict";

/**
 * Phase 4 fixtures, built on Phase 3's store model.
 *
 * Two deliberate choices, both aimed at the Phase 3 independent verification's finding
 * that "every test fixture in the suite sets `Agent.id === Agent.agentId`, so no test
 * in the suite could distinguish a caller using the wrong field":
 *
 *   1. **The two identifiers differ here.** `Agent.id` is a uuid-shaped row id and
 *      `Agent.agentId` is a business identifier; likewise for `Leg`. A caller that
 *      passes the wrong one now fails loudly rather than passing by coincidence.
 *   2. **Signing keys are real.** §23.3's minimum key length is enforced by the module,
 *      so a fixture with a short key would silently exercise the failure path.
 */

const { createCommitmentStore } = require("./commitmentStore");

/** A key long enough to satisfy §23.3's minimum. Test-only, obviously. */
const TEST_SIGNING_KEY = "phase-4-test-signing-key-not-for-production-use";

const AGENT_ROW_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_BUSINESS_ID = "porter-07";
const LEG_ROW_ID = "22222222-2222-4222-8222-222222222222";
const LEG_BUSINESS_ID = "leg-alpha";

/**
 * One shard, one agent, N Legs — with the row ids and the business ids distinct.
 *
 * @param {{ capacity?: number, legs?: number, now?: Date }} [options]
 * @returns {object}
 */
function seed(options) {
  const settings = options || {};
  const capacity = settings.capacity || 1;
  const legCount = settings.legs || 1;

  const legs = [];
  for (let index = 0; index < legCount; index += 1) {
    legs.push({
      id: index === 0 ? LEG_ROW_ID : `${LEG_ROW_ID.slice(0, -1)}${index}`,
      legId: index === 0 ? LEG_BUSINESS_ID : `leg-${index}`,
      missionId: `mission-${index}`,
      sequence: 0,
      purpose: "PRIMARY",
      state: "PLANNED",
      custodyState: "NONE",
      version: 0,
      cancelRequestedAt: null,
      startNotBefore: null,
      obstructionClass: null,
    });
  }

  return {
    agent: {
      id: AGENT_ROW_ID,
      agentId: AGENT_BUSINESS_ID,
      lifecycleState: "ACTIVE",
      authorityEpoch: 7n,
      fenceCounter: 41n,
      capacityOverride: capacity === 1 ? null : capacity,
    },
    legs,
    leadership: {
      id: "shard-leadership-default",
      shardId: "default",
      leadershipFence: 1n,
      holder: "coordinator-a",
      leaseExpiry: new Date("2026-07-30T09:00:30.000Z"),
    },
    capacity,
    now: settings.now || new Date("2026-07-30T09:00:00.000Z"),
  };
}

/**
 * A store seeded from `seed`.
 *
 * @param {object} fixture
 * @param {{ commitments?: object[], outbox?: object[], dedupState?: object[] }} [extra]
 * @returns {object}
 */
function storeFor(fixture, extra) {
  const more = extra || {};
  return createCommitmentStore({
    agent: [fixture.agent],
    leg: fixture.legs,
    shardLeadership: [fixture.leadership],
    commitment: more.commitments || [],
    outbox: more.outbox || [],
    agentDedupState: more.dedupState || [],
    agentFenceAudit: [],
    observation: [],
    now: fixture.now,
  });
}

/**
 * A HARD commitment as `commit.js` would have written it.
 *
 * @param {object} fixture
 * @param {{ commitmentId?: string, fence?: bigint, legIndex?: number, custodyState?: string, slot?: number }} [options]
 * @returns {object}
 */
function commitmentRow(fixture, options) {
  const settings = options || {};
  const leg = fixture.legs[settings.legIndex || 0];
  return {
    id: `commitment-row-${settings.commitmentId || "c1"}`,
    commitmentId: settings.commitmentId || "commitment-c1",
    agentId: fixture.agent.id,
    legId: leg.id,
    kind: "HARD",
    fence: settings.fence === undefined ? 42n : settings.fence,
    leaseExpiry: new Date(fixture.now.getTime() + 60_000),
    custodyState: settings.custodyState || "NONE",
    planSnapshotRef: "plan-1",
    decisionRef: "decision-1",
    version: 0,
    grantedAt: fixture.now,
    releasedAt: null,
    capacitySlot: settings.slot === undefined ? 0 : settings.slot,
  };
}

/**
 * The dependency set `commit()` takes, with both required seams supplied.
 *
 * @param {object} store
 * @param {object} [overrides]
 * @returns {object}
 */
function commitDeps(store, overrides) {
  return {
    prisma: store.client,
    runSerializable: (client, fn) => client.$transaction(fn),
    selectForUpdate: async (tx, table, column, value) => {
      const rows = await tx.$queryRawUnsafe(`SELECT * FROM "${table}" WHERE "${column}" = $1 FOR UPDATE`, value);
      return rows.length > 0 ? rows[0] : null;
    },
    isSerializationFailure: () => false,
    volatileRecheck: async () => ({ ok: true }),
    sideEffects: async () => {},
    ...(overrides || {}),
  };
}

/**
 * The request `commit()` takes, using **row ids** — which is what it requires.
 *
 * @param {object} fixture
 * @param {object} [overrides]
 * @returns {object}
 */
function commitRequest(fixture, overrides) {
  return {
    agentId: fixture.agent.id,
    legId: fixture.legs[0].id,
    decisionRoundId: "round-1",
    targetLegState: "OFFERED",
    shardId: "default",
    planSnapshotRef: "plan-1",
    decisionRef: "decision-1",
    snapshot: {
      leadershipFence: fixture.leadership.leadershipFence,
      authorityEpoch: fixture.agent.authorityEpoch,
      legVersion: fixture.legs[0].version,
      expectedLegState: "PLANNED",
    },
    config: { capacity: fixture.capacity, leaseDurationSeconds: 60 },
    ...(overrides || {}),
  };
}

module.exports = {
  TEST_SIGNING_KEY,
  AGENT_ROW_ID,
  AGENT_BUSINESS_ID,
  LEG_ROW_ID,
  LEG_BUSINESS_ID,
  seed,
  storeFor,
  commitmentRow,
  commitDeps,
  commitRequest,
};
