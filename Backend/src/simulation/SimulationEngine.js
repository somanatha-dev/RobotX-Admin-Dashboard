/**
 * Virtual Robot Simulation Engine
 *
 * Manages the lifecycle of virtual robots. A virtual robot exists only for a `Robot` row
 * that is explicitly marked `simulated = true`, in a process where the simulator is
 * explicitly enabled. Both conditions are evaluated by `simulationPolicy`, which is the
 * only module that decides this.
 *
 *   start()             — mark the engine as running AND start every robot it holds
 *   stop()              — disconnect all robots and clear tick timers (robots are retained)
 *   reset()             — clear task/charging state without disconnecting
 *   addRobot(config)    — connect and start a simulated robot
 *   removeRobot(id)     — stop and remove a robot (called on decommission)
 *   getStatus()         — snapshot of every robot's current state
 *   setConfig(tunables) — apply the closed set of simulator tunables (STEP 4)
 *
 * ── STEP 1: the engine refuses rather than trusts ───────────────────────────
 * `addRobot` used to spawn a VirtualRobot for whatever `robotId` it was handed, and both
 * of its callers handed it every robot they knew about. It now re-reads the target row and
 * refuses unless the database itself says the unit is simulated. The caller's claim is not
 * sufficient: a caller is where the mistake would be made, and the row is the fact.
 */

const VirtualRobot = require("./VirtualRobot");
// STEP 3 — the existing `EnergyModelParams` → §14.2-coefficient-name adapter. Reused
// rather than reimplemented: the two spellings are genuinely different and there must be
// exactly one place that converts between them.
const { energyCoefficientsFrom } = require("../engine/domain/mappers/decisionInputs");
const simulationPolicy = require("./simulationPolicy");
// STEP 4 — the closed set of simulator tunables. `setConfig` was a no-op; see
// `simulationConfig.js` for why this is nine numbers rather than a configuration framework.
const simulationConfig = require("./simulationConfig");
const { hashSeed } = require("./random");
// BATCH 2 — the development Charging Scheduler. It is driven from here and from nowhere
// else, which is what confines its scope: every robot in `robots` passed
// `simulationPolicy.maySpawnVirtualRobot`, so "the scheduler acts only on simulated units"
// is inherited from the gate that already establishes it rather than re-derived from the
// discriminator beside it.
const devChargingScheduler = require("./devChargingScheduler");

/**
 * STEP 3 — the commissioned specification a `VirtualRobot` is constructed with.
 *
 * ── Reading, not copying ────────────────────────────────────────────────────
 * Every value here is read out of the rows the commissioning transaction wrote and handed
 * straight to the constructor. Nothing is persisted back, no simulator-side table mirrors
 * any of it, and there is no second source of truth: change a unit's specification and
 * the next `addRobot` builds an agent from the new numbers.
 *
 * ── Absence stays absent ────────────────────────────────────────────────────
 * A unit commissioned before the specification existed has no `AgentClass` models, and
 * every field below is then `null`. `VirtualRobot._resolveSpecification` reads `null` as
 * "fall back to the module constant", so such a unit behaves exactly as it did before
 * this step — and a unit that *does* carry a value never has it replaced by a constant.
 *
 * @param {object|null} row the `Robot` row loaded by `addRobot`
 * @returns {{ specification: object, batteryState: object|null, energyModelParams: object|null }}
 */
