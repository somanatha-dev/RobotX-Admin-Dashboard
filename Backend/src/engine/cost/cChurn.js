"use strict";

/**
 * `C_churn` — hysteresis for the rolling horizon (§8.9). **Tier 2**, mechanism T2-07,
 * kill switch `churn_pricing`.
 *
 * > Re-optimising every round with fresh forecasts will revise SOFT reservations
 * > continuously as estimates jitter, and an agent that is re-planned every 500 ms never
 * > departs. The churn term prevents this without forbidding revision. It is charged **per
 * > column**, against whatever the column displaces:
 *
 * ```
 * C_churn(c) = 1[ c displaces an existing reservation or commitment ]
 *            · ( churn.base_cost
 *              + churn.per_second_elapsed · time_since_reservation
 *              + churn.wasted_travel_cost · distance_already_travelled
 *              + churn.notification_cost )
 * ```
 *
 * ── Why one expression prices two very different events ────────────────────
 * > - **Revising a SOFT reservation** costs computation and plan instability only. Nothing
 * >   was dispatched, no agent was told anything, nothing durable is rewritten (§2.6), and
 * >   `distance_already_travelled` is zero. Early revisions are consequently cheap, which
 * >   is what makes late binding worth having.
 * > - **Revising a HARD commitment** additionally requires the reassignment protocol
 * >   (§4.7): a fence advance, a recall command, a cooloff, and possibly wasted travel.
 * >   This is priced by the same expression evaluated at a much larger elapsed time and
 * >   non-zero travel — and it is **additionally gated by the protocol, which the optimiser
 * >   cannot bypass by paying the term.**
 *
 * That last clause is the one worth guarding, and `assertProtocolNotBypassed()` is the
 * guard. A HARD displacement priced here is still subject to §4.7's fence advance, recall,
 * and cooloff, and to F20's incumbent exclusions. The term is the *price* of a permitted
 * revision, never the *permission* — a distinction that disappears quietly if a caller
 * ever treats "I paid the churn cost" as sufficient.
 *
 * ── The term is charged per column, not per plan ───────────────────────────
 * `Φ` is a functional over plans and carries no churn term at all (§8.1); the column price
 * is `γ(c) = Φ(plan(c)) − Φ(plan₀(a(c))) + C_churn(c)`. So this module is called by
 * `plan/column.js` and never by `phi.js`, and it is registered into the column price
 * through the Tier 2 registration surface rather than statically imported, because
 * `column.js` is Tier 1 and a kill switch whose mechanism is statically linked into the
 * Tier 1 path is not a control (§1.8 rule 2, §22.5 rule 1).
 *
 * ── The knob is exposed, as §8.9 requires ──────────────────────────────────
 * > `churn.base_cost` is also the knob that tunes the plan-stability versus plan-quality
 * > trade-off, and it **MUST be exposed as such rather than buried**.
 *
 * It is a register entry with that sentence in its description, and the breakdown reports
 * it separately from the three quantities that scale with elapsed progress, so an operator
 * asking "why is this fleet not re-planning" can see which addend dominates.
 *
 * Determinism: `time_since_reservation` is measured against the round's pinned decision
 * time, never a clock.
 */

const { cu, milli, ZERO, total } = require("./units");
const { apply } = require("./exchangeRates");
const signDiscipline = require("./signDiscipline");

/** @structural milliseconds in one second */
const MS_PER_SECOND = 1000;

/** What a column displaces. §2.6 admits exactly these two and no third. */
const DISPLACEMENT = Object.freeze({
  /** Round-local coordinator state; nothing durable, nothing dispatched. */
  SOFT_RESERVATION: "SOFT_RESERVATION",
  /** A durable contract; §4.7's reassignment protocol applies. */
  HARD_COMMITMENT: "HARD_COMMITMENT",
  /** The column displaces nothing — the indicator is zero and so is the term. */
  NONE: "NONE",
});

/** §8.9's four addends. */
const COMPONENT = Object.freeze({
  BASE: "base",
  ELAPSED: "elapsed",
  WASTED_TRAVEL: "wastedTravel",
  NOTIFICATION: "notification",
});

/**
 * @param {*} value
 * @returns {boolean}
 */
function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Refuse to let the churn price stand in for the reassignment protocol.
 *
 * @param {object} displacement `{ kind, protocolSatisfied }`
 * @returns {{ ok: boolean, reason: string|null }}
 */
function assertProtocolNotBypassed(displacement) {
  const source = displacement || {};
  if (source.kind !== DISPLACEMENT.HARD_COMMITMENT) return { ok: true, reason: null };
  if (source.protocolSatisfied === true) return { ok: true, reason: null };
  return {
    ok: false,
    reason:
      "displacing a HARD commitment is gated by §4.7's reassignment protocol — a fence advance, a " +
      "recall command, and a cooloff — which the optimiser cannot bypass by paying C_churn. The term " +
      "prices a permitted revision; it does not grant permission (§8.9).",
  };
}

