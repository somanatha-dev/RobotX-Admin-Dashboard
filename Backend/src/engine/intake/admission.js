"use strict";

/**
 * Admission control and backpressure (§20.5) — **Tier 1**, mechanism T1-06.
 *
 * > Every queue in the engine is bounded, and every bound has a defined overflow
 * > behaviour. **An unbounded queue is a deferred outage.**
 *
 * > Declining at intake is strongly preferred to accepting and failing later: the
 * > customer can act on an immediate decline, and the operation is not left holding
 * > work it cannot perform.
 *
 * That last sentence is the whole design of this module. The baseline accepts every
 * task, returns HTTP 200 with a `PENDING` row, and then either assigns it or does not —
 * with no way for the caller to tell "working on it" from "will never happen". Here a
 * decline is a *first-class outcome* with a reason the caller can act on, and it is
 * produced before anything durable is written.
 *
 * ── The four controls this module owns ──────────────────────────────────────
 * §20.5's table lists six; two of them belong elsewhere and are named here so the
 * division is explicit rather than inferred:
 *
 *   1. **Per-tenant rate and concurrency quotas** — `checkQuota()`.
 *   2. **Global admission** — `checkQueueDelay()`: when projected queue delay exceeds
 *      an SLA class's budget, new missions of that class are declined **at intake with
 *      an honest reason**, not accepted and silently starved.
 *   3. **Class-based shedding** — `shedDecision()`: keyed on Leg `purpose` first and
 *      SLA class second, in a published order.
 *   4. **Round-level budgets** — `solve/budgets.js` (§9.4), not here.
 *   5. **Downstream protection** — the dependency clients' own circuit breakers (§5.2).
 *   6. **Cost-based limits** — per-tenant routing budgets, a Phase 7 concern.
 *
 * ── `custodial_purposes` are never shed, and the refusal is structural ──────
 * > **`custodial_purposes` (`RECOVERY`, `TRANSFER`) are never shed** — they discharge an
 * > obligation that already exists physically, and shedding one leaves goods stranded
 * > rather than merely unserved.
 *
 * `shedDecision()` therefore does not consult the shed ladder at all for a custodial
 * purpose: it returns `ADMIT` before the ladder is read, so no configuration of shed
 * level, queue depth, or SLA class can produce a shed verdict for one. A ladder that
 * merely placed custodial work last would still shed it at a sufficiently severe level,
 * and "sufficiently severe" is exactly the circumstance in which stranded goods are
 * least recoverable. The same reasoning is why `domain/purpose.isSheddable()` exists and
 * is consulted rather than re-derived here.
 *
 * ── Honest declines, not silent ones ────────────────────────────────────────
 * Every non-admission carries a machine-readable `reason` **and** a sentence naming what
 * the caller can do about it. §20.5's "declines are explicit, never silent" (§18.4 B19)
 * is a property of this return shape, not of the caller's rendering.
 *
 * Determinism: no clock, no store, no randomness. Every quantity — projected queue
 * delay, current shed level, the tenant's observed rate — arrives as an argument from
 * the caller, which is what makes an admission decision replayable alongside the round
 * it preceded.
 */

const purpose = require("../domain/purpose");

/** The verdicts this module can return. @structural outcome labels */
const VERDICT = Object.freeze({
  ADMIT: "ADMIT",
  DECLINE: "DECLINE",
  SHED: "SHED",
});

/**
 * Why work was not admitted. Machine-readable, so a caller can branch; the
 * accompanying sentence is what a human reads.
 * @structural decline-reason labels
 */
const REASON = Object.freeze({
  TENANT_RATE_QUOTA: "TENANT_RATE_QUOTA_EXCEEDED",
  TENANT_CONCURRENCY_QUOTA: "TENANT_CONCURRENCY_QUOTA_EXCEEDED",
  QUEUE_DELAY_EXCEEDS_SLA: "PROJECTED_QUEUE_DELAY_EXCEEDS_SLA_BUDGET",
  SHED_BY_PURPOSE: "SHED_BY_PURPOSE",
  SHED_BY_SLA_CLASS: "SHED_BY_SLA_CLASS",
  UNKNOWN_PURPOSE: "UNKNOWN_PURPOSE",
});

