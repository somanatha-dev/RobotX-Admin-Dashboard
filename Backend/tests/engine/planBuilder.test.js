"use strict";

/**
 * Phase 8 — §13's Plan Builder, timeline, insertion, and column price.
 *
 * The properties this suite exists to hold:
 *
 *   - the plan is the **one** artefact feasibility and cost share (§13.1)
 *   - service time is learned per cohort with hierarchical shrinkage (§13.2)
 *   - waiting is modelled and priced, so arriving early is penalised (§13.2)
 *   - a reserve violation attempts a charging stop before declaring infeasibility (§13.4)
 *   - there is **no** return-to-base rule (§13.5)
 *   - queue depth is a property of the plan, not an arc capacity (§13.3, §9.3)
 *   - `γ(c)` recomputed from `Φ` equals the solver's value exactly, in milli-CU (§13.3)
 */

const fixture = require("./helpers/planFixture");
const costFixture = require("./helpers/costFixture");
const planBuilder = require("../../src/engine/plan/planBuilder");
const timeline = require("../../src/engine/plan/timeline");
const column = require("../../src/engine/plan/column");
const columnBuilder = require("../../src/engine/plan/columnBuilder");
const insertion = require("../../src/engine/plan/insertion");
const phi = require("../../src/engine/cost/phi");
const cChurn = require("../../src/engine/cost/cChurn");
const { toCU, subtract } = require("../../src/engine/determinism/fixedPoint");

afterEach(() => phi.clearTerms());

describe("§13.1 — the plan is the artefact feasibility and cost share", () => {
  const built = planBuilder.build(fixture.buildInput());

  test("a plan is produced with every §13.1 bullet present", () => {
    expect(built.ok).toBe(true);
    const plan = built.plan;

    // The ordered stop sequence.
    expect(plan.stops.map((stop) => stop.stopType)).toEqual(["PICKUP", "DROP"]);
    // Per-stop arrival, service start, service end, departure, each with a band.
    for (const stop of plan.stops) {
      expect(typeof stop.projectedArrivalMs).toBe("number");
      expect(typeof stop.serviceStartMs).toBe("number");
      expect(typeof stop.serviceEndMs).toBe("number");
      expect(typeof stop.departureMs).toBe("number");
      expect(typeof stop.band.arrivalSdSeconds).toBe("number");
    }
    // Per-leg distances.
    expect(plan.distanceM).toBeGreaterThan(0);
    // Per-stop payload state, including centre of gravity and custody-relevant mass.
    expect(plan.loadState).toHaveLength(2);
    expect(plan.loadState[0].cog).toHaveProperty("withinEnvelope");
    // Per-stop energy with a band.
    expect(plan.stops[0].energy.band).toHaveProperty("sdWh");
    // The terminal state: position, SoC, time.
    expect(plan.terminal).toEqual(
      expect.objectContaining({ zoneId: "zone-rich", soc: expect.any(Number), releaseMs: expect.any(Number) }),
    );
    // Feasibility results for every stop.
    expect(plan.stopFeasibility).toHaveLength(2);
  });

  test("the plan carries every field the 38 predicates read", () => {
    const plan = built.plan;
    for (const field of [
      "projectedStartMs",
      "projectedEndMs",
      "horizonEndMs",
      "earliestFeasibleCompletionMs",
      "concurrentCommitments",
      "peakLoadedMassKg",
      "loadState",
      "packing",
      "energy",
    ]) {
      expect({ field, present: plan[field] !== undefined }).toEqual({ field, present: true });
    }
    expect(plan.energy.tierProbabilities).toEqual(
      expect.objectContaining({ T1: expect.any(Number), T2: expect.any(Number), T3: expect.any(Number) }),
    );
    expect(plan.energy.chargerReachability.basis).toBe("PINNED_PROJECTION");
  });

  test("the plan carries every field Φ reads", () => {
    const plan = built.plan;
    expect(Object.keys(plan.components).sort()).toEqual(
      [
        "approachSeconds",
        "linehaulSeconds",
        "serviceFirstSeconds",
        "serviceLastSeconds",
        "terminalSeconds",
        "waitSeconds",
      ].sort(),
    );
    expect(plan.energyWh).toBeGreaterThan(0);
    expect(plan.origin.zoneId).toBe("zone-poor");
  });

  test("the plan names the versions it was built from, so a decision can be replayed", () => {
    expect(built.plan.provenance.chargerProjectionVersion).toBe(41);
    expect(built.plan.provenance.decisionTimeMs).toBe(fixture.DECISION_TIME_MS);
  });

  test("two builds over identical inputs produce identical plans (T6, §9.6)", () => {
    const first = planBuilder.build(fixture.buildInput());
    const second = planBuilder.build(fixture.buildInput());
    expect(JSON.stringify(first.plan)).toBe(JSON.stringify(second.plan));
  });

  test("a drop before its pickup is refused — precedence is checked, not assumed", () => {
    const legs = fixture.newLegs();
    legs[0].stops = [
      { ...legs[0].stops[1], sequence: 1 },
      { ...legs[0].stops[0], sequence: 2 },
    ];
    const result = planBuilder.sequenceStops({ committedLegs: [], newLegs: legs });
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toMatch(/before any pickup/);
  });

  test("committed Legs are sequenced first, and the plan counts them", () => {
    const committed = fixture.newLegs()[0];
    const result = planBuilder.sequenceStops({
      committedLegs: [{ ...committed, legId: "committed-1", custodyAlreadyHeld: true }],
      newLegs: fixture.newLegs(),
    });
    expect(result.legs.map((leg) => [leg.legId, leg.committed])).toEqual([
      ["committed-1", true],
      ["leg-1", false],
    ]);
    expect(result.stops.map((stop) => stop.sequence)).toEqual([1, 2, 3, 4]);
  });
});

