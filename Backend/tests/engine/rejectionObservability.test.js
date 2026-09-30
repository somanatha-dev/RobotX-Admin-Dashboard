"use strict";

/**
 * P1.1 — the engine's refusals are recorded where the design already puts them.
 *
 * Two levels, both designed and neither connected before this change (measured on a live
 * `server.js`, 2026-09-27: `RejectionAggregate` empty, `DecisionRecordA.rejectionSummary`
 * `{}` for a Leg every robot was refused):
 *
 *   · §7.7 — the shard histogram. `feasibility.gate(…, { aggregator, dimensions })` folds
 *     each denial into the process's aggregator, which the rejection-aggregation flusher
 *     drains to `RejectionAggregate`. The coordinator's gate call passed no aggregator, and
 *     `server.js` created the flusher's aggregator where nothing else could reach it.
 *   · §21.2 — the per-Leg decision record. `runRound` hands `perLeg[legId]` to
 *     `decisionRecord.writeRound`, which writes `rejectionSummary` (per-predicate counts) and
 *     the compact top-N (each candidate, and **if rejected, its binding predicate only**).
 *     Nothing supplied `perLeg`.
 *
 * The rows below are built by the modules that write them (`tierA.compactTopN`,
 * `tierA.rejectionSummaryOf`), and the capability verdicts by the real F21 against the
 * bundle commissioning writes. Observation only: the gate's verdict is asserted unchanged.
 */

const fs = require("fs");
const path = require("path");

const coordinatorSolvePath = require("../../src/workers/coordinatorSolvePath");
const coordinator = require("../../src/workers/coordinator.worker");
const planState = require("../../src/engine/shard/planState");
const intake = require("../../src/engine/intake/intake");
const leadership = require("../../src/engine/shard/leadership");
const feasibility = require("../../src/engine/feasibility/evaluate");
const rejectionTelemetry = require("../../src/engine/feasibility/rejectionTelemetry");
const f21 = require("../../src/engine/feasibility/predicates/f21");
const tierA = require("../../src/engine/observability/tierA");
const robotSpecification = require("../../src/services/robotSpecification");
const fixture = require("./helpers/roundFixture");

const { REFUSAL } = coordinatorSolvePath;
const BACKEND = path.resolve(__dirname, "../..");

/** The capability bundle commissioning writes for a simulated ROVER rated 5 kg. */
const ROVER_BUNDLE = {
  bundleId: "CAP-V1DEMO-02",
  capabilities: robotSpecification.capabilityRowsFor(robotSpecification.CHASSIS_TYPE.ROVER, { payloadCapacityKg: 5 }),
};

/** A round state with one pinned Leg, as `rememberLeg` leaves it. */
function roundWithLeg() {
  const legs = new Map([["LEG-T1", { leg: { legId: "LEG-T1", legRowId: "leg-row-1", purpose: "PRIMARY" } }]]);
  return { legs, outcomes: new Map() };
}
const LEG = { legId: "LEG-T1" };

/** The real F21 verdict for a form submission, and the §7.7 tuple the gate derives from it. */
function f21Denial(submission, agentId) {
  const result = f21.evaluate({
    agentSnapshot: { capabilityBundle: ROVER_BUNDLE },
    mission: { requirements: robotSpecification.requirementSetFor(submission) },
    plan: {},
  });
  return { result, tuple: rejectionTelemetry.tupleFrom({ agentId, predicateId: "F21", result, dimensions: { shardId: "v1demo-shard" } }) };
}

/** What `evaluateExact` returns for a gate denial (`coordinatorSolvePath.js`, step 4). */
const infeasible = (predicateIds) => ({ feasible: false, gammaMilliCU: null, refusal: REFUSAL.INFEASIBLE, denials: predicateIds });

