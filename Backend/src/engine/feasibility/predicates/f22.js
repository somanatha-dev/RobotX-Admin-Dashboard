"use strict";

/**
 * **F22 — Total payload mass ≤ rated capacity × `payload.safety_factor` at every
 * point in the plan.** Class I. Indeterminate: `DENY`.
 *
 * > Overload affects braking, stability, and structural limits; **must hold per stop**,
 * > since load changes along a multi-stop plan (§15.4).
 *
 * ── "At every point", not "at the worst stop somebody remembered" ───────────
 * A consolidated plan picks up two parcels before dropping either, so its peak load is
 * at neither endpoint. Checking origin and destination — the only two points a
 * point-to-point model has — misses the peak entirely. This predicate therefore
 * iterates the whole load-state sequence and denies on the first stop that exceeds the
 * limit, reporting *which* stop, because "this plan overloads the agent" is
 * unactionable and "it overloads at stop 3 of 5 by 2.4 kg" is a re-sequencing.
 *
 * ── Mass is taken at the upper bound of its tolerance ───────────────────────
 * §15.1: "Mass is specified with a **tolerance**, because declared masses are
 * frequently wrong: **feasibility uses the upper bound of the tolerance** and energy
 * estimation uses the expectation." The load state supplies `massUpperBoundKg` for
 * exactly this reason. A load state offering only an expectation is `INDETERMINATE`,
 * not silently treated as the bound — using the expectation here would defeat the
 * distinction §15.1 draws.
 *
 * ── The load state is Phase 7's; the comparison is this predicate's ─────────
 * §15.4's *"Load state along the plan"* is `engine/payload/loadState.js`, which Phase 7
 * owns. This module consumes its output and never accumulates payload deltas itself —
 * doing so would be a second load model, and §14.6's argument about two sides
 * reasoning from identical inputs applies with equal force to two modules inside one
 * server. Until Phase 7 lands, `plan.loadState` is absent and this predicate returns
 * `INDETERMINATE`, which under class I denies. That is the specified conservative
 * behaviour, not a gap: an unestablished load state is not a safe one.
 *
 * Tier 0 (T0-01, T0-04).
 */

const tv = require("../threeValued");

const REQUIRED = "payload mass within rated capacity x payload.safety_factor at every stop";

/**
 * @param {object} context `{ agentSnapshot, mission, plan, config }`
 * @returns {object} a `threeValued` predicate result
 */
function evaluate(context) {
  const agent = (context && context.agentSnapshot) || null;
  const plan = (context && context.plan) || null;
  const config = context && context.config;

  if (!agent) return tv.absent("the agent snapshot", { required: REQUIRED });
  if (!plan) return tv.absent("the candidate plan", { required: REQUIRED });

  const ratedKg = agent.containerModel && agent.containerModel.totalMassLimitKg;
  if (!tv.isNumber(ratedKg)) {
    return tv.absent("the agent's rated total mass limit", {
      required: REQUIRED,
      inputSource: "CONTROL_PLANE",
    });
  }

  const safetyFactor = tv.readParameter(config, "payload.safety_factor");
  if (!tv.isNumber(safetyFactor)) {
    return tv.absent("payload.safety_factor", { required: REQUIRED, inputSource: "CONFIG" });
  }

  const limitKg = ratedKg * safetyFactor;

  const loadState = plan.loadState;
  if (loadState === undefined) {
    return tv.absent("the plan's per-stop load state (§15.4)", {
      required: { maxMassKg: limitKg },
      inputSource: "PLAN",
      reason:
        "no per-stop load state is projected for this plan. §15.4's load-state projection is " +
        "engine/payload/loadState.js (Phase 7); this predicate consumes it rather than " +
        "accumulating payload deltas itself, and an unestablished load state is not a safe one",
    });
  }
  if (loadState === null || !Array.isArray(loadState) || loadState.length === 0) {
    return tv.indeterminate({
      required: { maxMassKg: limitKg },
      inputSource: "PLAN",
      reason: "the plan's load state is empty or unreadable; per-stop mass cannot be evaluated (§15.4)",
    });
  }

  let tightestMarginKg = null;

  for (const point of loadState) {
    const massKg = point && point.massUpperBoundKg;

    if (!tv.isNumber(massKg)) {
      return tv.indeterminate({
        observed: { stopSequence: point ? point.sequence : null },
        required: { maxMassKg: limitKg },
        inputSource: "PLAN",
        reason:
          "a load-state point states no upper-bound mass. §15.1 requires feasibility to use the " +
          "upper bound of the declared tolerance, and the expectation is not a substitute for it",
      });
    }

    const marginKg = limitKg - massKg;

    if (massKg > limitKg) {
      return tv.violated({
        observed: { stopSequence: point.sequence === undefined ? null : point.sequence, massUpperBoundKg: massKg },
        required: { maxMassKg: limitKg, ratedKg, safetyFactor },
        inputSource: "PLAN",
        margin: marginKg,
        marginUnit: tv.MARGIN_UNIT.KILOGRAMS,
        reason:
          `load ${massKg} kg at stop ${String(point.sequence)} exceeds the ${limitKg} kg limit ` +
          `(rated ${ratedKg} kg x safety factor ${safetyFactor}). Overload affects braking, ` +
          "stability, and structural limits (§7.5 F22, §15.4)",
      });
    }

    if (tightestMarginKg === null || marginKg < tightestMarginKg) tightestMarginKg = marginKg;
  }

  return tv.satisfied({
    observed: { stopsChecked: loadState.length, tightestMarginKg },
    required: { maxMassKg: limitKg, ratedKg, safetyFactor },
    inputSource: "PLAN",
    margin: tightestMarginKg,
    marginUnit: tv.MARGIN_UNIT.KILOGRAMS,
  });
}

module.exports = { evaluate };
