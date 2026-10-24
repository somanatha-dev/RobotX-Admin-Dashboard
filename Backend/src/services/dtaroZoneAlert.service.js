"use strict";

/**
 * DTARO zone-scoped obstacle alerts — opt-in (`DTARO_ZONE_ALERTS_ENABLED=true`).
 *
 * Read with `docs/audits/dtaro-zone-coordination/`. The legacy path
 * (`alertDissemination.processObstacleReport`) resolves a bounding-box zone, never addresses
 * it, and scans the whole fleet for a `plannedPath` nothing writes. This module is the path
 * the OBSTACLE_REPORT handler takes instead when the switch is on:
 *
 *   1. The obstacle's location is resolved through the SAME spatial authority the engine
 *      uses — the pinned published map (`snapshot.spatial`, ADR-28): point → H3 fine cell →
 *      published cell→zone→region assignment. No bounding boxes, no query-time geometry.
 *      An unassigned cell fails closed.
 *   2. The reporter's region is the server's own fact (the zone room its last accepted
 *      position placed it in), never a field of the report. A report naming a point outside
 *      the reporter's region is refused.
 *   3. The alert is emitted to the region-qualified zone room
 *      `dtaro:region:<regionId>:zone:<zoneId>` through Socket.IO, so two regions that happen
 *      to use the same zone label can never receive each other's alerts.
 *   3b. Cross-zone (owner policy 2026-10-23): a robot in the same region but another zone
 *      is ALSO alerted, through its own robot room, when its remaining COMMANDED route — the
 *      live commitment's OFFER corridor, cut at the robot's latest server-held position
 *      (`dtaroCommandedRoute.service`) — meets the obstacle's footprint
 *      (`dtaroRecipientPolicy.selectRecipients`). A robot's own account of its route is never
 *      used. Other regions are never considered. `ALERT_CREATED` records every robot
 *      considered, whether it was selected and alerted, and why (`recipientDecisions`).
 *   4. Each recipient decides relevance itself against the route it was commanded, and
 *      answers OBSTACLE_RELEVANCE. The server accepts an answer only from a robot the alert
 *      was delivered to, and relays it to the dashboard (SUPER_ADMIN, via dashboardBroadcast).
 *
 * ── What this deliberately does NOT do ──────────────────────────────────────
 *   * No reroute, replan or path mutation of any kind, and no call into `routing.service`
 *     (OD-3: no replanning authority exists while the V1 engine is frozen).
 *   * No engine write: no Outbox, Commitment, Leg, Task or Mission row, no fenced command.
 *   * No plausibility distance and no lifecycle beyond the existing EKB TTL (OD-4/OD-5).
 *     Dedup is one active obstacle per (region, published cell), serialized per cell.
 *   * Physical robots are neither zone members nor accepted reporters: physical obstacle
 *     integration is out of scope (A-6), and the Pi never emits OBSTACLE_REPORT.
 *
 * Membership lives on the socket (`socket.data.dtaroZone`), not in the registry, so a
 * reconnect — which is always a new server-side socket — starts with no membership and is
 * re-joined at AUTH from the last known position. That closes audit FI-2 for these rooms.
 *
 * ── Deferred delivery (operator decisions, `dtaroObstacleDecision.service`) ──
 * With `deferDelivery`, `processReport` stops after the report is accepted, deduplicated and
 * stored: NO robot room receives anything and no ALERT_CREATED is sent. Fleet delivery is then a
 * separate stage the decision service starts once a decision is committed — `propagateAlert`
 * (STOP / REROUTE) or `suppressAlert` (REJECT_BROADCAST) — and each obstacle can be delivered or
 * suppressed once only. Without it (the default), delivery is immediate, exactly as before.
 */

const h3 = require("h3-js");
const { z } = require("zod");
const cells = require("../engine/spatial/cells");
const hierarchy = require("../engine/spatial/hierarchy");
const ekb = require("./ekb.service");
const simulationPolicy = require("../simulation/simulationPolicy");
const dashboardBroadcast = require("../sockets/dashboardBroadcast");
const commandedRoute = require("./dtaroCommandedRoute.service");
const { selectRecipients, REASON: RECIPIENT_REASON } = require("./dtaroRecipientPolicy");

/** The recipient policy `ALERT_CREATED` names: the zone room plus remaining-route crossings. */
const RECIPIENT_POLICY = "ZONE_PLUS_REMAINING_ROUTE";

const ENV_SWITCH = "DTARO_ZONE_ALERTS_ENABLED";