describe("§21.2 — each candidate's outcome is recorded for its Leg", () => {
  test("no route: refused before the gate — recorded with its refusal, and no predicate count", () => {
    const round = roundWithLeg();
    coordinatorSolvePath.noteCandidateOutcome(round, LEG, "V1DEMO-05", { agentId: "V1DEMO-05" }, {
      feasible: false,
      gammaMilliCU: null,
      refusal: REFUSAL.MISSING_HOP,
      problems: ["stop 0: the Routing Service failed: cell … is OUTSIDE relative to the serviceable region"],
    });
    const perLeg = coordinatorSolvePath.perLegFor(round)["leg-row-1"];
    expect(perLeg.candidates).toEqual([{ agentId: "V1DEMO-05", rejected: true, bindingPredicateId: "MISSING_HOP", gammaMilliCU: null }]);
    // Never evaluated by the gate, so no §7.7 tuple — the histogram counts predicates only.
    expect(perLeg.rejectionSummary).toEqual([]);
  });

  test("insufficient energy: F34 with its binding tier, as §7.7 keys it", () => {
    const round = roundWithLeg();
    const tuple = rejectionTelemetry.tupleFrom({
      agentId: "V1DEMO-06",
      predicateId: "F34",
      result: { outcome: "VIOLATED", observed: { bindingTier: "RETURN" }, reason: "E_return: insufficient energy" },
    });
    coordinatorSolvePath.noteRejectionTuples(round, LEG, [tuple]);
    coordinatorSolvePath.noteCandidateOutcome(round, LEG, "V1DEMO-06", { agentId: "V1DEMO-06" }, infeasible(["F34"]));

    const perLeg = coordinatorSolvePath.perLegFor(round)["LEG-T1"];
    expect(perLeg.rejectionSummary).toEqual([{ predicateId: "F34", tier: "RETURN", count: 1 }]);
    expect(perLeg.candidates[0]).toMatchObject({ agentId: "V1DEMO-06", rejected: true, bindingPredicateId: "F34" });
  });

  test("capability (DRONE + 1 kg on a ROVER fleet): the real F21 is VIOLATED and recorded as F21", () => {
    const round = roundWithLeg();
    const { result, tuple } = f21Denial({ chassisType: "DRONE", payloadMassKg: 1 }, "V1DEMO-02");
    expect(result.outcome).toBe("VIOLATED");
    expect(tuple).toMatchObject({ predicateId: "F21", outcome: "VIOLATED", indeterminate: false });

    coordinatorSolvePath.noteRejectionTuples(round, LEG, [tuple]);
    coordinatorSolvePath.noteCandidateOutcome(round, LEG, "V1DEMO-02", { agentId: "V1DEMO-02" }, infeasible(["F21"]));
    const perLeg = coordinatorSolvePath.perLegFor(round)["LEG-T1"];
    expect(perLeg.rejectionSummary).toEqual([{ predicateId: "F21", tier: null, count: 1 }]);
    expect(perLeg.candidates[0].bindingPredicateId).toBe("F21");
  });

  test("payload (ROVER + 10 kg on 5 kg units): the real F21 is VIOLATED on max_payload_mass, recorded as F21", () => {
    const round = roundWithLeg();
    const { result, tuple } = f21Denial({ chassisType: "ROVER", payloadMassKg: 10 }, "V1DEMO-03");
    expect(result.outcome).toBe("VIOLATED");
    expect(result.reason).toMatch(/max_payload_mass/);

    coordinatorSolvePath.noteRejectionTuples(round, LEG, [tuple]);
    coordinatorSolvePath.noteCandidateOutcome(round, LEG, "V1DEMO-03", { agentId: "V1DEMO-03" }, infeasible(["F21"]));
    expect(coordinatorSolvePath.perLegFor(round)["LEG-T1"].candidates[0].bindingPredicateId).toBe("F21");
  });

  test("successful assignment: a priced candidate is recorded as priced, never as a rejection", () => {
    const round = roundWithLeg();
    coordinatorSolvePath.noteCandidateOutcome(round, LEG, "V1DEMO-01", { agentId: "V1DEMO-01" }, { feasible: true, gammaMilliCU: 41234n });
    const perLeg = coordinatorSolvePath.perLegFor(round)["LEG-T1"];
    expect(perLeg.candidates).toEqual([{ agentId: "V1DEMO-01", rejected: false, gammaMilliCU: 41234n }]);
    expect(perLeg.rejectionSummary).toEqual([]);
  });

  test("the same robot evaluated twice for one Leg in one round is one row, not two", () => {
    const round = roundWithLeg();
    for (let i = 0; i < 2; i += 1) {
      coordinatorSolvePath.noteCandidateOutcome(round, LEG, "V1DEMO-02", { agentId: "V1DEMO-02" }, infeasible(["F21"]));
    }
    expect(coordinatorSolvePath.perLegFor(round)["LEG-T1"].candidates).toHaveLength(1);
  });

  test("the persisted Tier A sections: priced candidates first, then each rejected one with its binding predicate", () => {
    const round = roundWithLeg();
    const drone = f21Denial({ chassisType: "DRONE" }, "V1DEMO-02");
    coordinatorSolvePath.noteRejectionTuples(round, LEG, [drone.tuple]);
    coordinatorSolvePath.noteCandidateOutcome(round, LEG, "V1DEMO-02", { agentId: "V1DEMO-02" }, infeasible(["F21"]));
    coordinatorSolvePath.noteCandidateOutcome(round, LEG, "V1DEMO-05", { agentId: "V1DEMO-05" }, {
      feasible: false, gammaMilliCU: null, refusal: REFUSAL.MISSING_HOP, problems: [],
    });
    coordinatorSolvePath.noteCandidateOutcome(round, LEG, "V1DEMO-01", { agentId: "V1DEMO-01" }, { feasible: true, gammaMilliCU: 500n });

    const perLeg = coordinatorSolvePath.perLegFor(round)["leg-row-1"];
    const topN = tierA.compactTopN({ candidates: perLeg.candidates, chosenAgentId: "V1DEMO-01", topN: 5 }).topN;
    expect(topN).toEqual([
      { agentId: "V1DEMO-01", gammaMilliCU: "500", discoveryTier: null, chosen: true },
      { agentId: "V1DEMO-02", gammaMilliCU: null, discoveryTier: null, bindingPredicateId: "F21" },
      { agentId: "V1DEMO-05", gammaMilliCU: null, discoveryTier: null, bindingPredicateId: "MISSING_HOP" },
    ]);
    expect(tierA.rejectionSummaryOf(perLeg.rejectionSummary)).toEqual({ F21: 1 });
  });
});

