"use strict";

/**
 * The **physical fleet declaration**: every value the physical provider uses that no rover
 * sensor measures, in one owner-authored file.
 *
 * The physical RobotX has no battery ADC, no hardware e-stop, no temperature sensor, no
 * elevation source and no fitted energy model. The owner decided (2026-10-03) that each is
 * supplied by an explicit declaration rather than left absent:
 *
 *   stateOfCharge   OPERATOR_DECLARED: an operator enters SoC; it expires after maxAgeSeconds
 *   emergencyStop   SOFTWARE_STOP_LATCH: the Pi-reported stop-latch state satisfies F7. It is
 *                   labelled so it is never mistaken for a hardware e-stop circuit
 *   site.ambientC   a declared worst-case ambient range; the pack is taken at the worst case
 *   robots[].energy β derived from the commissioned pack and an operator-declared power draw,
 *                   never fitted (fittedAt null), so the uncalibrated reserve factor applies
 *
 * plus the declarations those depend on (charging, terrain, link, constrictions, localisation
 * mapping, risk prior). Every value here is PRODUCTION_DECLARED: owned, recorded, not
 * measured. A section that is absent or invalid turns its policy OFF, and the predicate that
 * needs it keeps denying by name, which is exactly the behaviour before this file existed.
 *
 * Nothing here is a simulator value, and this module imports nothing from `src/simulation/`.
 */

const fs = require("fs");
const path = require("path");

/** Opts a process into the physical fleet, independent of the simulator. @structural */
const ENABLE_VAR = "PHYSICAL_FLEET_ENABLED";
/** Path of the owner's declaration file. @structural */
const FILE_VAR = "PHYSICAL_FLEET_DECLARATION_FILE";

/** The provenance every declared value carries. @structural */
const PROVENANCE = "PRODUCTION_DECLARED";

/** @structural the policy names the owner chose; any other value turns the policy off */
const POLICY = Object.freeze({
  MANUAL_OUT_OF_SERVICE: "MANUAL_OUT_OF_SERVICE",
  OPERATOR_DECLARED: "OPERATOR_DECLARED",
  SOFTWARE_STOP_LATCH: "SOFTWARE_STOP_LATCH",
  FLAT_DECLARED: "FLAT_DECLARED",
  NONE_DECLARED: "NONE_DECLARED",
});

/** @structural the backend's fix vocabulary (positionObservation.FIX_TYPES) */
const KNOWN_FIX_TYPES = Object.freeze(["2D", "3D", "RTK_FLOAT", "RTK_FIXED"]);

const isNumber = (value) => typeof value === "number" && Number.isFinite(value);
const isString = (value) => typeof value === "string" && value.trim() !== "";

/** Is the physical fleet selected for this process? */
function isEnabled(env) {
  return String(((env || process.env)[ENABLE_VAR]) || "").trim().toLowerCase() === "true";
}

/**
 * Validate a robot's declaration. Returns the normalised record and its problems; a robot
 * with problems is declared with nothing (its facts stay absent).
 */
