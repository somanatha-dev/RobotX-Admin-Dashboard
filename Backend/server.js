const http = require("http");
const { Server } = require("socket.io");
const { createAdapter } = require("@socket.io/redis-adapter");
const Redis = require("ioredis");

require("./src/config/env");
require("./src/observability/eventLoopMonitor").start();

const app = require("./src/app");
const logger = require("./src/config/logger");
const { isOriginAllowed, tlsPosture } = require("./src/config/cors");
const { connectPrismaWithRetry, disconnectPrisma, runSerializable, selectForUpdate } = require("./src/db/prisma");
const { initKv } = require("./src/cache/kv");
const initSocketServer = require("./src/sockets/socket.server");
const { createVirtualRobotSimulator } = require("./src/simulation/SimulationEngine");
const { dispatchTaskAssign } = require("./src/services/commandDispatcher.service");
const { safeJsonParse } = require("./src/utils/json");
const { ensureAdminUser } = require("./src/services/adminBootstrap.service");
const configService = require("./src/engine/config/service");
// PHASE 13 — §19.3's single writer.
const election = require("./src/engine/shard/election");
const shardSupervisor = require("./src/workers/shardSupervisor.worker");
// §19.5's "full reconciliation before resuming rounds" is §12.4's sweep, injected into the
// supervisor's failover pass rather than re-implemented there. `failover.run()` refuses to
// run without it, and `election.promote()` refuses to grant commit permission without a
// completed result — so this import is what makes a leader able to run a round at all.
//
// The **engine module** `supervision/reconciler`, deliberately — never the worker that
// schedules it. Phase 0's scaffold guard forbids this file from naming the outbox, timer or
// reconciler worker modules at all, and it is right to: those three are `LEADER_ONLY`, and
// one wired into the bootstrap would be an engine write path reachable with the master
// switch off. What §19.5 needs here is the sweep function, not the loop that drives it.
const reconciler = require("./src/engine/supervision/reconciler");
const clock = require("./src/engine/commitment/clock");
// PHASE 14 — §23.2's periodic revocation check and §23.7's identity retention sweep.
const certificateRotation = require("./src/workers/certificateRotation.worker");
const auditStream = require("./src/engine/observability/auditStream");
// ── PHASE 15 — production scheduling ───────────────────────────────────────
// The plan's Phase 15 row: "All engine workers move from shadow to production
// scheduling." `src/workers/registry.js` is the list — what this process starts, what the
// shard supervisor starts on leadership acquisition, and what is deferred with the
// collaborator it is missing named. The registry, not this file, is the answer to "which
// workers run"; `startScheduledWorkers` below is only the wiring.
const workerRegistry = require("./src/workers/registry");
const invariantWorker = require("./src/workers/invariant.worker");
const tierBWorker = require("./src/workers/tierB.worker");
const rejectionAggregationWorker = require("./src/workers/rejectionAggregation.worker");
const calibrationWorker = require("./src/workers/calibration.worker");
const counterfactualWorker = require("./src/workers/counterfactual.worker");
const cutoverWorker = require("./src/workers/cutover.worker");
const cutoverStore = require("./src/engine/cutover/store");
const cutoverEnabled = require("./src/engine/cutover/enabled");
const sli = require("./src/engine/observability/sli");
const sampling = require("./src/engine/observability/sampling");
const rejectionTelemetry = require("./src/engine/feasibility/rejectionTelemetry");

/**
 * PHASE 15 — start the workers `src/workers/registry.js` marks `SCHEDULED`.
 *
 * Every handle is returned so shutdown can stop them; a worker whose interval outlives
 * the process's shutdown would keep a Prisma client alive past `disconnectPrisma()` and
 * turn a clean stop into a hang.
 *
 * The `LEADER_ONLY` workers (coordinator, outbox, reconciler, timer) are **not** started
 * here. §19.3 admits exactly one writer per shard, and a standby process that drained an
 * outbox or fired a timer would be a second one; they belong to the shard supervisor's
 * leadership lifecycle. Starting them at boot would be the single most dangerous line in
 * this file, so their absence is stated rather than left to be noticed.
 *
 * @param {{ prisma: object, kv: object, config: object, logger: object, io?: object }} context
 * @returns {{ handles: object[], running: string[] }}
 */
