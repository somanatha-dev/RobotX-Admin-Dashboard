/**
 * Simulated-vs-physical identity, and simulator runtime state, as two separate questions.
 *
 * ── Why they are two questions and not one ──────────────────────────────────
 * `simulated` is what a unit **is**: a row in the fleet database that no hardware will
 * ever claim. Whether a `VirtualRobot` is currently driving it is what the unit is
 * **doing**, and the two come apart in the deployment's default configuration — the
 * simulator is opt-in (`ENABLE_VIRTUAL_SIMULATOR`), so a simulated robot normally exists
 * in the database with nothing running it at all.
 *
 * Conflating them is a specific, already-paid-for mistake in this codebase: commissioning
 * used to write `isOnline: true` because a record had been created, and that invented
 * liveness travelled into the assignment engine's feasibility gate. So nothing here
 * derives liveness from identity. `isOnline` is the fleet's own report and is not
 * mentioned in this file.
 *
 * Everything here is pure — no fetch, no React, no DOM — so the rules can be tested
 * directly rather than through a rendered page. `src/__architecture__/` does that.
 */

/** What a unit *is*. Three-valued, because "not told" is not the same as "physical". */
export const IDENTITY = Object.freeze({
  SIMULATED: 'SIMULATED',
  PHYSICAL: 'PHYSICAL',
  UNKNOWN: 'UNKNOWN',
});

/**
 * What a simulated unit is *doing*. The first two are the backend's own vocabulary —
 * `POST /api/simulator/robot` answers with exactly these two strings — so the UI and the
 * API describe the same two outcomes with the same two words.
 *
 * `UNKNOWN` is this file's addition and it is not a third backend state: it is what the
 * UI shows when it could not read the simulator's status at all. Showing
 * PERSISTED_NOT_RUNNING in that case would be asserting something nobody measured.
 */
export const RUNTIME = Object.freeze({
  RUNNING: 'RUNNING',
  PERSISTED_NOT_RUNNING: 'PERSISTED_NOT_RUNNING',
  UNKNOWN: 'UNKNOWN',
});

/**
 * Is this robot a simulated unit?
 *
 * Strict on `true` and strict on `false`, with everything else UNKNOWN. The backend
 * projection (`services/robotProjection.js`) guarantees the field is present and boolean
 * on every robot payload, so UNKNOWN means the row did not come from there — and
 * defaulting it to PHYSICAL would render a simulated unit as hardware, which is the one
 * outcome this whole step exists to prevent.
 *
 * @param {{ simulated?: unknown }|null|undefined} robot
 * @returns {'SIMULATED'|'PHYSICAL'|'UNKNOWN'}
 */
export function identityOf(robot) {
  if (!robot || typeof robot !== 'object') return IDENTITY.UNKNOWN;
  if (robot.simulated === true) return IDENTITY.SIMULATED;
  if (robot.simulated === false) return IDENTITY.PHYSICAL;
  return IDENTITY.UNKNOWN;
}

/** Convenience predicate. Same strictness as `identityOf`. */
export function isSimulated(robot) {
  return identityOf(robot) === IDENTITY.SIMULATED;
}

/**
 * The runtime state of the simulator instance backing this robot, if any.
 *
 * @param {object} robot a robot row from `GET /api/robots/state`
 * @param {object|null} simulatorStatus the body of `GET /api/simulator/status`, or `null`
 *   when that call has not succeeded (not yet made, refused, or the endpoint answered 503)
 * @returns {'RUNNING'|'PERSISTED_NOT_RUNNING'|'UNKNOWN'|null} `null` for a unit that is
 *   not simulated — a physical robot has no simulator runtime, and reporting one as "not
 *   running" would invite the reader to look for a simulator that should never exist.
 */
