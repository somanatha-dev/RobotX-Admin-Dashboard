"use strict";

/**
 * **F36 — Maintenance interval not exceeded before projected mission end.** Class P.
 * Indeterminate: `DENY`.
 *
 * > Prevents a service interval lapsing mid-mission.
 *
 * ── The same temporal shape as F6, against a different clock ────────────────
 * F6 checks certifications at mission end; F36 checks service intervals at mission
 * end. The difference is that maintenance intervals are measured on **more than one
 * scale**, and a mission consumes all of them at once:
 *
 *   - **calendar** — a service due date
 *   - **distance** — an odometer limit
 *   - **operating hours** — a run-hours limit
 *
 * A mission that leaves the due date comfortably clear can still push the odometer
 * past its limit, so all declared scales are checked and the **binding** one is
 * reported. Each scale's consumption by this mission comes from the plan's projection:
 * distance and duration are properties of the route and timeline, not of the agent.
 *
 * ── Class P, and the operational reason it is not class I ──────────────────
 * An overdue service is a policy withdrawal, not a physical impossibility — the agent
 * is mechanically capable of the mission and operations has decided it should not do
 * it. §7.2 therefore permits an authorised operator to override with a recorded reason
 * (§23.6), which is a real operational need: a service bay unexpectedly closed for a
 * day should not ground a fleet. The `DENY` on indeterminate stands regardless: an
 * unknown service state is not an override, and only a *recorded* waiver is.
 *
 * Tier 0 (T0-01).
 */

const tv = require("../threeValued");

/**
 * The three maintenance scales, each with the agent-side counter, its limit, and the
 * plan-side quantity this mission would consume.
 * @structural the enumerated maintenance interval scales
 */
const SCALES = Object.freeze([
  Object.freeze({ name: "calendar", consumedBy: null, unit: "ms" }),
  Object.freeze({ name: "distance", counter: "odometerM", limit: "serviceDueOdometerM", consumedBy: "distanceM", unit: "m" }),
  Object.freeze({ name: "hours", counter: "operatingSeconds", limit: "serviceDueOperatingSeconds", consumedBy: "durationSeconds", unit: "ms" }),
]);

const REQUIRED = "no maintenance interval exceeded at projected mission end";

/**
 * @param {object} context `{ agentSnapshot, mission, plan, config }`
 * @returns {object} a `threeValued` predicate result
 */
function evaluate(context) {
  const agent = (context && context.agentSnapshot) || null;
  const plan = (context && context.plan) || null;

  if (!agent) return tv.absent("the agent snapshot", { required: REQUIRED });
  if (!plan) return tv.absent("the candidate plan", { required: REQUIRED });

  const maintenance = agent.maintenance;
  if (maintenance === undefined) {
    return tv.absent("the agent's maintenance state", {
      required: REQUIRED,
      inputSource: "CONTROL_PLANE",
      reason: "an unknown service state is not an override; only a recorded waiver is (§23.6)",
    });
  }
  if (maintenance === null || typeof maintenance !== "object") {
    return tv.indeterminate({
      required: REQUIRED,
      inputSource: "CONTROL_PLANE",
      reason: "the agent's maintenance state is unreadable",
    });
  }

  const endMs = tv.epochMs(plan.projectedEndMs);
  if (endMs === null) {
    return tv.absent("the plan's projected mission end", { required: REQUIRED, inputSource: "PLAN" });
  }

  let tightest = null;

  // ── Calendar ──────────────────────────────────────────────────────────────
  const dueAtMs = tv.epochMs(maintenance.serviceDueAt);
  if (dueAtMs !== null) {
    const marginMs = dueAtMs - endMs;
    if (marginMs < 0) {
      return tv.violated({
        observed: { scale: "calendar", serviceDueAtMs: dueAtMs, projectedEndMs: endMs },
        required: REQUIRED,
        inputSource: "CONTROL_PLANE",
        margin: marginMs,
        marginUnit: tv.MARGIN_UNIT.MILLISECONDS,
        reason: "the calendar service interval lapses before projected mission end (§7.5 F36)",
      });
    }
    tightest = { margin: marginMs, unit: tv.MARGIN_UNIT.MILLISECONDS, scale: "calendar" };
  }

  // ── Distance and operating hours ──────────────────────────────────────────
  for (const scale of SCALES) {
    if (scale.consumedBy === null) continue;

    const limit = maintenance[scale.limit];
    if (!tv.isNumber(limit)) continue; // this scale is not declared for this agent

    const current = maintenance[scale.counter];
    if (!tv.isNumber(current)) {
      return tv.absent(`the agent's ${scale.name} counter (${scale.counter})`, {
        required: REQUIRED,
        inputSource: "CONTROL_PLANE",
      });
    }

    const consumed = plan[scale.consumedBy];
    if (!tv.isNumber(consumed)) {
      return tv.absent(`the plan's projected ${scale.name} (${scale.consumedBy})`, {
        observed: { scale: scale.name, current, limit },
        required: REQUIRED,
        inputSource: "PLAN",
      });
    }

    const atEnd = current + consumed;
    const margin = limit - atEnd;

    if (margin < 0) {
      return tv.violated({
        observed: { scale: scale.name, atEnd, current, consumed },
        required: { limit },
        inputSource: "PLAN",
        margin,
        marginUnit: scale.unit === "m" ? tv.MARGIN_UNIT.METRES : tv.MARGIN_UNIT.MILLISECONDS,
        reason:
          `the ${scale.name} service interval is exceeded before projected mission end: ${atEnd} ` +
          `against a limit of ${limit} (§7.5 F36)`,
      });
    }

    const unit = scale.unit === "m" ? tv.MARGIN_UNIT.METRES : tv.MARGIN_UNIT.MILLISECONDS;
    // Scales are only comparable within a unit; the tightest is tracked per unit and
    // the reported one is whichever scale is nearest its own limit in its own terms.
    if (tightest === null || (tightest.unit === unit && margin < tightest.margin)) {
      tightest = { margin, unit, scale: scale.name };
    }
  }

  if (tightest === null) {
    return tv.indeterminate({
      required: REQUIRED,
      inputSource: "CONTROL_PLANE",
      reason:
        "the agent declares no maintenance interval on any scale — calendar, distance, or operating " +
        "hours. An agent with no declared service schedule is not one that never needs service (§7.5 F36)",
    });
  }

  return tv.satisfied({
    observed: { bindingScale: tightest.scale },
    required: REQUIRED,
    inputSource: "CONTROL_PLANE",
    margin: tightest.margin,
    marginUnit: tightest.unit,
  });
}

module.exports = { evaluate, SCALES };
