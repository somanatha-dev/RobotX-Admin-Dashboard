/**
 * FE-01 … FE-04 (frontend ↔ backend integration audit, 2026-09-30).
 *
 * FE-01  the dashboard socket connects only after authentication — it used to connect at
 *        import time, be refused by the backend (`UNAUTHORIZED` + server disconnect), and
 *        stay dead behind a signed-in dashboard until a reload.
 * FE-02  logout closes the socket; a logged-out page used to keep receiving telemetry.
 * FE-03  Cancel is not offered as something that can succeed for an engine-managed task,
 *        and the backend's 409 is recognised by its code.
 * FE-04  RESUME is not sent, STOP/PAUSE warn that they are one-way, and the fleet-wide
 *        STOP writes no robot status of its own.
 *
 * The socket half is behavioural (the real socket.io-client, no server needed: nothing is
 * awaited over the network); the page halves are structural, like the other files here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
// Comments removed, so a sentence that *describes* old behaviour cannot satisfy or fail a check.
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const socketModule = () => import(pathToFileURL(path.join(SRC, 'lib/socket.js')).href);

// ── FE-01 / FE-02: the socket module ─────────────────────────────────────────

test('FE-01 importing the socket module opens no connection', async () => {
  const { socket } = await socketModule();
  assert.equal(socket.connected, false);
  assert.equal(socket.active, false, 'nothing may connect before a session exists');
  assert.equal(socket.io.opts.autoConnect, false);
  assert.equal(socket.io.opts.withCredentials, true, 'the handshake must still carry the auth cookie');
});

test('FE-01 there is exactly one shared socket, and connecting twice opens one connection', async () => {
  const a = await socketModule();
  const b = await import(pathToFileURL(path.join(SRC, 'lib/socket.js')).href + '?second-import');
  assert.equal(a.socket, b.socket, 'a re-evaluated module (HMR) must reuse the global socket');

  assert.equal(a.connectDashboardSocket(), true);
  assert.equal(a.socket.active, true);
  assert.equal(a.connectDashboardSocket(), false, 'a second call while active must not open another');

  // FE-02: closing leaves nothing active, and closing twice is harmless.
  assert.equal(a.disconnectDashboardSocket(), true);
  assert.equal(a.socket.active, false);
  assert.equal(a.socket.connected, false);
  assert.equal(a.disconnectDashboardSocket(), false);
});

test('FE-01 the socket module itself never connects (no import-time or HMR connect)', () => {
  const src = code(read('lib/socket.js'));
  assert.match(src, /autoConnect:\s*false/);
  const connects = src.match(/socket\.connect\(\)/g) || [];
  assert.equal(connects.length, 1, 'the only connect() is inside connectDashboardSocket');
  assert.match(src, /export function connectDashboardSocket\(\)\s*\{\s*if \(socket\.active\) return false;\s*socket\.connect\(\);/);
});

// ── FE-01 / FE-02: the provider ──────────────────────────────────────────────

test('FE-01 the provider connects only while authenticated, and refreshes on every connect', () => {
  const src = code(read('context/AppProvider.jsx'));
  assert.match(
    src,
    /useEffect\(\(\) => \{\s*if \(session\.isAuthenticated\) connectDashboardSocket\(\);\s*else disconnectDashboardSocket\(\);\s*\}, \[session\.isAuthenticated\]\);/,
  );
  assert.equal((src.match(/\bconnectDashboardSocket\(\)/g) || []).length, 3,
    'connects: the session effect, the single post-UNAUTHORIZED retry, and its after-disconnect form');
  assert.match(src, /socket\.on\('connect', onConnect\)/);
  assert.match(src, /const onConnect = \(\) => \{[\s\S]*?refreshDbState\(\)/);
  assert.match(src, /socket\.on\(SOCKET_UNAUTHORIZED, onUnauthorized\)/);
  assert.match(src, /if \(unauthorizedRetriedRef\.current\) \{/, 'a second refusal must be final, not a loop');
});

test('FE-02 logout closes the socket before calling the backend, and clears fleet state', () => {
  const src = code(read('context/AppProvider.jsx'));
  const logout = src.match(/const logout = useCallback\(async \(\) => \{([\s\S]*?)\n {2}\}, \[/);
  assert.ok(logout, 'logout found');
  const body = logout[1];
  assert.ok(body.indexOf('disconnectDashboardSocket()') > -1);
  assert.ok(body.indexOf('disconnectDashboardSocket()') < body.indexOf('authApi.logout()'));
  assert.match(body, /clearSessionState\(\)/);

  const clear = src.match(/const clearSessionState = useCallback\(\(\) => \{([\s\S]*?)\n {2}\}, \[/);
  assert.ok(clear, 'clearSessionState found');
  for (const needle of ['disconnectDashboardSocket()', 'setRobots([])', 'setTasks([])', 'setSimulatorStatus(null)', 'taskPathCacheRef.current.clear()']) {
    assert.ok(clear[1].includes(needle), `clearSessionState must do ${needle}`);
  }
});

test('FE-02 a 401 from the backend signs the page out through the same path', () => {
  const src = code(read('context/AppProvider.jsx'));
  assert.match(src, /if \(err\?\.status === 401\) sessionExpiredRef\.current\?\.\(\);/);
  assert.match(src, /const expireSession = useCallback\(\(\) => \{[\s\S]*?clearSessionState\(\);/);
});

// ── FE-03: cancellation ──────────────────────────────────────────────────────

test('FE-03 an engine-managed task offers no cancel that can succeed; terminal tasks offer none', async () => {
  const m = await import(pathToFileURL(path.join(SRC, 'lib/taskCancellation.js')).href);
  for (const status of ['PENDING', 'ASSIGNED', 'IN_PROGRESS', 'VERIFYING']) {
    const c = m.cancellationFor({ status });
    assert.deepEqual([c.show, c.available], [true, false], status);
    assert.match(c.reason, /not available in V1/);
  }
  for (const status of ['COMPLETED', 'FAILED', 'CANCELLED', 'REJECTED']) {
    assert.equal(m.cancellationFor({ status }).show, false, status);
  }
});

test('FE-03 the backend 409 is recognised by status AND code, via httpClient', async () => {
  const m = await import(pathToFileURL(path.join(SRC, 'lib/taskCancellation.js')).href);
  const { requestJson } = await import(pathToFileURL(path.join(SRC, 'lib/api/httpClient.js')).href);
  const original = globalThis.fetch;
  const body = { ok: false, code: 'ENGINE_CANCELLATION_UNAVAILABLE', message: 'Task T is managed by the assignment engine; nothing was changed.' };
  globalThis.fetch = async () => new Response(JSON.stringify(body), { status: 409 });
  let caught = null;
  try {
    await requestJson('/api/tasks/T/cancel', { method: 'POST' });
  } catch (e) {
    caught = e;
  } finally {
    globalThis.fetch = original;
  }
  assert.ok(caught);
  assert.equal(caught.status, 409);
  assert.equal(caught.code, 'ENGINE_CANCELLATION_UNAVAILABLE');
  assert.equal(caught.message, body.message);
  assert.equal(m.isEngineCancellationRefusal(caught), true);
  assert.equal(m.isEngineCancellationRefusal(Object.assign(new Error('x'), { status: 409, code: 'OTHER' })), false);
  assert.equal(m.isEngineCancellationRefusal(Object.assign(new Error('x'), { status: 401, code: null })), false);
});

test('FE-03 the card and the provider: disabled control, and a 409 closes the dialog without a success', () => {
  const page = code(read('pages/TasksPage.jsx'));
  assert.match(page, /const cancellation = cancellationFor\(task\);/);
  assert.match(page, /cancellation\.show && cancellation\.available \? \(/);
  assert.doesNotMatch(page, /canCancel/);

  const src = code(read('context/AppProvider.jsx'));
  const cancel = src.match(/const cancelTask = useCallback\(([\s\S]*?)\n {2}\);/);
  assert.ok(cancel);
  const refusal = cancel[1].match(/if \(isEngineCancellationRefusal\(err\)\) \{([\s\S]*?)return;\s*\}/);
  assert.ok(refusal, 'the refusal branch returns (so the dialog closes)');
  assert.match(refusal[1], /showNotice\(/);
  assert.doesNotMatch(refusal[1], /addEvent\(`Task \$\{id\} cancelled`/, 'no success message on a refusal');
  assert.doesNotMatch(refusal[1], /setTasks\(/, 'no fabricated task state');
});

// ── FE-04: robot commands ────────────────────────────────────────────────────

test('FE-04 STOP and PAUSE warn that they are one-way; other commands do not', async () => {
  const m = await import(pathToFileURL(path.join(SRC, 'lib/robotCommands.js')).href);
  assert.match(m.commandWarning('STOP'), /One-way in V1/);
  assert.match(m.commandWarning('pause'), /One-way in V1/);
  assert.equal(m.commandWarning('RETURN'), null);
  assert.match(m.STOP_ALL_WARNING, /One-way in V1/);
  assert.deepEqual(
    m.summariseStopAll([
      { status: 'fulfilled', value: { delivered: true } },
      { status: 'fulfilled', value: { delivered: false } },
      { status: 'rejected', reason: new Error('x') },
    ]),
    { total: 3, accepted: 2, delivered: 1, failed: 1 },
  );
});

test('FE-04 RESUME is never sent, and the fleet-wide STOP writes no robot status', () => {
  const pages = ['pages/RobotDetailPage.jsx', 'pages/RobotsPage.jsx', 'pages/MapPage.jsx'].map((p) => code(read(p))).join('\n');
  assert.doesNotMatch(pages, /sendCommand\([^)]*'RESUME'\)/);
  assert.match(code(read('pages/RobotDetailPage.jsx')), /data-command-unavailable="RESUME"/);

  const src = code(read('context/AppProvider.jsx'));
  const stopAll = src.match(/const stopAll = useCallback\(\(\) => \{([\s\S]*?)\n {2}\}, \[/);
  assert.ok(stopAll);
  assert.doesNotMatch(stopAll[1], /setRobots\(/, 'no optimistic PAUSED');
  assert.doesNotMatch(stopAll[1], /setSystemOnline/);
  assert.match(stopAll[1], /refreshDbState\(\)/);
  assert.match(stopAll[1], /\{ warning: STOP_ALL_WARNING \}/);

  const hook = code(read('hooks/useRobotCommand.js'));
  assert.match(hook, /\{ warning: commandWarning\(type\) \}/);
  assert.match(hook, /refreshDbState\(\)/);

  const modal = code(read('components/modals/AuthChallengeModal.jsx'));
  assert.match(modal, /\{request\.warning && \(/);
});
