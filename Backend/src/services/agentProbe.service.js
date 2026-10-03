"use strict";

/**
 * P2B-2 — the **PROBE / PROBE_RESULT** boundary: the server-initiated round trip §7.5 F14
 * requires and nothing produced.
 *
 * ── The gap ────────────────────────────────────────────────────────────────
 * F14 admits an agent only on proof that the command path carries traffic *from the
 * server*: an acknowledged server-initiated exchange (`session.lastHeartbeatAckAt` or
 * `lastCommandRoundTripAt`). `HEARTBEAT` is agent-initiated and unacknowledged, so for a
 * physical agent F14 has had no producer at all; only the simulator states the field
 * (`simulatedAgentState`'s session overlay). P2A recorded this as G-1.
 *
 * ── What this is ───────────────────────────────────────────────────────────
 * The existing vocabulary, not a new one: `PROBE` is a §10.3.1 query command
 * (`fencing.QUERY_COMMANDS` — "side-effect-free. Always answered; never fenced"), and
 * `PROBE_RESULT` is the answer the reference client already sends (`VirtualRobot._onQuery`).
 * A query is never outboxed (`outbox.buildRow` refuses one), so it is a live emit on the
 * socket, and its proof is bound to that socket.
 *
 *   issueProbe       emits `PROBE { command, correlationId, issuedAtMs }` and remembers it
 *                    on the socket
 *   recordProbeResult  accepts `PROBE_RESULT` only for an outstanding correlation id, on the
 *                    same socket, within `RESULT_TIMEOUT_MS`, naming no other robot — then
 *                    writes `lastProbeAckAt` (**server** clock) and the socket id to the live
 *                    registry
 *   startProbeEmitter  the cadence, opt-in by `AGENT_PROBE_INTERVAL_MS`
 *
 * `agentFacts.service` reads the proof as `session.lastHeartbeatAckAt`, and only while the
 * socket that earned it is still the robot's current one — a reconnect starts with none.
 *
 * ── What this is NOT ───────────────────────────────────────────────────────
 * Not a health claim. A PROBE_RESULT proves the link carried a server-initiated message and
 * the agent's process answered it; it says nothing about motors, sensors or safety. Nothing
 * here answers on an agent's behalf, and an unanswered probe leaves F14 exactly as absent
 * as before. The emitter is **off unless configured**: the physical Pi does not implement
 * PROBE yet (P2B-1), and an agent that does not know the event would only log it.
 */

const crypto = require("crypto");
const { toStringOrNull } = require("../utils/parse");
const { setRobotState } = require("./robotRegistry.service");

/** @structural §10.3.1's query name and the reference client's answer name */
const PROBE_EVENT = "PROBE";
const RESULT_EVENT = "PROBE_RESULT";

/**
 * How long after issue an answer still proves the round trip — the P2A contract's "within
 * 2 s". A late answer proves a link that was slow when it mattered, and is not recorded.
 * @structural the contract's stated response window
 */
const RESULT_TIMEOUT_MS = 2000;

/** Outstanding probes remembered per socket; the oldest is dropped beyond this. @structural */
const MAX_PENDING = 8;

/** The environment variable that enables the emitter, in milliseconds. Infrastructure. @structural */
const ENV_VAR = "AGENT_PROBE_INTERVAL_MS";

/**
 * Gate 1 — how many recent probes F15's measured link quality is taken over. @structural
 */
const LINK_QUALITY_WINDOW = 10;

/** Why a PROBE_RESULT was or was not recorded. @structural outcome labels */
const OUTCOME = Object.freeze({
  RECORDED: "RECORDED",
  NOT_AUTHENTICATED: "NOT_AUTHENTICATED",
  NO_CORRELATION_ID: "NO_CORRELATION_ID",
  UNKNOWN_CORRELATION: "UNKNOWN_CORRELATION",
  LATE: "LATE",
  MISMATCHED_IDENTITY: "MISMATCHED_IDENTITY",
});

function pendingOf(socket) {
  if (!socket.data.pendingProbes || !(socket.data.pendingProbes instanceof Map)) socket.data.pendingProbes = new Map();
  return socket.data.pendingProbes;
}

/**
 * Emit one PROBE to an authenticated socket.
 *
 * @param {object} socket
 * @param {number} nowMs server clock
 * @returns {{ correlationId: string, issuedAtMs: number }|null} null for an unauthenticated socket
 */
function ledgerOf(socket) {
  if (!Array.isArray(socket.data.probeLedger)) socket.data.probeLedger = [];
  return socket.data.probeLedger;
}

