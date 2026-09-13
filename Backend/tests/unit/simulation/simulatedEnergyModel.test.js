/**
 * T3 — the simulator consumes energy through §14.2's model, and the environment reaches it.
 *
 * ── Two things are being established, and they are different ────────────────
 *   1. **The wiring is real.** When the coefficients and the profile are complete, the
 *      discharge is whatever `energy/consumption.legEnergyWh` says — and payload, vehicle
 *      mass, gradient and temperature each move it. These tests supply a fixture
 *      coefficient set to demonstrate that; no coefficient is declared in production.
 *   2. **The refusal is real.** With this deployment's actual data — every β null, no
 *      terrain source — the model refuses, the tick is labelled `LEGACY_PERCENTAGE`, and
 *      the missing inputs are named rather than defaulted.
 *
 * The fixture coefficients below exist **only inside this file**. They are not a
 * calibration, they are not written anywhere, and their presence here is not a claim that
 * anybody has fitted them. They are the arithmetic needed to prove that the terms are
 * connected.
 */

const VirtualRobot = require("../../../src/simulation/VirtualRobot");
const simulatedEnergy = require("../../../src/simulation/simulatedEnergy");
const environment = require("../../../src/simulation/simulatedEnvironment");
const consumption = require("../../../src/engine/energy/consumption");

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

/**
 * A complete §14.2 coefficient set — FIXTURE ONLY.
 *
 * Not fitted, not declared, not persisted. Every value is a round number chosen so the
 * arithmetic in these tests is checkable by hand.
 */
const FIXTURE_COEFFICIENTS = Object.freeze({
  beta_dist: 0.01,
  beta_mass: 0.001,
  beta_climb: 0.02,
  beta_regen: 0.01,
  beta_move_time: 0.002,
  beta_stop_start: 0.05,
  beta_dwell: 0.001,
  beta_aux: 0.0005,
  eta_regen: 0.5,
  beta_thermal: {
    // Draw rises with ambient and with pack temperature — the shape a cooling load has.
    ambientCurve: [{ x: 20, y: 0.0001 }, { x: 40, y: 0.002 }],
    packCurve: [{ x: 20, y: 0.0001 }, { x: 40, y: 0.003 }],
  },
  beta_payload_thermal: {},
});

const BASE_PROFILE = Object.freeze({
  distanceM: 500,
  climbM: 0,
  descentM: 0,
  movingSeconds: 400,
  dwellSeconds: 50,
  totalSeconds: 450,
  stopStartCycles: 2,
  payloadMassKg: 0,
  vehicleMassKg: 2,
  ambientC: 28,
  packC: 30,
  compartmentOccupancy: [],
});

