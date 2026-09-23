"use strict";

/**
 * **V1 demonstration — the composition/input probe, BEFORE and AFTER the simulation
 * routing producer.** Read-only diagnosis.
 *
 * ── What this is ───────────────────────────────────────────────────────────
 * `workers/coordinatorPipeline.requirements(context)` is a pure function of the composed
 * context: it asks 34 presence questions and answers each one *"is this present"*, never
 * *"here is a plausible value"*. This harness calls it twice — once with the V1
 * demonstration's L0 context exactly as it stands, and once with
 * `simulation/simulationRouter.demonstrationRoutingSeam()` spread into it — and reports
 * which requirements moved.
 *
 * It then drives one real route through the real `routing/cellPairCache.read`, so the
 * report says whether the producer actually answers rather than only whether the probe is
 * satisfied. Those are different facts and this programme has repeatedly found a seam that
 * passed the first and failed the second.
 *
 * ── It contacts nothing ────────────────────────────────────────────────────
 * No PostgreSQL, no Neon, no Redis, no routing engine, no network of any kind. The
 * configuration snapshot is built in process with `config/service.buildSnapshot`, which
 * reads the register from disk; the KV is a `Map`. The six `PROCESS_DEPENDENCY` rows are
 * satisfied with in-memory doubles, because those probes are presence checks and a
 * composition root always supplies them — see `PROCESS_DOUBLES` below, which says so at
 * the point it happens rather than in a footnote.
 *
 * ── It fabricates nothing ──────────────────────────────────────────────────
 * The bindings are `tools/config/v1DemonstrationConfig.bindings()` — the thirteen
 * ranking-only PROVISIONAL parameters, unchanged. The two Safety rows are **not** bound and
 * `assertNoSafetyParameter` is called to prove it. No `NO_PRODUCER` family is closed. No
 * route double is injected: the AFTER context's `route` is the real simulation producer.
 *
 *   node tools/verify/v1SimulationRoutingProbe.js
 */

const fs = require("fs");
const path = require("path");

const BACKEND_ROOT = path.resolve(__dirname, "..", "..");
const REPO_ROOT = path.resolve(BACKEND_ROOT, "..");

const configService = require("../../src/engine/config/service");
const coordinatorPipeline = require("../../src/workers/coordinatorPipeline");
const cells = require("../../src/engine/spatial/cells");
const regionBoundary = require("../../src/engine/spatial/regionBoundary");
const timeline = require("../../src/engine/plan/timeline");
const cellPairCache = require("../../src/engine/routing/cellPairCache");
const campusTravelModel = require("../../src/engine/routing/campusTravelModel");
const campusServiceability = require("../../src/engine/routing/campusServiceability");
const cellProjection = require("../../src/engine/routing/cellProjection");
const simulationPolicy = require("../../src/simulation/simulationPolicy");
const simulationRouter = require("../../src/simulation/simulationRouter");
const demonstration = require("../config/v1DemonstrationConfig");

function say(text) {
  process.stdout.write(`${text}\n`);
}

/**
 * The six `PROCESS_DEPENDENCY` probes are presence checks — "did the composition root
 * supply a client, a cache, a transaction runner, a row lock and a signing key". A
 * composition root always does. These doubles satisfy the probes without opening a
 * connection to anything; nothing in this harness calls a method on them.
 */
const PROCESS_DOUBLES = Object.freeze({
  prisma: { $queryRaw: () => { throw new Error("this probe opens no database connection"); } },
  runSerializable: () => { throw new Error("this probe opens no transaction"); },
  selectForUpdate: () => { throw new Error("this probe takes no row lock"); },
  isSerializationFailure: () => false,
  signingKey: "v1-simulation-routing-probe-key",
});

/** An in-memory KV, which is what `cellPairCache` needs and all it needs. */
function memoryKv() {
  const store = new Map();
  return {
    get: async (key) => (store.has(key) ? store.get(key) : null),
    set: async (key, value) => store.set(key, value),
    size: () => store.size,
  };
}

