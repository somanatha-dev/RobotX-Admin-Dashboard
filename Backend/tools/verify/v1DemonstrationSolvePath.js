"use strict";

/**
 * **TASK 3 — trace the real V1 demonstration solve path.** Read-only diagnosis.
 *
 * ── What this is ───────────────────────────────────────────────────────────
 * A throwaway diagnostic harness. It drives the **real** production modules — the real
 * `services/task.service.assignTask`, the real `engine/intake`, the real
 * `engine/config/service`, the real `workers/indexMaintainer`, the real
 * `engine/shard/election`, the real `workers/coordinatorSolvePath.create()` and the real
 * `workers/coordinator.worker.runRound()` — against a **disposable local PostgreSQL**, and
 * records, stage by stage, what was ENTERED, what the RESULT was, and the exact refusal.
 *
 * It modifies no production source, no test, no schema, no migration, no register file, no
 * gate. Nothing in `src/` requires it.
 *
 * ── The injection ladder, and the rule it is held to ───────────────────────
 * The path stops early. To map what lies **behind** each wall the harness re-runs the same
 * real code at escalating, individually labelled injection levels:
 *
 *   L0  LEGITIMATE ONLY — the process dependencies a composition root always supplies,
 *       plus exactly the five inputs the prior audit classified as zero-fabrication:
 *       `timeBucket`, the declared travel-time spread source, `Robot.massKg`, the
 *       simulated environment's `ambientC`/`packC`, and `speedMetresPerSecond`.
 *   L1  + NON-FABRICATING SEAMS — `failureProbabilityFor`, `routeHazardCuFor`,
 *       `batteryWearInputsFor`, `returnLegEnergyWhPerMetreFor` supplied as functions that
 *       **return nothing**. No number is invented: the probe is satisfied and the
 *       consuming module still refuses, by name. This separates "the composition could not
 *       be built" from "the value is absent", which the probe alone cannot.
 *   L2  + DIAGNOSTIC register values for the two Safety rows (`energy.model_residual_cv`,
 *       `energy.reserve_floor_wh`) on a **wrapper around** the pinned snapshot.
 *   L3  + DIAGNOSTIC route double (six fixed fields).
 *   L4  + DIAGNOSTIC fitted energy fixture (`tests/engine/helpers/energyFixture`) overlaid
 *       on the `EnergyModelParams` row **as it is read**, plus a state of health.
 *   L5  + DIAGNOSTIC charger estate and return-leg Wh/metre.
 *   L6  + DIAGNOSTIC p_fail, route hazard cost and battery-wear mission conditions.
 *
 * **NOTHING INJECTED AT L2 AND ABOVE IS A V1 INPUT, A PROPOSED VALUE, OR A CALIBRATION.**
 * No injected value is written to the register, to a configuration version, to the
 * database, to commissioning or to a simulation preset. Every one lives in this file, in a
 * wrapper, for the life of one process. The answer to *"what blocks V1"* is taken from the
 * LOWEST level; the higher levels exist only to answer *"and what is behind it"*, which is
 * what the task asked for and what a stop-at-the-first-error trace cannot say.
 *
 * ── Usage ──────────────────────────────────────────────────────────────────
 *   node tools/verify/v1DemonstrationSolvePath.js <postgres-url>
 *
 * Loopback only, never the default port, never Neon, never a remote Redis.
 */

const url = process.argv[2];

function refuse(message) {
  process.stderr.write(`REFUSED: ${message}\n`);
  process.exit(2);
}

if (!url) refuse("usage: node tools/verify/v1DemonstrationSolvePath.js <postgres-url>");

let target;
try {
  target = new URL(url);
} catch {
  refuse(`"${url}" is not a parseable URL`);
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const DEFAULT_POSTGRES_PORT = "5432";
if (!/^postgres(ql)?:$/u.test(target.protocol)) refuse(`protocol ${target.protocol} is not postgres`);
if (!LOOPBACK_HOSTS.has(target.hostname)) refuse(`host "${target.hostname}" is not loopback`);
if (target.port === "" || target.port === DEFAULT_POSTGRES_PORT) {
  refuse(`port "${target.port || "(default)"}" is the developer's own cluster; use a throwaway cluster`);
}

process.env.DATABASE_URL = url;
process.env.DATABASE_URL_LOCAL = url;
process.env.REDIS_ENABLED = "false";
delete process.env.REDIS_URL;
// §23.7's two secrets. Throwaway, for this process only — `sealIdentities` fails closed
// without them and the geofence pin happens inside it.
process.env.PRIVACY_SURROGATE_SECRET = "v1-solve-path-trace-secret";
process.env.PRIVACY_IDENTITY_KEY = "11".repeat(32);
// The process half of the cutover switch (§ `cutover/enabled.processEnabled`).
process.env.ENGINE_ENABLED = "true";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const h3 = require("h3-js");

const BACKEND_ROOT = path.resolve(__dirname, "..", "..");
const REPO_ROOT = path.resolve(BACKEND_ROOT, "..");

const { getPrisma } = require("../../src/db/prisma");
const { runSerializable, selectForUpdate, isSerializationFailure } = require("../../src/db/prisma");
const { initKv } = require("../../src/cache/kv");

const configService = require("../../src/engine/config/service");
const demonstration = require("../config/v1DemonstrationConfig");
const publishTool = require("../config/publishV1Demonstration");

const taskService = require("../../src/services/task.service");
const intake = require("../../src/engine/intake/intake");
const cutoverEnabled = require("../../src/engine/cutover/enabled");
const deliveryDomain = require("../../src/engine/spatial/deliveryDomain");
const cells = require("../../src/engine/spatial/cells");
const hierarchy = require("../../src/engine/spatial/hierarchy");
const timeline = require("../../src/engine/plan/timeline");
const consumption = require("../../src/engine/energy/consumption");
const leadership = require("../../src/engine/shard/leadership");
const election = require("../../src/engine/shard/election");
const failover = require("../../src/engine/shard/failover");
const availabilityIndex = require("../../src/engine/candidates/availabilityIndex");
const indexMaintainer = require("../../src/workers/indexMaintainer.worker");
const chargingStatus = require("../../src/services/chargingStatus.service");
const agentEnergyProvisioning = require("../../src/services/agentEnergyProvisioning.service");
const decisionInputs = require("../../src/engine/domain/mappers/decisionInputs");

const coordinatorPipeline = require("../../src/workers/coordinatorPipeline");
const coordinatorSolvePath = require("../../src/workers/coordinatorSolvePath");
const coordinatorWorker = require("../../src/workers/coordinator.worker");
const leaderWorkers = require("../../src/workers/leaderWorkers");
const offersModel = require("../../src/engine/dispatch/offers");

// The fitted β set the task authorises as a DIAGNOSTIC injection only. Its own header
// says the numbers are "chosen to be legible rather than realistic"; nothing here
// presents them as anything else, and they never leave this process.
const energyFixture = require("../../tests/engine/helpers/energyFixture");

/* ═══════════════════════════════════════════════════════════════════════════
   Two in-process observations of `feasibility/evaluate.gate`, in this throwaway
   process only. Neither is a repository change.

   1. `collectAll: true`. The shipped gate stops at the FIRST denial
      (`if (!settings.collectAll) break;`) and `coordinatorSolvePath` passes no options,
      so a round can only ever report one denying predicate. That answers "why did this
      candidate fail" with the first of possibly twenty reasons, and re-running after
      fixing it reveals the next — which is exactly the serial discovery this trace
      exists to avoid. `collectAll` changes no verdict: `feasible` is still
      `denials.length === 0`.

   2. A **labelled bypass**, used only at the last level, to answer "is the machinery
      downstream of the gate reachable and does it execute" — a question about code,
      never a claim that the candidate is feasible.
   ═══════════════════════════════════════════════════════════════════════════ */
const feasibilityEvaluate = require("../../src/engine/feasibility/evaluate");
const { brandFeasible } = require("../../src/engine/guards/tenets");
const realGate = feasibilityEvaluate.gate;
let gateObserver = null;
let gateBypass = false;

feasibilityEvaluate.gate = function observedGate(candidate, context, options) {
  const outcome = realGate(candidate, context, { ...(options || {}), collectAll: true });
  if (typeof gateObserver === "function") gateObserver(outcome);
  if (!gateBypass || outcome.feasible) return outcome;

  // DIAGNOSTIC BYPASS — reachability probe only.
  brandFeasible(candidate, {
    predicatesEvaluated: outcome.outcome.evaluated,
    configVersion: context && context.config ? context.config.version || null : null,
    snapshotId: context && context.snapshotId ? context.snapshotId : null,
    decisionTimeMs: context ? context.decisionTimeMs : null,
    penaltyMilliCu: outcome.outcome.penaltyMilliCu,
    envelopeReduced: outcome.outcome.envelopeReduced,
  });
  return { feasible: true, candidate, outcome: outcome.outcome, tuples: outcome.tuples, DIAGNOSTIC_BYPASS: true };
};

/**
 * A third observation, for the same reason: `planBuilder.buildVariant` swallows
 * `energy/tiers.evaluate`'s `problems` — when the tier evaluation fails it sets
 * `energyFragment = null`, `plan.energy` comes out `null`, `build()` still returns `ok`,
 * and the three names §14.5 could not resolve are never reported anywhere. `cRisk` then
 * says only *"plan.energy.tierProbabilities.T1"*. This records what `tiers.evaluate`
 * actually said. It changes nothing.
 */
const energyTiers = require("../../src/engine/energy/tiers");
const energyReserves = require("../../src/engine/energy/reserves");
const energyEReturn = require("../../src/engine/energy/eReturn");
const realTiersEvaluate = energyTiers.evaluate;
const realCompose = energyReserves.compose;
const realEReturn = energyEReturn.evaluate;
let tiersObserver = null;
energyTiers.evaluate = function observedTiers(input) {
  const outcome = realTiersEvaluate(input);
  if (typeof tiersObserver === "function") tiersObserver("tiers", outcome);
  return outcome;
};
energyReserves.compose = function observedCompose(input) {
  const outcome = realCompose(input);
  if (typeof tiersObserver === "function") tiersObserver("reserves.compose", outcome);
  return outcome;
};
energyEReturn.evaluate = function observedEReturn(input) {
  const outcome = realEReturn(input);
  if (typeof tiersObserver === "function") tiersObserver("eReturn", outcome);
  return outcome;
};

const RUN = `v1trace-${Date.now()}`;
const BOUNDARY_SHA256 = "04cb64c4205dc59462e149501fdd93b412106cfdc8d7249661bc8f3f47dc08b4";
const FINE = cells.H3_RESOLUTION.FINE;

/* ═══════════════════════════════════════════════════════════════════════════
   The stage recorder — the report IS the deliverable.
   ═══════════════════════════════════════════════════════════════════════════ */

const STAGE_ORDER = [
  "TASK",
  "TASK VALIDATION",
  "REGION RESOLUTION",
  "CONFIG PIN",
  "CUTOVER",
  "WORK QUEUE",
  "SHARD RESOLUTION",
  "LEADER / COORDINATOR START",
  "COMPOSITION",
  "CANDIDATE DISCOVERY",
  "ROBOT SNAPSHOT",
  "GEOFENCE",
  "ROUTING",
  "ENERGY",
  "RETURN ENERGY",
  "FEASIBILITY",
  "RELIABILITY",
  "COST",
  "SOLVER / DTARO",
  "ASSIGNMENT",
  "OFFER",
  "ROBOT ACCEPT",
  "MISSION EXECUTION",
];

const stages = new Map();
for (const name of STAGE_ORDER) {
  stages.set(name, { stage: name, entered: false, result: null, module: null, refusal: null, dependency: null, classification: null, level: null, notes: [] });
}

/**
 * Record (or refine) one stage.
 *
 * @param {string} name
 * @param {object} fields
 */
function record(name, fields) {
  const row = stages.get(name);
  if (!row) throw new Error(`unknown stage "${name}"`);
  for (const [key, value] of Object.entries(fields)) {
    if (key === "note") {
      row.notes.push(value);
      continue;
    }
    // Once a stage has been ENTERED it stays entered: a later, lower-level run must not
    // un-report a reach that a higher level genuinely achieved.
    if (key === "entered" && row.entered === true && value !== true) continue;
    row[key] = value;
  }
}

const findings = [];
function finding(text) {
  findings.push(text);
  process.stdout.write(`   ! ${text}\n`);
}

function say(text) {
  process.stdout.write(`${text}\n`);
}

const isNumber = (value) => typeof value === "number" && Number.isFinite(value);

/* ═══════════════════════════════════════════════════════════════════════════
   Geometry — the adopted RNSIT boundary, digest-pinned.
   ═══════════════════════════════════════════════════════════════════════════ */

function loadGeometry() {
  const raw = fs.readFileSync(path.join(REPO_ROOT, "rnsit-campus-osm.geojson"));
  const digest = crypto.createHash("sha256").update(raw).digest("hex");
  if (digest !== BOUNDARY_SHA256) refuse(`the RNSIT boundary digest is ${digest}, not the adopted ${BOUNDARY_SHA256}`);
  const boundary = JSON.parse(raw).features.find((row) => row.id === "way/1120154292").geometry;
  const points = {};
  for (const feature of JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "rnsit-campus-supplemental.geojson"))).features) {
    const [lon, lat] = feature.geometry.coordinates;
    points[feature.properties.id] = { lat, lon };
  }
  return { boundary, points };
}

