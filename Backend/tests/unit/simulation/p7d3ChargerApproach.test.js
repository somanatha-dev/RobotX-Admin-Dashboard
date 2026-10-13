"use strict";

/**
 * P7-D3 Step 1 — a simulated robot reserves the depot, DRIVES there over the campus network,
 * and only then charges.
 *
 * Before: `VirtualRobot._enterCharging` docked where the robot stood (measured on LOCAL: 159 m
 * from the charger it held, 10 → 79 % at speed 0). After:
 *   reserve a plug  →  route over the campus traversal network  →  drive (RETURNING)
 *   →  CHARGING only inside the docking radius of the reserved charger.
 *
 * The route is the SAME `campusTraversalNetwork.route(from, to)` the engine's return leg is priced
 * on (P7-C1 Step 3), over the network built from the pinned delivery-domain declaration and the
 * robot class's permitted ways. No straight-line fallback exists: no network, no route, no charge.
 *
 * Docking radius: `chargerRoute.DOCKING_RADIUS_M` — the simulator's own arrival tolerance. A
 * campus route ends exactly at its destination's coordinate (`campusTraversalNetwork.route`), and
 * the stepper arrives at a path's last point within that tolerance, so "docked" means "at the
 * charger's declared coordinate". A physical docking tolerance is hardware's to state.
 *
 * MOCKED BOUNDARIES: the agent's socket and flash storage, the wall clock, and the Charging
 * Scheduler client (stubbed, with a route provider). The campus network, the fixture's real
 * RNSIT declaration and permission sets, `chargerRoute`, and VirtualRobot are real.
 */

const path = require("path");

const VirtualRobot = require("../../../src/simulation/VirtualRobot");
const constants = require("../../../src/simulation/constants");
const chargerRoute = require("../../../src/simulation/chargerRoute");
const campusTraversalNetwork = require("../../../src/simulation/campusTraversalNetwork");
const { RELEASE_REASON } = require("../../../src/simulation/devChargingScheduler");
const { haversineMeters } = require("../../../src/utils/distance");
const fixture = require("../../fixtures/phase7/local-2026-10-09.json");

jest.setTimeout(60_000);

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

/* ── Harness (as `phase7SimulationIntegrity.test.js`) ─────────────────────── */

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

function makeAgent(overrides) {
  const socket = makeSocket();
  const robot = new VirtualRobot({ logger: silentLogger, kv: makeFlash(), simulated: true, ...overrides, socket: undefined });
  robot.socket = socket;
  robot.connected = true;
  return { robot, socket };
}

let clock = 1_791_521_745_000;
/** Drive ticks on one clock, letting the client's promises settle between ticks. */
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

const metres = (a, b) => haversineMeters(a.lat, a.lon, b.lat, b.lon);
const pathLength = (points) => points.slice(1).reduce((sum, point, i) => sum + metres(points[i], point), 0);

/* ── A synthetic campus geometry for the VirtualRobot cases ─────────────────── */

const START = { lat: 12.9, lon: 77.5 };
const CHARGER = { chargerId: "V1DEMO-DEPOT-01", lat: 12.901, lon: 77.5 };
const ROUTE = { ok: true, points: [START, { lat: 12.9005, lon: 77.5003 }, { lat: CHARGER.lat, lon: CHARGER.lon }], charger: CHARGER };
ROUTE.distanceM = pathLength(ROUTE.points);

/**
 * A Charging Scheduler client double with a route provider. `plug` is the verdict every
 * request/state answers until a release, after which it answers NONE.
 */
function chargingClient({ plug = "ACTIVE", route = ROUTE } = {}) {
  let state = plug;
  const calls = { request: 0, state: 0, release: [], route: [] };
  return {
    calls,
    client: {
      async request() { calls.request += 1; if (state === "NONE") state = plug; return { state }; },
      async state() { calls.state += 1; return { state }; },
      async release(reason) { calls.release.push(reason); state = "NONE"; return { ok: true }; },
      async routeToCharger(from) {
        calls.route.push({ ...from });
        if (typeof route === "function") return route(from);
        return route;
      },
    },
  };
}

