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
 *                    writes `lastProbeAckAt` (**server** clock) and the socket id to the
 *                    robot's probe state
 *   getProbeState    reads it back
 *   startProbeEmitter  the cadence, opt-in by `AGENT_PROBE_INTERVAL_MS`
 *
 * `agentFacts.service` reads the proof as `session.lastHeartbeatAckAt`, and only while the
 * socket that earned it is still the robot's current one — a reconnect starts with none.
 *
 * ── Where the proof lives (F7-A) ───────────────────────────────────────────
 * In its own key, `probe:{robotId}`, written by `recordProbeResult` alone and with one SET (no
 * read first). It used to be merged into `registry:{robotId}`, whose writers each read the
 * whole value and write it back later — telemetry across a frame's database work. A proof
 * recorded inside that window was overwritten with the older one the writer had read (the F7
 * investigation measured it 8 times in 5 Gate 1b runs). No other writer touches this key, so
 * the newest recorded proof is the stored one.
 *
 * ── Which proof a decision reads (F7-B / H5) ───────────────────────────────
 * A round reads its facts as of its pinned decision time D, and a proof stamped after D never
 * counts for D. Keeping only the newest proof meant an answer recorded a few milliseconds after
 * D (41–267 ms in the F7 runs) displaced the one that proved the link at D, and F14 found no
 * proof at all. So the key holds this socket's recent proofs, and readers take the newest one
 * at or before D (`getProbeProofAtOrBefore`). The history is built in the process that holds
 * the socket — the only process that records for it — and still written with one SET, never
 * read back first. A new socket starts its own history; an old socket's proofs never count for
 * a new one in any case.
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
const { safeJsonParse } = require("../utils/json");
const configRegister = require("../engine/config/register/appendixA.json");

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

/**
 * F7-A — how long a recorded proof stays readable: the lifetime of the `socket:{socketId}`
 * binding the proof is tied to. It is renewed by every recorded answer. Inside the registry
 * the proof lived as long as any writer kept that key alive, so a proof aged past F14's
 * budget still read as stale (VIOLATED) rather than absent; this keeps that true for any
 * session that has answered within the hour. A proof never outlives its socket in effect:
 * readers admit it only for the robot's current socket.
 * @structural
 */
const PROBE_STATE_TTL_SEC = 3600;

/**
 * F7-B — how far behind the newest recorded proof a decision time can be and still find its
 * exact proof.
 *
 * What it must cover is the lag between a round's pinned decision time and its facts read: the
 * round's own life, which the register bounds by `shard.lease_duration` (≤ 30 s: a round whose
 * leadership lapsed cannot commit) and `solve.time_budget` (≤ 2 s), and the commit recheck,
 * which reads as of the store's own time. It is taken as the larger of the register's maximum
 * shard lease and its maximum F14 budget (`connectivity.max_heartbeat_age`, ≤ 60 s, the
 * longest a proof can be relevant), so no admissible configuration outruns it. Past it the
 * read is not wrong, only conservative: the earlier proof may be gone, so the decision finds
 * none — INDETERMINATE, never a proof from after D.
 * @structural derived from the register's ranges
 */
const PROOF_RETENTION_MS = (() => {
  const maxOf = (name) => {
    const entry = configRegister.parameters.find((parameter) => parameter.name === name);
    if (!entry || !entry.range || !Number.isFinite(entry.range.max)) throw new Error(`agentProbe: the register has no range for ${name}`);
    return entry.range.max;
  };
  return Math.max(maxOf("connectivity.max_heartbeat_age"), maxOf("shard.lease_duration")) * 1000;
})();

/**
 * F7-B — a ceiling on the retained history, for memory only. The PROBE_RESULT rate limit (30 in
 * a fixed 60 s window, `robot.handler`) admits at most 60 answers in any 60 s span, plus the one
 * older proof kept below; this sits above that, so at the configured limit it never trims a
 * proof the horizon keeps. @structural
 */
const MAX_RETAINED_PROOFS = 64;

/** @param {string} robotId */
function probeStateKey(robotId) {
  return `probe:${robotId}`;
}

/** This socket's recorded proofs, oldest first: `{ at, linkQuality? }`. */
function proofsOf(socket) {
  if (!Array.isArray(socket.data.probeProofs)) socket.data.probeProofs = [];
  return socket.data.probeProofs;
}

