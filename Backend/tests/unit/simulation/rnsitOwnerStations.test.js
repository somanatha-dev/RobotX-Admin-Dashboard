"use strict";

/**
 * The two RNSIT simulated charging stations at the coordinates the OWNER supplied on 2026-10-13:
 *
 *   RNSIT-CHG-PU-COLLEGE   12.900742024769887, 77.51884060360668
 *   RNSIT-CHG-CANARA-BANK  12.902396962367357, 77.51862316497345
 *
 * Approval is the owner's act: the declaration file approves PU College (owner, 2026-10-13) and
 * keeps Canara Bank unapproved pending its 16.0 m boundary-margin review; the built-in default
 * approves neither. Blocks 3–4 inject `approved: true` for both into THIS ISOLATED TEST WORLD ONLY
 * (an in-memory store, a pinned clock) to exercise the machinery; that is not an approval. Block 5
 * boots on the declaration file as shipped. Plug counts are the simulation default (1 per station),
 * not a measured capacity.
 *
 * REAL: the pinned RNSIT declaration (way/1120154292, the digest-checked OSM boundary), the
 * contained campus sidewalk network (RD-2026-10-12-02), the owner's validation tool, SimulationEngine,
 * VirtualRobot, devChargingScheduler, chargerSelection, chargingStatus (the classifier the
 * Availability Index uses). MOCKED: database (in-memory), sockets, clock.
 */

const cw = require("../../helpers/chargingWorld");

require(cw.ENGINE_PATH);

const seed = require("../../../tools/demo/seedV1Demonstration");
const stationTool = require("../../../tools/charging/validateStationCoordinates");
const chargingStations = require("../../../src/simulation/chargingStations");
const chargerRoute = require("../../../src/simulation/chargerRoute");
const devChargingScheduler = require("../../../src/simulation/devChargingScheduler");
const chargingStatus = require("../../../src/services/chargingStatus.service");
const routeContainment = require("../../../src/services/fleetProviders/routeContainment");
const campusServiceability = require("../../../src/engine/routing/campusServiceability");
const cells = require("../../../src/engine/spatial/cells");

jest.setTimeout(240_000);

const PU = Object.freeze({ lat: 12.900742024769887, lon: 77.51884060360668 });
const CANARA = Object.freeze({ lat: 12.902396962367357, lon: 77.51862316497345 });
const JSSATE = Object.freeze({ lat: 12.9031892, lon: 77.5043182 }); // Academic Block A, the repo's OSM data
const OFF_CAMPUS = Object.freeze({ lat: 12.93, lon: 77.53 });

const shipped = () => chargingStations.loadDeclaration({ SIMULATED_CHARGING_STATIONS_FILE: require("path").resolve(__dirname, "../../../../docs/runbooks/simulated-charging-stations.example.json") });
/** The shipped stations, AS IF APPROVED — test world only. */
const asIfApproved = (ids) => shipped().stations.filter((s) => !ids || ids.includes(s.chargerId)).map((s) => ({ ...s, approved: true }));

const clock = cw.createClock();
beforeEach(() => clock.install());
afterEach(() => clock.uninstall());
const until = (robots, predicate, max) => cw.runUntil(clock, robots, predicate, max);
/** A station's Charger row as provisioning writes it (`devChargingScheduler.provisionStation`). */
const stationRow = (station) => ({ ...cw.DEPOT_ROW, id: "row-station", chargerId: "RNSIT-STATION", latitude: station.lat, longitude: station.lon, cellId: cells.cellForPoint(station.lat, station.lon, cells.RESOLUTION.FINE), isDepot: false });

function worldWithRegion() {
  const world = cw.createWorld();
  world.prisma.region = { async findUnique({ where }) { return where.regionId === "rnsit" ? { id: "region-rnsit", regionId: "rnsit" } : null; } };
  return world;
}

