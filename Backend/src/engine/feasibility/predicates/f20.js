"use strict";

/**
 * **F20 — Not excluded for this Leg by cooloff, incumbent penalty, or NACK cooloff.**
 * Class P. Indeterminate: `DENY`.
 *
 * > Prevents reassignment ping-pong and repeated offers to a refusing agent.
 *
 * ── Three exclusions, all keyed on the (agent, Leg) pair ────────────────────
 * The pairing is the point: none of these excludes an agent from *work*, only from
 * **this Leg**. An agent that just NACKed Leg A is a perfectly good candidate for
 * Leg B, and an exclusion keyed on the agent alone would idle it.
 *
 *   1. **Reassignment cooloff** (`recover.incumbent_cooloff`) — the Leg was taken away
 *      from this agent recently. Re-offering it immediately is the ping-pong §4.7
 *      names: two agents trading a Leg while the solver's estimate oscillates around
 *      the churn cost.
 *   2. **Incumbent penalty** — the agent is the *current* incumbent of a Leg being
 *      re-planned. This is not a bar in itself; it becomes one when
 *      `recover.max_reassignments_per_leg` has been exhausted, because a Leg that has
 *      already been moved that many times must stop moving.
 *   3. **NACK cooloff** (`dispatch.nack_cooloff`) — the agent refused this Leg. §11.2
 *      makes refusal a first-class outcome rather than an error, and this is the
 *      cooloff that stops the dispatcher immediately re-offering what was just refused.
 *
 * ── Class P with `DENY` on indeterminate ────────────────────────────────────
 * These are operational-intent rules, so §7.2 permits an authorised operator to
 * override them with a recorded reason. The predicate still denies on unknown: an
 * exclusion set that could not be read is not an empty one, and reading it as empty
 * would restore exactly the ping-pong the mechanism exists to damp.
 *
 * On the volatile subset (§10.3.2 step 3): a NACK arriving during the routing window
 * must exclude the agent before the commit lands, or the dispatcher re-offers a Leg
 * the agent has already refused.
 *
 * Tier 0 (T0-01).
 */

const tv = require("../threeValued");

const REQUIRED = "no cooloff, exhausted reassignment budget, or NACK cooloff excluding this pairing";

/**
 * Is `untilMs` still in the future at the pinned decision time?
 *
 * @param {number|null} untilMs
 * @param {number} decisionTimeMs
 * @returns {boolean}
 */
function stillActive(untilMs, decisionTimeMs) {
  return untilMs !== null && untilMs > decisionTimeMs;
}

/**
 * @param {object} context `{ agentSnapshot, mission, plan, config, decisionTimeMs }`
 * @returns {object} a `threeValued` predicate result
 */
function evaluate(context) {
  const agent = (context && context.agentSnapshot) || null;
  const mission = (context && context.mission) || null;
  const config = context && context.config;
  const decisionTimeMs = context && context.decisionTimeMs;

  if (!agent) return tv.absent("the agent snapshot", { required: REQUIRED });

  if (!tv.isNumber(decisionTimeMs)) {
    return tv.indeterminate({
      required: REQUIRED,
      reason: "the round's pinned decision time is absent; cooloff expiry cannot be evaluated (T6, §9.6)",
    });
  }

  const exclusions = agent.legExclusions;
  if (exclusions === undefined) {
    return tv.absent("the per-Leg exclusion set", {
      required: REQUIRED,
      inputSource: "PLAN",
      reason:
        "no exclusion set was supplied for this pairing. An unread exclusion set is not an empty " +
        "one, and reading it as empty restores the reassignment ping-pong F20 exists to damp",
    });
  }
  if (exclusions === null || typeof exclusions !== "object") {
    return tv.indeterminate({
      required: REQUIRED,
      inputSource: "PLAN",
      reason: "the per-Leg exclusion set is unreadable; exclusions cannot be established",
    });
  }

  const legId = mission && mission.legId;

  // ── 1. Reassignment cooloff ───────────────────────────────────────────────
  const cooloffUntilMs = tv.epochMs(exclusions.cooloffUntil);
  if (stillActive(cooloffUntilMs, decisionTimeMs)) {
    return tv.violated({
      observed: { legId: legId === undefined ? null : legId, cooloffUntilMs },
      required: REQUIRED,
      inputSource: "PLAN",
      margin: cooloffUntilMs - decisionTimeMs,
      marginUnit: tv.MARGIN_UNIT.MILLISECONDS,
      reason:
        "a reassignment cooloff (recover.incumbent_cooloff) is still in force for this pairing. " +
        "Re-offering now is the ping-pong §4.7 names (§7.5 F20)",
    });
  }

  // ── 2. NACK cooloff ───────────────────────────────────────────────────────
  const nackUntilMs = tv.epochMs(exclusions.nackCooloffUntil);
  if (stillActive(nackUntilMs, decisionTimeMs)) {
    return tv.violated({
      observed: { legId: legId === undefined ? null : legId, nackCooloffUntilMs: nackUntilMs },
      required: REQUIRED,
      inputSource: "PLAN",
      margin: nackUntilMs - decisionTimeMs,
      marginUnit: tv.MARGIN_UNIT.MILLISECONDS,
      reason:
        "the agent refused this Leg and dispatch.nack_cooloff has not elapsed. Refusal is a " +
        "first-class outcome (§11.2), and this is what stops it being immediately re-offered (§7.5 F20)",
    });
  }

  // ── 3. Incumbent penalty against the reassignment budget ──────────────────
  if (exclusions.isIncumbent === true) {
    const maxReassignments = tv.readParameter(config, "recover.max_reassignments_per_leg");
    const soFar = exclusions.reassignmentsSoFar;

    if (!tv.isNumber(maxReassignments)) {
      return tv.absent("recover.max_reassignments_per_leg", {
        observed: { isIncumbent: true },
        required: REQUIRED,
        inputSource: "CONFIG",
      });
    }
    if (!tv.isNumber(soFar)) {
      return tv.absent("the Leg's reassignment count", {
        observed: { isIncumbent: true },
        required: { maxReassignments },
        inputSource: "PLAN",
      });
    }

    if (soFar >= maxReassignments) {
      return tv.violated({
        observed: { isIncumbent: true, reassignmentsSoFar: soFar },
        required: { maxReassignments },
        inputSource: "PLAN",
        margin: maxReassignments - soFar,
        marginUnit: tv.MARGIN_UNIT.COUNT,
        reason:
          `this Leg has been reassigned ${soFar} times against a budget of ${maxReassignments}. ` +
          "A Leg that has already moved that many times must stop moving (§7.5 F20, §4.7)",
      });
    }
  }

  return tv.satisfied({
    observed: {
      legId: legId === undefined ? null : legId,
      isIncumbent: exclusions.isIncumbent === true,
      cooloffUntilMs,
      nackCooloffUntilMs: nackUntilMs,
    },
    required: REQUIRED,
    inputSource: "PLAN",
  });
}

module.exports = { evaluate, stillActive };
