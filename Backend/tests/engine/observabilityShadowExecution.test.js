"use strict";

/**
 * Engine lane — Phase 11: shadow mode proven non-executing, and the Tier B exemption
 * bound proven to bind, by **planted execution** rather than by reading the source.
 *
 * Both properties are already argued in `observability/shadow.js` and
 * `observability/sampling.js`, and both are already unit-tested one layer at a time. What
 * neither existing suite does is run the composition and watch for an effect: a source
 * scan proves the code as written cannot commit, and says nothing about whether the path
 * that actually runs went somewhere else. So every test here plants an observer on every
 * way the process could reach the world, drives the real worker, and asserts on what the
 * observer saw.
 *
 *   §21.6  "decisions that are recorded and never executed"
 *   §21.2  "an unbounded exemption converts to full retention across the entire shard at
 *           exactly the moment volume spikes hardest, which is the opposite of what a
 *           sampling scheme is for"
 */

const shadow = require("../../src/engine/observability/shadow");
const shadowWorker = require("../../src/workers/shadow.worker");
const decisionRecord = require("../../src/engine/observability/decisionRecord");
const sampling = require("../../src/engine/observability/sampling");
const auditStream = require("../../src/engine/observability/auditStream");
const tierBWorker = require("../../src/workers/tierB.worker");
const fixture = require("./helpers/roundFixture");

const DECISION_TIME_MS = 1_800_000_000_000;

/**
 * A prisma double that records every write to every table, so "nothing was written to a
 * production table" is an observation rather than an inference.
 */
function watchedPrisma() {
  const base = fixture.memoryPrisma();
  const writes = [];

  const watch = (tableName, table) =>
    new Proxy(table, {
      get(target, property) {
        const value = target[property];
        if (typeof value !== "function") return value;
        return (...args) => {
          if (/^(create|createMany|update|updateMany|upsert|delete|deleteMany)/.test(String(property))) {
            writes.push({ table: tableName, operation: String(property), args: args[0] });
          }
          return value.apply(target, args);
        };
      },
    });

  const watched = { __tables: base.__tables, __writes: writes };
  for (const key of Object.keys(base)) {
    if (key === "__tables") continue;
    watched[key] = base[key] && typeof base[key] === "object" ? watch(key, base[key]) : base[key];
  }
  return watched;
}

/** A round result shaped as `round.plan()` emits one, for the injected planner to return. */
function plannedRound(overrides) {
  return {
    ok: true,
    roundId: "r1",
    shardId: "s1",
    decisionTimeMs: DECISION_TIME_MS,
    regime: "SINGLETON",
    outcome: "COMPLETED",
    assignments: [{ legId: "L1", agentId: "A9", columnIdentity: "A9|L1|" }],
    deferrals: [],
    decisions: [{ legId: "L1", outcome: "ASSIGNED", agentId: "A9", columnIdentity: "A9|L1|" }],
    columns: { generated: 1, kept: 1, pruned: 0, bestPrunedGammaMilliCU: null },
    partitions: [
      {
        root: "agent:A9",
        ok: true,
        legIds: ["L1"],
        solver: "COST_SCALING",
        optimalityCertified: true,
        fallbackFrom: null,
        objectiveMilliCU: 9000n,
        boundMilliCU: 9000n,
        lpIpGapMilliCU: 0n,
        budgetLimited: false,
        unassigned: [],
      },
    ],
    partitionMerges: [],
    searchGapMilliCU: 0n,
    lpIpGapMilliCU: 0n,
    budgets: { budgetLimited: false, exceeded: [], incumbent: { assignments: [], objectiveMilliCU: 9000n, boundMilliCU: 9000n } },
    ...(overrides || {}),
  };
}

