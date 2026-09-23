"use strict";

/**
 * Seed the **minimum V1 DEMONSTRATION world** onto a local, disposable PostgreSQL cluster.
 *
 * ── What this is ───────────────────────────────────────────────────────────
 * One region, one shard, one commissioned *simulated* robot, one depot-class charger, and
 * one published-and-pinned configuration version. Nothing else. It exists so that the
 * **real** request path — `POST /api/tasks/assign` → intake → WorkQueue → the real
 * coordinator → the real feasibility gate → the real solve → the real commit — has a world
 * to run against.
 *
 * ── What it is NOT ─────────────────────────────────────────────────────────
 *   * **Not a second architecture.** Every row is written by the service that owns it:
 *     `robot.service.createRobotWithProjection` commissions the robot (the same call the
 *     API makes), `agentEnergyProvisioning.provisionAgentEnergyState` writes the battery
 *     state, `deliveryDomain.validateDomainDeclaration` validates the domain, and
 *     `config/service.publish` publishes the version. This file creates no model of its own.
 *   * **Not a demo coordinator.** It seeds data and stops. It does not assign, does not
 *     pick a robot, and cannot: the coordinator is the engine's, untouched.
 *   * **Not production calibration.** Every declared figure below is a DEVELOPMENT
 *     SIMULATION value for a simulated unit, labelled as such, and none of it is a
 *     measurement of any physical robot.
 *
 * ── The one physical quantity this deliberately does NOT invent ────────────
 * `services/robotSpecification.js` records that the owner declared a pack capacity of
 * **6000 mAh** for the simulated fleet, and that *"6000 mAh cannot become Wh without a
 * declared nominal pack voltage"* — so it refuses to convert it. This tool does not convert
 * it either. The simulated unit's pack is seeded at `simulation/constants.PACK_NOMINAL_WH`,
 * which is the simulator's **own declared DEVELOPMENT constant** for a simulated pack, and
 * the physical robot's 6000 mAh stays unresolved until a nominal voltage is declared. That
 * is a physical-robot-integration input, not a demonstration one.
 *
 * ── Local only, enforced ───────────────────────────────────────────────────
 * The host must be loopback and the port must not be 5432. A demonstration world has no
 * business anywhere but a throwaway cluster, and the check fails the run rather than
 * appearing in a runbook.
 *
 * Usage:
 *   node tools/demo/seedV1Demonstration.js --database-url postgresql://…@127.0.0.1:55432/db
 *                                          [--shard-id v1demo-shard] [--json]
 */

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const h3 = require("h3-js");

const BACKEND_ROOT = path.resolve(__dirname, "..", "..");
const REPO_ROOT = path.resolve(BACKEND_ROOT, "..");

const configService = require(path.join(BACKEND_ROOT, "src/engine/config/service"));
const deliveryDomain = require(path.join(BACKEND_ROOT, "src/engine/spatial/deliveryDomain"));
const cells = require(path.join(BACKEND_ROOT, "src/engine/spatial/cells"));
const robotService = require(path.join(BACKEND_ROOT, "src/services/robot.service"));
const robotSpecification = require(path.join(BACKEND_ROOT, "src/services/robotSpecification"));
const agentEnergyProvisioning = require(path.join(BACKEND_ROOT, "src/services/agentEnergyProvisioning.service"));
const observationModel = require(path.join(BACKEND_ROOT, "src/engine/domain/observation"));
const simulationConstants = require(path.join(BACKEND_ROOT, "src/simulation/constants"));

const publishTool = require(path.join(BACKEND_ROOT, "tools/config/publishV1Demonstration"));
const demonstration = require(path.join(BACKEND_ROOT, "tools/config/v1DemonstrationConfig"));

