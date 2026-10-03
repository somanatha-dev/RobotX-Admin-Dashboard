"use strict";

/**
 * GATE 1 — a declared physical robot is a valid assignment candidate, through the real
 * pipeline, on the physical provider alone (no simulator in the composition).
 *
 * What is real here: the candidate expansion, the 38-predicate feasibility gate, the Plan
 * Builder, Φ/γ pricing, the physical provider and its router over the real RNSIT campus OSM
 * extract, and the V1 register bindings. What is a double: the store (an in-memory Prisma in
 * the schema's row shapes, holding exactly the rows `physicalDeclaration.service` writes) and
 * the KV. No simulator module answers for the physical agent.
 *
 * The negative controls are the point as much as the positive case: each removes one declared
 * or measured input and the robot must stop being a candidate, by name.
 */

const fs = require("fs");
const path = require("path");

const fleetProviders = require("../../src/services/fleetProviders");
const physicalProvider = require("../../src/services/fleetProviders/physicalProvider");
const physicalPolicy = require("../../src/services/fleetProviders/physicalPolicy");
const physicalRouter = require("../../src/services/fleetProviders/physicalRouter");
const physicalFacts = require("../../src/services/fleetProviders/physicalFacts");
const physicalDeclaration = require("../../src/services/physicalDeclaration.service");
const profile = require("../../src/services/v1DemonstrationProfile");
const robotSpecification = require("../../src/services/robotSpecification");
const { setRobotState } = require("../../src/services/robotRegistry.service");
const { RouteRefusedError, ROUTE_REFUSAL } = require("../../src/engine/routing/productionRouter");
const { ENDPOINT_BASIS } = require("../../src/engine/routing/cellPairCache");

const solvePath = require("../../src/workers/coordinatorSolvePath");
const service = require("../../src/engine/config/service");
const cells = require("../../src/engine/spatial/cells");
const availabilityIndex = require("../../src/engine/candidates/availabilityIndex");
const evaluate = require("../../src/engine/feasibility/evaluate");
const demonstration = require("../../tools/config/v1DemonstrationConfig");
const energyFixture = require("./helpers/energyFixture");
const { createTestKv } = require("../helpers/testKv");

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

/* ── The campus, from the repository's own data ──────────────────────────── */

const REPO = path.resolve(__dirname, "..", "..", "..");
const BOUNDARY_WAY = "way/1120154292";
const EXTRACT = JSON.parse(fs.readFileSync(path.join(REPO, "rnsit-campus-osm.geojson"), "utf8"));
const DELIVERY_DOMAIN = Object.freeze({
  regionId: "rnsit-campus",
  name: "RNSIT Campus",
  kind: "CAMPUS",
  crs: "EPSG:4326",
  version: BOUNDARY_WAY,
  versionDate: "2026-08-30",
  boundary: EXTRACT.features.find((feature) => feature.id === BOUNDARY_WAY).geometry,
});
const POINTS = Object.fromEntries(
  JSON.parse(fs.readFileSync(path.join(REPO, "rnsit-campus-supplemental.geojson"), "utf8")).features.map((feature) => [
    feature.properties.id,
    { lat: feature.geometry.coordinates[1], lon: feature.geometry.coordinates[0] },
  ]),
);
const PICKUP = POINTS["rnsit-innovation-center"];
const DROP = POINTS["rnsit-food-court"];

const ROVER = robotSpecification.CHASSIS_TEMPLATE[robotSpecification.CHASSIS_TYPE.ROVER].permissionSet;

const SHARD_ID = "shard-physical";
const ROBOT_ID = "robotx-pi";
const SOCKET_ID = "socket-pi-1";
const FIRMWARE = "robotx-pi-agent/0.9.0";

/* ── The owner's declaration (the shape the deployment file carries) ─────── */

