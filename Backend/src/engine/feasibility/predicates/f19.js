"use strict";

/**
 * **F19 — Projected availability time ≤ mission's latest feasible start.** Class F.
 * Indeterminate: `DENY`.
 *
 * > Admits `FINISHING_SOON` agents while ensuring the wait is actually affordable.
 *
 * ── The predicate that makes chaining safe ──────────────────────────────────
 * Without F19 the engine has two equally bad options for an agent that is busy but
 * nearly done: exclude it, wasting the best candidate in the zone, or include it and
 * discover at execution time that the mission missed its window while the agent
 * finished something else. F19 is the middle path — include the agent, but price the
 * wait against the mission's own latest feasible start, and reject when the arithmetic
 * does not work.
 *
 * The `candidate.finishing_soon_horizon` parameter governs *candidate generation*
 * (Phase 9): how far ahead an agent may be projected free and still enter the
 * candidate set at all. This predicate is the gate's own check, and it is stricter —
 * generation may be generous because it is cheap, and F19 is what makes the generosity
 * safe.
 *
 * ── Both sides are projections, and both are pinned ─────────────────────────
 * `projectedAvailableAtMs` comes from the agent's current commitment and its
 * supervised ETA; `latestFeasibleStartMs` comes from the mission's time windows worked
 * backwards through the plan. Both are computed upstream and pinned in the round's
 * snapshot, so F19 compares two numbers and never re-derives either — a predicate that
 * recomputed an ETA would produce a different answer on replay than the plan it was
 * evaluated against (T6, §9.6).
 *
 * Tier 0 (T0-01).
 */

const tv = require("../threeValued");

const REQUIRED = "projected availability no later than the mission's latest feasible start";

/**
 * @param {object} context `{ agentSnapshot, mission, plan, config }`
 * @returns {object} a `threeValued` predicate result
 */
function evaluate(context) {
  const agent = (context && context.agentSnapshot) || null;
  const mission = (context && context.mission) || null;
  const plan = (context && context.plan) || null;

  if (!agent) return tv.absent("the agent snapshot", { required: REQUIRED });
  if (!mission) return tv.absent("the mission", { required: REQUIRED });

  const availableAtMs = tv.epochMs(agent.projectedAvailableAtMs);
  if (availableAtMs === null) {
    return tv.absent("the agent's projected availability time", {
      required: REQUIRED,
      inputSource: "PLAN",
      reason:
        "no projected availability time is pinned for this agent. An agent whose free time cannot " +
        "be projected cannot be shown to become free in time (§7.5 F19)",
    });
  }

  // The plan's own required start takes precedence when it states one — it is the
  // instant this specific plan needs the agent — and the mission's latest feasible
  // start is the fallback for a candidate evaluated without a full plan.
  const latestStartMs = tv.epochMs(
    plan && plan.latestFeasibleStartMs !== undefined && plan.latestFeasibleStartMs !== null
      ? plan.latestFeasibleStartMs
      : mission.latestFeasibleStartMs,
  );

  if (latestStartMs === null) {
    return tv.absent("the mission's latest feasible start", {
      observed: { projectedAvailableAtMs: availableAtMs },
      required: REQUIRED,
      inputSource: "PLAN",
    });
  }

  const marginMs = latestStartMs - availableAtMs;

  if (availableAtMs > latestStartMs) {
    return tv.violated({
      observed: { projectedAvailableAtMs: availableAtMs },
      required: { latestFeasibleStartMs: latestStartMs },
      inputSource: "PLAN",
      margin: marginMs,
      marginUnit: tv.MARGIN_UNIT.MILLISECONDS,
      reason:
        `the agent becomes free ${-marginMs} ms after the mission's latest feasible start. ` +
        "Admitting a finishing-soon agent requires the wait to be affordable, and this one is not (§7.5 F19)",
    });
  }

  return tv.satisfied({
    observed: { projectedAvailableAtMs: availableAtMs },
    required: { latestFeasibleStartMs: latestStartMs },
    inputSource: "PLAN",
    margin: marginMs,
    marginUnit: tv.MARGIN_UNIT.MILLISECONDS,
  });
}

module.exports = { evaluate };
