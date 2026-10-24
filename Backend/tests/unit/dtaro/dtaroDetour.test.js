"use strict";

/**
 * DTARO simulated detours: the network's per-query `avoidSegment`, the planner's refusals, the
 * independent `detourProblems` check, progress measurement — and the robot side, which drives a
 * detour from a simulation-only field and stops when it cannot verify one.
 */

const campusTraversalNetwork = require("../../../src/simulation/campusTraversalNetwork");
const dtaroDetour = require("../../../src/simulation/dtaroDetour");
const VirtualRobot = require("../../../src/simulation/VirtualRobot");
const { pathIntersectsPolygon, pointInPolygon } = require("../../../src/services/routeIntersection.service");
const silentLogger = require("../../mocks/silentLogger");
const world = require("../../helpers/dtaroDecisionWorld");

const { xy, FOOTPRINT } = world;
const NETWORK = world.buildNetwork();
const anywhere = () => true;
const meetsObstacle = (a, b) => pathIntersectsPolygon([a, b], FOOTPRINT);
const planner = dtaroDetour.createDetourPlanner({ networkFor: () => ({ ok: true, network: NETWORK }) });
const PERMIT = { roadClasses: ["footway"] };

describe("campusTraversalNetwork.route — the per-query avoidSegment option", () => {
  test("without it a query is exactly as before (and its memoised tree is not affected by an avoiding query)", () => {
    const before = NETWORK.route(xy(60, 0), xy(-120, 0));
    const avoided = NETWORK.route(xy(60, 0), xy(-120, 0), { avoidSegment: meetsObstacle });
    const after = NETWORK.route(xy(60, 0), xy(-120, 0));
    expect(before.ok && avoided.ok && after.ok).toBe(true);
    expect(after).toEqual(before);
    expect(pathIntersectsPolygon(before.points, FOOTPRINT)).toBe(true); // the plain route goes through
    expect(pathIntersectsPolygon(avoided.points, FOOTPRINT)).toBe(false); // the avoiding one goes round
    expect(avoided.distanceM).toBeGreaterThan(before.distanceM + 100);
  });

  test("an avoided area that disconnects the endpoints is refused by name", () => {
    // Everything north of the main walk is excluded as well: no way round remains.
    const north = (a, b) => meetsObstacle(a, b) || a.lat > xy(0, 40).lat || b.lat > xy(0, 40).lat;
    expect(NETWORK.route(xy(60, 0), xy(-120, 0), { avoidSegment: north })).toMatchObject({ ok: false, refusal: "NOT_CONNECTED" });
  });

  test("an endpoint whose every access connector meets the avoided area is refused by name", () => {
    expect(NETWORK.route(xy(0, 0), xy(-120, 0), { avoidSegment: () => true })).toMatchObject({ ok: false, refusal: "ACCESS_MEETS_AVOIDED_AREA" });
  });
});