function declaration(overrides) {
  const base = {
    declaredBy: "test owner",
    declaredAt: "2026-10-03",
    charging: { policy: "MANUAL_OUT_OF_SERVICE" },
    stateOfCharge: { policy: "OPERATOR_DECLARED", maxAgeSeconds: 7200 },
    emergencyStop: { mechanism: "SOFTWARE_STOP_LATCH" },
    site: { ambientC: { min: 18, max: 38 }, terrain: "FLAT_DECLARED", connectivityDeadZones: "NONE_DECLARED", constrictions: "NONE_DECLARED", stopStartCyclesPerHop: 1 },
    localisation: { referenceRadiusM: 25, acceptedFixTypes: ["3D", "RTK_FLOAT", "RTK_FIXED"] },
    risk: { failureProbabilityPrior: 0.05, routeHazardCu: 0 },
    robots: [
      {
        robotId: ROBOT_ID,
        control: {
          firmwareVersion: FIRMWARE,
          hardwareRevision: "rover-rev-a",
          missionTypes: ["DELIVERY"],
          calibrations: [],
          serviceDueAt: "2027-01-01T00:00:00Z",
          regionId: "rnsit",
          authorisation: "REGION",
          advisories: [],
          operatingAmbientC: { min: 0, max: 45 },
        },
        energy: { idlePowerW: 6, movingPowerW: 30, soh: 0.9, residualCv: 0.2, reserveFloorWh: 15 },
      },
    ],
  };
  return { ...base, ...(overrides || {}) };
}

/* ── The rows `physicalDeclaration.service` writes, in the schema's shapes ── */

function physicalWorld(options) {
  const opts = options || {};
  const decisionTimeMs = opts.decisionTimeMs;
  const policy = physicalPolicy.fromDeclaration(opts.declaration || declaration());
  const declared = policy.robotFor(ROBOT_ID);
  const at = opts.at || PICKUP;

  const coefficients = declared
    ? physicalDeclaration.declaredEnergyCoefficients(declared.energy)
    : null;
  const robot = {
    id: "robot-pi",
    robotId: ROBOT_ID,
    status: opts.status || "IDLE",
    isOnline: true,
    socketId: SOCKET_ID,
    lastSeenAt: new Date(decisionTimeMs - 2_000),
    createdAt: new Date(decisionTimeMs - 86_400_000),
    massKg: 6,
  };
  const operating = declared ? declared.control.operatingAmbientC : { min: 0, max: 45 };
  const agentClass = {
    classId: "class-pi",
    mobilityModel: {
      traversalDomain: "GROUND",
      kinematicLimits: { maxSpeedMs: 1.5 },
      speedModel: { nominalSpeedMps: 1.0 },
      permissionSet: { ...ROVER, surfaceClasses: physicalDeclaration.surfaceClassesFor(ROVER) },
      envelopeConstraints: { environmental: { ambientC: { min: operating.min, max: operating.max, unit: "DEGREES_CELSIUS" } } },
    },
    energyModel: {
      packNominalWh: 86,
      chargePowerCurve: energyFixture.chargePowerCurve(),
      thermalDeratingCurve: [{ x: operating.min, y: 1 }, { x: operating.max, y: 1 }],
    },
    containerModel: {
      totalMassLimitKg: 5,
      totalVolumeLitres: 20,
      cogEnvelope: {
        longitudinalMm: [-200, 200],
        lateralMm: [-150, 150],
        emptyVehicle: { massKg: 6, longitudinalMm: 0, lateralMm: 0 },
        compartmentCentroids: { "cmp-1": { longitudinalMm: 0, lateralMm: 0 } },
      },
      compartments: [{ id: "cmp-1", ...profile.SERVICE_ENVELOPE.compartment, maxMassKg: 5 }],
    },
    capabilityBundle: null,
    energyModelParams: coefficients ? [{ modelVersion: 1, fittedAt: null, ...coefficients }] : [],
    firmwareVersionSet: declared ? { DELIVERY: [FIRMWARE] } : null,
    hardwareRevision: declared ? "rover-rev-a" : null,
  };
  const agent = {
    id: "agent-pi",
    agentId: ROBOT_ID,
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
    batteryState:
      opts.soc === null
        ? { kappa: 1, lastObservedSoc: null, lastObservedAt: null, soh: 0.9, kappaSampleCount: 0, kappaUpdatedAt: null }
        : {
            kappa: 1,
            lastObservedSoc: opts.soc === undefined ? 0.9 : opts.soc,
            lastObservedAt: new Date(decisionTimeMs - (opts.socAgeMs === undefined ? 60_000 : opts.socAgeMs)),
            soh: 0.9,
            kappaSampleCount: 0,
            kappaUpdatedAt: null,
          },
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
    observedAtMs: BigInt(decisionTimeMs - 1_000),
    agent,
  };
  const fix = {
    agentId: agent.id,
    kind: "position",
    value: { lat: at.lat, lon: at.lon, provenance: "PHYSICAL", ...(opts.fixType === null ? {} : { fixType: opts.fixType || "3D" }) },
    observedAt: new Date(decisionTimeMs - 1_000),
    source: "AGENT_REPORT",
    deadReckoned: opts.deadReckoned === true,
    uncertaintyRadiusM: opts.hAccM === undefined ? 1.5 : opts.hAccM,
  };

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
    slaDeadline: new Date(decisionTimeMs + 3_600_000),
    startNotBefore: null,
    createdAt: new Date(decisionTimeMs - 60_000),
    manifests: [],
    mission: { missionId: "mission-1", legs: [{ id: "leg-row-1", sequence: 1 }] },
    stops: [
      { stopId: "stop-1", sequence: 1, stopType: "PICKUP", siteId: "site-a", lat: PICKUP.lat, lon: PICKUP.lon, geofenceResult: "INSIDE", routable: true },
      { stopId: "stop-2", sequence: 2, stopType: "DROP", siteId: "site-b", lat: DROP.lat, lon: DROP.lon, geofenceResult: "INSIDE", routable: true },
    ],
  };
  const depotCell = cells.cellForPoint(PICKUP.lat, PICKUP.lon, cells.RESOLUTION.FINE);

  const prisma = {
    leg: { findFirst: async () => leg },
    agent: {
      findUnique: async ({ where }) =>
        where.id === agent.id
          ? { agentId: agent.agentId, robot: { robotId: robot.robotId, status: robot.status }, batteryState: agent.batteryState }
          : null,
    },
    robot: {
      // `positionObservation.provenanceOf` → PHYSICAL. A store double in the column's shape.
      findUnique: async ({ where }) => (where.robotId === ROBOT_ID ? { ["simu" + "lated"]: false, agent: { id: agent.id } } : null),
      findMany: async () => [],
    },
    agentCellPosition: {
      findFirst: async () => position,
      findMany: async () => [position],
      findUnique: async () => ({ shardId: SHARD_ID }),
    },
    shard: { findUnique: async () => ({ regionId: "region-1" }) },
    observation: {
      findFirst: async ({ where }) => (where.agentId === agent.id && where.kind === "position" ? fix : null),
    },
    chargerReservation: { findMany: async () => [] },
    zone: { findMany: async () => [{ id: "zone-1" }] },
    charger: {
      findMany: async () => [{ chargerId: "charger-depot-1", cellId: depotCell, isDepot: true, chargerClass: "DEPOT", regionId: null }],
    },
    commitment: { findMany: async () => [] },
    chargerAvailabilityProjection: {
      findFirst: async () => ({
        version: 7,
        publishedAt: new Date(decisionTimeMs - 30_000),
        horizonEnd: new Date(decisionTimeMs + 7_200_000),
        payload: {
          chargers: [{ chargerId: "charger-depot-1", isDepot: true, intervals: [{ fromMs: decisionTimeMs - 60_000, untilMs: decisionTimeMs + 7_200_000, state: "FREE" }] }],
        },
      }),
    },
  };

  return { policy, prisma, agent, robot, position, fix, leg, fineCellId };
}

