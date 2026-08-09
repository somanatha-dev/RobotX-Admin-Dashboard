"use strict";

/**
 * Engine lane — Phase 11: **the reconstruction-equivalence build gate** (§24.3), the
 * golden replay corpus, and the snapshot-retention audit.
 *
 * > For every decision in the golden corpus that has a Tier B record, reconstruction
 * > from Tier A alone MUST reproduce that Tier B content **byte for byte** (§21.2). This
 * > is the property the two-tier decision record rests on: if reconstruction can diverge,
 * > then sampling Tier B loses information and the explainability tenet (T8) is no longer
 * > satisfied for unsampled decisions. **It is a build gate rather than a monitored
 * > metric**, because a divergence discovered in production means every unsampled
 * > explanation already served was potentially wrong.
 *
 * A gate that cannot fail is not a gate, so this file plants divergences of each kind
 * and asserts the gate catches every one.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const replay = require("../../tools/replay/replayDecision");
const tierB = require("../../src/engine/observability/tierB");
const sampling = require("../../src/engine/observability/sampling");
const fixture = require("./helpers/roundFixture");

const BACKEND_ROOT = path.join(__dirname, "..", "..");
const CORPUS_DIR = path.join(BACKEND_ROOT, replay.DEFAULT_CORPUS);

describe("§24.3 — the golden replay corpus runs on every build", () => {
  test("the corpus exists and every entry carries a stored Tier B", () => {
    const corpus = replay.loadCorpus();
    expect(corpus.length).toBeGreaterThanOrEqual(3);
    for (const entry of corpus) {
      expect({ name: entry.name, hasTierB: Boolean(entry.tierB) }).toEqual({ name: entry.name, hasTierB: true });
      expect({ name: entry.name, hasInput: Boolean(entry.reconstructionInput) }).toEqual({ name: entry.name, hasInput: true });
    }
  });

  test("THE GATE: reconstruction from Tier A alone reproduces every stored Tier B, byte for byte", () => {
    const result = replay.runCorpus();
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.withTierB).toBe(result.checked);
  });

  test("the corpus covers a milli-CU value beyond float precision", () => {
    // A cost that round-tripped through a double would compare equal on a small corpus
    // and diverge on a realistic one. The corpus carries 2^53 + 1 explicitly so the
    // string-encoding discipline is exercised rather than assumed.
    const large = replay.loadCorpus().find((entry) => entry.name.startsWith("large-milli-cu"));
    expect(large).toBeDefined();
    expect(JSON.stringify(large.tierB)).toContain("9007199254740993");
    // The precision loss, stated against BigInt rather than against a numeric literal —
    // a literal `9007199254740993` in source is itself already rounded, which would make
    // the comparison pass for the wrong reason.
    expect(BigInt(Number("9007199254740993"))).not.toBe(BigInt("9007199254740993"));
    expect(BigInt(Number("9007199254740993"))).toBe(9007199254740992n);
  });
});

describe("§24.3 — the gate fails on a planted divergence, of each kind", () => {
  const corpusOf = (mutate) => {
    const entry = JSON.parse(JSON.stringify(replay.loadCorpus()[0]));
    mutate(entry);
    return [entry];
  };

  test("a changed cost is caught, with the section and the byte named", () => {
    const result = replay.runCorpus({ corpus: corpusOf((entry) => {
      entry.tierB.costs[0].totalMilliCU = "999999";
    }) });

    expect(result.ok).toBe(false);
    expect(result.failures[0].equivalence.differingSections).toEqual(["costs"]);
    expect(result.failures[0].equivalence.firstDifference.offset).toBeGreaterThan(0);
  });

  test("a changed predicate observation is caught", () => {
    const result = replay.runCorpus({ corpus: corpusOf((entry) => {
      entry.tierB.feasibility[0].predicates[0].observationAgeMs = 999;
    }) });
    expect(result.ok).toBe(false);
    expect(result.failures[0].equivalence.differingSections).toEqual(["feasibility"]);
  });

  test("a dropped candidate is caught", () => {
    const result = replay.runCorpus({ corpus: corpusOf((entry) => {
      entry.tierB.candidateSet.pop();
    }) });
    expect(result.ok).toBe(false);
    expect(result.failures[0].equivalence.differingSections).toContain("candidateSet");
  });

  test("a dropped PRUNED column is caught — the pruned ones are part of what was considered", () => {
    const result = replay.runCorpus({ corpus: corpusOf((entry) => {
      entry.tierB.columnDetail = entry.tierB.columnDetail.filter((row) => row.kept);
    }) });
    expect(result.ok).toBe(false);
    expect(result.failures[0].equivalence.differingSections).toEqual(["columnDetail"]);
  });

  test("a sampling draw that no longer reproduces is caught", () => {
    const result = replay.runCorpus({ corpus: corpusOf((entry) => {
      entry.tierA.samplingDraw = 0.123456;
    }) });
    // A replay that resampled would compare a different Tier B population than the
    // original run kept, and the byte comparison would then be measuring the wrong thing.
    expect(result.ok).toBe(false);
    expect(result.failures[0].reason).toBe("SAMPLING_NOT_REPRODUCIBLE");
  });

  // PHASE 14 — §23.7 runs the same gate a second time, over an erased corpus. The
  // divergence-planting tests for that run live in `privacyErasure.test.js` beside the
  // erasure implementation; what belongs here is that the *gate* has two runs and that
  // the clean one still passes in both.
  test("the same gate passes over an erased corpus (§23.7)", () => {
    const result = replay.runCorpus({ erased: true });
    expect(result.ok).toBe(true);
    expect(result.erased).toBe(true);
    expect(result.withTierB).toBe(result.checked);
  });

  test("the CLI exits non-zero on a divergence and zero on a clean corpus", () => {
    const scratch = fs.mkdtempSync(path.join(require("os").tmpdir(), "replay-gate-"));
    const entry = JSON.parse(JSON.stringify(replay.loadCorpus()[0]));
    entry.tierB.costs[0].totalMilliCU = "1";
    fs.writeFileSync(path.join(scratch, "tampered.json"), JSON.stringify(entry));

    const run = (dir) => {
      try {
        execFileSync(process.execPath, [path.join(BACKEND_ROOT, "tools", "replay", "replayDecision.js"), "--corpus", dir], {
          cwd: BACKEND_ROOT,
          encoding: "utf8",
        });
        return 0;
      } catch (error) {
        return error.status;
      }
    };

    expect(run(scratch)).toBe(1);
    expect(run(CORPUS_DIR)).toBe(0);

    fs.rmSync(scratch, { recursive: true, force: true });
  });
});

describe("§21.2 — reconstruction is a pure function of the round result", () => {
  test("the same round result reconstructs to the same bytes, twice", () => {
    const input = replay.reviveMilliCU(replay.loadCorpus()[0].reconstructionInput);
    expect(tierB.serialiseSections(replay.reconstructTierB(input))).toBe(tierB.serialiseSections(replay.reconstructTierB(input)));
  });

  test("the revival turns milli-CU strings back into bigints, losing no precision", () => {
    const revived = replay.reviveMilliCU({ gammaMilliCU: "9007199254740993", nested: [{ lowerBoundMilliCU: "12345" }], other: "not-a-cost" });
    expect(revived.gammaMilliCU).toBe(9007199254740993n);
    expect(revived.nested[0].lowerBoundMilliCU).toBe(12345n);
    expect(revived.other).toBe("not-a-cost");
  });
});

describe("§9.6 / §21.2 — replaying a stored decision from the durable record", () => {
  const round = {
    async plan() {
      return { roundId: "shard-a:1", shardId: "shard-a", decisionTimeMs: 1000, decisions: [{ legId: "L1", outcome: "ASSIGNED" }] };
    },
    async execute() {
      throw new Error("replay must never cross into L3");
    },
  };

  const seed = (prisma) => {
    prisma.__tables.snapshots.push({
      id: "snap-1",
      snapshotId: "shard-a:1",
      roundId: "shard-a:1",
      shardId: "shard-a",
      decisionTime: new Date(1000),
      hash: "h1",
      seed: "abcd",
      configVersion: "42",
      codeVersion: "code-1",
      killSwitchState: { deferral: false },
      pins: {},
      retainUntil: new Date(9_000_000),
    });
  };

  test("a replay consumes Tier A and its snapshot, and never commits", async () => {
    const prisma = fixture.memoryPrisma();
    seed(prisma);
    prisma.__tables.decisionRecords.push({
      decisionId: "shard-a:1:L1",
      roundId: "shard-a:1",
      shardId: "shard-a",
      decisionTime: new Date(1000),
      shadowLabel: null,
      samplingRate: 0.5,
      samplingDraw: sampling.draw("shard-a:1:L1"),
      inputSnapshot: null,
    });
    // The double's `findUnique` returns the row; the include is resolved by hand here,
    // matching what Prisma would give back.
    prisma.decisionRecordA.findUnique = async ({ where }) => {
      const row = prisma.__tables.decisionRecords.find((entry) => entry.decisionId === where.decisionId);
      return row ? { ...row, inputSnapshot: prisma.__tables.snapshots[0], tierB: null } : null;
    };

    const result = await replay.replayDecision(
      { prisma, round, expandCandidates: async () => ({ candidates: [] }), pricedCandidateFor: () => null },
      "shard-a:1:L1",
      { candidatesFor: () => [] },
    );

    expect(result.ok).toBe(true);
    expect(result.tierBPresent).toBe(false);
    // The sampling decision replays too, or the corpus's Tier B population is not the
    // one the original run produced.
    expect(result.samplingReproducible).toBe(true);
    expect(result.samplingDrawMatches).toBe(true);
  });

  test("a decision whose snapshot has expired is reported as unreplayable, and as a DEFECT", async () => {
    const prisma = fixture.memoryPrisma();
    prisma.decisionRecordA.findUnique = async () => ({ decisionId: "d1", shadowLabel: null, inputSnapshot: null, tierB: null });

    const result = await replay.replayDecision({ prisma, round }, "d1");
    expect(result).toMatchObject({ ok: false, reason: "SNAPSHOT_EXPIRED" });
    // §24.3: "a non-zero count is a defect, not a capacity signal".
    expect(result.detail).toMatch(/defect/);
  });

  test("a replay handed a commit function refuses before planning", async () => {
    await expect(
      replay.replayRound({ round, commit: async () => ({}), expandCandidates: async () => ({}), pricedCandidateFor: () => null }, { snapshot: {} }),
    ).rejects.toThrow(/re-dispatch it to a live fleet/);
  });

  test("continuous production replay samples with the SAME deterministic draw, so it is auditable", async () => {
    const prisma = fixture.memoryPrisma();
    const ids = Array.from({ length: 200 }, (unused, index) => `shard-a:1:L${index}`);
    prisma.decisionRecordA.findMany = async ({ where }) => {
      // Production decisions only — a shadow record must never enter the sample.
      expect(where.shadowLabel).toBeNull();
      return ids.map((decisionId) => ({ decisionId }));
    };
    prisma.decisionRecordA.findUnique = async () => null;

    const result = await replay.replaySample({ prisma, round }, { shardId: "shard-a", rate: 0.1 });

    expect(result.considered).toBe(200);
    // The same draw the Tier B sampler uses: "which decisions get replayed" is itself
    // replayable, and an investigator can ask why a given decision was or was not checked.
    expect(result.sampled).toBe(ids.filter((id) => sampling.isSampled(id, 0.1)).length);
    expect(result.sampled).toBeGreaterThan(0);
    expect(result.sampled).toBeLessThan(200);

    const again = await replay.replaySample({ prisma, round }, { shardId: "shard-a", rate: 0.1 });
    expect(again.sampled).toBe(result.sampled);
  });

  test("a divergence found by continuous replay is marked release-blocking", async () => {
    const prisma = fixture.memoryPrisma();
    prisma.decisionRecordA.findMany = async () => [{ decisionId: "d1" }];
    prisma.decisionRecordA.findUnique = async () => ({
      decisionId: "d1",
      roundId: "shard-a:1",
      shardId: "shard-a",
      shadowLabel: null,
      decisionTime: new Date(1000),
      samplingRate: null,
      inputSnapshot: { roundId: "shard-a:1", decisionTime: new Date(1000), hash: "h", seed: "s", pins: {}, configVersion: "1", codeVersion: "c", killSwitchState: {} },
      // A stored Tier B that the reconstruction will not reproduce.
      tierB: tierB.toRow(tierB.build({ decisionId: "d1", decisionTimeMs: 1000, candidates: [{ agentId: "A9", rejected: false, gammaMilliCU: 1n, breakdown: { cDirect: 1n } }] }), { writtenBecause: "SAMPLED" }),
    });

    const result = await replay.replaySample({ prisma, round, expandCandidates: async () => ({}), pricedCandidateFor: () => null }, { rate: 1, options: { candidatesFor: () => [] } });

    expect(result.divergent).toBe(1);
    // §24.3: "Divergence indicates non-determinism … and is a release blocker."
    expect(result.releaseBlocking).toBe(true);
  });

  test("the snapshot-retention audit finds a Tier A record that has outlived its inputs", async () => {
    const prisma = fixture.memoryPrisma();
    prisma.decisionRecordA.findMany = async ({ where }) => {
      expect(where.shadowLabel).toBeNull();
      return [{ decisionId: "d1", decisionTime: new Date(0), inputSnapshotId: null }];
    };

    const audit = await replay.auditSnapshotRetention({ prisma }, { nowMs: 10_000_000 });
    expect(audit.ok).toBe(false);
    expect(audit.unreplayable).toBe(1);
    expect(audit.note).toMatch(/defect, not a capacity signal/);
  });
});
