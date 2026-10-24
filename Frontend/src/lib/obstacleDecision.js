/**
 * DTARO operator decisions — what the dashboard knows about each obstacle decision.
 *
 * Built ONLY from the server: `OBSTACLE_DECISION_REQUIRED` / `OBSTACLE_DECISION_UPDATED` (SUPER_ADMIN
 * sockets), the reply to a decision request, and `GET /api/dtaro/decisions` on (re)connect. Each
 * carries the WHOLE decision as the server holds it, with a `revision` that only rises: a payload
 * whose revision is not newer than the one held is ignored, so a late, replayed or reordered event
 * can never move a decision backwards (an expired obstacle is never made active again, an
 * executed reroute never shown as pending).
 *
 * The deadline is the server's (`deadlineAt`). The countdown shown is presentation only: it is the
 * server's deadline minus the server's time, estimated as this page's clock plus the offset the
 * server's own `serverNow` reveals — so a reconnect or a skewed laptop clock neither restarts nor
 * stretches it. Nothing here decides anything; at the deadline the SERVER applies its default.
 *
 * Simulated fleet only: the server refuses obstacle reports from anything else, and says so in
 * every payload (`provenance: "SIMULATED"`).
 */

export const DECISION_EVENTS = Object.freeze({
  REQUIRED: 'OBSTACLE_DECISION_REQUIRED',
  UPDATED: 'OBSTACLE_DECISION_UPDATED',
});

export const CHOICE = Object.freeze({ STOP: 'STOP', REROUTE: 'REROUTE', REJECT_BROADCAST: 'REJECT_BROADCAST' });
export const SOURCE = Object.freeze({ MANUAL: 'MANUAL', DEFAULT_TIMEOUT: 'DEFAULT_TIMEOUT' });

export const DECISION_STATUS = Object.freeze({
  REPORTED: 'REPORTED',
  AWAITING_OPERATOR_DECISION: 'AWAITING_OPERATOR_DECISION',
  DECIDED: 'DECIDED',
  PROPAGATED: 'PROPAGATED',
  SUPPRESSED: 'SUPPRESSED',
  EXECUTING: 'EXECUTING',
  COMPLETED: 'COMPLETED',
  EXPIRED: 'EXPIRED',
  ABANDONED_ON_RESTART: 'ABANDONED_ON_RESTART',
});

export const MAX_DECISIONS = 30;

const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const timeOf = (v) => {
  const ms = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(ms) ? ms : null;
};

export const EMPTY_DECISIONS = Object.freeze({ decisions: Object.freeze([]), offsetMs: 0, version: 0 });

/**
 * The server's clock minus this page's, from one payload's `serverNow`; null when it cannot tell.
 *
 * A one-way measurement: `serverNow` was stamped before the event travelled, so the value is the
 * true offset MINUS the delivery delay — never more than the truth. Taken as it is, that delay
 * would make the countdown LONGER than the server's (an operator shown "5 s" with 3.8 s left).
 * So the offset kept is the largest seen, and never below zero: the countdown can only ever be
 * shorter than the server's, never longer.
 */
export function clockOffsetOf(payload, receivedAtMs) {
  const server = timeOf(payload?.serverNow);
  return server !== null && Number.isFinite(receivedAtMs) ? server - receivedAtMs : null;
}

const keptOffset = (current, measured) => (measured === null ? current : Math.max(0, current, measured));

function normalise(payload) {
  const decisionId = text(payload?.decisionId);
  if (!decisionId) return null;
  return {
    ...payload,
    decisionId,
    revision: num(payload.revision) ?? 0,
    receivedAtMs: timeOf(payload.receivedAt),
    deadlineAtMs: timeOf(payload.deadlineAt),
    robots: Array.isArray(payload.robots) ? payload.robots.filter((r) => r && text(r.robotId)) : [],
    history: Array.isArray(payload.history) ? payload.history : [],
  };
}

/**
 * Apply one server payload (a whole decision). Pure; returns the same state when nothing changed.
 *
 * @param {object} state
 * @param {object} payload
 * @param {{ receivedAtMs?: number, askedAtMs?: number }} [options] `receivedAtMs`: this page's clock when the
 *   state arrived (the earliest "now" it is shown at). `askedAtMs`: for a state this page requested, when
 *   it asked — the server stamped `serverNow` after that, so the offset measured from it can only be
 *   too large, which only ever shortens the countdown
 */