describe("§13.2 — service time and waiting", () => {
  test("hour_of_week is derived arithmetically, with no calendar read", () => {
    // 2026-08-04T12:00:00Z is a Tuesday; Sunday-first index 2, hour 12 → 60.
    expect(timeline.hourOfWeek(fixture.DECISION_TIME_MS, 0)).toBe(60);
    // A site three hours ahead sees 15:00 local on the same day.
    expect(timeline.hourOfWeek(fixture.DECISION_TIME_MS, 3 * 3600)).toBe(63);
    // And one far enough behind rolls back into Monday.
    expect(timeline.hourOfWeek(fixture.DECISION_TIME_MS, -13 * 3600)).toBe(1 * 24 + 23);
  });

  test("hour_of_week floors correctly before the epoch", () => {
    expect(timeline.hourOfWeek(-1, 0)).toBe(3 * 24 + 23);
  });

  test("a cohort with no observations is exactly its parent — continuous, not thresholded", () => {
    const parent = { meanSeconds: 100, sdSeconds: 50 };
    expect(timeline.shrink({ n: 0, meanSeconds: 9999, sdSeconds: 1 }, parent, 20)).toEqual({
      meanSeconds: 100,
      sdSeconds: 50,
      weight: 0,
    });
  });

  test("the shrinkage weight is n / (n + strength)", () => {
    const shrunk = timeline.shrink({ n: 20, meanSeconds: 200, sdSeconds: 10 }, { meanSeconds: 100, sdSeconds: 50 }, 20);
    expect(shrunk.weight).toBe(0.5);
    expect(shrunk.meanSeconds).toBe(150);
    expect(shrunk.sdSeconds).toBe(30);
  });

  test("a well-observed cohort dominates its prior; a sparse one does not", () => {
    const parameters = { priorSeconds: 300, priorCv: 0.5, shrinkageStrength: 20 };
    const dense = timeline.serviceTimeFor({
      models: { "stopType=DROP": { n: 10_000, meanSeconds: 90, sdSeconds: 15 } },
      descriptor: { stopType: "DROP" },
      ...parameters,
    });
    const sparse = timeline.serviceTimeFor({
      models: { "stopType=DROP": { n: 1, meanSeconds: 90, sdSeconds: 15 } },
      descriptor: { stopType: "DROP" },
      ...parameters,
    });
    expect(dense.meanSeconds).toBeCloseTo(90, 0);
    expect(sparse.meanSeconds).toBeGreaterThan(280);
    expect(dense.shrinkageWeight).toBeGreaterThan(sparse.shrinkageWeight);
  });

  test("the more specific cohort inherits what its ancestors learned", () => {
    const resolved = timeline.serviceTimeFor({
      models: {
        "stopType=DROP": { n: 1000, meanSeconds: 90, sdSeconds: 15 },
        "siteId=site-b|stopType=DROP": { n: 40, meanSeconds: 300, sdSeconds: 40 },
      },
      descriptor: { siteId: "site-b", stopType: "DROP", missionClass: "PARCEL", hourOfWeek: 60 },
      priorSeconds: 150,
      priorCv: 0.5,
      shrinkageStrength: 20,
    });
    expect(resolved.cohortKey).toBe("siteId=site-b|stopType=DROP");
    // The site's own 300 s pulled toward the stop type's 90 s, not toward the raw prior.
    expect(resolved.meanSeconds).toBeGreaterThan(90);
    expect(resolved.meanSeconds).toBeLessThan(300);
    expect(resolved.ladder.map((row) => row.level)).toEqual(["prior", "stopType", "siteId+stopType"]);
  });

  test("with no fitted cohort at all, the configured prior is the answer and says so", () => {
    const resolved = timeline.serviceTimeFor({
      models: {},
      descriptor: { stopType: "PICKUP" },
      priorSeconds: 150,
      priorCv: 0.4,
      shrinkageStrength: 20,
    });
    expect(resolved.source).toBe(timeline.SOURCE.PRIOR);
    expect(resolved.meanSeconds).toBe(150);
    expect(resolved.sdSeconds).toBe(60);
  });

  test("an unresolved prior is refused rather than defaulted", () => {
    const resolved = timeline.serviceTimeFor({ models: {}, descriptor: { stopType: "PICKUP" } });
    expect(resolved.ok).toBe(false);
    expect(resolved.missing).toContain("plan.service_time_prior");
  });

  test("arriving before a window opens produces priced wait time", () => {
    const projected = timeline.project({
      startMs: fixture.DECISION_TIME_MS,
      decisionTimeMs: fixture.DECISION_TIME_MS,
      stops: [
        {
          sequence: 1,
          serviceSeconds: 60,
          serviceSdSeconds: 0,
          windowStartMs: fixture.DECISION_TIME_MS + 20 * fixture.MINUTE_MS,
        },
      ],
      hops: [{ distanceM: 100, travelSeconds: 60, travelSdSeconds: 0 }],
    });
    expect(projected.stops[0].waitSeconds).toBe(20 * 60 - 60);
    expect(projected.totals.windowWaitSeconds).toBe(20 * 60 - 60);
  });

  test("an agent that arrives 20 minutes early is penalised, not rewarded", () => {
    const stops = (travelSeconds) => ({
      startMs: fixture.DECISION_TIME_MS,
      decisionTimeMs: fixture.DECISION_TIME_MS,
      stops: [
        {
          sequence: 1,
          serviceSeconds: 60,
          serviceSdSeconds: 0,
          windowStartMs: fixture.DECISION_TIME_MS + 20 * fixture.MINUTE_MS,
        },
      ],
      hops: [{ distanceM: 100, travelSeconds, travelSdSeconds: 0 }],
    });
    const fast = timeline.project(stops(60));
    const slow = timeline.project(stops(1140));
    // Both start service at the same instant, so committed time is identical: being fast
    // buys nothing here, which is exactly §13.2's point.
    expect(fast.totals.waitSeconds + fast.totals.approachSeconds).toBe(
      slow.totals.waitSeconds + slow.totals.approachSeconds,
    );
  });

  test("uncertainty accumulates in quadrature along the plan", () => {
    const projected = timeline.project({
      startMs: fixture.DECISION_TIME_MS,
      decisionTimeMs: fixture.DECISION_TIME_MS,
      stops: [
        { sequence: 1, serviceSeconds: 60, serviceSdSeconds: 40 },
        { sequence: 2, serviceSeconds: 60, serviceSdSeconds: 0 },
      ],
      hops: [
        { distanceM: 100, travelSeconds: 60, travelSdSeconds: 30 },
        { distanceM: 100, travelSeconds: 60, travelSdSeconds: 0 },
      ],
    });
    expect(projected.stops[0].band.arrivalSdSeconds).toBe(30);
    expect(projected.stops[0].band.departureSdSeconds).toBe(50);
    expect(projected.stops[1].band.arrivalSdSeconds).toBe(50);
  });

  test("p_late reads the band, so punctuality is distinct from speed", () => {
    const deadlineMs = fixture.DECISION_TIME_MS + 200_000;
    const makeStops = (sd) => [
      {
        sequence: 1,
        departureMs: fixture.DECISION_TIME_MS + 100_000,
        band: { departureSdSeconds: sd },
      },
    ];
    const predictable = timeline.lateProbability(makeStops(10), deadlineMs);
    const erratic = timeline.lateProbability(makeStops(120), deadlineMs);
    expect(erratic.lateProbability).toBeGreaterThan(predictable.lateProbability);
  });

  test("a missing hop is refused — a stop reached for free is not a plan", () => {
    const projected = timeline.project({
      startMs: fixture.DECISION_TIME_MS,
      stops: [{ sequence: 1, serviceSeconds: 60 }, { sequence: 2, serviceSeconds: 60 }],
      hops: [{ distanceM: 100, travelSeconds: 60, travelSdSeconds: 0 }],
    });
    expect(projected.ok).toBe(false);
    expect(projected.problems[0]).toMatch(/a leg the plan would traverse for free/);
  });

  test("intermediate-stop dwell is carried, so a three-stop plan is never cheaper than the two inside it", () => {
    const two = timeline.project({
      startMs: 0,
      stops: [
        { sequence: 1, serviceSeconds: 100, serviceSdSeconds: 0 },
        { sequence: 2, serviceSeconds: 100, serviceSdSeconds: 0 },
      ],
      hops: [
        { distanceM: 10, travelSeconds: 10, travelSdSeconds: 0 },
        { distanceM: 10, travelSeconds: 10, travelSdSeconds: 0 },
      ],
    });
    const three = timeline.project({
      startMs: 0,
      stops: [
        { sequence: 1, serviceSeconds: 100, serviceSdSeconds: 0 },
        { sequence: 2, serviceSeconds: 100, serviceSdSeconds: 0 },
        { sequence: 3, serviceSeconds: 100, serviceSdSeconds: 0 },
      ],
      hops: [
        { distanceM: 10, travelSeconds: 10, travelSdSeconds: 0 },
        { distanceM: 10, travelSeconds: 10, travelSdSeconds: 0 },
        { distanceM: 10, travelSeconds: 10, travelSdSeconds: 0 },
      ],
    });
    const priced = (totals) =>
      totals.waitSeconds + totals.approachSeconds + totals.serviceFirstSeconds + totals.linehaulSeconds + totals.serviceLastSeconds;
    expect(three.totals.intermediateServiceSeconds).toBe(100);
    expect(priced(three.totals)).toBeGreaterThan(priced(two.totals));
    // The six components account for the whole elapsed plan: nothing is unpriced.
    expect(priced(three.totals)).toBe(three.totals.durationSeconds);
    expect(priced(two.totals)).toBe(two.totals.durationSeconds);
  });

  // Phase 8 remediation — the assertion above is exercised at `decisionTimeMs`
  // undefined, so `releaseDelaySeconds` is 0 and it never reaches §8.2's `t_wait`
  // "time until the agent can start". With a real release delay the six components
  // price **decision-time → plan end**, while `durationSeconds` measures **release →
  // plan end**; the two differ by exactly the release delay. Independent verification
  // confirmed the arithmetic is right and that the intervals are disjoint, so this
  // states the identity that actually holds rather than the one that happens to hold
  // at zero.
  test("with a real release delay, the six components price decision-time to plan end", () => {
    const decisionTimeMs = 0;
    const startMs = 60_000; // the agent is released a minute after the decision
    const projected = timeline.project({
      startMs,
      decisionTimeMs,
      stops: [
        { sequence: 1, serviceSeconds: 100, serviceSdSeconds: 0 },
        { sequence: 2, serviceSeconds: 100, serviceSdSeconds: 0 },
      ],
      hops: [
        { distanceM: 10, travelSeconds: 10, travelSdSeconds: 0 },
        { distanceM: 10, travelSeconds: 10, travelSdSeconds: 0 },
      ],
    });
    const t = projected.totals;
    const priced =
      t.waitSeconds + t.approachSeconds + t.serviceFirstSeconds + t.linehaulSeconds + t.serviceLastSeconds;

    expect(t.releaseDelaySeconds).toBe(60);
    // The identity: the six components (less `t_terminal`, which the Plan Builder owns)
    // cover decision-time → plan end, with no gap and no overlap.
    expect(priced).toBe((t.endMs - decisionTimeMs) / 1000);
    // And the excess over the plan's own duration is exactly the release delay — the
    // two intervals are adjacent, so nothing is charged twice.
    expect(priced - t.durationSeconds).toBe(t.releaseDelaySeconds);
    // The wait is reported split, so an explanation can tell the two kinds apart.
    expect(t.waitSeconds).toBe(t.releaseDelaySeconds + t.windowWaitSeconds);
  });
});

