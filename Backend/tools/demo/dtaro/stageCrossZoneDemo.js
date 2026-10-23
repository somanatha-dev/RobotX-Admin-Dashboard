#!/usr/bin/env node
"use strict";

/**
 * **Stage the DTARO cross-zone demonstration on a DISPOSABLE database.** Never anything else.
 *
 *   node tools/demo/dtaro/stageCrossZoneDemo.js --database-url postgresql://…@127.0.0.1:<port>/<db>
 *
 * Run after `seedV1Demonstration.js` (which publishes the one-zone V1 world) and before the
 * server starts. It publishes and pins, IN THAT DISPOSABLE DATABASE ONLY, a SYNTHETIC test map:
 *
 *   · the same 64-cell RNSIT cover, split into two TEST zones by cell-centre longitude
 *     (`rnsit-syn-west` / `rnsit-syn-east`, at 77.518) — a test line, NOT the G4 proposal;
 *   · a SECOND synthetic region 1.5 km west (`dtaro-synthetic-r2`), so region isolation can be
 *     shown with a real robot in another region. It is not a campus.
 *
 * Every other binding of the pinned version is restated exactly as the seed states it
 * (`publishV1Demonstration.publishRequest`, the V1 execution bindings, the region's cutover
 * binding, the adopted delivery domain), so the engine runs as it does in the one-zone world.
 * `Zone` rows are created BEFORE the map is pinned (F27 reads authorised zones from them). A
 * `Campus` row for RNSIT is created so the dashboard can select it (the seed creates none).
 *
 * Refuses unless the target is loopback, not the canonical LOCAL database
 * (`environmentGuard.requireDisposableTarget`) and not a default-port cluster
 * (`disposableDatabase.assertDisposableLocal`). It never reads or writes G4: the four-zone
 * proposal stays a read-only preview in the dashboard.
 */

const path = require("path");
const h3 = require("h3-js");

const BACKEND_ROOT = path.resolve(__dirname, "..", "..", "..");
const cells = require(path.join(BACKEND_ROOT, "src/engine/spatial/cells"));
const hierarchy = require(path.join(BACKEND_ROOT, "src/engine/spatial/hierarchy"));
const validators = require(path.join(BACKEND_ROOT, "src/engine/config/validators"));

/** @structural the test split line (cell-centre longitude); chosen so the depot is WEST and the walkway obstacle EAST */
const SPLIT_LON = 77.518;
const ZONES = Object.freeze({
  WEST: { id: "rnsit-syn-west", name: "SYNTHETIC TEST — RNSIT west half (not G4)" },
  EAST: { id: "rnsit-syn-east", name: "SYNTHETIC TEST — RNSIT east half (not G4)" },
});
const R2 = Object.freeze({
  regionId: "dtaro-synthetic-r2",
  name: "SYNTHETIC TEST REGION 2 (not a campus)",
  zone: { id: "dtaro-syn-r2-z1", name: "SYNTHETIC TEST — region 2 zone" },
  /** 1.5 km west of the campus (the same point the socket tests use for their second region). */
  centre: { lat: 12.9027, lon: 77.505 },
  /** @structural disk radius in res-11 cells */
  k: 4,
});

/**
 * The synthetic map — pure. `cover` is the adopted 64-cell index cover; `rnsitRowId` and
 * `r2RowId` are the two `Region.id` row keys.
 */
function syntheticSpatialMap({ cover, rnsitRowId, r2RowId }) {
  const r2Cells = h3.gridDisk(cells.cellForPoint(R2.centre.lat, R2.centre.lon, cells.RESOLUTION.FINE), R2.k);
  const rnsit = new Set(cover);
  if (r2Cells.some((c) => rnsit.has(c))) throw new Error("the synthetic second region overlaps the RNSIT cover");
  const zoneOf = (cellId) => (h3.cellToLatLng(cellId)[1] < SPLIT_LON ? ZONES.WEST.id : ZONES.EAST.id);
  return {
    version: 1,
    regions: [{ id: rnsitRowId }, { id: r2RowId }],
    zones: [
      { id: ZONES.WEST.id, regionId: rnsitRowId },
      { id: ZONES.EAST.id, regionId: rnsitRowId },
      { id: R2.zone.id, regionId: r2RowId },
    ],
    sites: [],
    cells: [
      ...cells.canonicalCellOrder(cover).map((cellId) => ({ cellId, resolution: "FINE", regionId: rnsitRowId, zoneId: zoneOf(cellId) })),
      ...cells.canonicalCellOrder(r2Cells).map((cellId) => ({ cellId, resolution: "FINE", regionId: r2RowId, zoneId: R2.zone.id })),
    ],
  };
}

/** The engine's own publish-time checks for a spatial map; refuses on any finding. */
function assertPublishable(spatial) {
  const verdict = hierarchy.validateForPublish(spatial);
  const v8 = validators.v8SpatialContainment(hierarchy.toConfigPayload(spatial));
  if (!verdict.ok || v8.length > 0) {
    throw new Error(`the synthetic map fails validation: ${[...verdict.problems, ...v8.map((f) => f.message)].join("; ")}`);
  }
}

