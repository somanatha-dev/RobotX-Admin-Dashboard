"use strict";

/**
 * **Route containment** for the physical router: does a point, or a straight piece of a route,
 * lie strictly inside the declared operating boundary?
 *
 * A physical route may not leave the boundary (`RD-2026-10-12-01` AC1, and `RD-2026-08-30-01`
 * §5's "serviceable routing boundary"). Endpoint checks alone do not give that: the campus
 * extract's ways run outside the adopted polygon, so a route between two inside points could
 * cut through ground the boundary excludes. Every edge the router may use, every access
 * connector and every piece of a returned path is therefore tested here.
 *
 * Points are classified by `campusServiceability`'s oracle, the same exact, tolerance-free
 * verdict the cell projection already uses, so the two cannot disagree about a coordinate.
 * `ON_BOUNDARY` is not inside. A segment is contained when both ends are inside **and** it
 * neither crosses nor touches any ring of the boundary (exterior or hole). With both ends
 * strictly inside, that is exactly "the whole segment is inside".
 *
 * No buffer and no tolerance, for the reason `campusServiceability` gives: `RD-2026-08-30-01`
 * §1 forbids enlarging the adopted geometry. Comparisons are exact, which is also the
 * fail-closed direction: a segment that grazes the boundary is refused.
 */

const { validateRegionDeclaration, BOUNDARY_STATUS } = require("../../engine/spatial/regionBoundary");
const { createServiceabilityOracle, SERVICEABILITY } = require("../../engine/routing/campusServiceability");

/** The signed area of the triangle (a, b, c), doubled. Exact: no tolerance is applied. */
function orientation(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

/** For three collinear points: does `c` lie within the bounding box of segment [a, b]? */
function withinBox(a, b, c) {
  return (
    c[0] >= Math.min(a[0], b[0]) &&
    c[0] <= Math.max(a[0], b[0]) &&
    c[1] >= Math.min(a[1], b[1]) &&
    c[1] <= Math.max(a[1], b[1])
  );
}

/**
 * Do the closed segments [p, q] and [r, s] share any point, including a touch at an end or a
 * collinear overlap?
 */
function segmentsMeet(p, q, r, s) {
  const o1 = orientation(p, q, r);
  const o2 = orientation(p, q, s);
  const o3 = orientation(r, s, p);
  const o4 = orientation(r, s, q);
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return true;
  if (o1 === 0 && withinBox(p, q, r)) return true;
  if (o2 === 0 && withinBox(p, q, s)) return true;
  if (o3 === 0 && withinBox(r, s, p)) return true;
  if (o4 === 0 && withinBox(r, s, q)) return true;
  return false;
}

const isPoint = (value) =>
  Boolean(value) && typeof value.lat === "number" && Number.isFinite(value.lat) && typeof value.lon === "number" && Number.isFinite(value.lon);

/**
 * Build the containment test for a delivery-domain (region) declaration.
 *
 * @param {object} declaration the pinned declaration (`boundary`, `regionId`, …)
 * @returns {{ usable: boolean, problems: string[], containsPoint: Function, containsSegment: Function }}
 */
function createRouteContainment(declaration) {
  const oracle = createServiceabilityOracle(declaration);
  const validated = validateRegionDeclaration(declaration);
  const usable = oracle.usable && validated.status === BOUNDARY_STATUS.VALID && Array.isArray(validated.polygons);

  // Every ring edge of every polygon, exterior and holes, as [lon, lat] pairs.
  const edges = [];
  if (usable) {
    for (const polygon of validated.polygons) {
      for (const ring of polygon) {
        for (let index = 0; index + 1 < ring.length; index += 1) edges.push([ring[index], ring[index + 1]]);
      }
    }
  }

  /** @param {{ lat: number, lon: number }} point */
  function containsPoint(point) {
    if (!usable || !isPoint(point)) return false;
    return oracle.assess(point.lat, point.lon).status === SERVICEABILITY.INSIDE;
  }

  /** @param {{ lat: number, lon: number }} from @param {{ lat: number, lon: number }} to */
  function containsSegment(from, to) {
    if (!containsPoint(from) || !containsPoint(to)) return false;
    const p = [from.lon, from.lat];
    const q = [to.lon, to.lat];
    for (const [r, s] of edges) {
      if (segmentsMeet(p, q, r, s)) return false;
    }
    return true;
  }

  return Object.freeze({
    usable,
    problems: usable ? [] : [...new Set([...(oracle.problems || []), ...(validated.problems || [])])],
    containsPoint,
    containsSegment,
  });
}

module.exports = { createRouteContainment, segmentsMeet };