/**
 * `C_churn(c)` for one column.
 *
 * @param {object} input
 * @param {object} input.displacement `{ kind, protocolSatisfied }`
 * @param {number} input.reservedAtMs when the displaced reservation or commitment was made
 * @param {number} input.decisionTimeMs the round's pinned time
 * @param {number} input.distanceAlreadyTravelledM progress made against the displaced work
 * @param {number} input.baseCostCu `churn.base_cost`
 * @param {object} input.perSecondRate a `makeRate("churn.per_second_elapsed", …)`
 * @param {object} input.wastedTravelRate a `makeRate("churn.wasted_travel_cost", …)`
 * @param {number} input.notificationCostCu `churn.notification_cost`
 * @returns {{ ok: boolean, milliCU: bigint|null, breakdown: object|null,
 *             signCheck: object|null, missing: string[], problems: string[] }}
 */
function evaluate(input) {
  const source = input || {};
  const kind = (source.displacement && source.displacement.kind) || DISPLACEMENT.NONE;

  if (kind === DISPLACEMENT.NONE) {
    // The indicator is zero. Reported as an evaluated zero rather than as an absent term,
    // so a decision record can distinguish "displaced nothing" from "churn pricing off".
    return {
      ok: true,
      milliCU: 0n,
      breakdown: Object.freeze({ displacementKind: kind, indicator: 0, milliCU: 0n }),
      signCheck: signDiscipline.check("C_churn", 0n),
      missing: [],
      problems: [],
    };
  }

  const gate = assertProtocolNotBypassed(source.displacement);
  if (!gate.ok) {
    return { ok: false, milliCU: null, breakdown: null, signCheck: null, missing: [], problems: [gate.reason] };
  }

  const missing = [];
  if (!isNumber(source.reservedAtMs)) missing.push("reservedAtMs");
  if (!isNumber(source.decisionTimeMs)) missing.push("decisionTimeMs");
  if (!isNumber(source.distanceAlreadyTravelledM) || source.distanceAlreadyTravelledM < 0) {
    missing.push("distanceAlreadyTravelledM");
  }
  if (!isNumber(source.baseCostCu) || source.baseCostCu < 0) missing.push("churn.base_cost");
  if (!source.perSecondRate || typeof source.perSecondRate.value !== "number") {
    missing.push("churn.per_second_elapsed");
  }
  if (!source.wastedTravelRate || typeof source.wastedTravelRate.value !== "number") {
    missing.push("churn.wasted_travel_cost");
  }
  if (!isNumber(source.notificationCostCu) || source.notificationCostCu < 0) {
    missing.push("churn.notification_cost");
  }
  if (missing.length > 0) {
    return { ok: false, milliCU: null, breakdown: null, signCheck: null, missing, problems: [] };
  }

  const elapsedSeconds = Math.max(0, (source.decisionTimeMs - source.reservedAtMs) / MS_PER_SECOND);

  const base = cu(source.baseCostCu);
  const elapsed = apply(source.perSecondRate, elapsedSeconds, "s");
  const wastedTravel = apply(source.wastedTravelRate, source.distanceAlreadyTravelledM, "m");
  const notification = cu(source.notificationCostCu);

  const summed = total(base, elapsed, wastedTravel, notification);
  const signCheck = signDiscipline.check("C_churn", summed.milliCU);

  return {
    ok: true,
    milliCU: summed.milliCU,
    breakdown: Object.freeze({
      displacementKind: kind,
      indicator: 1,
      [COMPONENT.BASE]: Object.freeze({
        cu: source.baseCostCu,
        milliCU: base.milliCU,
        note: "the exposed plan-stability versus plan-quality knob (§8.9)",
      }),
      [COMPONENT.ELAPSED]: Object.freeze({ seconds: elapsedSeconds, milliCU: elapsed.milliCU }),
      [COMPONENT.WASTED_TRAVEL]: Object.freeze({
        distanceM: source.distanceAlreadyTravelledM,
        milliCU: wastedTravel.milliCU,
      }),
      [COMPONENT.NOTIFICATION]: Object.freeze({ cu: source.notificationCostCu, milliCU: notification.milliCU }),
      milliCU: summed.milliCU,
    }),
    signCheck,
    missing: [],
    problems: signCheck.ok ? [] : [signCheck.finding],
  };
}

/**
 * The disabled behaviour §22.5 rule 1 requires this mechanism to degrade to.
 *
 * > Reassignment priced without a churn term.
 *
 * Exposed as a named function rather than left implicit, so the degraded path is a tested
 * behaviour rather than an absence. It returns an evaluated zero with the reason attached,
 * which is what lets a decision record explain a revision that happened *because* the
 * switch was thrown.
 *
 * @returns {{ ok: boolean, milliCU: bigint, breakdown: object }}
 */
function degraded() {
  return {
    ok: true,
    milliCU: ZERO.milliCU,
    breakdown: Object.freeze({
      milliCU: ZERO.milliCU,
      killSwitch: "churn_pricing",
      degradesTo: "reassignment priced without a churn term (§22.5 rule 1)",
      consequence:
        "revision is then bounded only by §4.7's protocol and F20's incumbent cooloff, not by price; " +
        "plan stability becomes a function of those two alone",
    }),
  };
}

module.exports = {
  DISPLACEMENT,
  COMPONENT,
  MS_PER_SECOND,
  assertProtocolNotBypassed,
  evaluate,
  degraded,
  // Re-exported so a caller composing the column price never reaches around this module
  // into raw arithmetic.
  milli,
};
