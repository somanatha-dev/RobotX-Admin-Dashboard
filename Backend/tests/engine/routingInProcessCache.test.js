"use strict";

/**
 * The in-process routing cache tier (§20.1, §20.3) — correctness, not speed.
 *
 * Speed is measured by `tools/routing/inProcessCacheBenchmark.js`, which is a diagnostic
 * measurement and not a gate. What is asserted here is the set of properties that make the
 * tier safe to put in front of Redis at all, and every one of them is a property the routing
 * caches' callers already depend on:
 *
 *   · a hit returns exactly what was written, byte for byte;
 *   · a version — profile, time bucket, charger-availability projection — is a different
 *     key, never a stale hit (§20.3 items 2 and 3);
 *   · a namespace — configuration version, spatial map version, shard — is an epoch, and an
 *     entry cannot cross one (§3.6: a cell id is an opaque token from the published map);
 *   · an L1 entry never outlives its L2 counterpart;
 *   · expiry is evaluated against an injected instant, never a host clock (T6, §9.6);
 *   · the bound holds and eviction is deterministic;
 *   · a Redis failure is a miss and never a stale answer (I16);
 *   · both shipped cache modules work through the façade **unchanged**.
 *
 * That last one is the point of the whole design and is asserted end to end.
 */

const cellPairCache = require("../../src/engine/routing/cellPairCache");
const chargerCache = require("../../src/engine/routing/chargerReachabilityCache");
const inProcess = require("../../src/engine/routing/inProcessCache");

const NAMESPACE = "cfg:7|map:3|shard:SHD-A";
const TTL_MS = 60_000;
const NOW = 1_700_000_000_000;

/** A minimal kv double with fault injection. Faithful: the caches are never an authority. */
function fakeKv() {
  const store = new Map();
  const client = {
    getCalls: 0,
    setCalls: 0,
    failGet: false,
    failSet: false,
    async get(key) {
      client.getCalls += 1;
      if (client.failGet) throw new Error("redis unavailable");
      return store.has(key) ? store.get(key) : null;
    },
    async set(key, value) {
      client.setCalls += 1;
      if (client.failSet) throw new Error("redis unavailable");
      store.set(key, value);
      return "OK";
    },
    store,
  };
  return client;
}

function tier(overrides) {
  return inProcess.createTier({
    maxEntries: 100,
    ttlMs: TTL_MS,
    namespace: NAMESPACE,
    population: inProcess.POPULATION.CELL_PAIR,
    ...overrides,
  });
}

describe("in-process routing cache tier — construction refuses to choose policy", () => {
  test("maxEntries is required and has no default", () => {
    expect(() => inProcess.createTier({ ttlMs: TTL_MS, namespace: NAMESPACE })).toThrow(/maxEntries/);
    expect(() => inProcess.createTier({ maxEntries: 0, ttlMs: TTL_MS, namespace: NAMESPACE })).toThrow(/maxEntries/);
  });

  test("ttlMs is required and has no default", () => {
    expect(() => inProcess.createTier({ maxEntries: 10, namespace: NAMESPACE })).toThrow(/ttlMs/);
  });

  test("a namespace is required, because a cell id is an opaque token from the published map", () => {
    expect(() => inProcess.createTier({ maxEntries: 10, ttlMs: TTL_MS })).toThrow(/namespace/);
  });

  test("the module publishes no numeric default any caller could inherit", () => {
    // §22.1 rule 1: the policy lives at the composition root, the mechanism lives here.
    // A default would be a behavioural constant in code, unowned and unregistered.
    const built = tier();
    expect(built.maxEntries).toBe(100);
    expect(built.ttlMs).toBe(TTL_MS);
  });
});

describe("hit, miss, and value fidelity", () => {
  test("a hit returns exactly what was written", () => {
    const store = tier();
    const payload = JSON.stringify({ distanceM: 1200, travelSeconds: 480, travelSdSeconds: 30 });
    store.set("engine:route:cell:a:b:p:0", payload, NOW);

    const read = store.get("engine:route:cell:a:b:p:0", NOW);
    expect(read.hit).toBe(true);
    expect(read.value).toBe(payload);
  });

  test("an absent key is a miss with a reason, not an undefined", () => {
    const store = tier();
    const read = store.get("engine:route:cell:missing:b:p:0", NOW);
    expect(read).toEqual({ hit: false, value: null, reason: "miss" });
  });

  test("counters separate hits, misses, expiries and evictions", () => {
    const store = tier();
    store.set("k1", "v1", NOW);
    store.get("k1", NOW);
    store.get("k2", NOW);

    const stats = store.stats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.reads).toBe(2);
    expect(stats.hitRate).toBe(0.5);
    expect(stats.writes).toBe(1);
  });
});