/** The adopted RNSIT boundary and the supplemental points, read from the tree. */
function geometry() {
  const boundaryFile = path.join(REPO_ROOT, "rnsit-campus-osm.geojson");
  const pointsFile = path.join(REPO_ROOT, "rnsit-campus-supplemental.geojson");
  const boundary = JSON.parse(fs.readFileSync(boundaryFile, "utf8")).features.find(
    (row) => row.id === "way/1120154292",
  ).geometry;

  const points = {};
  for (const feature of JSON.parse(fs.readFileSync(pointsFile, "utf8")).features) {
    const [lon, lat] = feature.geometry.coordinates;
    points[feature.properties.id] = { lat, lon };
  }
  return { boundary, points };
}

/**
 * The V1 demonstration's L0 context: the process dependencies a composition root always
 * supplies, plus exactly the zero-fabrication inputs the prior audit classified as such.
 * It is the BEFORE, and the AFTER is this object with the routing seam spread onto it.
 */
function baseContext(snapshot, kv, decisionTimeMs) {
  return {
    ...PROCESS_DOUBLES,
    kv,
    shardId: "v1-demo-shard",
    regionId: "rnsit",
    instanceId: `v1-simulation-routing-probe:${process.pid}`,
    snapshot: () => snapshot,
    values: () => snapshot.values,
    record: () => {},

    // The zero-fabrication inputs, unchanged from the existing trace's L0.
    // @structural IST, the deployment's own offset — `timeline.hourOfWeek`'s convention
    timeBucket: timeline.hourOfWeek(decisionTimeMs, 19800),
    vehicleMassKgFor: () => 42,
    environmentFor: () => ({ ambientC: 28, packC: 30 }),
  };
}

function report(label, contract) {
  const total = coordinatorPipeline.REQUIREMENT_IDS.length;
  say(`   ${label}: ${contract.satisfied.length} / ${total} satisfied, ${contract.missing.length} unresolved`);
  say(`   byClass: ${JSON.stringify(contract.byClass)}`);
  for (const row of contract.missing) say(`     - [${row.class}] ${row.input}`);
}

