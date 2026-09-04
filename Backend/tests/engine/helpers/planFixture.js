"use strict";

/**
 * A complete input for `plan/planBuilder.build()`.
 *
 * §13.1 requires the Plan Builder to produce a *complete, executable, and evaluated* plan,
 * which means it needs every physical input the energy and payload models take plus the
 * routing and service-time inputs. Assembling that once, here, is the only way a test can
 * change one thing and attribute the result to it — the same reason
 * `feasibilityFixture.js` exists for the 38 predicates.
 *
 * The numbers are chosen for legibility: 1 m·s⁻¹ travel, 100 s service, a pack whose
 * arithmetic can be checked by hand.
 */

const energyFixture = require("./energyFixture");

const DECISION_TIME_MS = Date.UTC(2026, 7, 4, 12, 0, 0);
const MINUTE_MS = 60_000;
const RELEASE_MS = DECISION_TIME_MS + 60_000;

/** Two stops: a pickup and a drop, one Leg. */
function newLegs(overrides) {
  return [
    {
      legId: "leg-1",
      missionId: "mission-1",
      role: "TERMINAL",
      slaClass: "STANDARD",
      tenantId: "tenant-a",
      targetMs: DECISION_TIME_MS + 40 * MINUTE_MS,
      deadlineMs: DECISION_TIME_MS + 60 * MINUTE_MS,
      queueAgeSeconds: 0,
      stops: [
        {
          sequence: 1,
          stopType: "PICKUP",
          siteId: "site-a",
          cellId: "cell-a",
          zoneId: "zone-poor",
          lat: 51.5,
          lon: -0.12,
          windowStartMs: DECISION_TIME_MS,
          windowEndMs: DECISION_TIME_MS + 30 * MINUTE_MS,
          waitPermitted: true,
        },
        {
          sequence: 2,
          stopType: "DROP",
          siteId: "site-b",
          cellId: "cell-b",
          zoneId: "zone-rich",
          lat: 51.52,
          lon: -0.1,
          windowStartMs: DECISION_TIME_MS,
          windowEndMs: DECISION_TIME_MS + 90 * MINUTE_MS,
          waitPermitted: true,
        },
      ],
      ...(overrides || {}),
    },
  ];
}

/**
 * One hop per stop: travel *into* it.
 *
 * E-8 — each hop carries its own terrain. §14.2 evaluates climb, regeneration and
 * stop-start over the traversal, so `climbM` / `descentM` / `stopStartCycles` ride on the
 * hop beside `distanceM`, and `hopsForSequence` re-resolving them is what gives an inserted
 * charging stop a real elevation profile instead of none. The values differ per hop so a
 * test that summed the wrong one would not still pass.
 */
function hops(count) {
  const rows = [];
  for (let index = 0; index < (count || 2); index += 1) {
    rows.push({
      distanceM: 600,
      travelSeconds: 600,
      travelSdSeconds: 30,
      climbM: 5 + index,
      descentM: 2 + index,
      stopStartCycles: 6 + index,
    });
  }
  return rows;
}

/** A fitted service-time model for the two cohorts the fixture's stops resolve to. */
function serviceTimeModels() {
  return {
    "stopType=PICKUP": { n: 100, meanSeconds: 120, sdSeconds: 20 },
    "stopType=DROP": { n: 100, meanSeconds: 90, sdSeconds: 15 },
  };
}

/** `input.serviceTime`. */
function serviceTime(overrides) {
  return {
    serviceTimeModels: serviceTimeModels(),
    priorSeconds: { PICKUP: 150, DROP: 120, CHARGE: 0 },
    priorCv: 0.5,
    shrinkageStrength: 20,
    missionClassByLegId: { "leg-1": "PARCEL" },
    utcOffsetSecondsBySite: { "site-a": 0, "site-b": 0 },
    nominalArrivalMsByStop: { 1: RELEASE_MS, 2: RELEASE_MS + 20 * MINUTE_MS },
    ...(overrides || {}),
  };
}

/** `input.payload` — Phase 7's own container and item shapes, one item, one compartment. */
function payload(overrides) {
  return {
    container: energyFixture.containerModel(),
    consignment: { items: [energyFixture.item()] },
    packingEfficiency: 0.75,
    nodeBudget: 5000,
    itemsByStop: null,
    ...(overrides || {}),
  };
}

/** `input.energy` — Phase 7's model inputs, with a pack that comfortably holds the plan. */
function energy(overrides) {
  return {
    model: energyFixture.energyModelParams(),
    kappa: 1,
    usableWh: 2000,
    residualCv: 0.1,
    inflations: { route_novelty: 1.25, forecast_horizon: 1.1, weather: 1.15 },
    severity: { route_novelty: 0, forecast_horizon: 0, weather: 0 },
    floorWh: 100,
    operationalWh: 50,
    contingencyQuantile: 0.99,
    availabilityMargin: 1.15,
    projectionMaxAgeSeconds: 120,
    uncalibratedReserveFactor: 1.25,
    ...(overrides || {}),
  };
}

/** `input.charging` — a reachable charger and a Scheduler-published target SoC. */
function charging(overrides) {
  return {
    chargerCandidates: energyFixture.reachabilityCandidates(),
    projection: energyFixture.projection(),
    targetSoc: 0.8,
    targetSocSource: "SCHEDULER",
    currentSoc: 0.4,
    packUsableWh: 2000,
    tempC: 20,
    chargerClass: "STANDARD",
    integrationSteps: 64,
    queueWaitSeconds: 120,
    chargerCellId: "cell-c",
    chargerZoneId: "zone-poor",
    chargerSiteId: "site-c",
    chargerId: "depot-1",
    reservationRequired: true,
    curve: energyFixture.chargePowerCurve(),
    ...(overrides || {}),
  };
}

/** The whole `planBuilder.build()` input. */
function buildInput(overrides) {
  const stopHops = hops(2);
  return {
    planId: "plan-1",
    agent: {
      agentId: "agent-1",
      agentClassId: "SIDEWALK_V2",
      releaseAtMs: RELEASE_MS,
      packNominalWh: 2000,
      lat: 51.49,
      lon: -0.13,
      cellId: "cell-origin",
      zoneId: "zone-poor",
    },
    committedLegs: [],
    newLegs: newLegs(),
    hops: stopHops,
    hopsForSequence: (stops) => hops(stops.length),
    serviceTime: serviceTime(),
    payload: payload(),
    energy: energy(),
    charging: charging(),
    environment: { ambientC: 18, packC: 22 },
    masses: { vehicleMassKg: 60, payloadMassExpectedKg: 8, payloadMassExpectedKgByLegId: { "leg-1": 8 } },
    // E-8: terrain moved onto the hops above; `terrainByStop` no longer exists as an input.
    actuatorCycles: { LIFT: 0, DOOR: 2, LATCH: 2 },
    brakingEvents: 14,
    gradientExposureM: 16,
    thermalStressMultiplier: 1.2,
    config: {
      "energy.shortfall_probability": { T1: 1e-2, T2: 1e-5, T3: 1e-7 },
      "plan.commitment_horizon": 7200,
    },
    slaClass: "STANDARD",
    decisionTimeMs: DECISION_TIME_MS,
    latestFeasibleStartMs: DECISION_TIME_MS + 30 * MINUTE_MS,
    route: null,
    environmentForecast: null,
    ...(overrides || {}),
  };
}

module.exports = {
  DECISION_TIME_MS,
  MINUTE_MS,
  RELEASE_MS,
  newLegs,
  hops,
  serviceTimeModels,
  serviceTime,
  payload,
  energy,
  charging,
  buildInput,
};