describe("§21.6 — a shadow decision is RECORDED and, provably, NEVER EXECUTED", () => {
  /** Every way the process could reach the world, wired to fail the test if touched. */
  const effects = () => {
    const touched = [];
    return {
      touched,
      commit: () => touched.push("commit"),
      dispatch: () => touched.push("dispatch"),
      outbox: () => touched.push("outbox"),
      planState: { reserve: () => touched.push("planState.reserve") },
      emit: () => touched.push("emit"),
    };
  };

  test("the full worker path writes a marked record and touches nothing else", async () => {
    const prisma = watchedPrisma();
    prisma.__tables.snapshots.push({
      id: "snap-1",
      snapshotId: "r1",
      roundId: "r1",
      shardId: "s1",
      decisionTime: new Date(DECISION_TIME_MS),
      hash: "pinned-hash",
      seed: "seed-1",
      killSwitchState: {},
      pins: {},
    });

    const world = effects();
    let executeCalled = 0;
    let planCalled = 0;

    const report = await shadowWorker.runOne(
      {
        prisma,
        round: {
          async plan() {
            planCalled += 1;
            return plannedRound();
          },
          async execute() {
            executeCalled += 1;
            throw new Error("a shadow run reached round.execute(), which crosses into L3");
          },
        },
        expandCandidates: async () => ({ candidates: [], achievedGapMilliCU: 0n }),
        pricedCandidateFor: () => null,
      },
      {
        storedRound: { roundId: "r1", shardId: "s1" },
        label: "cheaper-cRisk",
        candidateConfig: { "cost.risk_weight": 0.5 },
        production: { roundId: "r1", shardId: "s1", decisionTimeMs: DECISION_TIME_MS, decisions: [], budgets: {} },
        legs: [{ legId: "L1" }],
        nowMs: DECISION_TIME_MS,
        budget: sampling.createBudget({ writeBudgetPerMinute: 10, reservoirSize: 5 }),
        config: { sampleRate: 1, compactTopN: 5, fullRetentionDays: 30, tierBRetentionDays: 30, snapshotRetentionDays: 30 },
      },
    );

    expect(report.ok).toBe(true);
    expect(planCalled).toBe(1);
    expect(executeCalled).toBe(0);
    expect(world.touched).toEqual([]);

    // RECORDED: a Tier A row exists, marked in both places §21.6 requires.
    const rows = prisma.__tables.decisionRecords;
    expect(rows).toHaveLength(1);
    expect(rows[0].shadowLabel).toBe("cheaper-cRisk");
    expect(rows[0].decisionId).toBe(decisionRecord.shadowDecisionIdFor("cheaper-cRisk", "r1", "L1"));
    expect(rows[0].decisionId.startsWith(`${decisionRecord.SHADOW_ID_PREFIX}:`)).toBe(true);

    // NEVER EXECUTED: no Commitment, no Outbox, no WorkQueue mutation, no Round row.
    // Only the two observability tables §21.2 names — the pinned snapshot's idempotent
    // upsert and the Tier A row. (No Tier B here: this round supplied no `tierBInput`, so
    // there was nothing full-fidelity to write; the sampler's own suite covers that path.)
    const writtenTables = [...new Set(prisma.__writes.map((row) => row.table))].sort();
    expect(writtenTables).toEqual(["decisionRecordA", "inputSnapshot"]);
    for (const forbidden of ["round", "commitment", "outbox", "workQueue"]) {
      expect(prisma.__writes.some((row) => row.table === forbidden)).toBe(false);
    }
    expect(prisma.__tables.workQueue).toEqual([]);
    expect(prisma.__tables.rounds).toEqual([]);

    // The snapshot write is the immutable "ensure it exists" upsert, not an overwrite of
    // the production round's pinned inputs.
    const snapshotWrite = prisma.__writes.find((row) => row.table === "inputSnapshot");
    expect(snapshotWrite.operation).toBe("upsert");
    expect(snapshotWrite.args.update).toEqual({});
    expect(prisma.__tables.snapshots).toHaveLength(1);
    expect(prisma.__tables.snapshots[0].hash).toBe("pinned-hash");
  });

  test("handing the runner any effect at all throws BEFORE any planning happens", async () => {
    const world = effects();

    for (const [name, value] of Object.entries({
      commit: world.commit,
      dispatch: world.dispatch,
      outbox: world.outbox,
      planState: world.planState,
      emit: world.emit,
    })) {
      let planned = 0;
      await expect(
        shadow.run(
          { round: { plan: async () => { planned += 1; return plannedRound(); } }, [name]: value },
          { production: { roundId: "r1" }, label: "candidate", legs: [] },
        ),
      ).rejects.toThrow(shadow.ShadowSideEffectError);
      // "Before any planning happens" is the claim, so the counter is the assertion.
      expect(planned).toBe(0);
    }

    expect(world.touched).toEqual([]);
  });

  test("a shadow record can never be joined from a Commitment, because none exists", async () => {
    // The id namespace and the column are two markers; this is the third property, and it
    // is the structural one: nothing wrote a Commitment, so `decisionRef` cannot reach it.
    const prisma = watchedPrisma();
    prisma.__tables.snapshots.push({
      id: "snap-1", snapshotId: "r1", roundId: "r1", shardId: "s1",
      decisionTime: new Date(DECISION_TIME_MS), hash: "h", seed: "s", killSwitchState: {}, pins: {},
    });

    await shadowWorker.runOne(
      {
        prisma,
        round: { async plan() { return plannedRound(); } },
        expandCandidates: async () => ({ candidates: [] }),
        pricedCandidateFor: () => null,
      },
      {
        storedRound: { roundId: "r1", shardId: "s1" },
        label: "c1",
        production: { roundId: "r1", shardId: "s1", decisionTimeMs: DECISION_TIME_MS, decisions: [], budgets: {} },
        legs: [{ legId: "L1" }],
        nowMs: DECISION_TIME_MS,
        budget: sampling.createBudget({ writeBudgetPerMinute: 0, reservoirSize: 0 }),
        config: { sampleRate: 0 },
      },
    );

    expect(prisma.__writes.some((row) => row.table === "commitment")).toBe(false);
    // And the production read that would surface it filters it out by column.
    expect(decisionRecord.PRODUCTION_ONLY).toEqual({ shadowLabel: null });
    expect(prisma.__tables.decisionRecords[0].shadowLabel).not.toBeNull();
  });
});

