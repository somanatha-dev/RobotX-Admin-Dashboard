"use strict";

/**
 * P1 — the fleet provider boundary (`src/services/fleetProviders/`).
 *
 * The property under test is the one the architecture rests on: **the assignment engine
 * never chooses, admits, rejects, prices or ranks an agent because it is physical or
 * simulated.** Physical-vs-simulated is a data-source distinction, answered below the seams.
 *
 *   1. Simulation equivalence — the dispatcher hands a simulated agent exactly what the
 *      V1 demonstration composition hands it today.
 *   2. Physical absence — a physical agent receives only what is real, and none of the
 *      simulator's values.
 *   3. Mixed fleet — simulated and physical agents enter the SAME candidate pipeline, and an
 *      agent's disposition follows its data, never its kind.
 *   4. Provenance neutrality — two agents identical in every fact but provenance get
 *      identical verdicts, plans, prices and rank.
 *
 * (5, the static half, is in `simulationBoundary.test.js`.)
 *
 * ── Test doubles, and the rule they are held to ────────────────────────────
 * A double may stand in for a *seam* or the *store*, never for a *decision*. Every one is
 * labelled where it is built: `declaredRouter()` (a fixed six-field route), `storeWith()`
 * (an in-memory Prisma double in the schema's row shapes), `fixedFacts()` (a complete §7.5
 * fact set from `feasibilityFixture`, for the neutrality test only). The feasibility gate,
 * the plan builder, Φ/γ, the lower bound and the expansion are the real modules.
 */

const fleetProviders = require("../../src/services/fleetProviders");
const simulationProvider = require("../../src/services/fleetProviders/simulationProvider");
const physicalProvider = require("../../src/services/fleetProviders/physicalProvider");
const v1Composition = require("../../src/services/v1DemonstrationComposition");
const profile = require("../../src/services/v1DemonstrationProfile");
const simulatedAgentState = require("../../src/simulation/simulatedAgentState");
const { RouteRefusedError, ROUTE_REFUSAL } = require("../../src/engine/routing/productionRouter");

const solvePath = require("../../src/workers/coordinatorSolvePath");
const service = require("../../src/engine/config/service");
const cells = require("../../src/engine/spatial/cells");
const availabilityIndex = require("../../src/engine/candidates/availabilityIndex");
const consumption = require("../../src/engine/energy/consumption");
const evaluate = require("../../src/engine/feasibility/evaluate");
const { createTestKv } = require("../helpers/testKv");
const energyFixture = require("./helpers/energyFixture");
const fx = require("./helpers/feasibilityFixture");

const SIM_ENV = Object.freeze({ ENABLE_VIRTUAL_SIMULATOR: "true", V1_DEMONSTRATION_COMPOSITION: "true" });
const SIMULATED = simulatedAgentState.PROVENANCE; // "DEVELOPMENT_SIMULATION"
const PHYSICAL = "PHYSICAL_DERIVED_ONLY"; // the label agentFacts.service gives a physical agent's facts

const SHARD_ID = "shard-fleet";
const DECISION_TIME_MS = Date.UTC(2026, 8, 4, 12, 0, 0);
const ORIGIN = { lat: 12.9716, lon: 77.5946 };
const NEAR = { lat: 12.972, lon: 77.5948 };
const PICKUP = { lat: 12.9724, lon: 77.5951 };
const DROP = { lat: 12.9731, lon: 77.596 };

/** Every §7.5 fact only a control plane can state — none may reach a physical agent in P1. */
const CONTROL_PLANE_FIELDS = Object.freeze([
  "commissioning",
  "operatorHold",
  "firmwareVersion",
  "firmwareVersionSource",
  "calibrations",
  "emergencyStop",
  "faults",
  "localisation",
  "reliability",
  "advisories",
  "authorisedZoneIds",
  "maintenance",
  "environmentAt",
]);

/* ═══════════════════════════════════════════════════════════════════════════
   Fixtures
   ═══════════════════════════════════════════════════════════════════════════ */

/** **TEST DOUBLE — a router-shaped function, not a traversal source.** */
function declaredRouter() {
  const calls = [];
  const route = async (parts) => {
    calls.push(parts);
    return { distanceM: 800, travelSeconds: 400, travelSdSeconds: 20, climbM: 6, descentM: 3, stopStartCycles: 4 };
  };
  route.calls = calls;
  return route;
}

/** The real configuration snapshot, with named parameters overridden in this object only. */
function snapshotWith(overrides) {
  const real = service.defaultSnapshot();
  const map = overrides || {};
  return Object.assign(Object.create(Object.getPrototypeOf(real)), real, { spatial: null }, {
    resolve: (name, context, options) =>
      Object.prototype.hasOwnProperty.call(map, name) ? map[name] : real.resolve(name, context, options),
    explain: (name, context, options) => {
      const explained = real.explain(name, context, options);
      return Object.prototype.hasOwnProperty.call(map, name) ? { ...explained, value: map[name] } : explained;
    },
  });
}

/** Resolvable register values — the same smallest set the composition tests use. Not proposals. */
function register(extra) {
  return {
    "candidate.max_radius_by_sla_class": 300,
    "candidate.max_expansion_tiers": 2,
    // Every agent reached is evaluated: a mixed-fleet test must not stop at the first feasible one.
    "candidate.target_feasible": 10,
    "candidate.max_evaluated": 10,
    "plan.service_time_prior": 60,
    "energy.model_residual_cv": 0.1,
    "energy.reserve_floor_wh": 50,
    "energy.contingency_quantile": 0.99,
    "energy.charger_availability_margin": 1.15,
    "energy.uncalibrated_reserve_factor": 1.25,
    "cost.energy.cu_per_wh": 0.5,
    "cost.wear.cu_per_metre": 0.001,
    "cost.failure.cu": 100,
    "cost.staleness.cu_per_second_age": 0.001,
    "cost.energy_consequence": { T1: 10, T2: 100, T3: 1000 },
    "cost.sla.cu_per_second_late": 0.01,
    "cost.sla.breach_penalty": 50,
    "lifecycle.cu_per_actuator_cycle": { LIFT: 0.1, DOOR: 0.05, LATCH: 0.05 },
    "lifecycle.cu_per_braking_event": 0.01,
    "lifecycle.cu_per_gradient_metre": 0.002,
    "lifecycle.cu_per_thermal_stress_second": 0.0001,
    "cost.battery.cu_per_equivalent_cycle": 40,
    ...(extra || {}),
  };
}

