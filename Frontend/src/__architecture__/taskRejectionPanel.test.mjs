/**
 * P1.3-A — the task card says why a task is not assigned.
 *
 *   node --test src/__architecture__/
 *   (or: npm run test:arch, from Frontend/)
 *
 * The explanation is the engine's own (§21.3, `GET /api/explain/task/:taskId`), rendered
 * with its codes unchanged. It is explanatory: the task's status is authoritative, so the
 * panel exists only for a PENDING task and every failure mode leaves the card usable.
 *
 * Behavioural throughout: the view is rendered with `react-dom/server`, the load/state logic
 * is driven with stubbed loaders, and the request module against a stubbed `fetch`. One
 * structural check pins the card's use of the panel.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  TaskRejectionPanel,
  TaskRejectionView,
  explanationFromResponse,
  loadRejectionState,
} from '../features/tasks/taskRejection.js';
import { explainTask } from '../lib/api/tasks.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const render = (element) => renderToStaticMarkup(element);
const view = (state) => render(React.createElement(TaskRejectionView, { state }));

/** The shape `GET /api/explain/task/:taskId` returns (answers trimmed to what the panel reads). */
function explainBody({ outcome = 'NO_FEASIBLE_CANDIDATE', binding = { predicateId: 'F21', count: 5 }, levers } = {}) {
  return {
    decisionId: 'v1demo-shard:1790505031894:leg-row-1',
    answers: [
      {
        query: 'why_still_waiting',
        source: 'TIER_A',
        outcome,
        rejectionHistogram: binding ? [{ predicateId: binding.predicateId, tier: null, count: binding.count, share: 1 }] : [],
        bindingConstraint: binding ? { ...binding, tier: null, share: 1 } : null,
        sentence: binding ? `100 % of rejections were ${binding.predicateId}` : 'No candidate was rejected on a predicate in this decision.',
      },
      {
        query: 'what_would_change_it',
        source: 'RECONSTRUCTED',
        feasibilityLevers: levers ?? [
          { agentId: 'V1DEMO-01', lever: 'FEASIBILITY', bindingPredicateId: 'F21' },
          { agentId: 'V1DEMO-02', lever: 'FEASIBILITY', bindingPredicateId: 'F21' },
        ],
      },
    ],
  };
}

test('1: an unassigned task with rejection information shows why', async () => {
  const state = await loadRejectionState('TSK-1', async () => explainBody());
  assert.equal(state.status, 'ready');
  const html = view(state);
  assert.match(html, /Why not assigned/);
  assert.match(html, /No feasible robot/);
  assert.match(html, /data-outcome="NO_FEASIBLE_CANDIDATE"/);
  assert.match(html, /data-binding="F21"/);
  assert.match(html, /100 % of rejections were F21/);
});

test('2: several robots, several reasons — each robot with its own code, as the engine recorded it', async () => {
  const state = await loadRejectionState('TSK-2', async () =>
    explainBody({
      binding: { predicateId: 'F34', count: 1 },
      levers: [
        { agentId: 'V1DEMO-05', bindingPredicateId: 'MISSING_HOP' },
        { agentId: 'V1DEMO-06', bindingPredicateId: 'F34' },
        { agentId: 'V1DEMO-02', bindingPredicateId: 'F21' },
      ],
    }),
  );
  const html = view(state);
  assert.match(html, /data-candidates="3"/);
  for (const [agent, code] of [['V1DEMO-05', 'MISSING_HOP'], ['V1DEMO-06', 'F34'], ['V1DEMO-02', 'F21']]) {
    assert.match(html, new RegExp(`data-agent="${agent}"[^]*?>${agent}<[^]*?>${code}<`), `${agent} → ${code}`);
  }
});

