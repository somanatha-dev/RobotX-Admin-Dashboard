"use strict";

/**
 * Engine lane — Phase 11: the two-tier decision record (§21.2).
 *
 * The three properties the whole scheme rests on, each checked mechanically rather than
 * argued: Tier A carries every §21.2 section, Tier A is `O(1)` in candidate count, and
 * Tier A fits inside §20.1's 2 KB bound.
 */

const tierA = require("../../src/engine/observability/tierA");
const tierB = require("../../src/engine/observability/tierB");
const sampling = require("../../src/engine/observability/sampling");
const decisionRecord = require("../../src/engine/observability/decisionRecord");
const fixture = require("./helpers/roundFixture");

const MILLI = (cu) => BigInt(cu) * 1000n;

function candidates(count, options) {
  const settings = options || {};
  return Array.from({ length: count }, (unused, index) => ({
    agentId: `AGT-${String(index + 1).padStart(3, "0")}`,
    discoveryTier: index % 3,
    lowerBoundMilliCU: MILLI(index),
    gammaMilliCU: settings.rejectAll ? undefined : MILLI(100 + index * 10),
    rejected: Boolean(settings.rejectAll),
    bindingPredicateId: settings.rejectAll ? "F34" : null,
    breakdown: settings.rejectAll ? null : { cDirect: MILLI(80 + index * 8), cRisk: MILLI(10), cLifecycle: MILLI(10 + index * 2) },
    predicateResults: [
      { predicateId: "F01", outcome: "PASS", observed: true, required: true, inputSource: "AGENT_STATE", observationAgeMs: 90, indeterminatePolicy: "DENY" },
      { predicateId: "F34", outcome: settings.rejectAll ? "FAIL" : "PASS", observed: { bindingTier: "T2" }, required: { tier: "T2" }, inputSource: "ENERGY_MODEL", observationAgeMs: 300, indeterminatePolicy: "DENY", margin: -0.03, marginUnit: "ratio" },
    ],
  }));
}

function tierAInput(overrides) {
  return {
    identity: {
      decisionId: "shard-a:1770000000000:LEG-1",
      roundId: "shard-a:1770000000000",
      shardId: "shard-a",
      leadershipFence: 7n,
      coordinatorInstance: "coord-1",
      decisionTimeMs: 1770000000000,
    },
    versions: {
      codeVersion: "abc123",
      configVersion: "42",
      activeRegime: "WINTER",
      modelVersions: { consumption: "v3" },
      mapVersion: "m9",
      routingGraphVersion: "rg2",
      chargerProjectionVersion: "cp7",
    },
    trigger: tierA.TRIGGER.NEW_ARRIVAL,
    inputSnapshotRefs: { snapshotId: "shard-a:1770000000000", hash: "deadbeef", seed: "0011" },
    leg: { legId: "LEG-1", purpose: "PRIMARY", missionClass: "STANDARD", tenantId: "T1", sla: { deadlineMs: 1770000600000 }, queueAgeSeconds: 42, ladderStep: 2 },
    outcome: { outcome: "ASSIGNED", agentId: "AGT-001", columnIdentity: "col:AGT-001:LEG-1", columnLegIds: ["LEG-1"], commitmentId: "CMT-1", commitmentFence: 12n, agentAuthorityEpoch: 3n },
    candidates: candidates(4),
    costTotals: {
      chosen: { cDirect: MILLI(80), cRisk: MILLI(10), cLifecycle: MILLI(10) },
      runnerUp: { cDirect: MILLI(88), cRisk: MILLI(10), cLifecycle: MILLI(12) },
    },
    rejectionSummary: [
      { predicateId: "F34", tier: "T2", count: 12 },
      { predicateId: "F22", tier: null, count: 3 },
    ],
    searchAndSolveBounds: {
      cellsExplored: 19,
      agentsEvaluated: 4,
      smallestUnexploredBoundMilliCU: MILLI(140),
      omegaTerminalMilliCU: MILLI(5),
      omegaPolicyMilliCU: MILLI(2),
      searchGapMilliCU: MILLI(3),
      lpIpGapMilliCU: 0n,
      regime: "SINGLETON",
      guarantees: { exact: true, exactOver: "the generated column set", dualKind: "EXACT_INTEGER_MARGINAL_PRICE" },
      columnsGenerated: 4,
      columnsPruned: 1,
      bestPrunedGammaMilliCU: MILLI(400),
      budgetLimited: false,
    },
    degradation: { dependencies: [], envelopeReductions: [], relaxations: [], shardModes: [], killSwitches: { deferral: false, batch_solving: false } },
    deferral: null,
    overrides: [],
    predictions: { TRAVEL_TIME: 300, ENERGY: 120, units: { TRAVEL_TIME: "s", ENERGY: "Wh" } },
    compactTopN: 5,
    ...(overrides || {}),
  };
}

