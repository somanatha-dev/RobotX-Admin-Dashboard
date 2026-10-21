const { toStringOrNull, toNumberOrNull } = require("../utils/parse");
const accessScope = require("./accessScope.service");
const { withAudit } = require("./adminAudit.service");

/**
 * The campuses a scope may see — every one for a SUPER_ADMIN, its own for an ADMIN, none for
 * anything else. `regionId` is the operating region's business key (`Region.regionId`), the
 * identifier a task submission names, rather than the row id the column stores.
 */
async function listCampuses(prisma, scope) {
  const where = accessScope.isSuperAdmin(scope)
    ? {}
    : scope && scope.kind === accessScope.SCOPE.CAMPUS
      ? { id: scope.campusId }
      : { id: { in: [] } };
  const rows = await prisma.campus.findMany({ where, orderBy: [{ name: "asc" }], include: { region: { select: { regionId: true } } } });
  return rows.map(({ region, regionId: _regionRowId, ...campus }) => ({ ...campus, regionId: region ? region.regionId : null }));
}

/**
 * Link a campus to its operating region (or clear the link) — SUPER_ADMIN only, audited.
 *
 * The region is named by its business key and must exist; it may belong to no other campus
 * (the unique index says so too, this says it by name). This is the single source of the
 * campus → region mapping every campus-scoped task check reads.
 *
 * @param {object} prisma
 * @param {string} campusId
 * @param {string|null} regionKey `Region.regionId`, or null to unlink
 * @param {{ id: string, role: string }} actor
 */
async function linkCampusRegion(prisma, campusId, regionKey, actor) {
  const campus = await prisma.campus.findUnique({ where: { id: String(campusId) }, select: { id: true, code: true, regionId: true } });
  if (!campus) {
    const err = new Error("Unknown campus");
    err.status = 404;
    throw err;
  }

  let region = null;
  if (regionKey !== null) {
    region = await prisma.region.findUnique({ where: { regionId: String(regionKey) }, select: { id: true, regionId: true, campus: { select: { id: true, code: true } } } });
    if (!region) {
      const err = new Error(`regionId "${regionKey}" does not name an operating region in this deployment`);
      err.status = 400;
      err.code = "UNKNOWN_REGION";
      throw err;
    }
    if (region.campus && region.campus.id !== campus.id) {
      const err = new Error(`region "${region.regionId}" already belongs to campus ${region.campus.code}`);
      err.status = 409;
      err.code = "REGION_ALREADY_LINKED";
      throw err;
    }
  }

  return withAudit(prisma, async (tx) => {
    const updated = await tx.campus.update({ where: { id: campus.id }, data: { regionId: region ? region.id : null } });
    return {
      result: { ...updated, regionId: region ? region.regionId : null },
      event: {
        actorId: actor.id,
        actorRole: actor.role,
        subjectType: "CAMPUS",
        subjectId: campus.id,
        payload: { action: "CAMPUS_REGION_LINKED", campusCode: campus.code, regionId: region ? region.regionId : null },
      },
    };
  });
}

async function createCampus(prisma, body) {
  const code = toStringOrNull(body?.code);
  const name = toStringOrNull(body?.name);
  const centerLat = toNumberOrNull(body?.centerLat);
  const centerLon = toNumberOrNull(body?.centerLon);

  if (!code || !name) {
    const err = new Error("code and name are required");
    err.status = 400;
    throw err;
  }

  if (centerLat === null || centerLon === null) {
    const err = new Error("centerLat and centerLon are required");
    err.status = 400;
    throw err;
  }

  return prisma.campus.create({
    data: {
      code,
      name,
      centerLat,
      centerLon,
    },
  });
}

module.exports = {
  listCampuses,
  createCampus,
  linkCampusRegion,
};