/** Server → robot: an obstacle was reported in the zone this robot is in. */
const ALERT_EVENT = "OBSTACLE_ALERT";
/** Robot → server: the recipient's relevance verdict for one alert. */
const RELEVANCE_EVENT = "OBSTACLE_RELEVANCE";
/** Server → reporter (and dashboard): a report the server refused, with the reason. */
const REJECTED_EVENT = "OBSTACLE_REPORT_REJECTED";
/** Server → dashboard: a further report of an obstacle that is already active in that cell. */
const MERGED_EVENT = "OBSTACLE_REPORT_MERGED";

const REJECTION = Object.freeze({
  INVALID_COORDINATES: "INVALID_COORDINATES",
  SPATIAL_AUTHORITY_UNAVAILABLE: "SPATIAL_AUTHORITY_UNAVAILABLE",
  UNASSIGNED_CELL: "UNASSIGNED_CELL",
  CELL_HAS_NO_ZONE: "CELL_HAS_NO_ZONE",
  REPORTER_NOT_SIMULATED: "REPORTER_NOT_SIMULATED",
  REPORTER_REGION_UNKNOWN: "REPORTER_REGION_UNKNOWN",
  WRONG_REGION: "WRONG_REGION",
});

const ROUTE_SOURCES = Object.freeze(["COMMANDED_ROUTE", "CHARGER_APPROACH", "NONE"]);

const relevanceSchema = z.object({
  obstacleId: z.string().min(1).max(128),
  relevant: z.boolean(),
  routeSource: z.enum(ROUTE_SOURCES),
  taskId: z.string().max(128).nullable().optional(),
  routePoints: z.number().int().min(0).max(100_000).optional(),
  decision: z.string().min(1).max(64),
});

/**
 * The columns `admitSession` reads, spread into AUTH's one robot-row select so AUTH makes no
 * second read. This module is the only reader of the simulation discriminator on this path
 * (registered in `tests/engine/simulationBoundary.test.js`): it scopes membership and decides
 * nothing the assignment engine sees.
 */
const AUTH_SELECT = Object.freeze({ simulated: true });

/**
 * Record, on an authenticated socket, whether it may join zone rooms and report obstacles:
 * simulated robots only (A-6). Read through `simulationPolicy.isSimulatedRobot`, so this
 * answer and the simulator's own are the same answer.
 */
function admitSession(socket, robotRow) {
  if (socket && socket.data) socket.data.dtaroEligible = simulationPolicy.isSimulatedRobot(robotRow);
}

function isEnabled(env = process.env) {
  return String(env[ENV_SWITCH] || "").toLowerCase() === "true";
}

// ── Spatial authority ────────────────────────────────────────────────────────

/** `hierarchy.indexMap` walks every cell; a published map is immutable, so index it once. */
const indexCache = new WeakMap();

function spatialIndexOf(snapshot) {
  const spatial = snapshot && snapshot.spatial;
  if (!spatial || typeof spatial !== "object") return null;
  let index = indexCache.get(spatial);
  if (!index) {
    index = hierarchy.indexMap(spatial);
    indexCache.set(spatial, index);
  }
  return index;
}

