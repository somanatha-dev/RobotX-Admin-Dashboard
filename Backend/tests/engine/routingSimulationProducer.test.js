"use strict";

/**
 * Engine lane — the **DEVELOPMENT_SIMULATION routing producer**
 * (`src/simulation/simulationRouter.js`).
 *
 * ── What these tests establish ────────────────────────────────────────────
 *   * that the producer answers the `route(parts)` contract
 *     `workers/coordinatorPipeline.js` states verbatim, with six finite non-negative
 *     fields `routing/cellPairCache.buildEntry` accepts;
 *   * that its distance is the **simulator's own geometry** and its travel time the
 *     **owner's declared V1 model**, both re-derived here rather than transcribed;
 *   * that every field it emits carries `DEVELOPMENT_SIMULATION` provenance and that no
 *     `PRODUCTION_*` label appears anywhere in its output;
 *   * that it **cannot be constructed or used** in a process that is not running the
 *     simulator, for an agent that is not `Robot.simulated === true`, or for an endpoint
 *     outside the declared serviceable boundary;
 *   * that it **cannot be mistaken for a B1 adapter or a production router**;
 *   * that `routing/productionRouter.js`'s own refusals are untouched by its existence.
 *
 * ── What they do NOT establish ────────────────────────────────────────────
 * Nothing here is evidence about a physical robot, a real campus, real terrain, a real
 * travel time or a real routing engine. The producer's own header says its terrain is a
 * measurement of the simulator and its stop-start count is a floor; these tests assert
 * that those are what it emits, never that they describe the world. They do not discharge
 * B1, D1, D3 or D8, and they do not close the physical terrain or stop-start gaps —
 * `routing/productionRouter.js` still refuses without a declared source and is asserted
 * to still do so below.
 */

const fs = require("fs");
const path = require("path");

const cells = require("../../src/engine/spatial/cells");
const regionBoundary = require("../../src/engine/spatial/regionBoundary");
const configService = require("../../src/engine/config/service");
const cellPairCache = require("../../src/engine/routing/cellPairCache");
const travelModel = require("../../src/engine/routing/campusTravelModel");
const serviceability = require("../../src/engine/routing/campusServiceability");
const cellProjection = require("../../src/engine/routing/cellProjection");
const productionRouter = require("../../src/engine/routing/productionRouter");
const coordinatorPipeline = require("../../src/workers/coordinatorPipeline");
const adapterRoster = require("../../tools/routing/adapters/index");
const adapterContract = require("../../tools/routing/adapters/contract");
const { haversineMeters } = require("../../src/utils/distance");
const simulationConstants = require("../../src/simulation/constants");
const simulationPolicy = require("../../src/simulation/simulationPolicy");

const simulationRouter = require("../../src/simulation/simulationRouter");

const { FIELD_PROVENANCE, ROUTER_MODE, ROUTE_REFUSAL, RouteRefusedError } = productionRouter;
const { SIMULATION_REFUSAL } = simulationRouter;

/* ═══════════════════════════════════════════════════════════════════════════
   Fixtures
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * A synthetic region large enough that its own fine-cell centres fall inside it, so the
 * seam can be exercised end to end. The same fixture `routingProductionSeam.test.js` uses,
 * and for the same reason: it is **not** RNSIT and is never described as RNSIT.
 */
const SQUARE_REGION = Object.freeze({
  regionId: "test-square",
  name: "Test Square Region",
  kind: regionBoundary.REGION_KIND.CAMPUS,
  crs: "OGC:CRS84",
  version: "test-v1",
  versionDate: "2026-09-21",
  boundary: {
    type: "Polygon",
    coordinates: [
      [
        [77.40, 12.80],
        [77.60, 12.80],
        [77.60, 13.00],
        [77.40, 13.00],
        [77.40, 12.80],
      ],
    ],
  },
});

/** The adopted RNSIT serviceable boundary, read from the tree rather than transcribed. */
function rnsitDeclaration() {
  const file = path.resolve(__dirname, "..", "..", "..", "rnsit-campus-osm.geojson");
  const collection = JSON.parse(fs.readFileSync(file, "utf8"));
  const feature = collection.features.find((entry) => entry.id === "way/1120154292");
  return {
    regionId: "rnsit-bengaluru",
    name: "RNSIT Bengaluru Campus",
    kind: regionBoundary.REGION_KIND.CAMPUS,
    crs: "OGC:CRS84",
    version: "rnsit-boundary-v1",
    versionDate: "2026-08-30",
    boundary: feature.geometry,
  };
}

