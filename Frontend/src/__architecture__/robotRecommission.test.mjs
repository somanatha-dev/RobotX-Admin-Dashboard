/**
 * Recommissioning a retired robot — the dashboard half.
 *
 * `POST /api/robots/:robotId/recommission` returns a retired unit's own record to the fleet.
 * Regression for the RBT-2000 report: the commissioning page answered a retired id with a
 * dead end ("belongs to a retired robot and cannot be reused") and offered no way back.
 *
 *   RC1 the refusal for a retired id is recognised by its code, not its sentence, and an
 *       active duplicate is not mistaken for it;
 *   RC2 the form is validated before sending: a unit, a confirmation that repeats its id
 *       exactly, and a bounded reason; the body carries exactly the two accepted fields;
 *   RC3 every failure class reads as a sentence that says what to do next, the server's own
 *       sentence is kept, and an unreachable backend does not claim either outcome;
 *   RC4 the request module calls the explicit endpoint and lists the retired units;
 *   RC5 the provider routes recommissioning through the step-up, claims success only after
 *       the server answered, goes on to pairing, and the commission action offers the path on
 *       a retired-id refusal (never takes it by itself);
 *   RC6 the page distinguishes the two operations explicitly, keeps the retired-id warning,
 *       and shows the consequences before confirmation;
 *   RC7 every dashboard refetches on `robot_recommissioned`, the name the backend emits.
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

test('RC1 a retired-id refusal is recognised by code; an active duplicate is not', async () => {
  const { isRetiredIdRefusal, RETIRED_ID_CODE } = await load('lib/robotRecommission.js');
  assert.equal(RETIRED_ID_CODE, 'ROBOT_ID_RETIRED');
  assert.equal(isRetiredIdRefusal({ status: 409, code: 'ROBOT_ID_RETIRED', message: 'The ID "RBT-2000" belongs to a retired robot…' }), true);
  assert.equal(isRetiredIdRefusal({ status: 409, code: 'ROBOT_ID_TAKEN', message: 'already commissioned' }), false);
  assert.equal(isRetiredIdRefusal({ status: 400, code: 'ROBOT_ID_RETIRED' }), false);
  assert.equal(isRetiredIdRefusal(null), false);
  // The backend's commissioning controller sends exactly that code.
  const controller = fs.readFileSync(path.join(BACKEND, 'src/controllers/robots.controller.js'), 'utf8');
  assert.match(controller, /"ROBOT_ID_RETIRED"/);
});

test('RC2 validation and the request body', async () => {
  const { validateRecommissionDraft, buildRecommissionRequest, RECOMMISSION_REASON_MAX } = await load('lib/robotRecommission.js');
  assert.equal(RECOMMISSION_REASON_MAX, 500);
  const backend = fs.readFileSync(path.join(BACKEND, 'src/services/robotRecommission.service.js'), 'utf8');
  assert.match(backend, /const MAX_REASON_LENGTH = 500;/, 'the bound matches the server');

  assert.equal(validateRecommissionDraft({ robotId: 'RBT-2000', confirmRobotId: 'RBT-2000', reason: 'repaired' }).ok, true);
  assert.equal(validateRecommissionDraft({ robotId: '', confirmRobotId: '', reason: 'x' }).ok, false);
  assert.equal(validateRecommissionDraft({ robotId: 'RBT-2000', confirmRobotId: 'rbt-2000', reason: 'x' }).ok, false, 'exact, case-sensitive');
  assert.equal(validateRecommissionDraft({ robotId: 'RBT-2000', confirmRobotId: 'RBT-2000', reason: '   ' }).ok, false);
  assert.equal(validateRecommissionDraft({ robotId: 'RBT-2000', confirmRobotId: 'RBT-2000', reason: 'x'.repeat(501) }).ok, false);

  assert.deepEqual(buildRecommissionRequest({ robotId: 'RBT-2000', confirmRobotId: ' RBT-2000 ', reason: ' repaired ', extra: 1 }), {
    reason: 'repaired',
    confirmRobotId: 'RBT-2000',
  });
});

test('RC3 failure sentences', async () => {
  const { recommissionFailureMessage } = await load('lib/robotRecommission.js');
  assert.match(recommissionFailureMessage({ status: 401 }, 'RBT-2000'), /Sign in again/);
  assert.match(recommissionFailureMessage({ status: 403, message: 'this surface requires an elevated role' }, 'RBT-2000'), /not authorised.*elevated role/);
  assert.match(
    recommissionFailureMessage({ status: 409, code: 'ROBOT_NOT_RETIRED', message: 'Unit RBT-2000 is not retired (lifecycle COMMISSIONED).' }, 'RBT-2000'),
    /not retired.*Refresh the list/,
  );
  assert.equal(
    recommissionFailureMessage({ status: 409, code: 'SIMULATED_NOT_RECOMMISSIONABLE', message: 'Simulated robots are not recommissioned.' }, 'SIM-1'),
    'Simulated robots are not recommissioned.',
  );
  assert.match(recommissionFailureMessage({ status: 429 }, 'RBT-2000'), /Wait a minute/);
  assert.match(recommissionFailureMessage({ status: 503, message: 'The credential store is unavailable.' }, 'RBT-2000'), /Nothing was changed; it is safe to retry/);
  const unreachable = recommissionFailureMessage(new TypeError('Failed to fetch'), 'RBT-2000');
  assert.match(unreachable, /may or may not have been recommissioned/);
  assert.match(unreachable, /already done/);
});

test('RC4 the request module calls the explicit endpoint, and lists retired units', () => {
  const src = code(read('lib/api/robots.js'));
  assert.match(src, /`\/api\/robots\/\$\{encodeURIComponent\(robotId\)\}\/recommission`/);
  assert.match(src, /'\/api\/robots\/retired'/);
  const fn = src.slice(src.indexOf('export async function recommissionRobot'), src.indexOf('export async function deleteRobot'));
  assert.match(fn, /method: 'POST'/);
  assert.match(fn, /body,/, 'sends the caller-built body unchanged');
});

test('RC5 the provider: step-up first, success only after the server, then pairing; commission offers the path', () => {
  const src = code(read('context/AppProvider.jsx'));
  const start = src.indexOf('const recommission = useCallback(');
  assert.ok(start > -1, 'recommission is a provider action');
  const action = src.slice(start, src.indexOf('const retire = useCallback('));
  assert.match(action, /requestAuth\(\s*`RECOMMISSION RETIRED UNIT: \$\{robotId\}`/);
  assert.match(action, /robotsApi\.recommissionRobot\(robotId, buildRecommissionRequest\(draft\)\)/);
  // Success is reported only after the awaited call returned; the event and navigation follow it.
  const call = action.indexOf('robotsApi.recommissionRobot');
  assert.ok(action.indexOf('addEvent(') > call);
  assert.ok(action.indexOf('navigate(connectPathFor(robotId))') > call);
  assert.match(action, /recommissionFailureMessage\(err, robotId\)/);
  // Exposed to pages.
  assert.match(src, /updateRobotSpecification,\s*recommission,\s*retire,/);

  const commission = src.slice(src.indexOf('const commission = useCallback('), src.indexOf('const createSimulatedRobot'));
  assert.match(commission, /if \(isRetiredIdRefusal\(err\)\) robotData\?\.onRetiredId\?\.\(robotId\);\s*throw err;/);
  assert.doesNotMatch(commission, /recommissionRobot/, 'a refused commissioning never recommissions by itself');
});

test('RC6 the page: two explicit operations, the retired-id warning kept, consequences before confirmation', async () => {
  const page = code(read('pages/CommissionPage.jsx'));
  assert.match(page, /Commission new unit/);
  assert.match(page, /Recommission retired robot/);
  assert.match(page, /onRetiredId: \(id\) =>/);
  assert.match(page, /belongs to a retired robot, so a new unit cannot use it/);
  assert.match(page, /chooseMode\('recommission', retiredId\)/);

  const panel = code(read('features/robots/RecommissionRetiredUnit.jsx'));
  assert.match(panel, /robotsApi\.listRetiredRobots\(\)/);
  assert.match(panel, /RECOMMISSION_CONSEQUENCES\.map/);
  assert.match(panel, /disabled=\{!row\.recommissionable\}/);
  assert.match(panel, /recommission\(\{ robotId: selected\.robotId, confirmRobotId: confirmId, reason \}\)/);

  const { RECOMMISSION_CONSEQUENCES, sortRetiredForChoice } = await load('lib/robotRecommission.js');
  const all = RECOMMISSION_CONSEQUENCES.join(' ');
  assert.match(all, /history/);
  assert.match(all, /revoked/);
  assert.match(all, /paired again/);
  assert.match(all, /not released into service/);
  assert.deepEqual(
    sortRetiredForChoice([
      { robotId: 'SIM-9', recommissionable: false },
      { robotId: 'RBT-2000', recommissionable: true },
      { robotId: 'RBT-1000', recommissionable: true },
      { robotId: '' },
    ]).map((r) => r.robotId),
    ['RBT-1000', 'RBT-2000', 'SIM-9'],
  );
});

test('RC7 robot_recommissioned is a dashboard event the provider follows with a refetch', async () => {
  const { DASHBOARD_EVENTS } = await load('lib/socket.js');
  assert.equal(DASHBOARD_EVENTS.ROBOT_RECOMMISSIONED, 'robot_recommissioned');
  const controller = fs.readFileSync(path.join(BACKEND, 'src/controllers/robots.controller.js'), 'utf8');
  assert.match(controller, /emit\("robot_recommissioned"/);
  const src = code(read('context/AppProvider.jsx'));
  assert.match(src, /socket\.on\(DASHBOARD_EVENTS\.ROBOT_RECOMMISSIONED, onRobotRecommissioned\)/);
  assert.match(src, /socket\.off\(DASHBOARD_EVENTS\.ROBOT_RECOMMISSIONED, onRobotRecommissioned\)/);
  const handler = src.match(/const onRobotRecommissioned = \(data\) => \{([\s\S]*?)\n {4}\};/);
  assert.ok(handler);
  assert.match(handler[1], /refreshDbState\(\)/);
});
