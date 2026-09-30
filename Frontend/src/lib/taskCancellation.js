/**
 * Whether the dashboard may offer "Cancel" for a task, and how to recognise the backend's
 * refusal when a cancel request is sent anyway.
 *
 * ── The backend contract (P1.4, owner decision) ─────────────────────────────
 * `POST /api/tasks/:taskId/cancel` answers **409 `ENGINE_CANCELLATION_UNAVAILABLE`** for a
 * task the assignment engine manages (it has a Leg) and changes nothing. V1 has no
 * engine-side cancellation path, so a cancel button on such a task can never succeed.
 *
 * ── Why every non-terminal task counts as engine-managed ────────────────────
 * Since the Phase 15 cutover, intake is the only way a task is created, and intake gives
 * every task a Leg. The task list (`GET /api/tasks`) carries no Leg reference, so the
 * frontend cannot tell an engine task from a pre-cutover one, and must not guess in the
 * direction that offers an action that will be refused. The button is therefore shown
 * disabled with the reason. The backend's 409 stays the authority: `isEngineCancellationRefusal`
 * recognises it if a request is ever sent.
 */

export const ENGINE_CANCELLATION_UNAVAILABLE = 'ENGINE_CANCELLATION_UNAVAILABLE';

export const ENGINE_CANCELLATION_REASON =
  'Cancellation is not available in V1. The assignment engine manages this task, and the ' +
  'backend refuses to cancel it — nothing would be changed.';

const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'REJECTED']);

/**
 * @param {object} task a row from `GET /api/tasks`
 * @returns {{ show: boolean, available: boolean, reason: string|null }}
 *   `show` — whether the card has a cancel control at all (not for terminal tasks);
 *   `available` — whether pressing it can succeed.
 */
export function cancellationFor(task) {
  const status = String(task?.status || '').toUpperCase();
  if (TERMINAL.has(status)) return { show: false, available: false, reason: null };
  return { show: true, available: false, reason: ENGINE_CANCELLATION_REASON };
}

/**
 * Is this error the backend's "engine task, not cancellable, nothing changed" answer?
 *
 * @param {unknown} error an error thrown by `requestJson`
 * @returns {boolean}
 */
export function isEngineCancellationRefusal(error) {
  return Boolean(error) && error.status === 409 && error.code === ENGINE_CANCELLATION_UNAVAILABLE;
}
