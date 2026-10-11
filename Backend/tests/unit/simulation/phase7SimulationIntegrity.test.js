/**
 * Phase 7 (2026-10-09/10) — simulation integrity, characterised against LOCAL measurements.
 * Characterisation, NOT fixes: each block pins today's behaviour and says whether it is a
 * documented rule or a defect (P7-D3 was fixed in its Step 1; its block now asserts the fix). A DEFECT test will fail when the defect is fixed and must then
 * be rewritten to assert the fix.
 *
 * MOCKED BOUNDARIES: the agent's socket and flash storage (recording doubles, as in
 * `virtualRobotBehaviour.test.js`), the wall clock (a driven clock), and — for P7-D3 — the
 * Charging Scheduler client, stubbed to grant the plug (production uses
 * `devChargingScheduler` through `SimulationEngine`). VirtualRobot and rehydration are real.
 */

const VirtualRobot = require("../../../src/simulation/VirtualRobot");
const constants = require("../../../src/simulation/constants");
const { rehydrateSimulatedRobots } = require("../../../src/simulation/rehydrate");
const { haversineMeters } = require("../../../src/utils/distance");

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

function makeFlash() {
  const values = new Map();
  return {
    async get(key) {
      return values.has(key) ? values.get(key) : null;
    },
    async set(key, value) {
      values.set(key, value);
      return "OK";
    },
    async del(key) {
      values.delete(key);
    },
    async sadd() {
      return 1;
    },
  };
}

function makeSocket() {
  const emitted = [];
  return {
    emitted,
    connected: true,
    emit(event, payload) {
      emitted.push({ event, payload });
    },
    on() {},
    of(event) {
      return emitted.filter((entry) => entry.event === event);
    },
  };
}

function makeAgent(overrides) {
  const socket = makeSocket();
  const robot = new VirtualRobot({ logger: silentLogger, kv: makeFlash(), simulated: true, ...overrides, socket: undefined });
  robot.socket = socket;
  robot.connected = true;
  return { robot, socket };
}

/** Drive ticks on one clock, letting the scheduler client's promises settle between ticks. */
async function runTicks(robot, ticks, intervalMs = constants.TELEMETRY_INTERVAL_MS) {
  let now = 1_791_521_745_000;
  const realNow = Date.now;
  try {
    for (let i = 0; i < ticks; i += 1) {
      now += intervalMs;
      Date.now = () => now;
      robot._tick();
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setImmediate(resolve));
    }
  } finally {
    Date.now = realNow;
  }
}

describe("FIXED P7-D3 (Step 1) — a simulated robot drives to the charger whose plug it holds, and charges there", () => {
  // LOCAL, 2026-10-09 (the defect this block used to pin): SIM-0A8C043FFE67 held reservation
  // DEV-SIM-RNSIT-MBA-01:…:0 from 14:55:45Z to 15:06:22Z and charged 10.0 → 79.1 % at its own
  // position, 159 m from that charger, at speed 0.
  //
  // Since P7-D3 Step 0 the simulated fleet's charger is the V1 depot, and since Step 1 a robot
  // reserves it, drives the campus route there (the network the engine prices the return on),
  // and charges only inside the docking radius. This drives the REAL route from SIM-0A8C's
  // LOCAL position to the depot, over the fixture's real RNSIT declaration and permitted ways.
  const chargerRoute = require("../../../src/simulation/chargerRoute");
  const fixture = require("../../fixtures/phase7/local-2026-10-09.json");
  const SIM_0A8C = { lat: 12.901151, lon: 77.517575 };
  const depotRow = fixture.rows.Charger.find((row) => row.chargerId === "V1DEMO-DEPOT-01");
  const DEPOT = { lat: depotRow.latitude, lon: depotRow.longitude };

  test("granted a plug, the robot drives the campus route to the depot and only then charges to the target", async () => {
    const router = chargerRoute.createChargerRouter({ deliveryDomainFor: () => fixture.configVersion.payload.deliveryDomain });
    const route = router.routeToCharger({ chargerRow: depotRow, from: SIM_0A8C, permissionSet: fixture.rows.MobilityModel[0].permissionSet });
    expect(route.ok).toBe(true);

    const requests = [];
    const chargingClient = {
      request: async (targetSoc) => {
        requests.push(targetSoc);
        return { state: "ACTIVE", chargerId: depotRow.chargerId };
      },
      state: async () => ({ state: "ACTIVE", chargerId: depotRow.chargerId }),
      release: async () => ({ state: "NONE" }),
      routeToCharger: async () => route,
    };
    const { robot } = makeAgent({ robotId: "SIM-P7-DOCK", lat: SIM_0A8C.lat, lon: SIM_0A8C.lon, chargingClient });
    robot.battery = constants.BATTERY_CRITICAL_THRESHOLD; // 10 %, as on LOCAL

    // Reserved and driving — not charging where it stands.
    await runTicks(robot, 3);
    expect(requests[0]).toBeCloseTo(constants.TARGET_SOC_FALLBACK, 6);
    expect(robot.status).toBe("RETURNING");

    for (let chunk = 0; chunk < 20 && robot.status !== "CHARGING"; chunk += 1) {
      await runTicks(robot, 10); // eslint-disable-line no-await-in-loop
    }
    expect(robot.status).toBe("CHARGING");
    expect(haversineMeters(robot.lat, robot.lon, DEPOT.lat, DEPOT.lon)).toBeLessThanOrEqual(chargerRoute.DOCKING_RADIUS_M);
    expect(robot.distanceTravelled).toBeCloseTo(route.distanceM, 3);

    // Until the session ends at its target (the CC/CV taper makes the last points slow), bounded at 2 h.
    const docked = { lat: robot.lat, lon: robot.lon, travelled: robot.distanceTravelled };
    for (let chunk = 0; chunk < 36 && robot.status === "CHARGING"; chunk += 1) {
      await runTicks(robot, 100); // eslint-disable-line no-await-in-loop
    }
    expect(robot.status).toBe("IDLE");
    expect(robot.battery).toBeGreaterThanOrEqual(constants.TARGET_SOC_FALLBACK * 100 - 100 * constants.BATTERY_DRAIN_IDLE - 1e-9);
    // The whole session happened at the depot.
    expect(robot.lat).toBe(docked.lat);
    expect(robot.lon).toBe(docked.lon);
    expect(robot.distanceTravelled).toBe(docked.travelled);
  });
});

