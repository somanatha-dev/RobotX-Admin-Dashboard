"use strict";

/**
 * Engine lane — Phase 13: the shard model and shard resolution at intake (§3.5).
 *
 * The property this file exists to protect is the one §3.5 states in a single clause and
 * that everything else depends on: **"Every Leg is routed to exactly one shard at intake,
 * determined by its first Stop's region."** That is only well defined if region → shard is
 * a function, so a definition set that breaks it is refused at publish rather than at the
 * first Leg intake cannot route.
 */

const intake = require("../../src/engine/intake/intake");
const leadership = require("../../src/engine/shard/leadership");
const shardModel = require("../../src/engine/shard/shardModel");
const { memoryStore, twoShardWorld } = require("./helpers/shardFixture");

describe("the shard-state vocabulary (§3.5)", () => {
  test("the four states are exactly those the migration's CHECK admits", () => {
    expect(shardModel.SHARD_STATES).toEqual(["ACTIVE", "REBALANCING", "DRAINING", "RETIRED"]);
  });

  test("ACTIVE and REBALANCING admit new work; DRAINING and RETIRED do not", () => {
    expect(shardModel.admitsNewWork("ACTIVE")).toBe(true);
    expect(shardModel.admitsNewWork("REBALANCING")).toBe(true);
    expect(shardModel.admitsNewWork("DRAINING")).toBe(false);
    expect(shardModel.admitsNewWork("RETIRED")).toBe(false);
  });

  // T2 — unknown is never permission. A state nobody defined the routing rule for is a
  // state nobody decided the routing rule for.
  test("an unrecognised state admits nothing and is not a shard state", () => {
    expect(shardModel.admitsNewWork("PROBABLY_FINE")).toBe(false);
    expect(shardModel.isShardState("PROBABLY_FINE")).toBe(false);
    expect(shardModel.isShardState(undefined)).toBe(false);
  });

  test("setState refuses a state outside the vocabulary", async () => {
    const prisma = memoryStore(twoShardWorld());
    await expect(shardModel.setState({ prisma }, { shardId: "shard-north", state: "SORT_OF_ACTIVE" })).rejects.toThrow(
      /is not a shard state/,
    );
  });

  test("DRAINING carries its instant, and leaving DRAINING clears it — the schema CHECK's other half", async () => {
    const prisma = memoryStore(twoShardWorld());
    const at = new Date(1770000000000);

    const draining = await shardModel.setState({ prisma }, { shardId: "shard-north", state: "DRAINING", at });
    expect(draining.drainingSince).toEqual(at);

    const active = await shardModel.setState({ prisma }, { shardId: "shard-north", state: "ACTIVE", at });
    expect(active.drainingSince).toBeNull();
  });
});

