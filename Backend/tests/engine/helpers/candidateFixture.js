"use strict";

/**
 * Fixtures for Phase 9 — §6's candidate generation and admissible bound.
 *
 * Reuses `costFixture`'s rate/delay-parameter builders rather than restating them,
 * so a candidate test and a cost test price time and energy identically — which is
 * the whole admissibility argument's premise (§6.4: `LB` and `γ` must be
 * denominated in the same rates to be comparable at all).
 */

const { makeRate } = require("../../../src/engine/cost/exchangeRates");
const { COEFFICIENT } = require("../../../src/engine/energy/consumption");
const costFixture = require("./costFixture");

const DECISION_TIME_MS = costFixture.DECISION_TIME_MS;
const MINUTE_MS = costFixture.MINUTE_MS;

/** Bengaluru-ish coordinates, arbitrary but fixed so distances are reproducible. */
const ORIGIN = Object.freeze({ lat: 12.9716, lon: 77.5946 });
const NEARBY = Object.freeze({ lat: 12.98, lon: 77.6 }); // ~1.1 km from ORIGIN

/**
 * `LB(a, l)`'s rate pair, built at the same values `costFixture.rates()` uses for
 * `cost.lambda_time`/`cost.energy.cu_per_wh`, so `cost.lambda_time_floor` here can
 * be swept independently while staying comparable to `γ`.
 *
 * @param {{ lambdaTimeFloor?: number, cuPerWh?: number }} [overrides]
 */
function boundRates(overrides) {
  const applied = overrides || {};
  return {
    lambdaTimeFloor: makeRate("cost.lambda_time_floor", applied.lambdaTimeFloor ?? 1, { unit: "CU·s⁻¹" }),
    cuPerWh: makeRate("cost.energy.cu_per_wh", applied.cuPerWh ?? 1, { unit: "CU·Wh⁻¹" }),
  };
}

/**
 * @param {object} [overrides]
 * @returns {object} `lowerBound()`'s `agent` argument
 */
function agentSnapshot(overrides) {
  return {
    agentId: "agent-1",
    lat: ORIGIN.lat,
    lon: ORIGIN.lon,
    mobilityModel: { kinematicLimits: { maxSpeedMs: 2 } },
    ...(overrides || {}),
  };
}

/**
 * @param {object} [overrides]
 * @returns {object} `lowerBound()`'s `energy` argument
 */
function energyInput(overrides) {
  return {
    kappa: 1,
    model: { [COEFFICIENT.DIST]: 0.02 }, // Wh/m
    ...(overrides || {}),
  };
}

/**
 * @param {object} [overrides]
 * @returns {object} `lowerBound()`'s `leg` argument — spatial fields plus
 *   `cost/cDelay.forLeg`'s own fields, so one object serves both.
 */
function legForBound(overrides) {
  return {
    legId: "leg-1",
    missionId: "mission-1",
    firstStopLat: NEARBY.lat,
    firstStopLon: NEARBY.lon,
    earliestPossibleCompletionMs: DECISION_TIME_MS + 5 * MINUTE_MS,
    role: "TERMINAL",
    targetMs: DECISION_TIME_MS + 40 * MINUTE_MS,
    deadlineMs: DECISION_TIME_MS + 60 * MINUTE_MS,
    queueAgeSeconds: 0,
    ...(overrides || {}),
  };
}

/** `cost/cDelay.forLeg`'s `parameters`, reusing `costFixture`'s values. */
function delayParameters(overrides) {
  return costFixture.delayParameters(overrides);
}

/**
 * A zero correction — the common case for tests that are not exercising Ω_terminal
 * or Ω_policy specifically.
 *
 * @param {bigint} [milliCU]
 * @returns {{ milliCU: bigint, breakdown: null }}
 */
function zeroCorrection(milliCU) {
  return { milliCU: milliCU ?? 0n, breakdown: null };
}

module.exports = {
  DECISION_TIME_MS,
  MINUTE_MS,
  ORIGIN,
  NEARBY,
  boundRates,
  agentSnapshot,
  energyInput,
  legForBound,
  delayParameters,
  zeroCorrection,
};
