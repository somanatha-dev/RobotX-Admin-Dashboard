"use strict";

/**
 * Charging lifecycle step E — the simulated charge-rate model (`src/simulation/chargeModel.js`).
 *
 * A SIMULATION ASSUMPTION: no charge rate of the physical RobotX has been measured. The default
 * mode (`ABSOLUTE_W`) is the compatibility path — `constants.CHARGE_POWER_CURVE`, unchanged — and
 * the opt-in `PACK_RELATIVE` mode scales the same shape to the pack by a configurable C-rate. The
 * robot, the scheduler's reservable window and commissioning all read the one model.
 */

const constants = require("../../../src/simulation/constants");
const chargeModel = require("../../../src/simulation/chargeModel");
const chargeCurve = require("../../../src/engine/energy/chargeCurve");
const devChargingScheduler = require("../../../src/simulation/devChargingScheduler");
const simulatedAgentState = require("../../../src/simulation/simulatedAgentState");
const VirtualRobot = require("../../../src/simulation/VirtualRobot");
const cw = require("../../helpers/chargingWorld");

const ABSOLUTE = Object.freeze({ mode: "ABSOLUTE_W", ccCRate: chargeModel.REFERENCE_CC_C_RATE });
const RELATIVE = (ccCRate = chargeModel.REFERENCE_CC_C_RATE) => Object.freeze({ mode: "PACK_RELATIVE", ccCRate });

/** Seconds from `from` to `to` (fractions) on a pack, at a temperature, under given settings. */
function seconds(settings, packWh, from, to, tempC = 20) {
  const out = chargeCurve.timeToChargeSeconds({
    curve: chargeModel.curveFor(packWh, settings),
    fromSoc: from,
    toSoc: to,
    tempC,
    chargerClass: "STANDARD",
    packUsableWh: packWh,
    steps: constants.CHARGE_CURVE_INTEGRATION_STEPS,
  });
  expect(out.ok).toBe(true);
  return out.seconds;
}

const ENV_KEYS = ["SIM_CHARGE_CURVE_MODE", "SIM_CHARGE_CC_C_RATE"];
const saved = {};
beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  for (const key of ENV_KEYS) delete process.env[key];
  chargeModel.resetForTests();
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  chargeModel.resetForTests();
});

describe("settings: the default is the compatibility path; invalid values are refused by name", () => {
  test("defaults: ABSOLUTE_W, and a 2 C pack-relative rate derived from the existing curve (2 000 W / 1 000 Wh)", () => {
    expect(chargeModel.REFERENCE_CC_W).toBe(2000);
    expect(chargeModel.REFERENCE_PACK_WH).toBe(1000);
    expect(chargeModel.resolve({})).toEqual({ settings: { mode: "ABSOLUTE_W", ccCRate: 2 }, problems: [] });
  });

  test("PACK_RELATIVE and a C-rate are read from the environment", () => {
    expect(chargeModel.resolve({ SIM_CHARGE_CURVE_MODE: "pack_relative", SIM_CHARGE_CC_C_RATE: "0.5" }).settings).toEqual({ mode: "PACK_RELATIVE", ccCRate: 0.5 });
  });

  test.each([
    [{ SIM_CHARGE_CURVE_MODE: "FAST" }, /SIM_CHARGE_CURVE_MODE=FAST/],
    [{ SIM_CHARGE_CC_C_RATE: "0" }, /SIM_CHARGE_CC_C_RATE=0/],
    [{ SIM_CHARGE_CC_C_RATE: "11" }, /SIM_CHARGE_CC_C_RATE=11/],
    [{ SIM_CHARGE_CC_C_RATE: "fast" }, /SIM_CHARGE_CC_C_RATE=fast/],
  ])("%j is refused and the default kept", (env, message) => {
    const out = chargeModel.resolve(env);
    expect(out.settings).toEqual({ mode: "ABSOLUTE_W", ccCRate: 2 });
    expect(out.problems.join(" ")).toMatch(message);
  });

  test("labelled a simulation assumption, never a measurement", () => {
    expect(chargeModel.PROVENANCE).toMatchObject({ kind: "SIMULATION_ASSUMPTION", measured: false });
    expect(chargeModel.describe(500)).toMatchObject({ mode: "ABSOLUTE_W", packWh: 500, ccPowerW: 2000, ccCRate: 4, provenance: chargeModel.PROVENANCE });
    expect(chargeModel.describe(500, RELATIVE(1))).toMatchObject({ mode: "PACK_RELATIVE", ccPowerW: 500, ccCRate: 1 });
  });
});

