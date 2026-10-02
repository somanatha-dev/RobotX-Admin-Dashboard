"use strict";

/**
 * B1 test world — a store double with several agents and Legs, every read counted, every row
 * mutable between planning and commit. Built on the same pattern as
 * `coordinatorSolvePathComposition.test.js`'s `storeWith`/`completeContext`: a double for the
 * **store**, never for an engine module. Rows are in the shape `prisma/schema.prisma` declares
 * and each read returns a deep copy, as Prisma does, so a test can change the store after a
 * read and observe whether a later stage read it again.
 *
 * It answers the per-agent loader (`agentCellPosition.findFirst` with the snapshot include),
 * the batched planning reads (`agentCellPosition.findMany` by shard, `agentClass.findMany` by
 * the shard relation filter, `leg.findMany` by id/business id, `commitment.findMany` by Leg),
 * the charger estate and projection, and — through `txDouble` — the §10.3.2 transaction.
 *
 * **TEST DOUBLES throughout. No value here is a fleet measurement or a proposal.**
 */

const service = require("../../../src/engine/config/service");
const cells = require("../../../src/engine/spatial/cells");
const consumption = require("../../../src/engine/energy/consumption");
const energyFixture = require("./energyFixture");

const SHARD_ID = "shard-b1";
const DECISION_TIME_MS = Date.UTC(2026, 8, 4, 12, 0, 0);
const ORIGIN = { lat: 12.9716, lon: 77.5946 };
const PICKUP = { lat: 12.9724, lon: 77.5951 };
const DROP = { lat: 12.9731, lon: 77.596 };

/** A router-shaped function with fixed numbers. Not a traversal source. */
function declaredRouter() {
  const calls = [];
  const route = async (parts) => {
    calls.push(parts);
    return { distanceM: 800, travelSeconds: 400, travelSdSeconds: 20, climbM: 6, descentM: 3, stopStartCycles: 4 };
  };
  route.calls = calls;
  return route;
}

/** The real default snapshot with named parameters overridden in this object only. */
function snapshotWith(overrides, extras) {
  const real = service.defaultSnapshot();
  const map = overrides || {};
  return Object.assign(Object.create(Object.getPrototypeOf(real)), real, extras || {}, {
    resolve: (name, context, options) =>
      Object.prototype.hasOwnProperty.call(map, name) ? map[name] : real.resolve(name, context, options),
    explain: (name, context, options) => {
      if (!Object.prototype.hasOwnProperty.call(map, name)) return real.explain(name, context, options);
      return { ...real.explain(name, context, options), value: map[name] };
    },
  });
}

/** The smallest resolvable register the composition accepts (as the composition test's). */
function resolvableRegister(extra) {
  return {
    "candidate.max_radius_by_sla_class": 5000,
    "candidate.max_expansion_tiers": 2,
    "candidate.target_feasible": 1,
    "candidate.max_evaluated": 8,
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
    capacity: 1,
    ...(extra || {}),
  };
}

