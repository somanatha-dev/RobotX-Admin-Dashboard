/**
 * Robot charging view — what the dashboard says about a robot's battery and charging.
 *
 *   node --test src/__architecture__/robotCharging.test.mjs   (or: npm run test:arch)
 *
 * Charging audit U-1/U-3: PAUSED alone never means charging; seeking, driving to a charger,
 * waiting for a plug and charging are different stages; ETAs are the backend's or "unavailable".
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { isCharging } from '../lib/robotStatus.js';
import {
  CHARGING_STAGE,
  chargingDetails,
  chargingStageOf,
  formatDuration,
  isInChargingLifecycle,
  robotDisplayClass,
  simulatorEntryFor,
  unavailabilityReason,
} from '../lib/robotCharging.js';

const entry = (charging, extra = {}) => ({ robotId: 'SIM-1', charging, chargeTriggerPct: 20, energyWh: 30, reserveWh: 6.66, ...extra });

test('isCharging is true for CHARGING only — never for PAUSED', () => {
  assert.equal(isCharging('CHARGING'), true);
  assert.equal(isCharging('charging'), true);
  assert.equal(isCharging('PAUSED'), false);
  assert.equal(isCharging('IDLE'), false);
});

test('stages: SEEKING, driving, queued at the dock, charging (incl. the completing tick), blocked', () => {
  assert.equal(chargingStageOf(entry({ phase: 'SEEKING' })), CHARGING_STAGE.SEEKING);
  assert.equal(chargingStageOf(entry({ phase: 'APPROACHING' })), CHARGING_STAGE.TO_CHARGER);
  assert.equal(chargingStageOf(entry({ phase: 'WAITING', reservationState: 'QUEUED' })), CHARGING_STAGE.QUEUED);
  assert.equal(chargingStageOf(entry({ phase: 'WAITING', reservationState: 'ACTIVE' })), CHARGING_STAGE.CHARGING);
  assert.equal(chargingStageOf(entry({ phase: 'CHARGING' })), CHARGING_STAGE.CHARGING);
  assert.equal(chargingStageOf(entry({ phase: 'COMPLETE' })), CHARGING_STAGE.CHARGING);
  assert.equal(chargingStageOf(entry({ phase: null, blocked: { code: 'NO_PLUG' } })), CHARGING_STAGE.BLOCKED);
  assert.equal(chargingStageOf(entry({ phase: null, blocked: null })), null);
  assert.equal(chargingStageOf(null), null);
});

test('card class: a PAUSED robot that is discharging is "paused", not "charging"', () => {
  assert.equal(robotDisplayClass({ status: 'PAUSED' }, entry({ phase: null })), 'paused');
  assert.equal(robotDisplayClass({ status: 'PAUSED' }, null), 'paused');
});

test('card class: a PAUSED robot genuinely charging at the dock IS shown charging', () => {
  assert.equal(robotDisplayClass({ status: 'PAUSED' }, entry({ phase: 'CHARGING' })), 'charging');
});

test('card class: driving to / queued at a charger is not "charging"', () => {
  assert.equal(robotDisplayClass({ status: 'RETURNING' }, entry({ phase: 'APPROACHING' })), 'toCharger');
  assert.equal(robotDisplayClass({ status: 'CHARGING' }, entry({ phase: 'WAITING', reservationState: 'QUEUED' })), 'toCharger');
  assert.equal(robotDisplayClass({ status: 'IDLE' }, entry({ phase: 'SEEKING' })), 'toCharger');
});

test('card class: operational statuses', () => {
  assert.equal(robotDisplayClass({ status: 'ACTIVE' }, null), 'active');
  assert.equal(robotDisplayClass({ status: 'ERROR' }, null), 'issues');
  assert.equal(robotDisplayClass({ status: 'IDLE' }, null), 'idle');
  assert.equal(robotDisplayClass({ status: 'IDLE' }, entry({ phase: null, blocked: { code: 'ROUTE_REFUSED' } })), 'blocked');
});

test('the Charging filter: any charging stage, or a robot reporting CHARGING — not blocked, not PAUSED', () => {
  assert.equal(isInChargingLifecycle({ status: 'IDLE' }, entry({ phase: 'SEEKING' })), true);
  assert.equal(isInChargingLifecycle({ status: 'CHARGING' }, null), true);
  assert.equal(isInChargingLifecycle({ status: 'PAUSED' }, null), false);
  assert.equal(isInChargingLifecycle({ status: 'IDLE' }, entry({ phase: null, blocked: { code: 'NO_PLUG' } })), false);
});

test('details: every value is the backend’s; a missing ETA is "unavailable", never a guess', () => {
  const details = chargingDetails(entry({
    phase: 'APPROACHING', stationId: 'V1DEMO-DEPOT-01', stationName: 'Depot', remainingRouteM: 62.3,
    etaArrivalS: 44, queuePosition: null, estimatedWaitS: null, targetPct: 80, etaCompleteS: null,
  }));
  assert.equal(details.stage, CHARGING_STAGE.TO_CHARGER);
  assert.equal(details.stationName, 'Depot');
  assert.equal(details.etaArrival, '44 s');
  assert.equal(details.estimatedWait, 'unavailable');
  assert.equal(details.etaComplete, 'unavailable');
  assert.equal(details.targetPct, 80);
});

test('durations', () => {
  assert.equal(formatDuration(44.4), '44 s');
  assert.equal(formatDuration(630), '10 min 30 s');
  assert.equal(formatDuration(7868), '2 h 11 min');
  assert.equal(formatDuration(null), 'unavailable');
  assert.equal(formatDuration(Number.NaN), 'unavailable');
});

test('unavailability reasons, in operator words', () => {
  assert.equal(unavailabilityReason({ status: 'IDLE', isOnline: false }, null), 'Offline');
  assert.equal(unavailabilityReason({ status: 'ERROR', isOnline: true }, null), 'Fault — needs operator recovery');
  assert.equal(unavailabilityReason({ status: 'PAUSED', isOnline: true }, null), 'Operator hold');
  assert.equal(unavailabilityReason({ status: 'PAUSED', isOnline: true }, entry({ phase: 'CHARGING' })), 'Operator hold — charging continues at the dock');
  assert.equal(unavailabilityReason({ status: 'CHARGING', isOnline: true }, entry({ phase: 'CHARGING', targetPct: 80 })), 'Charging to 80%');
  assert.equal(unavailabilityReason({ status: 'CHARGING', isOnline: true }, entry({ phase: 'WAITING', reservationState: 'QUEUED' })), 'Waiting for a free charger plug');
  assert.equal(unavailabilityReason({ status: 'RETURNING', isOnline: true }, entry({ phase: 'APPROACHING' })), 'Driving to a charger');
  assert.match(
    unavailabilityReason({ status: 'IDLE', isOnline: true, battery: 15 }, entry({ phase: null, blocked: { code: 'ROUTE_REFUSED', detail: 'x' } })),
    /no campus route to a charger/,
  );
  assert.equal(unavailabilityReason({ status: 'IDLE', isOnline: true, battery: 18 }, entry({ phase: null }, { energyWh: 20 })), 'Low battery — charging due');
  assert.equal(unavailabilityReason({ status: 'IDLE', isOnline: true, battery: 60 }, entry({ phase: null })), null);
});

test('the simulator entry is matched by robot id', () => {
  const status = { robots: [{ robotId: 'SIM-1' }, { robotId: 'SIM-2' }] };
  assert.equal(simulatorEntryFor(status, ' SIM-2 ').robotId, 'SIM-2');
  assert.equal(simulatorEntryFor(null, 'SIM-1'), null);
});

// ── The charging map overlay ──────────────────────────────────────────────────
import { chargerRouteFeatures, stationFeatures, unplacedStations } from '../features/maps/charging/chargingGeoJson.js';

test('map: only stations with an approved, validated coordinate are placed — never a guessed one', () => {
  const status = {
    charging: {
      stations: [
        { chargerId: 'V1DEMO-DEPOT-01', name: 'Depot', usable: true, lat: 12.900729, lon: 77.517603, plugCount: 3, active: 3, queued: 1 },
        { chargerId: 'RNSIT-CHG-PU-COLLEGE', name: 'Near RNSIT PU College building', usable: false, lat: null, lon: null, problems: [{ code: 'NOT_APPROVED' }, { code: 'NO_COORDINATE' }] },
      ],
    },
  };
  const points = stationFeatures(status);
  assert.equal(points.features.length, 1);
  assert.deepEqual(points.features[0].geometry.coordinates, [77.517603, 12.900729]);
  assert.equal(points.features[0].properties.full, true);
  assert.match(points.features[0].properties.label, /3\/3 in use · 1 queued/);
  assert.deepEqual(unplacedStations(status), [{ chargerId: 'RNSIT-CHG-PU-COLLEGE', name: 'Near RNSIT PU College building', reasons: ['NOT_APPROVED', 'NO_COORDINATE'] }]);
});

test('map: a declared but unapproved station is drawn at its DECLARED coordinate as INACTIVE — never as a usable charger', () => {
  const status = {
    charging: {
      stations: [
        { chargerId: 'V1DEMO-DEPOT-01', name: 'Depot', usable: true, lat: 12.900729, lon: 77.517603, plugCount: 3, active: 0, queued: 0 },
        // The backend's report for an unapproved station: no usable position, its declared one for display.
        { chargerId: 'RNSIT-CHG-CANARA-BANK', name: 'Near RNSIT Canara Bank', approved: false, usable: false, lat: null, lon: null,
          declaredLat: 12.902396962367357, declaredLon: 77.51862316497345, problems: [{ code: 'NOT_APPROVED' }] },
      ],
    },
  };
  const features = stationFeatures(status).features;
  assert.equal(features.length, 2);
  const canara = features.find((f) => f.properties.chargerId === 'RNSIT-CHG-CANARA-BANK');
  // GeoJSON order: longitude first.
  assert.deepEqual(canara.geometry.coordinates, [77.51862316497345, 12.902396962367357]);
  assert.equal(canara.properties.inactive, true);
  assert.deepEqual(canara.properties.reasons, ['NOT_APPROVED']);
  assert.match(canara.properties.label, /INACTIVE — NOT_APPROVED/);
  // No capacity or occupancy is claimed for it.
  assert.equal(canara.properties.plugCount, null);
  assert.doesNotMatch(canara.properties.label, /in use/);
  const depot = features.find((f) => f.properties.chargerId === 'V1DEMO-DEPOT-01');
  assert.equal(depot.properties.inactive, false);
  assert.deepEqual(unplacedStations(status), []);
});

test('map: a charger route is the robot’s reported route, unchanged; malformed routes are dropped', () => {
  const status = {
    robots: [
      { robotId: 'SIM-1', charging: { stationId: 'D', route: [{ lat: 1, lon: 2 }, { lat: 3, lon: 4 }] } },
      { robotId: 'SIM-2', charging: { route: [{ lat: 1, lon: 2 }] } },
      { robotId: 'SIM-3', charging: { route: [{ lat: 'x', lon: 2 }, { lat: 3, lon: 4 }] } },
      { robotId: 'SIM-4', charging: null },
    ],
  };
  const lines = chargerRouteFeatures(status);
  assert.equal(lines.features.length, 1);
  assert.deepEqual(lines.features[0].geometry.coordinates, [[2, 1], [4, 3]]);
});