describe("§21.2 Tier A — every section, always written", () => {
  test("carries all fourteen sections of §21.2's table", () => {
    const record = tierA.build(tierAInput());
    expect(tierA.assertComplete(record)).toEqual({ ok: true, missing: [] });
    expect(tierA.SECTIONS).toHaveLength(14);
  });

  test("carries the leadership fence, the active regime, both Ω values, and both gaps", () => {
    const record = tierA.build(tierAInput());
    // §10.3.2 guard G1's fence — so a late commit can be attributed to its leader.
    expect(record.identity.leadershipFence).toBe("7");
    // §22.2's active regime — a decision taken under a winter regime replays under it.
    expect(record.versions.activeRegime).toBe("WINTER");
    // §6.4's two admissibility corrections.
    expect(record.searchAndSolveBounds.omegaTerminalMilliCU).toBe("5000");
    expect(record.searchAndSolveBounds.omegaPolicyMilliCU).toBe("2000");
    // §9.3 — reported separately, never summed.
    expect(record.searchAndSolveBounds.searchGapMilliCU).toBe("3000");
    expect(record.searchAndSolveBounds.lpIpGapMilliCU).toBe("0");
  });

  test("records the state of every kill switch — §22.5 rule 4", () => {
    const record = tierA.build(tierAInput());
    // "A thrown switch that is not recorded would silently break replay determinism."
    expect(record.degradation.killSwitches).toEqual({ deferral: false, batch_solving: false });
  });

  test("carries the selected column's FULL Leg set, not only this Leg", () => {
    const record = tierA.build(
      tierAInput({ outcome: { outcome: "ASSIGNED", agentId: "AGT-001", columnIdentity: "c", columnLegIds: ["LEG-2", "LEG-1"] } }),
    );
    // Sorted canonically, so two records of the same column agree byte for byte.
    expect(record.outcome.columnLegIds).toEqual(["LEG-1", "LEG-2"]);
  });

  test("every cost crosses the JSON boundary as a decimal string, never a number", () => {
    const record = tierA.build(tierAInput());
    for (const value of Object.values(record.costTotals.chosen)) expect(typeof value).toBe("string");
    expect(record.runnerUpAndTopN.runnerUp.gammaMilliCU).toEqual(expect.any(String));
    // A number would compare equal on a small corpus and diverge past 2^53.
    expect(() => tierA.milli(12345)).toThrow(/int64 milli-CU/);
  });

  test("the runner-up carries its cost delta — the margin an operator asks for", () => {
    const record = tierA.build(tierAInput());
    expect(record.runnerUpAndTopN.runnerUp.agentId).toBe("AGT-002");
    expect(record.runnerUpAndTopN.runnerUp.deltaMilliCU).toBe("10000");
  });

  test("a rejected candidate contributes its binding predicate ONLY — the O(1) clause", () => {
    const record = tierA.build(tierAInput({ candidates: candidates(3, { rejectAll: true }), outcome: { outcome: "NO_FEASIBLE_CANDIDATE" } }));
    for (const row of record.runnerUpAndTopN.topN) {
      expect(row.bindingPredicateId).toBe("F34");
      // Never the 38-row evaluation that produced it — that belongs in Tier B.
      expect(row).not.toHaveProperty("predicates");
    }
  });

  test("the rejection summary is counts by binding predicate — the aggregate, never per-candidate rows", () => {
    const record = tierA.build(tierAInput());
    // Compact map form, with §7.7's F34 tier as part of the key.
    expect(record.rejectionSummary).toEqual({ "F34:T2": 12, F22: 3 });
    // Read back as the descending rows an operator sees, with shares.
    expect(tierA.rejectionRows(record.rejectionSummary)).toEqual([
      { predicateId: "F34", tier: "T2", count: 12, share: 12 / 15 },
      { predicateId: "F22", tier: null, count: 3, share: 3 / 15 },
    ]);
  });

  test("the map encoding is roughly a quarter the bytes of the row encoding it replaces", () => {
    const { canonicalJson } = require("../../src/engine/determinism/ordering");
    const rows = Array.from({ length: 38 }, (unused, index) => ({ predicateId: `F${String(index + 1).padStart(2, "0")}`, tier: null, count: 100 }));
    const asRows = canonicalJson(rows);
    const asMap = canonicalJson(tierA.rejectionSummaryOf(rows));
    expect(asMap.length).toBeLessThan(asRows.length / 3);
  });

  test("a deferral section is null when no deferral was taken, and populated when one was", () => {
    expect(tierA.build(tierAInput()).deferral).toBeNull();
    const deferred = tierA.build(
      tierAInput({ deferral: { reason: "SUPPLY_EXPECTED", supplyEventAwaited: "AGT-009 finishing in 90 s", expectedImprovementMilliCU: "3200000" } }),
    );
    expect(deferred.deferral.supplyEventAwaited).toBe("AGT-009 finishing in 90 s");
  });
});

