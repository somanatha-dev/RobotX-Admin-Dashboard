/**
 * VirtualRobot
 *
 * A software agent that behaves identically to a physical robot:
 *   - Connects to the Socket.IO server as a client (same AUTH / TELEMETRY flow)
 *   - Receives TASK_ASSIGN via the `robot:{robotId}` room
 *   - Navigates along the planned path and emits TASK_COMPLETE when done
 *   - Enters CHARGING state when battery falls to 10%; charges back to 100%
 *   - Reports simulated obstacles via OBSTACLE_REPORT
 *
 * The server-side simulation engine (simulation.service.js) automatically
 * skips any robot that has an active socket — so there is zero double-driving.
 */

const { io: ioClient } = require("socket.io-client");
const crypto = require("crypto");
const rootLogger = require("../config/logger");
const { haversineMeters } = require("../utils/distance");

const {
  SESSION_TTL_SEC,
  TELEMETRY_INTERVAL_MS,
  MOVE_STEP_METERS,
  ARRIVE_THRESHOLD_METERS,
  BATTERY_DRAIN_ACTIVE,
  BATTERY_DRAIN_IDLE,
  BATTERY_RECHARGE_IDLE,
  BATTERY_WARN_THRESHOLD,
  BATTERY_CRITICAL_THRESHOLD,
  BATTERY_MIN,
  CHARGING_WAIT_MS,
  CHARGING_RATE_PER_TICK,
  CHARGING_INTERRUPT_BATTERY,
  OBSTACLE_PROBABILITY,
  PICKUP_WAIT_MS,
  DROP_WAIT_MS,
  RECONNECT_DELAY_MS,
} = require("./constants");

// ─── VirtualRobot ────────────────────────────────────────────────────────────