describe("expiry is evaluated against an injected instant, never a host clock", () => {
  test("an entry past its TTL is a miss and is dropped, not a stale answer", () => {
    const store = tier();
    store.set("k", "v", NOW);

    expect(store.get("k", NOW + TTL_MS - 1).hit).toBe(true);
    expect(store.get("k", NOW + TTL_MS).hit).toBe(false);
    expect(store.get("k", NOW + TTL_MS).reason).toBe("miss");
    expect(store.size).toBe(0);
    expect(store.stats().expiries).toBe(1);
  });

  test("a read does not extend the TTL", () => {
    // Refresh-on-access would let the hottest cell pair outlive every congestion bucket
    // boundary indefinitely — the entry most consulted and least able to afford being wrong.
    const store = tier();
    store.set("k", "v", NOW);
    store.get("k", NOW + TTL_MS / 2);
    expect(store.get("k", NOW + TTL_MS).hit).toBe(false);
  });

  test("a missing pinned instant fails closed to a miss rather than guessing one", () => {
    const store = tier();
    store.set("k", "v", NOW);
    const read = store.get("k", undefined);
    expect(read.hit).toBe(false);
    expect(read.reason).toMatch(/pinned decision time/);
    expect(store.set("k2", "v", undefined)).toBe(false);
  });

  test("the module reads no wall clock", () => {
    const source = require("fs").readFileSync(
      require("path").join(__dirname, "..", "..", "src", "engine", "routing", "inProcessCache.js"),
      "utf8",
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/Date\s*\.\s*now\s*\(/);
    expect(code).not.toMatch(/new\s+Date\s*\(/);
    expect(code).not.toMatch(/process\s*\.\s*hrtime/);
    expect(code).not.toMatch(/Math\s*\.\s*random\s*\(/);
  });
});

describe("version and namespace isolation — §20.3's key discipline, preserved", () => {
  test("a different mobility profile is a different key, never a stale hit", () => {
    const store = tier();
    const loaded = cellPairCache.key({ originCell: "a", destCell: "b", profileKey: "MOB-X:SIDEWALK_GRAPH:loaded", timeBucket: 3 });
    const unloaded = cellPairCache.key({ originCell: "a", destCell: "b", profileKey: "MOB-X:SIDEWALK_GRAPH:unloaded", timeBucket: 3 });
    expect(loaded.key).not.toBe(unloaded.key);

    store.set(loaded.key, "loaded-entry", NOW);
    expect(store.get(unloaded.key, NOW).hit).toBe(false);
  });

  test("a different time bucket is a different key", () => {
    const store = tier();
    const bucket3 = cellPairCache.key({ originCell: "a", destCell: "b", profileKey: "p", timeBucket: 3 }).key;
    const bucket4 = cellPairCache.key({ originCell: "a", destCell: "b", profileKey: "p", timeBucket: 4 }).key;
    store.set(bucket3, "three", NOW);
    expect(store.get(bucket4, NOW).hit).toBe(false);
    expect(store.get(bucket3, NOW).value).toBe("three");
  });

  test("a different charger-availability projection is a different key", () => {
    // §20.3 item 3: "an entry computed against one availability projection is never silently
    // applied under another, which preserves both the reserve's meaning and replay
    // determinism (§14.5, §9.6)."
    const store = tier({ population: inProcess.POPULATION.CHARGER_REACHABILITY });
    const v7 = chargerCache.key({ cellId: "c", profileKey: "p", timeBucket: 0, projectionVersion: 7 }).key;
    const v8 = chargerCache.key({ cellId: "c", profileKey: "p", timeBucket: 0, projectionVersion: 8 }).key;
    store.set(v7, "seven", NOW);
    expect(store.get(v8, NOW).hit).toBe(false);
  });

  test("an entry cannot cross a namespace, so a republished map cannot be served under the old one", () => {
    const before = tier({ namespace: "cfg:7|map:3|shard:SHD-A" });
    const after = tier({ namespace: "cfg:8|map:4|shard:SHD-A" });
    before.set("engine:route:cell:a:b:p:0", "old-geography", NOW);
    // Distinct instances is the deployment shape; the namespace is what makes it *safe* even
    // when one instance is reused, which is asserted next.
    expect(after.get("engine:route:cell:a:b:p:0", NOW).hit).toBe(false);

    const reused = tier({ namespace: "cfg:7|map:3|shard:SHD-A" });
    reused.set("engine:route:cell:a:b:p:0", "old-geography", NOW);
    reused.namespace = "cfg:8|map:4|shard:SHD-A";
    expect(reused.get("engine:route:cell:a:b:p:0", NOW).hit).toBe(false);
  });

  test("two shards in one process do not share entries", () => {
    // route.* is region-scoped (§22.2), so the same cell pair legitimately carries different
    // values under two shards.
    const a = tier({ namespace: "cfg:7|map:3|shard:SHD-A" });
    const b = tier({ namespace: "cfg:7|map:3|shard:SHD-B" });
    a.set("engine:route:cell:a:b:p:0", "A", NOW);
    b.set("engine:route:cell:a:b:p:0", "B", NOW);
    expect(a.get("engine:route:cell:a:b:p:0", NOW).value).toBe("A");
    expect(b.get("engine:route:cell:a:b:p:0", NOW).value).toBe("B");
  });
});

describe("bounded memory and deterministic eviction", () => {
  test("the bound holds", () => {
    const store = tier({ maxEntries: 10 });
    for (let index = 0; index < 100; index += 1) store.set(`k${index}`, `v${index}`, NOW);
    expect(store.size).toBe(10);
    expect(store.stats().evictions).toBe(90);
  });

  test("eviction is least-recently-used and repeats exactly", () => {
    const run = () => {
      const store = tier({ maxEntries: 3 });
      store.set("a", "1", NOW);
      store.set("b", "2", NOW);
      store.set("c", "3", NOW);
      store.get("a", NOW); // a becomes most recent; b is now least recent
      store.set("d", "4", NOW);
      return ["a", "b", "c", "d"].map((key) => store.get(key, NOW).hit);
    };
    expect(run()).toEqual([true, false, true, true]);
    expect(run()).toEqual(run());
  });

  test("a re-write refreshes recency rather than leaving the key at its old position", () => {
    const store = tier({ maxEntries: 2 });
    store.set("a", "1", NOW);
    store.set("b", "2", NOW);
    store.set("a", "1b", NOW);
    store.set("c", "3", NOW);
    expect(store.get("a", NOW).value).toBe("1b");
    expect(store.get("b", NOW).hit).toBe(false);
  });
});

describe("the layered façade — L1 in front of the cross-round tier", () => {
  test("it refuses to construct without the round's pinned decision time", () => {
    expect(() => inProcess.layeredKv({ tier: tier(), kv: fakeKv() })).toThrow(/pinned decision time/);
  });

  test("it refuses to construct its own tier", () => {
    expect(() => inProcess.layeredKv({ kv: fakeKv(), nowMs: NOW })).toThrow(/in-process tier/);
  });

  test("an L1 miss reads L2 once and promotes; the next read costs no round trip", async () => {
    const kv = fakeKv();
    kv.store.set("k", "value-from-redis");
    const layered = inProcess.layeredKv({ tier: tier(), kv, nowMs: NOW });

    expect(await layered.get("k")).toBe("value-from-redis");
    expect(kv.getCalls).toBe(1);
    expect(await layered.get("k")).toBe("value-from-redis");
    expect(kv.getCalls).toBe(1);

    const stats = layered.stats();
    expect(stats.l2.l2Hits).toBe(1);
    expect(stats.l2.promotions).toBe(1);
    expect(stats.l1.hits).toBe(1);
  });

  test("a write goes through to L2 and populates L1", async () => {
    const kv = fakeKv();
    const layered = inProcess.layeredKv({ tier: tier(), kv, nowMs: NOW });
    await layered.set("k", "v", "EX", 900);

    expect(kv.store.get("k")).toBe("v");
    expect(await layered.get("k")).toBe("v");
    expect(kv.getCalls).toBe(0);
  });

  test("concurrent misses for one key share a single L2 read", async () => {
    const kv = fakeKv();
    kv.store.set("k", "v");
    const layered = inProcess.layeredKv({ tier: tier(), kv, nowMs: NOW });

    const results = await Promise.all([layered.get("k"), layered.get("k"), layered.get("k")]);
    expect(results).toEqual(["v", "v", "v"]);
    expect(kv.getCalls).toBe(1);
    expect(layered.stats().l2.coalesced).toBe(2);
  });

  test("cross-round-tier operations are counted, so the residual can be attributed", async () => {
    // Which operations remain on the network is the quantity the §20.1 cache-path finding
    // turns on. Counting them is what makes an attribution a measurement rather than an
    // inference from the wall clock.
    const kv = fakeKv();
    kv.store.set("hot", "v");
    const layered = inProcess.layeredKv({ tier: tier(), kv, nowMs: NOW });

    await layered.get("hot");
    await layered.get("hot");
    await layered.get("cold");
    await layered.set("w", "v");

    const l2 = layered.stats().l2;
    expect(l2.l2Reads).toBe(2);
    expect(l2.l2Hits).toBe(1);
    expect(l2.l2Misses).toBe(1);
    expect(l2.l2Writes).toBe(1);
    expect(l2.l2WriteErrors).toBe(0);
  });

  test("a duplicate fill overwrites rather than accumulating", async () => {
    const kv = fakeKv();
    const layered = inProcess.layeredKv({ tier: tier(), kv, nowMs: NOW });
    await layered.set("k", "first");
    await layered.set("k", "second");
    expect(layered.tier.size).toBe(1);
    expect(await layered.get("k")).toBe("second");
  });
});

describe("failure behaviour — a cache failure is a miss, never a verdict (I16)", () => {
  test("an L2 read error is a miss and is not promoted", async () => {
    const kv = fakeKv();
    kv.store.set("k", "v");
    kv.failGet = true;
    const layered = inProcess.layeredKv({ tier: tier(), kv, nowMs: NOW });

    expect(await layered.get("k")).toBeNull();
    expect(layered.tier.size).toBe(0);
    expect(layered.stats().l2.l2Errors).toBe(1);
  });

  test("an L2 write failure leaves no process-local copy the rest of the fleet cannot see", async () => {
    const kv = fakeKv();
    kv.failSet = true;
    const layered = inProcess.layeredKv({ tier: tier(), kv, nowMs: NOW });

    expect(await layered.set("k", "v")).toBeNull();
    expect(layered.tier.size).toBe(0);
    expect(layered.stats().l2.l2WriteErrors).toBe(1);
  });

  test("with no kv at all the façade still serves what it holds", async () => {
    const layered = inProcess.layeredKv({ tier: tier(), kv: null, nowMs: NOW });
    await layered.set("k", "v");
    expect(await layered.get("k")).toBe("v");
    expect(await layered.get("absent")).toBeNull();
  });
});

describe("an L1 entry never outlives its L2 counterpart", () => {
  test("the ioredis positional TTL form is read and clamps the L1 lifetime", async () => {
    const kv = fakeKv();
    const store = tier({ ttlMs: 10 * 60_000 });
    const layered = inProcess.layeredKv({ tier: store, kv, nowMs: NOW });

    // cellPairCache.write() calls kv.set(key, value, "EX", ttlSeconds).
    await layered.set("k", "v", "EX", 60);
    expect(store.get("k", NOW + 59_000).hit).toBe(true);
    expect(store.get("k", NOW + 60_000).hit).toBe(false);
  });

  test("the object TTL form is read and clamps the L1 lifetime", async () => {
    const kv = fakeKv();
    const store = tier({ ttlMs: 10 * 60_000 });
    const layered = inProcess.layeredKv({ tier: store, kv, nowMs: NOW });

    // chargerReachabilityCache.write() calls kv.set(key, value, { ex: ttlSeconds }).
    await layered.set("k", "v", { ex: 30 });
    expect(store.get("k", NOW + 29_000).hit).toBe(true);
    expect(store.get("k", NOW + 30_000).hit).toBe(false);
  });

  test("this tier's own TTL still binds when the caller asks for a longer one", async () => {
    const kv = fakeKv();
    const store = tier({ ttlMs: 5_000 });
    const layered = inProcess.layeredKv({ tier: store, kv, nowMs: NOW });
    await layered.set("k", "v", "EX", 900);
    expect(store.get("k", NOW + 5_000).hit).toBe(false);
  });

  test("callerTtlMs reads both forms and reports absence honestly", () => {
    expect(inProcess.callerTtlMs(["EX", 60])).toBe(60_000);
    expect(inProcess.callerTtlMs(["PX", 250])).toBe(250);
    expect(inProcess.callerTtlMs([{ ex: 30 }])).toBe(30_000);
    expect(inProcess.callerTtlMs([{ px: 400 }])).toBe(400);
    expect(inProcess.callerTtlMs([])).toBeNull();
    expect(inProcess.callerTtlMs([undefined])).toBeNull();
  });
});

describe("both shipped cache modules work through the façade unchanged", () => {
  const PARTS = { originCell: "cell:a", destCell: "cell:b", profileKey: "MOB-SIDEWALK-DEFAULT:SIDEWALK_GRAPH:unloaded", timeBucket: 0 };

  test("cellPairCache round-trips, and the second read never reaches L2", async () => {
    const kv = fakeKv();
    const layered = inProcess.layeredKv({ tier: tier(), kv, nowMs: NOW });
    let routerCalls = 0;
    const route = async () => {
      routerCalls += 1;
      return { distanceM: 1500, travelSeconds: 600, travelSdSeconds: 45 };
    };

    const first = await cellPairCache.read({ kv: layered, route }, PARTS, { ttlSeconds: 900 });
    expect(first.ok).toBe(true);
    expect(first.hit).toBe(false);
    expect(routerCalls).toBe(1);

    const second = await cellPairCache.read({ kv: layered, route }, PARTS, { ttlSeconds: 900 });
    expect(second.hit).toBe(true);
    expect(routerCalls).toBe(1);
    // One L2 GET for the initial miss; the warm read is served entirely from process memory.
    expect(kv.getCalls).toBe(1);
    expect(second.entry.distanceM).toBe(1500);
  });

  test("the intra-cell offset is still applied to an entry served from L1", async () => {
    const kv = fakeKv();
    const layered = inProcess.layeredKv({ tier: tier(), kv, nowMs: NOW });
    const route = async () => ({ distanceM: 1000, travelSeconds: 500, travelSdSeconds: 10 });

    await cellPairCache.read({ kv: layered, route }, PARTS, { ttlSeconds: 900 });
    const warm = await cellPairCache.read({ kv: layered, route }, PARTS, {
      ttlSeconds: 900,
      intraCellOffsetM: 250,
      speedMetresPerSecond: 2,
    });

    expect(warm.hit).toBe(true);
    // Both ends carry the quantisation: 2 × 250 m added, pessimistically, and the time with it.
    expect(warm.entry.distanceM).toBe(1500);
    expect(warm.entry.travelSeconds).toBe(750);
    expect(warm.entry.correctionDirection).toBe("ADDED");
  });

  test("chargerReachabilityCache round-trips, and the version check still rejects a mismatch", async () => {
    const kv = fakeKv();
    const store = tier({ population: inProcess.POPULATION.CHARGER_REACHABILITY });
    const layered = inProcess.layeredKv({ tier: store, kv, nowMs: NOW });
    const parts = { cellId: "cell:z", profileKey: "p", timeBucket: 0, projectionVersion: 7 };

    const built = chargerCache.buildEntry({
      chargers: [{ chargerId: "CHG-1", distanceM: 800, travelSeconds: 400 }],
      k: 5,
      intraCellOffsetM: 250,
      energyWhPerMetre: 0.05,
      speedMetresPerSecond: 2,
      projectionVersion: 7,
    });
    expect(built.ok).toBe(true);

    await chargerCache.write({ kv: layered }, parts, built.entry, 900);

    const hit = await chargerCache.read({ kv: layered }, parts);
    expect(hit.hit).toBe(true);
    expect(hit.entry.chargers[0].chargerId).toBe("CHG-1");
    expect(kv.getCalls).toBe(0);

    const wrongVersion = await chargerCache.read({ kv: layered }, { ...parts, projectionVersion: 8 });
    expect(wrongVersion.hit).toBe(false);
  });

  test("a Redis outage mid-round degrades to a miss rather than to a stale entry", async () => {
    const kv = fakeKv();
    const layered = inProcess.layeredKv({ tier: tier(), kv, nowMs: NOW });
    const route = async () => ({ distanceM: 900, travelSeconds: 300, travelSdSeconds: 5 });

    await cellPairCache.read({ kv: layered, route }, PARTS, { ttlSeconds: 900 });
    kv.failGet = true;

    // Held in L1, so the outage is invisible for keys this process already has.
    const warm = await cellPairCache.read({ kv: layered, route }, PARTS, { ttlSeconds: 900 });
    expect(warm.hit).toBe(true);

    // Not held in L1: the outage is a miss that falls through to the injected router, and
    // the router's answer is what the caller gets — never a guess (I16).
    const cold = await cellPairCache.read({ kv: layered, route }, { ...PARTS, destCell: "cell:c" }, { ttlSeconds: 900 });
    expect(cold.ok).toBe(true);
    expect(cold.hit).toBe(false);
  });

  test("a router failure is still reported to the caller rather than answered from the tier", async () => {
    const layered = inProcess.layeredKv({ tier: tier(), kv: fakeKv(), nowMs: NOW });
    const route = async () => {
      throw new Error("routing service timeout");
    };
    const result = await cellPairCache.read({ kv: layered, route }, PARTS, { ttlSeconds: 900 });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Routing Service failed/);
  });
});

describe("the B1 harness seam is additive — the default behaviour is unchanged", () => {
  const b1 = require("../../tools/routing/b1Benchmark");

  const STAND_IN = {
    id: "test-stand-in",
    async matrix({ destCellIds }) {
      return (destCellIds || []).map((destCellId) => ({ destCellId, distanceM: 100, travelSeconds: 60, travelSdSeconds: 1 }));
    },
    async nearestChargers({ k }) {
      return Array.from({ length: k || 1 }, (unused, index) => ({ chargerId: `C${index}`, distanceM: 200, travelSeconds: 90 }));
    },
  };
  const CONFIG = {
    cellPairTtl: 900,
    cellPairMinHitRate: 0.95,
    chargerK: 5,
    chargerTtl: 900,
    intraCellOffsetM: 250,
    energyWhPerMetre: 0.05,
    speedMetresPerSecond: 5,
  };
  /** Small enough for a test lane; the CLI still runs §20.1's own 500 × 200 shape. */
  const SHAPE = { legs: 4, candidatesPerLeg: 4, clusterCount: 2, profileKey: "p", timeBucket: 0, projectionVersion: 1 };

  test("measure() with no deps still uses the in-memory kv and reports the same amortisation", async () => {
    const withoutDeps = await b1.measure(STAND_IN, CONFIG, SHAPE);
    const withExplicitDefault = await b1.measure(STAND_IN, CONFIG, SHAPE, { kvFactory: b1.memoryKv });
    expect(withoutDeps.amortisation).toEqual(withExplicitDefault.amortisation);
    expect(withoutDeps.approachHitRate).toEqual(withExplicitDefault.approachHitRate);
    expect(withoutDeps.cacheEntries).toBe(withExplicitDefault.cacheEntries);
  });

  test("the layered tier drives the same workload to the same amortisation", async () => {
    // The tier changes where a read is served from, never what it answers. If these two
    // disagreed, the tier would be changing the workload rather than accelerating it.
    const plain = await b1.measure(STAND_IN, CONFIG, SHAPE);
    const viaTier = await b1.measure(STAND_IN, CONFIG, SHAPE, {
      kvFactory: () => inProcess.layeredKv({ tier: tier(), kv: b1.memoryKv(), nowMs: NOW }),
    });
    expect(viaTier.amortisation).toEqual(plain.amortisation);
    expect(viaTier.approachHitRate.hitRate).toBe(plain.approachHitRate.hitRate);
    expect(viaTier.chargerHitRate).toBe(plain.chargerHitRate);
  });

  test("§20.1's workload shape is untouched", () => {
    expect(b1.DEFAULT_WORKLOAD.legs).toBe(500);
    expect(b1.DEFAULT_WORKLOAD.candidatesPerLeg).toBe(200);
    expect(b1.DEFAULT_WORKLOAD.clusterCount).toBe(25);
  });
});

describe("the tier remains engine-independent", () => {
  test("it imports nothing", () => {
    const source = require("fs").readFileSync(
      require("path").join(__dirname, "..", "..", "src", "engine", "routing", "inProcessCache.js"),
      "utf8",
    );
    expect(source).not.toMatch(/\brequire\s*\(/);
  });

  test("neither shipped cache module gained a dependency on it", () => {
    const path = require("path");
    const fs = require("fs");
    const root = path.join(__dirname, "..", "..", "src", "engine", "routing");
    for (const file of ["cellPairCache.js", "chargerReachabilityCache.js"]) {
      expect(fs.readFileSync(path.join(root, file), "utf8")).not.toMatch(/inProcessCache/);
    }
  });
});
