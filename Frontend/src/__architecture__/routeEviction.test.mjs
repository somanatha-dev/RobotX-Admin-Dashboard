/**
 * Completed task routes must not come back on the map (follow-up to the FS sync pass).
 *
 * Measured before the fix: the terminal TASK_UPDATED removed the route, and the map's sync
 * effect — which replays the provider's task-route cache on every `robot:update` — drew it
 * again 93 ms later, for good, because a finished task was never evicted from that cache.
 *
 * The replay decision and the eviction are the real functions the map and the provider call
 * (lib/liveState.js); the wiring into both is checked structurally, like the other files here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const live = () => import(pathToFileURL(path.join(SRC, 'lib/liveState.js')).href);

const P = [[77.5176, 12.9007], [77.5177, 12.9010]];
const D = [[77.5177, 12.9010], [77.5177, 12.9014]];
const entry = (taskId, robotId) => ({ taskId, robotId, pickup: null, drop: null, pathToPickup: P, pathToDrop: D });

// The map's sync pass, as useRobotStream runs it on each telemetry tick: draw what is
// replayable, and record it as drawn (upsertRoutes puts it in routesRef).
function telemetryTick(replayableRoutes, cache, activeRobotIds, drawn) {
  const replay = replayableRoutes(cache, { activeRobotIds, drawnRobotIds: drawn });
  for (const r of replay) drawn.set(r.robotId, r.taskId);
  return replay.map((r) => `${r.robotId}:${r.taskId}`);
}
// The map's terminal TASK_UPDATED: the robot's drawn route is removed.
const removeDrawn = (drawn, robotId) => drawn.delete(robotId);

test('1 — an active task\'s cached route is drawn', async () => {
  const { replayableRoutes } = await live();
  const cache = new Map([['T1', entry('T1', 'V1DEMO-01')]]);
  const drawn = new Map();
  assert.deepEqual(telemetryTick(replayableRoutes, cache, new Set(['V1DEMO-01']), drawn), ['V1DEMO-01:T1']);
  assert.deepEqual(telemetryTick(replayableRoutes, cache, new Set(['V1DEMO-01']), drawn), [], 'drawn once, not redrawn every tick');
});

test('2 — a terminal update evicts the task from the replayed cache', async () => {
  const { evictOnTerminalUpdate } = await live();
  for (const status of ['COMPLETED', 'CANCELLED', 'FAILED', 'REJECTED']) {
    const cache = new Map([['T1', entry('T1', 'V1DEMO-01')], ['T2', entry('T2', 'V1DEMO-02')]]);
    assert.equal(evictOnTerminalUpdate(cache, { taskId: 'T1', robotId: 'V1DEMO-01', status }), true, status);
    assert.equal(cache.has('T1'), false, status);
    assert.equal(cache.has('T2'), true, `${status}: only the finished task`);
  }
});

test('3 — telemetry after completion cannot redraw the finished route (the regression)', async () => {
  const { replayableRoutes, evictOnTerminalUpdate } = await live();
  const active = new Set(['V1DEMO-01', 'V1DEMO-02']);
  const cache = new Map([['T1', entry('T1', 'V1DEMO-01')], ['T2', entry('T2', 'V1DEMO-02')]]);
  const drawn = new Map();
  telemetryTick(replayableRoutes, cache, active, drawn);
  assert.deepEqual([...drawn.keys()].sort(), ['V1DEMO-01', 'V1DEMO-02']);

  // T1 completes: the map removes V1DEMO-01's route, the provider evicts T1.
  const completed = { taskId: 'T1', robotId: 'V1DEMO-01', status: 'COMPLETED' };
  removeDrawn(drawn, 'V1DEMO-01');
  evictOnTerminalUpdate(cache, completed);

  for (let tick = 0; tick < 500; tick++) {
    assert.deepEqual(telemetryTick(replayableRoutes, cache, active, drawn), [], `tick ${tick} redrew something`);
  }
  assert.equal(drawn.has('V1DEMO-01'), false, 'the completed route stays absent');
  assert.equal(drawn.get('V1DEMO-02'), 'T2', 'the other active route is untouched');
});

test('3b — the same sequence without eviction is the reported bug (the check is not vacuous)', async () => {
  const { replayableRoutes } = await live();
  const active = new Set(['V1DEMO-01']);
  const cache = new Map([['T1', entry('T1', 'V1DEMO-01')]]);
  const drawn = new Map();
  telemetryTick(replayableRoutes, cache, active, drawn);
  removeDrawn(drawn, 'V1DEMO-01');
  assert.deepEqual(telemetryTick(replayableRoutes, cache, active, drawn), ['V1DEMO-01:T1'], 'redrawn on the next tick');
});

test('4 — PAUSED, OFFLINE, IDLE, VERIFYING and ASSIGNED evict nothing', async () => {
  const { evictOnTerminalUpdate, evictTerminalRoutes, isTerminalTaskStatus, replayableRoutes } = await live();
  for (const status of ['PAUSED', 'OFFLINE', 'IDLE', 'VERIFYING', 'ASSIGNED', 'IN_PROGRESS', 'PENDING', '', undefined]) {
    assert.equal(isTerminalTaskStatus(status), false, String(status));
    const cache = new Map([['T1', entry('T1', 'V1DEMO-01')]]);
    assert.equal(evictOnTerminalUpdate(cache, { taskId: 'T1', status }), false, String(status));
    assert.deepEqual(evictTerminalRoutes(cache, [{ taskId: 'T1', status }]), [], String(status));
    assert.equal(cache.has('T1'), true, `${status}: the route is still an active delivery route`);
  }
  // A robot that is paused or offline is not a task event at all; a robot going
  // offline (not visible) only stops the replay for it, and it comes back when visible.
  const cache = new Map([['T1', entry('T1', 'V1DEMO-01')]]);
  assert.deepEqual(replayableRoutes(cache, { activeRobotIds: new Set(), drawnRobotIds: new Map() }), []);
  assert.equal(cache.has('T1'), true);
  assert.equal(replayableRoutes(cache, { activeRobotIds: new Set(['V1DEMO-01']), drawnRobotIds: new Map() }).length, 1);
});

test('5 — a reassigned task is replayed only for its new robot', async () => {
  const { replayableRoutes } = await live();
  const active = new Set(['V1DEMO-01', 'V1DEMO-04']);
  const cache = new Map([['T3', entry('T3', 'V1DEMO-01')]]);
  // TASK_ASSIGNED for the reassignment replaces the entry under the same task id (AppProvider).
  cache.set('T3', entry('T3', 'V1DEMO-04'));
  assert.deepEqual(telemetryTick(replayableRoutes, cache, active, new Map()), ['V1DEMO-04:T3']);
});

test('6 — a terminal state the page only learns from the refetch (event missed) is evicted too', async () => {
  const { evictTerminalRoutes } = await live();
  const cache = new Map([['T1', entry('T1', 'V1DEMO-01')], ['T2', entry('T2', 'V1DEMO-02')], ['T3', entry('T3', 'V1DEMO-03')]]);
  const removed = evictTerminalRoutes(cache, [
    { taskId: 'T1', status: 'COMPLETED' },
    { taskId: 'T2', status: 'ASSIGNED' },
    { taskId: 'T9', status: 'CANCELLED' }, // not cached: nothing to do
  ]);
  assert.deepEqual(removed, ['T1']);
  assert.deepEqual([...cache.keys()], ['T2', 'T3'], 'a task the list does not mention is left alone');
});

test('wiring — the provider evicts on the event and on refetch; the map replays through the helper', () => {
  const provider = code(read('context/AppProvider.jsx'));
  const updated = provider.match(/const onTaskUpdated = \(data\) => \{[\s\S]*?\n {4}\};/);
  assert.ok(updated);
  assert.match(updated[0], /evictOnTerminalUpdate\(taskPathCacheRef\.current, data\);/);
  assert.match(provider, /setTasks\(Array\.isArray\(tasksNext\) \? tasksNext : \[\]\);\s*evictTerminalRoutes\(taskPathCacheRef\.current, tasksNext\);/);
  // The Tasks card's planned-route distance is not the map's cache and is kept.
  assert.doesNotMatch(updated[0], /setTaskRoutes/);

  const map = code(read('features/maps/mapControl/hooks/useRobotStream.js'));
  assert.match(map, /const replay = replayableRoutes\(taskPathCacheRef\.current, \{\s*activeRobotIds: activeRobotIdsRef\.current,\s*drawnRobotIds: routesRef\.current,\s*\}\);/);
  assert.doesNotMatch(map, /for \(const \[taskId, entry\] of taskPathCacheRef\.current\.entries\(\)\)/, 'no second, unfiltered replay loop');
  assert.match(map, /if \(isTerminalTaskStatus\(msg\?\.status\)\) \{[\s\S]*?if \(taskId\) taskPathsRef\.current\.delete\(taskId\);/);
  assert.match(map, /if \(carried\?\.taskId && !isTerminalTaskStatus\(carried\.status\)\) rememberTask/);
  // FS-04's release of a reassigned task is unchanged.
  assert.equal((map.match(/releaseFromOtherRobots\(taskId, robotId\);/g) || []).length, 2);
});

// ── Reconnect after a missed completion: reconcile what is already drawn ─────
//
// The map's own state, and its two passes as useRobotStream runs them:
//   syncPass  — the effect that runs after every refetch (and every telemetry change of the
//               robot list): first drop what the cache no longer backs, then replay the cache.
//   telemetry — a robot:update for a visible robot: upsertRoutes redraws from the robot's
//               record and the map's own copy of the paths.
function mapState() {
  return { rendered: new Map(), records: new Map(), localPaths: new Map() };
}
function drawActive(m, cache, taskId, robotId) {
  const e = entry(taskId, robotId);
  cache.set(taskId, e);
  m.localPaths.set(taskId, e);
  m.records.set(robotId, { taskId, robotId });
  m.rendered.set(robotId, { taskId });
}
function syncPass(lib, m, cache, activeRobotIds) {
  for (const { robotId, taskId, finished } of lib.staleMapRoutes(m, cache)) {
    m.records.delete(robotId);
    if (finished) m.localPaths.delete(taskId);
    m.rendered.delete(robotId);
  }
  for (const r of lib.replayableRoutes(cache, { activeRobotIds, drawnRobotIds: m.rendered })) {
    m.records.set(r.robotId, { taskId: r.taskId, robotId: r.robotId });
    m.localPaths.set(r.taskId, cache.get(r.taskId));
    m.rendered.set(r.robotId, { taskId: r.taskId });
  }
}
function telemetry(m, robotId) {
  const record = m.records.get(robotId);
  if (record && m.localPaths.has(record.taskId)) m.rendered.set(robotId, { taskId: record.taskId });
}

test('R1 — completion missed while disconnected: the reconnect refetch removes the drawn route', async () => {
  const lib = await live();
  const active = new Set(['V1DEMO-01']);
  const cache = new Map();
  const m = mapState();
  drawActive(m, cache, 'T1', 'V1DEMO-01');
  assert.equal(m.rendered.size, 1);

  // Disconnected: TASK_UPDATED COMPLETED never arrives. On reconnect the provider refetches;
  // the backend's list says COMPLETED; the provider evicts; the new robot list re-runs the pass.
  lib.evictTerminalRoutes(cache, [{ taskId: 'T1', status: 'COMPLETED' }]);
  syncPass(lib, m, cache, active);
  assert.equal(m.rendered.size, 0, 'rendered route count = 0, with no telemetry, event, navigation or reload');
  assert.equal(m.records.has('V1DEMO-01'), false);
  assert.equal(m.localPaths.has('T1'), false);

  for (let i = 0; i < 150; i++) {
    telemetry(m, 'V1DEMO-01');
    syncPass(lib, m, cache, active);
    assert.equal(m.rendered.size, 0, `telemetry update ${i} brought it back`);
  }
});

test('R1b — without the reconciliation the drawn route survives (the reported edge case)', async () => {
  const lib = await live();
  const cache = new Map();
  const m = mapState();
  drawActive(m, cache, 'T1', 'V1DEMO-01');
  lib.evictTerminalRoutes(cache, [{ taskId: 'T1', status: 'COMPLETED' }]);
  lib.replayableRoutes(cache, { activeRobotIds: new Set(['V1DEMO-01']), drawnRobotIds: m.rendered }); // replay only
  telemetry(m, 'V1DEMO-01');
  assert.equal(m.rendered.get('V1DEMO-01')?.taskId, 'T1', 'still drawn after the refetch and a telemetry tick');
});

test('R2 — an active task survives disconnect + reconnect; so does VERIFYING', async () => {
  const lib = await live();
  for (const status of ['ASSIGNED', 'IN_PROGRESS', 'VERIFYING']) {
    const active = new Set(['V1DEMO-01']);
    const cache = new Map();
    const m = mapState();
    drawActive(m, cache, 'T1', 'V1DEMO-01');
    lib.evictTerminalRoutes(cache, [{ taskId: 'T1', status }]);
    syncPass(lib, m, cache, active);
    for (let i = 0; i < 120; i++) { telemetry(m, 'V1DEMO-01'); syncPass(lib, m, cache, active); }
    assert.equal(m.rendered.get('V1DEMO-01')?.taskId, 'T1', `${status}: the route stays`);
  }
  // A robot offline or out of view is not a task state: its route is not reconciled away.
  const cache = new Map();
  const m = mapState();
  drawActive(m, cache, 'T1', 'V1DEMO-01');
  syncPass(lib, m, cache, new Set());
  assert.equal(m.rendered.has('V1DEMO-01'), true);
});

test('R3 — a reassignment missed while disconnected: old robot route removed, new robot drawn', async () => {
  const lib = await live();
  const active = new Set(['V1DEMO-01', 'V1DEMO-02']);
  const cache = new Map();
  const m = mapState();
  drawActive(m, cache, 'T3', 'V1DEMO-01');
  // Reconnect: the backend re-emits TASK_ASSIGNED for its active tasks, and the provider's
  // handler replaces the entry — T3 now belongs to V1DEMO-02.
  cache.set('T3', entry('T3', 'V1DEMO-02'));
  syncPass(lib, m, cache, active);
  assert.equal(m.rendered.has('V1DEMO-01'), false, 'no stale route on robot A');
  assert.equal(m.rendered.get('V1DEMO-02')?.taskId, 'T3', 'the route on robot B');
  assert.equal(m.localPaths.has('T3'), true, 'the task is still active, so its paths stay');
});

test('R4 — a held task the map could draw from later is dropped too; a path-less record is not touched', async () => {
  const lib = await live();
  const cache = new Map();
  const m = mapState();
  drawActive(m, cache, 'T1', 'V1DEMO-01');
  m.rendered.delete('V1DEMO-01'); // not drawn (out of view), still held with a path
  lib.evictTerminalRoutes(cache, [{ taskId: 'T1', status: 'CANCELLED' }]);
  // A REST `currentTask` registered before its TASK_ASSIGNED arrives (e.g. just after a reload):
  // no path held, nothing to draw, so nothing to reconcile.
  m.records.set('V1DEMO-05', { taskId: 'T5', robotId: 'V1DEMO-05' });
  syncPass(lib, m, cache, new Set(['V1DEMO-05']));
  assert.equal(m.records.has('V1DEMO-01'), false);
  telemetry(m, 'V1DEMO-01');
  assert.equal(m.rendered.size, 0);
  assert.equal(m.records.has('V1DEMO-05'), true);
});

test('wiring — the sync pass reconciles first; only authoritative evictions leave the cache', () => {
  const map = code(read('features/maps/mapControl/hooks/useRobotStream.js'));
  const effect = map.match(/const stale = staleMapRoutes\([\s\S]*?syncMarkersToRobots\(list\);/);
  assert.ok(effect, 'reconciliation runs in the sync effect, before the markers sync');
  assert.match(effect[0], /robotTasksRef\.current\.delete\(robotId\);\s*if \(finished\) taskPathsRef\.current\.delete\(taskId\);\s*removeRouteForRobot\(robotId\);/);
  // The reconciliation trusts "absent from the cache" to mean "finished", so nothing but the
  // two terminal evictions and the logout clear may remove an entry.
  const provider = code(read('context/AppProvider.jsx'));
  assert.doesNotMatch(provider, /taskPathCacheRef\.current\.delete\(/);
  assert.equal((provider.match(/taskPathCacheRef\.current\.clear\(\)/g) || []).length, 1);
  assert.match(provider, /const clearSessionState = useCallback\(\(\) => \{[\s\S]*?taskPathCacheRef\.current\.clear\(\);/);
  assert.doesNotMatch(map, /taskPathCacheRef\??\.current\??\.(delete|clear)\(/);
});
