/**
 * The robot charging view — what the dashboard shows about a robot's battery and charging
 * lifecycle, derived only from what the backend reports.
 *
 * Two sources, never mixed up:
 *   · the robot row's `status` / `battery` (live through `robot:update`), and
 *   · the simulator's own report of a SIMULATED robot (`GET /api/simulator/status` →
 *     `robots[].charging`): its charging phase, reservation, destination charger, route, ETAs,
 *     queue position and — when charging is unavailable — the reason.
 *
 * Rules this module exists to keep (charging audit U-1, U-3):
 *   · PAUSED alone never means charging. Only a genuine charging phase is shown as charging.
 *   · Seeking a charger, driving to it, waiting for a plug and charging are different stages.
 *   · An ETA is shown only when the backend computed one from the route and the simulation;
 *     otherwise it is "unavailable", never a guess.
 *
 * Pure: no React, no DOM, no clock.
 */

import { normalizeStatus } from './robotStatus.js';

/** The charging stages a robot can be in, or none. */
export const CHARGING_STAGE = Object.freeze({
  SEEKING: 'SEEKING',
  TO_CHARGER: 'TO_CHARGER',
  QUEUED: 'QUEUED',
  CHARGING: 'CHARGING',
  BLOCKED: 'BLOCKED',
});

const STAGE_LABEL = Object.freeze({
  SEEKING: 'Requesting a charger',
  TO_CHARGER: 'Driving to charger',
  QUEUED: 'Waiting for a free plug',
  CHARGING: 'Charging',
  BLOCKED: 'Charging unavailable',
});

const BLOCKED_LABEL = Object.freeze({
  NO_PLUG: 'no charger plug could be reserved',
  ROUTE_REFUSED: 'no campus route to a charger',
  RESERVATION_LOST: 'the charger reservation ended',
  APPROACH_ABANDONED: 'the trip to the charger was abandoned',
});

/** The simulator's entry for one robot, or null. */
export function simulatorEntryFor(simulatorStatus, robotId) {
  const robots = simulatorStatus && Array.isArray(simulatorStatus.robots) ? simulatorStatus.robots : [];
  const wanted = String(robotId || '').trim();
  return robots.find((entry) => String(entry && entry.robotId).trim() === wanted) || null;
}

/**
 * The charging stage a simulator entry reports, or null when the robot is not in a charging
 * session (and charging is not blocked).
 */
export function chargingStageOf(entry) {
  const charging = entry && entry.charging;
  if (!charging) return null;
  switch (charging.phase) {
    case 'SEEKING':
      return CHARGING_STAGE.SEEKING;
    case 'APPROACHING':
      return CHARGING_STAGE.TO_CHARGER;
    case 'WAITING':
      // Docked. Current flows only once the plug is granted (ACTIVE); queued until then.
      return charging.reservationState === 'QUEUED' || charging.reservationState == null
        ? CHARGING_STAGE.QUEUED
        : CHARGING_STAGE.CHARGING;
    case 'CHARGING':
    case 'COMPLETE':
      return CHARGING_STAGE.CHARGING;
    default:
      return charging.blocked ? CHARGING_STAGE.BLOCKED : null;
  }
}

/** A duration in seconds as "12 min 5 s"; "unavailable" when it is not a finite number. */
export function formatDuration(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return 'unavailable';
  const whole = Math.round(seconds);
  if (whole < 60) return `${whole} s`;
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  if (minutes < 60) return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins ? `${hours} h ${mins} min` : `${hours} h`;
}

/**
 * The card tone for a robot: `charging` only for a genuine charging stage, `toCharger` for the
 * stages before current flows, then the operational status. PAUSED is its own class.
 *
 * @returns {'active'|'charging'|'toCharger'|'blocked'|'paused'|'issues'|'idle'}
 */
