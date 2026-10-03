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
 * The live value goes to the robot registry on every accepted report (F7 needs freshness
 * within `connectivity.max_heartbeat_age`); an `emergency_stop` Observation is written only
 * when the state changes, as the durable record.
 */

const { setRobotState } = require("./robotRegistry.service");
const positionObservation = require("./positionObservation.service");
const observation = require("../engine/domain/observation");

/** @structural the mechanism label */
const MECHANISM = "SOFTWARE_STOP_LATCH";

/** robotId → last recorded `engaged`, per process, bounded by fleet size. */
const lastRecorded = new Map();

/**
 * @param {{ prisma: object, kv: object, robotId: string, payload: object, snapshot?: object, nowMs?: number }} input
 * @returns {Promise<{ recorded: boolean, reason: string|null, engaged?: boolean }>}
 */
async function recordStopLatch(input) {
  const { prisma, kv, robotId, payload, snapshot } = input || {};
  const latch = payload && payload.safety && payload.safety.stopLatch;
  if (!latch || typeof latch.engaged !== "boolean") return { recorded: false, reason: "NO_LATCH_REPORT" };

  const observedAtMs = positionObservation.agentTimestampFrom(payload);
  if (typeof observedAtMs !== "number" || !Number.isFinite(observedAtMs) || observedAtMs <= 0) {
    return { recorded: false, reason: "NO_AGENT_TIMESTAMP" };
  }
  const nowMs = input && Number.isFinite(input.nowMs) ? input.nowMs : Date.now();
  const skewMs = positionObservation.maxClockSkewMsFrom(snapshot || null);
  if (!Number.isFinite(skewMs) || observedAtMs > nowMs + skewMs) return { recorded: false, reason: "CLOCK_AHEAD" };

  const components = latch.components && typeof latch.components === "object" ? latch.components : null;
  await setRobotState(kv, robotId, { stopLatch: { engaged: latch.engaged, observedAtMs, mechanism: MECHANISM } });

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

/** Test seam. */
function resetStopLatchState() {
  lastRecorded.clear();
}

module.exports = { MECHANISM, recordStopLatch, resetStopLatchState };
