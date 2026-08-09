"use strict";

/**
 * §9.2's round cadence, §9.3's regime guarantees, and §9.4's five bounds with anytime
 * behaviour — the three modules that decide *when* a round runs, *what it may claim*, and
 * *when it must stop*.
 */

const cadence = require("../../src/engine/solve/cadence");
const regime = require("../../src/engine/solve/regime");
const budgets = require("../../src/engine/solve/budgets");
const fixture = require("./helpers/roundFixture");
const { toMilliCU } = require("../../src/engine/determinism/fixedPoint");

/* ═══════════════════════════════════════════════════════════════════════════
   §9.2 — round cadence
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§9.2 — the four cadence regimes", () => {
  const config = fixture.cadenceConfig();

  test("saturated: feasible supply is zero, so the round backs off", () => {
    const verdict = cadence.windowFor({ queueDepth: 50, feasibleSupply: 0, config });
    expect(verdict.regime).toBe(cadence.CADENCE.SATURATED);
    expect(verdict.windowMs).toBe(config.saturatedWindowMs);
    expect(verdict.rationale).toMatch(/Solving repeatedly against no supply is wasted work/);
  });

  test("fast path: an SLA class in solve.fast_path_classes is waiting", () => {
    const verdict = cadence.windowFor({
      queueDepth: 40,
      feasibleSupply: 5,
      slaClassesWaiting: ["standard", "critical"],
      config,
    });
    expect(verdict.regime).toBe(cadence.CADENCE.FAST_PATH);
    expect(verdict.windowMs).toBe(0);
    expect(verdict.maxLegsThisRound).toBe(1);
  });

  test("fast path: queue depth one with idle supply — nothing to trade against", () => {
    const verdict = cadence.windowFor({ queueDepth: 1, feasibleSupply: 3, config });
    expect(verdict.regime).toBe(cadence.CADENCE.FAST_PATH);
    expect(verdict.rationale).toMatch(/nothing to trade against/);
  });

  test("nominal: steady arrivals hold at solve.window_min", () => {
    const verdict = cadence.windowFor({ queueDepth: 5, feasibleSupply: 5, config });
    expect(verdict.regime).toBe(cadence.CADENCE.NOMINAL);
    expect(verdict.windowMs).toBe(config.windowMinMs);
  });

  test("loaded: past solve.batch_growth_threshold the window grows toward window_max", () => {
    const modest = cadence.windowFor({ queueDepth: 12, feasibleSupply: 5, config });
    const heavy = cadence.windowFor({ queueDepth: 30, feasibleSupply: 5, config });

    expect(modest.regime).toBe(cadence.CADENCE.LOADED);
    expect(modest.windowMs).toBeGreaterThan(config.windowMinMs);
    expect(heavy.windowMs).toBeGreaterThan(modest.windowMs);
    expect(heavy.windowMs).toBeLessThanOrEqual(config.windowMaxMs);
  });
});

describe("§9.2 — the two prose requirements the cadence table does not carry", () => {
  test("the window is bounded so it cannot consume a meaningful fraction of any SLA budget", () => {
    const config = fixture.cadenceConfig();
    // A 60 s assignment budget at a 5 % ceiling admits a 3 s window; the saturated
    // regime would otherwise take 10 s.
    const verdict = cadence.windowFor({
      queueDepth: 50,
      feasibleSupply: 0,
      slaBudgetsSeconds: [60],
      config,
    });

    expect(verdict.unboundedWindowMs).toBe(10000);
    expect(verdict.windowMs).toBe(3000);
    expect(verdict.slaBound.applied).toBe(true);
    expect(verdict.slaBound.tightestBudgetSeconds).toBe(60);
  });

  test("the TIGHTEST budget in the batch binds — 'any mission's SLA budget' admits no averaging", () => {
    const config = fixture.cadenceConfig();
    const verdict = cadence.windowFor({
      queueDepth: 50,
      feasibleSupply: 0,
      slaBudgetsSeconds: [3600, 3600, 3600, 20],
      config,
    });

    expect(verdict.slaBound.tightestBudgetSeconds).toBe(20);
    expect(verdict.windowMs).toBe(1000);
  });

  test("the window closes early when supply changes materially", () => {
    const verdict = cadence.shouldCloseEarly({
      openedAtMs: 1000,
      nowMs: 1200,
      windowMs: 3000,
      supplyAtOpen: 2,
      supplyNow: 3,
      legsCollected: 4,
      maxLegsThisRound: 500,
    });
    expect(verdict.close).toBe(true);
    expect(verdict.reason).toBe(cadence.EARLY_CLOSE.SUPPLY_CHANGED);
    expect(verdict.detail).toMatch(/new information worth acting on/);
  });

  test("the window closes early when the batch fills", () => {
    const verdict = cadence.shouldCloseEarly({
      openedAtMs: 0,
      nowMs: 10,
      windowMs: 3000,
      supplyAtOpen: 2,
      supplyNow: 2,
      legsCollected: 500,
      maxLegsThisRound: 500,
    });
    expect(verdict.close).toBe(true);
    expect(verdict.reason).toBe(cadence.EARLY_CLOSE.BATCH_FULL);
  });

  test("supply FALLING does not close the window — only new information does", () => {
    const verdict = cadence.shouldCloseEarly({
      openedAtMs: 0,
      nowMs: 10,
      windowMs: 3000,
      supplyAtOpen: 5,
      supplyNow: 2,
      legsCollected: 1,
      maxLegsThisRound: 500,
    });
    expect(verdict.close).toBe(false);
  });
});

describe("§9.2 BUILD GATE — the fast path is the batch path at |L| = 1", () => {
  // The plan's own words: "enforced by a build-time test, not by review".
  test("a fast-path verdict differs from any other in exactly two fields: window and cap", () => {
    const config = fixture.cadenceConfig();
    const fast = cadence.windowFor({ queueDepth: 1, feasibleSupply: 3, config });
    const nominal = cadence.windowFor({ queueDepth: 5, feasibleSupply: 5, config });

    expect(Object.keys(fast).sort()).toEqual(Object.keys(nominal).sort());
    expect(cadence.assertFastPathIsBatchPath(fast)).toEqual({ ok: true, problems: [] });
  });

  test("the assertion fails if a fast-path verdict ever grows a field of its own", () => {
    const contaminated = {
      regime: cadence.CADENCE.FAST_PATH,
      windowMs: 0,
      unboundedWindowMs: 0,
      maxLegsThisRound: 1,
      rationale: "",
      slaBound: {},
      inputs: {},
      useGreedySolver: true,
    };
    const verdict = cadence.assertFastPathIsBatchPath(contaminated);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems[0]).toMatch(/forbids a parallel implementation/);
  });

  test("the assertion fails if the fast path ever caps the batch above one Leg", () => {
    const verdict = cadence.assertFastPathIsBatchPath({
      regime: cadence.CADENCE.FAST_PATH,
      windowMs: 0,
      unboundedWindowMs: 0,
      maxLegsThisRound: 2,
      rationale: "",
      slaBound: {},
      inputs: {},
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems[0]).toMatch(/batch path at \|L\| = 1/);
  });

  test("the source contains no branch on the fast-path regime outside cadence.js itself", () => {
    const fs = require("fs");
    const path = require("path");
    const solveRoot = path.resolve(__dirname, "..", "..", "src", "engine", "solve");
    const offenders = [];
    for (const name of fs.readdirSync(solveRoot)) {
      if (!name.endsWith(".js") || name === "cadence.js") continue;
      const source = fs.readFileSync(path.join(solveRoot, name), "utf8");
      if (/FAST_PATH/.test(source)) offenders.push(name);
    }
    // §9.2 forbids "a parallel implementation that shares some code". Nothing downstream
    // of the cadence decision may know which regime produced the window it was given.
    expect(offenders).toEqual([]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §9.3 — the regime and its guarantees
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§9.3 — the regime is a property of the generated column set", () => {
  test("every column covering one Leg ⇒ SINGLETON, and it is entitled to the four claims", () => {
    const columns = [
      fixture.column({ legId: "L1", agentId: "A1", gammaCu: 1 }),
      fixture.column({ legId: "L2", agentId: "A2", gammaCu: 2 }),
    ];
    const determined = regime.determine(columns);

    expect(determined.regime).toBe(regime.REGIME.SINGLETON);
    expect(determined.why).toMatch(/totally unimodular/);
    for (const claim of Object.values(regime.CLAIM)) {
      expect(regime.entitledTo(regime.REGIME.SINGLETON, claim).entitled).toBe(true);
    }
  });

  test("one multi-Leg column ⇒ COLUMN, and it is entitled to NONE of the four", () => {
    const columns = [
      fixture.column({ legId: "L1", agentId: "A1", gammaCu: 1 }),
      fixture.column({ legIds: ["L2", "L3"], agentId: "A2", gammaCu: 2 }),
    ];
    const determined = regime.determine(columns);

    expect(determined.regime).toBe(regime.REGIME.COLUMN);
    expect(determined.multiLegCount).toBe(1);
    expect(determined.maxLegsPerColumn).toBe(2);
    for (const claim of Object.values(regime.CLAIM)) {
      expect(regime.entitledTo(regime.REGIME.COLUMN, claim).entitled).toBe(false);
    }
  });

  test("REGIME GUARANTEE TEST (§24.1) — a multi-Leg round MUST NOT report exact-integer duals", () => {
    expect(() => regime.assertClaim(regime.REGIME.COLUMN, regime.CLAIM.EXACT_INTEGER_DUALS)).toThrow(
      /never asserts a guarantee it is not in the regime for/,
    );
    expect(() => regime.assertClaim(regime.REGIME.SINGLETON, regime.CLAIM.EXACT_INTEGER_DUALS)).not.toThrow();
  });

  test("duals are labelled with what they are, so a consumer cannot mistake one for the other", () => {
    const exact = regime.dualsFor(regime.REGIME.SINGLETON, { L1: toMilliCU(5) });
    const relaxed = regime.dualsFor(regime.REGIME.COLUMN, { L1: toMilliCU(5) });

    expect(exact.kind).toBe(regime.DUAL_KIND.EXACT_INTEGER);
    expect(exact.validForCalibrationWithoutQualification).toBe(true);
    expect(relaxed.kind).toBe(regime.DUAL_KIND.RELAXATION);
    expect(relaxed.validForCalibrationWithoutQualification).toBe(false);
    expect(relaxed.validity).toMatch(/§8.3.1 requires them to be recorded as such/);
  });

  test("no solver is registered for the column regime in this phase, and it says so", () => {
    expect(regime.solverAvailable(regime.REGIME.SINGLETON).solvable).toBe(true);
    const unavailable = regime.solverAvailable(regime.REGIME.COLUMN);
    expect(unavailable.solvable).toBe(false);
    expect(unavailable.reason).toMatch(/rather than solving it as though it were singleton/);
  });

  test("an unrecognised regime is refused — a round claiming one could claim any guarantee", () => {
    expect(() => regime.guaranteesFor("MAGIC")).toThrow(/is not a solve regime/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §9.4 — solve size control
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§9.4 — all five bounds, each with the behaviour the specification names", () => {
  test("legs per round", () => {
    const tracker = budgets.create({ config: fixture.budgetConfig({ maxLegsPerRound: 2 }) });
    expect(tracker.admitLeg(0).ok).toBe(true);
    expect(tracker.admitLeg(1).ok).toBe(true);
    const third = tracker.admitLeg(2);
    expect(third.ok).toBe(false);
    expect(third.verdict.behaviour).toBe("Spatially partition the batch and solve sub-problems independently");
  });

  test("candidates per Leg, counted per Leg rather than per round", () => {
    const tracker = budgets.create({ config: fixture.budgetConfig({ maxEvaluatedPerLeg: 2 }) });
    expect(tracker.evaluateCandidate("L1").ok).toBe(true);
    expect(tracker.evaluateCandidate("L1").ok).toBe(true);
    expect(tracker.evaluateCandidate("L1").ok).toBe(false);
    // A different Leg has its own budget.
    expect(tracker.evaluateCandidate("L2").ok).toBe(true);
  });

  test("columns per round records the best pruned column's bound", () => {
    const tracker = budgets.create({ config: fixture.budgetConfig({ maxColumnsPerRound: 2 }) });
    const verdict = tracker.admitColumns(5, 2, toMilliCU(77));
    expect(verdict.ok).toBe(false);
    expect(verdict.verdict.bestPrunedGammaMilliCU).toBe(String(toMilliCU(77)));
    expect(verdict.verdict.behaviour).toMatch(/Keep the cheapest by bound/);
  });

  test("branch-and-bound nodes — the counter exists even in the singleton regime, where it stays zero", () => {
    const tracker = budgets.create({ config: fixture.budgetConfig({ branchNodeBudget: 1 }) });
    expect(tracker.result().counters.branchNodes).toBe(0);
    expect(tracker.branchNode().ok).toBe(true);
    expect(tracker.branchNode().ok).toBe(false);
  });

  test("wall clock — exceeding it returns the incumbent with its bound", () => {
    const tracker = budgets.create({
      config: fixture.budgetConfig({ timeBudgetMs: 10 }),
      elapsedMs: () => 11,
    });
    const verdict = tracker.continueSolving();
    expect(verdict.ok).toBe(false);
    expect(verdict.verdict.behaviour).toBe("Return the best feasible solution found; record as budget-limited");
  });
});

describe("§9.4 — anytime: never nothing, never a hang", () => {
  test("a tracker that has been offered nothing still holds a feasible incumbent", () => {
    const tracker = budgets.create({ config: fixture.budgetConfig() });
    const result = tracker.result();

    expect(result.incumbent.assignments).toEqual([]);
    expect(result.incumbent.source).toBe("EMPTY");
    expect(budgets.assertAnytime(result).ok).toBe(true);
  });

  test("the incumbent is monotone — a worse solution is never accepted", () => {
    const tracker = budgets.create({ config: fixture.budgetConfig() });
    tracker.offer({ assignments: [{ legId: "L1" }], objectiveMilliCU: toMilliCU(10) });
    const rejected = tracker.offer({ assignments: [{ legId: "L2" }], objectiveMilliCU: toMilliCU(20) });

    expect(rejected.accepted).toBe(false);
    expect(tracker.result().incumbent.objectiveMilliCU).toBe(toMilliCU(10));
  });

  test("a budget-limited result names the obligation the caller now owes", () => {
    const tracker = budgets.create({ config: fixture.budgetConfig({ timeBudgetMs: 0 }), elapsedMs: () => 1 });
    tracker.continueSolving();
    const result = tracker.result();

    expect(result.budgetLimited).toBe(true);
    expect(result.obligations).toHaveLength(1);
    expect(budgets.assertAnytime(result).ok).toBe(true);
  });

  test("assertAnytime rejects a result with no incumbent, quoting §9.4", () => {
    const verdict = budgets.assertAnytime({ budgetLimited: true, obligations: [] });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems[0]).toMatch(/never nothing and never a hang/);
  });
});

describe("§9.6 — a replayed round truncates where the original did, not where its own clock lands", () => {
  test("the pinned wall-clock outcome is used and no clock is consulted", () => {
    let clockReads = 0;
    const tracker = budgets.create({
      config: fixture.budgetConfig({ timeBudgetMs: 250 }),
      elapsedMs: () => {
        clockReads += 1;
        return 0;
      },
      replayOf: { wallClockExceeded: true, elapsedAtStopMs: 251 },
    });

    const verdict = tracker.continueSolving();
    expect(verdict.ok).toBe(false);
    expect(clockReads).toBe(0);
    expect(tracker.result().wallClock).toMatchObject({ replayed: true, elapsedMs: 251, exceeded: true });
  });
});
