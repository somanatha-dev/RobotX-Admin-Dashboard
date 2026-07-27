"use strict";

/**
 * Engine lane — derived parameters (§22.1 rule 6, §14.5, §14.3, §8.6, §6.4).
 *
 * > Derived parameters are computed by the Config Service, never hand-entered. A
 * > parameter whose value must satisfy an identity with another parameter is a
 * > derived parameter, and permitting it to be set by hand permits the identity to be
 * > violated silently.
 *
 * Each identity is tested twice: that it computes the number the specification states,
 * and that the Config Service refuses a hand-entered value for it.
 */

const service = require("../../src/engine/config/service");
const derived = require("../../src/engine/config/derived");

const entries = service.loadRegister().entries;
const bind = (name, value, level = "global", key = "") => ({ level, key, name, value });

describe("α[tier] — the energy shortfall targets (§14.5)", () => {
  test("derives to exactly the per-mission targets §14.5 states, from the fleet-year budgets", () => {
    const snapshot = service.defaultSnapshot();
    const alpha = snapshot.resolve("energy.shortfall_probability");

    // §14.5: at N = 5 000 and r_d = 20 — 36.5 million missions per year — the tier
    // budgets 365 000 / 365 / 4 compose to 1e-2, 1e-5 and ≈1e-7.
    expect(alpha.T1).toBeCloseTo(1e-2, 12);
    expect(alpha.T2).toBeCloseTo(1e-5, 12);
    expect(alpha.T3).toBeCloseTo(1.0958904109589041e-7, 18);
  });

  test("re-derives automatically when the fleet grows — a target adequate at 500 agents is not adequate at 5 000", () => {
    const small = service.buildSnapshot({ bindings: [bind("fleet.agent_count", 500)] });
    const large = service.buildSnapshot({ bindings: [bind("fleet.agent_count", 50000)] });

    expect(small.resolve("energy.shortfall_probability").T3).toBeGreaterThan(
      large.resolve("energy.shortfall_probability").T3,
    );
    // The composed fleet-year budget is what is governed, so it is unchanged.
    expect(small.resolve("energy.event_budget_per_fleet_year")).toEqual(
      large.resolve("energy.event_budget_per_fleet_year"),
    );
  });

  test("is refused when the composed budget or the fleet size is unavailable", () => {
    const result = derived.deriveShortfallProbability({ "fleet.agent_count": 5000 });
    expect(result.value).toBeNull();
    expect(result.problems.join(" ")).toMatch(/event_budget_per_fleet_year/);
  });
});

describe("energy.contingency_quantile — derived as 1 − α₁ (§14.5)", () => {
  test("equals 1 − α[T1] and moves with it", () => {
    const snapshot = service.defaultSnapshot();
    expect(snapshot.resolve("energy.contingency_quantile")).toBeCloseTo(0.99, 12);

    const tightened = service.buildSnapshot({
      bindings: [bind("energy.event_budget_per_fleet_year", { T1: 36500, T2: 365, T3: 4 })],
    });
    const alpha = tightened.resolve("energy.shortfall_probability").T1;
    expect(tightened.resolve("energy.contingency_quantile")).toBeCloseTo(1 - alpha, 12);
  });

  test("a hand-entered quantile is refused — 0.95 cannot deliver a 1e-2 tier-1 target", () => {
    const { result } = service.validateCandidate({ bindings: [bind("energy.contingency_quantile", 0.95)] });
    const v3 = result.blocking.filter((item) => item.id === "V3");
    expect(v3.length).toBeGreaterThan(0);
    expect(v3[0].message).toMatch(/0\.95 quantile cannot deliver a 1e-2 tier-1 target/);
  });
});

