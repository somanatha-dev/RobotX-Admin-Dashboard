/**
 * VirtualRobot
 *
 * Behaves identically to a physical robot:
 *   - Connects as a Socket.IO client (same AUTH / TELEMETRY flow as real hardware)
 *   - Receives TASK_ASSIGN → navigates path → emits TASK_COMPLETE
 *   - Battery drains at real-time rates; level is persisted to Redis every 2 min
 *   - On server restart the last-known battery is restored from Redis (or DB fallback)
 *   - Speed uses an EMA-smoothed model: realistic 1.4 m/s ± jitter (no per-tick random jumps)
 */

const { io: ioClient } = require("socket.io-client");
const crypto = require("crypto");
const rootLogger = require("../config/logger");
const { haversineMeters } = require("../utils/distance");

const {
  SESSION_TTL_SEC,
  TELEMETRY_INTERVAL_MS,
  MOVE_STEP_METERS,
  SPEED_BASE_MS,
  SPEED_JITTER,
  SPEED_EMA_ALPHA,
  SPEED_MIN_MS,
  SPEED_MAX_MS,
  BATTERY_DRAIN_ACTIVE,
  BATTERY_DRAIN_IDLE,
  BATTERY_WARN_THRESHOLD,
  BATTERY_CRITICAL_THRESHOLD,
  BATTERY_MIN,
  CHARGING_WAIT_MS,
  CHARGING_RATE_PER_TICK,
  CHARGING_INTERRUPT_BATTERY,
  BATTERY_PERSIST_TICKS,
  OBSTACLE_PROBABILITY,
  PICKUP_WAIT_MS,
  DROP_WAIT_MS,
  RECONNECT_DELAY_MS,
} = require("./constants");

// Redis key for persisting battery across restarts (separate from live-state key)
const batteryKey = (robotId) => `vr:battery:${robotId}`;
const BATTERY_KEY_TTL = 48 * 3600; // 48 h — survives overnight / weekend downtime

