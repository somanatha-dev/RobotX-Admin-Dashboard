"use strict";

/**
 * **F35 — Charger reachable from the projected mission end with reserve intact.**
 * Class I. Indeterminate: `DENY`.
 *
 * > Prevents the "completed the delivery, stranded afterwards" failure, **which a
 * > mission-only energy check permits**.
 *
 * ── Why F34 does not already cover this ─────────────────────────────────────
 * F34 bounds the probability that the mission itself exhausts its reserves. It is
 * entirely possible to satisfy every tier of F34 and finish the mission in a place
 * from which no charger is reachable — a cul-de-sac at the edge of the service area,
 * a site whose only charger is occupied for the next hour. The mission succeeds and
 * the agent is stranded, which is a recovery callout rather than a delivery failure
 * and is invisible to any check that stops at the last drop.
 *
 * ── The availability circularity, and how §14.5 breaks it ───────────────────
 * "Reachable" means the nearest charger *available or reservable at the projected
 * arrival time*, not the nearest one geographically — a charger with a 25-minute queue
 * is not a viable reserve destination. That definition is circular: charger
 * availability depends on other agents' plans, which depend on this round's output.
 *
 * §14.5 breaks it by construction rather than iteration, and this predicate depends on
 * that resolution rather than re-deriving it: the **previous completed round's**
 * charger availability projection is pinned into this round's snapshot by version, so
 * the reachability verdict is deterministic and replayable (T6, ADR 21). This module
 * therefore requires the projection version to be present on the verdict it consumes —
 * a reachability answer that cannot name the projection it was computed against cannot
 * be replayed, and §20.3 item 3 keys the reachability cache on that version for the
 * same reason.
 *
 * ── Degradation is defined, and is not this predicate's to invent ───────────
 * > If the projection is unavailable or stale beyond
 * > `energy.charger_projection_max_age`, the engine falls back to *depot-only* return
 * > targets … and applies `energy.uncalibrated_reserve_factor`.
 *
 * That fallback is `engine/energy/eReturn.js`'s (Phase 7). What arrives here is a
 * verdict that states which basis it used, so the rejection tuple records whether the
 * fleet was reasoning from a live projection or from depot-only targets — a
 * distinction an operator reading a spike in F35 rejections needs immediately.
 *
 * ── A feasibility reserve, not a booking ────────────────────────────────────
 * > The engine does not reserve the charger it plans against. `E_return` is a
 * > *feasibility reserve*, not a booking.
 *
 * So a `SATISFIED` here asserts that a viable destination exists, not that one is
 * held. Actual reservations remain the Charging Scheduler's to grant (§14.7).
 *
 * On the volatile subset (§10.3.2 step 3).
 *
 * Tier 0 (T0-01, T0-03). Invariant I17.
 */

const tv = require("../threeValued");

/**
 * The bases §14.5 permits a reachability verdict to be computed against.
 * @structural the specification's own reachability bases
 */
const BASIS = Object.freeze({
  PINNED_PROJECTION: "PINNED_PROJECTION",
  DEPOT_ONLY: "DEPOT_ONLY",
});

const REQUIRED = "a charger reachable from the projected mission end with E_return intact";

/**
 * @param {object} context `{ agentSnapshot, mission, plan, config }`
 * @returns {object} a `threeValued` predicate result
 */
function evaluate(context) {
  const plan = (context && context.plan) || null;
  if (!plan) return tv.absent("the candidate plan", { required: REQUIRED });

  const energy = plan.energy;
  if (energy === undefined || energy === null || typeof energy !== "object") {
    return tv.absent("the plan's energy projection", { required: REQUIRED, inputSource: "PLAN" });
  }

  const reach = energy.chargerReachability;
  if (reach === undefined) {
    return tv.absent("the plan's charger-reachability verdict (§14.5)", {
      required: REQUIRED,
      inputSource: "PLAN",
      reason:
        "no reachability verdict is attached to this plan. Computing it is engine/energy/eReturn.js " +
        "with engine/routing/chargerReachabilityCache.js (Phase 7); a mission-only energy check " +
        "permits the completed-the-delivery-then-stranded failure this predicate exists to prevent",
    });
  }
  if (reach === null || typeof reach !== "object") {
    return tv.indeterminate({
      required: REQUIRED,
      inputSource: "PLAN",
      reason: "the charger-reachability verdict is unreadable",
    });
  }

  // Replayability: a verdict that cannot name the projection it was computed against
  // cannot be replayed, and §20.3 item 3 keys the reachability cache on that version.
  if (reach.basis === BASIS.PINNED_PROJECTION && (reach.projectionVersion === undefined || reach.projectionVersion === null)) {
    return tv.indeterminate({
      observed: { basis: reach.basis },
      required: REQUIRED,
      inputSource: "PLAN",
      reason:
        "the reachability verdict claims a pinned projection but names no projection version. A " +
        "verdict that cannot name its projection cannot be replayed (T6, §9.6, ADR 21)",
    });
  }

  if (reach.basis !== BASIS.PINNED_PROJECTION && reach.basis !== BASIS.DEPOT_ONLY) {
    return tv.indeterminate({
      observed: { basis: reach.basis === undefined ? null : String(reach.basis) },
      required: REQUIRED,
      inputSource: "PLAN",
      reason: `reachability basis "${String(reach.basis)}" is not one of ${Object.keys(BASIS).join(", ")} (§14.5)`,
    });
  }

  if (reach.reachable === undefined || reach.reachable === null) {
    return tv.indeterminate({
      observed: { basis: reach.basis },
      required: REQUIRED,
      inputSource: "PLAN",
      reason: "the reachability verdict states no outcome",
    });
  }

  const observed = {
    basis: reach.basis,
    projectionVersion: reach.projectionVersion === undefined ? null : reach.projectionVersion,
    chargerId: reach.chargerId === undefined ? null : reach.chargerId,
    eReturnWh: tv.isNumber(reach.eReturnWh) ? reach.eReturnWh : null,
    surplusWh: tv.isNumber(reach.surplusWh) ? reach.surplusWh : null,
  };

  if (reach.reachable !== true) {
    return tv.violated({
      observed,
      required: REQUIRED,
      inputSource: "PLAN",
      margin: tv.isNumber(reach.surplusWh) ? reach.surplusWh : null,
      marginUnit: tv.MARGIN_UNIT.WATT_HOURS,
      reason:
        `no charger is reachable from the projected mission end with E_return intact (basis: ` +
        `${reach.basis}). Reachable means available or reservable at the projected arrival time, not ` +
        "nearest geographically — a charger with a long queue is not a viable reserve destination (§14.5)",
    });
  }

  return tv.satisfied({
    observed,
    required: REQUIRED,
    inputSource: "PLAN",
    margin: tv.isNumber(reach.surplusWh) ? reach.surplusWh : null,
    marginUnit: tv.MARGIN_UNIT.WATT_HOURS,
  });
}

module.exports = { evaluate, BASIS };
