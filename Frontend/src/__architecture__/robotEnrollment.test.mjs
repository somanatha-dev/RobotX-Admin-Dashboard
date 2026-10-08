/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Physical-robot enrollment — commission, connect, done.
 *
 *   node --test src/__architecture__/
 *   (or: npm run test:arch, from Frontend/)
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 * Commissioning a physical unit ended on the Units list. Nothing in the dashboard issued a
 * pairing code. Someone extracted a JWT and curled `POST /api/robots/commission`, carried the
 * code to the Pi by hand, and checked the Pi's own API to learn whether it had worked. The
 * dashboard already received `robot_online` the moment the robot signed in, and nothing used
 * it for this.
 *
 * ── What is claimed ─────────────────────────────────────────────────────────
 *   1 — commissioning lands on the robot's Connect page, and the route exists;
 *   2 — a code is issued through the existing endpoint, behind the step-up, from robotId alone;
 *   3 — the code is shown with a countdown and one command, built only from six digits;
 *   4 — the robot coming online turns the page into "connected"; going offline after, "lost";
 *   5 — a refused attempt (robot_pairing_rejected) shows at once, with the count and the lock;
 *   6 — after a refresh a pending code is reported and never shown; replacing it is confirmed;
 *   7 — expiry, lockout, already-online, a code the server lost, and an unreadable status
 *       each have their own state;
 *   8 — the code never reaches the URL, browser storage or app state;
 *   9 — the detail page offers Connect / Re-pair for an offline physical unit only;
 *  10 — the commission form says the Robot ID must match the Pi's.
 *
 * As elsewhere in this directory: the rules live in `lib/` and are exercised, and the page
 * wiring — which has no DOM here — is read from source with comments stripped.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ENROLLMENT_PHASE,
  PAIRING_CODE_PATTERN,
  WAITING_HINT_AFTER_MS,
  applyPairingRejection,
  connectActionFor,
  connectPathFor,
  deriveEnrollmentView,
  enrollmentCommand,
  formatCountdown,
  issuedCodeFrom,
  secondsLeft,
} from '../lib/robotEnrollment.js';
import { getPairingStatus, requestPairingCode } from '../lib/api/robots.js';
import { DASHBOARD_EVENTS } from '../lib/socket.js';
import { getRouteTitle } from '../router/routeTitles.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BACKEND_SRC = path.resolve(SRC, '../../Backend/src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

/** Source with comments removed, so prose about a hazard never counts as the hazard. */
function code(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '');
}

/** The body of `case ENROLLMENT_PHASE.X:` up to the next case or default. */
function caseBody(source, phaseKey) {
  const start = source.indexOf(`case ENROLLMENT_PHASE.${phaseKey}:`);
  assert.ok(start >= 0, `no case for ${phaseKey}`);
  const rest = source.slice(start + 1);
  const next = rest.search(/\n\s*(case ENROLLMENT_PHASE\.|default:)/);
  return rest.slice(0, next < 0 ? undefined : next);
}

const CONNECT_PAGE = code(read('pages/ConnectRobotPage.jsx'));
const PROVIDER = code(read('context/AppProvider.jsx'));

const T0 = 1_760_000_000_000;
const PHYSICAL_OFFLINE = Object.freeze({ robotId: 'RBT-2000', simulated: false, isOnline: false, lastSeenAt: null });
const PHYSICAL_ONLINE = Object.freeze({ ...PHYSICAL_OFFLINE, isOnline: true, lastSeenAt: '2026-10-08T10:00:00.000Z' });
const FRESH_STATUS = Object.freeze({ isOnline: false, enrolled: false, pairingPending: false, failedAttempts: 0, locked: false });
const ISSUED = Object.freeze({ code: '482913', issuedAtMs: T0, expiresAtMs: T0 + 300_000 });

const view = (over = {}) =>
  deriveEnrollmentView({
    robot: PHYSICAL_OFFLINE,
    robotsLoaded: true,
    status: FRESH_STATUS,
    statusAtMs: T0 - 1000,
    statusFailed: false,
    issued: null,
    rejection: null,
    witnessedConnect: false,
    nowMs: T0 + 10_000,
    ...over,
  });

async function withFetch(respond, fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const { status = 200, body } = respond(String(url), init);
    return new Response(body === undefined ? '' : JSON.stringify(body), { status });
  };
  try {
    return { result: await fn(), calls };
  } finally {
    globalThis.fetch = original;
  }
}

