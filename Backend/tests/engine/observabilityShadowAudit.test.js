"use strict";

/**
 * Engine lane — Phase 11: shadow mode (§21.6) and the hash-chained audit stream (§21.7).
 *
 * The single most important property of a shadow run is that it cannot move a robot, and
 * "never executed" is tested here as a structural refusal rather than as a convention.
 *
 * The audit stream is tested against both attacks a tamper-evidence scheme has to
 * survive: an **edit**, which a broken link catches, and a **removal**, which only a
 * dense sequence catches. A scheme that stops one of the two will be defeated by the
 * other.
 */

const fs = require("fs");
const path = require("path");

const shadow = require("../../src/engine/observability/shadow");
const auditStream = require("../../src/engine/observability/auditStream");
const decisionRecord = require("../../src/engine/observability/decisionRecord");
const fixture = require("./helpers/roundFixture");

const BACKEND_ROOT = path.join(__dirname, "..", "..");

describe("§21.6 — a shadow run cannot reach the world", () => {
  test.each(shadow.FORBIDDEN_DEPENDENCIES.map((name) => [name]))("a run handed %s is refused before it plans", (name) => {
    expect(() => shadow.assertNoEffects({ [name]: () => {} })).toThrow(shadow.ShadowSideEffectError);
    expect(() => shadow.assertNoEffects({ [name]: () => {} })).toThrow(/production run with a different label/);
  });

  test("a clean dependency bundle is accepted", () => {
    expect(shadow.assertNoEffects({ expandCandidates: () => {}, pricedCandidateFor: () => {} })).toEqual({ ok: true });
  });

  test("the run calls round.plan(), never round.execute()", async () => {
    const calls = [];
    const round = {
      async plan() {
        calls.push("plan");
        return { roundId: "r1", decisions: [], regime: "SINGLETON" };
      },
      async execute() {
        calls.push("execute");
        throw new Error("a shadow run must never cross into L3");
      },
    };

    const result = await shadow.run(
      { round, expandCandidates: async () => ({ candidates: [] }), pricedCandidateFor: () => null },
      { production: { roundId: "r1", shardId: "s1", decisionTimeMs: 1000 }, snapshot: { hash: "h1" }, label: "cand-1", legs: [] },
    );

    // §3.1 makes plan() "deterministic, side-effect-free, replayable"; execute() is the
    // only function in that module that crosses into L3. The shadow path does not
    // contain the crossing at all.
    expect(calls).toEqual(["plan"]);
    expect(result.executed).toBe(false);
  });

  test("the run uses the production round's decision time, not a fresh clock", async () => {
    let seen = null;
    const round = {
      async plan(deps, input) {
        seen = input.decisionTimeMs;
        return { decisions: [] };
      },
    };
    await shadow.run(
      { round, expandCandidates: async () => ({}), pricedCandidateFor: () => null },
      { production: { roundId: "r1", shardId: "s1", decisionTimeMs: 1234 }, snapshot: { hash: "h" }, label: "c", legs: [] },
    );
    // A shadow run at a different instant is not a comparison of two candidates; it is a
    // comparison of two moments.
    expect(seen).toBe(1234);
  });
});

