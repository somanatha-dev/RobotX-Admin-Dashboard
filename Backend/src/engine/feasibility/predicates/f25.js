"use strict";

/**
 * **F25 — Thermal class of an assigned compartment covers the payload's required
 * range for the projected duration.** Class C/R, governed as **R**. Indeterminate:
 * `DENY`.
 *
 * > Cold-chain integrity; **duration-dependent, so it is a mission-level not
 * > agent-level check**.
 *
 * ── The duration clause is what makes this a mission-level predicate ────────
 * A passively insulated compartment holds its temperature for a bounded time and then
 * does not. Whether an agent can carry a cold-chain payload is therefore not a property
 * of the agent at all: the same compartment is adequate for a twenty-minute run and
 * inadequate for a two-hour one. This is why F25 cannot be answered from the
 * capability bundle alone, and why the predicate reads the plan's projected duration.
 *
 * Two cases, and only the second is time-bounded:
 *
 *   - **Actively cooled** (`activeThermal: true`) — holds its class for as long as it
 *     has power. Duration does not bind; the thermal class must simply cover the
 *     required range.
 *   - **Passively insulated** — holds for `thermalHoldSeconds`, after which the
 *     payload's own `thermalMaxExcursionSeconds` is being consumed. The mission is
 *     feasible only while the projected duration stays inside the sum.
 *
 * ── Governed as class R ─────────────────────────────────────────────────────
 * §7.5 gives F25 two classes, `C/R`. The register governs it as **R**, the stricter:
 * cold-chain breach for pharmaceuticals is a regulatory matter, not merely a
 * contractual one, and recording the looser half would make §7.3's mandatory `DENY`
 * evadable. `declaredClass` preserves the specification's own string.
 *
 * Tier 0 (T0-01, T0-04).
 */

const tv = require("../threeValued");

const REQUIRED = "an assigned compartment whose thermal class covers the payload range for the projected duration";

/**
 * @param {object} context `{ agentSnapshot, mission, plan, config }`
 * @returns {object} a `threeValued` predicate result
 */