// ─── 1 ───────────────────────────────────────────────────────────────────────

test('1a — a successful physical commission navigates to the Connect page, not the robot list', () => {
  const start = PROVIDER.indexOf('const commission = useCallback(');
  const end = PROVIDER.indexOf('const createSimulatedRobot', start);
  const body = PROVIDER.slice(start, end);
  assert.match(body, /navigate\(connectPathFor\(robotId\)\)/);
  assert.doesNotMatch(body, /navigate\('\/robots'\)/);
  assert.equal(connectPathFor('RBT-2000'), '/robots/RBT-2000/connect');
  assert.equal(connectPathFor('RBT 2/0'), '/robots/RBT%202%2F0/connect');
});

test('1b — /robots/:id/connect is routed to the Connect page and titled', () => {
  const router = code(read('router/AppRouter.jsx'));
  assert.match(router, /<Route path="robots\/:id\/connect" element=\{<ConnectRobotPage \/>\} \/>/);
  assert.equal(getRouteTitle('/robots/RBT-2000/connect'), 'Connect Robot');
  assert.equal(getRouteTitle('/robots/RBT-2000'), 'Unit Details');
});

// ─── 2 ───────────────────────────────────────────────────────────────────────

test('2a — requestPairingCode posts robotId alone to the existing commission endpoint', async () => {
  const { result, calls } = await withFetch(
    () => ({ body: { ok: true, robot: { robotId: 'RBT-2000' }, pairingCode: '482913', expiresIn: 300 } }),
    () => requestPairingCode('RBT-2000'),
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api\/robots\/commission$/);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.credentials, 'include');
  assert.deepEqual(JSON.parse(calls[0].init.body), { robotId: 'RBT-2000' });
  assert.deepEqual(result, { pairingCode: '482913', expiresIn: 300 });
});

