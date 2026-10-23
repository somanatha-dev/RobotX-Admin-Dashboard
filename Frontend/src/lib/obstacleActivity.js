/**
 * DTARO obstacle activity — what the dashboard knows about zone-delivered obstacle alerts.
 *
 * Built ONLY from three backend events (SUPER_ADMIN sockets):
 *   · `ALERT_CREATED` with `delivery: "ZONE_ROOM"` — a report the server accepted and delivered
 *     to a zone room, with its recipients. The legacy `ALERT_CREATED` (no `delivery`) is NOT
 *     activity: it keeps its old treatment in AppProvider, so with the feature off nothing new
 *     appears.
 *   · `OBSTACLE_RELEVANCE` — one recipient's own verdict, relayed by the server.
 *   · `OBSTACLE_REPORT_REJECTED` — a report the server refused, with its reason.
 *
 * Nothing is inferred: a recipient with no verdict yet is PENDING, never "not relevant"; a
 * verdict is a decision only (no reroute exists in V1); an obstacle's zone and region are the
 * server's, never a client guess. Bounded, newest first.
 */

export const OBSTACLE_EVENTS = Object.freeze({
  ALERT_CREATED: 'ALERT_CREATED',
  RELEVANCE: 'OBSTACLE_RELEVANCE',
  REJECTED: 'OBSTACLE_REPORT_REJECTED',
  MERGED: 'OBSTACLE_REPORT_MERGED',
});

export const RECIPIENT_STATUS = Object.freeze({
  RELEVANT: 'RELEVANT',
  NOT_RELEVANT: 'NOT_RELEVANT',
  NO_ROUTE: 'NO_ROUTE',
  PENDING: 'PENDING',
});

export const ACTIVITY_FILTER = Object.freeze({ ALL: 'ALL', RELEVANT: 'RELEVANT', REFUSED: 'REFUSED' });

export const MAX_OBSTACLES = 50;
export const MAX_REFUSALS = 50;

const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const timeOf = (v) => {
  const ms = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(ms) ? ms : null;
};

export const EMPTY_ACTIVITY = Object.freeze({ obstacles: Object.freeze([]), refusals: Object.freeze([]), version: 0 });

/** True for an `ALERT_CREATED` produced by the zone-room path (feature on). */
export function isZoneDelivery(payload) {
  return payload?.delivery === 'ZONE_ROOM';
}

/** The server's per-robot decisions, kept as stated (no field is inferred). */
function decisionsFrom(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((d) => d && text(d.robotId))
    .map((d) => ({
      robotId: text(d.robotId),
      zoneId: text(d.zoneId),
      relation: text(d.relation),
      reason: text(d.reason),
      selected: d.selected === true,
      alerted: d.alerted === true,
      routeIntersects: typeof d.routeIntersects === 'boolean' ? d.routeIntersects : null,
      routeStatus: text(d.route?.status),
      cut: text(d.route?.cut),
    }));
}

function obstacleFrom(payload, previous) {
  return {
    obstacleId: text(payload.obstacleId),
    reportingRobotId: text(payload.reportingRobotId),
    lat: num(payload.lat),
    lon: num(payload.lon),
    regionId: text(payload.regionId),
    zoneId: text(payload.zoneId),
    cellId: text(payload.cellId),
    // Robot-supplied and advisory; shown as reported, never turned into a hazard class.
    severity: text(payload.severity),
    reportedAtMs: timeOf(payload.timestamp),
    expiresAtMs: timeOf(payload.expiresAt),
    recipients: Array.isArray(payload.recipients) ? payload.recipients.map(text).filter(Boolean) : [],
    // Cross-zone recipients (owner policy 2026-10-23): alerted because their remaining commanded
    // route meets the obstacle, though they are in another zone.
    crossZoneRecipients: Array.isArray(payload.crossZoneRecipients) ? payload.crossZoneRecipients.map(text).filter(Boolean) : [],
    // The server's record of every robot it considered, and why it did or did not alert it.
    decisions: decisionsFrom(payload.recipientDecisions),
    footprint: Array.isArray(payload.footprint?.polygon) ? payload.footprint.polygon : null,
    verdicts: previous?.verdicts || {},
    corroborations: previous?.corroborations || [],
    partial: false,
  };
}

/**
 * Apply one backend event. Pure: returns the same state object when the event is not activity.
 *
 * @param {object} state
 * @param {string} event
 * @param {object} payload
 * @param {number} [nowMs]
 */