function energyModelParamsRow() {
  const fitted = energyFixture.energyModelParams();
  return {
    modelVersion: 1,
    betaDist: fitted[consumption.COEFFICIENT.DIST],
    betaMass: fitted[consumption.COEFFICIENT.MASS],
    betaClimb: fitted[consumption.COEFFICIENT.CLIMB],
    betaRegen: fitted[consumption.COEFFICIENT.REGEN],
    betaMoveTime: fitted[consumption.COEFFICIENT.MOVE_TIME],
    betaStopStart: fitted[consumption.COEFFICIENT.STOP_START],
    betaDwell: fitted[consumption.COEFFICIENT.DWELL],
    betaAux: fitted[consumption.COEFFICIENT.AUX],
    betaThermal: fitted[consumption.COEFFICIENT.THERMAL],
    betaPayloadThermal: fitted[consumption.COEFFICIENT.PAYLOAD_THERMAL],
    etaRegen: fitted[consumption.COEFFICIENT.REGEN_EFFICIENCY],
  };
}

/**
 * One fleet member, in the rows `prisma/schema.prisma` declares.
 *
 * `energy: true` gives the agent a `BatteryState` and fitted `EnergyModelParams` — the rows
 * commissioning writes for a simulated unit today and for no physical one.
 */
function member(spec) {
  const at = spec.at || ORIGIN;
  const robot = {
    id: `robot-${spec.key}`,
    robotId: spec.robotId,
    simulated: spec.simulated === true,
    status: "IDLE",
    isOnline: true,
    lastSeenAt: new Date(DECISION_TIME_MS - 2_000),
    createdAt: new Date(DECISION_TIME_MS - 86_400_000),
    massKg: 40,
  };
  const agentClass = {
    classId: `class-${spec.key}`,
    mobilityModel: {
      traversalDomain: "GROUND",
      kinematicLimits: { maxSpeedMs: 2 },
      speedModel: { nominalSpeedMps: 1.5 },
      permissionSet: spec.permissionSet === undefined ? null : spec.permissionSet,
    },
    energyModel: {
      packNominalWh: 1000,
      chargePowerCurve: energyFixture.chargePowerCurve(),
      thermalDeratingCurve: energyFixture.thermalDeratingCurve(),
    },
    containerModel: null,
    capabilityBundle: null,
    energyModelParams: spec.energy ? [energyModelParamsRow()] : [],
    firmwareVersionSet: null,
    hardwareRevision: null,
  };
  const agent = {
    id: `agent-${spec.key}`,
    agentId: spec.robotId,
    lifecycleState: "ACTIVE",
    authorityEpoch: 0n,
    fenceCounter: 0n,
    capacityOverride: null,
    tenantId: null,
    fleetId: null,
    regionId: "region-1",
    homeDepotId: null,
    robot,
    agentClass,
    batteryState: spec.energy
      ? { kappa: 1, lastObservedSoc: 0.9, soh: 1, kappaSampleCount: 0, kappaUpdatedAt: null }
      : null,
    commitments: [],
  };
  const fineCellId = cells.cellForPoint(at.lat, at.lon, cells.RESOLUTION.FINE);
  const position = {
    agentId: agent.id,
    shardId: SHARD_ID,
    lat: at.lat,
    lon: at.lon,
    fineCellId,
    coarseCellId: cells.coarseParentOf(fineCellId),
    availabilityClass: "IDLE_READY",
    capabilityClasses: [],
    containerClasses: [],
    observedAtMs: BigInt(DECISION_TIME_MS - 1_000),
    agent,
  };
  const observation = {
    agentId: agent.id,
    kind: "position",
    value: { lat: at.lat, lon: at.lon, provenance: spec.simulated ? "SIMULATED" : "PHYSICAL" },
    observedAt: new Date(DECISION_TIME_MS - 1_000),
    source: "AGENT_REPORT",
  };
  return { spec, robot, agent, position, observation, fineCellId };
}

/** **TEST DOUBLE — an in-memory store** in the schema's row shapes. Decides nothing. */
function storeWith(members) {
  const leg = {
    id: "leg-row-1",
    legId: "leg-1",
    missionId: "mission-row-1",
    purpose: "PRIMARY",
    state: "QUEUED",
    custodyState: "NONE",
    version: 0,
    cancelRequestedAt: null,
    obstructionClass: null,
    slaDeadline: new Date(DECISION_TIME_MS + 3_600_000),
    startNotBefore: null,
    createdAt: new Date(DECISION_TIME_MS - 60_000),
    manifests: [],
    mission: { missionId: "mission-1", legs: [{ id: "leg-row-1", sequence: 1 }] },
    stops: [
      { stopId: "stop-1", sequence: 1, stopType: "PICKUP", siteId: "site-a", lat: PICKUP.lat, lon: PICKUP.lon },
      { stopId: "stop-2", sequence: 2, stopType: "DROP", siteId: "site-b", lat: DROP.lat, lon: DROP.lon },
    ],
  };
  const byAgentRowId = new Map(members.map((m) => [m.agent.id, m]));
  const byAgentId = new Map(members.map((m) => [m.agent.agentId, m]));
  const find = (where) => {
    const wanted = where && where.OR ? where.OR.map((row) => row.agentId || (row.agent && row.agent.agentId)) : [];
    for (const id of wanted) {
      const hit = byAgentRowId.get(id) || byAgentId.get(id);
      if (hit) return hit;
    }
    return null;
  };

  return {
    leg,
    prisma: {
      leg: { findFirst: async () => leg },
      agentCellPosition: {
        findFirst: async (query) => {
          const hit = find(query && query.where);
          return hit ? hit.position : null;
        },
        findMany: async () => members.map((m) => m.position),
        findUnique: async (query) => {
          const hit = byAgentRowId.get(query.where.agentId);
          return hit ? { shardId: hit.position.shardId } : null;
        },
      },
      shard: { findUnique: async () => ({ regionId: "region-1" }) },
      observation: {
        findFirst: async (query) => {
          const hit = byAgentRowId.get(query.where.agentId);
          return hit && query.where.kind === "position" ? hit.observation : null;
        },
      },
      chargerReservation: { findMany: async () => [] },
      zone: { findMany: async () => [{ id: "zone-1" }] },
      charger: { findMany: async () => [] },
      commitment: { findMany: async () => [] },
      chargerAvailabilityProjection: { findFirst: async () => null },
      robot: { findMany: async () => members.filter((m) => m.robot.simulated).map((m) => ({ robotId: m.robot.robotId, simulated: true })) },
    },
  };
}

/** The neutral part of a solve-path context: register, store, bookkeeping. */
function baseContext(store, kv, extraRegister) {
  return {
    snapshot: snapshotWith(register(extraRegister)),
    prisma: store.prisma,
    kv,
    shardId: SHARD_ID,
    regionId: "region-1",
    instanceId: "instance-1",
    runSerializable: async (client, fn) => fn(client),
    selectForUpdate: async () => null,
    signingKey: "test-only-signing-key",
    values: new Map(),
    record: () => {},
  };
}

async function indexAll(kv, members) {
  for (const m of members) {
    await kv.sadd(availabilityIndex.fineKey(SHARD_ID, m.fineCellId, "IDLE_READY"), m.agent.id);
  }
}