describe("the detour planner", () => {
  test("plans around the obstacle, within the region, ending exactly at the leg's destination", () => {
    const plan = planner.planLeg({ from: xy(60, 0), to: xy(-120, 0), footprint: FOOTPRINT, inRegion: anywhere, permissionSet: PERMIT });
    expect(plan.ok).toBe(true);
    expect(dtaroDetour.detourProblems(plan.points, { from: xy(60, 0), to: xy(-120, 0), footprint: FOOTPRINT, inRegion: anywhere })).toEqual([]);
    expect(plan.points.some((p) => p.lat > xy(0, 70).lat)).toBe(true); // it took the bypass
  });

  test("never crosses out of the region: a region that excludes the bypass leaves no safe route", () => {
    const southOnly = (p) => p.lat < xy(0, 40).lat;
    expect(planner.planLeg({ from: xy(60, 0), to: xy(-120, 0), footprint: FOOTPRINT, inRegion: southOnly, permissionSet: PERMIT })).toMatchObject({ ok: false, refusal: "NO_SAFE_ALTERNATE_ROUTE" });
  });

  test("refuses by name: an endpoint in the obstacle, outside the region, no permitted ways, no network", () => {
    expect(planner.planLeg({ from: xy(5, 0), to: xy(-120, 0), footprint: FOOTPRINT, inRegion: anywhere, permissionSet: PERMIT })).toMatchObject({ ok: false, refusal: "ENDPOINT_IN_OBSTACLE" });
    expect(planner.planLeg({ from: xy(60, 0), to: xy(10, 0), footprint: FOOTPRINT, inRegion: anywhere, permissionSet: PERMIT })).toMatchObject({ ok: false, refusal: "ENDPOINT_IN_OBSTACLE" });
    expect(planner.planLeg({ from: xy(60, 0), to: xy(-120, 0), footprint: FOOTPRINT, inRegion: () => false, permissionSet: PERMIT })).toMatchObject({ ok: false, refusal: "ENDPOINT_OUTSIDE_REGION" });
    expect(planner.planLeg({ from: xy(60, 0), to: xy(-120, 0), footprint: FOOTPRINT, inRegion: anywhere, permissionSet: { roadClasses: [] } })).toMatchObject({ ok: false, refusal: "NO_PERMITTED_WAYS" });
    const noDomain = dtaroDetour.createDetourPlanner({ deliveryDomainFor: () => null });
    expect(noDomain.planLeg({ from: xy(60, 0), to: xy(-120, 0), footprint: FOOTPRINT, inRegion: anywhere, permissionSet: PERMIT })).toMatchObject({ ok: false, refusal: "NO_DELIVERY_DOMAIN" });
  });

  test("detourProblems rejects a path through the obstacle, out of the region, or with the wrong ends", () => {
    const through = [xy(60, 0), xy(0, 0), xy(-120, 0)];
    expect(dtaroDetour.detourProblems(through, { from: xy(60, 0), to: xy(-120, 0), footprint: FOOTPRINT, inRegion: anywhere })).toEqual(["the detour meets the obstacle's footprint"]);
    const round = [xy(60, 0), xy(120, 0), xy(120, 80), xy(-120, 80), xy(-120, 0)];
    expect(dtaroDetour.detourProblems(round, { from: xy(60, 0), to: xy(-120, 0), footprint: FOOTPRINT, inRegion: (p) => p.lat < xy(0, 60).lat })[0]).toMatch(/leaves the obstacle's region/);
    expect(dtaroDetour.detourProblems(round, { from: xy(61, 0), to: xy(-120, 0), footprint: FOOTPRINT, inRegion: anywhere })).toEqual(["the detour does not start at the robot"]);
    expect(dtaroDetour.detourProblems([xy(0, 0)], { footprint: FOOTPRINT })).toEqual(["a detour needs at least two points"]);
    expect(dtaroDetour.detourProblems([xy(0, 0), { lat: NaN, lon: 1 }], { footprint: FOOTPRINT })).toEqual(["a detour point is not a WGS-84 coordinate"]);
  });

  test("progressAlong follows a path forward and measures what is left", () => {
    const path = [xy(0, 0), xy(100, 0), xy(100, 100)];
    const half = dtaroDetour.progressAlong(path, xy(50, 0));
    expect(half.segmentIndex).toBe(0);
    expect(half.fraction).toBeCloseTo(0.25, 2);
    const end = dtaroDetour.progressAlong(path, xy(100, 100), 1);
    expect(end.remainingM).toBeLessThan(0.01);
    expect(dtaroDetour.progressAlong(path, null)).toBeNull();
  });
});

describe("VirtualRobot — DTARO_SIM_NAV", () => {
  function robot() {
    const spec = world.FLEET["SAME-CROSS"];
    const vr = new VirtualRobot({ robotId: "SAME-CROSS", lat: spec.stops[0][0].lat, lon: spec.stops[0][0].lon, logger: silentLogger, simulated: true, obstacleProbability: 0 });
    const sent = [];
    vr.socket = { connected: true, emit: (event, payload) => sent.push({ event, payload }) };
    vr._onTaskAssign({ taskId: "TSK-SAME-CROSS", pathToPickup: spec.stops[0], pathToDrop: spec.stops[1] });
    return { vr, sent, commanded: JSON.parse(JSON.stringify(vr.task.stops)) };
  }
  const detour = () => planner.planLeg({ from: xy(60, 0), to: xy(-120, 0), footprint: FOOTPRINT, inRegion: anywhere, permissionSet: PERMIT }).points;
  const nav = (over = {}) => ({ navId: "nav-1", decisionId: "dec-1", obstacleId: "OBS-1", action: "REROUTE", footprint: FOOTPRINT, taskId: "TSK-SAME-CROSS", legs: [{ stopIndex: 0, points: detour() }], ...over });
  const drive = (vr, n) => {
    const trail = [];
    for (let i = 0; i < n; i += 1) {
      vr._stepAlongPath();
      vr.speed = 6;
      trail.push({ lat: vr.lat, lon: vr.lon });
    }
    return trail;
  };

  test("a detour is driven from the simulation-only field; the commanded mission is untouched", () => {
    const { vr, sent, commanded } = robot();
    vr._onDtaroSimNav(nav());
    expect(sent.find((m) => m.event === "DTARO_SIM_NAV_ACK").payload).toEqual({ navId: "nav-1", decisionId: "dec-1", outcome: "REROUTING", reason: null });
    expect(JSON.parse(JSON.stringify(vr.task.stops))).toEqual(commanded);
    expect(vr.dtaroNavigation().detours.map((d) => d.stopIndex)).toEqual([0]);
    vr.speed = 6;
    const trail = drive(vr, 200);
    expect(trail.some((p) => pointInPolygon(p, FOOTPRINT))).toBe(false);
    expect(dtaroDetour.pathLengthM([trail[trail.length - 1], xy(-120, 0)])).toBeLessThan(0.5);
  });

  test("a redelivered instruction is re-acknowledged, never applied twice", () => {
    const { vr, sent } = robot();
    vr._onDtaroSimNav(nav());
    vr.speed = 6;
    drive(vr, 3);
    const where = { lat: vr.lat, lon: vr.lon, pathIndex: vr.pathIndex };
    vr._onDtaroSimNav(nav());
    expect(sent.filter((m) => m.event === "DTARO_SIM_NAV_ACK")).toHaveLength(2);
    expect({ lat: vr.lat, lon: vr.lon, pathIndex: vr.pathIndex }).toEqual(where);
  });

  test("a detour it cannot verify is refused and the robot STOPS instead of driving on", () => {
    for (const [over, reason] of [
      [{ taskId: "TSK-OTHER" }, "TASK_CHANGED"],
      [{ legs: [{ stopIndex: 0, points: [xy(60, 0), xy(0, 0), xy(-120, 0)] }] }, "DETOUR_MEETS_OBSTACLE"],
      [{ legs: [{ stopIndex: 0, points: [xy(60, 0), xy(120, 0)] }] }, "DETOUR_DOES_NOT_END_AT_STOP"],
      [{ legs: [{ stopIndex: 7, points: detour() }] }, "UNKNOWN_STOP"],
    ]) {
      const { vr, sent, commanded } = robot();
      vr._onDtaroSimNav(nav({ navId: `nav-${reason}`, ...over }));
      expect([reason, sent.find((m) => m.event === "DTARO_SIM_NAV_ACK").payload.outcome, vr.status]).toEqual([reason, "REFUSED_STOPPED", "PAUSED"]);
      expect(sent.find((m) => m.event === "DTARO_SIM_NAV_ACK").payload.reason).toBe(reason);
      expect(JSON.parse(JSON.stringify(vr.task.stops))).toEqual(commanded);
    }
  });

  test("STOP uses the simulator's own stop (PAUSED), and a new mission forgets old detours", () => {
    const { vr, sent } = robot();
    vr._onDtaroSimNav(nav());
    vr._onDtaroSimNav({ navId: "nav-stop", decisionId: "dec-2", action: "STOP", reason: "ROUTE_CROSSES_OBSTACLE" });
    expect(vr.status).toBe("PAUSED");
    expect(sent.filter((m) => m.event === "DTARO_SIM_NAV_ACK").map((m) => m.payload.outcome)).toEqual(["REROUTING", "STOPPED"]);
    const spec = world.FLEET["X-CLEAR"];
    vr._onTaskAssign({ taskId: "TSK-NEW", pathToPickup: spec.stops[0], pathToDrop: spec.stops[1] });
    expect(vr.dtaroNavigation().detours).toEqual([]);
  });
});
