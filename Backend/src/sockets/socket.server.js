const { toStringOrNull } = require("../utils/parse");
const taskService = require("../services/task.service");
const { registerRobotHandlers } = require("./handlers/robot.handler");
const { registerTelemetryHandlers } = require("./handlers/telemetry.handler");
const { registerCommandHandlers } = require("./handlers/command.handler");
const { registerDtaroHandlers } = require("./handlers/dtaro.handler");
const { sweepExpired } = require("../services/ekb.service");
const { seedDefaultZones } = require("../services/zoneManager.service");
const { verifyUserToken } = require("../middlewares/auth_middleware");

let offlineSweepStarted = false;
let dtaroSweepStarted = false;

// Extracts the admin session JWT from a dashboard socket's handshake — the
// `token` cookie (same cookie REST auth uses), falling back to an explicit
// `auth.token` for non-cookie clients. Robot sockets never hit this path.
function getDashboardToken(socket) {
    const cookieHeader = socket?.handshake?.headers?.cookie;
    if (typeof cookieHeader === "string") {
        for (const part of cookieHeader.split(";")) {
            const idx = part.indexOf("=");
            if (idx === -1) continue;
            if (part.slice(0, idx).trim() === "token") {
                try {
                    return decodeURIComponent(part.slice(idx + 1).trim());
                } catch {
                    return part.slice(idx + 1).trim();
                }
            }
        }
    }
    const authToken = socket?.handshake?.auth?.token;
    return typeof authToken === "string" && authToken ? authToken : null;
}

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

function startDtaroSweep(prisma, kv, { logger } = {}) {
    if (dtaroSweepStarted) return;
    dtaroSweepStarted = true;

    const log = logger || console;

    // Seed default campus zones on startup (idempotent)
    (async () => {
        try {
            const campus = await prisma.campus.findFirst();
            if (campus) await seedDefaultZones(prisma, kv, campus);
        } catch (e) {
            log.warn("Zone seeding skipped", e?.message);
        }
    })();

    // Periodically sweep expired EKB entries
    const ekbSweep = setInterval(async () => {
        try {
            await sweepExpired(kv);
        } catch (e) {
            log.error("EKB sweep failed", e);
        }
    }, 60_000);
    if (typeof ekbSweep.unref === "function") ekbSweep.unref();
}

function initSocketServer(io, { prisma, kv, logger }) {
    startOfflineDetector(prisma, { logger });
    startDtaroSweep(prisma, kv, { logger });

    const log = (logger || console);

    io.on("connection", async (socket) => {
        const origin = socket?.handshake?.headers?.origin;
        const ua     = socket?.handshake?.headers?.["user-agent"];
        const isDashboard = !!(origin || (typeof ua === "string" && ua.includes("Mozilla")));

        if (typeof log.socket === "function") {
            log.socket("connect", { socketId: socket.id });
        } else {
            log.info("Socket connected", { socketId: socket.id });
        }

        if (isDashboard) {
            // Dashboard sockets must present the same JWT REST auth uses —
            // robot sockets are untouched, they authenticate via the AUTH event.
            const token = getDashboardToken(socket);
            const user = token ? await verifyUserToken(token).catch(() => null) : null;

            if (!user) {
                if (typeof log.socket === "function") {
                    log.socket("reject", { socketId: socket.id, reason: "dashboard_unauthorized" });
                } else {
                    log.warn("Rejected unauthenticated dashboard socket", { socketId: socket.id });
                }
                socket.emit("UNAUTHORIZED", { message: "Authentication required" });
                socket.disconnect(true);
                return;
            }

            socket.data.userId = user.id;
            socket.join("dashboard");
            if (typeof log.socket === "function") {
                log.socket("join", { socketId: socket.id, room: "dashboard" });
            }

            // Re-hydrate this dashboard client with all active task paths so the
            // map route overlays work even when the user opens the page after
            // the initial TASK_ASSIGNED event was broadcast (on server startup or task creation).
            setImmediate(async () => {
                try {
                    const activeTasks = await prisma.task.findMany({
                        where: { status: { in: ["ASSIGNED", "IN_PROGRESS"] } },
                        include: { robot: { select: { robotId: true } } },
                    });
                    for (const t of activeTasks) {
                        const robotId = t.robot?.robotId;
                        if (!robotId) continue;
                        const pathRaw = await kv.get(`taskPath:${t.taskId}`).catch(() => null);
                        if (!pathRaw) continue;
                        let path;
                        try { path = JSON.parse(pathRaw); } catch { continue; }
                        if (!path?.toPickup || !path?.toDrop) continue;
                        socket.emit("TASK_ASSIGNED", {
                            taskId:       t.taskId,
                            robotId,
                            pickup:       path.pickup  ?? { lat: t.pickupLat, lon: t.pickupLon },
                            drop:         path.drop    ?? { lat: t.dropLat,   lon: t.dropLon   },
                            pathToPickup: path.toPickup,
                            pathToDrop:   path.toDrop,
                        });
                    }
                } catch { /* non-critical — dashboard will get routes via next emit */ }
            });
        }

        socket.on("disconnect", (reason) => {
            if (typeof log.socket === "function") {
                log.socket("disconnect", { socketId: socket.id, robotId: socket.data?.robotId, reason });
            } else {
                log.info("Socket disconnected", { socketId: socket.id, reason });
            }
        });

        // Robot auth + lifecycle
        registerRobotHandlers(io, socket, { prisma, kv, logger });

        // Telemetry pipeline (Redis live state + DB source of truth + snapshots)
        registerTelemetryHandlers(io, socket, { prisma, kv, logger });

        // Command ACK tracking
        registerCommandHandlers(io, socket, { prisma, kv, logger });

        // DTARO: obstacle reports, task completion, fault reporting
        registerDtaroHandlers(io, socket, { prisma, kv, logger });

        // ADMIN CREATES TASK (via socket — legacy path)
        socket.on("assign_task", async (task) => {
            if (typeof log.socketIn === "function") {
                log.socketIn("assign_task", { robotId: task?.robotId });
            }
            try {
                const created = await taskService.assignTask(prisma, task, { kv, io });
                io.to("dashboard").emit("task_assigned", created);
                if (typeof log.socketOut === "function") {
                    log.socketOut("task_assigned", "dashboard", { robotId: created?.robot?.robotId });
                }
            } catch (e) {
                const taskId  = toStringOrNull(task?.taskId || task?.id);
                const robotId = toStringOrNull(task?.robotId);
                log.error("assign_task failed", { taskId, robotId, message: e?.message });
                io.to("dashboard").emit("task_error", {
                    taskId,
                    robotId,
                    error: e?.message || "Failed to assign task",
                });
            }
        });
    });
}

module.exports = initSocketServer;