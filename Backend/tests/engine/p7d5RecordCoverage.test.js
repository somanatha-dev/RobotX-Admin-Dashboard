"use strict";

/**
 * P7-D5 D4 — a decision record never states as fact what it never captured.
 *
 * Found (P7-D5 D4 audit, 2026-10-11), on the real TSK-816 path:
 *   · R1 — nothing produced Tier A's `costTotals`, so `what_did_it_cost` answered "This decision
 *     was priced at 0 CU across 0 term(s)" for a decision priced at γ 748 531 milli-CU, and
 *     `why_this_agent` / `what_would_change_it` silently carried empty breakdowns — while the
 *     round had computed both γ breakdowns (they are in the Tier B input);
 *   · R2 — `what_happened` said "only the predictions are available" when none were recorded;
 *   · R3 — the degradation lists and `overrides` were stored as `[]` ("none") with no producer
 *     behind them ("not recorded").
 * And the §20.1 size limit `perf.tier_a_record_bytes` existed but was never mapped, so the
 * writer's `oversize` report could not fire.
 *
 * Invariants pinned here: Tier B (content and `contentHash`) is byte-identical; the fields the
 * dashboard reads are exactly the pre-D4 baseline; the decision itself is unchanged.
 *
 * MOCKED BOUNDARY: the store (`phase7World`'s in-memory Prisma seeded from real LOCAL rows, and
 * `roundFixture.memoryPrisma`).
 */

const w = require("./helpers/phase7World");
const decisionRecord = require("../../src/engine/observability/decisionRecord");
const tierA = require("../../src/engine/observability/tierA");
const tierB = require("../../src/engine/observability/tierB");
const explanation = require("../../src/engine/observability/explanation");
const sampling = require("../../src/engine/observability/sampling");
const configService = require("../../src/engine/config/service");
const coordinator = require("../../src/workers/coordinator.worker");
const fixture = require("./helpers/roundFixture");

const { COST_TOTALS_NOT_RECORDED, costTermsFrom, costTotalsFrom } = decisionRecord;

const sumOf = (terms) => Object.values(terms).reduce((total, value) => total + BigInt(value), 0n);
const answer = (result, query) => result.answers.find((row) => row.query === query);

/* ═══════════════════════════════════════════════════════════════════════════
   1. The real decision path: TSK-816, written as production writes it
   ═══════════════════════════════════════════════════════════════════════════ */

