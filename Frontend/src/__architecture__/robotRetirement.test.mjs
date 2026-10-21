/**
 * Robot soft retirement — the dashboard half.
 *
 * `DELETE /api/robots/:robotId` retires a unit instead of deleting it (the delete failed with an
 * unhandled 500 for any unit the engine had offered work). The backend's lists already omit a
 * retired unit; these checks hold the dashboard to the same contract:
 *
 *   R1  `robot_retired` is a named dashboard event, and it is the name the backend emits;
 *   R2  the provider subscribes to it (and unsubscribes), and drops the unit from the list —
 *       so a page other than the one that retired it stops showing it and stops targeting it
 *       with the global STOP;
 *   R3  the global STOP still targets only units the list holds as online;
 *   R4  a refusal (409) reaches the operator as the backend's sentence, not a generic failure.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BACKEND = path.resolve(SRC, '..', '..', 'Backend');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const load = (rel) => import(pathToFileURL(path.join(SRC, rel)).href);

test('R1 robot_retired is a dashboard event, named as the backend emits it', async () => {
  const { DASHBOARD_EVENTS } = await load('lib/socket.js');
  assert.equal(DASHBOARD_EVENTS.ROBOT_RETIRED, 'robot_retired');
  const service = fs.readFileSync(path.join(BACKEND, 'src/services/robotRetirement.service.js'), 'utf8');
  assert.match(service, /dashboardBroadcast\.emit\(io, "robot_retired"/);
  assert.match(service, /dashboardBroadcast\.emit\(io, "robot_offline"/);
});

test('R2 the provider subscribes, unsubscribes, and removes the retired unit from the list', () => {
  const src = code(read('context/AppProvider.jsx'));
  assert.match(src, /socket\.on\(DASHBOARD_EVENTS\.ROBOT_RETIRED, onRobotRetired\)/);
  assert.match(src, /socket\.off\(DASHBOARD_EVENTS\.ROBOT_RETIRED, onRobotRetired\)/);
  const handler = src.match(/const onRobotRetired = \(data\) => \{([\s\S]*?)\n {4}\};/);
  assert.ok(handler, 'onRobotRetired is defined');
  assert.match(handler[1], /setRobots\(\(prev\) => prev\.filter\(/);
});

test('R3 the global STOP targets only units the list holds as online', () => {
  const src = code(read('context/AppProvider.jsx'));
  assert.match(src, /robotsRef\.current\.filter\(\(r\) => r\.isOnline\)/);
});

test('R4 a 409 refusal carries the backend sentence to the operator', async () => {
  const { refusalMessage } = await load('lib/api/httpClient.js');
  assert.equal(
    refusalMessage({ ok: false, error: 'Conflict', code: 'LIVE_COMMITMENT', message: 'Unit R-1 holds 1 live commitment(s).' }),
    'Unit R-1 holds 1 live commitment(s).',
  );
  assert.equal(
    refusalMessage({ ok: false, error: 'Conflict', code: 'ROBOT_RETIRED', message: 'Unit R-1 is retired.' }),
    'Unit R-1 is retired.',
  );
});
