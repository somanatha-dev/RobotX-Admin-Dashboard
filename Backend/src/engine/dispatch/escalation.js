"use strict";

/**
 * The escalation ladder for undelivered or unacknowledged offers (§11.4).
 *
 * | Step | Condition | Action |
 * |---|---|---|
 * | 1 | No delivery confirmation within `dispatch.retry_window` | Retry with backoff on an alternate channel where available |
 * | 2 | No ACK within `dispatch.offer_ttl` | Withdraw offer at an advanced commitment fence, release the commitment, mark agent `dispatch_unresponsive`, re-plan the Leg excluding it |
 * | 3 | Agent `dispatch_unresponsive` on `health.unresponsive_strikes` consecutive offers | Remove from the availability index; open a health investigation |
 * | 4 | Fraction of unresponsive agents in the shard exceeds `dispatch.systemic_threshold` | Systemic fault: alert, stop new hardening, enter degraded mode (§18.3) |
 *
 * ── Why step 4 exists, in the specification's own words ─────────────────────
 * > Step 4 matters because the difference between one broken agent and a broken
 * > message bus is a count, and a system that only knows how to handle the former will
 * > respond to the latter by quietly grounding the fleet one agent at a time.
 *
 * That sentence is the whole design: steps 1–3 are per-agent and step 4 is the guard
 * against applying them fleet-wide. A ladder implemented without step 4 is not a
 * shorter ladder; it is a mechanism that converts an infrastructure outage into a
 * fleet grounding, one correct per-agent decision at a time.
 *
 * ── This module decides; it does not act ────────────────────────────────────
 * Each assessment returns the step reached and the action §11.4 prescribes. Two of
 * those actions belong to phases that have not landed — "remove from the availability
 * index" is Phase 9's index, and "enter degraded mode" is Phase 12's named-mode
 * register — so this module names them rather than performing them, and the drain
 * worker records the directive. Inventing an index or a mode here would be building
 * two of them.
 *
 * ── `dispatch_unresponsive` is derived, not stored ──────────────────────────
 * §11.4 step 2 says "mark agent `dispatch_unresponsive`" and step 3 counts consecutive
 * such offers. Both are read off the outbox: an offer that reached
 * `UNACKNOWLEDGED` **is** the mark, and "consecutive" is that agent's most recent rows
 * in order. Storing a second copy on the agent row would create a counter that could
 * disagree with the evidence it summarises, and the reconciler would then have a tenth
 * divergence class to repair.
 *
 * The mark therefore has to survive step 2's *own* action. Once the withdrawal has been
 * performed the row is terminal — `FAILED`, carrying `WITHDRAWN_AT_ADVANCED_FENCE` —
 * and reading the mark off the state name alone would have made every successful
 * withdrawal erase the evidence that step 3 counts, so an agent that never answers
 * would have been withdrawn from, indefinitely, and never investigated. `isMarked`
 * below is what keeps the two readings in one place.
 *
 * Tier 0 (T0-09).
 */

const clock = require("../commitment/clock");
const outbox = require("./outbox");

/**
 * The rungs, numbered as §11.4's own table numbers them. These are **step numbers from
 * the specification**, not thresholds: changing one would not tune a behaviour, it
 * would misname a row of a normative table.
 * @structural the enumerated rungs of the §11.4 ladder
 */
const ESCALATION_STEP = Object.freeze({
  NONE: 0,
  RETRY: 1,
  /** @structural §11.4 row 2's step number */
  WITHDRAW: 2,
  /** @structural §11.4 row 3's step number */
  AGENT_HEALTH: 3,
  /** @structural §11.4 row 4's step number */
  SYSTEMIC: 4,
});

/** @structural the actions §11.4 prescribes, one per rung */
const ESCALATION_ACTION = Object.freeze({
  NONE: "NONE",
  RETRY_WITH_BACKOFF: "RETRY_WITH_BACKOFF",
  WITHDRAW_AND_REPLAN: "WITHDRAW_AND_REPLAN",
  REMOVE_FROM_AVAILABILITY_INDEX: "REMOVE_FROM_AVAILABILITY_INDEX",
  DECLARE_SYSTEMIC_DISPATCH_FAULT: "DECLARE_SYSTEMIC_DISPATCH_FAULT",
});

/**
 * Steps 1 and 2, for one outbox row.
 *
 * The two clocks are different and deliberately so: the **retry window** runs from the
 * row's creation and governs *delivery*, while the **offer TTL** runs from the same
 * origin and governs *acknowledgement*. A row can be delivered promptly and still
 * reach step 2, which is the case that matters — an agent that received the offer and
 * said nothing is a different failure from an agent that never received it, and the
 * ladder must reach step 2 for both.
 *
 * @param {object} input
 * @param {object} input.row the outbox row
 * @param {Date} input.storeTime
 * @param {number} input.retryWindowSeconds `dispatch.retry_window`
 * @param {number} input.offerTtlSeconds `dispatch.offer_ttl`
 * @returns {{ step: number, action: string, reason: string|null }}
 */
