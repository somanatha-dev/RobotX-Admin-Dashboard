"use strict";

/**
 * **F11 — Reliability estimate within acceptable bound for the mission class.**
 * Class P. Indeterminate: **`ADMIT_WITH_PENALTY` using the cohort prior.**
 *
 * > Bars an agent whose recent intervention rate has degraded past a threshold, before
 * > a human notices (§16.4).
 *
 * ── The one predicate in group 2 that admits on unknown, and why ────────────
 * Every other safety-and-health predicate denies on `INDETERMINATE`. F11 does not,
 * and §7.5's Indeterminate column says why in five words: *"`ADMIT_WITH_PENALTY` using
 * the cohort prior"*. A newly commissioned agent has no intervention history by
 * construction, and denying it would make the fleet unable to introduce new hardware
 * — a rule that grounds every new agent until it has accumulated the history it can
 * only accumulate by working is not conservative, it is circular.
 *
 * The cohort prior is what makes admitting defensible: an agent with no history of its
 * own is not unknown, it is *typical of its cohort until shown otherwise*, and the
 * penalty prices exactly that residual uncertainty.
 *
 * ── What "admit with penalty" requires of this module ───────────────────────
 * Nothing. The penalty is `cost.uncertainty_penalty[F11]`, applied by
 * `threeValued.applyPolicy()` from the resolved register value; a predicate that
 * computed a cost would be evaluating cost inside the feasibility gate, which T1
 * forbids in the other direction and §7.1 forbids in this one. This module reports
 * `INDETERMINATE` with the cohort prior as the observed value, and the policy does
 * the rest.
 *
 * ── Reliability is Tier 2; this predicate is Tier 0 ─────────────────────────
 * §1.8 classes reliability-priced risk as a Tier 2 mechanism behind the
 * `reliability_based_gating` kill switch, and Tier 0 may not depend on Tier 2 (§1.8
 * rule 2). No import of `engine/reliability/` appears here: the estimate arrives *in
 * the snapshot*, already computed, which is the dependency inversion the tier gate
 * requires. With the kill switch thrown the snapshot carries cohort priors only, and
 * this predicate behaves identically — it never learns which it was given.
 *
 * Tier 0 (T0-01).
 */

const tv = require("../threeValued");

const REQUIRED = "intervention rate within the mission class's acceptable bound";

/**
 * @param {object} context `{ agentSnapshot, mission, plan, config }`
 * @returns {object} a `threeValued` predicate result
 */
function evaluate(context) {
  const agent = (context && context.agentSnapshot) || null;
  const mission = (context && context.mission) || null;
  const config = context && context.config;

  if (!agent) return tv.absent("the agent snapshot", { required: REQUIRED });

  const missionClass = mission && mission.missionClass;
  const bound = tv.readIndexedParameter(config, "reliability.max_intervention_rate", missionClass);

  if (!tv.isNumber(bound)) {
    return tv.absent(`reliability.max_intervention_rate for mission class "${String(missionClass)}"`, {
      required: REQUIRED,
      inputSource: "CONFIG",
    });
  }

  const reliability = agent.reliability || null;
  const observed = reliability && reliability.interventionRate;
  const cohortPrior = reliability && reliability.cohortPrior;

  if (!tv.isNumber(observed)) {
    // The declared policy's own case. The cohort prior travels in the tuple so the
    // decision record shows what the penalty was applied *in place of*, and so a
    // reviewer can see whether the prior itself was near the bound.
    return tv.indeterminate({
      observed: { interventionRate: null, cohortPrior: tv.isNumber(cohortPrior) ? cohortPrior : null },
      required: { maxInterventionRate: bound },
      inputSource: "INFERRED",
      margin: tv.isNumber(cohortPrior) ? bound - cohortPrior : null,
      marginUnit: tv.MARGIN_UNIT.RATIO,
      reason:
        "no per-agent intervention rate is available; the cohort prior stands in and the policy " +
        "admits with cost.uncertainty_penalty[F11] (§7.5 F11). Denying instead would ground every " +
        "newly commissioned agent until it accumulated history it can only accumulate by working",
    });
  }

  const margin = bound - observed;

  if (observed > bound) {
    return tv.violated({
      observed: { interventionRate: observed },
      required: { maxInterventionRate: bound },
      inputSource: "INFERRED",
      margin,
      marginUnit: tv.MARGIN_UNIT.RATIO,
      reason:
        `intervention rate ${observed} exceeds the ${bound} acceptable for mission class ` +
        `"${String(missionClass)}" (§7.5 F11, §16.4)`,
    });
  }

  return tv.satisfied({
    observed: { interventionRate: observed },
    required: { maxInterventionRate: bound },
    inputSource: "INFERRED",
    margin,
    marginUnit: tv.MARGIN_UNIT.RATIO,
  });
}

module.exports = { evaluate };