export function robotDisplayClass(robot, entry) {
  const stage = chargingStageOf(entry);
  const status = normalizeStatus(robot && robot.status);
  if (stage === CHARGING_STAGE.CHARGING) return 'charging';
  if (stage === CHARGING_STAGE.SEEKING || stage === CHARGING_STAGE.TO_CHARGER || stage === CHARGING_STAGE.QUEUED) {
    return 'toCharger';
  }
  if (status === 'PAUSED') return 'paused';
  if (['ERROR', 'ISSUES', 'OFFLINE'].includes(status)) return 'issues';
  if (stage === CHARGING_STAGE.BLOCKED) return 'blocked';
  if (status === 'ACTIVE' || status === 'RETURNING') return 'active';
  // A robot row reporting CHARGING with no simulator entry (none can today: the physical robot
  // has no charging status) is still a genuine charging report.
  if (status === 'CHARGING') return 'charging';
  return 'idle';
}

/** Is the robot in any charging stage (the "Charging" filter)? */
export function isInChargingLifecycle(robot, entry) {
  const stage = chargingStageOf(entry);
  if (stage && stage !== CHARGING_STAGE.BLOCKED) return true;
  return normalizeStatus(robot && robot.status) === 'CHARGING';
}

/**
 * The details of a robot's charging session, ready to display. Every value is the backend's;
 * missing values are reported as unavailable.
 */
export function chargingDetails(entry) {
  const charging = (entry && entry.charging) || null;
  const stage = chargingStageOf(entry);
  if (!charging || !stage) return null;
  return {
    stage,
    label: STAGE_LABEL[stage],
    stationId: charging.stationId || null,
    stationName: charging.stationName || charging.stationId || null,
    remainingRouteM: typeof charging.remainingRouteM === 'number' ? charging.remainingRouteM : null,
    etaArrival: formatDuration(charging.etaArrivalS),
    queuePosition: typeof charging.queuePosition === 'number' ? charging.queuePosition : null,
    estimatedWait: formatDuration(charging.estimatedWaitS),
    targetPct: typeof charging.targetPct === 'number' ? charging.targetPct : null,
    etaComplete: formatDuration(charging.etaCompleteS),
    blocked: charging.blocked
      ? {
          code: charging.blocked.code,
          reason: BLOCKED_LABEL[charging.blocked.code] || String(charging.blocked.code || 'unknown'),
          detail: charging.blocked.detail || '',
        }
      : null,
  };
}

/**
 * Why a robot is not available for work right now, in operator words — or null when nothing
 * the dashboard knows of keeps it out. The assignment engine decides per task (F34 energy, F09
 * health, F18 charging); this explains the robot-level reasons the backend reports.
 */
export function unavailabilityReason(robot, entry) {
  if (!robot) return null;
  const status = normalizeStatus(robot.status);
  const stage = chargingStageOf(entry);
  const details = chargingDetails(entry);
  if (robot.isOnline === false || status === 'OFFLINE') return 'Offline';
  if (status === 'ERROR') return 'Fault — needs operator recovery';
  if (status === 'ISSUES') return 'Degraded (ISSUES) — needs operator review';
  if (status === 'PAUSED') {
    return stage === CHARGING_STAGE.CHARGING ? 'Operator hold — charging continues at the dock' : 'Operator hold';
  }
  if (stage === CHARGING_STAGE.CHARGING) {
    return details && details.targetPct !== null ? `Charging to ${details.targetPct}%` : 'Charging';
  }
  if (stage === CHARGING_STAGE.QUEUED) return 'Waiting for a free charger plug';
  if (stage === CHARGING_STAGE.TO_CHARGER) return 'Driving to a charger';
  if (stage === CHARGING_STAGE.SEEKING) return 'Requesting a charger';
  const charging = entry && entry.charging;
  if (charging && charging.blocked) {
    const reason = BLOCKED_LABEL[charging.blocked.code] || charging.blocked.code;
    return `Needs charging — unavailable: ${reason}`;
  }
  if (entry && typeof entry.energyWh === 'number' && typeof entry.reserveWh === 'number' && entry.energyWh <= entry.reserveWh) {
    return 'At its energy reserve';
  }
  if (entry && typeof entry.chargeTriggerPct === 'number' && typeof robot.battery === 'number' && robot.battery <= entry.chargeTriggerPct) {
    return 'Low battery — charging due';
  }
  return null;
}