async function bootWith(stations, robots, extra = {}) {
  const world = worldWithRegion();
  for (const r of robots) cw.addRobotRow(world, { robotId: r.robotId, agentRowId: r.agentRowId, battery: r.battery ?? 10 });
  const booted = await cw.boot(clock, world, robots.map((r) => ({ robotId: r.robotId, at: r.at })), {
    simulatorOptions: { stationDeclaration: { includeDepot: true, stations, ...extra } },
  });
  return { world, ...booted };
}

const statusReader = (world) => chargingStatus.createChargingStatusReader({ prisma: world.prisma, inScope: () => true });
const chargerOf = (world, agentRowId) => {
  const held = cw.liveReservations(world, agentRowId)[0];
  return held ? world.rows.charger.find((r) => r.id === held.chargerDbId).chargerId : null;
};

describe("1. the owner's coordinates validate against the authoritative boundary", () => {
  test("the test's pinned declaration IS the digest-checked OSM way/1120154292, unmodified", () => {
    expect(cw.DECLARATION.version).toBe("way/1120154292");
    expect(cw.DECLARATION.boundary).toEqual(seed.loadGeometry().boundary);
  });

  test("the declaration file carries both exact coordinates, plug count 1; PU College approved, Canara Bank not", () => {
    const declared = shipped();
    expect(declared.problems).toEqual([]);
    expect(declared.stations.map((s) => [s.chargerId, s.lat, s.lon, s.plugCount, s.approved])).toEqual([
      ["RNSIT-CHG-PU-COLLEGE", PU.lat, PU.lon, 1, true],
      ["RNSIT-CHG-CANARA-BANK", CANARA.lat, CANARA.lon, 1, false],
    ]);
  });

  test("the owner's tool passes both from the depot: format, INSIDE, reachable by sidewalk, whole route inside", () => {
    const out = stationTool.validate({ declaration: cw.DECLARATION, stations: shipped().stations, from: cw.AT_DEPOT });
    expect(out.ok).toBe(true);
    for (const result of out.results) {
      expect(result.checks).toMatchObject({ format: "PASS", region: "PASS (INSIDE)", routeInsideRegion: "PASS" });
      expect(result.checks.reachable).toMatch(/^PASS/);
    }
    expect(Math.round(out.results[0].routeM)).toBe(161);
    expect(Math.round(out.results[1].routeM)).toBe(299);
  });

  test("the runtime's own validation: PU College is usable; Canara Bank lacks only the approval", () => {
    const [pu, canara] = shipped().stations;
    expect(chargingStations.validateStation({ station: pu, declaration: cw.DECLARATION, reference: cw.AT_DEPOT })).toMatchObject({ usable: true, problems: [] });
    const verdict = chargingStations.validateStation({ station: canara, declaration: cw.DECLARATION, reference: cw.AT_DEPOT });
    expect(verdict.usable).toBe(false);
    expect(verdict.problems.map((p) => p.code)).toEqual(["NOT_APPROVED"]);
  });

  test("the built-in default (no declaration file): neither station approved, the depot alone published, no station row", async () => {
    const world = worldWithRegion();
    const before = world.rows.charger.map((r) => r.chargerId);
    await cw.boot(clock, world, [], { simulatorOptions: { stationDeclaration: null } });
    expect(world.rows.charger.map((r) => r.chargerId)).toEqual(before);
    expect((await devChargingScheduler.publishedEstate(world.deps())).chargers.map((c) => c.chargerId)).toEqual(["V1DEMO-DEPOT-01"]);
  });
});

