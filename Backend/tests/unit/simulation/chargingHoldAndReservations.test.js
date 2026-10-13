"use strict";

/**
 * D-4 and D-8 (docs/ROBOTX_CHARGING_LIFECYCLE_AUDIT.md) — operator holds and charger
 * reservations; the agent's view of its reservation never outlives the session.
 *
 * Owner decision (2026-10-12): a PAUSED robot that is already DOCKED may continue its simulated
 * charging session; a robot that is NOT docked must not keep a reservation while it cannot move.
 *
 * Before: the tick trigger ignored PAUSED, and an approach kept its plug while held — measured on
 * SIM-0A8C's LOCAL state, one of three plugs blocked for the whole 2 h 11 min window by a robot
 * that never moved. A restart adopted such a reservation for a held robot away from the charger.
 * And a scheduler read that resolved after a release restored `ACTIVE` in the agent's state.
 *
 * REAL: SimulationEngine, VirtualRobot, devChargingScheduler, chargerRoute, the campus network.
 */

const cw = require("../../helpers/chargingWorld");

require(cw.ENGINE_PATH); // before any doMock in `boot` (see p7d3RestartRecovery)

const constants = require("../../../src/simulation/constants");
const chargerRoute = require("../../../src/simulation/chargerRoute");
const devChargingScheduler = require("../../../src/simulation/devChargingScheduler");
const { createChargingStatusReader } = require("../../../src/services/chargingStatus.service");

jest.setTimeout(60_000);

const { RESERVATION_STATE, RELEASE_REASON } = devChargingScheduler;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const clock = cw.createClock();
beforeEach(() => clock.install());
afterEach(() => clock.uninstall());

const run = (robots, ticks, onTick) => cw.runTicks(clock, robots, ticks, onTick);
const until = (robots, predicate, max) => cw.runUntil(clock, robots, predicate, max);
const at = (robot, point) => chargerRoute.withinDockingRadius(robot, point);
const reservationsOf = (world, agent) => world.rows.chargerReservation.filter((row) => row.agentId === agent);

function stop(robot, id) { robot._onCommand({ type: "STOP", commandId: id }); }
function resume(robot, id) { robot._onCommand({ type: "RESUME", commandId: id }); }

async function oneLowRobot(overrides = {}) {
  const world = cw.createWorld();
  cw.addRobotRow(world, { robotId: "SIM-H", agentRowId: "agent-h", battery: constants.BATTERY_CRITICAL_THRESHOLD, ...overrides });
  const booted = await cw.boot(clock, world, [{ robotId: "SIM-H", at: overrides.at || cw.AWAY }]);
  return { world, ...booted, robot: booted.byId("SIM-H") };
}

describe("D-4 — a robot that is not docked holds no reservation while paused", () => {
  test("a STOP during the approach releases the plug at once, and the robot stays put", async () => {
    const { world, robot } = await oneLowRobot();
    await until(robot, () => robot._chargingPhase === "APPROACHING", 20);
    await run(robot, 3);
    expect(robot.status).toBe("RETURNING");
    expect(cw.liveReservations(world, "agent-h")).toHaveLength(1);

    stop(robot, "c-stop-approach");
    await cw.settle();
    expect(robot.status).toBe("PAUSED");
    expect(cw.liveReservations(world, "agent-h")).toHaveLength(0);
    expect(reservationsOf(world, "agent-h")[0]).toMatchObject({ state: RESERVATION_STATE.RELEASED, externalId: RELEASE_REASON.AGENT_RELEASED });

    const held = { lat: robot.lat, lon: robot.lon };
    await run(robot, 30);
    expect({ lat: robot.lat, lon: robot.lon }).toEqual(held);
    // Below the trigger and held: no new session, no new reservation.
    expect(robot._chargingPhase).toBeNull();
    expect(reservationsOf(world, "agent-h")).toHaveLength(1);
  });

  test("a STOP while still asking for a plug (SEEKING) leaves no reservation behind", async () => {
    const { world, robot } = await oneLowRobot();
    clock.advance(constants.TELEMETRY_INTERVAL_MS);
    robot._tick(); // enters SEEKING and sends the request
    stop(robot, "c-stop-seeking");
    await cw.settle();
    await run(robot, 10);
    expect(robot.status).toBe("PAUSED");
    expect(robot._chargingPhase).toBeNull();
    expect(cw.liveReservations(world, "agent-h")).toHaveLength(0);
  });

  test("a held robot below the trigger does not start a session at all", async () => {
    const { world, robot } = await oneLowRobot({ status: "PAUSED" });
    expect(robot.status).toBe("PAUSED");
    await run(robot, 30);
    expect(robot._chargingPhase).toBeNull();
    expect(world.rows.chargerReservation).toHaveLength(0);
  });

  test("RESUME after a release: the robot asks again, drives the route and charges", async () => {
    const { world, robot } = await oneLowRobot();
    await until(robot, () => robot._chargingPhase === "APPROACHING", 20);
    stop(robot, "c-stop");
    await cw.settle();
    resume(robot, "c-resume");
    expect(robot.status).toBe("IDLE");
    await until(robot, () => robot._chargingPhase === "CHARGING", 200);
    expect(at(robot, cw.AT_DEPOT)).toBe(true);
    expect(cw.liveReservations(world, "agent-h")).toHaveLength(1);
    expect(reservationsOf(world, "agent-h")).toHaveLength(2); // the released one, and the new one
  });
});

