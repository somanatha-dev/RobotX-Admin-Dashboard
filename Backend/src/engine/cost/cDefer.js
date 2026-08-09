"use strict";

/**
 * `C_defer` — the price of waiting (§8.8). **Tier 2**, mechanism T2-04, kill switch
 * `deferral`. **Present and switched off**, as the Phase 8 checklist requires.
 *
 * > Deferral is an arc in the optimisation (§1.4), and its price is the expected cost of
 * > waiting one more round:
 *
 * ```
 * C_defer[l] = C_delay[l]( T_complete_expected_if_deferred )
 *            + p_no_better · penalty_for_wasted_round
 *            + risk_of_deadline_loss · M_breach
 * ```
 *
 * > This makes the engine capable of the decision the baseline cannot express at all: *the
 * > only feasible agent is 40 km away with 21 % charge; an agent will free up 600 m away in
 * > two minutes; wait.* Under min-max normalisation the distant agent normalises to a
 * > perfect score of 0 and is assigned immediately.
 *
 * ── The delay term is the same functional, evaluated later ─────────────────
 * The first addend calls `cDelay.forLeg()` at the deferred completion time rather than
 * reimplementing the lateness penalty. Two implementations of one term would eventually
 * disagree, and the disagreement would show up as the engine deferring work it should
 * assign, or the reverse — the two most expensive errors this arc can make.
 *
 * ── Deferral is bounded, and the bound is structural ───────────────────────
 * > Deferral is bounded: `assign.max_deferral_time` and `assign.max_consecutive_deferrals`
 * > force escalation, so deferral can never become indefinite silence (§17.4).
 *
 * `admissible()` is that bound as a refusal. A Leg past either limit cannot be deferred at
 * any price — the arc is removed rather than made expensive — because §17.4's ladder, not
 * the price, is where the anti-starvation guarantee lives. A bound implemented as a large
 * cost is a bound the optimiser is entitled to pay.
 *
 * ── Every deferral must explain itself, at the moment it is taken ──────────
 * > **Every deferral MUST emit an operator-facing reason at the moment it is taken.** This
 * > is a requirement of the mechanism, not a presentation concern. Deferral means the
 * > engine sometimes deliberately leaves a customer waiting while a nominally suitable
 * > agent sits idle nearby, and the first time an operator sees that on a live dashboard it
 * > will be escalated as a bug — correctly, by their lights, because nothing on the screen
 * > distinguishes a considered decision from a stuck queue. **A feature that cannot explain
 * > itself at the moment it surprises someone does not survive contact with live
 * > operations, however sound its arithmetic.**
 *
 * > The reason is a structured record, rendered as a single sentence: *"waiting — an agent
 * > 600 m away is projected free in 90 s; assigning the nearest available agent now would
 * > cost 3 200 CU more."* It names the expected improvement in CU, the supply event being
 * > waited for, the projected assignment time, and the deferral deadline at which the
 * > ladder takes over.
 *
 * `reason()` builds exactly that record and refuses to render a sentence from an
 * incomplete one. The four named facts are required rather than optional, because a
 * deferral explanation missing the improvement in CU is the explanation that does not
 * answer the operator's actual question.
 *
 * Determinism: every instant arrives from the round's pinned snapshot.
 */

const { cu, milli, ZERO, total } = require("./units");
const cDelay = require("./cDelay");
const signDiscipline = require("./signDiscipline");

/** @structural milliseconds in one second */
const MS_PER_SECOND = 1000;

/** §8.8's three addends. */
const COMPONENT = Object.freeze({
  DELAY: "deferredDelay",
  WASTED_ROUND: "wastedRound",
  DEADLINE_LOSS: "deadlineLossRisk",
});

/** Why the deferral arc is unavailable for a Leg. */
const REFUSAL = Object.freeze({
  KILL_SWITCH: "DEFERRAL_DISABLED_BY_KILL_SWITCH",
  MAX_TIME: "MAX_DEFERRAL_TIME_REACHED",
  MAX_CONSECUTIVE: "MAX_CONSECUTIVE_DEFERRALS_REACHED",
});

/**
 * @param {*} value
 * @returns {boolean}
 */
function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Is the deferral arc available for this Leg at all?
 *
 * @param {object} input
 * @param {boolean} input.deferralEnabled the kill-switch state, already resolved
 * @param {number} input.firstDeferredAtMs when this Leg was first deferred, or the
 *   decision time if it has not been
 * @param {number} input.decisionTimeMs
 * @param {number} input.consecutiveDeferrals
 * @param {number} input.maxDeferralTimeSeconds `assign.max_deferral_time`
 * @param {number} input.maxConsecutiveDeferrals `assign.max_consecutive_deferrals`
 * @returns {{ admissible: boolean, refusal: string|null, reason: string|null,
 *             deferralDeadlineMs: number|null }}
 */