class VirtualRobot {
  constructor({ robotId, lat, lon, logger, kv, dbBattery } = {}) {
    this.robotId = robotId;
    this.lat = lat;
    this.lon = lon;

    // Battery starts at the last persisted level once commission() runs.
    // dbBattery is the DB fallback passed in by SimulationEngine.
    this.battery = 100;
    this._dbBattery = typeof dbBattery === "number" ? dbBattery : null;

    this.speed  = 0;
    this.status = "IDLE";
    this.log    = logger || console;

    // ── Battery persistence ────────────────────────────────────────────────
    // kv is stored so _tick() can write the periodic battery snapshot.
    this.kv = kv || null;
    this._batteryPersistTicks = 0;

    // ── Speed model ────────────────────────────────────────────────────────
    // EMA-smoothed speed — starts at rest, ramps up as robot begins moving.
    this._targetSpeed = SPEED_BASE_MS;

    // ── Task navigation ────────────────────────────────────────────────────
    this.task        = null;   // { taskId, pathToPickup, pathToDrop }
    this.phase       = null;   // TO_PICKUP | WAIT_PICKUP | TO_DROP | WAIT_DROP
    this.pathIndex   = 0;
    this.waitUntil   = null;
    this.activePath  = null;
    this.distanceTravelled = 0;
    this._heading    = null;   // degrees clockwise from north (for marker rotation)

    // ── Charging ───────────────────────────────────────────────────────────
    this._chargingPhase    = null;   // null | 'WAITING' | 'CHARGING'
    this._chargeWaitUntil  = null;
    this._pendingResume    = null;   // TASK_ASSIGN payload deferred while charging on low battery

    // ── Socket ────────────────────────────────────────────────────────────
    this.socket             = null;
    this.sessionToken       = null;
    this.connected          = false;
    this._handlersRegistered = false;
    this._timer             = null;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Seed Redis with session token and restore the last-known battery level.
   *
   * Priority:  Redis vr:battery key  →  DB value  →  100 % (full charge)
   *
   * The robot record in PostgreSQL was already created by the Commission API
   * before addRobot() is called — do NOT touch DB here.
   */
  async commission(kv) {
    this.kv           = kv;
    this.sessionToken = crypto.randomUUID();

    // 1) Session token (enables AUTH on connect)
    await kv.set(`session:${this.robotId}`, this.sessionToken, { ex: SESSION_TTL_SEC });

    // 2) Restore battery
    let source = "default (100%)";
    let restoredBattery = null;

    try {
      const raw = await kv.get(batteryKey(this.robotId));
      if (raw !== null && raw !== undefined) {
        const v = parseFloat(raw);
        if (Number.isFinite(v) && v >= 1 && v <= 100) {
          restoredBattery = v;
          source = `Redis (${v.toFixed(1)}%)`;
        }
      }
    } catch { /* Redis unavailable — fall through */ }

    if (restoredBattery === null && this._dbBattery !== null) {
      restoredBattery = this._dbBattery;
      source = `DB (${this._dbBattery.toFixed(1)}%)`;
    }

    this.battery = restoredBattery !== null ? restoredBattery : 100;

    // 3) Seed live-state key so DTARO / dashboard see the robot immediately
    await Promise.all([
      kv.set(
        `robot:${this.robotId}`,
        JSON.stringify({
          lat:        this.lat,
          lon:        this.lon,
          battery:    Math.round(this.battery),
          status:     "IDLE",
          speed:      0,
          lastSeenAt: Date.now(),
        }),
        { ex: 30 }
      ),
      typeof kv.sadd === "function"
        ? kv.sadd("robots:all", this.robotId)
        : Promise.resolve(),
    ]);

    this.log.info(`[VR] ${this.robotId} commissioned — battery restored from ${source}`);
  }

  connect(serverUrl) {
    this.socket = ioClient(serverUrl, {
      reconnection:         true,
      reconnectionDelay:    RECONNECT_DELAY_MS,
      reconnectionDelayMax: 10_000,
      reconnectionAttempts: Infinity,
      transports:           ["websocket"],
    });

    this.socket.on("connect", () => {
      this.connected = true;
      this.log.info(`[VR] ${this.robotId} connected — sending AUTH`);
      this.socket.emit("AUTH", { robotId: this.robotId, token: this.sessionToken });
    });

    this.socket.on("disconnect", (reason) => {
      this.connected = false;
      this._handlersRegistered = false;
      this.log.info(`[VR] ${this.robotId} disconnected (${reason})`);
    });

    this.socket.on("AUTH_SUCCESS", ({ token } = {}) => {
      if (token) this.sessionToken = token;
      this.log.info(`[VR] ${this.robotId} AUTH_SUCCESS`);
      this._registerHandlers();
    });

    // Backward-compatible alias
    this.socket.on("AUTH_OK", ({ token } = {}) => {
      if (token && !this._handlersRegistered) {
        this.sessionToken = token;
        this._registerHandlers();
      }
    });

    this.socket.on("AUTH_REQUIRED", () => {
      this.socket.emit("AUTH", { robotId: this.robotId, token: this.sessionToken });
    });
  }

  _registerHandlers() {
    if (this._handlersRegistered) return;
    this._handlersRegistered = true;

    this.socket.on("TASK_ASSIGN", (payload) => this._onTaskAssign(payload));
    this.socket.on("REROUTE_ALERT", (payload) => this._onRerouteAlert(payload));

    // Operator commands. The server persists a Command row and dispatches
    // "COMMAND" with the row's id; acknowledging it with COMMAND_ACK is what
    // moves that row from SENT to ACK. Without this listener every operator
    // command against a virtual robot went unanswered and was marked FAILED
    // by the reliability scheduler ~15s later.
    this.socket.on("COMMAND", (payload) => this._onCommand(payload));

    // Direct task-lifecycle stop (task cancellation) — not a tracked Command,
    // no ACK expected.
    this.socket.on("STOP", () => this._applyStop("STOP"));

    // Retained for robots/tooling that still speak the older direct event.
    this.socket.on("RETURN_TO_BASE", () => this._applyReturnToBase("RETURN_TO_BASE"));
  }

  // ── Operator commands ──────────────────────────────────────────────────────

  /**
   * Handle a COMMAND from the operator console and acknowledge it.
   * Types mirror the Prisma CommandType enum: STOP | PAUSE | RETURN | RESUME.
   */
  _onCommand(payload) {
    const commandId = payload?.commandId;
    const type = typeof payload?.type === "string" ? payload.type.toUpperCase() : null;

    switch (type) {
      case "STOP":
      case "PAUSE":
        this._applyStop(type);
        break;
      case "RETURN":
        this._applyReturnToBase(type);
        break;
      case "RESUME":
        this._applyResume();
        break;
      default:
        this.log.warn(`[VR] ${this.robotId} ignoring unknown COMMAND type ${type}`);
        return; // unknown type — deliberately not acknowledged
    }

    if (commandId) {
      try {
        this.socket.emit("COMMAND_ACK", { commandId, robotId: this.robotId, timestamp: Date.now() });
      } catch { /* ignore */ }
    }
  }

  /** Halt movement. The task is retained so RESUME can pick it back up. */
  _applyStop(label) {
    if (this.status !== "CHARGING") this.status = "PAUSED";
    this.speed = 0;
    this.log.info(`[VR] ${this.robotId} ${label}`);
  }

  /** Abandon the current task entirely and go idle. */
  _applyReturnToBase(label) {
    this._clearTask();
    this._clearCharging();
    this._pendingResume = null;
    this.status = "IDLE";
    this.speed  = 0;
    this.log.info(`[VR] ${this.robotId} ${label}`);
  }

  /** Resume a task halted by STOP/PAUSE; otherwise just return to IDLE. */
  _applyResume() {
    if (this.status === "CHARGING") {
      this.log.info(`[VR] ${this.robotId} RESUME ignored — still charging`);
      return;
    }
    this.status = this.task && this.phase ? "ACTIVE" : "IDLE";
    this.log.info(`[VR] ${this.robotId} RESUME → ${this.status}`);
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._tick(), TELEMETRY_INTERVAL_MS);
    if (typeof this._timer.unref === "function") this._timer.unref();
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    try { this.socket?.disconnect(); } catch { /* ignore */ }
    this.socket             = null;
    this.connected          = false;
    this._handlersRegistered = false;
    this.log.info(`[VR] ${this.robotId} stopped`);
  }