/**
 * Add one proof and drop what no decision inside the horizon can select: every proof older
 * than `newest − PROOF_RETENTION_MS` except the newest of those, which stays because it is still
 * the right answer for a decision just inside the horizon (and reads as stale — VIOLATED — rather
 * than absent).
 */
function retainProof(proofs, proof) {
  proofs.push(proof);
  proofs.sort((a, b) => a.at - b.at);
  const cutoff = proofs[proofs.length - 1].at - PROOF_RETENTION_MS;
  const firstInside = proofs.findIndex((entry) => entry.at >= cutoff);
  if (firstInside > 1) proofs.splice(0, firstInside - 1);
  if (proofs.length > MAX_RETAINED_PROOFS) proofs.splice(0, proofs.length - MAX_RETAINED_PROOFS);
  return proofs;
}

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
  const proofs = retainProof(proofsOf(socket), { at: nowMs, ...(linkQuality === null ? {} : { linkQuality }) });
  const newest = proofs[proofs.length - 1];
  if (kv) {
    try {
      // The whole state in one SET, never a read-modify-write: this function is its only
      // writer, and the socket's own history is the source, so the last SET holds every
      // proof before it. The newest is also stated at the top level (the F7-A shape).
      await kv.set(
        probeStateKey(robotId),
        JSON.stringify({
          robotId,
          lastProbeAckAt: newest.at,
          lastProbeSocketId: socket.id,
          ...(newest.linkQuality === undefined ? {} : { linkQuality: newest.linkQuality }),
          proofs,
        }),
        { ex: PROBE_STATE_TTL_SEC },
      );
    } catch {
      // ignore — the store unavailable, live state degrades gracefully (as the registry did)
    }
  }
  return { outcome: OUTCOME.RECORDED, robotId };
}

/**
 * The robot's recorded probe proof, or null. It is read only as stored; whether it proves
 * anything (the robot's current socket, the decision time) is the reader's rule.
 *
 * @param {object} kv
 * @param {string} robotId
 * @returns {Promise<{ robotId: string, lastProbeAckAt: number, lastProbeSocketId: string, linkQuality?: number }|null>}
 */
async function getProbeState(kv, robotId) {
  if (!kv || !robotId) return null;
  try {
    const state = safeJsonParse(await kv.get(probeStateKey(robotId)));
    return state && typeof state === "object" && state.robotId === robotId ? state : null;
  } catch {
    return null;
  }
}

/**
 * F7-B — the newest recorded proof stamped at or before `decisionTimeMs` (`proofTime <=
 * decisionTime`), in the shape `getProbeState` returns, or null when there is none. With no
 * decision time it is the newest proof. Whether it proves anything for a given robot row (its
 * current socket) is still the reader's rule.
 *
 * @param {object} kv
 * @param {string} robotId
 * @param {number} [decisionTimeMs]
 * @returns {Promise<{ robotId: string, lastProbeAckAt: number, lastProbeSocketId: string, linkQuality?: number }|null>}
 */
async function getProbeProofAtOrBefore(kv, robotId, decisionTimeMs) {
  const state = await getProbeState(kv, robotId);
  if (!state) return null;
  // A value written before F7-B holds only the newest proof.
  const history = Array.isArray(state.proofs) ? state.proofs : [{ at: state.lastProbeAckAt, linkQuality: state.linkQuality }];
  const bounded = Number.isFinite(decisionTimeMs);
  let selected = null;
  for (const entry of history) {
    const at = entry && entry.at;
    if (typeof at !== "number" || !Number.isFinite(at)) continue;
    if (bounded && at > decisionTimeMs) continue;
    if (!selected || at > selected.at) selected = entry;
  }
  if (!selected) return null;
  const linkQuality = selected.linkQuality;
  return {
    robotId,
    lastProbeAckAt: selected.at,
    lastProbeSocketId: state.lastProbeSocketId,
    ...(typeof linkQuality === "number" && Number.isFinite(linkQuality) ? { linkQuality } : {}),
  };
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
  PROBE_STATE_TTL_SEC,
  PROOF_RETENTION_MS,
  MAX_RETAINED_PROOFS,
  probeStateKey,
  linkQualityOf,
  issueProbe,
  recordProbeResult,
  getProbeState,
  getProbeProofAtOrBefore,
  intervalFromEnv,
  startProbeEmitter,
};
