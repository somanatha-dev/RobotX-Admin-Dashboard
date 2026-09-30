/**
 * What a task card may truthfully say about where a task is — from the facts the dashboard
 * actually receives, and nothing more.
 *
 * ── What the frontend contract exposes (measured 2026-09-30, V1 launcher) ───
 *   · `Task.status` from `GET /api/tasks` and `TASK_UPDATED`: PENDING → ASSIGNED → COMPLETED.
 *     ASSIGNED is written only after the robot ACCEPTS the offer
 *     (`assignmentProjection.projectAcceptedAssignment`), so it means "executing".
 *   · `TASK_UPDATED` with `status: 'VERIFYING'` and a `verification` object when the
 *     completion evidence was insufficient or unavailable (socket only).
 *   · The engine's explanation (`GET /api/explain/task/:id`, `why_still_waiting.outcome`)
 *     while PENDING: 404 before the first round, then e.g. ASSIGNED (offered, awaiting the
 *     robot's answer) or NO_FEASIBLE_CANDIDATE.
 *
 * ── What it does NOT expose ─────────────────────────────────────────────────
 *   · The Leg's execution step (EN_ROUTE_PICKUP, AT_PICKUP, LOADED, EN_ROUTE_DROP, AT_DROP).
 *     `GET /api/legs/:legId/supervision` has it, but is keyed by the Leg's business id, and
 *     no response the dashboard receives carries that id.
 *   · Verification level and settlement. No route returns verification evidence, and
 *     `what_happened.settled` stayed false after a settled delivery.
 * So an accepted task is "Executing", not "At pickup", and a completed task is
 * "Completed", not "Verified" or "Settled". Guessing either would be the fabrication this
 * module exists to avoid.
 */

/**
 * Does this `OFFER_RESPONSE` mean a PENDING task's assignment state just changed?
 *
 * ── Why only these two ──────────────────────────────────────────────────────
 * Measured on the V1 launcher: a task goes PENDING → ASSIGNED on `TASK_UPDATED`, which the
 * backend emits in the same instant as the robot's OFFER_ACCEPT — the card already moves
 * on that event, not on the 10 s explanation poll. What no event covers is the robot
 * *refusing or deferring* an offer: the task stays PENDING and is re-planned, while a card
 * that last read "offered" would keep saying so until the next poll. OFFER_REJECT and
 * OFFER_DEFER are exactly that case, so they (and nothing else) trigger an immediate
 * re-read of the explanation. There is no dashboard event for an offer being *sent*, so the
 * poll stays as it is for that window.
 *
 * @param {{ response?: string } | null | undefined} offerResponse the socket payload
 * @returns {boolean}
 */
export function reopensAssignment(offerResponse) {
  const response = String(offerResponse?.response || '').trim();
  return response === 'OFFER_REJECT' || response === 'OFFER_DEFER';
}

export const PHASE = Object.freeze({
  QUEUED: 'QUEUED',
  OFFERED: 'OFFERED',
  WAITING: 'WAITING',
  NO_FEASIBLE_ROBOT: 'NO_FEASIBLE_ROBOT',
  PENDING_UNKNOWN: 'PENDING_UNKNOWN',
  EXECUTING: 'EXECUTING',
  VERIFYING: 'VERIFYING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  REJECTED: 'REJECTED',
  OTHER: 'OTHER',
});

const EXECUTING_STATUSES = new Set(['ASSIGNED', 'IN_PROGRESS', 'IN_EXECUTION']);

/**
 * @param {{ status?: string,
 *           rejection?: { status: string, explanation?: { outcome?: string|null, sentence?: string|null } },
 *           verification?: { failures?: string[], unavailable?: boolean, reason?: string } | null }} input
 *   `rejection` is the state of `useTaskRejection` (only meaningful while PENDING).
 * @returns {{ key: string, label: string, detail: string|null, busy: boolean, tone: string }}
 *   `busy` — assignment is genuinely still being worked on (the only case for a spinner).
 */
export function taskPhase(input) {
  const status = String(input?.status || '').toUpperCase();
  const rejection = input?.rejection || null;

  if (status === 'PENDING') {
    const outcome = rejection?.status === 'ready' ? rejection.explanation?.outcome || null : null;
    if (outcome === 'NO_FEASIBLE_CANDIDATE') {
      return {
        key: PHASE.NO_FEASIBLE_ROBOT,
        label: 'No feasible robot',
        detail: 'No robot satisfies this task. It stays queued and is re-evaluated every round.',
        busy: false,
        tone: 'warning',
      };
    }
    if (outcome === 'ASSIGNED') {
      return {
        key: PHASE.OFFERED,
        label: 'Offered',
        detail: 'Offered to a robot — waiting for it to accept.',
        busy: true,
        tone: 'pending',
      };
    }
    if (outcome) {
      return {
        key: PHASE.WAITING,
        label: 'Waiting',
        detail: rejection.explanation?.sentence || `Latest round: ${outcome}.`,
        busy: true,
        tone: 'pending',
      };
    }
    if (rejection?.status === 'unavailable') {
      return {
        key: PHASE.PENDING_UNKNOWN,
        label: 'Pending',
        detail: 'The assignment status could not be read.',
        busy: false,
        tone: 'pending',
      };
    }
    return {
      key: PHASE.QUEUED,
      label: 'Queued',
      detail: 'Waiting for the first assignment round.',
      busy: true,
      tone: 'pending',
    };
  }

  if (EXECUTING_STATUSES.has(status)) {
    return {
      key: PHASE.EXECUTING,
      label: 'Executing',
      detail: 'The robot accepted the task and is carrying it out. The exact step is not reported to the dashboard.',
      busy: false,
      tone: 'active',
    };
  }

  if (status === 'VERIFYING') {
    const v = input?.verification || null;
    const why = v?.unavailable
      ? `verification evidence unavailable${v.reason ? ` (${v.reason})` : ''}`
      : Array.isArray(v?.failures) && v.failures.length > 0
        ? `evidence insufficient: ${v.failures.join(', ')}`
        : null;
    return {
      key: PHASE.VERIFYING,
      label: 'Verifying',
      detail: `Completion reported but held for operator verification${why ? ` — ${why}` : ''}.`,
      busy: false,
      tone: 'warning',
    };
  }

  if (status === 'COMPLETED') {
    return {
      key: PHASE.COMPLETED,
      label: 'Completed',
      detail: 'Verification and settlement results are not reported to the dashboard.',
      busy: false,
      tone: 'done',
    };
  }
  if (status === 'FAILED') return { key: PHASE.FAILED, label: 'Failed', detail: null, busy: false, tone: 'error' };
  if (status === 'CANCELLED') return { key: PHASE.CANCELLED, label: 'Cancelled', detail: null, busy: false, tone: 'muted' };
  if (status === 'REJECTED') return { key: PHASE.REJECTED, label: 'Rejected', detail: null, busy: false, tone: 'error' };

  // A status this dashboard does not know: shown as itself, not dressed up as a failure.
  return { key: PHASE.OTHER, label: status || 'Unknown', detail: null, busy: false, tone: 'neutral' };
}
