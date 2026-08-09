"use strict";

/**
 * `C_opportunity` — the resource-allocation term (§8.3). **Tier 2**, mechanism T2-06,
 * kill switch `opportunity_cost_term`.
 *
 * > This term has no counterpart in the baseline and is the largest single source of
 * > expected quality improvement. It is also the most mathematically delicate term in the
 * > model, so it is derived here rather than asserted, and it is built from **one**
 * > calibrated primitive rather than from several independently-estimated quantities that
 * > could double-count each other.
 *
 * The derivation, in full, because the implementation is the derivation:
 *
 * ```
 * C_opportunity =  V_terminal( p_start, soc_start, t_start )
 *                − V_terminal( p_end,   soc_end,   t_release )
 *
 *               =  [ V_terminal(p_start, soc_start, t_start)                    ← unavailability
 *                    − V_terminal(p_start, soc_start, t_release) ]                 component
 *
 *               +  [ V_terminal(p_start, soc_start, t_release)                  ← relocation
 *                    − V_terminal(p_end,   soc_end,   t_release) ]                 component
 * ```
 *
 * > The two brackets **telescope exactly**: the intermediate term appears once positive
 * > and once negative and cancels. They are therefore two components of one quantity, not
 * > two independent estimators of the same quantity, and summing them cannot double-count.
 *
 * ```
 * C_opportunity =  ∫[ t_start → t_release ] λ_zone( origin_zone(a), τ ) dτ
 *                + [ V_terminal(p_start, soc_start, t_release)
 *                    − V_terminal(p_end, soc_end, t_release) ]
 * ```
 *
 * ── The three properties, each guarded ─────────────────────────────────────
 *
 * **(a) No double count.** One primitive, `λ_zone`, integrated over two *disjoint*
 * domains. `telescopingResidual()` recomputes the undecomposed difference and reports the
 * gap, so the identity is a checked property rather than a claim in a comment.
 *
 * > Adding two *independently estimated* quantities … charges the same resource
 * > consumption twice, over-penalises long missions in proportion to their duration, and
 * > makes the model's true sensitivity to zone prices roughly double what any calibration
 * > exercise would infer.
 *
 * **(b) The integral is over the origin zone, at a fixed position.**
 *
 * > It is emphatically *not* taken along the route the agent travels. An agent in transit
 * > is not available anywhere, so integrating an *availability* price along its path would
 * > penalise a mission for the accident of passing through an expensive zone — a quantity
 * > that measures nothing physical.
 *
 * `unavailability()` takes a single `originZoneId` and has no route parameter at all.
 * There is no argument through which a caller could supply a path, which is the
 * structural form of the rule.
 *
 * **(c) Both relocation evaluations are at the same time, `t_release`.**
 *
 * > Evaluating the start state at `t_start` and the end state at `t_release` would fold
 * > the passage of time into a term meant to measure displacement, silently re-charging
 * > the duration already priced by the first bracket.
 *
 * `relocation()` takes one instant and applies it to both states. A caller cannot pass two.
 *
 * ── Sign and lower bound ───────────────────────────────────────────────────
 * > The unavailability component is non-negative, since `λ_zone ≥ 0`. The relocation
 * > component may be **negative** … `C_opportunity` is therefore bounded below by
 * > `− Ω_terminal`.
 *
 * Checked against `signDiscipline`, because §6.4's pruning bound subtracts exactly that
 * quantity and a value beneath it makes the bound inadmissible.
 *
 * ── Horizon discipline ─────────────────────────────────────────────────────
 * > `V_avail` is zero beyond `T_H`, so a commitment extending past the horizon is charged
 * > the full remaining-horizon integral and the term stops discriminating among
 * > still-longer commitments.
 *
 * The saturation is reported on every evaluation that reaches it, so a fleet whose
 * horizon is too short shows up as a rising saturation rate rather than as a term that
 * quietly stopped discriminating. The Config Service rejects such a horizon at publish
 * (validator V1); this is the runtime half.
 *
 * T1 (§1.5): the plan entry point asserts the feasibility brand. Determinism: no clock —
 * `t_start`, `t_release`, and `T_H` all descend from the round's pinned decision time.
 */