describe("2. route reachability from representative RNSIT positions; no straight-line fallback", () => {
  const router = () => chargerRoute.createChargerRouter({ deliveryDomainFor: () => cw.DECLARATION });
  const guard = routeContainment.createRouteContainment(cw.DECLARATION);
  const oracle = campusServiceability.createServiceabilityOracle(cw.DECLARATION);
  const points = seed.loadGeometry().points;
  const inside = Object.entries(points).filter(([, p]) => oracle.assess(p.lat, p.lon).status === campusServiceability.SERVICEABILITY.INSIDE);
  const outside = Object.entries(points).filter(([, p]) => oracle.assess(p.lat, p.lon).status !== campusServiceability.SERVICEABILITY.INSIDE);

  test("the campus reference points split as RD-2026-08-30-01 records (3 outside: main gate, playground 1, parking lot)", () => {
    expect(outside.map(([name]) => name).sort()).toEqual(["rnsit-main-gate", "rnsit-parking-lot", "rnsit-playground-1"]);
    expect(inside.length).toBe(8);
  });

  test.each([["PU College", PU], ["Canara Bank", CANARA]])("every in-campus reference point (and the fixture robots) reaches %s, every segment inside the boundary", (_name, station) => {
    for (const [name, from] of [...inside, ["SIM-0A8C (AWAY)", cw.AWAY], ["MBA", cw.MBA]]) {
      const route = router().routeToCharger({ chargerRow: stationRow(station), from, permissionSet: cw.PERMISSION_SET });
      expect({ name, ok: route.ok }).toEqual({ name, ok: true });
      expect(route.distanceM).toBeGreaterThanOrEqual(0);
      for (let i = 1; i < route.points.length; i += 1) expect(guard.containsSegment(route.points[i - 1], route.points[i])).toBe(true);
    }
  });

  test.each([
    ...outside.map(([name, p]) => [name, p]),
    ["off campus (3.7 km)", OFF_CAMPUS],
    ["JSSATE", JSSATE],
  ])("from %s: refused OUTSIDE_OPERATING_BOUNDARY toward either station — no route, no straight line", (_name, from) => {
    for (const station of [PU, CANARA]) {
      const route = router().routeToCharger({ chargerRow: stationRow(station), from, permissionSet: cw.PERMISSION_SET });
      expect(route).toMatchObject({ ok: false, refusal: "OUTSIDE_OPERATING_BOUNDARY" });
      expect(route.points).toBeUndefined();
    }
  });
});

describe("3. AS IF APPROVED (isolated test world): the stations in the estate", () => {
  test("both are provisioned beside the depot (rows ADDED, depot untouched), each with its own plug count", async () => {
    const { world, simulator } = await bootWith(asIfApproved(), []);
    const estate = await devChargingScheduler.publishedEstate(world.deps());
    expect(estate.chargers.map((c) => [c.chargerId, c.plugCount])).toEqual([["V1DEMO-DEPOT-01", 3], ["RNSIT-CHG-PU-COLLEGE", 1], ["RNSIT-CHG-CANARA-BANK", 1]]);
    expect(world.rows.charger.find((r) => r.chargerId === "V1DEMO-DEPOT-01")).toEqual(cw.DEPOT_ROW);
    expect(world.rows.charger.find((r) => r.chargerId === "RNSIT-CHG-PU-COLLEGE")).toMatchObject({ latitude: PU.lat, longitude: PU.lon, isDepot: false });
    // Dashboard markers: every usable station with its position and occupancy.
    const overview = await simulator.chargingOverview();
    expect(overview.stations.map((s) => [s.chargerId, s.usable, s.lat, s.lon, s.plugCount, s.active, s.queued])).toEqual([
      ["V1DEMO-DEPOT-01", true, cw.DEPOT_ROW.latitude, cw.DEPOT_ROW.longitude, 3, 0, 0],
      ["RNSIT-CHG-PU-COLLEGE", true, PU.lat, PU.lon, 1, 0, 0],
      ["RNSIT-CHG-CANARA-BANK", true, CANARA.lat, CANARA.lon, 1, 0, 0],
    ]);
  });

  test("nearest REACHABLE charger: a robot at each station charges there; one at the depot charges at the depot", async () => {
    const { world, byId } = await bootWith(asIfApproved(), [
      { robotId: "SIM-AT-PU", agentRowId: "agent-pu", at: PU },
      { robotId: "SIM-AT-CANARA", agentRowId: "agent-canara", at: CANARA },
      { robotId: "SIM-AT-DEPOT", agentRowId: "agent-depot", at: cw.AT_DEPOT },
    ]);
    const robots = ["SIM-AT-PU", "SIM-AT-CANARA", "SIM-AT-DEPOT"].map(byId);
    await until(robots, () => robots.every((r) => r._chargingPhase === "CHARGING"), 60);
    expect([chargerOf(world, "agent-pu"), chargerOf(world, "agent-canara"), chargerOf(world, "agent-depot")]).toEqual([
      "RNSIT-CHG-PU-COLLEGE",
      "RNSIT-CHG-CANARA-BANK",
      "V1DEMO-DEPOT-01",
    ]);
  });

  test("off-campus and JSSATE robots needing charge are blocked by name, hold no reservation, and do not move", async () => {
    const { world, byId } = await bootWith(asIfApproved(), [
      { robotId: "SIM-OFF", agentRowId: "agent-off", at: OFF_CAMPUS },
      { robotId: "SIM-JSS", agentRowId: "agent-jss", at: JSSATE },
    ]);
    const robots = ["SIM-OFF", "SIM-JSS"].map(byId);
    await cw.runTicks(clock, robots, 30);
    for (const [robot, agentRowId, at] of [[robots[0], "agent-off", OFF_CAMPUS], [robots[1], "agent-jss", JSSATE]]) {
      expect(cw.liveReservations(world, agentRowId)).toHaveLength(0);
      expect(robot.chargingView().blocked).toMatchObject({ code: "ROUTE_REFUSED" });
      expect(JSON.stringify(robot.chargingView().blocked)).toMatch(/OUTSIDE_OPERATING_BOUNDARY/);
      expect({ lat: robot.lat, lon: robot.lon }).toEqual(at);
    }
  });
});