function admissible(input) {
  const source = input || {};

  if (source.deferralEnabled !== true) {
    return {
      admissible: false,
      refusal: REFUSAL.KILL_SWITCH,
      reason:
        "deferral is disabled (§22.5), and the degraded behaviour is immediate assignment when any " +
        "feasible candidate exists",
      deferralDeadlineMs: null,
    };
  }

  const missing = ["firstDeferredAtMs", "decisionTimeMs", "consecutiveDeferrals", "maxDeferralTimeSeconds", "maxConsecutiveDeferrals"].filter(
    (name) => !isNumber(source[name]),
  );
  if (missing.length > 0) {
    return {
      admissible: false,
      refusal: REFUSAL.MAX_TIME,
      reason: `the deferral bound cannot be evaluated: ${missing.join(", ")} absent. An unbounded deferral is indefinite silence (§8.8, §17.4)`,
      deferralDeadlineMs: null,
    };
  }

  const deadlineMs = source.firstDeferredAtMs + source.maxDeferralTimeSeconds * MS_PER_SECOND;

  if (source.decisionTimeMs >= deadlineMs) {
    return {
      admissible: false,
      refusal: REFUSAL.MAX_TIME,
      reason:
        `the Leg reached assign.max_deferral_time (${source.maxDeferralTimeSeconds} s). The arc is ` +
        "removed rather than priced high: §17.4's ladder terminates in a decision regardless of cost " +
        "dynamics, which is what makes it a guarantee",
      deferralDeadlineMs: deadlineMs,
    };
  }

  if (source.consecutiveDeferrals >= source.maxConsecutiveDeferrals) {
    return {
      admissible: false,
      refusal: REFUSAL.MAX_CONSECUTIVE,
      reason:
        `the Leg reached assign.max_consecutive_deferrals (${source.maxConsecutiveDeferrals}); the ` +
        "escalation ladder takes over (§17.4)",
      deferralDeadlineMs: deadlineMs,
    };
  }

  return { admissible: true, refusal: null, reason: null, deferralDeadlineMs: deadlineMs };
}

/**
 * `C_defer[l]`.
 *
 * @param {object} input
 * @param {object} input.leg as `cDelay.forLeg`
 * @param {number} input.expectedCompletionIfDeferredMs estimated from the forecast supply
 *   arriving in the next round window — principally agents projected to finish current work
 *   nearby, plus agents completing charging (§8.8)
 * @param {object} input.delayParameters as `cDelay.forLeg`
 * @param {number} input.probabilityNoBetter `p_no_better`
 * @param {number} input.wastedRoundPenaltyCu `defer.wasted_round_penalty`
 * @param {number} input.riskOfDeadlineLoss
 * @param {number} input.breachPenaltyCu `cost.sla.breach_penalty[class]`
 * @returns {{ ok: boolean, milliCU: bigint|null, breakdown: object|null,
 *             signCheck: object|null, missing: string[] }}
 */
function evaluate(input) {
  const source = input || {};
  const missing = [];

  if (!isNumber(source.probabilityNoBetter) || source.probabilityNoBetter < 0 || source.probabilityNoBetter > 1) {
    missing.push("p_no_better");
  }
  if (!isNumber(source.wastedRoundPenaltyCu) || source.wastedRoundPenaltyCu < 0) {
    missing.push("defer.wasted_round_penalty");
  }
  if (!isNumber(source.riskOfDeadlineLoss) || source.riskOfDeadlineLoss < 0 || source.riskOfDeadlineLoss > 1) {
    missing.push("risk_of_deadline_loss");
  }
  if (!isNumber(source.breachPenaltyCu) || source.breachPenaltyCu < 0) missing.push("cost.sla.breach_penalty");

  const delay = cDelay.forLeg(source.leg, source.expectedCompletionIfDeferredMs, source.delayParameters);
  if (!delay.ok) missing.push(...delay.missing);

  if (missing.length > 0) {
    return { ok: false, milliCU: null, breakdown: null, signCheck: null, missing: [...new Set(missing)] };
  }

  const wastedRound = cu(source.probabilityNoBetter * source.wastedRoundPenaltyCu);
  const deadlineLoss = cu(source.riskOfDeadlineLoss * source.breachPenaltyCu);
  const summed = total(milli(delay.milliCU), wastedRound, deadlineLoss);
  const signCheck = signDiscipline.check("C_defer", summed.milliCU);

  return {
    ok: true,
    milliCU: summed.milliCU,
    breakdown: Object.freeze({
      [COMPONENT.DELAY]: Object.freeze({
        milliCU: delay.milliCU,
        expectedCompletionIfDeferredMs: source.expectedCompletionIfDeferredMs,
        detail: delay.breakdown,
      }),
      [COMPONENT.WASTED_ROUND]: Object.freeze({
        probability: source.probabilityNoBetter,
        penaltyCu: source.wastedRoundPenaltyCu,
        milliCU: wastedRound.milliCU,
      }),
      [COMPONENT.DEADLINE_LOSS]: Object.freeze({
        risk: source.riskOfDeadlineLoss,
        breachPenaltyCu: source.breachPenaltyCu,
        milliCU: deadlineLoss.milliCU,
      }),
      milliCU: summed.milliCU,
    }),
    signCheck,
    missing: [],
  };
}

