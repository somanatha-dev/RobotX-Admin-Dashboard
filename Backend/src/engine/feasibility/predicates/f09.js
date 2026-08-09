"use strict";

/**
 * **F9 — Health tier ≥ tier required by the mission's SLA class.** Class P.
 * Indeterminate: `DENY`.
 *
 * > A marginal agent should not carry a critical or high-value mission even when it is
 * > nominally functional.
 *
 * F8 asks whether the agent may work at all; F9 asks whether it may carry *this*
 * work. The two are separate because the answer differs by mission: an agent with a
 * degraded fault is a perfectly reasonable choice for a routine internal transfer and
 * the wrong choice for a time-critical medical delivery, and one boolean cannot say
 * so.
 *
 * ── Class P, and what that does and does not permit ─────────────────────────
 * §7.2 allows an authorised operator to override a class P predicate with a recorded
 * reason (§23.6). That override is not this module's concern and is not expressible
 * here: the predicate reports what it measured, and the override machinery decides
 * whether a *recorded* waiver exists. A predicate that read an override flag would be
 * the bypass §7.2 warns a single undifferentiated list acquires.
 *
 * Note the declared indeterminate policy is `DENY`, not `ADMIT_WITH_PENALTY`: §7.5's
 * Indeterminate column says `DENY` for F9, and an unknown health tier on a
 * high-value mission is not a priceable uncertainty.
 *
 * Tier 0 (T0-01).
 */

const tv = require("../threeValued");

/**
 * §16.4's health tiers, ordered worst to best. The comparison is `>=` over this
 * order, so a tier the engine cannot rank is `INDETERMINATE` rather than admitted.
 * @structural the specification's own health-tier labels, ordered
 */
const HEALTH_TIER_ORDER = Object.freeze(["QUARANTINED", "MARGINAL", "NOMINAL", "FULL"]);

const REQUIRED = "health tier at or above the mission SLA class's required tier";

/**
 * @param {unknown} tier
 * @returns {number} rank, or -1 when unrecognised
 */
function rankOf(tier) {
  return HEALTH_TIER_ORDER.indexOf(String(tier).toUpperCase());
}

/**
 * @param {object} context `{ agentSnapshot, mission, plan, config }`
 * @returns {object} a `threeValued` predicate result
 */
function evaluate(context) {
  const agent = (context && context.agentSnapshot) || null;
  const mission = (context && context.mission) || null;
  const config = context && context.config;

  if (!agent) return tv.absent("the agent snapshot", { required: REQUIRED });
  if (!mission) return tv.absent("the mission", { required: REQUIRED });

  const observed = agent.healthTier;
  if (observed === undefined || observed === null) {
    return tv.absent("the agent's health tier", { required: REQUIRED, inputSource: "INFERRED" });
  }

  const observedRank = rankOf(observed);
  if (observedRank < 0) {
    return tv.indeterminate({
      observed: String(observed),
      required: REQUIRED,
      inputSource: "INFERRED",
      reason: `health tier "${String(observed)}" is not one of ${HEALTH_TIER_ORDER.join(", ")}`,
    });
  }

  // The required tier is a property of the mission's SLA class, resolved through the
  // register so that raising the bar for a class is a configuration change with an
  // owner and a blast radius (§22) rather than an edit here.
  const slaClass = mission.slaClass;
  const required =
    mission.requiredHealthTier !== undefined && mission.requiredHealthTier !== null
      ? mission.requiredHealthTier
      : tv.readIndexedParameter(config, "health.required_tier", slaClass);

  if (required === undefined || required === null) {
    return tv.absent(`the required health tier for SLA class "${String(slaClass)}"`, {
      observed: String(observed),
      required: REQUIRED,
      inputSource: "CONFIG",
    });
  }

  const requiredRank = rankOf(required);
  if (requiredRank < 0) {
    return tv.indeterminate({
      observed: String(observed),
      required: String(required),
      inputSource: "CONFIG",
      reason: `the required health tier "${String(required)}" is not one of ${HEALTH_TIER_ORDER.join(", ")}`,
    });
  }

  const margin = observedRank - requiredRank;

  if (margin < 0) {
    return tv.violated({
      observed: String(observed).toUpperCase(),
      required: String(required).toUpperCase(),
      inputSource: "INFERRED",
      margin,
      marginUnit: tv.MARGIN_UNIT.RANK,
      reason:
        `health tier ${String(observed).toUpperCase()} is below the ${String(required).toUpperCase()} ` +
        `required by SLA class "${String(slaClass)}" (§7.5 F9, §16.4)`,
    });
  }

  return tv.satisfied({
    observed: String(observed).toUpperCase(),
    required: String(required).toUpperCase(),
    inputSource: "INFERRED",
    margin,
    marginUnit: tv.MARGIN_UNIT.RANK,
  });
}

module.exports = { evaluate, HEALTH_TIER_ORDER };
