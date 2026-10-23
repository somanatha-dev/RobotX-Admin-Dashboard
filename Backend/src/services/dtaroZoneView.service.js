"use strict";

/**
 * DTARO — the PUBLISHED zone map, for the dashboard to draw. Read-only.
 *
 * The geometry is derived from exactly what the pinned configuration assigns: each zone is the
 * union of the H3 fine cells the published map (`snapshot.spatial`, ADR-28) assigns to it, with
 * each cell's own region (the same rule `hierarchy.resolve` uses). Nothing is inferred from a
 * bounding box, a campus outline or a proposal, so the map shows what alert routing uses — and
 * nothing else.
 *
 * Zones are keyed by `<regionId>/<zoneId>`: a zone id is only meaningful inside its region, and
 * two regions may reuse one label.
 *
 * Served whether or not obstacle alerts are on. The zones are a property of the published map,
 * not of the alert feature: a server with `DTARO_ZONE_ALERTS_ENABLED` unset answered
 * `{ enabled: false }` here, and the dashboard drew no zone and said nothing about why (seen in
 * the real app, 2026-10-22). `alertsEnabled` reports the switch, so the dashboard can say whether
 * alerts use these zones right now. Nothing about alert delivery depends on this answer.
 *
 * Reads: the pinned snapshot (in memory) and, for display only, `Region.regionId` / `Region.name`
 * and `Zone.name` by id. Writes nothing.
 */

const h3 = require("h3-js");
const cells = require("../engine/spatial/cells");

/** Per published map: the grouped cells and their outlines, computed once. */
const geometryCache = new WeakMap();

function zoneKey(regionId, zoneId) {
  return `${regionId}/${zoneId}`;
}

function groupPublishedCells(spatial) {
  const cached = geometryCache.get(spatial);
  if (cached) return cached;

  const zoneRegion = new Map();
  for (const zone of spatial.zones || []) {
    if (zone && zone.id) zoneRegion.set(String(zone.id), zone.regionId ? String(zone.regionId) : null);
  }

  const groups = new Map();
  let cellsWithoutZone = 0;
  for (const assignment of spatial.cells || []) {
    if (!assignment || !cells.isCellId(assignment.cellId)) continue;
    if (assignment.resolution && assignment.resolution !== cells.RESOLUTION.FINE) continue;
    const zoneId = assignment.zoneId ? String(assignment.zoneId) : null;
    const regionId = assignment.regionId ? String(assignment.regionId) : zoneId ? zoneRegion.get(zoneId) || null : null;
    if (!zoneId || !regionId) {
      cellsWithoutZone += 1;
      continue;
    }
    const key = zoneKey(regionId, zoneId);
    if (!groups.has(key)) groups.set(key, { key, regionId, zoneId, cellIds: [] });
    groups.get(key).cellIds.push(cells.normaliseCellId(assignment.cellId));
  }

  const zones = [...groups.values()]
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((group) => ({
      key: group.key,
      regionId: group.regionId,
      zoneId: group.zoneId,
      cellCount: group.cellIds.length,
      // GeoJSON order ([lon, lat]), outer rings closed — what Mapbox reads directly.
      geometry: { type: "MultiPolygon", coordinates: h3.cellsToMultiPolygon(group.cellIds, true) },
    }));

  const result = { zones, cellsWithoutZone };
  geometryCache.set(spatial, result);
  return result;
}

async function namesById(prisma, model, ids, select) {
  if (!prisma || ids.length === 0) return new Map();
  try {
    const rows = await prisma[model].findMany({ where: { id: { in: ids } }, select });
    return new Map((rows || []).map((row) => [String(row.id), row]));
  } catch {
    return new Map();
  }
}

/**
 * @param {{ snapshot: object|null, prisma: object|null, alertsEnabled: boolean }} args
 */
async function publishedZoneView({ snapshot, prisma, alertsEnabled = false }) {
  const alerts = alertsEnabled === true;
  const spatial = snapshot && snapshot.spatial;
  if (!spatial || !Array.isArray(spatial.cells)) {
    return { available: false, alertsEnabled: alerts, reason: "SPATIAL_AUTHORITY_UNAVAILABLE", regions: [], zones: [] };
  }

  const { zones, cellsWithoutZone } = groupPublishedCells(spatial);
  const regionIds = [...new Set(zones.map((z) => z.regionId))];
  const zoneIds = [...new Set(zones.map((z) => z.zoneId))];
  const regionRows = await namesById(prisma, "region", regionIds, { id: true, regionId: true, name: true });
  const zoneRows = await namesById(prisma, "zone", zoneIds, { id: true, name: true });

  const regions = regionIds.map((id) => {
    const row = regionRows.get(id);
    return { id, regionKey: row && row.regionId ? String(row.regionId) : null, name: row && row.name ? String(row.name) : null };
  });
  const regionKeyOf = new Map(regions.map((r) => [r.id, r.regionKey]));

  return {
    available: true,
    alertsEnabled: alerts,
    source: "PUBLISHED_MAP",
    configVersion: snapshot.version === undefined ? null : snapshot.version,
    spatialVersion: spatial.version === undefined ? null : spatial.version,
    cellsWithoutZone,
    regions,
    zones: zones.map((zone) => {
      const row = zoneRows.get(zone.zoneId);
      return {
        ...zone,
        regionKey: regionKeyOf.get(zone.regionId) || null,
        name: row && row.name ? String(row.name) : null,
      };
    }),
  };
}

module.exports = { publishedZoneView, zoneKey };
