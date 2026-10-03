"use strict";

/**
 * Apply a physical robot's **operator declaration** (`fleetProviders/physicalPolicy`) to the
 * rows the assignment engine reads, and record operator-declared state of charge.
 *
 * The physical counterpart of `simulatedClassDeclaration.service`, with one difference that is
 * the whole point: every value written here was declared by the owner for a real unit
 * (PRODUCTION_DECLARED), none is a simulator constant, and none claims to be fitted.
 *
 *   EnergyModelParams  β from the declared idle and moving power draw (Wh per second), every
 *                      term the rover cannot state set to 0 and the row left `fittedAt: null`
 *                      — uncalibrated, so the engine's uncalibrated reserve factor applies
 *   BatteryState       declared SoH; κ at identity; SoC only from `declareStateOfCharge`
 *   MobilityModel      surface classes = the permitted OSM way classes; the robot's declared
 *                      operating ambient range as its environmental envelope
 *   ContainerModel     the V1 service envelope (`v1DemonstrationProfile`), as for any unit
 *   AgentClass         firmwareVersionSet / hardwareRevision the operator attests
 *   Agent              bound to the declared region and put in service (COMMISSIONED → ACTIVE,
 *                      F2); a QUARANTINED, MAINTENANCE or DECOMMISSIONED unit is never re-activated
 *
 * Refuses any robot whose provenance is not PHYSICAL.
 */

const agentEnergyProvisioning = require("./agentEnergyProvisioning.service");
const positionObservation = require("./positionObservation.service");
const v1DemonstrationProfile = require("./v1DemonstrationProfile");
const observation = require("../engine/domain/observation");
const physicalPolicy = require("./fleetProviders/physicalPolicy");

/** @structural watts → Wh per second */
const SECONDS_PER_HOUR = 3600;

const isNumber = (value) => typeof value === "number" && Number.isFinite(value);

class PhysicalDeclarationError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.status = code === "NOT_FOUND" ? 404 : 409;
  }
}

/** The β row a declaration implies. Pure. */
function declaredEnergyCoefficients(energy) {
  const idle = energy.idlePowerW / SECONDS_PER_HOUR;
  const moving = energy.movingPowerW / SECONDS_PER_HOUR;
  const flatZero = [
    { x: -50, y: 0 },
    { x: 100, y: 0 },
  ];
  return {
    betaDist: 0,
    betaMass: 0,
    betaClimb: 0,
    betaRegen: 0,
    etaRegen: 0,
    betaMoveTime: moving - idle,
    betaStopStart: 0,
    betaDwell: 0,
    betaAux: idle,
    betaThermal: { ambientCurve: flatZero, packCurve: flatZero },
    betaPayloadThermal: {},
    stressCurves: {
      dod: [{ x: 0, y: 1 }, { x: 1, y: 1 }],
      socMid: [{ x: 0, y: 1 }, { x: 1, y: 1 }],
      tempC: [{ x: -50, y: 1 }, { x: 100, y: 1 }],
      cRate: [{ x: 0, y: 1 }, { x: 10, y: 1 }],
      calendarAgeing: [{ x: 0, y: 0 }, { x: 1, y: 0 }],
    },
    residualCv: energy.residualCv,
  };
}

/** The permitted OSM way classes, as the surface classes F28 matches the route against. */
function surfaceClassesFor(permissionSet) {
  const classes = permissionSet && Array.isArray(permissionSet.roadClasses) ? permissionSet.roadClasses : [];
  return [...new Set(classes.filter((c) => typeof c === "string" && c !== "").map((c) => c.toUpperCase()))].sort();
}