/** A critically low robot at START with the given client. */
function lowRobot(client, overrides) {
  const { robot, socket } = makeAgent({ robotId: "SIM-P7D3", lat: START.lat, lon: START.lon, chargingClient: client, ...overrides });
  robot.battery = constants.BATTERY_CRITICAL_THRESHOLD;
  return { robot, socket };
}

/* ═══════════════════════════════════════════════════════════════════════════
   1. VirtualRobot: reserve → route → drive → dock
   ═══════════════════════════════════════════════════════════════════════════ */

describe("P7-D3 Step 1 — a simulated robot drives to the reserved charger before charging", () => {
  test("a robot away from the charger does not enter CHARGING: with a plug granted it reports RETURNING and moves", async () => {
    const { calls, client } = chargingClient();
    const { robot } = lowRobot(client);

    await runTicks(robot, 6);

    expect(calls.request).toBeGreaterThan(0);
    expect(calls.route).toEqual([START]);
    expect(robot.status).toBe("RETURNING");
    expect(robot.distanceTravelled).toBeGreaterThan(0);
    expect(robot.battery).toBeLessThan(constants.BATTERY_CRITICAL_THRESHOLD); // drains while driving, never rises
  });

  test("it follows the route and enters CHARGING only at the charger, having driven the route's length", async () => {
    const { client } = chargingClient();
    const { robot, socket } = lowRobot(client);
    const chargingAt = [];

    for (let chunk = 0; chunk < 20 && robot.status !== "CHARGING"; chunk += 1) {
      // eslint-disable-next-line no-await-in-loop
      await runTicks(robot, 10, (r) => { if (r.status === "CHARGING") chargingAt.push({ lat: r.lat, lon: r.lon }); });
    }

    expect(robot.status).toBe("CHARGING");
    for (const point of chargingAt) expect(metres(point, CHARGER)).toBeLessThanOrEqual(chargerRoute.DOCKING_RADIUS_M);
    // Within half a millimetre: the stepper interpolates a partial move linearly in lat/lon, the
    // route length is haversine.
    expect(robot.distanceTravelled).toBeCloseTo(ROUTE.distanceM, 3);
    expect(robot.lat).toBe(CHARGER.lat);
    expect(robot.lon).toBe(CHARGER.lon);

    // The charge now flows, at the charger, without moving.
    const level = robot.battery;
    const travelled = robot.distanceTravelled;
    await runTicks(robot, 40);
    expect(robot.battery).toBeGreaterThan(level);
    expect(robot.distanceTravelled).toBe(travelled);

    // Every telemetry frame that claimed CHARGING was sent from the charger.
    const frames = socket.emitted.filter((entry) => entry.event === "TELEMETRY" && entry.payload && entry.payload.status === "CHARGING");
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) expect(metres(frame.payload, CHARGER)).toBeLessThanOrEqual(chargerRoute.DOCKING_RADIUS_M);
  });

  test("a robot already at the charger docks without driving", async () => {
    const { calls, client } = chargingClient({ route: { ok: true, points: [{ lat: CHARGER.lat, lon: CHARGER.lon }, { lat: CHARGER.lat, lon: CHARGER.lon }], distanceM: 0, charger: CHARGER } });
    const { robot } = lowRobot(client, { lat: CHARGER.lat, lon: CHARGER.lon });

    await runTicks(robot, 4);

    expect(calls.route).toHaveLength(1);
    expect(robot.status).toBe("CHARGING");
    expect(robot.distanceTravelled).toBe(0);
  });

  test("a robot outside the radius cannot charge, even holding a live ACTIVE reservation — the session is abandoned and the plug released", async () => {
    const { calls, client } = chargingClient();
    const { robot } = lowRobot(client);
    for (let chunk = 0; chunk < 20 && robot.status !== "CHARGING"; chunk += 1) await runTicks(robot, 10); // eslint-disable-line no-await-in-loop
    await runTicks(robot, 20);
    expect(robot._chargingPhase).toBe("CHARGING");

    // Moved off the charger while still holding the plug.
    robot.lat += 0.0005;
    const level = robot.battery;
    await runTicks(robot, 5);

    expect(robot.battery).toBeLessThanOrEqual(level);
    expect(robot.status).not.toBe("CHARGING");
    expect(calls.release).toContain(RELEASE_REASON.AGENT_RELEASED);
  });

  test("a robot told it is CHARGING with a live reservation but no verified dock gains no charge", async () => {
    const { client } = chargingClient();
    const { robot } = lowRobot(client, { lat: 12.95, lon: 77.55 });
    // The state a robot could be left in by a defect or a forced status: charging, plug held,
    // but it never docked at a charger this robot verified.
    robot.status = "CHARGING";
    robot._chargingPhase = "CHARGING";
    robot._schedulerState = "ACTIVE";
    robot.battery = 40;

    await runTicks(robot, 5);

    expect(robot.battery).toBeLessThanOrEqual(40);
    expect(robot.status).not.toBe("CHARGING");
  });

  test.each([
    ["refused (not connected)", () => ({ ok: false, refusal: "NOT_CONNECTED", reason: "no permitted way connects them" })],
    ["thrown", () => { throw new Error("network unavailable"); }],
    ["absent (no route data)", () => null],
  ])("a route %s: never CHARGING, never moves, the plug is released, and the route is asked again only after the retry interval", async (_label, route) => {
    const { calls, client } = chargingClient({ route });
    const { robot } = lowRobot(client);
    const statuses = new Set();

    await runTicks(robot, 10, (r) => statuses.add(r.status));

    expect(statuses.has("CHARGING")).toBe(false);
    expect(robot.lat).toBe(START.lat);
    expect(robot.lon).toBe(START.lon);
    expect(robot.distanceTravelled).toBe(0);
    expect(robot.battery).toBeLessThanOrEqual(constants.BATTERY_CRITICAL_THRESHOLD);
    expect(calls.release).toContain(RELEASE_REASON.AGENT_RELEASED);
    // 10 ticks = 20 s, inside the 30 s retry interval: asked once.
    expect(calls.route).toHaveLength(1);

    await runTicks(robot, 15); // past the retry interval
    expect(calls.route.length).toBeGreaterThanOrEqual(2);
    expect(robot.status).not.toBe("CHARGING");
  });

  test.each([
    ["a non-finite charger coordinate", { ...ROUTE, charger: { ...CHARGER, lat: Number.NaN } }],
    ["no charger", { ...ROUTE, charger: null }],
    ["a route that does not end at the charger", { ...ROUTE, points: ROUTE.points.slice(0, 2) }],
    ["a route that does not start at the robot", { ...ROUTE, points: [{ lat: 12.8, lon: 77.4 }, ...ROUTE.points.slice(1)] }],
    ["a one-point route", { ...ROUTE, points: [START] }],
  ])("%s is refused like a missing route: no charge in place, plug released", async (_label, route) => {
    const { calls, client } = chargingClient({ route });
    const { robot } = lowRobot(client);
    const statuses = new Set();

    await runTicks(robot, 10, (r) => statuses.add(r.status));

    expect(statuses.has("CHARGING")).toBe(false);
    expect(robot.distanceTravelled).toBe(0);
    expect(calls.release).toContain(RELEASE_REASON.AGENT_RELEASED);
  });

  test("no plug verdict (the request fails): no route is asked for and the robot never reports CHARGING", async () => {
    const calls = { route: 0 };
    const client = {
      async request() { throw new Error("database unavailable"); },
      async state() { return { state: "NONE" }; },
      async release() { return { ok: true }; },
      async routeToCharger() { calls.route += 1; return ROUTE; },
    };
    const { robot } = lowRobot(client);
    const statuses = new Set();

    await runTicks(robot, 10, (r) => statuses.add(r.status));

    expect(calls.route).toBe(0);
    expect(statuses.has("CHARGING")).toBe(false);
    expect(robot.distanceTravelled).toBe(0);
  });

  test("a QUEUED reservation still drives to the charger, then waits there for its plug (no charge before the grant)", async () => {
    const { client } = chargingClient({ plug: "QUEUED" });
    const { robot } = lowRobot(client);
    for (let chunk = 0; chunk < 20 && robot.status !== "CHARGING"; chunk += 1) await runTicks(robot, 10); // eslint-disable-line no-await-in-loop

    expect(robot.status).toBe("CHARGING");
    expect(robot._chargingPhase).toBe("WAITING");
    expect(metres(robot, CHARGER)).toBeLessThanOrEqual(chargerRoute.DOCKING_RADIUS_M);
    const level = robot.battery;
    await runTicks(robot, 20);
    expect(robot.battery).toBeLessThanOrEqual(level);
  });

  test("a RECALL during the approach abandons it and releases the plug", async () => {
    const { calls, client } = chargingClient();
    const { robot } = lowRobot(client);
    await runTicks(robot, 4);
    expect(robot.status).toBe("RETURNING");

    robot._applyReturnToBase("RECALL");

    expect(robot.status).toBe("IDLE");
    expect(robot._chargingPhase).toBeNull();
    expect(robot.activePath).toBeNull();
    expect(calls.release.length).toBeGreaterThan(0);
  });

  test("a STOP during the approach holds position and RELEASES the plug (D-4); after RESUME it asks again and drives to the charger", async () => {
    // The route double starts wherever the robot asks from, as the real campus route does.
    const fromHere = (from) => ({ ok: true, points: [{ ...from }, { lat: CHARGER.lat, lon: CHARGER.lon }], charger: CHARGER, distanceM: metres(from, CHARGER) });
    const { calls, client } = chargingClient({ route: fromHere });
    const { robot } = lowRobot(client);
    await runTicks(robot, 4);
    robot._applyStop("STOP");
    const held = { lat: robot.lat, lon: robot.lon };
    // D-4 (charging audit, owner decision 2026-10-12) — not docked, so the plug is not kept.
    expect(calls.release).toEqual([RELEASE_REASON.AGENT_RELEASED]);

    await runTicks(robot, 5);
    expect(robot.lat).toBe(held.lat);
    expect(robot.lon).toBe(held.lon);
    expect(robot.status).toBe("PAUSED");
    expect(robot._chargingPhase).toBeNull();

    robot._applyResume();
    for (let chunk = 0; chunk < 20 && robot.status !== "CHARGING"; chunk += 1) await runTicks(robot, 10); // eslint-disable-line no-await-in-loop
    expect(robot.status).toBe("CHARGING");
    expect(metres(robot, CHARGER)).toBeLessThanOrEqual(chargerRoute.DOCKING_RADIUS_M);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   2. chargerRoute: the campus route to the depot, from the real RNSIT network
   ═══════════════════════════════════════════════════════════════════════════ */

describe("P7-D3 Step 1 — chargerRoute routes over the same campus network the engine prices on", () => {
  const declaration = fixture.configVersion.payload.deliveryDomain;
  const depotRow = fixture.rows.Charger.find((row) => row.chargerId === "V1DEMO-DEPOT-01");
  const permissionSet = fixture.rows.MobilityModel[0].permissionSet;
  const SIM_0A8C = { lat: 12.901151, lon: 77.517575 };

  test("the docking radius is the simulator's own arrival tolerance", () => {
    expect(chargerRoute.DOCKING_RADIUS_M).toBe(0.01);
    expect(chargerRoute.withinDockingRadius({ lat: depotRow.latitude, lon: depotRow.longitude }, { lat: depotRow.latitude, lon: depotRow.longitude })).toBe(true);
    expect(chargerRoute.withinDockingRadius({ lat: depotRow.latitude + 0.00001, lon: depotRow.longitude }, { lat: depotRow.latitude, lon: depotRow.longitude })).toBe(false);
    expect(chargerRoute.withinDockingRadius({ lat: Number.NaN, lon: 0 }, { lat: 0, lon: 0 })).toBe(false);
    expect(chargerRoute.withinDockingRadius({ lat: 0, lon: 0 }, null)).toBe(false);
  });

  test("a real route from SIM-0A8C's position to the depot: starts at the robot, ends exactly at the depot", () => {
    const router = chargerRoute.createChargerRouter({ deliveryDomainFor: () => declaration });
    const out = router.routeToCharger({ chargerRow: depotRow, from: SIM_0A8C, permissionSet });

    expect(out.ok).toBe(true);
    expect(out.charger).toEqual({ chargerId: "V1DEMO-DEPOT-01", lat: depotRow.latitude, lon: depotRow.longitude });
    expect(out.points[0]).toEqual(SIM_0A8C);
    expect(out.points[out.points.length - 1]).toEqual({ lat: depotRow.latitude, lon: depotRow.longitude });
    expect(out.distanceM).toBeCloseTo(pathLength(out.points), 9);
    expect(out.distanceM).toBeGreaterThanOrEqual(metres(SIM_0A8C, { lat: depotRow.latitude, lon: depotRow.longitude }));
  });

  test("agreement: from TSK-816's drop stop the simulator's route is exactly the engine's priced return (65.71 m)", async () => {
    // The engine's exact return hop for TSK-816 (P7-C1 Step 3): its origin is the drop stop.
    const w = require("../../engine/helpers/phase7World");
    const out = await w.decide({
      decisionTimeMs: w.TSK816.assignRoundMs,
      robots: [{ robotId: "SIM-0A8C043FFE67", at: SIM_0A8C, socFraction: 0.29, status: "IDLE", positionAgeMs: 351 }],
    });
    const engineReturn = out.routeCalls.find((call) => call.ok && call.stops.length === 1 && call.stops[0].cellId === depotRow.cellId);
    const router = chargerRoute.createChargerRouter({ deliveryDomainFor: () => declaration });
    const simulated = router.routeToCharger({ chargerRow: depotRow, from: engineReturn.originPoint, permissionSet });

    expect(simulated.ok).toBe(true);
    expect(simulated.distanceM).toBeCloseTo(engineReturn.hops[0].distanceM, 9);
    expect(simulated.distanceM).toBeCloseTo(65.7059, 3);
  });

  test("the extract is read once and the network built once per permitted class set", () => {
    const extractFor = jest.fn(campusTraversalNetwork.extractForDeclaration);
    const router = chargerRoute.createChargerRouter({ deliveryDomainFor: () => declaration, extractFor });
    for (let i = 0; i < 3; i += 1) router.routeToCharger({ chargerRow: depotRow, from: SIM_0A8C, permissionSet });
    expect(extractFor).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["no delivery-domain declaration is pinned", { deliveryDomainFor: () => null }, {}, chargerRoute.ROUTE_REFUSAL.NO_DELIVERY_DOMAIN],
    ["the declaration names no extract on file", { deliveryDomainFor: () => ({ ...declaration, version: "way/1" }) }, {}, chargerRoute.ROUTE_REFUSAL.NO_CAMPUS_EXTRACT],
    ["the class permits no ways", {}, { permissionSet: { roadClasses: [] } }, chargerRoute.ROUTE_REFUSAL.NO_PERMITTED_WAYS],
    ["the charger row is absent", {}, { chargerRow: null }, chargerRoute.ROUTE_REFUSAL.CHARGER_UNUSABLE],
    ["the charger states no coordinate", {}, { chargerRow: { ...depotRow, latitude: null } }, chargerRoute.ROUTE_REFUSAL.CHARGER_UNUSABLE],
    ["the charger coordinate is out of range", {}, { chargerRow: { ...depotRow, latitude: 95 } }, chargerRoute.ROUTE_REFUSAL.CHARGER_UNUSABLE],
    ["the charger is not a depot", {}, { chargerRow: { ...depotRow, isDepot: false } }, chargerRoute.ROUTE_REFUSAL.CHARGER_UNUSABLE],
    ["the robot's position is not a point", {}, { from: { lat: "12.9", lon: 77.5 } }, chargerRoute.ROUTE_REFUSAL.MALFORMED_POSITION],
  ])("refused by name, never a straight line: %s", (_label, routerOptions, request, refusal) => {
    const router = chargerRoute.createChargerRouter({ deliveryDomainFor: () => declaration, ...routerOptions });
    const out = router.routeToCharger({ chargerRow: depotRow, from: SIM_0A8C, permissionSet, ...request });
    expect(out).toMatchObject({ ok: false, refusal });
    expect(typeof out.reason).toBe("string");
    expect(out.points).toBeUndefined();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   3. SimulationEngine wires the route provider into each robot's charging client
   ═══════════════════════════════════════════════════════════════════════════ */

describe("P7-D3 Step 1 — SimulationEngine hands each robot a route to the depot for its own class", () => {
  test("the charging client routes from the robot to the depot row over the class's permitted ways", async () => {
    const constructed = [];
    let createVirtualRobotSimulator;
    jest.isolateModules(() => {
      jest.doMock(path.resolve(__dirname, "../../../src/simulation/VirtualRobot"), () =>
        jest.fn().mockImplementation((options) => {
          constructed.push(options);
          return { robotId: options.robotId, commission: async () => {}, connect() {}, start() {}, stop() {} };
        }),
      );
      ({ createVirtualRobotSimulator } = require("../../../src/simulation/SimulationEngine"));
    });

    const depotRow = fixture.rows.Charger.find((row) => row.chargerId === "V1DEMO-DEPOT-01");
    const permissionSet = fixture.rows.MobilityModel[0].permissionSet;
    const selects = [];
    const prisma = {
      robot: {
        findUnique: async (args) => {
          selects.push(args.select);
          return {
            battery: 10,
            simulated: true,
            massKg: null,
            agent: { id: "agent-row-1", batteryState: null, agentClass: { mobilityModel: { kinematicLimits: null, speedModel: null, permissionSet }, energyModel: null, containerModel: null, energyModelParams: [] } },
          };
        },
      },
      charger: { findUnique: async ({ where }) => (where.chargerId === depotRow.chargerId ? { ...depotRow } : null) },
      // Phase B — the client routes to the charger the agent holds a plug at; this agent holds none.
      chargerReservation: { findFirst: async () => null },
    };
    const simulator = createVirtualRobotSimulator({
      prisma,
      kv: makeFlash(),
      logger: silentLogger,
      enabled: true,
      deliveryDomainFor: () => fixture.configVersion.payload.deliveryDomain,
    });

    await simulator.addRobot({ robotId: "SIM-0A8C043FFE67", lat: 12.901151, lon: 77.517575, simulated: true });

    expect(selects[0].agent.select.agentClass.select.mobilityModel.select.permissionSet).toBe(true);
    const client = constructed[0].chargingClient;
    const route = await client.routeToCharger({ lat: 12.901151, lon: 77.517575 });
    expect(route.ok).toBe(true);
    expect(route.charger.chargerId).toBe("V1DEMO-DEPOT-01");
    expect(route.points[route.points.length - 1]).toEqual({ lat: depotRow.latitude, lon: depotRow.longitude });
  });
});
