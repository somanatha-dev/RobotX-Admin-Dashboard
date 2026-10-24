"use strict";

/**
 * DTARO — a simulated robot's DETOUR around a reported obstacle. DEVELOPMENT_SIMULATION, and
 * nothing else.
 *
 * ── What a detour is, and what it is not ────────────────────────────────────
 * When an operator (or the decision deadline) chooses REROUTE for a reported obstacle, each
 * affected SIMULATED robot is given an alternate path for every remaining leg of its mission that
 * meets the obstacle's footprint (its published H3 cell). The robot drives that path from a
 * simulation-only navigation field (`VirtualRobot._dtaroDetours`), exactly as it drives the route
 * to its charger (`chargerRoute`), and never writes it back into its mission.
 *
 * It is NOT a reroute of the commanded route. The OFFER the server signed, the commitment, the Leg
 * and the Task are untouched; completion is still graded against the OFFER corridor
 * (`dtaro.handler.readCommandedCorridor`), so a robot that detoured is graded on what it was
 * commanded, which may well be insufficient. No replanning authority is created (OD-3).
 *
 * ── Where the geometry comes from ───────────────────────────────────────────
 * The same network a commanded route is computed over: the pinned delivery-domain declaration's
 * campus extract and the robot class's permitted ways (`MobilityModel.permissionSet`), kept inside
 * the operating boundary — `chargerRoute.containedNetworkFor`, the one contained network the
 * simulator builds. The obstacle is avoided with the network's per-query `avoidSegment`: an edge,
 * an access connector or a stretch that meets the footprint, or that leaves the obstacle's region
 * (sampled every `REGION_SAMPLE_M`), is not used. Nothing is interpolated or invented: every
 * interior point is an OSM vertex of a permitted way.
 *
 * ── Fail closed ─────────────────────────────────────────────────────────────
 * No declaration, no extract, no permitted ways, an endpoint inside the footprint, a network the
 * footprint disconnects: each is a refusal by name, and the caller keeps that robot STOPPED. A
 * planned path is then checked again by `detourProblems`, which shares no code with the planner's
 * exclusion beyond the geometric primitives: a path it rejects is never sent.
 *
 * Pure apart from reading the campus extract (through `chargerRoute.containedNetworkFor`): no
 * clock, no randomness, no database.
 */

const campusTraversalNetwork = require("./campusTraversalNetwork");
const chargerRoute = require("./chargerRoute");
const { pathIntersectsPolygon, pointInPolygon } = require("../services/routeIntersection.service");
const { haversineMeters } = require("../utils/distance");

/**
 * How finely a segment is sampled for region membership. Half the shortest edge of a res-11 H3
 * cell (~25 m) would already be safe; 2 m keeps a detour from clipping a foreign cell's corner.
 * @structural a sampling step, not a safety margin
 */
const REGION_SAMPLE_M = 2;

/**
 * How close a detour's ends must be to the requested points. The network appends the exact
 * endpoints, so this is a numerical tolerance only (the simulator's own `ARRIVAL_EPSILON_M`).
 * @structural
 */
const ENDPOINT_EPSILON_M = 0.01;

const REFUSAL = Object.freeze({
  NO_DELIVERY_DOMAIN: "NO_DELIVERY_DOMAIN",
  NO_CAMPUS_NETWORK: "NO_CAMPUS_NETWORK",
  NO_PERMITTED_WAYS: "NO_PERMITTED_WAYS",
  MALFORMED_ENDPOINT: "MALFORMED_ENDPOINT",
  ENDPOINT_IN_OBSTACLE: "ENDPOINT_IN_OBSTACLE",
  ENDPOINT_OUTSIDE_REGION: "ENDPOINT_OUTSIDE_REGION",
  NO_SAFE_ALTERNATE_ROUTE: "NO_SAFE_ALTERNATE_ROUTE",
  INVALID_DETOUR: "INVALID_DETOUR",
});

