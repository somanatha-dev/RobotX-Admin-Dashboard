"use strict";

/**
 * **F1 — Agent exists and is commissioned.** Class I. Indeterminate: `DENY`.
 *
 * > An uncommissioned agent has no validated configuration, so no other predicate's
 * > inputs are trustworthy.
 *
 * That rationale is why F1 is first in §7.5's evaluation order: it is not merely the
 * cheapest check, it is the one that licenses every later predicate to trust the
 * snapshot it reads.
 *
 * ── Absent record versus recorded "not commissioned" ────────────────────────
 * The two are reported differently even though both deny under class I:
 *
 *   - `commissioning.commissioned === false` — the control plane has a record and it
 *     says no. `VIOLATED`: a fact about this agent.
 *   - no commissioning record at all — nothing establishes that the agent was ever
 *     validated. `INDETERMINATE`, per §2.3's rule that absence is never evidence of
 *     lack, and per T2's that it is never permission either.
 *
 * The distinction is not cosmetic. §7.4 counts only candidates rejected *solely* for
 * indeterminacy, so classifying a missing commissioning record as `VIOLATED` would
 * hide a control-plane outage from the systemic guard — which is precisely the class
 * of infrastructure fault the guard exists to detect.
 *
 * Tier 0 (T0-01).
 */

const tv = require("../threeValued");

const REQUIRED = "a validated commissioning record";

/**
 * @param {object} context `{ agentSnapshot, mission, plan, config }`
 * @returns {object} a `threeValued` predicate result
 */
function evaluate(context) {
  const agent = context && context.agentSnapshot;

  if (!agent || typeof agent !== "object") {
    return tv.absent("the agent snapshot", { required: REQUIRED });
  }

  if (typeof agent.agentId !== "string" || agent.agentId.length === 0) {
    // A snapshot with no identity cannot be reasoned about at all: every cache key,
    // every commitment, and every rejection tuple is keyed on it.
    return tv.indeterminate({
      observed: null,
      required: REQUIRED,
      reason: "the agent snapshot carries no agentId; no predicate's inputs can be attributed",
    });
  }

  const record = agent.commissioning;

  if (record === undefined) {
    return tv.absent("the agent's commissioning record", {
      required: REQUIRED,
      inputSource: "CONTROL_PLANE",
    });
  }

  if (record === null || record.commissioned !== true) {
    return tv.violated({
      observed: record === null ? "no commissioning record" : { commissioned: record.commissioned === true },
      required: REQUIRED,
      inputSource: "CONTROL_PLANE",
      reason:
        "the commissioning record does not attest a commissioned agent. An uncommissioned agent " +
        "has no validated configuration, so no other predicate's inputs are trustworthy (§7.5 F1)",
    });
  }

  return tv.satisfied({
    observed: { commissioned: true, recordId: record.recordId === undefined ? null : record.recordId },
    required: REQUIRED,
    inputSource: "CONTROL_PLANE",
  });
}

module.exports = { evaluate };
