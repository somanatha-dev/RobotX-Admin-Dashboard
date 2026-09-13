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
 * @param {object} deps
 * @param {boolean} [deps.enabled] the process-level posture; defaults to
 *   `simulationPolicy.isSimulatorEnabled()`, i.e. `ENABLE_VIRTUAL_SIMULATOR=true`, off
 *   otherwise. Injected so the composition root can state it once and so a test need not
 *   mutate `process.env`.
 */
function createVirtualRobotSimulator({ prisma, kv, serverUrl, logger, enabled } = {}) {
  const log   = logger || console;
  const simulatorEnabled =
    typeof enabled === "boolean" ? enabled : simulationPolicy.isSimulatorEnabled();
  let robots  = [];
  let started = false;
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

    const running = robots.filter((vr) => vr.isRunning()).length;
    log.info(
      wasStarted
        ? `[VR] Simulator start — ${revived} robot(s) (re)started, ${running}/${robots.length} running`
        : `[VR] Simulator ready — ${running}/${robots.length} simulated robot(s) running`,
    );
    return { started: true, running, total: robots.length, reason: null };
  }

  function stop() {
    started = false;
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
      // ── STEP 3: the commissioned specification, and the persisted pack state ──
      // Read from the row above. Every field is `null` when the unit has no commissioned
      // value, and `VirtualRobot` then falls back to the module constant — a fallback
      // fills a gap and never overrides a value that is present.
      ...specificationInputsFor(row),
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
  };
}

module.exports = { createVirtualRobotSimulator };
