"use strict";

/**
 * The three defects that stood between a correctly-seeded world and one real assignment.
 *
 * Each was found by **executing** the V1 demonstration path against a disposable local
 * PostgreSQL cluster, not by reading the modules, and each is silent in production: none
 * throws, none logs, and every one of them ends in "no candidate" rather than in an error.
 * That is why they are asserted mechanically here.
 *
 *   1. `indexMaintainer.assembleRecord` published a hard-coded `shardId: "default"`.
 *   2. `coordinatorSolvePath`'s priced-candidate memo was keyed on one agent identifier
 *      and read on another, so every priced candidate was dropped before it became a
 *      column.
 *   3. `devChargingScheduler`'s declared charger carried no `cellId`, so the one
 *      development charger could never be routed to and §14.5's `E_return` had no
 *      destination.
 */

const indexMaintainer = require("../../src/workers/indexMaintainer.worker");
const coordinatorSolvePath = require("../../src/workers/coordinatorSolvePath");
const devChargingScheduler = require("../../src/simulation/devChargingScheduler");
const cells = require("../../src/engine/spatial/cells");

/* ═══════════════════════════════════════════════════════════════════════════
   1. The index maintainer publishes the shard that owns the agent.
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * A store holding one agent, one position observation, and whatever shard facts the
 * case under test declares.
 *
 * @param {object} options
 * @returns {object} a Prisma-shaped double
 */
function storeWith(options) {
  const { regionId = null, mirrorShardId = null, shards = [] } = options || {};
  return {
    agent: {
      findUnique: async () => ({
        id: "agent-row-1",
        agentId: "AGENT-1",
        lifecycleState: "ACTIVE",
        agentClassId: "class-row-1",
        capacityOverride: null,
        regionId,
      }),
    },
    observation: {
      findFirst: async () => ({
        value: { lat: 12.9007, lon: 77.5176, provenance: "SIMULATED" },
        observedAt: new Date("2026-09-20T04:00:00.000Z"),
      }),
    },
    commitment: { count: async () => 0 },
    agentCellPosition: {
      findUnique: async () => (mirrorShardId === null ? null : { shardId: mirrorShardId }),
    },
    shard: { findMany: async () => shards },
  };
}

/** A charging classifier that answers definitely, so the sweep's own narrowings do not fire. */
const knownIdle = async () => ({ known: true, charging: false, chargingInterruptible: false, waiting: false, projectedFreeAtMs: null });