describe("T3 — consumption goes through legEnergyWh, and the terms are connected", () => {
  test("the simulator's tick energy IS legEnergyWh's answer, not an approximation of it", () => {
    const outcome = simulatedEnergy.tickEnergy({
      model: FIXTURE_COEFFICIENTS,
      profile: BASE_PROFILE,
      kappa: 1,
      packNominalWh: 300,
      legacyPercent: 0.0444,
    });

    const direct = consumption.legEnergyWh(FIXTURE_COEFFICIENTS, BASE_PROFILE, 1);

    expect(outcome.basis).toBe(simulatedEnergy.ENERGY_BASIS.MODELLED);
    expect(direct.ok).toBe(true);
    // Identical, because it is the same call. A second equation anywhere would show here.
    expect(outcome.wh).toBe(direct.wh);
    expect(outcome.socDeltaPercent).toBeCloseTo((direct.wh / 300) * 100, 10);
  });

  test("payload mass increases consumption", () => {
    const empty = simulatedEnergy.tickEnergy({
      model: FIXTURE_COEFFICIENTS, profile: { ...BASE_PROFILE, payloadMassKg: 0 },
      kappa: 1, packNominalWh: 300, legacyPercent: 0,
    });
    const loaded = simulatedEnergy.tickEnergy({
      model: FIXTURE_COEFFICIENTS, profile: { ...BASE_PROFILE, payloadMassKg: 5 },
      kappa: 1, packNominalWh: 300, legacyPercent: 0,
    });

    expect(loaded.basis).toBe(simulatedEnergy.ENERGY_BASIS.MODELLED);
    expect(loaded.wh).toBeGreaterThan(empty.wh);
  });

  test("vehicle mass affects consumption on a climb", () => {
    // `beta_mass` is charged on payload only; vehicle mass enters through the climb and
    // regen terms, so the gradient is what makes it observable.
    const climbing = { ...BASE_PROFILE, climbM: 20 };
    const light = simulatedEnergy.tickEnergy({
      model: FIXTURE_COEFFICIENTS, profile: { ...climbing, vehicleMassKg: 1 },
      kappa: 1, packNominalWh: 300, legacyPercent: 0,
    });
    const heavy = simulatedEnergy.tickEnergy({
      model: FIXTURE_COEFFICIENTS, profile: { ...climbing, vehicleMassKg: 3 },
      kappa: 1, packNominalWh: 300, legacyPercent: 0,
    });

    expect(heavy.wh).toBeGreaterThan(light.wh);
  });

  test("terrain affects consumption when legitimate terrain exists", () => {
    const flat = simulatedEnergy.tickEnergy({
      model: FIXTURE_COEFFICIENTS, profile: { ...BASE_PROFILE, climbM: 0, descentM: 0 },
      kappa: 1, packNominalWh: 300, legacyPercent: 0,
    });
    const uphill = simulatedEnergy.tickEnergy({
      model: FIXTURE_COEFFICIENTS, profile: { ...BASE_PROFILE, climbM: 30, descentM: 0 },
      kappa: 1, packNominalWh: 300, legacyPercent: 0,
    });
    const downhill = simulatedEnergy.tickEnergy({
      model: FIXTURE_COEFFICIENTS, profile: { ...BASE_PROFILE, climbM: 0, descentM: 30 },
      kappa: 1, packNominalWh: 300, legacyPercent: 0,
    });

    expect(uphill.wh).toBeGreaterThan(flat.wh);
    expect(downhill.wh).toBeLessThan(flat.wh); // regen recovers, and never below zero
    expect(downhill.wh).toBeGreaterThanOrEqual(0);
  });

  test("temperature reaches the model — a hotter pack and ambient cost more", () => {
    const cool = simulatedEnergy.tickEnergy({
      model: FIXTURE_COEFFICIENTS, profile: { ...BASE_PROFILE, ambientC: 25, packC: 25 },
      kappa: 1, packNominalWh: 300, legacyPercent: 0,
    });
    const hot = simulatedEnergy.tickEnergy({
      model: FIXTURE_COEFFICIENTS, profile: { ...BASE_PROFILE, ambientC: 35, packC: 38 },
      kappa: 1, packNominalWh: 300, legacyPercent: 0,
    });

    // If the temperatures were displayed but not wired, these would be equal.
    expect(hot.wh).toBeGreaterThan(cool.wh);
  });

  test("κ scales the result, as §14.2's multiplier", () => {
    const unity = simulatedEnergy.tickEnergy({
      model: FIXTURE_COEFFICIENTS, profile: BASE_PROFILE, kappa: 1,
      packNominalWh: 300, legacyPercent: 0,
    });
    const drifted = simulatedEnergy.tickEnergy({
      model: FIXTURE_COEFFICIENTS, profile: BASE_PROFILE, kappa: 1.2,
      packNominalWh: 300, legacyPercent: 0,
    });
    expect(drifted.wh).toBeCloseTo(unity.wh * 1.2, 10);
  });
});

