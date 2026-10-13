"use strict";

/**
 * Phase B (charging lifecycle) — configurable charging stations, contained routing and station
 * selection.
 *
 * TEST COORDINATES: the stations below are placed at two known RNSIT campus points from the
 * fixture (the MBA-block centroid and SIM-0A8C's LOCAL position) purely so the machinery can be
 * exercised. They are NOT the owner's PU College / Canara Bank coordinates (supplied 2026-10-13;
 * see `rnsitOwnerStations.test.js`); the shipped declaration keeps both stations unapproved.
 *
 * REAL: SimulationEngine, VirtualRobot, devChargingScheduler, chargerRoute, chargingStations,
 * chargerSelection, campusTraversalNetwork + deliveryDomain over the pinned RNSIT declaration.
 */

const cw = require("../../helpers/chargingWorld");

require(cw.ENGINE_PATH);

const chargingStations = require("../../../src/simulation/chargingStations");
const chargerSelection = require("../../../src/simulation/chargerSelection");
const chargerRoute = require("../../../src/simulation/chargerRoute");
const devChargingScheduler = require("../../../src/simulation/devChargingScheduler");
const stationTool = require("../../../tools/charging/validateStationCoordinates");

jest.setTimeout(120_000);

const clock = cw.createClock();
beforeEach(() => clock.install());
afterEach(() => clock.uninstall());
const until = (robots, predicate, max) => cw.runUntil(clock, robots, predicate, max);

const OFF_CAMPUS = { lat: 12.93, lon: 77.53 }; // ≈3.7 km from RNSIT, outside its delivery domain
const STATION_A = { chargerId: "TEST-STATION-MBA", name: "Test station A (MBA block)", regionId: "rnsit", approved: true, lat: cw.MBA.lat, lon: cw.MBA.lon, plugCount: 1 };
const STATION_B = { chargerId: "TEST-STATION-AWAY", name: "Test station B", regionId: "rnsit", approved: true, lat: cw.AWAY.lat, lon: cw.AWAY.lon, plugCount: 1 };

function worldWithRegion() {
  const world = cw.createWorld();
  world.prisma.region = { async findUnique({ where }) { return where.regionId === "rnsit" ? { id: "region-rnsit", regionId: "rnsit" } : null; } };
  return world;
}

describe("chargerSelection — reachable, reserve-keeping, soonest to charge", () => {
  test("expected wait: free plug → 0; otherwise the matching finishing session; unknown → null", () => {
    expect(chargerSelection.expectedWaitSeconds({ plugCount: 2, activeRemainingS: [100], queued: 0 })).toBe(0);
    expect(chargerSelection.expectedWaitSeconds({ plugCount: 1, activeRemainingS: [300], queued: 0 })).toBe(300);
    expect(chargerSelection.expectedWaitSeconds({ plugCount: 2, activeRemainingS: [500, 200], queued: 1 })).toBe(500);
    expect(chargerSelection.expectedWaitSeconds({ plugCount: 1, activeRemainingS: [300], queued: 1 })).toBeNull();
    expect(chargerSelection.expectedWaitSeconds({ plugCount: 1, activeRemainingS: [null], queued: 0 })).toBeNull();
  });

  const robot = { speedMps: 2, whPerMetre: 0.01, availableWh: 20, reserveWh: 10 };

  test("an unreachable station is excluded by name; straight-line nearness plays no part", () => {
    const out = chargerSelection.selectStation({ robot, candidates: [{ chargerId: "NEAR", refusal: "OUTSIDE_DELIVERY_DOMAIN", reason: "x" }, { chargerId: "FAR", distanceM: 900, plugCount: 1, activeRemainingS: [], queued: 0 }] });
    expect(out.chosen.chargerId).toBe("FAR");
    expect(out.excluded).toEqual([{ chargerId: "NEAR", reason: "OUTSIDE_DELIVERY_DOMAIN: x" }]);
  });

  test("a farther free station beats a nearer one whose wait outlasts the extra drive", () => {
    const out = chargerSelection.selectStation({
      robot,
      candidates: [
        { chargerId: "NEAR-BUSY", distanceM: 100, plugCount: 1, activeRemainingS: [900], queued: 0 },
        { chargerId: "FAR-FREE", distanceM: 400, plugCount: 1, activeRemainingS: [], queued: 0 },
      ],
    });
    expect(out.chosen.chargerId).toBe("FAR-FREE");
  });

  test("a wait shorter than the drive costs nothing: the nearer busy station wins", () => {
    const out = chargerSelection.selectStation({
      robot,
      candidates: [
        { chargerId: "NEAR-BUSY", distanceM: 100, plugCount: 1, activeRemainingS: [30], queued: 0 },
        { chargerId: "FAR-FREE", distanceM: 400, plugCount: 1, activeRemainingS: [], queued: 0 },
      ],
    });
    expect(out.chosen.chargerId).toBe("NEAR-BUSY");
  });

  test("urgency: when no station keeps the reserve, the one costing least energy is chosen, whatever its queue", () => {
    const low = { ...robot, availableWh: 12 }; // 2 Wh above the reserve: 200 m at 0.01 Wh/m
    const out = chargerSelection.selectStation({
      robot: low,
      candidates: [
        { chargerId: "NEAR-BUSY", distanceM: 300, plugCount: 1, activeRemainingS: [3000], queued: 2 },
        { chargerId: "FAR-FREE", distanceM: 900, plugCount: 1, activeRemainingS: [], queued: 0 },
      ],
    });
    expect(out.urgent).toBe(true);
    expect(out.chosen.chargerId).toBe("NEAR-BUSY");
  });
});

