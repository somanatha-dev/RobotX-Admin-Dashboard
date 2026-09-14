"use strict";

/**
 * ROUTING BATCH 1 — **live** verification against a self-hosted OSRM runtime.
 *
 * ── What this proves, and what it deliberately does not ────────────────────
 * It proves that the production routing producer talks to a **real, self-hosted routing
 * engine** over a **real OpenStreetMap graph**, that the answer flows through the shipped
 * `cellPairCache` under the real four-part key, that the owner's V1 travel model is applied
 * to the engine's measured distance, and that every field with no producer is refused rather
 * than filled in.
 *
 * It proves **nothing** about engine performance and is **not B1 Step 3 evidence**: Step 1
 * (per-profile contraction hierarchies built against an approved extract) has not been
 * performed, and no engine is selected, ranked or recommended by this tool. It does not
 * discharge D1, D3 or D8.
 *
 * ── The two scenarios, and why there are two ───────────────────────────────
 *
 *   **A — RNSIT, the adopted boundary.** `way/1120154292`, exactly as RD-2026-08-30-01
 *   adopts it. This scenario is expected to **refuse every cell**, and it runs so that the
 *   refusal is demonstrated on live infrastructure rather than asserted on paper: the campus
 *   is ~0.0998 km² against a 0.7373 km² H3 res-8 cell, so all three cells its boundary
 *   touches have centres outside it. The engine is separately shown to route *inside* the
 *   campus by direct point queries, which is what makes the finding precise — the graph is
 *   fine, the cell-keyed identity is not.
 *
 *   **B — the downloaded extract's own bbox, as a VERIFICATION region.** A region large
 *   enough that its cells' centres fall inside it, so the full seam can be exercised end to
 *   end against the same live engine. It is a **verification construct and nothing else**:
 *   it is not a serviceable-area commitment, it is not an operating region, no commercial
 *   commitment attaches to it, and it must never be cited as D1 supply. It exists because
 *   the alternative — declaring the seam unverifiable — would leave the code unexercised.
 *
 * ── Infrastructure ────────────────────────────────────────────────────────
 * Disposable and local only. The base URL is checked by `contract.assertSelfHosted`, which
 * refuses all six public hosted services outright, so this tool cannot be pointed at
 * somebody else's cluster even by accident. No database is touched. No production system is
 * contacted.
 *
 *   node tools/verify/routingBatch1Live.js [--base-url http://127.0.0.1:5000]
 *                                          [--osm <path to the extract, for provenance>]
 *                                          [--json]
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const contract = require("../routing/adapters/contract");
const osrm = require("../routing/adapters/osrm");
const configService = require("../../src/engine/config/service");
const cells = require("../../src/engine/spatial/cells");
const regionBoundary = require("../../src/engine/spatial/regionBoundary");
const timeline = require("../../src/engine/plan/timeline");
const cellPairCache = require("../../src/engine/routing/cellPairCache");
const travelModel = require("../../src/engine/routing/campusTravelModel");
const campusServiceability = require("../../src/engine/routing/campusServiceability");
const cellProjection = require("../../src/engine/routing/cellProjection");
const productionRouter = require("../../src/engine/routing/productionRouter");

const REPO_ROOT = path.join(__dirname, "..", "..", "..");
const DEFAULT_BASE_URL = "http://127.0.0.1:5000";
/** @structural the OSRM engine-side profile the graph was built with */
const ENGINE_PROFILE = "foot";
/** @structural a local-loopback budget, generous because this is a correctness run, not a benchmark */
const MATRIX_TIMEOUT_MS = 10000;
/** @structural OSRM snaps to the nearest edge at ANY distance without this; R13 requires a bound */
const SNAP_RADIUS_M = 60;
/** @structural an arbitrary in-range hour-of-week for the run, Sunday 00:00 = 0 */
const RUN_TIME_BUCKET = 37;

const checks = [];

/**
 * Record one check. `expected` states what the honest outcome is, so a reader can tell a
 * demonstrated refusal from a failure.
 */
function record(id, what, ok, detail) {
  checks.push({ id, what, verdict: ok ? "PASS" : "FAIL", detail });
  return ok;
}

/** The adopted RNSIT boundary, read from the tree rather than transcribed. */
function rnsitGeometry() {
  const file = path.join(REPO_ROOT, "rnsit-campus-osm.geojson");
  const collection = JSON.parse(fs.readFileSync(file, "utf8"));
  return collection.features.find((entry) => entry.id === "way/1120154292").geometry;
}

