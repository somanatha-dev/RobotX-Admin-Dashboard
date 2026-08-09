"use strict";

/**
 * A fixture that satisfies all 38 predicates, and the tools to break exactly one.
 *
 * §24.1's requirement for this phase is *"each of the 38 predicates tested exhaustively
 * at its boundaries, all three outcomes, and its declared indeterminate policy"*. That
 * needs a baseline where every predicate is `SATISFIED`, so that a test which mutates
 * one input can attribute the resulting rejection to that predicate rather than to
 * whatever else happened to be missing.
 *
 * The fixture is deliberately **complete**: every field every predicate reads is
 * present. Building it is the most useful documentation of the evaluation context in
 * the repository, because it is the only place the full contract appears in one piece
 * — and it is checked by a test that asserts all 38 are satisfied, so it cannot rot
 * into a partial description.
 *
 * `withPatch()` applies a deep patch, and `undefined` in a patch **removes** the key
 * rather than setting it to `undefined`. That distinction matters throughout the
 * register: `null` is a value ("consulted, and there is none") and absence is
 * `INDETERMINATE` ("nobody established it"), so a fixture helper that could not express
 * removal could not test the indeterminate branch at all.
 */

const DECISION_TIME_MS = Date.UTC(2026, 7, 4, 12, 0, 0);
const MINUTE_MS = 60_000;

const PLAN_START_MS = DECISION_TIME_MS + 5 * MINUTE_MS;
const PLAN_END_MS = DECISION_TIME_MS + 45 * MINUTE_MS;

/** A marker meaning "delete this key", so a patch can express absence. */
const REMOVE = Symbol("feasibilityFixture.remove");

/**
 * The resolved configuration view every predicate reads through
 * `threeValued.readParameter`.
 */
function config() {
  return {
    version: "cfg-test-1",
    "connectivity.max_heartbeat_age": 10,
    "connectivity.max_deadzone_extension": 250,
    "localisation.max_odometry_divergence": 5,
    "localisation.min_confidence": { URBAN_SIDEWALK: 0.85 },
    "link.min_quality": { CONTINUOUS_SUPERVISION: 0.5, TELEOP_FALLBACK: 0.6 },
    "health.required_tier": { STANDARD: "NOMINAL" },
    "reliability.max_intervention_rate": { PARCEL: 0.1 },
    capacity: { SIDEWALK_V2: 2 },
    "plan.commitment_horizon": 7200,
    "recover.max_reassignments_per_leg": 3,
    "payload.safety_factor": 0.9,
    "energy.shortfall_probability": { T1: 1e-2, T2: 1e-5, T3: 1e-7 },
    "feasibility.systemic_indeterminacy_threshold": 0.3,
    "feasibility.negative_cache_ttl": { AGENT: 300, CLASS: 60, NONE: 10 },
    "cost.uncertainty_penalty": { F11: 500, F15: 250 },
    "degraded.max_duration": 900,
    "degraded.max_last_known_age": 60,
    "degraded.max_mission_scope": "LOCAL",
    "degraded.reserve_factor": 1.5,
  };
}

/** An observation fresh at the pinned decision time. */
function freshObservation(value, kind) {
  return {
    agentId: "agent-1",
    kind: kind || "generic",
    value,
    observedAt: new Date(DECISION_TIME_MS - 1000),
    receivedAt: new Date(DECISION_TIME_MS - 500),
    source: "SENSOR",
    deadReckoned: false,
  };
}

