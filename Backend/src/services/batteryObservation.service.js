"use strict";

/**
 * The agent's **reported state of charge**, carried into `BatteryState.lastObservedSoc` —
 * the column §14's energy decision reads (`coordinatorSolvePath.agentSnapshotLoaderFor`).
 *
 * ── The gap ────────────────────────────────────────────────────────────────
 * `lastObservedSoc` was written once, at commissioning (`agentEnergyProvisioning`), and by
 * nothing afterwards. Telemetry updated `Robot.battery` every frame, but the engine priced
 * every mission against the charge the unit had on the day it was commissioned: a robot
 * that had driven itself down to 20 % was still planned as a 90 % robot (the permissive
 * direction on F34/F35). Measured on the V1 demonstration path, 2026-09-23.
 *
 * ── What this writes, and what it never does ───────────────────────────────
 *   · **Update only.** A missing `BatteryState` row is left missing. Creating one would hand
 *     §14.2 `kappa`'s column default of 1 — an uncalibrated agent presented as a calibrated
 *     one — which is why Step 5 ruled out writing the row from telemetry. Only the two
 *     observation columns of an existing row move.
 *   · **The agent's own report, at the agent's own time.** The reported percentage (never a
 *     carried-forward value) and the frame's agent timestamp. A frame without either is not
 *     an observation of charge and writes nothing.
 *   · **Never backwards.** A frame older than the stored observation does not overwrite it.
 *
 * It is the same for every agent: a simulated unit's report is the simulator's pack, a
 * physical unit's is its own — the provenance is the agent's, not this module's. Today no
 * physical agent has a `BatteryState` row, so for them this is a no-op.
 *
 * ── P2B-2: a report is written only when its measurement basis is established ─
 * A percentage is not a measurement until something says how it was measured. For a
 * **simulated** unit the simulator *is* the pack, so the basis is the simulator's own state
 * (unchanged since D21). For a **physical** unit the frame must declare
 * `energy.socMethod` from `SOC_METHODS` — a BMS, coulomb counting, or a calibrated voltage
 * curve. A bare `battery` from a physical unit (a display estimate, a guess, a firmware
 * default) is never written into the SoC the energy decision plans from; it still reaches
 * the dashboard as a reported value. An undetermined provenance writes nothing.
 */

const PERCENT = 100;

/** P2B-2 — the measurement bases a physical unit may declare for its SoC. @structural */
const SOC_METHODS = Object.freeze(["BMS", "COULOMB_COUNTING", "VOLTAGE_CURVE_CALIBRATED"]);

/** Provenance labels, as `positionObservation.PROVENANCE` states them. @structural */
const PHYSICAL = "PHYSICAL";
const SIMULATED = "SIMULATED";

/**
 * Is the reported SoC's measurement basis established?
 *
 * @param {string|null|undefined} provenance
 * @param {unknown} socMethod
 * @returns {boolean}
 */
function measurementBasisEstablished(provenance, socMethod) {
  if (provenance === SIMULATED) return true;
  if (provenance === PHYSICAL) return typeof socMethod === "string" && SOC_METHODS.includes(socMethod);
  return false;
}

const isNumber = (value) => typeof value === "number" && Number.isFinite(value);

/**
 * @param {object} prisma
 * @param {{ robotId: string, batteryPct: unknown, agentTimestampMs: unknown,
 *   provenance?: string|null, socMethod?: unknown }} input
 * @returns {Promise<{ written: boolean, reason: string|null }>}
 */
async function recordReportedSoc(prisma, input) {
  const { robotId, batteryPct, agentTimestampMs, provenance, socMethod } = input || {};
  if (!prisma || typeof robotId !== "string" || robotId === "") return { written: false, reason: "NO_AGENT" };
  if (!isNumber(batteryPct) || batteryPct < 0 || batteryPct > PERCENT) return { written: false, reason: "NO_REPORTED_SOC" };
  if (!isNumber(agentTimestampMs) || agentTimestampMs <= 0) return { written: false, reason: "NO_AGENT_TIMESTAMP" };
  if (provenance !== PHYSICAL && provenance !== SIMULATED) return { written: false, reason: "PROVENANCE_UNDETERMINED" };
  if (!measurementBasisEstablished(provenance, socMethod)) return { written: false, reason: "NO_MEASUREMENT_BASIS" };

  const agent = await prisma.agent.findUnique({ where: { agentId: robotId }, select: { id: true } });
  if (!agent) return { written: false, reason: "NO_AGENT" };

  const observedAt = new Date(agentTimestampMs);
  const result = await prisma.batteryState.updateMany({
    where: {
      agentId: agent.id,
      OR: [{ lastObservedAt: null }, { lastObservedAt: { lt: observedAt } }],
    },
    data: { lastObservedSoc: batteryPct / PERCENT, lastObservedAt: observedAt },
  });
  return result && result.count > 0 ? { written: true, reason: null } : { written: false, reason: "NO_ROW_OR_NOT_NEWER" };
}

module.exports = { SOC_METHODS, measurementBasisEstablished, recordReportedSoc };
