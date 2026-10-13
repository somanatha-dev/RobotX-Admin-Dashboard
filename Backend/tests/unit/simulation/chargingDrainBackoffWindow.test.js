"use strict";

/**
 * D-5, D-6, D-7 (docs/ROBOTX_CHARGING_LIFECYCLE_AUDIT.md).
 *
 *   D-5 — the drain follows what the robot is DOING (working on a mission, or driving to a
 *         charger), not its status label: an `ISSUES` robot drove at full speed on the idle rate.
 *   D-6 — when no charger can be had (no charger row, no route) the robot backs off, boundedly,
 *         and says why; it used to re-ask every tick (900 scheduler reads and 902 warnings in
 *         30 min) or create and release a reservation row every ~30 s (57 rows in 30 min).
 *   D-7 — a reservation's window is computed from the robot's own commissioned pack, not a fixed
 *         1000 Wh: a large pack was cut off (STALE_EXPIRED) before reaching its target.
 */

const cw = require("../../helpers/chargingWorld");

require(cw.ENGINE_PATH);

const VirtualRobot = require("../../../src/simulation/VirtualRobot");
const constants = require("../../../src/simulation/constants");
const devChargingScheduler = require("../../../src/simulation/devChargingScheduler");
const chargeCurve = require("../../../src/engine/energy/chargeCurve");

jest.setTimeout(120_000);

const { RESERVATION_STATE, RELEASE_REASON } = devChargingScheduler;
const clock = cw.createClock();
beforeEach(() => clock.install());
afterEach(() => clock.uninstall());

const run = (robots, ticks, onTick) => cw.runTicks(clock, robots, ticks, onTick);
const until = (robots, predicate, max) => cw.runUntil(clock, robots, predicate, max);

describe("D-5 — the drain follows what the robot is doing", () => {
  function agent() {
    const robot = new VirtualRobot({ robotId: "SIM-D5", lat: 12.9, lon: 77.5, logger: cw.silentLogger, kv: cw.makeFlash(), simulated: true });
    robot.socket = cw.makeSocket();
    robot.connected = true;
    return robot;
  }
  const path = Array.from({ length: 40 }, (_, i) => ({ lat: 12.9 + i * 0.0005, lon: 77.5 }));

  test("a robot on a mission drains at the working rate whatever its status label (here ISSUES, from an older build or the server)", async () => {
    const working = agent();
    working.battery = 50;
    working._onTaskAssign({ taskId: "T-A", pathToPickup: path, pathToDrop: [...path].reverse() });
    const labelled = agent();
    labelled.battery = 50;
    labelled._onTaskAssign({ taskId: "T-B", pathToPickup: path, pathToDrop: [...path].reverse() });
    labelled.status = "ISSUES";

    await run([working, labelled], 20);
    expect(labelled.distanceTravelled).toBeGreaterThan(0);
    expect(50 - labelled.battery).toBeCloseTo(50 - working.battery, 6);
  });

  test("an idle robot still drains at the standby rate", async () => {
    const idle = agent();
    idle.battery = 50;
    await run(idle, 20);
    const working = agent();
    working.battery = 50;
    working._onTaskAssign({ taskId: "T-C", pathToPickup: path, pathToDrop: [...path].reverse() });
    await run(working, 20);
    expect(50 - idle.battery).toBeGreaterThan(0);
    expect(50 - idle.battery).toBeLessThan(50 - working.battery);
  });
});