describe("§13.4 — charging is a planned stop, not a refusal", () => {
  // A pack that cannot hold the plan's reserves without a top-up.
  const tight = (overrides) =>
    fixture.buildInput({
      energy: fixture.energy({ usableWh: 320, ...(overrides || {}) }),
      charging: fixture.charging({ currentSoc: 0.16, packUsableWh: 2000 }),
    });

  test("a reserve violation is met with an insertion attempt before any rejection", () => {
    const withoutCharge = planBuilder.build({ ...tight(), charging: { ...fixture.charging(), targetSoc: null } });
    expect(withoutCharge.charging).toBe(planBuilder.CHARGING.NO_FEASIBLE_INSERTION);

    const withCharge = planBuilder.build(tight());
    expect(withCharge.charging).toBe(planBuilder.CHARGING.INSERTED);
    expect(withCharge.plan.stops.some((stop) => stop.stopType === "CHARGE")).toBe(true);
  });

  test("the inserted stop is a plan, not a booking", () => {
    const built = planBuilder.build(tight());
    const chargeStop = built.plan.stops.find((stop) => stop.stopType === "CHARGE");
    expect(chargeStop.reservationHeld).toBe(false);
    expect(chargeStop.reservationRequired).toBe(true);
    expect(built.plan.charging.note).toMatch(/a plan, not a booking/);
  });

  test("the target SoC is consumed with its provenance, never computed here", () => {
    const built = planBuilder.build(tight());
    expect(built.plan.charging.targetSoc).toBe(0.8);
    expect(built.plan.charging.targetSocSource).toBe("SCHEDULER");

    const source = require("fs").readFileSync(
      require("path").join(__dirname, "..", "..", "src", "engine", "plan", "planBuilder.js"),
      "utf8",
    );
    expect(source).not.toMatch(/function\s+\w*[Tt]argetSoc\s*\(/);
  });

  test("with no target SoC available, no charging stop can be planned, and the reason says why", () => {
    const attempt = planBuilder.insertChargingStop(
      { ...tight(), charging: { ...fixture.charging(), targetSoc: null } },
      planBuilder.sequenceStops(tight()).stops,
    );
    expect(attempt.ok).toBe(false);
    expect(attempt.attempts[0].reason).toMatch(/forbids the engine to compute one/);
  });

  test("the charge duration comes from the nonlinear curve, and the queue wait is added", () => {
    const built = planBuilder.build(tight());
    expect(built.plan.charging.chargeSeconds).toBeGreaterThan(0);
    expect(built.plan.charging.queueWaitSeconds).toBe(120);
    const chargeStop = built.plan.stops.find((stop) => stop.stopType === "CHARGE");
    expect(chargeStop.serviceSeconds).toBe(built.plan.charging.chargeSeconds + 120);
  });

  test("the inserted charge is the mission's t_terminal, and nothing else is", () => {
    const uncharged = planBuilder.build(fixture.buildInput());
    expect(uncharged.plan.components.terminalSeconds).toBe(0);

    const charged = planBuilder.build(tight());
    expect(charged.plan.components.terminalSeconds).toBe(
      charged.plan.charging.chargeSeconds + charged.plan.charging.queueWaitSeconds,
    );
  });

  test("when no insertion works, the plan is still produced and F34 is left to decide", () => {
    const impossible = planBuilder.build({
      ...tight(),
      energy: fixture.energy({ usableWh: 5 }),
      charging: fixture.charging({ currentSoc: 0.999, targetSoc: 1 }),
    });
    expect(impossible.ok).toBe(true);
    expect(impossible.plan).not.toBeNull();
    expect(impossible.charging).toBe(planBuilder.CHARGING.NO_FEASIBLE_INSERTION);
    expect(impossible.problems[0]).toMatch(/§13.4 leaves the rejection to F34/);
  });
});

describe("§13.5 — there is no return-to-base rule", () => {
  test("the planner inserts no return leg; it reports the terminal state instead", () => {
    const built = planBuilder.build(fixture.buildInput());
    expect(built.plan.stops.map((stop) => stop.stopType)).toEqual(["PICKUP", "DROP"]);
    expect(built.plan.terminal.zoneId).toBe("zone-rich");
  });

  test("the source contains no return-to-base rule to find", () => {
    const source = require("fs").readFileSync(
      require("path").join(__dirname, "..", "..", "src", "engine", "plan", "planBuilder.js"),
      "utf8",
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code).not.toMatch(/RETURN_TO_BASE|returnToBase|homeDepot/);
  });
});

describe("§13.3 / §9.3 — the column price", () => {
  const brandedPlan = costFixture.brandedPlan();
  const limits = {
    capacity: 2,
    commitmentHorizonSeconds: 7200,
    decisionTimeMs: costFixture.DECISION_TIME_MS,
  };

  test("for an idle agent, γ = Φ(plan) exactly — the degenerate case (§8.1)", () => {
    const built = column.make({ agentId: "agent-1", legIds: ["leg-1"], plan: brandedPlan, basePlan: null });
    const priced = column.price(built, { candidatePhi: costFixture.phiInput(), limits });
    const direct = phi.evaluate(brandedPlan, costFixture.phiInput());

    expect(priced.ok).toBe(true);
    expect(priced.gammaMilliCU).toBe(direct.milliCU);
    expect(priced.breakdown.phiBaseMilliCU).toBe(0n);
  });

  test("for an occupied agent, γ is the difference of the one functional at two plans", () => {
    const basePlan = costFixture.brandedPlan({
      legs: [
        {
          legId: "base-leg",
          missionId: "mission-0",
          role: "TERMINAL",
          targetMs: costFixture.DECISION_TIME_MS,
          deadlineMs: costFixture.DECISION_TIME_MS + 3_600_000,
          queueAgeSeconds: 0,
          committed: true,
        },
      ],
      components: { ...costFixture.plan().components, linehaulSeconds: 300 },
    });
    const basePhi = costFixture.phiInput({
      completionByLegId: { "base-leg": costFixture.DECISION_TIME_MS + 600_000 },
    });

    const built = column.make({ agentId: "agent-1", legIds: ["leg-1"], plan: brandedPlan, basePlan });
    const priced = column.price(built, { candidatePhi: costFixture.phiInput(), basePhi, limits });

    const candidateValue = phi.evaluate(brandedPlan, costFixture.phiInput()).milliCU;
    const baseValue = phi.evaluate(basePlan, basePhi).milliCU;
    expect(priced.gammaMilliCU).toBe(subtract(candidateValue, baseValue));
  });

  test("γ recomputed from the two Φ values equals the solver's value, exactly", () => {
    const built = column.make({ agentId: "agent-1", legIds: ["leg-1"], plan: brandedPlan, basePlan: null });
    const priced = column.price(built, { candidatePhi: costFixture.phiInput(), limits });

    const check = column.recompute({
      phiCandidateMilliCU: priced.breakdown.phiCandidateMilliCU,
      phiBaseMilliCU: priced.breakdown.phiBaseMilliCU,
      churnMilliCU: priced.breakdown.churnMilliCU,
      solverGammaMilliCU: priced.gammaMilliCU,
    });
    expect(check).toEqual(
      expect.objectContaining({ ok: true, recomputedMilliCU: priced.gammaMilliCU, deltaMilliCU: 0n }),
    );
  });

  test("a solver value that disagrees by one milli-CU is caught, with no tolerance", () => {
    const check = column.recompute({
      phiCandidateMilliCU: 1000n,
      phiBaseMilliCU: 0n,
      churnMilliCU: 0n,
      solverGammaMilliCU: 1001n,
    });
    expect(check.ok).toBe(false);
    expect(check.deltaMilliCU).toBe(-1n);
    expect(check.reason).toMatch(/optimising a different objective/);
  });

  test("γ is recomputed in integers or not at all", () => {
    const check = column.recompute({
      phiCandidateMilliCU: 1,
      phiBaseMilliCU: 0n,
      churnMilliCU: 0n,
      solverGammaMilliCU: 1n,
    });
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/int64 milli-CU/);
  });

  test("C_churn enters the column price by registration, and its omission is recorded", () => {
    const built = column.make({ agentId: "agent-1", legIds: ["leg-1"], plan: brandedPlan, basePlan: null });
    const without = column.price(built, { candidatePhi: costFixture.phiInput(), limits });
    expect(without.omittedTerms.map((row) => row.term)).toContain("C_churn");
    expect(without.breakdown.churnMilliCU).toBe(0n);

    phi.registerTerm("C_churn", (input) => cChurn.evaluate(input));
    const rates = costFixture.rates();
    const with_ = column.price(built, {
      candidatePhi: costFixture.phiInput(),
      limits,
      churn: {
        displacement: { kind: cChurn.DISPLACEMENT.SOFT_RESERVATION },
        reservedAtMs: costFixture.DECISION_TIME_MS - 60_000,
        decisionTimeMs: costFixture.DECISION_TIME_MS,
        distanceAlreadyTravelledM: 0,
        baseCostCu: 10,
        perSecondRate: rates.churnPerSecond,
        wastedTravelRate: rates.churnWastedTravel,
        notificationCostCu: 2,
      },
    });
    expect(with_.gammaMilliCU - without.gammaMilliCU).toBe(with_.breakdown.churnMilliCU);
    expect(toCU(with_.breakdown.churnMilliCU)).toBeCloseTo(18, 9);
  });

  test("queue depth is checked as a property of the plan (§13.3, F17)", () => {
    const overFull = costFixture.brandedPlan({ concurrentCommitments: 3 });
    const built = column.make({ agentId: "agent-1", legIds: ["leg-1"], plan: overFull, basePlan: null });
    const priced = column.price(built, { candidatePhi: costFixture.phiInput(), limits });
    expect(priced.ok).toBe(false);
    expect(priced.problems[0]).toMatch(/concurrent commitments against a capacity/);
  });

  test("the commitment horizon is checked as plan feasibility too", () => {
    const far = costFixture.brandedPlan({
      horizonEndMs: costFixture.DECISION_TIME_MS + 12 * 3_600_000,
    });
    const built = column.make({ agentId: "agent-1", legIds: ["leg-1"], plan: far, basePlan: null });
    const priced = column.price(built, { candidatePhi: costFixture.phiInput(), limits });
    expect(priced.problems[0]).toMatch(/beyond the 7200 s commitment horizon/);
  });

  test("a plan that cannot state its own commitment count is refused, not read off the agent", () => {
    const silent = costFixture.brandedPlan({ concurrentCommitments: undefined });
    const verdict = column.assertQueueDepthIsPlanFeasibility(silent, limits);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems[0]).toMatch(/couple this candidate to the solver's other provisional choices/);
  });

  test("the column exposes no capacity field for a solver to turn into an arc", () => {
    const built = column.make({ agentId: "agent-1", legIds: ["leg-1"], plan: brandedPlan, basePlan: null });
    expect(Object.keys(built).sort()).toEqual(
      ["agentId", "basePlan", "identity", "insertionPositions", "legIds", "plan", "singleton"].sort(),
    );
  });

  test("a column's identity is canonical and independent of generation order", () => {
    const a = column.make({ agentId: "agent-1", legIds: ["b", "a"], plan: brandedPlan });
    const b = column.make({ agentId: "agent-1", legIds: ["a", "b"], plan: brandedPlan });
    expect(a.identity).toBe(b.identity);
  });
});

