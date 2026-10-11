/**
 * P7-D4 Part 5 (2026-10-10) — the operator's cancel on the Tasks page.
 *
 * The backend's `POST /api/tasks/:taskId/cancel` cancels a task whose Legs are all QUEUED, or
 * all REASSIGNING with the reassignment chain exhausted and nothing held (P7-D4 Part 3/4), and
 * refuses everything else with a named code and nothing changed. The task list carries no Leg
 * state, so the page offers a guarded attempt to an elevated operator and shows the backend's
 * answer; it never decides eligibility itself and never writes a task status.
 *
 * Behavioural where the logic lives (`lib/taskCancellation.js`, driven through the real
 * `tasksApi.cancelTask` and `requestJson` against a stubbed `fetch` — no network, no backend);
 * structural for the card and the provider wiring, like the other files here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const load = (rel) => import(pathToFileURL(path.join(SRC, rel)).href);

const TERMINAL = ['COMPLETED', 'FAILED', 'CANCELLED', 'REJECTED'];
const MAY_BE_ELIGIBLE = ['PENDING', 'ASSIGNED', 'IN_PROGRESS', 'IN_EXECUTION', 'SUSPENDED'];
const ELEVATED = { isAuthenticated: true, user: { id: 'u1', email: 'ops@robotx.test', role: 'SUPER_ADMIN' } };

/**
 * Run `fn` with `fetch` answering from `respond(url, init)`; every call is recorded. A real
 * request can never leave the process: the stub is installed before and removed after.
 */
async function withFetch(respond, fn) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method || 'GET' });
    return respond(url, init);
  };
  try {
    return { result: await fn(), calls };
  } finally {
    globalThis.fetch = original;
  }
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** One cancellation through the real API client, with recording collaborators. */
async function attempt(respond, { refreshFails = false } = {}) {
  const m = await load('lib/taskCancellation.js');
  const tasksApi = await load('lib/api/tasks.js');
  const notices = [];
  const events = [];
  const order = [];
  const { result, calls } = await withFetch(respond, () =>
    m.runTaskCancellation({
      taskId: 'TSK-254',
      cancel: async (id) => {
        order.push('cancel');
        return tasksApi.cancelTask(id);
      },
      refresh: async () => {
        order.push('refresh');
        if (refreshFails) throw new Error('refresh failed');
      },
      notify: (n) => notices.push(n),
      record: (msg, type) => events.push({ msg, type }),
    }),
  );
  return { result, calls, notices, events, order };
}

// ── who is offered the action, and for which tasks ───────────────────────────

test('an elevated operator is offered the cancel for a task that may be eligible', async () => {
  const m = await load('lib/taskCancellation.js');
  assert.equal(m.isElevatedOperator(ELEVATED), true);
  for (const status of MAY_BE_ELIGIBLE) {
    assert.deepEqual(m.cancellationFor({ status }, { elevated: true }), { show: true, available: true, reason: null }, status);
  }
  // Lower-case statuses from a socket update read the same.
  assert.equal(m.cancellationFor({ status: 'assigned' }, { elevated: true }).available, true);
});

test('a completion being verified is not offered, even to an elevated operator', async () => {
  const m = await load('lib/taskCancellation.js');
  assert.deepEqual(m.cancellationFor({ status: 'VERIFYING' }, { elevated: true }), { show: true, available: false, reason: m.VERIFYING_REASON });
});

test('a user who is not elevated cannot send it: the control is shown disabled with the reason', async () => {
  const m = await load('lib/taskCancellation.js');
  const notElevated = [
    null,
    undefined,
    { isAuthenticated: false, user: null },
    { isAuthenticated: true, user: { role: 'OPERATOR' } },
    { isAuthenticated: true, user: { role: '' } },
    { isAuthenticated: true, user: {} },
    { isAuthenticated: true, user: { role: 'super_admin' } },
    // A role anywhere but the backend's `/me` user is not read.
    { isAuthenticated: true, role: 'SUPER_ADMIN', user: { role: 'OPERATOR' } },
  ];
  for (const session of notElevated) {
    assert.equal(m.isElevatedOperator(session), false, JSON.stringify(session));
    for (const status of MAY_BE_ELIGIBLE) {
      assert.deepEqual(m.cancellationFor({ status }, { elevated: m.isElevatedOperator(session) }), {
        show: true,
        available: false,
        reason: m.NOT_ELEVATED_REASON,
      });
    }
  }
  // No viewer at all is not elevated.
  assert.equal(m.cancellationFor({ status: 'PENDING' }).available, false);
});

