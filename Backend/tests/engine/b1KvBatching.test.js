"use strict";

/**
 * B1 — the Availability Index reads of §6.3's expansion, batched, must decide exactly what the
 * one-key-at-a-time reads decide.
 *
 * Every scenario runs `expansion.expandCandidates` twice over the SAME index content:
 *   · `sequential` — a KV exposing only `smembers` (the pre-B1 access path, still the fallback);
 *   · `batched`    — the real KV facade (which, after B1, also answers `smembersMany`).
 * and asserts the two results, the order agents were loaded and evaluated in, and the counters
 * are identical — candidate order, γ, LB, tier, `cellsExplored`, `agentsEvaluated`,
 * `truncatedBy`, `unexploredRingDistance`, the achieved gap and its proof.
 *
 * The characterization part is green on the pre-B1 tree (both paths are then sequential). The
 * last block asserts the B1 property itself — KV round trips bounded by tiers, not by cells —
 * and is red before B1.
 */

const expansion = require("../../src/engine/candidates/expansion");
const availabilityIndex = require("../../src/engine/candidates/availabilityIndex");
const cells = require("../../src/engine/spatial/cells");
const { initKv } = require("../../src/cache/kv");
const f = require("./helpers/candidateFixture");

const SHARD = "shard-b1-kv";
const quiet = { warn() {}, info() {}, error() {} };
const big = (k, v) => (typeof v === "bigint" ? `${v}n` : v);
const json = (v) => JSON.parse(JSON.stringify(v, big));

const originCell = cells.cellForPoint(f.ORIGIN.lat, f.ORIGIN.lon, cells.RESOLUTION.FINE);

/** Index layout: [ring, cellIndex within ring, class, agentId]. */
const LAYOUT = [
  [0, 0, "IDLE_READY", "a-r0-x"],
  [0, 0, "IDLE_READY", "a-r0-b"],
  [1, 2, "IDLE_READY", "a-r1"],
  [1, 4, "QUEUE_CAPACITY_AVAILABLE", "a-r1-q"],
  [3, 7, "IDLE_READY", "a-r3"],
  [6, 1, "IDLE_READY", "a-r6"],
  [6, 1, "QUEUE_CAPACITY_AVAILABLE", "a-r6-q"],
  [9, 30, "IDLE_READY", "a-r9"],
  [2, 3, "CHARGING_INTERRUPTIBLE", "a-r2-chg"],
  [5, 0, "FINISHING_SOON", "a-r5-fin"],
];

async function seed(kv, extra) {
  for (const [ring, idx, cls, agentId] of [...LAYOUT, ...(extra || [])]) {
    const ringCells = ring === 0 ? [originCell] : cells.ringAt(originCell, ring);
    // eslint-disable-next-line no-await-in-loop
    await kv.sadd(availabilityIndex.fineKey(SHARD, ringCells[idx % ringCells.length], cls), agentId);
  }
}

/** A KV exposing only the per-key primitives — the pre-B1 path. Calls counted. */
function sequentialView(kv, options) {
  const settings = options || {};
  const counts = { smembers: 0, smembersMany: 0 };
  return {
    counts,
    kv: {
      sadd: (...a) => kv.sadd(...a),
      srem: (...a) => kv.srem(...a),
      smembers: async (key) => {
        counts.smembers += 1;
        if (settings.failKey && key === settings.failKey) throw new Error("TEST DOUBLE — KV read failed");
        return kv.smembers(key);
      },
    },
  };
}

/** The real facade, counted. `smembersMany` is passed through when the facade has it. */
function batchedView(kv, options) {
  const settings = options || {};
  const counts = { smembers: 0, smembersMany: 0, keys: 0 };
  const view = {
    sadd: (...a) => kv.sadd(...a),
    srem: (...a) => kv.srem(...a),
    smembers: async (key) => {
      counts.smembers += 1;
      if (settings.failKey && key === settings.failKey) throw new Error("TEST DOUBLE — KV read failed");
      return kv.smembers(key);
    },
  };
  if (typeof kv.smembersMany === "function") {
    view.smembersMany = async (keys) => {
      counts.smembersMany += 1;
      counts.keys += keys.length;
      if (settings.failBatch) throw new Error("TEST DOUBLE — pipeline failed");
      if (settings.failKey && keys.includes(settings.failKey)) throw new Error("TEST DOUBLE — pipeline failed");
      return kv.smembersMany(keys);
    };
  }
  return { counts, kv: view };
}

/** Deterministic seams; every call logged in order. */
function seams(log, options) {
  const settings = options || {};
  const offsetOf = (agentId) => [...agentId].reduce((s, c) => s + c.charCodeAt(0), 0);
  let ticks = 0;
  return {
    loadAgentSnapshot: async (agentId) => {
      log.push(`load:${agentId}`);
      return f.agentSnapshot({ agentId, lat: f.ORIGIN.lat + offsetOf(agentId) * 1e-6, lon: f.ORIGIN.lon });
    },
    waitUntilAvailableFor: async () => 0,
    energyFor: async (agentId) => {
      log.push(`energy:${agentId}`);
      return f.energyInput();
    },
    evaluateExact: async (agentId) => {
      log.push(`exact:${agentId}`);
      const feasible = offsetOf(agentId) % 3 !== 0;
      return feasible ? { feasible: true, gammaMilliCU: BigInt(10_000 + (offsetOf(agentId) % 97) * 10), agentId } : { feasible: false, gammaMilliCU: null };
    },
    // A deterministic clock: one tick per read, so a deadline trips at the same read on both paths.
    ...(settings.deadlineTicks ? { deadlineMs: settings.deadlineTicks, elapsedMs: () => (ticks += 1) } : {}),
  };
}

