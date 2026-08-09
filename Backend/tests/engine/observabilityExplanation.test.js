"use strict";

/**
 * Engine lane — Phase 11: the Explanation API's answers (§21.3), tenet T8.
 *
 * §21.3's table has **eight** rows. The execution plan's checklist says seven, omitting
 * *"why did this task go to a distant agent?"*; `IMPLEMENTATION_EXECUTION_PLAN.md` §0.1
 * settles it — the specification wins — so all eight are implemented and tested.
 *
 * Every answer must name its source. §21.3 is explicit that a `RECONSTRUCTED` answer
 * "is byte-identical to the Tier B record that would have been written, by T6, and the
 * API states so alongside the result rather than presenting recomputation as though it
 * were retrieval". That is a requirement about honesty, and it is tested as one.
 */

const explanation = require("../../src/engine/observability/explanation");
const tierA = require("../../src/engine/observability/tierA");
const tierB = require("../../src/engine/observability/tierB");

const MILLI = (cu) => BigInt(cu) * 1000n;

const record = tierA.build({
  identity: { decisionId: "shard-a:1770000000000:LEG-1", roundId: "shard-a:1770000000000", shardId: "shard-a", decisionTimeMs: 1770000000000 },
  versions: {},
  trigger: "NEW_ARRIVAL",
  inputSnapshotRefs: { snapshotId: "s1" },
  leg: { legId: "LEG-1", purpose: "PRIMARY", queueAgeSeconds: 420, ladderStep: 3 },
  outcome: { outcome: "ASSIGNED", agentId: "AGT-002", columnIdentity: "col" },
  candidates: [
    { agentId: "AGT-001", gammaMilliCU: MILLI(140), discoveryTier: 0, rejected: false },
    { agentId: "AGT-002", gammaMilliCU: MILLI(100), discoveryTier: 2, rejected: false },
    { agentId: "AGT-003", gammaMilliCU: MILLI(180), discoveryTier: 1, rejected: false },
    { agentId: "AGT-009", lowerBoundMilliCU: MILLI(10), discoveryTier: 0, rejected: true, bindingPredicateId: "F34" },
  ],
  costTotals: {
    chosen: { cDirect: MILLI(70), cRisk: MILLI(20), cLifecycle: MILLI(10) },
    runnerUp: { cDirect: MILLI(110), cRisk: MILLI(20), cLifecycle: MILLI(10) },
  },
  rejectionSummary: [
    { predicateId: "F34", tier: "T2", count: 18 },
    { predicateId: "F22", tier: null, count: 6 },
  ],
  searchAndSolveBounds: { cellsExplored: 30, agentsEvaluated: 4, regime: "SINGLETON" },
  degradation: {},
  deferral: null,
  overrides: [],
  predictions: { TRAVEL_TIME: 300, ENERGY: 120 },
  compactTopN: 5,
});

const row = { ...tierA.toRow(record, {}), decisionTime: new Date(record.identity.decisionTimeMs) };

describe("§21.3 — eight queries, each naming its source", () => {
  test("all eight are implemented", () => {
    expect(explanation.assertCoverage()).toEqual({ ok: true, problems: [], queries: 8 });
    expect(explanation.QUERIES).toEqual([
      "why_this_agent",
      "why_not_agent",
      "why_still_waiting",
      "why_deferred",
      "why_distant_agent",
      "what_would_change_it",
      "what_did_it_cost",
      "what_happened",
    ]);
  });

  test("every answer carries a source, and no answer can be built without one", () => {
    const { answers } = explanation.explain({ row, agentId: "AGT-001" });
    expect(answers).toHaveLength(8);
    for (const answer of answers) {
      expect(Object.values(explanation.SOURCE)).toContain(answer.source);
    }
    expect(() => explanation.answerOf("q", "MADE_UP", {})).toThrow(/must name their source/);
  });

  test("a RECONSTRUCTED answer says so rather than presenting recomputation as retrieval", () => {
    const [answer] = explanation.explain({ row, query: explanation.QUERY.WHAT_WOULD_CHANGE_IT }).answers;
    expect(answer.source).toBe(explanation.SOURCE.RECONSTRUCTED);
    expect(answer.reconstructed).toBe(true);
    expect(answer.reconstructionNote).toMatch(/byte-identical/);
  });

  test("a TIER_A answer carries no reconstruction note", () => {
    const [answer] = explanation.explain({ row, query: explanation.QUERY.WHY_THIS_AGENT }).answers;
    expect(answer.source).toBe(explanation.SOURCE.TIER_A);
    expect(answer.reconstructionNote).toBeNull();
  });
});

