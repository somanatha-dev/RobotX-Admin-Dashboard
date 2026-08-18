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
 * A jitter fraction in [0, 1) drawn from the row's own identity rather than from a
 * random source.
 *
 * §11.3 wants jitter so that a fleet's retries decorrelate instead of arriving as a
 * synchronised herd after a shared outage. What it does **not** want is a schedule that
 * differs between two replays of the same dispatch trace (T6). Both are satisfied by
 * making the fraction a pure function of the row id: distinct rows get distinct
 * fractions, and the same row gets the same fraction on every pass, in every worker,
 * after every restart. A worker that redrew the fraction on each pass would also make
 * `retryDueAt` non-monotonic — a row could be due, then not due, then due again —
 * which is a worse property than no jitter at all.
 *
 * @param {string} seed the row id
 * @returns {number} in [0, 1)
 */
function jitterFractionFor(seed) {
  // @structural FNV-1a's offset basis — a hash function's constant, not a threshold
  const FNV_OFFSET_BASIS = 2166136261;
  // @structural FNV-1a's prime — a hash function's constant, not a threshold
  const FNV_PRIME = 16777619;
  // @structural the 32-bit space the hash is reduced over
  const HASH_SPACE = 2 ** 32;

  let hash = FNV_OFFSET_BASIS;
  const text = String(seed === undefined || seed === null ? "" : seed);
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return (hash >>> 0) / HASH_SPACE;
}

/**
 * §11.3 — the instant a row that has already been attempted becomes eligible for the
 * next attempt.
 *
 * This is what makes `backoffSeconds` an *enforcement* mechanism rather than a number
 * that only ever reached a log line. Without it the drain loop reclaimed every
 * `PENDING` row on every pass, so the actual retry cadence was the worker's tick
 * interval — constant, unjittered, and identical across the whole fleet, which is the
 * one shape §11.3 names as prohibited.
 *
 * Two properties the caller relies on:
 *
 *   - **A row that has never been attempted is due immediately.** Backoff paces
 *     *retries*; delaying a command's first delivery would add latency to the healthy
 *     path to solve a problem only the unhealthy path has.
 *   - **The last-attempt instant is the row's own `updatedAt`.** A row sitting in
 *     `PENDING` with `attempts > 0` was last written by `recordAttempt`'s undelivered
 *     branch; every other transition moves it out of `PENDING`. Reading the column the
 *     store already maintains avoids a second timestamp that could disagree with it.
 *
 * @param {object} input
 * @param {object} input.row the outbox row
 * @param {number} input.retryWindowSeconds `dispatch.retry_window`
 * @returns {Date|null} the instant, or `null` when the row is due now
 */
function retryDueAt(input) {
  const settings = input || {};
  const row = settings.row;
  if (!row) return null;

  const attempts = Number.isInteger(row.attempts) ? row.attempts : 0;
  if (attempts <= 0) return null;

  const lastAttempt = row.updatedAt instanceof Date ? row.updatedAt : row.updatedAt ? new Date(row.updatedAt) : null;
  if (lastAttempt === null || Number.isNaN(lastAttempt.getTime())) return null;

  const seconds = backoffSeconds({
    attempts,
    retryWindowSeconds: settings.retryWindowSeconds,
    jitterFraction: jitterFractionFor(row.id),
  });
  return clock.deadlineFrom(lastAttempt, seconds);
}

/**
 * Is this row's next delivery attempt due?
 *
 * @param {object} input as `retryDueAt`, plus `storeTime`
 * @param {Date} input.storeTime the Commitment Store's clock (§10.6)
 * @returns {boolean}
 */
function isRetryDue(input) {
  const settings = input || {};
  const dueAt = retryDueAt(settings);
  if (dueAt === null) return true;
  return clock.hasPassed(dueAt, settings.storeTime);
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
  jitterFractionFor,
  retryDueAt,
  isRetryDue,
  assessAgent,
  assessShard,
  systemicDirective,
};