function evaluate(context) {
  const mission = (context && context.mission) || null;
  const plan = (context && context.plan) || null;

  if (!mission) return tv.absent("the mission", { required: REQUIRED });

  const payload = mission.payload;
  if (payload === undefined) {
    return tv.absent("the mission's payload specification", { required: REQUIRED, inputSource: "CONTROL_PLANE" });
  }

  // A payload with no thermal requirement is not a thermal mission, and this predicate
  // is vacuously satisfied. `null` for both bounds is the explicit "no requirement"
  // shape; a payload spec absent altogether was handled above.
  const needsMinC = payload && tv.isNumber(payload.thermalMinC) ? payload.thermalMinC : null;
  const needsMaxC = payload && tv.isNumber(payload.thermalMaxC) ? payload.thermalMaxC : null;

  if (needsMinC === null && needsMaxC === null) {
    return tv.satisfied({
      observed: { thermalRequirement: null },
      required: REQUIRED,
      inputSource: "CONTROL_PLANE",
      reason: "the payload declares no thermal range; F25 does not bind",
    });
  }

  if (!plan) return tv.absent("the candidate plan", { required: REQUIRED });

  const assignment = plan.packing && plan.packing.thermalAssignment;
  if (assignment === undefined) {
    return tv.absent("the plan's compartment thermal assignment (§15.2)", {
      required: REQUIRED,
      inputSource: "PLAN",
      reason:
        "no compartment assignment is attached to this plan, so no compartment's thermal class can " +
        "be checked. Compartment assignment is engine/payload/packing.js (Phase 7)",
    });
  }
  if (assignment === null || typeof assignment !== "object") {
    return tv.indeterminate({
      required: REQUIRED,
      inputSource: "PLAN",
      reason: "the compartment thermal assignment is unreadable",
    });
  }

  const holdsMinC = assignment.thermalMinC;
  const holdsMaxC = assignment.thermalMaxC;

  if (!tv.isNumber(holdsMinC) || !tv.isNumber(holdsMaxC)) {
    return tv.absent("the assigned compartment's thermal class bounds", {
      observed: { compartmentId: assignment.compartmentId === undefined ? null : assignment.compartmentId },
      required: { thermalMinC: needsMinC, thermalMaxC: needsMaxC },
      inputSource: "CONTROL_PLANE",
    });
  }

  // ── The range must cover ──────────────────────────────────────────────────
  const lowMargin = needsMinC === null ? null : needsMinC - holdsMinC;
  const highMargin = needsMaxC === null ? null : holdsMaxC - needsMaxC;
  const rangeMargins = [lowMargin, highMargin].filter((value) => value !== null);
  const tightestRangeMargin = rangeMargins.length === 0 ? null : Math.min(...rangeMargins);

  if (tightestRangeMargin !== null && tightestRangeMargin < 0) {
    return tv.violated({
      observed: { compartmentThermalMinC: holdsMinC, compartmentThermalMaxC: holdsMaxC },
      required: { thermalMinC: needsMinC, thermalMaxC: needsMaxC },
      inputSource: "PLAN",
      margin: tightestRangeMargin,
      marginUnit: tv.MARGIN_UNIT.DEGREES_CELSIUS,
      reason:
        `the assigned compartment holds ${holdsMinC}..${holdsMaxC} degC, which does not cover the ` +
        `payload's required ${needsMinC}..${needsMaxC} degC (§7.5 F25)`,
    });
  }

  // ── The duration clause ───────────────────────────────────────────────────
  if (assignment.activeThermal === true) {
    return tv.satisfied({
      observed: { compartmentThermalMinC: holdsMinC, compartmentThermalMaxC: holdsMaxC, activeThermal: true },
      required: { thermalMinC: needsMinC, thermalMaxC: needsMaxC },
      inputSource: "PLAN",
      margin: tightestRangeMargin,
      marginUnit: tv.MARGIN_UNIT.DEGREES_CELSIUS,
    });
  }

  const holdSeconds = assignment.thermalHoldSeconds;
  if (!tv.isNumber(holdSeconds)) {
    return tv.absent("the passively insulated compartment's thermal hold time", {
      observed: { compartmentThermalMinC: holdsMinC, compartmentThermalMaxC: holdsMaxC, activeThermal: false },
      required: REQUIRED,
      inputSource: "CONTROL_PLANE",
      reason:
        "a passively insulated compartment holds its class for a bounded time and then does not. " +
        "An unstated hold time is not an unbounded one (§7.5 F25)",
    });
  }

  const startMs = tv.epochMs(plan.projectedStartMs);
  const endMs = tv.epochMs(plan.projectedEndMs);
  if (startMs === null || endMs === null) {
    return tv.absent("the plan's projected duration", {
      required: REQUIRED,
      inputSource: "PLAN",
      reason: "F25 is duration-dependent, which is what makes it a mission-level rather than agent-level check",
    });
  }

  const excursionSeconds = tv.isNumber(payload.thermalMaxExcursionSeconds) ? payload.thermalMaxExcursionSeconds : 0;
  const budgetMs = tv.secondsToMs(holdSeconds + excursionSeconds);
  const durationMs = endMs - startMs;
  const durationMarginMs = budgetMs - durationMs;

  if (durationMs > budgetMs) {
    return tv.violated({
      observed: { durationMs, thermalHoldSeconds: holdSeconds, thermalMaxExcursionSeconds: excursionSeconds },
      required: { maxDurationMs: budgetMs },
      inputSource: "PLAN",
      margin: durationMarginMs,
      marginUnit: tv.MARGIN_UNIT.MILLISECONDS,
      reason:
        `the projected duration ${durationMs} ms exceeds the compartment's ${budgetMs} ms passive ` +
        "hold plus permitted excursion. Cold-chain integrity is duration-dependent (§7.5 F25)",
    });
  }

  return tv.satisfied({
    observed: {
      compartmentThermalMinC: holdsMinC,
      compartmentThermalMaxC: holdsMaxC,
      activeThermal: false,
      durationMs,
    },
    required: { thermalMinC: needsMinC, thermalMaxC: needsMaxC, maxDurationMs: budgetMs },
    inputSource: "PLAN",
    margin: durationMarginMs,
    marginUnit: tv.MARGIN_UNIT.MILLISECONDS,
  });
}

module.exports = { evaluate };
