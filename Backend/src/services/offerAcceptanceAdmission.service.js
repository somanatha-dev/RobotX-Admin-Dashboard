"use strict";

/**
 * Commit-race closure, Gap A — may this robot's `OFFER_ACCEPT` bind it to work, given its
 * PERSISTED state now?
 *
 * The engine decides on a snapshot and commits under §10.3.2's volatile re-check, whose list is
 * frozen and does not include F3 (operator hold). A robot paused after the round decided was
 * therefore committed and offered. The ACCEPT is the binding point (`OFFERED → ACCEPTED`), and the
 * server answers it here from the `Robot` row — never from what the client reports about itself.
 *
 * The rule is the facts providers' own, not a new one:
 *   · HELD    — `Robot.status` PAUSED: F3's operator hold in BOTH providers
 *               (`simulatedAgentState.simulatedAgentFacts`, `fleetProviders/physicalFacts`) — an
 *               operator STOP/PAUSE (`robots.controller.placeOperatorHold`) or the unit's own report;
 *   · FAULTED — `Robot.status` ERROR: F8's BLOCKING fault in both providers.
 * An OFFLINE row is judged by the status it remembers (`statusBeforeOffline`), as the offline
 * sweep and reconnect restore it. Every other status is admitted, exactly as before.
 * A row that cannot be read cannot show the robot is not held: refused (fail closed).
 *
 * Pure.
 */

const f07 = require("../engine/feasibility/predicates/f07");
const { OUTCOME } = require("../engine/feasibility/threeValued");
const physicalFacts = require("./fleetProviders/physicalFacts");

/** @structural the refusal codes, as they appear in `ACCEPT_REFUSED:<code>` */
const REFUSAL = Object.freeze({
  HELD: "HELD",
  FAULTED: "FAULTED",
  ROBOT_UNREADABLE: "ROBOT_UNREADABLE",
  /** A physical robot's recorded stop latch is engaged (F7 VIOLATED). */
  ESTOP_ENGAGED: "ESTOP_ENGAGED",
  /** A physical robot's latch is missing, stale, unreadable, from a replaced socket, or undeclared. */
  ESTOP_NOT_PROVEN: "ESTOP_NOT_PROVEN",
});

/** `Robot.status` values that carry F3's hold. @structural both facts providers' rule */
const HELD_STATUSES = Object.freeze(["PAUSED"]);
/** `Robot.status` values that carry F8's BLOCKING fault. @structural both facts providers' rule */
const BLOCKING_FAULT_STATUSES = Object.freeze(["ERROR"]);

/**
 * @param {{ status?: string, statusBeforeOffline?: string|null }|null} robot the persisted row
 * @returns {{ admitted: boolean, code: string|null, reason: string|null }}
 */
function assess(robot) {
  if (!robot || typeof robot.status !== "string") {
    return { admitted: false, code: REFUSAL.ROBOT_UNREADABLE, reason: "the robot's persisted state could not be read" };
  }
  const status = robot.status === "OFFLINE" && typeof robot.statusBeforeOffline === "string" ? robot.statusBeforeOffline : robot.status;
  if (HELD_STATUSES.includes(status)) {
    return { admitted: false, code: REFUSAL.HELD, reason: `the robot is held (Robot.status ${robot.status}${status !== robot.status ? `, remembered ${status}` : ""})` };
  }
  if (BLOCKING_FAULT_STATUSES.includes(status)) {
    return { admitted: false, code: REFUSAL.FAULTED, reason: `the robot has a blocking fault (Robot.status ${robot.status}${status !== robot.status ? `, remembered ${status}` : ""})` };
  }
  return { admitted: true, code: null, reason: null };
}

/**
 * A PHYSICAL robot's stop latch at acceptance — F7, exactly as the decision and the commit apply it.
 *
 * The input is the one F7 already reads for a physical robot: the Pi's SOFTWARE stop-latch report
 * (`stopLatchObservation`), admitted only for the robot's current socket, turned into F7's fact by
 * `physicalFacts.emergencyStopFrom` under the owner's declared mechanism, and judged by
 * `predicates/f07` with `connectivity.max_heartbeat_age` at the store's time. Only SATISFIED admits:
 * engaged is ESTOP_ENGAGED; missing, stale, unreadable, from a replaced socket, or with no
 * declared mechanism is ESTOP_NOT_PROVEN (F7 is class I, indeterminate DENY).
 *
 * It is the robot's own software latch: no independent hardware e-stop signal exists to read.
 *
 * WHICH robots: those in the owner's physical fleet declaration (`isDeclaredPhysical`) — the roster
 * `physicalFacts` itself keys F7's latch fact on. It never reads the simulation discriminator
 * (`simulationBoundary.test.js` confines that to the lifecycle boundary). A robot outside the
 * declaration — every simulated robot, and any undeclared unit — has no latch fact anywhere: the
 * simulator states a simulated robot's F7, and an undeclared unit's F7 is absent, so the decision
 * and the commit already deny it. Nothing is relaxed by not judging it again here.
 *
 * @param {object} input
 * @param {{ socketId?: string|null }} input.robot the persisted row
 * @param {{ ok: boolean, state: object|null, problem: string|null }|null} input.latchRead `stopLatchObservation.readStopLatchState`
 * @param {object} input.policy the loaded physical fleet declaration (`physicalPolicy.load`) that declares this robot
 * @param {{ get: (name: string) => * }} input.config
 * @param {number} input.atMs the store's time
 * @returns {{ admitted: boolean, code: string|null, reason: string|null }}
 */
function assessEmergencyStop(input) {
  const { robot, latchRead, policy, config, atMs } = input || {};
  const notProven = (reason) => ({ admitted: false, code: REFUSAL.ESTOP_NOT_PROVEN, reason });
  if (!latchRead || !latchRead.ok) return notProven((latchRead && latchRead.problem) || "the stop latch could not be read");
  if (!policy) return notProven("no physical fleet declaration is loaded, so no stop mechanism is declared");

  const state = latchRead.state;
  const current = state && robot && typeof robot.socketId === "string" && state.socketId === robot.socketId ? state : null;
  const fact = physicalFacts.emergencyStopFrom({ latch: current, policy, asOfMs: atMs });
  const verdict = f07.evaluate({ agentSnapshot: { emergencyStop: fact }, config, decisionTimeMs: atMs });
  if (verdict.outcome === OUTCOME.SATISFIED) return { admitted: true, code: null, reason: null };
  if (verdict.outcome === OUTCOME.VIOLATED) {
    return { admitted: false, code: REFUSAL.ESTOP_ENGAGED, reason: verdict.reason || "the stop latch is engaged" };
  }
  const why = state && !current ? "the recorded latch was reported by a replaced socket" : verdict.reason || "F7 could not be satisfied";
  return notProven(why);
}

/**
 * Is this robot in the owner's physical fleet declaration? The roster F7's latch fact is keyed on.
 *
 * @param {object|null} policy `physicalPolicy.load` result, or null when the physical fleet is off
 * @param {string} robotId
 * @returns {boolean}
 */
function isDeclaredPhysical(policy, robotId) {
  return Boolean(policy && typeof policy.robotFor === "function" && robotId && policy.robotFor(robotId));
}

module.exports = { REFUSAL, HELD_STATUSES, BLOCKING_FAULT_STATUSES, assess, assessEmergencyStop, isDeclaredPhysical };