/**
 * §18.5's Shed Load mode, as an ordered ladder. Level 0 is nominal — nothing is shed.
 * Each higher level sheds everything the level below it sheds, plus one more class of
 * work, so the ladder is a prefix relation exactly like §22.5's kill-switch ladder.
 *
 * The order is **published configuration in the specification's own words** — "keyed on
 * Leg `purpose` (§2.4) first and SLA class second: `speculative_purposes` (`REPOSITION`,
 * `EXERCISE`) shed first, then low-priority classes" — so it is encoded here as a
 * structural table rather than as a tunable, and `shedLadder()` returns it for an
 * operator surface to display *before* the load arrives rather than after.
 *
 * @structural §20.5's published shed order
 */
const SHED_LADDER = Object.freeze([
  Object.freeze({
    level: 0,
    name: "NOMINAL",
    shedsPurposes: Object.freeze([]),
    shedsSlaClasses: Object.freeze([]),
    note: "nothing is shed",
  }),
  Object.freeze({
    level: 1,
    name: "SPECULATIVE_SHED",
    shedsPurposes: Object.freeze([...purpose.SPECULATIVE_PURPOSES]),
    shedsSlaClasses: Object.freeze([]),
    note:
      "speculative work only — REPOSITION and EXERCISE. §17.3 makes repositioning explicitly " +
      "'first to be shed under load'; no customer is waiting on either",
  }),
  Object.freeze({
    level: 2, // @structural the ladder rung ordinal
    name: "LOW_PRIORITY_SHED",
    shedsPurposes: Object.freeze([...purpose.SPECULATIVE_PURPOSES]),
    shedsSlaClasses: Object.freeze(["bulk", "economy"]),
    note: "speculative work, then the lowest-priority customer classes",
  }),
  Object.freeze({
    level: 3, // @structural the ladder rung ordinal
    name: "STANDARD_SHED",
    shedsPurposes: Object.freeze([...purpose.SPECULATIVE_PURPOSES]),
    shedsSlaClasses: Object.freeze(["bulk", "economy", "standard"]),
    note:
      "everything above, plus standard-class customer work. MAINTENANCE_TRANSIT is deliberately " +
      "absent from every level: §17.4 requires a maintenance transit not be shed, because an agent " +
      "that cannot reach maintenance becomes a permanent capacity loss rather than a deferred one",
  }),
]);

/** The most severe level the ladder defines. @structural the ladder's own arity */
const MAX_SHED_LEVEL = SHED_LADDER[SHED_LADDER.length - 1].level;

/**
 * @param {*} value
 * @returns {boolean}
 */
function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * The published shed order, for an operator surface and for the decision record.
 *
 * @returns {readonly object[]}
 */
function shedLadder() {
  return SHED_LADDER;
}

/**
 * The ladder rung at a given severity, clamped into range.
 *
 * @param {number} level
 * @returns {object}
 */
function rungAt(level) {
  const clamped = Math.max(0, Math.min(MAX_SHED_LEVEL, isNumber(level) ? Math.floor(level) : 0));
  return SHED_LADDER[clamped];
}

/**
 * §20.5 — per-tenant rate and concurrency quotas.
 *
 * > A single misbehaving or compromised client cannot consume the fleet.
 *
 * Both observed quantities are supplied by the caller rather than counted here: the
 * counters live in the cache tier and this module is a pure function of them, which is
 * what lets an admission decision be replayed from a decision record without a live
 * Redis.
 *
 * @param {object} input
 * @param {string|null} input.tenantId
 * @param {number} [input.observedRatePerMinute] the tenant's current submission rate
 * @param {number} [input.rateQuotaPerMinute] the configured ceiling, or absent for none
 * @param {number} [input.observedConcurrent] the tenant's in-flight (unsettled) Legs
 * @param {number} [input.concurrencyQuota] the configured ceiling, or absent for none
 * @returns {{ ok: boolean, reason: string|null, sentence: string|null, observed: object }}
 */