test('2b — the page issues a code only inside the step-up challenge', () => {
  const issue = CONNECT_PAGE.slice(CONNECT_PAGE.indexOf('const issueCode = useCallback('));
  assert.match(issue, /requestAuth\(`ISSUE PAIRING CODE: \$\{robotId\}`, async \(\) => \{\s*const response = await robotsApi\.requestPairingCode\(robotId\)/);
  assert.equal((CONNECT_PAGE.match(/requestPairingCode\(/g) || []).length, 1);
});

test('2c — what the page keeps from the response: six digits and an expiry, or a refusal', () => {
  assert.deepEqual(issuedCodeFrom({ pairingCode: '004213', expiresIn: 300 }, T0), {
    code: '004213',
    issuedAtMs: T0,
    expiresAtMs: T0 + 300_000,
  });
  for (const bad of [null, '', '12345', '1234567', 'abcdef', '12 456', 482913.5]) {
    assert.throws(() => issuedCodeFrom({ pairingCode: bad, expiresIn: 300 }, T0), /did not return a pairing code/);
  }
});

// ─── 3 ───────────────────────────────────────────────────────────────────────

test('3a — the countdown: whole seconds left, never negative, shown as m:ss', () => {
  assert.equal(secondsLeft(T0 + 300_000, T0), 300);
  assert.equal(secondsLeft(T0 + 300_000, T0 + 299_001), 1);
  assert.equal(secondsLeft(T0 + 300_000, T0 + 300_000), 0);
  assert.equal(secondsLeft(T0 + 300_000, T0 + 900_000), 0);
  assert.equal(formatCountdown(300), '5:00');
  assert.equal(formatCountdown(61), '1:01');
  assert.equal(formatCountdown(9), '0:09');
  assert.equal(formatCountdown(-4), '0:00');
});

test('3b — a fresh code is WAITING with its seconds; a hint appears only after a while', () => {
  const early = view({ issued: ISSUED, nowMs: T0 + 10_000 });
  assert.equal(early.phase, ENROLLMENT_PHASE.WAITING);
  assert.equal(early.secondsLeft, 290);
  assert.equal(early.showWaitingHint, false);
  assert.equal(view({ issued: ISSUED, nowMs: T0 + WAITING_HINT_AFTER_MS }).showWaitingHint, true);
});

test('3c — the one command: the code into the file the agent reads, then a restart', () => {
  assert.equal(
    enrollmentCommand('482913'),
    "printf 'ROBOTX_PAIRING_CODE=%s\\n' 482913 | sudo tee /etc/robotx/pairing.env >/dev/null && sudo systemctl restart robotx-agent",
  );
});

test('3d — nothing but six digits can reach the shell through the command', () => {
  for (const hostile of ['123456; rm -rf /', '$(id)', '`id`', '12345', '1234567', '', null, '123456\n']) {
    assert.throws(() => enrollmentCommand(hostile), /expected exactly six digits/);
  }
  assert.ok(PAIRING_CODE_PATTERN.test('000000'));
});

// ─── 4 ───────────────────────────────────────────────────────────────────────

test('4a — the robot coming online after a code was issued is CONNECTED', () => {
  assert.equal(view({ issued: ISSUED, robot: PHYSICAL_ONLINE }).phase, ENROLLMENT_PHASE.CONNECTED);
  // Even once the page has dropped the spent code from memory.
  assert.equal(view({ issued: { ...ISSUED, code: null }, robot: PHYSICAL_ONLINE }).phase, ENROLLMENT_PHASE.CONNECTED);
  assert.equal(view({ robot: PHYSICAL_ONLINE, witnessedConnect: true }).phase, ENROLLMENT_PHASE.CONNECTED);
});

test('4b — connected, then offline, is CONNECTION_LOST rather than back to the start', () => {
  assert.equal(view({ issued: { ...ISSUED, code: null }, witnessedConnect: true }).phase, ENROLLMENT_PHASE.CONNECTION_LOST);
});

test('4c — the page follows the live robot row, which robot_online / robot_offline move', () => {
  assert.match(PROVIDER, /socket\.on\(DASHBOARD_EVENTS\.ROBOT_ONLINE, onRobotOnline\)/);
  assert.match(PROVIDER, /socket\.on\(DASHBOARD_EVENTS\.ROBOT_OFFLINE, onRobotOffline\)/);
  assert.match(CONNECT_PAGE, /const robot = robots\.find\(\(r\) => r\.robotId === robotId\)/);
  // The transition is recorded during render, and it drops the spent code.
  assert.match(CONNECT_PAGE, /if \(lastOnline === false && onlineNow === true\) \{[\s\S]*?setWitnessedConnect\(true\)[\s\S]*?code: null/);
  // The connected view says what connected does not mean.
  const connected = caseBody(CONNECT_PAGE, 'CONNECTED');
  assert.match(connected, /Robot Connected/);
  assert.match(connected, /not the same as ready for tasks/);
  assert.match(connected, /Continue to Robot|continueButton/);
});

// ─── 5 ───────────────────────────────────────────────────────────────────────

test('5a — robot_pairing_rejected is the name the backend emits, and the provider follows it', () => {
  assert.equal(DASHBOARD_EVENTS.ROBOT_PAIRING_REJECTED, 'robot_pairing_rejected');
  const handler = fs.readFileSync(path.join(BACKEND_SRC, 'sockets/handlers/robot.handler.js'), 'utf8');
  assert.match(handler, /emit\("robot_pairing_rejected", \{ robotId, failedAttempts, locked: Boolean\(locked\) \}\)/);
  assert.match(PROVIDER, /socket\.on\(DASHBOARD_EVENTS\.ROBOT_PAIRING_REJECTED, onRobotPairingRejected\)/);
  assert.match(PROVIDER, /socket\.off\(DASHBOARD_EVENTS\.ROBOT_PAIRING_REJECTED, onRobotPairingRejected\)/);
  assert.match(PROVIDER, /setPairingRejections\(\(prev\) => applyPairingRejection\(prev, data, Date\.now\(\)\)\)/);
});

test('5b — only the three announced facts are kept, whatever else a payload carries', () => {
  const next = applyPairingRejection({}, { robotId: 'RBT-2000', failedAttempts: 2, locked: false, pairingCode: '482913', extra: 1 }, T0);
  assert.deepEqual(next, { 'RBT-2000': { failedAttempts: 2, locked: false, atMs: T0 } });
  assert.equal(applyPairingRejection(next, { failedAttempts: 3 }, T0), next); // no robotId: ignored
});

test('5c — a refusal after the code was issued is REJECTED at once, with the count', () => {
  const rejection = { failedAttempts: 2, locked: false, atMs: T0 + 5_000 };
  const v = view({ issued: ISSUED, rejection });
  assert.equal(v.phase, ENROLLMENT_PHASE.REJECTED);
  assert.equal(v.failedAttempts, 2);
  // A refusal from before this code was issued is history, not this code's verdict.
  assert.equal(view({ issued: ISSUED, rejection: { ...rejection, atMs: T0 - 1 } }).phase, ENROLLMENT_PHASE.WAITING);
});

test('5d — a refusal that locked pairing is LOCKED', () => {
  const v = view({ issued: ISSUED, rejection: { failedAttempts: 5, locked: true, atMs: T0 + 5_000 } });
  assert.equal(v.phase, ENROLLMENT_PHASE.LOCKED);
  assert.equal(v.failedAttempts, 5);
});

test('5e — a page holding no code (refreshed) still learns of a refusal or lockout at once', () => {
  // Found by the browser run: after a refresh the page sat on "code already issued" while the
  // robot locked itself out, because only refusals newer than *this page's* code counted.
  const pendingStatus = { ...FRESH_STATUS, pairingPending: true };
  const statusAtMs = T0;
  const locked = view({ status: pendingStatus, statusAtMs, rejection: { failedAttempts: 5, locked: true, atMs: T0 + 1 } });
  assert.equal(locked.phase, ENROLLMENT_PHASE.LOCKED);
  const refused = view({ status: pendingStatus, statusAtMs, rejection: { failedAttempts: 1, locked: false, atMs: T0 + 1 } });
  assert.equal(refused.phase, ENROLLMENT_PHASE.REJECTED);
  // An enrolled robot whose stored credential was refused needs a new code: REJECTED says so.
  const enrolledRefused = view({ status: { ...FRESH_STATUS, enrolled: true }, statusAtMs, rejection: { failedAttempts: 1, locked: false, atMs: T0 + 1 } });
  assert.equal(enrolledRefused.phase, ENROLLMENT_PHASE.REJECTED);
  // A refusal the status read already covers is not news.
  assert.equal(view({ status: pendingStatus, statusAtMs, rejection: { failedAttempts: 1, locked: false, atMs: T0 - 1 } }).phase, ENROLLMENT_PHASE.CODE_HIDDEN_PENDING);
  // Before any status has been read there is nothing to compare against: still loading.
  assert.equal(view({ status: null, statusAtMs: null, rejection: { failedAttempts: 1, locked: false, atMs: T0 } }).phase, ENROLLMENT_PHASE.LOADING);
});

// ─── 6 ───────────────────────────────────────────────────────────────────────

test('6a — after a refresh, a pending code is reported and never shown', () => {
  const v = view({ issued: null, status: { ...FRESH_STATUS, pairingPending: true } });
  assert.equal(v.phase, ENROLLMENT_PHASE.CODE_HIDDEN_PENDING);
  const pending = caseBody(CONNECT_PAGE, 'CODE_HIDDEN_PENDING');
  assert.match(pending, /Pairing code already issued/);
  assert.match(pending, /For security it cannot be shown again/);
  assert.doesNotMatch(pending, /issued\.code|command\b/);
});

test('6b — "Issue New Code" goes through an explicit confirmation that says it replaces the old one', () => {
  const pending = caseBody(CONNECT_PAGE, 'CODE_HIDDEN_PENDING');
  assert.match(pending, /confirming === 'replace' \?/);
  assert.match(pending, /onClick=\{\(\) => setConfirming\('replace'\)\}/);
  assert.match(pending, /Issue New Code/);
  assert.match(pending, /replaces the previous one/);
  // The code is issued only from the confirmation panel's own button.
  assert.match(pending, /<ConfirmPanel[\s\S]*?onConfirm=\{issueCode\}/);
  assert.doesNotMatch(pending, /generateButton\(/);
});

test('6c — the status is hydrated on load and when the live connection comes back, never on a timer', () => {
  assert.match(CONNECT_PAGE, /useEffect\(\(\) => \{\s*loadStatus\(\);\s*\}, \[loadStatus\]\)/);
  assert.match(CONNECT_PAGE, /connectionState === CONNECTION\.CONNECTED && previous && previous !== CONNECTION\.CONNECTED/);
  // The only interval is the countdown, and it runs only while a code is on screen.
  assert.equal((CONNECT_PAGE.match(/setInterval\(/g) || []).length, 1);
  assert.match(CONNECT_PAGE, /const counting = view\.phase === ENROLLMENT_PHASE\.WAITING;/);
});

// ─── 7 ───────────────────────────────────────────────────────────────────────

test('7a — expired: the code ran out before the robot used it', () => {
  const v = view({ issued: ISSUED, nowMs: ISSUED.expiresAtMs });
  assert.equal(v.phase, ENROLLMENT_PHASE.EXPIRED);
  assert.match(caseBody(CONNECT_PAGE, 'EXPIRED'), /Generate New Code/);
});

test('7b — locked from the status: no code can be issued from that state', () => {
  const v = view({ status: { ...FRESH_STATUS, locked: true, failedAttempts: 5 } });
  assert.equal(v.phase, ENROLLMENT_PHASE.LOCKED);
  assert.equal(view({ issued: ISSUED, status: { ...FRESH_STATUS, locked: true } }).phase, ENROLLMENT_PHASE.LOCKED);
  const locked = caseBody(CONNECT_PAGE, 'LOCKED');
  assert.doesNotMatch(locked, /generateButton\(|issueCode/);
  assert.match(locked, /second approver/);
});

test('7c — already online when the page opened: connected state, and no code offered', () => {
  assert.equal(view({ robot: PHYSICAL_ONLINE }).phase, ENROLLMENT_PHASE.ALREADY_ONLINE);
  const already = caseBody(CONNECT_PAGE, 'ALREADY_ONLINE');
  assert.match(already, /already connected/);
  assert.doesNotMatch(already, /generateButton\(|issueCode|setConfirming/);
});

test('7d — the server lost the code (restart) or it was replaced: CODE_NO_LONGER_VALID', () => {
  const v = view({ issued: ISSUED, status: { ...FRESH_STATUS, pairingPending: false }, statusAtMs: T0 + 20_000, nowMs: T0 + 30_000 });
  assert.equal(v.phase, ENROLLMENT_PHASE.CODE_NO_LONGER_VALID);
  // A status read *before* the code was issued says nothing about it.
  assert.equal(view({ issued: ISSUED, statusAtMs: T0 - 1 }).phase, ENROLLMENT_PHASE.WAITING);
});

test('7e — the remaining states: ready, enrolled offline, simulated, unknown, unreadable, loading', () => {
  assert.equal(view().phase, ENROLLMENT_PHASE.READY);
  assert.equal(view({ status: { ...FRESH_STATUS, enrolled: true } }).phase, ENROLLMENT_PHASE.ENROLLED_OFFLINE);
  assert.equal(view({ robot: { ...PHYSICAL_OFFLINE, simulated: true } }).phase, ENROLLMENT_PHASE.SIMULATED);
  assert.equal(view({ robot: undefined }).phase, ENROLLMENT_PHASE.NOT_FOUND);
  assert.equal(view({ robot: undefined, robotsLoaded: false }).phase, ENROLLMENT_PHASE.LOADING);
  assert.equal(view({ status: null, statusFailed: true }).phase, ENROLLMENT_PHASE.STATUS_UNAVAILABLE);
  assert.equal(view({ status: null }).phase, ENROLLMENT_PHASE.LOADING);
  // Re-pairing an enrolled robot is confirmed before the step-up.
  const enrolled = caseBody(CONNECT_PAGE, 'ENROLLED_OFFLINE');
  assert.match(enrolled, /confirming === 'repair' \?/);
  assert.match(enrolled, /<ConfirmPanel[\s\S]*?onConfirm=\{issueCode\}/);
  assert.match(enrolled, /previous\s+credential stops working/);
});

test('7f — getPairingStatus reads the status endpoint and keeps only the status fields', async () => {
  const { result, calls } = await withFetch(
    () => ({
      body: { ok: true, robotId: 'RBT 2', isOnline: false, lastSeenAt: null, enrolled: true, pairingPending: true, failedAttempts: 2, locked: false, pairingCode: '482913' },
    }),
    () => getPairingStatus('RBT 2'),
  );
  assert.match(calls[0].url, /\/api\/robots\/RBT%202\/pairing$/);
  assert.equal(calls[0].init.method, 'GET');
  assert.deepEqual(result, { robotId: 'RBT 2', isOnline: false, lastSeenAt: null, enrolled: true, pairingPending: true, failedAttempts: 2, locked: false });
  assert.ok(!('pairingCode' in result));
});

// ─── 8 ───────────────────────────────────────────────────────────────────────

test('8a — the code never reaches browser storage or the URL (source)', () => {
  const sources = {
    'pages/ConnectRobotPage.jsx': CONNECT_PAGE,
    'lib/robotEnrollment.js': code(read('lib/robotEnrollment.js')),
    'lib/api/robots.js': code(read('lib/api/robots.js')),
  };
  for (const [file, source] of Object.entries(sources)) {
    assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|document\.cookie/, `${file} touches browser storage`);
    assert.doesNotMatch(source, /history\.(push|replace)State|useSearchParams|searchParams|location\.hash/, `${file} touches the URL`);
  }
  // Every navigation from the Connect page goes to a fixed path or the robot's own page.
  const navigations = CONNECT_PAGE.match(/navigate\([^)]*\)/g) || [];
  assert.ok(navigations.length > 0);
  for (const call of navigations) assert.doesNotMatch(call, /\b(issued|code|command|pairingCode)\b/, call);
  // The check itself can fail: a navigation carrying the code would be caught.
  assert.match('navigate(`/robots/${robotId}?c=${issued.code}`)', /\b(issued|code|command|pairingCode)\b/);
  // The code is component state, not app state: the provider never holds it.
  assert.doesNotMatch(PROVIDER, /pairingCode|requestPairingCode|issuedCodeFrom/);
});

test('8b — issuing and reading status write nothing to browser storage (runtime)', async () => {
  const writes = [];
  const fakeStorage = { setItem: (k, v) => writes.push([k, v]), getItem: () => null, removeItem() {}, clear() {} };
  const before = { localStorage: globalThis.localStorage, sessionStorage: globalThis.sessionStorage };
  Object.defineProperty(globalThis, 'localStorage', { value: fakeStorage, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'sessionStorage', { value: fakeStorage, configurable: true, writable: true });
  try {
    await withFetch(
      (url) =>
        url.endsWith('/commission')
          ? { body: { ok: true, pairingCode: '482913', expiresIn: 300 } }
          : { body: { ok: true, robotId: 'RBT-2000', isOnline: false, enrolled: false, pairingPending: true, failedAttempts: 0, locked: false } },
      async () => {
        const issuedNow = issuedCodeFrom(await requestPairingCode('RBT-2000'), T0);
        enrollmentCommand(issuedNow.code);
        await getPairingStatus('RBT-2000');
      },
    );
  } finally {
    Object.defineProperty(globalThis, 'localStorage', { value: before.localStorage, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'sessionStorage', { value: before.sessionStorage, configurable: true, writable: true });
  }
  assert.deepEqual(writes, []);
});

// ─── 9 ───────────────────────────────────────────────────────────────────────

test('9 — detail page: Connect / Re-pair for an offline physical unit, nothing for online or simulated', () => {
  assert.deepEqual(connectActionFor(PHYSICAL_OFFLINE, null), { kind: 'connect', label: 'Connect Robot' });
  assert.deepEqual(connectActionFor(PHYSICAL_OFFLINE, { ...FRESH_STATUS, enrolled: false }), { kind: 'connect', label: 'Connect Robot' });
  assert.deepEqual(connectActionFor(PHYSICAL_OFFLINE, { ...FRESH_STATUS, enrolled: true }), { kind: 'repair', label: 'Re-pair Robot' });
  assert.equal(connectActionFor(PHYSICAL_ONLINE, { ...FRESH_STATUS, enrolled: true }), null);
  assert.equal(connectActionFor({ ...PHYSICAL_OFFLINE, simulated: true }, null), null);

  const detail = code(read('pages/RobotDetailPage.jsx'));
  // The detail page only navigates; issuing (confirmed, step-up) happens on the Connect page.
  assert.match(detail, /navigate\(connectPathFor\(robot\.robotId\)\)/);
  assert.doesNotMatch(detail, /requestPairingCode/);
  assert.match(detail, /data-connect-action="connected"/);
});

// ─── 10 ──────────────────────────────────────────────────────────────────────

test('10 — the commission form says the Robot ID must match the Pi, and links an existing unit', () => {
  const page = code(read('pages/CommissionPage.jsx'));
  assert.match(page, /The Robot ID must exactly match the ID configured on the physical Pi\./);
  assert.match(page, /aria-describedby="unit-id-help"/);
  assert.match(page, /rrNavigate\(connectPathFor\(existingId\)\)/);
});
