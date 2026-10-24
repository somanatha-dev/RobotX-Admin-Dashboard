"use strict";

/**
 * DTARO — each robot's REMAINING commanded route, from trusted server-side state only.
 *
 * Used by the cross-zone recipient step of `dtaroZoneAlert.processReport`. Read-only: it reads
 * the engine's rows and changes none of them, and it never accepts a route from a robot.
 *
 * ── Where the route comes from ──────────────────────────────────────────────
 * The same authority completion grading uses (`dtaro.handler.readCommandedCorridor`): the agent's
 * live commitment (`releasedAt: null`, latest `grantedAt`, as `verifyCompletionClaim` selects it)
 * and the latest `OFFER` the server signed and queued for it in the Outbox, whose
 * `stopSequence[].path` points are the commanded corridor, in order. No commitment means the
 * robot has no commanded mission route: it is idle for this purpose.
 *
 * ── Where it is cut ─────────────────────────────────────────────────────────
 * Telemetry carries position, not route progress, so the cut is made where the robot's latest
 * server-held position projects onto the corridor. A corridor can pass the same place twice (a
 * route that doubles back), so the cut is made on the EARLIEST segment lying within the corridor
 * half-width (`VERIFY_CORRIDOR_HALF_WIDTH_M`, the completion grader's own "on the corridor"
 * tolerance) of the nearest one. Choosing earlier only ever keeps MORE of the route, so an
 * ambiguous cut can over-warn and can never drop a part of the route still ahead.
 *
 * Every degraded case keeps more route, never less:
 *   · position unknown → the whole corridor (`FULL_ROUTE_POSITION_UNKNOWN`);
 *   · tolerance not configured → the whole corridor (`FULL_ROUTE_NO_TOLERANCE`);
 *   · an older position → a cut further back along the route, i.e. a superset of the truth.
 * A commitment with no route geometry, a corridor holding a point that is not a finite
 * coordinate, or a failed read yields NO route (`NO_ROUTE_GEOMETRY`, `MALFORMED_ROUTE`,
 * `LOOKUP_FAILED`). Those are UNKNOWN routes (`UNKNOWN_ROUTE_STATUSES`), not empty ones: the
 * recipient policy alerts such a robot conservatively (ROUTE_UNKNOWN). A malformed corridor is
 * never repaired by dropping its bad points, which would join two points the server never
 * commanded as one segment.
 */

/** Statuses of a commanded-route read. */
const ROUTE_STATUS = Object.freeze({
  OK: "OK",
  NO_AGENT: "NO_AGENT",
  NO_LIVE_COMMITMENT: "NO_LIVE_COMMITMENT",
  NO_ROUTE_GEOMETRY: "NO_ROUTE_GEOMETRY",
  MALFORMED_ROUTE: "MALFORMED_ROUTE",
  LOOKUP_FAILED: "LOOKUP_FAILED",
});

/** Statuses where the robot may hold a commanded route the server could not establish. */
const UNKNOWN_ROUTE_STATUSES = Object.freeze([ROUTE_STATUS.NO_ROUTE_GEOMETRY, ROUTE_STATUS.MALFORMED_ROUTE, ROUTE_STATUS.LOOKUP_FAILED]);

/** How the remaining route was derived from the corridor. */
const CUT = Object.freeze({
  AT_POSITION: "AT_POSITION",
  FULL_ROUTE_POSITION_UNKNOWN: "FULL_ROUTE_POSITION_UNKNOWN",
  FULL_ROUTE_NO_TOLERANCE: "FULL_ROUTE_NO_TOLERANCE",
});

/** The completion grader's corridor half-width, read the way `readVerificationThresholds` reads it. */
const TOLERANCE_ENV = "VERIFY_CORRIDOR_HALF_WIDTH_M";

/** Metres per radian on the sphere `campusTraversalNetwork.snap` uses. @structural */
const METRES_PER_RADIAN = 6371000;

const isPoint = (p) => Boolean(p) && Number.isFinite(p.lat) && Number.isFinite(p.lon);

/** The corridor points of one OFFER payload, in stop order (`readCommandedCorridor`'s rule). */
function corridorOf(payload) {
  return corridorFactsOf(payload).points;
}

/**
 * The corridor points, and whether any path entry was not a valid coordinate (a non-finite or
 * out-of-range lat/lon, or not a point at all). `points` keeps the valid ones in order.
 */