function checkQuota(input) {
  const source = input || {};
  const observed = {
    tenantId: source.tenantId ?? null,
    ratePerMinute: isNumber(source.observedRatePerMinute) ? source.observedRatePerMinute : null,
    rateQuotaPerMinute: isNumber(source.rateQuotaPerMinute) ? source.rateQuotaPerMinute : null,
    concurrent: isNumber(source.observedConcurrent) ? source.observedConcurrent : null,
    concurrencyQuota: isNumber(source.concurrencyQuota) ? source.concurrencyQuota : null,
  };

  if (observed.rateQuotaPerMinute !== null && observed.ratePerMinute !== null && observed.ratePerMinute >= observed.rateQuotaPerMinute) {
    return {
      ok: false,
      reason: REASON.TENANT_RATE_QUOTA,
      sentence:
        `submission rate quota reached for this tenant (${observed.ratePerMinute} of ` +
        `${observed.rateQuotaPerMinute} per minute). Retry after the current minute, or request a higher quota.`,
      observed,
    };
  }

  if (observed.concurrencyQuota !== null && observed.concurrent !== null && observed.concurrent >= observed.concurrencyQuota) {
    return {
      ok: false,
      reason: REASON.TENANT_CONCURRENCY_QUOTA,
      sentence:
        `concurrency quota reached for this tenant (${observed.concurrent} of ${observed.concurrencyQuota} ` +
        "unsettled Legs). Existing work must settle before more is accepted.",
      observed,
    };
  }

  return { ok: true, reason: null, sentence: null, observed };
}

/**
 * §20.5 — global admission.
 *
 * > When projected queue delay exceeds an SLA class's budget, new missions of that class
 * > are declined **at intake with an honest reason**, not accepted and silently starved.
 *
 * The budget is `sla.assignment_deadline` for the class — the same parameter §4.5
 * registers the Leg `QUEUED` timer against, so the deadline that declines the work and
 * the deadline that escalates it are one number rather than two that can disagree.
 *
 * @param {object} input
 * @param {number} input.projectedQueueDelaySeconds
 * @param {number} [input.slaBudgetSeconds] `sla.assignment_deadline` for the class
 * @param {string|null} [input.slaClass]
 * @returns {{ ok: boolean, reason: string|null, sentence: string|null, observed: object }}
 */
function checkQueueDelay(input) {
  const source = input || {};
  const observed = {
    slaClass: source.slaClass ?? null,
    projectedQueueDelaySeconds: isNumber(source.projectedQueueDelaySeconds) ? source.projectedQueueDelaySeconds : null,
    slaBudgetSeconds: isNumber(source.slaBudgetSeconds) ? source.slaBudgetSeconds : null,
  };

  // An unknown budget does not decline. §20.5's control is "delay exceeds *the class's
  // budget*", and with no budget published there is no exceedance to establish — the
  // §17.4 ladder still bounds the wait, and declining on an absent configuration value
  // would turn a missing parameter into a customer-visible outage.
  if (observed.projectedQueueDelaySeconds === null || observed.slaBudgetSeconds === null) {
    return { ok: true, reason: null, sentence: null, observed };
  }

  if (observed.projectedQueueDelaySeconds > observed.slaBudgetSeconds) {
    return {
      ok: false,
      reason: REASON.QUEUE_DELAY_EXCEEDS_SLA,
      sentence:
        `declined: work of this class is currently projected to wait ${Math.round(observed.projectedQueueDelaySeconds)} s ` +
        `before assignment, which exceeds its ${observed.slaBudgetSeconds} s assignment budget. Accepting it would ` +
        "mean promising a deadline the shard cannot currently meet.",
      observed,
    };
  }

  return { ok: true, reason: null, sentence: null, observed };
}

/**
 * §20.5 — class-based shedding, purpose first and SLA class second.
 *
 * @param {object} input
 * @param {string} input.purpose a `domain/purpose.js` LegPurpose
 * @param {string|null} [input.slaClass]
 * @param {number} [input.shedLevel] the shard's current §18.5 Shed Load rung
 * @returns {{ ok: boolean, reason: string|null, sentence: string|null, observed: object }}
 */
