/**
 * Recommissioning a retired robot — the dashboard's pure half.
 *
 * `POST /api/robots/:robotId/recommission { reason, confirmRobotId }` returns a retired unit's
 * own record to the fleet (same identity, same history). The server decides everything: it
 * requires an elevated role, a reason and a confirmation that repeats the id, and it answers
 * with the unit `COMMISSIONED` — not eligible for work, and with no credential until it is
 * paired again. This module only shapes what the form sends and turns the server's answer
 * into a sentence; it checks no role and claims no success the server did not report.
 */

/** Must match the backend's `robotRecommission.service` MAX_REASON_LENGTH. */
export const RECOMMISSION_REASON_MAX = 500;

/** The 409 the physical commissioning endpoint answers for a retired robot's id. */
export const RETIRED_ID_CODE = 'ROBOT_ID_RETIRED';

/** What recommissioning does and does not do, shown before the operator confirms. */
export const RECOMMISSION_CONSEQUENCES = Object.freeze([
  'The same robot record comes back: its identifier, configuration and history (tasks, events, telemetry) are kept, not copied.',
  'Every credential it held before retirement is revoked. It must be paired again with a fresh one-time code.',
  'It is not released into service: it receives no work until its physical fleet declaration is applied, it is paired and online, and its state of charge is declared.',
  'Any hold it had (for example PAUSED after a STOP) and its stop latch are unchanged.',
  'The action, your account and your reason are recorded in the unit’s audit trail.',
]);

const text = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * Is this error the commissioning endpoint refusing a retired robot's id?
 * @param {unknown} err
 * @returns {boolean}
 */
export function isRetiredIdRefusal(err) {
  return Boolean(err) && err.status === 409 && err.code === RETIRED_ID_CODE;
}

/**
 * Check the form before anything is sent. The server checks the same things again.
 *
 * @param {{ robotId?: string, confirmRobotId?: string, reason?: string }} draft
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function validateRecommissionDraft(draft) {
  const robotId = text(draft?.robotId);
  const confirm = text(draft?.confirmRobotId);
  const reason = text(draft?.reason);
  const problems = [];
  if (!robotId) problems.push('Choose the retired robot to recommission.');
  if (robotId && confirm !== robotId) problems.push(`Type ${robotId} exactly to confirm.`);
  if (!reason) problems.push('Enter the reason for recommissioning; it is recorded in the audit trail.');
  if (reason.length > RECOMMISSION_REASON_MAX) problems.push(`The reason must be at most ${RECOMMISSION_REASON_MAX} characters.`);
  return { ok: problems.length === 0, problems };
}

/**
 * The request body: exactly the two fields the server accepts.
 * @param {{ confirmRobotId?: string, reason?: string }} draft
 * @returns {{ reason: string, confirmRobotId: string }}
 */
export function buildRecommissionRequest(draft) {
  return { reason: text(draft?.reason), confirmRobotId: text(draft?.confirmRobotId) };
}

/**
 * The sentence for a failed recommissioning. The server's own sentence is used wherever it
 * sent one; the cases below add what the operator should do next.
 *
 * @param {{ status?: number, code?: string|null, message?: string }|null|undefined} err
 * @param {string} robotId
 * @returns {string}
 */
export function recommissionFailureMessage(err, robotId) {
  const id = text(robotId) || 'the unit';
  const serverSentence = text(err?.message);
  switch (err?.status) {
    case 401:
      return 'Your session has ended. Sign in again, then retry the recommissioning.';
    case 403:
      return `Your account is not authorised to recommission robots. ${serverSentence}`.trim();
    case 404:
      return serverSentence || `No robot with ID ${id} exists.`;
    case 409:
      if (err?.code === 'ROBOT_NOT_RETIRED') {
        return `${serverSentence || `${id} is not retired.`} Refresh the list: it may already have been recommissioned.`;
      }
      return serverSentence || `${id} cannot be recommissioned in its current state.`;
    case 429:
      return 'Too many recommissioning requests. Wait a minute, then try again.';
    case 503:
      return `${serverSentence || 'The backend could not complete the request.'} Nothing was changed; it is safe to retry.`;
    default:
      if (!err?.status) {
        return 'The backend could not be reached. The robot may or may not have been recommissioned: refresh the retired list before retrying (a retry of a completed recommissioning is answered as already done).';
      }
      return serverSentence || 'Recommissioning failed.';
  }
}

/**
 * The retired units that can be chosen. Simulated units are listed by the server but cannot be
 * recommissioned; they are shown, disabled, so the operator is not left wondering where they went.
 *
 * @param {Array<object>} rows `GET /api/robots/retired`'s `robots`
 * @returns {Array<object>}
 */
export function sortRetiredForChoice(rows) {
  const list = Array.isArray(rows) ? rows.filter((row) => row && text(row.robotId)) : [];
  return [...list].sort((a, b) => {
    if (a.recommissionable !== b.recommissionable) return a.recommissionable ? -1 : 1;
    return String(a.robotId).localeCompare(String(b.robotId));
  });
}