async function loadPhysicalUnit(prisma, robotId) {
  const robot = await prisma.robot.findUnique({
    where: { robotId },
    select: {
      id: true,
      robotId: true,
      massKg: true,
      agent: {
        select: {
          id: true,
          agentClass: {
            select: {
              id: true,
              mobilityModelId: true,
              energyModelId: true,
              containerModelId: true,
              mobilityModel: { select: { permissionSet: true } },
              containerModel: { select: { totalMassLimitKg: true } },
            },
          },
        },
      },
    },
  });
  if (!robot || !robot.agent) throw new PhysicalDeclarationError("NOT_FOUND", `no commissioned robot "${robotId}" with an Agent`);
  if (!robot.agent.agentClass) throw new PhysicalDeclarationError("NO_CLASS", `robot "${robotId}" has no AgentClass`);
  const provenance = await positionObservation.provenanceOf(prisma, robotId);
  if (provenance !== "PHYSICAL") {
    throw new PhysicalDeclarationError("NOT_PHYSICAL", `robot "${robotId}" is not a physical unit (provenance ${provenance})`);
  }
  return robot;
}

/**
 * Write one robot's declaration onto its rows. Idempotent.
 *
 * @param {object} prisma
 * @param {object} declared one `policy.robotFor(robotId)` entry
 * @param {{ site: object }} policy the loaded physical policy (its site ambient bounds the derating curve)
 */
async function applyRobotDeclaration(prisma, declared, policy) {
  if (!declared || !declared.robotId) throw new TypeError("applyRobotDeclaration requires a validated robot declaration");
  const unit = await loadPhysicalUnit(prisma, declared.robotId);
  const agentClass = unit.agent.agentClass;
  const coefficients = declaredEnergyCoefficients(declared.energy);
  const region = await prisma.region.findFirst({ where: { regionId: declared.control.regionId }, select: { id: true } });
  if (!region) throw new PhysicalDeclarationError("NO_REGION", `no Region "${declared.control.regionId}" for robot "${declared.robotId}"`);
  const operating = declared.control.operatingAmbientC;
  const permissionSet = (agentClass.mobilityModel && agentClass.mobilityModel.permissionSet) || {};
  // The compartment carries the commissioned payload capacity, exactly as a simulated unit's does.
  const payloadCapacityKg = agentClass.containerModel ? agentClass.containerModel.totalMassLimitKg : null;
  const maxMassKg = isNumber(payloadCapacityKg) ? payloadCapacityKg : null;

  await prisma.$transaction(async (tx) => {
    await agentEnergyProvisioning.provisionAgentEnergyState(tx, {
      agentRowId: unit.agent.id,
      agentClassRowId: agentClass.id,
      initialBatteryPct: null,
    });
    await tx.energyModelParams.updateMany({ where: { agentClassId: agentClass.id, fittedAt: null }, data: coefficients });
    await tx.batteryState.updateMany({ where: { agentId: unit.agent.id }, data: { soh: declared.energy.soh } });

    if (agentClass.energyModelId) {
      await tx.energyModel.update({
        where: { id: agentClass.energyModelId },
        data: { thermalDeratingCurve: [{ x: operating.min, y: 1 }, { x: operating.max, y: 1 }] },
      });
    }
    if (agentClass.mobilityModelId) {
      await tx.mobilityModel.update({
        where: { id: agentClass.mobilityModelId },
        data: {
          permissionSet: { ...permissionSet, surfaceClasses: surfaceClassesFor(permissionSet) },
          envelopeConstraints: { environmental: { ambientC: { min: operating.min, max: operating.max, unit: "DEGREES_CELSIUS" } } },
        },
      });
    }
    if (agentClass.containerModelId) {
      const compartment = v1DemonstrationProfile.SERVICE_ENVELOPE.compartment;
      const created = await tx.compartment.upsert({
        where: { containerModelId_ordinal: { containerModelId: agentClass.containerModelId, ordinal: compartment.ordinal } },
        create: { ...compartment, containerModelId: agentClass.containerModelId, maxMassKg },
        update: { ...compartment, maxMassKg },
      });
      await tx.containerModel.update({
        where: { id: agentClass.containerModelId },
        data: {
          totalVolumeLitres: (compartment.internalLengthMm * compartment.internalWidthMm * compartment.internalHeightMm) / 1e6,
          cogEnvelope: {
            provenance: physicalPolicy.PROVENANCE,
            longitudinalMm: [-compartment.internalLengthMm / 2, compartment.internalLengthMm / 2],
            lateralMm: [-compartment.internalWidthMm / 2, compartment.internalWidthMm / 2],
            ...(isNumber(unit.massKg) ? { emptyVehicle: { massKg: unit.massKg, longitudinalMm: 0, lateralMm: 0 } } : {}),
            compartmentCentroids: { [created.id]: { longitudinalMm: 0, lateralMm: 0 } },
          },
        },
      });
    }
    // Put in service: the operator's declaration is the statement that this unit works in this
    // region. Conditional, so a held or retired unit is never re-activated by a redeploy.
    await tx.agent.updateMany({
      where: { id: unit.agent.id, lifecycleState: { in: ["COMMISSIONED", "ACTIVE"] } },
      data: { regionId: region.id, lifecycleState: "ACTIVE" },
    });
    await tx.agentClass.update({
      where: { id: agentClass.id },
      data: {
        firmwareVersionSet: Object.fromEntries(declared.control.missionTypes.map((type) => [type, [declared.control.firmwareVersion]])),
        hardwareRevision: declared.control.hardwareRevision,
      },
    });
  });

  return { robotId: declared.robotId, agentRowId: unit.agent.id, coefficients, provenance: physicalPolicy.PROVENANCE, policyDeclaredBy: policy && policy.declaredBy };
}

