"use strict";

/**
 * DTARO — the human-in-the-loop decision on a reported obstacle. SIMULATED FLEET ONLY.
 *
 * Opt-in: `DTARO_OPERATOR_DECISION_ENABLED=true`, and only while zone alerts are on
 * (`DTARO_ZONE_ALERTS_ENABLED=true`). Off, nothing here runs and obstacle alerts are delivered
 * at once, exactly as before.
 *
 * ── The five things kept apart ──────────────────────────────────────────────
 *   1. The internal report — accepted, deduplicated and stored by `dtaroZoneAlert.processReport`
 *      with `deferDelivery`: nothing reaches any robot.
 *   2. The operator-facing decision event — `OBSTACLE_DECISION_REQUIRED` to SUPER_ADMIN sockets,
 *      built from server state only, with the server's deadline.
 *   3. The committed decision — STOP, REROUTE or REJECT_BROADCAST, by an operator (MANUAL) or by
 *      the server at the deadline (DEFAULT_TIMEOUT → REROUTE). At most one, ever.
 *   4. Fleet propagation or suppression — `dtaroZoneAlert.propagateAlert` (STOP / REROUTE) or
 *      `suppressAlert` (REJECT_BROADCAST); either happens once, after the commit, never before.
 *   5. Per-robot simulated execution — `DTARO_SIM_NAV` to each affected SIMULATED robot's own
 *      sockets: STOP (the simulator's own stop, PAUSED) or REROUTE (a detour from
 *      `simulation/dtaroDetour`, driven from a simulation-only field). Progress is measured by the
 *      server from the robot's accepted positions, never taken from the robot.
 *
 * ── The deadline is the server's ────────────────────────────────────────────
 * Exactly `DECISION_WINDOW_MS` after the report was accepted. A timer armed before anything else
 * commits the default when it passes, whether or not any dashboard is connected. A manual decision
 * is accepted only if it reaches the server before the deadline; one that arrives later commits
 * the default (if the timer has not yet) and is refused as DEADLINE_PASSED. The commit is a
 * synchronous compare-and-set on the record, with no await before it, so a timer and a click (or
 * two clicks) can never both commit; the database row is then updated under a status guard.
 *
 * ── What it never does ──────────────────────────────────────────────────────
 *   * No engine write: no Outbox, Commitment, Leg, Task or Mission row, no fenced command, no
 *     operator Command row. The commanded route (the OFFER) is never rewritten; a detour lives in
 *     the simulated robot only, and completion is still graded against the OFFER corridor.
 *   * Never addresses a physical robot: a target with any socket that is not a DTARO-eligible
 *     (simulated) session is not sent anything (`NOT_SIMULATED`).
 *   * Never trusts a robot for time, identity, recipients or route: identity is the socket's,
 *     time is the server's, the route is the OFFER the server signed.
 *
 * ── Restart ─────────────────────────────────────────────────────────────────
 * The timers and the simulated execution live in this process. After a restart, every decision
 * that had not finished is marked ABANDONED_ON_RESTART (`recoverAfterRestart`) and stays visible
 * with that reason; none is executed late, so no stale or contradictory action is taken. The
 * report itself is not re-raised (its delivery ledger was per process too).
 */

const crypto = require("crypto");
const { z } = require("zod");

const dtaroZoneAlert = require("./dtaroZoneAlert.service");
const commandedRoute = require("./dtaroCommandedRoute.service");
const { pathIntersectsPolygon } = require("./routeIntersection.service");
const dashboardBroadcast = require("../sockets/dashboardBroadcast");
const dtaroDetour = require("../simulation/dtaroDetour");

const ENV_SWITCH = "DTARO_OPERATOR_DECISION_ENABLED";

/** The operator's window, from acceptance of the report to the default. Fixed by the owner's spec. */
const DECISION_WINDOW_MS = 5000;

const CHOICE = Object.freeze({ STOP: "STOP", REROUTE: "REROUTE", REJECT_BROADCAST: "REJECT_BROADCAST" });
const DEFAULT_CHOICE = CHOICE.REROUTE;
const SOURCE = Object.freeze({ MANUAL: "MANUAL", DEFAULT_TIMEOUT: "DEFAULT_TIMEOUT" });

/** The decision's own lifecycle — distinct from any robot's execution state. */
const STATUS = Object.freeze({
  REPORTED: "REPORTED",
  AWAITING_OPERATOR_DECISION: "AWAITING_OPERATOR_DECISION",
  DECIDED: "DECIDED",
  PROPAGATED: "PROPAGATED",
  SUPPRESSED: "SUPPRESSED",
  EXECUTING: "EXECUTING",
  COMPLETED: "COMPLETED",
  EXPIRED: "EXPIRED",
  ABANDONED_ON_RESTART: "ABANDONED_ON_RESTART",
});
/** Statuses a restart interrupts. */
const OPEN_STATUSES = Object.freeze([STATUS.REPORTED, STATUS.AWAITING_OPERATOR_DECISION, STATUS.DECIDED, STATUS.PROPAGATED, STATUS.SUPPRESSED, STATUS.EXECUTING]);
const FINAL_STATUSES = Object.freeze([STATUS.COMPLETED, STATUS.EXPIRED, STATUS.ABANDONED_ON_RESTART]);

/** One robot's simulated execution of the committed decision. */
const EXECUTION = Object.freeze({
  STOP_SENT: "STOP_SENT",
  STOPPED: "STOPPED",
  REROUTING: "REROUTING",
  MOVING: "MOVING",
  COMPLETED: "COMPLETED",
  NO_SAFE_ROUTE: "NO_SAFE_ROUTE",
  STOPPED_NO_SAFE_ROUTE: "STOPPED_NO_SAFE_ROUTE",
  REFUSED_STOPPED: "REFUSED_STOPPED",
  NOT_DELIVERED: "NOT_DELIVERED",
  UNCONFIRMED: "UNCONFIRMED",
  /** A later decision instructed this robot again; that instruction is the one it follows. */
  SUPERSEDED: "SUPERSEDED",
});
const TERMINAL_EXECUTIONS = new Set([EXECUTION.STOPPED, EXECUTION.COMPLETED, EXECUTION.STOPPED_NO_SAFE_ROUTE, EXECUTION.REFUSED_STOPPED, EXECUTION.NOT_DELIVERED, EXECUTION.UNCONFIRMED, EXECUTION.SUPERSEDED]);
/** A detour the robot is driving now. */
const IN_FLIGHT_REROUTE = new Set([EXECUTION.REROUTING, EXECUTION.MOVING]);

/** Why a robot is (or is not) affected — the server's reason, shown to the operator. */
const AFFECTED = Object.freeze({
  ROUTE_CROSSES_OBSTACLE: "ROUTE_CROSSES_OBSTACLE",
  ROUTE_UNKNOWN: "ROUTE_UNKNOWN",
  REPORTER_APPROACHING: "REPORTER_APPROACHING",
  REPORTER_ROUTE_UNKNOWN: "REPORTER_ROUTE_UNKNOWN",
  REPORTER_NOT_APPROACHING: "REPORTER_NOT_APPROACHING",
  SAME_ZONE_ROUTE_CLEAR: "SAME_ZONE_ROUTE_CLEAR",
  SAME_ZONE_IDLE: "SAME_ZONE_IDLE",
  /** The robot is driving an alternate route from an earlier decision, and that route meets this obstacle. */
  DETOUR_CROSSES_OBSTACLE: "DETOUR_CROSSES_OBSTACLE",
  /** The robot is driving an alternate route from an earlier decision that is clear of this obstacle. */
  DETOUR_CLEAR: "DETOUR_CLEAR",
});

/** Server → dashboard (SUPER_ADMIN). */
const REQUIRED_EVENT = "OBSTACLE_DECISION_REQUIRED";
const UPDATED_EVENT = "OBSTACLE_DECISION_UPDATED";
/** Server → one simulated robot's own sockets; robot → server acknowledgement. */
const NAV_EVENT = "DTARO_SIM_NAV";
const NAV_ACK_EVENT = "DTARO_SIM_NAV_ACK";

