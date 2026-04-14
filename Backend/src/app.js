const express = require("express");
const cookieParser = require("cookie-parser");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");

const logger = require("./config/logger");
const { corsOriginDelegate } = require("./config/cors");

const apiRoutes = require("./routes");

const notFound = require("./middlewares/notFound");
const errorHandler = require("./middlewares/errorHandler");

const app = express();

// Security
app.use(helmet());

// Middlewares
app.use(
  cors({
    origin: corsOriginDelegate,
    credentials: true,
  })
);

app.use(express.json());
app.use(cookieParser());

// HTTP request logging
app.use(
  morgan("tiny", {
    stream: {
      write: (msg) => logger.info(msg.trim()),
    },
  })
);

// Health check (no auth, used for production monitoring)
app.get("/health", async (req, res) => {
  const kv = req.app?.locals?.kv;
  const prisma = req.app?.locals?.prisma;

  let redisOk = false;
  let dbOk = false;
  let robotsOnline = 0;
  let commandsPending = 0;

  // Redis: if kv exposes health(), use it. Also attempt a tiny roundtrip.
  try {
    const hinted = typeof kv?.health === "function" ? kv.health() : null;
    if (hinted && hinted.redis === true) redisOk = true;
    const key = `health:${Date.now()}`;
    await kv?.set(key, "1", { ex: 2 });
    const v = await kv?.get(key);
    await kv?.del(key);
    if (v === "1") redisOk = redisOk || true;
  } catch {
    redisOk = false;
  }

  // DB: lightweight query
  try {
    if (prisma) {
      await prisma.$queryRaw`SELECT 1`;
      dbOk = true;
    }
  } catch {
    dbOk = false;
  }

  if (dbOk && prisma) {
    try {
      const [online, pending] = await Promise.all([
        prisma.robot.count({ where: { isOnline: true } }),
        prisma.command.count({ where: { status: "SENT" } }),
      ]);
      robotsOnline = online;
      commandsPending = pending;
    } catch {
      robotsOnline = 0;
      commandsPending = 0;
    }
  }

  res.json({
    server: "ok",
    redis: redisOk ? "ok" : "fail",
    db: dbOk ? "ok" : "fail",
    robotsOnline,
    commandsPending,
    uptime: Math.floor(process.uptime()),
  });
});

// Routes
app.use("/api", apiRoutes);

// 404 + error handler
app.use(notFound);
app.use(errorHandler);

module.exports = app;