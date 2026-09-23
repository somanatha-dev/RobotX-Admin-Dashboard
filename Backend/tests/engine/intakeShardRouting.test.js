"use strict";

/**
 * §3.5 — "Every Leg is routed to exactly one shard at intake, determined by its first
 * Stop's region" — on the **production request path**.
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 * Phase 13 built the store-backed resolver (`intake.resolveShardFor`) and made
 * `intake.admit` consult it only when asked (`resolveShardFromStore: true`), so that a
 * round replaying against a pinned snapshot could not acquire a store read the original
 * decision never made (§9.6 requirement 5, T6).
 *
 * **Nothing ever asked.** `resolveShardFromStore` had no caller outside one unit test, and
 * no production caller supplied `shardByRegionId` either — so `resolveShard` saw an empty
 * map on every live submission, read that as "no region→shard map is published", and
 * returned `SINGLE_SHARD_DEPLOYMENT` with `leadership.DEFAULT_SHARD_ID`. Every Leg the
 * running system admitted was filed under `"default"`, whatever the `Shard` table said.
 *
 * `coordinator.worker.claimBatch` selects `where: { shardId }` against the coordinator's
 * own `SHARD_ID`, so those rows were invisible to the coordinator that owned the region:
 * work durably accepted, correctly queued, and drained by nobody — the unowned in-flight
 * state §12.1 exists to make unrepresentable. Observed on a live PostgreSQL with
 * `WorkQueue.shardId="default"` while the published shard for the region was the leader.
 *
 * The assertions below are therefore end-to-end through the real modules: the real
 * `task.service.admitToRound`, the real `intake.admit`, the real `coordinator.claimBatch`,
 * against an in-memory store that models the `Shard` and `WorkQueue` tables. Nothing here
 * asserts on an intermediate value the production path does not itself compute.
 */

jest.mock("../../src/services/mapbox.service");
jest.mock("../../src/services/commandDispatcher.service");
jest.mock("../../src/services/metrics.service");

const taskService = require("../../src/services/task.service");
const intake = require("../../src/engine/intake/intake");
const coordinator = require("../../src/workers/coordinator.worker");
const leadership = require("../../src/engine/shard/leadership");
const fixture = require("./helpers/roundFixture");

const RECEIVED_AT_MS = 1_800_000_000_000;
const STORE_NOW = new Date(RECEIVED_AT_MS);

/**
 * Two published shards over two regions, keyed the way the database keys them.
 *
 * `Shard.regionId` is the foreign key to `Region.id` — a uuid — not the operator-facing
 * `Region.regionId`. The request path translates the caller's business key to the row id
 * before it gets here, so these are row ids, and they are deliberately not the readable
 * names: a fixture that used one value for both could not tell a correct routing from a
 * coincidence.
 */
const REGION_NORTH = "11111111-1111-4111-8111-111111111111";
const REGION_SOUTH = "22222222-2222-4222-8222-222222222222";
const REGION_UNPUBLISHED = "33333333-3333-4333-8333-333333333333";
const SHARD_NORTH = "shard-north";
const SHARD_SOUTH = "shard-south";

function legacyTaskRow(taskId) {
  return {
    id: `db-${taskId}`,
    taskId,
    status: "PENDING",
    pickup: "Building A",
    drop: "Building B",
    pickupLat: 1,
    pickupLon: 1,
    dropLat: 2,
    dropLon: 2,
    robot: null,
  };
}

/**
 * The in-memory store the bridge writes into, plus the §2.4 tables `admitToRound`
 * materialises. `workQueue` and `shard` come from the shared round fixture, so the queue
 * the coordinator reads is the same one intake wrote.
 */
