"use strict";

/**
 * What an `OFFER_REJECT` reason means for the next offer, and the agent-level hold a
 * readiness refusal places.
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 * Every refusal was handled the same way: the Leg back to QUEUED and the agent excluded from
 * **that Leg** for `dispatch.nack_cooloff` (F20). That is right for a refusal about the Leg
 * ("this stop has no executable path") and wrong for a refusal about the agent ("my ESP32 link
 * is down"): the agent is just as unable to take every other Leg, and it was offered the next
 * one in the following round, and every other one after it, each refused for the same reason.
 *
 * ── Classification ──────────────────────────────────────────────────────────
 * The physical agent's own refusal vocabulary (RobotX-Pi `RobotAgent.assess_offer`, checked
 * in that order before any Leg-specific judgement):
 *
 *   AGENT_READINESS  ESTOP_LATCHED · AGENT_ERROR · NO_MOTOR_LINK · NO_POSITION_FIX ·
 *                    NO_CUSTODY_SENSING — the agent cannot execute any mission right now
 *   LEG              NO_EXECUTABLE_PATH — this offer's stops carry no executable path
 *   UNCLASSIFIED     anything else, including every reason the reference simulator sends
 *                    (`AGENT_HELD:…`, `BELOW_E_FLOOR:…`) — handled exactly as before
 *
 * The code is the part before the first `:`, so `NO_EXECUTABLE_PATH:noStops` is a LEG refusal.
 *
 * ── The hold ────────────────────────────────────────────────────────────────
 * A readiness refusal is recorded (as before) as an `offer_rejection` Observation, now with its
 * `code` and `scope`. For `dispatch.nack_cooloff` after it, the agent carries a BLOCKING fault
 * (F8) — across every Leg, not only the refused one. It is bounded: it ends when the window
 * expires, or earlier when the agent's own readiness report, measured after the refusal, says it
 * is ready (`agentReadiness.service`). It is never permanent, and it only ever restricts.
 */

const positionObservation = require("./positionObservation.service");

/** @structural the Observation kind `offers.applyReject` records */
const REFUSAL_KIND = "offer_rejection";

/** @structural the agent's refusal codes that mean "not able to execute any mission now" */
const AGENT_READINESS_REFUSALS = Object.freeze(["ESTOP_LATCHED", "AGENT_ERROR", "NO_MOTOR_LINK", "NO_POSITION_FIX", "NO_CUSTODY_SENSING"]);

/** @structural the agent's refusal codes about this offer only */
const LEG_REFUSALS = Object.freeze(["NO_EXECUTABLE_PATH"]);

/** @structural the three scopes */
const SCOPE = Object.freeze({
  AGENT_READINESS: "AGENT_READINESS",
  LEG: "LEG",
  UNCLASSIFIED: "UNCLASSIFIED",
});

/** The hold's length. @structural a parameter name (the existing refusal cool-off) */
const HOLD_PARAMETER = "dispatch.nack_cooloff";

/** @structural bounds on a reason string carried to logs, rows and the dashboard */
const MAX_REASON_LENGTH = 200;

/**
 * @param {unknown} reason the agent's `OFFER_REJECT.reason`
 * @returns {{ reason: string|null, code: string|null, scope: string }}
 */
function classifyRefusal(reason) {
  const text = typeof reason === "string" ? reason.trim().slice(0, MAX_REASON_LENGTH) : "";
  if (text === "") return { reason: null, code: null, scope: SCOPE.UNCLASSIFIED };
  const code = text.split(":")[0].trim();
  if (AGENT_READINESS_REFUSALS.includes(code)) return { reason: text, code, scope: SCOPE.AGENT_READINESS };
  if (LEG_REFUSALS.includes(code)) return { reason: text, code, scope: SCOPE.LEG };
  return { reason: text, code, scope: SCOPE.UNCLASSIFIED };
}

/**
 * The hold's length in milliseconds, from the caller's config reader, else the register.
 * @param {((name: string) => unknown)|object|null} config a `(name) => value` reader or a snapshot
 * @returns {number|null}
 */
function holdMsFrom(config) {
  let seconds;
  if (typeof config === "function") {
    try {
      seconds = config(HOLD_PARAMETER);
    } catch {
      seconds = undefined;
    }
  }
  if (!(typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0)) {
    seconds = positionObservation.resolvedPositiveParameter(typeof config === "function" ? null : config || null, HOLD_PARAMETER);
  }
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

/**
 * The newest readiness refusal inside the hold window ending at `asOfMs`, or null.
 * @param {object} prisma
 * @param {string} agentRowId
 * @param {number} asOfMs
 * @param {number} holdMs
 * @returns {Promise<{ code: string, reason: string|null, observedAtMs: number }|null>}
 */
async function latestReadinessRefusal(prisma, agentRowId, asOfMs, holdMs) {
  if (!prisma || !prisma.observation || !agentRowId) return null;
  const row = await prisma.observation.findFirst({
    where: {
      agentId: agentRowId,
      kind: REFUSAL_KIND,
      observedAt: { gte: new Date(asOfMs - holdMs), lte: new Date(asOfMs) },
      value: { path: ["scope"], equals: SCOPE.AGENT_READINESS },
    },
    orderBy: { observedAt: "desc" },
    select: { value: true, observedAt: true },
  });
  if (!row || !row.value) return null;
  const classified = classifyRefusal(row.value.reason);
  if (classified.scope !== SCOPE.AGENT_READINESS) return null;
  const observedAtMs = new Date(row.observedAt).getTime();
  return Number.isFinite(observedAtMs) ? { code: classified.code, reason: classified.reason, observedAtMs } : null;
}

/**
 * The hold, as F8 faults: one BLOCKING fault while the newest readiness refusal is inside its
 * window and no later readiness report has cleared it; otherwise none.
 *
 * @param {{ refusal: object|null, holdMs: number|null, readiness?: object|null }} input
 *   `readiness`: `agentReadiness.assessReadiness` for the same agent and decision time
 * @returns {object[]}
 */
function refusalHoldFaults(input) {
  const { refusal, holdMs, readiness } = input || {};
  if (!refusal || !(typeof holdMs === "number" && holdMs > 0)) return [];
  const clearedByReport =
    Boolean(readiness) && readiness.current === true && readiness.ready === true && readiness.observedAtMs > refusal.observedAtMs;
  if (clearedByReport) return [];
  return [
    {
      code: `OFFER_REFUSED_NOT_READY:${refusal.code}`,
      severity: "BLOCKING",
      active: true,
      component: "READINESS",
      provenance: "AGENT_REPORT",
      since: new Date(refusal.observedAtMs).toISOString(),
      until: new Date(refusal.observedAtMs + holdMs).toISOString(),
      detail: `the agent refused an offer with ${refusal.reason || refusal.code}; it is not offered other work until it reports ready or the hold ends`,
    },
  ];
}

module.exports = {
  REFUSAL_KIND,
  AGENT_READINESS_REFUSALS,
  LEG_REFUSALS,
  SCOPE,
  HOLD_PARAMETER,
  classifyRefusal,
  holdMsFrom,
  latestReadinessRefusal,
  refusalHoldFaults,
};
