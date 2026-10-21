const asyncHandler = require("../utils/asyncHandler");
const { getPrisma } = require("../db/prisma");
const campusService = require("../services/campus.service");
const accessScope = require("../services/accessScope.service");
const { toStringOrNull } = require("../utils/parse");

// RBAC — every campus for a SUPER_ADMIN; only its own for an ADMIN.
const listCampuses = asyncHandler(async (req, res) => {
  const prisma = getPrisma();
  const campuses = await campusService.listCampuses(prisma, req.access ?? accessScope.accessScopeFor(req.user));
  res.json({ ok: true, campuses });
});

const createCampus = asyncHandler(async (req, res) => {
  const prisma = getPrisma();
  const campus = await campusService.createCampus(prisma, req.body);
  res.json({ ok: true, campus });
});

// PUT /api/campuses/:id/region — SUPER_ADMIN only. Body `{ regionId: "<Region.regionId>" | null }`.
const linkCampusRegion = asyncHandler(async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  if (!Object.prototype.hasOwnProperty.call(body, "regionId")) {
    const err = new Error("regionId is required (the operating region's business id, or null to unlink)");
    err.status = 400;
    throw err;
  }
  const regionKey = body.regionId === null ? null : toStringOrNull(body.regionId);
  if (body.regionId !== null && !regionKey) {
    const err = new Error("regionId must be a non-empty string or null");
    err.status = 400;
    throw err;
  }
  const campus = await campusService.linkCampusRegion(getPrisma(), req.params.id, regionKey, { id: req.user.id, role: req.user.role });
  res.json({ ok: true, campus });
});

module.exports = {
  listCampuses,
  createCampus,
  linkCampusRegion,
};