function bridgeStore(publishedShards) {
  const prisma = fixture.memoryPrisma();
  const missions = [];
  const legs = [];
  const stops = [];
  const tasks = [];
  const identities = [];

  for (const shard of publishedShards || []) prisma.__tables.shards.push({ ...shard });

  const upsertInto = (rows) => async ({ where, create }) => {
    const existing = rows.find((row) => row.id === where.id);
    if (existing) return { ...existing };
    rows.push({ ...create });
    return { ...create };
  };
  const updateIn = (rows, key) => async ({ where, data }) => {
    const existing = rows.find((row) => row[key] === where[key]);
    if (!existing) throw new Error(`no row with ${key}=${String(where[key])}`);
    Object.assign(existing, data);
    return { ...existing };
  };

  prisma.mission = { upsert: upsertInto(missions) };
  prisma.leg = {
    upsert: upsertInto(legs),
    update: updateIn(legs, "id"),
    findUnique: async ({ where }) => {
      const row = legs.find((entry) => entry.id === where.id);
      return row ? { ...row } : null;
    },
  };
  prisma.stop = { upsert: upsertInto(stops), update: updateIn(stops, "id") };
  prisma.task = {
    update: async ({ where, data }) => {
      let existing = tasks.find((row) => row.id === where.id);
      if (!existing) {
        existing = { id: where.id };
        tasks.push(existing);
      }
      Object.assign(existing, data);
      return { ...existing };
    },
  };
  prisma.identityRecord = {
    findUnique: async ({ where }) => identities.find((row) => row.surrogateKey === where.surrogateKey) || null,
    create: async ({ data }) => {
      identities.push({ ...data });
      return { ...data };
    },
    update: updateIn(identities, "surrogateKey"),
  };
  const timers = [];
  prisma.timer = {
    count: async () => 0,
    findUnique: async ({ where }) => timers.find((row) => row.timerKey === where.timerKey) || null,
    create: async ({ data }) => {
      const row = { id: `TMR-${timers.length + 1}`, createdAt: STORE_NOW, ...data };
      timers.push(row);
      return { ...row };
    },
    update: updateIn(timers, "id"),
  };
  prisma.$queryRawUnsafe = async () => [{ now: STORE_NOW }];
  prisma.$transaction = async (run) => {
    const { $transaction, ...tx } = prisma;
    return run(tx);
  };

  prisma.__bridge = { missions, legs, stops, tasks, identities, timers };
  return prisma;
}

const ACTIVE_ESTATE = [
  { shardId: SHARD_NORTH, regionId: REGION_NORTH, state: "ACTIVE" },
  { shardId: SHARD_SOUTH, regionId: REGION_SOUTH, state: "ACTIVE" },
];

const admit = (prisma, taskId, options) =>
  taskService.admitToRound(prisma, legacyTaskRow(taskId), {
    receivedAtMs: RECEIVED_AT_MS,
    cadenceConfig: fixture.cadenceConfig(),
    feasibleSupply: 3,
    ...(options || {}),
  });

describe("the request path routes a Leg to the shard that owns its region", () => {
  test("a published region resolves to its published shard, and the basis is recorded", async () => {
    const prisma = bridgeStore(ACTIVE_ESTATE);
    const response = await admit(prisma, "TSK-SHARD-1", { regionId: REGION_NORTH });

    expect(response.accepted).toBe(true);
    expect(response.shardId).toBe(SHARD_NORTH);
  });

  test("the WorkQueue row carries the published shard id, not the default", async () => {
    const prisma = bridgeStore(ACTIVE_ESTATE);
    await admit(prisma, "TSK-SHARD-2", { regionId: REGION_SOUTH });

    const [row] = prisma.__tables.workQueue;
    expect(row.shardId).toBe(SHARD_SOUTH);
    // Named explicitly: this exact value is what made the row invisible to the coordinator.
    expect(row.shardId).not.toBe(leadership.DEFAULT_SHARD_ID);
  });

  test("two regions route to two different shards from one published estate", async () => {
    const prisma = bridgeStore(ACTIVE_ESTATE);
    await admit(prisma, "TSK-SHARD-3", { regionId: REGION_NORTH });
    await admit(prisma, "TSK-SHARD-4", { regionId: REGION_SOUTH });

    expect(prisma.__tables.workQueue.map((row) => row.shardId)).toEqual([SHARD_NORTH, SHARD_SOUTH]);
  });

  test("the coordinator for that shard can claim the queued work", async () => {
    const prisma = bridgeStore(ACTIVE_ESTATE);
    await admit(prisma, "TSK-SHARD-5", { regionId: REGION_NORTH });

    const claimed = await coordinator.claimBatch(
      { prisma },
      { shardId: SHARD_NORTH, roundId: "round-1", storeTime: STORE_NOW, limit: 10 },
    );

    expect(claimed).toHaveLength(1);
    expect(claimed[0].shardId).toBe(SHARD_NORTH);
    expect(claimed[0].state).toBe(intake.QUEUE_STATE.CLAIMED);
    expect(claimed[0].claimedByRoundId).toBe("round-1");
    // And the durable row moved with it, rather than the claim living in the return value.
    expect(prisma.__tables.workQueue[0].state).toBe(intake.QUEUE_STATE.CLAIMED);
  });

  // The defect, stated as the thing that used to happen. A row filed under "default" is
  // not merely mislabelled: `claimBatch` filters on `shardId`, so the owning coordinator
  // never sees it and nothing else does either.
  test("a row filed under the default shard is invisible to the owning coordinator", async () => {
    const prisma = bridgeStore(ACTIVE_ESTATE);
    await admit(prisma, "TSK-SHARD-6", { regionId: REGION_NORTH });
    // Simulate the pre-fix state on the row that was just correctly written.
    prisma.__tables.workQueue[0].shardId = leadership.DEFAULT_SHARD_ID;

    const claimed = await coordinator.claimBatch(
      { prisma },
      { shardId: SHARD_NORTH, roundId: "round-1", storeTime: STORE_NOW, limit: 10 },
    );
    expect(claimed).toHaveLength(0);
  });
});

