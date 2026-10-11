"use strict";

/**
 * P7-D1 — a STOP received while charging LATCHES.
 *
 * Before: `_applyStop` left a charging robot charging (it kept CHARGING), and at the target it
 * reported IDLE — the operator's STOP simply vanished. That was masked only because CHARGING was
 * stored as a sticky PAUSED; fixing the PAUSED defect alone would have returned a STOPped robot
 * to service. So the two are fixed together:
 *
 *   · STOP/PAUSE while charging keeps the session (unplugging is not what a STOP means for a
 *     docked unit) but latches: however the session ends — target reached, plug taken away,
 *     moved off the charger, RECALL — the robot ends PAUSED, never IDLE;
 *   · a latched robot executes no assignment, including one deferred while it charged;
 *   · RESUME while charging clears the latch (the operator withdrew the STOP); the robot's own
 *     report still cannot lift the server-side hold the STOP placed (`p7d1HoldAndRestore`).
 *
 * Also here: evidence that the 0.01 m docking tolerance holds over a real campus route — the
 * robot docks on the charger's exact coordinate and stays at distance 0 for the whole session.
 *
 * MOCKED BOUNDARIES: socket, flash, wall clock, and the Charging Scheduler client (stubbed, with
 * the real `chargerRoute` over the fixture's RNSIT declaration where a route is driven).
 */

const VirtualRobot = require("../../../src/simulation/VirtualRobot");
const constants = require("../../../src/simulation/constants");
const chargerRoute = require("../../../src/simulation/chargerRoute");
const { RELEASE_REASON } = require("../../../src/simulation/devChargingScheduler");
const { haversineMeters } = require("../../../src/utils/distance");
const fixture = require("../../fixtures/phase7/local-2026-10-09.json");

jest.setTimeout(60_000);

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
function makeSocket() {
  const emitted = [];
  return { emitted, connected: true, emit(event, payload) { emitted.push({ event, payload }); }, on() {} };
}

let clock = 1_791_600_000_000;
async function runTicks(robot, ticks, onTick) {
  const realNow = Date.now;
  try {
    for (let i = 0; i < ticks; i += 1) {
      clock += constants.TELEMETRY_INTERVAL_MS;
      Date.now = () => clock;
      robot._tick();
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setImmediate(resolve));
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setImmediate(resolve));
      if (onTick) onTick(robot);
    }
  } finally {
    Date.now = realNow;
  }
}

const SIM_0A8C = { lat: 12.901151, lon: 77.517575 };
const depotRow = fixture.rows.Charger.find((row) => row.chargerId === "V1DEMO-DEPOT-01");
const DEPOT = { lat: depotRow.latitude, lon: depotRow.longitude };
const ROUTE = chargerRoute
  .createChargerRouter({ deliveryDomainFor: () => fixture.configVersion.payload.deliveryDomain })
  .routeToCharger({ chargerRow: depotRow, from: SIM_0A8C, permissionSet: fixture.rows.MobilityModel[0].permissionSet });

function client() {
  let state = "ACTIVE";
  const calls = { release: [] };
  return {
    calls,
    setState(next) { state = next; },
    client: {
      async request() { if (state === "NONE") state = "ACTIVE"; return { state }; },
      async state() { return { state }; },
      async release(reason) { calls.release.push(reason); state = "NONE"; return { ok: true }; },
      async routeToCharger() { return ROUTE; },
    },
  };
}

/** A scheduled robot, driven from SIM-0A8C's LOCAL position to the depot until current flows. */
async function dockedRobot() {
  const c = client();
  const socket = makeSocket();
  const robot = new VirtualRobot({ robotId: "SIM-P7D1", lat: SIM_0A8C.lat, lon: SIM_0A8C.lon, logger: silentLogger, kv: makeFlash(), simulated: true, chargingClient: c.client });
  robot.socket = socket;
  robot.connected = true;
  robot.battery = constants.BATTERY_CRITICAL_THRESHOLD;
  for (let chunk = 0; chunk < 30 && robot._chargingPhase !== "CHARGING"; chunk += 1) await runTicks(robot, 10); // eslint-disable-line no-await-in-loop
  expect(robot._chargingPhase).toBe("CHARGING");
  return { robot, socket, c };
}

/** Run until the session ends (status leaves CHARGING), bounded. */
async function untilSessionEnds(robot) {
  for (let chunk = 0; chunk < 40 && robot.status === "CHARGING"; chunk += 1) await runTicks(robot, 100); // eslint-disable-line no-await-in-loop
}

const TARGET = constants.TARGET_SOC_FALLBACK * 100;

