"use strict";

/**
 * **Zone references of a spatial map, checked against the `Zone` table** — the check
 * `configService.publish` does not make.
 *
 * ── Why it is needed ────────────────────────────────────────────────────────
 * A published spatial map names zones by id. `configService.publish` validates the map's
 * structure (`hierarchy.validateForPublish`, V8) and accepts any zone id. But two live paths
 * read the `Zone` table by those ids:
 *
 *   · F27 (route zone authorisation) authorises an agent only in the `Zone` rows of its region
 *     (`agentFacts.service` / `fleetProviders/physicalFacts`: `zone.findMany({ where: { regionId } })`),
 *     while the route's traversed zones come from the published map. A map naming a zone with
 *     no row in that region makes every route through it VIOLATED — the engine stops assigning.
 *   · `ObstacleEvent.zoneId` is a foreign key to `Zone`; `ekb.storeObstacle` swallows the insert
 *     error, so an obstacle in such a zone is delivered but silently not persisted.
 *
 * So a map may be published only when every zone it names is a `Zone` row in the region the
 * map puts it in. This module states that invariant once; the HTTP publish path
 * (`config.controller.publishVersion`) refuses before publishing (and therefore before pinning),
 * and the G4 rehearsal tool runs the same check. It reads; it writes nothing. Not engine code:
 * the frozen Config Service and its validators are unchanged.
 */

/**
 * Findings for a spatial map against `Zone` rows. Pure.
 *
 * @param {object|null|undefined} spatial the map a version would publish (`{ regions, zones, cells }`)
 * @param {Array<{ id: string, regionId: string|null }>} zoneRows the `Zone` rows for the ids it names
 * @returns {string[]} one sentence per problem; empty when every reference holds
 */
function zoneReferenceFindings(spatial, zoneRows) {
  if (!spatial || !Array.isArray(spatial.zones)) return [];
  const rows = new Map((zoneRows || []).map((z) => [z.id, z]));
  const listed = new Set(spatial.zones.map((z) => z && z.id));
  const findings = [];
  for (const zone of spatial.zones) {
    if (!zone || typeof zone.id !== "string" || zone.id === "") {
      findings.push("the map lists a zone with no id");
      continue;
    }
    const row = rows.get(zone.id);
    if (!row) findings.push(`no Zone row "${zone.id}": F27 would refuse every route through it`);
    else if (row.regionId !== zone.regionId) findings.push(`Zone row "${zone.id}" is in region ${row.regionId}, the map puts it in ${zone.regionId}`);
  }
  for (const cell of Array.isArray(spatial.cells) ? spatial.cells : []) {
    if (cell && cell.zoneId && !listed.has(cell.zoneId)) findings.push(`cell ${cell.cellId} names zone ${cell.zoneId}, which the map does not list`);
  }
  return findings;
}

/**
 * Load the `Zone` rows a map names and return its findings. A map with no zones has none.
 *
 * @param {object} prisma
 * @param {object|null|undefined} spatial
 * @returns {Promise<string[]>}
 */
async function checkSpatialZoneReferences(prisma, spatial) {
  if (!spatial || !Array.isArray(spatial.zones) || spatial.zones.length === 0) return zoneReferenceFindings(spatial, []);
  const ids = [...new Set(spatial.zones.map((z) => z && z.id).filter((id) => typeof id === "string" && id !== ""))];
  const rows = ids.length ? await prisma.zone.findMany({ where: { id: { in: ids } }, select: { id: true, regionId: true } }) : [];
  return zoneReferenceFindings(spatial, rows);
}

module.exports = { zoneReferenceFindings, checkSpatialZoneReferences };