describe("§21.2 — runRound hands the composition's per-Leg context to the decision record", () => {
  const SHARD = leadership.DEFAULT_SHARD_ID;
  const NOW = new Date("2026-09-27T12:00:00.000Z");
  const CONFIG = { windowMinMs: 500, windowMaxMs: 3000, saturatedWindowMs: 10000, batchGrowthThreshold: 10, fastPathClasses: [], maxLegsPerRound: 500 };

  function store() {
    const prisma = fixture.memoryPrisma();
    prisma.$queryRawUnsafe = async (sql) => {
      if (sql.includes("NOW()")) return [{ now: NOW }];
      if (sql.includes("ShardLeadership")) {
        return [{ shardId: SHARD, leadershipFence: "7", holder: "instance-1", leaseExpiry: new Date(NOW.getTime() + 60_000) }];
      }
      return [];
    };
    prisma.leg = { findMany: async () => [], updateMany: async () => ({ count: 0 }) };
    return prisma;
  }

  async function runWith(extraDeps, sourceExtra) {
    const prisma = store();
    await prisma.workQueue.create({
      data: {
        legId: "leg-row-1", shardId: SHARD, idempotencyKey: "k-1", purpose: "PRIMARY", slaClass: "standard",
        priority: 0, state: intake.QUEUE_STATE.QUEUED, enqueuedAt: new Date(NOW.getTime() - 1000),
      },
    });
    const result = await coordinator.runRound(
      {
        prisma,
        planState: planState.create({ shardId: SHARD }),
        // Nothing survives: the round's own outcome is NO_FEASIBLE_CANDIDATE.
        expandCandidates: async () => ({ candidates: [], achievedGapMilliCU: 0n, problems: [] }),
        pricedCandidateFor: () => null,
        commit: async () => ({ committed: false }),
        ...extraDeps,
      },
      { shardId: SHARD, config: CONFIG, feasibleSupply: 3, nowMs: NOW.getTime(), instanceId: "instance-1", killSwitches: {}, ...sourceExtra },
    );
    return { prisma, result };
  }

  test("a Leg no robot could take: its record names the Leg, the outcome, the counts and each robot's reason", async () => {
    const perLeg = {
      "leg-row-1": {
        candidates: [
          { agentId: "V1DEMO-02", rejected: true, bindingPredicateId: "F21", gammaMilliCU: null },
          { agentId: "V1DEMO-05", rejected: true, bindingPredicateId: "MISSING_HOP", gammaMilliCU: null },
        ],
        rejectionSummary: [{ predicateId: "F21", tier: null, count: 3 }],
      },
    };
    const { prisma, result } = await runWith({ perLegFor: () => perLeg });

    expect(result.ran).toBe(true);
    const [record] = prisma.__tables.decisionRecords;
    expect(record).toMatchObject({ legId: "leg-row-1", rejectionSummary: { F21: 3 } });
    expect(record.outcome).toMatchObject({ outcome: "NO_FEASIBLE_CANDIDATE" });
    expect(record.runnerUpAndTopN.topN).toEqual([
      { agentId: "V1DEMO-02", gammaMilliCU: null, discoveryTier: null, bindingPredicateId: "F21" },
      { agentId: "V1DEMO-05", gammaMilliCU: null, discoveryTier: null, bindingPredicateId: "MISSING_HOP" },
    ]);
    // The Leg stays queued — a record explains the round; it does not change the lifecycle.
    expect(prisma.__tables.workQueue[0].state).toBe(intake.QUEUE_STATE.QUEUED);
  });

  test("with no composition hook, a caller's own perLeg is used exactly as before", async () => {
    const { prisma } = await runWith({}, { perLeg: { "leg-row-1": { rejectionSummary: [{ predicateId: "F9", tier: null, count: 1 }] } } });
    expect(prisma.__tables.decisionRecords[0].rejectionSummary).toEqual({ F9: 1 });
  });

  test("with neither, the record is written as it always was (empty summary)", async () => {
    const { prisma } = await runWith({});
    expect(prisma.__tables.decisionRecords[0].rejectionSummary).toEqual({});
  });
});