function corridorFactsOf(payload) {
  const stops = payload && Array.isArray(payload.stopSequence) ? payload.stopSequence : [];
  const points = [];
  let malformed = false;
  for (const stop of stops) {
    for (const point of Array.isArray(stop && stop.path) ? stop.path : []) {
      const valid = isPoint(point) && Math.abs(point.lat) <= 90 && Math.abs(point.lon) <= 180;
      if (valid) points.push({ lat: point.lat, lon: point.lon });
      else malformed = true;
    }
  }
  return { points, malformed };
}

/**
 * The corridor stop by stop, in the OFFER's order: each stop's type and its own path points. Used
 * by the DTARO decision step to name a robot's legs and their ends; empty when any point is
 * malformed (the whole corridor is then unknown, as `corridorFactsOf` decides).
 */
function stopsOf(payload) {
  if (corridorFactsOf(payload).malformed) return [];
  const stops = payload && Array.isArray(payload.stopSequence) ? payload.stopSequence : [];
  return stops.map((stop, index) => ({
    index,
    stopType: stop && typeof stop.stopType === "string" ? stop.stopType : null,
    points: (Array.isArray(stop && stop.path) ? stop.path : []).map((p) => ({ lat: p.lat, lon: p.lon })),
  }));
}

/**
 * The commanded corridor of each robot, read in three queries whatever the number of robots.
 *
 * @param {object|null} prisma
 * @param {string[]} robotIds
 * @param {{ nowMs?: number }} [options]
 * @returns {Promise<Map<string, { status: string, commitmentId?: string, offerCreatedAt?: string,
 *           leaseExpired?: boolean, points: Array<{lat:number, lon:number}> }>>}
 */
async function readCommandedRoutes(prisma, robotIds, options = {}) {
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const out = new Map();
  const ids = [...new Set((robotIds || []).map(String))].sort();
  if (ids.length === 0) return out;
  const failAll = () => {
    for (const id of ids) out.set(id, { status: ROUTE_STATUS.LOOKUP_FAILED, points: [] });
    return out;
  };
  if (!prisma || !prisma.agent || !prisma.commitment || !prisma.outbox) return failAll();

  try {
    const agents = await prisma.agent.findMany({ where: { agentId: { in: ids } }, select: { id: true, agentId: true } });
    const agentByRow = new Map((agents || []).map((a) => [a.id, a.agentId]));
    const commitments = agentByRow.size
      ? await prisma.commitment.findMany({
          where: { agentId: { in: [...agentByRow.keys()] }, releasedAt: null },
          orderBy: { grantedAt: "desc" },
          select: { commitmentId: true, agentId: true, grantedAt: true, leaseExpiry: true },
        })
      : [];
    // The live commitment per agent: the latest granted, as `verifyCompletionClaim` takes it.
    const liveByRobot = new Map();
    for (const c of commitments || []) {
      const robotId = agentByRow.get(c.agentId);
      if (robotId && !liveByRobot.has(robotId)) liveByRobot.set(robotId, c);
    }
    const commitmentIds = [...liveByRobot.values()].map((c) => c.commitmentId);
    const offers = commitmentIds.length
      ? await prisma.outbox.findMany({
          where: { commitmentId: { in: commitmentIds }, command: "OFFER" },
          orderBy: { createdAt: "desc" },
          select: { commitmentId: true, payload: true, createdAt: true },
        })
      : [];
    const offerByCommitment = new Map();
    for (const o of offers || []) if (!offerByCommitment.has(o.commitmentId)) offerByCommitment.set(o.commitmentId, o);

    const known = new Set(agentByRow.values());
    for (const robotId of ids) {
      if (!known.has(robotId)) {
        out.set(robotId, { status: ROUTE_STATUS.NO_AGENT, points: [] });
        continue;
      }
      const live = liveByRobot.get(robotId);
      if (!live) {
        out.set(robotId, { status: ROUTE_STATUS.NO_LIVE_COMMITMENT, points: [] });
        continue;
      }
      const offer = offerByCommitment.get(live.commitmentId);
      const facts = offer ? corridorFactsOf(offer.payload) : { points: [], malformed: false };
      const points = facts.malformed ? [] : facts.points;
      const leaseMs = live.leaseExpiry ? new Date(live.leaseExpiry).getTime() : NaN;
      out.set(robotId, {
        status: facts.malformed ? ROUTE_STATUS.MALFORMED_ROUTE : points.length >= 2 ? ROUTE_STATUS.OK : ROUTE_STATUS.NO_ROUTE_GEOMETRY,
        commitmentId: live.commitmentId,
        offerCreatedAt: offer && offer.createdAt ? new Date(offer.createdAt).toISOString() : null,
        // Recorded, not acted on: an expired lease does not release the commitment (the
        // reconciler does), so its route is still the last one the server commanded.
        leaseExpired: Number.isFinite(leaseMs) ? leaseMs <= nowMs : false,
        points: points.length >= 2 ? points : [],
        // The task the OFFER discharges, and its corridor per stop (DTARO decision step).
        taskId: offer && offer.payload && typeof offer.payload.taskId === "string" ? offer.payload.taskId : null,
        stops: offer && points.length >= 2 ? stopsOf(offer.payload) : [],
      });
    }
    return out;
  } catch {
    return failAll();
  }
}