test('terminal tasks keep showing no cancel control, elevated or not', async () => {
  const m = await load('lib/taskCancellation.js');
  for (const status of TERMINAL) {
    for (const elevated of [true, false]) {
      assert.deepEqual(m.cancellationFor({ status }, { elevated }), { show: false, available: false, reason: null }, `${status}/${elevated}`);
    }
  }
});

test('the role list mirrors the backend register default for security.elevated_roles', async () => {
  const m = await load('lib/taskCancellation.js');
  const register = JSON.parse(fs.readFileSync(path.resolve(SRC, '../../Backend/src/engine/config/register/supplementary.json'), 'utf8'));
  const entries = [];
  JSON.stringify(register, (key, value) => {
    if (value && value.name === 'security.elevated_roles') entries.push(value);
    return value;
  });
  assert.equal(entries.length, 1);
  assert.deepEqual([...m.ELEVATED_ROLES], entries[0].default);
});

// ── confirmation ─────────────────────────────────────────────────────────────

test('the confirmation says it cancels the task and does not complete the delivery', async () => {
  const m = await load('lib/taskCancellation.js');
  for (const status of MAY_BE_ELIGIBLE) {
    const warning = m.cancellationWarning({ status });
    assert.match(warning, /CANCELS the task/);
    assert.match(warning, /does not complete the delivery/);
    assert.match(warning, /refuses otherwise, changing nothing/);
  }
  assert.match(m.cancellationWarning({ status: 'PENDING' }), /still waiting in the queue/);
  assert.match(m.cancellationWarning({ status: 'ASSIGNED' }), /reassignment chain is exhausted/);
});