describe("§21.6 — the agreement report", () => {
  const production = {
    roundId: "r1",
    regime: "SINGLETON",
    decisions: [
      { legId: "L1", outcome: "ASSIGNED", agentId: "A1" },
      { legId: "L2", outcome: "ASSIGNED", agentId: "A2" },
      { legId: "L3", outcome: "NO_FEASIBLE_CANDIDATE" },
    ],
  };

  test("agreement, and the two kinds of difference kept apart", () => {
    const report = shadow.compare({
      production,
      productionSnapshotHash: "h1",
      shadow: {
        label: "cand-1",
        snapshotHash: "h1",
        result: {
          regime: "SINGLETON",
          decisions: [
            { legId: "L1", outcome: "ASSIGNED", agentId: "A1" },
            { legId: "L2", outcome: "ASSIGNED", agentId: "A9" },
            { legId: "L3", outcome: "ASSIGNED", agentId: "A5" },
          ],
        },
      },
    });

    expect(report.ok).toBe(true);
    expect(report.agreed).toBe(1);
    expect(report.agreementRate).toBeCloseTo(1 / 3);
    // An outcome flip and an agent swap are different findings: the first says the
    // candidate changed *whether* work is done, the second only *by whom*.
    expect(report.differences.map((row) => [row.legId, row.kind])).toEqual([
      ["L2", "AGENT"],
      ["L3", "OUTCOME"],
    ]);
  });

  test("a pair with different pinned snapshots is refused, not scored", () => {
    const report = shadow.compare({
      production,
      productionSnapshotHash: "h1",
      shadow: { snapshotHash: "h2", result: { decisions: [] } },
    });
    // Any difference would be attributable to input drift rather than to the candidate,
    // which is precisely the comparison the mode exists to make (§9.6 requirement 5).
    expect(report.ok).toBe(false);
    expect(report.reason).toMatch(/input drift/);
  });

  test("the objective delta is reported in integer milli-CU, never as a percentage", () => {
    const report = shadow.compare({
      production: { ...production, budgets: { incumbent: { objectiveMilliCU: 100000n } } },
      productionSnapshotHash: "h1",
      shadow: { snapshotHash: "h1", result: { decisions: production.decisions, budgets: { incumbent: { objectiveMilliCU: 90000n } } } },
    });
    expect(report.objectiveDeltaMilliCU).toBe("-10000");
    expect(report.objectiveDeltaFavoursCandidate).toBe(true);
  });

  test("the report refuses to call an agreement rate a verdict", () => {
    const report = shadow.compare({ production, productionSnapshotHash: "h", shadow: { snapshotHash: "h", result: { decisions: production.decisions } } });
    expect(report.note).toMatch(/an agreement rate is a description, not a verdict/i);
  });
});

describe("§21.6 — shadow records are invisible to every production read", () => {
  test("no Phase 11 module queries decisionRecordA without the production filter", () => {
    // The one place the filter lives, so "shadow decisions never enter an SLI, an
    // explanation, or a replay corpus" is one thing to check rather than one per site.
    const files = [
      "src/engine/observability/metrics.js",
      "src/controllers/explain.controller.js",
      "tools/replay/replayDecision.js",
    ];

    // The named filter must itself be built from the shared constant, or the recognition
    // above would accept a filter that had quietly stopped excluding shadow rows.
    const metricsSource = fs.readFileSync(path.join(BACKEND_ROOT, "src/engine/observability/metrics.js"), "utf8");
    expect(metricsSource).toMatch(/const decisionFilter = \{ \.\.\.shardFilter, \.\.\.decisionRecord\.PRODUCTION_ONLY \}/);

    for (const file of files) {
      const source = fs.readFileSync(path.join(BACKEND_ROOT, file), "utf8");
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      const queries = [...code.matchAll(/decisionRecordA\.(findFirst|findMany|findUnique|count|groupBy)\(([\s\S]*?)\n\s{0,6}\}\)/g)];
      for (const [statement] of queries) {
        const guarded =
          statement.includes("PRODUCTION_ONLY") ||
          // The named filter `metrics.js` builds once from `PRODUCTION_ONLY` and spreads
          // into every decision-record query.
          statement.includes("decisionFilter") ||
          statement.includes("shadowLabel") ||
          // `findUnique` on the unique decision id is followed by an explicit shadow
          // check in `replayDecision`, which the next assertion pins.
          statement.includes("decisionId: String(decisionId)");
        expect({ file, statement: statement.slice(0, 80), guarded }).toEqual({ file, statement: statement.slice(0, 80), guarded: true });
      }
    }
  });

  test("replayDecision refuses a shadow record outright", async () => {
    const replay = require("../../tools/replay/replayDecision");
    const prisma = fixture.memoryPrisma();
    prisma.__tables.decisionRecords.push({ decisionId: "shadow:c1:r1:L1", shadowLabel: "c1", shardId: "s1" });

    const result = await replay.replayDecision({ prisma }, "shadow:c1:r1:L1");
    expect(result).toMatchObject({ ok: false, reason: "SHADOW_RECORD", shadowLabel: "c1" });
  });

  test("the two markers are independent — the id and the column", () => {
    expect(decisionRecord.shadowDecisionIdFor("cand-1", "r1", "L1")).toBe("shadow:cand-1:r1:L1");
    expect(decisionRecord.PRODUCTION_ONLY).toEqual({ shadowLabel: null });
  });
});

