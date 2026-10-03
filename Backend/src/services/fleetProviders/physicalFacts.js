"use strict";

/**
 * The **control-plane half of §7.5's agent facts for a physical robot** — the twelve facts
 * `agentFacts.PHYSICAL_CONTROL_PLANE_FACTS` lists — from the owner's declaration and the
 * robot's own live evidence. Never from the simulator.
 *
 *   F1  commissioning        the robot appears in the physical fleet declaration
 *   F3  operatorHold         `Robot.status` PAUSED (an operator STOP, or the unit itself)
 *   F5  firmwareVersion      the version the operator attests in the declaration (COMMISSIONING)
 *   F6  calibrations         declared, each with its validUntil
 *   F7  emergencyStop        the Pi-reported SOFTWARE_STOP_LATCH state, only when the owner's
 *                            declaration admits that mechanism; carries `mechanism` so it is
 *                            never read as a hardware e-stop circuit
 *   F8  faults               `Robot.status` ERROR → BLOCKING, ISSUES → DEGRADED (ROBOT_FAULT
 *                            forces ERROR), exactly the mapping the status already encodes
 *   F10 localisation         confidence from the latest fix's declared quality; corroborated by
 *                            MAP_MATCH (distance from the fix to the nearest permitted way)
 *   F11 reliability          left absent: F11 admits with the cohort-prior penalty
 *   F12 advisories           declared
 *   F14 session ack          the PROBE round trip (already derived by agentFacts.service)
 *   F15 linkQuality          the measured PROBE answer ratio
 *   F27 authorisedZoneIds    REGION: every zone of the agent's region
 *   F36 maintenance          declared serviceDueAt
 *
 * A robot with no declaration gets none of these, and every predicate keeps denying by name.
 */

const { getRobotState } = require("../robotRegistry.service");
const physicalPolicy = require("./physicalPolicy");

/** The provenance stamped on a declared physical robot's facts. @structural */
const PROVENANCE = "PHYSICAL_DECLARED";

const isNumber = (value) => typeof value === "number" && Number.isFinite(value);

/** @structural the status → fault mapping F8 reads, the same one the status already means */
const FAULT_BY_STATUS = Object.freeze({
  ERROR: Object.freeze({ code: "ROBOT_STATUS_ERROR", severity: "BLOCKING" }),
  ISSUES: Object.freeze({ code: "ROBOT_STATUS_ISSUES", severity: "DEGRADED" }),
});

/**
 * F10's input from the latest position Observation. Confidence is the declared mapping
 * `1 − hAcc / referenceRadius`, clamped to [0, 1]; a dead-reckoned fix, a fix with no
 * accuracy, or a fix type outside the declared set yields no localisation at all.
 */
function localisationFrom({ fix, policy, divergenceM }) {
  const declared = policy && policy.localisation;
  if (!declared || !fix) return undefined;
  if (fix.deadReckoned === true) return undefined;
  const fixType = fix.value && fix.value.fixType;
  if (!declared.acceptedFixTypes.includes(fixType)) return undefined;
  if (!isNumber(fix.uncertaintyRadiusM) || fix.uncertaintyRadiusM <= 0) return undefined;
  const confidence = Math.max(0, Math.min(1, 1 - fix.uncertaintyRadiusM / declared.referenceRadiusM));
  return {
    confidence,
    corroborations: [
      isNumber(divergenceM)
        ? { kind: "MAP_MATCH", available: true, divergenceM }
        : { kind: "MAP_MATCH", available: false },
    ],
    basis: { fixType, hAccM: fix.uncertaintyRadiusM, referenceRadiusM: declared.referenceRadiusM },
    provenance: physicalPolicy.PROVENANCE,
  };
}

/**
 * F7's input from the live stop-latch report, only under the SOFTWARE_STOP_LATCH policy.
 */
function emergencyStopFrom({ live, policy, asOfMs }) {
  if (!policy || policy.emergencyStop !== physicalPolicy.POLICY.SOFTWARE_STOP_LATCH) return undefined;
  const latch = live && live.stopLatch;
  if (!latch || typeof latch.engaged !== "boolean" || !isNumber(latch.observedAtMs)) return undefined;
  if (isNumber(asOfMs) && latch.observedAtMs > asOfMs) return undefined;
  return {
    value: latch.engaged,
    observedAt: new Date(latch.observedAtMs),
    source: "AGENT_REPORT",
    mechanism: physicalPolicy.POLICY.SOFTWARE_STOP_LATCH,
  };
}

