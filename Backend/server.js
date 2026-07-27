const http = require("http");
const { Server } = require("socket.io");
const { createAdapter } = require("@socket.io/redis-adapter");
const Redis = require("ioredis");

require("./src/config/env");
require("./src/observability/eventLoopMonitor").start();

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
const configService = require("./src/engine/config/service");

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

  // Socket.IO's default adapter only broadcasts within its own process — a
  // room emit (io.to("dashboard").emit(...)) from a worker that handled some
  // robot's telemetry would never reach a dashboard client connected to a
  // *different* worker. Required for correctness the moment this runs as
  // more than one process (clustering/horizontal scaling), not just a perf
  // nicety. Mirrors kv.js's own "configured but unreachable" policy: warn and
  // fall back to the default (single-process) adapter rather than crash —
  // this is the one place where that fallback is a real behavior change
  // (cross-worker broadcast silently stops working) rather than a
  // transparent degrade, so it's logged loudly.
  let redisAdapterClients = null;
  const redisUrl = typeof process.env.REDIS_URL === "string" ? process.env.REDIS_URL.trim() : "";
  const redisEnabled = String(process.env.REDIS_ENABLED || "").toLowerCase() !== "false";
  if (redisEnabled && redisUrl) {
    try {
      const pubClient = new Redis(redisUrl, { connectTimeout: Number(process.env.REDIS_CONNECT_TIMEOUT_MS || 5000) });
      const subClient = pubClient.duplicate();
      await Promise.all([
        new Promise((resolve, reject) => { pubClient.once("ready", resolve); pubClient.once("error", reject); }),
        new Promise((resolve, reject) => { subClient.once("ready", resolve); subClient.once("error", reject); }),
      ]);
      io.adapter(createAdapter(pubClient, subClient));
      redisAdapterClients = { pubClient, subClient };
      logger.info("Socket.IO Redis adapter attached — broadcasts fan out across worker processes");
    } catch (e) {
      logger.warn(
        "Socket.IO Redis adapter unavailable — falling back to the default single-process adapter. " +
        "If this process is one of several workers behind a load balancer, dashboard broadcasts from " +
        "other workers will NOT reach clients connected here.",
        { message: e?.message }
      );
    }
  }

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

  // Load the pinned configuration version (§22.1 rule 4). Config is DB-authoritative
  // and cache-read (§3.3): the pointer and the materialised set are mirrored in
  // Redis, but a cache miss costs a query and never a wrong answer.
  //
  // While ENGINE_ENABLED is false this degrades to the register defaults with a log
  // line. With it true, a process that cannot load its pinned version refuses to
  // start rather than silently inventing one.
  app.locals.config = await configService.bootstrap({ prisma, kv, logger });

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
      if (redisAdapterClients) {
        try { redisAdapterClients.pubClient.disconnect(); } catch { /* ignore */ }
        try { redisAdapterClients.subClient.disconnect(); } catch { /* ignore */ }
      }
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

  // Benchmark harness sets this so an external load-generator is the sole
  // source of robot traffic — otherwise every commissioned/seeded Robot row
  // gets its own in-process VirtualRobot socket.io-client on every boot
  // (below), which would compete with the server for CPU on the same
  // process and invalidate capacity measurements. Default (unset) preserves
  // existing behavior exactly.
  const disableVirtualSimulator = String(process.env.DISABLE_VIRTUAL_SIMULATOR || "").toLowerCase() === "true";

  server.listen(port, host, () => {
    const serverUrl = `http://127.0.0.1:${port}`;
    virtualSimulator = createVirtualRobotSimulator({ prisma, kv, serverUrl, logger });
    app.locals.virtualSimulator = virtualSimulator;

    if (disableVirtualSimulator) {
      logger.startup({
        env:       process.env.NODE_ENV || "development",
        port,
        db:        true,
        redis:     redisLive,
        simulator: "Disabled (DISABLE_VIRTUAL_SIMULATOR=true) — benchmark mode",
      });
      return;
    }

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

              // NOTE: `io` is required — dispatchTaskAssign routes through the
              // Socket.IO adapter (io.in(room)/io.to(room)) rather than a
              // process-local socket map, so it works across worker processes.
              // Omitting it silently bound the robotId to `io` and made every
              // re-dispatch a no-op that still reported itself as attempted.
              const result = await dispatchTaskAssign(io, robotId, {
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