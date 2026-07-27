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
 * Typed helpers: dispatchTaskAssign, dispatchRerouteAlert, dispatchCommand,
 * dispatchStop. Every server-to-robot message goes through one of these —
 * nothing should reach for `getRobotSocket()` to *deliver* a payload (it is
 * still fine for local presence/identity checks), because that Map only ever
 * sees sockets owned by the current process.
 *
 * Retry policy: at most MAX_RETRIES additional attempts with back-off.
 * If no socket is connected the payload is silently dropped (real robots
 * should reconnect and pick up state from task recovery; virtual robots
 * are handled by the simulation engine).
 *
 * Operator-initiated dispatches (dispatchCommand, dispatchStop) pass
 * `retries: 0` deliberately: they are issued from inside an HTTP request the
 * caller is waiting on, so burning up to 3s of back-off on an offline robot
 * would turn a fast "not delivered" answer into a slow one. Their durability
 * comes from elsewhere — the Command row's own 5s reliability scheduler for
 * commands, and task-recovery/reconnect semantics for STOP.
 */

const logger = require("../config/logger");

const MAX_RETRIES = 2;
const RETRY_BASE_MS = 1000; // first retry after 1 s, second after 2 s

function robotRoom(robotId) {
  return `robot:${robotId}`;
}

/**
 * Guard against being called without the Socket.IO server instance.
 *
 * Every dispatch here takes (io, robotId, ...). Calling the older two-argument
 * form binds robotId to `io`, and because `dispatch` treats any failure of the
 * presence check as "no socket connected", the mistake degraded into a silent
 * no-op that still reported itself as having been attempted — a real bug
 * shipped in server.js's restart re-dispatch path and invisible in the logs.
 * Fail loudly instead: a malformed call is a programming error, not a robot
 * that happens to be offline.
 */
function assertIoServer(io, where) {
  if (io && typeof io.in === "function" && typeof io.to === "function") return true;
  logger.error(
    `${where}: called without a Socket.IO server instance — expected (io, robotId, payload). ` +
    "Payload was NOT delivered.",
    { received: typeof io }
  );
  return false;
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
  if (!assertIoServer(io, `dispatch(${event})`)) {
    return { dispatched: false, socketId: null, attempts: 0, error: "NO_IO_SERVER" };
  }

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

/**
 * Dispatch an operator COMMAND (STOP | PAUSE | RETURN | RESUME) to a robot.
 *
 * The event name and payload shape are the robot-side contract: every robot
 * implementation (including simulation/VirtualRobot.js) listens for "COMMAND"
 * and replies with COMMAND_ACK carrying the same `commandId`, which is what
 * sockets/handlers/command.handler.js uses to move the Command row from SENT
 * to ACK and record its response time.
 *
 * @param {object} io - Socket.IO server instance
 * @param {string} robotId
 * @param {{ commandId: string, type: 'STOP'|'PAUSE'|'RETURN'|'RESUME' }} command
 */
async function dispatchCommand(io, robotId, { commandId, type }) {
  return dispatch(io, robotId, "COMMAND", { commandId, type, timestamp: Date.now() }, { retries: 0 });
}

/**
 * Dispatch an immediate STOP to a robot (task cancellation).
 *
 * Distinct from dispatchCommand: this is not a tracked Command row, it is a
 * fire-and-forget "abandon what you are doing" tied to a task lifecycle event,
 * and it expects no ACK.
 *
 * @param {object} io - Socket.IO server instance
 * @param {string} robotId
 * @param {{ taskId?: string, reason?: string }} payload
 */
async function dispatchStop(io, robotId, payload) {
  return dispatch(io, robotId, "STOP", { ...payload, timestamp: Date.now() }, { retries: 0 });
}

module.exports = {
  dispatch,
  dispatchTaskAssign,
  dispatchRerouteAlert,
  dispatchCommand,
  dispatchStop,
};