function startScheduledWorkers(context) {
  const { prisma, kv, config, logger: log, io } = context;
  const values = config && config.values;
  const seconds = (name) => {
    const value = values && typeof values.get === "function" ? values.get(name) : undefined;
    return Number.isFinite(value) ? value : undefined;
  };
  const parameter = (name) => (values && typeof values.get === "function" ? values.get(name) : undefined);

  const registry = sli.createRegistry();
  const budget = sampling.createBudget({
    perShardBudget: values && values.get ? values.get("observability.tier_b_write_budget") : undefined,
  });
  const aggregator = rejectionTelemetry.createAggregator();

  const onError = (workerId) => (error) =>
    log.error("Engine worker tick failed", { worker: workerId, message: error && error.message });

  const handles = [];
  const running = [];
  const started = (id, handle) => {
    handles.push(handle);
    running.push(id);
  };

  // ── PHASE 12 — the invariant checker, its mode sweep, and §18.6's chain ─────
  //
  // Three dependencies this call used to omit, each of which silently disabled a Phase 12
  // deliverable rather than failing:
  //
  //   · `kv` — without it `transitions.publishAdvisory()` returns "no advisory cache
  //     configured" and `engine:mode:{shard}`, the one Redis key §18.5's plan row reserves,
  //     is never written. The durable `DegradedModeEvent` stream remains the authority
  //     either way (§3.3); what was lost is the mirror every reader polls instead of it.
  //   · `emit` — the worker builds `INVARIANT_STATUS_CHANGED` and `STRANDING_ESCALATED`
  //     payloads and returns them. Nothing called `socketMessages()`, so both events had a
  //     producer and no wire. The worker still takes no Socket.IO dependency: this is a
  //     function, and the room is chosen here.
  //   · the check context — `invariant.monotonicity_window`, §17.4's ladder budget and the
  //     energy tier budgets. Two checks (I4, I13) reported `VIOLATED` on a healthy fleet
  //     without them and four audited shadow decisions as production; the worker now derives
  //     what it can and reports the rest as *unverified* rather than clean, so an omission
  //     here shows up as an incomplete register instead of a false page.
  started(
    "invariant",
    invariantWorker.start(
      {
        prisma,
        kv,
        emit: async (message) => {
          if (!io) return;
          try {
            io.to("dashboard").emit(message.event, message.payload);
          } catch (error) {
            // An emit that fails costs visibility, never correctness — the durable
            // `InvariantStatus` and `ExternalEscalation` rows are the authority and the two
            // REST surfaces read them. It must not take the checker's tick down.
            log.warn("Invariant worker socket emit failed", { event: message.event, message: error && error.message });
          }
        },
        onError: onError("invariant"),
      },
      {
        shardId: process.env.SHARD_ID || "default",
        checkIntervalSeconds: seconds("invariant.check_interval"),
        windowMs: seconds("invariant.monotonicity_window") ? seconds("invariant.monotonicity_window") * 1000 : undefined,
        // §17.4's ladder is invoked at `sla.assignment_deadline` ("how long work may remain
        // unassigned before the §17.4 anti-starvation ladder is invoked"), so an entry older
        // than it that no round has ever considered is not on the ladder — which is exactly
        // I13's failure case. The ladder's own step budgets are §17.4's phase, not this one's.
        ladderBudgetSeconds: seconds("sla.assignment_deadline"),
        tierEventBudgets: parameter("energy.event_budget_per_fleet_year"),
        maxAgeSeconds: seconds("map.obstruction_class_max_age"),
        escalationContacts: parameter("ops.external_escalation_contacts"),
        contactReviewPeriodSeconds: seconds("ops.escalation_contact_review_period"),
        emergencyServicesThreshold: parameter("ops.emergency_services_hazard_threshold"),
      },
    ),
  );

  started(
    "tier_b",
    tierBWorker.start({ prisma, budget, registry, onError: onError("tier_b") }, {}),
  );

  started(
    "rejection_aggregation",
    rejectionAggregationWorker.start({ prisma, aggregator, onError: onError("rejection_aggregation") }, {}),
  );

  started(
    "calibration",
    calibrationWorker.start(
      { prisma, config, registry, onError: onError("calibration") },
      { shardId: process.env.SHARD_ID || "default" },
    ),
  );

  started(
    "counterfactual",
    counterfactualWorker.start(
      { prisma, registry, onError: onError("counterfactual") },
      { shardId: process.env.SHARD_ID || "default" },
    ),
  );

  // The staged-rollout controller. It reads the pre-declaration back out of the audit
  // stream (`cutover/store.js`) rather than holding its own copy, publishes a reverted
  // binding on regression, and may only ever disable — `guardrails.assertOneDirectional`
  // throws on anything else.
  started(
    "cutover",
    cutoverWorker.start(
      {
        liveShards: () => cutoverStore.liveShards({ prisma }, { snapshot: config }),
        declarationFor: (shardId) => cutoverStore.declarationFor({ prisma }, shardId),
        observationsFor: (shardId, declaration) => {
          const endedAtMs = Date.now();
          return cutoverStore.observationsFor({ kv }, shardId, declaration, {
            windowStartedAtMs: declaration.declaredAtMs,
            windowEndedAtMs: endedAtMs,
          });
        },
        publish: async (action) => {
          // Deliberately not a config publish from inside the controller: publishing is
          // an approved, versioned operation (§22.1 rule 4) and the automatic path may
          // only *disable*. The binding is recorded and the shard's live check fails
          // closed on the next pass; the runbook's step 6 is what makes it permanent.
          log.error("AUTOMATIC ROLLBACK — a staged shard regressed against its pre-declared SLI guardrails", {
            shardId: action.shardId,
            regionId: action.regionId,
            reason: action.reason,
            consequence: action.consequence,
          });
        },
        audit: (event) => auditStream.append({ prisma }, event),
        onError: onError("cutover"),
      },
      { checkIntervalSeconds: seconds("cutover.guardrail_check_interval") },
    ),
  );

  const summary = workerRegistry.report({ running });
  log.info("Engine workers scheduled (§15 production scheduling)", {
    running: running.length,
    leaderOnly: summary.leaderOnly,
    deferred: summary.deferred,
  });

  return { handles, running };
}

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

  // `app.locals` by reference, not `app.locals.config` by value: the agent handlers read
  // the snapshot at call time, so a republished configuration reaches an already-connected
  // socket (P14-R1).
  initSocketServer(io, { prisma, kv, logger, appLocals: app.locals });

  // Ensure the admin user exists (idempotent — safe to run on every start).
  try {
    await ensureAdminUser(prisma, { logger });
  } catch (e) {
    logger.warn("Admin bootstrap skipped", { message: e?.message });
  }

  // ── PHASE 15 — the boot-time task recovery pass is gone ───────────────────
  //
  // `taskRecovery.service.js` ran here and rebuilt Redis task/path state after a restart.
  // The plan retires it: what it did is §12.4 row 3 restricted to exactly one trigger, and
  // §12.1 states why that restriction is the defect rather than the design — "no component
  // is responsible for noticing that a state has stopped progressing. Patching each trigger
  // individually leaves the seventh undiscovered." `supervision/reconciler.js`'s orphan scan
  // is the trigger-independent version, driven continuously by `reconciler.worker.js` under
  // the shard leader rather than once at boot. Nothing replaces this call site because the
  // replacement is not a call site.

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

  // ─────────────────────────────────────────────────────────────────────────
  // PHASE 13 — the coordinator lifecycle (§19.3, §19.5).
  //
  // Exactly one active Coordinator per shard, chosen by leader election with a fenced
  // lease from a consensus-backed store. This process stands for election, renews, runs
  // §19.5's reconciliation on acquisition, and releases on shutdown.
  //
  // ── Why it is gated, and what the gate means after Phase 15 ──────────────
  // The gate is `ENGINE_ENABLED`, the **process** half of the cutover switch. It answers
  // "does this process participate in the engine at all". The second half —
  // `cutover.engine_enabled`, resolved per shard — decides which shards the engine is the
  // decision path for, and `engine/cutover/enabled.js` owns the conjunction.
  //
  // With the legacy dispatcher removed from the build at Phase 15, a false gate no longer
  // means "the old path serves this fleet". It means this process runs no round, drains no
  // outbox, and starts no supervisor. See `docs/runbooks/rollback.md`.
  //
  // ── B3 is not decided here ───────────────────────────────────────────────
  // The consensus store is constructed from a **declared replication posture**
  // (`SHARD_CONSENSUS_REPLICATION`), and `election.assertConsensusStore` refuses anything
  // that does not declare the guarantee §19.5 requires. An undeclared posture therefore
  // fails loudly at boot rather than electing a leader over a store that cannot fence one.
  // Swapping in an etcd or Consul adapter is a change to this construction and to nothing
  // else.
  // ─────────────────────────────────────────────────────────────────────────
  // ─────────────────────────────────────────────────────────────────────────
  // PHASE 14 — §23.2's TLS posture, declared at boot.
  //
  // The process does not terminate mutual TLS itself: a deployment terminates at a load
  // balancer that forwards the validated peer certificate, or runs an HTTPS listener with
  // `requestCert: true` in front of this app. What the application owes is to say which
  // posture it believes it is in, once, at startup — because the failure this line exists
  // to prevent is a deployment that believes mTLS is enforced while agents connect
  // unauthenticated, and that failure is silent by nature.
  // ─────────────────────────────────────────────────────────────────────────
  const posture = tlsPosture();
  logger.info("Agent transport security posture (§23.2)", posture);

  let shardCoordinator = null;
  let certificateWorker = null;
  let engineWorkers = { handles: [], running: [] };
  const engineEnabled = cutoverEnabled.processEnabled();
  if (engineEnabled) {
    try {
      const store = election.postgresLeadershipStore(prisma, {
        replicationPosture: process.env.SHARD_CONSENSUS_REPLICATION,
      });
      election.assertConsensusStore(store);

      // ── The supervisor's dependency contract, satisfied in full ────────────
      //
      // The supervisor's `start()` documents seven dependencies. Supplying only some of
      // them does not degrade the supervisor — it kills it, silently, because every tick
      // throws inside `runOnce()` and `start()`'s `.catch` deliberately swallows the
      // throw so one lost renewal cannot take the process down. The session variable is
      // then never reassigned, so the loop re-enters as a follower forever:
      //
      //   · without `leaseDurationSeconds`, `tryAcquire` throws a RangeError from
      //     `clock.deadlineFrom` and **no leader is ever elected at all**;
      //   · without `reconcile`, `failover.run()` throws by design (§19.5) and
      //     `election.promote()` is never reached, so `mayCommit` stays false and the
      //     shard never resumes rounds;
      //   · without `runSerializable`/`selectForUpdate`, `membership.migrate()` cannot
      //     take the agent row under the lock the commit path takes, so no migration
      //     can execute.
      //
      // Each of those is a single missing key, and each disables a Phase 13 completion
      // criterion outright. They are listed here rather than left to a reader to
      // reconstruct because the failure mode is a supervisor that logs a tick error and
      // otherwise looks alive.
      const parameterValue = (name) => {
        const values = app.locals.config && app.locals.config.values;
        return values && typeof values.get === "function" ? values.get(name) : undefined;
      };
      const finite = (name) => {
        const value = parameterValue(name);
        return Number.isFinite(value) ? value : undefined;
      };

      shardCoordinator = shardSupervisor.start(
        {
          prisma,
          kv,
          store,
          runSerializable,
          selectForUpdate,
          // §19.5's reconciliation, bound to the same sweep `reconciler.worker.js` drives.
          // One implementation of a requeue, one set of §4.5 timer obligations attached to
          // it — which is the reason `failover.js` takes this injected rather than
          // importing it.
          //
          // ── The sweep's own configuration, which is not optional ─────────
          // `failover.run()` passes this callback `{ ...reconcileConfig, shardId }`, and
          // nothing supplied a `reconcileConfig`. The sweep then ran with three of its four
          // inputs undefined, and undefined is not neutral here:
          //
          //   · `assignmentDeadlineSeconds` reaches `timers.deadlineFrom()` inside the
          //     orphan requeue, which **throws** on a non-positive duration — so §19.5's
          //     reconciliation died on the first Leg it had to reconstruct, which is the
          //     one case a failover exists for. Same swallow, same follower loop, same
          //     invisible failure as P13-R1 and P13-R2;
          //   · the same value is `scanWaitingTasks`'s SLA, and `age <= undefined` is
          //     false, so **every** WAITING Task with no queue entry was repaired and
          //     escalated on the first sweep — §12.4's repair rate is an alertable SLI, and
          //     that is a false alert on every deployment;
          //   · `unresponsiveStrikes` decides whether an undelivered outbox row escalates.
          //
          // Each is a registered parameter that resolves. `energyDeviationTolerance` is
          // supplied for completeness; its scan skips anyway, because no energy model is
          // injected here and it says so rather than guessing.
          reconcile: (sweepConfig) =>
            reconciler.sweep(
              {
                prisma,
                runInTransaction: (fn) => runSerializable(prisma, fn),
                readStoreTime: () => clock.readStoreTime(prisma),
              },
              {
                assignmentDeadlineSeconds: finite("sla.assignment_deadline"),
                unresponsiveStrikes: finite("health.unresponsive_strikes"),
                energyDeviationTolerance: finite("energy.deviation_tolerance"),
                ...sweepConfig,
              },
            ),
          onError: (e) => logger.error("Shard supervisor tick failed", { message: e?.message }),
        },
        {
          shardId: process.env.SHARD_ID || "default",
          // The candidate identity must be unique per process and stable across a tick.
          // Host plus pid is both, and it is what a `holder` column is read for during an
          // incident.
          candidateId: `${process.env.HOSTNAME || host}:${process.pid}`,
          // §19.5's margin, from the register rather than from a literal here. Validator A4
          // checks these four are mutually satisfiable at publish; this is where the
          // publish-time check becomes a runtime behaviour. Units are the register's:
          // `shard.lease_duration` is seconds, the other three are milliseconds.
          leaseDurationSeconds: finite("shard.lease_duration"),
          intervalMs: finite("shard.renewal_interval"),
          maxClockSkewMillis: finite("time.max_clock_skew"),
          storeRoundTripMillis: finite("shard.store_round_trip_budget"),
          // §19.2's pacing, for the migration pass.
          minIntervalMs: finite("shard.migration_min_interval"),
          // §3.5's two sizing bounds. Without these the `sizingPass` evaluated neither and
          // wrote `NEITHER_EVALUATED` to `Shard.bindingBound` on every tick — so the phase's
          // completion criterion "both sizing bounds monitored with the binding one
          // reported" was unmet on every deployment, and `GET /api/shards` reported the
          // leader's verdict as unevaluated beside a live arithmetic that was not.
          //
          // Bound 2 (serial commit) is arithmetic over these four registered parameters and
          // the observed membership count, so it evaluates from here. Bound 1 (round
          // wall-clock) is a **measurement**, and no producer for it exists yet — the
          // supervisor is given no `measurement`, and `sizing.js` reports an unmeasured
          // bound as unevaluated rather than as satisfied. That gap is recorded as H6 and
          // is the round loop's to close, not this file's: fabricating a number here would
          // turn "we have not measured this" into a confident wrong answer.
          config: {
            missionRatePerAgentHour: finite("shard.mission_rate_per_agent_hour"),
            txnPerMissionLifecycle: finite("shard.txn_per_mission_lifecycle"),
            commitTxnServiceTimeMs: finite("shard.commit_txn_service_time"),
            maxSerialUtilisation: finite("commit.max_serial_utilisation"),
            roundWallClockBudgetMs: finite("perf.round_wall_clock_p99"),
          },
          // §11.1 / §23.3 — what the migration pass needs to enqueue a `SHARD_MIGRATE`.
          // `membership.migrate()` signs the command and stamps a `not_valid_after` inside
          // the handoff transaction; `commandSigning.sign` refuses an absent key and
          // `clock.deadlineFrom` refuses an absent TTL, both by throwing, so neither had a
          // producer and the first executed move would have thrown into the tick swallow.
          //
          // The key is an operator-declared deployment secret, read the same way
          // `SHARD_CONSENSUS_REPLICATION` is: the code will not invent one. Absent, the
          // migration pass reports `NO_COMMAND_CREDENTIALS` and
          // `POST /api/shards/:id/rebalance` refuses to record an intent at all, so no
          // shard is taken out of service for a plan that cannot be executed.
          commandTtlSeconds: finite("dispatch.offer_ttl"),
          signingKey: process.env.COMMAND_SIGNING_KEY,
          // The plan's Phase 13 Socket.IO row names `SHARD_LEADERSHIP_CHANGED` and
          // `SHARD_MIGRATED`. The worker builds them and returns them — it takes no
          // Socket.IO dependency, matching every engine worker since Phase 4 — so the room
          // is chosen here. Without this, both events had a producer and no wire, which is
          // the same omission Phase 15 recorded for the invariant worker's two events.
          //
          // `SHARD_MIGRATE` is deliberately NOT here: it is an agent-scope command and
          // reaches its agent through the outbox and the drain worker (§11.1), never
          // through a broadcast.
          onTick: (tick) => {
            if (!io) return;
            for (const message of shardSupervisor.socketMessages(tick)) {
              try {
                io.to("dashboard").emit(message.event, message.payload);
              } catch (error) {
                // An emit that fails costs visibility, never correctness — the durable
                // `ShardLeadership` and `ShardMembership` rows are the authority, and
                // `GET /api/shards` and `/health` read them. It must not take the tick down.
                logger.warn("Shard supervisor socket emit failed", { event: message.event, message: error?.message });
              }
            }
          },
        },
      );
      logger.info("Shard coordinator standing for election", { shardId: process.env.SHARD_ID || "default" });

      // §23.2's periodic revocation check and §23.7's identity retention sweep. The
      // verdicts come back here rather than being applied inside the worker: the socket
      // that must be closed may be owned by a different process, which is a fact only the
      // holder of the Socket.IO adapter knows.
      certificateWorker = certificateRotation.start(
        {
          prisma,
          audit: (tx, event) => auditStream.append({ prisma: tx }, event),
          // PHASE 14 remediation (P14-R11) — the live bindings this process holds.
          //
          // This was `async () => []`, so the worker's revocation pass examined nothing
          // and §23.2's "periodically during long sessions" rested entirely on the
          // per-socket re-check in `robot.handler.js`'s heartbeat. That covers an agent
          // that is *sending heartbeats*; it does not cover one that has gone quiet with
          // the socket still open, which is the case a periodic sweep exists for.
          //
          // Only this process's sockets, deliberately: the sweep terminates by closing a
          // socket, and a socket owned by another process is one this process cannot
          // close. Each process sweeping its own is what makes the coverage complete
          // without a cross-process command.
          sessions: async ({ limit } = {}) => {
            const live = [];
            try {
              for (const socket of io.sockets.sockets.values()) {
                const binding = socket.data && socket.data.certificateBinding;
                if (binding) live.push(binding);
                if (Number.isFinite(limit) && live.length >= limit) break;
              }
            } catch { /* an adapter that cannot enumerate yields nothing, never a wrong answer */ }
            return live;
          },
          onTerminate: (sessions) => {
            for (const session of sessions) {
              logger.warn("Agent session terminated by the periodic revocation check (§23.2)", session);
              try { io.in(`robot:${session.agentId}`).disconnectSockets(true); } catch { /* best effort */ }
            }
          },
          // §23.6 — "neither punitive by default". The finding is logged with its own
          // interpretation and nothing is done to the operator or the constraint (P14-R6).
          onOverrideRateFinding: (findings) => {
            for (const finding of findings) {
              logger.warn("Override rate threshold crossed (§23.6 design signal)", finding);
            }
          },
          onError: (e) => logger.error("Certificate rotation tick failed", { message: e?.message }),
        },
        {
          recheckIntervalSeconds: app.locals.config?.values?.get?.("security.certificate_revocation_recheck_interval"),
          rotationLeadTimeSeconds: app.locals.config?.values?.get?.("security.certificate_rotation_lead_time"),
          overrideRateWindowSeconds: app.locals.config?.values?.get?.("security.override_rate_window"),
          overrideRateThresholdPerOperator: app.locals.config?.values?.get?.("security.override_rate_threshold_per_operator"),
          overrideRateThresholdPerPredicate: app.locals.config?.values?.get?.("security.override_rate_threshold_per_predicate"),
        },
      );
    } catch (e) {
      // A process that cannot elect safely must not serve as a coordinator, and §19.5's
      // prohibition is not something to warn about and continue past.
      logger.error("Shard coordinator refused to start", { message: e?.message });
      throw e;
    }

    // PHASE 15 — the rest of the registry's `SCHEDULED` set. Started after the supervisor
    // and inside the same gate: a process that is not participating in the engine has
    // nothing for an invariant checker to check or a reservoir to drain.
    engineWorkers = startScheduledWorkers({ prisma, kv, config: app.locals.config, logger, io });
  } else {
    logger.info(
      "Engine workers not started: ENGINE_ENABLED is not true for this process. " +
        "The legacy dispatcher was removed from the build at Phase 15 and is not a fallback — " +
        "see docs/runbooks/rollback.md.",
      { registry: workerRegistry.report({ running: [] }) },
    );
  }

  const shutdown = async (signal) => {
    try {
      logger.warn(`Shutdown received (${signal}) — draining connections…`);
      try { virtualSimulator?.stop?.(); } catch { /* ignore */ }
      try { certificateWorker?.stop?.(); } catch { /* ignore */ }
      for (const handle of engineWorkers.handles) {
        try { handle.stop(); } catch { /* ignore */ }
      }

      // §19.3's availability argument, discharged: releasing advances the leadership fence,
      // so the standby takes the shard immediately instead of waiting a full
      // `shard.lease_duration` for a lease nobody is renewing to lapse — and this process
      // is fenced at the store the moment it lets go, so a command still in flight inside
      // it aborts at guard G1 rather than racing the new leader.
      //
      // Best-effort: a release that fails costs one lease duration of failover latency and
      // nothing else, because the lease lapses on its own and G1 fences this process
      // either way. It must not be allowed to hang a shutdown.
      if (shardCoordinator) {
        try {
          shardCoordinator.stop();
          const outcome = await shardSupervisor.drain(
            { store: election.postgresLeadershipStore(prisma, { replicationPosture: process.env.SHARD_CONSENSUS_REPLICATION }) },
            shardCoordinator.session(),
            { storeTime: new Date() },
          );
          logger.warn("Shard leadership released", { released: outcome.released, refusal: outcome.refusal });
        } catch (e) {
          logger.warn("Shard leadership release failed — the lease will lapse and G1 fences this process either way", {
            message: e?.message,
          });
        }
      }

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