"use strict";

/**
 * §4.5's deadline for a Leg state entered by a path that does not run §4.4's table —
 * **Tier 0 by consequence**.
 *
 * ── The defect this module exists to close (X2a / X2b) ─────────────────────
 * §4.5's obligation is unconditional and it is invariant **I4**:
 *
 * > Every non-terminal state has a deadline, and the deadline is registered in the
 * > transaction that enters the state.
 *
 * `lifecycle/transitions.apply()` discharges it for every state it enters. Four production
 * paths enter a Leg state **without** going through it, and none of them registered a
 * deadline. Phase 5's own adversarial closure reproduced two of them by name against a live
 * database — X2a and X2b — and routed them here, to the Phase 15 cutover, because
 * `dispatch/offers.js`'s own header had already said where they belonged:
 *
 * > every Leg write there is conditional on the version, *"which is the property Phase 5's
 * > machine will preserve **when it takes ownership of the transitions**"*.
 *
 * The four, as the tree has them:
 *
 * | path | writes | supervised before |
 * |---|---|---|
 * | `offers.applyAccept` ← `OFFER_ACCEPT` | `OFFERED → ACCEPTED` | no — X2a |
 * | `offers.applyReject` ← `OFFER_REJECT` | `OFFERED → QUEUED` | no |
 * | `offers.applyDefer` ← `OFFER_DEFER` | `OFFERED → PLANNED` | no |
 * | `offers.withdrawExpiredOffer` ← `outbox.worker` §11.4 step 2 | `OFFERED → QUEUED` | no — X2b |
 *
 * X2b is the sharpest of the four, and it is the one that makes this Phase 15's rather than
 * a note for somebody: **Phase 5's own `WITHDRAW_EXCLUDE_REPLAN` handler registers that
 * deadline**, and the outbox worker reaches the same `offers.withdrawExpiredOffer` from the
 * delivery side and did not. Two production paths to one state with different supervision
 * semantics is a divergence that produces an unsupervised Leg depending on which of two
 * racing supervisors won — and the outbox path became live only when Phase 15 wired the
 * worker into the composition root. Phase 15 made it reachable; Phase 15 owns it.
 *
 * Left alone, X2a is the more expensive one in service: an `ACCEPTED` Leg with no
 * `execute.start_grace` deadline is an agent that went silent after accepting and is never
 * probed and never reassigned — which is the "stuck `ASSIGNED`" family the whole engine
 * exists to remove, arrived at from inside the mechanism built to prevent it.
 *
 * ── Why this registers a deadline and does not run §4.4 ────────────────────
 * The tempting fix is to route these four writes through `transitions.apply()`. It is the
 * wrong fix, and the reason is worth stating because it looks like the more principled one.
 *
 * §4.4 has a row for two of the four — `OFFERED → ACCEPTED` on `AGENT_ACK` and
 * `OFFERED → QUEUED` on `AGENT_NACK` — and **no row at all** for `OFFERED → PLANNED`, which
 * is what §11.2's `DEFER` performs. Routing three of four through the table and leaving the
 * fourth out would reintroduce the divergence one layer in; adding a row for the fourth
 * would be writing a §4.4 transition the frozen specification does not contain, which is the
 * invention Phase 5 refused for §4.2 and this phase refuses here.
 *
 * The obligation these paths actually breach is **§4.5's**, not §4.4's, and §4.5 is
 * satisfiable without deciding anything §4.4 leaves open: the state's deadline parameter
 * comes from the state's own machine, and the timer is written in the transaction that
 * entered the state. That is exactly what `expiryActions.withdrawExcludeReplan` does for the
 * one path Phase 5 owned, and this module is that step with one implementation instead of
 * four.
 *
 * Taking ownership of the *transitions* remains open, and it remains §4.4's question. It is
 * recorded as such rather than settled by a fix aimed at a different invariant.
 *
 * ── Fail closed: an unresolvable deadline rolls the write back ─────────────
 * If the state's parameter does not resolve, this throws, and the caller's transaction
 * — the one that just wrote the Leg — rolls back with it. That is deliberate and it follows
 * Phase 5's precedent verbatim: *"committing the withdrawal while failing to arm the
 * requeued Leg's deadline produces exactly the unsupervised state §4.5 exists to prevent,
 * and it would be produced here."* An agent whose `OFFER_ACCEPT` is rolled back retries
 * against an offer that is still open; a Leg accepted into permanent unsupervision does not
 * recover on its own.
 *
 * ── No clock, no configuration read ────────────────────────────────────────
 * The store time and the resolved duration are supplied. The *parameter name* is not — it
 * is read from `legMachine.deadlineFor(state)`, so there is no second table mapping states
 * to parameters that could drift from §4.3.
 */

const legMachine = require("../lifecycle/legMachine");
const timers = require("../supervision/timers");

/** @structural what `superviseEntry` did, for the caller's own record */
const OUTCOME = Object.freeze({
  /** The entered state's deadline is armed and the exited state's timers are cancelled. */
  SUPERVISED: "SUPERVISED",
  /** The state is terminal, or §4.3 records it as one of the states with no deadline. */
  NO_DEADLINE_REQUIRED: "NO_DEADLINE_REQUIRED",
});