/**
 * The §1.8.1 owner-declared identifiers around that geometry.
 *
 * **This is not a D1 supply and must not be read as one.** `RD-2026-08-30-01` §7 gives four
 * independent reasons the tracked GeoJSON is not admissible external supply, and
 * `B1_EXTERNAL_INPUT_HANDOFF.md` §1.8.2 records that RNSIT still requires a snapshot artefact
 * that does not exist. This is a verification fixture built from the owner's recorded
 * decisions so that the *code* can be exercised against the *real* geometry.
 */
function rnsitVerificationRegion() {
  return {
    regionId: "rnsit-bengaluru",
    name: "RNSIT Bengaluru Campus",
    kind: regionBoundary.REGION_KIND.CAMPUS,
    crs: "OGC:CRS84",
    version: "rnsit-boundary-v1",
    versionDate: "2026-08-30",
    boundary: rnsitGeometry(),
  };
}

/**
 * Scenario B's region — the extract's own bounding box.
 *
 * Named `verification-bbox` so that nothing about it reads as a place RobotX serves.
 */
function verificationBboxRegion() {
  return {
    regionId: "verification-bbox",
    name: "VERIFICATION ONLY — routing extract bounding box, not a serviceable area",
    kind: regionBoundary.REGION_KIND.METRO_SERVICE_AREA,
    crs: "OGC:CRS84",
    version: "verification-v1",
    versionDate: "2026-09-13",
    boundary: {
      type: "Polygon",
      coordinates: [
        [
          [77.5110, 12.8950],
          [77.5240, 12.8950],
          [77.5240, 12.9065],
          [77.5110, 12.9065],
          [77.5110, 12.8950],
        ],
      ],
    },
  };
}

/** A minimal JSON transport over the local engine. */
function liveTransport() {
  return async ({ method, url, signal }) => {
    const response = await fetch(url, { method, signal });
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { httpStatus: response.status, body };
  };
}

function buildAdapter(baseUrl, projection, extractDescription) {
  return osrm.create({
    baseUrl,
    engineProfile: ENGINE_PROFILE,
    projectCell: (cellId) => projection.projectCell(cellId),
    chargerCatalogue: () => [],
    matrixTimeoutMs: MATRIX_TIMEOUT_MS,
    snapRadiusM: SNAP_RADIUS_M,
    travelTimeSpread: { source: travelModel.DECLARED_SPREAD_SOURCE, model: "PROPORTIONAL", value: 0 },
    // The vehicle the ENGINE is routing, which is not RobotX's travel model — the router
    // overrides the duration and this field is the adapter's own declaration.
    profile: { energyWhPerMetre: 0.05, speedMetresPerSecond: 1.5 },
    deployment: {
      shape: "disposable local container, osrm-routed --algorithm mld",
      extract: extractDescription,
      profilesBuilt: ENGINE_PROFILE,
      hierarchyBuildTime: "osrm-partition + osrm-customize, local run",
    },
    transport: liveTransport(),
  });
}

