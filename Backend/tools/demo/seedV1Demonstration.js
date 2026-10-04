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
 *                                          [--shard-id v1demo-shard] [--fleet single|baseline] [--json]
 *
 * `--fleet baseline` commissions the six-unit V1 acceptance fleet (`BASELINE_FLEET`); the
 * default, `single`, is the one unit this tool has always seeded. Then start the server
 * with `node tools/demo/startV1Server.js --database-url <the same url>`.
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
const membership = require(path.join(BACKEND_ROOT, "src/engine/shard/membership"));
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

/**
 * Refuse any database that is not a disposable local cluster — the shared check in
 * `tools/demo/disposableDatabase.js` (also used by the V1 server launcher).
 */
const { assertDisposableLocal } = require(path.join(BACKEND_ROOT, "tools/demo/disposableDatabase"));

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
  // ── …and the shard membership that goes with an index row (§3.5) ─────────
  //
  // The index maintainer never writes a mirror row without placing the agent in that row's
  // shard; this seed did. At boot the index is rebuilt from the mirror, so this agent was a
  // candidate before the first sweep — and an agent offered work before that sweep is not
  // indexed again (it holds a commitment), so it was never placed while its OFFER was open:
  // its OFFER_ACCEPT and COMMAND_ACK could not resolve a shard, and the OFFER expired
  // (RB-1, measured 2026-10-04). The same `membership.place` the maintainer calls.
  const placed = await membership.place(
    { prisma },
    { agentId: agent.id, shardId, at: observedAt, movedBy: "seedV1Demonstration:initial-placement" },
  );
  if (!placed.ok) throw new Error(`seed could not place ${robotCode} in shard ${shardId}: ${placed.refusal}`);

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
 * Publish and pin the demonstration configuration — the thirteen, the V1 execution
 * parameters, the labelled V9/S2 accommodation, the spatial index, the delivery domain,
 * and the region's cutover binding.
 *
 * The thirteen and the accommodation come from `tools/config/publishV1Demonstration.js`,
 * and the execution parameters from `tools/config/v1DemonstrationConfig.executionBindings()`,
 * rather than being restated, so there is one definition of what a demonstration binds.
 * `tools/demo/runV1Assignment.js` publishes through this same function, so the proof run
 * and a seeded `server.js` world run on the same configuration.
 *
 * ── Why the execution parameters are not optional ──────────────────────────
 * Without them `candidate.max_radius_by_sla_class` is unbound (register default null) and
 * `solve.time_budget` is its 250 ms default, so candidate expansion is bounded only by
 * that clock and finds no agent: measured on a real `server.js` against this world, every
 * round recorded `agentCount 0, BUDGET_LIMITED` with six healthy robots within 300 m, and
 * nothing was logged (engine enablement audit, 2026-09-27).
 *
 * @param {object} prisma
 * @param {object} world
 * @param {{ publishedBy?: string, note?: string }} [options] who publishes, and the
 *   caller's own line for the version note
 * @returns {Promise<object>}
 */
async function publishConfiguration(prisma, world, options = {}) {
  const publishedBy = options.publishedBy || "tools/demo/seedV1Demonstration.js";
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
    publishedBy,
    bindings: [
      ...base.bindings,
      // The V1 execution parameters (search radius, solve budget, horizons, SLA window,
      // intervention bound) — see the header for what happens without them.
      ...demonstration.executionBindings(),
      // §S-5's cutover act, taken here for a DISPOSABLE cluster only, and recorded in the
      // note. This is not a production cutover decision.
      { level: "region", key: world.region.id, name: "cutover.engine_enabled", value: true },
    ],
    spatial,
    deliveryDomain: world.declaration,
    note:
      base.note +
      ` | V1 DEMONSTRATION WORLD (${publishedBy}): the V1 execution parameters are bound, and ` +
      `cutover.engine_enabled is bound for region ${world.region.id} on a DISPOSABLE local cluster so the ` +
      "request path can be entered; the published spatial index is D6's boundary-overlap cover of the adopted " +
      "RNSIT boundary and the delivery domain is that same adopted declaration. NOT PRODUCTION." +
      (options.note ? ` | ${options.note}` : ""),
  });

  await configService.pinVersion(prisma, null, published.version, publishedBy);
  const pinned = await configService.loadPinnedSnapshot({ prisma });
  if (!pinned || pinned.version !== published.version) {
    throw new Error(`published version ${published.version} but loadPinnedSnapshot returned ${pinned && pinned.version}`);
  }
  return { published, pinned, spatial };
}