export function applyDecision(state, payload, { receivedAtMs = Date.now(), askedAtMs } = {}) {
  const current = state || EMPTY_DECISIONS;
  const next = normalise(payload);
  if (!next) return current;
  const offset = clockOffsetOf(payload, Number.isFinite(askedAtMs) ? askedAtMs : receivedAtMs);
  const existing = current.decisions.find((d) => d.decisionId === next.decisionId);
  // Never backwards. An archived row (revision 0) never replaces what this page holds live.
  const offsetMs = keptOffset(current.offsetMs, offset);
  if (existing && (next.revision <= existing.revision || (next.archived && !existing.archived))) {
    return offsetMs !== current.offsetMs ? { ...current, offsetMs } : current;
  }
  // This page's clock when it received the state: the panel never counts down from earlier.
  next.seenAtMs = Number.isFinite(receivedAtMs) ? receivedAtMs : null;
  const rest = current.decisions.filter((d) => d.decisionId !== next.decisionId);
  const decisions = [next, ...rest].sort((a, b) => (b.receivedAtMs ?? 0) - (a.receivedAtMs ?? 0)).slice(0, MAX_DECISIONS);
  return { decisions, offsetMs, version: current.version + 1 };
}

/** Milliseconds left before the server's deadline, by the server's clock (never below 0). */
export function remainingMs(decision, nowMs = Date.now(), offsetMs = 0) {
  if (!decision || !Number.isFinite(decision.deadlineAtMs)) return 0;
  // A page clock read before this state arrived (a panel opening long after its last tick) is
  // never used: the state's own arrival time is the earliest "now" it can be shown at.
  const now = Math.max(nowMs, Number.isFinite(decision.seenAtMs) ? decision.seenAtMs : -Infinity);
  return Math.max(0, decision.deadlineAtMs - (now + (Number.isFinite(offsetMs) ? offsetMs : 0)));
}

/** The countdown shown: whole seconds, 5 … 0. */
export function countdownSeconds(decision, nowMs = Date.now(), offsetMs = 0) {
  return Math.ceil(remainingMs(decision, nowMs, offsetMs) / 1000);
}

/** True while the server waits for an operator (whatever this page's clock says). */
export function isAwaiting(decision) {
  return decision?.status === DECISION_STATUS.AWAITING_OPERATOR_DECISION && !decision.decision;
}

/**
 * The decision the panel should open on: the awaiting one with the soonest deadline that this
 * page has not set aside; otherwise null. Every other awaiting decision is counted.
 */
export function nextAwaiting(state, { setAside = new Set() } = {}) {
  const awaiting = (state || EMPTY_DECISIONS).decisions.filter((d) => isAwaiting(d) && !setAside.has(d.decisionId));
  awaiting.sort((a, b) => (a.deadlineAtMs ?? 0) - (b.deadlineAtMs ?? 0));
  return { decision: awaiting[0] || null, others: Math.max(0, awaiting.length - 1) };
}

export const CHOICE_TEXT = Object.freeze({
  [CHOICE.STOP]: 'Stop',
  [CHOICE.REROUTE]: 'Reroute',
  [CHOICE.REJECT_BROADCAST]: 'Reject broadcast',
});

export const STATUS_TEXT = Object.freeze({
  [DECISION_STATUS.REPORTED]: 'Reported',
  [DECISION_STATUS.AWAITING_OPERATOR_DECISION]: 'Awaiting operator decision',
  [DECISION_STATUS.DECIDED]: 'Decided',
  [DECISION_STATUS.PROPAGATED]: 'Fleet alerted',
  [DECISION_STATUS.SUPPRESSED]: 'Broadcast rejected — fleet alert suppressed',
  [DECISION_STATUS.EXECUTING]: 'Simulated robots executing',
  [DECISION_STATUS.COMPLETED]: 'Completed',
  [DECISION_STATUS.EXPIRED]: 'Expired — obstacle lifetime ended, not confirmed clear',
  [DECISION_STATUS.ABANDONED_ON_RESTART]: 'Abandoned — the server restarted',
});

