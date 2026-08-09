"use strict";

/**
 * **F5 — Software/firmware version is in the supported set for this mission type.**
 * Class I. Indeterminate: `DENY`.
 *
 * > An agent whose firmware cannot parse or safely execute a mission type must never
 * > receive it; version skew is a real and frequent cause of field incidents.
 *
 * ── Per mission type, not per agent ─────────────────────────────────────────
 * The supported set is indexed by mission type because that is what §7.5 says and
 * because a single "minimum firmware" scalar cannot express the real constraint: a
 * build may be perfectly sound for ordinary deliveries and unfit for cold-chain or
 * hazmat work, and a scalar forces the fleet to the strictest mission's floor or
 * admits the riskiest one.
 *
 * The set comes from `AgentClass.firmwareVersionSet` (§2.1), which is control-plane
 * data, not an agent self-report. §23.5's asymmetric-trust rule applies with force
 * here: an agent claiming a firmware version it does not run is the exact scenario
 * this predicate is supposed to catch, so a version arriving through telemetry is
 * `INDETERMINATE` rather than an input.
 *
 * ── Exact membership, not ordering ──────────────────────────────────────────
 * Membership of an enumerated set, never a `>=` comparison on a version string.
 * Version strings do not order lexicographically (`1.10.0 < 1.9.0` as text), and a
 * newer build is not automatically supported: qualification is an act, and the set is
 * its record.
 *
 * Tier 0 (T0-01).
 */

const tv = require("../threeValued");

const REQUIRED = "membership of the supported firmware set for this mission type";

/**
 * @param {object} context `{ agentSnapshot, mission, plan, config }`
 * @returns {object} a `threeValued` predicate result
 */
function evaluate(context) {
  const agent = (context && context.agentSnapshot) || null;
  const mission = (context && context.mission) || null;

  if (!agent) return tv.absent("the agent snapshot", { required: REQUIRED });
  if (!mission) return tv.absent("the mission", { required: REQUIRED });

  const missionType = mission.missionType === undefined ? mission.missionClass : mission.missionType;
  if (missionType === undefined || missionType === null) {
    return tv.absent("the mission type", { required: REQUIRED, inputSource: "CONTROL_PLANE" });
  }

  const version = agent.firmwareVersion;
  if (version === undefined || version === null) {
    return tv.absent("the agent's attested firmware version", {
      required: REQUIRED,
      inputSource: "CONTROL_PLANE",
    });
  }

  if (agent.firmwareVersionSource !== undefined && agent.firmwareVersionSource === "AGENT_REPORT") {
    return tv.indeterminate({
      observed: { firmwareVersion: version, source: "AGENT_REPORT" },
      required: REQUIRED,
      inputSource: "AGENT_REPORT",
      reason:
        "the firmware version arrived as an agent self-report. Version skew is what this predicate " +
        "exists to catch, and an agent misreporting its own build is that failure exactly; the " +
        "attested value comes from the commissioning record and the firmware attestation (§23.5)",
    });
  }

  const supportedByType = agent.supportedFirmwareByMissionType;
  if (supportedByType === undefined || supportedByType === null || typeof supportedByType !== "object") {
    return tv.absent("the agent class's firmwareVersionSet", {
      observed: { firmwareVersion: version },
      required: REQUIRED,
      inputSource: "CONTROL_PLANE",
    });
  }

  const supported = supportedByType[missionType];
  if (supported === undefined || supported === null) {
    return tv.indeterminate({
      observed: { firmwareVersion: version, missionType },
      required: REQUIRED,
      inputSource: "CONTROL_PLANE",
      reason:
        `the agent class declares no supported firmware set for mission type "${missionType}". ` +
        "An unlisted mission type is not an unrestricted one: qualification is an act, and its " +
        "absence is the absence of the act",
    });
  }

  if (!Array.isArray(supported)) {
    return tv.indeterminate({
      observed: { firmwareVersion: version, missionType },
      required: REQUIRED,
      inputSource: "CONTROL_PLANE",
      reason: "the supported firmware set is not an enumerated list; membership cannot be evaluated",
    });
  }

  if (!supported.includes(version)) {
    return tv.violated({
      observed: { firmwareVersion: version, missionType },
      required: { supported },
      inputSource: "CONTROL_PLANE",
      reason:
        `firmware "${version}" is not in the supported set for mission type "${missionType}" ` +
        "(§7.5 F5). Membership is exact: a newer build is not automatically qualified",
    });
  }

  return tv.satisfied({
    observed: { firmwareVersion: version, missionType },
    required: { supported },
    inputSource: "CONTROL_PLANE",
  });
}

module.exports = { evaluate };
