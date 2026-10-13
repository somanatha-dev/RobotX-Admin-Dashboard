"use strict";

/**
 * Phase E — the simulated robot's energy model is its commissioned specification plus one stated
 * power policy, and the engine prices energy from the same coefficients.
 *
 *   · `energyPolicy`: P(v) = P_standby + (P_moving − P_standby)·v/v_ref, the reserve formula and
 *     the feasibility test, stated once. Defaults are the owner's ranges' midpoints (9.5 W standby,
 *     30 W moving at 2 m/s) — simulation assumptions, not measurements.
 *   · Commissioning writes the power model's coefficients for a new simulated unit.
 *   · A simulated robot consumes from its OWN coefficient row (the row F34 prices its missions
 *     with), so engine and simulator agree by construction — including existing units whose rows
 *     were derived from the old percentage drain (their consumption is unchanged).
 *   · The charge trigger is configurable, 20 % by default, and fires earlier when the robot could
 *     no longer reach a charger with its reserve intact.
 */

const VirtualRobot = require("../../../src/simulation/VirtualRobot");
const constants = require("../../../src/simulation/constants");
const energyPolicy = require("../../../src/simulation/energyPolicy");
const simulatedAgentState = require("../../../src/simulation/simulatedAgentState");
const simulationConfig = require("../../../src/simulation/simulationConfig");
const composition = require("../../../src/services/v1DemonstrationComposition");
const { energyCoefficientsFrom } = require("../../../src/engine/domain/mappers/decisionInputs");

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

function makeFlash() {
  const values = new Map();
  return {
    async get(key) { return values.has(key) ? values.get(key) : null; },
    async set(key, value) { values.set(key, value); return "OK"; },
    async del(key) { values.delete(key); },
    async sadd() { return 1; },
  };
}

/** A robot with a commissioned specification and coefficient row, as `SimulationEngine.addRobot` builds it. */
function commissioned({ packWh = 44.4, speed = 2, reservePct = 15, params, ...rest } = {}) {
  const row = params || simulatedAgentState.simulatedEnergyCoefficients(packWh);
  const robot = new VirtualRobot({
    robotId: "SIM-E",
    lat: 12.9,
    lon: 77.5,
    logger: silentLogger,
    kv: makeFlash(),
    simulated: true,
    specification: { packNominalWh: packWh, normalSpeedMps: speed, maxSpeedMps: speed + 0.5, massKg: 20, payloadCapacityKg: 3, batteryReservePct: reservePct },
    energyModelParams: energyCoefficientsFrom(row),
    ...rest,
  });
  robot.socket = { connected: true, emit() {}, on() {} };
  robot.connected = true;
  return robot;
}

let clock = 1_792_100_000_000;
function runTicks(robot, ticks, intervalMs = constants.TELEMETRY_INTERVAL_MS) {
  const realNow = Date.now;
  try {
    for (let i = 0; i < ticks; i += 1) {
      clock += intervalMs;
      Date.now = () => clock;
      robot._tick();
    }
  } finally {
    Date.now = realNow;
  }
}

const line = (n) => Array.from({ length: n }, (_, i) => ({ lat: 12.9 + i * 0.0005, lon: 77.5 }));

describe("energyPolicy — the power model, the reserve and the feasibility test, stated once", () => {
  afterEach(() => energyPolicy.resetForTests());

  test("defaults: 9.5 W standby, 30 W moving at 2 m/s, a 20 % trigger, no fixed reserve until one is supplied", () => {
    const p = energyPolicy.resolve({}).policy;
    expect(p).toMatchObject({ standbyPowerW: 9.5, movingPowerW: 30, movingPowerReferenceSpeedMps: 2, chargeTriggerPct: 20, fixedReserveWh: 0 });
  });

  test("the coefficients reproduce the stated power exactly: 9.5 W at rest, 30 W at 2 m/s, and power rises with speed", () => {
    const c = energyPolicy.powerCoefficients(energyPolicy.resolve({}).policy);
    const watts = (v) => (c.betaAux + c.betaDist * v) * 3600;
    expect(watts(0)).toBeCloseTo(9.5, 9);
    expect(watts(2)).toBeCloseTo(30, 9);
    expect(watts(1)).toBeLessThan(watts(2));
    expect(c.betaMoveTime).toBe(0);
    expect(c.betaDwell).toBe(0);
  });

  test("environment overrides are validated by name, and an invalid value keeps the default", () => {
    const { policy, problems } = energyPolicy.resolve({ SIM_STANDBY_POWER_W: "7", SIM_FIXED_RESERVE_WH: "2.5", SIM_MOVING_POWER_W: "abc" });
    expect(policy.standbyPowerW).toBe(7);
    expect(policy.fixedReserveWh).toBe(2.5);
    expect(policy.movingPowerW).toBe(30);
    expect(problems.join(" ")).toMatch(/SIM_MOVING_POWER_W=abc/);
  });

  test("reserve = commissioned percentage of the pack + fixed Wh, each counted once; undeclared → the 5 % floor", () => {
    expect(energyPolicy.reserveWh({ packWh: 44.4, reservePct: 15, fixedReserveWh: 2 })).toBeCloseTo(6.66 + 2, 9);
    expect(energyPolicy.reserveWh({ packWh: 44.4, reservePct: null, fixedReserveWh: 0 })).toBeCloseTo(2.22, 9);
    expect(energyPolicy.reserveWh({ packWh: null, reservePct: 15 })).toBeNull();
  });

  test("feasibility: available − delivery − charger trip ≥ reserve", () => {
    expect(energyPolicy.feasibility({ availableWh: 20, deliveryWh: 5, chargerTripWh: 3, reserveWh: 12 })).toEqual({ feasible: true, marginWh: 0 });
    expect(energyPolicy.feasibility({ availableWh: 20, deliveryWh: 5, chargerTripWh: 3.1, reserveWh: 12 }).feasible).toBe(false);
  });
});

