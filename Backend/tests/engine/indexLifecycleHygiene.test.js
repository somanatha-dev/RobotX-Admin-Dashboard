"use strict";

/**
 * The availability index never keeps an entry for an agent that is not ACTIVE.
 *
 * F2 ("Lifecycle state is active") can only reject an agent the round found in the index, so
 * every F2 rejection on a task card is an index entry that should not exist. Four ways one
 * survived, each pinned here:
 *
 *   1. `sweepOnce` visited only ACTIVE agents, so the row of an agent that left ACTIVE was
 *      never revisited — never removed.
 *   2. The sweep read the lifecycle unlocked and wrote the row later; a retirement committing
 *      in between found nothing to delete, and the sweep then created a row for a
 *      DECOMMISSIONED agent.
 *   3. `rebuildIndexFromMirror` restored every mirror row to Redis at boot, lifecycle unread.
 *   4. Recommissioning (DECOMMISSIONED → COMMISSIONED) never touched the index, so a row that
 *      survived 1–3 stayed with the COMMISSIONED unit.
 */

jest.mock("../../src/db/prisma");

const indexMaintainer = require("../../src/workers/indexMaintainer.worker");
const availabilityIndex = require("../../src/engine/candidates/availabilityIndex");
const cells = require("../../src/engine/spatial/cells");
const { createRetirementStore } = require("../helpers/retirementStore");

const BENGALURU = { lat: 12.9716, lon: 77.5946 };
const KNOWN_IDLE = async () => ({ known: true, charging: false, chargingInterruptible: false, waiting: false, projectedFreeAtMs: null });

/** A KV double recording set membership, as `availabilityIndex` writes it. */
function recordingKv() {
  const sets = new Map();
  return {
    sets,
    async sadd(key, ...members) {
      if (!sets.has(key)) sets.set(key, new Set());
      for (const member of members) sets.get(key).add(String(member));
      return members.length;
    },
    async srem(key, ...members) {
      if (sets.has(key)) for (const member of members) sets.get(key).delete(String(member));
      return members.length;
    },
    async smembers(key) {
      return [...(sets.get(key) || [])];
    },
    async del(key) {
      sets.delete(key);
      return 1;
    },
    async keys() {
      return [...sets.keys()];
    },
    holds(agentId) {
      return [...sets.values()].some((members) => members.has(agentId));
    },
  };
}

/** The mirror row the sweep would write for `agentId` at BENGALURU. */
function mirrorRow(agentId, shardId = "shard-1") {
  const fineCellId = cells.cellForPoint(BENGALURU.lat, BENGALURU.lon, cells.RESOLUTION.FINE);
  return {
    agentId,
    shardId,
    lat: BENGALURU.lat,
    lon: BENGALURU.lon,
    fineCellId,
    coarseCellId: cells.coarseParentOf(fineCellId),
    availabilityClass: "IDLE_READY",
    capabilityClasses: [],
    containerClasses: [],
    observedAtMs: 1_000n,
  };
}

/**
 * A store with the slice of Prisma the maintainer reads and writes, and a model of the
 * `FOR SHARE` lifecycle read: `lockedState` (when set) is what the locked read returns, which
 * is how a test puts a retirement between the unlocked read and the write.
 */
function maintainerStore({ agents, rows = [], lockedState } = {}) {
  const agentRows = new Map(agents.map((a) => [a.id, { agentClassId: null, capacityOverride: null, regionId: "region-1", ...a }]));
  const mirror = new Map(rows.map((row) => [row.agentId, { ...row }]));
  const calls = [];
  const prisma = {
    calls,
    mirror,
    agentRows,
    agent: {
      findUnique: jest.fn(async ({ where }) => {
        const row = agentRows.get(where.id);
        return row ? { ...row } : null;
      }),
      findMany: jest.fn(async ({ where }) =>
        [...agentRows.values()].filter((row) => !where || !where.lifecycleState || row.lifecycleState === where.lifecycleState).map((row) => ({ id: row.id })),
      ),
    },
    shard: { findMany: jest.fn(async () => [{ shardId: "shard-1", state: "ACTIVE" }]) },
    observation: { findFirst: jest.fn(async () => ({ value: { lat: BENGALURU.lat, lon: BENGALURU.lon }, observedAt: new Date(1_000) })) },
    commitment: { count: jest.fn(async () => 0) },
    shardMembership: { findUnique: jest.fn(async () => null), create: jest.fn(async () => ({})), upsert: jest.fn(async () => ({})) },
    agentCellPosition: {
      findUnique: jest.fn(async ({ where }) => (mirror.has(where.agentId) ? { ...mirror.get(where.agentId) } : null)),
      findMany: jest.fn(async (args) => {
        const wanted = args && args.where && args.where.agent && args.where.agent.is && args.where.agent.is.lifecycleState;
        return [...mirror.values()]
          .filter((row) => !wanted || (agentRows.get(row.agentId) || {}).lifecycleState === wanted)
          .map((row) => ({ ...row }));
      }),
      upsert: jest.fn(async ({ where, create, update }) => {
        calls.push("upsert");
        const existing = mirror.get(where.agentId);
        mirror.set(where.agentId, existing ? { ...existing, ...update } : { ...create });
      }),
      delete: jest.fn(async ({ where }) => {
        calls.push("delete");
        mirror.delete(where.agentId);
      }),
    },
    $queryRawUnsafe: jest.fn(async (sql, agentRowId) => {
      calls.push(sql);
      const row = agentRows.get(agentRowId);
      if (!row) return [];
      return [{ lifecycleState: lockedState === undefined ? row.lifecycleState : lockedState }];
    }),
    $transaction: jest.fn(async (fn) => {
      calls.push("BEGIN");
      const result = await fn(prisma);
      calls.push("COMMIT");
      return result;
    }),
  };
  return prisma;
}