async function stage(prisma, { log = console.log } = {}) {
  const configService = require(path.join(BACKEND_ROOT, "src/engine/config/service"));
  const publishTool = require(path.join(BACKEND_ROOT, "tools/config/publishV1Demonstration"));
  const demonstration = require(path.join(BACKEND_ROOT, "tools/config/v1DemonstrationConfig"));
  const bootstrap = require(path.join(BACKEND_ROOT, "tools/deploy/bootstrapV1Environment"));
  const world = bootstrap.intendedWorld();

  const rnsit = await prisma.region.findUnique({ where: { regionId: "rnsit" } });
  if (!rnsit) throw new Error("no rnsit Region row: run seedV1Demonstration.js first");
  const pinnedBefore = await configService.loadPinnedSnapshot({ prisma });
  if (!pinnedBefore || !pinnedBefore.spatial) throw new Error("no pinned configuration: run seedV1Demonstration.js first");

  // Rows first (F27 reads authorised zones from Zone rows): degenerate boxes, so the legacy
  // bounding-box lookup never matches them.
  const box = { minLat: 0, maxLat: 0, minLon: 0, maxLon: 0 };
  const r2 = await prisma.region.upsert({ where: { regionId: R2.regionId }, update: {}, create: { regionId: R2.regionId, name: R2.name, description: "DTARO cross-zone demonstration only (disposable database)." } });
  for (const [zone, regionId] of [[ZONES.WEST, rnsit.id], [ZONES.EAST, rnsit.id], [R2.zone, r2.id]]) {
    await prisma.zone.upsert({ where: { id: zone.id }, update: { name: zone.name, regionId }, create: { id: zone.id, name: zone.name, regionId, ...box } });
  }

  const spatial = syntheticSpatialMap({ cover: world.indexCover, rnsitRowId: rnsit.id, r2RowId: r2.id });
  assertPublishable(spatial);

  const base = publishTool.publishRequest({ accommodate: true });
  const publishedBy = "tools/demo/dtaro/stageCrossZoneDemo.js";
  const published = await configService.publish(prisma, {
    ...base,
    publishedBy,
    bindings: [...base.bindings, ...demonstration.executionBindings(), { level: "region", key: rnsit.id, name: "cutover.engine_enabled", value: true }],
    spatial,
    deliveryDomain: world.declaration,
    note: `${base.note} | DTARO CROSS-ZONE DEMONSTRATION on a DISPOSABLE cluster: a SYNTHETIC two-zone split of the RNSIT cover at cell-centre longitude ${SPLIT_LON} plus a synthetic second region. NOT G4, NOT PRODUCTION.`,
  });
  await configService.pinVersion(prisma, null, published.version, publishedBy);
  const pinned = await configService.loadPinnedSnapshot({ prisma });
  if (!pinned || pinned.version !== published.version) throw new Error(`published ${published.version} but the pin reads ${pinned && pinned.version}`);

  // The dashboard selects campuses from Campus rows; the seed creates none.
  const centre = h3.cellToLatLng(world.indexCover[0]);
  const campus = await prisma.campus.upsert({
    where: { code: "RNSIT" },
    update: { regionId: rnsit.id },
    create: { code: "RNSIT", name: "RNSIT", centerLat: centre[0], centerLon: centre[1], regionId: rnsit.id },
  });

  const counts = {};
  for (const c of spatial.cells) counts[c.zoneId] = (counts[c.zoneId] || 0) + 1;
  log(`staged: version ${published.version} pinned (was ${pinnedBefore.version}); zones ${JSON.stringify(counts)}; campus ${campus.code} → region ${rnsit.regionId}`);
  return { version: published.version, previousVersion: pinnedBefore.version, counts, spatial };
}

module.exports = { SPLIT_LON, ZONES, R2, syntheticSpatialMap, assertPublishable, stage };

if (require.main === module) {
  const at = process.argv.indexOf("--database-url");
  const url = at === -1 ? null : process.argv[at + 1];
  if (!url) {
    process.stderr.write("usage: node tools/demo/dtaro/stageCrossZoneDemo.js --database-url <disposable loopback postgres url>\n");
    process.exit(2);
  }
  process.env.DATABASE_URL = url;
  const { requireDisposableTarget } = require(path.join(BACKEND_ROOT, "src/config/environmentGuard"));
  if (!requireDisposableTarget()) process.exit(78);
  const { assertDisposableLocal } = require(path.join(BACKEND_ROOT, "tools/demo/disposableDatabase"));
  assertDisposableLocal(url);
  const { PrismaClient } = require("@prisma/client");
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  stage(prisma)
    .then(() => prisma.$disconnect())
    .catch(async (error) => {
      process.stderr.write(`STAGING FAILED: ${error.message}\n`);
      await prisma.$disconnect();
      process.exit(1);
    });
}