function validCoordinates(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

/**
 * Resolve a point to its published cell, zone and region.
 *
 * @param {object|null} snapshot the pinned configuration (`app.locals.config`)
 * @param {number} lat
 * @param {number} lon
 * @returns {{ ok: true, cellId: string, zoneId: string, regionId: string }
 *          |{ ok: false, reason: string, cellId?: string }}
 */
function resolvePoint(snapshot, lat, lon) {
  if (!validCoordinates(lat, lon)) return { ok: false, reason: REJECTION.INVALID_COORDINATES };
  const index = spatialIndexOf(snapshot);
  if (!index) return { ok: false, reason: REJECTION.SPATIAL_AUTHORITY_UNAVAILABLE };
  let cellId;
  try {
    cellId = cells.cellForPoint(lat, lon, cells.RESOLUTION.FINE);
  } catch {
    return { ok: false, reason: REJECTION.INVALID_COORDINATES };
  }
  const resolved = index.resolve(cellId);
  if (!resolved.assigned) return { ok: false, reason: REJECTION.UNASSIGNED_CELL, cellId: resolved.cellId };
  if (!resolved.zoneId || !resolved.regionId) {
    return { ok: false, reason: REJECTION.CELL_HAS_NO_ZONE, cellId: resolved.cellId };
  }
  return { ok: true, cellId: resolved.cellId, zoneId: resolved.zoneId, regionId: resolved.regionId };
}

/**
 * The room a zone's members are in. Region-qualified, and each part is URI-encoded so no
 * pair of ids can produce another pair's room name.
 */
function zoneRoom(regionId, zoneId) {
  return `dtaro:region:${encodeURIComponent(String(regionId))}:zone:${encodeURIComponent(String(zoneId))}`;
}

/** The obstacle's footprint: the boundary of its published fine cell, as `{lat, lon}`. */
function cellFootprint(cellId) {
  return h3.cellToBoundary(cellId).map(([lat, lon]) => ({ lat, lon }));
}

// ── Membership ───────────────────────────────────────────────────────────────

/**
 * Put an authenticated simulated robot's socket in the zone room its position resolves to,
 * leaving any previous one. Idempotent; cheap enough for every accepted telemetry frame
 * (one H3 lookup and one map read).
 *
 * @returns {{ changed: boolean, membership: object|null, reason?: string }}
 */
function syncMembership(socket, snapshot, lat, lon) {
  if (!socket || !socket.data || socket.data.isAuthed !== true || !socket.data.robotId) {
    return { changed: false, membership: null, reason: "NOT_AUTHENTICATED" };
  }
  if (socket.data.dtaroEligible !== true) {
    return { changed: false, membership: null, reason: REJECTION.REPORTER_NOT_SIMULATED };
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    // Position unknown this frame: keep whatever membership the last known position gave.
    return { changed: false, membership: socket.data.dtaroZone || null, reason: "NO_POSITION" };
  }

  const resolved = resolvePoint(snapshot, lat, lon);
  const previous = socket.data.dtaroZone || null;
  const next = resolved.ok
    ? { regionId: resolved.regionId, zoneId: resolved.zoneId, room: zoneRoom(resolved.regionId, resolved.zoneId) }
    : null;

  if ((previous && previous.room) === (next && next.room)) {
    return { changed: false, membership: previous, reason: resolved.ok ? undefined : resolved.reason };
  }
  if (previous && previous.room) socket.leave(previous.room);
  if (next) socket.join(next.room);
  socket.data.dtaroZone = next;
  return { changed: true, membership: next, previous, reason: resolved.ok ? undefined : resolved.reason };
}

// ── Delivery ledger ──────────────────────────────────────────────────────────
//
// Also the duplicate index: ONE active obstacle per (region, published cell). A further report
// whose point resolves to a cell that already holds an active obstacle is the same obstacle as
// far as the published map can tell — the cell is the spatial authority's resolution — so it is
// recorded as a corroboration and is not re-broadcast. No distance or time threshold is chosen
// here: the cell and the obstacle's existing lifetime (the EKB TTL) are the only parameters.
// After expiry a new report starts a new obstacle, which re-alerts the zone.
//
// Which robots each alert was delivered to, so a relevance answer is accepted only from a
// recipient. In-process and bounded: with the Redis adapter on, an answer reaching a
// different process than the report is refused as NOT_A_RECIPIENT (fail closed). Redis is
// off by design locally and Render runs one instance.

const LEDGER_MAX = 1_000;
const ledger = new Map();
/** `${regionId}|${cellId}` → obstacleId, for active obstacles only. */
const activeByCell = new Map();
const cellKey = (regionId, cellId) => `${regionId}|${cellId}`;

/**
 * One report at a time per (region, cell) between the duplicate check and the ledger write.
 * Storing an obstacle awaits the EKB, so without this two reports of one cell arriving together
 * both found no active obstacle and both created and broadcast one.
 */
const cellLocks = new Map();
async function withCellLock(key, fn) {
  const prior = cellLocks.get(key) || Promise.resolve();
  let release;
  const mine = new Promise((resolve) => { release = resolve; });
  const tail = prior.then(() => mine);
  cellLocks.set(key, tail);
  await prior;
  try {
    return await fn();
  } finally {
    release();
    if (cellLocks.get(key) === tail) cellLocks.delete(key);
  }
}

function ledgerPut(entry) {
  const now = Date.now();
  for (const [id, item] of ledger) {
    if (item.expiresAtMs <= now) forget(id, item);
  }
  if (ledger.size >= LEDGER_MAX) {
    const oldest = ledger.keys().next().value;
    forget(oldest, ledger.get(oldest));
  }
  ledger.set(entry.obstacleId, entry);
  if (entry.cellId) activeByCell.set(cellKey(entry.regionId, entry.cellId), entry.obstacleId);
}

function forget(obstacleId, entry) {
  ledger.delete(obstacleId);
  if (entry && entry.cellId && activeByCell.get(cellKey(entry.regionId, entry.cellId)) === obstacleId) {
    activeByCell.delete(cellKey(entry.regionId, entry.cellId));
  }
}

/** The active obstacle in a region's cell, or null (expired entries are forgotten on read). */
function activeObstacleIn(regionId, cellId) {
  const obstacleId = activeByCell.get(cellKey(regionId, cellId));
  return obstacleId ? ledgerGet(obstacleId) : null;
}

function ledgerGet(obstacleId) {
  const entry = ledger.get(obstacleId);
  if (!entry) return null;
  if (entry.expiresAtMs <= Date.now()) {
    forget(obstacleId, entry);
    return null;
  }
  return entry;
}

// ── Dashboard activity log ───────────────────────────────────────────────────
//
// Every DTARO event this service sends to the dashboard (ALERT_CREATED, OBSTACLE_RELEVANCE,
// OBSTACLE_REPORT_MERGED, OBSTACLE_REPORT_REJECTED) is also kept, exactly as sent, in a bounded
// in-process log, so a dashboard that opens or reconnects after a report can replay what it
// missed (`GET /api/dtaro/activity`). Nothing is composed for it: an entry is the payload the
// dashboard room received. Per process and in memory, like the delivery ledger; a restart
// empties it, and the panel then shows only what happens next.

const ACTIVITY_MAX = 200;
const activityLog = [];
let activitySeq = 0;

function toDashboard(io, event, payload) {
  activitySeq += 1;
  activityLog.push({ seq: activitySeq, event, payload });
  if (activityLog.length > ACTIVITY_MAX) activityLog.splice(0, activityLog.length - ACTIVITY_MAX);
  try { dashboardBroadcast.emit(io, event, payload); } catch { /* ignore */ }
}

/** The kept dashboard events, oldest first (copies). */
function recentActivity() {
  return activityLog.map((entry) => ({ seq: entry.seq, event: entry.event, payload: entry.payload }));
}

// ── Report ───────────────────────────────────────────────────────────────────

async function recipientsOf(io, room, exceptRobotId) {
  const sockets = await io.in(room).fetchSockets();
  const ids = new Set();
  for (const s of sockets) {
    const robotId = s.data && s.data.robotId;
    if (robotId && robotId !== exceptRobotId) ids.add(String(robotId));
  }
  return [...ids].sort();
}

function reject(io, socket, reporterRobotId, report, reason, detail) {
  const payload = {
    reportingRobotId: reporterRobotId,
    lat: Number.isFinite(report.lat) ? report.lat : null,
    lon: Number.isFinite(report.lon) ? report.lon : null,
    reason,
    ...(detail || {}),
    timestamp: Date.now(),
  };
  try { socket.emit(REJECTED_EVENT, payload); } catch { /* ignore */ }
  toDashboard(io, REJECTED_EVENT, payload);
  return { accepted: false, reason, payload };
}

/**
 * Process one OBSTACLE_REPORT that already passed authentication, rate limiting and schema.
 *
 * @param {{ io: object, prisma: object, kv: object, snapshot: object|null, socket: object,
 *           reporterRobotId: string, report: { lat: number, lon: number, severity: string },
 *           resolveReporterPosition?: () => Promise<{lat:number, lon:number}|null>,
 *           positionOf?: (robotId: string) => Promise<{lat:number, lon:number, at?: number}|null> }} args
 *   `positionOf` is the server's latest held position of any robot (registry, then cache),
 *   used to cut its commanded corridor. Absent, corridors are used whole (conservative).
 */
async function processReport({ io, prisma, kv, snapshot, socket, reporterRobotId, report, resolveReporterPosition, positionOf, deferDelivery = false }) {
  const { lat, lon, severity } = report;

  if (socket.data.dtaroEligible !== true) {
    return reject(io, socket, reporterRobotId, report, REJECTION.REPORTER_NOT_SIMULATED);
  }

  const located = resolvePoint(snapshot, lat, lon);
  if (!located.ok) {
    return reject(io, socket, reporterRobotId, report, located.reason, located.cellId ? { cellId: located.cellId } : null);
  }

  // The reporter's region: its current zone room if it has one, else the last position the
  // server holds for it. Never a field of the report (the schema strips any it carried).
  let reporterRegionId = socket.data.dtaroZone ? socket.data.dtaroZone.regionId : null;
  if (!reporterRegionId && typeof resolveReporterPosition === "function") {
    const position = await resolveReporterPosition().catch(() => null);
    if (position) {
      const synced = syncMembership(socket, snapshot, position.lat, position.lon);
      reporterRegionId = synced.membership ? synced.membership.regionId : null;
    }
  }
  if (!reporterRegionId) {
    return reject(io, socket, reporterRobotId, report, REJECTION.REPORTER_REGION_UNKNOWN, { cellId: located.cellId });
  }
  if (reporterRegionId !== located.regionId) {
    return reject(io, socket, reporterRobotId, report, REJECTION.WRONG_REGION, {
      cellId: located.cellId,
      reporterRegionId,
      obstacleRegionId: located.regionId,
    });
  }

  const created = await withCellLock(cellKey(located.regionId, located.cellId), async () => {
    const existing = activeObstacleIn(located.regionId, located.cellId);
    if (existing) {
      const repeat = existing.reportingRobotId === reporterRobotId || existing.corroborations.has(reporterRobotId);
      if (!repeat) existing.corroborations.add(reporterRobotId);
      const merged = {
        obstacleId: existing.obstacleId,
        reportingRobotId: reporterRobotId,
        originalReporterId: existing.reportingRobotId,
        corroborations: [...existing.corroborations].sort(),
        repeat,
        regionId: existing.regionId,
        zoneId: existing.zoneId,
        cellId: located.cellId,
        lat,
        lon,
        timestamp: Date.now(),
        expiresAt: new Date(existing.expiresAtMs).toISOString(),
      };
      toDashboard(io, MERGED_EVENT, merged);
      return { merged: { accepted: true, merged: true, obstacle: { obstacleId: existing.obstacleId, timestamp: merged.timestamp }, alert: merged, room: existing.room, recipients: [] } };
    }

    const stored = await ekb.storeObstacle(kv, prisma, {
      lat,
      lon,
      zoneId: located.zoneId,
      severity,
      reportingRobotId: reporterRobotId,
    });

    const zoneRoomName = zoneRoom(located.regionId, located.zoneId);
    // Deferred: nobody is a recipient until a decision delivers the alert (`propagateAlert`).
    const zoneMembers = deferDelivery ? [] : await recipientsOf(io, zoneRoomName, reporterRobotId);
    const ledgerEntry = {
      obstacleId: stored.obstacleId,
      regionId: located.regionId,
      zoneId: located.zoneId,
      room: zoneRoomName,
      reportingRobotId: reporterRobotId,
      cellId: located.cellId,
      recipients: new Set(zoneMembers),
      corroborations: new Set(),
      verdicts: new Map(),
      expiresAtMs: Date.parse(stored.expiresAt) || Date.now() + 300_000,
      // Delivery stage: IMMEDIATE (the default), or AWAITING → PROPAGATED | SUPPRESSED.
      delivery: deferDelivery ? DELIVERY.AWAITING : DELIVERY.IMMEDIATE,
      alert: null,
    };
    ledgerPut(ledgerEntry);
    return { obstacle: stored, room: zoneRoomName, sameZoneRecipients: zoneMembers, entry: ledgerEntry };
  });
  if (created.merged) return created.merged;

  const { obstacle, room, sameZoneRecipients, entry } = created;
  const footprint = { kind: "H3_CELL", cellId: located.cellId, polygon: cellFootprint(located.cellId) };

  const alert = {
    obstacleId: obstacle.obstacleId,
    lat,
    lon,
    severity,
    regionId: located.regionId,
    zoneId: located.zoneId,
    cellId: located.cellId,
    footprint,
    reportingRobotId: reporterRobotId,
    timestamp: obstacle.timestamp,
    expiresAt: obstacle.expiresAt,
  };
  entry.alert = alert;

  if (deferDelivery) {
    // Accepted and stored; delivery waits for a committed decision. Nothing has been emitted.
    return { accepted: true, deferred: true, obstacle, alert, room, footprint, located, recipients: [], sameZoneRecipients: [], crossZoneRecipients: [], recipientDecisions: [], crossZoneError: null };
  }

  const delivered = await deliverAlert({ io, prisma, entry, alert, located, footprint, reporterRobotId, sameZoneRecipients, positionOf });
  return { accepted: true, obstacle, alert, room, ...delivered };
}

/** The delivery stages of a ledger entry. */
const DELIVERY = Object.freeze({
  IMMEDIATE: "IMMEDIATE",
  AWAITING: "AWAITING",
  PROPAGATED: "PROPAGATED",
  SUPPRESSED: "SUPPRESSED",
});

/**
 * Deliver an accepted obstacle's alert: the zone room, then the cross-zone robots, then the
 * dashboard's ALERT_CREATED. `extra` fields (a decision's id and choice) are added to the alert
 * and to ALERT_CREATED; without them both are exactly as they always were.
 */
async function deliverAlert({ io, prisma, entry, alert, located, footprint, reporterRobotId, sameZoneRecipients, positionOf, extra = null }) {
  const room = entry.room;
  const robotAlert = extra ? { ...alert, ...extra } : alert;

  // The reporter is excluded by its robot room, so a reporter with two sockets is excluded
  // from both. Delivery is the Socket.IO room, the same mechanism the Redis adapter extends.
  // The zone room goes first and waits on nothing: the cross-zone step below reads the
  // database, and a slow or failed read must never delay or withhold a same-zone alert.
  io.to(room).except(`robot:${reporterRobotId}`).emit(ALERT_EVENT, robotAlert);

  // Cross-zone step (owner policy 2026-10-23): same-region robots in other zones whose
  // remaining COMMANDED route meets the footprint. Each is added to the ledger before it is
  // alerted, so its relevance answer is accepted, and alerted through its own robot room.
  const crossZone = await crossZoneStep({ io, prisma, located, footprint, reporterRobotId, sameZoneRecipients, positionOf });
  for (const robotId of crossZone.recipients) {
    entry.recipients.add(robotId);
    io.to(`robot:${robotId}`).emit(ALERT_EVENT, { ...robotAlert, via: "REMAINING_ROUTE" });
  }
  const recipients = [...entry.recipients].sort();

  // The existing dashboard event, with the dissemination facts added. SUPER_ADMIN only:
  // ALERT_CREATED is not on dashboardBroadcast's campus allow-list, and this does not add it.
  try {
    toDashboard(io, "ALERT_CREATED", {
      obstacleId: alert.obstacleId,
      lat: alert.lat,
      lon: alert.lon,
      zoneId: located.zoneId,
      zoneName: null,
      severity: alert.severity,
      reportingRobotId: reporterRobotId,
      timestamp: alert.timestamp,
      expiresAt: alert.expiresAt,
      regionId: located.regionId,
      cellId: located.cellId,
      room,
      recipients,
      delivery: "ZONE_ROOM",
      // The published cell the obstacle was localised to, so the dashboard can outline it.
      footprint,
      // Who was considered, selected and alerted, and why (owner policy 2026-10-23).
      recipientPolicy: RECIPIENT_POLICY,
      sameZoneRecipients,
      crossZoneRecipients: crossZone.recipients,
      recipientDecisions: crossZone.decisions,
      ...(crossZone.error ? { crossZoneError: crossZone.error } : {}),
      ...(extra || {}),
    });
  } catch { /* ignore */ }

  return { recipients, sameZoneRecipients, crossZoneRecipients: crossZone.recipients, recipientDecisions: crossZone.decisions, crossZoneError: crossZone.error || null };
}

/**
 * Deliver a DEFERRED obstacle's alert, once, after a decision to do so (STOP / REROUTE). The zone
 * room's members are read now, at delivery, so a robot that entered the zone while the operator
 * decided is alerted too.
 *
 * @param {{ io: object, prisma: object, obstacleId: string, extra?: object, positionOf?: Function }} args
 * @returns {Promise<{ ok: true, recipients: string[], sameZoneRecipients: string[], crossZoneRecipients: string[], recipientDecisions: object[], crossZoneError: string|null }
 *          | { ok: false, reason: string }>}
 */
async function propagateAlert({ io, prisma, obstacleId, extra = null, positionOf }) {
  const entry = ledgerGet(obstacleId);
  if (!entry) return { ok: false, reason: "OBSTACLE_EXPIRED" };
  if (entry.delivery !== DELIVERY.AWAITING) return { ok: false, reason: `DELIVERY_${entry.delivery}` };
  // Claimed synchronously, before any await: a second caller finds PROPAGATED and stops.
  entry.delivery = DELIVERY.PROPAGATED;
  const located = { regionId: entry.regionId, zoneId: entry.zoneId, cellId: entry.cellId };
  const footprint = { kind: "H3_CELL", cellId: entry.cellId, polygon: cellFootprint(entry.cellId) };
  const sameZoneRecipients = await recipientsOf(io, entry.room, entry.reportingRobotId);
  for (const robotId of sameZoneRecipients) entry.recipients.add(robotId);
  const delivered = await deliverAlert({ io, prisma, entry, alert: entry.alert, located, footprint, reporterRobotId: entry.reportingRobotId, sameZoneRecipients, positionOf, extra });
  return { ok: true, ...delivered };
}

/**
 * Suppress a DEFERRED obstacle's alert for good (REJECT_BROADCAST): it can never be delivered
 * afterwards, by this decision or any other. Nothing is emitted to any robot room.
 *
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function suppressAlert({ obstacleId }) {
  const entry = ledgerGet(obstacleId);
  if (!entry) return { ok: false, reason: "OBSTACLE_EXPIRED" };
  if (entry.delivery !== DELIVERY.AWAITING) return { ok: false, reason: `DELIVERY_${entry.delivery}` };
  entry.delivery = DELIVERY.SUPPRESSED;
  return { ok: true };
}

/**
 * Every authenticated, DTARO-eligible robot socket with a zone membership, one entry per robot.
 * A robot with sockets in two zones counts in `preferZoneId` if any socket is in it.
 */
async function eligibleRobots(io, preferZoneId) {
  if (!io || typeof io.fetchSockets !== "function") return [];
  const byRobot = new Map();
  for (const s of await io.fetchSockets()) {
    const data = s.data || {};
    if (data.isAuthed !== true || data.dtaroEligible !== true || !data.robotId || !data.dtaroZone) continue;
    const robotId = String(data.robotId);
    const here = { robotId, regionId: data.dtaroZone.regionId, zoneId: data.dtaroZone.zoneId };
    const seen = byRobot.get(robotId);
    if (!seen || (seen.zoneId !== preferZoneId && here.zoneId === preferZoneId)) byRobot.set(robotId, here);
  }
  return [...byRobot.values()];
}

/**
 * The cross-zone half of delivery. Reads each same-region robot's commanded corridor from the
 * server (`dtaroCommandedRoute.readCommandedRoutes`), cuts it at the robot's latest
 * server-held position, and lets `dtaroRecipientPolicy.selectRecipients` decide.
 *
 * Never throws: a failure is reported in `error`, no cross-zone robot is alerted, and the
 * zone room (already delivered) is unaffected.
 *
 * @returns {Promise<{ recipients: string[], decisions: object[], error?: string }>}
 */
async function crossZoneStep({ io, prisma, located, footprint, reporterRobotId, sameZoneRecipients, positionOf }) {
  try {
    const inZoneRoom = new Set(sameZoneRecipients);
    const { candidates, routeFacts, picked } = await assessRecipients({ io, prisma, located, footprint: footprint.polygon, reporterRobotId, positionOf });
    const recipients = picked.crossZone.filter((robotId) => !inZoneRoom.has(robotId)).sort();
    const alerted = new Set([...inZoneRoom, ...recipients]);
    const decisions = picked.decisions.map((d) => {
      const facts = routeFacts.get(d.robotId);
      const { remaining, ...route } = facts || {};
      void remaining;
      const zone = candidates.find((c) => c.robotId === d.robotId);
      return { ...d, zoneId: zone ? zone.zoneId : null, alerted: alerted.has(d.robotId), route: facts ? route : null };
    });
    return { recipients, decisions };
  } catch (error) {
    return { recipients: [], decisions: [], error: String((error && error.message) || error) };
  }
}

/**
 * `assessFleet` plus the recipient policy's verdict for every candidate (`selectRecipients`). The
 * one place the policy is applied: the cross-zone step and the operator-decision step both read it
 * here, so the policy stays wired through this service only.
 *
 * @returns {Promise<{ candidates: object[], routeFacts: Map, details: Map, picked: object }>}
 */
async function assessRecipients({ io, prisma, located, footprint, reporterRobotId, positionOf, includeReporter = false }) {
  const fleet = await assessFleet({ io, prisma, located, reporterRobotId, positionOf, includeReporter });
  const picked = selectRecipients({
    obstacle: { regionId: located.regionId, zoneId: located.zoneId, footprint },
    robots: fleet.candidates.map((r) => ({
      ...r,
      remainingRoute: fleet.routeFacts.has(r.robotId) ? fleet.routeFacts.get(r.robotId).remaining : null,
      // A route the server could not establish is unknown, not absent (conservative policy).
      routeUnknown: fleet.routeFacts.has(r.robotId) && commandedRoute.UNKNOWN_ROUTE_STATUSES.includes(fleet.routeFacts.get(r.robotId).status),
    })),
    reporterRobotId,
  });
  return { ...fleet, picked };
}

/**
 * The server's view of every eligible robot for one obstacle: its zone membership and, for each
 * same-region robot, its commanded route read from the server and cut at its server-held
 * position. `routeFacts` is what `ALERT_CREATED` reports (plus the `remaining` points); `details`
 * keeps what the decision step also needs — the raw route (stops, task) and the position used.
 * The reporter is left out unless `includeReporter`.
 *
 * @returns {Promise<{ candidates: object[], routeFacts: Map<string, object>, details: Map<string, { route: object, position: object|null, segmentIndex: number|null }> }>}
 */
async function assessFleet({ io, prisma, located, reporterRobotId, positionOf, includeReporter = false }) {
  const candidates = await eligibleRobots(io, located.zoneId);
  const sameRegion = candidates.filter((r) => r.regionId === located.regionId && (includeReporter || r.robotId !== reporterRobotId));
  const routes = await commandedRoute.readCommandedRoutes(prisma, sameRegion.map((r) => r.robotId));
  const toleranceM = commandedRoute.corridorToleranceM();
  const routeFacts = new Map();
  const details = new Map();
  for (const robot of sameRegion) {
    const route = routes.get(robot.robotId) || { status: commandedRoute.ROUTE_STATUS.LOOKUP_FAILED, points: [] };
    let position = null;
    if (route.status === commandedRoute.ROUTE_STATUS.OK && typeof positionOf === "function") {
      position = await Promise.resolve(positionOf(robot.robotId)).catch(() => null);
    }
    const remaining = route.status === commandedRoute.ROUTE_STATUS.OK ? commandedRoute.remainingRoute(route.points, position, { toleranceM }) : null;
    details.set(robot.robotId, { route, position, segmentIndex: remaining ? remaining.segmentIndex : null });
    routeFacts.set(robot.robotId, {
      source: "OFFER",
      status: route.status,
      commitmentId: route.commitmentId || null,
      offerCreatedAt: route.offerCreatedAt || null,
      leaseExpired: route.leaseExpired === true,
      corridorPoints: route.points.length,
      cut: remaining ? remaining.cut : null,
      remainingPoints: remaining ? remaining.points.length : 0,
      offRouteM: remaining ? remaining.offRouteM : null,
      positionAt: position && Number.isFinite(position.at) ? position.at : null,
      remaining: remaining && remaining.points.length > 0 ? remaining.points : null,
    });
  }
  return { candidates, routeFacts, details };
}

/**
 * Accept one OBSTACLE_RELEVANCE answer and relay it to the dashboard.
 *
 * @returns {{ accepted: boolean, reason?: string, payload?: object }}
 */
function recordRelevance({ io, robotId, payload }) {
  const parsed = relevanceSchema.safeParse(payload || {});
  if (!parsed.success) return { accepted: false, reason: "INVALID_PAYLOAD" };
  const answer = parsed.data;

  const entry = ledgerGet(answer.obstacleId);
  if (!entry) return { accepted: false, reason: "UNKNOWN_OBSTACLE" };
  if (!entry.recipients.has(robotId)) return { accepted: false, reason: "NOT_A_RECIPIENT" };
  if (entry.verdicts.has(robotId)) return { accepted: false, reason: "DUPLICATE" };

  const relayed = {
    obstacleId: answer.obstacleId,
    robotId,
    relevant: answer.relevant,
    routeSource: answer.routeSource,
    taskId: answer.taskId ?? null,
    routePoints: answer.routePoints ?? null,
    decision: answer.decision,
    regionId: entry.regionId,
    zoneId: entry.zoneId,
    reportingRobotId: entry.reportingRobotId,
    timestamp: Date.now(),
    // The obstacle's own expiry, so a dashboard that never saw its alert still lets it expire.
    expiresAt: new Date(entry.expiresAtMs).toISOString(),
  };
  entry.verdicts.set(robotId, relayed);
  toDashboard(io, RELEVANCE_EVENT, relayed);
  return { accepted: true, payload: relayed };
}

/**
 * Every obstacle still active in a region (unexpired ledger entries), with its footprint: what a
 * simulated detour must keep clear of, whatever was decided about each.
 *
 * @returns {Array<{ obstacleId: string, cellId: string, polygon: Array<{lat:number, lon:number}> }>}
 */
function activeObstacles(regionId) {
  const out = [];
  for (const [obstacleId] of ledger) {
    const entry = ledgerGet(obstacleId);
    if (entry && entry.regionId === regionId && entry.cellId) out.push({ obstacleId, cellId: entry.cellId, polygon: cellFootprint(entry.cellId) });
  }
  return out;
}

/** Test seam. */
function resetForTests() {
  ledger.clear();
  activeByCell.clear();
  cellLocks.clear();
  activityLog.length = 0;
}

module.exports = {
  ENV_SWITCH,
  ALERT_EVENT,
  RELEVANCE_EVENT,
  REJECTED_EVENT,
  MERGED_EVENT,
  REJECTION,
  ROUTE_SOURCES,
  RECIPIENT_POLICY,
  AUTH_SELECT,
  admitSession,
  isEnabled,
  resolvePoint,
  zoneRoom,
  cellFootprint,
  syncMembership,
  processReport,
  propagateAlert,
  suppressAlert,
  assessFleet,
  assessRecipients,
  RECIPIENT_REASON,
  eligibleRobots,
  activeObstacles,
  DELIVERY,
  recordRelevance,
  ledgerGet,
  recentActivity,
  resetForTests,
};