describe("§7.7 — the gate folds into the aggregator it is given, and its verdict does not change", () => {
  const candidateAndContext = () => ({
    candidate: { plan: "p" },
    context: {
      agentSnapshot: { agentId: "V1DEMO-02", capabilityBundle: ROVER_BUNDLE },
      mission: { requirements: robotSpecification.requirementSetFor({ chassisType: "DRONE" }) },
      plan: {},
      config: { get: () => undefined },
      decisionTimeMs: Date.now(),
    },
  });

  test("same feasible/denials with and without telemetry options; the denials reach the aggregator with their shard", () => {
    const aggregator = rejectionTelemetry.createAggregator();
    const plain = feasibility.gate(candidateAndContext().candidate, candidateAndContext().context);
    const observed = feasibility.gate(candidateAndContext().candidate, candidateAndContext().context, {
      aggregator,
      dimensions: { shardId: "v1demo-shard", missionClass: "DELIVERY", legPurpose: "PRIMARY" },
    });

    expect(observed.feasible).toBe(false);
    expect(observed.feasible).toBe(plain.feasible);
    const denied = observed.outcome.denials.map((row) => row.predicateId);
    expect(denied).toEqual(plain.outcome.denials.map((row) => row.predicateId));
    expect(denied.length).toBeGreaterThan(0);

    // Every denial the gate returned is in the aggregator, under the dimensions it was given.
    const drained = aggregator.drain();
    for (const predicateId of denied) {
      expect(drained.distribution.find((row) => row.predicateId === predicateId)).toMatchObject({
        shardId: "v1demo-shard",
        missionClass: "DELIVERY",
        legPurpose: "PRIMARY",
        count: 1,
      });
    }
  });
});