function energyModelParamsRow(version, scale) {
  const fitted = energyFixture.energyModelParams();
  const k = scale || 1;
  return {
    agentClassId: "class-row-1",
    modelVersion: version || 1,
    betaDist: fitted[consumption.COEFFICIENT.DIST] * k,
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

/** A deep copy that keeps BigInt and Date, as a fresh Prisma read would hand back. */
const copy = (value) => (value === null || value === undefined ? value : structuredClone(value));

/**
 * @param {object} [options]
 * @param {number} [options.agents] how many agents (default 2), placed around ORIGIN
 * @param {boolean} [options.omitBatteryFor] agent index with no BatteryState row
 * @param {object[]} [options.chargers] `Charger` rows
 * @param {object[]} [options.projections] projection rows
 */
function b1Store(options) {
  const settings = options || {};
  const agentCount = settings.agents === undefined ? 2 : settings.agents;
  const calls = {};
  const count = (name) => {
    calls[name] = (calls[name] || 0) + 1;
  };

  const agentClass = {
    id: "class-row-1",
    classId: "class-b1",
    firmwareVersionSet: null,
    hardwareRevision: "rev-a",
    mobilityModelId: "mobility-row-1",
    energyModelId: "energy-row-1",
    containerModelId: null,
    capabilityBundleId: null,
    mobilityModel: { id: "mobility-row-1", kinematicLimits: { maxSpeedMs: 2 }, traversalDomain: "GROUND" },
    energyModel: {
      id: "energy-row-1",
      packNominalWh: 1000,
      chargePowerCurve: energyFixture.chargePowerCurve(),
      thermalDeratingCurve: energyFixture.thermalDeratingCurve(),
    },
    containerModel: null,
    capabilityBundle: null,
    // Newest first, take 1 — what the include's `orderBy: desc, take: 1` returns.
    energyModelParams: [energyModelParamsRow(2, 1.02)],
  };

  const agents = [];
  const positions = [];
  for (let i = 0; i < agentCount; i += 1) {
    // Agents spread over a few metres so they share a cell or sit in the first ring.
    const lat = ORIGIN.lat + i * 0.00002;
    const lon = ORIGIN.lon + i * 0.00002;
    const fineCellId = cells.cellForPoint(lat, lon, cells.RESOLUTION.FINE);
    const agent = {
      id: `agent-row-${i + 1}`,
      agentId: `agent-${i + 1}`,
      robotDbId: `robot-row-${i + 1}`,
      lifecycleState: "ACTIVE",
      authorityEpoch: 3n,
      fenceCounter: 7n,
      capacityOverride: null,
      tenantId: "tenant-a",
      fleetId: null,
      agentClassId: agentClass.id,
      regionId: null,
      homeDepotId: null,
      robot: { id: `robot-row-${i + 1}`, robotId: `R-${i + 1}`, massKg: 60, isOnline: true, status: "IDLE", simulated: true },
      batteryState:
        settings.omitBatteryFor === i
          ? null
          : { agentId: `agent-row-${i + 1}`, kappa: 1 + i / 100, lastObservedSoc: 0.9 - i / 100, soh: 0.95, kappaSampleCount: 10, kappaUpdatedAt: new Date(DECISION_TIME_MS) },
      commitments: [],
    };
    agents.push(agent);
    positions.push({
      id: `pos-${i + 1}`,
      agentId: agent.id,
      shardId: SHARD_ID,
      lat,
      lon,
      fineCellId,
      coarseCellId: cells.coarseParentOf(fineCellId),
      availabilityClass: "IDLE_READY",
      capabilityClasses: [],
      containerClasses: [],
      observedAtMs: BigInt(DECISION_TIME_MS),
    });
  }

  const makeLeg = (n, version) => ({
    id: `leg-row-${n}`,
    legId: `leg-${n}`,
    missionId: `mission-row-${n}`,
    purpose: "PRIMARY",
    state: "QUEUED",
    custodyState: "NONE",
    version,
    cancelRequestedAt: null,
    obstructionClass: null,
    slaDeadline: new Date(DECISION_TIME_MS + 3_600_000),
    startNotBefore: null,
    createdAt: new Date(DECISION_TIME_MS - 60_000),
    manifests: [],
    mission: { id: `mission-row-${n}`, missionId: `mission-${n}`, legs: [{ id: `leg-row-${n}`, sequence: 1 }], tasks: [] },
    stops: [
      { stopId: `stop-${n}-1`, sequence: 1, stopType: "PICKUP", siteId: "site-a", lat: PICKUP.lat, lon: PICKUP.lon, accessConstraints: null, geofenceResult: null },
      { stopId: `stop-${n}-2`, sequence: 2, stopType: "DROP", siteId: "site-b", lat: DROP.lat, lon: DROP.lon, accessConstraints: null, geofenceResult: null },
    ],
  });
  const legs = [makeLeg(1, 0), makeLeg(2, 4)];
  const history = []; // Commitment rows: { legId, agentId, releasedAt }
  const chargers = settings.chargers || [];
  const projections = settings.projections || [];

  const agentById = (id) => agents.find((a) => a.id === id) || null;
  /** The position row with the snapshot include applied, as Prisma assembles it. */
  const included = (position) => {
    const agent = agentById(position.agentId);
    return copy({
      ...position,
      agent: { ...agent, agentClass: agent.agentClassId ? agentClass : null, commitments: agent.commitments.filter((c) => !c.releasedAt) },
    });
  };
  const positionMatches = (position, where) => {
    if (!where) return true;
    if (where.shardId !== undefined && position.shardId !== where.shardId) return false;
    if (where.OR) {
      const agent = agentById(position.agentId);
      return where.OR.some((clause) =>
        (clause.agentId !== undefined && position.agentId === clause.agentId) ||
        (clause.agent && clause.agent.agentId !== undefined && agent && agent.agentId === clause.agent.agentId));
    }
    return true;
  };
  const legMatches = (leg, wanted) => wanted.some((id) => leg.id === id || leg.legId === id);
  const scalars = (row) => Object.fromEntries(Object.entries(row).filter(([, v]) => v === null || typeof v !== "object" || v instanceof Date));
  const inList = (condition) => (condition && condition.in ? condition.in : [condition]);
  const classModels = () => (settings.failClassRead ? Promise.reject(new Error("TEST DOUBLE — class read failed")) : null);

  const prisma = {
    __calls: calls,
    agentCellPosition: {
      findFirst: async (query) => {
        count("agentCellPosition.findFirst");
        const hit = positions.find((p) => positionMatches(p, query && query.where));
        return hit ? included(hit) : null;
      },
      findMany: async (query) => {
        count("agentCellPosition.findMany");
        return positions.filter((p) => positionMatches(p, query && query.where)).map(included);
      },
    },
    agent: {
      findMany: async (query) => {
        count("agent.findMany");
        const where = query && query.where && query.where.cellPosition ? query.where.cellPosition.is : null;
        const ids = new Set(positions.filter((p) => positionMatches(p, where)).map((p) => p.agentId));
        return agents.filter((a) => ids.has(a.id)).map((a) => copy(scalars(a)));
      },
    },
    robot: {
      findMany: async (query) => {
        count("robot.findMany");
        const ids = inList(query.where.id);
        return agents.filter((a) => a.robot && ids.includes(a.robot.id)).map((a) => copy(a.robot));
      },
    },
    batteryState: {
      findMany: async (query) => {
        count("batteryState.findMany");
        const ids = inList(query.where.agentId);
        return agents.filter((a) => a.batteryState && ids.includes(a.id)).map((a) => copy(a.batteryState));
      },
    },
    shard: {
      findMany: async (query) => {
        count("shard.findMany");
        const ids = inList(query.where.shardId);
        return ids.includes(SHARD_ID) ? [{ shardId: SHARD_ID, regionId: "region-row-1" }] : [];
      },
    },
    agentClass: {
      findMany: async () => {
        count("agentClass.findMany");
        if (settings.failClassRead) throw new Error("TEST DOUBLE — class read failed");
        return [copy(agentClass)];
      },
    },
    mobilityModel: { findMany: async () => (count("mobilityModel.findMany"), classModels() || [copy(agentClass.mobilityModel)]) },
    energyModel: { findMany: async () => (count("energyModel.findMany"), classModels() || [copy(agentClass.energyModel)]) },
    energyModelParams: { findMany: async () => (count("energyModelParams.findMany"), classModels() || agentClass.energyModelParams.map(copy)) },
    containerModel: { findMany: async () => (count("containerModel.findMany"), classModels() || []) },
    capabilityBundle: { findMany: async () => (count("capabilityBundle.findMany"), classModels() || []) },
    leg: {
      findFirst: async (query) => {
        count("leg.findFirst");
        const wanted = ((query && query.where && query.where.OR) || []).map((row) => row.legId || row.id);
        return copy(legs.find((leg) => legMatches(leg, wanted)) || null);
      },
      findMany: async (query) => {
        count("leg.findMany");
        const or = (query && query.where && query.where.OR) || [];
        const wanted = or.flatMap((clause) => (clause.id ? clause.id.in : clause.legId ? clause.legId.in : []));
        return legs.filter((leg) => legMatches(leg, wanted)).map(copy);
      },
    },
    mission: {
      findMany: async (query) => {
        count("mission.findMany");
        const or = (query && query.where && query.where.legs && query.where.legs.some && query.where.legs.some.OR) || [];
        const wanted = or.flatMap((clause) => (clause.id ? clause.id.in : clause.legId ? clause.legId.in : []));
        return legs.filter((leg) => legMatches(leg, wanted) && leg.mission).map((leg) => copy(leg.mission));
      },
    },
    commitment: {
      findMany: async (query) => {
        count("commitment.findMany");
        const where = (query && query.where) || {};
        if (where.agentId !== undefined) {
          const ids = inList(where.agentId);
          return agents
            .filter((a) => ids.includes(a.id))
            .flatMap((a) => a.commitments.filter((c) => !c.releasedAt).map((c) => copy({ agentId: a.id, ...c })));
        }
        const legIds = where.legId && where.legId.in ? where.legId.in : [where.legId];
        return history
          .filter((row) => legIds.includes(row.legId))
          .map((row) => (where.legId && where.legId.in ? { agentId: row.agentId, releasedAt: row.releasedAt, legId: row.legId } : { agentId: row.agentId, releasedAt: row.releasedAt }));
      },
    },
    charger: {
      findMany: async () => {
        count("charger.findMany");
        return chargers.map(copy);
      },
    },
    chargerAvailabilityProjection: {
      findFirst: async () => {
        count("chargerAvailabilityProjection.findFirst");
        if (projections.length === 0) return null;
        return copy([...projections].sort((a, b) => b.version - a.version)[0]);
      },
    },
  };

  /**
   * The §10.3.2 transaction double: rows locked FOR UPDATE are the store's current rows, the
   * leadership row is the one given, and every write is recorded — so a test can assert that
   * an aborted commit wrote nothing.
   */
  function txDouble(opts) {
    const o = opts || {};
    const writes = [];
    const tx = {
      __writes: writes,
      commitment: {
        findUnique: async () => null,
        findMany: async ({ where }) => copy(agentById(where.agentId) ? agentById(where.agentId).commitments.filter((c) => !c.releasedAt) : []),
        create: async ({ data }) => {
          writes.push(["commitment.create", data]);
          return data;
        },
      },
      agent: { update: async (args) => writes.push(["agent.update", args]) },
      leg: { updateMany: async (args) => (writes.push(["leg.updateMany", args]), { count: 1 }) },
      agentFenceAudit: { upsert: async (args) => writes.push(["agentFenceAudit.upsert", args]) },
      $queryRawUnsafe: async (sql) => {
        if (/FROM "ShardLeadership"/.test(sql)) return [{ shardId: SHARD_ID, leadershipFence: 1n, holder: "h", leaseExpiry: new Date(DECISION_TIME_MS + 3_600_000) }];
        if (/SELECT NOW\(\)/.test(sql)) return [{ now: new Date(o.storeTimeMs || DECISION_TIME_MS + 1000) }];
        throw new Error(`txDouble: unexpected SQL ${sql}`);
      },
    };
    const selectForUpdate = async (_tx, table, _column, value) => {
      if (table === "Agent") {
        const agent = agentById(value);
        return agent ? copy({ ...agent, ...(o.agentAtLock || {}) }) : null;
      }
      if (table === "Leg") {
        const leg = legs.find((l) => l.id === value);
        return leg ? copy(leg) : null;
      }
      return null;
    };
    return { tx, writes, selectForUpdate, runSerializable: async (_client, fn) => fn(tx) };
  }

  return {
    prisma,
    calls,
    agents,
    positions,
    legs,
    history,
    agentClass,
    txDouble,
    fineCellIds: positions.map((p) => p.fineCellId),
  };
}

/** A composition context over the store, in which every declared input resolves. */
function b1Context(store, overrides) {
  const settings = overrides || {};
  return {
    snapshot: snapshotWith(resolvableRegister(settings.register), { spatial: null }),
    prisma: store.prisma,
    kv: settings.kv,
    shardId: SHARD_ID,
    regionId: "region-1",
    instanceId: "instance-1",
    route: declaredRouter(),
    travelTimeSpread: { source: "TEST DOUBLE" },
    speedMetresPerSecondFor: () => 2,
    hopTerrainSource: { source: "TEST DOUBLE" },
    timeBucket: settings.timeBucket || "b1-bucket",
    environmentFor: () => ({ ambientC: 20, packC: 22 }),
    vehicleMassKgFor: () => 60,
    returnLegEnergyWhPerMetreFor: () => 0.05,
    failureProbabilityFor: () => ({ probability: 0.01, provenance: "TEST DOUBLE" }),
    routeHazardCuFor: () => 0,
    batteryWearInputsFor: () => ({
      socThroughput: 0.2,
      curves: energyFixture.stressCurves(),
      conditions: { dod: 0.2, socMid: 0.8, tempC: 22, cRate: 0.5 },
    }),
    runSerializable: async (client, fn) => fn(client),
    selectForUpdate: async () => null,
    signingKey: "test-only-signing-key",
    values: new Map(),
    record: () => {},
    ...(settings.context || {}),
  };
}

module.exports = {
  SHARD_ID,
  DECISION_TIME_MS,
  ORIGIN,
  PICKUP,
  DROP,
  declaredRouter,
  snapshotWith,
  resolvableRegister,
  energyModelParamsRow,
  b1Store,
  b1Context,
};
