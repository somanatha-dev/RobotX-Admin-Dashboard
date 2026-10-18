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

/**
 * @structural the lifecycle states (§2.1) this module reads by name. The release-into-service
 * write below keeps its own literal list: `robotRecommission.test.js` pins that literal as the
 * only place a runtime module puts an existing Agent in service.
 */
const ACTIVE = "ACTIVE";
const RETIRED = "DECOMMISSIONED";
const ACTIVATABLE = Object.freeze(["COMMISSIONED", ACTIVE]);

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
 * The result states the lifecycle the unit is in once the write has committed, and whether it is
 * in service (`activated`). A held or retired unit has its declared rows written but is never
 * re-activated, and the result says so rather than reporting the write alone as success.
 *
 * @param {object} prisma
 * @param {object} declared one `policy.robotFor(robotId)` entry
 * @param {{ site: object }} policy the loaded physical policy (its site ambient bounds the derating curve)
 * @param {{ audit?: (tx: object, change: { robotRowId: string, before: string|null, after: string|null }) => Promise<void> }} [options]
 *   `audit` runs inside the same transaction, after the lifecycle write
 */
async function applyRobotDeclaration(prisma, declared, policy, options) {
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

  const audit = options && typeof options.audit === "function" ? options.audit : null;
  const lifecycle = await prisma.$transaction(async (tx) => {
    const before = await tx.agent.findUnique({ where: { id: unit.agent.id }, select: { lifecycleState: true } });
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
    const after = await tx.agent.findUnique({ where: { id: unit.agent.id }, select: { lifecycleState: true } });
    const change = {
      robotRowId: unit.id,
      before: before ? before.lifecycleState : null,
      after: after ? after.lifecycleState : null,
    };
    if (audit) await audit(tx, change);
    return change;
  });

  return {
    robotId: declared.robotId,
    agentRowId: unit.agent.id,
    lifecycleBefore: lifecycle.before,
    lifecycleState: lifecycle.after,
    activated: lifecycle.after === ACTIVE,
    coefficients,
    provenance: physicalPolicy.PROVENANCE,
    policyDeclaredBy: policy && policy.declaredBy,
  };
}

/**
 * Apply every robot in the declaration. One robot's failure is reported, never fatal to the rest.
 * A unit whose rows were written but which stays out of service (held or retired) is reported
 * `ok: true, activated: false` with its lifecycle, so the boot log does not read as "in service".
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

/** @structural the refusals `activateDeclaredRobot` answers with */
const ACTIVATION_REFUSAL = Object.freeze({
  INVALID_REQUEST: "INVALID_REQUEST",
  PHYSICAL_FLEET_DISABLED: "PHYSICAL_FLEET_DISABLED",
  NOT_DECLARED: "NOT_DECLARED",
  ROBOT_NOT_FOUND: "ROBOT_NOT_FOUND",
  NOT_PHYSICAL: "NOT_PHYSICAL",
  ROBOT_RETIRED: "ROBOT_RETIRED",
  LIFECYCLE_HELD: "LIFECYCLE_HELD",
  NOT_APPLIED: "NOT_APPLIED",
});

/** @structural the fields an activation request may carry */
const ACTIVATION_FIELDS = Object.freeze(["reason", "confirmRobotId"]);
/** @structural the audit reason's length bound, as recommissioning's */
const MAX_REASON_LENGTH = 500;

class DeclarationActivationRefused extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.name = "DeclarationActivationRefused";
    this.status = status;
    this.code = code;
    this.extra = extra && typeof extra === "object" ? extra : {};
  }

  toBody() {
    const error = { 400: "Bad Request", 404: "Not Found", 409: "Conflict" }[this.status] || "Error";
    return { ok: false, error, code: this.code, refusal: this.code, message: this.message, ...this.extra };
  }
}

function validateActivationRequest(robotId, body) {
  const source = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const invalid = (message) => new DeclarationActivationRefused(400, ACTIVATION_REFUSAL.INVALID_REQUEST, message);
  if (typeof robotId !== "string" || robotId.trim() === "") throw invalid("robotId is required");
  const unknown = Object.keys(source).filter((key) => !ACTIVATION_FIELDS.includes(key));
  if (unknown.length > 0) {
    throw invalid(
      `Applying a declaration accepts only ${ACTIVATION_FIELDS.join(" and ")}; refused: ${unknown.join(", ")}. ` +
        "Every declared value comes from the loaded physical fleet declaration, never from a request.",
    );
  }
  const confirm = typeof source.confirmRobotId === "string" ? source.confirmRobotId.trim() : "";
  if (confirm !== robotId) {
    throw invalid(`confirmRobotId must repeat the robot id exactly ("${robotId}") to confirm which unit is put in service.`);
  }
  const reason = typeof source.reason === "string" ? source.reason.trim() : "";
  if (!reason) throw invalid("A reason is required to put a physical unit in service; it is recorded in the audit trail.");
  if (reason.length > MAX_REASON_LENGTH) throw invalid(`The reason must be at most ${MAX_REASON_LENGTH} characters.`);
  return reason;
}