test('3: an assigned (or running, or finished) task shows no rejection panel at all', () => {
  for (const status of ['ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'CANCELLED']) {
    let called = false;
    const html = render(React.createElement(TaskRejectionPanel, { taskId: 'TSK-3', status, load: async () => { called = true; return explainBody(); } }));
    assert.equal(html, '', `${status} renders nothing`);
    assert.equal(called, false, `${status} does not even ask`);
  }
});

test('3b: still PENDING but the latest round ASSIGNED it (OFFER outstanding) — no "why not" panel', async () => {
  // Measured live: the decision is written ASSIGNED before the robot accepts, while the
  // task is still PENDING; its record can still carry other robots' rejections.
  const state = await loadRejectionState('TSK-3b', async () =>
    explainBody({ outcome: 'ASSIGNED', binding: { predicateId: 'F34', count: 1 }, levers: [{ agentId: 'V1DEMO-05', bindingPredicateId: 'MISSING_HOP' }] }),
  );
  const html = view(state);
  assert.match(html, /data-rejection-state="assigned"/);
  assert.match(html, /waiting for the robot to accept/);
  assert.doesNotMatch(html, /Why not assigned/);
  assert.doesNotMatch(html, /data-binding=|data-candidates=/);
});

test('4: no rejection information — a waiting task no round has decided yet, or one with nothing rejected', async () => {
  const notYet = Object.assign(new Error('no decision has been recorded for task "TSK-4" yet'), { status: 404 });
  const none = await loadRejectionState('TSK-4', async () => { throw notYet; });
  assert.deepEqual(none, { status: 'none' });
  assert.match(view(none), /Waiting for the first assignment round/);

  const nothingRejected = await loadRejectionState('TSK-4', async () => explainBody({ outcome: 'LOST_TO_ANOTHER_LEG', binding: null, levers: [] }));
  const html = view(nothingRejected);
  assert.match(html, /data-outcome="LOST_TO_ANOTHER_LEG"/);
  assert.doesNotMatch(html, /data-binding=/);
  assert.doesNotMatch(html, /data-candidates=/);
});

test('5: a diagnostics failure never breaks the card — every failure is a quiet state', async () => {
  const failures = [
    async () => { throw Object.assign(new Error('Unauthorized'), { status: 401 }); },
    async () => { throw Object.assign(new Error('Forbidden'), { status: 403 }); },
    async () => { throw Object.assign(new Error('Internal Server Error'), { status: 500 }); },
    async () => { throw new TypeError('fetch failed'); },
    async () => ({ nope: true }),
    async () => ({ answers: 'not a list' }),
    async () => null,
  ];
  for (const load of failures) {
    const state = await loadRejectionState('TSK-5', load);
    assert.deepEqual(state, { status: 'unavailable' });
    assert.match(view(state), /Assignment explanation unavailable/);
  }
  assert.equal(explanationFromResponse(undefined), null);
});

test('6: while loading, the pending card shows a quiet line, not a broken panel', () => {
  // The first render of a PENDING task, before the request resolves.
  const html = render(React.createElement(TaskRejectionPanel, { taskId: 'TSK-6', status: 'PENDING', load: () => new Promise(() => {}) }));
  assert.match(html, /data-rejection-state="muted"/);
  assert.match(html, /Checking why this task is not assigned yet/);
});

test('the request goes to the existing explain surface, resolved by task', async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(explainBody()), { status: 200 });
  };
  try {
    await explainTask('TSK 7/x');
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api\/explain\/task\/TSK%207%2Fx$/);
  assert.equal(calls[0].init.method, 'GET');
});

test('the task card renders the panel with the task and its status', () => {
  const page = fs.readFileSync(path.join(SRC, 'pages/TasksPage.jsx'), 'utf8');
  assert.match(page, /import \{ TaskRejectionPanel, useTaskRejection \} from '@\/features\/tasks\/taskRejection\.js';/);
  // FE-06: the card owns the one poll (`useTaskRejection`, enabled only while PENDING) and
  // hands its state to the panel, so header and panel read the same round.
  assert.match(page, /<TaskRejectionPanel taskId=\{taskId\} status=\{status\} state=\{rejection\} \/>/);
  assert.match(page, /const rejection = useTaskRejection\(task\.taskId \|\| task\.id, \{ enabled: isPending, refreshKey: assignmentSignal \}\);/);
});