describe("T3 — missing inputs refuse rather than default", () => {
  test("absent coefficients refuse, and name themselves", () => {
    const allNull = {
      beta_dist: null, beta_mass: null, beta_climb: null, beta_regen: null,
      beta_move_time: null, beta_stop_start: null, beta_dwell: null, beta_aux: null,
      eta_regen: null, beta_thermal: null, beta_payload_thermal: null,
    };
    const outcome = simulatedEnergy.tickEnergy({
      model: allNull, profile: BASE_PROFILE, kappa: 1, packNominalWh: 300, legacyPercent: 0.0444,
    });

    expect(outcome.basis).toBe(simulatedEnergy.ENERGY_BASIS.LEGACY);
    expect(outcome.wh).toBeNull();
    expect(outcome.missing).toEqual(expect.arrayContaining(["beta_dist", "beta_thermal"]));
    // The fallback is used, and it is the caller's declared legacy rate — not an invented one.
    expect(outcome.socDeltaPercent).toBe(0.0444);
  });

  test("absent terrain refuses — it is never silently treated as flat", () => {
    const profile = simulatedEnergy.buildLegProfile({
      distanceM: 100, movingSeconds: 60, dwellSeconds: 0, totalSeconds: 60,
      stopStartCycles: 1, vehicleMassKg: 2, payloadMassKg: 0, ambientC: 28, packC: 30,
      terrain: null,
    });

    expect(profile.climbM).toBeUndefined();
    expect(profile.descentM).toBeUndefined();

    const outcome = simulatedEnergy.tickEnergy({
      model: FIXTURE_COEFFICIENTS, profile, kappa: 1, packNominalWh: 300, legacyPercent: 0.0444,
    });
    expect(outcome.basis).toBe(simulatedEnergy.ENERGY_BASIS.LEGACY);
    expect(outcome.missing).toEqual(expect.arrayContaining(["profile.climbM", "profile.descentM"]));
  });

  test("an absent vehicle mass refuses rather than guessing a mass", () => {
    const profile = simulatedEnergy.buildLegProfile({
      distanceM: 100, movingSeconds: 60, dwellSeconds: 0, totalSeconds: 60,
      stopStartCycles: 1, vehicleMassKg: undefined, payloadMassKg: 0,
      ambientC: 28, packC: 30, terrain: { climbM: 0, descentM: 0 },
    });
    const outcome = simulatedEnergy.tickEnergy({
      model: FIXTURE_COEFFICIENTS, profile, kappa: 1, packNominalWh: 300, legacyPercent: 0.0444,
    });

    expect(outcome.basis).toBe(simulatedEnergy.ENERGY_BASIS.LEGACY);
    expect(outcome.missing).toContain("profile.vehicleMassKg");
  });

  test("an absent pack capacity cannot express Wh as SoC, and says so", () => {
    const outcome = simulatedEnergy.tickEnergy({
      model: FIXTURE_COEFFICIENTS, profile: BASE_PROFILE, kappa: 1,
      packNominalWh: null, legacyPercent: 0.0444,
    });
    expect(outcome.basis).toBe(simulatedEnergy.ENERGY_BASIS.LEGACY);
    expect(outcome.missing).toContain("packNominalWh");
  });
});

