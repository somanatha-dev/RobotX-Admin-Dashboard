/**
 * Command Dispatcher Service — DTARO
 *
 * Unified point for sending commands to robot sockets.
 * Wraps the in-memory socket registry and provides typed dispatch helpers.
 *
 * Typed helpers: dispatchTaskAssign, dispatchRerouteAlert.
 * (STOP/RETURN_TO_BASE commands are dispatched directly via robots.controller.js's
 * sendRobotCommand, not through this module.)
 *
 * Retry policy: at most MAX_RETRIES additional attempts with back-off.
 * If no socket is connected the payload is silently dropped (real robots
 * should reconnect and pick up state from task recovery; virtual robots
 * are handled by the simulation engine).
 */

const { getRobotSocket } = require("../sockets/robotSockets");

const MAX_RETRIES = 2;
const RETRY_BASE_MS = 1000; // first retry after 1 s, second after 2 s

/**
 * Low-level fire-and-forget emit with retry on missing socket.
 *
 * @param {string} robotId
 * @param {string} event
 * @param {object} payload
 * @param {object} [options]
 * @param {number} [options.retries]
 * @returns {Promise<{ dispatched: boolean, socketId: string|null, attempts: number }>}
 */
async function dispatch(robotId, event, payload, { retries = MAX_RETRIES } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const socket = getRobotSocket(robotId);

    if (!socket) {
      // No socket connected — back off before retrying
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, RETRY_BASE_MS * (attempt + 1)));
        continue;
      }
      return { dispatched: false, socketId: null, attempts: attempt + 1 };
    }

    try {
      socket.emit(event, payload);
      return { dispatched: true, socketId: socket.id, attempts: attempt + 1 };
    } catch {
      if (attempt >= retries) {
        return { dispatched: false, socketId: null, attempts: attempt + 1 };
      }
      await new Promise((r) => setTimeout(r, RETRY_BASE_MS * (attempt + 1)));
    }
  }

  return { dispatched: false, socketId: null, attempts: retries + 1 };
}

/**
 * Dispatch TASK_ASSIGN to a robot socket.
 *
 * @param {string} robotId
 * @param {{ taskId: string, pickup: object, drop: object, pathToPickup: object[], pathToDrop: object[] }} taskPayload
 */
async function dispatchTaskAssign(robotId, taskPayload) {
  return dispatch(robotId, "TASK_ASSIGN", { ...taskPayload, timestamp: Date.now() });
}

/**
 * Dispatch REROUTE_ALERT to a robot socket.
 *
 * @param {string} robotId
 * @param {{ obstacleId: string, lat: number, lon: number, zoneId?: string, severity?: string, newPath?: object[] }} alertPayload
 */
async function dispatchRerouteAlert(robotId, alertPayload) {
  // Single retry — rerouting is time-sensitive
  return dispatch(robotId, "REROUTE_ALERT", { ...alertPayload, timestamp: Date.now() }, { retries: 1 });
}

module.exports = {
  dispatch,
  dispatchTaskAssign,
  dispatchRerouteAlert,
};
