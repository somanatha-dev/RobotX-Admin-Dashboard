"use strict";

/**
 * A physical agent's own statement of whether it could execute a mission now — the optional
 * `readiness` block on TELEMETRY:
 *
 *     readiness: { blockers: ["NO_MOTOR_LINK", "NO_POSITION_FIX"] }
 *
 * `blockers` is the list of reasons the agent would refuse an offer right now, in the same
 * vocabulary its `OFFER_REJECT` uses (`offerRefusal.AGENT_READINESS_REFUSALS`); `[]` means the
 * agent reports nothing blocking. Omitted means not reported.
 *
 * ── Why `IDLE` is not this ─────────────────────────────────────────────────
 * `status: IDLE` is the agent's operating mode. A rover with a silent ESP32, motion disabled
 * and no GPS fix is IDLE. Nothing in `status` says the means to execute exist; this block does.
 *
 * ── It only ever restricts (§23.5) ─────────────────────────────────────────
 * Self-reported degradation is trusted because a false positive costs an agent-shift;
 * self-reported fitness is not, because a false positive risks an incident. So:
 *   - each blocker is a BLOCKING fault for F8 — including a code this server does not know;
 *   - an empty list adds no fault and removes none: every other predicate still applies;
 *   - an empty list measured after a readiness refusal ends that refusal's hold early
 *     (`offerRefusal.refusalHoldFaults`), which only returns the agent to the gates it had.
 *
 * ── Absent is not ready ────────────────────────────────────────────────────
 * Where the owner's physical fleet declaration requires the report
 * (`readiness.policy: "AGENT_REPORT_REQUIRED"`), a missing, stale, or other-socket report is one
 * BLOCKING fault. Where it does not, a missing report adds nothing — exactly the behaviour before
 * this block existed, so a Pi that does not send it yet is not made unassignable by a backend
 * deploy. The requirement is turned on in the declaration, once the Pi sends the block.
 *
 * ── Recording ──────────────────────────────────────────────────────────────
 * As the stop latch (`stopLatchObservation.service`): stamped with the frame's agent timestamp,
 * bounded by the clock-skew rule, newest report first per socket, bound to the socket that sent
 * it, kept in its own key (`readiness:{robotId}`) that no other writer touches.
 */

const positionObservation = require("./positionObservation.service");
const { safeJsonParse } = require("../utils/json");

/** How long a recorded report stays readable; freshness is judged separately. @structural */
const READINESS_STATE_TTL_SEC = 3600;

/** @structural bounds on what an agent may put in the block */
const MAX_BLOCKERS = 16;
const MAX_BLOCKER_LENGTH = 64;

/** @param {string} robotId */
function readinessKey(robotId) {
  return `readiness:${robotId}`;
}

/**
 * The block, normalised, or null when it is absent or malformed. A malformed block is not
 * recorded, so it reads as not reported — never as ready.
 * @param {object} payload
 * @returns {{ blockers: string[] }|null}
 */
function parseReadiness(payload) {
  const block = payload && payload.readiness;
  if (!block || typeof block !== "object" || Array.isArray(block)) return null;
  if (!Array.isArray(block.blockers) || block.blockers.length > MAX_BLOCKERS) return null;
  const blockers = [];
  for (const entry of block.blockers) {
    if (typeof entry !== "string") return null;
    const code = entry.trim();
    if (code === "" || code.length > MAX_BLOCKER_LENGTH) return null;
    if (!blockers.includes(code)) blockers.push(code);
  }
  return { blockers };
}

/**
 * Record one frame's readiness report.
 *
 * @param {{ kv: object, robotId: string, payload: object, snapshot?: object, nowMs?: number, socket: object }} input
 * @returns {Promise<{ recorded: boolean, reason: string|null, blockers?: string[] }>}
 */
async function recordReadiness(input) {
  const { kv, robotId, payload, snapshot, socket } = input || {};
  const parsed = parseReadiness(payload);
  if (!parsed) return { recorded: false, reason: payload && payload.readiness !== undefined ? "MALFORMED_READINESS" : "NO_READINESS_REPORT" };

  const observedAtMs = positionObservation.agentTimestampFrom(payload);
  if (typeof observedAtMs !== "number" || !Number.isFinite(observedAtMs) || observedAtMs <= 0) {
    return { recorded: false, reason: "NO_AGENT_TIMESTAMP" };
  }
  const nowMs = input && Number.isFinite(input.nowMs) ? input.nowMs : Date.now();
  const skewMs = positionObservation.maxClockSkewMsFrom(snapshot || null);
  if (!Number.isFinite(skewMs) || observedAtMs > nowMs + skewMs) return { recorded: false, reason: "CLOCK_AHEAD" };

  if (!socket || typeof socket.id !== "string" || socket.id === "" || !socket.data) return { recorded: false, reason: "NO_SOCKET" };

  // Newest report first, by the agent's own timestamp; checked and claimed with no await between.
  const newest = socket.data.readinessNewestAtMs;
  if (Number.isFinite(newest) && observedAtMs < newest) return { recorded: false, reason: "OUT_OF_ORDER" };
  socket.data.readinessNewestAtMs = observedAtMs;

  if (kv) {
    await kv.set(readinessKey(robotId), JSON.stringify({ robotId, socketId: socket.id, blockers: parsed.blockers, observedAtMs }), {
      ex: READINESS_STATE_TTL_SEC,
    });
  }
  return { recorded: true, reason: null, blockers: parsed.blockers, observedAtMs, socketId: socket.id };
}