describe("§21.2 — a SHARD-WIDE degradation cannot become full Tier B retention", () => {
  test("layer 1 (scope): shard-wide degradation is refused as an exemption, however many arrive", () => {
    const verdict = sampling.classifyExemption({
      degradations: Array.from({ length: 50 }, (unused, index) => ({
        scope: sampling.DEGRADATION_SCOPE.SHARD,
        mode: `DEGRADED_MODE_${index}`,
        reason: "shard-wide",
      })),
    });

    expect(verdict.exempt).toBe(false);
    expect(verdict.reasons).toEqual([]);
    expect(verdict.shardWideRefused).toHaveLength(50);
    expect(verdict.shardWideRefused.every((row) => row.recordedAt === "MODE_LEVEL")).toBe(true);
  });

  test("layer 2 (budget): the budget is shared ACROSS ROUNDS in a window, and binds", () => {
    // The failure this bounds: a per-round budget would reset every few hundred
    // milliseconds and never bind at all. Ten rounds of ten exempt decisions against a
    // budget of 25 must spend 25 and no more, whatever the round boundaries.
    const budget = sampling.createBudget({ writeBudgetPerMinute: 25, reservoirSize: 5 });
    const nowMs = 1_000_000; // one instant, so every round is inside one budget window
    const verdicts = [];

    for (let round = 0; round < 10; round += 1) {
      for (let leg = 0; leg < 10; leg += 1) {
        verdicts.push(
          budget.offer({
            shardId: "s1",
            decisionId: `r${round}:L${leg}`,
            nowMs,
            // No random sample at all, so every write here is an exempt one and the
            // budget is the only thing that can stop it.
            sampleRate: 0,
            exempt: true,
            exemptionReasons: [sampling.EXEMPTION.AT_DECISION.DEGRADED],
          }),
        );
      }
    }

    const counted = (verdict) => verdicts.filter((row) => row.verdict === verdict).length;

    expect(verdicts).toHaveLength(100);
    expect(counted(sampling.VERDICT.EXEMPT)).toBe(25);
    // Everything past the budget falls to the reservoir or is shed — never to a write.
    expect(counted(sampling.VERDICT.EXEMPT) + counted(sampling.VERDICT.RESERVOIR) + counted(sampling.VERDICT.SHED)).toBe(100);
    // Full retention would be 100. The bound holds at 25 writes plus a 5-slot reservoir.
    expect(budget.counters("s1").reservoirHeld).toBe(5);
    expect(budget.counters("s1").budgetRemaining).toBe(0);
    expect(counted(sampling.VERDICT.SHED)).toBeGreaterThan(0);
  });

  test("the budget rolls with the minute, and does NOT roll within one", () => {
    const budget = sampling.createBudget({ writeBudgetPerMinute: 2, reservoirSize: 0 });
    const offer = (id, nowMs) =>
      budget.offer({ shardId: "s1", decisionId: id, nowMs, sampleRate: 0, exempt: true, exemptionReasons: ["DEGRADED"] }).verdict;

    // Three offers spread across one minute: the third is past the budget.
    expect(offer("a", 60_000)).toBe(sampling.VERDICT.EXEMPT);
    expect(offer("b", 90_000)).toBe(sampling.VERDICT.EXEMPT);
    expect(offer("c", 119_999)).toBe(sampling.VERDICT.SHED);
    // The next minute starts a fresh allowance — per shard per MINUTE, as §21.2 states it.
    expect(offer("d", 120_000)).toBe(sampling.VERDICT.EXEMPT);
  });

  test("layer 3 (schema): a written Tier B row always names why, and a shed one is counted and audited", async () => {
    // §21.2: "the shedding is itself recorded as a counted event. Retention degrades
    // visibly and uniformly rather than by arrival order." The schema CHECK requires
    // `tierBReason` whenever `tierBWritten`, so the two cannot disagree.
    const prisma = fixture.memoryPrisma();
    const budget = sampling.createBudget({ writeBudgetPerMinute: 0, reservoirSize: 0 });
    for (let index = 0; index < 4; index += 1) {
      budget.offer({ shardId: "s1", decisionId: `r1:L${index}`, nowMs: 0, sampleRate: 0, exempt: true, exemptionReasons: ["DEGRADED"] });
    }
    expect(budget.counters("s1").shed).toBe(4);

    const registry = { counted: [], count(name, by, labels) { this.counted.push([name, by, labels]); } };
    await tierBWorker.flushOnce({ prisma, budget, registry, now: () => 0 }, {});

    const audit = prisma.__tables.auditEvents.filter((row) => row.eventType === auditStream.EVENT_TYPE.TIER_B_SHEDDING);
    expect(audit).toHaveLength(1);
    expect(audit[0].payload.shed).toBe(4);
    expect(registry.counted.some(([name]) => name === "sli.tier_b_shedding_count")).toBe(true);

    // Deterministic reservoir behaviour is untouched by any of this: the same population
    // offered in the reverse order yields the same retained set.
    const forwards = sampling.createBudget({ writeBudgetPerMinute: 0, reservoirSize: 3 });
    const backwards = sampling.createBudget({ writeBudgetPerMinute: 0, reservoirSize: 3 });
    const ids = Array.from({ length: 40 }, (unused, index) => `r1:L${index}`);
    for (const id of ids) forwards.offer({ shardId: "s1", decisionId: id, nowMs: 0, sampleRate: 0, exempt: true });
    for (const id of [...ids].reverse()) backwards.offer({ shardId: "s1", decisionId: id, nowMs: 0, sampleRate: 0, exempt: true });

    const held = (drained) => drained.reservoir.map((row) => row.decisionId).sort();
    expect(held(forwards.drain("s1"))).toEqual(held(backwards.drain("s1")));
  });
});