/** A robot that has not acknowledged a navigation instruction by then is UNCONFIRMED. @structural */
const NAV_ACK_TIMEOUT_MS = 10_000;
/** The simulator lands exactly on a path's last point; this is a numerical tolerance only. @structural */
const ARRIVAL_EPSILON_M = 0.5;
/** Progress-only updates to the dashboard are coalesced to at most one per record per this. @structural */
const PROGRESS_EMIT_MS = 500;
/** Kept in memory for the dashboard (newest first beyond this are dropped). @structural */
const MEMORY_MAX = 50;
/**
 * How long after its commit a decision keeps tracking its simulated robots. The obstacle's own
 * lifetime (the EKB TTL) does not end tracking: a robot halfway along a detour when the obstacle
 * expires is still followed to the end of it. @structural a demonstration bound
 */
const TRACKING_LIMIT_MS = 30 * 60_000;
/** Rows older than this are deleted at boot. Overridable with DTARO_DECISION_RETENTION_DAYS. */
const DEFAULT_RETENTION_DAYS = 30;

const decisionSchema = z.object({
  decision: z.enum([CHOICE.STOP, CHOICE.REROUTE, CHOICE.REJECT_BROADCAST]),
  idempotencyKey: z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/u),
});

const navAckSchema = z.object({
  navId: z.string().min(1).max(128),
  decisionId: z.string().min(1).max(128),
  outcome: z.enum(["STOPPED", "REROUTING", "REFUSED_STOPPED", "IGNORED"]),
  reason: z.string().max(300).nullable().optional(),
});

function isEnabled(env = process.env) {
  return dtaroZoneAlert.isEnabled(env) && String(env[ENV_SWITCH] || "").toLowerCase() === "true";
}