/**
 * Apply every robot in the declaration. One robot's failure is reported, never fatal to the rest.
 */
async function applyDeclaration(prisma, policy, { logger } = {}) {
  const results = [];
  for (const declared of policy.robots.values()) {
    try {
      results.push({ ok: true, ...(await applyRobotDeclaration(prisma, declared, policy)) });
    } catch (error) {
      results.push({ ok: false, robotId: declared.robotId, code: error && error.code, message: error && error.message });
      logger?.warn?.("physical declaration not applied", { robotId: declared.robotId, message: error && error.message });
    }
  }
  return results;
}

/**
 * Record an operator-declared state of charge (owner decision 2026-10-03: the rover has no
 * battery ADC). Written to `BatteryState.lastObservedSoc` — update-only, so a unit whose
 * declaration was never applied is refused — and to the Observation log as OPERATOR_ENTERED.
 * Its age is bounded by the availability policy, not here.
 *
 * @param {object} prisma
 * @param {{ robotId: string, socPct: number, enteredBy: string, at?: Date }} input
 */
async function declareStateOfCharge(prisma, input) {
  const { robotId, socPct, enteredBy } = input || {};
  const at = input && input.at instanceof Date ? input.at : new Date();
  if (!isNumber(socPct) || socPct < 0 || socPct > 100) {
    throw Object.assign(new PhysicalDeclarationError("INVALID", "socPct must be a number from 0 to 100"), { status: 400 });
  }
  const unit = await loadPhysicalUnit(prisma, robotId);
  const fraction = socPct / 100;
  const written = await prisma.batteryState.updateMany({
    where: { agentId: unit.agent.id },
    data: { lastObservedSoc: fraction, lastObservedAt: at },
  });
  if (!written || written.count !== 1) {
    throw new PhysicalDeclarationError(
      "NOT_DECLARED",
      `robot "${robotId}" has no BatteryState: apply its physical fleet declaration before declaring a state of charge`,
    );
  }
  await prisma.observation.create({
    data: {
      agentId: unit.agent.id,
      kind: "soc",
      value: { socPct, fraction, enteredBy: enteredBy || null, provenance: "PHYSICAL", method: physicalPolicy.POLICY.OPERATOR_DECLARED },
      observedAt: at,
      source: observation.OBSERVATION_SOURCE.OPERATOR_ENTERED,
    },
  });
  return { robotId, socPct, observedAt: at.toISOString() };
}

module.exports = {
  PhysicalDeclarationError,
  declaredEnergyCoefficients,
  surfaceClassesFor,
  applyRobotDeclaration,
  applyDeclaration,
  declareStateOfCharge,
};