/** An agent snapshot that satisfies F1–F21, F27–F29, F31, F36. */
function agentSnapshot() {
  return {
    agentId: "agent-1",
    agentClassId: "SIDEWALK_V2",
    hardwareRevision: "rev-c",
    tenantId: "tenant-a",
    fleetId: "fleet-1",
    regionId: "region-1",

    // F1
    commissioning: { commissioned: true, recordId: "comm-1" },
    // F2, F3
    lifecycleState: "ACTIVE",
    quarantined: false,
    operatorHold: null,
    // F4
    permittedTenants: ["tenant-a"],
    // F5
    firmwareVersion: "2.4.1",
    firmwareVersionSource: "FIRMWARE_ATTESTATION",
    supportedFirmwareByMissionType: { PARCEL: ["2.4.0", "2.4.1"] },
    // F6
    calibrations: [{ name: "lidar", validUntil: new Date(PLAN_END_MS + 86_400_000) }],
    capabilityBundle: {
      capabilities: [
        { name: "max_payload_mass", kind: "QUANTITATIVE", value: 20, source: "COMMISSIONING_RECORD" },
        { name: "autonomy_level", kind: "GRADED", value: 3, source: "COMMISSIONING_RECORD" },
        {
          name: "handling_certificate",
          kind: "CERTIFIED",
          value: true,
          validFrom: new Date(DECISION_TIME_MS - 86_400_000),
          validUntil: new Date(PLAN_END_MS + 86_400_000),
          source: "COMMISSIONING_RECORD",
        },
      ],
    },
    // F7
    emergencyStop: freshObservation(false, "emergency_stop"),
    // F8
    faults: [{ code: "brush-wear", severity: "DEGRADED", active: true }],
    // F9
    healthTier: "FULL",
    // F10
    localisation: {
      confidence: 0.95,
      corroborations: [
        { kind: "MAP_MATCH", available: true, divergenceM: 0.4 },
        { kind: "ODOMETRY", available: true, divergenceM: 1.2 },
      ],
    },
    // F11
    reliability: { interventionRate: 0.02, cohortPrior: 0.05 },
    // F12
    advisories: [],
    // F13, F14, F15
    session: {
      live: true,
      lastHeartbeatAt: new Date(DECISION_TIME_MS - 2000),
      lastCommandRoundTripAt: new Date(DECISION_TIME_MS - 3000),
      lastHeartbeatAckAt: new Date(DECISION_TIME_MS - 2500),
      linkQuality: 0.8,
    },
    autonomousDeadZoneCertified: true,
    // F16
    safetyRelevantObservations: {
      position: { stalenessBudgetMs: 10_000, observation: freshObservation({ lat: 1, lon: 2 }, "position") },
      soc: { stalenessBudgetMs: 30_000, observation: freshObservation(0.72, "soc") },
    },
    // F17
    capacityOverride: null,
    // F18
    reservations: [
      { subsystem: "CHARGING", from: new Date(PLAN_END_MS + 30 * MINUTE_MS), until: new Date(PLAN_END_MS + 90 * MINUTE_MS) },
    ],
    // F19
    projectedAvailableAtMs: DECISION_TIME_MS + MINUTE_MS,
    // F20
    legExclusions: { cooloffUntil: null, nackCooloffUntil: null, isIncumbent: false, reassignmentsSoFar: 0 },
    // F22, F24
    containerModel: {
      totalMassLimitKg: 20,
      cogEnvelope: { longitudinalMm: [-100, 100], lateralMm: [-80, 80] },
    },
    // F28, F29, F31
    mobilityModel: {
      modelId: "sidewalk-v2",
      traversalDomain: "SIDEWALK_GRAPH",
      permissionSet: { surfaceClasses: ["FOOTWAY", "SHARED_SPACE", "PLAZA"] },
      speedModel: {},
      kinematicLimits: {},
      envelopeConstraints: {
        maxKerbHeightMm: 120,
        maxGradientPct: 12,
        environmental: {
          windGustKph: { max: 40, unit: "ratio" },
          rainMmPerHour: { max: 15, unit: "ratio" },
        },
      },
      dimensionalFootprint: { widthMm: 700, heightMm: 1200 },
    },
    // F27
    authorisedZoneIds: ["zone-1", "zone-2"],
    // F36
    maintenance: {
      serviceDueAt: new Date(PLAN_END_MS + 30 * 86_400_000),
      odometerM: 1_200_000,
      serviceDueOdometerM: 2_000_000,
      operatingSeconds: 400_000,
      serviceDueOperatingSeconds: 900_000,
    },
  };
}

