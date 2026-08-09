"use strict";

/**
 * Fixtures for §8's cost function and §13's Plan Builder.
 *
 * Two things every cost test needs and neither is trivial to build ad hoc:
 *
 *   1. **A branded plan.** T1 (§1.5, I14) makes the cost function structurally incapable
 *      of seeing a candidate the feasibility gate did not admit, and the brand is a
 *      non-enumerable Symbol that only `feasibility/evaluate.js` may apply. So the fixture
 *      brands by running the real gate — not by reaching for `brandFeasible()`, which would
 *      be the test suite quietly doing the thing the architecture forbids the code to do.
 *
 *   2. **A complete rate set.** Every term refuses an unresolved rate rather than
 *      defaulting one, so a partial fixture produces "missing" results that look like
 *      failures of the term under test.
 *
 * The numbers are chosen to be readable by hand: one CU per second of agent time, one CU
 * per watt-hour, and round distances, so a reviewer can check a term's arithmetic without
 * running anything.
 */

const evaluate = require("../../../src/engine/feasibility/evaluate");
const { makeRate } = require("../../../src/engine/cost/exchangeRates");
const feasibilityFixture = require("./feasibilityFixture");

const DECISION_TIME_MS = feasibilityFixture.DECISION_TIME_MS;
const MINUTE_MS = 60_000;

/** Exchange rates, all built through `makeRate` so their dimensions are checked. */
function rates() {
  return {
    lambdaTime: makeRate("cost.lambda_time", 1, { unit: "CU·s⁻¹" }),
    cuPerWh: makeRate("cost.energy.cu_per_wh", 1, { unit: "CU·Wh⁻¹" }),
    cuPerMetreWear: makeRate("cost.wear.cu_per_metre", 0.01, { unit: "CU·m⁻¹" }),
    slaRate: makeRate("cost.sla.cu_per_second_late", 2, { unit: "CU·s⁻¹" }),
    stalenessRate: makeRate("cost.staleness.cu_per_second_age", 0.5, { unit: "CU·s⁻¹" }),
    gradientRate: makeRate("lifecycle.cu_per_gradient_metre", 0.002, { unit: "CU·m⁻¹" }),
    thermalRate: makeRate("lifecycle.cu_per_thermal_stress_second", 0.001, { unit: "CU·s⁻¹" }),
    churnPerSecond: makeRate("churn.per_second_elapsed", 0.1, { unit: "CU·s⁻¹" }),
    churnWastedTravel: makeRate("churn.wasted_travel_cost", 0.05, { unit: "CU·m⁻¹" }),
  };
}

/**
 * A plan shaped for `Φ`. `distanceM` and the six time components are round numbers so a
 * reviewer can verify `C_direct` in their head.
 */
function plan(overrides) {
  return {
    planId: "plan-1",
    agentId: "agent-1",
    agentClassId: "SIDEWALK_V2",
    legs: [
      {
        legId: "leg-1",
        missionId: "mission-1",
        role: "TERMINAL",
        targetMs: DECISION_TIME_MS + 40 * MINUTE_MS,
        deadlineMs: DECISION_TIME_MS + 60 * MINUTE_MS,
        queueAgeSeconds: 0,
        committed: false,
      },
    ],
    components: {
      waitSeconds: 60,
      approachSeconds: 300,
      serviceFirstSeconds: 120,
      linehaulSeconds: 600,
      serviceLastSeconds: 180,
      terminalSeconds: 0,
    },
    energyWh: 400,
    distanceM: 3000,
    actuatorCycles: { LIFT: 0, DOOR: 2, LATCH: 2 },
    brakingEvents: 20,
    gradientExposureM: 500,
    thermalExposedSeconds: 1260,
    thermalStressMultiplier: 1.2,
    concurrentCommitments: 1,
    horizonEndMs: DECISION_TIME_MS + 45 * MINUTE_MS,
    projectedEndMs: DECISION_TIME_MS + 45 * MINUTE_MS,
    ...(overrides || {}),
  };
}

/**
 * Brand a plan by running the real feasibility gate over the fixture context.
 *
 * @param {object} candidate
 * @returns {object} the same object, branded
 */
function brand(candidate) {
  const gated = evaluate.gate(candidate, feasibilityFixture.context());
  if (!gated.feasible) {
    throw new Error(
      `costFixture.brand: the feasibility fixture no longer satisfies every predicate — ` +
        `${gated.outcome.denials.map((denial) => denial.predicateId).join(", ")}`,
    );
  }
  return gated.candidate;
}

/** A branded plan, ready for `Φ`. */
function brandedPlan(overrides) {
  return brand(plan(overrides));
}

/** `cDirect.evaluate()`'s second argument. */
function directInput() {
  const rate = rates();
  return { lambdaTime: rate.lambdaTime, cuPerWh: rate.cuPerWh, cuPerMetreWear: rate.cuPerMetreWear };
}

