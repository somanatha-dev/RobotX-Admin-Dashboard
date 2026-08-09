"use strict";

/**
 * `C_delay` — SLA, priority, and aging (§8.7). **Tier 1.**
 *
 * ```
 * C_delay[l](T_complete) =  w_sla(class, tenant)
 *                         · aging_multiplier(queue_age)
 *                         · max(0, T_complete − T_target[l])^p
 *                         + M_breach · 1[ T_complete > T_deadline[l] ]      ← terminal Leg only
 * ```
 *
 * ── The attribution rule, which is the substance of this module ─────────────
 * > A Mission may comprise several Legs (§2.4), but the customer experiences exactly one
 * > instance of lateness. Charging every Leg the full contract term would penalise a
 * > three-Leg Mission three times for one late delivery, and would inflate every exchange
 * > rate in §8.10 by the fleet's average Leg count. The attribution rule is therefore
 * > stated here and is **not left to the implementer**.
 *
 * | Leg role | Term carried | `T_target` |
 * |---|---|---|
 * | **Terminal** — the Leg whose completion determines the Mission's completion | the **full** delay-cost term and the **whole** breach penalty `M_breach` | the Task's contractual target |
 * | **Upstream** — any Leg feeding a transfer point | a **slack-consumption** term: the same functional form with `w_sla` scaled by `sla.upstream_slack_weight` and no breach step | the Leg's *planned* handover time |
 *
 * > `M_breach` appears **once per Mission**, on the terminal Leg only. An upstream Leg
 * > that overruns so far that the Mission's deadline becomes unreachable does not itself
 * > incur the breach step; instead the Mission is re-planned and the terminal Leg's
 * > projected completion carries it, which is where the consequence actually lands.
 *
 * `evaluate()` refuses a Leg whose role is not stated. Defaulting to `TERMINAL` would
 * make every upstream Leg carry a full contract term and a breach step, which is the
 * exact over-charge the rule exists to prevent; defaulting to `UPSTREAM` would drop the
 * breach penalty from a Mission that has one. Neither default is safe, so there is none.
 *
 * ── The aging cap is a correctness requirement, not a tuning preference ─────
 * > An unbounded multiplier multiplies an already-convex lateness penalty, so in a batch
 * > solve a sufficiently aged Leg's cost comes to dominate the entire round's objective.
 * > … That is not anti-starvation; it is a single Leg holding the round's objective
 * > hostage.
 *
 * > **Anti-starvation is guaranteed structurally by the escalation ladder (§17.4), not by
 * > this term.**
 *
 * So the cap is applied here and `cost.aging.max_multiplier` is validated finite at
 * publish (validator V7, Phase 1). The two halves are independent on purpose: a
 * configuration that slipped past the validator still cannot produce an unbounded
 * multiplier at evaluation time.
 *
 * ── A dimensional consequence of `p ≠ 1`, stated rather than hidden ─────────
 * §8.10 registers `cost.sla.cu_per_second_late` with unit CU·s⁻¹, and §8.7 raises the
 * lateness to `p` (default 2). Those two are dimensionally consistent only at `p = 1`: at
 * `p = 2` the product `CU·s⁻¹ · s²` is CU·s, not CU. The specification is frozen and this
 * module implements what it says — `w_sla · aging · lateness^p` — so the practical
 * meaning is that the rate's calibration is exponent-dependent: a `w_sla` fitted at
 * `p = 2` is not the same number as one fitted at `p = 1`, and changing the exponent
 * without recalibrating the rate silently rescales every delay cost in the fleet.
 *
 * `cost.sla.lateness_exponent` is a POLICY-class parameter and `cost.sla.cu_per_second_late`
 * is CONTRACTUAL, so the two are owned by different people — which is precisely the
 * situation in which an unstated coupling causes trouble. It is recorded as a Phase 8
 * ambiguity rather than resolved here, because resolving it means changing §8.7.
 *
 * T1: the entry points that take a plan assert the feasibility brand. Determinism: no
 * clock — `T_complete` and the queue age both arrive from the round's pinned inputs.
 */

