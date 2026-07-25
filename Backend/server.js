const http = require("http");
const { Server } = require("socket.io");

require("./src/config/env");

const app = require("./src/app");
const logger = require("./src/config/logger");
const { isOriginAllowed } = require("./src/config/cors");
const { connectPrismaWithRetry, disconnectPrisma } = require("./src/db/prisma");
const { initKv } = require("./src/cache/kv");
const initSocketServer = require("./src/sockets/socket.server");
const { recoverActiveTasks } = require("./src/services/taskRecovery.service");
const { createVirtualRobotSimulator } = require("./src/simulation/SimulationEngine");
const { dispatchTaskAssign } = require("./src/services/commandDispatcher.service");
const { safeJsonParse } = require("./src/utils/json");
const { ensureAdminUser } = require("./src/services/adminBootstrap.service");

async function start() {
  const server = http.createServer(app);
  const io = new Server(server, {
    cors: {
      origin: (origin, callback) => {
        callback(null, isOriginAllowed(origin));
      },
      credentials: true,
    },
  });

  const prisma = await connectPrismaWithRetry({ logger });
  const { kv, close: closeKv } = await initKv({ logger });

  // Detect Redis availability for the startup banner.
  let redisLive = false;
  try {
    const testKey = `hb:${Date.now()}`;
    await kv.set(testKey, "1", { ex: 2 });
    const v = await kv.get(testKey);
    await kv.del(testKey);
    redisLive = v === "1";
  } catch { /* falls back to in-memory */ }

  app.locals.kv = kv;
  app.locals.prisma = prisma;
  app.locals.io = io;

  initSocketServer(io, { prisma, kv, logger });

  // Ensure the admin user exists (idempotent — safe to run on every start).
  try {
    await ensureAdminUser(prisma, { logger });
  } catch (e) {
    logger.warn("Admin bootstrap skipped", { message: e?.message });
  }

  // Resilience: rebuild Redis task/path state after restarts.
  try {
    await recoverActiveTasks(prisma, kv, io, { logger });
  } catch (e) {
    logger.error("Task recovery failed", { e });
  }

  const port = Number(process.env.PORT || 3000);
  const host = typeof process.env.HOST === "string" && process.env.HOST.trim() ? process.env.HOST.trim() : "0.0.0.0";

  server.on("error", (err) => {
    if (err && err.code === "EADDRINUSE") {
      logger.error(`Port ${port} is already in use. Stop the other process or set PORT to a free port.`);
      process.exit(1);
      return;
    }
    logger.error("Server error", { err });
    process.exit(1);
  });

  let virtualSimulator = null;

  const shutdown = async (signal) => {
    try {
      logger.warn(`Shutdown received (${signal}) — draining connections…`);
      try { virtualSimulator?.stop?.(); } catch { /* ignore */ }
      await new Promise((resolve) => server.close(resolve));
      io.close();
      await closeKv();
      await disconnectPrisma();
      process.exit(0);
    } catch (e) {
      logger.error("Shutdown failed", { e });
      process.exit(1);
    }
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  server.listen(port, host, () => {
    const serverUrl = `http://127.0.0.1:${port}`;
    virtualSimulator = createVirtualRobotSimulator({ prisma, kv, serverUrl, logger });
    app.locals.virtualSimulator = virtualSimulator;
    virtualSimulator.start();

    logger.startup({
      env:       process.env.NODE_ENV || "development",
      port,
      db:        true,
      redis:     redisLive,
      simulator: "Ready — re-hydrating commissioned robots…",
    });

    // Re-hydrate VirtualRobot instances for every robot that was commissioned
    // in a previous session.  Runs async after listen so it doesn't block the
    // HTTP server from becoming ready.
    (async () => {
      try {
        const existing = await prisma.robot.findMany({
          select: { robotId: true, lat: true, lon: true },
        });

        if (existing.length === 0) return;

        // Mark all robots online immediately so DTARO can assign tasks to them
        // even in the brief window before their VirtualRobot socket connects.
        await prisma.robot.updateMany({
          where: { robotId: { in: existing.map((r) => r.robotId) } },
          data:  { isOnline: true, lastSeenAt: new Date() },
        });

        for (const r of existing) {
          try {
            await virtualSimulator.addRobot({ robotId: r.robotId, lat: r.lat, lon: r.lon });
          } catch (e) {
            logger.warn(`[VR] Re-hydration failed for ${r.robotId}`, { message: e?.message });
          }
        }

        logger.info(`[VR] Re-hydrated ${existing.length} robot(s) from DB`);

        // After a brief window (5 s) for VirtualRobots to connect + authenticate,
        // re-dispatch any tasks that were active when the server was last shut down.
        // Without this, robots know they have tasks in DB but never receive TASK_ASSIGN.
        setTimeout(async () => {
          try {
            const activeTasks = await prisma.task.findMany({
              where: { status: { in: ["ASSIGNED", "IN_PROGRESS"] } },
              include: { robot: { select: { robotId: true } } },
            });

            for (const task of activeTasks) {
              const robotId = task.robot?.robotId;
              if (!robotId) continue;

              const pathRaw = await kv.get(`taskPath:${task.taskId}`);
              const path = safeJsonParse(pathRaw);
              if (!path?.toPickup || !path?.toDrop) continue;

              const result = await dispatchTaskAssign(robotId, {
                taskId: task.taskId,
                pickup: { lat: task.pickupLat, lon: task.pickupLon },
                drop:   { lat: task.dropLat,   lon: task.dropLon   },
                pathToPickup: path.toPickup,
                pathToDrop:   path.toDrop,
              });

              logger.info(`[VR] Re-dispatched task ${task.taskId} → ${robotId}`, {
                dispatched: result.dispatched,
                attempts: result.attempts,
              });

              // Also re-emit TASK_ASSIGNED so connected dashboards can draw the route.
              try {
                io.to("dashboard").emit("TASK_ASSIGNED", {
                  taskId:        task.taskId,
                  robotId,
                  pickup:        { lat: task.pickupLat, lon: task.pickupLon },
                  drop:          { lat: task.dropLat,   lon: task.dropLon   },
                  pathToPickup:  path.toPickup,
                  pathToDrop:    path.toDrop,
                  usedFallback:  false,
                });
              } catch { /* ignore */ }
            }
          } catch (e) {
            logger.warn("[VR] Active task re-dispatch error", { message: e?.message });
          }
        }, 5000);

      } catch (e) {
        logger.warn("[VR] Startup re-hydration error", { message: e?.message });
      }
    })();
  });
}

start().catch((err) => {
  logger.error("Failed to start server", { err });
  process.exit(1);
});