function assessRow(input) {
  const settings = input || {};
  const { row, storeTime } = settings;

  if (!row) return { step: ESCALATION_STEP.NONE, action: ESCALATION_ACTION.NONE, reason: "NO_ROW" };
  if (outbox.isTerminal(row.state)) {
    return { step: ESCALATION_STEP.NONE, action: ESCALATION_ACTION.NONE, reason: `TERMINAL_${row.state}` };
  }
  if (row.state === outbox.OUTBOX_STATE.ACKED) {
    return { step: ESCALATION_STEP.NONE, action: ESCALATION_ACTION.NONE, reason: "ACKED" };
  }

  const createdAt = row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt);

  const ackDeadline = clock.deadlineFrom(createdAt, settings.offerTtlSeconds);
  if (clock.hasPassed(ackDeadline, storeTime)) {
    return {
      step: ESCALATION_STEP.WITHDRAW,
      action: ESCALATION_ACTION.WITHDRAW_AND_REPLAN,
      reason: "NO_ACK_WITHIN_OFFER_TTL",
    };
  }

  const deliveryDeadline = clock.deadlineFrom(createdAt, settings.retryWindowSeconds);
  if (row.deliveredAt === null || row.deliveredAt === undefined) {
    if (clock.hasPassed(deliveryDeadline, storeTime)) {
      return {
        step: ESCALATION_STEP.RETRY,
        action: ESCALATION_ACTION.RETRY_WITH_BACKOFF,
        reason: "NO_DELIVERY_WITHIN_RETRY_WINDOW",
      };
    }
  }

  return { step: ESCALATION_STEP.NONE, action: ESCALATION_ACTION.NONE, reason: null };
}

/**
 * §11.3 — *"Retries use bounded exponential backoff with jitter; exhaustion escalates
 * rather than being discarded."*
 *
 * The backoff is computed from the attempt count and the retry window, and is capped
 * at the window: a backoff that could exceed the window would push the next attempt
 * past the rung that is supposed to catch it.
 *
 * Jitter is supplied by the caller rather than drawn here, so that a replay of a
 * dispatch trace reproduces the same schedule (T6). A worker passes a random fraction;
 * a test passes a fixed one.
 *
 * @param {object} input
 * @param {number} input.attempts attempts already made
 * @param {number} input.retryWindowSeconds `dispatch.retry_window`
 * @param {number} [input.jitterFraction] in [0, 1); defaults to none
 * @returns {number} seconds to wait before the next attempt
 */
function backoffSeconds(input) {
  const settings = input || {};
  const attempts = Number.isInteger(settings.attempts) && settings.attempts > 0 ? settings.attempts : 0;
  const window = settings.retryWindowSeconds;

  if (!Number.isFinite(window) || window <= 0) {
    throw new RangeError(`dispatch.retry_window resolved to ${String(window)}; a retry window must be positive`);
  }

  // @structural the base of the exponential; doubling is the backoff, not a threshold
  const BASE = 2;
  const exponential = Math.min(window, BASE ** attempts);
  const jitter = Number.isFinite(settings.jitterFraction) ? Math.min(Math.max(settings.jitterFraction, 0), 1) : 0;

  return Math.min(window, exponential * (1 + jitter));
}

/**
 * The `lastError` a row carries once its §11.4 step-2 withdrawal has been performed.
 * @structural the step-2 completion marker, written by the drain worker
 */
const WITHDRAWN_MARK = "WITHDRAWN_AT_ADVANCED_FENCE";

/**
 * Did this offer row reach step 2 — that is, was its agent marked
 * `dispatch_unresponsive` for it?
 *
 * True for a row still awaiting its withdrawal (`UNACKNOWLEDGED`) and for one whose
 * withdrawal has been performed (`FAILED` carrying the completion marker). Both are the
 * same fact about the agent; they differ only in what the engine has since done about
 * it.
 *
 * @param {{ state: string, lastError?: string|null }} row
 * @returns {boolean}
 */
function isMarkedUnresponsive(row) {
  if (!row) return false;
  if (row.state === outbox.OUTBOX_STATE.UNACKNOWLEDGED) return true;
  return row.state === outbox.OUTBOX_STATE.FAILED && row.lastError === WITHDRAWN_MARK;
}