export function runtimeStatusOf(robot, simulatorStatus) {
  if (!isSimulated(robot)) return null;

  // Not measured. Say so.
  if (!simulatorStatus || typeof simulatorStatus !== 'object') return RUNTIME.UNKNOWN;

  const entry =
    Array.isArray(simulatorStatus.robots)
      ? simulatorStatus.robots.find(
          (candidate) => candidate && String(candidate.robotId || '') === String(robot.robotId || ''),
        )
      : undefined;
  const managed = Boolean(entry);

  // ── STEP 4: the instance's own answer, where it gives one ───────────────────
  //
  // This used to be `enabled && started && managed` alone, and it was wrong in a way the
  // backend has since been fixed not to produce: `started` was an engine-level flag that
  // `SimulationEngine.start()` set without starting anything, so a fleet stopped by
  // `POST /api/simulator/stop` and then started again had no sockets and no tick timers
  // while every one of its robots was labelled RUNNING here.
  //
  // The engine now starts what it claims to have started, so the conjunction is no longer
  // false in that case — but it is still an *inference*, and the snapshot now carries the
  // fact: `running` is the instance's tick timer. Asking the instance is the difference
  // between "the engine believes it is running robots" and "this robot is running", which
  // is exactly the distinction the rest of this module exists to keep.
  //
  // The conjunction remains the fallback for a snapshot from a backend that does not send
  // the field, so an older server is read the way it was before rather than reported as
  // stopped.
  const running =
    simulatorStatus.enabled === true &&
    managed &&
    (typeof entry.running === 'boolean' ? entry.running : simulatorStatus.started === true);

  return running ? RUNTIME.RUNNING : RUNTIME.PERSISTED_NOT_RUNNING;
}

/**
 * A short sentence saying *why* a simulated unit is not running, for the cases where the
 * bare status would leave an operator guessing. Returns `null` when there is nothing to
 * add beyond the status itself.
 *
 * @param {'RUNNING'|'PERSISTED_NOT_RUNNING'|'UNKNOWN'|null} status
 * @param {object|null} simulatorStatus
 * @param {object|null} [robot] the robot the status is about. Optional, and only needed to
 *   tell "this engine holds no instance for the unit" from "it holds one that is stopped" —
 *   two situations an operator fixes differently. Omitting it costs the more specific of
 *   the two sentences, not correctness.
 * @returns {string|null}
 */
export function runtimeReason(status, simulatorStatus, robot) {
  if (status === RUNTIME.UNKNOWN) {
    return 'Simulator status could not be read, so whether this unit is running is not known.';
  }
  if (status !== RUNTIME.PERSISTED_NOT_RUNNING) return null;
  if (simulatorStatus && simulatorStatus.enabled !== true) {
    return 'The simulator is disabled in this deployment. The unit exists in the database and nothing is driving it.';
  }
  if (simulatorStatus && simulatorStatus.started !== true) {
    return 'The simulator is enabled but not started. The unit exists in the database and nothing is driving it.';
  }

  // STEP 4 — the case the old wording got wrong. A robot the engine holds an instance for,
  // where that instance is not ticking, is not a unit that "exists in the database only":
  // it exists in the simulator and is stopped, which is fixed by starting the simulator
  // rather than by wondering why creation did not take.
  const entry =
    robot && simulatorStatus && Array.isArray(simulatorStatus.robots)
      ? simulatorStatus.robots.find(
          (candidate) => candidate && String(candidate.robotId || '') === String(robot.robotId || ''),
        )
      : undefined;
  if (entry && entry.running === false) {
    return 'The simulator holds an instance for this unit but it is not running. Nothing is driving it.';
  }

  return 'No simulator instance is running this unit. It exists in the database only.';
}

/** Human label for a runtime status. The status strings themselves are already the label. */
export function runtimeLabel(status) {
  if (status === RUNTIME.RUNNING) return 'RUNNING';
  if (status === RUNTIME.PERSISTED_NOT_RUNNING) return 'PERSISTED_NOT_RUNNING';
  if (status === RUNTIME.UNKNOWN) return 'STATUS UNKNOWN';
  return '';
}
