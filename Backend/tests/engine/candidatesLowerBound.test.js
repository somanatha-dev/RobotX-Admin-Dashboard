"use strict";

/**
 * `candidates/lowerBound.js` — unit-level coverage of `LB(a,l)` (§6.4).
 * `candidateAdmissibility.test.js` covers the admissibility property itself
 * (`LB ≤ γ`) exhaustively; this file covers the function's own contract: which
 * inputs are required, and that it never fabricates a value for one that is
 * missing (T2 — unknown is never permission, applied to a bound as much as to a
 * predicate).
 */

const { lowerBound, maxSpeedMsOf } = require("../../src/engine/candidates/lowerBound");
const f = require("./helpers/candidateFixture");

function baseInput(overrides) {
  return {
    agent: f.agentSnapshot(),
    waitUntilAvailableSeconds: 0,
    energy: f.energyInput(),
    leg: f.legForBound(),
    rates: f.boundRates(),
    delayParameters: f.delayParameters(),
    correction: f.zeroCorrection(),
    ...(overrides || {}),
  };
}

describe("§6.4 — maxSpeedMsOf", () => {
  test("reads kinematicLimits.maxSpeedMs when positive and finite", () => {
    expect(maxSpeedMsOf(f.agentSnapshot())).toBe(2);
  });

  test("returns null for a missing, zero, negative, or non-finite speed", () => {
    expect(maxSpeedMsOf({})).toBeNull();
    expect(maxSpeedMsOf({ mobilityModel: { kinematicLimits: { maxSpeedMs: 0 } } })).toBeNull();
    expect(maxSpeedMsOf({ mobilityModel: { kinematicLimits: { maxSpeedMs: -1 } } })).toBeNull();
    expect(maxSpeedMsOf({ mobilityModel: { kinematicLimits: { maxSpeedMs: Number.NaN } } })).toBeNull();
  });
});

describe("§6.4 — lowerBound() required inputs", () => {
  test("succeeds with every required field present", () => {
    const result = lowerBound(baseInput());
    expect(result.ok).toBe(true);
    expect(typeof result.milliCU).toBe("bigint");
  });

  test.each([
    ["agent.lat/lon", { agent: { ...f.agentSnapshot(), lat: undefined } }],
    ["agent kinematic limit", { agent: { ...f.agentSnapshot(), mobilityModel: null } }],
    ["waitUntilAvailableSeconds", { waitUntilAvailableSeconds: undefined }],
    ["negative wait", { waitUntilAvailableSeconds: -1 }],
    ["energy.kappa", { energy: { model: f.energyInput().model } }],
    ["energy.model.beta_dist", { energy: { kappa: 1, model: {} } }],
    ["leg first stop", { leg: { ...f.legForBound(), firstStopLat: undefined } }],
    ["leg earliest completion", { leg: { ...f.legForBound(), earliestPossibleCompletionMs: undefined } }],
    ["cost.lambda_time_floor rate", { rates: { cuPerWh: f.boundRates().cuPerWh } }],
    ["cost.energy.cu_per_wh rate", { rates: { lambdaTimeFloor: f.boundRates().lambdaTimeFloor } }],
    ["the Ω correction", { correction: null }],
  ])("reports ok:false, not a fabricated bound, when %s is missing", (_label, overrides) => {
    const result = lowerBound(baseInput(overrides));
    expect(result.ok).toBe(false);
    expect(result.milliCU).toBeNull();
    expect(result.missing.length).toBeGreaterThan(0);
  });

  test("propagates a cost/cDelay refusal (e.g. an unstated Leg role) as its own missing reason", () => {
    const result = lowerBound(baseInput({ leg: { ...f.legForBound(), role: undefined } }));
    expect(result.ok).toBe(false);
    expect(result.missing.some((entry) => entry.startsWith("cost.cDelay:"))).toBe(true);
  });
});

describe("§6.4 — monotonicity sanity checks", () => {
  test("a farther first stop never produces a smaller bound, all else equal", () => {
    const near = lowerBound(baseInput());
    const far = lowerBound(
      baseInput({ leg: { ...f.legForBound(), firstStopLat: 13.5, firstStopLon: 78.2 } }),
    );
    expect(near.ok).toBe(true);
    expect(far.ok).toBe(true);
    expect(far.milliCU >= near.milliCU).toBe(true);
  });

  test("a larger Ω correction never produces a larger bound", () => {
    const zero = lowerBound(baseInput({ correction: f.zeroCorrection(0n) }));
    const large = lowerBound(baseInput({ correction: f.zeroCorrection(1_000_000n) }));
    expect(large.milliCU).toBeLessThan(zero.milliCU);
    expect(large.milliCU).toBe(zero.milliCU - 1_000_000n);
  });

  test("the bound may go negative once the correction exceeds the positive terms", () => {
    const result = lowerBound(baseInput({ correction: f.zeroCorrection(1_000_000_000n) }));
    expect(result.ok).toBe(true);
    expect(result.milliCU < 0n).toBe(true);
  });
});
