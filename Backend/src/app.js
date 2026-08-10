const express = require("express");
const cookieParser = require("cookie-parser");
const cors = require("cors");
const helmet = require("helmet");
const logger = require("./config/logger");
const { corsOriginDelegate } = require("./config/cors");
const { getSystemMetrics, getSliSummary } = require("./services/metrics.service");
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
  // Direct visibility into pool contention — the thing
  // docs/history/legacy-scale-architecture.md and the first benchmark run
  // could only infer indirectly from latency.
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

  // PHASE 11 — §20.1's release-gate targets, summarised. Deliberately the *summary* and
  // not the §21.4 derivation: `/health` is polled on a short interval by monitoring, and
  // running the full metric set here would put its cost on the availability path. The
  // full set is derived off the request path by `metrics.service.getEngineMetrics`.
  //
  // Best-effort like every other block on this route: a null `sli` means the SLI tier
  // could not be read, which costs visibility and never availability (§3.3).
  let sli = null;
  try {
    sli = await getSliSummary(
      { kv },
      { shardId: req.query?.shard ? String(req.query.shard) : "default", config: config ? { get: (name) => config.resolve(name) } : null },
    );
  } catch {
    sli = null;
  }

  // PHASE 12 — §18.5's mode register and §26's invariant register, summarised.
  //
  // Two counts and a mode list, not the registers themselves: `/api/health/modes` and
  // `/api/health/invariants` carry the detail behind authentication, and this route is a
  // liveness probe that infrastructure polls on a short interval. What belongs here is the
  // single fact a probe can act on — this shard is degraded, and these are the guarantees
  // it is currently not making — because a process that is "up" while its shard has
  // suspended an invariant is not, for any purpose a load balancer cares about, healthy.
  //
  // Best-effort like every other block on this route. A null `degraded` means the register
  // could not be read, which costs visibility and never availability (§3.3).
  let degraded = null;
  try {
    if (prisma) {
      const shardId = req.query?.shard ? String(req.query.shard) : "default";
      const open = await prisma.degradedModeEvent.findMany({
        where: { shardId, exitedAt: null },
        select: { mode: true, enteredAt: true, suspendedInvariants: true, timeBoxExpiresAt: true },
      });
      const statuses = await prisma.invariantStatus.groupBy({
        by: ["status"],
        where: { shardId, subjectType: "SHARD" },
        _count: { _all: true },
      });
      const byStatus = Object.fromEntries(statuses.map((row) => [row.status, Number(row._count._all || 0)]));
      degraded = {
        shardId,
        modes: open.map((row) => row.mode),
        // Empty is a real answer and is reported as such: "suspended nothing" and "nobody
        // wrote it down" are different states, and §18.5 rule 1 keeps them apart.
        suspendedInvariants: [...new Set(open.flatMap((row) => row.suspendedInvariants || []))].sort(),
        invariants: {
          enforced: byStatus.ENFORCED || 0,
          violated: byStatus.VIOLATED || 0,
          suspended: byStatus.SUSPENDED || 0,
        },
      };
    }
  } catch {
    degraded = null;
  }

  // PHASE 13 — §3.5's shard model and §19.3's single writer, summarised.
  //
  // Three facts and no detail: how many shards exist, whether this one is led, and whether
  // its rounds have resumed since the last leadership change (§19.5). `/api/shards` carries
  // the topology, the memberships, and both sizing bounds behind authentication; what
  // belongs on an unauthenticated liveness probe is the single fact a probe can act on —
  // this shard has no active coordinator, or has one that has not finished reconciling —
  // because a process that is "up" while its shard has no writer is not, for any purpose a
  // load balancer cares about, serving.
  //
  // Deliberately reads the **durable leadership row**, not `engine:shard:leader:{shard}`.
  // That key is an advisory mirror (§3.3), and a health probe answering from a cache would
  // report a dead coordinator as leading for the mirror's whole TTL.
  //
  // Best-effort like every other block on this route. A null `shard` means the model could
  // not be read, which costs visibility and never availability.
  let shard = null;
  try {
    if (prisma) {
      const shardId = req.query?.shard ? String(req.query.shard) : "default";
      const [record, row, shardCount] = await Promise.all([
        prisma.shardLeadership.findUnique({
          where: { shardId },
          select: { holder: true, leaseExpiry: true, leadershipFence: true },
        }),
        prisma.shard.findUnique({
          where: { shardId },
          select: { state: true, agentCount: true, bindingBound: true, roundsResumableAt: true },
        }),
        prisma.shard.count(),
      ]);
      shard = {
        shardId,
        // Zero means no shard definition has been published, which is the single-shard
        // deployment rather than a fleet with no shards. Named as such below.
        shardCount,
        singleShardDeployment: shardCount === 0,
        state: row ? row.state : null,
        agentCount: row ? row.agentCount : null,
        bindingBound: row ? row.bindingBound : null,
        led: Boolean(record && record.holder),
        // The holder's identity is deliberately absent: this route is unauthenticated, and
        // which process leads a shard is operational detail rather than a liveness signal.
        // `/api/shards` carries it.
        leaseValid: Boolean(record && record.leaseExpiry && new Date(record.leaseExpiry).getTime() > Date.now()),
        leadershipFence: record ? String(record.leadershipFence) : null,
        // §19.5 — "the new leader runs a full reconciliation of the shard before resuming
        // rounds". Null is a shard whose leader has not finished; it is a real and
        // temporary state, and it is not the same as unled.
        roundsResumable: row ? row.roundsResumableAt !== null : null,
      };
    }
  } catch {
    shard = null;
  }

  res.json({
    server: "ok",
    redis: redisOk ? "ok" : "fail",
    db: dbOk ? "ok" : "fail",
    degraded,
    shard,
    configVersion: config ? config.version : null,
    configRegisterDigest: config ? config.registerDigest : null,
    uptime: Math.floor(process.uptime()),
    eventLoopDelay: eventLoopMonitor.snapshot(),
    prismaPool,
    sli,
    ...metrics,
  });
});

// Routes
app.use("/api", apiRoutes);

// 404 + error handler
app.use(notFound);
app.use(errorHandler);

module.exports = app;