describe("1 — the sweep removes the entry of an agent that is no longer ACTIVE", () => {
  test("a COMMISSIONED agent's leftover mirror row and Redis entry are removed by sweepOnce", async () => {
    const kv = recordingKv();
    const row = mirrorRow("agent-2000");
    await availabilityIndex.applyPosition({ kv }, null, row);
    const prisma = maintainerStore({
      agents: [{ id: "agent-2000", agentId: "RBT-2000", lifecycleState: "COMMISSIONED" }],
      rows: [row],
    });
    expect(kv.holds("agent-2000")).toBe(true);

    const outcome = await indexMaintainer.sweepOnce({ prisma, kv, chargingStatusFor: KNOWN_IDLE });

    expect(outcome).toMatchObject({ processed: 1, removed: 1, indexed: 0, failed: 0 });
    expect(prisma.mirror.has("agent-2000")).toBe(false);
    expect(kv.holds("agent-2000")).toBe(false);
    expect(prisma.agentCellPosition.upsert).not.toHaveBeenCalled();
  });

  test("DECOMMISSIONED is removed the same way, and ACTIVE agents are still indexed in the same sweep", async () => {
    const kv = recordingKv();
    const prisma = maintainerStore({
      agents: [
        { id: "agent-retired", agentId: "SIM-OLD", lifecycleState: "DECOMMISSIONED" },
        { id: "agent-live", agentId: "SIM-LIVE", lifecycleState: "ACTIVE" },
      ],
      rows: [mirrorRow("agent-retired")],
    });

    const outcome = await indexMaintainer.sweepOnce({ prisma, kv, chargingStatusFor: KNOWN_IDLE });

    expect(outcome).toMatchObject({ processed: 2, indexed: 1, removed: 1, failed: 0 });
    expect([...prisma.mirror.keys()]).toEqual(["agent-live"]);
    expect(kv.holds("agent-live")).toBe(true);
    expect(kv.holds("agent-retired")).toBe(false);
  });

  test("an agent with neither ACTIVE nor a mirror row is not visited at all", async () => {
    const prisma = maintainerStore({ agents: [{ id: "agent-c", agentId: "RBT-C", lifecycleState: "COMMISSIONED" }] });
    const outcome = await indexMaintainer.sweepOnce({ prisma, kv: recordingKv(), chargingStatusFor: KNOWN_IDLE });
    expect(outcome.processed).toBe(0);
  });
});

describe("2 — lifecycle is re-read under the Agent row lock at write time", () => {
  test("a retirement committing after the unlocked read: nothing is written, nothing is indexed", async () => {
    // assembleRecord reads ACTIVE (unlocked); the locked read sees the committed retirement.
    const kv = recordingKv();
    const prisma = maintainerStore({ agents: [{ id: "agent-1", agentId: "RBT-1", lifecycleState: "ACTIVE" }], lockedState: "DECOMMISSIONED" });

    const outcome = await indexMaintainer.sweepAgents({ prisma, kv, chargingStatusFor: KNOWN_IDLE }, ["agent-1"]);

    expect(outcome).toMatchObject({ processed: 1, indexed: 0, failed: 0 });
    expect(prisma.agentCellPosition.upsert).not.toHaveBeenCalled();
    expect(prisma.mirror.size).toBe(0);
    expect(kv.holds("agent-1")).toBe(false);
  });

  test("…and an existing row for that agent is removed rather than refreshed", async () => {
    const kv = recordingKv();
    const row = mirrorRow("agent-1");
    await availabilityIndex.applyPosition({ kv }, null, row);
    const prisma = maintainerStore({
      agents: [{ id: "agent-1", agentId: "RBT-1", lifecycleState: "ACTIVE" }],
      rows: [row],
      lockedState: "DECOMMISSIONED",
    });

    const outcome = await indexMaintainer.sweepAgents({ prisma, kv, chargingStatusFor: KNOWN_IDLE }, ["agent-1"]);

    expect(outcome).toMatchObject({ removed: 1, indexed: 0 });
    expect(prisma.mirror.size).toBe(0);
    expect(kv.holds("agent-1")).toBe(false);
  });

  test("the lock is FOR SHARE on the Agent row, taken inside the transaction before the write and the Redis update", async () => {
    const kv = recordingKv();
    const prisma = maintainerStore({ agents: [{ id: "agent-1", agentId: "RBT-1", lifecycleState: "ACTIVE" }] });
    const sadd = jest.spyOn(kv, "sadd");

    await indexMaintainer.sweepAgents({ prisma, kv, chargingStatusFor: KNOWN_IDLE }, ["agent-1"]);

    const lockAt = prisma.calls.findIndex((c) => /FROM "Agent" WHERE "id" = \$1 FOR SHARE/.test(c));
    expect(prisma.calls.indexOf("BEGIN")).toBeLessThan(lockAt);
    expect(lockAt).toBeLessThan(prisma.calls.indexOf("upsert"));
    expect(prisma.calls.indexOf("upsert")).toBeLessThan(prisma.calls.indexOf("COMMIT"));
    // The Redis half was written while the lock was held (before COMMIT was recorded).
    expect(sadd).toHaveBeenCalled();
    expect(kv.holds("agent-1")).toBe(true);
  });
});

