"use strict";

/**
 * DTARO — the remaining commanded route, from server-side state (`dtaroCommandedRoute.service`).
 * Reads go through an in-memory Prisma stand-in shaped like the real rows: Agent, the live
 * Commitment, and the OFFER Outbox row whose `stopSequence[].path` is the commanded corridor.
 */

const { createPermissivePrisma } = require("../../helpers/permissivePrisma");
const route = require("../../../src/services/dtaroCommandedRoute.service");

const { ROUTE_STATUS, CUT } = route;

/** Points along a parallel of latitude, ~11 m apart per 0.0001° of longitude here. */
const P = (dLon, dLat = 0) => ({ lat: 12.9 + dLat, lon: 77.5 + dLon });

const NOW = Date.parse("2026-10-23T10:00:00Z");

function offer(paths) {
  return { stopSequence: paths.map((path, i) => ({ stopId: `s${i + 1}`, sequence: i + 1, path })) };
}

/**
 * agents: [{ id, agentId }]; commitments: [{ commitmentId, agentId, grantedAt, releasedAt, leaseExpiry }];
 * outbox: [{ commitmentId, command, payload, createdAt }]. Applies the `in` filters the service uses.
 */
function prismaWith({ agents = [], commitments = [], outbox = [] }, calls = []) {
  const inList = (value, list) => !list || list.includes(value);
  return createPermissivePrisma((model, method, args) => {
    calls.push(`${model}.${method}`);
    const where = (args && args.where) || {};
    if (model === "agent" && method === "findMany") return agents.filter((a) => inList(a.agentId, where.agentId && where.agentId.in));
    if (model === "commitment" && method === "findMany") {
      return commitments
        .filter((c) => inList(c.agentId, where.agentId && where.agentId.in) && (where.releasedAt !== null || !c.releasedAt))
        .sort((a, b) => Date.parse(b.grantedAt) - Date.parse(a.grantedAt));
    }
    if (model === "outbox" && method === "findMany") {
      return outbox
        .filter((o) => inList(o.commitmentId, where.commitmentId && where.commitmentId.in) && o.command === where.command)
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    }
    return undefined;
  });
}

describe("readCommandedRoutes — the live commitment's latest OFFER, and nothing else", () => {
  const world = {
    agents: [
      { id: "ag-1", agentId: "R1" },
      { id: "ag-2", agentId: "R2" },
      { id: "ag-3", agentId: "R3" },
      { id: "ag-4", agentId: "R4" },
      { id: "ag-5", agentId: "R5" },
    ],
    commitments: [
      // R1: an older released commitment and the live one.
      { commitmentId: "c-old", agentId: "ag-1", grantedAt: "2026-10-23T08:00:00Z", releasedAt: "2026-10-23T08:30:00Z", leaseExpiry: "2026-10-23T09:00:00Z" },
      { commitmentId: "c-1", agentId: "ag-1", grantedAt: "2026-10-23T09:50:00Z", releasedAt: null, leaseExpiry: "2026-10-23T10:05:00Z" },
      // R3: live, but its OFFER carries no geometry. R4: live, lease already expired.
      { commitmentId: "c-3", agentId: "ag-3", grantedAt: "2026-10-23T09:55:00Z", releasedAt: null, leaseExpiry: "2026-10-23T10:05:00Z" },
      { commitmentId: "c-4", agentId: "ag-4", grantedAt: "2026-10-23T09:00:00Z", releasedAt: null, leaseExpiry: "2026-10-23T09:30:00Z" },
      // R5: its only commitment is released (the mission is over), so it is idle.
      { commitmentId: "c-5", agentId: "ag-5", grantedAt: "2026-10-23T09:58:00Z", releasedAt: "2026-10-23T09:59:00Z", leaseExpiry: "2026-10-23T10:10:00Z" },
    ],
    outbox: [
      { commitmentId: "c-old", command: "OFFER", createdAt: "2026-10-23T08:00:01Z", payload: offer([[P(9), P(9.5)]]) },
      { commitmentId: "c-1", command: "OFFER", createdAt: "2026-10-23T09:50:01Z", payload: offer([[P(0), P(0.001)], [P(0.001), P(0.002)]]) },
      { commitmentId: "c-1", command: "WITHDRAW", createdAt: "2026-10-23T09:51:00Z", payload: offer([[P(5), P(6)]]) },
      { commitmentId: "c-3", command: "OFFER", createdAt: "2026-10-23T09:55:01Z", payload: { stopSequence: [{ stopId: "s1", sequence: 1 }] } },
      { commitmentId: "c-4", command: "OFFER", createdAt: "2026-10-23T09:00:01Z", payload: offer([[P(1), P(1.001)]]) },
      { commitmentId: "c-5", command: "OFFER", createdAt: "2026-10-23T09:58:01Z", payload: offer([[P(2), P(2.001)]]) },
    ],
  };

  test("statuses: OK, NO_LIVE_COMMITMENT (idle), NO_ROUTE_GEOMETRY, NO_AGENT; the stops' paths are concatenated in order", async () => {
    const calls = [];
    const routes = await route.readCommandedRoutes(prismaWith(world, calls), ["R1", "R2", "R3", "R4", "GHOST"], { nowMs: NOW });
    expect(routes.get("R1")).toMatchObject({ status: ROUTE_STATUS.OK, commitmentId: "c-1", leaseExpired: false });
    expect(routes.get("R1").points).toEqual([P(0), P(0.001), P(0.001), P(0.002)]);
    expect(routes.get("R2")).toEqual({ status: ROUTE_STATUS.NO_LIVE_COMMITMENT, points: [] });
    expect(routes.get("R3")).toMatchObject({ status: ROUTE_STATUS.NO_ROUTE_GEOMETRY, commitmentId: "c-3", points: [] });
    expect(routes.get("GHOST")).toEqual({ status: ROUTE_STATUS.NO_AGENT, points: [] });
    // Three reads, whatever the number of robots.
    expect(calls).toEqual(["agent.findMany", "commitment.findMany", "outbox.findMany"]);
  });

  test("a released commitment's OFFER and a non-OFFER command are never used", async () => {
    const routes = await route.readCommandedRoutes(prismaWith(world), ["R1", "R5"], { nowMs: NOW });
    expect(routes.get("R1").points.some((p) => p.lon >= 77.5 + 5)).toBe(false);
    // A robot whose only commitment is released has no commanded route: it is idle.
    expect(routes.get("R5")).toEqual({ status: ROUTE_STATUS.NO_LIVE_COMMITMENT, points: [] });
  });

  test("an expired lease is recorded, not acted on: the route is still the last one commanded", async () => {
    const routes = await route.readCommandedRoutes(prismaWith(world), ["R4"], { nowMs: NOW });
    expect(routes.get("R4")).toMatchObject({ status: ROUTE_STATUS.OK, commitmentId: "c-4", leaseExpired: true });
  });

  test("a failed read, or no database, gives LOOKUP_FAILED for every robot — never a guessed route", async () => {
    const failing = createPermissivePrisma((model) => {
      if (model === "agent") throw new Error("connection reset");
      return undefined;
    });
    const routes = await route.readCommandedRoutes(failing, ["R1", "R2"]);
    expect([...routes.values()]).toEqual([
      { status: ROUTE_STATUS.LOOKUP_FAILED, points: [] },
      { status: ROUTE_STATUS.LOOKUP_FAILED, points: [] },
    ]);
    expect((await route.readCommandedRoutes(null, ["R1"])).get("R1").status).toBe(ROUTE_STATUS.LOOKUP_FAILED);
    expect((await route.readCommandedRoutes(failing, [])).size).toBe(0);
  });
});