function specificationInputsFor(row) {
  const agent = row && row.agent ? row.agent : null;
  const agentClass = agent && agent.agentClass ? agent.agentClass : null;
  const mobility = agentClass && agentClass.mobilityModel ? agentClass.mobilityModel : null;

  const kinematic =
    mobility && mobility.kinematicLimits && typeof mobility.kinematicLimits === "object"
      ? mobility.kinematicLimits
      : {};
  const speedModel =
    mobility && mobility.speedModel && typeof mobility.speedModel === "object"
      ? mobility.speedModel
      : {};

  const params =
    agentClass && Array.isArray(agentClass.energyModelParams) && agentClass.energyModelParams.length > 0
      ? agentClass.energyModelParams[0]
      : null;

  return {
    specification: {
      massKg: row ? row.massKg : null,
      normalSpeedMps: speedModel.nominalSpeedMps ?? null,
      maxSpeedMps: kinematic.maxSpeedMps ?? null,
      packNominalWh: agentClass && agentClass.energyModel ? agentClass.energyModel.packNominalWh : null,
      payloadCapacityKg:
        agentClass && agentClass.containerModel ? agentClass.containerModel.totalMassLimitKg : null,
    },
    batteryState: agent && agent.batteryState ? agent.batteryState : null,
    // In `legEnergyWh`'s own naming. On this deployment every coefficient is null, so the
    // model refuses and names them — which is the whole reason the row is worth loading.
    energyModelParams: energyCoefficientsFrom(params),
  };
}

/**
 * BATCH 2 — how often the scheduler's reconciliation pass runs.
 *
 * @structural a sweep cadence, not a behavioural threshold. Every ordinary plug hand-over
 * is synchronous — `devChargingScheduler.release` promotes the next robot in the same
 * call — so this pass exists only for the promotions nothing announced: a reservation
 * that outlived its published window because the process holding it died. Ten seconds is
 * a batching choice against a window measured in tens of minutes, and no register entry
 * is invented for it because no behaviour changes with its value.
 */
const SCHEDULER_PASS_INTERVAL_MS = 10_000;

/**
 * @param {object} deps
 * @param {Function} [deps.runSerializable] `db/prisma.runSerializable`, and
 *   @param {Function} [deps.selectForUpdate] `db/prisma.selectForUpdate` — the two
 *   transaction primitives the development Charging Scheduler enforces its plug count
 *   with. **Injected, never imported**, for the same reason `prisma` is: no module under
 *   `src/simulation/` may take a database dependency of its own, and
 *   `tests/engine/simulationBoundary.test.js` holds that as a structural guard. Absent
 *   means no plug can be granted — `requestPlug` refuses rather than counting occupancy
 *   outside a lock, because a count that can interleave with an insert is how a
 *   three-plug charger comes to have four robots on it.
 * @param {boolean} [deps.enabled] the process-level posture; defaults to
 *   `simulationPolicy.isSimulatorEnabled()`, i.e. `ENABLE_VIRTUAL_SIMULATOR=true`, off
 *   otherwise. Injected so the composition root can state it once and so a test need not
 *   mutate `process.env`.
 */
