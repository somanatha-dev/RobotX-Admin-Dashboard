import React, { useEffect, useState } from 'react';

import { explainTask } from '../../lib/api/tasks.js';

/**
 * "Why was this task not assigned?" — the engine's own answer, on the task card.
 *
 * The data is the existing §21.3 explanation of the task's latest decision
 * (`GET /api/explain/task/:taskId`): `why_still_waiting` gives the round's outcome, the
 * rejection histogram and its binding constraint; `what_would_change_it` gives each robot
 * the decision rejected, with **its binding reason only** (a predicate such as `F21`, or a
 * refusal such as `MISSING_HOP`). Codes are shown exactly as the engine records them —
 * nothing here re-derives, renames or re-decides feasibility.
 *
 * The task's status is the authority; this is explanation. So the panel renders only for a
 * PENDING task, and any failure to load it (network, 401, 404, a malformed body) leaves the
 * card exactly as it was, with at most a muted line.
 *
 * Plain `React.createElement` rather than JSX, so the architecture tests can render it with
 * `react-dom/server` under plain node.
 */

/** How often a waiting task's explanation is refreshed (each round writes a new decision). */
export const REFRESH_MS = 10_000;

const h = React.createElement;

/**
 * Pick out what the panel shows from the explain response. Returns null for anything that is
 * not a usable explanation, so a malformed body renders as "unavailable", never as a crash.
 *
 * @param {unknown} body
 * @returns {{ decisionId: string|null, outcome: string|null, sentence: string|null,
 *   bindingConstraint: { predicateId: string, count: number }|null,
 *   histogram: Array<{ predicateId: string, count: number }>,
 *   candidates: Array<{ agentId: string, bindingPredicateId: string }> }|null}
 */
export function explanationFromResponse(body) {
  const answers = body && Array.isArray(body.answers) ? body.answers : null;
  if (!answers) return null;
  const waiting = answers.find((a) => a && a.query === 'why_still_waiting');
  if (!waiting) return null;
  const levers = answers.find((a) => a && a.query === 'what_would_change_it');

  const text = (value) => (typeof value === 'string' && value.trim() !== '' ? value : null);
  const histogram = (Array.isArray(waiting.rejectionHistogram) ? waiting.rejectionHistogram : [])
    .filter((row) => row && text(row.predicateId))
    .map((row) => ({ predicateId: row.predicateId, count: Number(row.count) || 0 }));
  const candidates = (levers && Array.isArray(levers.feasibilityLevers) ? levers.feasibilityLevers : [])
    .filter((row) => row && text(row.agentId) && text(row.bindingPredicateId))
    .map((row) => ({ agentId: row.agentId, bindingPredicateId: row.bindingPredicateId }));
  const binding =
    waiting.bindingConstraint && text(waiting.bindingConstraint.predicateId)
      ? { predicateId: waiting.bindingConstraint.predicateId, count: Number(waiting.bindingConstraint.count) || 0 }
      : null;

  return {
    decisionId: text(body.decisionId),
    outcome: text(waiting.outcome),
    sentence: text(waiting.sentence),
    bindingConstraint: binding,
    histogram,
    candidates,
  };
}

/** The outcome, in words, when it is the one an operator most needs named. */
function outcomeLabel(outcome) {
  if (outcome === 'NO_FEASIBLE_CANDIDATE') return 'No feasible robot';
  return outcome || 'Not assigned yet';
}

const muted = (text) => h('div', { className: 'text-[11px] text-muted-foreground', 'data-rejection-state': 'muted' }, text);

/**
 * The panel's content for one state. Pure, so it can be rendered and tested in isolation.
 *
 * @param {{ state: { status: 'loading'|'ready'|'none'|'unavailable', explanation?: object } }} props
 */