  reset() {
    this._clearTask();
    this._clearCharging();
    this._pendingResume = null;
    this.status = "IDLE";
    this.speed  = 0;
    this.log.info(`[VR] ${this.robotId} reset`);
  }

  getStatus() {
    return {
      robotId:       this.robotId,
      lat:           this.lat,
      lon:           this.lon,
      battery:       Math.round(this.battery * 10) / 10,
      speed:         Math.round(this.speed * 100) / 100,
      status:        this.status,
      phase:         this.phase,
      taskId:        this.task?.taskId || null,
      connected:     this.connected,
      chargingPhase: this._chargingPhase,
      pendingResumeTaskId: this._pendingResume?.taskId || null,
    };
  }

  // ── Task handlers ──────────────────────────────────────────────────────────

  _onTaskAssign(payload) {
    const { taskId, pathToPickup, pathToDrop } = payload || {};
    if (!taskId) return;

    if (this.status === "CHARGING") {
      if (this.battery < CHARGING_INTERRUPT_BATTERY) {
        // Too low to interrupt charging — defer the assignment instead of
        // discarding it. Without this, a task recovered after a restart
        // (redispatched while the robot has already auto-docked on a
        // critically low persisted battery) would be silently dropped
        // forever, leaving the DB task stuck at ASSIGNED with no robot
        // ever picking it back up.
        this._pendingResume = { taskId, pathToPickup, pathToDrop };
        this.log.warn(
          `[VR] ${this.robotId} TASK_ASSIGN ${taskId} deferred — battery ${this.battery.toFixed(1)}% too low, will resume once fully charged`
        );
        return;
      }
      this._clearCharging();
      this.log.info(`[VR] ${this.robotId} charging interrupted by TASK_ASSIGN`);
    }

    // A fresh, real assignment supersedes anything that was only queued.
    this._pendingResume = null;

    this.task = {
      taskId,
      pathToPickup: Array.isArray(pathToPickup) ? pathToPickup : [],
      pathToDrop:   Array.isArray(pathToDrop)   ? pathToDrop   : [],
    };
    this.phase             = "TO_PICKUP";
    this.waitUntil         = null;
    this.activePath        = this.task.pathToPickup;
    this.status            = "ACTIVE";
    this.distanceTravelled = 0;

    // Snap to nearest point on the path.
    //
    // Two scenarios handled by the same algorithm:
    //   A) Fresh assignment — robot is inside campus (off-road).
    //      path[0] is Mapbox-snapped to the nearest road.
    //      → robot teleports to path[0] (on-road) and starts moving.
    //
    //   B) Restart resume — robot's last DB position is somewhere along the route.
    //      recoverActiveTasks re-computes a fresh route from that position,
    //      so path[0] IS the robot's current road position.
    //      → robot resumes from where it left off (no backtrack to route start).
    const snapIdx = this._findNearestPathIndex(this.task.pathToPickup, this.lat, this.lon);
    this.pathIndex = snapIdx;
    const snapPt = this.task.pathToPickup[snapIdx];
    if (snapPt && typeof snapPt.lat === "number") {
      this.lat = snapPt.lat;
      this.lon = snapPt.lon;
    }

    this.log.info(
      `[VR] ${this.robotId} TASK_ASSIGN ${taskId} — snapped to path[${snapIdx}]/${this.task.pathToPickup.length}`
    );
  }

