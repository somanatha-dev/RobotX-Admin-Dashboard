"use strict";

/**
 * DTARO cross-zone obstacle awareness — the RECIPIENT POLICY, as a pure function.
 *
 * Owner design policy (2026-10-23): an obstacle alert goes to
 *   1. every robot whose current position is in the obstacle's zone (today's zone room), and
 *   2. every other robot IN THE SAME REGION whose REMAINING commanded route meets the
 *      obstacle's footprint, wherever that robot is now.
 * A robot in another region is never a recipient, whatever its route (region isolation).
 *
 * Missing route data is never proof that a robot is unaffected (2026-10-24). A same-region robot
 * in another zone whose commanded route the server could not establish — the read failed, or its
 * live commitment carries no usable route geometry (`routeUnknown`) — is alerted conservatively,
 * as ROUTE_UNKNOWN. An alert is advisory (no reroute, no engine write) and the robot judges its
 * own relevance, so over-warning is the safe side. An idle robot (no live commitment) has no
 * commanded route at all and is not alerted by route.
 *
 * ── Where it runs ────────────────────────────────────────────────────────────
 * `dtaroZoneAlert.processReport` calls it with every eligible robot's server-side zone and its
 * remaining commanded route (`dtaroCommandedRoute.service`: the live commitment's OFFER corridor,
 * cut at the robot's latest server-held position). A robot never supplies its own route here.
 *
 * Decides nothing about routes: no reroute, no replan, no engine write (OD-3, V1 freeze).
 * Deterministic: recipients are returned sorted by robot id.
 */

const { pathIntersectsPolygon } = require("./routeIntersection.service");

const REASON = Object.freeze({
  SAME_ZONE: "SAME_ZONE",
  ROUTE_CROSSES_OBSTACLE: "ROUTE_CROSSES_OBSTACLE",
  ROUTE_UNKNOWN: "ROUTE_UNKNOWN",
  OTHER_REGION: "OTHER_REGION",
  NO_ZONE: "NO_ZONE",
  NO_REMAINING_ROUTE: "NO_REMAINING_ROUTE",
  ROUTE_CLEAR: "ROUTE_CLEAR",
  REPORTER: "REPORTER",
});

/** Where a considered robot stands relative to the obstacle's zone. */
const RELATION = Object.freeze({
  SAME_ZONE: "SAME_ZONE",
  OTHER_ZONE: "OTHER_ZONE",
  NO_ZONE: "NO_ZONE",
});

const byRobotId = (a, b) => (a.robotId < b.robotId ? -1 : a.robotId > b.robotId ? 1 : 0);

/**
 * @param {object} input
 * @param {{ regionId: string, zoneId: string, footprint: Array<{lat:number, lon:number}> }} input.obstacle
 *   the obstacle's published cell, zone and region, and its footprint polygon
 * @param {Array<{ robotId: string, regionId: string|null, zoneId: string|null,
 *                 remainingRoute?: Array<{lat:number, lon:number}>|null, routeUnknown?: boolean }>} input.robots
 *   each robot's server-side region and zone (from its last accepted position) and the part of
 *   its commanded route still ahead of it, starting at its current position; `routeUnknown`
 *   when the robot may have a commanded route the server could not read
 * @param {string} [input.reporterRobotId] excluded, as the live path excludes it
 * @returns {{ sameZone: string[], crossZone: string[], notNotified: Array<{ robotId: string, reason: string }>,
 *             decisions: Array<{ robotId: string, relation: string, routeIntersects: boolean|null, selected: boolean, reason: string }> }}
 *   `decisions` holds one entry per robot considered, in robot-id order. `routeIntersects` is
 *   evaluated for every same-region robot that has a remaining route — including same-zone
 *   robots, for whom it is recorded but does not decide (the zone room already reaches them) —
 *   and is null where no route was available or the robot was excluded first.
 */
function selectRecipients({ obstacle, robots, reporterRobotId = null }) {
  if (!obstacle || typeof obstacle.regionId !== "string" || typeof obstacle.zoneId !== "string" || !Array.isArray(obstacle.footprint)) {
    throw new TypeError("selectRecipients needs the obstacle's regionId, zoneId and footprint");
  }
  const sameZone = [];
  const crossZone = [];
  const notNotified = [];
  const decisions = [];
  const hasRoute = (robot) => Array.isArray(robot.remainingRoute) && robot.remainingRoute.length > 0;
  for (const robot of [...(robots || [])].sort(byRobotId)) {
    const decide = (relation, selected, reason, routeIntersects = null) => {
      decisions.push({ robotId: robot.robotId, relation, routeIntersects, selected, reason });
      if (!selected) notNotified.push({ robotId: robot.robotId, reason });
    };
    if (robot.robotId === reporterRobotId) {
      decide(REASON.REPORTER, false, REASON.REPORTER);
      continue;
    }
    if (robot.regionId !== obstacle.regionId) {
      decide(REASON.OTHER_REGION, false, REASON.OTHER_REGION);
      continue;
    }
    const intersects = hasRoute(robot) ? pathIntersectsPolygon(robot.remainingRoute, obstacle.footprint) : null;
    if (robot.zoneId && robot.zoneId === obstacle.zoneId) {
      sameZone.push(robot.robotId);
      decide(RELATION.SAME_ZONE, true, REASON.SAME_ZONE, intersects);
    } else if (intersects === null && robot.routeUnknown === true) {
      crossZone.push(robot.robotId);
      decide(robot.zoneId ? RELATION.OTHER_ZONE : RELATION.NO_ZONE, true, REASON.ROUTE_UNKNOWN);
    } else if (intersects === null) decide(robot.zoneId ? RELATION.OTHER_ZONE : RELATION.NO_ZONE, false, robot.zoneId ? REASON.NO_REMAINING_ROUTE : REASON.NO_ZONE);
    else if (intersects) {
      crossZone.push(robot.robotId);
      decide(robot.zoneId ? RELATION.OTHER_ZONE : RELATION.NO_ZONE, true, REASON.ROUTE_CROSSES_OBSTACLE, true);
    } else decide(robot.zoneId ? RELATION.OTHER_ZONE : RELATION.NO_ZONE, false, REASON.ROUTE_CLEAR, false);
  }
  return { sameZone, crossZone, notNotified, decisions };
}

module.exports = { REASON, RELATION, selectRecipients };
