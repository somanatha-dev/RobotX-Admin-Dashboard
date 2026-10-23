/**
 * DTARO obstacle events in AppProvider — read from the source, like `syncTruth.test.mjs`.
 *
 *   · each obstacle event is subscribed exactly once and unsubscribed exactly once, on the
 *     module's single socket, in the effect whose dependencies do NOT include the connection —
 *     so a reconnect (same socket object) cannot register a second copy;
 *   · the legacy ALERT_CREATED keeps its behaviour (the decision modal) — only a zone-delivered
 *     alert goes to the activity store instead, so with the feature off nothing new happens;
 *   · the activity is dropped with the session.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DASHBOARD_EVENTS } from '../lib/socket.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROVIDER = fs.readFileSync(path.resolve(HERE, '../context/AppProvider.jsx'), 'utf8');

const count = (re) => (PROVIDER.match(re) || []).length;

test('the backend event names are the ones the server emits', () => {
  assert.equal(DASHBOARD_EVENTS.ALERT_CREATED, 'ALERT_CREATED');
  assert.equal(DASHBOARD_EVENTS.OBSTACLE_RELEVANCE, 'OBSTACLE_RELEVANCE');
  assert.equal(DASHBOARD_EVENTS.OBSTACLE_REPORT_REJECTED, 'OBSTACLE_REPORT_REJECTED');
});

test('each obstacle event: one subscription, one matching unsubscription', () => {
  for (const [event, handler] of [
    ['ALERT_CREATED', 'onAlertCreated'],
    ['OBSTACLE_RELEVANCE', 'onObstacleRelevance'],
    ['OBSTACLE_REPORT_REJECTED', 'onObstacleReportRejected'],
    ['OBSTACLE_REPORT_MERGED', 'onObstacleReportMerged'],
  ]) {
    assert.equal(count(new RegExp(`socket\\.on\\(DASHBOARD_EVENTS\\.${event}, ${handler}\\)`, 'g')), 1, `${event} on`);
    assert.equal(count(new RegExp(`socket\\.off\\(DASHBOARD_EVENTS\\.${event}, ${handler}\\)`, 'g')), 1, `${event} off`);
  }
});

test('the subscribing effect does not re-run on reconnect (its deps exclude the connection)', () => {
  const at = PROVIDER.indexOf('socket.on(DASHBOARD_EVENTS.OBSTACLE_RELEVANCE, onObstacleRelevance)');
  const close = PROVIDER.indexOf('}, [', at);
  const deps = PROVIDER.slice(close, PROVIDER.indexOf(']', close) + 1);
  assert.equal(deps, '}, [addEvent, refreshDbState, setDecisionRequest]');
  assert.doesNotMatch(deps, /connection/);
});

test('feature off: the legacy alert still opens the information modal; only a zone delivery goes to the store', () => {
  const start = PROVIDER.indexOf('const onAlertCreated = (data) => {');
  const body = PROVIDER.slice(start, PROVIDER.indexOf('\n    };', start));
  const zone = body.indexOf('if (isZoneDelivery(data)) {');
  const modal = body.indexOf('setDecisionRequest((prev) => prev ?? alert);');
  assert.ok(zone > 0 && modal > zone, 'the zone branch returns before the legacy modal');
  assert.match(body.slice(zone, modal), /obstacleActivityStore\.apply\(OBSTACLE_EVENTS\.ALERT_CREATED, data\);\s*return;/);
});

test('verdicts and refusals reach the store as the backend sent them', () => {
  assert.match(PROVIDER, /obstacleActivityStore\.apply\(OBSTACLE_EVENTS\.RELEVANCE, data\);/);
  assert.match(PROVIDER, /obstacleActivityStore\.apply\(OBSTACLE_EVENTS\.REJECTED, data\);/);
});

test('the activity ends with the session', () => {
  const start = PROVIDER.indexOf('const clearSessionState = useCallback(() => {');
  const body = PROVIDER.slice(start, PROVIDER.indexOf('}, []);', start));
  assert.match(body, /obstacleActivityStore\.reset\(\);/);
});