  /** Find the index of the path waypoint closest to (lat, lon). */
  _findNearestPathIndex(path, lat, lon) {
    if (!Array.isArray(path) || path.length === 0) return 0;
    if (typeof lat !== "number" || typeof lon !== "number") return 0;
    let minDist = Infinity;
    let minIdx  = 0;
    for (let i = 0; i < path.length; i++) {
      const pt = path[i];
      if (typeof pt?.lat !== "number" || typeof pt?.lon !== "number") continue;
      const d = haversineMeters(lat, lon, pt.lat, pt.lon);
      if (d < minDist) { minDist = d; minIdx = i; }
    }
    return minIdx;
  }

  _onRerouteAlert(payload) {
    // If backend computed a fresh Mapbox path, replace activePath entirely
    if (Array.isArray(payload?.newPath) && payload.newPath.length > 1) {
      const segment = payload.segment || "toPickup";
      this.activePath = payload.newPath;
      this.pathIndex  = 0;
      // Keep task.pathToPickup / pathToDrop consistent for phase transitions
      if (this.task) {
        if (segment === "toDrop") {
          this.task.pathToDrop = payload.newPath;
        } else {
          this.task.pathToPickup = payload.newPath;
        }
      }
      this.log.info(`[VR] ${this.robotId} REROUTE → full path (${payload.newPath.length} pts, ${segment})`);
      return;
    }

    // Fallback: skip ahead past the obstacle in the current path
    if (!this.activePath || !payload?.obstacleLocation) return;
    const obs      = payload.obstacleLocation;
    const SKIP_DEG = 0.0003;
    let idx = this.pathIndex;
    while (
      idx < this.activePath.length - 1 &&
      Math.abs((this.activePath[idx]?.lat || 0) - obs.lat) < SKIP_DEG &&
      Math.abs((this.activePath[idx]?.lon || 0) - obs.lon) < SKIP_DEG
    ) { idx++; }
    if (idx > this.pathIndex) {
      this.pathIndex = idx;
      this.log.info(`[VR] ${this.robotId} REROUTE fallback → skip to index ${idx}`);
    }
  }

  _clearTask() {
    this.task       = null;
    this.phase      = null;
    this.pathIndex  = 0;
    this.waitUntil  = null;
    this.activePath = null;
  }

  _clearCharging() {
    this._chargingPhase   = null;
    this._chargeWaitUntil = null;
  }

  // ── Charging state machine ────────────────────────────────────────────────

  _enterCharging() {
    this.status          = "CHARGING";
    this._chargingPhase  = "WAITING";
    this._chargeWaitUntil = Date.now() + CHARGING_WAIT_MS;
    this.speed           = 0;
    this.log.info(
      `[VR] ${this.robotId} battery critical (${this.battery.toFixed(1)}%) — docking to charge`
    );
  }