export function TaskRejectionView({ state }) {
  const status = state && state.status;
  if (status === 'loading') return muted('Checking why this task is not assigned yet…');
  if (status === 'none') return muted('Waiting for the first assignment round.');
  if (status !== 'ready' || !state.explanation) return muted('Assignment explanation unavailable.');

  const e = state.explanation;
  // The round did assign (`LEG_OUTCOME.ASSIGNED`); the task stays PENDING until the robot
  // accepts the OFFER. There is no "why not" to show, so none is shown.
  if (e.outcome === 'ASSIGNED') {
    return h(
      'div',
      { className: 'text-[11px] text-muted-foreground', 'data-rejection-state': 'assigned' },
      'Assigned in the latest round — waiting for the robot to accept.',
    );
  }
  return h(
    'div',
    { className: 'rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3 space-y-2', 'data-rejection-state': 'ready' },
    h(
      'div',
      { className: 'flex items-center justify-between gap-2' },
      h('span', { className: 'text-[10px] uppercase tracking-wide text-amber-700 font-bold' }, 'Why not assigned'),
      h('span', { className: 'font-mono text-[10px] text-amber-800', 'data-outcome': e.outcome || '' }, e.outcome || ''),
    ),
    h('div', { className: 'text-sm font-semibold text-slate-900' }, outcomeLabel(e.outcome)),
    e.bindingConstraint
      ? h(
          'div',
          { className: 'text-xs text-slate-700', 'data-binding': e.bindingConstraint.predicateId },
          'Binding constraint: ',
          h('span', { className: 'font-mono font-bold' }, e.bindingConstraint.predicateId),
          ` (${e.bindingConstraint.count} rejection${e.bindingConstraint.count === 1 ? '' : 's'})`,
        )
      : null,
    e.candidates.length > 0
      ? h(
          'ul',
          { className: 'space-y-0.5', 'data-candidates': String(e.candidates.length) },
          ...e.candidates.map((c) =>
            h(
              'li',
              { key: c.agentId, className: 'flex justify-between gap-3 text-xs', 'data-agent': c.agentId },
              h('span', { className: 'font-mono text-slate-800' }, c.agentId),
              h('span', { className: 'font-mono font-bold text-rose-700' }, c.bindingPredicateId),
            ),
          ),
        )
      : null,
    e.sentence ? h('div', { className: 'text-[11px] text-muted-foreground' }, e.sentence) : null,
  );
}

/**
 * One load, as a panel state. Any failure is a state, never a throw: a 404 (the task has
 * no recorded decision yet) is "none"; a network error, 401/403, 5xx or an unusable body is
 * "unavailable".
 *
 * @param {string} taskId
 * @param {(taskId: string) => Promise<unknown>} [load]
 * @returns {Promise<{ status: 'ready'|'none'|'unavailable', explanation?: object }>}
 */
export async function loadRejectionState(taskId, load = explainTask) {
  try {
    const explanation = explanationFromResponse(await load(taskId));
    return explanation ? { status: 'ready', explanation } : { status: 'unavailable' };
  } catch (error) {
    return { status: error && error.status === 404 ? 'none' : 'unavailable' };
  }
}

/**
 * Load, and refresh while mounted, a task's explanation (`loadRejectionState` on a timer).
 *
 * @param {string} taskId
 * @param {{ load?: (taskId: string) => Promise<unknown>, refreshMs?: number }} [options]
 */
export function useTaskRejection(taskId, options = {}) {
  const load = options.load || explainTask;
  const refreshMs = options.refreshMs ?? REFRESH_MS;
  // `enabled: false` — no request and no timer. The task card polls only while its task is
  // PENDING; it owns the one poll and hands the state to the panel (FE-06), so the card's
  // header and the panel cannot disagree about the latest round.
  const enabled = options.enabled !== false;
  // A change re-reads now (one request, the pending timer is dropped) — driven by an
  // existing socket event, never by a timer of its own.
  const refreshKey = options.refreshKey ?? 0;
  const [state, setState] = useState({ status: 'loading' });

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    let timer = null;
    const fetchOnce = async () => {
      const next = await loadRejectionState(taskId, load);
      if (cancelled) return;
      setState(next);
      if (refreshMs > 0) timer = setTimeout(fetchOnce, refreshMs);
    };
    fetchOnce();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [taskId, load, refreshMs, enabled, refreshKey]);

  return enabled ? state : IDLE_STATE;
}

const IDLE_STATE = Object.freeze({ status: 'idle' });

/**
 * The panel as the task card uses it. Renders nothing unless the task is PENDING — an
 * assigned, running or finished task has no "why not" to answer.
 *
 * @param {{ taskId: string, status: string, load?: Function }} props
 */
export function TaskRejectionPanel({ taskId, status, load, state }) {
  if (String(status || '').toUpperCase() !== 'PENDING' || !taskId) return null;
  // A caller that already polls (the task card) passes its state; otherwise poll here.
  if (state) return h(TaskRejectionView, { state });
  return h(PendingRejection, { taskId, load });
}

function PendingRejection({ taskId, load }) {
  const state = useTaskRejection(taskId, load ? { load } : {});
  return h(TaskRejectionView, { state });
}