describe("commissioning — a new simulated unit is declared on the power model", () => {
  test("its coefficient row is the policy's, whatever its pack", () => {
    const row = simulatedAgentState.simulatedEnergyCoefficients(44.4);
    const expected = energyPolicy.powerCoefficients();
    expect(row.betaAux).toBeCloseTo(expected.betaAux, 12);
    expect(row.betaDist).toBeCloseTo(expected.betaDist, 12);
    expect(row.betaMoveTime).toBe(0);
    expect(row.betaDwell).toBe(0);
    expect(energyPolicy.simulatedTerms(row)).not.toBeNull();
  });
});

describe("the simulated robot consumes from its own coefficient row", () => {
  test("idle for an hour on the power model: 9.5 Wh, i.e. 21.4 % of a 44.4 Wh pack", () => {
    const robot = commissioned();
    robot.battery = 80;
    runTicks(robot, 1800);
    expect(robot.getStatus().energyBasis).toBe("SIMULATED_POWER_WH");
    expect(80 - robot.battery).toBeCloseTo((9.5 / 44.4) * 100, 6);
  });

  test("driving: standby for the time plus the distance term for the metres actually driven", () => {
    const robot = commissioned();
    robot.battery = 80;
    robot._onTaskAssign({ taskId: "T-E", pathToPickup: line(40), pathToDrop: line(40).reverse() });
    runTicks(robot, 30);
    const c = energyPolicy.powerCoefficients();
    const expectedWh = c.betaAux * 60 + c.betaDist * robot.distanceTravelled;
    expect(robot.distanceTravelled).toBeGreaterThan(0);
    expect(robot.getStatus().cumulativeWh).toBeCloseTo(expectedWh, 3);
    expect(80 - robot.battery).toBeCloseTo((expectedWh / 44.4) * 100, 3);
  });

  test("an existing unit whose row was derived from the old percentage drain consumes exactly as before", () => {
    const legacyRow = { betaAux: 0.02225, betaMoveTime: 0.08875, betaDwell: 0.08875, betaDist: 0, betaMass: 0, betaClimb: 0, betaRegen: 0, etaRegen: 0, betaStopStart: 0 };
    const robot = commissioned({ packWh: 500, speed: 1.4, params: legacyRow });
    robot.battery = 60;
    runTicks(robot, 100);
    expect(60 - robot.battery).toBeCloseTo(constants.BATTERY_DRAIN_IDLE * 100, 6);
    const worker = commissioned({ packWh: 500, speed: 1.4, params: legacyRow });
    worker.battery = 60;
    worker._onTaskAssign({ taskId: "T-L", pathToPickup: line(60), pathToDrop: line(60).reverse() });
    runTicks(worker, 100);
    expect(60 - worker.battery).toBeCloseTo(constants.BATTERY_DRAIN_ACTIVE * 100, 6);
  });

  test("the tick period does not change the rate: consumption and charging are per simulated second", () => {
    const at = (intervalMs, ticks) => {
      const robot = commissioned({ telemetryIntervalMs: intervalMs });
      robot.battery = 70;
      runTicks(robot, ticks, intervalMs);
      return 70 - robot.battery;
    };
    expect(at(1000, 120)).toBeCloseTo(at(2000, 60), 9);

    const charged = (intervalMs, ticks) => {
      const robot = commissioned({ telemetryIntervalMs: intervalMs });
      robot.battery = 30;
      let gained = 0;
      for (let i = 0; i < ticks; i += 1) gained += robot._chargeStepPercent();
      return gained;
    };
    expect(charged(1000, 10)).toBeCloseTo(charged(2000, 5), 2);
  });

  test("the status reports capacity, energy and reserve in Wh from the commissioned values", () => {
    const robot = commissioned();
    robot.battery = 50;
    const status = robot.getStatus();
    expect(status.capacityWh).toBe(44.4);
    expect(status.energyWh).toBeCloseTo(22.2, 9);
    expect(status.reserveWh).toBeCloseTo(energyPolicy.reserveWh({ packWh: 44.4, reservePct: 15 }), 9);
    expect(status.chargeTriggerPct).toBe(20);
  });
});

