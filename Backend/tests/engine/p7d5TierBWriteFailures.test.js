"use strict";

/**
 * P7-D5 D6 — a Tier B write that does not land is reported as exactly what happened.
 *
 * Found (P7-D5 audit D6, re-traced 2026-10-11):
 *   · `decisionRecord.writeRound` discarded the Tier A claim's `updateMany` result, so a claim that
 *     matched no row still returned `tierBWritten: true` and counted in `tierBCount`;
 *   · a failed `DecisionRecordB.create` (no row) and a failed claim after a successful create (an
 *     orphan Tier B row) produced identical failure entries;
 *   · `coordinator.tier_b_write_failed` and `coordinator.snapshot_unpinned` reached the operator only
 *     as info-level `engine.*` lines among every routine coordinator event.
 *
 * The zero-row claim is SIMULATED here with the in-memory Prisma double (`updateMany` made to report
 * `{ count: 0 }`); it was reproduced against the pre-D6 code the same way (scratchpad
 * `p7d5-d6/zero-row-claim-BEFORE.txt`). It has NOT been reproduced against a real database — no
 * concrete production path to a zero-row claim is known; this closes the reporting hole regardless.
 *
 * MOCKED BOUNDARY: the store (`roundFixture.memoryPrisma`, `phase7World`'s in-memory Prisma), and
 * — for the composer routing — `coordinatorSolvePath.create`, replaced by an assembly whose
 * `deps.record` is the context's `record`, exactly as the real one builds it (`record:
 * enriched.record`, asserted below from the source).
 */

const fs = require("fs");
const path = require("path");

const decisionRecord = require("../../src/engine/observability/decisionRecord");
const sampling = require("../../src/engine/observability/sampling");
const tierB = require("../../src/engine/observability/tierB");
const configService = require("../../src/engine/config/service");
const coordinator = require("../../src/workers/coordinator.worker");
const coordinatorSolvePath = require("../../src/workers/coordinatorSolvePath");
const leaderWorkers = require("../../src/workers/leaderWorkers");
const tierBWorker = require("../../src/workers/tierB.worker");
const planStateModel = require("../../src/engine/shard/planState");
const intake = require("../../src/engine/intake/intake");
const leadership = require("../../src/engine/shard/leadership");
const replay = require("../../tools/replay/replayDecision");
const fixture = require("./helpers/roundFixture");
const w = require("./helpers/phase7World");

const { TIER_B_WRITE_STAGE } = decisionRecord;

const T = 1_790_000_040_000;
const ROUND = {
  roundId: `default:${T}`,
  shardId: "default",
  decisionTimeMs: T,
  regime: "SINGLETON",
  columns: { generated: 0, kept: 0, pruned: 0, bestPrunedGammaMilliCU: null },
  budgets: { budgetLimited: false, exceeded: [] },
  lpIpGapMilliCU: 0n,
  committed: [],
  decisions: [{ legId: "L1", outcome: "NO_FEASIBLE_CANDIDATE" }],
};
const TIER_B_INPUT = { candidates: [{ agentId: "A1", rejected: true, bindingPredicateId: "F7", predicateResults: [] }], columns: [], pruned: [] };

/** Write ROUND's one decision, sampled, against `prisma`. */
function writeOne(prisma) {
  return decisionRecord.writeRound(
    { prisma },
    {
      round: ROUND,
      context: { shardId: "default", snapshot: { snapshotId: ROUND.roundId, pins: null, seed: "00" }, perLeg: { L1: { candidates: [], tierBInput: TIER_B_INPUT } } },
      budget: sampling.createBudget({}),
      config: { sampleRate: 1, fullRetentionDays: 30, tierBRetentionDays: 30, snapshotRetentionDays: 30 },
      nowMs: T,
    },
  );
}

/** The decision's Tier A row joined to its Tier B, as `replayDecision` reads it. */
function joined(prisma) {
  const row = prisma.__tables.decisionRecords[0];
  return { ...row, tierB: prisma.__tables.tierBRecords.find((b) => b.decisionId === row.decisionId) || null };
}

