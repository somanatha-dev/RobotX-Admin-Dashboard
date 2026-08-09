"use strict";

/**
 * Fixtures for §14's energy model and §15's payload model.
 *
 * The energy model has more required inputs than any other surface in the engine — a
 * fitted β set, a pack, a state of health, a temperature curve, a reserve stack, three
 * derived targets, a pinned charger projection — and every one of them is *required*,
 * because §14.2 and §14.3 refuse to default a missing coefficient. A test that had to
 * assemble all of that inline would be testing the assembly.
 *
 * So this file provides one complete, internally consistent world in which every model
 * evaluates, and helpers to break exactly one part of it. The numbers are chosen to be
 * legible rather than realistic: a 1 000 Wh pack, coefficients that make a 1 km flat
 * unloaded leg cost about 100 Wh, and a charge curve whose taper is visible in a test's
 * assertion rather than only in the third decimal place.
 */

const DECISION_TIME_MS = Date.UTC(2026, 7, 4, 12, 0, 0);
const MINUTE_MS = 60_000;

/** A pack whose arithmetic is easy to check by hand. */
const PACK_NOMINAL_WH = 1000;

/**
 * A fitted `EnergyModelParams` set. Every coefficient §14.2 names is present, because
 * `legEnergyWh()` refuses to run without all of them.
 */
function energyModelParams() {
  return {
    // 0.1 Wh per metre — a 1 km leg is 100 Wh before every other term.
    beta_dist: 0.1,
    // 0.001 Wh per kg per metre — 10 kg over 1 km adds 10 Wh.
    beta_mass: 0.001,
    // 0.003 Wh per metre of climb per kg of gross mass.
    beta_climb: 0.003,
    beta_regen: 0.002,
    eta_regen: 0.5,
    beta_move_time: 0.002,
    beta_stop_start: 0.5,
    beta_dwell: 0.001,
    beta_aux: 0.004,
    beta_thermal: {
      ambientCurve: [
        { x: -10, y: 0.02 },
        { x: 20, y: 0.002 },
        { x: 40, y: 0.01 },
      ],
      packCurve: [
        { x: -10, y: 0.01 },
        { x: 20, y: 0 },
        { x: 45, y: 0.006 },
      ],
    },
    beta_payload_thermal: {
      CHILLED: [
        { x: -10, y: 0.001 },
        { x: 20, y: 0.01 },
        { x: 40, y: 0.03 },
      ],
      FROZEN: [
        { x: -10, y: 0.004 },
        { x: 20, y: 0.02 },
        { x: 40, y: 0.05 },
      ],
    },
  };
}

/** Vendor cycle-life and calendar-ageing curves for §14.4. */
function stressCurves() {
  return {
    // Superlinear in depth of discharge, which is what makes many shallow cycles the
    // cheaper policy without a rule saying so.
    dod: [
      { x: 0.1, y: 0.4 },
      { x: 0.5, y: 1 },
      { x: 0.8, y: 2.2 },
      { x: 1, y: 4 },
    ],
    socMid: [
      { x: 0.3, y: 0.9 },
      { x: 0.5, y: 1 },
      { x: 0.9, y: 1.4 },
    ],
    tempC: [
      { x: 0, y: 1.5 },
      { x: 25, y: 1 },
      { x: 45, y: 1.8 },
    ],
    cRate: [
      { x: 0.2, y: 0.9 },
      { x: 1, y: 1 },
      { x: 3, y: 1.9 },
    ],
    calendarAgeing: [
      { x: 0.5, y: 1e-8 },
      { x: 1, y: 1e-7 },
    ],
  };
}

/** A charge curve with a visible constant-voltage taper past 80 % (§14.6). */
function chargePowerCurve() {
  return {
    byChargerClass: {
      STANDARD: {
        socCurve: [
          { x: 0, y: 2000 },
          { x: 0.8, y: 2000 },
          { x: 0.9, y: 900 },
          { x: 0.95, y: 400 },
          { x: 1, y: 120 },
        ],
      },
      RAPID: {
        socCurve: [
          { x: 0, y: 6000 },
          { x: 0.8, y: 6000 },
          { x: 0.9, y: 1800 },
          { x: 1, y: 300 },
        ],
      },
    },
    temperatureDerating: [
      { x: -10, y: 0.35 },
      { x: 0, y: 0.6 },
      { x: 15, y: 1 },
      { x: 35, y: 1 },
      { x: 45, y: 0.7 },
    ],
  };
}

