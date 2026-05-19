/**
 * Alert Dissemination Service — DTARO
 *
 * Processes incoming obstacle reports end-to-end:
 *   1. Determine zone from obstacle coordinates
 *   2. Store event in EKB (Redis TTL + PostgreSQL)
 *   3. Emit ALERT_CREATED to dashboard
 *   4. Load all active robot states and their planned paths
 *   5. Run route intersection check to find affected robots
 *   6. Emit REROUTE_ALERT to each affected robot's socket room
 *   7. Trigger server-side path replanning for each affected robot
 *
 * All steps after EKB storage are best-effort — a failure in rerouting
 * does not block the obstacle from being recorded.
 */

const ekb = require("./ekb.service");
const { getZoneForCoordinates } = require("./zoneManager.service");
const { findAffectedRobots } = require("./routeIntersection.service");
const { getAllRobotIds, getRobotState } = require("./robotRegistry.service");
const { rerouteRobot } = require("./routing.service");

// Represent a point obstacle as a tiny segment (~22 m diagonal)
const POINT_OBSTACLE_DELTA = 0.0002; // degrees

/**
 * Process an obstacle report and disseminate REROUTE_ALERTs.
 *
 * @param {object} prisma
 * @param {object} kv
 * @param {object|null} io
 * @param {{ lat: number, lon: number, severity?: string, reportingRobotId?: string }} report
 * @returns {Promise<{ obstacle: object, affectedRobotIds: string[] }>}
 */
async function processObstacleReport(prisma, kv, io, report) {
  const { lat, lon, severity = "MEDIUM", reportingRobotId = null } = report;

  // 1) Zone determination
  const zone = await getZoneForCoordinates(prisma, kv, lat, lon);
  const zoneId = zone?.id || null;

  // 2) Store in EKB
  const obstacle = await ekb.storeObstacle(kv, prisma, {
    lat,
    lon,
    zoneId,
    severity,
    reportingRobotId,
  });

  // 3) Notify dashboard that a new obstacle was created
  if (io) {
    try {
      io.to("dashboard").emit("ALERT_CREATED", {
        obstacleId: obstacle.obstacleId,
        lat,
        lon,
        zoneId,
        zoneName: zone?.name || null,
        severity,
        reportingRobotId,
        timestamp: obstacle.timestamp,
        expiresAt: obstacle.expiresAt,
      });
    } catch {
      // ignore socket emit failure
    }
  }

  // 4) Load all active robot states (with planned paths for intersection test)
  const robotIds = await getAllRobotIds(kv);
  const robotStates = (
    await Promise.all(
      robotIds.map(async (robotId) => {
        const state = await getRobotState(kv, robotId);
        return state ? { robotId, plannedPath: state.plannedPath || [] } : null;
      })
    )
  ).filter(Boolean);

  // 5) Model the obstacle as a tiny segment for intersection testing
  const blockStart = { lat: lat - POINT_OBSTACLE_DELTA, lon: lon - POINT_OBSTACLE_DELTA };
  const blockEnd = { lat: lat + POINT_OBSTACLE_DELTA, lon: lon + POINT_OBSTACLE_DELTA };

  const affectedRobotIds = findAffectedRobots(robotStates, blockStart, blockEnd);

  // 6 & 7) Alert + reroute each affected robot
  await Promise.allSettled(
    affectedRobotIds.map(async (robotId) => {
      const alertPayload = {
        obstacleId: obstacle.obstacleId,
        lat,
        lon,
        zoneId,
        severity,
        timestamp: obstacle.timestamp,
      };

      // Emit to robot's dedicated socket room
      if (io) {
        try { io.to(`robot:${robotId}`).emit("REROUTE_ALERT", alertPayload); } catch { /* ignore */ }
        try {
          io.to("dashboard").emit("REROUTE_ALERT", { robotId, ...alertPayload });
        } catch { /* ignore */ }
      }

      // Server-side path replanning
      await rerouteRobot(prisma, kv, io, robotId, { obstacleLocation: { lat, lon } });
    })
  );

  return { obstacle, affectedRobotIds };
}

module.exports = {
  processObstacleReport,
};
