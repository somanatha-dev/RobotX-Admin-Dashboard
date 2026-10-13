"use strict";

/**
 * P7-D5 D7 — the round snapshot says what its `codeVersion` covers, and which parameter register
 * the round ran with, as additive, hashed, forensic evidence.
 *
 * Found (P7-D5 evidence audit D7; Session 1 scope audit and Session 2's review, 2026-10-11):
 *   · `codeVersion` is a SOURCE identity — `git:<commit>` on the platform, `src-sha256:` (server.js
 *     + src/**\/*.js) otherwise — and the record never said which, or what either excludes;
 *   · the configuration carries `registerDigest` (the register this process loaded) and
 *     `registerDigestAtPublish` (the one its version was published against); neither was pinned
 *     and the two were never compared.
 *
 * Now (additive only):
 *   · `config/codeVersion.describeCodeVersion` — pure, non-throwing: source kind + fixed scope;
 *   · two snapshot keys, `codeIdentity` and `registerIdentity` (`SAME | DRIFTED | UNKNOWN`), each
 *     hashed ONLY when its evidence exists — never written as `null` — so every snapshot captured
 *     without them keeps its exact hash; carried in `pins` exactly when hashed, through the D2 seal;
 *   · kept apart from D2's `configEvidence`: drift is provenance, never a D2 MISMATCH or a D5 verdict.
 *
 * MOCKED BOUNDARY: the store (`roundFixture.memoryPrisma`, `phase7World`'s in-memory Prisma) and the
 * `ConfigVersion` read. The configuration is the REAL published LOCAL v1 payload
 * (`fixtures/phase7/local-2026-10-09.json`) loaded through the real `configService.loadPinnedSnapshot`;
 * pinning, sealing, the decision-record writer, `runRound` and `replayDecision` are the real modules.
 */

const path = require("path");

const codeVersion = require("../../src/config/codeVersion");
const snapshotModel = require("../../src/engine/determinism/snapshot");
const configService = require("../../src/engine/config/service");
const decisionRecord = require("../../src/engine/observability/decisionRecord");
const sampling = require("../../src/engine/observability/sampling");
const tierB = require("../../src/engine/observability/tierB");
const planState = require("../../src/engine/shard/planState");
const intake = require("../../src/engine/intake/intake");
const leadership = require("../../src/engine/shard/leadership");
const coordinator = require("../../src/workers/coordinator.worker");
const { replayDecision, SNAPSHOT_STATE } = require("../../tools/replay/replayDecision");
const fixture = require("./helpers/roundFixture");
const w = require("./helpers/phase7World");
const LOCAL = require("../fixtures/phase7/local-2026-10-09.json");

const { SOURCE, SCOPE, describeCodeVersion } = codeVersion;
const { REGISTER_IDENTITY_STATE } = coordinator;

const DIGEST = "src-sha256:" + "a".repeat(64);
const OTHER_REGISTER = "f".repeat(64);
const ROUND = { roundId: "default:1790000040000", decisionTimeMs: 1790000040000, seed: snapshotModel.deriveSeed("default:1790000040000") };
const throughJson = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

/**
 * The REAL published LOCAL v1 configuration, through the real `loadPinnedSnapshot`, with its
 * payload's publish-time register digest replaced (`OMIT` removes it).
 */
const OMIT = Symbol("omit");
async function published(atPublish) {
  const payload = { ...LOCAL.configVersion.payload };
  if (atPublish === OMIT) delete payload.registerDigest;
  else if (atPublish !== undefined) payload.registerDigest = atPublish;
  const row = { ...LOCAL.configVersion, payload };
  return configService.loadPinnedSnapshot({ prisma: { configVersion: { findUnique: async () => row } }, version: LOCAL.configVersion.version });
}

/** The digest of the register this process loads (`registerDigest`). */
const IN_FORCE = configService.buildSnapshot({ version: 7 }).registerDigest;

/* ═══════════════════════════════════════════════════════════════════════════
   1. describeCodeVersion
   ═══════════════════════════════════════════════════════════════════════════ */

