"use strict";

/**
 * Engine lane — §14, the energy model.
 *
 * The plan's testing requirements for this phase, each mapped to a describe block below:
 *
 *   > Unit: consumption model conservation; charge-curve integration against vendor
 *   > curve fixtures; each of the three F34 tier conditions evaluated independently;
 *   > `α[tier]` derived from fleet-year budget, never hand-set; contingency quantile
 *   > derived from `α₁`. Property: energy never increases except while charging;
 *   > reserve layers never traded. Integration: `E_return` against a pinned projection
 *   > is deterministic and replayable; projection staleness beyond max age falls back to
 *   > depot-only.
 */

const fixture = require("./helpers/energyFixture");

const consumption = require("../../src/engine/energy/consumption");
const usable = require("../../src/engine/energy/usable");
const reserves = require("../../src/engine/energy/reserves");
const tiers = require("../../src/engine/energy/tiers");
const eReturn = require("../../src/engine/energy/eReturn");
const wear = require("../../src/engine/energy/wear");
const chargeCurve = require("../../src/engine/energy/chargeCurve");
const midMission = require("../../src/engine/energy/midMission");
const schedulerClient = require("../../src/engine/energy/chargingSchedulerClient");

const f34 = require("../../src/engine/feasibility/predicates/f34");
const f35 = require("../../src/engine/feasibility/predicates/f35");

