"use strict";

/**
 * The rover's **software stop latch**, as the Pi reports it on TELEMETRY:
 *
 *     safety: { stopLatch: { engaged: <boolean>, components?: { … } } }
 *
 * `engaged` is true while the rover is latched in a stop that needs operator action (the
 * ESP32 safety_stop latch, a Pi motion inhibit, …). Owner decision 2026-10-03: under the
 * physical fleet declaration's `emergencyStop.mechanism: SOFTWARE_STOP_LATCH`, this report is
 * what F7 reads. It is recorded with `mechanism: SOFTWARE_STOP_LATCH` everywhere so it is
 * never mistaken for a hardware e-stop circuit, which the rover does not have.
 *
 * Stamped with the agent's own measurement instant (the frame's `timestamp`), bounded by the
 * same clock-skew rule as a position fix. A report with no boolean, no timestamp, or a
 * timestamp ahead of the bound is not recorded — absence keeps F7 denying.
 *
 * The live value goes to its own key, `stopLatch:{robotId}`, on every accepted report (F7 needs
 * freshness within `connectivity.max_heartbeat_age`); an `emergency_stop` Observation is written
 * only when the state changes, as the durable record.
 *
 * ── One owner, newest first ────────────────────────────────────────────────
 * The latch used to be a field of `registry:{robotId}`, whose writers each read the whole value
 * and write it back later: telemetry across a frame's database work, every `setRobotState` caller
 * (HEARTBEAT, AUTH), `markOffline`. Any of them could restore an older `engaged: false` over a
 * newer `true`, and an older frame finishing after a newer one recorded its older report last.
 * F7 — class I, absolute — then read `false` (reproduced by the 2026-10-06 safety audit). Now:
 *   - this function is the only writer, with one SET and no read first; the registry drops the
 *     field on every merge (`robotRegistry.service`);
 *   - a report older than the newest one this socket recorded is refused. The socket lives in
 *     one process, and the check and the write's issue happen with no await between them, so
 *     the last SET this socket issues is its newest report. At an equal timestamp only an
 *     engaged report may replace a released one;
 *   - the value names the socket that reported it, and F7 admits it only for the robot's current
 *     socket (`physicalFacts`). A replaced socket's late write — possibly from another process,
 *     so no in-process ordering covers it — is therefore never read as this robot's latch: F7
 *     finds none and denies until the current socket reports. Never an older `false`.
 */

const positionObservation = require("./positionObservation.service");
const observation = require("../engine/domain/observation");
const { safeJsonParse } = require("../utils/json");

/** @structural the mechanism label */
const MECHANISM = "SOFTWARE_STOP_LATCH";

/**
 * How long the recorded latch stays readable: the lifetime of the `socket:{socketId}` binding it
 * is tied to, as for the probe proof (`agentProbe.PROBE_STATE_TTL_SEC`). Renewed by every report;
 * a reading past F7's budget still reads as stale, not absent. @structural
 */
const STOP_LATCH_STATE_TTL_SEC = 3600;

/** @param {string} robotId */
function stopLatchKey(robotId) {
  return `stopLatch:${robotId}`;
}

/** robotId → last recorded `engaged`, per process, bounded by fleet size. */
const lastRecorded = new Map();

/**
 * @param {{ prisma: object, kv: object, robotId: string, payload: object, snapshot?: object, nowMs?: number, socket: object }} input
 *   `socket` is the authenticated socket the report arrived on
 * @returns {Promise<{ recorded: boolean, reason: string|null, engaged?: boolean }>}
 */
async function recordStopLatch(input) {
  const { prisma, kv, robotId, payload, snapshot, socket } = input || {};
  const latch = payload && payload.safety && payload.safety.stopLatch;
  if (!latch || typeof latch.engaged !== "boolean") return { recorded: false, reason: "NO_LATCH_REPORT" };

  const observedAtMs = positionObservation.agentTimestampFrom(payload);
  if (typeof observedAtMs !== "number" || !Number.isFinite(observedAtMs) || observedAtMs <= 0) {
    return { recorded: false, reason: "NO_AGENT_TIMESTAMP" };
  }
  const nowMs = input && Number.isFinite(input.nowMs) ? input.nowMs : Date.now();
  const skewMs = positionObservation.maxClockSkewMsFrom(snapshot || null);
  if (!Number.isFinite(skewMs) || observedAtMs > nowMs + skewMs) return { recorded: false, reason: "CLOCK_AHEAD" };

  // Bound to the socket that reported it; without one there is nothing to bind it to.
  if (!socket || typeof socket.id !== "string" || socket.id === "" || !socket.data) return { recorded: false, reason: "NO_SOCKET" };

  // Newest report first, by the agent's own timestamp. Checked and claimed before the write is
  // issued, with no await in between.
  const newest = socket.data.stopLatchNewest;
  if (newest && (observedAtMs < newest.observedAtMs || (observedAtMs === newest.observedAtMs && !(latch.engaged === true && newest.engaged === false)))) {
    return { recorded: false, reason: "OUT_OF_ORDER" };
  }
  socket.data.stopLatchNewest = { observedAtMs, engaged: latch.engaged };

  const components = latch.components && typeof latch.components === "object" ? latch.components : null;
  if (kv) {
    await kv.set(stopLatchKey(robotId), JSON.stringify({ robotId, socketId: socket.id, engaged: latch.engaged, observedAtMs }), {
      ex: STOP_LATCH_STATE_TTL_SEC,
    });
  }

  if (lastRecorded.get(robotId) !== latch.engaged) {
    lastRecorded.set(robotId, latch.engaged);
    if (lastRecorded.size > 50_000) lastRecorded.clear();
    const agent = await prisma.agent.findUnique({ where: { agentId: robotId }, select: { id: true } });
    if (agent) {
      await prisma.observation.create({
        data: {
          agentId: agent.id,
          kind: "emergency_stop",
          value: { engaged: latch.engaged, mechanism: MECHANISM, ...(components ? { components } : {}) },
          observedAt: new Date(observedAtMs),
          source: observation.OBSERVATION_SOURCE.AGENT_REPORT,
        },
      });
    }
  }
  return { recorded: true, reason: null, engaged: latch.engaged };
}

/**
 * The robot's recorded latch, or null. Read only as stored: whether it counts (the robot's current
 * socket, F7's freshness, the decision time) is the reader's rule.
 *
 * @param {object} kv
 * @param {string} robotId
 * @returns {Promise<{ robotId: string, socketId: string, engaged: boolean, observedAtMs: number }|null>}
 */
async function getStopLatchState(kv, robotId) {
  if (!kv || !robotId) return null;
  try {
    const state = safeJsonParse(await kv.get(stopLatchKey(robotId)));
    return state && typeof state === "object" && state.robotId === robotId ? state : null;
  } catch {
    return null;
  }
}

/** Test seam. */
function resetStopLatchState() {
  lastRecorded.clear();
}

module.exports = { MECHANISM, STOP_LATCH_STATE_TTL_SEC, stopLatchKey, recordStopLatch, getStopLatchState, resetStopLatchState };
