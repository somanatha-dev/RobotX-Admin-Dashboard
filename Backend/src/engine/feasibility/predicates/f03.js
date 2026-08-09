"use strict";

/**
 * **F3 — Not under operator hold or quarantine.** Class P. Indeterminate: `DENY`.
 *
 * > Human judgement outranks the optimiser; holds exist precisely to remove an agent
 * > the model still likes.
 *
 * ── "No hold" and "hold status unknown" are different inputs ────────────────
 * A hold is a *positive* assertion someone recorded, so the absence of one ordinarily
 * means there is no hold. But "the hold service was not consulted" also produces an
 * absence, and reading that as "no hold" is exactly the permissive default T2 removes:
 * it would let an outage of the operator-hold service silently re-admit every agent an
 * operator had withdrawn.
 *
 * The snapshot therefore distinguishes them explicitly, and the contract is stated
 * here because it is the only place a reader would look for it:
 *
 *   - `operatorHold === null`      — consulted, and there is no hold. `SATISFIED`.
 *   - `operatorHold === undefined` — not established. `INDETERMINATE`.
 *   - `operatorHold` object with `held: true` — `VIOLATED`.
 *
 * §7.5 names *quarantine* in this predicate as well as in F2's lifecycle state,
 * because the two are different mechanisms that produce the same operator intent: F2
 * catches the lifecycle transition, F3 catches a quarantine flag raised against an
 * otherwise-`ACTIVE` agent (§16.4's automatic health quarantine, which sets the flag
 * before the lifecycle write lands).
 *
 * Tier 0 (T0-01).
 */

const tv = require("../threeValued");
const { LIFECYCLE_STATES } = require("../../domain/agent");

const REQUIRED = "no operator hold and no quarantine";

/**
 * @param {object} context `{ agentSnapshot, mission, plan, config }`
 * @returns {object} a `threeValued` predicate result
 */
function evaluate(context) {
  const agent = (context && context.agentSnapshot) || null;

  if (!agent) return tv.absent("the agent snapshot", { required: REQUIRED });

  if (agent.lifecycleState === LIFECYCLE_STATES.QUARANTINED.name) {
    return tv.violated({
      observed: { quarantined: true },
      required: REQUIRED,
      inputSource: "CONTROL_PLANE",
      reason: "the agent is quarantined — withdrawn from assignment by health tiering or by an operator (§16.4)",
    });
  }

  if (agent.quarantined === true) {
    return tv.violated({
      observed: { quarantined: true },
      required: REQUIRED,
      inputSource: "CONTROL_PLANE",
      reason:
        "a quarantine flag is raised against this agent. §16.4's automatic quarantine sets the flag " +
        "before the lifecycle write lands, so F2 alone would admit the agent in that window",
    });
  }

  const hold = agent.operatorHold;

  if (hold === undefined) {
    return tv.absent("the agent's operator-hold status", {
      required: REQUIRED,
      inputSource: "OPERATOR",
      // Spelled out because this is the case that would otherwise be read as "no hold".
      // Human judgement outranks the optimiser, and an unconsulted hold service is not
      // evidence that no human made a judgement.
    });
  }

  if (hold !== null && hold.held === true) {
    return tv.violated({
      observed: {
        held: true,
        reason: hold.reason === undefined ? null : hold.reason,
        by: hold.by === undefined ? null : hold.by,
      },
      required: REQUIRED,
      inputSource: "OPERATOR",
      reason: `an operator hold is in force${hold.reason ? `: ${hold.reason}` : ""} (§7.5 F3)`,
    });
  }

  return tv.satisfied({ observed: { held: false, quarantined: false }, required: REQUIRED, inputSource: "OPERATOR" });
}

module.exports = { evaluate };