/** The pack's temperature-versus-capacity curve for `f_temp` (§14.3). */
function thermalDeratingCurve() {
  return [
    { x: -10, y: 0.7 },
    { x: 0, y: 0.85 },
    { x: 20, y: 1 },
    { x: 40, y: 0.95 },
  ];
}

/** A flat, unloaded, 1 km leg profile. */
function legProfile(overrides) {
  return {
    legId: "leg-1",
    distanceM: 1000,
    climbM: 0,
    descentM: 0,
    movingSeconds: 200,
    dwellSeconds: 60,
    totalSeconds: 300,
    stopStartCycles: 4,
    payloadMassKg: 0,
    vehicleMassKg: 60,
    ambientC: 20,
    packC: 20,
    compartmentOccupancy: [],
    ...(overrides || {}),
  };
}

/** The resolved configuration view the energy modules read. */
function config(overrides) {
  return {
    "energy.shortfall_probability": { T1: 1e-2, T2: 1e-5, T3: 1e-7 },
    "energy.contingency_quantile": 0.99,
    "energy.f_derate": 1,
    "energy.charger_availability_margin": 1.15,
    "energy.charger_projection_max_age": 120,
    "energy.uncalibrated_reserve_factor": 1.25,
    "energy.max_combined_conservatism": 1.6,
    "energy.combined_nominal_conservatism": 1.4375,
    "energy.combined_degraded_conservatism": 1.5,
    "energy.reserve_floor_wh": 80,
    "energy.operational_reserve_wh": 0,
    "energy.kappa_ewma_alpha": 0.2,
    "energy.kappa_bounds": { min: 0.5, max: 2 },
    "energy.model_residual_cv": 0.1,
    "energy.variance_inflation": { route_novelty: 1.25, forecast_horizon: 1.1, weather: 1.15 },
    "energy.charge_curve_integration_steps": 64,
    "energy.deviation_tolerance": 0.15,
    "energy.target_soc_max_age": 300,
    "energy.target_soc_fallback": 0.8,
    "payload.safety_factor": 0.9,
    "payload.packing_efficiency": 0.75,
    "payload.packing_node_budget": 5000,
    "payload.mass_discrepancy_tolerance_kg": 0.5,
    "route.charger_reachability_k": 5,
    "route.charger_reachability_min_hit_rate": 0.9,
    "route.intra_cell_offset_m": 250,
    ...(overrides || {}),
  };
}

/** A reserve stack whose four layers are distinguishable at a glance. */
function reserveLayers(overrides) {
  return { floorWh: 80, returnWh: 120, contingencyWh: 40, operationalWh: 0, ...(overrides || {}) };
}

/** A pinned charger availability projection with one free and one occupied charger. */
function projection(overrides) {
  const base = DECISION_TIME_MS;
  return {
    version: 41,
    publishedAtMs: base - 30_000,
    horizonEndMs: base + 6 * 3_600_000,
    chargers: [
      {
        chargerId: "charger-near",
        chargerClass: "STANDARD",
        cellId: "cell-a",
        isDepot: false,
        intervals: [{ fromMs: base, untilMs: base + 6 * 3_600_000, state: "OCCUPIED" }],
      },
      {
        chargerId: "charger-far",
        chargerClass: "STANDARD",
        cellId: "cell-b",
        isDepot: false,
        intervals: [{ fromMs: base, untilMs: base + 6 * 3_600_000, state: "FREE" }],
      },
      {
        chargerId: "depot-1",
        chargerClass: "STANDARD",
        cellId: "cell-c",
        isDepot: true,
        intervals: [{ fromMs: base, untilMs: base + 6 * 3_600_000, state: "RESERVABLE" }],
      },
    ],
    ...(overrides || {}),
  };
}

/** Nearest-k reachability candidates, ordered nearest first as the cache produces them. */
function reachabilityCandidates() {
  return [
    { chargerId: "charger-near", energyWh: 40, travelSeconds: 300, isDepot: false },
    { chargerId: "charger-far", energyWh: 90, travelSeconds: 700, isDepot: false },
    { chargerId: "depot-1", energyWh: 160, travelSeconds: 1200, isDepot: true },
  ];
}

/* ── Payload ─────────────────────────────────────────────────────────────── */