describe("ABSOLUTE_W (default) — existing simulations keep their behaviour exactly", () => {
  test("every pack gets `constants.CHARGE_POWER_CURVE` itself", () => {
    for (const pack of [44.4, 500, 1000, 2000]) expect(chargeModel.curveFor(pack)).toBe(constants.CHARGE_POWER_CURVE);
  });

  test("a fixed 2 000 W: the 500 Wh pack charges 20 → 80 % in half the 1 000 Wh pack's time (4 C vs 2 C)", () => {
    expect(seconds(ABSOLUTE, 500, 0.2, 0.8)).toBeCloseTo(seconds(ABSOLUTE, 1000, 0.2, 0.8) / 2, 6);
    // CC: 0.6 × 1 000 Wh / 2 000 W = 0.3 h.
    expect(seconds(ABSOLUTE, 1000, 0.2, 0.8)).toBeCloseTo(1080, 6);
  });

  test("commissioning writes the unchanged curve, and the scheduler's window is the unchanged integral", () => {
    expect(simulatedAgentState.simulatedPackDeclaration(500).chargePowerCurve).toBe(constants.CHARGE_POWER_CURVE);
    const window = devChargingScheduler.sessionHorizonSeconds(1000);
    const direct = chargeCurve.timeToChargeSeconds({
      curve: constants.CHARGE_POWER_CURVE,
      fromSoc: 0,
      toSoc: 1,
      tempC: -10, // the derating table's slowest point
      chargerClass: "STANDARD",
      packUsableWh: 1000,
      steps: constants.CHARGE_CURVE_INTEGRATION_STEPS,
    });
    // The window is whole seconds, rounded up (never shorter than the integral).
    expect(window.seconds).toBe(Math.ceil(direct.seconds));
  });
});

describe("PACK_RELATIVE — the same shape, scaled to the pack by a configurable C-rate", () => {
  test("at the derived default (2 C) a 1 000 Wh pack charges exactly as before", () => {
    const relative = chargeModel.curveFor(1000, RELATIVE());
    expect(relative.byChargerClass.STANDARD.socCurve).toEqual(constants.CHARGE_POWER_CURVE.byChargerClass.STANDARD.socCurve);
    expect(relative.temperatureDerating).toBe(constants.CHARGE_POWER_CURVE.temperatureDerating);
    expect(seconds(RELATIVE(), 1000, 0.2, 0.8)).toBeCloseTo(seconds(ABSOLUTE, 1000, 0.2, 0.8), 9);
  });

  test("small and large packs take the same time to the same SoC (power scales with the pack)", () => {
    const reference = seconds(RELATIVE(), 1000, 0.2, 0.8);
    for (const pack of [44.4, 250, 500, 2000, 5000]) {
      expect(seconds(RELATIVE(), pack, 0.2, 0.8)).toBeCloseTo(reference, 6);
      expect(chargeModel.curveFor(pack, RELATIVE()).byChargerClass.STANDARD.socCurve[0].y).toBeCloseTo(2 * pack, 9);
    }
  });

  test("the C-rate is the calibration knob: 1 C takes twice as long as 2 C through the CC segment", () => {
    expect(seconds(RELATIVE(1), 500, 0.2, 0.8)).toBeCloseTo(2 * seconds(RELATIVE(2), 500, 0.2, 0.8), 6);
    // 0.6 of the pack at 1 C = 0.6 h.
    expect(seconds(RELATIVE(1), 500, 0.2, 0.8)).toBeCloseTo(2160, 6);
  });

  test("target SoC: the taper above 80 % is kept — 80 → 100 % is slower per point than 20 → 80 %", () => {
    const cc = seconds(RELATIVE(), 500, 0.2, 0.8) / 60;
    const cv = seconds(RELATIVE(), 500, 0.8, 1.0) / 20;
    expect(cv).toBeGreaterThan(cc);
    expect(seconds(RELATIVE(), 500, 0.2, 0.8)).toBeLessThan(seconds(RELATIVE(), 500, 0.2, 1.0));
  });

  test("temperature derating is kept: at 0 °C (factor 0.6) the CC segment takes 1/0.6 as long as at 20 °C", () => {
    expect(seconds(RELATIVE(), 500, 0.2, 0.8, 0)).toBeCloseTo(seconds(RELATIVE(), 500, 0.2, 0.8, 20) / 0.6, 6);
    expect(seconds(RELATIVE(), 500, 0.2, 0.8, -10)).toBeCloseTo(seconds(RELATIVE(), 500, 0.2, 0.8, 20) / 0.35, 6);
  });
});

