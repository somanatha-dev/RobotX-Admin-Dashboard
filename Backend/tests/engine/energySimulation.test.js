"use strict";

/**
 * Engine lane — Phase 7's two gates.
 *
 * **The simulation gate.** The plan requires:
 *
 * > Simulation: T1/T2/T3 event frequencies match budgeted rates in a long simulated run
 * > (I17 at T1/T2 timescales).
 *
 * §14.5 governs the budget in fleet-year terms and derives `α` down to a per-mission
 * probability. This suite closes the loop in the opposite direction: it admits missions
 * through F34's three conditions, draws a realised consumption from the same predictive
 * distribution, and counts how often each tier's event actually occurs among the
 * admitted missions. The realised rate must sit at or below the budgeted `α`.
 *
 * T3 is checked structurally rather than by frequency, and that is stated rather than
 * quietly skipped: `α₃ = 1e-7` needs on the order of 10⁸ missions to estimate at all,
 * which is a fleet-year of operational data and not a unit test. What is checkable in a
 * test is that the T3 condition binds where it should and that the three realised rates
 * are nested — the same property §14.5 states of the conditions themselves.
 *
 * **The percentage-floor gate.** The plan's completion criterion:
 *
 * > **Gate:** no percentage-based energy floor remains anywhere in the decision path.
 *
 * A source scan proves it, rather than a claim in a report.
 */

const fs = require("fs");
const path = require("path");

const fixture = require("./helpers/energyFixture");

const consumption = require("../../src/engine/energy/consumption");
const reserves = require("../../src/engine/energy/reserves");
const tiers = require("../../src/engine/energy/tiers");
const chargeCurve = require("../../src/engine/energy/chargeCurve");

const BACKEND_ROOT = path.join(__dirname, "..", "..");

/* ═══════════════════════════════════════════════════════════════════════════
   The simulation gate — realised event rates against the budget (I17)
   ═══════════════════════════════════════════════════════════════════════════ */

