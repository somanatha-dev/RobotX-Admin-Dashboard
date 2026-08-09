"use strict";

/**
 * **F12 — No safety-relevant recall or advisory outstanding against this agent
 * class.** Class R. Indeterminate: `DENY`.
 *
 * > Fleet-wide grounding must be enforceable in one action.
 *
 * That sentence is a requirement about *latency and blast radius*, not about the
 * check itself. When a manufacturer issues a safety recall against a hardware
 * revision, the fleet operator must be able to ground every affected agent by
 * recording one fact — not by editing per-agent rows, and certainly not by waiting for
 * a config rollout to reach each shard. The predicate is therefore keyed on the
 * **class**, and the input is a list of outstanding advisories rather than a
 * per-agent flag.
 *
 * ── Scope matching ──────────────────────────────────────────────────────────
 * An advisory names what it applies to. Three scopes, checked in order of breadth, so
 * that one recorded fact can ground a whole hardware revision:
 *
 *   - `agentClassId`      — every agent of the class
 *   - `hardwareRevision`  — every agent of that revision within the class
 *   - `agentIds`          — an enumerated subset
 *
 * An advisory whose scope cannot be read is treated as **applying**. A recall the
 * engine cannot interpret is not a recall it may ignore: class R is never overridable
 * operationally, and misreading a grounding order as inapplicable is the failure this
 * predicate exists to prevent.
 *
 * ── Only safety-relevant advisories gate ────────────────────────────────────
 * §7.5 says *safety-relevant*. Commercial or documentation advisories are recorded
 * against the same class and do not bar work; `safetyRelevant === true` is required
 * to gate, and an advisory that does not say is treated as safety-relevant for the
 * same reason its unreadable scope is.
 *
 * Tier 0 (T0-01).
 */

const tv = require("../threeValued");

const REQUIRED = "no outstanding safety-relevant recall or advisory";

/**
 * Does this advisory apply to this agent?
 *
 * @param {object} advisory
 * @param {object} agent
 * @returns {boolean}
 */
function applies(advisory, agent) {
  if (Array.isArray(advisory.agentIds)) return advisory.agentIds.includes(agent.agentId);
  if (advisory.hardwareRevision !== undefined && advisory.hardwareRevision !== null) {
    return advisory.hardwareRevision === agent.hardwareRevision;
  }
  if (advisory.agentClassId !== undefined && advisory.agentClassId !== null) {
    return advisory.agentClassId === agent.agentClassId;
  }
  // Unreadable scope. A grounding order the engine cannot interpret is not one it may
  // ignore (§7.2: class R is never overridable operationally).
  return true;
}

/**
 * @param {object} context `{ agentSnapshot, mission, plan, config }`
 * @returns {object} a `threeValued` predicate result
 */
function evaluate(context) {
  const agent = (context && context.agentSnapshot) || null;
  if (!agent) return tv.absent("the agent snapshot", { required: REQUIRED });

  const advisories = agent.advisories;
  if (advisories === undefined) {
    return tv.absent("the outstanding-advisory list", { required: REQUIRED, inputSource: "CONTROL_PLANE" });
  }

  if (advisories === null || !Array.isArray(advisories)) {
    return tv.indeterminate({
      required: REQUIRED,
      inputSource: "CONTROL_PLANE",
      reason: "the advisory list is not an enumerated list; outstanding recalls cannot be established",
    });
  }

  const outstanding = advisories.filter(
    (advisory) =>
      advisory &&
      advisory.outstanding !== false &&
      advisory.safetyRelevant !== false &&
      applies(advisory, agent),
  );

  if (outstanding.length > 0) {
    const first = outstanding[0];
    return tv.violated({
      observed: {
        advisoryId: first.advisoryId === undefined ? null : first.advisoryId,
        scope:
          Array.isArray(first.agentIds)
            ? "AGENT"
            : first.hardwareRevision
              ? "HARDWARE_REVISION"
              : first.agentClassId
                ? "AGENT_CLASS"
                : "UNREADABLE",
        outstandingCount: outstanding.length,
      },
      required: REQUIRED,
      inputSource: "CONTROL_PLANE",
      reason:
        `a safety-relevant advisory (${String(first.advisoryId)}) is outstanding against this agent ` +
        "(§7.5 F12). Fleet-wide grounding is enforceable in one action, and this is that action taking effect",
    });
  }

  return tv.satisfied({
    observed: { outstandingCount: 0, advisoriesConsidered: advisories.length },
    required: REQUIRED,
    inputSource: "CONTROL_PLANE",
  });
}

module.exports = { evaluate, applies };