const { assertFeasible } = require("../guards/tenets");
const { cu, total } = require("./units");
const vTerminalModule = require("../pricing/vTerminal");
const signDiscipline = require("./signDiscipline");

/** @structural milliseconds in one second */
const MS_PER_SECOND = 1000;

/** The two components of the one telescoping identity. */
const COMPONENT = Object.freeze({
  UNAVAILABILITY: "unavailability",
  RELOCATION: "relocation",
});

/**
 * @param {*} value
 * @returns {boolean}
 */
function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * The unavailability component: `∫[t_start → t_release] λ_zone(origin_zone(a), τ) dτ`.
 *
 * Note what is **not** a parameter: a route, a path, a sequence of zones, or an end
 * position. The integral is over one zone at one fixed position for the whole commitment,
 * and there is no way to express anything else through this signature.
 *
 * The integral is truncated at `T_H`, matching `V_avail`'s own boundary condition, so the
 * closed form and the bracket it came from agree exactly for commitments that run past
 * the horizon as well as for those that do not.
 *
 * @param {object} input
 * @param {object} input.priceSnapshot the round's pinned λ_zone surface
 * @param {string} input.originZoneId the zone the agent would have been available in
 * @param {number} input.startMs `t_start`
 * @param {number} input.releaseMs `t_release`
 * @param {number} input.horizonEndMs `T_H`
 * @returns {{ ok: boolean, cu: number|null, saturated: boolean, effectiveEndMs: number|null,
 *             problems: string[] }}
 */
function unavailability(input) {
  const source = input || {};
  const problems = [];

  if (!isNumber(source.startMs)) problems.push("startMs");
  if (!isNumber(source.releaseMs)) problems.push("releaseMs");
  if (!isNumber(source.horizonEndMs)) problems.push("horizonEndMs");
  if (problems.length > 0) return { ok: false, cu: null, saturated: false, effectiveEndMs: null, problems };

  if (source.releaseMs < source.startMs) {
    return {
      ok: false,
      cu: null,
      saturated: false,
      effectiveEndMs: null,
      problems: ["t_release precedes t_start; a commitment cannot end before it begins"],
    };
  }

  // The integral runs to the release or the horizon, whichever comes first. Beyond T_H
  // there is nothing to forgo, because V_avail values nothing there.
  const effectiveEndMs = Math.min(source.releaseMs, source.horizonEndMs);
  const saturated = source.releaseMs > source.horizonEndMs;

  // Computed as a difference of two V_avail integrals rather than as a fresh integral
  // over [t_start, t_release]. That is what makes the telescoping exact rather than
  // approximately exact: the two halves are literally the same function evaluated twice,
  // so a change to how λ is integrated cannot desynchronise them.
  const atStart = vTerminalModule.vAvail({
    snapshot: source.priceSnapshot,
    zoneId: source.originZoneId,
    fromMs: source.startMs,
    horizonEndMs: source.horizonEndMs,
  });
  if (!atStart.ok) return { ok: false, cu: null, saturated, effectiveEndMs, problems: atStart.problems };

  const atRelease = vTerminalModule.vAvail({
    snapshot: source.priceSnapshot,
    zoneId: source.originZoneId,
    fromMs: effectiveEndMs,
    horizonEndMs: source.horizonEndMs,
  });
  if (!atRelease.ok) return { ok: false, cu: null, saturated, effectiveEndMs, problems: atRelease.problems };

  return {
    ok: true,
    cu: atStart.cu - atRelease.cu,
    saturated,
    effectiveEndMs,
    durationSeconds: (effectiveEndMs - source.startMs) / MS_PER_SECOND,
    problems: [],
  };
}