async function main() {
  say("═════════════════════════════════════════════════════════════════════");
  say(" V1 DEMONSTRATION — COMPOSITION PROBE, BEFORE / AFTER THE SIMULATION");
  say(" ROUTING PRODUCER. Read-only. No PostgreSQL, no Redis, no network.");
  say("═════════════════════════════════════════════════════════════════════\n");

  /* ── Configuration: the thirteen, and a proof the two Safety rows are absent ── */
  const bindings = demonstration.bindings();
  demonstration.assertNoSafetyParameter(bindings);
  const snapshot = configService.buildSnapshot({ bindings, version: null });

  say("── CONFIGURATION ───────────────────────────────────────────────────");
  say(`   the 13 demonstration parameters bound: ${bindings.length}`);
  say(`   all 13 resolve: ${demonstration.PARAMETER_NAMES.every((name) => snapshot.resolve(name, {}) !== null)}`);
  for (const name of ["energy.model_residual_cv", "energy.reserve_floor_wh"]) {
    say(`   ${name} = ${String(snapshot.resolve(name, {}))}   (Safety — NOT bound, NOT invented)`);
  }
  say("");

  const kv = memoryKv();
  const decisionTimeMs = Date.UTC(2026, 8, 21, 6, 0, 0);
  const before = baseContext(snapshot, kv, decisionTimeMs);

  say("── BEFORE (a) — no routing input at all ────────────────────────────");
  const beforeContract = coordinatorPipeline.requirements(before);
  report("BEFORE(a)", beforeContract);
  say("");

  /* ── BEFORE (b): parity with the existing trace's L0 ─────────────────────
   * `tools/verify/v1DemonstrationSolvePath.js`'s L0 already supplies two of the four
   * routing inputs — a spread SOURCE NAME and a speed — without supplying a router. Both
   * are measured here so this slice's delta is not overstated by counting them as its own.
   *
   * It also records a real finding: that L0 names the **production** declaration
   * `DECLARED_V1_OPERATIONAL_UNCERTAINTY` for a run whose numbers are simulated. The
   * probe cannot see the difference — it is a presence check — but the label is wrong for
   * a demonstration, and `SIMULATED_SPREAD_SOURCE` is what the seam supplies instead. */
  const beforeTraceParity = {
    ...before,
    travelTimeSpread: campusTravelModel.DECLARED_SPREAD_SOURCE,
    // @structural the existing trace's own L0 speed, reproduced for parity, not proposed
    speedMetresPerSecondFor: () => 1.5,
  };
  say("── BEFORE (b) — parity with tools/verify/v1DemonstrationSolvePath L0 ─");
  const parityContract = coordinatorPipeline.requirements(beforeTraceParity);
  report("BEFORE(b)", parityContract);
  say(`   note: L0's travelTimeSpread is "${campusTravelModel.DECLARED_SPREAD_SOURCE}" — the PRODUCTION`);
  say(`   declaration, named for a simulated run. The seam supplies "${simulationRouter.SIMULATED_SPREAD_SOURCE}".`);
  say("");

  /* ── The producer, composed exactly as a demonstration root would ──────── */
  const { boundary, points } = geometry();
  const declaration = {
    regionId: "rnsit-campus",
    name: "RNSIT Campus",
    kind: regionBoundary.REGION_KIND.CAMPUS,
    crs: "EPSG:4326",
    version: "way/1120154292",
    versionDate: "2026-08-30",
    boundary,
  };
  const oracle = campusServiceability.createServiceabilityOracle(declaration);
  const projection = cellProjection.createCellProjection({ serviceability: oracle });
  const travelModel = campusTravelModel.resolveModelParameters(snapshot, {});

  say("── THE SIMULATION ROUTING PRODUCER ─────────────────────────────────");
  say(`   region boundary: ${oracle.regionId} status=${oracle.regionStatus} usable=${oracle.usable}`);
  say(`   travel model: ${JSON.stringify({ ok: travelModel.ok, buffer: travelModel.bufferSecondsPer100m, sdMultiple: travelModel.sdBufferMultiple })}`);

  // The simulator posture is stated to this harness, never set on `process.env`: the
  // producer takes an injected `env` precisely so a probe need not mutate the process.
  const env = { [simulationPolicy.SIMULATOR_ENV_VAR]: "true" };
  const agents = [{ robotId: "v1-demo-robot", simulated: true }];

  let seam;
  try {
    seam = simulationRouter.demonstrationRoutingSeam({
      projection,
      travelModel,
      agents,
      mode: "DEVELOPMENT",
      env,
    });
  } catch (error) {
    say(`   REFUSED: [${error.refusal}] ${error.message}`);
    return 1;
  }
  say(`   ${seam.router.describe()}`);
  say("");

  /* ── The refusals, exercised rather than asserted in prose ─────────────── */
  say("── REFUSALS (exercised, not claimed) ───────────────────────────────");
  for (const [label, run] of [
    ["non-simulated deployment", () => simulationRouter.createSimulationRouter({ projection, travelModel, agents, mode: "DEVELOPMENT", env: {} })],
    ["non-simulated robot", () => simulationRouter.createSimulationRouter({ projection, travelModel, agents: [{ robotId: "phys-1", simulated: false }], mode: "DEVELOPMENT", env })],
    ["mode not stated", () => simulationRouter.createSimulationRouter({ projection, travelModel, agents, env })],
    ["production provenance claimed", () => simulationRouter.createSimulationRouter({ projection, travelModel, agents, mode: "DEVELOPMENT", env, speedProvenance: "PRODUCTION_EXTERNAL" })],
  ]) {
    try {
      run();
      say(`   !! ${label}: NOT REFUSED — this is a defect`);
    } catch (error) {
      say(`   ${label}: REFUSED [${error.refusal}]`);
    }
  }
  say("");

  /* ── AFTER ─────────────────────────────────────────────────────────────── */
  const after = { ...before, ...seam };
  say("── AFTER — the same context with the routing seam spread in ────────");
  const afterContract = coordinatorPipeline.requirements(after);
  report("AFTER", afterContract);
  say("");

  say("── DELTA ───────────────────────────────────────────────────────────");
  for (const [label, baseline] of [["(a) no routing input", beforeContract], ["(b) trace-L0 parity", parityContract]]) {
    const gained = afterContract.satisfied.filter((id) => !baseline.satisfied.includes(id));
    const lost = baseline.satisfied.filter((id) => !afterContract.satisfied.includes(id));
    say(`   against BEFORE ${label}: ${baseline.missing.length} → ${afterContract.missing.length} unresolved`);
    say(`     resolved by this slice (${gained.length}):`);
    for (const id of gained) say(`       + ${id}`);
    say(`     regressed (${lost.length}): ${lost.length === 0 ? "none" : lost.join(", ")}`);
  }
  say("");

  /* ── One real route, through the real cache ────────────────────────────── */
  say("── ONE REAL ROUTE THROUGH routing/cellPairCache.read ───────────────");
  const origin = points["rnsit-innovation-center"];
  const destination = points["rnsit-food-court"];
  const originCell = cells.cellForPoint(origin.lat, origin.lon, cells.RESOLUTION.FINE);
  const destCell = cells.cellForPoint(destination.lat, destination.lon, cells.RESOLUTION.FINE);
  const parts = {
    originCell,
    destCell,
    profileKey: "MOB-V1-DEMO:SIDEWALK_GRAPH:unloaded",
    timeBucket: after.timeBucket,
  };
  say(`   ${originCell} → ${destCell}  bucket ${parts.timeBucket}`);

  const counters = new cellPairCache.Counters();
  const options = {
    ttlSeconds: snapshot.resolve("route.cell_pair_cache_ttl", {}),
    intraCellOffsetM: snapshot.resolve("route.intra_cell_offset_m", {}),
    speedMetresPerSecond: after.speedMetresPerSecondFor(parts.profileKey),
  };

  const raw = await after.route(parts).catch((error) => ({ refused: error }));
  if (raw.refused) {
    say(`   the producer REFUSED: [${raw.refused.refusal}] ${raw.refused.message}`);
  } else {
    say(`   producer: ${JSON.stringify({
      distanceM: raw.distanceM,
      travelSeconds: raw.travelSeconds,
      travelSdSeconds: raw.travelSdSeconds,
      climbM: raw.climbM,
      descentM: raw.descentM,
      stopStartCycles: raw.stopStartCycles,
    })}`);
    say(`   provenance: ${JSON.stringify(raw.provenance)}`);
  }

  const read = await cellPairCache.read({ kv, route: after.route, counters }, parts, options);
  say(`   cellPairCache.read ok=${read.ok} hit=${read.hit} reason=${String(read.reason)}`);
  if (read.entry) say(`   entry: ${JSON.stringify(read.entry)}`);
  const again = await cellPairCache.read({ kv, route: after.route, counters }, parts, options);
  say(`   second read hit=${again.hit}; counters=${JSON.stringify(counters.report(0.95))}`);
  say("");

  /* ── What remains ──────────────────────────────────────────────────────── */
  say("── WHAT THIS SLICE DID NOT CLOSE ───────────────────────────────────");
  const remainingByClass = new Map();
  for (const row of afterContract.missing) {
    if (!remainingByClass.has(row.class)) remainingByClass.set(row.class, []);
    remainingByClass.get(row.class).push(row.input);
  }
  for (const [className, inputs] of remainingByClass) {
    say(`   ${className} (${inputs.length}):`);
    for (const input of inputs) say(`     - ${input}`);
  }
  say("");
  say(`   describeMissing: ${coordinatorPipeline.describeMissing(afterContract.missing)}`);
  say("");
  say("   NOTE — a satisfied probe is not a working engine. This harness establishes that");
  say("   the routing inputs are PRESENT and that the producer ANSWERS. It establishes");
  say("   nothing about assignment quality, feasibility, or any physical robot.");

  return afterContract.missing.length === 0 ? 0 : 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`${error && error.stack}\n`);
    process.exit(1);
  },
);