/** Why the server considers a robot affected (or not): its own reason codes, in words. */
export const AFFECTED_TEXT = Object.freeze({
  ROUTE_CROSSES_OBSTACLE: 'its remaining commanded route crosses the obstacle',
  ROUTE_UNKNOWN: 'its commanded route cannot be read — included to be safe',
  REPORTER_APPROACHING: 'reported it, and its remaining route runs into it',
  REPORTER_ROUTE_UNKNOWN: "reported it; its route cannot be read — included to be safe",
  REPORTER_NOT_APPROACHING: 'reported it; its route does not run into it',
  SAME_ZONE_ROUTE_CLEAR: 'same zone; its route is clear of the obstacle',
  SAME_ZONE_IDLE: 'same zone; idle (no commanded route)',
  ROUTE_CLEAR: 'other zone; route clear of the obstacle',
  NO_REMAINING_ROUTE: 'other zone; no commanded route',
  NO_ZONE: 'no zone; no commanded route',
  OTHER_REGION: 'another region — never notified',
  DETOUR_CROSSES_OBSTACLE: 'its alternate route from an earlier decision runs into it',
  DETOUR_CLEAR: 'on an alternate route from an earlier decision, clear of it',
});

/** One robot's simulated execution state, in words. */
export const EXECUTION_TEXT = Object.freeze({
  STOP_SENT: 'Stop sent — awaiting the robot',
  STOPPED: 'Stopped',
  REROUTING: 'Rerouting — alternate route sent',
  MOVING: 'Moving on the alternate route',
  COMPLETED: 'Reached its destination on the alternate route',
  NO_SAFE_ROUTE: 'No safe alternate route available — stop sent',
  STOPPED_NO_SAFE_ROUTE: 'Stopped — no safe alternate route available',
  REFUSED_STOPPED: 'Stopped — the robot could not verify the alternate route',
  NOT_DELIVERED: 'Not delivered — the robot is not connected',
  UNCONFIRMED: 'Not confirmed by the robot',
  SUPERSEDED: 'Superseded by a later decision for another obstacle',
});

export const ROBOT_STATE_TEXT = Object.freeze({
  ACTIVE: 'moving',
  IDLE: 'idle',
  PAUSED: 'stopped',
  CHARGING: 'charging',
  RETURNING: 'returning',
  ISSUES: 'moving (low battery)',
  OFFLINE: 'disconnected',
});

/** How the committed decision was made, in one line. */
export function decisionLine(decision) {
  const d = decision?.decision;
  if (!d) return null;
  const choice = CHOICE_TEXT[d.choice] || d.choice;
  return d.source === SOURCE.DEFAULT_TIMEOUT
    ? `${choice} — applied automatically by the server: no operator decision within ${Math.round((decision.windowMs || 5000) / 1000)} s`
    : `${choice} — chosen by an operator`;
}

/** The counts the history lists. */
export function decisionCounts(decision) {
  const c = decision?.counts || {};
  return {
    affected: num(c.affected) ?? 0,
    delivered: num(c.delivered) ?? 0,
    suppressed: num(c.suppressed) ?? 0,
    rerouted: num(c.rerouted) ?? 0,
    noSafeRoute: num(c.noSafeRoute) ?? 0,
    stopped: num(c.stopped) ?? 0,
  };
}

/** The decisions of the selected campus's regions (all of them when no campus is selected). */
export function decisionsInScope(state, regionIds = null) {
  const scope = Array.isArray(regionIds) ? new Set(regionIds) : null;
  return (state || EMPTY_DECISIONS).decisions.filter((d) => scope === null || scope.has(d.obstacle?.regionId));
}

/** HH:MM:SS, local, or null. */
export function clockOf(ms) {
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** A small external store (AppProvider feeds it; the panel and the map read it). */
export function createObstacleDecisionStore() {
  let state = EMPTY_DECISIONS;
  const listeners = new Set();
  const emit = () => {
    for (const fn of [...listeners]) fn();
  };
  const set = (next) => {
    if (next === state) return false;
    state = next;
    emit();
    return true;
  };
  return {
    getSnapshot: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    apply(payload, receivedAtMs = Date.now()) {
      return set(applyDecision(state, payload, { receivedAtMs }));
    },
    /** `GET /api/dtaro/decisions` — every decision through the same reducer (idempotent). */
    hydrate(list, askedAtMs, receivedAtMs = Date.now()) {
      let next = state;
      for (const payload of Array.isArray(list) ? list : []) next = applyDecision(next, payload, { receivedAtMs, askedAtMs });
      return set(next);
    },
    reset() {
      set(EMPTY_DECISIONS);
    },
    listenerCount: () => listeners.size,
  };
}

/** The dashboard's one store. */
export const obstacleDecisionStore = createObstacleDecisionStore();