describe("chargingStations — declaration and coordinate validation", () => {
  test("with no declaration file, the two intended RNSIT stations are listed at the owner's coordinates (2026-10-13), unapproved", () => {
    const declared = chargingStations.normaliseDeclaration(null);
    expect(declared.stations.map((s) => [s.chargerId, s.approved, s.lat, s.lon, s.plugCount])).toEqual([
      ["RNSIT-CHG-PU-COLLEGE", false, 12.900742024769887, 77.51884060360668, 1],
      ["RNSIT-CHG-CANARA-BANK", false, 12.902396962367357, 77.51862316497345, 1],
    ]);
  });

  test("the built-in stations validate except for the approval, which is all that is missing", () => {
    for (const station of chargingStations.normaliseDeclaration(null).stations) {
      const verdict = chargingStations.validateStation({ station, declaration: cw.DECLARATION, reference: cw.AT_DEPOT });
      expect(verdict.usable).toBe(false);
      expect(verdict.problems.map((p) => p.code)).toEqual(["NOT_APPROVED"]);
    }
  });

  test("the validation says exactly what is missing, and never invents a coordinate", () => {
    const [pu] = chargingStations.normaliseDeclaration(null).stations;
    const verdict = chargingStations.validateStation({ station: { ...pu, lat: null, lon: null }, declaration: cw.DECLARATION, reference: cw.AT_DEPOT });
    expect(verdict.usable).toBe(false);
    expect(verdict.problems.map((p) => p.code)).toEqual(["NOT_APPROVED", "NO_COORDINATE"]);
    expect(verdict.problems[1].detail).toMatch(/WGS-84/);
    expect(verdict.cellId).toBeNull();
  });

  test.each([
    ["a string coordinate", { lat: "12.9", lon: "77.5" }, "MALFORMED_COORDINATE"],
    ["out of range", { lat: 120, lon: 77.5 }, "MALFORMED_COORDINATE"],
  ])("refused: %s", (_label, coordinate, code) => {
    const verdict = chargingStations.validateStation({ station: { ...STATION_A, ...coordinate }, declaration: cw.DECLARATION, reference: cw.AT_DEPOT });
    expect(verdict.usable).toBe(false);
    expect(verdict.problems.map((p) => p.code)).toContain(code);
  });

  test("an approved campus coordinate validates: reachable from the depot, with a cell, route and access connector reported", () => {
    const verdict = chargingStations.validateStation({ station: STATION_A, declaration: cw.DECLARATION, reference: cw.AT_DEPOT });
    expect(verdict).toMatchObject({ usable: true, problems: [] });
    expect(typeof verdict.cellId).toBe("string");
    expect(verdict.accessM).toBeGreaterThanOrEqual(0);
    expect(verdict.routeM).toBeGreaterThan(0);
  });

  test("no pinned declaration: refused by name (no campus network to check reachability on)", () => {
    const verdict = chargingStations.validateStation({ station: STATION_A, declaration: null, reference: cw.AT_DEPOT });
    expect(verdict.problems.map((p) => p.code)).toEqual(["NO_DELIVERY_DOMAIN"]);
  });

  test("a duplicate id and a bad plug count are reported by name", () => {
    const declared = chargingStations.normaliseDeclaration({ stations: [{ chargerId: "X", plugCount: 0 }, { chargerId: "X" }] });
    expect(declared.problems.join(" ")).toMatch(/plugCount must be an integer/);
    expect(declared.problems.join(" ")).toMatch(/declared twice/);
  });
});

