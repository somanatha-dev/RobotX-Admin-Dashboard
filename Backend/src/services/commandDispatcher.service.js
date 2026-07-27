/**
 * Command Dispatcher Service — DTARO
 *
 * Unified point for sending commands to robot sockets.
 * Dispatches via each robot's dedicated Socket.IO room ("robot:{robotId}",
 * joined at AUTH — see robot.handler.js) instead of the local in-memory
 * socket registry, so this works correctly whether the caller's REST request
 * landed on the same worker process that holds the robot's live connection
 * or not. That indirection is required, not optional, the moment this runs
 * as more than one process behind a load balancer (io.to()/io.in() go
 * through the Socket.IO adapter — see server.js's Redis adapter wiring —
 * which fans requests out to whichever worker actually owns the socket;
 * getRobotSocket()'s local Map has no visibility outside its own process).
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

const MAX_RETRIES = 2;
const RETRY_BASE_MS = 1000; // first retry after 1 s, second after 2 s

function robotRoom(robotId) {
  return `robot:${robotId}`;
}

/**
 * Low-level fire-and-forget emit with retry on an empty room.
 *
 * @param {object} io - Socket.IO server instance
 * @param {string} robotId
 * @param {string} event
 * @param {object} payload
 * @param {object} [options]
 * @param {number} [options.retries]
 * @returns {Promise<{ dispatched: boolean, socketId: string|null, attempts: number }>}
 */
async function dispatch(io, robotId, event, payload, { retries = MAX_RETRIES } = {}) {
  const room = robotRoom(robotId);
  for (let attempt = 0; attempt <= retries; attempt++) {
    // fetchSockets() is adapter-aware (works across worker processes via the
    // Redis adapter, same as within one process) — the cross-worker
    // equivalent of the old getRobotSocket() presence check.
    let sockets = [];
    try {
      sockets = await io.in(room).fetchSockets();
    } catch {
      sockets = [];
    }

    if (!sockets.length) {
      // No socket connected — back off before retrying
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, RETRY_BASE_MS * (attempt + 1)));
        continue;
      }
      return { dispatched: false, socketId: null, attempts: attempt + 1 };
    }

    try {
      io.to(room).emit(event, payload);
      return { dispatched: true, socketId: sockets[0].id, attempts: attempt + 1 };
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
 * @param {object} io - Socket.IO server instance
 * @param {string} robotId
 * @param {{ taskId: string, pickup: object, drop: object, pathToPickup: object[], pathToDrop: object[] }} taskPayload
 */
async function dispatchTaskAssign(io, robotId, taskPayload) {
  return dispatch(io, robotId, "TASK_ASSIGN", { ...taskPayload, timestamp: Date.now() });
}

/**
 * Dispatch REROUTE_ALERT to a robot socket.
 *
 * @param {object} io - Socket.IO server instance
 * @param {string} robotId
 * @param {{ obstacleId: string, lat: number, lon: number, zoneId?: string, severity?: string, newPath?: object[] }} alertPayload
 */
async function dispatchRerouteAlert(io, robotId, alertPayload) {
  // Single retry — rerouting is time-sensitive
  return dispatch(io, robotId, "REROUTE_ALERT", { ...alertPayload, timestamp: Date.now() }, { retries: 1 });
}

module.exports = {
  dispatch,
  dispatchTaskAssign,
  dispatchRerouteAlert,
};
