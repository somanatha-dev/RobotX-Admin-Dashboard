import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTIVITY_FILTER,
  EMPTY_ACTIVITY,
  MAX_OBSTACLES,
  OBSTACLE_EVENTS,
  RECIPIENT_STATUS,
  activityEntries,
  applyObstacleEvent,
  createObstacleActivityStore,
  isExpired,
  isZoneDelivery,
  obstacleCounts,
  recipientStatus,
} from './obstacleActivity.js';

// Payloads exactly as the backend emits them (Backend/src/services/dtaroZoneAlert.service.js).
const ALERT = Object.freeze({
  obstacleId: 'OBS-1',
  lat: 12.899823,
  lon: 77.518413,
  zoneId: 'rnsit-z1',
  zoneName: null,
  severity: 'HIGH',
  reportingRobotId: 'SIM-A',
  timestamp: 1_000,
  expiresAt: new Date(301_000).toISOString(),
  regionId: 'row-rnsit',
  cellId: '8b6014510486fff',
  room: 'dtaro:region:row-rnsit:zone:rnsit-z1',
  recipients: ['SIM-B', 'SIM-C', 'SIM-D'],
  delivery: 'ZONE_ROOM',
  footprint: { kind: 'H3_CELL', cellId: '8b6014510486fff', polygon: [{ lat: 1, lon: 2 }, { lat: 1, lon: 3 }, { lat: 2, lon: 3 }] },
});
const LEGACY_ALERT = Object.freeze({
  obstacleId: 'OBS-L',
  lat: 12.9,
  lon: 77.5,
  zoneId: null,
  zoneName: null,
  severity: 'MEDIUM',
  reportingRobotId: 'SIM-A',
  timestamp: 1_000,
  expiresAt: new Date(301_000).toISOString(),
});
const verdict = (robotId, relevant, extra = {}) => ({
  obstacleId: 'OBS-1',
  robotId,
  relevant,
  routeSource: 'COMMANDED_ROUTE',
  taskId: `TSK-${robotId}`,
  routePoints: 12,
  decision: relevant ? 'RELEVANT_NO_REPLAN' : 'NOT_RELEVANT',
  regionId: 'row-rnsit',
  zoneId: 'rnsit-z1',
  reportingRobotId: 'SIM-A',
  timestamp: 2_000,
  ...extra,
});

const run = (...events) => events.reduce((state, [event, payload]) => applyObstacleEvent(state, event, payload, 5_000), EMPTY_ACTIVITY);

test('feature off: a legacy ALERT_CREATED (no zone delivery) is not activity — the state object is unchanged', () => {
  assert.equal(isZoneDelivery(LEGACY_ALERT), false);
  assert.equal(applyObstacleEvent(EMPTY_ACTIVITY, OBSTACLE_EVENTS.ALERT_CREATED, LEGACY_ALERT), EMPTY_ACTIVITY);
  assert.equal(applyObstacleEvent(EMPTY_ACTIVITY, 'robot:update', { robotId: 'X' }), EMPTY_ACTIVITY);
});

test('a delivered alert lists its recipients as awaiting until each answers', () => {
  const state = run([OBSTACLE_EVENTS.ALERT_CREATED, ALERT]);
  const [obstacle] = state.obstacles;
  assert.equal(obstacle.obstacleId, 'OBS-1');
  assert.deepEqual(obstacle.recipients, ['SIM-B', 'SIM-C', 'SIM-D']);
  assert.equal(obstacle.regionId, 'row-rnsit');
  assert.equal(obstacle.zoneId, 'rnsit-z1');
  for (const id of obstacle.recipients) assert.equal(recipientStatus(obstacle, id), RECIPIENT_STATUS.PENDING);
});

test('relevant, not relevant and no-route verdicts come from the backend, one per robot', () => {
  const state = run(
    [OBSTACLE_EVENTS.ALERT_CREATED, ALERT],
    [OBSTACLE_EVENTS.RELEVANCE, verdict('SIM-B', true)],
    [OBSTACLE_EVENTS.RELEVANCE, verdict('SIM-C', false)],
    [OBSTACLE_EVENTS.RELEVANCE, verdict('SIM-D', false, { routeSource: 'NONE', decision: 'NO_PLANNED_ROUTE', taskId: null })],
  );
  const [o] = state.obstacles;
  assert.equal(recipientStatus(o, 'SIM-B'), RECIPIENT_STATUS.RELEVANT);
  assert.equal(recipientStatus(o, 'SIM-C'), RECIPIENT_STATUS.NOT_RELEVANT);
  assert.equal(recipientStatus(o, 'SIM-D'), RECIPIENT_STATUS.NO_ROUTE);
  assert.deepEqual(obstacleCounts(o), { recipients: 3, relevant: 1, notRelevant: 1, noRoute: 1, pending: 0 });
  assert.equal(o.verdicts['SIM-B'].decision, 'RELEVANT_NO_REPLAN');
});

