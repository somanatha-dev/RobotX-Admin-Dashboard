"use strict";

/**
 * Phase 9 closure regressions — §6.2, §6.3, §6.4.
 *
 * Every test here reproduces a defect the Phase 9 implementation and independent
 * verification reports both recorded as verified. Each one survived those reviews
 * for the same reason: the module was exercised through a fixture that satisfied
 * its own contract, never through the composition a caller actually performs. So
 * these tests are deliberately shaped the other way round — they compose the real
 * producer with the real consumer (`omega.combinedCorrection()` into
 * `lowerBound()`), and they measure the search's *outcome* (was the true optimum
 * reached, was the reported bound the proven one) rather than the shape of its
 * return value.
 *
 * `PHASE_9_REMEDIATION_AND_CLOSURE.md` carries the finding ids referenced below.
 */

const omega = require("../../src/engine/candidates/omega");
const { lowerBound } = require("../../src/engine/candidates/lowerBound");
const expansion = require("../../src/engine/candidates/expansion");
const availabilityIndex = require("../../src/engine/candidates/availabilityIndex");
const cells = require("../../src/engine/spatial/cells");
const f = require("./helpers/candidateFixture");

const DECISION_TIME_MS = f.DECISION_TIME_MS;

/** A config snapshot shaped as `omega.combinedCorrection()` reads one. */
function snapshotWith(maxTotalCredit, killSwitchState) {
  return {
    killSwitchState: killSwitchState || { opportunity_cost_term: true },
    resolve(name) {
      if (name === "cost.policy.max_total_credit") return maxTotalCredit;
      throw new Error(`unexpected resolve(${name})`);
    },
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   F9-1 — the Ω correction contract between omega.js and its consumers
   ═══════════════════════════════════════════════════════════════════════════ */

describe("F9-1 §6.4 — combinedCorrection() output is what LB(a, l) consumes", () => {
  const agent = () => f.agentSnapshot();
  const boundInput = (correction) => ({
    agent: agent(),
    waitUntilAvailableSeconds: 0,
    energy: f.energyInput(),
    leg: f.legForBound(),
    rates: f.boundRates(),
    delayParameters: f.delayParameters(),
    correction,
  });

  test("lowerBound() resolves against the real combinedCorrection() result, not only a hand-built one", () => {
    const correction = omega.combinedCorrection({ snapshot: snapshotWith(150) });
    expect(correction.ok).toBe(true);

    const bound = lowerBound(boundInput(correction));
    expect(bound.missing).toEqual([]);
    expect(bound.ok).toBe(true);
    expect(typeof bound.milliCU).toBe("bigint");
  });

  test("unexploredRingFloorMilliCU() resolves against it too", () => {
    const correction = omega.combinedCorrection({ snapshot: snapshotWith(150) });
    const floor = expansion.unexploredRingFloorMilliCU({
      ringDistance: 3,
      resolution: cells.RESOLUTION.FINE,
      leg: f.legForBound(),
      decisionTimeMs: DECISION_TIME_MS,
      fleetBestCase: { maxSpeedMs: 3, kappaMin: 1, betaDistMin: 0.01 },
      rates: f.boundRates(),
      delayParameters: f.delayParameters(),
      correction,
    });
    expect(floor.missing).toEqual([]);
    expect(floor.ok).toBe(true);
  });

  test("the correction is genuinely subtracted — LB falls by exactly Ω", () => {
    const correction = omega.combinedCorrection({ snapshot: snapshotWith(150) });
    const withCorrection = lowerBound(boundInput(correction));
    const withoutCorrection = lowerBound(boundInput(f.zeroCorrection()));

    expect(correction.milliCU).toBe(150_000n);
    expect(withoutCorrection.milliCU - withCorrection.milliCU).toBe(correction.milliCU);
  });

  test("an unresolved Ω stays fail-closed at the consumer — no silent zero correction", () => {
    // `opportunity_cost_term` live, but no omegaTerminalCu supplied: the correction
    // cannot be computed, and a bound without it is not a lower bound (§6.4).
    const correction = omega.combinedCorrection({
      snapshot: snapshotWith(150, { opportunity_cost_term: false }),
    });
    expect(correction.ok).toBe(false);
    expect(correction.milliCU).toBeNull();

    const bound = lowerBound(boundInput(correction));
    expect(bound.ok).toBe(false);
    expect(bound.milliCU).toBeNull();
  });

  test("both field names carry the same quantity, so an old reader cannot diverge from a new one", () => {
    const correction = omega.combinedCorrection({ snapshot: snapshotWith(42) });
    expect(correction.milliCU).toBe(correction.correctionMilliCU);
    expect(correction.breakdown.omegaPolicyMilliCU).toBe(42_000n);
    expect(correction.breakdown.opportunityTermActive).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   F9-2 — availability classification and the tier a charging agent belongs to
   ═══════════════════════════════════════════════════════════════════════════ */

describe("F9-2 §6.2/§6.3 — a charging agent is not in a tier 1–4 class", () => {
  const eligible = (extra) => ({ lifecycleEligible: true, ...extra });

  test("charging with no interruption permitted is not indexed at all", () => {
    const result = availabilityIndex.classify(
      eligible({ hasActiveCommitment: false, idle: true, charging: true, chargingInterruptible: false }),
      DECISION_TIME_MS,
      300,
    );
    expect(result).toBeNull();
  });

  test("charging and interruptible with no commitment is CHARGING_INTERRUPTIBLE, never IDLE_READY", () => {
    const result = availabilityIndex.classify(
      eligible({ hasActiveCommitment: false, idle: true, charging: true, chargingInterruptible: true }),
      DECISION_TIME_MS,
      300,
    );
    expect(result).toBe(availabilityIndex.AVAILABILITY_CLASS.CHARGING_INTERRUPTIBLE);
    expect(expansion.READY_CLASSES).not.toContain(result);
    expect(expansion.WIDENED_CLASSES).toContain(result);
  });

  test("the index maintainer's own state shape — queueDepth 0 against a configured capacity — is IDLE_READY", () => {
    // `indexMaintainer.assembleRecord()` always supplies queueDepth and capacity.
    // QUEUE_CAPACITY_AVAILABLE is §6.3 tier 0's class — "agents *already committed*
    // ... with spare queue capacity" — so an uncommitted agent must not land there.
    const result = availabilityIndex.classify(
      eligible({ hasActiveCommitment: false, idle: true, queueDepth: 0, capacity: 3 }),
      DECISION_TIME_MS,
      300,
    );
    expect(result).toBe(availabilityIndex.AVAILABILITY_CLASS.IDLE_READY);
  });

  test("and the same shape while charging non-interruptibly is not indexed, rather than offered work", () => {
    const result = availabilityIndex.classify(
      eligible({
        hasActiveCommitment: false,
        idle: true,
        queueDepth: 0,
        capacity: 3,
        charging: true,
        chargingInterruptible: false,
      }),
      DECISION_TIME_MS,
      300,
    );
    expect(result).toBeNull();
    expect(
      availabilityIndex.positionRecord({
        agentId: "a1",
        shardId: "s1",
        lat: f.ORIGIN.lat,
        lon: f.ORIGIN.lon,
        state: eligible({
          hasActiveCommitment: false,
          idle: true,
          queueDepth: 0,
          capacity: 3,
          charging: true,
          chargingInterruptible: false,
        }),
        decisionTimeMs: DECISION_TIME_MS,
        finishingSoonHorizonSeconds: 300,
      }).record,
    ).toBeNull();
  });

  test("a committed agent with spare queue capacity is still QUEUE_CAPACITY_AVAILABLE (unchanged)", () => {
    const result = availabilityIndex.classify(
      eligible({
        hasActiveCommitment: true,
        idle: false,
        queueDepth: 1,
        capacity: 2,
        charging: true,
        chargingInterruptible: true,
      }),
      DECISION_TIME_MS,
      300,
    );
    expect(result).toBe(availabilityIndex.AVAILABILITY_CLASS.QUEUE_CAPACITY_AVAILABLE);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   F9-3/F9-4/F9-5 — the pruning rule, the achieved bound, and boundedness
   ═══════════════════════════════════════════════════════════════════════════ */

describe("F9-3/4/5 §6.3/§6.4 — the search, its stop condition, and its reported bound", () => {
  const originFine = cells.cellForPoint(f.ORIGIN.lat, f.ORIGIN.lon, cells.RESOLUTION.FINE);
  const IDLE = availabilityIndex.AVAILABILITY_CLASS.IDLE_READY;

  /** A `kv` stand-in holding a fixed cell → agent-id map. */
  const kvOver = (store) => ({ async smembers(key) { return store[key] ? [...store[key]] : []; } });

  const commonInput = (overrides) => ({
    legId: "leg-1",
    shardId: "default",
    originLat: f.ORIGIN.lat,
    originLon: f.ORIGIN.lon,
    leg: f.legForBound(),
    decisionTimeMs: DECISION_TIME_MS,
    rates: f.boundRates(),
    delayParameters: f.delayParameters(),
    correction: f.zeroCorrection(),
    fleetBestCase: { maxSpeedMs: 2, kappaMin: 1, betaDistMin: 0.02 },
    targetFeasible: 1,
    maxEvaluated: 100,
    maxRadiusMetres: 600,
    optimalityToleranceMilliCU: 25_000n,
    waitUntilAvailableFor: async () => 0,
    energyFor: async () => f.energyInput(),
    ...overrides,
  });

  test("F9-3: the tier 3 zone sweep does not stop while an unexplored cell's bound is below C* − Δ", async () => {
    const [emptyZoneCell, richZoneCell] = cells.ringAt(originFine, 6).slice(0, 2).sort();
    const farCentre = cells.centreOfCell(richZoneCell);
    const store = {
      [`engine:idx:default:${originFine}:${IDLE}`]: ["agent-near"],
      [`engine:idx:default:${richZoneCell}:${IDLE}`]: ["agent-far"],
    };
    const snapshots = {
      "agent-near": f.agentSnapshot({ agentId: "agent-near" }),
      "agent-far": f.agentSnapshot({ agentId: "agent-far", lat: farCentre.lat, lon: farCentre.lon }),
    };
    // A large Ω correction is what puts C* and every LB below zero — §6.4's stated
    // reason the tolerance must be additive rather than multiplicative.
    const correction = { milliCU: 5_000_000n, breakdown: null };
    const gamma = { "agent-near": 20_000n, "agent-far": -1_000_000n };

    // The fixture is admissible by construction: assert LB ≤ γ before relying on it.
    for (const [agentId, snapshot] of Object.entries(snapshots)) {
      const lb = lowerBound({
        agent: snapshot,
        waitUntilAvailableSeconds: 0,
        energy: f.energyInput(),
        leg: f.legForBound(),
        rates: f.boundRates(),
        delayParameters: f.delayParameters(),
        correction,
      });
      expect(lb.ok).toBe(true);
      expect(lb.milliCU <= gamma[agentId]).toBe(true);
    }

    const result = await expansion.expandCandidates(
      commonInput({
        correction,
        kv: kvOver(store),
        maxExpansionTiers: 3,
        zoneCells: { originZoneId: "z1", cellIds: [emptyZoneCell, richZoneCell] },
        loadAgentSnapshot: async (id) => snapshots[id],
        evaluateExact: async (agentId) => ({ feasible: true, gammaMilliCU: gamma[agentId], dutyCycle: 0, healthTier: 0 }),
      }),
    );

    // C* − Δ is −5 000 milli-CU here, so a stop condition that assumed the unexplored
    // minimum was 0 fired immediately and never reached agent-far.
    expect(result.candidates.map((c) => c.agentId)).toContain("agent-far");
    expect(result.bestGammaMilliCU).toBe(-1_000_000n);
  });

  test("F9-3: zone cells are visited in increasing order of their own bound, not cell-id order", async () => {
    const ring = cells.ringAt(originFine, 4);
    const near = cells.ringAt(originFine, 1)[0];
    // Pick a far cell that sorts BEFORE the near one lexicographically, so cell-id
    // order and bound order disagree.
    const far = ring.filter((cellId) => cellId < near).sort()[0];
    expect(far).toBeDefined();

    const visited = [];
    const store = {};
    const result = await expansion.expandCandidates(
      commonInput({
        maxExpansionTiers: 3,
        maxRadiusMetres: 1, // ring 0 only, so tier 3 does the work
        zoneCells: { originZoneId: "z1", cellIds: [far, near] },
        kv: {
          async smembers(key) {
            const cellId = key.split(":")[3];
            if (cellId === far || cellId === near) visited.push(cellId);
            return store[key] || [];
          },
        },
        loadAgentSnapshot: async () => null,
        evaluateExact: async () => ({ feasible: false }),
      }),
    );

    expect(result.problems).toEqual([]);
    expect(visited[0]).toBe(near);
    expect(visited).toContain(far);
    expect(near > far).toBe(true); // the ordering is not the lexicographic one
  });

  test("F9-4: a truncation part-way through a ring bounds the gap against THAT ring, not the next", async () => {
    const ring3 = cells.ringAt(originFine, 3);
    const store = { [`engine:idx:default:${originFine}:${IDLE}`]: ["agent-000"] };
    ring3.forEach((cellId, index) => {
      store[`engine:idx:default:${cellId}:${IDLE}`] = [`agent-r3-${String(index).padStart(3, "0")}`];
    });

    const result = await expansion.expandCandidates(
      commonInput({
        kv: kvOver(store),
        maxExpansionTiers: 2,
        maxRadiusMetres: 5000,
        targetFeasible: 99,
        maxEvaluated: 2,
        optimalityToleranceMilliCU: 0n,
        loadAgentSnapshot: async (id) => f.agentSnapshot({ agentId: id }),
        evaluateExact: async () => ({ feasible: true, gammaMilliCU: 900_000n, dutyCycle: 0, healthTier: 0 }),
      }),
    );

    const floorAt = (k) =>
      expansion.unexploredRingFloorMilliCU({
        ringDistance: k,
        resolution: cells.RESOLUTION.FINE,
        leg: f.legForBound(),
        decisionTimeMs: DECISION_TIME_MS,
        fleetBestCase: { maxSpeedMs: 2, kappaMin: 1, betaDistMin: 0.02 },
        rates: f.boundRates(),
        delayParameters: f.delayParameters(),
        correction: f.zeroCorrection(),
      }).milliCU;

    expect(result.truncatedBy).toBe("candidate.max_evaluated");
    expect(result.unexploredRingDistance).toBe(3);
    // The proven bound uses ring 3's floor (the ring that is still partly unqueried),
    // not ring 4's, which would understate it.
    expect(result.achievedGapMilliCU).toBe(900_000n - floorAt(3));
    expect(result.achievedGapMilliCU > 900_000n - floorAt(4)).toBe(true);
    expect(result.achievedGapProven).toBe(true);
  });

  test("F9-4: with nothing priced there is no C*, so no gap is claimed", async () => {
    const result = await expansion.expandCandidates(
      commonInput({
        kv: kvOver({}),
        maxExpansionTiers: 2,
        loadAgentSnapshot: async () => null,
        evaluateExact: async () => ({ feasible: false }),
      }),
    );
    expect(result.bestGammaMilliCU).toBeNull();
    expect(result.achievedGapMilliCU).toBeNull();
    expect(result.achievedGapProven).toBe(false);
  });

  test("F9-5: agents whose LB does not resolve are reported, not silently dropped", async () => {
    const store = { [`engine:idx:default:${originFine}:${IDLE}`]: ["agent-a", "agent-b"] };
    const result = await expansion.expandCandidates(
      commonInput({
        kv: kvOver(store),
        maxExpansionTiers: 1,
        // No kinematic limits, so lowerBound() cannot resolve.
        loadAgentSnapshot: async (id) => ({ agentId: id, lat: f.ORIGIN.lat, lon: f.ORIGIN.lon }),
        evaluateExact: async () => {
          throw new Error("evaluateExact must not be reached when LB is unresolved");
        },
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.unresolvedBoundAgentIds).toEqual(["agent-a", "agent-b"]);
    expect(result.truncatedBy).toBe("lower_bound_unresolved");
    expect(result.candidates).toEqual([]);
    expect(result.problems.join(" ")).toMatch(/LB\(a, l\) did not resolve/);
  });

  test("F9-5: k-ring expansion with neither a radius nor a clock budget is refused, not run", async () => {
    const result = await expansion.expandCandidates(
      commonInput({
        kv: kvOver({}),
        maxExpansionTiers: 2,
        maxRadiusMetres: undefined,
        deadlineMs: undefined,
        elapsedMs: undefined,
        loadAgentSnapshot: async () => null,
        evaluateExact: async () => ({ feasible: false }),
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.truncatedBy).toBe("unbounded_search_refused");
    expect(result.cellsExplored).toBe(0);
    expect(result.problems.join(" ")).toMatch(/candidate\.max_radius_by_sla_class/);
  });

  test("F9-5: a wall-clock budget alone satisfies the boundedness requirement", async () => {
    let elapsed = 0;
    const result = await expansion.expandCandidates(
      commonInput({
        kv: kvOver({}),
        maxExpansionTiers: 2,
        maxRadiusMetres: undefined,
        deadlineMs: 5,
        elapsedMs: () => (elapsed += 1),
        loadAgentSnapshot: async () => null,
        evaluateExact: async () => ({ feasible: false }),
      }),
    );
    expect(result.truncatedBy).not.toBe("unbounded_search_refused");
  });

  test("tier 1 only (maxExpansionTiers = 1) still needs no radius — the ring loop cannot grow", async () => {
    const result = await expansion.expandCandidates(
      commonInput({
        kv: kvOver({}),
        maxExpansionTiers: 1,
        maxRadiusMetres: undefined,
        loadAgentSnapshot: async () => null,
        evaluateExact: async () => ({ feasible: false }),
      }),
    );
    expect(result.truncatedBy).not.toBe("unbounded_search_refused");
    expect(result.cellsExplored).toBe(1);
  });
});