export function applyObstacleEvent(state, event, payload, nowMs = Date.now()) {
  const current = state || EMPTY_ACTIVITY;
  if (!payload || typeof payload !== 'object') return current;

  if (event === OBSTACLE_EVENTS.ALERT_CREATED) {
    if (!isZoneDelivery(payload)) return current;
    const obstacleId = text(payload.obstacleId);
    if (!obstacleId) return current;
    const previous = current.obstacles.find((o) => o.obstacleId === obstacleId);
    const next = obstacleFrom(payload, previous);
    const rest = current.obstacles.filter((o) => o.obstacleId !== obstacleId);
    return { ...current, obstacles: [next, ...rest].slice(0, MAX_OBSTACLES), version: current.version + 1 };
  }

  if (event === OBSTACLE_EVENTS.RELEVANCE) {
    const obstacleId = text(payload.obstacleId);
    const robotId = text(payload.robotId);
    if (!obstacleId || !robotId || typeof payload.relevant !== 'boolean') return current;
    const verdict = {
      relevant: payload.relevant,
      decision: text(payload.decision),
      routeSource: text(payload.routeSource),
      taskId: text(payload.taskId),
      atMs: timeOf(payload.timestamp) ?? nowMs,
    };
    const existing = current.obstacles.find((o) => o.obstacleId === obstacleId);
    // A verdict for an alert this page did not see (it opened afterwards): keep what the
    // verdict itself states, marked partial — no location, no recipient list is invented.
    const base = existing || {
      obstacleId,
      reportingRobotId: text(payload.reportingRobotId),
      lat: null,
      lon: null,
      regionId: text(payload.regionId),
      zoneId: text(payload.zoneId),
      cellId: null,
      severity: null,
      reportedAtMs: null,
      expiresAtMs: null,
      recipients: [],
      footprint: null,
      verdicts: {},
      corroborations: [],
      partial: true,
    };
    const updated = { ...base, verdicts: { ...base.verdicts, [robotId]: verdict } };
    if (updated.partial && !updated.recipients.includes(robotId)) updated.recipients = [...updated.recipients, robotId];
    const rest = current.obstacles.filter((o) => o.obstacleId !== obstacleId);
    const obstacles = existing
      ? current.obstacles.map((o) => (o.obstacleId === obstacleId ? updated : o))
      : [updated, ...rest].slice(0, MAX_OBSTACLES);
    return { ...current, obstacles, version: current.version + 1 };
  }

  if (event === OBSTACLE_EVENTS.MERGED) {
    // Another report of an obstacle already active in that published cell. The server sends the
    // full corroborating set; a merge for an obstacle this page never saw is not invented.
    const obstacleId = text(payload.obstacleId);
    if (!obstacleId || !Array.isArray(payload.corroborations)) return current;
    if (!current.obstacles.some((o) => o.obstacleId === obstacleId)) return current;
    const corroborations = payload.corroborations.map(text).filter(Boolean);
    return {
      ...current,
      obstacles: current.obstacles.map((o) => (o.obstacleId === obstacleId ? { ...o, corroborations } : o)),
      version: current.version + 1,
    };
  }

  if (event === OBSTACLE_EVENTS.REJECTED) {
    const reason = text(payload.reason);
    if (!reason) return current;
    const atMs = timeOf(payload.timestamp) ?? nowMs;
    // Deterministic, so a refusal replayed from `/api/dtaro/activity` is the same refusal, not a second.
    const id = `${atMs}:${text(payload.reportingRobotId) || '?'}:${reason}:${num(payload.lat) ?? ''}:${num(payload.lon) ?? ''}`;
    if (current.refusals.some((r) => r.id === id)) return current;
    const refusal = {
      id,
      reportingRobotId: text(payload.reportingRobotId),
      lat: num(payload.lat),
      lon: num(payload.lon),
      reason,
      cellId: text(payload.cellId),
      reporterRegionId: text(payload.reporterRegionId),
      obstacleRegionId: text(payload.obstacleRegionId),
      atMs,
    };
    return { ...current, refusals: [refusal, ...current.refusals].slice(0, MAX_REFUSALS), version: current.version + 1 };
  }

  return current;
}

/** One recipient's state, from the verdict the server relayed — or PENDING. */
export function recipientStatus(obstacle, robotId) {
  const verdict = obstacle?.verdicts?.[robotId];
  if (!verdict) return RECIPIENT_STATUS.PENDING;
  if (verdict.routeSource === 'NONE') return RECIPIENT_STATUS.NO_ROUTE;
  return verdict.relevant ? RECIPIENT_STATUS.RELEVANT : RECIPIENT_STATUS.NOT_RELEVANT;
}

export function obstacleCounts(obstacle) {
  const counts = { recipients: 0, relevant: 0, notRelevant: 0, noRoute: 0, pending: 0 };
  for (const robotId of obstacle?.recipients || []) {
    counts.recipients += 1;
    const status = recipientStatus(obstacle, robotId);
    if (status === RECIPIENT_STATUS.RELEVANT) counts.relevant += 1;
    else if (status === RECIPIENT_STATUS.NOT_RELEVANT) counts.notRelevant += 1;
    else if (status === RECIPIENT_STATUS.NO_ROUTE) counts.noRoute += 1;
    else counts.pending += 1;
  }
  return counts;
}

