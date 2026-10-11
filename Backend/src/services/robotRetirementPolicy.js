"use strict";

/**
 * What "retired" means for a robot, stated once — the pure half of soft retirement.
 *
 * ── The mechanism is the one the engine already honours ──────────────────────
 * A retired robot is a `Robot` row whose `Agent.lifecycleState` is `DECOMMISSIONED` (§2.1,
 * "Permanently withdrawn"). There is no retirement column and no new status value: F2,
 * the availability index, the reconciler and the starvation detector already refuse every
 * lifecycle state but `ACTIVE`, so the assignment engine needed no change to stop
 * assigning a retired unit. What this module adds is the same answer for the readers that
 * look only at the legacy `Robot` row — socket AUTH, the simulator, the dashboard lists and
 * the per-robot operator endpoints.
 *
 * Retirement used to be a hard delete. It failed with a RESTRICT violation (SQLSTATE 23001) for
 * every robot the engine had ever offered work, because `Commitment.agentId` and
 * `Outbox.agentId` are `ON DELETE RESTRICT`, and where it succeeded it destroyed the
 * robot's telemetry, commands and observations and detached its tasks and events.
 * `robotRetirement.service.js` is the transition; this file is only the predicate.
 *
 * Pure on purpose: `simulation/simulationPolicy.js` reads it, and the simulator must not
 * import the database layer (`tests/engine/simulationBoundary.test.js`).
 */

const { LIFECYCLE_STATES } = require("../engine/domain/agent");

/** The §2.1 lifecycle state a retired robot's Agent carries. @structural */
const RETIRED_LIFECYCLE_STATE = LIFECYCLE_STATES.DECOMMISSIONED.name;

/** The refusal a retired robot receives from every operator endpoint. @structural wire value */
const ROBOT_RETIRED = "ROBOT_RETIRED";

/**
 * Is this Agent (or anything carrying `lifecycleState`) retired?
 * @param {{ lifecycleState?: unknown }|null|undefined} agent
 * @returns {boolean}
 */
function isRetiredAgent(agent) {
  return Boolean(agent) && agent.lifecycleState === RETIRED_LIFECYCLE_STATE;
}

/**
 * Is this Robot row retired? The row must have been read with `agent.lifecycleState`
 * (`lifecycleSelect()`); a row without its Agent is not retired — retirement always leaves
 * one behind, because it creates the Agent when an older robot has none.
 *
 * @param {{ agent?: { lifecycleState?: unknown }|null }|null|undefined} robot
 * @returns {boolean}
 */
function isRetiredRobot(robot) {
  return Boolean(robot) && isRetiredAgent(robot.agent);
}

/**
 * The relation select that lets `isRetiredRobot` answer. A function, so every caller gets
 * its own object to merge into a larger `select`.
 * @returns {{ agent: { select: { lifecycleState: true } } }}
 */
function lifecycleSelect() {
  return { agent: { select: { lifecycleState: true } } };
}

/**
 * A `Robot` filter that keeps every robot that is not retired — including a robot with no
 * Agent row at all, which is how an older unit that was never projected appears.
 * @returns {object}
 */
function notRetiredRobotWhere() {
  return { NOT: { agent: { is: { lifecycleState: RETIRED_LIFECYCLE_STATE } } } };
}

module.exports = {
  RETIRED_LIFECYCLE_STATE,
  ROBOT_RETIRED,
  isRetiredAgent,
  isRetiredRobot,
  lifecycleSelect,
  notRetiredRobotWhere,
};