function retentionDays(env = process.env) {
  const value = Number(env.DTARO_DECISION_RETENTION_DAYS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_RETENTION_DAYS;
}

/**
 * The detour planner over the pinned configuration's own campus network (the delivery-domain
 * declaration's extract, contained in its boundary). Replaceable only by a test, whose synthetic
 * map has no campus extract.
 */
const defaultPlannerFactory = (snapshotFn) =>
  dtaroDetour.createDetourPlanner({
    deliveryDomainFor: () => {
      const pinned = snapshotFn();
      return (pinned && (pinned.deliveryDomain || (pinned.spatial && pinned.spatial.deliveryDomain))) || null;
    },
  });
let plannerFactory = defaultPlannerFactory;

/** Test seam: `null` restores the default. */
function setPlannerFactoryForTests(factory) {
  plannerFactory = typeof factory === "function" ? factory : defaultPlannerFactory;
}

// ── State ────────────────────────────────────────────────────────────────────

/** decisionId → record. In process, bounded; the database row is the durable audit. */
const records = new Map();
/** obstacleId → decisionId. */
const byObstacle = new Map();

const now = () => Date.now();
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const isPoint = (p) => Boolean(p) && Number.isFinite(p.lat) && Number.isFinite(p.lon);

function remember(record) {
  records.set(record.decisionId, record);
  byObstacle.set(record.obstacleId, record.decisionId);
  if (records.size > MEMORY_MAX) {
    for (const [id, item] of records) {
      if (records.size <= MEMORY_MAX) break;
      if (!FINAL_STATUSES.includes(item.status)) continue;
      records.delete(id);
      if (byObstacle.get(item.obstacleId) === id) byObstacle.delete(item.obstacleId);
    }
  }
}

function note(record, stage, text) {
  record.history.push({ at: iso(now()), stage, text });
  if (record.history.length > 100) record.history.splice(0, record.history.length - 100);
}

function log(record, level, message, meta) {
  const logger = record.runtime && record.runtime.logger;
  try {
    if (logger && typeof logger[level] === "function") logger[level](message, { decisionId: record.decisionId, obstacleId: record.obstacleId, ...(meta || {}) });
  } catch { /* ignore */ }
}

// ── The dashboard view ───────────────────────────────────────────────────────

/** The record as the dashboard receives it. Everything is server state; absent is null. */
function view(record) {
  const executions = Object.fromEntries([...record.executions.entries()].map(([robotId, e]) => [robotId, executionView(e)]));
  const robots = (record.robots || record.plan || []).map((r) => ({ ...r, execution: executions[r.robotId] || null }));
  const suppressed = record.propagation && Array.isArray(record.propagation.suppressedRecipients) ? record.propagation.suppressedRecipients : [];
  return {
    decisionId: record.decisionId,
    revision: record.revision,
    status: record.status,
    provenance: "SIMULATED",
    serverNow: iso(now()),
    receivedAt: iso(record.receivedAtMs),
    deadlineAt: iso(record.deadlineAtMs),
    windowMs: DECISION_WINDOW_MS,
    defaultDecision: DEFAULT_CHOICE,
    decision: record.decision
      ? {
          choice: record.decision.choice,
          source: record.decision.source,
          reason: record.decision.reason,
          decidedAt: iso(record.decision.decidedAtMs),
          decidedBy: record.decision.decidedBy || null,
        }
      : null,
    obstacle: {
      obstacleId: record.obstacleId,
      lat: record.lat,
      lon: record.lon,
      cellId: record.cellId,
      zoneId: record.zoneId,
      regionId: record.regionId,
      severity: record.severity,
      footprint: record.footprint,
      reportedAt: iso(record.reportedAtMs),
      expiresAt: iso(record.expiresAtMs),
      // The report is a simulated robot's; the protocol carries no confidence, so none is shown.
      detection: { source: "SIMULATED_ROBOT_REPORT", confidence: null },
      corroborations: record.corroborations || [],
    },
    reporter: robots.find((r) => r.robotId === record.reportingRobotId) || { robotId: record.reportingRobotId, provenance: "SIMULATED", role: "REPORTER" },
    robots,
    affectedCount: robots.filter((r) => r.affected === true).length,
    propagation: record.propagation,
    counts: {
      considered: robots.length,
      affected: robots.filter((r) => r.affected === true).length,
      delivered: record.propagation && Array.isArray(record.propagation.delivered) ? record.propagation.delivered.length : 0,
      suppressed: suppressed.length,
      rerouted: [...record.executions.values()].filter((e) => e.action === CHOICE.REROUTE && [EXECUTION.REROUTING, EXECUTION.MOVING, EXECUTION.COMPLETED, EXECUTION.SUPERSEDED].includes(e.state)).length,
      noSafeRoute: [...record.executions.values()].filter((e) => e.state === EXECUTION.STOPPED_NO_SAFE_ROUTE || e.state === EXECUTION.NO_SAFE_ROUTE).length,
      stopped: [...record.executions.values()].filter((e) => e.state === EXECUTION.STOPPED || e.state === EXECUTION.STOPPED_NO_SAFE_ROUTE || e.state === EXECUTION.REFUSED_STOPPED).length,
    },
    persistence: record.persistence,
    completedAt: iso(record.completedAtMs),
    obstacleExpired: Number.isFinite(record.obstacleExpiredAtMs),
    abandonedReason: record.abandonedReason || null,
    history: record.history.slice(),
  };
}

function executionView(e) {
  return {
    robotId: e.robotId,
    action: e.action,
    state: e.state,
    reason: e.reason,
    navId: e.navId,
    issuedAt: iso(e.issuedAtMs),
    acknowledgedAt: iso(e.ackAtMs),
    completedAt: iso(e.completedAtMs),
    robotReason: e.robotReason || null,
    supersededBy: e.supersededBy || null,
    alternatePath: e.alternatePath || null,
    alternateDistanceM: Number.isFinite(e.alternateDistanceM) ? Math.round(e.alternateDistanceM * 10) / 10 : null,
    originalPath: e.originalPath || null,
    progress: e.progress
      ? { fraction: Math.round(e.progress.fraction * 1000) / 1000, doneM: Math.round(e.progress.doneM), totalM: Math.round(e.progress.totalM), at: iso(e.progress.atMs) }
      : null,
  };
}

function emitView(record, event = UPDATED_EVENT) {
  record.revision += 1;
  if (record.emitTimer) {
    clearTimeout(record.emitTimer);
    record.emitTimer = null;
  }
  const io = record.runtime && record.runtime.io;
  if (!io) return;
  try { dashboardBroadcast.emit(io, event, view(record)); } catch { /* ignore */ }
}

/** A progress-only change: coalesced. A state change calls `emitView` directly. */
function emitSoon(record) {
  if (record.emitTimer) return;
  record.emitTimer = setTimeout(() => {
    record.emitTimer = null;
    emitView(record);
  }, PROGRESS_EMIT_MS);
  if (typeof record.emitTimer.unref === "function") record.emitTimer.unref();
}

// ── Persistence (the durable audit row) ─────────────────────────────────────

function table(prisma) {
  return prisma && prisma.dtaroObstacleDecision ? prisma.dtaroObstacleDecision : null;
}

/** Writes for one record are applied in order; a failure is recorded on the record, never thrown. */
function persist(record, write) {
  record.persistChain = record.persistChain
    .then(async () => {
      const t = table(record.runtime && record.runtime.prisma);
      if (!t) throw new Error("the DtaroObstacleDecision table is not available");
      return write(t);
    })
    .catch((error) => {
      record.persistence = { ok: false, error: String((error && error.message) || error).slice(0, 300) };
      log(record, "warn", "DTARO decision audit write failed", { error: record.persistence.error });
    });
  return record.persistChain;
}

function outcomeJson(record) {
  const v = view(record);
  return {
    decision: v.decision,
    propagation: v.propagation,
    counts: v.counts,
    robots: v.robots.map((r) => ({
      robotId: r.robotId,
      role: r.role,
      relevanceReason: r.relevanceReason,
      affected: r.affected,
      affectedReason: r.affectedReason,
      routeStatus: r.routeStatus,
      taskId: r.taskId,
      execution: r.execution
        ? { action: r.execution.action, state: r.execution.state, reason: r.execution.reason, robotReason: r.execution.robotReason, issuedAt: r.execution.issuedAt, acknowledgedAt: r.execution.acknowledgedAt, completedAt: r.execution.completedAt, alternateDistanceM: r.execution.alternateDistanceM, alternatePoints: r.execution.alternatePath ? r.execution.alternatePath.length : 0 }
        : null,
    })),
    history: v.history,
  };
}

function persistState(record) {
  return persist(record, (t) =>
    t.updateMany({
      where: { decisionId: record.decisionId },
      data: {
        status: record.status,
        propagatedAt: record.propagation && record.propagation.outcome === "PROPAGATED" ? new Date(record.propagation.atMs) : undefined,
        suppressedAt: record.propagation && record.propagation.outcome === "SUPPRESSED" ? new Date(record.propagation.atMs) : undefined,
        completedAt: Number.isFinite(record.completedAtMs) ? new Date(record.completedAtMs) : undefined,
        recipients: record.plan ? record.plan.map((r) => ({ robotId: r.robotId, role: r.role, relevanceReason: r.relevanceReason, affected: r.affected, affectedReason: r.affectedReason })) : undefined,
        outcome: outcomeJson(record),
      },
    }),
  );
}

// ── Opening a decision ──────────────────────────────────────────────────────

/**
 * Open the decision for a report `dtaroZoneAlert.processReport` accepted with `deferDelivery`.
 * Synchronous up to the deadline timer: the deadline holds from here whatever happens next.
 *
 * @param {object} args
 * @param {object} args.io
 * @param {object} args.prisma
 * @param {() => object|null} args.snapshotOf the pinned configuration, read when needed
 * @param {(robotId: string) => Promise<{lat:number, lon:number, at?:number}|null>} args.positionOf
 * @param {(robotId: string) => Promise<object|null>} [args.robotStateOf] the server-held live state
 * @param {object} args.report the `processReport` result (`deferred: true`)
 * @param {object} [args.planner] `dtaroDetour.createDetourPlanner(...)`, injected for tests
 * @param {object} [args.logger]
 * @returns {{ decisionId: string, deadlineAt: string }}
 */
function open({ io, prisma, snapshotOf, positionOf, robotStateOf, report, planner, logger }) {
  const receivedAtMs = now();
  const alert = report.alert;
  const snapshotFn = typeof snapshotOf === "function" ? snapshotOf : () => null;
  const record = {
    decisionId: crypto.randomUUID(),
    revision: 0,
    status: STATUS.REPORTED,
    obstacleId: alert.obstacleId,
    regionId: alert.regionId,
    zoneId: alert.zoneId,
    cellId: alert.cellId,
    lat: alert.lat,
    lon: alert.lon,
    severity: alert.severity || null,
    footprint: report.footprint && Array.isArray(report.footprint.polygon) ? report.footprint.polygon : dtaroZoneAlert.cellFootprint(alert.cellId),
    reportedAtMs: Number(alert.timestamp) || receivedAtMs,
    expiresAtMs: Date.parse(alert.expiresAt) || receivedAtMs + 300_000,
    reportingRobotId: alert.reportingRobotId,
    receivedAtMs,
    deadlineAtMs: receivedAtMs + DECISION_WINDOW_MS,
    decision: null,
    plan: null,
    robots: null,
    propagation: null,
    executions: new Map(),
    corroborations: [],
    history: [],
    persistence: { ok: true },
    persistChain: Promise.resolve(),
    completedAtMs: null,
    runtime: {
      io,
      prisma,
      snapshotOf: snapshotFn,
      positionOf,
      robotStateOf,
      logger,
      planner: planner || plannerFactory(snapshotFn),
    },
    timer: null,
    expiryTimer: null,
    emitTimer: null,
  };
  note(record, STATUS.REPORTED, `Report from ${record.reportingRobotId} accepted by the server`);
  record.status = STATUS.AWAITING_OPERATOR_DECISION;
  note(record, STATUS.AWAITING_OPERATOR_DECISION, `Awaiting an operator decision until ${iso(record.deadlineAtMs)} (default ${DEFAULT_CHOICE})`);
  remember(record);
  armDeadline(record);
  armExpiry(record);

  persist(record, (t) =>
    t.create({
      data: {
        decisionId: record.decisionId,
        obstacleId: record.obstacleId,
        regionId: record.regionId,
        zoneId: record.zoneId,
        cellId: record.cellId,
        lat: record.lat,
        lon: record.lon,
        severity: record.severity,
        reportingRobotId: record.reportingRobotId,
        status: STATUS.AWAITING_OPERATOR_DECISION,
        receivedAt: new Date(record.receivedAtMs),
        deadlineAt: new Date(record.deadlineAtMs),
        expiresAt: new Date(record.expiresAtMs),
      },
    }),
  );

  // The operator's view: who is involved and why, from the server's own state. Then a preview of
  // what REROUTE would do for each affected robot. Neither delays the deadline.
  record.preparing = prepare(record);
  return { decisionId: record.decisionId, deadlineAt: iso(record.deadlineAtMs) };
}

async function prepare(record) {
  try {
    record.plan = (await assess(record)).robots;
  } catch (error) {
    record.plan = [];
    note(record, record.status, `Could not assess the fleet: ${String((error && error.message) || error)}`);
  }
  emitView(record, REQUIRED_EVENT);
  if (record.decision) return;
  try {
    await previewReroutes(record);
    if (!record.decision) emitView(record);
  } catch { /* the preview is informational */ }
}

function armDeadline(record) {
  const wait = Math.max(0, record.deadlineAtMs - now());
  record.timer = setTimeout(() => onDeadline(record), wait);
  if (typeof record.timer.unref === "function") record.timer.unref();
}

function onDeadline(record) {
  record.timer = null;
  if (record.decision || record.status !== STATUS.AWAITING_OPERATOR_DECISION) return;
  // A timer that fires early (a clock adjustment) waits again rather than deciding early.
  if (now() < record.deadlineAtMs) {
    armDeadline(record);
    return;
  }
  commitChoice(record, { choice: DEFAULT_CHOICE, source: SOURCE.DEFAULT_TIMEOUT, decidedBy: null, idempotencyKey: null });
}

function armExpiry(record) {
  const wait = Math.max(0, record.expiresAtMs - now());
  record.expiryTimer = setTimeout(() => {
    record.expiryTimer = null;
    if (FINAL_STATUSES.includes(record.status)) return;
    // The obstacle is no longer active (not confirmed clear). A robot still executing this
    // decision keeps being followed until it finishes, or until the tracking limit.
    record.obstacleExpiredAtMs = now();
    note(record, record.status, "The obstacle's lifetime ended (not confirmed clear); robots still executing this decision are followed to the end");
    settle(record);
  }, wait);
  if (typeof record.expiryTimer.unref === "function") record.expiryTimer.unref();
}

function armTrackingLimit(record) {
  record.trackingTimer = setTimeout(() => {
    record.trackingTimer = null;
    if (FINAL_STATUSES.includes(record.status)) return;
    record.status = STATUS.EXPIRED;
    note(record, STATUS.EXPIRED, `Tracking ended ${TRACKING_LIMIT_MS / 60_000} min after the decision, before every simulated robot finished`);
    clearAckTimers(record);
    emitView(record);
    persistState(record);
  }, TRACKING_LIMIT_MS);
  if (typeof record.trackingTimer.unref === "function") record.trackingTimer.unref();
}

// ── Committing ───────────────────────────────────────────────────────────────

/**
 * The one place a decision is committed. Synchronous: the compare-and-set and the state change
 * happen before any await, so a second caller always sees the first caller's decision.
 *
 * @returns {boolean} true when this call committed
 */
function commitChoice(record, { choice, source, decidedBy, idempotencyKey }) {
  if (record.decision || record.status !== STATUS.AWAITING_OPERATOR_DECISION) return false;
  const decidedAtMs = now();
  record.decision = {
    choice,
    source,
    decidedAtMs,
    decidedBy: decidedBy || null,
    idempotencyKey: idempotencyKey || null,
    reason:
      source === SOURCE.DEFAULT_TIMEOUT
        ? `No operator decision reached the server within ${DECISION_WINDOW_MS / 1000} s; the server applied the default (${DEFAULT_CHOICE})`
        : `Chosen by an operator ${Math.max(0, decidedAtMs - record.receivedAtMs)} ms after the report was accepted`,
  };
  record.status = STATUS.DECIDED;
  if (record.timer) {
    clearTimeout(record.timer);
    record.timer = null;
  }
  armTrackingLimit(record);
  note(record, STATUS.DECIDED, source === SOURCE.DEFAULT_TIMEOUT ? `Default ${choice}: no operator decision by the deadline` : `${choice} chosen by the operator`);
  log(record, "info", "DTARO obstacle decision committed", { choice, source });

  persist(record, (t) =>
    t.updateMany({
      where: { decisionId: record.decisionId, status: STATUS.AWAITING_OPERATOR_DECISION },
      data: {
        status: STATUS.DECIDED,
        decision: choice,
        decisionSource: source,
        decidedByUserId: decidedBy ? decidedBy.userId : null,
        decidedAt: new Date(decidedAtMs),
        idempotencyKey: idempotencyKey || null,
      },
    }).then((result) => {
      if (result && result.count === 0) {
        record.persistence = { ok: false, error: "the audit row was not in AWAITING_OPERATOR_DECISION when the decision was written" };
      }
    }),
  );
  emitView(record);
  record.executing = execute(record).catch((error) => {
    note(record, record.status, `Execution failed: ${String((error && error.message) || error)}`);
    log(record, "error", "DTARO decision execution failed", { error: String((error && error.message) || error) });
    emitView(record);
  });
  return true;
}

/**
 * An operator's decision (`POST /api/dtaro/decisions/:decisionId`).
 *
 * @param {{ decisionId: string, body: object, user: { id: string, role?: string } }} input
 * @returns {{ status: number, body: object }}
 */
function decide({ decisionId, body, user }) {
  const parsed = decisionSchema.safeParse(body || {});
  if (!parsed.success) return { status: 400, body: { error: "INVALID_DECISION", details: parsed.error.issues.map((i) => i.message) } };
  const record = records.get(String(decisionId || ""));
  if (!record) return { status: 404, body: { error: "UNKNOWN_DECISION" } };
  const { decision: choice, idempotencyKey } = parsed.data;

  if (record.decision) {
    const same = record.decision.source === SOURCE.MANUAL && record.decision.idempotencyKey === idempotencyKey && record.decision.choice === choice;
    if (same) return { status: 200, body: { outcome: "ALREADY_COMMITTED", replay: true, decision: view(record) } };
    return {
      status: 409,
      body: {
        error: record.decision.source === SOURCE.DEFAULT_TIMEOUT ? "DEFAULT_ALREADY_APPLIED" : "ALREADY_DECIDED",
        committed: { choice: record.decision.choice, source: record.decision.source },
        decision: view(record),
      },
    };
  }
  if (record.status !== STATUS.AWAITING_OPERATOR_DECISION) {
    return { status: 409, body: { error: "NOT_AWAITING_DECISION", status: record.status, decision: view(record) } };
  }
  // The server's clock decides lateness. A late request still makes the default happen now.
  if (now() >= record.deadlineAtMs) {
    commitChoice(record, { choice: DEFAULT_CHOICE, source: SOURCE.DEFAULT_TIMEOUT, decidedBy: null, idempotencyKey: null });
    return { status: 409, body: { error: "DEADLINE_PASSED", committed: { choice: record.decision.choice, source: record.decision.source }, decision: view(record) } };
  }
  const committed = commitChoice(record, { choice, source: SOURCE.MANUAL, decidedBy: { userId: String(user && user.id), role: (user && user.role) || null }, idempotencyKey });
  if (!committed) return { status: 409, body: { error: "ALREADY_DECIDED", decision: view(record) } };
  return { status: 200, body: { outcome: "COMMITTED", decision: view(record) } };
}

// ── Assessment: who is involved, from the server's own state ────────────────

function inRegionFor(record) {
  return (point) => {
    const resolved = dtaroZoneAlert.resolvePoint(record.runtime.snapshotOf(), point.lat, point.lon);
    return resolved.ok && resolved.regionId === record.regionId;
  };
}

async function namesAndTasks(prisma, robotIds, taskIds) {
  const out = { names: new Map(), tasks: new Map(), permissionSets: new Map() };
  try {
    const robots = robotIds.length && prisma && prisma.robot ? await prisma.robot.findMany({ where: { robotId: { in: robotIds } }, select: { robotId: true, name: true } }) : [];
    for (const r of robots || []) out.names.set(r.robotId, r.name || null);
  } catch { /* names are cosmetic */ }
  try {
    const tasks = taskIds.length && prisma && prisma.task
      ? await prisma.task.findMany({ where: { taskId: { in: taskIds } }, select: { taskId: true, pickup: true, pickupLat: true, pickupLon: true, drop: true, dropLat: true, dropLon: true } })
      : [];
    for (const t of tasks || []) out.tasks.set(t.taskId, t);
  } catch { /* origin and destination then show as unavailable */ }
  try {
    const agents = robotIds.length && prisma && prisma.agent
      ? await prisma.agent.findMany({ where: { agentId: { in: robotIds } }, select: { agentId: true, agentClass: { select: { mobilityModel: { select: { permissionSet: true } } } } } })
      : [];
    for (const a of agents || []) {
      const set = a && a.agentClass && a.agentClass.mobilityModel ? a.agentClass.mobilityModel.permissionSet : null;
      out.permissionSets.set(a.agentId, set || null);
    }
  } catch { /* no permission set → no detour (refused by name) */ }
  return out;
}

const place = (name, lat, lon) => (name || Number.isFinite(lat) ? { name: name || null, lat: Number.isFinite(lat) ? lat : null, lon: Number.isFinite(lon) ? lon : null } : null);

/**
 * Every eligible robot with the server's reasons. The reporter is included (its own approach to
 * the obstacle decides whether it is stopped); robots of other regions are listed as never
 * involved, which is what region isolation means.
 */
async function assess(record) {
  const { io, prisma, positionOf, robotStateOf } = record.runtime;
  const located = { regionId: record.regionId, zoneId: record.zoneId, cellId: record.cellId };
  // The recipient policy's verdict, through the zone-alert service (its one wiring point).
  const fleet = await dtaroZoneAlert.assessRecipients({ io, prisma, located, footprint: record.footprint, reporterRobotId: record.reportingRobotId, positionOf, includeReporter: true });
  const picked = fleet.picked;

  const robotIds = fleet.candidates.map((c) => c.robotId);
  const taskIds = [...new Set([...fleet.details.values()].map((d) => d.route && d.route.taskId).filter(Boolean))];
  const lookups = await namesAndTasks(prisma, robotIds, taskIds);

  const robots = [];
  for (const d of picked.decisions) {
    const candidate = fleet.candidates.find((c) => c.robotId === d.robotId) || {};
    const facts = fleet.routeFacts.get(d.robotId) || null;
    const detail = fleet.details.get(d.robotId) || null;
    const isReporter = d.robotId === record.reportingRobotId;
    const sameRegion = candidate.regionId === record.regionId;
    const unknown = Boolean(facts) && commandedRoute.UNKNOWN_ROUTE_STATUSES.includes(facts.status);
    let intersects = facts && facts.remaining ? pathIntersectsPolygon(facts.remaining, record.footprint) : null;
    // A robot driving a detour from an earlier decision is judged on what it is driving: the rest
    // of that detour, then its commanded legs after the last detoured one, not the corridor it left.
    const nav = sameRegion ? activeNavigation(d.robotId, record) : null;
    const navPosition = detail && isPoint(detail.position) ? detail.position : null;
    if (nav && navPosition) intersects = pathIntersectsPolygon(navigationAhead(nav, navPosition, detail.route), record.footprint);

    let affected = false;
    let affectedReason = d.reason;
    if (!sameRegion) {
      affectedReason = dtaroZoneAlert.RECIPIENT_REASON.OTHER_REGION;
    } else if (nav && navPosition && !isReporter) {
      [affected, affectedReason] = intersects ? [true, AFFECTED.DETOUR_CROSSES_OBSTACLE] : [false, AFFECTED.DETOUR_CLEAR];
    } else if (isReporter) {
      affected = intersects === true || unknown;
      affectedReason = intersects === true ? AFFECTED.REPORTER_APPROACHING : unknown ? AFFECTED.REPORTER_ROUTE_UNKNOWN : AFFECTED.REPORTER_NOT_APPROACHING;
    } else if (d.selected) {
      if (intersects === true) [affected, affectedReason] = [true, AFFECTED.ROUTE_CROSSES_OBSTACLE];
      else if (unknown) [affected, affectedReason] = [true, AFFECTED.ROUTE_UNKNOWN];
      else affectedReason = facts && facts.status === commandedRoute.ROUTE_STATUS.OK ? AFFECTED.SAME_ZONE_ROUTE_CLEAR : AFFECTED.SAME_ZONE_IDLE;
    }

    let position = detail && detail.position;
    if (!position && typeof positionOf === "function") position = await Promise.resolve(positionOf(d.robotId)).catch(() => null);
    let live = null;
    if (typeof robotStateOf === "function") live = await Promise.resolve(robotStateOf(d.robotId)).catch(() => null);
    const route = detail && detail.route && detail.route.status === commandedRoute.ROUTE_STATUS.OK ? detail.route : null;
    const task = route && route.taskId ? lookups.tasks.get(route.taskId) : null;
    const corridorProgress = route && isPoint(position) ? dtaroDetour.progressAlong(route.points, position) : null;

    robots.push({
      robotId: d.robotId,
      name: lookups.names.get(d.robotId) || null,
      provenance: "SIMULATED",
      role: isReporter ? "REPORTER" : !sameRegion ? "OTHER_REGION" : d.selected ? "RECIPIENT" : "NOT_ALERTED",
      relation: d.relation,
      zoneId: candidate.zoneId || null,
      regionId: candidate.regionId || null,
      relevanceReason: d.reason,
      alertedOnPropagation: !isReporter && d.selected === true,
      affected,
      affectedReason,
      routeStatus: facts ? facts.status : null,
      routeIntersects: intersects,
      state: live && typeof live.status === "string" ? live.status : null,
      speed: live && Number.isFinite(live.speed) ? live.speed : null,
      position: isPoint(position) ? { lat: position.lat, lon: position.lon, at: Number.isFinite(position.at) ? iso(position.at) : null } : null,
      taskId: route ? route.taskId : null,
      origin: task ? place(task.pickup, task.pickupLat, task.pickupLon) : null,
      destination: task ? place(task.drop, task.dropLat, task.dropLon) : null,
      originalRoute: facts && facts.remaining ? facts.remaining.map((p) => ({ lat: p.lat, lon: p.lon })) : null,
      routeProgress: corridorProgress ? { fraction: Math.round(corridorProgress.fraction * 1000) / 1000, doneM: Math.round(corridorProgress.doneM), totalM: Math.round(corridorProgress.totalM) } : null,
      // Driving an alternate route from an earlier decision (simulation only), if so.
      onDetourFrom: nav ? nav.record.decisionId : null,
      preview: null,
    });
  }
  return { robots, fleet, lookups };
}

// ── Legs and detours ─────────────────────────────────────────────────────────

/**
 * The detour a robot is driving now, from an earlier decision this process holds, with the leg the
 * server measures it to be on (its progress along the detour's legs). Null when it drives none.
 */
function activeNavigation(robotId, except) {
  let best = null;
  for (const record of records.values()) {
    if (record === except || FINAL_STATUSES.includes(record.status)) continue;
    const e = record.executions.get(String(robotId));
    if (!e || e.action !== CHOICE.REROUTE || !IN_FLIGHT_REROUTE.has(e.state) || !Array.isArray(e.alternatePath) || !Array.isArray(e.legSpans)) continue;
    if (!best || e.issuedAtMs > best.execution.issuedAtMs) best = { record, execution: e };
  }
  if (!best) return null;
  const e = best.execution;
  const doneM = e.progress ? e.progress.doneM : 0;
  const span = e.legSpans.find((sp) => doneM <= sp.endM + 1e-6) || e.legSpans[e.legSpans.length - 1];
  return { ...best, currentStopIndex: span.stopIndex, lastStopIndex: e.legSpans[e.legSpans.length - 1].stopIndex };
}

/** What a detouring robot will still drive: the rest of its detour, then the commanded legs after it. */
function navigationAhead(nav, position, route) {
  const e = nav.execution;
  const from = e.progress ? e.progress.segmentIndex + 1 : 1;
  const ahead = [{ lat: position.lat, lon: position.lon }, ...e.alternatePath.slice(from)];
  const stops = route && Array.isArray(route.stops) ? route.stops : [];
  for (const stop of stops) if (stop.index > nav.lastStopIndex) ahead.push(...stop.points);
  return ahead;
}

/** The legs from a known stop on: that stop's leg from the robot's position, then the later ones. */
function legsFromStop(route, position, stopIndex) {
  const legs = [];
  for (const stop of route.stops || []) {
    if (stop.index < stopIndex || stop.points.length === 0) continue;
    const to = stop.points[stop.points.length - 1];
    legs.push(
      stop.index === stopIndex
        ? { stopIndex: stop.index, stopType: stop.stopType, from: { lat: position.lat, lon: position.lon }, to, geometry: [{ lat: position.lat, lon: position.lon }, to], current: true }
        : { stopIndex: stop.index, stopType: stop.stopType, from: stop.points[0], to, geometry: stop.points.slice() },
    );
  }
  return legs;
}

/**
 * The legs still ahead of a robot on its commanded route, from where the server holds it: the
 * current stop's leg from the robot's position, then every later stop's whole leg.
 */
function legsAhead(route, position, segmentIndex) {
  const stops = Array.isArray(route.stops) ? route.stops : [];
  if (stops.length === 0 || !isPoint(position) || !Number.isInteger(segmentIndex)) return [];
  // Flat corridor index → stop: the corridor is the stops' paths concatenated, in order.
  let offset = 0;
  let current = -1;
  let local = 0;
  for (const stop of stops) {
    const length = stop.points.length;
    // Segment i joins flat points i and i+1; it belongs to the stop owning point i+1.
    const target = segmentIndex + 1;
    if (current === -1 && target >= offset && target < offset + length) {
      current = stop.index;
      local = target - offset;
    }
    offset += length;
  }
  if (current === -1) return [];
  const legs = [];
  for (const stop of stops) {
    if (stop.index < current || stop.points.length === 0) continue;
    const to = stop.points[stop.points.length - 1];
    if (stop.index === current) {
      legs.push({ stopIndex: stop.index, stopType: stop.stopType, from: { lat: position.lat, lon: position.lon }, to, geometry: [{ lat: position.lat, lon: position.lon }, ...stop.points.slice(local)] });
    } else {
      legs.push({ stopIndex: stop.index, stopType: stop.stopType, from: stop.points[0], to, geometry: stop.points.slice() });
    }
  }
  return legs;
}

/**
 * The detour plan for one robot: every leg ahead that meets the footprint gets an alternate path;
 * one leg without a safe alternative makes the whole plan fail (the robot is then stopped).
 */
function planFor(record, robotId, fleet, permissionSet) {
  const detail = fleet.details.get(robotId);
  const route = detail && detail.route;
  if (!route || route.status !== commandedRoute.ROUTE_STATUS.OK) {
    return { ok: false, reason: "ROUTE_UNKNOWN", text: "The server cannot read this robot's commanded route, so no alternate path can be planned" };
  }
  if (!isPoint(detail.position)) return { ok: false, reason: "POSITION_UNKNOWN", text: "The server holds no position for this robot, so no alternate path can be planned" };
  // Every other obstacle still active in the region is kept clear of too, whatever was decided
  // about it: a detour around one obstacle must not lead into another.
  const others = dtaroZoneAlert.activeObstacles(record.regionId).filter((o) => o.obstacleId !== record.obstacleId).map((o) => o.polygon);
  const areas = [record.footprint, ...others];
  // A robot on an earlier detour is off its commanded corridor: its leg is the one the server
  // measured it on, and that leg is replanned from where it is.
  const nav = activeNavigation(robotId, record);
  const legs = nav ? legsFromStop(route, detail.position, nav.currentStopIndex) : legsAhead(route, detail.position, detail.segmentIndex);
  const crossing = legs.filter((leg) => leg.current || areas.some((poly) => pathIntersectsPolygon(leg.geometry, poly)));
  if (crossing.length === 0) return { ok: false, reason: "NO_CROSSING_LEG", text: "No leg ahead could be attributed the crossing; the robot is stopped rather than guessed about" };
  const inRegion = inRegionFor(record);
  const planned = [];
  for (const leg of crossing) {
    const result = record.runtime.planner.planLeg({ from: leg.from, to: leg.to, footprint: record.footprint, footprints: others, inRegion, permissionSet });
    if (!result.ok) return { ok: false, reason: result.refusal, text: `No safe alternate route available for leg ${leg.stopIndex + 1}: ${result.reason}` };
    planned.push({ ...leg, points: result.points, distanceM: result.distanceM });
  }
  // What the robot will drive from here to the end of the last detoured leg, and what it would have.
  const last = Math.max(...planned.map((leg) => leg.stopIndex));
  const navigation = [];
  const original = [];
  // Where each leg ends along the navigation path, so the server can tell which leg the robot is on.
  const legSpans = [];
  const join = (line, pts) => {
    for (const p of pts) {
      const tail = line[line.length - 1];
      if (!tail || tail.lat !== p.lat || tail.lon !== p.lon) line.push({ lat: p.lat, lon: p.lon });
    }
  };
  for (const leg of legs) {
    if (leg.stopIndex > last) break;
    const replaced = planned.find((p) => p.stopIndex === leg.stopIndex);
    const startM = dtaroDetour.pathLengthM(navigation);
    join(navigation, replaced ? replaced.points : leg.geometry);
    join(original, leg.current ? (route.stops.find((st) => st.index === leg.stopIndex) || { points: leg.geometry }).points : leg.geometry);
    legSpans.push({ stopIndex: leg.stopIndex, startM, endM: dtaroDetour.pathLengthM(navigation) });
  }
  return {
    ok: true,
    legs: planned.map((leg) => ({ stopIndex: leg.stopIndex, stopType: leg.stopType, from: leg.from, to: leg.to, points: leg.points, distanceM: leg.distanceM })),
    navigation,
    original,
    legSpans,
    avoid: others,
    distanceM: dtaroDetour.pathLengthM(navigation),
    taskId: route.taskId,
    commitmentId: route.commitmentId || null,
  };
}

/** Before a decision: what REROUTE would do for each affected robot (informational). */
async function previewReroutes(record) {
  if (!record.plan) return;
  const { fleet, lookups } = await assess(record);
  for (const robot of record.plan) {
    if (!robot.affected) continue;
    const plan = planFor(record, robot.robotId, fleet, lookups.permissionSets.get(robot.robotId) || null);
    robot.preview = plan.ok ? { ok: true, distanceM: Math.round(plan.distanceM), legs: plan.legs.length } : { ok: false, reason: plan.reason, text: plan.text };
  }
}

// ── Execution ────────────────────────────────────────────────────────────────

async function sendNav(record, robotId, message) {
  const io = record.runtime.io;
  const sockets = await io.in(`robot:${robotId}`).fetchSockets();
  if (sockets.length === 0) return { delivered: false, reason: "ROBOT_NOT_CONNECTED" };
  // Never to a physical unit: every socket in the room must be an authenticated DTARO-eligible
  // (simulated) session of this very robot.
  const eligible = sockets.every((s) => s.data && s.data.isAuthed === true && s.data.dtaroEligible === true && String(s.data.robotId) === robotId);
  if (!eligible) return { delivered: false, reason: "NOT_SIMULATED" };
  for (const s of sockets) s.emit(NAV_EVENT, message);
  return { delivered: true, sockets: sockets.length };
}

function newExecution(robotId, action, reason) {
  return { robotId, action, state: null, reason, navId: crypto.randomUUID(), issuedAtMs: null, ackAtMs: null, completedAtMs: null, robotReason: null, alternatePath: null, alternateDistanceM: null, originalPath: null, progress: null, ackTimer: null };
}

async function dispatchStop(record, execution, { noSafeRoute = false, text }) {
  const message = {
    navId: execution.navId,
    decisionId: record.decisionId,
    obstacleId: record.obstacleId,
    action: CHOICE.STOP,
    reason: execution.reason,
    text,
    provenance: "SIMULATED",
    footprint: record.footprint,
    issuedAt: iso(now()),
  };
  execution.issuedAtMs = now();
  const sent = await sendNav(record, execution.robotId, message);
  if (!sent.delivered) {
    execution.state = EXECUTION.NOT_DELIVERED;
    execution.robotReason = sent.reason;
    note(record, record.status, `${execution.robotId}: stop not delivered (${sent.reason})`);
    return;
  }
  execution.state = noSafeRoute ? EXECUTION.NO_SAFE_ROUTE : EXECUTION.STOP_SENT;
  note(record, record.status, `${execution.robotId}: ${noSafeRoute ? `no safe alternate route — stop sent (${text})` : `stop sent (${execution.reason})`}`);
  armAckTimer(record, execution);
}

async function dispatchReroute(record, execution, plan) {
  const message = {
    navId: execution.navId,
    decisionId: record.decisionId,
    obstacleId: record.obstacleId,
    action: CHOICE.REROUTE,
    reason: execution.reason,
    provenance: "SIMULATED",
    footprint: record.footprint,
    // Every other active obstacle the detour keeps clear of: the robot verifies against all of them.
    avoid: plan.avoid,
    taskId: plan.taskId,
    commitmentId: plan.commitmentId,
    legs: plan.legs.map((leg) => ({ stopIndex: leg.stopIndex, stopType: leg.stopType, to: leg.to, points: leg.points })),
    issuedAt: iso(now()),
  };
  execution.alternatePath = plan.navigation;
  execution.originalPath = plan.original;
  execution.legSpans = plan.legSpans;
  execution.alternateDistanceM = plan.distanceM;
  execution.issuedAtMs = now();
  const sent = await sendNav(record, execution.robotId, message);
  if (!sent.delivered) {
    execution.state = EXECUTION.NOT_DELIVERED;
    execution.robotReason = sent.reason;
    note(record, record.status, `${execution.robotId}: alternate route not delivered (${sent.reason})`);
    return;
  }
  execution.state = EXECUTION.REROUTING;
  note(record, record.status, `${execution.robotId}: alternate route sent (${Math.round(plan.distanceM)} m, ${plan.legs.length} leg${plan.legs.length === 1 ? "" : "s"} detoured)`);
  armAckTimer(record, execution);
}

function armAckTimer(record, execution) {
  execution.ackTimer = setTimeout(() => {
    execution.ackTimer = null;
    if (execution.ackAtMs || TERMINAL_EXECUTIONS.has(execution.state) || FINAL_STATUSES.includes(record.status)) return;
    execution.state = EXECUTION.UNCONFIRMED;
    note(record, record.status, `${execution.robotId}: no acknowledgement within ${NAV_ACK_TIMEOUT_MS / 1000} s`);
    settle(record);
  }, NAV_ACK_TIMEOUT_MS);
  if (typeof execution.ackTimer.unref === "function") execution.ackTimer.unref();
}

function clearAckTimers(record) {
  for (const e of record.executions.values()) {
    if (e.ackTimer) clearTimeout(e.ackTimer);
    e.ackTimer = null;
  }
}

async function execute(record) {
  const choice = record.decision.choice;
  const { fleet, lookups, robots } = await assess(record);
  // Robots as they are at the commit; the report-time view is kept as `plan`.
  record.robots = robots.map((r) => ({ ...r, preview: (record.plan || []).find((p) => p.robotId === r.robotId)?.preview || null }));
  if (record.status !== STATUS.DECIDED) return;

  let targets;
  if (choice === CHOICE.REJECT_BROADCAST) {
    const suppressed = dtaroZoneAlert.suppressAlert({ obstacleId: record.obstacleId });
    const would = robots.filter((r) => r.alertedOnPropagation).map((r) => r.robotId).sort();
    record.propagation = { outcome: "SUPPRESSED", atMs: now(), at: iso(now()), ok: suppressed.ok, reason: suppressed.ok ? "Broadcast rejected by the operator — fleet alert suppressed" : suppressed.reason, delivered: [], suppressedRecipients: would };
    record.status = STATUS.SUPPRESSED;
    note(record, STATUS.SUPPRESSED, `Broadcast rejected — fleet alert suppressed for ${would.length} robot${would.length === 1 ? "" : "s"}${would.length ? ` (${would.join(", ")})` : ""}. The obstacle is not confirmed absent.`);
    // Only the reporter is kept safe, and only if it is heading into the obstacle.
    targets = robots.filter((r) => r.role === "REPORTER" && r.affected).map((r) => ({ robot: r, action: CHOICE.STOP, reason: "REPORTER_SAFETY_STOP" }));
  } else {
    const delivered = await dtaroZoneAlert.propagateAlert({
      io: record.runtime.io,
      prisma: record.runtime.prisma,
      obstacleId: record.obstacleId,
      extra: { decisionId: record.decisionId, decision: choice, decisionSource: record.decision.source },
      positionOf: record.runtime.positionOf,
    });
    record.propagation = delivered.ok
      ? { outcome: "PROPAGATED", atMs: now(), at: iso(now()), ok: true, delivered: delivered.recipients, sameZone: delivered.sameZoneRecipients, crossZone: delivered.crossZoneRecipients, suppressedRecipients: [] }
      : { outcome: "PROPAGATION_FAILED", atMs: now(), at: iso(now()), ok: false, reason: delivered.reason, delivered: [], suppressedRecipients: [] };
    record.status = STATUS.PROPAGATED;
    note(record, STATUS.PROPAGATED, delivered.ok ? `Fleet alert delivered to ${delivered.recipients.length} robot${delivered.recipients.length === 1 ? "" : "s"}` : `Fleet alert not delivered: ${delivered.reason}`);
    targets = robots.filter((r) => r.affected).map((r) => ({ robot: r, action: choice, reason: r.affectedReason }));
  }
  emitView(record);
  persistState(record);

  // While instructions are still going out, an early acknowledgement must not close the record.
  record.dispatching = true;
  for (const { robot, action, reason } of targets) {
    const execution = newExecution(robot.robotId, action, reason);
    // Read before this instruction exists: the plan below starts from the earlier detour.
    const earlier = activeNavigation(robot.robotId, record);
    record.executions.set(robot.robotId, execution);
    if (action === CHOICE.STOP) {
      await dispatchStop(record, execution, { text: reason === "REPORTER_SAFETY_STOP" ? "Reporter kept safe: broadcast rejected, robot stopped short of the reported obstacle" : "Stopped by the obstacle decision" });
    } else {
      const plan = planFor(record, robot.robotId, fleet, lookups.permissionSets.get(robot.robotId) || null);
      if (plan.ok) await dispatchReroute(record, execution, plan);
      else {
        execution.reason = plan.reason;
        await dispatchStop(record, execution, { noSafeRoute: true, text: `No safe alternate route available — ${plan.text}` });
      }
    }
    if (earlier && execution.state !== EXECUTION.NOT_DELIVERED) {
      earlier.execution.state = EXECUTION.SUPERSEDED;
      earlier.execution.supersededBy = record.decisionId;
      if (earlier.execution.ackTimer) clearTimeout(earlier.execution.ackTimer);
      note(earlier.record, earlier.record.status, `${robot.robotId}: superseded by a later decision (${record.decisionId}) for another obstacle`);
      note(record, record.status, `${robot.robotId}: was on an alternate route from decision ${earlier.record.decisionId}; replaced by this instruction`);
      settle(earlier.record);
    }
  }
  record.dispatching = false;
  if (targets.length > 0 && !FINAL_STATUSES.includes(record.status)) {
    record.status = STATUS.EXECUTING;
    note(record, STATUS.EXECUTING, `${targets.length} simulated robot${targets.length === 1 ? "" : "s"} instructed`);
  }
  settle(record);
}

/** Close the record once every execution is terminal; emit and persist either way. */
function settle(record) {
  if (!record.dispatching && !FINAL_STATUSES.includes(record.status) && record.status !== STATUS.AWAITING_OPERATOR_DECISION && record.status !== STATUS.DECIDED) {
    const all = [...record.executions.values()];
    if (all.every((e) => TERMINAL_EXECUTIONS.has(e.state))) {
      record.status = STATUS.COMPLETED;
      record.completedAtMs = now();
      note(record, STATUS.COMPLETED, all.length ? "Every instructed simulated robot reached a final state" : "No simulated robot needed an instruction");
      for (const key of ["expiryTimer", "trackingTimer"]) {
        if (record[key]) clearTimeout(record[key]);
        record[key] = null;
      }
    }
  }
  emitView(record);
  persistState(record);
}

// ── From the robots and the telemetry path ───────────────────────────────────

/**
 * A simulated robot's acknowledgement of a navigation instruction. Accepted only from a socket of
 * the robot the instruction was sent to, for a decision still being executed.
 */
function recordNavAck({ robotId, payload }) {
  const parsed = navAckSchema.safeParse(payload || {});
  if (!parsed.success) return { accepted: false, reason: "INVALID_PAYLOAD" };
  const record = records.get(parsed.data.decisionId);
  if (!record) return { accepted: false, reason: "UNKNOWN_DECISION" };
  if (FINAL_STATUSES.includes(record.status)) return { accepted: false, reason: `DECISION_${record.status}` };
  const execution = record.executions.get(String(robotId));
  if (!execution || execution.navId !== parsed.data.navId) return { accepted: false, reason: "NOT_A_TARGET" };
  if (execution.ackAtMs) return { accepted: false, reason: "DUPLICATE" };
  execution.ackAtMs = now();
  execution.robotReason = parsed.data.reason || null;
  if (execution.ackTimer) {
    clearTimeout(execution.ackTimer);
    execution.ackTimer = null;
  }
  const outcome = parsed.data.outcome;
  if (outcome === "STOPPED") execution.state = execution.state === EXECUTION.NO_SAFE_ROUTE ? EXECUTION.STOPPED_NO_SAFE_ROUTE : EXECUTION.STOPPED;
  else if (outcome === "REFUSED_STOPPED") execution.state = EXECUTION.REFUSED_STOPPED;
  else if (outcome === "REROUTING") execution.state = execution.state === EXECUTION.REROUTING ? EXECUTION.REROUTING : execution.state;
  else execution.state = EXECUTION.UNCONFIRMED;
  note(record, record.status, `${robotId}: robot reports ${outcome}${execution.robotReason ? ` (${execution.robotReason})` : ""}`);
  settle(record);
  return { accepted: true };
}

/**
 * A simulated robot's accepted position (telemetry). Measures progress along its alternate path;
 * reaching the end of the last detoured leg completes its reroute.
 */
function onPosition(robotId, lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  const id = String(robotId);
  for (const record of records.values()) {
    if (FINAL_STATUSES.includes(record.status)) continue;
    const execution = record.executions.get(id);
    if (!execution || execution.action !== CHOICE.REROUTE || !Array.isArray(execution.alternatePath)) continue;
    if (execution.state !== EXECUTION.REROUTING && execution.state !== EXECUTION.MOVING) continue;
    const previous = execution.progress;
    const measured = dtaroDetour.progressAlong(execution.alternatePath, { lat, lon }, previous ? Math.max(0, previous.segmentIndex - 1) : 0);
    if (!measured) continue;
    if (!Number.isFinite(execution.startDoneM)) execution.startDoneM = measured.doneM;
    // Forward only: an older or noisy fix never moves progress back.
    const doneM = previous ? Math.max(previous.doneM, measured.doneM) : measured.doneM;
    execution.progress = { ...measured, doneM, fraction: measured.totalM > 0 ? doneM / measured.totalM : 1, atMs: now() };
    const last = execution.alternatePath[execution.alternatePath.length - 1];
    const atEnd = measured.segmentIndex === execution.alternatePath.length - 2 && dtaroDetour.pathLengthM([{ lat, lon }, last]) <= ARRIVAL_EPSILON_M;
    if (atEnd) {
      execution.state = EXECUTION.COMPLETED;
      execution.completedAtMs = now();
      note(record, record.status, `${id}: reached the end of its alternate route`);
      settle(record);
    } else if (execution.state === EXECUTION.REROUTING && execution.ackAtMs && doneM > execution.startDoneM + 0.5) {
      execution.state = EXECUTION.MOVING;
      note(record, record.status, `${id}: moving along its alternate route`);
      emitView(record);
    } else {
      emitSoon(record);
    }
  }
}

/** A further report merged into an obstacle awaiting or executing a decision. */
function onMerged(obstacleId, corroborations) {
  const record = records.get(byObstacle.get(obstacleId));
  if (!record || FINAL_STATUSES.includes(record.status)) return;
  record.corroborations = Array.isArray(corroborations) ? corroborations.slice() : [];
  note(record, record.status, `Also reported by ${record.corroborations.join(", ")} (same published cell, merged)`);
  emitView(record);
}

// ── Reads, recovery, retention ───────────────────────────────────────────────

/** The archived view of a database row this process does not hold (e.g. after a restart). */
function rowView(row) {
  return {
    decisionId: row.decisionId,
    revision: 0,
    status: row.status,
    provenance: "SIMULATED",
    archived: true,
    serverNow: iso(now()),
    receivedAt: iso(new Date(row.receivedAt).getTime()),
    deadlineAt: iso(new Date(row.deadlineAt).getTime()),
    windowMs: DECISION_WINDOW_MS,
    defaultDecision: DEFAULT_CHOICE,
    decision: row.decision ? { choice: row.decision, source: row.decisionSource, reason: null, decidedAt: row.decidedAt ? iso(new Date(row.decidedAt).getTime()) : null, decidedBy: row.decidedByUserId ? { userId: row.decidedByUserId } : null } : null,
    obstacle: { obstacleId: row.obstacleId, lat: row.lat, lon: row.lon, cellId: row.cellId, zoneId: row.zoneId, regionId: row.regionId, severity: row.severity, footprint: null, expiresAt: row.expiresAt ? iso(new Date(row.expiresAt).getTime()) : null, detection: { source: "SIMULATED_ROBOT_REPORT", confidence: null } },
    reporter: { robotId: row.reportingRobotId, provenance: "SIMULATED", role: "REPORTER" },
    robots: [],
    propagation: row.outcome && row.outcome.propagation ? row.outcome.propagation : null,
    counts: row.outcome && row.outcome.counts ? row.outcome.counts : null,
    persistence: { ok: true },
    completedAt: row.completedAt ? iso(new Date(row.completedAt).getTime()) : null,
    abandonedReason: row.abandonedReason || null,
    history: row.outcome && Array.isArray(row.outcome.history) ? row.outcome.history : [],
  };
}

/** Newest first: this process's records, then recent archived rows it does not hold. */
async function listDecisions(prisma, { limit = 30 } = {}) {
  const live = [...records.values()].sort((a, b) => b.receivedAtMs - a.receivedAtMs).map(view);
  let archived = [];
  try {
    const t = table(prisma);
    const rows = t ? await t.findMany({ orderBy: { receivedAt: "desc" }, take: limit }) : [];
    archived = (rows || []).filter((row) => !records.has(row.decisionId)).map(rowView);
  } catch { /* the live records still answer */ }
  return [...live, ...archived].sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt)).slice(0, limit);
}

