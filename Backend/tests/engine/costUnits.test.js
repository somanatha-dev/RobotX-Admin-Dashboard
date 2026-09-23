"use strict";

/**
 * Engine lane — the CU and its dimensioned exchange rates (§1.3, §8.10).
 *
 * The baseline priced with `C(r) = w1·D + w2·(1−B) + w3·U + w4·T + w5·Z`, weights
 * summing to 1, each candidate set rescaled into [0, 1]. §1.3 prohibits that outright
 * and states five capabilities it makes unreachable. These tests hold the replacement
 * to its two structural promises: costs are absolute and additive, and every
 * conversion into CU carries an explicit dimension.
 */

const units = require("../../src/engine/cost/units");
const rates = require("../../src/engine/cost/exchangeRates");
const service = require("../../src/engine/config/service");
const fixedPoint = require("../../src/engine/determinism/fixedPoint");

describe("the cost unit", () => {
  test("quotes the specification's own definition, so an explanation and the spec agree", () => {
    expect(units.CU_DEFINITION).toMatch(/one second of committed time of a reference agent class/);
  });

  test("carries costs as int64 milli-CU", () => {
    expect(units.cu(1.5).milliCU).toBe(1500n);
    expect(units.cu(1.5).dimension).toBe(units.DIMENSION.CU);
  });

  test("is additive: a total is the exact sum of its terms, in any order", () => {
    const terms = [units.cu(1200.5), units.cu(-340.25), units.cu(0.125), units.cu(9)];
    const forwards = units.total(...terms);
    const backwards = units.total(...[...terms].reverse());
    expect(forwards.milliCU).toBe(backwards.milliCU);
    expect(forwards.milliCU).toBe(fixedPoint.toMilliCU(1200.5 - 340.25 + 0.125 + 9));
  });

  test("supports negative terms, because C_opportunity and C_policy may be negative", () => {
    expect(units.cu(-500).milliCU).toBe(-500000n);
    expect(units.total(units.cu(100), units.cu(-250)).milliCU).toBe(-150000n);
  });

  test("a 10 km mission costs more than a 1 km one — the property min-max cannot satisfy", () => {
    const perMetre = rates.makeRate("cost.wear.cu_per_metre", 0.002);
    const short = rates.apply(perMetre, 1000, "m");
    const long = rates.apply(perMetre, 10000, "m");
    expect(fixedPoint.compare(long.milliCU, short.milliCU)).toBe(1);
    // Under min-max both would be (0, 1) regardless of the absolute gap.
  });

  test("behaves correctly with a single candidate, which is the common case in a sparse fleet", () => {
    const only = units.cu(4100);
    expect(units.toCurrency(only, 1)).toBe(4100);
    // Under min-max a single candidate scores 0.5 on every relative term, so the
    // terms silently vanish.
  });

  test("maintains the currency view alongside the CU view, as §1.3 requires of every cost", () => {
    const view = units.views(units.cu(3600), 2);
    expect(view).toEqual({ milliCU: "3600000", cu: 3600, currency: 1800, dimension: "CU" });
  });

  test("refuses a non-positive currency rate rather than dividing by it", () => {
    expect(() => units.toCurrency(units.cu(1), 0)).toThrow(/positive finite rate/);
  });

  test("refuses a value that is not a CU-dimensioned cost", () => {
    expect(() => units.assertCost(4100, "test")).toThrow(/expected a CU-dimensioned cost/);
    expect(() => units.assertCost({ milliCU: 1n, dimension: "CU·s⁻¹" })).toThrow(/expected dimension CU/);
  });

  test("normalisation is refused by name, with the reason", () => {
    for (const kind of units.PROHIBITED_NORMALISATIONS) {
      expect(() => units.refuseNormalisation(kind, "phi")).toThrow(new RegExp(`${kind} normalisation`));
    }
    expect(() => units.refuseNormalisation("min-max")).toThrow(/prohibited \(§1\.3\)/);
  });
});