describe("§21.3 — the five questions answered from Tier A with no reconstruction", () => {
  test("why this agent: the breakdown, the runner-up, the margin, and which terms were decisive", () => {
    const [answer] = explanation.explain({ row, query: explanation.QUERY.WHY_THIS_AGENT }).answers;
    expect(answer.chosenAgentId).toBe("AGT-002");
    expect(answer.runnerUp.agentId).toBe("AGT-001");
    expect(answer.marginMilliCU).toBe("40000");
    // A term is decisive when the chosen candidate's advantage on it is at least the
    // winning margin — removing that advantage alone would flip the decision.
    expect(answer.decisiveTerms.map((row_) => row_.term)).toEqual(["cDirect"]);
    expect(answer.sentence).toMatch(/AGT-002 was chosen over AGT-001 by 40 CU, decided by cDirect/);
  });

  test("why is this task still waiting: the histogram, exact over 100 % of decisions", () => {
    const [answer] = explanation.explain({ row, query: explanation.QUERY.WHY_STILL_WAITING }).answers;
    expect(answer.source).toBe(explanation.SOURCE.TIER_A);
    // §7.7's aggregation happens at decision time, before Tier B sampling, so the
    // histogram is exact even for a decision whose Tier B was never written.
    expect(answer.exactOverAllDecisions).toBe(true);
    expect(answer.bindingConstraint).toMatchObject({ predicateId: "F34", tier: "T2", count: 18 });
    expect(answer.rejectionHistogram[0].share).toBeCloseTo(18 / 24);
    expect(answer.ladderStep).toBe(3);
    expect(answer.queueAgeSeconds).toBe(420);
    expect(answer.sentence).toMatch(/75 % of rejections were F34 \(tier T2\)/);
  });

  test("why was this deferred while a robot sat idle: §8.8's record, as one sentence", () => {
    const deferred = tierA.build({
      identity: { decisionId: "d", decisionTimeMs: 0 },
      versions: {},
      leg: {},
      outcome: { outcome: "DEFERRED" },
      searchAndSolveBounds: {},
      deferral: {
        reason: "SUPPLY_EXPECTED",
        supplyEventAwaited: "an agent 600 m away is projected free in 90 s",
        expectedImprovementMilliCU: "3200000",
        deferralDeadlineMs: 1770000600000,
      },
    });
    const [answer] = explanation.explain({
      row: { ...tierA.toRow(deferred, {}), decisionTime: new Date(0) },
      query: explanation.QUERY.WHY_DEFERRED,
    }).answers;

    expect(answer.source).toBe(explanation.SOURCE.TIER_A);
    expect(answer.deferred).toBe(true);
    expect(answer.expectedImprovementCU).toBe(3200);
    // §8.8 wants it "rendered as one sentence for the operator console".
    expect(answer.sentence).toMatch(/waiting — an agent 600 m away is projected free in 90 s; assigning now would cost 3200 CU more/);
  });

  test("a null deferral section means no deferral was taken, not a deferral without a reason", () => {
    const [answer] = explanation.explain({ row, query: explanation.QUERY.WHY_DEFERRED }).answers;
    expect(answer.deferred).toBe(false);
    expect(answer.note).toMatch(/not a deferral without a reason/);
  });

  test("what did this decision cost: the CU breakdown and its currency equivalent", () => {
    const [answer] = explanation.explain({ row, query: explanation.QUERY.WHAT_DID_IT_COST, cuPerCurrencyUnit: 10 }).answers;
    expect(answer.totalMilliCU).toBe("100000");
    expect(answer.totalCU).toBe(100);
    // §1.3's exchange rate applied only at the presentation boundary — the stored
    // quantity stays in CU, because the rate changes and the record must not.
    expect(answer.totalCurrency).toBe(10);
    expect(answer.terms.map((term) => term.term)).toEqual(["cDirect", "cLifecycle", "cRisk"]);
  });

  test("what actually happened: realised versus predicted, with signed deltas", () => {
    const [answer] = explanation.explain({ row, query: explanation.QUERY.WHAT_HAPPENED, settlement: { TRAVEL_TIME: 360, ENERGY: 100 } }).answers;
    expect(answer.settled).toBe(true);
    expect(answer.deltas).toEqual([
      { quantity: "ENERGY", predicted: 120, realised: 100, signedError: -20 },
      { quantity: "TRAVEL_TIME", predicted: 300, realised: 360, signedError: 60 },
    ]);
  });

  test("an unsettled decision says so rather than inventing an outcome", () => {
    const [answer] = explanation.explain({ row, query: explanation.QUERY.WHAT_HAPPENED }).answers;
    expect(answer.settled).toBe(false);
    expect(answer.sentence).toMatch(/has not settled yet/);
  });
});