describe("T3 — the running agent's discharge is the model's, and reports which basis it used", () => {
  function agentWith(coefficients) {
    const agent = new VirtualRobot({
      robotId: "SIM-E", lat: 12.9, lon: 77.5, logger: silentLogger, simulated: true,
      specification: { massKg: 2, normalSpeedMps: 1.5, maxSpeedMps: 2.5, packNominalWh: 300, payloadCapacityKg: 5 },
      batteryState: { kappa: 1, kappaSampleCount: 0 },
      energyModelParams: coefficients,
    });
    agent.battery = 90;
    agent._ambientC = 28;
    agent._packC = 31;
    return agent;
  }

  test("with this deployment's real data the tick is LEGACY_PERCENTAGE and names what is missing", () => {
    const agent = agentWith(null);
    agent.status = "ACTIVE";
    agent._applyBattery();

    const status = agent.getStatus();
    expect(status.energyBasis).toBe(simulatedEnergy.ENERGY_BASIS.LEGACY);
    expect(status.energyMissing.length).toBeGreaterThan(0);
    expect(status.lastTickWh).toBeNull();
    // The fallback is visible on every status read, so it cannot be mistaken for physics.
    expect(status.energyBasis).not.toBe(simulatedEnergy.ENERGY_BASIS.MODELLED);
  });

  test("with coefficients and terrain the tick is MODELLED_WH and the pack loses real Wh", () => {
    const agent = agentWith(FIXTURE_COEFFICIENTS);
    agent.status = "ACTIVE";
    agent.speed = 1.5;
    agent.distanceTravelled = 300;

    // Terrain is the one input the deployment cannot supply; injected here to complete
    // the profile, exactly as a real elevation source would.
    const original = agent._legProfileForTick.bind(agent);
    agent._legProfileForTick = () => ({ ...original(), climbM: 5, descentM: 3 });

    const before = agent.battery;
    agent._applyBattery();

    const status = agent.getStatus();
    expect(status.energyBasis).toBe(simulatedEnergy.ENERGY_BASIS.MODELLED);
    expect(status.energyMissing).toEqual([]);
    expect(status.lastTickWh).toBeGreaterThan(0);
    expect(agent.battery).toBeLessThan(before);
    expect(status.cumulativeWh).toBeGreaterThan(0);
  });

  test("the environment's own temperatures are the ones handed to the energy model", () => {
    // The link between Step 4 and Step 5. Without this, a simulator could display a
    // varying temperature while the profile it prices carried a constant — which is
    // exactly the "fake temperature display" the milestone forbids.
    const agent = agentWith(FIXTURE_COEFFICIENTS);
    agent.status = "ACTIVE";
    agent.speed = 1.5;

    const thermal = agent._environment.advance({ nowMs: Date.now(), speedMps: agent.speed });
    agent._ambientC = thermal.ambientC;
    agent._packC = thermal.packC;

    const profile = agent._legProfileForTick();
    expect(profile.ambientC).toBe(thermal.ambientC);
    expect(profile.packC).toBe(thermal.packC);
    expect(profile.ambientC).toBeGreaterThanOrEqual(environment.AMBIENT_MIN_C);
    expect(profile.ambientC).toBeLessThanOrEqual(environment.AMBIENT_MAX_C);
  });

  test("moving the pack temperature moves the modelled energy for the same journey", () => {
    // Same distance, same masses, same durations — only the pack temperature differs.
    const agent = agentWith(FIXTURE_COEFFICIENTS);
    agent.status = "ACTIVE";
    agent.speed = 1.5;
    agent.distanceTravelled = 300;

    const withTemps = (ambientC, packC) => {
      const clone = agentWith(FIXTURE_COEFFICIENTS);
      clone.status = "ACTIVE";
      clone.speed = 1.5;
      clone.distanceTravelled = 300;
      clone._ambientC = ambientC;
      clone._packC = packC;
      const base = clone._legProfileForTick();
      return simulatedEnergy.tickEnergy({
        model: FIXTURE_COEFFICIENTS,
        profile: { ...base, climbM: 0, descentM: 0 },
        kappa: 1,
        packNominalWh: 300,
        legacyPercent: 0,
      });
    };

    const cool = withTemps(25, 25);
    const hot = withTemps(35, 40);

    expect(cool.basis).toBe(simulatedEnergy.ENERGY_BASIS.MODELLED);
    expect(hot.basis).toBe(simulatedEnergy.ENERGY_BASIS.MODELLED);
    expect(hot.wh).toBeGreaterThan(cool.wh);
  });

  test("κ comes from the persisted BatteryState, and its sample count is reported beside it", () => {
    const agent = new VirtualRobot({
      robotId: "SIM-K", lat: 0, lon: 0, logger: silentLogger, simulated: true,
      batteryState: { kappa: 1.12, kappaSampleCount: 9 },
    });
    const status = agent.getStatus();
    expect(status.kappa).toBe(1.12);
    expect(status.kappaSampleCount).toBe(9);
  });

  test("an uncalibrated agent reports κ = 1 with a sample count of 0", () => {
    const agent = new VirtualRobot({
      robotId: "SIM-U", lat: 0, lon: 0, logger: silentLogger, simulated: true,
      batteryState: { kappa: 1, kappaSampleCount: 0 },
    });
    const status = agent.getStatus();
    expect(status.kappa).toBe(1);
    expect(status.kappaSampleCount).toBe(0);
  });
});

