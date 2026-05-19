const http = require("http");
const { Server } = require("socket.io");

require("./src/config/env");

const app = require("./src/app");
const logger = require("./src/config/logger");
const { isOriginAllowed } = require("./src/config/cors");
const { connectPrismaWithRetry, disconnectPrisma } = require("./src/db/prisma");
const { initKv } = require("./src/cache/kv");
const initSocketServer = require("./src/sockets/socket.server");
const { createSimulationEngine } = require("./src/services/simulation.service");
const { recoverActiveTasks } = require("./src/services/taskRecovery.service");
const { createVirtualRobotSimulator } = require("./src/simulation/SimulationEngine");
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

  // Controlled robot simulation engine (Redis primary live state; DB secondary).
  // Safe: skips robots with an active robot socket connection.
  const simulation = createSimulationEngine({ prisma, kv, io, logger });
  simulation.start({ intervalMs: 2000 });

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
      try { simulation?.stop?.();        } catch { /* ignore */ }
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
      db:        true,   // if we got here, prisma connected
      redis:     redisLive,
      simulator: "Ready — waiting for commissioned robots",
    });
  });
}

start().catch((err) => {
  logger.error("Failed to start server", { err });
  process.exit(1);
});