/**
 * The demonstration fleets, by name. Each entry is a simulated unit's code, the named
 * RNSIT point it starts at, and its starting charge — fixtures, not policy: which unit is
 * chosen for a task is the engine's decision, never this list's.
 *
 * `baseline` is the first proven run's fleet (`runV1Assignment.js --scenario baseline`,
 * and the V1 acceptance test): four healthy units and two the engine must refuse by its
 * own checks. `expect` records that for the runner's expectations; the seed ignores it.
 */
const BASELINE_FLEET = Object.freeze([
  { code: "V1DEMO-01", point: "rnsit-innovation-center", batteryPct: 90 },
  { code: "V1DEMO-02", point: "rnsit-pre-university-college", batteryPct: 85 },
  { code: "V1DEMO-03", point: "rnsit-canara-bank", batteryPct: 80 },
  { code: "V1DEMO-04", point: "rns-evening-college", batteryPct: 75 },
  // In a boundary cell whose centre lies outside the adopted RNSIT boundary: the router
  // refuses to route from it, so this robot is a genuine rejection.
  { code: "V1DEMO-05", point: "rnsit-main-gate", batteryPct: 85, expect: "NEVER_ASSIGNED" },
  // Low charge: the energy feasibility check has to do the rejecting.
  { code: "V1DEMO-06", point: "rnsit-cyber-security-department", batteryPct: 12, expect: "NEVER_ASSIGNED" },
].map((entry) => Object.freeze(entry)));

const FLEETS = Object.freeze({
  /** The one unit `seedWorld` commissions. */
  single: Object.freeze([BASELINE_FLEET[0]]),
  baseline: BASELINE_FLEET,
});

/**
 * Commission every unit of `fleet` through the real commissioning service, at fixed codes.
 * The unit `seedWorld` already commissioned is skipped; if the fleet gives it a different
 * starting charge, that charge is applied to its battery state and its row.
 *
 * @param {object} prisma
 * @param {object} world `seedWorld`'s result
 * @param {Array<{ code: string, point: string, batteryPct: number }>} fleet
 * @param {string} ownerId the simulated units' owner (`User.id`)
 */
async function commissionFleet(prisma, world, fleet, ownerId) {
  for (const entry of fleet) {
    if (entry.code === world.robot.robotId) continue; // seeded by seedWorld
    const point = world.points[entry.point];
    if (!point) throw new Error(`fleet entry ${entry.code} names unknown point "${entry.point}"`);
    // eslint-disable-next-line no-await-in-loop
    await robotService.createRobotWithProjection(
      prisma,
      {
        name: `V1 demo @ ${entry.point}`,
        locationId: world.location.id,
        lat: point.lat,
        lon: point.lon,
        chassisType: "ROVER",
        specification: { ...simulatedSpecification(), initialBatteryPct: entry.batteryPct },
      },
      { robotCode: entry.code, simulated: true, simulationOwnerId: ownerId },
    );
  }
  // The seeded robot's pack, when the fleet states a different starting charge.
  const seeded = fleet.find((entry) => entry.code === world.robot.robotId);
  if (seeded && seeded.batteryPct !== 90) {
    await prisma.batteryState.updateMany({ where: { agentId: world.agent.id }, data: { lastObservedSoc: seeded.batteryPct / 100 } });
    await prisma.robot.update({ where: { robotId: seeded.code }, data: { battery: seeded.batteryPct } });
  }
}

module.exports = {
  assertDisposableLocal,
  loadGeometry,
  simulatedSpecification,
  seedWorld,
  publishConfiguration,
  BASELINE_FLEET,
  FLEETS,
  commissionFleet,
};

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
    const fleetName = flag("--fleet", "single");
    const fleet = Object.prototype.hasOwnProperty.call(FLEETS, fleetName) ? FLEETS[fleetName] : null;
    if (!fleet) throw new Error(`unknown --fleet "${fleetName}"; one of: ${Object.keys(FLEETS).join(", ")}`);

    const { PrismaClient } = require(path.join(BACKEND_ROOT, "node_modules/@prisma/client"));
    const prisma = new PrismaClient({ datasources: { db: { url } } });

    try {
      const world = await seedWorld(prisma, { shardId });
      const configuration = await publishConfiguration(prisma, world);
      const owner = await prisma.user.findFirst({ where: { email: "v1-demonstration-seed@localhost" } });
      await commissionFleet(prisma, world, fleet, owner.id);
      const robots = await prisma.robot.findMany({
        where: { robotId: { in: fleet.map((entry) => entry.code) } },
        select: { robotId: true, simulated: true, battery: true },
        orderBy: { robotId: "asc" },
      });

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
        fleet: fleetName,
        robots,
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
            `  config        version ${report.configVersion} (13 PROVISIONAL + execution params + labelled V9/S2 + spatial + domain + cutover)\n` +
            `  fleet         ${report.fleet}: ${report.robots.map((row) => `${row.robotId}(${row.battery}%)`).join(" ")}\n` +
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