describe("P7-D5 D7 — describeCodeVersion says what an identity is and covers, and never throws", () => {
  test.each([
    ["git:abc1234", SOURCE.PLATFORM_COMMIT],
    ["git:" + "0".repeat(40), SOURCE.PLATFORM_COMMIT],
    [DIGEST, SOURCE.SOURCE_DIGEST],
  ])("%s → %s, with that source's fixed scope", (value, source) => {
    expect(describeCodeVersion(value)).toEqual({ source, scope: SCOPE[source] });
  });

  test.each([
    [null], [undefined], [""], ["c"], ["code-1"], ["test"], ["abc123"], ["e558243"], ["git:"], ["git:ABC1234"],
    ["git:abc12"], ["git:" + "a".repeat(41)], ["git:abc1234 "], ["src-sha256:"], ["src-sha256:" + "a".repeat(63)],
    ["src-sha256:" + "A".repeat(64)], [42], [{}], [["git:abc1234"]], [Symbol("x")],
  ])("%p → NONE with no scope", (value) => {
    expect(() => describeCodeVersion(value)).not.toThrow();
    expect(describeCodeVersion(value)).toEqual({ source: SOURCE.NONE, scope: null });
  });

  test("everything resolveCodeVersion can produce is described with a scope", () => {
    const commit = codeVersion.resolveCodeVersion({ env: { RENDER_GIT_COMMIT: "ABCDEF1234567" } });
    expect(describeCodeVersion(commit.codeVersion)).toEqual({ source: commit.source, scope: SCOPE.PLATFORM_COMMIT });
    const digest = codeVersion.resolveCodeVersion({ env: {} });
    expect(describeCodeVersion(digest.codeVersion)).toEqual({ source: digest.source, scope: SCOPE.SOURCE_DIGEST });
  });

  test("the SOURCE_DIGEST scope is what sourceDigest actually covers: server.js + src/**/*.js, no register JSON", () => {
    const backend = path.resolve(__dirname, "../..");
    const files = new Map([["server.js", "s"], ["src/a.js", "a"], ["src/engine/config/register/x.json", "{}"]]);
    const io = {
      existsSync: (p) => [...files.keys()].some((rel) => path.join(backend, rel) === p),
      readFileSync: (p) => Buffer.from(files.get([...files.keys()].find((rel) => path.join(backend, rel) === p))),
      readdirSync: (dir) => {
        const prefix = path.relative(backend, dir).split(path.sep).join("/");
        const children = new Map();
        for (const rel of files.keys()) {
          if (!rel.startsWith(prefix + "/")) continue;
          const [head, ...rest] = rel.slice(prefix.length + 1).split("/");
          children.set(head, rest.length > 0);
        }
        return [...children].map(([name, isDir]) => ({ name, isDirectory: () => isDir, isFile: () => !isDir }));
      },
    };
    const withJson = codeVersion.sourceDigest(backend, io);
    files.set("src/engine/config/register/x.json", "{\"changed\":true}");
    expect(codeVersion.sourceDigest(backend, io)).toEqual(withJson); // a register edit does NOT move it …
    expect(withJson.files).toBe(2); // … because only server.js and the .js file are digested
    expect(SCOPE.SOURCE_DIGEST).toMatch(/server\.js and src\/\*\*\/\*\.js only/);
    expect(SCOPE.SOURCE_DIGEST).toMatch(/parameter register JSON/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   2. Register identity: SAME, DRIFTED, UNKNOWN
   ═══════════════════════════════════════════════════════════════════════════ */

describe("P7-D5 D7 — registerIdentity compares the register in force with the one at publish", () => {
  test("SAME: the published version recorded the register this process loaded (real loadPinnedSnapshot)", async () => {
    const config = await published(IN_FORCE);
    expect(coordinator.registerIdentityFrom(config)).toEqual({ inForce: IN_FORCE, atPublish: IN_FORCE, state: REGISTER_IDENTITY_STATE.SAME });
  });

  test("DRIFTED: published against a different register — provenance, nothing more", async () => {
    const config = await published(OTHER_REGISTER);
    expect(coordinator.registerIdentityFrom(config)).toEqual({ inForce: IN_FORCE, atPublish: OTHER_REGISTER, state: REGISTER_IDENTITY_STATE.DRIFTED });
  });

  test.each([
    ["a payload with no digest (null at publish)", OMIT],
    ["a malformed digest at publish (recorded as null, never copied)", "abc"],
  ])("UNKNOWN: %s", async (_, atPublish) => {
    const config = await published(atPublish);
    expect(coordinator.registerIdentityFrom(config)).toEqual({ inForce: IN_FORCE, atPublish: null, state: REGISTER_IDENTITY_STATE.UNKNOWN });
  });

  test("UNKNOWN: a configuration built in-process states no publish-time digest (buildSnapshot, defaultSnapshot)", () => {
    for (const config of [configService.buildSnapshot({ version: 7 }), configService.defaultSnapshot()]) {
      expect(config.registerDigestAtPublish).toBeUndefined();
      expect(coordinator.registerIdentityFrom(config)).toEqual({ inForce: IN_FORCE, atPublish: null, state: REGISTER_IDENTITY_STATE.UNKNOWN });
    }
  });

  test("no digest at all → no evidence (undefined, so no key is written)", () => {
    expect(coordinator.registerIdentityFrom(null)).toBeUndefined();
    expect(coordinator.registerIdentityFrom({})).toBeUndefined();
    expect(coordinator.registerIdentityFrom({ registerDigest: "x", registerDigestAtPublish: null })).toBeUndefined();
  });

  test("identityEvidence carries each key only when its evidence exists", async () => {
    const config = await published(IN_FORCE);
    expect(Object.keys(coordinator.identityEvidence(config, DIGEST)).sort()).toEqual(["codeIdentity", "registerIdentity"]);
    expect(Object.keys(coordinator.identityEvidence(config, "code-1"))).toEqual(["registerIdentity"]);
    expect(Object.keys(coordinator.identityEvidence(null, "git:abc1234"))).toEqual(["codeIdentity"]);
    expect(coordinator.identityEvidence(null, null)).toEqual({});
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   3. Snapshot compatibility: legacy hashes, goldens, absent keys
   ═══════════════════════════════════════════════════════════════════════════ */

describe("P7-D5 D7 — a snapshot without identity keeps its exact historical hash", () => {
  // Computed with the PRE-D7 `determinism/snapshot.js` (sha256 4884ef88…, the accepted D6 baseline)
  // by `scratchpad/d7-impl/golden-pre-d7.js`; the post-D7 module must reproduce them exactly.
  const GOLDEN = [
    ["minimal", { roundId: "default:1790000040000", decisionTime: 1790000040000, configVersion: 7, codeVersion: "c", killSwitchState: {} },
      "e13e1224c992bf6cd773c47d73b9c78706015a87c2a6b66ae1e2cc71f3612262"],
    ["full", {
      roundId: "default:1790000040000", decisionTime: 1790000040000, configVersion: 7, codeVersion: DIGEST,
      killSwitchState: { deferral: false }, activeRegime: null,
      resolvedValues: { "candidate.max_evaluated": 40, "observability.tier_b_sample_rate": 0.01 },
    }, "11bac24ac8a05de490742870767f8f0149d4e58c66215fb8319e50743f76d005"],
    ["withConfigEvidence", {
      roundId: "default:1790000040000", decisionTime: 1790000040000, configVersion: 7, codeVersion: "git:abc1234",
      killSwitchState: {}, resolvedValues: { a: 1 }, configEvidence: { state: "CONSISTENT", mismatches: [], problems: [] },
    }, "ea55a4b265e67e216023da259f6d85336a5cae73bede84e1756722fdf75d0ce0"],
  ];

  test.each(GOLDEN)("golden %s: the pre-D7 hash, unchanged", (_, inputs, hash) => {
    expect(snapshotModel.captureSnapshot(inputs).hash).toBe(hash);
  });

  test.each(GOLDEN)("golden %s: absent, undefined, null or non-object identity is NOT hashed", (_, inputs, hash) => {
    for (const absent of [undefined, null, "SAME", 0, ["x"]]) {
      const captured = snapshotModel.captureSnapshot({ ...inputs, codeIdentity: absent, registerIdentity: absent });
      expect(captured.hash).toBe(hash);
      expect("codeIdentity" in captured).toBe(false);
      expect("registerIdentity" in captured).toBe(false);
    }
  });

  test("present identity IS hashed: each key moves the hash, and the snapshot stays intact", () => {
    const [, inputs, hash] = GOLDEN[1];
    const code = { source: SOURCE.SOURCE_DIGEST, scope: SCOPE.SOURCE_DIGEST };
    const register = { inForce: IN_FORCE, atPublish: IN_FORCE, state: REGISTER_IDENTITY_STATE.SAME };
    const withCode = snapshotModel.captureSnapshot({ ...inputs, codeIdentity: code });
    const withRegister = snapshotModel.captureSnapshot({ ...inputs, registerIdentity: register });
    const withBoth = snapshotModel.captureSnapshot({ ...inputs, codeIdentity: code, registerIdentity: register });
    expect(new Set([hash, withCode.hash, withRegister.hash, withBoth.hash]).size).toBe(4);
    for (const captured of [withCode, withRegister, withBoth]) expect(snapshotModel.isIntact(captured)).toBe(true);
    expect(snapshotModel.isIntact({ ...withBoth, registerIdentity: { ...register, state: REGISTER_IDENTITY_STATE.DRIFTED } })).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   4. pinRoundInputs and sealRoundSnapshot: pinned, unpinned and fallback paths
   ═══════════════════════════════════════════════════════════════════════════ */

describe("P7-D5 D7 — round pinning carries identity exactly where the hash does", () => {
  /** The body `replayDecision` rebuilds from a stored row: its columns plus `pins`. */
  function rebuiltFrom(snapshot) {
    const row = throughJson(decisionRecord.snapshotRow({ snapshot, roundId: ROUND.roundId, shardId: "default", decisionTimeMs: ROUND.decisionTimeMs }));
    return {
      roundId: row.roundId, decisionTime: ROUND.decisionTimeMs, configVersion: row.configVersion, codeVersion: row.codeVersion,
      killSwitchState: row.killSwitchState, activeRegime: row.activeRegime, hash: row.hash, seed: row.seed,
      resolvedValues: row.resolvedValues ?? null, ...(row.pins || {}),
    };
  }

  test("pinned: both identity keys are hashed AND in pins; the rebuilt body is intact", async () => {
    const config = await published(IN_FORCE);
    const out = coordinator.pinRoundInputs({ configSnapshot: () => config, codeVersion: DIGEST }, ROUND);
    expect(out.pinned).toBe(true);
    expect(out.snapshot.pins.codeIdentity).toEqual({ source: SOURCE.SOURCE_DIGEST, scope: SCOPE.SOURCE_DIGEST });
    expect(out.snapshot.pins.registerIdentity).toEqual({ inForce: IN_FORCE, atPublish: IN_FORCE, state: REGISTER_IDENTITY_STATE.SAME });
    // The captured body (hash input) and pins carry the same identity keys, and the inputs the D2
    // seal re-captures from carry them too.
    expect(out.captureInputs.codeIdentity).toEqual(out.snapshot.pins.codeIdentity);
    expect(out.captureInputs.registerIdentity).toEqual(out.snapshot.pins.registerIdentity);
    expect(snapshotModel.isIntact(rebuiltFrom(out.snapshot))).toBe(true);
    // Drop either from pins and the stored row can no longer rebuild the hashed body.
    for (const key of coordinator.IDENTITY_PIN_KEYS) {
      const { [key]: _gone, ...pins } = out.snapshot.pins;
      expect(snapshotModel.isIntact(rebuiltFrom({ ...out.snapshot, pins }))).toBe(false);
    }
  });

  test("pinned with an unprefixed code version ('c', 'code-1'): no codeIdentity key, register identity kept", async () => {
    const config = await published(IN_FORCE);
    for (const label of ["c", "code-1"]) {
      const out = coordinator.pinRoundInputs({ configSnapshot: () => config, codeVersion: label }, ROUND);
      expect(out.pinned).toBe(true);
      expect("codeIdentity" in out.snapshot.pins).toBe(false);
      expect("codeIdentity" in out.captureInputs).toBe(false);
      expect(out.snapshot.pins.registerIdentity.state).toBe(REGISTER_IDENTITY_STATE.SAME);
      expect(snapshotModel.isIntact(rebuiltFrom(out.snapshot))).toBe(true);
    }
  });

  test("the pre-D7 pin keys are unchanged and still null-filled; identity keys are never null-filled", async () => {
    const out = coordinator.pinRoundInputs({ configSnapshot: () => configService.buildSnapshot({ version: 7 }), codeVersion: "c" }, ROUND);
    expect(Object.keys(out.snapshot.pins).sort()).toEqual([
      "activeRegime", "agentStateVersion", "chargerProjectionPublishedAt", "chargerProjectionVersion", "codeVersion",
      "configVersion", "forecastVersion", "killSwitchState", "modelVersions", "priceSnapshotVersion", "registerIdentity",
    ]);
    expect(Object.values(out.snapshot.pins).every((value) => value !== undefined)).toBe(true);
  });

  test("unpinned (no code version): identity recorded beside the known pins, and NO hash", async () => {
    const config = await published(IN_FORCE);
    const out = coordinator.pinRoundInputs({ configSnapshot: () => config, codeVersion: null }, ROUND);
    expect(out.pinned).toBe(false);
    expect(out.snapshot.hash).toBeUndefined();
    expect("codeIdentity" in out.snapshot.pins).toBe(false);
    expect(out.snapshot.pins.registerIdentity.state).toBe(REGISTER_IDENTITY_STATE.SAME);
    // Sealing an unpinned snapshot keeps the identity in pins and still invents no hash.
    const sealed = coordinator.sealRoundSnapshot(out, { state: "CONSISTENT", mismatches: [], problems: [] });
    expect(sealed.hash).toBeUndefined();
    expect(sealed.pins.registerIdentity).toEqual(out.snapshot.pins.registerIdentity);
  });

  test("unpinned (unpublished configuration): both identities recorded, no hash", () => {
    const out = coordinator.pinRoundInputs({ configSnapshot: () => configService.defaultSnapshot(), codeVersion: DIGEST }, ROUND);
    expect(out.pinned).toBe(false);
    expect(out.snapshot.hash).toBeUndefined();
    expect(out.snapshot.pins.codeIdentity.source).toBe(SOURCE.SOURCE_DIGEST);
    expect(out.snapshot.pins.registerIdentity.state).toBe(REGISTER_IDENTITY_STATE.UNKNOWN);
  });

  test("the no-config fallback shape is exactly as before (p7d5DecisionEvidence :195, :220)", () => {
    expect(coordinator.pinRoundInputs({}, ROUND).snapshot).toEqual({ snapshotId: ROUND.roundId, pins: null, seed: ROUND.seed });
    const thrown = coordinator.pinRoundInputs({ configSnapshot: () => { throw new Error("boom"); }, codeVersion: DIGEST }, ROUND);
    expect(thrown.snapshot).toEqual({ snapshotId: ROUND.roundId, pins: null, seed: ROUND.seed });
    // A caller-supplied snapshot is used as is.
    const explicit = { snapshotId: "x", pins: null, seed: "00" };
    expect(coordinator.pinRoundInputs({ snapshot: explicit, configSnapshot: () => configService.buildSnapshot({ version: 7 }), codeVersion: DIGEST }, ROUND).snapshot).toBe(explicit);
  });

  test("D2 seal and reseal: identity survives, is re-hashed with the evidence, and resealing is deterministic", async () => {
    const config = await published(OTHER_REGISTER);
    const out = coordinator.pinRoundInputs({ configSnapshot: () => config, codeVersion: "git:abc1234" }, ROUND);
    const evidence = { state: "CONSISTENT", mismatches: [], problems: [] };
    const sealed = coordinator.sealRoundSnapshot(out, evidence);
    expect(sealed.hash).not.toBe(out.snapshot.hash);
    expect(sealed.pins.codeIdentity).toEqual({ source: SOURCE.PLATFORM_COMMIT, scope: SCOPE.PLATFORM_COMMIT });
    expect(sealed.pins.registerIdentity).toEqual({ inForce: IN_FORCE, atPublish: OTHER_REGISTER, state: REGISTER_IDENTITY_STATE.DRIFTED });
    expect(sealed.pins.configEvidence).toEqual(evidence); // D2 evidence untouched by drift: no MISMATCH is introduced
    expect(snapshotModel.isIntact(rebuiltFrom(sealed))).toBe(true);
    // Resealing the same round inputs gives the identical sealed snapshot.
    expect(coordinator.sealRoundSnapshot(out, evidence)).toEqual(sealed);
    // A sealed snapshot handed back in carries a hash and is left exactly as given.
    expect(coordinator.sealRoundSnapshot({ snapshot: sealed, pinned: false }, evidence)).toBe(sealed);
    // The sealed hash is exactly captureSnapshot over the same inputs + evidence.
    expect(sealed.hash).toBe(snapshotModel.captureSnapshot({ ...out.captureInputs, configEvidence: evidence }).hash);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   5. End to end: runRound → stored InputSnapshot → replayDecision
   ═══════════════════════════════════════════════════════════════════════════ */

describe("P7-D5 D7 — a sealed round's identity survives storage and replay reconstruction", () => {
  const SHARD = leadership.DEFAULT_SHARD_ID;
  const NOW = new Date("2026-10-10T12:00:00.000Z");
  const LEG_ROW = "leg-row-1";
  const TIER_B_INPUT = { candidates: [{ agentId: "A1", rejected: true, bindingPredicateId: "F7", predicateResults: [] }], columns: [], pruned: [] };

  function store() {
    const prisma = fixture.memoryPrisma();
    prisma.$queryRawUnsafe = async (sql) => {
      if (sql.includes("NOW()")) return [{ now: NOW }];
      if (sql.includes("ShardLeadership")) return [{ shardId: SHARD, leadershipFence: "7", holder: "instance-1", leaseExpiry: new Date(NOW.getTime() + 60_000) }];
      return [];
    };
    prisma.leg = { findMany: async () => [], updateMany: async () => ({ count: 0 }) };
    return prisma;
  }

  async function runWith({ config, code }) {
    const prisma = store();
    await prisma.workQueue.create({
      data: { legId: LEG_ROW, shardId: SHARD, idempotencyKey: "k-1", purpose: "PRIMARY", slaClass: "standard", priority: 0, state: intake.QUEUE_STATE.QUEUED, enqueuedAt: new Date(NOW.getTime() - 1000) },
    });
    const result = await coordinator.runRound(
      {
        prisma,
        planState: planState.create({ shardId: SHARD }),
        expandCandidates: async () => ({ candidates: [], achievedGapMilliCU: 0n, problems: [] }),
        pricedCandidateFor: () => null,
        commit: async () => ({ committed: false }),
        perLegFor: () => ({ [LEG_ROW]: { candidates: [], rejectionSummary: [], tierBInput: TIER_B_INPUT } }),
        recordBudget: sampling.createBudget({ writeBudgetPerMinute: 10, reservoirSize: 1 }),
        record: () => {},
      },
      {
        shardId: SHARD, config: { windowMinMs: 500, windowMaxMs: 3000, saturatedWindowMs: 10000, batchGrowthThreshold: 10, fastPathClasses: [], maxLegsPerRound: 500 },
        feasibleSupply: 3, nowMs: NOW.getTime(), instanceId: "instance-1", killSwitches: {},
        configSnapshot: () => config, codeVersion: code,
      },
    );
    expect(result.ran).toBe(true);
    return prisma;
  }

  /** The real replay tool over the stored rows, JSON-round-tripped as Postgres stores them. */
  async function replayStored(prisma, mutateSnapshot) {
    const [tierARow] = prisma.__tables.decisionRecords;
    const [snapshotRow] = prisma.__tables.snapshots;
    const stored = throughJson({ ...snapshotRow, decisionTime: undefined });
    const inputSnapshot = { ...stored, decisionTime: snapshotRow.decisionTime };
    if (mutateSnapshot) mutateSnapshot(inputSnapshot);
    const tierBRow = prisma.__tables.tierBRecords.find((row) => row.decisionId === tierARow.decisionId) || null;
    return replayDecision(
      {
        prisma: { decisionRecordA: { findUnique: async () => ({ ...tierARow, inputSnapshot, tierB: tierBRow }) } },
        round: { plan: async () => ({ roundId: tierARow.roundId, decisions: [] }) },
      },
      tierARow.decisionId,
    );
  }

  test("stored pins carry both identities; the real replay rebuild reads the snapshot INTACT", async () => {
    const prisma = await runWith({ config: await published(IN_FORCE), code: DIGEST });
    const [snapshotRow] = prisma.__tables.snapshots;
    expect(snapshotRow.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshotRow.pins.codeIdentity).toEqual({ source: SOURCE.SOURCE_DIGEST, scope: SCOPE.SOURCE_DIGEST });
    expect(snapshotRow.pins.registerIdentity).toEqual({ inForce: IN_FORCE, atPublish: IN_FORCE, state: REGISTER_IDENTITY_STATE.SAME });
    expect(snapshotRow.pins.configEvidence).toBeDefined(); // the D2 seal ran
    const replayed = await replayStored(prisma);
    expect(replayed.snapshotState).toBe(SNAPSHOT_STATE.INTACT);
    expect(replayed.snapshotIntact).toBe(true);
  });

  test.each([
    ["codeIdentity.scope", (s) => { s.pins.codeIdentity.scope = "everything"; }],
    ["codeIdentity removed", (s) => { delete s.pins.codeIdentity; }],
    ["registerIdentity.state", (s) => { s.pins.registerIdentity.state = REGISTER_IDENTITY_STATE.DRIFTED; }],
    ["registerIdentity.atPublish", (s) => { s.pins.registerIdentity.atPublish = OTHER_REGISTER; }],
    ["registerIdentity removed", (s) => { delete s.pins.registerIdentity; }],
  ])("tampering with %s is detected as a snapshot hash mismatch", async (_, mutate) => {
    const prisma = await runWith({ config: await published(IN_FORCE), code: DIGEST });
    const replayed = await replayStored(prisma, mutate);
    expect(replayed.snapshotState).toBe(SNAPSHOT_STATE.HASH_MISMATCH);
    expect(replayed.snapshotIntact).toBe(false);
  });

  test("a DRIFTED round replays INTACT: drift is recorded provenance, not a replay verdict", async () => {
    const prisma = await runWith({ config: await published(OTHER_REGISTER), code: "git:abc1234" });
    const [snapshotRow] = prisma.__tables.snapshots;
    expect(snapshotRow.pins.registerIdentity.state).toBe(REGISTER_IDENTITY_STATE.DRIFTED);
    expect((await replayStored(prisma)).snapshotState).toBe(SNAPSHOT_STATE.INTACT);
  });

  test("a legacy stored row (no identity keys) still replays INTACT", async () => {
    const prisma = await runWith({ config: await published(IN_FORCE), code: "code-1" });
    const [snapshotRow] = prisma.__tables.snapshots;
    expect("codeIdentity" in snapshotRow.pins).toBe(false);
    // Strip the register identity too, as a pre-D7 row would have it: re-capture without it.
    const prismaLegacy = await runWith({ config: { ...(await published(IN_FORCE)), registerDigest: undefined, registerDigestAtPublish: undefined }, code: "code-1" });
    const [legacyRow] = prismaLegacy.__tables.snapshots;
    expect(Object.keys(legacyRow.pins).some((key) => coordinator.IDENTITY_PIN_KEYS.includes(key))).toBe(false);
    expect((await replayStored(prismaLegacy)).snapshotState).toBe(SNAPSHOT_STATE.INTACT);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   6. TSK-816: the real path, a D7-pinned and D2-sealed snapshot, the real writer
   ═══════════════════════════════════════════════════════════════════════════ */

describe("P7-D5 D7 — TSK-816's Tier B hash is unchanged with identity in its snapshot", () => {
  test("Tier B contentHash is the pre-D4/D6/D7 baseline; the stored snapshot carries identity and is intact", async () => {
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

    const roundId = `default:${w.TSK816.assignRoundMs}`;
    const pinRound = { roundId, decisionTimeMs: w.TSK816.assignRoundMs, seed: snapshotModel.deriveSeed(roundId) };
    const pinned = coordinator.pinRoundInputs({ configSnapshot: () => LOADED, codeVersion: DIGEST }, pinRound);
    expect(pinned.pinned).toBe(true);
    const sealed = coordinator.sealRoundSnapshot(pinned, { state: "CONSISTENT", mismatches: [], problems: [] });

    const round = {
      roundId, shardId: "default", decisionTimeMs: w.TSK816.assignRoundMs, regime: "SINGLETON",
      columns: { generated: 0, kept: 0, pruned: 0, bestPrunedGammaMilliCU: null }, budgets: { budgetLimited: false, exceeded: [] },
      lpIpGapMilliCU: 0n, committed: [], partitions: [], decisions: [out.decision],
    };
    const prisma = fixture.memoryPrisma();
    const result = await decisionRecord.writeRound(
      { prisma },
      {
        round,
        context: {
          shardId: "default", snapshot: sealed, compactTopN: 5,
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

    const [snapshotRow] = prisma.__tables.snapshots;
    expect(snapshotRow.hash).toBe(sealed.hash);
    expect(snapshotRow.pins.codeIdentity.source).toBe(SOURCE.SOURCE_DIGEST);
    expect(snapshotRow.pins.registerIdentity.state).toBe(REGISTER_IDENTITY_STATE.SAME);
  });
});

/** The published LOCAL v1 configuration with its real publish-time digest, loaded once. */
let LOADED = null;
beforeAll(async () => {
  LOADED = await published(IN_FORCE);
});