describe("tools/charging/validateStationCoordinates — the owner's pre-approval check (region, format, reachability)", () => {
  const run = (stations) => stationTool.validate({ declaration: cw.DECLARATION, stations, from: cw.AT_DEPOT });

  test("a campus coordinate passes every check, with its route and access connector stated", () => {
    const out = run([STATION_A]);
    expect(out.ok).toBe(true);
    expect(out.results[0].checks).toMatchObject({ format: "PASS", region: "PASS (INSIDE)", routeInsideRegion: "PASS" });
    expect(out.results[0].checks.reachable).toMatch(/^PASS — \d+ m by sidewalk; access connector/);
  });

  test("a coordinate outside the operating region fails the region check", () => {
    const out = run([{ ...STATION_A, chargerId: "OUT", lat: OFF_CAMPUS.lat, lon: OFF_CAMPUS.lon }]);
    expect(out.ok).toBe(false);
    expect(out.results[0].checks.region).toMatch(/^FAIL — OUTSIDE/);
  });

  test("a string coordinate fails the format check; a missing one is reported as needed, not as a failure", () => {
    const out = run([{ ...STATION_A, chargerId: "STR", lat: "12.9", lon: "77.5" }, { ...STATION_B, chargerId: "NONE", lat: null, lon: null }]);
    expect(out.results[0].checks.format).toMatch(/^FAIL/);
    expect(out.results[1].checks.format).toMatch(/^NEEDS COORDINATE/);
    expect(out.results[1].pass).toBeNull();
  });
});