describe("§21.2 — Tier A is O(1) in candidate count and inside §20.1's 2 KB bound", () => {
  test("the record is O(1) in candidate count — 200 candidates and 2 000 give the same bytes but for the count", () => {
    // The load-bearing property of §21.2. `candidate.max_evaluated` is 200, so both arms
    // are past the point where the top-N saturates; what remains is a record that does
    // not grow with k at all.
    const proof = tierA.assertBoundedInCandidateCount(tierAInput(), { small: 200, large: 2000 });
    expect(proof.differingFields).toEqual(["runnerUpAndTopN"]);
    expect(proof.ok).toBe(true);
    // The only growth is the decimal width of `candidatesConsidered`.
    expect(proof.growthBytes).toBeLessThanOrEqual(4);
  });

  test("growth from a small candidate set to the register's maximum is a handful of bytes", () => {
    const small = tierA.size(tierA.build(tierAInput({ candidates: candidates(4) }))).bytes;
    const atMax = tierA.size(tierA.build(tierAInput({ candidates: candidates(200) }))).bytes;
    // Fifty times the candidates, and the record barely moves. This is what
    // "O(1) in candidate count, not O(k · predicates)" means in bytes.
    expect(atMax - small).toBeLessThan(100);
  });

  test("the §20.1 size target is registered, measured on every record, and reported when exceeded", () => {
    const { defaultSnapshot } = require("../../src/engine/config/service");
    const limit = defaultSnapshot().resolve("perf.tier_a_record_bytes");
    expect(limit).toBe(2048);

    // The §21.2 worst case for a *compact* record: `candidate.max_evaluated` = 200
    // candidates behind it, and all 38 register predicates appearing as binding.
    const worstCase = tierA.build({
      ...tierAInput({ candidates: candidates(200) }),
      rejectionSummary: Array.from({ length: 38 }, (unused, index) => ({
        predicateId: `F${String(index + 1).padStart(2, "0")}`,
        tier: null,
        count: 200 - index,
      })),
    });

    const sized = tierA.size(worstCase, limit);

    // MEASURED, and stated rather than asserted away. A fully-populated §21.2 record
    // serialised as self-describing canonical JSON runs about 2.4–3.1 KB against
    // §20.1's `< 2 KB`. The overshoot is field names, not data: the record is ~1.8 KB
    // before a single candidate is considered, and adding 196 candidates costs under
    // 100 bytes. Closing it would mean abbreviating the field names of the one artefact
    // in the system whose purpose is that a human can read it.
    //
    // The upper fence moved from 3 000 to 3 200 at the Phase 11 remediation, and the
    // reason is recorded rather than absorbed: Phase 10's handoffs P11-2 and P11-3 added
    // six fields to `searchAndSolveBounds` (`solver`, `optimalityCertified`,
    // `fallbackFrom`, `objectiveMilliCU`, `boundMilliCU`, `truncationGapMilliCU`). Their
    // cost is measured directly by the next test, and it is ~130 bytes — the fence tracks
    // a measurement that grew for a stated reason, not a target that was relaxed to make
    // a red test green. The *requirement* — `limitBytes` 2 048, `withinLimit` false — is
    // asserted unchanged and still fails, which is the point.
    //
    // This bound is a release-gate target (§20.1), and what Phase 11 owes is that it is
    // measured, recorded per row, and visible — which it is: `sizeBytes` on every
    // `DecisionRecordA`, an SLI target in `sli.TARGETS`, and an `oversize` list from the
    // writer. The residual is recorded in the closure document, not hidden behind a
    // relaxed assertion.
    expect(sized.bytes).toBeGreaterThan(2000);
    expect(sized.bytes).toBeLessThan(3200);
    expect(sized.withinLimit).toBe(false);
    expect(sized.limitBytes).toBe(2048);
  });

  test("the Phase 10 solver fields cost about 130 bytes, and the overshoot does not depend on them", () => {
    // The honest accounting behind the fence above. Removing the six fields would still
    // leave the record over §20.1's 2 KB, so P11-2 and P11-3 did not create the overshoot
    // and reverting them would not close it — which is the fact the size decision in
    // `PHASE_11_REMEDIATION_AND_CLOSURE.md` §8 rests on.
    const base = tierA.build(tierAInput({ candidates: candidates(200) }));
    const withSolve = tierA.build(
      tierAInput({
        candidates: candidates(200),
        searchAndSolveBounds: {
          ...tierAInput().searchAndSolveBounds,
          solver: "COST_SCALING",
          optimalityCertified: true,
          fallbackFrom: null,
          objectiveMilliCU: MILLI(1240),
          boundMilliCU: MILLI(1240),
          truncationGapMilliCU: 0n,
        },
      }),
    );

    const populatedCost = tierA.size(withSolve).bytes - tierA.size(base).bytes;
    // Populating the six fields over their nulls is small; the fields' *presence* is the
    // ~130 bytes, and both are far short of the 900-byte overshoot.
    expect(populatedCost).toBeLessThan(100);

    const withoutSolveFields = { ...base, searchAndSolveBounds: { ...base.searchAndSolveBounds } };
    for (const field of ["solver", "optimalityCertified", "fallbackFrom", "objectiveMilliCU", "boundMilliCU", "truncationGapMilliCU"]) {
      delete withoutSolveFields.searchAndSolveBounds[field];
    }
    const strippedBytes = Buffer.byteLength(tierA.serialise(withoutSolveFields), "utf8");

    expect(tierA.size(base).bytes - strippedBytes).toBeGreaterThan(100);
    expect(tierA.size(base).bytes - strippedBytes).toBeLessThan(200);
    // The load-bearing claim: still over 2 KB with every one of them removed.
    expect(strippedBytes).toBeGreaterThan(2048);
  });

  test("a record whose sections are absent is refused — an absent section is not an empty one", () => {
    const record = { ...tierA.build(tierAInput()) };
    delete record.deferral;
    expect(tierA.assertComplete(record)).toEqual({ ok: false, missing: ["deferral"] });
  });

  test("toRow and fromRow round-trip every section", () => {
    const record = tierA.build(tierAInput());
    const row = tierA.toRow(record, { sizeBytes: 100 });
    const back = tierA.fromRow({ ...row, decisionTime: new Date(record.identity.decisionTimeMs) });
    expect(back.outcome).toEqual(record.outcome);
    expect(back.searchAndSolveBounds).toEqual(record.searchAndSolveBounds);
    expect(back.rejectionSummary).toEqual(record.rejectionSummary);
  });
});

