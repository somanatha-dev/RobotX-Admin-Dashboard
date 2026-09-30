const http = require("http");
const { Server } = require("socket.io");
const { createAdapter } = require("@socket.io/redis-adapter");
const Redis = require("ioredis");

require("./src/config/env");
require("./src/observability/eventLoopMonitor").start();

const app = require("./src/app");
const logger = require("./src/config/logger");
const { isOriginAllowed, tlsPosture } = require("./src/config/cors");
const {
  connectPrismaWithRetry,
  disconnectPrisma,
  runSerializable,
  selectForUpdate,
  isSerializationFailure,
} = require("./src/db/prisma");
const { initKv } = require("./src/cache/kv");
const initSocketServer = require("./src/sockets/socket.server");
const { createVirtualRobotSimulator } = require("./src/simulation/SimulationEngine");
const simulationPolicy = require("./src/simulation/simulationPolicy");
const { rehydrateSimulatedRobots } = require("./src/simulation/rehydrate");
const { dispatchTaskAssign, outboxDeliveryArm: dispatchOutboxCommand } = require("./src/services/commandDispatcher.service");
const agentProbe = require("./src/services/agentProbe.service");
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
// PHASE 15 remediation (D-5) — the shard supervisor's promotion hook. The registry marks
// four workers `LEADER_ONLY` ("started and stopped by the shard supervisor rather than at
// boot"), and until this remediation nothing started them: this file said they belonged to
// the leadership lifecycle and `shardSupervisor.worker.js` had no such hook. `leaderWorkers`
// is that hook. It starts the two whose dependency contracts a production producer can
// satisfy and **refuses the other two by name**, because a coordinator composed against a
// fabricated router or a timer worker composed against an empty handler map would run,
// report success, and decide nothing.
const leaderWorkers = require("./src/workers/leaderWorkers");
const invariantWorker = require("./src/workers/invariant.worker");
const tierBWorker = require("./src/workers/tierB.worker");
const rejectionAggregationWorker = require("./src/workers/rejectionAggregation.worker");
const calibrationWorker = require("./src/workers/calibration.worker");
const counterfactualWorker = require("./src/workers/counterfactual.worker");
const cutoverWorker = require("./src/workers/cutover.worker");
// REMEDIAL PHASE T1-04 — §17.5's agent-starvation detector. The ladder and its capacity
// model are driven by the LEADER_ONLY timer worker through §4.3's `ESCALATION_LADDER`;
// this is the third module, whose signal is an absence and therefore needs a tick.
const fairnessWorker = require("./src/workers/fairness.worker");
// BATCH 2 — §6.2's availability index maintainer, and the charging classifier it was
// blocked on. The worker's registry row moved DEFERRED → SCHEDULED because that classifier
// now exists; `src/workers/registry.js` records what that does and does not claim.
const indexMaintainer = require("./src/workers/indexMaintainer.worker");
const chargingStatus = require("./src/services/chargingStatus.service");
const v1DemonstrationComposition = require("./src/services/v1DemonstrationComposition");
// P1 — the fleet provider boundary: one seam set for simulated and physical agents, selected
// by `FLEET_PROVIDER_DISPATCH=true` (default off: the composition above, exactly as before).
const fleetProviders = require("./src/services/fleetProviders");
const cutoverStore = require("./src/engine/cutover/store");
const cutoverEnabled = require("./src/engine/cutover/enabled");
const privacyKeys = require("./src/config/privacyKeys");
// PHASE 15 remediation — the two halves of the cutover switch that had no production
// producer: the pull that lets a published binding reach a running process (P15-R2), and
// the publish that makes §22.4 item 4's automatic rollback take effect (P15-R1).
const configPropagation = require("./src/engine/cutover/configPropagation");
const rollbackPublisher = require("./src/engine/cutover/rollbackPublisher");
// PHASE 15 remediation (P15-R3) — the shard's open degraded modes, which decide whether
// §18.5 permits a command to be delivered at all.
const degradedTransitions = require("./src/engine/degraded/transitions");
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
  /**
   * The configuration version in force **now**, for the readers that must not be pinned to
   * boot (P15-R2). Worker *cadences* below are deliberately still resolved once, from
   * `values`: an interval is a property of the timer this call creates, and changing one
   * means restarting the worker rather than reading a different number on the next tick.
   */
  const snapshotOf = () => (typeof context.snapshotOf === "function" ? context.snapshotOf() : config);
  const seconds = (name) => {
    const value = values && typeof values.get === "function" ? values.get(name) : undefined;
    return Number.isFinite(value) ? value : undefined;
  };
  const parameter = (name) => (values && typeof values.get === "function" ? values.get(name) : undefined);

  const registry = sli.createRegistry();
  const budget = sampling.createBudget({
    perShardBudget: values && values.get ? values.get("observability.tier_b_write_budget") : undefined,
  });
  // §7.7's aggregator: the one the coordinator's feasibility gate folds into (passed in by
  // the engine block, which also hands it to `leaderWorkers.create`), so the flusher below
  // drains what the rounds recorded. A fresh one here would be drained forever empty.
  const aggregator = context.rejectionAggregator || rejectionTelemetry.createAggregator();

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
    // The shard this process's aggregator belongs to. Without it the near-miss sketch half of
    // every flush threw (`NearMissSketch` is keyed on shardId, and a null in its compound
    // unique is refused by the client), so each flush after the first rejection failed.
    rejectionAggregationWorker.start(
      { prisma, aggregator, onError: onError("rejection_aggregation") },
      { shardId: process.env.SHARD_ID || "default" },
    ),
  );

  // ── REMEDIAL PHASE T1-04 — §17.5's agent-starvation detector ───────────────
  //
  // The one T1-04 module with no deadline behind it. §17.4's ladder and its capacity
  // model are reached through `ESCALATION_LADDER`, §4.3's expiry action for `QUEUED`, so
  // the LEADER_ONLY timer worker is their runtime caller. §17.5's detection is a statement
  // about an absence over a window — "zero completed missions in `fairness.idle_alert_period`
  // while nominally available" — which nothing announces, so it needs a tick.
  //
  // `start` throws rather than defaulting when the period does not resolve, so this is
  // guarded here for the same reason every other cadence is: a worker that cannot be
  // configured is reported as not running, not started on a number nobody published.
  const idleAlertPeriodHours = seconds("fairness.idle_alert_period");
  if (Number.isFinite(idleAlertPeriodHours) && idleAlertPeriodHours > 0) {
    started(
      "fairness",
      fairnessWorker.start(
        {
          prisma,
          regionId: context.regionId || null,
          idleAlertPeriodHours,
          record: (event, detail) => log.info("Fairness (§17.5)", { event, ...detail }),
          onError: onError("fairness"),
        },
        {},
      ),
    );
  } else {
    log.error("§17.5's agent-starvation detector is NOT running", {
      worker: "fairness",
      blockedBy:
        "fairness.idle_alert_period did not resolve, so the detector has neither a window nor a cadence. An idle " +
        "fleet will not be reported until it is published.",
    });
  }

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
  // PHASE 15 remediation (P15-R1) — the publisher that makes an automatic rollback a
  // rollback. See `engine/cutover/rollbackPublisher.js` for the whole argument, including
  // why an automated publish of *this* parameter is the one §22.3 permits.
  const rollback = rollbackPublisher.create({
    // PHASE 15 remediation (P15-E2) — the version **in force**, not the latest published.
    //
    // This was `findFirst({ orderBy: { version: "desc" } })`, which is the highest-numbered
    // published version. That is the version in force only while nobody has published one
    // without pinning it — and `config.controller.publishVersion` pins only
    // `if (body.pin !== false)`, so an unpinned candidate awaiting review is a supported and
    // ordinary state. In it, one automatic rollback carried the candidate's whole payload
    // forward and **pinned** it: an unreviewed configuration put into force fleet-wide by the
    // one control whose licence to run without a human is that it may only disable one shard.
    //
    // The reader now lives in `cutover/rollbackPublisher.js` beside the contract it satisfies,
    // so there is one implementation of "which version is in force" rather than a composition
    // root quietly disagreeing with the module it composes. See that function's header.
    versionInForce: () => rollbackPublisher.versionInForceReader({ prisma }),
    publish: (request) => configService.publish(prisma, request),
    pin: (version, publishedBy) => configService.pinVersion(prisma, kv, version, publishedBy),
    record: (event, detail) => log.warn(`cutover.${event}`, detail),
  });

  started(
    "cutover",
    cutoverWorker.start(
      {
        // PHASE 15 remediation (P15-R2) — the snapshot at call time, not at boot. A
        // controller reading the version this process started on would go on assessing a
        // shard that had since been rolled back, and would stop assessing one that had
        // since been staged.
        liveShards: () => cutoverStore.liveShards({ prisma }, { snapshot: snapshotOf() }),
        declarationFor: (shardId) => cutoverStore.declarationFor({ prisma }, shardId),
        observationsFor: (shardId, declaration) => {
          const endedAtMs = Date.now();
          return cutoverStore.observationsFor({ kv }, shardId, declaration, {
            windowStartedAtMs: declaration.declaredAtMs,
            windowEndedAtMs: endedAtMs,
          });
        },
        publish: async (action) => {
          // ── PHASE 15 remediation (P15-R1) ────────────────────────────────
          //
          // This callback used to log and return. The comment justifying that read:
          // "Deliberately not a config publish from inside the controller: publishing is an
          // approved, versioned operation (§22.1 rule 4) and the automatic path may only
          // *disable*. The binding is recorded and the shard's live check fails closed on
          // the next pass; the runbook's step 6 is what makes it permanent."
          //
          // Both of its factual claims were false. The binding was recorded **only** in the
          // audit event's payload, which nothing reads for that purpose; and the shard's
          // live check resolves `cutover.engine_enabled` from the published snapshot, which
          // was untouched — so the shard stayed live. Worse, `cutover/store.declarationFor`
          // returns null once the latest cutover event is a rollback, so the *next* pass
          // reported the shard as "live with no pre-declared guardrails" and never assessed
          // it again. A breaching shard was left running and permanently unguarded by the
          // control that exists to stop it.
          //
          // And its premise was false too: `cutover.engine_enabled` is classified STRUCTURAL
          // rather than SAFETY, and the register entry says in its own words that this is
          // "on purpose … the automatic rollback of §22.4 item 4 must be able to set this
          // false". The publish is what the change class was chosen for.
          log.error("AUTOMATIC ROLLBACK — a staged shard regressed against its pre-declared SLI guardrails", {
            shardId: action.shardId,
            regionId: action.regionId,
            reason: action.reason,
            consequence: action.consequence,
          });

          const outcome = await rollback.publishRollback(action);
          if (!outcome.published) {
            // Raised, not logged: `cutover.worker` states the rule — "the whole value of an
            // automatic rollback is that its record and its effect agree" — and it declines
            // to write the audit event when `publish` throws. A rollback that could not be
            // published must not be recorded as one that happened.
            throw new Error(
              `automatic rollback for ${action.shardId} could not be published ` +
                `[${outcome.refusal.code}]: ${outcome.refusal.message}`,
            );
          }
          log.error("AUTOMATIC ROLLBACK PUBLISHED — this shard now has no decision path", {
            shardId: action.shardId,
            regionId: action.regionId,
            configVersion: outcome.version,
          });
        },
        audit: (event) => auditStream.append({ prisma }, event),
        onError: onError("cutover"),
      },
      { checkIntervalSeconds: seconds("cutover.guardrail_check_interval") },
    ),
  );

  // ── BATCH 2 — §6.2's availability index maintainer ──────────────────────────
  //
  // Started here for an engine process, and beside the simulator for a development
  // simulation process where `ENGINE_ENABLED` is false. Exactly one of the two runs, and
  // the caller decides which by supplying `indexMaintainerDeps` only on this path.
  //
  // The dependency object is built by the caller rather than here because its classifier
  // needs the simulator's roster, which `start()` holds and this function does not. What
  // matters for correctness is that the classifier is REAL: without one, `assembleRecord`
  // now refuses to index any agent at all rather than defaulting to "not charging", so a
  // mis-wired composition degrades to an empty index instead of a widened one.
  if (typeof context.indexMaintainerDeps === "function") {
    started("index_maintainer", indexMaintainer.start(context.indexMaintainerDeps(), {}));
  }

  const summary = workerRegistry.report({ running });
  log.info("Engine workers scheduled (§15 production scheduling)", {
    running: running.length,
    leaderOnly: summary.leaderOnly,
    deferred: summary.deferred,
  });

  return { handles, running };
}

