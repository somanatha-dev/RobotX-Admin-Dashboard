"use strict";

/**
 * The charging lifecycle end to end, in isolated simulation, on the new defaults.
 *
 * A simulated robot commissioned like the physical RobotX — 44.4 Wh pack, 2 m/s, 15 % reserve,
 * coefficients from the simulation power policy (9.5 W standby, 30 W at 2 m/s) — starts a delivery
 * at 21 %, crosses the 20 % trigger mid-delivery, FINISHES the delivery, then seeks a charger,
 * drives the campus route to it, charges to 80 % and returns to IDLE at the charger. Every frame
 * it sent is then replayed through the real engine-on telemetry handler: none is refused, the row
 * never becomes ISSUES, and the last word is IDLE at ~80 %.
 *
 * REAL: SimulationEngine, VirtualRobot, devChargingScheduler, chargerRoute, energyPolicy,
 * telemetry.handler. MOCKED: database (in-memory), sockets, clock.
 */

const cw = require("../../helpers/chargingWorld");

require(cw.ENGINE_PATH);

const simulatedAgentState = require("../../../src/simulation/simulatedAgentState");
const energyPolicy = require("../../../src/simulation/energyPolicy");
const campusTraversalNetwork = require("../../../src/simulation/campusTraversalNetwork");
const { createTelemetryReplay } = require("../../helpers/telemetryReplay");

jest.setTimeout(180_000);

const clock = cw.createClock();
beforeEach(() => clock.install());
afterEach(() => clock.uninstall());

function campusPath(from, to) {
  const extract = campusTraversalNetwork.extractForDeclaration(cw.DECLARATION);
  const network = campusTraversalNetwork.createCampusTraversalNetwork({
    features: extract.features,
    roadClasses: campusTraversalNetwork.permittedClasses(cw.PERMISSION_SET),
    source: extract.file,
  });
  const routed = network.route(from, to);
  if (!routed.ok) throw new Error(routed.reason);
  return routed.points.map((p) => ({ lat: p.lat, lon: p.lon }));
}

test("delivery across the trigger → finish → seek → drive → charge to 80 % → IDLE; every frame accepted by the server", async () => {
  const world = cw.createWorld();
  cw.addRobotRow(world, { robotId: "SIM-E2E", agentRowId: "agent-e2e", battery: 21, packNominalWh: 44.4, batteryReservePct: 15 });
  const row = world.robots.get("SIM-E2E");
  row.agent.agentClass.mobilityModel = { ...row.agent.agentClass.mobilityModel, speedModel: { nominalSpeedMps: 2 }, kinematicLimits: { maxSpeedMps: 2.5 } };
  row.agent.agentClass.energyModelParams = [simulatedAgentState.simulatedEnergyCoefficients(44.4)];
  const { byId, simulator } = await cw.boot(clock, world, [{ robotId: "SIM-E2E", at: cw.AWAY }]);
  const robot = byId("SIM-E2E");
  expect(robot.getStatus()).toMatchObject({ capacityWh: 44.4, chargeTriggerPct: 20, energyBasis: null });

  // A campus delivery: AWAY → MBA → AWAY (≈ 2 × 385 m by sidewalk).
  robot._onTaskAssign({ taskId: "TSK-E2E", pathToPickup: campusPath(cw.AWAY, cw.MBA), pathToDrop: campusPath(cw.MBA, cw.AWAY) });
  const seen = { crossedOnTask: false, statuses: new Set(), views: {} };
  await cw.runUntil(clock, robot, () => {
    seen.statuses.add(robot.status);
    if (robot.task && robot.battery <= 20) seen.crossedOnTask = true;
    const view = robot.chargingView();
    if (view.phase && !seen.views[view.phase]) seen.views[view.phase] = view;
    return robot.socket.emitted.some((e) => e.event === "TASK_COMPLETE") && robot._chargingPhase === null && robot.battery >= 79.9;
  }, 6000);

  // Crossed 20 % on the delivery, kept going (no ISSUES), finished it.
  expect(seen.crossedOnTask).toBe(true);
  expect(seen.statuses.has("ISSUES")).toBe(false);
  expect(robot.socket.emitted.filter((e) => e.event === "TASK_COMPLETE")).toHaveLength(1);
  // Then the session, stage by stage, with what the dashboard shows.
  expect(seen.views.SEEKING).toBeDefined();
  expect(seen.views.APPROACHING.stationId).toBe("V1DEMO-DEPOT-01");
  expect(seen.views.APPROACHING.remainingRouteM).toBeGreaterThan(0);
  expect(seen.views.APPROACHING.etaArrivalS).toBeCloseTo(seen.views.APPROACHING.remainingRouteM / 2, 6);
  expect(seen.views.CHARGING.etaCompleteS).toBeGreaterThan(0);
  expect(seen.views.CHARGING.targetPct).toBe(80);
  // Ended IDLE, at the charger, plug released at the target.
  expect(robot.status).toBe("IDLE");
  expect(cw.liveReservations(world)).toHaveLength(0);
  expect(world.rows.chargerReservation[0].externalId).toBe("TARGET_REACHED");
  expect(robot.getStatus().energyBasis).toBe("SIMULATED_POWER_WH");
  const overview = await simulator.chargingOverview();
  expect(overview.stations[0]).toMatchObject({ chargerId: "V1DEMO-DEPOT-01", active: 0, queued: 0, plugCount: 3 });

  // Every frame through the real engine-on handler.
  await cw.runTicks(clock, robot, 30);
  const frames = robot.socket.emitted.filter((e) => e.event === "TELEMETRY").map((e) => e.payload);
  const replay = await createTelemetryReplay({
    robotId: "SIM-E2E",
    row: { status: "ACTIVE", battery: frames[0].battery, lat: frames[0].lat, lon: frames[0].lon },
    configValues: { "security.implausible_report_quarantine_threshold": 3 },
  });
  const refused = [];
  const dbStatuses = new Set();
  for (const frame of frames) {
    // eslint-disable-next-line no-await-in-loop
    const outcome = await replay.send(frame);
    if (!outcome.accepted) refused.push({ status: frame.status, battery: frame.battery });
    dbStatuses.add(replay.dbRow.status);
  }
  expect(refused).toEqual([]);
  expect(replay.securityEvents()).toHaveLength(0);
  expect(dbStatuses.has("ISSUES")).toBe(false);
  expect(replay.dbRow.status).toBe("IDLE");
  expect(replay.dbRow.battery).toBeGreaterThanOrEqual(79);

  // The arithmetic, for the report: the delivery's consumption on the stated power model.
  const policy = energyPolicy.policy();
  expect(policy).toMatchObject({ standbyPowerW: 9.5, movingPowerW: 30 });
});