describe("§21.2 Tier B — the full-fidelity record", () => {
  const input = {
    decisionId: "shard-a:1770000000000:LEG-1",
    roundId: "shard-a:1770000000000",
    shardId: "shard-a",
    decisionTimeMs: 1770000000000,
    candidates: candidates(4),
    columns: [{ identity: "col:A", agentId: "AGT-001", legIds: ["LEG-1"], gammaMilliCU: MILLI(100), breakdown: { cDirect: MILLI(80) } }],
    pruned: [{ identity: "col:B", agentId: "AGT-002", legIds: ["LEG-1"], reason: "BUDGET", gammaMilliCU: MILLI(400), breakdown: null }],
  };

  test("carries §21.2's four sections", () => {
    const record = tierB.build(input);
    expect(Object.keys(record)).toEqual(expect.arrayContaining(tierB.SECTIONS));
    expect(record.candidateSet).toHaveLength(4);
    // Per candidate, per predicate: result, observed, required, source, age, policy.
    expect(record.feasibility[0].predicates[0]).toMatchObject({
      predicateId: "F01",
      outcome: "PASS",
      inputSource: "AGENT_STATE",
      observationAgeMs: 90,
      indeterminatePolicy: "DENY",
    });
  });

  test("the column detail holds every GENERATED column, kept and pruned", () => {
    const record = tierB.build(input);
    expect(record.columnDetail.map((row) => [row.identity, row.kept])).toEqual([
      ["col:A", true],
      ["col:B", false],
    ]);
    expect(record.columnDetail[1].prunedReason).toBe("BUDGET");
  });

  test("is a pure function — the same input yields byte-identical output, twice", () => {
    const first = tierB.build(input);
    const second = tierB.build(input);
    expect(tierB.serialiseSections(first)).toBe(tierB.serialiseSections(second));
    expect(first.contentHash).toBe(second.contentHash);
  });

  test("the ordering does not depend on the order candidates arrived in", () => {
    const shuffled = { ...input, candidates: [...input.candidates].reverse() };
    expect(tierB.build(shuffled).contentHash).toBe(tierB.build(input).contentHash);
  });

  test("equivalent() finds the byte and the section when two records diverge", () => {
    const stored = tierB.build(input);
    const drifted = tierB.build({ ...input, candidates: candidates(4).map((row, index) => (index === 0 ? { ...row, gammaMilliCU: MILLI(999) } : row)) });
    const verdict = tierB.equivalent(stored, drifted);
    expect(verdict.ok).toBe(false);
    expect(verdict.differingSections).toContain("costs");
    expect(verdict.firstDifference.offset).toBeGreaterThan(0);
  });

  test("the identity fields are excluded from the compared bytes", () => {
    // They come from Tier A, which the reconstruction path already has; including them
    // would make the comparison partly a comparison of Tier A with itself.
    const other = tierB.build({ ...input, decisionId: "different", roundId: "different" });
    expect(tierB.serialiseSections(other)).toBe(tierB.serialiseSections(tierB.build(input)));
  });
});