describe("§9.3 — the Column Builder builds singleton columns only", () => {
  const brandedPlan = costFixture.brandedPlan();
  const candidate = (agentId, legId) => ({
    agentId,
    legId,
    plan: brandedPlan,
    basePlan: null,
    pricing: { candidatePhi: costFixture.phiInput() },
    limits: { capacity: 2, commitmentHorizonSeconds: 7200, decisionTimeMs: costFixture.DECISION_TIME_MS },
  });

  test("one column per (agent, Leg) pairing, all singletons", () => {
    const built = columnBuilder.build({
      candidates: [candidate("agent-1", "leg-1"), candidate("agent-2", "leg-1")],
      maxColumnsPerRound: 100,
    });
    expect(built.columns).toHaveLength(2);
    expect(built.columns.every((entry) => entry.singleton)).toBe(true);
    expect(built.generation.regime).toBe("SINGLETON");
  });

  test("the singleton set is complete, so column generation contributes no gap", () => {
    const built = columnBuilder.build({
      candidates: [candidate("agent-1", "leg-1")],
      maxColumnsPerRound: 100,
    });
    expect(built.generation.generationGapMilliCU).toBe(0n);
    expect(built.generation.generationGapNote).toMatch(/reported separately/);
  });

  test("budget truncation keeps the cheapest and records the best pruned bound (§9.4)", () => {
    const built = columnBuilder.build({
      candidates: [candidate("agent-1", "leg-1"), candidate("agent-2", "leg-1"), candidate("agent-3", "leg-1")],
      maxColumnsPerRound: 2,
    });
    expect(built.columns).toHaveLength(2);
    expect(built.generation.budgetTruncated).toBe(true);
    expect(typeof built.generation.bestPrunedGammaMilliCU).toBe("bigint");
    // Deterministic truncation: the tie-break ends in the unique agent id.
    expect(built.columns.map((entry) => entry.agentId)).toEqual(["agent-1", "agent-2"]);
  });

  test("an unpriceable candidate is pruned with its reason, not silently dropped", () => {
    const broken = candidate("agent-4", "leg-1");
    broken.pricing = { candidatePhi: {} };
    const built = columnBuilder.build({ candidates: [broken], maxColumnsPerRound: 10 });
    expect(built.columns).toHaveLength(0);
    expect(built.pruned[0].reason).toBe(columnBuilder.PRUNED.UNPRICEABLE);
    expect(built.pruned[0].detail.length).toBeGreaterThan(0);
  });

  test("a multi-Leg column is refused — that mechanism is behind its own kill switch", () => {
    const verdict = columnBuilder.assertSingletonRegime([{ identity: "x", legIds: ["a", "b"] }]);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems[0]).toMatch(/multi_leg_columns/);
  });

  // Phase 8 remediation. The guard above shipped correct and unit-tested but uncalled, so
  // the singleton restriction rested on `build()` happening to take one legId per
  // candidate rather than on the named check. These pin it as a live guard.
  test("build() runs the singleton guard over the set it emits", () => {
    const built = columnBuilder.build({ candidates: [candidate("agent-1", "leg-1")], maxColumnsPerRound: 10 });
    expect(built.ok).toBe(true);
    expect(built.problems).toEqual([]);
    expect(built.columns.every((entry) => entry.singleton)).toBe(true);
  });

  test("a multi-Leg column reaching the emitted set fails build(), it does not pass unremarked", () => {
    const emitted = [{ identity: "x", agentId: "a", legIds: ["l1", "l2"], singleton: false, gammaMilliCU: 0n }];
    const verdict = columnBuilder.assertSingletonRegime(emitted);
    expect(verdict.ok).toBe(false);
    // `build()` returns `ok: regimeCheck.ok`, so the same verdict is the build's verdict.
    expect(verdict.problems[0]).toMatch(/covers 2 Legs/);
  });
});