/**
 * The recorded report, or null.
 * @param {object} kv
 * @param {string} robotId
 * @returns {Promise<object|null>}
 */
async function readReadiness(kv, robotId) {
  if (!kv || !robotId) return null;
  const state = safeJsonParse(await kv.get(readinessKey(robotId)));
  return state && typeof state === "object" && state.robotId === robotId && Array.isArray(state.blockers) ? state : null;
}

/**
 * Does the recorded report count, as of a decision time?
 *
 * Current only when it came from the robot's current socket, was measured no later than `asOfMs`,
 * and is within the freshness budget (`connectivity.max_heartbeat_age`, as for every agent input).
 *
 * A stored value that is not a recorded report (wrong shape, or another robot's) reads as no
 * report at all.
 *
 * @param {{ state: object|null, robotId?: string, socketId?: string|null, asOfMs: number, freshnessBoundMs: number|null }} input
 * @returns {{ reported: boolean, current: boolean, ready: boolean|null, blockers: string[], observedAtMs: number|null, ageMs: number|null, reason: string|null }}
 */
function assessReadiness(input) {
  const { socketId, asOfMs, freshnessBoundMs, robotId } = input || {};
  const raw = input && input.state;
  const state =
    raw && typeof raw === "object" && Array.isArray(raw.blockers) && raw.blockers.every((code) => typeof code === "string") &&
    typeof raw.robotId === "string" && (robotId === undefined || raw.robotId === robotId)
      ? raw
      : null;
  if (!state) return { reported: false, current: false, ready: null, blockers: [], observedAtMs: null, ageMs: null, reason: "no readiness report on record" };
  const observedAtMs = Number(state.observedAtMs);
  const ageMs = Number.isFinite(observedAtMs) && Number.isFinite(asOfMs) ? asOfMs - observedAtMs : null;
  const base = { reported: true, blockers: [...state.blockers], observedAtMs: Number.isFinite(observedAtMs) ? observedAtMs : null, ageMs };
  let reason = null;
  if (!socketId || state.socketId !== socketId) reason = "the report did not come from the robot's current connection";
  else if (ageMs === null || ageMs < 0) reason = "the report postdates the decision time";
  else if (!(Number.isFinite(freshnessBoundMs) && ageMs <= freshnessBoundMs)) reason = `the report is ${Math.round(ageMs / 1000)} s old`;
  if (reason) return { ...base, current: false, ready: null, reason };
  return { ...base, current: true, ready: state.blockers.length === 0, reason: null };
}

/**
 * F8 faults from the report: one BLOCKING fault per blocker when it is current; when it is not and
 * the declaration requires it, one BLOCKING fault saying so; otherwise none.
 *
 * @param {object} assessment from `assessReadiness`
 * @param {{ required: boolean }} options
 * @returns {object[]}
 */
function readinessFaults(assessment, options) {
  const required = Boolean(options && options.required);
  if (assessment && assessment.current) {
    return assessment.blockers.map((code) => ({
      code: `AGENT_NOT_READY:${code}`,
      severity: "BLOCKING",
      active: true,
      component: "READINESS",
      provenance: "AGENT_REPORT",
    }));
  }
  if (!required) return [];
  return [
    {
      code: "READINESS_NOT_REPORTED",
      severity: "BLOCKING",
      active: true,
      component: "READINESS",
      provenance: "PHYSICAL",
      detail: (assessment && assessment.reason) || "no readiness report on record",
    },
  ];
}

/**
 * The `readiness` object a client reads. `ready` is the agent's own statement and is only ever
 * `true` for a current report with no blockers — and even then it is one input among the
 * engine's predicates, never a dispatch verdict.
 *
 * @param {object} assessment from `assessReadiness`
 * @param {{ required?: boolean|null }} [options] `required`: the declaration's policy, when known
 * @returns {object}
 */
function describeReadiness(assessment, options) {
  const a = assessment || { reported: false, current: false, ready: null, blockers: [], observedAtMs: null, ageMs: null, reason: null };
  return {
    reported: a.reported,
    current: a.current,
    ready: a.current ? a.ready : null,
    blockers: [...a.blockers],
    observedAt: Number.isFinite(a.observedAtMs) ? new Date(a.observedAtMs).toISOString() : null,
    ageMs: Number.isFinite(a.ageMs) ? Math.max(0, a.ageMs) : null,
    required: options && typeof options.required === "boolean" ? options.required : null,
    reason: a.reason,
  };
}

module.exports = {
  READINESS_STATE_TTL_SEC,
  describeReadiness,
  readinessKey,
  parseReadiness,
  recordReadiness,
  readReadiness,
  assessReadiness,
  readinessFaults,
};