describe("the charge trigger", () => {
  function scheduled(extra = {}) {
    const calls = { request: 0 };
    const client = {
      async request() { calls.request += 1; return { state: "QUEUED" }; },
      async state() { return { state: "QUEUED" }; },
      async release() { return { ok: true }; },
      async routeToCharger() { return { ok: false, refusal: "NOT_ROUTABLE", reason: "test" }; },
      ...extra,
    };
    return { client, calls };
  }

  test("an idle robot seeks a charger at the 20 % default, not before", () => {
    const { client } = scheduled();
    const above = commissioned({ chargingClient: client });
    above.battery = 20.4;
    runTicks(above, 1);
    expect(above._chargingPhase).toBeNull();
    const at = commissioned({ chargingClient: client });
    at.battery = 20;
    runTicks(at, 1);
    expect(at._chargingPhase).toBe("SEEKING");
  });

  test("the trigger is a live simulator parameter", () => {
    expect(simulationConfig.normaliseConfig({ chargeTriggerPct: 35 })).toMatchObject({ ok: true, live: ["chargeTriggerPct"] });
    expect(simulationConfig.normaliseConfig({ chargeTriggerPct: 0 }).ok).toBe(false);
    const { client } = scheduled();
    const robot = commissioned({ chargingClient: client });
    robot.setChargeTriggerPct(35);
    robot.battery = 34;
    runTicks(robot, 1);
    expect(robot._chargingPhase).toBe("SEEKING");
  });

  test("above the trigger, a robot that could no longer reach a charger with its reserve intact seeks one now", async () => {
    // 44.4 Wh, 15 % reserve = 6.66 Wh. A charger 1,000 m away costs 1000 × whPerMetre at 2 m/s.
    const tripEstimate = { ok: true, chargerId: "STATION-FAR", distanceM: 1000 };
    const { client } = scheduled({ async chargerTripEstimate() { return tripEstimate; } });
    const c = energyPolicy.powerCoefficients();
    const tripWh = 1000 * energyPolicy.whPerMetre(c, 2);
    const reserve = energyPolicy.reserveWh({ packWh: 44.4, reservePct: 15 });
    const edgePct = ((reserve + tripWh) / 44.4) * 100;

    const comfortable = commissioned({ chargingClient: client });
    comfortable.battery = edgePct + 1;
    runTicks(comfortable, 3);
    await new Promise((resolve) => setImmediate(resolve));
    runTicks(comfortable, 1);
    expect(comfortable._chargingPhase).toBeNull();

    const marginal = commissioned({ chargingClient: client });
    marginal.battery = edgePct - 0.05;
    expect(marginal.battery).toBeGreaterThan(20);
    runTicks(marginal, 3);
    await new Promise((resolve) => setImmediate(resolve));
    runTicks(marginal, 1);
    expect(marginal._chargingPhase).toBe("SEEKING");
  });
});

describe("the engine prices the return leg from the same coefficients the simulator consumes", () => {
  test("a simulated snapshot's profile carries its own Wh per metre, and the return leg uses it", () => {
    const params = simulatedAgentState.simulatedEnergyCoefficients(44.4);
    const snapshot = {
      provenance: simulatedAgentState.PROVENANCE,
      mobilityModel: { speedModel: { nominalSpeedMps: 2 }, permissionSet: { roadClasses: ["footway"] } },
      energyModel: { packNominalWh: 44.4 },
      energyModelParams: params,
    };
    const key = composition.simulatedProfileKeyFor(snapshot);
    expect(composition.simulatedWhPerMetre(key)).toBeCloseTo(energyPolicy.whPerMetre(params, 2), 12);

    const legacy = { ...snapshot, energyModel: { packNominalWh: 500 }, mobilityModel: { ...snapshot.mobilityModel, speedModel: { nominalSpeedMps: 1.4 } }, energyModelParams: { betaAux: 0.02225, betaMoveTime: 0.08875, betaDwell: 0.08875, betaDist: 0, betaMass: 0, betaClimb: 0, betaRegen: 0, betaStopStart: 0 } };
    expect(composition.simulatedWhPerMetre(composition.simulatedProfileKeyFor(legacy))).toBeCloseTo(0.111 / 1.4, 9);
  });
});