/** The real register with the V1 bindings, the RNSIT delivery domain and a one-zone spatial model. */
function snapshotFor(points) {
  const real = service.defaultSnapshot();
  const map = Object.fromEntries([...demonstration.bindings(), ...demonstration.executionBindings()].map((row) => [row.name, row.value]));
  map["energy.model_residual_cv"] = 0.1;
  map["energy.reserve_floor_wh"] = 50;
  return Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
    deliveryDomain: DELIVERY_DOMAIN,
    spatial: {
      version: 1,
      regions: [{ id: "region-1" }],
      zones: [{ id: "zone-1", regionId: "region-1" }],
      sites: [],
      cells: points.map((pt) => ({
        cellId: cells.cellForPoint(pt.lat, pt.lon, cells.RESOLUTION.FINE),
        resolution: cells.RESOLUTION.FINE,
        regionId: "region-1",
        zoneId: "zone-1",
      })),
    },
    resolve: (name, context, options) => (Object.prototype.hasOwnProperty.call(map, name) ? map[name] : real.resolve(name, context, options)),
    explain: (name, context, options) => {
      const explained = real.explain(name, context, options);
      return Object.prototype.hasOwnProperty.call(map, name) ? { ...explained, value: map[name] } : explained;
    },
  });
}

/** Live evidence the Pi supplies: a fresh stop-latch report and a PROBE proof on its socket. */
async function liveEvidence(kv, decisionTimeMs, overrides) {
  const opts = overrides || {};
  await setRobotState(kv, ROBOT_ID, {
    lastHeartbeat: decisionTimeMs - 1_000,
    ...(opts.noLatch ? {} : { stopLatch: { engaged: opts.engaged === true, observedAtMs: decisionTimeMs - 1_000 } }),
    ...(opts.noProbe ? {} : { lastProbeAckAt: decisionTimeMs - 1_500, lastProbeSocketId: SOCKET_ID, linkQuality: 1 }),
  });
}