  _handleCharging(nowMs) {
    if (this.status !== "CHARGING") return;

    if (this._chargingPhase === "WAITING") {
      if (nowMs >= (this._chargeWaitUntil || 0)) {
        this._chargingPhase = "CHARGING";
        this.log.info(`[VR] ${this.robotId} charging current flowing`);
      }
      return;
    }

    if (this._chargingPhase === "CHARGING") {
      this.battery = Math.min(100, this.battery + CHARGING_RATE_PER_TICK);
      if (this.battery >= 100) {
        this.battery = 100;
        this.status  = "IDLE";
        this._clearCharging();

        const pending = this._pendingResume;
        this._pendingResume = null;
        if (pending) {
          this.log.info(`[VR] ${this.robotId} fully charged → resuming deferred task ${pending.taskId}`);
          this._onTaskAssign(pending);
        } else {
          this.log.info(`[VR] ${this.robotId} fully charged → IDLE`);
        }
      }
    }
  }

  // ── Per-tick simulation ────────────────────────────────────────────────────

  _tick() {
    if (!this.connected || !this.socket?.connected) return;

    const nowMs = Date.now();

    // 1) Update EMA speed target — only when actually moving
    this._updateSpeed();

    // 2) Charging (highest priority)
    this._handleCharging(nowMs);

    // 3) Task navigation (only when not charging)
    if (this.status !== "CHARGING") {
      this._advanceTask(nowMs);
    }

    // 4) Enter charging if battery critically low and no active task
    if (
      this.battery <= BATTERY_CRITICAL_THRESHOLD &&
      this.status !== "CHARGING" &&
      this.phase === null
    ) {
      this._enterCharging();
    }

    // 5) Battery drain (skipped during charging — handled by _handleCharging)
    if (this.status !== "CHARGING") {
      this._applyBattery();
    }

    // 6) Obstacle report (while moving)
    this._maybeReportObstacle();

    // 7) Keep server offline-detector happy
    try { this.socket.emit("HEARTBEAT"); } catch { /* ignore */ }

    // 8) Emit telemetry
    this._emitTelemetry();

    // 9) Periodic battery persistence to Redis (every 2 minutes)
    this._maybePersistBattery();

    // 10) Optional simulation snapshot log
    if (typeof rootLogger.simulation === "function") {
      rootLogger.simulation({
        robotId: this.robotId,
        battery: Math.round(this.battery * 10) / 10,
        status:  this.status,
        phase:   this.phase,
        lat:     this.lat,
        lon:     this.lon,
        speed:   Math.round(this.speed * 100) / 100,
      });
    }
  }

  // ── Speed model ──────────────────────────────────────────────────────────

  _updateSpeed() {
    // ISSUES means "navigating on critically low battery", not "stopped" —
    // it's set by _applyBattery() while the robot is still under way. Treating
    // it like a halted state here would decelerate the robot to 0 m/s on the
    // very next tick and strand it mid-route until the battery (never
    // recovers on its own) or task state changes, even though the task stays
    // ASSIGNED/IN_PROGRESS in the DB the whole time.
    const isNavigating = (this.status === "ACTIVE" || this.status === "ISSUES") && this.phase && this.task;
    if (isNavigating) {
      // Target speed varies slightly around the base (smooth with EMA)
      this._targetSpeed =
        SPEED_BASE_MS + (Math.random() - 0.5) * SPEED_JITTER;
      this.speed =
        this.speed * (1 - SPEED_EMA_ALPHA) +
        this._targetSpeed * SPEED_EMA_ALPHA;
      this.speed = Math.max(SPEED_MIN_MS, Math.min(SPEED_MAX_MS, this.speed));
    } else if (this.status !== "CHARGING") {
      // Decelerate smoothly to zero
      this.speed = this.speed * 0.5;
      if (this.speed < 0.05) this.speed = 0;
    }
    // During CHARGING speed is always 0 (set in _enterCharging)
  }

  // ── Task advancement ───────────────────────────────────────────────────────