describe("P7-D1 — a STOP received while charging latches", () => {
  test("without a STOP, a finished charge ends IDLE (unchanged)", async () => {
    const { robot, c } = await dockedRobot();
    robot.battery = TARGET - 0.05;
    await untilSessionEnds(robot);
    expect(robot.status).toBe("IDLE");
    expect(c.calls.release).toContain(RELEASE_REASON.TARGET_REACHED);
  });

  test("STOP while charging keeps the session — and at the target the robot ends PAUSED, never IDLE", async () => {
    const { robot, socket, c } = await dockedRobot();
    robot._applyStop("STOP");
    expect(robot.status).toBe("CHARGING"); // not knocked out of the session

    const level = robot.battery;
    await runTicks(robot, 20);
    expect(robot.battery).toBeGreaterThan(level); // current still flows

    robot.battery = TARGET - 0.05;
    await untilSessionEnds(robot);
    expect(robot.status).toBe("PAUSED");
    expect(c.calls.release).toContain(RELEASE_REASON.TARGET_REACHED);
    // What the server is told after the session: PAUSED — a restriction it persists.
    await runTicks(robot, 1);
    const last = socket.emitted.filter((entry) => entry.event === "TELEMETRY").pop();
    expect(last.payload.status).toBe("PAUSED");
  });

  test.each(["PAUSE", "ABORT_MISSION"])("%s while charging latches the same way", async (label) => {
    const { robot } = await dockedRobot();
    robot._applyStop(label);
    robot.battery = TARGET - 0.05;
    await untilSessionEnds(robot);
    expect(robot.status).toBe("PAUSED");
  });

  test("latched, the plug taken away underneath: PAUSED", async () => {
    const { robot, c } = await dockedRobot();
    robot._applyStop("STOP");
    c.setState("NONE");
    await runTicks(robot, 3);
    expect(robot.status).toBe("PAUSED");
  });

  test("latched, moved off the charger (session abandoned): PAUSED", async () => {
    const { robot } = await dockedRobot();
    robot._applyStop("STOP");
    robot.lat += 0.0005;
    await runTicks(robot, 2);
    expect(robot.status).toBe("PAUSED");
  });

  test("latched, a RECALL ends the session: PAUSED", async () => {
    const { robot } = await dockedRobot();
    robot._applyStop("STOP");
    robot._applyReturnToBase("RECALL");
    expect(robot.status).toBe("PAUSED");
  });

  test("latched, an assignment is not executed — not during the charge, and not the deferred one after it", async () => {
    const { robot } = await dockedRobot();
    robot._applyStop("STOP");
    const assignment = {
      taskId: "TASK-LATCHED",
      stops: [
        { stopType: "PICKUP", lat: DEPOT.lat, lon: DEPOT.lon, path: [DEPOT, { lat: DEPOT.lat + 0.0005, lon: DEPOT.lon }] },
        { stopType: "DROP", lat: DEPOT.lat + 0.001, lon: DEPOT.lon, path: [{ lat: DEPOT.lat + 0.0005, lon: DEPOT.lon }, { lat: DEPOT.lat + 0.001, lon: DEPOT.lon }] },
      ],
    };
    // A deferred task (as `_onTaskAssign` stores one on low battery), and a fresh one now.
    robot._pendingResume = { taskId: "TASK-DEFERRED", stops: assignment.stops, payloadMassKg: null };
    robot._onTaskAssign(assignment);
    expect(robot.task).toBeNull();
    expect(robot.status).toBe("CHARGING");

    robot.battery = TARGET - 0.05;
    await untilSessionEnds(robot);
    expect(robot.status).toBe("PAUSED");
    expect(robot.task).toBeNull();
    expect(robot._pendingResume).toBeNull();
  });

  test("RESUME while charging withdraws the latch: the session continues and ends IDLE", async () => {
    const { robot } = await dockedRobot();
    robot._applyStop("STOP");
    robot._applyResume();
    expect(robot.status).toBe("CHARGING");
    robot.battery = TARGET - 0.05;
    await untilSessionEnds(robot);
    expect(robot.status).toBe("IDLE");
  });

  test("the latch also binds a robot with no scheduler client (the Batch 1 path)", async () => {
    const socket = makeSocket();
    const robot = new VirtualRobot({ robotId: "SIM-P7D1-LEGACY", lat: 12.9, lon: 77.5, logger: silentLogger, kv: makeFlash(), simulated: true });
    robot.socket = socket;
    robot.connected = true;
    robot.battery = constants.BATTERY_CRITICAL_THRESHOLD;
    await runTicks(robot, 20);
    expect(robot.status).toBe("CHARGING");
    robot._applyStop("STOP");
    robot.battery = TARGET - 0.05;
    await untilSessionEnds(robot);
    expect(robot.status).toBe("PAUSED");
  });

  test("a STOP during the approach (not yet charging) still halts at once, as before", async () => {
    const c = client();
    const robot = new VirtualRobot({ robotId: "SIM-P7D1-APP", lat: SIM_0A8C.lat, lon: SIM_0A8C.lon, logger: silentLogger, kv: makeFlash(), simulated: true, chargingClient: c.client });
    robot.socket = makeSocket();
    robot.connected = true;
    robot.battery = constants.BATTERY_CRITICAL_THRESHOLD;
    await runTicks(robot, 4);
    expect(robot.status).toBe("RETURNING");
    robot._applyStop("STOP");
    expect(robot.status).toBe("PAUSED");
  });
});

describe("P7-D3 docking tolerance under the simulator's real waypoint logic", () => {
  test("over the real campus route the robot docks exactly on the charger and stays at 0 m for the whole session", async () => {
    expect(ROUTE.ok).toBe(true);
    const distances = [];
    const { robot } = await dockedRobot();
    distances.push(haversineMeters(robot.lat, robot.lon, DEPOT.lat, DEPOT.lon));
    await runTicks(robot, 200, (r) => {
      if (r.status === "CHARGING") distances.push(haversineMeters(r.lat, r.lon, DEPOT.lat, DEPOT.lon));
    });
    expect(distances.length).toBeGreaterThan(100);
    expect(Math.max(...distances)).toBe(0);
    // The route's own final point is the charger's coordinate, bit for bit — which is why a
    // 0.01 m tolerance is not tight in practice: arrival snaps the robot onto that point.
    expect(ROUTE.points[ROUTE.points.length - 1]).toEqual(DEPOT);
  });
});