const SNAPSHOT = configService.defaultSnapshot();
const MODEL = travelModel.resolveModelParameters(SNAPSHOT, {});

/** A process that is running the simulator, injected rather than set on `process.env`. */
const SIMULATED_ENV = Object.freeze({ [simulationPolicy.SIMULATOR_ENV_VAR]: "true" });

/** One simulated unit and one physical one, in `Robot` row shape. */
const SIMULATED_ROBOT = Object.freeze({ robotId: "sim-demo-1", simulated: true });
const PHYSICAL_ROBOT = Object.freeze({ robotId: "phys-1", simulated: false });
/** A row read with a `select` that omitted the column — "not established", which is physical. */
const UNSTATED_ROBOT = Object.freeze({ robotId: "unknown-1" });

/** Two cells inside `SQUARE_REGION`, and one far outside it. */
const ORIGIN_CELL = cells.cellForPoint(12.90, 77.50, cells.RESOLUTION.FINE);
const DEST_CELL = cells.cellForPoint(12.92, 77.52, cells.RESOLUTION.FINE);
const OFF_CAMPUS_CELL = cells.cellForPoint(10.00, 70.00, cells.RESOLUTION.FINE);
const PROFILE = "MOB-TEST:SIDEWALK_GRAPH:unloaded";
/** @structural an arbitrary in-range hour-of-week, Sunday 00:00 = 0 */
const BUCKET = 37;

const REQUEST = Object.freeze({
  originCell: ORIGIN_CELL,
  destCell: DEST_CELL,
  profileKey: PROFILE,
  timeBucket: BUCKET,
});

/**
 * Build a composable simulation router. `overrides` removes or corrupts one input at a
 * time, which is how every refusal below is provoked without rebuilding the composition.
 */
function build(overrides) {
  const settings = overrides || {};
  const oracle = serviceability.createServiceabilityOracle(
    settings.region === undefined ? SQUARE_REGION : settings.region,
  );
  const projection = cellProjection.createCellProjection({ serviceability: oracle });

  const config = {
    projection: settings.projection === undefined ? projection : settings.projection,
    travelModel: settings.travelModel === undefined ? MODEL : settings.travelModel,
    agents: settings.agents === undefined ? [SIMULATED_ROBOT] : settings.agents,
    mode: settings.mode === undefined ? ROUTER_MODE.DEVELOPMENT : settings.mode,
    env: settings.env === undefined ? SIMULATED_ENV : settings.env,
  };
  if (settings.speedFor !== undefined) config.speedFor = settings.speedFor;
  if (settings.speedProvenance !== undefined) config.speedProvenance = settings.speedProvenance;

  return { oracle, projection, config, router: simulationRouter.createSimulationRouter(config) };
}

/** Run a function and return the thrown `RouteRefusedError`, failing if it does not throw. */
function refusalFrom(run) {
  try {
    const answer = run();
    if (answer && typeof answer.then === "function") {
      return answer.then(
        () => {
          throw new Error("expected a refusal, and the call resolved");
        },
        (error) => error,
      );
    }
  } catch (error) {
    return error;
  }
  throw new Error("expected a refusal, and the call returned");
}

/* ═══════════════════════════════════════════════════════════════════════════
   S1 — a valid simulated route, and the route contract
   ═══════════════════════════════════════════════════════════════════════════ */