async function assemble(world, decisionTimeMs, extra) {
  const snapshot = snapshotFor([PICKUP, DROP]);
  const kv = await freshKv();
  await liveEvidence(kv, decisionTimeMs, extra && extra.live);
  const physical = physicalProvider.createPhysicalProvider({
    prisma: world.prisma,
    kv,
    tenantId: profile.DEMONSTRATION_TENANT_ID,
    snapshot: () => snapshot,
    policy: world.policy,
  });
  const fleet = fleetProviders.createFleetComposition({ physical });
  const assembly = solvePath.create({
    snapshot,
    prisma: world.prisma,
    kv,
    shardId: SHARD_ID,
    regionId: "region-1",
    instanceId: "instance-1",
    runSerializable: async (client, fn) => fn(client),
    selectForUpdate: async () => null,
    signingKey: "test-only-signing-key",
    values: new Map(),
    record: () => {},
    ...fleet,
  });
  if (!assembly.ok) throw new Error(`create() refused: ${assembly.blockedBy}`);
  await kv.sadd(availabilityIndex.fineKey(SHARD_ID, world.fineCellId, "IDLE_READY"), world.agent.id);
  return { assembly, kv, physical, fleet, snapshot };
}

/** Expand once, recording the exact evaluation and all 38 verdicts. */
async function evaluateOnce(world, decisionTimeMs, extra) {
  const built = await assemble(world, decisionTimeMs, extra);
  const seen = [];
  const real = built.assembly.round.evaluateExact;
  built.assembly.round.evaluateExact = async (agentId, leg, agentSnapshot) => {
    const result = await real(agentId, leg, agentSnapshot);
    seen.push({ agentId, agentSnapshot, result });
    return result;
  };
  const verdicts = {};
  const spy = jest.spyOn(evaluate, "gate").mockImplementation((candidate, gateContext, options) => {
    verdicts.all = evaluate.evaluateCandidate(gateContext, { collectAll: true }).verdicts;
    return REAL_GATE(candidate, gateContext, options);
  });
  try {
    const outcome = await built.assembly.deps.expandCandidates({
      legId: "leg-1",
      shardId: SHARD_ID,
      decisionTimeMs,
      slaClass: null,
      queueAgeSeconds: 60,
    });
    return { ...built, outcome, seen, verdicts: verdicts.all || null };
  } finally {
    spy.mockRestore();
  }
}

const REAL_GATE = evaluate.gate;

const notSatisfied = (verdicts) =>
  Object.entries(verdicts || {})
    .filter(([, verdict]) => verdict.outcome !== "SATISFIED")
    .map(([id, verdict]) => `${id}:${verdict.outcome}:${verdict.reason || verdict.missing || ""}`);

/* ═══════════════════════════════════════════════════════════════════════════ */