describe("4. AS IF APPROVED: approach, queue, charge, release, return — and no work meanwhile", () => {
  test("approaching Canara Bank from the depot: the route, the ETA, the station marker, and the robot is not assignable", async () => {
    const { world, byId, simulator } = await bootWith(asIfApproved(["RNSIT-CHG-CANARA-BANK"]), [{ robotId: "SIM-APP", agentRowId: "agent-app", at: cw.AT_DEPOT }], { includeDepot: false });
    const robot = byId("SIM-APP");
    await until(robot, () => robot._chargingPhase === "APPROACHING", 40);
    const view = robot.chargingView();
    expect(view).toMatchObject({ phase: "APPROACHING", stationId: "RNSIT-CHG-CANARA-BANK", stationLat: CANARA.lat, stationLon: CANARA.lon });
    expect(view.remainingRouteM).toBeGreaterThan(250);
    expect(view.etaArrivalS).toBeGreaterThan(0);
    expect(view.route.length).toBeGreaterThan(1);
    const guard = routeContainment.createRouteContainment(cw.DECLARATION);
    for (let i = 1; i < view.route.length; i += 1) expect(guard.containsSegment(view.route[i - 1], view.route[i])).toBe(true);
    // The Availability Index's classifier: holding a plug while driving to it is not available.
    expect(await statusReader(world)("agent-app")).toMatchObject({ known: true, charging: true });
    expect((await simulator.chargingOverview()).stations[0]).toMatchObject({ chargerId: "RNSIT-CHG-CANARA-BANK", active: 1, queued: 0 });
  });

  test("PU College's one plug taken: the second robot QUEUES (no other station), is told its place and wait; then each charges, releases at the target, and returns to the fleet", async () => {
    const { world, byId, simulator } = await bootWith(asIfApproved(["RNSIT-CHG-PU-COLLEGE"]), [
      { robotId: "SIM-P1", agentRowId: "agent-p1", at: PU },
      { robotId: "SIM-P2", agentRowId: "agent-p2", at: PU, battery: 30 },
    ], { includeDepot: false });
    const [first, second] = ["SIM-P1", "SIM-P2"].map(byId);
    await until([first, second], () => first._chargingPhase === "CHARGING", 40);
    second.battery = 10;
    await until([first, second], () => second._chargingPhase === "WAITING", 40);

    // Queued: the plug is first's; second holds a QUEUED place, is not charging, and is not assignable.
    expect(cw.liveReservations(world, "agent-p2")[0].state).toBe("QUEUED");
    expect(await statusReader(world)("agent-p1")).toMatchObject({ known: true, charging: true });
    expect(await statusReader(world)("agent-p2")).toMatchObject({ known: true, charging: false, waiting: true });
    const overview = await simulator.chargingOverview();
    expect(overview.stations[0]).toMatchObject({ chargerId: "RNSIT-CHG-PU-COLLEGE", plugCount: 1, active: 1, queued: 1 });
    expect(overview.robots["SIM-P2"].queuePosition).toBe(1);
    expect(overview.robots["SIM-P2"].estimatedWaitS).toBeGreaterThan(0);
    expect(first.chargingView().etaCompleteS).toBeGreaterThan(0);

    // First reaches the target: plug released (TARGET_REACHED), back to IDLE, assignable again.
    // The session's completing tick still reports CHARGING (D-2); the next one is IDLE.
    await until([first, second], () => first._chargingPhase === null && first.status === "IDLE", 3000);
    expect(first.status).toBe("IDLE");
    expect(first.battery).toBeGreaterThanOrEqual(79.9);
    expect(world.rows.chargerReservation.find((r) => r.agentId === "agent-p1").externalId).toBe("TARGET_REACHED");
    expect(await statusReader(world)("agent-p1")).toMatchObject({ known: true, charging: false, waiting: false });

    // Second is promoted to the freed plug and finishes the same way.
    await until([first, second], () => second._chargingPhase === "CHARGING", 60);
    await until([first, second], () => second._chargingPhase === null && second.status === "IDLE", 3000);
    expect(second.status).toBe("IDLE");
    expect(cw.liveReservations(world)).toHaveLength(0);
    expect(await statusReader(world)("agent-p2")).toMatchObject({ known: true, charging: false, waiting: false });
  });
});