/**
 * @param {object} input
 * @param {object} input.prisma
 * @param {object} [input.kv]
 * @param {object} input.policy the loaded physical policy
 * @param {object} [input.router] the physical router (for MAP_MATCH)
 * @param {object} input.agent the Agent row with `robot` and `agentClass`
 * @param {number} [input.asOfMs]
 * @param {object} [input.placement] `{ agentId, shardId, regionId }` already read by the caller
 * @returns {Promise<object|null>} the control-plane facts, or null when the robot is undeclared
 */
async function controlFactsFor(input) {
  const { prisma, kv, policy, router, agent, asOfMs } = input || {};
  const robot = agent && agent.robot;
  if (!robot || !policy || typeof policy.robotFor !== "function") return null;
  const declared = policy.robotFor(robot.robotId);
  if (!declared) return null;

  const asOf = isNumber(asOfMs) ? new Date(asOfMs) : null;

  let regionId = agent.regionId || null;
  if (!regionId) {
    const placement = input.placement;
    if (placement && placement.agentId === agent.id && typeof placement.shardId === "string") {
      regionId = placement.regionId ?? null;
    } else {
      const mirror = await prisma.agentCellPosition.findUnique({ where: { agentId: agent.id }, select: { shardId: true } });
      const shard = mirror ? await prisma.shard.findUnique({ where: { shardId: mirror.shardId }, select: { regionId: true } }) : null;
      regionId = shard ? shard.regionId : null;
    }
  }

  const [zones, fix, live] = await Promise.all([
    regionId ? prisma.zone.findMany({ where: { regionId }, select: { id: true } }) : [],
    prisma.observation.findFirst({
      where: { agentId: agent.id, kind: "position", ...(asOf ? { observedAt: { lte: asOf } } : {}) },
      orderBy: { observedAt: "desc" },
    }),
    kv ? getRobotState(kv, robot.robotId).catch(() => null) : null,
  ]);

  const permissionSet = agent.agentClass && agent.agentClass.mobilityModel ? agent.agentClass.mobilityModel.permissionSet : null;
  const point = fix && fix.value && isNumber(fix.value.lat) && isNumber(fix.value.lon) ? { lat: fix.value.lat, lon: fix.value.lon } : null;
  const divergenceM = router && point ? router.mapMatchDivergenceM(point, permissionSet) : null;

  const fault = FAULT_BY_STATUS[robot.status];
  const probed = live && isNumber(Number(live.lastProbeAckAt)) && live.lastProbeSocketId && live.lastProbeSocketId === robot.socketId;
  const linkQuality = probed && isNumber(live.linkQuality) ? live.linkQuality : undefined;

  const facts = {
    commissioning: { commissioned: true, recordId: `${physicalPolicy.PROVENANCE}:${robot.robotId}:${policy.declaredAt || "undated"}` },
    operatorHold:
      robot.status === "PAUSED"
        ? { held: true, reason: "the unit is stopped (Robot.status PAUSED): an operator STOP or the unit's own report", by: "ROBOT_STATUS" }
        : { held: false },
    firmwareVersion: declared.control.firmwareVersion,
    firmwareVersionSource: "COMMISSIONING",
    calibrations: declared.control.calibrations.map((row) => ({ name: row.kind, validUntil: row.validUntil })),
    emergencyStop: emergencyStopFrom({ live, policy, asOfMs }),
    faults: fault ? [{ ...fault, active: true, provenance: "PHYSICAL" }] : [],
    localisation: localisationFrom({ fix, policy, divergenceM }),
    advisories: [...declared.control.advisories],
    authorisedZoneIds: declared.control.authorisation === "REGION" && zones.length > 0 ? zones.map((zone) => zone.id).sort() : undefined,
    maintenance: { serviceDueAt: new Date(declared.control.serviceDueAt), provenance: physicalPolicy.PROVENANCE },
    sessionOverlay: linkQuality === undefined ? {} : { linkQuality },
  };
  for (const key of Object.keys(facts)) if (facts[key] === undefined) delete facts[key];
  return facts;
}

module.exports = {
  PROVENANCE,
  FAULT_BY_STATUS,
  localisationFrom,
  emergencyStopFrom,
  controlFactsFor,
};