/* ═══════════════════════════════════════════════════════════════════════════
   §14.2 — the consumption model
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§14.2 the consumption model", () => {
  const model = fixture.energyModelParams();

  test("a flat unloaded kilometre costs the sum of its own terms and nothing else", () => {
    const result = consumption.legEnergyWh(model, fixture.legProfile(), 1);
    expect(result.ok).toBe(true);

    // Every term is checkable by hand against the fixture's coefficients.
    expect(result.terms.distance).toBeCloseTo(100, 9);
    expect(result.terms.mass).toBeCloseTo(0, 9);
    expect(result.terms.climb).toBeCloseTo(0, 9);
    expect(result.terms.regen).toBeCloseTo(0, 9);
    expect(result.terms.moveTime).toBeCloseTo(0.4, 9);
    expect(result.terms.stopStart).toBeCloseTo(2, 9);
    expect(result.terms.dwell).toBeCloseTo(0.06, 9);
    expect(result.terms.aux).toBeCloseTo(1.2, 9);
    expect(result.wh).toBeCloseTo(Object.values(result.terms).slice(0, 10).reduce((a, b) => a + b, 0), 6);
  });

  test("κ scales the whole bracket, not one term", () => {
    const base = consumption.legEnergyWh(model, fixture.legProfile(), 1);
    const scaled = consumption.legEnergyWh(model, fixture.legProfile(), 1.12);
    // "an agent that consistently consumes 12 % more than predicted has κ = 1.12".
    expect(scaled.wh).toBeCloseTo(base.wh * 1.12, 9);
  });

  test("a missing coefficient is reported by name and is never defaulted to zero", () => {
    const withoutClimb = { ...model };
    delete withoutClimb.beta_climb;

    const result = consumption.legEnergyWh(withoutClimb, fixture.legProfile({ climbM: 200 }), 1);
    expect(result.ok).toBe(false);
    expect(result.wh).toBeNull();
    expect(result.missing).toContain("beta_climb");
  });

  test("payload mass and climb both raise the estimate, and regen lowers it", () => {
    const flat = consumption.legEnergyWh(model, fixture.legProfile(), 1).wh;
    const loaded = consumption.legEnergyWh(model, fixture.legProfile({ payloadMassKg: 10 }), 1).wh;
    const climbing = consumption.legEnergyWh(model, fixture.legProfile({ climbM: 50 }), 1).wh;
    const descending = consumption.legEnergyWh(model, fixture.legProfile({ climbM: 50, descentM: 50 }), 1).wh;

    expect(loaded).toBeGreaterThan(flat);
    expect(climbing).toBeGreaterThan(flat);
    expect(descending).toBeLessThan(climbing);
  });

  test("regeneration can never make a leg cost less than nothing", () => {
    // A pathological all-descent profile. §14.5's reserves are additive and none may be
    // traded; a negative leg energy would silently fund another leg's reserve.
    const result = consumption.legEnergyWh(model, fixture.legProfile({ distanceM: 1, descentM: 100_000 }), 1);
    expect(result.ok).toBe(true);
    expect(result.wh).toBeGreaterThanOrEqual(0);
    expect(result.terms.floored).toBe(true);
  });

  describe("β_payload_thermal is charged over t_occupied(k), not over the mission", () => {
    test("an unconditioned compartment draws nothing for conditioning", () => {
      const result = consumption.legEnergyWh(
        model,
        fixture.legProfile({ compartmentOccupancy: [{ compartmentId: "c1", thermalClass: null, occupiedSeconds: 300 }] }),
        1,
      );
      expect(result.ok).toBe(true);
      expect(result.terms.payloadThermal).toBe(0);
    });

    test("half the mission's occupancy costs half the conditioning of the whole mission's", () => {
      const half = consumption.legEnergyWh(
        model,
        fixture.legProfile({ compartmentOccupancy: [{ compartmentId: "c2", thermalClass: "CHILLED", occupiedSeconds: 150 }] }),
        1,
      );
      const whole = consumption.legEnergyWh(
        model,
        fixture.legProfile({ compartmentOccupancy: [{ compartmentId: "c2", thermalClass: "CHILLED", occupiedSeconds: 300 }] }),
        1,
      );
      expect(half.terms.payloadThermal).toBeCloseTo(whole.terms.payloadThermal / 2, 9);
      // "a cold-chain compartment loaded at stop 1 and emptied at stop 2 draws power
      // over that interval and not over the whole mission".
      expect(whole.wh).toBeGreaterThan(half.wh);
    });

    test("a thermal class with no fitted curve is missing, not free", () => {
      const result = consumption.legEnergyWh(
        model,
        fixture.legProfile({ compartmentOccupancy: [{ compartmentId: "c2", thermalClass: "CRYOGENIC", occupiedSeconds: 300 }] }),
        1,
      );
      expect(result.ok).toBe(false);
      expect(result.missing).toContain("beta_payload_thermal.CRYOGENIC");
    });

    test("it is a separate term from β_thermal, so an ambient change moves both independently", () => {
      const cold = consumption.legEnergyWh(model, fixture.legProfile({ ambientC: -10 }), 1);
      const mild = consumption.legEnergyWh(model, fixture.legProfile({ ambientC: 20 }), 1);
      expect(cold.terms.thermal).toBeGreaterThan(mild.terms.thermal);
      expect(cold.terms.payloadThermal).toBe(0);
    });
  });

  test("mission energy is the sum of its legs, and one unusable leg fails the mission", () => {
    const summed = consumption.missionEnergyWh(model, [fixture.legProfile(), fixture.legProfile({ legId: "leg-2" })], 1);
    const single = consumption.legEnergyWh(model, fixture.legProfile(), 1);
    expect(summed.ok).toBe(true);
    expect(summed.wh).toBeCloseTo(single.wh * 2, 9);

    const broken = consumption.missionEnergyWh(model, [fixture.legProfile(), fixture.legProfile({ distanceM: null })], 1);
    expect(broken.ok).toBe(false);
    expect(broken.wh).toBeNull();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §14.5 — the predictive distribution
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§14.5 the predictive distribution of E_mission", () => {
  const inflations = fixture.config()["energy.variance_inflation"];

  test("the variance is inflated, not the standard deviation", () => {
    const none = consumption.predictiveDistribution({
      meanWh: 400,
      residualCv: 0.1,
      inflations,
      severity: { route_novelty: 0, forecast_horizon: 0, weather: 0 },
    });
    const all = consumption.predictiveDistribution({
      meanWh: 400,
      residualCv: 0.1,
      inflations,
      severity: { route_novelty: 1, forecast_horizon: 1, weather: 1 },
    });

    const product = inflations.route_novelty * inflations.forecast_horizon * inflations.weather;
    expect(all.varianceWh2).toBeCloseTo(none.varianceWh2 * product, 6);
    // The two differ by a square root, which at T3's tail probabilities is not a
    // rounding difference.
    expect(all.sdWh).toBeCloseTo(none.sdWh * Math.sqrt(product), 9);
  });

  test("an unstated severity inflates in full — an unquantified uncertainty is not an absent one", () => {
    const unstated = consumption.predictiveDistribution({ meanWh: 400, residualCv: 0.1, inflations });
    const full = consumption.predictiveDistribution({
      meanWh: 400,
      residualCv: 0.1,
      inflations,
      severity: { route_novelty: 1, forecast_horizon: 1, weather: 1 },
    });
    expect(unstated.varianceWh2).toBeCloseTo(full.varianceWh2, 9);
  });

  test("an unresolved residual CV yields no distribution, so F34 cannot be evaluated on a guess", () => {
    const result = consumption.predictiveDistribution({ meanWh: 400, residualCv: null, inflations });
    expect(result.ok).toBe(false);
    expect(result.missing).toContain("energy.model_residual_cv");
  });

  test("the normal CDF and quantile are mutual inverses across the tail F34 works in", () => {
    // The bound asserted is **relative**, because that is the bound the two
    // approximations state: erfc's fractional error is below 1.2e-7 and the probit's
    // below 1.15e-9. At T3's 1e-7 an absolute bound would be meaninglessly loose and at
    // 0.5 it would be meaninglessly tight; the relative bound is the same statement at
    // both ends, and it is the one that matters when the quantity being compared spans
    // five orders of magnitude.
    for (const p of [1e-2, 1e-5, 1e-7, 0.5, 0.99]) {
      const z = consumption.normalQuantile(p);
      const round = consumption.normalCdf(z);
      expect(Math.abs(round - p) / p).toBeLessThan(1e-6);
    }
  });

  test("the tail probabilities are reproducible — a replay reaches the same number", () => {
    const distribution = { meanWh: 400, sdWh: 50 };
    const first = consumption.exceedanceProbability(distribution, 600);
    const second = consumption.exceedanceProbability(distribution, 600);
    expect(first).toBe(second);
    expect(first).toBeLessThan(1e-4);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §14.3 — usable energy
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§14.3 usable energy", () => {
  test("a degraded pack at the same percentage holds materially less energy", () => {
    const healthy = usable.usableWh({ packNominalWh: 1000, soh: 1, fTemp: 1, soc: 0.3, fDerate: 1 });
    const aged = usable.usableWh({ packNominalWh: 1000, soh: 0.7, fTemp: 1, soc: 0.3, fDerate: 1 });

    // "at 70 % state of health, 30 % SoC is 21 % of the nominal energy the threshold
    // was calibrated against" — the second defect §14.1 lists.
    expect(healthy.wh).toBeCloseTo(300, 9);
    expect(aged.wh).toBeCloseTo(210, 9);
  });

  test("f_derate is a divisor — a conservatism factor makes the usable figure smaller", () => {
    const plain = usable.usableWh({ packNominalWh: 1000, soh: 1, fTemp: 1, soc: 1, fDerate: 1 });
    const derated = usable.usableWh({ packNominalWh: 1000, soh: 1, fTemp: 1, soc: 1, fDerate: 1.25 });
    expect(derated.wh).toBeLessThan(plain.wh);
    expect(derated.wh).toBeCloseTo(800, 9);
  });

  test("an absent temperature curve is unknown, never f_temp = 1", () => {
    expect(usable.fTemp({}, 20).ok).toBe(false);
    expect(usable.fTemp({ thermalDeratingCurve: fixture.thermalDeratingCurve() }, 20).fTemp).toBeCloseTo(1, 9);
    expect(usable.fTemp({ thermalDeratingCurve: fixture.thermalDeratingCurve() }, -10).fTemp).toBeCloseTo(0.7, 9);
  });

  test("a derating curve claiming above-nominal capacity is refused, not clamped", () => {
    expect(usable.fTemp({ thermalDeratingCurve: [{ x: 20, y: 1.2 }] }, 20).ok).toBe(false);
  });

  test("the combined conservatism products are read from the publish, and the cap is checked", () => {
    const within = usable.assertWithinCap(fixture.config());
    expect(within.ok).toBe(true);

    const over = usable.assertWithinCap(fixture.config({ "energy.combined_degraded_conservatism": 2.5 }));
    expect(over.ok).toBe(false);
    expect(over.problems.join(" ")).toMatch(/combined degraded/);
  });

  test("internal resistance is reported separately from state of health", () => {
    const signal = usable.resistanceSignal({ internalResistanceMilliOhm: 60, baselineResistanceMilliOhm: 40, resistanceTrendPerCycle: 0.02 });
    expect(signal.ok).toBe(true);
    expect(signal.riseRatio).toBeCloseTo(1.5, 9);
    expect(signal.trendPerCycle).toBeCloseTo(0.02, 9);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §14.5 — the layered reserves
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§14.5 the layered reserve model", () => {
  test("all four layers are required — an absent E_return is not a zero return reserve", () => {
    const composed = reserves.compose({ floorWh: 80, contingencyWh: 40, operationalWh: 0 });
    expect(composed.ok).toBe(false);
    expect(composed.missing).toContain("returnWh");
  });

  test("the layers are additive", () => {
    const composed = reserves.compose(fixture.reserveLayers());
    expect(composed.ok).toBe(true);
    expect(composed.totalWh).toBeCloseTo(240, 9);
  });

  describe("no layer may be traded against another", () => {
    test("funding the return reserve out of contingency is refused", () => {
      const before = fixture.reserveLayers();
      const after = { ...before, returnWh: 150, contingencyWh: 10 };
      const asserted = reserves.assertNoTrade(before, after);

      expect(asserted.ok).toBe(false);
      expect(asserted.traded.map((row) => row.layer)).toEqual(["contingencyWh"]);
      expect(asserted.problems[0]).toMatch(/none may be traded/);
    });

    test("a protected layer rising on its own is always lawful", () => {
      const before = fixture.reserveLayers();
      expect(reserves.assertNoTrade(before, { ...before, returnWh: 200 }).ok).toBe(true);
    });

    test("releasing the one overridable layer is not a trade", () => {
      const before = fixture.reserveLayers({ operationalWh: 50 });
      const released = reserves.releaseOperational(before, "policy: peak demand");
      expect(released.ok).toBe(true);
      expect(reserves.assertNoTrade(before, released.layers).ok).toBe(true);
      expect(released.released.layer).toBe("E_operational");
    });

    test("only E_operational declares itself overridable", () => {
      expect(reserves.LAYERS.filter((layer) => layer.overridable).map((layer) => layer.id)).toEqual(["E_operational"]);
    });
  });

  test("a degradation multiplier scales every layer together, and one below 1 is refused", () => {
    const scaled = reserves.applyMultiplier(fixture.reserveLayers(), 1.4);
    expect(scaled.ok).toBe(true);
    expect(scaled.layers.floorWh).toBeCloseTo(112, 9);
    expect(scaled.layers.returnWh).toBeCloseTo(168, 9);

    const shrunk = reserves.applyMultiplier(fixture.reserveLayers(), 0.9);
    expect(shrunk.ok).toBe(false);
    expect(shrunk.reason).toMatch(/may not relax a Tier 0 constraint/);
  });

  describe("the contingency layer is derived from the quantile, never configured", () => {
    test("it is the distance from the mean to the derived quantile", () => {
      const distribution = { meanWh: 400, sdWh: 50 };
      const contingency = reserves.contingencyWh(distribution, 0.99);
      expect(contingency.ok).toBe(true);
      // z(0.99) ≈ 2.326, so the reserve is ≈ 116 Wh — the excess over the mean, not the
      // quantile itself, because F34 already charges the mean against usable energy.
      expect(contingency.wh).toBeCloseTo(50 * consumption.normalQuantile(0.99), 6);
      expect(contingency.quantileWh).toBeCloseTo(400 + contingency.wh, 6);
    });

    test("an unresolved quantile is refused with the derivation named", () => {
      const contingency = reserves.contingencyWh({ meanWh: 400, sdWh: 50 }, null);
      expect(contingency.ok).toBe(false);
      expect(contingency.reason).toMatch(/DERIVED as 1 − α₁/);
    });

    test("a tighter tier-1 target buys a larger contingency reserve", () => {
      const distribution = { meanWh: 400, sdWh: 50 };
      const loose = reserves.contingencyWh(distribution, 0.95);
      const tight = reserves.contingencyWh(distribution, 0.999);
      expect(tight.wh).toBeGreaterThan(loose.wh);
    });
  });

  test("the offer's energyReserveParams carry the layers unsummed, in watt-hours", () => {
    const params = reserves.offerParams({
      layers: fixture.reserveLayers(),
      packNominalWh: fixture.PACK_NOMINAL_WH,
      targetSoc: 0.8,
      targetSocSource: "SCHEDULER",
    });

    expect(params.ok).toBe(true);
    expect(params.params.floorWh).toBe(80);
    expect(params.params.returnWh).toBe(120);
    expect(params.params.packNominalWh).toBe(1000);
    expect(params.params.overridableLayers).toEqual(["operationalWh"]);
    expect(params.params.targetSocSource).toBe("SCHEDULER");
    // No summed total: sending one would let the agent trade the layers without knowing.
    expect(params.params.totalWh).toBeUndefined();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §14.5 — the three tiers
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§14.5 the three shortfall tiers", () => {
  const config = fixture.config();
  const layers = fixture.reserveLayers();

  const evaluateAt = (meanWh, sdWh, overrides) =>
    tiers.evaluate({
      usableWh: 700,
      distribution: { meanWh, sdWh },
      layers,
      config: overrides ? fixture.config(overrides) : config,
      slaClass: "STANDARD",
    });

  test("all three conditions are evaluated, every time", () => {
    const result = evaluateAt(300, 30);
    expect(result.ok).toBe(true);
    expect(Object.keys(result.tierProbabilities).sort()).toEqual(["T1", "T2", "T3"]);
    expect(result.tiers).toHaveLength(3);
  });

  test("each tier subtracts its own reserve composition and no other", () => {
    const t1 = tiers.thresholdWh(700, layers, tiers.TIERS[0].reserveFields);
    const t2 = tiers.thresholdWh(700, layers, tiers.TIERS[1].reserveFields);
    const t3 = tiers.thresholdWh(700, layers, tiers.TIERS[2].reserveFields);

    expect(t1.reserveWh).toBeCloseTo(240, 9); // floor + return + contingency
    expect(t2.reserveWh).toBeCloseTo(200, 9); // floor + return
    expect(t3.reserveWh).toBeCloseTo(80, 9); //  floor
    // E_operational appears in none of them: efficiency is not safety.
    expect(tiers.TIERS.some((tier) => tier.reserveFields.includes("operationalWh"))).toBe(false);
  });

  test("the conditions are nested — T3's event implies T2's implies T1's", () => {
    const result = evaluateAt(300, 60);
    expect(result.tierProbabilities.T1).toBeGreaterThanOrEqual(result.tierProbabilities.T2);
    expect(result.tierProbabilities.T2).toBeGreaterThanOrEqual(result.tierProbabilities.T3);
    expect(tiers.assertNested(result.tierProbabilities).ok).toBe(true);
  });

  test("a violated nesting is caught rather than reported as three plausible numbers", () => {
    const broken = tiers.assertNested({ T1: 1e-6, T2: 1e-3, T3: 1e-9 });
    expect(broken.ok).toBe(false);
    expect(broken.problems[0]).toMatch(/implies/);
  });

  test("each tier can bind on its own — a long mission binds where a marginal one does not", () => {
    const comfortable = evaluateAt(200, 20);
    expect(comfortable.feasible).toBe(true);

    const marginal = evaluateAt(455, 20);
    expect(marginal.feasible).toBe(false);
    expect(marginal.tiers.find((tier) => tier.tier === "T1").holds).toBe(false);

    const dire = evaluateAt(615, 20);
    expect(dire.feasible).toBe(false);
    expect(dire.tiers.find((tier) => tier.tier === "T3").holds).toBe(false);
  });

  test("the binding tier is the one furthest over its own budget, measured relatively", () => {
    // Targets span 1e-2 to 1e-7, so an absolute probability margin would let T1 always
    // dominate. The exceedance ratio is what §14.5 means by "tightest relative to the
    // distribution's shape at that threshold".
    const result = evaluateAt(560, 40);
    expect(result.feasible).toBe(false);
    const binding = result.tiers.find((tier) => tier.tier === result.bindingTier);
    for (const tier of result.tiers) expect(binding.exceedance).toBeGreaterThanOrEqual(tier.exceedance);
  });

  describe("α[tier] is derived and never hand-set", () => {
    test("it is read from energy.shortfall_probability, which the Config Service derives", () => {
      const resolved = tiers.alphaFor(config, "T2", "STANDARD");
      expect(resolved.ok).toBe(true);
      expect(resolved.alpha).toBe(1e-5);
    });

    test("an unresolved derivation is not a licence to use a per-mission number", () => {
      const resolved = tiers.alphaFor(fixture.config({ "energy.shortfall_probability": null }), "T1", "STANDARD");
      expect(resolved.ok).toBe(false);
      expect(resolved.reason).toMatch(/DERIVED from/);
      expect(evaluateAt(300, 30, { "energy.shortfall_probability": null }).ok).toBe(false);
    });

    test("the Config Service derives it from the governed fleet-year budget", () => {
      const derived = require("../../src/engine/config/derived");
      const result = derived.deriveShortfallProbability({
        "energy.event_budget_per_fleet_year": { T1: 365000, T2: 365, T3: 4 },
        "fleet.agent_count": 5000,
        "fleet.missions_per_agent_year": 7300,
      });
      expect(result.problems).toEqual([]);
      expect(result.value.T1).toBeCloseTo(1e-2, 12);
      expect(result.value.T2).toBeCloseTo(1e-5, 12);
      // A growing fleet re-derives the target automatically — a target adequate at 500
      // agents is not adequate at 5 000, and a hand-set α would never have surfaced it.
      const larger = derived.deriveShortfallProbability({
        "energy.event_budget_per_fleet_year": { T1: 365000, T2: 365, T3: 4 },
        "fleet.agent_count": 50000,
        "fleet.missions_per_agent_year": 7300,
      });
      expect(larger.value.T3).toBeLessThan(result.value.T3);
    });

    test("the contingency quantile is derived from α₁ and the two cannot contradict", () => {
      const derived = require("../../src/engine/config/derived");
      expect(derived.deriveContingencyQuantile({ T1: 1e-2 }).value).toBeCloseTo(0.99, 12);
      expect(derived.DERIVED_PARAMETERS).toContain("energy.contingency_quantile");
      // A 0.95 quantile cannot deliver a 1e-2 tier-1 target, which is why it is derived
      // rather than configured alongside it (§22.1 rule 6).
      expect(derived.rejectHandEnteredDerived([{ name: "energy.contingency_quantile" }])).toHaveLength(1);
    });
  });

  test("the fragment it produces is exactly what F34 and F35 read", () => {
    const evaluated = evaluateAt(200, 20);
    const verdict = { reachable: true, basis: "PINNED_PROJECTION", projectionVersion: 41, chargerId: "c", eReturnWh: 120, surplusWh: 300 };
    const fragment = tiers.planEnergyFragment(evaluated, verdict);

    const context = { mission: { slaClass: "STANDARD" }, plan: { energy: fragment }, config };
    expect(f34.evaluate(context).outcome).toBe("SATISFIED");
    expect(f35.evaluate(context).outcome).toBe("SATISFIED");
  });

  test("F34 and this module agree on which tier binds", () => {
    const evaluated = evaluateAt(560, 40);
    const fragment = tiers.planEnergyFragment(evaluated, null);
    // `planEnergyFragment` returns null when the evaluation failed to resolve; here it
    // resolved and simply reported an infeasible plan, so the fragment exists.
    const result = f34.evaluate({ mission: { slaClass: "STANDARD" }, plan: { energy: fragment }, config });
    expect(result.outcome).toBe("VIOLATED");
    expect(result.observed.bindingTier).toBe(evaluated.bindingTier);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §14.5 — E_return and the availability circularity
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§14.5 E_return", () => {
  const base = () => ({
    candidates: fixture.reachabilityCandidates(),
    projection: fixture.projection(),
    decisionTimeMs: fixture.DECISION_TIME_MS,
    projectedEndMs: fixture.DECISION_TIME_MS + 40 * fixture.MINUTE_MS,
    usableWh: 700,
    missionWh: 300,
    floorWh: 80,
    availabilityMargin: 1.15,
    projectionMaxAgeSeconds: 120,
    uncalibratedReserveFactor: 1.25,
  });

  test("the nearest *available* charger is chosen, not the nearest one geographically", () => {
    const result = eReturn.evaluate(base());
    expect(result.ok).toBe(true);
    // `charger-near` is nearest but the projection shows it OCCUPIED at the projected
    // arrival: "a charger with a 25-minute queue is not a viable reserve destination".
    expect(result.verdict.chargerId).toBe("charger-far");
    expect(result.verdict.reachable).toBe(true);
    expect(result.verdict.eReturnWh).toBeCloseTo(90 * 1.15, 9);
  });

  test("the verdict names the projection version it was computed against", () => {
    const result = eReturn.evaluate(base());
    expect(result.verdict.projectionVersion).toBe(41);
    // F35 refuses a pinned-projection verdict that cannot name one.
    const anonymous = { ...result.verdict, projectionVersion: null };
    expect(f35.evaluate({ plan: { energy: { chargerReachability: anonymous } } }).outcome).toBe("INDETERMINATE");
  });

  test("it is deterministic and replayable — the same pinned inputs give the same verdict", () => {
    const first = eReturn.evaluate(base());
    const second = eReturn.evaluate(base());
    expect(JSON.stringify(second.verdict)).toBe(JSON.stringify(first.verdict));
  });

  test("a projection stale beyond the max age falls back to depot-only, with the factor applied", () => {
    const stale = eReturn.evaluate({
      ...base(),
      projection: fixture.projection({ publishedAtMs: fixture.DECISION_TIME_MS - 600_000 }),
    });

    expect(stale.basis).toBe(eReturn.BASIS.DEPOT_ONLY);
    expect(stale.verdict.chargerId).toBe("depot-1");
    // The envelope shrinks to what can still be established, rather than the constraint
    // being relaxed: the margin *and* the uncalibrated reserve factor both apply.
    expect(stale.verdict.eReturnWh).toBeCloseTo(160 * 1.15 * 1.25, 6);
    expect(stale.degradation.mode).toBe("DEPOT_ONLY_RETURN_TARGETS");
    expect(stale.verdict.projectionVersion).toBeNull();
  });

  test("an absent projection is treated exactly as a stale one", () => {
    const result = eReturn.evaluate({ ...base(), projection: null });
    expect(result.basis).toBe(eReturn.BASIS.DEPOT_ONLY);
    expect(result.verdict.chargerId).toBe("depot-1");
  });

  test("a projected arrival past the horizon is unknown, never availability", () => {
    const result = eReturn.evaluate({
      ...base(),
      projection: fixture.projection({ horizonEndMs: fixture.DECISION_TIME_MS + 60_000 }),
      projectedEndMs: fixture.DECISION_TIME_MS + 10 * 3_600_000,
    });
    expect(result.verdict.reachable).toBe(false);
    expect(result.verdict.considered.every((row) => row.admitted === false)).toBe(true);
  });

  test("no reachable charger yields no E_return layer — not a zero one", () => {
    const none = eReturn.evaluate({ ...base(), candidates: [] });
    expect(none.verdict.reachable).toBe(false);
    const layer = eReturn.returnLayerWh(none.verdict);
    expect(layer.ok).toBe(false);
    expect(reserves.compose({ floorWh: 80, returnWh: layer.returnWh, contingencyWh: 40, operationalWh: 0 }).ok).toBe(false);
  });

  test("a margin below 1 is refused — a conservatism factor may not shrink the reserve", () => {
    const result = eReturn.evaluate({ ...base(), availabilityMargin: 0.9 });
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/may not be below 1/);
  });

  test("its BASIS agrees with F35's, so a verdict is always readable at the gate", () => {
    expect(eReturn.BASIS).toEqual(f35.BASIS);
  });

  test("the settlement observation records optimism without acting on it", () => {
    const observation = eReturn.settlementObservation({
      chargerId: "charger-far",
      projectionVersion: 41,
      projectedWaitSeconds: 60,
      realisedWaitSeconds: 900,
    });
    expect(observation.optimistic).toBe(true);
    expect(observation.kind).toBe("charger_projection_accuracy");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §14.6 — the charge curve
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§14.6 the charging model", () => {
  const curve = fixture.chargePowerCurve();

  const charge = (fromSoc, toSoc, overrides) =>
    chargeCurve.timeToChargeSeconds({
      curve,
      fromSoc,
      toSoc,
      tempC: 20,
      chargerClass: "STANDARD",
      packUsableWh: fixture.PACK_NOMINAL_WH,
      steps: 64,
      ...(overrides || {}),
    });

  test("the last 20 % takes as long as the first 60 % — the property a linear rate cannot express", () => {
    const first60 = charge(0.2, 0.8);
    const last20 = charge(0.8, 1);

    expect(first60.ok).toBe(true);
    expect(last20.ok).toBe(true);
    // §14.6's own claim, checked against the fixture's vendor curve.
    expect(last20.seconds).toBeGreaterThan(first60.seconds);
  });

  test("a linear model would have underestimated the same charge", () => {
    const modelled = charge(0.1, 1);
    // The constant-current rate applied to the whole range — the baseline's assumption.
    const linearSeconds = ((1 - 0.1) * fixture.PACK_NOMINAL_WH * 3600) / 2000;
    expect(modelled.seconds).toBeGreaterThan(linearSeconds);
  });

  test("the integral is additive over sub-ranges, as an integral must be", () => {
    const whole = charge(0.2, 0.9);
    const first = charge(0.2, 0.55);
    const second = charge(0.55, 0.9);
    expect(first.seconds + second.seconds).toBeCloseTo(whole.seconds, 0);
  });

  test("a rapid charger is faster, and a cold pack is slower", () => {
    const standard = charge(0.2, 0.8);
    const rapid = charge(0.2, 0.8, { chargerClass: "RAPID" });
    const cold = charge(0.2, 0.8, { tempC: -10 });

    expect(rapid.seconds).toBeLessThan(standard.seconds);
    expect(cold.seconds).toBeGreaterThan(standard.seconds);
  });

  test("the step count is fixed, so the duration is bit-identical on replay", () => {
    expect(charge(0.2, 0.9).seconds).toBe(charge(0.2, 0.9).seconds);
  });

  test("an uncharacterised charger class is missing, never a default rate", () => {
    const result = charge(0.2, 0.8, { chargerClass: "UNKNOWN_CLASS" });
    expect(result.ok).toBe(false);
    expect(result.missing.join(" ")).toMatch(/UNKNOWN_CLASS/);
  });

  test("a target already met costs nothing", () => {
    const result = charge(0.9, 0.8);
    expect(result.ok).toBe(true);
    expect(result.seconds).toBe(0);
  });

  test("the mean C-rate is a property of the planned charge, not the nameplate", () => {
    const planned = charge(0.2, 0.8);
    const rate = chargeCurve.meanCRate(planned.energyWh, planned.seconds, fixture.PACK_NOMINAL_WH);
    expect(rate).toBeGreaterThan(0);
    expect(rate).toBeLessThan(3);
  });

  describe("charge interruption replaces the 30 % constant with three stated conditions", () => {
    const permitted = {
      reservesIntact: true,
      schedulerConfirms: true,
      missionValueCu: 100,
      wearPremiumCu: 10,
      deferredChargeOpportunityCu: 20,
    };

    test("all three satisfied permits interruption", () => {
      expect(chargeCurve.interruptionPermitted(permitted).permitted).toBe(true);
    });

    test("it permits a short mission at low charge and forbids a long one at higher charge", () => {
      // No state of charge appears anywhere in the decision — which is exactly why one
      // threshold could not do this.
      const shortMissionAt25 = chargeCurve.interruptionPermitted({ ...permitted, missionValueCu: 60, wearPremiumCu: 5, deferredChargeOpportunityCu: 5 });
      const longMissionAt45 = chargeCurve.interruptionPermitted({ ...permitted, reservesIntact: false });
      expect(shortMissionAt25.permitted).toBe(true);
      expect(longMissionAt45.permitted).toBe(false);
    });

    test("an unanswered Scheduler is not a confirming one", () => {
      const result = chargeCurve.interruptionPermitted({ ...permitted, schedulerConfirms: undefined });
      expect(result.permitted).toBe(false);
      expect(result.failed).toContain(chargeCurve.INTERRUPTION_CONDITION.SCHEDULER_CONFIRMS);
    });

    test("value not exceeding cost forbids it", () => {
      const result = chargeCurve.interruptionPermitted({ ...permitted, missionValueCu: 25 });
      expect(result.permitted).toBe(false);
      expect(result.failed).toContain(chargeCurve.INTERRUPTION_CONDITION.VALUE_EXCEEDS_COST);
    });

    test("an unpriced mission is not an interruptible one", () => {
      expect(chargeCurve.interruptionPermitted({ ...permitted, missionValueCu: null }).permitted).toBe(false);
    });
  });

  test("there is no function anywhere in this module that chooses a target SoC", () => {
    const names = Object.keys(chargeCurve).join(" ").toLowerCase();
    expect(names).not.toMatch(/computetarget|choosetarget|targetsoc/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §14.4 — battery wear
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§14.4 battery wear", () => {
  const curves = fixture.stressCurves();

  const cost = (overrides) =>
    wear.batteryWear({
      socThroughput: 0.6,
      curves,
      conditions: { dod: 0.3, socMid: 0.5, tempC: 25, cRate: 1 },
      cuPerEquivalentCycle: 100,
      ...(overrides || {}),
    });

  test("throughput becomes equivalent cycles at two half-cycles to the cycle", () => {
    expect(wear.equivalentCycles(0.6)).toBeCloseTo(0.3, 9);
  });

  test("deep discharges cost superlinearly more — the correct Li-ion policy, unencoded", () => {
    const shallowCycles = cost({ socThroughput: 1.6, conditions: { dod: 0.2, socMid: 0.5, tempC: 25, cRate: 1 } });
    const deepCycle = cost({ socThroughput: 1.6, conditions: { dod: 0.8, socMid: 0.5, tempC: 25, cRate: 1 } });
    // Same throughput, different depth: the optimiser prefers many shallow cycles over
    // few deep ones without any rule saying so.
    expect(deepCycle.cu).toBeGreaterThan(shallowCycles.cu * 2);
  });

  test("high-C-rate charging carries a stress premium", () => {
    const gentle = cost({ conditions: { dod: 0.3, socMid: 0.5, tempC: 25, cRate: 0.2 } });
    const fast = cost({ conditions: { dod: 0.3, socMid: 0.5, tempC: 25, cRate: 3 } });
    expect(fast.cu).toBeGreaterThan(gentle.cu);
  });

  test("resting at very high SoC is mildly penalised", () => {
    const low = cost({ rest: { restSoc: 0.5, restSeconds: 36_000 } });
    const high = cost({ rest: { restSoc: 1, restSeconds: 36_000 } });
    expect(high.cu).toBeGreaterThan(low.cu);
  });

  test("an absent C-rate curve is missing, not free", () => {
    const withoutCRate = { ...curves };
    delete withoutCRate.cRate;
    const result = cost({ curves: withoutCRate });
    expect(result.ok).toBe(false);
    expect(result.missing).toContain("stressCurves.cRate");
  });

  test("an unresolved rate yields no cost, not a zero one", () => {
    const result = cost({ cuPerEquivalentCycle: null });
    expect(result.ok).toBe(false);
    expect(result.missing).toContain(wear.RATE_PARAMETER);
  });

  test("the result is integer milli-CU, which is what Φ compares in", () => {
    const result = cost();
    expect(typeof result.milliCU).toBe("bigint");
    expect(Number(result.milliCU) / 1000).toBeCloseTo(result.cu, 3);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §14.8 — mid-mission energy management
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§14.8 mid-mission energy management", () => {
  const layers = fixture.reserveLayers();

  const assess = (projectedRemainingWh, custodyState) => midMission.assess({ projectedRemainingWh, layers, custodyState });

  test("the five rows are selected by projected remaining energy, most severe first", () => {
    expect(assess(300).row.row).toBe(midMission.ROW.RESERVES_INTACT);
    expect(assess(220).row.row).toBe(midMission.ROW.CONTINGENCY_ERODED);
    expect(assess(150, "NONE").row.row).toBe(midMission.ROW.RETURN_THREATENED_PRE_CUSTODY);
    expect(assess(150, "HELD").row.row).toBe(midMission.ROW.RETURN_THREATENED_CUSTODY_HELD);
    expect(assess(50).row.row).toBe(midMission.ROW.FLOOR_IMMINENT);
  });

  test("the custody split is what makes the two T2 rows different actions", () => {
    expect(assess(150, "NONE").row.action).toBe(midMission.ACTION.ABORT_AND_REASSIGN);
    expect(assess(150, "HELD").row.action).toBe(midMission.ACTION.DIVERT_TO_SAFE_DROP_OR_ESCALATE);
    expect(assess(150, "NONE").row.tier).toBe("T2");
    expect(assess(150, "HELD").row.tier).toBe("T2");
  });

  test("the tiers here are literally F34's tiers, so I17 is verifiable from operational data", () => {
    const tierModule = require("../../src/engine/energy/tiers");
    for (const row of midMission.ROWS) {
      if (!row.tier) continue;
      expect(tierModule.TIER_NAMES).toContain(row.tier);
      expect(midMission.TIER_BY_NAME[row.tier].event).toBe(tierModule.TIERS.find((t) => t.tier === row.tier).event);
    }
  });

  test("a T3 event reached by controlled stop still counts against the T3 budget", () => {
    const assessment = assess(50);
    const event = midMission.budgetEvent(assessment, { agentId: "a1", reachedByControlledStop: true });
    expect(event.tier).toBe("T3");
    expect(event.countsAgainstBudget).toBe(true);
    expect(event.reachedByControlledStop).toBe(true);
  });

  test("an intact-reserves projection produces no budget event", () => {
    expect(midMission.budgetEvent(assess(300), {})).toBeNull();
  });

  test("the divergence trigger is one-sided — consuming less is a calibration observation", () => {
    expect(midMission.hasDiverged({ predictedWh: 100, realisedWh: 130, deviationTolerance: 0.15 }).diverged).toBe(true);
    expect(midMission.hasDiverged({ predictedWh: 100, realisedWh: 70, deviationTolerance: 0.15 }).diverged).toBe(false);
  });

  test("it agrees with §12.3's supervision signal about when a deviation has occurred", () => {
    const progress = require("../../src/engine/supervision/progress");
    const input = { predictedWh: 100, realisedWh: 130, deviationTolerance: 0.15 };
    expect(midMission.hasDiverged(input).diverged).toBe(progress.assessEnergyDeviation(input).fired);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §14.7 — the Charging Scheduler contract
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§14.7 the Charging Scheduler contract", () => {
  test("a projection with no version is refused rather than assigned one", () => {
    const result = schedulerClient.consumeProjection({ publishedAtMs: 1, chargers: [] });
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/charger_availability_version/);
  });

  test("a consumed projection is frozen — a round cannot mutate its own pinned input", () => {
    const result = schedulerClient.consumeProjection(fixture.projection());
    expect(result.ok).toBe(true);
    expect(Object.isFrozen(result.projection)).toBe(true);
    expect(Object.isFrozen(result.projection.chargers)).toBe(true);
  });

  test("reservations arrive as hard constraints in F18's own shape, targetSoc untouched", () => {
    const result = schedulerClient.consumeReservations([
      { agentId: "a1", chargerId: "c1", fromMs: 1000, untilMs: 2000, targetSoc: 0.85, externalId: "ext-1" },
    ]);
    expect(result.ok).toBe(true);
    expect(result.reservations[0].subsystem).toBe("CHARGING");
    expect(result.reservations[0].targetSoc).toBe(0.85);
  });

  describe("target SoC is consumed, never computed", () => {
    const base = {
      publishedTargetSoc: 0.85,
      publishedAtMs: fixture.DECISION_TIME_MS - 60_000,
      decisionTimeMs: fixture.DECISION_TIME_MS,
      maxAgeSeconds: 300,
      classFallback: 0.8,
    };

    test("a fresh published value is used, and is labelled as the Scheduler's", () => {
      const result = schedulerClient.resolveTargetSoc(base);
      expect(result.targetSoc).toBe(0.85);
      expect(result.source).toBe(schedulerClient.TARGET_SOC_SOURCE.SCHEDULER);
      expect(result.degradationFlag).toBeNull();
    });

    test("a stale value falls back to the class default with a degradation flag", () => {
      const result = schedulerClient.resolveTargetSoc({ ...base, publishedAtMs: fixture.DECISION_TIME_MS - 600_000 });
      expect(result.targetSoc).toBe(0.8);
      expect(result.source).toBe(schedulerClient.TARGET_SOC_SOURCE.CLASS_DEFAULT);
      expect(result.degradationFlag.flag).toBe("TARGET_SOC_CLASS_DEFAULT");
    });

    test("with neither a published value nor a class default it refuses — it does not compute one", () => {
      const result = schedulerClient.resolveTargetSoc({ ...base, publishedTargetSoc: null, classFallback: null });
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/does not compute a substitute/);
    });

    test("only two provenances are lawful, and an engine-computed one is refused", () => {
      expect(schedulerClient.assertNotEngineComputed("SCHEDULER").ok).toBe(true);
      expect(schedulerClient.assertNotEngineComputed("CLASS_DEFAULT").ok).toBe(true);
      expect(schedulerClient.assertNotEngineComputed("ENGINE_FORECAST").ok).toBe(false);
      expect(Object.keys(schedulerClient.TARGET_SOC_SOURCE)).toEqual(["SCHEDULER", "CLASS_DEFAULT"]);
    });
  });

  describe("every cross-boundary influence is priced, refusable, and recorded", () => {
    test("an unpriced request is not a request", () => {
      const result = schedulerClient.buildRequest({
        kind: schedulerClient.REQUEST_KIND.REVISE_TARGET_SOC,
        requestId: "r1",
        agentId: "a1",
        requestedTargetSoc: 0.95,
      });
      expect(result.ok).toBe(false);
      expect(result.problems.join(" ")).toMatch(/priced in CU/);
    });

    test("a refusal and a silence are recorded as different dispositions", () => {
      const built = schedulerClient.buildRequest({
        kind: schedulerClient.REQUEST_KIND.RELEASE_RESERVATION,
        requestId: "r2",
        agentId: "a1",
        priceCu: 40,
      });
      expect(built.ok).toBe(true);
      expect(schedulerClient.recordDisposition(built.request, { disposition: "REFUSED" }).disposition).toBe("REFUSED");
      expect(schedulerClient.recordDisposition(built.request, null).disposition).toBe("UNANSWERED");
    });
  });

  test("unavailability reduces the envelope in exactly the three pre-declared ways", () => {
    const envelope = schedulerClient.unavailabilityEnvelope("connection refused");
    expect(envelope.reductions.map((row) => row.id)).toEqual([
      "CHARGE_COMPLETION_ONLY",
      "TARGET_SOC_CLASS_DEFAULT",
      "DEPOT_ONLY_RETURN",
    ]);
    // "agents already charging continue to completion; no interruption is permitted".
    expect(envelope.interruptionPermitted).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §14.2 — κ(a), the self-correcting multiplier
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§14.2 κ(a)", () => {
  const bounds = { min: 0.5, max: 2 };

  test("an agent consistently consuming 12 % more converges on κ ≈ 1.12 within a few missions", () => {
    let kappa = 1;
    for (let mission = 0; mission < 20; mission += 1) {
      // The prediction already carries the current κ, and the pack still draws 12 % more
      // than the class model says.
      const predicted = 100 * kappa;
      const realised = 100 * 1.12;
      kappa = consumption.updateKappa(kappa, { predictedWh: predicted, realisedWh: realised, alpha: 0.2, bounds }).kappa;
    }
    expect(kappa).toBeCloseTo(1.12, 2);
  });

  test("the update is clamped, and the clamp is reported", () => {
    const result = consumption.updateKappa(1.9, { predictedWh: 100, realisedWh: 1000, alpha: 1, bounds });
    expect(result.kappa).toBe(2);
    expect(result.clamped).toBe(true);
  });

  test("a deviation that is not agent-attributable is refused, not folded in", () => {
    const result = consumption.updateKappa(1, { predictedWh: 100, realisedWh: 200, alpha: 0.2, bounds, attributable: false });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not agent-attributable/);
  });

  test("a κ at a bound is a maintenance signal, not merely a planning correction", () => {
    expect(consumption.kappaDriftSignal(2, bounds).atBound).toBe("max");
    expect(consumption.kappaDriftSignal(1.12, bounds).atBound).toBeNull();
    expect(consumption.kappaDriftSignal(1.12, bounds).deviation).toBeCloseTo(0.12, 9);
  });
});