describe("definition validation (§3.5)", () => {
  test("a shard names a shard id and a region", () => {
    expect(shardModel.validateDefinition({ shardId: "s1", regionId: "r1" })).toEqual([]);
    expect(shardModel.validateDefinition({ regionId: "r1" })[0]).toMatch(/names its shard id/);
    expect(shardModel.validateDefinition({ shardId: "s1" })[0]).toMatch(/names no OperatingRegion/);
  });

  // The load-bearing one.
  test("two shards claiming one region is refused — region → shard must be a function", () => {
    const result = shardModel.validateDefinitions([
      { shardId: "s1", regionId: "metro" },
      { shardId: "s2", regionId: "metro" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/region "metro" is claimed by both/);
    expect(result.problems.join(" ")).toMatch(/split by redistricting the region into two/);
  });

  test("a duplicated shard id is refused", () => {
    const result = shardModel.validateDefinitions([
      { shardId: "s1", regionId: "north" },
      { shardId: "s1", regionId: "south" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/is defined twice/);
  });

  test("a well-formed multi-shard set passes", () => {
    expect(
      shardModel.validateDefinitions([
        { shardId: "s1", regionId: "north" },
        { shardId: "s2", regionId: "south", state: "DRAINING" },
      ]),
    ).toEqual({ ok: true, problems: [] });
  });
});

describe("the published region → shard map", () => {
  test("only shards that admit work appear", () => {
    const map = shardModel.regionShardMap([
      { shardId: "s1", regionId: "north", state: "ACTIVE" },
      { shardId: "s2", regionId: "south", state: "REBALANCING" },
      { shardId: "s3", regionId: "east", state: "DRAINING" },
      { shardId: "s4", regionId: "west", state: "RETIRED" },
    ]);
    expect(map).toEqual({ north: "s1", south: "s2" });
  });

  test("an empty table produces an empty map — the single-shard deployment's signal", async () => {
    const prisma = memoryStore();
    expect(await shardModel.readRegionShardMap({ prisma })).toEqual({});
  });
});

describe("ensureShard — the shard and its leadership row are created together", () => {
  test("the leadership row exists after creation, so guard G1 has a row to compare against", async () => {
    const prisma = memoryStore();
    const outcome = await shardModel.ensureShard({ prisma }, { shardId: "s1", regionId: "north" });

    expect(outcome.created).toBe(true);
    expect(prisma.__store.shardLeadership).toHaveLength(1);
    expect(prisma.__store.shardLeadership[0].shardId).toBe("s1");
    expect(prisma.__store.shardLeadership[0].leadershipFence).toBe(1);
  });

  test("it is idempotent, and does not reset an existing fence — a monotone counter never goes backwards", async () => {
    const prisma = memoryStore({
      shardLeadership: [{ id: "sl", shardId: "s1", leadershipFence: 97n, holder: "coordinator-x", leaseExpiry: null }],
    });
    await shardModel.ensureShard({ prisma }, { shardId: "s1", regionId: "north" });
    await shardModel.ensureShard({ prisma }, { shardId: "s1", regionId: "north" });

    expect(prisma.__store.shard).toHaveLength(1);
    expect(prisma.__store.shardLeadership[0].leadershipFence).toBe(97n);
  });

  test("an invalid definition is refused before anything is written", async () => {
    const prisma = memoryStore();
    await expect(shardModel.ensureShard({ prisma }, { shardId: "s1" })).rejects.toThrow(/invalid definition/);
    expect(prisma.__store.shard).toEqual([]);
    expect(prisma.__store.shardLeadership).toEqual([]);
  });
});

describe("shard resolution at intake (§3.5)", () => {
  test("no published map means the single-shard deployment, and the reason is recorded", () => {
    const resolved = intake.resolveShard({ firstStop: { regionId: "north" } });
    expect(resolved).toMatchObject({ ok: true, shardId: leadership.DEFAULT_SHARD_ID, resolvedBy: "SINGLE_SHARD_DEPLOYMENT" });
  });

  test("a published map routes by the first Stop's region", () => {
    const resolved = intake.resolveShard({ firstStop: { regionId: "north" }, shardByRegionId: { north: "s1", south: "s2" } });
    expect(resolved).toMatchObject({ ok: true, shardId: "s1", resolvedBy: "REGION_MAP" });
  });

  test("a Leg with no region is refused when a map is published", () => {
    const resolved = intake.resolveShard({ firstStop: {}, shardByRegionId: { north: "s1" } });
    expect(resolved.ok).toBe(false);
    expect(resolved.reason).toMatch(/names no OperatingRegion/);
  });

  // PHASE 13's distinction: unmapped and draining are different operational facts, and an
  // operator resolves them differently.
  test("a draining region is refused **by name**, distinctly from an unmapped one", () => {
    const draining = intake.resolveShard({
      firstStop: { regionId: "east" },
      shardByRegionId: { north: "s1" },
      notAdmittingRegions: { east: "DRAINING" },
    });
    expect(draining.ok).toBe(false);
    expect(draining.reason).toMatch(/is owned by a shard in state DRAINING/);
    expect(draining.reason).toMatch(/it is draining/);

    const unmapped = intake.resolveShard({ firstStop: { regionId: "west" }, shardByRegionId: { north: "s1" } });
    expect(unmapped.reason).toMatch(/not in the published region→shard map/);
    expect(unmapped.reason).not.toMatch(/draining/);
  });

  test("resolveShardFor reads the published map from the Shard table", async () => {
    const prisma = memoryStore(twoShardWorld());
    expect(await intake.resolveShardFor({ prisma }, { regionId: "region-north" })).toMatchObject({
      ok: true,
      shardId: "shard-north",
      resolvedBy: "REGION_MAP",
    });
  });

  test("resolveShardFor refuses a region whose shard is draining", async () => {
    const world = twoShardWorld();
    world.shard[1].state = "DRAINING";
    const prisma = memoryStore(world);

    const resolved = await intake.resolveShardFor({ prisma }, { regionId: "region-south" });
    expect(resolved.ok).toBe(false);
    expect(resolved.reason).toMatch(/state DRAINING/);
  });

  test("resolveShard stays pure — it performs no store read and replays identically", () => {
    const input = { firstStop: { regionId: "north" }, shardByRegionId: { north: "s1" } };
    expect(intake.resolveShard(input)).toEqual(intake.resolveShard(input));
    // The source-level half: the pure function's body names no client.
    const source = require("fs").readFileSync(require.resolve("../../src/engine/intake/intake.js"), "utf8");
    const body = source
      .slice(source.indexOf("function resolveShard(input)"), source.indexOf("async function resolveShardFor"))
      // Comments stripped: this asserts a property of the *code*, and the prose around it
      // necessarily names the store read the code does not perform.
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(body).not.toMatch(/prisma|await/);
  });

  test("admit() resolves from the store only when asked to — every existing caller is unchanged", async () => {
    const prisma = memoryStore(twoShardWorld());
    const base = {
      legId: "leg-x",
      purpose: "PRIMARY",
      receivedAtMs: 1770000000000,
      shardResolution: { regionId: "region-north" },
    };

    // Default: the pure path, no map supplied, single-shard deployment.
    const withoutStore = await intake.admit({ prisma }, base);
    expect(withoutStore.shardId).toBe(leadership.DEFAULT_SHARD_ID);

    // Opt-in: the published map.
    const withStore = await intake.admit({ prisma }, { ...base, legId: "leg-y", resolveShardFromStore: true });
    expect(withStore.shardId).toBe("shard-north");
  });
});

describe("describe() — the projection GET /api/shards renders", () => {
  test("the fence is a string, because JSON has no BigInt that survives a round trip", () => {
    const described = shardModel.describe({
      shard: { shardId: "s1", regionId: "north", state: "ACTIVE", agentCount: 12, lastFailoverReconstructedLegs: 3, roundsResumableAt: new Date(0) },
      leadership: { holder: "coordinator-a", leadershipFence: 42n, leaseExpiry: null },
      sizing: null,
    });
    expect(described.leadership.leadershipFence).toBe("42");
    expect(described.failover.reconstructedLegs).toBe(3);
    expect(described.failover.roundsResumable).toBe(true);
    expect(described.admitsNewWork).toBe(true);
  });

  test("an unled shard reports its leadership as absent rather than as an empty holder", () => {
    const described = shardModel.describe({ shard: { shardId: "s1", state: "ACTIVE" }, leadership: null });
    expect(described.leadership).toBeNull();
    expect(described.failover.roundsResumable).toBe(false);
  });
});
