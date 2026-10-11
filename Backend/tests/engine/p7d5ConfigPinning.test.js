"use strict";

/**
 * P7-D5 D2 — a round reads one configuration, and its record says whether it did.
 *
 * Found (P7-D5 evidence completeness audit, 2026-10-11), and re-traced before this change:
 *   · the round's pinned snapshot was read once (`pinRoundInputs`), but planning re-read the
 *     LIVE accessor per Leg (`round.snapshotFor`) and per agent (`agentFactsOf`), so a publish
 *     landing mid-round split one round across two versions while the record named one;
 *   · round limits, cadence and the routing seam's TTL / intra-cell offset were resolved once
 *     at PROMOTION and never compared with the pin;
 *   · the commit re-read live configuration, unrecorded;
 *   · `resolvedValues` is global-scope only: class-specific (`sla_class`, `agent_class`)
 *     bindings the round consumed were never recorded.
 *
 * Now: planning reads only the snapshot `beginRound` pinned, through a view that records every
 * class-specific resolution; promotion-time values and every commit read are recorded and
 * compared; the result is sealed into the snapshot hash as `configEvidence`, and replay will
 * not call a decision VERIFIED unless that evidence says CONSISTENT.
 *
 * MOCKED BOUNDARY: the store (`phase7World`'s in-memory Prisma seeded from real LOCAL rows, or
 * `roundFixture.memoryPrisma`). The "publish" is the live accessor answering a different
 * snapshot after the round boundary — what `configPropagation` does to `app.locals.config`.
 */

const coordinatorSolvePath = require("../../src/workers/coordinatorSolvePath");
const coordinatorPipeline = require("../../src/workers/coordinatorPipeline");
const coordinator = require("../../src/workers/coordinator.worker");
const leaderWorkers = require("../../src/workers/leaderWorkers");
const planStateModel = require("../../src/engine/shard/planState");
const volatileSubset = require("../../src/engine/feasibility/volatileSubset");
const configService = require("../../src/engine/config/service");
const snapshotModel = require("../../src/engine/determinism/snapshot");
const sampling = require("../../src/engine/observability/sampling");
const intake = require("../../src/engine/intake/intake");
const leadership = require("../../src/engine/shard/leadership");
const replay = require("../../tools/replay/replayDecision");
const fixture = require("./helpers/roundFixture");
const w = require("./helpers/phase7World");

const { CONFIG_EVIDENCE_STATE, roundConfigView, configEvidenceFor } = coordinatorSolvePath;

/** The real accessor, taken before any spy, so nested spies can never wrap one another. */
const ORIGINAL_SNAPSHOT_FROM = coordinatorPipeline.snapshotFrom;

