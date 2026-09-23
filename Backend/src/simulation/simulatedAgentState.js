"use strict";

/**
 * **SimulatedAgentState** — the DEVELOPMENT_SIMULATION provider of the agent facts §7.5
 * reads, for simulated units only. V1 demonstration.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * Ten §7.5 inputs (F1 commissioning, F3 operator hold, F5 firmware, F6 calibrations, F7
 * emergency stop, F8 faults, F10 localisation, F12 advisories, F27 authorised zones, F36
 * maintenance) have **no table and no producer** anywhere in this repository. Each is
 * class DENY, so each one alone made every candidate infeasible and no simulated robot
 * could ever reach OFFER (measured 2026-09-22: 30 of 38 predicates denied).
 *
 * For a *physical* agent these facts come from a control plane and live telemetry that do
 * not exist yet, and nothing here pretends otherwise. For a *simulated* agent they are
 * facts about the simulator, and the simulator can state them honestly: it has no
 * emergency-stop circuit, no sensors to calibrate, no fault channel beyond its own status,
 * and it knows its position exactly. This module states exactly that, labelled.
 *
 * ── What this is NOT ───────────────────────────────────────────────────────
 *   * **Not telemetry.** Nothing here is presented as a sensor reading from a vehicle.
 *     Every fact carries `provenance: DEVELOPMENT_SIMULATION`.
 *   * **Not a relaxation of any predicate.** The predicates still evaluate every value: a
 *     PAUSED simulated robot is held (F3), an ISSUES robot carries a DEGRADED fault (F8)
 *     and a MARGINAL tier (F9), an offline robot's e-stop reading goes stale (F7), and a
 *     robot outside its region's zones is unauthorised (F27).
 *   * **Not a decision.** No function here decides feasibility, cost or selection.
 *
 * ── The replacement seam ───────────────────────────────────────────────────
 * `services/agentFacts.service.js` calls this only for `Robot.simulated === true`. For the
 * physical RobotX it supplies only the facts derived from real rows (session, health tier,
 * position freshness, reservations), and the control-plane facts stay **absent**, so the
 * predicates deny by name. Connecting the physical robot means supplying those same
 * fields from its control plane — the assignment engine does not change.
 *
 * Pure: no clock, no randomness, no I/O. Everything time-dependent is passed in.
 */

const constants = require("./constants");
const { AMBIENT_MAX_C, siteAmbientC } = require("./simulatedEnvironment");

/** The provenance label every value here carries. @structural a label, not a value */
const PROVENANCE = "DEVELOPMENT_SIMULATION";

/**
 * The version string a simulated agent reports as its "firmware". It names the simulator's
 * protocol implementation, not a vehicle build. @structural a label
 */
const SIMULATED_FIRMWARE_VERSION = "virtual-robot/v1-simulation";

/** The hardware revision a simulated agent class declares. @structural a label */
const SIMULATED_HARDWARE_REVISION = "virtual";

/**
 * The only surface class the simulated world has. The simulator moves along the straight
 * segments it is given (`VirtualRobot._stepAlongPath` over `haversineMeters`) and has no
 * notion of footway, road or stairs, so a simulated route traverses exactly this class and
 * a simulated agent class is permitted exactly this class.
 * @structural a label for the simulated world's single surface
 */
const SIMULATED_SURFACE_CLASS = "SIMULATED_PLANAR";

/** Mission types a simulated agent class is qualified for (F5). @structural */
const SIMULATED_MISSION_TYPES = Object.freeze(["DELIVERY"]);

/** Days between declared services of a simulated unit (F36). @structural V1 declaration */
const SIMULATED_SERVICE_INTERVAL_DAYS = 365;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const TICK_SECONDS = constants.TELEMETRY_INTERVAL_MS / 1000;

/** Wh drawn per second at a drain of `percentPerTick` of a `packWh` pack. */
function whPerSecond(percentPerTick, packWh) {
  return ((percentPerTick / 100) * packWh) / TICK_SECONDS;
}

/** The unit's own declared pack, or the simulator's default pack. */
function packOrDefault(packNominalWh) {
  return typeof packNominalWh === "number" && Number.isFinite(packNominalWh) && packNominalWh > 0
    ? packNominalWh
    : constants.PACK_NOMINAL_WH;
}

/**
 * The simulated pack's §14.2 coefficient set, **derived from the simulator's own drain
 * constants** — not invented, not fitted, not a measurement of any vehicle.
 *
 * `VirtualRobot` drains `BATTERY_DRAIN_IDLE` %/tick at rest and `BATTERY_DRAIN_ACTIVE`
 * %/tick while working — a percentage of **the unit's own pack** — per
 * `TELEMETRY_INTERVAL_MS` tick. So, at the shipped constants on a 1000 Wh pack:
 *
 *   β_aux       = idle draw                    (0.0445 Wh/s at the shipped constants)
 *   β_move_time = active draw − idle draw      (0.1775 Wh/s)
 *   β_dwell     = active draw − idle draw      (a robot waiting at a stop is ACTIVE)
 *
 * and every term the simulator does not model is **zero because the simulator has no such
 * term** — no mass dependence, no gradient (it has no elevation), no stop-start penalty, no
 * thermal draw. That makes the engine's prediction and the simulator's consumption the same
 * model, which is coherence, not validation (`simulatedEnergy.js` says the same).
 *
 * @param {number} [packNominalWh] the unit's declared pack; the simulator's default otherwise
 * @returns {object} `EnergyModelParams` columns in Prisma spelling
 */
