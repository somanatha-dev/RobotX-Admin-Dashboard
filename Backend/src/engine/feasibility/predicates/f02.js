"use strict";

/**
 * **F2 — Lifecycle state is `active`.** Class P. Indeterminate: `DENY`.
 *
 * > Quarantined, in-maintenance, or decommissioned agents are administratively
 * > withdrawn.
 *
 * The eligibility question is answered by `domain/agent.js`'s lifecycle table rather
 * than by a comparison written here, because §2.1 states which states are eligible and
 * a second copy of that judgement is a second place for it to drift.
 *
 * ── Why an unrecognised state is `INDETERMINATE`, not `VIOLATED` ────────────
 * `lifecycleOf()` throws on an unknown state — "an unrecognised lifecycle state is
 * never treated as in-service". Here that throw is converted into `INDETERMINATE`
 * rather than allowed to escape: a predicate that throws takes the whole round down,
 * and §7.3 already has a value that means "could not be evaluated". Under class P's
 * declared `DENY` the candidate is rejected either way, so the conversion loses no
 * strictness and gains a rejection tuple an operator can read.
 *
 * Tier 0 (T0-01).
 */

const tv = require("../threeValued");
const { LIFECYCLE_STATES, isLifecycleState, isLifecycleEligible } = require("../../domain/agent");

const REQUIRED = "ACTIVE";

/**
 * @param {object} context `{ agentSnapshot, mission, plan, config }`
 * @returns {object} a `threeValued` predicate result
 */
function evaluate(context) {
  const agent = (context && context.agentSnapshot) || null;
  const state = agent && agent.lifecycleState;

  if (state === undefined || state === null) {
    return tv.absent("the agent's lifecycle state", { required: REQUIRED, inputSource: "CONTROL_PLANE" });
  }

  if (!isLifecycleState(state)) {
    return tv.indeterminate({
      observed: String(state),
      required: REQUIRED,
      inputSource: "CONTROL_PLANE",
      reason:
        `lifecycle state "${String(state)}" is not one of §2.1's five states. An unrecognised ` +
        "lifecycle state is never treated as in-service",
    });
  }

  if (!isLifecycleEligible(state)) {
    return tv.violated({
      observed: state,
      required: REQUIRED,
      inputSource: "CONTROL_PLANE",
      reason: `${state} — ${LIFECYCLE_STATES[state].meaning}; administratively withdrawn (§7.5 F2)`,
    });
  }

  return tv.satisfied({ observed: state, required: REQUIRED, inputSource: "CONTROL_PLANE" });
}

module.exports = { evaluate };