/** A published snapshot with class-specific bindings, built by the real config service. */
function scopedSnapshot(version = 7) {
  return configService.buildSnapshot({
    version,
    bindings: [
      { level: "agent_class", key: "porter-2", name: "energy.uncalibrated_reserve_factor", value: 1.5 },
      { level: "sla_class", key: "express", name: "candidate.max_evaluated", value: 50 },
    ],
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   1. The round view: same values, class-specific ones recorded
   ═══════════════════════════════════════════════════════════════════════════ */

describe("P7-D5 D2 — roundConfigView", () => {
  test("answers exactly what the pinned snapshot answers, at every scope", () => {
    const pinned = scopedSnapshot();
    const { view } = roundConfigView(pinned);
    const asks = [
      ["energy.uncalibrated_reserve_factor", {}],
      ["energy.uncalibrated_reserve_factor", { agent_class: "porter-2" }],
      ["energy.uncalibrated_reserve_factor", { agent_class: "other" }],
      ["candidate.max_evaluated", { sla_class: "express" }],
      ["candidate.max_evaluated", { sla_class: null }],
      ["dispatch.offer_ttl", {}],
    ];
    for (const [name, scope] of asks) expect(view.resolve(name, scope)).toEqual(pinned.resolve(name, scope));
    expect(view.values).toBe(pinned.values);
    expect(view.version).toBe(7);
    expect(Object.isFrozen(view)).toBe(true);
  });

  test("records each class-specific value consumed — and nothing a global read already shows", () => {
    const { view, ledger } = roundConfigView(scopedSnapshot());
    view.resolve("energy.uncalibrated_reserve_factor", {});
    view.resolve("energy.uncalibrated_reserve_factor", { agent_class: "other" });
    view.resolve("candidate.max_evaluated", { sla_class: null });
    expect([...ledger.scoped.values()]).toEqual([]);

    view.resolve("energy.uncalibrated_reserve_factor", { agent_class: "porter-2" });
    view.resolve("energy.uncalibrated_reserve_factor", { agent_class: "porter-2" });
    view.explain("candidate.max_evaluated", { sla_class: "express" });
    expect(ledger.capture).toBe("RECORDED");
    expect([...ledger.scoped.values()]).toEqual([
      { name: "energy.uncalibrated_reserve_factor", level: "agent_class", key: "porter-2", index: null, value: 1.5 },
      { name: "candidate.max_evaluated", level: "sla_class", key: "express", index: null, value: 50 },
    ]);
  });

  test("a snapshot with no explain() keeps its values and reports the capture as UNAVAILABLE", () => {
    const bare = { version: 3, values: new Map([["x", 1]]), resolve: () => 1 };
    const { view, ledger } = roundConfigView(bare);
    expect(view.resolve("x", { agent_class: "a" })).toBe(1);
    expect(ledger.capture).toBe("UNAVAILABLE");
    expect(roundConfigView(null)).toMatchObject({ view: null, ledger: { capture: "UNAVAILABLE" } });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   2. The evidence: one explicit state
   ═══════════════════════════════════════════════════════════════════════════ */

describe("P7-D5 D2 — configEvidenceFor", () => {
  const pinned = scopedSnapshot(7);
  const recorded = () => {
    const { view, ledger } = roundConfigView(pinned);
    view.resolve("energy.uncalibrated_reserve_factor", { agent_class: "porter-2" });
    return ledger;
  };
  const maxEvaluated = pinned.values.get("candidate.max_evaluated");

  test("CONSISTENT: promotion reads agree, every commit read was the pinned object, class values listed", () => {
    const evidence = configEvidenceFor({
      pinned,
      ledger: recorded(),
      commitReads: [{ version: 7, pinned: true }],
      promotionReads: [{ name: "candidate.max_evaluated", used: maxEvaluated, via: "finite" }],
    });
    expect(evidence).toMatchObject({ state: CONFIG_EVIDENCE_STATE.CONSISTENT, pinnedVersion: 7, mismatches: [], problems: [], promotionReads: 1, commitReads: 1 });
    expect(evidence.scopedResolutions).toEqual([
      { name: "energy.uncalibrated_reserve_factor", level: "agent_class", key: "porter-2", index: null, value: 1.5 },
    ]);
  });

  test("a value resolved at promotion that the pin no longer holds is a named MISMATCH", () => {
    const evidence = configEvidenceFor({
      pinned,
      ledger: recorded(),
      promotionReads: [{ name: "candidate.max_evaluated", used: maxEvaluated + 1, via: "finite" }],
    });
    expect(evidence.state).toBe(CONFIG_EVIDENCE_STATE.MISMATCH);
    expect(evidence.mismatches).toEqual([{ source: "PROMOTION", name: "candidate.max_evaluated", used: maxEvaluated + 1, pinned: maxEvaluated }]);
  });

  test("a commit that read another published version is a MISMATCH; the same version re-loaded is not", () => {
    expect(configEvidenceFor({ pinned, ledger: recorded(), commitReads: [{ version: 8, pinned: false }] }).mismatches).toEqual([
      { source: "COMMIT", version: 8, pinnedVersion: 7 },
    ]);
    expect(configEvidenceFor({ pinned, ledger: recorded(), commitReads: [{ version: 7, pinned: false }] }).state).toBe("CONSISTENT");
    // An unversioned live object that is not the pinned one cannot be shown to agree.
    expect(configEvidenceFor({ pinned, ledger: recorded(), commitReads: [{ version: null, pinned: false }] }).state).toBe("MISMATCH");
  });

  test("missing pieces are INCOMPLETE, never CONSISTENT; a mismatch outranks them", () => {
    expect(configEvidenceFor({ pinned: null, ledger: null })).toMatchObject({ state: "INCOMPLETE", problems: expect.arrayContaining([expect.stringMatching(/no configuration snapshot was pinned/)]) });
    expect(configEvidenceFor({ pinned, ledger: { capture: "UNAVAILABLE", scoped: new Map() } }).state).toBe("INCOMPLETE");
    expect(configEvidenceFor({ pinned, ledger: { capture: "UNAVAILABLE", scoped: new Map() }, commitReads: [{ version: 9, pinned: false }] }).state).toBe("MISMATCH");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   3. The real decision path (TSK-816): pinned planning, live commit
   ═══════════════════════════════════════════════════════════════════════════ */

describe("P7-D5 D2 — TSK-816 through the real path", () => {
  const DT = w.TSK816.assignRoundMs;
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
  /**
   * A publish that, applied to the whole round, changes TSK-816's outcome (proved below). Two
   * parameters, one per planning path: the heartbeat age is read by the agent facts during
   * `prepareRound` (F7 then rejects every robot); `candidate.max_evaluated` is read per Leg by
   * expansion. Both are read AFTER the round boundary. (Measured: the energy and cost parameters
   * do not move TSK-816 — the V1 agents declare their own energy model.)
   */
  const HEARTBEAT = "connectivity.max_heartbeat_age";
  const PUBLISHED_OVERRIDES = { [HEARTBEAT]: 0.000001, "candidate.max_evaluated": 0 };

  /** The published snapshot with named parameters answered differently, as a NEW version. */
  function republished(live, overrides, version) {
    const values = new Map(live.values);
    for (const [name, value] of Object.entries(overrides)) values.set(name, value);
    const has = (name) => Object.prototype.hasOwnProperty.call(overrides, name);
    return {
      ...live,
      version,
      values,
      resolve: (name, context, options) => (has(name) ? overrides[name] : live.resolve(name, context, options)),
      explain: (name, context, options) => {
        const explained = live.explain(name, context, options);
        return has(name) ? { ...explained, value: overrides[name], configVersion: version } : explained;
      },
    };
  }

  /**
   * Decide TSK-816 through `phase7World.decide`, capturing the assembly and the commit's
   * recheck adapter. `publishAtBoundary` makes the live accessor answer `transform(live)` from
   * the moment `beginRound` has pinned the round's configuration.
   */
  async function decideCapturing({ publishAtBoundary, configOverrides } = {}) {
    while (afterEachRestore.length > 0) afterEachRestore.pop()();
    let assembly = null;
    let buildContext = null;
    let volatileRecheck = null;
    let afterBoundary = false;
    let liveObject = null;
    let publishedObject = null;

    const create = coordinatorSolvePath.create;
    const createSpy = jest.spyOn(coordinatorSolvePath, "create").mockImplementation((context) => {
      assembly = create(context);
      return assembly;
    });
    const recheck = volatileSubset.createVolatileRecheck;
    const recheckSpy = jest.spyOn(volatileSubset, "createVolatileRecheck").mockImplementation((input) => {
      buildContext = input.buildContext;
      volatileRecheck = recheck(input);
      return volatileRecheck;
    });
    const planStateCreate = planStateModel.create;
    const planStateSpy = jest.spyOn(planStateModel, "create").mockImplementation((input) => {
      const real = planStateCreate(input);
      return Object.freeze({
        ...real,
        beginRound(roundId) {
          const begun = real.beginRound(roundId);
          afterBoundary = Boolean(publishAtBoundary);
          return begun;
        },
      });
    });
    // Built on whatever the accessor currently answers (a caller's own spy included), never on itself.
    const current = coordinatorPipeline.snapshotFrom;
    const underlying = current === ORIGINAL_SNAPSHOT_FROM ? ORIGINAL_SNAPSHOT_FROM : current.getMockImplementation() || ORIGINAL_SNAPSHOT_FROM;
    const accessorSpy = jest.spyOn(coordinatorPipeline, "snapshotFrom").mockImplementation((context) => {
      const answer = underlying(context);
      // Only the LIVE accessor changes on a publish — never the round's own pinned view.
      if (liveObject === null && answer && typeof answer.resolve === "function") liveObject = answer;
      if (afterBoundary && answer === liveObject) {
        if (publishedObject === null) publishedObject = republished(liveObject, PUBLISHED_OVERRIDES, (liveObject.version || 1) + 1);
        return publishedObject;
      }
      return answer;
    });

    try {
      const out = await w.decide({ decisionTimeMs: DT, robots: fleet(), ...(configOverrides ? { configOverrides } : {}) });
      return { out, assembly, buildContext, volatileRecheck, publishedObject: () => publishedObject };
    } finally {
      createSpy.mockRestore();
      recheckSpy.mockRestore();
      planStateSpy.mockRestore();
      // Left in place until the caller has finished asking the assembly; restored in afterEach.
      afterEachRestore.push(() => accessorSpy.mockRestore());
    }
  }

  const afterEachRestore = [];
  afterEach(() => {
    while (afterEachRestore.length > 0) afterEachRestore.pop()();
  });

  const shape = (out) => ({
    outcome: out.outcome,
    winner: out.winner,
    candidates: out.candidates.map((row) => ({ ...row, gammaMilliCU: row.gammaMilliCU === null ? null : String(row.gammaMilliCU) })),
    rejectionSummary: out.rejectionSummary,
  });

  test("with configuration unchanged, the decision is the recorded one and the evidence is CONSISTENT", async () => {
    const { out, assembly } = await decideCapturing();
    expect(out.winner).toBe("SIM-9F6F88D84EBD");
    const byAgent = Object.fromEntries(out.candidates.map((row) => [row.agentId, row]));
    expect(String(byAgent["SIM-9F6F88D84EBD"].gammaMilliCU)).toBe("748531");
    expect(byAgent["SIM-0A8C043FFE67"]).toMatchObject({ rejected: true, bindingPredicateId: "F34" });

    const evidence = assembly.deps.configEvidence({});
    expect(evidence).toMatchObject({ state: "CONSISTENT", scopedResolutionCapture: "RECORDED", mismatches: [], problems: [] });
    expect(evidence.pinnedVersion).toBe(assembly.round.configPinned.version);
    expect(evidence.promotionReads).toBe(3); // solve.time_budget and the routing seam's two
    // The record pins the object planning read.
    expect(assembly.deps.roundConfig()).toBe(assembly.round.configView);
  });

  test("the publish used below DOES change TSK-816 when a round reads it (counterfactual, whole round)", async () => {
    const baseline = (await decideCapturing()).out;
    const counterfactual = (await decideCapturing({ configOverrides: PUBLISHED_OVERRIDES })).out;
    expect(shape(counterfactual)).not.toEqual(shape(baseline));
  });

  test("a publish landing mid-round: planning keeps the pinned version, so the decision is unchanged", async () => {
    const baseline = shape((await decideCapturing()).out);
    const { out, assembly, publishedObject } = await decideCapturing({ publishAtBoundary: true });
    expect(shape(out)).toEqual(baseline);
    // Planning never asked the live accessor after the boundary — the publish went unread.
    expect(publishedObject()).toBeNull();
    expect(assembly.deps.configEvidence({}).state).toBe("CONSISTENT");
    // …but the live accessor DID change: asked now, it answers the new version.
    const live = coordinatorPipeline.snapshotFrom(assembly.context);
    expect(live.version).toBe(assembly.round.configPinned.version + 1);
    expect(live.resolve(HEARTBEAT, {})).toBe(0.000001);
    expect(assembly.round.snapshotFor().resolve(HEARTBEAT, {})).not.toBe(0.000001);
  });

  /** The commit's §10.3.2 step-3 recheck for the winning pairing, exactly as `commit.js` calls it. */
  const commitContextFor = (out) => ({
    leg: { legId: out.assignment.legId },
    agent: { agentId: out.assignment.agentId },
    storeTime: new Date(DT),
  });

  test("with no publish, the commit's volatile recheck passes and the evidence stays CONSISTENT", async () => {
    const { out, assembly, volatileRecheck } = await decideCapturing();
    expect(await volatileRecheck(commitContextFor(out))).toEqual({ ok: true });
    const evidence = assembly.deps.configEvidence({});
    expect(evidence.state).toBe("CONSISTENT");
    expect(evidence.commitReads).toBeGreaterThan(0); // the commit's reads are noted…
    expect(evidence.mismatches).toEqual([]); // …and they were the pinned version
  });

  test("…after a mid-round publish the commit reads the NEW version and fails closed; the record says MISMATCH", async () => {
    const { out, assembly, buildContext, volatileRecheck, publishedObject } = await decideCapturing({ publishAtBoundary: true });
    const pinnedVersion = assembly.round.configPinned.version;

    // The recheck's configuration is the newest published one, never the round's pin.
    const context = await buildContext(commitContextFor(out));
    expect(context.plan).not.toBeNull();
    expect(context.config.get(HEARTBEAT)).toBe(0.000001);

    // And it is authoritative: the pairing the round planned does not commit under it.
    const verdict = await volatileRecheck(commitContextFor(out));
    expect(verdict).toMatchObject({ ok: false, reason: "VOLATILE_FEASIBILITY_LOST" });

    const evidence = assembly.deps.configEvidence({});
    expect(evidence.state).toBe("MISMATCH");
    expect(evidence.mismatches).toContainEqual({ source: "COMMIT", version: publishedObject().version, pinnedVersion });
  });

  test("class-specific values the round consumed are recorded (an agent_class binding on the gate's scope)", async () => {
    // The published snapshot with ONE parameter bound at agent_class — same value, so the
    // decision cannot move — and answered as a binding at that level.
    const NAME = "dispatch.nack_cooloff";
    const { out, assembly } = await (async () => {
      const spy = jest.spyOn(coordinatorPipeline, "snapshotFrom").mockImplementation((context) => {
        const live = ORIGINAL_SNAPSHOT_FROM(context);
        if (!live || typeof live.explain !== "function" || live.__boundForTest) return live;
        const explain = (name, scope, options) => {
          const explained = live.explain(name, scope, options);
          return name === NAME && scope && scope.agent_class
            ? { ...explained, source: "BINDING", level: "agent_class", key: String(scope.agent_class) }
            : explained;
        };
        return { ...live, __boundForTest: true, explain, resolve: (n, s, o) => explain(n, s, o).value };
      });
      try {
        return await decideCapturing();
      } finally {
        spy.mockRestore();
      }
    })();
    expect(out.winner).toBe("SIM-9F6F88D84EBD");
    const scoped = assembly.deps.configEvidence({}).scopedResolutions.filter((row) => row.name === NAME);
    expect(scoped.length).toBeGreaterThan(0);
    for (const row of scoped) expect(row).toMatchObject({ level: "agent_class", index: null });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   4. runRound seals the evidence into the hashed snapshot; replay reads it
   ═══════════════════════════════════════════════════════════════════════════ */

describe("P7-D5 D2 — runRound records the configuration evidence, and replay honours it", () => {
  const SHARD = leadership.DEFAULT_SHARD_ID;
  const NOW = new Date("2026-10-11T12:00:00.000Z");
  const CONFIG = { windowMinMs: 500, windowMaxMs: 3000, saturatedWindowMs: 10000, batchGrowthThreshold: 10, fastPathClasses: [], maxLegsPerRound: 500 };
  const CODE = "git:abc1234";

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

  async function runWith({ evidence, codeVersion = CODE } = {}) {
    const prisma = store();
    await prisma.workQueue.create({
      data: {
        legId: "leg-row-1", shardId: SHARD, idempotencyKey: "k-1", purpose: "PRIMARY", slaClass: "standard",
        priority: 0, state: intake.QUEUE_STATE.QUEUED, enqueuedAt: new Date(NOW.getTime() - 1000),
      },
    });
    const config = configService.buildSnapshot({ version: 7 });
    const record = jest.fn();
    const provider = evidence === undefined ? {} : { configEvidence: typeof evidence === "function" ? evidence : () => evidence };
    const result = await coordinator.runRound(
      {
        prisma,
        planState: planStateModel.create({ shardId: SHARD }),
        expandCandidates: async () => ({ candidates: [], achievedGapMilliCU: 0n, problems: [] }),
        pricedCandidateFor: () => null,
        commit: async () => ({ committed: false }),
        perLegFor: () => ({ "leg-row-1": { candidates: [], rejectionSummary: [] } }),
        recordBudget: sampling.createBudget({ writeBudgetPerMinute: 5000, reservoirSize: 100 }),
        record,
        ...provider,
      },
      { shardId: SHARD, config: CONFIG, feasibleSupply: 3, nowMs: NOW.getTime(), instanceId: "instance-1", killSwitches: {}, configSnapshot: () => config, codeVersion },
    );
    expect(result.ran).toBe(true);
    return { prisma, record };
  }

  /** Replay the round's one decision from the stored rows, with complete inputs and no Tier B. */
  async function replayStored(prisma, edit) {
    const [tierA] = prisma.__tables.decisionRecords;
    const [snapshot] = prisma.__tables.snapshots;
    const stored = JSON.parse(JSON.stringify({ ...snapshot, decisionTime: undefined }));
    const row = { ...tierA, inputSnapshot: { ...stored, decisionTime: snapshot.decisionTime, ...(edit ? edit(stored) : {}) }, tierB: null };
    return replay.replayDecision(
      {
        prisma: { decisionRecordA: { findUnique: async () => row } },
        round: { plan: async () => ({ decisions: [] }) },
        expandCandidates: async () => ({}),
        pricedCandidateFor: () => null,
      },
      tierA.decisionId,
      { legsFor: () => [{ legId: "leg-row-1" }], configFor: () => ({}), candidatesFor: () => [] },
    );
  }

  const CONSISTENT = { state: "CONSISTENT", pinnedVersion: 7, scopedResolutions: [], mismatches: [], problems: [] };

  test("CONSISTENT evidence is hashed into the snapshot: replay finds it INTACT, and an edited verdict is a HASH_MISMATCH", async () => {
    const { prisma } = await runWith({ evidence: CONSISTENT });
    const [snapshot] = prisma.__tables.snapshots;
    expect(snapshot.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshot.pins.configEvidence).toEqual(CONSISTENT);

    const intact = await replayStored(prisma);
    expect(intact).toMatchObject({ snapshotState: "INTACT", configEvidenceState: "CONSISTENT" });
    expect(intact.reasons).not.toContain(replay.UNVERIFIED_REASON.CONFIG_EVIDENCE_NOT_CONSISTENT);

    const edited = await replayStored(prisma, (stored) => ({ pins: { ...stored.pins, configEvidence: { ...CONSISTENT, state: "CONSISTENT", mismatches: [{ source: "x" }] } } }));
    expect(edited.status).toBe(replay.REPLAY_STATUS.SNAPSHOT_HASH_MISMATCH);
  });

  test("MISMATCH evidence is recorded, reported as an event, and keeps replay from VERIFIED", async () => {
    const MISMATCH = { state: "MISMATCH", pinnedVersion: 7, mismatches: [{ source: "COMMIT", version: 8, pinnedVersion: 7 }], problems: [] };
    const { prisma, record } = await runWith({ evidence: MISMATCH });
    expect(record).toHaveBeenCalledWith("coordinator.config_evidence", expect.objectContaining({ state: "MISMATCH", mismatches: MISMATCH.mismatches }));
    const replayed = await replayStored(prisma);
    expect(replayed).toMatchObject({ snapshotState: "INTACT", configEvidenceState: "MISMATCH", configMismatches: MISMATCH.mismatches });
    expect(replayed.reasons).toContain(replay.UNVERIFIED_REASON.CONFIG_EVIDENCE_NOT_CONSISTENT);
    expect(replayed.reproducibility.completeDeterministicReplay).toBe(false);
  });

  test("no evidence provider: the record says NOT_RECORDED, never CONSISTENT", async () => {
    const { prisma, record } = await runWith();
    const [snapshot] = prisma.__tables.snapshots;
    expect(snapshot.pins.configEvidence).toMatchObject({ state: "NOT_RECORDED" });
    expect(record).not.toHaveBeenCalledWith("coordinator.config_evidence", expect.anything());
    const replayed = await replayStored(prisma);
    expect(replayed.configEvidenceState).toBe("NOT_RECORDED");
    expect(replayed.reasons).toContain(replay.UNVERIFIED_REASON.CONFIG_EVIDENCE_NOT_CONSISTENT);
  });

  test("a provider that throws costs the evidence (INCOMPLETE), never the round", async () => {
    const { prisma, record } = await runWith({ evidence: () => { throw new Error("boom"); } });
    expect(prisma.__tables.snapshots[0].pins.configEvidence).toMatchObject({ state: "INCOMPLETE" });
    expect(record).toHaveBeenCalledWith("coordinator.config_evidence", expect.objectContaining({ state: "INCOMPLETE" }));
  });

  test("an unpinned round (no code version) carries the evidence but still claims no hash", async () => {
    const { prisma } = await runWith({ evidence: CONSISTENT, codeVersion: null });
    const [snapshot] = prisma.__tables.snapshots;
    expect(snapshot.hash).toBe("");
    expect(snapshot.pins.configEvidence).toEqual(CONSISTENT);
    expect((await replayStored(prisma)).snapshotState).toBe("UNPINNED");
  });

  test("a snapshot captured without evidence keeps the exact body and hash it always had", () => {
    const inputs = { roundId: "r", decisionTime: 1, configVersion: 1, codeVersion: "c", killSwitchState: {} };
    const before = snapshotModel.captureSnapshot(inputs);
    expect(Object.keys(before)).not.toContain("configEvidence");
    expect(snapshotModel.captureSnapshot({ ...inputs, configEvidence: undefined }).hash).toBe(before.hash);
    expect(snapshotModel.captureSnapshot({ ...inputs, configEvidence: CONSISTENT }).hash).not.toBe(before.hash);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   5. The composition hands the worker the pin and the promotion-time reads
   ═══════════════════════════════════════════════════════════════════════════ */

describe("P7-D5 D2 — leaderWorkers composes the coordinator with the round's pin", () => {
  afterEach(() => jest.restoreAllMocks());

  test("configSnapshot is the round's pinned view; promotionConfigReads names every promotion-time setting", () => {
    const config = configService.buildSnapshot({ version: 7 });
    const pinnedView = { version: 7, values: config.values };
    jest.spyOn(coordinatorSolvePath, "create").mockReturnValue({
      ok: true,
      deps: { roundConfig: () => pinnedView },
      context: { snapshot: () => config, expansionWallClockBudgetMs: 100 },
    });
    let settings = null;
    jest.spyOn(coordinator, "start").mockImplementation((deps, given) => {
      settings = given;
      return { stop() {} };
    });
    expect(leaderWorkers.COMPOSERS.coordinator({ values: config.values, shardId: "default", instanceId: "i-1" }).ok).toBe(true);

    expect(settings.configSnapshot()).toBe(pinnedView);
    const names = settings.promotionConfigReads.map((read) => read.name).sort();
    expect(names).toEqual([
      "candidate.max_evaluated", "plan.max_columns_per_round", "solve.branch_node_budget", "solve.max_legs_per_round",
      "solve.saturated_window", "solve.window_max", "solve.window_min", "time.max_clock_skew", "time.store_round_trip",
    ]);
    // Each recorded read is the value the round was handed.
    expect(settings.promotionConfigReads.find((read) => read.name === "candidate.max_evaluated").used).toBe(settings.config.maxEvaluatedPerLeg);
    expect(settings.config.timeBudgetMs).toBe(100);
  });
});