describe("STEP 4 — the simulated environment", () => {
  test("ambient stays inside the owner's declared 25–35 °C band, all day", () => {
    const env = environment.createSimulatedEnvironment({ robotId: "SIM-A" });
    for (let minute = 0; minute < 24 * 60; minute += 7) {
      const reading = env.ambientCAt(minute * 60 * 1000);
      expect(reading).toBeGreaterThanOrEqual(environment.AMBIENT_MIN_C);
      expect(reading).toBeLessThanOrEqual(environment.AMBIENT_MAX_C);
    }
  });

  test("ambient actually varies with simulated time rather than sitting at a constant", () => {
    const env = environment.createSimulatedEnvironment({ robotId: "SIM-A" });
    const readings = [0, 6, 12, 18].map((h) => env.ambientCAt(h * 3600 * 1000));
    expect(new Set(readings.map((r) => r.toFixed(3))).size).toBeGreaterThan(1);
    // A full swing across the band, not a token wobble.
    expect(Math.max(...readings) - Math.min(...readings)).toBeGreaterThan(5);
  });

  test("pack temperature is not simply ambient: load raises it", () => {
    const env = environment.createSimulatedEnvironment({ robotId: "SIM-A", startedAtMs: 0 });
    let now = 0;
    for (let i = 0; i < 300; i += 1) {
      now += 2000;
      env.advance({ nowMs: now, speedMps: 1.5, charging: false });
    }
    const { ambientC, packC } = env.snapshot(now);
    expect(packC).toBeGreaterThan(ambientC);
  });

  test("pack temperature relaxes back toward ambient when the agent is idle", () => {
    const env = environment.createSimulatedEnvironment({ robotId: "SIM-A", startedAtMs: 0 });
    let now = 0;
    for (let i = 0; i < 300; i += 1) { now += 2000; env.advance({ nowMs: now, speedMps: 1.5 }); }
    const hot = env.snapshot(now).packC;

    for (let i = 0; i < 900; i += 1) { now += 2000; env.advance({ nowMs: now, speedMps: 0 }); }
    const rested = env.snapshot(now);

    expect(rested.packC).toBeLessThan(hot);
    expect(rested.packC - rested.ambientC).toBeLessThan(1);
  });

  test("it is deterministic per robot, and two robots are independent", () => {
    const a1 = environment.createSimulatedEnvironment({ robotId: "SIM-A" });
    const a2 = environment.createSimulatedEnvironment({ robotId: "SIM-A" });
    const b1 = environment.createSimulatedEnvironment({ robotId: "SIM-B" });

    // Same robot, same trace — the reproducibility the milestone requires.
    expect(a1.ambientOffsetC).toBe(a2.ambientOffsetC);
    // Different robots have their own sensor offsets, drawn from their own streams.
    expect(a1.ambientOffsetC).not.toBe(b1.ambientOffsetC);
  });

  test("no global Math.random is used for simulation state", () => {
    const spy = jest.spyOn(Math, "random");
    const env = environment.createSimulatedEnvironment({ robotId: "SIM-R", startedAtMs: 0 });
    env.advance({ nowMs: 2000, speedMps: 1.2 });
    env.advance({ nowMs: 4000, speedMps: 1.2 });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test("a running agent's temperatures reach its status, inside the band", () => {
    const agent = new VirtualRobot({
      robotId: "SIM-T", lat: 0, lon: 0, logger: silentLogger, simulated: true,
      specification: { massKg: 2, normalSpeedMps: 1.5, maxSpeedMps: 2.5, packNominalWh: 300, payloadCapacityKg: 5 },
    });
    const thermal = agent._environment.advance({ nowMs: Date.now(), speedMps: 1.5 });
    agent._ambientC = thermal.ambientC;
    agent._packC = thermal.packC;

    const status = agent.getStatus();
    expect(status.ambientC).toBeGreaterThanOrEqual(environment.AMBIENT_MIN_C);
    expect(status.ambientC).toBeLessThanOrEqual(environment.AMBIENT_MAX_C);
    expect(status.packC).toEqual(expect.any(Number));
  });
});