describe("P7-D5 D4 — TSK-816 through the real path and the real writer", () => {
  const DT = w.TSK816.assignRoundMs;
  const fleet = () => [
    { robotId: "SIM-0A8C043FFE67", at: { lat: 12.901151, lon: 77.517575 }, socFraction: 0.2, status: "IDLE", positionAgeMs: 351 },
    { robotId: "SIM-1ABF21512BE5", at: { lat: 12.900817, lon: 77.518043 }, socFraction: 0.9, status: "IDLE", positionAgeMs: 350 },
    { robotId: "SIM-9F6F88D84EBD", at: { lat: 12.90032004, lon: 77.51870238 }, socFraction: 0.95, status: "IDLE", positionAgeMs: 1360 },
  ];

  /**
   * The pre-D4 baseline, captured from this exact scenario and writer before any D4 change
   * (scratchpad `p7d5-d4/baseline-tsk816.json`): the dashboard-read fields and Tier B's hash.
   */
  const BASELINE = {
    tierBContentHash: "616685b644c83d1c962c153d84989d4ef2a1c476f9e8891ab31f038532277993",
    tierASizeBytes: 2158,
    whyStillWaiting: {
      outcome: "ASSIGNED",
      sentence: "100 % of rejections were F34. That is what is binding for this Leg.",
      rejectionHistogram: [{ predicateId: "F34", tier: null, count: 1, share: 1 }],
      bindingConstraint: { predicateId: "F34", tier: null, count: 1, share: 1 },
    },
    whatWouldChangeIt: {
      sentence: "Any single cost term of the chosen agent rising by 28.307 CU flips this decision to SIM-1ABF21512BE5.",
      feasibilityLevers: [
        {
          agentId: "SIM-0A8C043FFE67",
          lever: "FEASIBILITY",
          bindingPredicateId: "F34",
          note: "this candidate is not priced; it enters the decision only if this predicate is satisfied",
        },
      ],
    },
    whatHappenedSettled: false,
    runnerUp: { agentId: "SIM-1ABF21512BE5", deltaMilliCU: "28307", gammaMilliCU: "776838" },
  };

  let out;
  let written;
  let tierARow;
  let tierBRow;
  let explained;

  beforeAll(async () => {
    out = await w.decide({ decisionTimeMs: DT, robots: fleet() });
    const round = {
      roundId: `default:${DT}`,
      shardId: "default",
      decisionTimeMs: DT,
      regime: "SINGLETON",
      columns: { generated: 0, kept: 0, pruned: 0, bestPrunedGammaMilliCU: null },
      budgets: { budgetLimited: false, exceeded: [] },
      lpIpGapMilliCU: 0n,
      committed: [],
      partitions: [],
      decisions: [out.decision],
    };
    const prisma = fixture.memoryPrisma();
    written = await decisionRecord.writeRound(
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
        // The production limit, now that it is mapped (`coordinator.observabilityFrom`).
        config: { sampleRate: 1, compactTopN: 5, fullRetentionDays: 30, tierBRetentionDays: 30, snapshotRetentionDays: 30, tierARecordBytes: 2048 },
        nowMs: DT,
      },
    );
    [tierARow] = prisma.__tables.decisionRecords;
    [tierBRow] = prisma.__tables.tierBRecords;
    explained = explanation.explain({ row: tierARow, tierBRow: tierB.fromRow(tierBRow) });
  });

  test("the decision is unchanged: winner SIM-9F6F at γ 748 531", () => {
    expect(out.winner).toBe("SIM-9F6F88D84EBD");
    expect(String(out.candidates.find((row) => row.agentId === "SIM-9F6F88D84EBD").gammaMilliCU)).toBe("748531");
  });

  test("R1 — the winner's itemised breakdown reconciles EXACTLY to its γ of 748 531 milli-CU", () => {
    const { chosen, notRecorded } = tierARow.costTotals;
    expect(notRecorded).toEqual({ chosen: null, runnerUp: null });
    expect(Object.keys(chosen)).toContain("C_churn");
    for (const value of Object.values(chosen)) expect(value).toMatch(/^-?\d+$/);
    expect(sumOf(chosen)).toBe(748531n);
  });

  test("R1 — the runner-up is the record's own runner-up, and its breakdown reconciles to 776 838 — verified independently", () => {
    expect(tierARow.runnerUpAndTopN.runnerUp).toEqual(BASELINE.runnerUp);
    expect(sumOf(tierARow.costTotals.runnerUp)).toBe(776838n);
    // Independently, from the round's own γ breakdown for that agent: Φ(candidate) − Φ(base) + churn.
    const breakdown = out.tierBInput.candidates.find((row) => row.agentId === "SIM-1ABF21512BE5").breakdown;
    const independent = BigInt(breakdown.phiCandidateMilliCU) - BigInt(breakdown.phiBaseMilliCU) + BigInt(breakdown.churnMilliCU);
    expect(independent).toBe(776838n);
    expect(BigInt(breakdown.gammaMilliCU)).toBe(776838n);
    // And the margin the two breakdowns imply is the record's margin.
    expect(sumOf(tierARow.costTotals.runnerUp) - sumOf(tierARow.costTotals.chosen)).toBe(BigInt(BASELINE.runnerUp.deltaMilliCU));
  });

  test("R1/R2 — the cost answers now state what was priced", () => {
    const cost = answer(explained, "what_did_it_cost");
    expect(cost).toMatchObject({ recorded: true, notRecordedReason: null, totalMilliCU: "748531", totalCU: 748.531 });
    expect(cost.sentence).toMatch(/^This decision was priced at 748\.531 CU across \d+ term\(s\)\.$/);
    const why = answer(explained, "why_this_agent");
    expect(why).toMatchObject({ costBreakdownRecorded: true, marginMilliCU: "28307" });
    expect(Array.isArray(why.decisiveTerms)).toBe(true);
    const change = answer(explained, "what_would_change_it");
    expect(change.costLeversRecorded).toBe(true);
    expect(change.costLevers.length).toBe(Object.keys(tierARow.costTotals.chosen).length);
  });

  test("the fields the dashboard reads are EXACTLY the pre-D4 baseline", () => {
    const waiting = answer(explained, "why_still_waiting");
    expect({
      outcome: waiting.outcome,
      sentence: waiting.sentence,
      rejectionHistogram: waiting.rejectionHistogram,
      bindingConstraint: waiting.bindingConstraint,
    }).toEqual(BASELINE.whyStillWaiting);
    const change = answer(explained, "what_would_change_it");
    expect({ sentence: change.sentence, feasibilityLevers: change.feasibilityLevers }).toEqual(BASELINE.whatWouldChangeIt);
    expect(answer(explained, "what_happened").settled).toBe(BASELINE.whatHappenedSettled);
  });

  test("Tier B is byte-identical: same contentHash as the pre-D4 baseline, and it still reconstructs", () => {
    expect(tierBRow.contentHash).toBe(BASELINE.tierBContentHash);
    const rebuilt = tierB.build({ ...out.tierBInput, decisionId: tierBRow.decisionId, roundId: tierBRow.roundId, shardId: tierBRow.shardId, decisionTimeMs: DT });
    expect(rebuilt.contentHash).toBe(BASELINE.tierBContentHash);
    expect(tierB.equivalent(tierB.fromRow(tierBRow), rebuilt).ok).toBe(true);
  });

  test("R3 — no producer: degradation lists and overrides are null (not recorded); the switch state is kept", () => {
    expect(tierARow.degradation).toMatchObject({ dependencies: null, envelopeReductions: null, relaxations: null, shardModes: null });
    expect(Object.prototype.hasOwnProperty.call(tierARow.degradation, "killSwitches")).toBe(true);
    expect(tierARow.overrides).toBeNull();
    expect(tierA.fromRow(tierARow).overrides).toBeNull();
    expect(tierA.assertComplete(tierA.fromRow(tierARow)).ok).toBe(true);
    // D3 — marking is not producing: nothing became exempt, the budget saw no exempt offer.
    expect(written.written[0].exemptionReasons).toEqual([]);
  });

  test("R2 — what_happened no longer offers predictions that were never recorded", () => {
    const happened = answer(explained, "what_happened");
    expect(happened.predictionsRecorded).toBe(false);
    expect(happened.sentence).toBe("No predictions were recorded for this decision, and it has not settled yet.");
  });

  test("size — measured on the real record: over §20.1's 2 KB, reported as oversize, still written", () => {
    expect(tierARow.sizeBytes).toBeGreaterThan(BASELINE.tierASizeBytes); // the breakdowns cost bytes …
    expect(tierARow.sizeBytes).toBeLessThan(3200); // … inside the documented Phase 11 fence
    expect(written.oversize).toEqual([{ decisionId: tierARow.decisionId, bytes: tierARow.sizeBytes, limitBytes: 2048 }]);
    expect(written.tierACount).toBe(1);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   2. R1 — reconciliation, or an explicit reason
   ═══════════════════════════════════════════════════════════════════════════ */

describe("P7-D5 D4 — costTermsFrom reconciles exactly or records why not", () => {
  // γ = (Φc − Φb) + churn = (1000 − 300) + 50 = 750, with per-term maps that sum to Φc and Φb.
  const breakdown = () => ({
    phiCandidateMilliCU: "1000",
    phiBaseMilliCU: "300",
    churnMilliCU: "50",
    gammaMilliCU: "750",
    candidateTerms: { C_direct: "600", C_delay: "400" },
    baseTerms: { C_direct: "300" },
  });

  test("per-term candidate − base, plus churn, summing exactly to γ", () => {
    const { terms, reason } = costTermsFrom(breakdown(), 750n);
    expect(reason).toBeNull();
    expect(terms).toEqual({ C_delay: 400n, C_direct: 300n, C_churn: 50n });
    expect(Object.values(terms).reduce((a, b) => a + b, 0n)).toBe(750n);
  });

  test("bigint inputs (the round's own values) work the same as the JSON-safe strings", () => {
    const raw = { ...breakdown(), gammaMilliCU: 750n, churnMilliCU: 50n, candidateTerms: { C_direct: 600n, C_delay: 400n }, baseTerms: { C_direct: 300n } };
    expect(costTermsFrom(raw, null).terms).toEqual({ C_delay: 400n, C_direct: 300n, C_churn: 50n });
  });

  test.each([
    ["a term that does not add up", (b) => ({ ...b, candidateTerms: { ...b.candidateTerms, C_delay: "401" } }), COST_TOTALS_NOT_RECORDED.DOES_NOT_RECONCILE],
    ["a γ that disagrees with its terms", (b) => ({ ...b, gammaMilliCU: "751" }), COST_TOTALS_NOT_RECORDED.DOES_NOT_RECONCILE],
    ["a fractional value", (b) => ({ ...b, baseTerms: { C_direct: "300.5" } }), COST_TOTALS_NOT_RECORDED.BREAKDOWN_INCOMPLETE],
    ["no churn", (b) => ({ ...b, churnMilliCU: null }), COST_TOTALS_NOT_RECORDED.BREAKDOWN_INCOMPLETE],
    ["no candidate terms", (b) => ({ ...b, candidateTerms: null }), COST_TOTALS_NOT_RECORDED.BREAKDOWN_INCOMPLETE],
    ["a missing base map over a non-zero base Φ", (b) => ({ ...b, baseTerms: null }), COST_TOTALS_NOT_RECORDED.BREAKDOWN_INCOMPLETE],
    ["churn already among the terms (would count twice)", (b) => ({ ...b, candidateTerms: { ...b.candidateTerms, C_churn: "0" } }), COST_TOTALS_NOT_RECORDED.BREAKDOWN_INCOMPLETE],
  ])("%s → no map, reason recorded, nothing normalised", (label, edit, reason) => {
    expect(costTermsFrom(edit(breakdown()), null)).toEqual({ terms: null, reason });
  });

  test("the record's stated γ must agree with the breakdown's", () => {
    expect(costTermsFrom(breakdown(), 749n)).toEqual({ terms: null, reason: COST_TOTALS_NOT_RECORDED.DOES_NOT_RECONCILE });
  });

  test("a missing base map is exact only when the base Φ is zero", () => {
    const zeroBase = { ...breakdown(), phiBaseMilliCU: "0", baseTerms: null, gammaMilliCU: "1050" };
    expect(costTermsFrom(zeroBase, null)).toEqual({ terms: { C_delay: 400n, C_direct: 600n, C_churn: 50n }, reason: null });
  });

  test("no breakdown at all → NO_BREAKDOWN", () => {
    expect(costTermsFrom(null, null)).toEqual({ terms: null, reason: COST_TOTALS_NOT_RECORDED.NO_BREAKDOWN });
  });
});

describe("P7-D5 D4 — costTotalsFrom picks the runner-up the record picks, and names absences", () => {
  const breakdown = (gamma) => ({ phiCandidateMilliCU: String(gamma), phiBaseMilliCU: "0", churnMilliCU: "0", gammaMilliCU: String(gamma), candidateTerms: { C_direct: String(gamma) }, baseTerms: {} });
  const candidates = [
    { agentId: "B", rejected: false, gammaMilliCU: 200n },
    { agentId: "A", rejected: false, gammaMilliCU: 100n },
    { agentId: "C", rejected: false, gammaMilliCU: 300n },
    { agentId: "X", rejected: true, bindingPredicateId: "F7", gammaMilliCU: null },
  ];
  const tierBCandidates = ["A", "B", "C"].map((agentId) => ({ agentId, breakdown: breakdown({ A: 100, B: 200, C: 300 }[agentId]) }));

  test("chosen A, runner-up B — the same runner-up as tierA.compactTopN", () => {
    const totals = costTotalsFrom({ candidates, tierBCandidates, chosenAgentId: "A", compactTopN: 5 });
    expect(totals).toEqual({ chosen: { C_direct: 100n, C_churn: 0n }, runnerUp: { C_direct: 200n, C_churn: 0n }, notRecorded: { chosen: null, runnerUp: null } });
    expect(tierA.compactTopN({ candidates, chosenAgentId: "A", topN: 5 }).runnerUp.agentId).toBe("B");
  });

  test("no agent chosen → chosen NO_CHOSEN_AGENT (the cheapest is still a runner-up, as in the record)", () => {
    const totals = costTotalsFrom({ candidates, tierBCandidates, chosenAgentId: null });
    expect(totals.chosen).toBeNull();
    expect(totals.notRecorded.chosen).toBe(COST_TOTALS_NOT_RECORDED.NO_CHOSEN_AGENT);
  });

  test("a single priced candidate → runner-up NO_RUNNER_UP", () => {
    const totals = costTotalsFrom({ candidates: [candidates[1]], tierBCandidates, chosenAgentId: "A" });
    expect(totals).toMatchObject({ runnerUp: null, notRecorded: { chosen: null, runnerUp: COST_TOTALS_NOT_RECORDED.NO_RUNNER_UP } });
  });

  test("a chosen agent with no breakdown in the evidence → NO_BREAKDOWN", () => {
    expect(costTotalsFrom({ candidates, tierBCandidates: [], chosenAgentId: "A" }).notRecorded.chosen).toBe(COST_TOTALS_NOT_RECORDED.NO_BREAKDOWN);
  });

  test("the adapter derives costTotals only when there is a Tier B input — otherwise it is as before", () => {
    const round = { roundId: "r", decisionTimeMs: 1, decisions: [] };
    const decision = { legId: "L", outcome: "ASSIGNED", agentId: "A" };
    const without = decisionRecord.tierAInputFor({ round, decision, context: { candidates } });
    expect(without.costTotals).toBeNull();
    const supplied = { chosen: { C_direct: 1n }, runnerUp: null };
    expect(decisionRecord.tierAInputFor({ round, decision, context: { candidates, costTotals: supplied, tierBInput: { candidates: tierBCandidates } } }).costTotals).toBe(supplied);
    expect(decisionRecord.tierAInputFor({ round, decision, context: { candidates, tierBInput: { candidates: tierBCandidates } } }).costTotals.notRecorded).toEqual({ chosen: null, runnerUp: null });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   3. R2 — the Explanation API never turns "not recorded" into a number
   ═══════════════════════════════════════════════════════════════════════════ */

describe("P7-D5 D4 — explanation answers when evidence is absent", () => {
  /** A Tier A record with the given cost section and predictions; everything else minimal. */
  function recordWith({ costTotals, predictions = null, agentId = "A" }) {
    return tierA.build({
      identity: { decisionId: "d1", roundId: "r1", shardId: "s1", decisionTimeMs: 1 },
      outcome: { outcome: agentId ? "ASSIGNED" : "NO_FEASIBLE_CANDIDATE", agentId },
      candidates: [
        { agentId: "A", rejected: false, gammaMilliCU: 100n },
        { agentId: "B", rejected: false, gammaMilliCU: 140n },
      ],
      costTotals,
      predictions,
    });
  }
  const explain = (record, extra) => explanation.explain({ row: tierA.toRow(record, {}), ...(extra || {}) });

  test.each([
    ["a legacy record (both sides null, no reason)", null, null, "The cost breakdown was not recorded for this decision."],
    ["a reconciliation failure", { chosen: null, runnerUp: null, notRecorded: { chosen: "DOES_NOT_RECONCILE", runnerUp: null } }, "DOES_NOT_RECONCILE", "The cost breakdown was not recorded for this decision."],
    ["an empty term map", { chosen: {}, runnerUp: {} }, null, "The cost breakdown was not recorded for this decision."],
  ])("what_did_it_cost on %s → recorded:false, total null, never '0 CU'", (label, costTotals, reason, sentence) => {
    const result = explain(recordWith({ costTotals }));
    const cost = answer(result, "what_did_it_cost");
    expect(cost).toMatchObject({ recorded: false, notRecordedReason: reason, terms: [], totalMilliCU: null, totalCU: null, totalCurrency: null, sentence });
    expect(cost.sentence).not.toMatch(/0 CU/);
    expect(answer(result, "why_this_agent")).toMatchObject({ costBreakdown: null, costBreakdownRecorded: false, decisiveTerms: null });
    // The margin still comes from the top-N, which WAS recorded.
    expect(answer(result, "why_this_agent").marginMilliCU).toBe("40"); // γ 140 − 100 milli-CU
    expect(answer(result, "what_would_change_it")).toMatchObject({ costLevers: [], costLeversRecorded: false });
  });

  test("no agent chosen → said plainly, not as 'not recorded'", () => {
    const record = recordWith({ agentId: null, costTotals: { chosen: null, runnerUp: null, notRecorded: { chosen: "NO_CHOSEN_AGENT", runnerUp: "NO_RUNNER_UP" } } });
    expect(answer(explain(record), "what_did_it_cost")).toMatchObject({
      recorded: false,
      notRecordedReason: "NO_CHOSEN_AGENT",
      totalMilliCU: null,
      sentence: "No agent was chosen, so this decision priced no assignment.",
    });
  });

  test("a recorded chosen side with an unrecorded runner-up: breakdown stated, decisive terms null (cannot be judged)", () => {
    const record = recordWith({ costTotals: { chosen: { C_direct: 100n }, runnerUp: null, notRecorded: { chosen: null, runnerUp: "NO_BREAKDOWN" } } });
    const why = answer(explain(record), "why_this_agent");
    expect(why).toMatchObject({ costBreakdown: { C_direct: "100" }, costBreakdownRecorded: true, decisiveTerms: null });
    expect(answer(explain(record), "what_did_it_cost")).toMatchObject({ recorded: true, totalMilliCU: "100" });
  });

  test("existing callers that supply costTotals are answered as before", () => {
    const record = recordWith({ costTotals: { chosen: { cDirect: 100000n }, runnerUp: { cDirect: 140000n } } });
    const cost = answer(explain(record), "what_did_it_cost");
    expect(cost).toMatchObject({ recorded: true, totalMilliCU: "100000", sentence: "This decision was priced at 100 CU across 1 term(s)." });
    expect(answer(explain(record), "why_this_agent").decisiveTerms).toEqual([{ term: "cDirect", advantageMilliCU: "40000", advantageCU: 40 }]);
  });

  test.each([
    [null, null, false, false, "No predictions were recorded for this decision, and it has not settled yet."],
    [null, { TRAVEL_TIME: 310 }, true, false, "The decision has settled; no predictions were recorded for it, so there is nothing to compare."],
    [{ TRAVEL_TIME: 300 }, null, false, true, "This decision has not settled yet, so only the predictions are available."],
    [{ TRAVEL_TIME: 300 }, { TRAVEL_TIME: 310 }, true, true, "TRAVEL_TIME: predicted 300, realised 310 (+10)"],
  ])("what_happened: predictions %j, settlement %j", (predictions, settlement, settled, recorded, sentence) => {
    const happened = answer(explain(recordWith({ costTotals: null, predictions }), { settlement }), "what_happened");
    expect(happened).toMatchObject({ settled, predictionsRecorded: recorded, sentence });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   4. R3 — "not recorded" (null) versus "none" ([]), and backward compatibility
   ═══════════════════════════════════════════════════════════════════════════ */

describe("P7-D5 D4 — tierA keeps an explicit null and defaults an omitted list to []", () => {
  const base = { identity: { decisionId: "d", decisionTimeMs: 1 } };

  test("omitted sections keep the [] every existing caller relies on", () => {
    const record = tierA.build(base);
    expect(record.degradation).toMatchObject({ dependencies: [], envelopeReductions: [], relaxations: [], shardModes: [] });
    expect(record.overrides).toEqual([]);
    expect(record.costTotals).toEqual({ chosen: null, runnerUp: null, unit: "milli-CU" }); // no notRecorded key
  });

  test("explicit null is preserved; explicit [] is preserved", () => {
    const unknown = tierA.build({ ...base, degradation: { dependencies: null, envelopeReductions: null, relaxations: null, shardModes: null, killSwitches: { deferral: false } }, overrides: null });
    expect(unknown.degradation).toEqual({ dependencies: null, envelopeReductions: null, relaxations: null, shardModes: null, killSwitches: { deferral: false } });
    expect(unknown.overrides).toBeNull();
    const none = tierA.build({ ...base, degradation: { dependencies: [], relaxations: [] }, overrides: [] });
    expect(none.degradation).toMatchObject({ dependencies: [], relaxations: [], envelopeReductions: [], shardModes: [] });
    expect(none.overrides).toEqual([]);
  });

  test("fromRow reads a stored null back as null, and a row without the field as []", () => {
    expect(tierA.fromRow({ decisionId: "d", overrides: null }).overrides).toBeNull();
    expect(tierA.fromRow({ decisionId: "d" }).overrides).toEqual([]);
    expect(tierA.fromRow({ decisionId: "d", overrides: [] }).overrides).toEqual([]);
  });

  test("the production adapter records a producer's lists as given, and null when there is none", () => {
    const round = { roundId: "r", decisionTimeMs: 1, decisions: [] };
    const decision = { legId: "L", outcome: "NO_FEASIBLE_CANDIDATE" };
    const none = decisionRecord.tierAInputFor({ round, decision, context: {} });
    expect(none.degradation).toMatchObject({ dependencies: null, envelopeReductions: null, relaxations: null, shardModes: null });
    expect(none.overrides).toBeNull();
    const given = decisionRecord.tierAInputFor({ round, decision, context: { degradation: { dependencies: [], relaxations: [{ id: "r1" }] }, overrides: [] } });
    expect(given.degradation).toMatchObject({ dependencies: [], relaxations: [{ id: "r1" }], envelopeReductions: null, shardModes: null });
    expect(given.overrides).toEqual([]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   5. The §20.1 size setting, now mapped
   ═══════════════════════════════════════════════════════════════════════════ */

describe("P7-D5 D4 — perf.tier_a_record_bytes reaches the writer", () => {
  test("mapped by name, default 2048, and a published value is honoured", () => {
    expect(coordinator.OBSERVABILITY_PARAMETERS.tierARecordBytes).toBe("perf.tier_a_record_bytes");
    expect(coordinator.observabilityFrom(configService.buildSnapshot({ version: 7 })).tierARecordBytes).toBe(2048);
    const published = configService.buildSnapshot({ version: 8, bindings: [{ level: "global", key: "", name: "perf.tier_a_record_bytes", value: 4096 }] });
    expect(coordinator.observabilityFrom(published).tierARecordBytes).toBe(4096);
  });

  async function writeOne(tierARecordBytes) {
    const prisma = fixture.memoryPrisma();
    const round = {
      roundId: "default:1", shardId: "default", decisionTimeMs: 1, regime: "SINGLETON",
      columns: { generated: 0, kept: 0, pruned: 0, bestPrunedGammaMilliCU: null },
      budgets: { budgetLimited: false, exceeded: [] }, lpIpGapMilliCU: 0n, committed: [],
      decisions: [{ legId: "L1", outcome: "NO_FEASIBLE_CANDIDATE" }],
    };
    const result = await decisionRecord.writeRound(
      { prisma },
      {
        round,
        context: { shardId: "default", snapshot: { snapshotId: round.roundId, pins: null, seed: "00" }, perLeg: { L1: { candidates: [] } } },
        budget: sampling.createBudget({}),
        config: { sampleRate: 0, fullRetentionDays: 30, tierBRetentionDays: 30, snapshotRetentionDays: 30, ...(tierARecordBytes === undefined ? {} : { tierARecordBytes }) },
        nowMs: 1,
      },
    );
    return { result, row: prisma.__tables.decisionRecords[0] };
  }

  test("a record over the limit is reported in `oversize` and still written; under it, not reported", async () => {
    const small = await writeOne(100);
    expect(small.result.oversize).toEqual([{ decisionId: small.row.decisionId, bytes: small.row.sizeBytes, limitBytes: 100 }]);
    expect(small.result.tierACount).toBe(1);
    const roomy = await writeOne(2048);
    expect(roomy.row.sizeBytes).toBeLessThan(2048);
    expect(roomy.result.oversize).toEqual([]);
  });

  test("with no limit supplied (the pre-D4 production state) nothing is reported, exactly as before", async () => {
    const { result, row } = await writeOne(undefined);
    expect(result.oversize).toEqual([]);
    expect(row.sizeBytes).toBeGreaterThan(0); // the size is still measured on every row
  });
});
