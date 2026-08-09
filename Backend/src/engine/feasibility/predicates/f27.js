"use strict";

/**
 * **F27 — Agent authorised in every zone the planned route traverses.** Class R/P,
 * governed as **R**. Indeterminate: `DENY`.
 *
 * > Authorisation is a property of the *whole route*, not of the endpoints; **a route
 * > crossing an unauthorised zone is illegal even with legal endpoints**.
 *
 * ── The endpoint fallacy ────────────────────────────────────────────────────
 * Checking origin and destination is the natural implementation and it is wrong in a
 * way that produces no visible symptom until an enforcement action. A delivery from an
 * authorised depot to an authorised address whose only viable route crosses a
 * restricted campus is not a legal mission with an unfortunate route; it is an illegal
 * mission. The predicate therefore iterates `plan.route.zonesTraversed`, which is the
 * routing result, not the pair of endpoints.
 *
 * F33 checks the endpoints — that is its whole job, as a geofence input-validation
 * rule. The two predicates are not redundant: F33 asks whether the endpoints are
 * serviceable at all, F27 asks whether *this agent* may be in every zone the route
 * passes through.
 *
 * ── An unenumerated route is not an empty one ───────────────────────────────
 * A plan with no traversed-zone list is `INDETERMINATE`, never satisfied. An empty
 * list would mean "this route crosses no zones", which is a claim about the world; an
 * absent list means the routing service did not say, which is a claim about the
 * snapshot.
 *
 * Tier 0 (T0-01).
 */

const tv = require("../threeValued");

const REQUIRED = "agent authorised in every zone the planned route traverses";

/**
 * @param {object} context `{ agentSnapshot, mission, plan, config }`
 * @returns {object} a `threeValued` predicate result
 */
function evaluate(context) {
  const agent = (context && context.agentSnapshot) || null;
  const plan = (context && context.plan) || null;

  if (!agent) return tv.absent("the agent snapshot", { required: REQUIRED });
  if (!plan) return tv.absent("the candidate plan", { required: REQUIRED });

  const authorised = agent.authorisedZoneIds;
  if (authorised === undefined) {
    return tv.absent("the agent's zone authorisation set", { required: REQUIRED, inputSource: "CONTROL_PLANE" });
  }
  if (authorised === null || !Array.isArray(authorised)) {
    return tv.indeterminate({
      required: REQUIRED,
      inputSource: "CONTROL_PLANE",
      reason: "the agent's zone authorisation set is not an enumerated list; authorisation cannot be established",
    });
  }

  const traversed = plan.route && plan.route.zonesTraversed;
  if (traversed === undefined) {
    return tv.absent("the route's traversed-zone list", {
      required: REQUIRED,
      inputSource: "ROUTING",
      reason:
        "the plan states no traversed-zone list. An absent list is a claim about the snapshot, not " +
        "about the world: checking the endpoints instead is the fallacy §7.5 F27 exists to remove",
    });
  }
  if (traversed === null || !Array.isArray(traversed)) {
    return tv.indeterminate({
      required: REQUIRED,
      inputSource: "ROUTING",
      reason: "the route's traversed-zone list is unreadable",
    });
  }

  const authorisedSet = new Set(authorised);
  const unauthorised = traversed.filter((zoneId) => !authorisedSet.has(zoneId));

  if (unauthorised.length > 0) {
    return tv.violated({
      observed: { unauthorisedZones: unauthorised, zonesTraversed: traversed.length },
      required: REQUIRED,
      inputSource: "ROUTING",
      margin: -unauthorised.length,
      marginUnit: tv.MARGIN_UNIT.COUNT,
      reason:
        `the route traverses ${unauthorised.length} zone(s) this agent is not authorised in ` +
        `(${unauthorised.join(", ")}). A route crossing an unauthorised zone is illegal even with ` +
        "legal endpoints (§7.5 F27)",
    });
  }

  return tv.satisfied({
    observed: { zonesTraversed: traversed.length },
    required: REQUIRED,
    inputSource: "ROUTING",
  });
}

module.exports = { evaluate };