test('a malformed verdict is ignored — no status is invented', () => {
  const base = run([OBSTACLE_EVENTS.ALERT_CREATED, ALERT]);
  assert.equal(applyObstacleEvent(base, OBSTACLE_EVENTS.RELEVANCE, { obstacleId: 'OBS-1', robotId: 'SIM-B' }), base);
  assert.equal(applyObstacleEvent(base, OBSTACLE_EVENTS.RELEVANCE, { obstacleId: 'OBS-1', relevant: 'yes', robotId: 'SIM-B' }), base);
});

test('a verdict for an alert this page did not see is kept, marked partial, with no invented location', () => {
  const state = run([OBSTACLE_EVENTS.RELEVANCE, verdict('SIM-B', true)]);
  const [o] = state.obstacles;
  assert.equal(o.partial, true);
  assert.equal(o.lat, null);
  assert.deepEqual(o.recipients, ['SIM-B']);
  // A later full alert replaces the stub and keeps the verdict.
  const after = applyObstacleEvent(state, OBSTACLE_EVENTS.ALERT_CREATED, ALERT);
  assert.equal(after.obstacles.length, 1);
  assert.equal(after.obstacles[0].partial, false);
  assert.equal(recipientStatus(after.obstacles[0], 'SIM-B'), RECIPIENT_STATUS.RELEVANT);
});

test('refusals are recorded with their reason; a refusal without a reason is ignored', () => {
  const state = run(
    [OBSTACLE_EVENTS.REJECTED, { reportingRobotId: 'SIM-X', lat: 1, lon: 2, reason: 'WRONG_REGION', reporterRegionId: 'row-jss', obstacleRegionId: 'row-rnsit', timestamp: 3_000 }],
    [OBSTACLE_EVENTS.REJECTED, { reportingRobotId: 'SIM-Y' }],
  );
  assert.equal(state.refusals.length, 1);
  assert.equal(state.refusals[0].reason, 'WRONG_REGION');
});

test('filters: relevant-only and refused-only', () => {
  const state = run(
    [OBSTACLE_EVENTS.ALERT_CREATED, ALERT],
    [OBSTACLE_EVENTS.ALERT_CREATED, { ...ALERT, obstacleId: 'OBS-2', recipients: ['SIM-C'], timestamp: 1_500 }],
    [OBSTACLE_EVENTS.RELEVANCE, verdict('SIM-B', true)],
    [OBSTACLE_EVENTS.REJECTED, { reportingRobotId: 'SIM-X', reason: 'UNASSIGNED_CELL', timestamp: 3_000 }],
  );
  const all = activityEntries(state);
  assert.deepEqual(all.entries.map((e) => e.kind), ['REFUSAL', 'OBSTACLE', 'OBSTACLE']);
  assert.deepEqual(activityEntries(state, { filter: ACTIVITY_FILTER.RELEVANT }).entries.map((e) => e.obstacle.obstacleId), ['OBS-1']);
  assert.deepEqual(activityEntries(state, { filter: ACTIVITY_FILTER.REFUSED }).entries.map((e) => e.kind), ['REFUSAL']);
});