/* ═══════════════════════════════════════════════════════════════════════════
   DIAGNOSTIC INJECTIONS. Every one is labelled, bounded to this process, and
   never written anywhere durable.
   ═══════════════════════════════════════════════════════════════════════════ */

/** L2 — the two Safety register rows, on a wrapper, never on the register. */
const DIAGNOSTIC_SAFETY_REGISTER = Object.freeze({
  "energy.model_residual_cv": 0.1,
  "energy.reserve_floor_wh": 50,
});

/**
 * L3 — a six-field router-shaped function. **NOT a traversal source.**
 *
 * The numbers are chosen only so the plan's extent stays inside `plan.commitment_horizon`
 * (900 s) once §20.3's intra-cell offset is added: a larger fixed hop makes F17 fire on
 * the *fixture's* arithmetic and hides every predicate behind it. They are not travel
 * times, nothing in this trace depends on their values, and they are never presented as a
 * measurement.
 */
function diagnosticRoute() {
  const calls = [];
  const route = async (parts) => {
    calls.push(parts);
    return { distanceM: 60, travelSeconds: 45, travelSdSeconds: 5, climbM: 1, descentM: 1, stopStartCycles: 1 };
  };
  route.calls = calls;
  return route;
}

/** L4 — the fitted β set, in the Prisma column spelling, as a read-time overlay. */
function diagnosticEnergyParamsRow() {
  const fitted = energyFixture.energyModelParams();
  return {
    modelVersion: 1,
    betaDist: fitted[consumption.COEFFICIENT.DIST],
    betaMass: fitted[consumption.COEFFICIENT.MASS],
    betaClimb: fitted[consumption.COEFFICIENT.CLIMB],
    betaRegen: fitted[consumption.COEFFICIENT.REGEN],
    etaRegen: fitted[consumption.COEFFICIENT.REGEN_EFFICIENCY],
    betaMoveTime: fitted[consumption.COEFFICIENT.MOVE_TIME],
    betaStopStart: fitted[consumption.COEFFICIENT.STOP_START],
    betaDwell: fitted[consumption.COEFFICIENT.DWELL],
    betaAux: fitted[consumption.COEFFICIENT.AUX],
    betaThermal: fitted[consumption.COEFFICIENT.THERMAL],
    betaPayloadThermal: fitted[consumption.COEFFICIENT.PAYLOAD_THERMAL],
    stressCurves: energyFixture.stressCurves(),
    residualCv: null,
    fittedAt: null,
  };
}

/**
 * A Prisma read-through proxy that overlays the DIAGNOSTIC energy row and state of health
 * onto the rows the agent-snapshot loader reads.
 *
 * A proxy rather than a database write, deliberately: the task forbids the fitted values
 * reaching the database, and a read-time overlay cannot outlive this process.
 *
 * @param {object} prisma
 * @param {{ energy?: boolean, soh?: number }} injections
 * @returns {object}
 */
function energyInjectingPrisma(prisma, injections) {
  if (!injections || (!injections.energy && !isNumber(injections.soh))) return prisma;
  const params = injections.energy ? diagnosticEnergyParamsRow() : null;

  const overlay = (position) => {
    if (!position || !position.agent) return position;
    const agent = position.agent;
    if (params && agent.agentClass) agent.agentClass.energyModelParams = [params];
    if (isNumber(injections.soh) && agent.batteryState) agent.batteryState.soh = injections.soh;
    return position;
  };

  const table = prisma.agentCellPosition;
  const wrapped = new Proxy(prisma, {
    get(reference, property) {
      if (property !== "agentCellPosition") return Reflect.get(reference, property);
      return {
        ...table,
        findFirst: async (args) => overlay(await table.findFirst(args)),
        findMany: async (args) => (await table.findMany(args)).map(overlay),
        count: (args) => table.count(args),
        create: (args) => table.create(args),
        deleteMany: (args) => table.deleteMany(args),
      };
    },
  });
  return wrapped;
}

/**
 * A snapshot wrapper carrying DIAGNOSTIC register values. The real snapshot answers
 * everything else, so `omega.combinedCorrection` and every other reader that walks more of
 * the object than `resolve()` keep working against the published version.
 *
 * @param {object} real a pinned snapshot
 * @param {object} overrides
 * @returns {object}
 */