/* ═══════════════════════════════════════════════════════════════════════════
   1. The writer reports what the store holds
   ═══════════════════════════════════════════════════════════════════════════ */

describe("P7-D5 D6 — decisionRecord.writeRound: the claim must land on exactly one row", () => {
  test("normal success: one row claimed, tierBWritten true, no failure", async () => {
    const prisma = fixture.memoryPrisma();
    const result = await writeOne(prisma);
    expect(result).toMatchObject({ tierBCount: 1, tierBFailures: [] });
    expect(result.written[0].tierBWritten).toBe(true);
    expect(prisma.__tables.decisionRecords[0]).toMatchObject({ tierBWritten: true, tierBReason: "SAMPLED" });
    expect(prisma.__tables.tierBRecords).toHaveLength(1);
  });

  test("Tier B create fails: no row, a CREATE failure that says no row may exist, Tier A false", async () => {
    const prisma = fixture.memoryPrisma();
    prisma.decisionRecordB.create = async () => {
      throw new Error("disk full");
    };
    const result = await writeOne(prisma);
    expect(result.tierBFailures).toEqual([
      { decisionId: prisma.__tables.decisionRecords[0].decisionId, stage: TIER_B_WRITE_STAGE.CREATE, tierBRowMayExist: false, message: "disk full" },
    ]);
    expect(result).toMatchObject({ tierBCount: 0 });
    expect(result.written[0].tierBWritten).toBe(false);
    expect(prisma.__tables.tierBRecords).toHaveLength(0);
    expect(prisma.__tables.decisionRecords[0]).toMatchObject({ tierBWritten: false, tierBReason: null });
  });

  test("the claim throws after a successful create: a CLAIM failure flagging the orphan row; Tier A false", async () => {
    const prisma = fixture.memoryPrisma();
    prisma.decisionRecordA.updateMany = async () => {
      throw new Error("deadlock detected");
    };
    const result = await writeOne(prisma);
    expect(result.tierBFailures).toEqual([
      { decisionId: prisma.__tables.decisionRecords[0].decisionId, stage: TIER_B_WRITE_STAGE.CLAIM, tierBRowMayExist: true, message: "deadlock detected" },
    ]);
    expect(result.written[0].tierBWritten).toBe(false);
    expect(prisma.__tables.tierBRecords).toHaveLength(1); // the orphan — kept, never repaired here
    expect(prisma.__tables.decisionRecords[0].tierBWritten).toBe(false);
  });

  test.each([
    [{ count: 0 }, "the Tier A claim updated 0 row(s), not exactly 1"],
    [{ count: 2 }, "the Tier A claim updated 2 row(s), not exactly 1"],
    [undefined, "the Tier A claim updated an unknown number of row(s), not exactly 1"],
  ])("SIMULATED zero/other-row claim (%j): reported as a CLAIM failure, never as written", async (claimResult, message) => {
    // Pre-D6, `{ count: 0 }` returned tierBWritten: true, tierBCount: 1 and no failure while the
    // store said false (p7d5-d6/zero-row-claim-BEFORE.txt). The double's claim touches no row.
    const prisma = fixture.memoryPrisma();
    prisma.decisionRecordA.updateMany = async () => claimResult;
    const result = await writeOne(prisma);
    expect(result.written[0].tierBWritten).toBe(false);
    expect(result.tierBCount).toBe(0);
    expect(result.tierBFailures).toEqual([
      { decisionId: prisma.__tables.decisionRecords[0].decisionId, stage: TIER_B_WRITE_STAGE.CLAIM, tierBRowMayExist: true, message },
    ]);
    // What the writer reports now matches the store.
    expect(prisma.__tables.decisionRecords[0].tierBWritten).toBe(result.written[0].tierBWritten);
  });

  test("the claim statement itself is unchanged: same table, same guard, same two columns", () => {
    const source = fs.readFileSync(path.join(__dirname, "../../src/engine/observability/decisionRecord.js"), "utf8");
    expect(source).toMatch(
      /const claimed = await deps\.prisma\.decisionRecordA\.updateMany\(\{\s*where: \{ decisionId: record\.identity\.decisionId, tierBWritten: false \},\s*data: \{ tierBWritten: true, tierBReason: selection\.verdict\.writtenBecause \},\s*\}\);/,
    );
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   2. The orphan a CLAIM failure can leave: D5 replay and D1 retention
   ═══════════════════════════════════════════════════════════════════════════ */

describe("P7-D5 D6 — an orphan Tier B row is read honestly and expires normally", () => {
  async function orphan() {
    const prisma = fixture.memoryPrisma();
    const claim = prisma.decisionRecordA.updateMany;
    prisma.decisionRecordA.updateMany = async () => ({ count: 0 });
    await writeOne(prisma);
    prisma.decisionRecordA.updateMany = claim;
    return prisma;
  }

  test("D5 replay: RETAINED (by row presence), with Tier A's flag reported as stored — false", async () => {
    const prisma = await orphan();
    const row = joined(prisma);
    const result = await replay.replayDecision(
      { prisma: { decisionRecordA: { findUnique: async () => ({ ...row, inputSnapshot: prisma.__tables.snapshots[0] }) } }, round: { plan: async () => ({ decisions: [] }) } },
      row.decisionId,
    );
    expect(result).toMatchObject({ tierBState: replay.TIER_B_STATE.RETAINED, tierBWritten: false, tierBPresent: true });
  });

  test("D5 replay after a CREATE failure: TIER_B_NEVER_WRITTEN", async () => {
    const prisma = fixture.memoryPrisma();
    prisma.decisionRecordB.create = async () => {
      throw new Error("disk full");
    };
    await writeOne(prisma);
    expect(replay.tierBStateOf(joined(prisma))).toBe(replay.TIER_B_STATE.NEVER_WRITTEN);
  });

  test("D1 retention: the orphan expires like any Tier B row, and Tier A is not touched", async () => {
    const prisma = await orphan();
    const before = JSON.parse(JSON.stringify(prisma.__tables.decisionRecords));
    const retainUntil = prisma.__tables.tierBRecords[0].retainUntil;
    const expired = await tierBWorker.expireTierB({ prisma }, { nowMs: retainUntil.getTime() + 1 });
    expect(expired.expired).toBe(1);
    expect(prisma.__tables.tierBRecords).toHaveLength(0);
    expect(JSON.parse(JSON.stringify(prisma.__tables.decisionRecords))).toEqual(before);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   3. TSK-816: nothing about the decision or its Tier B changes
   ═══════════════════════════════════════════════════════════════════════════ */

describe("P7-D5 D6 — TSK-816 through the real path and the real writer", () => {
  test("the decision and the Tier B hash are the pre-D4/D6 baseline; the claim lands; no failure", async () => {
    const out = await w.decide({
      decisionTimeMs: w.TSK816.assignRoundMs,
      // Replayed as recorded (5 % floor then; see `phase7World.asRecorded`).
      robots: w.asRecorded([
        { robotId: "SIM-0A8C043FFE67", at: { lat: 12.901151, lon: 77.517575 }, socFraction: 0.2, status: "IDLE", positionAgeMs: 351 },
        { robotId: "SIM-1ABF21512BE5", at: { lat: 12.900817, lon: 77.518043 }, socFraction: 0.9, status: "IDLE", positionAgeMs: 350 },
        { robotId: "SIM-9F6F88D84EBD", at: { lat: 12.90032004, lon: 77.51870238 }, socFraction: 0.95, status: "IDLE", positionAgeMs: 1360 },
      ]),
    });
    expect(out.winner).toBe("SIM-9F6F88D84EBD");
    const round = { ...ROUND, roundId: `default:${w.TSK816.assignRoundMs}`, decisionTimeMs: w.TSK816.assignRoundMs, partitions: [], decisions: [out.decision] };
    const prisma = fixture.memoryPrisma();
    const result = await decisionRecord.writeRound(
      { prisma },
      {
        round,
        context: {
          shardId: "default",
          snapshot: { snapshotId: round.roundId, pins: null, seed: "00" },
          compactTopN: 5,
          perLeg: { [out.decision.legId]: { candidates: out.candidates, rejectionSummary: out.rejectionSummary, tierBInput: out.tierBInput } },
        },
        budget: sampling.createBudget({ writeBudgetPerMinute: 10, reservoirSize: 1 }),
        config: { sampleRate: 1, compactTopN: 5, fullRetentionDays: 30, tierBRetentionDays: 30, snapshotRetentionDays: 30 },
        nowMs: w.TSK816.assignRoundMs,
      },
    );
    expect(result).toMatchObject({ tierBCount: 1, tierBFailures: [] });
    expect(prisma.__tables.tierBRecords[0].contentHash).toBe("616685b644c83d1c962c153d84989d4ef2a1c476f9e8891ab31f038532277993");
    expect(tierB.fromRow(prisma.__tables.tierBRecords[0]).contentHash).toBe("616685b644c83d1c962c153d84989d4ef2a1c476f9e8891ab31f038532277993");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   4. Evidence loss at warn — through the composer and the real runRound
   ═══════════════════════════════════════════════════════════════════════════ */

describe("P7-D5 D6 — the composer raises evidence-loss events to warn; nothing else moves", () => {
  afterEach(() => jest.restoreAllMocks());

  test("the real assembly takes deps.record from the context it is given (why the wrapper sits before create)", () => {
    const source = fs.readFileSync(path.join(__dirname, "../../src/workers/coordinatorSolvePath.js"), "utf8");
    expect(source).toMatch(/record: enriched\.record,/);
    const marker = () => {};
    expect(coordinatorSolvePath.contextFor({ record: marker, snapshot: () => configService.buildSnapshot({ version: 7 }) }).record).toBe(marker);
  });

  /**
   * Compose the coordinator through `leaderWorkers.COMPOSERS.coordinator`, then run one real round
   * with the deps it handed `coordinator.start`. The assembly stands in for
   * `coordinatorSolvePath.create`, taking `deps.record` from the context exactly as the real one does.
   */
  async function composeAndRun({ logger, tierBCreateFails, unpinned }) {
    const config = configService.buildSnapshot({ version: 7, bindings: [{ level: "global", name: "observability.tier_b_sample_rate", value: 1 }] });
    const record = jest.fn();
    let seenContext = null;
    jest.spyOn(coordinatorSolvePath, "create").mockImplementation((context) => {
      seenContext = context;
      return { ok: true, deps: { record: context.record }, context: { snapshot: () => config, expansionWallClockBudgetMs: 100 } };
    });
    let started = null;
    jest.spyOn(coordinator, "start").mockImplementation((deps, settings) => {
      started = { deps, settings };
      return { stop() {} };
    });
    const context = { values: config.values, shardId: leadership.DEFAULT_SHARD_ID, instanceId: "i-1", record, ...(logger ? { logger } : {}) };
    expect(leaderWorkers.COMPOSERS.coordinator(context).ok).toBe(true);

    // One real round with the composed deps.
    const SHARD = leadership.DEFAULT_SHARD_ID;
    const NOW = new Date("2026-10-11T12:00:00.000Z");
    const prisma = fixture.memoryPrisma();
    prisma.$queryRawUnsafe = async (sql) => {
      if (sql.includes("NOW()")) return [{ now: NOW }];
      if (sql.includes("ShardLeadership")) return [{ shardId: SHARD, leadershipFence: "7", holder: "i-1", leaseExpiry: new Date(NOW.getTime() + 60_000) }];
      return [];
    };
    prisma.leg = { findMany: async () => [], updateMany: async () => ({ count: 0 }) };
    if (tierBCreateFails) {
      prisma.decisionRecordB.create = async () => {
        throw new Error("disk full");
      };
    }
    await prisma.workQueue.create({
      data: { legId: "leg-row-1", shardId: SHARD, idempotencyKey: "k-1", purpose: "PRIMARY", slaClass: "standard", priority: 0, state: intake.QUEUE_STATE.QUEUED, enqueuedAt: new Date(NOW.getTime() - 1000) },
    });
    const result = await coordinator.runRound(
      {
        ...started.deps,
        prisma,
        planState: planStateModel.create({ shardId: SHARD }),
        expandCandidates: async () => ({ candidates: [], achievedGapMilliCU: 0n, problems: [] }),
        pricedCandidateFor: () => null,
        commit: async () => ({ committed: false }),
        perLegFor: () => ({ "leg-row-1": { candidates: [], rejectionSummary: [], tierBInput: TIER_B_INPUT } }),
        recordBudget: sampling.createBudget({}),
      },
      {
        ...started.settings,
        config: { windowMinMs: 500, windowMaxMs: 3000, saturatedWindowMs: 10000, batchGrowthThreshold: 10, fastPathClasses: [], maxLegsPerRound: 500 },
        feasibleSupply: 3,
        nowMs: NOW.getTime(),
        configSnapshot: () => config,
        codeVersion: unpinned ? null : "git:abc1234",
      },
    );
    expect(result.ran).toBe(true);
    return { record, context, seenContext, started };
  }

  test("with a logger: tier_b_write_failed and snapshot_unpinned go to logger.warn, not to the info record", async () => {
    const logger = { warn: jest.fn(), info: jest.fn(), error: jest.fn() };
    const { record } = await composeAndRun({ logger, tierBCreateFails: true, unpinned: true });
    const warned = logger.warn.mock.calls.map(([name]) => name);
    expect(warned).toEqual(expect.arrayContaining(["engine.coordinator.tier_b_write_failed", "engine.coordinator.snapshot_unpinned"]));
    const failed = logger.warn.mock.calls.find(([name]) => name === "engine.coordinator.tier_b_write_failed")[1];
    expect(failed.failures[0]).toMatchObject({ stage: "CREATE", tierBRowMayExist: false, message: "disk full" });
    const recorded = record.mock.calls.map(([event]) => event);
    expect(recorded).not.toContain("coordinator.tier_b_write_failed");
    expect(recorded).not.toContain("coordinator.snapshot_unpinned");
  });

  test("with a logger: every other coordinator event still reaches the record exactly as before", async () => {
    const logger = { warn: jest.fn() };
    const { record } = await composeAndRun({ logger, tierBCreateFails: false, unpinned: false });
    // No evidence was lost this round, so nothing is raised …
    expect(logger.warn).not.toHaveBeenCalled();
    // … and other events — including other coordinator failures — are forwarded to the record
    // untouched, never raised: the composed `deps.record` is the wrapper the round emits through.
    // (A clean round emits no coordinator event at all, so forwarding is exercised directly.)
    expect(record.mock.calls.map(([event]) => event)).not.toContain("coordinator.tier_b_write_failed");
    const forwarded = [];
    const second = await composeAndRun({ logger, tierBCreateFails: false, unpinned: false });
    second.record.mockImplementation((event) => forwarded.push(event));
    second.started.deps.record("coordinator.config_evidence", { state: "INCOMPLETE" });
    second.started.deps.record("coordinator.prepare_failed", { message: "x" });
    expect(forwarded).toEqual(["coordinator.config_evidence", "coordinator.prepare_failed"]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test("with no logger: the context is handed to the assembly unchanged and every event reaches the record", async () => {
    const { record, context, seenContext, started } = await composeAndRun({ logger: null, tierBCreateFails: true, unpinned: true });
    expect(seenContext).toBe(context); // the very same object, as before D6
    expect(started.settings.record).toBe(context.record);
    const recorded = record.mock.calls.map(([event]) => event);
    expect(recorded).toEqual(expect.arrayContaining(["coordinator.tier_b_write_failed", "coordinator.snapshot_unpinned"]));
  });
});