/**
 * At boot, with the feature on: mark every decision a previous process left open as
 * ABANDONED_ON_RESTART (never executed late), and delete rows past retention.
 */
async function recoverAfterRestart(prisma, { env = process.env, logger } = {}) {
  const t = table(prisma);
  if (!t) return { ok: false, reason: "NO_TABLE" };
  // Only what a PREVIOUS process left open: a decision this process accepts after recovery
  // starts is live here and must never be marked abandoned by its own boot.
  const startedAt = new Date(now());
  try {
    const abandoned = await t.updateMany({
      where: { status: { in: [...OPEN_STATUSES] }, receivedAt: { lt: startedAt } },
      data: {
        status: STATUS.ABANDONED_ON_RESTART,
        abandonedReason: "The server restarted before this decision finished. Its timer and the simulated execution were in that process; nothing was executed late.",
      },
    });
    const cutoff = new Date(now() - retentionDays(env) * 86_400_000);
    const deleted = await t.deleteMany({ where: { receivedAt: { lt: cutoff } } });
    if (logger && typeof logger.info === "function") logger.info("DTARO decision recovery", { abandoned: abandoned.count, deleted: deleted.count, retentionDays: retentionDays(env) });
    return { ok: true, abandoned: abandoned.count, deleted: deleted.count };
  } catch (error) {
    if (logger && typeof logger.warn === "function") logger.warn("DTARO decision recovery failed", { error: String((error && error.message) || error) });
    return { ok: false, reason: String((error && error.message) || error) };
  }
}