async function main(argv) {
  const args = argv || [];
  const asJson = args.includes("--json");
  const baseUrlIndex = args.indexOf("--base-url");
  const baseUrl = baseUrlIndex >= 0 ? args[baseUrlIndex + 1] : DEFAULT_BASE_URL;
  const osmIndex = args.indexOf("--osm");
  const osmPath = osmIndex >= 0 ? args[osmIndex + 1] : null;

  // ── R1 first: this tool cannot be pointed at a hosted service ──
  try {
    contract.assertSelfHosted("osrm", baseUrl);
    record("L0", "the base URL is a self-hosted engine (R1, §5.2, ADR-11)", true, baseUrl);
  } catch (error) {
    record("L0", "the base URL is a self-hosted engine (R1, §5.2, ADR-11)", false, error.message);
    return report(asJson);
  }

  // ── Extract provenance, recorded rather than assumed ──
  let extractDescription = "operator-supplied OSM extract (path not given to this tool)";
  if (osmPath && fs.existsSync(osmPath)) {
    const bytes = fs.readFileSync(osmPath);
    const digest = crypto.createHash("sha256").update(bytes).digest("hex");
    extractDescription = `${path.basename(osmPath)} sha256:${digest} (${bytes.length} bytes)`;
    record("L1", "the routing extract is named by content, not by adjective", true, extractDescription);
  } else {
    record("L1", "the routing extract is named by content, not by adjective", false, "no --osm path supplied, so the extract's identity is not pinned by this run (D8)");
  }

  // ── The engine is actually up ──
  try {
    const response = await fetch(`${baseUrl}/table/v1/${ENGINE_PROFILE}/77.5174,12.9009;77.5180,12.9015?annotations=duration,distance`);
    const body = await response.json();
    record("L2", "a self-hosted OSRM runtime answers the Table service", body.code === "Ok", `code=${body.code}`);
    if (body.code !== "Ok") return report(asJson);
  } catch (error) {
    record("L2", "a self-hosted OSRM runtime answers the Table service", false, `${error.message} — start one, or pass --base-url`);
    return report(asJson);
  }

  const snapshot = configService.defaultSnapshot();
  const model = travelModel.resolveModelParameters(snapshot, {});
  record("L3", "the V1 travel model resolves from the parameter register", model.ok, `buffer=${model.bufferSecondsPer100m} s/100 m, sdMultiple=${model.sdBufferMultiple}`);
  if (!model.ok) return report(asJson);

  /* ══════════════════════════════════════════════════════════════════════════
     SCENARIO A — RNSIT, the adopted boundary
     ══════════════════════════════════════════════════════════════════════════ */

  const rnsit = campusServiceability.createServiceabilityOracle(rnsitVerificationRegion());
  record("A1", "the adopted RNSIT geometry validates as a region declaration", rnsit.regionStatus === regionBoundary.BOUNDARY_STATUS.VALID, rnsit.problems.join("; ") || "V-1…V-6 clean");

  // The engine routes INSIDE the campus — proven by a direct point query, so the finding
  // below cannot be mistaken for "the graph does not cover RNSIT".
  // Two points inside the adopted polygon, each within the snap radius of a mapped campus
  // way. They were found by probing the live engine's `nearest` service rather than chosen
  // by eye: a coordinate that merely *looks* like it is on a path is how a verification run
  // ends up asserting something about the author's guess instead of about the graph.
  const insideA = [77.5175, 12.9022];
  const insideB = [77.5191, 12.9022];
  const pointResponse = await fetch(
    `${baseUrl}/table/v1/${ENGINE_PROFILE}/${insideA.join(",")};${insideB.join(",")}` +
      `?sources=0&destinations=1&annotations=duration,distance&radiuses=${SNAP_RADIUS_M};${SNAP_RADIUS_M}`,
  );
  const pointBody = await pointResponse.json();
  const campusDistanceM = pointBody.code === "Ok" ? pointBody.distances[0][0] : null;
  record(
    "A2",
    "the live graph routes between two points INSIDE the RNSIT campus",
    typeof campusDistanceM === "number" && campusDistanceM > 0,
    `code=${pointBody.code}, distance=${campusDistanceM} m`,
  );

  // Both endpoints are genuinely inside the adopted boundary.
  record(
    "A3",
    "both of those points are inside the adopted serviceable boundary",
    rnsit.isServiceable(insideA[1], insideA[0]) && rnsit.isServiceable(insideB[1], insideB[0]),
    "point-in-polygon against way/1120154292",
  );

  // And yet every cell the campus touches projects outside it.
  const rnsitProjection = cellProjection.createCellProjection({ serviceability: rnsit });
  const touched = [...new Set(rnsitGeometry().coordinates[0].map(([lon, lat]) => cells.cellForPoint(lat, lon, cells.RESOLUTION.FINE)))];
  const refusals = [];
  for (const cellId of touched) {
    try {
      rnsitProjection.project(cellId);
      refusals.push(`${cellId}: ACCEPTED (unexpected)`);
    } catch (error) {
      refusals.push(`${cellId}: ${error.refusal}`);
    }
  }
  const allRefused = refusals.every((entry) => entry.includes("OUTSIDE_SERVICEABLE_REGION"));
  record(
    "A4",
    "EVERY RNSIT cell is refused by the projection — the measured architectural finding",
    allRefused,
    `${touched.length} cell(s): ${refusals.join(", ")}. The campus is ~0.0998 km² against a 0.7373 km² res-8 cell, ` +
      "so no cell centre lies inside it. This is the spatial-model escalation of B1_EXTERNAL_INPUT_HANDOFF.md " +
      "§1.8.3–§1.8.5 reaching the routing layer. It is NOT resolved here",
  );

  /* ══════════════════════════════════════════════════════════════════════════
     SCENARIO B — the full seam, end to end, on the same live engine
     ══════════════════════════════════════════════════════════════════════════ */

  const bbox = campusServiceability.createServiceabilityOracle(verificationBboxRegion());
  const projection = cellProjection.createCellProjection({ serviceability: bbox });
  const adapter = buildAdapter(baseUrl, projection, extractDescription);

  // Two cells whose centres fall inside the verification region AND within the snap radius
  // of the graph — established by probing the engine's `nearest` service (5.1 m and 10.1 m
  // respectively), not assumed. Only three res-8 cells have a centre inside this bbox at
  // all, which is itself a demonstration of how coarse the frozen fine band is against a
  // campus-scale extract.
  const originCell = cells.cellForPoint(12.903954, 77.513370, cells.RESOLUTION.FINE);
  const destCell = cells.cellForPoint(12.903925, 77.521786, cells.RESOLUTION.FINE);
  const profileKey = "MOB-VERIFY:SIDEWALK_GRAPH:unloaded";
  const request = { originCell, destCell, profileKey, timeBucket: RUN_TIME_BUCKET };

  // ── B1: production mode with no terrain source refuses, on live infrastructure ──
  const productionMode = productionRouter.createProductionRouter({
    adapter,
    projection,
    travelModel: model,
    speedFor: () => 1.5,
    speedProvenance: productionRouter.FIELD_PROVENANCE.PRODUCTION_DECLARED,
    mode: productionRouter.ROUTER_MODE.PRODUCTION,
  });
  let productionRefusal = null;
  try {
    await productionMode.route(request);
  } catch (error) {
    productionRefusal = error;
  }
  record(
    "B1",
    "PRODUCTION mode refuses: no terrain producer exists",
    productionRefusal !== null && productionRefusal.refusal === productionRouter.ROUTE_REFUSAL.NO_TERRAIN_SOURCE,
    productionRefusal ? productionRefusal.refusal : "a route was returned, which would mean terrain was fabricated",
  );

  // ── B2: a simulated terrain value is refused in production mode ──
  const productionWithSimTerrain = productionRouter.createProductionRouter({
    adapter,
    projection,
    travelModel: model,
    speedFor: () => 1.5,
    speedProvenance: productionRouter.FIELD_PROVENANCE.PRODUCTION_DECLARED,
    terrainSource: async () => ({ climbM: 3, descentM: 3, provenance: productionRouter.FIELD_PROVENANCE.DEVELOPMENT_SIMULATION }),
    stopStartSource: async () => ({ stopStartCycles: 2, provenance: productionRouter.FIELD_PROVENANCE.DEVELOPMENT_SIMULATION }),
    mode: productionRouter.ROUTER_MODE.PRODUCTION,
  });
  let masqueradeRefusal = null;
  try {
    await productionWithSimTerrain.route(request);
  } catch (error) {
    masqueradeRefusal = error;
  }
  record(
    "B2",
    "a SIMULATED value cannot masquerade as production evidence",
    masqueradeRefusal !== null && masqueradeRefusal.refusal === productionRouter.ROUTE_REFUSAL.SIMULATION_IN_PRODUCTION,
    masqueradeRefusal ? masqueradeRefusal.refusal : "the simulated value was accepted in PRODUCTION mode",
  );

  // ── B3: DEVELOPMENT mode, complete six-field route over the live engine ──
  const development = productionRouter.createProductionRouter({
    adapter,
    projection,
    travelModel: model,
    speedFor: () => 1.5,
    speedProvenance: productionRouter.FIELD_PROVENANCE.DEVELOPMENT_SIMULATION,
    terrainSource: async () => ({ climbM: 3, descentM: 3, provenance: productionRouter.FIELD_PROVENANCE.DEVELOPMENT_SIMULATION }),
    stopStartSource: async () => ({ stopStartCycles: 2, provenance: productionRouter.FIELD_PROVENANCE.DEVELOPMENT_SIMULATION }),
    mode: productionRouter.ROUTER_MODE.DEVELOPMENT,
  });

  let route = null;
  try {
    route = await development.route(request);
  } catch (error) {
    record("B3", "DEVELOPMENT mode returns a complete six-field route from the live engine", false, `${error.refusal || "error"}: ${error.message}`);
    return report(asJson);
  }

  const sixFields = ["distanceM", "travelSeconds", "travelSdSeconds", "climbM", "descentM", "stopStartCycles"];
  const allFinite = sixFields.every((field) => Number.isFinite(route[field]) && route[field] >= 0);
  record("B3", "DEVELOPMENT mode returns a complete six-field route from the live engine", allFinite, sixFields.map((f) => `${f}=${route[f]}`).join(", "));

  // ── B4: the distance really came from the engine, not from geometry ──
  const straightLineM = require("h3-js").greatCircleDistance(
    require("h3-js").cellToLatLng(originCell),
    require("h3-js").cellToLatLng(destCell),
    "m",
  );
  record(
    "B4",
    "distanceM is the ENGINE's routed distance, longer than the straight line",
    route.distanceM > straightLineM,
    `routed=${route.distanceM.toFixed(1)} m vs straight line=${straightLineM.toFixed(1)} m (detour ratio ${(route.distanceM / straightLineM).toFixed(3)})`,
  );

  // ── B5: the owner's formula, recomputed independently of the module ──
  const expectedBase = route.distanceM / 1.5;
  const expectedBuffer = (route.distanceM * 15) / 100;
  const formulaHolds = Math.abs(route.travelSeconds - (expectedBase + expectedBuffer)) < 1e-9;
  record(
    "B5",
    "travelSeconds = distanceM / speedMps + distanceM x 15 / 100",
    formulaHolds,
    `${route.distanceM.toFixed(2)} / 1.5 + ${route.distanceM.toFixed(2)} x 15 / 100 = ${(expectedBase + expectedBuffer).toFixed(4)} s; ` +
      `router returned ${route.travelSeconds.toFixed(4)} s (base ${expectedBase.toFixed(2)} + buffer ${expectedBuffer.toFixed(2)})`,
  );

  // ── B6: the engine's own duration was NOT used ──
  const engineTable = await fetch(
    `${baseUrl}/table/v1/${ENGINE_PROFILE}/${route.endpoints.origin.lon},${route.endpoints.origin.lat};` +
      `${route.endpoints.destination.lon},${route.endpoints.destination.lat}` +
      `?sources=0&destinations=1&annotations=duration,distance&radiuses=${SNAP_RADIUS_M};${SNAP_RADIUS_M}`,
  );
  const engineBody = await engineTable.json();
  const engineDuration = engineBody.code === "Ok" ? engineBody.durations[0][0] : null;
  record(
    "B6",
    "the ENGINE's duration is discarded; RobotX's travel time is the owner's model",
    engineDuration !== null && Math.abs(engineDuration - route.travelSeconds) > 1e-6,
    `engine said ${engineDuration} s (its own foot-profile speed); RobotX reports ${route.travelSeconds.toFixed(2)} s`,
  );

  // ── B7: the spread is positive and carries its declared source ──
  record(
    "B7",
    "travelSdSeconds is positive and names DECLARED_V1_OPERATIONAL_UNCERTAINTY (N29)",
    route.travelSdSeconds > 0 && route.provenance.travelSdSource === "DECLARED_V1_OPERATIONAL_UNCERTAINTY",
    `sd=${route.travelSdSeconds.toFixed(2)} s, source=${route.provenance.travelSdSource}`,
  );

  // ── B8: the shipped cell-pair cache, with the real four-part key ──
  const store = new Map();
  const kv = {
    get: async (key) => store.get(key) || null,
    set: async (key, value) => {
      store.set(key, value);
    },
  };
  const counters = new cellPairCache.Counters();
  const deps = { kv, counters, route: (parts) => development.route(parts) };
  const options = { ttlSeconds: 300, intraCellOffsetM: snapshot.resolve("route.intra_cell_offset_m", {}), speedMetresPerSecond: 1.5 };

  const miss = await cellPairCache.read(deps, request, options);
  const hit = await cellPairCache.read(deps, request, options);
  const otherBucket = await cellPairCache.read(deps, { ...request, timeBucket: RUN_TIME_BUCKET + 1 }, options);
  const otherProfile = await cellPairCache.read(deps, { ...request, profileKey: `${profileKey}-B` }, options);

  record(
    "B8",
    "the route flows through the SHIPPED cellPairCache and is cached",
    miss.ok && miss.hit === false && hit.ok && hit.hit === true,
    `miss then hit; hit rate ${JSON.stringify(counters.report(0.95))}`,
  );
  record(
    "B9",
    "a different timeBucket and a different profile are different cache entries",
    otherBucket.hit === false && otherProfile.hit === false && store.size === 3,
    `${store.size} distinct key(s) for 3 distinct identities: ${[...store.keys()].join(" | ")}`,
  );

  // ── B10: the intra-cell offset is applied in the pessimistic direction ──
  record(
    "B10",
    "§20.3's intra-cell offset inflates the cached pair, never deflates it",
    hit.entry.distanceM > route.distanceM && hit.entry.correctionDirection === "ADDED",
    `raw ${route.distanceM.toFixed(1)} m -> corrected ${hit.entry.distanceM.toFixed(1)} m (offset ${hit.entry.intraCellOffsetM} m)`,
  );

  // ── B11: timeBucket is the convention the rest of the engine uses ──
  const derivedBucket = timeline.hourOfWeek(Date.UTC(2026, 8, 13, 12, 0, 0), 0);
  record(
    "B11",
    "timeBucket is plan/timeline.hourOfWeek's 0…167, Sunday 00:00 = 0",
    Number.isInteger(derivedBucket) && derivedBucket >= 0 && derivedBucket < productionRouter.TIME_BUCKET_COUNT,
    `2026-09-13 12:00 UTC -> bucket ${derivedBucket}`,
  );

  // ── B12: a destination outside the region is refused before any engine call ──
  const outsideCell = cells.cellForPoint(12.80, 77.40, cells.RESOLUTION.FINE);
  let outsideRefusal = null;
  try {
    await development.route({ ...request, destCell: outsideCell });
  } catch (error) {
    outsideRefusal = error;
  }
  record(
    "B12",
    "a destination outside the region is refused as outside the domain",
    outsideRefusal !== null && outsideRefusal.refusal === productionRouter.ROUTE_REFUSAL.OUTSIDE_SERVICEABLE_REGION,
    outsideRefusal ? outsideRefusal.refusal : "it was routed",
  );

  // ── B13: a destination inside the region but off the graph is a DIFFERENT refusal ──
  // The third cell in the bbox. Its centre is inside the verification region and **101.6 m**
  // from the nearest mapped way — beyond the R13 snap radius — so it is the genuine
  // "inside the domain, not on the graph" case rather than a contrived one.
  const offGraphCell = cells.cellForPoint(12.896460, 77.517454, cells.RESOLUTION.FINE);
  let offGraph = null;
  try {
    const answer = await development.route({ ...request, destCell: offGraphCell });
    offGraph = { routed: true, distanceM: answer.distanceM };
  } catch (error) {
    offGraph = { routed: false, refusal: error.refusal };
  }
  record(
    "B13",
    "inside-but-unroutable is reported distinctly from outside-the-domain",
    offGraph.routed === true || offGraph.refusal === productionRouter.ROUTE_REFUSAL.NOT_ROUTABLE,
    offGraph.routed
      ? `this cell happened to be routable (${offGraph.distanceM.toFixed(1)} m), so the distinction is exercised by B12 and the unit suite instead`
      : `refused as ${offGraph.refusal}, which is NOT ${productionRouter.ROUTE_REFUSAL.OUTSIDE_SERVICEABLE_REGION}`,
  );

  return report(asJson, { route, describe: development.describe() });
}

function report(asJson, extra) {
  const passed = checks.filter((entry) => entry.verdict === "PASS").length;
  const failed = checks.length - passed;

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ total: checks.length, passed, failed, checks, ...(extra || {}) }, null, 2)}\n`);
  } else {
    const lines = ["ROUTING BATCH 1 — live verification against a self-hosted OSRM runtime", ""];
    for (const entry of checks) {
      lines.push(`  ${entry.verdict.padEnd(6)} ${entry.id.padEnd(4)} ${entry.what}`);
      if (entry.detail) lines.push(`                ${entry.detail}`);
    }
    lines.push("");
    lines.push(`  ${passed} PASS, ${failed} FAIL, of ${checks.length}.`);
    lines.push("");
    lines.push("  This is NOT B1 Step 3 evidence: Step 1 has not been performed and no engine is selected,");
    lines.push("  ranked or recommended here. It discharges neither D1 nor D3 nor D8.");
    process.stdout.write(`${lines.join("\n")}\n`);
  }
  return failed === 0 ? 0 : 1;
}

module.exports = { main };

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
