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
// Phase B (charging lifecycle) — the station estate (owner declaration + validation) and the
// choice of station for one robot.
const chargingStations = require("./chargingStations");
const chargerSelection = require("./chargerSelection");
// P7-D3 Step 1 — the campus route to the reserved charger, over the network the engine prices
// the return leg on.
const chargerRoute = require("./chargerRoute");

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
      // Phase E — the commissioned minimum reserve (`Robot.batteryReservePct`).
      batteryReservePct: row && typeof row.batteryReservePct === "number" ? row.batteryReservePct : null,
    },
    batteryState: agent && agent.batteryState ? agent.batteryState : null,
    // In `legEnergyWh`'s own naming. On this deployment every coefficient is null, so the
    // model refuses and names them — which is the whole reason the row is worth loading.
    energyModelParams: energyCoefficientsFrom(params),
  };
}

/** The `RobotStatus` values a row can hold (`prisma/schema.prisma`). @structural */
const ROBOT_STATUSES = Object.freeze(["IDLE", "ACTIVE", "PAUSED", "OFFLINE", "ERROR", "ISSUES"]);

/**
 * P7-D3 Step 2 — does the server hold this unit (P7-D1's operator STOP/PAUSE), read from its row?
 *
 * The hold is durable only server-side: `robots.controller.placeOperatorHold` writes PAUSED, or, for
 * an OFFLINE unit, `statusBeforeOffline` PAUSED (which a reconnect restores). The agent's own latch
 * is in memory and does not survive a restart, so a restarted simulated agent takes its hold from
 * here — otherwise it would come back IDLE and drive (to its charger) while an operator held it.
 *
 * `null` when the row does not say (no status, or a value this module does not know): the caller
 * must then not act as though the unit were free.
 *
 * @param {{ status?: string, statusBeforeOffline?: string|null }|null} row
 * @returns {boolean|null}
 */
