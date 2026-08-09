"use strict";

/**
 * `candidates/clusterShare.js` — §6.5's "candidate sets are computed once per cell
 * cluster and shared across those Legs".
 */

const clusterShare = require("../../src/engine/candidates/clusterShare");

describe("§6.5 — clusterLegs", () => {
  test("Legs whose origins fall in the same coarse cell share one cluster", () => {
    const legs = [
      { legId: "l1", originLat: 12.9716, originLon: 77.5946 },
      { legId: "l2", originLat: 12.972, originLon: 77.595 }, // a few hundred metres away — same coarse cell
      { legId: "l3", originLat: -33.87, originLon: 151.21 }, // Sydney — a different coarse cell entirely
    ];
    const { clusters, legToCoarseCellId } = clusterShare.clusterLegs(legs);

    expect(clusters.length).toBe(2);
    expect(legToCoarseCellId.l1).toBe(legToCoarseCellId.l2);
    expect(legToCoarseCellId.l3).not.toBe(legToCoarseCellId.l1);

    const bengaluruCluster = clusters.find((cluster) => cluster.legIds.includes("l1"));
    expect(bengaluruCluster.legIds.sort()).toEqual(["l1", "l2"]);
  });

  test("clusters are canonically ordered by coarse cell id, and each cluster's legIds are ordered too", () => {
    const legs = [
      { legId: "z", originLat: -33.87, originLon: 151.21 },
      { legId: "a", originLat: 12.9716, originLon: 77.5946 },
    ];
    const { clusters } = clusterShare.clusterLegs(legs);
    const ids = clusters.map((cluster) => cluster.coarseCellId);
    expect(ids).toEqual([...ids].sort());
  });

  test("skips a malformed Leg entry rather than throwing", () => {
    const { clusters } = clusterShare.clusterLegs([null, { legId: "ok", originLat: 1, originLon: 1 }]);
    expect(clusters.length).toBe(1);
    expect(clusters[0].legIds).toEqual(["ok"]);
  });

  test("an empty batch produces no clusters", () => {
    expect(clusterShare.clusterLegs([])).toEqual({ clusters: [], legToCoarseCellId: {} });
  });
});

describe("§6.5 — sharedIndexReader", () => {
  test("memoises smembers by key — a second read for the same key does not hit the underlying kv again", async () => {
    let calls = 0;
    const kv = {
      async smembers(key) {
        calls += 1;
        return [`member-of-${key}`];
      },
    };
    const shared = clusterShare.sharedIndexReader(kv);

    const first = await shared.smembers("cell-1");
    const second = await shared.smembers("cell-1");
    expect(first).toEqual(["member-of-cell-1"]);
    expect(second).toEqual(["member-of-cell-1"]);
    expect(calls).toBe(1);
    expect(shared.sharedReadCount()).toBe(1);
  });

  test("different keys are read independently", async () => {
    const kv = { async smembers(key) { return [key]; } };
    const shared = clusterShare.sharedIndexReader(kv);
    await shared.smembers("a");
    await shared.smembers("b");
    expect(shared.sharedReadCount()).toBe(2);
  });

  test("non-smembers methods pass straight through, unmemoised", async () => {
    let sadds = 0;
    const kv = {
      async smembers() { return []; },
      async sadd() { sadds += 1; return 1; },
    };
    const shared = clusterShare.sharedIndexReader(kv);
    await shared.sadd("k", "m");
    await shared.sadd("k", "m");
    expect(sadds).toBe(2);
  });

  test("requires a kv client exposing smembers()", () => {
    expect(() => clusterShare.sharedIndexReader(null)).toThrow(/requires a kv client/);
    expect(() => clusterShare.sharedIndexReader({})).toThrow(/requires a kv client/);
  });
});
