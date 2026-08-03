"use strict";

/**
 * Leg purpose (§2.4).
 *
 * > `purpose` is an explicit, durable, first-class attribute of every Leg, set at
 * > creation and never mutated. It exists because several mechanisms in this design
 * > need to distinguish *why* a Leg exists, and leaving that distinction implicit
 * > forces each of them to invent its own test — inconsistently, and in ways that a
 * > future call site can quietly get wrong.
 *
 * This module is that single test. `custodial_purposes` and `speculative_purposes`
 * are defined **once**, here, and derived from the same table that states each
 * purpose's cancellability and preemptibility — so the three facts cannot drift
 * apart the way three hand-maintained lists would.
 *
 * Consumers, each of which the specification names:
 *   - §4.6 cancellation — the guard is `cancel_requested_at IS NULL OR purpose ∈
 *     custodial_purposes`, and the *unqualified* guard blocks its own mandated
 *     recovery path.
 *   - §4.8 preemption — `RECOVERY` and `TRANSFER` are never preemptible.
 *   - §20.5 admission control — `custodial_purposes` are never shed;
 *     `speculative_purposes` are shed first.
 *   - §21.2 decision records and §7.7 rejection telemetry — purpose is a reported
 *     dimension, so "what fraction of this shard's capacity is going to recovery
 *     work" is a query rather than an inference.
 */

/**
 * The six purposes of §2.4, with the properties that table states for each.
 *
 * `cancellableByRequester` and `preemptible` are recorded as data rather than as
 * conditionals elsewhere: a mechanism that needs to know whether it may cancel or
 * preempt a Leg reads it from here.
 */
const PURPOSES = Object.freeze({
  PRIMARY: Object.freeze({
    name: "PRIMARY",
    createdBy: "Intake, from a customer Task (§3.4)",
    cancellableByRequester: true,
    preemptible: "BY_CLASS_RULES",
    custodial: false,
    speculative: false,
    note: "The ordinary case.",
  }),
  RECOVERY: Object.freeze({
    name: "RECOVERY",
    createdBy: "The recovery machinery: return-or-transfer after cancellation with custody held, or after an unrecoverable fault (§4.6, §4.7)",
    cancellableByRequester: false,
    preemptible: "NEVER",
    custodial: true,
    speculative: false,
    note: "Discharges a custody obligation that already exists.",
  }),
  TRANSFER: Object.freeze({
    name: "TRANSFER",
    createdBy: "The reassignment protocol, to collect goods from an incumbent agent (§4.7)",
    cancellableByRequester: false,
    preemptible: "NEVER",
    custodial: true,
    speculative: false,
    note: "A RECOVERY-class Leg with a custody handoff Stop.",
  }),
  REPOSITION: Object.freeze({
    name: "REPOSITION",
    createdBy: "Repositioning Planner (§17.3)",
    cancellableByRequester: "NOT_APPLICABLE",
    preemptible: "FREELY",
    custodial: false,
    speculative: true,
    note: "Speculative; first to be shed under load. No customer.",
  }),
  EXERCISE: Object.freeze({
    name: "EXERCISE",
    createdBy: "Agent-starvation detection (§17.5)",
    cancellableByRequester: "NOT_APPLICABLE",
    preemptible: "FREELY",
    custodial: false,
    speculative: true,
    note: "Periodic self-test and proving runs.",
  }),
  MAINTENANCE_TRANSIT: Object.freeze({
    name: "MAINTENANCE_TRANSIT",
    createdBy: "Maintenance interaction (§16.6)",
    cancellableByRequester: false,
    preemptible: "NEVER",
    custodial: false,
    speculative: false,
    note: "Transit to a service bay.",
  }),
});

/** Every purpose name, in the order §2.4 tabulates them. */
const PURPOSE_NAMES = Object.freeze(Object.keys(PURPOSES));

/**
 * `custodial_purposes` = {RECOVERY, TRANSFER} (§2.4).
 *
 * Derived from the table rather than restated, so a seventh purpose added by a
 * later phase cannot be custodial in one place and not in another.
 */
const CUSTODIAL_PURPOSES = Object.freeze(
  PURPOSE_NAMES.filter((name) => PURPOSES[name].custodial),
);

/** `speculative_purposes` = {REPOSITION, EXERCISE} (§2.4). */
const SPECULATIVE_PURPOSES = Object.freeze(
  PURPOSE_NAMES.filter((name) => PURPOSES[name].speculative),
);

/**
 * @param {unknown} purpose
 * @returns {boolean} whether this is one of the six §2.4 purposes
 */
function isPurpose(purpose) {
  return typeof purpose === "string" && Object.prototype.hasOwnProperty.call(PURPOSES, purpose);
}

/**
 * @param {string} purpose
 * @returns {object} the purpose's §2.4 row
 * @throws {Error} on an unknown purpose — an unrecognised purpose is never treated
 *   as the permissive default, because purpose gates cancellation, preemption, and
 *   shedding (T2: unknown is never permission)
 */
function purposeOf(purpose) {
  if (!isPurpose(purpose)) {
    throw new Error(
      `unknown Leg purpose "${String(purpose)}". §2.4 defines exactly: ${PURPOSE_NAMES.join(", ")}.`,
    );
  }
  return PURPOSES[purpose];
}

/**
 * Is this Leg's purpose custodial — that is, does the Leg exist to discharge an
 * outstanding physical obligation (§2.4)?
 *
 * Custodial Legs are exempt from the cancellation guard (§4.6), are never
 * preemptible (§4.8), and are never shed by admission control (§20.5).
 *
 * @param {string} purpose
 * @returns {boolean}
 */
function isCustodial(purpose) {
  return purposeOf(purpose).custodial;
}

/**
 * Is this Leg speculative — no customer commitment, shed first under load (§2.4)?
 *
 * @param {string} purpose
 * @returns {boolean}
 */
function isSpeculative(purpose) {
  return purposeOf(purpose).speculative;
}

/**
 * §4.8: `RECOVERY` and `TRANSFER` are never preemptible; speculative purposes are
 * preemptible without penalty; `PRIMARY` is preemptible by class rules.
 *
 * @param {string} purpose
 * @returns {boolean} false only where §2.4 states "Never"
 */
function isPreemptible(purpose) {
  return purposeOf(purpose).preemptible !== "NEVER";
}

/**
 * §20.5: admission control sheds by purpose before it sheds by class, and
 * `custodial_purposes` are **never** shed.
 *
 * @param {string} purpose
 * @returns {boolean}
 */
function isSheddable(purpose) {
  return !purposeOf(purpose).custodial;
}

/**
 * §4.6: may the *requester* cancel a Leg with this purpose?
 *
 * Returns false for `NOT_APPLICABLE` as well as for an explicit no: a Leg with no
 * customer has no requester who could cancel it.
 *
 * @param {string} purpose
 * @returns {boolean}
 */
function isCancellableByRequester(purpose) {
  return purposeOf(purpose).cancellableByRequester === true;
}

module.exports = {
  PURPOSES,
  PURPOSE_NAMES,
  CUSTODIAL_PURPOSES,
  SPECULATIVE_PURPOSES,
  isPurpose,
  purposeOf,
  isCustodial,
  isSpeculative,
  isPreemptible,
  isSheddable,
  isCancellableByRequester,
};