const { assertFeasible } = require("../guards/tenets");
const { cu, milli, ZERO, total } = require("./units");
const { applyDimensionlessFactor } = require("./exchangeRates");
const { toMilliCU } = require("../determinism/fixedPoint");

/** @structural milliseconds in one second */
const MS_PER_SECOND = 1000;

/**
 * The two Leg roles §8.7's attribution table defines.
 * @structural §8.7's own two-row table
 */
const LEG_ROLE = Object.freeze({
  /** The Leg whose completion determines the Mission's completion. */
  TERMINAL: "TERMINAL",
  /** A Leg feeding a transfer point. */
  UPSTREAM: "UPSTREAM",
});

/**
 * @param {*} value
 * @returns {boolean}
 */
function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * `aging_multiplier(age) = min( max_multiplier, (1 + age / reference_period)^growth_exponent )`
 *
 * @param {number} queueAgeSeconds
 * @param {object} parameters `{ referencePeriodSeconds, growthExponent, maxMultiplier }`
 * @returns {{ ok: boolean, multiplier: number|null, capped: boolean, missing: string[] }}
 */
function agingMultiplier(queueAgeSeconds, parameters) {
  const source = parameters || {};
  const missing = [];

  if (!isNumber(queueAgeSeconds) || queueAgeSeconds < 0) missing.push("queueAgeSeconds");
  if (!isNumber(source.referencePeriodSeconds) || source.referencePeriodSeconds <= 0) {
    missing.push("cost.aging.reference_period");
  }
  if (!isNumber(source.growthExponent) || source.growthExponent < 0) missing.push("cost.aging.growth_exponent");
  if (!isNumber(source.maxMultiplier) || source.maxMultiplier < 1) missing.push("cost.aging.max_multiplier");
  if (missing.length > 0) return { ok: false, multiplier: null, capped: false, missing };

  const uncapped = (1 + queueAgeSeconds / source.referencePeriodSeconds) ** source.growthExponent;
  const capped = uncapped > source.maxMultiplier;

  return { ok: true, multiplier: capped ? source.maxMultiplier : uncapped, capped, missing: [] };
}

/**
 * `C_delay[l](T_complete)` for one Leg.
 *
 * @param {object} leg
 * @param {string} leg.legId
 * @param {string} leg.role one of `LEG_ROLE` — **required**, never defaulted
 * @param {number} leg.targetMs the Leg's `T_target`: the Task's contractual target for a
 *   terminal Leg, the planned handover time for an upstream one
 * @param {number} [leg.deadlineMs] `T_deadline`; consulted for a terminal Leg only
 * @param {number} leg.queueAgeSeconds
 * @param {number} completionMs `T_complete` the plan achieves for this Leg
 * @param {object} parameters
 * @param {object} parameters.slaRate a `makeRate("cost.sla.cu_per_second_late", …)`
 * @param {number} parameters.breachPenaltyCu `cost.sla.breach_penalty[class]`
 * @param {number} parameters.latenessExponent `cost.sla.lateness_exponent[class]`
 * @param {number} parameters.upstreamSlackWeight `cost.sla.upstream_slack_weight`
 * @param {object} parameters.aging `{ referencePeriodSeconds, growthExponent, maxMultiplier }`
 * @returns {{ ok: boolean, milliCU: bigint|null, breakdown: object|null, missing: string[] }}
 */