function operatorHoldFrom(row) {
  if (!row || !ROBOT_STATUSES.includes(row.status)) return null;
  if (row.status === "PAUSED") return true;
  if (row.status !== "OFFLINE") return false;
  const before = row.statusBeforeOffline === undefined ? null : row.statusBeforeOffline;
  if (before === null) return false;
  if (!ROBOT_STATUSES.includes(before)) return null;
  return before === "PAUSED";
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
 * @param {() => object|null} [deps.deliveryDomainFor] P7-D3 Step 1 — the pinned
 *   delivery-domain declaration, read per request. The campus network a robot drives to its
 *   charger on is built from its extract, as the V1 composition's router is. Absent, every
 *   route to the charger is refused by name and no robot charges (none charges in place).
 */
function createVirtualRobotSimulator({
  prisma, kv, serverUrl, logger, enabled, runSerializable, selectForUpdate, isSerializationFailure, deliveryDomainFor,
  // Phase B — the owner's station declaration (the parsed JSON), injected by a test; otherwise
  // read from `SIMULATED_CHARGING_STATIONS_FILE` at provisioning (`chargingStations.loadDeclaration`).
  stationDeclaration,
} = {}) {
  const log   = logger || console;
  // P7-D3 Step 1 — one route provider for the fleet; extracts and networks are built once.
  const chargerRouter = chargerRoute.createChargerRouter({ deliveryDomainFor });
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
  /** D-6 — why the last provisioning failed (null when it succeeded or has not run). */
  let provisioningProblems = null;
  /**
   * Phase B — every declared station with its validation outcome, for status and the dashboard:
   * `{ chargerId, name, approved, lat, lon, plugCount, usable, problems, provisioned }`.
   */
  let stationCatalogue = [];
  /** Phase B — the instance of each managed agent, by `Agent.id` (for queue wait estimates). */
  const vrByAgentRowId = new Map();

  /** The pinned delivery-domain declaration, or null (never throws). */
  function pinnedDomain() {
    try {
      return typeof deliveryDomainFor === "function" ? deliveryDomainFor() : null;
    } catch {
      return null;
    }
  }

  /**
   * Phase B — the published estate's chargers with their rows and live load: plug count, the
   * remaining charge time of each active session (from the robots charging there), and the
   * agents queued, in FIFO order.
   */
  async function estateLoad() {
    const estate = await devChargingScheduler.publishedEstate(chargingDeps);
    if (!estate.ok) return [];
    const out = [];
    for (const entry of estate.chargers) {
      // eslint-disable-next-line no-await-in-loop
      const row = await prisma.charger.findUnique({ where: { chargerId: entry.chargerId } });
      // eslint-disable-next-line no-await-in-loop
      const live = row
        ? await prisma.chargerReservation.findMany({
          where: { chargerDbId: row.id, state: { in: devChargingScheduler.LIVE_STATES } },
          orderBy: [{ reservedFrom: "asc" }, { reservationId: "asc" }],
        })
        : [];
      const active = live.filter((r) => r.state === devChargingScheduler.RESERVATION_STATE.ACTIVE);
      const queued = live.filter((r) => r.state === devChargingScheduler.RESERVATION_STATE.QUEUED);
      out.push({
        chargerId: entry.chargerId,
        row,
        plugCount: entry.plugCount,
        isDepot: entry.isDepot,
        activeAgents: active.map((r) => r.agentId),
        queuedAgents: queued.map((r) => r.agentId),
        activeRemainingS: active.map((r) => {
          const vr = vrByAgentRowId.get(r.agentId);
          return vr && typeof vr.chargeSecondsRemaining === "function" ? vr.chargeSecondsRemaining() : null;
        }),
      });
    }
    return out;
  }

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
  function chargingClientFor(agentRowId, permissionSet, packNominalWh) {
    /**
     * Phase B — the station for a new session: reachable (contained campus route), keeping the
     * reserve where possible, soonest to start charging (`chargerSelection`). `context` is what
     * the robot knows about itself; without it (an older caller) the depot is asked for.
     */
    async function chooseStation(context) {
      if (!context || !context.from) return { chargerId: devChargingScheduler.DEVELOPMENT_CHARGER.chargerId, selection: null };
      const load = await estateLoad();
      // Nothing published: not a routing question. The depot is asked for, and the scheduler's
      // refusal (with the provisioning problems) says why no plug can be had.
      if (load.length === 0) return { chargerId: devChargingScheduler.DEVELOPMENT_CHARGER.chargerId, selection: null };
      const candidates = load.map((entry) => {
        const routed = chargerRouter.routeToCharger({ chargerRow: entry.row, from: context.from, permissionSet });
        return routed.ok
          ? { chargerId: entry.chargerId, distanceM: routed.distanceM, plugCount: entry.plugCount, activeRemainingS: entry.activeRemainingS, queued: entry.queuedAgents.length }
          : { chargerId: entry.chargerId, refusal: routed.refusal, reason: routed.reason };
      });
      const selection = chargerSelection.selectStation({ candidates, robot: context });
      return { chargerId: selection.chosen ? selection.chosen.chargerId : null, selection };
    }

    return {
      async request(targetSoc, context) {
        // A robot that already holds a plug anywhere in the estate keeps it (idempotent); only a
        // new session chooses a station.
        let existing = await devChargingScheduler.liveReservationFor(chargingDeps, agentRowId);
        let chargerId = devChargingScheduler.DEVELOPMENT_CHARGER.chargerId;
        let selection = null;
        if (existing && existing.chargerDbId) {
          // A reservation at a charger that has LEFT the published estate can never be served: it is
          // not this robot's plug any more. The scheduler releases it (CHARGER_SUPERSEDED, its own
          // grants only) when the request below runs; the robot chooses a usable station instead.
          const estate = await devChargingScheduler.publishedEstate(chargingDeps);
          const heldRow = await prisma.charger.findUnique({ where: { id: existing.chargerDbId } });
          if (estate.ok && heldRow && !estate.chargers.some((entry) => entry.chargerId === heldRow.chargerId)) existing = null;
        }
        if (existing) {
          // The plug it holds is at the reservation's OWN charger, and that is the charger this
          // request and the promotion pass below are about. Naming the depot here left a robot
          // queued at a station waiting for ever when the estate had no depot — the depot's
          // capacity is unpublished, so the restated request was refused every tick and the
          // robot never heard its promotion (measured: RNSIT owner stations, includeDepot false).
          const heldRow = existing.chargerDbId ? await prisma.charger.findUnique({ where: { id: existing.chargerDbId } }) : null;
          if (heldRow && heldRow.chargerId) chargerId = heldRow.chargerId;
        } else {
          const chosen = await chooseStation(context);
          selection = chosen.selection;
          if (!chosen.chargerId) {
            const reasons = selection ? selection.excluded.map((e) => `${e.chargerId}: ${e.reason}`) : [];
            return {
              state: null,
              retryable: false,
              blockedCode: "ROUTE_REFUSED",
              problems: reasons.length > 0 ? [`no charging station is reachable — ${reasons.join("; ")}`] : ["no charging station is published"],
            };
          }
          chargerId = chosen.chargerId;
        }
        const verdict = await devChargingScheduler.requestPlug(chargingDeps, {
          agentRowId,
          targetSoc,
          nowMs: Date.now(),
          // D-7 — the reservation window is sized for this agent's commissioned pack.
          packNominalWh,
          // Phase B — the chosen station.
          chargerId,
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
          // D-6 — with the reason provisioning failed, when it did: "no projection" alone does
          // not tell an operator that the charger row itself is missing.
          return {
            state: null,
            retryable: verdict.retryable === true,
            problems: [...(verdict.problems || []), ...(provisioningProblems || [])],
          };
        }
        // A newly queued robot is promoted by the same pass everybody else is, so the
        // request does not grant its own plug. Running the pass here keeps the common
        // case — a free plug and an empty queue — one round trip rather than one tick.
        await devChargingScheduler.promote(chargingDeps, { nowMs: Date.now(), chargerId });
        const held = await devChargingScheduler.liveReservationFor(chargingDeps, agentRowId);
        return { state: held ? held.state : "NONE", problems: [], chargerId, urgent: Boolean(selection && selection.urgent) };
      },
      async release(reason) {
        return devChargingScheduler.release(chargingDeps, { agentRowId, nowMs: Date.now(), reason });
      },
      async state() {
        const live = await devChargingScheduler.liveReservationFor(chargingDeps, agentRowId);
        return { state: live ? live.state : "NONE" };
      },
      /**
       * P7-D3 Step 2 — the live reservation this agent may adopt after a restart, or why not. A
       * read: it grants, extends and releases nothing (`devChargingScheduler.reservationForRecovery`).
       */
      async reservationAtRestart() {
        return devChargingScheduler.reservationForRecovery(chargingDeps, { agentRowId, nowMs: Date.now() });
      },
      /**
       * P7-D3 Step 1 — the campus route from `from` to the declared charger's own coordinate,
       * over this robot's class's permitted ways, or a refusal by name. The charger row is read
       * fresh, so the robot is routed to the row as it is now, never to a remembered one.
       */
      /**
       * Phase E — the campus route length from `from` to the nearest usable charger, for the
       * robot's early-trigger check (`VirtualRobot._chargerOutOfReach`). A read: nothing is
       * reserved. `{ ok: false }` when no usable charger can be routed to.
       */
      async chargerTripEstimate(from) {
        // Phase B — the nearest (by campus route) usable charger of the estate.
        const estate = await devChargingScheduler.publishedEstate(chargingDeps);
        const ids = estate.ok && estate.chargers.length > 0 ? estate.chargers.map((e) => e.chargerId) : [devChargingScheduler.DEVELOPMENT_CHARGER.chargerId];
        let best = null;
        let lastRefusal = null;
        for (const chargerId of ids) {
          // eslint-disable-next-line no-await-in-loop
          const chargerRow = await prisma.charger.findUnique({ where: { chargerId } });
          const routed = chargerRouter.routeToCharger({ chargerRow, from, permissionSet });
          if (routed.ok && (!best || routed.distanceM < best.distanceM)) best = { ok: true, chargerId, distanceM: routed.distanceM };
          if (!routed.ok) lastRefusal = routed;
        }
        return best || { ok: false, refusal: lastRefusal ? lastRefusal.refusal : "NO_CHARGER", reason: lastRefusal ? lastRefusal.reason : "no charger is published" };
      },
      async routeToCharger(from) {
        // Phase B — the route to the charger this agent HOLDS a plug at; the depot when it holds
        // none (an older caller asks for the route before reserving).
        const held = await devChargingScheduler.liveReservationFor(chargingDeps, agentRowId);
        const chargerRow = held && held.chargerDbId
          ? await prisma.charger.findUnique({ where: { id: held.chargerDbId } })
          : await prisma.charger.findUnique({ where: { chargerId: devChargingScheduler.DEVELOPMENT_CHARGER.chargerId } });
        return chargerRouter.routeToCharger({ chargerRow, from, permissionSet });
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
      // Step D — OPT-IN (`SIM_CHARGER_PROJECTION_REFRESH_SECONDS`): republish the estate's
      // occupancy so `E_return` can price against the projection instead of its DEPOT_ONLY fallback.
      const refresh = devChargingScheduler.projectionRefreshSeconds();
      if (refresh.problem) log.warn("[VR] charger projection refresh", { problem: refresh.problem });
      schedulerTimer = setInterval(() => {
        const nowMs = Date.now();
        devChargingScheduler
          .reconcile(chargingDeps, { nowMs })
          .then(() => (refresh.enabled ? devChargingScheduler.refreshProjection(chargingDeps, { nowMs, refreshAfterSeconds: refresh.seconds }) : null))
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

    // Phase B — the owner's station declaration: each approved station's coordinate is validated
    // against the pinned delivery domain and the campus network (reachable from the depot, the
    // whole route inside the domain) before it is offered to the scheduler. Unapproved or invalid
    // stations stay in the catalogue with their problems, never in the estate.
    const declared = stationDeclaration !== undefined
      ? chargingStations.normaliseDeclaration(stationDeclaration, "injected")
      : chargingStations.loadDeclaration();
    const domain = pinnedDomain();
    const depotRow = await prisma.charger.findUnique({ where: { chargerId: devChargingScheduler.DEVELOPMENT_CHARGER.chargerId } });
    const reference = depotRow && Number.isFinite(depotRow.latitude) && Number.isFinite(depotRow.longitude)
      ? { lat: depotRow.latitude, lon: depotRow.longitude }
      : null;
    stationCatalogue = declared.stations.map((station) => {
      const verdict = chargingStations.validateStation({ station, declaration: domain, reference });
      const problems = [...verdict.problems];
      if (verdict.usable && !reference) problems.push({ code: "NOT_REACHABLE", detail: "no depot coordinate to test reachability from" });
      return { ...station, usable: problems.length === 0, problems, cellId: verdict.cellId, accessM: verdict.accessM, provisioned: false };
    });
    const offered = stationCatalogue
      .filter((station) => station.usable)
      .map((station) => ({ chargerId: station.chargerId, lat: station.lat, lon: station.lon, cellId: station.cellId, regionId: station.regionId, plugCount: station.plugCount }));

    const provisioned = await devChargingScheduler.provision({ prisma }, { nowMs, stations: offered, includeDepot: declared.includeDepot });
    for (const outcome of provisioned.stations || []) {
      const entry = stationCatalogue.find((station) => station.chargerId === outcome.chargerId);
      if (!entry) continue;
      entry.provisioned = outcome.usable;
      if (!outcome.usable) {
        entry.usable = false;
        entry.problems = [...entry.problems, ...outcome.problems.map((detail) => ({ code: "NOT_PROVISIONED", detail }))];
      }
    }
    if (declared.problems.length > 0) log.warn("[VR] charging station declaration problems", { source: declared.source, problems: declared.problems });
    if (!provisioned.ok) {
      provisioningProblems = Array.isArray(provisioned.problems) ? provisioned.problems : null;
      log.warn("[VR] development charger not provisioned", { problems: provisioned.problems });
      return provisioned;
    }
    provisioningProblems = null;

    // Restart reconciliation, before the first robot asks for anything. A process that
    // died with three robots ACTIVE left three occupied plugs and no in-memory state;
    // without this the charger is full forever and every request queues behind agents that
    // are gone.
    const reconciled = await devChargingScheduler.reconcile(chargingDeps, { nowMs });

    log.info("[VR] development charging scheduler ready", {
      chargerId: devChargingScheduler.DEVELOPMENT_CHARGER.chargerId,
      plugCount: devChargingScheduler.DEVELOPMENT_CHARGER.plugCount,
      // Phase B — the declared stations and whether each is in the estate.
      stations: stationCatalogue.map((station) => ({ chargerId: station.chargerId, approved: station.approved, usable: station.usable, problems: station.problems.map((x) => x.code) })),
      projectionVersion: provisioned.projectionVersion,
      publishedNewVersion: provisioned.published,
      staleReservationsExpired: reconciled.expired,
      // P7-D3 Step 0 — live reservations left at the superseded development charger.
      supersededReservationsReleased: reconciled.superseded,
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
            // Phase E — the commissioned reserve, read with the rest of the specification.
            batteryReservePct: true,
            // P7-D3 Step 2 — the server-side operator hold (`operatorHoldFrom`).
            status: true,
            statusBeforeOffline: true,
            agent: {
              select: {
                // BATCH 2 — the `Agent` primary key. `ChargerReservation.agentId` is a
                // foreign key to it, so the charging client cannot be bound without it.
                // A String uuid, so the BigInt-serialisation hazard the comment above
                // names does not apply.
                id: true,
                // Soft retirement — `simulationPolicy.maySpawnVirtualRobot` refuses a row
                // whose Agent is DECOMMISSIONED, which is what keeps a retired simulated
                // unit from being re-hydrated at boot.
                lifecycleState: true,
                batteryState: {
                  select: { kappa: true, kappaSampleCount: true, soh: true, lastObservedSoc: true },
                },
                agentClass: {
                  select: {
                    // P7-D3 Step 1 — `permissionSet`: the ways this class may drive to its charger on.
                    mobilityModel: { select: { kinematicLimits: true, speedModel: true, permissionSet: true } },
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
      // Phase E — the charge trigger, when one has been configured for this process.
      chargeTriggerPct:    config.chargeTriggerPct,
      // A configured seed is *offset by the robot id* rather than used directly. Handing
      // every robot the same seed would make them move identically — synchronised jitter
      // across the fleet — which is the opposite of the independence a seed is set for. The
      // seed pins the *run*; the id still separates the robots within it.
      randomSeed:
        Number.isFinite(config.randomSeed)
          ? (config.randomSeed ^ hashSeed(robotId)) >>> 0
          : undefined,
      telemetrySequenceFloor,
      // P7-D3 Step 2 — the server's hold on this unit; `null` when the row cannot say.
      operatorHoldAtStart: operatorHoldFrom(row),
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
        prisma && row && row.agent && row.agent.id
          ? chargingClientFor(
              row.agent.id,
              (row.agent.agentClass && row.agent.agentClass.mobilityModel && row.agent.agentClass.mobilityModel.permissionSet) || null,
              specificationInputsFor(row).specification.packNominalWh,
            )
          : null,
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
    if (row && row.agent && row.agent.id) vrByAgentRowId.set(row.agent.id, vr);

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
    for (const [agentRowId, instance] of vrByAgentRowId) {
      if (instance === robots[idx]) vrByAgentRowId.delete(agentRowId);
    }
    robots.splice(idx, 1);
    log.info(`[VR] ${robotId} virtual robot removed`);
  }

  // ── Introspection ───────────────────────────────────────────────────────────

  /**
   * Phase B / dashboard — the charging estate as the operator sees it, and each queued robot's
   * place in its queue.
   *
   *   stations: the depot and every declared station — approved or not, usable or not, with the
   *             problems that keep it out — each with its plug count, occupancy and queue length.
   *             A station with no approved coordinate is listed with no coordinate.
   *   robots:   robotId → { stationName, queuePosition (1 = next; 0 = on a plug), estimatedWaitS },
   *             the wait from `chargerSelection.expectedWaitSeconds` (null when unknown).
   *
   * @returns {Promise<{ stations: object[], robots: object, provenance: string }>}
   */
  async function chargingOverview() {
    const load = prisma ? await estateLoad() : [];
    const loadById = new Map(load.map((entry) => [entry.chargerId, entry]));
    const depotId = devChargingScheduler.DEVELOPMENT_CHARGER.chargerId;
    const nameOf = (chargerId) => {
      if (chargerId === depotId) return devChargingScheduler.DEVELOPMENT_CHARGER.name;
      const declared = stationCatalogue.find((station) => station.chargerId === chargerId);
      return declared ? declared.name : chargerId;
    };
    const occupancy = (entry) => (entry
      ? { inEstate: true, plugCount: entry.plugCount, active: entry.activeAgents.length, queued: entry.queuedAgents.length }
      : { inEstate: false, plugCount: null, active: 0, queued: 0 });

    const stations = [];
    const depotLoad = loadById.get(depotId);
    if (depotLoad) {
      stations.push({
        chargerId: depotId,
        name: nameOf(depotId),
        isDepot: true,
        approved: true,
        usable: true,
        lat: depotLoad.row ? depotLoad.row.latitude : null,
        lon: depotLoad.row ? depotLoad.row.longitude : null,
        problems: [],
        ...occupancy(depotLoad),
      });
    }
    for (const station of stationCatalogue) {
      const entry = loadById.get(station.chargerId);
      // The coordinate the owner DECLARED, for display only — when it is a well-formed WGS-84
      // pair (never a malformed one, never a guessed one). `lat`/`lon` stay the position of a
      // station that can serve robots, and are null for every other: a declared position is
      // not a usable charger, and the dashboard draws it as inactive with its problems.
      const declaredWellFormed = Number.isFinite(station.lat) && Number.isFinite(station.lon) &&
        Math.abs(station.lat) <= 90 && Math.abs(station.lon) <= 180 &&
        !(station.problems || []).some((p) => p && (p.code === "MALFORMED_COORDINATE" || p.code === "NO_COORDINATE"));
      stations.push({
        chargerId: station.chargerId,
        name: station.name,
        isDepot: false,
        approved: station.approved,
        usable: station.usable && Boolean(entry),
        lat: station.usable ? station.lat : null,
        lon: station.usable ? station.lon : null,
        declaredLat: declaredWellFormed ? station.lat : null,
        declaredLon: declaredWellFormed ? station.lon : null,
        problems: station.problems,
        ...occupancy(entry),
      });
    }

    const robotsInfo = {};
    for (const entry of load) {
      for (const agentRowId of entry.activeAgents) {
        const vr = vrByAgentRowId.get(agentRowId);
        if (vr) robotsInfo[vr.robotId] = { stationName: nameOf(entry.chargerId), queuePosition: 0, estimatedWaitS: 0 };
      }
      entry.queuedAgents.forEach((agentRowId, index) => {
        const vr = vrByAgentRowId.get(agentRowId);
        if (!vr) return;
        robotsInfo[vr.robotId] = {
          stationName: nameOf(entry.chargerId),
          queuePosition: index + 1,
          estimatedWaitS: chargerSelection.expectedWaitSeconds({ plugCount: entry.plugCount, activeRemainingS: entry.activeRemainingS, queued: index }),
        };
      });
    }
    return { stations, robots: robotsInfo, provenance: "DEVELOPMENT_SIMULATION" };
  }

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
        if ("chargeTriggerPct" in normalised.config && typeof vr.setChargeTriggerPct === "function") {
          changed = vr.setChargeTriggerPct(normalised.config.chargeTriggerPct) || changed;
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
    // Phase B / dashboard — stations, occupancy and queue positions.
    chargingOverview,
  };
}

module.exports = { createVirtualRobotSimulator, operatorHoldFrom };