class VirtualRobot {
  constructor({ robotId, lat, lon, logger } = {}) {
    this.robotId = robotId;
    this.lat = lat;
    this.lon = lon;
    this.battery = 85 + Math.random() * 15; // 85–100 on spawn
    this.speed = 0;
    this.status = "IDLE";
    this.log = logger || console;

    // Task navigation state
    this.task = null;       // { taskId, pathToPickup, pathToDrop }
    this.phase = null;      // TO_PICKUP | WAIT_PICKUP | TO_DROP | WAIT_DROP
    this.pathIndex = 0;
    this.waitUntil = null;
    this.activePath = null;

    // Charging state
    // _chargingPhase: null | 'WAITING' | 'CHARGING'
    this._chargingPhase = null;
    this._chargeWaitUntil = null;

    // Socket state
    this.socket = null;
    this.sessionToken = null;
    this.connected = false;
    this._handlersRegistered = false;
    this._timer = null;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  /**
   * Seed Redis with a session token and initial live state for this robot.
   *
   * The robot record in PostgreSQL was already created by the Commission Robot
   * API before addRobot() is called, so we must NOT touch the DB here — doing
   * so would overwrite the correctly-set locationId and other fields.
   *
   * @param {object} kv  Redis client
   */
  async commission(kv) {
    this.sessionToken = crypto.randomUUID();
    await kv.set(`session:${this.robotId}`, this.sessionToken, { ex: SESSION_TTL_SEC });

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

    this.log.info(`[VR] ${this.robotId} session seeded in Redis`);
  }

  connect(serverUrl) {
    this.socket = ioClient(serverUrl, {
      reconnection:          true,
      reconnectionDelay:     RECONNECT_DELAY_MS,
      reconnectionDelayMax:  10_000,
      reconnectionAttempts:  Infinity,
      transports:            ["websocket"],
    });

    this.socket.on("connect", () => {
      this.connected = true;
      this.log.info(`[VR] ${this.robotId} socket connected — sending AUTH`);
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

    this.socket.on("STOP", () => {
      if (this.status !== "CHARGING") this.status = "PAUSED";
      this.speed = 0;
      this.log.info(`[VR] ${this.robotId} STOP`);
    });

    this.socket.on("RETURN_TO_BASE", () => {
      this._clearTask();
      this._clearCharging();
      this.status = "IDLE";
      this.speed  = 0;
      this.log.info(`[VR] ${this.robotId} RETURN_TO_BASE`);
    });
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._tick(), TELEMETRY_INTERVAL_MS);
    if (typeof this._timer.unref === "function") this._timer.unref();
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    try { this.socket?.disconnect(); } catch { /* ignore */ }
    this.socket = null;
    this.connected = false;
    this._handlersRegistered = false;
    this.log.info(`[VR] ${this.robotId} stopped`);
  }

  reset() {
    this._clearTask();
    this._clearCharging();
    this.status = "IDLE";
    this.speed  = 0;
    this.log.info(`[VR] ${this.robotId} reset`);
  }

  getStatus() {
    return {
      robotId:        this.robotId,
      lat:            this.lat,
      lon:            this.lon,
      battery:        Math.round(this.battery * 10) / 10,
      speed:          this.speed,
      status:         this.status,
      phase:          this.phase,
      taskId:         this.task?.taskId || null,
      connected:      this.connected,
      chargingPhase:  this._chargingPhase,
    };
  }

  // ── Task handlers ───────────────────────────────────────────────────────────

  _onTaskAssign(payload) {
    const { taskId, pathToPickup, pathToDrop } = payload || {};
    if (!taskId) return;

    // Interrupt charging if battery is sufficient for the task.
    if (this.status === "CHARGING") {
      if (this.battery < CHARGING_INTERRUPT_BATTERY) {
        this.log.warn(
          `[VR] ${this.robotId} TASK_ASSIGN rejected — battery ${this.battery.toFixed(1)}% too low while charging`
        );
        return;
      }
      this._clearCharging();
      this.log.info(`[VR] ${this.robotId} charging interrupted by TASK_ASSIGN (battery=${this.battery.toFixed(1)}%)`);
    }

    this.log.info(`[VR] ${this.robotId} TASK_ASSIGN ${taskId}`);

    this.task = {
      taskId,
      pathToPickup: Array.isArray(pathToPickup) ? pathToPickup : [],
      pathToDrop:   Array.isArray(pathToDrop)   ? pathToDrop   : [],
    };
    this.phase      = "TO_PICKUP";
    this.pathIndex  = 0;
    this.waitUntil  = null;
    this.activePath = this.task.pathToPickup;
    this.status     = "ACTIVE";
  }

  _onRerouteAlert(payload) {
    if (!this.activePath || !payload?.obstacleLocation) return;
    const obs = payload.obstacleLocation;
    const SKIP_RADIUS_DEG = 0.0003;

    let idx = this.pathIndex;
    while (
      idx < this.activePath.length - 1 &&
      Math.abs((this.activePath[idx]?.lat || 0) - obs.lat) < SKIP_RADIUS_DEG &&
      Math.abs((this.activePath[idx]?.lon || 0) - obs.lon) < SKIP_RADIUS_DEG
    ) {
      idx++;
    }
    if (idx > this.pathIndex) {
      this.pathIndex = idx;
      this.log.info(`[VR] ${this.robotId} REROUTE: advanced to path index ${idx}`);
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

  // ── Charging state machine ──────────────────────────────────────────────────

  _enterCharging() {
    this.status          = "CHARGING";
    this._chargingPhase  = "WAITING";
    this._chargeWaitUntil = Date.now() + CHARGING_WAIT_MS;
    this.speed           = 0;
    this.log.info(
      `[VR] ${this.robotId} battery critical (${this.battery.toFixed(1)}%) — entering CHARGING (wait ${CHARGING_WAIT_MS / 1000}s)`
    );
  }

  _handleCharging(nowMs) {
    if (this.status !== "CHARGING") return;

    if (this._chargingPhase === "WAITING") {
      if (nowMs >= (this._chargeWaitUntil || 0)) {
        this._chargingPhase = "CHARGING";
        this.log.info(`[VR] ${this.robotId} charging started`);
      }
      return;
    }

    if (this._chargingPhase === "CHARGING") {
      this.battery = Math.min(100, this.battery + CHARGING_RATE_PER_TICK);
      if (this.battery >= 100) {
        this.battery = 100;
        this.status  = "IDLE";
        this._clearCharging();
        this.log.info(`[VR] ${this.robotId} fully charged — returning to IDLE`);
      }
    }
  }

  // ── Per-tick simulation ─────────────────────────────────────────────────────

  _tick() {
    if (!this.connected || !this.socket?.connected) return;

    const nowMs = Date.now();

    // 1) Charging takes priority (handles the charging state machine)
    this._handleCharging(nowMs);

    // 2) Task navigation (only when not charging)
    if (this.status !== "CHARGING") {
      this._advanceTask(nowMs);
    }

    // 3) Check if battery is critically low and no active task
    if (
      this.battery <= BATTERY_CRITICAL_THRESHOLD &&
      this.status !== "CHARGING" &&
      this.phase === null
    ) {
      this._enterCharging();
    }

    // 4) Battery model (skipped during charging — handled by _handleCharging)
    if (this.status !== "CHARGING") {
      this._applyBattery();
    }

    // 5) Obstacle simulation
    this._maybeReportObstacle();

    // 6) Keep offline detector reset
    try { this.socket.emit("HEARTBEAT"); } catch { /* ignore */ }

    // 7) Emit telemetry
    this._emitTelemetry();

    // 8) Periodic simulation snapshot (throttled — won't spam)
    if (typeof rootLogger.simulation === "function") {
      rootLogger.simulation({
        robotId: this.robotId,
        battery: Math.round(this.battery * 10) / 10,
        status:  this.status,
        phase:   this.phase,
        lat:     this.lat,
        lon:     this.lon,
      });
    }
  }

  _advanceTask(nowMs) {
    if (!this.task || !this.phase) {
      if (this.status === "ACTIVE") this.status = "IDLE";
      this.speed = 0;
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

    const idx    = Math.min(this.pathIndex, this.activePath.length - 1);
    const target = this.activePath[idx];
    if (!target || typeof target.lat !== "number") return;

    const dist = haversineMeters(this.lat, this.lon, target.lat, target.lon);

    if (dist <= ARRIVE_THRESHOLD_METERS) {
      this.lat = target.lat;
      this.lon = target.lon;
      if (this.pathIndex < this.activePath.length - 1) this.pathIndex++;
    } else {
      const t = Math.min(1, MOVE_STEP_METERS / dist);
      this.lat = this.lat + (target.lat - this.lat) * t;
      this.lon = this.lon + (target.lon - this.lon) * t;
    }
    this.speed = 1.5;
  }

  _applyBattery() {
    if (this.status === "ACTIVE") {
      this.battery = Math.max(BATTERY_MIN, this.battery - BATTERY_DRAIN_ACTIVE);
    } else if (this.status === "IDLE" && this.battery < 95) {
      // Slow trickle recharge while idle
      this.battery = Math.min(100, this.battery - BATTERY_DRAIN_IDLE + BATTERY_RECHARGE_IDLE);
    } else {
      this.battery = Math.max(0, this.battery - BATTERY_DRAIN_IDLE);
    }

    if (this.battery < BATTERY_WARN_THRESHOLD && this.status === "ACTIVE") {
      this.status = "ISSUES";
    }
  }

  _maybeReportObstacle() {
    if (this.status !== "ACTIVE") return;
    if (Math.random() >= OBSTACLE_PROBABILITY) return;

    const obLat = this.lat + (Math.random() - 0.5) * 0.0002;
    const obLon = this.lon + (Math.random() - 0.5) * 0.0002;
    const severity = Math.random() < 0.3 ? "HIGH" : "MEDIUM";

    try {
      this.socket.emit("OBSTACLE_REPORT", { lat: obLat, lon: obLon, severity });
      if (typeof rootLogger.obstacle === "function") {
        rootLogger.obstacle({ reportingRobotId: this.robotId, lat: obLat, lon: obLon, severity });
      } else {
        this.log.warn(`[VR] ${this.robotId} reported obstacle (${severity})`);
      }
    } catch { /* ignore */ }
  }

  _emitTelemetry() {
    if (!this.socket?.connected) return;
    try {
      this.socket.emit("TELEMETRY", {
        robotId: this.robotId,
        lat:     this.lat,
        lon:     this.lon,
        battery: Math.round(this.battery * 10) / 10,
        speed:   this.speed,
        status:  this.status, // "CHARGING" is accepted by the telemetry handler
      });
    } catch { /* ignore */ }
  }
}

module.exports = VirtualRobot;