describe("one model for the robot, the scheduler and commissioning (PACK_RELATIVE set in the environment)", () => {
  const robotWith = (packWh, telemetryIntervalMs) => {
    const robot = new VirtualRobot({
      robotId: "SIM-E-RATE",
      lat: 12.9,
      lon: 77.5,
      logger: cw.silentLogger,
      kv: cw.makeFlash(),
      simulated: true,
      specification: { packNominalWh: packWh, normalSpeedMps: 2, maxSpeedMps: 2.5, massKg: 20, payloadCapacityKg: 3, batteryReservePct: 15 },
      ...(telemetryIntervalMs ? { telemetryIntervalMs } : {}),
    });
    robot._packC = 20;
    return robot;
  };

  test("the robot's per-tick gain is the same for a 250 Wh and a 2 000 Wh pack (and 4× smaller for the 250 Wh pack under ABSOLUTE_W)", () => {
    const gain = (pack) => {
      const robot = robotWith(pack);
      robot.battery = 40;
      return robot._chargeStepPercent();
    };
    const absoluteSmall = gain(250);
    const absoluteLarge = gain(2000);
    expect(absoluteSmall).toBeCloseTo(8 * absoluteLarge, 6);

    process.env.SIM_CHARGE_CURVE_MODE = "PACK_RELATIVE";
    chargeModel.resetForTests();
    expect(gain(250)).toBeCloseTo(gain(2000), 9);
  });

  test("simulation time: the tick period does not change the rate — charge is per simulated second", () => {
    process.env.SIM_CHARGE_CURVE_MODE = "PACK_RELATIVE";
    chargeModel.resetForTests();
    const charged = (intervalMs, ticks) => {
      const robot = robotWith(500, intervalMs);
      robot.battery = 30;
      let gained = 0;
      for (let i = 0; i < ticks; i += 1) gained += robot._chargeStepPercent();
      return gained;
    };
    expect(charged(500, 40)).toBeCloseTo(charged(2000, 10), 2);
    // 20 s at 2 C = 1/90 of an hour at 200 %/h ≈ 1.11 points.
    expect(charged(2000, 10)).toBeCloseTo((20 / 3600) * 200, 2);
  });

  test("the robot's time to its target, the scheduler's window and the commissioned curve all follow the pack", () => {
    process.env.SIM_CHARGE_CURVE_MODE = "PACK_RELATIVE";
    process.env.SIM_CHARGE_CC_C_RATE = "1";
    chargeModel.resetForTests();

    const robot = robotWith(500);
    robot.battery = 20;
    robot._chargingPhase = "CHARGING";
    robot._publishedTargetSoc = 0.8;
    expect(robot.chargeSecondsRemaining()).toBeCloseTo(seconds(RELATIVE(1), 500, 0.2, 0.8), 6);
    expect(robot.chargingView().rateModel).toMatchObject({ mode: "PACK_RELATIVE", ccPowerW: 500, ccCRate: 1, provenance: { kind: "SIMULATION_ASSUMPTION" } });

    // Pack-independent window: a 500 Wh and a 2 000 Wh pack reserve the same worst-case session.
    expect(devChargingScheduler.sessionHorizonSeconds(500).seconds).toBeCloseTo(devChargingScheduler.sessionHorizonSeconds(2000).seconds, 6);
    expect(simulatedAgentState.simulatedPackDeclaration(500).chargePowerCurve.byChargerClass.STANDARD.socCurve[0].y).toBeCloseTo(500, 9);
  });
});