/**
 * Gate 1 — F15's link quality: the share of this socket's recent probes answered in time.
 * Probes still inside their answer window are not counted either way.
 */
function linkQualityOf(socket, nowMs) {
  const settled = ledgerOf(socket).filter((entry) => entry.answered || nowMs - entry.issuedAtMs > RESULT_TIMEOUT_MS);
  if (settled.length === 0) return null;
  return settled.filter((entry) => entry.answered).length / settled.length;
}

function issueProbe(socket, nowMs) {
  if (!socket || !socket.data || socket.data.isAuthed !== true || !socket.data.robotId) return null;
  const pending = pendingOf(socket);
  const correlationId = crypto.randomUUID();
  pending.set(correlationId, nowMs);
  const ledger = ledgerOf(socket);
  ledger.push({ correlationId, issuedAtMs: nowMs, answered: false });
  while (ledger.length > LINK_QUALITY_WINDOW) ledger.shift();
  while (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value);
  socket.emit(PROBE_EVENT, { command: PROBE_EVENT, correlationId, issuedAtMs: nowMs });
  return { correlationId, issuedAtMs: nowMs };
}

/**
 * Record a PROBE_RESULT, if it proves a round trip this socket's probe started.
 *
 * @param {{ kv: object, socket: object, payload: object, nowMs: number }} input
 * @returns {Promise<{ outcome: string, robotId: string|null }>}
 */
async function recordProbeResult(input) {
  const { kv, socket, payload, nowMs } = input || {};
  const robotId = socket && socket.data && socket.data.isAuthed === true ? toStringOrNull(socket.data.robotId) : null;
  if (!robotId) return { outcome: OUTCOME.NOT_AUTHENTICATED, robotId: null };

  const correlationId = toStringOrNull(payload && payload.correlationId);
  if (!correlationId) return { outcome: OUTCOME.NO_CORRELATION_ID, robotId };

  const pending = pendingOf(socket);
  const issuedAtMs = pending.get(correlationId);
  if (issuedAtMs === undefined) return { outcome: OUTCOME.UNKNOWN_CORRELATION, robotId };
  pending.delete(correlationId);

  if (nowMs - issuedAtMs > RESULT_TIMEOUT_MS) return { outcome: OUTCOME.LATE, robotId };

  // Identity comes from the socket. A payload naming a different robot is refused rather than
  // ignored: it is either a misconfigured agent or one answering for another.
  const named = payload && payload.robotId !== undefined && payload.robotId !== null ? String(payload.robotId) : null;
  if (named !== null && named !== robotId) return { outcome: OUTCOME.MISMATCHED_IDENTITY, robotId };

  const entry = ledgerOf(socket).find((row) => row.correlationId === correlationId);
  if (entry) entry.answered = true;
  const linkQuality = linkQualityOf(socket, nowMs);
  await setRobotState(kv, robotId, {
    lastProbeAckAt: nowMs,
    lastProbeSocketId: socket.id,
    ...(linkQuality === null ? {} : { linkQuality }),
  });
  return { outcome: OUTCOME.RECORDED, robotId };
}

/**
 * The configured cadence, or null when the emitter is off.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number|null}
 */
function intervalFromEnv(env) {
  const raw = (env || process.env)[ENV_VAR];
  const value = Number(raw);
  return raw !== undefined && raw !== "" && Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * Probe every authenticated robot socket held by this process, on a cadence. Each process
 * probes its own sockets — the proof is bound to the socket, which lives in exactly one.
 *
 * @param {{ io: object, intervalMs: number, logger?: object }} input
 * @returns {{ stop: () => void }}
 */
function startProbeEmitter(input) {
  const { io, intervalMs, logger } = input || {};
  if (!io || !Number.isInteger(intervalMs) || intervalMs <= 0) throw new TypeError("startProbeEmitter requires io and a positive intervalMs");
  const timer = setInterval(() => {
    try {
      const sockets = io.of("/").sockets;
      const nowMs = Date.now();
      for (const socket of sockets.values()) issueProbe(socket, nowMs);
    } catch (e) {
      logger?.warn?.("agent probe pass failed", { message: e?.message });
    }
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return { stop: () => clearInterval(timer) };
}

module.exports = {
  PROBE_EVENT,
  RESULT_EVENT,
  RESULT_TIMEOUT_MS,
  MAX_PENDING,
  ENV_VAR,
  OUTCOME,
  LINK_QUALITY_WINDOW,
  linkQualityOf,
  issueProbe,
  recordProbeResult,
  intervalFromEnv,
  startProbeEmitter,
};