describe("exchange rates", () => {
  test("every rate declares its dimension", () => {
    for (const [name, dimension] of Object.entries(rates.RATE_DIMENSIONS)) {
      expect(rates.makeRate(name, 1).dimension).toBe(dimension);
    }
  });

  test("a rate cannot price the wrong quantity", () => {
    const perWh = rates.makeRate("cost.energy.cu_per_wh", 0.0004);
    expect(rates.apply(perWh, 500, "Wh").milliCU).toBe(fixedPoint.toMilliCU(0.2));
    expect(() => rates.apply(perWh, 500, "m")).toThrow(/prices Wh, not m/);
  });

  test("an unregistered rate cannot be constructed — that is the no-magic-constants mechanism", () => {
    expect(() => rates.makeRate("cost.my_tuning_knob", 0.5)).toThrow(/not a registered exchange rate/);
  });

  test("a rate whose register unit disagrees with the engine's dimension is refused", () => {
    expect(() => rates.makeRate("cost.energy.cu_per_wh", 1, { unit: "CU·m⁻¹" })).toThrow(
      /applied to the wrong quantity produces a plausible-looking wrong number/,
    );
  });

  test("an unset rate is refused rather than defaulted to zero or one", () => {
    expect(() => rates.makeRate("cost.energy.cu_per_wh", null)).toThrow(/An unset rate cannot be used to price/);
  });

  test("a negative price is refused", () => {
    expect(() => rates.makeRate("cost.wear.cu_per_metre", -1)).toThrow(/a price is not negative/);
  });

  test("only the dimensionless factors the specification names may multiply a priced quantity", () => {
    const cost = units.cu(100);
    expect(rates.applyDimensionlessFactor(cost, 2, "cost.sla.lateness_exponent").milliCU).toBe(200000n);
    expect(() => rates.applyDimensionlessFactor(cost, 0.7, "cost.terminal_value_weight")).toThrow(
      /unregistered second exchange rate/,
    );
  });

  test("V_terminal's components carry no weighting coefficients, so none is registered", () => {
    const entries = service.loadRegister().entries;
    const suspicious = [...entries.keys()].filter((name) => /terminal.*(weight|coefficient)/i.test(name));
    expect(suspicious).toEqual([]);
  });

  test("rates are built from the Config Service, carrying the scope level that supplied each", () => {
    const snapshot = service.buildSnapshot({
      bindings: [{ level: "region", key: "eu-west", name: "cost.energy.cu_per_wh", value: 0.0005 }],
    });
    const built = rates.ratesFrom(snapshot, { region: "eu-west" });
    expect(built["cost.energy.cu_per_wh"].value).toBe(0.0005);
    expect(built["cost.energy.cu_per_wh"].provenance.level).toBe("region");
    // What this asserts is that the provenance carries the register's *own* calibration
    // status through, not that the status is any particular one. It used to name
    // `UNCALIBRATED` as a literal, which made an ordinary §22.4 status change — the V1
    // demonstration moved this entry to `PROVISIONAL` — look like a defect in `ratesFrom`.
    const registered = service.loadRegister().entries.get("cost.energy.cu_per_wh").calibrationStatus;
    expect(built["cost.energy.cu_per_wh"].provenance.calibrationStatus).toBe(registered);
    expect(["DERIVED", "PROVISIONAL", "UNCALIBRATED"]).toContain(registered);
  });

  test("an unset rate is simply absent rather than silently zero", () => {
    const built = rates.ratesFrom(service.defaultSnapshot(), {});
    expect(built["cost.energy.cu_per_wh"]).toBeUndefined();
    expect(built["cost.lambda_time_floor"].value).toBe(0.2);
  });

  test("the absolute-CU parameters are not mistaken for rates", () => {
    for (const name of rates.ABSOLUTE_CU_PARAMETERS) {
      expect({ name, isRate: Object.prototype.hasOwnProperty.call(rates.RATE_DIMENSIONS, name) }).toEqual({
        name,
        isRate: false,
      });
    }
  });
});
