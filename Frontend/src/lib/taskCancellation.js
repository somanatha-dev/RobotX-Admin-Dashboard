/**
 * Whether the dashboard offers "Cancel" for a task, what it tells the operator before and after,
 * and how one request is run.
 *
 * ── The backend contract ────────────────────────────────────────────────────
 * `POST /api/tasks/:taskId/cancel` is the only path, and the backend decides. It cancels an
 * engine task in two cases only, each proven inside one audited transaction:
 *   · every open Leg is still QUEUED, with no commitment and no custody (Phase 6);
 *   · every open Leg is REASSIGNING with its reassignment chain exhausted, custody NONE, no live
 *     commitment, no command in flight, and the incumbent robot holding nothing (P7-D4).
 * Anything else is refused with a named code and nothing changed. Authority is the backend's
 * too: the route is authenticated and the role must be in `security.elevated_roles`.
 *
 * ── What the dashboard can know, and therefore what it offers ───────────────
 * `GET /api/tasks` carries the Task row only — no Leg state, chain length, commitment or
 * custody — so the page cannot prove that a task is eligible. What it can tell is when a task
 * certainly is not: a terminal task, or a user who is not elevated. For an elevated operator and
 * a task whose status still allows one of the two cases (it is waiting, or it shows as executing,
 * which is how a stranded task looks), the control is a guarded attempt — confirmation and the
 * step-up challenge, as every other destructive act on this dashboard — and the backend's answer
 * is shown as it is. VERIFYING is not offered: a completion claim for the task is being
 * verified, so the robot reports a delivery, and cancelling is not what that needs.
 *
 * ── The role check is a display rule, not authorisation ─────────────────────
 * `session.user.role` is what the backend's `/api/auth/me` returned. It decides only whether the
 * control is shown enabled. `ELEVATED_ROLES` mirrors the register's default for
 * `security.elevated_roles`; a deployment that publishes a different set is answered by the
 * backend's 403, which is shown as a refusal.
 */

export const ENGINE_CANCELLATION_UNAVAILABLE = 'ENGINE_CANCELLATION_UNAVAILABLE';

/** The default of the backend register's `security.elevated_roles` (§23.4). */
export const ELEVATED_ROLES = Object.freeze(['SUPER_ADMIN']);

export const NOT_ELEVATED_REASON = 'Cancelling a task requires an elevated operator role.';

export const VERIFYING_REASON =
  'A completion claim for this task is being verified. It is not offered for cancellation.';

const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'REJECTED']);

/**
 * @param {{ user?: { role?: string|null }|null }|null|undefined} session
 * @returns {boolean}
 */
export function isElevatedOperator(session) {
  const role = session?.user?.role;
  return typeof role === 'string' && ELEVATED_ROLES.includes(role);
}

/**
 * @param {object} task a row from `GET /api/tasks`
 * @param {{ elevated?: boolean }} [viewer]
 * @returns {{ show: boolean, available: boolean, reason: string|null }}
 *   `show` — whether the card has a cancel control at all (not for terminal tasks);
 *   `available` — whether pressing it sends a request (the backend still decides).
 */
export function cancellationFor(task, viewer = {}) {
  const status = String(task?.status || '').toUpperCase();
  if (TERMINAL.has(status)) return { show: false, available: false, reason: null };
  if (viewer?.elevated !== true) return { show: true, available: false, reason: NOT_ELEVATED_REASON };
  if (status === 'VERIFYING') return { show: true, available: false, reason: VERIFYING_REASON };
  return { show: true, available: true, reason: null };
}

/**
 * Shown in the authorisation dialog before the request is sent.
 *
 * @param {object} task
 * @returns {string}
 */
export function cancellationWarning(task) {
  const status = String(task?.status || '').toUpperCase();
  const which =
    status === 'PENDING'
      ? 'It is cancelled only if it is still waiting in the queue with no robot committed to it.'
      : 'A task shown as executing is cancelled only if the engine stranded it: its reassignment ' +
        'chain is exhausted, no robot holds a commitment or goods for it, and no command is in flight.';
  return (
    'This CANCELS the task. It does not complete the delivery, and it is not undone. ' +
    `${which} The engine checks this and refuses otherwise, changing nothing.`
  );
}