function normaliseRobot(raw) {
  const problems = [];
  const source = raw || {};
  if (!isString(source.robotId)) problems.push("robotId is required");

  const control = source.control || {};
  if (!isString(control.firmwareVersion)) problems.push("control.firmwareVersion is required (the Pi RobotAgent version the operator attests)");
  if (!isString(control.hardwareRevision)) problems.push("control.hardwareRevision is required");
  const missionTypes = Array.isArray(control.missionTypes) && control.missionTypes.every(isString) ? control.missionTypes : null;
  if (!missionTypes || missionTypes.length === 0) problems.push("control.missionTypes must list the mission types the firmware supports");
  const calibrations = Array.isArray(control.calibrations) ? control.calibrations : null;
  if (!calibrations) problems.push("control.calibrations must be a list (empty when the unit carries none)");
  else {
    for (const [i, row] of calibrations.entries()) {
      if (!row || !isString(row.kind) || !isString(row.validUntil) || Number.isNaN(Date.parse(row.validUntil))) {
        problems.push(`control.calibrations[${i}] needs kind and an ISO validUntil`);
      }
    }
  }
  if (!isString(control.serviceDueAt) || Number.isNaN(Date.parse(control.serviceDueAt))) {
    problems.push("control.serviceDueAt is required (ISO date the maintenance interval ends)");
  }
  if (!isString(control.regionId)) problems.push("control.regionId is required (the Region.regionId the unit is in service in)");
  if (control.authorisation !== "REGION") problems.push('control.authorisation must be "REGION" (authorised throughout its commissioned region)');
  if (!Array.isArray(control.advisories)) problems.push("control.advisories must be a list (empty when none are outstanding)");
  const operating = control.operatingAmbientC || {};
  if (!isNumber(operating.min) || !isNumber(operating.max) || operating.min > operating.max) {
    problems.push("control.operatingAmbientC needs numeric min <= max (the unit's own rated ambient range)");
  }

  const energy = source.energy || {};
  if (!isNumber(energy.idlePowerW) || energy.idlePowerW < 0) problems.push("energy.idlePowerW must be a non-negative number of watts");
  if (!isNumber(energy.movingPowerW) || energy.movingPowerW <= 0) problems.push("energy.movingPowerW must be a positive number of watts");
  if (isNumber(energy.idlePowerW) && isNumber(energy.movingPowerW) && energy.movingPowerW < energy.idlePowerW) {
    problems.push("energy.movingPowerW must not be below energy.idlePowerW");
  }
  if (!isNumber(energy.soh) || energy.soh <= 0 || energy.soh > 1) problems.push("energy.soh must be in (0, 1]");
  if (!isNumber(energy.residualCv) || energy.residualCv <= 0) problems.push("energy.residualCv must be a positive number");
  if (!isNumber(energy.reserveFloorWh) || energy.reserveFloorWh < 0) problems.push("energy.reserveFloorWh must be a non-negative number of Wh");

  if (problems.length > 0) return { robot: null, problems };
  return {
    robot: Object.freeze({
      robotId: source.robotId,
      control: Object.freeze({
        firmwareVersion: control.firmwareVersion,
        hardwareRevision: control.hardwareRevision,
        missionTypes: Object.freeze([...missionTypes]),
        calibrations: Object.freeze(calibrations.map((row) => Object.freeze({ kind: row.kind, validUntil: row.validUntil }))),
        serviceDueAt: control.serviceDueAt,
        regionId: control.regionId,
        authorisation: control.authorisation,
        advisories: Object.freeze([...control.advisories]),
        operatingAmbientC: Object.freeze({ min: operating.min, max: operating.max }),
      }),
      energy: Object.freeze({
        idlePowerW: energy.idlePowerW,
        movingPowerW: energy.movingPowerW,
        soh: energy.soh,
        residualCv: energy.residualCv,
        reserveFloorWh: energy.reserveFloorWh,
      }),
    }),
    problems: [],
  };
}

/**
 * Validate the whole declaration. Pure: the caller supplies the parsed JSON.
 *
 * @param {object} raw
 * @returns {object} the frozen policy, with `problems` naming every section that is off
 */
