"use strict";

/**
 * **F30 — Time-of-day, day-of-week, and event restrictions satisfied for the projected
 * traversal window.** Class R. Indeterminate: `DENY`.
 *
 * > Curfews and event closures apply **at traversal time, not decision time**.
 *
 * ── The same temporal error as F6, in a different dimension ────────────────
 * F6 catches a certificate that is valid now and expired at mission end. F30 catches a
 * zone that is open now and closed when the agent gets there. Both are the general
 * failure of evaluating a time-varying constraint at the wrong instant, and both are
 * unrepresentable in a model that has only "now".
 *
 * The predicate works from `plan.route.zoneTraversals` — per zone, the window
 * `[enterMs, exitMs)` the plan projects — and tests each zone's restrictions against
 * *that* window rather than against the decision time or the mission as a whole. A
 * mission spanning a curfew boundary is feasible or not depending on which side of it
 * each zone is entered, and a whole-mission test cannot express that.
 *
 * ── Restrictions are supplied resolved, and are closed-unless-open ──────────
 * Each traversal carries the restrictions in force for its zone. A traversal whose
 * restriction set is absent is `INDETERMINATE`: class R is never overridable
 * operationally, and an unread curfew is not an absent one.
 *
 * A restriction states a closure window and the traversal must not intersect it. The
 * intersection test is half-open on both sides for the reason F18 gives: a plan
 * exiting a zone exactly as its curfew begins has not violated the curfew.
 *
 * Tier 0 (T0-01).
 */

const tv = require("../threeValued");

const REQUIRED = "no time-of-day, day-of-week, or event restriction intersecting the projected traversal window";

/**
 * Do the half-open intervals `[aFrom, aUntil)` and `[bFrom, bUntil)` intersect?
 *
 * @param {number} aFrom
 * @param {number} aUntil
 * @param {number} bFrom
 * @param {number} bUntil
 * @returns {boolean}
 */
function intersects(aFrom, aUntil, bFrom, bUntil) {
  return aFrom < bUntil && bFrom < aUntil;
}

/**
 * @param {object} context `{ agentSnapshot, mission, plan, config }`
 * @returns {object} a `threeValued` predicate result
 */
function evaluate(context) {
  const plan = (context && context.plan) || null;
  if (!plan) return tv.absent("the candidate plan", { required: REQUIRED });

  const traversals = plan.route && plan.route.zoneTraversals;
  if (traversals === undefined) {
    return tv.absent("the route's per-zone traversal windows", {
      required: REQUIRED,
      inputSource: "ROUTING",
      reason:
        "the plan projects no per-zone traversal windows. Curfews apply at traversal time, and a " +
        "whole-mission test cannot express which side of a boundary each zone is entered on (§7.5 F30)",
    });
  }
  if (traversals === null || !Array.isArray(traversals)) {
    return tv.indeterminate({
      required: REQUIRED,
      inputSource: "ROUTING",
      reason: "the route's traversal windows are unreadable",
    });
  }

  let tightestClearanceMs = null;

  for (const traversal of traversals) {
    const zoneId = traversal && traversal.zoneId;
    const enterMs = tv.epochMs(traversal && traversal.enterMs);
    const exitMs = tv.epochMs(traversal && traversal.exitMs);

    if (enterMs === null || exitMs === null) {
      return tv.indeterminate({
        observed: { zoneId: zoneId === undefined ? null : zoneId },
        required: REQUIRED,
        inputSource: "ROUTING",
        reason: `the traversal of zone "${String(zoneId)}" states no readable entry or exit time`,
      });
    }

    const restrictions = traversal.restrictions;
    if (restrictions === undefined) {
      return tv.absent(`the restriction set for zone "${String(zoneId)}"`, {
        required: REQUIRED,
        inputSource: "CONTROL_PLANE",
        reason: "an unread curfew is not an absent one; class R is never overridable operationally (§7.2)",
      });
    }
    if (restrictions === null || !Array.isArray(restrictions)) {
      return tv.indeterminate({
        observed: { zoneId: zoneId === undefined ? null : zoneId },
        required: REQUIRED,
        inputSource: "CONTROL_PLANE",
        reason: `the restriction set for zone "${String(zoneId)}" is unreadable`,
      });
    }

    for (const restriction of restrictions) {
      const closedFromMs = tv.epochMs(restriction && restriction.closedFromMs);
      const closedUntilMs = tv.epochMs(restriction && restriction.closedUntilMs);

      if (closedFromMs === null || closedUntilMs === null) {
        return tv.indeterminate({
          observed: { zoneId: zoneId === undefined ? null : zoneId, kind: restriction ? restriction.kind : null },
          required: REQUIRED,
          inputSource: "CONTROL_PLANE",
          reason: `a restriction on zone "${String(zoneId)}" states an unreadable closure window`,
        });
      }

      if (intersects(enterMs, exitMs, closedFromMs, closedUntilMs)) {
        return tv.violated({
          observed: {
            zoneId: zoneId === undefined ? null : zoneId,
            kind: restriction.kind === undefined ? null : restriction.kind,
            enterMs,
            exitMs,
          },
          required: { closedFromMs, closedUntilMs },
          inputSource: "CONTROL_PLANE",
          reason:
            `the projected traversal of zone "${String(zoneId)}" intersects a ` +
            `${String(restriction.kind)} closure. Restrictions apply at traversal time, not decision ` +
            "time (§7.5 F30)",
        });
      }

      const clearanceMs = closedFromMs >= exitMs ? closedFromMs - exitMs : enterMs - closedUntilMs;
      if (tightestClearanceMs === null || clearanceMs < tightestClearanceMs) tightestClearanceMs = clearanceMs;
    }
  }

  return tv.satisfied({
    observed: { traversalsChecked: traversals.length, tightestClearanceMs },
    required: REQUIRED,
    inputSource: "CONTROL_PLANE",
    margin: tightestClearanceMs,
    marginUnit: tv.MARGIN_UNIT.MILLISECONDS,
  });
}

module.exports = { evaluate, intersects };