describe("5. the declaration file AS SHIPPED: PU College active beside the depot, Canara Bank excluded", () => {
  const fileStations = () => shipped().stations;

  test("the estate: depot (3 plugs) + PU College (1 plug); Canara Bank never gets a row", async () => {
    const { world, simulator } = await bootWith(fileStations(), []);
    expect((await devChargingScheduler.publishedEstate(world.deps())).chargers.map((c) => [c.chargerId, c.plugCount])).toEqual([["V1DEMO-DEPOT-01", 3], ["RNSIT-CHG-PU-COLLEGE", 1]]);
    expect(world.rows.charger.some((r) => r.chargerId === "RNSIT-CHG-CANARA-BANK")).toBe(false);
    const overview = await simulator.chargingOverview();
    expect(overview.stations.map((s) => [s.chargerId, s.usable])).toEqual([["V1DEMO-DEPOT-01", true], ["RNSIT-CHG-PU-COLLEGE", true], ["RNSIT-CHG-CANARA-BANK", false]]);
  });

  test("a robot at PU College charges at PU College; one standing at the Canara Bank point charges at a USABLE station, never Canara Bank", async () => {
    const { world, byId } = await bootWith(fileStations(), [
      { robotId: "SIM-NEAR-PU", agentRowId: "agent-near-pu", at: PU },
      { robotId: "SIM-NEAR-CANARA", agentRowId: "agent-near-canara", at: CANARA },
    ]);
    const robots = ["SIM-NEAR-PU", "SIM-NEAR-CANARA"].map(byId);
    await until(robots, () => robots.every((r) => r._chargingPhase === "APPROACHING" || r._chargingPhase === "CHARGING" || r._chargingPhase === "WAITING"), 60);
    expect(chargerOf(world, "agent-near-pu")).toBe("RNSIT-CHG-PU-COLLEGE");
    expect(["V1DEMO-DEPOT-01", "RNSIT-CHG-PU-COLLEGE"]).toContain(chargerOf(world, "agent-near-canara"));
    expect(world.rows.charger.some((r) => r.chargerId === "RNSIT-CHG-CANARA-BANK")).toBe(false);
  });

  test("off-campus and JSSATE robots still cannot reach any RNSIT station: blocked by name, no reservation, no movement", async () => {
    const { world, byId } = await bootWith(fileStations(), [
      { robotId: "SIM-OFF5", agentRowId: "agent-off5", at: OFF_CAMPUS },
      { robotId: "SIM-JSS5", agentRowId: "agent-jss5", at: JSSATE },
    ]);
    const robots = ["SIM-OFF5", "SIM-JSS5"].map(byId);
    await cw.runTicks(clock, robots, 30);
    for (const [robot, agentRowId, at] of [[robots[0], "agent-off5", OFF_CAMPUS], [robots[1], "agent-jss5", JSSATE]]) {
      expect(cw.liveReservations(world, agentRowId)).toHaveLength(0);
      expect(JSON.stringify(robot.chargingView().blocked)).toMatch(/OUTSIDE_OPERATING_BOUNDARY/);
      expect({ lat: robot.lat, lon: robot.lon }).toEqual(at);
    }
  });
});