function decisionFor(obstacleId) {
  const record = records.get(byObstacle.get(obstacleId));
  return record ? view(record) : null;
}

/** Test seam: clears every record and timer. */
function resetForTests() {
  for (const record of records.values()) {
    for (const t of [record.timer, record.expiryTimer, record.emitTimer, record.trackingTimer]) if (t) clearTimeout(t);
    clearAckTimers(record);
  }
  records.clear();
  byObstacle.clear();
}

/** Test seam: the in-flight work of a record (preparation and execution). */
async function settledForTests(decisionId) {
  const record = records.get(decisionId);
  if (!record) return;
  await record.preparing;
  await record.executing;
  await record.persistChain;
}

module.exports = {
  ENV_SWITCH,
  DECISION_WINDOW_MS,
  CHOICE,
  DEFAULT_CHOICE,
  SOURCE,
  STATUS,
  EXECUTION,
  AFFECTED,
  REQUIRED_EVENT,
  UPDATED_EVENT,
  NAV_EVENT,
  NAV_ACK_EVENT,
  NAV_ACK_TIMEOUT_MS,
  isEnabled,
  open,
  decide,
  recordNavAck,
  onPosition,
  onMerged,
  listDecisions,
  decisionFor,
  recoverAfterRestart,
  legsAhead,
  resetForTests,
  settledForTests,
  setPlannerFactoryForTests,
  /** Test seam: the delivery guard (every socket in the room must be a simulated session). */
  sendNavForTests: (io, robotId, message) => sendNav({ runtime: { io } }, robotId, message),
};
