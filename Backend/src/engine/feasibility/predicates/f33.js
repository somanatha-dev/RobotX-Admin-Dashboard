"use strict";

/**
 * **F33 — Geofence: origin and destination inside the serviceable region.** Class C.
 * Indeterminate: `DENY`.
 *
 * > Also a hard input-validation rule at intake; **the baseline accepts any
 * > latitude/longitude, including out-of-range values**.
 *
 * ── Two checks, and the first is not about geofencing at all ────────────────
 * The rationale names a defect that is not a service-area question: the baseline
 * accepts *out-of-range* coordinates — latitudes beyond ±90, longitudes beyond ±180,
 * `NaN`, nulls. Those are not points outside the serviceable region; they are not
 * points. A geofence test against them is meaningless, and worse, a naive
 * point-in-polygon implementation will happily return `false` for a malformed
 * coordinate and produce a rejection tuple that says "outside service area" when the
 * truth is "this is not a coordinate".
 *
 * So the predicate is ordered:
 *
 *   1. **Well-formedness** — every endpoint is a readable coordinate in range.
 *      Failure is `VIOLATED` with a reason that names the malformation, because a
 *      malformed coordinate is a definite fact about the request, not missing data.
 *   2. **Containment** — every endpoint lies in the serviceable region.
 *
 * Intake applies the same rule earlier — **and since RD-2026-09-14-01 that sentence is
 * finally true.** `services/task.service.sealIdentities` evaluates the exact coordinate
 * against the published delivery-domain geometry and pins the verdict on
 * `Stop.geofenceResult`. For four phases this docstring asserted a hard input-validation
 * point that did not exist; F33 was the only place the rule was applied at all. F33's
 * presence in the gate remains deliberate redundancy: a Task that entered before the
 * producer existed, or through a path that bypasses intake, must not become assignable —
 * and such Tasks exist, carrying a null verdict, which reads here as absent and denies.
 *
 * ── What `serviceable` now means — D1's three layers ───────────────────────
 * §3.6: "**Containment is by assignment, not by geometry** — deriving a cell's zone
 * from polygon intersection at query time makes it depend on floating-point geometry
 * evaluated per round, which is both slow and non-deterministic (T6)." That still
 * governs, and this predicate still runs no point-in-polygon test.
 *
 * What changed is what the assignment it reads *is*. `coordinatorSolvePath.serviceabilityFor`
 * now composes three facts rather than one:
 *
 *     serviceable = assigned ∧ inDeliveryDomain ∧ routable
 *
 * — the published cell assignment (an **index** fact), the pinned exact-coordinate
 * geofence verdict (a **domain** fact), and reachability of the routing graph (R13, an
 * unresolved external input). The distinction matters here because a cell being indexed
 * has never implied that its ground is inside the delivery domain, and this predicate
 * used to be handed a value that quietly conflated them.
 *
 * The three-valued reading below is unchanged and is what makes the composition safe:
 * `true` satisfies, `false` is VIOLATED, and **absent is INDETERMINATE** — so a
 * conjunction with an absent term denies while naming the absence, rather than resolving
 * it in either direction.
 *
 * Tier 0 (T0-01).
 */

const tv = require("../threeValued");

/** @structural the WGS-84 latitude bound in degrees */
const MAX_ABS_LATITUDE = 90;
/** @structural the WGS-84 longitude bound in degrees */
const MAX_ABS_LONGITUDE = 180;

const REQUIRED = "every endpoint a well-formed coordinate inside the serviceable region";

/**
 * @param {object} endpoint
 * @returns {string|null} the malformation, or null when well-formed
 */
function malformation(endpoint) {
  if (!endpoint || typeof endpoint !== "object") return "the endpoint is not an object";
  if (!tv.isNumber(endpoint.lat)) return "latitude is not a finite number";
  if (!tv.isNumber(endpoint.lon)) return "longitude is not a finite number";
  if (Math.abs(endpoint.lat) > MAX_ABS_LATITUDE) return `latitude ${endpoint.lat} is outside +/-${MAX_ABS_LATITUDE}`;
  if (Math.abs(endpoint.lon) > MAX_ABS_LONGITUDE) return `longitude ${endpoint.lon} is outside +/-${MAX_ABS_LONGITUDE}`;
  return null;
}

/**
 * @param {object} context `{ agentSnapshot, mission, plan, config }`
 * @returns {object} a `threeValued` predicate result
 */
function evaluate(context) {
  const plan = (context && context.plan) || null;
  if (!plan) return tv.absent("the candidate plan", { required: REQUIRED });

  const stops = plan.stops;
  if (stops === undefined) {
    return tv.absent("the plan's stops", { required: REQUIRED, inputSource: "PLAN" });
  }
  if (stops === null || !Array.isArray(stops) || stops.length === 0) {
    return tv.indeterminate({
      required: REQUIRED,
      inputSource: "PLAN",
      reason: "the plan states no stops; there are no endpoints to test",
    });
  }

  // ── 1. Well-formedness ────────────────────────────────────────────────────
  for (const stop of stops) {
    const problem = malformation(stop);
    if (problem !== null) {
      return tv.violated({
        observed: {
          stopSequence: stop && stop.sequence !== undefined ? stop.sequence : null,
          lat: stop ? stop.lat : null,
          lon: stop ? stop.lon : null,
        },
        required: REQUIRED,
        inputSource: "CONTROL_PLANE",
        reason:
          `stop ${String(stop && stop.sequence)} carries a malformed coordinate: ${problem}. This is ` +
          "a definite fact about the request, not missing data — the baseline accepts any " +
          "latitude/longitude including out-of-range values (§7.5 F33)",
      });
    }
  }

  // ── 2. Containment, by assignment ─────────────────────────────────────────
  for (const stop of stops) {
    if (stop.serviceable === undefined) {
      return tv.absent(`the serviceability assignment for stop ${String(stop.sequence)}`, {
        observed: { lat: stop.lat, lon: stop.lon },
        required: REQUIRED,
        inputSource: "MAP",
        reason:
          "containment is by assignment, not geometry (§3.6); an unassigned cell is not an " +
          "out-of-area one, and running a point-in-polygon test here would be non-deterministic (T6)",
      });
    }
    if (stop.serviceable !== true) {
      return tv.violated({
        observed: { stopSequence: stop.sequence === undefined ? null : stop.sequence, lat: stop.lat, lon: stop.lon },
        required: REQUIRED,
        inputSource: "MAP",
        reason: `stop ${String(stop.sequence)} lies outside the serviceable region (§7.5 F33)`,
      });
    }
  }

  return tv.satisfied({
    observed: { endpointsChecked: stops.length },
    required: REQUIRED,
    inputSource: "MAP",
  });
}

module.exports = { evaluate, malformation, MAX_ABS_LATITUDE, MAX_ABS_LONGITUDE };