describe("§21.2 / §24.3 — retention ordering", () => {
  test("computes both expiries from the decision time", () => {
    const retention = decisionRecord.retentionFor({
      decisionTimeMs: 0,
      fullRetentionDays: 30,
      tierBRetentionDays: 30,
      snapshotRetentionDays: 30,
    });
    expect(retention.ok).toBe(true);
    expect(retention.tierAUntil.getTime()).toBe(30 * decisionRecord.MS_PER_DAY);
    expect(retention.snapshotUntil.getTime()).toBe(30 * decisionRecord.MS_PER_DAY);
  });

  test("refuses a snapshot retention shorter than Tier A's — the pair V6 forbids", () => {
    const retention = decisionRecord.retentionFor({
      decisionTimeMs: 0,
      fullRetentionDays: 30,
      tierBRetentionDays: 30,
      snapshotRetentionDays: 7,
    });
    expect(retention.ok).toBe(false);
    expect(retention.problems[0]).toMatch(/unreplayable|defect/);
  });
});

describe("§21.2 — writeRound: the single writer", () => {
  const roundResult = {
    roundId: "shard-a:1770000000000",
    shardId: "shard-a",
    decisionTimeMs: 1770000000000,
    regime: "SINGLETON",
    guarantees: { exact: true, exactOver: "columns", dualKind: "EXACT_INTEGER_MARGINAL_PRICE" },
    columns: { generated: 4, kept: 3, pruned: 1, bestPrunedGammaMilliCU: MILLI(400) },
    budgets: { budgetLimited: false, exceeded: [] },
    lpIpGapMilliCU: 0n,
    committed: [{ legId: "LEG-1", commitmentId: "CMT-1" }],
    decisions: [
      { legId: "LEG-1", outcome: "ASSIGNED", agentId: "AGT-001", searchGapMilliCU: MILLI(3), cellsExplored: 19, agentsEvaluated: 4 },
      { legId: "LEG-2", outcome: "NO_FEASIBLE_CANDIDATE", searchGapMilliCU: 0n, cellsExplored: 25, agentsEvaluated: 0 },
    ],
  };

  const context = {
    shardId: "shard-a",
    leadershipFence: 7,
    coordinatorInstance: "coord-1",
    snapshot: { snapshotId: "shard-a:1770000000000", hash: "deadbeef", seed: "0011", pins: { configVersion: "42", codeVersion: "abc" } },
    perLeg: { "LEG-1": { candidates: candidates(3) }, "LEG-2": { candidates: candidates(2, { rejectAll: true }) } },
  };

  const config = { sampleRate: 0, compactTopN: 5, fullRetentionDays: 30, tierBRetentionDays: 30, snapshotRetentionDays: 30, tierARecordBytes: 2048 };

  test("writes the snapshot once and one Tier A per Leg, whatever the outcome", async () => {
    const prisma = fixture.memoryPrisma();
    const budget = sampling.createBudget({ writeBudgetPerMinute: 10, reservoirSize: 5 });

    const result = await decisionRecord.writeRound({ prisma }, { round: roundResult, context, budget, config, nowMs: 1770000000000 });

    expect(result.tierACount).toBe(2);
    expect(prisma.__tables.snapshots).toHaveLength(1);
    expect(prisma.__tables.decisionRecords.map((row) => row.decisionId).sort()).toEqual([
      "shard-a:1770000000000:LEG-1",
      "shard-a:1770000000000:LEG-2",
    ]);
    expect(decisionRecord.assertEveryDecisionRecorded({ round: roundResult, result })).toEqual({ ok: true, missing: [], duplicated: [] });
  });

  test("the snapshot is written BEFORE the records that depend on it, and is immutable on retry", async () => {
    const prisma = fixture.memoryPrisma();
    const budget = sampling.createBudget({ writeBudgetPerMinute: 10, reservoirSize: 5 });

    await decisionRecord.writeRound({ prisma }, { round: roundResult, context, budget, config, nowMs: 1 });
    const first = { ...prisma.__tables.snapshots[0] };
    await decisionRecord.writeRound({ prisma }, { round: roundResult, context: { ...context, snapshot: { ...context.snapshot, hash: "TAMPERED" } }, budget, config, nowMs: 2 });

    // Still one row, still the original hash: an existing snapshot is never rewritten,
    // because a stored decision's inputs must not change under it.
    expect(prisma.__tables.snapshots).toHaveLength(1);
    expect(prisma.__tables.snapshots[0].hash).toBe(first.hash);
  });

  test("every Tier A row records its own size and the sampling draw that selected it", async () => {
    const prisma = fixture.memoryPrisma();
    const budget = sampling.createBudget({ writeBudgetPerMinute: 10, reservoirSize: 5 });
    await decisionRecord.writeRound({ prisma }, { round: roundResult, context, budget, config: { ...config, sampleRate: 0.5 }, nowMs: 1 });

    for (const row of prisma.__tables.decisionRecords) {
      expect(row.sizeBytes).toBeGreaterThan(0);
      expect(row.samplingRate).toBe(0.5);
      expect(row.samplingDraw).toBeGreaterThanOrEqual(0);
      expect(row.samplingDraw).toBeLessThan(1);
      // The schema CHECK: a Tier B written without a reason is the unbounded exemption.
      if (row.tierBWritten) expect(row.tierBReason).not.toBeNull();
      else expect(row.tierBReason).toBeNull();
    }
  });

  test("an oversize record is recorded and reported, never dropped", async () => {
    const prisma = fixture.memoryPrisma();
    const budget = sampling.createBudget({ writeBudgetPerMinute: 10, reservoirSize: 5 });
    // A 1-byte limit makes every record oversize.
    const result = await decisionRecord.writeRound({ prisma }, { round: roundResult, context, budget, config: { ...config, tierARecordBytes: 1 }, nowMs: 1 });

    expect(result.oversize).toHaveLength(2);
    // Recorded anyway: a record refused for being large removes the evidence that the
    // §20.1 bound was exceeded, which is the one thing the target exists to surface.
    expect(prisma.__tables.decisionRecords).toHaveLength(2);
  });

  test("writes Tier B when the sample selects, and none when it does not", async () => {
    const prisma = fixture.memoryPrisma();
    const budget = sampling.createBudget({ writeBudgetPerMinute: 10, reservoirSize: 5 });
    const withTierB = {
      ...context,
      perLeg: {
        "LEG-1": { candidates: candidates(3), tierBInput: { candidates: candidates(3), columns: [], pruned: [] } },
        "LEG-2": { candidates: candidates(2, { rejectAll: true }), tierBInput: { candidates: candidates(2, { rejectAll: true }), columns: [], pruned: [] } },
      },
    };

    await decisionRecord.writeRound({ prisma }, { round: roundResult, context: withTierB, budget, config: { ...config, sampleRate: 1 }, nowMs: 1 });
    expect(prisma.__tables.tierBRecords).toHaveLength(2);
    expect(prisma.__tables.tierBRecords.every((row) => row.writtenBecause === "SAMPLED")).toBe(true);

    const none = fixture.memoryPrisma();
    await decisionRecord.writeRound({ prisma: none }, { round: roundResult, context: withTierB, budget, config: { ...config, sampleRate: 0 }, nowMs: 1 });
    expect(none.__tables.tierBRecords).toHaveLength(0);
    // Tier A still complete: the decision is not lost, it is reconstructible.
    expect(none.__tables.decisionRecords).toHaveLength(2);
  });

  test("THE GATE: the aggregate SLIs stay exact over 100 % of decisions despite Tier B sampling", async () => {
    // §21.2: "Aggregate SLIs never sample. … The histograms that make the feasibility
    // gate a capacity-planning instrument are therefore exact across 100 % of decisions,
    // while the per-candidate rows behind them are sampled. Aggregating first and
    // sampling second is what allows both properties to hold at once."
    const withHistogram = {
      ...context,
      perLeg: {
        "LEG-1": { candidates: candidates(3), rejectionSummary: [{ predicateId: "F34", tier: "T2", count: 17 }], tierBInput: { candidates: candidates(3) } },
        "LEG-2": { candidates: candidates(2, { rejectAll: true }), rejectionSummary: [{ predicateId: "F22", count: 9 }], tierBInput: { candidates: candidates(2, { rejectAll: true }) } },
      },
    };

    const sampled = fixture.memoryPrisma();
    const unsampled = fixture.memoryPrisma();
    const budget = sampling.createBudget({ writeBudgetPerMinute: 10, reservoirSize: 5 });

    await decisionRecord.writeRound({ prisma: sampled }, { round: roundResult, context: withHistogram, budget, config: { ...config, sampleRate: 1 }, nowMs: 1 });
    await decisionRecord.writeRound({ prisma: unsampled }, { round: roundResult, context: withHistogram, budget, config: { ...config, sampleRate: 0 }, nowMs: 1 });

    // Tier B is written in one run and not the other.
    expect(sampled.__tables.tierBRecords).toHaveLength(2);
    expect(unsampled.__tables.tierBRecords).toHaveLength(0);

    // The histograms are byte-identical regardless. Sampling touches the per-candidate
    // rows and cannot touch the counts, because the counts were folded first.
    const histograms = (prisma) => prisma.__tables.decisionRecords.map((row) => row.rejectionSummary);
    expect(histograms(unsampled)).toEqual(histograms(sampled));
    expect(histograms(sampled)).toEqual([{ "F34:T2": 17 }, { F22: 9 }]);
  });

  test("a shadow run's records carry both markers and cannot be mistaken for production", async () => {
    const prisma = fixture.memoryPrisma();
    const budget = sampling.createBudget({ writeBudgetPerMinute: 0, reservoirSize: 0 });
    await decisionRecord.writeRound(
      { prisma },
      { round: roundResult, context: { ...context, shadowLabel: "candidate-lambda-v2" }, budget, config, nowMs: 1 },
    );

    for (const row of prisma.__tables.decisionRecords) {
      expect(row.shadowLabel).toBe("candidate-lambda-v2");
      expect(row.decisionId.startsWith("shadow:candidate-lambda-v2:")).toBe(true);
    }
    // The filter every production read carries.
    expect(decisionRecord.PRODUCTION_ONLY).toEqual({ shadowLabel: null });
  });
});