describe("Ω_policy — the sum of the C_policy credit ceilings (§8.6, §6.4)", () => {
  test("is the sum of every declared ceiling", () => {
    const snapshot = service.defaultSnapshot();
    const ceilings = [...entries.values()].filter((entry) => entry.creditCeiling);
    const expected = ceilings.reduce((total, entry) => total + snapshot.resolve(entry.name), 0);
    expect(snapshot.resolve("cost.policy.max_total_credit")).toBe(expected);
  });

  test("updates as a mechanical consequence of changing a constituent ceiling", () => {
    const base = service.defaultSnapshot().resolve("cost.policy.max_total_credit");
    const raised = service.buildSnapshot({ bindings: [bind("policy.max_operator_adjustment", 1000)] });
    expect(raised.resolve("cost.policy.max_total_credit")).toBe(
      base - service.defaultSnapshot().resolve("policy.max_operator_adjustment") + 1000,
    );
  });

  test("a C_policy adjustment without a usable ceiling makes the pruning bound inadmissible and is refused", () => {
    const result = derived.derivePolicyTotalCredit(
      [{ name: "policy.max_zone_affinity_credit", creditCeiling: true }],
      {},
    );
    expect(result.value).toBeNull();
    expect(result.problems.join(" ")).toMatch(/candidate-pruning lower bound admissible/);
  });

  test("is refused when hand-entered", () => {
    const { result } = service.validateCandidate({ bindings: [bind("cost.policy.max_total_credit", 5)] });
    expect(result.blocking.some((item) => item.id === "A2")).toBe(true);
  });
});

describe("combined energy conservatism (§14.3)", () => {
  test("multiplies exactly the energy-domain factors active in nominal operation", () => {
    const snapshot = service.defaultSnapshot();
    const expected =
      snapshot.resolve("energy.f_derate") *
      snapshot.resolve("energy.charger_availability_margin") *
      snapshot.resolve("energy.uncalibrated_reserve_factor");
    expect(snapshot.resolve("energy.combined_nominal_conservatism")).toBeCloseTo(expected, 12);
  });

  test("the degraded product is the nominal one times the multipliers a mode can activate", () => {
    const snapshot = service.defaultSnapshot();
    expect(snapshot.resolve("energy.combined_degraded_conservatism")).toBeCloseTo(
      snapshot.resolve("energy.combined_nominal_conservatism") *
        snapshot.resolve("route.degraded_reserve_factor"),
      12,
    );
  });

  test("does not multiply in factors from other domains — a product across incommensurable quantities is meaningless", () => {
    const snapshot = service.defaultSnapshot();
    const nominal = snapshot.resolve("energy.combined_nominal_conservatism");
    // payload.safety_factor and execute.eta_tolerance both declare conservatism, in
    // other domains. Neither may appear in the energy product.
    expect(nominal).not.toBeCloseTo(nominal * snapshot.resolve("execute.eta_tolerance"), 6);
    expect(Object.keys(snapshot.derivationEvidence.conservatism.factors.nominal)).not.toContain(
      "payload.safety_factor",
    );
  });

  test("two factors compensating for the same uncertainty is reported as a defect, not as extra safety", () => {
    const result = derived.deriveCombinedConservatism(
      [
        { name: "a.factor", conservatism: { compensates: "vendor-curve optimism", activeInNominal: true } },
        { name: "b.factor", conservatism: { compensates: "vendor-curve optimism", activeInNominal: true } },
      ],
      { "a.factor": 1.1, "b.factor": 1.2 },
    );
    expect(result.duplicateCompensations.join(" ")).toMatch(/both compensate for "vendor-curve optimism"/);
  });

  test("a conservatism factor that does not declare what it compensates for is refused", () => {
    const result = derived.deriveCombinedConservatism(
      [{ name: "a.factor", conservatism: { activeInNominal: true } }],
      { "a.factor": 1.1 },
    );
    expect(result.problems.join(" ")).toMatch(/does not declare what uncertainty it compensates for/);
  });
});

describe("§22.1 rule 6 — no derived parameter may be hand-entered", () => {
  test("every parameter the Config Service computes is protected", () => {
    for (const name of derived.DERIVED_PARAMETERS) {
      const problems = derived.rejectHandEnteredDerived([{ name, level: "global" }]);
      expect({ name, refused: problems.length > 0 }).toEqual({ name, refused: true });
    }
  });

  test("Ω_terminal names where it is derived instead, since it is derived per round rather than at publish", () => {
    const problems = derived.rejectHandEnteredDerived([{ name: "cost.opportunity.max_terminal_gain" }]);
    expect(problems[0]).toMatch(/Capacity Pricing Service/);
  });
});