function createVirtualRobotSimulator({
  prisma, kv, serverUrl, logger, enabled, runSerializable, selectForUpdate, isSerializationFailure,
} = {}) {
  const log   = logger || console;
  const simulatorEnabled =
    typeof enabled === "boolean" ? enabled : simulationPolicy.isSimulatorEnabled();
  let robots  = [];
  let started = false;
  /**
   * BATCH 2 — the scheduler's periodic pass, and the deps it runs with.
   *
   * `promote`/`reconcile` need a tick of their own because the events they respond to are
   * not the agent's: a plug freed by robot A is what promotes robot B, and B is not
   * ticking on A's schedule. Every exit from charging also promotes synchronously (see
   * `devChargingScheduler.release`), so this pass is the safety net for the case no exit
   * announced — a process that died mid-session — rather than the primary mechanism.
   */
  let schedulerTimer = null;
  const chargingDeps = { prisma, runSerializable, selectForUpdate, isSerializationFailure };

  /**
   * BATCH 2 — is this agent one the development Charging Scheduler covers?
   *
   * The roster is the answer, and the roster is `robots`: every entry passed
   * `simulationPolicy.maySpawnVirtualRobot`, which re-read the row and required the
   * database itself to say the unit is simulated. So membership here *is* the
   * discriminator, obtained through the one gate allowed to read it.
   *
   * `services/chargingStatus.service.js` receives this as its injected `inScope`
   * predicate, which is why that module reads no flag of its own: a physical agent is not
   * in this list and cannot be, so it can never be told that it is free of a charger.
   *
   * Matches on the robot's business identifier — the `Agent.agentId` seeded from
   * `Robot.robotId`, and the `Robot.robotId` itself — so a caller holding either can ask.
   *
   * @param {{ robotId?: string|null, agentId?: string|null }} subject
   * @returns {boolean}
   */
  function managesAgent(subject) {
    const source = subject || {};
    const wanted = [source.robotId, source.agentId].filter((value) => typeof value === "string" && value !== "");
    if (wanted.length === 0) return false;
    return robots.some((vr) => wanted.includes(vr.robotId));
  }

  /**
   * The scheduler client one `VirtualRobot` is handed. Bound to that agent's row, so the
   * agent cannot name another.
   *
   * @param {string} agentRowId `Agent.id`
   * @returns {{ request: Function, release: Function, state: Function }}
   */
  function chargingClientFor(agentRowId) {
    return {
      async request(targetSoc) {
        const verdict = await devChargingScheduler.requestPlug(chargingDeps, {
          agentRowId,
          targetSoc,
          nowMs: Date.now(),
        });
        if (!verdict.ok) {
          // `retryable` means PostgreSQL declined to serialise the transaction against a
          // concurrent request — several robots docking in the same instant is the ordinary
          // case for a three-plug charger, not an incident. It is logged at debug and the
          // agent asks again on its next tick, which is the bounded retry `db/prisma`'s own
          // "deliberately performs no retry" note assigns to the caller.
          const level = verdict.retryable === true ? "debug" : "warn";
          if (typeof log[level] === "function") {
            log[level]("[VR] plug request not granted", { agentRowId, retryable: verdict.retryable === true, problems: verdict.problems });
          }
          // `null`, never `"NONE"`. "The scheduler did not answer" is not "you hold
          // nothing"; reporting the second would let a charging agent conclude its
          // reservation had been taken away because one transaction lost a race.
          return { state: null, retryable: verdict.retryable === true, problems: verdict.problems };
        }
        // A newly queued robot is promoted by the same pass everybody else is, so the
        // request does not grant its own plug. Running the pass here keeps the common
        // case — a free plug and an empty queue — one round trip rather than one tick.
        await devChargingScheduler.promote(chargingDeps, { nowMs: Date.now() });
        const live = await devChargingScheduler.liveReservationFor(chargingDeps, agentRowId);
        return { state: live ? live.state : "NONE", problems: [] };
      },
      async release(reason) {
        return devChargingScheduler.release(chargingDeps, { agentRowId, nowMs: Date.now(), reason });
      },
      async state() {
        const live = await devChargingScheduler.liveReservationFor(chargingDeps, agentRowId);
        return { state: live ? live.state : "NONE" };
      },
    };
  }

  /**
   * STEP 4 — the current tunables, `{}` until something sets them. Applied to robots as
   * they are added, and — for the two `LIVE` parameters — to robots already running.
   */
  let config  = {};

  // ── Engine lifecycle ────────────────────────────────────────────────────────

  /**
   * Mark the engine started, and **start the robots it is holding**.
   *
   * ── STEP 4: what this used to do, and why that was a defect ──────────────────
   * It set `started = true` and logged a line. Nothing else. Two consequences, both of
   * which a demo hits immediately:
   *
   *   1. A robot added while the engine was not started was pushed onto the list with the
   *      verdict `ENGINE_NOT_STARTED` and then **never started by anything**. `start()`
   *      did not look at the list, so the robot sat there for the life of the process.
   *   2. `stop()` disconnects every robot and nulls its socket. A subsequent `start()`
   *      therefore left the entire fleet dead — no socket, no timer, no telemetry — while
   *      the engine reported `started: true`.
   *
   * The second one was worse than an inert button, because `started` is *read as truth* on
   * the way out: the frontend's `runtimeStatusOf` computes RUNNING from
   * `enabled && started && managed`, so after one stop→start cycle every simulated robot
   * was labelled RUNNING on the dashboard with nothing driving it. That is the same class
   * of defect as the `isOnline: true` this programme has removed twice — a flag asserting a
   * runtime that does not exist.
   *
   * Fixed in the direction that makes the existing reading true, rather than by teaching
   * the UI to distrust the flag: `started` now means the robots are started, because
   * starting them is what this function does.
   *
   * @returns {{ started: boolean, running: number, total: number, reason: string|null }}
   */
  function start() {
    if (!simulatorEnabled) {
      // Not an error, and not silently "started either way". A disabled simulator that
      // reported itself running would make the next operator debug the wrong thing.
      log.info(
        `[VR] Simulator disabled — set ${simulationPolicy.SIMULATOR_ENV_VAR}=true to enable it. ` +
          "No virtual robot will be spawned.",
      );
      return { started: false, running: 0, total: robots.length, reason: "SIMULATOR_DISABLED" };
    }

    const wasStarted = started;
    started = true;

    // Every managed robot that is not ticking is (re)connected and started. Idempotent:
    // `VirtualRobot.start()` returns immediately when its timer is already live, so calling
    // this on a healthy fleet changes nothing.
    let revived = 0;
    for (const vr of robots) {
      if (vr.isRunning()) continue;
      try {
        // A stopped robot had its socket nulled, so it needs a fresh one. `connect()` is
        // safe to call again — it replaces the socket and clears the handler registration
        // record, which is what keeps the reconnect path from double-registering.
        if (!vr.socket) vr.connect(serverUrl);
        vr.start();
        revived += 1;
      } catch (e) {
        log.warn(`[VR] ${vr.robotId} could not be started`, { message: e?.message });
      }
    }

    // BATCH 2 — the development Charging Scheduler's periodic pass. Started with the
    // fleet and stopped with it, because a scheduler promoting robots that are not running
    // would hand plugs to agents that cannot use them.
    if (prisma && schedulerTimer === null) {
      schedulerTimer = setInterval(() => {
        devChargingScheduler
          .reconcile(chargingDeps, { nowMs: Date.now() })
          .catch((e) => log.warn("[VR] charging scheduler pass failed", { message: e?.message }));
      }, SCHEDULER_PASS_INTERVAL_MS);
      if (typeof schedulerTimer.unref === "function") schedulerTimer.unref();
    }

    const running = robots.filter((vr) => vr.isRunning()).length;
    log.info(
      wasStarted
        ? `[VR] Simulator start — ${revived} robot(s) (re)started, ${running}/${robots.length} running`
        : `[VR] Simulator ready — ${running}/${robots.length} simulated robot(s) running`,
    );
    return { started: true, running, total: robots.length, reason: null };
  }

  /**
   * BATCH 2 — provision the development charger and clear any reservation the previous
   * process left behind.
   *
   * Separate from `start()` and awaited by the composition root, because it is the one
   * step that must have completed before a robot can ask for a plug: `requestPlug` refuses
   * when no projection has been published, and a fleet that started first would spend its
   * first ticks being refused for a reason that is about boot order rather than about
   * charging.
   *
   * @param {{ nowMs?: number }} [options]
   * @returns {Promise<object>}
   */
  async function provisionCharging(options) {
    if (!prisma) return { ok: false, problems: ["no prisma client"] };
    const nowMs = options && Number.isFinite(options.nowMs) ? options.nowMs : Date.now();

    const provisioned = await devChargingScheduler.provision({ prisma }, { nowMs });
    if (!provisioned.ok) {
      log.warn("[VR] development charger not provisioned", { problems: provisioned.problems });
      return provisioned;
    }

    // Restart reconciliation, before the first robot asks for anything. A process that
    // died with three robots ACTIVE left three occupied plugs and no in-memory state;
    // without this the charger is full forever and every request queues behind agents that
    // are gone.
    const reconciled = await devChargingScheduler.reconcile(chargingDeps, { nowMs });

    log.info("[VR] development charging scheduler ready", {
      chargerId: devChargingScheduler.DEVELOPMENT_CHARGER.chargerId,
      plugCount: devChargingScheduler.DEVELOPMENT_CHARGER.plugCount,
      projectionVersion: provisioned.projectionVersion,
      publishedNewVersion: provisioned.published,
      staleReservationsExpired: reconciled.expired,
      evidence: "DEVELOPMENT SIMULATION — not physical charger evidence, and no V1 stop condition is affected",
    });

    return { ...provisioned, expired: reconciled.expired };
  }

  function stop() {
    started = false;
    if (schedulerTimer !== null) {
      clearInterval(schedulerTimer);
      schedulerTimer = null;
    }
    for (const vr of robots) {
      try { vr.stop(); } catch { /* ignore */ }
    }
    // The robots stay in the list. They are still this engine's simulated units and a
    // later `start()` revives them; dropping them would lose the fleet on a pause.
    log.info(`[VR] Simulator stopped — ${robots.length} robot(s) held, none running`);
  }

  function reset() {
    for (const vr of robots) {
      try { vr.reset(); } catch { /* ignore */ }
    }
    log.info("[VR] All virtual robots reset");
  }

  // ── Dynamic robot management ────────────────────────────────────────────────

  /**
   * The highest telemetry `sequence` the server has accepted from this robot, from its
   * durable position log (`Observation`, kind `position`) — the log
   * `positionObservation.service` seeds its STALE_SEQUENCE high-water mark from. The
   * maximum rather than the latest row, so the floor is never below any accepted frame.
   *
   * A robot with no agent row or no position history resumes from 0 (its first frame is 1).
   * A failed read also resumes from 0 — the pre-P1.3 behaviour, which the server still
   * refuses safely as STALE_SEQUENCE until the counter passes its mark — and says so.
   *
   * @param {object|null} row the Robot row read above
   * @returns {Promise<number>}
   */
  async function lastAcceptedSequence(row) {
    const agentRowId = row && row.agent && row.agent.id;
    if (!prisma || !agentRowId || !prisma.observation || typeof prisma.observation.aggregate !== "function") return 0;
    try {
      const found = await prisma.observation.aggregate({
        where: { agentId: agentRowId, kind: "position" },
        _max: { sequence: true },
      });
      const max = found && found._max ? found._max.sequence : null;
      if (max === null || max === undefined) return 0;
      const value = Number(max);
      return Number.isSafeInteger(value) && value > 0 ? value : 0;
    } catch (e) {
      log.warn("[VR] Could not read the last accepted telemetry sequence; resuming from 0", {
        agentRowId,
        message: e?.message,
      });
      return 0;
    }
  }

  /**
   * Attach a simulation instance to a `Robot` row that is a simulated unit.
   *
   * The row must already exist in the DB; `commission()` only seeds the simulated agent's
   * Redis session and live-state keys, and refuses to do even that for a physical unit.
   *
   * ── The authority for "is this simulated" is the row, not the argument ────
   * `simulated` may be passed by a caller that has just read or written the row, but it is
   * only a hint: when a Prisma client is available the row is re-read and **that** answer
   * governs. A caller passing `simulated: true` for a physical robot is refused, which is
   * the case that matters — it is the one that would credential physical hardware from the
   * simulator.
   *
   * @param {{ robotId: string, lat: number|null, lon: number|null, simulated?: boolean }} config
   * @returns {Promise<{ started: boolean, reason: string|null }>}
   */
  async function addRobot({ robotId, lat, lon, simulated } = {}) {
    if (!robotId) return { started: false, reason: "NO_ROBOT_ID" };

    if (!simulatorEnabled) {
      log.info(
        `[VR] addRobot refused for ${robotId} — SIMULATOR_DISABLED ` +
          `(${simulationPolicy.SIMULATOR_ENV_VAR} is not true)`,
      );
      return { started: false, reason: "SIMULATOR_DISABLED" };
    }

    // Idempotent — skip if already managed.
    if (robots.find((r) => r.robotId === robotId)) {
      log.info(`[VR] addRobot: ${robotId} already managed — skipping`);
      return { started: false, reason: "ALREADY_MANAGED" };
    }

    // Load the row: the simulation discriminator, and the DB battery as a fallback in case
    // the Redis persistence key is absent (so battery is never random on first start).
    let row = null;
    if (prisma) {
      try {
        // ── STEP 3: load the unit's commissioned specification, not just its flag ──
        //
        // This used to select `{ battery, simulated }` and nothing else, which is why
        // every VirtualRobot fell back to the fleet constants: the specification the
        // operator entered was never read, so the agent could not have used it.
        //
        // The joins are the same ones `robotSpecification.SPECIFICATION_INCLUDE` uses —
        // the per-unit `AgentClass` and its three model rows — plus the pack state and
        // the class's §14.2 coefficients. Columns are enumerated rather than pulled in
        // wholesale for the reason `SPECIFICATION_INCLUDE` documents: `Agent` carries
        // BigInt columns that would throw on serialisation.
        row = await prisma.robot.findUnique({
          where:  { robotId },
          select: {
            battery: true,
            simulated: true,
            massKg: true,
            agent: {
              select: {
                // BATCH 2 — the `Agent` primary key. `ChargerReservation.agentId` is a
                // foreign key to it, so the charging client cannot be bound without it.
                // A String uuid, so the BigInt-serialisation hazard the comment above
                // names does not apply.
                id: true,
                batteryState: {
                  select: { kappa: true, kappaSampleCount: true, soh: true, lastObservedSoc: true },
                },
                agentClass: {
                  select: {
                    mobilityModel: { select: { kinematicLimits: true, speedModel: true } },
                    energyModel: { select: { packNominalWh: true } },
                    containerModel: { select: { totalMassLimitKg: true } },
                    energyModelParams: { orderBy: { modelVersion: "desc" }, take: 1 },
                  },
                },
              },
            },
          },
        });
      } catch (e) {
        // A row that could not be read is a row whose `simulated` flag is unknown, and an
        // unknown flag is not permission. Refusing here is what keeps a transient DB error
        // from being an opening through which a physical robot acquires a simulated twin.
        log.warn(`[VR] addRobot refused for ${robotId} — row unreadable`, { message: e?.message });
        return { started: false, reason: "ROBOT_ROW_UNREADABLE" };
      }
      if (!row) {
        log.warn(`[VR] addRobot refused for ${robotId} — no such Robot row`);
        return { started: false, reason: "ROBOT_NOT_FOUND" };
      }
    }

    // Without a Prisma client (a harness constructing the engine standalone) the caller's
    // own claim is all there is; it is still required to be an explicit `true`.
    const subject = row || { robotId, simulated };
    const verdict = simulationPolicy.maySpawnVirtualRobot(subject, { enabled: simulatorEnabled });
    if (!verdict.allowed) {
      log.info(
        `[VR] addRobot refused for ${robotId} — ${verdict.reason}. ` +
          "Physical units never receive a VirtualRobot.",
      );
      return { started: false, reason: verdict.reason };
    }

    // The robot's own position wins; a configured start position is the fallback for a row
    // that has none, and the class default is the fallback for that. A configured position
    // that overrode a robot's recorded one would move the fleet on top of each other every
    // time somebody tuned the simulator.
    const spawnLat =
      typeof lat === "number" ? lat : Number.isFinite(config.startLat) ? config.startLat : 12.9023;
    const spawnLon =
      typeof lon === "number" ? lon : Number.isFinite(config.startLon) ? config.startLon : 77.5183;

    const dbBattery =
      typeof row?.battery === "number" && Number.isFinite(row.battery) ? row.battery : null;

    // P1.3 — where this robot's telemetry sequence resumes. The server accepts a position
    // frame only if its sequence exceeds every one it has accepted for this robot, and it
    // seeds that mark from the durable log (`positionObservation.service`), so the log is
    // the authority and the simulated agent reads it the way a physical one must persist its
    // own counter (LAN-10). Read before the robot exists, so no frame can be sent first.
    const telemetrySequenceFloor = await lastAcceptedSequence(row);

    const vr = new VirtualRobot({
      robotId,
      lat: spawnLat,
      lon: spawnLon,
      logger: log,
      kv,
      dbBattery,
      simulated: true,
      // STEP 4 — the tunables, at construction. Undefined entries fall back to the module
      // constants inside `VirtualRobot`, so an unconfigured engine builds exactly the robot
      // it built before Step 4.
      telemetryIntervalMs: config.telemetryIntervalMs,
      speedBaseMs:         config.speedBaseMs,
      speedJitter:         config.speedJitter,
      obstacleProbability: config.obstacleProbability,
      initialBattery:      config.initialBattery,
      // A configured seed is *offset by the robot id* rather than used directly. Handing
      // every robot the same seed would make them move identically — synchronised jitter
      // across the fleet — which is the opposite of the independence a seed is set for. The
      // seed pins the *run*; the id still separates the robots within it.
      randomSeed:
        Number.isFinite(config.randomSeed)
          ? (config.randomSeed ^ hashSeed(robotId)) >>> 0
          : undefined,
      telemetrySequenceFloor,
      // ── STEP 3: the commissioned specification, and the persisted pack state ──
      // Read from the row above. Every field is `null` when the unit has no commissioned
      // value, and `VirtualRobot` then falls back to the module constant — a fallback
      // fills a gap and never overrides a value that is present.
      ...specificationInputsFor(row),
      // ── BATCH 2: the Charging Scheduler client, or nothing ────────────────────
      //
      // Supplied only when this unit has an `Agent` row for a reservation to reference.
      // A simulated `Robot` with no backing `Agent` — a unit predating the Phase 2
      // backfill — gets no client and keeps Batch 1's local docking delay. That is the
      // fail-closed direction: `ChargerReservation.agentId` is a foreign key, a
      // reservation cannot be written for an agent that does not exist, and inventing the
      // agent to make the charger work would be inventing a fleet participant.
      chargingClient:
        prisma && row && row.agent && row.agent.id ? chargingClientFor(row.agent.id) : null,
    });

    try {
      await vr.commission(kv);
    } catch (e) {
      // The session seed is what makes the simulated agent able to AUTH. A VirtualRobot
      // that failed it would connect, be refused, and reconnect forever — so it is not
      // registered or started at all.
      log.error(`[VR] addRobot session seed failed for ${robotId}`, { message: e?.message });
      return { started: false, reason: "SESSION_SEED_FAILED" };
    }

    robots.push(vr);

    if (started) {
      vr.connect(serverUrl);
      vr.start();
      log.info(`[VR] ${robotId} virtual robot started`);
      return { started: true, reason: null };
    }

    log.warn(`[VR] ${robotId} queued — engine not started yet`);
    return { started: false, reason: "ENGINE_NOT_STARTED" };
  }

  /**
   * Stop and remove a commissioned robot (called by the retire/decommission flow).
   * @param {string} robotId
   */
  function removeRobot(robotId) {
    const idx = robots.findIndex((r) => r.robotId === robotId);
    if (idx < 0) return;
    try { robots[idx].stop(); } catch { /* ignore */ }
    // BATCH 2 — a retired unit must not keep a plug. `stop()` halts the tick, so the
    // agent will never reach its target and never release; without this the charger loses
    // a plug for every decommission and the queue behind it stops moving. Issued before
    // the splice, while the instance still holds its bound client.
    try { robots[idx]._clearCharging(devChargingScheduler.RELEASE_REASON.DEREGISTERED); } catch { /* ignore */ }
    robots.splice(idx, 1);
    log.info(`[VR] ${robotId} virtual robot removed`);
  }

  // ── Introspection ───────────────────────────────────────────────────────────

  function getStatus() {
    const robotStatuses = robots.map((vr) => vr.getStatus());
    return {
      enabled: simulatorEnabled,
      started,
      serverUrl,
      robotCount: robots.length,
      // STEP 4 — how many are actually ticking, alongside how many are held. The two can
      // differ (a robot added before `start()`, or a fleet between `stop()` and `start()`),
      // and a status snapshot that reported only the total invited the reader to assume they
      // were the same number.
      runningCount: robotStatuses.filter((entry) => entry.running === true).length,
      config: { ...config },
      robots: robotStatuses,
    };
  }

  /**
   * Transport-level detail about one managed robot, for verification (STEP 4).
   *
   * ── Why this exists, and why it returns values rather than the instance ──────
   * The reconnect finding is a property of the *emitter*: one delivered event reaching two
   * registered listeners. `getStatus()` cannot show it, because it reports the robot's
   * simulation state and a listener table is not that. `tools/verify/step4SimulationBehaviour.js`
   * needs it to establish something no in-process double can — that socket.io-client really
   * does reuse one `Socket` object across a reconnection, which is the premise the fix rests
   * on. A double that reconnected by constructing a fresh socket would make the fix look
   * unnecessary while the unit tests still passed.
   *
   * It returns counts and an opaque identity token, never the `VirtualRobot` or its socket.
   * Handing out the instance would make this an escape hatch through which anything could
   * reach in and mutate a running agent; handing out numbers keeps it an observation. The
   * socket identity is exposed as the transport's own id plus a monotonic counter of how many
   * distinct socket objects this robot has had, which is exactly enough to answer "was it
   * reused?" without exposing the object that would answer it.
   *
   * @param {string} robotId
   * @returns {{ robotId: string, running: boolean, connected: boolean, socketId: string|null,
   *             socketGeneration: number, listeners: Record<string, number> } | null}
   */
  function inspectTransport(robotId) {
    const vr = robots.find((r) => r.robotId === robotId);
    if (!vr) return null;
    return vr.inspectTransport();
  }

  /**
   * Apply simulator tunables (STEP 4).
   *
   * ── What this replaces ───────────────────────────────────────────────────────
   * A no-op with a comment reserving it for later, behind an endpoint that answered
   * `{ ok: true }` for a request it discarded. An operator tuning a demo therefore had no
   * way to make it repeatable and no way to discover that.
   *
   * ── The two categories are honoured, not flattened ───────────────────────────
   * `LIVE` parameters (tick period, obstacle rate) are pushed to robots that are already
   * running. `INITIAL` parameters (battery, position, speed centre, seed) are **not**:
   * they describe where a robot started, and rewriting them on a running instance would
   * fabricate history — a robot at 43 % jumping to 100 % would put a charge that never
   * happened into the telemetry stream. They apply to robots added afterwards, and the
   * return value says which did which so the caller does not have to guess.
   *
   * @param {unknown} requested
   * @returns {{ ok: true, config: object, appliedLive: string[], appliesToNewRobots: string[],
   *             robotsUpdated: number } | { ok: false, problems: string[] }}
   */
  function setConfig(requested) {
    const normalised = simulationConfig.normaliseConfig(requested);
    if (!normalised.ok) {
      log.warn("[VR] setConfig refused", { problems: normalised.problems });
      return normalised;
    }

    config = { ...config, ...normalised.config };

    let robotsUpdated = 0;
    if (normalised.live.length > 0) {
      for (const vr of robots) {
        let changed = false;
        if ("telemetryIntervalMs" in normalised.config) {
          changed = vr.setTelemetryInterval(normalised.config.telemetryIntervalMs) || changed;
        }
        if ("obstacleProbability" in normalised.config) {
          changed = vr.setObstacleProbability(normalised.config.obstacleProbability) || changed;
        }
        if (changed) robotsUpdated += 1;
      }
    }

    log.info("[VR] setConfig applied", {
      live: normalised.live,
      initial: normalised.initial,
      robotsUpdated,
    });

    return {
      ok: true,
      config: { ...config },
      appliedLive: normalised.live,
      appliesToNewRobots: normalised.initial,
      robotsUpdated,
    };
  }

  return {
    start,
    stop,
    reset,
    addRobot,
    removeRobot,
    getStatus,
    setConfig,
    inspectTransport,
    isEnabled: () => simulatorEnabled,
    // ── BATCH 2 ───────────────────────────────────────────────────────────────
    provisionCharging,
    // The scope predicate `services/chargingStatus.service.js` is composed with. Exposed
    // as a function rather than as the roster itself, so no caller can take a copy that
    // goes stale the moment a robot is added or retired.
    managesAgent,
    // The charger's occupancy, for diagnostics and the live verification harness.
    chargingStatus: () => devChargingScheduler.status(chargingDeps),
  };
}

module.exports = { createVirtualRobotSimulator };
