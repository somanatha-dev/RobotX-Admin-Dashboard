/**
 * What the robot command buttons may promise, given the backend's V1 behaviour.
 *
 * ── The rule these texts describe (backend, §23.5 — not changed here) ───────
 * STOP and PAUSE put a unit in PAUSED. Leaving PAUSED needs the unit's own report that it
 * is fit again, and under the assignment engine that self-report is refused, because a
 * false "I'm fine" risks an incident. RESUME is therefore delivered (`delivered: true`)
 * and changes nothing: the unit stays PAUSED and out of assignment.
 *
 * So in V1, STOP and PAUSE are one-way from the dashboard, and RESUME is not offered.
 * The command endpoint and its payload are unchanged; only what the UI offers and says is.
 */

import { taskRobotCode } from './liveState.js';

/** Commands that take a unit out of service with no dashboard way back in V1. */
export const ONE_WAY_COMMANDS = Object.freeze(['STOP', 'PAUSE']);

export const RESUME_UNAVAILABLE_REASON =
  'Resume is not available in V1. A paused unit cannot return itself to service: the backend ' +
  'refuses the unit\'s own report that it is fit again (§23.5), so RESUME would be delivered ' +
  'and change nothing.';

const ONE_WAY_WARNING =
  'One-way in V1: the unit goes to PAUSED and leaves assignment. It cannot be resumed from ' +
  'the dashboard (§23.5).';

export const STOP_ALL_WARNING =
  'One-way in V1: every online unit is sent STOP and goes to PAUSED. None of them can be ' +
  'resumed from the dashboard (§23.5), so the whole fleet leaves assignment.';

/** @param {string} type */
export function isOneWayCommand(type) {
  return ONE_WAY_COMMANDS.includes(String(type || '').toUpperCase());
}

/*
 * ── RETURN (FS-05; the backend half is BG-09, not changed here) ─────────────
 * RETURN goes from the command endpoint straight to the unit; the assignment engine takes
 * no part. The unit drops what it is doing and reports IDLE (VirtualRobot
 * `_applyReturnToBase`). Measured on a unit executing a delivery: the Task stayed ASSIGNED
 * and its Leg active with a live commitment for about 1.5 min, then went REASSIGNING, and
 * another robot was sent at about 2.4 min (2.8 min in a second run). RETURN is therefore not a completion and not a
 * cancellation, and while a unit holds a task it is not offered at all.
 */
export const RETURN_WARNING =
  'RETURN is sent directly to the unit; the assignment engine takes no part. The unit ' +
  'abandons whatever it is doing and reports IDLE. It does not complete or cancel any task.';

/** @param {string} taskId */
export function returnBusyReason(taskId) {
  return (
    `RETURN is not available while this unit holds task ${taskId}. RETURN bypasses the ` +
    'assignment engine: the unit would abandon the delivery while the engine still holds ' +
    'it assigned, and the delivery would only be reassigned after the engine\'s own ' +
    'recovery (measured: about 2.5–3 min). It would neither complete nor cancel the task.'
  );
}

const TASK_HOLDING_STATUSES = new Set(['ASSIGNED', 'IN_PROGRESS', 'VERIFYING']);

/**
 * The task the backend says this unit holds, or null. Read from the robot row's
 * `currentTask` (`Robot.currentTaskId`, which the engine's assignment projection binds and
 * unbinds) and, between refetches, from any non-terminal task naming this unit's code.
 * Either source is enough: offering RETURN on a unit that holds a delivery is the unsafe
 * direction.
 *
 * @param {object} robot a row of the provider's robot list
 * @param {object[]} tasks the provider's task list
 */
export function heldTaskId(robot, tasks) {
  const own = robot?.currentTask?.taskId || null;
  if (own) return String(own);
  const code = String(robot?.robotId || '').trim();
  if (!code || !Array.isArray(tasks)) return robot?.currentTaskId ? String(robot.currentTaskId) : null;
  const bound = tasks.find(
    (t) => TASK_HOLDING_STATUSES.has(String(t?.status || '').toUpperCase()) && taskRobotCode(t) === code,
  );
  if (bound) return String(bound.taskId || bound.id);
  return robot?.currentTaskId ? String(robot.currentTaskId) : null;
}

/**
 * Whether RETURN may be offered for this unit, and what to say either way.
 *
 * @returns {{ available: boolean, reason: string|null }}
 */
export function returnAvailability(robot, tasks) {
  const taskId = heldTaskId(robot, tasks);
  return taskId ? { available: false, reason: returnBusyReason(taskId) } : { available: true, reason: null };
}

/**
 * The warning the authorisation dialog shows before sending `type`, or null.
 *
 * @param {string} type
 * @returns {string|null}
 */
export function commandWarning(type) {
  if (isOneWayCommand(type)) return ONE_WAY_WARNING;
  if (String(type || '').toUpperCase() === 'RETURN') return RETURN_WARNING;
  return null;
}

/**
 * Summarise the answers of a fleet-wide STOP without inventing any robot state: only what
 * the backend said about each request.
 *
 * @param {PromiseSettledResult<{ delivered?: boolean }>[]} results
 * @returns {{ total: number, delivered: number, accepted: number, failed: number }}
 */
export function summariseStopAll(results) {
  const list = Array.isArray(results) ? results : [];
  const fulfilled = list.filter((r) => r && r.status === 'fulfilled');
  return {
    total: list.length,
    accepted: fulfilled.length,
    delivered: fulfilled.filter((r) => r.value && r.value.delivered === true).length,
    failed: list.length - fulfilled.length,
  };
}