  _advanceTask(nowMs) {
    if (!this.task || !this.phase) {
      if (this.status === "ACTIVE") this.status = "IDLE";
      return;
    }

    switch (this.phase) {
      case "TO_PICKUP": {
        this._stepAlongPath();
        const atEnd = this.pathIndex >= (this.activePath?.length || 0) - 1;
        if (atEnd) {
          const last = this.activePath?.[this.activePath.length - 1];
          if (last) { this.lat = last.lat; this.lon = last.lon; }
          this.phase     = "WAIT_PICKUP";
          this.waitUntil = nowMs + PICKUP_WAIT_MS;
          this.speed     = 0;
          this.log.info(`[VR] ${this.robotId} reached pickup — waiting ${PICKUP_WAIT_MS / 1000}s`);
        }
        break;
      }

      case "WAIT_PICKUP":
        this.speed = 0;
        if (nowMs >= (this.waitUntil || 0)) {
          this.phase      = "TO_DROP";
          this.pathIndex  = 0;
          this.activePath = this.task.pathToDrop;
          this.waitUntil  = null;
          this.log.info(`[VR] ${this.robotId} pickup done — heading to drop`);
        }
        break;

      case "TO_DROP": {
        this._stepAlongPath();
        const atEnd = this.pathIndex >= (this.activePath?.length || 0) - 1;
        if (atEnd) {
          const last = this.activePath?.[this.activePath.length - 1];
          if (last) { this.lat = last.lat; this.lon = last.lon; }
          this.phase     = "WAIT_DROP";
          this.waitUntil = nowMs + DROP_WAIT_MS;
          this.speed     = 0;
          this.log.info(`[VR] ${this.robotId} reached drop — waiting ${DROP_WAIT_MS / 1000}s`);
        }
        break;
      }

      case "WAIT_DROP":
        this.speed = 0;
        if (nowMs >= (this.waitUntil || 0)) {
          const completedTaskId = this.task.taskId;
          this._clearTask();
          this.status = "IDLE";
          this.speed  = 0;
          this.log.info(`[VR] ${this.robotId} task ${completedTaskId} COMPLETE`);
          try {
            this.socket.emit("TASK_COMPLETE", { taskId: completedTaskId, timestamp: nowMs });
          } catch { /* ignore */ }
        }
        break;

      default:
        break;
    }
  }

  _stepAlongPath() {
    if (!this.activePath || this.activePath.length === 0) return;

    // Total distance budget for this tick (metres).
    // speed (m/s) × tick_interval (s) = real displacement, capped at MOVE_STEP_METERS
    // to guard against GPS teleports in edge cases.
    let budgetM = Math.min(
      this.speed * (TELEMETRY_INTERVAL_MS / 1000),
      MOVE_STEP_METERS
    );

    const path   = this.activePath;
    let   idx    = this.pathIndex;
    let   curLat = this.lat;
    let   curLon = this.lon;

    // Remember where we started (used to compute heading after movement)
    const startLat = curLat;
    const startLon = curLon;

    // Advance through multiple waypoints in a single tick so the robot moves
    // at the correct speed regardless of how densely the path is sampled.
    while (budgetM > 0.001 && idx < path.length) {
      const target = path[idx];
      if (!target || typeof target.lat !== "number") break;

      const dist = haversineMeters(curLat, curLon, target.lat, target.lon);

      if (dist < 0.01) {
        // Already on this waypoint — advance without consuming budget
        if (idx < path.length - 1) { idx++; continue; }
        break;
      }

      if (dist <= budgetM) {
        // Enough budget to reach this waypoint
        this.distanceTravelled += dist;
        budgetM -= dist;
        curLat = target.lat;
        curLon = target.lon;
        if (idx < path.length - 1) idx++;
        else break;
      } else {
        // Move partially toward this waypoint
        const t = budgetM / dist;
        this.distanceTravelled += budgetM;
        curLat = curLat + (target.lat - curLat) * t;
        curLon = curLon + (target.lon - curLon) * t;
        budgetM = 0;
      }
    }

    this.pathIndex = Math.min(idx, path.length - 1);

    // Compute heading clockwise from north.
    // Primary: direction of actual movement this tick (follows road shape exactly).
    // Fallback: direction toward the next upcoming waypoint (when movement was tiny).
    // Both go through wrap-aware EMA so the marker rotates smoothly.
    const dLatMov = curLat - startLat;
    const dLonMov = curLon - startLon;
    let rawHeading = null;

    if (Math.abs(dLatMov) > 1e-8 || Math.abs(dLonMov) > 1e-8) {
      // Use actual movement vector (most accurate)
      rawHeading = ((Math.atan2(dLonMov, dLatMov) * 180) / Math.PI + 360) % 360;
    } else {
      // Too little movement — point toward the next waypoint on the path
      const nextWp = path[Math.min(this.pathIndex, path.length - 1)];
      if (nextWp) {
        const dLat = nextWp.lat - curLat;
        const dLon = nextWp.lon - curLon;
        if (Math.abs(dLat) > 1e-8 || Math.abs(dLon) > 1e-8) {
          rawHeading = ((Math.atan2(dLon, dLat) * 180) / Math.PI + 360) % 360;
        }
      }
    }

    if (rawHeading !== null) {
      if (this._heading !== null) {
        // Wrap-aware EMA: interpolate along the shorter arc to avoid 359°→1° flip
        let delta = rawHeading - this._heading;
        while (delta > 180)  delta -= 360;
        while (delta < -180) delta += 360;
        this._heading = (this._heading + delta * 0.45 + 360) % 360;
      } else {
        this._heading = rawHeading;
      }
    }

    this.lat = curLat;
    this.lon = curLon;
  }