test('the provider asks for the step-up challenge with that confirmation, as a destructive act', () => {
  const src = code(read('context/AppProvider.jsx'));
  const cancel = src.match(/const cancelTask = useCallback\(([\s\S]*?)\n {2}\);/);
  assert.ok(cancel);
  assert.match(cancel[1], /requestAuth\(\s*`CANCEL TASK \$\{id\}`,/);
  assert.match(cancel[1], /true,\s*\{ warning: cancellationWarning\(task\) \}/);
  // The dialog renders the warning before it authorises (the existing contract).
  const modal = code(read('components/modals/AuthChallengeModal.jsx'));
  assert.match(modal, /\{request\.warning && \(/);
});

// ── pending state and double submission ─────────────────────────────────────

test('one request per task: a second submission while the first is pending is not sent', async () => {
  const m = await load('lib/taskCancellation.js');
  const seen = [];
  const flight = m.createSingleFlight((keys) => seen.push(keys));
  let release;
  let runs = 0;
  const first = flight.run('TSK-254', async () => {
    runs += 1;
    await new Promise((resolve) => {
      release = resolve;
    });
    return 'first';
  });
  assert.equal(flight.has('TSK-254'), true);
  assert.equal(await flight.run('TSK-254', async () => {
    runs += 1;
    return 'second';
  }), null);
  // Another task is not held up by it.
  assert.equal(await flight.run('TSK-551', async () => 'other'), 'other');
  release();
  assert.equal(await first, 'first');
  assert.equal(runs, 1);
  assert.equal(flight.has('TSK-254'), false);
  assert.deepEqual(seen[0], ['TSK-254']);
  assert.deepEqual(seen.at(-1), []);
});

test('the key is released when the request fails, so a deliberate later attempt is possible', async () => {
  const m = await load('lib/taskCancellation.js');
  const flight = m.createSingleFlight();
  await assert.rejects(flight.run('T', async () => {
    throw new Error('boom');
  }));
  assert.equal(flight.has('T'), false);
});

test('the card shows the pending state ahead of the button, and the provider refuses to reopen a pending task', () => {
  const page = code(read('pages/TasksPage.jsx'));
  const pending = page.indexOf('cancellation.show && cancelPending ? (');
  const available = page.indexOf('cancellation.show && cancellation.available ? (');
  assert.ok(pending > 0 && available > pending, 'pending is checked first');
  assert.match(page.slice(pending, available), /disabled/);
  assert.match(page.slice(pending, available), /Cancelling…/);
  assert.match(page, /onClick=\{\(\) => onCancel\(task\)\}/);
  assert.match(page, /cancelPending=\{\(cancellingTaskIds \|\| \[\]\)\.includes\(taskId\)\}/);
  assert.match(page, /const elevated = isElevatedOperator\(session\);/);

  const src = code(read('context/AppProvider.jsx'));
  assert.match(src, /const \[cancellationFlight\] = useState\(\(\) => createSingleFlight\(setCancellingTaskIds\)\);/);
  const cancel = src.match(/const cancelTask = useCallback\(([\s\S]*?)\n {2}\);/)[1];
  assert.match(cancel, /if \(!id \|\| cancellationFlight\.has\(id\)\) return;/);
  assert.match(cancel, /cancellationFlight\.run\(id,/);
});

// ── success ──────────────────────────────────────────────────────────────────

test('success: one POST, then the authoritative list is re-read, and the server’s CANCELLED is reported', async () => {
  const { result, calls, notices, events, order } = await attempt(() =>
    json(200, { ok: true, task: { taskId: 'TSK-254', status: 'CANCELLED' }, cancellation: { resolution: 'CANCELLED_IMMEDIATELY', operatorExit: 'EXHAUSTED_REASSIGNMENT' } }),
  );
  assert.deepEqual(result, { outcome: 'CANCELLED', status: 'CANCELLED' });
  assert.deepEqual(calls, [{ url: 'http://localhost:3000/api/tasks/TSK-254/cancel', method: 'POST' }]);
  assert.deepEqual(order, ['cancel', 'refresh'], 'refreshed after the server confirmed, never before');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].kind, 'info');
  assert.match(notices[0].message, /backend reports the task CANCELLED/);
  assert.deepEqual(events, [{ msg: 'Task TSK-254 cancelled', type: 'warning' }]);
});

test('success whose refresh fails is still a success, and says the list is stale (not a retry prompt)', async () => {
  const { result, notices } = await attempt(() => json(200, { ok: true, task: { status: 'CANCELLED' } }), { refreshFails: true });
  assert.equal(result.outcome, 'CANCELLED');
  assert.match(notices[0].message, /could not be refreshed/);
});

test('a 200 naming another terminal status is not reported as a cancellation', async () => {
  const { result, notices, events } = await attempt(() => json(200, { ok: true, task: { status: 'COMPLETED' } }));
  assert.deepEqual(result, { outcome: 'ALREADY_TERMINAL', status: 'COMPLETED' });
  assert.match(notices[0].message, /reports the task COMPLETED; nothing was cancelled/);
  assert.deepEqual(events, []);
});

// ── refusals ─────────────────────────────────────────────────────────────────

// Bodies exactly as `tasks.controller.cancelTask` sends them: { ok: false, code, error, message }.
const REFUSALS = [
  [409, 'AGENT_CUSTODY_UNRESOLVED', /Custody unresolved/],
  [409, 'CUSTODY_NOT_NONE', /Custody unresolved/],
  [409, 'COMMITMENT_CUSTODY_NOT_NONE', /Custody unresolved/],
  [409, 'LIVE_COMMITMENT_EXISTS', /A robot is committed/],
  [409, 'COMMAND_IN_FLIGHT', /Command in flight/],
  [409, 'CHAIN_NOT_EXHAUSTED', /Still being reassigned/],
  [403, 'NOT_AUTHORISED', /Not authorised/],
  [409, 'ENGINE_CANCELLATION_UNAVAILABLE', /Not cancellable in this state/],
  [503, 'CHAIN_BOUND_UNRESOLVED', /Cannot be checked/],
  [503, 'AUDIT_NOT_RECORDED', /Not recorded/],
  [409, 'TASK_MOVED', /Task changed/],
  [404, 'UNKNOWN_TASK', /Unknown task/],
];

for (const [status, codeName, title] of REFUSALS) {
  test(`refusal ${status} ${codeName} is shown as a refusal with the backend's sentence; nothing is written locally`, async () => {
    const sentence = `Task TSK-254 was not cancelled (${codeName}: detail); nothing was changed`;
    const task = Object.freeze({ taskId: 'TSK-254', status: 'ASSIGNED' });
    const { result, calls, notices, events, order } = await attempt(() => json(status, { ok: false, code: codeName, error: sentence, message: sentence }));
    assert.deepEqual(result, { outcome: 'REFUSED', code: codeName });
    assert.equal(calls.length, 1, 'sent once, not retried');
    assert.deepEqual(order, ['cancel', 'refresh'], 'the list is re-read from the backend, not edited');
    assert.equal(notices.length, 1);
    assert.equal(notices[0].kind, 'warning');
    assert.match(notices[0].title, /^Task TSK-254 was not cancelled — /);
    assert.match(notices[0].title, title);
    assert.ok(notices[0].message.includes(sentence), 'the backend sentence is shown');
    assert.deepEqual(events, [], 'no "cancelled" event');
    assert.equal(task.status, 'ASSIGNED');
  });
}

test('a gate 403 with no code, and a 429, are refusals too', async () => {
  const forbidden = await attempt(() => json(403, { ok: false, error: 'Forbidden', detail: 'this surface requires an elevated role (§23.4)' }));
  assert.equal(forbidden.result.outcome, 'REFUSED');
  assert.match(forbidden.notices[0].title, /Not authorised/);
  const limited = await attempt(() => json(429, { ok: false, error: 'Rate limit exceeded' }));
  assert.equal(limited.result.outcome, 'REFUSED');
  assert.match(limited.notices[0].title, /Too many requests/);
  assert.equal(limited.calls.length, 1);
});

// ── ambiguous failures ───────────────────────────────────────────────────────

test('a network failure is reported as an unknown outcome and is not retried', async () => {
  const { result, calls, notices, events } = await attempt(() => {
    throw new TypeError('Failed to fetch');
  });
  assert.deepEqual(result, { outcome: 'UNKNOWN', code: null });
  assert.equal(calls.length, 1, 'exactly one request — no automatic retry');
  assert.match(notices[0].title, /outcome unknown/);
  assert.match(notices[0].message, /may or may not have been made\. It was not retried/);
  assert.deepEqual(events, []);
});

test('a 5xx with no refusal code is also an unknown outcome, never "nothing changed"', async () => {
  const { result, notices, calls } = await attempt(() => json(500, { message: 'Internal Server Error' }));
  assert.equal(result.outcome, 'UNKNOWN');
  assert.doesNotMatch(notices[0].message, /nothing was changed/);
  assert.equal(calls.length, 1);
});

test('the action never throws, so the dialog closes and cannot re-submit an ambiguous request', async () => {
  const m = await load('lib/taskCancellation.js');
  for (const failure of [new TypeError('Failed to fetch'), Object.assign(new Error('x'), { status: 409, code: 'COMMAND_IN_FLIGHT' })]) {
    const out = await m.runTaskCancellation({
      taskId: 'T',
      cancel: async () => {
        throw failure;
      },
      refresh: async () => {
        throw new Error('also down');
      },
      notify: () => {},
    });
    assert.ok(['REFUSED', 'UNKNOWN'].includes(out.outcome));
  }
  // The dialog closes only when its action resolves (AuthChallengeModal), and re-runs it only on
  // a fresh click — so a resolved action is what keeps a failure from being re-sent from there.
  const modal = code(read('components/modals/AuthChallengeModal.jsx'));
  assert.match(modal, /await Promise\.resolve\(request\.action\(\)\);\s*onClose\(\);/);
});

test('a network failure while a request is pending does not let a second one start', async () => {
  const m = await load('lib/taskCancellation.js');
  const tasksApi = await load('lib/api/tasks.js');
  const flight = m.createSingleFlight();
  let fail;
  const { calls } = await withFetch(
    () =>
      new Promise((_, reject) => {
        fail = () => reject(new TypeError('Failed to fetch'));
      }),
    async () => {
      const run = () =>
        flight.run('TSK-254', () =>
          m.runTaskCancellation({ taskId: 'TSK-254', cancel: tasksApi.cancelTask, refresh: async () => {}, notify: () => {} }),
        );
      const first = run();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(await run(), null, 'ignored while pending');
      fail();
      assert.equal((await first).outcome, 'UNKNOWN');
    },
  );
  assert.equal(calls.length, 1);
});

// ── unchanged ────────────────────────────────────────────────────────────────

test('the API call is the existing endpoint through the existing client', () => {
  const api = code(read('lib/api/tasks.js'));
  assert.match(api, /export async function cancelTask\(taskId\) \{\s*const data = await requestJson\(`\/api\/tasks\/\$\{encodeURIComponent\(taskId\)\}\/cancel`, \{ method: 'POST' \}\);/);
  const src = code(read('context/AppProvider.jsx'));
  assert.match(src.match(/const cancelTask = useCallback\(([\s\S]*?)\n {2}\);/)[1], /cancel: tasksApi\.cancelTask,/);
});

test('terminal and non-elevated cards keep their existing rendering', () => {
  const page = code(read('pages/TasksPage.jsx'));
  // Not elevated (or VERIFYING): the disabled control with the reason, as before.
  assert.match(page, /data-cancel-state="unavailable"/);
  assert.match(page, /title=\{cancellation\.reason\}/);
  // Terminal: the status line, as before.
  assert.match(page, /\{status === 'CANCELLED' \? <X className="w-3\.5 h-3\.5" \/> : null\}/);
});