/** The adopted RNSIT boundary (RD-2026-08-30-01), pinned by digest. */
const BOUNDARY_SHA256 = "04cb64c4205dc59462e149501fdd93b412106cfdc8d7249661bc8f3f47dc08b4";
const BOUNDARY_WAY = "way/1120154292";
const FINE = cells.H3_RESOLUTION.FINE;

/**
 * The simulated unit's commissioning specification.
 *
 * Three of the six fields are the owner's declared `STANDARD` DEVELOPMENT preset, read from
 * `robotSpecification.SIMULATION_PRESET` rather than copied. The other three are the ones
 * the preset deliberately leaves blank (`PRESET_UNDECLARED_FIELDS`), declared here as
 * **DEVELOPMENT SIMULATION values for a simulated unit** and sourced, where the simulator
 * already states one, from the simulator's own constants.
 *
 * @structural the demonstration unit's declared specification; not a measurement
 */
function simulatedSpecification() {
  const preset = robotSpecification.simulationPresetValues("STANDARD");
  return {
    // ── owner-declared preset (massKg, normalSpeedMps, payloadCapacityKg) ──
    ...preset,
    // ── the four the preset leaves to the operator, declared for a SIMULATED unit ──
    //
    // A kinematic limit is not implied by a nominal speed, so it is stated rather than
    // copied: a simulated STANDARD unit cruises at 1.5 m/s and is declared capable of 2.0.
    maxSpeedMps: 2.0,
    // NOT a conversion of the owner's 6000 mAh — see the module header. This is the
    // simulator's own declared pack constant for a simulated pack.
    batteryCapacityWh: simulationConstants.PACK_NOMINAL_WH,
    // The simulator's own declared floor (`constants.BATTERY_MIN`), as a percentage.
    batteryReservePct: simulationConstants.BATTERY_MIN,
    // Seeded per unit, not per chassis. A comfortable demonstration state of charge.
    initialBatteryPct: 90,
  };
}

/** Hosts a demonstration world may be seeded onto. */
const LOCAL_HOSTS = Object.freeze(["localhost", "127.0.0.1", "::1"]);

/**
 * Refuse any database that is not a disposable local cluster.
 *
 * @param {string} url
 * @returns {string}
 */
function assertDisposableLocal(url) {
  if (!url) throw new Error("no database URL: pass --database-url or set DATABASE_URL");
  let target;
  try {
    target = new URL(url);
  } catch {
    throw new Error("the database URL could not be parsed; refusing to connect");
  }
  if (!LOCAL_HOSTS.includes(target.hostname)) {
    throw new Error(
      `refusing to seed a demonstration world onto host "${target.hostname}". Only ` +
        `${LOCAL_HOSTS.join(", ")} are permitted — never Neon, never a remote or shared cluster.`,
    );
  }
  if (target.port === "" || target.port === "5432") {
    throw new Error(`port "${target.port || "(default)"}" is the developer's own cluster; use a throwaway one`);
  }
  return url;
}

/**
 * The adopted boundary geometry and the campus reference points.
 *
 * @returns {{ boundary: object, points: object }}
 */
function loadGeometry() {
  const raw = fs.readFileSync(path.join(REPO_ROOT, "rnsit-campus-osm.geojson"));
  const digest = crypto.createHash("sha256").update(raw).digest("hex");
  if (digest !== BOUNDARY_SHA256) {
    throw new Error(`the RNSIT boundary digest is ${digest}, not the adopted ${BOUNDARY_SHA256}`);
  }
  const boundary = JSON.parse(raw).features.find((row) => row.id === BOUNDARY_WAY).geometry;

  const points = {};
  const supplemental = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "rnsit-campus-supplemental.geojson")));
  for (const feature of supplemental.features) {
    const [lon, lat] = feature.geometry.coordinates;
    points[feature.properties.id] = { lat, lon };
  }
  return { boundary, points };
}

/**
 * Seed the world. Idempotent at the level of "a fresh disposable cluster".
 *
 * @param {object} prisma
 * @param {{ shardId: string }} options
 * @returns {Promise<object>} the report
 */