  // ── Battery drain (real-time rates) ───────────────────────────────────────

  _applyBattery() {
    if (this.status === "CHARGING") return; // handled by _handleCharging

    const drain = this.status === "ACTIVE"
      ? BATTERY_DRAIN_ACTIVE   // 100%→20% in 1 h of movement
      : BATTERY_DRAIN_IDLE;    // 100%→20% in 5 h at rest

    this.battery = Math.max(BATTERY_MIN, this.battery - drain);

    // Warn when battery drops below threshold while working
    if (this.battery < BATTERY_WARN_THRESHOLD && this.status === "ACTIVE") {
      this.status = "ISSUES";
    }
  }

  // ── Battery persistence (every 2 minutes) ────────────────────────────────

  _maybePersistBattery() {
    this._batteryPersistTicks++;
    if (this._batteryPersistTicks < BATTERY_PERSIST_TICKS) return;
    this._batteryPersistTicks = 0;

    if (!this.kv) return;
    const snapshot = Math.round(this.battery * 10) / 10;
    // Fire-and-forget: non-blocking, errors are silently swallowed
    this.kv
      .set(batteryKey(this.robotId), String(snapshot), { ex: BATTERY_KEY_TTL })
      .catch(() => {});
    this.log.debug?.(`[VR] ${this.robotId} battery snapshot saved: ${snapshot}%`);
  }

  // ── Obstacle simulation ───────────────────────────────────────────────────

  _maybeReportObstacle() {
    if (this.status !== "ACTIVE") return;
    if (Math.random() >= OBSTACLE_PROBABILITY) return;

    const obLat   = this.lat + (Math.random() - 0.5) * 0.0002;
    const obLon   = this.lon + (Math.random() - 0.5) * 0.0002;
    const severity = Math.random() < 0.3 ? "HIGH" : "MEDIUM";

    try {
      this.socket.emit("OBSTACLE_REPORT", { lat: obLat, lon: obLon, severity });
      if (typeof rootLogger.obstacle === "function") {
        rootLogger.obstacle({ reportingRobotId: this.robotId, lat: obLat, lon: obLon, severity });
      } else {
        this.log.warn(`[VR] ${this.robotId} obstacle detected (${severity})`);
      }
    } catch { /* ignore */ }
  }

  // ── Telemetry emit ────────────────────────────────────────────────────────

  _emitTelemetry() {
    if (!this.socket?.connected) return;
    try {
      this.socket.emit("TELEMETRY", {
        robotId:           this.robotId,
        lat:               this.lat,
        lon:               this.lon,
        battery:           Math.round(this.battery * 10) / 10,
        speed:             Math.round(this.speed * 100) / 100,
        status:            this.status,
        distanceTravelled: Math.round(this.distanceTravelled),
        heading:           this._heading !== null ? Math.round(this._heading) : null,
      });
    } catch { /* ignore */ }
  }
}

module.exports = VirtualRobot;
