"use strict";

/**
 * **Live verification of the D1 two-layer spatial model** (`RD-2026-09-14-01`).
 *
 * Unit tests prove the modules. This proves the **seam**: that a verdict computed by the
 * real `task.service.sealIdentities` against the real adopted RNSIT geometry, written to
 * a real PostgreSQL column, read back by the real `coordinatorSolvePath.legLoaderFor`
 * query, survives every layer and reaches F33 intact. Every previous phase of this
 * programme found defects that only a live database could show, and the specific class —
 * a producer and a consumer each correct in isolation, connected by a projection that
 * silently dropped the field — is exactly what D1 adds.
 *
 * Disposable local PostgreSQL only, on a non-default port, guarded by allow-list before
 * anything connects. **Never Neon. Never the developer's own 5432.**
 *
 *   node tools/verify/spatialDeliveryDomainLive.js <postgres-url>
 */

const url = process.argv[2];

function refuse(message) {
  process.stderr.write(`REFUSED: ${message}\n`);
  process.exit(2);
}

if (!url) refuse("usage: node tools/verify/spatialDeliveryDomainLive.js <postgres-url>");

let target;
try {
  target = new URL(url);
} catch {
  refuse(`"${url}" is not a parseable URL`);
}

// Allow-list, not deny-list. A deny-list naming `neon.tech` is one new hostname away from
// being wrong, and this tool writes rows.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const DEFAULT_POSTGRES_PORT = "5432";

if (!/^postgres(ql)?:$/u.test(target.protocol)) refuse(`protocol ${target.protocol} is not postgres`);
if (!LOOPBACK_HOSTS.has(target.hostname)) refuse(`host "${target.hostname}" is not loopback`);
if (target.port === "" || target.port === DEFAULT_POSTGRES_PORT) {
  refuse(`port "${target.port || "(default)"}" is the developer's own cluster; use a throwaway cluster (convention: 55432)`);
}

process.env.DATABASE_URL = url;
process.env.REDIS_ENABLED = "false";
delete process.env.REDIS_URL;

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const h3 = require("h3-js");

const { getPrisma } = require("../../src/db/prisma");
const taskService = require("../../src/services/task.service");
const solvePath = require("../../src/workers/coordinatorSolvePath");
const deliveryDomain = require("../../src/engine/spatial/deliveryDomain");
const cells = require("../../src/engine/spatial/cells");
const hierarchy = require("../../src/engine/spatial/hierarchy");
const f33 = require("../../src/engine/feasibility/predicates/f33");
const configService = require("../../src/engine/config/service");

const REPO_ROOT = path.join(__dirname, "..", "..", "..");
const BOUNDARY_SHA256 = "04cb64c4205dc59462e149501fdd93b412106cfdc8d7249661bc8f3f47dc08b4";
const FINE = cells.H3_RESOLUTION.FINE;
const PRIVACY_KEYS = { secret: "live-verify-secret", encryptionKey: Buffer.alloc(32, 11) };

/**
 * Is this token a fine cell under the model in force?
 *
 * Asked through the **production decoder** — `resolutionOfH3Cell`, enforcement point 1
 * of the four — rather than a wrapper. A verification tool that asserts against a
 * convenience predicate is verifying the predicate; this asserts against the thing the
 * engine actually relies on.
 */
const isFine = (cellId) =>
  typeof cellId === "string" && cellId.trim() !== "" && cells.resolutionOfH3Cell(cellId) === cells.RESOLUTION.FINE;