async function seedWorld(prisma, options) {
  const shardId = options.shardId;
  const { boundary, points } = loadGeometry();

  /* ── 1. The operating region and its delivery domain (D1) ──────────────── */
  const declaration = {
    regionId: "rnsit-campus",
    name: "RNSIT Campus",
    kind: "CAMPUS",
    crs: "EPSG:4326",
    version: BOUNDARY_WAY,
    versionDate: "2026-08-30",
    boundary,
  };
  // The domain declaration is validated by the module that owns it; a malformed one is
  // refused here rather than at the first geofence test.
  const domain = deliveryDomain.validateDomainDeclaration(declaration);

  const region = await prisma.region.create({ data: { regionId: "rnsit", name: "RNSIT" } });
  const zone = await prisma.zone.create({
    data: {
      id: "rnsit-z1",
      name: "RNSIT Zone 1",
      regionId: region.id,
      minLat: domain.bbox.minLat,
      maxLat: domain.bbox.maxLat,
      minLon: domain.bbox.minLon,
      maxLon: domain.bbox.maxLon,
    },
  });

  /* ── 2. D6's index cover — boundary-overlapping, so campus ground is 100% covered ── */
  const indexCover = h3.polygonToCellsExperimental(
    boundary.coordinates,
    FINE,
    h3.POLYGON_TO_CELLS_FLAGS.containmentOverlapping,
    true,
  );
  await prisma.cellAssignment.createMany({
    data: indexCover.map((cellId) => ({
      cellId,
      resolution: "FINE",
      regionId: region.id,
      zoneId: zone.id,
      mapVersion: 1,
    })),
  });

  /* ── 3. The published shard that owns the region ───────────────────────── */
  await prisma.shardLeadership.create({ data: { shardId, leadershipFence: 1 } });
  await prisma.shard.create({ data: { shardId, regionId: region.id, state: "ACTIVE" } });

  /* ── 4. The simulated robot, through the REAL commissioning service ────── */
  const start = points["rnsit-innovation-center"];
  const location = await prisma.location.create({
    data: { name: "RNSIT Innovation Center", type: "AREA", lat: start.lat, lon: start.lon },
  });

  // The simulated unit's owner. `Robot.simulationOwnerId` is a real foreign key to `User`
  // (Step 2 — one declared owner per simulated robot), so the owner is a row, not a label.
  const owner = await prisma.user.create({
    data: {
      email: "v1-demonstration-seed@localhost",
      // A disposable local cluster only; this account can authenticate to nothing else.
      password: crypto.randomBytes(24).toString("hex"),
      role: "SUPER_ADMIN",
    },
  });

  const robotCode = "V1DEMO-01";
  const specification = simulatedSpecification();
  const created = await robotService.createRobotWithProjection(
    prisma,
    {
      locationId: location.id,
      lat: start.lat,
      lon: start.lon,
      name: "V1 demonstration robot",
      chassisType: robotSpecification.CHASSIS_TYPE.ROVER,
      specification,
    },
    // A simulated unit, owned by the seeding operator. `Robot.simulated` is the single
    // fact `simulationPolicy.isSimulatedRobot` reads.
    { robotCode, simulated: true, simulationOwnerId: owner.id },
  );

  const robot = await prisma.robot.findUnique({ where: { robotId: robotCode }, include: { agent: true } });
  const agentClass = await prisma.agentClass.findUnique({
    where: { classId: robotSpecification.modelIdsFor(robotCode).classId },
  });

  // The agent is bound to the region and made ACTIVE — the lifecycle state §7.5 F2 requires
  // and the one the availability index files as eligible.
  const agent = await prisma.agent.update({
    where: { id: robot.agent.id },
    data: { regionId: region.id, lifecycleState: "ACTIVE", agentClassId: agentClass.id },
  });

  /* ── 5. Battery state, through the REAL commissioning producer ─────────── */
  // Writes κ = 1 with a zero sample count and leaves every β and `soh` null, deliberately,
  // so that whatever refuses downstream names them. Nothing here fills those in.
  const provisioned = await agentEnergyProvisioning.provisionAgentEnergyState(prisma, {
    agentRowId: agent.id,
    agentClassRowId: agentClass.id,
    initialBatteryPct: specification.initialBatteryPct,
  });

  /* ── 6. The position Observation and the index mirror row (§2.7) ───────── */
  const fineCellId = cells.cellForPoint(start.lat, start.lon, cells.RESOLUTION.FINE);
  const observedAt = new Date();
  await prisma.observation.create({
    data: {
      agentId: agent.id,
      kind: "position",
      observedAt,
      source: observationModel.OBSERVATION_SOURCE.AGENT_REPORT,
      // Provenance travels inside `value` (§2.7) and never on `AgentCellPosition`.
      value: { lat: start.lat, lon: start.lon, provenance: "SIMULATED" },
    },
  });
  await prisma.agentCellPosition.create({
    data: {
      agentId: agent.id,
      shardId,
      lat: start.lat,
      lon: start.lon,
      fineCellId,
      coarseCellId: cells.coarseParentOf(fineCellId),
      availabilityClass: "IDLE_READY",
      capabilityClasses: [],
      containerClasses: [],
      observedAtMs: BigInt(observedAt.getTime()),
    },
  });

  /* ── 7. One depot-class charger, with the cell §20.3 item 3 requires ───── */
  //
  // `coordinatorSolvePath.chargerCandidatesFor` omits and reports any charger with no
  // `cellId`, because a charger that cannot be routed to cannot bound §14.5's `E_return`.
  // The depot sits at the robot's own start point for the demonstration.
  const depot = await prisma.charger.create({
    data: {
      chargerId: "V1DEMO-DEPOT-01",
      regionId: region.id,
      cellId: fineCellId,
      chargerClass: "STANDARD",
      isDepot: true,
      latitude: start.lat,
      longitude: start.lon,
    },
  });

  return { region, zone, shardId, indexCover, declaration, robot, agent, agentClass, provisioned, fineCellId, depot, location, points, specification, created };
}