describe("an unresolvable shard is refused cleanly, and nothing durable is written", () => {
  test("a region absent from the published estate is declined by name", async () => {
    const prisma = bridgeStore(ACTIVE_ESTATE);
    const response = await admit(prisma, "TSK-SHARD-7", { regionId: REGION_UNPUBLISHED });

    expect(response.accepted).toBe(false);
    expect(response.reason).toBe("SHARD_UNRESOLVED");
    expect(response.sentence).toMatch(/not in the published region→shard map/);
    expect(prisma.__tables.workQueue).toHaveLength(0);
  });

  test("a submission naming no region is refused once an estate is published", async () => {
    const prisma = bridgeStore(ACTIVE_ESTATE);
    const response = await admit(prisma, "TSK-SHARD-8", { regionId: null });

    expect(response.accepted).toBe(false);
    expect(response.sentence).toMatch(/names no OperatingRegion/);
    expect(prisma.__tables.workQueue).toHaveLength(0);
  });

  test("a region whose shard is draining is refused by its own name, not routed to default", async () => {
    const prisma = bridgeStore([
      { shardId: SHARD_NORTH, regionId: REGION_NORTH, state: "ACTIVE" },
      { shardId: SHARD_SOUTH, regionId: REGION_SOUTH, state: "DRAINING" },
    ]);
    const response = await admit(prisma, "TSK-SHARD-9", { regionId: REGION_SOUTH });

    expect(response.accepted).toBe(false);
    expect(response.sentence).toMatch(/state DRAINING/);
    expect(response.sentence).toMatch(/it is draining/);
    expect(prisma.__tables.workQueue).toHaveLength(0);
  });

  // §19.2's REBALANCING shard still admits work — the omission is only of shards that do
  // not. Asserted so "reads the store" is not quietly narrowed to "reads ACTIVE shards".
  test("a REBALANCING shard still admits new work", async () => {
    const prisma = bridgeStore([{ shardId: SHARD_NORTH, regionId: REGION_NORTH, state: "REBALANCING" }]);
    const response = await admit(prisma, "TSK-SHARD-10", { regionId: REGION_NORTH });

    expect(response.accepted).toBe(true);
    expect(response.shardId).toBe(SHARD_NORTH);
  });
});

