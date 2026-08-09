"use strict";

/**
 * `candidates/omega.js` — Ω_terminal and Ω_policy (§6.4).
 */

const omega = require("../../src/engine/candidates/omega");
const { buildSnapshot, defaultSnapshot } = require("../../src/engine/config/service");

describe("§6.4 — opportunityTermActive", () => {
  test("active by default when no snapshot has a kill-switch state (falls back to not-thrown reading)", () => {
    expect(omega.opportunityTermActive(null)).toBe(true);
  });

  test("inactive when the default snapshot's killSwitchState throws opportunity_cost_term (§1.8 rule 3 baseline)", () => {
    const snapshot = defaultSnapshot();
    expect(snapshot.killSwitchState.opportunity_cost_term).toBe(true);
    expect(omega.opportunityTermActive(snapshot)).toBe(false);
  });

  test("active when the switch is explicitly not thrown", () => {
    const snapshot = buildSnapshot({ killSwitchState: { opportunity_cost_term: false } });
    expect(omega.opportunityTermActive(snapshot)).toBe(true);
  });
});

describe("§6.4 — omegaPolicyMilliCU", () => {
  test("resolves cost.policy.max_total_credit from the default snapshot", () => {
    const snapshot = defaultSnapshot();
    const result = omega.omegaPolicyMilliCU(snapshot, {});
    expect(result.ok).toBe(true);
    expect(typeof result.milliCU).toBe("bigint");
    expect(result.milliCU >= 0n).toBe(true);
  });

  test("reports a problem rather than fabricating a value when there is no snapshot", () => {
    const result = omega.omegaPolicyMilliCU(null, {});
    expect(result.ok).toBe(false);
    expect(result.milliCU).toBeNull();
  });

  test("reports a problem when resolve() throws", () => {
    const throwing = { resolve: () => { throw new Error("boom"); } };
    const result = omega.omegaPolicyMilliCU(throwing, {});
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toMatch(/did not resolve/);
  });

  test("reports a problem on a negative resolved value", () => {
    const negative = { resolve: () => -5 };
    const result = omega.omegaPolicyMilliCU(negative, {});
    expect(result.ok).toBe(false);
  });
});

describe("§6.4 — omegaTerminalMilliCU", () => {
  test("is exactly zero and marked inactive when the opportunity term is thrown", () => {
    const snapshot = defaultSnapshot();
    const result = omega.omegaTerminalMilliCU({ snapshot });
    expect(result).toEqual({ ok: true, milliCU: 0n, cu: 0, active: false, problems: [] });
  });

  test("requires a non-negative omegaTerminalCu when the term is active", () => {
    const snapshot = buildSnapshot({ killSwitchState: { opportunity_cost_term: false } });
    const missing = omega.omegaTerminalMilliCU({ snapshot });
    expect(missing.ok).toBe(false);
    expect(missing.active).toBe(true);

    const negative = omega.omegaTerminalMilliCU({ snapshot, omegaTerminalCu: -1 });
    expect(negative.ok).toBe(false);

    const supplied = omega.omegaTerminalMilliCU({ snapshot, omegaTerminalCu: 5000 });
    expect(supplied.ok).toBe(true);
    expect(supplied.milliCU).toBe(5_000_000n);
  });
});

describe("§6.4 — combinedCorrection", () => {
  test("sums Ω_policy and Ω_terminal when the opportunity term is active", () => {
    const snapshot = buildSnapshot({ killSwitchState: { opportunity_cost_term: false } });
    const policyOnly = omega.omegaPolicyMilliCU(snapshot, {});
    expect(policyOnly.ok).toBe(true);

    const result = omega.combinedCorrection({ snapshot, omegaTerminalCu: 100 });
    expect(result.ok).toBe(true);
    expect(result.correctionMilliCU).toBe(policyOnly.milliCU + 100_000n);
  });

  test("is Ω_policy alone when the opportunity term is inactive (§1.8 rule 3 baseline)", () => {
    const snapshot = defaultSnapshot();
    const policyOnly = omega.omegaPolicyMilliCU(snapshot, {});
    const result = omega.combinedCorrection({ snapshot });
    expect(result.ok).toBe(true);
    expect(result.correctionMilliCU).toBe(policyOnly.milliCU);
  });

  test("collects problems from both halves rather than stopping at the first", () => {
    const result = omega.combinedCorrection({ snapshot: null });
    expect(result.ok).toBe(false);
    expect(result.problems.length).toBeGreaterThan(0);
  });
});