describe("indexMaintainer.assembleRecord — the owning shard is read, never assumed", () => {
  test("publishes the shard on the agent's own durable mirror row", async () => {
    const record = await indexMaintainer.assembleRecord(
      { prisma: storeWith({ mirrorShardId: "v1demo-shard" }), chargingStatusFor: knownIdle },
      "agent-row-1",
      Date.now(),
    );

    expect(record).not.toBeNull();
    // The defect: this was the literal string "default" for every deployment.
    expect(record.shardId).toBe("v1demo-shard");
  });

  test("falls back to the ACTIVE shard published for the agent's region when no mirror row exists yet", async () => {
    const record = await indexMaintainer.assembleRecord(
      {
        prisma: storeWith({
          regionId: "region-row-1",
          mirrorShardId: null,
          shards: [{ shardId: "v1demo-shard", state: "ACTIVE" }],
        }),
        chargingStatusFor: knownIdle,
      },
      "agent-row-1",
      Date.now(),
    );

    expect(record).not.toBeNull();
    expect(record.shardId).toBe("v1demo-shard");
  });

  test("a shard that is not admitting work does not become this agent's shard", async () => {
    const record = await indexMaintainer.assembleRecord(
      {
        prisma: storeWith({
          regionId: "region-row-1",
          mirrorShardId: null,
          shards: [{ shardId: "draining-shard", state: "DRAINING" }],
        }),
        chargingStatusFor: knownIdle,
      },
      "agent-row-1",
      Date.now(),
    );

    // Not indexed at all. §3.3 I16 makes the index advisory, so an absent agent costs
    // candidate quality; an agent indexed under a shard that is not admitting work is
    // invisible to its own coordinator and visible to another's.
    expect(record).toBeNull();
  });

  test("an agent whose shard cannot be established is not indexed under a constant", async () => {
    const record = await indexMaintainer.assembleRecord(
      { prisma: storeWith({ regionId: null, mirrorShardId: null, shards: [] }), chargingStatusFor: knownIdle },
      "agent-row-1",
      Date.now(),
    );

    expect(record).toBeNull();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   2. The priced-candidate memo answers to every identifier the round resolved.
   ═══════════════════════════════════════════════════════════════════════════ */

describe("coordinatorSolvePath — the priced-candidate memo is keyed on one canonical agent", () => {
  /**
   * The three identifiers the round genuinely sees for one agent, and where each comes
   * from. The memo must answer to all three or a correct pairing is dropped in silence.
   */
  const ROW_ID = "agent-row-1"; // availabilityIndex → expansion → candidate.agentId
  const BUSINESS_ID = "AGENT-1"; // the agent snapshot, the column, the locked Agent row

  // The cross-identifier memo lookup is asserted against the REAL assembly in
  // `coordinatorSolvePathComposition.test.js`, which owns the complete-context fixture
  // `create()` requires. Reimplementing the canonicaliser here would assert this file's
  // own arithmetic, which is the shape of test that let the defect ship.

  test("agentSnapshotLoaderFor resolves either identifier to the same position row", async () => {
    const seen = [];
    const position = {
      lat: 12.9007,
      lon: 77.5176,
      fineCellId: "8b6014510498fff",
      coarseCellId: "85601453fffffff",
      availabilityClass: "IDLE_READY",
      capabilityClasses: [],
      containerClasses: [],
      observedAtMs: BigInt(Date.now()),
      agent: {
        id: ROW_ID,
        agentId: BUSINESS_ID,
        lifecycleState: "ACTIVE",
        authorityEpoch: 0n,
        fenceCounter: 0n,
        commitments: [],
        agentClass: null,
        batteryState: null,
      },
    };

    const load = coordinatorSolvePath.agentSnapshotLoaderFor({
      prisma: {
        agentCellPosition: {
          findFirst: async (args) => {
            seen.push(args.where);
            return position;
          },
        },
      },
    });

    const byRow = await load(ROW_ID);
    const byBusiness = await load(BUSINESS_ID);

    expect(byRow.agentRowId).toBe(ROW_ID);
    expect(byBusiness.agentRowId).toBe(ROW_ID);
    // The query accepts both spellings rather than only the foreign key.
    for (const where of seen) {
      expect(Array.isArray(where.OR)).toBe(true);
      expect(where.OR).toEqual([{ agentId: expect.any(String) }, { agent: { agentId: expect.any(String) } }]);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   2b. The cold index is rebuilt before the first sweep.
   ═══════════════════════════════════════════════════════════════════════════ */

describe("indexMaintainer.start — a cold index is repopulated from the durable mirror", () => {
  /** A kv double recording set membership, as `availabilityIndex` writes it. */
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
    };
  }

  test("start() rebuilds from AgentCellPosition, so a restart with an empty index finds the fleet", async () => {
    // ── The defect this pins ────────────────────────────────────────────────
    // `applyPosition` writes only the DELTA between the previous mirror row and the new
    // one. On a cold index the mirror already matches what the sweep computes, so `toAdd`
    // is empty, `sweepOnce` reports `indexed: 1`, and nothing is written. The index stays
    // empty until an agent moves — and `rebuildIndexFromMirror`, the shipped answer, was
    // exported and called from nowhere.
    const kv = recordingKv();
    const prisma = {
      agentCellPosition: {
        findMany: async () => [
          {
            agentId: "agent-row-1",
            shardId: "v1demo-shard",
            lat: 12.9007,
            lon: 77.5176,
            fineCellId: "8b6014510498fff",
            coarseCellId: "85601453fffffff",
            availabilityClass: "IDLE_READY",
            capabilityClasses: [],
            containerClasses: [],
          },
        ],
      },
      agent: { findMany: async () => [] },
    };

    const handle = indexMaintainer.start({ prisma, kv }, { intervalMs: 60_000 });
    // The rebuild is kicked off synchronously by `start()`; let its promise settle.
    await new Promise((resolve) => setImmediate(resolve));
    handle.stop();

    const written = [...kv.sets.entries()].filter(([, members]) => members.has("agent-row-1"));
    expect(written.length).toBeGreaterThan(0);
    // Under the shard the mirror row names — not under a constant.
    expect(written.some(([key]) => key.includes("v1demo-shard"))).toBe(true);
    expect(written.some(([key]) => key.includes("default"))).toBe(false);
  });

  test("rebuildOnStart:false is honoured, for a caller that has already rebuilt", async () => {
    const kv = recordingKv();
    let read = 0;
    const prisma = {
      agentCellPosition: {
        findMany: async () => {
          read += 1;
          return [];
        },
      },
      agent: { findMany: async () => [] },
    };

    const handle = indexMaintainer.start({ prisma, kv }, { intervalMs: 60_000, rebuildOnStart: false });
    await new Promise((resolve) => setImmediate(resolve));
    handle.stop();

    expect(read).toBe(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   3. The simulated fleet's charger can be routed to — and it is the depot (P7-D3 Step 0).
   ═══════════════════════════════════════════════════════════════════════════ */

describe("devChargingScheduler — the declared charger can be routed to", () => {
  // Before P7-D3 Step 0 the scheduler upserted its own row and had to derive the cell
  // `chargerCandidatesFor` requires from its declared coordinate. It now charges at the V1
  // depot, whose row (cell included) the seed writes; the scheduler reads it, never writes it,
  // and refuses one that states no cell.
  const depot = {
    id: "charger-row-1",
    chargerId: "V1DEMO-DEPOT-01",
    cellId: cells.cellForPoint(12.900729, 77.517603, cells.RESOLUTION.FINE),
    chargerClass: "STANDARD",
    isDepot: true,
    latitude: 12.900729,
    longitude: 77.517603,
  };

  function prismaWith(row) {
    const writes = [];
    return {
      writes,
      charger: {
        findUnique: async ({ where }) => (row && where.chargerId === row.chargerId ? { ...row } : null),
        upsert: async (args) => { writes.push(args); return null; },
        update: async (args) => { writes.push(args); return null; },
        create: async (args) => { writes.push(args); return null; },
      },
      chargerAvailabilityProjection: {
        findFirst: async () => null,
        create: async (args) => ({ version: 1, ...args.data }),
      },
    };
  }

  test("provision reads the depot row and writes no Charger field", async () => {
    const prisma = prismaWith(depot);
    const outcome = await devChargingScheduler.provision({ prisma }, { nowMs: Date.parse("2026-09-20T04:00:00.000Z") });

    expect(outcome).toMatchObject({ ok: true, chargerDbId: "charger-row-1", published: true });
    expect(prisma.writes).toEqual([]);
  });

  test("a depot row that states no cell is refused — it could not be routed to", async () => {
    const prisma = prismaWith({ ...depot, cellId: null });
    const outcome = await devChargingScheduler.provision({ prisma }, { nowMs: Date.parse("2026-09-20T04:00:00.000Z") });

    expect(outcome.ok).toBe(false);
    expect(outcome.problems.join(" ")).toMatch(/states no cell/);
  });

  test("the declared charger is a depot, so the engine's DEPOT_ONLY return target and the simulator's charger are one row", () => {
    expect(devChargingScheduler.DEVELOPMENT_CHARGER.chargerId).toBe("V1DEMO-DEPOT-01");
    expect(devChargingScheduler.depotProblems(depot)).toEqual([]);
    expect(devChargingScheduler.depotProblems({ ...depot, isDepot: false }).join(" ")).toMatch(/is not a depot/);
  });
});
