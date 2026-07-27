const express = require("express");
const cookieParser = require("cookie-parser");
const cors = require("cors");
const helmet = require("helmet");
const logger = require("./config/logger");
const { corsOriginDelegate } = require("./config/cors");
const { getSystemMetrics } = require("./services/metrics.service");
const eventLoopMonitor = require("./observability/eventLoopMonitor");

const apiRoutes = require("./routes");
const configService = require("./engine/config/service");

const notFound = require("./middlewares/notFound");
const errorHandler = require("./middlewares/errorHandler");

const app = express();

// Config bootstrap (§22). The register defaults are available from module load, with
// no database and no cache, so every parameter is resolvable before — and regardless
// of whether — a version has been published. `server.js` replaces this with the
// pinned published version at boot when one exists.
//
// This is what lets the legacy compatibility shims read the register without giving
// the legacy dispatcher a startup dependency it never had.
app.locals.config = configService.defaultSnapshot();

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

// HTTP request + response logging with timing.
app.use((req, res, next) => {
  logger.http(req);
  const start = Date.now();
  res.on("finish", () => logger.httpEnd(req, res, Date.now() - start));
  next();
});

// Health check — also returns DTARO system metrics (no auth, used for monitoring).
app.get("/health", async (req, res) => {
  const kv = req.app?.locals?.kv;
  const prisma = req.app?.locals?.prisma;

  let redisOk = false;
  let dbOk = false;

  try {
    const hinted = typeof kv?.health === "function" ? kv.health() : null;
    if (hinted?.redis === true) redisOk = true;
    const key = `health:${Date.now()}`;
    await kv?.set(key, "1", { ex: 2 });
    if ((await kv?.get(key)) === "1") redisOk = true;
    await kv?.del(key);
  } catch {
    redisOk = false;
  }

  try {
    if (prisma) { await prisma.$queryRaw`SELECT 1`; dbOk = true; }
  } catch {
    dbOk = false;
  }

  // Pull DTARO system metrics (best-effort).
  let metrics = {};
  try {
    metrics = await getSystemMetrics(kv, prisma);
  } catch {
    // ignore
  }

  // Prisma connection-pool + query-wait metrics (previewFeatures=["metrics"]).
  // Direct visibility into pool contention — the thing scale-architecture.md
  // and the first benchmark run could only infer indirectly from latency.
  let prismaPool = null;
  try {
    const raw = await prisma?.$metrics?.json();
    if (raw) {
      const gauge = (name) => raw.gauges?.find((g) => g.key === name)?.value ?? null;
      const waitHist = raw.histograms?.find((h) => h.key === "prisma_client_queries_wait_histogram_ms");
      const waitCount = waitHist?.value?.count ?? 0;
      const waitSum = waitHist?.value?.sum ?? 0;
      prismaPool = {
        connectionsOpen: gauge("prisma_pool_connections_open"),
        connectionsBusy: gauge("prisma_pool_connections_busy"),
        connectionsIdle: gauge("prisma_pool_connections_idle"),
        queriesWaitAvgMs: waitCount > 0 ? Math.round((waitSum / waitCount) * 100) / 100 : 0,
        queriesWaitCount: waitCount,
      };
    }
  } catch {
    // metrics preview feature unavailable — non-fatal
  }

  // Which configuration version this process is resolving against. Null means the
  // register defaults — nothing published yet, which is the Phase 1 state.
  const config = req.app?.locals?.config || null;

  res.json({
    server: "ok",
    redis: redisOk ? "ok" : "fail",
    db: dbOk ? "ok" : "fail",
    configVersion: config ? config.version : null,
    configRegisterDigest: config ? config.registerDigest : null,
    uptime: Math.floor(process.uptime()),
    eventLoopDelay: eventLoopMonitor.snapshot(),
    prismaPool,
    ...metrics,
  });
});

// Routes
app.use("/api", apiRoutes);

// 404 + error handler
app.use(notFound);
app.use(errorHandler);

module.exports = app;