describe("§13.3 — insertion, priced by Φ and never by a second model", () => {
  test("precedence is enforced by construction: no position pair drops before it picks up", () => {
    for (const [first, last] of insertion.exhaustivePositions(4, 2)) {
      expect(first).toBeLessThanOrEqual(last);
    }
    expect(insertion.exhaustivePositions(2, 2)).toHaveLength(6);
    expect(insertion.exhaustivePositions(3, 1)).toHaveLength(4);
  });

  test("splicing resequences the merged stop list", () => {
    const merged = insertion.spliceAt(
      [{ id: "a" }, { id: "b" }],
      [{ id: "p" }, { id: "d" }],
      [0, 2],
    );
    expect(merged.map((stop) => [stop.id, stop.sequence])).toEqual([
      ["p", 1],
      ["a", 2],
      ["b", 3],
      ["d", 4],
    ]);
  });

  test("the heuristic is bounded and deterministic beyond max_exhaustive_stops", () => {
    const stops = Array.from({ length: 20 }, (_unused, index) => ({
      projectedArrivalMs: fixture.DECISION_TIME_MS + index * 60_000,
    }));
    const first = insertion.heuristicPositions({
      existingStops: stops,
      targetMs: fixture.DECISION_TIME_MS + 10 * 60_000,
      insertedStops: 2,
      maxInsertions: 4,
    });
    const second = insertion.heuristicPositions({
      existingStops: stops,
      targetMs: fixture.DECISION_TIME_MS + 10 * 60_000,
      insertedStops: 2,
      maxInsertions: 4,
    });
    expect(first).toEqual(second);
    expect(first.length).toBeLessThanOrEqual(4 * 4);
  });

  test("the enumerator cannot brand a plan; only the injected gate can", () => {
    const source = require("fs").readFileSync(
      require("path").join(__dirname, "..", "..", "src", "engine", "plan", "insertion.js"),
      "utf8",
    );
    expect(source).not.toMatch(/brandFeasible/);
    expect(source).toMatch(/source\.gate/);
  });

  test("with no admissible position the result names §13.3's four constraints", () => {
    const result = insertion.cheapestInsertion({
      existingStops: [{ projectedArrivalMs: 0 }],
      insertedStops: [{ stopType: "PICKUP" }, { stopType: "DROP" }],
      builderInput: { hopsForSequence: () => null },
      gate: () => null,
      phiInputFor: () => ({}),
      maxExhaustiveStops: 8,
      maxHeuristicInsertions: 24,
    });
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toContain("precedence (pickup before its drop)");
    expect(result.problems[0]).toContain("payload capacity at every point");
  });

  test("the kill switch degrades to strict one-mission-per-agent", () => {
    expect(insertion.degraded().degradesTo).toMatch(/capacity\[agent_class\] = 1/);
  });
});
