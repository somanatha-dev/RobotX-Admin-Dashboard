/**
 * `simulatorStatus` has two asynchronous writers — the full refresh (`refreshDbState`) and the
 * five-second poll — and a slow response used to overwrite a newer one; the poll could also
 * overlap itself. Ordering now lives in `lib/simulatorStatusSync.js`, driven here with
 * controllable promises: every interleaving is set up explicitly, nothing waits on a clock.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { POLL_OUTCOME, createSimulatorStatusPoller, createSimulatorStatusSync } from '../lib/simulatorStatusSync.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A promise the test settles by hand. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** The state as the provider holds it: every applied write, in order. */
function stateHolder() {
  const writes = [];
  return { apply: (value) => writes.push(value), writes, current: () => writes[writes.length - 1] };
}

/** The refresh's simulator half, as `refreshDbState` runs it: ticket at start, settle on answer. */
async function refreshWith(sync, answer) {
  const ticket = sync.begin();
  const value = await answer;
  return sync.settle(ticket, value || null);
}

const report = (label) => ({ label, charging: { stations: [] }, robots: [] });

test('a slow older poll answering after a newer refresh does not overwrite it', async () => {
  const state = stateHolder();
  const sync = createSimulatorStatusSync(state.apply);
  const slowPoll = deferred();
  const poller = createSimulatorStatusPoller({ sync, fetchStatus: () => slowPoll.promise });

  const pollRun = poller.tick(); // starts first (older ticket)…
  const refreshed = await refreshWith(sync, Promise.resolve(report('refresh-newer'))); // …newer one lands first
  assert.equal(refreshed, true);
  slowPoll.resolve(report('poll-older'));
  assert.equal(await pollRun, POLL_OUTCOME.DISCARDED_STALE);

  assert.deepEqual(state.writes.map((w) => w.label), ['refresh-newer']);
  assert.equal(state.current().label, 'refresh-newer');
});

test('a slow older refresh answering after a newer poll does not overwrite it', async () => {
  const state = stateHolder();
  const sync = createSimulatorStatusSync(state.apply);
  const slowRefresh = deferred();
  const poller = createSimulatorStatusPoller({ sync, fetchStatus: () => Promise.resolve(report('poll-newer')) });

  const refreshRun = refreshWith(sync, slowRefresh.promise); // older ticket
  assert.equal(await poller.tick(), POLL_OUTCOME.APPLIED);
  slowRefresh.resolve(report('refresh-older'));
  assert.equal(await refreshRun, false);

  assert.deepEqual(state.writes.map((w) => w.label), ['poll-newer']);
});

test('responses applied in start order still apply when they answer in start order', async () => {
  const state = stateHolder();
  const sync = createSimulatorStatusSync(state.apply);
  assert.equal(await refreshWith(sync, Promise.resolve(report('a'))), true);
  assert.equal(await refreshWith(sync, Promise.resolve(report('b'))), true);
  // A refresh whose simulator half answered nothing still writes `null` — "status unknown", as before.
  assert.equal(await refreshWith(sync, Promise.resolve(null)), true);
  assert.deepEqual(state.writes, [report('a'), report('b'), null]);
});

test('a poll does not start while the previous one is still in flight', async () => {
  const state = stateHolder();
  const sync = createSimulatorStatusSync(state.apply);
  const first = deferred();
  let fetches = 0;
  const poller = createSimulatorStatusPoller({
    sync,
    fetchStatus: () => {
      fetches += 1;
      return first.promise;
    },
  });

  const run = poller.tick();
  assert.equal(poller.isInFlight(), true);
  assert.equal(await poller.tick(), POLL_OUTCOME.SKIPPED_IN_FLIGHT);
  assert.equal(await poller.tick(), POLL_OUTCOME.SKIPPED_IN_FLIGHT);
  assert.equal(fetches, 1, 'no second request while the first is outstanding');

  first.resolve(report('only'));
  assert.equal(await run, POLL_OUTCOME.APPLIED);
  assert.equal(poller.isInFlight(), false);
});

