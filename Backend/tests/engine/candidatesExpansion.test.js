"use strict";

/**
 * `candidates/expansion.js` — §6.3's hierarchical tiers and §6.4's pruning rule.
 *
 * Exercises the orchestrator end to end against the real Availability Index (via
 * `kv`'s in-memory fallback) and the real `lowerBound()`, with a small,
 * deterministic stand-in for the exact evaluator (`evaluateExact`) — the seam that
 * belongs to Phase 10's round loop, not Phase 9 (see `expansion.js`'s own
 * docstring).
 */

const expansion = require("../../src/engine/candidates/expansion");
const availabilityIndex = require("../../src/engine/candidates/availabilityIndex");
const cells = require("../../src/engine/spatial/cells");
const { initKv } = require("../../src/cache/kv");
const f = require("./helpers/candidateFixture");

const DECISION_TIME_MS = f.DECISION_TIME_MS;

describe("§6.4 — minimumPossibleDistanceForRingMetres", () => {
  test("is zero at k=0 and k=1, then grows by one edge length per ring", () => {
    const edge = cells.edgeLengthMetres(cells.RESOLUTION.FINE);
    expect(expansion.minimumPossibleDistanceForRingMetres(0, cells.RESOLUTION.FINE)).toBe(0);
    expect(expansion.minimumPossibleDistanceForRingMetres(1, cells.RESOLUTION.FINE)).toBe(0);
    expect(expansion.minimumPossibleDistanceForRingMetres(2, cells.RESOLUTION.FINE)).toBeCloseTo(edge, 6);
    expect(expansion.minimumPossibleDistanceForRingMetres(3, cells.RESOLUTION.FINE)).toBeCloseTo(2 * edge, 6);
  });

  test("rejects a negative or fractional k", () => {
    expect(() => expansion.minimumPossibleDistanceForRingMetres(-1, cells.RESOLUTION.FINE)).toThrow();
    expect(() => expansion.minimumPossibleDistanceForRingMetres(1.5, cells.RESOLUTION.FINE)).toThrow();
  });
});

describe("§6.4 — unexploredRingFloorMilliCU", () => {
  const scenario = () => ({
    ringDistance: 2,
    resolution: cells.RESOLUTION.FINE,
    leg: f.legForBound(),
    decisionTimeMs: DECISION_TIME_MS,
    fleetBestCase: { maxSpeedMs: 3, kappaMin: 1, betaDistMin: 0.01 },
    rates: f.boundRates(),
    delayParameters: f.delayParameters(),
    correction: f.zeroCorrection(),
  });

  test("computes a finite floor for a well-formed scenario", () => {
    const result = expansion.unexploredRingFloorMilliCU(scenario());
    expect(result.ok).toBe(true);
    expect(typeof result.milliCU).toBe("bigint");
  });

  test("reports missing fields rather than a fabricated floor", () => {
    const { fleetBestCase, ...rest } = scenario();
    const result = expansion.unexploredRingFloorMilliCU(rest);
    expect(result.ok).toBe(false);
    expect(result.missing).toContain("fleetBestCase.maxSpeedMs");
  });

  test("a larger ring distance never produces a smaller floor", () => {
    const near = expansion.unexploredRingFloorMilliCU({ ...scenario(), ringDistance: 2 });
    const far = expansion.unexploredRingFloorMilliCU({ ...scenario(), ringDistance: 5 });
    expect(far.milliCU >= near.milliCU).toBe(true);
  });
});