describe("D-4 — a robot already docked keeps its session while paused", () => {
  test("PAUSED while charging: the session continues to the target, ends PAUSED, and releases TARGET_REACHED", async () => {
    const { world, robot } = await oneLowRobot({ at: cw.AT_DEPOT });
    await until(robot, () => robot._chargingPhase === "CHARGING", 20);
    const before = robot.battery;
    stop(robot, "c-stop-docked");
    await run(robot, 20);
    expect(robot.battery).toBeGreaterThan(before);
    expect(cw.liveReservations(world, "agent-h")).toHaveLength(1);
    await until(robot, () => robot._chargingPhase === null, 2000);
    expect(robot.status).toBe("PAUSED");
    expect(reservationsOf(world, "agent-h")[0]).toMatchObject({ state: RESERVATION_STATE.RELEASED, externalId: RELEASE_REASON.TARGET_REACHED });
  });

  test("PAUSED while queued at the charger: it keeps its place, is promoted, charges and ends PAUSED", async () => {
    const world = cw.createWorld();
    cw.addRobotRow(world, { robotId: "SIM-Q1", agentRowId: "agent-q1", battery: 10 });
    cw.addRobotRow(world, { robotId: "SIM-Q2", agentRowId: "agent-q2", battery: 10 });
    const booted = await cw.boot(clock, world, []);
    const projection = world.rows.chargerAvailabilityProjection[world.rows.chargerAvailabilityProjection.length - 1];
    for (const entry of projection.payload.chargers) entry.plugCount = 1;
    await booted.simulator.addRobot({ robotId: "SIM-Q1", lat: cw.AT_DEPOT.lat, lon: cw.AT_DEPOT.lon, simulated: true });
    await booted.simulator.addRobot({ robotId: "SIM-Q2", lat: cw.AT_DEPOT.lat, lon: cw.AT_DEPOT.lon, simulated: true });
    for (const vr of booted.instances) { vr.socket = cw.makeSocket(); vr.connected = true; }
    const [q1, q2] = ["SIM-Q1", "SIM-Q2"].map(booted.byId);

    await until([q1, q2], () => q1._chargingPhase === "CHARGING" && q2._chargingPhase === "WAITING", 20);
    expect(cw.liveReservations(world, "agent-q2")[0].state).toBe(RESERVATION_STATE.QUEUED);
    stop(q2, "c-stop-queued");
    await run([q1, q2], 10);
    expect(cw.liveReservations(world, "agent-q2")[0].state).toBe(RESERVATION_STATE.QUEUED);

    await until([q1, q2], () => q2._chargingPhase === "CHARGING", 2000);
    await until([q1, q2], () => q2._chargingPhase === null, 2000);
    expect(q2.status).toBe("PAUSED");
    expect(cw.liveReservations(world)).toHaveLength(0);
  });

  test("a docked, paused robot cannot be assigned: its reservation keeps it out of the index", async () => {
    const { world, robot, simulator } = await oneLowRobot({ at: cw.AT_DEPOT });
    await until(robot, () => robot._chargingPhase === "CHARGING", 20);
    stop(robot, "c-stop-assign");
    const read = createChargingStatusReader({ prisma: world.prisma, inScope: (s) => simulator.managesAgent(s) });
    const status = await read("agent-h");
    expect(status).toMatchObject({ known: true, charging: true, chargingInterruptible: false });
    robot._onTaskAssign({ taskId: "TSK-HELD", pathToPickup: [cw.AT_DEPOT, cw.MBA], pathToDrop: [cw.MBA, cw.AWAY] });
    expect(robot.task).toBeNull();
    expect(robot._chargingPhase).toBe("CHARGING");
  });
});