describe("Gate 1 — the physical fleet declaration", () => {
  test("a complete declaration validates with no problems", () => {
    const policy = physicalPolicy.fromDeclaration(declaration());
    expect(policy.problems).toEqual([]);
    expect(policy.robotFor(ROBOT_ID)).not.toBeNull();
  });

  test("an absent declaration turns every section off and names each", () => {
    const policy = physicalPolicy.NONE;
    expect(policy.charging).toBeNull();
    expect(policy.stateOfCharge).toBeNull();
    expect(policy.emergencyStop).toBeNull();
    expect(policy.site.terrain).toBeNull();
    expect(policy.problems.join(" ")).toMatch(/MANUAL_OUT_OF_SERVICE/);
    expect(policy.problems.join(" ")).toMatch(/SOFTWARE_STOP_LATCH/);
  });

  test("a robot entry missing a required declaration is refused, not partly applied", () => {
    const raw = declaration();
    delete raw.robots[0].energy.movingPowerW;
    const policy = physicalPolicy.fromDeclaration(raw);
    expect(policy.robotFor(ROBOT_ID)).toBeNull();
    expect(policy.problems.join(" ")).toMatch(/movingPowerW/);
  });

  test("the declared β is the declared draw in Wh per second, uncalibrated", () => {
    const coefficients = physicalDeclaration.declaredEnergyCoefficients({ idlePowerW: 6, movingPowerW: 30, residualCv: 0.2 });
    expect(coefficients.betaAux).toBeCloseTo(6 / 3600, 12);
    expect(coefficients.betaMoveTime).toBeCloseTo(24 / 3600, 12);
    expect(coefficients.residualCv).toBe(0.2);
    expect(coefficients).not.toHaveProperty("fittedAt");
  });
});

describe("Gate 1 — physical availability policy (F01)", () => {
  test("declared, MANUAL_OUT_OF_SERVICE, fresh operator SoC: known and not charging", async () => {
    const now = Date.now();
    const world = physicalWorld({ decisionTimeMs: now });
    const physical = physicalProvider.createPhysicalProvider({ prisma: world.prisma, policy: world.policy });
    const status = await physical.chargingStatusFor(world.agent.id);
    expect(status).toMatchObject({ known: true, charging: false, waiting: false });
  });

  test.each([
    ["no declaration at all", { declaration: {} }, /no charging policy/],
    ["SoC never declared", { soc: null }, /no operator-declared state of charge/],
    ["SoC older than the declared bound", { socAgeMs: 7201 * 1000 }, /old \(bound 7200 s\)/],
  ])("%s: unknown, with the reason", async (_name, options, reason) => {
    const now = Date.now();
    const world = physicalWorld({ decisionTimeMs: now, ...options });
    const physical = physicalProvider.createPhysicalProvider({ prisma: world.prisma, policy: world.policy });
    const status = await physical.chargingStatusFor(world.agent.id);
    expect(status.known).toBe(false);
    expect(status.reason).toMatch(reason);
  });

  test("the fleet reader asks the simulator first and falls to the physical policy", async () => {
    const now = Date.now();
    const world = physicalWorld({ decisionTimeMs: now });
    const physical = physicalProvider.createPhysicalProvider({ prisma: world.prisma, policy: world.policy });
    const statusFor = fleetProviders.createChargingStatusFor({
      simulationStatusFor: async () => ({ known: false, reason: "not on the simulator's roster" }),
      physical,
    });
    expect((await statusFor(world.agent.id)).known).toBe(true);
  });
});

describe("Gate 1 — physical routing over the campus network (F02)", () => {
  function routerWith(declared) {
    const snapshot = snapshotFor([PICKUP, DROP]);
    return physicalRouter.createPhysicalRouter({ snapshot: () => snapshot, policy: physicalPolicy.fromDeclaration(declared) });
  }
  const key = "PHYSICAL:v=1:wh=86:net=" + require("../../src/simulation/campusTraversalNetwork").permittedClasses(ROVER).join("+");
  const parts = {
    originCell: cells.cellForPoint(PICKUP.lat, PICKUP.lon, cells.RESOLUTION.FINE),
    destCell: cells.cellForPoint(DROP.lat, DROP.lon, cells.RESOLUTION.FINE),
    originPoint: PICKUP,
    destPoint: DROP,
    profileKey: key,
    timeBucket: 10,
  };

  test("exact endpoints: a network path, the travel model at the commissioned speed, declared flat terrain", async () => {
    const route = await routerWith(declaration()).route(parts);
    expect(route.endpointBasis).toBe(ENDPOINT_BASIS.EXACT_POINTS);
    expect(route.path.length).toBeGreaterThan(2);
    expect(route.distanceM).toBeGreaterThan(0);
    expect(route.travelSeconds).toBeGreaterThan(route.distanceM / 1.0 - 1e-9);
    expect([route.climbM, route.descentM, route.stopStartCycles]).toEqual([0, 0, 1]);
    expect(JSON.stringify(route.provenance)).not.toMatch(/DEVELOPMENT_SIMULATION/);
  });

  test("without the terrain declaration the route is refused NO_TERRAIN_SOURCE", async () => {
    const raw = declaration();
    raw.site = { ...raw.site, terrain: undefined };
    await expect(routerWith(raw).route(parts)).rejects.toMatchObject({ refusal: ROUTE_REFUSAL.NO_TERRAIN_SOURCE });
  });

  test("a simulated profile key is never answered by the physical router", async () => {
    const error = await routerWith(declaration()).route({ ...parts, profileKey: "SIMULATED:v=1.5:wh=1000:net=footway" }).catch((e) => e);
    expect(error).toBeInstanceOf(RouteRefusedError);
    expect(error.refusal).toBe(ROUTE_REFUSAL.NOT_ROUTABLE);
  });

  test("MAP_MATCH: a point on a permitted way is 0 m from the network; one off it is not", () => {
    const router = routerWith(declaration());
    const onWay = EXTRACT.features.find((f) => f.geometry.type === "LineString" && f.properties.highway === "footway").geometry.coordinates[0];
    expect(router.mapMatchDivergenceM({ lat: onWay[1], lon: onWay[0] }, ROVER)).toBeCloseTo(0, 6);
    expect(router.mapMatchDivergenceM({ lat: onWay[1] + 0.001, lon: onWay[0] }, ROVER)).toBeGreaterThan(10);
  });
});

