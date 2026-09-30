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

/**
 * The warning the authorisation dialog shows before sending `type`, or null.
 *
 * @param {string} type
 * @returns {string|null}
 */
export function commandWarning(type) {
  return isOneWayCommand(type) ? ONE_WAY_WARNING : null;
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
