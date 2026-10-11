"use strict";

/**
 * P7-D5 Step 1 — the decision-evidence pipeline is fed.
 *
 * Found (completion audit, 2026-10-10), and re-verified against the source before this change:
 *   · `coordinatorSolvePath.perLegFor` produced `{ candidates, rejectionSummary }` only, so
 *     `decisionRecord.writeRound` never had a `tierBInput` and never wrote Tier B;
 *   · `leaderWorkers` started the coordinator with no `observability`, so every decision was
 *     offered to the sampler with `sampleRate: undefined` (stored `samplingRate = null`);
 *   · and with no snapshot, so `runRound` recorded `{ snapshotId, pins: null, seed }` — an
 *     `InputSnapshot` with an empty hash, no versions and no resolved values;
 *   · nothing produced the `codeVersion` `captureSnapshot` requires.
 *
 * These tests pin the wiring, the fail-safe paths, and that evidence collection changes no
 * decision: the TSK-816 replay below reaches the same winner and γ it always has.
 *
 * MOCKED BOUNDARY: the store (`roundFixture.memoryPrisma`, or `phase7World`'s in-memory
 * Prisma seeded from real LOCAL rows), and a stub `fs` for the digest's failure cases.
 */

const crypto = require("crypto");
const path = require("path");

const { resolveCodeVersion, sourceDigest, SOURCE } = require("../../src/config/codeVersion");
const coordinator = require("../../src/workers/coordinator.worker");
const coordinatorSolvePath = require("../../src/workers/coordinatorSolvePath");
const leaderWorkers = require("../../src/workers/leaderWorkers");
const configService = require("../../src/engine/config/service");
const snapshotModel = require("../../src/engine/determinism/snapshot");
const { canonicalJson } = require("../../src/engine/determinism/ordering");
const decisionRecord = require("../../src/engine/observability/decisionRecord");
const sampling = require("../../src/engine/observability/sampling");
const tierB = require("../../src/engine/observability/tierB");
const feasibilityRegister = require("../../src/engine/feasibility/register");
const planState = require("../../src/engine/shard/planState");
const intake = require("../../src/engine/intake/intake");
const leadership = require("../../src/engine/shard/leadership");
const { replayDecision } = require("../../tools/replay/replayDecision");
const fixture = require("./helpers/roundFixture");
const w = require("./helpers/phase7World");

jest.setTimeout(60_000);

const BACKEND = path.resolve(__dirname, "../..");
const CODE = "src-sha256:" + "a".repeat(64);

/** A published configuration, as `config/service.loadPinnedSnapshot` builds one. */
function publishedConfig(overrides, version) {
  return configService.buildSnapshot({
    version: version === undefined ? 7 : version,
    bindings: Object.entries(overrides || {}).map(([name, value]) => ({ level: "global", name, value })),
  });
}

/** Rebuild a captured body the way `tools/replay/replayDecision` rebuilds it from a row. */
function bodyFromRecordShape(roundId, decisionTimeMs, snapshot) {
  return { roundId, decisionTime: decisionTimeMs, hash: snapshot.hash, seed: snapshot.seed, resolvedValues: snapshot.resolvedValues, ...snapshot.pins };
}

/** What a PostgreSQL `Json` column returns for a value: its JSON text, parsed. */
const throughJson = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

/* ═══════════════════════════════════════════════════════════════════════════
   1. The code version
   ═══════════════════════════════════════════════════════════════════════════ */

/** An `fs` double over a flat map of relative POSIX path → contents. */
function memoryFs(files, root) {
  const dirents = (dir) => {
    const relative = path.relative(root, dir).split(path.sep).join("/");
    const prefix = relative === "" ? "" : `${relative}/`;
    const names = new Map();
    for (const file of Object.keys(files)) {
      if (!file.startsWith(prefix)) continue;
      const rest = file.slice(prefix.length);
      const [head, ...tail] = rest.split("/");
      names.set(head, tail.length > 0);
    }
    return [...names.entries()].reverse().map(([name, isDir]) => ({ name, isDirectory: () => isDir, isFile: () => !isDir }));
  };
  return {
    readdirSync: (dir) => dirents(dir),
    existsSync: (full) => Object.prototype.hasOwnProperty.call(files, path.relative(root, full).split(path.sep).join("/")),
    readFileSync: (full) => Buffer.from(files[path.relative(root, full).split(path.sep).join("/")]),
  };
}