describe("3 — the boot rebuild restores only ACTIVE agents", () => {
  test("a mirror row of a COMMISSIONED agent is not restored to Redis", async () => {
    const kv = recordingKv();
    const prisma = maintainerStore({
      agents: [
        { id: "agent-live", agentId: "SIM-LIVE", lifecycleState: "ACTIVE" },
        { id: "agent-2000", agentId: "RBT-2000", lifecycleState: "COMMISSIONED" },
      ],
      rows: [mirrorRow("agent-live"), mirrorRow("agent-2000")],
    });

    await indexMaintainer.rebuildIndexFromMirror({ prisma, kv });

    expect(prisma.agentCellPosition.findMany).toHaveBeenCalledWith({ where: { agent: { is: { lifecycleState: "ACTIVE" } } } });
    expect(kv.holds("agent-live")).toBe(true);
    expect(kv.holds("agent-2000")).toBe(false);
  });
});

describe("4 — recommissioning leaves no index entry behind", () => {
  test("a leftover mirror row is deleted in the transaction and its Redis entry after the commit", async () => {
    const kv = recordingKv();
    kv.del = jest.fn(async () => 1);
    const cell = mirrorRow("agent-2000");
    await availabilityIndex.applyPosition({ kv }, null, cell);
    const store = createRetirementStore({
      robots: [{ id: "row-2000", robotId: "RBT-2000", status: "IDLE", simulated: false }],
      agents: [{ id: "agent-2000", agentId: "RBT-2000", robotDbId: "row-2000", lifecycleState: "DECOMMISSIONED", authorityEpoch: 5, fenceCounter: 9 }],
      cells: [cell],
    });
    store.state.fenceAudits.push({ agentId: "agent-2000", epochHighWater: 5n, fenceHighWater: 9n, lastFenceSource: "decommission", observedAt: "2026-10-10T08:00:00.000Z" });

    const svc = require("../../src/services/robotRecommission.service");
    const result = await svc.recommission(store.prisma, "RBT-2000", { reason: "returning to the fleet after repair", confirmRobotId: "RBT-2000" }, { actorId: "op-1", kv });

    expect(result).toMatchObject({ outcome: "RECOMMISSIONED", lifecycleState: "COMMISSIONED", indexEntryRemoved: true });
    expect(result).not.toHaveProperty("indexEntryRemovalFailed");
    expect(result).not.toHaveProperty("cell");
    expect(store.state.cells).toEqual([]);
    expect(kv.holds("agent-2000")).toBe(false);
  });

  test("with no leftover row, nothing is removed and the result says so", async () => {
    const kv = recordingKv();
    kv.del = jest.fn(async () => 1);
    const store = createRetirementStore({
      robots: [{ id: "row-2000", robotId: "RBT-2000", status: "IDLE", simulated: false }],
      agents: [{ id: "agent-2000", agentId: "RBT-2000", robotDbId: "row-2000", lifecycleState: "DECOMMISSIONED", authorityEpoch: 5 }],
    });
    store.state.fenceAudits.push({ agentId: "agent-2000", epochHighWater: 5n, fenceHighWater: 0n, lastFenceSource: "decommission", observedAt: "2026-10-10T08:00:00.000Z" });
    const svc = require("../../src/services/robotRecommission.service");

    const result = await svc.recommission(store.prisma, "RBT-2000", { reason: "returning to the fleet after repair", confirmRobotId: "RBT-2000" }, { actorId: "op-1", kv });

    expect(result).toMatchObject({ outcome: "RECOMMISSIONED", indexEntryRemoved: false });
  });
});