describe("6. a reservation at a charger that has LEFT the estate never strands its robot (live-run defect, 2026-10-13)", () => {
  // Measured on a live run: the depot excluded by the declaration after a robot's depot session, and
  // the robot held NO_PLUG for hours — its ACTIVE depot reservation could be neither served nor
  // replaced. The scheduler now releases its OWN grants at a charger outside the published estate.
  const onlyPu = () => shipped().stations.filter((s) => s.chargerId === "RNSIT-CHG-PU-COLLEGE");

  test("the depot excluded after a session: the scheduler's own depot reservation is released CHARGER_SUPERSEDED and the robot charges at PU College", async () => {
    const world = worldWithRegion();
    cw.addRobotRow(world, { robotId: "SIM-LEFT", agentRowId: "agent-left", battery: 15 });
    const row = cw.seedReservation(world, { agentRowId: "agent-left", charger: cw.DEPOT_ROW, state: "ACTIVE", fromMs: clock.now - 60_000, untilMs: clock.now + 2 * 3600_000 });
    const { byId } = await cw.boot(clock, world, [{ robotId: "SIM-LEFT", at: cw.AT_DEPOT }], {
      simulatorOptions: { stationDeclaration: { includeDepot: false, stations: onlyPu() } },
    });
    expect(row).toMatchObject({ state: "RELEASED", externalId: "CHARGER_SUPERSEDED" });
    const robot = byId("SIM-LEFT");
    await until(robot, () => robot._chargingPhase === "APPROACHING" || robot._chargingPhase === "CHARGING", 40);
    expect(chargerOf(world, "agent-left")).toBe("RNSIT-CHG-PU-COLLEGE");
    expect(robot.chargingView().blocked).toBeNull();
  });

  test("a FOREIGN reservation at a charger outside the estate (not granted under this scheduler's projections) is NOT released", async () => {
    const world = worldWithRegion();
    cw.addRobotRow(world, { robotId: "SIM-FOREIGN", agentRowId: "agent-foreign", battery: 60 });
    const row = cw.seedReservation(world, { agentRowId: "agent-foreign", charger: cw.DEPOT_ROW, state: "ACTIVE", fromMs: clock.now - 60_000, untilMs: clock.now + 2 * 3600_000 });
    row.projectionVersion = 999; // no projection of this scheduler has that version
    await cw.boot(clock, world, [{ robotId: "SIM-FOREIGN", at: cw.AT_DEPOT }], {
      simulatorOptions: { stationDeclaration: { includeDepot: false, stations: onlyPu() } },
    });
    expect(row.state).toBe("ACTIVE");
  });

  test("a reservation at a charger still IN the estate is kept (the session continues)", async () => {
    const world = worldWithRegion();
    cw.addRobotRow(world, { robotId: "SIM-KEEP", agentRowId: "agent-keep", battery: 15 });
    const row = cw.seedReservation(world, { agentRowId: "agent-keep", charger: cw.DEPOT_ROW, state: "ACTIVE", fromMs: clock.now - 60_000, untilMs: clock.now + 2 * 3600_000 });
    await cw.boot(clock, world, [{ robotId: "SIM-KEEP", at: cw.AT_DEPOT }], {
      simulatorOptions: { stationDeclaration: { includeDepot: true, stations: onlyPu() } },
    });
    expect(row.state).toBe("ACTIVE");
  });
});