describe("P7-D5 — the code version pinned into every round snapshot", () => {
  const ROOT = path.resolve("/virtual/backend");
  const FILES = { "server.js": "boot()", "src/a.js": "a", "src/engine/b.js": "b", "src/readme.md": "not code" };

  test("the platform's commit wins, lower-cased and labelled", () => {
    const out = resolveCodeVersion({ env: { RENDER_GIT_COMMIT: "ABCDEF1234567" }, root: ROOT, fs: memoryFs(FILES, ROOT) });
    expect(out).toEqual({ codeVersion: "git:abcdef1234567", source: SOURCE.PLATFORM_COMMIT, problems: [] });
  });

  test("a commit value that is not a hex id is ignored, said so, and the source digest is used", () => {
    const out = resolveCodeVersion({ env: { RENDER_GIT_COMMIT: "main; rm -rf" }, root: ROOT, fs: memoryFs(FILES, ROOT) });
    expect(out.source).toBe(SOURCE.SOURCE_DIGEST);
    expect(out.codeVersion).toMatch(/^src-sha256:[0-9a-f]{64}$/);
    expect(out.problems).toEqual(["RENDER_GIT_COMMIT is set but is not a hex commit id; it was ignored"]);
  });

  test("the digest covers server.js and src/**/*.js only, is order-independent, and changes with any byte, path or file", () => {
    const base = sourceDigest(ROOT, memoryFs(FILES, ROOT));
    expect(base).toMatchObject({ ok: true, files: 3 });
    // A non-.js file does not count.
    expect(sourceDigest(ROOT, memoryFs({ ...FILES, "src/readme.md": "edited" }, ROOT)).digest).toBe(base.digest);
    // One byte, a rename, an added file: each a different digest.
    expect(sourceDigest(ROOT, memoryFs({ ...FILES, "src/a.js": "A" }, ROOT)).digest).not.toBe(base.digest);
    const renamed = { ...FILES };
    delete renamed["src/a.js"];
    renamed["src/c.js"] = "a";
    expect(sourceDigest(ROOT, memoryFs(renamed, ROOT)).digest).not.toBe(base.digest);
    expect(sourceDigest(ROOT, memoryFs({ ...FILES, "src/d.js": "" }, ROOT)).digest).not.toBe(base.digest);
    // Two files cannot run together into one: "ab" + "" ≠ "a" + "b".
    expect(sourceDigest(ROOT, memoryFs({ "src/x.js": "ab", "src/y.js": "" }, ROOT)).digest).not.toBe(
      sourceDigest(ROOT, memoryFs({ "src/x.js": "a", "src/y.js": "b" }, ROOT)).digest,
    );
  });

  test("no source and no commit: null, never an invented identity", () => {
    const broken = { readdirSync: () => { throw new Error("EACCES"); }, existsSync: () => false, readFileSync: () => Buffer.alloc(0) };
    const out = resolveCodeVersion({ env: {}, root: ROOT, fs: broken });
    expect(out.codeVersion).toBeNull();
    expect(out.source).toBe(SOURCE.NONE);
    expect(out.problems[0]).toMatch(/EACCES/);
  });

  test("this repository's own backend resolves to a source digest", () => {
    const out = resolveCodeVersion({ env: {}, root: BACKEND });
    expect(out.source).toBe(SOURCE.SOURCE_DIGEST);
    expect(out.codeVersion).toMatch(/^src-sha256:[0-9a-f]{64}$/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   2. The round's pinned inputs
   ═══════════════════════════════════════════════════════════════════════════ */

describe("P7-D5 — pinRoundInputs: the snapshot and the sampling settings come from the config in force", () => {
  const ROUND = { roundId: "default:1790000000000", decisionTimeMs: 1790000000000, seed: snapshotModel.deriveSeed("default:1790000000000") };

  test("a published config and a code version: a content-addressed snapshot that verifies", () => {
    const config = publishedConfig({ "observability.tier_b_sample_rate": 0.25 });
    const out = coordinator.pinRoundInputs({ configSnapshot: () => config, codeVersion: CODE, killSwitches: { deferral: false } }, ROUND);

    expect(out.pinned).toBe(true);
    expect(out.problems).toEqual([]);
    expect(out.snapshot.snapshotId).toBe(ROUND.roundId);
    expect(out.snapshot.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(out.snapshot.seed).toBe(ROUND.seed);
    expect(out.snapshot.pins).toMatchObject({ configVersion: 7, codeVersion: CODE, killSwitchState: { deferral: false }, activeRegime: null });
    // Every resolved value the round's configuration holds, as a Json column will hold it.
    expect(out.snapshot.resolvedValues).toEqual(throughJson(Object.fromEntries(config.values)));
    expect(Object.keys(out.snapshot.resolvedValues)).toHaveLength(config.values.size);
    expect(out.snapshot.resolvedValues["observability.tier_b_sample_rate"]).toBe(0.25);

    // The hash verifies over exactly the stored shape — after the JSON round trip a row takes.
    const stored = throughJson(out.snapshot);
    expect(snapshotModel.isIntact(bodyFromRecordShape(ROUND.roundId, ROUND.decisionTimeMs, stored))).toBe(true);
    // …and fails for any change to a resolved value.
    const tampered = { ...stored, resolvedValues: { ...stored.resolvedValues, "observability.tier_b_sample_rate": 0.5 } };
    expect(snapshotModel.isIntact(bodyFromRecordShape(ROUND.roundId, ROUND.decisionTimeMs, tampered))).toBe(false);
  });

  test("the sampling settings are the register parameters of the same config, by name", () => {
    const out = coordinator.pinRoundInputs({ configSnapshot: () => publishedConfig({ "observability.tier_b_sample_rate": 0.25 }), codeVersion: CODE }, ROUND);
    expect(out.observability).toEqual({
      sampleRate: 0.25,
      compactTopN: 5,
      fullRetentionDays: 30,
      tierBRetentionDays: 30,
      snapshotRetentionDays: 30,
      writeBudgetPerMinute: 5000,
      reservoirSize: 100,
      // P7-D5 D4 — `perf.tier_a_record_bytes` (§20.1) is a register parameter after all, now mapped.
      tierARecordBytes: 2048,
    });
    expect(Object.values(coordinator.OBSERVABILITY_PARAMETERS).every((name) => feasibleName(name))).toBe(true);
  });

  test("an explicit snapshot or observability object is used exactly as given (existing callers unchanged)", () => {
    const explicit = { snapshotId: "x", hash: "h", seed: "s", pins: { configVersion: "1" } };
    const settings = { sampleRate: 1 };
    const out = coordinator.pinRoundInputs({ snapshot: explicit, observability: settings, configSnapshot: () => publishedConfig(), codeVersion: CODE }, ROUND);
    expect(out.snapshot).toBe(explicit);
    expect(out.observability).toBe(settings);
  });

  test("no configuration accessor at all: the snapshot is the one runRound always wrote", () => {
    const out = coordinator.pinRoundInputs({}, ROUND);
    expect(out).toEqual({
      snapshot: { snapshotId: ROUND.roundId, pins: null, seed: ROUND.seed },
      observability: Object.fromEntries(Object.keys(coordinator.OBSERVABILITY_PARAMETERS).map((key) => [key, undefined])),
      pinned: false,
      problems: [],
    });
  });

  test("no code version: what is known is recorded, the hash is NOT — the record cannot read as replayable", () => {
    const out = coordinator.pinRoundInputs({ configSnapshot: () => publishedConfig(), codeVersion: null }, ROUND);
    expect(out.pinned).toBe(false);
    expect(out.snapshot.hash).toBeUndefined();
    expect(out.snapshot.pins).toMatchObject({ configVersion: 7, codeVersion: null });
    expect(out.snapshot.resolvedValues).toBeTruthy();
    expect(out.problems[0]).toMatch(/codeVersion/);
  });

  test("an unpublished configuration (no version): not pinned, and said so", () => {
    const out = coordinator.pinRoundInputs({ configSnapshot: () => configService.defaultSnapshot(), codeVersion: CODE }, ROUND);
    expect(out.pinned).toBe(false);
    expect(out.snapshot.hash).toBeUndefined();
    expect(out.problems[0]).toMatch(/configVersion/);
  });

  test("an accessor that throws is a missing snapshot, not a crashed round", () => {
    const out = coordinator.pinRoundInputs({ configSnapshot: () => { throw new Error("boom"); }, codeVersion: CODE }, ROUND);
    expect(out.snapshot).toEqual({ snapshotId: ROUND.roundId, pins: null, seed: ROUND.seed });
    expect(out.problems).toEqual(["no configuration snapshot was readable at round start"]);
  });

  test("jsonSafe: what is hashed is what a Json column stores", () => {
    const value = { at: new Date("2026-10-10T00:00:00.000Z"), big: 12n, nan: NaN, inf: -Infinity, map: new Map([["k", 1]]), gone: undefined, fn: () => 1, list: [1, undefined, 2n] };
    const safe = coordinator.jsonSafe(value);
    expect(safe).toEqual({ at: "2026-10-10T00:00:00.000Z", big: "12", nan: "NaN", inf: "-Infinity", map: { k: 1 }, list: [1, null, "2"] });
    expect(canonicalJson(throughJson(safe))).toBe(canonicalJson(safe));
  });
});

/** Every observability register name the coordinator reads exists in the register. */
function feasibleName(name) {
  return configService.defaultSnapshot().entries.has(name);
}

/* ═══════════════════════════════════════════════════════════════════════════
   3. The composition hands the coordinator what it needs
   ═══════════════════════════════════════════════════════════════════════════ */

describe("P7-D5 — leaderWorkers composes the coordinator with the config accessor and the code version", () => {
  afterEach(() => jest.restoreAllMocks());

  function compose(context) {
    const config = publishedConfig();
    const enrichedSnapshot = jest.fn(() => config);
    jest.spyOn(coordinatorSolvePath, "create").mockReturnValue({
      ok: true,
      deps: {},
      context: { snapshot: enrichedSnapshot, expansionWallClockBudgetMs: 100 },
    });
    let settings = null;
    jest.spyOn(coordinator, "start").mockImplementation((deps, given) => {
      settings = given;
      return { stop() {} };
    });
    const outcome = leaderWorkers.COMPOSERS.coordinator({ values: config.values, shardId: "default", instanceId: "i-1", ...context });
    return { outcome, settings, config, enrichedSnapshot };
  }

  test("configSnapshot reads the solve path's own accessor, per call; codeVersion is passed through", () => {
    const { outcome, settings, config, enrichedSnapshot } = compose({ codeVersion: CODE });
    expect(outcome.ok).toBe(true);
    expect(settings.codeVersion).toBe(CODE);
    expect(typeof settings.configSnapshot).toBe("function");
    expect(settings.configSnapshot()).toBe(config);
    expect(settings.configSnapshot()).toBe(config);
    expect(enrichedSnapshot).toHaveBeenCalledTimes(2); // read per round, never frozen at promotion
    // Nothing that steers the round changed: the same config block, the same switches.
    expect(settings.killSwitches).toEqual({});
    expect(Object.keys(settings.config).sort()).toEqual(
      ["branchNodeBudget", "maxClockSkewMillis", "maxColumnsPerRound", "maxEvaluatedPerLeg", "maxLegsPerRound", "saturatedWindowMs", "storeRoundTripMillis", "timeBudgetMs", "windowMaxMs", "windowMinMs"],
    );
  });

  test("an absent or empty code version is null — the coordinator then records rounds unpinned", () => {
    expect(compose({}).settings.codeVersion).toBeNull();
    expect(compose({ codeVersion: "" }).settings.codeVersion).toBeNull();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   4. runRound → the decision record
   ═══════════════════════════════════════════════════════════════════════════ */

describe("P7-D5 — runRound writes the pinned snapshot, the sampling rate and Tier B", () => {
  const SHARD = leadership.DEFAULT_SHARD_ID;
  const NOW = new Date("2026-10-10T12:00:00.000Z");
  const CONFIG = { windowMinMs: 500, windowMaxMs: 3000, saturatedWindowMs: 10000, batchGrowthThreshold: 10, fastPathClasses: [], maxLegsPerRound: 500 };
  const LEG_ROW = "leg-row-1";

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

  const TIER_B_INPUT = {
    candidates: [
      {
        agentId: "AGT-1",
        discoveryTier: 1,
        availabilityClass: "IDLE_READY",
        lowerBoundMilliCU: 100n,
        rejected: false,
        bindingPredicateId: null,
        gammaMilliCU: 500n,
        breakdown: { gammaMilliCU: "500" },
        predicateResults: [{ predicateId: "F1", outcome: "SATISFIED", observed: null, required: null }],
      },
      {
        agentId: "AGT-2",
        rejected: true,
        bindingPredicateId: "F34",
        gammaMilliCU: null,
        predicateResults: [{ predicateId: "F34", outcome: "VIOLATED", observed: { tier: "T1" }, required: { alpha: 0.01 } }],
      },
    ],
    columns: [],
    pruned: [],
  };

  async function runWith({ sampleRate = 1, codeVersion = CODE, perLeg, deps: extraDeps = {}, source: extraSource = {}, prepare } = {}) {
    const prisma = store();
    if (typeof prepare === "function") prepare(prisma);
    await prisma.workQueue.create({
      data: {
        legId: LEG_ROW, shardId: SHARD, idempotencyKey: "k-1", purpose: "PRIMARY", slaClass: "standard",
        priority: 0, state: intake.QUEUE_STATE.QUEUED, enqueuedAt: new Date(NOW.getTime() - 1000),
      },
    });
    const config = publishedConfig({ "observability.tier_b_sample_rate": sampleRate });
    const record = jest.fn();
    const legContext = perLeg === undefined
      ? { [LEG_ROW]: { candidates: [{ agentId: "AGT-2", rejected: true, bindingPredicateId: "F34", gammaMilliCU: null }], rejectionSummary: [], tierBInput: TIER_B_INPUT } }
      : perLeg;
    const result = await coordinator.runRound(
      {
        prisma,
        planState: planState.create({ shardId: SHARD }),
        expandCandidates: async () => ({ candidates: [], achievedGapMilliCU: 0n, problems: [] }),
        pricedCandidateFor: () => null,
        commit: async () => ({ committed: false }),
        perLegFor: () => legContext,
        // The shard's budget, explicitly: `defaultRecordBudget` is a process singleton.
        recordBudget: sampling.createBudget({ writeBudgetPerMinute: 5000, reservoirSize: 100 }),
        record,
        ...extraDeps,
      },
      {
        shardId: SHARD, config: CONFIG, feasibleSupply: 3, nowMs: NOW.getTime(), instanceId: "instance-1", killSwitches: {},
        configSnapshot: () => config, codeVersion,
        ...extraSource,
      },
    );
    return { prisma, result, record, config };
  }

  test("InputSnapshot carries the hash, the config version, the code version and every resolved value", async () => {
    const { prisma, result, record, config } = await runWith();
    expect(result.ran).toBe(true);
    expect(record).not.toHaveBeenCalledWith("coordinator.snapshot_unpinned", expect.anything());

    const [snapshot] = prisma.__tables.snapshots;
    expect(snapshot.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshot.configVersion).toBe("7");
    expect(snapshot.codeVersion).toBe(CODE);
    expect(snapshot.resolvedValues).toEqual(throughJson(Object.fromEntries(config.values)));
    expect(snapshot.pins).toMatchObject({ configVersion: 7, codeVersion: CODE, killSwitchState: {} });

    // Tier A names the same versions and points at the same snapshot.
    const [tierARow] = prisma.__tables.decisionRecords;
    expect(tierARow.versions).toMatchObject({ configVersion: 7, codeVersion: CODE, activeRegime: null });
    expect(tierARow.inputSnapshotRefs).toMatchObject({ snapshotId: snapshot.snapshotId, hash: snapshot.hash, seed: snapshot.seed });
    expect(tierARow.samplingRate).toBe(1);
  });

  test("the stored snapshot replays as intact, through the real replay tool and a Json round trip", async () => {
    const { prisma } = await runWith();
    const [tierARow] = prisma.__tables.decisionRecords;
    const [snapshot] = prisma.__tables.snapshots;
    const [tierBRow] = prisma.__tables.tierBRecords;
    const asStored = {
      ...snapshot,
      pins: throughJson(snapshot.pins),
      resolvedValues: throughJson(snapshot.resolvedValues),
      killSwitchState: throughJson(snapshot.killSwitchState),
    };
    const replay = (snapshotRow) =>
      replayDecision(
        {
          prisma: { decisionRecordA: { findUnique: async () => ({ ...tierARow, inputSnapshot: snapshotRow, tierB: tierBRow || null }) } },
          round: { plan: async () => ({ roundId: tierARow.roundId, decisions: [] }) },
        },
        tierARow.decisionId,
      );

    expect((await replay(asStored)).snapshotIntact).toBe(true);
    expect((await replay({ ...asStored, resolvedValues: { ...asStored.resolvedValues, "candidate.max_evaluated": 1 } })).snapshotIntact).toBe(false);
  });

  test("Tier B is written from the composition's tierBInput, and Tier A says so only once it exists", async () => {
    const { prisma, result } = await runWith({ sampleRate: 1 });
    const [tierARow] = prisma.__tables.decisionRecords;
    const [tierBRow] = prisma.__tables.tierBRecords;
    expect(tierARow).toMatchObject({ tierBWritten: true, tierBReason: sampling.WRITTEN_BECAUSE.SAMPLED });
    expect(tierBRow.decisionId).toBe(tierARow.decisionId);
    expect(tierBRow.candidateSet.map((row) => row.agentId)).toEqual(["AGT-1", "AGT-2"]);
    expect(tierBRow.feasibility.find((row) => row.agentId === "AGT-2")).toMatchObject({ admitted: false, bindingPredicateId: "F34" });
    expect(tierBRow.costs).toEqual([{ agentId: "AGT-1", terms: { gammaMilliCU: "500" }, totalMilliCU: "500", unit: "milli-CU" }]);
    expect(result.recorded).toMatchObject({ tierACount: 1, tierBCount: 1, tierBFailures: [] });
    // The content hash is the digest of exactly what is stored.
    expect(tierB.equivalent(tierB.fromRow(throughJson(tierBRow)), tierB.build({ ...TIER_B_INPUT, decisionId: tierARow.decisionId })).ok).toBe(true);
  });

  test("sample rate 0: nothing sampled, the rate recorded as 0 (not null)", async () => {
    const { prisma } = await runWith({ sampleRate: 0 });
    expect(prisma.__tables.tierBRecords).toHaveLength(0);
    expect(prisma.__tables.decisionRecords[0]).toMatchObject({ tierBWritten: false, tierBReason: null, samplingRate: 0 });
  });

  test("a selected decision with no tierBInput writes no Tier B and does not claim one", async () => {
    const { prisma } = await runWith({ perLeg: { [LEG_ROW]: { candidates: [], rejectionSummary: [] } } });
    expect(prisma.__tables.tierBRecords).toHaveLength(0);
    expect(prisma.__tables.decisionRecords[0]).toMatchObject({ tierBWritten: false, tierBReason: null, samplingRate: 1 });
  });

  test("a failed Tier B write is reported, leaves Tier A honest, and the round still ran", async () => {
    const { prisma: used, result, record } = await runWith({
      prepare: (prisma) => {
        prisma.decisionRecordB.create = async () => {
          throw new Error("disk full");
        };
      },
    });

    expect(result.ran).toBe(true);
    expect(used.__tables.decisionRecords[0]).toMatchObject({ tierBWritten: false, tierBReason: null });
    // P7-D5 D6 — the entry also names the failed step and whether a Tier B row may be orphaned.
    expect(result.recorded.tierBFailures).toEqual([
      { decisionId: used.__tables.decisionRecords[0].decisionId, stage: "CREATE", tierBRowMayExist: false, message: "disk full" },
    ]);
    expect(record).toHaveBeenCalledWith("coordinator.tier_b_write_failed", expect.objectContaining({ failures: result.recorded.tierBFailures }));
    // The Leg's queue outcome is the round's, untouched by the evidence failure.
    expect(used.__tables.workQueue[0].state).toBe(intake.QUEUE_STATE.QUEUED);
  });

  test("no code version: the round runs, records configuration facts, writes no hash, and reports it", async () => {
    const { prisma, result, record } = await runWith({ codeVersion: null });
    expect(result.ran).toBe(true);
    expect(prisma.__tables.snapshots[0]).toMatchObject({ hash: "", configVersion: "7", codeVersion: null });
    expect(prisma.__tables.decisionRecords[0].inputSnapshotRefs.hash).toBeNull();
    expect(record).toHaveBeenCalledWith("coordinator.snapshot_unpinned", expect.objectContaining({ problems: [expect.stringMatching(/codeVersion/)] }));
  });

  test("a caller with no configuration accessor gets exactly the old record (empty hash, no versions)", async () => {
    const { prisma } = await runWith({ source: { configSnapshot: undefined, codeVersion: undefined } });
    expect(prisma.__tables.snapshots[0]).toMatchObject({ hash: "", configVersion: null, codeVersion: null, resolvedValues: null });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   5. Sampling at the configured rates — the writer, directly
   ═══════════════════════════════════════════════════════════════════════════ */

describe("P7-D5 — the sampler selects exactly what its configured rate selects", () => {
  const LEGS = Array.from({ length: 40 }, (_, index) => `LEG-${String(index).padStart(2, "0")}`);
  const round = {
    roundId: "default:1790000000000",
    shardId: "default",
    decisionTimeMs: 1790000000000,
    regime: "SINGLETON",
    columns: { generated: 0, kept: 0, pruned: 0, bestPrunedGammaMilliCU: null },
    budgets: { budgetLimited: false, exceeded: [] },
    lpIpGapMilliCU: 0n,
    committed: [],
    decisions: LEGS.map((legId) => ({ legId, outcome: "NO_FEASIBLE_CANDIDATE" })),
  };
  const perLeg = Object.fromEntries(LEGS.map((legId) => [legId, { candidates: [], tierBInput: { candidates: [], columns: [], pruned: [] } }]));

  async function writeAt(sampleRate) {
    const prisma = fixture.memoryPrisma();
    const result = await decisionRecord.writeRound(
      { prisma },
      {
        round,
        context: { shardId: "default", snapshot: { snapshotId: round.roundId, pins: null, seed: "00" }, perLeg },
        budget: sampling.createBudget({ writeBudgetPerMinute: 5000, reservoirSize: 100 }),
        config: { sampleRate, fullRetentionDays: 30, tierBRetentionDays: 30, snapshotRetentionDays: 30 },
        nowMs: round.decisionTimeMs,
      },
    );
    return { prisma, result };
  }

  test.each([0, 0.25, 0.5, 1])("rate %p: Tier B for exactly the decisions isSampled selects, Tier A for all", async (rate) => {
    const { prisma, result } = await writeAt(rate);
    const expected = LEGS.map((legId) => decisionRecord.decisionIdFor(round.roundId, legId)).filter((id) => sampling.isSampled(id, rate)).sort();
    expect(result.tierACount).toBe(LEGS.length);
    expect(prisma.__tables.tierBRecords.map((row) => row.decisionId).sort()).toEqual(expected);
    expect(prisma.__tables.decisionRecords.filter((row) => row.tierBWritten).map((row) => row.decisionId).sort()).toEqual(expected);
    for (const row of prisma.__tables.decisionRecords) expect(row.samplingRate).toBe(rate);
    if (rate === 0) expect(expected).toEqual([]);
    if (rate === 1) expect(expected).toHaveLength(LEGS.length);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   6. The real decision path: TSK-816, with evidence — same decision, real Tier B input
   ═══════════════════════════════════════════════════════════════════════════ */

describe("P7-D5 — TSK-816's round: the decision is unchanged by evidence capture and its Tier B input is what the gate computed", () => {
  const DT = w.TSK816.assignRoundMs;
  /**
   * The four robots as the store held them at 13:44:13.786Z (as `phase7AssignmentQuality`), with
   * ONE change: SIM-0A8C at 20 % SoC rather than 29 %. Since P7-C1 Step 3 priced the return leg
   * between exact points, the recorded 29 % robot passes F34 and wins; these tests need a rejected
   * candidate, and at 20 % its return to the depot is unreachable, so F34 is INDETERMINATE exactly
   * as the recorded decision's was (measured: `p7c1ExactReturnLeg.test.js`).
   */
  const fleet = () => [
    { robotId: "SIM-0A8C043FFE67", at: { lat: 12.901151, lon: 77.517575 }, socFraction: 0.2, status: "IDLE", positionAgeMs: 351 },
    {
      robotId: "SIM-1ABF21512BE5", at: { lat: 12.900817, lon: 77.518043 }, socFraction: 0.362, status: "PAUSED", positionAgeMs: 350,
      openCommitments: [{ legId: "leg-of-TSK-1790958521622-254", leaseExpiry: new Date("2026-10-02T16:53:35.042Z") }],
    },
    {
      robotId: "SIM-CFE1E46B2002", at: { lat: 12.900411, lon: 77.518715 }, socFraction: 0.62, status: "PAUSED", positionAgeMs: 349,
      openCommitments: [{ legId: "leg-of-TSK-1790960698218-551", leaseExpiry: new Date("2026-10-02T17:29:19.351Z") }],
    },
    { robotId: "SIM-9F6F88D84EBD", at: { lat: 12.90032004, lon: 77.51870238 }, socFraction: 0.95, status: "IDLE", positionAgeMs: 1360 },
  ];

  let out;
  beforeAll(async () => {
    out = await w.decide({ decisionTimeMs: DT, robots: fleet() });
  });

  test("the decision: winner SIM-9F6F at its recorded γ 748 531, SIM-0A8C bound by F34", () => {
    expect(out.winner).toBe("SIM-9F6F88D84EBD");
    const byAgent = Object.fromEntries(out.candidates.map((row) => [row.agentId, row]));
    expect(String(byAgent["SIM-9F6F88D84EBD"].gammaMilliCU)).toBe("748531");
    expect(byAgent["SIM-0A8C043FFE67"]).toMatchObject({ rejected: true, bindingPredicateId: "F34" });
  });

  test("Tier A's per-candidate rows carry only the fields they always did", () => {
    const allowed = ["agentId", "bindingPredicateId", "gammaMilliCU", "rejected"];
    expect(out.candidates.length).toBeGreaterThan(0);
    for (const row of out.candidates) expect(Object.keys(row).filter((key) => !allowed.includes(key))).toEqual([]);
  });

  test("the winner carries every predicate the gate ran (all 38), its γ decomposition, tier and lower bound", () => {
    const winner = out.tierBInput.candidates.find((row) => row.agentId === "SIM-9F6F88D84EBD");
    expect(winner.rejected).toBe(false);
    expect(winner.gammaMilliCU).toBe(748531n);
    expect(winner.breakdown.gammaMilliCU).toBe("748531");
    expect(winner.predicateResults).toHaveLength(feasibilityRegister.PREDICATE_COUNT);
    expect(winner.predicateResults.some((row) => row.outcome === "VIOLATED")).toBe(false);
    expect(winner.discoveryTier).not.toBeNull();
    expect(typeof winner.lowerBoundMilliCU).toBe("bigint");
    expect(winner.availabilityClass).toBe("IDLE_READY");
  });

  test("the rejected robot carries the predicates evaluated up to and including its binding F34 — no more", () => {
    const rejected = out.tierBInput.candidates.find((row) => row.agentId === "SIM-0A8C043FFE67");
    expect(rejected).toMatchObject({ rejected: true, bindingPredicateId: "F34", gammaMilliCU: null, breakdown: null });
    const last = rejected.predicateResults[rejected.predicateResults.length - 1];
    // Recorded as the gate computed it: F34 could not establish the shortfall bound, and its
    // registered §7.3 policy denied — which Tier A's binding-predicate-only summary cannot show.
    expect(last).toMatchObject({ predicateId: "F34", outcome: "INDETERMINATE", indeterminatePolicy: feasibilityRegister.predicate("F34").policy });
    expect(last.indeterminatePolicy).not.toBeNull();
    // Every predicate before the binding one admitted the robot.
    expect(rejected.predicateResults.slice(0, -1).some((row) => row.outcome === "VIOLATED")).toBe(false);
    expect(rejected.predicateResults.map((row) => row.predicateId)).toEqual(
      feasibilityRegister.EVALUATION_ORDER.slice(0, feasibilityRegister.EVALUATION_ORDER.indexOf("F34") + 1),
    );
    // Every value is JSON-safe, so the stored row is what the hash covers.
    expect(canonicalJson(throughJson(coordinator.jsonSafe(rejected.predicateResults)))).toBe(canonicalJson(rejected.predicateResults));
  });

  test("the built Tier B survives the Json round trip byte for byte, and is deterministic across replays", async () => {
    const decisionId = decisionRecord.decisionIdFor(`default:${DT}`, out.legRowId);
    const record = tierB.build({ ...out.tierBInput, decisionId });
    const stored = tierB.fromRow(throughJson(tierB.toRow(record, { writtenBecause: "SAMPLED" })));
    expect(tierB.equivalent(stored, record).ok).toBe(true);
    const sections = Object.fromEntries(tierB.SECTIONS.map((name) => [name, stored[name]]));
    expect(crypto.createHash("sha256").update(canonicalJson(sections)).digest("hex")).toBe(record.contentHash);

    const again = await w.decide({ decisionTimeMs: DT, robots: fleet() });
    expect(tierB.build({ ...again.tierBInput, decisionId }).contentHash).toBe(record.contentHash);
    expect(again.winner).toBe(out.winner);
  });
});

describe("P7-D5 — tierBInputFor states only what was observed", () => {
  test("an agent excluded for an unresolved lower bound is in the candidate set, named, with nothing invented", () => {
    const round = { legs: new Map([["LEG-1", { leg: { legId: "LEG-1", legRowId: "row-1" } }]]), outcomes: new Map() };
    const leg = { legId: "LEG-1" };
    coordinatorSolvePath.noteExpansionEvidence(round, leg, { candidates: [], unresolvedBoundAgentIds: ["AGT-NO-BATTERY"] });
    const input = coordinatorSolvePath.perLegFor(round)["row-1"].tierBInput;
    expect(input).toEqual({
      candidates: [{
        agentId: "AGT-NO-BATTERY", discoveryTier: null, availabilityClass: null, lowerBoundMilliCU: null, rejected: true,
        bindingPredicateId: coordinatorSolvePath.LOWER_BOUND_UNRESOLVED, gammaMilliCU: null, breakdown: null, predicateResults: [],
      }],
      columns: [],
      pruned: [],
    });
    // Tier A's compact candidate list is unchanged by it.
    expect(coordinatorSolvePath.perLegFor(round)["row-1"].candidates).toEqual([]);
  });

  test("a refusal before the gate (no route) has no predicate results", () => {
    const round = { legs: new Map([["LEG-1", { leg: { legId: "LEG-1", legRowId: "row-1" } }]]), outcomes: new Map() };
    coordinatorSolvePath.noteCandidateOutcome(round, { legId: "LEG-1" }, "AGT-X", { agentId: "AGT-X" }, {
      feasible: false, gammaMilliCU: null, refusal: coordinatorSolvePath.REFUSAL.MISSING_HOP, problems: [],
    });
    const [row] = coordinatorSolvePath.perLegFor(round)["row-1"].tierBInput.candidates;
    expect(row).toMatchObject({ agentId: "AGT-X", rejected: true, bindingPredicateId: "MISSING_HOP", predicateResults: [], discoveryTier: null });
  });
});