describe("§7.7 — the flusher persists what it drains, on any server", () => {
  const flusher = require("../../src/workers/rejectionAggregation.worker");

  function capturingPrisma() {
    const writes = { raw: [], sketchWhere: [] };
    return {
      writes,
      prisma: {
        async $executeRaw(strings, ...values) {
          writes.raw.push({ sql: strings.join("?"), values });
          return 1;
        },
        nearMissSketch: {
          async findUnique(args) {
            // What Prisma does with a null inside a compound-unique `where` (measured live).
            const key = args.where.shardId_predicateId_marginUnit_bucketStart;
            if (key.shardId === null) throw new Error("Argument `shardId` must not be null.");
            writes.sketchWhere.push(key);
            return null;
          },
          async upsert() {},
        },
      },
    };
  }
  const snapshot = () => ({
    distribution: [{ shardId: "v1demo-shard", predicateId: "F21", tier: null, count: 3 }],
    sketches: [{ predicateId: "F34", marginUnit: "Wh", buckets: [{ bucket: 2, count: 1 }], total: 1 }],
  });
  const AT = Date.parse("2026-09-27T10:03:39.606Z");

  test("bucket and row times are bound as UTC instants and written in UTC, whatever the session zone", async () => {
    const { prisma, writes } = capturingPrisma();
    await flusher.flushSnapshot({ prisma }, snapshot(), { atMs: AT, shardId: "v1demo-shard" });
    const [insert] = writes.raw;
    expect(insert.values).toContain("2026-09-27T10:00:00.000Z");
    expect(insert.values).toContain("2026-09-27T10:05:00.000Z");
    expect(insert.values.some((value) => value instanceof Date)).toBe(false);
    expect(insert.sql.match(/AT TIME ZONE 'UTC'/g)).toHaveLength(5);
    expect(insert.sql).not.toMatch(/,\s*CURRENT_TIMESTAMP\s*\)/);
  });

  test("with its shard, the sketch half writes; without one it is the error every flush used to raise", async () => {
    const ok = capturingPrisma();
    await expect(flusher.flushSnapshot({ prisma: ok.prisma }, snapshot(), { atMs: AT, shardId: "v1demo-shard" }))
      .resolves.toMatchObject({ aggregatesWritten: 1, sketchesWritten: 1 });
    expect(ok.writes.sketchWhere[0].shardId).toBe("v1demo-shard");

    const bad = capturingPrisma();
    await expect(flusher.flushSnapshot({ prisma: bad.prisma }, snapshot(), { atMs: AT, shardId: null }))
      .rejects.toThrow(/shardId` must not be null/);
  });

  test("server.js starts the flusher for this process's shard", () => {
    const server = fs.readFileSync(path.join(BACKEND, "server.js"), "utf8");
    const start = server.slice(server.indexOf("rejectionAggregationWorker.start("));
    expect(start.slice(0, 200)).toMatch(/\{ shardId: process\.env\.SHARD_ID \|\| "default" \}/);
  });
});

describe("composition — one aggregator, reachable from both ends", () => {
  test("server.js creates it once and hands it to the coordinator and to the flusher", () => {
    const server = fs.readFileSync(path.join(BACKEND, "server.js"), "utf8");
    expect(server.match(/const rejectionAggregator = rejectionTelemetry\.createAggregator\(\);/g)).toHaveLength(1);
    const create = server.slice(server.indexOf("leaderLifecycle = leaderWorkers.create({"));
    expect(create.slice(0, 400)).toMatch(/\brejectionAggregator,/);
    const scheduled = server.slice(server.indexOf("engineWorkers = startScheduledWorkers({"));
    expect(scheduled.slice(0, 200)).toMatch(/\brejectionAggregator,/);
    expect(server).toMatch(/const aggregator = context\.rejectionAggregator \|\| rejectionTelemetry\.createAggregator\(\);/);
  });

  test("the coordinator's gate call passes that aggregator and the §7.7 dimensions", () => {
    const solvePath = fs.readFileSync(path.join(BACKEND, "src/workers/coordinatorSolvePath.js"), "utf8");
    const call = solvePath.slice(solvePath.indexOf("const gated = feasibility.gate(built.plan"));
    expect(call.slice(0, 1400)).toMatch(/aggregator: context\.rejectionAggregator \|\| undefined,/);
    expect(call.slice(0, 1400)).toMatch(/shardId: context\.shardId \?\? null,/);
  });
});