function simulatedEnergyCoefficients(packNominalWh) {
  const packWh = packOrDefault(packNominalWh);
  const idle = whPerSecond(constants.BATTERY_DRAIN_IDLE, packWh);
  const active = whPerSecond(constants.BATTERY_DRAIN_ACTIVE, packWh);
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
    betaMoveTime: active - idle,
    betaStopStart: 0,
    betaDwell: active - idle,
    betaAux: idle,
    betaThermal: { ambientCurve: flatZero, packCurve: flatZero },
    betaPayloadThermal: {},
    // §14.4's stress curves. The simulator models no pack degradation, so every stress
    // factor is exactly 1 and wear prices pure throughput.
    stressCurves: {
      dod: [{ x: 0, y: 1 }, { x: 1, y: 1 }],
      socMid: [{ x: 0, y: 1 }, { x: 1, y: 1 }],
      tempC: [{ x: -50, y: 1 }, { x: 100, y: 1 }],
      cRate: [{ x: 0, y: 1 }, { x: 10, y: 1 }],
      calendarAgeing: [{ x: 0, y: 0 }, { x: 1, y: 0 }],
    },
    // The simulator's only source of consumption variance is its speed jitter: drain is
    // per second and the target speed is uniform in ±SPEED_JITTER/2 around SPEED_BASE_MS,
    // so the per-metre energy has CV ≈ (SPEED_JITTER/2)/√3/SPEED_BASE_MS ≈ 0.078.
    // Declared at 0.10 — the next tenth above — so the dispersion is not understated.
    residualCv: 0.1,
  };
}

/**
 * The simulated pack's other declarations: nominal capacity, discharge derating, charge
 * curve, state of health and the floor below which the simulator never lets it go.
 *
 * @param {number} [packNominalWh] the unit's declared pack; the simulator's default otherwise
 * @returns {object}
 */
function simulatedPackDeclaration(packNominalWh) {
  const packWh = packOrDefault(packNominalWh);
  const [lowC, highC] = [
    constants.CHARGE_POWER_CURVE.temperatureDerating[0].x,
    constants.CHARGE_POWER_CURVE.temperatureDerating[constants.CHARGE_POWER_CURVE.temperatureDerating.length - 1].x,
  ];
  return {
    packNominalWh: packWh,
    // The simulator does not derate discharge with temperature: f_temp = 1 over the pack's
    // declared operating range (the charge curve's own temperature domain).
    thermalDeratingCurve: [
      { x: lowC, y: 1 },
      { x: highC, y: 1 },
    ],
    chargePowerCurve: constants.CHARGE_POWER_CURVE,
    // The simulator models no capacity fade.
    soh: 1,
    // `BATTERY_MIN` is the floor `VirtualRobot` clamps the pack to — a fact of the
    // simulated world, so the §14.5 absolute floor for a simulated pack is that fraction of
    // its capacity (50 Wh on a 1000 Wh pack).
    reserveFloorWh: (constants.BATTERY_MIN / 100) * packWh,
    residualCv: simulatedEnergyCoefficients().residualCv,
    // The ambient range the simulated pack is declared to operate in (F31).
    operatingAmbientC: { min: lowC, max: highC },
  };
}

/**
 * The simulated agent class's declared columns beyond its energy model.
 *
 * @param {object} [chassisPermissionSet] the chassis template's own permission set
 * @returns {object}
 */
function simulatedClassDeclaration(chassisPermissionSet) {
  const pack = simulatedPackDeclaration();
  return {
    permissionSet: { ...(chassisPermissionSet || {}), surfaceClasses: [SIMULATED_SURFACE_CLASS] },
    environmentalLimits: {
      ambientC: { min: pack.operatingAmbientC.min, max: pack.operatingAmbientC.max, unit: "DEGREES_CELSIUS" },
    },
    firmwareVersionSet: Object.fromEntries(SIMULATED_MISSION_TYPES.map((type) => [type, [SIMULATED_FIRMWARE_VERSION]])),
    hardwareRevision: SIMULATED_HARDWARE_REVISION,
  };
}

/** Robot.status → §16.4 tier, for the simulator's own status vocabulary. */
const FAULT_BY_STATUS = Object.freeze({
  ERROR: Object.freeze({ code: "SIMULATED_ERROR", severity: "BLOCKING" }),
  ISSUES: Object.freeze({ code: "SIMULATED_ISSUES", severity: "DEGRADED" }),
});

