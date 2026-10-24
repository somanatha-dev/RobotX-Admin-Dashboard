/**
 * The dashboard's obstacle-decision model: newest revision wins (so no late or replayed event can
 * move a decision backwards), the countdown follows the server's deadline and clock (so a reconnect
 * neither restarts nor stretches it), and the panel opens on the soonest awaiting decision.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EMPTY_DECISIONS,
  applyDecision,
  countdownSeconds,
  createObstacleDecisionStore,
  decisionLine,
  decisionsInScope,
  isAwaiting,
  nextAwaiting,
  remainingMs,
} from './obstacleDecision.js';
import { sample } from '../features/maps/__architecture__/helpers/decisionFixtures.mjs';

const T0 = Date.UTC(2026, 9, 24, 6, 0, 0);
const iso = (ms) => new Date(ms).toISOString();


test('a newer revision replaces the decision; an older or equal one is ignored', () => {
  let s = applyDecision(EMPTY_DECISIONS, sample({ revision: 2 }), { receivedAtMs: T0 });
  const decided = sample({ revision: 3, status: 'DECIDED', decision: { choice: 'STOP', source: 'MANUAL' } });
  s = applyDecision(s, decided, { receivedAtMs: T0 });
  assert.equal(s.decisions[0].decision.choice, 'STOP');
  // The late REQUIRED (revision 2) and a replay of 3 change nothing.
  const late = applyDecision(s, sample({ revision: 2 }), { receivedAtMs: T0 });
  assert.equal(late.decisions[0].decision.choice, 'STOP');
  assert.equal(applyDecision(late, decided, { receivedAtMs: T0 }).version, late.version);
});

test('an archived row never replaces what this page holds live', () => {
  const s = applyDecision(EMPTY_DECISIONS, sample({ revision: 4, status: 'EXECUTING', decision: { choice: 'REROUTE', source: 'DEFAULT_TIMEOUT' } }), { receivedAtMs: T0 });
  const after = applyDecision(s, sample({ revision: 9, archived: true, status: 'ABANDONED_ON_RESTART' }), { receivedAtMs: T0 });
  assert.equal(after.decisions[0].status, 'EXECUTING');
});

test("the countdown is the server's deadline by the server's clock: a skewed page clock does not change it", () => {
  // This page's clock is 3 s behind the server's: the server says it is T0 when the page says T0-3000.
  const s = applyDecision(EMPTY_DECISIONS, sample(), { receivedAtMs: T0 - 3000 });
  assert.equal(s.offsetMs, 3000);
  const d = s.decisions[0];
  assert.equal(countdownSeconds(d, T0 - 3000, s.offsetMs), 5);
  assert.equal(countdownSeconds(d, T0 - 3000 + 2500, s.offsetMs), 3);
  assert.equal(countdownSeconds(d, T0 + 2001, s.offsetMs), 0);
  assert.equal(remainingMs(d, T0 + 10_000, s.offsetMs), 0);
});

test('delivery delay never lengthens the countdown: a late event shows the time actually left, not 5 s', () => {
  // Same clocks; the event left the server at T0 and arrived 1.2 s later.
  const s = applyDecision(EMPTY_DECISIONS, sample({ serverNow: iso(T0) }), { receivedAtMs: T0 + 1200 });
  assert.equal(s.offsetMs, 0, 'the -1.2 s one-way reading is not taken as clock skew');
  assert.equal(countdownSeconds(s.decisions[0], T0 + 1200, s.offsetMs), 4);
  assert.equal(remainingMs(s.decisions[0], T0 + 1200, s.offsetMs), 3800);
  // A later, faster event can only raise the estimate towards the truth.
  const later = applyDecision(s, sample({ revision: 2, serverNow: iso(T0 + 2000) }), { receivedAtMs: T0 + 1500 });
  assert.equal(later.offsetMs, 500);
});

test('a reconnect that took 1 s to answer counts from the answer, and its offset can only shorten the countdown', () => {
  const store = createObstacleDecisionStore();
  // Asked at T0+3000, the server stamped serverNow at T0+3500, the answer arrived at T0+4000.
  store.hydrate([sample({ serverNow: iso(T0 + 3500) })], T0 + 3000, T0 + 4000);
  const s = store.getSnapshot();
  assert.equal(s.offsetMs, 500, 'measured from the ask: an upper bound (same clocks: truth is 0)');
  assert.equal(s.decisions[0].seenAtMs, T0 + 4000);
  // With the page clock still at mount time, the panel counts from the answer: 1 s + 0.5 s margin.
  assert.equal(remainingMs(s.decisions[0], T0, s.offsetMs), 500);
});

test('a panel whose clock is older than the state it shows counts from the state\'s arrival, never from earlier', () => {
  const s = applyDecision(EMPTY_DECISIONS, sample({ serverNow: iso(T0 + 4000) }), { receivedAtMs: T0 + 4000 });
  // The page last read its clock two minutes before the decision arrived.
  assert.equal(countdownSeconds(s.decisions[0], T0 - 120_000, s.offsetMs), 1);
});

test('a reconnect (hydrate) keeps the deadline: the countdown resumes, never restarts', () => {
  const store = createObstacleDecisionStore();
  store.apply(sample(), T0);
  // 3 s later the page reconnects and reads GET /api/dtaro/decisions.
  store.hydrate([sample({ revision: 1, serverNow: iso(T0 + 3000) })], T0 + 3000, T0 + 3000);
  const s = store.getSnapshot();
  assert.equal(countdownSeconds(s.decisions[0], T0 + 3000, s.offsetMs), 2);
  assert.equal(s.decisions.length, 1, 'no duplicate decision');
});

test('the panel opens on the soonest awaiting decision, skipping set-aside and decided ones', () => {
  let s = EMPTY_DECISIONS;
  s = applyDecision(s, sample({ decisionId: 'late', receivedAt: iso(T0 + 1000), deadlineAt: iso(T0 + 6000) }), { receivedAtMs: T0 });
  s = applyDecision(s, sample({ decisionId: 'soon' }), { receivedAtMs: T0 });
  s = applyDecision(s, sample({ decisionId: 'done', status: 'COMPLETED', decision: { choice: 'STOP', source: 'MANUAL' } }), { receivedAtMs: T0 });
  assert.deepEqual([nextAwaiting(s).decision.decisionId, nextAwaiting(s).others], ['soon', 1]);
  assert.equal(nextAwaiting(s, { setAside: new Set(['soon']) }).decision.decisionId, 'late');
  assert.equal(isAwaiting(s.decisions.find((d) => d.decisionId === 'done')), false);
});

test('manual and automatic decisions are told apart in words', () => {
  assert.match(decisionLine(sample({ decision: { choice: 'REROUTE', source: 'DEFAULT_TIMEOUT' } })), /applied automatically by the server: no operator decision within 5 s/);
  assert.match(decisionLine(sample({ decision: { choice: 'STOP', source: 'MANUAL' } })), /^Stop — chosen by an operator$/);
  assert.equal(decisionLine(sample()), null);
});

test('decisions are scoped to the selected campus regions', () => {
  let s = applyDecision(EMPTY_DECISIONS, sample(), { receivedAtMs: T0 });
  s = applyDecision(s, sample({ decisionId: 'other', obstacle: { ...sample().obstacle, regionId: 'jssate' } }), { receivedAtMs: T0 });
  assert.deepEqual(decisionsInScope(s, ['rnsit']).map((d) => d.decisionId), ['dec-1']);
  assert.equal(decisionsInScope(s, null).length, 2);
});

test('malformed payloads are ignored; reset empties the store', () => {
  const store = createObstacleDecisionStore();
  assert.equal(store.apply({ revision: 1 }), false);
  assert.equal(store.apply(null), false);
  store.apply(sample(), T0);
  store.reset();
  assert.equal(store.getSnapshot().decisions.length, 0);
});