/** `cLifecycle.evaluate()`'s second argument, including §14.4's battery arguments. */
function lifecycleInput() {
  const rate = rates();
  return {
    cuPerMetreWear: rate.cuPerMetreWear,
    cuPerActuatorCycle: { LIFT: 0.5, DOOR: 0.02, LATCH: 0.01 },
    cuPerBrakingEvent: 0.03,
    gradientRate: rate.gradientRate,
    thermalRate: rate.thermalRate,
    battery: {
      socThroughput: 0.4,
      curves: {
        dod: [
          { x: 0, y: 1 },
          { x: 1, y: 2 },
        ],
        socMid: [
          { x: 0, y: 1 },
          { x: 1, y: 1 },
        ],
        tempC: [
          { x: 0, y: 1 },
          { x: 40, y: 1 },
        ],
        cRate: [
          { x: 0, y: 1 },
          { x: 2, y: 1 },
        ],
        calendarAgeing: [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
        ],
      },
      conditions: { dod: 0.4, socMid: 0.6, tempC: 20, cRate: 0.5 },
      cuPerEquivalentCycle: 100,
      rest: { restSoc: 0.6, restSeconds: 0 },
    },
  };
}

/** `cRisk.evaluate()`'s second argument. */
function riskInput(overrides) {
  const rate = rates();
  return {
    failure: { probability: 0.01, provenance: "COHORT_PRIOR" },
    failureConsequenceCu: 500,
    tierProbabilities: { T1: 1e-3, T2: 1e-6, T3: 1e-9 },
    energyConsequenceCu: { T1: 50, T2: 5000, T3: 500_000 },
    lateProbability: 0.05,
    overrunMilliCU: 120_000n,
    staleness: {
      safetyRelevantObservations: {
        position: { observedAtMs: DECISION_TIME_MS - 2000 },
        soc: { observedAtMs: DECISION_TIME_MS - 8000 },
      },
      decisionTimeMs: DECISION_TIME_MS,
      stalenessRate: rate.stalenessRate,
    },
    routeHazardCu: 12,
    ...(overrides || {}),
  };
}

/** `cPolicy.evaluate()`'s second argument. */
function policyInput(overrides) {
  return {
    adjustments: [
      { id: "ZONE_AFFINITY", cu: -20, reason: "the agent holds the permit for this zone" },
    ],
    config: {
      "policy.max_zone_affinity_credit": 60,
      "policy.max_dedicated_fleet_credit": 300,
      "policy.max_burn_in_credit": 120,
      "policy.max_pilot_adjustment": 120,
      "policy.max_operator_adjustment": 300,
    },
    decisionTimeMs: DECISION_TIME_MS,
    omegaPolicyCu: 900,
    ...(overrides || {}),
  };
}

/** `cDelay.forLeg()`'s parameters, for the fixture's single terminal Leg. */
function delayParameters(overrides) {
  const rate = rates();
  return {
    slaRate: rate.slaRate,
    breachPenaltyCu: 5000,
    latenessExponent: 2,
    upstreamSlackWeight: 0.15,
    aging: { referencePeriodSeconds: 900, growthExponent: 1.5, maxMultiplier: 8 },
    ...(overrides || {}),
  };
}

/** The completion time map `Φ` reads. */
function completions(overrides) {
  return { "leg-1": DECISION_TIME_MS + 45 * MINUTE_MS, ...(overrides || {}) };
}

/** Everything `phi.evaluate()` needs, assembled. */
function phiInput(overrides) {
  return {
    direct: directInput(),
    risk: riskInput(),
    lifecycle: lifecycleInput(),
    policy: policyInput(),
    completionByLegId: completions(),
    delayParametersFor: () => delayParameters(),
    bounds: { omegaTerminalMilliCU: 5_000_000n, omegaPolicyMilliCU: 900_000n },
    ...(overrides || {}),
  };
}

/**
 * A λ_zone price surface: two zones, one flat bucket each, covering the whole horizon.
 *
 * `zone-rich` is priced at four times `zone-poor`, so a relocation between them produces a
 * relocation component with an unambiguous sign.
 */
function priceSnapshot(overrides) {
  const horizonEndMs = DECISION_TIME_MS + 30 * MINUTE_MS;
  return {
    version: 7,
    publishedAtMs: DECISION_TIME_MS - 1000,
    source: "FORECAST_QUEUEING",
    horizonEndMs,
    zones: {
      "zone-poor": [{ startMs: DECISION_TIME_MS - MINUTE_MS, endMs: horizonEndMs, lambdaCuPerSecond: 0.01 }],
      "zone-rich": [{ startMs: DECISION_TIME_MS - MINUTE_MS, endMs: horizonEndMs, lambdaCuPerSecond: 0.04 }],
    },
    ...(overrides || {}),
  };
}

/** `cOpportunity.evaluate()`'s second argument. */
function opportunityInput(overrides) {
  const snapshot = priceSnapshot();
  return {
    priceSnapshot: snapshot,
    originZoneId: "zone-poor",
    startMs: DECISION_TIME_MS,
    releaseMs: DECISION_TIME_MS + 10 * MINUTE_MS,
    horizonEndMs: snapshot.horizonEndMs,
    startState: { zoneId: "zone-poor", chargeAccessCu: 30, socDeficitCu: 0 },
    endState: { zoneId: "zone-rich", chargeAccessCu: 20, socDeficitCu: 5 },
    omegaTerminalCu: 5000,
    ...(overrides || {}),
  };
}

module.exports = {
  DECISION_TIME_MS,
  MINUTE_MS,
  rates,
  plan,
  brand,
  brandedPlan,
  directInput,
  lifecycleInput,
  riskInput,
  policyInput,
  delayParameters,
  completions,
  phiInput,
  priceSnapshot,
  opportunityInput,
};
