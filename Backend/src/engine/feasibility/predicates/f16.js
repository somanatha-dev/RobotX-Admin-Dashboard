"use strict";

/**
 * **F16 — Observation freshness within the budget for every safety-relevant input.**
 * Class I. Indeterminate: `DENY`, **subject to §7.4**.
 *
 * > The general form of the freshness rule (§2.7).
 *
 * The other predicates check the freshness of the input each one needs. F16 is the
 * catch-all that makes the rule total: *every* safety-relevant input, including ones
 * no individual predicate happens to read, must be within its declared budget. Without
 * it the freshness discipline would hold exactly where somebody remembered to write
 * it, which is how the baseline arrived at its registry-expiry cliff:
 *
 * > several inputs simultaneously degraded to their *most permissive* defaults
 * > precisely when an agent had stopped reporting — that is, when a negative signal
 * > was silently read as positive.
 *
 * ── "Subject to §7.4" ───────────────────────────────────────────────────────
 * F16's Indeterminate column is the only one in the register carrying a qualifier, and
 * it points at the systemic guard. The reason is structural: F16 is the predicate a
 * telemetry outage trips *first and fleet-wide*, so a naive fail-closed on it is
 * exactly the availability outage §7.4 exists to prevent. The qualifier does not
 * weaken the `DENY` — this module always denies on stale, and Restricted Operation
 * "suspends no invariant". What §7.4 changes is what the *shard* does once it observes
 * that this predicate is denying everywhere at once, and that is `systemicGuard.js`'s
 * decision, not this predicate's.
 *
 * ── Budgets are declared per input kind, never defaulted here ───────────────
 * §2.7: "Every consumer of an Observation declares a **staleness budget**." A budget
 * defaulted inside this module would be a behavioural constant outside the register
 * (§22.1 rule 1), so an input with no declared budget is `INDETERMINATE` — the
 * strictest reading, and the one that surfaces the omission instead of hiding it.
 *
 * ── Dead-reckoned positions are inadmissible, not merely stale ──────────────
 * §2.7: "Extrapolation is permitted for cost estimation and **prohibited for safety
 * constraints**." A dead-reckoned observation inside its budget still fails here,
 * which `observation.isAdmissibleFor` states once so this module asks rather than
 * remembers.
 *
 * On the volatile subset (§10.3.2 step 3).
 *
 * Tier 0 (T0-01).
 */

const tv = require("../threeValued");
const { FRESHNESS, assess, isAdmissibleFor } = require("../../domain/observation");

const REQUIRED = "every safety-relevant observation within its declared staleness budget";

/** §2.7's use-purpose for this predicate. @structural the specification's own purpose label */
const SAFETY_CONSTRAINT = "SAFETY_CONSTRAINT";

/**
 * @param {object} context `{ agentSnapshot, mission, plan, config, decisionTimeMs }`
 * @returns {object} a `threeValued` predicate result
 */
function evaluate(context) {
  const agent = (context && context.agentSnapshot) || null;
  const decisionTimeMs = context && context.decisionTimeMs;

  if (!agent) return tv.absent("the agent snapshot", { required: REQUIRED });

  if (!tv.isNumber(decisionTimeMs)) {
    return tv.indeterminate({
      required: REQUIRED,
      reason: "the round's pinned decision time is absent; freshness cannot be established (T6, §9.6)",
    });
  }

  const inputs = agent.safetyRelevantObservations;
  if (inputs === undefined) {
    return tv.absent("the safety-relevant observation set", { required: REQUIRED, inputSource: "SENSOR" });
  }
  if (inputs === null || typeof inputs !== "object") {
    return tv.indeterminate({
      required: REQUIRED,
      inputSource: "SENSOR",
      reason: "the safety-relevant observation set is unreadable; freshness cannot be established",
    });
  }

  const kinds = Object.keys(inputs).sort();
  if (kinds.length === 0) {
    return tv.indeterminate({
      observed: { kinds: [] },
      required: REQUIRED,
      inputSource: "SENSOR",
      reason:
        "the snapshot declares no safety-relevant inputs at all. An empty set is not a fresh set: " +
        "it means nothing established which inputs this mission's safety depends on (§2.7)",
    });
  }

  let worstMarginMs = null;

  for (const kind of kinds) {
    const entry = inputs[kind];
    const budgetMs = entry && entry.stalenessBudgetMs;

    if (!tv.isNumber(budgetMs)) {
      return tv.indeterminate({
        observed: { kind },
        required: REQUIRED,
        inputSource: "SENSOR",
        reason:
          `safety-relevant input "${kind}" declares no staleness budget. §2.7 requires every ` +
          "consumer to declare one; a budget defaulted here would be a behavioural constant " +
          "outside the register (§22.1 rule 1)",
      });
    }

    const observation = entry.observation === undefined ? null : entry.observation;

    if (observation !== null && !isAdmissibleFor(observation, { purpose: SAFETY_CONSTRAINT })) {
      return tv.violated({
        observed: { kind, deadReckoned: true },
        required: REQUIRED,
        inputSource: "INFERRED",
        reason:
          `safety-relevant input "${kind}" is dead-reckoned. §2.7 permits extrapolation for cost ` +
          "estimation and prohibits it for safety constraints",
      });
    }

    const freshness = assess(observation, { stalenessBudgetMs: budgetMs, atEpochMs: decisionTimeMs });

    if (freshness.freshness !== FRESHNESS.FRESH) {
      return tv.stale(`safety-relevant input "${kind}"`, freshness.ageMs, budgetMs, {
        observed: { kind, ageMs: freshness.ageMs },
        required: { stalenessBudgetMs: budgetMs },
        inputSource: "SENSOR",
        margin: tv.isNumber(freshness.ageMs) ? budgetMs - freshness.ageMs : null,
        marginUnit: tv.MARGIN_UNIT.MILLISECONDS,
      });
    }

    const marginMs = budgetMs - freshness.ageMs;
    if (worstMarginMs === null || marginMs < worstMarginMs) worstMarginMs = marginMs;
  }

  return tv.satisfied({
    observed: { kinds, count: kinds.length },
    required: REQUIRED,
    inputSource: "SENSOR",
    margin: worstMarginMs,
    marginUnit: tv.MARGIN_UNIT.MILLISECONDS,
  });
}

module.exports = { evaluate };