/**
 * The parameter that governs a Leg state's exit deadline, from the state's own machine.
 *
 * Returns `null` for a state §4.3 gives a **projected** deadline (`execute.eta_tolerance`
 * is a multiplier on a mission's projected ETA, not a duration) — none of this module's
 * four callers enters such a state, and returning the multiplier as seconds would arm an
 * `EN_ROUTE` Leg with a deadline of "1.3 seconds".
 *
 * @param {string} state
 * @returns {string|null}
 */
function deadlineParameterFor(state) {
  const spec = legMachine.deadlineFor(state);
  if (!spec || spec.projected === true) return null;
  return spec.parameter || null;
}

/**
 * Resolve a Leg state's exit deadline, in seconds, from a published configuration.
 *
 * The parameter name comes from the state's own machine, so a caller never names a
 * parameter and there is no second table of "which parameter supervises which state" to
 * drift from §4.3. A value that does not resolve is returned as `undefined` rather than
 * defaulted, and `superviseEntry` refuses it — §22.1 admits no behavioural constant outside
 * the register, least of all one invented at the moment supervision is being armed.
 *
 * @param {{ get: (name: string) => any }|null|undefined} values a snapshot's `values` map
 * @param {string} state
 * @returns {number|undefined}
 */
function deadlineSecondsFrom(values, state) {
  const parameter = deadlineParameterFor(state);
  if (!parameter) return undefined;
  const seconds = values && typeof values.get === "function" ? values.get(parameter) : undefined;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

/**
 * Arm the §4.5 deadline of the Leg state this transaction has just entered, and cancel the
 * deadline of the state it left.
 *
 * **Both halves, in the caller's transaction.** Cancelling without registering leaves an
 * unsupervised Leg; registering without cancelling leaves the exited state's deadline live,
 * and it fires against a Leg whose version has moved on — which discards correctly but
 * charges a handler pass for a deadline nobody owes.
 *
 * @param {object} tx the transaction that wrote the Leg
 * @param {object} input
 * @param {object} input.leg the Leg row **as it was before the write** — its `version` is
 *   incremented here, because §4.5 keys the timer on the version of the state being entered
 *   and the caller's conditional write has just produced `version + 1`
 * @param {string} input.state the state entered
 * @param {Date} input.storeTime the store's clock (§10.6)
 * @param {number|undefined} input.deadlineSeconds the resolved value of the state's own
 *   parameter; `undefined` is refused rather than defaulted
 * @param {string} input.event what caused the entry, recorded on the timer's payload
 * @param {string} [input.shardId]
 * @returns {Promise<{ outcome: string, state: string, parameter: string|null, timer: object|null }>}
 */
async function superviseEntry(tx, input) {
  const source = input || {};
  const leg = source.leg;
  const state = source.state;

  if (!leg || typeof leg.id !== "string" || leg.id === "") {
    throw new TypeError("superviseEntry names the Leg row whose state was just written");
  }
  if (typeof state !== "string" || state === "") {
    throw new TypeError("superviseEntry names the state that was entered");
  }

  // The exited state's deadline goes first, and unconditionally — including for a terminal
  // entry, where it is the only half there is. `transitions.apply` cancels on exit for the
  // same reason.
  await timers.cancelFor(tx, {
    entityType: timers.ENTITY_TYPE.LEG,
    entityId: leg.id,
    storeTime: source.storeTime,
    reason: `EXITED_${leg.state}`,
  });

  if (!timers.requiresTimer(timers.ENTITY_TYPE.LEG, state)) {
    return { outcome: OUTCOME.NO_DEADLINE_REQUIRED, state, parameter: null, timer: null };
  }

  const parameter = deadlineParameterFor(state);
  const spec = legMachine.deadlineFor(state);

  if (!Number.isFinite(source.deadlineSeconds) || source.deadlineSeconds <= 0) {
    // Rolling the caller's whole transaction back is the only honest option — see the
    // header. The message names the parameter, because "HANDLER_THREW" for a missing
    // register entry is the failure mode Phase 5 spent a live run to diagnose once already.
    throw new RangeError(
      `${parameter || "the deadline parameter"} did not resolve, so the Leg could not be armed on entering ` +
        `${state}. §4.5 registers a state's deadline in the transaction that enters it (I4); a write ` +
        "committed without one leaves a non-terminal Leg no component owns, which is the defect the " +
        "deadline exists to prevent.",
    );
  }

  const timer = await timers.register(tx, {
    entityType: timers.ENTITY_TYPE.LEG,
    entityId: leg.id,
    state,
    // The version the conditional write has just produced. Keying on the pre-write version
    // would arm a deadline the very next `assessFire` discards as stale.
    entity: { ...leg, version: leg.version + 1 },
    dueAt: timers.deadlineFrom(source.storeTime, source.deadlineSeconds),
    armedSeconds: source.deadlineSeconds,
    handler: spec.onExpiry,
    payload: { from: leg.state, event: source.event || null, armedBy: "cutover/legEntryDeadline" },
    shardId: source.shardId === null ? undefined : source.shardId,
  });

  return { outcome: OUTCOME.SUPERVISED, state, parameter, timer };
}

module.exports = { OUTCOME, deadlineParameterFor, deadlineSecondsFrom, superviseEntry };