function fromDeclaration(raw) {
  const source = raw || {};
  const problems = [];

  const charging = source.charging && source.charging.policy === POLICY.MANUAL_OUT_OF_SERVICE ? POLICY.MANUAL_OUT_OF_SERVICE : null;
  if (!charging) problems.push('charging.policy is not "MANUAL_OUT_OF_SERVICE": no physical robot is indexed');

  const soc = source.stateOfCharge || {};
  const socPolicy =
    soc.policy === POLICY.OPERATOR_DECLARED && isNumber(soc.maxAgeSeconds) && soc.maxAgeSeconds > 0
      ? Object.freeze({ policy: POLICY.OPERATOR_DECLARED, maxAgeSeconds: soc.maxAgeSeconds })
      : null;
  if (!socPolicy) problems.push('stateOfCharge needs policy "OPERATOR_DECLARED" and a positive maxAgeSeconds');

  const estop = source.emergencyStop && source.emergencyStop.mechanism === POLICY.SOFTWARE_STOP_LATCH ? POLICY.SOFTWARE_STOP_LATCH : null;
  if (!estop) problems.push('emergencyStop.mechanism is not "SOFTWARE_STOP_LATCH": F7 denies every physical robot');

  const site = source.site || {};
  const ambient = site.ambientC || {};
  const ambientC = isNumber(ambient.min) && isNumber(ambient.max) && ambient.min <= ambient.max
    ? Object.freeze({ min: ambient.min, max: ambient.max })
    : null;
  if (!ambientC) problems.push("site.ambientC needs numeric min <= max");
  const terrain = site.terrain === POLICY.FLAT_DECLARED ? POLICY.FLAT_DECLARED : null;
  if (!terrain) problems.push('site.terrain is not "FLAT_DECLARED": physical routes are refused NO_TERRAIN_SOURCE');
  const deadZones = site.connectivityDeadZones === POLICY.NONE_DECLARED ? POLICY.NONE_DECLARED : null;
  if (!deadZones) problems.push('site.connectivityDeadZones is not "NONE_DECLARED"');
  const constrictions = site.constrictions === POLICY.NONE_DECLARED ? POLICY.NONE_DECLARED : null;
  if (!constrictions) problems.push('site.constrictions is not "NONE_DECLARED"');
  const stopStartCyclesPerHop = Number.isInteger(site.stopStartCyclesPerHop) && site.stopStartCyclesPerHop >= 0
    ? site.stopStartCyclesPerHop
    : null;
  if (stopStartCyclesPerHop === null) problems.push("site.stopStartCyclesPerHop must be a non-negative integer");

  const loc = source.localisation || {};
  const localisation =
    isNumber(loc.referenceRadiusM) && loc.referenceRadiusM > 0 &&
    Array.isArray(loc.acceptedFixTypes) && loc.acceptedFixTypes.length > 0 &&
    loc.acceptedFixTypes.every((type) => KNOWN_FIX_TYPES.includes(type))
      ? Object.freeze({ referenceRadiusM: loc.referenceRadiusM, acceptedFixTypes: Object.freeze([...loc.acceptedFixTypes]) })
      : null;
  if (!localisation) problems.push(`localisation needs referenceRadiusM > 0 and acceptedFixTypes from ${KNOWN_FIX_TYPES.join(", ")}`);

  const risk = source.risk || {};
  const failureProbabilityPrior = isNumber(risk.failureProbabilityPrior) && risk.failureProbabilityPrior >= 0 && risk.failureProbabilityPrior <= 1
    ? risk.failureProbabilityPrior
    : null;
  if (failureProbabilityPrior === null) problems.push("risk.failureProbabilityPrior must be in [0, 1]");
  const routeHazardCu = isNumber(risk.routeHazardCu) && risk.routeHazardCu >= 0 ? risk.routeHazardCu : null;
  if (routeHazardCu === null) problems.push("risk.routeHazardCu must be a non-negative number");

  const robots = new Map();
  for (const entry of Array.isArray(source.robots) ? source.robots : []) {
    const normalised = normaliseRobot(entry);
    if (normalised.robot) robots.set(normalised.robot.robotId, normalised.robot);
    else problems.push(`robots[${entry && entry.robotId}]: ${normalised.problems.join("; ")}`);
  }

  return Object.freeze({
    provenance: PROVENANCE,
    declaredBy: isString(source.declaredBy) ? source.declaredBy : null,
    declaredAt: isString(source.declaredAt) ? source.declaredAt : null,
    charging,
    stateOfCharge: socPolicy,
    emergencyStop: estop,
    site: Object.freeze({ ambientC, terrain, connectivityDeadZones: deadZones, constrictions, stopStartCyclesPerHop }),
    localisation,
    risk: Object.freeze({ failureProbabilityPrior, routeHazardCu }),
    robots,
    robotFor: (robotId) => robots.get(robotId) || null,
    problems: Object.freeze(problems),
  });
}

/** The policy a process with no declaration has: every section off. */
const NONE = fromDeclaration({});

/**
 * Load the declaration named by the environment. A missing or unreadable file is every
 * section off, with the reason recorded, never an exception at boot.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {object}
 */
function load(env) {
  const source = env || process.env;
  const file = source[FILE_VAR];
  if (!isString(file)) return Object.freeze({ ...NONE, problems: Object.freeze([`${FILE_VAR} is not set`, ...NONE.problems]) });
  try {
    const raw = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
    return fromDeclaration(raw);
  } catch (error) {
    return Object.freeze({ ...NONE, problems: Object.freeze([`${file} could not be read: ${error && error.message}`, ...NONE.problems]) });
  }
}

module.exports = {
  ENABLE_VAR,
  FILE_VAR,
  PROVENANCE,
  POLICY,
  KNOWN_FIX_TYPES,
  NONE,
  isEnabled,
  fromDeclaration,
  load,
};
