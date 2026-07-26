/**
 * Robot Validator Service — DTARO
 *
 * Validates robot eligibility before task allocation.
 * Checks: online status, IDLE/CHARGING state, no active task, battery threshold,
 * no active fault, and socket authentication integrity.
 *
 * CHARGING robots are eligible when `allowCharging: true` is passed AND their
 * live Redis status is "CHARGING" (DB stores "PAUSED" — the enum-compatible value).
 */

const { getRobotState } = require("./robotRegistry.service");
const { getRobotSocket } = require("../sockets/robotSockets");
const { BATTERY_THRESHOLD, CHARGING_INTERRUPT_BATTERY } = require("../config/dtaro.constants");

/**
 * @typedef {object} ValidationResult
 * @property {boolean} valid
 * @property {string|null} reason
 */

/**
 * Validate a single robot for task allocation eligibility.
 *
 * @param {object} kv
 * @param {{ robotId:string, status:string, currentTaskId:string|null, battery:number|null, isOnline:boolean }} robotRow
 * @param {object} [options]
 * @param {number} [options.batteryThreshold]
 * @param {boolean} [options.allowCharging]  When true, CHARGING robots with sufficient battery are accepted.
 * @param {object|null} [options.liveState]  Pre-fetched registry state (e.g. from a batched
 *   `getManyRobotStates` call). When provided, skips the internal `getRobotState` lookup —
 *   pass `undefined` (the default) to have this function fetch it itself.
 * @returns {Promise<ValidationResult>}
 */
async function validateRobot(
  kv,
  robotRow,
  { batteryThreshold = BATTERY_THRESHOLD, allowCharging = false, liveState } = {}
) {
  if (!robotRow) return { valid: false, reason: "Robot not found" };

  const { robotId } = robotRow;

  // Must be online (either DB flag or Redis heartbeat within TTL)
  if (!robotRow.isOnline) {
    return { valid: false, reason: "Robot is offline" };
  }

  const dbStatus = String(robotRow.status || "");

  // Battery check — prefer Redis live value (may say "CHARGING") over DB stale value.
  // Use the pre-fetched state when the caller already batched it (F9); otherwise fetch it here.
  const live = liveState !== undefined ? liveState : await getRobotState(kv, robotId);
  const liveStatus = typeof live?.status === "string" ? live.status : null;

  // Determine effective status: Redis live state is more accurate than DB
  const effectiveStatus = liveStatus || dbStatus;

  // CHARGING robots: DB stores "PAUSED" but Redis live state says "CHARGING"
  const isCharging = effectiveStatus === "CHARGING" || (dbStatus === "PAUSED" && liveStatus === "CHARGING");

  if (isCharging) {
    if (!allowCharging) {
      return { valid: false, reason: "Robot is charging" };
    }
    // Charging robots need a higher battery reserve (task drain + 10% safety margin).
    // Enforce CHARGING_INTERRUPT_BATTERY as the floor regardless of the general
    // `batteryThreshold` default, so callers that don't override it (the common
    // case) still get the intended 30% charge-interrupt floor rather than the
    // 20% general-eligibility floor.
    const chargingMinBattery = Math.max(batteryThreshold, CHARGING_INTERRUPT_BATTERY);
    const battery =
      typeof live?.battery === "number"
        ? live.battery
        : typeof robotRow.battery === "number"
          ? robotRow.battery
          : null;
    if (battery !== null && battery < chargingMinBattery) {
      return {
        valid: false,
        reason: `Charging robot battery ${battery.toFixed(1)}% is below minimum ${chargingMinBattery}% to interrupt`,
      };
    }
    // Skip the currentTaskId check for charging robots (they won't have one)
    if (robotRow.currentTaskId) return { valid: false, reason: "Robot already has an active task" };
    return { valid: true, reason: null };
  }

  // Standard IDLE check
  if (dbStatus !== "IDLE") {
    return { valid: false, reason: `Robot status is ${dbStatus}, expected IDLE` };
  }

  // Must not already have a task
  if (robotRow.currentTaskId) {
    return { valid: false, reason: "Robot already has an active task" };
  }

  // Battery check
  const battery =
    typeof live?.battery === "number"
      ? live.battery
      : typeof robotRow.battery === "number"
        ? robotRow.battery
        : null;

  if (battery !== null && battery < batteryThreshold) {
    return {
      valid: false,
      reason: `Battery ${battery.toFixed(1)}% is below threshold ${batteryThreshold}%`,
    };
  }

  // Fault check via health status in registry
  if (live?.healthStatus === "FAULT") {
    return { valid: false, reason: "Robot has an active hardware fault" };
  }

  // Auth integrity: if a real socket is connected, it must have been authenticated
  const socket = getRobotSocket(robotId);
  if (socket && live?.authenticated === false) {
    return { valid: false, reason: "Robot socket is connected but not authenticated" };
  }

  return { valid: true, reason: null };
}

module.exports = {
  validateRobot,
};