/** Backend refusal codes → what the operator is told. The backend's own sentence is shown beside it. */
const REFUSALS = Object.freeze({
  NOT_AUTHORISED: { kind: 'unauthorised', title: 'Not authorised', explanation: 'Your role may not cancel engine tasks.' },
  CUSTODY_NOT_NONE: {
    kind: 'custody',
    title: 'Custody unresolved',
    explanation: 'The task’s custody is not NONE: goods may be aboard or in handover. Resolve custody first.',
  },
  COMMITMENT_CUSTODY_NOT_NONE: {
    kind: 'custody',
    title: 'Custody unresolved',
    explanation: 'A commitment for this task recorded custody other than NONE. Resolve custody first.',
  },
  AGENT_CUSTODY_UNRESOLVED: {
    kind: 'custody',
    title: 'Custody unresolved',
    explanation: 'The robot this task was withdrawn from holds goods or unresolved custody on other work. Try again once that is resolved.',
  },
  CUSTODY_HELD: { kind: 'custody', title: 'Custody unresolved', explanation: 'Goods are aboard; a cancellation needs a recovery, not this action.' },
  LIVE_COMMITMENT_EXISTS: {
    kind: 'commitment',
    title: 'A robot is committed',
    explanation: 'A robot still holds a live commitment for this task — it may be executing or newly assigned.',
  },
  HARD_COMMITMENT_EXISTS: { kind: 'commitment', title: 'A robot is committed', explanation: 'A robot holds a commitment for this task.' },
  COMMAND_IN_FLIGHT: {
    kind: 'command',
    title: 'Command in flight',
    explanation: 'A command to the robot is still being delivered. Try again once it has settled, failed or expired.',
  },
  CHAIN_NOT_EXHAUSTED: {
    kind: 'chain',
    title: 'Still being reassigned',
    explanation: 'The engine is still reassigning this task; it is not waiting for an operator.',
  },
  CHAIN_BOUND_UNRESOLVED: {
    kind: 'configuration',
    title: 'Cannot be checked',
    explanation: 'The reassignment bound is not configured, so the backend cannot prove the task is eligible.',
  },
  ENGINE_CANCELLATION_UNAVAILABLE: {
    kind: 'state',
    title: 'Not cancellable in this state',
    explanation: 'Only a queued task, or one stranded after its reassignments were exhausted, can be cancelled.',
  },
  CUSTODIAL_PURPOSE_NOT_REQUESTER_CANCELLABLE: {
    kind: 'state',
    title: 'Not cancellable in this state',
    explanation: 'A recovery or transfer Leg is not cancelled from here.',
  },
  LEG_MOVED: { kind: 'moved', title: 'Task changed', explanation: 'The task changed while it was being cancelled. Review it before trying again.' },
  TASK_MOVED: { kind: 'moved', title: 'Task changed', explanation: 'The task changed while it was being cancelled. Review it before trying again.' },
  AUDIT_NOT_RECORDED: { kind: 'audit', title: 'Not recorded', explanation: 'The cancellation could not be audited, so it was not made.' },
  UNKNOWN_TASK: { kind: 'missing', title: 'Unknown task', explanation: 'The backend has no such task.' },
});

/**
 * Is this error the backend's "engine task, not cancellable here, nothing changed" answer?
 *
 * @param {unknown} error an error thrown by `requestJson`
 * @returns {boolean}
 */
export function isEngineCancellationRefusal(error) {
  return Boolean(error) && error.status === 409 && error.code === ENGINE_CANCELLATION_UNAVAILABLE;
}

/**
 * What a failed cancel request means.
 *
 * `refused` is the backend's definite answer — nothing was changed. `unknown` is a request whose
 * outcome this page cannot know (no response, or a server error with no refusal code): it may or
 * may not have been applied, so it is reported as such and never retried here.
 *
 * @param {unknown} error an error thrown by `requestJson` or `fetch`
 * @returns {{ outcome: 'REFUSED'|'UNKNOWN', kind: string, code: string|null, title: string, message: string }}
 */