/** A mission that satisfies F4, F5, F9, F10, F11, F15, F21, F25, F26, F37. */
function mission() {
  return {
    missionId: "mission-1",
    legId: "leg-1",
    missionClass: "PARCEL",
    missionType: "PARCEL",
    slaClass: "STANDARD",
    tenantId: "tenant-a",
    requiredFleetId: null,
    environment: "URBAN_SIDEWALK",
    supervisionRequirement: "CONTINUOUS_SUPERVISION",
    requirements: [
      { name: "max_payload_mass", comparator: "AT_LEAST", value: 12 },
      { name: "autonomy_level", comparator: "AT_LEAST", value: 3 },
    ],
    payload: {
      massKg: 8,
      massToleranceKg: 0.5,
      thermalMinC: null,
      thermalMaxC: null,
      thermalMaxExcursionSeconds: null,
      hazardClasses: [],
      securityClass: null,
    },
    latestFeasibleStartMs: PLAN_START_MS,
    deadlineMs: PLAN_END_MS + 30 * MINUTE_MS,
    deadlineIsContractuallyHard: true,
  };
}

/** A plan that satisfies F6, F17–F19, F22–F26, F27–F38. */
function plan() {
  return {
    projectedStartMs: PLAN_START_MS,
    projectedEndMs: PLAN_END_MS,
    horizonEndMs: PLAN_END_MS,
    earliestFeasibleCompletionMs: PLAN_END_MS,
    latestFeasibleStartMs: PLAN_START_MS,
    concurrentCommitments: 1,
    peakLoadedMassKg: 48,
    distanceM: 3200,
    durationSeconds: 2400,

    stops: [
      {
        sequence: 1,
        stopType: "PICKUP",
        lat: 51.5,
        lon: -0.12,
        serviceable: true,
        projectedArrivalMs: PLAN_START_MS,
        windowStart: new Date(PLAN_START_MS - 10 * MINUTE_MS),
        windowEnd: new Date(PLAN_START_MS + 10 * MINUTE_MS),
        waitPermitted: true,
        accessPrerequisites: [{ kind: "GATE", availability: "HELD" }],
      },
      {
        sequence: 2,
        stopType: "DROP",
        lat: 51.52,
        lon: -0.1,
        serviceable: true,
        projectedArrivalMs: PLAN_END_MS,
        windowStart: new Date(PLAN_END_MS - 15 * MINUTE_MS),
        windowEnd: new Date(PLAN_END_MS + 15 * MINUTE_MS),
        waitPermitted: true,
        accessPrerequisites: [{ kind: "DOOR_CREDENTIAL", availability: "OBTAINABLE" }],
      },
    ],

    // §15.4 — Phase 7's `payload/loadState.js` produces this.
    loadState: [
      { sequence: 1, massUpperBoundKg: 8.5, cog: { withinEnvelope: true, envelopeMarginMm: 35 } },
      { sequence: 2, massUpperBoundKg: 0, cog: { withinEnvelope: true, envelopeMarginMm: 90 } },
    ],

    // §15.3 — Phase 7's `payload/packing.js` produces this.
    packing: {
      verdict: "FEASIBLE",
      tier: 1,
      thermalAssignment: null,
      compartmentLoads: [
        {
          compartmentId: "c1",
          lockClass: null,
          items: [{ itemId: "item-1", hazardClasses: [], securityClass: null, segregation: { incompatibleHazardClasses: [] } }],
        },
      ],
    },

    // §14.5 — Phase 7's `energy/tiers.js` and `energy/eReturn.js` produce these.
    energy: {
      tierProbabilities: { T1: 1e-3, T2: 1e-6, T3: 1e-9 },
      chargerReachability: {
        reachable: true,
        basis: "PINNED_PROJECTION",
        projectionVersion: 41,
        chargerId: "charger-7",
        eReturnWh: 120,
        surplusWh: 260,
      },
    },

    route: {
      loaded: true,
      profileKey: "sidewalk-v2:SIDEWALK_GRAPH:loaded",
      surfaceClasses: ["FOOTWAY", "SHARED_SPACE"],
      zonesTraversed: ["zone-1", "zone-2"],
      deadZoneExtentM: 0,
      constrictions: [
        { at: "alley-3", widthMm: 900, heightMm: 2200 },
        { at: "kerb-11", kerbHeightMm: 80, gradientPct: 6 },
        { at: "lift-a", liftCapacityKg: 200 },
      ],
      zoneTraversals: [
        {
          zoneId: "zone-1",
          enterMs: PLAN_START_MS,
          exitMs: PLAN_START_MS + 15 * MINUTE_MS,
          restrictions: [
            { kind: "CURFEW", closedFromMs: PLAN_END_MS + 6 * 3_600_000, closedUntilMs: PLAN_END_MS + 12 * 3_600_000 },
          ],
        },
        { zoneId: "zone-2", enterMs: PLAN_START_MS + 15 * MINUTE_MS, exitMs: PLAN_END_MS, restrictions: [] },
      ],
    },

    environmentForecast: {
      source: "FORECAST",
      variables: {
        windGustKph: { worstCase: 22 },
        rainMmPerHour: { worstCase: 2 },
      },
    },
  };
}

