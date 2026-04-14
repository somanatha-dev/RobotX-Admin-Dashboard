const { toStringOrNull } = require("../utils/parse");
const taskService = require("../services/task.service");
const { registerRobotHandlers } = require("./handlers/robot.handler");
const { registerTelemetryHandlers } = require("./handlers/telemetry.handler");
const { registerCommandHandlers } = require("./handlers/command.handler");

let offlineSweepStarted = false;

function startOfflineDetector(prisma, { logger } = {}) {
    if (offlineSweepStarted) return;
    offlineSweepStarted = true;

    const log = logger || console;
    setInterval(async () => {
        try {
            const cutoff = new Date(Date.now() - 10_000);
            // Efficiently mark stale robots offline.
            await prisma.robot.updateMany({
                where: {
                    isOnline: true,
                    lastSeenAt: { lt: cutoff },
                },
                data: {
                    isOnline: false,
                    status: "OFFLINE",
                },
            });
        } catch (e) {
            log.error("offline detector failed", e);
        }
    }, 10_000);
}

function initSocketServer(io, { prisma, kv, logger }) {
    startOfflineDetector(prisma, { logger });

    io.on("connection", (socket) => {
        (logger || console).info("Socket connected", { socketId: socket.id });

        // Frontend dashboard sockets are typically browser-originated.
        // Heuristic join keeps backward compatibility (frontend doesn't need to emit a join event).
        const origin = socket?.handshake?.headers?.origin;
        const ua = socket?.handshake?.headers?.["user-agent"];
        if (origin || (typeof ua === "string" && ua.includes("Mozilla"))) {
            socket.join("dashboard");
        }

        // Robot auth + lifecycle
        registerRobotHandlers(io, socket, { prisma, kv, logger });

        // Telemetry pipeline (Redis live state + DB source of truth + snapshots)
        registerTelemetryHandlers(io, socket, { prisma, kv, logger });

        // Command ACK tracking
        registerCommandHandlers(io, socket, { prisma, kv, logger });

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
    });
}

module.exports = initSocketServer;