describe("D-4 — expiry and restart", () => {
  test("a reservation that expires during the approach ends the approach; nothing is charged without a plug", async () => {
    const { world, robot } = await oneLowRobot();
    await until(robot, () => robot._chargingPhase === "APPROACHING", 20);
    const row = cw.liveReservations(world, "agent-h")[0];
    row.reservedUntil = new Date(clock.now - 1);
    await devChargingScheduler.reconcile(world.deps(), { nowMs: clock.now });
    expect(cw.liveReservations(world, "agent-h")).toHaveLength(0);

    const before = robot.battery;
    await run(robot, 5);
    expect(robot._chargingPhase).toBeNull();
    expect(robot.status).not.toBe("CHARGING");
    expect(robot.battery).toBeLessThanOrEqual(before);
  });

  test("restart while held AWAY from the charger: the surviving reservation is released, not adopted", async () => {
    const world = cw.createWorld();
    cw.addRobotRow(world, { robotId: "SIM-HA", agentRowId: "agent-ha", battery: 55, status: "OFFLINE", statusBeforeOffline: "PAUSED" });
    cw.seedReservation(world, { agentRowId: "agent-ha", state: RESERVATION_STATE.ACTIVE, fromMs: clock.now - 10 * MINUTE, untilMs: clock.now + HOUR });
    const { byId } = await cw.boot(clock, world, [{ robotId: "SIM-HA", at: cw.AWAY }]);
    const robot = byId("SIM-HA");
    await cw.settle();

    expect(robot.getStatus()).toMatchObject({ chargingRecovery: "RELEASED_HELD_AWAY", status: "PAUSED", chargingPhase: null });
    expect(cw.liveReservations(world, "agent-ha")).toHaveLength(0);
    expect(reservationsOf(world, "agent-ha")[0].externalId).toBe(RELEASE_REASON.AGENT_RELEASED);
    await run(robot, 10);
    expect(robot.distanceTravelled).toBe(0);
  });

  test("restart while held AT the charger: the session resumes with the STOP latched (unchanged)", async () => {
    const world = cw.createWorld();
    cw.addRobotRow(world, { robotId: "SIM-HD", agentRowId: "agent-hd", battery: 40, status: "PAUSED" });
    cw.seedReservation(world, { agentRowId: "agent-hd", state: RESERVATION_STATE.ACTIVE, fromMs: clock.now - 10 * MINUTE, untilMs: clock.now + HOUR });
    const { byId } = await cw.boot(clock, world, [{ robotId: "SIM-HD", at: cw.AT_DEPOT }]);
    const robot = byId("SIM-HD");
    expect(robot.getStatus().chargingRecovery).toBe("RESUMED_AT_CHARGER");
    await until(robot, () => robot._chargingPhase === null, 3000);
    expect(robot.status).toBe("PAUSED");
    expect(robot.battery).toBeGreaterThanOrEqual(79.9);
  });
});

describe("D-8 — a late scheduler answer cannot restore a released reservation in the agent's state", () => {
  test("after the session ends, the agent reports no live reservation, at every tick", async () => {
    const { robot } = await oneLowRobot({ at: cw.AT_DEPOT });
    await until(robot, () => robot._chargingPhase === "CHARGING", 20);
    await until(robot, () => robot._chargingPhase === null, 3000);
    const seen = new Set();
    await run(robot, 20, () => seen.add(robot.getStatus().chargingReservationState));
    expect(seen.has("ACTIVE")).toBe(false);
    expect(seen.has("QUEUED")).toBe(false);
  });

  test("a read that resolves after a release is discarded", async () => {
    const { robot } = await oneLowRobot({ at: cw.AT_DEPOT });
    await until(robot, () => robot._chargingPhase === "CHARGING", 20);
    let resolveLate;
    robot._chargingClient.state = () => new Promise((resolve) => { resolveLate = resolve; });
    robot._schedulerPending = false;
    robot._refreshSchedulerState();
    robot._applyReturnToBase("RETURN");
    await cw.settle();
    resolveLate({ state: "ACTIVE" });
    await cw.settle();
    expect(robot.getStatus().chargingReservationState).not.toBe("ACTIVE");
  });
});