/**
 * Publish and pin the demonstration configuration — the thirteen, the labelled V9/S2
 * accommodation, the spatial index, the delivery domain, and the region's cutover binding.
 *
 * The thirteen and the accommodation come from `tools/config/publishV1Demonstration.js`
 * rather than being restated, so there is one definition of what a demonstration binds.
 *
 * @param {object} prisma
 * @param {object} world
 * @returns {Promise<object>}
 */
async function publishConfiguration(prisma, world) {
  // Reuse the existing request builder — bindings, note, approvals, and the
  // `assertNoSafetyParameter` refusal all come from it.
  const base = publishTool.publishRequest({ accommodate: true });

  const spatial = {
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

  const published = await configService.publish(prisma, {
    ...base,
    publishedBy: "tools/demo/seedV1Demonstration.js",
    bindings: [
      ...base.bindings,
      // §S-5's cutover act, taken here for a DISPOSABLE cluster only, and recorded in the
      // note. This is not a production cutover decision.
      { level: "region", key: world.region.id, name: "cutover.engine_enabled", value: true },
    ],
    spatial,
    deliveryDomain: world.declaration,
    note:
      base.note +
      " | V1 DEMONSTRATION WORLD (tools/demo/seedV1Demonstration.js): cutover.engine_enabled is bound for " +
      `region ${world.region.id} on a DISPOSABLE local cluster so the request path can be entered; the ` +
      "published spatial index is D6's boundary-overlap cover of the adopted RNSIT boundary and the delivery " +
      "domain is that same adopted declaration. NOT PRODUCTION.",
  });

  await configService.pinVersion(prisma, null, published.version, "tools/demo/seedV1Demonstration.js");
  const pinned = await configService.loadPinnedSnapshot({ prisma });
  if (!pinned || pinned.version !== published.version) {
    throw new Error(`published version ${published.version} but loadPinnedSnapshot returned ${pinned && pinned.version}`);
  }
  return { published, pinned, spatial };
}

module.exports = { assertDisposableLocal, loadGeometry, simulatedSpecification, seedWorld, publishConfiguration };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const flag = (name, fallback) => {
    const at = argv.indexOf(name);
    return at === -1 ? fallback : argv[at + 1];
  };
  const asJson = argv.includes("--json");

  (async () => {
    const url = assertDisposableLocal(flag("--database-url", process.env.DATABASE_URL));
    process.env.DATABASE_URL = url;
    const shardId = flag("--shard-id", process.env.SHARD_ID || "v1demo-shard");

    const { PrismaClient } = require(path.join(BACKEND_ROOT, "node_modules/@prisma/client"));
    const prisma = new PrismaClient({ datasources: { db: { url } } });

    try {
      const world = await seedWorld(prisma, { shardId });
      const configuration = await publishConfiguration(prisma, world);

      const report = {
        regionId: world.region.regionId,
        regionRowId: world.region.id,
        shardId: world.shardId,
        indexCoverCells: world.indexCover.length,
        robotId: world.robot.robotId,
        agentId: world.agent.agentId,
        agentClassId: world.agentClass.classId,
        simulated: world.robot.simulated,
        massKg: world.robot.massKg,
        specification: world.specification,
        fineCellId: world.fineCellId,
        depotChargerId: world.depot.chargerId,
        configVersion: configuration.published.version,
        commissioning: {
          kappa: world.provisioned.batteryState.kappa,
          soc: world.provisioned.batteryState.lastObservedSoc,
          soh: world.provisioned.batteryState.soh,
          betaDist: world.provisioned.energyModelParams.betaDist,
          residualCv: world.provisioned.energyModelParams.residualCv,
        },
      };

      if (asJson) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        process.stdout.write(
          `V1 DEMONSTRATION WORLD seeded\n` +
            `  region        ${report.regionId} (Region.id ${report.regionRowId})\n` +
            `  shard         ${report.shardId}\n` +
            `  index cover   ${report.indexCoverCells} FINE cells (D6 boundary-overlap)\n` +
            `  robot         ${report.robotId}  simulated=${report.simulated}  massKg=${report.massKg}\n` +
            `  agent         ${report.agentId}  class ${report.agentClassId}\n` +
            `  cell          ${report.fineCellId}\n` +
            `  depot charger ${report.depotChargerId}\n` +
            `  config        version ${report.configVersion} (13 PROVISIONAL + labelled V9/S2 + spatial + domain + cutover)\n` +
            `  commissioning kappa=${report.commissioning.kappa} soc=${report.commissioning.soc} ` +
            `soh=${String(report.commissioning.soh)} betaDist=${String(report.commissioning.betaDist)} ` +
            `residualCv=${String(report.commissioning.residualCv)}\n` +
            `  NOT PRODUCTION. Every figure above is a declared DEVELOPMENT SIMULATION value.\n`,
        );
      }
      process.exitCode = 0;
    } catch (error) {
      const findings = (error.findings || []).filter((item) => item.severity === "BLOCKING");
      process.stderr.write(`\nREFUSED — ${error.message}\n`);
      for (const item of findings) process.stderr.write(`  [${item.id}] ${item.rule}\n      ${item.message}\n`);
      if (error.stack && findings.length === 0) process.stderr.write(`${error.stack}\n`);
      process.exitCode = 1;
    } finally {
      await prisma.$disconnect();
    }
  })().catch((error) => {
    process.stderr.write(`\nREFUSED — ${error.message}\n${error.stack || ""}\n`);
    process.exitCode = 1;
  });
}
