"use strict";

/**
 * Write a **simulated** unit's class declaration into the columns a physical unit's real
 * values will later occupy — V1 demonstration, DEVELOPMENT_SIMULATION.
 *
 * ── Why columns, not an overlay ────────────────────────────────────────────
 * `EnergyModelParams` (β, residual CV, stress curves), `EnergyModel` (derating and charge
 * curves), `BatteryState.soh`, `MobilityModel` (permitted surfaces, environmental envelope)
 * and `AgentClass` (firmware set, hardware revision) are what the decision path already
 * reads. Commissioning left all of them null for every unit, so every energy predicate
 * refused and F5/F28/F31 denied. For a simulated unit every one of these is a fact of the
 * simulator (`simulation/simulatedAgentState`), so it is written where the engine reads it —
 * the same columns a physical RobotX's fitted and measured values will fill, with no second
 * read path.
 *
 * `EnergyModelParams.fittedAt` stays **null**: these coefficients are derived from the
 * simulator's drain constants, not fitted to any observation, and a reader asking "was this
 * model fitted" must keep getting "no".
 *
 * Called only from `robot.service.createRobotWithProjection`'s simulated branch, inside the
 * commissioning transaction.
 */

const simulatedAgentState = require("../simulation/simulatedAgentState");
const v1DemonstrationProfile = require("./v1DemonstrationProfile");

/**
 * Write-only: every value it needs is one the commissioning transaction already holds, so
 * nothing is re-read inside it.
 *
 * @param {object} tx a Prisma transaction client
 * @param {object} input
 * @param {string} input.agentRowId `Agent.id`
 * @param {object} input.agentClass the `AgentClass` row just upserted (its id and model ids)
 * @param {number} [input.packNominalWh] the unit's declared pack
 * @param {object} [input.chassisPermissionSet] the chassis template's permission set
 * @param {number} [input.payloadCapacityKg] the unit's declared payload mass limit
 * @param {number} [input.vehicleMassKg] `Robot.massKg`
 * @returns {Promise<object>} what was written, for the caller's log
 */
async function applySimulatedClassDeclaration(tx, input) {
  const { agentRowId, agentClass, packNominalWh, chassisPermissionSet, payloadCapacityKg, vehicleMassKg } = input || {};
  if (!agentRowId || !agentClass || !agentClass.id) {
    throw new TypeError("applySimulatedClassDeclaration requires the Agent row id and the AgentClass row");
  }

  const coefficients = simulatedAgentState.simulatedEnergyCoefficients(packNominalWh);
  const pack = simulatedAgentState.simulatedPackDeclaration(packNominalWh);
  const declaration = simulatedAgentState.simulatedClassDeclaration(chassisPermissionSet);
  const isNumber = (value) => typeof value === "number" && Number.isFinite(value);

  // Never over a fitted row: `fittedAt` stays null and only an unfitted row is written.
  await tx.energyModelParams.updateMany({ where: { agentClassId: agentClass.id, fittedAt: null }, data: coefficients });

  if (agentClass.energyModelId) {
    await tx.energyModel.update({
      where: { id: agentClass.energyModelId },
      data: {
        packNominalWh: pack.packNominalWh,
        thermalDeratingCurve: pack.thermalDeratingCurve,
        chargePowerCurve: pack.chargePowerCurve,
      },
    });
  }

  await tx.batteryState.updateMany({ where: { agentId: agentRowId, soh: null }, data: { soh: pack.soh } });

  if (agentClass.mobilityModelId) {
    await tx.mobilityModel.update({
      where: { id: agentClass.mobilityModelId },
      data: {
        permissionSet: declaration.permissionSet,
        envelopeConstraints: { environmental: declaration.environmentalLimits },
      },
    });
  }

  // §15.2 — the V1 service envelope's single compartment, sized by the V1 service
  // definition (`v1DemonstrationProfile.SERVICE_ENVELOPE`) and limited by the unit's own
  // commissioned payload mass, with the container's volume derived from it and a CoG
  // envelope in which it sits on the vehicle's centreline (the simulator has no rigid-body
  // model; F24 still computes the loaded CoG against it).
  if (agentClass.containerModelId) {
    const compartment = v1DemonstrationProfile.SERVICE_ENVELOPE.compartment;
    const created = await tx.compartment.upsert({
      where: { containerModelId_ordinal: { containerModelId: agentClass.containerModelId, ordinal: compartment.ordinal } },
      create: { ...compartment, containerModelId: agentClass.containerModelId, maxMassKg: isNumber(payloadCapacityKg) ? payloadCapacityKg : null },
      update: { ...compartment, maxMassKg: isNumber(payloadCapacityKg) ? payloadCapacityKg : null },
    });
    await tx.containerModel.update({
      where: { id: agentClass.containerModelId },
      data: {
        totalVolumeLitres: (compartment.internalLengthMm * compartment.internalWidthMm * compartment.internalHeightMm) / 1e6,
        cogEnvelope: {
          provenance: v1DemonstrationProfile.PROVENANCE,
          longitudinalMm: [-compartment.internalLengthMm / 2, compartment.internalLengthMm / 2],
          lateralMm: [-compartment.internalWidthMm / 2, compartment.internalWidthMm / 2],
          ...(isNumber(vehicleMassKg) ? { emptyVehicle: { massKg: vehicleMassKg, longitudinalMm: 0, lateralMm: 0 } } : {}),
          compartmentCentroids: { [created && created.id ? created.id : `ordinal-${compartment.ordinal}`]: { longitudinalMm: 0, lateralMm: 0 } },
        },
      },
    });
  }

  await tx.agentClass.update({
    where: { id: agentClass.id },
    data: { firmwareVersionSet: declaration.firmwareVersionSet, hardwareRevision: declaration.hardwareRevision },
  });

  return { provenance: simulatedAgentState.PROVENANCE, packNominalWh: pack.packNominalWh, coefficients, declaration };
}

module.exports = { applySimulatedClassDeclaration };