describe("DEFECT P7-D4 — rehydration restores a simulated robot without its in-flight mission", () => {
  // LOCAL: SIM-1ABF21512BE5 and SIM-CFE1E46B2002 still carry Robot.currentTaskId (TSK-…-254 /
  // TSK-…-551) and live commitments, and their Legs are EN_ROUTE_PICKUP; the simulator's own
  // robots report IDLE and dock to charge (which requires `phase === null`). The re-hydrator
  // reads four columns and hands the simulator nothing about a mission, so the two sides
  // disagree from the first tick after any restart.
  test("only robotId, lat, lon and simulated are read and passed on — no task, no route, no commitment", async () => {
    const reads = [];
    const prisma = {
      robot: {
        findMany: async (query) => {
          reads.push(query);
          return [{ robotId: "SIM-1ABF21512BE5", lat: 12.900817, lon: 77.518043, simulated: true }];
        },
      },
    };
    const spawned = [];
    await rehydrateSimulatedRobots({
      prisma,
      simulator: { addRobot: async (args) => (spawned.push(args), { started: true }) },
      logger: silentLogger,
      enabled: true,
    });

    expect(reads[0].select).toEqual({ robotId: true, lat: true, lon: true, simulated: true });
    expect(spawned).toEqual([{ robotId: "SIM-1ABF21512BE5", lat: 12.900817, lon: 77.518043, simulated: true }]);
  });
});

describe("DOCUMENTED — the idle drain that makes every parked simulated robot dock within hours", () => {
  test("idle drain is 0.0089 %/2 s tick: 16 %/h, matching LOCAL's measured 1.5 % in 337 s at speed 0", async () => {
    const { robot } = makeAgent({ robotId: "SIM-P7-IDLE", lat: 12.9, lon: 77.5 });
    robot.battery = 95;
    await runTicks(robot, 1800); // one hour at the 2 s tick
    const perHour = 95 - robot.battery;
    expect(perHour).toBeCloseTo(constants.BATTERY_DRAIN_IDLE * 1800, 6); // 16.02 %/h

    // LOCAL SIM-0A8C043FFE67, 14:50:04.676Z → 14:55:41.837Z: 11.5 % → 10.0 % (Telemetry rows).
    const measuredPerHour = (1.5 / 337.161) * 3600;
    expect(Math.abs(measuredPerHour - perHour)).toBeLessThan(0.1 * perHour);

    // 95 % → the 10 % dock threshold in ≈ 5.3 h parked: SIM-9F6F88D84EBD was commissioned at 95 %
    // at 13:44Z and read 17.4 % at 18:07Z on LOCAL without moving after its one delivery.
    expect((95 - constants.BATTERY_CRITICAL_THRESHOLD) / perHour).toBeCloseTo(5.3, 1);
  });
});