describe("§21.3 — why not agent X, and the top-N boundary", () => {
  test("an agent in the top-N is answered from Tier A", () => {
    const [answer] = explanation.explain({ row, query: explanation.QUERY.WHY_NOT_AGENT, agentId: "AGT-001" }).answers;
    expect(answer.source).toBe(explanation.SOURCE.TIER_A);
    expect(answer.inTopN).toBe(true);
    expect(answer.deltaFromChosenMilliCU).toBe("40000");
  });

  test("a rejected agent in the top-N is answered with its binding predicate", () => {
    const [answer] = explanation.explain({ row, query: explanation.QUERY.WHY_NOT_AGENT, agentId: "AGT-009" }).answers;
    expect(answer.rejected).toBe(true);
    expect(answer.bindingPredicateId).toBe("F34");
    expect(answer.sentence).toMatch(/AGT-009 was rejected by F34/);
  });

  test("an agent outside the top-N is answered from Tier B when one was written", () => {
    const full = tierB.build({
      decisionId: "shard-a:1770000000000:LEG-1",
      decisionTimeMs: 0,
      candidates: [
        {
          agentId: "AGT-050",
          discoveryTier: 4,
          rejected: true,
          bindingPredicateId: "F22",
          predicateResults: [
            { predicateId: "F22", outcome: "FAIL", observed: 3, required: 5, inputSource: "CAPABILITY", observationAgeMs: 10, indeterminatePolicy: "DENY" },
          ],
        },
      ],
    });

    const [answer] = explanation.explain({ row, tierBRow: full, query: explanation.QUERY.WHY_NOT_AGENT, agentId: "AGT-050" }).answers;
    expect(answer.source).toBe(explanation.SOURCE.TIER_B);
    expect(answer.inTopN).toBe(false);
    // §7.7's full evaluation tuple for this one agent.
    expect(answer.predicates[0]).toMatchObject({ predicateId: "F22", observed: 3, required: 5, inputSource: "CAPABILITY" });
  });

  test("the same answer from a reconstruction is labelled RECONSTRUCTED, not TIER_B", () => {
    const reconstructed = tierB.build({ decisionId: "d", decisionTimeMs: 0, candidates: [{ agentId: "AGT-050", rejected: true, bindingPredicateId: "F22", predicateResults: [] }] });
    const [answer] = explanation.explain({ row, reconstructed, query: explanation.QUERY.WHY_NOT_AGENT, agentId: "AGT-050" }).answers;
    expect(answer.source).toBe(explanation.SOURCE.RECONSTRUCTED);
  });

  test("with neither, the answer says the full one needs a replay rather than guessing", () => {
    const [answer] = explanation.explain({ row, query: explanation.QUERY.WHY_NOT_AGENT, agentId: "AGT-050" }).answers;
    expect(answer.unavailable).toBe(true);
    expect(answer.sentence).toMatch(/available by reconstruction/);
  });

  test("the query refuses to run without an agent id", () => {
    expect(() => explanation.explain({ row, query: explanation.QUERY.WHY_NOT_AGENT })).toThrow(/needs an agent id/);
  });
});

describe("§21.3 — why did this go to a distant agent", () => {
  test("names the nearer candidates and why each lost", () => {
    const [answer] = explanation.explain({ row, query: explanation.QUERY.WHY_DISTANT_AGENT }).answers;
    // Nearness is the expansion tier the candidate was discovered at (§6.3): tier 0 is
    // the origin cell. The chosen agent was found at tier 2; two candidates were nearer.
    expect(answer.chosenDiscoveryTier).toBe(2);
    expect(answer.nearerCandidates.map((entry) => entry.agentId).sort()).toEqual(["AGT-001", "AGT-003", "AGT-009"]);
    expect(answer.sentence).toMatch(/AGT-009 rejected by F34/);
  });
});

describe("§21.3 — sensitivity is exact, because the objective is a transparent sum", () => {
  test("reports the flip margin against every term the decision carried", () => {
    const [answer] = explanation.explain({ row, query: explanation.QUERY.WHAT_WOULD_CHANGE_IT }).answers;
    expect(answer.exact).toBe(true);
    expect(answer.marginMilliCU).toBe("40000");
    for (const lever of answer.costLevers) {
      // For an additive objective, ANY single term rising by the margin flips it. No
      // search, no perturbation, no local linearisation.
      expect(lever.flipsIfIncreasedByMilliCU).toBe("40000");
      expect(lever.flipsIfIncreasedByCU).toBe(40);
    }
    expect(answer.costLevers.map((lever) => lever.term)).toEqual(["cDirect", "cLifecycle", "cRisk"]);
    expect(answer.why).toMatch(/transparent optimiser over an opaque learned policy/);
  });

  test("a rejected candidate's lever is its predicate, never a price", () => {
    const [answer] = explanation.explain({ row, query: explanation.QUERY.WHAT_WOULD_CHANGE_IT }).answers;
    // Reporting a cost sensitivity for a candidate the gate never admitted would be
    // arithmetic about an ineligible pairing (T1, I14).
    expect(answer.feasibilityLevers).toEqual([
      { agentId: "AGT-009", lever: "FEASIBILITY", bindingPredicateId: "F34", note: expect.stringMatching(/not priced/) },
    ]);
  });

  test("the relative change required is stated where the current value is non-zero", () => {
    const [answer] = explanation.explain({ row, query: explanation.QUERY.WHAT_WOULD_CHANGE_IT }).answers;
    const direct = answer.costLevers.find((lever) => lever.term === "cDirect");
    expect(direct.relativeChangeRequired).toBeCloseTo(40000 / 70000);
  });
});