/**
 * Put ONE declared physical unit in service from the declaration this process already loaded —
 * the same write the boot applies (`applyRobotDeclaration`), without a restart.
 *
 * Why it exists: the declaration is applied at boot only, so a unit commissioned after the boot
 * (its Robot row did not exist yet) or recommissioned after it (it returns COMMISSIONED) stayed
 * out of service until the next restart of the production backend. This is the explicit,
 * operator-authorised path for those two cases. It adds no authority the boot does not already
 * exercise, and it is narrower:
 *
 *   · only a unit the loaded declaration names, with no problems (the file is not re-read: what a
 *     request can put in service is exactly what the process was started with);
 *   · only a PHYSICAL unit (`Robot.simulated`, through `positionObservation.provenanceOf`);
 *   · only from COMMISSIONED or ACTIVE — a retired unit is refused (recommission it first), and a
 *     QUARANTINED or MAINTENANCE unit is refused by name rather than silently left as it is;
 *   · a reason and a typed confirmation, recorded as an Event in the same transaction.
 *
 * It makes the unit ACTIVE and nothing more. Discovery still needs the index's own conditions (a
 * measured position, a fresh operator SoC declaration, a shard), and every §7.5 predicate —
 * fresh localisation, stop latch, readiness, energy, route containment — is still decided per
 * round. Active is not assignable.
 *
 * @param {object} prisma
 * @param {string} robotId
 * @param {object} body `{ reason, confirmRobotId }`
 * @param {{ policy: object|null, actorId?: string|null }} context `policy` is `app.locals.physicalFleetPolicy`
 */
async function activateDeclaredRobot(prisma, robotId, body, context) {
  const code = typeof robotId === "string" ? robotId.trim() : "";
  const reason = validateActivationRequest(code, body);
  const policy = context && context.policy;
  const actorId = context && typeof context.actorId === "string" ? context.actorId : null;

  if (!policy || typeof policy.robotFor !== "function") {
    throw new DeclarationActivationRefused(
      409,
      ACTIVATION_REFUSAL.PHYSICAL_FLEET_DISABLED,
      "The physical fleet is not enabled in this backend (PHYSICAL_FLEET_ENABLED), so no physical unit can be put in service.",
    );
  }
  const declared = policy.robotFor(code);
  if (!declared) {
    const problems = typeof policy.problemsFor === "function" ? [...policy.problemsFor(code)] : [];
    throw new DeclarationActivationRefused(
      409,
      ACTIVATION_REFUSAL.NOT_DECLARED,
      problems.length > 0
        ? `Unit ${code} is named in the physical fleet declaration but its entry is invalid: ${problems.join("; ")}`
        : `Unit ${code} is not in the physical fleet declaration this backend loaded. Add it to the file and restart the backend.`,
      { problems },
    );
  }

  const robot = await prisma.robot.findUnique({
    where: { robotId: code },
    select: { id: true, agent: { select: { id: true, lifecycleState: true } } },
  });
  if (!robot || !robot.agent) {
    throw new DeclarationActivationRefused(404, ACTIVATION_REFUSAL.ROBOT_NOT_FOUND, `No commissioned robot "${code}" with an engine Agent.`);
  }
  if ((await positionObservation.provenanceOf(prisma, code)) !== "PHYSICAL") {
    throw new DeclarationActivationRefused(409, ACTIVATION_REFUSAL.NOT_PHYSICAL, `Unit ${code} is not a physical unit.`);
  }
  const current = robot.agent.lifecycleState;
  if (current === RETIRED) {
    throw new DeclarationActivationRefused(
      409,
      ACTIVATION_REFUSAL.ROBOT_RETIRED,
      `Unit ${code} is retired. Recommission it first (POST /api/robots/${code}/recommission).`,
      { lifecycleState: current },
    );
  }
  if (!ACTIVATABLE.includes(current)) {
    throw new DeclarationActivationRefused(
      409,
      ACTIVATION_REFUSAL.LIFECYCLE_HELD,
      `Unit ${code} is ${current}; only a COMMISSIONED or ACTIVE unit is put in service by its declaration.`,
      { lifecycleState: current },
    );
  }

  let result;
  try {
    result = await applyRobotDeclaration(prisma, declared, policy, {
      audit: (tx, change) =>
        tx.event.create({
          data: {
            robotId: change.robotRowId,
            type: "INFO",
            message:
              `Unit ${code}: physical fleet declaration applied (lifecycle ${change.before} -> ${change.after})` +
              (actorId ? ` by ${actorId}` : "") +
              `: ${reason}. In service is not assignable: position, SoC, readiness and every safety gate are still required.`,
          },
        }),
    });
  } catch (error) {
    if (error instanceof PhysicalDeclarationError) {
      throw new DeclarationActivationRefused(error.status === 404 ? 404 : 409, error.code || ACTIVATION_REFUSAL.NOT_APPLIED, error.message);
    }
    throw error;
  }
  if (!result.activated) {
    // A retirement or hold committed between the check above and the conditional write.
    throw new DeclarationActivationRefused(
      409,
      ACTIVATION_REFUSAL.NOT_APPLIED,
      `Unit ${code} was not put in service: its lifecycle is now ${result.lifecycleState}.`,
      { lifecycleState: result.lifecycleState },
    );
  }
  return {
    robotId: code,
    lifecycleBefore: result.lifecycleBefore,
    lifecycleState: result.lifecycleState,
    activated: true,
    alreadyActive: result.lifecycleBefore === ACTIVE,
  };
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
  DeclarationActivationRefused,
  ACTIVATION_REFUSAL,
  activateDeclaredRobot,
  declaredEnergyCoefficients,
  surfaceClassesFor,
  applyRobotDeclaration,
  applyDeclaration,
  declareStateOfCharge,
};