function forLeg(leg, completionMs, parameters) {
  const source = parameters || {};
  const target = leg || {};
  const missing = [];

  if (target.role !== LEG_ROLE.TERMINAL && target.role !== LEG_ROLE.UPSTREAM) {
    return {
      ok: false,
      milliCU: null,
      breakdown: null,
      missing: [
        "leg.role — §8.7's attribution rule assigns the full term and M_breach to exactly one " +
          "terminal Leg and a slack-consumption term to every upstream Leg. There is no safe default: " +
          "assuming TERMINAL charges a three-Leg Mission three contract terms, and assuming UPSTREAM " +
          "drops the breach penalty the Mission actually carries",
      ],
    };
  }

  if (!isNumber(completionMs)) missing.push("completionMs");
  if (!isNumber(target.targetMs)) missing.push("leg.targetMs");
  if (!source.slaRate || typeof source.slaRate.value !== "number") missing.push("cost.sla.cu_per_second_late");
  if (!isNumber(source.latenessExponent) || source.latenessExponent < 1) {
    missing.push("cost.sla.lateness_exponent");
  }
  if (target.role === LEG_ROLE.TERMINAL && !isNumber(source.breachPenaltyCu)) {
    missing.push("cost.sla.breach_penalty");
  }
  if (target.role === LEG_ROLE.UPSTREAM && (!isNumber(source.upstreamSlackWeight) || source.upstreamSlackWeight < 0)) {
    missing.push("cost.sla.upstream_slack_weight");
  }

  const aging = agingMultiplier(target.queueAgeSeconds, source.aging);
  if (!aging.ok) missing.push(...aging.missing);

  if (missing.length > 0) return { ok: false, milliCU: null, breakdown: null, missing: [...new Set(missing)] };

  const latenessSeconds = Math.max(0, (completionMs - target.targetMs) / MS_PER_SECOND);

  // One float expression, one conversion into milli-CU. `fixedPoint` states the
  // discipline — "the conversion boundary is one function" — and a chain of per-factor
  // conversions would round three times and make the result depend on the order.
  const shapedCu = source.slaRate.value * aging.multiplier * latenessSeconds ** source.latenessExponent;
  let lateness = cu(shapedCu);

  if (target.role === LEG_ROLE.UPSTREAM) {
    // The one place §8.7 permits a dimensionless factor on this term, and it is a
    // registered one, so it goes through the checked path rather than a bare multiply.
    lateness = applyDimensionlessFactor(lateness, source.upstreamSlackWeight, "cost.sla.upstream_slack_weight");
  }

  // §8.7: the breach step is carried by the terminal Leg alone, once per Mission.
  const breaches =
    target.role === LEG_ROLE.TERMINAL && isNumber(target.deadlineMs) && completionMs > target.deadlineMs;
  const breach = breaches ? cu(source.breachPenaltyCu) : ZERO;

  return {
    ok: true,
    milliCU: total(lateness, breach).milliCU,
    breakdown: Object.freeze({
      legId: target.legId ?? null,
      role: target.role,
      completionMs,
      targetMs: target.targetMs,
      deadlineMs: isNumber(target.deadlineMs) ? target.deadlineMs : null,
      latenessSeconds,
      latenessExponent: source.latenessExponent,
      queueAgeSeconds: target.queueAgeSeconds ?? null,
      agingMultiplier: aging.multiplier,
      agingCapped: aging.capped,
      upstreamSlackWeight: target.role === LEG_ROLE.UPSTREAM ? source.upstreamSlackWeight : null,
      latenessMilliCU: lateness.milliCU,
      breached: breaches,
      breachMilliCU: breach.milliCU,
      slaCostPerSecond: source.slaRate.value,
    }),
    missing: [],
  };
}

/**
 * `Σ_{l ∈ legs(plan)} C_delay[l]( completion_time(l, plan) )`.
 *
 * > `legs(plan)` is **every** Leg the plan executes — the Legs being newly inserted *and*
 * > the Legs the agent had already committed.
 *
 * That is what makes a column pay for the delay it imposes on work the agent already
 * holds, and it is the difference between an insertion price and a standalone one
 * (§13.3). A plan that reported only its new Legs would price chaining as free.
 *
 * @param {object} plan the branded plan
 * @param {Record<string, number>} completionByLegId from `plan/timeline.legCompletions()`
 * @param {(legId: string) => object} parametersFor per-Leg parameters, since `w_sla`,
 *   `M_breach`, and `p` are all indexed by SLA class and tenant
 * @returns {{ ok: boolean, milliCU: bigint|null, perLeg: object[], missing: string[] }}
 */