async function start() {
  // §23.7's two secrets, checked before anything connects — when this process runs the
  // engine. Every engine-path submission seals identities *after* writing its Task, Leg
  // and Stops, so a secret the sealer refuses would otherwise surface as a 500 that leaves
  // those rows behind. Same validators the write path uses; no threshold of its own.
  if (cutoverEnabled.processEnabled()) {
    try {
      privacyKeys.assertValid();
    } catch (error) {
      // Named here, before the generic boot handler below repeats the cause.
      logger.error(`Refusing to start the engine: ${error.message}`);
      throw error;
    }
  }

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

  /** PHASE 15 remediation (P15-R2) — the configuration pull loop; stopped on shutdown. */
  let configPropagator = null;

  // Load the pinned configuration version (§22.1 rule 4). Config is DB-authoritative
  // and cache-read (§3.3): the pointer and the materialised set are mirrored in
  // Redis, but a cache miss costs a query and never a wrong answer.
  //
  // While ENGINE_ENABLED is false this degrades to the register defaults with a log
  // line. With it true, a process that cannot load its pinned version refuses to
  // start rather than silently inventing one.
  app.locals.config = await configService.bootstrap({ prisma, kv, logger });

  // ── PHASE 15 remediation (P15-R2) — the pull half of pull-with-pin ────────
  //
  // The comment that used to stand here read: "`app.locals` by reference, not
  // `app.locals.config` by value: the agent handlers read the snapshot at call time, so a
  // republished configuration reaches an already-connected socket (P14-R1)."
  //
  // The first half was true and the second was not. P14-R1 built the plumbing that lets a
  // republished configuration reach a connected socket; **nothing ever republished into
  // it.** The line above was the only assignment to `app.locals.config` in the process, and
  // `configService.loadPinnedSnapshot()` — the pull side of §22.1 rule 4 — had no caller
  // outside two read-only endpoints. Even `POST /api/config/versions`, which publishes *and
  // pins*, left its own process reading the version it booted on.
  //
  // For Phase 15 that is not a general staleness bug, it is the deliverable failing: the
  // per-shard cutover switch **is** a published binding, so "staged by shard, with
  // rollback" meant "staged at boot, permanently" — a shard could not be taken live, could
  // not be rolled back, and §22.4 item 4's automatic rollback could not take effect at all.
  //
  // A pull on a cadence rather than a push, because §22.1 rule 4 says so in as many words:
  // propagation is "pull-with-pin, never a push that could land mid-round".
  configPropagator = configPropagation.start(
    {
      load: () => configService.loadPinnedSnapshot({ prisma, kv }),
      apply: (snapshot) => {
        app.locals.config = snapshot;
      },
      record: (event, detail) => logger.info(`config.${event}`, detail),
      onError: (error) =>
        // Not `warn`: a process that has stopped tracking configuration still answers
        // requests, still gates agents, and is now doing it against a version somebody may
        // have deliberately superseded. That is a state an operator must not learn about
        // from a metric.
        logger.error("Configuration propagation pass failed — this process is still on its previous version", {
          message: error?.message,
          version: configPropagator ? configPropagator.version() : null,
        }),
    },
    {
      currentVersion: app.locals.config ? app.locals.config.version : null,
      checkIntervalSeconds: app.locals.config?.values?.get?.("cutover.guardrail_check_interval"),
    },
  );

  // `app.locals` by reference, not `app.locals.config` by value: the agent handlers read
  // the snapshot at call time, so a republished configuration reaches an already-connected
  // socket (P14-R1) — which, with the propagator above, is now true rather than merely
  // possible.
  initSocketServer(io, { prisma, kv, logger, appLocals: app.locals });

  // P2B-2 — the server-initiated PROBE round trip (§7.5 F14's proof). Off unless
  // AGENT_PROBE_INTERVAL_MS is set: the physical Pi does not implement PROBE yet, and an
  // unanswered probe proves nothing and changes nothing (`services/agentProbe.service.js`).
  const probeIntervalMs = agentProbe.intervalFromEnv(process.env);
  if (probeIntervalMs !== null) {
    agentProbe.startProbeEmitter({ io, intervalMs: probeIntervalMs, logger });
    logger.info(`[probe] agent PROBE emitter active every ${probeIntervalMs} ms`);
  }

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
    logger.error("Server error", describeError(err));
    process.exit(1);
  });

  let virtualSimulator = null;
  /**
   * BATCH 2 — the §6.2 index maintainer's handle, when this process starts it outside the
   * `ENGINE_ENABLED` gate (a development simulation process). Held so shutdown can stop
   * it: a 5 s interval that outlived `disconnectPrisma()` would keep a Prisma client alive
   * and turn a clean stop into a hang.
   */
  let indexMaintainerHandle = null;

  /**
   * BATCH 2 — the index maintainer's dependency object, built once and used by both start
   * sites so the two cannot drift.
   *
   * The classifier is the whole point of this function. `chargingStatusFor` is composed
   * from `services/chargingStatus.service.js` and given its scope predicate from the
   * simulator's roster — which is how a physical agent comes to have **no** authoritative
   * charging state and is therefore left out of the index, rather than being widened into
   * `IDLE_READY` by a default.
   *
   * `capabilityAndContainerClassesFor` is deliberately **not** supplied. It has no
   * producer, §6.2's class vocabularies are undeclared, and nothing reads the secondary
   * index (`candidates/expansion.js` passes no filters at any of its three call sites).
   * Passing a fabricated one would be worse than the documented `[]` default, which is
   * inert. The gap is recorded, not filled.
   *
   * @returns {object}
   */
  const indexMaintainerDeps = () => ({
    prisma,
    kv,
    snapshot: app.locals.config,
    chargingStatusFor: chargingStatus.createChargingStatusReader({
      prisma,
      // With the fleet provider boundary selected, each provider answers for the agents whose
      // charging state it owns — the simulator's roster, and nobody yet for a physical agent.
      // The same answer as the line below, reached through the boundary.
      inScope: fleetProviders.isDispatchEnabled(process.env)
        ? fleetProviders.createChargingScope({
            simulation: {
              chargingInScope: (subject) => (virtualSimulator ? virtualSimulator.managesAgent(subject) === true : false),
            },
            physical: fleetProviders.physicalProvider.createPhysicalProvider({ prisma, kv }),
          })
        : (subject) => (virtualSimulator ? virtualSimulator.managesAgent(subject) === true : false),
      onError: (error, agentRowId) =>
        logger.warn("Charging status could not be read", { agentRowId, message: error && error.message }),
    }),
    onError: (error, agentId) =>
      logger.error("Index maintainer sweep failed", { agentId, message: error && error.message }),
  });

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
  let leaderLifecycle = null;
  let certificateWorker = null;
  let engineWorkers = { handles: [], running: [] };
  const engineEnabled = cutoverEnabled.processEnabled();
  // REMEDIAL PHASE T1-04 — hoisted out of the leadership block below, where it was
  // resolved for the LEADER_ONLY workers alone. §17.4's `ops.escalation_capacity` and
  // §17.5's detection are both **region-scoped**, and the SCHEDULED set is started after
  // the leadership block closes, so a region resolved inside it was out of scope by the
  // time the fairness worker needed it. Declared here, assigned there, read by both.
  let regionId = null;
  // §7.7 — one rejection aggregator for this process: folded into by the coordinator's
  // feasibility gate (LEADER_ONLY), drained to `RejectionAggregate` by the flusher
  // (SCHEDULED). The two are composed in different places, so it is created once here.
  const rejectionAggregator = rejectionTelemetry.createAggregator();
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

      // ── PHASE 15 remediation (D-5) — the LEADER_ONLY lifecycle ───────────
      //
      // Built before the supervisor so that the very first tick that reports `mayRunRound`
      // can promote it. Its `apply()` is idempotent, so the repeated true-ticks of a stable
      // leadership start nothing twice — §19.3 admits one writer per shard and a second
      // interval on the same table would be exactly that second writer.
      const shardId = process.env.SHARD_ID || "default";

      // PHASE 15 remediation (P15-R6) — the shard's operating region.
      //
      // `expiryActions.pageOperations` resolves §18.6's contact set by region
      // (`externalEscalation.resolveContactSet({ contacts, regionId, … })`), and the timer
      // worker was composed without one. `regionId` was therefore `null` on every fire, so
      // the lookup could never match a configured region and every obstructing-stranding
      // escalation would have recorded `NO_CONTACT_CONFIGURED` — silently, and *including
      // after* B8 supplies `ops.external_escalation_contacts`, which is the part that makes
      // it worth fixing now rather than filing behind the calibration blocker.
      //
      // ── Which "region id", and why it is not the one the cutover binding uses ──
      //
      // Found by attacking this fix against a live database, which is the part of the
      // protocol that earned its keep. **`Shard.regionId` is a foreign key to `Region.id`** —
      // a uuid — while `Region.regionId` is the operator-facing identifier. The two are
      // different strings and a fixture that used one value for both could not tell.
      //
      // The rest of the cutover machinery resolves `cutover.engine_enabled` at
      // `Shard.regionId`, and that is correct and self-consistent there: those bindings are
      // written by `stage.authoriseEnable` from the same column, so the key is
      // machine-generated at both ends.
      //
      // §18.6's contact set is the opposite case. `ops.external_escalation_contacts` is a map
      // an **operator authors**, keyed by the region they know — "the responsible
      // infrastructure operator per region — rail, tram, highways, or site security". Handing
      // `externalEscalation.resolveContactSet` a uuid would match nothing and record
      // `NO_CONTACT_CONFIGURED` for every obstructing stranding, silently, and would go on
      // doing so *after* B8 supplies the contacts. So the region is resolved through `Region`
      // to its business identifier.
      //
      // Absent, it stays null and the behaviour is what it was — a gap visible in the
      // escalation row rather than a value invented here.
      try {
        const shardRow = await prisma.shard.findUnique({
          where: { shardId },
          select: { region: { select: { regionId: true } } },
        });
        regionId = (shardRow && shardRow.region && shardRow.region.regionId) || null;
      } catch (e) {
        logger.warn("Could not resolve this shard's operating region for the LEADER_ONLY workers", {
          shardId,
          message: e?.message,
        });
      }
      if (!regionId) {
        logger.error(
          "This shard has no resolvable operating region. §18.6's external escalation chain will record " +
            "NO_CONTACT_CONFIGURED for every obstructing stranding, because a contact set is keyed by region.",
          { shardId },
        );
      }

      leaderLifecycle = leaderWorkers.create({
        prisma,
        // §7.7 — the process's rejection aggregator. The coordinator's gate folds into it;
        // the rejection-aggregation flusher (`startScheduledWorkers`) drains the same one.
        rejectionAggregator,
        kv,
        io,
        // PHASE 15 remediation (P15-R2) — an accessor, not the boot snapshot's map.
        //
        // `create()` is called once at start-up and the composers read this on every
        // promotion. Capturing `app.locals.config.values` here bound every LEADER_ONLY
        // worker's configuration to the version this process happened to boot on, for the
        // life of the process — so a republished deadline, batch size or budget would be
        // adopted by the request path and ignored by the workers, which is worse than
        // either answer alone. Read through a function, a promotion composes against the
        // version in force at the moment leadership is acquired.
        values: () => app.locals.config && app.locals.config.values,
        // E-8b — the same accessor rule, for the snapshot itself.
        //
        // `values` is the resolved parameter *map*; `coordinatorPipeline`'s probes need the
        // *snapshot*, because `resolve(name, { sla_class })` is scope-aware and a flat map
        // cannot answer a per-SLA-class question. This process has had that object all along
        // — `app.locals.config`, kept current by the configuration pull loop — and simply
        // never handed it to the composers, so `snapshot` measured as an unsatisfied
        // PROCESS_DEPENDENCY on a dependency the repository already owns. That made the
        // coordinator's refusal report one more missing input than it truly had, and E-7's
        // own table recorded the process dependencies as "supplied at promotion" when two of
        // the four were not.
        //
        // An accessor rather than the object, for P15-R2's reason exactly: `create()` runs
        // once at boot and the composers run on every promotion.
        snapshot: () => app.locals.config,
        shardId,
        regionId,
        instanceId: `${process.env.HOSTNAME || host}:${process.pid}`,
        runInTransaction: (fn) => runSerializable(prisma, fn),
        // V1 composition — the three seams §10.3.2's commit is built from.
        //
        // `workers/coordinatorSolvePath.js` assembles `commit` rather than taking it
        // injected, because `commitment/commit.js` refuses without a `volatileRecheck`,
        // `volatileSubset.createVolatileRecheck` refuses without a `buildContext` adapter,
        // and that adapter's own header assigns it to the round's composition root. What
        // the assembly cannot build for itself is the transaction seam and the row lock —
        // those know this deployment's isolation level — and the §23.3 signing key, which
        // is an operator-declared deployment secret. All three already existed in this
        // process for the supervisor's own path; they were simply never handed to the
        // composers, which is the E-8b finding again at a second dependency.
        runSerializable,
        selectForUpdate,
        isSerializationFailure,
        // §11.3's transport arm, bound to this process's `io`. The worker never reaches for
        // a socket itself; `activeModes` is passed as a function because a shard's mode set
        // can change between two rows of one drain pass.
        //
        // PHASE 15 remediation (P15-R3). This was `activeModes: () => []` — a constant empty
        // set — so `modeRegister.commandsSuspended([])` answered "nothing is suspended" for
        // every delivery and §18.5's Custodial Operation, whose whole content is *"with the
        // store unavailable no fence can be allocated, so **no command can be authorised**"*,
        // was unenforced on the one path every §10.3.1 command takes. `GET /api/health` read
        // the real `DegradedModeEvent` rows and reported `commandsSuspended: true` at the
        // same moment. The producer existed; the composition root did not use it.
        deliver: dispatchOutboxCommand(io, {
          activeModes: () => degradedTransitions.activeModes({ prisma }, shardId),
        }),
        signingKey: process.env.COMMAND_SIGNING_KEY,
        record: (event, detail) => logger.info(`engine.${event}`, detail),
        onError: (e, workerId) => logger.error("LEADER_ONLY worker failed to stop", { worker: workerId, message: e?.message }),
        logger,
        // V1 DEMONSTRATION (2026-09-23) — the coordinator's input seams for a simulated fleet,
        // composed only when `V1_DEMONSTRATION_COMPOSITION=true` and the simulator is on
        // (`services/v1DemonstrationComposition`). Absent, this spreads nothing and the
        // coordinator refuses by name exactly as before. The same composition the proof run
        // (`tools/demo/runV1Assignment.js`) uses.
        //
        // P1 — `FLEET_PROVIDER_DISPATCH=true` spreads the same seams through the fleet provider
        // boundary (`services/fleetProviders`), under the same gate: simulated agents are
        // answered by the composition above, physical agents by real sources only. One
        // coordinator, one round, one commitment path either way.
        ...(fleetProviders.isDispatchEnabled(process.env)
          ? fleetProviders.composeIfEnabled({ prisma, kv, snapshot: () => app.locals.config, env: process.env })
          : v1DemonstrationComposition.composeIfEnabled({ prisma, kv, snapshot: () => app.locals.config, env: process.env })),
      });

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
            // ── PHASE 15 remediation (D-5) — the promotion hook ────────────────
            //
            // The registry's `LEADER_ONLY` row says these workers are "started and stopped
            // by the shard supervisor rather than at boot". This line is where that becomes
            // true. `mayRunRound` is the supervisor's own single answer to "does this
            // process hold a promoted lease" — computed in `runOnce()` after the failover
            // pass, which is exactly where §19.5 permits rounds to resume — so it is read
            // rather than reconstructed, and this file cannot disagree with the supervisor
            // about who leads.
            //
            // Both directions matter. A demotion stops them, because a worker whose interval
            // outlived a lost lease is precisely the second writer §19.3 forbids, and the
            // fence at the store would not stop its next tick from *trying*.
            if (leaderLifecycle) {
              try {
                leaderLifecycle.apply(tick);
              } catch (error) {
                logger.error("LEADER_ONLY lifecycle failed to apply a leadership transition", {
                  message: error?.message,
                });
              }
            }

            if (!io) return;

            // ── PHASE 15 remediation (D-6) — a migration invalidates the session ──
            //
            // The agent-facing cutover check resolves the agent's shard **once, at AUTH**
            // and caches it on the socket (`engine/cutover/agentGate.js`), because
            // resolving it per event would put two indexed queries on the telemetry hot
            // path. That cache is correct for exactly as long as the agent's shard does not
            // change, and §19.2's migration is the one thing that changes it.
            //
            // Disconnecting is not a heavy-handed way to invalidate a cache — it is what
            // the migration already requires. `membership.migrate()` advances the agent's
            // `authority_epoch`, which voids every mission authority it holds (§10.3.1), and
            // §11.5's deduplication handshake — the mechanism by which an agent adopts a new
            // epoch and fence floor — rides on `AUTH_SUCCESS`. An agent that stayed
            // connected across a migration would be holding a superseded authority and a
            // stale shard binding at the same time. It reconnects, re-AUTHs, and
            // `agentGate` resolves the shard it is now actually in.
            //
            // Cross-process by construction: the Socket.IO Redis adapter fans this out, so
            // the migrated agent is reached wherever its socket lives — the same pattern
            // the §23.2 revocation sweep uses below. `agentGate`'s freshness bound is the
            // backstop for a session this does not reach.
            for (const outcome of (tick.migration && tick.migration.outcomes) || []) {
              if (!outcome.ok || !outcome.agentId) continue;
              try {
                io.in(`robot:${outcome.agentId}`).disconnectSockets(true);
                logger.info("Agent session invalidated by shard migration (§19.2) — it will re-AUTH into its new shard", {
                  agentId: outcome.agentId,
                  fromShardId: outcome.fromShardId,
                  toShardId: outcome.toShardId,
                });
              } catch (error) {
                // Best effort. The durable `ShardMembership` row is the authority and
                // `agentGate`'s freshness bound refuses the stale binding within one
                // window either way; failing here must not take the supervisor's tick down.
                logger.warn("Could not invalidate a migrated agent's session", {
                  agentId: outcome.agentId,
                  message: error?.message,
                });
              }
            }

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
    engineWorkers = startScheduledWorkers({
      prisma,
      rejectionAggregator,
      kv,
      config: app.locals.config,
      // PHASE 15 remediation (P15-R2) — the current version, for the readers that must
      // track a republish rather than the one this process booted on.
      snapshotOf: () => app.locals.config,
      logger,
      io,
      // T1-04 — `fairness.idle_alert_period` is region-scoped, as is
      // `ops.escalation_capacity`. Resolved above, from `Shard → Region`.
      regionId,
      // BATCH 2 — the index maintainer's dependencies, built here because its charging
      // classifier needs the simulator's roster for its scope predicate.
      indexMaintainerDeps,
    });
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
      // BATCH 2 — the index maintainer, when this process started it outside the
      // `ENGINE_ENABLED` gate. The engine-path handle is in `engineWorkers.handles` and is
      // stopped with the rest below; this is the development-simulation one, which nothing
      // else holds.
      try { indexMaintainerHandle?.stop?.(); } catch { /* ignore */ }
      try { certificateWorker?.stop?.(); } catch { /* ignore */ }
      // PHASE 15 remediation (D-5) — stop the LEADER_ONLY workers before the leadership
      // release below. Releasing first would advance the fence while a drain pass was still
      // in flight in this process; stopping first means the standby that takes the shard
      // inherits no in-flight writer of ours.
      try { leaderLifecycle?.stop?.(); } catch { /* ignore */ }
      // PHASE 15 remediation (P15-R2) — the configuration pull loop. Stopped with the rest;
      // an interval that outlived the process's shutdown would go on swapping a snapshot
      // nothing reads.
      try { configPropagator?.stop?.(); } catch { /* ignore */ }
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

  // ── STEP 1: simulation is opt-in ──────────────────────────────────────────
  //
  // `ENABLE_VIRTUAL_SIMULATOR=true` turns the in-process simulator on; unset means off.
  // The previous posture was the inverse — the simulator ran unless `DISABLE_VIRTUAL_
  // SIMULATOR=true` said otherwise — which meant every boot of every deployment spawned an
  // in-process VirtualRobot for every `Robot` row, physical hardware included. The legacy
  // kill switch is still honoured (`simulationPolicy` documents why) so the benchmark
  // configuration keeps meaning what it says.
  const simulatorEnabled = simulationPolicy.isSimulatorEnabled();

  server.listen(port, host, () => {
    const serverUrl = `http://127.0.0.1:${port}`;
    virtualSimulator = createVirtualRobotSimulator({
      prisma,
      kv,
      serverUrl,
      logger,
      enabled: simulatorEnabled,
      // BATCH 2 — the two transaction primitives the development Charging Scheduler needs
      // to enforce its plug count. Injected here because no module under `src/simulation/`
      // may import a database dependency of its own (`simulationBoundary.test.js` holds
      // that as a structural guard), and because the composition root is already where
      // `prisma` and `kv` reach the simulator.
      runSerializable,
      selectForUpdate,
      // The SQLSTATE check, injected for the same reason: a serialisation failure is an
      // ordinary outcome for several robots docking at once, and the scheduler must be
      // able to tell one apart from a real error without importing a database module.
      isSerializationFailure,
    });
    app.locals.virtualSimulator = virtualSimulator;

    logger.startup({
      env:       process.env.NODE_ENV || "development",
      port,
      db:        true,
      redis:     redisLive,
      simulator: simulatorEnabled
        ? "Enabled — re-hydrating simulated robots…"
        : `Disabled (${simulationPolicy.SIMULATOR_ENV_VAR} is not true) — physical fleet only`,
    });

    // ── BATCH 2: the development Charging Scheduler, then the index maintainer ──
    //
    // Ordered, and awaited, for a reason that is about truth rather than tidiness. The
    // scheduler must have published its availability projection before any robot asks for
    // a plug (`requestPlug` refuses without one) and before the index maintainer's first
    // sweep, because `chargingStatusFor` reads the reservations the scheduler owns — a
    // sweep that ran first would find no scheduler, answer `known: false` for every agent,
    // and index nothing. That is the correct answer for an absent scheduler and the wrong
    // one for a scheduler that has not finished booting.
    if (simulatorEnabled) {
      virtualSimulator
        .provisionCharging()
        .catch((e) => logger.warn("Development charging scheduler could not be provisioned", { message: e?.message }))
        .finally(() => { virtualSimulator.start(); });
    }

    // §6.2's index maintainer. Its registry row moved from DEFERRED to SCHEDULED at
    // Batch 2 because the classifier it was blocked on now exists — see
    // `src/workers/registry.js` for what that does and does not claim.
    //
    // ── Why it is started HERE and not in `startScheduledWorkers` ─────────────
    // Every other SCHEDULED worker starts inside the `ENGINE_ENABLED` gate, and this one
    // must also run for a development simulation process where the engine is off: the
    // whole point of Batch 2 is that a simulated fleet becomes *visible* to candidate
    // search. So the condition is the union, and the worker is started once in whichever
    // of the two postures applies. Starting it twice would run two sweeps over one table.
    //
    // It is safe in both. The classifier answers `known: false` for every agent no
    // Charging Scheduler covers, and the worker then indexes nothing — so an engine
    // process with no simulator writes exactly the rows it wrote before Batch 2 (none).
    if (simulatorEnabled && !engineEnabled) {
      indexMaintainerHandle = indexMaintainer.start(indexMaintainerDeps(), {});
      logger.info("Availability index maintainer started (development simulation)", {
        worker: "index_maintainer",
        engineEnabled: false,
        note:
          "the availability index is advisory (§3.3 I16). Agents no Charging Scheduler covers are NOT indexed; " +
          "this closes no V1 stop condition and is not physical evidence",
      });
    }

    // Re-hydrate VirtualRobot instances for the robots that are *simulated* units.
    // Runs async after listen so it doesn't block the HTTP server from becoming ready.
    //
    // ── What was removed, and why it was not a convenience ────────────────
    // This block used to run `updateMany({ data: { isOnline: true, lastSeenAt: now } })`
    // over every Robot row, on the reasoning that DTARO should be able to assign tasks in
    // "the brief window before their VirtualRobot socket connects". For a physical fleet
    // that window never closes: nothing was connecting, so the write was not a head start
    // on the truth, it was a substitute for it — every robot in the database reported
    // itself online because a process had restarted. F13 reads `Robot.isOnline` as
    // liveness. Liveness is now established the only way it can be, by a session: AUTH
    // sets it (`sockets/handlers/robot.handler.js`), disconnect clears it, and the
    // staleness sweeper in `socket.server.js` retires whatever is left.
    (async () => {
      try {
        await rehydrateSimulatedRobots({
          prisma,
          simulator: virtualSimulator,
          logger,
          enabled: simulatorEnabled,
        });

        // After a brief window (5 s) for agents to connect + authenticate, re-dispatch any
        // tasks that were active when the server was last shut down. Without this, robots
        // know they have tasks in DB but never receive TASK_ASSIGN.
        //
        // Outside the simulator branch on purpose. Recovering an interrupted task is a
        // property of the fleet, not of the simulator, and it used to run only because the
        // simulator was on by default; leaving it there would have made turning simulation
        // off silently disable task recovery for physical robots. Same dispatch path as
        // before — `dispatchTaskAssign`, addressed to whichever robot holds the task.
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
  // P1.4 — the logger renders an Error's own enumerable fields only, so `{ err }` printed
  // `err={}` and a failed boot said nothing about why. Name the fields explicitly.
  logger.error("Failed to start server", describeError(err));
  process.exit(1);
});

/**
 * An Error as loggable fields — message, code and stack — for the boot and listen
 * handlers, whose `{ err }` the logger rendered as `{}`.
 *
 * @param {unknown} err
 * @returns {{ message: string|null, code: string|null, stack: string|null }}
 */
function describeError(err) {
  return {
    message: err && err.message ? String(err.message) : String(err),
    code: err && err.code ? String(err.code) : null,
    stack: err && err.stack ? String(err.stack) : null,
  };
}