/**
 * The operator-facing reason §8.8 requires at the moment a deferral is taken.
 *
 * Four facts, all required: the expected improvement in CU, the supply event being waited
 * for, the projected assignment time, and the deferral deadline at which the ladder takes
 * over. The record is structured; `sentence` is its rendering.
 *
 * Served from Tier A (§21.2, §21.3) — "a deferral is exactly the kind of decision that
 * gets questioned and exactly the kind whose record must therefore never be sampled away."
 *
 * @param {object} input
 * @param {number} input.expectedImprovementCu what waiting is expected to save
 * @param {object} input.supplyEvent `{ description, distanceM, projectedFreeInSeconds }`
 * @param {number} input.projectedAssignmentMs
 * @param {number} input.deferralDeadlineMs
 * @returns {{ ok: boolean, record: object|null, sentence: string|null, missing: string[] }}
 */
function reason(input) {
  const source = input || {};
  const missing = [];

  if (!isNumber(source.expectedImprovementCu)) missing.push("expectedImprovementCu");
  if (!source.supplyEvent || typeof source.supplyEvent !== "object") missing.push("supplyEvent");
  if (!isNumber(source.projectedAssignmentMs)) missing.push("projectedAssignmentMs");
  if (!isNumber(source.deferralDeadlineMs)) missing.push("deferralDeadlineMs");

  if (missing.length > 0) {
    // Refused rather than partially rendered. §8.8 makes the explanation a requirement of
    // the mechanism, and a sentence missing the CU figure does not answer the question an
    // operator is actually asking when they see an idle agent beside a waiting customer.
    return { ok: false, record: null, sentence: null, missing };
  }

  const event = source.supplyEvent;
  const record = Object.freeze({
    decision: "DEFER",
    expectedImprovementCu: source.expectedImprovementCu,
    supplyEvent: Object.freeze({
      description: event.description ?? null,
      distanceM: isNumber(event.distanceM) ? event.distanceM : null,
      projectedFreeInSeconds: isNumber(event.projectedFreeInSeconds) ? event.projectedFreeInSeconds : null,
    }),
    projectedAssignmentMs: source.projectedAssignmentMs,
    deferralDeadlineMs: source.deferralDeadlineMs,
    tier: "A",
  });

  const distance = isNumber(event.distanceM) ? `${event.distanceM} m away ` : "";
  const freeIn = isNumber(event.projectedFreeInSeconds) ? `is projected free in ${event.projectedFreeInSeconds} s` : "is projected free";

  return {
    ok: true,
    record,
    sentence:
      `waiting — an agent ${distance}${freeIn}; assigning the nearest available agent now would cost ` +
      `${source.expectedImprovementCu} CU more.`,
    missing: [],
  };
}

/**
 * The disabled behaviour §22.5 rule 1 requires: immediate assignment when any feasible
 * candidate exists.
 *
 * @returns {{ ok: boolean, milliCU: bigint, breakdown: object }}
 */
function degraded() {
  return {
    ok: true,
    milliCU: ZERO.milliCU,
    breakdown: Object.freeze({
      milliCU: ZERO.milliCU,
      killSwitch: "deferral",
      degradesTo: "immediate assignment when any feasible candidate exists (§22.5 rule 1)",
      consequence:
        "the round cannot express 'wait for the agent finishing nearby'; the anti-starvation guarantee " +
        "is unaffected, because it lives in §17.4's ladder rather than in this arc",
    }),
  };
}

module.exports = {
  COMPONENT,
  REFUSAL,
  MS_PER_SECOND,
  admissible,
  evaluate,
  reason,
  degraded,
};