export function isExpired(obstacle, nowMs = Date.now()) {
  return Number.isFinite(obstacle?.expiresAtMs) && obstacle.expiresAtMs <= nowMs;
}

/**
 * The activity list for the panel, scoped to a campus.
 *
 * `regionIds` — the published region ids of the selected campus, or `null` when no campus is
 * selected (then everything is listed, each entry naming its region). An entry whose region is
 * not one of them is hidden and counted; a refusal that names no region (invalid coordinates,
 * an unassigned cell) can belong to no campus and is listed only without a campus.
 *
 * @returns {{ entries: object[], hiddenCount: number }}
 */
export function activityEntries(state, { regionIds = null, filter = ACTIVITY_FILTER.ALL } = {}) {
  const current = state || EMPTY_ACTIVITY;
  const scope = Array.isArray(regionIds) ? new Set(regionIds) : null;
  const inScope = (...ids) => scope === null || ids.some((id) => id && scope.has(id));
  let hiddenCount = 0;
  const entries = [];

  for (const obstacle of current.obstacles) {
    if (!inScope(obstacle.regionId)) {
      hiddenCount += 1;
      continue;
    }
    const counts = obstacleCounts(obstacle);
    if (filter === ACTIVITY_FILTER.REFUSED) continue;
    if (filter === ACTIVITY_FILTER.RELEVANT && counts.relevant === 0) continue;
    entries.push({ kind: 'OBSTACLE', key: `o:${obstacle.obstacleId}`, atMs: obstacle.reportedAtMs, obstacle, counts });
  }
  for (const refusal of current.refusals) {
    if (!inScope(refusal.reporterRegionId, refusal.obstacleRegionId)) {
      hiddenCount += 1;
      continue;
    }
    if (filter === ACTIVITY_FILTER.RELEVANT) continue;
    entries.push({ kind: 'REFUSAL', key: `r:${refusal.id}`, atMs: refusal.atMs, refusal });
  }
  entries.sort((a, b) => (b.atMs ?? 0) - (a.atMs ?? 0));
  return { entries, hiddenCount };
}

/** Plain-language refusal reasons; the code is shown beside it. */
export const REFUSAL_TEXT = Object.freeze({
  INVALID_COORDINATES: 'invalid coordinates',
  SPATIAL_AUTHORITY_UNAVAILABLE: 'no published zone map on the server',
  UNASSIGNED_CELL: 'the point is in no published cell',
  CELL_HAS_NO_ZONE: 'the cell has no zone',
  REPORTER_NOT_SIMULATED: 'only simulated robots may report',
  REPORTER_REGION_UNKNOWN: "the reporter's region is unknown",
  WRONG_REGION: "the point is outside the reporter's region",
});

export const STATUS_TEXT = Object.freeze({
  [RECIPIENT_STATUS.RELEVANT]: 'On its commanded route',
  [RECIPIENT_STATUS.NOT_RELEVANT]: 'Not on its commanded route',
  [RECIPIENT_STATUS.NO_ROUTE]: 'No planned route',
  [RECIPIENT_STATUS.PENDING]: 'Awaiting its answer',
});

/** HH:MM:SS, local, or null. */
export function clockOf(ms) {
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * A tiny external store, so the activity outlives page navigation (like the route cache) and
 * only the components that read it re-render when it changes.
 */
export function createObstacleActivityStore() {
  let state = EMPTY_ACTIVITY;
  const listeners = new Set();
  const emit = () => {
    for (const fn of [...listeners]) fn();
  };
  return {
    getSnapshot: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    apply(event, payload, nowMs) {
      const next = applyObstacleEvent(state, event, payload, nowMs);
      if (next === state) return false;
      state = next;
      emit();
      return true;
    },
    /**
     * Replay events the server already sent (`GET /api/dtaro/activity`), oldest first, through
     * the same reducer. Idempotent: an event already applied leaves the state as it was.
     */
    hydrate(events, nowMs) {
      let next = state;
      for (const entry of Array.isArray(events) ? events : []) {
        if (entry && typeof entry.event === 'string') next = applyObstacleEvent(next, entry.event, entry.payload, nowMs);
      }
      if (next === state) return false;
      state = next;
      emit();
      return true;
    },
    reset() {
      if (state === EMPTY_ACTIVITY) return;
      state = EMPTY_ACTIVITY;
      emit();
    },
    listenerCount: () => listeners.size,
  };
}

/** The dashboard's one store (AppProvider feeds it; the map page reads it). */
export const obstacleActivityStore = createObstacleActivityStore();