describe("D-6 — no usable charger: bounded back-off and a visible reason", () => {
  test("no charger row at all: a handful of requests in 30 min, not one per tick; the reason is reported", async () => {
    const world = cw.createWorld({ chargers: [] });
    cw.addRobotRow(world, { robotId: "SIM-NOCH", agentRowId: "agent-noch", battery: 10 });
    const { byId, log } = await cw.boot(clock, world, [{ robotId: "SIM-NOCH", at: cw.AWAY }]);
    const robot = byId("SIM-NOCH");
    const readsBefore = world.calls["chargerAvailabilityProjection.findFirst"] || 0;

    await run(robot, 900); // 30 min

    const reads = (world.calls["chargerAvailabilityProjection.findFirst"] || 0) - readsBefore;
    // Back-off 30 s doubling to 10 min: at most 7 attempts in 30 min (was one per tick: 900), each
    // reading the published projection at most twice (station selection, then the plug request).
    const attempts = robot.getStatus().chargingBlocked.attempts;
    expect(attempts).toBeLessThanOrEqual(7);
    expect(reads).toBeLessThanOrEqual(2 * (attempts + 1));
    expect(log.lines.filter((l) => l.level === "warn").length).toBeLessThanOrEqual(30);
    expect(world.rows.chargerReservation).toHaveLength(0);
    expect(robot.status).toBe("IDLE");
    expect(robot.getStatus().chargingBlocked).toMatchObject({ code: "NO_PLUG" });
    expect(robot.getStatus().chargingBlocked.detail).toMatch(/V1DEMO-DEPOT-01/);
    expect(robot.getStatus().chargingBlocked.retryAtMs).toBeGreaterThan(clock.now);
  });

  test("no route to the charger: a few reservations in 30 min (was 57), each released; the reason names the refusal", async () => {
    const world = cw.createWorld();
    cw.addRobotRow(world, { robotId: "SIM-NORT", agentRowId: "agent-nort", battery: 10 });
    const { byId } = await cw.boot(clock, world, [{ robotId: "SIM-NORT", at: cw.AWAY }], { deliveryDomain: null });
    const robot = byId("SIM-NORT");

    await run(robot, 900);

    expect(world.rows.chargerReservation.length).toBeLessThanOrEqual(10);
    expect(world.rows.chargerReservation.every((row) => row.state === RESERVATION_STATE.RELEASED)).toBe(true);
    expect(robot.getStatus().chargingBlocked).toMatchObject({ code: "ROUTE_REFUSED" });
    expect(robot.getStatus().chargingBlocked.detail).toMatch(/NO_DELIVERY_DOMAIN/);
    expect(robot.status).toBe("IDLE");
  });

  test("once a charge succeeds the reason is cleared", async () => {
    const world = cw.createWorld();
    cw.addRobotRow(world, { robotId: "SIM-RECOVER", agentRowId: "agent-recover", battery: 10 });
    let domain = null;
    const { byId } = await cw.boot(clock, world, [{ robotId: "SIM-RECOVER", at: cw.AWAY }], { simulatorOptions: { deliveryDomainFor: () => domain } });
    const robot = byId("SIM-RECOVER");
    await run(robot, 20);
    expect(robot.getStatus().chargingBlocked).not.toBeNull();
    domain = cw.DECLARATION;
    await until(robot, () => robot._chargingPhase === "CHARGING", 600);
    expect(robot.getStatus().chargingBlocked).toBeNull();
  });
});

describe("D-7 — the reservation window is computed from the robot's own pack", () => {
  const fullChargeSeconds = (packWh) => chargeCurve.timeToChargeSeconds({
    curve: constants.CHARGE_POWER_CURVE, fromSoc: 0, toSoc: 1, tempC: -10, chargerClass: "STANDARD",
    packUsableWh: packWh, steps: constants.CHARGE_CURVE_INTEGRATION_STEPS,
  }).seconds;

  test("a request carries the pack: the window covers that pack's worst-case full charge", async () => {
    const world = cw.createWorld();
    await devChargingScheduler.provision({ prisma: world.prisma }, { nowMs: clock.now });
    const verdict = await devChargingScheduler.requestPlug(world.deps(), { agentRowId: "agent-big", targetSoc: 0.8, nowMs: clock.now, packNominalWh: 8000 });
    expect(verdict.ok).toBe(true);
    const row = verdict.reservation;
    const windowSeconds = (row.reservedUntil.getTime() - row.reservedFrom.getTime()) / 1000;
    expect(windowSeconds).toBeGreaterThanOrEqual(fullChargeSeconds(8000));
    // ...and promotion keeps that window length, starting when current flows.
    clock.advance(5_000);
    await devChargingScheduler.promote(world.deps(), { nowMs: clock.now });
    const promoted = world.rows.chargerReservation[0];
    expect(promoted.state).toBe(RESERVATION_STATE.ACTIVE);
    expect((promoted.reservedUntil.getTime() - clock.now) / 1000).toBeGreaterThanOrEqual(fullChargeSeconds(8000));
  });

  test("a 7 kWh robot charges 10 → 80 % without its reservation expiring under it", async () => {
    const world = cw.createWorld();
    cw.addRobotRow(world, { robotId: "SIM-BIG", agentRowId: "agent-big", battery: 10, packNominalWh: 7000 });
    const { byId } = await cw.boot(clock, world, [{ robotId: "SIM-BIG", at: cw.AT_DEPOT }]);
    const robot = byId("SIM-BIG");
    let ticks = 0;
    const done = await until(robot, () => {
      ticks += 1;
      if (ticks % 5 === 0) devChargingScheduler.reconcile(world.deps(), { nowMs: clock.now });
      return robot._chargingPhase === null && robot.battery >= 79.9;
    }, 6000);
    expect(done).toBeGreaterThan(0);
    const row = world.rows.chargerReservation[0];
    expect(row.externalId).toBe(RELEASE_REASON.TARGET_REACHED);
  });
});
