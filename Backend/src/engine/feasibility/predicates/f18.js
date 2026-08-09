"use strict";

/**
 * **F18 — No conflicting reservation held by another subsystem (charging,
 * maintenance, teleop).** Class I. Indeterminate: `DENY`.
 *
 * > Prevents the classic bug where **two schedulers each believe they own the agent**.
 *
 * ── Why this is class I and not a policy preference ─────────────────────────
 * The failure it prevents is physical, not economic. If the Charging Scheduler has
 * docked an agent at 14:05 and the assignment engine commits it to a delivery at
 * 14:05, one of the two systems will issue a command the agent obeys and the other
 * will supervise a mission that is not happening. §12.4 would eventually reconcile the
 * divergence, but "eventually" is after the agent has driven off a charger mid-charge
 * or refused a dispatch it was told to accept.
 *
 * The engine does not arbitrate between the subsystems here — it *yields*. Reservation
 * ownership is the other subsystem's, and §14.7 states the direction explicitly for
 * charging: actual reservations remain the Charging Scheduler's to grant.
 *
 * ── Overlap, not equality ───────────────────────────────────────────────────
 * A reservation conflicts when its interval **overlaps** the plan's occupancy window,
 * using half-open intervals `[from, until)` so that a reservation ending exactly when
 * the plan begins does not conflict. Back-to-back is not overlapping, and treating it
 * as such would sterilise the schedule around every charging slot.
 *
 * A reservation with an **open end** (`until` absent) is treated as extending
 * indefinitely and therefore conflicting with any plan that starts after it: an
 * open-ended maintenance hold is exactly the case where assuming a short duration is
 * unsafe.
 *
 * On the volatile subset (§10.3.2 step 3): another subsystem may reserve the agent
 * during the routing window, and the re-check under the row locks is where that race
 * is resolved.
 *
 * Tier 0 (T0-01).
 */

const tv = require("../threeValued");

/**
 * The subsystems §7.5 F18 names as reservation holders.
 * @structural the specification's own subsystem labels
 */
const RESERVING_SUBSYSTEM = Object.freeze({
  CHARGING: "CHARGING",
  MAINTENANCE: "MAINTENANCE",
  TELEOP: "TELEOP",
});

const REQUIRED = "no reservation by another subsystem overlapping the plan's occupancy window";

/**
 * Do the half-open intervals `[aFrom, aUntil)` and `[bFrom, bUntil)` overlap?
 *
 * A null `aUntil` means "open ended" and overlaps everything from `aFrom` onwards.
 *
 * @param {number} aFrom
 * @param {number|null} aUntil
 * @param {number} bFrom
 * @param {number} bUntil
 * @returns {boolean}
 */
function overlaps(aFrom, aUntil, bFrom, bUntil) {
  if (aUntil === null) return bUntil > aFrom;
  return aFrom < bUntil && bFrom < aUntil;
}

/**
 * @param {object} context `{ agentSnapshot, mission, plan, config }`
 * @returns {object} a `threeValued` predicate result
 */
function evaluate(context) {
  const agent = (context && context.agentSnapshot) || null;
  const plan = (context && context.plan) || null;

  if (!agent) return tv.absent("the agent snapshot", { required: REQUIRED });
  if (!plan) return tv.absent("the candidate plan", { required: REQUIRED });

  const reservations = agent.reservations;
  if (reservations === undefined) {
    // Not "no reservations". An unconsulted reservation store is precisely how two
    // schedulers come to believe they each own the agent.
    return tv.absent("the reservation set held by other subsystems", {
      required: REQUIRED,
      inputSource: "EXTERNAL_SUBSYSTEM",
    });
  }
  if (reservations === null || !Array.isArray(reservations)) {
    return tv.indeterminate({
      required: REQUIRED,
      inputSource: "EXTERNAL_SUBSYSTEM",
      reason: "the reservation set is not an enumerated list; conflicts cannot be established",
    });
  }

  const planFromMs = tv.epochMs(plan.projectedStartMs);
  const planUntilMs = tv.epochMs(plan.projectedEndMs);

  if (planFromMs === null || planUntilMs === null) {
    return tv.absent("the plan's occupancy window", {
      required: REQUIRED,
      inputSource: "PLAN",
      reason:
        "the plan states no projected start or end, so no interval exists to test reservations " +
        "against (§7.5 F18)",
    });
  }

  let nearestGapMs = null;

  for (const reservation of reservations) {
    if (!reservation) continue;

    const fromMs = tv.epochMs(reservation.from);
    if (fromMs === null) {
      return tv.indeterminate({
        observed: { subsystem: reservation.subsystem === undefined ? null : reservation.subsystem },
        required: REQUIRED,
        inputSource: "EXTERNAL_SUBSYSTEM",
        reason:
          `a reservation held by "${String(reservation.subsystem)}" states no readable start. A ` +
          "reservation whose interval cannot be read cannot be shown not to conflict",
      });
    }

    // An open end extends indefinitely. `undefined` and `null` both mean open here:
    // an open-ended maintenance hold is exactly the case where assuming a short
    // duration is unsafe.
    const untilMs = reservation.until === undefined || reservation.until === null ? null : tv.epochMs(reservation.until);
    if (reservation.until !== undefined && reservation.until !== null && untilMs === null) {
      return tv.indeterminate({
        observed: { subsystem: reservation.subsystem === undefined ? null : reservation.subsystem },
        required: REQUIRED,
        inputSource: "EXTERNAL_SUBSYSTEM",
        reason: `a reservation held by "${String(reservation.subsystem)}" states an unreadable end`,
      });
    }

    if (overlaps(fromMs, untilMs, planFromMs, planUntilMs)) {
      return tv.violated({
        observed: {
          subsystem: reservation.subsystem === undefined ? null : reservation.subsystem,
          fromMs,
          untilMs,
        },
        required: { planFromMs, planUntilMs },
        inputSource: "EXTERNAL_SUBSYSTEM",
        reason:
          `a ${String(reservation.subsystem)} reservation overlaps the plan's occupancy window ` +
          "(§7.5 F18). Reservation ownership belongs to that subsystem, and the engine yields to it",
      });
    }

    // How much clear time separates the plan from this reservation — the near-miss
    // dimension that distinguishes "the schedule is saturated" from "there was one
    // unrelated booking".
    const gapMs = fromMs >= planUntilMs ? fromMs - planUntilMs : untilMs === null ? null : planFromMs - untilMs;
    if (gapMs !== null && (nearestGapMs === null || gapMs < nearestGapMs)) nearestGapMs = gapMs;
  }

  return tv.satisfied({
    observed: { reservationsConsidered: reservations.length, nearestGapMs },
    required: { planFromMs, planUntilMs },
    inputSource: "EXTERNAL_SUBSYSTEM",
    margin: nearestGapMs,
    marginUnit: tv.MARGIN_UNIT.MILLISECONDS,
  });
}

module.exports = { evaluate, RESERVING_SUBSYSTEM, overlaps };