/**
 * The relocation component:
 * `V_terminal(p_start, soc_start, t_release) − V_terminal(p_end, soc_end, t_release)`.
 *
 * One instant, applied to both states. §8.3.3(c) is the reason this is a single parameter
 * rather than two: evaluating the start state at `t_start` would re-charge the duration
 * the unavailability component has already priced.
 *
 * @param {object} input
 * @param {number} input.releaseMs the one instant both states are valued at
 * @param {object} input.startState `{ zoneId, chargeAccessCu, socDeficitCu }` — the agent's
 *   position and charge as it stands now, valued as if it were free at `t_release`
 * @param {object} input.endState `{ zoneId, chargeAccessCu, socDeficitCu }` — where the plan
 *   leaves it
 * @param {object} input.priceSnapshot
 * @param {number} input.horizonEndMs
 * @returns {{ ok: boolean, cu: number|null, startCu: number|null, endCu: number|null,
 *             problems: string[] }}
 */
function relocation(input) {
  const source = input || {};
  const problems = [];

  if (!isNumber(source.releaseMs)) problems.push("releaseMs");
  if (!source.startState || !source.endState) problems.push("startState and endState");
  if (problems.length > 0) return { ok: false, cu: null, startCu: null, endCu: null, problems };

  const evaluateState = (state, label) => {
    const avail = vTerminalModule.vAvail({
      snapshot: source.priceSnapshot,
      zoneId: state.zoneId,
      fromMs: source.releaseMs,
      horizonEndMs: source.horizonEndMs,
    });
    if (!avail.ok) return { ok: false, cu: null, problems: avail.problems.map((p) => `${label}: ${p}`) };

    const valued = vTerminalModule.vTerminal({
      vAvailCu: avail.cu,
      chargeAccessCu: state.chargeAccessCu,
      socDeficitCu: state.socDeficitCu,
    });
    if (!valued.ok) {
      return { ok: false, cu: null, problems: valued.missing.map((name) => `${label}: ${name}`) };
    }
    return { ok: true, cu: valued.cu, components: valued.components, problems: [] };
  };

  const start = evaluateState(source.startState, "startState");
  const end = evaluateState(source.endState, "endState");
  if (!start.ok || !end.ok) {
    return { ok: false, cu: null, startCu: null, endCu: null, problems: [...start.problems, ...end.problems] };
  }

  return {
    ok: true,
    cu: start.cu - end.cu,
    startCu: start.cu,
    endCu: end.cu,
    startComponents: start.components,
    endComponents: end.components,
    problems: [],
  };
}

/**
 * The residual of §8.3.3's telescoping identity.
 *
 * ```
 * unavailability + relocation  −  [ V_terminal(start, t_start) − V_terminal(end, t_release) ]
 * ```
 *
 * Zero when the identity holds. It holds exactly when the charge-access and SoC-deficit
 * terms of the start state are the **same** at `t_start` and at `t_release` — which is
 * §8.3.3's own stated condition, "the charge-access and SoC-deficit terms are evaluated at
 * the *same* state in both halves of that bracket and cancel with it".
 *
 * Reported rather than asserted zero, because the condition is a modelling assumption
 * about the two subtracted costs and a caller that supplies a time-varying charge-access
 * cost for the start state is entitled to see how much the decomposition then costs it.
 *
 * @param {object} input as `evaluate`, plus `startStateAtStartMs` — the start state's
 *   charge-access and SoC-deficit costs evaluated at `t_start`
 * @returns {{ ok: boolean, residualCu: number|null, decomposedCu: number|null,
 *             undecomposedCu: number|null, problems: string[] }}
 */
function telescopingResidual(input) {
  const source = input || {};

  const unavailable = unavailability(source);
  const relocated = relocation(source);
  if (!unavailable.ok || !relocated.ok) {
    return {
      ok: false,
      residualCu: null,
      decomposedCu: null,
      undecomposedCu: null,
      problems: [...unavailable.problems, ...relocated.problems],
    };
  }

  const startAtStart = source.startStateAtStartMs || source.startState;
  const availAtStart = vTerminalModule.vAvail({
    snapshot: source.priceSnapshot,
    zoneId: source.startState.zoneId,
    fromMs: source.startMs,
    horizonEndMs: source.horizonEndMs,
  });
  if (!availAtStart.ok) {
    return {
      ok: false,
      residualCu: null,
      decomposedCu: null,
      undecomposedCu: null,
      problems: availAtStart.problems,
    };
  }

  const valuedAtStart = vTerminalModule.vTerminal({
    vAvailCu: availAtStart.cu,
    chargeAccessCu: startAtStart.chargeAccessCu,
    socDeficitCu: startAtStart.socDeficitCu,
  });
  if (!valuedAtStart.ok) {
    return {
      ok: false,
      residualCu: null,
      decomposedCu: null,
      undecomposedCu: null,
      problems: valuedAtStart.missing,
    };
  }

  const decomposedCu = unavailable.cu + relocated.cu;
  const undecomposedCu = valuedAtStart.cu - relocated.endCu;

  return {
    ok: true,
    residualCu: decomposedCu - undecomposedCu,
    decomposedCu,
    undecomposedCu,
    problems: [],
  };
}