function forPlan(plan, completionByLegId, parametersFor) {
  assertFeasible(plan, "cost/cDelay.forPlan");

  const legs = (plan && plan.legs) || [];
  if (legs.length === 0) {
    return { ok: false, milliCU: null, perLeg: [], missing: ["plan.legs"] };
  }

  const perLeg = [];
  const missing = [];
  let accumulated = ZERO;
  let terminalCount = 0;

  // Canonical order, so the reported breakdown is identical across runs. The sum itself
  // is order-independent (integer arithmetic, §9.6 requirement 1).
  const ordered = [...legs].sort((a, b) => (String(a.legId) < String(b.legId) ? -1 : 1));

  for (const leg of ordered) {
    const legId = String(leg.legId);
    const completionMs = (completionByLegId || {})[legId];
    const parameters = typeof parametersFor === "function" ? parametersFor(legId) : null;
    const evaluated = forLeg(leg, completionMs, parameters);

    if (!evaluated.ok) {
      missing.push(...evaluated.missing.map((name) => `${legId}: ${name}`));
      continue;
    }
    if (leg.role === LEG_ROLE.TERMINAL) terminalCount += 1;
    perLeg.push(evaluated.breakdown);
    accumulated = total(accumulated, milli(evaluated.milliCU));
  }

  if (missing.length > 0) return { ok: false, milliCU: null, perLeg, missing };

  return { ok: true, milliCU: accumulated.milliCU, perLeg, terminalLegCount: terminalCount, missing: [] };
}

/**
 * Check §8.7's once-per-Mission property over a plan's Legs.
 *
 * A plan holding two Legs of the same Mission both marked `TERMINAL` would charge
 * `M_breach` twice, which is the specific over-charge the attribution rule forbids. The
 * check is separate from `forPlan` so a caller can run it over a *proposed* plan before
 * pricing, and so the failure names the Mission rather than surfacing as a large number.
 *
 * @param {Array<{legId: string, missionId: string, role: string}>} legs
 * @returns {{ ok: boolean, problems: string[] }}
 */
function assertAttribution(legs) {
  const terminalsByMission = new Map();
  const problems = [];

  for (const leg of legs || []) {
    if (!leg || leg.role !== LEG_ROLE.TERMINAL) continue;
    const missionId = String(leg.missionId ?? "");
    const seen = terminalsByMission.get(missionId) || [];
    seen.push(String(leg.legId));
    terminalsByMission.set(missionId, seen);
  }

  for (const [missionId, legIds] of terminalsByMission.entries()) {
    if (legIds.length > 1) {
      problems.push(
        `Mission "${missionId}" has ${legIds.length} terminal Legs (${legIds.join(", ")}). §8.7: ` +
          "M_breach appears once per Mission, on the terminal Leg only — the customer experiences " +
          "exactly one instance of lateness",
      );
    }
  }

  return { ok: problems.length === 0, problems };
}

/**
 * The expected overrun cost given lateness, for `C_risk`'s `p_late · E[C_delay overrun | late]`.
 *
 * Exposed here rather than recomputed in `cRisk.js` so that the two cannot disagree: the
 * risk term prices the *same* functional at a worse completion time, which is what
 * "overrun" means. A second implementation would be a second delay model.
 *
 * @param {object} leg as `forLeg`
 * @param {number} expectedCompletionIfLateMs
 * @param {object} parameters as `forLeg`
 * @returns {ReturnType<typeof forLeg>}
 */
function overrunGivenLate(leg, expectedCompletionIfLateMs, parameters) {
  return forLeg(leg, expectedCompletionIfLateMs, parameters);
}

module.exports = {
  LEG_ROLE,
  MS_PER_SECOND,
  agingMultiplier,
  forLeg,
  forPlan,
  assertAttribution,
  overrunGivenLate,
};