describe("realised tier event rates match their budgeted rates (I17)", () => {
  /**
   * One simulated fleet-day.
   *
   * Each mission draws a distance, projects its energy through the §14.2 model, sizes
   * its reserves through §14.5, and is admitted only if all three F34 conditions hold.
   * The realised consumption is then drawn from the same predictive distribution the
   * decision was taken on, and the tier events are counted.
   *
   * @param {number} missions
   * @param {number} seed
   * @returns {object}
   */
  function run(missions, seed) {
    const uniform = fixture.seededUniform(seed);
    const normal = fixture.seededNormal(uniform);
    const model = fixture.energyModelParams();
    const config = fixture.config();
    const alpha = config["energy.shortfall_probability"];

    const usableWh = 700;
    const floorWh = 80;
    const returnWh = 120;

    const counts = { offered: 0, admitted: 0, T1: 0, T2: 0, T3: 0 };

    for (let index = 0; index < missions; index += 1) {
      counts.offered += 1;

      // A spread of mission lengths, so the admitted set is a mixture rather than one
      // point — a single distance would make the realised rate a property of that one
      // distance and tell us nothing about the constraint.
      const distanceM = 500 + uniform() * 4000;
      const projected = consumption.legEnergyWh(model, fixture.legProfile({ distanceM, totalSeconds: distanceM / 4 }), 1);
      if (!projected.ok) continue;

      const distribution = consumption.predictiveDistribution({
        meanWh: projected.wh,
        residualCv: config["energy.model_residual_cv"],
        inflations: config["energy.variance_inflation"],
        severity: { route_novelty: 0.2, forecast_horizon: 0.2, weather: 0.2 },
      });
      if (!distribution.ok) continue;

      const contingency = reserves.contingencyWh(distribution, config["energy.contingency_quantile"]);
      const layers = reserves.compose({ floorWh, returnWh, contingencyWh: contingency.wh, operationalWh: 0 });
      if (!layers.ok) continue;

      const evaluated = tiers.evaluate({ usableWh, distribution, layers: layers.layers, config, slaClass: "STANDARD" });
      if (!evaluated.ok || !evaluated.feasible) continue;

      counts.admitted += 1;

      // The realised draw, from the distribution the decision was taken on.
      const realisedWh = Math.max(0, distribution.meanWh + normal() * distribution.sdWh);
      const remaining = usableWh - realisedWh;

      if (remaining < floorWh + returnWh + contingency.wh) counts.T1 += 1;
      if (remaining < floorWh + returnWh) counts.T2 += 1;
      if (remaining < floorWh) counts.T3 += 1;
    }

    return {
      ...counts,
      rates: {
        T1: counts.admitted > 0 ? counts.T1 / counts.admitted : 0,
        T2: counts.admitted > 0 ? counts.T2 / counts.admitted : 0,
        T3: counts.admitted > 0 ? counts.T3 / counts.admitted : 0,
      },
      alpha,
    };
  }

  const result = run(60_000, 20260804);

  test("the run admits a substantial fraction of the missions it is offered", () => {
    // A gate that admitted nothing would trivially satisfy every rate bound while
    // proving only that the fleet had stopped working.
    expect(result.admitted).toBeGreaterThan(result.offered * 0.3);
  });

  test("the realised T1 rate sits at or below its budgeted α₁", () => {
    // T1 is "an operating-cost line: ~1 % of missions incur an unplanned charge
    // diversion", and it is the one tier a test-sized run can estimate directly.
    expect(result.rates.T1).toBeLessThanOrEqual(result.alpha.T1);
  });

  test("the realised T2 rate sits at or below its budgeted α₂", () => {
    expect(result.rates.T2).toBeLessThanOrEqual(result.alpha.T2);
  });

  test("the realised rates are nested, exactly as the conditions they came from are", () => {
    expect(result.rates.T1).toBeGreaterThanOrEqual(result.rates.T2);
    expect(result.rates.T2).toBeGreaterThanOrEqual(result.rates.T3);
  });

  test("α₃ is stated as unestimable at this sample size rather than silently passed", () => {
    // ~1e-7 needs on the order of 10⁸ missions. Recording the arithmetic here is what
    // stops a future reader mistaking "0 T3 events in 60 000 missions" for evidence.
    const missionsNeeded = 1 / result.alpha.T3;
    expect(missionsNeeded).toBeGreaterThan(result.offered * 100);
    expect(result.rates.T3).toBe(0);
  });

  test("the run is reproducible — the same seed gives the same counts", () => {
    const again = run(5_000, 99);
    const once = run(5_000, 99);
    expect(again.admitted).toBe(once.admitted);
    expect(again.T1).toBe(once.T1);
  });

  test("a fleet planned with no contingency reserve breaches its T1 budget", () => {
    // The counterfactual that makes the passing result mean something: remove the layer
    // §14.5 sizes at the T1 quantile, and the T1 event rate stops being budgeted.
    const uniform = fixture.seededUniform(7);
    const normal = fixture.seededNormal(uniform);
    const model = fixture.energyModelParams();
    const config = fixture.config();

    let admitted = 0;
    let events = 0;

    for (let index = 0; index < 20_000; index += 1) {
      const distanceM = 500 + uniform() * 4000;
      const projected = consumption.legEnergyWh(model, fixture.legProfile({ distanceM, totalSeconds: distanceM / 4 }), 1);
      const distribution = consumption.predictiveDistribution({
        meanWh: projected.wh,
        residualCv: config["energy.model_residual_cv"],
        inflations: config["energy.variance_inflation"],
        severity: { route_novelty: 0.2, forecast_horizon: 0.2, weather: 0.2 },
      });

      // Admitted on the mean alone — the deterministic margin §14.5 rejects.
      if (700 - distribution.meanWh < 200) continue;
      admitted += 1;

      const realisedWh = Math.max(0, distribution.meanWh + normal() * distribution.sdWh);
      if (700 - realisedWh < 200) events += 1;
    }

    expect(admitted).toBeGreaterThan(0);
    expect(events / admitted).toBeGreaterThan(config["energy.shortfall_probability"].T1);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   The percentage-floor gate
   ═══════════════════════════════════════════════════════════════════════════ */

describe("no percentage-based energy floor remains in the decision path", () => {
  /**
   * Every runtime module in the engine tree, with its source.
   * @returns {Array<[string, string]>}
   */
  function engineModules() {
    const root = path.join(BACKEND_ROOT, "src", "engine");
    const found = [];
    const walk = (absolute, relative) => {
      for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
        const child = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(path.join(absolute, entry.name), child);
        else if (entry.name.endsWith(".js") && !child.startsWith("guards/")) {
          found.push([`src/engine/${child}`, fs.readFileSync(path.join(absolute, entry.name), "utf8")]);
        }
      }
    };
    walk(root, "");
    return found;
  }

  const MODULES = engineModules();

  test("the engine tree is being scanned, not an empty list", () => {
    expect(MODULES.length).toBeGreaterThan(90);
  });

  test("no engine module imports the legacy percentage constants", () => {
    // `dtaro.constants.js` is retained as a compatibility shim for the legacy
    // dispatcher, which retires at Phase 15 with its consumers. What Phase 7's gate
    // requires is that nothing in the *decision path* reads it.
    const offenders = MODULES.filter(([, source]) => /dtaro\.constants/.test(source)).map(([name]) => name);
    expect(offenders).toEqual([]);
  });

  test("no engine module reads the legacy battery-threshold register entries", () => {
    const offenders = MODULES.filter(([, source]) =>
      /legacy\.dtaro\.(battery_threshold_pct|charging_interrupt_battery_pct)/.test(source),
    ).map(([name]) => name);
    expect(offenders).toEqual([]);
  });

  test("no engine module names the baseline's 20 % / 30 % floors as behavioural constants", () => {
    const offenders = MODULES.filter(([, source]) =>
      /\b(BATTERY_THRESHOLD|CHARGING_INTERRUPT_BATTERY|batteryThreshold|minBatteryPercent|batteryFloorPercent)\b/.test(source),
    ).map(([name]) => name);
    expect(offenders).toEqual([]);
  });

  test("the reserve model is denominated in watt-hours throughout", () => {
    // Every layer field, and every reserve parameter the register carries, is Wh or a
    // dimensionless multiplier of one. A percentage floor cannot be expressed in this
    // vocabulary, which is the structural half of the gate.
    for (const layer of reserves.LAYERS) expect(layer.field).toMatch(/Wh$/);

    const service = require("../../src/engine/config/service");
    const { entries } = service.loadRegister();
    expect(entries.get("energy.reserve_floor_wh").unit).toBe("Wh");
    expect(entries.get("energy.operational_reserve_wh").unit).toBe("Wh");
  });

  test("the tier conditions are probabilities over watt-hours, not comparisons of percentages", () => {
    for (const tier of tiers.TIERS) {
      for (const field of tier.reserveFields) expect(field).toMatch(/Wh$/);
    }
  });

  test("charge interruption reads no state of charge at all", () => {
    // §14.6's replacement for the fixed 30 % threshold: three stated conditions, none of
    // which is a charge level. It "correctly permits interruption at 25 % for a 400 m
    // mission while forbidding it at 45 % for a 9 km one, which no single threshold can
    // do" — because it never asks.
    const source = fs.readFileSync(path.join(BACKEND_ROOT, "src", "engine", "energy", "chargeCurve.js"), "utf8");
    const body = source.slice(source.indexOf("function interruptionPermitted"));
    expect(body).not.toMatch(/\bsoc\b/i);
    expect(body).not.toMatch(/battery/i);
  });

  test("the legacy shim still exists and still resolves, for the dispatcher that retires at Phase 15", () => {
    // Stated as a test rather than left implicit: Phase 7 removes the percentage floor
    // from the *decision path*, and removing the shim would break a legacy path Phase 7
    // was not asked to change. The two facts belong together.
    const dtaro = require("../../src/config/dtaro.constants");
    expect(dtaro.BATTERY_THRESHOLD).toBe(20);
    expect(dtaro.CHARGING_INTERRUPT_BATTERY).toBe(30);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §14.6 — the simulator reasons from the server's inputs
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the simulator and the server reason from identical inputs (§14.6)", () => {
  const simulationConstants = require("../../src/simulation/constants");

  test("the simulator integrates the server's own charge-curve module", () => {
    const source = fs.readFileSync(path.join(BACKEND_ROOT, "src", "simulation", "VirtualRobot.js"), "utf8");
    // "so the two sides reason from identical inputs by construction rather than by a
    // shared constant that a future edit could desynchronise".
    expect(source).toMatch(/require\("\.\.\/engine\/energy\/chargeCurve"\)/);
  });

  test("its curve is in the shape the server's integrator reads, and tapers past 80 %", () => {
    const first60 = chargeCurve.timeToChargeSeconds({
      curve: simulationConstants.CHARGE_POWER_CURVE,
      fromSoc: 0.2,
      toSoc: 0.8,
      tempC: simulationConstants.CHARGE_PACK_TEMPERATURE_C,
      chargerClass: simulationConstants.CHARGE_CHARGER_CLASS,
      packUsableWh: simulationConstants.PACK_NOMINAL_WH,
      steps: simulationConstants.CHARGE_CURVE_INTEGRATION_STEPS,
    });
    const last20 = chargeCurve.timeToChargeSeconds({
      curve: simulationConstants.CHARGE_POWER_CURVE,
      fromSoc: 0.8,
      toSoc: 1,
      tempC: simulationConstants.CHARGE_PACK_TEMPERATURE_C,
      chargerClass: simulationConstants.CHARGE_CHARGER_CLASS,
      packUsableWh: simulationConstants.PACK_NOMINAL_WH,
      steps: simulationConstants.CHARGE_CURVE_INTEGRATION_STEPS,
    });

    expect(first60.ok).toBe(true);
    expect(last20.ok).toBe(true);
    expect(last20.seconds).toBeGreaterThan(first60.seconds);
  });

  test("its integration step count matches the register's seeded default", () => {
    const service = require("../../src/engine/config/service");
    expect(simulationConstants.CHARGE_CURVE_INTEGRATION_STEPS).toBe(
      service.defaultSnapshot().resolve("energy.charge_curve_integration_steps"),
    );
  });

  test("its target-SoC fallback matches the register's, and it computes no target of its own", () => {
    const service = require("../../src/engine/config/service");
    expect(simulationConstants.TARGET_SOC_FALLBACK).toBe(service.defaultSnapshot().resolve("energy.target_soc_fallback"));

    const source = fs.readFileSync(path.join(BACKEND_ROOT, "src", "simulation", "VirtualRobot.js"), "utf8");
    const body = source.slice(source.indexOf("  _targetSocPercent() {"));
    // It reads a published value or the class default, and there is no third branch.
    expect(body.slice(0, 400)).toMatch(/_publishedTargetSoc/);
    expect(body.slice(0, 400)).toMatch(/TARGET_SOC_FALLBACK/);
  });

  test("the legacy linear rate is retained but is no longer what the simulator charges at", () => {
    expect(simulationConstants.CHARGING_RATE_PER_TICK).toBe(0.1);
    const source = fs.readFileSync(path.join(BACKEND_ROOT, "src", "simulation", "VirtualRobot.js"), "utf8");
    const body = source.slice(source.indexOf("  _chargeStepPercent() {"));
    // Reachable only when the curve cannot be evaluated at all.
    expect(body.slice(0, 1200)).toMatch(/if \(!integrated\.ok[\s\S]*?CHARGING_RATE_PER_TICK/);
  });
});