test('region isolation: a campus sees only its own region; other regions and unattributed refusals are counted, not shown', () => {
  const state = run(
    [OBSTACLE_EVENTS.ALERT_CREATED, ALERT],
    // Another region that also calls its zone "rnsit-z1": the label alone must not admit it.
    [OBSTACLE_EVENTS.ALERT_CREATED, { ...ALERT, obstacleId: 'OBS-OTHER', regionId: 'row-other', zoneId: 'rnsit-z1' }],
    [OBSTACLE_EVENTS.REJECTED, { reportingRobotId: 'SIM-X', reason: 'INVALID_COORDINATES', timestamp: 3_000 }],
    [OBSTACLE_EVENTS.REJECTED, { reportingRobotId: 'SIM-Y', reason: 'WRONG_REGION', reporterRegionId: 'row-rnsit', obstacleRegionId: 'row-other', timestamp: 3_100 }],
  );
  const rnsit = activityEntries(state, { regionIds: ['row-rnsit'] });
  assert.deepEqual(
    rnsit.entries.map((e) => (e.kind === 'OBSTACLE' ? e.obstacle.obstacleId : e.refusal.reason)),
    ['WRONG_REGION', 'OBS-1'],
  );
  assert.equal(rnsit.hiddenCount, 2);
  // A campus with no published region sees nothing at all.
  assert.deepEqual(activityEntries(state, { regionIds: [] }).entries, []);
  // No campus selected: everything, each entry naming its own region.
  assert.equal(activityEntries(state, { regionIds: null }).entries.length, 4);
});

test('bounded, newest first; a repeated alert updates in place and keeps its verdicts', () => {
  let state = EMPTY_ACTIVITY;
  for (let i = 0; i < MAX_OBSTACLES + 5; i += 1) {
    state = applyObstacleEvent(state, OBSTACLE_EVENTS.ALERT_CREATED, { ...ALERT, obstacleId: `OBS-${i}` });
  }
  assert.equal(state.obstacles.length, MAX_OBSTACLES);
  assert.equal(state.obstacles[0].obstacleId, `OBS-${MAX_OBSTACLES + 4}`);
  const withVerdict = applyObstacleEvent(state, OBSTACLE_EVENTS.RELEVANCE, { ...verdict('SIM-B', true), obstacleId: 'OBS-10' });
  const again = applyObstacleEvent(withVerdict, OBSTACLE_EVENTS.ALERT_CREATED, { ...ALERT, obstacleId: 'OBS-10' });
  assert.equal(again.obstacles.filter((o) => o.obstacleId === 'OBS-10').length, 1);
  assert.equal(recipientStatus(again.obstacles.find((o) => o.obstacleId === 'OBS-10'), 'SIM-B'), RECIPIENT_STATUS.RELEVANT);
});

test('expiry is the server-stated time, nothing else', () => {
  const [o] = run([OBSTACLE_EVENTS.ALERT_CREATED, ALERT]).obstacles;
  assert.equal(isExpired(o, 300_999), false);
  assert.equal(isExpired(o, 301_000), true);
});

test('store: subscribers are told of changes only; unsubscribe and reset leave nothing behind', () => {
  const store = createObstacleActivityStore();
  let calls = 0;
  const off = store.subscribe(() => {
    calls += 1;
  });
  assert.equal(store.apply(OBSTACLE_EVENTS.ALERT_CREATED, LEGACY_ALERT), false);
  assert.equal(calls, 0);
  assert.equal(store.apply(OBSTACLE_EVENTS.ALERT_CREATED, ALERT), true);
  assert.equal(calls, 1);
  store.reset();
  assert.equal(store.getSnapshot(), EMPTY_ACTIVITY);
  assert.equal(calls, 2);
  off();
  assert.equal(store.listenerCount(), 0);
  store.apply(OBSTACLE_EVENTS.ALERT_CREATED, ALERT);
  assert.equal(calls, 2);
});

test('a merged report adds corroborations to the obstacle it joined; one for an unseen obstacle is ignored', () => {
  const merged = { obstacleId: 'OBS-1', reportingRobotId: 'SIM-C', originalReporterId: 'SIM-A', corroborations: ['SIM-C'], repeat: false, regionId: 'row-rnsit', zoneId: 'rnsit-z1', cellId: '8b6014510486fff', timestamp: 3_000 };
  const state = run([OBSTACLE_EVENTS.ALERT_CREATED, ALERT], [OBSTACLE_EVENTS.MERGED, merged]);
  assert.deepEqual(state.obstacles[0].corroborations, ['SIM-C']);
  assert.equal(state.obstacles.length, 1, 'a merge never creates a second obstacle');
  const unseen = run([OBSTACLE_EVENTS.MERGED, { ...merged, obstacleId: 'OBS-UNSEEN' }]);
  assert.equal(unseen, EMPTY_ACTIVITY);
  // A later full alert for the same obstacle keeps what was corroborated.
  const again = applyObstacleEvent(state, OBSTACLE_EVENTS.ALERT_CREATED, ALERT);
  assert.deepEqual(again.obstacles[0].corroborations, ['SIM-C']);
});