/** The complete evaluation context, with every predicate satisfied. */
function context() {
  return {
    agentSnapshot: agentSnapshot(),
    mission: mission(),
    plan: plan(),
    config: config(),
    decisionTimeMs: DECISION_TIME_MS,
    snapshotId: "snap-1",
  };
}

/**
 * Deep-merge a patch onto a base. `REMOVE` deletes a key, which is how a test
 * distinguishes "null, explicitly none" from "absent, nobody established it" — the two
 * outcomes §7.3 keeps apart and the baseline conflated.
 *
 * @param {*} base
 * @param {*} patch
 * @returns {*}
 */
function merge(base, patch) {
  if (patch === REMOVE) return REMOVE;
  if (patch === null) return null;
  if (typeof patch !== "object") return patch;

  // A `Date` is a leaf, not a bag of fields. Spreading one produces `{}`, which every
  // predicate then reads as an unreadable timestamp — so a case meant to test a
  // *violated* deadline would silently test an *indeterminate* one instead. Every
  // temporal predicate in the register takes a Date somewhere, so this is load-bearing
  // for a third of the table.
  if (patch instanceof Date) return patch;

  // Arrays merge **element-wise, with the patch's length winning**. Element-wise so a
  // case can change one field of one stop without restating the whole plan; the
  // patch's length winning so an empty patch array means "none" — which is how the
  // F10 case expresses "no corroborating signals were offered", a state that is
  // materially different from "the signals in the fixture".
  if (Array.isArray(patch)) {
    const source = Array.isArray(base) ? base : [];
    return patch.map((element, index) => merge(source[index], element)).filter((element) => element !== REMOVE);
  }

  const target = Array.isArray(base) ? [...base] : { ...(base || {}) };
  for (const [key, value] of Object.entries(patch)) {
    const merged = merge(target[key], value);
    if (merged === REMOVE) {
      delete target[key];
    } else {
      target[key] = merged;
    }
  }
  return target;
}

/**
 * A context with a patch applied.
 *
 * @param {object} patch
 * @returns {object}
 */
function withPatch(patch) {
  return merge(context(), patch);
}

module.exports = {
  DECISION_TIME_MS,
  MINUTE_MS,
  PLAN_START_MS,
  PLAN_END_MS,
  REMOVE,
  config,
  agentSnapshot,
  mission,
  plan,
  context,
  withPatch,
  merge,
  freshObservation,
};