/**
 * Step 3 — is this agent unresponsive on `health.unresponsive_strikes` **consecutive**
 * offers?
 *
 * "Consecutive" is the load-bearing word. An agent that answers nine offers and misses
 * one has a transport blip; an agent that misses three in a row has a fault. Counting
 * a rate over a window instead would quarantine the first agent during a busy hour and
 * miss the second during a quiet one.
 *
 * @param {object} input
 * @param {Array<{ state: string, createdAt: Date|string }>} input.recentOffers newest first
 * @param {number} input.strikes `health.unresponsive_strikes`
 * @returns {{ step: number, action: string, consecutive: number, reason: string|null }}
 */
function assessAgent(input) {
  const settings = input || {};
  const offers = Array.isArray(settings.recentOffers) ? settings.recentOffers : [];
  const strikes = settings.strikes;

  if (!Number.isInteger(strikes) || strikes <= 0) {
    throw new RangeError(
      `health.unresponsive_strikes resolved to ${String(strikes)}; a strike count must be a positive integer`,
    );
  }

  let consecutive = 0;
  for (const offer of offers) {
    if (isMarkedUnresponsive(offer)) consecutive += 1;
    else break;
  }

  if (consecutive >= strikes) {
    return {
      step: ESCALATION_STEP.AGENT_HEALTH,
      action: ESCALATION_ACTION.REMOVE_FROM_AVAILABILITY_INDEX,
      consecutive,
      reason: "CONSECUTIVE_UNRESPONSIVE_OFFERS",
    };
  }

  return { step: ESCALATION_STEP.NONE, action: ESCALATION_ACTION.NONE, consecutive, reason: null };
}

/**
 * Step 4 — is the shard's unresponsive fraction above `dispatch.systemic_threshold`?
 *
 * A shard with no agents is **not** systemically faulty: `0/0` is an empty shard, and
 * declaring a dispatch fault over it would alert on every shard that has not yet been
 * populated. Unknown is not permission here either — an empty shard is *known* to have
 * no evidence of a fault, which is different from missing data.
 *
 * @param {object} input
 * @param {number} input.unresponsiveAgents
 * @param {number} input.totalAgents
 * @param {number} input.systemicThreshold `dispatch.systemic_threshold`, a fraction
 * @returns {{ step: number, action: string, fraction: number, reason: string|null }}
 */
function assessShard(input) {
  const settings = input || {};
  const total = settings.totalAgents;
  const unresponsive = settings.unresponsiveAgents;
  const threshold = settings.systemicThreshold;

  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
    throw new RangeError(
      `dispatch.systemic_threshold resolved to ${String(threshold)}; it is a fraction in (0, 1]`,
    );
  }
  if (!Number.isInteger(total) || total < 0 || !Number.isInteger(unresponsive) || unresponsive < 0) {
    throw new RangeError("the systemic assessment counts agents; both counts are non-negative integers");
  }
  if (total === 0) {
    return { step: ESCALATION_STEP.NONE, action: ESCALATION_ACTION.NONE, fraction: 0, reason: "EMPTY_SHARD" };
  }

  const fraction = unresponsive / total;
  if (fraction > threshold) {
    return {
      step: ESCALATION_STEP.SYSTEMIC,
      action: ESCALATION_ACTION.DECLARE_SYSTEMIC_DISPATCH_FAULT,
      fraction,
      reason: "UNRESPONSIVE_FRACTION_ABOVE_SYSTEMIC_THRESHOLD",
    };
  }

  return { step: ESCALATION_STEP.NONE, action: ESCALATION_ACTION.NONE, fraction, reason: null };
}

/**
 * The step 4 directive, in the form the phases that must honour it will consume.
 *
 * > Systemic fault: alert, **stop new hardening**, enter degraded mode (§18.3).
 *
 * `stopNewHardening` is the part that must not be lost in translation: the correct
 * response to "the bus is broken" is to stop *creating* new commitments, not to keep
 * committing and keep failing to deliver.
 *
 * @param {{ fraction: number, threshold: number, shardId: string }} assessment
 * @returns {object}
 */
function systemicDirective(assessment) {
  const source = assessment || {};
  return Object.freeze({
    alert: "SYSTEMIC_DISPATCH_FAULT",
    shardId: source.shardId === undefined ? null : source.shardId,
    unresponsiveFraction: source.fraction,
    threshold: source.threshold,
    stopNewHardening: true,
    // Phase 12 owns the named degraded modes and their suspension sets (§18.5, §26.2).
    // Naming the mode without entering it is deliberate: entering one here would be a
    // second, undocumented mode register.
    enterDegradedMode: "SHED_LOAD",
    ownedBy: "Phase 12 — degraded/modeRegister.js",
  });
}

module.exports = {
  ESCALATION_STEP,
  ESCALATION_ACTION,
  WITHDRAWN_MARK,
  isMarkedUnresponsive,
  assessRow,
  backoffSeconds,
  assessAgent,
  assessShard,
  systemicDirective,
};