function shedDecision(input) {
  const source = input || {};
  const rung = rungAt(source.shedLevel);
  const observed = {
    purpose: source.purpose ?? null,
    slaClass: source.slaClass ?? null,
    shedLevel: rung.level,
    shedLevelName: rung.name,
  };

  if (!purpose.isPurpose(source.purpose)) {
    return {
      ok: false,
      reason: REASON.UNKNOWN_PURPOSE,
      sentence:
        `"${String(source.purpose)}" is not a Leg purpose. §2.4 sets purpose at creation and never mutates it, ` +
        "and three separate mechanisms — cancellation (§4.6), preemption (§4.8), and this one — read it; work " +
        "whose purpose cannot be established cannot be admitted, because none of the three could decide about it.",
      observed,
    };
  }

  // The structural refusal. Read before the ladder, so no shed level can reach it.
  if (!purpose.isSheddable(source.purpose)) {
    return {
      ok: true,
      reason: null,
      sentence: null,
      observed: { ...observed, neverShed: true, neverShedBecause: purpose.isCustodial(source.purpose) ? "custodial_purposes" : "not sheddable (§20.5)" },
    };
  }

  if (rung.shedsPurposes.includes(source.purpose)) {
    return {
      ok: false,
      reason: REASON.SHED_BY_PURPOSE,
      sentence:
        `declined: the shard is in Shed Load level ${rung.level} (${rung.name}) and ${source.purpose} work is shed ` +
        "at this level. This is speculative work with no customer waiting on it; it will be accepted again when " +
        "load returns to nominal.",
      observed,
    };
  }

  if (source.slaClass !== null && source.slaClass !== undefined && rung.shedsSlaClasses.includes(String(source.slaClass))) {
    return {
      ok: false,
      reason: REASON.SHED_BY_SLA_CLASS,
      sentence:
        `declined: the shard is in Shed Load level ${rung.level} (${rung.name}) and the "${source.slaClass}" class ` +
        "is shed at this level. Higher-priority classes are still being accepted.",
      observed,
    };
  }

  return { ok: true, reason: null, sentence: null, observed };
}

/**
 * The whole §20.5 admission decision, in the order the controls apply.
 *
 * Order matters and is stated: quota first (a misbehaving client is refused before its
 * work is priced against the shard's health at all), then shedding (a purpose-level
 * refusal that does not depend on this shard's queue), then global admission (the one
 * control that depends on the shard's live projected delay). A shed verdict and a
 * queue-delay decline are distinguished rather than merged, because they call for
 * different operator responses: the first is load management working as designed, the
 * second is a capacity shortfall.
 *
 * @param {object} input the union of `checkQuota`, `shedDecision`, and `checkQueueDelay`
 * @returns {{ verdict: string, admitted: boolean, reason: string|null, sentence: string|null,
 *             controls: object }}
 */
function assess(input) {
  const source = input || {};

  const quota = checkQuota(source);
  const shed = shedDecision(source);
  const delay = shed.ok && (shed.observed.neverShed === true) ? { ok: true, reason: null, sentence: null, observed: { neverShed: true } } : checkQueueDelay(source);

  const controls = Object.freeze({
    quota: Object.freeze(quota),
    shed: Object.freeze(shed),
    // A custodial Leg is not declined for queue delay either: §20.5's global-admission
    // control declines "new missions", and a RECOVERY or TRANSFER Leg is the discharge
    // of an obligation the fleet has already incurred physically. Declining it would
    // leave the goods where they are, which is the outcome the control exists to avoid
    // rather than one it may choose.
    queueDelay: Object.freeze(delay),
  });

  if (!quota.ok) {
    return { verdict: VERDICT.DECLINE, admitted: false, reason: quota.reason, sentence: quota.sentence, controls };
  }
  if (!shed.ok) {
    const verdict = shed.reason === REASON.UNKNOWN_PURPOSE ? VERDICT.DECLINE : VERDICT.SHED;
    return { verdict, admitted: false, reason: shed.reason, sentence: shed.sentence, controls };
  }
  if (!delay.ok) {
    return { verdict: VERDICT.DECLINE, admitted: false, reason: delay.reason, sentence: delay.sentence, controls };
  }

  return { verdict: VERDICT.ADMIT, admitted: true, reason: null, sentence: null, controls };
}

module.exports = {
  VERDICT,
  REASON,
  SHED_LADDER,
  MAX_SHED_LEVEL,
  shedLadder,
  rungAt,
  checkQuota,
  checkQueueDelay,
  shedDecision,
  assess,
};