const checks = [];
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  checks.push({ name, ok, actual, expected });
  const mark = ok ? "PASS" : "FAIL";
  console.log(`   ${mark}  ${name}`);
  if (!ok) console.log(`         expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function loadGeometry() {
  const raw = fs.readFileSync(path.join(REPO_ROOT, "rnsit-campus-osm.geojson"));
  const digest = crypto.createHash("sha256").update(raw).digest("hex");
  if (digest !== BOUNDARY_SHA256) refuse(`the RNSIT boundary file digest is ${digest}, not the adopted ${BOUNDARY_SHA256}`);
  const boundary = JSON.parse(raw).features.find((row) => row.id === "way/1120154292").geometry;
  const points = {};
  for (const feature of JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "rnsit-campus-supplemental.geojson"))).features) {
    const [lon, lat] = feature.geometry.coordinates;
    points[feature.properties.id] = { lat, lon };
  }
  return { boundary, points };
}

async function main() {
  const prisma = getPrisma();
  const { boundary, points } = loadGeometry();

  const declaration = {
    regionId: "rnsit-campus", name: "RNSIT Campus", kind: "CAMPUS", crs: "EPSG:4326",
    version: "way/1120154292", versionDate: "2026-08-30", boundary,
  };

  console.log("═══ D1 TWO-LAYER SPATIAL MODEL — LIVE VERIFICATION ═══");
  const identity = await prisma.$queryRawUnsafe(
    "select current_database() as db, inet_server_port() as port, current_user as usr, version() as version",
  );
  console.log(`target          ${target.protocol}//${target.hostname}:${target.port}${target.pathname}`);
  console.log(`server identity db=${identity[0].db} port=${identity[0].port} user=${identity[0].usr}`);
  console.log(`server version  ${String(identity[0].version).split(",")[0]}`);
  console.log(`spatial model   ${cells.SPATIAL_MODEL.id}`);
  console.log(`boundary digest ${BOUNDARY_SHA256} (verified)`);
  console.log("");

  /* ── 1. The index cover, derived live from the adopted geometry ─────────── */

  console.log("── 1. H3-11 index creation from the adopted boundary ──");
  const centreCover = h3.polygonToCells(boundary.coordinates, FINE, true);
  const indexCover = h3.polygonToCellsExperimental(
    boundary.coordinates, FINE, h3.POLYGON_TO_CELLS_FLAGS.containmentOverlapping, true,
  );
  check("centre-contained cover size", centreCover.length, 45);
  check("D6 boundary-overlap INDEX cover size", indexCover.length, 64);
  check("every index cell is a fine cell under this model", indexCover.every((cellId) => isFine(cellId)), true);

  const domain = deliveryDomain.validateDomainDeclaration(declaration);
  const centreSet = new Set(centreCover);
  const added = indexCover.filter((cellId) => !centreSet.has(cellId));
  const addedCentresOutside = added.filter((cellId) => {
    const [lat, lon] = h3.cellToLatLng(cellId);
    return deliveryDomain.evaluatePoint(domain, lat, lon).verdict === "OUTSIDE";
  });
  check("cells the overlap mode adds", added.length, 19);
  check("every added cell's centre is OUTSIDE the campus", addedCentresOutside.length, added.length);
  console.log("");

  /* ── 2. CellAssignment rows, live ───────────────────────────────────────── */

  console.log("── 2. CellAssignment — the published index, in the database ──");
  await prisma.cellAssignment.deleteMany({});
  await prisma.zone.deleteMany({});
  await prisma.region.deleteMany({});
  const region = await prisma.region.create({ data: { regionId: "rnsit", name: "RNSIT" } });
  // The Zone's bounding box is **derived from the adopted geometry**, not invented: it is
  // `boundingBoxOf` over the same ring, which is a derivation from a supplied geometry and
  // not a declaration. Nothing here widens, buffers or rounds it.
  const zone = await prisma.zone.create({
    data: {
      // `Zone` carries no `zoneId` of its own — its `id` IS its published identifier, which
      // is what `CellAssignment.zoneId` and `hierarchy.indexMap` key on.
      id: "rnsit-z1", name: "RNSIT Z1", regionId: region.id,
      minLat: domain.bbox.minLat, maxLat: domain.bbox.maxLat, minLon: domain.bbox.minLon, maxLon: domain.bbox.maxLon,
    },
  });
  await prisma.cellAssignment.createMany({
    data: indexCover.map((cellId) => ({ cellId, resolution: "FINE", regionId: region.id, zoneId: zone.id, mapVersion: 1 })),
  });
  const assignmentCount = await prisma.cellAssignment.count();
  check("CellAssignment rows written", assignmentCount, 64);
  const distinctMapVersions = await prisma.cellAssignment.findMany({ select: { mapVersion: true }, distinct: ["mapVersion"] });
  check("mapVersion carries the index generation", distinctMapVersions.map((row) => row.mapVersion), [1]);
  console.log("");

  /* ── 3. Intake seals the verdict against a PUBLISHED declaration ────────── */

  console.log("── 3. Intake pins the exact-coordinate verdict (D1 layer 2) ──");
  const snapshot = configService.buildSnapshot({ deliveryDomain: declaration, version: 1 });
  check("the declaration is a SIBLING of spatial on the snapshot", snapshot.deliveryDomain !== null && snapshot.spatial === null, true);
  check("S-3 row 29 is NOT discharged — the artefact is unattested", deliveryDomain.validateDomainDeclaration(snapshot.deliveryDomain).attested, false);

  await prisma.stop.deleteMany({});
  await prisma.leg.deleteMany({});
  await prisma.mission.deleteMany({});
  await prisma.identityRecord.deleteMany({});

  const mission = await prisma.mission.create({ data: { missionId: "m-live-1" } });
  const leg = await prisma.leg.create({ data: { legId: "leg-live-1", missionId: mission.id, sequence: 1, purpose: "PRIMARY" } });

  // Three real cases, and the middle one is D6's whole point.
  const fixtures = [
    { id: "stop-inside", point: points["rnsit-food-court"], expect: "INSIDE" },
    { id: "stop-overlap-outside", point: points["rnsit-parking-lot"], expect: "OUTSIDE" },
    { id: "stop-unassigned-inside", point: { lat: 12.9716, lon: 77.5946 }, expect: "OUTSIDE" },
  ];
  const workStops = [];
  for (const fixture of fixtures) {
    // eslint-disable-next-line no-await-in-loop
    const row = await prisma.stop.create({
      data: {
        stopId: fixture.id, legId: leg.id, sequence: workStops.length + 1, stopType: "DROP",
        label: `label-${fixture.id}`, lat: fixture.point.lat, lon: fixture.point.lon,
      },
    });
    workStops.push(row);
  }

  await taskService.sealIdentities(prisma, {
    task: { id: "t", taskId: "t-live-1" },
    work: { stops: workStops },
    privacyKeys: PRIVACY_KEYS,
    deliveryDomain: snapshot.deliveryDomain,
  });

  const sealed = await prisma.stop.findMany({ orderBy: { sequence: "asc" }, select: { stopId: true, geofenceResult: true, fineCell: true, lat: true, lon: true } });
  check("pinned verdicts written to Stop.geofenceResult", sealed.map((row) => row.geofenceResult), fixtures.map((row) => row.expect));
  check("fineCell written at the model in force", sealed.every((row) => isFine(row.fineCell)), true);
  // The parking lot is the D6 case: indexed, and outside.
  const parkingCell = sealed.find((row) => row.stopId === "stop-overlap-outside").fineCell;
  check("the OUTSIDE stop's cell IS in the published index", indexCover.includes(parkingCell), true);
  console.log("");

  /* ── 4. The verdict survives the round's own query ──────────────────────── */

  console.log("── 4. The pin reaches the coordinator through the production query ──");
  const loaded = await solvePath.legLoaderFor({ prisma })("leg-live-1");
  check("legLoaderFor carries geofenceResult out of the database", loaded.stops.map((row) => row.geofenceResult), fixtures.map((row) => row.expect));

  const spatialPayload = {
    version: 1,
    regions: [{ id: "rnsit" }],
    zones: [{ id: "rnsit-z1", regionId: "rnsit" }],
    sites: [],
    cells: indexCover.map((cellId) => ({ cellId, resolution: "FINE", regionId: "rnsit", zoneId: "rnsit-z1" })),
  };
  check("the published index resolves the OUTSIDE stop's cell as ASSIGNED", hierarchy.indexMap(spatialPayload).resolve(parkingCell).assigned, true);

  // Without routability the conjunction cannot reach `true` — the standing R13 consequence.
  // But a **definite** negative still wins: three-valued conjunction returns false as soon
  // as any term is false, regardless of what else is absent. So the INSIDE stop goes
  // absent (nothing established routability) while the two OUTSIDE stops are still a
  // definite refusal. That is the discipline working, and it is why R13's absence makes
  // the gate stricter rather than merely undecided.
  const withoutRoutable = solvePath.serviceabilityFor({ spatial: spatialPayload })(loaded.stops);
  check(
    "with R13 unsupplied: INSIDE is ABSENT, OUTSIDE is still a definite refusal",
    withoutRoutable.map((row) => (row.serviceable === undefined ? "ABSENT" : row.serviceable)),
    ["ABSENT", false, false],
  );
  check("no stop is serviceable without R13", withoutRoutable.some((row) => row.serviceable === true), false);
  check(
    "F33 on the INSIDE stop alone therefore DENIES as INDETERMINATE",
    f33.evaluate({ plan: { stops: [{ ...withoutRoutable[0], sequence: 1 }] } }).outcome,
    "INDETERMINATE",
  );

  // Supplying routability only — the conjunction then turns on the pinned verdict alone.
  const routable = solvePath.serviceabilityFor({ spatial: spatialPayload })(loaded.stops.map((row) => ({ ...row, routable: true })));
  check("assigned + INSIDE + routable  → serviceable true", routable[0].serviceable, true);
  check("assigned + OUTSIDE + routable → serviceable FALSE (D6: the index did not authorise it)", routable[1].serviceable, false);
  check(
    "F33 on the boundary-overlap OUTSIDE stop is VIOLATED",
    f33.evaluate({ plan: { stops: [{ ...routable[1], sequence: 1 }] } }).outcome,
    "VIOLATED",
  );
  check(
    "F33 on the INSIDE stop alone is SATISFIED",
    f33.evaluate({ plan: { stops: [{ ...routable[0], sequence: 1 }] } }).outcome,
    "SATISFIED",
  );
  console.log("");

  /* ── 5. An unassigned cell is INDETERMINATE, never VIOLATED ─────────────── */

  console.log("── 5. Unassigned ≠ out-of-area (§M.2) ──");
  const elsewhere = { ...loaded.stops[0], lat: 12.9716, lon: 77.5946, cellId: undefined, geofenceResult: "INSIDE", routable: true };
  const elsewhereProjected = solvePath.serviceabilityFor({ spatial: spatialPayload })([elsewhere]);
  check("an unassigned cell leaves serviceability ABSENT", elsewhereProjected[0].serviceable, undefined);
  check(
    "F33 reports INDETERMINATE, not VIOLATED",
    f33.evaluate({ plan: { stops: [{ ...elsewhereProjected[0], sequence: 1 }] } }).outcome,
    "INDETERMINATE",
  );
  console.log("");

  /* ── 6. Foreign-token fail-closed, live ─────────────────────────────────── */

  console.log("── 6. A historical res-8 token fails closed, in the database ──");
  const res8 = h3.latLngToCell(points["rnsit-food-court"].lat, points["rnsit-food-court"].lon, 8);
  await prisma.stop.update({ where: { stopId: "stop-inside" }, data: { fineCell: res8 } });
  const stranded = await prisma.stop.findUnique({ where: { stopId: "stop-inside" }, select: { fineCell: true, geofenceResult: true } });
  check("a stranded res-8 token is not a fine cell under this model", isFine(stranded.fineCell), false);
  check("it decodes to no recognised resolution", cells.resolutionOfH3Cell(stranded.fineCell), null);
  // Enforcement point 2 of the four: the hierarchy relation refuses a foreign token
  // rather than coercing it. Exercised against the real persisted value.
  let refused = false;
  try {
    cells.coarseParentOf(stranded.fineCell);
  } catch {
    refused = true;
  }
  check("coarseParentOf refuses it rather than coercing it", refused, true);
  check("the index does not assign it", hierarchy.indexMap(spatialPayload).resolve(stranded.fineCell).assigned, false);
  // The property D1 buys: a spatial-model change does NOT disturb the geofence verdict.
  check("the pinned geofence verdict is untouched by the stranded cell", stranded.geofenceResult, "INSIDE");
  console.log("");

  /* ── 7. AgentCellPosition at the model in force ─────────────────────────── */

  console.log("── 7. AgentCellPosition persistence ──");
  await prisma.agentCellPosition.deleteMany({});
  await prisma.agent.deleteMany({});
  const agent = await prisma.agent.create({ data: { agentId: "agent-live-1" } });
  const agentPoint = points["rnsit-innovation-center"];
  const fineCellId = cells.cellForPoint(agentPoint.lat, agentPoint.lon, cells.RESOLUTION.FINE);
  await prisma.agentCellPosition.create({
    data: {
      agentId: agent.id, shardId: "shard-1", lat: agentPoint.lat, lon: agentPoint.lon,
      fineCellId, coarseCellId: cells.coarseParentOf(fineCellId),
      availabilityClass: "IDLE_READY", capabilityClasses: [], containerClasses: [],
      // Required and carried as a BigInt. A fixed literal, not a clock read: this
      // verification must be reproducible byte-for-byte across runs.
      observedAtMs: 1757808000000n,
    },
  });
  const stored = await prisma.agentCellPosition.findFirst({ select: { lat: true, lon: true, fineCellId: true, coarseCellId: true } });
  check("the stored fine cell is at the model in force", isFine(stored.fineCellId), true);
  check("it is recomputable from the row's own lat/lon", cells.cellForPoint(stored.lat, stored.lon, cells.RESOLUTION.FINE), stored.fineCellId);
  check("the coarse parent is derived, not stored independently", cells.coarseParentOf(stored.fineCellId), stored.coarseCellId);
  console.log("");

  /* ── Verdict ────────────────────────────────────────────────────────────── */

  const failed = checks.filter((row) => !row.ok);
  console.log("═══════════════════════════════════════════════════════");
  console.log(`${checks.length} checks, ${failed.length} failed`);
  if (failed.length > 0) for (const row of failed) console.log(`  FAILED: ${row.name}`);
  await prisma.$disconnect();
  return failed.length === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch(async (error) => {
    console.error(error);
    process.exit(1);
  });
