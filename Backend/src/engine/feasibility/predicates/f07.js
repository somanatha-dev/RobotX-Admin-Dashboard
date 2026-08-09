"use strict";

/**
 * **F7 — Emergency stop not engaged.** Class I. Indeterminate: `DENY`.
 *
 * > Absolute.
 *
 * §7.5's shortest rationale, and the predicate needs no more: there is no mission
 * value, no SLA, and no operator authority that admits an agent whose emergency stop
 * is engaged. Class I means never overridable *by anyone, including operators and
 * manual assignment* (§7.2).
 *
 * ── On the volatile subset ──────────────────────────────────────────────────
 * F7 is one of the eleven predicates §10.3.2 step 3 re-verifies under the row locks at
 * commit time. It has to be: an E-stop engaged during the routing window between
 * evaluation and commit is the canonical instance of the baseline defect the audit
 * records — *"validates battery and health before the reservation and never re-checks
 * them at finalisation"*.
 *
 * ── Freshness is part of the predicate ──────────────────────────────────────
 * An E-stop reading is a safety-relevant input, so §2.7's rule applies: stale beyond
 * its budget is `INDETERMINATE`, not "last known good". `f16` enforces the general
 * form of the freshness rule across every safety input; F7 enforces it for its own
 * because a predicate that trusted an arbitrarily old E-stop reading would be
 * satisfied by an agent that had stopped reporting *because* it had stopped.
 *
 * Tier 0 (T0-01).
 */

const tv = require("../threeValued");
const { FRESHNESS, assess } = require("../../domain/observation");

const REQUIRED = "emergency stop not engaged";

/**
 * @param {object} context `{ agentSnapshot, mission, plan, config, decisionTimeMs }`
 * @returns {object} a `threeValued` predicate result
 */
function evaluate(context) {
  const agent = (context && context.agentSnapshot) || null;
  const config = context && context.config;

  if (!agent) return tv.absent("the agent snapshot", { required: REQUIRED });

  const observation = agent.emergencyStop;
  if (observation === undefined || observation === null) {
    return tv.absent("the emergency-stop observation", { required: REQUIRED, inputSource: "SENSOR" });
  }

  const budgetSeconds = tv.readParameter(config, "connectivity.max_heartbeat_age");
  if (!tv.isNumber(budgetSeconds)) {
    return tv.indeterminate({
      required: REQUIRED,
      inputSource: "SENSOR",
      reason:
        "connectivity.max_heartbeat_age is unresolved, so no staleness budget can be declared for " +
        "the emergency-stop reading. §2.7 requires every consumer to declare one",
    });
  }

  const freshness = assess(observation, {
    stalenessBudgetMs: tv.secondsToMs(budgetSeconds),
    atEpochMs: context && context.decisionTimeMs,
  });

  if (freshness.freshness !== FRESHNESS.FRESH) {
    return tv.stale("the emergency-stop reading", freshness.ageMs, tv.secondsToMs(budgetSeconds), {
      observed: freshness.value === undefined ? null : freshness.value,
      required: REQUIRED,
      inputSource: "SENSOR",
    });
  }

  // The value is deliberately read as "engaged unless it says false". `true`, a
  // truthy string, and an unrecognised value all engage; only an explicit `false`
  // clears. An E-stop is the one place where an unparseable reading must not resolve
  // to "not engaged".
  const engaged = freshness.value !== false;

  if (engaged) {
    return tv.violated({
      observed: { engaged: true, value: freshness.value },
      required: REQUIRED,
      inputSource: "SENSOR",
      observationAgeMs: freshness.ageMs,
      reason: "the emergency stop is engaged. Absolute — class I admits no override (§7.2, §7.5 F7)",
    });
  }

  return tv.satisfied({
    observed: { engaged: false },
    required: REQUIRED,
    inputSource: "SENSOR",
    observationAgeMs: freshness.ageMs,
  });
}

module.exports = { evaluate };