describe("two configured stations — provisioning and selection through the real engine", () => {
  async function bootWithStations(stations, robots, extra = {}) {
    const world = worldWithRegion();
    for (const r of robots) cw.addRobotRow(world, { robotId: r.robotId, agentRowId: r.agentRowId, battery: r.battery ?? 10 });
    const booted = await cw.boot(clock, world, robots.map((r) => ({ robotId: r.robotId, at: r.at })), {
      simulatorOptions: { stationDeclaration: { includeDepot: true, stations, ...extra } },
    });
    return { world, ...booted };
  }

  test("both approved stations are provisioned (rows ADDED, depot untouched) and published with their own capacity", async () => {
    const { world, provisioned, simulator } = await bootWithStations([STATION_A, STATION_B], []);
    expect(provisioned.ok).toBe(true);
    const estate = await devChargingScheduler.publishedEstate(world.deps());
    expect(estate.chargers.map((c) => [c.chargerId, c.plugCount])).toEqual([["V1DEMO-DEPOT-01", 3], ["TEST-STATION-MBA", 1], ["TEST-STATION-AWAY", 1]]);
    expect(world.rows.charger.find((r) => r.chargerId === "TEST-STATION-MBA")).toMatchObject({ isDepot: false, chargerClass: "STANDARD", regionId: "region-rnsit" });
    expect(world.rows.charger.find((r) => r.chargerId === "V1DEMO-DEPOT-01")).toEqual(cw.DEPOT_ROW);
    const overview = await simulator.chargingOverview();
    expect(overview.stations.map((s) => [s.chargerId, s.usable, s.plugCount])).toEqual([
      ["V1DEMO-DEPOT-01", true, 3], ["TEST-STATION-MBA", true, 1], ["TEST-STATION-AWAY", true, 1],
    ]);
  });

  test("a robot standing at station B selects it, drives nowhere, and charges there", async () => {
    const { world, byId } = await bootWithStations([STATION_A, STATION_B], [{ robotId: "SIM-B", agentRowId: "agent-b", at: cw.AWAY }]);
    const robot = byId("SIM-B");
    await until(robot, () => robot._chargingPhase === "CHARGING", 40);
    const held = cw.liveReservations(world, "agent-b")[0];
    expect(world.rows.charger.find((r) => r.id === held.chargerDbId).chargerId).toBe("TEST-STATION-AWAY");
    expect(chargerRoute.withinDockingRadius(robot, cw.AWAY)).toBe(true);
  });

  test("with station B's single plug taken, the next robot there goes where it would start charging soonest — not into B's queue", async () => {
    const { world, byId } = await bootWithStations(
      [STATION_A, STATION_B],
      [{ robotId: "SIM-1", agentRowId: "agent-1", at: cw.AWAY }, { robotId: "SIM-2", agentRowId: "agent-2", at: cw.AWAY, battery: 30 }],
    );
    const first = byId("SIM-1");
    const second = byId("SIM-2");
    await until([first, second], () => first._chargingPhase === "CHARGING", 40);
    second.battery = 10;
    await until([first, second], () => second._chargingPhase === "APPROACHING" || second._chargingPhase === "WAITING", 40);
    const held = cw.liveReservations(world, "agent-2")[0];
    const chosen = world.rows.charger.find((r) => r.id === held.chargerDbId).chargerId;
    expect(chosen).not.toBe("TEST-STATION-AWAY");
    await until([first, second], () => second._chargingPhase === "CHARGING", 600);
    expect(second.status).toBe("CHARGING");
  });

  test("an approved station with a malformed coordinate is excluded from the estate and reported", async () => {
    const bad = { ...STATION_A, chargerId: "TEST-STATION-BAD", lat: "12.9", lon: "77.5" };
    const { world, simulator } = await bootWithStations([bad, STATION_B], []);
    const estate = await devChargingScheduler.publishedEstate(world.deps());
    expect(estate.chargers.map((c) => c.chargerId)).not.toContain("TEST-STATION-BAD");
    expect(world.rows.charger.some((r) => r.chargerId === "TEST-STATION-BAD")).toBe(false);
    const overview = await simulator.chargingOverview();
    const entry = overview.stations.find((s) => s.chargerId === "TEST-STATION-BAD");
    expect(entry).toMatchObject({ usable: false, lat: null, lon: null });
    // A malformed coordinate is never published, not even for display.
    expect(entry).toMatchObject({ declaredLat: null, declaredLon: null });
    expect(entry.problems.map((p) => p.code)).toContain("MALFORMED_COORDINATE");
  });

  test("an existing row at a different coordinate is not rewritten; the station is refused", async () => {
    const world = worldWithRegion();
    world.rows.charger.push({ id: "pre-existing", chargerId: "TEST-STATION-MBA", latitude: cw.AWAY.lat, longitude: cw.AWAY.lon, cellId: "x", chargerClass: "STANDARD", isDepot: false });
    const { simulator } = await cw.boot(clock, world, [], { simulatorOptions: { stationDeclaration: { stations: [STATION_A] } } });
    expect(world.rows.charger.find((r) => r.chargerId === "TEST-STATION-MBA")).toMatchObject({ latitude: cw.AWAY.lat });
    const overview = await simulator.chargingOverview();
    expect(overview.stations.find((s) => s.chargerId === "TEST-STATION-MBA").usable).toBe(false);
  });

  test("the shipped default (owner coordinates, not approved): only the depot is in the estate; both stations listed with what is missing", async () => {
    const world = worldWithRegion();
    const { simulator } = await cw.boot(clock, world, [], { simulatorOptions: { stationDeclaration: null } });
    const estate = await devChargingScheduler.publishedEstate(world.deps());
    expect(estate.chargers.map((c) => c.chargerId)).toEqual(["V1DEMO-DEPOT-01"]);
    const overview = await simulator.chargingOverview();
    expect(overview.stations.map((s) => [s.chargerId, s.usable, s.problems.map((p) => p.code)])).toEqual([
      ["V1DEMO-DEPOT-01", true, []],
      ["RNSIT-CHG-PU-COLLEGE", false, ["NOT_APPROVED"]],
      ["RNSIT-CHG-CANARA-BANK", false, ["NOT_APPROVED"]],
    ]);
  });

  test("the overview gives a queued robot its place and a wait derived from the session ahead of it", async () => {
    const { byId, simulator } = await bootWithStations([], [
      { robotId: "SIM-Q1", agentRowId: "agent-q1", at: cw.AT_DEPOT },
      { robotId: "SIM-Q2", agentRowId: "agent-q2", at: cw.AT_DEPOT },
    ], { includeDepot: true });
    const [q1, q2] = ["SIM-Q1", "SIM-Q2"].map(byId);
    // Depot has 3 plugs: both charge. The queue path is covered by `chargingHoldAndReservations`.
    await until([q1, q2], () => q1._chargingPhase === "CHARGING" && q2._chargingPhase === "CHARGING", 40);
    const overview = await simulator.chargingOverview();
    expect(overview.robots["SIM-Q1"]).toMatchObject({ queuePosition: 0, estimatedWaitS: 0 });
    expect(q1.chargingView().etaCompleteS).toBeGreaterThan(0);
    expect(q1.chargingView().stationId).toBe("V1DEMO-DEPOT-01");
  });
});