async function expandOnce(assembly) {
  return assembly.deps.expandCandidates({
    legId: "leg-1",
    shardId: SHARD_ID,
    decisionTimeMs: DECISION_TIME_MS,
    slaClass: null,
    queueAgeSeconds: 60,
  });
}

/** Stringify with BigInt and Date support, for "does this contain X anywhere" scans. */
function flat(value) {
  return JSON.stringify(value, (key, v) => (typeof v === "bigint" ? `${v}n` : v)) || "";
}

/** One in-memory kv per world, so no test's availability index leaks into another's. */
const openKvs = [];
async function freshKv() {
  const handle = await createTestKv();
  openKvs.push(handle);
  return handle.kv;
}
afterEach(async () => {
  while (openKvs.length > 0) {
    const handle = openKvs.pop();
    if (handle && handle.close) await handle.close();
  }
});

const { routingProfileKey } = require("../../src/engine/domain/mobilityModel");
const roundModule = require("../../src/engine/solve/round");
const { haversineMeters } = require("../../src/utils/distance");

/** The real feasibility gate, captured before any test spies on it. */
const REAL_GATE = evaluate.gate;

/**
 * A facts object with its function-valued fields replaced by what they return at the pinned
 * instant. `simulatedAgentFacts` builds a fresh `environmentAt` closure per call, so two
 * calls are never the same function — but they must give the same answer.
 */
function evaluated(facts) {
  if (!facts || typeof facts !== "object") return facts;
  const out = {};
  for (const [key, value] of Object.entries(facts)) out[key] = typeof value === "function" ? { at: value(DECISION_TIME_MS) } : value;
  return out;
}

/** The resolved-configuration accessor `agentFactsFor` is handed by the snapshot loader. */
const configOf = (snapshot) => (name) => snapshot.resolve(name, {});

/**
 * A world with two simulated agents and one physical, the direct V1 demonstration
 * composition, and the same composition behind the fleet provider boundary.
 */
function fleetWorld() {
  const members = [
    member({ key: "a", robotId: "SIM-A", simulated: true, energy: true }),
    member({ key: "b", robotId: "SIM-B", simulated: true, energy: true, at: NEAR }),
    member({ key: "x", robotId: "RBX-1", simulated: false, energy: false }),
  ];
  const store = storeWith(members);
  const snapshot = snapshotWith(register());
  const direct = v1Composition.createV1DemonstrationComposition({ prisma: store.prisma, snapshot: () => snapshot, env: SIM_ENV });
  const roster = new Set(members.filter((m) => m.robot.simulated).map((m) => m.robot.robotId));
  const managesAgent = (subject) => [subject && subject.robotId, subject && subject.agentId].some((id) => roster.has(id));
  const simulation = simulationProvider.createSimulationProvider({ composition: direct, managesAgent });
  const physical = physicalProvider.createPhysicalProvider({ prisma: store.prisma, tenantId: profile.DEMONSTRATION_TENANT_ID });
  const fleet = fleetProviders.createFleetComposition({ simulation, physical });
  const byKey = Object.fromEntries(members.map((m) => [m.spec.key, m]));
  return { members, byKey, store, snapshot, direct, simulation, physical, fleet, managesAgent };
}

/** Agent snapshots as the coordinator's own loader builds them, through the given seams. */
async function loadSnapshots(world, seams) {
  const load = solvePath.agentSnapshotLoaderFor({ prisma: world.store.prisma, snapshot: world.snapshot, ...seams });
  const out = {};
  for (const m of world.members) out[m.spec.key] = await load(m.agent.id, { asOfMs: DECISION_TIME_MS });
  return out;
}

/** A planar execution request, for comparing the `directionsFor` functions two seams return. */
const SEGMENT = Object.freeze({ from: { lat: ORIGIN.lat, lon: ORIGIN.lon }, to: { lat: DROP.lat, lon: DROP.lon } });

async function comparable(value) {
  if (typeof value === "function") return { executes: await value(SEGMENT) };
  return value;
}

/* ═══════════════════════════════════════════════════════════════════════════
   1. SIMULATION EQUIVALENCE — what a simulated agent is handed does not change
   ═══════════════════════════════════════════════════════════════════════════ */