/** A two-compartment container with a deliberately narrow aperture on the second. */
function containerModel(overrides) {
  return {
    modelId: "container-a",
    totalMassLimitKg: 20,
    totalVolumeLitres: 100,
    cogEnvelope: {
      longitudinalMm: [-100, 100],
      lateralMm: [-80, 80],
      emptyVehicle: { massKg: 60, longitudinalMm: 0, lateralMm: 0, heightMm: 300 },
      compartmentCentroids: {
        c1: { longitudinalMm: 50, lateralMm: 0, heightMm: 400 },
        c2: { longitudinalMm: -50, lateralMm: 0, heightMm: 400 },
      },
    },
    compartments: [
      {
        compartmentId: "c1",
        ordinal: 1,
        internalLengthMm: 500,
        internalWidthMm: 400,
        internalHeightMm: 300,
        apertureWidthMm: 400,
        apertureHeightMm: 300,
        maxMassKg: 12,
        thermalClass: "AMBIENT",
        thermalMinC: 0,
        thermalMaxC: 40,
        activeThermal: false,
        thermalHoldSeconds: 3600,
        lockClass: null,
        cleanlinessClass: "FOOD",
        blockedBy: [],
      },
      {
        compartmentId: "c2",
        ordinal: 2,
        internalLengthMm: 500,
        internalWidthMm: 400,
        internalHeightMm: 300,
        // Deliberately narrow: §15.2's "two 40 cm boxes through a 30 cm hatch".
        apertureWidthMm: 200,
        apertureHeightMm: 200,
        maxMassKg: 12,
        thermalClass: "CHILLED",
        thermalMinC: -5,
        thermalMaxC: 8,
        activeThermal: true,
        thermalHoldSeconds: 1800,
        lockClass: "SECURE_A",
        cleanlinessClass: "FOOD",
        blockedBy: ["c1"],
      },
    ],
    ...(overrides || {}),
  };
}

/** One item that fits compartment 1 comfortably. */
function item(overrides) {
  return {
    itemId: "item-1",
    massKg: 5,
    massToleranceKg: 0.5,
    lengthMm: 300,
    widthMm: 200,
    heightMm: 150,
    volumeLitres: 9,
    orientationConstraints: null,
    stackable: true,
    loadBearingLimitKg: 20,
    fragilityClass: null,
    thermalMinC: null,
    thermalMaxC: null,
    thermalMaxExcursionSeconds: null,
    securityClass: null,
    hazardClasses: [],
    segregation: { incompatibleHazardClasses: [] },
    declaredValue: 20,
    regulatoryClass: null,
    ...(overrides || {}),
  };
}

/** A two-stop plan: pick up at stop 1, drop at stop 2. */
function stops() {
  return [
    { sequence: 1, stopType: "PICKUP", projectedArrivalMs: DECISION_TIME_MS + 5 * MINUTE_MS },
    { sequence: 2, stopType: "DROP", projectedArrivalMs: DECISION_TIME_MS + 45 * MINUTE_MS },
  ];
}

/**
 * A deterministic linear congruential generator.
 *
 * The simulation test draws tens of thousands of missions and must produce the same
 * numbers on every machine and every run — an unseeded source would make a failure
 * unreproducible, which is the property §9.6 requires of the engine and this suite
 * holds itself to for the same reason.
 *
 * @param {number} seed
 * @returns {() => number} uniform in [0, 1)
 */
function seededUniform(seed) {
  let state = seed >>> 0;
  return () => {
    // Numerical Recipes' LCG parameters.
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/**
 * A standard normal draw from a uniform source, by the Box–Muller transform.
 *
 * @param {() => number} uniform
 * @returns {() => number}
 */
function seededNormal(uniform) {
  let spare = null;
  return () => {
    if (spare !== null) {
      const value = spare;
      spare = null;
      return value;
    }
    let u = uniform();
    if (u <= 0) u = Number.MIN_VALUE;
    const v = uniform();
    const radius = Math.sqrt(-2 * Math.log(u));
    const angle = 2 * Math.PI * v;
    spare = radius * Math.sin(angle);
    return radius * Math.cos(angle);
  };
}

module.exports = {
  DECISION_TIME_MS,
  MINUTE_MS,
  PACK_NOMINAL_WH,
  energyModelParams,
  stressCurves,
  chargePowerCurve,
  thermalDeratingCurve,
  legProfile,
  config,
  reserveLayers,
  projection,
  reachabilityCandidates,
  containerModel,
  item,
  stops,
  seededUniform,
  seededNormal,
};
