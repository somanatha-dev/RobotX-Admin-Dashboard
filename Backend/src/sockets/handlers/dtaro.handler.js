/**
 * DTARO Socket Handler
 *
 * Handles robot-initiated DTARO events that are not part of the
 * core telemetry or auth pipeline:
 *
 *   OBSTACLE_REPORT  — robot detected an obstacle; triggers EKB + dissemination
 *   TASK_COMPLETE    — real robot signals task completion
 *   ROBOT_FAULT      — robot reports a hardware fault
 *
 * Each handler rate-limits, validates, and delegates to the appropriate service.
 */

const { toStringOrNull } = require("../../utils/parse");
const { allow } = require("../rateLimit");
const { processObstacleReport } = require("../../services/alertDissemination.service");
const { updateHealthStatus, updateAssignedTask } = require("../../services/robotRegistry.service");
const { z } = require("zod");

const obstacleSchema = z.object({
  lat: z.number(),
  lon: z.number(),
  severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional().default("MEDIUM"),
});

const faultSchema = z.object({
  code: z.string().optional(),
  message: z.string().optional(),
  sensor: z.string().optional(),
});

/**
 * Register DTARO-specific socket event handlers.
 *
 * @param {object} io
 * @param {object} socket
 * @param {{ prisma: object, kv: object, logger: object }} deps
 */
function registerDtaroHandlers(io, socket, { prisma, kv, logger }) {
  const log = logger || console;

  // ─── OBSTACLE_REPORT ────────────────────────────────────────────────────────
  socket.on("OBSTACLE_REPORT", async (payload) => {
    try {
      if (!allow(socket, "OBSTACLE_REPORT", { limit: 10, windowMs: 60_000, minIntervalMs: 500 })) return;

      const robotId = toStringOrNull(socket.data.robotId);
      if (!robotId) {
        socket.emit("ERROR", { event: "OBSTACLE_REPORT", reason: "Not authenticated" });
        return;
      }

      const parsed = obstacleSchema.safeParse(payload || {});
      if (!parsed.success) {
        socket.emit("ERROR", { event: "OBSTACLE_REPORT", reason: "Invalid payload", details: parsed.error.issues });
        return;
      }

      const { lat, lon, severity } = parsed.data;

      log.info("OBSTACLE_REPORT received", { robotId, lat, lon, severity });

      const result = await processObstacleReport(prisma, kv, io, {
        lat,
        lon,
        severity,
        reportingRobotId: robotId,
      });

      socket.emit("OBSTACLE_REPORT_ACK", {
        obstacleId: result.obstacle.obstacleId,
        affectedRobots: result.affectedRobotIds.length,
        timestamp: result.obstacle.timestamp,
      });
    } catch (e) {
      log.error("OBSTACLE_REPORT handler failed", e);
    }
  });

  // ─── TASK_COMPLETE ───────────────────────────────────────────────────────────
  socket.on("TASK_COMPLETE", async (payload) => {
    try {
      if (!allow(socket, "TASK_COMPLETE", { limit: 5, windowMs: 30_000, minIntervalMs: 1000 })) return;

      const robotId = toStringOrNull(socket.data.robotId);
      if (!robotId) return;

      const taskId = toStringOrNull(payload?.taskId);
      log.info("TASK_COMPLETE received", { robotId, taskId });

      await prisma.$transaction(async (tx) => {
        // Mark task COMPLETED if it belongs to this robot and isn't already done
        if (taskId) {
          await tx.task.updateMany({
            where: {
              taskId,
              robot: { robotId },
              status: { in: ["ASSIGNED", "IN_PROGRESS"] },
            },
            data: { status: "COMPLETED", completedAt: new Date() },
          });
        }

        // Release robot back to IDLE
        await tx.robot.update({
          where: { robotId },
          data: { currentTaskId: null, status: "IDLE", speed: 0 },
        });
      });

      // Clear Redis task state
      if (kv && taskId) {
        await Promise.allSettled([
          kv.del(`robotTaskState:${robotId}`),
          kv.del(`robotTask:${robotId}`),
        ]);
      }

      // Update registry
      await updateAssignedTask(kv, robotId, null);

      // Notify dashboard
      io.to("dashboard").emit("TASK_UPDATED", {
        robotId,
        taskId,
        status: "COMPLETED",
        timestamp: Date.now(),
      });

      socket.emit("TASK_COMPLETE_ACK", { taskId, timestamp: Date.now() });
    } catch (e) {
      log.error("TASK_COMPLETE handler failed", e);
    }
  });

  // ─── ROBOT_FAULT ─────────────────────────────────────────────────────────────
  socket.on("ROBOT_FAULT", async (payload) => {
    try {
      if (!allow(socket, "ROBOT_FAULT", { limit: 5, windowMs: 60_000, minIntervalMs: 1000 })) return;

      const robotId = toStringOrNull(socket.data.robotId);
      if (!robotId) return;

      const parsed = faultSchema.safeParse(payload || {});
      const faultData = parsed.success ? parsed.data : {};
      const { code = "UNKNOWN", message = "Unspecified fault", sensor = null } = faultData;

      log.warn("ROBOT_FAULT received", { robotId, code, message, sensor });

      // Update robot status to ERROR in DB
      await prisma.robot.update({
        where: { robotId },
        data: { status: "ERROR" },
      });

      // Update health status in registry
      await updateHealthStatus(kv, robotId, "FAULT");

      // Log fault as an Event
      try {
        const robotRow = await prisma.robot.findUnique({ where: { robotId }, select: { id: true } });
        if (robotRow) {
          await prisma.event.create({
            data: {
              robotId: robotRow.id,
              type: "CRITICAL",
              message: `Fault reported: [${code}] ${message}${sensor ? ` (sensor: ${sensor})` : ""}`,
            },
          });
        }
      } catch {
        // ignore event log failure
      }

      // Notify dashboard
      io.to("dashboard").emit("ROBOT_UPDATED", {
        robotId,
        status: "ERROR",
        healthStatus: "FAULT",
        fault: { code, message, sensor },
        timestamp: Date.now(),
      });

      socket.emit("ROBOT_FAULT_ACK", { timestamp: Date.now() });
    } catch (e) {
      log.error("ROBOT_FAULT handler failed", e);
    }
  });
}

module.exports = { registerDtaroHandlers };
