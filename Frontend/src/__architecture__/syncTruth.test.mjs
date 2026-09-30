/**
 * FS-01 … FS-06, FS-08 (frontend ↔ backend behaviour-sync audit, 2026-09-30).
 *
 * FS-01  `robot_offline` / `robot_online` are subscribed; an offline robot stops showing online.
 * FS-02  the socket's transport state is kept and shown; a dead backend no longer looks live.
 * FS-03  the session restore runs once, and only a 401/404 signs the operator out.
 * FS-04  a reassigned task names its new robot at once (robot code, never the REST UUID).
 * FS-05  RETURN is not offered for a unit that holds a task, and warns otherwise.
 * FS-06  the obstacle alert is information: no countdown, no reroute claim, no legacy reroute.
 * FS-08  one Idempotency-Key per task draft, sent on every retry of that draft.
 *
 * Decisions are exercised through the pure modules the provider calls (behavioural); the
 * wiring into the provider and pages is structural, like the other files here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BACKEND = path.resolve(SRC, '..', '..', 'Backend');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(SRC, rel));
// Comments removed, so a sentence that *describes* old behaviour cannot satisfy or fail a check.
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
const load = (rel) => import(pathToFileURL(path.join(SRC, rel)).href);

function allSourceFiles(dir = SRC) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__architecture__') continue;
      out.push(...allSourceFiles(full));
    } else if (/\.(jsx?|mjs)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

// ── FS-01: robot presence ────────────────────────────────────────────────────

test('FS-01 the socket contract names the backend\'s own presence events', async () => {
  const { DASHBOARD_EVENTS } = await load('lib/socket.js');
  assert.equal(DASHBOARD_EVENTS.ROBOT_OFFLINE, 'robot_offline');
  assert.equal(DASHBOARD_EVENTS.ROBOT_ONLINE, 'robot_online');
  // Not invented: these are the names robot.handler.js emits to the dashboard room.
  const handler = fs.readFileSync(path.join(BACKEND, 'src/sockets/handlers/robot.handler.js'), 'utf8');
  assert.match(handler, /io\.to\("dashboard"\)\.emit\("robot_offline", \{ robotId: boundRobotId \}\)/);
  assert.match(handler, /io\.to\("dashboard"\)\.emit\("robot_online", \{ robotId \}\)/);
});

test('FS-01 robot_offline applies exactly what markRobotOffline wrote, to that robot only', async () => {
  const { applyRobotOffline, applyRobotOnline } = await load('lib/liveState.js');
  const robots = [
    { robotId: 'V1DEMO-01', isOnline: true, status: 'PAUSED', battery: 80, lat: 1, lon: 2 },
    { robotId: 'V1DEMO-02', isOnline: true, status: 'IDLE', battery: 70 },
  ];
  const off = applyRobotOffline(robots, { robotId: 'V1DEMO-01' });
  assert.deepEqual(off[0], { robotId: 'V1DEMO-01', isOnline: false, status: 'OFFLINE', battery: 80, lat: 1, lon: 2 });
  assert.equal(off[1], robots[1], 'other robots are untouched');
  assert.equal(applyRobotOffline(robots, { robotId: 'NOPE' }), robots, 'an unknown robot changes nothing');

  // robot_online: liveness only — the restored status is not in the event, so it is not guessed.
  const on = applyRobotOnline(off, { robotId: 'V1DEMO-01' });
  assert.equal(on[0].isOnline, true);
  assert.equal(on[0].status, 'OFFLINE', 'the status comes from the refetch, not from the frontend');
});

test('FS-01 the provider subscribes to both, refetches on online, and cleans every listener up', () => {
  const src = code(read('context/AppProvider.jsx'));
  assert.match(src, /socket\.on\(DASHBOARD_EVENTS\.ROBOT_OFFLINE, onRobotOffline\)/);
  assert.match(src, /socket\.on\(DASHBOARD_EVENTS\.ROBOT_ONLINE, onRobotOnline\)/);
  assert.match(src, /const onRobotOnline = \(data\) => \{[\s\S]*?refreshDbState\(\)/);
  // Every registration has its matching removal (no duplicate listeners across re-login/HMR).
  const ons = [...src.matchAll(/socket(\.io)?\.on\(([^,]+), (\w+)\)/g)].map((m) => `${m[1] || ''}|${m[2]}|${m[3]}`);
  const offs = [...src.matchAll(/socket(\.io)?\.off\(([^,]+), (\w+)\)/g)].map((m) => `${m[1] || ''}|${m[2]}|${m[3]}`);
  assert.ok(ons.length >= 20, 'registrations found');
  assert.deepEqual([...ons].sort(), [...offs].sort());
});

// ── FS-02: live-connection truth ─────────────────────────────────────────────

test('FS-02 connection state is read from the socket, and says nothing about robots', async () => {
  const { CONNECTION, connectionStateOf, connectionBanner } = await load('lib/connectionState.js');
  const at = (flags, everConnected, authenticated = true) => connectionStateOf(flags, { authenticated, everConnected });
  assert.equal(at({ connected: true, active: true }, true, false), CONNECTION.IDLE, 'no session, no banner');
  assert.equal(at({ connected: true, active: true }, true), CONNECTION.CONNECTED);
  assert.equal(at({ connected: false, active: true }, false), CONNECTION.CONNECTING);
  assert.equal(at({ connected: false, active: true }, true), CONNECTION.RECONNECTING);
  assert.equal(at({ connected: false, active: false }, true), CONNECTION.DISCONNECTED);

  assert.equal(connectionBanner(CONNECTION.CONNECTED, 1), null);
  assert.equal(connectionBanner(CONNECTION.IDLE, null), null);
  const lastLive = new Date(2026, 8, 30, 14, 5, 9).getTime();
  for (const state of [CONNECTION.RECONNECTING, CONNECTION.DISCONNECTED]) {
    const b = connectionBanner(state, lastLive);
    assert.equal(b.kind, 'warning');
    assert.match(b.message, /from 14:05:09 or earlier/, 'says when the data stopped being live');
    assert.match(b.message, /not evidence that any robot is online or offline/);
  }
});

test('FS-02 a real socket that cannot reach the backend reads as not live', async () => {
  const { io } = await import('socket.io-client');
  const { CONNECTION, connectionStateOf } = await load('lib/connectionState.js');
  // Port 9 (discard) on loopback: nothing answers; socket.io keeps retrying by itself.
  const s = io('http://127.0.0.1:9', { autoConnect: false, reconnectionDelay: 50, timeout: 200 });
  try {
    s.connect();
    assert.equal(connectionStateOf(s, { authenticated: true, everConnected: false }), CONNECTION.CONNECTING);
    assert.equal(connectionStateOf(s, { authenticated: true, everConnected: true }), CONNECTION.RECONNECTING);
    s.disconnect();
    assert.equal(connectionStateOf(s, { authenticated: true, everConnected: true }), CONNECTION.DISCONNECTED);
  } finally {
    s.disconnect();
  }
});

test('FS-02 the provider tracks transport events and the layout shows the banner on every page', () => {
  const src = code(read('context/AppProvider.jsx'));
  const effect = src.match(/const readConnection = useCallback\(\(\) => \{[\s\S]*?\}, \[readConnection\]\);/);
  assert.ok(effect, 'connection tracking found');
  for (const needle of ["socket.on('connect', onConnect)", "socket.on('disconnect', onDisconnect)", "socket.on('connect_error', onConnectError)"]) {
    assert.ok(effect[0].includes(needle), needle);
  }
  assert.doesNotMatch(effect[0], /setRobots|isOnline/, 'a transport event changes no robot');
  assert.match(src, /connection,\n/, 'exposed through the provider');

  const layout = code(read('router/layout.jsx'));
  assert.match(layout, /connectionBanner\(connection\?\.state, connection\?\.lastLiveAtMs\)/);
  assert.match(layout, /data-connection-state=\{connection\.state\}/);
});

// ── FS-03: session restore ───────────────────────────────────────────────────

test('FS-03 only a 401 or 404 means "no session"; a network error or 5xx does not', async () => {
  const { SESSION_CHECK, sessionCheckOutcome } = await load('lib/sessionCheck.js');
  const { me } = await load('lib/api/auth.js');
  const original = globalThis.fetch;
  const outcomeFor = async (fetchImpl) => {
    globalThis.fetch = fetchImpl;
    try {
      await me();
      return 'resolved';
    } catch (err) {
      return sessionCheckOutcome(err);
    } finally {
      globalThis.fetch = original;
    }
  };
  const reply = (status, body) => async () => new Response(JSON.stringify(body), { status });
  assert.equal(await outcomeFor(reply(401, { message: 'Unauthorized' })), SESSION_CHECK.NO_SESSION);
  assert.equal(await outcomeFor(reply(404, { message: 'User not found' })), SESSION_CHECK.NO_SESSION);
  assert.equal(await outcomeFor(reply(500, { message: 'Internal Server Error' })), SESSION_CHECK.UNREACHABLE);
  assert.equal(await outcomeFor(reply(502, {})), SESSION_CHECK.UNREACHABLE);
  assert.equal(await outcomeFor(reply(503, {})), SESSION_CHECK.UNREACHABLE);
  assert.equal(await outcomeFor(async () => { throw new TypeError('Failed to fetch'); }), SESSION_CHECK.UNREACHABLE);
  assert.equal(await outcomeFor(reply(200, { user: { id: 'u' } })), 'resolved');
});

test('FS-03 the restore runs once per mount, and signs out only on "no session"', () => {
  const src = code(read('context/AppProvider.jsx'));
  const restore = src.match(/const check = async \(\) => \{[\s\S]*?\n {2}\}, \[([^\]]*)\]\);/);
  assert.ok(restore, 'restore effect found');
  assert.equal(restore[1].trim(), 'refreshDbState', 'navigation must not re-run the session check');
  const body = restore[0];
  assert.ok(body.indexOf('SESSION_CHECK.UNREACHABLE') > -1);
  assert.ok(
    body.indexOf('SESSION_CHECK.UNREACHABLE') < body.indexOf("navigateRef.current('/login')"),
    'an unreachable backend is handled before the sign-out path',
  );
  assert.match(body, /setTimeout\(check, sessionRetryDelayMs\(attempt\)\)/, 'unreachable → ask again');
  // The one in-session /me (UNAUTHORIZED retry) follows the same rule.
  assert.match(src, /if \(sessionCheckOutcome\(err\) === SESSION_CHECK\.NO_SESSION\) sessionExpiredRef\.current\?\.\(\);/);
  // A page change still notices an expired cookie — by /me alone, never by refetching data,
  // and never signing out because the backend is unreachable.
  const pageCheck = src.match(/const checkedPathRef = useRef\(null\);[\s\S]*?\}, \[pathname\]\);/);
  assert.ok(pageCheck, 'page-change session check found');
  assert.match(pageCheck[0], /authApi\.me\(\)\.catch\(\(err\) => \{\s*if \(sessionCheckOutcome\(err\) === SESSION_CHECK\.NO_SESSION\) sessionExpiredRef\.current\?\.\(\);\s*\}\);/);
  assert.doesNotMatch(pageCheck[0], /refreshDbState|navigate/);
  // The gate says why it is waiting instead of sending the operator to /login.
  const router = code(read('router/AppRouter.jsx'));
  assert.match(router, /if \(!isAuthResolved && isAuthUnreachable\)/);
});

// ── FS-04: task robot identity ───────────────────────────────────────────────

test('FS-04 a reassignment replaces the robot the card shows; the UUID is never the code', async () => {
  const { applyTaskUpdate, taskRobotCode } = await load('lib/liveState.js');
  const UUID_01 = '0b8d9c4e-0000-4000-8000-000000000001';
  const rest = { taskId: 'TSK-1', status: 'ASSIGNED', robotId: UUID_01, robot: { robotId: 'V1DEMO-01' } };
  assert.equal(taskRobotCode(rest), 'V1DEMO-01');

  const moved = applyTaskUpdate(rest, { taskId: 'TSK-1', robotId: 'V1DEMO-02', status: 'ASSIGNED' });
  assert.equal(taskRobotCode(moved), 'V1DEMO-02', 'the new robot, at once');
  assert.equal(moved.robotId, null, 'the previous robot\'s UUID is not kept beside the new code');
  assert.notEqual(moved.robotId, 'V1DEMO-02', 'a code is never written where REST keeps a UUID');

  const same = applyTaskUpdate(rest, { taskId: 'TSK-1', robotId: 'V1DEMO-01', status: 'COMPLETED' });
  assert.equal(same.robotId, UUID_01, 'same robot: the UUID stays');
  assert.equal(same.status, 'COMPLETED');

  const statusOnly = applyTaskUpdate(rest, { taskId: 'TSK-1', status: 'VERIFYING', verification: { reason: 'x' } });
  assert.deepEqual(statusOnly.robot, rest.robot);
  assert.deepEqual(statusOnly.verification, { reason: 'x' });

  // A REST row with only a UUID names no code: nothing to show rather than a UUID.
  assert.equal(taskRobotCode({ robotId: UUID_01, robot: null }), null);
});

test('FS-04 the card reads only the code; the provider refetches bindings; the map moves the route', () => {
  const page = code(read('pages/TasksPage.jsx'));
  assert.equal((page.match(/taskRobotCode\(/g) || []).length, 2);
  assert.doesNotMatch(page, /robot\?\.robotId \|\| t(ask)?\.robotId/);

  const src = code(read('context/AppProvider.jsx'));
  const updated = src.match(/const onTaskUpdated = \(data\) => \{[\s\S]*?\n {4}\};/);
  assert.ok(updated);
  assert.match(updated[0], /applyTaskUpdate\(t, data\)/);
  assert.match(updated[0], /refreshDbState\(\)/, 'Robot.currentTaskId changed in the backend; fetch it');
  assert.doesNotMatch(updated[0], /robotId: data\.robotId/);

  const map = code(read('features/maps/mapControl/hooks/useRobotStream.js'));
  assert.equal((map.match(/releaseFromOtherRobots\(taskId, robotId\);/g) || []).length, 2,
    'TASK_ASSIGNED and a non-terminal TASK_UPDATED both release the task from its previous robot');
});

// ── FS-05: RETURN ────────────────────────────────────────────────────────────

test('FS-05 RETURN is not offered while the unit holds a task, and warns when it is', async () => {
  const m = await load('lib/robotCommands.js');
  const idle = { robotId: 'V1DEMO-01', status: 'IDLE', currentTask: null };
  assert.deepEqual(m.returnAvailability(idle, []), { available: true, reason: null });

  const bound = m.returnAvailability({ ...idle, currentTask: { taskId: 'TSK-9' } }, []);
  assert.equal(bound.available, false);
  assert.match(bound.reason, /TSK-9/);
  assert.match(bound.reason, /bypasses the assignment engine/);

  // Between refetches: a live task naming the unit is enough (the unsafe direction is to offer it).
  const tasks = [{ taskId: 'TSK-7', status: 'ASSIGNED', robot: { robotId: 'V1DEMO-01' } }];
  assert.equal(m.returnAvailability(idle, tasks).available, false);
  // …but not a finished one, and not another unit's.
  assert.equal(m.returnAvailability(idle, [{ ...tasks[0], status: 'COMPLETED' }]).available, true);
  assert.equal(m.returnAvailability({ ...idle, robotId: 'V1DEMO-02' }, tasks).available, true);

  const warning = m.commandWarning('RETURN');
  assert.match(warning, /assignment engine takes no part/);
  assert.match(warning, /does not complete or cancel any task/);
});

test('FS-05 both RETURN buttons are gated by returnAvailability', () => {
  for (const [page, variable] of [['pages/RobotDetailPage.jsx', 'returnState'], ['pages/RobotsPage.jsx', 'selectedReturn']]) {
    const src = code(read(page));
    assert.match(src, new RegExp(`const ${variable} = returnAvailability\\(`), page);
    assert.match(src, new RegExp(`disabled=\\{!${variable}\\.available\\}`), page);
    assert.match(src, new RegExp(`onClick=\\{\\(\\) => sendCommand\\([^)]*'RETURN'\\)\\}\\s*disabled=\\{!${variable}\\.available\\}`), page);
  }
});

// ── FS-06: obstacle alert ────────────────────────────────────────────────────

test('FS-06 the alert is built from the event only: no countdown, and no obstacle id posing as a task', async () => {
  const { obstacleAlertFrom, rerouteAlertLogLine, OBSTACLE_NO_ACTION_NOTE } = await load('lib/obstacleAlert.js');
  const event = { obstacleId: 'OBS-1', lat: 12.9, lon: 77.5, zoneName: null, zoneId: null, severity: 'HIGH', reportingRobotId: 'V1DEMO-03', timestamp: 1, expiresAt: 2 };
  const noTask = obstacleAlertFrom(event, [{ robotId: 'V1DEMO-03', currentTask: null }]);
  assert.equal(noTask.taskId, null, 'the obstacle id used to be shown as the Task ID');
  assert.equal(noTask.obstacleId, 'OBS-1');
  assert.equal('countdown' in noTask, false);
  assert.equal(obstacleAlertFrom(event, [{ robotId: 'V1DEMO-03', currentTask: { taskId: 'TSK-4' } }]).taskId, 'TSK-4');

  assert.doesNotMatch(OBSTACLE_NO_ACTION_NOTE, /auto-?rerout/i);
  assert.match(OBSTACLE_NO_ACTION_NOTE, /nothing has been rerouted/);
  assert.doesNotMatch(rerouteAlertLogLine({ robotId: 'V1DEMO-03' }), /\brerouted\b/, 'an alert sent is not a reroute performed');
});

test('FS-06 nothing in the dashboard fabricates a reroute or calls the legacy reroute path', () => {
  assert.equal(exists('hooks/useDecisionCountdown.js'), false, 'the countdown that logged "Swarm auto-rerouted" is gone');
  for (const file of allSourceFiles()) {
    const src = code(fs.readFileSync(file, 'utf8'));
    const rel = path.relative(SRC, file);
    assert.doesNotMatch(src, /\/reroute[`'"]/, `${rel} calls /tasks/:id/reroute`);
    assert.doesNotMatch(src, /rerouteTask|auto-?rerout|useDecisionCountdown/i, rel);
  }
  const modal = code(read('components/modals/DecisionRequiredModal.jsx'));
  assert.doesNotMatch(modal, /REROUTE|WAIT|countdown|unsplash/);
  const layout = code(read('router/layout.jsx'));
  const dismiss = layout.match(/const handleDismissAlert = useCallback\(([^;]*)\);/);
  assert.ok(dismiss);
  assert.equal(dismiss[1].trim(), '() => setDecisionRequest(null), [setDecisionRequest]', 'dismissing sends nothing and claims nothing');
});

// ── FS-08: idempotent task creation ──────────────────────────────────────────

test('FS-08 keys are random v4 UUIDs, never derived from the task', async () => {
  const { newIdempotencyKey } = await load('lib/idempotency.js');
  const a = newIdempotencyKey();
  const b = newIdempotencyKey();
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(a, b);
});

test('FS-08 a retried draft sends the same key; the backend\'s DUPLICATE answer is the original task', async () => {
  const { assignTask } = await load('lib/api/tasks.js');
  const { newIdempotencyKey } = await load('lib/idempotency.js');
  // A stand-in for intake's contract (tasks.controller + intake.admit): the first submission
  // under a key is ACCEPTED, a repeat is DUPLICATE with the original task.
  const accepted = new Map();
  const sent = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const key = init.headers?.['Idempotency-Key'] || null;
    sent.push({ key, body: init.body });
    if (key && accepted.has(key)) {
      return new Response(JSON.stringify({ ok: true, task: accepted.get(key), intake: { outcome: 'DUPLICATE', accepted: true } }), { status: 200 });
    }
    const task = { taskId: `TSK-${sent.length}` };
    if (key) accepted.set(key, task);
    return new Response(JSON.stringify({ ok: true, task, intake: { outcome: 'ACCEPTED', accepted: true } }), { status: 200 });
  };
  try {
    const body = { pickup: 'A', drop: 'B', regionId: 'rnsit' };
    const key = newIdempotencyKey();
    const first = await assignTask(body, { idempotencyKey: key });
    const retry = await assignTask(body, { idempotencyKey: key });
    assert.equal(sent[0].key, key);
    assert.equal(sent[1].key, key, 'the retry re-sends the draft\'s key');
    assert.equal(sent[0].body, sent[1].body, 'and the same body');
    assert.equal(first.intake.outcome, 'ACCEPTED');
    assert.equal(retry.intake.outcome, 'DUPLICATE');
    assert.equal(retry.task.taskId, first.task.taskId, 'no second task');
    assert.equal(JSON.parse(sent[0].body).regionId, 'rnsit', 'the body contract is unchanged');
    assert.equal('idempotencyKey' in JSON.parse(sent[0].body), false, 'the key is a header, not a body field');
  } finally {
    globalThis.fetch = original;
  }
});

test('FS-08 the key belongs to the draft and is captured outside the retried action', () => {
  const modal = code(read('components/modals/CreateTaskModal.jsx'));
  assert.match(modal, /const \[idempotencyKey\] = useState\(newIdempotencyKey\);/, 'made once per form, not per render or per click');
  assert.match(modal, /onCreate\(\{\s*campusId,\s*idempotencyKey,/);

  const src = code(read('context/AppProvider.jsx'));
  const create = src.match(/const createTask = useCallback\(([\s\S]*?)\n {2}\);/);
  assert.ok(create);
  const body = create[1];
  const keyAt = body.indexOf('const idempotencyKey =');
  const authAt = body.indexOf('requestAuth(');
  assert.ok(keyAt > -1 && keyAt < authAt, 'fixed before the action the auth dialog may re-run');
  assert.match(body, /tasksApi\.assignTask\(buildAssignTaskRequest\(taskDraft\), \{ idempotencyKey \}\)/);
  assert.match(body, /try \{\s*await refreshDbState\(\);\s*\} catch \{/, 'a refresh failure after a 200 is not a failed creation');
  assert.match(body, /DUPLICATE_OUTCOME/);
});