/**
 * The simulator-owned agent facts for one simulated unit.
 *
 * @param {object} input
 * @param {object} input.robot the `Robot` row (status, createdAt, lastSeenAt, robotId)
 * @param {string[]} input.regionZoneIds every zone of the agent's commissioned region
 * @returns {object}
 */
function simulatedAgentFacts(input) {
  const { robot, regionZoneIds } = input || {};
  if (!robot) return null;

  const lastSeenAt = robot.lastSeenAt ? new Date(robot.lastSeenAt) : null;
  const createdAtMs = robot.createdAt ? new Date(robot.createdAt).getTime() : null;
  const fault = FAULT_BY_STATUS[robot.status];

  return {
    provenance: PROVENANCE,
    // F1 — the unit was commissioned through `robot.service.createRobotWithProjection`.
    commissioning: { commissioned: true, recordId: `${PROVENANCE}:${robot.robotId}` },
    // F3 — a simulated unit is stopped when an operator STOP reached it, or when it docked
    // to charge: `telemetry.handler` stores CHARGING as PAUSED because `RobotStatus` has no
    // CHARGING. The row cannot tell the two apart, so the hold says so — it is withheld
    // either way, and never on a claim that an operator acted.
    operatorHold:
      robot.status === "PAUSED"
        ? {
            held: true,
            reason: "simulated robot is stopped — an operator STOP or a charging dock (Robot.status PAUSED cannot distinguish them)",
            by: "SIMULATOR",
          }
        : { held: false },
    // F5 — the simulator's protocol version, attested at commissioning (not self-reported).
    firmwareVersion: SIMULATED_FIRMWARE_VERSION,
    firmwareVersionSource: "COMMISSIONING",
    // F6 — a simulated unit has no sensors to calibrate.
    calibrations: [],
    // F7 — the simulator has no e-stop circuit, so the reading is "not engaged", stamped at
    // the unit's last telemetry. No telemetry → no reading → F7 denies; stale telemetry →
    // F7 reports it stale. Freshness is real even though the circuit is not.
    emergencyStop: lastSeenAt
      ? { value: false, observedAt: lastSeenAt, source: "AGENT_REPORT", provenance: PROVENANCE }
      : null,
    // F8 — the simulator's only fault channel is its own status.
    faults: fault ? [{ ...fault, active: true, provenance: PROVENANCE }] : [],
    // F10 — the simulator's position is ground truth, and its odometry is that truth.
    localisation: {
      confidence: 1,
      corroborations: [{ kind: "ODOMETRY", available: true, divergenceM: 0 }],
      provenance: PROVENANCE,
    },
    // F11 — the simulator has no human-intervention mechanism at all.
    reliability: { interventionRate: 0, provenance: PROVENANCE },
    // F12 — no advisory mechanism exists, and none is outstanding against a simulator.
    advisories: [],
    // F27 — a simulated unit is authorised throughout the region it was commissioned into.
    authorisedZoneIds: Array.isArray(regionZoneIds) ? [...regionZoneIds].sort() : undefined,
    // F36 — a declared calendar interval from commissioning.
    maintenance:
      createdAtMs === null
        ? undefined
        : { serviceDueAt: new Date(createdAtMs + SIMULATED_SERVICE_INTERVAL_DAYS * MS_PER_DAY), provenance: PROVENANCE },
    // F14/F15 — the simulated link is an in-process socket: the server's heartbeat is
    // acknowledged on the same connection the last telemetry arrived on, and there is no
    // radio to degrade.
    sessionOverlay: lastSeenAt ? { lastHeartbeatAckAt: lastSeenAt, linkQuality: 1 } : {},
    // §14.2's thermal inputs, from the simulated site model. The pack is taken at ambient —
    // the simulator's own pack model is per-robot state this server-side reader cannot see.
    environmentAt(nowMs) {
      const ambientC = siteAmbientC(nowMs);
      return { ambientC, packC: ambientC, provenance: PROVENANCE };
    },
  };
}

/**
 * F31's forecast for a simulated route: the simulated site's ambient is bounded above by
 * `AMBIENT_MAX_C`, so that bound IS the worst case over any window.
 *
 * @returns {object}
 */
function simulatedEnvironmentForecast() {
  return {
    source: "FORECAST",
    provenance: PROVENANCE,
    variables: { ambientC: { worstCase: AMBIENT_MAX_C, provenance: PROVENANCE } },
  };
}

module.exports = {
  PROVENANCE,
  SIMULATED_FIRMWARE_VERSION,
  SIMULATED_HARDWARE_REVISION,
  SIMULATED_SURFACE_CLASS,
  SIMULATED_MISSION_TYPES,
  SIMULATED_SERVICE_INTERVAL_DAYS,
  simulatedEnergyCoefficients,
  simulatedPackDeclaration,
  simulatedClassDeclaration,
  simulatedAgentFacts,
  simulatedEnvironmentForecast,
};