describe("S1 — a valid simulated route satisfies the six-field route contract", () => {
  test("every required field is present, finite and non-negative", async () => {
    const { router } = build();
    const route = await router.route(REQUEST);

    for (const field of [
      "distanceM",
      "travelSeconds",
      "travelSdSeconds",
      "climbM",
      "descentM",
      "stopStartCycles",
    ]) {
      expect(typeof route[field]).toBe("number");
      expect(Number.isFinite(route[field])).toBe(true);
      expect(route[field]).toBeGreaterThanOrEqual(0);
    }
  });

  test("`cellPairCache.buildEntry` accepts the result — the contract is the cache's, not this test's", async () => {
    const { router } = build();
    const route = await router.route(REQUEST);

    const entry = cellPairCache.buildEntry({ ...route, profileKey: PROFILE, timeBucket: BUCKET });
    expect(entry.missing).toEqual([]);
    expect(entry.ok).toBe(true);
    // The terrain three are *carried* by `buildEntry` and required at the decision path,
    // so a route that omitted them would cache and then fail one seam later.
    for (const field of cellPairCache.TERRAIN_FIELDS) expect(entry.entry[field]).not.toBeNull();
  });

  test("the seam works through `cellPairCache.read`, which is the only caller that matters", async () => {
    const { router } = build();
    const store = new Map();
    const kv = {
      get: async (key) => (store.has(key) ? store.get(key) : null),
      set: async (key, value) => store.set(key, value),
    };
    const counters = new cellPairCache.Counters();

    const miss = await cellPairCache.read(
      { kv, route: (parts) => router.route(parts), counters },
      REQUEST,
      { ttlSeconds: 60, intraCellOffsetM: 250, speedMetresPerSecond: simulationRouter.SIMULATED_NOMINAL_SPEED_MS },
    );
    expect(miss.ok).toBe(true);
    expect(miss.hit).toBe(false);

    const hit = await cellPairCache.read(
      { kv, route: (parts) => router.route(parts), counters },
      REQUEST,
      { ttlSeconds: 60, intraCellOffsetM: 250, speedMetresPerSecond: simulationRouter.SIMULATED_NOMINAL_SPEED_MS },
    );
    expect(hit.ok).toBe(true);
    expect(hit.hit).toBe(true);
    expect(counters.report(0.95).hits).toBe(1);
  });

  test("distanceM is the simulator's own haversine geometry between the projected cells", async () => {
    const { router, projection } = build();
    const route = await router.route(REQUEST);

    const origin = projection.project(ORIGIN_CELL);
    const destination = projection.project(DEST_CELL);
    // Re-derived with the same function `VirtualRobot._stepAlongPath` advances on. Not a
    // transcribed constant: a copied number would still pass if the producer switched to a
    // different geometry.
    expect(route.distanceM).toBe(haversineMeters(origin.lat, origin.lon, destination.lat, destination.lon));
    expect(route.endpoints.origin.cellId).toBe(ORIGIN_CELL);
    expect(route.endpoints.destination.cellId).toBe(DEST_CELL);
  });

  test("travelSeconds and travelSdSeconds are the owner's declared V1 campus model, unmodified", async () => {
    const { router } = build();
    const route = await router.route(REQUEST);

    const expected = travelModel.travelTimeFor({
      distanceM: route.distanceM,
      speedMetresPerSecond: simulationRouter.SIMULATED_NOMINAL_SPEED_MS,
      bufferSecondsPer100m: MODEL.bufferSecondsPer100m,
      sdBufferMultiple: MODEL.sdBufferMultiple,
    });
    expect(expected.ok).toBe(true);
    expect(route.travelSeconds).toBe(expected.travelSeconds);
    expect(route.travelSdSeconds).toBe(expected.travelSdSeconds);
    // The engine's own duration is not a thing this producer has; the flag is asserted so a
    // future change that started using one is visible.
    expect(route.terms.engineDurationUsed).toBe(false);
  });

  test("the declared V1 simulation terrain and stop-start assumptions are what is emitted", async () => {
    const { router } = build();
    const route = await router.route(REQUEST);

    expect(route.climbM).toBe(simulationRouter.SIMULATED_CLIMB_M);
    expect(route.descentM).toBe(simulationRouter.SIMULATED_DESCENT_M);
    expect(route.stopStartCycles).toBe(simulationRouter.SIMULATED_STOP_START_CYCLES);

    // The basis travels with the numbers. Each says, in the result itself, that it is
    // simulation output — so a reader of an audit record never has to come back here.
    expect(route.basis.terrain).toContain("DEVELOPMENT_SIMULATION");
    expect(route.basis.terrain).toContain("NOT a claim that the RNSIT campus is");
    expect(route.basis.stopStartCycles).toContain("FLOOR");
    expect(route.basis.distanceM).toContain("LOWER BOUND");
  });

  test("the speed is the simulator's own declared nominal speed, not a fleet measurement", async () => {
    expect(simulationRouter.SIMULATED_NOMINAL_SPEED_MS).toBe(simulationConstants.SPEED_BASE_MS);

    const { router } = build({ speedFor: () => 2 });
    const route = await router.route(REQUEST);
    expect(route.terms.speedMetresPerSecond).toBe(2);
  });

  test("determinism — the same request answers identically on repeated calls", async () => {
    const { router } = build();
    const first = await router.route(REQUEST);
    const second = await router.route(REQUEST);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   S2 — provenance: DEVELOPMENT_SIMULATION, explicitly, everywhere
   ═══════════════════════════════════════════════════════════════════════════ */

describe("S2 — every produced field carries explicit DEVELOPMENT_SIMULATION provenance", () => {
  test("each of the six fields is labelled DEVELOPMENT_SIMULATION", async () => {
    const { router } = build();
    const route = await router.route(REQUEST);

    for (const field of [
      "distanceM",
      "travelSeconds",
      "travelSdSeconds",
      "climbM",
      "descentM",
      "stopStartCycles",
      "speedMetresPerSecond",
    ]) {
      expect(route.provenance[field]).toBe(FIELD_PROVENANCE.DEVELOPMENT_SIMULATION);
    }
    expect(route.provenance.mode).toBe(ROUTER_MODE.DEVELOPMENT);
    expect(router.provenance).toBe(FIELD_PROVENANCE.DEVELOPMENT_SIMULATION);
  });

  test("no PRODUCTION_EXTERNAL or PRODUCTION_DECLARED label appears anywhere in the result", async () => {
    const { router } = build();
    const route = await router.route(REQUEST);

    const serialised = JSON.stringify(route);
    expect(serialised).not.toContain(FIELD_PROVENANCE.PRODUCTION_EXTERNAL);
    expect(serialised).not.toContain(FIELD_PROVENANCE.PRODUCTION_DECLARED);
  });

  test("the spread source names the production declaration it reuses AND says it is simulated", async () => {
    const { router } = build();
    const route = await router.route(REQUEST);

    // Both halves. A bare `DECLARED_V1_OPERATIONAL_UNCERTAINTY` would read as the
    // production declaration; a name with no reference to it would hide that the
    // arithmetic is the owner's.
    expect(route.provenance.travelSdSource).toBe(simulationRouter.SIMULATED_SPREAD_SOURCE);
    expect(simulationRouter.SIMULATED_SPREAD_SOURCE).toContain(FIELD_PROVENANCE.DEVELOPMENT_SIMULATION);
    expect(simulationRouter.SIMULATED_SPREAD_SOURCE).toContain(travelModel.DECLARED_SPREAD_SOURCE);
    expect(simulationRouter.SIMULATED_SPREAD_SOURCE).not.toBe(travelModel.DECLARED_SPREAD_SOURCE);
  });

  test("every field maps onto the SIMULATED half of §2.7's evidence axis", async () => {
    const { router } = build();
    const route = await router.route(REQUEST);

    for (const axis of Object.values(route.provenance.evidenceAxis)) expect(axis).toBe("SIMULATED");
  });

  test("describe() states what this is before anything a reader could mistake it for", () => {
    const { router } = build();
    const described = router.describe();
    expect(described).toContain("DEVELOPMENT_SIMULATION");
    expect(described).toContain("NOT a production router");
    expect(described).toContain("NOT a B1 adapter");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   S3 — a non-simulated deployment is refused
   ═══════════════════════════════════════════════════════════════════════════ */

describe("S3 — the producer cannot be constructed or used in a non-simulated deployment", () => {
  test("construction refuses when the simulator is not enabled for the process", () => {
    const error = refusalFrom(() => build({ env: {} }));
    expect(error).toBeInstanceOf(RouteRefusedError);
    expect(error.refusal).toBe(SIMULATION_REFUSAL.NOT_A_SIMULATED_DEPLOYMENT);
    expect(error.message).toContain(simulationPolicy.SIMULATOR_ENV_VAR);
  });

  test("the legacy kill switch wins over the enable flag, as `simulationPolicy` declares", () => {
    const error = refusalFrom(() =>
      build({
        env: {
          [simulationPolicy.SIMULATOR_ENV_VAR]: "true",
          [simulationPolicy.LEGACY_DISABLE_ENV_VAR]: "true",
        },
      }),
    );
    expect(error.refusal).toBe(SIMULATION_REFUSAL.NOT_A_SIMULATED_DEPLOYMENT);
  });

  test("anything but the exact string `true` is not a simulated deployment", () => {
    for (const value of ["1", "yes", "TRUE ", "", "false", undefined]) {
      const env = value === undefined ? {} : { [simulationPolicy.SIMULATOR_ENV_VAR]: value };
      // `"TRUE "` trims and lower-cases to `true` in `simulationPolicy`, deliberately; the
      // rest must all refuse.
      if (String(value).trim().toLowerCase() === "true") continue;
      expect(refusalFrom(() => build({ env })).refusal).toBe(SIMULATION_REFUSAL.NOT_A_SIMULATED_DEPLOYMENT);
    }
  });

  test("with no injected env the default test process — which sets no simulator flag — refuses", () => {
    expect(process.env[simulationPolicy.SIMULATOR_ENV_VAR]).toBeUndefined();
    const oracle = serviceability.createServiceabilityOracle(SQUARE_REGION);
    const error = refusalFrom(() =>
      simulationRouter.createSimulationRouter({
        projection: cellProjection.createCellProjection({ serviceability: oracle }),
        travelModel: MODEL,
        agents: [SIMULATED_ROBOT],
        mode: ROUTER_MODE.DEVELOPMENT,
      }),
    );
    expect(error.refusal).toBe(SIMULATION_REFUSAL.NOT_A_SIMULATED_DEPLOYMENT);
  });

  test("the deployment is re-read on every route, so turning the simulator off stops a warm router", async () => {
    const env = { [simulationPolicy.SIMULATOR_ENV_VAR]: "true" };
    const { router } = build({ env });
    await expect(router.route(REQUEST)).resolves.toBeDefined();

    env[simulationPolicy.SIMULATOR_ENV_VAR] = "false";
    const error = await refusalFrom(() => router.route(REQUEST));
    expect(error.refusal).toBe(SIMULATION_REFUSAL.NOT_A_SIMULATED_DEPLOYMENT);
  });

  test("the mode must be stated explicitly — there is no default", () => {
    // Omitted entirely, through the real constructor rather than through this file's
    // helper, which supplies one.
    const oracle = serviceability.createServiceabilityOracle(SQUARE_REGION);
    const omitted = refusalFrom(() =>
      simulationRouter.createSimulationRouter({
        projection: cellProjection.createCellProjection({ serviceability: oracle }),
        travelModel: MODEL,
        agents: [SIMULATED_ROBOT],
        env: SIMULATED_ENV,
      }),
    );
    expect(omitted.refusal).toBe(ROUTE_REFUSAL.MALFORMED_REQUEST);
    expect(omitted.message).toContain("mode must be stated explicitly");

    for (const mode of [ROUTER_MODE.PRODUCTION, null, "", "development"]) {
      const error = refusalFrom(() => build({ mode }));
      expect(error.refusal).toBe(ROUTE_REFUSAL.MALFORMED_REQUEST);
      expect(error.message).toContain("mode must be stated explicitly");
    }
  });

  test("a production provenance label cannot be attached to this producer's output", () => {
    for (const claimed of [FIELD_PROVENANCE.PRODUCTION_EXTERNAL, FIELD_PROVENANCE.PRODUCTION_DECLARED]) {
      const error = refusalFrom(() => build({ speedProvenance: claimed }));
      expect(error.refusal).toBe(ROUTE_REFUSAL.MALFORMED_REQUEST);
      expect(error.message).toContain("speedProvenance");
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   S4 — a non-simulated robot cannot use the producer
   ═══════════════════════════════════════════════════════════════════════════ */

describe("S4 — only `Robot.simulated === true` agents may be served", () => {
  test("a physical unit in the roster refuses the whole composition", () => {
    const error = refusalFrom(() => build({ agents: [SIMULATED_ROBOT, PHYSICAL_ROBOT] }));
    expect(error.refusal).toBe(SIMULATION_REFUSAL.NOT_A_SIMULATED_AGENT);
    expect(error.message).toContain(PHYSICAL_ROBOT.robotId);
  });

  test("an unstated `simulated` column is physical, never a pass", () => {
    const error = refusalFrom(() => build({ agents: [UNSTATED_ROBOT] }));
    expect(error.refusal).toBe(SIMULATION_REFUSAL.NOT_A_SIMULATED_AGENT);
  });

  test("truthiness is not enough — the predicate is `simulationPolicy.isSimulatedRobot`", () => {
    for (const value of ["true", 1, {}, "false"]) {
      const error = refusalFrom(() => build({ agents: [{ robotId: "coerced", simulated: value }] }));
      expect(error.refusal).toBe(SIMULATION_REFUSAL.NOT_A_SIMULATED_AGENT);
    }
    expect(simulationPolicy.isSimulatedRobot(PHYSICAL_ROBOT)).toBe(false);
  });

  test("an empty roster is refused — the check must have something to check", () => {
    const error = refusalFrom(() => build({ agents: [] }));
    expect(error.refusal).toBe(ROUTE_REFUSAL.MALFORMED_REQUEST);
    expect(error.message).toContain("agents is required");
  });

  test("`assertAgent` refuses a physical row handed to a composed router", () => {
    const { router } = build();
    expect(router.agents).toEqual([SIMULATED_ROBOT.robotId]);
    expect(() => router.assertAgent(SIMULATED_ROBOT)).not.toThrow();
    const error = refusalFrom(() => router.assertAgent(PHYSICAL_ROBOT));
    expect(error.refusal).toBe(SIMULATION_REFUSAL.NOT_A_SIMULATED_AGENT);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   S5 — endpoints outside the declared serviceable boundary are refused
   ═══════════════════════════════════════════════════════════════════════════ */

describe("S5 — an endpoint outside the declared serviceable campus boundary is refused", () => {
  test("an off-campus destination is refused, not routed", async () => {
    const { router } = build();
    const error = await refusalFrom(() => router.route({ ...REQUEST, destCell: OFF_CAMPUS_CELL }));
    expect(error.refusal).toBe(ROUTE_REFUSAL.OUTSIDE_SERVICEABLE_REGION);
  });

  test("an off-campus origin is refused too — both ends are checked", async () => {
    const { router } = build();
    const error = await refusalFrom(() => router.route({ ...REQUEST, originCell: OFF_CAMPUS_CELL }));
    expect(error.refusal).toBe(ROUTE_REFUSAL.OUTSIDE_SERVICEABLE_REGION);
  });

  test("with no boundary configured, nothing can be shown to be inside one — unknown is DENY", async () => {
    const { router } = build({ region: null });
    const error = await refusalFrom(() => router.route(REQUEST));
    expect(error.refusal).toBe(ROUTE_REFUSAL.MALFORMED_REQUEST);
    expect(error.detail.refusal).toBe(cellProjection.PROJECTION_REFUSAL.NO_REGION);
  });

  test("the boundary instrument is the shared one — the adopted RNSIT polygon refuses a cell off it", async () => {
    const { router } = build({ region: rnsitDeclaration() });
    // A point two degrees away is unambiguously off any campus, at any resolution, so this
    // asserts the refusal rather than re-measuring the RNSIT cover (which is
    // `spatialRnsitCover.test.js`'s job).
    const error = await refusalFrom(() => router.route({ ...REQUEST, originCell: OFF_CAMPUS_CELL }));
    expect(error.refusal).toBe(ROUTE_REFUSAL.OUTSIDE_SERVICEABLE_REGION);
  });

  test("a malformed request is refused by the shared `normaliseRouteRequest`, not a second copy", async () => {
    const { router } = build();
    const error = await refusalFrom(() => router.route({ ...REQUEST, timeBucket: Date.now() }));
    expect(error.refusal).toBe(ROUTE_REFUSAL.MALFORMED_REQUEST);
    expect(error.message).toContain("timeBucket");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   S6 — it cannot be registered as a productionRouter / B1 adapter
   ═══════════════════════════════════════════════════════════════════════════ */

describe("S6 — the producer cannot be mistaken for a B1 adapter or a production router", () => {
  test("it exposes no matrix(), which is what the roster decides availability on", () => {
    const { router } = build();
    expect(router.matrix).toBeUndefined();

    const availability = adapterRoster.availabilityOf(router);
    expect(availability.status).toBe(adapterContract.AVAILABILITY.NOT_DEPLOYED);
    expect(availability.measurable).toBeUndefined();
  });

  test("it is absent from the B1 candidate roster, by id and by listing", () => {
    expect(adapterRoster.byId("simulation")).toBeNull();
    expect(adapterRoster.byId("simulationRouter")).toBeNull();
    for (const id of adapterRoster.CANDIDATE_IDS) expect(id.toLowerCase()).not.toContain("sim");
    for (const row of adapterRoster.roster()) expect(row.id.toLowerCase()).not.toContain("sim");
  });

  test("`createProductionRouter` refuses it as an adapter", () => {
    const { router, projection } = build();
    const error = refusalFrom(() =>
      productionRouter.createProductionRouter({
        adapter: router,
        projection,
        travelModel: MODEL,
        speedFor: () => 1.5,
        speedProvenance: FIELD_PROVENANCE.PRODUCTION_DECLARED,
      }),
    );
    expect(error.refusal).toBe(ROUTE_REFUSAL.MALFORMED_REQUEST);
    expect(error.message).toContain("adapter is required and must expose matrix(request)");
  });

  test("the module exports no adapter surface at all — no id, no create, no availability", () => {
    expect(simulationRouter.id).toBeUndefined();
    expect(simulationRouter.create).toBeUndefined();
    expect(simulationRouter.availability).toBeUndefined();
    expect(simulationRouter.matrix).toBeUndefined();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   S7 — the production routing refusals are untouched
   ═══════════════════════════════════════════════════════════════════════════ */

describe("S7 — `routing/productionRouter.js`'s refusals are unchanged by this producer's existence", () => {
  test("a PRODUCTION-mode router still refuses a DEVELOPMENT_SIMULATION speed at composition", () => {
    const oracle = serviceability.createServiceabilityOracle(SQUARE_REGION);
    const projection = cellProjection.createCellProjection({ serviceability: oracle });
    const error = refusalFrom(() =>
      productionRouter.createProductionRouter({
        adapter: { matrix: async () => [{ status: "OK", distanceM: 10 }] },
        projection,
        travelModel: MODEL,
        speedFor: () => 1.5,
        speedProvenance: FIELD_PROVENANCE.DEVELOPMENT_SIMULATION,
      }),
    );
    expect(error.refusal).toBe(ROUTE_REFUSAL.MALFORMED_REQUEST);
    expect(error.message).toContain("speedProvenance is DEVELOPMENT_SIMULATION and mode is PRODUCTION");
  });

  test("a PRODUCTION-mode router still refuses a simulated terrain value at route time", async () => {
    const oracle = serviceability.createServiceabilityOracle(SQUARE_REGION);
    const projection = cellProjection.createCellProjection({ serviceability: oracle });
    const router = productionRouter.createProductionRouter({
      adapter: { matrix: async () => [{ status: "OK", distanceM: 1200 }] },
      projection,
      travelModel: MODEL,
      speedFor: () => 1.5,
      speedProvenance: FIELD_PROVENANCE.PRODUCTION_DECLARED,
      terrainSource: async () => ({
        climbM: simulationRouter.SIMULATED_CLIMB_M,
        descentM: simulationRouter.SIMULATED_DESCENT_M,
        provenance: FIELD_PROVENANCE.DEVELOPMENT_SIMULATION,
      }),
      stopStartSource: async () => ({
        stopStartCycles: simulationRouter.SIMULATED_STOP_START_CYCLES,
        provenance: FIELD_PROVENANCE.DEVELOPMENT_SIMULATION,
      }),
    });

    const error = await refusalFrom(() => router.route(REQUEST));
    expect(error.refusal).toBe(ROUTE_REFUSAL.SIMULATION_IN_PRODUCTION);
  });

  test("a PRODUCTION-mode router with no terrain source still refuses — the physical gap is not closed", async () => {
    const oracle = serviceability.createServiceabilityOracle(SQUARE_REGION);
    const projection = cellProjection.createCellProjection({ serviceability: oracle });
    const router = productionRouter.createProductionRouter({
      adapter: { matrix: async () => [{ status: "OK", distanceM: 1200 }] },
      projection,
      travelModel: MODEL,
      speedFor: () => 1.5,
      speedProvenance: FIELD_PROVENANCE.PRODUCTION_DECLARED,
    });

    const error = await refusalFrom(() => router.route(REQUEST));
    expect(error.refusal).toBe(ROUTE_REFUSAL.NO_TERRAIN_SOURCE);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   S8 — the wiring: exactly four composition requirements, and no more
   ═══════════════════════════════════════════════════════════════════════════ */

describe("S8 — `demonstrationRoutingSeam` satisfies exactly the routing requirements it names", () => {
  /** The requirement ids the seam claims, and nothing else. */
  const CLAIMED = Object.freeze([
    "route",
    "travelSdSeconds source (N29)",
    "speedMetresPerSecond (per routing profile)",
    "hop terrain (climbM / descentM / stopStartCycles)",
  ]);

  test("the four it claims become satisfied, and no other requirement moves", () => {
    const oracle = serviceability.createServiceabilityOracle(SQUARE_REGION);
    const projection = cellProjection.createCellProjection({ serviceability: oracle });

    const before = coordinatorPipeline.requirements({});
    const seam = simulationRouter.demonstrationRoutingSeam({
      projection,
      travelModel: MODEL,
      agents: [SIMULATED_ROBOT],
      mode: ROUTER_MODE.DEVELOPMENT,
      env: SIMULATED_ENV,
    });
    const after = coordinatorPipeline.requirements({ ...seam });

    const gained = after.satisfied.filter((id) => !before.satisfied.includes(id));
    expect(gained.slice().sort()).toEqual(CLAIMED.slice().sort());
    expect(before.satisfied.filter((id) => !after.satisfied.includes(id))).toEqual([]);
  });

  test("`timeBucket` stays unresolved — it is the round's, not the producer's", () => {
    const oracle = serviceability.createServiceabilityOracle(SQUARE_REGION);
    const projection = cellProjection.createCellProjection({ serviceability: oracle });
    const seam = simulationRouter.demonstrationRoutingSeam({
      projection,
      travelModel: MODEL,
      agents: [SIMULATED_ROBOT],
      mode: ROUTER_MODE.DEVELOPMENT,
      env: SIMULATED_ENV,
    });

    const after = coordinatorPipeline.requirements({ ...seam });
    expect(after.missing.map((row) => row.input)).toContain("timeBucket (§20.3 congestion bucket)");
    expect(after.ok).toBe(false);
  });

  test("the seam cannot be built in a non-simulated deployment either", () => {
    const oracle = serviceability.createServiceabilityOracle(SQUARE_REGION);
    const projection = cellProjection.createCellProjection({ serviceability: oracle });
    const error = refusalFrom(() =>
      simulationRouter.demonstrationRoutingSeam({
        projection,
        travelModel: MODEL,
        agents: [SIMULATED_ROBOT],
        mode: ROUTER_MODE.DEVELOPMENT,
        env: {},
      }),
    );
    expect(error.refusal).toBe(SIMULATION_REFUSAL.NOT_A_SIMULATED_DEPLOYMENT);
  });

  test("the seam's route is the router's — one producer, not a second copy", async () => {
    const oracle = serviceability.createServiceabilityOracle(SQUARE_REGION);
    const projection = cellProjection.createCellProjection({ serviceability: oracle });
    const seam = simulationRouter.demonstrationRoutingSeam({
      projection,
      travelModel: MODEL,
      agents: [SIMULATED_ROBOT],
      mode: ROUTER_MODE.DEVELOPMENT,
      env: SIMULATED_ENV,
    });

    const viaSeam = await seam.route(REQUEST);
    const viaRouter = await seam.router.route(REQUEST);
    expect(JSON.stringify(viaSeam)).toBe(JSON.stringify(viaRouter));
    expect(seam.hopTerrainSource).toBe(simulationRouter.SIMULATED_TERRAIN_SOURCE);
    expect(seam.travelTimeSpread).toBe(simulationRouter.SIMULATED_SPREAD_SOURCE);
    expect(seam.speedMetresPerSecondFor(PROFILE)).toBe(simulationRouter.SIMULATED_NOMINAL_SPEED_MS);
  });
});