function snapshotWith(real, overrides) {
  const map = overrides || {};
  if (Object.keys(map).length === 0) return real;
  return Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
    resolve: (name, context, options) =>
      Object.prototype.hasOwnProperty.call(map, name) ? map[name] : real.resolve(name, context, options),
    explain: (name, context, options) => {
      if (!Object.prototype.hasOwnProperty.call(map, name)) return real.explain(name, context, options);
      const explained = real.explain(name, context, options);
      return { ...explained, value: map[name] };
    },
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   The seed — every row a real deployment legitimately holds.
   ═══════════════════════════════════════════════════════════════════════════ */

async function seed(prisma, geometry) {
  const { boundary, points } = geometry;

  /* ── The operating region, its zone, and D6's index cover ─────────────── */
  const declaration = {
    regionId: "rnsit-campus",
    name: "RNSIT Campus",
    kind: "CAMPUS",
    crs: "EPSG:4326",
    version: "way/1120154292",
    versionDate: "2026-08-30",
    boundary,
  };
  const domain = deliveryDomain.validateDomainDeclaration(declaration);

  const indexCover = h3.polygonToCellsExperimental(
    boundary.coordinates,
    FINE,
    h3.POLYGON_TO_CELLS_FLAGS.containmentOverlapping,
    true,
  );

  const region = await prisma.region.create({ data: { regionId: "rnsit", name: "RNSIT" } });
  const zone = await prisma.zone.create({
    data: {
      id: "rnsit-z1",
      name: "RNSIT Z1",
      regionId: region.id,
      minLat: domain.bbox.minLat,
      maxLat: domain.bbox.maxLat,
      minLon: domain.bbox.minLon,
      maxLon: domain.bbox.maxLon,
    },
  });
  await prisma.cellAssignment.createMany({
    data: indexCover.map((cellId) => ({ cellId, resolution: "FINE", regionId: region.id, zoneId: zone.id, mapVersion: 1 })),
  });

  /* ── The published shard for that region ──────────────────────────────── */
  const shardId = `${RUN}-shard`;
  await prisma.shardLeadership.create({ data: { shardId, leadershipFence: 1 } });
  await prisma.shard.create({ data: { shardId, regionId: region.id, state: "ACTIVE" } });

  /* ── The fleet ────────────────────────────────────────────────────────── */
  const mobilityModel = await prisma.mobilityModel.create({
    data: {
      modelId: `${RUN}-mobility`,
      name: "V1 demonstration mobility model",
      traversalDomain: "GROUND",
      kinematicLimits: { maxSpeedMs: 2 },
      permissionSet: ["FOOTWAY", "SERVICE_ROAD"],
      envelopeConstraints: { maxWidthMm: 800, maxHeightMm: 1400 },
      dimensionalFootprint: { widthMm: 600, lengthMm: 900, heightMm: 1200 },
    },
  });
  const energyModel = await prisma.energyModel.create({
    data: {
      modelId: `${RUN}-energy`,
      name: "V1 demonstration energy model",
      packNominalWh: 1000,
      thermalDeratingCurve: energyFixture.thermalDeratingCurve(),
      chargePowerCurve: energyFixture.chargePowerCurve(),
    },
  });
  const containerModel = await prisma.containerModel.create({
    data: { modelId: `${RUN}-container`, name: "V1 demonstration container", ...containerColumns() },
  });
  const agentClass = await prisma.agentClass.create({
    data: {
      classId: `${RUN}-class`,
      name: "V1 demonstration agent class",
      mobilityModelId: mobilityModel.id,
      energyModelId: energyModel.id,
      containerModelId: containerModel.id,
      hardwareRevision: "rev-a",
      firmwareVersionSet: { DELIVERY: ["1.0.0"] },
    },
  });

  const location = await prisma.location.create({ data: { name: `${RUN}-location`, type: "AREA" } });
  // SIMULATED, deliberately. `services/chargingStatus.service` gives an authoritative
  // charging state only to an agent a Charging Scheduler covers, and the only scheduler
  // in this repository is the simulator's (B2 blocks the physical fleet's). A physical
  // unit is therefore not indexable at all — which is a finding, not a harness choice.
  const robot = await prisma.robot.create({
    data: {
      robotId: `${RUN}-robot`,
      name: "V1 demonstration robot",
      locationId: location.id,
      simulated: true,
      // `Robot.massKg` — zero-fabrication input 3. A commissioning value an operator
      // enters; `services/robotSpecification.js` is its declared sole writer.
      massKg: 42,
      battery: 90,
    },
  });
  const agent = await prisma.agent.create({
    data: {
      agentId: `${RUN}-robot`,
      robotDbId: robot.id,
      agentClassId: agentClass.id,
      regionId: region.id,
      lifecycleState: "ACTIVE",
    },
  });

  // The REAL commissioning producer, unchanged. It writes κ = 1 with a zero sample count
  // and leaves every β and `soh` null — which is finding 3 of the brief, reproduced here
  // by running the actual code rather than by asserting it.
  const provisioned = await agentEnergyProvisioning.provisionAgentEnergyState(prisma, {
    agentRowId: agent.id,
    agentClassRowId: agentClass.id,
    initialBatteryPct: 90,
  });

  /* ── The agent's position, and the Observation the index maintainer reads ── */
  const agentPoint = points["rnsit-innovation-center"];
  const fineCellId = cells.cellForPoint(agentPoint.lat, agentPoint.lon, cells.RESOLUTION.FINE);
  const observedAt = new Date();
  // Written in the exact shape `services/positionObservation.recordPositionObservation`
  // produces (§2.7): `AGENT_REPORT`, the agent-measured instant, provenance SIMULATED
  // inside `value`. The service itself needs a live socket binding, which is a stage this
  // trace does not exercise; the row it would have written is what the index maintainer
  // reads, so that row is what is seeded.
  const observationModel = require("../../src/engine/domain/observation");
  await prisma.observation.create({
    data: {
      agentId: agent.id,
      kind: "position",
      observedAt,
      source: observationModel.OBSERVATION_SOURCE.AGENT_REPORT,
      value: { lat: agentPoint.lat, lon: agentPoint.lon, provenance: "SIMULATED" },
    },
  });
  await prisma.agentCellPosition.create({
    data: {
      agentId: agent.id,
      shardId,
      lat: agentPoint.lat,
      lon: agentPoint.lon,
      fineCellId,
      coarseCellId: cells.coarseParentOf(fineCellId),
      availabilityClass: "IDLE_READY",
      capabilityClasses: [],
      containerClasses: [],
      observedAtMs: BigInt(observedAt.getTime()),
    },
  });

  return {
    region,
    zone,
    shardId,
    indexCover,
    declaration,
    domain,
    agent,
    agentClass,
    robot,
    provisioned,
    fineCellId,
    agentPoint,
    points,
  };
}

/** `ContainerModel`'s declared columns and its `Compartment` rows, in schema shape. */
function containerColumns() {
  const model = energyFixture.containerModel();
  return {
    totalMassLimitKg: model.totalMassLimitKg,
    totalVolumeLitres: model.totalVolumeLitres,
    cogEnvelope: model.cogEnvelope,
    compartments: {
      create: model.compartments.map((compartment) => ({
        ordinal: compartment.ordinal,
        internalLengthMm: compartment.internalLengthMm,
        internalWidthMm: compartment.internalWidthMm,
        internalHeightMm: compartment.internalHeightMm,
        apertureWidthMm: compartment.apertureWidthMm,
        apertureHeightMm: compartment.apertureHeightMm,
        maxMassKg: compartment.maxMassKg,
        thermalClass: compartment.thermalClass,
        activeThermal: compartment.activeThermal,
        lockClass: compartment.lockClass,
      })),
    },
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   Configuration — the thirteen, published and pinned.
   ═══════════════════════════════════════════════════════════════════════════ */

async function publishConfiguration(prisma, world) {
  const bindings = demonstration.bindings();
  demonstration.assertNoSafetyParameter(bindings);

  const spatialPayload = {
    version: 1,
    regions: [{ id: world.region.id }],
    zones: [{ id: world.zone.id, regionId: world.region.id }],
    sites: [],
    cells: world.indexCover.map((cellId) => ({
      cellId,
      resolution: "FINE",
      regionId: world.region.id,
      zoneId: world.zone.id,
    })),
  };

  const at = new Date().toISOString();
  const published = await configService.publish(prisma, {
    publishedBy: "tools/verify/v1DemonstrationSolvePath.js",
    approvals: [
      { approverId: "v1-solve-path-trace-a", approvedAt: at },
      { approverId: "v1-solve-path-trace-b", approvedAt: at },
    ],
    bindings: [
      ...bindings,
      publishTool.V9_ACCOMMODATION,
      // §S-5's owner act, taken here so the request path is reachable at all. Recorded
      // in the note; this is a disposable cluster and nothing else.
      { level: "region", key: world.region.id, name: "cutover.engine_enabled", value: true },
    ],
    spatial: spatialPayload,
    deliveryDomain: world.declaration,
    note:
      demonstration.DEMONSTRATION_NOTE +
      publishTool.ACCOMMODATION_NOTE +
      " | TASK 3 TRACE: cutover.engine_enabled is bound for this region on a DISPOSABLE cluster so the " +
      "request path can be entered; the published spatial index is D6's boundary-overlap cover of the " +
      "adopted RNSIT boundary and the delivery domain is that same adopted declaration. NOT PRODUCTION.",
  });
  await configService.pinVersion(prisma, null, published.version, "tools/verify/v1DemonstrationSolvePath.js");
  const pinned = await configService.loadPinnedSnapshot({ prisma });
  return { published, pinned, spatialPayload };
}

/* ═══════════════════════════════════════════════════════════════════════════
   The composition context, per injection level.
   ═══════════════════════════════════════════════════════════════════════════ */

const LEVELS = [
  { level: 0, label: "L0 LEGITIMATE ONLY" },
  { level: 1, label: "L1 + non-fabricating function seams" },
  { level: 2, label: "L2 + DIAGNOSTIC safety register values" },
  { level: 3, label: "L3 + DIAGNOSTIC route double" },
  { level: 4, label: "L4 + DIAGNOSTIC fitted energy fixture" },
  { level: 5, label: "L5 + DIAGNOSTIC charger estate and return-leg rate" },
  { level: 6, label: "L6 + DIAGNOSTIC p_fail / hazard / battery-wear conditions" },
  { level: 7, label: "L7 + DIAGNOSTIC §7.1 GATE BYPASS — reachability probe ONLY" },
  { level: 8, label: "L8 + DIAGNOSTIC staleness observations + thermal stress multiplier" },
  { level: 9, label: "L9 + DIAGNOSTIC §6.3 containment radius (candidate.max_radius_by_sla_class)" },
];

/**
 * L9 — §6.3's containment radius.
 *
 * Measured at L8: `candidate.target_feasible` is **12** on the published register and this
 * demonstration fleet has **one** agent, so `enoughFeasible()` is never true and
 * `shouldStopExpanding` can never fire. With `candidate.max_radius_by_sla_class`
 * unresolved, `maxRadiusRings` is `Infinity`, the k-ring loop runs until the wall clock
 * expires (~100 000 res-11 cells in 250 ms), and §9.4's round budget is exhausted before
 * the solve — so every Leg returns `BUDGET_TRUNCATED` **even with a feasible, priced
 * candidate in the origin cell**. The radius is therefore not an optional policy for a
 * demonstration-sized fleet; it is what lets a round finish.
 */
const DIAGNOSTIC_CONTAINMENT_RADIUS_M = 100;

/**
 * L8 — the two inputs Φ names that `coordinatorPipeline`'s 34 do NOT model, injected so
 * the trace can answer whether the solver, the commit and the offer execute at all.
 *
 * `plan.thermalStressMultiplier` is read from `planBuilder.build`'s own input and no caller
 * sets it; `agentSnapshot.safetyRelevantObservations` is read by `cRisk.stalenessPenalty`
 * and by F16 and `agentSnapshotLoaderFor` never writes it. Both are wrapped here rather
 * than anywhere durable.
 */
const planBuilderModule = require("../../src/engine/plan/planBuilder");
const realPlanBuild = planBuilderModule.build;
let injectThermalStress = false;
planBuilderModule.build = function observedBuild(input) {
  if (!injectThermalStress) return realPlanBuild(input);
  return realPlanBuild({ ...input, thermalStressMultiplier: 1 });
};

function buildContext(level, base) {
  const { prisma, kv, world, pinned, decisionTimeMs } = base;

  /* ── L0: the five zero-fabrication inputs, and nothing else ─────────────── */
  const context = {
    // `TRACE_OMIT_SOH=1` injects the fitted β set WITHOUT a state of health, to attribute
    // the energy wall between the two halves commissioning leaves null.
    prisma: energyInjectingPrisma(
      prisma,
      level >= 4 ? { energy: true, soh: process.env.TRACE_OMIT_SOH === "1" ? undefined : 0.95 } : null,
    ),
    kv,
    shardId: world.shardId,
    regionId: world.region.regionId,
    instanceId: `${RUN}:${process.pid}`,
    runSerializable: (fn) => runSerializable(prisma, fn),
    selectForUpdate,
    isSerializationFailure,
    signingKey: "v1-solve-path-trace-signing-key",
    snapshot: () =>
      snapshotWith(pinned, {
        ...(level >= 2 ? DIAGNOSTIC_SAFETY_REGISTER : {}),
        ...(level >= 9 ? { "candidate.max_radius_by_sla_class": DIAGNOSTIC_CONTAINMENT_RADIUS_M } : {}),
      }),
    values: () => pinned.values,
    record: () => {},

    // 1. `timeBucket` — §20.3's congestion bucket, derived from the round's own pinned
    //    decision time by the module that owns the convention. Zero fabrication: it is
    //    arithmetic on a time the round already pinned.
    timeBucket: timeline.hourOfWeek(decisionTimeMs, 19800),

    // 2. the declared travel-time spread source (N29). `campusTravelModel` already
    //    declares `DECLARED_V1_OPERATIONAL_UNCERTAINTY`; this marks the source, and the
    //    number itself still comes from the routing seam's `travelSdSeconds`.
    travelTimeSpread: require("../../src/engine/routing/campusTravelModel").DECLARED_SPREAD_SOURCE,

    // 3. `Robot.massKg` — read from the column its declared writer populates.
    vehicleMassKgFor: async () => null, // replaced below with the real synchronous reader
    // 4. the simulated environment's ambient and pack temperature.
    environmentFor: () => ({ ambientC: 28, packC: 30 }),
    // 5. the routing profile's speed.
    speedMetresPerSecondFor: () => 1.5,
  };

  // `vehicleMassKgFor` is called synchronously by `planInputFor`, so the column is read
  // once at context-build time rather than per candidate.
  context.vehicleMassKgFor = () => base.vehicleMassKg;

  if (level >= 1) {
    /* ── L1: function seams that supply NO number ────────────────────────── */
    // Each satisfies `coordinatorPipeline`'s presence probe and returns nothing, so the
    // consuming module refuses by name instead of the composition refusing by class.
    context.hopTerrainSource = "NO PRODUCER — declared here so the probe is satisfied; the six-field route contract is the real producer";
    context.failureProbabilityFor = () => null;
    context.routeHazardCuFor = () => null;
    context.batteryWearInputsFor = () => null;
    context.returnLegEnergyWhPerMetreFor = () => null;
  }

  if (level >= 3) {
    context.route = diagnosticRoute();
  }

  if (level >= 5) {
    // DIAGNOSTIC ONLY — a return-leg marginal rate nobody has declared.
    context.returnLegEnergyWhPerMetreFor = () => 0.12;
  }

  if (level >= 6) {
    // DIAGNOSTIC ONLY — p_fail, hazard and the mission half of §14.4.
    context.failureProbabilityFor = () => ({ probability: 0.01, source: "DIAGNOSTIC_INJECTION" });
    context.routeHazardCuFor = () => 0;
    context.batteryWearInputsFor = () => ({
      conditions: { dod: 0.2, socMid: 0.8, tempC: 30, cRate: 0.5 },
      socThroughput: 0.4,
      curves: energyFixture.stressCurves(),
    });
  }

  return context;
}

/* ═══════════════════════════════════════════════════════════════════════════
   Main.
   ═══════════════════════════════════════════════════════════════════════════ */

async function main() {
  const prisma = getPrisma();
  const { kv } = await initKv({ logger: { info() {}, warn() {}, error() {} } });
  const geometry = loadGeometry();

  say("═════════════════════════════════════════════════════════════════════");
  say(" TASK 3 — THE REAL V1 DEMONSTRATION SOLVE PATH, TRACED");
  say(`   target ${target.protocol}//${target.hostname}:${target.port}${target.pathname}`);
  say("   READ-ONLY DIAGNOSIS. No production source, test, schema, migration,");
  say("   register file, gate or configuration is modified by this run.");
  say("═════════════════════════════════════════════════════════════════════\n");

  /* ── Seed ──────────────────────────────────────────────────────────────── */
  say("── SEED ────────────────────────────────────────────────────────────");
  const world = await seed(prisma, geometry);
  say(`   region      ${world.region.regionId} (Region.id ${world.region.id})`);
  say(`   shard       ${world.shardId}`);
  say(`   index cover ${world.indexCover.length} FINE cells (D6 boundary-overlap)`);
  say(`   agent       ${world.agent.agentId}  simulated=true  Robot.massKg=${world.robot.massKg}`);
  say(
    `   commissioning wrote: kappa=${world.provisioned.batteryState.kappa} ` +
      `soc=${world.provisioned.batteryState.lastObservedSoc} soh=${String(world.provisioned.batteryState.soh)} ` +
      `betaDist=${String(world.provisioned.energyModelParams.betaDist)} ` +
      `residualCv=${String(world.provisioned.energyModelParams.residualCv)} ` +
      `stressCurves=${String(world.provisioned.energyModelParams.stressCurves)}`,
  );
  say("");

  /* ── CONFIG PIN ────────────────────────────────────────────────────────── */
  say("── CONFIG PIN ──────────────────────────────────────────────────────");
  let configuration;
  try {
    configuration = await publishConfiguration(prisma, world);
    record("CONFIG PIN", {
      entered: true,
      result: `PUBLISHED AND PINNED — version ${configuration.published.version}`,
      module: "engine/config/service.publish + pinVersion",
      classification: "A (already implemented) for the mechanism; D (owner decision) for the two accommodations it needed",
      note:
        `the 13 demonstration parameters + the labelled V9 accommodation + cutover.engine_enabled for ` +
        `region ${world.region.id}; safetyClassChanges=${configuration.published.safetyClassChanges.length}`,
    });
    say(`   version ${configuration.published.version}`);
    say(`   the 13 resolve: ${demonstration.PARAMETER_NAMES.every((name) => configuration.pinned.resolve(name, {}) !== null)}`);
    say(`   energy.model_residual_cv  = ${String(configuration.pinned.resolve("energy.model_residual_cv", {}))}`);
    say(`   energy.reserve_floor_wh   = ${String(configuration.pinned.resolve("energy.reserve_floor_wh", {}))}`);
  } catch (error) {
    record("CONFIG PIN", {
      entered: true,
      result: "REFUSED",
      module: "engine/config/service.publish",
      refusal: error && error.message,
      classification: "D (owner decision)",
    });
    say(`   REFUSED: ${error && error.message}`);
    await dump(prisma);
    return 1;
  }
  say("");

  const pinned = configuration.pinned;

  /* ── CUTOVER ───────────────────────────────────────────────────────────── */
  say("── CUTOVER ─────────────────────────────────────────────────────────");
  const posture = cutoverEnabled.describe({
    snapshot: pinned,
    shard: { regionId: world.region.id, shardId: world.shardId },
  });
  record("CUTOVER", {
    entered: true,
    result: posture.live ? "LIVE" : "NOT LIVE",
    module: "engine/cutover/enabled.describe",
    refusal: posture.live ? null : posture.consequence,
    dependency: posture.live ? null : "cutover.engine_enabled",
    classification: "D (owner decision) — S-5",
  });
  say(`   processEnabled=${posture.processEnabled} configEnabled=${posture.configEnabled} live=${posture.live}`);
  say("");

  /* ── TASK → VALIDATION → REGION → WORK QUEUE → SHARD ───────────────────── */
  say("── TASK SUBMISSION (the real request path) ─────────────────────────");
  const foodCourt = world.points["rnsit-food-court"];
  const innovation = world.points["rnsit-innovation-center"];
  let submission = null;
  let submissionError = null;
  try {
    submission = await taskService.assignTask(
      prisma,
      {
        taskId: `${RUN}-task`,
        pickup: "RNSIT Food Court",
        pickupLat: foodCourt.lat,
        pickupLon: foodCourt.lon,
        drop: "RNSIT Innovation Center",
        dropLat: innovation.lat,
        dropLon: innovation.lon,
      },
      {
        kv,
        io: null,
        config: pinned,
        // The business key, as an external caller can know it.
        regionId: world.region.regionId,
        slaClass: "STANDARD",
        tenantId: `${RUN}-tenant`,
      },
    );
  } catch (error) {
    submissionError = error;
  }

  if (submissionError) {
    record("TASK", { entered: true, result: "REFUSED", module: "services/task.service.assignTask", refusal: submissionError.message });
    record("TASK VALIDATION", { entered: true, result: "see TASK" });
    say(`   REFUSED (${submissionError.status || "?"} ${submissionError.code || ""}): ${submissionError.message}`);
    await dump(prisma);
    return 1;
  }

  record("TASK", {
    entered: true,
    result: `ACCEPTED — Task ${submission.taskId} created PENDING`,
    module: "services/task.service.assignTask",
    classification: "A (already implemented)",
  });
  record("TASK VALIDATION", {
    entered: true,
    result: "PASSED — pickup/drop, coordinates, payload declaration and requested class all validated pre-write",
    module: "services/task.service.parsePayloadDeclaration + assignTask's pre-write checks",
    classification: "A (already implemented)",
  });
  record("REGION RESOLUTION", {
    entered: true,
    result: `RESOLVED — business key "${world.region.regionId}" → Region.id ${world.region.id}`,
    module: "services/task.service.resolveRegionRowId",
    classification: "A (already implemented)",
  });

  const admitted = submission.intake;
  record("WORK QUEUE", {
    entered: true,
    result: admitted && admitted.queued ? `QUEUED — ${JSON.stringify(admitted.queued).slice(0, 200)}` : `admitted=${JSON.stringify(admitted).slice(0, 300)}`,
    module: "engine/intake/intake.admit + services/task.service.admitToRound",
    classification: "A (already implemented)",
  });
  say(`   task ${submission.taskId} admitted`);

  const queueRows = await prisma.workQueue.findMany();
  const queueRow = queueRows[0] || null;
  record("SHARD RESOLUTION", {
    entered: true,
    result: queueRow ? `WorkQueue.shardId = "${queueRow.shardId}"` : "no WorkQueue row was written",
    module: "engine/intake/intake.resolveShard / resolveShardFor",
    classification: "A (already implemented)",
  });
  say(`   WorkQueue rows: ${queueRows.length}; shardId = ${queueRow ? `"${queueRow.shardId}"` : "(none)"}`);
  if (queueRow && queueRow.shardId !== world.shardId) {
    finding(
      `SPECIAL CHECK 3 — shard resolution produced "${queueRow.shardId}" and the published shard owning this ` +
        `region is "${world.shardId}". claimBatch selects where shardId = the coordinator's own, so this row is ` +
        "invisible to the coordinator that owns the region.",
    );
  } else if (queueRow) {
    say(`   SPECIAL CHECK 3 — resolved to the PUBLISHED shard, not "default". OK.`);
  }

  const stopRows = await prisma.stop.findMany({ orderBy: { sequence: "asc" } });
  record("GEOFENCE", {
    entered: true,
    result: `Stop.geofenceResult pinned at intake: ${JSON.stringify(stopRows.map((row) => row.geofenceResult))}`,
    module: "services/task.service.sealIdentities → engine/spatial/deliveryDomain.evaluatePoint",
    classification: "A (already implemented)",
  });
  say(`   SPECIAL CHECK 2 — Stop.geofenceResult = ${JSON.stringify(stopRows.map((row) => row.geofenceResult))}`);
  const indexMap = hierarchy.indexMap(configuration.spatialPayload);
  say(
    `   stop cells assigned in the published index: ` +
      JSON.stringify(stopRows.map((row) => (row.fineCell ? indexMap.resolve(row.fineCell).assigned : null))),
  );
  say("");

  /* ── AVAILABILITY INDEX — SPECIAL CHECK 1 ──────────────────────────────── */
  say("── AVAILABILITY INDEX (candidate discoverability) ──────────────────");
  const sweep = await indexMaintainer.sweepOnce({
    prisma,
    kv,
    snapshot: pinned,
    chargingStatusFor: chargingStatus.createChargingStatusReader({
      prisma,
      // Stands in for the running simulator's roster: this unit IS simulated, which is
      // the fact `virtualSimulator.managesAgent` reports in a live process.
      inScope: async (subject) => {
        const robot = await prisma.robot.findUnique({ where: { robotId: subject.robotId || "" }, select: { simulated: true } });
        return Boolean(robot && robot.simulated === true);
      },
    }),
  });
  say(`   sweepOnce: ${JSON.stringify(sweep)}`);

  const publishedShardKey = availabilityIndex.fineKey(world.shardId, world.fineCellId, "IDLE_READY");
  const defaultShardKey = availabilityIndex.fineKey("default", world.fineCellId, "IDLE_READY");
  const underPublished = await availabilityIndex.candidatesInFineCell({ kv }, world.shardId, world.fineCellId, ["IDLE_READY"]);
  const underDefault = await availabilityIndex.candidatesInFineCell({ kv }, "default", world.fineCellId, ["IDLE_READY"]);
  say(`   key ${publishedShardKey} → ${JSON.stringify(underPublished)}`);
  say(`   key ${defaultShardKey} → ${JSON.stringify(underDefault)}`);

  // The durable mirror row — which the sweep also rewrites.
  const mirrorAfterSweep = await prisma.agentCellPosition.findUnique({ where: { agentId: world.agent.id }, select: { shardId: true } });
  say(`   AgentCellPosition.shardId after the sweep = "${mirrorAfterSweep.shardId}" (seeded as "${world.shardId}")`);

  if (underPublished.length === 0 && underDefault.length > 0) {
    finding(
      "SPECIAL CHECK 1 — DEFECT. `indexMaintainer.assembleRecord` returns a HARD-CODED " +
        '`shardId: "default"` (indexMaintainer.worker.js:214). `sweepAgents` then (a) writes the KV ' +
        'availability index under `engine:idx:default:…` and (b) UPSERTS `AgentCellPosition.shardId` to ' +
        '"default", overwriting the published shard on the durable mirror row. ' +
        "`expansion.expandCandidates` queries the index under the ROUND's shard and " +
        "`coordinatorSolvePath.expandCandidatesFor` reads `agentCellPosition.findMany({ where: { shardId } })` " +
        "for `fleetBestCase` under the same shard — so after one sweep NO agent is discoverable and NO ring " +
        "floor resolves for any shard but \"default\". This is the first true blocker on candidate discovery.",
    );
  } else if (underPublished.length > 0) {
    say("   SPECIAL CHECK 1 — the agent is discoverable under the published shard. OK.");
  } else {
    finding("SPECIAL CHECK 1 — the agent is not in the availability index under either shard id.");
  }

  /* ── DIAGNOSTIC REPAIR, so the trace can continue past that blocker ──────
   * The mirror row's `shardId` is restored to the value intake and the published `Shard`
   * table both name, and the index is rebuilt with `rebuildIndexFromMirror` — the OTHER
   * shipped producer, which reads the row's real `shardId` rather than a constant. No
   * value is invented: this repairs a column the sweep overwrote, back to the published
   * fact. It is a repair of corrupted data, not an input. */
  await prisma.agentCellPosition.update({ where: { agentId: world.agent.id }, data: { shardId: world.shardId } });
  const rebuilt = await indexMaintainer.rebuildIndexFromMirror({ prisma, kv });
  const afterRebuild = await availabilityIndex.candidatesInFineCell({ kv }, world.shardId, world.fineCellId, ["IDLE_READY"]);
  say(`   [DIAGNOSTIC REPAIR] AgentCellPosition.shardId restored to "${world.shardId}"`);
  say(`   rebuildIndexFromMirror: ${JSON.stringify(rebuilt)}`);
  say(`   after rebuild, key ${publishedShardKey} → ${JSON.stringify(afterRebuild)}`);
  record("CANDIDATE DISCOVERY", {
    note:
      `the periodic sweep indexed under "default" AND rewrote the mirror row's shardId to "default"; ` +
      `after restoring the published shard and running the Cold Index rebuild, ` +
      `${afterRebuild.length} candidate(s) are discoverable under "${world.shardId}"`,
  });
  say("");

  /* ── LEADERSHIP ────────────────────────────────────────────────────────── */
  say("── LEADER / COORDINATOR START ──────────────────────────────────────");
  const store = election.assertConsensusStore(
    election.postgresLeadershipStore(prisma, { replicationPosture: "SINGLE_PRIMARY_NO_AUTOMATIC_FAILOVER" }),
  );
  const storeTime = await require("../../src/engine/commitment/clock").readStoreTime(prisma);
  const session = await election.acquire(store, {
    shardId: world.shardId,
    candidateId: `${RUN}:${process.pid}`,
    storeTime,
    leaseDurationSeconds: pinned.resolve("shard.lease_duration", {}) || 30,
  });
  say(`   election: state=${session.state} fence=${String(session.leadershipFence)} refusal=${String(session.lastRefusal)}`);
  record("LEADER / COORDINATOR START", {
    entered: true,
    result: session.state === "LEADER" ? `LEADER ACQUIRED — fence ${String(session.leadershipFence)}` : `NOT LEADER — ${String(session.lastRefusal)}`,
    module: "engine/shard/election.acquire (postgresLeadershipStore)",
    classification: "A (already implemented); the replication posture is D (owner declaration per deployment)",
  });
  say("");

  /* ── COMPOSITION + ROUND, per injection level ──────────────────────────── */
  const decisionTimeMs = storeTime.getTime();
  const base = { prisma, kv, world, pinned, decisionTimeMs, vehicleMassKg: world.robot.massKg };
  const levelReports = [];
  let assemblyForProbe = null;

  for (const { level, label } of LEVELS) {
    say(`── ${label} ────────────────────────────────────────`);
    gateBypass = level >= 7;
    injectThermalStress = level >= 8;

    if (level === 5) {
      // DIAGNOSTIC ONLY — one depot-class charger at the agent's own cell, so §14.5's
      // `E_return` has a destination. `RD-2026-08-30-01` records that NO production
      // charger exists at either campus, and §11 step 5 makes the estate and the
      // return-leg rate one owner decision taken together. This row is neither: it exists
      // so the trace can see what lies past `reserves.compose`, and it is dropped with the
      // cluster.
      await prisma.charger.upsert({
        where: { chargerId: `${RUN}-depot` },
        create: {
          chargerId: `${RUN}-depot`,
          regionId: world.region.id,
          cellId: world.fineCellId,
          chargerClass: "STANDARD",
          isDepot: true,
          latitude: world.agentPoint.lat,
          longitude: world.agentPoint.lon,
        },
        update: {},
      });
      say(`   [DIAGNOSTIC] one depot-class Charger row created at cell ${world.fineCellId}`);
    }
    const context = buildContext(level, base);
    const enriched = coordinatorSolvePath.contextFor(context);
    const contract = coordinatorPipeline.requirements(enriched);
    const total = coordinatorPipeline.REQUIREMENT_IDS.length;
    say(`   composition: ${contract.satisfied.length} / ${total} satisfied, ${contract.missing.length} unresolved`);
    say(`   byClass: ${JSON.stringify(contract.byClass)}`);
    for (const row of contract.missing) say(`     - [${row.class}] ${row.input}`);

    const report = { level, label, satisfied: contract.satisfied.length, total, missing: contract.missing.map((r) => ({ input: r.input, class: r.class })), round: null };

    if (level === 0) {
      record("COMPOSITION", {
        entered: true,
        result: `${contract.satisfied.length} / ${total} satisfied at L0 (legitimate inputs only)`,
        module: "workers/coordinatorSolvePath.create → workers/coordinatorPipeline.requirements",
        refusal: contract.ok ? null : coordinatorPipeline.describeMissing(contract.missing),
        level: "L0",
      });
    }

    if (contract.ok) {
      const assembly = coordinatorSolvePath.create(context);
      if (!assembly.ok) {
        say(`   create() REFUSED: ${assembly.blockedBy}`);
        report.round = { refused: assembly.blockedBy };
      } else {
        record("COMPOSITION", { entered: true, result: `ASSEMBLED at ${label}`, level: `L${level}` });
        // Twice. The first round of a process pays JIT, connection and cache costs and
        // routinely exceeds `solve.time_budget` (250 ms) before a candidate is evaluated;
        // that is a real effect worth reporting but it is not the boundary this trace is
        // after, so the second, warm round is the one classified.
        say("   round 1 (cold):");
        const cold = await runOneRound(prisma, kv, assembly, world, pinned, session, level);
        say("   round 2 (warm):");
        const warm = await runOneRound(prisma, kv, assembly, world, pinned, session, level);
        report.round = { cold: summarise(cold), warm };
      }
    }
    levelReports.push(report);
    if (level === LEVELS[LEVELS.length - 1].level && assemblyForProbe === null && contract.ok) {
      assemblyForProbe = coordinatorSolvePath.create(context);
    }
    say("");
  }

  /* ── COMMIT / OFFER probe — the stage behind the identity defect ─────────── */
  say("── COMMIT / OFFER PROBE (§10.3.2, the real commit) ─────────────────");
  await commitProbe(prisma, kv, base, world, pinned, session);
  say("");

  /* ── OFFER → ACCEPT reachability ───────────────────────────────────────── */
  say("── OFFER / ROBOT ACCEPT / MISSION EXECUTION ────────────────────────");
  const commitments = await prisma.commitment.count();
  const outbox = await prisma.outbox.findMany();
  const rounds = await prisma.round.count();
  say(`   Commitment rows: ${commitments}   Outbox rows: ${outbox.length}   Round rows: ${rounds}`);
  record("OFFER", {
    entered: outbox.length > 0,
    result: outbox.length > 0 ? `${outbox.length} outbox row(s) written` : "NOT REACHED — no assignment was produced, so §10.3.2 step 5 never ran",
    module: "engine/dispatch/offers.enqueueOffer (inside engine/commitment/commit)",
  });
  record("ASSIGNMENT", {
    entered: commitments > 0,
    result: commitments > 0 ? `${commitments} Commitment row(s)` : "NOT REACHED — no commitment written",
    module: "engine/commitment/commit.commit",
  });
  say("");

  await report(levelReports, world);
  await dump(prisma);
  return 0;
}


/**
 * §10.3.2's commit, called directly, with each of the two identifier conventions the
 * round mixes — so the stage behind the memo-key defect is measured rather than inferred.
 *
 * `solve/round.plan` builds its `legs` from the WorkQueue row's `legId` and its candidate
 * agent ids from the availability index, which are the **row** primary keys; the assembly
 * memoises everything under the **business** keys. Both calls below are the real
 * production `commit` from `coordinatorSolvePath.create()`.
 */
async function commitProbe(prisma, kv, base, world, pinned, session) {
  const context = buildContext(LEVELS[LEVELS.length - 1].level, base);
  const assembly = coordinatorSolvePath.create(context);
  if (!assembly.ok) {
    say(`   the assembly refused, so no commit could be probed: ${assembly.blockedBy}`);
    return;
  }

  // Populate the round's memo by running one real round.
  gateBypass = true;
  injectThermalStress = true;
  const round = await runOneRound(prisma, kv, assembly, world, pinned, session, LEVELS[LEVELS.length - 1].level);
  const memoKeys = [...assembly.round.priced.keys()];
  say(`   memo after the round: ${JSON.stringify(memoKeys)}`);

  const leg = await prisma.leg.findFirst({ orderBy: { sequence: "asc" } });
  const roundResult = { roundId: `${RUN}-probe-round`, leadershipFence: session.leadershipFence ?? null };

  for (const attempt of [
    { label: "row ids (what the solver actually supplies)", legId: leg.id, agentId: world.agent.id },
    { label: "business ids (what the assembly memoises under)", legId: leg.legId, agentId: world.agent.agentId },
  ]) {
    let outcome;
    try {
      // eslint-disable-next-line no-await-in-loop
      outcome = await assembly.deps.commit({ legId: attempt.legId, agentId: attempt.agentId }, roundResult);
    } catch (error) {
      outcome = { threw: error && error.message };
    }
    say(`   commit with ${attempt.label}:`);
    say(`     ${JSON.stringify(outcome).slice(0, 900)}`);
    record("ASSIGNMENT", {
      note: `direct §10.3.2 commit with ${attempt.label} → ${outcome.threw ? `THREW ${outcome.threw}` : `${outcome.outcome || "?"} ${outcome.reason || ""}`}`,
    });
    if (outcome && outcome.committed === true) {
      record("ASSIGNMENT", { entered: true, result: `COMMITTED via the direct probe (${attempt.label})`, module: "engine/commitment/commit.commit", level: "PROBE" });
    }
  }

  const commitments = await prisma.commitment.findMany();
  const outbox = await prisma.outbox.findMany();
  say(`   after the probe: Commitment rows=${commitments.length} Outbox rows=${outbox.length}`);
  if (outbox.length > 0) {
    const row = outbox[0];
    say(`     outbox[0]: kind=${row.commandType || row.kind || "?"} state=${row.state} agentId=${row.agentId}`);
    record("OFFER", {
      entered: true,
      result: `REACHED via the direct commit probe — ${outbox.length} Outbox row(s) written inside the commit transaction`,
      module: "engine/dispatch/offers.enqueueOffer",
      level: "PROBE",
    });
  }
  return { memoKeys, round };
}

/** A one-line summary of a round, for the level table. */
function summarise(round) {
  if (!round) return null;
  if (round.threw) return { threw: round.threw };
  if (round.ran !== true) return { ran: false, reason: round.reason };
  return {
    ran: true,
    outcome: round.outcome,
    decisions: round.decisions.map((row) => row.outcome),
    agentsEvaluated: (round.observed.expansions[0] || {}).agentsEvaluated ?? null,
  };
}

/**
 * Run one real round and classify where it stopped.
 *
 * @returns {Promise<object>}
 */
async function runOneRound(prisma, kv, assembly, world, pinned, session, level) {
  const finite = (name) => {
    const value = pinned.resolve(name, {});
    return isNumber(value) ? value : undefined;
  };

  /* ── Read-only observation wrappers ─────────────────────────────────────
   * `solve/round.plan` keeps the expansion's `problems` and discards them: the per-Leg
   * decision row carries `cellsExplored`, `agentsEvaluated`, `truncatedBy` and a fixed
   * sentence, and `finish()` has no `problems` field at all. `expansion.evaluateOne`
   * likewise uses `evaluateExact`'s result to filter and never carries its `refusal` or
   * `problems` anywhere. Both are the decisive diagnostic for this trace, so both are
   * OBSERVED here. Neither wrapper changes a value or a control flow. */
  const observed = { expansions: [], evaluations: [], gate: [], tiers: [], priced: [] };
  tiersObserver = (stage, outcome) => {
    observed.tiers.push({
      stage,
      ok: outcome.ok,
      problems: outcome.problems || outcome.missing || [],
      bindingTier: outcome.bindingTier ?? null,
      basis: outcome.verdict ? outcome.verdict.basis ?? null : null,
    });
  };
  gateObserver = (outcome) => {
    observed.gate.push({
      feasible: outcome.feasible,
      // The observer runs BEFORE the bypass is applied, so this records whether the bypass
      // WILL fire rather than reading a flag the real gate never sets.
      bypassed: gateBypass === true && outcome.feasible !== true,
      evaluated: (outcome.outcome && outcome.outcome.evaluated) || [],
      denials: ((outcome.outcome && outcome.outcome.denials) || []).map((denial) => ({
        predicateId: denial.predicateId,
        outcome: denial.outcome,
        policy: denial.policy,
        constraintClass: denial.constraintClass,
        deniedForIndeterminacy: denial.deniedForIndeterminacy,
        required: denial.result && denial.result.required,
        observed: denial.result && denial.result.observed,
        reason: denial.result && denial.result.reason,
        inputSource: denial.result && denial.result.inputSource,
      })),
    });
  };
  const realExpand = assembly.deps.expandCandidates;
  const realEvaluate = assembly.round.evaluateExact;
  assembly.round.evaluateExact = async (agentId, leg, agentSnapshot) => {
    const snapshot =
      level >= 8
        ? {
            ...agentSnapshot,
            // DIAGNOSTIC ONLY — §8.3's staleness is measured on the oldest safety-relevant
            // observation. The agent's own position Observation is the one this deployment
            // genuinely has; nothing in `src/` assembles this map, so it is built here.
            safetyRelevantObservations: { position: { observedAtMs: agentSnapshot.observedAtMs } },
          }
        : agentSnapshot;
    const outcome = await realEvaluate(agentId, leg, snapshot);
    const args = [agentId];
    observed.evaluations.push({
      agentId: args[0],
      feasible: outcome.feasible,
      refusal: outcome.refusal || null,
      problems: outcome.problems ? [...outcome.problems] : null,
      denials: outcome.denials ? [...outcome.denials] : null,
      deniedForIndeterminacyOnly: outcome.deniedForIndeterminacyOnly ?? null,
    });
    return outcome;
  };
  const realPriced = assembly.deps.pricedCandidateFor;
  const wrappedDeps = {
    ...assembly.deps,
    record: () => {},
    // `solve/round.plan` turns a surviving candidate into a column ONLY if this returns an
    // entry. Observed because a miss is silent (`if (!entry) continue;`).
    pricedCandidateFor: (agentId, legId, candidate) => {
      const entry = realPriced(agentId, legId, candidate);
      observed.priced.push({
        askedAgentId: agentId,
        askedLegId: legId,
        hit: Boolean(entry),
        memoKeys: [...assembly.round.priced.keys()],
      });
      return entry;
    },
    expandCandidates: async (input) => {
      const outcome = await realExpand(input);
      observed.expansions.push({
        legId: input.legId,
        ok: outcome.ok,
        candidates: (outcome.candidates || []).length,
        cellsExplored: outcome.cellsExplored,
        agentsEvaluated: outcome.agentsEvaluated,
        truncatedBy: outcome.truncatedBy ?? null,
        unresolvedBoundAgentIds: outcome.unresolvedBoundAgentIds || [],
        problems: outcome.problems || [],
      });
      return outcome;
    },
  };

  let result;
  try {
    result = await coordinatorWorker.runRound(
      wrappedDeps,
      {
        shardId: world.shardId,
        instanceId: `${RUN}:${process.pid}`,
        regionId: world.region.regionId,
        config: {
          maxEvaluatedPerLeg: finite("candidate.max_evaluated"),
          maxColumnsPerRound: finite("plan.max_columns_per_round"),
          branchNodeBudget: finite("solve.branch_node_budget"),
          timeBudgetMs: assembly.context.expansionWallClockBudgetMs,
          maxClockSkewMillis: finite("time.max_clock_skew"),
          storeRoundTripMillis: finite("time.store_round_trip"),
          windowMinMs: finite("solve.window_min"),
          windowMaxMs: finite("solve.window_max"),
          saturatedWindowMs: finite("solve.saturated_window"),
          maxLegsPerRound: finite("solve.max_legs_per_round"),
        },
        killSwitches: {},
      },
    );
  } catch (error) {
    say(`   runRound THREW: ${error && error.message}`);
    return { threw: error && error.message, observed };
  }

  if (result.ran !== true) {
    say(`   round did not run: ${result.reason} ${result.detail || ""}`);
    return { ran: false, reason: result.reason, detail: result.detail || null, observed };
  }

  const decisions = (result.result && result.result.decisions) || [];
  say(`   round ${result.roundId} ran: ${decisions.length} decision(s), regime ${result.result.regime}`);
  const summary = [];
  for (const decision of decisions) {
    say(`     leg ${decision.legId}: ${decision.outcome}`);
    const detail = decision.detail ? String(decision.detail) : "";
    if (detail) say(`       detail: ${detail.slice(0, 900)}`);
    summary.push({ legId: decision.legId, outcome: decision.outcome, detail: detail.slice(0, 1500), agentId: decision.agentId || null });
  }

  // The OBSERVED expansion and per-candidate refusals — the decisive diagnostic, and the
  // one the shipped result object does not carry. NOT truncated.
  for (const expansion of observed.expansions) {
    say(
      `     expansion leg=${expansion.legId} ok=${expansion.ok} candidates=${expansion.candidates} ` +
        `cells=${expansion.cellsExplored} agentsEvaluated=${expansion.agentsEvaluated} truncatedBy=${expansion.truncatedBy}`,
    );
    for (const problem of expansion.problems) say(`       expansion problem: ${problem}`);
    if (expansion.unresolvedBoundAgentIds.length > 0) {
      say(`       unresolvedBoundAgentIds: ${JSON.stringify(expansion.unresolvedBoundAgentIds)}`);
    }
  }
  for (const evaluation of observed.evaluations) {
    say(`     evaluateExact agent=${evaluation.agentId} feasible=${evaluation.feasible} refusal=${evaluation.refusal}`);
    for (const problem of evaluation.problems || []) say(`       -> ${problem}`);
  }
  // §14.5's energy chain — eReturn → reserves.compose → tiers. `planBuilder.buildVariant`
  // swallows every one of these `problems` lists.
  const seenStages = new Set();
  for (const row of [...observed.tiers].reverse()) {
    if (seenStages.has(row.stage)) continue;
    seenStages.add(row.stage);
    say(`     §14.5 ${row.stage}: ok=${row.ok}${row.basis ? ` basis=${row.basis}` : ""}${row.bindingTier ? ` binding=${row.bindingTier}` : ""}`);
    for (const problem of row.problems) say(`       -> ${problem}`);
  }
  // The §7.1 gate's COMPLETE denial list — every predicate that denied, with the input it
  // named. The shipped gate reports only the first; this is the whole map in one pass.
  const lastGate = observed.gate[observed.gate.length - 1] || null;
  if (lastGate) {
    const denied = new Set(lastGate.denials.map((row) => row.predicateId));
    say(
      `     §7.1 gate: ${lastGate.evaluated.length} predicates evaluated, ${lastGate.denials.length} denied` +
        `${lastGate.bypassed ? "  [DIAGNOSTIC BYPASS APPLIED]" : ""}`,
    );
    say(`     SATISFIED: ${lastGate.evaluated.filter((id) => !denied.has(id)).join(", ") || "(none)"}`);
    for (const denial of lastGate.denials) {
      say(
        `       ${denial.predicateId} ${denial.outcome} (${denial.constraintClass}/${denial.policy}) ` +
          `required=${JSON.stringify(denial.required)} observed=${JSON.stringify(denial.observed)}`,
      );
      if (denial.reason) say(`           reason: ${String(denial.reason).slice(0, 300)}`);
    }
  }

  // §9.3's partition reports — where the solver's own refusal lives.
  const partitions = (result.result && result.result.partitions) || [];
  say(`     partitions: ${partitions.length}`);
  for (const part of partitions) {
    say(
      `       part root=${part.root} ok=${part.ok}` +
        (part.ok
          ? ` solver=${part.solver} legs=${part.legCount} columns=${part.columnCount} ` +
            `objective=${String(part.objectiveMilliCU)} unassigned=${JSON.stringify(part.unassigned)} ` +
            `budgetLimited=${part.budgetLimited} certified=${part.optimalityCertified}`
          : ` problems=${JSON.stringify(part.problems)}`),
    );
  }
  const columns = (result.result && result.result.columns) || null;
  if (columns) say(`     columns: generated=${columns.generated} kept=${columns.kept} pruned=${columns.pruned} budgetTruncated=${columns.budgetTruncated}`);
  for (const ask of observed.priced) {
    say(`     pricedCandidateFor(agentId=${ask.askedAgentId}, legId=${ask.askedLegId}) -> ${ask.hit ? "HIT" : "MISS"}`);
    say(`       memoised keys (legId|agentId): ${JSON.stringify(ask.memoKeys)}`);
  }

  classifyRound(result, level, observed, partitions);

  return {
    ran: true,
    roundId: result.roundId,
    regime: result.result.regime,
    outcome: result.result.outcome,
    decisions: summary,
    observed,
    committed: (result.result.committed || []).length,
  };
}

/**
 * Turn one round's outcome into stage rows.
 */
function classifyRound(result, level, observed, partitions) {
  const tag = `L${level}`;
  const decisions = (result.result && result.result.decisions) || [];
  const first = decisions[0] || null;
  if (!first) return;

  const outcome = first.outcome;
  const expansion = observed.expansions[0] || null;
  const evaluation = observed.evaluations[0] || null;

  record("CANDIDATE DISCOVERY", {
    entered: true,
    result:
      `${outcome} — cellsExplored=${first.cellsExplored ?? "?"} agentsEvaluated=${first.agentsEvaluated ?? "?"} ` +
      `candidates=${expansion ? expansion.candidates : "?"}`,
    module: "engine/candidates/expansion.expandCandidates",
    refusal: expansion && expansion.problems.length > 0 ? expansion.problems.join(" | ") : null,
    level: tag,
  });

  if (!evaluation) return;

  record("ROBOT SNAPSHOT", {
    entered: true,
    result: "LOADED — the agent snapshot reached evaluateExact",
    module: "workers/coordinatorSolvePath.agentSnapshotLoaderFor",
    level: tag,
  });

  const problems = (evaluation.problems || []).join(" | ");
  const refusal = evaluation.refusal;
  const has = (needle) => problems.toLowerCase().includes(needle.toLowerCase());

  if (refusal === "MISSING_HOP") {
    record("ROUTING", {
      entered: true,
      result: "REFUSED",
      module: "engine/routing/cellPairCache.hopsFor",
      refusal: problems,
      dependency: "route (B1)",
      level: tag,
    });
    return;
  }

  record("ROUTING", {
    entered: true,
    result: level >= 3 ? "RESOLVED against the DIAGNOSTIC route double" : "RESOLVED",
    module: "engine/routing/cellPairCache.hopsFor → deps.route",
    level: tag,
  });

  if (refusal === "PLAN_REFUSED") {
    const energyNames = (evaluation.problems || []).filter((row) =>
      /beta_|eta_regen|residual|usable|soh|kappa|energy|consumption/i.test(row),
    );
    const returnNames = (evaluation.problems || []).filter((row) => /return|reserve|charger|E_return/i.test(row));
    if (energyNames.length > 0) {
      record("ENERGY", {
        entered: true,
        result: "REACHED AND REFUSED",
        module: "engine/plan/planBuilder.legProfiles → engine/energy/consumption.legEnergyWh",
        refusal: energyNames.join(" | "),
        level: tag,
      });
    } else {
      record("ENERGY", { entered: true, result: "PASSED — the consumption model evaluated", module: "engine/energy/consumption", level: tag });
    }
    if (returnNames.length > 0) {
      record("RETURN ENERGY", {
        entered: true,
        result: "REACHED AND REFUSED",
        module: "engine/energy/eReturn.evaluate → engine/energy/reserves.compose",
        refusal: returnNames.join(" | "),
        level: tag,
      });
    }
    record("FEASIBILITY", { result: "NOT REACHED — the Plan Builder refused first", module: "engine/feasibility/evaluate.gate", level: tag });
    return;
  }

  // The plan built.
  const energyChain = (stage) => [...observed.tiers].reverse().find((row) => row.stage === stage) || null;
  const composeRow = energyChain("reserves.compose");
  const tiersRow = energyChain("tiers");
  const eReturnRow = energyChain("eReturn");
  record("ENERGY", {
    entered: true,
    result:
      `${level >= 4 ? "PASSED ONLY UNDER THE DIAGNOSTIC FITTED FIXTURE" : "PASSED"} — ` +
      `§14.2 consumption evaluated and a plan was built` +
      (tiersRow ? `; §14.5 tiers ok=${tiersRow.ok}${tiersRow.bindingTier ? ` binding=${tiersRow.bindingTier}` : ""}` : ""),
    module: "engine/plan/planBuilder.build → engine/energy/consumption.legEnergyWh",
    refusal: tiersRow && !tiersRow.ok ? tiersRow.problems.join(" | ") : null,
    level: tag,
  });
  record("RETURN ENERGY", {
    entered: true,
    result:
      composeRow && composeRow.ok
        ? `RESERVES COMPOSED${level >= 5 ? " ONLY UNDER THE DIAGNOSTIC CHARGER + RETURN-LEG RATE" : ""}` +
          (eReturnRow ? `; eReturn basis=${eReturnRow.basis}` : "")
        : `REFUSED — reserves.compose missing ${JSON.stringify(composeRow ? composeRow.problems : ["(not reached)"])}` +
          (eReturnRow ? `; eReturn ok=${eReturnRow.ok} basis=${eReturnRow.basis}` : ""),
    module: "engine/energy/eReturn.evaluate → engine/energy/reserves.compose → engine/energy/tiers.evaluate",
    refusal: composeRow && !composeRow.ok ? composeRow.problems.join(" | ") : null,
    level: tag,
  });

  if (refusal === "INFEASIBLE") {
    const gateRow = observed.gate[observed.gate.length - 1] || { denials: [], evaluated: [] };
    record("FEASIBILITY", {
      entered: true,
      result:
        `REACHED — ${gateRow.evaluated.length} predicates evaluated, DENIED by ` +
        `${gateRow.denials.map((row) => `${row.predicateId}:${row.outcome}`).join(", ")} ` +
        `(indeterminacyOnly=${evaluation.deniedForIndeterminacyOnly})`,
      module: "engine/feasibility/evaluate.gate",
      refusal: gateRow.denials.map((row) => `${row.predicateId} — ${row.reason || `required ${JSON.stringify(row.required)}, observed ${JSON.stringify(row.observed)}`}`).join(" | "),
      level: tag,
    });
    return;
  }

  const gateRow = observed.gate[observed.gate.length - 1] || { denials: [], evaluated: [], bypassed: false };
  record("FEASIBILITY", {
    entered: true,
    result: gateRow.bypassed
      ? `**DIAGNOSTIC BYPASS APPLIED** — the real gate DENIED: ${gateRow.denials.length} of ` +
        `${gateRow.evaluated.length} predicates deny (${gateRow.denials.map((row) => row.predicateId).join(", ")}). ` +
        "The pairing was force-admitted so the stages behind the gate could be measured; this is NOT a pass."
      : "PASSED — §7.1's gate admitted the pairing",
    module: "engine/feasibility/evaluate.gate",
    refusal: gateRow.denials
      .map((row) => `${row.predicateId} — ${row.reason || `required ${JSON.stringify(row.required)}, observed ${JSON.stringify(row.observed)}`}`)
      .join(" | "),
    level: tag,
  });

  if (refusal === "UNPRICEABLE") {
    if (has("failure")) {
      record("RELIABILITY", {
        entered: true,
        result: "REACHED AND REFUSED",
        module: "engine/cost/cRisk.evaluate",
        refusal: (evaluation.problems || []).filter((row) => /failure/i.test(row)).join(" | "),
        level: tag,
      });
    }
    record("COST", {
      entered: true,
      result: "REACHED AND REFUSED",
      module: "engine/cost/phi.evaluate → engine/plan/column.price",
      refusal: problems,
      level: tag,
    });
    return;
  }

  record("RELIABILITY", {
    entered: true,
    result:
      level >= 6
        ? "REACHED AND PRICED — but only against the DIAGNOSTIC injected p_fail; no producer exists"
        : "REACHED AND PRICED",
    module: "engine/cost/cRisk.evaluate",
    level: tag,
  });
  record("COST", {
    entered: true,
    result: `PRICED — γ resolved${level >= 8 ? " (with the two DIAGNOSTIC Φ inputs injected: safetyRelevantObservations, thermalStressMultiplier)" : ""}`,
    module: "engine/cost/phi.evaluate + engine/plan/column.price",
    refusal: null,
    level: tag,
  });

  const parts = partitions || [];
  const failedParts = parts.filter((part) => !part.ok);
  record("SOLVER / DTARO", {
    entered: true,
    result:
      `REACHED — regime ${result.result.regime}, ${parts.length} partition(s), outcome ${result.result.outcome}` +
      (parts.length > 0 && parts[0].ok
        ? `; solver=${parts[0].solver} columns=${parts[0].columnCount} objective=${String(parts[0].objectiveMilliCU)} ` +
          `unassigned=${JSON.stringify(parts[0].unassigned)} certified=${parts[0].optimalityCertified}`
        : ""),
    module: "engine/solve/round.plan → engine/solve/objective.buildInstance → engine/solve/minCostFlow.solve",
    refusal: failedParts.length > 0 ? JSON.stringify(failedParts.map((part) => part.problems)) : null,
    level: tag,
  });

  if (outcome === "ASSIGNED") {
    record("ASSIGNMENT", { entered: true, result: `ASSIGNED agent ${first.agentId}`, module: "engine/solve/round.execute → engine/commitment/commit", level: tag });
  } else {
    record("ASSIGNMENT", { result: `NOT ASSIGNED — ${outcome}`, module: "engine/solve/round.execute", refusal: String(first.detail || "").slice(0, 600), level: tag });
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   Report.
   ═══════════════════════════════════════════════════════════════════════════ */

async function report(levelReports, world) {
  say("═════════════════════════════════════════════════════════════════════");
  say(" STAGE TRACE");
  say("═════════════════════════════════════════════════════════════════════");
  for (const name of STAGE_ORDER) {
    const row = stages.get(name);
    say(`\n${name}`);
    say(`   ENTERED   ${row.entered ? "yes" : "no"}${row.level ? `  (${row.level})` : ""}`);
    say(`   RESULT    ${row.result === null ? "NOT REACHED" : row.result}`);
    if (row.module) say(`   MODULE    ${row.module}`);
    if (row.refusal) say(`   REFUSAL   ${row.refusal}`);
    if (row.dependency) say(`   DEPENDS   ${row.dependency}`);
    if (row.classification) say(`   CLASS     ${row.classification}`);
    for (const note of row.notes) say(`   NOTE      ${note}`);
  }

  say("\n═════════════════════════════════════════════════════════════════════");
  say(" COMPOSITION BY INJECTION LEVEL");
  say("═════════════════════════════════════════════════════════════════════");
  for (const row of levelReports) {
    say(`${row.label}: ${row.satisfied} / ${row.total} satisfied`);
    for (const missing of row.missing) say(`     - [${missing.class}] ${missing.input}`);
    if (row.round) say(`     round: ${JSON.stringify(row.round).slice(0, 1200)}`);
  }

  say("\n═════════════════════════════════════════════════════════════════════");
  say(" FINDINGS");
  say("═════════════════════════════════════════════════════════════════════");
  if (findings.length === 0) say("   (none)");
  for (const row of findings) say(`   ! ${row}`);

  // Machine-readable, for the write-up. Written outside the repository: this harness must
  // leave no artefact behind in the working tree.
  const out = path.join(process.env.TEMP || require("os").tmpdir(), "v1-solve-path-trace.json");
  try {
    fs.writeFileSync(
      out,
      JSON.stringify({ stages: [...stages.values()], levels: levelReports, findings }, null, 2),
    );
    say(`\n   trace written to ${out}`);
  } catch {
    /* the console output is the deliverable */
  }
}

async function dump(prisma) {
  try {
    await prisma.$disconnect();
  } catch {
    /* ignore */
  }
}

main()
  .then((code) => process.exit(code))
  .catch(async (error) => {
    console.error(error);
    process.exit(1);
  });
