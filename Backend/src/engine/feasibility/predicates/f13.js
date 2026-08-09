"use strict";

/**
 * **F13 — Live session exists and heartbeat is within
 * `connectivity.max_heartbeat_age`.** Class I. Indeterminate: `DENY`.
 *
 * > Availability MUST mean "commandable now," established from a live session, **not
 * > from a throttled database column that may lag reality by tens of seconds**.
 *
 * The emphasis is the audit's finding turned into a rule. The baseline reads
 * `Robot.isOnline`, a column written by a throttled flush, and treats it as liveness;
 * an agent that dropped its session ten seconds ago is still `isOnline = true` and
 * still receives missions. This predicate takes the session itself as its input and
 * the heartbeat age as its measure, so "commandable" is established from the thing
 * that would carry the command.
 *
 * ── F13 and F14 are not the same check ──────────────────────────────────────
 * F13 asks whether a session exists and is *recent*. F14 asks whether that session has
 * been *proven to carry traffic*. A socket can satisfy the first and fail the second —
 * that is the silently-dead-link case F14 exists for — so both are in the register and
 * both are in the volatile subset.
 *
 * On the volatile subset (§10.3.2 step 3): a session lost during the routing window is
 * exactly the window this re-check closes.
 *
 * Tier 0 (T0-01).
 */

const tv = require("../threeValued");

const REQUIRED = "a live session with a heartbeat within connectivity.max_heartbeat_age";

/**
 * @param {object} context `{ agentSnapshot, mission, plan, config, decisionTimeMs }`
 * @returns {object} a `threeValued` predicate result
 */
function evaluate(context) {
  const agent = (context && context.agentSnapshot) || null;
  const config = context && context.config;
  const decisionTimeMs = context && context.decisionTimeMs;

  if (!agent) return tv.absent("the agent snapshot", { required: REQUIRED });

  const maxAgeSeconds = tv.readParameter(config, "connectivity.max_heartbeat_age");
  if (!tv.isNumber(maxAgeSeconds)) {
    return tv.absent("connectivity.max_heartbeat_age", { required: REQUIRED, inputSource: "CONFIG" });
  }
  const maxAgeMs = tv.secondsToMs(maxAgeSeconds);

  if (!tv.isNumber(decisionTimeMs)) {
    return tv.indeterminate({
      required: REQUIRED,
      reason:
        "the round's pinned decision time is absent, so heartbeat age cannot be computed. A clock " +
        "read here instead would make the verdict non-replayable (T6, §9.6)",
    });
  }

  const session = agent.session;
  if (session === undefined) {
    return tv.absent("the agent's session state", { required: REQUIRED, inputSource: "SENSOR" });
  }

  if (session === null || session.live !== true) {
    return tv.violated({
      observed: { live: false },
      required: REQUIRED,
      inputSource: "SENSOR",
      reason:
        "no live session exists. Availability means commandable now, established from a live " +
        "session rather than from a database column that may lag reality (§7.5 F13)",
    });
  }

  const lastHeartbeatMs = tv.epochMs(session.lastHeartbeatAt);
  if (lastHeartbeatMs === null) {
    return tv.absent("the session's last heartbeat timestamp", {
      observed: { live: true },
      required: { maxHeartbeatAgeMs: maxAgeMs },
      inputSource: "SENSOR",
    });
  }

  const ageMs = decisionTimeMs - lastHeartbeatMs;

  if (ageMs < 0) {
    return tv.indeterminate({
      observed: { live: true, ageMs },
      required: { maxHeartbeatAgeMs: maxAgeMs },
      inputSource: "SENSOR",
      observationAgeMs: ageMs,
      reason: "the last heartbeat is stamped after the pinned decision time (clock skew, §10.6)",
    });
  }

  if (ageMs > maxAgeMs) {
    return tv.violated({
      observed: { live: true, ageMs },
      required: { maxHeartbeatAgeMs: maxAgeMs },
      inputSource: "SENSOR",
      observationAgeMs: ageMs,
      margin: maxAgeMs - ageMs,
      marginUnit: tv.MARGIN_UNIT.MILLISECONDS,
      reason: `the last heartbeat is ${ageMs} ms old, beyond the ${maxAgeMs} ms budget (§7.5 F13)`,
    });
  }

  return tv.satisfied({
    observed: { live: true, ageMs },
    required: { maxHeartbeatAgeMs: maxAgeMs },
    inputSource: "SENSOR",
    observationAgeMs: ageMs,
    margin: maxAgeMs - ageMs,
    marginUnit: tv.MARGIN_UNIT.MILLISECONDS,
  });
}

module.exports = { evaluate };