/** The corridor half-width from the environment, or null when it is not a positive number. */
function corridorToleranceM(env = process.env) {
  const value = Number(env[TOLERANCE_ENV]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Cut a corridor at a position. See the module header for the rule.
 *
 * @param {Array<{lat:number, lon:number}>} points the commanded corridor, ≥ 2 points
 * @param {{lat:number, lon:number}|null} position the robot's latest server-held position
 * @param {{ toleranceM: number|null }} options
 * @returns {{ cut: string, points: Array<{lat:number, lon:number}>, segmentIndex: number|null, offRouteM: number|null }}
 */
function remainingRoute(points, position, { toleranceM }) {
  const route = (points || []).filter(isPoint);
  if (route.length < 2) return { cut: CUT.AT_POSITION, points: [], segmentIndex: null, offRouteM: null };
  if (!isPoint(position)) return { cut: CUT.FULL_ROUTE_POSITION_UNKNOWN, points: route.slice(), segmentIndex: null, offRouteM: null };
  if (!Number.isFinite(toleranceM) || toleranceM <= 0) {
    return { cut: CUT.FULL_ROUTE_NO_TOLERANCE, points: [{ lat: position.lat, lon: position.lon }, ...route], segmentIndex: null, offRouteM: null };
  }

  // A local equirectangular frame centred on the robot, as `campusTraversalNetwork.snap` uses.
  const lat0 = (position.lat * Math.PI) / 180;
  const kx = Math.cos(lat0) * (Math.PI / 180) * METRES_PER_RADIAN;
  const ky = (Math.PI / 180) * METRES_PER_RADIAN;
  const segments = [];
  for (let i = 0; i < route.length - 1; i += 1) {
    const A = route[i];
    const B = route[i + 1];
    const ax = (A.lon - position.lon) * kx;
    const ay = (A.lat - position.lat) * ky;
    const dx = (B.lon - A.lon) * kx;
    const dy = (B.lat - A.lat) * ky;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    segments.push({ i, t, distanceM: Math.hypot(ax + t * dx, ay + t * dy) });
  }
  const nearest = Math.min(...segments.map((s) => s.distanceM));
  const chosen = segments.find((s) => s.distanceM <= nearest + toleranceM);
  const A = route[chosen.i];
  const B = route[chosen.i + 1];
  const onRoute = { lat: A.lat + (B.lat - A.lat) * chosen.t, lon: A.lon + (B.lon - A.lon) * chosen.t };

  const out = [{ lat: position.lat, lon: position.lon }];
  for (const p of [onRoute, ...route.slice(chosen.i + 1)]) {
    const last = out[out.length - 1];
    if (p.lat !== last.lat || p.lon !== last.lon) out.push({ lat: p.lat, lon: p.lon });
  }
  // A robot exactly at the end of its corridor still has a (zero-length) route: keep two points.
  if (out.length === 1) out.push({ lat: position.lat, lon: position.lon });
  return { cut: CUT.AT_POSITION, points: out, segmentIndex: chosen.i, offRouteM: Math.round(nearest * 10) / 10 };
}

module.exports = { ROUTE_STATUS, UNKNOWN_ROUTE_STATUSES, CUT, TOLERANCE_ENV, corridorOf, corridorFactsOf, stopsOf, readCommandedRoutes, corridorToleranceM, remainingRoute };