/**
 * `C_opportunity` for one plan.
 *
 * @param {object} plan the branded plan
 * @param {object} input as `unavailability` and `relocation` combined, plus:
 * @param {number} input.omegaTerminalCu `Ω_terminal` for the round, from the same price
 *   snapshot this evaluation used
 * @returns {{ ok: boolean, milliCU: bigint|null, breakdown: object|null,
 *             signCheck: object|null, problems: string[] }}
 */
function evaluate(plan, input) {
  assertFeasible(plan, "cost/cOpportunity.evaluate");

  const source = input || {};
  const unavailable = unavailability(source);
  const relocated = relocation(source);

  if (!unavailable.ok || !relocated.ok) {
    return {
      ok: false,
      milliCU: null,
      breakdown: null,
      signCheck: null,
      problems: [...unavailable.problems, ...relocated.problems],
    };
  }
  if (!isNumber(source.omegaTerminalCu) || source.omegaTerminalCu < 0) {
    return {
      ok: false,
      milliCU: null,
      breakdown: null,
      signCheck: null,
      problems: [
        "cost.opportunity.max_terminal_gain (Ω_terminal) is required. §8.1 declares C_opportunity " +
          "bounded below rather than non-negative, and a term that may be negative with no bound " +
          "cannot be pruned against (§6.4)",
      ],
    };
  }

  const unavailabilityCost = cu(unavailable.cu);
  const relocationCost = cu(relocated.cu);
  const summed = total(unavailabilityCost, relocationCost);

  const signCheck = signDiscipline.check("C_opportunity", summed.milliCU, {
    lowerBoundMilliCU: cu(source.omegaTerminalCu).milliCU,
  });

  return {
    ok: true,
    milliCU: summed.milliCU,
    breakdown: Object.freeze({
      [COMPONENT.UNAVAILABILITY]: Object.freeze({
        cu: unavailable.cu,
        milliCU: unavailabilityCost.milliCU,
        originZoneId: source.originZoneId ?? null,
        startMs: source.startMs,
        releaseMs: source.releaseMs,
        durationSeconds: unavailable.durationSeconds,
        horizonSaturated: unavailable.saturated,
        note:
          "integrated over the origin zone at a fixed position, never along the route: an agent in " +
          "transit is not available anywhere (§8.3.3(b))",
      }),
      [COMPONENT.RELOCATION]: Object.freeze({
        cu: relocated.cu,
        milliCU: relocationCost.milliCU,
        evaluatedAtMs: source.releaseMs,
        startTerminalCu: relocated.startCu,
        endTerminalCu: relocated.endCu,
        startComponents: relocated.startComponents,
        endComponents: relocated.endComponents,
        note: "both states valued at t_release, so displacement is measured without re-charging duration (§8.3.3(c))",
      }),
      priceSnapshotVersion: (source.priceSnapshot && source.priceSnapshot.version) ?? null,
      priceSource: (source.priceSnapshot && source.priceSnapshot.source) ?? null,
      omegaTerminalCu: source.omegaTerminalCu,
    }),
    signCheck,
    problems: signCheck.ok ? [] : [signCheck.finding],
  };
}

module.exports = {
  COMPONENT,
  MS_PER_SECOND,
  unavailability,
  relocation,
  telescopingResidual,
  evaluate,
};