describe("1 — the dispatcher hands every agent exactly what the direct composition hands it", () => {
  test("the same seams, of the same kinds; the mission and round declarations are the same objects", () => {
    const { direct, fleet } = fleetWorld();

    expect(Object.keys(fleet).sort()).toEqual(Object.keys(direct).sort());
    expect([...fleetProviders.SEAMS].sort()).toEqual(Object.keys(direct).sort());
    for (const name of Object.keys(direct)) {
      expect({ name, kind: typeof fleet[name] }).toEqual({ name, kind: typeof direct[name] });
    }
    for (const name of fleetProviders.PASS_THROUGH) {
      expect({ name, same: fleet[name] === direct[name] }).toEqual({ name, same: true });
    }
  });

  test("every snapshot-keyed seam answers identically — simulated, physical, unlabelled and absent", async () => {
    const world = fleetWorld();
    const { direct, fleet, store } = world;
    const loaded = await loadSnapshots(world, direct);
    expect(loaded.a.provenance).toBe(SIMULATED);
    expect(loaded.x.provenance).toBe(PHYSICAL);

    const snapshots = [
      loaded.a,
      loaded.b,
      loaded.x,
      // A simulated unit of a different pack and speed — its own profile key.
      { ...loaded.a, mobilityModel: { speedModel: { nominalSpeedMps: 2.5 } }, energyModel: { packNominalWh: 500 } },
      { ...loaded.a, provenance: undefined },
      {},
      null,
    ];
    const stops = store.leg.stops.map((stop) => ({ ...stop, cellId: cells.cellForPoint(stop.lat, stop.lon, cells.RESOLUTION.FINE) }));
    const plan = { energyWh: 60, durationSeconds: 900 };

    const calls = {
      profileKeyFor: (s) => [s],
      agentEnergyDeclarationsFor: (s) => [s],
      vehicleMassKgFor: (s) => ["class-a", s],
      routeDescriptorFor: (s) => [{ agentSnapshot: s, stops, decisionTimeMs: DECISION_TIME_MS, horizonSeconds: 900 }],
      environmentForecastFor: (s) => [s],
      thermalStressMultiplierFor: (s) => [s],
      failureProbabilityFor: (s) => [s],
      batteryWearInputsFor: (s) => [s, plan],
      directionsFor: (s) => [s],
    };
    expect(Object.keys(calls).sort()).toEqual(Object.keys(fleetProviders.SNAPSHOT_SEAMS).sort());

    for (const [name, argsFor] of Object.entries(calls)) {
      for (const [index, snapshot] of snapshots.entries()) {
        const viaFleet = await comparable(fleet[name](...argsFor(snapshot)));
        const viaDirect = await comparable(direct[name](...argsFor(snapshot)));
        expect({ name, index, answer: viaFleet }).toEqual({ name, index, answer: viaDirect });
      }
    }
  });

  test("the robot-keyed seams — agent facts and environment — answer identically for both kinds", async () => {
    const { direct, fleet, members, snapshot } = fleetWorld();
    // The simulated environment reads the wall clock; pin it so both sides read the same instant.
    jest.spyOn(Date, "now").mockReturnValue(DECISION_TIME_MS);

    for (const m of members) {
      const input = { agent: m.agent, config: configOf(snapshot), asOfMs: DECISION_TIME_MS };
      expect({ robot: m.robot.robotId, facts: evaluated(await fleet.agentFactsFor(input)) }).toEqual({
        robot: m.robot.robotId,
        facts: evaluated(await direct.agentFactsFor(input)),
      });
      expect({ robot: m.robot.robotId, env: fleet.environmentFor(m.agent.agentId, m.agent) }).toEqual({
        robot: m.robot.robotId,
        env: direct.environmentFor(m.agent.agentId, m.agent),
      });
    }
    // An agent with no Robot row, and no agent at all.
    const orphan = { ...members[0].agent, robot: null };
    expect(await fleet.agentFactsFor({ agent: orphan })).toEqual(await direct.agentFactsFor({ agent: orphan }));
    expect(await fleet.agentFactsFor({})).toEqual(await direct.agentFactsFor({}));
    expect(fleet.environmentFor("nobody", undefined)).toEqual(direct.environmentFor("nobody", undefined));
  });

  test("the profile-keyed seams answer identically, and the SIMULATED namespace is the one the issuer uses", async () => {
    const world = fleetWorld();
    const { direct, fleet } = world;
    const loaded = await loadSnapshots(world, direct);
    const issued = direct.profileKeyFor(loaded.a);
    expect(issued.startsWith(simulationProvider.SIMULATED_PROFILE_NAMESPACE)).toBe(true);

    const keys = [issued, direct.profileKeyFor(loaded.b), "SIMULATED:v=2.5:wh=500", "SIMULATED:malformed", "GROUND", "PHYSICAL:class-x", "", null, undefined];
    for (const key of keys) {
      expect({ key, speed: fleet.speedMetresPerSecondFor(key) }).toEqual({ key, speed: direct.speedMetresPerSecondFor(key) });
      expect({ key, whPerMetre: fleet.returnLegEnergyWhPerMetreFor(key) }).toEqual({
        key,
        whPerMetre: direct.returnLegEnergyWhPerMetreFor(key),
      });
    }
  });

  test("a simulated route request reaches the wrapped composition's router unchanged; a physical one never does", async () => {
    const world = fleetWorld();
    const loaded = await loadSnapshots(world, world.direct);
    // A spy on the wrapped composition's own `route`, so the assertion is about what the
    // dispatcher forwards — the router behind it is exercised by the live scenario runs.
    const routeSpy = jest.spyOn(world.direct, "route").mockImplementation(async (parts) => ({ answeredFor: parts }));
    const originCell = cells.cellForPoint(ORIGIN.lat, ORIGIN.lon, cells.RESOLUTION.FINE);
    const destCell = cells.cellForPoint(DROP.lat, DROP.lon, cells.RESOLUTION.FINE);

    const simulatedParts = { originCell, destCell, profileKey: world.direct.profileKeyFor(loaded.a), timeBucket: 42 };
    const answer = await world.fleet.route(simulatedParts);
    expect(answer).toEqual({ answeredFor: simulatedParts });
    expect(routeSpy).toHaveBeenCalledTimes(1);
    expect(routeSpy.mock.calls[0][0]).toBe(simulatedParts);

    // The key a physical agent's traversal is cached under today (its traversal domain).
    for (const profileKey of ["GROUND", "PHYSICAL:class-x", null]) {
      await expect(world.fleet.route({ originCell, destCell, profileKey, timeBucket: 42 })).rejects.toMatchObject({
        name: "RouteRefusedError",
        refusal: ROUTE_REFUSAL.NOT_ROUTABLE,
      });
    }
    expect(routeSpy).toHaveBeenCalledTimes(1);
  });

  test("the plan-keyed route hazard answers identically", () => {
    const { direct, fleet } = fleetWorld();
    const plans = [{ route: { provenance: SIMULATED } }, { route: { provenance: "TEST DOUBLE" } }, { route: null }, {}, null];
    for (const [index, plan] of plans.entries()) {
      expect({ index, hazard: fleet.routeHazardCuFor(plan) }).toEqual({ index, hazard: direct.routeHazardCuFor(plan) });
    }
  });

  test("the charging scope through the boundary is the simulator's roster — synchronous or not", async () => {
    const world = fleetWorld();
    const subjects = [
      { robotId: "SIM-A", agentId: "SIM-A", agentRowId: "agent-a" },
      { robotId: "SIM-B", agentId: "SIM-B", agentRowId: "agent-b" },
      { robotId: "RBX-1", agentId: "RBX-1", agentRowId: "agent-x" },
      { robotId: null, agentId: "NOBODY", agentRowId: "agent-z" },
    ];
    const syncScope = fleetProviders.createChargingScope({ simulation: world.simulation, physical: world.physical });
    const asyncScope = fleetProviders.createChargingScope({
      simulation: simulationProvider.createSimulationProvider({ composition: world.direct, managesAgent: async (s) => world.managesAgent(s) }),
      physical: world.physical,
    });
    for (const subject of subjects) {
      const expected = { subject: subject.agentId, inScope: world.managesAgent(subject) };
      expect({ subject: subject.agentId, inScope: await syncScope(subject) }).toEqual(expected);
      expect({ subject: subject.agentId, inScope: await asyncScope(subject) }).toEqual(expected);
    }
  });

  test("the dispatcher is marked without adding a key the coordinator would receive", () => {
    const { direct, fleet } = fleetWorld();
    expect(fleetProviders.isFleetComposition(fleet)).toBe(true);
    expect(fleetProviders.isFleetComposition(direct)).toBe(false);
    // Spread — how `server.js` hands it to `leaderWorkers.create()` — carries no mark.
    const spread = { ...fleet };
    expect(Object.getOwnPropertySymbols(spread)).toEqual([]);
    expect(Object.keys(spread).sort()).toEqual(Object.keys(direct).sort());
  });

  test("the flag defaults off: only the string true selects the dispatcher", () => {
    expect(fleetProviders.isDispatchEnabled({})).toBe(false);
    for (const value of ["", "false", "0", "yes", "TRUEISH"]) {
      expect({ value, on: fleetProviders.isDispatchEnabled({ FLEET_PROVIDER_DISPATCH: value }) }).toEqual({ value, on: false });
    }
    expect(fleetProviders.isDispatchEnabled({ FLEET_PROVIDER_DISPATCH: "true" })).toBe(true);
    expect(fleetProviders.isDispatchEnabled({ FLEET_PROVIDER_DISPATCH: " TRUE " })).toBe(true);
  });

  test("composeIfEnabled keeps the V1 composition's own gate", () => {
    const prisma = storeWith([]).prisma;
    expect(fleetProviders.composeIfEnabled({ prisma, env: {} })).toEqual({});
    expect(fleetProviders.composeIfEnabled({ prisma, env: { V1_DEMONSTRATION_COMPOSITION: "true" } })).toEqual({});
    const composed = fleetProviders.composeIfEnabled({ prisma, snapshot: () => null, env: SIM_ENV });
    expect(fleetProviders.isFleetComposition(composed)).toBe(true);
    expect(Object.keys(composed).sort()).toEqual([...fleetProviders.SEAMS].sort());
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   2. PHYSICAL ABSENCE — real facts only, and none of the simulator's
   ═══════════════════════════════════════════════════════════════════════════ */

describe("2 — a physical agent receives what is real and nothing the simulator states", () => {
  test("agent facts: the derived half only — no control-plane fact, no simulated label anywhere", async () => {
    const { fleet, byKey, snapshot } = fleetWorld();
    const facts = await fleet.agentFactsFor({ agent: byKey.x.agent, config: configOf(snapshot), asOfMs: DECISION_TIME_MS });

    expect(Object.keys(facts).sort()).toEqual(
      ["healthTier", "provenance", "reservations", "safetyRelevantObservations", "session", "tenantId"].sort(),
    );
    expect(facts.provenance).toBe(PHYSICAL);
    for (const field of CONTROL_PLANE_FIELDS) expect({ field, present: field in facts }).toEqual({ field, present: false });
    // No acknowledged round trip and no link quality — the simulated link overlay is not applied.
    expect(Object.keys(facts.session).sort()).toEqual(["lastHeartbeatAt", "live"]);
    expect(flat(facts)).not.toContain(SIMULATED);
  });

  test("every other seam answers absent — battery, route, charging, environment, failure, hazard included", async () => {
    const world = fleetWorld();
    const { fleet, byKey, store } = world;
    const loaded = await loadSnapshots(world, fleet);
    const s = loaded.x;

    // The snapshot the engine would reason over: the same loader, and nothing simulated in it.
    expect(s.provenance).toBe(PHYSICAL);
    expect(s.soc).toBeNull();
    expect(s.kappa).toBeNull();
    expect(s.energyModelParams).toBeUndefined();
    for (const field of CONTROL_PLANE_FIELDS) expect({ field, present: field in s }).toEqual({ field, present: false });
    expect(flat({ ...s, _position: undefined })).not.toContain(SIMULATED);

    const stops = store.leg.stops.map((stop) => ({ ...stop, cellId: cells.cellForPoint(stop.lat, stop.lon, cells.RESOLUTION.FINE) }));
    expect(fleet.profileKeyFor(s)).toBeNull();
    expect(fleet.agentEnergyDeclarationsFor(s)).toBeNull();
    expect(fleet.routeDescriptorFor({ agentSnapshot: s, stops, decisionTimeMs: DECISION_TIME_MS, horizonSeconds: 900 })).toBeUndefined();
    expect(fleet.environmentForecastFor(s)).toBeUndefined();
    expect(fleet.thermalStressMultiplierFor(s)).toBeUndefined();
    expect(fleet.failureProbabilityFor(s)).toBeNull();
    expect(fleet.batteryWearInputsFor(s, { energyWh: 60, durationSeconds: 900 })).toBeNull();
    expect(fleet.directionsFor(s)).toBeUndefined();
    expect(fleet.environmentFor(byKey.x.agent.agentId, byKey.x.agent)).toBeNull();
    expect(fleet.speedMetresPerSecondFor("GROUND")).toBeUndefined();
    expect(fleet.returnLegEnergyWhPerMetreFor("GROUND")).toBeUndefined();
    expect(fleet.routeHazardCuFor({ route: undefined })).toBeNull();
    // The one commissioning column it is handed: the unit's own entered mass.
    expect(fleet.vehicleMassKgFor(s.agentClassId, s)).toBe(40);

    const scope = fleetProviders.createChargingScope({ simulation: world.simulation, physical: world.physical });
    expect(await scope({ robotId: "RBX-1", agentId: "RBX-1", agentRowId: "agent-x" })).toBe(false);
  });

  test("a physical route is refused by name and never reaches the simulation router", async () => {
    const world = fleetWorld();
    const routeSpy = jest.spyOn(world.direct, "route");
    const originCell = cells.cellForPoint(ORIGIN.lat, ORIGIN.lon, cells.RESOLUTION.FINE);
    const refusal = await world.fleet.route({ originCell, destCell: originCell, profileKey: "GROUND", timeBucket: 0 }).catch((e) => e);
    expect(refusal).toBeInstanceOf(RouteRefusedError);
    expect(refusal.message).toMatch(/no physical routing producer is composed/);
    expect(routeSpy).not.toHaveBeenCalled();
  });

  test("the physical provider refuses simulator-stated facts even if a call were misrouted to it", async () => {
    const { physical, byKey, snapshot } = fleetWorld();
    const input = { agent: byKey.a.agent, config: configOf(snapshot), asOfMs: DECISION_TIME_MS };
    expect(await physical.seams.agentFactsFor(input)).toBeNull();
  });

  test("the physical provider needs no simulator: a fleet without one answers physical-only, and absent", async () => {
    const world = fleetWorld();
    const physicalOnly = fleetProviders.createFleetComposition({
      physical: physicalProvider.createPhysicalProvider({ prisma: world.store.prisma, tenantId: profile.DEMONSTRATION_TENANT_ID }),
    });
    // No simulation provider: nothing is owned by it, and no simulated value exists to hand out.
    const input = { agent: world.byKey.a.agent, config: configOf(world.snapshot), asOfMs: DECISION_TIME_MS };
    expect(await physicalOnly.agentFactsFor(input)).toBeNull();
    expect(physicalOnly.profileKeyFor({ provenance: SIMULATED, mobilityModel: {}, energyModel: {} })).toBeNull();
    // Gate 1 (F05) — a physical-only process carries the round- and mission-level declarations
    // itself: present, and none of them is a simulator value.
    for (const name of fleetProviders.PASS_THROUGH) expect({ name, present: name in physicalOnly }).toEqual({ name, present: true });
    expect(flat(fleetProviders.PASS_THROUGH.map((name) => physicalOnly[name]))).not.toMatch(/DEVELOPMENT_SIMULATION/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   3. MIXED FLEET — one pipeline, and dispositions that follow data, not kind
   ═══════════════════════════════════════════════════════════════════════════ */

/** Wrap the round's exact evaluator so a test can see every agent it priced or refused. */
function recordEvaluations(assembly) {
  const seen = [];
  const real = assembly.round.evaluateExact;
  assembly.round.evaluateExact = async (agentId, leg, agentSnapshot) => {
    const result = await real(agentId, leg, agentSnapshot);
    seen.push({ agentId, agentSnapshot, result });
    return result;
  };
  return seen;
}

describe("3 — simulated and physical agents enter the same candidate pipeline", () => {
  test("five agents, one expansion; each stops exactly where its own data runs out", async () => {
    const members = [
      member({ key: "a", robotId: "SIM-A", simulated: true, energy: true }),
      member({ key: "b", robotId: "SIM-B", simulated: true, energy: true, at: NEAR }),
      // The physical RobotX as it is today: no BatteryState, no fitted β.
      member({ key: "x", robotId: "RBX-1", simulated: false, energy: false }),
      // CONTROL — a simulated agent missing exactly the same rows.
      member({ key: "c", robotId: "SIM-C", simulated: true, energy: false }),
      // TEST FIXTURE ONLY — a physical agent WITH energy rows, which no physical unit has
      // today. It shows the next step of the same pipeline, not a real state.
      member({ key: "y", robotId: "RBX-2", simulated: false, energy: true }),
    ];
    const store = storeWith(members);
    const snapshot = snapshotWith(register());
    const direct = v1Composition.createV1DemonstrationComposition({ prisma: store.prisma, snapshot: () => snapshot, env: SIM_ENV });
    // **TEST DOUBLE** for the simulation router only (it needs a pinned delivery domain);
    // every other simulation seam is the real one.
    const simulatedRouter = declaredRouter();
    const simulation = simulationProvider.createSimulationProvider({ composition: { ...direct, route: simulatedRouter } });
    const physical = physicalProvider.createPhysicalProvider({ prisma: store.prisma, tenantId: profile.DEMONSTRATION_TENANT_ID });
    const fleet = fleetProviders.createFleetComposition({ simulation, physical });

    const kv = await freshKv();
    const assembly = solvePath.create({ ...baseContext(store, kv), ...fleet });
    expect(assembly.ok).toBe(true);
    const seen = recordEvaluations(assembly);
    await indexAll(kv, members);

    const outcome = await expandOnce(assembly);

    // One expansion reached all five — the index, the loader and the lower bound do not ask.
    expect(outcome.agentsEvaluated).toBe(5);

    // The physical unit and its simulated control have the same gap and get the same answer.
    expect([...outcome.unresolvedBoundAgentIds].sort()).toEqual(["agent-c", "agent-x"]);
    const physicalEnergy = await assembly.round.energyFor("agent-x");
    const controlEnergy = await assembly.round.energyFor("agent-c");
    expect(physicalEnergy).toEqual(controlEnergy);
    expect(physicalEnergy.kappa).toBeNull();

    // The rest reach the same exact evaluator.
    const byAgent = Object.fromEntries(seen.map((row) => [row.agentId, row]));
    expect(Object.keys(byAgent).sort()).toEqual(["agent-a", "agent-b", "agent-y"]);
    expect(byAgent["agent-a"].agentSnapshot.provenance).toBe(SIMULATED);
    expect(byAgent["agent-y"].agentSnapshot.provenance).toBe(PHYSICAL);

    // The simulated two reach the feasibility gate and are judged on their data alike.
    expect(byAgent["agent-a"].result.refusal).toBe(solvePath.REFUSAL.INFEASIBLE);
    expect(byAgent["agent-b"].result.denials).toEqual(byAgent["agent-a"].result.denials);

    // The physical one stops at the first real gap past energy: it has no route, refused by
    // name by its own provider — never priced on the simulation router.
    expect(byAgent["agent-y"].result.refusal).toBe(solvePath.REFUSAL.MISSING_HOP);
    expect(byAgent["agent-y"].result.problems.join(" ")).toMatch(/no physical routing producer is composed/);
    expect(simulatedRouter.calls.length).toBeGreaterThan(0);
    for (const call of simulatedRouter.calls) expect(call.profileKey.startsWith("SIMULATED:")).toBe(true);

    // Same loader, same shape: every non-control-plane field a simulated snapshot carries,
    // the physical snapshot carries too — and it carries no control-plane fact at all.
    const simulatedKeys = Object.keys(byAgent["agent-a"].agentSnapshot).filter((key) => !CONTROL_PLANE_FIELDS.includes(key));
    for (const key of simulatedKeys) expect({ key, present: key in byAgent["agent-y"].agentSnapshot }).toEqual({ key, present: true });
    for (const field of CONTROL_PLANE_FIELDS) {
      expect({ field, present: field in byAgent["agent-y"].agentSnapshot }).toEqual({ field, present: false });
    }

    // No physical agent was priced, so none can be selected.
    expect(assembly.deps.pricedCandidateFor("agent-x", "leg-row-1", {})).toBeNull();
    expect(assembly.deps.pricedCandidateFor("agent-y", "leg-row-1", {})).toBeNull();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   4. PROVENANCE NEUTRALITY — identical facts, identical decisions
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * **TEST DOUBLE — a distance-aware router.** Hop length is the great-circle distance between
 * the two cells' centres, so an agent nearer the pickup is genuinely cheaper. Not a
 * traversal source; it exists so position, and only position, can separate two agents.
 */
function distanceRouter() {
  return async (parts) => {
    const a = cells.centreOfCell(parts.originCell);
    const b = cells.centreOfCell(parts.destCell);
    const distanceM = Math.max(20, haversineMeters(a.lat, a.lon, b.lat, b.lon));
    return { distanceM, travelSeconds: distanceM / 1.5, travelSdSeconds: distanceM / 15, climbM: 0, descentM: 0, stopStartCycles: 1 };
  };
}

/**
 * **TEST DOUBLE — a complete §7.5 fact set** (from `feasibilityFixture`, aligned to the V1
 * mission profile), identical for every agent it is asked about except for `provenance`.
 */
function fixedFacts(provenance) {
  const base = fx.agentSnapshot();
  const picked = {};
  for (const field of solvePath.AGENT_FACT_FIELDS) if (base[field] !== undefined) picked[field] = base[field];
  const at = (offsetMs) => new Date(DECISION_TIME_MS - offsetMs);
  return {
    ...picked,
    tenantId: profile.DEMONSTRATION_TENANT_ID,
    permittedTenants: [profile.DEMONSTRATION_TENANT_ID],
    session: { live: true, lastHeartbeatAt: at(2000), lastHeartbeatAckAt: at(2500), lastCommandRoundTripAt: at(3000), linkQuality: 0.9 },
    emergencyStop: { value: false, observedAt: at(1000), source: "SENSOR" },
    safetyRelevantObservations: {
      position: {
        stalenessBudgetMs: 10_000,
        observedAtMs: DECISION_TIME_MS - 1000,
        observation: { value: {}, observedAt: at(1000), source: "AGENT_REPORT", deadReckoned: false },
      },
    },
    calibrations: [],
    reservations: [],
    authorisedZoneIds: ["zone-1"],
    maintenance: { serviceDueAt: new Date(DECISION_TIME_MS + 30 * 86_400_000) },
    ...(provenance === undefined ? {} : { provenance }),
  };
}

/**
 * Two agents identical in every row and every fact, differing only in `Robot.simulated` and
 * the `provenance` label on their facts — and, where a test says so, in position.
 *
 * @param {{ labels: object, simulated: object, at?: object }} spec keyed `t1` / `t2`
 */
async function twinWorld(spec) {
  const twins = ["t1", "t2"].map((key, index) =>
    member({ key, robotId: `TWIN-${index + 1}`, simulated: spec.simulated[key], energy: true, at: (spec.at && spec.at[key]) || ORIGIN }),
  );
  for (const t of twins) {
    const agentClass = t.agent.agentClass;
    agentClass.firmwareVersionSet = { DELIVERY: ["2.4.1"] };
    agentClass.hardwareRevision = "rev-c";
    agentClass.mobilityModel.permissionSet = { surfaceClasses: ["FOOTWAY"] };
    agentClass.mobilityModel.envelopeConstraints = { environmental: { ambientC: { min: -10, max: 50, unit: "DEGREES_CELSIUS" } } };
    agentClass.containerModel = {
      totalMassLimitKg: 20,
      totalVolumeLitres: 30,
      cogEnvelope: {
        longitudinalMm: [-200, 200],
        lateralMm: [-150, 150],
        emptyVehicle: { massKg: 40, longitudinalMm: 0, lateralMm: 0 },
        compartmentCentroids: { "cmp-1": { longitudinalMm: 0, lateralMm: 0 } },
      },
      compartments: [{ id: "cmp-1", ...profile.SERVICE_ENVELOPE.compartment, maxMassKg: 20 }],
    };
  }

  const store = storeWith(twins);
  store.leg.stops = store.leg.stops.map((stop) => ({ ...stop, geofenceResult: "INSIDE", routable: true }));
  const depotCell = cells.cellForPoint(DROP.lat, DROP.lon, cells.RESOLUTION.FINE);
  store.prisma.charger.findMany = async () => [{ chargerId: "charger-depot-1", cellId: depotCell, isDepot: true, chargerClass: "DEPOT", regionId: null }];
  store.prisma.chargerAvailabilityProjection.findFirst = async () => ({
    version: 7,
    publishedAt: new Date(DECISION_TIME_MS - 30_000),
    horizonEnd: new Date(DECISION_TIME_MS + 7_200_000),
    payload: {
      chargers: [
        { chargerId: "charger-depot-1", isDepot: true, intervals: [{ fromMs: DECISION_TIME_MS - 60_000, untilMs: DECISION_TIME_MS + 7_200_000, state: "FREE" }] },
      ],
    },
  });

  const kv = await freshKv();
  const context = baseContext(store, kv, {
    "plan.commitment_horizon": 7200,
    "localisation.min_confidence": { CAMPUS: 0.85 },
    "localisation.max_odometry_divergence": 5,
    "link.min_quality": { AUTONOMOUS: 0.5 },
    "health.required_tier": { STANDARD: "NOMINAL" },
    "reliability.max_intervention_rate": { DELIVERY: 0.1 },
  });
  context.snapshot.spatial = {
    version: 1,
    regions: [{ id: "region-1" }],
    zones: [{ id: "zone-1", regionId: "region-1" }],
    sites: [],
    cells: [ORIGIN, NEAR, PICKUP, DROP].map((pt) => ({
      cellId: cells.cellForPoint(pt.lat, pt.lon, cells.RESOLUTION.FINE),
      resolution: cells.RESOLUTION.FINE,
      regionId: "region-1",
      zoneId: "zone-1",
    })),
  };

  const labelOf = (agent) => spec.labels[agent.agentId === "TWIN-1" ? "t1" : "t2"];
  // One seam set for both twins. Nothing here reads the label except to stamp it.
  const seams = {
    route: distanceRouter(),
    travelTimeSpread: { source: "TEST DOUBLE" },
    hopTerrainSource: { source: "TEST DOUBLE" },
    speedMetresPerSecondFor: () => 1.5,
    timeBucket: "tb",
    environmentFor: () => ({ ambientC: 20, packC: 22 }),
    vehicleMassKgFor: () => 40,
    returnLegEnergyWhPerMetreFor: () => 0.05,
    failureProbabilityFor: () => ({ probability: 0.01, provenance: "TEST DOUBLE" }),
    routeHazardCuFor: () => 0,
    batteryWearInputsFor: () => ({
      socThroughput: 0.2,
      curves: energyFixture.stressCurves(),
      conditions: { dod: 0.2, socMid: 0.8, tempC: 22, cRate: 0.5 },
    }),
    agentEnergyDeclarationsFor: () => ({ residualCv: 0.1, reserveFloorWh: 50, provenance: "TEST DOUBLE" }),
    missionProfileFor: profile.applyMissionProfile,
    defaultConsignmentFor: () => profile.consignmentFor(null),
    defaultStopAccessPrerequisites: profile.STOP_ACCESS_PREREQUISITES,
    routeDescriptorFor: ({ agentSnapshot, decisionTimeMs, horizonSeconds }) => ({
      provenance: "TEST DOUBLE",
      loaded: false,
      profileKey: routingProfileKey(agentSnapshot.mobilityModel, { loaded: false }),
      surfaceClasses: ["FOOTWAY"],
      constrictions: [],
      deadZoneExtentM: 0,
      zonesTraversed: ["zone-1"],
      zoneTraversals: [{ zoneId: "zone-1", enterMs: decisionTimeMs, exitMs: decisionTimeMs + horizonSeconds * 1000, restrictions: [] }],
    }),
    environmentForecastFor: () => ({ source: "FORECAST", provenance: "TEST DOUBLE", variables: { ambientC: { worstCase: 30 } } }),
    thermalStressMultiplierFor: () => 1,
    agentFactsFor: async ({ agent }) => fixedFacts(labelOf(agent)),
  };

  // Every verdict of every predicate, per agent, read beside the real gate.
  const verdicts = {};
  jest.spyOn(evaluate, "gate").mockImplementation((candidate, gateContext, options) => {
    verdicts[gateContext.agentSnapshot.agentId] = evaluate.evaluateCandidate(gateContext, { collectAll: true }).verdicts;
    return REAL_GATE(candidate, gateContext, options);
  });

  const assembly = solvePath.create({ ...context, ...seams });
  if (!assembly.ok) throw new Error(`create() refused: ${assembly.blockedBy}`);
  const seen = recordEvaluations(assembly);
  await indexAll(kv, twins);
  return { assembly, seen, verdicts };
}

/** §9's solve over the round's own priced columns — the assignment decision, not committed. */
async function solveOnce(assembly) {
  assembly.deps.planState.beginRound("round-1");
  return roundModule.plan(
    {
      expandCandidates: assembly.deps.expandCandidates,
      pricedCandidateFor: assembly.deps.pricedCandidateFor,
      planState: assembly.deps.planState,
      deferPriceFor: assembly.deps.deferPriceFor,
    },
    {
      roundId: "round-1",
      shardId: SHARD_ID,
      decisionTimeMs: DECISION_TIME_MS,
      legs: [
        {
          legId: "leg-row-1",
          priority: 0,
          purpose: "PRIMARY",
          slaClass: null,
          expansionInput: assembly.deps.expansionInputFor({ legId: "leg-row-1", shardId: SHARD_ID, enqueuedAt: new Date(Date.now() - 60_000) }),
        },
      ],
      config: {},
      killSwitches: {},
      snapshot: { snapshotId: "round-1" },
    },
  );
}

/** A value with the twins' two identities folded to one, so "identical but for identity" is a string compare. */
function anonymous(value) {
  return flat(value)
    .replace(/TWIN-[12]/g, "TWIN")
    .replace(/agent-t[12]/g, "agent-twin")
    .replace(/robot-t[12]/g, "robot-twin")
    .replace(/class-t[12]/g, "class-twin");
}

describe("4 — provenance is not an assignment preference", () => {
  test("predicate layer: all 38 verdicts are identical whatever the provenance label", () => {
    const labels = [SIMULATED, PHYSICAL, "PHYSICAL", "SIMULATED", undefined];
    const results = labels.map((label) => {
      const context = fx.context();
      if (label === undefined) delete context.agentSnapshot.provenance;
      else context.agentSnapshot.provenance = label;
      return evaluate.evaluateCandidate(context, { collectAll: true });
    });
    for (const [index, result] of results.entries()) {
      expect({ label: labels[index], feasible: result.feasible }).toEqual({ label: labels[index], feasible: true });
      expect(Object.keys(result.verdicts)).toHaveLength(38);
      expect(flat(result.verdicts)).toBe(flat(results[0].verdicts));
    }
  });

  test("pipeline: identical twins get identical verdicts, plan, Φ and γ — through the real gate, Plan Builder and pricing", async () => {
    const { assembly, seen, verdicts } = await twinWorld({
      labels: { t1: SIMULATED, t2: PHYSICAL },
      simulated: { t1: true, t2: false },
    });
    await expandOnce(assembly);

    const [one, two] = ["agent-t1", "agent-t2"].map((id) => seen.find((row) => row.agentId === id));
    expect(one.agentSnapshot.provenance).toBe(SIMULATED);
    expect(two.agentSnapshot.provenance).toBe(PHYSICAL);

    // Feasible, both, on every one of the 38 — and the same verdicts.
    expect(one.result.feasible).toBe(true);
    expect(two.result.feasible).toBe(true);
    expect(Object.keys(verdicts["TWIN-1"])).toHaveLength(38);
    expect(Object.values(verdicts["TWIN-1"]).every((v) => v.outcome === "SATISFIED")).toBe(true);
    expect(anonymous(verdicts["TWIN-2"])).toBe(anonymous(verdicts["TWIN-1"]));

    // The same price, to the milli-CU.
    expect(typeof one.result.gammaMilliCU).toBe("bigint");
    expect(two.result.gammaMilliCU).toBe(one.result.gammaMilliCU);

    // The same plan, mission and Φ inputs.
    const pricedOne = assembly.deps.pricedCandidateFor("agent-t1", "leg-row-1", {});
    const pricedTwo = assembly.deps.pricedCandidateFor("agent-t2", "leg-row-1", {});
    expect(pricedOne).not.toBeNull();
    expect(anonymous(pricedTwo)).toBe(anonymous(pricedOne));
  });

  test("D1: a priced entry written by the real pipeline carries the authority epoch of the snapshot it was priced from", async () => {
    const { assembly, seen } = await twinWorld({
      labels: { t1: SIMULATED, t2: PHYSICAL },
      simulated: { t1: true, t2: false },
    });
    await expandOnce(assembly);

    for (const id of ["agent-t1", "agent-t2"]) {
      const evaluated = seen.find((row) => row.agentId === id);
      const priced = assembly.deps.pricedCandidateFor(id, "leg-row-1", {});
      expect(evaluated.agentSnapshot.authorityEpoch).not.toBeUndefined();
      expect(evaluated.agentSnapshot.authorityEpoch).not.toBeNull();
      // G3's pin (`commitFor`) is this value, never a read made at commit time.
      expect(priced.authorityEpoch).toBe(evaluated.agentSnapshot.authorityEpoch);
    }
  });

  test("assignment: swapping the labels between identical twins does not move the decision", async () => {
    const decide = async (labels, simulated) => {
      const world = await twinWorld({ labels, simulated });
      const planned = await solveOnce(world.assembly);
      return {
        assigned: planned.assignments.map((row) => row.agentId),
        gammas: world.seen.map((row) => [row.agentId, String(row.result.gammaMilliCU)]).sort(),
      };
    };
    const asLabelled = await decide({ t1: SIMULATED, t2: PHYSICAL }, { t1: true, t2: false });
    const swapped = await decide({ t1: PHYSICAL, t2: SIMULATED }, { t1: false, t2: true });

    expect(asLabelled.assigned).toHaveLength(1);
    expect(swapped).toEqual(asLabelled);
  });

  test("assignment: the objectively cheaper agent wins, whichever kind it is", async () => {
    const decide = async (labels, simulated, at) =>
      (await solveOnce((await twinWorld({ labels, simulated, at })).assembly)).assignments.map((row) => row.agentId);

    const nearOne = { t1: NEAR, t2: ORIGIN };
    const nearTwo = { t1: ORIGIN, t2: NEAR };
    // The twin nearer the pickup wins — physical or simulated.
    expect(await decide({ t1: PHYSICAL, t2: SIMULATED }, { t1: false, t2: true }, nearOne)).toEqual(["TWIN-1"]);
    expect(await decide({ t1: SIMULATED, t2: PHYSICAL }, { t1: true, t2: false }, nearOne)).toEqual(["TWIN-1"]);
    expect(await decide({ t1: PHYSICAL, t2: SIMULATED }, { t1: false, t2: true }, nearTwo)).toEqual(["TWIN-2"]);
    expect(await decide({ t1: SIMULATED, t2: PHYSICAL }, { t1: true, t2: false }, nearTwo)).toEqual(["TWIN-2"]);
  });
});
