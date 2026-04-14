const http = require("http");
const { Server } = require("socket.io");

require("./src/config/env");

const app = require("./src/app");
const logger = require("./src/config/logger");
const { isOriginAllowed } = require("./src/config/cors");
const { connectPrismaWithRetry, disconnectPrisma } = require("./src/db/prisma");
const { initKv } = require("./src/cache/kv");
const initSocketServer = require("./src/sockets/socket.server");
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
  await ensureAdminUser(prisma, { logger });
  const { kv, close: closeKv } = await initKv({ logger });

  // Make shared infrastructure available to route handlers without changing existing
  // connection implementations.
  app.locals.kv = kv;
  app.locals.prisma = prisma;

  initSocketServer(io, { prisma, kv, logger });

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

  const shutdown = async (signal) => {
    try {
      logger.info(`Shutting down (${signal})...`);
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
    logger.info(`Server running on ${host}:${port}`);
  });
}

start().catch((err) => {
  logger.error("Failed to start server", { err });
  process.exit(1);
});