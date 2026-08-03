"use strict";

/**
 * Custody (§2.5) — **Tier 0**, mechanism T0-07.
 *
 * > Custody is possession of physical goods. It is tracked explicitly because it
 * > changes what recovery is *physically possible*, and the baseline system has no
 * > representation of it at all.
 *
 * > A failure before custody is a scheduling problem: cancel, requeue, reassign,
 * > done. A failure after custody is a *physical logistics problem*: the goods are
 * > inside a stalled machine at a location, and no amount of database repair moves
 * > them. The engine MUST NOT model these as the same event, and MUST NOT mark a
 * > Task requeueable while custody is `HELD`.
 *
 * Phase 2 lands the state vocabulary and the two questions every later mechanism
 * asks of it: *does this state hold goods*, and *may this Leg be reassigned without
 * a physical intervention*. Phases 4, 5, and 7 land the transitions, the evidence,
 * and the manifest reconciliation that drive it.
 *
 * Invariants this vocabulary serves: I7 (an agent is never returned to the
 * available pool while custody is outstanding — custody release strictly precedes
 * commitment release at settlement, §4.9) and I8 (a Leg terminates only once
 * custody is discharged, §4.4).
 */

/**
 * The five custody states of §2.5, each with the recovery semantics that table
 * states for it. The semantics are data, not a switch statement somewhere else,
 * because §4.7's three lawful outcomes and §12.2's expiry handling both read them.
 */
const CUSTODY_STATES = Object.freeze({
  NONE: Object.freeze({
    name: "NONE",
    meaning: "Agent carries nothing for this task",
    holdsGoods: false,
    recovery: "Reassign freely; no physical intervention",
    reassignableWithoutIntervention: true,
    terminal: false,
  }),
  PENDING_TRANSFER: Object.freeze({
    name: "PENDING_TRANSFER",
    meaning: "At the pickup, handover in progress",
    holdsGoods: false,
    recovery: "Abort is safe; may require sender re-engagement",
    reassignableWithoutIntervention: true,
    terminal: false,
  }),
  HELD: Object.freeze({
    name: "HELD",
    meaning: "Agent physically carries the goods",
    holdsGoods: true,
    recovery: "Reassignment requires physical goods recovery — a TRANSFER Leg or human retrieval (§2.4, §4.7)",
    reassignableWithoutIntervention: false,
    terminal: false,
  }),
  RELEASED: Object.freeze({
    name: "RELEASED",
    meaning: "Delivered and confirmed",
    holdsGoods: false,
    recovery: "Task complete pending verification",
    reassignableWithoutIntervention: true,
    terminal: true,
  }),
  DISPUTED: Object.freeze({
    name: "DISPUTED",
    meaning: "Evidence conflicts",
    recovery: "Operator adjudication required; no automatic action",
    // Unknown is never permission (T2). Disputed evidence means the engine does not
    // know where the goods are, and "does not know" resolves to "may be holding".
    holdsGoods: true,
    reassignableWithoutIntervention: false,
    terminal: false,
  }),
});

/** Every custody state name. */
const CUSTODY_STATE_NAMES = Object.freeze(Object.keys(CUSTODY_STATES));

/**
 * @param {unknown} state
 * @returns {boolean}
 */
function isCustodyState(state) {
  return typeof state === "string" && Object.prototype.hasOwnProperty.call(CUSTODY_STATES, state);
}

/**
 * @param {string} state
 * @returns {object} the state's §2.5 row
 * @throws {Error} on an unknown state. An unrecognised custody state is never read
 *   as `NONE`: the baseline's defining failure mode is a negative signal silently
 *   becoming a permissive default (§2.7, T2).
 */
function custodyOf(state) {
  if (!isCustodyState(state)) {
    throw new Error(
      `unknown custody state "${String(state)}". §2.5 defines exactly: ${CUSTODY_STATE_NAMES.join(", ")}. ` +
        "An unrecognised custody state is never treated as NONE.",
    );
  }
  return CUSTODY_STATES[state];
}

/**
 * Does this state mean the agent may be physically holding goods?
 *
 * `DISPUTED` answers **true**: the evidence conflicts, so the engine does not know,
 * and not knowing resolves to the conservative case (T2, §7.3).
 *
 * @param {string} state
 * @returns {boolean}
 */
function holdsGoods(state) {
  return custodyOf(state).holdsGoods;
}

/**
 * May a Leg in this custody state be reassigned by the database alone (§4.7)?
 *
 * False means a physical recovery is required — a `TRANSFER` Leg where the
 * receiving agent is `custody_transfer_capable`, or human-mediated retrieval. Most
 * fleets have no transfer-capable agents, which is why `custody_transfer_capable`
 * defaults to false (§2.3).
 *
 * @param {string} state
 * @returns {boolean}
 */
function isReassignableWithoutIntervention(state) {
  return custodyOf(state).reassignableWithoutIntervention;
}

/**
 * §2.5, §4.7, invariant I7: a Task MUST NOT be marked requeueable while custody is
 * `HELD`. Stated as a positive predicate so no call site has to remember to negate.
 *
 * @param {string} state
 * @returns {boolean}
 */
function isRequeueable(state) {
  return !holdsGoods(state);
}

/**
 * §4.9 / I7: settlement releases custody **strictly before** it releases the
 * commitment, and an agent is never returned to the available pool while custody is
 * outstanding. This is the predicate that question reduces to.
 *
 * @param {string} state
 * @returns {boolean} whether custody has been discharged
 */
function isDischarged(state) {
  const row = custodyOf(state);
  return row.name === CUSTODY_STATES.RELEASED.name || row.name === CUSTODY_STATES.NONE.name;
}

module.exports = {
  CUSTODY_STATES,
  CUSTODY_STATE_NAMES,
  isCustodyState,
  custodyOf,
  holdsGoods,
  isReassignableWithoutIntervention,
  isRequeueable,
  isDischarged,
};