describe("remainingRoute — cut at the robot's current position", () => {
  const corridor = [P(0), P(0.001), P(0.002), P(0.003)];

  test("the completed part is dropped: the route starts at the robot and runs on from its projection", () => {
    const r = route.remainingRoute(corridor, P(0.0015, 0.00001), { toleranceM: 30 });
    expect(r.cut).toBe(CUT.AT_POSITION);
    expect(r.segmentIndex).toBe(1);
    expect(r.points[0]).toEqual(P(0.0015, 0.00001));
    expect(r.points[1].lon).toBeCloseTo(77.5015, 9);
    expect(r.points.slice(2)).toEqual([P(0.002), P(0.003)]);
    expect(r.points.every((p) => p.lon >= 77.5015 - 1e-9)).toBe(true);
    expect(r.offRouteM).toBeGreaterThan(0);
  });

  test("a route that doubles back is cut at the EARLIEST pass the robot could be on, keeping more, never less", () => {
    // Out east along one side of a lane, back west 5 m north of it. A robot on the outbound leg
    // is within the tolerance of both legs: the cut keeps the rest of the outbound leg AND the
    // whole return.
    const outAndBack = [P(0), P(0.002), P(0.002, 0.000045), P(0, 0.000045)];
    const r = route.remainingRoute(outAndBack, P(0.001, 0.00002), { toleranceM: 30 });
    expect(r.segmentIndex).toBe(0);
    expect(r.points.slice(-3)).toEqual([P(0.002), P(0.002, 0.000045), P(0, 0.000045)]);
  });

  test("position unknown → the whole corridor (conservative)", () => {
    expect(route.remainingRoute(corridor, null, { toleranceM: 30 })).toEqual({ cut: CUT.FULL_ROUTE_POSITION_UNKNOWN, points: corridor, segmentIndex: null, offRouteM: null });
  });

  test("tolerance not configured → the whole corridor from the robot (conservative), never a guessed tolerance", () => {
    const r = route.remainingRoute(corridor, P(0.0025), { toleranceM: null });
    expect(r.cut).toBe(CUT.FULL_ROUTE_NO_TOLERANCE);
    expect(r.points).toEqual([P(0.0025), ...corridor]);
    expect(route.corridorToleranceM({})).toBeNull();
    expect(route.corridorToleranceM({ VERIFY_CORRIDOR_HALF_WIDTH_M: "30" })).toBe(30);
    expect(route.corridorToleranceM({ VERIFY_CORRIDOR_HALF_WIDTH_M: "-1" })).toBeNull();
  });

  test("a robot at the end of its corridor has a two-point route at its position", () => {
    const r = route.remainingRoute(corridor, P(0.003), { toleranceM: 30 });
    expect(r.points).toEqual([P(0.003), P(0.003)]);
  });

  test("no geometry → no route", () => {
    expect(route.remainingRoute([P(0)], P(0), { toleranceM: 30 }).points).toEqual([]);
  });
});