describe("§6.3 — expandCandidates, end to end", () => {
  let kv;
  let close;

  beforeAll(async () => {
    const initialized = await initKv({ logger: { warn() {}, info() {}, error() {} } });
    kv = initialized.kv;
    close = initialized.close;
  });

  afterAll(async () => {
    if (close) await close();
  });

  /** Seed one agent into the Availability Index at a given offset from the origin. */
  async function seedAgent(agentId, shardId, lat, lon) {
    const record = availabilityIndex.positionRecord({
      agentId,
      shardId,
      lat,
      lon,
      state: { lifecycleEligible: true, hasActiveCommitment: false, idle: true },
      decisionTimeMs: DECISION_TIME_MS,
      finishingSoonHorizonSeconds: 300,
    }).record;
    await availabilityIndex.applyPosition({ kv }, null, record);
    return record;
  }

  function baseAgentSnapshots(agents) {
    return async (agentId) => {
      const found = agents.find((agent) => agent.agentId === agentId);
      if (!found) return null;
      return f.agentSnapshot({ agentId, lat: found.lat, lon: found.lon });
    };
  }

  test("finds a seeded agent in the origin cell and prices it via the injected exact evaluator", async () => {
    const shardId = `shard-${Date.now()}`;
    const seeded = await seedAgent("agent-near", shardId, f.ORIGIN.lat, f.ORIGIN.lon);

    const result = await expansion.expandCandidates({
      legId: "leg-1",
      shardId,
      originLat: f.ORIGIN.lat,
      originLon: f.ORIGIN.lon,
      leg: f.legForBound(),
      decisionTimeMs: DECISION_TIME_MS,
      rates: f.boundRates(),
      delayParameters: f.delayParameters(),
      correction: f.zeroCorrection(),
      fleetBestCase: { maxSpeedMs: 3, kappaMin: 1, betaDistMin: 0.01 },
      targetFeasible: 1,
      maxEvaluated: 10,
      maxExpansionTiers: 2,
      kv,
      loadAgentSnapshot: baseAgentSnapshots([seeded]),
      waitUntilAvailableFor: async () => 0,
      energyFor: async () => f.energyInput(),
      evaluateExact: async (agentId) => ({ feasible: true, gammaMilliCU: 42_000n, agentId }),
    });

    expect(result.ok).toBe(true);
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0].agentId).toBe("agent-near");
    expect(result.bestGammaMilliCU).toBe(42_000n);
    expect(result.agentsEvaluated).toBe(1);
    expect(result.achievedGapMilliCU >= 0n).toBe(true);
  });

  test("tier 0 (chaining) candidates are considered even when the index has nothing nearby", async () => {
    const shardId = `shard-${Date.now()}-t0`;
    const result = await expansion.expandCandidates({
      legId: "leg-2",
      shardId,
      originLat: 0,
      originLon: 0, // nothing indexed here
      leg: f.legForBound(),
      decisionTimeMs: DECISION_TIME_MS,
      rates: f.boundRates(),
      delayParameters: f.delayParameters(),
      correction: f.zeroCorrection(),
      fleetBestCase: { maxSpeedMs: 3, kappaMin: 1, betaDistMin: 0.01 },
      targetFeasible: 1,
      maxEvaluated: 5,
      maxExpansionTiers: 0, // only tier 0
      kv,
      tierZeroAgentIds: ["agent-chained"],
      loadAgentSnapshot: async (agentId) => f.agentSnapshot({ agentId }),
      waitUntilAvailableFor: async () => 0,
      energyFor: async () => f.energyInput(),
      evaluateExact: async (agentId) => ({ feasible: true, gammaMilliCU: 7_000n, agentId }),
    });

    expect(result.candidates.map((c) => c.agentId)).toEqual(["agent-chained"]);
    expect(result.candidates[0].tier).toBe(expansion.TIER.CHAINING);
  });

  test("an infeasible exact evaluation is excluded from the ordered candidates", async () => {
    const shardId = `shard-${Date.now()}-infeasible`;
    const seeded = await seedAgent("agent-infeasible", shardId, f.ORIGIN.lat, f.ORIGIN.lon);

    const result = await expansion.expandCandidates({
      legId: "leg-3",
      shardId,
      originLat: f.ORIGIN.lat,
      originLon: f.ORIGIN.lon,
      leg: f.legForBound(),
      decisionTimeMs: DECISION_TIME_MS,
      rates: f.boundRates(),
      delayParameters: f.delayParameters(),
      correction: f.zeroCorrection(),
      fleetBestCase: { maxSpeedMs: 3, kappaMin: 1, betaDistMin: 0.01 },
      targetFeasible: 5,
      maxEvaluated: 5,
      maxExpansionTiers: 1,
      kv,
      loadAgentSnapshot: baseAgentSnapshots([seeded]),
      waitUntilAvailableFor: async () => 0,
      energyFor: async () => f.energyInput(),
      evaluateExact: async () => ({ feasible: false, gammaMilliCU: null }),
    });

    expect(result.candidates).toEqual([]);
    expect(result.bestGammaMilliCU).toBeNull();
  });

  test("truncates at candidate.max_evaluated and reports why", async () => {
    const shardId = `shard-${Date.now()}-cap`;
    const agents = [];
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      agents.push(await seedAgent(`agent-${i}`, shardId, f.ORIGIN.lat, f.ORIGIN.lon));
    }

    const result = await expansion.expandCandidates({
      legId: "leg-4",
      shardId,
      originLat: f.ORIGIN.lat,
      originLon: f.ORIGIN.lon,
      leg: f.legForBound(),
      decisionTimeMs: DECISION_TIME_MS,
      rates: f.boundRates(),
      delayParameters: f.delayParameters(),
      correction: f.zeroCorrection(),
      fleetBestCase: { maxSpeedMs: 3, kappaMin: 1, betaDistMin: 0.01 },
      targetFeasible: 100, // unreachable, forcing the cap to bind
      maxEvaluated: 2,
      maxExpansionTiers: 1,
      kv,
      loadAgentSnapshot: baseAgentSnapshots(agents),
      waitUntilAvailableFor: async () => 0,
      energyFor: async () => f.energyInput(),
      evaluateExact: async (agentId) => ({ feasible: true, gammaMilliCU: 1000n, agentId }),
    });

    expect(result.agentsEvaluated).toBe(2);
    expect(result.truncatedBy).toBe("candidate.max_evaluated");
  });

  test("candidates are returned in canonical order (ascending γ)", async () => {
    const shardId = `shard-${Date.now()}-order`;
    const agents = [
      await seedAgent("agent-expensive", shardId, f.ORIGIN.lat, f.ORIGIN.lon),
      await seedAgent("agent-cheap", shardId, f.ORIGIN.lat, f.ORIGIN.lon),
    ];

    const gammaByAgent = { "agent-expensive": 9000n, "agent-cheap": 1000n };

    const result = await expansion.expandCandidates({
      legId: "leg-5",
      shardId,
      originLat: f.ORIGIN.lat,
      originLon: f.ORIGIN.lon,
      leg: f.legForBound(),
      decisionTimeMs: DECISION_TIME_MS,
      rates: f.boundRates(),
      delayParameters: f.delayParameters(),
      correction: f.zeroCorrection(),
      fleetBestCase: { maxSpeedMs: 3, kappaMin: 1, betaDistMin: 0.01 },
      targetFeasible: 2,
      maxEvaluated: 10,
      maxExpansionTiers: 1,
      kv,
      loadAgentSnapshot: baseAgentSnapshots(agents),
      waitUntilAvailableFor: async () => 0,
      energyFor: async () => f.energyInput(),
      evaluateExact: async (agentId) => ({ feasible: true, gammaMilliCU: gammaByAgent[agentId], agentId }),
    });

    expect(result.candidates.map((c) => c.agentId)).toEqual(["agent-cheap", "agent-expensive"]);
  });
});