describe("RD-2026-10-12-02 — simulated charger routes are contained within the campus traversal network", () => {
  const routeContainment = require("../../../src/services/fleetProviders/routeContainment");
  // A real JSSATE campus point (Academic Block A, from the repository's own OSM data).
  const JSSATE = { lat: 12.9031892, lon: 77.5043182 };
  const router = () => chargerRoute.createChargerRouter({ deliveryDomainFor: () => cw.DECLARATION });

  test("in-campus robots route exactly as before, and every point of every route lies inside the boundary", () => {
    const guard = routeContainment.createRouteContainment(cw.DECLARATION);
    for (const [from, metres] of [[cw.AWAY, 62], [cw.MBA, 385]]) {
      const route = router().routeToCharger({ chargerRow: { ...cw.DEPOT_ROW }, from, permissionSet: cw.PERMISSION_SET });
      expect(route.ok).toBe(true);
      expect(Math.round(route.distanceM)).toBe(metres);
      for (let i = 1; i < route.points.length; i += 1) expect(guard.containsSegment(route.points[i - 1], route.points[i])).toBe(true);
    }
  });

  test.each([["off campus (3.7 km away)", OFF_CAMPUS], ["at JSSATE", JSSATE]])("a robot %s is refused by name — no straight-line route", (_label, from) => {
    const route = router().routeToCharger({ chargerRow: { ...cw.DEPOT_ROW }, from, permissionSet: cw.PERMISSION_SET });
    expect(route).toMatchObject({ ok: false, refusal: "OUTSIDE_OPERATING_BOUNDARY" });
    expect(route.points).toBeUndefined();
  });

  test.each([["off campus", OFF_CAMPUS], ["at JSSATE", JSSATE]])("a simulated robot %s needing charge is blocked with the reason, holds no reservation and does not move", async (_label, at) => {
    const world = cw.createWorld();
    cw.addRobotRow(world, { robotId: "SIM-AWAY-CAMPUS", agentRowId: "agent-away-campus", battery: 10 });
    const { byId } = await cw.boot(clock, world, [{ robotId: "SIM-AWAY-CAMPUS", at }]);
    const robot = byId("SIM-AWAY-CAMPUS");
    await cw.runTicks(clock, robot, 30);
    expect(robot.getStatus().chargingBlocked).toMatchObject({ code: "ROUTE_REFUSED" });
    expect(robot.getStatus().chargingBlocked.detail).toMatch(/OUTSIDE_OPERATING_BOUNDARY/);
    expect(cw.liveReservations(world)).toHaveLength(0);
    expect(robot.distanceTravelled).toBe(0);
  });

  test("a station outside the boundary is refused at provisioning and never joins the estate", async () => {
    const world = worldWithRegion();
    const outside = { ...STATION_A, chargerId: "TEST-STATION-OUTSIDE", lat: OFF_CAMPUS.lat, lon: OFF_CAMPUS.lon };
    const { simulator } = await cw.boot(clock, world, [], { simulatorOptions: { stationDeclaration: { stations: [outside] } } });
    const estate = await devChargingScheduler.publishedEstate(world.deps());
    expect(estate.chargers.map((c) => c.chargerId)).toEqual(["V1DEMO-DEPOT-01"]);
    const entry = (await simulator.chargingOverview()).stations.find((s) => s.chargerId === "TEST-STATION-OUTSIDE");
    expect(entry.usable).toBe(false);
    expect(entry.problems.map((p) => p.code)).toContain("OUTSIDE_OPERATING_BOUNDARY");
  });

  test("an unreachable charger in the estate is excluded from selection; the reachable one is chosen", async () => {
    const world = worldWithRegion();
    cw.addRobotRow(world, { robotId: "SIM-SEL", agentRowId: "agent-sel", battery: 10 });
    const { byId } = await cw.boot(clock, world, [{ robotId: "SIM-SEL", at: cw.AWAY }], { simulatorOptions: { stationDeclaration: { stations: [STATION_A] } } });
    // The station's row is moved off the campus after it was provisioned: it is now unreachable.
    const row = world.rows.charger.find((r) => r.chargerId === "TEST-STATION-MBA");
    Object.assign(row, { latitude: OFF_CAMPUS.lat, longitude: OFF_CAMPUS.lon });
    const robot = byId("SIM-SEL");
    await cw.runUntil(clock, robot, () => robot._chargingPhase === "CHARGING", 200);
    const held = world.rows.chargerReservation.find((r) => r.agentId === "agent-sel");
    expect(world.rows.charger.find((r) => r.id === held.chargerDbId).chargerId).toBe("V1DEMO-DEPOT-01");
  });
});