const isNumber = (v) => typeof v === "number" && Number.isFinite(v);
const isPoint = (p) => Boolean(p) && isNumber(p.lat) && isNumber(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;
const metres = (a, b) => haversineMeters(a.lat, a.lon, b.lat, b.lon);
const refused = (refusal, reason) => Object.freeze({ ok: false, refusal, reason });

/** Points every `stepM` along a segment, both ends included. */
function samples(a, b, stepM) {
  const n = Math.max(1, Math.ceil(metres(a, b) / stepM));
  const out = [];
  for (let k = 0; k <= n; k += 1) out.push({ lat: a.lat + ((b.lat - a.lat) * k) / n, lon: a.lon + ((b.lon - a.lon) * k) / n });
  return out;
}

/** True when every sample of a → b is in the region. */
function segmentInRegion(a, b, inRegion, stepM = REGION_SAMPLE_M) {
  return samples(a, b, stepM).every((p) => inRegion(p));
}

/** The footprint plus any further areas to keep clear of, each a valid polygon. */
function areasOf(footprint, footprints) {
  return [footprint, ...(Array.isArray(footprints) ? footprints : [])].filter((poly) => Array.isArray(poly) && poly.filter(isPoint).length >= 3);
}

/**
 * Everything wrong with a planned detour, or [] — the independent check every sent path passes.
 *
 * @param {Array<{lat:number, lon:number}>} points
 * @param {{ from: object, to: object, footprint: object[], footprints?: object[][], inRegion: (p: object) => boolean }} expected
 *   `footprints`: every other active obstacle's footprint, which the detour must also keep clear of
 * @returns {string[]}
 */
function detourProblems(points, { from, to, footprint, footprints, inRegion }) {
  const problems = [];
  if (!Array.isArray(points) || points.length < 2) return ["a detour needs at least two points"];
  if (!points.every(isPoint)) return ["a detour point is not a WGS-84 coordinate"];
  if (isPoint(from) && metres(points[0], from) > ENDPOINT_EPSILON_M) problems.push("the detour does not start at the robot");
  if (isPoint(to) && metres(points[points.length - 1], to) > ENDPOINT_EPSILON_M) problems.push("the detour does not end at the leg's destination");
  if (pathIntersectsPolygon(points, footprint)) problems.push("the detour meets the obstacle's footprint");
  else if (areasOf(null, footprints).some((poly) => pathIntersectsPolygon(points, poly))) problems.push("the detour meets another active obstacle's footprint");
  if (typeof inRegion === "function") {
    for (let i = 1; i < points.length; i += 1) {
      if (!segmentInRegion(points[i - 1], points[i], inRegion, REGION_SAMPLE_M / 2)) {
        problems.push(`the detour leaves the obstacle's region between points ${i - 1} and ${i}`);
        break;
      }
    }
  }
  return problems;
}

/** Length of a polyline in metres. */
function pathLengthM(points) {
  let total = 0;
  for (let i = 1; i < (points || []).length; i += 1) total += metres(points[i - 1], points[i]);
  return total;
}

/**
 * How far along a path a position is: the projection onto the nearest segment at or after
 * `fromSegment` (so a path that doubles back is followed forward, never jumped back along).
 *
 * @returns {{ segmentIndex: number, doneM: number, totalM: number, fraction: number, offPathM: number, remainingM: number }|null}
 */
function progressAlong(points, position, fromSegment = 0) {
  if (!Array.isArray(points) || points.length < 2 || !isPoint(position)) return null;
  const lat0 = (position.lat * Math.PI) / 180;
  const kx = Math.cos(lat0) * (Math.PI / 180) * 6371000;
  const ky = (Math.PI / 180) * 6371000;
  let best = null;
  let walked = 0;
  for (let i = 0; i < points.length - 1; i += 1) {
    const A = points[i];
    const B = points[i + 1];
    const segM = metres(A, B);
    if (i >= Math.max(0, fromSegment)) {
      const ax = (A.lon - position.lon) * kx;
      const ay = (A.lat - position.lat) * ky;
      const dx = (B.lon - A.lon) * kx;
      const dy = (B.lat - A.lat) * ky;
      const len2 = dx * dx + dy * dy;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
      const off = Math.hypot(ax + t * dx, ay + t * dy);
      if (best === null || off < best.offPathM - 1e-9) best = { segmentIndex: i, doneM: walked + t * segM, offPathM: off };
    }
    walked += segM;
  }
  const totalM = walked;
  const doneM = Math.min(totalM, best.doneM);
  return {
    segmentIndex: best.segmentIndex,
    doneM,
    totalM,
    fraction: totalM > 0 ? doneM / totalM : 1,
    offPathM: best.offPathM,
    remainingM: Math.max(0, totalM - doneM),
  };
}

/**
 * Build the planner.
 *
 * @param {object} settings
 * @param {() => object|null} [settings.deliveryDomainFor] the pinned delivery-domain declaration
 * @param {(roadClasses: string[]) => ({ ok: true, network: object }|{ ok: false, refusal: string, problems: string[] })} [settings.networkFor]
 *   injected for tests; otherwise `chargerRoute.containedNetworkFor(declaration, roadClasses)`
 * @returns {{ planLeg: Function }}
 */
function createDetourPlanner(settings) {
  const source = settings || {};

  function networkFor(roadClasses) {
    if (typeof source.networkFor === "function") return source.networkFor(roadClasses);
    let declaration = null;
    try {
      declaration = typeof source.deliveryDomainFor === "function" ? source.deliveryDomainFor() : null;
    } catch {
      declaration = null;
    }
    if (!declaration) return { ok: false, refusal: REFUSAL.NO_DELIVERY_DOMAIN, problems: ["the pinned configuration carries no delivery-domain declaration"] };
    return chargerRoute.containedNetworkFor(declaration, roadClasses);
  }

  /**
   * An alternate path for one leg, `from` → `to`, that avoids the footprint and stays in the
   * obstacle's region.
   *
   * @param {object} input
   * @param {{lat:number, lon:number}} input.from where the leg is driven from (the robot, or the previous stop)
   * @param {{lat:number, lon:number}} input.to the leg's own destination (its last commanded point)
   * @param {Array<{lat:number, lon:number}>} input.footprint the obstacle's published cell
   * @param {Array<Array<{lat:number, lon:number}>>} [input.footprints] every other active obstacle's
   *   cell in the region: kept clear of too, whatever was decided about it
   * @param {(p: object) => boolean} input.inRegion whether a point is in the obstacle's region
   * @param {object|null} input.permissionSet the class's `MobilityModel.permissionSet`
   * @returns {{ ok: true, points: object[], distanceM: number } | { ok: false, refusal: string, reason: string }}
   */
  function planLeg(input) {
    const request = input || {};
    const { from, to, footprint, footprints, inRegion } = request;
    if (!isPoint(from) || !isPoint(to)) return refused(REFUSAL.MALFORMED_ENDPOINT, "a leg endpoint is not a WGS-84 { lat, lon } pair");
    if (!Array.isArray(footprint) || footprint.filter(isPoint).length < 3) return refused(REFUSAL.MALFORMED_ENDPOINT, "the obstacle has no footprint polygon");
    if (typeof inRegion !== "function") return refused(REFUSAL.ENDPOINT_OUTSIDE_REGION, "no region test was supplied");
    const areas = areasOf(footprint, footprints);
    for (const [name, point] of [["robot's position", from], ["leg's destination", to]]) {
      if (areas.some((poly) => pointInPolygon(point, poly))) return refused(REFUSAL.ENDPOINT_IN_OBSTACLE, `the ${name} is inside ${pointInPolygon(point, footprint) ? "the obstacle's" : "an active obstacle's"} footprint`);
      if (!inRegion(point)) return refused(REFUSAL.ENDPOINT_OUTSIDE_REGION, `the ${name} is not in the obstacle's region`);
    }

    const roadClasses = campusTraversalNetwork.permittedClasses(request.permissionSet);
    if (roadClasses.length === 0) return refused(REFUSAL.NO_PERMITTED_WAYS, "the robot's class declares no permitted ground ways (MobilityModel.permissionSet)");
    const built = networkFor(roadClasses);
    if (!built || !built.ok) {
      const problems = (built && built.problems) || [];
      return refused(built && built.refusal === REFUSAL.NO_DELIVERY_DOMAIN ? REFUSAL.NO_DELIVERY_DOMAIN : REFUSAL.NO_CAMPUS_NETWORK, problems.join("; ") || "no campus network");
    }

    const avoidSegment = (a, b) => areas.some((poly) => pathIntersectsPolygon([a, b], poly)) || !segmentInRegion(a, b, inRegion);
    const routed = built.network.route(from, to, { avoidSegment });
    if (!routed.ok) return refused(REFUSAL.NO_SAFE_ALTERNATE_ROUTE, `${routed.refusal}: ${routed.reason}`);

    const problems = detourProblems(routed.points, { from, to, footprint, footprints, inRegion });
    if (problems.length > 0) return refused(REFUSAL.INVALID_DETOUR, problems.join("; "));
    return Object.freeze({ ok: true, points: routed.points.map((p) => ({ lat: p.lat, lon: p.lon })), distanceM: routed.distanceM });
  }

  return Object.freeze({ planLeg });
}

module.exports = {
  REGION_SAMPLE_M,
  ENDPOINT_EPSILON_M,
  REFUSAL,
  createDetourPlanner,
  detourProblems,
  progressAlong,
  pathLengthM,
  segmentInRegion,
};
