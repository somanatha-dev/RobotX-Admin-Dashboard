import { test } from 'node:test';
import assert from 'node:assert/strict';

import { alertRecipientsSuffix, obstacleRejectedLogLine, obstacleRelevanceLogLine } from './obstacleAlert.js';

test('a zone-room ALERT_CREATED names its recipients and zone; the legacy event gets no suffix', () => {
  assert.equal(
    alertRecipientsSuffix({ delivery: 'ZONE_ROOM', recipients: ['SIM-B', 'SIM-C'], regionId: 'rnsit', zoneId: 'rnsit-z1' }),
    ' — alerted SIM-B, SIM-C in zone rnsit/rnsit-z1',
  );
  assert.equal(alertRecipientsSuffix({ delivery: 'ZONE_ROOM', recipients: [], zoneId: 'z1' }), ' — alerted no other robot in zone z1');
  assert.equal(alertRecipientsSuffix({ zoneId: 'rnsit-z1', severity: 'HIGH' }), '');
});

test('relevance lines say flagged-not-rerouted, not relevant, or no route', () => {
  assert.equal(
    obstacleRelevanceLogLine({ robotId: 'SIM-B', relevant: true, routeSource: 'COMMANDED_ROUTE', taskId: 'TSK-1' }),
    'SIM-B: obstacle is on its commanded route (TSK-1) — flagged, no reroute (V1)',
  );
  assert.equal(
    obstacleRelevanceLogLine({ robotId: 'SIM-C', relevant: false, routeSource: 'COMMANDED_ROUTE' }),
    'SIM-C: obstacle is not on its commanded route — no change',
  );
  assert.equal(obstacleRelevanceLogLine({ robotId: 'SIM-D', relevant: false, routeSource: 'NONE' }), 'SIM-D: obstacle alert received — no planned route, not relevant');
  assert.equal(obstacleRelevanceLogLine({ relevant: true }), null);
});

test('a refused report names the robot and the reason', () => {
  assert.equal(obstacleRejectedLogLine({ reportingRobotId: 'SIM-A', reason: 'WRONG_REGION' }), 'Obstacle report from SIM-A refused: WRONG_REGION');
  assert.equal(obstacleRejectedLogLine({ reason: 'WRONG_REGION' }), null);
});