export function describeCancellationFailure(error) {
  const status = typeof error?.status === 'number' ? error.status : null;
  const code = typeof error?.code === 'string' ? error.code : null;
  const server = typeof error?.message === 'string' && error.message.trim() ? error.message.trim() : null;

  const known = code ? REFUSALS[code] : null;
  if (known) {
    return { outcome: 'REFUSED', kind: known.kind, code, title: known.title, message: server ? `${known.explanation} ${server}` : known.explanation };
  }
  if (status === 403) {
    return { outcome: 'REFUSED', kind: 'unauthorised', code, title: 'Not authorised', message: server || REFUSALS.NOT_AUTHORISED.explanation };
  }
  if (status === 401) {
    return { outcome: 'REFUSED', kind: 'session', code, title: 'Signed out', message: 'Your session has ended, so the backend refused the request. Sign in again.' };
  }
  if (status === 429) {
    return { outcome: 'REFUSED', kind: 'rate_limited', code, title: 'Too many requests', message: server || 'Wait a moment before trying again.' };
  }
  if (status !== null && status >= 400 && status < 500) {
    return { outcome: 'REFUSED', kind: 'refused', code, title: 'Not cancelled', message: server || 'The backend refused the cancellation.' };
  }
  return {
    outcome: 'UNKNOWN',
    kind: 'unknown',
    code,
    title: 'Outcome unknown',
    message:
      'No definite answer arrived, so the cancellation may or may not have been made. It was not retried. ' +
      'Check the task’s status in the refreshed list before trying again.',
  };
}

/**
 * Run one cancel request and report it. Never throws, so the authorisation dialog closes on any
 * answer and an ambiguous failure is not re-submitted from it. Nothing is written to the task
 * locally: the page shows the list the backend returns after the request.
 *
 * @param {object} input
 * @param {string} input.taskId
 * @param {(taskId: string) => Promise<object|null>} input.cancel the API call; resolves to the task row
 * @param {() => Promise<unknown>} input.refresh re-reads the authoritative task list
 * @param {(notice: object) => void} input.notify
 * @param {(message: string, type: string) => void} [input.record] the event log
 * @returns {Promise<{ outcome: 'CANCELLED'|'ALREADY_TERMINAL'|'REFUSED'|'UNKNOWN', status?: string|null, code?: string|null }>}
 */
export async function runTaskCancellation({ taskId, cancel, refresh, notify, record }) {
  let task;
  try {
    task = await cancel(taskId);
  } catch (error) {
    const failure = describeCancellationFailure(error);
    let refreshed = true;
    try {
      await refresh();
    } catch {
      refreshed = false;
    }
    notify({
      kind: 'warning',
      title: failure.outcome === 'UNKNOWN' ? `Task ${taskId}: ${failure.title.toLowerCase()}` : `Task ${taskId} was not cancelled — ${failure.title}`,
      message: refreshed ? failure.message : `${failure.message} The task list could not be refreshed.`,
    });
    return { outcome: failure.outcome, code: failure.code };
  }

  const status = typeof task?.status === 'string' ? task.status.toUpperCase() : null;
  let refreshed = true;
  try {
    await refresh();
  } catch {
    refreshed = false;
  }
  const stale = refreshed ? '' : ' The task list could not be refreshed; it will update when it next refreshes.';

  if (status === 'CANCELLED') {
    record?.(`Task ${taskId} cancelled`, 'warning');
    notify({ kind: 'info', title: `Task ${taskId} cancelled`, message: `The backend reports the task CANCELLED.${stale}` });
    return { outcome: 'CANCELLED', status };
  }
  notify({
    kind: 'warning',
    title: `Task ${taskId} was not cancelled`,
    message: `The backend reports the task ${status || 'in an unknown state'}; nothing was cancelled.${stale}`,
  });
  return { outcome: 'ALREADY_TERMINAL', status };
}

/**
 * One request per key at a time. A second `run` for a key whose request has not settled is not
 * started — it resolves to `null` — so a double click, or a reopened dialog, cannot send two.
 *
 * @param {(keys: string[]) => void} [onChange] told the keys in flight whenever they change
 */
export function createSingleFlight(onChange) {
  const inFlight = new Set();
  const changed = () => onChange?.([...inFlight]);
  return {
    has: (key) => inFlight.has(key),
    async run(key, fn) {
      if (inFlight.has(key)) return null;
      inFlight.add(key);
      changed();
      try {
        return await fn();
      } finally {
        inFlight.delete(key);
        changed();
      }
    },
  };
}