describe("§21.7 — the hash-chained audit stream", () => {
  const event = (overrides) => ({
    streamId: "shard-a",
    eventType: auditStream.EVENT_TYPE.OVERRIDE,
    actorId: "ops-7",
    actorRole: "SUPER_ADMIN",
    subjectType: "DECISION",
    subjectId: "shard-a:1:L1",
    reason: "customer escalation",
    recordedAtMs: 1000,
    ...(overrides || {}),
  });

  test("the first link has no predecessor and starts at sequence zero", () => {
    const first = auditStream.link({ ...event(), previous: null });
    expect(String(first.sequence)).toBe("0");
    expect(first.previousHash).toBeNull();
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("each link covers its predecessor's hash", () => {
    const first = auditStream.link({ ...event(), previous: null });
    const second = auditStream.link({ ...event({ recordedAtMs: 2000 }), previous: first });
    expect(second.previousHash).toBe(first.hash);
    expect(String(second.sequence)).toBe("1");
  });

  test("an unrecognised event type is refused", () => {
    // An append-only stream that accepts an unrecognised type accepts an event nobody
    // defined the meaning of, which is the one thing a non-repudiation record may not do.
    expect(() => auditStream.link({ ...event({ eventType: "SOMETHING_ELSE" }), previous: null })).toThrow(/not one of the audit stream's event types/);
  });

  test("verify() accepts an intact chain", async () => {
    const prisma = fixture.memoryPrisma();
    for (let index = 0; index < 5; index += 1) {
      // eslint-disable-next-line no-await-in-loop
      await auditStream.append({ prisma }, event({ recordedAtMs: 1000 + index }));
    }
    const verdict = await auditStream.verifyStream({ prisma }, "shard-a");
    expect(verdict).toMatchObject({ ok: true, checked: 5, brokenLinks: [], gaps: [] });
  });

  test("an EDIT breaks the chain — caught by the hash", async () => {
    const prisma = fixture.memoryPrisma();
    for (let index = 0; index < 4; index += 1) {
      // eslint-disable-next-line no-await-in-loop
      await auditStream.append({ prisma }, event({ recordedAtMs: 1000 + index }));
    }
    // The party best placed to remove the record of their own override is the operator.
    prisma.__tables.auditEvents[1].reason = "routine maintenance";

    const verdict = await auditStream.verifyStream({ prisma }, "shard-a");
    expect(verdict.ok).toBe(false);
    expect(verdict.brokenLinks.length).toBeGreaterThan(0);
    expect(verdict.brokenLinks.some((row) => /altered in place/.test(row.why))).toBe(true);
  });

  test("a REMOVAL breaks the chain — caught by the dense sequence, which the hash alone would not", async () => {
    const prisma = fixture.memoryPrisma();
    for (let index = 0; index < 4; index += 1) {
      // eslint-disable-next-line no-await-in-loop
      await auditStream.append({ prisma }, event({ recordedAtMs: 1000 + index }));
    }
    prisma.__tables.auditEvents.splice(1, 1);

    const verdict = await auditStream.verifyStream({ prisma }, "shard-a");
    expect(verdict.ok).toBe(false);
    expect(verdict.gaps).toEqual([{ expected: "1", found: "2" }]);
  });

  test("truncating the tail is caught too", async () => {
    const prisma = fixture.memoryPrisma();
    for (let index = 0; index < 4; index += 1) {
      // eslint-disable-next-line no-await-in-loop
      await auditStream.append({ prisma }, event({ recordedAtMs: 1000 + index }));
    }
    const full = await auditStream.verifyStream({ prisma }, "shard-a");
    prisma.__tables.auditEvents.pop();
    const truncated = await auditStream.verifyStream({ prisma }, "shard-a");

    // The chain still verifies as a chain — deleting the tail leaves every remaining
    // link intact — so the detection is that the last sequence moved backwards, which is
    // what the persisted high-water discipline is for.
    expect(truncated.ok).toBe(true);
    expect(Number(truncated.lastSequence)).toBeLessThan(Number(full.lastSequence));
  });

  test("a concurrent append collides on (streamId, sequence) and is surfaced, never swallowed", async () => {
    const prisma = fixture.memoryPrisma();
    const first = await auditStream.append({ prisma }, event());
    expect(first.ok).toBe(true);

    // Two writers both read the tail at sequence 0 and both build sequence 1. The first
    // lands; the unique index on `(streamId, sequence)` refuses the second. That is the
    // correct outcome — a chain has one tail — and it is a constraint rather than a lock.
    const writerA = auditStream.link({ ...event({ recordedAtMs: 2000 }), previous: first.event });
    const writerB = auditStream.link({ ...event({ recordedAtMs: 3000 }), previous: first.event });
    prisma.__tables.auditEvents.push({ ...writerA, id: "a" });

    // The loser retries by re-reading the tail, which is exactly what `append` does.
    expect(String(writerB.sequence)).toBe(String(writerA.sequence));
    const retried = await auditStream.append({ prisma }, event({ recordedAtMs: 3000 }));
    expect(retried.ok).toBe(true);
    expect(String(retried.event.sequence)).toBe("2");

    // And a direct write of the taken sequence is surfaced, never swallowed: a silently
    // dropped audit event is the failure this module exists to prevent.
    await expect(prisma.auditEvent.create({ data: { ...writerB, id: "b" } })).rejects.toMatchObject({ code: "P2002" });
  });

  test("Tier B shedding lands on the stream — a loss of evidence recorded where it cannot be lost", () => {
    expect(auditStream.EVENT_TYPES).toContain(auditStream.EVENT_TYPE.TIER_B_SHEDDING);
    expect(auditStream.EVENT_TYPES).toContain(auditStream.EVENT_TYPE.OVERRIDE);
    expect(auditStream.EVENT_TYPES).toContain(auditStream.EVENT_TYPE.CONFIG_CHANGE);
    expect(auditStream.EVENT_TYPES).toContain(auditStream.EVENT_TYPE.CANCELLATION);
  });
});

describe("workers/tierB.worker — the reservoir flush and the counted shedding", () => {
  const worker = require("../../src/workers/tierB.worker");
  const sampling = require("../../src/engine/observability/sampling");

  test("drains a reservoir into DecisionRecordB and records the shedding on the audit stream", async () => {
    const prisma = fixture.memoryPrisma();
    const budget = sampling.createBudget({ writeBudgetPerMinute: 0, reservoirSize: 2 });

    for (let index = 0; index < 10; index += 1) {
      const decisionId = `shard-a:1:L${index}`;
      prisma.__tables.decisionRecords.push({ decisionId, shardId: "shard-a", tierBWritten: false, tierBReason: null });
      budget.offer({
        shardId: "shard-a",
        decisionId,
        nowMs: 0,
        sampleRate: 0,
        exempt: true,
        exemptionReasons: ["DEGRADED"],
        payload: { decisionId, roundId: "shard-a:1", shardId: "shard-a", decisionTimeMs: 0, candidates: [] },
      });
    }

    const registry = require("../../src/engine/observability/sli").createRegistry();
    const result = await worker.flushOnce({ prisma, budget, registry, now: () => 60000 }, {});

    expect(result.flushed[0].reservoirWritten).toBe(2);
    expect(prisma.__tables.tierBRecords.every((row) => row.writtenBecause === "RESERVOIR")).toBe(true);
    // The Tier A rows now advertise the Tier B that exists.
    expect(prisma.__tables.decisionRecords.filter((row) => row.tierBWritten)).toHaveLength(2);
    // "The shedding is itself recorded as a counted event."
    const shedding = prisma.__tables.auditEvents.filter((row) => row.eventType === "TIER_B_SHEDDING");
    expect(shedding).toHaveLength(1);
    expect(shedding[0].payload.shed).toBeGreaterThan(0);
    expect(registry.snapshot().counters['sli.tier_b_shedding_count|{"shardId":"shard-a"}']).toBeGreaterThan(0);
  });

  test("expiring Tier B never touches the input snapshot that makes it reconstructible", async () => {
    const prisma = fixture.memoryPrisma();
    prisma.__tables.snapshots.push({ id: "s1", snapshotId: "shard-a:1", retainUntil: new Date(999999) });
    prisma.__tables.decisionRecords.push({ decisionId: "d1", tierBWritten: true, tierBReason: "SAMPLED" });
    prisma.__tables.tierBRecords.push({ id: "b1", decisionId: "d1", retainUntil: new Date(1000) });

    const result = await worker.expireTierB({ prisma }, { nowMs: 5000 });

    expect(result.expired).toBe(1);
    expect(prisma.__tables.tierBRecords).toHaveLength(0);
    // §21.2: "discarded; reconstructible by replay **while the input snapshots survive**".
    expect(prisma.__tables.snapshots).toHaveLength(1);
    // The row keeps why a Tier B was written and loses the claim that one still exists.
    expect(prisma.__tables.decisionRecords[0]).toMatchObject({ tierBWritten: false, tierBReason: "SAMPLED" });
  });
});
