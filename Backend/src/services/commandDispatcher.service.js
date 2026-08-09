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
// PHASE 12 — §18.5's mode register, consulted before any engine command leaves the process.
// Data and pure queries only; this import adds no store dependency to a legacy-tree service.
const modeRegister = require("../engine/degraded/modeRegister");

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

// ───────────────────────────────────────────────────────────────────────────
// PHASE 4 — the outbox's delivery arm (§11.1 item 2, §11.3).
//
// §4.1 rule 5 states the constraint this section exists to satisfy:
//
//   > Every command to an agent — offer, withdrawal, recall, reroute, stand-down — is
//   > emitted **only** by draining the outbox, and its outbox row is written in the
//   > *same transaction* as the state transition and fence advance that authorise it.
//   > **No component may send a command by any other path.**
//
// The typed helpers above (dispatchTaskAssign / dispatchRerouteAlert /
// dispatchCommand / dispatchStop) are the **legacy** path's events, and they stay
// exactly as they are until the Phase 15 cutover removes the legacy decision path
// from the build. They are not engine commands: none of them carries a fence, a
// sequence, an expiry, or a signature, and no §10.3.1 command name is among them.
//
// `deliverOutboxCommand` is the only route by which a §10.3.1 command reaches an
// agent. It deliberately does **not** retry: retry is the drain worker's loop, bounded
// by the escalation ladder (§11.4), and a second, local retry loop underneath it would
// make the ladder's timings a fiction. It reports the outcome instead of discarding
// it — the discarded dispatch result being, precisely, the baseline defect §11.1
// opens by naming.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Deliver one outbox envelope to its agent.
 *
 * Routing is by agent identity through the room the agent joins at AUTH, which is
 * adapter-aware and therefore correct across worker processes — §11.3's "cluster-safe
 * by construction", and the reason nothing here consults the process-local socket map.
 *
 * @param {object} io Socket.IO server instance
 * @param {string} agentSocketId the identity the agent authenticated with (its robot id)
 * @param {object} envelope from `workers/outbox.worker.js`'s `envelopeOf`
 * @returns {Promise<{ delivered: boolean, detail: string|null, socketId: string|null }>}
 */
async function deliverOutboxCommand(io, agentSocketId, envelope, options = {}) {
  // ── PHASE 12 — §18.5 Custodial Operation: **no commands** ───────────────────
  //
  //   > Command authority derives from a fence allocated in the Commitment Store; with
  //   > the store unavailable no fence can be allocated, so no command can be authorised.
  //   > The engine does not fall back to a cached fence, because a fence that cannot be
  //   > advanced durably provides none of the protection a fence exists to provide.
  //
  // The gate sits here rather than in the drain worker because this function is the *only*
  // route by which a §10.3.1 command reaches an agent (§4.1 rule 5). A check one level up
  // would be a check some future caller could route around; a check at the single exit is
  // one nothing can.
  //
  // `activeModes` is supplied by the caller — the drain worker reads it from
  // `degraded/transitions.activeModes`, whose authority is the `DegradedModeEvent` table.
  // This service does not read it itself, and takes no engine store dependency: a legacy-
  // tree service that queried the mode register would be a second place the shard's mode is
  // determined, and two determinations of "may we command" is one too many.
  //
  // Absent `activeModes`, nothing is suspended. That is the correct default for the legacy
  // path — which has no modes and is unchanged until the Phase 15 cutover — and it is safe
  // for the engine path because the drain worker always supplies it.
  const suspension = modeRegister.commandsSuspended(options.activeModes || []);
  if (suspension.suspended) {
    // Not an error and not a discard: the outbox row stays PENDING and is delivered when
    // the mode exits. §18.4 — infrastructure failure never fails customer work; the queue
    // drains more slowly, and no task is failed for this reason.
    return {
      delivered: false,
      detail: `COMMANDS_SUSPENDED:${suspension.byMode}`,
      socketId: null,
      degradedMode: suspension.byMode,
      reason: suspension.reason,
    };
  }

  if (!assertIoServer(io, `deliverOutboxCommand(${envelope?.command})`)) {
    return { delivered: false, detail: "NO_IO_SERVER", socketId: null };
  }
  if (!agentSocketId) {
    return { delivered: false, detail: "NO_AGENT_IDENTITY", socketId: null };
  }
  if (!envelope || typeof envelope.command !== "string") {
    return { delivered: false, detail: "MALFORMED_ENVELOPE", socketId: null };
  }

  const room = robotRoom(agentSocketId);

  let sockets = [];
  try {
    sockets = await io.in(room).fetchSockets();
  } catch (e) {
    return { delivered: false, detail: `PRESENCE_CHECK_FAILED:${e?.message || "unknown"}`, socketId: null };
  }

  if (!sockets.length) {
    // Not a failure to be logged and forgotten: the row stays PENDING, the worker
    // retries with backoff, and the escalation ladder is what eventually withdraws the
    // offer (§11.4 step 2). "No socket connected" is a state, not a discard.
    return { delivered: false, detail: "AGENT_NOT_CONNECTED", socketId: null };
  }

  try {
    // The event name is the command itself, so every §10.3.1 command is a distinct
    // wire event the agent subscribes to individually — rather than a single opaque
    // envelope whose type is a payload field an agent could forget to switch on.
    io.to(room).emit(envelope.command, envelope);
    return { delivered: true, detail: null, socketId: sockets[0].id };
  } catch (e) {
    return { delivered: false, detail: `EMIT_FAILED:${e?.message || "unknown"}`, socketId: null };
  }
}

/**
 * The delivery function shape `workers/outbox.worker.js` expects, bound to one `io`.
 *
 * @param {object} io
 * @returns {(agentSocketId: string, envelope: object) => Promise<{ delivered: boolean, detail: string|null }>}
 */
function outboxDeliveryArm(io, options = {}) {
  // `options.activeModes` may be a value or a function. A function is what the drain worker
  // passes, because the shard's mode set can change between two rows of one drain pass and a
  // value captured at bind time would let a command out after Custodial Operation opened.
  return (agentSocketId, envelope) =>
    deliverOutboxCommand(io, agentSocketId, envelope, {
      activeModes:
        typeof options.activeModes === "function" ? options.activeModes() : options.activeModes || [],
    });
}

module.exports = {
  dispatch,
  dispatchTaskAssign,
  dispatchRerouteAlert,
  dispatchCommand,
  dispatchStop,
  deliverOutboxCommand,
  outboxDeliveryArm,
};
