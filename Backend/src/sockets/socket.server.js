const { toNumberOrNull, toStringOrNull } = require("../utils/parse");
const telemetryService = require("../services/telemetry.service");
const taskService = require("../services/task.service");
const robotService = require("../services/robot.service");

function initSocketServer(io, { prisma, kv, logger }) {
    io.on("connection", (socket) => {
        (logger || console).info("Socket connected", { socketId: socket.id });

        // ROBOT SENDS DATA
        socket.on("telemetry", async (data) => {
            try {
                const robotCode = toStringOrNull(data?.robotId);
                if (!robotCode) return;

                // keep last-known state in Redis for ultra-fast reads
                await kv.set(`robot:${robotCode}`, JSON.stringify(data));
                await kv.set(`socket:${socket.id}`, robotCode);

                const now = new Date();
                const lat = toNumberOrNull(data?.lat);
                const lon = toNumberOrNull(data?.lon);
                const speed = toNumberOrNull(data?.speed);
                const battery = toNumberOrNull(data?.battery);

                // Robots must be commissioned first (locationId is mandatory)
                const existing = await prisma.robot.findUnique({ where: { robotId: robotCode }, select: { id: true } });
                if (!existing) {
                    io.emit("robot_unregistered", { robotId: robotCode });
                    return;
                }

                const robotRow = await prisma.robot.update({
                    where: { robotId: robotCode },
                    data: {
                        isOnline: true,
                        socketId: socket.id,
                        lastSeenAt: now,
                        ...(lat === null ? {} : { lat }),
                        ...(lon === null ? {} : { lon }),
                        speed,
                        battery,
                    },
                });

                // Store high-frequency stream (you can throttle later if needed)
                await telemetryService.saveTelemetry(prisma, robotRow.id, { lat, lon, speed, battery }, now);

                // Emit enriched update (robot row + currentTask) so the frontend can draw
                const robot = await prisma.robot.findUnique({
                    where: { robotId: robotCode },
                    include: { currentTask: true, campus: true, location: true },
                });

                io.emit("robot_update", {
                    ...data,
                    robot,
                });
            } catch (e) {
                (logger || console).error("telemetry handler failed", e);
            }
        });

        // ADMIN CREATES TASK
        socket.on("assign_task", async (task) => {
            try {
                const created = await taskService.assignTask(prisma, task);
                io.emit("task_assigned", created);
            } catch (e) {
                const taskId = toStringOrNull(task?.taskId || task?.id);
                const robotId = toStringOrNull(task?.robotId);
                io.emit("task_error", {
                    taskId,
                    robotId,
                    error: e && e.message ? e.message : "Failed to assign task",
                });
            }
        });

        socket.on("disconnect", () => {
            (logger || console).info("Socket disconnected", { socketId: socket.id });

            // Best-effort: mark robot offline if we know which one was bound to this socket.
            (async () => {
                try {
                    const robotCode = await kv.get(`socket:${socket.id}`);
                    if (!robotCode) return;
                    await kv.del(`socket:${socket.id}`);
                    await robotService.markRobotOffline(prisma, robotCode);
                    io.emit("robot_offline", { robotId: robotCode });
                } catch {
                    // ignore
                }
            })();
        });
    });
}

module.exports = initSocketServer;