test('a failed poll releases the in-flight guard, so the next poll runs', async () => {
  const state = stateHolder();
  const sync = createSimulatorStatusSync(state.apply);
  const answers = [deferred(), deferred(), deferred()];
  let call = 0;
  const poller = createSimulatorStatusPoller({ sync, fetchStatus: () => answers[call++].promise });

  // Rejected.
  const failing = poller.tick();
  answers[0].reject(new Error('network down'));
  assert.equal(await failing, POLL_OUTCOME.FAILED);
  assert.equal(poller.isInFlight(), false);

  // Answered nothing (the simulator API resolves null on failure): the last report is kept.
  const empty = poller.tick();
  answers[1].resolve(null);
  assert.equal(await empty, POLL_OUTCOME.EMPTY);
  assert.equal(poller.isInFlight(), false);
  assert.equal(state.writes.length, 0);

  // And polling carries on.
  const next = poller.tick();
  answers[2].resolve(report('recovered'));
  assert.equal(await next, POLL_OUTCOME.APPLIED);
  assert.equal(call, 3);
  assert.equal(state.current().label, 'recovered');
});

test('teardown: a poll still in flight when the poller stops is never applied, and no tick runs after', async () => {
  const state = stateHolder();
  const sync = createSimulatorStatusSync(state.apply);
  const pending = deferred();
  let fetches = 0;
  const poller = createSimulatorStatusPoller({
    sync,
    fetchStatus: () => {
      fetches += 1;
      return pending.promise;
    },
  });

  const run = poller.tick();
  poller.stop();
  pending.resolve(report('after-teardown'));
  assert.equal(await run, POLL_OUTCOME.DISCARDED_STOPPED);
  assert.equal(state.writes.length, 0);
  assert.equal(poller.isInFlight(), false);
  assert.equal(await poller.tick(), POLL_OUTCOME.STOPPED);
  assert.equal(fetches, 1);
});

test('sign-out: invalidate makes every request already started stale; a request started after it applies', async () => {
  const state = stateHolder();
  const sync = createSimulatorStatusSync(state.apply);
  const refreshAnswer = deferred();
  const pollAnswer = deferred();
  const poller = createSimulatorStatusPoller({ sync, fetchStatus: () => pollAnswer.promise });

  const refreshRun = refreshWith(sync, refreshAnswer.promise);
  const pollRun = poller.tick();
  sync.invalidate(); // clearSessionState
  refreshAnswer.resolve(report('previous-session-refresh'));
  pollAnswer.resolve(report('previous-session-poll'));
  assert.equal(await refreshRun, false);
  assert.equal(await pollRun, POLL_OUTCOME.DISCARDED_STALE);
  assert.equal(state.writes.length, 0);

  assert.equal(await refreshWith(sync, Promise.resolve(report('next-session'))), true);
  assert.equal(state.current().label, 'next-session');
});

test('a background tab skips the poll without starting a request', async () => {
  const state = stateHolder();
  const sync = createSimulatorStatusSync(state.apply);
  let fetches = 0;
  let visible = false;
  const poller = createSimulatorStatusPoller({
    sync,
    fetchStatus: () => {
      fetches += 1;
      return Promise.resolve(report('visible'));
    },
    isVisible: () => visible,
  });
  assert.equal(await poller.tick(), POLL_OUTCOME.SKIPPED_HIDDEN);
  assert.equal(fetches, 0);
  visible = true;
  assert.equal(await poller.tick(), POLL_OUTCOME.APPLIED);
});

test('wiring: both writers in AppProvider go through the one sync; sign-out invalidates it', () => {
  const source = fs.readFileSync(path.join(SRC, 'context/AppProvider.jsx'), 'utf8');
  // One sync, created once, writing the state setter.
  assert.match(source, /createSimulatorStatusSync\(setSimulatorStatus\)/);
  // The refresh takes its ticket before the fetch and settles through the sync.
  assert.match(source, /const simulatorTicket = simulatorSyncRef\.current\.begin\(\);\s*const \[robotsNext, tasksNext, simulatorNext\] = await Promise\.all/);
  assert.match(source, /simulatorSyncRef\.current\.settle\(simulatorTicket, simulatorNext \|\| null\)/);
  // The poll is the poller on the same sync, stopped on teardown.
  assert.match(source, /createSimulatorStatusPoller\(\{\s*sync: simulatorSyncRef\.current,/);
  assert.match(source, /poller\.stop\(\);/);
  // Sign-out invalidates before clearing; the clear is the only direct write left.
  assert.match(source, /simulatorSyncRef\.current\.invalidate\(\);\s*setSimulatorStatus\(null\);/);
  const directWrites = source.match(/setSimulatorStatus\(/g) || [];
  assert.equal(directWrites.length, 1, 'only the sign-out clear writes simulatorStatus directly');
});
