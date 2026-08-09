"use strict";

/**
 * **F28 — Route uses only road/surface classes the MobilityModel permits.** Class I.
 * Indeterminate: `DENY`.
 *
 * > A sidewalk robot must not be routed onto a carriageway; **enforced by routing with
 * > the agent's profile rather than by post-hoc checking**.
 *
 * ── This predicate is a backstop, and says so ───────────────────────────────
 * §7.5's rationale states where the enforcement actually lives: the Routing Service is
 * queried *with* a MobilityModel reference (§2.2), so a compliant route is the only
 * kind the router should return. F28 exists because "should" is not a guarantee — a
 * cached route computed under a different profile, a router fallback, or a profile
 * whose permission set changed after the cache was filled all produce a route the
 * router would not generate today.
 *
 * The predicate therefore checks two things, and the second is the one that catches
 * the interesting failure:
 *
 *   1. every surface class in the route is in the model's permitted set, **and**
 *   2. the route was computed under *this agent's* routing profile.
 *
 * Check 2 uses `mobilityModel.routingProfileKey()` — the key Phase 2 defined for
 * exactly this purpose, noting that "a cache keyed on a profile invented later would
 * have to be rebuilt". A route whose profile key does not match is `INDETERMINATE`:
 * its surface classes may well be fine, but they were selected against different
 * constraints and this predicate cannot certify them.
 *
 * ── The loaded/unloaded distinction matters here ───────────────────────────
 * §15.5: mass and centre of gravity limit traversable inclines, which makes load a
 * *routing* constraint. `routingProfileKey` takes `loaded` for that reason, and the
 * plan states which it was routed as.
 *
 * Tier 0 (T0-01, T0-04).
 */

const tv = require("../threeValued");
const { routingProfileKey } = require("../../domain/mobilityModel");

const REQUIRED = "every route surface class permitted by the agent's MobilityModel";

/**
 * @param {object} context `{ agentSnapshot, mission, plan, config }`
 * @returns {object} a `threeValued` predicate result
 */
function evaluate(context) {
  const agent = (context && context.agentSnapshot) || null;
  const plan = (context && context.plan) || null;

  if (!agent) return tv.absent("the agent snapshot", { required: REQUIRED });
  if (!plan) return tv.absent("the candidate plan", { required: REQUIRED });

  const model = agent.mobilityModel;
  if (model === undefined || model === null) {
    return tv.absent("the agent's MobilityModel", { required: REQUIRED, inputSource: "CONTROL_PLANE" });
  }

  const permitted = model.permissionSet && model.permissionSet.surfaceClasses;
  if (permitted === undefined || permitted === null || !Array.isArray(permitted)) {
    return tv.absent("the MobilityModel's permitted surface classes", {
      required: REQUIRED,
      inputSource: "CONTROL_PLANE",
      reason:
        "the model declares no enumerated surface-class permission set. §2.2 requires all six " +
        "elements to be declared; an absent one is a gap, not a permissive default",
    });
  }

  const route = plan.route;
  if (!route) {
    return tv.absent("the plan's route", { required: REQUIRED, inputSource: "ROUTING" });
  }

  // ── Check 2, first: was this route computed for this agent's profile? ─────
  const expectedProfile = routingProfileKey(model, { loaded: route.loaded === true });
  if (route.profileKey === undefined || route.profileKey === null) {
    return tv.absent("the route's routing-profile key", {
      required: { profileKey: expectedProfile },
      inputSource: "ROUTING",
    });
  }
  if (route.profileKey !== expectedProfile) {
    return tv.indeterminate({
      observed: { profileKey: route.profileKey },
      required: { profileKey: expectedProfile },
      inputSource: "ROUTING",
      reason:
        `the route was computed under profile "${route.profileKey}" but this agent's profile is ` +
        `"${expectedProfile}". Its surface classes were selected against different constraints, so ` +
        "this predicate cannot certify them (§2.2, §7.5 F28)",
    });
  }

  // ── Check 1: the surface classes themselves ───────────────────────────────
  const used = route.surfaceClasses;
  if (used === undefined) {
    return tv.absent("the route's surface-class list", { required: REQUIRED, inputSource: "ROUTING" });
  }
  if (used === null || !Array.isArray(used)) {
    return tv.indeterminate({
      required: REQUIRED,
      inputSource: "ROUTING",
      reason: "the route's surface-class list is unreadable",
    });
  }

  const permittedSet = new Set(permitted);
  const forbidden = used.filter((surfaceClass) => !permittedSet.has(surfaceClass));

  if (forbidden.length > 0) {
    return tv.violated({
      observed: { forbiddenSurfaceClasses: forbidden, surfaceClassesUsed: used.length },
      required: { permitted },
      inputSource: "ROUTING",
      margin: -forbidden.length,
      marginUnit: tv.MARGIN_UNIT.COUNT,
      reason:
        `the route uses surface class(es) the MobilityModel does not permit (${forbidden.join(", ")}). ` +
        "A sidewalk robot must not be routed onto a carriageway (§7.5 F28)",
    });
  }

  return tv.satisfied({
    observed: { surfaceClassesUsed: used.length, profileKey: route.profileKey },
    required: { permitted },
    inputSource: "ROUTING",
  });
}

module.exports = { evaluate };