function input(kv, log, overrides) {
  const o = overrides || {};
  return {
    legId: "leg-kv",
    shardId: SHARD,
    originLat: f.ORIGIN.lat,
    originLon: f.ORIGIN.lon,
    leg: f.legForBound(),
    decisionTimeMs: f.DECISION_TIME_MS,
    rates: f.boundRates(),
    delayParameters: f.delayParameters(),
    correction: f.zeroCorrection(),
    fleetBestCase: { maxSpeedMs: 3, kappaMin: 1, betaDistMin: 0.01 },
    targetFeasible: 99, // never enough: the sweep is exhaustive unless something truncates it
    maxEvaluated: 99,
    maxExpansionTiers: 5,
    maxRadiusMetres: 250,
    kv,
    ...seams(log, o),
    ...o,
  };
}

async function both(overrides, viewOptions) {
  const { kv, close } = await initKv({ logger: quiet });
  await seed(kv, overrides && overrides.extraSeed);
  const { extraSeed, ...rest } = overrides || {};
  const seq = sequentialView(kv, viewOptions);
  const bat = batchedView(kv, viewOptions);
  const seqLog = [];
  const batLog = [];
  const sequential = await expansion.expandCandidates(input(seq.kv, seqLog, rest));
  const batched = await expansion.expandCandidates(input(bat.kv, batLog, rest));
  await close();
  return { sequential, batched, seqLog, batLog, seqCounts: seq.counts, batCounts: bat.counts };
}

describe("B1 KV — batched index reads decide exactly what per-key reads decide", () => {
  test("an exhaustive sweep over tiers 1, 2 and 5: identical candidates, order, bounds and counters", async () => {
    const r = await both();
    expect(json(r.batched)).toEqual(json(r.sequential));
    expect(r.batLog).toEqual(r.seqLog);
    // Pinned so a change to BOTH paths is caught too: the ready agents in ring order, agent
    // id order within a cell (§6.6), then tier 5's widened classes.
    expect(r.seqLog.filter((e) => e.startsWith("load:"))).toEqual([
      "load:a-r0-b",
      "load:a-r0-x",
      ...r.seqLog.filter((e) => e.startsWith("load:")).slice(2),
    ]);
    expect(r.sequential.agentsEvaluated).toBe(LAYOUT.length);
    expect(r.sequential.candidates.map((c) => c.tier).includes(expansion.TIER.WIDENED_CLASSES)).toBe(true);
  });

  test("max_evaluated truncating mid-ring: same truncation, same lowest unexplored ring, same gap", async () => {
    const r = await both({ maxEvaluated: 3 });
    expect(json(r.batched)).toEqual(json(r.sequential));
    expect(r.batLog).toEqual(r.seqLog);
    expect(r.sequential.truncatedBy).toBe("candidate.max_evaluated");
  });

  test("the wall-clock deadline tripping mid-sweep: same read count before the trip, same result", async () => {
    const r = await both({ deadlineTicks: 7 });
    expect(json(r.batched)).toEqual(json(r.sequential));
    expect(r.batLog).toEqual(r.seqLog);
    expect(r.sequential.truncatedBy).toBe("wall_clock_budget");
  });

  test("pruning stops the sweep early: same stopping ring", async () => {
    const r = await both({ targetFeasible: 1, optimalityToleranceMilliCU: 10_000_000n });
    expect(json(r.batched)).toEqual(json(r.sequential));
    expect(r.batLog).toEqual(r.seqLog);
  });

  test("a KV read that fails is an empty cell on both paths (I16: the index is advisory)", async () => {
    const failKey = availabilityIndex.fineKey(SHARD, cells.ringAt(originCell, 1)[2], "IDLE_READY");
    const r = await both({}, { failKey });
    expect(json(r.batched)).toEqual(json(r.sequential));
    expect(r.batLog).toEqual(r.seqLog);
    expect(r.seqLog.includes("load:a-r1")).toBe(false);
  });

  test("a whole batch that fails falls back to per-key reads with per-key error semantics", async () => {
    const r = await both({}, { failBatch: true });
    expect(json(r.batched)).toEqual(json(r.sequential));
    expect(r.batLog).toEqual(r.seqLog);
  });

  test("missing keys are empty cells, never an error", async () => {
    const r = await both({ originLat: 0, originLon: 0 });
    expect(json(r.batched)).toEqual(json(r.sequential));
    expect(r.sequential.agentsEvaluated).toBe(0);
  });

  test("tier 5 searches one ring beyond the declared radius — pinned as it is (out of B1's scope)", async () => {
    const edge = cells.edgeLengthMetres(cells.RESOLUTION.FINE);
    const radius = 250;
    const maxRadiusRings = Math.ceil(radius / Math.max(1, edge)) + 1;
    const beyond = [[maxRadiusRings + 1, 0, "CHARGING_INTERRUPTIBLE", "a-beyond-radius"]];
    const r = await both({ extraSeed: beyond });
    expect(json(r.batched)).toEqual(json(r.sequential));
    // The audit's observation (expansion.js tier 5 `Math.max(ring, 1)` after `ring` passed the
    // bound): this agent, one ring past the k-ring bound, IS reached. B1 does not change it.
    expect(r.seqLog.includes("load:a-beyond-radius")).toBe(true);
  });
});

describe("B1 KV — round trips bounded by tiers, not cells (red before B1)", () => {
  test("an exhaustive sweep issues one pipelined read per tier, never one read per cell", async () => {
    const r = await both();
    const cellsRead = r.seqCounts.smembers;
    expect(cellsRead).toBeGreaterThan(100);
    expect(r.batCounts.smembers).toBe(0);
    expect(r.batCounts.smembersMany).toBeLessThanOrEqual(2);
    expect(r.batCounts.keys).toBeGreaterThanOrEqual(cellsRead);
  });
});
