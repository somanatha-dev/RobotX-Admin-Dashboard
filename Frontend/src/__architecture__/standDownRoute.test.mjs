/**
 * A unit that acknowledged a RECALL / WITHDRAW must not keep its route on the map.
 *
 * Found by the 2026-10-02 forensic audit: a recalled robot went IDLE, but the backend emitted
 * no dashboard event and the map removes a route only on a terminal TASK_UPDATED — so the
 * stood-down unit sat under its old route until the task was reassigned or the page reloaded.
 * The backend now emits TASK_UPDATED { action: 'RECALLED', releasedRobotId, status: 'PENDING' }
 * when the agent acknowledges the stand-down (sockets/handlers/command.handler.js).
 *
 * The decisions are the real lib/liveState.js functions; the wiring into the provider and
 * the map is checked structurally, like the other files here.
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
const recalled = (taskId, releasedRobotId) => ({ taskId, releasedRobotId, status: 'PENDING', action: 'RECALLED' });

test('1 — a stand-down names its unit; any other update names none', async () => {
  const { standDownRobot, STAND_DOWN_ACTION } = await live();
  assert.equal(STAND_DOWN_ACTION, 'RECALLED');
  assert.equal(standDownRobot(recalled('T1', ' V1DEMO-01 ')), 'V1DEMO-01');
  assert.equal(standDownRobot({ taskId: 'T1', robotId: 'V1DEMO-01', status: 'ASSIGNED' }), '');
  assert.equal(standDownRobot({ taskId: 'T1', action: 'REROUTED', releasedRobotId: 'V1DEMO-01' }), '');
  assert.equal(standDownRobot(null), '');
});

test('2 — the stood-down unit\'s route leaves the replayed cache', async () => {
  const { evictOnStandDown } = await live();
  const cache = new Map([['T1', entry('T1', 'V1DEMO-01')], ['T2', entry('T2', 'V1DEMO-02')]]);
  assert.equal(evictOnStandDown(cache, recalled('T1', 'V1DEMO-01')), true);
  assert.equal(cache.has('T1'), false);
  assert.equal(cache.has('T2'), true, 'only the recalled task');
});

test('3 — a route already re-bound to the unit the task moved to is kept', async () => {
  const { evictOnStandDown } = await live();
  // The new robot's TASK_ASSIGNED arrived before the old robot's acknowledgement.
  const cache = new Map([['T1', entry('T1', 'V1DEMO-02')]]);
  assert.equal(evictOnStandDown(cache, recalled('T1', 'V1DEMO-01')), false);
  assert.equal(cache.get('T1').robotId, 'V1DEMO-02');
});

test('4 — the task is not finished: a stand-down is not a terminal status', async () => {
  const { evictOnTerminalUpdate, isTerminalTaskStatus } = await live();
  assert.equal(isTerminalTaskStatus('PENDING'), false);
  const cache = new Map([['T1', entry('T1', 'V1DEMO-01')]]);
  assert.equal(evictOnTerminalUpdate(cache, recalled('T1', 'V1DEMO-01')), false);
});

test('5 — wiring: the provider evicts on a stand-down, and the map removes the unit\'s route', () => {
  const provider = code(read('context/AppProvider.jsx'));
  assert.match(provider, /evictOnStandDown\(taskPathCacheRef\.current, data\)/);

  const map = code(read('features/maps/mapControl/hooks/useRobotStream.js'));
  assert.match(map, /const stoodDown = standDownRobot\(msg\);/);
  assert.match(map, /removeRouteForRobot\(stoodDown\);/);
  assert.match(map, /robotTasksRef\.current\.delete\(stoodDown\);/);
});