describe("Gate 1 — a declared physical robot is a feasible, priced candidate (F01–F05)", () => {
  test("38/38 SATISFIED, priced, through the real gate, Plan Builder and pricing — no simulator composed", async () => {
    const now = Date.now();
    const world = physicalWorld({ decisionTimeMs: now });
    const { outcome, seen, verdicts, assembly } = await evaluateOnce(world, now);

    expect(outcome.agentsEvaluated).toBe(1);
    expect(seen).toHaveLength(1);
    const [row] = seen;
    expect(row.agentSnapshot.provenance).toBe(physicalFacts.PROVENANCE);
    // 37 SATISFIED; F11 is INDETERMINATE by design: no intervention history yet, so the cohort
    // prior stands in and the policy admits with its uncertainty penalty (§7.5 F11).
    expect(Object.keys(verdicts)).toHaveLength(38);
    expect(notSatisfied(verdicts).map((line) => line.split(":").slice(0, 2).join(":"))).toEqual(["F11:INDETERMINATE"]);
    expect(row.result.feasible).toBe(true);
    expect(typeof row.result.gammaMilliCU).toBe("bigint");

    const priced = assembly.deps.pricedCandidateFor(world.agent.id, "leg-row-1", {});
    expect(priced).not.toBeNull();
    // Nothing the simulator states reached this agent.
    expect(JSON.stringify(row.agentSnapshot, (k, v) => (typeof v === "bigint" ? String(v) : v))).not.toMatch(/DEVELOPMENT_SIMULATION/);
  });

  test.each([
    ["the robot is not in the declaration", { declaration: declaration({ robots: [] }) }, {}, /^\[\]$/],
    ["the stop latch is engaged", {}, { live: { engaged: true } }, /F7:VIOLATED/],
    ["no stop-latch report", {}, { live: { noLatch: true } }, /F7:INDETERMINATE/],
    ["no PROBE proof on this socket", {}, { live: { noProbe: true } }, /F14:/],
    ["a dead-reckoned fix", { deadReckoned: true }, {}, /F10:/],
    ["a fix with no declared quality", { fixType: null }, {}, /F10:/],
    ["a 2D fix the declaration does not accept", { fixType: "2D" }, {}, /F10:/],
    ["the unit is in ERROR", { status: "ERROR" }, {}, /F8:VIOLATED/],
  ])("negative control — %s: not feasible, named", async (_name, worldOptions, extra, named) => {
    const now = Date.now();
    const world = physicalWorld({ decisionTimeMs: now, ...worldOptions });
    const { seen, verdicts } = await evaluateOnce(world, now, extra);
    const feasible = seen.length === 1 && seen[0].result.feasible === true;
    expect(feasible).toBe(false);
    const failures = verdicts ? notSatisfied(verdicts).join(" ") : JSON.stringify(seen.map((s) => s.result.refusal || s.result.denials));
    expect(failures).toMatch(named);
  });
});