describe("the single-shard fallback applies only where it is documented to", () => {
  test("an empty Shard table is the single-shard deployment, and still routes to the default", async () => {
    const prisma = bridgeStore([]);
    const response = await admit(prisma, "TSK-SHARD-11", { regionId: REGION_NORTH });

    expect(response.accepted).toBe(true);
    expect(response.shardId).toBe(leadership.DEFAULT_SHARD_ID);
    expect(prisma.__tables.workQueue[0].shardId).toBe(leadership.DEFAULT_SHARD_ID);
  });

  test("an empty Shard table and no region is still admitted — the region is not yet a deployed concept", async () => {
    const prisma = bridgeStore([]);
    const response = await admit(prisma, "TSK-SHARD-12", { regionId: null });

    expect(response.accepted).toBe(true);
    expect(response.shardId).toBe(leadership.DEFAULT_SHARD_ID);
  });

  // ── The half of the fallback that was silently wrong ─────────────────────────
  //
  // `shardByRegionId` omits shards that do not admit work, so an estate that is entirely
  // DRAINING produced an *empty* map — indistinguishable, to the old test, from "no shard
  // has ever been published" — and landed the Leg on the default shard. That is the
  // single-shard fallback overriding a published estate, and it is refused now.
  // `shard/failover.js` records hitting the identical reading from the other side.
  test("an estate that is entirely draining is NOT a single-shard deployment", async () => {
    const prisma = bridgeStore([
      { shardId: SHARD_NORTH, regionId: REGION_NORTH, state: "DRAINING" },
      { shardId: SHARD_SOUTH, regionId: REGION_SOUTH, state: "RETIRED" },
    ]);
    const response = await admit(prisma, "TSK-SHARD-13", { regionId: REGION_NORTH });

    expect(response.accepted).toBe(false);
    expect(response.sentence).toMatch(/state DRAINING/);
    expect(prisma.__tables.workQueue).toHaveLength(0);
  });

  test("the pure rule agrees: a non-admitting estate is a published estate", () => {
    // Held at the rule as well as at the path, because this is the condition the fallback
    // turns on and it has no other guard.
    expect(intake.resolveShard({ regionId: "r", shardByRegionId: {}, notAdmittingRegions: { r: "DRAINING" } })).
      toMatchObject({ ok: false });
    expect(intake.resolveShard({ regionId: "r", shardByRegionId: {}, notAdmittingRegions: {} })).toMatchObject({
      ok: true,
      shardId: leadership.DEFAULT_SHARD_ID,
      resolvedBy: "SINGLE_SHARD_DEPLOYMENT",
    });
  });
});

describe("an explicitly supplied region→shard map still wins", () => {
  // A caller that names a map means it — a replay, a simulation, a rebalance rehearsal —
  // and `resolveShardFor` would overwrite it with the store's. So the store is consulted
  // exactly when no map was supplied.
  test("the caller's map is honoured and the store is not consulted", async () => {
    const prisma = bridgeStore(ACTIVE_ESTATE);
    let storeReads = 0;
    const findMany = prisma.shard.findMany;
    prisma.shard.findMany = async (...args) => {
      storeReads += 1;
      return findMany(...args);
    };

    const response = await admit(prisma, "TSK-SHARD-14", {
      regionId: REGION_NORTH,
      // Deliberately disagrees with the published estate, so "the caller's map won" is
      // distinguishable from "both happened to say the same thing".
      shardByRegionId: { [REGION_NORTH]: "shard-from-the-caller" },
    });

    expect(response.shardId).toBe("shard-from-the-caller");
    expect(prisma.__tables.workQueue[0].shardId).toBe("shard-from-the-caller");
    expect(storeReads).toBe(0);
  });

  test("an explicit map that does not cover the region still refuses rather than falling back", async () => {
    const prisma = bridgeStore(ACTIVE_ESTATE);
    const response = await admit(prisma, "TSK-SHARD-15", {
      regionId: REGION_SOUTH,
      shardByRegionId: { [REGION_NORTH]: "shard-from-the-caller" },
    });

    expect(response.accepted).toBe(false);
    expect(response.reason).toBe("SHARD_UNRESOLVED");
  });

  test("an EMPTY map is not a map — it does not suppress the store read", async () => {
    // The reading that caused the defect: an empty map treated as a published one. A
    // caller with no map must reach the store, or the fix is off by exactly this case.
    const prisma = bridgeStore(ACTIVE_ESTATE);
    const response = await admit(prisma, "TSK-SHARD-16", { regionId: REGION_NORTH, shardByRegionId: {} });

    expect(response.shardId).toBe(SHARD_NORTH);
  });
});

describe("intake.admit's own opt-in is unchanged — replay callers keep the pure path", () => {
  test("admit() without the flag performs no store read, whatever the Shard table holds", async () => {
    const prisma = bridgeStore(ACTIVE_ESTATE);
    let storeReads = 0;
    const findMany = prisma.shard.findMany;
    prisma.shard.findMany = async (...args) => {
      storeReads += 1;
      return findMany(...args);
    };

    const response = await intake.admit(
      { prisma },
      {
        legId: "leg-replay",
        purpose: "PRIMARY",
        receivedAtMs: RECEIVED_AT_MS,
        shardResolution: { regionId: REGION_NORTH },
      },
    );

    expect(storeReads).toBe(0);
    expect(response.shardId).toBe(leadership.DEFAULT_SHARD_ID);
  });
});
